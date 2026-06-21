import type { ReactNode } from "react";
import { Alert, Badge, Button, Progress, Tag, Typography } from "antd";
import { ExternalLink, ListChecks, Play, Square, Terminal, Wrench } from "lucide-react";
import { displayBytes, displayNumber, displaySecondsFromMilliseconds, displayText } from "../ui/format";
import { PanelHeader, SectionActions } from "../ui/primitives";
import { statusText } from "../ui/status";
import { PreflightStatusTag, StatusTag, TaskStatusTag } from "../ui/statusTags";
import { isBeginnerMode } from "../ui/userMode";
import type {
  AppPaths,
  AppState,
  LogEntry,
  PreflightCheck,
  ServiceSnapshot,
  ServiceStatus,
  Settings,
  TaskRecord,
  ToolchainInfo,
} from "../types";
import type { SetupProgressItem } from "../ui/setupProgress";

const { Text } = Typography;

interface OverviewPageProps {
  appState?: AppState;
  core?: ServiceSnapshot;
  logs: LogEntry[];
  healthScore: number;
  setupChecklist: SetupProgressItem[];
  loadingAction?: string;
  onStartCore: () => void;
  onStopCore: () => void;
  onOpenWebconsole: () => void;
  onOpenInstallGuide: (step?: number) => void;
  onOpenEnvironment: () => void;
  onOpenLogs: () => void;
}

