# 发布检查清单

## 本地发布前检查

在 tag 前至少执行三轮完整验证。每轮都必须重新执行命令，不复用旧输出：

```powershell
pnpm build
pnpm test:ui
pnpm verify:security
pnpm verify:bundle-config
cargo test --manifest-path src-tauri\Cargo.toml
pnpm tauri build --no-bundle
pnpm smoke:desktop
```

也可以直接运行统一脚本，脚本会连续执行三轮 UI smoke、完整 verify、真实桌面壳 smoke、真实 Core smoke，并检查 smoke 端口释放和 GBK 编码噪声：

```powershell
pnpm verify:e2e -- --start-port 8910 --timeout 90
```

真实 Core smoke：

```powershell
pnpm smoke:core -- --port 8875 --timeout 90
```

真实桌面壳 smoke：

```powershell
pnpm smoke:desktop
```

Windows 安装包：

```powershell
pnpm prepare:runtime-assets
pnpm bundle:windows
Get-FileHash -Algorithm SHA256 src-tauri\target\release\bundle\nsis\GSDesk_0.1.0_x64-setup.exe
```

本地验证 release 资产清单和 checksum：

```powershell
New-Item -ItemType Directory -Force -Path release-assets
Copy-Item src-tauri\target\release\bundle\nsis\GSDesk_0.1.0_x64-setup.exe release-assets\
pnpm verify:release-assets -- --dir release-assets --platform windows --write
```

`pnpm test:ui` 会自动覆盖首屏、首启引导关闭/重开、日志虚拟滚动、网络页、环境页和诊断页。还需要人工打开 UI 补充检查：

- 运行总控台能显示 Core 状态、健康度、首启入口和 WebConsole 操作。
- 正式 release 可执行文件能启动真实桌面窗口，窗口标题为 `GSDesk`，窗口句柄非 0 且进程响应。
- 首次安装引导能打开、能关闭，提供“一键安装启动”，成功后持久化 `installGuideCompleted`。
- 环境与修复能显示预检、任务历史、取消当前运行任务、重试失败/已取消任务、安装/修复 uv、重新 clone Core、隔离目录复制/打开。
- Core 更新区能检查 latest、更新 latest/stable/dev，并在更新前记录回滚点；dirty repo 必须拒绝更新。
- 回滚按钮只能使用已记录回滚点，回滚后要重新同步依赖。
- 运行时备份能生成 zip，包含 `settings.redacted.json`，不直接导出原始 settings 里的代理密码/token。
- 恢复最近运行时备份时必须先创建安全备份；Core 正在运行时必须拒绝恢复；只允许恢复 `core-data/core-config/core-plugins/logs`。
- 设置导出/导入只迁移非敏感字段，代理账号密码不能被导出，也不能被导入覆盖。
- 清理所有数据必须先确认、先停止 Core，再删除 GSDesk 应用数据目录下的 runtime、logs、diagnostics、backups 和 settings.json；清理后 UI 回到未初始化状态。
- Windows NSIS 卸载必须触发 `windows/nsis-hooks.nsh`，删除 `$APPDATA/$LOCALAPPDATA` 下的 GSDesk 数据目录。
- macOS `.app/.dmg` 没有卸载钩子；发布说明必须提示用户卸载前可在应用内执行“清理所有数据”。
- fresh runtime 下未检测到 uv 时，一键流程能先复制安装包内置 uv 到 `runtime/tools/uv`，后续初始化使用该隔离 uv。
- fresh runtime 下初始化 Python 时不得联网下载 Python；必须从安装包内置 `runtime-assets/python` 复制到 `runtime/uv/python`，并设置 `UV_PYTHON_DOWNLOADS=never`。
- Core 启动后 `runtime/core-process.json` 能记录 pid/port；重开 GSDesk 后能识别遗留进程，停止时清理状态文件。
- 主窗口关闭应隐藏到系统托盘且不停止 Core；托盘菜单能显示窗口、启动/停止/重启 Core、打开 WebConsole、打开日志目录；托盘“退出 GSDesk”才按设置清理 Core。
- 自动端口模式下 8765 占用应提示警告并自动选择 8766-8865；固定端口被占用时必须阻断启动并提示改回自动或关闭占用进程。
- 日志页只显示 Core JSONL 文件日志，1000+ 行保持虚拟滚动。
- 日志页能按等级、模块过滤，真实 JSONL 不出现多个时间戳挤在同一行。
- 旧 `logs/core.log` 中 Python logging/colorama 的 GBK 编码噪声会被清理；诊断包不得包含这类假错误。
- 诊断导出能生成 zip，敏感字段被遮蔽。
- 诊断页故障排查向导能显示预检阻断项、最近失败任务、Core 错误、WebConsole 未就绪和更新检查失败的中文处理动作。
- 诊断页隐私说明面板能明确显示自动上传关闭；诊断包包含 `privacy.txt`，说明诊断包只在本机生成。
- 壳更新检查能通过 Tauri updater 返回当前版本、可安装版本、下载地址或中文错误；发现更新后能出现“下载并安装”入口。

