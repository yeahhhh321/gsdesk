import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Layout, message } from "antd";
import { gsdeskApi, subscribeLogs } from "./api";
import { AppHeader, AppSidebar, type AppSectionKey } from "./ui/appShell";
import { getSetupProgress } from "./ui/setupProgress";
import type {
  AppState,
  LogEntry,
  MirrorCheckResult,
  NetworkDiagnosticResult,
  RuntimeRestoreResult,
  ServiceSnapshot,
  SettingsTransferResult,
  Settings as SettingsType,
  SourceProbeResult,
  TaskRecord,
  UpdateInfo,
} from "./types";

const { Content } = Layout;
const MAX_LOG_BUFFER = 5000;

const OverviewPage = lazy(() => import("./pages/OverviewPage"));
const WebconsolePage = lazy(() => import("./pages/WebconsolePage"));
const LogsPage = lazy(() => import("./pages/LogsPage"));
const EnvironmentPage = lazy(() => import("./pages/EnvironmentPage"));
const NetworkPage = lazy(() => import("./pages/NetworkPage"));
const DiagnosticsPage = lazy(() => import("./pages/DiagnosticsPage"));
const InstallGuide = lazy(() => import("./ui/InstallGuide").then((module) => ({ default: module.InstallGuide })));

function App() {
  const [activeKey, setActiveKey] = useState<AppSectionKey>("overview");
  const [appState, setAppState] = useState<AppState>();
  const [loadingAction, setLoadingAction] = useState<string>();
  const [setupRunning, setSetupRunning] = useState(false);
  const [sourceResults, setSourceResults] = useState<SourceProbeResult[]>([]);
  const [mirrorResults, setMirrorResults] = useState<MirrorCheckResult[]>([]);
  const [networkDiagnostics, setNetworkDiagnostics] = useState<NetworkDiagnosticResult[]>([]);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo>();
  const [webconsoleUrl, setWebconsoleUrl] = useState("");
  const [installGuideOpen, setInstallGuideOpen] = useState(false);
  const [installStep, setInstallStep] = useState(0);
  const [logsVersion, setLogsVersion] = useState(0);

  const logsRef = useRef<LogEntry[]>([]);
  const logFrameRef = useRef<number | undefined>(undefined);
  const activeKeyRef = useRef<AppSectionKey>("overview");
  const installGuideAutoOpened = useRef(false);

  const core = appState?.services.find((service) => service.serviceId === "gsuid_core");
  const nonebot = appState?.services.find((service) => service.serviceId === "nonebot2");
  const visibleLogs = useMemo(() => logsRef.current, [logsVersion]);

  function requestLogPaint() {
    if (activeKeyRef.current !== "logs" || logFrameRef.current) return;
    logFrameRef.current = window.requestAnimationFrame(() => {
      logFrameRef.current = undefined;
      setLogsVersion((version) => version + 1);
    });
  }

  function syncLogs(logs: LogEntry[]) {
    logsRef.current = logs;
    requestLogPaint();
  }

  async function refreshState() {
    const state = await gsdeskApi.getAppState();
    setAppState(state);
    syncLogs(state.recentLogs);
    if (state.services[0]?.url) setWebconsoleUrl(`${state.services[0].url}/app`);
  }

  async function runAction<T>(key: string, action: () => Promise<T>, success?: string): Promise<T | undefined> {
    setLoadingAction(key);
    try {
      const result = await action();
      if (success) message.success(success);
      await refreshState();
      return result;
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
      return undefined;
    } finally {
      setLoadingAction(undefined);
    }
  }

  async function probeSources() {
    const result = await runAction<SourceProbeResult[]>("probe_sources", gsdeskApi.probeSources);
    if (!result) return false;
    setSourceResults(result);
    const ok = result.some((item) => item.ok);
    const best = result.find((item) => item.ok);
    if (appState) {
      const nextSettings = {
        ...appState.settings,
        selectedSource: best && appState.settings.sourceMode === "auto" ? best.url : appState.settings.selectedSource,
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
    if (best && appState && appState.settings.pypiIndexMode === "auto") {
      const nextSettings = { ...appState.settings, pypiIndexUrl: best.url, lastMirrorCheckAt: new Date().toISOString() };
      const state = await gsdeskApi.saveSettings(nextSettings);
      setAppState(state);
    } else if (appState) {
      const state = await gsdeskApi.saveSettings({ ...appState.settings, lastMirrorCheckAt: new Date().toISOString() });
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
    const result = await runAction<ServiceSnapshot>("start", gsdeskApi.startGsuidCore, "Core 启动中");
    if (!result) return false;
    setInstallStep(5);
    return true;
  }

  async function repairRuntime(action: "sync_deps" | "rebuild_venv" | "reclone_core" | "clear_uv_cache") {
    const result = await runAction<AppState>(`repair_${action}`, () => gsdeskApi.repairRuntime(action), "修复动作已完成");
    if (!result) return false;
    setAppState(result);
    return true;
  }

  async function bootstrapUv() {
    const result = await runAction<AppState>("bootstrap_uv", gsdeskApi.bootstrapUv, "uv 已安装到隔离目录");
    if (!result) return false;
    setAppState(result);
    return true;
  }

  async function coreUpdate(action: "check" | "update" | "rollback", channel: "stable" | "latest" | "dev" = "latest") {
    const result = await runAction(`core_${action}`, () => gsdeskApi.coreUpdate(action, channel));
    if (!result) return false;
    message.info(result.message);
    await refreshState();
    return true;
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
      const action = task.stage === "rollback" ? "rollback" : task.stage === "check" ? "check" : "update";
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

  async function openWebconsole() {
    setLoadingAction("open_webconsole");
    try {
      const info = await gsdeskApi.openGsuidWebconsole();
      setWebconsoleUrl(info.url);
      if (appState && !appState.settings.installGuideCompleted) {
        const state = await gsdeskApi.saveSettings({ ...appState.settings, installGuideCompleted: true });
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
      if (!appState?.uvDetected) {
        const uvOk = await bootstrapUv();
        if (!uvOk) return false;
      }
      const initOk = await initRuntime();
      if (!initOk) return false;
      setInstallStep(4);
      const startOk = await startCore();
      if (!startOk) return false;
      setInstallStep(5);
      return await openWebconsole();
    } finally {
      setSetupRunning(false);
    }
  }

  function openInstallGuide(step = 0) {
    setInstallStep(step);
    setInstallGuideOpen(true);
  }

  useEffect(() => {
    activeKeyRef.current = activeKey;
    requestLogPaint();
  }, [activeKey]);

  useEffect(() => {
    refreshState().catch((error) => message.error(String(error)));
    const timer = window.setInterval(() => {
      gsdeskApi
        .checkServiceHealth()
        .then((state) => {
          setAppState(state);
          syncLogs(state.recentLogs);
        })
        .catch(() => undefined);
    }, 5000);
    subscribeLogs((entry) => {
      logsRef.current = [...logsRef.current.slice(-(MAX_LOG_BUFFER - 1)), entry];
      requestLogPaint();
    }).catch(() => undefined);
    return () => {
      window.clearInterval(timer);
      if (logFrameRef.current) window.cancelAnimationFrame(logFrameRef.current);
    };
  }, []);

  useEffect(() => {
    if (!appState || installGuideAutoOpened.current) return;
    const coreSnapshot = appState.services.find((service) => service.serviceId === "gsuid_core");
    let alreadySeen = false;
    try {
      alreadySeen = window.sessionStorage.getItem("gsdesk.installGuide.seen") === "1";
    } catch {
      alreadySeen = false;
    }
    if (coreSnapshot?.status === "uninitialized" && !appState.settings.installGuideCompleted && !alreadySeen) {
      installGuideAutoOpened.current = true;
      try {
        window.sessionStorage.setItem("gsdesk.installGuide.seen", "1");
      } catch {
        // Restricted webviews can disable storage; the guide still works manually.
      }
      openInstallGuide(0);
    }
  }, [appState]);

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

  function renderActivePage() {
    if (!appState && activeKey !== "overview" && activeKey !== "logs") return <PageFallback />;

    switch (activeKey) {
      case "overview":
        return (
          <OverviewPage
            appState={appState}
            core={core}
            nonebot={nonebot}
            healthScore={healthScore}
            setupChecklist={setupChecklist}
            loadingAction={loadingAction}
            onStartCore={() => startCore()}
            onStopCore={() => runAction("stop", gsdeskApi.stopGsuidCore, "Core 已停止")}
            onRestartCore={() => runAction("restart", gsdeskApi.restartGsuidCore, "Core 重启中")}
            onOpenWebconsole={() => openWebconsole()}
            onOpenInstallGuide={openInstallGuide}
          />
        );
      case "webconsole":
        return <WebconsolePage webconsoleUrl={webconsoleUrl} onRefreshFrame={() => setWebconsoleUrl((url) => `${url}`)} />;
      case "logs":
        return <LogsPage logs={visibleLogs} onOpenLogsDir={() => gsdeskApi.openPath("logsDir").catch((error) => message.error(String(error)))} />;
      case "environment":
        return (
          <EnvironmentPage
            appState={appState as AppState}
            loadingAction={loadingAction}
            onInitRuntime={() => initRuntime()}
            onBootstrapUv={() => bootstrapUv()}
            onRepairRuntime={repairRuntime}
            onCoreUpdate={coreUpdate}
            onCancelTask={cancelCurrentTask}
            onRetryTask={retryTask}
            onCreateRuntimeBackup={createRuntimeBackup}
            onRestoreRuntimeBackup={restoreRuntimeBackup}
            onExportSettings={exportSettings}
            onImportSettings={importSettings}
            onRefreshState={() => refreshState()}
          />
        );
      case "network":
        return (
          <NetworkPage
            appState={appState as AppState}
            sourceResults={sourceResults}
            mirrorResults={mirrorResults}
            networkDiagnostics={networkDiagnostics}
            loadingAction={loadingAction}
            onProbeSources={() => probeSources()}
            onCheckMirrors={() => checkMirrors()}
            onTestNetworkTargets={() => testNetworkTargets()}
            onSaveSettings={(settings: SettingsType) => runAction("save_settings", () => gsdeskApi.saveSettings(settings), "设置已保存")}
          />
        );
      case "diagnostics":
        return (
          <DiagnosticsPage
            appState={appState as AppState}
            updateInfo={updateInfo}
            loadingAction={loadingAction}
            onExportDiagnostics={() => runAction("diagnostics", gsdeskApi.exportDiagnostics, "诊断包已导出")}
            onCheckShellUpdate={async () => {
              const info = await runAction("update", gsdeskApi.checkShellUpdate);
              if (info) setUpdateInfo(info);
            }}
            onOpenDiagnosticsDir={() => gsdeskApi.openPath("diagnosticsDir").catch((error) => message.error(String(error)))}
          />
        );
      default:
        return <PageFallback />;
    }
  }

  return (
    <>
      <Layout className="app-shell">
        <AppSidebar activeKey={activeKey} coreStatus={core?.status || "uninitialized"} version={appState?.version} onSelect={setActiveKey} />
        <Layout>
          <AppHeader activeKey={activeKey} onRefresh={() => refreshState()} />
          <Content className="content">
            <Suspense fallback={<PageFallback />}>{renderActivePage()}</Suspense>
          </Content>
        </Layout>
      </Layout>
      {installGuideOpen && (
        <Suspense fallback={null}>
          <InstallGuide
            open={installGuideOpen}
            activeStep={installStep}
            appState={appState}
            core={core}
            sourceResults={sourceResults}
            mirrorResults={mirrorResults}
            loadingAction={loadingAction}
            setupRunning={setupRunning}
            onClose={() => setInstallGuideOpen(false)}
            onStepChange={setInstallStep}
            onOpenNetwork={() => {
              setInstallGuideOpen(false);
              setActiveKey("network");
            }}
            onOpenLogs={() => {
              setInstallGuideOpen(false);
              setActiveKey("logs");
            }}
            onProbeSources={probeSources}
            onCheckMirrors={checkMirrors}
            onRunAll={runFirstSetup}
            onInitRuntime={initRuntime}
            onStartCore={startCore}
            onOpenWebconsole={openWebconsole}
          />
        </Suspense>
      )}
    </>
  );
}

function normalizeRepairAction(stage: string): "sync_deps" | "rebuild_venv" | "reclone_core" | "clear_uv_cache" | undefined {
  if (stage === "sync_deps" || stage === "rebuild_venv" || stage === "reclone_core" || stage === "clear_uv_cache") {
    return stage;
  }
  return undefined;
}

function PageFallback() {
  return <div className="page-loading">加载中...</div>;
}

export default App;
