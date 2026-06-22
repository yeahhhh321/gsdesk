use std::collections::VecDeque;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use wait_timeout::ChildExt;

use crate::core_logs::{latest_core_log_file, read_core_jsonl_records, CoreFileLogRecord};
use crate::models::{
    AppPaths, CoreCommitEntry, CoreUpdateRequest, CoreUpdateResult, LogEntry, RepairRuntimeRequest,
    RuntimeBackupResult, RuntimeRestoreRequest, RuntimeRestoreResult, ServiceSnapshot,
    ServiceStatus, Settings, StartServiceRequest, TaskRecord,
};
use crate::paths::app_paths;
use crate::ports::{select_port, service_port_available};
use crate::process::{
    apply_default_child_env, process_memory_bytes, run_command_timeout, LEGACY_WINDOWS_STDIO_ENV,
    PYTHON_IO_ENCODING,
};
use crate::runtime_backup::{create_runtime_backup_inner, restore_runtime_backup_inner};
use crate::service_logs::{
    classify_level, contains_terminal_sensitive_char, is_standalone_python_gbk_encoding_error,
    is_structured_log_prefix_at, log_file_safe_text, normalize_log_records,
    should_promote_recent_error, ConsoleLogFilter,
};
use crate::settings::env_from_settings;
use crate::toolchain;

pub use crate::service_logs::sanitize_persisted_log_content;

pub const GSUID_SERVICE_ID: &str = "gsuid_core";
pub const NONEBOT_SERVICE_ID: &str = "nonebot2";
const NONEBOT_PENDING_MESSAGE: &str =
    "NoneBot2 暂未配置：后续接入项目目录、进程启动、连接检查和合并日志。";
const UNSUPPORTED_SERVICE_MESSAGE: &str = "当前只支持管理 gsuid_core；NoneBot2 暂未配置启动方式。";
const MAX_LOG_ENTRIES: usize = 5000;
const MAX_PERSISTED_LOG_BYTES: u64 = 8 * 1024 * 1024;
const MAX_ROTATED_LOG_FILES: usize = 5;
const MAX_INITIAL_CORE_FILE_LOG_BYTES: u64 = 2 * 1024 * 1024;
const MAX_CORE_LOG_READ_BYTES: usize = 256 * 1024;
const MAX_CORE_LOG_RECORDS_PER_SYNC: usize = 800;
const GRACEFUL_STOP_TIMEOUT: Duration = Duration::from_secs(8);
const CLEANABLE_CORE_UPDATE_PATHS: &[&str] = &["uv.lock"];

#[derive(Clone, Default)]
pub struct SharedRuntime {
    pub inner: Arc<Mutex<ServiceRuntime>>,
}

impl SharedRuntime {
    pub fn lock(&self) -> MutexGuard<'_, ServiceRuntime> {
        lock_service_runtime(&self.inner)
    }
}

pub struct ServiceRuntime {
    pub status: ServiceStatus,
    pub port: Option<u16>,
    pub child: Option<Child>,
    pub logs: VecDeque<LogEntry>,
    pub recent_error: Option<String>,
    pub started_at: Option<String>,
    pub next_log_id: u64,
    pub core_log_path: Option<PathBuf>,
    pub core_log_offset: u64,
    pub core_file_log_ready: bool,
    pub core_log_poller_active: bool,
    pub webconsole_available: bool,
    pub webconsole_probe_active: bool,
    pub next_webconsole_probe_at: Option<Instant>,
    pub tasks: VecDeque<TaskRecord>,
    pub next_task_id: u64,
    pub persisted_log_sanitized: bool,
    pub cancel_requested: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CoreRepoChange {
    status: String,
    path: String,
}

struct CoreUpdateStep<'a> {
    action: &'a str,
    channel: &'a str,
    target_commit: Option<&'a str>,
    task_id: u64,
}

fn lock_service_runtime(runtime: &Arc<Mutex<ServiceRuntime>>) -> MutexGuard<'_, ServiceRuntime> {
    match runtime.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn lock_command_records(
    records: &Arc<Mutex<VecDeque<String>>>,
) -> MutexGuard<'_, VecDeque<String>> {
    match records.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

impl Default for ServiceRuntime {
    fn default() -> Self {
        Self {
            status: ServiceStatus::Uninitialized,
            port: None,
            child: None,
            logs: VecDeque::new(),
            recent_error: None,
            started_at: None,
            next_log_id: 1,
            core_log_path: None,
            core_log_offset: 0,
            core_file_log_ready: false,
            core_log_poller_active: false,
            webconsole_available: false,
            webconsole_probe_active: false,
            next_webconsole_probe_at: None,
            tasks: VecDeque::new(),
            next_task_id: 1,
            persisted_log_sanitized: false,
            cancel_requested: false,
        }
    }
}

pub fn ensure_gsuid_service(service_id: Option<&str>) -> Result<(), String> {
    if let Some(service_id) = service_id {
        if service_id != GSUID_SERVICE_ID {
            return Err(UNSUPPORTED_SERVICE_MESSAGE.to_string());
        }
    }
    Ok(())
}

pub fn snapshot(
    runtime: &mut ServiceRuntime,
    paths: &AppPaths,
    core_git: Option<CoreGitMetadata>,
) -> Vec<ServiceSnapshot> {
    refresh_child_exit_status(runtime, paths);
    let persisted = if runtime.child.is_none() {
        let persisted = running_persisted_core_process(paths);
        if let Some(record) = &persisted {
            attach_runtime_to_persisted_core(runtime, record);
        } else {
            clear_detached_core_runtime(runtime);
        }
        persisted
    } else {
        None
    };
    let core_installed = core_runtime_installed(paths);
    let core_status = if runtime.status == ServiceStatus::Uninitialized && core_installed {
        ServiceStatus::Stopped
    } else {
        runtime.status
    };
    let core_url = runtime.port.map(|port| format!("http://127.0.0.1:{port}"));
    let core_pid = runtime
        .child
        .as_ref()
        .map(|child| child.id())
        .or_else(|| persisted.as_ref().map(|record| record.pid));
    let core_memory_bytes = core_pid.and_then(process_memory_bytes);
    vec![
        ServiceSnapshot {
            service_id: GSUID_SERVICE_ID.to_string(),
            name: "Gsuid Core".to_string(),
            status: core_status,
            port: runtime.port,
            pid: core_pid,
            memory_bytes: core_memory_bytes,
            url: core_url.clone(),
            started_at: runtime.started_at.clone(),
            current_commit: core_git.as_ref().and_then(|metadata| metadata.commit.clone()),
            current_tag: core_git.as_ref().and_then(|metadata| metadata.tag.clone()),
            recent_error: runtime.recent_error.clone(),
            health_ok: core_status == ServiceStatus::Running,
            webconsole_available: core_status == ServiceStatus::Running
                && runtime.webconsole_available,
        },
        ServiceSnapshot {
            service_id: NONEBOT_SERVICE_ID.to_string(),
            name: "NoneBot2".to_string(),
            status: ServiceStatus::Uninitialized,
            port: None,
            pid: None,
            memory_bytes: None,
            url: None,
            started_at: None,
            current_commit: None,
            current_tag: None,
            recent_error: Some(NONEBOT_PENDING_MESSAGE.to_string()),
            health_ok: false,
            webconsole_available: false,
        },
    ]
}

fn refresh_child_exit_status(runtime: &mut ServiceRuntime, paths: &AppPaths) {
    if let Some(child) = runtime.child.as_mut() {
        if let Ok(Some(status)) = child.try_wait() {
            if runtime.status == ServiceStatus::Running || runtime.status == ServiceStatus::Starting
            {
                runtime.status = ServiceStatus::Failed;
                runtime.recent_error = Some(format!("Core 进程已退出，退出码: {status}"));
            }
            runtime.child = None;
            runtime.core_file_log_ready = false;
            runtime.webconsole_available = false;
            let _ = clear_persisted_core_process(paths);
        }
    }
}

#[derive(Debug, Clone)]
pub struct CoreGitMetadata {
    pub commit: Option<String>,
    pub tag: Option<String>,
}

pub fn core_git_metadata(app: &AppHandle, paths: &AppPaths) -> Option<CoreGitMetadata> {
    let core_dir = PathBuf::from(&paths.core_dir);
    if !core_dir.join(".git").exists() {
        return None;
    }
    let git_program = toolchain::git_program(app, paths).ok()?;
    let commit = run_command_timeout(
        &git_program,
        &["rev-parse", "--short", "HEAD"],
        Some(&core_dir),
        &[],
        Duration::from_secs(5),
    )
    .ok()
    .and_then(|output| output.success.then(|| output.stdout.trim().to_string()))
    .filter(|value| !value.is_empty());
    let tag = run_command_timeout(
        &git_program,
        &["describe", "--tags", "--exact-match", "HEAD"],
        Some(&core_dir),
        &[],
        Duration::from_secs(5),
    )
    .ok()
    .and_then(|output| output.success.then(|| output.stdout.trim().to_string()))
    .filter(|value| !value.is_empty());
    Some(CoreGitMetadata { commit, tag })
}

fn core_runtime_installed(paths: &AppPaths) -> bool {
    let core_dir = PathBuf::from(&paths.core_dir);
    core_dir.join(".git").exists() || core_dir.join("pyproject.toml").exists()
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum CoreSourceState {
    GitRepo,
    SourceTree,
    Missing,
    Invalid(String),
}

fn core_source_state(core_dir: &Path) -> CoreSourceState {
    if core_dir.join(".git").exists() {
        return CoreSourceState::GitRepo;
    }
    if core_dir.join("pyproject.toml").exists() {
        return CoreSourceState::SourceTree;
    }
    if !core_dir.exists() {
        return CoreSourceState::Missing;
    }
    CoreSourceState::Invalid(format!(
        "Core 路径已存在，但没有 .git 或 pyproject.toml: {}",
        core_dir.display()
    ))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedCoreProcess {
    pid: u32,
    port: u16,
    started_at: String,
}

fn persisted_core_process_file(paths: &AppPaths) -> PathBuf {
    PathBuf::from(&paths.runtime).join("core-process.json")
}

fn persist_core_process(
    paths: &AppPaths,
    pid: u32,
    port: u16,
    started_at: &str,
) -> Result<(), String> {
    let path = persisted_core_process_file(paths);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("创建进程状态目录失败 {}: {error}", parent.display()))?;
    }
    let record = PersistedCoreProcess { pid, port, started_at: started_at.to_string() };
    let json = serde_json::to_string_pretty(&record)
        .map_err(|error| format!("序列化 Core 进程状态失败: {error}"))?;
    fs::write(&path, json)
        .map_err(|error| format!("写入 Core 进程状态失败 {}: {error}", path.display()))
}

fn load_persisted_core_process(paths: &AppPaths) -> Option<PersistedCoreProcess> {
    fs::read_to_string(persisted_core_process_file(paths))
        .ok()
        .and_then(|raw| serde_json::from_str::<PersistedCoreProcess>(&raw).ok())
}

fn clear_persisted_core_process(paths: &AppPaths) -> Result<(), String> {
    let path = persisted_core_process_file(paths);
    if path.exists() {
        fs::remove_file(&path)
            .map_err(|error| format!("删除 Core 进程状态失败 {}: {error}", path.display()))?;
    }
    Ok(())
}

fn running_persisted_core_process(paths: &AppPaths) -> Option<PersistedCoreProcess> {
    let record = load_persisted_core_process(paths)?;
    if process_alive(record.pid) {
        Some(record)
    } else {
        let _ = clear_persisted_core_process(paths);
        None
    }
}

fn attach_runtime_to_persisted_core(
    runtime: &mut ServiceRuntime,
    record: &PersistedCoreProcess,
) -> bool {
    if runtime.child.is_some()
        || matches!(
            runtime.status,
            ServiceStatus::Checking | ServiceStatus::Initializing | ServiceStatus::Stopping
        )
    {
        return false;
    }

    let was_same_core = matches!(runtime.status, ServiceStatus::Starting | ServiceStatus::Running)
        && runtime.port == Some(record.port)
        && runtime.started_at.as_deref() == Some(record.started_at.as_str());

    runtime.port = Some(record.port);
    runtime.started_at = Some(record.started_at.clone());
    runtime.status = ServiceStatus::Running;
    runtime.recent_error = None;

    if !was_same_core {
        runtime.webconsole_available = false;
        runtime.next_webconsole_probe_at = None;
    }

    !was_same_core
}

fn clear_detached_core_runtime(runtime: &mut ServiceRuntime) {
    if runtime.child.is_some()
        || !matches!(runtime.status, ServiceStatus::Starting | ServiceStatus::Running)
    {
        return;
    }
    runtime.port = None;
    runtime.started_at = None;
    runtime.core_file_log_ready = false;
    runtime.webconsole_available = false;
    runtime.next_webconsole_probe_at = None;
    runtime.status = ServiceStatus::Stopped;
    runtime.recent_error = None;
}

pub fn attach_persisted_core_if_running(
    app: &AppHandle,
    runtime: &SharedRuntime,
    paths: &AppPaths,
) -> bool {
    let should_activate_background_hooks = {
        let mut guard = runtime.lock();
        refresh_child_exit_status(&mut guard, paths);
        if guard.child.is_some() {
            return false;
        }

        let Some(record) = running_persisted_core_process(paths) else {
            clear_detached_core_runtime(&mut guard);
            return false;
        };

        let should_log = attach_runtime_to_persisted_core(&mut guard, &record);
        if should_log {
            push_log(
                &mut guard,
                app,
                "system",
                "info",
                &format!(
                    "已加载后台 Core: pid={} http://127.0.0.1:{}/app",
                    record.pid, record.port
                ),
            );
        }
        matches!(guard.status, ServiceStatus::Starting | ServiceStatus::Running)
    };

    if should_activate_background_hooks {
        spawn_core_file_log_poller(app.clone(), runtime.clone(), paths.clone());
        ensure_webconsole_probe(app, runtime, paths);
    }
    should_activate_background_hooks
}

