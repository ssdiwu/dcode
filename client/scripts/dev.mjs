#!/usr/bin/env node
/**
 * 开发 / 截图启动器。
 *   node scripts/dev.mjs                 → vite dev server + electron（窗口）
 *   node scripts/dev.mjs --no-vite       → 直接 electron 加载已构建产物
 *   node scripts/dev.mjs --capture <png> → 加载后截取主窗口并退出
 * Host 始终是独立子进程（ELECTRON_RUN_AS_NODE），可按需指向隔离数据根。
 */
import { spawn } from "node:child_process";
import { once } from "node:events";

const args = process.argv.slice(2);
const captureIndex = args.indexOf("--capture");
const capturePath = captureIndex !== -1 ? args[captureIndex + 1] : null;
const noVite = args.includes("--no-vite") || capturePath !== null;

const children = [];
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill("SIGTERM");
  process.exit(code);
}

process.on("SIGINT", () => shutdown(130));
process.on("exit", () => {
  for (const child of children) child.kill("SIGTERM");
});

async function waitForRenderer(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not ready yet
    }
    if (Date.now() > deadline) throw new Error(`renderer not ready: ${url}`);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

if (!noVite) {
  const vite = spawn("node", ["node_modules/vite/bin/vite.js"], {
    cwd: new URL("..", import.meta.url).pathname,
    stdio: "inherit",
  });
  children.push(vite);
  vite.on("exit", code => {
    if (!shuttingDown) {
      console.error(`vite exited early (${code})`);
      shutdown(code ?? 1);
    }
  });
  await waitForRenderer("http://127.0.0.1:5173/");
}

const env = { ...process.env };
if (!noVite) env.DCODE_RENDERER_URL = "http://127.0.0.1:5173/";
if (capturePath) env.DCODE_CAPTURE = capturePath;

const electron = spawn(
  "node",
  ["node_modules/electron/cli.js", "."],
  { cwd: new URL("..", import.meta.url).pathname, env, stdio: "inherit" },
);
children.push(electron);
const [code] = await once(electron, "exit");
shutdown(code ?? 0);
