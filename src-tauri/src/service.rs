use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use wait_timeout::ChildExt;
use zip::write::FileOptions;

use crate::models::{
    AppPaths, CoreUpdateRequest, CoreUpdateResult, LogEntry, RepairRuntimeRequest,
    RuntimeBackupResult, RuntimeRestoreRequest, RuntimeRestoreResult, ServiceSnapshot,
    ServiceStatus, Settings, StartServiceRequest, TaskRecord,
};
use crate::paths::app_paths;
use crate::process::{
    apply_default_child_env, run_command_timeout, LEGACY_WINDOWS_STDIO_ENV, PYTHON_IO_ENCODING,
};
use crate::settings::{env_from_settings, redact_secrets};
use crate::toolchain;

pub const GSUID_SERVICE_ID: &str = "gsuid_core";
pub const NONEBOT_SERVICE_ID: &str = "nonebot2";
const MAX_LOG_ENTRIES: usize = 5000;
const MAX_PERSISTED_LOG_BYTES: u64 = 8 * 1024 * 1024;
const MAX_ROTATED_LOG_FILES: usize = 5;
const MAX_INITIAL_CORE_FILE_LOG_BYTES: u64 = 2 * 1024 * 1024;
const GRACEFUL_STOP_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Clone, Default)]
pub struct SharedRuntime {
    pub inner: Arc<Mutex<ServiceRuntime>>,
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
    pub core_log_poller_active: bool,
    pub tasks: VecDeque<TaskRecord>,
    pub next_task_id: u64,
    pub persisted_log_sanitized: bool,
    pub cancel_requested: bool,
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
            core_log_poller_active: false,
            tasks: VecDeque::new(),
            next_task_id: 1,
            persisted_log_sanitized: false,
            cancel_requested: false,
        }
    }
}

pub fn snapshot(
    runtime: &mut ServiceRuntime,
    paths: &AppPaths,
    core_git: Option<CoreGitMetadata>,
) -> Vec<ServiceSnapshot> {
    refresh_child_exit_status(runtime, paths);
    let persisted = if runtime.child.is_none() {
        load_persisted_core_process(paths).and_then(|record| {
            if process_alive(record.pid) {
                Some(record)
            } else {
                let _ = clear_persisted_core_process(paths);
                None
            }
        })
    } else {
        None
    };
    if let Some(record) = &persisted {
        runtime.port = Some(record.port);
        runtime.started_at = Some(record.started_at.clone());
        if matches!(
            runtime.status,
            ServiceStatus::Uninitialized | ServiceStatus::Stopped | ServiceStatus::Crashed
        ) {
            runtime.status = ServiceStatus::Running;
            runtime.recent_error = None;
        }
    }
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
    vec![
        ServiceSnapshot {
            service_id: GSUID_SERVICE_ID.to_string(),
            name: "Gsuid Core".to_string(),
            status: core_status,
            port: runtime.port,
            pid: core_pid,
            url: core_url.clone(),
            started_at: runtime.started_at.clone(),
            current_commit: core_git
                .as_ref()
                .and_then(|metadata| metadata.commit.clone()),
            current_tag: core_git.as_ref().and_then(|metadata| metadata.tag.clone()),
            recent_error: runtime.recent_error.clone(),
            health_ok: core_status == ServiceStatus::Running,
            webconsole_available: core_url
                .as_ref()
                .map(|url| webconsole_available(url))
                .unwrap_or(false),
        },
        ServiceSnapshot {
            service_id: NONEBOT_SERVICE_ID.to_string(),
            name: "NoneBot2".to_string(),
            status: ServiceStatus::Uninitialized,
            port: None,
            pid: None,
            url: None,
            started_at: None,
            current_commit: None,
            current_tag: None,
            recent_error: Some("v1 仅预留架构，后续支持项目目录、进程启动和连接检查".to_string()),
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
                runtime.status = ServiceStatus::Crashed;
                runtime.recent_error = Some(format!("Core 进程已退出，退出码: {status}"));
            }
            runtime.child = None;
            let _ = clear_persisted_core_process(paths);
        }
    }
}

#[derive(Debug, Clone)]
pub struct CoreGitMetadata {
    pub commit: Option<String>,
    pub tag: Option<String>,
}