## Tag 发布

1. 确认工作区只包含本次发布内容。
2. 更新 `src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`package.json` 的版本号。
3. 运行三轮本地验证。
4. 创建 tag：

```powershell
git tag v0.1.0
git push origin v0.1.0
```

5. 等待 GitHub Actions `Release` workflow 完成。
6. 检查已发布 Release 产物：
   - Windows NSIS 安装包
   - Windows `.exe.sig`
   - macOS dmg
   - macOS `.app.tar.gz`
   - macOS `.app.tar.gz.sig`
   - `latest.json`
   - `SHA256SUMS-windows.txt`
   - `SHA256SUMS-macos-aarch64.txt`
   - `SHA256SUMS-macos-x86_64.txt`
   - `SHA256SUMS-*.txt` 中每个 hash 都能被 `pnpm verify:release-assets` 复核
   - 自动生成的 release notes
7. 用新安装包做 fresh runtime 初始化，确认未出现 `uv python install` 下载 Python，任务日志显示内置 Python 已就绪。
8. 用上一版本安装包启动 GSDesk，执行“检查壳更新 -> 下载并安装”，确认签名校验通过并自动重启到新版本。

## 发布边界

- v1 支持用户确认后的壳自动更新：下载 GitHub Release updater 包、校验签名、安装并重启。
- v1 安装包内置 Git、uv 与 uv-managed CPython 3.12；终端用户初始化时不要求安装系统 Git，不下载 Python 运行时，只下载 Core 源码和项目依赖。
- Release signing 私钥只允许放在本机或 GitHub Secrets，不进入 Git。
- 诊断包不会自动上传。
- 不修改用户全局 Git、pip、uv、Python 配置。
- 修复动作默认只操作 GSDesk 隔离目录。
- 数据清理只允许操作 GSDesk 应用数据目录，不允许删除安装目录、用户全局工具目录或任意自定义路径。

## 回归重点

- 国内网络下 GitHub 慢、CNB 快时，自动源选择应保存 CNB。
- PyPI 镜像为自动模式时，测速后保存最快可用镜像到 `UV_DEFAULT_INDEX`；手动锁定时不能覆盖用户填写的地址。
- 错误代理要能暴露清楚的中文错误和原始日志。
- Core stdout/stderr 中出现中文或 emoji 时，不能出现 `UnicodeEncodeError: 'gbk' codec can't encode character`。
- Core JSONL 中出现坏行时，日志页显示 `JSONL parse_error` 而不是空白或界面异常。
- uv 检测、初始化、修复和诊断必须使用同一套 uv 解析顺序：隔离目录 -> 打包资源 -> PATH。
- Git 检测、源码探测、clone/fetch/pull、Core 更新/回滚和诊断必须优先使用安装包内置 Git，系统 Git 只能作为高级 fallback。
- Python 运行时必须来自打包资源或已复制的隔离目录；业务路径不得回退到 `uv python install` 联网下载。
- 运行时备份不得包含 venv、uv cache、uv Python 安装目录。
- 壳更新检查和安装必须走 Tauri updater，不再手写 GitHub Release semver 判断。
- 发布配置必须通过 `pnpm verify:bundle-config`：版本号一致，targets 包含 Windows/macOS，图标包含 `.ico/.icns/PNG`，`createUpdaterArtifacts` 和 updater endpoint/pubkey 不可缺失。
- 发布配置必须保留 Windows NSIS uninstall hook，避免卸载后残留运行时数据。
