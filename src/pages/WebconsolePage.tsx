import type { ReactNode } from "react";
import { Alert, App as AntdApp, Button, Empty } from "antd";
import { Copy, ExternalLink, ListChecks, Play, RefreshCcw, Terminal, Wrench } from "lucide-react";
import { displayText } from "../ui/format";
import { PanelHeader, SectionActions } from "../ui/primitives";
import { statusText } from "../ui/status";
import { StatusTag } from "../ui/statusTags";
import type { ServiceSnapshot, ServiceStatus } from "../types";

interface WebconsolePageProps {
  core?: ServiceSnapshot;
  webconsoleUrl: string;
  frameVersion: number;
  loadingAction?: string;
  onRefreshFrame: () => void;
  onOpenExternalUrl: (url: string) => void;
  onStartCore: () => void;
  onOpenInstallGuide: (step?: number) => void;
  onOpenLogs: () => void;
  onOpenEnvironment: () => void;
}

export default function WebconsolePage({
  core,
  webconsoleUrl,
  frameVersion,
  loadingAction,
  onRefreshFrame,
  onOpenExternalUrl,
  onStartCore,
  onOpenInstallGuide,
  onOpenLogs,
  onOpenEnvironment,
}: WebconsolePageProps) {
  const { message } = AntdApp.useApp();
  const coreStatus = core?.status ?? "uninitialized";
  const emptyState = buildWebconsoleEmptyState({
    core,
    coreStatus,
    onStartCore,
    onOpenInstallGuide,
    onOpenLogs,
    onOpenEnvironment,
  });

  function refreshFrame() {
    onRefreshFrame();
    message.success("WebConsole 框架已刷新");
  }

  async function copyUrl() {
    try {
      await copyText(webconsoleUrl);
      message.success("URL 已复制");
    } catch (error) {
      message.error(error instanceof Error ? error.message : `复制 URL 失败: ${String(error)}`);
    }
  }

  return (
    <section className="page-block">
      <PanelHeader
        title="WebConsole"
        description={displayText(webconsoleUrl, "Core 启动后加载本机 /app")}
        actions={
          <SectionActions>
            <StatusTag status={coreStatus} />
            <Button icon={<RefreshCcw size={16} />} onClick={refreshFrame} disabled={!webconsoleUrl}>
              刷新框架
            </Button>
            <Button icon={<Copy size={16} />} onClick={copyUrl} disabled={!webconsoleUrl}>
              复制 URL
            </Button>
            <Button
              icon={<ExternalLink size={16} />}
              loading={loadingAction === "open_external_url"}
              onClick={() => onOpenExternalUrl(webconsoleUrl)}
              disabled={!webconsoleUrl}
            >
              外部打开
            </Button>
          </SectionActions>
        }
      />
      {webconsoleUrl ? (
        <iframe
          key={frameVersion}
          className="webconsole-frame"
          data-frame-version={frameVersion}
          src={webconsoleUrl}
          title="GSDesk WebConsole"
        />
      ) : (
        <div className="webconsole-empty-state">
          <Empty description={emptyState.emptyText} />
          <Alert type={emptyState.type} showIcon title={emptyState.title} description={emptyState.detail} />
          <SectionActions>
            {emptyState.secondary && (
              <Button icon={emptyState.secondary.icon} onClick={emptyState.secondary.onClick}>
                {emptyState.secondary.label}
              </Button>
            )}
            <Button
              type="primary"
              icon={emptyState.primary.icon}
              loading={loadingAction === emptyState.primary.loadingKey}
              onClick={emptyState.primary.onClick}
            >
              {emptyState.primary.label}
            </Button>
          </SectionActions>
        </div>
      )}
    </section>
  );
}

type WebconsoleAction = {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  loadingKey?: string;
};

type WebconsoleEmptyState = {
  type: "success" | "info" | "warning" | "error";
  emptyText: string;
  title: string;
  detail: string;
  primary: WebconsoleAction;
  secondary?: WebconsoleAction;
};

