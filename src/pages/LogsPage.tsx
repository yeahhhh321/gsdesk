import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Button, Dropdown, Input, Select, Switch, Tag, Typography } from "antd";
import { ArrowDownToLine, ClipboardCopy, Download, FolderOpen, MoreHorizontal, Search, Trash2 } from "lucide-react";
import {
  displayLogModule,
  filterLogs,
  formatLogLine,
  getLogDisplay,
  levelLabel,
  logModuleOptions,
  logsAfterClear,
  LOG_LEVEL_OPTIONS,
  LOG_ROW_HEIGHT,
  type LogLevelFilter,
  virtualLogWindow,
} from "../logModel";
import { displayText } from "../ui/format";
import { PanelHeader, SectionActions } from "../ui/primitives";
import type { LogEntry } from "../types";

const { Text } = Typography;

interface LogsPageProps {
  logs: LogEntry[];
  onOpenLogsDir: () => void;
}

export default function LogsPage({ logs, onOpenLogsDir }: LogsPageProps) {
  const [logQuery, setLogQuery] = useState("");
  const [logLevel, setLogLevel] = useState<LogLevelFilter>("all");
  const [moduleFilter, setModuleFilter] = useState("all");
  const [followTail, setFollowTail] = useState(true);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(360);
  const [clearedBeforeId, setClearedBeforeId] = useState<number | undefined>();
  const [busyAction, setBusyAction] = useState<"copy" | "export">();
  const viewportRef = useRef<HTMLDivElement>(null);
  const scrollFrameRef = useRef<number | undefined>(undefined);
  const deferredQuery = useDeferredValue(logQuery);

  const activeLogs = useMemo(() => logsAfterClear(logs, clearedBeforeId), [clearedBeforeId, logs]);

  const filteredLogs = useMemo(
    () => filterLogs(activeLogs, { query: deferredQuery, level: logLevel, module: moduleFilter }),
    [activeLogs, deferredQuery, logLevel, moduleFilter],
  );

  const moduleOptions = useMemo(() => logModuleOptions(activeLogs), [activeLogs]);
  const { totalHeight, visibleStart, visibleEnd, visibleRange } = virtualLogWindow(
    filteredLogs.length,
    scrollTop,
    viewportHeight,
  );
  const visibleLogs = filteredLogs.slice(visibleStart, visibleEnd);

  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return undefined;
    setViewportHeight(node.clientHeight);
    const resizeObserver = new ResizeObserver(() => setViewportHeight(node.clientHeight));
    resizeObserver.observe(node);
    return () => {
      resizeObserver.disconnect();
      if (scrollFrameRef.current !== undefined) window.cancelAnimationFrame(scrollFrameRef.current);
    };
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
    if (scrollFrameRef.current !== undefined) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = undefined;
      const node = viewportRef.current;
      if (!node) return;
      setScrollTop(node.scrollTop);
      setViewportHeight(node.clientHeight);
      const distanceToBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
      setFollowTail(distanceToBottom < LOG_ROW_HEIGHT * 3);
    });
  }

  function scrollToBottom() {
    const node = viewportRef.current;
    if (!node) return;
    setFollowTail(true);
    window.requestAnimationFrame(() => {
      node.scrollTop = node.scrollHeight;
    });
  }

  async function copyLogs(items: LogEntry[]) {
    setBusyAction("copy");
    try {
      await navigator.clipboard.writeText(await formatLogsText(items));
    } finally {
      setBusyAction(undefined);
    }
  }

  async function exportFilteredLogs() {
    setBusyAction("export");
    try {
      const content = await formatLogsText(filteredLogs);
      const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `gsdesk-logs-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
      anchor.click();
      URL.revokeObjectURL(url);
    } finally {
      setBusyAction(undefined);
    }
  }

  function clearView() {
    const lastId = logs[logs.length - 1]?.id;
    setClearedBeforeId(lastId);
    setScrollTop(0);
  }

  function runMoreAction(key: string) {
    if (key === "copy_all") {
      void copyLogs(filteredLogs);
      return;
    }
    if (key === "export") {
      void exportFilteredLogs();
      return;
    }
    if (key === "open_dir") {
      onOpenLogsDir();
      return;
    }
    if (key === "clear") {
      clearView();
    }
  }

  return (
    <section className="page-block logs-page">
      <PanelHeader
        title="Core JSONL 日志"
        description="只展示 Core data/logs 下的 JSONL 文件日志；启动命令输出不混入主日志视图"
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
            <Select<LogLevelFilter> value={logLevel} className="log-filter" onChange={setLogLevel} options={LOG_LEVEL_OPTIONS} />
            <Select value={moduleFilter} className="log-module-filter" onChange={setModuleFilter} options={moduleOptions} />
          </SectionActions>
        }
      />

      <div className="log-toolbar">
        <div className="log-meta">
          <strong>{filteredLogs.length}</strong>
          <Text type="secondary">
            条匹配 · JSONL {activeLogs.length}/{logs.length} · 可视 {visibleRange}
          </Text>
        </div>
        <SectionActions>
          <span className="log-follow">
            <Text type="secondary">自动跟随</Text>
            <Switch
              size="small"
              checked={followTail}
              onChange={(checked) => (checked ? scrollToBottom() : setFollowTail(false))}
            />
          </span>
          <Button icon={<ArrowDownToLine size={15} />} onClick={scrollToBottom}>
            到底部
          </Button>
          <Button
            icon={<ClipboardCopy size={15} />}
            loading={busyAction === "copy"}
            onClick={() => void copyLogs(visibleLogs)}
            disabled={!visibleLogs.length}
          >
            复制可见
          </Button>
          <Dropdown
            trigger={["click"]}
            menu={{
              items: [
                {
                  key: "copy_all",
                  label: "复制全部匹配",
                  icon: <ClipboardCopy size={14} />,
                  disabled: !filteredLogs.length,
                },
                {
                  key: "export",
                  label: "导出筛选结果",
                  icon: <Download size={14} />,
                  disabled: !filteredLogs.length,
                },
                {
                  key: "open_dir",
                  label: "打开日志目录",
                  icon: <FolderOpen size={14} />,
                },
                {
                  key: "clear",
                  label: "清空当前视图",
                  icon: <Trash2 size={14} />,
                  disabled: !logs.length,
                  danger: true,
                },
              ],
              onClick: ({ key }: { key: string }) => runMoreAction(key),
            }}
          >
            <Button icon={<MoreHorizontal size={15} />} loading={busyAction === "export"}>
              更多
            </Button>
          </Dropdown>
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
                  <Tag>{levelLabel(entry.level)}</Tag>
                  <span className="log-module" title={displayLogModule(entry.module)}>
                    {displayText(entry.module)}
                  </span>
                  <code title={displayText(entry.raw, entry.line)}>{display.message}</code>
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

async function formatLogsText(items: LogEntry[]) {
  const chunkSize = 500;
  const chunks: string[] = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(
      items
        .slice(index, index + chunkSize)
        .map(formatLogLine)
        .join("\n"),
    );
    if (index + chunkSize < items.length) {
      await yieldToBrowser();
    }
  }
  return chunks.join("\n");
}

function yieldToBrowser() {
  return new Promise<void>((resolve) => window.setTimeout(resolve, 0));
}
