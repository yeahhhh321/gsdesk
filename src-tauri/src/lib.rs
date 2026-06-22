mod core_logs;
mod data_cleanup;
mod diagnostics;
mod failure_rules;
mod models;
mod network;
mod paths;
mod ports;
mod preflight;
mod process;
mod runtime_backup;
mod service;
mod service_logs;
mod settings;
mod toolchain;
mod tray;
mod update;

use std::path::PathBuf;
use std::process::Command;

use chrono::Utc;
use models::{
    ActionResultEvent, AppStateChangedEvent, AppStateResponse, ClearAppDataResult,
    ClearPortRequest, ClearPortResult, CoreUpdateRequest, CoreUpdateResult, LogEntry,
    MirrorCheckResult, NetworkDiagnosticResult, ProcessResourceUsage, RepairRuntimeRequest,
    RuntimeBackupResult, RuntimeRestoreRequest, RuntimeRestoreResult, ServiceSnapshot, Settings,
    SettingsTransferRequest, SettingsTransferResult, SourceProbeResult, StartServiceRequest,
    UpdateInfo, UpdateInstallResult, WebConsoleInfo,
};
use serde::Serialize;
use service::SharedRuntime;
use tauri::{AppHandle, Emitter, Manager, State};

async fn run_blocking<T, F>(work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| format!("后台任务执行失败: {error}"))?
}

async fn run_action<T, F>(app: AppHandle, action: &'static str, work: F) -> Result<T, String>
where
    T: Serialize + Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    let result = run_blocking(work).await;
    emit_action_result(&app, action, &result);
    emit_state_changed(&app, action);
    result
}

fn emit_action_result<T: Serialize>(app: &AppHandle, action: &str, result: &Result<T, String>) {
    let (ok, payload, error) = match result {
        Ok(value) => (true, serde_json::to_value(value).ok(), None),
        Err(message) => (false, None, Some(message.clone())),
    };
    let event = ActionResultEvent {
        action: action.to_string(),
        ok,
        result: payload,
        error,
        emitted_at: Utc::now().to_rfc3339(),
    };
    let _ = app.emit("gsdesk-action-result", event);
}

fn emit_state_changed(app: &AppHandle, reason: &str) {
    let event =
        AppStateChangedEvent { reason: reason.to_string(), emitted_at: Utc::now().to_rfc3339() };
    let _ = app.emit("gsdesk-state-changed", event);
}

#[tauri::command]
async fn get_app_state(
    app: AppHandle,
    runtime: State<'_, SharedRuntime>,
) -> Result<AppStateResponse, String> {
    let runtime = runtime.inner().clone();
    run_blocking(move || app_state(&app, &runtime)).await
}

#[tauri::command]
async fn save_settings(app: AppHandle, settings: Settings) -> Result<AppStateResponse, String> {
    let action_app = app.clone();
    run_action(app, "save_settings", move || {
        let (_, paths) = paths::app_paths(&action_app)?;
        settings::save_settings_file(&PathBuf::from(paths.settings_file), &settings)?;
        let runtime = action_app.state::<SharedRuntime>().inner().clone();
        app_state(&action_app, &runtime)
    })
    .await
}

#[tauri::command]
async fn configure_proxy(app: AppHandle, settings: Settings) -> Result<AppStateResponse, String> {
    let action_app = app.clone();
    run_action(app, "configure_proxy", move || {
        let (_, paths) = paths::app_paths(&action_app)?;
        settings::save_settings_file(&PathBuf::from(paths.settings_file), &settings)?;
        let runtime = action_app.state::<SharedRuntime>().inner().clone();
        app_state(&action_app, &runtime)
    })
    .await
}

#[tauri::command]
async fn probe_sources(app: AppHandle) -> Result<Vec<SourceProbeResult>, String> {
    let action_app = app.clone();
    run_action(app, "probe_sources", move || {
        let settings = load_settings_for_app(&action_app)?;
        let (_, paths) = paths::app_paths(&action_app)?;
        Ok(network::probe_sources(&settings, toolchain::git_program(&action_app, &paths)))
    })
    .await
}