fn process_alive(pid: u32) -> bool {
    if cfg!(windows) {
        run_command_timeout(
            "powershell",
            &[
                "-NoProfile",
                "-Command",
                &format!(
                    "if (Get-Process -Id {pid} -ErrorAction SilentlyContinue) {{ '1' }} else {{ '0' }}"
                ),
            ],
            None,
            &[],
            Duration::from_secs(5),
        )
        .map(|output| output.stdout.trim() == "1")
        .unwrap_or(false)
    } else {
        run_command_timeout(
            "sh",
            &["-c", &format!("kill -0 {pid} >/dev/null 2>&1")],
            None,
            &[],
            Duration::from_secs(5),
        )
        .map(|output| output.success)
        .unwrap_or(false)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StopOutcome {
    NoProcess,
    Graceful,
    Forced,
}

fn request_process_tree_stop(pid: u32) {
    if cfg!(windows) {
        let args = windows_taskkill_args(pid, false);
        let args = args.iter().map(String::as_str).collect::<Vec<_>>();
        let _ = run_command_timeout("taskkill", &args, None, &[], Duration::from_secs(10));
    } else {
        let _ = run_command_timeout(
            "sh",
            &["-c", &unix_tree_signal_script(pid, "TERM")],
            None,
            &[],
            Duration::from_secs(10),
        );
    }
}

fn force_kill_process_tree(pid: u32) {
    if cfg!(windows) {
        let args = windows_taskkill_args(pid, true);
        let args = args.iter().map(String::as_str).collect::<Vec<_>>();
        let _ = run_command_timeout("taskkill", &args, None, &[], Duration::from_secs(10));
    } else {
        let _ = run_command_timeout(
            "sh",
            &["-c", &unix_tree_signal_script(pid, "KILL")],
            None,
            &[],
            Duration::from_secs(10),
        );
    }
}

fn windows_taskkill_args(pid: u32, force: bool) -> Vec<String> {
    let mut args = vec!["/PID".to_string(), pid.to_string(), "/T".to_string()];
    if force {
        args.push("/F".to_string());
    }
    args
}

fn unix_tree_signal_script(pid: u32, signal: &str) -> String {
    format!("pkill -{signal} -P {pid} >/dev/null 2>&1 || true; kill -{signal} {pid} >/dev/null 2>&1 || true")
}

fn stop_child_process_tree(child: &mut Child) -> StopOutcome {
    let pid = child.id();
    request_process_tree_stop(pid);
    match child.wait_timeout(GRACEFUL_STOP_TIMEOUT) {
        Ok(Some(_)) => StopOutcome::Graceful,
        Ok(None) | Err(_) => {
            force_kill_process_tree(pid);
            let _ = child.wait();
            StopOutcome::Forced
        }
    }
}

fn stop_persisted_process_tree(pid: u32) -> StopOutcome {
    if !process_alive(pid) {
        return StopOutcome::NoProcess;
    }
    request_process_tree_stop(pid);
    if wait_for_process_exit(pid, GRACEFUL_STOP_TIMEOUT) {
        StopOutcome::Graceful
    } else {
        force_kill_process_tree(pid);
        StopOutcome::Forced
    }
}

fn wait_for_process_exit(pid: u32, timeout: Duration) -> bool {
    if cfg!(windows) {
        let timeout_ms = timeout.as_millis();
        let script = format!(
            "$deadline = (Get-Date).AddMilliseconds({timeout_ms}); \
             while (Get-Process -Id {pid} -ErrorAction SilentlyContinue) {{ \
               if ((Get-Date) -ge $deadline) {{ exit 1 }}; \
               Start-Sleep -Milliseconds 200 \
             }}; exit 0"
        );
        run_command_timeout(
            "powershell",
            &["-NoProfile", "-Command", &script],
            None,
            &[],
            timeout + Duration::from_secs(2),
        )
        .map(|output| output.success)
        .unwrap_or(false)
    } else {
        let started = Instant::now();
        while started.elapsed() < timeout {
            if !process_alive(pid) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        !process_alive(pid)
    }
}

pub fn sanitize_persisted_core_log_once(app: &AppHandle, runtime: &SharedRuntime) {
    let should_sanitize = {
        let mut guard = runtime.lock();
        if guard.persisted_log_sanitized {
            false
        } else {
            guard.persisted_log_sanitized = true;
            true
        }
    };
    if !should_sanitize {
        return;
    }

    let Ok((_, paths)) = app_paths(app) else {
        return;
    };
    let path = PathBuf::from(paths.logs_dir).join("core.log");
    let _ = sanitize_persisted_core_log_file(&path);
}

pub fn task_history(runtime: &ServiceRuntime) -> Vec<TaskRecord> {
    runtime.tasks.iter().rev().cloned().collect()
}

pub fn sync_core_file_logs(app: &AppHandle, runtime: &SharedRuntime) -> Result<(), String> {
    let (_, paths) = app_paths(app)?;
    attach_persisted_core_if_running(app, runtime, &paths);
    sync_core_file_logs_from_paths(app, runtime, &paths)
}

fn sync_core_file_logs_from_paths(
    app: &AppHandle,
    runtime: &SharedRuntime,
    paths: &AppPaths,
) -> Result<(), String> {
    let Some(log_path) = latest_core_log_file(paths) else {
        return Ok(());
    };
    let file_len = fs::metadata(&log_path)
        .map_err(|error| format!("读取 Core 日志文件信息失败 {}: {error}", log_path.display()))?
        .len();
    let (offset, path_changed) = {
        let guard = runtime.lock();
        let path_changed =
            guard.core_log_path.as_ref().map(|path| path != &log_path).unwrap_or(true);
        let offset = if path_changed || guard.core_log_offset > file_len {
            file_len.saturating_sub(MAX_INITIAL_CORE_FILE_LOG_BYTES)
        } else {
            guard.core_log_offset
        };
        (offset, path_changed)
    };

    let (mut records, next_offset) =
        read_core_jsonl_records(&log_path, offset, MAX_CORE_LOG_READ_BYTES)?;
    if records.len() > MAX_CORE_LOG_RECORDS_PER_SYNC {
        let skipped = records.len() - MAX_CORE_LOG_RECORDS_PER_SYNC;
        records.drain(0..skipped);
    }
    let has_file_records = !records.is_empty();
    let entries = {
        let mut guard = runtime.lock();
        if path_changed {
            guard.core_log_path = Some(log_path);
            guard.core_file_log_ready = false;
        }
        let should_remove_console_duplicates = has_file_records && !guard.core_file_log_ready;
        guard.core_log_offset = next_offset;
        if has_file_records {
            guard.core_file_log_ready = true;
        }
        let mut entries = Vec::new();
        for record in records {
            entries.push(push_core_file_log(&mut guard, record, should_remove_console_duplicates));
        }
        entries
    };
    emit_log_batch(app, &entries);
    Ok(())
}

pub fn recent_core_logs(runtime: &ServiceRuntime) -> Vec<LogEntry> {
    runtime.logs.iter().filter(|entry| entry.stream == "core").cloned().collect()
}

fn emit_log_batch(app: &AppHandle, entries: &[LogEntry]) {
    if entries.is_empty() {
        return;
    }
    let _ = app.emit("gsdesk-log-batch", entries);
}

fn spawn_core_file_log_poller(app: AppHandle, runtime: SharedRuntime, paths: AppPaths) {
    let should_spawn = {
        let mut guard = runtime.lock();
        if guard.core_log_poller_active {
            false
        } else {
            guard.core_log_poller_active = true;
            true
        }
    };
    if !should_spawn {
        return;
    }

    std::thread::spawn(move || {
        let mut error_logged = false;
        loop {
            match sync_core_file_logs_from_paths(&app, &runtime, &paths) {
                Ok(_) => error_logged = false,
                Err(error) if !error_logged => {
                    push_system_log(
                        &app,
                        &runtime,
                        "warn",
                        &format!("读取 Core 文件日志失败，将继续重试: {error}"),
                    );
                    error_logged = true;
                }
                Err(_) => {}
            }

            let keep_running = {
                let mut guard = runtime.lock();
                refresh_child_exit_status(&mut guard, &paths);
                guard.child.is_some()
                    || matches!(guard.status, ServiceStatus::Starting | ServiceStatus::Running)
            };
            if !keep_running {
                break;
            }
            std::thread::sleep(Duration::from_millis(700));
        }

        let _ = sync_core_file_logs_from_paths(&app, &runtime, &paths);
        let mut guard = runtime.lock();
        guard.core_log_poller_active = false;
    });
}

fn start_task(runtime: &mut ServiceRuntime, name: &str, stage: &str, message: &str) -> u64 {
    let id = runtime.next_task_id;
    runtime.next_task_id += 1;
    runtime.cancel_requested = false;
    runtime.tasks.push_back(TaskRecord {
        id,
        name: name.to_string(),
        status: "running".to_string(),
        stage: stage.to_string(),
        message: message.to_string(),
        started_at: Utc::now().to_rfc3339(),
        ended_at: None,
        elapsed_ms: None,
    });
    while runtime.tasks.len() > 50 {
        runtime.tasks.pop_front();
    }
    id
}

pub fn start_runtime_task(runtime: &SharedRuntime, name: &str, stage: &str, message: &str) -> u64 {
    let mut guard = runtime.lock();
    start_task(&mut guard, name, stage, message)
}

fn update_task(runtime: &mut ServiceRuntime, id: u64, stage: &str, message: &str) {
    if let Some(task) = runtime.tasks.iter_mut().find(|task| task.id == id) {
        task.stage = stage.to_string();
        task.message = message.to_string();
    }
}

pub fn update_runtime_task(runtime: &SharedRuntime, id: u64, stage: &str, message: &str) {
    let mut guard = runtime.lock();
    update_task(&mut guard, id, stage, message);
}

fn finish_task(runtime: &mut ServiceRuntime, id: u64, status: &str, stage: &str, message: &str) {
    if let Some(task) = runtime.tasks.iter_mut().find(|task| task.id == id) {
        task.status = status.to_string();
        task.stage = stage.to_string();
        task.message = message.to_string();
        let ended_at = Utc::now();
        task.elapsed_ms =
            chrono::DateTime::parse_from_rfc3339(&task.started_at).ok().map(|started| {
                ended_at
                    .signed_duration_since(started.with_timezone(&Utc))
                    .num_milliseconds()
                    .max(0) as u128
            });
        task.ended_at = Some(ended_at.to_rfc3339());
    }
}

fn finish_task_if_running(
    runtime: &mut ServiceRuntime,
    id: u64,
    status: &str,
    stage: &str,
    message: &str,
) {
    let should_finish = runtime
        .tasks
        .iter()
        .find(|task| task.id == id)
        .map(|task| task.status == "running")
        .unwrap_or(false);
    if should_finish {
        finish_task(runtime, id, status, stage, message);
    }
}

pub fn finish_runtime_task(
    runtime: &SharedRuntime,
    id: u64,
    status: &str,
    stage: &str,
    message: &str,
) {
    let mut guard = runtime.lock();
    finish_task(&mut guard, id, status, stage, message);
}

pub fn push_system_log(app: &AppHandle, runtime: &SharedRuntime, level: &str, line: &str) {
    let mut guard = runtime.lock();
    push_log(&mut guard, app, "system", level, line);
}

pub fn reset_runtime_after_data_clear(runtime: &SharedRuntime) {
    let mut guard = runtime.lock();
    *guard = ServiceRuntime::default();
}

pub fn cancel_current_task(app: &AppHandle, runtime: &SharedRuntime) -> Result<(), String> {
    let pid_to_kill = {
        let mut guard = runtime.lock();
        let Some(index) = guard.tasks.iter().rposition(|task| task.status == "running") else {
            return Err("当前没有运行中的任务".to_string());
        };
        let task_name = guard.tasks[index].name.clone();
        guard.cancel_requested = true;
        guard.tasks[index].stage = "cancel_requested".to_string();
        guard.tasks[index].message = "已请求取消，正在停止当前任务".to_string();
        let pid_to_kill = if task_name == "启动 Core" || guard.status == ServiceStatus::Starting {
            guard.child.as_ref().map(|child| child.id())
        } else {
            None
        };
        push_log(&mut guard, app, "system", "warn", &format!("已请求取消任务: {task_name}"));
        pid_to_kill
    };

    if let Some(pid) = pid_to_kill {
        force_kill_process_tree(pid);
    }
    Ok(())
}

pub fn take_cancel_requested(runtime: &SharedRuntime) -> bool {
    let mut guard = runtime.lock();
    let requested = guard.cancel_requested;
    guard.cancel_requested = false;
    requested
}

pub fn init_core_runtime(
    app: &AppHandle,
    runtime: &SharedRuntime,
    settings: &Settings,
) -> Result<(), String> {
    {
        let mut guard = runtime.lock();
        guard.status = ServiceStatus::Initializing;
        let task_id =
            start_task(&mut guard, "初始化运行时", "prepare", "开始初始化 gsuid_core 运行时");
        push_log(&mut guard, app, "system", "info", "开始初始化 gsuid_core 运行时");
        drop(guard);
        init_core_runtime_steps(app, runtime, settings, task_id)
    }
}

fn init_core_runtime_steps(
    app: &AppHandle,
    runtime: &SharedRuntime,
    settings: &Settings,
    task_id: u64,
) -> Result<(), String> {
    let (_, paths) = app_paths(app)?;
    let core_dir = PathBuf::from(&paths.core_dir);
    let core_parent =
        core_dir.parent().ok_or_else(|| "Core 路径缺少父目录".to_string())?.to_path_buf();
    fs::create_dir_all(&core_parent).map_err(|error| format!("创建 Core 父目录失败: {error}"))?;

    let envs = runtime_env(settings, &paths);
    let source = selected_source(settings);
    let source_state = core_source_state(&core_dir);
    let git_program =
        if matches!(&source_state, CoreSourceState::GitRepo | CoreSourceState::Missing) {
            match toolchain::git_program(app, &paths) {
                Ok(program) => Some(program),
                Err(error) => {
                    mark_task_failed(runtime, task_id, "toolchain", &error);
                    return Err(error);
                }
            }
        } else {
            None
        };
    {
        let mut guard = runtime.lock();
        update_task(&mut guard, task_id, "source", source_state_message(&source_state));
    }
    match source_state {
        CoreSourceState::GitRepo => {
            let Some(git_program) = git_program.as_deref() else {
                return Err("Git 工具未完成解析，无法更新 Core 源码".to_string());
            };
            if let Some(dirty) = core_repo_dirty(git_program, &core_dir, &envs)? {
                let message = format!("Core 源码存在未提交修改，已停止自动更新: {dirty}");
                mark_task_failed(runtime, task_id, "source", &message);
                return Err(message);
            }
            run_logged(
                app,
                runtime,
                git_program,
                &["fetch", "--all", "--prune"],
                Some(core_dir.as_path()),
                &envs,
                Duration::from_secs(120),
            )
            .inspect_err(|error| {
                mark_task_failed(runtime, task_id, "source", error);
            })?;
            run_logged(
                app,
                runtime,
                git_program,
                &["pull", "--ff-only"],
                Some(core_dir.as_path()),
                &envs,
                Duration::from_secs(120),
            )
            .inspect_err(|error| {
                mark_task_failed(runtime, task_id, "source", error);
            })?;
        }
        CoreSourceState::SourceTree => {
            let mut guard = runtime.lock();
            push_log(
                &mut guard,
                app,
                "system",
                "info",
                &format!("使用现有 Core 源码目录: {}", core_dir.display()),
            );
        }
        CoreSourceState::Missing => {
            let Some(git_program) = git_program.as_deref() else {
                return Err("Git 工具未完成解析，无法拉取 Core 源码".to_string());
            };
            clone_core_repo(app, runtime, git_program, source, &core_dir, &envs).inspect_err(
                |error| {
                    mark_task_failed(runtime, task_id, "source", error);
                },
            )?;
        }
        CoreSourceState::Invalid(message) => {
            mark_task_failed(runtime, task_id, "source", &message);
            return Err(message);
        }
    }

    let uv_program = match toolchain::uv_program(app, &paths) {
        Ok(program) => program,
        Err(error) => {
            let mut guard = runtime.lock();
            guard.status = ServiceStatus::Failed;
            guard.recent_error = Some(error.clone());
            push_log(&mut guard, app, "system", "error", "未检测到 uv，无法初始化 Python 环境");
            finish_task(&mut guard, task_id, "failed", "toolchain", &error);
            return Err(error);
        }
    };

    let python_result =
        toolchain::ensure_python_runtime(app, &paths, &uv_program, &envs, |stage, message| {
            let mut guard = runtime.lock();
            update_task(&mut guard, task_id, stage, message);
        })
        .inspect_err(|error| {
            mark_task_failed(runtime, task_id, "python", error);
        })?;
    {
        let mut guard = runtime.lock();
        push_log(
            &mut guard,
            app,
            "system",
            "info",
            &format!("Python 3.12 已就绪: {} / {}", python_result.source, python_result.python),
        );
    }
    {
        let mut guard = runtime.lock();
        update_task(&mut guard, task_id, "dependencies", "同步 Python 依赖");
    }
    run_logged(
        app,
        runtime,
        &uv_program,
        &["sync", "--no-dev"],
        Some(&core_dir),
        &envs,
        Duration::from_secs(1200),
    )
    .inspect_err(|error| {
        mark_task_failed(runtime, task_id, "dependencies", error);
    })?;

    let mut guard = runtime.lock();
    guard.status = ServiceStatus::Stopped;
    guard.recent_error = None;
    push_log(&mut guard, app, "system", "info", "运行时初始化完成");
    finish_task(&mut guard, task_id, "success", "done", "运行时初始化完成");
    Ok(())
}

fn core_repo_dirty(
    git_program: &str,
    core_dir: &Path,
    envs: &[(String, String)],
) -> Result<Option<String>, String> {
    let changes = core_repo_changes(git_program, core_dir, envs, false)?;
    if changes.is_empty() {
        Ok(None)
    } else {
        Ok(Some(core_changes_summary(&changes, 5)))
    }
}

fn core_repo_changes(
    git_program: &str,
    core_dir: &Path,
    envs: &[(String, String)],
    include_untracked: bool,
) -> Result<Vec<CoreRepoChange>, String> {
    let untracked_arg =
        if include_untracked { "--untracked-files=all" } else { "--untracked-files=no" };
    let output = run_command_timeout(
        git_program,
        &["status", "--porcelain", untracked_arg],
        Some(core_dir),
        envs,
        Duration::from_secs(20),
    )?;
    if !output.success {
        return Err(format!(
            "读取 Core git 状态失败: {}",
            first_non_empty(&output.stderr, &output.stdout)
        ));
    }
    Ok(output.stdout.lines().filter_map(parse_core_repo_change).collect())
}

fn parse_core_repo_change(line: &str) -> Option<CoreRepoChange> {
    let status = line.get(0..2)?.trim();
    let path = line.get(3..)?.trim();
    if status.is_empty() || path.is_empty() {
        return None;
    }
    let normalized_path = match path.rsplit_once(" -> ") {
        Some((_, next)) => next.trim(),
        None => path,
    }
    .replace('\\', "/");
    Some(CoreRepoChange { status: status.to_string(), path: normalized_path })
}

fn core_changes_summary(changes: &[CoreRepoChange], limit: usize) -> String {
    changes
        .iter()
        .take(limit)
        .map(|change| format!("{} {}", change.status, change.path))
        .collect::<Vec<_>>()
        .join("; ")
}

fn mark_task_failed(runtime: &SharedRuntime, task_id: u64, stage: &str, message: &str) {
    let mut guard = runtime.lock();
    finish_task_for_error(&mut guard, task_id, stage, message);
}

fn finish_task_for_error(runtime: &mut ServiceRuntime, task_id: u64, stage: &str, message: &str) {
    if is_task_cancelled_error(message) {
        runtime.cancel_requested = false;
        if matches!(
            runtime.status,
            ServiceStatus::Checking | ServiceStatus::Initializing | ServiceStatus::Starting
        ) {
            runtime.status = ServiceStatus::Stopped;
        }
        finish_task(runtime, task_id, "cancelled", "cancelled", message);
    } else {
        finish_task(runtime, task_id, "failed", stage, message);
    }
}

pub fn is_task_cancelled_error(message: &str) -> bool {
    message.starts_with("任务已取消")
}

pub fn start_core(
    app: &AppHandle,
    runtime: &SharedRuntime,
    settings: &Settings,
    request: Option<StartServiceRequest>,
) -> Result<ServiceSnapshot, String> {
    if let Some(request) = &request {
        ensure_gsuid_service(request.service_id.as_deref())?;
    }
    let (_, paths) = app_paths(app)?;
    if attach_persisted_core_if_running(app, runtime, &paths) {
        let mut guard = runtime.lock();
        return snapshot(&mut guard, &paths, core_git_metadata(app, &paths))
            .into_iter()
            .find(|service| service.service_id == GSUID_SERVICE_ID)
            .ok_or_else(|| "无法读取 Core 状态".to_string());
    }
    let core_dir = PathBuf::from(&paths.core_dir);
    if !core_dir.exists() {
        return Err("Core 源码不存在，请先执行一键初始化运行时".to_string());
    }
    let uv_program = toolchain::uv_program(app, &paths)?;
    let start_task_id = {
        let mut guard = runtime.lock();
        if guard.child.is_some() {
            return snapshot(&mut guard, &paths, core_git_metadata(app, &paths))
                .into_iter()
                .find(|service| service.service_id == GSUID_SERVICE_ID)
                .ok_or_else(|| "无法读取 Core 状态".to_string());
        }
        guard.status = ServiceStatus::Starting;
        let task_id = start_task(&mut guard, "启动 Core", "spawn", "正在启动 gsuid_core");
        push_log(&mut guard, app, "system", "info", "正在启动 gsuid_core");
        task_id
    };

    let port = resolve_start_port(settings, request.as_ref()).inspect_err(|error| {
        mark_task_failed(runtime, start_task_id, "port", error);
    })?;
    let mut command = Command::new(&uv_program);
    apply_default_child_env(&mut command);
    command
        .args(["run", "--python", "3.12", "core", "--host", "127.0.0.1", "--port"])
        .arg(port.to_string())
        .current_dir(&core_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in runtime_env(settings, &paths) {
        command.env(key, value);
    }
    command.env_remove(LEGACY_WINDOWS_STDIO_ENV);

    let mut child = command.spawn().map_err(|error| {
        let message = format!("启动 Core 失败: {error}");
        mark_task_failed(runtime, start_task_id, "spawn", &message);
        message
    })?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    {
        let mut guard = runtime.lock();
        let started_at = Utc::now().to_rfc3339();
        let child_id = child.id();
        persist_core_process(&paths, child_id, port, &started_at).ok();
        guard.port = Some(port);
        guard.started_at = Some(started_at);
        guard.recent_error = None;
        guard.core_file_log_ready = false;
        guard.webconsole_available = false;
        guard.next_webconsole_probe_at = None;
        guard.status = ServiceStatus::Starting;
        guard.child = Some(child);
        push_log(
            &mut guard,
            app,
            "system",
            "info",
            &format!("Core 已启动: http://127.0.0.1:{port}/app"),
        );
    }
    spawn_log_reader(app.clone(), runtime.inner.clone(), stdout, "stdout".to_string());
    spawn_log_reader(app.clone(), runtime.inner.clone(), stderr, "stderr".to_string());
    spawn_core_file_log_poller(app.clone(), runtime.clone(), paths.clone());
    spawn_webconsole_ready_probe(
        app.clone(),
        runtime.clone(),
        paths.clone(),
        port,
        Some(start_task_id),
        Duration::from_secs(60),
    );

    let mut guard = runtime.lock();
    snapshot(&mut guard, &paths, core_git_metadata(app, &paths))
        .into_iter()
        .find(|service| service.service_id == GSUID_SERVICE_ID)
        .ok_or_else(|| "无法读取 Core 状态".to_string())
}

pub fn ensure_webconsole_probe(app: &AppHandle, runtime: &SharedRuntime, paths: &AppPaths) {
    let port = {
        let guard = runtime.lock();
        if !matches!(guard.status, ServiceStatus::Starting | ServiceStatus::Running) {
            return;
        }
        if guard.webconsole_available {
            return;
        }
        if let Some(next_probe_at) = guard.next_webconsole_probe_at {
            if Instant::now() < next_probe_at {
                return;
            }
        }
        let Some(port) = guard.port else {
            return;
        };
        port
    };
    spawn_webconsole_ready_probe(
        app.clone(),
        runtime.clone(),
        paths.clone(),
        port,
        None,
        Duration::from_secs(15),
    );
}

fn spawn_webconsole_ready_probe(
    app: AppHandle,
    runtime: SharedRuntime,
    paths: AppPaths,
    port: u16,
    task_id: Option<u64>,
    timeout: Duration,
) {
    let should_spawn = {
        let mut guard = runtime.lock();
        if guard.webconsole_probe_active {
            false
        } else {
            guard.webconsole_probe_active = true;
            if let Some(task_id) = task_id {
                update_task(&mut guard, task_id, "webconsole", "Core 已启动，等待 WebConsole 就绪");
            }
            true
        }
    };
    if !should_spawn {
        return;
    }

    std::thread::spawn(move || {
        let base_url = format!("http://127.0.0.1:{port}");
        let started = Instant::now();
        let outcome = loop {
            if webconsole_available(&base_url) {
                break WebConsoleProbeOutcome::Ready;
            }

            let state = {
                let mut guard = runtime.lock();
                refresh_child_exit_status(&mut guard, &paths);
                if task_id.is_some() && guard.cancel_requested {
                    WebConsoleProbeOutcome::Cancelled
                } else if guard.child.is_none()
                    && matches!(guard.status, ServiceStatus::Stopping | ServiceStatus::Stopped)
                {
                    WebConsoleProbeOutcome::Stopped
                } else if guard.child.is_none()
                    && !matches!(guard.status, ServiceStatus::Starting | ServiceStatus::Running)
                {
                    WebConsoleProbeOutcome::Exited(
                        guard.recent_error.clone().unwrap_or_else(|| "Core 进程已退出".to_string()),
                    )
                } else if started.elapsed() >= timeout {
                    WebConsoleProbeOutcome::Timeout
                } else {
                    WebConsoleProbeOutcome::Pending
                }
            };

            match state {
                WebConsoleProbeOutcome::Pending => std::thread::sleep(Duration::from_millis(700)),
                outcome => break outcome,
            }
        };

        finish_webconsole_probe(&app, &runtime, &paths, task_id, &base_url, outcome);
    });
}

enum WebConsoleProbeOutcome {
    Ready,
    Timeout,
    Cancelled,
    Stopped,
    Exited(String),
    Pending,
}

fn finish_webconsole_probe(
    app: &AppHandle,
    runtime: &SharedRuntime,
    paths: &AppPaths,
    task_id: Option<u64>,
    base_url: &str,
    outcome: WebConsoleProbeOutcome,
) {
    if matches!(outcome, WebConsoleProbeOutcome::Cancelled) {
        let mut child = {
            let mut guard = runtime.lock();
            guard.child.take()
        };
        if let Some(child) = child.as_mut() {
            force_kill_process_tree(child.id());
            let _ = child.wait();
        }
    }

    let mut guard = runtime.lock();
    guard.webconsole_probe_active = false;
    match outcome {
        WebConsoleProbeOutcome::Ready => {
            guard.status = ServiceStatus::Running;
            guard.webconsole_available = true;
            guard.next_webconsole_probe_at = None;
            guard.recent_error = None;
            push_log(
                &mut guard,
                app,
                "system",
                "info",
                &format!("WebConsole 已就绪: {base_url}/app"),
            );
            if let Some(task_id) = task_id {
                finish_task_if_running(
                    &mut guard,
                    task_id,
                    "success",
                    "ready",
                    "Core 与 WebConsole 已就绪",
                );
            }
        }
        WebConsoleProbeOutcome::Timeout => {
            if matches!(guard.status, ServiceStatus::Starting | ServiceStatus::Running) {
                let should_report = task_id.is_some() || guard.status == ServiceStatus::Starting;
                guard.status = ServiceStatus::Running;
                guard.webconsole_available = false;
                guard.next_webconsole_probe_at = Some(Instant::now() + Duration::from_secs(30));
                if should_report {
                    push_log(&mut guard, app, "system", "warn", "Core 已启动，WebConsole 仍在等待");
                }
                if let Some(task_id) = task_id {
                    finish_task_if_running(
                        &mut guard,
                        task_id,
                        "success",
                        "waiting_webconsole",
                        "Core 已启动，WebConsole 仍在等待",
                    );
                }
            }
        }
        WebConsoleProbeOutcome::Cancelled => {
            let _ = clear_persisted_core_process(paths);
            guard.port = None;
            guard.started_at = None;
            guard.core_file_log_ready = false;
            guard.webconsole_available = false;
            guard.next_webconsole_probe_at = None;
            guard.cancel_requested = false;
            guard.status = ServiceStatus::Stopped;
            push_log(&mut guard, app, "system", "warn", "任务已取消: 启动 Core");
            if let Some(task_id) = task_id {
                finish_task_if_running(
                    &mut guard,
                    task_id,
                    "cancelled",
                    "cancelled",
                    "任务已取消: 启动 Core",
                );
            }
        }
        WebConsoleProbeOutcome::Stopped => {
            let _ = clear_persisted_core_process(paths);
            guard.port = None;
            guard.started_at = None;
            guard.core_file_log_ready = false;
            guard.webconsole_available = false;
            guard.next_webconsole_probe_at = None;
            guard.cancel_requested = false;
            guard.status = ServiceStatus::Stopped;
            if let Some(task_id) = task_id {
                finish_task_if_running(
                    &mut guard,
                    task_id,
                    "cancelled",
                    "stopped",
                    "启动已被停止动作中断",
                );
            }
        }
        WebConsoleProbeOutcome::Exited(error) => {
            guard.webconsole_available = false;
            guard.next_webconsole_probe_at = None;
            guard.status = ServiceStatus::Failed;
            guard.recent_error = Some(error.clone());
            push_log(&mut guard, app, "system", "error", &error);
            if let Some(task_id) = task_id {
                finish_task_if_running(&mut guard, task_id, "failed", "process", &error);
            }
        }
        WebConsoleProbeOutcome::Pending => {}
    }
}

pub fn stop_core(app: &AppHandle, runtime: &SharedRuntime) -> Result<(), String> {
    let (_, paths) = app_paths(app)?;
    let (task_id, child, persisted) = {
        let mut guard = runtime.lock();
        let task_id = start_task(&mut guard, "停止 Core", "stop", "正在停止 Core 进程");
        guard.status = ServiceStatus::Stopping;
        push_log(&mut guard, app, "system", "info", "正在停止 Core 进程");
        let child = guard.child.take();
        let persisted = if child.is_none() { load_persisted_core_process(&paths) } else { None };
        (task_id, child, persisted)
    };

    let outcome = if let Some(mut child) = child {
        stop_child_process_tree(&mut child)
    } else if let Some(record) = persisted {
        stop_persisted_process_tree(record.pid)
    } else {
        StopOutcome::NoProcess
    };

    let mut guard = runtime.lock();
    match outcome {
        StopOutcome::NoProcess => {
            push_log(&mut guard, app, "system", "info", "未检测到正在运行的 Core 进程");
        }
        StopOutcome::Graceful => {
            push_log(&mut guard, app, "system", "info", "Core 进程已优雅退出");
        }
        StopOutcome::Forced => {
            push_log(&mut guard, app, "system", "warn", "Core 优雅退出超时，已强制结束进程树");
        }
    }
    let _ = clear_persisted_core_process(&paths);
    guard.port = None;
    guard.started_at = None;
    guard.core_file_log_ready = false;
    guard.webconsole_available = false;
    guard.next_webconsole_probe_at = None;
    guard.status = ServiceStatus::Stopped;
    finish_task(&mut guard, task_id, "success", "done", "Core 进程已停止");
    Ok(())
}

pub fn repair_runtime(
    app: &AppHandle,
    runtime: &SharedRuntime,
    settings: &Settings,
    request: RepairRuntimeRequest,
) -> Result<(), String> {
    let (_, paths) = app_paths(app)?;
    let task_id = {
        let mut guard = runtime.lock();
        let message = repair_action_label(&request.action);
        start_task(&mut guard, "运行时修复", request.action.as_str(), &message)
    };
    let result = match request.action.as_str() {
        "sync_deps" => sync_dependencies(app, runtime, settings, &paths),
        "rebuild_venv" => remove_runtime_dir(&paths.venv_dir, &paths.runtime)
            .and_then(|_| sync_dependencies(app, runtime, settings, &paths)),
        "reclone_core" => reclone_core(app, runtime, settings, &paths),
        "clear_uv_cache" => {
            remove_runtime_dir(&paths.uv_cache_dir, &paths.runtime).and_then(|_| {
                fs::create_dir_all(&paths.uv_cache_dir)
                    .map_err(|error| format!("重建 uv cache 目录失败: {error}"))
            })
        }
        _ => Err(format!("未知修复动作: {}", request.action)),
    };

    let mut guard = runtime.lock();
    match &result {
        Ok(_) => {
            finish_task(&mut guard, task_id, "success", request.action.as_str(), "修复动作完成")
        }
        Err(error) => finish_task_for_error(&mut guard, task_id, request.action.as_str(), error),
    }
    result
}

pub fn install_playwright(
    app: &AppHandle,
    runtime: &SharedRuntime,
    settings: &Settings,
) -> Result<(), String> {
    let (_, paths) = app_paths(app)?;
    let task_id = start_runtime_task(
        runtime,
        "安装 Playwright",
        "prepare",
        "准备安装 Playwright Python 包和 Chromium 浏览器",
    );
    push_system_log(app, runtime, "info", "开始安装 Playwright 到 GSDesk 隔离运行时");
    let result = install_playwright_steps(app, runtime, settings, &paths, task_id);
    match &result {
        Ok(_) => {
            finish_runtime_task(
                runtime,
                task_id,
                "success",
                "done",
                "Playwright Chromium 已安装到隔离目录",
            );
            push_system_log(app, runtime, "info", "Playwright Chromium 已安装到隔离目录");
        }
        Err(error) => {
            let mut guard = runtime.lock();
            finish_task_for_error(&mut guard, task_id, "error", error);
            drop(guard);
            let level = if is_task_cancelled_error(error) { "warn" } else { "error" };
            push_system_log(app, runtime, level, error);
        }
    }
    result
}

fn install_playwright_steps(
    app: &AppHandle,
    runtime: &SharedRuntime,
    settings: &Settings,
    paths: &AppPaths,
    task_id: u64,
) -> Result<(), String> {
    let core_dir = PathBuf::from(&paths.core_dir);
    if !core_dir.join("pyproject.toml").is_file() {
        return Err(format!(
            "请先初始化 Core 运行时，再安装 Playwright。缺少: {}",
            core_dir.display()
        ));
    }

    let envs = runtime_env(settings, paths);
    let uv_program = toolchain::uv_program(app, paths)?;
    toolchain::ensure_python_runtime(app, paths, &uv_program, &envs, |stage, message| {
        update_runtime_task(runtime, task_id, stage, message);
        push_system_log(app, runtime, "info", message);
    })?;

    update_runtime_task(runtime, task_id, "dependencies", "确认 Core Python 依赖环境");
    run_logged(
        app,
        runtime,
        &uv_program,
        &["sync", "--no-dev"],
        Some(&core_dir),
        &envs,
        Duration::from_secs(1200),
    )?;

    let venv_python = find_venv_python(paths)
        .ok_or_else(|| format!("Core venv 不完整，未找到 Python: {}", paths.venv_dir))?;
    let venv_python_text = venv_python.to_string_lossy().to_string();

    update_runtime_task(runtime, task_id, "package", "安装 Playwright Python 包");
    run_logged(
        app,
        runtime,
        &uv_program,
        &["pip", "install", "--python", venv_python_text.as_str(), "playwright"],
        Some(&core_dir),
        &envs,
        Duration::from_secs(600),
    )?;

    fs::create_dir_all(&paths.playwright_browsers_dir)
        .map_err(|error| format!("创建 Playwright 浏览器目录失败: {error}"))?;
    update_runtime_task(runtime, task_id, "browsers", "下载 Playwright Chromium 浏览器");
    run_logged(
        app,
        runtime,
        &venv_python_text,
        &["-m", "playwright", "install", "chromium"],
        Some(&core_dir),
        &envs,
        Duration::from_secs(1200),
    )?;

    if !playwright_chromium_installed(&paths.playwright_browsers_dir) {
        return Err(format!(
            "Playwright 安装结束但未发现 Chromium 浏览器目录: {}",
            paths.playwright_browsers_dir
        ));
    }
    update_runtime_task(runtime, task_id, "verify", "Playwright Chromium 已验证");
    Ok(())
}

pub fn core_update(
    app: &AppHandle,
    runtime: &SharedRuntime,
    settings: &Settings,
    request: CoreUpdateRequest,
) -> Result<CoreUpdateResult, String> {
    let (_, paths) = app_paths(app)?;
    let CoreUpdateRequest { action, channel, target_commit } = request;
    let channel = channel.unwrap_or_else(|| "latest".to_string());
    let task_id = start_runtime_task(
        runtime,
        "Core 更新",
        action.as_str(),
        &format!("准备执行 Core {action}"),
    );
    let step = CoreUpdateStep {
        action: action.as_str(),
        channel: &channel,
        target_commit: target_commit.as_deref(),
        task_id,
    };
    let result = core_update_steps(app, runtime, settings, &paths, step);
    match &result {
        Ok(result) => {
            finish_runtime_task(runtime, task_id, "success", action.as_str(), &result.message);
            push_system_log(app, runtime, "info", &result.message);
        }
        Err(error) => {
            let mut guard = runtime.lock();
            finish_task_for_error(&mut guard, task_id, action.as_str(), error);
            drop(guard);
            let level = if is_task_cancelled_error(error) { "warn" } else { "error" };
            push_system_log(app, runtime, level, error);
        }
    }
    result
}

fn core_update_steps(
    app: &AppHandle,
    runtime: &SharedRuntime,
    settings: &Settings,
    paths: &AppPaths,
    step: CoreUpdateStep<'_>,
) -> Result<CoreUpdateResult, String> {
    let should_restart =
        matches!(step.action, "update" | "rollback") && core_process_running(runtime, paths);
    if should_restart {
        update_runtime_task(runtime, step.task_id, "stop", "Core 正在运行，先停止后更新");
        stop_core(app, runtime)
            .map_err(|error| format!("Core 自动停止失败，已取消更新: {error}"))?;
    }

    let mut result = match step.action {
        "check" => check_core_update(app, runtime, settings, paths, step.channel, step.task_id),
        "list_commits" => {
            list_core_commits(app, runtime, settings, paths, step.channel, step.task_id)
        }
        "clean" => clean_core_update_diff(app, runtime, settings, paths, step.task_id),
        "update" => apply_core_update(app, runtime, settings, paths, step.channel, step.task_id),
        "rollback" => {
            rollback_core_update(app, runtime, settings, paths, step.target_commit, step.task_id)
        }
        _ => Err(format!("未知 Core 更新动作: {}", step.action)),
    }?;

    if should_restart {
        update_runtime_task(runtime, step.task_id, "restart", "Core 更新完成，正在自动重启");
        start_core(app, runtime, settings, None)
            .map_err(|error| format!("{}，但自动重启 Core 失败: {error}", result.message))?;
        result.message = format!("{}，已自动重启 Core", result.message);
    }

    Ok(result)
}

fn core_process_running(runtime: &SharedRuntime, paths: &AppPaths) -> bool {
    let child_pid = {
        let guard = runtime.lock();
        guard.child.as_ref().map(|child| child.id())
    };
    if let Some(pid) = child_pid {
        return process_alive(pid);
    }
    running_persisted_core_process(paths).is_some()
}

pub fn create_runtime_backup(
    app: &AppHandle,
    runtime: &SharedRuntime,
) -> Result<RuntimeBackupResult, String> {
    let (_, paths) = app_paths(app)?;
    let task_id =
        start_runtime_task(runtime, "运行时备份", "prepare", "准备导出运行时用户数据快照");
    let result = create_runtime_backup_inner(&paths);
    match &result {
        Ok(result) => {
            finish_runtime_task(runtime, task_id, "success", "done", "运行时备份已导出");
            push_system_log(app, runtime, "info", &format!("运行时备份已导出: {}", result.path));
        }
        Err(error) => {
            finish_runtime_task(runtime, task_id, "failed", "error", error);
            push_system_log(app, runtime, "error", error);
        }
    }
    result
}

pub fn restore_runtime_backup(
    app: &AppHandle,
    runtime: &SharedRuntime,
    request: RuntimeRestoreRequest,
) -> Result<RuntimeRestoreResult, String> {
    let (_, paths) = app_paths(app)?;
    ensure_core_not_running(runtime, &paths)?;
    let task_id = start_runtime_task(
        runtime,
        "恢复运行时备份",
        "prepare",
        "准备恢复 Core data/config/plugins 和日志快照",
    );
    let result = restore_runtime_backup_inner(&paths, request.path.as_deref());
    match &result {
        Ok(result) => {
            finish_runtime_task(runtime, task_id, "success", "done", "运行时备份已恢复");
            push_system_log(app, runtime, "info", &format!("运行时备份已恢复: {}", result.path));
        }
        Err(error) => {
            finish_runtime_task(runtime, task_id, "failed", "error", error);
            push_system_log(app, runtime, "error", error);
        }
    }
    result
}

fn check_core_update(
    app: &AppHandle,
    runtime: &SharedRuntime,
    settings: &Settings,
    paths: &AppPaths,
    channel: &str,
    task_id: u64,
) -> Result<CoreUpdateResult, String> {
    let core_dir = ensure_core_git_repo(paths)?;
    let git_program = toolchain::git_program(app, paths)?;
    let envs = runtime_env(settings, paths);
    update_runtime_task(runtime, task_id, "fetch", "正在拉取远端更新信息");
    run_logged(
        app,
        runtime,
        &git_program,
        &["fetch", "--all", "--tags", "--prune"],
        Some(&core_dir),
        &envs,
        Duration::from_secs(180),
    )?;
    let current = git_output(&git_program, &core_dir, &envs, &["rev-parse", "--short", "HEAD"])?;
    let target_ref = resolve_update_target(&git_program, &core_dir, &envs, channel)?;
    let target =
        git_output(&git_program, &core_dir, &envs, &["rev-parse", "--short", &target_ref])?;
    let changed = current != target;
    Ok(CoreUpdateResult {
        action: "check".to_string(),
        channel: channel.to_string(),
        current_commit: Some(current.clone()),
        target_commit: Some(target.clone()),
        rollback_commit: load_core_rollback(paths).ok(),
        commits: Vec::new(),
        changed,
        message: if changed {
            format!("发现 Core 更新: {current} -> {target} ({channel})")
        } else {
            format!("Core 已是当前通道最新: {current}")
        },
    })
}

fn list_core_commits(
    app: &AppHandle,
    runtime: &SharedRuntime,
    settings: &Settings,
    paths: &AppPaths,
    channel: &str,
    task_id: u64,
) -> Result<CoreUpdateResult, String> {
    let core_dir = ensure_core_git_repo(paths)?;
    let git_program = toolchain::git_program(app, paths)?;
    let envs = runtime_env(settings, paths);
    update_runtime_task(runtime, task_id, "fetch", "正在拉取远端提交列表");
    run_logged(
        app,
        runtime,
        &git_program,
        &["fetch", "--all", "--tags", "--prune"],
        Some(&core_dir),
        &envs,
        Duration::from_secs(180),
    )?;
    let current_full = git_output(&git_program, &core_dir, &envs, &["rev-parse", "HEAD"])?;
    let current_short =
        git_output(&git_program, &core_dir, &envs, &["rev-parse", "--short", "HEAD"])?;
    let rollback = load_core_rollback(paths).ok();
    let commits =
        core_commit_entries(&git_program, &core_dir, &envs, &current_full, rollback.as_deref())?;
    let message = if commits.is_empty() {
        "Core 没有可选择的提交记录".to_string()
    } else {
        format!("已加载 {} 个 Core 提交，可选择目标版本", commits.len())
    };
    Ok(CoreUpdateResult {
        action: "list_commits".to_string(),
        channel: channel.to_string(),
        current_commit: Some(current_short),
        target_commit: commits.first().map(|commit| commit.short_commit.clone()),
        rollback_commit: rollback,
        commits,
        changed: false,
        message,
    })
}

fn clean_core_update_diff(
    app: &AppHandle,
    runtime: &SharedRuntime,
    settings: &Settings,
    paths: &AppPaths,
    task_id: u64,
) -> Result<CoreUpdateResult, String> {
    let core_dir = ensure_core_git_repo(paths)?;
    let git_program = toolchain::git_program(app, paths)?;
    let envs = runtime_env(settings, paths);
    let cleaned =
        clean_core_generated_diffs(app, runtime, &git_program, &core_dir, &envs, task_id)?;
    let current = git_output(&git_program, &core_dir, &envs, &["rev-parse", "--short", "HEAD"])?;
    let message = if cleaned.is_empty() {
        "Core 没有需要清理的更新差异".to_string()
    } else {
        format!("Core 已清理更新差异: {}", cleaned.join("、"))
    };
    Ok(CoreUpdateResult {
        action: "clean".to_string(),
        channel: "local".to_string(),
        current_commit: Some(current.clone()),
        target_commit: Some(current),
        rollback_commit: load_core_rollback(paths).ok(),
        commits: Vec::new(),
        changed: !cleaned.is_empty(),
        message,
    })
}

fn apply_core_update(
    app: &AppHandle,
    runtime: &SharedRuntime,
    settings: &Settings,
    paths: &AppPaths,
    channel: &str,
    task_id: u64,
) -> Result<CoreUpdateResult, String> {
    let core_dir = ensure_core_git_repo(paths)?;
    let git_program = toolchain::git_program(app, paths)?;
    let envs = runtime_env(settings, paths);
    let cleaned =
        clean_core_generated_diffs(app, runtime, &git_program, &core_dir, &envs, task_id)?;
    if let Some(dirty) = core_repo_dirty(&git_program, &core_dir, &envs)? {
        return Err(format!("Core 源码存在未提交修改，拒绝更新: {dirty}"));
    }
    update_runtime_task(runtime, task_id, "fetch", "正在拉取远端更新信息");
    run_logged(
        app,
        runtime,
        &git_program,
        &["fetch", "--all", "--tags", "--prune"],
        Some(&core_dir),
        &envs,
        Duration::from_secs(180),
    )?;
    let old_full = git_output(&git_program, &core_dir, &envs, &["rev-parse", "HEAD"])?;
    let old_short = git_output(&git_program, &core_dir, &envs, &["rev-parse", "--short", "HEAD"])?;
    let target_ref = resolve_update_target(&git_program, &core_dir, &envs, channel)?;
    validate_core_commit(&git_program, &core_dir, &envs, &target_ref, "Core 目标提交")?;
    let target_short =
        git_output(&git_program, &core_dir, &envs, &["rev-parse", "--short", &target_ref])?;
    save_core_rollback(paths, &old_full)?;

    update_runtime_task(runtime, task_id, "checkout", &format!("正在切换 Core 到 {target_ref}"));
    let result = if channel == "stable" {
        run_logged(
            app,
            runtime,
            &git_program,
            &["checkout", "--detach", &target_ref],
            Some(&core_dir),
            &envs,
            Duration::from_secs(120),
        )
    } else {
        run_logged(
            app,
            runtime,
            &git_program,
            &["merge", "--ff-only", &target_ref],
            Some(&core_dir),
            &envs,
            Duration::from_secs(120),
        )
    };
    if let Err(error) = result {
        let _ = run_logged(
            app,
            runtime,
            &git_program,
            &["reset", "--hard", &old_full],
            Some(&core_dir),
            &envs,
            Duration::from_secs(120),
        );
        return Err(format!("Core 更新失败，已尝试回滚到 {old_short}: {error}"));
    }
    update_runtime_task(runtime, task_id, "dependencies", "正在同步 Core 依赖");
    sync_dependencies(app, runtime, settings, paths)?;

    Ok(CoreUpdateResult {
        action: "update".to_string(),
        channel: channel.to_string(),
        current_commit: Some(old_short.clone()),
        target_commit: Some(target_short.clone()),
        rollback_commit: Some(old_full),
        commits: Vec::new(),
        changed: old_short != target_short,
        message: update_message_with_cleaned(
            if old_short == target_short {
                format!("Core 已在目标提交: {target_short}")
            } else {
                format!("Core 已更新: {old_short} -> {target_short}")
            },
            &cleaned,
        ),
    })
}

fn rollback_core_update(
    app: &AppHandle,
    runtime: &SharedRuntime,
    settings: &Settings,
    paths: &AppPaths,
    target_commit: Option<&str>,
    task_id: u64,
) -> Result<CoreUpdateResult, String> {
    let core_dir = ensure_core_git_repo(paths)?;
    let git_program = toolchain::git_program(app, paths)?;
    let envs = runtime_env(settings, paths);
    let cleaned =
        clean_core_generated_diffs(app, runtime, &git_program, &core_dir, &envs, task_id)?;
    if let Some(dirty) = core_repo_dirty(&git_program, &core_dir, &envs)? {
        return Err(format!("Core 源码存在未提交修改，拒绝回滚: {dirty}"));
    }
    let rollback = match target_commit.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => value.to_string(),
        None => load_core_rollback(paths)?,
    };
    validate_core_commit(&git_program, &core_dir, &envs, &rollback, "Core 回滚目标")?;
    let current_full = git_output(&git_program, &core_dir, &envs, &["rev-parse", "HEAD"])?;
    let current = git_output(&git_program, &core_dir, &envs, &["rev-parse", "--short", "HEAD"])?;
    let target = git_output(&git_program, &core_dir, &envs, &["rev-parse", "--short", &rollback])?;
    save_core_rollback(paths, &current_full)?;
    update_runtime_task(runtime, task_id, "rollback", &format!("正在回滚 Core 到 {target}"));
    run_logged(
        app,
        runtime,
        &git_program,
        &["reset", "--hard", &rollback],
        Some(&core_dir),
        &envs,
        Duration::from_secs(120),
    )?;
    update_runtime_task(runtime, task_id, "dependencies", "正在同步回滚后的依赖");
    sync_dependencies(app, runtime, settings, paths)?;
    Ok(CoreUpdateResult {
        action: "rollback".to_string(),
        channel: "rollback".to_string(),
        current_commit: Some(current.clone()),
        target_commit: Some(target.clone()),
        rollback_commit: Some(current_full),
        commits: Vec::new(),
        changed: current != target,
        message: update_message_with_cleaned(
            format!("Core 已回滚: {current} -> {target}"),
            &cleaned,
        ),
    })
}

fn clean_core_generated_diffs(
    app: &AppHandle,
    runtime: &SharedRuntime,
    git_program: &str,
    core_dir: &Path,
    envs: &[(String, String)],
    task_id: u64,
) -> Result<Vec<String>, String> {
    let changes = core_repo_changes(git_program, core_dir, envs, false)?;
    if changes.is_empty() {
        return Ok(Vec::new());
    }

    let mut cleanable = Vec::new();
    let mut blocked = Vec::new();
    for change in changes {
        if cleanable_core_update_path(&change.path) {
            cleanable.push(change.path);
        } else {
            blocked.push(change);
        }
    }
    if !blocked.is_empty() {
        return Err(format!(
            "Core 源码存在需要人工确认的修改，拒绝自动清理: {}",
            core_changes_summary(&blocked, 5)
        ));
    }
    if cleanable.is_empty() {
        return Ok(Vec::new());
    }

    update_runtime_task(
        runtime,
        task_id,
        "clean",
        &format!("正在清理 Core 更新差异: {}", cleanable.join("、")),
    );
    let mut args = vec![
        "restore".to_string(),
        "--staged".to_string(),
        "--worktree".to_string(),
        "--".to_string(),
    ];
    args.extend(cleanable.iter().cloned());
    let arg_refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    run_logged(
        app,
        runtime,
        git_program,
        &arg_refs,
        Some(core_dir),
        envs,
        Duration::from_secs(60),
    )?;
    Ok(cleanable)
}

fn cleanable_core_update_path(path: &str) -> bool {
    CLEANABLE_CORE_UPDATE_PATHS.contains(&path)
}

fn update_message_with_cleaned(message: String, cleaned: &[String]) -> String {
    if cleaned.is_empty() {
        message
    } else {
        format!("{message}；已清理更新差异: {}", cleaned.join("、"))
    }
}

fn ensure_core_git_repo(paths: &AppPaths) -> Result<PathBuf, String> {
    let core_dir = PathBuf::from(&paths.core_dir);
    if core_dir.join(".git").exists() {
        Ok(core_dir)
    } else {
        Err("Core 源码仓库不存在，请先初始化运行时".to_string())
    }
}

fn resolve_update_target(
    git_program: &str,
    core_dir: &Path,
    envs: &[(String, String)],
    channel: &str,
) -> Result<String, String> {
    if channel == "stable" {
        let tags = git_output(git_program, core_dir, envs, &["tag", "--sort=-v:refname"])?;
        return tags
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .map(str::to_string)
            .ok_or_else(|| "远端未发现可用 tag，无法使用 stable 通道".to_string());
    }
    if let Ok(upstream) = git_output(
        git_program,
        core_dir,
        envs,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    ) {
        if !upstream.trim().is_empty() {
            return Ok(upstream);
        }
    }
    for candidate in ["origin/master", "origin/main"] {
        if git_output(git_program, core_dir, envs, &["rev-parse", "--verify", candidate]).is_ok() {
            return Ok(candidate.to_string());
        }
    }
    Err("无法识别 Core 远端分支，请检查 git remote/upstream".to_string())
}

fn core_commit_entries(
    git_program: &str,
    core_dir: &Path,
    envs: &[(String, String)],
    current_commit: &str,
    rollback_commit: Option<&str>,
) -> Result<Vec<CoreCommitEntry>, String> {
    let output = git_output(
        git_program,
        core_dir,
        envs,
        &[
            "log",
            "--all",
            "--date=iso-strict",
            "--pretty=format:%H%x1f%h%x1f%cI%x1f%an%x1f%s",
            "-n",
            "80",
        ],
    )?;
    Ok(output
        .lines()
        .filter_map(|line| parse_core_commit_entry(line, current_commit, rollback_commit))
        .collect())
}

fn parse_core_commit_entry(
    line: &str,
    current_commit: &str,
    rollback_commit: Option<&str>,
) -> Option<CoreCommitEntry> {
    let mut parts = line.splitn(5, '\x1f');
    let commit = parts.next()?.trim();
    let short_commit = parts.next()?.trim();
    let committed_at = parts.next()?.trim();
    let author = parts.next()?.trim();
    let subject = parts.next()?.trim();
    if commit.is_empty() || short_commit.is_empty() {
        return None;
    }
    let rollback_matches = rollback_commit
        .is_some_and(|rollback| commit.starts_with(rollback) || rollback.starts_with(commit));
    Some(CoreCommitEntry {
        commit: commit.to_string(),
        short_commit: short_commit.to_string(),
        subject: if subject.is_empty() {
            "(无提交说明)".to_string()
        } else {
            subject.to_string()
        },
        author: if author.is_empty() { "unknown".to_string() } else { author.to_string() },
        committed_at: committed_at.to_string(),
        is_current: commit == current_commit,
        is_rollback: rollback_matches,
    })
}

fn git_output(
    git_program: &str,
    core_dir: &Path,
    envs: &[(String, String)],
    args: &[&str],
) -> Result<String, String> {
    let output =
        run_command_timeout(git_program, args, Some(core_dir), envs, Duration::from_secs(30))?;
    if output.success {
        Ok(output.stdout.trim().to_string())
    } else {
        Err(first_non_empty(&output.stderr, &output.stdout))
    }
}

fn validate_core_commit(
    git_program: &str,
    core_dir: &Path,
    envs: &[(String, String)],
    revision: &str,
    label: &str,
) -> Result<(), String> {
    let commit_spec = format!("{revision}^{{commit}}");
    git_output(git_program, core_dir, envs, &["cat-file", "-e", &commit_spec])
        .map(|_| ())
        .map_err(|error| format!("{label} 不可用: {revision}；git: {error}"))
}

fn first_non_empty(a: &str, b: &str) -> String {
    let trimmed = a.trim();
    if trimmed.is_empty() {
        b.trim().to_string()
    } else {
        trimmed.to_string()
    }
}

fn core_rollback_file(paths: &AppPaths) -> PathBuf {
    PathBuf::from(&paths.backups_dir).join("core-rollback.txt")
}

fn save_core_rollback(paths: &AppPaths, commit: &str) -> Result<(), String> {
    let path = core_rollback_file(paths);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("创建 Core 回滚目录失败 {}: {error}", parent.display()))?;
    }
    fs::write(&path, commit)
        .map_err(|error| format!("写入 Core 回滚点失败 {}: {error}", path.display()))
}

fn load_core_rollback(paths: &AppPaths) -> Result<String, String> {
    fs::read_to_string(core_rollback_file(paths))
        .map(|value| value.trim().to_string())
        .map_err(|_| "没有可用 Core 回滚点，请先执行一次 Core 更新".to_string())
        .and_then(|value| {
            if value.is_empty() {
                Err("Core 回滚点为空".to_string())
            } else {
                Ok(value)
            }
        })
}

fn ensure_core_not_running(runtime: &SharedRuntime, paths: &AppPaths) -> Result<(), String> {
    let guard = runtime.lock();
    if guard.child.is_some() {
        return Err("Core 正在运行，恢复备份前请先停止 Core".to_string());
    }
    drop(guard);
    if let Some(record) = running_persisted_core_process(paths) {
        return Err(format!("检测到遗留 Core 进程 pid={}，恢复备份前请先停止 Core", record.pid));
    }
    Ok(())
}

fn sync_dependencies(
    app: &AppHandle,
    runtime: &SharedRuntime,
    settings: &Settings,
    paths: &AppPaths,
) -> Result<(), String> {
    let core_dir = PathBuf::from(&paths.core_dir);
    if !core_dir.exists() {
        return Err("Core 源码不存在，无法同步依赖，请先初始化运行时".to_string());
    }
    run_logged(
        app,
        runtime,
        &toolchain::uv_program(app, paths)?,
        &["sync", "--no-dev"],
        Some(&core_dir),
        &runtime_env(settings, paths),
        Duration::from_secs(1200),
    )
}

fn reclone_core(
    app: &AppHandle,
    runtime: &SharedRuntime,
    settings: &Settings,
    paths: &AppPaths,
) -> Result<(), String> {
    let core_dir = PathBuf::from(&paths.core_dir);
    let core_parent =
        core_dir.parent().ok_or_else(|| "Core 路径缺少父目录".to_string())?.to_path_buf();
    fs::create_dir_all(&core_parent).map_err(|error| format!("创建 Core 父目录失败: {error}"))?;

    let backup_dir = reclone_backup_dir(paths, &core_dir)?;
    if core_dir.exists() {
        let backup_parent = backup_dir.parent().ok_or_else(|| "备份路径缺少父目录".to_string())?;
        fs::create_dir_all(backup_parent)
            .map_err(|error| format!("创建 Core 备份目录失败: {error}"))?;
        fs::rename(&core_dir, &backup_dir)
            .map_err(|error| format!("备份旧 Core 目录失败: {error}"))?;
    }

    let envs = runtime_env(settings, paths);
    let git_program = toolchain::git_program(app, paths)?;
    let clone_result =
        clone_core_repo(app, runtime, &git_program, selected_source(settings), &core_dir, &envs);
    if let Err(error) = clone_result {
        if backup_dir.exists() && !core_dir.exists() {
            let _ = fs::rename(&backup_dir, &core_dir);
        }
        return Err(error);
    }

    if backup_dir.exists() {
        for name in ["data", "config", "plugins"] {
            let source = backup_dir.join(name);
            let target = core_dir.join(name);
            if source.exists() {
                copy_dir_all(&source, &target)
                    .map_err(|error| format!("恢复用户目录失败 {name}: {error}"))?;
            }
        }
        let mut guard = runtime.lock();
        push_log(
            &mut guard,
            app,
            "system",
            "info",
            &format!("Core 已重新 clone，旧目录备份在 {}", backup_dir.display()),
        );
    }

    sync_dependencies(app, runtime, settings, paths)
}

fn source_state_message(state: &CoreSourceState) -> &str {
    match state {
        CoreSourceState::GitRepo => "更新现有 gsuid_core 源码",
        CoreSourceState::SourceTree => "使用现有 Core 源码目录",
        CoreSourceState::Missing => "拉取 gsuid_core 源码",
        CoreSourceState::Invalid(_) => "检查 Core 源码目录",
    }
}

fn clone_core_repo(
    app: &AppHandle,
    runtime: &SharedRuntime,
    git_program: &str,
    source: &str,
    core_dir: &Path,
    envs: &[(String, String)],
) -> Result<(), String> {
    let target = core_dir.to_string_lossy().to_string();
    run_logged(
        app,
        runtime,
        git_program,
        &["clone", source, target.as_str()],
        None,
        envs,
        Duration::from_secs(300),
    )
}

fn reclone_backup_dir(paths: &AppPaths, core_dir: &Path) -> Result<PathBuf, String> {
    let timestamp = Utc::now().format("%Y%m%d%H%M%S");
    let runtime = PathBuf::from(&paths.runtime);
    if core_dir.starts_with(&runtime) {
        return Ok(runtime.join("backups").join(format!("gsuid_core-{timestamp}")));
    }
    let parent = core_dir.parent().ok_or_else(|| "Core 路径缺少父目录".to_string())?;
    let name =
        core_dir.file_name().and_then(|value| value.to_str()).filter(|value| !value.is_empty());
    let backup_name = match name {
        Some(value) => format!("{value}-backup-{timestamp}"),
        None => format!("gsuid_core-backup-{timestamp}"),
    };
    Ok(parent.join(backup_name))
}

fn copy_dir_all(source: &Path, target: &Path) -> std::io::Result<()> {
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let next_target = target.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_all(&entry.path(), &next_target)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), next_target)?;
        }
    }
    Ok(())
}

