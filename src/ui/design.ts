import type { ThemeConfig } from "antd";

export const antdTheme: ThemeConfig = {
  token: {
    colorPrimary: "#256d85",
    colorInfo: "#256d85",
    colorText: "#1c2430",
    colorTextSecondary: "#64748b",
    colorBgLayout: "#f6f7f9",
    colorBgContainer: "#ffffff",
    colorBorder: "#e3e7ed",
    borderRadius: 8,
    fontFamily: 'Inter, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
  },
  components: {
    Button: {
      controlHeight: 36,
      borderRadius: 8,
    },
    Layout: {
      headerBg: "#ffffff",
      siderBg: "#ffffff",
    },
    Menu: {
      itemSelectedBg: "#e8f2f5",
      itemSelectedColor: "#256d85",
      itemBorderRadius: 8,
    },
  },
};
