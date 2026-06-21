import type { PreflightCheck, ServiceStatus, TaskRecord } from "../types";

export const statusText: Record<ServiceStatus, string> = {
  uninitialized: "未初始化",
  checking: "检测中",
  initializing: "初始化中",
  starting: "启动中",
  running: "运行中",
  stopping: "停止中",
  stopped: "已停止",
  failed: "失败",
};

export const statusColor: Record<ServiceStatus, string> = {
  uninitialized: "default",
  checking: "processing",
  initializing: "processing",
  starting: "processing",
  running: "success",
  stopping: "warning",
  stopped: "default",
  failed: "error",
};

export function isFailedServiceStatus(status: ServiceStatus | null | undefined) {
  return status === "failed";
}

export const preflightStatusText: Record<PreflightCheck["status"], string> = {
  ok: "通过",
  block: "阻断",
  warn: "警告",
};

export const preflightStatusColor: Record<PreflightCheck["status"], string> = {
  ok: "success",
  block: "error",
  warn: "warning",
};

export const taskStatusText: Record<TaskRecord["status"], string> = {
  running: "执行中",
  success: "成功",
  failed: "失败",
  cancelled: "已取消",
};

export const taskStatusColor: Record<TaskRecord["status"], string> = {
  running: "processing",
  success: "success",
  failed: "error",
  cancelled: "default",
};
