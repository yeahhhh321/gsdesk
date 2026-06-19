import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AppState,
  CoreConfigFileContent,
  CoreConfigFileSummary,
  CoreConfigSaveResult,
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
} from "./types";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const GSUID_CORE_SERVICE_ID = "gsuid_core";

const mockState: AppState = {
  version: "0.1.0",
  uvDetected: false,
  settings: {
    sourceMode: "auto",
    selectedSource: "https://github.com/Genshin-bots/gsuid_core.git",
    pypiIndexMode: "auto",
    pypiIndexUrl: "https://pypi.org/simple/",
    preferredCorePort: null,
    closeCoreOnExit: true,
    autoCheckUpdate: true,
    installGuideCompleted: false,
    language: "zh-CN",
    proxy: {
      httpProxy: "",
      httpsProxy: "",
      allProxy: "",
      noProxy: "127.0.0.1,localhost,::1",
    },
  },
  paths: {
    appData: "开发预览模式",
    runtime: "开发预览模式/runtime",
    toolsDir: "开发预览模式/runtime/tools",
    coreDir: "开发预览模式/runtime/core/gsuid_core",
    venvDir: "开发预览模式/runtime/venvs/gsuid_core",
    uvCacheDir: "开发预览模式/runtime/uv/cache",
    uvPythonDir: "开发预览模式/runtime/uv/python",
    uvExecutable: "开发预览模式/runtime/tools/uv/uv.exe",
    logsDir: "开发预览模式/logs",
    diagnosticsDir: "开发预览模式/diagnostics",
    backupsDir: "开发预览模式/runtime/backups",
    settingsFile: "开发预览模式/settings.json",
  },
  toolchain: {
    uvDetected: false,
    uvSource: "missing",
    uvBootstrapSupported: true,
    uvBootstrapTarget: "开发预览模式/runtime/tools/uv/uv.exe",
    uvBootstrapUrl: "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip",
    uvError: "未检测到 uv",
  },
  services: [
    {
      serviceId: "gsuid_core",
      name: "Gsuid Core",
      status: "uninitialized",
      currentCommit: "dev",
      healthOk: false,
      webconsoleAvailable: false,
    },
    {
      serviceId: "nonebot2",
      name: "NoneBot2",
      status: "uninitialized",
      recentError: "v1 仅预留架构，后续接入",
      healthOk: false,
      webconsoleAvailable: false,
    },
  ],
  recentLogs: createMockLogs(1200),
  preflightChecks: [
    { id: "os", label: "系统", status: "ok", detail: "windows / x86_64" },
    { id: "git", label: "Git", status: "ok", detail: "Git 可用" },
    { id: "uv", label: "uv", status: "block", detail: "未检测到 uv", action: "安装 uv 或使用正式发行包" },
    { id: "port", label: "默认端口", status: "ok", detail: "8765 可用；固定端口未设置" },
    { id: "core_repo", label: "Core 源码", status: "warn", detail: "尚未初始化 Core 源码", action: "运行首次安装引导" },
  ],
  taskHistory: [
    {
      id: 3,
      name: "初始化运行时",
      status: "running",
      stage: "dependencies",
      message: "mock running: 正在同步 Python 依赖",
      startedAt: new Date(Date.now() - 3000).toISOString(),
    },
    {
      id: 2,
      name: "运行时修复",
      status: "failed",
      stage: "sync_deps",
      message: "mock failed: uv sync 网络超时",
      startedAt: new Date(Date.now() - 25_000).toISOString(),
      endedAt: new Date(Date.now() - 20_000).toISOString(),
      elapsedMs: 5000,
    },
    {
      id: 1,
      name: "开发预览任务",
      status: "success",
      stage: "mock",
      message: "用于验证任务中心布局",
      startedAt: new Date(Date.now() - 10_000).toISOString(),
      endedAt: new Date().toISOString(),
      elapsedMs: 10_000,
    },
  ],
};

export async function command<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri) {
    return mockCommand<T>(name, args);
  }
  return invoke<T>(name, args);
}

