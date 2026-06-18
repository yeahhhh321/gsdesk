# GSDesk

GSDesk is a lightweight desktop wrapper for `gsuid_core`.

The desktop app manages the local Python core process, opens the built-in
WebConsole, and makes setup, logs, proxy, mirrors, and diagnostics visible for
Windows and macOS users.

## First Release Scope

The first usable release should be one complete local operations surface, not a
set of split milestones.

- Desktop shell for Windows and macOS.
- Start, stop, restart, and health-check `gsuid_core`.
- Load the built-in WebConsole from `http://127.0.0.1:<port>/app`.
- Show real-time terminal logs from the Core process.
- Detect shell updates and guide users to update.
- Clone or update `gsuid_core` from GitHub or the cnb.cool mirror.
- Detect and configure uv / Python / PyPI mirror health.
- Run mirror checks based on upstream `check_pypi_mirrors.py` behavior.
- Support HTTP/HTTPS proxy configuration for Git, uv, Python packages, and Core.
- Provide one-click environment repair and diagnostic export.
- Reserve service orchestration for future NoneBot2 integration.

## Architecture Direction

```text
GSDesk desktop shell
  - window, tray, update check, settings, diagnostics
  - service manager
  - source, mirror, and proxy manager

Local services
  - gsuid_core Python process
  - future NoneBot2 process

Web UI
  - built-in gsuid_core WebConsole at /app
```

The project should avoid rewriting the existing WebConsole in the first
release. The value of GSDesk is making the local runtime stable and inspectable
for users who do not want to operate Git, uv, Python, and terminal logs by hand.

