import {closePreviewProxy} from "./preview-network.js";
import { HTMLPreview } from "./html-preview.js";
import { readLegacyPreferences } from "./legacy-preferences.js";
import { switchApplication } from "./candidate-switch.js";
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeTheme,
  Notification,
  dialog,
  shell,
  type IpcMainInvokeEvent,
} from "electron";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { HostBridge } from "../host/bridge.js";
import { resolveClientPaths } from "./paths.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const paths = resolveClientPaths(here, app.isPackaged, process.resourcesPath);
const devUrl = process.env.DCODE_RENDERER_URL;
if (devUrl && !/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(devUrl))
  throw new Error("Invalid development renderer URL");
const rendererUrl = devUrl ?? pathToFileURL(paths.renderer).href;
let window: BrowserWindow | null = null;
let bridge: HostBridge | null = null;
let restarting: Promise<boolean> | null = null;
let quitting = false;
let shutdownComplete = false;
let notifyEnabled = true;
let fontZoom = 1;
const diagnostics: { time: string; message: string }[] = [];
function diagnostic(message: string) {
  diagnostics.push({ time: new Date().toISOString(), message });
  if (diagnostics.length > 200) diagnostics.shift();
}
let quitAck: ((error?: string) => void) | null = null;
app.setName("D Code");
if(process.env.DCODE_USER_DATA) app.setPath("userData",process.env.DCODE_USER_DATA);
const sendEvent = (event: string, data?: unknown) => {
  if (window && !window.isDestroyed())
    window.webContents.send("dcode:event", {
      version: 1,
      type: "event",
      event,
      data,
    });
};
function assertSender(event: IpcMainInvokeEvent): void {
  if (
    event.sender !== window?.webContents ||
    event.senderFrame !== window.webContents.mainFrame ||
    event.senderFrame.url.split("?")[0] !== rendererUrl
  )
    throw new Error("Untrusted IPC sender");
}
function hostOptions() {
  return {
    executablePath: process.execPath,
    executableIsElectron: true,
    hostEntryPath: process.env.DCODE_HOST_ENTRY ?? paths.host,
    agentDirPath:
      process.env.DCODE_AGENT_DIR ?? join(app.getPath("home"), ".pi", "agent"),
    dataRootPath: process.env.DCODE_DATA_ROOT,
    onStderr: (text: string) => console.error(`[host] ${text.trimEnd()}`),
  };
}
async function startHost(): Promise<boolean> {
  const next = await HostBridge.start(hostOptions());
  await next.request("host.hello");
  bridge = next;
  diagnostic("Host 已连接，协议握手完成");
  if (!process.env.DCODE_DATA_ROOT) {
    const snapshot = await next.request<{storeRevision:number}>("foundation.snapshot");
    await next.request("clientPreferences.importLegacy", {requestId:`legacy-preferences-${Date.now()}`, expectedStoreRevision:snapshot.storeRevision, values:await readLegacyPreferences()});
  }
  await refreshNotifications();
  next.onEvent((event) => {
    const data = (event.data ?? {}) as {
      kind?: string;
      outcome?: string;
      runtime?: { taskId?: string };
    };
    if (
      event.event === "foundation.changed" &&
      data.kind === "clientPreferences.updated"
    )
      void refreshNotifications().catch((error) =>
        console.error("[dcode] preferences", String(error)),
      );
    if (
      event.event === "session.durableRunFinished" &&
      data.outcome === "succeeded" &&
      notifyEnabled &&
      Notification.isSupported()
    ) {
      void next
        .request<{ tasks: { id: string; title: string }[] }>(
          "foundation.snapshot",
        )
        .then((snapshot) => {
          if (quitting || !notifyEnabled) return;
          const task = snapshot.tasks.find(
            (t) => t.id === data.runtime?.taskId,
          );
          new Notification({
            title: "本次执行已完成",
            body: task?.title ?? "可以查看执行结果。",
          }).show();
        })
        .catch((error) => console.error("[dcode] notification", String(error)));
    }
    if (window && !window.isDestroyed())
      window.webContents.send("dcode:event", event);
  });
  next.onExit((code, signal) => {
    if (bridge === next && !quitting) {
      bridge = null;
      sendEvent("host.exit", { code, signal });
    }
  });
  sendEvent("host.ready", {protocolVersion:1});
  return true;
}
const trustedHandle = <Args extends unknown[]>(
  channel: string,
  fn: (...args: Args) => unknown,
) =>
  ipcMain.handle(channel, (event, ...args) => {
    assertSender(event);
    return fn(...(args as Args));
  });
