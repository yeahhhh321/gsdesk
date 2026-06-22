import { useEffect } from "react";
import { Button, Form, Radio, Switch, Tabs } from "antd";
import { Save } from "lucide-react";
import { WidePanel } from "../ui/pageTabs";
import { PanelHeader } from "../ui/primitives";
import NetworkPage from "./NetworkPage";
import type { AppState, MirrorCheckResult, Settings, SourceProbeResult } from "../types";

interface SettingsPageProps {
  appState: AppState;
  sourceResults: SourceProbeResult[];
  mirrorResults: MirrorCheckResult[];
  loadingAction?: string;
  onProbeSources: () => void;
  onCheckMirrors: () => void;
  onSaveSettings: (settings: Settings) => void;
  onSelectDirectory: (defaultPath?: string) => Promise<string | undefined>;
  onOpenPath: (key: string) => void;
}

interface PreferenceFormValues {
  beginnerMode: boolean;
  hideToTrayOnClose: boolean;
  closeCoreOnExit: boolean;
  autoCheckUpdate: boolean;
}

export default function SettingsPage({
  appState,
  sourceResults,
  mirrorResults,
  loadingAction,
  onProbeSources,
  onCheckMirrors,
  onSaveSettings,
  onSelectDirectory,
  onOpenPath,
}: SettingsPageProps) {
  const [form] = Form.useForm<PreferenceFormValues>();

  useEffect(() => {
    form.setFieldsValue(toPreferenceForm(appState.settings));
  }, [appState.settings, form]);

  function savePreferenceSettings(values: PreferenceFormValues) {
    onSaveSettings({ ...appState.settings, ...values });
  }

  return (
    <section className="page-grid settings-page">
      <Tabs
        className="workspace-tabs"
        items={[
          {
            key: "preferences",
            label: "偏好",
            children: (
              <WidePanel>
                <PanelHeader title="偏好设置" description="显示模式、窗口行为和低频自动检查" />
                <Form
                  form={form}
                  layout="vertical"
                  className="settings-form compact-settings-form"
                  initialValues={toPreferenceForm(appState.settings)}
                  onFinish={savePreferenceSettings}
                >
                  <Form.Item name="beginnerMode" label="小白模式" valuePropName="checked">
                    <Switch checkedChildren="开启" unCheckedChildren="关闭" />
                  </Form.Item>
                  <Form.Item name="hideToTrayOnClose" label="点击 X 关闭窗口">
                    <Radio.Group>
                      <Radio.Button value={true}>隐藏到托盘</Radio.Button>
                      <Radio.Button value={false}>退出 GSDesk</Radio.Button>
                    </Radio.Group>
                  </Form.Item>
                  <Form.Item name="closeCoreOnExit" label="退出 GSDesk 时 Core">
                    <Radio.Group>
                      <Radio.Button value={true}>停止 Core</Radio.Button>
                      <Radio.Button value={false}>后台保留</Radio.Button>
                    </Radio.Group>
                  </Form.Item>
                  <Form.Item name="autoCheckUpdate" label="每日检查壳更新">
                    <Radio.Group>
                      <Radio.Button value={true}>开启</Radio.Button>
                      <Radio.Button value={false}>关闭</Radio.Button>
                    </Radio.Group>
                  </Form.Item>
                  <Button type="primary" icon={<Save size={16} />} htmlType="submit" loading={loadingAction === "save_settings"}>
                    保存设置
                  </Button>
                </Form>
              </WidePanel>
            ),
          },
          {
            key: "network",
            label: "网络设置",
            children: (
              <NetworkPage
                embedded
                mode="network"
                appState={appState}
                sourceResults={sourceResults}
                mirrorResults={mirrorResults}
                loadingAction={loadingAction}
                onProbeSources={onProbeSources}
                onCheckMirrors={onCheckMirrors}
                onSaveSettings={onSaveSettings}
                onSelectDirectory={onSelectDirectory}
                onOpenPath={onOpenPath}
              />
            ),
          },
          {
            key: "core-path",
            label: "Core 路径",
            children: (
              <NetworkPage
                embedded
                mode="core"
                appState={appState}
                sourceResults={sourceResults}
                mirrorResults={mirrorResults}
                loadingAction={loadingAction}
                onProbeSources={onProbeSources}
                onCheckMirrors={onCheckMirrors}
                onSaveSettings={onSaveSettings}
                onSelectDirectory={onSelectDirectory}
                onOpenPath={onOpenPath}
              />
            ),
          },
        ]}
      />
    </section>
  );
}

function toPreferenceForm(settings: Settings): PreferenceFormValues {
  return {
    beginnerMode: settings.beginnerMode,
    hideToTrayOnClose: settings.hideToTrayOnClose,
    closeCoreOnExit: settings.closeCoreOnExit,
    autoCheckUpdate: settings.autoCheckUpdate,
  };
}
