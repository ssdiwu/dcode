// 主区时间线：消息、工具块、改动聚合卡共处一条流。
// 恢复条只恢复界面；继续执行是用户的显式动作。
// 运行徽标直接映射执行端相位（ready/running/pausing/paused/faulted）——没有「已完成」相。

import { useEffect, useRef } from "react";
import { Plus, RotateCcw } from "lucide-react";
import type { AppSnapshot, RunState, SendMode, SendReceipt, Session, TimelineBlock } from "@/contracts";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { Banner } from "../components/Banner";
import { MarkdownLite } from "../components/MarkdownLite";
import { ToolCallBlock } from "../components/ToolCallBlock";
import { ChangeSummaryCard } from "../components/ChangeSummaryCard";
import { Composer } from "../components/Composer";
import { useT } from "../i18n";

export function Timeline({
  snapshot,
  session,
  draft,
  onDraftChange,
  onSend,
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
  onSend: () => void;
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
  const snapRef = useRef<{ sh: number; ch: number } | null>(null);
  const stickToBottomRef = useRef<() => void>(() => {});

  // mount/切换会话的监听器与意图初始化：本 effect 不重跑（依赖不含 count），
  // 与下文按 count 驱动的位移 effect 分离——避免位移 cleanup 中止监听器、丢失真实滚动识别
  useEffect(() => {
    const scroller = endRef.current?.closest(".overflow-y-auto");
    const col = scroller?.firstElementChild;
    if (!scroller || !col) return;
    const atBottom = () => scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
    const pushSnap = () => {
      snapRef.current = { sh: scroller.scrollHeight, ch: scroller.clientHeight };
    };
    stickToBottomRef.current = () => {
      scroller.scrollTop = scroller.scrollHeight;
    };
    // 按当前真实位置初始化意图后立刻位移（初次通常为底部 → 钉到真实底部）
    followingRef.current = atBottom();
    stickToBottomRef.current();
    pushSnap();

    const onScroll = () => {
      const snap = snapRef.current;
      if (snap && scroller.scrollHeight === snap.sh && scroller.clientHeight === snap.ch) {
        // 几何未变的 scroll 是真实滚动（滚轮/键盘/滚动条/程序化）：按滚动后位置更新意图
        followingRef.current = atBottom();
      }
      // 几何已变的 scroll 是重排锚定/钳制：保留原意图，交给 ResizeObserver 或 count 分支处理
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });

    // ResizeObserver 只负责几何触发（字号/窗口/检查器开闭/流式内容自然增高）的跟随重钉
    const ro = new ResizeObserver(() => {
      if (followingRef.current) stickToBottomRef.current();
      pushSnap();
    });
    // 同时观察滚动容器本体：纯视口缩高/检查器开闭只改变 clientHeight 与最大 scrollTop，
    // 内容列高度不变，只观察列会漏掉这一路贴底重钉
    ro.observe(col);
    ro.observe(scroller);

    return () => {
      scroller.removeEventListener("scroll", onScroll);
      ro.disconnect();
      followingRef.current = null;
      snapRef.current = null;
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
      <header className="drag-region flex shrink-0 items-center gap-2 border-b border-border px-4">
        <span className="text-ui-sm text-subtlest truncate min-w-0">{locationLabel}</span>
        <span className="text-ui-sm font-medium truncate min-w-0">{session.title}</span>
        <div className="flex-1" />
        {run && run.pendingInputs > 0 && (
          <Badge tone="neutral">{t("timeline.pendingInputs", { n: run.pendingInputs })}</Badge>
        )}
        {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
        {run?.errorNote && (
          <span className="text-ui-xs text-destructive truncate max-w-72" title={t(`issue.${run.errorNote}`)}>
            {t(`issue.${run.errorNote}`)}
          </span>
        )}
        <Button size="sm" variant="ghost" className="shrink-0" onClick={onNewSession}>
          <Plus className="size-3.5" />
          {t("timeline.newSession")}
        </Button>
      </header>

              {/* 时间线是唯一滚动容器；min-h-0 让它在窗口内收缩而不是撑开整页 */}
        <div className="min-h-0 flex-1 overflow-y-auto">
        {/* 消息列与悬浮 dock 共用一个 flex 容器承担自然高度：短内容时 dock 贴底且不多出一卡片高滚动 */}
        <div className="flex min-h-full flex-col">
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
            卡片自身持表面/边界/圆角（DESIGN 容器规则 + spec 桌面会话输入区；上游 sticky dock 结构参照，不整段搬入） */}
        <div className="pointer-events-none sticky bottom-0 mx-auto w-full max-w-172 px-4 pb-3">
          <div className="pointer-events-auto">
            <Composer
              draft={draft}
              onDraftChange={onDraftChange}
              onSend={onSend}
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
        <div className="px-0.5">
          <MarkdownLite text={block.text} />
        </div>
      );
    case "tool":
      return <ToolCallBlock tool={block.tool} />;
    case "change-summary":
      return <ChangeSummaryCard files={block.files} onOpen={() => onOpenChanges(block.id)} />;
    case "run-marker":
      return (
        <div className="flex items-center gap-2 py-1">
          <div className="h-px flex-1 bg-border" />
          <span className="text-ui-xs text-subtlest">{t(`marker.${block.marker}`)}</span>
          <div className="h-px flex-1 bg-border" />
        </div>
      );
  }
}

/** 用户消息块：呈现提交原文与接收回执三态；已处理（done）后 chip 消失。 */
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
    <div
      className={`rounded-xl border px-3.5 py-2.5 space-y-1.5 ${
        failed ? "border-destructive/45 bg-card" : "border-border bg-card"
      }`}
    >
      <MarkdownLite text={block.text} />
      {receipt && <ReceiptView receipt={receipt} onRetry={onRetry} onCheck={onCheck} />}
    </div>
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
