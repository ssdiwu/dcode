import type { DCodeSessionPresentation } from "../types";

export interface EstimatedContextUsage {
  kind: "estimated";
  runtimeId: string;
  projectionEntryId: string | null;
  lastUsageRecord: { entryId: string; recordedAt: string | null };
  modelName: string;
  tokens: number;
  contextWindow: number;
  remainingTokens: number;
  remainingPercent: number;
}

export interface UnknownContextUsage {
  kind: "unknown";
  reason: "historical-path" | "no-runtime" | "no-usage" | "model-changed" | "compacted";
}

export type SessionContextUsage = EstimatedContextUsage | UnknownContextUsage;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function timestamp(value: unknown): string | null {
  const time = typeof value === "number" || typeof value === "string" ? new Date(value) : null;
  return time && Number.isFinite(time.getTime()) ? time.toISOString() : null;
}

function hasProviderUsage(message: Record<string, unknown>): boolean {
  if (message.stopReason === "aborted" || message.stopReason === "error") return false;
  const usage = record(message.usage);
  if (!usage) return false;
  if (positiveNumber(usage.totalTokens)) return true;
  const parts = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite];
  return parts.every(part => typeof part === "number" && Number.isFinite(part) && part >= 0)
    && parts.reduce<number>((sum, part) => sum + (part as number), 0) > 0;
}

/** Pi SDK occupancy is an estimate; a provider usage record is only a separate source timestamp. */
export function currentSessionContextUsage(
  presentation: DCodeSessionPresentation | undefined,
  selectedModel?: { providerId: string; modelId: string } | null,
): SessionContextUsage {
  if (!presentation) return { kind: "unknown", reason: "no-runtime" };
  const selectedPath = presentation.nativePaths?.find(path => path.id === presentation.selectedNativePathId);
  if (selectedPath ? !selectedPath.isCurrent : presentation.inspection?.selectedPathId !== presentation.inspection?.currentPathId)
    return { kind: "unknown", reason: "historical-path" };
  const runtime = presentation.runtime;
  if (!runtime || !presentation.binding || presentation.binding.sessionId !== presentation.dcodeSession.id || !presentation.inspection)
    return { kind: "unknown", reason: "no-runtime" };
  const state = record(runtime.state);
  if (!state || state.sessionId !== presentation.binding.adapterSessionId)
    return { kind: "unknown", reason: "no-runtime" };
  const model = record(state.model);
  if (!model || typeof model.provider !== "string" || typeof model.id !== "string")
    return { kind: "unknown", reason: "no-usage" };
  if (selectedModel && (model.provider !== selectedModel.providerId || model.id !== selectedModel.modelId))
    return { kind: "unknown", reason: "model-changed" };
  const usage = record(state.contextUsage);
  if (!usage || !positiveNumber(usage.contextWindow))
    return { kind: "unknown", reason: "no-usage" };

  const entries = presentation.inspection.entries;
  let latestCompactionIndex = -1;
  let latestInvalidationIndex = -1;
  let latestAssistant: Record<string, unknown> | null = null;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type === "compaction" && latestCompactionIndex < 0) latestCompactionIndex = index;
    if ((entry.type === "compaction" || entry.type === "context_edit") && latestInvalidationIndex < 0)
      latestInvalidationIndex = index;
    if (!latestAssistant && entry.type === "message") {
      const message = record(entry.message);
      if (message?.role === "assistant") latestAssistant = message;
    }
  }
  if (latestAssistant && latestAssistant.provider !== undefined && latestAssistant.model !== undefined
    && (latestAssistant.provider !== model.provider || latestAssistant.model !== model.id))
    return { kind: "unknown", reason: "model-changed" };

  let lastUsageRecord: EstimatedContextUsage["lastUsageRecord"] | null = null;
  let hasPostCompactionUsage = false;
  for (let index = entries.length - 1; index > Math.min(latestInvalidationIndex, latestCompactionIndex); index--) {
    const entry = entries[index];
    if (entry.type !== "message") continue;
    const message = record(entry.message);
    if (!message || message.role !== "assistant" || message.provider !== model.provider || message.model !== model.id || !hasProviderUsage(message)) continue;
    if (index > latestCompactionIndex) hasPostCompactionUsage = true;
    if (index > latestInvalidationIndex && !lastUsageRecord)
      lastUsageRecord = { entryId: entry.id, recordedAt: timestamp(message.timestamp) ?? timestamp(entry.timestamp) };
    if (lastUsageRecord && hasPostCompactionUsage) break;
  }
  if (latestCompactionIndex >= 0 && !hasPostCompactionUsage)
    return { kind: "unknown", reason: "compacted" };
  if (!positiveNumber(usage.tokens)) return { kind: "unknown", reason: "no-usage" };
  if (!lastUsageRecord) return { kind: "unknown", reason: "no-usage" };

  const remainingTokens = Math.max(0, usage.contextWindow - usage.tokens);
  return {
    kind: "estimated",
    runtimeId: runtime.runtimeId,
    projectionEntryId: entries.at(-1)?.id ?? null,
    lastUsageRecord,
    modelName: typeof model.name === "string" ? model.name : model.id,
    tokens: usage.tokens,
    contextWindow: usage.contextWindow,
    remainingTokens,
    remainingPercent: Math.max(0, Math.min(100, 100 * remainingTokens / usage.contextWindow)),
  };
}
