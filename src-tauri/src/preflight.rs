use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::models::{AppPaths, PreflightCheck, Settings, ToolchainInfo};
use crate::process::run_command_timeout;
use crate::service::service_port_available;

pub fn run(
    settings: &Settings,
    paths: &AppPaths,
    toolchain: &ToolchainInfo,
) -> Vec<PreflightCheck> {
    let mut checks = Vec::new();
    checks.push(check_os_arch());
    checks.push(tool_check("git", "Git", "安装 Git 后重新检测"));
    checks.push(uv_check(toolchain));
    checks.push(check_port(settings));
    checks.push(check_write_permission(&paths.app_data));
    checks.push(check_disk_space(&paths.app_data));
    checks.push(check_core_repo(&paths.core_dir));
    checks.push(check_venv(&paths.venv_dir));
    checks.push(check_source_settings(settings));
    checks.push(check_pypi_settings(settings));
    checks
}

fn ok(id: &str, label: &str, detail: impl Into<String>) -> PreflightCheck {
    PreflightCheck {
        id: id.to_string(),
        label: label.to_string(),
        status: "ok".to_string(),
        detail: detail.into(),
        action: None,
    }
}

fn warn(
    id: &str,
    label: &str,
    detail: impl Into<String>,
    action: impl Into<String>,
) -> PreflightCheck {
    PreflightCheck {
        id: id.to_string(),
        label: label.to_string(),
        status: "warn".to_string(),
        detail: detail.into(),
        action: Some(action.into()),
    }
}

fn block(
    id: &str,
    label: &str,
    detail: impl Into<String>,
    action: impl Into<String>,
) -> PreflightCheck {
    PreflightCheck {
        id: id.to_string(),
        label: label.to_string(),
        status: "block".to_string(),
        detail: detail.into(),
        action: Some(action.into()),
    }
}

fn check_os_arch() -> PreflightCheck {
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    if matches!(os, "windows" | "macos") {
        ok("os", "系统", format!("{os} / {arch}"))
    } else {
        block(
            "os",
            "系统",
            format!("当前系统 {os} / {arch} 不在 v1 支持范围"),
            "使用 Windows 或 macOS",
        )
    }
}

fn tool_check(command: &str, label: &str, action: &str) -> PreflightCheck {
    match command_version(command) {
        Some(version) => ok(command, label, format!("{label} 可用: {version}")),
        None => block(command, label, format!("未检测到 {label}"), action),
    }
}

fn uv_check(toolchain: &ToolchainInfo) -> PreflightCheck {
    let Some(version) = toolchain.uv_version.as_ref() else {
        return block(
            "uv",
            "uv",
            "未检测到 uv",
            if toolchain.uv_bootstrap_supported {
                "点击“安装/修复 uv”，安装到 GSDesk 隔离目录"
            } else {
                "当前平台暂不支持自动安装 uv，请手动安装后重新检测"
            },
        );
    };
    if let Some(number) = version
        .split_whitespace()
        .find(|part| part.starts_with(|ch: char| ch.is_ascii_digit()))
    {
        if semver_less_than(number, (0, 5, 0)) {
            return warn(
                "uv",
                "uv",
                format!("uv 版本偏旧: {version}"),
                "点击“安装/修复 uv”更新隔离目录内的 uv",
            );
        }
    }
    ok(
        "uv",
        "uv",
        format!("uv 可用: {version} ({})", toolchain.uv_source),
    )
}

fn command_version(command: &str) -> Option<String> {
    let output =
        run_command_timeout(command, &["--version"], None, &[], Duration::from_secs(5)).ok()?;
    if !output.success {
        return None;
    }
    let version = if output.stdout.trim().is_empty() {
        output.stderr.trim()
    } else {
        output.stdout.trim()
    };
    if version.is_empty() {
        None
    } else {
        Some(version.lines().next().unwrap_or(version).to_string())
    }
}

fn semver_less_than(value: &str, minimum: (u64, u64, u64)) -> bool {
    let mut parts = value
        .split(['.', '-'])
        .filter_map(|part| part.parse::<u64>().ok());
    let version = (
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
    );
    version < minimum
}

fn check_port(settings: &Settings) -> PreflightCheck {
    if let Some(port) = settings.preferred_core_port {
        return check_fixed_port(port);
    }

    let port = 8765;
    if service_port_available(port) {
        ok("port", "默认端口", format!("{port} 可用"))
    } else {
        let occupant = port_occupant_summary(port)
            .map(|summary| format!("，占用信息: {summary}"))
            .unwrap_or_default();
        warn(
            "port",
            "默认端口",
            format!("{port} 已被占用{occupant}，启动时会自动选择 8766-8865"),
            "关闭占用进程或使用自动端口",
        )
    }
}

