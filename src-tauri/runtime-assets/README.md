# Runtime assets

Release builds generate bundled Git for Windows and CPython 3.12 into this directory before Tauri packaging.

GSDesk creates and updates its isolated uv executable from this bundled Python at runtime.
GSDesk uses bundled Git for source probing, clone, fetch, update, rollback, and diagnostics before falling back to system Git.

Generated binaries are intentionally ignored. They are release resources, not source files.
