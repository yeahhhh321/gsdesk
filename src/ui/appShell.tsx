import { useState } from "react";
import { Badge, Button, Layout, Menu, Tooltip, Typography } from "antd";
import { PanelLeftClose, PanelLeftOpen, RefreshCcw } from "lucide-react";
import type { ServiceStatus } from "../types";
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
}

export function AppSidebar({ activeKey, coreStatus, version, beginnerMode, onSelect }: AppSidebarProps) {
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
    </Sider>
  );
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
