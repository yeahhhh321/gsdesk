# 隐私说明

GSDesk v1 默认本地优先，不自动上传任何运行数据。

## 默认行为

- 不包含自动上传、匿名统计或行为分析。
- 诊断包只写入本机 `diagnostics` 目录，不自动上传。
- 诊断包写入前会遮蔽 `WS_TOKEN`、`REGISTER_CODE`、常见 token/password/passwd 字段和代理密码。
- Core 运行时、uv、Python、venv、缓存、日志和诊断都保存在 GSDesk 应用数据目录。
- 用户可在“环境与修复”中清理所有本机数据；该动作只删除 GSDesk 应用数据目录，不触碰用户全局 Git、pip、uv 或 Python。

## 会发生的网络请求

网络请求默认由用户动作触发；如果开启“启动时检查壳更新”，GSDesk 启动后会自动访问一次更新元数据：

- 初始化或 Core 更新：访问当前选择的 GitHub/CNB 源。
- PyPI 镜像测速或依赖同步：访问用户选择或测速列表里的 PyPI 镜像。
- Python 运行时：正式安装包从壳内置资源复制，不访问网络下载 Python。
- 壳更新检查和安装：访问 `yeahhhh321/gsdesk` GitHub Release `latest.json` 和对应签名更新包。
- WebConsole：访问本机 `127.0.0.1:<port>/app`。

## 卸载与数据清理

- Windows NSIS 卸载器会删除 GSDesk 的 Roaming/Local 应用数据目录。
- macOS `.app/.dmg` 拖拽删除没有卸载钩子；需要彻底清理时，先在应用内执行“清理所有数据”，再删除 App。
