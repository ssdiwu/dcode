// 正常首次初始化只建内置对象；示例历史由隔离装配显式注入。
import type { PersistedState } from "./types";

export function seedState(): PersistedState {
  return {
    workspaces: [{ id: "ws-home", name: "Home", folders: ["~"], builtinHome: true, defaultTaskId: "task-home-default" }],
    tasks: [{ id: "task-home-default", workspaceId: "ws-home", parentId: null, kind: "long", title: "默认任务", boundFolder: null, isDefault: true, updatedAt: Date.now() }],
    sessions: [], timelines: {}, runs: {}, sessionModels: {},
    settings: { theme: "system", fontSize: 14, coldStart: "restore", language: "system", newSessionModelChoice: { mode: "auto" }, modelCandidates: [] },
    pendingFirstSends: {},
  };
}
