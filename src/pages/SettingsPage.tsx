import { useEffect } from "react";
import { Button, Form, Radio, Switch } from "antd";
import { Save } from "lucide-react";
import { WidePanel } from "../ui/pageTabs";
import { PanelHeader } from "../ui/primitives";
import type { AppState, Settings } from "../types";

interface SettingsPageProps {
  appState: AppState;
  loadingAction?: string;
  onSaveSettings: (settings: Settings) => void;
}

interface PreferenceFormValues {
  beginnerMode: boolean;
  hideToTrayOnClose: boolean;
  closeCoreOnExit: boolean;
  autoCheckUpdate: boolean;
}

export default function SettingsPage({ appState, loadingAction, onSaveSettings }: SettingsPageProps) {
  const [form] = Form.useForm<PreferenceFormValues>();

  useEffect(() => {
    form.setFieldsValue(toPreferenceForm(appState.settings));
  }, [appState.settings, form]);

  function savePreferenceSettings(values: PreferenceFormValues) {
    onSaveSettings({ ...appState.settings, ...values });
  }

  return (
    <section className="page-grid settings-page">
      <WidePanel>
        <PanelHeader title="偏好设置" description="只管理 GSDesk 的显示模式、窗口行为和启动时自动检查" />
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
          <Form.Item name="autoCheckUpdate" label="启动时检查壳更新">
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
