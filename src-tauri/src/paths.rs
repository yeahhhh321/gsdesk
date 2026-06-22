use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::models::{AppPaths, Settings};
use crate::settings;

pub fn app_paths(app: &AppHandle) -> Result<(PathBuf, AppPaths), String> {
    let base =
        app.path().app_data_dir().map_err(|error| format!("无法定位应用数据目录: {error}"))?;
    let settings_file = base.join("settings.json");
    let settings = settings::load_settings(&settings_file);
    build_paths_with_settings(&base, &settings)
}

pub fn build_paths_with_settings(
    base: &Path,
    settings: &Settings,
) -> Result<(PathBuf, AppPaths), String> {
    let runtime = base.join("runtime");
    let tools_dir = runtime.join("tools");
    let core_dir = resolve_core_dir(base, &runtime, settings);
    let venv_dir = runtime.join("venvs").join("gsuid_core");
    let uv_cache_dir = runtime.join("uv").join("cache");
    let uv_python_dir = runtime.join("uv").join("python");
    let uv_executable = tools_dir.join("uv").join(uv_scripts_dir_name()).join(uv_executable_name());
    let playwright_browsers_dir = runtime.join("playwright").join("browsers");
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
        &playwright_browsers_dir,
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
            playwright_browsers_dir: display_path(&playwright_browsers_dir),
            logs_dir: display_path(&logs_dir),
            diagnostics_dir: display_path(&diagnostics_dir),
            backups_dir: display_path(&backups_dir),
            settings_file: display_path(&settings_file),
        },
    ))
}

fn resolve_core_dir(base: &Path, runtime: &Path, settings: &Settings) -> PathBuf {
    let custom = settings.custom_core_dir.trim();
    if custom.is_empty() {
        return runtime.join("core").join("gsuid_core");
    }
    let custom_path = PathBuf::from(custom);
    if custom_path.is_absolute() {
        return custom_path;
    }
    base.join(custom_path)
}

pub fn uv_executable_name() -> &'static str {
    if cfg!(windows) {
        "uv.exe"
    } else {
        "uv"
    }
}

pub fn uv_scripts_dir_name() -> &'static str {
    if cfg!(windows) {
        "Scripts"
    } else {
        "bin"
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
        let (_, paths) = build_paths_with_settings(&temp, &Settings::default()).unwrap();
        assert!(
            paths.core_dir.ends_with("runtime\\core\\gsuid_core")
                || paths.core_dir.ends_with("runtime/core/gsuid_core")
        );
        assert!(paths.venv_dir.contains("venvs"));
        assert!(paths.tools_dir.contains("tools"));
        assert!(paths.uv_executable.ends_with("uv.exe") || paths.uv_executable.ends_with("uv"));
        assert!(
            paths.uv_executable.contains("\\Scripts\\") || paths.uv_executable.contains("/bin/")
        );
    }

    #[test]
    fn custom_core_dir_overrides_managed_source_path() {
        let temp = std::env::temp_dir().join("gsdesk-path-test");
        let custom = temp.join("custom-core");
        let settings = Settings {
            custom_core_dir: custom.to_string_lossy().to_string(),
            ..Settings::default()
        };

        let (_, paths) = build_paths_with_settings(&temp, &settings).unwrap();

        assert_eq!(paths.core_dir, custom.to_string_lossy().to_string());
        assert!(paths.venv_dir.contains("venvs"));
    }

    #[test]
    fn relative_custom_core_dir_is_resolved_under_app_data() {
        let temp = std::env::temp_dir().join("gsdesk-path-test");
        let settings =
            Settings { custom_core_dir: "local-core".to_string(), ..Settings::default() };

        let (_, paths) = build_paths_with_settings(&temp, &settings).unwrap();

        assert_eq!(paths.core_dir, temp.join("local-core").to_string_lossy().to_string());
    }
}
