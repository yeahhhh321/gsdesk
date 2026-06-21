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

use models::{
    AppStateResponse, ClearAppDataResult, ClearPortRequest, ClearPortResult, CoreUpdateRequest,
    CoreUpdateResult, LogEntry, MirrorCheckResult, NetworkDiagnosticResult, ProcessResourceUsage,
    RepairRuntimeRequest, RuntimeBackupResult, RuntimeRestoreRequest, RuntimeRestoreResult,
    ServiceSnapshot, Settings, SettingsTransferRequest, SettingsTransferResult, SourceProbeResult,
    StartServiceRequest, UpdateInfo, UpdateInstallResult, WebConsoleInfo,
};
use service::SharedRuntime;
use tauri::{AppHandle, Manager, State};

#[tauri::command]
fn get_app_state(
    app: AppHandle,
    runtime: State<SharedRuntime>,
) -> Result<AppStateResponse, String> {
    app_state(&app, &runtime)
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: Settings) -> Result<AppStateResponse, String> {
    let (_, paths) = paths::app_paths(&app)?;
    settings::save_settings_file(&PathBuf::from(paths.settings_file), &settings)?;
    let runtime = app.state::<SharedRuntime>();
    app_state(&app, &runtime)
}

#[tauri::command]
fn configure_proxy(app: AppHandle, settings: Settings) -> Result<AppStateResponse, String> {
    save_settings(app, settings)
}

#[tauri::command]
fn probe_sources(app: AppHandle) -> Result<Vec<SourceProbeResult>, String> {
    let settings = load_settings_for_app(&app)?;
    let (_, paths) = paths::app_paths(&app)?;
    Ok(network::probe_sources(&settings, toolchain::git_program(&app, &paths)))
}

#[tauri::command]
fn check_pypi_mirrors(app: AppHandle) -> Result<Vec<MirrorCheckResult>, String> {
    let settings = load_settings_for_app(&app)?;
    network::check_mirrors(&settings)
}

#[tauri::command]
fn test_network_targets(
    app: AppHandle,
    runtime: State<SharedRuntime>,
) -> Result<Vec<NetworkDiagnosticResult>, String> {
    let settings = load_settings_for_app(&app)?;
    let (_, paths) = paths::app_paths(&app)?;
    service::attach_persisted_core_if_running(&app, &runtime, &paths);
    let webconsole_url = {
        let mut guard = runtime.lock();
        service::snapshot(&mut guard, &paths, service::core_git_metadata(&app, &paths))
            .into_iter()
            .find(|item| item.service_id == service::GSUID_SERVICE_ID)
            .and_then(|item| item.url)
            .map(|url| format!("{}/app", url.trim_end_matches('/')))
    };
    Ok(network::diagnose_targets(&settings, webconsole_url, toolchain::git_program(&app, &paths)))
}

#[tauri::command]
fn init_core_runtime(
    app: AppHandle,
    runtime: State<SharedRuntime>,
) -> Result<AppStateResponse, String> {
    let settings = load_settings_for_app(&app)?;
    service::init_core_runtime(&app, &runtime, &settings)?;
    app_state(&app, &runtime)
}

#[tauri::command]
fn start_service(
    app: AppHandle,
    runtime: State<SharedRuntime>,
    request: Option<StartServiceRequest>,
) -> Result<ServiceSnapshot, String> {
    let settings = load_settings_for_app(&app)?;
    service::start_core(&app, &runtime, &settings, request)
}

#[tauri::command]
fn stop_service(
    app: AppHandle,
    runtime: State<SharedRuntime>,
    service_id: Option<String>,
) -> Result<AppStateResponse, String> {
    service::ensure_gsuid_service(service_id.as_deref())?;
    service::stop_core(&app, &runtime)?;
    app_state(&app, &runtime)
}

#[tauri::command]
fn restart_service(
    app: AppHandle,
    runtime: State<SharedRuntime>,
    service_id: Option<String>,
) -> Result<ServiceSnapshot, String> {
    service::ensure_gsuid_service(service_id.as_deref())?;
    service::stop_core(&app, &runtime)?;
    let settings = load_settings_for_app(&app)?;
    service::start_core(&app, &runtime, &settings, None)
}

