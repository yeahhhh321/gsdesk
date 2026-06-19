import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
const platform = String(args.platform || "").toLowerCase();
const dir = path.resolve(String(args.dir || "release-assets"));
const shouldWrite = Boolean(args.write);

if (!["windows", "macos"].includes(platform)) {
  throw new Error("Usage: node scripts/verify-release-assets.mjs --platform windows|macos [--dir release-assets] [--write]");
}
if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
  throw new Error(`Release assets directory does not exist: ${dir}`);
}

const checksumName = `SHA256SUMS-${platform}.txt`;
const files = fs
  .readdirSync(dir, { withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
  .sort((a, b) => a.localeCompare(b));
const assetFiles = files.filter((name) => name !== checksumName && !name.startsWith("SHA256SUMS-"));

assertRequiredAssets(platform, assetFiles);
assertNonEmpty(assetFiles);

const checksumLines = assetFiles.map((name) => `${sha256(path.join(dir, name))}  ${name}`);
const checksumPath = path.join(dir, checksumName);
if (shouldWrite) {
  fs.writeFileSync(checksumPath, `${checksumLines.join("\n")}\n`, "utf8");
}

if (!fs.existsSync(checksumPath)) {
  throw new Error(`Missing checksum file: ${checksumName}`);
}

const expected = checksumLines.join("\n");
const actual = fs.readFileSync(checksumPath, "utf8").trim().split(/\r?\n/).sort().join("\n");
if (actual !== expected) {
  throw new Error(`Checksum file mismatch: ${checksumName}`);
}

console.log(`[release-assets] ${platform} ok: ${assetFiles.join(", ")}; ${checksumName}`);

function assertRequiredAssets(target, names) {
  if (target === "windows") {
    requireSome(names, /\.exe$/i, "Windows NSIS installer (.exe)");
    return;
  }
  requireSome(names, /\.dmg$/i, "macOS disk image (.dmg)");
  requireSome(names, /\.app\.zip$/i, "macOS app archive (.app.zip)");
}

function assertNonEmpty(names) {
  for (const name of names) {
    const fullPath = path.join(dir, name);
    if (fs.statSync(fullPath).size <= 0) {
      throw new Error(`Release asset is empty: ${name}`);
    }
  }
}

function requireSome(names, pattern, label) {
  if (!names.some((name) => pattern.test(name))) {
    throw new Error(`Missing required release asset: ${label}`);
  }
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").toUpperCase();
}

function parseArgs(rawArgs) {
  const parsed = {};
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--write") {
      parsed.write = true;
      continue;
    }
    if (arg.startsWith("--")) {
      parsed[arg.slice(2)] = rawArgs[index + 1];
      index += 1;
    }
  }
  return parsed;
}
