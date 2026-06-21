import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const assetsDir = path.join(root, "src-tauri", "runtime-assets");
const pythonDir = path.join(assetsDir, "python");
const gitDir = path.join(assetsDir, "git");
const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsdesk-runtime-assets-"));
const bootstrapUvRoot = path.join(buildDir, "uv-bootstrap");
const pythonInstallDir = path.join(buildDir, "python-install");
const cacheDir = path.join(root, "src-tauri", "target", "runtime-asset-cache", "uv");
const gitCacheDir = path.join(root, "src-tauri", "target", "runtime-asset-cache", "git");
const pythonTarget = "3.12";
const uvTargetName = process.platform === "win32" ? "uv.exe" : "uv";

ensureDir(pythonDir);
ensureDir(gitDir);
const bundledPython = findPythonBinary(pythonDir);
if (!bundledPython) {
  throw new Error(`Bundled Python ${pythonTarget} is required before updating runtime assets: ${pythonDir}`);
}
const gitAsset = await prepareGitAsset();
resetDir(bootstrapUvRoot);
ensureDir(cacheDir);
const uvPath = createUvFromBundledPython(bundledPython, bootstrapUvRoot);
const uvVersion = runText(uvPath, ["--version"]);
console.log(`[runtime-assets] using ${uvVersion} from bundled Python`);

cleanGeneratedDir(pythonDir);
resetDir(pythonInstallDir);

const installEnv = {
  ...process.env,
  UV_CACHE_DIR: cacheDir,
  UV_PYTHON_INSTALL_DIR: pythonInstallDir,
};
delete installEnv.UV_PYTHON_DOWNLOADS;

run(uvPath, ["python", "install", pythonTarget, "--install-dir", pythonInstallDir, "--no-bin"], installEnv);

copyDirContents(pythonInstallDir, pythonDir);
removeIfExists(path.join(pythonDir, ".temp"));
removeIfExists(path.join(pythonDir, ".lock"));
removeIfExists(path.join(pythonDir, ".gitignore"));

const pythonBinary = findPythonBinary(pythonDir);
if (!pythonBinary) {
  throw new Error(`Bundled Python ${pythonTarget} was not generated under ${pythonDir}`);
}

const installNames = fs
  .readdirSync(pythonDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith("cpython-3.12"))
  .map((entry) => entry.name)
  .sort();

if (installNames.length === 0) {
  throw new Error(`Bundled Python ${pythonTarget} install directory is missing under ${pythonDir}`);
}

const manifest = {
  schema: "gsdesk-runtime-assets-v1",
  generatedAt: new Date().toISOString(),
  platform: os.platform(),
  arch: os.arch(),
  uvBootstrap: {
    package: "uv",
    source: "bundled-python-venv",
    version: uvVersion,
  },
  pythonTarget,
  pythonInstalls: installNames,
  pythonBinary: path.relative(assetsDir, pythonBinary).replaceAll("\\", "/"),
  git: gitAsset,
};

