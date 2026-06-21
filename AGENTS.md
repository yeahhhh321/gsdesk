# GSDesk Agent Guide

## 工作原则

- 先读当前 worktree，再下结论；README 和计划只能作为线索。
- 变更要克制，优先删掉重复逻辑和隐式 fallback，再新增抽象。
- 注释使用中文；只解释边界、协议和不直观约束，避免写空泛 why 注释。
- 不用宽泛 `any`、`as any`、`@ts-ignore`。需要跨边界数据时先定义类型或解析函数。
- 少用 `||` 串 fallback。业务默认值要用显式分支、类型守卫或命名函数表达。
- Rust 不在业务路径里 `unwrap`/`expect`；测试里允许。
- 用户可见错误必须是中文，且保留原始错误关键内容。

## 必跑命令

```powershell
pnpm format:check
pnpm lint
pnpm build
cargo test --manifest-path src-tauri\Cargo.toml
```

发布前再跑：

```powershell
pnpm verify:security
pnpm verify:bundle-config
pnpm tauri build --no-bundle
```

## 代码边界

- 前端页面只做编排；表格列、故障规则、mock 数据和纯计算逻辑应拆到独立模块。
- Rust 命令层只做参数装配和返回值转换；进程、日志、备份、更新、诊断应在各自模块里。
- JSONL 是 Core 日志主数据源；stdout/stderr 只用于初始化任务和兜底现场。
- GSDesk 不修改用户全局 Git、pip、uv 或 Python 配置。

## UI/UE

- 桌面工具优先清晰和可扫描，不做营销式 hero。
- 每个页面只突出一个主任务，危险操作要弱化或确认。
- 图标优先用 lucide-react；按钮文字要短，命令型动作要明确。
- 中文文案保持动作导向：说明问题、下一步、结果。
