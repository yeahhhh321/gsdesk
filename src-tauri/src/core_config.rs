use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::SystemTime;

use chrono::{DateTime, Utc};
use serde_json::{Map, Value};

use crate::models::{
    AppPaths, CoreConfigEntry, CoreConfigFileContent, CoreConfigFileSummary, CoreConfigSaveEntry,
    CoreConfigSaveResult,
};

const CONFIG_ROOTS: [&str; 4] = [
    "data/configs",
    "data/plugins_configs",
    "data/ai_core",
    "data/config.json",
];

pub fn list_core_config_files(paths: &AppPaths) -> Result<Vec<CoreConfigFileSummary>, String> {
    let core_dir = PathBuf::from(&paths.core_dir);
    if !core_dir.exists() {
        return Ok(Vec::new());
    }

    let mut files = Vec::new();
    collect_config_file(&core_dir, Path::new("data/config.json"), &mut files)?;
    for relative_dir in ["data/configs", "data/plugins_configs", "data/ai_core"] {
        collect_config_dir(&core_dir, Path::new(relative_dir), &mut files)?;
    }
    files.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(files)
}

pub fn read_core_config_file(
    paths: &AppPaths,
    relative_path: &str,
) -> Result<CoreConfigFileContent, String> {
    let path = resolve_allowed_config_path(paths, relative_path)?;
    let value = read_json_file(&path)?;
    let schema = detect_schema(&value);
    let entries = parse_entries(&value, schema);
    Ok(CoreConfigFileContent {
        relative_path: normalize_relative_path(relative_path),
        path: path.to_string_lossy().to_string(),
        schema: schema.to_string(),
        entries,
    })
}

pub fn save_core_config_file(
    paths: &AppPaths,
    relative_path: &str,
    entries: Vec<CoreConfigSaveEntry>,
) -> Result<CoreConfigSaveResult, String> {
    let path = resolve_allowed_config_path(paths, relative_path)?;
    let mut value = read_json_file(&path)?;
    let schema = detect_schema(&value);
    let mut saved = Vec::new();
    let mut skipped = Vec::new();

    let backup_path = if entries.is_empty() {
        None
    } else {
        Some(create_config_backup(paths, relative_path, &path)?)
    };

    for entry in entries {
        let key = entry.key;
        match apply_config_value(&mut value, schema, &key, entry.value) {
            Ok(true) => saved.push(key),
            Ok(false) => skipped.push(key),
            Err(error) => return Err(error),
        }
    }

    let content = serde_json::to_string_pretty(&value)
        .map_err(|error| format!("序列化 Core 配置失败: {error}"))?;
    fs::write(&path, format!("{content}\n"))
        .map_err(|error| format!("保存 Core 配置失败 {}: {error}", path.display()))?;

    Ok(CoreConfigSaveResult {
        relative_path: normalize_relative_path(relative_path),
        path: path.to_string_lossy().to_string(),
        backup_path: backup_path.map(|path| path.to_string_lossy().to_string()),
        saved,
        skipped,
    })
}

fn collect_config_dir(
    core_dir: &Path,
    relative_dir: &Path,
    files: &mut Vec<CoreConfigFileSummary>,
) -> Result<(), String> {
    let dir = core_dir.join(relative_dir);
    let Ok(entries) = fs::read_dir(&dir) else {
        return Ok(());
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if path.is_file()
            && path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("json"))
        {
            let Some(file_name) = path.file_name() else {
                continue;
            };
            collect_config_file(core_dir, &relative_dir.join(file_name), files)?;
        }
    }
    Ok(())
}

fn collect_config_file(
    core_dir: &Path,
    relative_path: &Path,
    files: &mut Vec<CoreConfigFileSummary>,
) -> Result<(), String> {
    let path = core_dir.join(relative_path);
    let Ok(metadata) = fs::metadata(&path) else {
        return Ok(());
    };
    if !metadata.is_file() {
        return Ok(());
    }
    let value = read_json_file(&path).unwrap_or_else(|_| Value::Object(Map::new()));
    let schema = detect_schema(&value);
    let entries = parse_entries(&value, schema);
    let relative_path = relative_path.to_string_lossy().replace('\\', "/");
    let modified_at = metadata.modified().ok().map(system_time_to_rfc3339);
    Ok(files.push(CoreConfigFileSummary {
        label: config_label(&relative_path),
        relative_path,
        path: path.to_string_lossy().to_string(),
        size_bytes: metadata.len(),
        modified_at,
        entry_count: entries.len(),
        secret_count: entries.iter().filter(|entry| entry.secret).count(),
    }))
}

