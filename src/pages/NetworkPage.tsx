import { useEffect, useRef } from "react";
import { Button, Form, Input, InputNumber, Radio, Table, Typography } from "antd";
import { Activity, FolderOpen } from "lucide-react";
import { displayText } from "../ui/format";
import { WidePanel } from "../ui/pageTabs";
import { PanelHeader } from "../ui/primitives";
import { isBeginnerMode } from "../ui/userMode";
import { mirrorColumns, sourceColumns } from "./networkTables";
import type { AppState, MirrorCheckResult, Settings as SettingsType, SourceProbeResult } from "../types";

const { Text } = Typography;
const DEFAULT_CORE_PORT = 8765;

interface NetworkPageProps {
  embedded?: boolean;
  mode?: "network" | "core";
  appState: AppState;
  sourceResults: SourceProbeResult[];
  mirrorResults: MirrorCheckResult[];
  loadingAction?: string;
  onProbeSources: () => void;
  onCheckMirrors: () => void;
  onSaveSettings: (settings: SettingsType) => void;
  onSelectDirectory: (defaultPath?: string) => Promise<string | undefined>;
  onOpenPath: (key: string) => void;
}

export default function NetworkPage({
  embedded = false,
  mode = "network",
  appState,
  sourceResults,
  mirrorResults,
  loadingAction,
  onProbeSources,
  onCheckMirrors,
  onSaveSettings,
  onSelectDirectory,
  onOpenPath,
}: NetworkPageProps) {
  const beginnerMode = isBeginnerMode(appState.settings);
  const content =
    mode === "core" ? (
      <CorePathPanel
        settings={appState.settings}
        paths={appState.paths}
        beginnerMode={beginnerMode}
        loadingAction={loadingAction}
        onSubmit={onSaveSettings}
        onSelectDirectory={onSelectDirectory}
        onOpenPath={onOpenPath}
      />
    ) : (
      <NetworkSettingsPanel
        settings={appState.settings}
        sourceResults={sourceResults}
        mirrorResults={mirrorResults}
        beginnerMode={beginnerMode}
        loadingAction={loadingAction}
        onProbeSources={onProbeSources}
        onCheckMirrors={onCheckMirrors}
        onSubmit={onSaveSettings}
      />
    );

  return embedded ? content : <section className="page-grid">{content}</section>;
}

function NetworkSettingsPanel({
  settings,
  sourceResults,
  mirrorResults,
  beginnerMode,
  loadingAction,
  onProbeSources,
  onCheckMirrors,
  onSubmit,
}: {
  settings: SettingsType;
  sourceResults: SourceProbeResult[];
  mirrorResults: MirrorCheckResult[];
  beginnerMode: boolean;
  loadingAction?: string;
  onProbeSources: () => void;
  onCheckMirrors: () => void;
  onSubmit: (settings: SettingsType) => void;
}) {
  if (beginnerMode) {
    return (
      <WidePanel>
        <PanelHeader title="网络设置" description="源码源检测和 PyPI/Playwright 镜像测速" />
        <div className="settings-summary-grid">
          <SummaryItem label="源码源" value={sourceModeText(settings.sourceMode)} detail="默认自动选择可用源" />
          <SummaryItem label="PyPI 镜像" value={pypiModeText(settings.pypiIndexMode)} detail="测速后保存可用镜像" />
          <SummaryItem label="Playwright" value={playwrightHostText(settings.playwrightDownloadHost)} detail="浏览器下载源" />
        </div>
        <div className="network-check-grid">
          <SourceCheckBlock
            results={sourceResults}
            lastCheckedAt={settings.lastSourceProbeAt}
            loadingAction={loadingAction}
            onProbeSources={onProbeSources}
          />
          <MirrorCheckBlock
            results={mirrorResults}
            lastCheckedAt={settings.lastMirrorCheckAt}
            loadingAction={loadingAction}
            onCheckMirrors={onCheckMirrors}
          />
        </div>
      </WidePanel>
    );
  }

  return (
    <WidePanel>
      <PanelHeader title="网络设置" description="只管理源码源检测和 PyPI/Playwright 镜像" />
      <NetworkSettingsForm
        settings={settings}
        sourceResults={sourceResults}
        mirrorResults={mirrorResults}
        loadingAction={loadingAction}
        onProbeSources={onProbeSources}
        onCheckMirrors={onCheckMirrors}
        onSubmit={onSubmit}
      />
    </WidePanel>
  );
}

