use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::models::{AppPaths, Settings, ToolchainInfo};
use crate::paths::uv_scripts_dir_name;
use crate::process::run_command_timeout;
use crate::settings::env_from_settings;

const PYTHON_TARGET: &str = "3.12";
const UV_PIP_PACKAGE: &str = "uv";

#[derive(Debug, Clone)]
pub struct PythonRuntimeResult {
    pub source: String,
    pub python: String,
}

pub fn uv_status(app: &AppHandle, paths: &AppPaths) -> ToolchainInfo {
    let target = PathBuf::from(&paths.uv_executable);
    let bundled_python =
        bundled_python_resource_dir(app).filter(|dir| find_python_binary(dir).is_some());
    let uv_bootstrap_supported = bundled_python.is_some();
    let uv = resolve_uv(app, paths);
    let git = resolve_git(app, paths);
    let playwright_browsers_path = paths.playwright_browsers_dir.clone();
    let playwright_detected = playwright_browsers_installed(&playwright_browsers_path);
    let bundled_python_path =
        bundled_python.as_ref().map(|path| path.to_string_lossy().to_string());
    let bundled_git_path =
        bundled_git_resource_program(app).map(|path| path.to_string_lossy().to_string());

    ToolchainInfo {
        uv_detected: uv.is_some(),
        uv_path: uv.as_ref().map(|found| found.program.clone()),
        uv_source: uv
            .as_ref()
            .map(|found| found.source.clone())
            .unwrap_or_else(|| "missing".to_string()),
        uv_version: uv.as_ref().map(|found| found.version.clone()),
        uv_bootstrap_supported,
        uv_bootstrap_target: target.to_string_lossy().to_string(),
        uv_bootstrap_url: None,
        bundled_python_available: bundled_python.is_some(),
        bundled_python_path,
        uv_error: uv
            .is_none()
            .then(|| "未检测到 GSDesk 隔离 uv；可使用内置 Python 创建，不修改系统环境".to_string()),
        playwright_detected,
        playwright_browsers_path: playwright_browsers_path.clone(),
        playwright_error: (!playwright_detected)
            .then(|| format!("未安装 Playwright 浏览器，目标路径: {playwright_browsers_path}")),
        git_detected: git.is_some(),
        git_path: git.as_ref().map(|found| found.program.clone()),
        git_source: git
            .as_ref()
            .map(|found| found.source.clone())
            .unwrap_or_else(|| "missing".to_string()),
        git_version: git.as_ref().map(|found| found.version.clone()),
        bundled_git_available: bundled_git_path.is_some(),
        git_error: git.is_none().then(|| git_missing_message(bundled_git_path.as_deref())),
        bundled_git_path,
    }
}

fn playwright_browsers_installed(path: &str) -> bool {
    let dir = Path::new(path);
    fs::read_dir(dir)
        .ok()
        .map(|entries| {
            entries.filter_map(Result::ok).any(|entry| {
                let path = entry.path();
                path.is_dir()
                    && path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name.starts_with("chromium-"))
            })
        })
        .unwrap_or(false)
}

pub fn uv_program(app: &AppHandle, paths: &AppPaths) -> Result<String, String> {
    resolve_uv(app, paths).map(|found| found.program).ok_or_else(|| {
        format!("未检测到 uv。请在环境页安装到隔离目录，目标路径: {}", paths.uv_executable)
    })
}

