import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = process.cwd();
const args = parseArgs(process.argv.slice(2));
const port = Number(args.port || 8875);
const timeoutMs = Number(args.timeout || 90) * 1000;
const sourceUrl = args.source || "https://github.com/Genshin-bots/gsuid_core.git";
const coreDir = resolve(args.coreDir || defaultCoreDir());
const runtimeDir = resolve(coreDir, "..", "..");
const venvDir = resolve(args.venvDir || join(runtimeDir, "venvs", "gsuid_core"));
const uvCacheDir = resolve(args.uvCacheDir || join(runtimeDir, "uv", "cache"));
const uvPythonDir = resolve(args.uvPythonDir || join(runtimeDir, "uv", "python"));
const gitProgram = resolveGitProgram(args.git);

if (!existsSync(coreDir)) {
  if (!args.fresh) {
    throw new Error(`Core runtime does not exist: ${coreDir}. Pass --fresh to clone ${sourceUrl}.`);
  }
  mkdirSync(dirname(coreDir), { recursive: true });
  await run(gitProgram, ["clone", "--depth", "1", sourceUrl, coreDir], { cwd: dirname(coreDir), timeoutMs: 300_000 });
}

if (!existsSync(join(coreDir, "pyproject.toml"))) {
  throw new Error(`pyproject.toml not found in ${coreDir}`);
}

mkdirSync(uvCacheDir, { recursive: true });
mkdirSync(uvPythonDir, { recursive: true });
mkdirSync(venvDir, { recursive: true });

const env = {
  ...process.env,
  UV_PROJECT_ENVIRONMENT: venvDir,
  UV_CACHE_DIR: uvCacheDir,
  UV_PYTHON_INSTALL_DIR: uvPythonDir,
  PYTHONUTF8: "1",
  PYTHONIOENCODING: "utf-8:replace",
  PYTHONUNBUFFERED: "1",
  UV_NO_PROGRESS: "1",
  NO_COLOR: "1",
  FORCE_COLOR: "0",
  CLICOLOR: "0",
  TERM: "dumb",
};
delete env.PYTHONLEGACYWINDOWSSTDIO;

console.log(`[smoke] coreDir=${coreDir}`);
console.log(`[smoke] port=${port}`);
console.log(`[smoke] git=${gitProgram}`);
await run("uv", ["--version"], { cwd: coreDir, timeoutMs: 20_000, env });

