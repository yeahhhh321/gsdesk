import type { LogEntry } from "./types";
import { displayText } from "./ui/format";

export const LOG_ROW_HEIGHT = 30;
export const LOG_OVERSCAN = 18;
export const LOG_LEVEL_OPTIONS: Array<{ value: LogLevelFilter; label: string }> = [
  { value: "all", label: "全部等级" },
  { value: "debug", label: "调试" },
  { value: "info", label: "信息" },
  { value: "warn", label: "警告" },
  { value: "error", label: "错误" },
];

export type LogLevelFilter = LogEntry["level"] | "all";

interface LogFilterState {
  query: string;
  level: LogLevelFilter;
  module: string;
}

interface VirtualLogWindow {
  visibleStart: number;
  visibleEnd: number;
  visibleRange: string;
  totalHeight: number;
}

export function isCoreJsonLog(entry: LogEntry) {
  return entry.stream === "core";
}

export function logsAfterClear(logs: LogEntry[], clearedBeforeId: number | undefined) {
  if (clearedBeforeId === undefined) return logs;
  return logs.filter((entry) => entry.id > clearedBeforeId);
}

export function filterLogs(logs: LogEntry[], filter: LogFilterState) {
  const query = filter.query.trim().toLowerCase();
  if (!query && filter.level === "all" && filter.module === "all") return logs;
  return logs.filter((entry) => {
    if (filter.level !== "all" && entry.level !== filter.level) return false;
    if (filter.module !== "all" && displayLogModule(entry.module) !== filter.module) return false;
    if (!query) return true;
    const searchable = [entry.message, entry.module, entry.raw, entry.line, entry.serviceId]
      .filter(isSearchableText)
      .join("\n")
      .toLowerCase();
    return searchable.includes(query);
  });
}

export function logModuleOptions(logs: LogEntry[]) {
  const modules = Array.from(new Set(logs.map((entry) => displayLogModule(entry.module)))).sort((a, b) =>
    a.localeCompare(b, "zh-CN"),
  );
  return [{ value: "all", label: "全部模块" }, ...modules.slice(0, 80).map((module) => ({ value: module, label: module }))];
}

export function virtualLogWindow(totalRows: number, scrollTop: number, viewportHeight: number): VirtualLogWindow {
  const totalHeight = totalRows * LOG_ROW_HEIGHT;
  const visibleStart = Math.max(0, Math.floor(scrollTop / LOG_ROW_HEIGHT) - LOG_OVERSCAN);
  const visibleCount = Math.ceil(viewportHeight / LOG_ROW_HEIGHT) + LOG_OVERSCAN * 2;
  const visibleEnd = Math.min(totalRows, visibleStart + visibleCount);
  return {
    visibleStart,
    visibleEnd,
    visibleRange: totalRows ? `${visibleStart + 1}-${visibleEnd}` : "0-0",
    totalHeight,
  };
}

export function formatLogLine(entry: LogEntry) {
  const module = entry.module ? ` [${entry.module}]` : "";
  return `[${entry.timestamp}] [${entry.serviceId}] [${entry.stream}]${module} ${displayText(entry.message, entry.line)}`;
}

export function getLogDisplay(entry: LogEntry) {
  if (entry.message && entry.message !== entry.line) {
    return {
      time: formatLogTime(entry.timestamp),
      message: entry.message,
    };
  }
  const structured = entry.line.match(/^(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+\[([^\]]+)\]\s*(.*)$/);
  if (!structured) {
    return {
      time: formatLogTime(entry.timestamp),
      message: entry.line,
    };
  }

  return {
    time: structured[1],
    message: displayText(structured[3], structured[2].trim()),
  };
}

export function displayLogModule(module: string | undefined) {
  return displayText(module, "未标记");
}

export function levelLabel(level: LogEntry["level"]) {
  if (level === "debug") return "调试";
  if (level === "warn") return "警告";
  if (level === "error") return "错误";
  return "信息";
}

function isSearchableText(value: string | undefined): value is string {
  return Boolean(value);
}

function formatLogTime(timestamp: string) {
  const date = new Date(timestamp);
  if (!Number.isNaN(date.getTime())) return date.toLocaleTimeString();
  return timestamp;
}
