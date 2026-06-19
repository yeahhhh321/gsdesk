import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          const modulePath = id.replace(/\\/g, "/");
          if (modulePath.includes("/react/") || modulePath.includes("/react-dom/") || modulePath.includes("/scheduler/")) {
            return "vendor-react";
          }
          if (
            modulePath.includes("/antd/") ||
            modulePath.includes("/@ant-design/") ||
            modulePath.includes("/rc-") ||
            modulePath.includes("/@rc-component/")
          ) {
            return undefined;
          }
          if (modulePath.includes("/lucide-react/")) return "vendor-icons";
          if (modulePath.includes("/@tauri-apps/")) return "vendor-tauri";
          return "vendor";
        },
      },
    },
  },
  server: {
    strictPort: true,
    host: "127.0.0.1",
    port: 1420,
  },
  envPrefix: ["VITE_", "TAURI_"],
});
