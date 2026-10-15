// 同块流式模拟（不进入产品）：真实 React + 真实 Timeline + 真实 ResizeObserver + 真实滚动事件。
// 在 Timeline 的公开 props 数据边界，让同一条 message.id 的 text 逐步增长（blocks.length 不变）。
// 滚动事件由真实滚轮/键盘/程序化 scrollTop 触发；高度变化由真实布局驱动，不改 DOM。
// 场景独立原则：真实产品中块清空即切 DraftState、Timeline 卸载（App.tsx），
// 因此每个场景用新 session.id 重挂 Timeline（真实组件卸载/挂载，带初始消息挂载），
// 不从真实产品不会出现的「同一实例上空 Timeline」起步。
import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import type { AppSnapshot, Session, TimelineBlock } from "@/contracts";
import { Timeline } from "sim-timeline";
import { syncLanguage } from "../../../src/renderer/i18n";
import { TooltipProvider } from "sim-tooltip";

declare global {
  interface Window {
    __SIM: {
      /** 新场景：以新 session.id 重挂 Timeline，初始即带的 blocks（真实进入会话生命周期） */
      resetSession(blocks: TimelineBlock[]): void;
      appendBlock(b: TimelineBlock): void;
      growBlock(id: string, delta: string): void;
      getScrollerInfo(): {
        scrollTop: number;
        scrollHeight: number;
        clientHeight: number;
        messageCount: number;
        rowCount: number;
        blockHeight(needle: string): number;
        blockTextLength(needle: string): number;
      };
    };
  }
}

const now = Date.now();
let sessionSeq = 0;

function makeSession(id: string): Session {
  return { id, taskId: "task-default", title: `模拟会话 ${id}`, kind: "main", updatedAt: now };
}

function buildSnapshot(session: Session, blocks: TimelineBlock[]): AppSnapshot {
  return {
    workspaces: [{ id: "ws", name: "模拟", folders: ["/tmp"], builtinHome: true, defaultTaskId: "task-default" }],
    tasks: [{ id: "task-default", workspaceId: "ws", parentId: null, kind: "long", title: "模拟任务", boundFolder: "/tmp", isDefault: true, updatedAt: now }],
    sessions: [session],
    timelines: { [session.id]: blocks },
    runs: {},
    // D 片新增的两份快照字段：时间线会按会话 id 读 sessionModels、任务区读 taskUsage。
    // 模拟运行不发真实请求，因此如实给"没有实际采用、没有用量、没有任务汇总"，
    // 而不是省略字段让渲染层在初始化时索引 undefined。
    sessionModels: {
      [session.id]: {
        sessionId: session.id,
        choice: { mode: "auto" },
        actual: null,
        actualResponseId: null,
        usage: null,
        requests: [],
        thinkingLevel: null,
        lastRouting: null,
        lastResult: "none",
        invalidReason: null,
        waitingExplicitContinue: false,
      },
    },
    taskUsage: {},
    settings: { theme: "light", fontSize: 13, coldStart: "home-draft", language: "zh" },
    model: { available: true, name: "mock" },
    execution: { kind: "mock" },
    closeError: null,
    closeErrorRevision: 0,
  };
}

/**
 * 模拟运行不接主进程（无 preload、无 IPC），但渲染树会挂载 C07 模型入口。
 * 这里给一份**有限且如实**的桥：模型来源目录为空、额度无来源，
 * 模拟运行本来就不发真实请求，不能因为缺桥就整页崩掉。
 */