#[tauri::command]
async fn check_pypi_mirrors(app: AppHandle) -> Result<Vec<MirrorCheckResult>, String> {
    let action_app = app.clone();
    run_action(app, "check_pypi_mirrors", move || {
        let settings = load_settings_for_app(&action_app)?;
        network::check_mirrors(&settings)
    })
    .await
}

#[tauri::command]
async fn test_network_targets(
    app: AppHandle,
    runtime: State<'_, SharedRuntime>,
) -> Result<Vec<NetworkDiagnosticResult>, String> {
    let runtime = runtime.inner().clone();
    let action_app = app.clone();
    run_action(app, "test_network_targets", move || {
        let settings = load_settings_for_app(&action_app)?;
        let (_, paths) = paths::app_paths(&action_app)?;
        service::attach_persisted_core_if_running(&action_app, &runtime, &paths);
        let webconsole_url = {
            let mut guard = runtime.lock();
            service::snapshot(&mut guard, &paths, service::core_git_metadata(&action_app, &paths))
                .into_iter()
                .find(|item| item.service_id == service::GSUID_SERVICE_ID)
                .and_then(|item| item.url)
                .map(|url| format!("{}/app", url.trim_end_matches('/')))
        };
        Ok(network::diagnose_targets(
            &settings,
            webconsole_url,
            toolchain::git_program(&action_app, &paths),
        ))
    })
    .await
}

#[tauri::command]
async fn init_core_runtime(
    app: AppHandle,
    runtime: State<'_, SharedRuntime>,
) -> Result<AppStateResponse, String> {
    let runtime = runtime.inner().clone();
    let action_app = app.clone();
    run_action(app, "init_core_runtime", move || {
        let settings = load_settings_for_app(&action_app)?;
        service::init_core_runtime(&action_app, &runtime, &settings)?;
        app_state(&action_app, &runtime)
    })
    .await
}

#[tauri::command]
async fn start_service(
    app: AppHandle,
    runtime: State<'_, SharedRuntime>,
    request: Option<StartServiceRequest>,
) -> Result<ServiceSnapshot, String> {
    let runtime = runtime.inner().clone();
    let action_app = app.clone();
    run_action(app, "start_service", move || {
        let settings = load_settings_for_app(&action_app)?;
        service::start_core(&action_app, &runtime, &settings, request)
    })
    .await
}

#[tauri::command]
async fn stop_service(
    app: AppHandle,
    runtime: State<'_, SharedRuntime>,
    service_id: Option<String>,
) -> Result<AppStateResponse, String> {
    let runtime = runtime.inner().clone();
    let action_app = app.clone();
    run_action(app, "stop_service", move || {
        service::ensure_gsuid_service(service_id.as_deref())?;
        service::stop_core(&action_app, &runtime)?;
        app_state(&action_app, &runtime)
    })
    .await
}

#[tauri::command]
async fn restart_service(
    app: AppHandle,
    runtime: State<'_, SharedRuntime>,
    service_id: Option<String>,
) -> Result<ServiceSnapshot, String> {
    let runtime = runtime.inner().clone();
    let action_app = app.clone();
    run_action(app, "restart_service", move || {
        service::ensure_gsuid_service(service_id.as_deref())?;
        service::stop_core(&action_app, &runtime)?;
        let settings = load_settings_for_app(&action_app)?;
        service::start_core(&action_app, &runtime, &settings, None)
    })
    .await
}

#[tauri::command]
async fn cancel_current_task(
    app: AppHandle,
    runtime: State<'_, SharedRuntime>,
) -> Result<AppStateResponse, String> {
    let runtime = runtime.inner().clone();
    let action_app = app.clone();
    run_action(app, "cancel_current_task", move || {
        service::cancel_current_task(&action_app, &runtime)?;
        app_state(&action_app, &runtime)
    })
    .await
}

#[tauri::command]
async fn repair_runtime(
    app: AppHandle,
    runtime: State<'_, SharedRuntime>,
    request: RepairRuntimeRequest,
) -> Result<AppStateResponse, String> {
    let runtime = runtime.inner().clone();
    let action_app = app.clone();
    run_action(app, "repair_runtime", move || {
        let settings = load_settings_for_app(&action_app)?;
        service::repair_runtime(&action_app, &runtime, &settings, request)?;
        app_state(&action_app, &runtime)
    })
    .await
}