pub fn core_git_metadata(paths: &AppPaths) -> Option<CoreGitMetadata> {
    let core_dir = PathBuf::from(&paths.core_dir);
    if !core_dir.join(".git").exists() {
        return None;
    }
    let commit = run_command_timeout(
        "git",
        &["rev-parse", "--short", "HEAD"],
        Some(&core_dir),
        &[],
        Duration::from_secs(5),
    )
    .ok()
    .and_then(|output| output.success.then(|| output.stdout.trim().to_string()))
    .filter(|value| !value.is_empty());
    let tag = run_command_timeout(
        "git",
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

pub fn core_runtime_installed(paths: &AppPaths) -> bool {
    let core_dir = PathBuf::from(&paths.core_dir);
    core_dir.join(".git").exists() || core_dir.join("pyproject.toml").exists()
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
    let record = PersistedCoreProcess {
        pid,
        port,
        started_at: started_at.to_string(),
    };
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

pub fn recent_logs(runtime: &ServiceRuntime) -> Vec<LogEntry> {
    runtime.logs.iter().cloned().collect()
}

pub fn sanitize_persisted_core_log_once(app: &AppHandle, runtime: &SharedRuntime) {
    let should_sanitize = {
        let mut guard = runtime.inner.lock().unwrap();
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
        let guard = runtime.inner.lock().unwrap();
        let path_changed = guard
            .core_log_path
            .as_ref()
            .map(|path| path != &log_path)
            .unwrap_or(true);
        let offset = if path_changed || guard.core_log_offset > file_len {
            file_len.saturating_sub(MAX_INITIAL_CORE_FILE_LOG_BYTES)
        } else {
            guard.core_log_offset
        };
        (offset, path_changed)
    };

    let (records, next_offset) = read_core_jsonl_records(&log_path, offset)?;
    let mut guard = runtime.inner.lock().unwrap();
    if path_changed {
        guard.core_log_path = Some(log_path);
    }
    guard.core_log_offset = next_offset;
    for record in records {
        push_core_file_log(&mut guard, app, record);
    }
    Ok(())
}

fn spawn_core_file_log_poller(app: AppHandle, runtime: SharedRuntime, paths: AppPaths) {
    let should_spawn = {
        let mut guard = runtime.inner.lock().unwrap();
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
                let mut guard = runtime.inner.lock().unwrap();
                refresh_child_exit_status(&mut guard, &paths);
                guard.child.is_some()
                    || matches!(
                        guard.status,
                        ServiceStatus::Starting | ServiceStatus::Running
                    )
            };
            if !keep_running {
                break;
            }
            std::thread::sleep(Duration::from_millis(700));
        }

        let _ = sync_core_file_logs_from_paths(&app, &runtime, &paths);
        let mut guard = runtime.inner.lock().unwrap();
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
    let mut guard = runtime.inner.lock().unwrap();
    start_task(&mut guard, name, stage, message)
}

fn update_task(runtime: &mut ServiceRuntime, id: u64, stage: &str, message: &str) {
    if let Some(task) = runtime.tasks.iter_mut().find(|task| task.id == id) {
        task.stage = stage.to_string();
        task.message = message.to_string();
    }
}

pub fn update_runtime_task(runtime: &SharedRuntime, id: u64, stage: &str, message: &str) {
    let mut guard = runtime.inner.lock().unwrap();
    update_task(&mut guard, id, stage, message);
}

fn finish_task(runtime: &mut ServiceRuntime, id: u64, status: &str, stage: &str, message: &str) {
    if let Some(task) = runtime.tasks.iter_mut().find(|task| task.id == id) {
        task.status = status.to_string();
        task.stage = stage.to_string();
        task.message = message.to_string();
        let ended_at = Utc::now();
        task.elapsed_ms = chrono::DateTime::parse_from_rfc3339(&task.started_at)
            .ok()
            .map(|started| {
                ended_at
                    .signed_duration_since(started.with_timezone(&Utc))
                    .num_milliseconds()
                    .max(0) as u128
            });
        task.ended_at = Some(ended_at.to_rfc3339());
    }
}

pub fn finish_runtime_task(
    runtime: &SharedRuntime,
    id: u64,
    status: &str,
    stage: &str,
    message: &str,
) {
    let mut guard = runtime.inner.lock().unwrap();
    finish_task(&mut guard, id, status, stage, message);
}

pub fn push_system_log(app: &AppHandle, runtime: &SharedRuntime, level: &str, line: &str) {
    let mut guard = runtime.inner.lock().unwrap();
    push_log(&mut guard, app, "system", level, line);
}

pub fn cancel_current_task(app: &AppHandle, runtime: &SharedRuntime) -> Result<(), String> {
    let pid_to_kill = {
        let mut guard = runtime.inner.lock().unwrap();
        let Some(index) = guard
            .tasks
            .iter()
            .rposition(|task| task.status == "running")
        else {
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
        push_log(
            &mut guard,
            app,
            "system",
            "warn",
            &format!("已请求取消任务: {task_name}"),
        );
        pid_to_kill
    };

    if let Some(pid) = pid_to_kill {
        force_kill_process_tree(pid);
    }
    Ok(())
}

pub fn take_cancel_requested(runtime: &SharedRuntime) -> bool {
    let mut guard = runtime.inner.lock().unwrap();
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
        let mut guard = runtime.inner.lock().unwrap();
        guard.status = ServiceStatus::Initializing;
        let task_id = start_task(
            &mut guard,
            "初始化运行时",
            "prepare",
            "开始初始化 gsuid_core 运行时",
        );
        push_log(
            &mut guard,
            app,
            "system",
            "info",
            "开始初始化 gsuid_core 运行时",
        );
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
    let core_parent = core_dir
        .parent()
        .ok_or_else(|| "Core 路径缺少父目录".to_string())?
        .to_path_buf();
    fs::create_dir_all(&core_parent).map_err(|error| format!("创建 Core 父目录失败: {error}"))?;

    let envs = runtime_env(settings, &paths);
    let source = selected_source(settings);
    {
        let mut guard = runtime.inner.lock().unwrap();
        update_task(
            &mut guard,
            task_id,
            "source",
            if core_dir.join(".git").exists() {
                "更新现有 gsuid_core 源码"
            } else {
                "拉取 gsuid_core 源码"
            },
        );
    }
    if core_dir.join(".git").exists() {
        if let Some(dirty) = core_repo_dirty(&core_dir, &envs)? {
            let message = format!("Core 源码存在未提交修改，已停止自动更新: {dirty}");
            mark_task_failed(runtime, task_id, "source", &message);
            return Err(message);
        }
        run_logged(
            app,
            runtime,
            "git",
            &["fetch", "--all", "--prune"],
            Some(core_dir.as_path()),
            &envs,
            Duration::from_secs(120),
        )
        .map_err(|error| {
            mark_task_failed(runtime, task_id, "source", &error);
            error
        })?;
        run_logged(
            app,
            runtime,
            "git",
            &["pull", "--ff-only"],
            Some(core_dir.as_path()),
            &envs,
            Duration::from_secs(120),
        )
        .map_err(|error| {
            mark_task_failed(runtime, task_id, "source", &error);
            error
        })?;
    } else {
        run_logged(
            app,
            runtime,
            "git",
            &["clone", source, "gsuid_core"],
            Some(core_parent.as_path()),
            &envs,
            Duration::from_secs(300),
        )
        .map_err(|error| {
            mark_task_failed(runtime, task_id, "source", &error);
            error
        })?;
    }

    let uv_program = match toolchain::uv_program(app, &paths) {
        Ok(program) => program,
        Err(error) => {
            let mut guard = runtime.inner.lock().unwrap();
            guard.status = ServiceStatus::Failed;
            guard.recent_error = Some(error.clone());
            push_log(
                &mut guard,
                app,
                "system",
                "error",
                "未检测到 uv，无法初始化 Python 环境",
            );
            finish_task(&mut guard, task_id, "failed", "toolchain", &error);
            return Err(error);
        }
    };

    {
        let mut guard = runtime.inner.lock().unwrap();
        update_task(&mut guard, task_id, "python", "安装 uv 托管 Python 3.12");
    }
    run_logged(
        app,
        runtime,
        &uv_program,
        &["python", "install", "3.12"],
        Some(&core_dir),
        &envs,
        Duration::from_secs(600),
    )
    .map_err(|error| {
        mark_task_failed(runtime, task_id, "python", &error);
        error
    })?;
    {
        let mut guard = runtime.inner.lock().unwrap();
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
    .map_err(|error| {
        mark_task_failed(runtime, task_id, "dependencies", &error);
        error
    })?;

    let mut guard = runtime.inner.lock().unwrap();
    guard.status = ServiceStatus::Stopped;
    guard.recent_error = None;
    push_log(&mut guard, app, "system", "success", "运行时初始化完成");
    finish_task(&mut guard, task_id, "success", "done", "运行时初始化完成");
    Ok(())
}

fn core_repo_dirty(core_dir: &Path, envs: &[(String, String)]) -> Result<Option<String>, String> {
    let output = run_command_timeout(
        "git",
        &["status", "--porcelain", "--untracked-files=no"],
        Some(core_dir),
        envs,
        Duration::from_secs(20),
    )?;
    let status = output.stdout.trim();
    if status.is_empty() {
        Ok(None)
    } else {
        Ok(Some(status.lines().take(5).collect::<Vec<_>>().join("; ")))
    }
}

fn mark_task_failed(runtime: &SharedRuntime, task_id: u64, stage: &str, message: &str) {
    let mut guard = runtime.inner.lock().unwrap();
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
        if let Some(service_id) = &request.service_id {
            if service_id != GSUID_SERVICE_ID {
                return Err("v1 仅支持启动 gsuid_core，NoneBot2 仅预留架构".to_string());
            }
        }
    }
    let (_, paths) = app_paths(app)?;
    let core_dir = PathBuf::from(&paths.core_dir);
    if !core_dir.exists() {
        return Err("Core 源码不存在，请先执行一键初始化运行时".to_string());
    }
    let uv_program = toolchain::uv_program(app, &paths)?;
    let start_task_id = {
        let mut guard = runtime.inner.lock().unwrap();
        if guard.child.is_some() {
            return snapshot(&mut guard, &paths, core_git_metadata(&paths))
                .into_iter()
                .find(|service| service.service_id == GSUID_SERVICE_ID)
                .ok_or_else(|| "无法读取 Core 状态".to_string());
        }
        guard.status = ServiceStatus::Starting;
        let task_id = start_task(&mut guard, "启动 Core", "spawn", "正在启动 gsuid_core");
        push_log(&mut guard, app, "system", "info", "正在启动 gsuid_core");
        task_id
    };

    let port = resolve_start_port(settings, request.as_ref()).map_err(|error| {
        mark_task_failed(runtime, start_task_id, "port", &error);
        error
    })?;
    let mut command = Command::new(&uv_program);
    apply_default_child_env(&mut command);
    command
        .args([
            "run",
            "--python",
            "3.12",
            "core",
            "--host",
            "127.0.0.1",
            "--port",
        ])
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
        let mut guard = runtime.inner.lock().unwrap();
        let started_at = Utc::now().to_rfc3339();
        let child_id = child.id();
        persist_core_process(&paths, child_id, port, &started_at).ok();
        guard.port = Some(port);
        guard.started_at = Some(started_at);
        guard.recent_error = None;
        guard.status = ServiceStatus::Starting;
        guard.child = Some(child);
        push_log(
            &mut guard,
            app,
            "system",
            "success",
            &format!("Core 已启动: http://127.0.0.1:{port}/app"),
        );
    }
    spawn_log_reader(
        app.clone(),
        runtime.inner.clone(),
        stdout,
        "stdout".to_string(),
    );
    spawn_log_reader(
        app.clone(),
        runtime.inner.clone(),
        stderr,
        "stderr".to_string(),
    );
    spawn_core_file_log_poller(app.clone(), runtime.clone(), paths.clone());

    let base_url = format!("http://127.0.0.1:{port}");
    let ready = match wait_for_webconsole(runtime, &base_url, Duration::from_secs(60)) {
        Ok(ready) => ready,
        Err(error) => {
            let mut guard = runtime.inner.lock().unwrap();
            if let Some(child) = guard.child.as_mut() {
                force_kill_process_tree(child.id());
                let _ = child.wait();
            }
            guard.child = None;
            let _ = clear_persisted_core_process(&paths);
            guard.port = None;
            guard.started_at = None;
            guard.status = ServiceStatus::Stopped;
            guard.cancel_requested = false;
            push_log(&mut guard, app, "system", "warn", &error);
            finish_task(&mut guard, start_task_id, "cancelled", "cancelled", &error);
            return Err(error);
        }
    };
    {
        let mut guard = runtime.inner.lock().unwrap();
        guard.status = ServiceStatus::Running;
        if ready {
            push_log(
                &mut guard,
                app,
                "system",
                "success",
                &format!("WebConsole 已就绪: {base_url}/app"),
            );
            finish_task(
                &mut guard,
                start_task_id,
                "success",
                "ready",
                "Core 与 WebConsole 已就绪",
            );
        } else {
            push_log(
                &mut guard,
                app,
                "system",
                "warn",
                "Core 进程已启动，但 WebConsole 在 60 秒内未就绪",
            );
            finish_task(
                &mut guard,
                start_task_id,
                "success",
                "waiting_webconsole",
                "Core 进程已启动，WebConsole 仍在等待",
            );
        }
    }

    let mut guard = runtime.inner.lock().unwrap();
    snapshot(&mut guard, &paths, core_git_metadata(&paths))
        .into_iter()
        .find(|service| service.service_id == GSUID_SERVICE_ID)
        .ok_or_else(|| "无法读取 Core 状态".to_string())
}

pub fn stop_core(app: &AppHandle, runtime: &SharedRuntime) -> Result<(), String> {
    let (_, paths) = app_paths(app)?;
    let (task_id, child, persisted) = {
        let mut guard = runtime.inner.lock().unwrap();
        let task_id = start_task(&mut guard, "停止 Core", "stop", "正在停止 Core 进程");
        guard.status = ServiceStatus::Stopping;
        push_log(&mut guard, app, "system", "info", "正在停止 Core 进程");
        let child = guard.child.take();
        let persisted = if child.is_none() {
            load_persisted_core_process(&paths)
        } else {
            None
        };
        (task_id, child, persisted)
    };

    let outcome = if let Some(mut child) = child {
        stop_child_process_tree(&mut child)
    } else if let Some(record) = persisted {
        stop_persisted_process_tree(record.pid)
    } else {
        StopOutcome::NoProcess
    };

    let mut guard = runtime.inner.lock().unwrap();
    match outcome {
        StopOutcome::NoProcess => {
            push_log(
                &mut guard,
                app,
                "system",
                "info",
                "未检测到正在运行的 Core 进程",
            );
        }
        StopOutcome::Graceful => {
            push_log(&mut guard, app, "system", "info", "Core 进程已优雅退出");
        }
        StopOutcome::Forced => {
            push_log(
                &mut guard,
                app,
                "system",
                "warn",
                "Core 优雅退出超时，已强制结束进程树",
            );
        }
    }
    let _ = clear_persisted_core_process(&paths);
    guard.port = None;
    guard.started_at = None;
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
        let mut guard = runtime.inner.lock().unwrap();
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

    let mut guard = runtime.inner.lock().unwrap();
    match &result {
        Ok(_) => finish_task(
            &mut guard,
            task_id,
            "success",
            request.action.as_str(),
            "修复动作完成",
        ),
        Err(error) => finish_task_for_error(&mut guard, task_id, request.action.as_str(), error),
    }
    result
}

pub fn core_update(
    app: &AppHandle,
    runtime: &SharedRuntime,
    settings: &Settings,
    request: CoreUpdateRequest,
) -> Result<CoreUpdateResult, String> {
    let (_, paths) = app_paths(app)?;
    let action = request.action.as_str();
    let channel = request.channel.unwrap_or_else(|| "latest".to_string());
    let task_id = start_runtime_task(
        runtime,
        "Core 更新",
        action,
        &format!("准备执行 Core {action}"),
    );
    let result = match action {
        "check" => check_core_update(app, runtime, settings, &paths, &channel, task_id),
        "update" => apply_core_update(app, runtime, settings, &paths, &channel, task_id),
        "rollback" => rollback_core_update(app, runtime, settings, &paths, task_id),
        _ => Err(format!("未知 Core 更新动作: {action}")),
    };
    match &result {
        Ok(result) => {
            finish_runtime_task(runtime, task_id, "success", action, &result.message);
            push_system_log(app, runtime, "success", &result.message);
        }
        Err(error) => {
            let mut guard = runtime.inner.lock().unwrap();
            finish_task_for_error(&mut guard, task_id, action, error);
            drop(guard);
            let level = if is_task_cancelled_error(error) {
                "warn"
            } else {
                "error"
            };
            push_system_log(app, runtime, level, error);
        }
    }
    result
}

pub fn create_runtime_backup(
    app: &AppHandle,
    runtime: &SharedRuntime,
) -> Result<RuntimeBackupResult, String> {
    let (_, paths) = app_paths(app)?;
    let task_id = start_runtime_task(
        runtime,
        "运行时备份",
        "prepare",
        "准备导出运行时用户数据快照",
    );
    let result = create_runtime_backup_inner(&paths);
    match &result {
        Ok(result) => {
            finish_runtime_task(runtime, task_id, "success", "done", "运行时备份已导出");
            push_system_log(
                app,
                runtime,
                "success",
                &format!("运行时备份已导出: {}", result.path),
            );
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
            push_system_log(
                app,
                runtime,
                "success",
                &format!("运行时备份已恢复: {}", result.path),
            );
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
    let envs = runtime_env(settings, paths);
    update_runtime_task(runtime, task_id, "fetch", "正在拉取远端更新信息");
    run_logged(
        app,
        runtime,
        "git",
        &["fetch", "--all", "--tags", "--prune"],
        Some(&core_dir),
        &envs,
        Duration::from_secs(180),
    )?;
    let current = git_output(&core_dir, &envs, &["rev-parse", "--short", "HEAD"])?;
    let target_ref = resolve_update_target(&core_dir, &envs, channel)?;
    let target = git_output(&core_dir, &envs, &["rev-parse", "--short", &target_ref])?;
    let changed = current != target;
    Ok(CoreUpdateResult {
        action: "check".to_string(),
        channel: channel.to_string(),
        current_commit: Some(current.clone()),
        target_commit: Some(target.clone()),
        rollback_commit: load_core_rollback(paths).ok(),
        changed,
        message: if changed {
            format!("发现 Core 更新: {current} -> {target} ({channel})")
        } else {
            format!("Core 已是当前通道最新: {current}")
        },
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
    let envs = runtime_env(settings, paths);
    if let Some(dirty) = core_repo_dirty(&core_dir, &envs)? {
        return Err(format!("Core 源码存在未提交修改，拒绝更新: {dirty}"));
    }
    update_runtime_task(runtime, task_id, "fetch", "正在拉取远端更新信息");
    run_logged(
        app,
        runtime,
        "git",
        &["fetch", "--all", "--tags", "--prune"],
        Some(&core_dir),
        &envs,
        Duration::from_secs(180),
    )?;
    let old_full = git_output(&core_dir, &envs, &["rev-parse", "HEAD"])?;
    let old_short = git_output(&core_dir, &envs, &["rev-parse", "--short", "HEAD"])?;
    let target_ref = resolve_update_target(&core_dir, &envs, channel)?;
    let target_short = git_output(&core_dir, &envs, &["rev-parse", "--short", &target_ref])?;
    save_core_rollback(paths, &old_full)?;

    update_runtime_task(
        runtime,
        task_id,
        "checkout",
        &format!("正在切换 Core 到 {target_ref}"),
    );
    let result = if channel == "stable" {
        run_logged(
            app,
            runtime,
            "git",
            &["checkout", "--detach", &target_ref],
            Some(&core_dir),
            &envs,
            Duration::from_secs(120),
        )
    } else {
        run_logged(
            app,
            runtime,
            "git",
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
            "git",
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
        changed: old_short != target_short,
        message: if old_short == target_short {
            format!("Core 已在目标提交: {target_short}")
        } else {
            format!("Core 已更新: {old_short} -> {target_short}")
        },
    })
}

fn rollback_core_update(
    app: &AppHandle,
    runtime: &SharedRuntime,
    settings: &Settings,
    paths: &AppPaths,
    task_id: u64,
) -> Result<CoreUpdateResult, String> {
    let core_dir = ensure_core_git_repo(paths)?;
    let envs = runtime_env(settings, paths);
    if let Some(dirty) = core_repo_dirty(&core_dir, &envs)? {
        return Err(format!("Core 源码存在未提交修改，拒绝回滚: {dirty}"));
    }
    let rollback = load_core_rollback(paths)?;
    let current = git_output(&core_dir, &envs, &["rev-parse", "--short", "HEAD"])?;
    let target = git_output(&core_dir, &envs, &["rev-parse", "--short", &rollback])?;
    update_runtime_task(
        runtime,
        task_id,
        "rollback",
        &format!("正在回滚 Core 到 {target}"),
    );
    run_logged(
        app,
        runtime,
        "git",
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
        rollback_commit: Some(rollback),
        changed: current != target,
        message: format!("Core 已回滚: {current} -> {target}"),
    })
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
    core_dir: &Path,
    envs: &[(String, String)],
    channel: &str,
) -> Result<String, String> {
    if channel == "stable" {
        let tags = git_output(core_dir, envs, &["tag", "--sort=-v:refname"])?;
        return tags
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .map(str::to_string)
            .ok_or_else(|| "远端未发现可用 tag，无法使用 stable 通道".to_string());
    }
    if let Ok(upstream) = git_output(
        core_dir,
        envs,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    ) {
        if !upstream.trim().is_empty() {
            return Ok(upstream);
        }
    }
    for candidate in ["origin/master", "origin/main"] {
        if git_output(core_dir, envs, &["rev-parse", "--verify", candidate]).is_ok() {
            return Ok(candidate.to_string());
        }
    }
    Err("无法识别 Core 远端分支，请检查 git remote/upstream".to_string())
}

fn git_output(core_dir: &Path, envs: &[(String, String)], args: &[&str]) -> Result<String, String> {
    let output = run_command_timeout("git", args, Some(core_dir), envs, Duration::from_secs(30))?;
    if output.success {
        Ok(output.stdout.trim().to_string())
    } else {
        Err(first_non_empty(&output.stderr, &output.stdout))
    }
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

fn create_runtime_backup_inner(paths: &AppPaths) -> Result<RuntimeBackupResult, String> {
    let backup_dir = PathBuf::from(&paths.backups_dir);
    fs::create_dir_all(&backup_dir)
        .map_err(|error| format!("创建备份目录失败 {}: {error}", backup_dir.display()))?;
    let path = backup_dir.join(format!(
        "gsdesk-runtime-{}.zip",
        Utc::now().format("%Y%m%d%H%M%S%9f")
    ));
    let file = File::create(&path)
        .map_err(|error| format!("创建备份文件失败 {}: {error}", path.display()))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let mut included = Vec::new();

    let settings_path = PathBuf::from(&paths.settings_file);
    if settings_path.is_file() {
        let settings = fs::read_to_string(&settings_path).map_err(|error| {
            format!("读取设置备份文件失败 {}: {error}", settings_path.display())
        })?;
        add_backup_text(
            &mut zip,
            options,
            "settings.redacted.json",
            &redact_secrets(&settings),
        )?;
        included.push("settings.redacted.json".to_string());
    }

    for (label, path) in [
        ("core-data", PathBuf::from(&paths.core_dir).join("data")),
        ("core-config", PathBuf::from(&paths.core_dir).join("config")),
        (
            "core-plugins",
            PathBuf::from(&paths.core_dir).join("plugins"),
        ),
        ("logs", PathBuf::from(&paths.logs_dir)),
    ] {
        if path.is_file() {
            add_backup_file(&mut zip, options, &path, label)?;
            included.push(label.to_string());
        } else if path.is_dir() {
            add_backup_dir(&mut zip, options, &path, label)?;
            included.push(label.to_string());
        }
    }
    zip.finish()
        .map_err(|error| format!("写入备份 zip 失败 {}: {error}", path.display()))?;
    Ok(RuntimeBackupResult {
        path: path.to_string_lossy().to_string(),
        included,
    })
}

fn restore_runtime_backup_inner(
    paths: &AppPaths,
    requested_path: Option<&str>,
) -> Result<RuntimeRestoreResult, String> {
    let backup_path = resolve_runtime_backup_path(paths, requested_path)?;
    let safety_backup = create_runtime_backup_inner(paths)
        .ok()
        .map(|backup| backup.path);
    let file = File::open(&backup_path)
        .map_err(|error| format!("打开运行时备份失败 {}: {error}", backup_path.display()))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| format!("读取运行时备份 zip 失败 {}: {error}", backup_path.display()))?;

    let restore_targets = restore_target_dirs(paths);
    let mut required_roots = Vec::new();
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| format!("读取备份条目失败: {error}"))?;
        let Some(root) = backup_entry_root(entry.name()) else {
            continue;
        };
        if restore_targets.contains_key(root) && !required_roots.contains(&root.to_string()) {
            required_roots.push(root.to_string());
        }
    }
    if required_roots.is_empty() {
        return Err(
            "运行时备份中没有可恢复的 core-data/core-config/core-plugins/logs 条目".to_string(),
        );
    }

    for root in &required_roots {
        if let Some(target) = restore_targets.get(root.as_str()) {
            if target.exists() {
                fs::remove_dir_all(target)
                    .map_err(|error| format!("清理恢复目标失败 {}: {error}", target.display()))?;
            }
            fs::create_dir_all(target)
                .map_err(|error| format!("创建恢复目标失败 {}: {error}", target.display()))?;
        }
    }

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("读取备份条目失败: {error}"))?;
        let name = entry.name().replace('\\', "/");
        let Some(root) = backup_entry_root(&name) else {
            continue;
        };
        let Some(target_root) = restore_targets.get(root) else {
            continue;
        };
        let Some(enclosed) = entry.enclosed_name().map(PathBuf::from) else {
            return Err(format!("备份条目路径不安全: {name}"));
        };
        let relative = enclosed
            .strip_prefix(root)
            .map_err(|_| format!("备份条目路径不匹配: {name}"))?;
        if relative.as_os_str().is_empty() {
            continue;
        }
        let target = target_root.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&target)
                .map_err(|error| format!("创建恢复目录失败 {}: {error}", target.display()))?;
        } else {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| format!("创建恢复目录失败 {}: {error}", parent.display()))?;
            }
            let mut output = File::create(&target)
                .map_err(|error| format!("创建恢复文件失败 {}: {error}", target.display()))?;
            std::io::copy(&mut entry, &mut output)
                .map_err(|error| format!("写入恢复文件失败 {}: {error}", target.display()))?;
        }
    }

    Ok(RuntimeRestoreResult {
        path: backup_path.to_string_lossy().to_string(),
        safety_backup,
        restored: required_roots,
    })
}