pub fn git_program(app: &AppHandle, paths: &AppPaths) -> Result<String, String> {
    resolve_git(app, paths).map(|found| found.program).ok_or_else(|| {
        let bundled_git_path =
            bundled_git_resource_program(app).map(|path| path.to_string_lossy().to_string());
        git_missing_message(bundled_git_path.as_deref())
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
    let source_python = bundled_python_binary(app)?;
    let target_root = uv_tool_root(&target)?;
    let runtime = PathBuf::from(&paths.runtime);
    let envs = python_bootstrap_env(settings, paths);

    progress("prepare", "正在清理旧 uv 隔离环境");
    reset_runtime_dir(&target_root, &runtime)?;

    progress("venv", "正在使用内置 Python 创建 uv 隔离环境");
    let target_root_arg = target_root.to_string_lossy().to_string();
    run_python_step(
        &source_python,
        &["-m", "venv", target_root_arg.as_str()],
        &envs,
        Duration::from_secs(120),
        "创建 uv 隔离环境失败",
    )?;

    let venv_python = find_python_binary(&target_root).ok_or_else(|| {
        format!("uv 隔离环境创建完成，但未找到 Python: {}", target_root.display())
    })?;
    make_executable(&venv_python)?;

    progress("pip", "正在初始化内置 pip");
    run_python_step(
        &venv_python,
        &["-m", "ensurepip", "--upgrade"],
        &envs,
        Duration::from_secs(120),
        "初始化内置 pip 失败",
    )?;

    progress("install", "正在通过内置 Python 更新 uv");
    run_python_step(
        &venv_python,
        &["-m", "pip", "install", "--upgrade", UV_PIP_PACKAGE],
        &envs,
        Duration::from_secs(240),
        "安装或更新 uv 失败",
    )?;

    if !target.exists() {
        return Err(format!("uv 安装完成但未找到可执行文件: {}", target.display()));
    }
    make_executable(&target)?;
    progress("verify", "正在验证隔离 uv");
    command_version(&target.to_string_lossy())
        .ok_or_else(|| format!("隔离 uv 已安装但无法执行: {}", target.display()))?;
    Ok(uv_status(app, paths))
}

pub fn ensure_python_runtime<F>(
    app: &AppHandle,
    paths: &AppPaths,
    uv_program: &str,
    envs: &[(String, String)],
    mut progress: F,
) -> Result<PythonRuntimeResult, String>
where
    F: FnMut(&str, &str),
{
    if let Some(python) = find_managed_python(uv_program, paths, envs) {
        return Ok(PythonRuntimeResult { source: "runtime".to_string(), python });
    }

    let source = bundled_python_resource_dir(app).ok_or_else(|| {
        "安装包未包含内置 Python 资源目录，无法离线初始化 Python 3.12".to_string()
    })?;
    let source_python = find_python_binary(&source).ok_or_else(|| {
        format!(
            "安装包内置 Python 不完整，未找到 Python 可执行文件。资源目录: {}",
            source.display()
        )
    })?;
    let target = PathBuf::from(&paths.uv_python_dir);
    let runtime = PathBuf::from(&paths.runtime);

    progress("python", "正在复制安装包内置 CPython 3.12");
    reset_runtime_dir(&target, &runtime)?;
    copy_dir_contents(&source, &target)?;
    if let Some(target_python) = find_python_binary(&target) {
        make_executable(&target_python)?;
    }

    progress("verify", "正在校验内置 CPython 3.12");
    find_managed_python(uv_program, paths, envs).map_or_else(
        || {
            Err(format!(
                "内置 Python 已复制但 uv 无法识别 Python 3.12。源: {}，示例可执行文件: {}",
                source.display(),
                source_python.display()
            ))
        },
        |python| Ok(PythonRuntimeResult { source: "bundle".to_string(), python }),
    )
}

fn bundled_python_binary(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = bundled_python_resource_dir(app)
        .ok_or_else(|| "当前构建未包含内置 Python，无法创建或更新 GSDesk 隔离 uv".to_string())?;
    find_python_binary(&dir).ok_or_else(|| {
        format!("当前构建内置 Python 不完整，未找到 Python 可执行文件: {}", dir.display())
    })
}

#[derive(Debug, Clone)]
struct FoundCommand {
    program: String,
    source: String,
    version: String,
}

#[derive(Debug)]
struct CommandCandidate {
    source: String,
    program: String,
    requires_existing_file: bool,
}

fn resolve_uv(app: &AppHandle, paths: &AppPaths) -> Option<FoundCommand> {
    for (source, program) in uv_candidates(app, paths) {
        if !program.exists() {
            continue;
        }
        let program = program.to_string_lossy().to_string();
        if let Some(version) = command_version(&program) {
            return Some(FoundCommand { program, source, version });
        }
    }
    None
}

fn resolve_git(app: &AppHandle, paths: &AppPaths) -> Option<FoundCommand> {
    for candidate in git_candidates(app, paths) {
        if candidate.requires_existing_file && !Path::new(&candidate.program).exists() {
            continue;
        }
        if let Some(version) = command_version(&candidate.program) {
            return Some(FoundCommand {
                program: candidate.program,
                source: candidate.source,
                version,
            });
        }
    }
    None
}

fn uv_candidates(_app: &AppHandle, paths: &AppPaths) -> Vec<(String, PathBuf)> {
    vec![("runtime".to_string(), PathBuf::from(&paths.uv_executable))]
}

fn git_candidates(app: &AppHandle, paths: &AppPaths) -> Vec<CommandCandidate> {
    let runtime_git = PathBuf::from(&paths.tools_dir).join("git");
    let mut candidates = git_binary_candidates(&runtime_git)
        .into_iter()
        .map(|program| CommandCandidate {
            source: "runtime".to_string(),
            program: program.to_string_lossy().to_string(),
            requires_existing_file: true,
        })
        .collect::<Vec<_>>();

    if let Some(resource_git) = bundled_git_resource_dir(app) {
        candidates.extend(git_binary_candidates(&resource_git).into_iter().map(|program| {
            CommandCandidate {
                source: "bundle".to_string(),
                program: program.to_string_lossy().to_string(),
                requires_existing_file: true,
            }
        }));
    }

    candidates.push(CommandCandidate {
        source: "system".to_string(),
        program: "git".to_string(),
        requires_existing_file: false,
    });
    candidates
}

fn bundled_python_resource_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().resource_dir().ok()?.join("runtime-assets").join("python");
    dir.exists().then_some(dir)
}

fn bundled_git_resource_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().resource_dir().ok()?.join("runtime-assets").join("git");
    dir.exists().then_some(dir)
}

