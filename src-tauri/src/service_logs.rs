#[derive(Default)]
pub(crate) struct ConsoleLogFilter {
    pending_python_logging_error: Option<Vec<String>>,
}

impl ConsoleLogFilter {
    pub(crate) fn apply(&mut self, records: Vec<String>) -> Vec<String> {
        let mut output = Vec::new();
        for record in records {
            if let Some(block) = &mut self.pending_python_logging_error {
                block.push(record);
                if block.len() > 160 {
                    output.extend(self.pending_python_logging_error.take().unwrap_or_default());
                    continue;
                }
                if block.last().is_some_and(|line| is_python_logging_error_block_end(line)) {
                    let block = self.pending_python_logging_error.take().unwrap_or_default();
                    if !is_python_gbk_logging_noise(&block) {
                        output.extend(block);
                    }
                }
                continue;
            }

            if is_python_logging_error_block_start(&record) {
                self.pending_python_logging_error = Some(vec![record]);
                continue;
            }

            if is_standalone_python_gbk_encoding_error(&record) {
                continue;
            }

            output.push(record);
        }
        output
    }

    pub(crate) fn flush_pending(&mut self) -> Vec<String> {
        let block = self.pending_python_logging_error.take().unwrap_or_default();
        if is_python_gbk_logging_noise(&block) {
            Vec::new()
        } else {
            block
        }
    }
}

pub fn sanitize_persisted_log_content(content: &str) -> String {
    #[derive(Default)]
    struct PendingBlock {
        original_lines: Vec<String>,
        payloads: Vec<String>,
    }

    let mut output = Vec::new();
    let mut pending: Option<PendingBlock> = None;

    for line in content.lines() {
        let payload = persisted_log_payload(line).trim().to_string();
        if let Some(block) = &mut pending {
            block.original_lines.push(line.to_string());
            block.payloads.push(payload);

            if block.payloads.len() > 160 {
                let block = pending.take().unwrap_or_default();
                output.extend(block.original_lines.iter().map(|line| log_file_safe_text(line)));
                continue;
            }

            if block.payloads.last().is_some_and(|line| is_python_logging_error_block_end(line)) {
                let block = pending.take().unwrap_or_default();
                if !is_python_gbk_logging_noise(&block.payloads) {
                    output.extend(block.original_lines.iter().map(|line| log_file_safe_text(line)));
                }
            }
            continue;
        }

        if is_python_logging_error_block_start(&payload) {
            pending = Some(PendingBlock {
                original_lines: vec![line.to_string()],
                payloads: vec![payload],
            });
            continue;
        }

        if is_standalone_python_gbk_encoding_error(&payload) {
            continue;
        }

        output.push(log_file_safe_text(line));
    }

    if let Some(block) = pending {
        if !is_python_gbk_logging_noise(&block.payloads) {
            output.extend(block.original_lines.iter().map(|line| log_file_safe_text(line)));
        }
    }

    let mut sanitized = output.join("\n");
    if content.ends_with('\n') && !sanitized.is_empty() {
        sanitized.push('\n');
    }
    sanitized
}

pub(crate) fn log_file_safe_text(input: &str) -> String {
    if !contains_terminal_sensitive_char(input) {
        return input.to_string();
    }

    let mut output = String::with_capacity(input.len());
    for ch in input.chars() {
        if is_terminal_sensitive_char(ch) {
            output.push_str(&format!("\\u{{{:X}}}", ch as u32));
        } else {
            output.push(ch);
        }
    }
    output
}

pub(crate) fn contains_terminal_sensitive_char(input: &str) -> bool {
    input.chars().any(is_terminal_sensitive_char)
}

fn is_terminal_sensitive_char(ch: char) -> bool {
    let code = ch as u32;
    code == 0xFE0E
        || code == 0xFE0F
        || (0x2600..=0x27BF).contains(&code)
        || (0x1F000..=0x1FAFF).contains(&code)
}

fn persisted_log_payload(line: &str) -> &str {
    let Some(first_end) = line.find("] ") else {
        return line;
    };
    let after_timestamp = &line[first_end + 2..];
    let Some(second_end) = after_timestamp.find("] ") else {
        return line;
    };
    &after_timestamp[second_end + 2..]
}

fn is_python_logging_error_block_start(line: &str) -> bool {
    line.trim() == "--- Logging error ---"
}

fn is_python_logging_error_block_end(line: &str) -> bool {
    line.trim_start().starts_with("Arguments:")
}

pub(crate) fn is_standalone_python_gbk_encoding_error(line: &str) -> bool {
    let lower = line.to_lowercase();
    lower.contains("unicodeencodeerror")
        && lower.contains("'gbk'")
        && lower.contains("can't encode character")
        && lower.contains("illegal multibyte sequence")
}

