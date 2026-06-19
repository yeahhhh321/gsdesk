# 隐私与遥测

GSDesk v1 默认本地优先，不自动上传任何运行数据。

## 默认行为

- 不包含崩溃上报、匿名统计、行为分析或远程遥测。
- 诊断包只写入本机 `diagnostics` 目录，不自动上传。
- 诊断包写入前会遮蔽 `WS_TOKEN`、`REGISTER_CODE`、常见 token/password/passwd 字段和代理密码。
- Core 运行时、uv、Python、venv、缓存、日志和诊断都保存在 GSDesk 应用数据目录。

## 会发生的网络请求

网络请求只在用户触发对应动作时发生：

- 初始化或 Core 更新：访问当前选择的 GitHub/CNB 源。
- PyPI 镜像测速或依赖同步：访问用户选择或测速列表里的 PyPI 镜像。
- 壳更新检查：访问 `yeahhhh321/gsdesk` GitHub Releases。
- WebConsole：访问本机 `127.0.0.1:<port>/app`。

## 后续约束

如果后续加入崩溃上报或匿名统计，必须先满足：

- 默认关闭。
- UI 中提供明确开关。
- 明确列出上传字段。
- 支持随时关闭。
- 不能把诊断包、Core 配置、代理凭据或 token 自动上传。
