use std::fs::{self, File};
use std::io::{self, Cursor};
use std::path::{Path, PathBuf};
use std::time::Duration;

use reqwest::blocking::{Client, ClientBuilder};
use reqwest::Proxy;
use tauri::{AppHandle, Manager};
use zip::ZipArchive;

use crate::models::{AppPaths, Settings, ToolchainInfo};
use crate::paths::uv_executable_name;
use crate::process::run_command_timeout;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ArchiveKind {
    Zip,
    TarGz,
}

#[derive(Debug, Clone, Copy)]
struct UvAsset {
    url: &'static str,
    kind: ArchiveKind,
}

pub fn uv_status(app: &AppHandle, paths: &AppPaths) -> ToolchainInfo {
    let target = PathBuf::from(&paths.uv_executable);
    let asset = uv_asset();
    match resolve_uv(app, paths) {
        Some(found) => ToolchainInfo {
            uv_detected: true,
            uv_path: Some(found.program.clone()),
            uv_source: found.source,
            uv_version: Some(found.version),
            uv_bootstrap_supported: asset.is_some(),
            uv_bootstrap_target: target.to_string_lossy().to_string(),
            uv_bootstrap_url: asset.map(|asset| asset.url.to_string()),
            uv_error: None,
        },
        None => ToolchainInfo {
            uv_detected: false,
            uv_path: None,
            uv_source: "missing".to_string(),
            uv_version: None,
            uv_bootstrap_supported: asset.is_some(),
            uv_bootstrap_target: target.to_string_lossy().to_string(),
            uv_bootstrap_url: asset.map(|asset| asset.url.to_string()),
            uv_error: Some("未检测到 uv；可安装到 GSDesk 隔离目录，不修改全局配置".to_string()),
        },
    }
}

pub fn uv_program(app: &AppHandle, paths: &AppPaths) -> Result<String, String> {
    resolve_uv(app, paths)
        .map(|found| found.program)
        .ok_or_else(|| {
            format!(
                "未检测到 uv。请在环境页安装到隔离目录，目标路径: {}",
                paths.uv_executable
            )
        })
}

pub fn bootstrap_uv<F>(
    app: &AppHandle,
    paths: &AppPaths,
    settings: &Settings,
    mut progress: F,
) -> Result<ToolchainInfo, String>
where
    F: FnMut(&str, &str),
{
    let target = PathBuf::from(&paths.uv_executable);
    if target.exists() {
        if let Some(version) = command_version(&target.to_string_lossy()) {
            return Ok(ToolchainInfo {
                uv_detected: true,
                uv_path: Some(target.to_string_lossy().to_string()),
                uv_source: "runtime".to_string(),
                uv_version: Some(version),
                uv_bootstrap_supported: uv_asset().is_some(),
                uv_bootstrap_target: target.to_string_lossy().to_string(),
                uv_bootstrap_url: uv_asset().map(|asset| asset.url.to_string()),
                uv_error: None,
            });
        }
        fs::remove_file(&target)
            .map_err(|error| format!("删除损坏 uv 可执行文件失败 {}: {error}", target.display()))?;
    }

    let asset = uv_asset().ok_or_else(|| {
        format!(
            "当前平台暂不支持自动安装 uv: {} / {}",
            std::env::consts::OS,
            std::env::consts::ARCH
        )
    })?;
    let target_dir = target
        .parent()
        .ok_or_else(|| "uv 目标路径缺少父目录".to_string())?;
    fs::create_dir_all(target_dir)
        .map_err(|error| format!("创建 uv 工具目录失败 {}: {error}", target_dir.display()))?;

    progress("download", "正在下载 uv 发行包");
    let bytes = http_client(settings)?
        .get(asset.url)
        .send()
        .and_then(|response| response.error_for_status())
        .map_err(|error| format!("下载 uv 失败: {error}"))?
        .bytes()
        .map_err(|error| format!("读取 uv 下载内容失败: {error}"))?;

    progress("extract", "正在解压 uv 到隔离目录");
    match asset.kind {
        ArchiveKind::Zip => extract_uv_zip(&bytes, &target)?,
        ArchiveKind::TarGz => extract_uv_targz(&bytes, target_dir, &target)?,
    }

    progress("verify", "正在验证 uv");
    command_version(&target.to_string_lossy())
        .ok_or_else(|| format!("uv 已解压但无法执行: {}", target.display()))?;
    Ok(uv_status(app, paths))
}

#[derive(Debug)]
struct FoundUv {
    program: String,
    source: String,
    version: String,
}

fn resolve_uv(app: &AppHandle, paths: &AppPaths) -> Option<FoundUv> {
    for (source, program) in uv_candidates(app, paths) {
        if program != PathBuf::from("uv") && !program.exists() {
            continue;
        }
        let program = program.to_string_lossy().to_string();
        if let Some(version) = command_version(&program) {
            return Some(FoundUv {
                program,
                source,
                version,
            });
        }
    }
    None
}

fn uv_candidates(app: &AppHandle, paths: &AppPaths) -> Vec<(String, PathBuf)> {
    let mut candidates = vec![("runtime".to_string(), PathBuf::from(&paths.uv_executable))];
    if let Ok(resource_dir) = app.path().resource_dir() {
        for path in [
            resource_dir.join("bin").join(uv_executable_name()),
            resource_dir.join("uv").join(uv_executable_name()),
            resource_dir.join(uv_executable_name()),
        ] {
            candidates.push(("bundle".to_string(), path));
        }
    }
    candidates.push(("path".to_string(), PathBuf::from("uv")));
    candidates
}

