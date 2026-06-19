export type ServiceStatus =
  | "uninitialized"
  | "checking"
  | "initializing"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed"
  | "crashed";

export interface ProxySettings {
  httpProxy: string;
  httpsProxy: string;
  allProxy: string;
  noProxy: string;
}

export interface Settings {
  sourceMode: "auto" | "github" | "cnb";
  selectedSource: string;
  pypiIndexMode: "auto" | "manual";
  pypiIndexUrl: string;
  preferredCorePort?: number | null;
  lastSourceProbeAt?: string;
  lastMirrorCheckAt?: string;
  proxy: ProxySettings;
  closeCoreOnExit: boolean;
  autoCheckUpdate: boolean;
  installGuideCompleted: boolean;
  language: "zh-CN";
}

export interface AppPaths {
  appData: string;
  runtime: string;
  toolsDir: string;
  coreDir: string;
  venvDir: string;
  uvCacheDir: string;
  uvPythonDir: string;
  uvExecutable: string;
  logsDir: string;
  diagnosticsDir: string;
  backupsDir: string;
  settingsFile: string;
}

export interface ToolchainInfo {
  uvDetected: boolean;
  uvPath?: string;
  uvSource: "runtime" | "bundle" | "path" | "missing" | string;
  uvVersion?: string;
  uvBootstrapSupported: boolean;
  uvBootstrapTarget: string;
  uvBootstrapUrl?: string;
  uvError?: string;
}

export interface ServiceSnapshot {
  serviceId: string;
  name: string;
  status: ServiceStatus;
  port?: number;
  pid?: number;
  url?: string;
  startedAt?: string;
  currentCommit?: string;
  currentTag?: string;
  recentError?: string;
  healthOk: boolean;
  webconsoleAvailable: boolean;
}

export interface LogEntry {
  id: number;
  serviceId: string;
  stream: "core" | "stdout" | "stderr" | "system";
  level: "info" | "success" | "warn" | "error";
  line: string;
  message: string;
  module?: string;
  raw?: string;
  timestamp: string;
}

export interface AppState {
  version: string;
  settings: Settings;
  paths: AppPaths;
  services: ServiceSnapshot[];
  recentLogs: LogEntry[];
  preflightChecks: PreflightCheck[];
  taskHistory: TaskRecord[];
  toolchain: ToolchainInfo;
  uvDetected: boolean;
}

export interface PreflightCheck {
  id: string;
  label: string;
  status: "ok" | "warn" | "block";
  detail: string;
  action?: string;
}

export interface TaskRecord {
  id: number;
  name: string;
  status: "running" | "success" | "failed" | "cancelled";
  stage: string;
  message: string;
  startedAt: string;
  endedAt?: string;
  elapsedMs?: number;
}

export interface CoreUpdateResult {
  action: "check" | "update" | "rollback" | string;
  channel: "stable" | "latest" | "dev" | "rollback" | string;
  currentCommit?: string;
  targetCommit?: string;
  rollbackCommit?: string;
  changed: boolean;
  message: string;
}

export interface RuntimeBackupResult {
  path: string;
  included: string[];
}

export interface RuntimeRestoreResult {
  path: string;
  safetyBackup?: string;
  restored: string[];
}

export interface SettingsTransferResult {
  path: string;
  fields: string[];
  skipped: string[];
}

export interface CoreConfigFileSummary {
  relativePath: string;
  label: string;
  path: string;
  sizeBytes: number;
  modifiedAt?: string;
  entryCount: number;
  secretCount: number;
}

export interface CoreConfigEntry {
  key: string;
  title: string;
  description: string;
  value: unknown;
  valueType: "null" | "bool" | "number" | "string" | "array" | "object" | string;
  options: unknown[];
  secret: boolean;
  editable: boolean;
}

export interface CoreConfigFileContent {
  relativePath: string;
  path: string;
  schema: "gsuid" | "plain" | string;
  entries: CoreConfigEntry[];
}

export interface CoreConfigSaveResult {
  relativePath: string;
  path: string;
  backupPath?: string;
  saved: string[];
  skipped: string[];
}

export interface SourceProbeResult {
  id: string;
  name: string;
  url: string;
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

export interface MirrorCheckResult {
  name: string;
  url: string;
  ok: boolean;
  latencyMs?: number;
  speedMbps?: number;
  error?: string;
}

export interface NetworkDiagnosticResult {
  id: string;
  label: string;
  target: string;
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

export interface UpdateInfo {
  currentVersion: string;
  latestVersion?: string;
  prereleaseVersion?: string;
  hasUpdate: boolean;
  channel: "latest" | "prerelease" | "current" | "error";
  releaseUrl?: string;
  prereleaseUrl?: string;
  notes?: string;
  error?: string;
}
