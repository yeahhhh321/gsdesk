use std::fs;
use std::path::Path;

use chrono::Utc;
use serde_json::{json, Value};

use crate::models::{Settings, SettingsTransferResult};

pub fn load_settings(settings_file: &Path) -> Settings {
    match fs::read_to_string(settings_file) {
        Ok(raw) => serde_json::from_str::<Settings>(&raw).unwrap_or_default(),
        Err(_) => Settings::default(),
    }
}

pub fn save_settings_file(settings_file: &Path, settings: &Settings) -> Result<(), String> {
    if let Some(parent) = settings_file.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建设置目录失败: {error}"))?;
    }
    let json = serde_json::to_string_pretty(settings)
        .map_err(|error| format!("序列化设置失败: {error}"))?;
    fs::write(settings_file, json).map_err(|error| format!("写入设置失败: {error}"))
}

pub fn env_from_settings(settings: &Settings) -> Vec<(String, String)> {
    let mut envs = Vec::new();
    if !settings.pypi_index_url.trim().is_empty() {
        envs.push(("UV_DEFAULT_INDEX".to_string(), settings.pypi_index_url.trim().to_string()));
    }
    add_proxy_env(&mut envs, "HTTP_PROXY", &settings.proxy.http_proxy);
    add_proxy_env(&mut envs, "http_proxy", &settings.proxy.http_proxy);
    add_proxy_env(&mut envs, "HTTPS_PROXY", &settings.proxy.https_proxy);
    add_proxy_env(&mut envs, "https_proxy", &settings.proxy.https_proxy);
    add_proxy_env(&mut envs, "ALL_PROXY", &settings.proxy.all_proxy);
    add_proxy_env(&mut envs, "all_proxy", &settings.proxy.all_proxy);
    add_proxy_env(&mut envs, "NO_PROXY", &settings.proxy.no_proxy);
    add_proxy_env(&mut envs, "no_proxy", &settings.proxy.no_proxy);
    envs
}

pub fn export_portable_settings(
    backups_dir: &Path,
    settings: &Settings,
) -> Result<SettingsTransferResult, String> {
    fs::create_dir_all(backups_dir)
        .map_err(|error| format!("创建设置导出目录失败 {}: {error}", backups_dir.display()))?;
    let path =
        backups_dir.join(format!("gsdesk-settings-{}.json", Utc::now().format("%Y%m%d%H%M%S%9f")));
    let fields = portable_setting_fields();
    let skipped = sensitive_setting_fields();
    let payload = json!({
        "schemaVersion": 1,
        "kind": "gsdesk-settings",
        "exportedAt": Utc::now().to_rfc3339(),
        "settings": {
            "beginnerMode": settings.beginner_mode,
            "sourceMode": settings.source_mode,
            "selectedSource": settings.selected_source,
            "customCoreDir": settings.custom_core_dir,
            "pypiIndexMode": settings.pypi_index_mode,
            "pypiIndexUrl": settings.pypi_index_url,
            "preferredCorePort": settings.preferred_core_port,
            "closeCoreOnExit": settings.close_core_on_exit,
            "hideToTrayOnClose": settings.hide_to_tray_on_close,
            "autoCheckUpdate": settings.auto_check_update,
            "language": settings.language,
            "proxy": {
                "noProxy": settings.proxy.no_proxy
            }
        },
        "skipped": skipped,
    });
    let json = serde_json::to_string_pretty(&payload)
        .map_err(|error| format!("序列化设置导出失败: {error}"))?;
    fs::write(&path, json)
        .map_err(|error| format!("写入设置导出失败 {}: {error}", path.display()))?;
    Ok(SettingsTransferResult { path: path.to_string_lossy().to_string(), fields, skipped })
}

