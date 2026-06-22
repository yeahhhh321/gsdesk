import type { ReactNode } from "react";
import { ExternalLink, Gauge, HardDrive, History, Settings, Terminal, Wrench } from "lucide-react";

export type AppRouteKey =
  | "overview"
  | "webconsole"
  | "logs"
  | "settings"
  | "environment_runtime"
  | "environment_update"
  | "operation_records";

export type AppSectionKey = AppRouteKey;

interface AppRoute {
  key: AppRouteKey;
  icon: ReactNode;
  label: string;
  description: string;
}

export const appRoutes: AppRoute[] = [
  { key: "overview", icon: <Gauge size={18} />, label: "运行总控台", description: "管理 Core 状态、启动入口和首启流程" },
  { key: "webconsole", icon: <ExternalLink size={18} />, label: "WebConsole", description: "打开 gsuid_core 自带 WebConsole" },
  { key: "logs", icon: <Terminal size={18} />, label: "Core 日志", description: "查看 Core JSONL 文件日志" },
  {
    key: "environment_runtime",
    icon: <Wrench size={18} />,
    label: "检测处理",
    description: "查看阻断项、执行修复、定位故障并跟踪任务",
  },
  {
    key: "environment_update",
    icon: <HardDrive size={18} />,
    label: "Core 管理",
    description: "更新、回滚、备份或清理 Core 运行时数据",
  },
  {
    key: "operation_records",
    icon: <History size={18} />,
    label: "操作记录",
    description: "查看初始化、启动、停止、修复和更新任务",
  },
  {
    key: "settings",
    icon: <Settings size={18} />,
    label: "设置",
    description: "管理偏好、网络源、Core 路径和自动检查策略",
  },
];

const beginnerRouteKeys = new Set<AppRouteKey>([
  "overview",
  "webconsole",
  "logs",
  "environment_runtime",
  "environment_update",
  "settings",
]);

export const sectionMeta = Object.fromEntries(appRoutes.map((section) => [section.key, section])) as Record<
  AppRouteKey,
  AppRoute
>;

const navItems = appRoutes.map(navItemForRoute);

export function navItemsForMode(beginnerMode: boolean) {
  if (!beginnerMode) return navItems;
  return appRoutes.filter((route) => beginnerRouteKeys.has(route.key)).map(navItemForRoute);
}

function navItemForRoute(route: AppRoute) {
  return { key: route.key, icon: route.icon, label: route.label };
}
