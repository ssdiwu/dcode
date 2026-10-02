import { uiText, localizeUi } from "../../../shared/ui-language.ts";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { autoUpdate, flip, offset, shift, useFloating } from "@floating-ui/react-dom";
import { CircleHelp, X } from "lucide-react";
import type { ModelControls } from "../workbench/useModels";
import type { Workbench } from "../useWorkbench";
import { api } from "../types";
import { currentSessionContextUsage } from "../workbench/context-usage";

interface ContextBreakdown {
  available: boolean;
  totalTokens: number | null;
  contextWindow: number;
  parts: Array<{ kind: string; tokens: number | null }>;
}

const partLabels: Record<string, string> = localizeUi({
  systemTools: "系统与工具",
  user: "用户输入",
  assistant: "助手回复",
  thinking: "思考",
  toolResult: "工具结果",
});
const number = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });

function unknownDescription(reason: string): string {
  switch (reason) {
    case "historical-path": return uiText("正在查看历史路径，当前上下文用量不可用于这条路径。");
    case "no-runtime": return uiText("这条会话当前没有活动运行实例，暂无可读取的上下文用量。");
    case "model-changed": return uiText("模型已切换，等待新回复确认这条会话的上下文用量。");
    case "compacted": return uiText("上下文已压缩，等待新回复确认压缩后的用量。");
    default: return uiText("还没有可核对的模型用量响应，暂无法显示上下文估算。");
  }
}

