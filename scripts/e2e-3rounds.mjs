import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";

const pnpm = "pnpm";
const startPort = readNumberArg("--start-port", 8910);
const timeout = readNumberArg("--timeout", 90);

for (let round = 1; round <= 3; round += 1) {
  const port = startPort + round - 1;
  console.log(`\n[e2e] round ${round}/3 port=${port}`);
  await run(pnpm, ["test:ui"]);
  await run(pnpm, ["verify"]);
  await run(pnpm, ["smoke:desktop"]);
  await run(process.execPath, ["scripts/smoke-core.mjs", "--port", String(port), "--timeout", String(timeout)]);
  await assertPortClosed(port);
}

assertNoGbkEncodingNoise();
console.log("\n[e2e] 3 rounds passed");

function readNumberArg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ${name}: ${process.argv[index + 1]}`);
  }
  return value;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    console.log(`[e2e] $ ${command} ${args.join(" ")}`);
    const windowsShellCommand = process.platform === "win32" && command === pnpm;
    const child = windowsShellCommand
      ? spawn(shellLine(command, args), {
          cwd: process.cwd(),
          stdio: "inherit",
          shell: true,
        })
      : spawn(command, args, {
          cwd: process.cwd(),
          stdio: "inherit",
        });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} failed with code=${code} signal=${signal}`));
      }
    });
  });
}

function shellLine(command, args) {
  return [command, ...args].map(shellQuote).join(" ");
}

function shellQuote(value) {
  if (/^[\w:./\\-]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

async function assertPortClosed(port) {
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(1200);
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error(`Port ${port} is still accepting connections after smoke`));
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", () => resolve());
  });
  console.log(`[e2e] port ${port} released`);
}

function assertNoGbkEncodingNoise() {
  const roots = runtimeLogRoots();
  const patterns = [/UnicodeEncodeError/i, /gbk.*can't encode/i, /can't encode character/i];
  const hits = [];

  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    for (const file of listTextFiles(root, 50)) {
      const content = readTail(file, 512 * 1024);
      if (patterns.some((pattern) => pattern.test(content))) {
        hits.push(file);
      }
    }
  }

  if (hits.length) {
    throw new Error(`GBK encoding noise found in logs:\n${hits.join("\n")}`);
  }
  console.log("[e2e] no GBK encoding noise found in recent logs");
}

function runtimeLogRoots() {
  if (process.platform === "win32") {
    const base = process.env.APPDATA ? path.join(process.env.APPDATA, "com.core.gsdesk") : "";
    return [path.join(base, "logs"), path.join(base, "runtime", "core", "gsuid_core", "data", "logs")];
  }
  if (process.platform === "darwin") {
    const base = path.join(process.env.HOME || "", "Library", "Application Support", "com.core.gsdesk");
    return [path.join(base, "logs"), path.join(base, "runtime", "core", "gsuid_core", "data", "logs")];
  }
  return [];
}

function* listTextFiles(root, maxFiles) {
  const stack = [root];
  let count = 0;
  while (stack.length && count < maxFiles) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (/\.(log|jsonl|txt)$/i.test(entry.name)) {
        count += 1;
        yield fullPath;
        if (count >= maxFiles) return;
      }
    }
  }
}

function readTail(file, maxBytes) {
  const stat = fs.statSync(file);
  const start = Math.max(0, stat.size - maxBytes);
  const length = stat.size - start;
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}
