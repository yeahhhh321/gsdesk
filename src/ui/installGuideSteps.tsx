import { Alert, Typography } from "antd";
import type { ReactNode } from "react";
import { Activity, ArrowRight, Cable, CheckCircle2, ExternalLink, Play, Terminal, Wrench } from "lucide-react";
import type { AppState, MirrorCheckResult, ServiceSnapshot, SourceProbeResult } from "../types";
import { displayNumber, displayText } from "./format";
import { ResultTag } from "./primitives";
import { getSetupProgress } from "./setupProgress";
import { isFailedServiceStatus, statusText } from "./status";
import { StatusTag } from "./statusTags";
import { isBeginnerMode } from "./userMode";

const { Text, Title } = Typography;

export interface InstallGuideProps {
  open: boolean;
  activeStep: number;
  appState?: AppState;
  core?: ServiceSnapshot;
  sourceResults: SourceProbeResult[];
  mirrorResults: MirrorCheckResult[];
  loadingAction?: string;
  setupRunning?: boolean;
  onClose: () => void;
  onStepChange: (step: number) => void;
  onOpenNetwork: () => void;
  onOpenLogs: () => void;
  onProbeSources: () => Promise<boolean>;
  onCheckMirrors: () => Promise<boolean>;
  onRunAll: () => Promise<boolean>;
  onInitRuntime: () => Promise<boolean>;
  onStartCore: () => Promise<boolean>;
  onOpenWebconsole: () => Promise<boolean>;
}

export interface GuideAction {
  label: string;
  icon: ReactNode;
  loadingKey?: string;
  onClick: () => void | Promise<boolean>;
}

export interface GuideStep {
  title: string;
  done: boolean;
  error?: boolean;
  content: ReactNode;
  primary: GuideAction;
  secondary?: GuideAction;
}

