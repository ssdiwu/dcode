import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

const rendererRoot = fileURLToPath(new URL("./src/renderer", import.meta.url));
const devPort = 5173;

export default defineConfig({
  root: rendererRoot,
  base: "./",
  plugins: [
    {
      name: "development-renderer-websocket-csp",
      apply: "serve",
      transformIndexHtml(html) {
        const directive = "connect-src 'self';";
        if (!html.includes(directive)) throw new Error("Renderer CSP connect-src missing");
        return html.replace(directive, `connect-src 'self' ws://127.0.0.1:${devPort};`);
      },
    },
    {
      name: "threeui-registered-variants",
      resolveId(id, importer) {
        if (id.startsWith("../") && importer?.includes("/vendor/threeui/src/shaders/structure-flow/")) {
          return resolve(rendererRoot, "../../node_modules/@designcodeio/threeui/lib-dist/shaders/structure-flow", `${id}.js`);
        }
      },
    },
    react(), tailwindcss(),
  ],
  build: {
    outDir: join(rendererRoot, "..", "..", "dist", "renderer"),
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: devPort,
    strictPort: true,
  },
});