fn repair_action_label(action: &str) -> String {
    match action {
        "sync_deps" => "重跑 uv sync".to_string(),
        "rebuild_venv" => "重建 venv 并同步依赖".to_string(),
        "reclone_core" => "备份旧 Core 后重新 clone".to_string(),
        "clear_uv_cache" => "清理 uv cache".to_string(),
        _ => format!("执行 {action}"),
    }
}

fn remove_runtime_dir(target: &str, runtime_root: &str) -> Result<(), String> {
    let target = PathBuf::from(target);
    let runtime_root = PathBuf::from(runtime_root);
    let target_abs = normalize_path(&target)?;
    let runtime_abs = normalize_path(&runtime_root)?;
    if !target_abs.starts_with(&runtime_abs) {
        return Err(format!("拒绝删除运行时目录外路径: {}", target.display()));
    }
    if target_abs.exists() {
        fs::remove_dir_all(&target_abs)
            .map_err(|error| format!("删除目录失败 {}: {error}", target_abs.display()))?;
    }
    Ok(())
}

fn normalize_path(path: &Path) -> Result<PathBuf, String> {
    if path.exists() {
        fs::canonicalize(path).map_err(|error| format!("解析路径失败 {}: {error}", path.display()))
    } else if let Some(parent) = path.parent() {
        let parent = fs::canonicalize(parent)
            .map_err(|error| format!("解析父路径失败 {}: {error}", path.display()))?;
        Ok(parent.join(path.file_name().unwrap_or_default()))
    } else {
        Ok(path.to_path_buf())
    }
}