const htmlPreview=new HTMLPreview(()=>window,()=>bridge,sendEvent);
function setupIPC() {
  // Dedicated confidential submission: never use the generic request logger.
  ipcMain.handle("dcode:connectApiKey",async(event,providerId:unknown,key:unknown)=>{
    try{
      assertSender(event);
      if(typeof providerId!=="string"||typeof key!=="string")return {ok:false,code:"INVALID_INPUT"};
      if(!bridge)return {ok:false,code:"UNAVAILABLE"};
      return await bridge.connectApiKey(providerId,key);
    }catch{return {ok:false,code:"FAILED"};}
    finally{key=undefined;}
  });
  trustedHandle("dcode:htmlPreview",(input:Record<string,unknown>)=>{
    if(input.action==="update")return htmlPreview.update(input as unknown as Parameters<HTMLPreview["update"]>[0]);
    if(input.action==="bounds")return htmlPreview.bounds(input.bounds as Parameters<HTMLPreview["bounds"]>[0],input.clientId as string|undefined);
    if(input.action==="network"&&typeof input.id==="string"&&typeof input.allow==="boolean")return htmlPreview.allowNetwork(input.id,input.allow);
    if(input.action==="close")return htmlPreview.close(typeof input.clientId==="string"?input.clientId:undefined);
    throw new Error("预览操作无效");
  });
  trustedHandle("dcode:restoreFailed", async () => {
    if (process.env.DCODE_SWITCH_ID && process.env.DCODE_SWITCH_READY) {
      await writeFile(
        process.env.DCODE_SWITCH_READY,
        JSON.stringify({
          id: process.env.DCODE_SWITCH_ID,
          pid: process.pid,
          status: "failed",
        }),
        { flag: "wx", mode: 0o600 },
      );
    }
  });
  trustedHandle(
    "dcode:request",
    (method: string, params: Record<string, unknown> = {}) => {
      if (!bridge) throw new Error("运行服务尚未连接，请重新连接。");
      return bridge
        .request(method, params)
        .then(async result => {
          if (method === "clientPreferences.set" && "appearance" in params) await refreshNotifications();
          return result;
        })
        .catch((error: Error & { code?: string }) => {
          diagnostic(`${method} · ${error.code ?? "HOST_ERROR"}`);
          throw new Error(`${error.code ?? "HOST_ERROR"}: ${error.message}`);
        });
    },
  );
  trustedHandle(
    "dcode:signalReady",
    async (selection: { taskId: string | null; sessionId: string | null }) => {
      const id = process.env.DCODE_SWITCH_ID;
      if (!id || !process.env.DCODE_SWITCH_READY || !bridge) return;
      const { receipts } = await bridge.request<{
        receipts: {
          id: string;
          state: string;
          toApp: string;
          rollbackOf?: string;
          selection: unknown;
        }[];
      }>("selfEvolution.list");
      const receipt = receipts.find((r) => r.id === id);
      if (!receipt) throw new Error("恢复回执不存在");
      const expected = join(receipt.toApp, "Contents/MacOS/D Code");
      if (expected !== process.execPath) throw new Error("恢复应用身份不匹配");
      const snapshot = await bridge.request<{ storeRevision: number }>(
        "foundation.snapshot",
      );
      if (receipt.state === "restart_requested")
        await bridge.request("selfEvolution.transition", {
          requestId: `arrived-${id}`,
          expectedStoreRevision: snapshot.storeRevision,
          id,
          state: "session_restored",
          selection,
        });
      try {
        await writeFile(
          process.env.DCODE_SWITCH_READY,
          JSON.stringify({ id, pid: process.pid }),
          { flag: "wx", mode: 0o600 },
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const prior = JSON.parse(
          await readFile(process.env.DCODE_SWITCH_READY, "utf8"),
        );
        if (prior.id !== id || prior.pid !== process.pid)
          throw new Error("启动确认文件不匹配");
      }
      const go = process.env.DCODE_SWITCH_GO;
      if (go) {
        const timer = setInterval(() => {
          void readFile(go, "utf8")
            .then(async (value) => {
              if (value === id) {
                clearInterval(timer);
                let rollbackRecorded = false;
                if (receipt.rollbackOf && bridge) {
                  try {
                    for (let attempt = 0; ; attempt++) {
                      const current = await bridge.request<{
                        storeRevision: number;
                      }>("foundation.snapshot");
                      try {
                        await bridge.request("selfEvolution.transition", {
                          requestId: `rollback-arrived-${id}`,
                          expectedStoreRevision: current.storeRevision,
                          id,
                          state: "rolled_back",
                        });
                        rollbackRecorded = true;
                        break;
                      } catch (error) {
                        if (
                          attempt >= 3 ||
                          (error as { code?: string }).code !==
                            "REVISION_CONFLICT"
                        )
                          throw error;
                      }
                    }
                  } catch {
                    diagnostic("上一构建已启动，回滚记录需人工确认");
                  }
                }
                window?.show();
                if (!receipt.rollbackOf || !rollbackRecorded)
                  sendEvent("shell.candidateRestored");
                delete process.env.DCODE_SWITCH_ID;
                delete process.env.DCODE_SWITCH_READY;
                delete process.env.DCODE_SWITCH_GO;
              }
            })
            .catch(() => {});
        }, 100);
        setTimeout(() => {
          clearInterval(timer);
          if (process.env.DCODE_SWITCH_ID) app.quit();
        }, 60000);
      }
    },
  );
  trustedHandle(
    "dcode:switchCandidate",
    async (direction: "candidate" | "rollback") => {
      if (!bridge || quitting) throw new Error("当前不能切换应用");
      if (direction !== "candidate" && direction !== "rollback")
        throw new Error("切换方式无效");
      quitting = true;
      try {
        return await switchApplication({
          bridge,
          direction,
          executablePath: process.execPath,
          env: process.env,
          flush: async () => {
            const issue = await new Promise<string | undefined>((resolve) => {
              const timer = setTimeout(() => resolve("界面未完成保存"), 8000);
              quitAck = (error) => {
                clearTimeout(timer);
                resolve(error);
              };
              sendEvent("shell.quitRequested");
            });
            quitAck = null;
            if (issue) throw new Error(issue);
          },
          disconnect: () => {
            bridge = null;
          },
          reconnect: async () => {
            await startHost();
            return bridge!;
          },
          finish: () => {
            shutdownComplete = true;
            app.quit();
          },
        });
      } catch (error) {
        quitting = false;
        sendEvent("shell.quitCancelled");
        throw error;
      }
    },
  );
  trustedHandle("dcode:diagnostics", () => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    hostReady: !!bridge && !bridge.hasExited,
    events: [...diagnostics],
  }));
  trustedHandle("dcode:clearDiagnostics", () => {
    diagnostics.length = 0;
    return true;
  });
  trustedHandle("dcode:notificationSettings", () =>
    shell.openExternal(
      "x-apple.systempreferences:com.apple.Notifications-Settings.extension?bundleId=dev.dcode.desktop",
    ),
  );
  trustedHandle("dcode:revealCandidate", async (path: string) => {
    const state = await bridge?.request<{ candidatePath?: string }>(
      "maintenance.status",
    );
    if (!state?.candidatePath || state.candidatePath !== path)
      throw new Error("候选路径无效");
    shell.showItemInFolder(path);
  });
  trustedHandle("dcode:chooseContextFiles",async()=>{if(!window)return [];const result=await dialog.showOpenDialog(window,{title:"选择任务附加资料",properties:["openFile","multiSelections"],filters:[{name:"文本与代码",extensions:["md","markdown","txt","json","ts","tsx","js","py","swift","yaml","yml","toml"]}]});return result.canceled?[]:result.filePaths;});
  trustedHandle("dcode:chooseDirectory", async () => {
    if (!window) return null;
    const result = await dialog.showOpenDialog(window, {
      title: "选择项目文件夹",
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  trustedHandle("dcode:previewInspiration", async (nodeId:string,media:boolean) => {
    if(!bridge||!window||!/^idea-[a-f0-9-]{36}$/.test(nodeId)||typeof media!=="boolean")throw new Error("灵感预览暂不可用。");
    const file=await bridge.request<{path:string;name?:string}>(media?"inspiration.media":"inspiration.export",{nodeId});
    window.previewFile(file.path,file.name);
  });
  trustedHandle("dcode:previewAttachment", async (id: string) => {
    if (!bridge || !window || typeof id !== "string" || !/^attachment-[a-f0-9]{32}$/.test(id)) throw new Error("附件预览暂不可用。");
    const file=await bridge.request<{path:string;name:string}>("attachment.resolve",{id});
    window.previewFile(file.path,file.name);
  });
  trustedHandle("dcode:openExternal", async (url: string) => {
    const parsed = new URL(url);
    if (!["https:", "http:"].includes(parsed.protocol))
      throw new Error("不支持打开此链接。");
    await shell.openExternal(parsed.href);
  });
  trustedHandle("dcode:notify", (options: { title: string; body?: string }) => {
    if (!notifyEnabled || !Notification.isSupported()) return false;
    new Notification({
      title: String(options.title).slice(0, 200),
      body: String(options.body ?? "").slice(0, 1000),
    }).show();
    return true;
  });
  trustedHandle("dcode:restartHost", () => {
    if (restarting) return restarting;
    restarting = (async () => {
      const old = bridge;
      if (old && !old.hasExited)
        await old.request("host.shutdown", { requireIdle: true });
      bridge = null;
      await old?.shutdown();
      return await startHost();
    })().finally(() => {
      restarting = null;
    });
    return restarting;
  });
  ipcMain.on("dcode:readyToQuit", (event, error?: string) => {
    if (event.sender === window?.webContents) quitAck?.(error);
  });
}
async function refreshNotifications() {
  if (!bridge) return;
  const preferences = await bridge.request<{
    notificationsEnabled: boolean;
    appearance?: "system" | "light" | "dark";
    fontScale?: "compact" | "standard" | "large";
  }>("clientPreferences.get");
  notifyEnabled = preferences.notificationsEnabled;
  nativeTheme.themeSource =
    process.env.DCODE_THEME === "light" || process.env.DCODE_THEME === "dark"
      ? process.env.DCODE_THEME
      : (preferences.appearance ?? "system");
  fontZoom =
    preferences.fontScale === "compact"
      ? 0.92
      : preferences.fontScale === "large"
        ? 1.12
        : 1;
  window?.webContents.setZoomFactor(fontZoom);
  buildMenu();
}
async function saveNotifications(value: boolean) {
  if (!bridge) throw new Error("运行服务未连接");
  for (let attempt = 0; ; attempt++) {
    const snapshot = await bridge.request<{ storeRevision: number }>(
      "foundation.snapshot",
    );
    try {
      await bridge.request("clientPreferences.set", {
        requestId: `notifications-${Date.now()}-${attempt}`,
        expectedStoreRevision: snapshot.storeRevision,
        notificationsEnabled: value,
      });
      break;
    } catch (error) {
      if (
        attempt >= 3 ||
        (error as { code?: string }).code !== "REVISION_CONFLICT"
      )
        throw error;
    }
  }
  await refreshNotifications();
}
function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "D Code",
        submenu: [
          { role: "about", label: "关于 D Code" },
          { type: "separator" },
          {
            label: "设置…",
            accelerator: "Cmd+,",
            click: () => sendEvent("shell.settings"),
          },
          { type: "separator" },
          { role: "hide", label: "隐藏 D Code" },
          { role: "quit", label: "退出 D Code" },
        ],
      },
      {
        label: "文件",
        submenu: [
          {
            label: "新建任务",
            accelerator: "Cmd+N",
            click: () => sendEvent("shell.newTask"),
          },
          {
            label: "新建项目…",
            accelerator: "Cmd+Shift+N",
            click: () => sendEvent("shell.newProject"),
          },
          { type: "separator" },
          { role: "close", label: "关闭窗口" },
        ],
      },
      { role: "editMenu", label: "编辑" },
      {
        label: "视图",
        submenu: [
          {
            label: "搜索",
            accelerator: "Cmd+K",
            click: () => sendEvent("shell.focusSearch"),
          },
          { role: "togglefullscreen", label: "进入全屏幕" },
          ...(!app.isPackaged
            ? [{ role: "toggleDevTools" as const, label: "开发者工具" }]
            : []),
        ],
      },
      {
        label: "任务",
        submenu: [
          {
            label: "完成通知",
            type: "checkbox",
            checked: notifyEnabled,
            click: (item) => {
              void saveNotifications(item.checked).catch((error) => {
                buildMenu();
                void dialog.showMessageBox({
                  type: "error",
                  message: "通知偏好未能保存",
                  detail: String(error),
                });
              });
            },
          },
        ],
      },
      { role: "windowMenu", label: "窗口" },
    ]),
  );
}
async function createWindow() {
  const width = Number(process.env.DCODE_WIDTH ?? 1440);
  window = new BrowserWindow({
    width: Number.isFinite(width) ? width : 1440,
    height: 900,
    minWidth: 640,
    minHeight: 480,
    title: "D Code",
    show: false,
    icon: paths.icon,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 12 },
    backgroundColor: "#242427",
    webPreferences: {
      preload: join(here, "..", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  window.once("ready-to-show", () => {
    if (!process.env.DCODE_SWITCH_ID) window?.show();
  });
  window.on("close", (event) => {
    if (!shutdownComplete) {
      event.preventDefault();
      app.quit();
    }
  });
  window.on("closed", () => {
    void htmlPreview.close().catch(()=>{});
    window = null;
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("console-message", (details) => {
    if (["warning", "error"].includes(details.level))
      console.error(`[renderer] ${details.message}`);
  });
  await window.loadURL(rendererUrl);
  window.webContents.setZoomFactor(fontZoom);
}
app.on("before-quit", (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  void (async () => {
    let saveError: string | undefined;
    if (window && !window.isDestroyed()) {
      saveError = await new Promise<string | undefined>((resolve) => {
        const timer = setTimeout(() => resolve("界面没有及时完成保存。"), 8000);
        quitAck = (error) => {
          clearTimeout(timer);
          resolve(error);
        };
        sendEvent("shell.quitRequested");
      });
      quitAck = null;
    }
    if (saveError) {
      const choice = await dialog.showMessageBox({
        type: "warning",
        message: "退出前还有内容需要处理",
        detail: saveError,
        buttons: ["返回工作台", "仍然退出"],
        defaultId: 0,
        cancelId: 0,
      });
      if (choice.response === 0) {
        quitting = false;
        sendEvent("shell.quitCancelled");
        return;
      }
    }
    await htmlPreview.close().catch(()=>{});
    closePreviewProxy();
    await bridge?.shutdown();
    shutdownComplete = true;
    app.quit();
  })().catch((error) => {
    quitting = false;
    sendEvent("shell.quitCancelled");
    console.error("[dcode] shutdown failed", String(error));
  });
});
void app
  .whenReady()
  .then(async () => {
    if (
      process.env.DCODE_THEME === "dark" ||
      process.env.DCODE_THEME === "light"
    )
      nativeTheme.themeSource = process.env.DCODE_THEME;
    if (process.platform === "darwin") app.dock?.setIcon(paths.icon);
    setupIPC();
    buildMenu();
    try {
      await startHost();
    } catch (error) {
      console.error("[dcode] startup failed", String(error));
    }
    await createWindow();
    if (!bridge) sendEvent("host.exit", { reason: "startup" });
    if (process.env.DCODE_CAPTURE && window) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const target = process.env.DCODE_CAPTURE;
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, (await window.webContents.capturePage()).toPNG());
      app.quit();
    }
  })
  .catch((error) => {
    console.error("[dcode] window failed", String(error));
    app.quit();
  });