#[tauri::command]
async fn clear_occupied_port(
    app: AppHandle,
    runtime: State<'_, SharedRuntime>,
    request: Option<ClearPortRequest>,
) -> Result<ClearPortResult, String> {
    let runtime = runtime.inner().clone();
    let action_app = app.clone();
    run_action(app, "clear_occupied_port", move || {
        let settings = load_settings_for_app(&action_app)?;
        let port = request
            .and_then(|request| request.port)
            .or(settings.preferred_core_port)
            .unwrap_or(8765);
        let task_id = service::start_runtime_task(
            &runtime,
            "清理端口占用",
            "detect",
            &format!("检查并强杀占用端口 {port} 的进程"),
        );
        let result = ports::clear_occupied_port(port);
        match &result {
            Ok(result) => {
                service::finish_runtime_task(&runtime, task_id, "success", "done", &result.message);
                service::push_system_log(&action_app, &runtime, "info", &result.message);
            }
            Err(error) => {
                service::finish_runtime_task(&runtime, task_id, "failed", "error", error);
                service::push_system_log(&action_app, &runtime, "error", error);
            }
        }
        result
    })
    .await
}

#[tauri::command]
async fn clear_app_data(
    app: AppHandle,
    runtime: State<'_, SharedRuntime>,
) -> Result<ClearAppDataResult, String> {
    let runtime = runtime.inner().clone();
    let action_app = app.clone();
    run_action(app, "clear_app_data", move || {
        let (_, paths) = paths::app_paths(&action_app)?;
        service::stop_core(&action_app, &runtime)?;
        let result = data_cleanup::clear_app_data(&paths)?;
        service::reset_runtime_after_data_clear(&runtime);
        Ok(result)
    })
    .await
}

#[tauri::command]
async fn core_update(
    app: AppHandle,
    runtime: State<'_, SharedRuntime>,
    request: CoreUpdateRequest,
) -> Result<CoreUpdateResult, String> {
    let runtime = runtime.inner().clone();
    let action_app = app.clone();
    run_action(app, "core_update", move || {
        let settings = load_settings_for_app(&action_app)?;
        service::core_update(&action_app, &runtime, &settings, request)
    })
    .await
}

#[tauri::command]
async fn create_runtime_backup(
    app: AppHandle,
    runtime: State<'_, SharedRuntime>,
) -> Result<RuntimeBackupResult, String> {
    let runtime = runtime.inner().clone();
    let action_app = app.clone();
    run_action(app, "create_runtime_backup", move || {
        service::create_runtime_backup(&action_app, &runtime)
    })
    .await
}

#[tauri::command]
async fn restore_runtime_backup(
    app: AppHandle,
    runtime: State<'_, SharedRuntime>,
    request: Option<RuntimeRestoreRequest>,
) -> Result<RuntimeRestoreResult, String> {
    let runtime = runtime.inner().clone();
    let action_app = app.clone();
    run_action(app, "restore_runtime_backup", move || {
        service::restore_runtime_backup(
            &action_app,
            &runtime,
            request.unwrap_or(RuntimeRestoreRequest { path: None }),
        )
    })
    .await
}

#[tauri::command]
async fn export_settings(app: AppHandle) -> Result<SettingsTransferResult, String> {
    let action_app = app.clone();
    run_action(app, "export_settings", move || {
        let (_, paths) = paths::app_paths(&action_app)?;
        let settings = settings::load_settings(&PathBuf::from(&paths.settings_file));
        settings::export_portable_settings(&PathBuf::from(paths.backups_dir), &settings)
    })
    .await
}

#[tauri::command]
async fn import_settings(
    app: AppHandle,
    request: Option<SettingsTransferRequest>,
) -> Result<AppStateResponse, String> {
    let action_app = app.clone();
    run_action(app, "import_settings", move || {
        let (_, paths) = paths::app_paths(&action_app)?;
        let current = settings::load_settings(&PathBuf::from(&paths.settings_file));
        let request_path =
            request.as_ref().and_then(|request| request.path.as_ref()).map(PathBuf::from);
        let (settings, _) = settings::import_portable_settings(
            &PathBuf::from(&paths.backups_dir),
            &current,
            request_path.as_deref(),
        )?;
        settings::save_settings_file(&PathBuf::from(paths.settings_file), &settings)?;
        let runtime = action_app.state::<SharedRuntime>().inner().clone();
        app_state(&action_app, &runtime)
    })
    .await
}

