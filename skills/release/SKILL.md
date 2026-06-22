# GSDesk Release Skill

## 目标

用于 GSDesk 发版前检查。发布必须证明构建、配置、安全边界和产物完整。

## 流程

1. 确认 worktree clean。
2. 执行格式、lint、前端构建、Rust 测试。
3. 执行安全和 bundle 配置脚本。
4. 执行 `pnpm tauri build --no-bundle`。
5. 在 clean checkout 语义下执行 `pnpm prepare:runtime-assets`；该脚本必须能从构建机 `uv` 自举 CPython 资源，不能依赖 Git 已跟踪的 Python 目录。
6. 生成平台安装包后执行 release asset 校验。
7. GitHub Actions 只能先写 draft release；所有平台构建和 checksum artifact 完成后，由 `publish` job 统一转为正式 Release。

## 命令

```powershell
pnpm precommit
pnpm verify:security
pnpm verify:bundle-config
pnpm tauri build --no-bundle
pnpm prepare:runtime-assets
pnpm verify:release-assets -- --dir release-assets --platform windows --write
```

## 发布说明必须包含

- 版本号和 commit。
- Windows/macOS 产物名和 SHA256。
- 已知限制。
- JSONL 日志和诊断包位置。
