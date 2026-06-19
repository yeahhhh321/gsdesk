import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Button, Input, Select, Switch, Tag, Typography } from "antd";
import { ArrowDownToLine, ClipboardCopy, Download, FolderOpen, Search, Trash2 } from "lucide-react";
import { PanelHeader, SectionActions } from "../ui/primitives";
import type { LogEntry } from "../types";

const { Text } = Typography;
const LOG_ROW_HEIGHT = 30;
const LOG_OVERSCAN = 18;

interface LogsPageProps {
  logs: LogEntry[];
  onOpenLogsDir: () => void;
}

export default function LogsPage({ logs, onOpenLogsDir }: LogsPageProps) {
  const [logQuery, setLogQuery] = useState("");
  const [logLevel, setLogLevel] = useState("all");
  const [streamFilter, setStreamFilter] = useState("all");
  const [moduleFilter, setModuleFilter] = useState("all");
  const [followTail, setFollowTail] = useState(true);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(360);
  const [clearedBeforeId, setClearedBeforeId] = useState<number | undefined>();
  const viewportRef = useRef<HTMLDivElement>(null);
  const deferredQuery = useDeferredValue(logQuery);

  const activeLogs = useMemo(() => {
    if (clearedBeforeId === undefined) return logs;
    return logs.filter((entry) => entry.id > clearedBeforeId);
  }, [clearedBeforeId, logs]);

  const filteredLogs = useMemo(() => {
    const query = deferredQuery.trim().toLowerCase();
    return activeLogs.filter((entry) => {
      const levelOk = logLevel === "all" || entry.level === logLevel;
      const streamOk = streamFilter === "all" || entry.stream === streamFilter;
      const moduleOk = moduleFilter === "all" || (entry.module || "未标记") === moduleFilter;
      const searchable = [entry.message, entry.module, entry.raw, entry.line, entry.serviceId].filter(Boolean).join("\n").toLowerCase();
      const queryOk = !query || searchable.includes(query);
      return levelOk && streamOk && moduleOk && queryOk;
    });
  }, [activeLogs, deferredQuery, logLevel, moduleFilter, streamFilter]);

  const moduleOptions = useMemo(() => {
    const modules = Array.from(new Set(activeLogs.map((entry) => entry.module || "未标记"))).sort((a, b) => a.localeCompare(b, "zh-CN"));
    return [{ value: "all", label: "全部模块" }, ...modules.slice(0, 80).map((module) => ({ value: module, label: module }))];
  }, [activeLogs]);

  const totalHeight = filteredLogs.length * LOG_ROW_HEIGHT;
  const visibleStart = Math.max(0, Math.floor(scrollTop / LOG_ROW_HEIGHT) - LOG_OVERSCAN);
  const visibleCount = Math.ceil(viewportHeight / LOG_ROW_HEIGHT) + LOG_OVERSCAN * 2;
  const visibleEnd = Math.min(filteredLogs.length, visibleStart + visibleCount);
  const visibleLogs = filteredLogs.slice(visibleStart, visibleEnd);
  const visibleRange = filteredLogs.length ? `${visibleStart + 1}-${visibleEnd}` : "0-0";

  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return undefined;
    setViewportHeight(node.clientHeight);
    const resizeObserver = new ResizeObserver(() => setViewportHeight(node.clientHeight));
    resizeObserver.observe(node);
    return () => resizeObserver.disconnect();
  }, []);

  useEffect(() => {
    if (!followTail) return;
    const node = viewportRef.current;
    if (!node) return;
    window.requestAnimationFrame(() => {
      node.scrollTop = node.scrollHeight;
    });
  }, [filteredLogs.length, followTail]);

  function handleScroll() {
    const node = viewportRef.current;
    if (!node) return;
    setScrollTop(node.scrollTop);
    setViewportHeight(node.clientHeight);
    const distanceToBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    setFollowTail(distanceToBottom < LOG_ROW_HEIGHT * 3);
  }

  function scrollToBottom() {
    const node = viewportRef.current;
    if (!node) return;
    setFollowTail(true);
    window.requestAnimationFrame(() => {
      node.scrollTop = node.scrollHeight;
    });
  }

  function copyLogs(items: LogEntry[]) {
    return navigator.clipboard.writeText(items.map(formatLogLine).join("\n"));
  }

  function exportFilteredLogs() {
    const content = filteredLogs.map(formatLogLine).join("\n");
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `gsdesk-logs-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function clearView() {
    const lastId = logs[logs.length - 1]?.id;
    setClearedBeforeId(lastId);
    setScrollTop(0);
  }

  return (
    <section className="page-block logs-page">
      <PanelHeader
        title="终端日志"
        description="优先读取 Core JSONL 文件日志，stdout/stderr 保留启动失败和崩溃现场"
        actions={
          <SectionActions>
            <Input
              className="log-search"
              prefix={<Search size={15} />}
              placeholder="搜索日志"
              allowClear
              value={logQuery}
              onChange={(event) => setLogQuery(event.target.value)}
            />
            <Select
              value={logLevel}
              className="log-filter"
              onChange={setLogLevel}
              options={[
                { value: "all", label: "全部等级" },
                { value: "info", label: "信息" },
                { value: "success", label: "成功" },
                { value: "warn", label: "警告" },
                { value: "error", label: "错误" },
              ]}
            />
            <Select
              value={streamFilter}
              className="log-filter"
              onChange={setStreamFilter}
              options={[
                { value: "all", label: "全部来源" },
                { value: "core", label: "Core文件" },
                { value: "stdout", label: "stdout" },
                { value: "stderr", label: "stderr" },
                { value: "system", label: "system" },
              ]}
            />
            <Select value={moduleFilter} className="log-module-filter" onChange={setModuleFilter} options={moduleOptions} />
          </SectionActions>
        }
      />

      <div className="log-toolbar">
        <div className="log-meta">
          <strong>{filteredLogs.length}</strong>
          <Text type="secondary">条匹配 · 缓存 {activeLogs.length}/{logs.length} · 可视 {visibleRange}</Text>
        </div>
        <SectionActions>
          <span className="log-follow">
            <Text type="secondary">自动跟随</Text>
            <Switch size="small" checked={followTail} onChange={(checked) => (checked ? scrollToBottom() : setFollowTail(false))} />
          </span>
          <Button icon={<ArrowDownToLine size={15} />} onClick={scrollToBottom}>
            到底部
          </Button>
          <Button icon={<ClipboardCopy size={15} />} onClick={() => copyLogs(visibleLogs)} disabled={!visibleLogs.length}>
            复制可见
          </Button>
          <Button icon={<ClipboardCopy size={15} />} onClick={() => copyLogs(filteredLogs)} disabled={!filteredLogs.length}>
            复制全部
          </Button>
          <Button icon={<Download size={15} />} onClick={exportFilteredLogs} disabled={!filteredLogs.length}>
            导出筛选
          </Button>
          <Button icon={<FolderOpen size={15} />} onClick={onOpenLogsDir}>
            日志目录
          </Button>
          <Button icon={<Trash2 size={15} />} onClick={clearView} disabled={!logs.length}>
            清空视图
          </Button>
        </SectionActions>
      </div>

      <div className="log-view" ref={viewportRef} onScroll={handleScroll} data-testid="virtual-log-view">
        {filteredLogs.length ? (
          <div className="log-spacer" style={{ height: totalHeight }}>
            {visibleLogs.map((entry, index) => {
              const display = getLogDisplay(entry);
              return (
                <div
                  key={entry.id}
                  className={`log-line ${entry.level}`}
                  style={{ transform: `translateY(${(visibleStart + index) * LOG_ROW_HEIGHT}px)` }}
                >
                  <span className="log-time">{display.time}</span>
                  <Tag>{entry.stream}</Tag>
                  <span className="log-module" title={entry.module || "未标记"}>
                    {entry.module || "-"}
                  </span>
                  <code title={entry.raw || entry.line}>{display.message}</code>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="log-empty">暂无匹配日志</div>
        )}
      </div>
    </section>
  );
}

function formatLogLine(entry: LogEntry) {
  const module = entry.module ? ` [${entry.module}]` : "";
  return `[${entry.timestamp}] [${entry.serviceId}] [${entry.stream}]${module} ${entry.message || entry.line}`;
}

function getLogDisplay(entry: LogEntry) {
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
    message: structured[3] || structured[2].trim(),
  };
}

function formatLogTime(timestamp: string) {
  const date = new Date(timestamp);
  if (!Number.isNaN(date.getTime())) return date.toLocaleTimeString();
  return timestamp;
}
