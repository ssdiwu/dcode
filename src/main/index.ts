// 主进程：窗口生命周期、IPC 接线与依赖装配。
// 不承担任务业务状态；运行协调在 application，执行在注入的后端（mock 或 Pi，一次运行只装配一种）。

import { app, BrowserWindow, dialog, ipcMain, nativeImage, safeStorage } from "electron";
import { join } from "node:path";
import { readFile, stat, writeFile } from "node:fs/promises";
import { DCodeApplication } from "@/application";
import { assembleExecution } from "./assembly";
import { JsonFileStorage } from "@/adapters/storage";
import { validateOperationInput, type DCodeOperations } from "@/contracts";
import { createRealPiBackend, modelSetupStoreFactory } from "@/adapters/pi";
import type { CredentialCipher } from "@/adapters/pi";

// 统一诊断只保留事件、错误类别和系统错误码；不输出错误正文、用户内容或凭据。
function diagnose(event: string, cause: unknown): void {
  const code = typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
  const name = cause instanceof Error && /^[A-Za-z0-9_]+Error$/.test(cause.name) ? cause.name : "Error";
  // 仅保存函数与行列，帮助定位调用点；排除 stack 首行和路径中的正文／凭据。
  const frames = cause instanceof Error ? (cause.stack ?? "").split("\n").slice(1).flatMap(line => {
    const frame = /^\s*at (?:async )?([A-Za-z0-9_.$]+).*:(\d+):(\d+)\)?$/.exec(line);
    return frame ? [{ function: frame[1], line: Number(frame[2]), column: Number(frame[3]) }] : [];
  }).slice(0, 6) : [];
  console.error("[dcode]", event, { name, code: typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : undefined, frames });
}

// 自动验收不得抢走 507 的输入焦点：默认不显示测试窗口，只有显式可见验收才进入前台。
const backgroundE2E = process.env.DCODE_E2E === "1" && process.env.DCODE_E2E_VISIBLE !== "1";
if (backgroundE2E && process.platform === "darwin") app.setActivationPolicy("accessory");

let window: BrowserWindow | null = null;
let application: DCodeApplication | null = null;
// 退出收束：Electron 的 before-quit 不等待异步工作，preventDefault 是唯一可靠的延迟手段。
// 正常关闭路径必须等全部会话 close() 与存储收束的真实结果：成功才真正退出；
// 失败保留可见状态（closeError 进快照）、不伪报安全保存，应用保持打开。
let flushStarted = false;
let flushDone = false;

