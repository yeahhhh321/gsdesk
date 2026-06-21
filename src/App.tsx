import { lazy, Suspense } from "react";
import { Layout } from "antd";
import { useAppController } from "./appController";
import { AppHeader, AppSidebar } from "./ui/appShell";
import type { DiagnosticsSection } from "./pages/DiagnosticsPage";
import type { EnvironmentSection } from "./pages/EnvironmentPage";
import type { NetworkSection } from "./pages/NetworkPage";
import type { AppSectionKey } from "./ui/appSections";

const { Content } = Layout;

const OverviewPage = lazy(() => import("./pages/OverviewPage"));
const WebconsolePage = lazy(() => import("./pages/WebconsolePage"));
const LogsPage = lazy(() => import("./pages/LogsPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const EnvironmentPage = lazy(() => import("./pages/EnvironmentPage"));
const NetworkPage = lazy(() => import("./pages/NetworkPage"));
const DiagnosticsPage = lazy(() => import("./pages/DiagnosticsPage"));
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
            logs={controller.visibleLogs}
            healthScore={controller.healthScore}
            setupChecklist={controller.setupChecklist}
            loadingAction={controller.loadingAction}
            onStartCore={controller.startCore}
            onStopCore={controller.stopCore}
            onOpenWebconsole={controller.openWebconsole}
            onOpenInstallGuide={controller.openInstallGuide}
            onOpenEnvironment={() => controller.setActiveKey("environment_runtime")}
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
            onOpenEnvironment={() => controller.setActiveKey("environment_runtime")}
          />
        );
      case "logs":
        return <LogsPage logs={controller.visibleLogs} onOpenLogsDir={() => controller.openPath("logsDir")} />;
      case "settings":
        if (!controller.appState) return <PageFallback />;
        return (
          <SettingsPage
            appState={controller.appState}
            updateInfo={controller.updateInfo}
            loadingAction={controller.loadingAction}
            onSaveSettings={controller.saveSettings}
            onCheckShellUpdate={controller.checkShellUpdate}
            onInstallShellUpdate={controller.installShellUpdate}
            onExportSettings={controller.exportSettings}
            onImportSettings={controller.importSettings}
            onOpenPath={controller.openPath}
            onOpenInstallGuide={() => controller.openInstallGuide(0)}
          />
        );
      case "environment_runtime":
      case "environment_update":
      case "environment_data":
      case "environment_tasks":
        if (!controller.appState) return <PageFallback />;
        return (
          <EnvironmentPage
            section={environmentSection(controller.activeKey)}
            appState={controller.appState}
            loadingAction={controller.loadingAction}
            onInitRuntime={controller.initRuntime}
            onBootstrapUv={controller.bootstrapUv}
            onRepairRuntime={controller.repairRuntime}
            onClearOccupiedPort={controller.clearOccupiedPort}
            onCoreUpdate={controller.coreUpdate}
            onCancelTask={controller.cancelCurrentTask}
            onRetryTask={controller.retryTask}
            onCreateRuntimeBackup={controller.createRuntimeBackup}
            onRestoreRuntimeBackup={controller.restoreRuntimeBackup}
            onExportSettings={controller.exportSettings}
            onImportSettings={controller.importSettings}
            onClearAppData={controller.clearAppData}
            onRefreshState={controller.refreshState}
          />
        );
      case "network_settings":
      case "network_checks":
        if (!controller.appState) return <PageFallback />;
        return (
          <NetworkPage
            section={networkSection(controller.activeKey)}
            appState={controller.appState}
            sourceResults={controller.sourceResults}
            mirrorResults={controller.mirrorResults}
            networkDiagnostics={controller.networkDiagnostics}
            loadingAction={controller.loadingAction}
            onProbeSources={controller.probeSources}
            onCheckMirrors={controller.checkMirrors}
            onTestNetworkTargets={controller.testNetworkTargets}
            onSaveSettings={controller.saveSettings}
          />
        );
      case "diagnostics_export":
      case "diagnostics_failures":
        if (!controller.appState) return <PageFallback />;
        return (
          <DiagnosticsPage
            section={diagnosticsSection(controller.activeKey)}
            appState={controller.appState}
            logs={controller.visibleLogs}
            updateInfo={controller.updateInfo}
            loadingAction={controller.loadingAction}
            onExportDiagnostics={controller.exportDiagnostics}
            onCheckShellUpdate={controller.checkShellUpdate}
            onInstallShellUpdate={controller.installShellUpdate}
            onOpenDiagnosticsDir={() => controller.openPath("diagnosticsDir")}
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
              controller.setActiveKey(
                controller.appState?.settings.beginnerMode === false ? "network_settings" : "network_checks",
              );
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

function networkSection(route: AppSectionKey): NetworkSection {
  return route === "network_checks" ? "checks" : "settings";
}

function environmentSection(route: AppSectionKey): EnvironmentSection {
  if (route === "environment_update") return "update";
  if (route === "environment_data") return "data";
  if (route === "environment_tasks") return "tasks";
  return "runtime";
}

function diagnosticsSection(route: AppSectionKey): DiagnosticsSection {
  return route === "diagnostics_failures" ? "failures" : "export";
}

function PageFallback() {
  return <div className="page-loading">加载中...</div>;
}

export default App;
