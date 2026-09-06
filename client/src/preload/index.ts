import { contextBridge, ipcRenderer, webUtils } from "electron";
contextBridge.exposeInMainWorld("dcode", {
  request: (method: string, params?: Record<string, unknown>) =>
    ipcRenderer.invoke("dcode:request", method, params ?? {}),
  subscribe: (handler: (envelope: unknown) => void) => {
    const listener = (_event: unknown, envelope: unknown) => handler(envelope);
    ipcRenderer.on("dcode:event", listener);
    return () => ipcRenderer.removeListener("dcode:event", listener);
  },
  notify: (options: { title: string; body?: string }) =>
    ipcRenderer.invoke("dcode:notify", options),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  previewAttachment: (id: string) => ipcRenderer.invoke("dcode:previewAttachment", id),
  switchCandidate: (direction: "candidate" | "rollback") =>
    ipcRenderer.invoke("dcode:switchCandidate", direction),
  signalRestoreFailed: () => ipcRenderer.invoke("dcode:restoreFailed"),
  signalReady: (selection: {
    taskId: string | null;
    sessionId: string | null;
  }) => ipcRenderer.invoke("dcode:signalReady", selection),
  diagnostics: () => ipcRenderer.invoke("dcode:diagnostics"),
  clearDiagnostics: () => ipcRenderer.invoke("dcode:clearDiagnostics"),
  openNotificationSettings: () =>
    ipcRenderer.invoke("dcode:notificationSettings"),
  revealCandidate: (path: string) =>
    ipcRenderer.invoke("dcode:revealCandidate", path),
  chooseDirectory: () => ipcRenderer.invoke("dcode:chooseDirectory"),
  openExternal: (url: string) => ipcRenderer.invoke("dcode:openExternal", url),
  restartHost: () => ipcRenderer.invoke("dcode:restartHost"),
  readyToQuit: (error?: string) => ipcRenderer.send("dcode:readyToQuit", error),
});