function buildWebconsoleEmptyState({
  core,
  coreStatus,
  onStartCore,
  onOpenInstallGuide,
  onOpenLogs,
  onOpenEnvironment,
}: {
  core?: ServiceSnapshot;
  coreStatus: ServiceStatus;
  onStartCore: () => void;
  onOpenInstallGuide: (step?: number) => void;
  onOpenLogs: () => void;
  onOpenEnvironment: () => void;
}): WebconsoleEmptyState {
  if (coreStatus === "uninitialized") {
    return {
      type: "warning",
      emptyText: "Core 尚未初始化",
      title: "先完成首次安装引导",
      detail: "初始化会准备源码、隔离 uv/Python、venv 依赖，并在成功后启动 WebConsole。",
      primary: { label: "打开引导", icon: <Wrench size={16} />, onClick: () => onOpenInstallGuide(0) },
      secondary: { label: "环境检查", icon: <ListChecks size={16} />, onClick: onOpenEnvironment },
    };
  }

  if (coreStatus === "failed") {
    return {
      type: "error",
      emptyText: "Core 启动失败",
      title: "WebConsole 暂不可用",
      detail: displayText(core?.recentError, "先查看 Core JSONL 日志里的最后一个错误段，再决定是否重试启动。"),
      primary: { label: "查看日志", icon: <Terminal size={16} />, onClick: onOpenLogs },
      secondary: { label: "重新启动", icon: <Play size={16} />, onClick: onStartCore, loadingKey: "start" },
    };
  }

  if (coreStatus === "stopped") {
    return {
      type: "info",
      emptyText: "Core 已停止",
      title: "启动 Core 后加载 WebConsole",
      detail: "启动完成后 GSDesk 会检查 /app 是否可访问；端口策略仍按网络设置执行。",
      primary: { label: "启动 Core", icon: <Play size={16} />, onClick: onStartCore, loadingKey: "start" },
      secondary: { label: "环境检查", icon: <ListChecks size={16} />, onClick: onOpenEnvironment },
    };
  }

  if (coreStatus === "starting" || coreStatus === "initializing" || coreStatus === "checking") {
    return {
      type: "info",
      emptyText: statusText[coreStatus],
      title: "正在等待 Core 就绪",
      detail: "如果长时间没有变化，打开任务历史确认阶段，再查看日志里的启动输出。",
      primary: { label: "查看任务", icon: <ListChecks size={16} />, onClick: onOpenEnvironment },
      secondary: { label: "查看日志", icon: <Terminal size={16} />, onClick: onOpenLogs },
    };
  }

  if (coreStatus === "running") {
    return {
      type: "warning",
      emptyText: "WebConsole 未就绪",
      title: "Core 已运行，但 /app 暂不可访问",
      detail: "通常是启动还没完成、端口被代理影响，或 Core 内部初始化失败。先查看日志和 NO_PROXY。",
      primary: { label: "查看日志", icon: <Terminal size={16} />, onClick: onOpenLogs },
      secondary: { label: "环境检查", icon: <ListChecks size={16} />, onClick: onOpenEnvironment },
    };
  }

  return {
    type: "info",
    emptyText: "WebConsole 暂不可用",
    title: "当前状态暂不能打开 WebConsole",
    detail: "先确认 Core 状态，再按环境检查或日志继续排查。",
    primary: { label: "环境检查", icon: <ListChecks size={16} />, onClick: onOpenEnvironment },
    secondary: { label: "查看日志", icon: <Terminal size={16} />, onClick: onOpenLogs },
  };
}

async function copyText(text: string) {
  let clipboardError: unknown;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (error) {
      clipboardError = error;
    }
  }

  if (copyTextWithSelection(text)) return;

  if (clipboardError instanceof Error) {
    throw new Error(`复制 URL 失败: ${clipboardError.message}`);
  }
  throw new Error("复制 URL 失败: 当前 WebView 不允许访问剪贴板");
}

function copyTextWithSelection(text: string) {
  const element = document.createElement("textarea");
  element.value = text;
  element.setAttribute("readonly", "");
  element.style.position = "fixed";
  element.style.left = "-9999px";
  element.style.top = "0";
  element.style.opacity = "0";

  const selection = document.getSelection();
  const selectedRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : undefined;

  document.body.appendChild(element);
  element.select();
  element.setSelectionRange(0, element.value.length);

  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(element);
    if (selection && selectedRange) {
      selection.removeAllRanges();
      selection.addRange(selectedRange);
    }
  }
}
