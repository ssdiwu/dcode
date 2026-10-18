import { AssistantEntry, CompactionEntry } from '@earendil-works/pi-durable';
import type { ContextView, EntryRecord } from '@earendil-works/pi-durable';
import type { AnyModel } from '@earendil-works/pi-ai';
import type { ContextUsage } from '@earendil-works/pi-coding-agent';
import { estimateContextTokens, estimateMessageTokens, calculateContextTokens } from '@earendil-works/pi-ai/utils/estimate';

/** 原Host捕获帧，不冒称单一存储revision或同步查询时的瞬时状态。 */
export type ContextUsageFrame = Readonly<{
  sessionId: string; resourceEpoch: string; threadId: number; requestId: string;
  beforeModelKey: string | null; afterModelKey: string | null;
  entriesComplete: true;
}>;
export type ContextUsageSnapshot = Readonly<{
  context: ContextView;
  /** All fork-visible entries paged through the exact context tail, not a latest unbounded scan. */
  entries: readonly EntryRecord[];
  /** The original Host canonical physical model. Credentials/headers are never read. */
  model: AnyModel | undefined;
  frame: ContextUsageFrame;
}>;
export type ContextUsageObservation = Readonly<{
  usage: ContextUsage | undefined;
  reason: string;
  frameKey: string;
  headId: number | null;
  tailId: number;
  anchorEntryId?: number;
  basis?: 'active-estimate' | 'chat-usage-plus-tail' | 'unknown-after-compaction';
}>;
const finiteCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const plain = (value: unknown) => JSON.stringify(value);

/** Small scalar identity only: do not serialize the canonical model or its auth material. */
export function contextModelKey(model: AnyModel | undefined): string | null {
  if (!model) return null;
  const window = 'contextWindow' in model ? model.contextWindow : null;
  return JSON.stringify([model.type ?? 'chat', model.api, model.provider, model.id, window]);
}