fn is_python_gbk_logging_noise(block: &[String]) -> bool {
    if block.is_empty() {
        return false;
    }
    let joined = block.join("\n").to_lowercase();
    is_standalone_python_gbk_encoding_error(&joined)
        && (joined.contains("logging\\__init__.py")
            || joined.contains("logging/__init__.py")
            || joined.contains("colorama\\ansitowin32.py")
            || joined.contains("colorama/ansitowin32.py"))
}

pub(crate) fn classify_level(line: &str) -> &str {
    let lower = line.to_lowercase();
    if lower.contains("[error")
        || lower.contains("traceback")
        || lower.starts_with("file \"")
        || lower.contains("error")
        || lower.contains("失败")
        || lower.contains("exception")
        || lower.contains("panic")
    {
        "error"
    } else if lower.contains("[warn") || lower.contains("warn") || lower.contains("警告") {
        "warn"
    } else if lower.contains("[debug") || lower.contains("debug") || lower.contains("调试") {
        "debug"
    } else {
        "info"
    }
}

pub(crate) fn should_promote_recent_error(line: &str) -> bool {
    let trimmed = line.trim();
    let lower = trimmed.to_lowercase();
    if is_standalone_python_gbk_encoding_error(trimmed) {
        return false;
    }
    if lower.starts_with("traceback")
        || lower.starts_with("file \"")
        || lower.starts_with("return ")
        || lower.starts_with("asyncio.")
        || lower.starts_with("self.")
        || lower.starts_with("super().")
        || lower.starts_with("handle.")
    {
        return false;
    }

    lower.contains("[error")
        || lower.contains("error")
        || lower.contains("exception")
        || lower.contains("failed")
        || lower.contains("panic")
        || lower.contains("失败")
}

pub(crate) fn normalize_log_records(text: &str) -> Vec<String> {
    let cleaned = strip_terminal_sequences(text);
    let mut records = Vec::new();
    for fragment in cleaned.split(['\r', '\n']) {
        let fragment = fragment.trim();
        if fragment.is_empty() {
            continue;
        }
        records.extend(split_structured_log_records(fragment));
    }
    records
}

fn split_structured_log_records(line: &str) -> Vec<String> {
    let bytes = line.as_bytes();
    let starts: Vec<usize> =
        (0..bytes.len()).filter(|index| is_structured_log_prefix_at(bytes, *index)).collect();

    if starts.is_empty() {
        return vec![line.to_string()];
    }

    let mut records = Vec::new();
    if starts[0] > 0 {
        let prefix = line[..starts[0]].trim();
        if !prefix.is_empty() {
            records.push(prefix.to_string());
        }
    }

    for (position, start) in starts.iter().enumerate() {
        let end = starts.get(position + 1).copied().unwrap_or(line.len());
        let record = line[*start..end].trim();
        if !record.is_empty() {
            records.push(record.to_string());
        }
    }
    records
}

pub(crate) fn is_structured_log_prefix_at(bytes: &[u8], start: usize) -> bool {
    if bytes.len() < start + 17 {
        return false;
    }

    let fixed = [
        (0, b'd'),
        (1, b'd'),
        (2, b'-'),
        (3, b'd'),
        (4, b'd'),
        (5, b' '),
        (6, b'd'),
        (7, b'd'),
        (8, b':'),
        (9, b'd'),
        (10, b'd'),
        (11, b':'),
        (12, b'd'),
        (13, b'd'),
        (14, b' '),
        (15, b'['),
    ];

    for (offset, expected) in fixed {
        let actual = bytes[start + offset];
        if expected == b'd' {
            if !actual.is_ascii_digit() {
                return false;
            }
        } else if actual != expected {
            return false;
        }
    }

    let mut index = start + 16;
    while index < bytes.len() && index < start + 34 {
        let byte = bytes[index];
        if byte == b']' {
            return index > start + 16;
        }
        if !(byte.is_ascii_alphabetic() || byte == b' ' || byte == b'_' || byte == b'-') {
            return false;
        }
        index += 1;
    }
    false
}

fn strip_terminal_sequences(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;

    while index < bytes.len() {
        match bytes[index] {
            0x1b if index + 1 < bytes.len() && bytes[index + 1] == b'[' => {
                index += 2;
                while index < bytes.len() {
                    let byte = bytes[index];
                    index += 1;
                    if (0x40..=0x7e).contains(&byte) {
                        break;
                    }
                }
            }
            0x1b if index + 1 < bytes.len() && bytes[index + 1] == b']' => {
                index += 2;
                while index < bytes.len() {
                    if bytes[index] == 0x07 {
                        index += 1;
                        break;
                    }
                    if bytes[index] == 0x1b && index + 1 < bytes.len() && bytes[index + 1] == b'\\'
                    {
                        index += 2;
                        break;
                    }
                    index += 1;
                }
            }
            0x08 => {
                output.pop();
                index += 1;
            }
            0x00..=0x08 | 0x0b | 0x0c | 0x0e..=0x1f | 0x7f => {
                index += 1;
            }
            byte => {
                output.push(byte);
                index += 1;
            }
        }
    }

    String::from_utf8_lossy(&output).to_string()
}
