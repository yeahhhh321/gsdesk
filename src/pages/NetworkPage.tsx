import { useEffect, useMemo } from "react";
import { Button, Form, Input, InputNumber, Radio, Table, Tabs, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { Activity } from "lucide-react";
import { PanelHeader, ResultTag, SectionActions } from "../ui/primitives";
import type { AppState, MirrorCheckResult, NetworkDiagnosticResult, Settings as SettingsType, SourceProbeResult } from "../types";

const { Text } = Typography;

interface NetworkPageProps {
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
  const sourceColumns = useMemo<ColumnsType<SourceProbeResult>>(
    () => [
      { title: "源", dataIndex: "name", width: 160 },
      { title: "地址", dataIndex: "url", ellipsis: true },
      {
        title: "状态",
        width: 100,
        render: (_, row) => <ResultTag ok={row.ok} />,
      },
      { title: "延迟", width: 100, render: (_, row) => (row.latencyMs ? `${row.latencyMs}ms` : "-") },
      { title: "错误", dataIndex: "error", ellipsis: true },
    ],
    [],
  );

  const mirrorColumns = useMemo<ColumnsType<MirrorCheckResult>>(
    () => [
      { title: "镜像", dataIndex: "name", width: 140 },
      { title: "地址", dataIndex: "url", ellipsis: true },
      {
        title: "状态",
        width: 100,
        render: (_, row) => <ResultTag ok={row.ok} />,
      },
      { title: "延迟", width: 100, render: (_, row) => (row.latencyMs ? `${row.latencyMs}ms` : "-") },
      { title: "速度", width: 120, render: (_, row) => (row.speedMbps ? `${row.speedMbps.toFixed(2)} MB/s` : "-") },
      { title: "错误", dataIndex: "error", ellipsis: true },
    ],
    [],
  );

  const diagnosticColumns = useMemo<ColumnsType<NetworkDiagnosticResult>>(
    () => [
      { title: "目标", dataIndex: "label", width: 150 },
      { title: "地址", dataIndex: "target", ellipsis: true },
      {
        title: "状态",
        width: 100,
        render: (_, row) => <ResultTag ok={row.ok} />,
      },
      { title: "延迟", width: 100, render: (_, row) => (row.latencyMs ? `${row.latencyMs}ms` : "-") },
      { title: "错误", dataIndex: "error", ellipsis: true },
    ],
    [],
  );

  return (
    <section className="page-block">
      <PanelHeader title="网络与设置" description="源码源、PyPI 镜像、代理和基础偏好统一在这里配置" />
      <Tabs
        items={[
          {
            key: "sources",
            label: "源码源",
            children: (
              <>
                <SectionActions>
                  <Button icon={<Activity size={16} />} loading={loadingAction === "probe_sources"} onClick={onProbeSources}>
                    探测 GitHub / CNB
                  </Button>
                  <Text type="secondary">上次探测：{formatTime(appState.settings.lastSourceProbeAt)}</Text>
                </SectionActions>
                <Table rowKey="id" columns={sourceColumns} dataSource={sourceResults} pagination={false} size="small" />
              </>
            ),
          },
          {
            key: "mirrors",
            label: "PyPI 镜像",
            children: (
              <>
                <SectionActions>
                  <Button icon={<Activity size={16} />} loading={loadingAction === "check_mirrors"} onClick={onCheckMirrors}>
                    测速镜像
                  </Button>
                  <Text type="secondary">测速结果会按可用性和速度排序 · 上次测速：{formatTime(appState.settings.lastMirrorCheckAt)}</Text>
                </SectionActions>
                <Table rowKey="url" columns={mirrorColumns} dataSource={mirrorResults} pagination={false} size="small" />
              </>
            ),
          },
          {
            key: "proxy",
            label: "代理与设置",
            children: <SettingsForm settings={appState.settings} onSubmit={onSaveSettings} />,
          },
          {
            key: "diagnostics",
            label: "连通性诊断",
            children: (
              <>
                <SectionActions>
                  <Button icon={<Activity size={16} />} loading={loadingAction === "test_network"} onClick={onTestNetworkTargets}>
                    测试 GitHub / CNB / PyPI / WebConsole
                  </Button>
                  <Text type="secondary">使用当前代理设置，定位具体失败目标</Text>
                </SectionActions>
                <Table rowKey="id" columns={diagnosticColumns} dataSource={networkDiagnostics} pagination={false} size="small" />
              </>
            ),
          },
        ]}
      />
    </section>
  );
}

function formatTime(value?: string) {
  if (!value) return "从未";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function SettingsForm({ settings, onSubmit }: { settings: SettingsType; onSubmit: (settings: SettingsType) => void }) {
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
      <Form.Item name="pypiIndexMode" label="PyPI 镜像策略" extra="自动模式会在测速后保存最快可用镜像；手动锁定会保留当前地址，只更新时间戳和测速结果。">
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
      <Form.Item name="closeCoreOnExit" label="退出 GSDesk 时关闭 Core">
        <Radio.Group>
          <Radio.Button value={true}>关闭</Radio.Button>
          <Radio.Button value={false}>后台保留</Radio.Button>
        </Radio.Group>
      </Form.Item>
      <Form.Item name="autoCheckUpdate" label="启动时检查壳更新">
        <Radio.Group>
          <Radio.Button value={true}>开启</Radio.Button>
          <Radio.Button value={false}>关闭</Radio.Button>
        </Radio.Group>
      </Form.Item>
      <Button type="primary" htmlType="submit">
        保存设置
      </Button>
    </Form>
  );
}
