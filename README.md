# GSDesk

GSDesk 是 `gsuid_core` 的桌面运行管家，目标是让 Windows/macOS 用户不用打开终端，也能完成初始化、启动、修复、查看日志和打开 WebConsole。

当前仓库已经落地 v1 基础骨架：

- Tauri v2 桌面壳
- React + TypeScript 中文界面
- Rust 命令层
- 壳内置 uv 与 uv-managed CPython 3.12
- uv 托管项目虚拟环境
- `gsuid_core` 服务状态管理
- 首次安装引导和环境预检
- GitHub/CNB 源探测
- PyPI 镜像测速
- 代理配置
- GitHub/CNB/PyPI/WebConsole 连通性诊断
- Core JSONL 文件日志主视图，stdout/stderr 仅作诊断兜底
- 隔离 uv bootstrap，不依赖用户全局 uv
- 系统托盘后台运行与快捷控制
- 运行时修复面板
- Core 更新与回滚
- 运行时备份快照
- 应用内清理所有本机数据
- 诊断包导出
- 隐私说明
- 壳更新检测与签名自动安装
- NoneBot2 多服务架构占位

## 架构

```text
GSDesk Desktop
  React UI
    - 运行总控台
    - WebConsole 容器
    - Core JSONL 日志
    - 环境与修复
    - 网络、镜像、代理
    - 诊断导出

  Tauri / Rust
    - ServiceManager
    - GsuidCoreService
    - NoneBot2Service placeholder
    - Source / Mirror / Proxy / Diagnostics managers

  Local Runtime
    - gsuid_core source checkout
    - isolated uv executable
    - bundled uv-managed CPython 3.12 copied into runtime
    - isolated project venv
    - uv cache and Python install directories
```

v1 不重写 `gsuid_core` 自带 WebConsole。GSDesk 负责把本地运行时变得稳定、可视化、可诊断。

## 运行时目录

GSDesk 不修改用户全局 Git、pip、uv 或 Python 配置。运行时文件放在应用数据目录：

```text
GSDesk app data
  runtime/core/gsuid_core
  runtime/tools/uv/uv(.exe)
  runtime/venvs/gsuid_core
  runtime/uv/cache
  runtime/uv/python
  runtime/backups
  logs
  diagnostics
  settings.json
```

安装包资源包含 `runtime-assets/git` 与 `runtime-assets/python`；小白用户不需要安装系统 Git 或 Python。

Windows 当前位于 `%APPDATA%\com.yeahhhh321.gsdesk`，macOS 位于 `~/Library/Application Support/com.yeahhhh321.gsdesk`。

## 首次使用

GSDesk 首次打开且 Core 未初始化时会自动弹出安装引导，也可以从运行总控台手动打开。

引导顺序：

