import { Alert, Badge, Button, Progress, Typography } from "antd";
import { ExternalLink, Play, RefreshCcw, RotateCw, Square, Wrench } from "lucide-react";
import { StatusTag, statusText } from "../ui/appShell";
import { PanelHeader, SectionActions } from "../ui/primitives";
import type { AppState, ServiceSnapshot } from "../types";
import type { SetupProgressItem } from "../ui/setupProgress";

const { Text } = Typography;

interface OverviewPageProps {
  appState?: AppState;
  core?: ServiceSnapshot;
  nonebot?: ServiceSnapshot;
  healthScore: number;
  setupChecklist: SetupProgressItem[];
  loadingAction?: string;
  onStartCore: () => void;
  onStopCore: () => void;
  onRestartCore: () => void;
  onOpenWebconsole: () => void;
  onOpenInstallGuide: (step?: number) => void;
}

export default function OverviewPage({
  appState,
  core,
  nonebot,
  healthScore,
  setupChecklist,
  loadingAction,
  onStartCore,
  onStopCore,
  onRestartCore,
  onOpenWebconsole,
  onOpenInstallGuide,
}: OverviewPageProps) {
  const coreStatus = core?.status || "uninitialized";
  const nonebotStatus = nonebot?.status || "uninitialized";
  const blockingChecks = appState?.preflightChecks.filter((check) => check.status === "block") || [];
  const warningChecks = appState?.preflightChecks.filter((check) => check.status === "warn") || [];

  return (
    <section className="page-grid overview-grid">
      <div className="wide-panel control-panel">
        <PanelHeader
          title="Gsuid Core"
          description="本地 Python Core 进程和 WebConsole 状态"
          actions={<StatusTag status={coreStatus} />}
        />
        {core?.recentError && <Alert type="error" showIcon message={core.recentError} className="spaced" />}
        <div className="status-strip">
          <div>
            <Text type="secondary">端口</Text>
            <strong>{core?.port || "-"}</strong>
          </div>
          <div>
            <Text type="secondary">端口策略</Text>
            <strong>{appState?.settings.preferredCorePort ? `固定 ${appState.settings.preferredCorePort}` : "自动"}</strong>
          </div>
          <div>
            <Text type="secondary">进程</Text>
            <strong>{core?.pid || "-"}</strong>
          </div>
          <div>
            <Text type="secondary">WebConsole</Text>
            <strong>{core?.webconsoleAvailable ? "可访问" : "未就绪"}</strong>
          </div>
          <div>
            <Text type="secondary">运行地址</Text>
            <strong>{core?.url || "-"}</strong>
          </div>
          <div>
            <Text type="secondary">Commit</Text>
            <strong>{core?.currentCommit || "-"}</strong>
          </div>
          <div>
            <Text type="secondary">Tag</Text>
            <strong>{core?.currentTag || "-"}</strong>
          </div>
        </div>
        <SectionActions>
          <Button type="primary" icon={<Play size={16} />} loading={loadingAction === "start"} onClick={onStartCore}>
            启动
          </Button>
          <Button icon={<Square size={16} />} loading={loadingAction === "stop"} onClick={onStopCore}>
            停止
          </Button>
          <Button icon={<RotateCw size={16} />} loading={loadingAction === "restart"} onClick={onRestartCore}>
            重启
          </Button>
          <Button icon={<ExternalLink size={16} />} loading={loadingAction === "open_webconsole"} onClick={onOpenWebconsole}>
            打开 WebConsole
          </Button>
        </SectionActions>
      </div>
      <div className="side-panel">
        <PanelHeader title="环境健康度" />
        <Progress type="dashboard" percent={healthScore} size={132} />
        <div className="health-list">
          <Badge
            status={appState?.uvDetected ? "success" : "error"}
            text={appState?.uvDetected ? `uv 可用 / ${appState.toolchain.uvSource}` : "未检测到 uv"}
          />
          <Badge status={blockingChecks.length ? "error" : "success"} text={blockingChecks.length ? `${blockingChecks.length} 个阻断项` : "预检无阻断"} />
          <Badge status={warningChecks.length ? "warning" : "success"} text={warningChecks.length ? `${warningChecks.length} 个警告项` : "预检无警告"} />
          <Badge status={appState?.settings.pypiIndexUrl ? "success" : "warning"} text="PyPI 镜像已配置" />
          <Badge status={core?.healthOk ? "success" : "default"} text={core?.healthOk ? "Core 健康" : "Core 未运行"} />
        </div>
      </div>
      <div className="wide-panel">
        <PanelHeader
          title="首次安装引导"
          description="从网络、源码源、镜像到运行时初始化的完整流程"
          actions={
            <Button type="primary" icon={<Wrench size={16} />} onClick={() => onOpenInstallGuide(0)}>
              打开引导
            </Button>
          }
        />
        <div className="wizard-line">
          {setupChecklist.map((step, index) => (
            <button type="button" key={step.label} className={`wizard-step ${step.done ? "ready" : ""}`} onClick={() => onOpenInstallGuide(index)}>
              <span>{step.done ? "✓" : index + 1}</span>
              <strong>{step.label}</strong>
              <small>{step.detail}</small>
            </button>
          ))}
        </div>
      </div>
      <div className="side-panel">
        <PanelHeader title="NoneBot2" actions={<StatusTag status={nonebotStatus} />} />
        <p className="muted-block">v1 仅预留多服务架构，后续接入项目目录、进程启动、连接检查和合并日志。</p>
      </div>
    </section>
  );
}
