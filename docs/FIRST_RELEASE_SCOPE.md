# GSDesk v1 范围

## 目标

v1 要成为一个完整的 `gsuid_core` 桌面运行管家，而不是只包一层 WebView。

用户成功路径：

```text
打开 GSDesk
  -> 配置代理或跳过
  -> 探测 GitHub / CNB 源
  -> 测速 PyPI 镜像
  -> 初始化 uv / Python / venv
  -> 启动 gsuid_core
  -> 打开 WebConsole
  -> 出错时查看日志并导出诊断包
```

## 已落地模块

### 桌面壳

- Tauri v2
- React + TypeScript
- 中文优先 UI
- Windows/macOS 目标
- 应用窗口最小尺寸按小屏 PC 设计

### 服务模型

- `ServiceManager` 由 Rust `SharedRuntime` 和服务命令承载
- `GsuidCoreService` 已实现启动、停止、重启、状态快照、日志采集
- 启动后持久化 Core `pid/port/started_at`，应用重启后可识别遗留进程，停止/显式退出时能清理持久化进程
- 关闭主窗口隐藏到系统托盘；托盘提供显示窗口、Core 启停/重启、打开 WebConsole、打开日志目录和退出 GSDesk
- 端口支持自动选择和用户固定；固定端口冲突时作为阻断项处理，不自动切换到其它端口
- `NoneBot2Service` 首版仅占位，避免后续接入时重构服务模型

### 运行时隔离

- Core 源码、venv、uv cache、uv Python 安装目录都在 GSDesk 应用数据目录
- uv 可执行文件优先使用 `runtime/tools/uv/uv(.exe)`，其次是打包资源，最后才回退到 PATH
- 环境页提供“安装/修复 uv”，自动下载到隔离目录，不修改全局配置
- 备份快照输出到 `runtime/backups`，不打包 venv、cache 或 Python 安装目录
- 子进程通过环境变量注入配置
- 不修改用户全局工具配置

### 网络与镜像

- GitHub/CNB 源探测
- 10 个 PyPI 镜像测速
- `UV_DEFAULT_INDEX` 注入
- 代理配置和 `NO_PROXY` 默认值
- 连通性诊断分别测试 GitHub、CNB、当前 PyPI 镜像和本机 WebConsole
- WebConsole 诊断会检查 `NO_PROXY` 是否覆盖 127.0.0.1/localhost

### 日志与诊断

- Core JSONL 文件日志为主，stdout/stderr 作为初始化和崩溃兜底
- 日志搜索、复制、按等级/来源/模块过滤
- 当前筛选日志可导出，日志目录可直接打开
- JSONL 坏行显示为 `parse_error`
- 多行 event 会拆成多条日志，避免时间戳挤在同一行
- 诊断 zip 导出
- 敏感字段遮蔽
- 诊断包包含状态、设置、系统、端口、uv/Git、GSDesk 兜底日志和 Core JSONL tail
- 诊断页提供故障排查向导，把预检阻断、Core 错误、失败任务和更新检查错误转成中文处理动作

### 更新

- 壳更新检查 GitHub Releases
- v1 不静默替换安装包
- Core 更新支持 `latest/stable/dev` 通道；更新前记录回滚点，源码 dirty 时拒绝更新；失败会尝试回滚旧 commit
- Core 更新和回滚后会同步依赖，避免源码与 venv 不一致

### 环境与修复

- 初始化前显示环境预检：系统、Git、uv、默认端口、目录权限、磁盘、Core 源码、venv、源码源、PyPI 镜像
- 首次安装引导提供“一键安装启动”，成功打开 WebConsole 后持久化 `installGuideCompleted`
- 任务历史记录初始化、启动、停止、修复动作的阶段、耗时和失败原因；支持取消当前运行任务，并重试失败/已取消的可恢复任务
- 修复面板支持安装/修复隔离 uv、重跑 `uv sync`、清理 uv cache、重建 venv、备份后重新 clone Core
- 环境页支持 Core 检查更新、更新 latest/stable/dev、回滚上次更新
- 环境页支持运行时备份，导出脱敏 `settings.redacted.json`、Core data/config/plugins 和日志快照
- 环境页支持恢复最近运行时备份，恢复前自动创建安全备份，并且只恢复白名单目录
- 环境页支持导出/导入非敏感设置，代理账号密码不会默认导出
- 环境页支持 Core 配置编辑器：读取常用 JSON 配置，按字段编辑，敏感字段遮蔽，保存前校验类型并创建备份
- 隔离目录支持复制路径和打开目录，路径打开命令只允许预定义键
- Windows Core 子进程强制使用 UTF-8：`PYTHONUTF8=1`、`PYTHONIOENCODING=utf-8:replace`，并显式移除 `PYTHONLEGACYWINDOWSSTDIO`、关闭颜色输出
- GSDesk 诊断文本日志不持久化普通 stdout/info，旧 `logs/core.log` 中的 emoji/符号会转义为 `\u{...}`，避免 GBK 控制台读取时二次报错
- 工具链预检显示 Git/uv 版本，uv 过旧时给出升级警告

### 安全与发布

- Tauri CSP 已收紧，仅允许 Tauri IPC、localhost WebConsole 和必要网络检测目标
- GitHub Actions 覆盖 Windows/macOS no-bundle 验证
- tag 发布 workflow 生成 Windows NSIS、macOS app/dmg、平台独立的 SHA256SUMS，并上传 Draft Release
- 本地已验证 Windows NSIS 安装包构建链路
- `pnpm smoke:core` 可启动真实 `gsuid_core`、等待 `/app`、验证 JSONL 日志并清理进程

## 暂不进入 v1

- 重写 `gsuid_core` WebConsole
- 完整 NoneBot2 项目创建和适配器配置
- 静默自动更新安装包
- 插件市场重做
- 修改用户全局 Git/pip/uv/Python 配置

## 验收标准

- `pnpm build` 通过
- `cargo test --manifest-path src-tauri\Cargo.toml` 通过
- `pnpm tauri build --no-bundle` 通过
- `pnpm smoke:desktop` 通过，Windows 本地能打开真实桌面壳
- 未初始化时 UI 能明确提示下一步
- 初始化失败时能看到中文错误和原始日志
- 诊断包能生成并遮蔽敏感字段
- 真实 Core JSONL 文件可被增量读取，中文/emoji 日志不因 GBK 编码失败
- 日志页 1000+ 行仍使用虚拟滚动，不全量渲染 DOM
- 发布前 tag workflow 产物必须带平台独立的 SHA256 校验和
