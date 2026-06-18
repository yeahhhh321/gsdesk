# First Release Scope

## Goal

Make `gsuid_core` usable as a desktop application for Windows and macOS without
requiring users to operate a terminal.

The first release is complete when a user can install GSDesk, initialize the
runtime, start Core, open WebConsole, understand failures, and repair common
network/environment problems from the desktop UI.

## Required Capabilities

### Shell

- Native desktop window.
- Tray menu with open, restart Core, and quit.
- Shell update detection.
- Local settings storage.
- Application data directory management.

### Core Runtime

- Start, stop, restart `gsuid_core`.
- Detect running state, startup failure, crash, and port conflicts.
- Pick an available localhost port when `8765` is occupied.
- Load WebConsole from `http://127.0.0.1:<port>/app`.
- Expose Core data, plugin, config, and log paths.
- Show and copy the initial WebConsole register code when available.

### Terminal Logs

- Stream Core stdout and stderr.
- Search and filter logs.
- Copy selected logs.
- Export recent logs with diagnostic metadata.
- Surface startup errors from the last relevant log lines.

### Source Management

- Support source selection:
  - GitHub: `https://github.com/Genshin-bots/gsuid_core.git`
  - CNB mirror: `https://cnb.cool/gscore-mirror/gsuid_core.git`
- Probe source availability before clone/update.
- Allow switching source when one side is slow or blocked.
- Keep local Core source separate from GSDesk installation files.

### uv, Python, and Mirror Management

- Detect uv availability.
- Install or use a bundled uv where practical.
- Detect Python version compatibility.
- Run environment initialization with uv.
- Configure package index URL.
- Check mirror availability, following the upstream
  `check_pypi_mirrors.py` idea instead of relying on a hardcoded single source.
- Provide one-click repair:
  - rerun uv sync
  - clear broken environment
  - rebuild venv
  - switch mirror

### Proxy Management

- Configure HTTP and HTTPS proxy for:
  - Git clone/update
  - uv package download
  - Python package install
  - Core runtime network access
- Support no-proxy defaults for localhost and local addresses.
- Validate proxy reachability.
- Show the effective proxy configuration before running network operations.

### Diagnostics

- One-click diagnostic export with:
  - GSDesk version
  - OS and architecture
  - uv version
  - Python version
  - selected Core source
  - selected package mirror
  - proxy summary
  - port status
  - recent logs
  - key config paths

### NoneBot2 Preparation

The first release does not need full NoneBot2 onboarding, but the internal
service model should support adding it without rewriting Core management.

```text
ServiceManager
  - GsuidCoreService
  - NoneBot2Service
```

Future NoneBot2 support should include process management, config linking,
connection detection, and combined logs.

