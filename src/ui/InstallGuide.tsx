import { Alert, Button, Space, Steps, Typography } from "antd";
import { useEffect, type ReactNode } from "react";
import {
  Activity,
  ArrowRight,
  Cable,
  CheckCircle2,
  ExternalLink,
  Play,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import type {
  AppState,
  MirrorCheckResult,
  ServiceSnapshot,
  SourceProbeResult,
} from "../types";
import { StatusTag, statusText } from "./appShell";
import { ResultTag } from "./primitives";
import { getSetupProgress } from "./setupProgress";

const { Text, Title } = Typography;

interface InstallGuideProps {
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

interface GuideAction {
  label: string;
  icon: ReactNode;
  loadingKey?: string;
  onClick: () => void | Promise<boolean>;
}

interface GuideStep {
  title: string;
  done: boolean;
  error?: boolean;
  content: ReactNode;
  primary: GuideAction;
  secondary?: GuideAction;
}

export function InstallGuide(props: InstallGuideProps) {
  const {
    open,
    activeStep,
    loadingAction,
    setupRunning,
    onClose,
    onStepChange,
    onRunAll,
  } = props;
  const steps = buildGuideSteps(props);
  const current = clampStep(activeStep, steps.length);
  const step = steps[current];
  const runningTask = props.appState?.taskHistory.find((task) => task.status === "running");

  useEffect(() => {
    if (!open) return undefined;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div className="install-guide-overlay" role="dialog" aria-modal="true" aria-label="首次安装引导" data-testid="install-guide">
      <div className="install-guide-panel">
        <div className="install-guide-header">
          <Title level={4}>首次安装引导</Title>
          <Button
            type="text"
            icon={<X size={18} />}
            onClick={onClose}
            aria-label="关闭首次安装引导"
            data-testid="install-guide-close"
          />
        </div>
        <div className="install-guide-scroll">
          <div className="install-guide-body">
            <Alert
              type="info"
              showIcon
              message="按顺序完成网络、源码、镜像、初始化和启动；失败时先看日志，再做修复。"
            />
            <div className="guide-run-all">
              <div>
                <strong>一键初始化</strong>
                <Text type="secondary">自动测速源码源和 PyPI 镜像，然后初始化运行时、启动 Core、打开 WebConsole。</Text>
              </div>
              <Button type="primary" icon={<Play size={16} />} loading={setupRunning} disabled={Boolean(loadingAction)} onClick={onRunAll}>
                一键安装启动
              </Button>
            </div>
            {runningTask && (
              <Alert
                type="info"
                showIcon
                message={`当前任务：${runningTask.name} / ${runningTask.stage}`}
                description={runningTask.message}
              />
            )}
            <Steps
              current={current}
              size="small"
              items={steps.map((item, index) => ({
                title: item.title,
                status: stepStatus(current, index, item),
              }))}
              onChange={onStepChange}
              direction="horizontal"
              responsive={false}
              className="install-steps"
            />
            <div className="guide-action-panel">{step.content}</div>
          </div>
        </div>
        <GuideFooter
          current={current}
          loadingAction={loadingAction}
          primary={step.primary}
          secondary={step.secondary}
          onStepChange={onStepChange}
          onClose={onClose}
        />
      </div>
    </div>
  );
}

function buildGuideSteps({
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
  const hasError = core?.status === "failed" || core?.status === "crashed";
  const preflightIssues =
    appState?.preflightChecks.filter((check) => check.status === "block" || check.status === "warn") || [];

  return [
    {
      title: "预检",
      done: progress[0].done,
      error: progress[0].error,
      content: (
        <>
          <StepTitle index={1} title="环境预检与代理" />
          <p className="muted-block">
            代理会覆盖 Git、uv、Python 包下载和 Core 运行；默认保留
            <code> NO_PROXY=127.0.0.1,localhost,::1</code>，避免本机 WebConsole 被代理。
          </p>
          <div className="guide-summary-grid">
            <SummaryItem label="HTTP_PROXY" value={appState?.settings.proxy.httpProxy || "未设置"} />
            <SummaryItem label="HTTPS_PROXY" value={appState?.settings.proxy.httpsProxy || "未设置"} />
            <SummaryItem label="ALL_PROXY" value={appState?.settings.proxy.allProxy || "未设置"} />
            <SummaryItem label="NO_PROXY" value={appState?.settings.proxy.noProxy || "未设置"} />
          </div>
          <ResultList
            emptyText="预检无阻断或警告。"
            items={preflightIssues.map((item) => ({
              key: item.id,
              name: item.label,
              detail: item.action || item.detail,
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
        label: "配置代理",
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
            默认自动测速 GitHub 与 CNB。国内网络通常 CNB 更稳，海外网络通常 GitHub 更直接；用户也可以在设置里锁定来源。
          </p>
          <div className="guide-summary-grid">
            <SummaryItem label="策略" value={appState?.settings.sourceMode || "auto"} />
            <SummaryItem label="当前源" value={appState?.settings.selectedSource || "未设置"} />
          </div>
          <ResultList
            emptyText="还没有探测结果。"
            items={sourceResults.map((item) => ({
              key: item.id,
              name: item.name,
              detail: item.latencyMs ? `${item.latencyMs}ms` : item.error || item.url,
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
          <p className="muted-block">先探测 simple 页面，再做有限下载测速，按可用性和速度推荐。</p>
          <div className="guide-summary-grid">
            <SummaryItem label="镜像策略" value={appState?.settings.pypiIndexMode === "manual" ? "手动锁定" : "自动选择"} />
            <SummaryItem label="当前镜像" value={appState?.settings.pypiIndexUrl || "未设置"} />
            <SummaryItem
              label="uv"
              value={
                appState?.toolchain.uvDetected
                  ? `${appState.toolchain.uvVersion || "可用"} / ${appState.toolchain.uvSource}`
                  : appState?.toolchain.uvBootstrapSupported
                    ? "未安装；一键流程会安装到隔离目录"
                    : "未安装；当前平台需手动安装"
              }
            />
          </div>
          <ResultList
            emptyText="还没有测速结果。"
            items={mirrorResults.map((item) => ({
              key: item.url,
              name: item.name,
              detail: item.ok
                ? `${item.latencyMs || "-"}ms / ${item.speedMbps ? `${item.speedMbps.toFixed(2)} MB/s` : "未测速"}`
                : item.error || item.url,
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
            初始化会创建隔离目录，拉取 gsuid_core，安装 uv 托管的 CPython 3.12，并同步项目依赖；不会写用户全局
            Git、pip、uv 或 Python 配置。
          </p>
          <div className="guide-summary-grid">
            <SummaryItem label="uv" value={appState?.toolchain.uvPath || appState?.toolchain.uvBootstrapTarget || "-"} />
            <SummaryItem label="Core" value={appState?.paths.coreDir || "-"} />
            <SummaryItem label="venv" value={appState?.paths.venvDir || "-"} />
            <SummaryItem label="uv cache" value={appState?.paths.uvCacheDir || "-"} />
            <SummaryItem label="Python installs" value={appState?.paths.uvPythonDir || "-"} />
          </div>
          {core?.recentError && <Alert type="error" showIcon message={core.recentError} />}
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
            <SummaryItem label="状态" value={statusText[core?.status || "uninitialized"]} />
            <SummaryItem label="端口" value={core?.port ? String(core.port) : "-"} />
            <SummaryItem label="进程" value={core?.pid ? String(core.pid) : "-"} />
            <SummaryItem label="地址" value={core?.url || "-"} />
          </div>
          {core?.recentError && <Alert type="error" showIcon message={core.recentError} />}
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
            <SummaryItem label="地址" value={core?.url ? `${core.url}/app` : "-"} />
          </div>
          <StatusTag status={core?.status || "uninitialized"} />
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

function GuideFooter({
  current,
  loadingAction,
  primary,
  secondary,
  onStepChange,
  onClose,
}: {
  current: number;
  loadingAction?: string;
  primary: GuideAction;
  secondary?: GuideAction;
  onStepChange: (step: number) => void;
  onClose: () => void;
}) {
  return (
    <div className="guide-footer">
      <Button onClick={onClose} data-testid="install-guide-dismiss">
        稍后再说
      </Button>
      <Space wrap>
        {secondary && (
          <Button icon={secondary.icon} onClick={secondary.onClick} data-testid="install-guide-secondary">
            {secondary.label}
          </Button>
        )}
        <Button disabled={current === 0} onClick={() => onStepChange(current - 1)} data-testid="install-guide-prev">
          上一步
        </Button>
        <Button
          type="primary"
          icon={primary.icon}
          loading={Boolean(primary.loadingKey && primary.loadingKey === loadingAction)}
          onClick={primary.onClick}
          data-testid="install-guide-primary"
        >
          {primary.label}
        </Button>
      </Space>
    </div>
  );
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
  return <Title level={5}>{index}. {title}</Title>;
}

function clampStep(activeStep: number, length: number) {
  return Math.min(Math.max(activeStep, 0), length - 1);
}

function stepStatus(current: number, index: number, step: GuideStep) {
  if (step.error && current === index) return "error" as const;
  if (step.done) return "finish" as const;
  if (current === index) return "process" as const;
  return "wait" as const;
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <Text type="secondary">{label}</Text>
      <code>{value}</code>
    </div>
  );
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
