// C07 来源与模型入口（spec/页面与交互组件.md#工作输入区 C07）。
//
// 两层结构，职责不重叠：
//  · **第一层**：本次会话的选择方式、实际采用的来源与模型、条件参数档位。
//    这三者分别可辨——改了选择不等于已经换了模型，采用某个模型也不等于这次请求成功。
//  · **第二层**：展开后按来源／接入分组搜索，点名到具体模型。**来源 + 模型标识**才是身份，
//    同名模型不来源分别列、不合并；归属（账户／区域／计划）未提供就写「未提供」，不据此断定相同。
//
// 三条硬边界：
//  1. 打开、展开、搜索、查看都**不**执行工作：不同步发送、不启动执行、不读额度、不解除暂停。
//  2. 选择**只作用于后续请求**：当前正在输出的请求的模型归属保持不变，不中断、不重投。
//  3. 额度事实按状态如实呈现（未读取／未知／暂不支持／已耗尽／可用分别显示），
//     未读取就是「未读取」，不显示成可用，也不显示成 0。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Search } from "lucide-react";
import type {
  ModelSourcePick,
  ModelSourcesView,
  QuotaFacts,
  SessionModelChoice,
  SessionModelState,
  TaskUsageSummary,
  ThinkingLevel,
  WorkUsage,
} from "@/contracts";
import { useT } from "../i18n";
import type { CopyKey } from "../i18n";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";

/** 第一层那行摘要文字的构成；由事实推导，不接受外部传入文案。 */
export function describeCurrentModel(args: {
  state: SessionModelState | null;
  sources: readonly ModelSourcePick[];
}): { primary: string; secondary: string | null } {
  const { state, sources } = args;
  if (!state) return { primary: "auto", secondary: null };
  const choice = state.choice;
  if (choice.mode === "explicit") {
    const source = sources.find((s) => s.sourceId === choice.sourceId);
    const modelLabel = source?.models.find((m) => m.modelId === choice.modelId)?.modelLabel ?? choice.modelId;
    const sourceLabel = source?.sourceLabel ?? choice.sourceId;
    // 显式选择这一行显示的是**选择**，不是已采用：
    // 刚改选到 B 但还没发请求时，这里必须说 B，而下面的「本次实际采用」仍说 A。
    // 账户／区域／计划归属缺席即「未提供」，不据此断定与其它同名条目相同
    const account = state.actual?.accountLabel;
    return { primary: `${sourceLabel} · ${modelLabel}`, secondary: account ? `${modelLabel}（${account}）` : null };
  }
  // 自动：显示实际采用的模型；尚未判定时如实说明「尚未确定」，不把选择器文字当成已采用
  const actual = state.actual;
  if (!actual) return { primary: "auto", secondary: null };
  const source = sources.find((s) => s.sourceId === actual.sourceId);
  const primary = `${actual.sourceLabel || source?.sourceLabel || actual.sourceId} · ${actual.modelLabel}`;
  return { primary, secondary: null };
}

/** 实际采用的来源与模型：由真实请求事件发布的 actual 推导，不用目录里的名称顶替。 */
export function describeActual(
  actual: NonNullable<SessionModelState["actual"]>,
  sources: readonly ModelSourcePick[],
): string {
  const source = sources.find((s) => s.sourceId === actual.sourceId);
  const modelLabel = source?.models.find((m) => m.modelId === actual.modelId)?.modelLabel ?? actual.modelLabel;
  const sourceLabel = actual.sourceLabel || source?.sourceLabel || actual.sourceId;
  return `${sourceLabel} · ${modelLabel}`;
}

/** 上下文上限只显示已核实的真实数值；未核实就写「未核实」，不用别处的数字顶替。 */
function formatContextWindow(value: number | null): string {
  if (value === null) return "未核实";
  return `${Math.round(value / 1000)}k`;
}

/** 额度状态的中性描述：五态分别表达，未读取不算第四态。 */
export function describeQuota(facts: QuotaFacts | null): CopyKey | null {
  if (!facts) return null;
  switch (facts.state) {
    case "available":
      return "quota.available";
    case "exhausted":
      return "quota.exhausted";
    case "unknown":
      return "quota.unknown";
    case "unsupported":
      return "quota.unsupported";
    case "stale":
      return "quota.stale";
    default:
      return null;
  }
}

/** 窗口／共享池／更新时间与状态分别呈现：某窗口耗尽不用另一窗口的剩余冒充可用。 */
export function describeQuotaDetail(facts: QuotaFacts): string {
  const parts: string[] = [];
  if (facts.windowLabel) parts.push(`窗口 ${facts.windowLabel}`);
  if (facts.poolId) parts.push(`池 ${facts.poolId}`);
  if (facts.updatedAt !== null) parts.push(`更新于 ${new Date(facts.updatedAt).toLocaleString()}`);
  if (facts.reason) parts.push(facts.reason);
  return parts.join(" · ");
}