async function createWindow(): Promise<void> {
  // 测试隔离：DCODE_STATE_DIR 指定独立状态目录（含 Chromium profile、持久化状态与 Pi 运行记录）
  const stateDir = process.env.DCODE_STATE_DIR ?? app.getPath("userData");
  if (process.env.DCODE_STATE_DIR) app.setPath("userData", join(stateDir, "userdata"));
  const storage = new JsonFileStorage(stateDir, diagnose);
  // 凭据加密能力（注入 pi）：safeStorage.encryptString / decryptString；加密不可用时只允许"明确失败"
  const cipher: CredentialCipher = {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plaintext) => safeStorage.encryptString(plaintext),
    decrypt: (encrypted) => safeStorage.decryptString(encrypted),
  };
  const { backend, initialState } = await assembleExecution(process.env, stateDir, cipher);
  // 单 store：连接元数据 + cipher 加密凭据一体原子；应用层只见接口，backend 构造同步无副作用
  const modelSetupStore = modelSetupStoreFactory(stateDir, cipher);
  application = new DCodeApplication(
    backend,
    storage,
    initialState,
    diagnose,
    modelSetupStore,
    (record) => createRealPiBackend({
      stateDir,
      config: { provider: record.provider, label: record.label, modelId: record.modelId, baseUrl: record.baseUrl },
      cipher,
      store: modelSetupStore,
      diagnose,
    }),
  );
  await application.init();

  // 品牌母版保持原稿；Dock 直接显示方形母版会留下直角和过大的视觉边界，改读平台圆角资产。
  // 文件读取用 node:fs/promises.readFile 异步完成（统一异步规则）；Electron 的 nativeImage.createFromBuffer
  // 是解码而非 I/O。输入字节 hash 在测试侧单独证明；重编码至 Dock 的字节不必与原 PNG 相等。
  const owlPath = join(import.meta.dirname, "../../resources/brand/dcode-macos.png");
  let brandOwl = null;
  try {
    const bytes = await readFile(owlPath);
    brandOwl = nativeImage.createFromBuffer(bytes);
    if (brandOwl.isEmpty()) {
      brandOwl = null;
      diagnose("brand-owl-decode-empty", new Error("decoded empty image"));
    }
  } catch (err) {
    diagnose("brand-owl-read-failed", err);
    brandOwl = null;
  }
  if (brandOwl && process.platform === "darwin" && app.dock) {
    // 本片接入的是「运行时 Dock 图形」，不是已安装应用 ICNS——两者的验证分别记录，不互相冒充
    app.dock.setIcon(brandOwl);
  }

  window = new BrowserWindow({
    show: !backgroundE2E,
    focusable: !backgroundE2E,
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    title: "D Code",
    titleBarStyle: "hiddenInset",
    backgroundColor: "#00000000",
    ...(brandOwl ? { icon: brandOwl } : {}),
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 隐藏验收仍需正常绘制与运行计时；避免后台节流造成假超时，不改变正常客户端配置。
      backgroundThrottling: !backgroundE2E,
    },
  });

  // 测试注入（仅 DCODE_TEST_BAD_PUSH=1 显式开启）：首次真实快照推送后紧随其后发一条畸形推送，
  // 验证接收侧丢弃畸形推送而不污染渲染层当前状态。默认关闭，不影响正常通路。
  let badPushArmed = process.env.DCODE_TEST_BAD_PUSH === "1";
  // 测试注入（仅 DCODE_TEST_DROP_SEND_RESULT=1）：首次 sendMessage 丢弃给界面的返回（外层应答丢失语义）。
  let dropSendResultArmed = process.env.DCODE_TEST_DROP_SEND_RESULT === "1";
  // 测试注入（仅 DCODE_TEST_SEND_RESULT_GATE=1）：首次 sendMessage 在应用层真实完成后，
  // 给界面的应答在门文件 <stateDir>/send-result-gate 出现前暂不返回（等待回执期间的时序验证）。
  let sendResultGateArmed = process.env.DCODE_TEST_SEND_RESULT_GATE === "1";
  const gateAllSendResults = process.env.DCODE_TEST_SEND_RESULT_GATE === "all";
  let sendResultGateOrder = 0;
  // 测试注入：每会话首次 resumeRun 等专属门（或共用 resume-gate），finally 由测试放行。
  // 不以超时自动放行：防重必须跟随真实 Promise，两个会话可各自保持在途。
  const resumeGateEnabled = process.env.DCODE_TEST_RESUME_GATE === "1";
  const gatedResumeSessions = new Set<string>();
  application.subscribe((snapshot) => {
    if (window && !window.isDestroyed()) {
      window.webContents.send("dcode:snapshot", snapshot);
      if (badPushArmed) {
        badPushArmed = false;
        setTimeout(() => {
          if (window && !window.isDestroyed()) window.webContents.send("dcode:snapshot", { bad: true, settings: {} });
        }, 100);
      }
    }
  });

  ipcMain.handle("dcode:op", async (event, op: keyof DCodeOperations, input: unknown) => {
    if (!window || event.sender !== window.webContents) throw new Error("Unknown sender");
    if (!application) throw new Error("Application not ready");
    // 接收侧校验（MiniMax 审计项）：只允许既有操作名且载荷过形状校验；
    // 未知操作或畸形载荷在此拒绝，不建对象、不接收、不执行。
    const rejected = validateOperationInput(String(op), input);
    if (rejected) throw new Error(`拒绝：${rejected}`);
    if (resumeGateEnabled && op === "resumeRun") {
      const { sessionId } = input as { sessionId: string };
      if (!gatedResumeSessions.has(sessionId)) {
        gatedResumeSessions.add(sessionId);
        const gateFile = join(stateDir, "resume-gate");
        const sessionGate = join(stateDir, `resume-gate-${sessionId}`);
        await writeFile(join(stateDir, `resume-waiting-${sessionId}`), "waiting");
        for (;;) {
          const exists = await stat(sessionGate).then(() => true, () => stat(gateFile).then(() => true, () => false));
          if (exists) break;
          await new Promise((r) => setTimeout(r, 10));
        }
      }
    }
    const method = application[op] as unknown;
    if (typeof method !== "function") throw new Error(`Unknown op: ${String(op)}`);
    const result = await (method as (arg: unknown) => Promise<unknown>).call(application, input);
    if ((sendResultGateArmed || gateAllSendResults) && op === "sendMessage") {
      sendResultGateArmed = false;
      const order = ++sendResultGateOrder;
      const gateFile = join(stateDir, "send-result-gate");
      const individualGate = join(stateDir, `send-result-gate-${order}`);
      await writeFile(join(stateDir, `send-result-waiting-${order}`), JSON.stringify({ order, operationId: (input as { operationId: string }).operationId }));
      const deadline = Date.now() + 15_000;
      // all 模式逐请求真实门控，finally 由测试放行；用于 A→B→A 外层应答交错反例。
      for (;;) {
        const exists = await stat(individualGate).then(() => true, () => stat(gateFile).then(() => true, () => false));
        if (exists || (!gateAllSendResults && Date.now() > deadline)) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      await writeFile(join(stateDir, `send-result-released-${order}`), "released");
    }
    // 测试注入（仅 DCODE_TEST_DROP_SEND_RESULT=1）：首次 sendMessage 在应用层真实完成后，
    // 丢弃给界面的返回（外层应答丢失语义）；应用层状态不受影响，供同身份找回验证。
    if (dropSendResultArmed && op === "sendMessage") {
      dropSendResultArmed = false;
      throw new Error("注入：sendMessage 外层应答丢失（应用层已完成，传输未确认）");
    }
    return result;
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    await window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  }
}

// 集成后保留主树的 Promise 检查：初始化失败必须有明确结果，不能留下未处理拒绝和空窗口。
app.whenReady().then(createWindow).catch((error: unknown) => {
  diagnose("startup-failed", error);
  if (!backgroundE2E) dialog.showErrorBox("D Code", "无法打开工作界面。当前工作未开始，请关闭后重新打开。 / Unable to open the workspace. Work has not started; close and reopen D Code.");
  app.exit(1);
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", (event) => {
  if (!application || flushDone) return;
  // 连续退出也须等待同一次收束；仅 flushStarted 为真不能证明保存成功（回归见 send-receipts）。
  event.preventDefault();
  if (!flushStarted) {
    flushStarted = true;
    void application.flush().then(
      () => {
        flushDone = true;
        app.quit();
      },
      () => {
        // 收束失败：不退出、不伪报成功；快照里的 closeError 让界面如实呈现，
        // 后续退出仍被阻止（flush 在同一实例复用同一个收束结果与失败）。
      },
    );
  }
});
