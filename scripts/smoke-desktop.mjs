import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const args = parseArgs(process.argv.slice(2));
const timeoutMs = Number(args.timeout || 20) * 1000;
const keepOpen = Boolean(args.keepOpen);

const target = resolve(args.exe || defaultTarget());
if (!existsSync(target)) {
  throw new Error(`Desktop target does not exist: ${target}`);
}

if (process.platform === "win32") {
  await smokeWindows(target, timeoutMs, keepOpen);
} else if (process.platform === "darwin") {
  await smokeMacos(target, timeoutMs, keepOpen);
} else {
  throw new Error(`Unsupported desktop smoke platform: ${process.platform}`);
}

function defaultTarget() {
  if (process.platform === "win32") return "src-tauri/target/release/gsdesk.exe";
  if (process.platform === "darwin") return "src-tauri/target/release/bundle/macos/GSDesk.app";
  return "src-tauri/target/release/gsdesk";
}

async function smokeWindows(exe, timeout, keep) {
  const child = spawn(exe, [], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
  try {
    const state = await waitForWindowsWindow(child.pid, timeout);
    safeWrite(
      `[desktop-smoke] windows ok pid=${state.id} title=${JSON.stringify(state.title)} handle=${state.handle} responding=${state.responding}\n`,
    );
  } finally {
    if (!keep) await killWindowsTree(child.pid);
  }
}

async function waitForWindowsWindow(pid, timeout) {
  const deadline = Date.now() + timeout;
  let last = "";
  while (Date.now() < deadline) {
    const output = await run("powershell", [
      "-NoProfile",
      "-Command",
      `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { [pscustomobject]@{ id=$p.Id; title=$p.MainWindowTitle; handle=$p.MainWindowHandle; responding=$p.Responding } | ConvertTo-Json -Compress }`,
    ]);
    last = output.stdout.trim() || output.stderr.trim();
    if (output.code === 0 && output.stdout.trim()) {
      const parsed = JSON.parse(output.stdout.trim());
      if (Number(parsed.handle) !== 0 && String(parsed.title || "").trim()) {
        return {
          id: parsed.id,
          title: parsed.title,
          handle: parsed.handle,
          responding: parsed.responding,
        };
      }
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for GSDesk window. Last state: ${last || "empty"}`);
}

async function killWindowsTree(pid) {
  await run("taskkill", ["/PID", String(pid), "/T", "/F"]);
}

async function smokeMacos(appPath, timeout, keep) {
  await run("open", ["-n", appPath]);
  const appName = appPath.endsWith(".app") ? appPath.split(/[\\/]/).at(-1).replace(/\.app$/i, "") : "gsdesk";
  try {
    const state = await waitForMacosProcess(appName, timeout);
    safeWrite(`[desktop-smoke] macos ok process=${JSON.stringify(state)}\n`);
  } finally {
    if (!keep) await run("osascript", ["-e", `tell application "${appName}" to quit`]);
  }
}

async function waitForMacosProcess(appName, timeout) {
  const deadline = Date.now() + timeout;
  let last = "";
  while (Date.now() < deadline) {
    const output = await run("osascript", [
      "-e",
      `tell application "System Events" to get the name of every process whose name contains "${appName.replace(/"/g, '\\"')}"`,
    ]);
    last = output.stdout.trim() || output.stderr.trim();
    if (output.code === 0 && output.stdout.trim()) return output.stdout.trim();
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${appName} process. Last state: ${last || "empty"}`);
}

function run(command, commandArgs) {
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => resolve({ code: 1, stdout, stderr: error.message }));
    child.on("exit", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--keep-open") {
      parsed.keepOpen = true;
    } else if (value.startsWith("--")) {
      parsed[value.slice(2)] = values[index + 1];
      index += 1;
    }
  }
  return parsed;
}

function safeWrite(text) {
  process.stdout.write(text);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