fn ensure_core_not_running(runtime: &SharedRuntime, paths: &AppPaths) -> Result<(), String> {
    let guard = runtime.inner.lock().unwrap();
    if guard.child.is_some() {
        return Err("Core 正在运行，恢复备份前请先停止 Core".to_string());
    }
    drop(guard);
    if let Some(record) = load_persisted_core_process(paths) {
        if process_alive(record.pid) {
            return Err(format!(
                "检测到遗留 Core 进程 pid={}，恢复备份前请先停止 Core",
                record.pid
            ));
        }
    }
    Ok(())
}

fn resolve_runtime_backup_path(
    paths: &AppPaths,
    requested_path: Option<&str>,
) -> Result<PathBuf, String> {
    let backup_dir = PathBuf::from(&paths.backups_dir);
    match requested_path {
        Some(path) if !path.trim().is_empty() => {
            let path = PathBuf::from(path);
            ensure_path_under_dir(&path, &backup_dir)?;
            Ok(path)
        }
        _ => latest_runtime_backup(&backup_dir),
    }
}

fn latest_runtime_backup(backup_dir: &Path) -> Result<PathBuf, String> {
    let mut files = fs::read_dir(backup_dir)
        .map_err(|error| format!("读取备份目录失败 {}: {error}", backup_dir.display()))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .map(|name| name.starts_with("gsdesk-runtime-") && name.ends_with(".zip"))
                    .unwrap_or(false)
        })
        .filter_map(|path| {
            let modified = fs::metadata(&path)
                .and_then(|metadata| metadata.modified())
                .ok()?;
            Some((path, modified))
        })
        .collect::<Vec<_>>();
    files.sort_by_key(|(_, modified)| *modified);
    files
        .pop()
        .map(|(path, _)| path)
        .ok_or_else(|| "没有找到可恢复的运行时备份，请先导出备份快照".to_string())
}

