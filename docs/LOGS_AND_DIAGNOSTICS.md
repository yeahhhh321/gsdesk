# 日志与诊断

## 日志来源

GSDesk 的日志模型分为四类来源：

- `core`：优先读取 `gsuid_core/data/logs` 下最新的 `.log` 或 `.jsonl` 文件。
- `stdout`：Core 进程 stdout，用于启动阶段和兜底。
- `stderr`：Core 进程 stderr，用于 Python traceback、依赖错误和崩溃现场。
- `system`：GSDesk 自己记录的初始化、启动、停止和修复动作。

上游 `gsuid_core` 当前常见日志格式：

```json
{"event":"[早柚核心] 插件加载完成! 总耗时: 3.00秒","level":"success","timestamp":"06-19 10:37:47"}
```

GSDesk 会把 `event` 映射为 `message`，把 `level` 映射为 `info/success/warn/error`，把 `[早柚核心]` 这类前缀提取为 `module`。如果 event 内包含多行内容，会拆成多条日志，避免 UI 中出现多个时间戳挤在同一行。

## 兼容规则

- JSONL 文件按文件偏移增量读取，不重复扫描整个文件。
- 文件轮换或缩短时会从新文件开头读取。
- 坏 JSON 行不会拖垮页面，会显示为 `JSONL parse_error`。
- stdout/stderr 会去掉 ANSI 控制符，并拆分 `\r`、`\n` 和连续结构化时间戳。
- Windows 子进程强制注入 UTF-8 与无颜色环境变量，避免中文和图标日志触发 GBK 编码错误。
- Python logging/colorama 产生的 `UnicodeEncodeError: 'gbk' codec can't encode character` 噪声会按整块过滤；GSDesk 启动取状态时会清理旧 `logs/core.log` 中已经落盘的同类污染，诊断包也不会导出这类假错误。
- GSDesk 自身的 `logs/core.log` 是诊断文本，只持久化 system 和 stdout/stderr 的 warn/error；emoji/符号会写成 `\u{...}`，避免用户在 GBK 控制台读取文本日志时二次报错。上游 JSONL 文件仍保留原始 UTF-8 内容，由日志页直接读取展示。
- GSDesk 自身的 `logs/core.log` 达到 8 MB 后会轮转为 `core-<timestamp>.log`，默认保留最近 5 个归档，避免长期运行后诊断包和日志页被旧兜底日志拖慢。

## 前端展示

日志页使用虚拟滚动，默认只渲染可视范围和少量 overscan。支持：

- 按等级过滤
- 按来源过滤
- 按模块过滤
- 搜索 `message/module/raw/line/serviceId`
- 复制可见日志
- 复制当前过滤后的全部日志
- 导出当前筛选结果为文本文件
- 打开 GSDesk 日志目录
- 自动跟随底部
- 清空当前视图

## 诊断包

诊断包输出到 GSDesk 应用数据目录的 `diagnostics` 下，文件名形如：

```text
gsdesk-diagnostics-20260619-120000.zip
```

包含内容：

- `state.json`：当前应用状态、服务状态、环境预检、任务历史。
- `settings.json`：当前设置。
- `system.txt`：诊断 schema、版本、OS、架构、关键路径和应用数据盘剩余空间。
- `privacy.txt`：本机诊断、无自动上传、无遥测的隐私声明。
- `uv.txt`：uv 解析来源、实际路径、版本或错误；解析顺序为隔离目录、打包资源、PATH。
- `git.txt`：Git 版本或错误。
- `ports.txt`：当前 Core 端口占用摘要。
- `network-targets.json`：GitHub、CNB、当前 PyPI 镜像和本机 WebConsole 的连通性诊断。
- `failure-summary.txt`：按预检、服务状态、失败任务和最后错误段生成的中文失败摘要。
- `core.log`：GSDesk 自己持久化的 stdout/stderr/system tail。
- `gsuid-core-jsonl.log`：上游 Core 最新 JSONL/`.log` 文件 tail。

导出前会遮蔽 `WS_TOKEN`、`REGISTER_CODE`、常见 token/password/passwd 字段，以及代理 URL 中的密码。

诊断页还会展示故障排查向导和最近错误摘要。向导不上传数据，只基于当前本地状态生成建议：

- 环境预检阻断项和警告项。
- Core `failed/crashed`、最近错误和 WebConsole 未就绪。
- 最近失败任务的阶段和消息。
- 最近 traceback/错误段和常见错误的中文解释。
- 壳更新检查失败时的网络处理建议。

最近错误摘要会直接读取当前缓存日志，提取最后一个 traceback 或错误段，并识别依赖缺失、端口占用、代理/网络、权限、Git 同步、uv/Python 初始化和 GBK 编码等常见失败。

## 运行时备份

环境页的“导出备份快照”会写入 `runtime/backups/gsdesk-runtime-*.zip`。该快照用于本机迁移和人工排障，包含：

- `settings.redacted.json`：脱敏后的 GSDesk 设置。
- `core-data/`：上游 Core data 目录。
- `core-config/`：上游 Core config 目录。
- `core-plugins/`：上游 Core plugins 目录。
- `logs/`：GSDesk 日志目录。

备份不会打包 venv、uv cache、uv Python 安装目录，也不会直接写入未脱敏的 `settings.json`。

“恢复最近备份”只恢复 `core-data/`、`core-config/`、`core-plugins/` 和 `logs/` 白名单目录。恢复前会创建一次新的安全备份；Core 正在运行或检测到遗留进程时会拒绝恢复。

“设置迁移”只导出源码源、PyPI 镜像、固定端口、退出策略、更新策略、语言和 `NO_PROXY` 等非敏感字段。导入时不会覆盖代理账号密码。
