import type {
  AppState,
  MirrorCheckResult,
  ServiceSnapshot,
  SourceProbeResult,
} from "../types";

export interface SetupProgressContext {
  appState?: AppState;
  core?: ServiceSnapshot;
  sourceResults: SourceProbeResult[];
  mirrorResults: MirrorCheckResult[];
}

export interface SetupProgressItem {
  label: string;
  detail: string;
  done: boolean;
  error?: boolean;
}

export function getSetupProgress({
  appState,
  core,
  sourceResults,
  mirrorResults,
}: SetupProgressContext): SetupProgressItem[] {
  const sourceReady = sourceResults.some((item) => item.ok);
  const mirrorReady = mirrorResults.some((item) => item.ok);
  const runtimeReady = Boolean(core && core.status !== "uninitialized");
  const running = core?.status === "running";
  const consoleReady = Boolean(core?.webconsoleAvailable);
  const failed = core?.status === "failed" || core?.status === "crashed";
  const blockers = appState?.preflightChecks.filter((check) => check.status === "block").length || 0;
  const warnings = appState?.preflightChecks.filter((check) => check.status === "warn").length || 0;

  return [
    {
      label: "环境预检",
      detail: blockers ? `${blockers} 个阻断项` : warnings ? `${warnings} 个警告项` : "预检通过",
      done: Boolean(appState) && blockers === 0,
      error: blockers > 0,
    },
    { label: "源码源", detail: sourceReady ? "已探测可用源" : "待测速 GitHub/CNB", done: sourceReady },
    { label: "PyPI 镜像", detail: mirrorReady ? "已测速镜像" : "待测速镜像", done: mirrorReady },
    {
      label: "运行时",
      detail: runtimeReady ? "Core 已初始化" : "待初始化",
      done: runtimeReady,
      error: failed,
    },
    {
      label: "启动 Core",
      detail: running ? `端口 ${core?.port}` : "待启动",
      done: running,
      error: failed,
    },
    {
      label: "WebConsole",
      detail: consoleReady ? "可访问 /app" : "待打开",
      done: consoleReady,
    },
  ];
}
