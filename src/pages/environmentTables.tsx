import { Button } from "antd";
import type { ColumnsType } from "antd/es/table";
import { CircleStop, RefreshCcw } from "lucide-react";
import { displaySecondsFromMilliseconds, displayValue } from "../ui/format";
import { PreflightStatusTag, TaskStatusTag } from "../ui/statusTags";
import type { PreflightCheck, TaskRecord } from "../types";
import { isRetryableTask } from "./environmentLogic";

interface TaskColumnActions {
  loadingAction?: string;
  onCancelTask: () => void;
  onRetryTask: (task: TaskRecord) => void;
}

export const preflightColumns: ColumnsType<PreflightCheck> = [
  { title: "检查项", dataIndex: "label", width: 140 },
  {
    title: "状态",
    width: 90,
    render: (_, row) => <PreflightStatusTag status={row.status} />,
  },
  { title: "详情", dataIndex: "detail", ellipsis: true },
  { title: "建议", dataIndex: "action", ellipsis: true, render: (value) => displayValue(value) },
];

export function createTaskColumns({ loadingAction, onCancelTask, onRetryTask }: TaskColumnActions): ColumnsType<TaskRecord> {
  return [
    { title: "任务", dataIndex: "name", width: 130 },
    { title: "状态", width: 90, render: (_, row) => <TaskStatusTag status={row.status} /> },
    { title: "阶段", dataIndex: "stage", width: 120 },
    { title: "说明", dataIndex: "message", ellipsis: true },
    { title: "耗时", width: 90, render: (_, row) => displaySecondsFromMilliseconds(row.elapsedMs) },
    {
      title: "操作",
      width: 120,
      render: (_, row) => {
        if (row.status === "running") {
          return (
            <Button
              size="small"
              danger
              icon={<CircleStop size={13} />}
              loading={loadingAction === "cancel_task"}
              onClick={onCancelTask}
            >
              取消
            </Button>
          );
        }
        if ((row.status === "failed" || row.status === "cancelled") && isRetryableTask(row)) {
          return (
            <Button size="small" icon={<RefreshCcw size={13} />} onClick={() => onRetryTask(row)}>
              重试
            </Button>
          );
        }
        return "-";
      },
    },
  ];
}