#[tauri::command]
fn cancel_current_task(
    app: AppHandle,
    runtime: State<SharedRuntime>,
) -> Result<AppStateResponse, String> {
    service::cancel_current_task(&app, &runtime)?;
    app_state(&app, &runtime)
}

#[tauri::command]
fn repair_runtime(
    app: AppHandle,
    runtime: State<SharedRuntime>,
    request: RepairRuntimeRequest,
) -> Result<AppStateResponse, String> {
    let settings = load_settings_for_app(&app)?;
    service::repair_runtime(&app, &runtime, &settings, request)?;
    app_state(&app, &runtime)
}

#[tauri::command]
fn clear_occupied_port(
    app: AppHandle,
    runtime: State<SharedRuntime>,
    request: Option<ClearPortRequest>,
) -> Result<ClearPortResult, String> {
    let settings = load_settings_for_app(&app)?;
    let port =
        request.and_then(|request| request.port).or(settings.preferred_core_port).unwrap_or(8765);
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
            service::push_system_log(&app, &runtime, "info", &result.message);
        }
        Err(error) => {
            service::finish_runtime_task(&runtime, task_id, "failed", "error", error);
            service::push_system_log(&app, &runtime, "error", error);
        }
    }
    result
}

#[tauri::command]
fn clear_app_data(
    app: AppHandle,
    runtime: State<SharedRuntime>,
) -> Result<ClearAppDataResult, String> {
    let (_, paths) = paths::app_paths(&app)?;
    service::stop_core(&app, &runtime)?;
    let result = data_cleanup::clear_app_data(&paths)?;
    service::reset_runtime_after_data_clear(&runtime);
    Ok(result)
}

#[tauri::command]
fn core_update(
    app: AppHandle,
    runtime: State<SharedRuntime>,
    request: CoreUpdateRequest,
) -> Result<CoreUpdateResult, String> {
    let settings = load_settings_for_app(&app)?;
    service::core_update(&app, &runtime, &settings, request)
}

#[tauri::command]
fn create_runtime_backup(
    app: AppHandle,
    runtime: State<SharedRuntime>,
) -> Result<RuntimeBackupResult, String> {
    service::create_runtime_backup(&app, &runtime)
}

#[tauri::command]
fn restore_runtime_backup(
    app: AppHandle,
    runtime: State<SharedRuntime>,
    request: Option<RuntimeRestoreRequest>,
) -> Result<RuntimeRestoreResult, String> {
    service::restore_runtime_backup(
        &app,
        &runtime,
        request.unwrap_or(RuntimeRestoreRequest { path: None }),
    )
}

#[tauri::command]
fn export_settings(app: AppHandle) -> Result<SettingsTransferResult, String> {
    let (_, paths) = paths::app_paths(&app)?;
    let settings = settings::load_settings(&PathBuf::from(&paths.settings_file));
    settings::export_portable_settings(&PathBuf::from(paths.backups_dir), &settings)
}

#[tauri::command]
fn import_settings(
    app: AppHandle,
    request: Option<SettingsTransferRequest>,
) -> Result<AppStateResponse, String> {
    let (_, paths) = paths::app_paths(&app)?;
    let current = settings::load_settings(&PathBuf::from(&paths.settings_file));
    let request_path =
        request.as_ref().and_then(|request| request.path.as_ref()).map(PathBuf::from);
    let (settings, _) = settings::import_portable_settings(
        &PathBuf::from(&paths.backups_dir),
        &current,
        request_path.as_deref(),
    )?;
    settings::save_settings_file(&PathBuf::from(paths.settings_file), &settings)?;
    let runtime = app.state::<SharedRuntime>();
    app_state(&app, &runtime)
}