1. 环境预检：系统、内置 Git、uv、默认端口、目录权限、磁盘、Core 源码、venv、源码源、PyPI 镜像。
2. 网络代理：保存 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY`。
3. 源码源测速：GitHub 与 CNB 自动测速，自动模式会保存最快可用源。
4. PyPI 镜像测速：保存最快可用镜像到 `UV_DEFAULT_INDEX`。
5. 工具链与初始化运行时：使用安装包内置 Git clone/fetch/pull Core；未检测到 uv 时用内置 Python 创建隔离 uv，再复制壳内置 uv-managed CPython 3.12、执行 `uv sync --no-dev`。
6. 启动 Core：自动选择 `8765-8865` 可用端口，等待 `/app` WebConsole ready。

引导顶部提供“一键安装启动”，会按上述顺序自动执行并在成功打开 WebConsole 后把 `installGuideCompleted` 写入 `settings.json`。后续保存网络设置不会清掉这个状态。

所有失败会进入任务历史和日志页。任务历史支持取消当前运行任务，并对失败或已取消的初始化、启动、uv 安装、修复和 Core 更新任务重试。修复入口位于“环境与修复”，支持安装/修复隔离 uv、重跑 `uv sync`、清理 uv cache、重建 venv、重新 clone Core、Core 更新/回滚、运行时备份、清理所有本机数据，以及打开/复制隔离目录。

## 开发

需要 Node.js、pnpm、Rust/Cargo 和 uv。

```powershell
pnpm install
pnpm build
pnpm verify:bundle-config
pnpm test:ui
cargo test --manifest-path src-tauri\Cargo.toml
pnpm tauri build --no-bundle
pnpm smoke:core
pnpm smoke:desktop
```

开发模式：

```powershell
pnpm tauri dev
```

Web 预览：

```powershell
pnpm dev
```

## v1 关键能力

### Core 管理

- 启动、停止、重启 `gsuid_core`
- 默认优先使用 `8765`，端口占用时自动选择 `8766-8865`
- 支持在“网络与设置”中填写固定端口；固定端口被占用时会阻断启动并提示用户关闭占用进程或改回自动选择
- 启动后持久化 pid/port/start time，GSDesk 重启后可识别遗留 Core，停止或显式退出时按设置清理进程
- 关闭主窗口会隐藏到系统托盘，不会中断 Core；托盘菜单支持显示窗口、启动/停止/重启 Core、打开 WebConsole、打开日志目录和退出 GSDesk
- Core 更新支持 `latest/stable/dev` 通道；更新前记录回滚点，源码有未提交修改时拒绝更新，更新/回滚后会重跑 `uv sync --no-dev`
- 运行时备份导出 `settings.redacted.json`、Core `data/config/plugins` 和日志快照，不打包 venv/cache/Python 安装目录
- 可恢复最近运行时备份；恢复前自动生成安全备份，只恢复 Core `data/config/plugins` 和 GSDesk 日志，不触碰 venv/cache/Python
- 设置迁移支持导出/导入源码源、PyPI 镜像、固定端口、退出策略等非敏感偏好，默认不导出代理账号密码
- “清理所有数据”会先停止 Core，再删除 GSDesk 应用数据目录下的 runtime、logs、diagnostics、backups 和 settings.json，回到未初始化状态
- Windows NSIS 卸载会清理 GSDesk 应用数据目录；macOS `.app/.dmg` 拖拽删除没有系统卸载钩子，卸载前应先在应用内执行“清理所有数据”
- 启动命令：

```text
uv run --python 3.12 core --host 127.0.0.1 --port <port>
```

### 网络治理

- 源码源：
  - GitHub: `https://github.com/Genshin-bots/gsuid_core.git`
  - CNB: `https://cnb.cool/gscore-mirror/gsuid_core.git`
