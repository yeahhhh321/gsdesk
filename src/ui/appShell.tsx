import { useState } from "react";
import { App as AntdApp, Badge, Button, Layout, Menu, Tooltip, Typography } from "antd";
import { AlertCircle, CheckCircle2, Download, PanelLeftClose, PanelLeftOpen, RefreshCcw, RefreshCw } from "lucide-react";
import type { ServiceStatus, UpdateInfo } from "../types";
import appIconUrl from "../assets/genshinuid-icon.png";
import { navItemsForMode, sectionMeta, type AppSectionKey } from "./appSections";
import { displayText } from "./format";
import { statusText } from "./status";

const { Header, Sider } = Layout;
const { Text, Title } = Typography;

interface AppSidebarProps {
  activeKey: AppSectionKey;
  coreStatus: ServiceStatus;
  version?: string;
  beginnerMode: boolean;
  onSelect: (key: AppSectionKey) => void;
  updateInfo?: UpdateInfo;
  loadingAction?: string;
  onCheckShellUpdate: () => void | Promise<unknown>;
  onInstallShellUpdate: () => void | Promise<unknown>;
}

export function AppSidebar({
  activeKey,
  coreStatus,
  version,
  beginnerMode,
  onSelect,
  updateInfo,
  loadingAction,
  onCheckShellUpdate,
  onInstallShellUpdate,
}: AppSidebarProps) {
  const [collapsed, setCollapsed] = useState(false);
  const toggleLabel = collapsed ? "展开侧边栏" : "收起侧边栏";
  const statusLabel = `Core ${statusText[coreStatus]} / v${displayText(version, "0.1.0")}`;

  return (
    <Sider width={224} collapsedWidth={72} collapsed={collapsed} trigger={null} className="sidebar">
      <div className="brand">
        <img className="brand-mark" src={appIconUrl} alt="GSDesk" />
        {!collapsed && (
          <div>
            <div className="brand-name">GSDesk</div>
            <div className="brand-subtitle">gsuid_core 桌面管家</div>
          </div>
        )}
      </div>
      <Menu
        mode="inline"
        inlineCollapsed={collapsed}
        selectedKeys={[activeKey]}
        onSelect={({ key }) => onSelect(key as AppSectionKey)}
        items={navItemsForMode(beginnerMode)}
      />
      <div className="sidebar-bottom">
        <SidebarUpdateButton
          collapsed={collapsed}
          updateInfo={updateInfo}
          loadingAction={loadingAction}
          onCheckShellUpdate={onCheckShellUpdate}
          onInstallShellUpdate={onInstallShellUpdate}
        />
        <div className="sidebar-footer">
          {collapsed ? (
            <Tooltip title={statusLabel} placement="right">
              <Badge status={coreStatus === "running" ? "success" : "default"} />
            </Tooltip>
          ) : (
            <>
              <Badge status={coreStatus === "running" ? "success" : "default"} text={statusText[coreStatus]} />
              <Text type="secondary">v{displayText(version, "0.1.0")}</Text>
            </>
          )}
          <Tooltip title={toggleLabel} placement="right">
            <Button
              size="small"
              type="text"
              aria-label={toggleLabel}
              icon={collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
              onClick={() => setCollapsed((value) => !value)}
            />
          </Tooltip>
        </div>
      </div>
    </Sider>
  );
}

interface SidebarUpdateButtonProps {
  collapsed: boolean;
  updateInfo?: UpdateInfo;
  loadingAction?: string;
  onCheckShellUpdate: () => void | Promise<unknown>;
  onInstallShellUpdate: () => void | Promise<unknown>;
}

function SidebarUpdateButton({
  collapsed,
  updateInfo,
  loadingAction,
  onCheckShellUpdate,
  onInstallShellUpdate,
}: SidebarUpdateButtonProps) {
  const { modal } = AntdApp.useApp();
  const state = shellUpdateButtonState(updateInfo, loadingAction);

  function handleClick() {
    if (state.installing || state.checking) return;
    if (!updateInfo?.hasUpdate) {
      void onCheckShellUpdate();
      return;
    }
    modal.confirm({
      title: "下载并安装 GSDesk 更新",
      content: `将安装 ${displayText(updateInfo.latestVersion, "新版本")}，完成后会重启 GSDesk。Core 默认保留在后台运行。`,
      okText: "安装更新",
      cancelText: "取消",
      onOk: onInstallShellUpdate,
    });
  }

  const button = (
    <Button
      block={!collapsed}
      size="small"
      type={state.type}
      danger={state.danger}
      loading={state.checking || state.installing}
      icon={state.icon}
      aria-label={state.tooltip}
      className={`sidebar-update-button ${state.className}`}
      onClick={handleClick}
    >
      {!collapsed && state.label}
    </Button>
  );

  return collapsed ? (
    <Tooltip title={state.tooltip} placement="right">
      {button}
    </Tooltip>
  ) : (
    button
  );
}

function shellUpdateButtonState(updateInfo: UpdateInfo | undefined, loadingAction: string | undefined) {
  if (loadingAction === "install_shell_update") {
    return {
      label: "安装中",
      tooltip: "正在安装 GSDesk 壳更新",
      icon: <Download size={15} />,
      type: "primary" as const,
      danger: false,
      checking: false,
      installing: true,
      className: "is-installing",
    };
  }
  if (loadingAction === "update") {
    return {
      label: "检查中",
      tooltip: "正在检查 GSDesk 壳更新",
      icon: <RefreshCw size={15} />,
      type: "default" as const,
      danger: false,
      checking: true,
      installing: false,
      className: "is-checking",
    };
  }
  if (updateInfo?.hasUpdate) {
    const version = displayText(updateInfo.latestVersion, "新版本");
    return {
      label: `更新 ${version}`,
      tooltip: `发现 GSDesk ${version}，点击安装`,
      icon: <Download size={15} />,
      type: "primary" as const,
      danger: false,
      checking: false,
      installing: false,
      className: "is-available",
    };
  }
  if (updateInfo?.error) {
    return {
      label: "检查失败",
      tooltip: "壳更新检查失败，点击重试",
      icon: <AlertCircle size={15} />,
      type: "default" as const,
      danger: true,
      checking: false,
      installing: false,
      className: "is-error",
    };
  }
  if (updateInfo) {
    return {
      label: "已是最新",
      tooltip: "当前壳已是最新，点击重新检查",
      icon: <CheckCircle2 size={15} />,
      type: "default" as const,
      danger: false,
      checking: false,
      installing: false,
      className: "is-current",
    };
  }
  return {
    label: "检查更新",
    tooltip: "检查 GSDesk 壳更新",
    icon: <RefreshCw size={15} />,
    type: "default" as const,
    danger: false,
    checking: false,
    installing: false,
    className: "is-unknown",
  };
}

interface AppHeaderProps {
  activeKey: AppSectionKey;
  onRefresh: () => void;
}

export function AppHeader({ activeKey, onRefresh }: AppHeaderProps) {
  const section = sectionMeta[activeKey];
  return (
    <Header className="topbar">
      <div>
        <Title level={4}>{section.label}</Title>
        <Text type="secondary">{section.description}</Text>
      </div>
      <Button icon={<RefreshCcw size={16} />} onClick={onRefresh}>
        刷新
      </Button>
    </Header>
  );
}
