use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::Deserialize;
use serde_json::Value;

use crate::models::AppPaths;
use crate::service_logs::classify_level;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreFileLogRecord {
    pub message: String,
    pub level: String,
    pub timestamp: String,
    pub module: Option<String>,
    pub raw: Option<String>,
}

impl CoreFileLogRecord {
    pub fn to_display_line(&self) -> String {
        format!("{} [{:<8}] {}", self.timestamp, self.level, self.message.trim())
    }
}

#[derive(Debug, Deserialize)]
struct RawCoreJsonLog {
    event: Value,
    level: Option<String>,
    timestamp: Option<String>,
    module: Option<String>,
    logger: Option<String>,
    name: Option<String>,
    target: Option<String>,
}

pub fn latest_core_log_file(paths: &AppPaths) -> Option<PathBuf> {
    let logs_dir = PathBuf::from(&paths.core_dir).join("data").join("logs");
    fs::read_dir(logs_dir)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .map(|extension| {
                        extension.eq_ignore_ascii_case("log")
                            || extension.eq_ignore_ascii_case("jsonl")
                    })
                    .unwrap_or(false)
        })
        .max_by_key(|path| fs::metadata(path).and_then(|metadata| metadata.modified()).ok())
}

pub fn read_core_jsonl_records(
    path: &Path,
    offset: u64,
    max_bytes: usize,
) -> Result<(Vec<CoreFileLogRecord>, u64), String> {
    let mut file = File::open(path)
        .map_err(|error| format!("打开 Core 日志文件失败 {}: {error}", path.display()))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| format!("定位 Core 日志文件失败 {}: {error}", path.display()))?;
    let mut bytes = Vec::new();
    let mut limited = file.take(max_bytes as u64);
    limited
        .read_to_end(&mut bytes)
        .map_err(|error| format!("读取 Core 日志文件失败 {}: {error}", path.display()))?;
    if bytes.is_empty() {
        return Ok((Vec::new(), offset));
    }

    let complete_len =
        bytes.iter().rposition(|byte| *byte == b'\n').map(|index| index + 1).unwrap_or(0);
    if complete_len == 0 {
        if bytes.len() >= max_bytes {
            return Ok((vec![oversized_line_record(max_bytes)], offset + bytes.len() as u64));
        }
        return Ok((Vec::new(), offset));
    }

    let usable_start = if offset > 0 {
        bytes[..complete_len]
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|index| index + 1)
            .unwrap_or(complete_len)
    } else {
        0
    };
    if usable_start >= complete_len {
        return Ok((Vec::new(), offset + complete_len as u64));
    }

    let text = String::from_utf8_lossy(&bytes[usable_start..complete_len]);
    let mut records = Vec::new();
    for line in text.lines() {
        records.extend(parse_core_jsonl_line(line));
    }
    Ok((records, offset + complete_len as u64))
}

fn oversized_line_record(max_bytes: usize) -> CoreFileLogRecord {
    CoreFileLogRecord {
        message: format!("JSONL 单行超过 {} KB，已跳过以避免界面卡顿", max_bytes / 1024),
        level: "warn".to_string(),
        timestamp: Utc::now().format("%m-%d %H:%M:%S").to_string(),
        module: Some("log_guard".to_string()),
        raw: None,
    }
}

pub fn parse_core_jsonl_line(line: &str) -> Vec<CoreFileLogRecord> {
    let raw_line = line.trim();
    let raw = match serde_json::from_str::<RawCoreJsonLog>(line) {
        Ok(raw) => raw,
        Err(error) => {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                return Vec::new();
            }
            return vec![CoreFileLogRecord {
                message: format!("JSONL parse_error: {error}; raw={trimmed}"),
                level: "warn".to_string(),
                timestamp: Utc::now().format("%m-%d %H:%M:%S").to_string(),
                module: Some("parse_error".to_string()),
                raw: Some(trimmed.to_string()),
            }];
        }
    };
    let event = match raw.event {
        Value::String(value) => value,
        value => value.to_string(),
    };
    let timestamp =
        raw.timestamp.unwrap_or_else(|| Utc::now().format("%m-%d %H:%M:%S").to_string());
    let level = normalize_core_json_level(raw.level.as_deref(), &event);
    let explicit_module = raw.module.or(raw.logger).or(raw.name).or(raw.target);

    event
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .lines()
        .map(str::trim_end)
        .filter(|line| !line.trim().is_empty())
        .map(|line| CoreFileLogRecord {
            message: line.to_string(),
            level: level.clone(),
            timestamp: timestamp.clone(),
            module: explicit_module.clone().or_else(|| extract_bracket_module(line)),
            raw: Some(raw_line.to_string()),
        })
        .collect()
}

fn extract_bracket_module(line: &str) -> Option<String> {
    let start = line.find('[')?;
    let end = line[start + 1..].find(']')? + start + 1;
    let module = line[start + 1..end].trim();
    if module.is_empty() || module.len() > 48 || module.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    Some(module.to_string())
}

