import type { TaskRecord } from "../types";

const RETRYABLE_REPAIR_STAGES = new Set(["sync_deps", "rebuild_venv", "reclone_core", "clear_uv_cache"]);

export function isRetryableTask(task: TaskRecord) {
  if (task.name === "初始化运行时" || task.name === "安装 uv" || task.name === "启动 Core") return true;
  if (task.name === "Core 更新") return true;
  if (task.name === "运行时修复") return RETRYABLE_REPAIR_STAGES.has(task.stage);
  return false;
}