function SourceCheckBlock({
  results,
  lastCheckedAt,
  loadingAction,
  onProbeSources,
}: {
  results: SourceProbeResult[];
  lastCheckedAt?: string;
  loadingAction?: string;
  onProbeSources: () => void;
}) {
  return (
    <div className="network-check-block">
      <div className="network-check-header">
        <div className="network-check-copy">
          <strong>源码检测</strong>
          <Text type="secondary">上次检测：{formatTime(lastCheckedAt)}</Text>
        </div>
        <Button icon={<Activity size={16} />} loading={loadingAction === "probe_sources"} onClick={onProbeSources}>
          检测源码源
        </Button>
      </div>
      {results.length > 0 ? (
        <Table rowKey="id" columns={sourceColumns} dataSource={results} pagination={false} size="small" />
      ) : (
        <p className="muted-block">还没有源码源检测结果。</p>
      )}
    </div>
  );
}

function MirrorCheckBlock({
  results,
  lastCheckedAt,
  loadingAction,
  onCheckMirrors,
}: {
  results: MirrorCheckResult[];
  lastCheckedAt?: string;
  loadingAction?: string;
  onCheckMirrors: () => void;
}) {
  return (
    <div className="network-check-block">
      <div className="network-check-header">
        <div className="network-check-copy">
          <strong>PyPI 测速</strong>
          <Text type="secondary">上次检测：{formatTime(lastCheckedAt)}</Text>
        </div>
        <Button icon={<Activity size={16} />} loading={loadingAction === "check_mirrors"} onClick={onCheckMirrors}>
          测速 PyPI
        </Button>
      </div>
      {results.length > 0 ? (
        <Table rowKey="url" columns={mirrorColumns} dataSource={results} pagination={false} size="small" />
      ) : (
        <p className="muted-block">还没有 PyPI 镜像测速结果。</p>
      )}
    </div>
  );
}

function SummaryItem({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="settings-summary-item">
      <Text type="secondary">{label}</Text>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  );
}

function formatTime(value?: string) {
  const text = displayText(value, "");
  if (!text) return "从未";
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  return date.toLocaleString();
}

function sourceModeText(value: SettingsType["sourceMode"]) {
  if (value === "github") return "固定 GitHub";
  if (value === "cnb") return "固定 CNB";
  return "自动选择";
}

function pypiModeText(value: SettingsType["pypiIndexMode"]) {
  if (value === "manual") return "手动锁定";
  return "自动选择";
}

function playwrightHostText(value: string) {
  return value.trim() ? "镜像" : "官方";
}

interface NetworkFormValues {
  sourceMode: SettingsType["sourceMode"];
  selectedSource: string;
  pypiIndexMode: SettingsType["pypiIndexMode"];
  pypiIndexUrl: string;
  playwrightDownloadHost: string;
}