- PyPI 镜像测速参考上游 `check_pypi_mirrors.py` 思路
- 支持 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY`
- 默认 `NO_PROXY=127.0.0.1,localhost,::1`
- 连通性诊断会分别测试 GitHub、CNB、当前 PyPI 镜像和本机 WebConsole；如果配置了代理但 `NO_PROXY` 缺少本机地址，会直接提示 WebConsole 可能被代理劫持

### 诊断

诊断包包含：

- GSDesk 版本
- 系统状态
- 隐私说明
- uv/Git 信息
- 运行时路径
- 服务状态
- 环境预检结果
- 最近任务历史
- 端口占用摘要
- 网络目标诊断
- 失败摘要与最后错误段
- 网络源和镜像配置
- 代理摘要
- 最近 GSDesk stdout/stderr 兜底日志
- 最近 `gsuid_core/data/logs/*.log|*.jsonl` 文件日志 tail

敏感信息会自动遮蔽，包括 `WS_TOKEN`、`REGISTER_CODE` 和代理认证信息。GSDesk v1 不自动上传诊断包、日志或运行状态，详见 [隐私说明](docs/PRIVACY.md)。

诊断页会同时展示故障排查向导和最近错误摘要：根据环境预检、Core 状态、最近失败任务、壳更新检查结果和最后一个 traceback/错误段，给出中文原因和下一步处理动作，避免只导出 zip 但不知道先看哪里。

## 日志

日志页优先读取上游 `gsuid_core/data/logs` 下最新的 JSONL/`.log` 文件。实际兼容的上游格式示例：

```json
{ "event": "[早柚核心] 插件加载完成! 总耗时: 3.00秒", "level": "info", "timestamp": "06-19 10:37:47" }
```

GSDesk 会按文件偏移增量读取，拆分多行 event，容忍坏 JSON 行并显示 `JSONL parse_error`。日志页只展示 Core JSONL 文件日志，支持按等级、模块过滤，支持复制可见、复制全部、导出当前筛选结果和打开日志目录。stdout/stderr/system 不混入日志主视图，仅保留给初始化失败、Python 依赖错误和诊断包兜底；普通 stdout/info 不再写入 GSDesk 诊断文本日志，避免和 JSONL 主日志重复。Windows 子进程默认注入 `PYTHONUTF8=1`、`PYTHONIOENCODING=utf-8:replace`、`PYTHONUNBUFFERED=1` 和无颜色环境变量，并显式移除 `PYTHONLEGACYWINDOWSSTDIO`，避免中文或图标日志回退到 GBK 编码路径；Python logging/colorama 已产生的 GBK 噪声会按整块过滤，旧 `logs/core.log` 也会在取状态时清理并把 emoji/符号转义为 `\u{...}`。

PyPI 镜像策略支持“自动选择”和“手动锁定”。自动选择会在测速后保存最快可用镜像并注入 `UV_DEFAULT_INDEX`；手动锁定只更新时间戳和测速结果，不覆盖用户填写的镜像地址。

## 发布

CI 会在 Windows 和 macOS 上执行：

```powershell
pnpm build
cargo test --manifest-path src-tauri\Cargo.toml
pnpm tauri build --no-bundle
```

推送 `v*` tag 会触发 Release workflow，先为当前平台生成 `runtime-assets`，把 uv 与 uv-managed CPython 3.12 打入安装包，再生成 Windows NSIS 和 macOS app/dmg/updater 产物，签名更新包，上传 `latest.json`，并发布 GitHub Release。应用内壳更新会读取 `releases/latest/download/latest.json`，校验签名后下载、安装并重启 GSDesk。

本地 Windows 安装包命令：

```powershell
pnpm prepare:runtime-assets
pnpm bundle:windows
Get-FileHash -Algorithm SHA256 src-tauri\target\release\bundle\nsis\GSDesk_0.1.0_x64-setup.exe
```

Release workflow 会对每个平台的产物运行：

```powershell
pnpm verify:release-assets -- --dir release-assets --platform windows --write
pnpm verify:release-assets -- --dir release-assets --platform macos --write
```

Windows 必须包含 NSIS `.exe` 和 `.exe.sig`，macOS 必须包含 `.dmg`、`.app.tar.gz` 和 `.app.tar.gz.sig`；脚本会生成并复核 `SHA256SUMS-*.txt`。

Release workflow 需要在 GitHub Secrets 配置：

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`，如果私钥没有密码可留空

本地生成 updater signing key：

```powershell
pnpm tauri signer generate --write-keys .tauri\gsdesk-updater.key
```

`.tauri/` 已被忽略；只提交 `.pub` 内容对应的 `tauri.conf.json > plugins.updater.pubkey`，私钥只放本机或 GitHub Secrets。

真实 Core smoke：

```powershell
pnpm smoke:core -- --port 8875 --timeout 90
```

该脚本会启动隔离 runtime 中的 `gsuid_core`，等待 `/app` 返回成功，确认最新 Core 日志是 JSONL，然后清理进程。

桌面壳 smoke：

```powershell
pnpm smoke:desktop
```

Windows 会启动 `src-tauri/target/release/gsdesk.exe`，确认真实窗口标题、句柄和响应状态，然后清理进程。macOS 需要先生成 `.app`，再在 macOS 环境执行同一命令。

更多细节见：

- [首发范围](docs/FIRST_RELEASE_SCOPE.md)
- [日志与诊断](docs/LOGS_AND_DIAGNOSTICS.md)
- [隐私说明](docs/PRIVACY.md)
- [发布检查清单](docs/RELEASE_CHECKLIST.md)

## License

GPL-3.0-or-later
