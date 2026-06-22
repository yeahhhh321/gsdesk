import { useEffect, useMemo, useRef, useState } from "react";
import { App as AntdApp } from "antd";
import { gsdeskApi, subscribeActionResults, subscribeLogBatches, subscribeLogs, subscribeStateChanges } from "./api";
import { isCoreJsonLog } from "./logModel";
import { findGsuidCore } from "./serviceIds";
import { getSetupProgress } from "./ui/setupProgress";
import type { ActionResultEvent } from "./api";
import type {
  AppState,
  ClearAppDataResult,
  ClearPortResult,
  CoreUpdateResult,
  LogEntry,
  MirrorCheckResult,
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
const STATE_REFRESH_DELAY_MS = 120;
const WEBCONSOLE_READY_TIMEOUT_MS = 75_000;
const INSTALL_GUIDE_SEEN_KEY = "gsdesk.installGuide.seen";
const SHELL_UPDATE_LAST_AUTO_CHECK_KEY = "gsdesk.shellUpdate.lastAutoCheckAt";
const SHELL_UPDATE_AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

type RepairAction = "sync_deps" | "rebuild_venv" | "reclone_core" | "clear_uv_cache";
type CoreUpdateAction = "check" | "clean" | "list_commits" | "update" | "rollback";
type CoreUpdateChannel = "stable" | "latest" | "dev";
type WebconsoleWaitOutcome = "ready" | "failed" | "waiting" | "timeout";

interface WebconsoleStateWaiter {
  evaluate: (state: AppState) => WebconsoleWaitOutcome | undefined;
  resolve: (outcome: WebconsoleWaitOutcome) => void;
  timeoutId: number;
}

export function useAppController() {
  const { message } = AntdApp.useApp();
  const [activeKey, setActiveKey] = useState<AppSectionKey>("overview");
  const [appState, setAppStateValue] = useState<AppState>();
  const [loadingAction, setLoadingAction] = useState<string>();
  const [setupRunning, setSetupRunning] = useState(false);
  const [sourceResults, setSourceResults] = useState<SourceProbeResult[]>([]);
  const [mirrorResults, setMirrorResults] = useState<MirrorCheckResult[]>([]);
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
  const stateRefreshTimerRef = useRef<number | undefined>(undefined);
  const stateRefreshInFlightRef = useRef(false);
  const stateRefreshQueuedRef = useRef(false);
  const webconsoleWaitersRef = useRef<WebconsoleStateWaiter[]>([]);
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
    resolveWebconsoleWaiters(compactState);
  }

  function requestLogPaint() {
    if (
      !(
        activeKeyRef.current === "overview" ||
        activeKeyRef.current === "logs" ||
        activeKeyRef.current === "environment_runtime"
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

  function handleLogNotification(logs: LogEntry[]) {
    enqueueLogs(logs);
    if (logs.some(shouldRefreshStateForLog)) {
      scheduleStateRefresh();
    }
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

  function scheduleStateRefresh() {
    if (stateRefreshTimerRef.current !== undefined) return;
    stateRefreshTimerRef.current = window.setTimeout(() => {
      stateRefreshTimerRef.current = undefined;
      void refreshStateFromNotification();
    }, STATE_REFRESH_DELAY_MS);
  }

  async function refreshStateFromNotification() {
    if (stateRefreshInFlightRef.current) {
      stateRefreshQueuedRef.current = true;
      return;
    }
    stateRefreshInFlightRef.current = true;
    try {
      await refreshHealthState();
    } catch {
      // 通知触发的状态刷新不打断当前操作，显式按钮动作会单独反馈错误。
    } finally {
      stateRefreshInFlightRef.current = false;
      if (stateRefreshQueuedRef.current) {
        stateRefreshQueuedRef.current = false;
        scheduleStateRefresh();
      }
    }
  }

  async function refreshHealthState() {
    const state = await gsdeskApi.checkServiceHealth();
    setAppState(state);
    return state;
  }

  function handleActionResult(event: ActionResultEvent) {
    if (event.ok) {
      applyActionResult(event);
    }
    scheduleStateRefresh();
  }

  function applyActionResult(event: ActionResultEvent) {
    const result = event.result;
    if (event.action === "probe_sources" && isSourceProbeResults(result)) {
      setSourceResults(result);
      return;
    }
    if (event.action === "check_pypi_mirrors" && isMirrorCheckResults(result)) {
      setMirrorResults(result);
      return;
    }
    if (event.action === "check_shell_update" && isUpdateInfo(result)) {
      setUpdateInfo(result);
    }
  }

  function resolveWebconsoleWaiters(state: AppState) {
    if (!webconsoleWaitersRef.current.length) return;
    const remaining: WebconsoleStateWaiter[] = [];
    for (const waiter of webconsoleWaitersRef.current) {
      const outcome = waiter.evaluate(state);
      if (outcome) {
        window.clearTimeout(waiter.timeoutId);
        waiter.resolve(outcome);
      } else {
        remaining.push(waiter);
      }
    }
    webconsoleWaitersRef.current = remaining;
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
    const outcome = await waitForWebconsoleOutcome(timeoutMs);
    if (outcome === "ready") {
      return true;
    }
    if (outcome === "failed") {
      const currentCore = appStateRef.current ? findGsuidCore(appStateRef.current.services) : undefined;
      message.error(currentCore?.recentError ?? "Core 启动失败");
      return false;
    }
    message.warning("Core 已启动，WebConsole 仍在等待；可先查看日志或稍后手动打开");
    return false;
  }

  function waitForWebconsoleOutcome(timeoutMs: number) {
    const currentState = appStateRef.current;
    const currentOutcome = currentState ? getWebconsoleWaitOutcome(currentState) : undefined;
    if (currentOutcome) {
      return Promise.resolve(currentOutcome);
    }
    return new Promise<WebconsoleWaitOutcome>((resolve) => {
      const waiter: WebconsoleStateWaiter = {
        evaluate: getWebconsoleWaitOutcome,
        resolve,
        timeoutId: window.setTimeout(() => {
          webconsoleWaitersRef.current = webconsoleWaitersRef.current.filter((item) => item !== waiter);
          resolve("timeout");
        }, timeoutMs),
      };
      webconsoleWaitersRef.current.push(waiter);
    });
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

  async function installPlaywright() {
    const result = await runAction<AppState>("install_playwright", gsdeskApi.installPlaywright, "Playwright 已安装到隔离目录");
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
    if (task.name === "安装 Playwright") return installPlaywright();
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
    const info = await runAction<UpdateInfo>("update", gsdeskApi.checkShellUpdate);
    if (info) {
      setUpdateInfo(info);
      rememberShellUpdateAutoCheck();
    }
  }

  async function installShellUpdate() {
    const result = await runAction<UpdateInstallResult>("install_shell_update", gsdeskApi.installShellUpdate);
    if (!result) return false;
    message.success(result.message);
    return true;
  }

  async function openPath(key: string) {
    try {
      await gsdeskApi.openPath(key);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function selectDirectory(defaultPath?: string) {
    try {
      const selected = await gsdeskApi.selectDirectory(defaultPath);
      if (typeof selected === "string" && selected.trim()) {
        return selected;
      }
      return undefined;
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
      return undefined;
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
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    void subscribeLogs((entry) => handleLogNotification([entry]))
      .then((unlisten) => {
        if (cancelled) {
          unlisten();
          return;
        }
        unlisteners.push(unlisten);
      })
      .catch(() => undefined);
    void subscribeLogBatches(handleLogNotification)
      .then((unlisten) => {
        if (cancelled) {
          unlisten();
          return;
        }
        unlisteners.push(unlisten);
      })
      .catch(() => undefined);
    void subscribeStateChanges(() => scheduleStateRefresh())
      .then((unlisten) => {
        if (cancelled) {
          unlisten();
          return;
        }
        unlisteners.push(unlisten);
      })
      .catch(() => undefined);
    void subscribeActionResults(handleActionResult)
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
      if (stateRefreshTimerRef.current !== undefined) window.clearTimeout(stateRefreshTimerRef.current);
      if (logFrameRef.current) window.cancelAnimationFrame(logFrameRef.current);
      if (logFlushTimerRef.current !== undefined) window.clearTimeout(logFlushTimerRef.current);
      webconsoleWaitersRef.current.forEach((waiter) => {
        window.clearTimeout(waiter.timeoutId);
        waiter.resolve("timeout");
      });
      webconsoleWaitersRef.current = [];
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
    if (!shouldRunShellUpdateAutoCheck()) return;
    rememberShellUpdateAutoCheck();
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
    initRuntime,
    bootstrapUv,
    installPlaywright,
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
    openPath,
    selectDirectory,
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

function shouldRunShellUpdateAutoCheck(now = Date.now()) {
  try {
    const raw = window.localStorage.getItem(SHELL_UPDATE_LAST_AUTO_CHECK_KEY);
    if (raw === null) return true;
    const previous = Number(raw);
    if (!Number.isFinite(previous)) return true;
    return now - previous >= SHELL_UPDATE_AUTO_CHECK_INTERVAL_MS;
  } catch {
    return true;
  }
}

function rememberShellUpdateAutoCheck(now = Date.now()) {
  try {
    window.localStorage.setItem(SHELL_UPDATE_LAST_AUTO_CHECK_KEY, String(now));
  } catch {
    // localStorage 不可用时只影响自动检查节流，手动检查不受影响。
  }
}

function stripStateLogs(state: AppState): AppState {
  if (!state.recentLogs.length) return state;
  return { ...state, recentLogs: [] };
}

function shouldDisplayLogs(activeKey: AppSectionKey) {
  return activeKey === "overview" || activeKey === "logs" || activeKey === "environment_runtime";
}

function shouldRefreshStateForLog(entry: LogEntry) {
  return entry.stream === "system" || entry.level === "error";
}

function coreWebconsoleUrl(core?: ServiceSnapshot) {
  if (!core?.url) return "";
  return `${core.url}/app`;
}

function getWebconsoleWaitOutcome(state: AppState): WebconsoleWaitOutcome | undefined {
  const nextCore = findGsuidCore(state.services);
  if (nextCore?.status === "failed") {
    return "failed";
  }
  if (nextCore?.status === "running" && nextCore.webconsoleAvailable) {
    return "ready";
  }
  const waitingTask = state.taskHistory.find(
    (task) => task.name === "启动 Core" && task.status === "success" && task.stage === "waiting_webconsole",
  );
  if (nextCore?.status === "running" && waitingTask) {
    return "waiting";
  }
  return undefined;
}

function isSourceProbeResults(value: unknown): value is SourceProbeResult[] {
  return Array.isArray(value) && value.every(isSourceProbeResult);
}

function isMirrorCheckResults(value: unknown): value is MirrorCheckResult[] {
  return Array.isArray(value) && value.every(isMirrorCheckResult);
}

function isSourceProbeResult(value: unknown): value is SourceProbeResult {
  return (
    isObjectRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.url === "string" &&
    typeof value.ok === "boolean"
  );
}

function isMirrorCheckResult(value: unknown): value is MirrorCheckResult {
  return (
    isObjectRecord(value) && typeof value.name === "string" && typeof value.url === "string" && typeof value.ok === "boolean"
  );
}

function isUpdateInfo(value: unknown): value is UpdateInfo {
  return (
    isObjectRecord(value) &&
    typeof value.currentVersion === "string" &&
    typeof value.hasUpdate === "boolean" &&
    typeof value.channel === "string"
  );
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
