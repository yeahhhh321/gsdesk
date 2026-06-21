use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

use crate::models::{UpdateInfo, UpdateInstallResult};

pub async fn check_shell_update(app: &AppHandle) -> UpdateInfo {
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(error) => return update_error(current_version, format!("初始化壳更新器失败: {error}")),
    };

    match updater.check().await {
        Ok(Some(update)) => UpdateInfo {
            current_version: update.current_version,
            latest_version: Some(update.version),
            prerelease_version: None,
            has_update: true,
            channel: "latest".to_string(),
            release_url: Some(update.download_url.to_string()),
            prerelease_url: None,
            notes: update.body,
            error: None,
        },
        Ok(None) => UpdateInfo {
            current_version,
            latest_version: None,
            prerelease_version: None,
            has_update: false,
            channel: "current".to_string(),
            release_url: None,
            prerelease_url: None,
            notes: None,
            error: None,
        },
        Err(error) => update_error(current_version, format!("检查壳更新失败: {error}")),
    }
}

pub async fn install_shell_update(app: AppHandle) -> Result<UpdateInstallResult, String> {
    let updater = app.updater().map_err(|error| format!("初始化壳更新器失败: {error}"))?;
    let update = updater
        .check()
        .await
        .map_err(|error| format!("检查壳更新失败: {error}"))?
        .ok_or_else(|| "当前已是最新版本，无需安装更新".to_string())?;

    let version = update.version.clone();
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|error| format!("下载或安装壳更新失败: {error}"))?;

    #[cfg(not(target_os = "windows"))]
    app.restart();

    Ok(UpdateInstallResult {
        version: Some(version.clone()),
        message: format!("壳更新 {version} 已安装，正在重启 GSDesk"),
    })
}

fn update_error(current_version: String, error: String) -> UpdateInfo {
    UpdateInfo {
        current_version,
        latest_version: None,
        prerelease_version: None,
        has_update: false,
        channel: "error".to_string(),
        release_url: None,
        prerelease_url: None,
        notes: None,
        error: Some(error),
    }
}

#[cfg(test)]
mod tests {
    use super::update_error;

    #[test]
    fn updater_errors_keep_current_version_and_raw_detail() {
        let info = update_error("0.1.0".to_string(), "network timeout".to_string());
        assert_eq!(info.current_version, "0.1.0");
        assert_eq!(info.channel, "error");
        assert!(!info.has_update);
        assert_eq!(info.error.as_deref(), Some("network timeout"));
    }
}