function installBridgeStub(): void {
  const emptyState = (sessionId: string) => ({
    sessionId,
    choice: { mode: "auto" as const },
    actual: null,
    actualResponseId: null,
    usage: null,
    requests: [],
    thinkingLevel: null,
    lastRouting: null,
    lastResult: "none" as const,
    invalidReason: null,
    waitingExplicitContinue: false,
  });
  const stub = {
    listModelSources: async () => ({ sources: [], defaultChoice: { mode: "auto" as const }, sessionStates: [] }),
    readModelQuota: async () => ({
      sourceId: "",
      modelId: "",
      state: "unsupported" as const,
      poolId: null,
      windowLabel: null,
      updatedAt: null,
      reason: "模拟运行没有额度来源",
    }),
    setSessionModelChoice: async ({ sessionId }: { sessionId: string }) => emptyState(sessionId),
    setSessionThinkingLevel: async ({ sessionId }: { sessionId: string }) => emptyState(sessionId),
    resolveSessionRouting: async ({ sessionId }: { sessionId: string }) => emptyState(sessionId),
  };
  Object.defineProperty(window, "dcode", { value: stub, configurable: true, writable: true });
}

function App() {
  const [session, setSession] = useState<Session>(() => makeSession(`s${sessionSeq++}`));
  const [blocks, setBlocks] = useState<TimelineBlock[]>([]);
  const snapshot = buildSnapshot(session, blocks);

  useEffect(() => { syncLanguage(snapshot); }, [snapshot.settings.language]);
  useEffect(() => {
    document.documentElement.style.setProperty("--ui-font-size-num", String(snapshot.settings.fontSize));
    document.documentElement.dataset.theme = snapshot.settings.theme;
  }, [snapshot.settings.fontSize, snapshot.settings.theme]);

  window.__SIM = {
    resetSession(next: TimelineBlock[]) {
      // 新 session.id → Timeline（key 由 session.id 驱动的 effect）卸载重挂，意图按新会话初始化
      setBlocks(next);
      setSession(makeSession(`s${sessionSeq++}`));
    },
    appendBlock(b: TimelineBlock) {
      setBlocks((cur) => [...cur, b]);
    },
    growBlock(id: string, delta: string) {
      setBlocks((cur) => cur.map((b) => (b.kind === "message" && b.id === id ? { ...b, text: b.text + delta } : b)));
    },
    getScrollerInfo() {
      const scroller = document.querySelector("main .overflow-y-auto") as HTMLElement | null;
      const col = scroller?.querySelector(".space-y-3") as HTMLElement | null;
      const children = col ? [...col.children] : [];
      // 真实消息块 = 高度 >1 的容器；占位 endRef 高度恒 0（不计）
      const realBlocks = children.filter((el) => (el as HTMLElement).getBoundingClientRect().height > 1);
      const findByText = (needle: string) => realBlocks.find((el) => (el.textContent ?? "").startsWith(needle));
      return {
        scrollTop: Math.round(scroller?.scrollTop ?? 0),
        scrollHeight: scroller?.scrollHeight ?? 0,
        clientHeight: scroller?.clientHeight ?? 0,
        messageCount: realBlocks.length,
        rowCount: children.length,
        blockHeight: (needle: string) => findByText(needle)?.getBoundingClientRect().height ?? 0,
        blockTextLength: (needle: string) => (findByText(needle) as HTMLElement | undefined)?.textContent?.length ?? 0,
      };
    },
  };

  return (
    <TooltipProvider>
      <main style={{ height: "100vh", display: "flex", flexDirection: "column", margin: 0 }} className="flex min-h-0 flex-1 min-w-0 flex-col bg-background">
        <Timeline
          snapshot={snapshot}
          session={session}
          draft=""
          onDraftChange={() => {}}
          onSend={() => {}}
          onResume={async () => {}}
          onDismissResume={() => {}}
          resumeDismissed={false}
          onOpenChanges={() => {}}
          onRetrySend={() => {}}
          onCheckReceipt={() => {}}
          onPause={() => {}}
          onNewSession={() => {}}
          locationLabel="模拟"
          resumePending={false}
          pendingSendText={null}
          unknownSendText={null}
          mode="steer"
          onModeChange={() => {}}
        />
      </main>
    </TooltipProvider>
  );
}

const container = document.getElementById("root");
if (!container) throw new Error("missing root");
installBridgeStub();
createRoot(container).render(<App />);