export function buildGuideSteps({
  appState,
  core,
  sourceResults,
  mirrorResults,
  onStepChange,
  onOpenNetwork,
  onOpenLogs,
  onProbeSources,
  onCheckMirrors,
  onInitRuntime,
  onStartCore,
  onOpenWebconsole,
}: InstallGuideProps): GuideStep[] {
  const progress = getSetupProgress({ appState, core, sourceResults, mirrorResults });
  const hasError = isFailedServiceStatus(core?.status);
  const preflightIssues = getPreflightIssues(appState);
  const settings = appState?.settings;
  const beginnerMode = isBeginnerMode(settings);
  const toolchain = appState?.toolchain;
  const paths = appState?.paths;

  return [
    {
      title: "预检",
      done: progress[0].done,
      error: progress[0].error,
      content: (
        <>
          <StepTitle index={1} title="环境预检与代理" />
          <p className="muted-block">
            {beginnerMode
              ? "先检查电脑环境是否能直接启动。GSDesk 完整安装包已包含 Git 和 Python，不需要用户手动打开命令行。"
              : "代理会覆盖 Git、uv、Python 包下载和 Core 运行；默认保留 NO_PROXY=127.0.0.1,localhost,::1，避免本机 WebConsole 被代理。"}
          </p>
          <div className="guide-summary-grid">
            <SummaryItem
              label="源码工具"
              value={
                toolchain?.gitDetected
                  ? `${gitSourceText(toolchain.gitSource)} Git 可用`
                  : displayText(toolchain?.gitError, "缺少内置 Git")
              }
            />
            {!beginnerMode && (
              <>
                <SummaryItem label="HTTP_PROXY" value={displayText(settings?.proxy.httpProxy, "未设置")} />
                <SummaryItem label="HTTPS_PROXY" value={displayText(settings?.proxy.httpsProxy, "未设置")} />
                <SummaryItem label="ALL_PROXY" value={displayText(settings?.proxy.allProxy, "未设置")} />
                <SummaryItem label="NO_PROXY" value={displayText(settings?.proxy.noProxy, "未设置")} />
              </>
            )}
          </div>
          <ResultList
            emptyText="预检无阻断或警告。"
            items={preflightIssues.map((item) => ({
              key: item.id,
              name: item.label,
              detail: displayText(item.action, item.detail),
              ok: item.status !== "block",
            }))}
          />
        </>
      ),
      primary: {
        label: "下一步",
        icon: <ArrowRight size={16} />,
        onClick: () => onStepChange(1),
      },
      secondary: {
        label: beginnerMode ? "网络设置" : "配置代理",
        icon: <Cable size={16} />,
        onClick: onOpenNetwork,
      },
    },
    {
      title: "源码",
      done: progress[1].done,
      content: (
        <>
          <StepTitle index={2} title="选择源码源" />
          <p className="muted-block">
            {beginnerMode
              ? "GSDesk 会自动测试可用源码源，并保存当前网络下更容易成功的那个。"
              : "默认自动测速 GitHub 与 CNB。国内网络通常 CNB 更稳，海外网络通常 GitHub 更直接；用户也可以在设置里锁定来源。"}
          </p>
          <div className="guide-summary-grid">
            <SummaryItem label="选择方式" value={beginnerMode ? "自动选择" : (settings?.sourceMode ?? "auto")} />
            {!beginnerMode && <SummaryItem label="当前源" value={displayText(settings?.selectedSource, "未设置")} />}
          </div>
          <ResultList
            emptyText="还没有探测结果。"
            items={sourceResults.map((item) => ({
              key: item.id,
              name: item.name,
              detail: sourceProbeDetail(item),
              ok: item.ok,
            }))}
          />
        </>
      ),
      primary: {
        label: "探测源码源",
        icon: <Activity size={16} />,
        loadingKey: "probe_sources",
        onClick: onProbeSources,
      },
      secondary: {
        label: "使用当前源",
        icon: <ArrowRight size={16} />,
        onClick: () => onStepChange(2),
      },
    },
    {
      title: "镜像",
      done: progress[2].done,
      content: (
        <>
          <StepTitle index={3} title="PyPI 镜像测速" />
          <p className="muted-block">
            {beginnerMode
              ? "GSDesk 会自动找一个能下载 Python 依赖的源，避免用户手动复制镜像地址。"
              : "先探测 simple 页面，再做有限下载测速，按可用性和速度推荐。"}
          </p>
          <div className="guide-summary-grid">
            <SummaryItem
              label="镜像策略"
              value={beginnerMode ? "自动选择" : settings?.pypiIndexMode === "manual" ? "手动锁定" : "自动选择"}
            />
            {!beginnerMode && <SummaryItem label="当前镜像" value={displayText(settings?.pypiIndexUrl, "未设置")} />}
            <SummaryItem
              label="uv"
              value={
                toolchain?.uvDetected
                  ? `${displayText(toolchain.uvVersion, "可用")} / ${toolchain.uvSource}`
                  : toolchain?.uvBootstrapSupported
                    ? "未安装；一键流程会用内置 Python 创建"
                    : "未安装；当前构建未提供内置 Python"
              }
            />
            <SummaryItem label="内置 Python" value={toolchain?.bundledPythonAvailable ? "可用" : "未随当前构建提供"} />
          </div>
          <ResultList
            emptyText="还没有测速结果。"
            items={mirrorResults.map((item) => ({
              key: item.url,
              name: item.name,
              detail: mirrorCheckDetail(item),
              ok: item.ok,
            }))}
          />
        </>
      ),
      primary: {
        label: "测速镜像",
        icon: <Activity size={16} />,
        loadingKey: "check_mirrors",
        onClick: onCheckMirrors,
      },
      secondary: {
        label: "使用当前镜像",
        icon: <ArrowRight size={16} />,
        onClick: () => onStepChange(3),
      },
    },
    {
      title: "初始化",
      done: progress[3].done,
      error: progress[3].error,
      content: (
        <>
          <StepTitle index={4} title="初始化 Core 运行时" />
          <p className="muted-block">
            {beginnerMode
              ? "GSDesk 会在自己的数据目录里准备 Core、Git 和 Python 环境，不会改系统环境，也不会要求用户手动打开命令行。"
              : "初始化会创建隔离目录，用内置 Git 拉取 gsuid_core，用壳内置 Python 创建并更新 uv，再复制内置 CPython 3.12 并同步项目依赖；不会写用户全局 Git、pip、uv 或 Python 配置。"}
          </p>
          <div className="guide-summary-grid">
            <SummaryItem
              label="内置 Git"
              value={
                beginnerMode
                  ? toolchain?.gitDetected
                    ? "可用"
                    : "当前构建未提供"
                  : displayText(toolchain?.gitPath, displayText(toolchain?.bundledGitPath, "当前构建未提供"))
              }
            />
            <SummaryItem label="uv" value={displayText(toolchain?.uvPath, displayText(toolchain?.uvBootstrapTarget, "-"))} />
            {!beginnerMode && <SummaryItem label="Core" value={displayText(paths?.coreDir, "-")} />}
            {!beginnerMode && <SummaryItem label="venv" value={displayText(paths?.venvDir, "-")} />}
            {!beginnerMode && <SummaryItem label="uv cache" value={displayText(paths?.uvCacheDir, "-")} />}
            {!beginnerMode && <SummaryItem label="Python installs" value={displayText(paths?.uvPythonDir, "-")} />}
            <SummaryItem label="内置 Python" value={displayText(toolchain?.bundledPythonPath, "当前构建未提供")} />
          </div>
          {core?.recentError && <Alert type="error" showIcon title={core.recentError} />}
        </>
      ),
      primary: {
        label: "初始化",
        icon: <Wrench size={16} />,
        loadingKey: "init",
        onClick: onInitRuntime,
      },
      secondary: errorLogAction(hasError, onOpenLogs),
    },
    {
      title: "启动",
      done: progress[4].done,
      error: progress[4].error,
      content: (
        <>
          <StepTitle index={5} title="启动 gsuid_core" />
          <p className="muted-block">
            默认优先使用 <code>8765</code> 端口，被占用时自动选择 <code>8766-8865</code>，界面会显示实际端口。
          </p>
          <div className="guide-summary-grid">
            <SummaryItem label="状态" value={statusText[core?.status ?? "uninitialized"]} />
            <SummaryItem label="端口" value={displayNumber(core?.port, "-")} />
            <SummaryItem label="进程" value={displayNumber(core?.pid, "-")} />
            <SummaryItem label="地址" value={displayText(core?.url, "-")} />
          </div>
          {core?.recentError && <Alert type="error" showIcon title={core.recentError} />}
        </>
      ),
      primary: {
        label: "启动 Core",
        icon: <Play size={16} />,
        loadingKey: "start",
        onClick: onStartCore,
      },
      secondary: errorLogAction(hasError, onOpenLogs),
    },
    {
      title: "控制台",
      done: progress[5].done,
      content: (
        <>
          <StepTitle index={6} title="打开 WebConsole" />
          <p className="muted-block">
            Core 启动后打开 <code>/app</code>，直接进入 gsuid_core 自带 WebConsole。v1 不重写 WebConsole。
          </p>
          <div className="guide-summary-grid">
            <SummaryItem label="WebConsole" value={core?.webconsoleAvailable ? "可访问" : "等待 Core 就绪"} />
            <SummaryItem label="地址" value={webconsoleUrl(core)} />
          </div>
          <StatusTag status={core?.status ?? "uninitialized"} />
        </>
      ),
      primary: {
        label: "打开 WebConsole",
        icon: <ExternalLink size={16} />,
        loadingKey: "open_webconsole",
        onClick: onOpenWebconsole,
      },
    },
  ];
}