fn find_venv_python(paths: &AppPaths) -> Option<PathBuf> {
    let venv = PathBuf::from(&paths.venv_dir);
    let candidates = if cfg!(windows) {
        vec![venv.join("Scripts").join("python.exe"), venv.join("python.exe")]
    } else {
        vec![venv.join("bin").join("python"), venv.join("bin").join("python3")]
    };
    candidates.into_iter().find(|path| path.is_file())
}

fn playwright_chromium_installed(path: &str) -> bool {
    fs::read_dir(path)
        .ok()
        .map(|entries| {
            entries.filter_map(Result::ok).any(|entry| {
                let path = entry.path();
                path.is_dir()
                    && path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name.starts_with("chromium-"))
            })
        })
        .unwrap_or(false)
}

fn resolve_start_port(
    settings: &Settings,
    request: Option<&StartServiceRequest>,
) -> Result<u16, String> {
    if let Some(port) = request.and_then(|request| request.port) {
        return resolve_fixed_port(port, "启动请求端口");
    }
    if let Some(port) = settings.preferred_core_port {
        return resolve_fixed_port(port, "固定端口");
    }
    Ok(select_port())
}

fn resolve_fixed_port(port: u16, label: &str) -> Result<u16, String> {
    if !(1024..=65535).contains(&port) {
        return Err(format!("{label} {port} 不在允许范围 1024-65535"));
    }
    if !service_port_available(port) {
        return Err(format!(
            "{label} {port} 已被占用，请关闭占用进程，或在网络设置里改成其他可用端口"
        ));
    }
    Ok(port)
}

