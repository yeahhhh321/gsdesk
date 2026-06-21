use chrono::Utc;

use crate::models::{AppStateResponse, LogEntry, ServiceStatus};
use crate::service::GSUID_SERVICE_ID;

struct FailureRule {
    all_terms: &'static [&'static str],
    any_terms: &'static [&'static str],
    explanation: &'static str,
}

const FAILURE_RULES: &[FailureRule] = &[
    FailureRule {
        all_terms: &["unicodeencodeerror", "gbk"],
        any_terms: &[],
        explanation:
            "Python/控制台编码问题；GSDesk 已强制 UTF-8，仍出现时请保留诊断包继续排查启动环境。",
    },
    FailureRule {
        all_terms: &[],
        any_terms: &["module not found", "modulenotfounderror", "no module named", "importerror"],
        explanation: "Python 依赖或 venv 不完整；优先重跑依赖同步，仍失败再重建 venv。",
    },
    FailureRule {
        all_terms: &[],
        any_terms: &[
            "address already in use",
            "only one usage of each socket address",
            "10048",
            "端口",
            "localport",
        ],
        explanation:
            "端口被占用或端口检测异常；在环境与修复中强杀端口占用，或切回自动端口后重启 Core。",
    },
    FailureRule {
        all_terms: &[],
        any_terms: &[
            "proxy",
            "timed out",
            "timeout",
            "connection refused",
            "could not resolve",
            "dns",
            "连接超时",
            "代理",
        ],
        explanation: "网络或代理配置异常；先运行网络诊断，确认源码工具、PyPI 和本机 NO_PROXY。",
    },
    FailureRule {
        all_terms: &[],
        any_terms: &["permission denied", "access is denied", "拒绝访问", "无权限"],
        explanation: "路径或权限受限；确认应用数据目录可写，避免把运行时放在受保护目录。",
    },
    FailureRule {
        all_terms: &[],
        any_terms: &["git clone", "git fetch", "git pull", "dirty repo", "未提交修改"],
        explanation: "源码仓库同步失败；检查内置 Git 连通性、源码源选择和本地未提交修改。",
    },
    FailureRule {
        all_terms: &[],
        any_terms: &["uv sync", "uv python", "pyproject", "python install", "内置 python"],
        explanation:
            "uv/Python 初始化失败；检查 uv 安装、壳内置 Python 资源、隔离 Python 目录和 PyPI 镜像。",
    },
    FailureRule {
        all_terms: &[],
        any_terms: &["traceback", "exception"],
        explanation: "Core 或依赖运行时抛出异常；优先查看最后 traceback 的最底部错误行。",
    },
];

const ERROR_SIGNAL_TERMS: &[&str] =
    &["traceback", "exception", "failed", "error", "panic", "启动失败", "执行失败", "parse_error"];

pub fn failure_summary(state: &AppStateResponse) -> String {
    let mut signals = Vec::new();
    let mut evidence = Vec::new();

    for check in state.preflight_checks.iter().filter(|check| check.status != "ok").take(8) {
        let action = check.action.as_deref().unwrap_or("无建议动作");
        signals.push(format!(
            "preflight.{}: {} - {} | action={}",
            check.status, check.label, check.detail, action
        ));
        evidence.push(check.detail.clone());
        if let Some(action) = &check.action {
            evidence.push(action.clone());
        }
    }

    if let Some(core) = state.services.iter().find(|service| service.service_id == GSUID_SERVICE_ID)
    {
        if core.status == ServiceStatus::Failed {
            let error = core.recent_error.as_deref().unwrap_or("未记录具体错误");
            signals.push(format!(
                "core.status: {} | error={error}",
                service_status_label(core.status)
            ));
            evidence.push(error.to_string());
        } else if let Some(error) = &core.recent_error {
            signals.push(format!("core.recent_error: {error}"));
            evidence.push(error.clone());
        }

        if core.status == ServiceStatus::Running && !core.webconsole_available {
            let port =
                core.port.map(|value| value.to_string()).unwrap_or_else(|| "unknown".to_string());
            signals
                .push(format!("webconsole.unavailable: Core 运行中但 /app 不可访问 | port={port}"));
            evidence.push("webconsole unavailable".to_string());
        }
    }

    if let Some(task) = state.task_history.iter().rev().find(|task| task.status == "failed") {
        signals.push(format!("task.failed: {} / {} - {}", task.name, task.stage, task.message));
        evidence.push(task.message.clone());
    }

    let context = last_error_context(&state.recent_logs);
    evidence.extend(context.iter().cloned());
    if let Some(explanation) = common_failure_explanation(&evidence.join("\n")) {
        signals.push(format!("likely_cause: {explanation}"));
    }

    let mut lines = vec![
        "schema=gsdesk-failure-summary-v1".to_string(),
        format!("generatedAt={}", Utc::now().to_rfc3339()),
    ];

    if signals.is_empty() && context.is_empty() {
        lines.push("status=未发现明确失败信号".to_string());
        lines.push("next=如仍无法启动，请重新执行环境预检、导出诊断包并附带复现步骤。".to_string());
        return lines.join("\n");
    }

    lines.push("status=发现可能失败信号".to_string());
    lines.push(String::new());
    lines.push("[signals]".to_string());
    if signals.is_empty() {
        lines.push("- 未从状态快照发现失败项，继续查看最后错误段。".to_string());
    } else {
        lines.extend(signals.into_iter().map(|signal| format!("- {signal}")));
    }

    if !context.is_empty() {
        lines.push(String::new());
        lines.push("[last-error-context]".to_string());
        lines.extend(context.into_iter().map(|line| format!("  {line}")));
    }

    lines.join("\n")
}