fn normalize_core_json_level(level: Option<&str>, event: &str) -> String {
    match level.map(|value| value.to_lowercase()) {
        Some(value) if value == "trace" || value == "debug" => "debug".to_string(),
        Some(value) if value == "success" => "info".to_string(),
        Some(value) if value == "warn" || value == "warning" => "warn".to_string(),
        Some(value) if value == "error" || value == "exception" || value == "critical" => {
            "error".to_string()
        }
        Some(value) if value == "info" => "info".to_string(),
        _ => classify_level(event).to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_core_jsonl_log_lines() {
        let records = parse_core_jsonl_line(
            r#"{"event":"Started server process [36928]\nWaiting for application startup.","level":"info","timestamp":"06-19 10:37:47"}"#,
        );

        assert_eq!(
            records,
            vec![
                CoreFileLogRecord {
                    message: "Started server process [36928]".to_string(),
                    level: "info".to_string(),
                    timestamp: "06-19 10:37:47".to_string(),
                    module: None,
                    raw: Some(
                        r#"{"event":"Started server process [36928]\nWaiting for application startup.","level":"info","timestamp":"06-19 10:37:47"}"#
                            .to_string(),
                    ),
                },
                CoreFileLogRecord {
                    message: "Waiting for application startup.".to_string(),
                    level: "info".to_string(),
                    timestamp: "06-19 10:37:47".to_string(),
                    module: None,
                    raw: Some(
                        r#"{"event":"Started server process [36928]\nWaiting for application startup.","level":"info","timestamp":"06-19 10:37:47"}"#
                            .to_string(),
                    ),
                },
            ]
        );
        assert_eq!(
            records[0].to_display_line(),
            "06-19 10:37:47 [info    ] Started server process [36928]"
        );
    }

    #[test]
    fn keeps_core_jsonl_parse_errors_visible() {
        let records = parse_core_jsonl_line("{bad json");

        assert_eq!(records.len(), 1);
        assert_eq!(records[0].level, "warn");
        assert!(records[0].message.contains("JSONL parse_error"));
        assert!(records[0].message.contains("{bad json"));
        assert_eq!(records[0].module.as_deref(), Some("parse_error"));
    }

    #[test]
    fn reads_core_jsonl_incrementally() {
        let dir = std::env::temp_dir().join(format!(
            "gsdesk-jsonl-test-{}",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("2026-06-19.log");
        fs::write(
            &path,
            "{\"event\":\"first\",\"level\":\"info\",\"timestamp\":\"06-19 10:37:43\"}\n{\"event\":\"second\",\"level\":\"success\",\"timestamp\":\"06-19 10:37:44\"}\n",
        )
        .unwrap();

        let (records, offset) = read_core_jsonl_records(&path, 0, 1024 * 1024).unwrap();
        assert_eq!(records.len(), 2);
        assert_eq!(records[1].level, "info");

        fs::write(
            &path,
            "{\"event\":\"first\",\"level\":\"info\",\"timestamp\":\"06-19 10:37:43\"}\n{\"event\":\"second\",\"level\":\"success\",\"timestamp\":\"06-19 10:37:44\"}\n{\"event\":\"partial\",\"level\":\"info\"",
        )
        .unwrap();
        let (records, next_offset) = read_core_jsonl_records(&path, offset, 1024 * 1024).unwrap();
        assert!(records.is_empty());
        assert_eq!(next_offset, offset);

        let _ = fs::remove_file(path);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn reads_core_jsonl_from_middle_without_partial_line_noise() {
        let dir = std::env::temp_dir().join(format!(
            "gsdesk-jsonl-tail-test-{}",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("2026-06-19.log");
        let content = concat!(
            "{\"event\":\"first long line\",\"level\":\"info\",\"timestamp\":\"06-19 10:37:43\"}\n",
            "{\"event\":\"second\",\"level\":\"success\",\"timestamp\":\"06-19 10:37:44\"}\n"
        );
        fs::write(&path, content).unwrap();

        let offset_inside_first_line = 10;
        let (records, next_offset) =
            read_core_jsonl_records(&path, offset_inside_first_line, 1024 * 1024).unwrap();

        assert_eq!(records.len(), 1);
        assert_eq!(records[0].message, "second");
        assert_eq!(records[0].level, "info");
        assert_eq!(next_offset, content.len() as u64);

        let _ = fs::remove_file(path);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn extracts_module_from_real_core_jsonl_shape_with_emoji_event() {
        let marker = char::from_u32(0x1f5d1).unwrap();
        let event = format!("{marker} [ResourceManager] TTL 已清理");
        let raw = serde_json::json!({
            "event": event,
            "level": "success",
            "timestamp": "06-19 10:37:47"
        })
        .to_string();
        let records = parse_core_jsonl_line(&raw);

        assert_eq!(records.len(), 1);
        assert_eq!(records[0].message, event);
        assert_eq!(records[0].module.as_deref(), Some("ResourceManager"));
        assert_eq!(records[0].level, "info");
    }

    #[test]
    fn skips_oversized_incomplete_line() {
        let dir = std::env::temp_dir().join(format!(
            "gsdesk-jsonl-oversized-test-{}",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("2026-06-19.log");
        fs::write(&path, "x".repeat(128)).unwrap();

        let (records, next_offset) = read_core_jsonl_records(&path, 0, 64).unwrap();

        assert_eq!(records.len(), 1);
        assert_eq!(records[0].level, "warn");
        assert_eq!(records[0].module.as_deref(), Some("log_guard"));
        assert_eq!(next_offset, 64);

        let _ = fs::remove_file(path);
        let _ = fs::remove_dir_all(dir);
    }
}
