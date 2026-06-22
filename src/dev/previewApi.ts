import type {
  AppState,
  CoreUpdateResult,
  LogEntry,
  MirrorCheckResult,
  RuntimeBackupResult,
  RuntimeRestoreResult,
  Settings,
  SettingsTransferResult,
  SourceProbeResult,
  UpdateInfo,
  UpdateInstallResult,
} from "../types";
import { GSUID_CORE_SERVICE_ID, NONEBOT2_SERVICE_ID } from "../serviceIds";

const PREVIEW_ROOT = "预览数据目录";

const previewState: AppState = {
  version: "0.1.0",
  uvDetected: false,
  settings: {
    beginnerMode: true,
    sourceMode: "auto",
    selectedSource: "https://github.com/Genshin-bots/gsuid_core.git",
    customCoreDir: "",
    pypiIndexMode: "auto",
    pypiIndexUrl: "https://pypi.org/simple/",
    playwrightDownloadHost: "",
    preferredCorePort: 8765,
    closeCoreOnExit: false,
    hideToTrayOnClose: true,
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
    appData: PREVIEW_ROOT,
    runtime: `${PREVIEW_ROOT}/runtime`,
    toolsDir: `${PREVIEW_ROOT}/runtime/tools`,
    coreDir: `${PREVIEW_ROOT}/runtime/core/gsuid_core`,
    venvDir: `${PREVIEW_ROOT}/runtime/venvs/gsuid_core`,
    uvCacheDir: `${PREVIEW_ROOT}/runtime/uv/cache`,
    uvPythonDir: `${PREVIEW_ROOT}/runtime/uv/python`,
    uvExecutable: `${PREVIEW_ROOT}/runtime/tools/uv/Scripts/uv.exe`,
    playwrightBrowsersDir: `${PREVIEW_ROOT}/runtime/playwright/browsers`,
    logsDir: `${PREVIEW_ROOT}/logs`,
    diagnosticsDir: `${PREVIEW_ROOT}/diagnostics`,
    backupsDir: `${PREVIEW_ROOT}/runtime/backups`,
    settingsFile: `${PREVIEW_ROOT}/settings.json`,
  },
  shell: {
    pid: 32924,
    memoryBytes: 91 * 1024 * 1024,
  },
  toolchain: {
    uvDetected: false,
    uvSource: "missing",
    uvBootstrapSupported: true,
    uvBootstrapTarget: `${PREVIEW_ROOT}/runtime/tools/uv/Scripts/uv.exe`,
    bundledPythonAvailable: true,
    bundledPythonPath: `${PREVIEW_ROOT}/resources/runtime-assets/python`,
    uvError: "未检测到 uv",
    playwrightDetected: false,
    playwrightBrowsersPath: `${PREVIEW_ROOT}/runtime/playwright/browsers`,
    playwrightError: "未安装 Playwright 浏览器",
    gitDetected: true,
    gitSource: "bundle",
    gitPath: `${PREVIEW_ROOT}/resources/runtime-assets/git/cmd/git.exe`,
    gitVersion: "git version 2.51.2.windows.1",
    bundledGitAvailable: true,
    bundledGitPath: `${PREVIEW_ROOT}/resources/runtime-assets/git/cmd/git.exe`,
  },
  services: [
    {
      serviceId: GSUID_CORE_SERVICE_ID,
      name: "Gsuid Core",
      status: "uninitialized",
      currentCommit: "dev",
      memoryBytes: undefined,
      healthOk: false,
      webconsoleAvailable: false,
    },
    {
      serviceId: NONEBOT2_SERVICE_ID,
      name: "NoneBot2",
      status: "uninitialized",
      recentError: "暂未配置，后续接入",
      memoryBytes: undefined,
      healthOk: false,
      webconsoleAvailable: false,
    },
  ],
  recentLogs: createPreviewLogs(1200),
  preflightChecks: [
    { id: "os", label: "系统", status: "ok", detail: "windows / x86_64" },
    { id: "git", label: "源码工具", status: "ok", detail: "Git 可用: git version 2.51.2.windows.1 (内置)" },
    { id: "uv", label: "uv", status: "block", detail: "未检测到 uv", action: "安装 uv 或使用正式发行包" },
    { id: "port", label: "固定端口", status: "ok", detail: "8765 可用" },
    { id: "core_repo", label: "Core 源码", status: "warn", detail: "尚未初始化 Core 源码", action: "运行首次安装引导" },
  ],
  taskHistory: [
    {
      id: 3,
      name: "初始化运行时",
      status: "running",
      stage: "dependencies",
      message: "正在同步 Python 依赖",
      startedAt: new Date(Date.now() - 3000).toISOString(),
    },
    {
      id: 2,
      name: "运行时修复",
      status: "failed",
      stage: "sync_deps",
      message: "uv sync 网络超时",
      startedAt: new Date(Date.now() - 25_000).toISOString(),
      endedAt: new Date(Date.now() - 20_000).toISOString(),
      elapsedMs: 5000,
    },
    {
      id: 1,
      name: "初始化预检",
      status: "success",
      stage: "preflight",
      message: "预检已完成",
      startedAt: new Date(Date.now() - 10_000).toISOString(),
      endedAt: new Date().toISOString(),
      elapsedMs: 10_000,
    },
  ],
};

