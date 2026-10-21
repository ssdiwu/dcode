// 工作台壳：侧栏树｜主区（草稿态 / 时间线 / 设置页）｜按需检查器。
// 冷启动落点、恢复目标失效回退、草稿保留与纯导航规则都在这里收口。
// 发送语义：草稿只在「已接收」后清除；确认未接收保留原文+原因+重试；待核对只读回查，不盲投。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppSnapshot, SendMode, WorkReference } from "@/contracts";
import { clearAcceptedDraft, loadUiState, usePersistentUi, useSnapshot, draftVersionOf, isSameDraftVersion, type UiState } from "./store";
import { Sidebar } from "./views/Sidebar";
import { Timeline } from "./views/Timeline";
import { Inspector } from "./views/Inspector";
import { DraftState } from "./views/DraftState";
import { SettingsPage } from "./views/SettingsPage";
import { Banner } from "./components/Banner";
import { Button } from "./components/Button";
import { TooltipProvider } from "./components/ui/tooltip";
import { useT } from "./i18n";

function locationOf(
  snapshot: AppSnapshot,
  sessionId: string | null,
  draftTaskId: string | null,
  defaultTaskLabel: string,
): string {
  const taskId = sessionId
    ? snapshot.sessions.find((s) => s.id === sessionId)?.taskId
    : draftTaskId;
  const task = snapshot.tasks.find((t) => t.id === taskId);
  if (!task) return "";
  const workspace = snapshot.workspaces.find((w) => w.id === task.workspaceId);
  return `${workspace?.name ?? "?"} / ${task.isDefault ? defaultTaskLabel : task.title}`;
}