function NetworkSettingsForm({
  settings,
  sourceResults,
  mirrorResults,
  loadingAction,
  onProbeSources,
  onCheckMirrors,
  onSubmit,
}: {
  settings: SettingsType;
  sourceResults: SourceProbeResult[];
  mirrorResults: MirrorCheckResult[];
  loadingAction?: string;
  onProbeSources: () => void;
  onCheckMirrors: () => void;
  onSubmit: (settings: SettingsType) => void;
}) {
  const [form] = Form.useForm<NetworkFormValues>();
  const userEditedRef = useRef(false);

  useEffect(() => {
    if (userEditedRef.current) return;
    form.setFieldsValue(networkFormValues(settings));
  }, [form, settings]);

  return (
    <Form
      form={form}
      layout="vertical"
      initialValues={networkFormValues(settings)}
      onValuesChange={() => {
        userEditedRef.current = true;
      }}
      onFinish={(values) => onSubmit(mergeNetworkFormValues(settings, values))}
      className="settings-form network-settings-form"
    >
      <div className="network-settings-layout">
        <fieldset className="settings-group">
          <legend>源码源</legend>
          <div className="settings-group-grid source-settings-grid">
            <Form.Item name="sourceMode" label="源码源策略">
              <Radio.Group>
                <Radio.Button value="auto">自动选择</Radio.Button>
                <Radio.Button value="github">GitHub</Radio.Button>
                <Radio.Button value="cnb">CNB</Radio.Button>
              </Radio.Group>
            </Form.Item>
            <Form.Item name="selectedSource" label="当前源码源">
              <Input />
            </Form.Item>
          </div>
          <SourceCheckBlock
            results={sourceResults}
            lastCheckedAt={settings.lastSourceProbeAt}
            loadingAction={loadingAction}
            onProbeSources={onProbeSources}
          />
        </fieldset>

        <fieldset className="settings-group">
          <legend>PyPI 镜像</legend>
          <div className="settings-group-grid pypi-settings-grid">
            <Form.Item name="pypiIndexMode" label="PyPI 镜像策略" extra="自动测速保存最快镜像；手动锁定只记录结果。">
              <Radio.Group>
                <Radio.Button value="auto">自动选择</Radio.Button>
                <Radio.Button value="manual">手动锁定</Radio.Button>
              </Radio.Group>
            </Form.Item>
            <Form.Item name="pypiIndexUrl" label="PyPI 镜像地址">
              <Input />
            </Form.Item>
            <Form.Item
              name="playwrightDownloadHost"
              label="Playwright 浏览器镜像"
              extra="留空使用官方 CDN；国内可填 https://cdn.npmmirror.com/binaries/playwright"
            >
              <Input placeholder="https://cdn.npmmirror.com/binaries/playwright" />
            </Form.Item>
          </div>
          <MirrorCheckBlock
            results={mirrorResults}
            lastCheckedAt={settings.lastMirrorCheckAt}
            loadingAction={loadingAction}
            onCheckMirrors={onCheckMirrors}
          />
        </fieldset>
      </div>
      <div className="settings-form-actions">
        <Button type="primary" htmlType="submit">
          保存设置
        </Button>
      </div>
    </Form>
  );
}

interface CorePathFormValues {
  customCoreDir: string;
  preferredCorePort?: number | null;
}

function CorePathPanel({
  settings,
  paths,
  beginnerMode,
  loadingAction,
  onSubmit,
  onSelectDirectory,
  onOpenPath,
}: {
  settings: SettingsType;
  paths: AppState["paths"];
  beginnerMode: boolean;
  loadingAction?: string;
  onSubmit: (settings: SettingsType) => void;
  onSelectDirectory: (defaultPath?: string) => Promise<string | undefined>;
  onOpenPath: (key: string) => void;
}) {
  if (beginnerMode) {
    return (
      <WidePanel>
        <PanelHeader title="Core 路径" description="小白模式默认使用 GSDesk 托管目录和固定 8765 端口" />
        <div className="settings-summary-grid">
          <SummaryItem label="Core 源码" value="GSDesk 托管" detail={paths.coreDir} />
          <SummaryItem label="插件目录" value="固定位置" detail={joinPath(paths.coreDir, "plugins")} />
          <SummaryItem label="端口" value={`固定 ${settings.preferredCorePort ?? DEFAULT_CORE_PORT}`} detail="默认 8765" />
        </div>
        <div className="settings-form-actions">
          <Button icon={<FolderOpen size={16} />} onClick={() => onOpenPath("coreDir")}>
            打开源码目录
          </Button>
          <Button icon={<FolderOpen size={16} />} onClick={() => onOpenPath("corePluginsDir")}>
            打开插件目录
          </Button>
        </div>
      </WidePanel>
    );
  }

  return (
    <WidePanel>
      <PanelHeader title="Core 路径" description="源码目录、插件目录和固定端口单独管理" />
      <CorePathForm
        settings={settings}
        activeCoreDir={paths.coreDir}
        loadingAction={loadingAction}
        onSubmit={onSubmit}
        onSelectDirectory={onSelectDirectory}
        onOpenPath={onOpenPath}
      />
    </WidePanel>
  );
}