export const gsdeskApi = {
  getAppState: () => command<AppState>("get_app_state"),
  checkServiceHealth: () => command<AppState>("check_service_health"),
  saveSettings: (settings: Settings) => command<AppState>("save_settings", { settings }),
  probeSources: () => command<SourceProbeResult[]>("probe_sources"),
  checkPypiMirrors: () => command<MirrorCheckResult[]>("check_pypi_mirrors"),
  testNetworkTargets: () => command<NetworkDiagnosticResult[]>("test_network_targets"),
  initCoreRuntime: () => command<AppState>("init_core_runtime"),
  repairRuntime: (action: "sync_deps" | "rebuild_venv" | "reclone_core" | "clear_uv_cache") =>
    command<AppState>("repair_runtime", { request: { action } }),
  coreUpdate: (action: "check" | "update" | "rollback", channel: "stable" | "latest" | "dev" = "latest") =>
    command<CoreUpdateResult>("core_update", { request: { action, channel } }),
  createRuntimeBackup: () => command<RuntimeBackupResult>("create_runtime_backup"),
  restoreRuntimeBackup: () => command<RuntimeRestoreResult>("restore_runtime_backup", { request: { path: null } }),
  exportSettings: () => command<SettingsTransferResult>("export_settings"),
  importSettings: () => command<AppState>("import_settings", { request: { path: null } }),
  listCoreConfigFiles: () => command<CoreConfigFileSummary[]>("list_core_config_files"),
  readCoreConfigFile: (relativePath: string) => command<CoreConfigFileContent>("read_core_config_file", { request: { relativePath } }),
  saveCoreConfigFile: (relativePath: string, entries: Array<{ key: string; value: unknown }>) =>
    command<CoreConfigSaveResult>("save_core_config_file", { request: { relativePath, entries } }),
  openCoreConfigFile: (relativePath: string) => command<void>("open_core_config_file", { request: { relativePath } }),
  bootstrapUv: () => command<AppState>("bootstrap_uv"),
  cancelCurrentTask: () => command<AppState>("cancel_current_task"),
  startGsuidCore: () =>
    command<ServiceSnapshot>("start_service", {
      request: { serviceId: GSUID_CORE_SERVICE_ID },
    }),
  stopGsuidCore: () => command<AppState>("stop_service", { serviceId: GSUID_CORE_SERVICE_ID }),
  restartGsuidCore: () => command<ServiceSnapshot>("restart_service", { serviceId: GSUID_CORE_SERVICE_ID }),
  openGsuidWebconsole: () => command<{ url: string }>("open_webconsole", { serviceId: GSUID_CORE_SERVICE_ID }),
  exportDiagnostics: () => command<string>("export_diagnostics"),
  checkShellUpdate: () => command<UpdateInfo>("check_shell_update"),
  openPath: (key: string) => command<void>("open_path", { key }),
};

