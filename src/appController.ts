import { useEffect, useMemo, useRef, useState } from "react";
import { App as AntdApp } from "antd";
import { gsdeskApi, subscribeLogBatches, subscribeLogs } from "./api";
import { isCoreJsonLog } from "./logModel";
import { findGsuidCore } from "./serviceIds";
import { getSetupProgress } from "./ui/setupProgress";
import type {
  AppState,
  ClearAppDataResult,
  ClearPortResult,
  CoreUpdateResult,
  LogEntry,
  MirrorCheckResult,
  NetworkDiagnosticResult,
  RuntimeRestoreResult,
  ServiceSnapshot,
  Settings,
  SettingsTransferResult,
  SourceProbeResult,
  TaskRecord,
  UpdateInfo,
  UpdateInstallResult,
} from "./types";
import type { AppSectionKey } from "./ui/appSections";

const MAX_LOG_BUFFER = 5000;
const MAX_PENDING_LOG_BUFFER = 2000;
const LOG_FLUSH_DELAY_MS = 80;
const HEALTH_POLL_INTERVAL_MS = 1500;
const WEBCONSOLE_READY_TIMEOUT_MS = 75_000;
const INSTALL_GUIDE_SEEN_KEY = "gsdesk.installGuide.seen";

type RepairAction = "sync_deps" | "rebuild_venv" | "reclone_core" | "clear_uv_cache";
type CoreUpdateAction = "check" | "clean" | "list_commits" | "update" | "rollback";
type CoreUpdateChannel = "stable" | "latest" | "dev";

