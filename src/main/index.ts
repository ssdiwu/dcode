// 主进程：窗口生命周期、IPC 接线与依赖装配。
// 不承担任务业务状态；运行协调在 application，执行在注入的后端（mock 或 Pi，一次运行只装配一种）。

import { app, BrowserWindow, dialog, ipcMain, nativeImage, safeStorage } from "electron";
import { join } from "node:path";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { DCodeApplication } from "@/application";
import { assembleExecution, resolveConfiguredSources } from "./assembly";
import { ProviderLoginController } from "./provider-login";
import { NativeProjectFolders } from "./project-folders";
import { JsonFileStorage } from "@/adapters/storage";
import { NodeReferencePort } from "@/adapters/references";
import { isValidOnlineStatus, validateOperationInput, type AppSnapshot, type AuthEventPayload, type AuthPromptRequest } from "@/contracts";
import { createBackendFromSelection, AuthFlowRegistry, ProviderLoginService } from "@/adapters/pi";
import type { CredentialCipher } from "@/adapters/pi";
import type { ExecutionBackend } from "@/application";

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
let settleAuthAndCatalog: (() => Promise<void>) | null = null;
let authCatalogFlush: Promise<void> | null = null;
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
  const assembled = await assembleExecution(process.env, stateDir, cipher);
  const { backend, initialState, catalog, directoryStore, backendDeps, modelRouting, setRequestAdmission } = assembled;
  const flowRegistry = new AuthFlowRegistry();
  // 关闭收束的认证/目录部分在窗口建立后注册（见 createWindow 尾部）；
  // 这里只持有注册表，真正的吊销在 before-quit 统一触发。

  /** 目录查询的应用层视图（preset apply 校验用）：供应商身份与模型必须经目录核实，不凭 id 猜。 */
  const presetLookup = catalog
    ? {
        hasProvider: (providerId: string) => catalog.preset(providerId) !== undefined,
        providerName: (providerId: string) => catalog.preset(providerId)?.name ?? null,
        authKinds: (providerId: string) => catalog.preset(providerId)?.authKinds ?? [],
        model: (providerId: string, modelId: string) => {
          const resolved = catalog.resolveModel(providerId, modelId);
          if (!resolved.effective) return null;
          return { id: resolved.effective.id, name: resolved.effective.name };
        },
        modelAsync: async (providerId: string, modelId: string) => {
          const resolved = await catalog.resolveAfterRefresh(providerId, modelId);
          if (!resolved) return null;
          return { id: resolved.info.id, name: resolved.info.name };
        },
      }
    : null;

  // 交互工厂与启动走**同一份**已配置来源解析：切换模型重建后端时，
  // 除新选择之外，已配置来源仍要可请求（否则改完配置的下一条请求找不到身份）。
  // 每次重建都重读目录：设置里新增/移除来源后，下一次重建必须按当次配置解析，而不是用启动时的旧集合。
  /** 已经建出来的后端（含启动那一个）：认证提交后要同步它们的模型客户端，不只是通知目录。 */
  const liveBackends = new Set<ExecutionBackend>();
  /**
   * 目录内容变化后，把**当次重新解析到的已配置来源**同步给已打开的后端。
   *
   * 目录刷新只是呈现：客户端不更新，新 ID 在执行端就解析不到身份——
   * 会话里选了这个新模型，请求既发不出去也不会留下任何真实请求记录。
   * 与认证提交走的是同一处同步，不另立一条只在刷新时才生效的规则。
   */
  const syncBackendsAfterCatalogChange = async (event: string): Promise<void> => {
    if (!directoryStore || !catalog || !backendDeps) return;
    const refreshed = await resolveConfiguredSources(
      await directoryStore.read().catch(() => null),
      backendDeps,
      catalog,
    ).catch((error: unknown) => {
      diagnose(event, error);
      return null;
    });
    if (!refreshed) return;
    for (const live of liveBackends) {
      if (typeof live.refreshAdditionalSources !== "function") continue;
      await live.refreshAdditionalSources(refreshed).catch((error: unknown) => diagnose(event, error));
    }
  };
  const backendFactory = backendDeps
    ? async (selection:
        | { kind: "custom"; provider: "openai-completions" | "anthropic-messages"; label: string; modelId: string; baseUrl: string }
        | { kind: "preset"; providerId: string; modelId: string }): Promise<ExecutionBackend> => {
        const deps = directoryStore && catalog
          ? {
              ...backendDeps,
              additionalSources: await resolveConfiguredSources(
                await directoryStore.read().catch(() => null),
                backendDeps,
                catalog,
              ),
            }
          : backendDeps;
        if (selection.kind === "custom") {
          const created = createBackendFromSelection(selection, deps);
          liveBackends.add(created);
          return created;
        }
        const resolution = await catalog!.resolveAfterRefresh(selection.providerId, selection.modelId);
        if (!resolution || !resolution.executable || !resolution.model) throw new Error("model-not-executable-in-local-catalog");
        const created = createBackendFromSelection(
          {
            kind: "preset",
            providerId: selection.providerId,
            modelId: selection.modelId,
            model: resolution.model as never,
            info: resolution.info,
          },
          deps,
        );
        liveBackends.add(created);
        return created;
      }
    : undefined;

  application = new DCodeApplication(
    backend,
    storage,
    initialState,
    diagnose,
    directoryStore,
    backendFactory,
    presetLookup,
    // C05 引用读取端口：文件/技能发现与快照都在主进程；界面只经桥拿结果。
    new NodeReferencePort(),
    // D 片模型端口：能力资料读 Pi 内置目录的逐模型字段，额度端口无真实来源时如实 unsupported。
    // 验证装配为 null —— 界面据此呈现「本实例无模型目录」，不造灰入口或示例数据。
    modelRouting,
    new NativeProjectFolders(async () => {
      if (!window || window.isDestroyed()) throw new Error('project-folder-unavailable');
      // 每次从真实 dialog 对象调用；隐藏测试只替换系统选择结果，不预写业务绑定。
      const result = await dialog.showOpenDialog(window, { properties: ['openDirectory'] });
      return result.canceled ? null : result.filePaths[0] ?? null;
    }),
  );
  if (backendDeps && typeof backend.refreshAdditionalSources === "function") liveBackends.add(backend);
  await application.init();
  // 每次 SDK 请求前的完整准入接到执行端：工具回合自己发起的下一次请求也要按当次事实核。
  // 这里在 app 建好之后才挂上——后端可能早就装配好，但请求发生时读的是当前这一个 app。
  if (setRequestAdmission && application) {
    setRequestAdmission(async (request) => {
      const admitted = await application!.admitSdkRequest(request);
      return { ok: admitted.ok, reason: admitted.reason, target: admitted.target };
    });
  }

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
  /** 门控标记一律"先写临时文件再 rename"：测试按文件出现来判定在途，非原子写会让它读到半个 JSON。 */
  const writeMarker = async (path: string, data: string): Promise<void> => {
    const tmp = `${path}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, path);
  };
  // 测试注入（仅 DCODE_TEST_DROP_SEND_RESULT=1）：首次 sendMessage 丢弃给界面的返回（外层应答丢失语义）。
  let dropSendResultArmed = process.env.DCODE_TEST_DROP_SEND_RESULT === "1";
  // 测试注入（仅 DCODE_TEST_SEND_RESULT_GATE=1）：首次 sendMessage 在应用层真实完成后，
  // 给界面的应答在门文件 <stateDir>/send-result-gate 出现前暂不返回（等待回执期间的时序验证）。
  let sendResultGateArmed = process.env.DCODE_TEST_SEND_RESULT_GATE === "1";
  const gateAllSendResults = process.env.DCODE_TEST_SEND_RESULT_GATE === "all";
  let sendResultGateOrder = 0;
  // 测试注入（仅 DCODE_TEST_RECEIPT_RESULT_GATE=1/all）：checkReceipt / retrySend 在应用层真实完成后，
  // 给界面的应答在门文件 <stateDir>/receipt-result-gate[-N] 出现前暂不返回。
  // 与 send-result-gate 同构但**独立计数与独立门文件**：回查与重试各自可辨的在途与放行，
  // 不共用发送侧的门，也不共用模型应答门（那是执行端生成，不是给界面的回执应答）。
  let receiptResultGateArmed = process.env.DCODE_TEST_RECEIPT_RESULT_GATE === "1";
  const gateAllReceiptResults = process.env.DCODE_TEST_RECEIPT_RESULT_GATE === "all";
  let receiptResultGateOrder = 0;
  /** 门控中的回查/重试目标消息块；确认它的那次快照推送会被扣住到放行为止。 */
  let pendingReceiptConfirmation: { sessionId: string; blockId: string } | null = null;
  /** 门控期间扣住的那次"确认已接收"快照。 */
  let heldReceiptConfirmation: AppSnapshot | null = null;
  function confirmsTarget(snapshot: AppSnapshot, target: { sessionId: string; blockId: string }): boolean {
    const block = snapshot.timelines[target.sessionId]?.find((b) => b.id === target.blockId);
    return block?.kind === "message" && block.receipt?.status === "accepted";
  }
  /** 放行门控期间扣住的那次确认推送（与外层应答同一道门，避免只放一半造成假在途）。 */
  function releaseHeldReceiptConfirmation(): void {
    const held = heldReceiptConfirmation;
    heldReceiptConfirmation = null;
    pendingReceiptConfirmation = null;
    if (held && window && !window.isDestroyed()) window.webContents.send("dcode:snapshot", held);
  }
  // 测试注入：每会话首次 resumeRun 等专属门（或共用 resume-gate），finally 由测试放行。
  // 不以超时自动放行：防重必须跟随真实 Promise，两个会话可各自保持在途。
  const resumeGateEnabled = process.env.DCODE_TEST_RESUME_GATE === "1";
  const gatedResumeSessions = new Set<string>();
  application.subscribe((snapshot) => {
    if (window && !window.isDestroyed()) {
      // 回执门禁在途：确认回执的那一次推送与外层应答同门扣住，否则界面会在门放行前就按
      // "已到但续跑未跑"的中间态清稿，这条用例就验不到真实在途。
      if (pendingReceiptConfirmation && confirmsTarget(snapshot, pendingReceiptConfirmation)) {
        heldReceiptConfirmation = snapshot;
        return;
      }
      window.webContents.send("dcode:snapshot", snapshot);
      if (badPushArmed) {
        badPushArmed = false;
        setTimeout(() => {
          if (window && !window.isDestroyed()) window.webContents.send("dcode:snapshot", { bad: true, settings: {} });
        }, 100);
      }
    }
  });

  // 目录修订推送：只带修订号（目录正文经 listModelCatalog 有界读取，不进高频快照）
  catalog?.onChanged((info) => {
    if (window && !window.isDestroyed()) window.webContents.send("dcode:catalog", info);
  });

  // 认证交互：SDK 登录编排在 pi 模块（login-service）；这里只做宿主桥事件转发与 flow 登记/门禁装配
  const loginService = directoryStore && backendDeps ? new ProviderLoginService({ directoryStore, presets: backendDeps.presets }) : null;
  const pushAuthEvent = (payload: AuthEventPayload) => {
    if (window && !window.isDestroyed()) window.webContents.send("dcode:auth", payload);
  };
  const appInstance = application;
  const loginController = new ProviderLoginController({
    admit: (providerId) => appInstance.beginProviderAuth(providerId),
    beginGuard: (providerId) => flowRegistry.begin(providerId),
    rejectPrompts: (loginId) => loginService?.rejectLoginPrompts(loginId, new Error("login-cancelled")),
    diagnose: (error) => diagnose("provider-login-failed", error),
    perform: async (input, guard, signal) => {
      const outcome = await loginService!.runLogin(input, guard, signal, {
        onPrompt: (event) => {
          const payload: AuthPromptRequest = {
            requestId: event.requestId, loginId: event.loginId, kind: event.kind, message: event.message,
            ...(event.placeholder ? { placeholder: event.placeholder } : {}),
            ...(event.options ? { options: event.options } : {}),
          };
          pushAuthEvent({ type: "prompt", ...payload });
        },
        onInfo: (event) => pushAuthEvent(event),
      });
      if (!outcome.ok) return outcome.issue === "cancelled" ? { ok: false, issue: "cancelled", message: "认证已取消" } : { ok: false, issue: "auth-failed", message: outcome.message };
      // 凭据原子提交已成立；后续目录呈现失败不能把已保存认证误报为失败。
      await catalog!.noteCredentialChanged(input.providerId).catch((error) => diagnose("credential-view-refresh-failed", error));
      // 已打开的模型客户端同步新增来源：目录刷新只是呈现，实际客户端不更新就仍然发不出那条来源的请求
      const refreshed = directoryStore && catalog
        ? await resolveConfiguredSources(await directoryStore.read().catch(() => null), backendDeps!, catalog)
        : [];
      for (const live of liveBackends) {
        if (typeof live.refreshAdditionalSources !== "function") continue;
        await live.refreshAdditionalSources(refreshed).catch((error) => diagnose("credential-client-refresh-failed", error));
      }
      return { ok: true };
    },
  });
  const runLogin = async (input: { loginId: string; providerId: string; type: "api_key" | "oauth" }) => {
    if (!catalog || !directoryStore || !backendDeps || !loginService) return { ok: false, issue: "invalid-input", message: "本实例不支持认证流程" };
    const preset = catalog.preset(input.providerId);
    if (!preset) return { ok: false, issue: "invalid-input", message: "未登记的预设供应商" };
    if (!preset.authKinds.includes(input.type)) return { ok: false, issue: "unsupported-auth", message: "该供应商不支持所选认证方式" };
    return loginController.start(input);
  };

  ipcMain.handle("dcode:login", async (event, input: { loginId: string; providerId: string; type: "api_key" | "oauth" }) => {
    if (!window || event.sender !== window.webContents) throw new Error("Unknown sender");
    if (!application) throw new Error("Application not ready");
    const rejected = validateOperationInput("loginProvider", input);
    if (rejected) return { ok: false, issue: "invalid-input", message: rejected };
    return runLogin(input);
  });

  const cancelLogin = (loginId: string) => loginController.cancel(loginId);

  // 取消：立即吊销 flow 提交授权（真实 commit 点此后拒绝）、abort SDK 交互、拒绝该 login 的挂起 prompt；
  // 不假装「已收束」——runLogin 的 settlement 仍真实等待 SDK 收束，取消回执只表达「取消指令已生效」。
  ipcMain.handle("dcode:login-cancel", async (event, input: { loginId: string }) => {
    if (!window || event.sender !== window.webContents) throw new Error("Unknown sender");
    if (validateOperationInput("cancelLogin", input)) return { ok: false };
    return cancelLogin(input.loginId);
  });

  ipcMain.handle("dcode:auth-reply", async (event, input: { requestId: string; value?: string; cancel?: boolean }) => {
    if (!window || event.sender !== window.webContents) throw new Error("Unknown sender");
    if (validateOperationInput("replyAuthPrompt", input) || !loginService) return { ok: false };
    return { ok: loginService.answerPrompt(input.requestId, input.value, input.cancel === true) };
  });

  ipcMain.handle("dcode:catalog", async (event, input: unknown) => {
    if (!window || event.sender !== window.webContents) throw new Error("Unknown sender");
    if (validateOperationInput("listModelCatalog", input)) throw new Error("invalid-input");
    if (!catalog) throw new Error("catalog-unavailable");
    return catalog.view();
  });

  ipcMain.handle("dcode:catalog-refresh", async (event, input: unknown) => {
    if (!window || event.sender !== window.webContents) throw new Error("Unknown sender");
    if (validateOperationInput("refreshModelCatalog", input)) throw new Error("invalid-input");
    if (!catalog) throw new Error("catalog-unavailable");
    const result = await catalog.refresh();
    // 目录刷新走的是**专用通道**（不经过 dcode:op）：同步必须挂在这里，
    // 否则新模型只进目录、不进执行端，会话里选中新 ID 后请求发不出去。
    await syncBackendsAfterCatalogChange("catalog-client-refresh-failed");
    return result;
  });

  // 联网恢复信号：renderer navigator.onLine=true 触发同一 refresh（关闭时自动撤 listener）
  // 关闭/窗口销毁前由 settleAuthAndCatalog 关 catalog → 后续 refresh 自然收束；无需手动撤销。
  ipcMain.handle("dcode:online-status", async (event, input: unknown) => {
    if (!window || event.sender !== window.webContents) throw new Error("Unknown sender");
    if (!isValidOnlineStatus(input)) throw new Error("invalid-online-status");
    if (catalog && input.online) void catalog.refresh().catch((error) => diagnose("catalog-online-refresh-failed", error));
  });

  ipcMain.handle("dcode:catalog-set-source", async (event, input: { baseUrl: string }) => {
    if (!window || event.sender !== window.webContents) throw new Error("Unknown sender");
    if (!catalog) throw new Error("catalog-unavailable");
    const rejected = validateOperationInput("setCatalogSource", input);
    if (rejected) return { ok: false, issue: "invalid-input", message: rejected };
    const result = await catalog.setSource(input.baseUrl);
    await syncBackendsAfterCatalogChange("catalog-source-client-refresh-failed");
    return result;
  });

  // 启动后异步自动检查一次公共目录（不阻塞窗口可用；失败保留内置目录与真实原因）
  void catalog?.refresh().catch((err) => diagnose("catalog-auto-refresh-failed", err));

  ipcMain.handle("dcode:op", async (event, op: string, input: unknown) => {
    if (!window || event.sender !== window.webContents) throw new Error("Unknown sender");
    if (!application) throw new Error("Application not ready");
    // 接收侧校验（MiniMax 审计项）：只允许既有操作名且载荷过形状校验；
    // 未知操作或畸形载荷在此拒绝，不建对象、不接收、不执行。
    const rejected = validateOperationInput(String(op), input);
    if (rejected) throw new Error(`拒绝：${rejected}`);
    if (op === "onCatalogChanged" || op === "onAuthEvent") throw new Error("Unknown op: " + op);
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
    // 目录与认证有专用通道/侧状态，路由到专用实现；其余走 application 公开方法
    let result: unknown;
    if (op === "listModelCatalog") {
      if (!catalog) throw new Error("catalog-unavailable");
      result = await catalog.view();
    } else if (op === "refreshModelCatalog") {
      if (!catalog) throw new Error("catalog-unavailable");
      result = await catalog.refresh();
      await syncBackendsAfterCatalogChange("catalog-client-refresh-failed");
    } else if (op === "setCatalogSource") {
      if (!catalog) throw new Error("catalog-unavailable");
      result = await catalog.setSource((input as { baseUrl: string }).baseUrl);
      await syncBackendsAfterCatalogChange("catalog-source-client-refresh-failed");
    } else if (op === "loginProvider") {
      result = await runLogin(input as { loginId: string; providerId: string; type: "api_key" | "oauth" });
    } else if (op === "cancelLogin") {
      result = cancelLogin((input as { loginId: string }).loginId);
    } else if (op === "replyAuthPrompt") {
      const reply = input as { requestId: string; value?: string; cancel?: boolean };
      result = { ok: loginService?.answerPrompt(reply.requestId, reply.value, reply.cancel === true) ?? false };
    } else {
      const method = (application as unknown as Record<string, unknown>)[op];
      if (typeof method !== "function") throw new Error(`Unknown op: ${String(op)}`);
      result = await (method as (arg: unknown) => Promise<unknown>).call(application, input);
    }
    if ((sendResultGateArmed || gateAllSendResults) && op === "sendMessage") {
      sendResultGateArmed = false;
      const order = ++sendResultGateOrder;
      const gateFile = join(stateDir, "send-result-gate");
      const individualGate = join(stateDir, `send-result-gate-${order}`);
      await writeMarker(join(stateDir, `send-result-waiting-${order}`), JSON.stringify({ order, operationId: (input as { operationId: string }).operationId }));
      const deadline = Date.now() + 15_000;
      // all 模式逐请求真实门控，finally 由测试放行；用于 A→B→A 外层应答交错反例。
      for (;;) {
        const exists = await stat(individualGate).then(() => true, () => stat(gateFile).then(() => true, () => false));
        if (exists || (!gateAllSendResults && Date.now() > deadline)) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      await writeMarker(join(stateDir, `send-result-released-${order}`), "released");
    }
    // 回执确认类操作的外层应答门禁：应用层此时已真实完成（回执按事实落定、快照已推送），
    // 卡住的只是给界面的那一次返回，于是界面侧确定性地存在"回执已到、续跑未跑"的在途窗口。
    // 逐请求门控，finally 由测试放行；不自动超时放行，免得把未证明的在途当成已验证。
    if ((receiptResultGateArmed || gateAllReceiptResults) && (op === "checkReceipt" || op === "retrySend")) {
      receiptResultGateArmed = false;
      const order = ++receiptResultGateOrder;
      const gateFile = join(stateDir, "receipt-result-gate");
      const individualGate = join(stateDir, `receipt-result-gate-${order}`);
      const target = input as { sessionId?: string; blockId?: string };
      if (typeof target.sessionId === "string" && typeof target.blockId === "string") {
        pendingReceiptConfirmation = { sessionId: target.sessionId, blockId: target.blockId };
      }
      await writeMarker(join(stateDir, `receipt-result-waiting-${order}`), JSON.stringify({ order, op, sessionId: target.sessionId ?? null, blockId: target.blockId ?? null }));
      const deadline = Date.now() + 15_000;
      for (;;) {
        const exists = await stat(individualGate).then(() => true, () => stat(gateFile).then(() => true, () => false));
        if (exists || (!gateAllReceiptResults && Date.now() > deadline)) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      await writeMarker(join(stateDir, `receipt-result-released-${order}`), "released");
      releaseHeldReceiptConfirmation();
    }
    // 测试注入（仅 DCODE_TEST_DROP_SEND_RESULT=1）：首次 sendMessage 在应用层真实完成后，
    // 丢弃给界面的返回（外层应答丢失语义）；应用层状态不受影响，供同身份找回验证。
    if (dropSendResultArmed && op === "sendMessage") {
      dropSendResultArmed = false;
      throw new Error("注入：sendMessage 外层应答丢失（应用层已完成，传输未确认）");
    }
    return result;
  });

  // 关闭收束：吊销全部在途认证 flow、中止登录、取消目录刷新；
  // 已开始的认证收束与目录关闭必须实际等待（由下方 before-quit 顺序执行），不能只发信号即退出。
  settleAuthAndCatalog = async (): Promise<void> => {
    flowRegistry.close();
    await Promise.allSettled([loginController.close(), catalog?.close()]);
  };

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
  event.preventDefault();
  if (!flushStarted) {
    flushStarted = true;
    // 关闭第一同步认领：所有接收/认证/配置 admission 立即拒（不等 auth/catalog 收束完成也不让窗口存在）
    application.beginClosing();
    // 再真实收束 auth/catalog + 保存/端口（settleAuthAndCatalog 在同一 promise 复用）
    authCatalogFlush ??= settleAuthAndCatalog ? settleAuthAndCatalog() : Promise.resolve();
    const settle = authCatalogFlush;
    void settle
      .catch(() => undefined)
      .then(() => application!.flush())
      .then(
        () => {
          flushDone = true;
          app.quit();
        },
        () => {
          // 失败仍保留关闭认领与可见错误，但释放本次退出快门：App.flush已清掉失败promise，
          // 用户修复存储后再次正常退出必须能重试；不能永久卡在已失败的flushStarted。
          flushStarted = false;
        },
      );
  }
});
