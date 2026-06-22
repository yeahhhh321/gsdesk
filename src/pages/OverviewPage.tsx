import type { ReactNode } from "react";
import { Alert, Button, Typography } from "antd";
import { ExternalLink, ListChecks, Play, Square, Terminal, Wrench } from "lucide-react";
import { displayNumber, displaySecondsFromMilliseconds, displayText } from "../ui/format";
import { PanelHeader, SectionActions } from "../ui/primitives";
import { statusText } from "../ui/status";
import { PreflightStatusTag, StatusTag, TaskStatusTag } from "../ui/statusTags";
import { isBeginnerMode } from "../ui/userMode";
import type { AppState, PreflightCheck, ServiceSnapshot, ServiceStatus, Settings, TaskRecord, ToolchainInfo } from "../types";
import type { SetupProgressItem } from "../ui/setupProgress";

const { Text } = Typography;

interface OverviewPageProps {
  appState?: AppState;
  core?: ServiceSnapshot;
  setupChecklist: SetupProgressItem[];
  loadingAction?: string;
  onStartCore: () => void;
  onStopCore: () => void;
  onOpenWebconsole: () => void;
  onOpenInstallGuide: (step?: number) => void;
  onOpenEnvironment: () => void;
  onOpenOperations: () => void;
  onOpenLogs: () => void;
}

const PREFLIGHT_LIMIT = 4;
const TASK_LIMIT = 2;