#[tauri::command]
fn bootstrap_uv(app: AppHandle, runtime: State<SharedRuntime>) -> Result<AppStateResponse, String> {
    let settings = load_settings_for_app(&app)?;
    let (_, paths) = paths::app_paths(&app)?;
    let task_id = service::start_runtime_task(
        &runtime,
        "安装 uv",
        "prepare",
        "准备使用内置 Python 创建或更新 uv",
    );
    service::push_system_log(&app, &runtime, "info", "开始使用内置 Python 创建或更新 uv");
    let result = toolchain::bootstrap_uv(&app, &paths, &settings, |stage, message| {
        service::update_runtime_task(&runtime, task_id, stage, message);
        service::push_system_log(&app, &runtime, "info", message);
    });
    match result {
        Ok(info) => {
            if service::take_cancel_requested(&runtime) {
                let message = "任务已取消: 安装 uv".to_string();
                service::finish_runtime_task(&runtime, task_id, "cancelled", "cancelled", &message);
                service::push_system_log(&app, &runtime, "warn", &message);
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
                &app,
                &runtime,
                "info",
                &format!(
                    "uv 已可用: {}",
                    info.uv_version.unwrap_or_else(|| "版本未知".to_string())
                ),
            );
            app_state(&app, &runtime)
        }
        Err(error) => {
            let status =
                if service::is_task_cancelled_error(&error) { "cancelled" } else { "failed" };
            let stage = if status == "cancelled" { "cancelled" } else { "error" };
            let level = if status == "cancelled" { "warn" } else { "error" };
            service::finish_runtime_task(&runtime, task_id, status, stage, &error);
            service::push_system_log(&app, &runtime, level, &error);
            Err(error)
        }
    }
}

#[tauri::command]
fn check_service_health(
    app: AppHandle,
    runtime: State<SharedRuntime>,
) -> Result<AppStateResponse, String> {
    app_state_with_options(
        &app,
        &runtime,
        AppStateOptions { sync_logs: false, include_logs: false },
    )
}

#[tauri::command]
fn open_webconsole(
    app: AppHandle,
    runtime: State<SharedRuntime>,
    service_id: Option<String>,
) -> Result<WebConsoleInfo, String> {
    service::ensure_gsuid_service(service_id.as_deref())?;
    let (_, paths) = paths::app_paths(&app)?;
    service::attach_persisted_core_if_running(&app, &runtime, &paths);
    let mut guard = runtime.lock();
    let snapshot = service::snapshot(&mut guard, &paths, service::core_git_metadata(&app, &paths))
        .into_iter()
        .find(|item| item.service_id == service::GSUID_SERVICE_ID)
        .ok_or_else(|| "无法读取 Core 状态".to_string())?;
    let url = snapshot
        .url
        .map(|url| format!("{}/app", url.trim_end_matches('/')))
        .ok_or_else(|| "Core 尚未启动，无法打开 WebConsole".to_string())?;
    Ok(WebConsoleInfo { url })
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("外部打开失败: URL 为空".to_string());
    }
    if !is_local_webconsole_url(trimmed) {
        return Err(format!("外部打开失败: 只允许打开本机 WebConsole 地址: {trimmed}"));
    }
    tauri_plugin_opener::open_url(trimmed, None::<&str>)
        .map_err(|error| format!("外部打开失败: {error}"))
}

#[tauri::command]
fn stream_logs(app: AppHandle, runtime: State<SharedRuntime>) -> Result<Vec<LogEntry>, String> {
    service::sync_core_file_logs(&app, &runtime)?;
    let guard = runtime.lock();
    Ok(service::recent_core_logs(&guard))
}

#[tauri::command]
fn export_diagnostics(app: AppHandle, runtime: State<SharedRuntime>) -> Result<String, String> {
    let settings = load_settings_for_app(&app)?;
    let state = app_state(&app, &runtime)?;
    diagnostics::export(&app, &state, &settings)
}

#[tauri::command]
async fn check_shell_update(app: AppHandle) -> Result<UpdateInfo, String> {
    Ok(update::check_shell_update(&app).await)
}

#[tauri::command]
async fn install_shell_update(app: AppHandle) -> Result<UpdateInstallResult, String> {
    update::install_shell_update(app).await
}

#[tauri::command]
fn open_path(app: AppHandle, key: String) -> Result<(), String> {
    let (_, paths) = paths::app_paths(&app)?;
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
