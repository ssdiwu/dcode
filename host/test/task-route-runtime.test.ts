import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiHost } from "../src/pi-host.js";
import type { FoundationSnapshot, TaskBundle } from "../src/product-store.js";

function completion(content: string, args?: unknown, id = "route-call") {
  const tool = args ? { index: 0, id, type: "function", function: { name: "dcode_route", arguments: JSON.stringify(args) } } : undefined;
  const chunk = { id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: tool ? { role: "assistant", tool_calls: [tool] } : { role: "assistant", content }, finish_reason: null }] };
  const end = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}

test("native coordinator uses the registered route tool through Pi and resumes persisted context without replacing raw input", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-route-runtime-")), agent = join(root, "agent"), home = join(root, "home");
  await mkdir(agent); await mkdir(home);
  await writeFile(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "zai-coding-cn", defaultModel: "fixture", retry: { enabled: false } }));
  await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { "zai-coding-cn": { baseUrl: "https://open.bigmodel.cn/api/paas/v4", api: "openai-completions", apiKey: "fixture-only", models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 4096 }] } } }));
  const previousFetch = globalThis.fetch;
  let calls = 0;
  const toolResults: unknown[] = [];
  globalThis.fetch = (async (_url, init) => {
    if (String(_url).includes("quota/limit")) return Response.json({ success: true, code: 200, data: { limits: [{ type: "TOKENS_LIMIT", percentage: 20, nextResetTime: Date.now() + 3600000 }] } });
    const body = JSON.parse(String(init?.body)); calls++;
    const tool = body.tools.find((item: { function: { name: string } }) => item.function.name === "dcode_route");
    assert.ok(tool); assert.equal(tool.function.parameters.type, "object");
    const last = body.messages.filter((message: { role: string }) => message.role === "tool").at(-1);
    if (last) toolResults.push(last);
    let result;
    try { result = last ? JSON.parse(last.content) : undefined; }
    catch { throw new Error(`Unexpected route tool result: ${String(last?.content).slice(0, 800)}`); }
    if (calls === 1) return completion("", { action: "context" }, "context");
    if (calls === 2) return completion("", { action: "update", expectedPlanRevision: result.planRevision, operation: { action: "begin", question: "选择可验证的读取路线", budget: { candidates: 3, checks: 3, rounds: 2 }, independentCheck: false } }, "begin");
    if (calls === 3) return completion("", { action: "update", expectedPlanRevision: result.planRevision, operation: { action: "propose", candidate: { title: "流式读取", approach: "逐段处理输入", assumptions: ["允许分段"], basis: "尚待核对读取接口", evidenceIds: [], failureConditions: ["跨段状态丢失"], probe: "核查跨段边界", expectedCost: "一次独立检查", remainingWork: ["实现并验证"], dependencies: "读取接口边界成立" } } }, "propose");
    if (calls === 5) {
      assert.match(body.messages.find((message: { role: string }) => message.role === "system").content, /当前任务路线记录/);
      return completion("", { action: "read", offset: 0, limit: 1000 }, "read");
    }
    if (calls === 6) { assert.equal(result.content.length, 1000); assert.equal(result.nextOffset, 1000); }
    return completion("候选已保存，尚未检查或采用。");
  }) as typeof fetch;
  const events: unknown[] = [];
  const options = { agentDir: agent, sessionsDirectory: join(agent, "sessions"), dataRoot: join(root, ".dcode"), userHome: home,
    emit: (event: string, data?: unknown) => { if (/error|failed/i.test(event)) events.push({ event, data }); } };
  let host = new PiHost(options);
  const snapshot = () => host.handle("foundation.snapshot", {}) as Promise<FoundationSnapshot>;
  const settled = async () => {
    const deadline = Date.now() + 12000;
    while ((await snapshot()).sessionRuns.some(run => run.status === "running" || run.status === "prepared")) {
      if (Date.now() > deadline) throw new Error(`Native route run did not settle: ${JSON.stringify({ calls, events, runs: (await snapshot()).sessionRuns.map(run => ({ id: run.id, status: run.status })) })}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  try {
    await host.start(); const initial = await snapshot();
    const task = await host.handle("task.create", { requestId: "create", expectedStoreRevision: initial.storeRevision, scope: { kind: "user", userId: initial.currentUser.id }, title: "读取路线", goal: "保留输出并降低内存" }) as TaskBundle;
    await host.handle("dcodeSession.prompt", { dcodeSessionId: task.coordinationSession.id, promptId: "first", message: "先探索读取方案" });
    await settled();
    const before = await snapshot();
    assert.equal(before.taskPlans.length, 1, JSON.stringify({ calls, toolResults, runs: before.sessionRuns, providerCalls: before.providerCalls, reports: before.agentReports })); assert.equal((before.taskPlans[0]!.document as any).routeExploration.candidates.length, 1, JSON.stringify(toolResults));
    assert.equal(before.agentRuns.length, 1);
    assert.ok(before.promptReceipts.length > 0);
    const original = await host.handle("sessionRun.inputs", { taskId: task.task.id, sessionRunId: before.sessionRuns[0]!.id }) as { rawText: string };
    assert.equal(original.rawText, "先探索读取方案");
    await host.close(); host = new PiHost(options); await host.start();
    await host.handle("dcodeSession.prompt", { dcodeSessionId: task.coordinationSession.id, promptId: "second", message: "继续核对候选" });
    await settled();
    const after = await snapshot();
    assert.deepEqual(after.taskPlans.map(({ routeInputCurrent, ...plan }) => plan), before.taskPlans.map(({ routeInputCurrent, ...plan }) => plan));
    assert.equal(after.taskPlans[0]!.routeInputCurrent, false, "新输入等待协调者核对，持久路线原文保持不变");
    assert.equal(after.tasks[0]!.state, "active");
    assert.equal(calls, 6);
  } finally { await host.close(); globalThis.fetch = previousFetch; await rm(root, { recursive: true, force: true }); }
});