/** 仅从原有效上下文派生SDK估算；不写历史／账单、不接收输入或请求模型。 */
export function explainContextUsage(snapshot: ContextUsageSnapshot): ContextUsageObservation {
  const {context: view, entries, model, frame} = snapshot;
  const headId = view.head ? Number(view.head.id) : null;
  const tailId = view.entries.reduce((tail, entry) => Math.max(tail, Number(entry.id)), 0);
  const frameKey = JSON.stringify([frame.sessionId, frame.resourceEpoch, frame.threadId, frame.requestId,
    frame.afterModelKey, headId, tailId]);
  const unknown = (reason: string): ContextUsageObservation => ({usage: undefined, reason, frameKey, headId, tailId});
  if (!frame.sessionId || !frame.resourceEpoch || !frame.requestId || frame.entriesComplete !== true
    || !Number.isSafeInteger(frame.threadId) || frame.threadId <= 0
    || frame.beforeModelKey !== frame.afterModelKey || frame.afterModelKey !== contextModelKey(model)) return unknown('incoherent-frame');
  if (!model || model.type === 'image' || model.type === 'classifier' || model.api === 'pi-virtual') return unknown('physical-chat-model-missing');
  const window = model.contextWindow;
  if (!Number.isSafeInteger(window) || window <= 0) return unknown('context-window-unknown');
  if (view.entries.length !== view.contributions.length) return unknown('inconsistent-context');
  const raw = new Map<number, EntryRecord>(); let rawTail = 0;
  for (const entry of entries) {
    const id = Number(entry.id);
    if (!Number.isSafeInteger(id) || id <= 0 || id > tailId || raw.has(id)) return unknown('entry-range-mismatch');
    raw.set(id, entry); rawTail = Math.max(rawTail, id);
  }
  if (raw.size && rawTail !== tailId) return unknown('entry-range-mismatch');
  const sorted = [...raw.values()].sort((left, right) => Number(left.id) - Number(right.id));
  const latestHead = sorted.filter(entry => entry.head !== undefined).at(-1);
  if (latestHead?.id !== view.head?.id || latestHead?.head !== view.head?.head) return unknown('head-frame-mismatch');
  for (const entry of view.entries) {
    const found = raw.get(Number(entry.id));
    if (!found || found.kind !== entry.kind || found.conversationId !== entry.conversationId
      || found.head !== entry.head || plain(found.model) !== plain(entry.model) || plain(found.edits) !== plain(entry.edits)) return unknown('entry-frame-mismatch');
  }
  // Parent conversationId is legitimate for inherited fork-visible entries. Verify each original row above,
  // never replace source ownership by the current conversation or merge unrelated conversation scans.
  // Durable会为尚未完成的工具合成协议占位；它不是正式贡献，不能虚增SDK上下文用量。
  // 同样正文若确已由正式ToolResult保存，仍按原贡献保留，不靠字符串内容猜测。
  const contributed = new Set(view.contributions.flat());
  const messages = view.messages.filter(message => message.role !== 'toolResult' || contributed.has(message));
  let estimate: ReturnType<typeof estimateContextTokens>;
  try { estimate = estimateContextTokens(messages); } catch { return unknown('invalid-effective-message'); }
  if (!finiteCount(estimate.tokens) || !finiteCount(estimate.usageTokens) || !finiteCount(estimate.trailingTokens)) return unknown('invalid-estimate');
  const anchorIndex = estimate.lastUsageIndex;
  const message = anchorIndex === null ? undefined : messages[anchorIndex];
  const sourceIndex = message ? view.contributions.findIndex(parts => parts.includes(message)) : -1;
  const source = sourceIndex < 0 ? undefined : view.entries[sourceIndex];
  let usable = !!message && message.role === 'assistant' && !!source && source.kind === AssistantEntry.kind
    && message.provider === model.provider && message.model === model.id && message.api === model.api
    && message.stopReason !== 'aborted' && message.stopReason !== 'error' && message.stopReason !== 'deferred'
    && finiteCount(calculateContextTokens(message.usage)) && calculateContextTokens(message.usage) > 0;
  // A retained assistant before a newly appended compaction describes the old prefix, not the new one.
  if (usable && view.head && Number(source!.id) <= Number(view.head.id)) usable = false;
  const rangeStart = Number(view.head?.head ?? 0);
  if (usable) {
    // Full bounded raw entries expose edits carried by older head markers omitted from view.entries.
    const activeIds = new Set(view.entries.map(entry => Number(entry.id)));
    if (sorted.some(entry => Number(entry.id) >= rangeStart && Number(entry.id) > Number(source!.id)
      && entry.edits?.some(edit => activeIds.has(Number(edit.target)) && Number(edit.target) <= Number(source!.id)))) usable = false;
    // Unknown edit provenance cannot make an old usage measurement apply to changed content.
    for (let index = 0; usable && index <= sourceIndex; index++) {
      const entry = view.entries[index];
      const original = (entry.model ?? []).filter(part => part.role !== 'assistant'
        || !['aborted', 'error', 'deferred'].includes(part.stopReason));
      if (plain(original) !== plain(view.contributions[index])
        && !sorted.some(editEntry => Number(editEntry.id) >= rangeStart && editEntry.edits?.some(edit => edit.target === entry.id))) usable = false;
    }
  }
  if (usable) {
    const percent = estimate.tokens / window * 100;
    if (!finiteCount(percent)) return unknown('invalid-estimate-percent');
    return {usage: {tokens: estimate.tokens, contextWindow: window, percent},
      reason: 'applicable-chat-usage', frameKey, headId, tailId, anchorEntryId: Number(source!.id), basis: 'chat-usage-plus-tail'};
  }
  if (view.head?.kind === CompactionEntry.kind) return {usage: {tokens: null, contextWindow: window, percent: null},
    reason: 'no-applicable-post-compaction-chat-usage', frameKey, headId, tailId, basis: 'unknown-after-compaction'};
  // No trustworthy measurement: estimate only effective model messages, never entries/data/UsageDoc totals.
  const tokens = messages.reduce((sum, part) => sum + estimateMessageTokens(part), 0);
  if (!finiteCount(tokens)) return unknown('invalid-estimate');
  const percent = tokens / window * 100;
  if (!finiteCount(percent)) return unknown('invalid-estimate-percent');
  return {usage: {tokens, contextWindow: window, percent}, reason: 'no-applicable-chat-usage',
    frameKey, headId, tailId, basis: 'active-estimate'};
}
export function deriveContextUsage(snapshot: ContextUsageSnapshot): ContextUsage | undefined {
  return explainContextUsage(snapshot).usage;
}