fn read_json_file(path: &Path) -> Result<Value, String> {
    let content = fs::read_to_string(path)
        .map_err(|error| format!("读取 Core 配置失败 {}: {error}", path.display()))?;
    if content.trim().is_empty() {
        return Ok(Value::Object(Map::new()));
    }
    serde_json::from_str(&content)
        .map_err(|error| format!("解析 Core 配置 JSON 失败 {}: {error}", path.display()))
}

fn detect_schema(value: &Value) -> &'static str {
    let Value::Object(map) = value else {
        return "plain";
    };
    let total = map.len();
    if total == 0 {
        return "plain";
    }
    let gs_like = map
        .values()
        .filter(|value| {
            value
                .as_object()
                .is_some_and(|object| object.contains_key("data") || object.contains_key("type"))
        })
        .count();
    if gs_like * 2 >= total {
        "gsuid"
    } else {
        "plain"
    }
}

fn parse_entries(value: &Value, schema: &str) -> Vec<CoreConfigEntry> {
    let Value::Object(map) = value else {
        return vec![CoreConfigEntry {
            key: "$root".to_string(),
            title: "根配置".to_string(),
            description: "非对象 JSON 配置".to_string(),
            value: redact_if_secret("$root", value.clone(), false),
            value_type: value_type(value),
            options: Vec::new(),
            secret: false,
            editable: true,
        }];
    };

    let mut entries = map
        .iter()
        .map(|(key, item)| {
            if schema == "gsuid" {
                parse_gsuid_entry(key, item)
            } else {
                parse_plain_entry(key, item)
            }
        })
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| left.key.cmp(&right.key));
    entries
}

