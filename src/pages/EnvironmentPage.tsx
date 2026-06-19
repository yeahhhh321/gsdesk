import { Alert, Button, Input, InputNumber, Modal, Select, Switch, Table, Tag, Tooltip, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import { CircleStop, Copy, DownloadCloud, ExternalLink, FolderOpen, RefreshCcw, RotateCcw, Save, Trash2, Wrench } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { gsdeskApi } from "../api";
import { PanelHeader, SectionActions } from "../ui/primitives";
import type { AppState, CoreConfigEntry, CoreConfigFileContent, CoreConfigFileSummary, PreflightCheck, TaskRecord } from "../types";

const { Text } = Typography;
const { TextArea } = Input;

interface EnvironmentPageProps {
  appState: AppState;
  loadingAction?: string;
  onInitRuntime: () => void;
  onBootstrapUv: () => void;
  onRepairRuntime: (action: "sync_deps" | "rebuild_venv" | "reclone_core" | "clear_uv_cache") => void;
  onCoreUpdate: (action: "check" | "update" | "rollback", channel?: "stable" | "latest" | "dev") => void;
  onCancelTask: () => void;
  onRetryTask: (task: TaskRecord) => void;
  onCreateRuntimeBackup: () => void;
  onRestoreRuntimeBackup: () => void;
  onExportSettings: () => void;
  onImportSettings: () => void;
  onRefreshState: () => void;
}

export default function EnvironmentPage({
  appState,
  loadingAction,
  onInitRuntime,
  onBootstrapUv,
  onRepairRuntime,
  onCoreUpdate,
  onCancelTask,
  onRetryTask,
  onCreateRuntimeBackup,
  onRestoreRuntimeBackup,
  onExportSettings,
  onImportSettings,
  onRefreshState,
}: EnvironmentPageProps) {
  const [configFiles, setConfigFiles] = useState<CoreConfigFileSummary[]>([]);
  const [selectedConfig, setSelectedConfig] = useState<string>();
  const [configContent, setConfigContent] = useState<CoreConfigFileContent>();
  const [configDraft, setConfigDraft] = useState<Record<string, unknown>>({});
  const [complexDraftText, setComplexDraftText] = useState<Record<string, string>>({});
  const [configErrors, setConfigErrors] = useState<Record<string, string>>({});
  const [configLoading, setConfigLoading] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);

  const preflightColumns = useMemo<ColumnsType<PreflightCheck>>(
    () => [
      { title: "检查项", dataIndex: "label", width: 140 },
      {
        title: "状态",
        width: 90,
        render: (_, row) => <PreflightTag status={row.status} />,
      },
      { title: "详情", dataIndex: "detail", ellipsis: true },
      { title: "建议", dataIndex: "action", ellipsis: true, render: (value) => value || "-" },
    ],
    [],
  );

  const taskColumns = useMemo<ColumnsType<TaskRecord>>(
    () => [
      { title: "任务", dataIndex: "name", width: 130 },
      { title: "状态", width: 90, render: (_, row) => <TaskTag status={row.status} /> },
      { title: "阶段", dataIndex: "stage", width: 120 },
      { title: "说明", dataIndex: "message", ellipsis: true },
      { title: "耗时", width: 90, render: (_, row) => (row.elapsedMs ? `${Math.round(row.elapsedMs / 1000)}s` : "-") },
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
    ],
    [loadingAction, onCancelTask, onRetryTask],
  );

  const configColumns = useMemo<ColumnsType<CoreConfigEntry>>(
    () => [
      {
        title: "配置项",
        width: 230,
        render: (_, row) => (
          <div className="config-key-cell">
            <strong>{row.title || row.key}</strong>
            <code>{row.key}</code>
          </div>
        ),
      },
      {
        title: "说明",
        dataIndex: "description",
        ellipsis: true,
        render: (value) => value || "-",
      },
      {
        title: "类型",
        width: 110,
        render: (_, row) => (
          <span className="config-type-cell">
            <Tag>{row.valueType}</Tag>
            {row.secret ? <Tag color="warning">敏感</Tag> : null}
          </span>
        ),
      },
      {
        title: "值",
        width: 360,
        render: (_, row) => renderConfigEditor(row),
      },
    ],
    [complexDraftText, configDraft, configErrors],
  );

  const selectedConfigSummary = configFiles.find((file) => file.relativePath === selectedConfig);
  const changedConfigEntries = useMemo(() => {
    if (!configContent) return [];
    return configContent.entries.filter((entry) => {
      if (!entry.editable || !(entry.key in configDraft)) return false;
      return JSON.stringify(configDraft[entry.key]) !== JSON.stringify(entry.value);
    });
  }, [configContent, configDraft]);
  const hasConfigErrors = Object.keys(configErrors).length > 0;

  useEffect(() => {
    loadCoreConfigFiles().catch((error) => message.error(String(error)));
  }, []);

  async function loadCoreConfigFiles() {
    setConfigLoading(true);
    try {
      const files = await gsdeskApi.listCoreConfigFiles();
      setConfigFiles(files);
      const nextSelected = selectedConfig && files.some((file) => file.relativePath === selectedConfig) ? selectedConfig : files[0]?.relativePath;
      setSelectedConfig(nextSelected);
      if (nextSelected) await readCoreConfig(nextSelected);
      if (!nextSelected) {
        setConfigContent(undefined);
        setConfigDraft({});
        setComplexDraftText({});
        setConfigErrors({});
      }
    } finally {
      setConfigLoading(false);
    }
  }

  async function readCoreConfig(relativePath: string) {
    setConfigLoading(true);
    try {
      const content = await gsdeskApi.readCoreConfigFile(relativePath);
      setConfigContent(content);
      setConfigDraft(Object.fromEntries(content.entries.map((entry) => [entry.key, entry.value])));
      setComplexDraftText(
        Object.fromEntries(
          content.entries
            .filter((entry) => entry.valueType === "array" || entry.valueType === "object")
            .map((entry) => [entry.key, JSON.stringify(entry.value, null, 2)]),
        ),
      );
      setConfigErrors({});
    } finally {
      setConfigLoading(false);
    }
  }

  function updateConfigValue(key: string, value: unknown) {
    setConfigDraft((draft) => ({ ...draft, [key]: value }));
  }

  function updateComplexConfigValue(key: string, text: string) {
    setComplexDraftText((draft) => ({ ...draft, [key]: text }));
    try {
      const parsed = JSON.parse(text);
      setConfigErrors((errors) => {
        const next = { ...errors };
        delete next[key];
        return next;
      });
      updateConfigValue(key, parsed);
    } catch (error) {
      setConfigErrors((errors) => ({
        ...errors,
        [key]: error instanceof Error ? error.message : "JSON 解析失败",
      }));
    }
  }

  async function saveCoreConfig() {
    if (!configContent || hasConfigErrors) return;
    setConfigSaving(true);
    try {
      const result = await gsdeskApi.saveCoreConfigFile(
        configContent.relativePath,
        changedConfigEntries.map((entry) => ({ key: entry.key, value: configDraft[entry.key] })),
      );
      message.success(`已保存 ${result.saved.length} 项；备份 ${result.backupPath || "未生成"}`);
      if (result.skipped.length) message.warning(`已跳过敏感或不可写项：${result.skipped.join("、")}`);
      await readCoreConfig(configContent.relativePath);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setConfigSaving(false);
    }
  }

  function renderConfigEditor(row: CoreConfigEntry) {
    const disabled = !row.editable || row.secret;
    const value = configDraft[row.key];
    const options = row.options
      .filter((option): option is string | number => typeof option === "string" || typeof option === "number")
      .map((option) => ({ value: option, label: String(option) }));

    if (row.secret) {
      return <Input value="******" disabled />;
    }
    if (row.valueType === "bool") {
      return <Switch checked={Boolean(value)} disabled={disabled} onChange={(checked) => updateConfigValue(row.key, checked)} />;
    }
    if (row.options.length && row.valueType !== "array" && row.valueType !== "object") {
      return <Select value={value as string | number | undefined} disabled={disabled} options={options} onChange={(next) => updateConfigValue(row.key, next)} />;
    }
    if (row.valueType === "number") {
      return <InputNumber value={typeof value === "number" ? value : undefined} disabled={disabled} onChange={(next) => updateConfigValue(row.key, next ?? 0)} />;
    }
    if (row.valueType === "array" || row.valueType === "object") {
      return (
        <div className="config-json-editor">
          <TextArea
            autoSize={{ minRows: 2, maxRows: 6 }}
            value={complexDraftText[row.key] ?? ""}
            disabled={disabled}
            onChange={(event) => updateComplexConfigValue(row.key, event.target.value)}
          />
          {configErrors[row.key] ? <Text type="danger">{configErrors[row.key]}</Text> : null}
        </div>
      );
    }
    return <Input value={String(value ?? "")} disabled={disabled} onChange={(event) => updateConfigValue(row.key, event.target.value)} />;
  }

  return (
    <section className="page-grid">
      <div className="wide-panel">
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
      </div>

      <div className="wide-panel">
        <PanelHeader
          title="运行时修复"
          description={`uv: ${
            appState.toolchain.uvDetected
              ? `${appState.toolchain.uvVersion || "可用"} / ${appState.toolchain.uvSource}`
              : `未安装，目标 ${appState.toolchain.uvBootstrapTarget}`
          }`}
        />
        <SectionActions>
          <Button
            icon={<DownloadCloud size={16} />}
            loading={loadingAction === "bootstrap_uv"}
            disabled={!appState.toolchain.uvBootstrapSupported}
            onClick={onBootstrapUv}
          >
            安装/修复 uv
          </Button>
          <Button icon={<Wrench size={16} />} loading={loadingAction === "init"} onClick={onInitRuntime}>
            重新初始化
          </Button>
          <Button icon={<RotateCcw size={16} />} loading={loadingAction === "repair_sync_deps"} onClick={() => onRepairRuntime("sync_deps")}>
            重跑 uv sync
          </Button>
          <Button icon={<Trash2 size={16} />} loading={loadingAction === "repair_clear_uv_cache"} onClick={() => onRepairRuntime("clear_uv_cache")}>
            清理 uv cache
          </Button>
          <Button icon={<RotateCcw size={16} />} loading={loadingAction === "repair_rebuild_venv"} onClick={() => onRepairRuntime("rebuild_venv")}>
            重建 venv
          </Button>
          <Button icon={<RotateCcw size={16} />} loading={loadingAction === "repair_reclone_core"} onClick={() => onRepairRuntime("reclone_core")}>
            重新 clone Core
          </Button>
        </SectionActions>
      </div>

      <div className="wide-panel">
        <PanelHeader
          title="Core 更新与回滚"
          description="更新前记录回滚点；源码有未提交修改时会拒绝更新，避免覆盖用户数据"
        />
        <SectionActions>
          <Button icon={<RefreshCcw size={16} />} loading={loadingAction === "core_check"} onClick={() => onCoreUpdate("check", "latest")}>
            检查 latest
          </Button>
          <Button icon={<RotateCcw size={16} />} loading={loadingAction === "core_update"} onClick={() => onCoreUpdate("update", "latest")}>
            更新 latest
          </Button>
          <Button icon={<RotateCcw size={16} />} loading={loadingAction === "core_update"} onClick={() => onCoreUpdate("update", "stable")}>
            切到 stable
          </Button>
          <Button icon={<RotateCcw size={16} />} loading={loadingAction === "core_update"} onClick={() => onCoreUpdate("update", "dev")}>
            更新 dev
          </Button>
          <Button icon={<RotateCcw size={16} />} loading={loadingAction === "core_rollback"} onClick={() => onCoreUpdate("rollback", "latest")}>
            回滚上次更新
          </Button>
        </SectionActions>
      </div>

      <div className="wide-panel">
        <PanelHeader
          title="运行时备份"
          description="导出或恢复 Core data/config/plugins 和日志快照；恢复前会自动生成安全备份"
        />
        <SectionActions>
          <Button icon={<DownloadCloud size={16} />} loading={loadingAction === "runtime_backup"} onClick={onCreateRuntimeBackup}>
            导出备份快照
          </Button>
          <Button
            icon={<RotateCcw size={16} />}
            loading={loadingAction === "runtime_restore"}
            onClick={() =>
              Modal.confirm({
                title: "恢复最近运行时备份",
                content: "恢复会替换 Core data/config/plugins 和日志快照。请先停止 Core；恢复前会自动生成一份安全备份。",
                okText: "恢复",
                cancelText: "取消",
                onOk: onRestoreRuntimeBackup,
              })
            }
          >
            恢复最近备份
          </Button>
        </SectionActions>
      </div>

      <div className="wide-panel">
        <PanelHeader
          title="设置迁移"
          description="导出源码源、镜像、端口、退出策略等非敏感设置；代理账号密码不会默认导出"
        />
        <SectionActions>
          <Button icon={<DownloadCloud size={16} />} loading={loadingAction === "settings_export"} onClick={onExportSettings}>
            导出设置
          </Button>
          <Button icon={<RotateCcw size={16} />} loading={loadingAction === "settings_import"} onClick={onImportSettings}>
            导入最近设置
          </Button>
        </SectionActions>
      </div>

      <div className="wide-panel">
        <PanelHeader
          title="Core 配置编辑器"
          description="读取 data/config.json 和 data/configs 下的常用配置；保存前校验类型，敏感字段只遮蔽展示"
          actions={
            <SectionActions>
              <Button icon={<RefreshCcw size={16} />} loading={configLoading} onClick={() => loadCoreConfigFiles()}>
                重新读取
              </Button>
              <Button
                icon={<ExternalLink size={16} />}
                disabled={!selectedConfig}
                onClick={() => selectedConfig && gsdeskApi.openCoreConfigFile(selectedConfig).catch((error) => message.error(String(error)))}
              >
                定位文件
              </Button>
              <Button
                type="primary"
                icon={<Save size={16} />}
                loading={configSaving}
                disabled={!configContent || !changedConfigEntries.length || hasConfigErrors}
                onClick={saveCoreConfig}
              >
                保存修改
              </Button>
            </SectionActions>
          }
        />
        <div className="config-toolbar">
          <Select
            className="config-file-select"
            placeholder="选择 Core 配置文件"
            loading={configLoading}
            value={selectedConfig}
            options={configFiles.map((file) => ({
              value: file.relativePath,
              label: `${file.label} (${file.entryCount} 项)`,
            }))}
            onChange={(relativePath) => {
              setSelectedConfig(relativePath);
              readCoreConfig(relativePath).catch((error) => message.error(String(error)));
            }}
          />
          <Text type="secondary">
            {selectedConfigSummary
              ? `${selectedConfigSummary.relativePath} · ${selectedConfigSummary.secretCount} 个敏感项 · ${changedConfigEntries.length} 项待保存`
              : "未发现可编辑 Core 配置"}
          </Text>
        </div>
        {appState.services.find((service) => service.serviceId === "gsuid_core")?.status === "running" ? (
          <Alert
            className="spaced"
            type="warning"
            showIcon
            message="Core 正在运行"
            description="部分配置需要重启 Core 才会生效；涉及数据库、端口或启动行为的配置建议先停止 Core 再保存。"
          />
        ) : null}
        <Table
          className="spaced"
          rowKey="key"
          columns={configColumns}
          dataSource={configContent?.entries || []}
          loading={configLoading}
          pagination={{ pageSize: 8, showSizeChanger: false }}
          size="small"
        />
      </div>

      <div className="wide-panel">
        <PanelHeader title="任务历史" description="初始化、启动、停止、修复动作的阶段和耗时" />
        <Table rowKey="id" columns={taskColumns} dataSource={appState.taskHistory} pagination={false} size="small" />
      </div>

      <div className="wide-panel">
        <PanelHeader title="隔离目录" description="Core、venv、uv cache、Python 安装和诊断输出位置" />
        <div className="path-grid">
          {Object.entries(appState.paths).map(([key, value]) => (
            <div key={key}>
              <Text type="secondary">{key}</Text>
              <Tooltip title={value}>
                <code>{value}</code>
              </Tooltip>
              <div className="path-actions">
                <Button size="small" icon={<Copy size={13} />} onClick={() => navigator.clipboard.writeText(value)}>
                  复制
                </Button>
                <Button
                  size="small"
                  icon={<FolderOpen size={13} />}
                  onClick={() => gsdeskApi.openPath(key).catch((error) => message.error(String(error)))}
                >
                  打开
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function PreflightTag({ status }: { status: PreflightCheck["status"] }) {
  if (status === "ok") return <Tag color="success">通过</Tag>;
  if (status === "block") return <Tag color="error">阻断</Tag>;
  return <Tag color="warning">警告</Tag>;
}

function TaskTag({ status }: { status: TaskRecord["status"] }) {
  if (status === "success") return <Tag color="success">成功</Tag>;
  if (status === "failed") return <Tag color="error">失败</Tag>;
  if (status === "cancelled") return <Tag color="default">已取消</Tag>;
  return <Tag color="processing">执行中</Tag>;
}

function isRetryableTask(task: TaskRecord) {
  if (task.name === "初始化运行时" || task.name === "安装 uv" || task.name === "启动 Core") return true;
  if (task.name === "Core 更新") return true;
  if (task.name === "运行时修复") {
    return ["sync_deps", "rebuild_venv", "reclone_core", "clear_uv_cache"].includes(task.stage);
  }
  return false;
}