#[tauri::command]
async fn bootstrap_uv(
    app: AppHandle,
    runtime: State<'_, SharedRuntime>,
) -> Result<AppStateResponse, String> {
    let runtime = runtime.inner().clone();
    let action_app = app.clone();
    run_action(app, "bootstrap_uv", move || {
        let settings = load_settings_for_app(&action_app)?;
        let (_, paths) = paths::app_paths(&action_app)?;
        let task_id = service::start_runtime_task(
            &runtime,
            "安装 uv",
            "prepare",
            "准备使用内置 Python 创建或更新 uv",
        );
        service::push_system_log(
            &action_app,
            &runtime,
            "info",
            "开始使用内置 Python 创建或更新 uv",
        );
        let result = toolchain::bootstrap_uv(&action_app, &paths, &settings, |stage, message| {
            service::update_runtime_task(&runtime, task_id, stage, message);
            service::push_system_log(&action_app, &runtime, "info", message);
        });
        match result {
            Ok(info) => {
                if service::take_cancel_requested(&runtime) {
                    let message = "任务已取消: 安装 uv".to_string();
                    service::finish_runtime_task(
                        &runtime,
                        task_id,
                        "cancelled",
                        "cancelled",
                        &message,
                    );
                    service::push_system_log(&action_app, &runtime, "warn", &message);
                    return Err(message);
                }
                service::finish_runtime_task(
                    &runtime,
                    task_id,
                    "success",
                    "done",
                    "uv 已通过内置 Python 更新并验证可用",
                );
                service::push_system_log(
                    &action_app,
                    &runtime,
                    "info",
                    &format!(
                        "uv 已可用: {}",
                        info.uv_version.unwrap_or_else(|| "版本未知".to_string())
                    ),
                );
                app_state(&action_app, &runtime)
            }
            Err(error) => {
                let status =
                    if service::is_task_cancelled_error(&error) { "cancelled" } else { "failed" };
                let stage = if status == "cancelled" { "cancelled" } else { "error" };
                let level = if status == "cancelled" { "warn" } else { "error" };
                service::finish_runtime_task(&runtime, task_id, status, stage, &error);
                service::push_system_log(&action_app, &runtime, level, &error);
                Err(error)
            }
        }
    })
    .await
}

#[tauri::command]
async fn check_service_health(
    app: AppHandle,
    runtime: State<'_, SharedRuntime>,
) -> Result<AppStateResponse, String> {
    let runtime = runtime.inner().clone();
    run_blocking(move || {
        app_state_with_options(
            &app,
            &runtime,
            AppStateOptions { sync_logs: false, include_logs: false },
        )
    })
    .await
}

#[tauri::command]
async fn open_webconsole(
    app: AppHandle,
    runtime: State<'_, SharedRuntime>,
    service_id: Option<String>,
) -> Result<WebConsoleInfo, String> {
    let runtime = runtime.inner().clone();
    let action_app = app.clone();
    run_action(app, "open_webconsole", move || {
        service::ensure_gsuid_service(service_id.as_deref())?;
        let (_, paths) = paths::app_paths(&action_app)?;
        service::attach_persisted_core_if_running(&action_app, &runtime, &paths);
        let mut guard = runtime.lock();
        let snapshot =
            service::snapshot(&mut guard, &paths, service::core_git_metadata(&action_app, &paths))
                .into_iter()
                .find(|item| item.service_id == service::GSUID_SERVICE_ID)
                .ok_or_else(|| "无法读取 Core 状态".to_string())?;
        let url = snapshot
            .url
            .map(|url| format!("{}/app", url.trim_end_matches('/')))
            .ok_or_else(|| "Core 尚未启动，无法打开 WebConsole".to_string())?;
        Ok(WebConsoleInfo { url })
    })
    .await
}