export default function OverviewPage({
  appState,
  core,
  setupChecklist,
  loadingAction,
  onStartCore,
  onStopCore,
  onOpenWebconsole,
  onOpenInstallGuide,
  onOpenEnvironment,
  onOpenOperations,
  onOpenLogs,
}: OverviewPageProps) {
  const coreStatus = core?.status ?? "uninitialized";
  const beginnerMode = isBeginnerMode(appState?.settings);
  const preflightChecks = appState?.preflightChecks ?? [];
  const blockingChecks = preflightChecks.filter((check) => check.status === "block");
  const warningChecks = preflightChecks.filter((check) => check.status === "warn");
  const visiblePreflight = sortPreflightChecks(preflightChecks);
  const actionablePreflight = visiblePreflight.filter((check) => check.status !== "ok");
  const compactPreflight = (actionablePreflight.length ? actionablePreflight : visiblePreflight).slice(0, PREFLIGHT_LIMIT);
  const hiddenPreflightCount = Math.max(visiblePreflight.length - compactPreflight.length, 0);
  const taskHistory = appState?.taskHistory ?? [];
  const compactTasks = beginnerMode ? [] : taskHistory.slice(0, TASK_LIMIT);
  const hiddenTaskCount = Math.max(taskHistory.length - compactTasks.length, 0);
  const portPolicy = `固定 ${appState?.settings.preferredCorePort ?? 8765}`;
  const settingsItems = appState ? createSettingsItems(appState.settings, appState.toolchain, beginnerMode) : [];
  const lifecycleAction = getLifecycleAction(coreStatus);
  const lifecycleLoading = Boolean(lifecycleAction.loadingKey && loadingAction === lifecycleAction.loadingKey);
  const runLifecycleAction = lifecycleAction.kind === "stop" ? onStopCore : onStartCore;
  const nextAction = buildOverviewNextAction({
    core,
    coreStatus,
    blockingChecks,
    runningTask: beginnerMode ? undefined : taskHistory.find((task) => task.status === "running"),
    failedTask: beginnerMode ? undefined : taskHistory.find((task) => task.status === "failed"),
    onStartCore,
    onOpenWebconsole,
    onOpenInstallGuide,
    onOpenEnvironment,
    onOpenOperations,
    onOpenLogs,
  });

  return (
    <section className="overview-dashboard overview-dashboard-compact">
      <div className="wide-panel overview-control-strip">
        <PanelHeader
          title="Gsuid Core 总控"
          description="只保留启动判断、阻断项、当前任务和关键入口"
          actions={<StatusTag status={coreStatus} />}
        />
        <div className="overview-control-grid">
          <div className="overview-primary-state">
            <Text type="secondary">当前状态</Text>
            <strong>{statusText[coreStatus]}</strong>
            <small>{core?.healthOk ? "WebConsole 健康检查通过" : "启动后自动检查 WebConsole"}</small>
          </div>
          <div className="overview-compact-status-grid">
            <OverviewMetric label="端口" value={displayNumber(core?.port, "未分配")} detail={portPolicy} />
            <OverviewMetric
              label="WebConsole"
              value={core?.webconsoleAvailable ? "可访问" : "未就绪"}
              detail={displayText(core?.url, "启动后生成")}
            />
            <OverviewMetric
              label="预检"
              value={preflightSummary(blockingChecks.length, warningChecks.length)}
              detail={visiblePreflight.length ? "按阻断优先排序" : "等待状态刷新"}
            />
            <OverviewMetric
              label="Commit"
              value={displayText(core?.currentCommit, "-")}
              detail={displayText(core?.currentTag, "无 tag")}
            />
            <OverviewMetric label="工具链" value={toolchainStatus(appState)} detail={toolchainDetail(appState)} />
            {!beginnerMode && (
              <OverviewMetric
                label="任务"
                value={taskStatusSummary(taskHistory)}
                detail={taskHistory[0] ? taskHistory[0].name : "暂无任务"}
              />
            )}
          </div>
          <SectionActions>
            <Button
              type={lifecycleAction.kind === "start" ? "primary" : "default"}
              icon={lifecycleAction.kind === "stop" ? <Square size={16} /> : <Play size={16} />}
              loading={lifecycleLoading}
              disabled={lifecycleAction.disabled}
              onClick={runLifecycleAction}
            >
              {lifecycleAction.label}
            </Button>
            <Button icon={<ExternalLink size={16} />} loading={loadingAction === "open_webconsole"} onClick={onOpenWebconsole}>
              打开 WebConsole
            </Button>
          </SectionActions>
        </div>
        {nextAction && (
          <Alert
            className="overview-next-action"
            type={nextAction.type}
            showIcon
            title={nextAction.title}
            description={nextAction.detail}
            action={
              <SectionActions>
                {nextAction.secondary && (
                  <Button size="small" icon={nextAction.secondaryIcon} onClick={nextAction.secondary.onClick}>
                    {nextAction.secondary.label}
                  </Button>
                )}
                <Button size="small" type="primary" icon={nextAction.primaryIcon} onClick={nextAction.primary.onClick}>
                  {nextAction.primary.label}
                </Button>
              </SectionActions>
            }
          />
        )}
      </div>

      <div className="wide-panel overview-preflight-panel overview-compact-panel">
        <PanelHeader
          title="预检与阻断项"
          actions={
            <Button icon={<Wrench size={16} />} onClick={onOpenEnvironment}>
              处理
            </Button>
          }
        />
        <div className="overview-check-list">
          {compactPreflight.map((check) => (
            <div className={`overview-check-item ${check.status}`} key={check.id}>
              <div>
                <strong>{check.label}</strong>
                <p>{displayText(check.action, check.detail)}</p>
              </div>
              <PreflightStatusTag status={check.status} />
            </div>
          ))}
          {!compactPreflight.length && <p className="muted-block">等待预检结果。</p>}
          {hiddenPreflightCount > 0 && (
            <p className="overview-more-line">另有 {hiddenPreflightCount} 项通过或在环境预检页查看。</p>
          )}
        </div>
      </div>

      <div className="wide-panel overview-settings-panel overview-compact-panel">
        <PanelHeader title={beginnerMode ? "当前自动配置" : "网络与策略"} />
        <OverviewInfoGrid items={settingsItems} />
      </div>

      {!beginnerMode && (
        <div className="wide-panel overview-task-panel overview-compact-panel">
          <PanelHeader
            title="操作记录"
            actions={
              <Button icon={<ListChecks size={16} />} onClick={onOpenOperations}>
                查看
              </Button>
            }
          />
          <div className="overview-task-list">
            {compactTasks.map((task) => (
              <div className="overview-task-item" key={task.id}>
                <TaskStatusTag status={task.status} />
                <div>
                  <strong>{task.name}</strong>
                  <small>
                    {task.stage} · {formatTime(task.startedAt)}
                  </small>
                </div>
                <p>{task.message}</p>
                <span>{displaySecondsFromMilliseconds(task.elapsedMs, task.status === "running" ? "进行中" : "-")}</span>
              </div>
            ))}
            {!compactTasks.length && <p className="muted-block">暂无操作记录。</p>}
            {hiddenTaskCount > 0 && <p className="overview-more-line">还有 {hiddenTaskCount} 条在操作记录里查看。</p>}
          </div>
        </div>
      )}

      <div className="wide-panel overview-guide-panel overview-compact-panel">
        <PanelHeader
          title="首次安装引导"
          actions={
            <Button type="primary" icon={<Wrench size={16} />} onClick={() => onOpenInstallGuide(0)}>
              打开引导
            </Button>
          }
        />
        <div className="wizard-line">
          {setupChecklist.map((step, index) => (
            <button
              type="button"
              key={step.label}
              className={`wizard-step ${step.done ? "ready" : ""}`}
              onClick={() => onOpenInstallGuide(index)}
            >
              <span>{step.done ? "✓" : index + 1}</span>
              <strong>{step.label}</strong>
              <small>{step.detail}</small>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

interface OverviewMetricProps {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
}

function OverviewMetric({ label, value, detail }: OverviewMetricProps) {
  return (
    <div className="overview-metric-cell">
      <Text type="secondary">{label}</Text>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  );
}

interface OverviewInfoItem {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
}

function OverviewInfoGrid({ items }: { items: OverviewInfoItem[] }) {
  return (
    <div className="overview-info-grid">
      {items.map((item) => (
        <div className="overview-info-item" key={item.label}>
          <Text type="secondary">{item.label}</Text>
          <strong>{item.value}</strong>
          {item.detail && <small>{item.detail}</small>}
        </div>
      ))}
    </div>
  );
}

function createSettingsItems(settings: Settings, toolchain: ToolchainInfo, beginnerMode: boolean): OverviewInfoItem[] {
  if (beginnerMode) {
    return [
      { label: "使用模式", value: "小白模式", detail: "只显示直接可用的操作" },
      {
        label: "源码工具",
        value: toolchain.gitDetected ? "已准备好" : "当前安装包不完整",
        detail: toolchain.gitDetected ? gitSourceText(toolchain.gitSource) : displayText(toolchain.gitError, "缺少内置 Git"),
      },
      {
        label: "下载源",
        value: sourceModeText(settings.sourceMode),
        detail: displayText(settings.selectedSource, "自动选择可用源"),
      },
      { label: "PyPI", value: pypiModeText(settings.pypiIndexMode), detail: displayText(settings.pypiIndexUrl, "自动选择镜像") },
      {
        label: "端口",
        value: `固定 ${settings.preferredCorePort ?? 8765}`,
        detail: "默认 8765",
      },
      { label: "关闭窗口", value: settings.hideToTrayOnClose ? "隐藏到托盘" : "退出 GSDesk" },
    ];
  }

  return [
    {
      label: "源码工具",
      value: toolchain.gitDetected ? gitSourceText(toolchain.gitSource) : "不可用",
      detail: toolchain.gitDetected ? displayText(toolchain.gitVersion, "Git 可用") : displayText(toolchain.gitError, "缺少 Git"),
    },
    { label: "源码源", value: sourceModeText(settings.sourceMode), detail: displayText(settings.selectedSource, "未设置源码源") },
    { label: "PyPI", value: pypiModeText(settings.pypiIndexMode), detail: displayText(settings.pypiIndexUrl, "未设置镜像") },
    {
      label: "端口",
      value: `固定 ${settings.preferredCorePort ?? 8765}`,
      detail: "启动时严格使用该端口",
    },
    { label: "代理", value: proxySummary(settings.proxy), detail: "HTTP / HTTPS / ALL / NO_PROXY" },
    {
      label: "退出时 Core",
      value: settings.closeCoreOnExit ? "关闭" : "后台保留",
      detail: settings.hideToTrayOnClose ? "窗口隐藏到托盘" : "窗口关闭即退出",
    },
  ];
}

function sortPreflightChecks(checks: PreflightCheck[]) {
  return [...checks].sort((left, right) => preflightPriority(left.status) - preflightPriority(right.status));
}

function preflightPriority(status: PreflightCheck["status"]) {
  if (status === "block") return 0;
  if (status === "warn") return 1;
  return 2;
}

function preflightSummary(blockingCount: number, warningCount: number) {
  if (blockingCount > 0) return `${blockingCount} 阻断`;
  if (warningCount > 0) return `${warningCount} 警告`;
  return "无阻断";
}

function taskStatusSummary(tasks: TaskRecord[]) {
  const runningTask = tasks.find((task) => task.status === "running");
  if (runningTask) return "进行中";
  const failedTask = tasks.find((task) => task.status === "failed");
  if (failedTask) return "有失败";
  if (tasks.length > 0) return "已记录";
  return "暂无";
}

function toolchainStatus(appState?: AppState) {
  if (!appState) return "等待刷新";
  if (appState.uvDetected && appState.toolchain.gitDetected) return "已就绪";
  return "需处理";
}

function toolchainDetail(appState?: AppState) {
  if (!appState) return "uv / Git";
  const uvText = appState.uvDetected ? "uv 可用" : "uv 缺失";
  const gitText = appState.toolchain.gitDetected ? "Git 可用" : "Git 缺失";
  return `${uvText} · ${gitText}`;
}

function sourceModeText(value: Settings["sourceMode"]) {
  if (value === "github") return "固定 GitHub";
  if (value === "cnb") return "固定 CNB";
  return "自动选择";
}

function gitSourceText(value?: string) {
  if (value === "bundle") return "内置";
  if (value === "runtime") return "运行时";
  if (value === "system") return "系统";
  if (value === "missing") return "缺失";
  return displayText(value, "未知");
}

function pypiModeText(value: Settings["pypiIndexMode"]) {
  if (value === "manual") return "手动锁定";
  return "自动选择";
}

function proxySummary(proxy: Settings["proxy"]) {
  const values = [proxy.httpProxy, proxy.httpsProxy, proxy.allProxy, proxy.noProxy];
  let configuredCount = 0;
  for (const value of values) {
    if (displayText(value, "").length > 0) configuredCount += 1;
  }
  if (configuredCount > 0) return `${configuredCount} 项已设置`;
  return "未设置";
}

function formatTime(value?: string) {
  const text = displayText(value, "");
  if (!text) return "-";
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  return date.toLocaleTimeString();
}

type LifecycleAction = {
  kind: "start" | "stop";
  label: string;
  loadingKey?: "start" | "stop";
  disabled?: boolean;
};

type OverviewActionButton = {
  label: string;
  onClick: () => void;
};

type OverviewNextAction = {
  type: "success" | "info" | "warning" | "error";
  title: string;
  detail: string;
  primary: OverviewActionButton;
  primaryIcon: ReactNode;
  secondary?: OverviewActionButton;
  secondaryIcon?: ReactNode;
};

function buildOverviewNextAction({
  core,
  coreStatus,
  blockingChecks,
  runningTask,
  failedTask,
  onStartCore,
  onOpenWebconsole,
  onOpenInstallGuide,
  onOpenEnvironment,
  onOpenOperations,
  onOpenLogs,
}: {
  core?: ServiceSnapshot;
  coreStatus: ServiceStatus;
  blockingChecks: Array<{ label: string; detail: string; action?: string }>;
  runningTask?: TaskRecord;
  failedTask?: TaskRecord;
  onStartCore: () => void;
  onOpenWebconsole: () => void;
  onOpenInstallGuide: (step?: number) => void;
  onOpenEnvironment: () => void;
  onOpenOperations: () => void;
  onOpenLogs: () => void;
}): OverviewNextAction {
  if (runningTask) {
    return {
      type: "info",
      title: `当前任务：${runningTask.name}`,
      detail: `${runningTask.stage} · ${runningTask.message}`,
      primary: { label: "查看记录", onClick: onOpenOperations },
      primaryIcon: <ListChecks size={14} />,
      secondary: { label: "看日志", onClick: onOpenLogs },
      secondaryIcon: <Terminal size={14} />,
    };
  }

  const firstBlocker = blockingChecks[0];
  if (firstBlocker) {
    return {
      type: "error",
      title: `先处理阻断项：${firstBlocker.label}`,
      detail: displayText(firstBlocker.action, firstBlocker.detail),
      primary: { label: "去修复", onClick: onOpenEnvironment },
      primaryIcon: <Wrench size={14} />,
      secondary: { label: "打开引导", onClick: () => onOpenInstallGuide(0) },
      secondaryIcon: <ListChecks size={14} />,
    };
  }

  if (coreStatus === "uninitialized") {
    return {
      type: "warning",
      title: "运行时尚未初始化",
      detail: "按首次安装引导完成源码源、PyPI 镜像、uv/Python 和 Core 初始化。",
      primary: { label: "打开引导", onClick: () => onOpenInstallGuide(0) },
      primaryIcon: <Wrench size={14} />,
    };
  }

  if (coreStatus === "failed") {
    return {
      type: "error",
      title: "Core 启动失败",
      detail: displayText(
        core?.recentError,
        failedTask ? `${failedTask.stage} · ${failedTask.message}` : "先查看最近日志，再重试启动。",
      ),
      primary: { label: "查看日志", onClick: onOpenLogs },
      primaryIcon: <Terminal size={14} />,
      secondary: { label: "重新启动", onClick: onStartCore },
      secondaryIcon: <Play size={14} />,
    };
  }

  if (coreStatus === "stopped") {
    return {
      type: "info",
      title: "运行时已就绪",
      detail: "可以直接启动 Core；启动后会自动检查 WebConsole。",
      primary: { label: "启动 Core", onClick: onStartCore },
      primaryIcon: <Play size={14} />,
    };
  }

  if (coreStatus === "running" && !core?.webconsoleAvailable) {
    return {
      type: "warning",
      title: "Core 已运行，WebConsole 未就绪",
      detail: "如果等待超过一分钟，优先查看 Core JSONL 日志和网络 NO_PROXY 设置。",
      primary: { label: "查看日志", onClick: onOpenLogs },
      primaryIcon: <Terminal size={14} />,
      secondary: { label: "环境检查", onClick: onOpenEnvironment },
      secondaryIcon: <ListChecks size={14} />,
    };
  }

  if (coreStatus === "running") {
    return {
      type: "success",
      title: "Core 正在运行",
      detail: core?.url ? `当前地址：${core.url}` : "WebConsole 可用时会打开本机 /app。",
      primary: { label: "打开 WebConsole", onClick: onOpenWebconsole },
      primaryIcon: <ExternalLink size={14} />,
    };
  }

  return {
    type: "info",
    title: statusText[coreStatus],
    detail: "当前状态正在变化；需要排查时先查看操作记录和 Core 日志。",
    primary: { label: "查看记录", onClick: onOpenOperations },
    primaryIcon: <ListChecks size={14} />,
  };
}

function getLifecycleAction(status: ServiceStatus): LifecycleAction {
  if (status === "running") {
    return { kind: "stop", label: "停止 Core", loadingKey: "stop" };
  }
  if (status === "starting") {
    return { kind: "start", label: "启动中", loadingKey: "start", disabled: true };
  }
  if (status === "stopping") {
    return { kind: "stop", label: "停止中", loadingKey: "stop", disabled: true };
  }
  if (status === "initializing" || status === "checking") {
    return { kind: "start", label: statusText[status], disabled: true };
  }
  if (status === "failed") {
    return { kind: "start", label: "重新启动 Core", loadingKey: "start" };
  }
  return { kind: "start", label: "启动 Core", loadingKey: "start" };
}