const child = spawn("uv", ["run", "--python", "3.12", "core", "--host", "127.0.0.1", "--port", String(port)], {
  cwd: coreDir,
  env,
  detached: process.platform !== "win32",
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let stdout = "";
let stderr = "";
const stdoutSink = createPrefixedSink(process.stdout, "[core:stdout] ");
const stderrSink = createPrefixedSink(process.stderr, "[core:stderr] ");
child.stdout.on("data", (chunk) => {
  const text = chunk.toString("utf8");
  stdout += text;
  stdoutSink.write(text);
});
child.stderr.on("data", (chunk) => {
  const text = chunk.toString("utf8");
  stderr += text;
  stderrSink.write(text);
});

try {
  const appUrl = `http://127.0.0.1:${port}/app`;
  await waitForUrl(appUrl, timeoutMs);
  const jsonl = readLatestJsonl(coreDir);
  if (!jsonl) {
    throw new Error("Core started but no JSONL log file was found under data/logs");
  }
  console.log(`[smoke] webconsole=${appUrl}`);
  console.log(`[smoke] jsonl=${jsonl.path}`);
  console.log(`[smoke] jsonlLines=${jsonl.lines}`);
  console.log("[smoke] ok");
} finally {
  await stopTree(child.pid);
  stdoutSink.flush();
  stderrSink.flush();
}

async function waitForUrl(url, timeout) {
  const started = Date.now();
  let lastError = "";
  while (Date.now() - started < timeout) {
    if (child.exitCode !== null) {
      throw new Error(`Core process exited early with code ${child.exitCode}\n${stdout}\n${stderr}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(1000);
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError}`);
}

function readLatestJsonl(dir) {
  const logsDir = join(dir, "data", "logs");
  if (!existsSync(logsDir)) return undefined;
  const files = readdirSync(logsDir, { withFileTypes: true })
    .filter((item) => item.isFile() && (item.name.endsWith(".log") || item.name.endsWith(".jsonl")))
    .map((item) => join(logsDir, item.name))
    .sort();
  const latest = files.at(-1);
  if (!latest) return undefined;
  const content = readFileSync(latest, "utf8");
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const hasJson = lines.some((line) => {
    try {
      const parsed = JSON.parse(line);
      return Boolean(parsed.event && parsed.level);
    } catch {
      return false;
    }
  });
  if (!hasJson) {
    throw new Error(`Latest Core log is not JSONL: ${latest}`);
  }
  return { path: latest, lines: lines.length };
}

async function run(command, commandArgs, options = {}) {
  const childProcess = spawn(command, commandArgs, {
    cwd: options.cwd,
    env: options.env || process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  childProcess.stdout.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  childProcess.stderr.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  const timer = setTimeout(() => {
    childProcess.kill();
  }, options.timeoutMs || 60_000);
  const code = await new Promise((resolve) => childProcess.on("exit", resolve));
  clearTimeout(timer);
  safeWrite(process.stdout, output);
  if (code !== 0) {
    throw new Error(`${command} ${commandArgs.join(" ")} failed with code ${code}`);
  }
}

function safeWrite(stream, text) {
  stream.write(sanitizeTerminalText(text));
}

function createPrefixedSink(stream, prefix) {
  let pending = "";
  return {
    write(text) {
      pending += text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        safeWrite(stream, line ? `${prefix}${line}\n` : "\n");
      }
    },
    flush() {
      if (!pending) return;
      safeWrite(stream, `${prefix}${pending}\n`);
      pending = "";
    },
  };
}

function sanitizeTerminalText(text) {
  return Array.from(text)
    .map((value) => (isTerminalSensitiveChar(value) ? escapeCodePoint(value) : value))
    .join("");
}

function isTerminalSensitiveChar(value) {
  const codePoint = value.codePointAt(0);
  if (codePoint === undefined) return false;
  return (
    codePoint === 0xfe0e ||
    codePoint === 0xfe0f ||
    (codePoint >= 0x2190 && codePoint <= 0x2bff) ||
    (codePoint >= 0x1f000 && codePoint <= 0x1faff)
  );
}

function escapeCodePoint(value) {
  const codePoint = value.codePointAt(0);
  if (codePoint === undefined) return "\\u{FFFD}";
  return `\\u{${codePoint.toString(16).toUpperCase().padStart(4, "0")}}`;
}

async function stopTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    await runDetached("taskkill", ["/PID", String(pid), "/T"]);
    if (await waitForExit(pid, 8000)) return;
    await runDetached("taskkill", ["/PID", String(pid), "/T", "/F"]);
  } else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already exited.
      }
    }
    if (await waitForExit(pid, 8000)) return;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already exited.
      }
    }
  }
}

async function waitForExit(pid, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!(await processAlive(pid))) return true;
    await delay(200);
  }
  return !(await processAlive(pid));
}

async function processAlive(pid) {
  if (process.platform === "win32") {
    const code = await spawnExitCode("powershell", [
      "-NoProfile",
      "-Command",
      `if (Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }`,
    ]);
    return code === 0;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function runDetached(command, commandArgs) {
  await spawnExitCode(command, commandArgs, { stdio: "ignore", windowsHide: true });
}

async function spawnExitCode(command, commandArgs, options = {}) {
  return await new Promise((resolve) => {
    spawn(command, commandArgs, {
      stdio: options.stdio || "ignore",
      windowsHide: options.windowsHide ?? true,
    }).on("exit", (code) => resolve(code ?? 0));
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultCoreDir() {
  if (process.env.GSUID_CORE_DIR) return process.env.GSUID_CORE_DIR;
  if (process.platform === "win32") {
    return join(
      process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
      "com.yeahhhh321.gsdesk",
      "runtime",
      "core",
      "gsuid_core",
    );
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "com.yeahhhh321.gsdesk", "runtime", "core", "gsuid_core");
  }
  return join(tmpdir(), "gsdesk-runtime", "core", "gsuid_core");
}

function resolveGitProgram(configured) {
  if (configured) return resolve(configured);
  const runtimeGit = join(root, "src-tauri", "runtime-assets", "git");
  for (const candidate of gitBinaryCandidates(runtimeGit)) {
    if (existsSync(candidate)) return candidate;
  }
  return "git";
}

function gitBinaryCandidates(dir) {
  if (process.platform === "win32") {
    return [
      join(dir, "cmd", "git.exe"),
      join(dir, "bin", "git.exe"),
      join(dir, "mingw64", "bin", "git.exe"),
      join(dir, "git.exe"),
    ];
  }
  return [join(dir, "bin", "git"), join(dir, "cmd", "git"), join(dir, "git")];
}

function parseArgs(rawArgs) {
  const parsed = {};
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--fresh") {
      parsed.fresh = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      parsed[key] = rawArgs[index + 1];
      index += 1;
    }
  }
  return parsed;
}