pub fn runtime_env(settings: &Settings, paths: &crate::models::AppPaths) -> Vec<(String, String)> {
    let mut envs = env_from_settings(settings);
    envs.push(("UV_PROJECT_ENVIRONMENT".to_string(), paths.venv_dir.clone()));
    envs.push(("UV_CACHE_DIR".to_string(), paths.uv_cache_dir.clone()));
    envs.push(("UV_PYTHON_INSTALL_DIR".to_string(), paths.uv_python_dir.clone()));
    envs.push(("UV_PYTHON_DOWNLOADS".to_string(), "never".to_string()));
    envs.push(("PLAYWRIGHT_BROWSERS_PATH".to_string(), paths.playwright_browsers_dir.clone()));
    envs.push(("PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT".to_string(), "120000".to_string()));
    envs.push(("PYTHONUTF8".to_string(), "1".to_string()));
    envs.push(("PYTHONIOENCODING".to_string(), PYTHON_IO_ENCODING.to_string()));
    envs.push(("PYTHONUNBUFFERED".to_string(), "1".to_string()));
    envs.push(("UV_NO_PROGRESS".to_string(), "1".to_string()));
    envs.push(("GIT_TERMINAL_PROMPT".to_string(), "0".to_string()));
    envs.push(("GIT_OPTIONAL_LOCKS".to_string(), "0".to_string()));
    envs.push(("NO_COLOR".to_string(), "1".to_string()));
    envs.push(("FORCE_COLOR".to_string(), "0".to_string()));
    envs.push(("CLICOLOR".to_string(), "0".to_string()));
    envs.push(("TERM".to_string(), "dumb".to_string()));
    envs
}

