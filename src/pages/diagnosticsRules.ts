import type { AppState, LogEntry, PreflightCheck, ServiceSnapshot, UpdateInfo } from "../types";
import { findGsuidCore } from "../serviceIds";
import { displayText, firstText } from "../ui/format";
import { isFailedServiceStatus, statusText } from "../ui/status";

export function updateMessage(updateInfo: UpdateInfo) {
  if (updateInfo.error) return "更新检查失败";
  if (updateInfo.hasUpdate) return `发现可安装更新 ${updateInfo.latestVersion}`;
  if (updateInfo.channel === "prerelease") return `当前稳定版已是最新，存在预览版 ${updateInfo.prereleaseVersion}`;
  return "当前已是最新稳定版或暂无 Release";
}

export function updateDescription(updateInfo: UpdateInfo) {
  if (updateInfo.hasUpdate) {
    return firstText(updateInfo.notes, updateInfo.releaseUrl, "点击“下载并安装”后会校验签名、安装更新并重启 GSDesk。");
  }
  return firstText(updateInfo.error, updateInfo.releaseUrl, updateInfo.prereleaseUrl, updateInfo.notes);
}

export type TroubleshootingSeverity = "block" | "warn" | "info" | "ok";

export interface TroubleshootingItem {
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

interface FailureRule {
  allTerms: string[];
  anyTerms: string[];
  explanation: string;
}

const FAILURE_RULES: FailureRule[] = [
  {
    allTerms: ["unicodeencodeerror", "gbk"],
    anyTerms: [],
    explanation: "Python/控制台编码问题；GSDesk 已强制 UTF-8，仍出现时请保留 Core 日志和操作记录继续排查启动环境。",
  },
  {
    allTerms: [],
    anyTerms: ["module not found", "modulenotfounderror", "no module named", "importerror"],
    explanation: "Python 依赖或 venv 不完整；优先重跑依赖同步，仍失败再重建 venv。",
  },
  {
    allTerms: [],
    anyTerms: ["address already in use", "only one usage of each socket address", "10048", "端口", "localport"],
    explanation: "端口被占用或端口检测异常；在环境与修复中强杀端口占用，或切回自动端口后重启 Core。",
  },
  {
    allTerms: [],
    anyTerms: ["proxy", "timed out", "timeout", "connection refused", "could not resolve", "dns", "连接超时", "代理"],
    explanation: "网络或代理配置异常；先运行网络诊断，确认源码工具、PyPI 和本机 NO_PROXY。",
  },
  {
    allTerms: [],
    anyTerms: ["permission denied", "access is denied", "拒绝访问", "无权限"],
    explanation: "路径或权限受限；确认应用数据目录可写，避免把运行时放在受保护目录。",
  },
  {
    allTerms: [],
    anyTerms: ["git clone", "git fetch", "git pull", "dirty repo", "未提交修改"],
    explanation: "源码仓库同步失败；检查内置 Git 连通性、源码源选择和本地未提交修改。",
  },
  {
    allTerms: [],
    anyTerms: ["uv sync", "uv python", "pyproject", "python install", "内置 python"],
    explanation: "uv/Python 初始化失败；检查 uv 安装、壳内置 Python 资源、隔离 Python 目录和 PyPI 镜像。",
  },
  {
    allTerms: [],
    anyTerms: ["traceback", "exception"],
    explanation: "Core 或依赖运行时抛出异常；优先查看最后 traceback 的最底部错误行。",
  },
];

const ERROR_SIGNAL_TERMS = ["traceback", "exception", "failed", "error", "panic", "启动失败", "执行失败", "parse_error"];

export function buildLogFailureSummary(logs: LogEntry[]): LogFailureSummary | null {
  const context = lastErrorContext(logs);
  if (!context.length) return null;
  const explanation = firstText(
    commonFailureExplanation(logs.map(logEntryText).join("\n")),
    commonFailureExplanation(context.join("\n")),
  );
  return {
    title: explanation ? "识别到可能失败原因" : "识别到最近错误段",
    explanation: displayText(explanation, "没有匹配到内置规则；优先查看错误段最底部一行，并保留最近 Core 日志上下文。"),
    context,
  };
}

function lastErrorContext(logs: LogEntry[]) {
  const lastErrorIndex = findLastIndex(logs, isErrorSignal);
  if (lastErrorIndex < 0) return [];

  const searchStart = Math.max(0, lastErrorIndex - 30);
  const tracebackOffset = findLastIndex(logs.slice(searchStart, lastErrorIndex + 1), (entry) =>
    logEntryText(entry).toLowerCase().includes("traceback"),
  );
  const tracebackStart = tracebackOffset >= 0 ? searchStart + tracebackOffset : -1;
  const start = tracebackStart >= 0 ? tracebackStart : Math.max(0, lastErrorIndex - 6);
  const maxAfter = tracebackStart >= 0 ? 25 : 8;
  const end = Math.min(logs.length, lastErrorIndex + maxAfter);

  return logs
    .slice(start, end)
    .slice(0, 30)
    .map(
      (entry) =>
        `${entry.timestamp} [${entry.stream}/${entry.level}]${entry.module ? ` [${entry.module}]` : ""} ${logEntryText(entry)}`,
    );
}

function commonFailureExplanation(text: string) {
  const lower = text.toLowerCase();
  return FAILURE_RULES.find((rule) => ruleMatches(rule, lower))?.explanation;
}

function isErrorSignal(entry: LogEntry) {
  if (entry.level === "error") return true;
  return containsAny(logEntryText(entry).toLowerCase(), ERROR_SIGNAL_TERMS);
}

function ruleMatches(rule: FailureRule, lower: string) {
  return rule.allTerms.every((term) => lower.includes(term)) && (!rule.anyTerms.length || containsAny(lower, rule.anyTerms));
}

function containsAny(text: string, terms: string[]) {
  return terms.some((term) => text.includes(term));
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

export function buildTroubleshootingItems(appState: AppState, updateInfo?: UpdateInfo): TroubleshootingItem[] {
  const core = findGsuidCore(appState.services);
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
      action: "打开 Core 日志，保留操作记录和原始输出。",
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
      action: "发布前仍需执行真实 Core smoke 并保留日志。",
    });
  }

  return items;
}

