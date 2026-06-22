import { Alert, App as AntdApp, Button, Tag } from "antd";
import { AlertTriangle, CheckCircle2, FileArchive, Wrench } from "lucide-react";
import { WidePanel } from "../ui/pageTabs";
import { PanelHeader, SectionActions } from "../ui/primitives";
import { buildLogFailureSummary, buildTroubleshootingItems, severityColor, severityLabel } from "./diagnosticsRules";
import type { AppState, LogEntry, UpdateInfo } from "../types";

export type DiagnosticsSection = "export" | "failures";

interface DiagnosticsPageProps {
  section: DiagnosticsSection;
  appState: AppState;
  logs: LogEntry[];
  updateInfo?: UpdateInfo;
  loadingAction?: string;
  onExportDiagnostics: () => Promise<string | undefined>;
}

export default function DiagnosticsPage({
  section,
  appState,
  logs,
  updateInfo,
  loadingAction,
  onExportDiagnostics,
}: DiagnosticsPageProps) {
  const { modal } = AntdApp.useApp();
  const troubleshootingItems = buildTroubleshootingItems(appState, updateInfo);
  const logFailureSummary = buildLogFailureSummary(logs);

  if (section === "export") {
    return (
      <section className="page-grid">
        <WidePanel>
          <PanelHeader title="诊断导出" description="生成本机诊断包，敏感字段会遮蔽" />
          <p className="muted-block">
            诊断包只保存在本机 diagnostics 目录；版本、系统、路径、端口、网络摘要和最近日志会写入包内，敏感字段会遮蔽。
          </p>
          <SectionActions>
            <Button
              type="primary"
              icon={<FileArchive size={16} />}
              loading={loadingAction === "diagnostics"}
              onClick={async () => {
                const path = await onExportDiagnostics();
                if (path) modal.info({ title: "诊断包路径", content: path });
              }}
            >
              导出诊断包
            </Button>
          </SectionActions>
        </WidePanel>
      </section>
    );
  }

  return (
    <section className="page-grid">
      <WidePanel>
        <PanelHeader title="故障摘要" description="先看当前建议，再看最近错误段" />
        <div className="troubleshooting-list">
          {troubleshootingItems.map((item) => (
            <div className="troubleshooting-item" key={item.key}>
              <div className={`troubleshooting-icon ${item.severity}`}>
                {item.severity === "ok" ? (
                  <CheckCircle2 size={18} />
                ) : item.severity === "block" ? (
                  <AlertTriangle size={18} />
                ) : (
                  <Wrench size={18} />
                )}
              </div>
              <div>
                <div className="troubleshooting-title">
                  <span>{item.title}</span>
                  <Tag color={severityColor(item.severity)}>{severityLabel(item.severity)}</Tag>
                </div>
                <p>{item.detail}</p>
                {item.action && <strong>{item.action}</strong>}
              </div>
            </div>
          ))}
        </div>

        {logFailureSummary ? (
          <div className="failure-summary compact-failure-summary">
            <Alert type="warning" showIcon title={logFailureSummary.title} description={logFailureSummary.explanation} />
            <div className="failure-context" data-testid="failure-context">
              {logFailureSummary.context.map((line, index) => (
                <code key={`${index}-${line}`}>{line}</code>
              ))}
            </div>
          </div>
        ) : (
          <Alert
            className="spaced"
            type="success"
            showIcon
            title="未发现最近错误段"
            description="当前缓存日志里没有 traceback、异常、失败任务输出或错误级别日志。"
          />
        )}
      </WidePanel>
    </section>
  );
}