pub fn selected_source(settings: &Settings) -> &str {
    match settings.source_mode.as_str() {
        "cnb" => "https://cnb.cool/gscore-mirror/gsuid_core.git",
        "github" => "https://github.com/Genshin-bots/gsuid_core.git",
        _ if settings.selected_source.contains("cnb.cool")
            || settings.selected_source.contains("github.com") =>
        {
            settings.selected_source.as_str()
        }
        _ => "https://github.com/Genshin-bots/gsuid_core.git",
    }
}

fn run_logged(
    app: &AppHandle,
    runtime: &SharedRuntime,
    program: &str,
    args: &[&str],
    cwd: Option<&Path>,
    envs: &[(String, String)],
    timeout: Duration,
) -> Result<(), String> {
    {
        let mut guard = runtime.lock();
        push_log(&mut guard, app, "system", "info", &format!("执行: {program} {}", args.join(" ")));
    }

    let started = Instant::now();
    let mut command = Command::new(program);
    apply_default_child_env(&mut command);
    command.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    for (key, value) in envs {
        command.env(key, value);
    }
    command.env_remove(LEGACY_WINDOWS_STDIO_ENV);

    let mut child = command.spawn().map_err(|error| format!("执行命令失败 {program}: {error}"))?;
    let collected = Arc::new(Mutex::new(VecDeque::new()));
    let stdout_reader = spawn_command_log_reader(
        app.clone(),
        runtime.inner.clone(),
        child.stdout.take(),
        "system".to_string(),
        collected.clone(),
    );
    let stderr_reader = spawn_command_log_reader(
        app.clone(),
        runtime.inner.clone(),
        child.stderr.take(),
        "system".to_string(),
        collected.clone(),
    );

    let mut timed_out = false;
    let mut cancelled = false;
    let status = loop {
        if task_cancel_requested(runtime) {
            cancelled = true;
            force_kill_process_tree(child.id());
            break child.wait().ok();
        }
        let elapsed = started.elapsed();
        if elapsed >= timeout {
            timed_out = true;
            force_kill_process_tree(child.id());
            break child.wait().ok();
        }
        let wait_for = timeout
            .checked_sub(elapsed)
            .unwrap_or_else(|| Duration::from_millis(1))
            .min(Duration::from_millis(200));
        match child
            .wait_timeout(wait_for)
            .map_err(|error| format!("等待命令失败 {program}: {error}"))?
        {
            Some(status) => break Some(status),
            None => continue,
        }
    };

    if let Some(reader) = stdout_reader {
        let _ = reader.join();
    }
    if let Some(reader) = stderr_reader {
        let _ = reader.join();
    }

    let success = status.is_some_and(|status| status.success());
    if cancelled {
        let message = task_cancelled_message(program, args);
        let mut guard = runtime.lock();
        guard.cancel_requested = false;
        push_log(&mut guard, app, "system", "warn", &message);
        return Err(message);
    }
    if timed_out || !success {
        let base_message = if timed_out {
            format!("命令超时: {program} {}", args.join(" "))
        } else {
            format!("{program} {} 执行失败", args.join(" "))
        };
        let tail = command_log_tail(&collected);
        let message = if tail.is_empty() {
            base_message
        } else {
            format!("{base_message}\n最近输出:\n{tail}")
        };
        let mut guard = runtime.lock();
        guard.status = ServiceStatus::Failed;
        guard.recent_error = Some(message.clone());
        push_log(&mut guard, app, "system", "error", &message);
        return Err(message);
    }
    Ok(())
}

fn task_cancel_requested(runtime: &SharedRuntime) -> bool {
    runtime.lock().cancel_requested
}

fn task_cancelled_message(program: &str, args: &[&str]) -> String {
    format!("任务已取消: {program} {}", args.join(" "))
}

fn spawn_command_log_reader(
    app: AppHandle,
    runtime: Arc<Mutex<ServiceRuntime>>,
    stream: Option<impl Read + Send + 'static>,
    stream_name: String,
    collected: Arc<Mutex<VecDeque<String>>>,
) -> Option<std::thread::JoinHandle<()>> {
    stream.map(|mut stream| {
        std::thread::spawn(move || {
            let mut pending = Vec::new();
            let mut buffer = [0_u8; 4096];
            let mut filter = ConsoleLogFilter::default();
            loop {
                match stream.read(&mut buffer) {
                    Ok(0) => {
                        flush_command_log_bytes(
                            &runtime,
                            &app,
                            &stream_name,
                            &mut pending,
                            &mut filter,
                            &collected,
                            true,
                        );
                        break;
                    }
                    Ok(count) => {
                        pending.extend_from_slice(&buffer[..count]);
                        flush_command_log_bytes(
                            &runtime,
                            &app,
                            &stream_name,
                            &mut pending,
                            &mut filter,
                            &collected,
                            false,
                        );
                    }
                    Err(error) => {
                        let line = format!("读取命令日志流失败: {error}");
                        collect_command_log_records(&collected, std::slice::from_ref(&line));
                        push_log_text(&runtime, &app, &stream_name, &line);
                        break;
                    }
                }
            }
        })
    })
}

fn flush_command_log_bytes(
    runtime: &Arc<Mutex<ServiceRuntime>>,
    app: &AppHandle,
    stream: &str,
    pending: &mut Vec<u8>,
    filter: &mut ConsoleLogFilter,
    collected: &Arc<Mutex<VecDeque<String>>>,
    final_flush: bool,
) {
    for chunk in drain_delimited_log_chunks(pending) {
        push_log_text_filtered_collected(runtime, app, stream, filter, collected, &chunk);
    }

    if (final_flush && !pending.is_empty()) || pending.len() > 16 * 1024 {
        let chunk = String::from_utf8_lossy(pending).to_string();
        pending.clear();
        push_log_text_filtered_collected(runtime, app, stream, filter, collected, &chunk);
    }

    if final_flush {
        let records = filter.flush_pending();
        collect_command_log_records(collected, &records);
        push_log_records(runtime, app, stream, records);
    }
}

fn push_log_text_filtered_collected(
    runtime: &Arc<Mutex<ServiceRuntime>>,
    app: &AppHandle,
    stream: &str,
    filter: &mut ConsoleLogFilter,
    collected: &Arc<Mutex<VecDeque<String>>>,
    text: &str,
) {
    let records = filter.apply(normalize_log_records(text));
    collect_command_log_records(collected, &records);
    push_log_records(runtime, app, stream, records);
}

fn collect_command_log_records(collected: &Arc<Mutex<VecDeque<String>>>, records: &[String]) {
    if records.is_empty() {
        return;
    }
    let mut guard = lock_command_records(collected);
    for record in records {
        guard.push_back(record.clone());
        while guard.len() > 40 {
            guard.pop_front();
        }
    }
}

fn command_log_tail(collected: &Arc<Mutex<VecDeque<String>>>) -> String {
    let tail = lock_command_records(collected).iter().rev().take(8).cloned().collect::<Vec<_>>();
    tail.into_iter().rev().collect::<Vec<_>>().join("\n")
}