export default function OverviewPage({
  appState,
  core,
  logs,
  healthScore,
  setupChecklist,
  loadingAction,
  onStartCore,
  onStopCore,
  onOpenWebconsole,
  onOpenInstallGuide,
  onOpenEnvironment,
  onOpenLogs,
}: OverviewPageProps) {
  const coreStatus = core?.status ?? "uninitialized";
  const beginnerMode = isBeginnerMode(appState?.settings);
  const preflightChecks = appState?.preflightChecks;
  const blockingChecks = preflightChecks ? preflightChecks.filter((check) => check.status === "block") : [];
  const warningChecks = preflightChecks ? preflightChecks.filter((check) => check.status === "warn") : [];
  const portPolicy = appState?.settings.preferredCorePort ? `固定 ${appState.settings.preferredCorePort}` : "自动";
  const services = appState?.services ?? [];
  const taskHistory = appState?.taskHistory ?? [];
  const visiblePreflight = sortPreflightChecks(appState?.preflightChecks ?? []);
  const recentLogs = logs.slice(-8).reverse();
  const settingsItems = appState
    ? beginnerMode
      ? createBeginnerSettingsItems(appState.settings, appState.paths, appState.toolchain)
      : createSettingsItems(appState.settings, appState.paths, appState.toolchain)
    : [];
  const pathItems = appState ? createPathItems(appState.paths, appState.toolchain) : [];
  const lifecycleAction = getLifecycleAction(coreStatus);
  const lifecycleLoading = Boolean(lifecycleAction.loadingKey && loadingAction === lifecycleAction.loadingKey);
  const runLifecycleAction = lifecycleAction.kind === "stop" ? onStopCore : onStartCore;
  const nextAction = buildOverviewNextAction({
    core,
    coreStatus,
    blockingChecks,
    runningTask: appState?.taskHistory.find((task) => task.status === "running"),
    failedTask: appState?.taskHistory.find((task) => task.status === "failed"),
    onStartCore,
    onOpenWebconsole,
    onOpenInstallGuide,
    onOpenEnvironment,
    onOpenLogs,
  });

  return (
    <section className="overview-dashboard">
      <div className="wide-panel overview-core-panel">
        <PanelHeader
          title="Gsuid Core 总控"
          description="启动、停止、WebConsole 和本机运行状态"
          actions={<StatusTag status={coreStatus} />}
        />
        {core?.recentError && <Alert type="error" showIcon title={core.recentError} className="spaced" />}
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
        <div className="core-summary-row">
          <div className="core-state-card">
            <Text type="secondary">当前状态</Text>
            <strong>{statusText[coreStatus]}</strong>
            <small>{core?.healthOk ? "WebConsole 健康检查通过" : "启动后自动检查 WebConsole"}</small>
          </div>
          <div className="core-port-card">
            <Text type="secondary">端口</Text>
            <strong>{displayNumber(core?.port, "未分配")}</strong>
            <small>策略：{portPolicy}</small>
          </div>
          <div className="core-url-card">
            <Text type="secondary">运行地址</Text>
            <strong>{displayText(core?.url, "启动后生成")}</strong>
            <small>{core?.webconsoleAvailable ? "WebConsole 可访问" : "WebConsole 未就绪"}</small>
          </div>
        </div>
        <div className="overview-metrics">
          <div>
            <Text type="secondary">进程</Text>
            <strong>{displayNumber(core?.pid, "-")}</strong>
          </div>
          <div>
            <Text type="secondary">Core 内存</Text>
            <strong>{displayBytes(core?.memoryBytes)}</strong>
          </div>
          <div>
            <Text type="secondary">壳进程</Text>
            <strong>{displayNumber(appState?.shell.pid, "-")}</strong>
          </div>
          <div>
            <Text type="secondary">壳内存</Text>
            <strong>{displayBytes(appState?.shell.memoryBytes)}</strong>
          </div>
          <div>
            <Text type="secondary">WebConsole</Text>
            <strong>{core?.webconsoleAvailable ? "可访问" : "未就绪"}</strong>
          </div>
          <div>
            <Text type="secondary">Commit</Text>
            <strong>{displayText(core?.currentCommit, "-")}</strong>
          </div>
          <div>
            <Text type="secondary">Tag</Text>
            <strong>{displayText(core?.currentTag, "-")}</strong>
          </div>
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
      <div className="wide-panel overview-health-panel">
        <PanelHeader
          title="健康检查"
          description="只保留影响启动和排查的状态摘要"
          actions={<Text type="secondary">{healthScore}%</Text>}
        />
        <div className="health-overview">
          <Progress percent={healthScore} size="small" showInfo={false} />
          <div className="health-list compact">
            <Badge
              status={appState?.uvDetected ? "success" : "error"}
              text={appState?.uvDetected ? `uv 可用 / ${appState.toolchain.uvSource}` : "未检测到 uv"}
            />
            <Badge
              status={appState?.toolchain.gitDetected ? "success" : "error"}
              text={
                appState?.toolchain.gitDetected ? `源码工具可用 / ${gitSourceText(appState.toolchain.gitSource)}` : "缺少源码工具"
              }
            />
            <Badge
              status={blockingChecks.length ? "error" : "success"}
              text={blockingChecks.length ? `${blockingChecks.length} 个阻断项` : "预检无阻断"}
            />
            <Badge
              status={warningChecks.length ? "warning" : "success"}
              text={warningChecks.length ? `${warningChecks.length} 个警告项` : "预检无警告"}
            />
            <Badge status={core?.healthOk ? "success" : "default"} text={core?.healthOk ? "Core 健康" : "Core 未运行"} />
          </div>
        </div>
      </div>
      {!beginnerMode && (
        <div className="wide-panel overview-service-panel">
          <PanelHeader title="服务状态" description="所有纳入 GSDesk 管理或预留的服务快照" />
          <div className="overview-service-list">
            {services.map((service) => (
              <div className="overview-service-item" key={service.serviceId}>
                <div>
                  <strong>{service.name}</strong>
                  <small>{service.serviceId}</small>
                </div>
                <StatusTag status={service.status} />
                <span>{displayNumber(service.pid, "-")}</span>
                <span>{displayNumber(service.port, "-")}</span>
                <span>{displayBytes(service.memoryBytes)}</span>
                <code>{displayText(service.url, "-")}</code>
                {service.recentError && <p>{service.recentError}</p>}
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="wide-panel overview-preflight-panel">
        <PanelHeader
          title="预检明细"
          description="系统、工具链、端口、权限、磁盘、Core 源码和 venv"
          actions={
            <Button icon={<Wrench size={16} />} onClick={onOpenEnvironment}>
              处理预检
            </Button>
          }
        />
        <div className="overview-check-list">
          {visiblePreflight.map((check) => (
            <div className={`overview-check-item ${check.status}`} key={check.id}>
              <div>
                <strong>{check.label}</strong>
                <p>{check.detail}</p>
                {check.action && <small>{check.action}</small>}
              </div>
              <PreflightStatusTag status={check.status} />
            </div>
          ))}
        </div>
      </div>
      <div className="wide-panel overview-settings-panel">
        <PanelHeader
          title={beginnerMode ? "当前自动配置" : "网络与策略"}
          description={beginnerMode ? "小白模式使用自动源、自动镜像、自动端口和托管目录" : "源码源、PyPI、端口、代理和启动策略"}
        />
        <OverviewInfoGrid items={settingsItems} />
      </div>
      {!beginnerMode && (
        <div className="wide-panel overview-path-panel">
          <PanelHeader title="运行路径" description="当前生效的 Core、venv、uv、日志、诊断和备份目录" />
          <OverviewInfoGrid items={pathItems} code />
        </div>
      )}
      <div className="wide-panel overview-task-panel">
        <PanelHeader
          title="任务历史"
          description="初始化、启动、停止、修复和更新动作"
          actions={
            <Button icon={<ListChecks size={16} />} onClick={onOpenEnvironment}>
              查看任务
            </Button>
          }
        />
        <div className="overview-task-list">
          {taskHistory.map((task) => (
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
          {!taskHistory.length && <p className="muted-block">暂无任务记录。</p>}
        </div>
      </div>
      {!beginnerMode && (
        <div className="wide-panel overview-log-panel">
          <PanelHeader
            title="最近 Core 日志"
            description="首页只保留最近几条，完整 JSONL 在日志页查看"
            actions={
              <Button icon={<Terminal size={16} />} onClick={onOpenLogs}>
                打开日志
              </Button>
            }
          />
          <div className="overview-log-list">
            {recentLogs.map((entry) => (
              <div className={`overview-log-item ${entry.level}`} key={entry.id}>
                <time>{formatTime(entry.timestamp)}</time>
                <Tag>{entry.level}</Tag>
                <span>{displayText(entry.module, entry.stream)}</span>
                <code>{displayText(entry.message, entry.line)}</code>
              </div>
            ))}
            {!recentLogs.length && <p className="muted-block">暂无 Core JSONL 日志。</p>}
          </div>
        </div>
      )}
      <div className="wide-panel overview-guide-panel">
        <PanelHeader
          title="首次安装引导"
          description="网络、源码、镜像、初始化、启动和 WebConsole 一条线完成"
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

interface OverviewInfoItem {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
}

function OverviewInfoGrid({ items, code = false }: { items: OverviewInfoItem[]; code?: boolean }) {
  return (
    <div className="overview-info-grid">
      {items.map((item) => (
        <div className="overview-info-item" key={item.label}>
          <Text type="secondary">{item.label}</Text>
          {code ? <code>{item.value}</code> : <strong>{item.value}</strong>}
          {item.detail && <small>{item.detail}</small>}
        </div>
      ))}
    </div>
  );
}

function createSettingsItems(settings: Settings, paths: AppPaths, toolchain: ToolchainInfo): OverviewInfoItem[] {
  return [
    {
      label: "源码工具",
      value: toolchain.gitDetected ? gitSourceText(toolchain.gitSource) : "不可用",
      detail: toolchain.gitDetected ? displayText(toolchain.gitVersion, "Git 可用") : displayText(toolchain.gitError, "缺少 Git"),
    },
    {
      label: "源码策略",
      value: sourceModeText(settings.sourceMode),
      detail: displayText(settings.selectedSource, "未设置源码源"),
    },
    {
      label: "Core 源码路径",
      value: displayText(paths.coreDir, "-"),
      detail: displayText(settings.customCoreDir, "使用 GSDesk 托管目录"),
    },
    { label: "PyPI 策略", value: pypiModeText(settings.pypiIndexMode), detail: displayText(settings.pypiIndexUrl, "未设置镜像") },
    {
      label: "端口策略",
      value: settings.preferredCorePort ? `固定 ${settings.preferredCorePort}` : "自动选择",
      detail: settings.preferredCorePort ? "启动时严格使用该端口" : "自动选择 8765-8865",
    },
    { label: "HTTP_PROXY", value: displayText(settings.proxy.httpProxy, "未设置") },
    { label: "HTTPS_PROXY", value: displayText(settings.proxy.httpsProxy, "未设置") },
    { label: "ALL_PROXY", value: displayText(settings.proxy.allProxy, "未设置") },
    { label: "NO_PROXY", value: displayText(settings.proxy.noProxy, "未设置") },
    { label: "点击 X", value: settings.hideToTrayOnClose ? "隐藏到托盘" : "退出 GSDesk" },
    { label: "退出时关闭 Core", value: settings.closeCoreOnExit ? "关闭" : "后台保留" },
    { label: "启动检查壳更新", value: settings.autoCheckUpdate ? "开启" : "关闭" },
  ];
}

function createBeginnerSettingsItems(settings: Settings, paths: AppPaths, toolchain: ToolchainInfo): OverviewInfoItem[] {
  return [
    { label: "使用模式", value: "小白模式", detail: "只显示直接可用的操作" },
    {
      label: "源码工具",
      value: toolchain.gitDetected ? "已准备好" : "当前安装包不完整",
      detail: toolchain.gitDetected ? "无需单独安装 Git" : displayText(toolchain.gitError, "缺少内置 Git"),
    },
    { label: "源码与下载源", value: "自动选择", detail: "网络检测后自动保存可用源" },
    {
      label: "Core 目录",
      value: settings.customCoreDir.trim().length ? "保留高级自定义" : "GSDesk 托管",
      detail: settings.customCoreDir.trim().length ? settings.customCoreDir : paths.coreDir,
    },
    {
      label: "端口",
      value: settings.preferredCorePort ? `固定 ${settings.preferredCorePort}` : "自动选择",
      detail: settings.preferredCorePort ? "高级设置仍在生效" : "默认从 8765 开始寻找可用端口",
    },
    { label: "关闭窗口", value: settings.hideToTrayOnClose ? "隐藏到托盘" : "退出 GSDesk" },
    { label: "退出时 Core", value: settings.closeCoreOnExit ? "停止 Core" : "后台保留" },
  ];
}

function createPathItems(paths: AppPaths, toolchain: ToolchainInfo): OverviewInfoItem[] {
  return [
    { label: "AppData", value: paths.appData },
    { label: "Runtime", value: paths.runtime },
    { label: "Tools", value: paths.toolsDir },
    { label: "Core", value: paths.coreDir },
    { label: "venv", value: paths.venvDir },
    { label: "uv cache", value: paths.uvCacheDir },
    { label: "uv Python", value: paths.uvPythonDir },
    { label: "uv executable", value: paths.uvExecutable },
    { label: "Git executable", value: displayText(toolchain.gitPath, "-") },
    { label: "Logs", value: paths.logsDir },
    { label: "Diagnostics", value: paths.diagnosticsDir },
    { label: "Backups", value: paths.backupsDir },
    { label: "Settings", value: paths.settingsFile },
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
  onOpenLogs: () => void;
}): OverviewNextAction {
  if (runningTask) {
    return {
      type: "info",
      title: `当前任务：${runningTask.name}`,
      detail: `${runningTask.stage} · ${runningTask.message}`,
      primary: { label: "查看任务", onClick: onOpenEnvironment },
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
    detail: "当前状态正在变化；需要排查时先查看任务历史和 Core 日志。",
    primary: { label: "查看任务", onClick: onOpenEnvironment },
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
