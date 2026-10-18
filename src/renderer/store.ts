// 界面状态：应用快照经桥订阅；界面草稿、选择与几何为界面本地状态。
// 产品状态的唯一写入者是 application；这里不复制可推进的执行状态。

import { useEffect, useMemo, useRef, useState } from "react";
import { syncLanguage } from "./i18n";
import { parseWorkReference, referenceSetId } from "@/contracts";
import type { AppSnapshot, SendMode, WorkReference } from "@/contracts";

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

/**
 * 草稿版本身份：文字 + 用途 + 引用集合，三者一起构成"这是不是同一次提交的那一版"。
 * 直接回执、自然快照与显式查查/同次重试三条清稿通路必须用**同一个**判据：
 * 文字相同但引用换了，是新的一版，旧回执不得清掉它的文字或引用。
 */
export type DraftVersion = Readonly<{ text: string; mode: SendMode; referenceSetId: string }>;

export function draftVersionOf(text: string, mode: SendMode, references: readonly { kind: "file" | "skill"; locator: string; snapshot: { contentHash: string } }[] | undefined): DraftVersion {
  return { text, mode, referenceSetId: referenceSetId(references ?? []) };
}

/** 版本判据：三个字段逐项相等才算"仍是那一版"。 */
export function isSameDraftVersion(a: DraftVersion | null | undefined, b: DraftVersion): boolean {
  return a !== null && a !== undefined && a.text === b.text && a.mode === b.mode && a.referenceSetId === b.referenceSetId;
}

/**
 * 回执确认已接收后清掉对应草稿与发送身份——三条通路（直接应答 / 自然快照 / 显式查回与重试）
 * 共用的**唯一**判据：当前草稿是否仍是这次提交的那一版（文字 + 用途 + 引用集合，逐项相等）。
 * 文字相同但引用换了 = 新的一版：文字与引用都必须留下，只解除这次发送的身份占位；
 * 也不在同一版时无论哪条通路都不得清用户正在写的新稿，更不能只留 chip 不留文字。
 */
export function clearAcceptedDraft(
  ui: UiState,
  operationId: string,
  sentVersion: DraftVersion,
  currentMode: SendMode,
): UiState {
  const key = ui.draftOfOperation[operationId];
  if (!key) return ui;
  const sameOperation = ui.operationOfDraft[key]?.operationId === operationId;
  const draftOfOperation = { ...ui.draftOfOperation };
  const operationOfDraft = { ...ui.operationOfDraft };
  delete draftOfOperation[operationId];
  if (!sameOperation) return { ...ui, draftOfOperation, operationOfDraft };
  const currentVersion = draftVersionOf((ui.drafts[key] ?? "").trim(), currentMode, ui.referencesOfDraft[key]);
  if (isSameDraftVersion(currentVersion, sentVersion)) {
    const drafts = { ...ui.drafts, [key]: "" };
    const referencesOfDraft = { ...ui.referencesOfDraft };
    delete referencesOfDraft[key];
    delete operationOfDraft[key];
    return { ...ui, drafts, referencesOfDraft, draftOfOperation, operationOfDraft };
  }
  // 不是同一版：只释放这次发送的身份占位，绝不碰用户正在写的新稿与新引用。
  delete operationOfDraft[key];
  return { ...ui, draftOfOperation, operationOfDraft };
}

export interface UiState {
  /** 当前选中的会话（界面位置，不代表执行状态） */
  selectedSessionId: string | null;
  /** 草稿目标：选中任务但尚未创建会话 */
  draftTaskId: string | null;
  /** 新工作草稿的可选父长期任务；只保存界面意图，正式父归属由首发接收方写入。 */
  draftParentTaskId?: string | null;
  /** 上次现场：重开时恢复的位置 */
  lastScene: { sessionId: string | null; draftTaskId: string | null; draftParentTaskId: string | null } | null;
  expandedWorkspaceIds: string[];
  /** 任务子任务展开（多选，纯导航） */
  expandedTaskIds: string[];
  /** 手风琴：同一时刻最多一个任务展开会话列表 */
  expandedTaskId: string | null;
  view: "session" | "settings";
  /** 检查器引用具体的聚合卡（会话 + 块 id），内容始终从当前快照取，不缓存 diff 正文 */
  inspector: { sessionId: string; blockId: string; activeFile: string } | null;
  drafts: Record<string, string>;
  /**
   * 草稿键 → 该草稿当前携带的引用（C05）。
   * 唯一事实在这里：输入区只做呈现与增删转发，发送时按这一刻的集合带走。
   * 清稿判据用引用集合身份：发送途中增删引用后，旧一次 accepted 不得清掉新集合。
   */
  referencesOfDraft: Record<string, WorkReference[]>;
  /** 发送操作 operationId → 原草稿键：回执在重试/回查后才到达时，仍能清掉正确的草稿 */
  draftOfOperation: Record<string, string>;
  /** 草稿键 → 本次发送持有的身份与原文：界面自己生成并随草稿持久化；
   *  同文同模式重发复用同一身份（应答丢失/重开后只读找回，不重建对象），内容变了即新身份 */
  operationOfDraft: Record<string, { operationId: string; version: DraftVersion }>;
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
  draftParentTaskId: null,
  lastScene: null,
  expandedWorkspaceIds: [],
  expandedTaskIds: [],
  expandedTaskId: null,
  view: "session",
  inspector: null,
  drafts: {},
  referencesOfDraft: {},
  draftOfOperation: {},
  operationOfDraft: {},
  dismissedResume: [],
  unknownOps: [],
  notice: null,
};

