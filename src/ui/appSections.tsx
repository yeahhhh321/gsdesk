import type { ReactNode } from "react";
import { ExternalLink, FileArchive, Gauge, Globe, HardDrive, Settings, Terminal } from "lucide-react";

export type AppRouteKey =
  | "overview"
  | "webconsole"
  | "logs"
  | "settings"
  | "network_settings"
  | "network_checks"
  | "environment_runtime"
  | "environment_update"
  | "environment_data"
  | "environment_tasks"
  | "diagnostics_export"
  | "diagnostics_failures";

export type AppSectionKey = AppRouteKey;
export type AppNavGroupKey = "network" | "environment" | "diagnostics";

interface AppRoute {
  key: AppRouteKey;
  icon: ReactNode;
  label: string;
  description: string;
}

interface AppNavGroup {
  key: AppNavGroupKey;
  icon: ReactNode;
  label: string;
  children: AppRoute[];
}

type AppNavEntry = AppRoute | AppNavGroup;

export const appRoutes: AppRoute[] = [
  { key: "overview", icon: <Gauge size={18} />, label: "运行总控台", description: "管理 Core 状态、启动入口和首启流程" },
  { key: "webconsole", icon: <ExternalLink size={18} />, label: "WebConsole", description: "打开 gsuid_core 自带 WebConsole" },
  { key: "logs", icon: <Terminal size={18} />, label: "Core 日志", description: "查看 Core JSONL 文件日志" },
  {
    key: "settings",
    icon: <Settings size={18} />,
    label: "设置",
    description: "管理 GSDesk 版本、壳更新、窗口关闭和后台运行策略",
  },
  {
    key: "network_settings",
    icon: <Globe size={18} />,
    label: "网络设置",
    description: "配置源码源、PyPI 镜像、Core 路径、端口和代理",
  },
  {
    key: "network_checks",
    icon: <Globe size={18} />,
    label: "网络检测",
    description: "探测源码源、测速 PyPI，并诊断本机 WebConsole 连通性",
  },
  {
    key: "environment_runtime",
    icon: <HardDrive size={18} />,
    label: "预检修复",
    description: "检查系统、工具链、端口、权限、磁盘、Core 源码和 venv",
  },
  {
    key: "environment_update",
    icon: <HardDrive size={18} />,
    label: "Core 更新",
    description: "检查、更新、清理差异，并选择 commit 回滚 Core",
  },
  {
    key: "environment_data",
    icon: <HardDrive size={18} />,
    label: "数据维护",
    description: "处理运行时备份、设置迁移、目录打开和本机数据清理",
  },
  { key: "environment_tasks", icon: <HardDrive size={18} />, label: "任务历史", description: "查看初始化、启动、停止和修复任务" },
  {
    key: "diagnostics_export",
    icon: <FileArchive size={18} />,
    label: "诊断更新",
    description: "导出诊断包并检查 GSDesk 壳更新",
  },
  {
    key: "diagnostics_failures",
    icon: <FileArchive size={18} />,
    label: "故障摘要",
    description: "查看当前建议和最近日志错误段",
  },
];

const standaloneRoutes = appRoutes.filter((route) => ["overview", "webconsole", "logs", "settings"].includes(route.key));

const networkRoutes = appRoutes.filter((route) => route.key.startsWith("network_"));
const environmentRoutes = appRoutes.filter((route) => route.key.startsWith("environment_"));
const diagnosticsRoutes = appRoutes.filter((route) => route.key.startsWith("diagnostics_"));
const beginnerRouteKeys = new Set<AppRouteKey>([
  "overview",
  "webconsole",
  "logs",
  "settings",
  "network_checks",
  "environment_runtime",
  "environment_tasks",
  "diagnostics_export",
  "diagnostics_failures",
]);

export const appNavigation: AppNavEntry[] = [
  ...standaloneRoutes,
  { key: "network", icon: <Globe size={18} />, label: "网络与源", children: networkRoutes },
  { key: "environment", icon: <HardDrive size={18} />, label: "环境与修复", children: environmentRoutes },
  { key: "diagnostics", icon: <FileArchive size={18} />, label: "诊断导出", children: diagnosticsRoutes },
];

export const sectionMeta = Object.fromEntries(appRoutes.map((section) => [section.key, section])) as Record<
  AppRouteKey,
  AppRoute
>;

export const routeParentKey = Object.fromEntries(
  appNavigation.flatMap((entry) => ("children" in entry ? entry.children.map((child) => [child.key, entry.key]) : [])),
) as Partial<Record<AppRouteKey, AppNavGroupKey>>;

const navItems = appNavigation.map((entry) => {
  return navItemForEntry(entry);
});

export function navItemsForMode(beginnerMode: boolean) {
  if (!beginnerMode) return navItems;
  return appNavigation.flatMap((entry) => {
    if (!("children" in entry)) {
      return beginnerRouteKeys.has(entry.key) ? [navItemForEntry(entry)] : [];
    }
    const children = entry.children.filter((child) => beginnerRouteKeys.has(child.key));
    if (!children.length) return [];
    return [
      {
        key: entry.key,
        icon: entry.icon,
        label: entry.label,
        children: children.map(({ key, label }) => ({ key, label })),
      },
    ];
  });
}

function navItemForEntry(entry: AppNavEntry) {
  if ("children" in entry) {
    return {
      key: entry.key,
      icon: entry.icon,
      label: entry.label,
      children: entry.children.map(({ key, label }) => ({ key, label })),
    };
  }
  return { key: entry.key, icon: entry.icon, label: entry.label };
}