#[tauri::command]
async fn open_external_url(app: AppHandle, url: String) -> Result<(), String> {
    run_action(app, "open_external_url", move || {
        let trimmed = url.trim();
        if trimmed.is_empty() {
            return Err("外部打开失败: URL 为空".to_string());
        }
        if !is_local_webconsole_url(trimmed) {
            return Err(format!("外部打开失败: 只允许打开本机 WebConsole 地址: {trimmed}"));
        }
        tauri_plugin_opener::open_url(trimmed, None::<&str>)
            .map_err(|error| format!("外部打开失败: {error}"))
    })
    .await
}

#[tauri::command]
async fn stream_logs(
    app: AppHandle,
    runtime: State<'_, SharedRuntime>,
) -> Result<Vec<LogEntry>, String> {
    let runtime = runtime.inner().clone();
    run_blocking(move || {
        service::sync_core_file_logs(&app, &runtime)?;
        let guard = runtime.lock();
        Ok(service::recent_core_logs(&guard))
    })
    .await
}

#[tauri::command]
async fn export_diagnostics(
    app: AppHandle,
    runtime: State<'_, SharedRuntime>,
) -> Result<String, String> {
    let runtime = runtime.inner().clone();
    let action_app = app.clone();
    run_action(app, "export_diagnostics", move || {
        let settings = load_settings_for_app(&action_app)?;
        let state = app_state(&action_app, &runtime)?;
        diagnostics::export(&action_app, &state, &settings)
    })
    .await
}

#[tauri::command]
async fn check_shell_update(app: AppHandle) -> Result<UpdateInfo, String> {
    let result = Ok(update::check_shell_update(&app).await);
    emit_action_result(&app, "check_shell_update", &result);
    emit_state_changed(&app, "check_shell_update");
    result
}

#[tauri::command]
async fn install_shell_update(app: AppHandle) -> Result<UpdateInstallResult, String> {
    let result = update::install_shell_update(app.clone()).await;
    emit_action_result(&app, "install_shell_update", &result);
    emit_state_changed(&app, "install_shell_update");
    result
}

#[tauri::command]
async fn open_path(app: AppHandle, key: String) -> Result<(), String> {
    let action_app = app.clone();
    run_action(app, "open_path", move || {
        let (_, paths) = paths::app_paths(&action_app)?;
        let target = match key.as_str() {
            "appData" => PathBuf::from(paths.app_data),
            "runtime" => PathBuf::from(paths.runtime),
            "toolsDir" => PathBuf::from(paths.tools_dir),
            "coreDir" => PathBuf::from(paths.core_dir),
            "venvDir" => PathBuf::from(paths.venv_dir),
            "uvCacheDir" => PathBuf::from(paths.uv_cache_dir),
            "uvPythonDir" => PathBuf::from(paths.uv_python_dir),
            "uvExecutable" => PathBuf::from(paths.uv_executable)
                .parent()
                .map(PathBuf::from)
                .ok_or_else(|| "uvExecutable 缺少父目录".to_string())?,
            "logsDir" => PathBuf::from(paths.logs_dir),
            "diagnosticsDir" => PathBuf::from(paths.diagnostics_dir),
            "backupsDir" => PathBuf::from(paths.backups_dir),
            "settingsFile" => PathBuf::from(paths.settings_file)
                .parent()
                .map(PathBuf::from)
                .ok_or_else(|| "settingsFile 缺少父目录".to_string())?,
            _ => return Err(format!("不允许打开未知路径键: {key}")),
        };
        std::fs::create_dir_all(&target).ok();
        if cfg!(windows) {
            Command::new("explorer")
                .arg(&target)
                .spawn()
                .map_err(|error| format!("打开目录失败: {error}"))?;
        } else {
            Command::new("open")
                .arg(&target)
                .spawn()
                .map_err(|error| format!("打开目录失败: {error}"))?;
        }
        Ok(())
    })
    .await
}

fn load_settings_for_app(app: &AppHandle) -> Result<Settings, String> {
    let (_, paths) = paths::app_paths(app)?;
    Ok(settings::load_settings(&PathBuf::from(paths.settings_file)))
}

fn is_local_webconsole_url(url: &str) -> bool {
    url.starts_with("http://127.0.0.1:")
        || url.starts_with("http://localhost:")
        || url.starts_with("http://[::1]:")
}