/**
 * 承接旧版本保存的界面现场。
 *
 * C05 之前 `operationOfDraft` 的值是 `{operationId, text, mode}`，同一把 `dcode-prototype-ui-v1`
 * 下直接浅合并会把旧条目原样带进运行：读侧按 `version` 取值时会拿到 undefined 并崩在
 * `heldSend.version.text`（重开一条待核对的旧发送即可触发）。
 * 迁移按**旧条目自身**补出完整草稿版本：旧版本没有引用概念，引用集合身份取空集，
 * 原 operationId、原文、用途与 operationId↔草稿键的关联一律保留——
 * 清掉旧关联等于让用户那次待核对的发送失去归属，只是把崩溃换成静默错认。
 */
function normalizeOperationOfDraft(raw: unknown): Record<string, { operationId: string; version: DraftVersion }> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, { operationId: string; version: DraftVersion }> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as { operationId?: unknown; version?: unknown; text?: unknown; mode?: unknown };
    if (typeof entry.operationId !== "string" || !entry.operationId) continue;
    const version = isDraftVersion(entry.version)
      ? entry.version
      : typeof entry.text === "string"
        ? draftVersionOf(entry.text, entry.mode === "follow-up" ? "follow-up" : "steer", [])
        : null;
    // 既没有完整版本、也没有旧式原文的条目无法还原身份：宁可丢掉这条占位，
    // 也不能造一个对不上任何真实发送的 operationId。
    if (!version) continue;
    out[key] = { operationId: entry.operationId, version };
  }
  return out;
}

function isDraftVersion(value: unknown): value is DraftVersion {
  return Boolean(value) && typeof value === "object"
    && typeof (value as DraftVersion).text === "string"
    && ((value as DraftVersion).mode === "steer" || (value as DraftVersion).mode === "follow-up")
    && typeof (value as DraftVersion).referenceSetId === "string";
}

function stringRecord(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function stringArray(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string") : [];
}

/** 检查器引用只保留指向真实块的完整三元组；缺任一项就不恢复它，不半截呈现。 */
function normalizeInspector(raw: unknown): UiState["inspector"] {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as { sessionId?: unknown; blockId?: unknown; activeFile?: unknown };
  if (typeof value.sessionId !== "string" || typeof value.blockId !== "string") return null;
  return { sessionId: value.sessionId, blockId: value.blockId, activeFile: typeof value.activeFile === "string" ? value.activeFile : "" };
}

/** 引用集合只收形状合法的条目：损坏的本地现场不能变成渲染期崩溃或错认的清稿判据。 */
function normalizeReferencesOfDraft(raw: unknown): Record<string, WorkReference[]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, WorkReference[]> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    const refs: WorkReference[] = [];
    let broken = false;
    for (const item of value) {
      try {
        refs.push(parseWorkReference(item));
      } catch {
        broken = true;
        break;
      }
    }
    // 整条集合有一项不合法就整条丢弃：半截集合会让同一版草稿既非旧版也非新版。
    if (!broken) out[key] = refs;
  }
  return out;
}

/** 把任意来源的保存现场归一成当前形状；损坏或缺失的字段回到默认值，不阻塞启动。 */
export function normalizeUiState(raw: unknown): UiState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_UI };
  const value = raw as Partial<UiState> & Record<string, unknown>;
  const scene = value.lastScene as { sessionId?: unknown; draftTaskId?: unknown; draftParentTaskId?: unknown } | null | undefined;
  return {
    ...DEFAULT_UI,
    ...value,
    selectedSessionId: typeof value.selectedSessionId === "string" ? value.selectedSessionId : null,
    draftTaskId: typeof value.draftTaskId === "string" ? value.draftTaskId : null,
    draftParentTaskId: typeof value.draftParentTaskId === "string" ? value.draftParentTaskId : null,
    lastScene: scene && typeof scene === "object"
      ? {
        sessionId: typeof scene.sessionId === "string" ? scene.sessionId : null,
        draftTaskId: typeof scene.draftTaskId === "string" ? scene.draftTaskId : null,
        draftParentTaskId: typeof scene.draftParentTaskId === "string" ? scene.draftParentTaskId : null,
      }
      : null,
    expandedWorkspaceIds: stringArray(value.expandedWorkspaceIds),
    expandedTaskIds: stringArray(value.expandedTaskIds),
    view: value.view === "settings" ? "settings" : "session",
    drafts: stringRecord(value.drafts),
    expandedTaskId: typeof value.expandedTaskId === "string" ? value.expandedTaskId : null,
    inspector: normalizeInspector(value.inspector),
    referencesOfDraft: normalizeReferencesOfDraft(value.referencesOfDraft),
    draftOfOperation: stringRecord(value.draftOfOperation),
    operationOfDraft: normalizeOperationOfDraft(value.operationOfDraft),
    dismissedResume: stringArray(value.dismissedResume),
    unknownOps: stringArray(value.unknownOps),
    notice: typeof value.notice === "string" ? value.notice : null,
  };
}

export function loadUiState(): UiState {
  try {
    const raw = localStorage.getItem(UI_KEY);
    if (raw) return normalizeUiState(JSON.parse(raw));
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