pub fn import_portable_settings(
    backups_dir: &Path,
    current: &Settings,
    path: Option<&Path>,
) -> Result<(Settings, SettingsTransferResult), String> {
    let path = match path {
        Some(path) => path.to_path_buf(),
        None => latest_settings_export(backups_dir)?,
    };
    let raw = fs::read_to_string(&path)
        .map_err(|error| format!("读取设置导入文件失败 {}: {error}", path.display()))?;
    let value = serde_json::from_str::<Value>(&raw)
        .map_err(|error| format!("解析设置导入文件失败 {}: {error}", path.display()))?;
    if value.get("kind").and_then(Value::as_str) != Some("gsdesk-settings") {
        return Err("设置导入文件类型不正确，需要 kind=gsdesk-settings".to_string());
    }
    let settings_value =
        value.get("settings").ok_or_else(|| "设置导入文件缺少 settings 字段".to_string())?;
    let mut next = current.clone();
    let mut fields = Vec::new();

    if let Some(value) = settings_value.get("beginnerMode").and_then(Value::as_bool) {
        next.beginner_mode = value;
        fields.push("beginnerMode".to_string());
    }
    if let Some(value) = read_string(settings_value, "sourceMode") {
        if matches!(value.as_str(), "auto" | "github" | "cnb") {
            next.source_mode = value;
            fields.push("sourceMode".to_string());
        }
    }
    if let Some(value) = read_string(settings_value, "selectedSource") {
        next.selected_source = value;
        fields.push("selectedSource".to_string());
    }
    if let Some(value) = read_string(settings_value, "customCoreDir") {
        next.custom_core_dir = value;
        fields.push("customCoreDir".to_string());
    }
    if let Some(value) = read_string(settings_value, "pypiIndexUrl") {
        next.pypi_index_url = value;
        fields.push("pypiIndexUrl".to_string());
    }
    if let Some(value) = read_string(settings_value, "pypiIndexMode") {
        if matches!(value.as_str(), "auto" | "manual") {
            next.pypi_index_mode = value;
            fields.push("pypiIndexMode".to_string());
        }
    }
    if let Some(value) = settings_value.get("preferredCorePort") {
        if value.is_null() {
            next.preferred_core_port = None;
            fields.push("preferredCorePort".to_string());
        } else if let Some(port) = value.as_u64().and_then(|port| u16::try_from(port).ok()) {
            next.preferred_core_port = Some(port);
            fields.push("preferredCorePort".to_string());
        }
    }
    if let Some(value) = settings_value.get("closeCoreOnExit").and_then(Value::as_bool) {
        next.close_core_on_exit = value;
        fields.push("closeCoreOnExit".to_string());
    }
    if let Some(value) = settings_value.get("hideToTrayOnClose").and_then(Value::as_bool) {
        next.hide_to_tray_on_close = value;
        fields.push("hideToTrayOnClose".to_string());
    }
    if let Some(value) = settings_value.get("autoCheckUpdate").and_then(Value::as_bool) {
        next.auto_check_update = value;
        fields.push("autoCheckUpdate".to_string());
    }
    if let Some(value) = read_string(settings_value, "language") {
        if value == "zh-CN" {
            next.language = value;
            fields.push("language".to_string());
        }
    }
    if let Some(value) = settings_value.get("proxy").and_then(|proxy| read_string(proxy, "noProxy"))
    {
        next.proxy.no_proxy = value;
        fields.push("proxy.noProxy".to_string());
    }

    Ok((
        next,
        SettingsTransferResult {
            path: path.to_string_lossy().to_string(),
            fields,
            skipped: sensitive_setting_fields(),
        },
    ))
}

fn latest_settings_export(backups_dir: &Path) -> Result<std::path::PathBuf, String> {
    let mut files = fs::read_dir(backups_dir)
        .map_err(|error| format!("读取设置备份目录失败 {}: {error}", backups_dir.display()))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .map(|name| name.starts_with("gsdesk-settings-") && name.ends_with(".json"))
                    .unwrap_or(false)
        })
        .filter_map(|path| {
            let modified = fs::metadata(&path).and_then(|metadata| metadata.modified()).ok()?;
            Some((path, modified))
        })
        .collect::<Vec<_>>();
    files.sort_by_key(|(_, modified)| *modified);
    files
        .pop()
        .map(|(path, _)| path)
        .ok_or_else(|| "没有找到可导入的设置备份，请先导出设置".to_string())
}

fn read_string(value: &Value, key: &str) -> Option<String> {
    value.get(key)?.as_str().map(ToString::to_string)
}

fn portable_setting_fields() -> Vec<String> {
    [
        "beginnerMode",
        "sourceMode",
        "selectedSource",
        "customCoreDir",
        "pypiIndexMode",
        "pypiIndexUrl",
        "preferredCorePort",
        "closeCoreOnExit",
        "hideToTrayOnClose",
        "autoCheckUpdate",
        "language",
        "proxy.noProxy",
    ]
    .into_iter()
    .map(ToString::to_string)
    .collect()
}

fn sensitive_setting_fields() -> Vec<String> {
    ["proxy.httpProxy", "proxy.httpsProxy", "proxy.allProxy"]
        .into_iter()
        .map(ToString::to_string)
        .collect()
}

fn add_proxy_env(envs: &mut Vec<(String, String)>, key: &str, value: &str) {
    let value = value.trim();
    if !value.is_empty() {
        envs.push((key.to_string(), value.to_string()));
    }
}