export async function previewCommand<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  await new Promise((resolve) => window.setTimeout(resolve, 250));
  if (name === "get_app_state" || name === "check_service_health") return previewStateSnapshot() as T;
  if (name === "save_settings" || name === "configure_proxy") {
    previewState.settings = args?.settings as Settings;
    applyPreviewPaths();
    return previewStateSnapshot() as T;
  }
  if (name === "init_core_runtime") {
    const core = previewState.services[0];
    core.status = "stopped";
    core.recentError = undefined;
    return previewStateSnapshot() as T;
  }
  if (name === "repair_runtime") {
    previewState.taskHistory = [
      {
        id: previewState.taskHistory.length + 1,
        name: "运行时修复",
        status: "success",
        stage: String((args?.request as { action?: string } | undefined)?.action ?? "sync_deps"),
        message: "预览数据修复完成",
        startedAt: new Date(Date.now() - 1200).toISOString(),
        endedAt: new Date().toISOString(),
        elapsedMs: 1200,
      },
      ...previewState.taskHistory,
    ];
    return previewStateSnapshot() as T;
  }
  if (name === "bootstrap_uv") {
    previewState.uvDetected = true;
    previewState.toolchain = {
      uvDetected: true,
      uvSource: "runtime",
      uvPath: previewState.paths.uvExecutable,
      uvVersion: "uv 0.9.8",
      uvBootstrapSupported: true,
      uvBootstrapTarget: previewState.paths.uvExecutable,
      bundledPythonAvailable: true,
      bundledPythonPath: `${PREVIEW_ROOT}/resources/runtime-assets/python`,
      playwrightDetected: previewState.toolchain.playwrightDetected,
      playwrightBrowsersPath: previewState.paths.playwrightBrowsersDir,
      playwrightError: previewState.toolchain.playwrightError,
      gitDetected: true,
      gitSource: "bundle",
      gitPath: `${PREVIEW_ROOT}/resources/runtime-assets/git/cmd/git.exe`,
      gitVersion: "git version 2.51.2.windows.1",
      bundledGitAvailable: true,
      bundledGitPath: `${PREVIEW_ROOT}/resources/runtime-assets/git/cmd/git.exe`,
    };
    previewState.preflightChecks = previewState.preflightChecks.map((check) =>
      check.id === "uv" ? { ...check, status: "ok", detail: "uv 可用: uv 0.9.8 (runtime)", action: undefined } : check,
    );
    previewState.taskHistory = [
      {
        id: previewState.taskHistory.length + 1,
        name: "安装 uv",
        status: "success",
        stage: "done",
        message: "uv 已安装并验证可用",
        startedAt: new Date(Date.now() - 1500).toISOString(),
        endedAt: new Date().toISOString(),
        elapsedMs: 1500,
      },
      ...previewState.taskHistory,
    ];
    return previewStateSnapshot() as T;
  }
  if (name === "install_playwright") {
    previewState.toolchain = {
      ...previewState.toolchain,
      playwrightDetected: true,
      playwrightBrowsersPath: previewState.paths.playwrightBrowsersDir,
      playwrightError: undefined,
    };
    previewState.taskHistory = [
      {
        id: previewState.taskHistory.length + 1,
        name: "安装 Playwright",
        status: "success",
        stage: "done",
        message: "Playwright Chromium 已安装到隔离目录",
        startedAt: new Date(Date.now() - 2200).toISOString(),
        endedAt: new Date().toISOString(),
        elapsedMs: 2200,
      },
      ...previewState.taskHistory,
    ];
    return previewStateSnapshot() as T;
  }
  if (name === "cancel_current_task") {
    const running = previewState.taskHistory.find((task) => task.status === "running");
    if (running) {
      running.status = "cancelled";
      running.stage = "cancelled";
      running.message = "任务已取消";
      running.endedAt = new Date().toISOString();
      running.elapsedMs = 1200;
    } else {
      previewState.taskHistory = [
        {
          id: previewState.taskHistory.length + 1,
          name: "任务取消记录",
          status: "cancelled",
          stage: "cancelled",
          message: "任务已取消",
          startedAt: new Date(Date.now() - 1200).toISOString(),
          endedAt: new Date().toISOString(),
          elapsedMs: 1200,
        },
        ...previewState.taskHistory,
      ];
    }
    return previewStateSnapshot() as T;
  }
  if (name === "core_update") {
    const request = args?.request as { action?: string; channel?: string; targetCommit?: string } | undefined;
    const action = request?.action ?? "check";
    const channel = request?.channel ?? "latest";
    const previewCommits = [
      {
        commit: "deadc0de00000000000000000000000000000000",
        shortCommit: "deadc0d",
        subject: "修复 WebConsole 连接探测",
        author: "GenshinUID",
        committedAt: "2026-06-20T08:00:00+08:00",
        isCurrent: true,
        isRollback: false,
      },
      {
        commit: "prev1234000000000000000000000000000000000",
        shortCommit: "prev123",
        subject: "调整依赖同步流程",
        author: "GenshinUID",
        committedAt: "2026-06-19T20:00:00+08:00",
        isCurrent: false,
        isRollback: true,
      },
      {
        commit: "old56780000000000000000000000000000000000",
        shortCommit: "old5678",
        subject: "更新插件初始化",
        author: "GenshinUID",
        committedAt: "2026-06-18T18:30:00+08:00",
        isCurrent: false,
        isRollback: false,
      },
    ];
    const result = {
      action,
      channel,
      currentCommit: "dev",
      targetCommit: action === "rollback" ? (request?.targetCommit ?? "prev1234") : "dev",
      rollbackCommit: "prev1234",
      commits: action === "list_commits" ? previewCommits : [],
      changed: action !== "check" && action !== "list_commits",
      message:
        action === "list_commits"
          ? "预览数据：已加载 3 个 Core 提交，可选择目标版本"
          : action === "check"
            ? "预览数据：Core 已是当前通道最新"
            : action === "clean"
              ? "预览数据：Core 已清理更新差异: uv.lock"
              : action === "rollback"
                ? "预览数据：Core 已回滚"
                : "预览数据：Core 已更新",
    } satisfies CoreUpdateResult;
    previewState.taskHistory = [
      {
        id: previewState.taskHistory.length + 1,
        name: "Core 更新",
        status: "success",
        stage: action,
        message: result.message,
        startedAt: new Date(Date.now() - 1000).toISOString(),
        endedAt: new Date().toISOString(),
        elapsedMs: 1000,
      },
      ...previewState.taskHistory,
    ];
    return result as T;
  }
  if (name === "create_runtime_backup") {
    const result = {
      path: `${PREVIEW_ROOT}/runtime/backups/gsdesk-runtime.zip`,
      included: ["settings.json", "core-data", "core-config", "core-plugins", "logs"],
    } satisfies RuntimeBackupResult;
    previewState.taskHistory = [
      {
        id: previewState.taskHistory.length + 1,
        name: "运行时备份",
        status: "success",
        stage: "done",
        message: "运行时备份已导出",
        startedAt: new Date(Date.now() - 1000).toISOString(),
        endedAt: new Date().toISOString(),
        elapsedMs: 1000,
      },
      ...previewState.taskHistory,
    ];
    return result as T;
  }
  if (name === "restore_runtime_backup") {
    const result = {
      path: `${PREVIEW_ROOT}/runtime/backups/gsdesk-runtime.zip`,
      safetyBackup: `${PREVIEW_ROOT}/runtime/backups/gsdesk-runtime-safety.zip`,
      restored: ["core-data", "core-config", "core-plugins", "logs"],
    } satisfies RuntimeRestoreResult;
    previewState.taskHistory = [
      {
        id: previewState.taskHistory.length + 1,
        name: "恢复运行时备份",
        status: "success",
        stage: "done",
        message: "预览数据：运行时备份已恢复",
        startedAt: new Date(Date.now() - 1000).toISOString(),
        endedAt: new Date().toISOString(),
        elapsedMs: 1000,
      },
      ...previewState.taskHistory,
    ];
    return result as T;
  }
  if (name === "export_settings") {
    return {
      path: `${PREVIEW_ROOT}/runtime/backups/gsdesk-settings.json`,
      fields: [
        "sourceMode",
        "beginnerMode",
        "selectedSource",
        "pypiIndexMode",
        "pypiIndexUrl",
        "preferredCorePort",
        "closeCoreOnExit",
        "hideToTrayOnClose",
        "autoCheckUpdate",
        "language",
        "proxy.noProxy",
      ],
      skipped: ["proxy.httpProxy", "proxy.httpsProxy", "proxy.allProxy"],
    } satisfies SettingsTransferResult as T;
  }
  if (name === "import_settings") {
    previewState.taskHistory = [
      {
        id: previewState.taskHistory.length + 1,
        name: "导入设置",
        status: "success",
        stage: "done",
        message: "预览数据：设置已导入",
        startedAt: new Date(Date.now() - 800).toISOString(),
        endedAt: new Date().toISOString(),
        elapsedMs: 800,
      },
      ...previewState.taskHistory,
    ];
    return previewStateSnapshot() as T;
  }
  if (name === "clear_occupied_port") {
    previewState.preflightChecks = previewState.preflightChecks.map((check) =>
      check.id === "port" ? { ...check, status: "ok", detail: "8765 可用", action: undefined } : check,
    );
    return {
      port: 8765,
      occupants: [{ pid: 45678, name: "python", path: "C:\\Python\\python.exe" }],
      killedPids: [45678],
      released: true,
      message: "端口 8765 已释放，强杀进程: [45678]",
    } as T;
  }
  if (name === "clear_app_data") {
    previewState.uvDetected = false;
    previewState.settings = {
      ...previewState.settings,
      beginnerMode: true,
      installGuideCompleted: false,
      preferredCorePort: 8765,
      customCoreDir: "",
    };
    applyPreviewPaths();
    previewState.services = previewState.services.map((service) =>
      service.serviceId === GSUID_CORE_SERVICE_ID
        ? {
            serviceId: GSUID_CORE_SERVICE_ID,
            name: "Gsuid Core",
            status: "uninitialized",
            memoryBytes: undefined,
            healthOk: false,
            webconsoleAvailable: false,
          }
        : service,
    );
    previewState.taskHistory = [];
    previewState.recentLogs = [];
    return {
      appData: PREVIEW_ROOT,
      deleted: [
        `${PREVIEW_ROOT}/runtime`,
        `${PREVIEW_ROOT}/logs`,
        `${PREVIEW_ROOT}/diagnostics`,
        `${PREVIEW_ROOT}/settings.json`,
      ],
      message: "预览数据：本机数据已清理",
    } as T;
  }
  if (name === "start_service") {
    const core = previewState.services[0];
    core.status = "running";
    core.port = 8765;
    core.pid = 12345;
    core.memoryBytes = 128 * 1024 * 1024;
    core.url = "http://127.0.0.1:8765";
    core.currentCommit = "dev";
    core.healthOk = true;
    core.webconsoleAvailable = true;
    core.recentError = undefined;
    return core as T;
  }
  if (name === "stop_service") {
    const core = previewState.services[0];
    core.status = "stopped";
    core.pid = undefined;
    core.memoryBytes = undefined;
    core.healthOk = false;
    core.webconsoleAvailable = false;
    return previewStateSnapshot() as T;
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
  if (name === "stream_logs") return previewState.recentLogs as T;
  if (name === "open_webconsole") {
    const core = previewState.services[0];
    core.status = "running";
    core.port = 8765;
    core.pid = 32100;
    core.memoryBytes = 132 * 1024 * 1024;
    core.url = "http://127.0.0.1:8765";
    core.healthOk = true;
    core.webconsoleAvailable = true;
    return { url: "http://127.0.0.1:8765/app" } as T;
  }
  if (name === "open_external_url") return undefined as T;
  if (name === "check_shell_update") {
    return {
      currentVersion: "0.1.0",
      latestVersion: "0.2.0",
      hasUpdate: true,
      channel: "latest",
      releaseUrl: "https://github.com/yeahhhh321/gsdesk/releases/download/v0.2.0/latest.json",
      notes: "预览数据：可安装 GSDesk 壳更新。",
    } satisfies UpdateInfo as T;
  }
  if (name === "install_shell_update") {
    return {
      version: "0.2.0",
      message: "预览数据：壳更新 0.2.0 已安装，正在重启 GSDesk",
    } satisfies UpdateInstallResult as T;
  }
  if (name === "open_path") return undefined as T;
  return previewStateSnapshot() as T;
}

