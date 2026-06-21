# Rust Tauri Skill

## 目标

用于 GSDesk Rust/Tauri 改动。要求错误中文化、模块职责明确、子进程和文件操作可恢复。

## 规则

- 业务路径返回 `Result<T, String>` 或更具体错误，不在运行时路径 `unwrap`。
- 子进程命令必须有超时、工作目录、环境变量边界和日志记录。
- 路径操作只能落在允许的 app data/runtime 目录内。
- JSONL 日志读取要容忍坏行、半行和文件轮转。
- 注释用中文，只写协议、边界和安全约束。

## 验证

```powershell
cargo fmt --manifest-path src-tauri\Cargo.toml --check
cargo clippy --manifest-path src-tauri\Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri\Cargo.toml
```