pub fn redact_secrets(input: &str) -> String {
    let mut value = input.to_string();
    for key in ["WS_TOKEN", "REGISTER_CODE", "token", "password", "passwd"] {
        let key = regex::escape(key);
        let pattern = format!(r#"(?i)(^|[{{,\s])("?{}"?\s*[:=]\s*)("[^"]+"|[^\s,}}]+)"#, key);
        if let Ok(regex) = regex::Regex::new(&pattern) {
            value = regex.replace_all(&value, "$1$2\"***\"").to_string();
        }
    }
    match regex::Regex::new(r#"(https?://)([^:/\s]+):([^@\s]+)@"#) {
        Ok(regex) => regex.replace_all(&value, "$1$2:***@").to_string(),
        Err(_) => value,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proxy_env_preserves_no_proxy() {
        let settings = Settings::default();
        let envs = env_from_settings(&settings);
        assert!(envs.iter().any(|(key, value)| key == "NO_PROXY" && value.contains("127.0.0.1")));
    }

    #[test]
    fn redacts_tokens_and_proxy_passwords() {
        let raw = r#"{"WS_TOKEN":"abc","REGISTER_CODE":"def"} WS_TOKEN=ghi REGISTER_CODE=jkl password=secret http://user:pass@127.0.0.1:7890"#;
        let redacted = redact_secrets(raw);
        assert!(!redacted.contains("abc"));
        assert!(!redacted.contains("def"));
        assert!(!redacted.contains("ghi"));
        assert!(!redacted.contains("jkl"));
        assert!(!redacted.contains("secret"));
        assert!(!redacted.contains("pass@"));
        assert!(redacted.contains("WS_TOKEN=\"***\""));
        assert!(redacted.contains("REGISTER_CODE=\"***\""));
    }

    #[test]
    fn portable_settings_export_skips_proxy_credentials() {
        let dir = std::env::temp_dir().join(format!(
            "gsdesk-settings-export-test-{}",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let mut settings = Settings::default();
        settings.proxy.http_proxy = "http://user:secret@127.0.0.1:7890".to_string();
        settings.proxy.no_proxy = "127.0.0.1,localhost".to_string();
        settings.pypi_index_mode = "manual".to_string();
        settings.preferred_core_port = Some(8899);
        settings.custom_core_dir = "D:\\gsuid_core".to_string();

        let result = export_portable_settings(&dir, &settings).unwrap();
        let raw = fs::read_to_string(&result.path).unwrap();

        assert!(raw.contains("\"pypiIndexMode\": \"manual\""));
        assert!(raw.contains("\"beginnerMode\": true"));
        assert!(raw.contains("\"preferredCorePort\": 8899"));
        assert!(raw.contains("\"customCoreDir\": \"D:\\\\gsuid_core\""));
        assert!(raw.contains("127.0.0.1,localhost"));
        assert!(!raw.contains("secret"));
        assert!(result.fields.contains(&"pypiIndexMode".to_string()));
        assert!(result.skipped.contains(&"proxy.httpProxy".to_string()));

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn portable_settings_import_merges_non_sensitive_fields() {
        let dir = std::env::temp_dir().join(format!(
            "gsdesk-settings-import-test-{}",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("gsdesk-settings-test.json");
        fs::write(
            &path,
            r#"{
              "kind": "gsdesk-settings",
              "settings": {
                "beginnerMode": false,
                "sourceMode": "cnb",
                "selectedSource": "https://cnb.cool/gscore-mirror/gsuid_core.git",
                "customCoreDir": "D:\\gsuid_core",
                "pypiIndexMode": "manual",
                "pypiIndexUrl": "https://mirrors.aliyun.com/pypi/simple/",
                "preferredCorePort": 8899,
                "hideToTrayOnClose": false,
                "proxy": { "noProxy": "127.0.0.1,localhost,::1" }
              }
            }"#,
        )
        .unwrap();
        let mut current = Settings::default();
        current.proxy.http_proxy = "http://user:secret@127.0.0.1:7890".to_string();

        let (settings, result) = import_portable_settings(&dir, &current, Some(&path)).unwrap();

        assert_eq!(settings.source_mode, "cnb");
        assert!(!settings.beginner_mode);
        assert_eq!(settings.custom_core_dir, "D:\\gsuid_core");
        assert_eq!(settings.pypi_index_mode, "manual");
        assert_eq!(settings.preferred_core_port, Some(8899));
        assert!(!settings.hide_to_tray_on_close);
        assert_eq!(settings.proxy.http_proxy, "http://user:secret@127.0.0.1:7890");
        assert!(result.fields.contains(&"pypiIndexMode".to_string()));
        assert!(result.fields.contains(&"beginnerMode".to_string()));
        assert!(result.fields.contains(&"customCoreDir".to_string()));
        assert!(result.fields.contains(&"hideToTrayOnClose".to_string()));
        assert!(result.fields.contains(&"proxy.noProxy".to_string()));

        let _ = fs::remove_dir_all(dir);
    }
}