export function useAppController() {
  const { message } = AntdApp.useApp();
  const [activeKey, setActiveKey] = useState<AppSectionKey>("overview");
  const [appState, setAppStateValue] = useState<AppState>();
  const [loadingAction, setLoadingAction] = useState<string>();
  const [setupRunning, setSetupRunning] = useState(false);
  const [sourceResults, setSourceResults] = useState<SourceProbeResult[]>([]);
  const [mirrorResults, setMirrorResults] = useState<MirrorCheckResult[]>([]);
  const [networkDiagnostics, setNetworkDiagnostics] = useState<NetworkDiagnosticResult[]>([]);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo>();
  const [webconsoleUrl, setWebconsoleUrl] = useState("");
  const [webconsoleFrameVersion, setWebconsoleFrameVersion] = useState(0);
  const [installGuideOpen, setInstallGuideOpen] = useState(false);
  const [installStep, setInstallStep] = useState(0);
  const [logsVersion, setLogsVersion] = useState(0);

  const logsRef = useRef<LogEntry[]>([]);
  const logFrameRef = useRef<number | undefined>(undefined);
  const logFlushTimerRef = useRef<number | undefined>(undefined);
  const pendingLogsRef = useRef<LogEntry[]>([]);
  const activeKeyRef = useRef<AppSectionKey>("overview");
  const appStateRef = useRef<AppState | undefined>(undefined);
  const healthPollInFlightRef = useRef(false);
  const installGuideAutoOpened = useRef(false);
  const shellUpdateAutoChecked = useRef(false);

  const core = appState ? findGsuidCore(appState.services) : undefined;
  const visibleLogs = useMemo(() => logsRef.current, [logsVersion]);

  const healthScore = useMemo(() => {
    if (!appState) return 0;
    const checks = appState.preflightChecks;
    if (!checks.length) return 0;
    const passed = checks.reduce((score, check) => score + (check.status === "ok" ? 1 : check.status === "warn" ? 0.5 : 0), 0);
    const base = Math.round((passed / checks.length) * 70);
    const runtime = (core?.status === "running" ? 15 : 0) + (core?.webconsoleAvailable ? 15 : 0);
    return Math.min(base + runtime, 100);
  }, [appState, core]);

  const setupChecklist = useMemo(() => {
    return getSetupProgress({ appState, core, sourceResults, mirrorResults });
  }, [appState, core, mirrorResults, sourceResults]);

  function setAppState(state: AppState) {
    const compactState = stripStateLogs(state);
    appStateRef.current = compactState;
    setAppStateValue(compactState);
    setWebconsoleUrl(coreWebconsoleUrl(findGsuidCore(compactState.services)));
  }

  function requestLogPaint() {
    if (
      !(
        activeKeyRef.current === "overview" ||
        activeKeyRef.current === "logs" ||
        activeKeyRef.current.startsWith("diagnostics_")
      ) ||
      logFrameRef.current
    ) {
      return;
    }
    logFrameRef.current = window.requestAnimationFrame(() => {
      logFrameRef.current = undefined;
      setLogsVersion((version) => version + 1);
    });
  }

  function syncLogs(logs: LogEntry[]) {
    pendingLogsRef.current = [];
    logsRef.current = logs.filter(isCoreJsonLog).slice(-MAX_LOG_BUFFER);
    setLogsVersion((version) => version + 1);
  }

  function enqueueLogs(logs: LogEntry[]) {
    const coreLogs = logs.filter(isCoreJsonLog);
    if (!coreLogs.length) return;
    pendingLogsRef.current.push(...coreLogs);
    if (pendingLogsRef.current.length > MAX_PENDING_LOG_BUFFER) {
      pendingLogsRef.current.splice(0, pendingLogsRef.current.length - MAX_PENDING_LOG_BUFFER);
    }
    scheduleLogFlush();
  }

  function scheduleLogFlush() {
    if (logFlushTimerRef.current !== undefined) return;
    logFlushTimerRef.current = window.setTimeout(() => {
      logFlushTimerRef.current = undefined;
      flushPendingLogs();
    }, LOG_FLUSH_DELAY_MS);
  }

  function flushPendingLogs() {
    const pending = pendingLogsRef.current;
    if (!pending.length) return;
    pendingLogsRef.current = [];
    logsRef.current = [...logsRef.current, ...pending].slice(-MAX_LOG_BUFFER);
    requestLogPaint();
  }

  async function refreshState() {
    const state = await gsdeskApi.getAppState();
    syncLogs(state.recentLogs);
    setAppState(state);
  }

  async function pollHealthState() {
    if (healthPollInFlightRef.current) return;
    healthPollInFlightRef.current = true;
    try {
      await refreshHealthState();
    } finally {
      healthPollInFlightRef.current = false;
    }
  }

  async function refreshHealthState() {
    const state = await gsdeskApi.checkServiceHealth();
    setAppState(state);
    return state;
  }

  async function runAction<T>(
    key: string,
    action: () => Promise<T>,
    success?: string,
    refreshAfter = false,
  ): Promise<T | undefined> {
    setLoadingAction(key);
    try {
      const result = await action();
      if (success) message.success(success);
      if (refreshAfter) await refreshState();
      return result;
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
      return undefined;
    } finally {
      setLoadingAction(undefined);
    }
  }

  async function saveSettings(settings: Settings) {
    const result = await runAction<AppState>("save_settings", () => gsdeskApi.saveSettings(settings), "设置已保存");
    if (result) setAppState(result);
    return result;
  }

  async function probeSources() {
    const result = await runAction<SourceProbeResult[]>("probe_sources", gsdeskApi.probeSources);
    if (!result) return false;
    setSourceResults(result);
    const ok = result.some((item) => item.ok);
    const best = result.find((item) => item.ok);
    const currentState = appStateRef.current;
    if (currentState) {
      const nextSettings = {
        ...currentState.settings,
        selectedSource: best && currentState.settings.sourceMode === "auto" ? best.url : currentState.settings.selectedSource,
        lastSourceProbeAt: new Date().toISOString(),
      };
      const state = await gsdeskApi.saveSettings(nextSettings);
      setAppState(state);
    }
    if (ok) setInstallStep(2);
    return ok;
  }

  async function checkMirrors() {
    const result = await runAction<MirrorCheckResult[]>("check_mirrors", gsdeskApi.checkPypiMirrors);
    if (!result) return false;
    setMirrorResults(result);
    const ok = result.some((item) => item.ok);
    const best = result.find((item) => item.ok);
    const currentState = appStateRef.current;
    if (currentState) {
      const nextSettings = {
        ...currentState.settings,
        pypiIndexUrl: best && currentState.settings.pypiIndexMode === "auto" ? best.url : currentState.settings.pypiIndexUrl,
        lastMirrorCheckAt: new Date().toISOString(),
      };
      const state = await gsdeskApi.saveSettings(nextSettings);
      setAppState(state);
    }
    if (ok) setInstallStep(3);
    return ok;
  }

  async function testNetworkTargets() {
    const result = await runAction<NetworkDiagnosticResult[]>("test_network", gsdeskApi.testNetworkTargets);
    if (!result) return false;
    setNetworkDiagnostics(result);
    return result.some((item) => item.ok);
  }

  async function initRuntime() {
    const result = await runAction<AppState>("init", gsdeskApi.initCoreRuntime, "初始化任务已完成");
    if (!result) return false;
    setAppState(result);
    setInstallStep(4);
    return true;
  }

  async function startCore() {
    const result = await runAction<ServiceSnapshot>("start", gsdeskApi.startGsuidCore, "Core 启动中", true);
    if (!result) return false;
    setInstallStep(5);
    return true;
  }

  async function waitForWebconsoleReady(timeoutMs = WEBCONSOLE_READY_TIMEOUT_MS) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const state = await refreshHealthState();
      const nextCore = findGsuidCore(state.services);
      if (nextCore?.status === "failed") {
        message.error(nextCore.recentError ?? "Core 启动失败");
        return false;
      }
      if (nextCore?.status === "running" && nextCore.webconsoleAvailable) {
        return true;
      }
      await delay(1000);
    }
    message.warning("Core 已启动，WebConsole 仍在等待；可先查看日志或稍后手动打开");
    return false;
  }

  async function stopCore() {
    const result = await runAction<AppState>("stop", gsdeskApi.stopGsuidCore, "Core 已停止");
    if (result) setAppState(result);
    return Boolean(result);
  }

  async function repairRuntime(action: RepairAction) {
    const result = await runAction<AppState>(`repair_${action}`, () => gsdeskApi.repairRuntime(action), "修复动作已完成");
    if (!result) return false;
    setAppState(result);
    return true;
  }

  async function clearOccupiedPort() {
    const port = appStateRef.current?.settings.preferredCorePort ?? 8765;
    const result = await runAction<ClearPortResult>("clear_port", () => gsdeskApi.clearOccupiedPort(port), undefined, true);
    if (!result) return false;
    message.success(result.message);
    return true;
  }

  async function bootstrapUv() {
    const result = await runAction<AppState>("bootstrap_uv", gsdeskApi.bootstrapUv, "uv 已通过内置 Python 更新");
    if (!result) return false;
    setAppState(result);
    return true;
  }

  async function coreUpdate(action: CoreUpdateAction, channel: CoreUpdateChannel = "latest", targetCommit?: string) {
    const result = await runAction<CoreUpdateResult>(`core_${action}`, () => gsdeskApi.coreUpdate(action, channel, targetCommit));
    if (!result) return undefined;
    message.info(result.message);
    await refreshState();
    return result;
  }

  async function cancelCurrentTask() {
    const result = await runAction<AppState>("cancel_task", gsdeskApi.cancelCurrentTask, "已请求取消当前任务");
    if (!result) return false;
    setAppState(result);
    return true;
  }

  async function retryTask(task: TaskRecord) {
    if (!["failed", "cancelled"].includes(task.status)) {
      message.info("只有失败或已取消的任务可以重试");
      return false;
    }

    if (task.name === "初始化运行时") return initRuntime();
    if (task.name === "安装 uv") return bootstrapUv();
    if (task.name === "启动 Core") return startCore();
    if (task.name === "运行时修复") {
      const action = normalizeRepairAction(task.stage);
      if (action) return repairRuntime(action);
    }
    if (task.name === "Core 更新") {
      const action =
        task.stage === "rollback"
          ? "list_commits"
          : task.stage === "check"
            ? "check"
            : task.stage === "clean"
              ? "clean"
              : "update";
      return coreUpdate(action, "latest");
    }

    message.warning(`暂不支持重试任务：${task.name}`);
    return false;
  }

  async function createRuntimeBackup() {
    const result = await runAction("runtime_backup", gsdeskApi.createRuntimeBackup);
    if (!result) return false;
    message.success(`备份已导出：${result.path}`);
    await refreshState();
    return true;
  }

  async function restoreRuntimeBackup() {
    const result = await runAction<RuntimeRestoreResult>("runtime_restore", gsdeskApi.restoreRuntimeBackup);
    if (!result) return false;
    message.success(`已恢复：${result.restored.join("、")}`);
    await refreshState();
    return true;
  }

  async function exportSettings() {
    const result = await runAction<SettingsTransferResult>("settings_export", gsdeskApi.exportSettings);
    if (!result) return false;
    message.success(`设置已导出：${result.path}`);
    return true;
  }

  async function importSettings() {
    const result = await runAction<AppState>("settings_import", gsdeskApi.importSettings);
    if (!result) return false;
    setAppState(result);
    message.success("设置已导入，敏感代理字段保持当前值");
    return true;
  }

  async function clearAppData() {
    const result = await runAction<ClearAppDataResult>("clear_app_data", gsdeskApi.clearAppData);
    if (!result) return false;
    pendingLogsRef.current = [];
    logsRef.current = [];
    setLogsVersion((version) => version + 1);
    setSourceResults([]);
    setMirrorResults([]);
    setNetworkDiagnostics([]);
    setUpdateInfo(undefined);
    setWebconsoleUrl("");
    setWebconsoleFrameVersion((version) => version + 1);
    installGuideAutoOpened.current = false;
    try {
      window.sessionStorage.removeItem(INSTALL_GUIDE_SEEN_KEY);
    } catch {
      // sessionStorage 不可用时忽略；清理结果仍以本机数据为准。
    }
    message.success(`${result.message}，已删除 ${result.deleted.length} 项`);
    await refreshState();
    setActiveKey("overview");
    return true;
  }

  async function openWebconsole() {
    setLoadingAction("open_webconsole");
    try {
      const info = await gsdeskApi.openGsuidWebconsole();
      setWebconsoleUrl(info.url);
      setWebconsoleFrameVersion((version) => version + 1);
      const currentState = appStateRef.current;
      if (currentState && !currentState.settings.installGuideCompleted) {
        const state = await gsdeskApi.saveSettings({ ...currentState.settings, installGuideCompleted: true });
        setAppState(state);
      }
      setActiveKey("webconsole");
      setInstallGuideOpen(false);
      return true;
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setLoadingAction(undefined);
    }
  }

  async function runFirstSetup() {
    setSetupRunning(true);
    try {
      setInstallStep(1);
      const sourcesOk = await probeSources();
      if (!sourcesOk) return false;
      setInstallStep(2);
      const mirrorsOk = await checkMirrors();
      if (!mirrorsOk) return false;
      setInstallStep(3);
      if (!appStateRef.current?.uvDetected) {
        const uvOk = await bootstrapUv();
        if (!uvOk) return false;
      }
      const initOk = await initRuntime();
      if (!initOk) return false;
      setInstallStep(4);
      const startOk = await startCore();
      if (!startOk) return false;
      setInstallStep(5);
      const webconsoleReady = await waitForWebconsoleReady();
      if (!webconsoleReady) return false;
      return await openWebconsole();
    } finally {
      setSetupRunning(false);
    }
  }

  function openInstallGuide(step = 0) {
    setInstallStep(step);
    setInstallGuideOpen(true);
  }

  function refreshWebconsoleFrame() {
    if (!webconsoleUrl) return;
    setWebconsoleFrameVersion((version) => version + 1);
  }

  async function openExternalUrl(url: string) {
    await runAction<void>("open_external_url", () => gsdeskApi.openExternalUrl(url), "已交给系统浏览器打开");
  }

  async function checkShellUpdate() {
    const info = await runAction("update", gsdeskApi.checkShellUpdate);
    if (info) setUpdateInfo(info);
  }

  async function installShellUpdate() {
    const result = await runAction<UpdateInstallResult>("install_shell_update", gsdeskApi.installShellUpdate);
    if (!result) return false;
    message.success(result.message);
    return true;
  }

  async function exportDiagnostics() {
    return runAction("diagnostics", gsdeskApi.exportDiagnostics, "诊断包已导出");
  }

  async function openPath(key: string) {
    try {
      await gsdeskApi.openPath(key);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  }

  useEffect(() => {
    activeKeyRef.current = activeKey;
    requestLogPaint();
  }, [activeKey]);

  useEffect(() => {
    if (!shouldDisplayLogs(activeKey)) return;
    if (logsRef.current.length) {
      requestLogPaint();
      return;
    }
    void gsdeskApi
      .streamLogs()
      .then(syncLogs)
      .catch(() => undefined);
  }, [activeKey]);

  useEffect(() => {
    refreshState().catch((error) => message.error(String(error)));
    const timer = window.setInterval(() => {
      void pollHealthState().catch(() => undefined);
    }, HEALTH_POLL_INTERVAL_MS);
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    void subscribeLogs((entry) => enqueueLogs([entry]))
      .then((unlisten) => {
        if (cancelled) {
          unlisten();
          return;
        }
        unlisteners.push(unlisten);
      })
      .catch(() => undefined);
    void subscribeLogBatches(enqueueLogs)
      .then((unlisten) => {
        if (cancelled) {
          unlisten();
          return;
        }
        unlisteners.push(unlisten);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unlisteners.forEach((unlisten) => unlisten());
      window.clearInterval(timer);
      if (logFrameRef.current) window.cancelAnimationFrame(logFrameRef.current);
      if (logFlushTimerRef.current !== undefined) window.clearTimeout(logFlushTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!appState || installGuideAutoOpened.current) return;
    const coreSnapshot = findGsuidCore(appState.services);
    const alreadySeen = readInstallGuideSeen();
    if (coreSnapshot?.status === "uninitialized" && !appState.settings.installGuideCompleted && !alreadySeen) {
      installGuideAutoOpened.current = true;
      try {
        window.sessionStorage.setItem(INSTALL_GUIDE_SEEN_KEY, "1");
      } catch {
        // 受限 WebView 可能禁用 sessionStorage，引导仍可手动打开。
      }
      openInstallGuide(0);
    }
  }, [appState]);

  useEffect(() => {
    if (!appState || shellUpdateAutoChecked.current || !appState.settings.autoCheckUpdate) return;
    shellUpdateAutoChecked.current = true;
    gsdeskApi
      .checkShellUpdate()
      .then((info) => {
        setUpdateInfo(info);
        if (info.hasUpdate) {
          message.info(`发现 GSDesk 壳更新：${info.latestVersion ?? "新版本"}`);
        }
      })
      .catch(() => undefined);
  }, [appState, message]);

  return {
    activeKey,
    appState,
    core,
    healthScore,
    setupChecklist,
    visibleLogs,
    loadingAction,
    setupRunning,
    sourceResults,
    mirrorResults,
    networkDiagnostics,
    updateInfo,
    webconsoleUrl,
    webconsoleFrameVersion,
    installGuideOpen,
    installStep,
    setActiveKey,
    setInstallStep,
    setInstallGuideOpen,
    refreshState,
    probeSources,
    checkMirrors,
    testNetworkTargets,
    initRuntime,
    bootstrapUv,
    repairRuntime,
    clearOccupiedPort,
    coreUpdate,
    cancelCurrentTask,
    retryTask,
    createRuntimeBackup,
    restoreRuntimeBackup,
    exportSettings,
    importSettings,
    clearAppData,
    saveSettings,
    startCore,
    stopCore,
    openWebconsole,
    refreshWebconsoleFrame,
    openExternalUrl,
    openInstallGuide,
    runFirstSetup,
    checkShellUpdate,
    installShellUpdate,
    exportDiagnostics,
    openPath,
  };
}

function normalizeRepairAction(stage: string): RepairAction | undefined {
  if (stage === "sync_deps" || stage === "rebuild_venv" || stage === "reclone_core" || stage === "clear_uv_cache") {
    return stage;
  }
  return undefined;
}

function readInstallGuideSeen() {
  try {
    return window.sessionStorage.getItem(INSTALL_GUIDE_SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

function stripStateLogs(state: AppState): AppState {
  if (!state.recentLogs.length) return state;
  return { ...state, recentLogs: [] };
}

function shouldDisplayLogs(activeKey: AppSectionKey) {
  return activeKey === "overview" || activeKey === "logs" || activeKey.startsWith("diagnostics_");
}

function coreWebconsoleUrl(core?: ServiceSnapshot) {
  if (!core?.url) return "";
  return `${core.url}/app`;
}

function delay(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}
