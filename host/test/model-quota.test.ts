import assert from "node:assert/strict";
import test from "node:test";
import { ModelQuotaService, assessModelQuota, parseQuotaGroups, type ModelQuotaSnapshot } from "../src/model-quota.js";
import { chooseAgentModel } from "../src/model-route.js";

const now = 1_800_000_000_000;
function snapshot(percent: number | null, poolId = "shared"): ModelQuotaSnapshot {
  return { providerId: "minimax-cn", poolId, fetchedAt: now, validUntil: now + 60_000, status: "known", groups: [{ id: "general", label: "通用", windows: [{ id: "week", label: "周", remainingPercent: percent, resetAt: now + 100_000, capability: "text" }] }] };
}

test("quota lower bound uses raw values, all applicable windows, and explicit reset freshness", () => {
  assert.equal(assessModelQuota(snapshot(1.01), "m", now, 1).eligible, true);
  for (const value of [1, 0.99, 0, null]) assert.equal(assessModelQuota(snapshot(value), "m", now, 1).eligible, false);
  const data = snapshot(90);
  data.groups[0]!.windows.push({ id: "short", label: "短期", remainingPercent: 1, resetAt: now + 1000, capability: "text" });
  assert.equal(assessModelQuota(data, "m", now, 1).eligible, false);
  assert.match(assessModelQuota(snapshot(80), "m", now + 60_000, 1).reason, /过期/);
  const reset = snapshot(80); reset.groups[0]!.windows[0]!.resetAt = now;
  assert.match(assessModelQuota(reset, "m", now, 1).reason, /重新查询/);
});

test("provider parsers retain missing fields as unknown and do not confuse unrelated search quota", () => {
  const codex = parseQuotaGroups("openai-codex", { rate_limit: { primary_window: { reset_at: (now + 1000) / 1000 } } });
  assert.equal(codex[0]!.windows[0]!.remainingPercent, null);
  const minimax = parseQuotaGroups("minimax-cn", { base_resp: { status_code: 0 }, model_remains: [{ model_name: "video", current_interval_remaining_percent: 100 }, { model_name: "general", current_interval_remaining_percent: 80 }] });
  assert.equal(minimax.find((group) => group.id === "general")!.windows[1]!.remainingPercent, null);
  const groups = parseQuotaGroups("zai-coding-cn", { success: true, code: 200, data: { limits: [{ type: "TOKENS_LIMIT", percentage: 10, unit: 3, number: 5 }, { type: "TIME_LIMIT", percentage: 100 }] } });
  const data = { ...snapshot(80), groups };
  assert.equal(assessModelQuota(data, "glm", now, 1).eligible, true);
  assert.equal(assessModelQuota(data, "glm", now, 1, ["search"]).eligible, false);
});

test("model-specific buckets require a real mapping and add to the general constraint", () => {
  const data = snapshot(80);
  data.groups.push({ id: "special", label: "专属", modelIds: ["special-model"], windows: [{ id: "short", label: "短期", remainingPercent: 0, resetAt: now + 1000, capability: "text" }] });
  assert.equal(assessModelQuota(data, "ordinary", now, 1).eligible, true);
  assert.equal(assessModelQuota(data, "special-model", now, 1).eligible, false);
  delete data.groups[1]!.modelIds;
  assert.match(assessModelQuota(data, "ordinary", now, 1).reason, /范围尚未确认/);
  assert.equal(assessModelQuota(data, "ordinary", now, 1).eligible, false);
});

test("each member's fallback order survives quota filtering and a shared low pool is not retried per model", async () => {
  const models = ["disabled", "first", "same-pool", "next", "largest"].map((modelId) => ({ providerId: modelId === "next" || modelId === "largest" ? modelId : "shared-provider", modelId, enabled: modelId !== "disabled", available: true }));
  const calls: string[] = [];
  const quotas = { get: async (providerId: string) => { calls.push(providerId); return snapshot(providerId === "shared-provider" ? 1 : providerId === "next" ? 2 : 90, providerId); } };
  const candidates = models.map(({ providerId, modelId }) => ({ providerId, modelId }));
  const first = await chooseAgentModel({ thresholdPercent:1, candidates, models, quotas, now: () => now });
  assert.equal(first.selected?.modelId, "next");
  assert.deepEqual(calls, ["shared-provider", "next"]);
  assert.deepEqual(first.considered.map((item) => item.reason), ["模型未启用", "剩余额度不高于 1%", "剩余额度不高于 1%", "额度可用"]);
  const second = await chooseAgentModel({ thresholdPercent:1, candidates: candidates.slice().reverse(), models, quotas, now: () => now });
  assert.equal(second.selected?.modelId, "largest");
});

test("unknown or inaccessible candidates do not start a model or trigger unnecessary quota queries", async () => {
  let queried = 0;
  const quotas = { get: async () => { queried++; return { ...snapshot(80), status: "unknown" as const, error: "缺字段" }; } };
  const candidates = [{ providerId: "one", modelId: "offline" }, { providerId: "two", modelId: "unknown" }];
  const result = await chooseAgentModel({ thresholdPercent:1, candidates, models: candidates.map((item) => ({ ...item, enabled: true, available: item.modelId !== "offline" })), quotas, now: () => now });
  assert.equal(queried, 1);
  assert.equal(result.selected, null);
});

