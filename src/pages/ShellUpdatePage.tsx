import { Alert, App as AntdApp, Button } from "antd";
import { Download, RefreshCw } from "lucide-react";
import { updateDescription, updateMessage } from "./diagnosticsRules";
import { WidePanel } from "../ui/pageTabs";
import { PanelHeader, SectionActions } from "../ui/primitives";
import type { UpdateInfo } from "../types";

interface ShellUpdatePageProps {
  updateInfo?: UpdateInfo;
  loadingAction?: string;
  onCheckShellUpdate: () => void;
  onInstallShellUpdate: () => void;
}

export default function ShellUpdatePage({
  updateInfo,
  loadingAction,
  onCheckShellUpdate,
  onInstallShellUpdate,
}: ShellUpdatePageProps) {
  const { modal } = AntdApp.useApp();

  function confirmInstall() {
    modal.confirm({
      title: "下载并安装 GSDesk 更新",
      content: "更新会下载官方 Release 产物，完成校验后安装并重启 GSDesk。",
      okText: "安装更新",
      cancelText: "取消",
      onOk: onInstallShellUpdate,
    });
  }

  return (
    <section className="page-grid">
      <WidePanel>
        <PanelHeader title="壳更新" description="只检查和安装 GSDesk 壳；Core 更新在 Core 更新页处理" />
        <SectionActions>
          <Button icon={<RefreshCw size={16} />} loading={loadingAction === "update"} onClick={onCheckShellUpdate}>
            检查更新
          </Button>
          {updateInfo?.hasUpdate && (
            <Button
              type="primary"
              icon={<Download size={16} />}
              loading={loadingAction === "install_shell_update"}
              onClick={confirmInstall}
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
    </section>
  );
}
