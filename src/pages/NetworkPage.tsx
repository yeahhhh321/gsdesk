import { useEffect } from "react";
import { Button, Form, Input, InputNumber, Radio, Table, Typography } from "antd";
import { Activity } from "lucide-react";
import { displayText } from "../ui/format";
import { WidePanel } from "../ui/pageTabs";
import { PanelHeader, SectionActions } from "../ui/primitives";
import { isBeginnerMode } from "../ui/userMode";
import { diagnosticColumns, mirrorColumns, sourceColumns } from "./networkTables";
import type { AppState, MirrorCheckResult, NetworkDiagnosticResult, Settings as SettingsType, SourceProbeResult } from "../types";

const { Text } = Typography;
export type NetworkSection = "settings" | "checks";

interface NetworkPageProps {
  section: NetworkSection;
  appState: AppState;
  sourceResults: SourceProbeResult[];
  mirrorResults: MirrorCheckResult[];
  networkDiagnostics: NetworkDiagnosticResult[];
  loadingAction?: string;
  onProbeSources: () => void;
  onCheckMirrors: () => void;
  onTestNetworkTargets: () => void;
  onSaveSettings: (settings: SettingsType) => void;
}

export default function NetworkPage({
  section,
  appState,
  sourceResults,
  mirrorResults,
  networkDiagnostics,
  loadingAction,
  onProbeSources,
  onCheckMirrors,
  onTestNetworkTargets,
  onSaveSettings,
}: NetworkPageProps) {
  const beginnerMode = isBeginnerMode(appState.settings);

  if (section === "settings") {
    if (beginnerMode) {
      return (
        <section className="page-grid">
          <WidePanel>
            <PanelHeader title="网络设置" description="小白模式下使用自动源、自动镜像、自动端口和 GSDesk 托管目录" />
            <div className="settings-summary-grid">
              <SummaryItem label="源码源" value={sourceModeText(appState.settings.sourceMode)} detail="默认自动选择可用源" />
              <SummaryItem label="PyPI 镜像" value={pypiModeText(appState.settings.pypiIndexMode)} detail="测速后保存可用镜像" />
              <SummaryItem label="Core 路径" value="GSDesk 托管" detail={appState.paths.coreDir} />
              <SummaryItem label="端口" value="自动选择" detail="默认从 8765 开始寻找可用端口" />
            </div>
          </WidePanel>
        </section>
      );
    }

    return (
      <section className="page-grid">
        <WidePanel>
          <PanelHeader title="高级网络设置" description="源码、镜像、Core 路径、端口和代理集中保存" />
          <SettingsForm settings={appState.settings} activeCoreDir={appState.paths.coreDir} onSubmit={onSaveSettings} />
        </WidePanel>
      </section>
    );
  }

  return (
    <section className="page-grid">
      <WidePanel>
        <PanelHeader title="网络检测" description="首装或排查时手动运行；结果只在本页显示" />
        <SectionActions>
          <Button icon={<Activity size={16} />} loading={loadingAction === "probe_sources"} onClick={onProbeSources}>
            探测 GitHub / CNB
          </Button>
          <Button icon={<Activity size={16} />} loading={loadingAction === "check_mirrors"} onClick={onCheckMirrors}>
            测速 PyPI
          </Button>
          <Button icon={<Activity size={16} />} loading={loadingAction === "test_network"} onClick={onTestNetworkTargets}>
            连通性诊断
          </Button>
          <Text type="secondary">
            源码 {formatTime(appState.settings.lastSourceProbeAt)} / 镜像 {formatTime(appState.settings.lastMirrorCheckAt)}
          </Text>
        </SectionActions>

        {!sourceResults.length && !mirrorResults.length && !networkDiagnostics.length && (
          <p className="muted-block">
            当前源码策略：{sourceModeText(appState.settings.sourceMode)}；PyPI 策略：
            {pypiModeText(appState.settings.pypiIndexMode)}。
          </p>
        )}

        <div className="network-result-stack">
          {sourceResults.length > 0 && (
            <section>
              <h5>源码源结果</h5>
              <Table rowKey="id" columns={sourceColumns} dataSource={sourceResults} pagination={false} size="small" />
            </section>
          )}
          {mirrorResults.length > 0 && (
            <section>
              <h5>PyPI 镜像结果</h5>
              <Table rowKey="url" columns={mirrorColumns} dataSource={mirrorResults} pagination={false} size="small" />
            </section>
          )}
          {networkDiagnostics.length > 0 && (
            <section>
              <h5>连通性诊断结果</h5>
              <Table rowKey="id" columns={diagnosticColumns} dataSource={networkDiagnostics} pagination={false} size="small" />
            </section>
          )}
        </div>
      </WidePanel>
    </section>
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

function SettingsForm({
  settings,
  activeCoreDir,
  onSubmit,
}: {
  settings: SettingsType;
  activeCoreDir: string;
  onSubmit: (settings: SettingsType) => void;
}) {
  const [form] = Form.useForm<SettingsType>();

  useEffect(() => {
    form.setFieldsValue(settings);
  }, [form, settings]);

  return (
    <Form
      form={form}
      layout="vertical"
      initialValues={settings}
      onFinish={(values) => onSubmit({ ...settings, ...values, proxy: { ...settings.proxy, ...values.proxy } })}
      className="settings-form"
    >
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
      <Form.Item name="customCoreDir" label="Core 源码路径" extra={`留空使用 GSDesk 托管目录。当前生效路径：${activeCoreDir}`}>
        <Input placeholder="例如 D:\\runtime\\gsuid_core" />
      </Form.Item>
      <Form.Item
        name="pypiIndexMode"
        label="PyPI 镜像策略"
        extra="自动模式会在测速后保存最快可用镜像；手动锁定会保留当前地址，只更新时间戳和测速结果。"
      >
        <Radio.Group>
          <Radio.Button value="auto">自动选择</Radio.Button>
          <Radio.Button value="manual">手动锁定</Radio.Button>
        </Radio.Group>
      </Form.Item>
      <Form.Item name="pypiIndexUrl" label="PyPI 镜像地址">
        <Input />
      </Form.Item>
      <Form.Item
        name="preferredCorePort"
        label="Core 固定端口"
        extra="留空为自动选择。填写后启动会严格使用该端口；端口被占用时会阻断启动并提示占用。"
      >
        <InputNumber min={1024} max={65535} precision={0} placeholder="自动选择 8765-8865" style={{ width: "100%" }} />
      </Form.Item>
      <div className="form-grid">
        <Form.Item name={["proxy", "httpProxy"]} label="HTTP_PROXY">
          <Input placeholder="http://127.0.0.1:7890" />
        </Form.Item>
        <Form.Item name={["proxy", "httpsProxy"]} label="HTTPS_PROXY">
          <Input placeholder="http://127.0.0.1:7890" />
        </Form.Item>
        <Form.Item name={["proxy", "allProxy"]} label="ALL_PROXY">
          <Input placeholder="socks5://127.0.0.1:7890" />
        </Form.Item>
        <Form.Item name={["proxy", "noProxy"]} label="NO_PROXY">
          <Input />
        </Form.Item>
      </div>
      <Button type="primary" htmlType="submit">
        保存设置
      </Button>
    </Form>
  );
}
