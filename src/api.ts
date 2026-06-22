import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { previewCommand } from "./dev/previewApi";
import { GSUID_CORE_SERVICE_ID } from "./serviceIds";
import type {
  AppState,
  ClearAppDataResult,
  ClearPortResult,
  CoreUpdateResult,
  LogEntry,
  MirrorCheckResult,
  NetworkDiagnosticResult,
  RuntimeBackupResult,
  RuntimeRestoreResult,
  ServiceSnapshot,
  SettingsTransferResult,
  Settings,
  SourceProbeResult,
  UpdateInfo,
  UpdateInstallResult,
} from "./types";

export interface AppStateChangedEvent {
  reason: string;
  emittedAt: string;
}

export interface ActionResultEvent {
  action: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  emittedAt: string;
}

export async function command<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriRuntime()) {
    return previewCommand<T>(name, args);
  }
  return invoke<T>(name, args);
}

export const gsdeskApi = {
  getAppState: () => command<AppState>("get_app_state"),
  checkServiceHealth: () => command<AppState>("check_service_health"),
  streamLogs: () => command<LogEntry[]>("stream_logs"),
  saveSettings: (settings: Settings) => command<AppState>("save_settings", { settings }),
  probeSources: () => command<SourceProbeResult[]>("probe_sources"),
  checkPypiMirrors: () => command<MirrorCheckResult[]>("check_pypi_mirrors"),
  testNetworkTargets: () => command<NetworkDiagnosticResult[]>("test_network_targets"),
  initCoreRuntime: () => command<AppState>("init_core_runtime"),
  repairRuntime: (action: "sync_deps" | "rebuild_venv" | "reclone_core" | "clear_uv_cache") =>
    command<AppState>("repair_runtime", { request: { action } }),
  clearOccupiedPort: (port?: number | null) => command<ClearPortResult>("clear_occupied_port", { request: { port } }),
  clearAppData: () => command<ClearAppDataResult>("clear_app_data"),
  coreUpdate: (
    action: "check" | "clean" | "list_commits" | "update" | "rollback",
    channel: "stable" | "latest" | "dev" = "latest",
    targetCommit?: string,
  ) => command<CoreUpdateResult>("core_update", { request: { action, channel, targetCommit } }),
  createRuntimeBackup: () => command<RuntimeBackupResult>("create_runtime_backup"),
  restoreRuntimeBackup: () => command<RuntimeRestoreResult>("restore_runtime_backup", { request: { path: null } }),
  exportSettings: () => command<SettingsTransferResult>("export_settings"),
  importSettings: () => command<AppState>("import_settings", { request: { path: null } }),
  bootstrapUv: () => command<AppState>("bootstrap_uv"),
  cancelCurrentTask: () => command<AppState>("cancel_current_task"),
  startGsuidCore: () =>
    command<ServiceSnapshot>("start_service", {
      request: { serviceId: GSUID_CORE_SERVICE_ID },
    }),
  stopGsuidCore: () => command<AppState>("stop_service", { serviceId: GSUID_CORE_SERVICE_ID }),
  openGsuidWebconsole: () => command<{ url: string }>("open_webconsole", { serviceId: GSUID_CORE_SERVICE_ID }),
  openExternalUrl: (url: string) => command<void>("open_external_url", { url }),
  exportDiagnostics: () => command<string>("export_diagnostics"),
  checkShellUpdate: () => command<UpdateInfo>("check_shell_update"),
  installShellUpdate: () => command<UpdateInstallResult>("install_shell_update"),
  openPath: (key: string) => command<void>("open_path", { key }),
};

export function subscribeLogs(handler: (entry: LogEntry) => void): Promise<() => void> {
  if (!isTauriRuntime()) {
    return Promise.resolve(() => undefined);
  }
  return listen<LogEntry>("gsdesk-log", (event) => handler(event.payload));
}

export function subscribeLogBatches(handler: (entries: LogEntry[]) => void): Promise<() => void> {
  if (!isTauriRuntime()) {
    return Promise.resolve(() => undefined);
  }
  return listen<LogEntry[]>("gsdesk-log-batch", (event) => handler(event.payload));
}

export function subscribeStateChanges(handler: (event: AppStateChangedEvent) => void): Promise<() => void> {
  if (!isTauriRuntime()) {
    return Promise.resolve(() => undefined);
  }
  return listen<AppStateChangedEvent>("gsdesk-state-changed", (event) => handler(event.payload));
}

export function subscribeActionResults(handler: (event: ActionResultEvent) => void): Promise<() => void> {
  if (!isTauriRuntime()) {
    return Promise.resolve(() => undefined);
  }
  return listen<ActionResultEvent>("gsdesk-action-result", (event) => handler(event.payload));
}

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
