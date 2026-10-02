import assert from "node:assert/strict";
import test from "node:test";
import { currentSessionContextUsage } from "../src/renderer/src/workbench/context-usage.ts";

const timestamp = "2026-09-29T00:00:00.000Z";
function fixture() {
  return {
    dcodeSession: { id: "dcode-main" },
    nativePaths: [{ id: "current", isCurrent: true }, { id: "older", isCurrent: false }],
    selectedNativePathId: "current",
    binding: { sessionId: "dcode-main", adapterSessionId: "adapter-main" },
    runtime: {
      runtimeId: "runtime-main",
      state: {
        sessionId: "adapter-main",
        model: { provider: "provider-a", id: "model-a", name: "模型 A" },
        contextUsage: { tokens: 42_000, contextWindow: 100_000, percent: 42 },
      },
    },
    inspection: {
      selectedPathId: "pi-current", currentPathId: "pi-current",
      entries: [
        { type: "message", id: "user-one", timestamp, message: { role: "user" } },
        { type: "message", id: "assistant-one", timestamp, message: { role: "assistant", provider: "provider-a", model: "model-a", stopReason: "stop", timestamp, usage: { input: 40_000, output: 2_000, cacheRead: 0, cacheWrite: 0, totalTokens: 42_000 } } },
      ],
    },
  };
}

test("current Session and Runtime expose an estimate with a separately sourced model usage record", () => {
  const value = currentSessionContextUsage(fixture(), { providerId: "provider-a", modelId: "model-a" });
  assert.equal(value.kind, "estimated");
  assert.deepEqual(value.lastUsageRecord, { entryId: "assistant-one", recordedAt: timestamp });
  assert.equal(value.tokens, 42_000);
  assert.equal(value.contextWindow, 100_000);
  assert.equal(value.remainingTokens, 58_000);
  assert.equal(value.remainingPercent, 58);
});

test("a different member, a historical path, or an inactive Runtime never borrows usage", () => {
  assert.deepEqual(currentSessionContextUsage(undefined), { kind: "unknown", reason: "no-runtime" });
  const historical = fixture(); historical.selectedNativePathId = "older";
  assert.deepEqual(currentSessionContextUsage(historical), { kind: "unknown", reason: "historical-path" });
  const noRuntime = fixture(); noRuntime.runtime = null;
  assert.deepEqual(currentSessionContextUsage(noRuntime), { kind: "unknown", reason: "no-runtime" });
  const wrongBinding = fixture(); wrongBinding.runtime.state.sessionId = "adapter-other-member";
  assert.deepEqual(currentSessionContextUsage(wrongBinding), { kind: "unknown", reason: "no-runtime" });
  const otherMember = fixture(); otherMember.binding.sessionId = "dcode-other-member";
  assert.deepEqual(currentSessionContextUsage(otherMember), { kind: "unknown", reason: "no-runtime" });
});

test("unknown totals and changed models cannot draw a false full ring", () => {
  for (const [tokens, contextWindow] of [[null, 100_000], [0, 100_000], [42_000, 0]]) {
    const value = fixture(); value.runtime.state.contextUsage = { tokens, contextWindow };
    assert.deepEqual(currentSessionContextUsage(value), { kind: "unknown", reason: "no-usage" });
  }
  const switched = fixture(); switched.runtime.state.model.id = "model-b";
  assert.deepEqual(currentSessionContextUsage(switched), { kind: "unknown", reason: "model-changed" });
  const selected = fixture();
  assert.deepEqual(currentSessionContextUsage(selected, { providerId: "provider-a", modelId: "model-b" }), { kind: "unknown", reason: "model-changed" });
});

test("compaction invalidates the previous assistant usage until a new result exists", () => {
  const value = fixture();
  value.inspection.entries.push({ type: "compaction", id: "compact-one", timestamp });
  assert.deepEqual(currentSessionContextUsage(value), { kind: "unknown", reason: "compacted" });
  value.runtime.state.contextUsage.tokens = null;
  assert.deepEqual(currentSessionContextUsage(value), { kind: "unknown", reason: "compacted" });
  value.runtime.state.contextUsage.tokens = 42_000;
  value.inspection.entries.push({ type: "message", id: "assistant-two", timestamp, message: { role: "assistant", provider: "provider-a", model: "model-a", timestamp } });
  assert.deepEqual(currentSessionContextUsage(value), { kind: "unknown", reason: "compacted" });
  value.inspection.entries.at(-1).message.usage = { input: 40_000, output: 2_000, cacheRead: 0, cacheWrite: 0, totalTokens: 42_000 };
  assert.equal(currentSessionContextUsage(value).lastUsageRecord.entryId, "assistant-two");
});

test("later messages without provider usage do not acquire a false confirmation time", () => {
  const value = fixture();
  const later = "2026-09-29T00:02:00.000Z";
  value.runtime.state.contextUsage.tokens = 45_000;
  value.inspection.entries.push({ type: "message", id: "assistant-two", timestamp: later, message: { role: "assistant", provider: "provider-a", model: "model-a", timestamp: later } });
  const usage = currentSessionContextUsage(value);
  assert.equal(usage.kind, "estimated");
  assert.equal(usage.tokens, 45_000);
  assert.deepEqual(usage.lastUsageRecord, { entryId: "assistant-one", recordedAt: timestamp });
});

test("without a valid provider usage anchor, occupancy is unknown", () => {
  const value = fixture();
  value.inspection.entries.at(-1).message.usage = undefined;
  const usage = currentSessionContextUsage(value);
  assert.deepEqual(usage, { kind: "unknown", reason: "no-usage" });
  const edited = fixture();
  edited.inspection.entries.push({ type: "context_edit", id: "edit-one", timestamp });
  const afterEdit = currentSessionContextUsage(edited);
  assert.deepEqual(afterEdit, { kind: "unknown", reason: "no-usage" });
  const failed = fixture(); failed.inspection.entries.at(-1).message.stopReason = "error";
  assert.deepEqual(currentSessionContextUsage(failed), { kind: "unknown", reason: "no-usage" });
});