fn spawn_log_reader(
    app: AppHandle,
    runtime: Arc<Mutex<ServiceRuntime>>,
    stream: Option<impl Read + Send + 'static>,
    stream_name: String,
) {
    if let Some(mut stream) = stream {
        std::thread::spawn(move || {
            let mut pending = Vec::new();
            let mut buffer = [0_u8; 4096];
            let mut filter = ConsoleLogFilter::default();
            loop {
                match stream.read(&mut buffer) {
                    Ok(0) => {
                        flush_log_bytes(
                            &runtime,
                            &app,
                            &stream_name,
                            &mut pending,
                            &mut filter,
                            true,
                        );
                        break;
                    }
                    Ok(count) => {
                        pending.extend_from_slice(&buffer[..count]);
                        flush_log_bytes(
                            &runtime,
                            &app,
                            &stream_name,
                            &mut pending,
                            &mut filter,
                            false,
                        );
                    }
                    Err(error) => {
                        push_log_text(
                            &runtime,
                            &app,
                            &stream_name,
                            &format!("读取日志流失败: {error}"),
                        );
                        break;
                    }
                }
            }
        });
    }
}

fn flush_log_bytes(
    runtime: &Arc<Mutex<ServiceRuntime>>,
    app: &AppHandle,
    stream: &str,
    pending: &mut Vec<u8>,
    filter: &mut ConsoleLogFilter,
    final_flush: bool,
) {
    for chunk in drain_delimited_log_chunks(pending) {
        push_log_text_filtered(runtime, app, stream, filter, &chunk);
    }

    if (final_flush && !pending.is_empty()) || pending.len() > 16 * 1024 {
        let chunk = String::from_utf8_lossy(pending).to_string();
        pending.clear();
        push_log_text_filtered(runtime, app, stream, filter, &chunk);
    }

    if final_flush {
        push_log_records(runtime, app, stream, filter.flush_pending());
    }
}

fn drain_delimited_log_chunks(pending: &mut Vec<u8>) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut start = 0;
    let mut index = 0;

    while index < pending.len() {
        if pending[index] == b'\n' || pending[index] == b'\r' {
            if index > start {
                chunks.push(String::from_utf8_lossy(&pending[start..index]).to_string());
            }
            index += 1;
            if index < pending.len() && pending[index - 1] == b'\r' && pending[index] == b'\n' {
                index += 1;
            }
            while index < pending.len() && (pending[index] == b'\n' || pending[index] == b'\r') {
                index += 1;
            }
            start = index;
        } else {
            index += 1;
        }
    }

    if start > 0 {
        pending.drain(..start);
    }
    chunks
}

fn push_log_text(runtime: &Arc<Mutex<ServiceRuntime>>, app: &AppHandle, stream: &str, text: &str) {
    let records = normalize_log_records(text);
    push_log_records(runtime, app, stream, records);
}

fn push_log_text_filtered(
    runtime: &Arc<Mutex<ServiceRuntime>>,
    app: &AppHandle,
    stream: &str,
    filter: &mut ConsoleLogFilter,
    text: &str,
) {
    let records = filter.apply(normalize_log_records(text));
    push_log_records(runtime, app, stream, records);
}

fn push_log_records(
    runtime: &Arc<Mutex<ServiceRuntime>>,
    app: &AppHandle,
    stream: &str,
    records: Vec<String>,
) {
    if records.is_empty() {
        return;
    }

    let mut guard = lock_service_runtime(runtime);
    for record in records {
        if should_suppress_console_record(&guard, stream, &record) {
            continue;
        }
        let level = classify_level(&record);
        push_log(&mut guard, app, stream, level, &record);
    }
}

fn should_suppress_console_record(runtime: &ServiceRuntime, stream: &str, record: &str) -> bool {
    if is_standalone_python_gbk_encoding_error(record) {
        return true;
    }
    if !matches!(stream, "stdout" | "stderr") || !runtime.core_file_log_ready {
        return false;
    }
    is_core_structured_console_record(record) || is_core_lifecycle_console_record(record)
}

fn is_core_structured_console_record(record: &str) -> bool {
    is_structured_log_prefix_at(record.trim_start().as_bytes(), 0)
}

fn is_core_lifecycle_console_record(record: &str) -> bool {
    let trimmed = record.trim();
    trimmed.starts_with("Started server process")
        || trimmed.starts_with("Waiting for application startup")
        || trimmed.starts_with("Application startup complete")
        || trimmed.starts_with("Uvicorn running on ")
}

fn push_core_file_log(
    runtime: &mut ServiceRuntime,
    record: CoreFileLogRecord,
    remove_duplicate_console: bool,
) -> LogEntry {
    if remove_duplicate_console {
        remove_console_duplicate(runtime, &record.message);
    }
    let line = record.to_display_line();
    let entry = LogEntry {
        id: runtime.next_log_id,
        service_id: GSUID_SERVICE_ID.to_string(),
        stream: "core".to_string(),
        level: record.level,
        line,
        message: record.message,
        module: record.module,
        raw: record.raw,
        timestamp: record.timestamp,
    };
    runtime.next_log_id += 1;
    push_log_entry(runtime, entry.clone());
    entry
}

fn remove_console_duplicate(runtime: &mut ServiceRuntime, event: &str) {
    let event = event.trim();
    if event.len() < 8 {
        return;
    }
    runtime.logs.retain(|entry| {
        !(matches!(entry.stream.as_str(), "stdout" | "stderr") && entry.line.contains(event))
    });
}

pub fn push_log(
    runtime: &mut ServiceRuntime,
    app: &AppHandle,
    stream: &str,
    level: &str,
    line: &str,
) {
    let entry = LogEntry {
        id: runtime.next_log_id,
        service_id: GSUID_SERVICE_ID.to_string(),
        stream: stream.to_string(),
        level: level.to_string(),
        line: line.to_string(),
        message: line.to_string(),
        module: None,
        raw: None,
        timestamp: Utc::now().to_rfc3339(),
    };
    runtime.next_log_id += 1;
    push_log_entry(runtime, entry.clone());
    let _ = app.emit("gsdesk-log", &entry);
    persist_log(app, &entry);
}

fn push_log_entry(runtime: &mut ServiceRuntime, entry: LogEntry) {
    if entry.level == "error" && should_promote_recent_error(&entry.line) {
        runtime.recent_error = Some(entry.line.clone());
    }
    runtime.logs.push_back(entry);
    while runtime.logs.len() > MAX_LOG_ENTRIES {
        runtime.logs.pop_front();
    }
}

fn persist_log(app: &AppHandle, entry: &LogEntry) {
    if is_standalone_python_gbk_encoding_error(&entry.line) {
        return;
    }
    if matches!(entry.stream.as_str(), "stdout" | "stderr")
        && matches!(entry.level.as_str(), "debug" | "info")
    {
        return;
    }
    if let Ok((_, paths)) = app_paths(app) {
        let path = PathBuf::from(paths.logs_dir).join("core.log");
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ =
            rotate_persisted_log_if_needed(&path, MAX_PERSISTED_LOG_BYTES, MAX_ROTATED_LOG_FILES);
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
            let line = log_file_safe_text(&entry.line);
            let _ = writeln!(file, "[{}] [{}] {}", entry.timestamp, entry.stream, line);
        }
    }
}

fn sanitize_persisted_core_log_file(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let bytes =
        fs::read(path).map_err(|error| format!("读取持久日志失败 {}: {error}", path.display()))?;
    let content = String::from_utf8_lossy(&bytes);
    let lower = content.to_lowercase();
    if !lower.contains("unicodeencodeerror")
        && !content.contains("--- Logging error ---")
        && !contains_terminal_sensitive_char(content.as_ref())
    {
        return Ok(());
    }

    let sanitized = sanitize_persisted_log_content(content.as_ref());
    if sanitized != content {
        fs::write(path, sanitized.as_bytes())
            .map_err(|error| format!("清理持久日志失败 {}: {error}", path.display()))?;
    }
    Ok(())
}

fn rotate_persisted_log_if_needed(
    path: &Path,
    max_bytes: u64,
    keep_files: usize,
) -> Result<(), String> {
    let Ok(metadata) = fs::metadata(path) else {
        return Ok(());
    };
    if metadata.len() < max_bytes {
        return Ok(());
    }
    let Some(parent) = path.parent() else {
        return Ok(());
    };

    let timestamp = Utc::now().format("%Y%m%d-%H%M%S-%9f");
    let rotated = parent.join(format!("core-{timestamp}.log"));
    fs::rename(path, &rotated).map_err(|error| {
        format!("轮转 GSDesk 日志失败 {} -> {}: {error}", path.display(), rotated.display())
    })?;
    prune_rotated_logs(parent, keep_files)
}

fn prune_rotated_logs(log_dir: &Path, keep_files: usize) -> Result<(), String> {
    let mut files = fs::read_dir(log_dir)
        .map_err(|error| format!("读取日志目录失败 {}: {error}", log_dir.display()))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .map(|name| name.starts_with("core-") && name.ends_with(".log"))
                    .unwrap_or(false)
        })
        .filter_map(|path| {
            let modified = fs::metadata(&path).and_then(|metadata| metadata.modified()).ok()?;
            Some((path, modified))
        })
        .collect::<Vec<_>>();

    files.sort_by_key(|(_, modified)| *modified);
    files.reverse();
    for (path, _) in files.into_iter().skip(keep_files) {
        let _ = fs::remove_file(path);
    }
    Ok(())
}

