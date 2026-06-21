import { useEffect } from "react";
import { Alert, App as AntdApp, Button, Form, Radio, Switch, Tag, Typography } from "antd";
import {
  Download,
  FolderOpen,
  HelpCircle,
  Import,
  RefreshCw,
  Save,
  Settings as SettingsIcon,
  SlidersHorizontal,
} from "lucide-react";
import { updateDescription, updateMessage } from "./diagnosticsRules";
import { findGsuidCore } from "../serviceIds";
import { displayBytes, displayText } from "../ui/format";
import { WidePanel } from "../ui/pageTabs";
import { PanelHeader, SectionActions } from "../ui/primitives";
import type { AppState, Settings, UpdateInfo } from "../types";

const { Text } = Typography;

interface SettingsPageProps {
  appState: AppState;
  updateInfo?: UpdateInfo;
  loadingAction?: string;
  onSaveSettings: (settings: Settings) => void;
  onCheckShellUpdate: () => void;
  onInstallShellUpdate: () => void;
  onExportSettings: () => void;
  onImportSettings: () => void;
  onOpenPath: (key: string) => void;
  onOpenInstallGuide: () => void;
}

interface BehaviorFormValues {
  beginnerMode: boolean;
  hideToTrayOnClose: boolean;
  closeCoreOnExit: boolean;
  autoCheckUpdate: boolean;
}

