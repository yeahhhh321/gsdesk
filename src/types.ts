export type ServiceStatus =
  | "uninitialized"
  | "checking"
  | "initializing"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";

export interface ProxySettings {
  httpProxy: string;
  httpsProxy: string;
  allProxy: string;
  noProxy: string;
}

export interface Settings {
  beginnerMode: boolean;
  sourceMode: "auto" | "github" | "cnb";
  selectedSource: string;
  customCoreDir: string;
  pypiIndexMode: "auto" | "manual";
  pypiIndexUrl: string;
  playwrightDownloadHost: string;
  preferredCorePort?: number | null;
  lastSourceProbeAt?: string;
  lastMirrorCheckAt?: string;
  proxy: ProxySettings;
  closeCoreOnExit: boolean;
  hideToTrayOnClose: boolean;
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
  playwrightBrowsersDir: string;
  logsDir: string;
  diagnosticsDir: string;
  backupsDir: string;
  settingsFile: string;
}

export interface ToolchainInfo {
  uvDetected: boolean;
  uvPath?: string;
  uvSource: "runtime" | "missing" | string;
  uvVersion?: string;
  uvBootstrapSupported: boolean;
  uvBootstrapTarget: string;
  uvBootstrapUrl?: string;
  bundledPythonAvailable: boolean;
  bundledPythonPath?: string;
  uvError?: string;
  playwrightDetected: boolean;
  playwrightBrowsersPath: string;
  playwrightError?: string;
  gitDetected: boolean;
  gitPath?: string;
  gitSource: "runtime" | "bundle" | "system" | "missing" | string;
  gitVersion?: string;
  bundledGitAvailable: boolean;
  bundledGitPath?: string;
  gitError?: string;
}

export interface ServiceSnapshot {
  serviceId: string;
  name: string;
  status: ServiceStatus;
  port?: number;
  pid?: number;
  memoryBytes?: number;
  url?: string;
  startedAt?: string;
  currentCommit?: string;
  currentTag?: string;
  recentError?: string;
  healthOk: boolean;
  webconsoleAvailable: boolean;
}

export interface ProcessResourceUsage {
  pid: number;
  memoryBytes?: number;
}

export interface LogEntry {
  id: number;
  serviceId: string;
  stream: "core" | "stdout" | "stderr" | "system";
  level: "debug" | "info" | "warn" | "error";
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
  shell: ProcessResourceUsage;
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

export interface CoreCommitEntry {
  commit: string;
  shortCommit: string;
  subject: string;
  author: string;
  committedAt: string;
  isCurrent: boolean;
  isRollback: boolean;
}

export interface CoreUpdateResult {
  action: "check" | "clean" | "list_commits" | "update" | "rollback" | string;
  channel: "stable" | "latest" | "dev" | "rollback" | "local" | string;
  currentCommit?: string;
  targetCommit?: string;
  rollbackCommit?: string;
  commits: CoreCommitEntry[];
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

export interface PortOccupant {
  pid: number;
  name: string;
  path?: string;
}

export interface ClearPortResult {
  port: number;
  occupants: PortOccupant[];
  killedPids: number[];
  released: boolean;
  message: string;
}

export interface ClearAppDataResult {
  appData: string;
  deleted: string[];
  message: string;
}

export interface SettingsTransferResult {
  path: string;
  fields: string[];
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

export interface UpdateInstallResult {
  version?: string;
  message: string;
}