test("queries coalesce, snapshots exclude credentials, and cache resets require another request", async () => {
  let time = now; let calls = 0;
  const service = new ModelQuotaService({ now: () => time,
    resolveCredential: async () => ({ auth: { apiKey: "test-private-material" }, sourceBaseUrl: "https://api.minimaxi.com/v1" }),
    fetch: async (_url, options) => {
      calls++;
      assert.equal(options?.redirect, "error");
      await new Promise((resolve) => setTimeout(resolve, 5));
      return Response.json({ base_resp: { status_code: 0 }, model_remains: [{ model_name: "general", current_interval_remaining_percent: 50, current_weekly_remaining_percent: 90, end_time: time + 1000, weekly_end_time: time + 100000 }] });
    },
  });
  const [a, b] = await Promise.all([service.get("minimax-cn"), service.get("minimax-cn")]);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a).includes("test-private-material"), false);
  await service.get("minimax-cn"); assert.equal(calls, 1);
  time += 1001;
  await service.get("minimax-cn"); assert.equal(calls, 2);
});

test("untrusted provider names and wrong inference origins cannot receive credentials", async () => {
  let calls = 0;
  const service = new ModelQuotaService({ resolveCredential: async () => ({ auth: { apiKey: "fixture" }, sourceBaseUrl: "https://unrelated.invalid/v1" }), fetch: async () => { calls++; return Response.json({}); } });
  assert.equal((await service.get("__proto__")).status, "unknown");
  assert.equal((await service.get("minimax-cn")).status, "unknown");
  assert.equal(calls, 0);
});

test("one failed provider does not invalidate another provider's snapshot", async () => {
  const service = new ModelQuotaService({ now: () => now, resolveCredential: async (providerId) => ({ auth: { apiKey: "fixture" }, sourceBaseUrl: providerId === "minimax-cn" ? "https://api.minimaxi.com/v1" : "https://open.bigmodel.cn/v4" }), fetch: async (url) => {
    if (String(url).includes("bigmodel")) return new Response("private error body", { status: 403 });
    return Response.json({ base_resp: { status_code: 0 }, model_remains: [{ model_name: "general", current_interval_remaining_percent: 30, current_weekly_remaining_percent: 20 }] });
  } });
  const data = await service.collect(["minimax-cn", "zai-coding-cn"]);
  assert.equal(data[0]?.status, "known");
  assert.equal(data[1]?.status, "unknown");
  assert.equal(JSON.stringify(data).includes("private error body"), false);
});

test("unmapped text-model constraints remain unknown while unrelated generation quotas do not block text", () => {
  const general = { model_name: "general", current_interval_remaining_percent: 90, current_weekly_remaining_percent: 90 };
  const low = { current_interval_remaining_percent: 0, current_weekly_remaining_percent: 0 };
  const unknown = parseQuotaGroups("minimax-cn", { base_resp: { status_code: 0 }, model_remains: [general, { model_name: "some-model", ...low }] });
  assert.equal(assessModelQuota({ ...snapshot(80), groups: unknown }, "some-model", now, 1).eligible, false);
  const video = parseQuotaGroups("minimax-cn", { base_resp: { status_code: 0 }, model_remains: [general, { model_name: "video", ...low }] });
  assert.equal(assessModelQuota({ ...snapshot(80), groups: video }, "text-model", now, 1).eligible, true);
  assert.equal(assessModelQuota({ ...snapshot(80), groups: video }, "text-model", now, 1, ["video_generation"]).eligible, false);
});

test("missing explicitly required search quota is unknown rather than inferred from text quota", () => {
  const groups = parseQuotaGroups("zai-coding-cn", { success: true, code: 200, data: { limits: [{ type: "TOKENS_LIMIT", percentage: 10, unit: 3, number: 5 }] } });
  const result = assessModelQuota({ ...snapshot(80), groups }, "glm", now, 1, ["search"]);
  assert.equal(result.eligible, false);
  assert.match(result.reason, /所需功能/);
});

test("a Provider rate limit blocks the entire known pool until retry time even on forced refresh",async()=>{
  let time=now,calls=0;
  const service=new ModelQuotaService({now:()=>time,resolveCredential:async()=>({auth:{apiKey:"fixture-only"},sourceBaseUrl:"https://api.minimaxi.com/v1"}),fetch:async()=>{calls++;return Response.json({base_resp:{status_code:0},model_remains:[{model_name:"general",current_interval_remaining_percent:50,current_weekly_remaining_percent:90,end_time:time+100000,weekly_end_time:time+604800000}]});}});
  await service.get("minimax-cn");service.blockProvider("minimax-cn","30");
  assert.equal((await service.get("minimax-cn",true)).status,"rate_limited");assert.equal(calls,1);
  time+=30001;assert.equal((await service.get("minimax-cn",true)).status,"known");assert.equal(calls,2);
});
