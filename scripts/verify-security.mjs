import fs from "node:fs";

const tauriConfig = JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json", "utf8"));
const capability = JSON.parse(fs.readFileSync("src-tauri/capabilities/default.json", "utf8"));

const csp = tauriConfig?.app?.security?.csp ?? "";
const requiredCspFragments = [
  "default-src 'self' ipc: http://ipc.localhost",
  "script-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "frame-src http://127.0.0.1:*",
  "connect-src 'self' ipc: http://ipc.localhost http://127.0.0.1:*",
];
const forbiddenTelemetryFragments = [
  "analytics",
  "telemetry",
  "sentry",
  "posthog",
  "segment",
  "amplitude",
  "google-analytics",
  "googletagmanager",
];

for (const fragment of requiredCspFragments) {
  assert(csp.includes(fragment), `CSP missing fragment: ${fragment}`);
}

assert(!csp.includes("script-src 'self' 'unsafe-inline'"), "script-src must not allow inline scripts");
assert(!csp.includes("'unsafe-eval'"), "CSP must not allow unsafe-eval");
for (const fragment of forbiddenTelemetryFragments) {
  assert(!csp.toLowerCase().includes(fragment), `CSP must not include telemetry/analytics target: ${fragment}`);
}

assert(Array.isArray(capability.windows), "capability.windows must be an array");
assert(capability.windows.length === 1 && capability.windows[0] === "main", "capability must only target the main window");

const permissions = new Set(capability.permissions ?? []);
assert(permissions.has("core:default"), "capability must include core:default");
assert(permissions.has("opener:default"), "capability must include opener:default");
assert(permissions.size === 2, "capability should not grant extra permissions without an explicit review");
assert(fs.existsSync("docs/PRIVACY.md"), "docs/PRIVACY.md must document the local-only privacy posture");

console.log("[security] CSP and default capability checks passed");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