async function mockCommand<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  await new Promise((resolve) => window.setTimeout(resolve, 250));
  if (name === "get_app_state" || name === "check_service_health") return mockState as T;
  if (name === "save_settings" || name === "configure_proxy") {
    mockState.settings = args?.settings as Settings;
    return mockState as T;
  }
  if (name === "init_core_runtime") {
    const core = mockState.services[0];
    core.status = "stopped";
    core.recentError = undefined;
    return mockState as T;
  }
  if (name === "repair_runtime") {
    mockState.taskHistory = [
      {
        id: mockState.taskHistory.length + 1,
        name: "运行时修复",
        status: "success",
        stage: String((args?.request as { action?: string } | undefined)?.action || "sync_deps"),
        message: "开发预览模式修复完成",
        startedAt: new Date(Date.now() - 1200).toISOString(),
        endedAt: new Date().toISOString(),
        elapsedMs: 1200,
      },
      ...mockState.taskHistory,
    ];
    return mockState as T;
  }
  if (name === "bootstrap_uv") {
    mockState.uvDetected = true;
    mockState.toolchain = {
      uvDetected: true,
      uvSource: "runtime",
      uvPath: mockState.paths.uvExecutable,
      uvVersion: "uv 0.9.8",
      uvBootstrapSupported: true,
      uvBootstrapTarget: mockState.paths.uvExecutable,
      uvBootstrapUrl: "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip",
    };
    mockState.preflightChecks = mockState.preflightChecks.map((check) =>
      check.id === "uv" ? { ...check, status: "ok", detail: "uv 可用: uv 0.9.8 (runtime)", action: undefined } : check,
    );
    mockState.taskHistory = [
      {
        id: mockState.taskHistory.length + 1,
        name: "安装 uv",
        status: "success",
        stage: "done",
        message: "uv 已安装并验证可用",
        startedAt: new Date(Date.now() - 1500).toISOString(),
        endedAt: new Date().toISOString(),
        elapsedMs: 1500,
      },
      ...mockState.taskHistory,
    ];
    return mockState as T;
  }
  if (name === "cancel_current_task") {
    const running = mockState.taskHistory.find((task) => task.status === "running");
    if (running) {
      running.status = "cancelled";
      running.stage = "cancelled";
      running.message = "任务已取消";
      running.endedAt = new Date().toISOString();
      running.elapsedMs = 1200;
    } else {
      mockState.taskHistory = [
        {
          id: mockState.taskHistory.length + 1,
          name: "开发预览任务",
          status: "cancelled",
          stage: "cancelled",
          message: "任务已取消",
          startedAt: new Date(Date.now() - 1200).toISOString(),
          endedAt: new Date().toISOString(),
          elapsedMs: 1200,
        },
        ...mockState.taskHistory,
      ];
    }
    return mockState as T;
  }
  if (name === "core_update") {
    const request = args?.request as { action?: string; channel?: string } | undefined;
    const action = request?.action || "check";
    const channel = request?.channel || "latest";
    const result = {
      action,
      channel,
      currentCommit: "dev",
      targetCommit: action === "rollback" ? "prev1234" : "dev",
      rollbackCommit: "prev1234",
      changed: action !== "check",
      message:
        action === "check"
          ? "开发预览模式：Core 已是当前通道最新"
          : action === "rollback"
            ? "开发预览模式：Core 已回滚"
            : "开发预览模式：Core 已更新",
    } satisfies CoreUpdateResult;
    mockState.taskHistory = [
      {
        id: mockState.taskHistory.length + 1,
        name: "Core 更新",
        status: "success",
        stage: action,
        message: result.message,
        startedAt: new Date(Date.now() - 1000).toISOString(),
        endedAt: new Date().toISOString(),
        elapsedMs: 1000,
      },
      ...mockState.taskHistory,
    ];
    return result as T;
  }
  if (name === "create_runtime_backup") {
    const result = {
      path: "开发预览模式/runtime/backups/gsdesk-runtime.zip",
      included: ["settings.json", "core-data", "core-config", "core-plugins", "logs"],
    } satisfies RuntimeBackupResult;
    mockState.taskHistory = [
      {
        id: mockState.taskHistory.length + 1,
        name: "运行时备份",
        status: "success",
        stage: "done",
        message: "运行时备份已导出",
        startedAt: new Date(Date.now() - 1000).toISOString(),
        endedAt: new Date().toISOString(),
        elapsedMs: 1000,
      },
      ...mockState.taskHistory,
    ];
    return result as T;
  }
  if (name === "restore_runtime_backup") {
    const result = {
      path: "开发预览模式/runtime/backups/gsdesk-runtime.zip",
      safetyBackup: "开发预览模式/runtime/backups/gsdesk-runtime-safety.zip",
      restored: ["core-data", "core-config", "core-plugins", "logs"],
    } satisfies RuntimeRestoreResult;
    mockState.taskHistory = [
      {
        id: mockState.taskHistory.length + 1,
        name: "恢复运行时备份",
        status: "success",
        stage: "done",
        message: "开发预览模式：运行时备份已恢复",
        startedAt: new Date(Date.now() - 1000).toISOString(),
        endedAt: new Date().toISOString(),
        elapsedMs: 1000,
      },
      ...mockState.taskHistory,
    ];
    return result as T;
  }
  if (name === "export_settings") {
    return {
      path: "开发预览模式/runtime/backups/gsdesk-settings.json",
      fields: [
        "sourceMode",
        "selectedSource",
        "pypiIndexMode",
        "pypiIndexUrl",
        "preferredCorePort",
        "closeCoreOnExit",
        "autoCheckUpdate",
        "language",
        "proxy.noProxy",
      ],
      skipped: ["proxy.httpProxy", "proxy.httpsProxy", "proxy.allProxy"],
    } satisfies SettingsTransferResult as T;
  }
  if (name === "import_settings") {
    mockState.taskHistory = [
      {
        id: mockState.taskHistory.length + 1,
        name: "导入设置",
        status: "success",
        stage: "done",
        message: "开发预览模式：设置已导入",
        startedAt: new Date(Date.now() - 800).toISOString(),
        endedAt: new Date().toISOString(),
        elapsedMs: 800,
      },
      ...mockState.taskHistory,
    ];
    return mockState as T;
  }
  if (name === "list_core_config_files") {
    return [
      {
        relativePath: "data/config.json",
        label: "Core 主配置",
        path: "开发预览模式/runtime/core/gsuid_core/data/config.json",
        sizeBytes: 520,
        modifiedAt: new Date().toISOString(),
        entryCount: 12,
        secretCount: 2,
      },
      {
        relativePath: "data/configs/core_config.json",
        label: "Core 配置 / core_config.json",
        path: "开发预览模式/runtime/core/gsuid_core/data/configs/core_config.json",
        sizeBytes: 2048,
        modifiedAt: new Date().toISOString(),
        entryCount: 18,
        secretCount: 0,
      },
    ] satisfies CoreConfigFileSummary[] as T;
  }
  if (name === "read_core_config_file") {
    const request = args?.request as { relativePath?: string } | undefined;
    const relativePath = request?.relativePath || "data/config.json";
    return {
      relativePath,
      path: `开发预览模式/runtime/core/gsuid_core/${relativePath}`,
      schema: relativePath.includes("configs/") ? "gsuid" : "plain",
      entries:
        relativePath === "data/config.json"
          ? [
              {
                key: "HOST",
                title: "HOST",
                description: "",
                value: "127.0.0.1",
                valueType: "string",
                options: [],
                secret: false,
                editable: true,
              },
              {
                key: "ENABLE_HTTP",
                title: "ENABLE_HTTP",
                description: "",
                value: false,
                valueType: "bool",
                options: [],
                secret: false,
                editable: true,
              },
              {
                key: "REGISTER_CODE",
                title: "REGISTER_CODE",
                description: "",
                value: "******",
                valueType: "string",
                options: [],
                secret: true,
                editable: false,
              },
            ]
          : [
              {
                key: "AutoUpdateCore",
                title: "自动更新Core",
                description: "每晚凌晨三点四十自动更新core本体",
                value: true,
                valueType: "bool",
                options: [],
                secret: false,
                editable: true,
              },
              {
                key: "StartVENV",
                title: "设置启动环境工具",
                description: "可选pdm, poetry, python, auto, uv",
                value: "auto",
                valueType: "string",
                options: ["pdm", "poetry", "python", "uv", "auto"],
                secret: false,
                editable: true,
              },
            ],
    } satisfies CoreConfigFileContent as T;
  }
  if (name === "save_core_config_file") {
    const request = args?.request as { relativePath?: string; entries?: Array<{ key: string }> } | undefined;
    return {
      relativePath: request?.relativePath || "data/config.json",
      path: `开发预览模式/runtime/core/gsuid_core/${request?.relativePath || "data/config.json"}`,
      backupPath: "开发预览模式/runtime/backups/core-config-dev.bak.json",
      saved: request?.entries?.map((entry) => entry.key) || [],
      skipped: [],
    } satisfies CoreConfigSaveResult as T;
  }
  if (name === "open_core_config_file") return undefined as T;
  if (name === "start_service" || name === "restart_service") {
    const core = mockState.services[0];
    core.status = "running";
    core.port = 8765;
    core.pid = 12345;
    core.url = "http://127.0.0.1:8765";
    core.currentCommit = "dev";
    core.healthOk = true;
    core.webconsoleAvailable = true;
    core.recentError = undefined;
    return core as T;
  }
  if (name === "stop_service") {
    const core = mockState.services[0];
    core.status = "stopped";
    core.pid = undefined;
    core.healthOk = false;
    core.webconsoleAvailable = false;
    return mockState as T;
  }
  if (name === "probe_sources") {
    return [
      {
        id: "github",
        name: "GitHub",
        url: "https://github.com/Genshin-bots/gsuid_core.git",
        ok: true,
        latencyMs: 320,
      },
      {
        id: "cnb",
        name: "CNB 国内镜像",
        url: "https://cnb.cool/gscore-mirror/gsuid_core.git",
        ok: true,
        latencyMs: 118,
      },
    ] satisfies SourceProbeResult[] as T;
  }
  if (name === "check_pypi_mirrors") {
    return [
      { name: "阿里", url: "https://mirrors.aliyun.com/pypi/simple/", ok: true, latencyMs: 80, speedMbps: 7.1 },
      { name: "官方", url: "https://pypi.org/simple/", ok: true, latencyMs: 280, speedMbps: 2.4 },
    ] satisfies MirrorCheckResult[] as T;
  }
  if (name === "test_network_targets") {
    return [
      { id: "github", label: "GitHub", target: "https://github.com/Genshin-bots/gsuid_core.git", ok: true, latencyMs: 320 },
      { id: "cnb", label: "CNB 国内镜像", target: "https://cnb.cool/gscore-mirror/gsuid_core.git", ok: true, latencyMs: 118 },
      { id: "pypi", label: "当前 PyPI 镜像", target: mockState.settings.pypiIndexUrl, ok: true, latencyMs: 96 },
      { id: "webconsole", label: "本机 WebConsole", target: "Core 未启动", ok: false, error: "Core 尚未启动，无法测试 /app" },
    ] satisfies NetworkDiagnosticResult[] as T;
  }
  if (name === "stream_logs") return mockState.recentLogs as T;
  if (name === "open_webconsole") return { url: "http://127.0.0.1:8765/app" } as T;
  if (name === "check_shell_update") {
    return { currentVersion: "0.1.0", hasUpdate: false, channel: "current" } satisfies UpdateInfo as T;
  }
  if (name === "export_diagnostics") return "开发预览模式/diagnostics/gsdesk-diagnostics.zip" as T;
  if (name === "open_path") return undefined as T;
  return mockState as T;
}

