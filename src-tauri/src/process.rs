use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use wait_timeout::ChildExt;

pub const PYTHON_IO_ENCODING: &str = "utf-8:replace";
pub const LEGACY_WINDOWS_STDIO_ENV: &str = "PYTHONLEGACYWINDOWSSTDIO";

pub struct CommandOutput {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    pub elapsed_ms: u128,
}

#[cfg(test)]
pub fn command_exists(command: &str) -> bool {
    let mut probe = Command::new(command);
    apply_default_child_env(&mut probe);
    probe
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

pub fn run_command_timeout(
    program: &str,
    args: &[&str],
    cwd: Option<&Path>,
    envs: &[(String, String)],
    timeout: Duration,
) -> Result<CommandOutput, String> {
    let started = Instant::now();
    let mut command = Command::new(program);
    apply_default_child_env(&mut command);
    command.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    for (key, value) in envs {
        command.env(key, value);
    }
    command.env_remove(LEGACY_WINDOWS_STDIO_ENV);
    let mut child = command.spawn().map_err(|error| format!("执行命令失败 {program}: {error}"))?;
    let status = match child
        .wait_timeout(timeout)
        .map_err(|error| format!("等待命令失败 {program}: {error}"))?
    {
        Some(status) => status,
        None => {
            let _ = child.kill();
            let output = child
                .wait_with_output()
                .map_err(|error| format!("读取超时命令输出失败 {program}: {error}"))?;
            return Ok(CommandOutput {
                success: false,
                stdout: String::from_utf8_lossy(&output.stdout).to_string(),
                stderr: format!(
                    "命令超时: {program} {}\n{}",
                    args.join(" "),
                    String::from_utf8_lossy(&output.stderr)
                ),
                elapsed_ms: started.elapsed().as_millis(),
            });
        }
    };
    let output =
        child.wait_with_output().map_err(|error| format!("读取命令输出失败 {program}: {error}"))?;
    Ok(CommandOutput {
        success: status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        elapsed_ms: started.elapsed().as_millis(),
    })
}

pub fn apply_default_child_env(command: &mut Command) {
    command
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", PYTHON_IO_ENCODING)
        .env("PYTHONUNBUFFERED", "1")
        .env("UV_NO_PROGRESS", "1")
        .env("NO_COLOR", "1")
        .env("FORCE_COLOR", "0")
        .env("CLICOLOR", "0")
        .env("TERM", "dumb")
        .env_remove(LEGACY_WINDOWS_STDIO_ENV);
}

pub fn process_memory_bytes(pid: u32) -> Option<u64> {
    if pid == 0 {
        return None;
    }
    if cfg!(windows) {
        return windows_process_memory_bytes(pid);
    }
    unix_process_memory_bytes(pid)
}

fn windows_process_memory_bytes(pid: u32) -> Option<u64> {
    let script = format!(
        "$process = Get-Process -Id {pid} -ErrorAction SilentlyContinue; \
         if ($process) {{ [int64]$process.WorkingSet64 }}"
    );
    let output = run_command_timeout(
        "powershell",
        &["-NoProfile", "-Command", &script],
        None,
        &[],
        Duration::from_secs(5),
    )
    .ok()?;
    if !output.success {
        return None;
    }
    output.stdout.trim().parse::<u64>().ok()
}

fn unix_process_memory_bytes(pid: u32) -> Option<u64> {
    let pid_arg = pid.to_string();
    let output = run_command_timeout(
        "ps",
        &["-o", "rss=", "-p", &pid_arg],
        None,
        &[],
        Duration::from_secs(5),
    )
    .ok()?;
    if !output.success {
        return None;
    }
    output.stdout.trim().parse::<u64>().ok().map(|kb| kb * 1024)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_common_command() {
        assert!(command_exists("git") || command_exists("cmd"));
    }

    #[test]
    fn default_child_env_forces_python_utf8() {
        let mut command = Command::new("dummy");
        apply_default_child_env(&mut command);
        let envs = command.get_envs().collect::<Vec<_>>();
        assert!(envs.iter().any(|(key, value)| {
            key.to_string_lossy() == "PYTHONUTF8" && value.is_some_and(|value| value == "1")
        }));
        assert!(envs.iter().any(|(key, value)| {
            key.to_string_lossy() == "PYTHONIOENCODING"
                && value.is_some_and(|value| value == PYTHON_IO_ENCODING)
        }));
        assert!(envs.iter().any(|(key, value)| {
            key.to_string_lossy() == LEGACY_WINDOWS_STDIO_ENV && value.is_none()
        }));
        assert!(envs.iter().any(|(key, value)| {
            key.to_string_lossy() == "FORCE_COLOR" && value.is_some_and(|value| value == "0")
        }));
    }
}