fn webconsole_available(base_url: &str) -> bool {
    let url = format!("{}/app", base_url.trim_end_matches('/'));
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .ok()
        .and_then(|client| client.get(url).send().ok())
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use std::net::TcpListener;

    use super::*;

    fn unique_test_dir(name: &str) -> PathBuf {
        let stamp = Utc::now().timestamp_nanos_opt().unwrap_or_default();
        std::env::temp_dir().join(format!("gsdesk-{name}-{stamp}"))
    }

    fn test_paths(runtime: &Path) -> AppPaths {
        AppPaths {
            app_data: runtime.join("app").to_string_lossy().to_string(),
            runtime: runtime.to_string_lossy().to_string(),
            tools_dir: runtime.join("tools").to_string_lossy().to_string(),
            core_dir: runtime.join("core").join("gsuid_core").to_string_lossy().to_string(),
            venv_dir: runtime.join("venv").to_string_lossy().to_string(),
            uv_cache_dir: runtime.join("cache").to_string_lossy().to_string(),
            uv_python_dir: runtime.join("py").to_string_lossy().to_string(),
            uv_executable: runtime
                .join("tools")
                .join("uv")
                .join("uv")
                .to_string_lossy()
                .to_string(),
            playwright_browsers_dir: runtime
                .join("playwright")
                .join("browsers")
                .to_string_lossy()
                .to_string(),
            logs_dir: runtime.join("logs").to_string_lossy().to_string(),
            diagnostics_dir: runtime.join("diagnostics").to_string_lossy().to_string(),
            backups_dir: runtime.join("backups").to_string_lossy().to_string(),
            settings_file: runtime.join("settings.json").to_string_lossy().to_string(),
        }
    }

    #[test]
    fn selects_default_port() {
        let port = select_port();
        assert!(port >= 8765);
    }

    #[test]
    fn resolve_start_port_uses_available_preferred_port() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);

        let mut settings = Settings { preferred_core_port: Some(port), ..Settings::default() };

        assert_eq!(resolve_start_port(&settings, None).unwrap(), port);
        settings.preferred_core_port = None;
        assert!(resolve_start_port(&settings, None).unwrap() >= 8765);
    }

    #[test]
    fn resolve_start_port_rejects_occupied_fixed_port() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let settings = Settings { preferred_core_port: Some(port), ..Settings::default() };

        let error = resolve_start_port(&settings, None).unwrap_err();
        assert!(error.contains("固定端口"));
        assert!(error.contains("已被占用"));
    }

    #[test]
    fn selected_source_follows_mode() {
        let settings = Settings { source_mode: "cnb".to_string(), ..Settings::default() };
        assert!(selected_source(&settings).contains("cnb.cool"));
    }

    #[test]
    fn parses_core_repo_changes_from_porcelain_status() {
        let change = parse_core_repo_change(" M uv.lock").unwrap();

        assert_eq!(change.status, "M");
        assert_eq!(change.path, "uv.lock");

        let renamed = parse_core_repo_change("R  old.py -> new.py").unwrap();
        assert_eq!(renamed.status, "R");
        assert_eq!(renamed.path, "new.py");
    }

    #[test]
    fn cleanable_core_update_paths_are_limited() {
        assert!(cleanable_core_update_path("uv.lock"));
        assert!(!cleanable_core_update_path("pyproject.toml"));
        assert!(!cleanable_core_update_path("gsuid_core/plugins/user.py"));
    }

    #[test]
    fn parses_core_commit_entry_with_current_and_rollback_marks() {
        let current = "abc1234567890abcdef1234567890abcdef1234";
        let line = "abc1234567890abcdef1234567890abcdef1234\x1fabc1234\x1f2026-06-20T12:00:00+08:00\x1fdev\x1f修复启动流程";

        let entry = parse_core_commit_entry(line, current, Some("abc1234")).unwrap();

        assert_eq!(entry.short_commit, "abc1234");
        assert_eq!(entry.subject, "修复启动流程");
        assert!(entry.is_current);
        assert!(entry.is_rollback);
    }

    #[test]
    fn core_source_state_accepts_existing_source_tree() {
        let core_dir = unique_test_dir("source-tree");
        fs::create_dir_all(&core_dir).unwrap();
        fs::write(core_dir.join("pyproject.toml"), "[project]\nname = \"gsuid_core\"\n").unwrap();

        assert_eq!(core_source_state(&core_dir), CoreSourceState::SourceTree);

        let _ = fs::remove_dir_all(core_dir);
    }

    #[test]
    fn core_source_state_rejects_existing_invalid_directory() {
        let core_dir = unique_test_dir("invalid-core");
        fs::create_dir_all(&core_dir).unwrap();

        let state = core_source_state(&core_dir);

        assert!(
            matches!(state, CoreSourceState::Invalid(message) if message.contains("pyproject.toml"))
        );

        let _ = fs::remove_dir_all(core_dir);
    }

    #[test]
    fn reclone_backup_dir_keeps_managed_core_backup_under_runtime() {
        let runtime = unique_test_dir("managed-backup");
        let paths = test_paths(&runtime);
        let core_dir = runtime.join("core").join("gsuid_core");

        let backup_dir = reclone_backup_dir(&paths, &core_dir).unwrap();

        assert!(backup_dir.starts_with(runtime.join("backups")));
        assert!(backup_dir
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("gsuid_core-")));
    }

    #[test]
    fn reclone_backup_dir_keeps_custom_core_backup_as_sibling() {
        let runtime = unique_test_dir("custom-backup-runtime");
        let custom_parent = unique_test_dir("custom-core-parent");
        let paths = test_paths(&runtime);
        let core_dir = custom_parent.join("custom-core");

        let backup_dir = reclone_backup_dir(&paths, &core_dir).unwrap();

        assert!(backup_dir.starts_with(&custom_parent));
        assert!(backup_dir
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("custom-core-backup-")));
    }

    #[test]
    fn service_id_guard_keeps_nonebot2_as_unconfigured_service() {
        assert!(ensure_gsuid_service(None).is_ok());
        assert!(ensure_gsuid_service(Some(GSUID_SERVICE_ID)).is_ok());

        let error = ensure_gsuid_service(Some(NONEBOT_SERVICE_ID)).unwrap_err();

        assert!(error.contains("NoneBot2 暂未配置"));
        assert!(!error.contains("v1"));
    }

    #[test]
    fn attach_runtime_to_persisted_core_restores_detached_state() {
        let started_at = "2026-06-20T12:00:00+08:00".to_string();
        let record = PersistedCoreProcess { pid: 42, port: 8765, started_at: started_at.clone() };
        let mut runtime = ServiceRuntime {
            status: ServiceStatus::Stopped,
            recent_error: Some("旧错误".to_string()),
            webconsole_available: true,
            next_webconsole_probe_at: Some(Instant::now()),
            ..ServiceRuntime::default()
        };

        assert!(attach_runtime_to_persisted_core(&mut runtime, &record));
        assert_eq!(runtime.status, ServiceStatus::Running);
        assert_eq!(runtime.port, Some(8765));
        assert_eq!(runtime.started_at, Some(started_at));
        assert!(runtime.recent_error.is_none());
        assert!(!runtime.webconsole_available);
        assert!(runtime.next_webconsole_probe_at.is_none());
        assert!(!attach_runtime_to_persisted_core(&mut runtime, &record));
    }

    #[test]
    fn snapshot_restores_alive_persisted_core_process() {
        let runtime_dir = unique_test_dir("persisted-core-process");
        let paths = test_paths(&runtime_dir);
        let started_at = "2026-06-20T12:00:00+08:00";
        let pid = std::process::id();
        persist_core_process(&paths, pid, 18765, started_at).unwrap();

        let mut runtime = ServiceRuntime::default();
        let snapshot = snapshot(&mut runtime, &paths, None)
            .into_iter()
            .find(|service| service.service_id == GSUID_SERVICE_ID)
            .unwrap();

        assert_eq!(snapshot.status, ServiceStatus::Running);
        assert_eq!(snapshot.pid, Some(pid));
        assert_eq!(snapshot.port, Some(18765));
        assert_eq!(snapshot.url, Some("http://127.0.0.1:18765".to_string()));
        assert_eq!(snapshot.started_at, Some(started_at.to_string()));
        assert_eq!(runtime.status, ServiceStatus::Running);
        assert_eq!(runtime.port, Some(18765));

        let _ = fs::remove_dir_all(runtime_dir);
    }

    #[test]
    fn runtime_env_contains_uv_paths() {
        let settings = Settings::default();
        let paths = crate::models::AppPaths {
            app_data: "a".into(),
            runtime: "r".into(),
            tools_dir: "tools".into(),
            core_dir: "c".into(),
            venv_dir: "v".into(),
            uv_cache_dir: "cache".into(),
            uv_python_dir: "py".into(),
            uv_executable: "tools/uv/Scripts/uv.exe".into(),
            playwright_browsers_dir: "playwright".into(),
            logs_dir: "l".into(),
            diagnostics_dir: "d".into(),
            backups_dir: "b".into(),
            settings_file: "s".into(),
        };
        let envs = runtime_env(&settings, &paths);
        assert!(envs.iter().any(|(key, value)| key == "UV_PROJECT_ENVIRONMENT" && value == "v"));
        assert!(envs.iter().any(|(key, value)| key == "UV_PYTHON_DOWNLOADS" && value == "never"));
        assert!(envs.iter().any(|(key, value)| key == "GIT_TERMINAL_PROMPT" && value == "0"));
    }

    #[test]
    fn runtime_env_forces_python_utf8_on_windows_pipes() {
        let settings = Settings::default();
        let paths = crate::models::AppPaths {
            app_data: "a".into(),
            runtime: "r".into(),
            tools_dir: "tools".into(),
            core_dir: "c".into(),
            venv_dir: "v".into(),
            uv_cache_dir: "cache".into(),
            uv_python_dir: "py".into(),
            uv_executable: "tools/uv/Scripts/uv.exe".into(),
            playwright_browsers_dir: "playwright".into(),
            logs_dir: "l".into(),
            diagnostics_dir: "d".into(),
            backups_dir: "b".into(),
            settings_file: "s".into(),
        };
        let envs = runtime_env(&settings, &paths);

        assert!(envs.iter().any(|(key, value)| key == "PYTHONUTF8" && value == "1"));
        assert!(envs
            .iter()
            .any(|(key, value)| key == "PYTHONIOENCODING" && value == PYTHON_IO_ENCODING));
        assert!(!envs.iter().any(|(key, _)| key == LEGACY_WINDOWS_STDIO_ENV));
        assert!(envs.iter().any(|(key, value)| key == "PYTHONUNBUFFERED" && value == "1"));
        assert!(envs.iter().any(|(key, value)| key == "UV_NO_PROGRESS" && value == "1"));
        assert!(envs.iter().any(|(key, value)| key == "GIT_OPTIONAL_LOCKS" && value == "0"));
        assert!(envs.iter().any(|(key, value)| key == "NO_COLOR" && value == "1"));
        assert!(envs.iter().any(|(key, value)| key == "FORCE_COLOR" && value == "0"));
        assert!(envs.iter().any(|(key, value)| key == "CLICOLOR" && value == "0"));
        assert!(envs.iter().any(|(key, value)| key == "TERM" && value == "dumb"));
    }

    #[test]
    fn stop_commands_try_graceful_before_force() {
        assert_eq!(windows_taskkill_args(1234, false), vec!["/PID", "1234", "/T"]);
        assert_eq!(windows_taskkill_args(1234, true), vec!["/PID", "1234", "/T", "/F"]);
        assert_eq!(
            unix_tree_signal_script(1234, "TERM"),
            "pkill -TERM -P 1234 >/dev/null 2>&1 || true; kill -TERM 1234 >/dev/null 2>&1 || true"
        );
        assert_eq!(
            unix_tree_signal_script(1234, "KILL"),
            "pkill -KILL -P 1234 >/dev/null 2>&1 || true; kill -KILL 1234 >/dev/null 2>&1 || true"
        );
    }

    #[test]
    fn normalizes_carriage_returns_and_concatenated_structured_logs() {
        let records = normalize_log_records(
            "06-19 10:37:43 [info     ] first\r06-19 10:37:44 [success  ] second 06-19 10:37:45 [info     ] third\n",
        );

        assert_eq!(
            records,
            vec![
                "06-19 10:37:43 [info     ] first",
                "06-19 10:37:44 [success  ] second",
                "06-19 10:37:45 [info     ] third",
            ]
        );
    }

    #[test]
    fn suppresses_duplicate_core_console_after_file_log_ready() {
        let mut runtime = ServiceRuntime { core_file_log_ready: true, ..ServiceRuntime::default() };

        assert!(should_suppress_console_record(
            &runtime,
            "stdout",
            "06-19 10:37:47 [info     ] WebConsole挂载成功"
        ));
        assert!(should_suppress_console_record(
            &runtime,
            "stdout",
            "Started server process [36928]"
        ));
        assert!(!should_suppress_console_record(
            &runtime,
            "stderr",
            "Traceback (most recent call last):"
        ));

        runtime.core_file_log_ready = false;
        assert!(!should_suppress_console_record(
            &runtime,
            "stdout",
            "06-19 10:37:47 [info     ] WebConsole挂载成功"
        ));
    }

    #[test]
    fn suppresses_standalone_gbk_encoding_noise_before_file_log_ready() {
        let runtime = ServiceRuntime::default();

        assert!(should_suppress_console_record(
            &runtime,
            "stderr",
            "UnicodeEncodeError: 'gbk' codec can't encode character '\\U0001f5d1' in position 0: illegal multibyte sequence"
        ));
    }

    #[test]
    fn console_filter_drops_python_gbk_logging_noise_across_chunks() {
        let mut filter = ConsoleLogFilter::default();
        let first = filter.apply(vec![
            "--- Logging error ---".to_string(),
            "Traceback (most recent call last):".to_string(),
        ]);
        assert!(first.is_empty());

        let second = filter.apply(vec![
            "File \"C:\\Python\\Lib\\logging\\__init__.py\", line 1163, in emit".to_string(),
            "File \"C:\\venv\\Lib\\site-packages\\colorama\\ansitowin32.py\", line 210, in write_plain_text".to_string(),
            "UnicodeEncodeError: 'gbk' codec can't encode character '\\U0001f5d1' in position 0: illegal multibyte sequence".to_string(),
            "Call stack:".to_string(),
            "Arguments: ()".to_string(),
        ]);

        assert!(second.is_empty());
        assert!(filter.flush_pending().is_empty());
    }

    #[test]
    fn persisted_log_sanitizer_drops_python_gbk_logging_blocks() {
        let content = [
            "[2026-06-19T03:34:40Z] [stdout] keep before",
            "[2026-06-19T03:34:41Z] [stderr] --- Logging error ---",
            "[2026-06-19T03:34:41Z] [stderr] Traceback (most recent call last):",
            "[2026-06-19T03:34:41Z] [stderr] File \"C:\\Python\\Lib\\logging\\__init__.py\", line 1163, in emit",
            "[2026-06-19T03:34:41Z] [stderr] File \"C:\\venv\\Lib\\site-packages\\colorama\\ansitowin32.py\", line 210, in write_plain_text",
            "[2026-06-19T03:34:41Z] [stderr] UnicodeEncodeError: 'gbk' codec can't encode character '\\U0001f5d1' in position 0: illegal multibyte sequence",
            "[2026-06-19T03:34:41Z] [stderr] Call stack:",
            "[2026-06-19T03:34:41Z] [stderr] Message: {'event': '\\U0001f5d1\\ufe0f [ResourceManager] TTL'}",
            "[2026-06-19T03:34:41Z] [stderr] Arguments: ()",
            "[2026-06-19T03:34:42Z] [stdout] keep after",
            "",
        ]
        .join("\n");

        let sanitized = sanitize_persisted_log_content(&content);

        assert!(sanitized.contains("keep before"));
        assert!(sanitized.contains("keep after"));
        assert!(!sanitized.contains("UnicodeEncodeError"));
        assert!(!sanitized.contains("ResourceManager"));
        assert!(!sanitized.contains("--- Logging error ---"));
    }

    #[test]
    fn persisted_log_sanitizer_escapes_terminal_sensitive_emoji() {
        let trash = char::from_u32(0x1f5d1).unwrap();
        let content = format!(
            "[2026-06-19T05:16:10Z] [stdout] {trash}\u{fe0f} [ResourceManager] TTL 清理任务已启动\n"
        );

        let sanitized = sanitize_persisted_log_content(&content);

        assert!(sanitized.contains("\\u{1F5D1}\\u{FE0F} [ResourceManager]"));
        assert!(!sanitized.contains(trash));
    }

    #[test]
    fn task_cancel_error_marks_task_cancelled_and_next_task_clears_flag() {
        let mut runtime = ServiceRuntime {
            cancel_requested: true,
            status: ServiceStatus::Initializing,
            ..ServiceRuntime::default()
        };
        let first = start_task(&mut runtime, "初始化运行时", "python", "安装 Python");
        runtime.cancel_requested = true;

        finish_task_for_error(&mut runtime, first, "python", "任务已取消: uv python install 3.12");

        let task = runtime.tasks.iter().find(|task| task.id == first).unwrap();
        assert_eq!(task.status, "cancelled");
        assert_eq!(task.stage, "cancelled");
        assert!(!runtime.cancel_requested);
        assert_eq!(runtime.status, ServiceStatus::Stopped);

        let second = start_task(&mut runtime, "启动 Core", "spawn", "正在启动");
        assert!(!runtime.cancel_requested);
        assert_eq!(runtime.tasks.iter().find(|task| task.id == second).unwrap().status, "running");
    }

    #[test]
    fn console_filter_keeps_unrelated_python_logging_errors() {
        let mut filter = ConsoleLogFilter::default();
        let records = filter.apply(vec![
            "--- Logging error ---".to_string(),
            "Traceback (most recent call last):".to_string(),
            "RuntimeError: handler failed".to_string(),
            "Arguments: ()".to_string(),
        ]);

        assert_eq!(records.len(), 4);
        assert!(records[2].contains("RuntimeError"));
    }

    #[test]
    fn rotates_persisted_gsdesk_log_when_it_grows_too_large() {
        let dir = std::env::temp_dir().join(format!(
            "gsdesk-log-rotation-test-{}",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("core.log");
        fs::write(&path, "old gsdesk log").unwrap();

        rotate_persisted_log_if_needed(&path, 1, 5).unwrap();

        assert!(!path.exists());
        let rotated = fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("core-") && name.ends_with(".log"))
            })
            .collect::<Vec<_>>();
        assert_eq!(rotated.len(), 1);
        assert_eq!(fs::read_to_string(&rotated[0]).unwrap(), "old gsdesk log");

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn prunes_old_rotated_gsdesk_logs() {
        let dir = std::env::temp_dir().join(format!(
            "gsdesk-log-prune-test-{}",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        fs::create_dir_all(&dir).unwrap();
        for index in 0..5 {
            fs::write(dir.join(format!("core-20260619-00000{index}.log")), "old").unwrap();
        }

        prune_rotated_logs(&dir, 2).unwrap();

        let remaining = fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name.starts_with("core-") && name.ends_with(".log"))
            })
            .count();
        assert!(remaining <= 2);

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn strips_terminal_sequences_before_display() {
        let records = normalize_log_records("\u{1b}[32m06-19 10:37:47 [info     ] ready\u{1b}[0m");

        assert_eq!(records, vec!["06-19 10:37:47 [info     ] ready"]);
    }

    #[test]
    fn classifies_traceback_lines_as_errors() {
        assert_eq!(classify_level("Traceback (most recent call last):"), "error");
        assert_eq!(classify_level("File \"core.py\", line 79, in main"), "error");
        assert_eq!(classify_level("06-19 10:37:47 [success  ] started"), "info");
    }

    #[test]
    fn promotes_only_actionable_recent_errors() {
        assert!(!should_promote_recent_error("File \"core.py\", line 79, in main"));
        assert!(!should_promote_recent_error("Traceback (most recent call last):"));
        assert!(should_promote_recent_error("ModuleNotFoundError: No module named 'gsuid_core'"));
        assert!(should_promote_recent_error("06-19 10:37:45 [error    ] 启动失败"));
    }
}