fn parse_gsuid_entry(key: &str, item: &Value) -> CoreConfigEntry {
    let object = item.as_object();
    let raw_value = object.and_then(|object| object.get("data")).unwrap_or(item);
    let declared_secret = object
        .and_then(|object| object.get("secret"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let secret = declared_secret || is_sensitive_key(key);
    let title = object
        .and_then(|object| object.get("title"))
        .and_then(Value::as_str)
        .unwrap_or(key)
        .to_string();
    let description = object
        .and_then(|object| object.get("desc"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let options = object
        .and_then(|object| object.get("options"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|value| redact_if_secret(key, value, secret))
        .collect();

    CoreConfigEntry {
        key: key.to_string(),
        title,
        description,
        value: redact_if_secret(key, raw_value.clone(), secret),
        value_type: value_type(raw_value),
        options,
        secret,
        editable: !secret,
    }
}

fn parse_plain_entry(key: &str, value: &Value) -> CoreConfigEntry {
    let secret = is_sensitive_key(key);
    CoreConfigEntry {
        key: key.to_string(),
        title: key.to_string(),
        description: String::new(),
        value: redact_if_secret(key, value.clone(), secret),
        value_type: value_type(value),
        options: Vec::new(),
        secret,
        editable: !secret,
    }
}

fn apply_config_value(
    value: &mut Value,
    schema: &str,
    key: &str,
    next_value: Value,
) -> Result<bool, String> {
    let Value::Object(map) = value else {
        return Err("暂不支持保存非对象 Core 配置".to_string());
    };
    let Some(current) = map.get_mut(key) else {
        return Ok(false);
    };

    if schema == "gsuid" {
        let Some(object) = current.as_object_mut() else {
            return Ok(false);
        };
        let current_data = object.get("data").cloned().unwrap_or(Value::Null);
        let secret = object
            .get("secret")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            || is_sensitive_key(key);
        if secret {
            return Ok(false);
        }
        validate_value_type(key, &current_data, &next_value)?;
        validate_options(key, object, &next_value)?;
        object.insert("data".to_string(), next_value);
        return Ok(true);
    }

    if is_sensitive_key(key) {
        return Ok(false);
    }
    validate_value_type(key, current, &next_value)?;
    *current = next_value;
    Ok(true)
}

fn validate_value_type(key: &str, current: &Value, next: &Value) -> Result<(), String> {
    let current_type = value_type(current);
    let next_type = value_type(next);
    if current_type == next_type {
        return Ok(());
    }
    if current.is_number() && next.is_number() {
        return Ok(());
    }
    Err(format!(
        "配置 {key} 类型不匹配：当前是 {current_type}，新值是 {next_type}"
    ))
}

fn validate_options(key: &str, object: &Map<String, Value>, next: &Value) -> Result<(), String> {
    let Some(options) = object.get("options").and_then(Value::as_array) else {
        return Ok(());
    };
    if options.is_empty() || options.iter().any(|option| option == next) {
        return Ok(());
    }
    Err(format!("配置 {key} 不在允许选项中"))
}

fn create_config_backup(
    paths: &AppPaths,
    relative_path: &str,
    path: &Path,
) -> Result<PathBuf, String> {
    let backups_dir = PathBuf::from(&paths.backups_dir);
    fs::create_dir_all(&backups_dir)
        .map_err(|error| format!("创建配置备份目录失败 {}: {error}", backups_dir.display()))?;
    let timestamp = Utc::now().format("%Y%m%d%H%M%S%9f");
    let safe_name = normalize_relative_path(relative_path).replace('/', "__");
    let backup_path = backups_dir.join(format!("core-config-{timestamp}-{safe_name}.bak.json"));
    fs::copy(path, &backup_path).map_err(|error| {
        format!(
            "备份 Core 配置失败 {} -> {}: {error}",
            path.display(),
            backup_path.display()
        )
    })?;
    Ok(backup_path)
}

pub fn resolve_allowed_config_path(
    paths: &AppPaths,
    relative_path: &str,
) -> Result<PathBuf, String> {
    let normalized = normalize_relative_path(relative_path);
    if !is_allowed_relative_config(&normalized) {
        return Err(format!("不允许编辑该 Core 配置路径: {relative_path}"));
    }

    let relative = Path::new(&normalized);
    if relative
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!("Core 配置路径包含非法片段: {relative_path}"));
    }

    let core_dir = PathBuf::from(&paths.core_dir);
    let path = core_dir.join(relative);
    if !path.exists() {
        return Err(format!("Core 配置不存在: {}", path.display()));
    }
    let core_abs = fs::canonicalize(&core_dir)
        .map_err(|error| format!("解析 Core 目录失败 {}: {error}", core_dir.display()))?;
    let path_abs = fs::canonicalize(&path)
        .map_err(|error| format!("解析 Core 配置失败 {}: {error}", path.display()))?;
    if !path_abs.starts_with(core_abs) {
        return Err(format!("Core 配置路径越界: {}", path.display()));
    }
    Ok(path_abs)
}

fn is_allowed_relative_config(relative_path: &str) -> bool {
    if relative_path == "data/config.json" {
        return true;
    }
    relative_path.ends_with(".json")
        && CONFIG_ROOTS.iter().any(|root| {
            root.ends_with(".json")
                .then_some(false)
                .unwrap_or_else(|| relative_path.starts_with(&format!("{root}/")))
        })
}

fn normalize_relative_path(path: &str) -> String {
    path.replace('\\', "/").trim_start_matches('/').to_string()
}

fn config_label(relative_path: &str) -> String {
    match relative_path {
        "data/config.json" => "Core 主配置".to_string(),
        path if path.starts_with("data/configs/") => {
            format!("Core 配置 / {}", path.trim_start_matches("data/configs/"))
        }
        path if path.starts_with("data/plugins_configs/") => {
            format!(
                "插件配置 / {}",
                path.trim_start_matches("data/plugins_configs/")
            )
        }
        path if path.starts_with("data/ai_core/") => {
            format!("AI 配置 / {}", path.trim_start_matches("data/ai_core/"))
        }
        _ => relative_path.to_string(),
    }
}

fn is_sensitive_key(key: &str) -> bool {
    let lower = key.to_lowercase();
    lower.contains("token")
        || lower.contains("password")
        || lower.contains("passwd")
        || lower.contains("secret")
        || lower.contains("register_code")
        || lower.contains("api_key")
        || lower.ends_with("_key")
        || lower.contains("apikey")
}

fn redact_if_secret(_key: &str, value: Value, secret: bool) -> Value {
    if secret {
        Value::String("******".to_string())
    } else {
        value
    }
}

fn value_type(value: &Value) -> String {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "bool",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
    .to_string()
}

fn system_time_to_rfc3339(value: SystemTime) -> String {
    let value: DateTime<Utc> = value.into();
    value.to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_paths(dir: &Path) -> AppPaths {
        AppPaths {
            app_data: dir.join("app").to_string_lossy().to_string(),
            runtime: dir.join("runtime").to_string_lossy().to_string(),
            tools_dir: dir.join("runtime/tools").to_string_lossy().to_string(),
            core_dir: dir.join("core").to_string_lossy().to_string(),
            venv_dir: dir.join("runtime/venv").to_string_lossy().to_string(),
            uv_cache_dir: dir.join("runtime/cache").to_string_lossy().to_string(),
            uv_python_dir: dir.join("runtime/python").to_string_lossy().to_string(),
            uv_executable: dir.join("runtime/tools/uv").to_string_lossy().to_string(),
            logs_dir: dir.join("logs").to_string_lossy().to_string(),
            diagnostics_dir: dir.join("diagnostics").to_string_lossy().to_string(),
            backups_dir: dir.join("backups").to_string_lossy().to_string(),
            settings_file: dir.join("settings.json").to_string_lossy().to_string(),
        }
    }

    #[test]
    fn reads_gsuid_config_and_redacts_sensitive_values() {
        let dir = std::env::temp_dir().join(format!(
            "gsdesk-core-config-read-{}",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let paths = test_paths(&dir);
        let config_dir = PathBuf::from(&paths.core_dir).join("data").join("configs");
        fs::create_dir_all(&config_dir).unwrap();
        fs::write(
            config_dir.join("core_config.json"),
            r#"{
              "AutoUpdateCore": {"type":"GsBoolConfig","title":"自动更新Core","desc":"desc","data":true,"secret":false},
              "ApiToken": {"type":"GsStrConfig","title":"Token","desc":"","data":"secret","secret":true}
            }"#,
        )
        .unwrap();

        let content = read_core_config_file(&paths, "data/configs/core_config.json").unwrap();

        assert_eq!(content.schema, "gsuid");
        assert!(content
            .entries
            .iter()
            .any(|entry| entry.key == "AutoUpdateCore" && entry.value == Value::Bool(true)));
        assert!(content.entries.iter().any(|entry| {
            entry.key == "ApiToken"
                && entry.secret
                && entry.value == Value::String("******".to_string())
        }));

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn saves_allowed_values_and_skips_sensitive_plain_keys() {
        let dir = std::env::temp_dir().join(format!(
            "gsdesk-core-config-save-{}",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let paths = test_paths(&dir);
        let data_dir = PathBuf::from(&paths.core_dir).join("data");
        fs::create_dir_all(&data_dir).unwrap();
        fs::write(
            data_dir.join("config.json"),
            r#"{"HOST":"127.0.0.1","ENABLE_HTTP":false,"WS_TOKEN":"secret"}"#,
        )
        .unwrap();

        let result = save_core_config_file(
            &paths,
            "data/config.json",
            vec![
                CoreConfigSaveEntry {
                    key: "HOST".to_string(),
                    value: Value::String("0.0.0.0".to_string()),
                },
                CoreConfigSaveEntry {
                    key: "WS_TOKEN".to_string(),
                    value: Value::String("new".to_string()),
                },
            ],
        )
        .unwrap();

        assert_eq!(result.saved, vec!["HOST".to_string()]);
        assert_eq!(result.skipped, vec!["WS_TOKEN".to_string()]);
        assert!(result.backup_path.is_some());
        let saved = read_json_file(&data_dir.join("config.json")).unwrap();
        assert_eq!(saved["HOST"], Value::String("0.0.0.0".to_string()));
        assert_eq!(saved["WS_TOKEN"], Value::String("secret".to_string()));

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_config_path_traversal() {
        let dir = std::env::temp_dir().join(format!(
            "gsdesk-core-config-traversal-{}",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let paths = test_paths(&dir);
        fs::create_dir_all(&paths.core_dir).unwrap();

        let error = read_core_config_file(&paths, "../settings.json").unwrap_err();

        assert!(error.contains("不允许编辑"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_type_changes_when_saving() {
        let dir = std::env::temp_dir().join(format!(
            "gsdesk-core-config-type-{}",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let paths = test_paths(&dir);
        let data_dir = PathBuf::from(&paths.core_dir).join("data");
        fs::create_dir_all(&data_dir).unwrap();
        fs::write(data_dir.join("config.json"), r#"{"ENABLE_HTTP":false}"#).unwrap();

        let error = save_core_config_file(
            &paths,
            "data/config.json",
            vec![CoreConfigSaveEntry {
                key: "ENABLE_HTTP".to_string(),
                value: Value::String("false".to_string()),
            }],
        )
        .unwrap_err();

        assert!(error.contains("类型不匹配"));
        let _ = fs::remove_dir_all(dir);
    }
}