fn bundled_git_resource_program(app: &AppHandle) -> Option<PathBuf> {
    let dir = bundled_git_resource_dir(app)?;
    git_binary_candidates(&dir).into_iter().find(|path| path.exists())
}

fn git_binary_candidates(root: &Path) -> Vec<PathBuf> {
    if cfg!(windows) {
        return vec![
            root.join("cmd").join("git.exe"),
            root.join("bin").join("git.exe"),
            root.join("mingw64").join("bin").join("git.exe"),
            root.join("git.exe"),
        ];
    }
    vec![root.join("bin").join("git"), root.join("cmd").join("git"), root.join("git")]
}

fn git_missing_message(bundled_git_path: Option<&str>) -> String {
    match bundled_git_path {
        Some(path) => format!(
            "检测到内置 Git 但无法执行: {path}。请使用完整安装包重新安装，或在高级环境中安装系统 Git 后重试"
        ),
        None => "未检测到可用 Git。当前安装包缺少内置 Git，请使用完整安装包；高级用户也可以安装系统 Git 后重试"
            .to_string(),
    }
}

fn find_managed_python(
    uv_program: &str,
    paths: &AppPaths,
    envs: &[(String, String)],
) -> Option<String> {
    let merged_envs = python_install_env(paths, envs);
    let output = run_command_timeout(
        uv_program,
        &["python", "find", PYTHON_TARGET, "--managed-python"],
        None,
        &merged_envs,
        Duration::from_secs(30),
    )
    .ok()?;
    if !output.success {
        return None;
    }
    let raw =
        if output.stdout.trim().is_empty() { output.stderr.trim() } else { output.stdout.trim() };
    raw.lines()
        .next()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter(|line| Path::new(line).exists())
        .map(ToString::to_string)
}

fn python_install_env(paths: &AppPaths, envs: &[(String, String)]) -> Vec<(String, String)> {
    let mut merged = envs.to_vec();
    upsert_env(&mut merged, "UV_PYTHON_INSTALL_DIR", paths.uv_python_dir.clone());
    upsert_env(&mut merged, "UV_PYTHON_DOWNLOADS", "never".to_string());
    merged
}

fn python_bootstrap_env(settings: &Settings, paths: &AppPaths) -> Vec<(String, String)> {
    let mut envs = env_from_settings(settings);
    upsert_env(&mut envs, "PYTHONUTF8", "1".to_string());
    upsert_env(&mut envs, "PYTHONUNBUFFERED", "1".to_string());
    upsert_env(&mut envs, "PIP_DISABLE_PIP_VERSION_CHECK", "1".to_string());
    upsert_env(&mut envs, "PIP_NO_INPUT", "1".to_string());
    upsert_env(
        &mut envs,
        "PIP_CACHE_DIR",
        PathBuf::from(&paths.uv_cache_dir).join("pip").to_string_lossy().to_string(),
    );
    envs
}

fn upsert_env(envs: &mut Vec<(String, String)>, key: &str, value: String) {
    if let Some((_, existing)) = envs.iter_mut().find(|(name, _)| name == key) {
        *existing = value;
    } else {
        envs.push((key.to_string(), value));
    }
}

