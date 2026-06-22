import { lazy, Suspense } from "react";
import { Layout } from "antd";
import { useAppController } from "./appController";
import { AppHeader, AppSidebar } from "./ui/appShell";
import type { EnvironmentSection } from "./pages/EnvironmentPage";
import type { AppSectionKey } from "./ui/appSections";

const { Content } = Layout;

const OverviewPage = lazy(() => import("./pages/OverviewPage"));
const WebconsolePage = lazy(() => import("./pages/WebconsolePage"));
const LogsPage = lazy(() => import("./pages/LogsPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const EnvironmentPage = lazy(() => import("./pages/EnvironmentPage"));
const InstallGuide = lazy(() => import("./ui/InstallGuide").then((module) => ({ default: module.InstallGuide })));

function App() {
  const controller = useAppController();

  function renderActivePage() {
    if (!controller.appState && controller.activeKey !== "overview" && controller.activeKey !== "logs") return <PageFallback />;

    switch (controller.activeKey) {
      case "overview":
        return (
          <OverviewPage
            appState={controller.appState}
            core={controller.core}
            setupChecklist={controller.setupChecklist}
            loadingAction={controller.loadingAction}
            onStartCore={controller.startCore}
            onStopCore={controller.stopCore}
            onOpenWebconsole={controller.openWebconsole}
            onOpenInstallGuide={controller.openInstallGuide}
            onOpenEnvironment={() => controller.setActiveKey("environment_runtime")}
            onOpenOperations={() => controller.setActiveKey("operation_records")}
            onOpenLogs={() => controller.setActiveKey("logs")}
          />
        );
      case "webconsole":
        return (
          <WebconsolePage
            core={controller.core}
            webconsoleUrl={controller.webconsoleUrl}
            frameVersion={controller.webconsoleFrameVersion}
            loadingAction={controller.loadingAction}
            onRefreshFrame={controller.refreshWebconsoleFrame}
            onOpenExternalUrl={controller.openExternalUrl}
            onStartCore={controller.startCore}
            onOpenInstallGuide={controller.openInstallGuide}
            onOpenLogs={() => controller.setActiveKey("logs")}
          />
        );
      case "logs":
        return <LogsPage logs={controller.visibleLogs} onOpenLogsDir={() => controller.openPath("logsDir")} />;
      case "settings":
        if (!controller.appState) return <PageFallback />;
        return (
          <SettingsPage
            appState={controller.appState}
            sourceResults={controller.sourceResults}
            mirrorResults={controller.mirrorResults}
            loadingAction={controller.loadingAction}
            onProbeSources={controller.probeSources}
            onCheckMirrors={controller.checkMirrors}
            onSaveSettings={controller.saveSettings}
            onSelectDirectory={controller.selectDirectory}
            onOpenPath={controller.openPath}
          />
        );
      case "environment_runtime":
      case "environment_update":
      case "operation_records":
        if (!controller.appState) return <PageFallback />;
        return (
          <EnvironmentPage
            section={environmentSection(controller.activeKey)}
            appState={controller.appState}
            logs={controller.visibleLogs}
            updateInfo={controller.updateInfo}
            loadingAction={controller.loadingAction}
            onInitRuntime={controller.initRuntime}
            onBootstrapUv={controller.bootstrapUv}
            onInstallPlaywright={controller.installPlaywright}
            onRepairRuntime={controller.repairRuntime}
            onClearOccupiedPort={controller.clearOccupiedPort}
            onCoreUpdate={controller.coreUpdate}
            onCancelTask={controller.cancelCurrentTask}
            onRetryTask={controller.retryTask}
            onCreateRuntimeBackup={controller.createRuntimeBackup}
            onRestoreRuntimeBackup={controller.restoreRuntimeBackup}
            onClearAppData={controller.clearAppData}
            onRefreshState={controller.refreshState}
          />
        );
      default:
        return <PageFallback />;
    }
  }

  return (
    <>
      <Layout className="app-shell">
        <AppSidebar
          activeKey={controller.activeKey}
          coreStatus={controller.core?.status ?? "uninitialized"}
          version={controller.appState?.version}
          beginnerMode={controller.appState?.settings.beginnerMode !== false}
          onSelect={controller.setActiveKey}
          updateInfo={controller.updateInfo}
          loadingAction={controller.loadingAction}
          onCheckShellUpdate={controller.checkShellUpdate}
          onInstallShellUpdate={controller.installShellUpdate}
        />
        <Layout>
          <AppHeader activeKey={controller.activeKey} onRefresh={controller.refreshState} />
          <Content className="content">
            <Suspense fallback={<PageFallback />}>{renderActivePage()}</Suspense>
          </Content>
        </Layout>
      </Layout>
      {controller.installGuideOpen && (
        <Suspense fallback={null}>
          <InstallGuide
            open={controller.installGuideOpen}
            activeStep={controller.installStep}
            appState={controller.appState}
            core={controller.core}
            sourceResults={controller.sourceResults}
            mirrorResults={controller.mirrorResults}
            loadingAction={controller.loadingAction}
            setupRunning={controller.setupRunning}
            onClose={() => controller.setInstallGuideOpen(false)}
            onStepChange={controller.setInstallStep}
            onOpenNetwork={() => {
              controller.setInstallGuideOpen(false);
              controller.setActiveKey("settings");
            }}
            onOpenLogs={() => {
              controller.setInstallGuideOpen(false);
              controller.setActiveKey("logs");
            }}
            onProbeSources={controller.probeSources}
            onCheckMirrors={controller.checkMirrors}
            onRunAll={controller.runFirstSetup}
            onInitRuntime={controller.initRuntime}
            onStartCore={controller.startCore}
            onOpenWebconsole={controller.openWebconsole}
          />
        </Suspense>
      )}
    </>
  );
}

function environmentSection(route: AppSectionKey): EnvironmentSection {
  if (route === "operation_records") return "tasks";
  return route === "environment_update" ? "core" : "workbench";
}

function PageFallback() {
  return <div className="page-loading">加载中...</div>;
}

export default App;
