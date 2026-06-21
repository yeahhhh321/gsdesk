use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

use chrono::Utc;
use tauri::AppHandle;
use zip::write::FileOptions;

use crate::core_logs::latest_core_log_file;
use crate::failure_rules::failure_summary;
use crate::models::{AppStateResponse, Settings};
use crate::network;
use crate::paths::app_paths;
use crate::preflight;
use crate::process::run_command_timeout;
use crate::service::{sanitize_persisted_log_content, GSUID_SERVICE_ID};
use crate::settings::redact_secrets;
use crate::toolchain;

pub fn export(
    app: &AppHandle,
    state: &AppStateResponse,
    settings: &Settings,
) -> Result<String, String> {
    let (_, paths) = app_paths(app)?;
    let uv_status = toolchain::uv_status(app, &paths);
    let uv_info = match toolchain::uv_program(app, &paths) {
        Ok(program) => run_command_timeout(
            &program,
            &["--version"],
            None,
            &[],
            std::time::Duration::from_secs(8),
        )
        .map(|output| {
            format!(
                "source={}\npath={}\n{}\n{}",
                uv_status.uv_source, program, output.stdout, output.stderr
            )
        })
        .unwrap_or_else(|error| error),
        Err(error) => {
            format!("detected=false\ntarget={}\nerror={error}", uv_status.uv_bootstrap_target)
        }
    };

    let git_info = match toolchain::git_program(app, &paths) {
        Ok(program) => run_command_timeout(
            &program,
            &["--version"],
            None,
            &[],
            std::time::Duration::from_secs(8),
        )
        .map(|output| {
            format!(
                "source={}\npath={}\n{}\n{}",
                uv_status.git_source, program, output.stdout, output.stderr
            )
        })
        .unwrap_or_else(|error| error),
        Err(error) => format!(
            "detected=false\nbundledGit={}\nerror={error}",
            uv_status.bundled_git_path.as_deref().unwrap_or("current build has no bundled git")
        ),
    };

    let webconsole_url = state
        .services
        .iter()
        .find(|service| service.service_id == GSUID_SERVICE_ID)
        .and_then(|service| service.url.as_ref())
        .map(|url| format!("{}/app", url.trim_end_matches('/')));
    let network_json = serde_json::to_string_pretty(&network::diagnose_targets(
        settings,
        webconsole_url,
        toolchain::git_program(app, &paths),
    ))
    .map_err(|error| format!("序列化网络诊断失败: {error}"))?;

    write_diagnostics_zip(
        &paths,
        state,
        settings,
        &uv_info,
        &git_info,
        &port_summary(state.services.first().and_then(|service| service.port)),
        &network_json,
    )
}