fn ensure_path_under_dir(path: &Path, dir: &Path) -> Result<(), String> {
    let path = normalize_path(path)?;
    let dir = normalize_path(dir)?;
    if path.starts_with(&dir) {
        Ok(())
    } else {
        Err(format!(
            "出于安全限制，只允许恢复备份目录内的 zip: {}",
            dir.display()
        ))
    }
}

fn restore_target_dirs(paths: &AppPaths) -> std::collections::HashMap<&'static str, PathBuf> {
    [
        ("core-data", PathBuf::from(&paths.core_dir).join("data")),
        ("core-config", PathBuf::from(&paths.core_dir).join("config")),
        (
            "core-plugins",
            PathBuf::from(&paths.core_dir).join("plugins"),
        ),
        ("logs", PathBuf::from(&paths.logs_dir)),
    ]
    .into_iter()
    .collect()
}

fn backup_entry_root(name: &str) -> Option<&str> {
    name.split('/')
        .next()
        .filter(|root| matches!(*root, "core-data" | "core-config" | "core-plugins" | "logs"))
}

fn add_backup_dir(
    zip: &mut zip::ZipWriter<File>,
    options: FileOptions,
    dir: &Path,
    prefix: &str,
) -> Result<(), String> {
    for entry in
        fs::read_dir(dir).map_err(|error| format!("读取备份目录失败 {}: {error}", dir.display()))?
    {
        let entry = entry.map_err(|error| format!("读取备份目录项失败: {error}"))?;
        let path = entry.path();
        let name = format!(
            "{}/{}",
            prefix,
            entry.file_name().to_string_lossy().replace('\\', "/")
        );
        if path.is_dir() {
            add_backup_dir(zip, options, &path, &name)?;
        } else if path.is_file() {
            add_backup_file(zip, options, &path, &name)?;
        }
    }
    Ok(())
}

fn add_backup_file(
    zip: &mut zip::ZipWriter<File>,
    options: FileOptions,
    path: &Path,
    name: &str,
) -> Result<(), String> {
    let name = name.replace('\\', "/");
    zip.start_file(name, options)
        .map_err(|error| format!("写入备份条目失败 {}: {error}", path.display()))?;
    let mut file = File::open(path)
        .map_err(|error| format!("打开备份文件失败 {}: {error}", path.display()))?;
    std::io::copy(&mut file, zip)
        .map_err(|error| format!("写入备份文件失败 {}: {error}", path.display()))?;
    Ok(())
}

