// 隔离桥：只向界面暴露约定的操作与快照订阅，不暴露原始 IPC 或宿主能力。
// 接收侧校验：每个操作的返回值按契约过 isValidOpResponse，推送快照过 isValidSnapshot；
// 畸形返回/推送不交付渲染层（不豁免本进程生产者）。认证交互与目录视图走独立校验。

import { contextBridge, ipcRenderer } from "electron";
import { isValidAuthEvent, isValidOpResponse, isValidSnapshot, validateOperationInput } from "@/contracts";
import type {
  AppSnapshot,
  AuthEventPayload,
  ApplyModelInput,
  DCodeBridge,
  DCodeOperations,
  ModelCatalogView,
  ModelSetupInput,
  Settings,
} from "@/contracts";

// 只分发出现在 OP_NAMES 且经接收侧校验的操作；on* 订阅与专用通道不走这里
type InvocableOp = Exclude<keyof DCodeOperations, "onCatalogChanged" | "onAuthEvent" | "onSnapshot" | "listModelCatalog" | "refreshModelCatalog" | "loginProvider" | "cancelLogin" | "replyAuthPrompt">;

const invoke = async <K extends InvocableOp>(
  op: K,
  input: unknown,
): Promise<Awaited<ReturnType<DCodeOperations[K]>>> => {
  const value: unknown = await ipcRenderer.invoke("dcode:op", op, input);
  if (!isValidOpResponse(op, value)) throw new Error(`操作 ${String(op)} 返回畸形（接收侧校验拒绝）`);
  return value as Awaited<ReturnType<DCodeOperations[K]>>;
};

type SetCatalogSourceResult = { ok: boolean; issue?: "invalid-input" | "refresh-failed" | "closed"; message?: string; revision?: number };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** 目录视图接收侧严格校验：复用 contracts 的 isValidModelCatalogView（单一 schema）。 */
function isCatalogView(v: unknown): v is ModelCatalogView {
  return isValidOpResponse("listModelCatalog", v);
}

/** 目录刷新回执（contracts 复用 through isValidOpResponse refreshModelCatalog）。 */
function isRefreshResult(v: unknown): boolean {
  return isValidOpResponse("refreshModelCatalog", v);
}

/** 认证事件接受侧严格校验：loginId/kind/message/url/select options/device/progress 逐字段核。
 *  畸形不交付（不写 prompt、不推进流程、不落凭据）。 */
function isAuthEventPayload(v: unknown): v is AuthEventPayload {
  return isValidAuthEvent(v);
}

