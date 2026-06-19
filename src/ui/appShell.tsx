import { Badge, Button, Layout, Menu, Tag, Typography } from "antd";
import type { ReactNode } from "react";
import {
  ExternalLink,
  FileArchive,
  Gauge,
  Globe,
  HardDrive,
  RefreshCcw,
  Terminal,
} from "lucide-react";
import type { ServiceStatus } from "../types";

const { Header, Sider } = Layout;
const { Text, Title } = Typography;

export type AppSectionKey =
  | "overview"
  | "webconsole"
  | "logs"
  | "environment"
  | "network"
  | "diagnostics";

export const statusText: Record<ServiceStatus, string> = {
  uninitialized: "未初始化",
  checking: "检测中",
  initializing: "初始化中",
  starting: "启动中",
  running: "运行中",
  stopping: "停止中",
  stopped: "已停止",
  failed: "失败",
  crashed: "已崩溃",
};

export const statusColor: Record<ServiceStatus, string> = {
  uninitialized: "default",
  checking: "processing",
  initializing: "processing",
  starting: "processing",
  running: "success",
  stopping: "warning",
  stopped: "default",
  failed: "error",
  crashed: "error",
};

const sections: Array<{ key: AppSectionKey; icon: ReactNode; label: string; description: string }> = [
  { key: "overview", icon: <Gauge size={18} />, label: "运行总控台", description: "管理 Core 状态、启动入口和首启流程" },
  { key: "webconsole", icon: <ExternalLink size={18} />, label: "WebConsole", description: "打开 gsuid_core 自带 WebConsole" },
  { key: "logs", icon: <Terminal size={18} />, label: "终端日志", description: "查看 Core 文件日志和启动失败原始信息" },
  { key: "environment", icon: <HardDrive size={18} />, label: "环境与修复", description: "检查隔离目录、uv、Python 和依赖状态" },
  { key: "network", icon: <Globe size={18} />, label: "网络与设置", description: "配置源码源、PyPI 镜像、代理和基础偏好" },
  { key: "diagnostics", icon: <FileArchive size={18} />, label: "诊断导出", description: "导出诊断包并检查壳更新" },
];

export const sectionMeta = Object.fromEntries(sections.map((section) => [section.key, section])) as Record<
  AppSectionKey,
  (typeof sections)[number]
>;

const navItems = sections.map(({ key, icon, label }) => ({ key, icon, label }));

interface AppSidebarProps {
  activeKey: AppSectionKey;
  coreStatus: ServiceStatus;
  version?: string;
  onSelect: (key: AppSectionKey) => void;
}

export function AppSidebar({ activeKey, coreStatus, version, onSelect }: AppSidebarProps) {
  return (
    <Sider width={236} className="sidebar">
      <div className="brand">
        <div className="brand-mark">GS</div>
        <div>
          <div className="brand-name">GSDesk</div>
          <div className="brand-subtitle">gsuid_core 桌面管家</div>
        </div>
      </div>
      <Menu
        mode="inline"
        selectedKeys={[activeKey]}
        onSelect={({ key }) => onSelect(key as AppSectionKey)}
        items={navItems}
      />
      <div className="sidebar-footer">
        <Badge status={coreStatus === "running" ? "success" : "default"} text={statusText[coreStatus]} />
        <Text type="secondary">v{version || "0.1.0"}</Text>
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

export function StatusTag({ status }: { status: ServiceStatus }) {
  return <Tag color={statusColor[status]}>{statusText[status]}</Tag>;
}
