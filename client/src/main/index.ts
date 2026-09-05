import { app, BrowserWindow, ipcMain, nativeTheme } from "electron";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { HostBridge } from "../host/bridge.js";

/**
 * 平台壳（议题二七项职责的最小实现）：窗口 + Host 看护 + 事件转发。
 * 不承载任何 Project / Task / Session 产品语义。
 */
const here = fileURLToPath(new URL(".", import.meta.url));
const DEV_RENDERER_URL = process.env.DCODE_RENDERER_URL;
const CAPTURE_PATH = process.env.DCODE_CAPTURE;

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

function resolveDataRootPath(): string | undefined {
  return process.env.DCODE_DATA_ROOT;
}

async function createWindow(): Promise<void> {
  const width = Number.parseInt(process.env.DCODE_WIDTH ?? "1440", 10);
  mainWindow = new BrowserWindow({
    width: Number.isFinite(width) ? width : 1440,
    height: 900,
    minWidth: 640,
    minHeight: 480,
    title: "D Code",
    show: false,
    backgroundColor: "#1c1c1e",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 12 },
    webPreferences: {
      preload: join(here, "..", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  const query: Record<string, string> = {};
  if (process.env.DCODE_OPEN_DETAIL === "1") query["detail"] = "1";
  if (process.env.DCODE_OPEN_HUD === "1") query["hud"] = "1";
  if (process.env.DCODE_FIXTURES === "1") query["fixtures"] = "1";
  if (process.env.DCODE_VIEW) query["view"] = process.env.DCODE_VIEW;
  if (DEV_RENDERER_URL) {
    const url = new URL(DEV_RENDERER_URL);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    await mainWindow.loadURL(url.toString());
  } else {
    await mainWindow.loadFile(join(here, "..", "..", "renderer", "index.html"), {
      query,
    });
  }
}

/** DCODE_CAPTURE=path 时截取主窗口画面后退出（视觉验收用，不开截图应用）。 */
async function captureThenQuit(): Promise<void> {
  if (!CAPTURE_PATH || !mainWindow) return;
  await delay(3_500);
  if (!mainWindow) return;
  const diagnostics = await mainWindow.webContents
    .executeJavaScript(
      `(() => {
        try {
          const pick = selector => {
            const el = document.querySelector(selector);
            if (!el) return null;
            const style = getComputedStyle(el);
            return style.backgroundColor || style.color;
          };
          return {
            ok: true,
            dark: matchMedia("(prefers-color-scheme: dark)").matches,
            rootColorScheme: getComputedStyle(document.documentElement).colorScheme,
            nav: pick(".bg-nav"),
            canvas: pick(".bg-canvas"),
            raised: pick(".bg-raised"),
            rootVars: (() => {
              const style = getComputedStyle(document.documentElement);
              return { nav: style.getPropertyValue("--c-nav").trim(), raised: style.getPropertyValue("--c-raised").trim() };
            })(),
            geometry: (() => {
              const root = document.getElementById("root");
              const body = document.body;
              const appEl = root ? root.firstElementChild : null;
              const rect = el => {
                if (!el) return "null";
                const box = el.getBoundingClientRect();
                return Math.round(box.width) + "x" + Math.round(box.height);
              };
              return {
                body: rect(body),
                root: rect(root),
                app: rect(appEl),
                appClass: appEl ? appEl.className : "",
                bodyBg: body ? getComputedStyle(body).backgroundColor : "",
              };
            })(),
          };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      })()`,
    )
    .catch((error: unknown) => ({ ok: false, error: String(error) }));
  console.log(`[dcode] diagnostics ${JSON.stringify(diagnostics)}`);
  const image = await mainWindow.webContents.capturePage();
  const target = CAPTURE_PATH.replace("{width}", String(mainWindow.getContentBounds().width));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, image.toPNG());
  console.log(`[dcode] captured ${target}`);
  app.quit();
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

void app
  .whenReady()
  .then(async () => {
    const theme = process.env.DCODE_THEME;
    if (theme === "dark" || theme === "light") nativeTheme.themeSource = theme;
    bridge = await HostBridge.start({
      executablePath: process.execPath,
      executableIsElectron: true,
      hostEntryPath: resolveHostEntryPath(),
      agentDirPath: resolveAgentDirPath(),
      dataRootPath: resolveDataRootPath(),
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
    await captureThenQuit();
  })
  .catch((error: unknown) => {
    console.error(
      `[dcode] startup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    app.quit();
  });

app.on("window-all-closed", () => {
  void (async () => {
    await bridge?.shutdown();
    app.quit();
  })();
});