const bridge: DCodeBridge = {
  chooseProjectFolder: (input) => invoke("chooseProjectFolder", input),
  discardProjectFolder: (input) => invoke("discardProjectFolder", input),
  createWorkspace: (input) => invoke("createWorkspace", input),
  getSnapshot: () => invoke("getSnapshot", undefined),
  createTask: (input) => invoke("createTask", input),
  moveTask: (input) => invoke("moveTask", input),
  createSession: (input) => invoke("createSession", input),
  sendMessage: (input) => invoke("sendMessage", input),
  retrySend: (input) => invoke("retrySend", input),
  checkReceipt: (input) => invoke("checkReceipt", input),
  pauseRun: (input) => invoke("pauseRun", input),
  resumeRun: (input) => invoke("resumeRun", input),
  updateSettings: (input: Partial<Settings>) => invoke("updateSettings", input),
  configureModel: (input: ModelSetupInput) => invoke("configureModel", input),
  applyModel: (input: ApplyModelInput) => invoke("applyModel", input),
  listModelCatalog: async () => {
    // 发送前严格校验：dcode:catalog 无参数（validateOperationInput listModelCatalog）
    const rejected = validateOperationInput("listModelCatalog", undefined);
    if (rejected) throw new Error(`listModelCatalog 拒绝：${rejected}`);
    const value: unknown = await ipcRenderer.invoke("dcode:catalog");
    if (!isCatalogView(value)) throw new Error("目录视图畸形（接收侧校验拒绝）");
    return value;
  },
  refreshModelCatalog: async () => {
    const rejected = validateOperationInput("refreshModelCatalog", undefined);
    if (rejected) throw new Error(`refreshModelCatalog 拒绝：${rejected}`);
    const value: unknown = await ipcRenderer.invoke("dcode:catalog-refresh");
    if (!isRefreshResult(value)) throw new Error("目录刷新回执畸形（接收侧校验拒绝）");
    return value as { ok: boolean; revision: number; message?: string };
  },
  setCatalogSource: async (input) => {
    const rejected = validateOperationInput("setCatalogSource", input);
    if (rejected) throw new Error(`setCatalogSource 拒绝：${rejected}`);
    const value: unknown = await ipcRenderer.invoke("dcode:catalog-set-source", input);
    if (!isValidOpResponse("setCatalogSource", value)) throw new Error("来源设置回执畸形（接收侧校验拒绝）");
    return value as SetCatalogSourceResult;
  },
  onCatalogChanged: (listener) => {
    const wrapped = (_event: unknown, info: unknown) => {
      if (!isRecord(info) || !Number.isSafeInteger(info.revision)) return;
      listener({ revision: info.revision as number });
    };
    ipcRenderer.on("dcode:catalog", wrapped);
    return () => ipcRenderer.removeListener("dcode:catalog", wrapped);
  },
  loginProvider: async (input) => {
    const rejected = validateOperationInput("loginProvider", input);
    if (rejected) throw new Error(`loginProvider 拒绝：${rejected}`);
    const value: unknown = await ipcRenderer.invoke("dcode:login", input);
    if (!isValidOpResponse("loginProvider", value)) throw new Error("认证回执畸形（接收侧校验拒绝）");
    return value as Awaited<ReturnType<DCodeBridge["loginProvider"]>>;
  },
  cancelLogin: async (input) => {
    const rejected = validateOperationInput("cancelLogin", input);
    if (rejected) throw new Error(`cancelLogin 拒绝：${rejected}`);
    const value: unknown = await ipcRenderer.invoke("dcode:login-cancel", input);
    if (!isValidOpResponse("cancelLogin", value)) throw new Error("取消回执畸形（接收侧校验拒绝）");
    return value as { ok: boolean };
  },
  onAuthEvent: (listener) => {
    const wrapped = (_event: unknown, payload: unknown) => {
      if (!isAuthEventPayload(payload)) return;
      listener(payload);
    };
    ipcRenderer.on("dcode:auth", wrapped);
    return () => ipcRenderer.removeListener("dcode:auth", wrapped);
  },
  replyAuthPrompt: async (input) => {
    const rejected = validateOperationInput("replyAuthPrompt", input);
    if (rejected) throw new Error(`replyAuthPrompt 拒绝：${rejected}`);
    const value: unknown = await ipcRenderer.invoke("dcode:auth-reply", input);
    if (!isValidOpResponse("replyAuthPrompt", value)) throw new Error("prompt 回执畸形（接收侧校验拒绝）");
    return value as { ok: boolean };
  },
  // 引用发现／选取走与其它操作同一条 dcode:op 正式通路：不另开专用 IPC 通道
  // （主进程只按 OP_NAMES 在该通道上分派），载荷与回执都过同一套接收侧校验。
  listReferences: (input) => invoke("listReferences", input),
  // D 片模型入口走同一条 dcode:op 正式通路：不另开通道、不暴露原始 IPC；
  // 载荷过 validateOperationInput，返回值过 isValidOpResponse 的统一接收侧校验。
  listModelSources: (input) => invoke("listModelSources", input),
  setSessionModelChoice: (input) => invoke("setSessionModelChoice", input),
  setSessionThinkingLevel: (input) => invoke("setSessionThinkingLevel", input),
  readModelQuota: (input) => invoke("readModelQuota", input),
  resolveSessionRouting: (input) => invoke("resolveSessionRouting", input),
  setDefaultModelChoice: (input) => invoke("setDefaultModelChoice", input),
  captureReference: (input) => invoke("captureReference", input),
  onSnapshot: (listener) => {
    const wrapped = (_event: unknown, snapshot: unknown) => {
      // 推送通道同样校验：畸形快照静默丢弃（渲染层保留上一份已确认快照）
      if (!isValidSnapshot(snapshot)) return;
      listener(snapshot as AppSnapshot);
    };
    ipcRenderer.on("dcode:snapshot", wrapped);
    return () => ipcRenderer.removeListener("dcode:snapshot", wrapped);
  },
};

// 联网恢复信号：navigator.onLine 变化即报宿主；宿主据此触发目录 refresh（关闭撤销）。
// 仅上报状态不触发网络调用；不做凭据迁移/不读凭据。
const notifyOnline = (online: boolean) => {
  void ipcRenderer.invoke("dcode:online-status", { online }).catch(() => undefined);
};
window.addEventListener("online", () => notifyOnline(true));
window.addEventListener("offline", () => notifyOnline(false));

contextBridge.exposeInMainWorld("dcode", bridge);

// 仅平台布局事实：macOS 原生窗控安全区域，不暴露宿主任意能力。
document.addEventListener("DOMContentLoaded", () => { document.documentElement.dataset.platform = process.platform; });
