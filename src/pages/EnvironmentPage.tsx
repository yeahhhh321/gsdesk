import { Alert, App as AntdApp, Button, Dropdown, Space, Table, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import { AlertTriangle, CheckCircle2, DownloadCloud, MoreHorizontal, RefreshCcw, RotateCcw, Trash2, Wrench } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { gsdeskApi } from "../api";
import { findGsuidCore } from "../serviceIds";
import { displayText } from "../ui/format";
import { WidePanel } from "../ui/pageTabs";
import { PanelHeader, SectionActions } from "../ui/primitives";
import { isBeginnerMode } from "../ui/userMode";
import type { AppState, CoreCommitEntry, CoreUpdateResult, TaskRecord } from "../types";
import type { LogEntry, UpdateInfo } from "../types";
import { buildLogFailureSummary, buildTroubleshootingItems, severityColor, severityLabel } from "./diagnosticsRules";
import { createTaskColumns, preflightColumns } from "./environmentTables";

export type EnvironmentSection = "workbench" | "core" | "tasks";

interface EnvironmentPageProps {
  section: EnvironmentSection;
  appState: AppState;
  logs: LogEntry[];
  updateInfo?: UpdateInfo;
  loadingAction?: string;
  onInitRuntime: () => void;
  onBootstrapUv: () => void;
  onInstallPlaywright: () => void;
  onRepairRuntime: (action: "sync_deps" | "rebuild_venv" | "reclone_core" | "clear_uv_cache") => void;
  onClearOccupiedPort: () => void;
  onCoreUpdate: (
    action: "check" | "clean" | "list_commits" | "update" | "rollback",
    channel?: "stable" | "latest" | "dev",
    targetCommit?: string,
  ) => Promise<CoreUpdateResult | undefined>;
  onCancelTask: () => void;
  onRetryTask: (task: TaskRecord) => void;
  onCreateRuntimeBackup: () => void;
  onRestoreRuntimeBackup: () => void;
  onClearAppData: () => void;
  onRefreshState: () => void;
}

export default function EnvironmentPage({
  section,
  appState,
  logs,
  updateInfo,
  loadingAction,
  onInitRuntime,
  onBootstrapUv,
  onInstallPlaywright,
  onRepairRuntime,
  onClearOccupiedPort,
  onCoreUpdate,
  onCancelTask,
  onRetryTask,
  onCreateRuntimeBackup,
  onRestoreRuntimeBackup,
  onClearAppData,
  onRefreshState,
}: EnvironmentPageProps) {
  const { message, modal } = AntdApp.useApp();
  const [coreCommits, setCoreCommits] = useState<CoreCommitEntry[]>([]);
  const [commitListState, setCommitListState] = useState<"idle" | "loading" | "loaded">("idle");
  const beginnerMode = isBeginnerMode(appState.settings);
  const core = findGsuidCore(appState.services);
  const troubleshootingItems = buildTroubleshootingItems(appState, updateInfo);
  const logFailureSummary = buildLogFailureSummary(logs);
  const taskColumns = useMemo(
    () => createTaskColumns({ loadingAction, onCancelTask, onRetryTask }),
    [loadingAction, onCancelTask, onRetryTask],
  );
  const commitColumns = useMemo<ColumnsType<CoreCommitEntry>>(
    () => [
      {
        title: "Commit",
        width: 160,
        render: (_, commit) => (
          <Space size={4} wrap>
            <code>{commit.shortCommit}</code>
            {commit.isCurrent && <Tag color="blue">当前</Tag>}
            {commit.isRollback && <Tag color="gold">回滚点</Tag>}
          </Space>
        ),
      },
      { title: "提交说明", dataIndex: "subject", ellipsis: true },
      { title: "作者", dataIndex: "author", width: 120, ellipsis: true },
      {
        title: "时间",
        dataIndex: "committedAt",
        width: 190,
        render: (value: string) => value.replace("T", " ").replace("Z", " UTC"),
      },
      {
        title: "操作",
        width: 96,
        render: (_, commit) => (
          <Button
            size="small"
            danger
            disabled={commit.isCurrent}
            loading={loadingAction === "core_rollback"}
            onClick={() => confirmRollbackCommit(commit)}
          >
            回滚
          </Button>
        ),
      },
    ],
    [loadingAction],
  );

  const refreshCoreCommits = useCallback(
    async (showEmptyWarning = true) => {
      setCommitListState("loading");
      const result = await gsdeskApi.coreUpdate("list_commits", "latest");
      const commits = result.commits;
      setCoreCommits(commits);
      setCommitListState("loaded");
      if (showEmptyWarning && !commits.length) {
        message.warning("没有可选择的 Core commit");
      }
    },
    [message],
  );

  useEffect(() => {
    if (section !== "core" || commitListState !== "idle") return;
    const timer = window.setTimeout(() => {
      void refreshCoreCommits(false);
    }, 100);
    return () => window.clearTimeout(timer);
  }, [commitListState, refreshCoreCommits, section]);

  const portForCleanup = appState.settings.preferredCorePort ?? 8765;
  const advancedRepairLoading = loadingAction
    ? ["repair_clear_uv_cache", "clear_port", "repair_rebuild_venv", "repair_reclone_core"].includes(loadingAction)
    : false;

  function confirmRollbackCommit(commit: CoreCommitEntry) {
    modal.confirm({
      title: "回滚 Core 到该 commit",
      content: `${commit.shortCommit} · ${commit.subject}`,
      okText: "回滚",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        const result = await onCoreUpdate("rollback", "latest", commit.commit);
        if (result) await refreshCoreCommits(false);
      },
    });
  }

  function runAdvancedRepair(key: string) {
    if (key === "clear_uv_cache") {
      onRepairRuntime("clear_uv_cache");
      return;
    }
    if (key === "rebuild_venv") {
      onRepairRuntime("rebuild_venv");
      return;
    }
    if (key === "clear_port") {
      modal.confirm({
        title: `强杀端口 ${portForCleanup} 占用`,
        content: "GSDesk 会查找监听该端口的进程并强制结束，然后复检端口是否释放。请确认该端口不是其他重要服务正在使用。",
        okText: "强杀释放",
        okButtonProps: { danger: true },
        cancelText: "取消",
        onOk: onClearOccupiedPort,
      });
      return;
    }
    if (key === "reclone_core") {
      modal.confirm({
        title: "重新 clone Core",
        content: "这会按运行时修复流程处理 Core 源码目录。已有本地数据时，请先导出运行时备份。",
        okText: "重新 clone",
        okButtonProps: { danger: true },
        cancelText: "取消",
        onOk: () => onRepairRuntime("reclone_core"),
      });
    }
  }

  function runCoreUpdateMenu(key: string) {
    if (key === "clean") {
      void onCoreUpdate("clean", "latest");
      return;
    }
    if (key === "stable") {
      void onCoreUpdate("update", "stable");
      return;
    }
    if (key === "dev") {
      void onCoreUpdate("update", "dev");
    }
  }

  function confirmClearAppData() {
    modal.confirm({
      title: "清理所有 GSDesk 本机数据",
      content:
        "这会先停止 Core，然后删除本机 Core 源码、data/config/plugins、venv、uv cache、Python、日志、旧诊断包、备份和 settings.json。操作不可撤销。",
      okText: "清理所有数据",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: onClearAppData,
    });
  }

  function confirmRestoreRuntimeBackup() {
    modal.confirm({
      title: "恢复最近运行时备份",
      content: "恢复会替换 Core data/config/plugins 和日志快照。请先停止 Core；恢复前会自动生成一份安全备份。",
      okText: "恢复",
      cancelText: "取消",
      onOk: onRestoreRuntimeBackup,
    });
  }

  return <section className="page-grid">{renderSection()}</section>;

  function renderSection() {
    if (section === "core") {
      return (
        <>
          {renderCoreUpdatePanel()}
          {renderRuntimeDataPanel()}
        </>
      );
    }
    if (section === "tasks") return renderTaskPanel();

    return (
      <>
        {renderPreflightPanel()}
        {renderRepairPanel()}
        {renderFailurePanel()}
      </>
    );
  }

  function renderPreflightPanel() {
    return (
      <WidePanel>
        <PanelHeader
          title="环境检测"
          description="系统、工具链、端口、权限、磁盘和运行时阻断项"
          actions={
            <Button icon={<RefreshCcw size={16} />} onClick={onRefreshState}>
              重新检测
            </Button>
          }
        />
        {beginnerMode ? (
          <BeginnerPreflight checks={appState.preflightChecks} />
        ) : (
          <Table rowKey="id" columns={preflightColumns} dataSource={appState.preflightChecks} pagination={false} size="small" />
        )}
      </WidePanel>
    );
  }

  function renderRepairPanel() {
    return (
      <WidePanel>
        <PanelHeader
          title="运行时修复"
          description={`uv ${
            appState.toolchain.uvDetected
              ? displayText(appState.toolchain.uvVersion, "可用")
              : `未安装，目标 ${appState.toolchain.uvBootstrapTarget}`
          } / Git ${
            appState.toolchain.gitDetected
              ? gitSourceText(appState.toolchain.gitSource)
              : displayText(appState.toolchain.gitError, "不可用")
          } / Python ${appState.toolchain.bundledPythonAvailable ? "可用" : "不可用"}`}
        />
        <div className="settings-summary-grid">
          <SummaryItem
            label="源码工具"
            value={appState.toolchain.gitDetected ? "可用" : "不可用"}
            detail={
              appState.toolchain.gitDetected
                ? gitSourceText(appState.toolchain.gitSource)
                : displayText(appState.toolchain.gitError)
            }
          />
          <SummaryItem
            label="uv"
            value={appState.toolchain.uvDetected ? "可用" : "待创建"}
            detail={
              appState.toolchain.uvDetected ? displayText(appState.toolchain.uvVersion) : appState.toolchain.uvBootstrapTarget
            }
          />
          <SummaryItem label="内置 Python" value={appState.toolchain.bundledPythonAvailable ? "可用" : "不可用"} />
          <SummaryItem
            label="Playwright"
            value={appState.toolchain.playwrightDetected ? "已安装" : "待安装"}
            detail={
              appState.toolchain.playwrightDetected
                ? appState.toolchain.playwrightBrowsersPath
                : displayText(appState.toolchain.playwrightError, appState.toolchain.playwrightBrowsersPath)
            }
          />
        </div>
        <SectionActions>
          {(!beginnerMode || !appState.toolchain.uvDetected) && (
            <Button
              icon={<DownloadCloud size={16} />}
              loading={loadingAction === "bootstrap_uv"}
              disabled={!appState.toolchain.uvBootstrapSupported}
              onClick={onBootstrapUv}
            >
              安装/更新 uv
            </Button>
          )}
          <Button
            icon={<DownloadCloud size={16} />}
            loading={loadingAction === "install_playwright"}
            disabled={!appState.toolchain.uvDetected}
            onClick={onInstallPlaywright}
          >
            安装 Playwright
          </Button>
          <Button type="primary" icon={<Wrench size={16} />} loading={loadingAction === "init"} onClick={onInitRuntime}>
            {beginnerMode ? "一键准备环境" : "重新初始化"}
          </Button>
          <Button
            icon={<RotateCcw size={16} />}
            loading={loadingAction === "repair_sync_deps"}
            onClick={() => onRepairRuntime("sync_deps")}
          >
            同步依赖
          </Button>
          {!beginnerMode && (
            <Dropdown
              trigger={["click"]}
              menu={{
                items: [
                  { key: "clear_uv_cache", label: "清理 uv cache", icon: <Trash2 size={14} /> },
                  { key: "rebuild_venv", label: "重建 venv", icon: <RotateCcw size={14} /> },
                  {
                    key: "clear_port",
                    label: `强杀端口 ${portForCleanup} 占用`,
                    icon: <Trash2 size={14} />,
                    danger: true,
                  },
                  { key: "reclone_core", label: "重新 clone Core", icon: <RotateCcw size={14} />, danger: true },
                ],
                onClick: ({ key }: { key: string }) => runAdvancedRepair(key),
              }}
            >
              <Button icon={<MoreHorizontal size={16} />} loading={advancedRepairLoading}>
                高级修复
              </Button>
            </Dropdown>
          )}
        </SectionActions>
      </WidePanel>
    );
  }

  function renderFailurePanel() {
    return (
      <WidePanel>
        <PanelHeader title="故障摘要" description="当前建议和最近错误段" />
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
    );
  }

  function renderTaskPanel() {
    return (
      <WidePanel>
        <PanelHeader title="操作记录" description="初始化、启动、停止、修复和更新动作的阶段和耗时" />
        <Table rowKey="id" columns={taskColumns} dataSource={appState.taskHistory} pagination={false} size="small" />
      </WidePanel>
    );
  }

  function renderCoreUpdatePanel() {
    if (beginnerMode) {
      return (
        <WidePanel>
          <PanelHeader title="Core 更新" description="小白模式只保留检查和更新到推荐版本；版本回滚和指定 commit 在高级模式显示" />
          <div className="settings-summary-grid">
            <SummaryItem label="当前 commit" value={displayText(core?.currentCommit, "-")} />
            <SummaryItem label="当前 tag" value={displayText(core?.currentTag, "-")} />
            <SummaryItem label="更新策略" value="latest 推荐版本" detail="更新成功后 Core 会自动重启" />
          </div>
          <SectionActions>
            <Button
              icon={<RefreshCcw size={16} />}
              loading={loadingAction === "core_check"}
              onClick={() => onCoreUpdate("check", "latest")}
            >
              检查更新
            </Button>
            <Button
              type="primary"
              icon={<RotateCcw size={16} />}
              loading={loadingAction === "core_update"}
              onClick={() => onCoreUpdate("update", "latest")}
            >
              更新 Core
            </Button>
          </SectionActions>
        </WidePanel>
      );
    }

    return (
      <WidePanel>
        <PanelHeader
          title="Core 更新与回滚"
          description="更新前记录回滚点；仅自动清理 uv.lock 这类更新噪音；Core 运行中会先停止并在成功后自动重启"
        />
        <SectionActions>
          <Button
            icon={<RefreshCcw size={16} />}
            loading={loadingAction === "core_check"}
            onClick={() => onCoreUpdate("check", "latest")}
          >
            检查 latest
          </Button>
          <Button
            type="primary"
            icon={<RotateCcw size={16} />}
            loading={loadingAction === "core_update"}
            onClick={() => onCoreUpdate("update", "latest")}
          >
            更新 latest
          </Button>
          <Button
            icon={<RefreshCcw size={16} />}
            loading={loadingAction === "core_list_commits" || commitListState === "loading"}
            onClick={() => refreshCoreCommits()}
          >
            刷新 commit 列表
          </Button>
          <Dropdown
            trigger={["click"]}
            menu={{
              items: [
                { key: "clean", label: "清理更新差异", icon: <Trash2 size={14} /> },
                { key: "stable", label: "切到 stable", icon: <RotateCcw size={14} /> },
                { key: "dev", label: "更新 dev", icon: <RotateCcw size={14} /> },
              ],
              onClick: ({ key }: { key: string }) => runCoreUpdateMenu(key),
            }}
          >
            <Button
              icon={<MoreHorizontal size={16} />}
              loading={["core_clean", "core_update"].includes(displayText(loadingAction, ""))}
            >
              更多更新操作
            </Button>
          </Dropdown>
        </SectionActions>
        <Table
          rowKey="commit"
          columns={commitColumns}
          dataSource={coreCommits}
          pagination={false}
          size="small"
          loading={commitListState === "loading" || loadingAction === "core_list_commits"}
          scroll={{ y: 360 }}
        />
      </WidePanel>
    );
  }

  function renderRuntimeDataPanel() {
    if (beginnerMode) {
      return (
        <WidePanel>
          <PanelHeader title="运行时备份" description="导出当前 Core 数据、配置和日志快照" />
          <SectionActions>
            <Button
              icon={<DownloadCloud size={16} />}
              loading={loadingAction === "runtime_backup"}
              onClick={onCreateRuntimeBackup}
            >
              导出备份
            </Button>
          </SectionActions>
        </WidePanel>
      );
    }

    return (
      <WidePanel>
        <PanelHeader title="运行时备份" description="导出、恢复或清理 GSDesk 运行时数据" />
        <SectionActions>
          <Button icon={<DownloadCloud size={16} />} loading={loadingAction === "runtime_backup"} onClick={onCreateRuntimeBackup}>
            导出备份
          </Button>
          <Button
            icon={<RotateCcw size={16} />}
            loading={loadingAction === "runtime_restore"}
            onClick={confirmRestoreRuntimeBackup}
          >
            恢复备份
          </Button>
          <Button danger icon={<Trash2 size={16} />} loading={loadingAction === "clear_app_data"} onClick={confirmClearAppData}>
            清理所有数据
          </Button>
        </SectionActions>
      </WidePanel>
    );
  }
}

function BeginnerPreflight({ checks }: { checks: AppState["preflightChecks"] }) {
  const issues = checks.filter((check) => check.status !== "ok");
  if (!issues.length) {
    return <p className="muted-block">当前没有阻断或警告。</p>;
  }

  return (
    <div className="overview-check-list spaced">
      {issues.map((check) => (
        <div className={`overview-check-item ${check.status}`} key={check.id}>
          <div>
            <strong>{check.label}</strong>
            <p>{check.detail}</p>
            {check.action && <small>{check.action}</small>}
          </div>
          <Tag color={check.status === "block" ? "error" : "warning"}>{check.status === "block" ? "需要处理" : "可继续"}</Tag>
        </div>
      ))}
    </div>
  );
}

function SummaryItem({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="settings-summary-item">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  );
}

function gitSourceText(value?: string) {
  if (value === "bundle") return "内置";
  if (value === "runtime") return "运行时";
  if (value === "system") return "系统";
  if (value === "missing") return "缺失";
  return displayText(value, "未知");
}
