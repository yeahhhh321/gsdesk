import fs from "node:fs";
import path from "node:path";

const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
const tauriConfig = JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json", "utf8"));
const cargoToml = fs.readFileSync("src-tauri/Cargo.toml", "utf8");

const cargoVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
assert(packageJson.version === tauriConfig.version, "package.json and tauri.conf.json versions must match");
assert(packageJson.version === cargoVersion, "package.json and Cargo.toml versions must match");

const targets = new Set(tauriConfig?.bundle?.targets ?? []);
for (const target of ["nsis", "app", "dmg"]) {
  assert(targets.has(target), `bundle.targets must include ${target}`);
}

const icons = tauriConfig?.bundle?.icon ?? [];
for (const required of ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.icns", "icons/icon.ico"]) {
  assert(icons.includes(required), `bundle.icon must include ${required}`);
  assertFile(`src-tauri/${required}`);
}

const resources = tauriConfig.bundle.resources ?? [];
assert(Array.isArray(resources), "bundle.resources must be an array");
assert(resources.includes("runtime-assets/"), "bundle.resources must include runtime-assets/");
assertDir("src-tauri/runtime-assets");
assertDir("src-tauri/runtime-assets/python");
assertFile("src-tauri/runtime-assets/manifest.json");
if (process.platform === "win32") {
  assertDir("src-tauri/runtime-assets/git");
  const bundledGit = findRuntimeGit("src-tauri/runtime-assets/git");
  assertFile(bundledGit);
  const manifest = JSON.parse(fs.readFileSync("src-tauri/runtime-assets/manifest.json", "utf8"));
  assert(manifest.git?.bundled === true, "runtime-assets manifest must declare bundled Git on Windows");
  assert(
    path.normalize(path.join("src-tauri/runtime-assets", manifest.git.binary ?? "")) === path.normalize(bundledGit),
    "runtime-assets manifest git.binary must point to the bundled Git executable",
  );
}
assertFile("src-tauri/app-icon.svg");
assert(tauriConfig.bundle.publisher === "yeahhhh321", "bundle.publisher must stay on yeahhhh321");
assert(tauriConfig.bundle.homepage === "https://github.com/yeahhhh321/gsdesk", "bundle.homepage must point to the public repo");
assert(tauriConfig.bundle.license === "GPL-3.0-or-later", "bundle.license must match LICENSE");
assert(tauriConfig.identifier === "com.yeahhhh321.gsdesk", "Tauri identifier must stay stable for app data paths");
assert(
  tauriConfig.bundle.windows?.nsis?.installerHooks === "windows/nsis-hooks.nsh",
  "bundle.windows.nsis.installerHooks must clean GSDesk app data on uninstall",
);
assertFile("src-tauri/windows/nsis-hooks.nsh");
const nsisHooks = fs.readFileSync("src-tauri/windows/nsis-hooks.nsh", "utf8");
assert(nsisHooks.includes("NSIS_HOOK_POSTUNINSTALL"), "NSIS hooks must define NSIS_HOOK_POSTUNINSTALL");
assert(nsisHooks.includes("$APPDATA\\com.yeahhhh321.gsdesk"), "NSIS uninstall hook must remove roaming app data");
assert(nsisHooks.includes("$LOCALAPPDATA\\com.yeahhhh321.gsdesk"), "NSIS uninstall hook must remove local app data");
assert(
  tauriConfig.bundle.createUpdaterArtifacts === true,
  "bundle.createUpdaterArtifacts must stay enabled for shell auto update",
);

const updater = tauriConfig?.plugins?.updater;
assert(updater?.pubkey && typeof updater.pubkey === "string", "plugins.updater.pubkey is required for signed shell updates");
assert(
  updater.endpoints?.includes("https://github.com/yeahhhh321/gsdesk/releases/latest/download/latest.json"),
  "plugins.updater.endpoints must include the public GitHub latest.json endpoint",
);
assert(updater?.windows?.installMode === "passive", "plugins.updater.windows.installMode must be passive");

console.log("[bundle-config] version, targets, identifiers, and icons passed");

function assertFile(file) {
  assert(fs.existsSync(file), `Missing file: ${file}`);
  assert(fs.statSync(file).size > 0, `File is empty: ${file}`);
}

function assertDir(dir) {
  assert(fs.existsSync(dir), `Missing directory: ${dir}`);
  assert(fs.statSync(dir).isDirectory(), `Path is not a directory: ${dir}`);
}

function findRuntimeGit(dir) {
  for (const candidate of [
    path.join(dir, "cmd", "git.exe"),
    path.join(dir, "bin", "git.exe"),
    path.join(dir, "mingw64", "bin", "git.exe"),
    path.join(dir, "git.exe"),
  ]) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Missing bundled Git executable under ${dir}`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
