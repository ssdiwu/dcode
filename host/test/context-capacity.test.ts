import test from "node:test";
import assert from "node:assert/strict";
import { normalizeContext } from "@earendil-works/pi-ai";
import { requiredContextTokens } from "../src/pi-prompt-compat.js";
import { chooseAgentModel } from "../src/model-route.js";

test("capacity selection keeps a measured long conversation eligible without treating encrypted protocol bytes as tokens", async () => {
  const context = normalizeContext({ messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "", thinkingSignature: JSON.stringify({ id: "rs_fixture", type: "reasoning", summary: [], encrypted_content: "A".repeat(700000) }) }],
    provider: "openai-codex", model: "gpt-6-sol", api: "openai-codex-responses", timestamp: 1, stopReason: "stop", usage: { input: 210000, output: 264, cacheRead: 0, cacheWrite: 0, totalTokens: 210264, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }] });
  const candidate = { providerId: "openai-codex", modelId: "gpt-6-sol" }, now = Date.now();
  const choose = (minimumContext: number) => chooseAgentModel({ candidates: [candidate], models: [{ ...candidate, enabled: true, available: true, contextWindow: 272000 }], thresholdPercent: 1, minimumContext, now: () => now,
    quotas: { get: async () => ({ providerId: "openai-codex", poolId: "fixture", status: "known", fetchedAt: now, validUntil: now + 60000, groups: [{ id: "general", label: "quota", windows: [{ id: "week", label: "week", remainingPercent: 50, resetAt: now + 60000, capability: "text" }] }] }) } });
  assert.deepEqual((await choose(requiredContextTokens(context, 210264))).selected, candidate);
  assert.equal((await choose(requiredContextTokens(context, 280000))).selected, null);
  assert.ok(requiredContextTokens(context, null) < 10000, "post-compaction unknown usage is re-estimated from content, not old usage or ciphertext");
  const largeInput = normalizeContext({ messages: [{ role: "user", content: "x".repeat(1200000), timestamp: 1 }] });
  assert.equal((await choose(requiredContextTokens(largeInput, null))).selected, null, "large real content still requires a sufficiently large model");
});
