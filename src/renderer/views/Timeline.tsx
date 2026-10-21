// 主区时间线：消息、工具块、改动聚合卡共处一条流。
// 恢复条只恢复界面；继续执行是用户的显式动作。
// 运行徽标直接映射执行端相位（ready/running/pausing/paused/faulted）——没有「已完成」相。

import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** 滚动停止的空闲判定：交互节奏参数，不承担任何状态收束职责。 */
const SCROLL_IDLE_MS = 140;
import { Plus, RotateCcw } from "lucide-react";
import type { AppSnapshot, RunState, SendMode, SendReceipt, Session, TimelineBlock , WorkReference} from "@/contracts";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { Banner } from "../components/Banner";
import { Message, MessageContent, MessageResponse } from "../components/ai/message";
import { ToolCallBlock } from "../components/ToolCallBlock";
import { ChangeSummaryCard } from "../components/ChangeSummaryCard";
import { Composer } from "../components/Composer";
import { ModelEntry } from "../components/ModelEntry";
import { useT } from "../i18n";

export function Timeline({
  snapshot,
  session,
  draft,
  onDraftChange,
  onSend,
  references,
  onReferencesChange,
  onResume,
  onDismissResume,
  resumeDismissed,
  onOpenChanges,
  onRetrySend,
  onCheckReceipt,
  onPause,
  onNewSession,
  locationLabel,
  resumePending,
  pendingSendText,
  unknownSendText,
  mode,
  onModeChange,
}: {
  snapshot: AppSnapshot;
  session: Session;
  draft: string;
  onDraftChange: (text: string) => void;
  /** C05：发送时带上这一版引用 */
  onSend: (references: readonly WorkReference[]) => void;
  references?: readonly WorkReference[];
  onReferencesChange?: (update: (current: readonly WorkReference[]) => readonly WorkReference[]) => void;
  /** 返回在途恢复请求的真实 settle（Composer 的继续防重以此收束） */
  onResume: () => Promise<void>;
  onDismissResume: () => void;
  resumeDismissed: boolean;
  onOpenChanges: (blockId: string) => void;
  onRetrySend: (blockId: string) => void;
  onCheckReceipt: (blockId: string) => void;
  onPause: () => void;
  onNewSession: () => void;
  locationLabel: string;
  /** 恢复条与 C01 共用的同一在途继续（T08：两入口交错/连点只执行一次） */
  resumePending: boolean;
  pendingSendText: string | null;
  unknownSendText: string | null;
  mode: SendMode;
  onModeChange: (mode: SendMode) => void;
}) {
  const t = useT();
  const runBadge: Record<Exclude<RunState["status"], "ready">, { tone: "neutral" | "success" | "destructive" | "warning"; label: string }> = {
    running: { tone: "neutral", label: t("run.running") },
    paused: { tone: "warning", label: t("run.paused") },
    pausing: { tone: "warning", label: t("run.pausing") },
    faulted: { tone: "destructive", label: t("run.faulted") },
  };
  const blocks = snapshot.timelines[session.id] ?? [];
  const run = snapshot.runs[session.id] ?? null;
  const endRef = useRef<HTMLDivElement>(null);
  const count = blocks.length;

  // 阅读意图（following）由新块追加、流式增长与几何变化（字号/窗口/检查器开闭）共同尊重：
  // 用户在底部时继续跟随并钉到真实底部；上翻阅读时一律保持阅读位置，不被拉回。
  // following 的唯一写入处是本组件持有 ref 的「真实滚动识别」（几何快照区分真实滚动与重排锚定/钳制）
  // 及「进入会话的当前位置」；位移决定由两类 effect 按当前意图执行。键盘/滚动条等非滚轮滚动同样生效。
  // 贴底用直接写 scrollTop（sticky 卡片在文档流末位回到内容之后，末尾内容与操作完整显示在卡片上方；
  // 不能用 scrollIntoView(block:"end")——它把末尾锚点对到视口底边，正好被卡片遮住）。
  // 红证据：主会话审计 render-probe.json 的运行中上翻阅读后新块强制滚底（top 0、height 1254、viewport 712、
  // rows 12→13、跳到 729），见审计目录 /Users/diwu/Workspace/Archives/dcode-rea-ui-audit-2026-10-08-u76wuf4y/；
  // 本片以 streaming-sim 场景 E 在基线变体（无条件 count effect）复现：0→1920 拉回。
  // 更早的 stick-red.log（纯缩高不重钉）与 probe-inspector-anchoring-red.log（锚定调离底部后丢失跟随）。
  const followingRef = useRef<boolean | null>(null);
  const stickToBottomRef = useRef<() => void>(() => {});
  // 本组件自己写入 scrollTop 的标记：跟随贴底与重排重钉都会触发浏览器 scroll 事件，
  // 若不标记就会落进 onScroll 的真实位移分支，
  // 造成「展开 → RO 跟随 → scroll → 暂收 → 恢复 → 再 RO → 再 scroll」的循环。
  // 只有本组件写入的那一次位移消费此标记，用户滚轮／键盘／滚动条引起的位移照旧识别。
  const programmaticRef = useRef<{ top: number; sh: number; ch: number } | null>(null);
  // 会话输入区的暂收：真实滚动时收起展开部分，停止滚动后由 Composer 按暂收前实测高度恢复。
  // 滚动结束用空闲计时识别——它是交互节奏，不是用来掩盖同步错误；重排锚定与程序化位移都不触发（见 onScroll）。
  const [scrolling, setScrolling] = useState(false);
  const scrollIdleRef = useRef<number | null>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // Composer先在本次布局恢复原高度，再撤暂收占位；不能先清占位而制造一帧max收缩/钳底。
    if (!scrolling && dockRef.current) dockRef.current.style.minHeight = "";
  }, [scrolling]);

  // mount/切换会话的监听器与意图初始化：本 effect 不重跑（依赖不含 count），
  // 与下文按 count 驱动的位移 effect 分离——避免位移 cleanup 中止监听器、丢失真实滚动识别
  useEffect(() => {
    const scroller = endRef.current?.closest<HTMLElement>(".overflow-y-auto");
    const col = scroller?.firstElementChild;
    if (!scroller || !col) return;
    const atBottom = () => scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
    stickToBottomRef.current = () => {
      const max = scroller.scrollHeight - scroller.clientHeight;
      const next = Math.max(0, max);
      // 初始化也会主动写到末尾：跟随意图在写入点成立，不能等延迟 scroll 派发才补，
      // 也不能在消费自己的位移时把初始化留下的 false 保住，导致第一次展开/缩窗失去跟随。
      followingRef.current = true;
      // 已在目标位置就不写：scrollTop 不变不会产生 scroll 事件，留着标记会吞掉下一次用户滚动
      if (Math.abs(scroller.scrollTop - next) < 1) return;
      programmaticRef.current = { top: next, sh: scroller.scrollHeight, ch: scroller.clientHeight };
      scroller.scrollTop = next;
    };
    // 按当前真实位置初始化意图后立刻位移（初次通常为底部 → 钉到真实底部）
    followingRef.current = atBottom();
    stickToBottomRef.current();
    // 与上一实际 scroll 派发比较，不能由先到的 RO 覆写比较起点。重排可派发两次同落点
    // scroll；后次没有新增位移，不能再把它当成用户滚动触发 140ms 暂收。
    let observedScroll = { top: scroller.scrollTop, sh: scroller.scrollHeight, ch: scroller.clientHeight };

    // 原 bool 标记无法区分同帧程序化贴底与用户上翻。可信输入先取消旧标记；
    // 向上动作立即离开跟随，避免实际 scroll 事件尚未派发时 RO 又把用户钉回底部。
    let userScrollPending = false;
    let userScrollDirection = 0;
    const markUserScroll = (direction: -1 | 0 | 1) => {
      userScrollPending = true;
      userScrollDirection = direction;
      programmaticRef.current = null;
      if (direction === -1) followingRef.current = false;
      // 已在末尾的明确下翻可能不产生新scroll；此处认领，否则旧上翻意图会挡住随后增高。
      else if (direction === 1 && atBottom()) followingRef.current = true;
    };
    const onWheel = (event: WheelEvent) => {
      if (!event.isTrusted || event.deltaY === 0) return;
      // 内层可滚动区仍能消费这次位移时，不改外层时间线的阅读意图。
      let node = event.target instanceof Element ? event.target : null;
      while (node && node !== scroller) {
        const overflow = getComputedStyle(node).overflowY;
        const max = node.scrollHeight - node.clientHeight;
        if ((overflow === "auto" || overflow === "scroll") && max > 1
          && (event.deltaY < 0 ? node.scrollTop > 1 : node.scrollTop < max - 1)) return;
        node = node.parentElement;
      }
      markUserScroll(event.deltaY < 0 ? -1 : 1);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.isTrusted || event.defaultPrevented || event.target !== scroller) return;
      if (["PageUp", "ArrowUp", "Home"].includes(event.key)) markUserScroll(-1);
      else if (["PageDown", "ArrowDown", "End", " "].includes(event.key)) markUserScroll(1);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!event.isTrusted || event.button !== 0) return;
      const rect = scroller.getBoundingClientRect();
      const contentRight = rect.left + scroller.clientLeft + scroller.clientWidth;
      if (event.clientX >= contentRight && event.clientX < rect.right && event.clientY >= rect.top && event.clientY < rect.bottom) {
        markUserScroll(0); // thumb可以向任一方向拖动，仍以实际落点核阅读意图
      }
    };
    const onScroll = () => {
      const previous = observedScroll;
      observedScroll = { top: scroller.scrollTop, sh: scroller.scrollHeight, ch: scroller.clientHeight };
      const written = programmaticRef.current;
      programmaticRef.current = null;
      if (written && (Math.abs(scroller.scrollTop - written.top) < 1
        || (!userScrollPending && (scroller.scrollHeight !== written.sh || scroller.clientHeight !== written.ch)))) {
        // 位移与派发之间又有重排时，按写入时的几何核来源，不能拿 RO 刚更新的快照误判成上翻。
        // 可信用户输入已同步撤掉写入记录；本组件位移不在延迟派发时重新核 atBottom，
        // 也不把已经由可信上翻改成 false 的阅读意图改回 true。同几何下位置不同说明
        // 后次位移覆盖了自己的写入；没有可信输入标记也不能据此把这次滚动吞掉。
        return;
      }
      const replacedWrite = written && observedScroll.sh === written.sh && observedScroll.ch === written.ch;
      const sameGeometry = observedScroll.sh === previous.sh && observedScroll.ch === previous.ch;
      const moved = Math.abs(observedScroll.top - previous.top) >= 1;
      if (userScrollPending || replacedWrite || (sameGeometry && moved)) {
        // 几何未变的 scroll 是真实滚动（滚轮/键盘/滚动条）：按滚动后位置更新意图
        // PageDown 的浏览器动画可能在“已回底”之后仍派发尾帧；期间字号／卡片重排
        // 扩大 max 时，旧动画目标不再是新底部，不能把继续向下的同次动作误读成上翻。
        // 已回底且仍在真实向下动作中的跟随保持；新的上翻在输入事件处立即解除跟随。
        if (!(userScrollPending && (userScrollDirection === -1 || (userScrollDirection === 1 && followingRef.current)))) {
          followingRef.current = atBottom();
        }
        // 真实滚动 → 输入区暂收；停止滚动后恢复（恢复高度由 Composer 按暂收前实测值给出）
        // 暂收只缩卡片显示；保留本轮展开占位，避免内容max减少把已上翻位置钳成新底部。
        const dock = dockRef.current;
        if (dock && !dock.style.minHeight) dock.style.minHeight = `${dock.getBoundingClientRect().height}px`;
        setScrolling(true);
        if (scrollIdleRef.current !== null) window.clearTimeout(scrollIdleRef.current);
        scrollIdleRef.current = window.setTimeout(() => {
          scrollIdleRef.current = null;
          userScrollPending = false;
          userScrollDirection = 0;
          setScrolling(false);
        }, SCROLL_IDLE_MS);
      }
      // 几何已变的 scroll 是重排锚定/钳制：保留原意图，交给 ResizeObserver 或 count 分支处理
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    scroller.addEventListener("wheel", onWheel, { passive: true });
    scroller.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown, { capture: true, passive: true });

    // ResizeObserver 只负责几何触发（字号/窗口/检查器开闭/流式内容自然增高）的跟随重钉
    const ro = new ResizeObserver(() => {
      if (followingRef.current) stickToBottomRef.current();
    });
    // 同时观察滚动容器本体：纯视口缩高/检查器开闭只改变 clientHeight 与最大 scrollTop，
    // 内容列高度不变，只观察列会漏掉这一路贴底重钉
    ro.observe(col);
    ro.observe(scroller);

    return () => {
      scroller.removeEventListener("scroll", onScroll);
      scroller.removeEventListener("wheel", onWheel);
      scroller.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown, true);
      ro.disconnect();
      if (scrollIdleRef.current !== null) window.clearTimeout(scrollIdleRef.current);
      scrollIdleRef.current = null;
      followingRef.current = null;
      programmaticRef.current = null;
      if (dockRef.current) dockRef.current.style.minHeight = "";
      setScrolling(false);
    };
  }, [session.id]);

  // 新块追加：位移决定只读取意图 ref；effect 本身不写意图、不重挂监听器。
  // 真实产品中块清空即切换到 DraftState、Timeline 卸载（App.tsx:433），同实例不存在
  // 「清空后再期待进入规则」的路径，不为此加行为。
  useEffect(() => {
    if (followingRef.current === null) return;
    if (followingRef.current) stickToBottomRef.current();
  }, [count, session.id]);

  const badge = run && run.status !== "ready" ? runBadge[run.status] : null;
  const interrupted =
    run?.status === "paused" && run.restored === true && !resumeDismissed;

  // min-h-0：列方向 flex 子项默认 min-height:auto，缺它时间线不滚、整页被撑高
  return (
      <div className="flex min-h-0 flex-1 flex-col min-w-0">
      {/* 会话标题带：内容在其后滚动，因此用磨砂材质＋极弱下缘，而不是一条实线分割主区 */}
      <header className="drag-region glass glass-bar flex shrink-0 items-center gap-2 border-b border-[var(--edge)] px-4">
        <span className="truncate text-ui-sm text-subtlest">{locationLabel}</span>
        <span className="truncate text-ui-sm font-medium">{session.title}</span>
        <div className="flex-1" />
        {run && run.pendingInputs > 0 && (
          <Badge tone="neutral">{t("timeline.pendingInputs", { n: run.pendingInputs })}</Badge>
        )}
        {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
        {run?.errorNote && (
          <span className="max-w-72 truncate text-ui-xs text-destructive" title={t(`issue.${run.errorNote}`)}>
            {t(`issue.${run.errorNote}`)}
          </span>
        )}
        {/* C07：来源与模型入口在会话标题带，不在输入框内（2026-10-21 507 要求）。
            模型是会话级事实：入口与这条会话同处一行，选择只作用于后续请求。 */}
        <ModelEntry
          target={{ kind: "session", sessionId: session.id }}
          state={snapshot.sessionModels[session.id] ?? null}
          defaultChoice={snapshot.settings.newSessionModelChoice}
          taskUsage={snapshot.taskUsage[session.taskId] ?? null}
        />
        <Button size="sm" variant="ghost" className="shrink-0" onClick={onNewSession}>
          <Plus className="size-3.5" />
          {t("timeline.newSession")}
        </Button>
      </header>

              {/* 时间线是唯一滚动容器；min-h-0 让它在窗口内收缩而不是撑开整页 */}
        <div className="min-h-0 flex-1 overflow-y-auto">
        {/* 消息列与悬浮 dock 共用一个 flex 容器承担自然高度：短内容时 dock 贴底且不多出一卡片高滚动 */}
        <div className="flex min-h-full flex-col">
          {/* 阅读列：space-y-3 是 E2E 滚动断言的行选择器（main .overflow-y-auto .space-y-3 > *），保持不变 */}
          <div className="mx-auto w-full max-w-172 flex-1 px-4 py-4 space-y-3">
          {interrupted && (
            <Banner
              tone="info"
              actions={
                <>
                  <Button size="sm" variant="ghost" onClick={onDismissResume}>
                    {t("timeline.viewOnly")}
                  </Button>
                  <Button size="sm" variant="primary" aria-busy={resumePending} disabled={resumePending || !snapshot.model.available} onClick={() => void onResume()}>
                    <RotateCcw className="size-3.5" />
                    {t("timeline.resume")}
                  </Button>
                </>
              }
            >
              {t("timeline.resumeBar")}
            </Banner>
          )}

          {blocks.map((block) => (
            <TimelineRow
              key={block.id}
              block={block}
              onOpenChanges={onOpenChanges}
              onRetrySend={onRetrySend}
              onCheckReceipt={onCheckReceipt}
            />
          ))}
          <div ref={endRef} />
          </div>

        {/* 悬浮输入卡片：与消息同一滚动视口，sticky 贴视口底部；滚到末尾时卡片回到文档流末位，
            末尾内容与操作完整显示在卡片上方。外围留白仍是时间线表面（pointer-events 穿透，可滚可点可选中）；
            卡片自身持表面/边界/圆角（DESIGN 容器规则 + spec 桌面会话输入区） */}
        {/* data-slot="composer-dock"：末尾消息避让、底部留边与留白穿透都以整个 dock
            （卡片＋C06 说明）为对象，不再只量卡片本体——说明行同样会遮住滚动中的消息 */}
        <div ref={dockRef} data-slot="composer-dock" className="pointer-events-none sticky bottom-0 mx-auto flex w-full max-w-172 flex-col justify-end px-4 pb-3">
          <div className="pointer-events-auto">
            <Composer
              draft={draft}
              onDraftChange={onDraftChange}
              onSend={onSend}
              referenceScope={{ sessionId: session.id }}
              references={references}
              onReferencesChange={onReferencesChange}
              run={run}
              onPause={onPause}
              onResume={onResume}
              disabled={!snapshot.model.available}
              placeholder={snapshot.model.available ? t("timeline.followupPlaceholder") : t("draft.composerPlaceholderNoModel")}
              pendingSendText={pendingSendText}
              unknownSendText={unknownSendText}
              resumePending={resumePending}
              menuSide="up"
              mode={mode}
              onModeChange={onModeChange}
              collapsed={scrolling}
            />
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}

function TimelineRow({
  block,
  onOpenChanges,
  onRetrySend,
  onCheckReceipt,
}: {
  block: TimelineBlock;
  onOpenChanges: (blockId: string) => void;
  onRetrySend: (blockId: string) => void;
  onCheckReceipt: (blockId: string) => void;
}) {
  const t = useT();
  switch (block.kind) {
    case "message":
      return block.role === "user" ? (
        <UserMessageBlock
          block={block}
          onRetry={() => onRetrySend(block.id)}
          onCheck={() => onCheckReceipt(block.id)}
        />
      ) : (
        // 助手正文：单时间线上不套容器框，靠排版层级（字阶/行高/留白）自身成立；
        // 与用户气泡的差别由 Message 的对齐方向承担，不再额外描线或加背景。
        <Message from="assistant">
          <MessageContent>
            {/* 流式输出中按流式模式解析未闭合的 Markdown；完成后切回静态，避免再次重排已读正文 */}
            <MessageResponse mode={block.streaming ? "streaming" : "static"} parseIncompleteMarkdown={block.streaming}>
              {block.text}
            </MessageResponse>
          </MessageContent>
        </Message>
      );
    case "extension-message":
      return <div data-slot="extension-message" className="space-y-1"><p className="text-ui-xs text-subtle">{t("timeline.extension")} · {block.customType}</p><MessageResponse mode="static">{block.text}</MessageResponse></div>;
    case "tool":
      return <ToolCallBlock tool={block.tool} />;
    case "change-summary":
      return <ChangeSummaryCard blockId={block.id} files={block.files} onOpen={() => onOpenChanges(block.id)} />;
    case "run-marker":
      // 运行标记是真实事件节点：用居中的时间节点而不是横贯的分割线段
      return (
        <div className="flex items-center gap-2.5 py-1.5" data-slot="run-marker">
          <span className="size-1 shrink-0 rounded-full bg-subtlest" aria-hidden="true" />
          <span className="truncate text-ui-xs text-subtlest">{t(`marker.${block.marker}`)}</span>
          <span className="h-px flex-1 bg-[var(--edge)]" aria-hidden="true" />
        </div>
      );
  }
}

/** 用户消息块：提交原文 + 接收回执三态。已处理（done）后状态行消失。 */
function UserMessageBlock({
  block,
  onRetry,
  onCheck,
}: {
  block: Extract<TimelineBlock, { kind: "message" }>;
  onRetry: () => void;
  onCheck: () => void;
}) {
  const receipt: SendReceipt | undefined = block.receipt;
  const failed = receipt?.status === "not-accepted";
  return (
    <Message from="user">
      <MessageContent
        // 用户原话按原文呈现，不做关键词清洗或改写（DESIGN 产品文案与工程说明）
        className={failed ? "ring-1 ring-destructive/45" : undefined}
      >
        <MessageResponse>{block.text}</MessageResponse>
        {receipt && <ReceiptView receipt={receipt} onRetry={onRetry} onCheck={onCheck} />}
      </MessageContent>
    </Message>
  );
}

function ReceiptView({
  receipt,
  onRetry,
  onCheck,
}: {
  receipt: SendReceipt;
  onRetry: () => void;
  onCheck: () => void;
}) {
  const t = useT();
  if (receipt.status === "accepted") {
    // done = 该次输入已获得回答（既不等于用户验收，也不等于任务完成）；chip 消失
    if (receipt.processing === "done") return null;
    if (receipt.processing === "unanswered") {
      return <Badge tone="warning">{t("receipt.unanswered")}</Badge>;
    }
    return <Badge tone="neutral">{t("receipt.accepted")}</Badge>;
  }
  if (receipt.status === "unknown") {
    // 接收结果待核对：只读回查，不盲投；回查后按实际记录更新
    return (
      <div className="flex items-center gap-2">
        <Badge tone="neutral">{t("receipt.pendingLookup")}</Badge>
        <span className="text-ui-xs text-subtlest">{t("receipt.reason.storage-unavailable")}</span>
        <Button size="sm" variant="ghost" onClick={onCheck}>
          {t("receipt.lookup")}
        </Button>
      </div>
    );
  }
  // 确认未接收：内联如实说明原因 + 保留原文 + 重试入口
  return (
    <div className="flex items-center gap-2">
      <span className="text-ui-xs text-destructive">{t(`receipt.reason.${receipt.reason}`)}</span>
      <Button size="sm" variant="outline" onClick={onRetry}>
        {t("receipt.retry")}
      </Button>
    </div>
  );
}
