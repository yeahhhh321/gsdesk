use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;

use tauri::menu::MenuBuilder;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

use crate::models::ServiceStatus;
use crate::paths;
use crate::service::{self, SharedRuntime};
use crate::settings;

const TRAY_ID: &str = "gsdesk-main-tray";
const MENU_SHOW: &str = "tray-show-main";
const MENU_START_CORE: &str = "tray-start-core";
const MENU_STOP_CORE: &str = "tray-stop-core";
const MENU_RESTART_CORE: &str = "tray-restart-core";
const MENU_OPEN_WEBCONSOLE: &str = "tray-open-webconsole";
const MENU_OPEN_LOGS: &str = "tray-open-logs";
const MENU_QUIT: &str = "tray-quit";

#[derive(Default)]
pub struct TrayState {
    quitting: AtomicBool,
}

impl TrayState {
    pub fn begin_quit(&self) {
        self.quitting.store(true, Ordering::SeqCst);
    }

    pub fn is_quitting(&self) -> bool {
        self.quitting.load(Ordering::SeqCst)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TrayAction {
    ShowMain,
    StartCore,
    StopCore,
    RestartCore,
    OpenWebConsole,
    OpenLogs,
    Quit,
}

pub fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let handle = app.handle().clone();
    let menu = MenuBuilder::new(app)
        .text(MENU_SHOW, "显示 GSDesk")
        .separator()
        .text(MENU_START_CORE, "启动 Core")
        .text(MENU_STOP_CORE, "停止 Core")
        .text(MENU_RESTART_CORE, "重启 Core")
        .text(MENU_OPEN_WEBCONSOLE, "打开 WebConsole")
        .text(MENU_OPEN_LOGS, "打开日志目录")
        .separator()
        .text(MENU_QUIT, "退出 GSDesk")
        .build()?;

    let icon = app.default_window_icon().cloned();
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip(tray_tooltip_text(&handle))
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            if let Some(action) = tray_action(event.id().as_ref()) {
                handle_tray_action(app, action);
            }
        })
        .on_tray_icon_event(|tray, event| {
            if should_show_from_tray_event(&event) {
                show_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = icon {
        builder = builder.icon(icon);
    }

    builder.build(app)?;
    Ok(())
}

pub fn is_quitting(app: &AppHandle) -> bool {
    app.try_state::<TrayState>()
        .map(|state| state.is_quitting())
        .unwrap_or(false)
}

pub fn hide_window_to_tray(app: &AppHandle) {
    update_tray_tooltip(app);
    let runtime = app.state::<SharedRuntime>();
    service::push_system_log(
        app,
        &runtime,
        "info",
        "窗口已隐藏到系统托盘，Core 状态保持不变",
    );
}

pub fn cleanup_core_for_exit(app: &AppHandle) {
    let Ok(settings) = load_settings(app) else {
        return;
    };
    if !settings.close_core_on_exit {
        return;
    }
    let runtime = app.state::<SharedRuntime>();
    let _ = service::stop_core(app, &runtime);
}

fn handle_tray_action(app: &AppHandle, action: TrayAction) {
    match action {
        TrayAction::ShowMain => show_main_window(app),
        TrayAction::StartCore => spawn_service_action(app, "托盘请求启动 Core", |app| {
            let settings = load_settings(&app)?;
            let runtime = app.state::<SharedRuntime>();
            service::start_core(&app, &runtime, &settings, None).map(|_| ())
        }),
        TrayAction::StopCore => spawn_service_action(app, "托盘请求停止 Core", |app| {
            let runtime = app.state::<SharedRuntime>();
            service::stop_core(&app, &runtime)
        }),
        TrayAction::RestartCore => spawn_service_action(app, "托盘请求重启 Core", |app| {
            let runtime = app.state::<SharedRuntime>();
            service::stop_core(&app, &runtime)?;
            let settings = load_settings(&app)?;
            service::start_core(&app, &runtime, &settings, None).map(|_| ())
        }),
        TrayAction::OpenWebConsole => {
            if let Err(error) = open_webconsole(app) {
                log_tray_error(app, &error);
                show_main_window(app);
            }
        }
        TrayAction::OpenLogs => {
            if let Err(error) = open_logs_dir(app) {
                log_tray_error(app, &error);
                show_main_window(app);
            }
        }
        TrayAction::Quit => request_quit(app),
    }
}

fn spawn_service_action<F>(app: &AppHandle, message: &'static str, action: F)
where
    F: FnOnce(AppHandle) -> Result<(), String> + Send + 'static,
{
    let app = app.clone();
    thread::spawn(move || {
        let runtime = app.state::<SharedRuntime>();
        service::push_system_log(&app, &runtime, "info", message);
        if let Err(error) = action(app.clone()) {
            service::push_system_log(&app, &runtime, "error", &error);
        }
        update_tray_tooltip(&app);
    });
}

fn request_quit(app: &AppHandle) {
    if let Some(state) = app.try_state::<TrayState>() {
        state.begin_quit();
    }
    cleanup_core_for_exit(app);
    app.exit(0);
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    update_tray_tooltip(app);
}

fn open_webconsole(app: &AppHandle) -> Result<(), String> {
    let url = current_webconsole_url(app)?;
    open_external(&url)
}

fn current_webconsole_url(app: &AppHandle) -> Result<String, String> {
    let (_, paths) = paths::app_paths(app)?;
    let runtime = app.state::<SharedRuntime>();
    let mut guard = runtime.inner.lock().unwrap();
    service::snapshot(&mut guard, &paths, service::core_git_metadata(&paths))
        .into_iter()
        .find(|service| service.service_id == service::GSUID_SERVICE_ID)
        .and_then(|service| service.url)
        .map(|url| format!("{}/app", url.trim_end_matches('/')))
        .ok_or_else(|| "Core 尚未启动，无法从托盘打开 WebConsole".to_string())
}

fn open_logs_dir(app: &AppHandle) -> Result<(), String> {
    let (_, paths) = paths::app_paths(app)?;
    std::fs::create_dir_all(&paths.logs_dir)
        .map_err(|error| format!("创建日志目录失败: {error}"))?;
    open_external(&paths.logs_dir)
}

fn open_external(target: &str) -> Result<(), String> {
    if cfg!(windows) {
        Command::new("explorer")
            .arg(target)
            .spawn()
            .map_err(|error| format!("打开失败: {error}"))?;
    } else {
        Command::new("open")
            .arg(target)
            .spawn()
            .map_err(|error| format!("打开失败: {error}"))?;
    }
    Ok(())
}

fn update_tray_tooltip(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(tray_tooltip_text(app)));
    }
}

fn tray_tooltip_text(app: &AppHandle) -> String {
    format!("GSDesk - {}", core_status_text(app))
}

fn core_status_text(app: &AppHandle) -> String {
    let Ok((_, paths)) = paths::app_paths(app) else {
        return "Core 状态未知".to_string();
    };
    let runtime = app.state::<SharedRuntime>();
    let mut guard = runtime.inner.lock().unwrap();
    let service = service::snapshot(&mut guard, &paths, service::core_git_metadata(&paths))
        .into_iter()
        .find(|service| service.service_id == service::GSUID_SERVICE_ID);
    let Some(service) = service else {
        return "Core 状态未知".to_string();
    };
    let label = service_status_label(service.status);
    if let Some(port) = service.port {
        format!("Core {label} · 127.0.0.1:{port}")
    } else {
        format!("Core {label}")
    }
}

fn log_tray_error(app: &AppHandle, error: &str) {
    let runtime = app.state::<SharedRuntime>();
    service::push_system_log(app, &runtime, "error", error);
    update_tray_tooltip(app);
}

fn load_settings(app: &AppHandle) -> Result<crate::models::Settings, String> {
    let (_, paths) = paths::app_paths(app)?;
    Ok(settings::load_settings(&std::path::PathBuf::from(
        paths.settings_file,
    )))
}

fn should_show_from_tray_event(event: &TrayIconEvent) -> bool {
    matches!(
        event,
        TrayIconEvent::DoubleClick {
            button: MouseButton::Left,
            ..
        } | TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        }
    )
}