// 发送身份生成：界面侧唯一即可（关联用途，无安全语义）；不依赖安全上下文 API
let operationCounter = 0;
const newOperationId = () => `op-${Date.now().toString(36)}-${(operationCounter++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function draftKeyOf(ui: Pick<UiState, "selectedSessionId" | "draftTaskId" | "draftParentTaskId">): string | null {
  if (ui.selectedSessionId) return ui.selectedSessionId;
  if (!ui.draftTaskId) return null;
  return ui.draftParentTaskId
    ? `draft:${ui.draftTaskId}:child:${ui.draftParentTaskId}`
    : `draft:${ui.draftTaskId}`;
}

export default function App() {
  const t = useT();
  const snapshot = useSnapshot();
  const [ui, setUi] = useState<UiState>(loadUiState);
  const [booted, setBooted] = useState(false);
  const [focusKey, setFocusKey] = useState(0);
  const navigationGeneration = useRef(0);
  const [sendMode, setSendMode] = useState<SendMode>("steer");
  /**
   * 当前用途的即时值。发送／回查／重试都在 await 之后才清稿，那时组件可能已经重渲染过好几次：
   * 直接用 await 所在那次 render 闭包里的 sendMode，会在"steer 发起 → 用户改成 follow-up →
   * 旧回执到达"时按 steer 清掉用户的新稿。这里保证清稿读到的是**此刻**的用途。
   */
  const sendModeRef = useRef(sendMode);
  sendModeRef.current = sendMode;
  // D02：缺配置提示里的「去设置」直接落在模型分区；侧栏的设置入口仍从外观开始
  const [settingsSection, setSettingsSection] = useState<"appearance" | "startup" | "model" | "about">("appearance");
  const [dismissedCloseErrorRevision, setDismissedCloseErrorRevision] = useState<number | null>(null);
  const [draftPersistFailed, setDraftPersistFailed] = useState(false);
  // 同次双击不重复投递：同草稿键+同原文的在途提交直接忽略（重试走消息块上的重试入口）。
  // 「旧发送待回执」是输入区状态表的事实来源（pendingSendText），不是全局 sending 布尔
  const submittingRef = useRef<{ key: string; text: string } | null>(null);
  const [, bumpSubmit] = useState(0);

  usePersistentUi(ui);

  const patch = useCallback((partial: Partial<UiState>) => {
    setUi((prev) => ({ ...prev, ...partial }));
  }, []);

  // ---------- 冷启动：恢复现场或固定 Home 新草稿（只恢复界面位置） ----------
  useEffect(() => {
    if (!snapshot || booted) return;
    const home = snapshot.workspaces.find((w) => w.builtinHome);
    const homeDraft = { draftTaskId: home?.defaultTaskId ?? null, draftParentTaskId: null, selectedSessionId: null };

    if (snapshot.settings.coldStart === "restore" && ui.lastScene) {
      const { sessionId, draftTaskId, draftParentTaskId } = ui.lastScene;
      const session = sessionId ? snapshot.sessions.find((s) => s.id === sessionId) : null;
      const draftTask = draftTaskId ? snapshot.tasks.find((t) => t.id === draftTaskId) : null;
      const validDraftTask = draftTask && (!draftParentTaskId || (draftTask.id === draftParentTaskId && draftTask.kind === "long"));
      if (session) {
        selectSession(session.id, snapshot, patch, ui);
      } else if (validDraftTask) {
        selectDraft(draftTask.id, snapshot, patch, ui, draftParentTaskId);
      } else if (sessionId || draftTaskId) {
        // 恢复目标已不存在：回退到 Home 默认任务的新草稿，并说明结果
        setUi((prev) => ({
          ...prev,
          ...homeDraft,
          notice: "__fallback__",
        }));
      }
      if (home) {
        setUi((prev) => ({
          ...prev,
          expandedWorkspaceIds: [...new Set([...prev.expandedWorkspaceIds, home.id])],
        }));
      }
    } else {
      // 固定 Home 新草稿，或没有任何现场记录
      if (home) {
        setUi((prev) => ({
          ...prev,
          ...homeDraft,
          expandedWorkspaceIds: [...new Set([...prev.expandedWorkspaceIds, home.id])],
        }));
      }
    }
    setBooted(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, booted]);

  // ---------- 主题与字号旋钮 ----------
  useEffect(() => {
    if (!snapshot) return;
    const { theme, fontSize } = snapshot.settings;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && media.matches);
      document.documentElement.classList.toggle("dark", dark);
    };
    apply();
    media.addEventListener("change", apply);
    document.documentElement.style.setProperty("--ui-font-size-num", String(fontSize));
    return () => media.removeEventListener("change", apply);
  }, [snapshot, snapshot?.settings.theme, snapshot?.settings.fontSize]);

  // ---------- 设置页 Esc 返回 ----------
  useEffect(() => {
    if (ui.view !== "settings") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !(event as KeyboardEvent).isComposing) {
        // S02：有开着的菜单/对话框浮层时，Esc 只关闭那个浮层（由各浮层自行消费），不连带退出设置
        if (document.querySelector('[data-slot="dropdown-menu-content"], [data-slot="dialog-content"]')) return;
        patch({ view: "session" });
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [ui.view, patch]);

  // ---------- 草稿本地持久化失败：如实提示，不假装已存 ----------
  useEffect(() => {
    const onFail = () => setDraftPersistFailed(true);
    window.addEventListener("dcode:draft-persist-failed", onFail);
    return () => window.removeEventListener("dcode:draft-persist-failed", onFail);
  }, []);

  const selectedSession = useMemo(
    () => snapshot?.sessions.find((s) => s.id === ui.selectedSessionId) ?? null,
    [snapshot, ui.selectedSessionId],
  );
  const sendUnknownNotice = t("app.sendUnknown");

  // 外层回包可能丢失而正式快照已 accepted：按原操作清稿与身份，不能只删 unknown 标记
  // 又让旧文成为新输入；后来改写的草稿保留。未知仍经原消息 T02 回查。
  useEffect(() => {
    if (!snapshot || ui.unknownOps.length === 0) return;
    setUi((prev) => {
      let next = prev;
      const unknownOps = prev.unknownOps.filter((op) => {
        const hit = Object.values(snapshot.timelines).flat().find((b) => b.kind === "message" && b.operationId === op);
        if (!hit || hit.kind !== "message" || !hit.receipt || hit.receipt.status === "unknown") return true;
        // 只有带发送身份的用户消息才谈得上"这次发送的草稿版本"；助手/工具块没有可清的原稿。
        if (hit.receipt.status === "accepted" && hit.kind === "message" && hit.role === "user" && hit.mode) {
          // 历史消息块携带的就是这次发送的完整草稿版本（文字、用途与引用集合身份）。
          next = clearAcceptedDraft(next, op, draftVersionOf(hit.text, hit.mode, hit.references), sendModeRef.current);
        }
        return false;
      });
      if (unknownOps.length === prev.unknownOps.length) return prev;
      return {
        ...next, unknownOps,
        notice: unknownOps.length === 0 && prev.notice === sendUnknownNotice ? null : prev.notice,
      };
    });
  }, [snapshot, ui.unknownOps, sendUnknownNotice]);

  // 恢复条与本按钮共用的同一在途继续（T08）：同一会话的恢复请求在途时两入口交错/连点只执行一次；
  // 在途依赖真实 Promise settle，失败（errorNote 进快照）后可再次明确尝试
  const resumeFlights = useRef(new Map<string, Promise<void>>());
  const [, bumpResume] = useState(0);
  const handleResume = useCallback(
    (sessionId: string): Promise<void> => {
      // 同步登记真实 Promise：React 尚未重渲染时的两入口连点也复用；A 收束不释放 B。
      const pending = resumeFlights.current.get(sessionId);
      if (pending) return pending;
      const flight = Promise.resolve().then(() => window.dcode.resumeRun({ sessionId }))
        .then(() => undefined, () => undefined)
        .finally(() => {
          if (resumeFlights.current.get(sessionId) === flight) resumeFlights.current.delete(sessionId);
          bumpResume((n) => n + 1);
        });
      resumeFlights.current.set(sessionId, flight);
      bumpResume((n) => n + 1);
      return flight;
    },
    [],
  );

  // 异步回调（建任务后选中、发送后跳转）必须读最新快照：
  // 此前闭包本轮渲染的 snapshot，createTask 后 selectDraft 在旧快照里找不到新任务而静默放弃，
  // 表现为「任务建出来了但主区没有跟过去」。证据：E2E 开发任务全链在创建后等不到位置标签。
  // 修复：经桥重新读快照——IPC 返回时应用层状态已提交，必然包含新对象。
  const latestSnapshot = () => window.dcode.getSnapshot();

  const draftKey = draftKeyOf(ui);
  const draft = draftKey ? (ui.drafts[draftKey] ?? "") : "";

  // C01「新文字」vs 同次旧输入的事实来源：
  // pendingSendText = 同草稿键、仍等待回执的本次发送原文（文字未变就不是新草稿）；
  // unknownSendText = 同一次发送接收结果未知的原文（沿既有 operationOfDraft 与时间线回执投影）
  const pendingSendText =
    submittingRef.current && draftKey && submittingRef.current.key === draftKey ? submittingRef.current.text : null;
  const heldSend = draftKey ? ui.operationOfDraft[draftKey] : undefined;
  const unknownSendText = useMemo(() => {
    if (!snapshot) return null;
    // 来源一：外层应答丢失的待核对标记（ui.unknownOps，只读定界，不重建接收事实）；
    // 来源二：时间线原消息回执投影仍为 unknown（持久化的待核对事实）
    if (heldSend && ui.unknownOps.includes(heldSend.operationId)) return heldSend.version.text;
    for (const blocks of Object.values(snapshot.timelines)) {
      const hit = blocks.find((b) => b.kind === "message" && b.operationId === heldSend?.operationId);
      if (heldSend && hit && hit.kind === "message" && hit.receipt?.status === "unknown") return heldSend.version.text;
    }
    // 首发原稿关联仍在 draft:<task>，新会话不能因此漏掉原消息待核对的 C06 说明。
    const unresolved = [...(snapshot.timelines[ui.selectedSessionId ?? ""] ?? [])].reverse().find(
      (b) => b.kind === "message" && b.role === "user" && b.receipt?.status === "unknown",
    );
    if (unresolved?.kind === "message") return unresolved.text;
    return null;
  }, [heldSend, snapshot, ui.unknownOps, ui.selectedSessionId]);

  // 所有 Hook 必须先于任何提前返回：本 useMemo 曾在 `if (!snapshot) return` 之后，
  // 首帧快照未到时少执行一个 Hook，下一帧触发 React #310（Rendered more hooks）间歇白屏。
  // 证据：E2E 连续启动约半数空渲染，dev 构建下必现；修复后 debug-race 12 连跑无复发。
  // 检查器内容按会话 + 块 id 精确定位：同名文件可能出现在多个会话的聚合卡里，
  // 此前按路径全局扫描曾把别的会话的 diff 配到当前标签下（E2E 全链复现）。
  const inspectorFiles = useMemo(() => {
    if (!ui.inspector || !snapshot) return null;
    const blocks = snapshot.timelines[ui.inspector.sessionId] ?? [];
    const block = blocks.find((b) => b.id === ui.inspector!.blockId && b.kind === "change-summary");
    return block && block.kind === "change-summary" ? block.files : null;
  }, [ui.inspector, snapshot]);

  if (!snapshot) {
    return <div className="flex h-full items-center justify-center text-ui-sm text-subtlest">{t("app.loading")}</div>;
  }

  const selectAndRecord = (partial: Partial<UiState>) => {
    setUi((prev) => {
      const next = { ...prev, ...partial, notice: partial.notice ?? null };
      next.lastScene = { sessionId: next.selectedSessionId, draftTaskId: next.draftTaskId, draftParentTaskId: next.draftParentTaskId ?? null };
      return next;
    });
  };

  const handleSelectSession = (sessionId: string) => {
    const generation = ++navigationGeneration.current;
    void latestSnapshot().then((s) => { if (navigationGeneration.current === generation) selectSession(sessionId, s, (p) => selectAndRecord(p), ui); });
  };
  const handleSelectDraft = (taskId: string, parentTaskId: string | null = null) => {
    const generation = ++navigationGeneration.current;
    void latestSnapshot().then((s) => { if (navigationGeneration.current === generation) selectDraft(taskId, s, (p) => selectAndRecord(p), ui, parentTaskId); });
  };

  const handleSend = async (references: readonly WorkReference[] = []) => {
    const key = draftKey;
    const text = draft.trim();
    if (!key || !text) return;
    // C02：旧发送未知时，Enter、点击或换 mode 均不能成为隐式重试（T02/T03 各自明确操作）。
    if (unknownSendText?.trim() === text) return;
    // 同草稿键+同原文的在途提交直接忽略；文字已改的是新发送身份，不因旧发送未返回被锁死
    if (submittingRef.current && submittingRef.current.key === key && submittingRef.current.text === text) return;
    const submitting = { key, text };
    submittingRef.current = submitting;
    bumpSubmit((n) => n + 1);
    // 发送身份由界面随草稿持有：**完整草稿版本**（文字+用途+引用集合）相同才复用同一身份
    // （外层应答丢失/重开后同身份重发可只读找回）；任一项变了即新身份。
    const referencesAtSend = references;
    const versionAtSend = draftVersionOf(text, sendMode, referencesAtSend);
    const held = ui.operationOfDraft[key];
    const reused = isSameDraftVersion(held?.version, versionAtSend);
    const operationId = reused ? held!.operationId : newOperationId();
    const effectiveMode = sendMode;
    if (!reused) {
      setUi((prev) => ({
        ...prev,
        operationOfDraft: { ...prev.operationOfDraft, [key]: { operationId, version: versionAtSend } },
        draftOfOperation: { ...prev.draftOfOperation, [operationId]: key },
      }));
    }
    try {
      // 引用随本次发送一起带走：用户原文字与引用内容在执行端分成独立内容块。
      const result = ui.selectedSessionId
        ? await window.dcode.sendMessage({ sessionId: ui.selectedSessionId, text, references: referencesAtSend, mode: effectiveMode, operationId })
        : await window.dcode.sendMessage({
          taskId: ui.draftTaskId ?? undefined,
          ...(ui.draftParentTaskId ? { parentTaskId: ui.draftParentTaskId } : {}),
          text, references: referencesAtSend, mode: effectiveMode, operationId,
        });
      // 续跑一律基于最新界面状态（等待回执期间用户可能已继续编辑或切走）：
      // 只清与本次提交仍对应（同键、同身份、内容未被新编辑替换）的原稿，其余草稿不动；
      // 首发进入新会话也仅当用户仍停留在同一草稿且未开始新编辑——切走或已改写的不拉回。
      setUi((prev) => {
        // 草稿只在「已接收」后清除；未接收／待核对保留原文（重试走消息块入口或同身份重发）。
        // 三条清稿通路走的是同一个判据函数，不在这里另写一份"只比文字"的近似实现。
        // 先按**清稿前**的当前草稿判定是否仍是那一版：首发转入新会话据此决定是否跟随，
        // 若在清稿之后再判，文字已被清空、永远判不出同一版。
        const sameVersion = isSameDraftVersion(
          draftVersionOf((prev.drafts[key] ?? "").trim(), sendModeRef.current, prev.referencesOfDraft[key]),
          versionAtSend,
        );
        let next = result.receipt.status === "accepted"
          ? clearAcceptedDraft(prev, operationId, versionAtSend, sendModeRef.current)
          : prev;
        if (!ui.selectedSessionId) {
          const currentKey = draftKeyOf(next);
          if (currentKey === key && sameVersion) {
            next = { ...next, selectedSessionId: result.sessionId, draftTaskId: null, draftParentTaskId: null, notice: null };
            next.lastScene = { sessionId: result.sessionId, draftTaskId: null, draftParentTaskId: null };
          }
        }
        return next;
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "";
      if (message.includes("父任务草稿归属无效") || message.includes("Unknown task:")) {
        // 目标确已失效是明确拒绝；保留草稿与父任务意图，不能标成“结果未知”诱导查回。
        setUi((prev) => ({ ...prev, notice: t("draft.targetUnavailable") }));
        return;
      }
      // 传输中断或返回未过接收侧校验：发送结果未知，不当成确定未接收——
      // 原文与发送身份保留，本次发送身份并入待核对标记（C02：Enter 不把待核对旧发送当新输入；
      // 换发送方式也不会让它改成新身份重投——这是「发送结果未知」的正式边界，未知只在原消息回查）
      setUi((prev) => ({ ...prev, notice: t("app.sendUnknown"), unknownOps: [...new Set([...prev.unknownOps, operationId])] }));
    } finally {
      // 按本次请求对象释放：A→B→A 的第三次 A 是新身份，第一次 A 迟到完成不能按同文误清。
      if (submittingRef.current === submitting) submittingRef.current = null;
      bumpSubmit((n) => n + 1);
    }
  };

  const openChanges = (sessionId: string, blockId: string, firstPath: string) => {
    patch({ inspector: { sessionId, blockId, activeFile: firstPath } });
  };

  // 回执确认已接收后清掉对应草稿与发送身份：按 operationId 关联（不按文字匹配），重试与只读回查找回共用。
  // 同样基于最新界面状态：草稿已被新编辑替换时保留新内容，只解除身份关联。
  const clearDraftOnAccepted = (sessionId: string, blockId: string, accepted: boolean) => {
    if (!accepted) return;
    const block = (snapshot.timelines[sessionId] ?? []).find((b) => b.id === blockId);
    if (!block || block.kind !== "message" || !block.operationId || !block.mode) return;
    const operationId = block.operationId;
    const version = draftVersionOf(block.text, block.mode, block.references);
    // 同样读当前用途：查回／重试的在途期间用户可能已经改了输入选项。
    setUi((prev) => clearAcceptedDraft(prev, operationId, version, sendModeRef.current));
  };

  const isDraft =
    ui.view === "session" &&
    !selectedSession &&
    ui.draftTaskId !== null;
  const sessionEmpty =
    selectedSession && (snapshot.timelines[selectedSession.id] ?? []).length === 0;

  return (
    // 滚动归属：壳层必须兜住工作台高度——flex 子项默认 min-height:auto，长内容会把整页撑成滚动容器。
    // 根因证据与验收见 test/e2e/evidence/scroll-2026-10-05/ 与 scroll.test.mjs。
    <TooltipProvider>
    <div className="app-shell flex h-full min-h-0 overflow-hidden">
      <Sidebar
        snapshot={snapshot}
        selection={{ sessionId: ui.selectedSessionId, draftTaskId: ui.draftTaskId }}
        expandedWorkspaceIds={ui.expandedWorkspaceIds}
        expandedTaskIds={ui.expandedTaskIds}
        expandedTaskId={ui.expandedTaskId}
        onSelectSession={(id) => {
          handleSelectSession(id);
          patch({ view: "session" });
        }}
        onSelectDraft={(id) => {
          handleSelectDraft(id);
          patch({ view: "session" });
        }}
        onToggleWorkspace={(id) =>
          patch({
            expandedWorkspaceIds: ui.expandedWorkspaceIds.includes(id)
              ? ui.expandedWorkspaceIds.filter((w) => w !== id)
              : [...ui.expandedWorkspaceIds, id],
          })
        }
        onExpandTask={(id) => patch({ expandedTaskId: id })}
        onToggleTaskChildren={(id) =>
          patch({
            expandedTaskIds: ui.expandedTaskIds.includes(id)
              ? ui.expandedTaskIds.filter((t) => t !== id)
              : [...ui.expandedTaskIds, id],
          })
        }
        onOpenSettings={() => {
          setSettingsSection("appearance");
          patch({ view: "settings" });
        }}
        onNewDraft={(workspaceId, parentTaskId) => {
          const workspace = snapshot.workspaces.find((w) => w.id === workspaceId);
          if (workspace) {
            handleSelectDraft(parentTaskId ?? workspace.defaultTaskId, parentTaskId);
            patch({ view: "session" });
          }
        }}
        onTaskCreated={(created) => {
          // 设置页内也能创建任务：保存或查回成功须同时退出设置页并定位已保存主会话。
          patch({ view: "session", expandedWorkspaceIds: [...new Set([...ui.expandedWorkspaceIds, created.workspaceId])] });
          // 命名任务保存时已带唯一主会话；进入它后首条输入不能再建空间根任务。
          handleSelectSession(created.mainSessionId);
        }}
        onMoveTask={(taskId, targetWorkspaceId) => void window.dcode.moveTask({ taskId, targetWorkspaceId })}
        onWorkspaceCreated={(workspace) => {
          patch({ expandedWorkspaceIds: [...new Set([...ui.expandedWorkspaceIds, workspace.id])] });
          handleSelectDraft(workspace.defaultTaskId);
        }}
      />

      <main className="flex min-h-0 flex-1 min-w-0 flex-col bg-background">
        {ui.notice && (
          <div className="px-4 pt-3">
            <Banner tone="info" actions={
              <Button size="sm" variant="ghost" onClick={() => patch({ notice: null })}>{t("app.noticeDismiss")}</Button>
            }>
              {ui.notice === "__fallback__" ? t("app.noticeFallback") : ui.notice}
            </Banner>
          </div>
        )}

        {snapshot.closeError && snapshot.closeErrorRevision !== dismissedCloseErrorRevision && (
          <div className="px-4 pt-3">
            <Banner tone="destructive" actions={
              <Button size="sm" variant="ghost" onClick={() => setDismissedCloseErrorRevision(snapshot.closeErrorRevision)}>{t("app.closeErrorDismiss")}</Button>
            }>
              {t(`issue.${snapshot.closeError}`)}
            </Banner>
          </div>
        )}

        {draftPersistFailed && (
          <div className="px-4 pt-3">
            <Banner tone="warning" actions={
              <Button size="sm" variant="ghost" onClick={() => setDraftPersistFailed(false)}>{t("app.noticeDismiss")}</Button>
            }>
              {t("app.draftPersistFailed")}
            </Banner>
          </div>
        )}

        {ui.view === "settings" ? (
          <SettingsPage
            snapshot={snapshot}
            initialSection={settingsSection}
            onBack={() => patch({ view: "session" })}
            onUpdateSettings={(input) => { void window.dcode.updateSettings(input).catch(() => undefined); }}
          />
        ) : isDraft || sessionEmpty ? (
          <DraftState
            snapshot={snapshot}
            locationLabel={`${locationOf(snapshot, ui.selectedSessionId, ui.draftTaskId, t("nav.defaultTask"))}${ui.draftParentTaskId ? ` / ${t("nav.newShortTask")}` : ""}`}
            draft={draft}
            focusKey={focusKey}
            onDraftChange={(text) => draftKey && patch({ drafts: { ...ui.drafts, [draftKey]: text } })}
            references={draftKey ? ui.referencesOfDraft[draftKey] ?? [] : []}
            // 归属跟着当前草稿键走：选中会话（含空时间线）按 sessionId，新任务草稿按 taskId
            referenceScope={ui.selectedSessionId
              ? { sessionId: ui.selectedSessionId }
              : ui.draftTaskId
                ? { taskId: ui.draftTaskId }
                : null}
            // 更新式写入：作用在该草稿键的当前引用集合上，不用渲染时的旧副本
            onReferencesChange={(update) => {
              if (!draftKey) return;
              setUi((prev) => ({
                ...prev,
                referencesOfDraft: { ...prev.referencesOfDraft, [draftKey]: [...update(prev.referencesOfDraft[draftKey] ?? [])] },
              }));
            }}
            onSend={(refs) => void handleSend(refs)}
            pendingSendText={pendingSendText}
            unknownSendText={unknownSendText}
            mode={sendMode}
            onModeChange={setSendMode}
            sessionModelState={ui.selectedSessionId ? snapshot.sessionModels[ui.selectedSessionId] ?? null : null}
            newSessionChoice={snapshot.settings.newSessionModelChoice}
            onPickRecent={handleSelectSession}
            onPickRecommended={(text) => {
              if (draftKey) patch({ drafts: { ...ui.drafts, [draftKey]: text } });
              setFocusKey((n) => n + 1);
            }}
            // D02：缺配置时到真实的模型配置位置；进入设置不清草稿、不改变执行状态
            onOpenSettings={() => {
              setSettingsSection("model");
              patch({ view: "settings" });
            }}
          />
        ) : selectedSession ? (
          <Timeline
            snapshot={snapshot}
            session={selectedSession}
            locationLabel={locationOf(snapshot, ui.selectedSessionId, null, t("nav.defaultTask"))}
            draft={draft}
            onDraftChange={(text) => draftKey && patch({ drafts: { ...ui.drafts, [draftKey]: text } })}
            references={draftKey ? ui.referencesOfDraft[draftKey] ?? [] : []}
            // 更新式写入：作用在该草稿键的当前引用集合上，不用渲染时的旧副本
            onReferencesChange={(update) => {
              if (!draftKey) return;
              setUi((prev) => ({
                ...prev,
                referencesOfDraft: { ...prev.referencesOfDraft, [draftKey]: [...update(prev.referencesOfDraft[draftKey] ?? [])] },
              }));
            }}
            onSend={(refs) => void handleSend(refs)}
            onResume={() => handleResume(selectedSession.id)}
            resumePending={resumeFlights.current.has(selectedSession.id)}
            onDismissResume={() => patch({ dismissedResume: [...ui.dismissedResume, selectedSession.id] })}
            resumeDismissed={ui.dismissedResume.includes(selectedSession.id)}
            pendingSendText={pendingSendText}
            unknownSendText={unknownSendText}
            mode={sendMode}
            onModeChange={setSendMode}
            onOpenChanges={(blockId) => {
              const blocks = snapshot.timelines[selectedSession.id] ?? [];
              const block = blocks.find((b) => b.id === blockId && b.kind === "change-summary");
              if (block && block.kind === "change-summary") {
                openChanges(selectedSession.id, blockId, block.files[0]?.path ?? "");
              }
            }}
            onRetrySend={(blockId) => {
              void window.dcode.retrySend({ sessionId: selectedSession.id, blockId }).then((result) => {
                clearDraftOnAccepted(selectedSession.id, blockId, result.receipt.status === "accepted");
              });
            }}
            onCheckReceipt={(blockId) => {
              void window.dcode.checkReceipt({ sessionId: selectedSession.id, blockId }).then((result) => {
                // 只读回查找回「已接收」与重试同义：同样清掉这次发送对应的原草稿
                clearDraftOnAccepted(selectedSession.id, blockId, result.receipt.status === "accepted");
              });
            }}
            onPause={() => void window.dcode.pauseRun({ sessionId: selectedSession.id })}
            onNewSession={() => {
              void window.dcode.createSession({ taskId: selectedSession.taskId }).then((session) => {
                handleSelectSession(session.id);
              });
            }}
          />
        ) : null}
      </main>

      {inspectorFiles && ui.inspector && (
        <Inspector
          files={inspectorFiles}
          activeFile={ui.inspector.activeFile}
          onSelectFile={(path) => ui.inspector && patch({ inspector: { ...ui.inspector, activeFile: path } })}
          onClose={() => patch({ inspector: null })}
        />
      )}
    </div>
    </TooltipProvider>
  );
}

// 选中会话／草稿时同步展开其归属路径（纯导航）
function selectSession(
  sessionId: string,
  snapshot: AppSnapshot,
  patch: (p: Partial<UiState>) => void,
  ui: UiState,
): void {
  const session = snapshot.sessions.find((s) => s.id === sessionId);
  const task = session ? snapshot.tasks.find((t) => t.id === session.taskId) : null;
  if (!session || !task) return;
  patch({
    selectedSessionId: sessionId,
    draftTaskId: null,
    draftParentTaskId: null,
    expandedWorkspaceIds: [...new Set([...ui.expandedWorkspaceIds, task.workspaceId])],
    // 父任务的子任务区展开（多选集合），当前任务的会话列表进入手风琴
    expandedTaskIds: task.parentId
      ? [...new Set([...ui.expandedTaskIds, task.parentId])]
      : ui.expandedTaskIds,
    // 进入主会话不代替用户操作展开箭头；进入成员会话才显露所属成员列表。
    expandedTaskId: session.kind === "sub" ? task.id : ui.expandedTaskId,
  });
}

function selectDraft(
  taskId: string,
  snapshot: AppSnapshot,
  patch: (p: Partial<UiState>) => void,
  ui: UiState,
  parentTaskId: string | null = null,
): void {
  const task = snapshot.tasks.find((t) => t.id === taskId);
  if (!task) return;
  if (parentTaskId && (task.id !== parentTaskId || task.kind !== "long")) return;
  patch({
    selectedSessionId: null,
    draftTaskId: taskId,
    draftParentTaskId: parentTaskId,
    expandedWorkspaceIds: [...new Set([...ui.expandedWorkspaceIds, task.workspaceId])],
    expandedTaskIds: task.parentId
      ? [...new Set([...ui.expandedTaskIds, task.parentId])]
      : ui.expandedTaskIds,
  });
}
