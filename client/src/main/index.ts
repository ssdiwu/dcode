import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HostBridge } from "../host/bridge.js";

/**
 * 平台壳（议题二七项职责的最小实现）：窗口 + Host 看护 + 事件转发。
 * 不承载任何 Project / Task / Session 产品语义。
 */
const here = fileURLToPath(new URL(".", import.meta.url));
const DEV_RENDERER_URL = process.env.DCODE_RENDERER_URL;

let mainWindow: BrowserWindow | null = null;
let bridge: HostBridge | null = null;

function resolveHostEntryPath(): string {
  const override = process.env.DCODE_HOST_ENTRY;
  if (override) return override;
  // electron . 从 client/ 启动；host 产物在相邻目录。
  return join(here, "..", "..", "..", "..", "host", "dist", "src", "index.js");
}

function resolveAgentDirPath(): string {
  return (
    process.env.DCODE_AGENT_DIR ?? join(app.getPath("home"), ".pi", "agent")
  );
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    title: "D Code",
    show: false,
    webPreferences: {
      preload: join(here, "..", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  if (DEV_RENDERER_URL) {
    await mainWindow.loadURL(DEV_RENDERER_URL);
  } else {
    await mainWindow.loadFile(join(here, "..", "renderer", "index.html"));
  }
}

void app.whenReady().then(async () => {
  bridge = await HostBridge.start({
    executablePath: process.execPath,
    executableIsElectron: true,
    hostEntryPath: resolveHostEntryPath(),
    agentDirPath: resolveAgentDirPath(),
    onStderr: text => console.error(`[host] ${text.trimEnd()}`),
  });
  bridge.onEvent(event => {
    mainWindow?.webContents.send("dcode:event", event);
  });
  bridge.onExit((code, signal) => {
    // 崩溃域分离：壳存活，如实把核心退出事件交给界面呈现恢复入口。
    mainWindow?.webContents.send("dcode:event", {
      version: 1,
      type: "event",
      event: "host.exit",
      data: { code, signal: signal ?? null },
    });
  });

  ipcMain.handle(
    "dcode:request",
    (_event, method: string, params?: Record<string, unknown>) => {
      if (!bridge) throw new Error("host bridge is not ready");
      return bridge.request(method, params ?? {});
    },
  );

  await createWindow();
});

app.on("window-all-closed", () => {
  void (async () => {
    await bridge?.shutdown();
    app.quit();
  })();
});