fn uv_tool_root(target: &Path) -> Result<PathBuf, String> {
    let parent = target.parent().ok_or_else(|| "uv 目标路径缺少父目录".to_string())?;
    if parent
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case(uv_scripts_dir_name()))
    {
        return parent
            .parent()
            .map(PathBuf::from)
            .ok_or_else(|| "uv 隔离环境路径缺少父目录".to_string());
    }
    Ok(parent.to_path_buf())
}

fn reset_runtime_dir(target: &Path, runtime: &Path) -> Result<(), String> {
    if !target.starts_with(runtime) {
        return Err(format!(
            "拒绝清理非 GSDesk 运行时目录: {} 不在 {} 下",
            target.display(),
            runtime.display()
        ));
    }
    fs::create_dir_all(target)
        .map_err(|error| format!("创建运行时目录失败 {}: {error}", target.display()))?;
    for entry in fs::read_dir(target)
        .map_err(|error| format!("读取运行时目录失败 {}: {error}", target.display()))?
    {
        let entry = entry.map_err(|error| format!("读取运行时目录条目失败: {error}"))?;
        let path = entry.path();
        if path.is_dir() {
            fs::remove_dir_all(&path)
                .map_err(|error| format!("清理旧运行时目录失败 {}: {error}", path.display()))?;
        } else {
            fs::remove_file(&path)
                .map_err(|error| format!("清理旧运行时文件失败 {}: {error}", path.display()))?;
        }
    }
    Ok(())
}

fn run_python_step(
    program: &Path,
    args: &[&str],
    envs: &[(String, String)],
    timeout: Duration,
    context: &str,
) -> Result<(), String> {
    let program = program.to_string_lossy().to_string();
    let output = run_command_timeout(&program, args, None, envs, timeout)?;
    if output.success {
        return Ok(());
    }
    Err(format!("{context}: {}\n{}", output.stderr.trim(), output.stdout.trim()))
}

fn copy_dir_contents(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target)
        .map_err(|error| format!("创建目录失败 {}: {error}", target.display()))?;
    for entry in fs::read_dir(source)
        .map_err(|error| format!("读取资源目录失败 {}: {error}", source.display()))?
    {
        let entry = entry.map_err(|error| format!("读取资源目录条目失败: {error}"))?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|error| format!("读取资源条目类型失败 {}: {error}", source_path.display()))?;
        if file_type.is_dir() {
            copy_dir_contents(&source_path, &target_path)?;
        } else if file_type.is_file() {
            fs::copy(&source_path, &target_path).map_err(|error| {
                format!(
                    "复制资源文件失败 {} -> {}: {error}",
                    source_path.display(),
                    target_path.display()
                )
            })?;
        }
    }
    Ok(())
}

fn find_python_binary(dir: &Path) -> Option<PathBuf> {
    let entries: Vec<_> = fs::read_dir(dir).ok()?.filter_map(Result::ok).collect();
    for entry in &entries {
        let path = entry.path();
        if path.file_name().and_then(|name| name.to_str()).is_some_and(is_python_name) {
            return Some(path);
        }
    }
    for entry in entries {
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_python_binary(&path) {
                return Some(found);
            }
        }
    }
    None
}

fn is_python_name(name: &str) -> bool {
    if cfg!(windows) {
        name.eq_ignore_ascii_case("python.exe")
    } else {
        name == "python" || name.starts_with("python3.")
    }
}

fn command_version(program: &str) -> Option<String> {
    let output =
        run_command_timeout(program, &["--version"], None, &[], Duration::from_secs(8)).ok()?;
    if !output.success {
        return None;
    }
    let raw =
        if output.stdout.trim().is_empty() { output.stderr.trim() } else { output.stdout.trim() };
    raw.lines().next().map(|line| line.trim().to_string()).filter(|line| !line.is_empty())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_binary_candidates_match_portable_git_layout() {
        let root = PathBuf::from("runtime-assets").join("git");
        let candidates = git_binary_candidates(&root);
        if cfg!(windows) {
            assert_eq!(candidates[0], root.join("cmd").join("git.exe"));
            assert!(candidates.contains(&root.join("mingw64").join("bin").join("git.exe")));
        } else {
            assert_eq!(candidates[0], root.join("bin").join("git"));
        }
    }
}
