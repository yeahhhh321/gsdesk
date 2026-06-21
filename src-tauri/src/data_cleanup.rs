use std::fs;
use std::path::{Path, PathBuf};

use crate::models::{AppPaths, ClearAppDataResult};

pub fn clear_app_data(paths: &AppPaths) -> Result<ClearAppDataResult, String> {
    let app_data = PathBuf::from(&paths.app_data);
    let app_data_abs = normalize_existing_dir(&app_data)?;
    validate_app_data_root(&app_data_abs)?;

    let mut deleted = Vec::new();
    let mut failures = Vec::new();
    for entry in fs::read_dir(&app_data_abs)
        .map_err(|error| format!("读取应用数据目录失败 {}: {error}", app_data_abs.display()))?
    {
        let entry = entry.map_err(|error| format!("读取应用数据目录条目失败: {error}"))?;
        let path = entry.path();
        let label = path.to_string_lossy().to_string();
        match remove_entry(&path) {
            Ok(_) => deleted.push(label),
            Err(error) => failures.push(format!("{label}: {error}")),
        }
    }

    if !failures.is_empty() {
        return Err(format!("清理本机数据部分失败: {}", failures.join("；")));
    }

    Ok(ClearAppDataResult {
        app_data: app_data_abs.to_string_lossy().to_string(),
        deleted,
        message: "本机数据已清理，GSDesk 已回到未初始化状态".to_string(),
    })
}

fn normalize_existing_dir(path: &Path) -> Result<PathBuf, String> {
    let absolute = fs::canonicalize(path)
        .map_err(|error| format!("解析应用数据目录失败 {}: {error}", path.display()))?;
    if !absolute.is_dir() {
        return Err(format!("应用数据路径不是目录: {}", absolute.display()));
    }
    Ok(absolute)
}

fn validate_app_data_root(path: &Path) -> Result<(), String> {
    let name = path.file_name().and_then(|value| value.to_str()).unwrap_or_default().to_lowercase();
    if !name.contains("gsdesk") {
        return Err(format!("拒绝清理非 GSDesk 数据目录: {}", path.display()));
    }
    if path.parent().is_none() || path.components().count() < 3 {
        return Err(format!("拒绝清理危险路径: {}", path.display()));
    }
    Ok(())
}

fn remove_entry(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("读取路径信息失败 {}: {error}", path.display()))?;
    let file_type = metadata.file_type();
    if file_type.is_symlink() {
        if path.is_dir() {
            return fs::remove_dir(path).map_err(|error| format!("删除目录链接失败: {error}"));
        }
        return fs::remove_file(path).map_err(|error| format!("删除文件链接失败: {error}"));
    }
    if file_type.is_dir() {
        fs::remove_dir_all(path).map_err(|error| format!("删除目录失败: {error}"))
    } else {
        fs::remove_file(path).map_err(|error| format!("删除文件失败: {error}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::AppPaths;

    #[test]
    fn clear_app_data_removes_only_children() {
        let root = std::env::temp_dir().join(format!(
            "gsdesk-clear-data-test-{}",
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let runtime = root.join("runtime");
        let logs = root.join("logs");
        fs::create_dir_all(runtime.join("core")).unwrap();
        fs::create_dir_all(&logs).unwrap();
        fs::write(root.join("settings.json"), "{}").unwrap();
        fs::write(logs.join("core.log"), "log").unwrap();

        let result = clear_app_data(&test_paths(&root)).unwrap();

        assert_eq!(result.app_data, fs::canonicalize(&root).unwrap().to_string_lossy().to_string());
        assert!(root.exists());
        assert!(fs::read_dir(&root).unwrap().next().is_none());
        assert!(result.deleted.iter().any(|path| path.contains("runtime")));
        assert!(result.deleted.iter().any(|path| path.contains("settings.json")));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn clear_app_data_rejects_non_gsdesk_path() {
        let root = std::env::temp_dir().join(format!(
            "other-app-data-test-{}",
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        fs::create_dir_all(&root).unwrap();

        let error = clear_app_data(&test_paths(&root)).unwrap_err();

        assert!(error.contains("拒绝清理非 GSDesk 数据目录"));
        let _ = fs::remove_dir_all(root);
    }

    fn test_paths(root: &Path) -> AppPaths {
        AppPaths {
            app_data: root.to_string_lossy().to_string(),
            runtime: root.join("runtime").to_string_lossy().to_string(),
            tools_dir: root.join("runtime/tools").to_string_lossy().to_string(),
            core_dir: root.join("runtime/core/gsuid_core").to_string_lossy().to_string(),
            venv_dir: root.join("runtime/venvs/gsuid_core").to_string_lossy().to_string(),
            uv_cache_dir: root.join("runtime/uv/cache").to_string_lossy().to_string(),
            uv_python_dir: root.join("runtime/uv/python").to_string_lossy().to_string(),
            uv_executable: root
                .join("runtime/tools/uv/Scripts/uv.exe")
                .to_string_lossy()
                .to_string(),
            logs_dir: root.join("logs").to_string_lossy().to_string(),
            diagnostics_dir: root.join("diagnostics").to_string_lossy().to_string(),
            backups_dir: root.join("runtime/backups").to_string_lossy().to_string(),
            settings_file: root.join("settings.json").to_string_lossy().to_string(),
        }
    }
}