const RESULT_KEYS = ["none", "pending", "succeeded", "failed"] as const;
function resultCopyKey(value: string): CopyKey {
  return `model.result.${(RESULT_KEYS as readonly string[]).includes(value) ? value : "none"}` as CopyKey;
}

const LEVEL_KEYS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
function levelCopyKey(level: string): CopyKey {
  return `model.level.${(LEVEL_KEYS as readonly string[]).includes(level) ? level : "off"}` as CopyKey;
}

export function ModelEntry({
  scope,
  state,
  taskUsage,
  disabled,
}: {
  /** 只有已有会话能选模型；新任务草稿尚无会话，入口如实不可用 */
  scope: { sessionId?: string; taskId?: string } | null | undefined;
  state: SessionModelState | null;
  /** 本任务的只读用量汇总；缺席即尚无该任务归属的记录，不补零 */
  taskUsage?: TaskUsageSummary | null;
  disabled?: boolean;
}): React.JSX.Element {
  const t = useT();
  const [view, setView] = useState<ModelSourcesView | null>(null);
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [quotaByKey, setQuotaByKey] = useState<Record<string, QuotaFacts>>({});
  const requestSeq = useRef(0);

  const sessionId = scope?.sessionId;

  // 打开入口时才读取模型目录：读取不执行工作、不发送、不读额度。
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    const seq = ++requestSeq.current;
    void window.dcode.listModelSources({ sessionId }).then((next) => {
      if (cancelled || seq !== requestSeq.current) return; // 迟到结果不得覆盖较新的读取
      setView(next);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!view) return [];
    if (!needle) return view.sources;
    return view.sources
      .map((s) => ({
        ...s,
        models: s.models.filter(
          (m) => m.modelLabel.toLowerCase().includes(needle)
            || m.modelId.toLowerCase().includes(needle)
            || s.sourceLabel.toLowerCase().includes(needle),
        ),
      }))
      .filter((s) => s.models.length > 0);
  }, [view, query]);

  const summary = useMemo(() => describeCurrentModel({ state, sources: view?.sources ?? [] }), [state, view]);

  const choose = useCallback(async (choice: SessionModelChoice) => {
    if (!sessionId || busy) return;
    setBusy(true);
    setNotice(null);
    const seq = ++requestSeq.current;
    try {
      const next = await window.dcode.setSessionModelChoice({ sessionId, choice });
      // 选择只作用于后续请求：这里返回的「实际采用」可能仍是上一个模型，界面如实显示
      if (seq === requestSeq.current) setNotice(next.invalidReason ?? null);
    } catch {
      if (seq === requestSeq.current) setNotice("model.entry.failed");
    } finally {
      if (seq === requestSeq.current) setBusy(false);
    }
  }, [sessionId, busy]);

  const readQuota = useCallback(async (sourceId: string, modelId: string) => {
    const key = `${sourceId} ${modelId}`;
    // 只读额度：不发送输入、不启用执行、不解除暂停，也不因为读到就推进原工作
    const facts = await window.dcode.readModelQuota({ sourceId, modelId });
    setQuotaByKey((current) => ({ ...current, [key]: facts }));
  }, []);

  const setLevel = useCallback(async (level: ThinkingLevel | null) => {
    if (!sessionId || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const next = await window.dcode.setSessionThinkingLevel({ sessionId, level });
      setNotice(next.invalidReason ?? null);
    } catch {
      setNotice("model.entry.failed");
    } finally {
      setBusy(false);
    }
  }, [sessionId, busy]);

  if (!sessionId) {
    // 草稿尚无会话：如实说明入口不适用，不造灰入口
    return (
      <span data-slot="model-entry" data-testid="model-entry-disabled" className="text-xs opacity-70">
        {t("model.entry.noSession")}
      </span>
    );
  }

  // 条件参数作用在「本次会话要用的模型」上：
  //  · 指定模式 = 刚选定的那一个（还没发过请求也要能设）；
  //  · 自动模式 = 最近一次判定采用的候选（下一次请求要用的），没有判定时才看实际采用的模型；
  //  · 三者都没有 → 不显示档位控件，只如实给出说明，不凭空给一个作用对象。
  const decision = state?.lastRouting?.decision;
  const routed = decision?.kind === "adopt" || decision?.kind === "bounded-attempt" ? decision.identity : null;
  const levelTarget = state?.choice.mode === "explicit"
    ? { sourceId: state.choice.sourceId, modelId: state.choice.modelId }
    : routed ?? state?.actual;
  const levelCaps = levelTarget
    ? view?.sources
        .find((s) => s.sourceId === levelTarget.sourceId)
        ?.models.find((m) => m.modelId === levelTarget.modelId)?.capabilities ?? null
    : null;
  const verifiedLevels = levelCaps?.thinkingLevels ?? [];
  const levelNote = levelCaps?.thinkingNote ?? null;

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        data-slot="model-entry"
        data-testid="model-entry-trigger"
        disabled={disabled || busy}
        aria-label={`${t("model.entry.label")}：${summary.primary}`}
      >
        <span className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs hover:bg-hover">
          {/* 标签可被窄卡片收起：单行预算里入口不能把编辑区挤没。
              可访问名称仍完整挂在触发器的 aria-label 上，信息不丢。 */}
          <span data-slot="model-entry-label" className="max-w-[9rem] truncate">{summary.primary}</span>
          <ChevronDown className="size-3" strokeWidth={1.75} />
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[22rem]">
        {/* 第一层：本次会话的选择方式与实际采用，分别可辨 */}
        <DropdownMenuRadioGroup
          value={state?.choice.mode ?? "auto"}
          onValueChange={(value) => void choose(value === "explicit" && state?.choice.mode === "explicit"
            ? state.choice
            : { mode: "auto" })}
        >
          <DropdownMenuRadioItem value="auto" data-testid="model-choice-auto">
            {t("model.entry.auto")}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        {state?.choice.mode === "explicit" && (
          <p data-testid="model-choice-explicit" className="px-2 py-1 text-xs opacity-80">
            {summary.primary}
          </p>
        )}
        {/* 实际采用与最后一次请求结果分开呈现。
            「本次实际采用」只读真实 actual（由真实请求事件发布），
            不能复用上面那行"选择"摘要——否则改选到 B 还没发请求就会说已采用 B。 */}
        <p data-testid="model-actual" className="px-2 py-1 text-xs opacity-80">
          {state?.actual
            ? `${t("model.entry.actual")}：${describeActual(state.actual, view?.sources ?? [])}`
            : t("model.entry.notAdopted")}
          {state ? ` · ${t(resultCopyKey(state.lastResult))}` : ""}
        </p>
        <DropdownMenuSeparator />
        {/* 第二层：按来源分组搜索并点名到具体模型 */}
        <div className="flex items-center gap-1 px-2 py-1">
          <Search className="size-3 opacity-70" strokeWidth={1.75} />
          <input
            data-testid="model-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("model.entry.search")}
            className="w-full bg-transparent text-xs outline-none"
          />
        </div>
        {filtered.length === 0 && (
          <p data-testid="model-empty" className="px-2 py-1 text-xs opacity-70">
            {view ? t("model.entry.noMatch") : t("model.entry.loading")}
          </p>
        )}
        {filtered.map((source) => (
          <div key={source.sourceId} data-testid={`model-group-${source.sourceId}`}>
            <p className="px-2 pt-2 text-[0.68rem] uppercase opacity-60">
              {source.sourceLabel}
              {source.configured ? "" : ` · ${t("model.entry.unconfigured")}`}
            </p>
            {source.models.map((model) => {
              const key = `${model.sourceId} ${model.modelId}`;
              const selected = state?.choice.mode === "explicit"
                && state.choice.sourceId === model.sourceId
                && state.choice.modelId === model.modelId;
              return (
                <DropdownMenuRadioItem
                  key={key}
                  value={selected ? `pick:${key}` : `pick:${key}`}
                  data-testid={`model-item-${model.sourceId}-${model.modelId}`}
                  onSelect={() => void choose({ mode: "explicit", sourceId: model.sourceId, modelId: model.modelId })}
                >
                  <span className="flex flex-col gap-0.5">
                    <span className="text-xs">{model.modelLabel}</span>
                    {/* 同名模型以来源与标识区分；归属未提供就写未提供，不合并成一条 */}
                    <span className="text-[0.68rem] opacity-70">{model.modelId}</span>
                    <span data-testid="model-caps" className="text-[0.68rem] opacity-70">
                      {model.capabilities
                        ? `${t("model.context.label")} ${formatContextWindow(model.capabilities.contextWindow)}`
                        : t("model.caps.unverified")}
                    </span>
                  </span>
                </DropdownMenuRadioItem>
              );
            })}
          </div>
        ))}
        {/* 额度：只读，且只针对本次会话要用的模型。
            读取不发送输入、不启用执行、不解除暂停；未读取就显示「未读取」，不显示成可用或 0。 */}
        <DropdownMenuSeparator />
        <p className="px-2 pt-1 text-[0.68rem] uppercase opacity-60">{t("model.quota.label")}</p>
        {levelTarget ? (
          <>
            <p data-testid="model-quota-target" className="px-2 text-[0.68rem] opacity-70">
              {`${levelTarget.sourceId} · ${levelTarget.modelId}`}
            </p>
            {(() => {
              const key = `${levelTarget.sourceId} ${levelTarget.modelId}`;
              const quota = quotaByKey[key] ?? null;
              if (!quota) {
                return (
                  <div className="px-2">
                    <p data-testid="model-quota-unread" className="text-[0.68rem] opacity-70">{t("model.quota.unread")}</p>
                    <button
                      type="button"
                      data-testid="model-quota-read"
                      className="text-[0.68rem] underline"
                      onClick={() => void readQuota(levelTarget.sourceId, levelTarget.modelId)}
                    >
                      {t("model.quota.read")}
                    </button>
                  </div>
                );
              }
              return (
                <p data-testid="model-quota" className="px-2 text-[0.68rem] opacity-70">
                  {`${t(describeQuota(quota) ?? "quota.unknown")} — ${describeQuotaDetail(quota)}`}
                </p>
              );
            })()}
          </>
        ) : (
          <p data-testid="model-quota-none" className="px-2 text-[0.68rem] opacity-70">{t("model.quota.noTarget")}</p>
        )}
        {verifiedLevels.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <p className="px-2 pt-1 text-[0.68rem] uppercase opacity-60">{t("model.level.label")}</p>
            <DropdownMenuRadioGroup
              value={state?.thinkingLevel ?? "none"}
              onValueChange={(value) => void setLevel(value === "none" ? null : (value as ThinkingLevel))}
            >
              <DropdownMenuRadioItem value="none" data-testid="model-level-none">
                {t("model.level.default")}
              </DropdownMenuRadioItem>
              {verifiedLevels.map((level) => (
                <DropdownMenuRadioItem key={level} value={level} data-testid={`model-level-${level}`}>
                  {t(levelCopyKey(level))}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        )}
        {verifiedLevels.length === 0 && levelNote && (
          <p data-testid="model-level-note" className="px-2 pt-2 text-[0.68rem] opacity-70">
            {levelNote}
          </p>
        )}
        {notice && (
          <p data-testid="model-entry-notice" className="px-2 pt-2 text-[0.68rem] opacity-80">
            {notice === "model.entry.failed" ? t("model.entry.failed") : notice}
          </p>
        )}
        {/* 任务用量：只读汇总，来自真实请求记录。基础摘要一行，
            计量范围与按来源拆分按需展开（DESIGN：摘要优先、细节渐进）。 */}
        <DropdownMenuSeparator />
        <UsageSummary state={state} summary={taskUsage ?? null} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 用量数字按来源事实呈现：没有记录是"尚无记录"而不是 0。 */
function usageLine(t: (k: CopyKey, p?: Record<string, string | number>) => string, usage: WorkUsage): string {
  return `${t("model.usage.tokens", {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
  })} · ${t("model.usage.requests", { n: usage.requests })}`;
}

function UsageSummary({
  state,
  summary,
}: {
  state: SessionModelState | null;
  summary: TaskUsageSummary | null;
}): React.JSX.Element {
  const t = useT();
  const [open, setOpen] = useState(false);
  const sessionUsage = state?.usage ?? null;
  return (
    <div className="px-2 pt-1 pb-1 text-[0.68rem]">
      <p data-testid="model-usage-session">
        {sessionUsage
          ? `${t("model.usage.session")}：${usageLine(t, sessionUsage)}`
          : t("model.usage.noRecord")}
      </p>
      <p data-testid="model-usage-task" className="opacity-80">
        {summary?.totals
          ? `${t("model.usage.task")}：${usageLine(t, summary.totals)}`
          : t("model.usage.noRecord")}
      </p>
      {summary?.incompleteReason && (
        <p data-testid="model-usage-gap" className="opacity-70">
          {summary.incompleteReason}
        </p>
      )}
      {summary && (
        <>
          <button
            type="button"
            data-testid="model-usage-scope-toggle"
            className="mt-1 cursor-default text-[0.68rem] opacity-70 underline decoration-dotted underline-offset-2"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? t("model.usage.hideScope") : t("model.usage.showScope")}
          </button>
          {open && (
            <div data-testid="model-usage-scope" className="mt-1 space-y-0.5 opacity-80">
              {summary.scope.length === 0 && <p>{t("model.usage.scopeEmpty")}</p>}
              {summary.scope.map((entry) => (
                <p key={entry.sessionId} data-testid={`model-usage-scope-${entry.sessionId}`}>
                  {entry.kind === "main" ? t("model.usage.mainSession") : t("model.usage.memberSession")}
                  {" · "}
                  {entry.usage ? usageLine(t, entry.usage) : t("model.usage.noRecord")}
                </p>
              ))}
              {summary.bySource.map((src) => (
                <p key={src.sourceId} data-testid={`model-usage-source-${src.sourceId}`}>
                  {`${src.sourceLabel} · ${usageLine(t, src.usage)}`}
                </p>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}