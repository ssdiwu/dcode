// 隔离桥：只向界面暴露约定的操作与快照订阅，不暴露原始 IPC 或宿主能力。
// 接收侧校验：每个操作的返回值按契约过 isValidOpResponse，推送快照过 isValidSnapshot；
// 畸形返回/推送不交付渲染层（不豁免本进程生产者）。

import { contextBridge, ipcRenderer } from "electron";
import { isValidOpResponse, isValidSnapshot } from "@/contracts";
import type { AppSnapshot, DCodeBridge, DCodeOperations, ModelSetupInput, Settings } from "@/contracts";

const invoke = async <K extends keyof DCodeOperations>(
  op: K,
  input: unknown,
): Promise<Awaited<ReturnType<DCodeOperations[K]>>> => {
  const value: unknown = await ipcRenderer.invoke("dcode:op", op, input);
  if (!isValidOpResponse(op, value)) throw new Error(`操作 ${String(op)} 返回畸形（接收侧校验拒绝）`);
  return value as Awaited<ReturnType<DCodeOperations[K]>>;
};

const bridge: DCodeBridge = {
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

contextBridge.exposeInMainWorld("dcode", bridge);

// 仅平台布局事实：macOS 原生窗控安全区域，不暴露宿主任意能力。
document.addEventListener("DOMContentLoaded", () => { document.documentElement.dataset.platform = process.platform; });