function CorePathForm({
  settings,
  activeCoreDir,
  loadingAction,
  onSubmit,
  onSelectDirectory,
  onOpenPath,
}: {
  settings: SettingsType;
  activeCoreDir: string;
  loadingAction?: string;
  onSubmit: (settings: SettingsType) => void;
  onSelectDirectory: (defaultPath?: string) => Promise<string | undefined>;
  onOpenPath: (key: string) => void;
}) {
  const [form] = Form.useForm<CorePathFormValues>();
  const userEditedRef = useRef(false);
  const corePluginsDir = joinPath(activeCoreDir, "plugins");

  useEffect(() => {
    if (userEditedRef.current) return;
    form.setFieldsValue(corePathFormValues(settings));
  }, [form, settings]);

  async function pickCoreDir() {
    const currentValue = form.getFieldValue("customCoreDir");
    const defaultPath = typeof currentValue === "string" && currentValue.trim() ? currentValue : activeCoreDir;
    const selected = await onSelectDirectory(defaultPath);
    if (selected) {
      userEditedRef.current = true;
      form.setFieldValue("customCoreDir", selected);
    }
  }

  return (
    <Form
      form={form}
      layout="vertical"
      initialValues={corePathFormValues(settings)}
      onValuesChange={() => {
        userEditedRef.current = true;
      }}
      onFinish={(values) => onSubmit(mergeCorePathFormValues(settings, values))}
      className="settings-form network-settings-form"
    >
      <div className="network-settings-layout">
        <fieldset className="settings-group">
          <legend>Core 源码</legend>
          <div className="settings-group-grid core-settings-grid">
            <Form.Item name="customCoreDir" label="Core 源码路径" extra={`当前生效路径：${activeCoreDir}`}>
              <Input placeholder="例如 D:\\runtime\\gsuid_core" />
            </Form.Item>
            <div className="path-action-row">
              <Button icon={<FolderOpen size={16} />} onClick={() => void pickCoreDir()}>
                选择目录
              </Button>
              <Button icon={<FolderOpen size={16} />} onClick={() => onOpenPath("coreDir")}>
                打开源码目录
              </Button>
            </div>
            <Form.Item name="preferredCorePort" label="Core 固定端口" extra="默认 8765；填写后启动时严格使用。">
              <InputNumber min={1024} max={65535} precision={0} placeholder="8765" style={{ width: "100%" }} />
            </Form.Item>
          </div>
        </fieldset>
        <fieldset className="settings-group">
          <legend>插件目录</legend>
          <div className="readonly-path-row">
            <div className="settings-path-item">
              <Text type="secondary">插件目录</Text>
              <code>{corePluginsDir}</code>
            </div>
            <Button icon={<FolderOpen size={16} />} onClick={() => onOpenPath("corePluginsDir")}>
              打开插件目录
            </Button>
          </div>
        </fieldset>
      </div>
      <div className="settings-form-actions">
        <Button type="primary" htmlType="submit" loading={loadingAction === "save_settings"}>
          保存设置
        </Button>
      </div>
    </Form>
  );
}

function joinPath(base: string, child: string) {
  const trimmed = base.replace(/[\\/]+$/, "");
  if (!trimmed) return child;
  const separator = trimmed.includes("\\") ? "\\" : "/";
  return `${trimmed}${separator}${child}`;
}

function networkFormValues(settings: SettingsType): NetworkFormValues {
  return {
    sourceMode: settings.sourceMode,
    selectedSource: settings.selectedSource,
    pypiIndexMode: settings.pypiIndexMode,
    pypiIndexUrl: settings.pypiIndexUrl,
    playwrightDownloadHost: settings.playwrightDownloadHost,
  };
}

function mergeNetworkFormValues(settings: SettingsType, values: NetworkFormValues): SettingsType {
  return {
    ...settings,
    sourceMode: values.sourceMode,
    selectedSource: values.selectedSource,
    pypiIndexMode: values.pypiIndexMode,
    pypiIndexUrl: values.pypiIndexUrl,
    playwrightDownloadHost: values.playwrightDownloadHost,
  };
}

function corePathFormValues(settings: SettingsType): CorePathFormValues {
  return {
    customCoreDir: settings.customCoreDir,
    preferredCorePort: settings.preferredCorePort ?? DEFAULT_CORE_PORT,
  };
}

function mergeCorePathFormValues(settings: SettingsType, values: CorePathFormValues): SettingsType {
  const preferredCorePort = typeof values.preferredCorePort === "number" ? values.preferredCorePort : DEFAULT_CORE_PORT;
  return {
    ...settings,
    customCoreDir: values.customCoreDir,
    preferredCorePort,
  };
}