fn add_backup_text(
    zip: &mut zip::ZipWriter<File>,
    options: FileOptions,
    name: &str,
    content: &str,
) -> Result<(), String> {
    zip.start_file(name.replace('\\', "/"), options)
        .map_err(|error| format!("写入备份条目失败 {name}: {error}"))?;
    zip.write_all(content.as_bytes())
        .map_err(|error| format!("写入备份文本失败 {name}: {error}"))
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
    let core_parent = core_dir
        .parent()
        .ok_or_else(|| "Core 路径缺少父目录".to_string())?
        .to_path_buf();
    fs::create_dir_all(&core_parent).map_err(|error| format!("创建 Core 父目录失败: {error}"))?;

    let backup_dir = PathBuf::from(&paths.runtime)
        .join("backups")
        .join(format!("gsuid_core-{}", Utc::now().format("%Y%m%d%H%M%S")));
    if core_dir.exists() {
        let backup_parent = backup_dir
            .parent()
            .ok_or_else(|| "备份路径缺少父目录".to_string())?;
        fs::create_dir_all(backup_parent)
            .map_err(|error| format!("创建 Core 备份目录失败: {error}"))?;
        fs::rename(&core_dir, &backup_dir)
            .map_err(|error| format!("备份旧 Core 目录失败: {error}"))?;
    }

    let envs = runtime_env(settings, paths);
    let clone_result = run_logged(
        app,
        runtime,
        "git",
        &["clone", selected_source(settings), "gsuid_core"],
        Some(core_parent.as_path()),
        &envs,
        Duration::from_secs(300),
    );
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
        let mut guard = runtime.inner.lock().unwrap();
        push_log(
            &mut guard,
            app,
            "system",
            "success",
            &format!("Core 已重新 clone，旧目录备份在 {}", backup_dir.display()),
        );
    }

    sync_dependencies(app, runtime, settings, paths)
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

pub fn service_port_available(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

pub fn select_port() -> u16 {
    for port in 8765..=8865 {
        if service_port_available(port) {
            return port;
        }
    }
    TcpListener::bind(("127.0.0.1", 0))
        .ok()
        .and_then(|listener| listener.local_addr().ok().map(|addr| addr.port()))
        .unwrap_or(8765)
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
            "{label} {port} 已被占用，请关闭占用进程，或在网络与设置里清空固定端口改回自动选择"
        ));
    }
    Ok(port)
}

pub fn runtime_env(settings: &Settings, paths: &crate::models::AppPaths) -> Vec<(String, String)> {
    let mut envs = env_from_settings(settings);
    envs.push(("UV_PROJECT_ENVIRONMENT".to_string(), paths.venv_dir.clone()));
    envs.push(("UV_CACHE_DIR".to_string(), paths.uv_cache_dir.clone()));
    envs.push((
        "UV_PYTHON_INSTALL_DIR".to_string(),
        paths.uv_python_dir.clone(),
    ));
    envs.push(("PYTHONUTF8".to_string(), "1".to_string()));
    envs.push((
        "PYTHONIOENCODING".to_string(),
        PYTHON_IO_ENCODING.to_string(),
    ));
    envs.push(("PYTHONUNBUFFERED".to_string(), "1".to_string()));
    envs.push(("UV_NO_PROGRESS".to_string(), "1".to_string()));
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

pub fn latest_core_log_file(paths: &AppPaths) -> Option<PathBuf> {
    let logs_dir = PathBuf::from(&paths.core_dir).join("data").join("logs");
    fs::read_dir(logs_dir)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .map(|extension| {
                        extension.eq_ignore_ascii_case("log")
                            || extension.eq_ignore_ascii_case("jsonl")
                    })
                    .unwrap_or(false)
        })
        .max_by_key(|path| {
            fs::metadata(path)
                .and_then(|metadata| metadata.modified())
                .ok()
        })
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
        let mut guard = runtime.inner.lock().unwrap();
        push_log(
            &mut guard,
            app,
            "system",
            "info",
            &format!("执行: {program} {}", args.join(" ")),
        );
    }

    let started = Instant::now();
    let mut command = Command::new(program);
    apply_default_child_env(&mut command);
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    for (key, value) in envs {
        command.env(key, value);
    }
    command.env_remove(LEGACY_WINDOWS_STDIO_ENV);

    let mut child = command
        .spawn()
        .map_err(|error| format!("执行命令失败 {program}: {error}"))?;
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
        let mut guard = runtime.inner.lock().unwrap();
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
        let mut guard = runtime.inner.lock().unwrap();
        guard.status = ServiceStatus::Failed;
        guard.recent_error = Some(message.clone());
        push_log(&mut guard, app, "system", "error", &message);
        return Err(message);
    }
    Ok(())
}