function errorLogAction(hasError: boolean, onOpenLogs: () => void): GuideAction | undefined {
  if (!hasError) return undefined;
  return {
    label: "查看日志",
    icon: <Terminal size={16} />,
    onClick: onOpenLogs,
  };
}

function StepTitle({ index, title }: { index: number; title: string }) {
  return (
    <Title level={5}>
      {index}. {title}
    </Title>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <Text type="secondary">{label}</Text>
      <code>{value}</code>
    </div>
  );
}

function gitSourceText(value?: string) {
  if (value === "bundle") return "内置";
  if (value === "runtime") return "运行时";
  if (value === "system") return "系统";
  if (value === "missing") return "缺失";
  return displayText(value, "未知");
}

function ResultList({
  emptyText,
  items,
}: {
  emptyText: string;
  items: Array<{ key: string; name: string; detail: string; ok: boolean }>;
}) {
  if (!items.length) return <p className="guide-empty">{emptyText}</p>;
  return (
    <div className="guide-result-list">
      {items.map((item) => (
        <div key={item.key}>
          {item.ok ? <CheckCircle2 size={16} className="guide-ok" /> : <span className="guide-error-dot" />}
          <strong>{item.name}</strong>
          <span className="guide-result-detail">{item.detail}</span>
          <ResultTag ok={item.ok} />
        </div>
      ))}
    </div>
  );
}

function getPreflightIssues(appState?: AppState) {
  if (!appState) return [];
  return appState.preflightChecks.filter((check) => check.status === "block" || check.status === "warn");
}

function sourceProbeDetail(item: SourceProbeResult) {
  if (!item.ok) return displayText(item.error, item.url);
  if (item.latencyMs !== undefined) return `${item.latencyMs}ms`;
  return displayText(item.error, item.url);
}

function mirrorCheckDetail(item: MirrorCheckResult) {
  if (!item.ok) return displayText(item.error, item.url);
  const latency = item.latencyMs === undefined ? "-" : String(item.latencyMs);
  const speed = item.speedMbps === undefined ? "未测速" : `${item.speedMbps.toFixed(2)} MB/s`;
  return `${latency}ms / ${speed}`;
}

function webconsoleUrl(core?: ServiceSnapshot) {
  if (!core?.url) return "-";
  return `${core.url}/app`;
}
