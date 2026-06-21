use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

use chrono::Utc;
use zip::write::FileOptions;

use crate::models::{AppPaths, RuntimeBackupResult, RuntimeRestoreResult};
use crate::settings::redact_secrets;

pub fn create_runtime_backup_inner(paths: &AppPaths) -> Result<RuntimeBackupResult, String> {
    let backup_dir = PathBuf::from(&paths.backups_dir);
    fs::create_dir_all(&backup_dir)
        .map_err(|error| format!("创建备份目录失败 {}: {error}", backup_dir.display()))?;
    let path =
        backup_dir.join(format!("gsdesk-runtime-{}.zip", Utc::now().format("%Y%m%d%H%M%S%9f")));
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
        add_backup_text(&mut zip, options, "settings.redacted.json", &redact_secrets(&settings))?;
        included.push("settings.redacted.json".to_string());
    }

    for (label, path) in [
        ("core-data", PathBuf::from(&paths.core_dir).join("data")),
        ("core-config", PathBuf::from(&paths.core_dir).join("config")),
        ("core-plugins", PathBuf::from(&paths.core_dir).join("plugins")),
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
    zip.finish().map_err(|error| format!("写入备份 zip 失败 {}: {error}", path.display()))?;
    Ok(RuntimeBackupResult { path: path.to_string_lossy().to_string(), included })
}

pub fn restore_runtime_backup_inner(
    paths: &AppPaths,
    requested_path: Option<&str>,
) -> Result<RuntimeRestoreResult, String> {
    let backup_path = resolve_runtime_backup_path(paths, requested_path)?;
    let safety_backup = create_runtime_backup_inner(paths).ok().map(|backup| backup.path);
    let file = File::open(&backup_path)
        .map_err(|error| format!("打开运行时备份失败 {}: {error}", backup_path.display()))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| format!("读取运行时备份 zip 失败 {}: {error}", backup_path.display()))?;

    let restore_targets = restore_target_dirs(paths);
    let mut required_roots = Vec::new();
    for index in 0..archive.len() {
        let entry =
            archive.by_index(index).map_err(|error| format!("读取备份条目失败: {error}"))?;
        let Some(root) = backup_entry_root(entry.name()) else {
            continue;
        };
        if restore_targets.contains_key(root) && !required_roots.contains(&root.to_string()) {
            required_roots.push(root.to_string());
        }
    }
    if required_roots.is_empty() {
        return Err(
            "运行时备份中没有可恢复的 core-data/core-config/core-plugins/logs 条目".to_string()
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
        let mut entry =
            archive.by_index(index).map_err(|error| format!("读取备份条目失败: {error}"))?;
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
        let relative =
            enclosed.strip_prefix(root).map_err(|_| format!("备份条目路径不匹配: {name}"))?;
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
            let modified = fs::metadata(&path).and_then(|metadata| metadata.modified()).ok()?;
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
        Err(format!("出于安全限制，只允许恢复备份目录内的 zip: {}", dir.display()))
    }
}

fn restore_target_dirs(paths: &AppPaths) -> HashMap<&'static str, PathBuf> {
    [
        ("core-data", PathBuf::from(&paths.core_dir).join("data")),
        ("core-config", PathBuf::from(&paths.core_dir).join("config")),
        ("core-plugins", PathBuf::from(&paths.core_dir).join("plugins")),
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
        let name = format!("{}/{}", prefix, entry.file_name().to_string_lossy().replace('\\', "/"));
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
    zip.write_all(content.as_bytes()).map_err(|error| format!("写入备份文本失败 {name}: {error}"))
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

#[cfg(test)]
mod tests {
    use std::io::Read;

    use super::*;

    fn test_paths(
        dir: &Path,
        runtime: &Path,
        core: &Path,
        logs: &Path,
        backups: &Path,
    ) -> AppPaths {
        AppPaths {
            app_data: dir.to_string_lossy().to_string(),
            runtime: runtime.to_string_lossy().to_string(),
            tools_dir: runtime.join("tools").to_string_lossy().to_string(),
            core_dir: core.to_string_lossy().to_string(),
            venv_dir: runtime.join("venvs").join("gsuid_core").to_string_lossy().to_string(),
            uv_cache_dir: runtime.join("uv").join("cache").to_string_lossy().to_string(),
            uv_python_dir: runtime.join("uv").join("python").to_string_lossy().to_string(),
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
        }
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

        let paths = test_paths(&dir, &runtime, &core, &dir.join("logs"), &backups);
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
        archive.by_name("settings.redacted.json").unwrap().read_to_string(&mut settings).unwrap();
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

        let paths = test_paths(&dir, &runtime, &core, &logs, &backups);
        let restored =
            restore_runtime_backup_inner(&paths, Some(backup_path.to_string_lossy().as_ref()))
                .unwrap();

        assert!(restored.safety_backup.is_some());
        assert!(restored.restored.contains(&"core-data".to_string()));
        assert_eq!(fs::read_to_string(data.join("new.json")).unwrap(), "new-data");
        assert!(!data.join("old.json").exists());
        assert_eq!(fs::read_to_string(config.join("new.json")).unwrap(), "new-config");
        assert_eq!(fs::read_to_string(plugins.join("new.py")).unwrap(), "new-plugin");
        assert_eq!(fs::read_to_string(logs.join("core.log")).unwrap(), "new-log");

        let _ = fs::remove_dir_all(dir);
    }
}