fn check_fixed_port(port: u16) -> PreflightCheck {
    if !(1024..=65535).contains(&port) {
        return block(
            "port",
            "固定端口",
            format!("{port} 不在允许范围 1024-65535"),
            "清空固定端口改为自动，或填写 1024-65535 之间的端口",
        );
    }
    if service_port_available(port) {
        ok("port", "固定端口", format!("{port} 可用"))
    } else {
        let occupant = port_occupant_summary(port)
            .map(|summary| format!("，占用信息: {summary}"))
            .unwrap_or_default();
        block(
            "port",
            "固定端口",
            format!("{port} 已被占用{occupant}，固定端口模式不会自动切换"),
            "关闭占用进程，或清空固定端口改回自动选择",
        )
    }
}

fn port_occupant_summary(port: u16) -> Option<String> {
    if cfg!(windows) {
        let output = run_command_timeout(
            "powershell",
            &[
                "-NoProfile",
                "-Command",
                &format!(
                    "$c=Get-NetTCPConnection -LocalPort {port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) {{ $p=Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue; if ($p) {{ \"$($c.OwningProcess) $($p.ProcessName)\" }} else {{ \"$($c.OwningProcess)\" }} }}"
                ),
            ],
            None,
            &[],
            Duration::from_secs(5),
        )
        .ok()?;
        let summary = output.stdout.trim();
        if summary.is_empty() {
            None
        } else {
            Some(summary.to_string())
        }
    } else {
        let output = run_command_timeout(
            "sh",
            &["-c", &format!("lsof -nP -iTCP:{port} -sTCP:LISTEN -Fp -c 2>/dev/null | head -n 2 | paste -sd ' ' -")],
            None,
            &[],
            Duration::from_secs(5),
        )
        .ok()?;
        let summary = output.stdout.trim();
        if summary.is_empty() {
            None
        } else {
            Some(summary.to_string())
        }
    }
}

fn check_write_permission(app_data: &str) -> PreflightCheck {
    let dir = PathBuf::from(app_data);
    let probe = dir.join(".gsdesk-write-test");
    match fs::write(&probe, b"ok").and_then(|_| fs::remove_file(&probe)) {
        Ok(_) => ok("permission", "目录权限", "应用数据目录可写"),
        Err(error) => block(
            "permission",
            "目录权限",
            format!("应用数据目录不可写: {error}"),
            "检查目录权限或换用可写用户目录",
        ),
    }
}

fn check_disk_space(app_data: &str) -> PreflightCheck {
    match free_space_bytes(Path::new(app_data)) {
        Some(bytes) if bytes >= 2 * 1024 * 1024 * 1024 => {
            ok("disk", "磁盘空间", format!("剩余 {}", format_bytes(bytes)))
        }
        Some(bytes) => warn(
            "disk",
            "磁盘空间",
            format!("剩余 {}，初始化依赖可能失败", format_bytes(bytes)),
            "清理磁盘，至少预留 2GB",
        ),
        None => warn(
            "disk",
            "磁盘空间",
            "无法自动读取剩余空间",
            "确认应用数据目录所在磁盘至少有 2GB 可用空间",
        ),
    }
}

fn check_core_repo(core_dir: &str) -> PreflightCheck {
    let dir = PathBuf::from(core_dir);
    if dir.join(".git").exists() && dir.join("pyproject.toml").exists() {
        ok("core_repo", "Core 源码", "已检测到 gsuid_core 仓库")
    } else if dir.exists() {
        warn(
            "core_repo",
            "Core 源码",
            "Core 目录存在但缺少 .git 或 pyproject.toml",
            "在环境与修复中重新初始化运行时",
        )
    } else {
        warn(
            "core_repo",
            "Core 源码",
            "尚未初始化 Core 源码",
            "运行首次安装引导",
        )
    }
}

fn check_venv(venv_dir: &str) -> PreflightCheck {
    let dir = PathBuf::from(venv_dir);
    let python = if cfg!(windows) {
        dir.join("Scripts").join("python.exe")
    } else {
        dir.join("bin").join("python")
    };
    if dir.join("pyvenv.cfg").exists() && python.exists() {
        ok("venv", "Python 虚拟环境", "venv 已创建")
    } else {
        warn(
            "venv",
            "Python 虚拟环境",
            "venv 不完整或尚未创建",
            "重跑 uv sync 或重建 venv",
        )
    }
}

fn check_source_settings(settings: &Settings) -> PreflightCheck {
    if settings.selected_source.contains("github.com")
        || settings.selected_source.contains("cnb.cool")
    {
        ok("source", "源码源", settings.selected_source.clone())
    } else {
        warn(
            "source",
            "源码源",
            "源码源不是已知 GitHub/CNB 地址",
            "重新探测源码源或手动修正",
        )
    }
}

