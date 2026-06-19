import fs from "node:fs";

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

assertFile("src-tauri/app-icon.svg");
assert(tauriConfig.bundle.publisher === "yeahhhh321", "bundle.publisher must stay on yeahhhh321");
assert(tauriConfig.bundle.homepage === "https://github.com/yeahhhh321/gsdesk", "bundle.homepage must point to the public repo");
assert(tauriConfig.bundle.license === "GPL-3.0-or-later", "bundle.license must match LICENSE");
assert(tauriConfig.identifier === "com.yeahhhh321.gsdesk", "Tauri identifier must stay stable for app data paths");

console.log("[bundle-config] version, targets, identifiers, and icons passed");

function assertFile(file) {
  assert(fs.existsSync(file), `Missing file: ${file}`);
  assert(fs.statSync(file).size > 0, `File is empty: ${file}`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
