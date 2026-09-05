import { contextBridge, ipcRenderer } from "electron";

/**
 * 渲染层唯一通道（电话线预铺约束之二）：一切 Host 交互经主进程桥接的
 * 版本化 IPC；渲染层永不直接触碰传输。
 */
contextBridge.exposeInMainWorld("dcode", {
  request: (method: string, params?: Record<string, unknown>) =>
    ipcRenderer.invoke("dcode:request", method, params ?? {}),
  subscribe: (handler: (envelope: unknown) => void) => {
    const listener = (_event: unknown, envelope: unknown) => handler(envelope);
    ipcRenderer.on("dcode:event", listener as never);
    return () => {
      ipcRenderer.removeListener("dcode:event", listener as never);
    };
  },
  notify: (options: { title: string; body?: string }) =>
    ipcRenderer.invoke("dcode:notify", options),
  restartHost: () => ipcRenderer.invoke("dcode:restartHost"),
});