fn task_cancel_requested(runtime: &SharedRuntime) -> bool {
    runtime.inner.lock().unwrap().cancel_requested
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

    if final_flush && !pending.is_empty() {
        let chunk = String::from_utf8_lossy(pending).to_string();
        pending.clear();
        push_log_text_filtered_collected(runtime, app, stream, filter, collected, &chunk);
    } else if pending.len() > 16 * 1024 {
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
    let mut guard = collected.lock().unwrap();
    for record in records {
        guard.push_back(record.clone());
        while guard.len() > 40 {
            guard.pop_front();
        }
    }
}

fn command_log_tail(collected: &Arc<Mutex<VecDeque<String>>>) -> String {
    let tail = collected
        .lock()
        .unwrap()
        .iter()
        .rev()
        .take(8)
        .cloned()
        .collect::<Vec<_>>();
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

    if final_flush && !pending.is_empty() {
        let chunk = String::from_utf8_lossy(pending).to_string();
        pending.clear();
        push_log_text_filtered(runtime, app, stream, filter, &chunk);
    } else if pending.len() > 16 * 1024 {
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

    let mut guard = runtime.lock().unwrap();
    for record in records {
        let level = classify_level(&record);
        push_log(&mut guard, app, stream, level, &record);
    }
}

#[derive(Default)]
struct ConsoleLogFilter {
    pending_python_logging_error: Option<Vec<String>>,
}

impl ConsoleLogFilter {
    fn apply(&mut self, records: Vec<String>) -> Vec<String> {
        let mut output = Vec::new();
        for record in records {
            if let Some(block) = &mut self.pending_python_logging_error {
                block.push(record);
                if block.len() > 160 {
                    output.extend(self.pending_python_logging_error.take().unwrap_or_default());
                    continue;
                }
                if block
                    .last()
                    .is_some_and(|line| is_python_logging_error_block_end(line))
                {
                    let block = self.pending_python_logging_error.take().unwrap_or_default();
                    if !is_python_gbk_logging_noise(&block) {
                        output.extend(block);
                    }
                }
                continue;
            }

            if is_python_logging_error_block_start(&record) {
                self.pending_python_logging_error = Some(vec![record]);
                continue;
            }

            if is_standalone_python_gbk_encoding_error(&record) {
                continue;
            }

            output.push(record);
        }
        output
    }

    fn flush_pending(&mut self) -> Vec<String> {
        let block = self.pending_python_logging_error.take().unwrap_or_default();
        if is_python_gbk_logging_noise(&block) {
            Vec::new()
        } else {
            block
        }
    }
}

fn push_core_file_log(runtime: &mut ServiceRuntime, app: &AppHandle, record: CoreFileLogRecord) {
    remove_console_duplicate(runtime, &record.message);
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
    let _ = app.emit("gsdesk-log", &entry);
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
        && matches!(entry.level.as_str(), "info" | "success")
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

pub fn sanitize_persisted_log_content(content: &str) -> String {
    #[derive(Default)]
    struct PendingBlock {
        original_lines: Vec<String>,
        payloads: Vec<String>,
    }

    let mut output = Vec::new();
    let mut pending: Option<PendingBlock> = None;

    for line in content.lines() {
        let payload = persisted_log_payload(line).trim().to_string();
        if let Some(block) = &mut pending {
            block.original_lines.push(line.to_string());
            block.payloads.push(payload);

            if block.payloads.len() > 160 {
                let block = pending.take().unwrap_or_default();
                output.extend(
                    block
                        .original_lines
                        .iter()
                        .map(|line| log_file_safe_text(line)),
                );
                continue;
            }

            if block
                .payloads
                .last()
                .is_some_and(|line| is_python_logging_error_block_end(line))
            {
                let block = pending.take().unwrap_or_default();
                if !is_python_gbk_logging_noise(&block.payloads) {
                    output.extend(
                        block
                            .original_lines
                            .iter()
                            .map(|line| log_file_safe_text(line)),
                    );
                }
            }
            continue;
        }

        if is_python_logging_error_block_start(&payload) {
            pending = Some(PendingBlock {
                original_lines: vec![line.to_string()],
                payloads: vec![payload],
            });
            continue;
        }

        if is_standalone_python_gbk_encoding_error(&payload) {
            continue;
        }

        output.push(log_file_safe_text(line));
    }

    if let Some(block) = pending {
        if !is_python_gbk_logging_noise(&block.payloads) {
            output.extend(
                block
                    .original_lines
                    .iter()
                    .map(|line| log_file_safe_text(line)),
            );
        }
    }

    let mut sanitized = output.join("\n");
    if content.ends_with('\n') && !sanitized.is_empty() {
        sanitized.push('\n');
    }
    sanitized
}

fn log_file_safe_text(input: &str) -> String {
    if !contains_terminal_sensitive_char(input) {
        return input.to_string();
    }

    let mut output = String::with_capacity(input.len());
    for ch in input.chars() {
        if is_terminal_sensitive_char(ch) {
            output.push_str(&format!("\\u{{{:X}}}", ch as u32));
        } else {
            output.push(ch);
        }
    }
    output
}

fn contains_terminal_sensitive_char(input: &str) -> bool {
    input.chars().any(is_terminal_sensitive_char)
}

fn is_terminal_sensitive_char(ch: char) -> bool {
    let code = ch as u32;
    code == 0xFE0E
        || code == 0xFE0F
        || (0x2600..=0x27BF).contains(&code)
        || (0x1F000..=0x1FAFF).contains(&code)
}

fn persisted_log_payload(line: &str) -> &str {
    let Some(first_end) = line.find("] ") else {
        return line;
    };
    let after_timestamp = &line[first_end + 2..];
    let Some(second_end) = after_timestamp.find("] ") else {
        return line;
    };
    &after_timestamp[second_end + 2..]
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
        format!(
            "轮转 GSDesk 日志失败 {} -> {}: {error}",
            path.display(),
            rotated.display()
        )
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
            let modified = fs::metadata(&path)
                .and_then(|metadata| metadata.modified())
                .ok()?;
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

fn is_python_logging_error_block_start(line: &str) -> bool {
    line.trim() == "--- Logging error ---"
}

fn is_python_logging_error_block_end(line: &str) -> bool {
    line.trim_start().starts_with("Arguments:")
}

fn is_standalone_python_gbk_encoding_error(line: &str) -> bool {
    let lower = line.to_lowercase();
    lower.contains("unicodeencodeerror")
        && lower.contains("'gbk'")
        && lower.contains("can't encode character")
        && lower.contains("illegal multibyte sequence")
}

fn is_python_gbk_logging_noise(block: &[String]) -> bool {
    if block.is_empty() {
        return false;
    }
    let joined = block.join("\n").to_lowercase();
    is_standalone_python_gbk_encoding_error(&joined)
        && (joined.contains("logging\\__init__.py")
            || joined.contains("logging/__init__.py")
            || joined.contains("colorama\\ansitowin32.py")
            || joined.contains("colorama/ansitowin32.py"))
}

fn classify_level(line: &str) -> &str {
    let lower = line.to_lowercase();
    if lower.contains("[error")
        || lower.contains("traceback")
        || lower.starts_with("file \"")
        || lower.contains("error")
        || lower.contains("失败")
        || lower.contains("exception")
        || lower.contains("panic")
    {
        "error"
    } else if lower.contains("[warn") || lower.contains("warn") || lower.contains("警告") {
        "warn"
    } else if lower.contains("[success")
        || lower.contains("success")
        || lower.contains("完成")
        || lower.contains("已启动")
    {
        "success"
    } else {
        "info"
    }
}

fn should_promote_recent_error(line: &str) -> bool {
    let trimmed = line.trim();
    let lower = trimmed.to_lowercase();
    if is_standalone_python_gbk_encoding_error(trimmed) {
        return false;
    }
    if lower.starts_with("traceback")
        || lower.starts_with("file \"")
        || lower.starts_with("return ")
        || lower.starts_with("asyncio.")
        || lower.starts_with("self.")
        || lower.starts_with("super().")
        || lower.starts_with("handle.")
    {
        return false;
    }

    lower.contains("[error")
        || lower.contains("error")
        || lower.contains("exception")
        || lower.contains("failed")
        || lower.contains("panic")
        || lower.contains("失败")
}

#[derive(Debug, Deserialize)]
struct RawCoreJsonLog {
    event: Value,
    level: Option<String>,
    timestamp: Option<String>,
    module: Option<String>,
    logger: Option<String>,
    name: Option<String>,
    target: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CoreFileLogRecord {
    message: String,
    level: String,
    timestamp: String,
    module: Option<String>,
    raw: Option<String>,
}

impl CoreFileLogRecord {
    fn to_display_line(&self) -> String {
        format!(
            "{} [{:<8}] {}",
            self.timestamp,
            self.level,
            self.message.trim()
        )
    }
}

fn read_core_jsonl_records(
    path: &Path,
    offset: u64,
) -> Result<(Vec<CoreFileLogRecord>, u64), String> {
    let mut file = File::open(path)
        .map_err(|error| format!("打开 Core 日志文件失败 {}: {error}", path.display()))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| format!("定位 Core 日志文件失败 {}: {error}", path.display()))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| format!("读取 Core 日志文件失败 {}: {error}", path.display()))?;
    if bytes.is_empty() {
        return Ok((Vec::new(), offset));
    }

    let complete_len = bytes
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map(|index| index + 1)
        .unwrap_or(0);
    if complete_len == 0 {
        return Ok((Vec::new(), offset));
    }

    let usable_start = if offset > 0 {
        bytes[..complete_len]
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|index| index + 1)
            .unwrap_or(complete_len)
    } else {
        0
    };
    if usable_start >= complete_len {
        return Ok((Vec::new(), offset + complete_len as u64));
    }

    let text = String::from_utf8_lossy(&bytes[usable_start..complete_len]);
    let mut records = Vec::new();
    for line in text.lines() {
        records.extend(parse_core_jsonl_line(line));
    }
    Ok((records, offset + complete_len as u64))
}

fn parse_core_jsonl_line(line: &str) -> Vec<CoreFileLogRecord> {
    let raw_line = line.trim();
    let raw = match serde_json::from_str::<RawCoreJsonLog>(line) {
        Ok(raw) => raw,
        Err(error) => {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                return Vec::new();
            }
            return vec![CoreFileLogRecord {
                message: format!("JSONL parse_error: {error}; raw={trimmed}"),
                level: "warn".to_string(),
                timestamp: Utc::now().format("%m-%d %H:%M:%S").to_string(),
                module: Some("parse_error".to_string()),
                raw: Some(trimmed.to_string()),
            }];
        }
    };
    let event = match raw.event {
        Value::String(value) => value,
        value => value.to_string(),
    };
    let timestamp = raw
        .timestamp
        .unwrap_or_else(|| Utc::now().format("%m-%d %H:%M:%S").to_string());
    let level = normalize_core_json_level(raw.level.as_deref(), &event);
    let explicit_module = raw.module.or(raw.logger).or(raw.name).or(raw.target);

    event
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .lines()
        .map(str::trim_end)
        .filter(|line| !line.trim().is_empty())
        .map(|line| CoreFileLogRecord {
            message: line.to_string(),
            level: level.clone(),
            timestamp: timestamp.clone(),
            module: explicit_module
                .clone()
                .or_else(|| extract_bracket_module(line)),
            raw: Some(raw_line.to_string()),
        })
        .collect()
}

fn extract_bracket_module(line: &str) -> Option<String> {
    let start = line.find('[')?;
    let end = line[start + 1..].find(']')? + start + 1;
    let module = line[start + 1..end].trim();
    if module.is_empty() || module.len() > 48 || module.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    Some(module.to_string())
}

fn normalize_core_json_level(level: Option<&str>, event: &str) -> String {
    match level.map(|value| value.to_lowercase()) {
        Some(value) if value == "success" => "success".to_string(),
        Some(value) if value == "warn" || value == "warning" => "warn".to_string(),
        Some(value) if value == "error" || value == "exception" || value == "critical" => {
            "error".to_string()
        }
        Some(value) if value == "info" => "info".to_string(),
        _ => classify_level(event).to_string(),
    }
}

fn normalize_log_records(text: &str) -> Vec<String> {
    let cleaned = strip_terminal_sequences(text);
    let mut records = Vec::new();
    for fragment in cleaned.split(|ch| ch == '\r' || ch == '\n') {
        let fragment = fragment.trim();
        if fragment.is_empty() {
            continue;
        }
        records.extend(split_structured_log_records(fragment));
    }
    records
}

fn split_structured_log_records(line: &str) -> Vec<String> {
    let bytes = line.as_bytes();
    let starts: Vec<usize> = (0..bytes.len())
        .filter(|index| is_structured_log_prefix_at(bytes, *index))
        .collect();

    if starts.is_empty() {
        return vec![line.to_string()];
    }

    let mut records = Vec::new();
    if starts[0] > 0 {
        let prefix = line[..starts[0]].trim();
        if !prefix.is_empty() {
            records.push(prefix.to_string());
        }
    }

    for (position, start) in starts.iter().enumerate() {
        let end = starts.get(position + 1).copied().unwrap_or(line.len());
        let record = line[*start..end].trim();
        if !record.is_empty() {
            records.push(record.to_string());
        }
    }
    records
}

fn is_structured_log_prefix_at(bytes: &[u8], start: usize) -> bool {
    if bytes.len() < start + 17 {
        return false;
    }

    let fixed = [
        (0, b'd'),
        (1, b'd'),
        (2, b'-'),
        (3, b'd'),
        (4, b'd'),
        (5, b' '),
        (6, b'd'),
        (7, b'd'),
        (8, b':'),
        (9, b'd'),
        (10, b'd'),
        (11, b':'),
        (12, b'd'),
        (13, b'd'),
        (14, b' '),
        (15, b'['),
    ];

    for (offset, expected) in fixed {
        let actual = bytes[start + offset];
        if expected == b'd' {
            if !actual.is_ascii_digit() {
                return false;
            }
        } else if actual != expected {
            return false;
        }
    }

    let mut index = start + 16;
    while index < bytes.len() && index < start + 34 {
        let byte = bytes[index];
        if byte == b']' {
            return index > start + 16;
        }
        if !(byte.is_ascii_alphabetic() || byte == b' ' || byte == b'_' || byte == b'-') {
            return false;
        }
        index += 1;
    }
    false
}

fn strip_terminal_sequences(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;

    while index < bytes.len() {
        match bytes[index] {
            0x1b if index + 1 < bytes.len() && bytes[index + 1] == b'[' => {
                index += 2;
                while index < bytes.len() {
                    let byte = bytes[index];
                    index += 1;
                    if (0x40..=0x7e).contains(&byte) {
                        break;
                    }
                }
            }
            0x1b if index + 1 < bytes.len() && bytes[index + 1] == b']' => {
                index += 2;
                while index < bytes.len() {
                    if bytes[index] == 0x07 {
                        index += 1;
                        break;
                    }
                    if bytes[index] == 0x1b && index + 1 < bytes.len() && bytes[index + 1] == b'\\'
                    {
                        index += 2;
                        break;
                    }
                    index += 1;
                }
            }
            0x08 => {
                output.pop();
                index += 1;
            }
            0x00..=0x08 | 0x0b | 0x0c | 0x0e..=0x1f | 0x7f => {
                index += 1;
            }
            byte => {
                output.push(byte);
                index += 1;
            }
        }
    }

    String::from_utf8_lossy(&output).to_string()
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

fn wait_for_webconsole(
    runtime: &SharedRuntime,
    base_url: &str,
    timeout: Duration,
) -> Result<bool, String> {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if task_cancel_requested(runtime) {
            return Err("任务已取消: 启动 Core".to_string());
        }
        if webconsole_available(base_url) {
            return Ok(true);
        }
        std::thread::sleep(Duration::from_millis(700));
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

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

        let mut settings = Settings {
            preferred_core_port: Some(port),
            ..Settings::default()
        };

        assert_eq!(resolve_start_port(&settings, None).unwrap(), port);
        settings.preferred_core_port = None;
        assert!(resolve_start_port(&settings, None).unwrap() >= 8765);
    }

    #[test]
    fn resolve_start_port_rejects_occupied_fixed_port() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let settings = Settings {
            preferred_core_port: Some(port),
            ..Settings::default()
        };

        let error = resolve_start_port(&settings, None).unwrap_err();
        assert!(error.contains("固定端口"));
        assert!(error.contains("已被占用"));
    }

    #[test]
    fn selected_source_follows_mode() {
        let mut settings = Settings::default();
        settings.source_mode = "cnb".to_string();
        assert!(selected_source(&settings).contains("cnb.cool"));
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
            uv_executable: "tools/uv/uv".into(),
            logs_dir: "l".into(),
            diagnostics_dir: "d".into(),
            backups_dir: "b".into(),
            settings_file: "s".into(),
        };
        let envs = runtime_env(&settings, &paths);
        assert!(envs
            .iter()
            .any(|(key, value)| key == "UV_PROJECT_ENVIRONMENT" && value == "v"));
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
            uv_executable: "tools/uv/uv".into(),
            logs_dir: "l".into(),
            diagnostics_dir: "d".into(),
            backups_dir: "b".into(),
            settings_file: "s".into(),
        };
        let envs = runtime_env(&settings, &paths);

        assert!(envs
            .iter()
            .any(|(key, value)| key == "PYTHONUTF8" && value == "1"));
        assert!(envs
            .iter()
            .any(|(key, value)| key == "PYTHONIOENCODING" && value == PYTHON_IO_ENCODING));
        assert!(!envs
            .iter()
            .any(|(key, _)| key == LEGACY_WINDOWS_STDIO_ENV));
        assert!(envs
            .iter()
            .any(|(key, value)| key == "PYTHONUNBUFFERED" && value == "1"));
        assert!(envs
            .iter()
            .any(|(key, value)| key == "UV_NO_PROGRESS" && value == "1"));
        assert!(envs
            .iter()
            .any(|(key, value)| key == "NO_COLOR" && value == "1"));
        assert!(envs
            .iter()
            .any(|(key, value)| key == "FORCE_COLOR" && value == "0"));
        assert!(envs
            .iter()
            .any(|(key, value)| key == "CLICOLOR" && value == "0"));
        assert!(envs
            .iter()
            .any(|(key, value)| key == "TERM" && value == "dumb"));
    }

    #[test]
    fn stop_commands_try_graceful_before_force() {
        assert_eq!(
            windows_taskkill_args(1234, false),
            vec!["/PID", "1234", "/T"]
        );
        assert_eq!(
            windows_taskkill_args(1234, true),
            vec!["/PID", "1234", "/T", "/F"]
        );
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
        let mut runtime = ServiceRuntime::default();
        runtime.cancel_requested = true;
        runtime.status = ServiceStatus::Initializing;
        let first = start_task(&mut runtime, "初始化运行时", "python", "安装 Python");
        runtime.cancel_requested = true;

        finish_task_for_error(
            &mut runtime,
            first,
            "python",
            "任务已取消: uv python install 3.12",
        );

        let task = runtime.tasks.iter().find(|task| task.id == first).unwrap();
        assert_eq!(task.status, "cancelled");
        assert_eq!(task.stage, "cancelled");
        assert!(!runtime.cancel_requested);
        assert_eq!(runtime.status, ServiceStatus::Stopped);

        let second = start_task(&mut runtime, "启动 Core", "spawn", "正在启动");
        assert!(!runtime.cancel_requested);
        assert_eq!(
            runtime
                .tasks
                .iter()
                .find(|task| task.id == second)
                .unwrap()
                .status,
            "running"
        );
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
        assert_eq!(
            classify_level("Traceback (most recent call last):"),
            "error"
        );
        assert_eq!(
            classify_level("File \"core.py\", line 79, in main"),
            "error"
        );
        assert_eq!(
            classify_level("06-19 10:37:47 [success  ] started"),
            "success"
        );
    }

    #[test]
    fn promotes_only_actionable_recent_errors() {
        assert!(!should_promote_recent_error(
            "File \"core.py\", line 79, in main"
        ));
        assert!(!should_promote_recent_error(
            "Traceback (most recent call last):"
        ));
        assert!(should_promote_recent_error(
            "ModuleNotFoundError: No module named 'gsuid_core'"
        ));
        assert!(should_promote_recent_error(
            "06-19 10:37:45 [error    ] 启动失败"
        ));
    }

    #[test]
    fn parses_core_jsonl_log_lines() {
        let records = parse_core_jsonl_line(
            r#"{"event":"Started server process [36928]\nWaiting for application startup.","level":"info","timestamp":"06-19 10:37:47"}"#,
        );

        assert_eq!(
            records,
            vec![
                CoreFileLogRecord {
                    message: "Started server process [36928]".to_string(),
                    level: "info".to_string(),
                    timestamp: "06-19 10:37:47".to_string(),
                    module: None,
                    raw: Some(
                        r#"{"event":"Started server process [36928]\nWaiting for application startup.","level":"info","timestamp":"06-19 10:37:47"}"#
                            .to_string(),
                    ),
                },
                CoreFileLogRecord {
                    message: "Waiting for application startup.".to_string(),
                    level: "info".to_string(),
                    timestamp: "06-19 10:37:47".to_string(),
                    module: None,
                    raw: Some(
                        r#"{"event":"Started server process [36928]\nWaiting for application startup.","level":"info","timestamp":"06-19 10:37:47"}"#
                            .to_string(),
                    ),
                },
            ]
        );
        assert_eq!(
            records[0].to_display_line(),
            "06-19 10:37:47 [info    ] Started server process [36928]"
        );
    }

    #[test]
    fn keeps_core_jsonl_parse_errors_visible() {
        let records = parse_core_jsonl_line("{bad json");

        assert_eq!(records.len(), 1);
        assert_eq!(records[0].level, "warn");
        assert!(records[0].message.contains("JSONL parse_error"));
        assert!(records[0].message.contains("{bad json"));
        assert_eq!(records[0].module.as_deref(), Some("parse_error"));
    }

    #[test]
    fn reads_core_jsonl_incrementally() {
        let dir = std::env::temp_dir().join(format!(
            "gsdesk-jsonl-test-{}",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("2026-06-19.log");
        fs::write(
            &path,
            "{\"event\":\"first\",\"level\":\"info\",\"timestamp\":\"06-19 10:37:43\"}\n{\"event\":\"second\",\"level\":\"success\",\"timestamp\":\"06-19 10:37:44\"}\n",
        )
        .unwrap();

        let (records, offset) = read_core_jsonl_records(&path, 0).unwrap();
        assert_eq!(records.len(), 2);
        assert_eq!(records[1].level, "success");

        fs::write(
            &path,
            "{\"event\":\"first\",\"level\":\"info\",\"timestamp\":\"06-19 10:37:43\"}\n{\"event\":\"second\",\"level\":\"success\",\"timestamp\":\"06-19 10:37:44\"}\n{\"event\":\"partial\",\"level\":\"info\"",
        )
        .unwrap();
        let (records, next_offset) = read_core_jsonl_records(&path, offset).unwrap();
        assert!(records.is_empty());
        assert_eq!(next_offset, offset);

        let _ = fs::remove_file(path);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn reads_core_jsonl_from_middle_without_partial_line_noise() {
        let dir = std::env::temp_dir().join(format!(
            "gsdesk-jsonl-tail-test-{}",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("2026-06-19.log");
        let content = concat!(
            "{\"event\":\"first long line\",\"level\":\"info\",\"timestamp\":\"06-19 10:37:43\"}\n",
            "{\"event\":\"second\",\"level\":\"success\",\"timestamp\":\"06-19 10:37:44\"}\n"
        );
        fs::write(&path, content).unwrap();

        let offset_inside_first_line = 10;
        let (records, next_offset) =
            read_core_jsonl_records(&path, offset_inside_first_line).unwrap();

        assert_eq!(records.len(), 1);
        assert_eq!(records[0].message, "second");
        assert_eq!(records[0].level, "success");
        assert_eq!(next_offset, content.len() as u64);

        let _ = fs::remove_file(path);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn runtime_backup_redacts_settings_and_excludes_heavy_runtime_dirs() {
        let dir = std::env::temp_dir().join(format!(
            "gsdesk-backup-test-{}",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let runtime = dir.join("runtime");
        let core = runtime.join("core").join("gsuid_core");
        let data = core.join("data");
        let config = core.join("config");
        let venv = runtime.join("venvs").join("gsuid_core");
        let cache = runtime.join("uv").join("cache");
        let backups = runtime.join("backups");
        fs::create_dir_all(&data).unwrap();
        fs::create_dir_all(&config).unwrap();
        fs::create_dir_all(&venv).unwrap();
        fs::create_dir_all(&cache).unwrap();
        fs::write(
            dir.join("settings.json"),
            r#"{"WS_TOKEN":"abc","proxy":"http://user:pass@127.0.0.1:7890"}"#,
        )
        .unwrap();
        fs::write(data.join("config.json"), "{}").unwrap();
        fs::write(config.join("core.json"), "{}").unwrap();
        fs::write(venv.join("pyvenv.cfg"), "venv").unwrap();
        fs::write(cache.join("cache.bin"), "cache").unwrap();

        let paths = crate::models::AppPaths {
            app_data: dir.to_string_lossy().to_string(),
            runtime: runtime.to_string_lossy().to_string(),
            tools_dir: runtime.join("tools").to_string_lossy().to_string(),
            core_dir: core.to_string_lossy().to_string(),
            venv_dir: venv.to_string_lossy().to_string(),
            uv_cache_dir: cache.to_string_lossy().to_string(),
            uv_python_dir: runtime
                .join("uv")
                .join("python")
                .to_string_lossy()
                .to_string(),
            uv_executable: runtime
                .join("tools")
                .join("uv")
                .join(crate::paths::uv_executable_name())
                .to_string_lossy()
                .to_string(),
            logs_dir: dir.join("logs").to_string_lossy().to_string(),
            diagnostics_dir: dir.join("diagnostics").to_string_lossy().to_string(),
            backups_dir: backups.to_string_lossy().to_string(),
            settings_file: dir.join("settings.json").to_string_lossy().to_string(),
        };

        let backup = create_runtime_backup_inner(&paths).unwrap();
        let file = File::open(&backup.path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let names = (0..archive.len())
            .map(|index| archive.by_index(index).unwrap().name().to_string())
            .collect::<Vec<_>>();
        assert!(names.iter().any(|name| name == "settings.redacted.json"));
        assert!(names.iter().any(|name| name == "core-data/config.json"));
        assert!(names.iter().any(|name| name == "core-config/core.json"));
        assert!(!names.iter().any(|name| name.contains("pyvenv.cfg")));
        assert!(!names.iter().any(|name| name.contains("cache.bin")));

        let mut settings = String::new();
        archive
            .by_name("settings.redacted.json")
            .unwrap()
            .read_to_string(&mut settings)
            .unwrap();
        assert!(!settings.contains("abc"));
        assert!(!settings.contains("pass@"));

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn runtime_restore_replaces_allowed_runtime_dirs_and_creates_safety_backup() {
        let dir = std::env::temp_dir().join(format!(
            "gsdesk-restore-test-{}",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let runtime = dir.join("runtime");
        let core = runtime.join("core").join("gsuid_core");
        let data = core.join("data");
        let config = core.join("config");
        let plugins = core.join("plugins");
        let logs = dir.join("logs");
        let backups = runtime.join("backups");
        fs::create_dir_all(&data).unwrap();
        fs::create_dir_all(&config).unwrap();
        fs::create_dir_all(&plugins).unwrap();
        fs::create_dir_all(&logs).unwrap();
        fs::create_dir_all(&backups).unwrap();
        fs::write(data.join("old.json"), "old").unwrap();
        fs::write(config.join("old.json"), "old").unwrap();
        fs::write(plugins.join("old.py"), "old").unwrap();
        fs::write(logs.join("core.log"), "old").unwrap();

        let backup_path = backups.join("gsdesk-runtime-restore.zip");
        {
            let file = File::create(&backup_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let options =
                FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            add_backup_text(&mut zip, options, "core-data/new.json", "new-data").unwrap();
            add_backup_text(&mut zip, options, "core-config/new.json", "new-config").unwrap();
            add_backup_text(&mut zip, options, "core-plugins/new.py", "new-plugin").unwrap();
            add_backup_text(&mut zip, options, "logs/core.log", "new-log").unwrap();
            zip.finish().unwrap();
        }

        let paths = crate::models::AppPaths {
            app_data: dir.to_string_lossy().to_string(),
            runtime: runtime.to_string_lossy().to_string(),
            tools_dir: runtime.join("tools").to_string_lossy().to_string(),
            core_dir: core.to_string_lossy().to_string(),
            venv_dir: runtime
                .join("venvs")
                .join("gsuid_core")
                .to_string_lossy()
                .to_string(),
            uv_cache_dir: runtime
                .join("uv")
                .join("cache")
                .to_string_lossy()
                .to_string(),
            uv_python_dir: runtime
                .join("uv")
                .join("python")
                .to_string_lossy()
                .to_string(),
            uv_executable: runtime
                .join("tools")
                .join("uv")
                .join(crate::paths::uv_executable_name())
                .to_string_lossy()
                .to_string(),
            logs_dir: logs.to_string_lossy().to_string(),
            diagnostics_dir: dir.join("diagnostics").to_string_lossy().to_string(),
            backups_dir: backups.to_string_lossy().to_string(),
            settings_file: dir.join("settings.json").to_string_lossy().to_string(),
        };

        let restored =
            restore_runtime_backup_inner(&paths, Some(backup_path.to_string_lossy().as_ref()))
                .unwrap();

        assert!(restored.safety_backup.is_some());
        assert!(restored.restored.contains(&"core-data".to_string()));
        assert_eq!(
            fs::read_to_string(data.join("new.json")).unwrap(),
            "new-data"
        );
        assert!(!data.join("old.json").exists());
        assert_eq!(
            fs::read_to_string(config.join("new.json")).unwrap(),
            "new-config"
        );
        assert_eq!(
            fs::read_to_string(plugins.join("new.py")).unwrap(),
            "new-plugin"
        );
        assert_eq!(
            fs::read_to_string(logs.join("core.log")).unwrap(),
            "new-log"
        );

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn extracts_module_from_real_core_jsonl_shape_with_emoji_event() {
        let marker = char::from_u32(0x1f5d1).unwrap();
        let event = format!("{marker} [ResourceManager] TTL 已清理");
        let raw = serde_json::json!({
            "event": event,
            "level": "success",
            "timestamp": "06-19 10:37:47"
        })
        .to_string();
        let records = parse_core_jsonl_line(&raw);

        assert_eq!(records.len(), 1);
        assert_eq!(records[0].message, event);
        assert_eq!(records[0].module.as_deref(), Some("ResourceManager"));
        assert_eq!(records[0].level, "success");
    }
}