function preflightTroubleshootingItem(check: PreflightCheck): TroubleshootingItem {
  return {
    key: `preflight-${check.id}`,
    severity: check.status === "block" ? "block" : "warn",
    title: `${check.label}：${check.detail}`,
    detail: displayText(check.action, "预检提示需要处理，建议先在环境与修复页复查。"),
    action: repairActionForCheck(check),
  };
}

function repairActionForCheck(check: PreflightCheck) {
  if (check.id === "uv") return "执行“安装/更新 uv”，然后重新运行初始化。";
  if (check.id === "git") return "重新安装包含内置 Git 的完整 GSDesk；高级用户也可以安装系统 Git 后重新检测。";
  if (check.id === "port") return displayText(check.action, "强杀端口占用，或改成其他可用端口。");
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
  if (isFailedServiceStatus(core.status)) {
    items.push({
      key: "core-failed",
      severity: "block",
      title: `Core 状态异常：${statusText[core.status]}`,
      detail: displayText(core.recentError, "Core 已失败或异常退出，但当前快照没有记录具体错误。"),
      action: "打开 Core 日志，查看最近 traceback。",
    });
  } else if (core.recentError) {
    items.push({
      key: "core-recent-error",
      severity: "warn",
      title: "Core 最近错误",
      detail: core.recentError,
      action: "如果错误重复出现，先重启 Core；仍失败再保留最近日志和操作记录。",
    });
  }
  if (core.status === "running" && !core.webconsoleAvailable) {
    items.push({
      key: "webconsole-unavailable",
      severity: "warn",
      title: "WebConsole 未就绪",
      detail: `Core 已运行${core.port === undefined ? "" : `在 ${core.port} 端口`}，但 /app 暂不可访问。`,
      action: "等待启动完成；若超过 60 秒，检查 NO_PROXY、端口占用和 Core 日志。",
    });
  }
  return items;
}

export function severityColor(severity: TroubleshootingSeverity) {
  if (severity === "block") return "error";
  if (severity === "warn") return "warning";
  if (severity === "ok") return "success";
  return "processing";
}

export function severityLabel(severity: TroubleshootingSeverity) {
  if (severity === "block") return "阻断";
  if (severity === "warn") return "警告";
  if (severity === "ok") return "正常";
  return "提示";
}
