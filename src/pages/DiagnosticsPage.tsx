import { Alert, Button, Modal, Tag } from "antd";
import { AlertTriangle, CheckCircle2, Download, FileArchive, FolderOpen, ShieldCheck, Wrench } from "lucide-react";
import { PanelHeader, SectionActions } from "../ui/primitives";
import type { AppState, LogEntry, PreflightCheck, ServiceSnapshot, UpdateInfo } from "../types";

interface DiagnosticsPageProps {
  appState: AppState;
  updateInfo?: UpdateInfo;
  loadingAction?: string;
  onExportDiagnostics: () => Promise<string | undefined>;
  onCheckShellUpdate: () => void;
  onOpenDiagnosticsDir: () => void;
}

export default function DiagnosticsPage({
  appState,
  updateInfo,
  loadingAction,
  onExportDiagnostics,
  onCheckShellUpdate,
  onOpenDiagnosticsDir,
}: DiagnosticsPageProps) {
  const troubleshootingItems = buildTroubleshootingItems(appState, updateInfo);
  const logFailureSummary = buildLogFailureSummary(appState.recentLogs);

  return (
    <section className="page-grid">
      <div className="wide-panel">
        <PanelHeader title="诊断导出" description="导出诊断信息、检查 GSDesk 壳更新" />
        <p className="muted-block">导出版本、系统、路径、端口、源码源、镜像、代理摘要、uv/Python 信息和最近日志。敏感字段会自动遮蔽。</p>
        <SectionActions>
          <Button
            type="primary"
            icon={<FileArchive size={16} />}
            loading={loadingAction === "diagnostics"}
            onClick={async () => {
              const path = await onExportDiagnostics();
              if (path) Modal.info({ title: "诊断包路径", content: path });
            }}
          >
            导出诊断包
          </Button>
          <Button icon={<Download size={16} />} loading={loadingAction === "update"} onClick={onCheckShellUpdate}>
            检查壳更新
          </Button>
          <Button icon={<FolderOpen size={16} />} onClick={onOpenDiagnosticsDir}>
            打开诊断目录
          </Button>
        </SectionActions>
        {updateInfo && (
          <Alert
            className="spaced"
            type={updateInfo.hasUpdate ? "success" : updateInfo.error ? "warning" : "info"}
            showIcon
            message={updateMessage(updateInfo)}
            description={updateDescription(updateInfo)}
          />
        )}
      </div>
      <div className="wide-panel">
        <PanelHeader title="故障排查向导" description="按当前状态给出最可能的失败原因和下一步动作" />
        <div className="troubleshooting-list">
          {troubleshootingItems.map((item) => (
            <div className="troubleshooting-item" key={item.key}>
              <div className={`troubleshooting-icon ${item.severity}`}>
                {item.severity === "ok" ? <CheckCircle2 size={18} /> : item.severity === "block" ? <AlertTriangle size={18} /> : <Wrench size={18} />}
              </div>
              <div>
                <div className="troubleshooting-title">
                  <span>{item.title}</span>
                  <Tag color={severityColor(item.severity)}>{severityLabel(item.severity)}</Tag>
                </div>
                <p>{item.detail}</p>
                {item.action && <strong>{item.action}</strong>}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="wide-panel">
        <PanelHeader title="最近错误摘要" description="自动提取最后一个 traceback 或错误段，给出中文解释" />
        {logFailureSummary ? (
          <div className="failure-summary">
            <Alert type="warning" showIcon message={logFailureSummary.title} description={logFailureSummary.explanation} />
            <div className="failure-context" data-testid="failure-context">
              {logFailureSummary.context.map((line, index) => (
                <code key={`${index}-${line}`}>{line}</code>
              ))}
            </div>
          </div>
        ) : (
          <Alert type="success" showIcon message="未发现最近错误段" description="当前缓存日志里没有 traceback、异常、失败任务输出或错误级别日志。" />
        )}
      </div>
      <div className="wide-panel">
        <PanelHeader title="隐私与遥测" description="GSDesk 默认本地优先，不自动上传诊断数据" />
        <div className="privacy-grid">
          <div className="privacy-item">
            <ShieldCheck size={18} />
            <div>
              <strong>自动上传：关闭</strong>
              <p>没有崩溃上报、匿名统计或诊断包自动上传逻辑。</p>
            </div>
          </div>
          <div className="privacy-item">
            <FileArchive size={18} />
            <div>
              <strong>诊断包：本机生成</strong>
              <p>诊断包仅保存在本机 diagnostics 目录；敏感字段会在写入前遮蔽。</p>
            </div>
          </div>
          <div className="privacy-item">
            <Download size={18} />
            <div>
              <strong>网络请求：动作触发</strong>
              <p>仅在初始化、测速、更新检查或打开 WebConsole 等用户动作中访问 GitHub、CNB、PyPI 镜像和本机地址。</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function updateMessage(updateInfo: UpdateInfo) {
  if (updateInfo.error) return "更新检查失败";
  if (updateInfo.hasUpdate) return `发现稳定版 ${updateInfo.latestVersion}`;
  if (updateInfo.channel === "prerelease") return `当前稳定版已是最新，存在预览版 ${updateInfo.prereleaseVersion}`;
  return "当前已是最新稳定版或暂无 Release";
}

function updateDescription(updateInfo: UpdateInfo) {
  return updateInfo.error || updateInfo.releaseUrl || updateInfo.prereleaseUrl || updateInfo.notes;
}

type TroubleshootingSeverity = "block" | "warn" | "info" | "ok";

interface TroubleshootingItem {
  key: string;
  severity: TroubleshootingSeverity;
  title: string;
  detail: string;
  action?: string;
}

interface LogFailureSummary {
  title: string;
  explanation: string;
  context: string[];
}

function buildLogFailureSummary(logs: LogEntry[]): LogFailureSummary | null {
  const context = lastErrorContext(logs);
  if (!context.length) return null;
  const explanation = commonFailureExplanation(logs.map(logEntryText).join("\n")) || commonFailureExplanation(context.join("\n"));
  return {
    title: explanation ? "识别到可能失败原因" : "识别到最近错误段",
    explanation: explanation || "没有匹配到内置规则；优先查看错误段最底部一行，再导出诊断包保留完整上下文。",
    context,
  };
}

function lastErrorContext(logs: LogEntry[]) {
  const lastErrorIndex = findLastIndex(logs, isErrorSignal);
  if (lastErrorIndex < 0) return [];

  const searchStart = Math.max(0, lastErrorIndex - 30);
  const tracebackOffset = findLastIndex(logs.slice(searchStart, lastErrorIndex + 1), (entry) => logEntryText(entry).toLowerCase().includes("traceback"));
  const tracebackStart = tracebackOffset >= 0 ? searchStart + tracebackOffset : -1;
  const start = tracebackStart >= 0 ? tracebackStart : Math.max(0, lastErrorIndex - 6);
  const maxAfter = tracebackStart >= 0 ? 25 : 8;
  const end = Math.min(logs.length, lastErrorIndex + maxAfter);

  return logs
    .slice(start, end)
    .slice(0, 30)
    .map((entry) => `${entry.timestamp} [${entry.stream}/${entry.level}]${entry.module ? ` [${entry.module}]` : ""} ${logEntryText(entry)}`);
}

function commonFailureExplanation(text: string) {
  const lower = text.toLowerCase();
  if (lower.includes("unicodeencodeerror") && lower.includes("gbk")) {
    return "Python/控制台编码问题；GSDesk 已强制 UTF-8，仍出现时请保留诊断包继续排查启动环境。";
  }
  if (lower.includes("module not found") || lower.includes("modulenotfounderror") || lower.includes("no module named") || lower.includes("importerror")) {
    return "Python 依赖或 venv 不完整；优先重跑依赖同步，仍失败再重建 venv。";
  }
  if (lower.includes("address already in use") || lower.includes("only one usage of each socket address") || lower.includes("10048") || lower.includes("端口")) {
    return "端口被占用或端口检测异常；关闭占用进程，或切回自动端口后重启 Core。";
  }
  if (
    lower.includes("proxy") ||
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("connection refused") ||
    lower.includes("could not resolve") ||
    lower.includes("dns") ||
    lower.includes("连接超时") ||
    lower.includes("代理")
  ) {
    return "网络或代理配置异常；先运行网络诊断，确认 Git、PyPI 和本机 NO_PROXY。";
  }
  if (lower.includes("permission denied") || lower.includes("access is denied") || lower.includes("拒绝访问") || lower.includes("无权限")) {
    return "路径或权限受限；确认应用数据目录可写，避免把运行时放在受保护目录。";
  }
  if (lower.includes("git clone") || lower.includes("git fetch") || lower.includes("git pull") || lower.includes("dirty repo") || lower.includes("未提交修改")) {
    return "源码仓库同步失败；检查 Git 连通性、源码源选择和本地未提交修改。";
  }
  if (lower.includes("uv sync") || lower.includes("uv python") || lower.includes("pyproject") || lower.includes("python install")) {
    return "uv/Python 初始化失败；检查 uv 安装、Python 3.12 下载目录和 PyPI 镜像。";
  }
  if (lower.includes("traceback") || lower.includes("exception")) {
    return "Core 或依赖运行时抛出异常；优先查看最后 traceback 的最底部错误行。";
  }
  return undefined;
}

function isErrorSignal(entry: LogEntry) {
  if (entry.level === "error") return true;
  const lower = logEntryText(entry).toLowerCase();
  return (
    lower.includes("traceback") ||
    lower.includes("exception") ||
    lower.includes("failed") ||
    lower.includes("error") ||
    lower.includes("panic") ||
    lower.includes("启动失败") ||
    lower.includes("执行失败") ||
    lower.includes("parse_error")
  );
}

function logEntryText(entry: LogEntry) {
  return entry.message?.trim() ? entry.message : entry.line;
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) return index;
  }
  return -1;
}

function buildTroubleshootingItems(appState: AppState, updateInfo?: UpdateInfo): TroubleshootingItem[] {
  const core = appState.services.find((service) => service.serviceId === "gsuid_core");
  const items: TroubleshootingItem[] = [];

  appState.preflightChecks
    .filter((check) => check.status !== "ok")
    .slice(0, 5)
    .forEach((check) => items.push(preflightTroubleshootingItem(check)));

  if (core) {
    items.push(...coreTroubleshootingItems(core));
  }

  const failedTask = [...appState.taskHistory].reverse().find((task) => task.status === "failed");
  if (failedTask) {
    items.push({
      key: `task-${failedTask.id}`,
      severity: "block",
      title: `最近任务失败：${failedTask.name}`,
      detail: `${failedTask.stage} · ${failedTask.message}`,
      action: "打开终端日志或导出诊断包，保留任务历史和原始输出。",
    });
  }

  if (updateInfo?.error) {
    items.push({
      key: "shell-update-error",
      severity: "warn",
      title: "壳更新检查失败",
      detail: updateInfo.error,
      action: "先完成网络诊断；如果 GitHub 不通，配置代理后再检查。",
    });
  }

  if (!items.length) {
    items.push({
      key: "healthy",
      severity: "ok",
      title: "未发现阻断项",
      detail: "当前预检、Core 状态和最近任务没有暴露新的失败信号。",
      action: "发布前仍需导出诊断包并执行真实 Core smoke。",
    });
  }

  return items;
}

function preflightTroubleshootingItem(check: PreflightCheck): TroubleshootingItem {
  return {
    key: `preflight-${check.id}`,
    severity: check.status === "block" ? "block" : "warn",
    title: `${check.label}：${check.detail}`,
    detail: check.action || "预检提示需要处理，建议先在环境与修复页复查。",
    action: repairActionForCheck(check),
  };
}

function repairActionForCheck(check: PreflightCheck) {
  if (check.id === "uv") return "执行“安装/修复 uv”，然后重新运行初始化。";
  if (check.id === "git") return "安装 Git 后重新打开 GSDesk，确认预检变为可用。";
  if (check.id === "port") return check.action || "关闭占用进程，或改回自动端口。";
  if (check.id === "core_repo") return "运行首次安装引导；已有数据时优先使用运行时备份。";
  if (check.id === "venv") return "执行“重建 venv”或重跑依赖同步。";
  if (check.id === "pypi") return "重新测速 PyPI 镜像，保存最快可用源。";
  if (check.id === "source") return "重新探测 GitHub / CNB，保存可用源码源。";
  return check.action;
}

function coreTroubleshootingItems(core: ServiceSnapshot): TroubleshootingItem[] {
  const items: TroubleshootingItem[] = [];
  if (core.status === "uninitialized") {
    items.push({
      key: "core-uninitialized",
      severity: "warn",
      title: "Core 尚未初始化",
      detail: "当前还没有可启动的 gsuid_core 运行时。",
      action: "从首次安装引导执行一键安装启动。",
    });
  }
  if (core.status === "failed" || core.status === "crashed") {
    items.push({
      key: "core-failed",
      severity: "block",
      title: `Core 状态异常：${core.status}`,
      detail: core.recentError || "Core 已失败或崩溃，但当前快照没有记录具体错误。",
      action: "打开终端日志，查看最近 traceback；随后导出诊断包。",
    });
  } else if (core.recentError) {
    items.push({
      key: "core-recent-error",
      severity: "warn",
      title: "Core 最近错误",
      detail: core.recentError,
      action: "如果错误重复出现，先重启 Core；仍失败再导出诊断包。",
    });
  }
  if (core.status === "running" && !core.webconsoleAvailable) {
    items.push({
      key: "webconsole-unavailable",
      severity: "warn",
      title: "WebConsole 未就绪",
      detail: `Core 已运行${core.port ? `在 ${core.port} 端口` : ""}，但 /app 暂不可访问。`,
      action: "等待启动完成；若超过 60 秒，检查 NO_PROXY、端口占用和 Core 日志。",
    });
  }
  return items;
}

function severityColor(severity: TroubleshootingSeverity) {
  if (severity === "block") return "error";
  if (severity === "warn") return "warning";
  if (severity === "ok") return "success";
  return "processing";
}

function severityLabel(severity: TroubleshootingSeverity) {
  if (severity === "block") return "阻断";
  if (severity === "warn") return "警告";
  if (severity === "ok") return "正常";
  return "提示";
}