export default function SettingsPage({
  appState,
  updateInfo,
  loadingAction,
  onSaveSettings,
  onCheckShellUpdate,
  onInstallShellUpdate,
  onExportSettings,
  onImportSettings,
  onOpenPath,
  onOpenInstallGuide,
}: SettingsPageProps) {
  const { modal } = AntdApp.useApp();
  const core = findGsuidCore(appState.services);
  const [modeForm] = Form.useForm<BehaviorFormValues>();
  const [behaviorForm] = Form.useForm<BehaviorFormValues>();

  useEffect(() => {
    const values = toBehaviorForm(appState.settings);
    modeForm.setFieldsValue(values);
    behaviorForm.setFieldsValue(values);
  }, [appState.settings, behaviorForm, modeForm]);

  function saveBehaviorSettings(values: Partial<BehaviorFormValues>) {
    onSaveSettings({ ...appState.settings, ...values });
  }

  return (
    <section className="page-grid settings-page">
      <WidePanel>
        <PanelHeader
          title="GSDesk 设置"
          description="管理壳版本、更新检查、窗口关闭行为和本机设置文件"
          actions={
            <SectionActions>
              <Button icon={<FolderOpen size={16} />} onClick={() => onOpenPath("settingsFile")}>
                设置目录
              </Button>
              <Button icon={<HelpCircle size={16} />} onClick={onOpenInstallGuide}>
                打开引导
              </Button>
            </SectionActions>
          }
        />

        <div className="settings-summary-grid">
          <SummaryItem
            label="使用模式"
            value={appState.settings.beginnerMode ? "小白模式" : "高级模式"}
            detail={appState.settings.beginnerMode ? "只显示直接可用的操作" : "开放路径、端口、代理和回滚"}
          />
          <SummaryItem label="GSDesk 版本" value={`v${appState.version}`} detail={versionDetail(updateInfo)} />
          <SummaryItem label="Core 状态" value={coreStatusText(core?.status)} detail={core?.url ?? "WebConsole 尚未就绪"} />
          <SummaryItem
            label="壳进程"
            value={`pid ${appState.shell.pid}`}
            detail={`内存 ${displayBytes(appState.shell.memoryBytes)}`}
          />
          <SummaryItem label="语言" value="中文" detail={appState.settings.language} />
        </div>
      </WidePanel>

      <WidePanel>
        <PanelHeader
          title="使用模式"
          description="小白模式默认自动托管运行时；高级模式开放源码、镜像、端口、代理、回滚和清理等细项"
          actions={<Tag icon={<SlidersHorizontal size={13} />}>{appState.settings.beginnerMode ? "小白" : "高级"}</Tag>}
        />
        <Form form={modeForm} layout="vertical" className="settings-form compact-settings-form" onFinish={saveBehaviorSettings}>
          <Form.Item
            name="beginnerMode"
            label="小白模式"
            valuePropName="checked"
            extra="开启后，侧边栏和页面只展示启动、停止、WebConsole、预检、一键准备、任务和诊断；高级配置会保留但不主动打扰。"
          >
            <Switch checkedChildren="开启" unCheckedChildren="关闭" />
          </Form.Item>
          <Button type="primary" icon={<Save size={16} />} htmlType="submit" loading={loadingAction === "save_settings"}>
            保存模式
          </Button>
        </Form>
      </WidePanel>

      <WidePanel>
        <PanelHeader title="壳更新" description="只检查和更新 GSDesk 壳；Core 更新在环境页单独处理" />
        <SectionActions>
          <Button icon={<RefreshCw size={16} />} loading={loadingAction === "update"} onClick={onCheckShellUpdate}>
            检查更新
          </Button>
          {updateInfo?.hasUpdate && (
            <Button
              type="primary"
              icon={<Download size={16} />}
              loading={loadingAction === "install_shell_update"}
              onClick={() =>
                modal.confirm({
                  title: "下载并安装 GSDesk 更新",
                  content: "更新会下载官方 Release 产物，完成校验后安装并重启 GSDesk。",
                  okText: "安装更新",
                  cancelText: "取消",
                  onOk: onInstallShellUpdate,
                })
              }
            >
              下载并安装
            </Button>
          )}
        </SectionActions>
        {updateInfo ? (
          <Alert
            className="spaced"
            type={updateInfo.hasUpdate ? "warning" : updateInfo.error ? "warning" : "info"}
            showIcon
            title={updateMessage(updateInfo)}
            description={updateDescription(updateInfo)}
          />
        ) : (
          <p className="muted-block">尚未手动检查更新。开启自动检查后，GSDesk 启动时会静默查询壳更新。</p>
        )}
      </WidePanel>

      <WidePanel>
        <PanelHeader title="窗口与后台" description="点击 X、退出 GSDesk 和 Core 后台保留分开控制" />
        <Form
          form={behaviorForm}
          layout="vertical"
          className="settings-form compact-settings-form"
          onFinish={saveBehaviorSettings}
        >
          <Form.Item
            name="hideToTrayOnClose"
            label="点击 X 关闭窗口"
            extra="隐藏到托盘时 GSDesk 仍在运行，Core 状态保持不变；直接退出时会执行退出清理策略。"
          >
            <Radio.Group>
              <Radio.Button value={true}>隐藏到托盘</Radio.Button>
              <Radio.Button value={false}>退出 GSDesk</Radio.Button>
            </Radio.Group>
          </Form.Item>
          <Form.Item
            name="closeCoreOnExit"
            label="退出 GSDesk 时 Core"
            extra="从托盘退出，或点击 X 被设置为直接退出时生效。后台保留后，下次打开 GSDesk 会自动加载原 Core。"
          >
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

      <WidePanel>
        <PanelHeader title="设置与目录" description="导出可迁移设置，敏感代理字段不会写入导出文件" />
        <SectionActions>
          <Button icon={<Download size={16} />} loading={loadingAction === "settings_export"} onClick={onExportSettings}>
            导出设置
          </Button>
          <Button icon={<Import size={16} />} loading={loadingAction === "settings_import"} onClick={onImportSettings}>
            导入最近设置
          </Button>
          <Button icon={<FolderOpen size={16} />} onClick={() => onOpenPath("appData")}>
            AppData
          </Button>
          <Button icon={<FolderOpen size={16} />} onClick={() => onOpenPath("backupsDir")}>
            备份目录
          </Button>
        </SectionActions>
        <div className="settings-path-list">
          <PathItem label="设置文件" value={appState.paths.settingsFile} />
          <PathItem label="AppData" value={appState.paths.appData} />
          <PathItem label="运行时" value={appState.paths.runtime} />
        </div>
      </WidePanel>
    </section>
  );
}

function toBehaviorForm(settings: Settings): BehaviorFormValues {
  return {
    beginnerMode: settings.beginnerMode,
    hideToTrayOnClose: settings.hideToTrayOnClose,
    closeCoreOnExit: settings.closeCoreOnExit,
    autoCheckUpdate: settings.autoCheckUpdate,
  };
}

function versionDetail(updateInfo?: UpdateInfo) {
  if (!updateInfo) return "未检查更新";
  if (updateInfo.hasUpdate) return `可更新到 ${updateInfo.latestVersion ?? "新版本"}`;
  if (updateInfo.error) return "检查失败";
  return "已是当前版本";
}

function coreStatusText(status: string | undefined) {
  if (status === "running") return "运行中";
  if (status === "starting") return "启动中";
  if (status === "failed") return "失败";
  if (status === "stopped") return "已停止";
  if (status === "uninitialized") return "未初始化";
  return displayText(status, "未知");
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

function PathItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="settings-path-item">
      <Tag icon={<SettingsIcon size={13} />}>{label}</Tag>
      <code>{value}</code>
    </div>
  );
}
