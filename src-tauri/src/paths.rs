use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::models::AppPaths;

pub fn app_paths(app: &AppHandle) -> Result<(PathBuf, AppPaths), String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录: {error}"))?;
    build_paths(&base)
}

pub fn build_paths(base: &Path) -> Result<(PathBuf, AppPaths), String> {
    let runtime = base.join("runtime");
    let tools_dir = runtime.join("tools");
    let core_dir = runtime.join("core").join("gsuid_core");
    let venv_dir = runtime.join("venvs").join("gsuid_core");
    let uv_cache_dir = runtime.join("uv").join("cache");
    let uv_python_dir = runtime.join("uv").join("python");
    let uv_executable = tools_dir.join("uv").join(uv_executable_name());
    let backups_dir = runtime.join("backups");
    let logs_dir = base.join("logs");
    let diagnostics_dir = base.join("diagnostics");
    let settings_file = base.join("settings.json");

    for dir in [
        base,
        &runtime,
        &tools_dir,
        &uv_cache_dir,
        &uv_python_dir,
        &backups_dir,
        &logs_dir,
        &diagnostics_dir,
    ] {
        fs::create_dir_all(dir)
            .map_err(|error| format!("创建目录失败 {}: {error}", dir.display()))?;
    }

    Ok((
        base.to_path_buf(),
        AppPaths {
            app_data: display_path(base),
            runtime: display_path(&runtime),
            tools_dir: display_path(&tools_dir),
            core_dir: display_path(&core_dir),
            venv_dir: display_path(&venv_dir),
            uv_cache_dir: display_path(&uv_cache_dir),
            uv_python_dir: display_path(&uv_python_dir),
            uv_executable: display_path(&uv_executable),
            logs_dir: display_path(&logs_dir),
            diagnostics_dir: display_path(&diagnostics_dir),
            backups_dir: display_path(&backups_dir),
            settings_file: display_path(&settings_file),
        },
    ))
}

pub fn uv_executable_name() -> &'static str {
    if cfg!(windows) {
        "uv.exe"
    } else {
        "uv"
    }
}

pub fn display_path(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_expected_paths() {
        let temp = std::env::temp_dir().join("gsdesk-path-test");
        let (_, paths) = build_paths(&temp).unwrap();
        assert!(
            paths.core_dir.ends_with("runtime\\core\\gsuid_core")
                || paths.core_dir.ends_with("runtime/core/gsuid_core")
        );
        assert!(paths.venv_dir.contains("venvs"));
        assert!(paths.tools_dir.contains("tools"));
        assert!(paths.uv_executable.ends_with("uv.exe") || paths.uv_executable.ends_with("uv"));
    }
}