fn command_version(program: &str) -> Option<String> {
    let output =
        run_command_timeout(program, &["--version"], None, &[], Duration::from_secs(8)).ok()?;
    if !output.success {
        return None;
    }
    let raw = if output.stdout.trim().is_empty() {
        output.stderr.trim()
    } else {
        output.stdout.trim()
    };
    raw.lines()
        .next()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
}

fn http_client(settings: &Settings) -> Result<Client, String> {
    let mut builder = Client::builder()
        .timeout(Duration::from_secs(180))
        .user_agent("GSDesk/0.1 uv-bootstrap");
    builder = add_proxy(builder, "http", &settings.proxy.http_proxy)?;
    builder = add_proxy(builder, "https", &settings.proxy.https_proxy)?;
    if !settings.proxy.all_proxy.trim().is_empty() {
        builder = builder.proxy(
            Proxy::all(settings.proxy.all_proxy.trim())
                .map_err(|error| format!("ALL_PROXY 无效: {error}"))?,
        );
    }
    builder
        .build()
        .map_err(|error| format!("创建 uv 下载客户端失败: {error}"))
}

fn add_proxy(builder: ClientBuilder, scheme: &str, value: &str) -> Result<ClientBuilder, String> {
    let value = value.trim();
    if value.is_empty() {
        return Ok(builder);
    }
    let proxy = match scheme {
        "http" => Proxy::http(value).map_err(|error| format!("HTTP_PROXY 无效: {error}"))?,
        "https" => Proxy::https(value).map_err(|error| format!("HTTPS_PROXY 无效: {error}"))?,
        _ => return Ok(builder),
    };
    Ok(builder.proxy(proxy))
}

fn extract_uv_zip(bytes: &[u8], target: &Path) -> Result<(), String> {
    let mut archive = ZipArchive::new(Cursor::new(bytes))
        .map_err(|error| format!("读取 uv zip 失败: {error}"))?;
    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|error| format!("读取 uv zip 条目失败: {error}"))?;
        let Some(path) = file.enclosed_name().map(PathBuf::from) else {
            continue;
        };
        if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case(uv_executable_name()))
        {
            let mut output = File::create(target)
                .map_err(|error| format!("创建 uv 可执行文件失败 {}: {error}", target.display()))?;
            io::copy(&mut file, &mut output)
                .map_err(|error| format!("写入 uv 可执行文件失败 {}: {error}", target.display()))?;
            return Ok(());
        }
    }
    Err("uv zip 中未找到 uv 可执行文件".to_string())
}

fn extract_uv_targz(bytes: &[u8], target_dir: &Path, target: &Path) -> Result<(), String> {
    let archive_path = target_dir.join("uv-download.tar.gz");
    fs::write(&archive_path, bytes)
        .map_err(|error| format!("写入 uv 临时压缩包失败 {}: {error}", archive_path.display()))?;
    let archive_arg = archive_path.to_string_lossy().to_string();
    let dir_arg = target_dir.to_string_lossy().to_string();
    let output = run_command_timeout(
        "tar",
        &["-xzf", archive_arg.as_str(), "-C", dir_arg.as_str()],
        None,
        &[],
        Duration::from_secs(60),
    )?;
    let _ = fs::remove_file(&archive_path);
    if !output.success {
        return Err(format!("解压 uv 失败: {}", output.stderr.trim()));
    }
    let extracted =
        find_uv_binary(target_dir).ok_or_else(|| "uv tar.gz 中未找到 uv 可执行文件".to_string())?;
    if extracted != target {
        fs::copy(&extracted, target).map_err(|error| {
            format!(
                "复制 uv 可执行文件失败 {} -> {}: {error}",
                extracted.display(),
                target.display()
            )
        })?;
    }
    make_executable(target)?;
    Ok(())
}

fn find_uv_binary(dir: &Path) -> Option<PathBuf> {
    for entry in fs::read_dir(dir).ok()? {
        let entry = entry.ok()?;
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_uv_binary(&path) {
                return Some(found);
            }
        } else if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name == uv_executable_name())
        {
            return Some(path);
        }
    }
    None
}

#[cfg(unix)]
fn make_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = fs::metadata(path)
        .map_err(|error| format!("读取 uv 权限失败 {}: {error}", path.display()))?
        .permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions)
        .map_err(|error| format!("设置 uv 可执行权限失败 {}: {error}", path.display()))
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn uv_asset() -> Option<UvAsset> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => Some(UvAsset {
            url: "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip",
            kind: ArchiveKind::Zip,
        }),
        ("windows", "aarch64") => Some(UvAsset {
            url: "https://github.com/astral-sh/uv/releases/latest/download/uv-aarch64-pc-windows-msvc.zip",
            kind: ArchiveKind::Zip,
        }),
        ("macos", "x86_64") => Some(UvAsset {
            url: "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-apple-darwin.tar.gz",
            kind: ArchiveKind::TarGz,
        }),
        ("macos", "aarch64") => Some(UvAsset {
            url: "https://github.com/astral-sh/uv/releases/latest/download/uv-aarch64-apple-darwin.tar.gz",
            kind: ArchiveKind::TarGz,
        }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supported_desktop_targets_have_uv_asset() {
        if matches!(std::env::consts::OS, "windows" | "macos") {
            let asset = uv_asset().expect("windows and macOS should have uv assets");
            assert!(asset.url.contains("astral-sh/uv"));
        }
    }
}