fn tray_action(id: &str) -> Option<TrayAction> {
    match id {
        MENU_SHOW => Some(TrayAction::ShowMain),
        MENU_START_CORE => Some(TrayAction::StartCore),
        MENU_STOP_CORE => Some(TrayAction::StopCore),
        MENU_RESTART_CORE => Some(TrayAction::RestartCore),
        MENU_OPEN_WEBCONSOLE => Some(TrayAction::OpenWebConsole),
        MENU_OPEN_LOGS => Some(TrayAction::OpenLogs),
        MENU_QUIT => Some(TrayAction::Quit),
        _ => None,
    }
}

fn service_status_label(status: ServiceStatus) -> &'static str {
    match status {
        ServiceStatus::Uninitialized => "未初始化",
        ServiceStatus::Checking => "检查中",
        ServiceStatus::Initializing => "初始化中",
        ServiceStatus::Starting => "启动中",
        ServiceStatus::Running => "运行中",
        ServiceStatus::Stopping => "停止中",
        ServiceStatus::Stopped => "已停止",
        ServiceStatus::Failed => "失败",
        ServiceStatus::Crashed => "已崩溃",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_known_tray_menu_ids() {
        assert_eq!(tray_action(MENU_SHOW), Some(TrayAction::ShowMain));
        assert_eq!(tray_action(MENU_START_CORE), Some(TrayAction::StartCore));
        assert_eq!(tray_action(MENU_STOP_CORE), Some(TrayAction::StopCore));
        assert_eq!(
            tray_action(MENU_RESTART_CORE),
            Some(TrayAction::RestartCore)
        );
        assert_eq!(
            tray_action(MENU_OPEN_WEBCONSOLE),
            Some(TrayAction::OpenWebConsole)
        );
        assert_eq!(tray_action(MENU_OPEN_LOGS), Some(TrayAction::OpenLogs));
        assert_eq!(tray_action(MENU_QUIT), Some(TrayAction::Quit));
        assert_eq!(tray_action("unknown"), None);
    }

    #[test]
    fn renders_chinese_status_labels() {
        assert_eq!(service_status_label(ServiceStatus::Running), "运行中");
        assert_eq!(service_status_label(ServiceStatus::Crashed), "已崩溃");
    }

    #[test]
    fn tray_state_tracks_explicit_quit() {
        let state = TrayState::default();
        assert!(!state.is_quitting());
        state.begin_quit();
        assert!(state.is_quitting());
    }
}