fn write_diagnostics_zip(
    paths: &crate::models::AppPaths,
    state: &AppStateResponse,
    settings: &Settings,
    uv_info: &str,
    git_info: &str,
    ports_info: &str,
    network_json: &str,
) -> Result<String, String> {
    let diagnostics_dir = PathBuf::from(&paths.diagnostics_dir);
    fs::create_dir_all(&diagnostics_dir).map_err(|error| format!("创建诊断目录失败: {error}"))?;
    let file_name = format!("gsdesk-diagnostics-{}.zip", Utc::now().format("%Y%m%d-%H%M%S"));
    let zip_path = diagnostics_dir.join(file_name);
    let file = File::create(&zip_path).map_err(|error| format!("创建诊断包失败: {error}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    let state_json =
        serde_json::to_string_pretty(state).map_err(|error| format!("序列化状态失败: {error}"))?;
    add_file(&mut zip, options, "state.json", &redact_secrets(&state_json))?;

    let settings_json = serde_json::to_string_pretty(settings)
        .map_err(|error| format!("序列化设置失败: {error}"))?;
    add_file(&mut zip, options, "settings.json", &redact_secrets(&settings_json))?;

    add_file(&mut zip, options, "system.txt", &redact_secrets(&system_summary(state)))?;
    add_file(&mut zip, options, "privacy.txt", &privacy_summary())?;

    add_file(&mut zip, options, "uv.txt", &redact_secrets(uv_info))?;
    add_file(&mut zip, options, "git.txt", git_info)?;

    add_file(&mut zip, options, "ports.txt", &redact_secrets(ports_info))?;

    add_file(&mut zip, options, "network-targets.json", &redact_secrets(network_json))?;

    add_file(&mut zip, options, "failure-summary.txt", &redact_secrets(&failure_summary(state)))?;

    let log_path = PathBuf::from(&paths.logs_dir).join("core.log");
    if let Ok(log) = fs::read_to_string(log_path) {
        let log = sanitize_persisted_log_content(&log);
        add_file(&mut zip, options, "core.log", &redact_secrets(&tail(&log, 400)))?;
    }

    if let Some(core_log_path) = latest_core_log_file(&state.paths) {
        if let Ok(log) = fs::read_to_string(core_log_path) {
            add_file(&mut zip, options, "gsuid-core-jsonl.log", &redact_secrets(&tail(&log, 400)))?;
        }
    }

    zip.finish().map_err(|error| format!("写入诊断包失败: {error}"))?;
    Ok(zip_path.to_string_lossy().to_string())
}

fn add_file(
    zip: &mut zip::ZipWriter<File>,
    options: FileOptions,
    name: &str,
    content: &str,
) -> Result<(), String> {
    zip.start_file(name, options).map_err(|error| format!("写入诊断文件失败 {name}: {error}"))?;
    zip.write_all(content.as_bytes()).map_err(|error| format!("写入诊断内容失败 {name}: {error}"))
}

fn tail(content: &str, max_lines: usize) -> String {
    let lines = content.lines().collect::<Vec<_>>();
    let start = lines.len().saturating_sub(max_lines);
    lines[start..].join("\n")
}

fn system_summary(state: &AppStateResponse) -> String {
    let disk_free_bytes = preflight::free_space_bytes(Path::new(&state.paths.app_data));
    system_summary_with_disk(state, disk_free_bytes)
}

fn system_summary_with_disk(state: &AppStateResponse, disk_free_bytes: Option<u64>) -> String {
    let disk_free_bytes_text =
        disk_free_bytes.map(|bytes| bytes.to_string()).unwrap_or_else(|| "unknown".to_string());
    let disk_free_human =
        disk_free_bytes.map(preflight::format_bytes).unwrap_or_else(|| "unknown".to_string());
    let core = state.services.iter().find(|service| service.service_id == GSUID_SERVICE_ID);
    let core_pid = core
        .and_then(|service| service.pid.map(|pid| pid.to_string()))
        .unwrap_or_else(|| "unknown".to_string());
    let core_memory_bytes = core
        .and_then(|service| service.memory_bytes.map(|bytes| bytes.to_string()))
        .unwrap_or_else(|| "unknown".to_string());
    let core_memory_human = core
        .and_then(|service| service.memory_bytes.map(format_runtime_bytes))
        .unwrap_or_else(|| "unknown".to_string());
    let shell_memory_bytes = state
        .shell
        .memory_bytes
        .map(|bytes| bytes.to_string())
        .unwrap_or_else(|| "unknown".to_string());
    let shell_memory_human =
        state.shell.memory_bytes.map(format_runtime_bytes).unwrap_or_else(|| "unknown".to_string());
    format!(
        "schema=gsdesk-diagnostics-v1\nversion={}\nos={}\narch={}\nappData={}\nruntime={}\ncoreDir={}\nvenvDir={}\ndiskFreeBytes={}\ndiskFreeHuman={}\nshellPid={}\nshellMemoryBytes={}\nshellMemoryHuman={}\ncorePid={}\ncoreMemoryBytes={}\ncoreMemoryHuman={}\n",
        state.version,
        std::env::consts::OS,
        std::env::consts::ARCH,
        state.paths.app_data,
        state.paths.runtime,
        state.paths.core_dir,
        state.paths.venv_dir,
        disk_free_bytes_text,
        disk_free_human,
        state.shell.pid,
        shell_memory_bytes,
        shell_memory_human,
        core_pid,
        core_memory_bytes,
        core_memory_human
    )
}

fn format_runtime_bytes(bytes: u64) -> String {
    let mib = bytes as f64 / 1024.0 / 1024.0;
    format!("{mib:.1} MB")
}

fn privacy_summary() -> String {
    [
        "schema=gsdesk-privacy-v1",
        "automaticUpload=disabled",
        "diagnostics=local-only",
        "diagnosticsUpload=manual-user-action-only",
        "network=GitHub/CNB/PyPI/WebConsole/update checks only when user starts related actions",
        "secrets=diagnostics are redacted before packaging",
    ]
    .join("\n")
}

fn port_summary(port: Option<u16>) -> String {
    let port = port.unwrap_or(8765).to_string();
    if cfg!(windows) {
        run_command_timeout(
            "powershell",
            &[
                "-NoProfile",
                "-Command",
                &format!("Get-NetTCPConnection -LocalPort {port} -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort,State,OwningProcess | Format-Table -AutoSize"),
            ],
            None,
            &[],
            std::time::Duration::from_secs(8),
        )
        .map(|output| format!("{}\n{}", output.stdout, output.stderr))
        .unwrap_or_else(|error| error)
    } else {
        run_command_timeout(
            "sh",
            &["-c", &format!("lsof -nP -iTCP:{port} -sTCP:LISTEN || true")],
            None,
            &[],
            std::time::Duration::from_secs(8),
        )
        .map(|output| format!("{}\n{}", output.stdout, output.stderr))
        .unwrap_or_else(|error| error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{
        AppPaths, LogEntry, PreflightCheck, ServiceSnapshot, ServiceStatus, Settings, TaskRecord,
        ToolchainInfo,
    };
    use std::io::Read;

    #[test]
    fn system_summary_includes_disk_space() {
        let state = state_with_logs(Vec::new());

        let summary = system_summary_with_disk(&state, Some(3 * 1024 * 1024 * 1024));

        assert!(summary.contains("diskFreeBytes=3221225472"));
        assert!(summary.contains("diskFreeHuman=3.0 GB"));
    }

    #[test]
    fn privacy_summary_declares_local_only_diagnostics() {
        let summary = privacy_summary();

        assert!(summary.contains("schema=gsdesk-privacy-v1"));
        assert!(summary.contains("automaticUpload=disabled"));
        assert!(summary.contains("diagnostics=local-only"));
    }

    #[test]
    fn diagnostics_zip_contains_required_files_and_redacts_secrets() {
        let root = std::env::temp_dir().join(format!(
            "gsdesk-diagnostics-test-{}",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let app_data = root.join("app");
        let runtime = root.join("runtime");
        let core_dir = runtime.join("core").join("gsuid_core");
        let logs_dir = app_data.join("logs");
        let diagnostics_dir = app_data.join("diagnostics");
        let backups_dir = runtime.join("backups");
        fs::create_dir_all(core_dir.join("data").join("logs")).unwrap();
        fs::create_dir_all(&logs_dir).unwrap();
        fs::create_dir_all(&diagnostics_dir).unwrap();
        fs::write(
            logs_dir.join("core.log"),
            [
                "[2026-06-19T03:34:40Z] [stdout] keep before",
                "[2026-06-19T03:34:41Z] [stderr] --- Logging error ---",
                "[2026-06-19T03:34:41Z] [stderr] Traceback (most recent call last):",
                "[2026-06-19T03:34:41Z] [stderr] File \"C:\\Python\\Lib\\logging\\__init__.py\", line 1163, in emit",
                "[2026-06-19T03:34:41Z] [stderr] File \"C:\\venv\\Lib\\site-packages\\colorama\\ansitowin32.py\", line 210, in write_plain_text",
                "[2026-06-19T03:34:41Z] [stderr] UnicodeEncodeError: 'gbk' codec can't encode character '\\U0001f5d1' in position 0: illegal multibyte sequence",
                "[2026-06-19T03:34:41Z] [stderr] Call stack:",
                "[2026-06-19T03:34:41Z] [stderr] Message: {'event': '\\U0001f5d1\\ufe0f [ResourceManager] TTL'}",
                "[2026-06-19T03:34:41Z] [stderr] Arguments: ()",
                "[2026-06-19T03:34:42Z] [stdout] keep after",
            ]
            .join("\n"),
        )
        .unwrap();
        fs::write(
            core_dir.join("data").join("logs").join("2026-06-19.log"),
            r#"{"event":"started","level":"info","REGISTER_CODE":"secret-code"}"#,
        )
        .unwrap();

        let paths = AppPaths {
            app_data: app_data.to_string_lossy().to_string(),
            runtime: runtime.to_string_lossy().to_string(),
            tools_dir: runtime.join("tools").to_string_lossy().to_string(),
            core_dir: core_dir.to_string_lossy().to_string(),
            venv_dir: runtime.join("venvs").join("gsuid_core").to_string_lossy().to_string(),
            uv_cache_dir: runtime.join("uv").join("cache").to_string_lossy().to_string(),
            uv_python_dir: runtime.join("uv").join("python").to_string_lossy().to_string(),
            uv_executable: runtime
                .join("tools")
                .join("uv")
                .join(if cfg!(windows) { "uv.exe" } else { "uv" })
                .to_string_lossy()
                .to_string(),
            logs_dir: logs_dir.to_string_lossy().to_string(),
            diagnostics_dir: diagnostics_dir.to_string_lossy().to_string(),
            backups_dir: backups_dir.to_string_lossy().to_string(),
            settings_file: app_data.join("settings.json").to_string_lossy().to_string(),
        };
        let mut state = state_with_logs(vec![log(
            1,
            "stderr",
            "error",
            "ModuleNotFoundError: No module named 'gsuid_core'",
        )]);
        state.paths = paths.clone();
        let mut settings = Settings::default();
        settings.proxy.http_proxy = "http://user:password@127.0.0.1:7890".to_string();

        let zip_path = write_diagnostics_zip(
            &paths,
            &state,
            &settings,
            "uv 0.9.8\nWS_TOKEN=secret-token",
            "git version 2.0.0",
            "LocalPort OwningProcess",
            r#"[{"id":"pypi","ok":true}]"#,
        )
        .unwrap();

        let file = File::open(&zip_path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let names = (0..archive.len())
            .map(|index| archive.by_index(index).unwrap().name().to_string())
            .collect::<Vec<_>>();
        for required in [
            "state.json",
            "settings.json",
            "system.txt",
            "privacy.txt",
            "uv.txt",
            "git.txt",
            "ports.txt",
            "network-targets.json",
            "failure-summary.txt",
            "core.log",
            "gsuid-core-jsonl.log",
        ] {
            assert!(names.contains(&required.to_string()), "missing {required}");
        }

        let settings_json = zip_text(&mut archive, "settings.json");
        assert!(!settings_json.contains("password"));
        assert!(settings_json.contains("***"));
        let uv_text = zip_text(&mut archive, "uv.txt");
        assert!(!uv_text.contains("secret-token"));
        let core_log = zip_text(&mut archive, "core.log");
        assert!(!core_log.contains("UnicodeEncodeError"));
        let jsonl = zip_text(&mut archive, "gsuid-core-jsonl.log");
        assert!(jsonl.contains("started"));
        assert!(!jsonl.contains("secret-code"));
        let system = zip_text(&mut archive, "system.txt");
        assert!(system.contains("schema=gsdesk-diagnostics-v1"));
        let privacy = zip_text(&mut archive, "privacy.txt");
        assert!(privacy.contains("automaticUpload=disabled"));

        let _ = fs::remove_dir_all(root);
    }

    fn state_with_logs(logs: Vec<LogEntry>) -> AppStateResponse {
        AppStateResponse {
            version: "0.1.0".to_string(),
            settings: Settings::default(),
            paths: AppPaths {
                app_data: "app".to_string(),
                runtime: "runtime".to_string(),
                tools_dir: "tools".to_string(),
                core_dir: "core".to_string(),
                venv_dir: "venv".to_string(),
                uv_cache_dir: "uv-cache".to_string(),
                uv_python_dir: "uv-python".to_string(),
                uv_executable: "uv".to_string(),
                logs_dir: "logs".to_string(),
                diagnostics_dir: "diagnostics".to_string(),
                backups_dir: "backups".to_string(),
                settings_file: "settings.json".to_string(),
            },
            shell: crate::models::ProcessResourceUsage { pid: 1, memory_bytes: Some(64) },
            services: vec![ServiceSnapshot {
                service_id: GSUID_SERVICE_ID.to_string(),
                name: "gsuid_core".to_string(),
                status: ServiceStatus::Stopped,
                port: Some(8765),
                pid: None,
                memory_bytes: None,
                url: None,
                started_at: None,
                current_commit: None,
                current_tag: None,
                recent_error: None,
                health_ok: false,
                webconsole_available: false,
            }],
            recent_logs: logs,
            preflight_checks: vec![PreflightCheck {
                id: "uv".to_string(),
                label: "uv".to_string(),
                status: "ok".to_string(),
                detail: "可用".to_string(),
                action: None,
            }],
            task_history: vec![TaskRecord {
                id: 1,
                name: "初始化".to_string(),
                status: "completed".to_string(),
                stage: "done".to_string(),
                message: "完成".to_string(),
                started_at: "2026-06-19T00:00:00Z".to_string(),
                ended_at: Some("2026-06-19T00:00:01Z".to_string()),
                elapsed_ms: Some(1000),
            }],
            toolchain: ToolchainInfo {
                uv_detected: true,
                uv_path: Some("tools/uv/Scripts/uv.exe".to_string()),
                uv_source: "runtime".to_string(),
                uv_version: Some("uv 0.0.0".to_string()),
                uv_bootstrap_supported: true,
                uv_bootstrap_target: "tools/uv/Scripts/uv.exe".to_string(),
                uv_bootstrap_url: None,
                bundled_python_available: true,
                bundled_python_path: Some("runtime-assets/python".to_string()),
                uv_error: None,
                git_detected: true,
                git_path: Some("runtime-assets/git/cmd/git.exe".to_string()),
                git_source: "bundle".to_string(),
                git_version: Some("git version 2.51.2.windows.1".to_string()),
                bundled_git_available: true,
                bundled_git_path: Some("runtime-assets/git/cmd/git.exe".to_string()),
                git_error: None,
            },
            uv_detected: true,
        }
    }

    fn log(id: u64, stream: &str, level: &str, message: &str) -> LogEntry {
        LogEntry {
            id,
            service_id: GSUID_SERVICE_ID.to_string(),
            stream: stream.to_string(),
            level: level.to_string(),
            line: message.to_string(),
            message: message.to_string(),
            module: None,
            raw: None,
            timestamp: "2026-06-19T00:00:00Z".to_string(),
        }
    }

    fn zip_text(archive: &mut zip::ZipArchive<File>, name: &str) -> String {
        let mut file = archive.by_name(name).unwrap();
        let mut content = String::new();
        file.read_to_string(&mut content).unwrap();
        content
    }
}
