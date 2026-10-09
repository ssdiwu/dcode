import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig({
  main: {
    resolve: { alias: { "@": src } },
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