function applyPreviewPaths() {
  const custom = previewState.settings.customCoreDir.trim();
  previewState.paths.coreDir = custom.length ? custom : `${PREVIEW_ROOT}/runtime/core/gsuid_core`;
}

function previewStateSnapshot() {
  return JSON.parse(JSON.stringify(previewState)) as AppState;
}

function createPreviewLogs(count: number): LogEntry[] {
  const levels: LogEntry["level"][] = ["debug", "info", "warn", "error"];
  const coreReadyMessage = "\u{1f496} [早柚核心] 插件加载完成! 总耗时: 3.00秒";
  const samples: Array<Pick<LogEntry, "level" | "line" | "message" | "module" | "raw">> = [
    {
      level: "info",
      line: "06-19 10:37:47 [info     ] Waiting for application startup.",
      message: "Waiting for application startup.",
      raw: '{"event":"Waiting for application startup.","level":"info","timestamp":"06-19 10:37:47"}',
    },
    {
      level: "info",
      line: `06-19 10:37:47 [info     ] ${coreReadyMessage}`,
      message: coreReadyMessage,
      module: "早柚核心",
      raw: JSON.stringify({ event: coreReadyMessage, level: "info", timestamp: "06-19 10:37:47" }),
    },
    {
      level: "error",
      line: "Traceback (most recent call last):",
      message: "Traceback (most recent call last):",
      module: "启动失败",
      raw: JSON.stringify({ event: "Traceback (most recent call last):", level: "error", timestamp: "06-19 10:37:45" }),
    },
    {
      level: "error",
      line: 'File "C:\\Users\\echo\\AppData\\Roaming\\com.core.gsdesk\\runtime\\core\\gsuid_core\\gsuid_core\\core.py", line 79, in main',
      message:
        'File "C:\\Users\\echo\\AppData\\Roaming\\com.core.gsdesk\\runtime\\core\\gsuid_core\\gsuid_core\\core.py", line 79, in main',
      module: "启动失败",
      raw: JSON.stringify({
        event:
          'File "C:\\Users\\echo\\AppData\\Roaming\\com.core.gsdesk\\runtime\\core\\gsuid_core\\gsuid_core\\core.py", line 79, in main',
        level: "error",
        timestamp: "06-19 10:37:45",
      }),
    },
    {
      level: "error",
      line: "ModuleNotFoundError: No module named 'gsuid_core'",
      message: "ModuleNotFoundError: No module named 'gsuid_core'",
      module: "启动失败",
      raw: JSON.stringify({
        event: "ModuleNotFoundError: No module named 'gsuid_core'",
        level: "error",
        timestamp: "06-19 10:37:45",
      }),
    },
  ];
  const baseTime = Date.now() - count * 1200;
  return Array.from({ length: count }, (_, index) => {
    const sample = samples[index];
    const level = index < samples.length ? levels[index % levels.length] : levels[index % 3];
    const line =
      sample?.line ??
      `[jsonl:${String(index + 1).padStart(4, "0")}] ${level.toUpperCase()} core JSONL :: 插件状态同步完成，等待下一次健康检查。`;
    return {
      id: index + 1,
      serviceId: GSUID_CORE_SERVICE_ID,
      stream: "core",
      level: sample?.level ?? level,
      timestamp: new Date(baseTime + index * 1200).toISOString(),
      line,
      message: sample?.message ?? line,
      module: sample?.module ?? (index % 9 === 0 ? "早柚核心" : undefined),
      raw:
        sample?.raw ??
        JSON.stringify({
          event: line,
          level,
          timestamp: new Date(baseTime + index * 1200).toISOString(),
          module: index % 9 === 0 ? "早柚核心" : undefined,
        }),
    };
  });
}
