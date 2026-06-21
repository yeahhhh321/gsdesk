import { Tag } from "antd";
import type { PreflightCheck, ServiceStatus, TaskRecord } from "../types";
import { preflightStatusColor, preflightStatusText, statusColor, statusText, taskStatusColor, taskStatusText } from "./status";

export function StatusTag({ status }: { status: ServiceStatus }) {
  return <Tag color={statusColor[status]}>{statusText[status]}</Tag>;
}

export function PreflightStatusTag({ status }: { status: PreflightCheck["status"] }) {
  return <Tag color={preflightStatusColor[status]}>{preflightStatusText[status]}</Tag>;
}

export function TaskStatusTag({ status }: { status: TaskRecord["status"] }) {
  return <Tag color={taskStatusColor[status]}>{taskStatusText[status]}</Tag>;
}
