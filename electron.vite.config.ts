import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig({
  main: {
    resolve: { alias: { "@": src } },
    build: {
      rollupOptions: {
        // 只把完整 coding-agent SDK 外部化：它的公开根会静态 re-export 交互层 TUI，
        // 且传递依赖里的 jiti 带 CJS shim（esbuild 转译会报 Unterminated string literal）。
        // 外部化后由宿主在运行时从 node_modules 解析，不进主进程构建图；
        // 其余 Pi 包（pi-ai/pi-durable/chord）保持既有内联行为不动。
        external: ["@earendil-works/pi-coding-agent"],
      },
    },
  },
  preload: {
    resolve: { alias: { "@": src } },
    // 预加载强制 CJS：ESM 预加载的完成时机可能晚于页面脚本，导致桥间歇缺失
    build: { rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } } },
  },
  renderer: {
    root: "src/renderer",
    plugins: [react(), tailwindcss()],
    resolve: { alias: { "@": src } },
  },
});