fn service_status_label(status: ServiceStatus) -> &'static str {
    match status {
        ServiceStatus::Uninitialized => "uninitialized",
        ServiceStatus::Checking => "checking",
        ServiceStatus::Initializing => "initializing",
        ServiceStatus::Starting => "starting",
        ServiceStatus::Running => "running",
        ServiceStatus::Stopping => "stopping",
        ServiceStatus::Stopped => "stopped",
        ServiceStatus::Failed => "failed",
    }
}

fn common_failure_explanation(text: &str) -> Option<&'static str> {
    let lower = text.to_lowercase();
    FAILURE_RULES.iter().find(|rule| rule_matches(rule, &lower)).map(|rule| rule.explanation)
}

fn rule_matches(rule: &FailureRule, lower: &str) -> bool {
    rule.all_terms.iter().all(|term| lower.contains(term))
        && (rule.any_terms.is_empty() || contains_any(lower, rule.any_terms))
}

fn last_error_context(logs: &[LogEntry]) -> Vec<String> {
    let Some(last_error_index) = logs.iter().rposition(is_error_signal) else {
        return Vec::new();
    };

    let search_start = last_error_index.saturating_sub(30);
    let traceback_start = logs[search_start..=last_error_index]
        .iter()
        .rposition(|entry| entry_text(entry).to_lowercase().contains("traceback"))
        .map(|offset| search_start + offset);
    let start = traceback_start.unwrap_or_else(|| last_error_index.saturating_sub(6));
    let max_after = if traceback_start.is_some() { 25 } else { 8 };
    let end = logs.len().min(last_error_index + max_after);

    logs[start..end].iter().take(30).map(format_log_context_line).collect()
}

fn is_error_signal(entry: &LogEntry) -> bool {
    if entry.level == "error" {
        return true;
    }
    contains_any(&entry_text(entry).to_lowercase(), ERROR_SIGNAL_TERMS)
}

fn contains_any(text: &str, terms: &[&str]) -> bool {
    terms.iter().any(|term| text.contains(term))
}

fn format_log_context_line(entry: &LogEntry) -> String {
    let module = entry
        .module
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(|value| format!(" [{value}]"))
        .unwrap_or_default();
    format!(
        "{} [{}/{}]{} {}",
        entry.timestamp,
        entry.stream,
        entry.level,
        module,
        entry_text(entry)
    )
}

fn entry_text(entry: &LogEntry) -> &str {
    if !entry.message.trim().is_empty() {
        &entry.message
    } else {
        &entry.line
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{
        AppPaths, PreflightCheck, ServiceSnapshot, Settings, TaskRecord, ToolchainInfo,
    };

    #[test]
    fn explains_dependency_failure_from_traceback() {
        let logs = vec![
            log(1, "stdout", "info", "Booting"),
            log(2, "stderr", "error", "Traceback (most recent call last):"),
            log(3, "stderr", "error", "  File \"core.py\", line 1, in <module>"),
            log(4, "stderr", "error", "ModuleNotFoundError: No module named 'gsuid_core'"),
        ];
        let state = state_with_logs(logs);

        let summary = failure_summary(&state);

        assert!(summary.contains("schema=gsdesk-failure-summary-v1"));
        assert!(summary.contains("Python 依赖或 venv 不完整"));
        assert!(summary.contains("[last-error-context]"));
        assert!(summary.contains("Traceback (most recent call last):"));
        assert!(summary.contains("ModuleNotFoundError"));
    }

    #[test]
    fn classifies_port_and_proxy_failures() {
        assert!(common_failure_explanation("OSError: address already in use")
            .unwrap()
            .contains("端口被占用"));
        assert!(common_failure_explanation("Connect timed out while using proxy")
            .unwrap()
            .contains("网络或代理"));
    }

    #[test]
    fn healthy_summary_has_no_failure_signal() {
        let state = state_with_logs(vec![log(1, "core", "info", "Started server process")]);

        let summary = failure_summary(&state);

        assert!(summary.contains("status=未发现明确失败信号"));
        assert!(!summary.contains("[last-error-context]"));
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
}