export function subscribeLogs(handler: (entry: LogEntry) => void): Promise<() => void> {
  if (!isTauri) {
    return Promise.resolve(() => undefined);
  }
  return listen<LogEntry>("gsdesk-log", (event) => handler(event.payload));
}

function createMockLogs(count: number): LogEntry[] {
  const streams: LogEntry["stream"][] = ["core", "system", "stdout", "stderr"];
  const levels: LogEntry["level"][] = ["info", "success", "warn", "error"];
  const coreReadyMessage = "\u{1f496} [早柚核心] 插件加载完成! 总耗时: 3.00秒";
  const samples: Array<Pick<LogEntry, "stream" | "level" | "line" | "message" | "module" | "raw">> = [
    {
      stream: "system",
      level: "info",
      line: "开发预览模式：Tauri 命令将在桌面壳内生效。",
      message: "开发预览模式：Tauri 命令将在桌面壳内生效。",
    },
    {
      stream: "core",
      level: "info",
      line: "06-19 10:37:47 [info     ] Waiting for application startup.",
      message: "Waiting for application startup.",
      raw: '{"event":"Waiting for application startup.","level":"info","timestamp":"06-19 10:37:47"}',
    },
    {
      stream: "core",
      level: "success",
      line: `06-19 10:37:47 [success  ] ${coreReadyMessage}`,
      message: coreReadyMessage,
      module: "早柚核心",
      raw: JSON.stringify({ event: coreReadyMessage, level: "success", timestamp: "06-19 10:37:47" }),
    },
    {
      stream: "stderr",
      level: "error",
      line: "Traceback (most recent call last):",
      message: "Traceback (most recent call last):",
    },
    {
      stream: "stderr",
      level: "error",
      line: 'File "C:\\Users\\echo\\AppData\\Roaming\\com.yeahhhh321.gsdesk\\runtime\\core\\gsuid_core\\gsuid_core\\core.py", line 79, in main',
      message: 'File "C:\\Users\\echo\\AppData\\Roaming\\com.yeahhhh321.gsdesk\\runtime\\core\\gsuid_core\\gsuid_core\\core.py", line 79, in main',
    },
    {
      stream: "stderr",
      level: "error",
      line: "ModuleNotFoundError: No module named 'gsuid_core'",
      message: "ModuleNotFoundError: No module named 'gsuid_core'",
    },
  ];
  const baseTime = Date.now() - count * 1200;
  return Array.from({ length: count }, (_, index) => {
    const sample = samples[index];
    const level = index < samples.length ? levels[index % levels.length] : levels[index % 3];
    const stream = streams[index % streams.length];
    const line =
      sample?.line ??
      `[mock:${String(index + 1).padStart(4, "0")}] ${level.toUpperCase()} ${stream} uv run core --host 127.0.0.1 --port 8765 :: 模拟长日志内容用于验证虚拟滚动、搜索、复制和自动跟随。`;
    return {
      id: index + 1,
      serviceId: "gsuid_core",
      stream: sample?.stream ?? stream,
      level: sample?.level ?? level,
      timestamp: new Date(baseTime + index * 1200).toISOString(),
      line,
      message: sample?.message ?? line,
      module: sample?.module ?? (stream === "core" && index % 9 === 0 ? "早柚核心" : undefined),
      raw: sample?.raw,
    };
  });
}