fn check_pypi_settings(settings: &Settings) -> PreflightCheck {
    if !matches!(settings.pypi_index_mode.as_str(), "auto" | "manual") {
        return warn(
            "pypi",
            "PyPI 镜像",
            format!(
                "未知镜像策略 {}，将按自动策略处理",
                settings.pypi_index_mode
            ),
            "在网络与设置里选择自动或手动锁定",
        );
    }
    if settings.pypi_index_url.starts_with("https://") && settings.pypi_index_url.ends_with('/') {
        ok(
            "pypi",
            "PyPI 镜像",
            format!("{} / {}", settings.pypi_index_mode, settings.pypi_index_url),
        )
    } else {
        warn(
            "pypi",
            "PyPI 镜像",
            "PyPI 镜像地址建议使用 https:// 并以 / 结尾",
            "重新测速镜像或手动修正",
        )
    }
}

pub(crate) fn free_space_bytes(path: &Path) -> Option<u64> {
    if cfg!(windows) {
        let drive = path.components().next()?.as_os_str().to_string_lossy();
        let drive = drive.trim_end_matches('\\').trim_end_matches(':');
        let output = run_command_timeout(
            "powershell",
            &[
                "-NoProfile",
                "-Command",
                &format!("(Get-PSDrive -Name '{}').Free", drive.replace('\'', "''")),
            ],
            None,
            &[],
            Duration::from_secs(5),
        )
        .ok()?;
        output.stdout.trim().parse::<u64>().ok()
    } else {
        let path_arg = path.to_string_lossy().to_string();
        let output = run_command_timeout(
            "df",
            &["-Pk", path_arg.as_str()],
            None,
            &[],
            Duration::from_secs(5),
        )
        .ok()?;
        output
            .stdout
            .lines()
            .nth(1)
            .and_then(|line| line.split_whitespace().nth(3))
            .and_then(|kb| kb.parse::<u64>().ok())
            .map(|kb| kb * 1024)
    }
}

pub(crate) fn format_bytes(bytes: u64) -> String {
    let gib = bytes as f64 / 1024.0 / 1024.0 / 1024.0;
    format!("{gib:.1} GB")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preflight_reports_required_checks() {
        let temp = std::env::temp_dir().join("gsdesk-preflight-test");
        fs::create_dir_all(&temp).unwrap();
        let paths = AppPaths {
            app_data: temp.to_string_lossy().to_string(),
            runtime: "runtime".into(),
            tools_dir: "tools".into(),
            core_dir: temp.join("core").to_string_lossy().to_string(),
            venv_dir: temp.join("venv").to_string_lossy().to_string(),
            uv_cache_dir: "cache".into(),
            uv_python_dir: "py".into(),
            uv_executable: "tools/uv/uv".into(),
            logs_dir: "logs".into(),
            diagnostics_dir: "diagnostics".into(),
            backups_dir: "backups".into(),
            settings_file: "settings.json".into(),
        };
        let settings = Settings {
            source_mode: "auto".into(),
            selected_source: "https://github.com/Genshin-bots/gsuid_core.git".into(),
            pypi_index_url: "https://pypi.org/simple/".into(),
            ..Settings::default()
        };

        let toolchain = ToolchainInfo {
            uv_detected: true,
            uv_path: Some("uv".into()),
            uv_source: "path".into(),
            uv_version: Some("uv 0.9.8".into()),
            uv_bootstrap_supported: true,
            uv_bootstrap_target: "tools/uv/uv".into(),
            uv_bootstrap_url: Some("https://github.com/astral-sh/uv".into()),
            uv_error: None,
        };

        let checks = run(&settings, &paths, &toolchain);
        assert!(checks.iter().any(|check| check.id == "git"));
        assert!(checks
            .iter()
            .any(|check| check.id == "permission" && check.status == "ok"));
        assert!(checks.iter().any(|check| check.id == "core_repo"));

        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn compares_uv_versions_for_upgrade_warning() {
        assert!(semver_less_than("0.4.30", (0, 5, 0)));
        assert!(!semver_less_than("0.5.0", (0, 5, 0)));
        assert!(!semver_less_than("0.9.8", (0, 5, 0)));
    }

    #[test]
    fn fixed_port_conflict_is_a_blocking_preflight_issue() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();

        let mut settings = Settings::default();
        settings.preferred_core_port = Some(port);
        let check = check_port(&settings);

        assert_eq!(check.id, "port");
        assert_eq!(check.label, "固定端口");
        assert_eq!(check.status, "block");
        assert!(check.detail.contains("固定端口模式不会自动切换"));
    }
}
