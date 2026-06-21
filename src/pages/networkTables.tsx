import type { ColumnsType } from "antd/es/table";
import { displayMegabytesPerSecond, displayMilliseconds, displayValue } from "../ui/format";
import { ResultTag } from "../ui/primitives";
import type { MirrorCheckResult, NetworkDiagnosticResult, SourceProbeResult } from "../types";

const resultColumn = <T extends { ok: boolean }>(width = 100) => ({
  title: "状态",
  width,
  render: (_: unknown, row: T) => <ResultTag ok={row.ok} />,
});

const latencyColumn = <T extends { latencyMs?: number }>(width = 100) => ({
  title: "延迟",
  width,
  render: (_: unknown, row: T) => displayMilliseconds(row.latencyMs),
});

const errorColumn = {
  title: "错误",
  dataIndex: "error",
  ellipsis: true,
  render: (value: unknown) => displayValue(value),
};

export const sourceColumns: ColumnsType<SourceProbeResult> = [
  { title: "源", dataIndex: "name", width: 160 },
  { title: "地址", dataIndex: "url", ellipsis: true },
  resultColumn<SourceProbeResult>(),
  latencyColumn<SourceProbeResult>(),
  errorColumn,
];

export const mirrorColumns: ColumnsType<MirrorCheckResult> = [
  { title: "镜像", dataIndex: "name", width: 140 },
  { title: "地址", dataIndex: "url", ellipsis: true },
  resultColumn<MirrorCheckResult>(),
  latencyColumn<MirrorCheckResult>(),
  { title: "速度", width: 120, render: (_: unknown, row: MirrorCheckResult) => displayMegabytesPerSecond(row.speedMbps) },
  errorColumn,
];

export const diagnosticColumns: ColumnsType<NetworkDiagnosticResult> = [
  { title: "目标", dataIndex: "label", width: 150 },
  { title: "地址", dataIndex: "target", ellipsis: true },
  resultColumn<NetworkDiagnosticResult>(),
  latencyColumn<NetworkDiagnosticResult>(),
  errorColumn,
];
