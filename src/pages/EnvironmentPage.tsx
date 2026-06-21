import { Alert, App as AntdApp, Button, Dropdown, Space, Table, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import { DownloadCloud, FolderOpen, MoreHorizontal, RefreshCcw, RotateCcw, Trash2, Wrench } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { gsdeskApi } from "../api";
import { findGsuidCore } from "../serviceIds";
import { displayText } from "../ui/format";
import { WidePanel } from "../ui/pageTabs";
import { PanelHeader, SectionActions } from "../ui/primitives";
import { isBeginnerMode } from "../ui/userMode";
import type { AppState, CoreCommitEntry, CoreUpdateResult, TaskRecord } from "../types";
import { createTaskColumns, preflightColumns } from "./environmentTables";

export type EnvironmentSection = "runtime" | "update" | "data" | "tasks";

interface EnvironmentPageProps {
  section: EnvironmentSection;
  appState: AppState;
  loadingAction?: string;
  onInitRuntime: () => void;
  onBootstrapUv: () => void;
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
  onExportSettings: () => void;
  onImportSettings: () => void;
  onClearAppData: () => void;
  onRefreshState: () => void;
}

export default function EnvironmentPage({
  section,
  appState,
  loadingAction,
  onInitRuntime,
  onBootstrapUv,
  onRepairRuntime,
  onClearOccupiedPort,
  onCoreUpdate,
  onCancelTask,
  onRetryTask,
  onCreateRuntimeBackup,
  onRestoreRuntimeBackup,
  onExportSettings,
  onImportSettings,
  onClearAppData,
  onRefreshState,
}: EnvironmentPageProps) {
  const { message, modal } = AntdApp.useApp();
  const [coreCommits, setCoreCommits] = useState<CoreCommitEntry[]>([]);
  const [commitListState, setCommitListState] = useState<"idle" | "loading" | "loaded">("idle");
  const beginnerMode = isBeginnerMode(appState.settings);
  const core = findGsuidCore(appState.services);
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
    if (section !== "update" || commitListState !== "idle") return;
    const timer = window.setTimeout(() => {
      void refreshCoreCommits(false);
    }, 100);
    return () => window.clearTimeout(timer);
  }, [commitListState, refreshCoreCommits, section]);

  const portForCleanup = appState.settings.preferredCorePort ?? 8765;
  const pathMenuItems = Object.keys(appState.paths).map((key) => ({ key, label: key, icon: <FolderOpen size={14} /> }));
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

  function runBackupSettingsMenu(key: string) {
    if (key === "backup_export") {
      onCreateRuntimeBackup();
      return;
    }
    if (key === "backup_restore") {
      modal.confirm({
        title: "恢复最近运行时备份",
        content: "恢复会替换 Core data/config/plugins 和日志快照。请先停止 Core；恢复前会自动生成一份安全备份。",
        okText: "恢复",
        cancelText: "取消",
        onOk: onRestoreRuntimeBackup,
      });
      return;
    }
    if (key === "settings_export") {
      onExportSettings();
      return;
    }
    if (key === "settings_import") {
      onImportSettings();
    }
  }

  function openManagedPath(key: string) {
    void gsdeskApi.openPath(key).catch((error) => message.error(String(error)));
  }

  function confirmClearAppData() {
    modal.confirm({
      title: "清理所有 GSDesk 本机数据",
      content:
        "这会先停止 Core，然后删除本机 Core 源码、data/config/plugins、venv、uv cache、Python、日志、诊断包、备份和 settings.json。操作不可撤销。",
      okText: "清理所有数据",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: onClearAppData,
    });
  }

  return <section className="page-grid">{renderSection()}</section>;

  function renderSection() {
    if (section === "runtime") {
      if (beginnerMode) {
        return (
          <WidePanel>
            <PanelHeader
              title="一键准备环境"
              description="GSDesk 会自动准备内置 Git、uv、Python、Core 源码和依赖；正常情况下不用改路径、端口或代理"
              actions={
                <Button icon={<RefreshCcw size={16} />} onClick={onRefreshState}>
                  重新检测
                </Button>
              }
            />
            <div className="settings-summary-grid">
              <SummaryItem
                label="源码工具"
                value={appState.toolchain.gitDetected ? "已内置" : "不可用"}
                detail={
                  appState.toolchain.gitDetected ? "无需单独安装 Git" : displayText(appState.toolchain.gitError, "缺少内置 Git")
                }
              />
              <SummaryItem
                label="uv"
                value={appState.toolchain.uvDetected ? "已准备" : "待创建"}
                detail={
                  appState.toolchain.uvDetected ? displayText(appState.toolchain.uvVersion, "可用") : "使用内置 Python 创建"
                }
              />
              <SummaryItem
                label="Python"
                value={appState.toolchain.bundledPythonAvailable ? "已内置" : "不可用"}
                detail={appState.toolchain.bundledPythonAvailable ? "无需安装系统 Python" : "当前构建缺少内置 Python"}
              />
            </div>
            <BeginnerPreflight checks={appState.preflightChecks} />
            <SectionActions>
              {!appState.toolchain.uvDetected && (
                <Button
                  icon={<DownloadCloud size={16} />}
                  loading={loadingAction === "bootstrap_uv"}
                  disabled={!appState.toolchain.uvBootstrapSupported}
                  onClick={onBootstrapUv}
                >
                  安装/更新 uv
                </Button>
              )}
              <Button type="primary" icon={<Wrench size={16} />} loading={loadingAction === "init"} onClick={onInitRuntime}>
                一键准备环境
              </Button>
              <Button
                icon={<RotateCcw size={16} />}
                loading={loadingAction === "repair_sync_deps"}
                onClick={() => onRepairRuntime("sync_deps")}
              >
                重新同步依赖
              </Button>
            </SectionActions>
            <p className="muted-block">端口释放、清理缓存、重建 venv、重新 clone 和自定义路径属于高级模式。</p>
          </WidePanel>
        );
      }

      return (
        <>
          <WidePanel>
            <PanelHeader
              title="环境预检"
              description="初始化前检查系统、工具链、端口、权限、磁盘、Core 源码和 venv"
              actions={
                <Button icon={<RefreshCcw size={16} />} onClick={onRefreshState}>
                  重新检测
                </Button>
              }
            />
            <Table rowKey="id" columns={preflightColumns} dataSource={appState.preflightChecks} pagination={false} size="small" />
          </WidePanel>

          <WidePanel>
            <PanelHeader
              title="运行时修复"
              description={`uv: ${
                appState.toolchain.uvDetected
                  ? `${displayText(appState.toolchain.uvVersion, "可用")} / ${appState.toolchain.uvSource}`
                  : `未安装，目标 ${appState.toolchain.uvBootstrapTarget}`
              }；Git: ${
                appState.toolchain.gitDetected
                  ? `${displayText(appState.toolchain.gitVersion, "可用")} / ${gitSourceText(appState.toolchain.gitSource)}`
                  : displayText(appState.toolchain.gitError, "不可用")
              }；内置 Python 创建/更新: ${appState.toolchain.bundledPythonAvailable ? "可用" : "当前构建未提供"}`}
            />
            <SectionActions>
              <Button
                icon={<DownloadCloud size={16} />}
                loading={loadingAction === "bootstrap_uv"}
                disabled={!appState.toolchain.uvBootstrapSupported}
                onClick={onBootstrapUv}
              >
                安装/更新 uv
              </Button>
              <Button icon={<Wrench size={16} />} loading={loadingAction === "init"} onClick={onInitRuntime}>
                重新初始化
              </Button>
              <Button
                icon={<RotateCcw size={16} />}
                loading={loadingAction === "repair_sync_deps"}
                onClick={() => onRepairRuntime("sync_deps")}
              >
                重跑 uv sync
              </Button>
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
            </SectionActions>
          </WidePanel>
        </>
      );
    }

    if (section === "update") {
      if (beginnerMode) {
        return (
          <WidePanel>
            <PanelHeader
              title="Core 更新"
              description="小白模式只保留检查和更新到推荐版本；版本回滚和指定 commit 在高级模式显示"
            />
            <div className="settings-summary-grid">
              <SummaryItem label="当前 commit" value={displayText(core?.currentCommit, "-")} />
              <SummaryItem label="当前 tag" value={displayText(core?.currentTag, "-")} />
              <SummaryItem label="更新策略" value="latest 推荐版本" detail="更新成功后 Core 会自动重启" />
            </div>
            <Alert
              className="spaced"
              type="info"
              showIcon
              message="回滚是高级操作"
              description="需要选择 commit、清理差异、切 stable/dev 或回滚版本时，在设置页关闭小白模式。"
            />
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

    if (section === "data") {
      if (beginnerMode) {
        return (
          <WidePanel>
            <PanelHeader title="备份与设置" description="小白模式只保留导出备份和设置迁移；清理所有数据属于高级模式" />
            <SectionActions>
              <Button
                icon={<DownloadCloud size={16} />}
                loading={loadingAction === "runtime_backup"}
                onClick={onCreateRuntimeBackup}
              >
                导出备份
              </Button>
              <Button icon={<DownloadCloud size={16} />} loading={loadingAction === "settings_export"} onClick={onExportSettings}>
                导出设置
              </Button>
              <Button icon={<RotateCcw size={16} />} loading={loadingAction === "settings_import"} onClick={onImportSettings}>
                导入最近设置
              </Button>
            </SectionActions>
            <p className="muted-block">恢复运行时备份、打开内部目录、清理全部 AppData 会改变本机数据，只在高级模式显示。</p>
          </WidePanel>
        );
      }

      return (
        <WidePanel>
          <PanelHeader title="数据维护" description="备份、设置迁移、目录打开和本机数据清理" />
          <SectionActions>
            <Dropdown
              trigger={["click"]}
              menu={{
                items: [
                  { key: "backup_export", label: "导出备份快照", icon: <DownloadCloud size={14} /> },
                  { key: "backup_restore", label: "恢复最近备份", icon: <RotateCcw size={14} /> },
                  { key: "settings_export", label: "导出设置", icon: <DownloadCloud size={14} /> },
                  { key: "settings_import", label: "导入最近设置", icon: <RotateCcw size={14} /> },
                ],
                onClick: ({ key }: { key: string }) => runBackupSettingsMenu(key),
              }}
            >
              <Button
                icon={<MoreHorizontal size={16} />}
                loading={["runtime_backup", "runtime_restore", "settings_export", "settings_import"].includes(
                  displayText(loadingAction, ""),
                )}
              >
                备份与设置
              </Button>
            </Dropdown>
            <Dropdown
              trigger={["click"]}
              menu={{
                items: pathMenuItems,
                onClick: ({ key }: { key: string }) => openManagedPath(key),
              }}
            >
              <Button icon={<FolderOpen size={16} />}>打开目录</Button>
            </Dropdown>
            <Button danger icon={<Trash2 size={16} />} loading={loadingAction === "clear_app_data"} onClick={confirmClearAppData}>
              清理所有数据
            </Button>
          </SectionActions>
        </WidePanel>
      );
    }

    return (
      <WidePanel>
        <PanelHeader title="任务历史" description="初始化、启动、停止、修复动作的阶段和耗时" />
        <Table rowKey="id" columns={taskColumns} dataSource={appState.taskHistory} pagination={false} size="small" />
      </WidePanel>
    );
  }
}

function BeginnerPreflight({ checks }: { checks: AppState["preflightChecks"] }) {
  const issues = checks.filter((check) => check.status !== "ok");
  if (!issues.length) {
    return (
      <Alert
        className="spaced"
        type="success"
        showIcon
        message="当前没有阻断问题"
        description="可以直接一键准备环境或启动 Core。"
      />
    );
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
