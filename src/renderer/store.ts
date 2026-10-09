// 界面状态：应用快照经桥订阅；界面草稿、选择与几何为界面本地状态。
// 产品状态的唯一写入者是 application；这里不复制可推进的执行状态。

import { useEffect, useMemo, useRef, useState } from "react";
import { syncLanguage } from "./i18n";
import type { AppSnapshot, SendMode } from "@/contracts";

let current: AppSnapshot | null = null;
const listeners = new Set<() => void>();

// 桥由 preload 建立；ESM 打包下其完成时机可能晚于页面脚本，必须等待而不是假定存在。
// 依据：E2E 冷启动间歇空渲染（window.dcode 为 undefined 时入口模块整体抛错）。
export function initSnapshotBridge(): void {
  const attempt = (n: number): void => {
    const bridge = (window as { dcode?: import("@/contracts").DCodeBridge }).dcode;
    if (!bridge) {
      if (n > 200) return; // 10s 后仍无桥：界面保持「载入中」，不假装可用
      setTimeout(() => attempt(n + 1), 50);
      return;
    }
    void bridge.getSnapshot().then((snap) => {
      // 先更新语言，再交付快照；渲染失败页也能使用已保存的语言。
      syncLanguage(snap);
      current = snap;
      listeners.forEach((l) => l());
    });
    bridge.onSnapshot((snap) => {
      // 先更新语言，再交付快照；渲染失败页也能使用已保存的语言。
      syncLanguage(snap);
      current = snap;
      listeners.forEach((l) => l());
    });
  };
  attempt(0);
}

export function useSnapshot(): AppSnapshot | null {
  const [snap, setSnap] = useState<AppSnapshot | null>(() => current);
  useEffect(() => {
    const cb = () => setSnap(current);
    listeners.add(cb);
    if (current && current !== snap) setSnap(current);
    return () => {
      listeners.delete(cb);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return snap;
}

// ---------- 界面本地状态（草稿、选择、几何），localStorage 持久化 ----------

const UI_KEY = "dcode-prototype-ui-v1";

export interface UiState {
  /** 当前选中的会话（界面位置，不代表执行状态） */
  selectedSessionId: string | null;
  /** 草稿目标：选中任务但尚未创建会话 */
  draftTaskId: string | null;
  /** 上次现场：重开时恢复的位置 */
  lastScene: { sessionId: string | null; draftTaskId: string | null } | null;
  expandedWorkspaceIds: string[];
  /** 任务子任务展开（多选，纯导航） */
  expandedTaskIds: string[];
  /** 手风琴：同一时刻最多一个任务展开会话列表 */
  expandedTaskId: string | null;
  view: "session" | "settings";
  /** 检查器引用具体的聚合卡（会话 + 块 id），内容始终从当前快照取，不缓存 diff 正文 */
  inspector: { sessionId: string; blockId: string; activeFile: string } | null;
  drafts: Record<string, string>;
  /** 发送操作 operationId → 原草稿键：回执在重试/回查后才到达时，仍能清掉正确的草稿 */
  draftOfOperation: Record<string, string>;
  /** 草稿键 → 本次发送持有的身份与原文：界面自己生成并随草稿持久化；
   *  同文同模式重发复用同一身份（应答丢失/重开后只读找回，不重建对象），内容变了即新身份 */
  operationOfDraft: Record<string, { operationId: string; text: string; mode: SendMode }>;
  /** 恢复条已忽略（仅查看）的会话 */
  dismissedResume: string[];
  /** 外层应答丢失、待核对的本次发送 operationId：未知只在原消息与输入状态说明，不当成新输入 */
  unknownOps: string[];
  /** 一次性提示（如恢复目标失效回退） */
  notice: string | null;
}

const DEFAULT_UI: UiState = {
  selectedSessionId: null,
  draftTaskId: null,
  lastScene: null,
  expandedWorkspaceIds: [],
  expandedTaskIds: [],
  expandedTaskId: null,
  view: "session",
  inspector: null,
  drafts: {},
  draftOfOperation: {},
  operationOfDraft: {},
  dismissedResume: [],
  unknownOps: [],
  notice: null,
};

export function loadUiState(): UiState {
  try {
    const raw = localStorage.getItem(UI_KEY);
    if (raw) return { ...DEFAULT_UI, ...(JSON.parse(raw) as Partial<UiState>) };
  } catch {
    // 损坏的本地界面状态直接回到默认，不阻塞启动
  }
  return { ...DEFAULT_UI };
}

export function persistUiState(state: UiState): string | null {
  try {
    localStorage.setItem(UI_KEY, JSON.stringify(state));
    return null;
  } catch (error) {
    // 存储满或不可用：如实上报，不假装已存（界面照常工作，只是不记住布局）
    return String(error);
  }
}

export function usePersistentUi(state: UiState): void {
  const serialized = useMemo(() => JSON.stringify(state), [state]);
  const failed = useRef(false);
  useEffect(() => {
    const error = persistUiState(JSON.parse(serialized) as UiState);
    if (error && !failed.current) {
      failed.current = true; // 只提示一次，不随每次渲染重复打断
      window.dispatchEvent(new CustomEvent("dcode:draft-persist-failed"));
    }
  }, [serialized]);
}