export function ContextUsage({ work, models }: { work: Workbench; models: ModelControls }) {
  const sessionId = work.session?.id;
  const runtimeId = work.presentation?.runtime?.runtimeId;
  const selectedModel = models.data?.models.find(model => model.key === models.data?.selectedKey);
  const source = useMemo(
    () => currentSessionContextUsage(work.presentation, selectedModel),
    [work.presentation, selectedModel?.providerId, selectedModel?.modelId],
  );
  const [blockedUsageEntryId, setBlockedUsageEntryId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [breakdown, setBreakdown] = useState<ContextBreakdown | null>(null);
  const [breakdownError, setBreakdownError] = useState(false);
  const [breakdownLoading, setBreakdownLoading] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const detailsId = useId();
  const { refs, floatingStyles, isPositioned } = useFloating({
    open,
    strategy: "fixed",
    placement: "top-start",
    whileElementsMounted: autoUpdate,
    middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 })],
  });
  useLayoutEffect(() => { refs.setReference(trigger.current); }, [refs.setReference]);

  useEffect(() => {
    if (!sessionId || !runtimeId) return;
    return api().subscribe(event => {
      const data = event.data as { type?: string; aborted?: boolean; result?: unknown; runtime?: { dcodeSessionId?: string } } | undefined;
      if (event.event !== "session.event" || data?.type !== "compaction_end" || data.aborted || data.result === undefined || data.runtime?.dcodeSessionId !== sessionId) return;
      if (source.kind === "estimated") setBlockedUsageEntryId(source.lastUsageRecord.entryId);
      void work.refreshPresentation().catch(work.fail);
    });
  }, [sessionId, runtimeId, source.kind === "estimated" ? source.lastUsageRecord.entryId : null, work.refreshPresentation, work.fail]);

  const usage = source.kind === "estimated" && source.lastUsageRecord.entryId !== blockedUsageEntryId && !work.hostDead && !models.busy ? source : null;
  const reason = work.hostDead ? uiText("连接中，暂无法确认上下文用量。")
    : models.busy ? uiText("正在核对所选模型的上下文用量。")
    : source.kind === "estimated" && source.lastUsageRecord.entryId === blockedUsageEntryId ? unknownDescription("compacted")
    : unknownDescription(source.kind === "unknown" ? source.reason : "no-usage");
  const usageKey = usage ? `${usage.runtimeId}:${usage.projectionEntryId}:${usage.lastUsageRecord.entryId}:${usage.tokens}:${usage.contextWindow}` : null;

  useEffect(() => {
    if (!open || !usage || !usageKey) {
      setBreakdown(null);
      setBreakdownError(false);
      setBreakdownLoading(false);
      return;
    }
    let live = true;
    setBreakdown(null);
    setBreakdownError(false);
    setBreakdownLoading(true);
    void api().request<ContextBreakdown>("session.contextBreakdown", { runtimeId: usage.runtimeId })
      .then(result => {
        if (!live) return;
        if (!result?.available || result.totalTokens !== usage.tokens || result.contextWindow !== usage.contextWindow || !Array.isArray(result.parts)) {
          setBreakdownError(true);
          void work.refreshPresentation().catch(work.fail);
          return;
        }
        setBreakdown(result);
      })
      .catch(() => { if (live) setBreakdownError(true); })
      .finally(() => { if (live) setBreakdownLoading(false); });
    return () => { live = false; };
  }, [open, usageKey, work.refreshPresentation, work.fail]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !trigger.current?.contains(target) && !refs.floating.current?.contains(target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", escape, true); };
  }, [open, refs.floating]);

  useEffect(() => { if (open && isPositioned) heading.current?.focus(); }, [open, isPositioned]);

  const remaining = usage ? Math.round(usage.remainingPercent) : null;
  return <>
    <button
      ref={trigger}
      type="button"
      className="context-usage-trigger"
      aria-label={usage ? uiText("当前会话上下文预计剩余 {0}%；查看用量详情", [remaining]) : uiText("当前会话上下文用量未知；查看详情")}
      aria-expanded={open}
      aria-controls={open ? detailsId : undefined}
      onClick={() => setOpen(value => !value)}
    >
      {usage ? <svg className="context-usage-ring" viewBox="0 0 36 36" aria-hidden="true">
        <circle className="context-usage-used" cx="18" cy="18" r="14" />
        <circle className="context-usage-remaining" cx="18" cy="18" r="14" pathLength="100" strokeDasharray={`${usage.remainingPercent} 100`} />
      </svg> : <CircleHelp size={17} aria-hidden="true" />}
      <span>{remaining === null ? uiText("未知") : uiText("约{0}%", [remaining])}</span>
    </button>
    {open && createPortal(<section
      ref={refs.setFloating}
      id={detailsId}
      className="context-usage-popover"
      role="dialog"
      aria-labelledby={`${detailsId}-title`}
      style={{ ...floatingStyles, visibility: isPositioned ? "visible" : "hidden" }}
    >
      <div className="context-usage-heading"><h3 ref={heading} id={`${detailsId}-title`} tabIndex={-1}>{uiText("当前会话上下文")}</h3><button type="button" className="icon-button" aria-label={uiText("关闭上下文用量详情")} onClick={() => { setOpen(false); trigger.current?.focus(); }}><X size={14}/></button></div>
      {usage ? <>
        <p className="context-usage-model">{usage.modelName} {uiText(" 的上下文容量")}</p>
        <dl className="context-usage-facts">
          <div><dt>{uiText("已用 · 估算")}</dt><dd>{number.format(usage.tokens)} token</dd></div>
          <div><dt>{uiText("模型容量")}</dt><dd>{number.format(usage.contextWindow)} token</dd></div>
          <div><dt>{uiText("剩余 · 估算")}</dt><dd>{number.format(usage.remainingTokens)} {uiText(" token（约")}{remaining}%）</dd></div>
        </dl>
        <p className="context-usage-note">{uiText("最近模型用量响应：")}{usage.lastUsageRecord.recordedAt ? new Date(usage.lastUsageRecord.recordedAt).toLocaleString("zh-CN") : uiText("时间未知")}{uiText("。这是估算锚点；当前占用可能包含后续消息的估算，不是计费数。")}</p>
        {breakdownLoading && <p className="context-usage-note" role="status">{uiText("正在读取构成估算…")}</p>}
        {breakdownError && <p className="context-usage-note" role="status">{uiText("暂时无法读取构成估算。")}</p>}
        {breakdown && <><div className="context-usage-separator"/><p className="context-usage-subtitle">{uiText("构成估算")}</p><dl className="context-usage-facts">
          {breakdown.parts.filter(part => partLabels[part.kind]).map(part => <div key={part.kind}><dt>{partLabels[part.kind]} {uiText(" · 估算")}</dt><dd>{typeof part.tokens === "number" && Number.isFinite(part.tokens) && part.tokens >= 0 ? `${number.format(part.tokens)} token` : uiText("未知")}</dd></div>)}
        </dl><p className="context-usage-note">{uiText("分项按消息内容估算，仅用于了解构成；不是计费或缓存命中数据。")}</p></>}
      </> : <p className="context-usage-note context-usage-unknown">{reason}</p>}
    </section>, document.body)}
  </>;
}
