import type { ReactNode } from "react";
import { ExternalLink, FileArchive, Gauge, Globe, HardDrive, RefreshCw, Settings, Terminal, Wrench } from "lucide-react";

export type AppRouteKey =
  | "overview"
  | "webconsole"
  | "logs"
  | "settings"
  | "shell_update"
  | "network_settings"
  | "network_checks"
  | "environment_runtime"
  | "environment_repair"
  | "environment_update"
  | "environment_data"
  | "environment_tasks"
  | "diagnostics_export"
  | "diagnostics_failures";

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
    key: "settings",
    icon: <Settings size={18} />,
    label: "偏好设置",
    description: "管理使用模式、窗口关闭和自动检查策略",
  },
  {
    key: "shell_update",
    icon: <RefreshCw size={18} />,
    label: "壳更新",
    description: "检查并安装 GSDesk 壳更新",
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
    label: "环境预检",
    description: "查看系统、工具链、端口、权限、磁盘和运行时阻断项",
  },
  {
    key: "environment_repair",
    icon: <Wrench size={18} />,
    label: "运行时修复",
    description: "准备 uv、初始化 Core 运行时并执行依赖修复",
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
    label: "运行时备份",
    description: "导出、恢复或清理 GSDesk 运行时数据",
  },
  { key: "environment_tasks", icon: <HardDrive size={18} />, label: "任务历史", description: "查看初始化、启动、停止和修复任务" },
  {
    key: "diagnostics_export",
    icon: <FileArchive size={18} />,
    label: "诊断导出",
    description: "生成本机诊断包",
  },
  {
    key: "diagnostics_failures",
    icon: <FileArchive size={18} />,
    label: "故障摘要",
    description: "查看当前建议和最近日志错误段",
  },
];

const beginnerRouteKeys = new Set<AppRouteKey>([
  "overview",
  "webconsole",
  "logs",
  "settings",
  "shell_update",
  "network_checks",
  "environment_runtime",
  "environment_repair",
  "environment_tasks",
  "diagnostics_export",
  "diagnostics_failures",
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