fn app_state(app: &AppHandle, runtime: &SharedRuntime) -> Result<AppStateResponse, String> {
    app_state_with_options(app, runtime, AppStateOptions { sync_logs: true, include_logs: true })
}

#[derive(Debug, Clone, Copy)]
struct AppStateOptions {
    sync_logs: bool,
    include_logs: bool,
}

fn app_state_with_options(
    app: &AppHandle,
    runtime: &SharedRuntime,
    options: AppStateOptions,
) -> Result<AppStateResponse, String> {
    let (_, paths) = paths::app_paths(app)?;
    let settings = settings::load_settings(&PathBuf::from(&paths.settings_file));
    service::sanitize_persisted_core_log_once(app, runtime);
    service::attach_persisted_core_if_running(app, runtime, &paths);
    if options.sync_logs {
        service::sync_core_file_logs(app, runtime)?;
    }
    let mut guard = runtime.lock();
    let core_git = service::core_git_metadata(app, &paths);
    let services = service::snapshot(&mut guard, &paths, core_git);
    let recent_logs =
        if options.include_logs { service::recent_core_logs(&guard) } else { Vec::new() };
    let task_history = service::task_history(&guard);
    drop(guard);
    service::ensure_webconsole_probe(app, runtime, &paths);
    let toolchain = toolchain::uv_status(app, &paths);
    let preflight_checks = preflight::run(&settings, &paths, &toolchain, &services);
    let uv_detected = toolchain.uv_detected;
    let shell_pid = std::process::id();
    let shell = ProcessResourceUsage {
        pid: shell_pid,
        memory_bytes: process::process_memory_bytes(shell_pid),
    };
    Ok(AppStateResponse {
        version: env!("CARGO_PKG_VERSION").to_string(),
        settings,
        paths,
        shell,
        services,
        recent_logs,
        preflight_checks,
        task_history,
        toolchain,
        uv_detected,
    })
}

pub fn run() {
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(SharedRuntime::default())
        .manage(tray::TrayState::default())
        .setup(|app| {
            let handle = app.handle().clone();
            let runtime = handle.state::<SharedRuntime>();
            if let Ok((_, paths)) = paths::app_paths(&handle) {
                service::attach_persisted_core_if_running(&handle, &runtime, &paths);
            }
            tray::setup_tray(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            let tauri::WindowEvent::CloseRequested { api, .. } = event else {
                return;
            };
            let app = window.app_handle().clone();
            if !tray::is_quitting(&app) {
                if !tray::should_hide_to_tray_on_close(&app) {
                    api.prevent_close();
                    tray::quit_app(&app);
                    return;
                }
                api.prevent_close();
                let _ = window.hide();
                tray::hide_window_to_tray(&app);
                return;
            }
            tray::cleanup_core_for_exit(&app);
        })
        .invoke_handler(tauri::generate_handler![
            get_app_state,
            save_settings,
            probe_sources,
            check_pypi_mirrors,
            test_network_targets,
            configure_proxy,
            init_core_runtime,
            start_service,
            stop_service,
            restart_service,
            cancel_current_task,
            repair_runtime,
            clear_occupied_port,
            clear_app_data,
            core_update,
            create_runtime_backup,
            restore_runtime_backup,
            export_settings,
            import_settings,
            bootstrap_uv,
            check_service_health,
            open_webconsole,
            open_external_url,
            stream_logs,
            export_diagnostics,
            check_shell_update,
            install_shell_update,
            open_path
        ])
        .run(tauri::generate_context!());

    if let Err(error) = result {
        eprintln!("GSDesk 启动失败: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::is_local_webconsole_url;

    #[test]
    fn external_open_allows_only_local_webconsole_hosts() {
        assert!(is_local_webconsole_url("http://127.0.0.1:8765/app"));
        assert!(is_local_webconsole_url("http://localhost:8765/app"));
        assert!(is_local_webconsole_url("http://[::1]:8765/app"));
        assert!(!is_local_webconsole_url("https://github.com/yeahhhh321/gsdesk"));
        assert!(!is_local_webconsole_url("http://example.com:8765/app"));
    }
}