fs.writeFileSync(path.join(assetsDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`[runtime-assets] bundled ${manifest.pythonBinary}`);
fs.rmSync(buildDir, { recursive: true, force: true });

function createUvFromBundledPython(sourcePython, targetRoot) {
  const pipEnv = {
    ...process.env,
    PIP_CACHE_DIR: path.join(cacheDir, "pip"),
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    PIP_NO_INPUT: "1",
    PYTHONUTF8: "1",
    PYTHONUNBUFFERED: "1",
  };
  console.log(`[runtime-assets] creating uv with bundled Python: ${sourcePython}`);
  run(sourcePython, ["-m", "venv", targetRoot], pipEnv);
  const venvPython = findPythonBinary(targetRoot);
  if (!venvPython) {
    throw new Error(`uv bootstrap venv was created without Python: ${targetRoot}`);
  }
  run(venvPython, ["-m", "ensurepip", "--upgrade"], pipEnv);
  run(venvPython, ["-m", "pip", "install", "--upgrade", "uv"], pipEnv);
  const uvExecutable = path.join(targetRoot, scriptsDirName(), uvTargetName);
  if (!fs.existsSync(uvExecutable)) {
    throw new Error(`uv was installed but executable is missing: ${uvExecutable}`);
  }
  if (process.platform !== "win32") {
    fs.chmodSync(uvExecutable, 0o755);
  }
  return uvExecutable;
}

async function prepareGitAsset() {
  const localGitDir = process.env.GSDESK_PORTABLE_GIT_DIR;
  if (localGitDir) {
    return copyConfiguredGitDir(path.resolve(localGitDir), "local-dir");
  }

  if (process.platform !== "win32") {
    return {
      bundled: false,
      source: "skipped",
      reason: "automatic portable Git bundling is implemented for Windows release assets",
    };
  }

  ensureDir(gitCacheDir);
  const url = process.env.GSDESK_PORTABLE_GIT_URL || (await latestMinGitUrl());
  const archive = path.join(gitCacheDir, safeArchiveName(url));
  if (!fs.existsSync(archive) || fs.statSync(archive).size === 0) {
    console.log(`[runtime-assets] downloading portable Git: ${url}`);
    await downloadFile(url, archive);
  } else {
    console.log(`[runtime-assets] using cached portable Git: ${archive}`);
  }

  const extractDir = path.join(buildDir, "git-extract");
  resetDir(extractDir);
  expandZip(archive, extractDir);
  const sourceDir = findGitRoot(extractDir);
  if (!sourceDir) {
    throw new Error(`Portable Git archive did not contain a supported git executable: ${archive}`);
  }
  return copyConfiguredGitDir(sourceDir, url);
}

function copyConfiguredGitDir(sourceDir, sourceLabel) {
  const gitBinary = findGitBinary(sourceDir);
  if (!gitBinary) {
    throw new Error(`Portable Git directory is missing git executable: ${sourceDir}`);
  }

  resetDir(gitDir);
  copyDirContents(sourceDir, gitDir);
  fs.writeFileSync(path.join(gitDir, ".gitkeep"), "", "utf8");
  const bundledGit = findGitBinary(gitDir);
  if (!bundledGit) {
    throw new Error(`Portable Git copy completed without git executable: ${gitDir}`);
  }
  const gitVersion = runText(bundledGit, ["--version"]);
  const relativeBinary = path.relative(assetsDir, bundledGit).replaceAll("\\", "/");
  console.log(`[runtime-assets] bundled ${gitVersion} at ${relativeBinary}`);
  return {
    bundled: true,
    source: sourceLabel,
    version: gitVersion,
    binary: relativeBinary,
  };
}

async function latestMinGitUrl() {
  const response = await fetch("https://api.github.com/repos/git-for-windows/git/releases/latest", {
    headers: { "User-Agent": "GSDesk runtime asset builder" },
  });
  if (!response.ok) {
    throw new Error(`Failed to query Git for Windows release: HTTP ${response.status}`);
  }
  const release = await response.json();
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const asset = assets
    .filter((item) => typeof item.name === "string" && typeof item.browser_download_url === "string")
    .find((item) => /^MinGit-.*-64-bit\.zip$/i.test(item.name) && !/busybox/i.test(item.name));
  if (!asset) {
    throw new Error("Git for Windows release does not contain a MinGit 64-bit zip asset");
  }
  return asset.browser_download_url;
}

async function downloadFile(url, target) {
  const response = await fetch(url, { headers: { "User-Agent": "GSDesk runtime asset builder" } });
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(target, buffer);
}

function expandZip(archive, targetDir) {
  if (process.platform === "win32") {
    run("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Expand-Archive -LiteralPath '${psLiteral(archive)}' -DestinationPath '${psLiteral(targetDir)}' -Force`,
    ]);
    return;
  }
  run("unzip", ["-q", archive, "-d", targetDir]);
}

function findGitRoot(dir) {
  if (findGitBinary(dir)) return dir;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const found = findGitRoot(path.join(dir, entry.name));
    if (found) return found;
  }
  return undefined;
}

function findGitBinary(dir) {
  for (const candidate of gitBinaryCandidates(dir)) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return undefined;
}

function gitBinaryCandidates(dir) {
  if (process.platform === "win32") {
    return [
      path.join(dir, "cmd", "git.exe"),
      path.join(dir, "bin", "git.exe"),
      path.join(dir, "mingw64", "bin", "git.exe"),
      path.join(dir, "git.exe"),
    ];
  }
  return [path.join(dir, "bin", "git"), path.join(dir, "cmd", "git"), path.join(dir, "git")];
}

function safeArchiveName(url) {
  const name = path.basename(new URL(url).pathname);
  if (!name.toLowerCase().endsWith(".zip")) {
    throw new Error(`Portable Git asset must be a zip file: ${url}`);
  }
  return name;
}

function psLiteral(value) {
  return String(value).replaceAll("'", "''");
}

function run(program, args, env = process.env) {
  execFileSync(program, args, { cwd: root, env, stdio: "inherit" });
}

function runText(program, args) {
  return execFileSync(program, args, { cwd: root, encoding: "utf8" }).trim();
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function cleanGeneratedDir(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".gitkeep") continue;
    const target = path.join(dir, entry.name);
    fs.rmSync(target, { recursive: true, force: true });
  }
}

function resetDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  ensureDir(dir);
}

function copyDirContents(source, target) {
  ensureDir(target);
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyDirContents(sourcePath, targetPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

function removeIfExists(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function scriptsDirName() {
  return process.platform === "win32" ? "Scripts" : "bin";
}

function findPythonBinary(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const current = path.join(dir, entry.name);
    if (entry.isFile() && isPythonName(entry.name)) {
      return current;
    }
  }
  for (const entry of entries) {
    const current = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findPythonBinary(current);
      if (found) return found;
    }
  }
  return undefined;
}

function isPythonName(name) {
  if (process.platform === "win32") return name.toLowerCase() === "python.exe";
  return name === "python" || name.startsWith("python3.");
}
