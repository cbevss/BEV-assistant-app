import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// fileURLToPath (not URL.pathname) so Windows drive letters resolve correctly.
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Tauri expects a fixed port.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": r("./src") },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  // Two entry points: the main app window and the lightweight overlay.
  build: {
    target: "esnext",
    rollupOptions: {
      input: {
        main: r("./index.html"),
        overlay: r("./overlay.html"),
      },
    },
  },
});
