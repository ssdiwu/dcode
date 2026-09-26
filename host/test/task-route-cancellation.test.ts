import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PiHost } from "../src/pi-host.js";
import type { FoundationSnapshot, TaskBundle } from "../src/product-store.js";

function answer(text: string, name?: string, args?: unknown, id = "call") {
  const tool = name ? { index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } } : undefined;
  const chunk = { id: "fixture", object: "chat.completion.chunk", model: "fixture", created: 1, choices: [{ index: 0, delta: tool ? { role: "assistant", tool_calls: [tool] } : { role: "assistant", content: text }, finish_reason: null }] };
  const end = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}
async function until(check: () => Promise<boolean>, label: string) {
  const end = Date.now() + 15000;
  while (!await check()) { if (Date.now() > end) throw new Error(label); await new Promise(resolve => setTimeout(resolve, 20)); }
}

test("route invalidation stops the real running member and preserves an independent member", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-route-stop-")), home = join(root, "home"), agent = join(root, "agent");
  await mkdir(home); await mkdir(agent); await writeFile(join(home, "proof.txt"), "Fixture premise for a reversible route.");
  await writeFile(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "zai-coding-cn", defaultModel: "fixture", retry: { enabled: false } }));
  await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { "zai-coding-cn": { baseUrl: "https://open.bigmodel.cn/api/paas/v4", api: "openai-completions", apiKey: "fixture-only", models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 4096 }] } } }));
  const previous = globalThis.fetch;
  let ownerCalls = 0, workerCalls = 0, independentStarted = false, released = false;
  let continuePhase = false, continuationCalls = 0;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = () => { released = true; resolve(); }; });
  const errors: unknown[] = [];
  const host = new PiHost({ agentDir: agent, sessionsDirectory: join(agent, "sessions"), dataRoot: join(root, ".dcode"), userHome: home, emit: (event, data) => { if (/error|failed/.test(event)) errors.push({ event, data }); } });
  const snapshot = () => host.handle("foundation.snapshot", {}) as Promise<FoundationSnapshot>;
  globalThis.fetch = (async (url, init) => {
    if (String(url).includes("quota/limit")) return Response.json({ success: true, code: 200, data: { limits: [{ type: "TOKENS_LIMIT", percentage: 10, nextResetTime: Date.now() + 3600000 }] } });
    const body = JSON.parse(String(init?.body)), system = body.messages.find((item: { role: string }) => item.role === "system")?.content ?? "";
    if (system.includes("coordinator Agent")) {
      ownerCalls++;
      const current = await snapshot(), plan = current.taskPlans.find(item => item.state === "active"), route = (plan?.document as any)?.routeExploration;
      const update = (operation: unknown) => answer("", "dcode_route", { action: "update", expectedPlanRevision: plan?.revision ?? 0, operation }, `owner-${ownerCalls}`);
      if (continuePhase) {
        continuationCalls++;
        const worker = current.agentRuns.find(item => item.role === "worker")!;
        if (continuationCalls === 1) return answer("", "dcode_route", { action: "context" }, "continue-context");
        if (continuationCalls === 2) {
          const latest = JSON.parse(body.messages.filter((item: { role: string }) => item.role === "tool").at(-1).content);
          return update({ action: "acknowledge", inputId: latest.pendingInput.id, impact: "unchanged", reason: "只说明已保存事实，不恢复失效路线" });
        }
        if (continuationCalls === 3) {
          const previousInput = current.collaborationMessages?.find(item => item.targetAgentRunId === worker.id && ["interrupted", "failed", "paused"].includes(item.state));
          assert.ok(previousInput);
          return answer("", "dcode_team", { action: "cancel_input", messageId: previousInput.id, reason: "旧执行已被用户取消；原文保留，只继续说明失败原因" }, "close-old-input");
        }
        if (continuationCalls === 4) return answer("", "dcode_team", { action: "continue_member", agentRunId: worker.id, message: "说明已有失败原因，不执行旧命令", acceptance: "说明来源和停止结果", route: { purpose: "independent", reason: "仅解释已保存的事实，不依赖原路线成立" } }, "continue-worker");
        if (continuationCalls === 5) {
          const result = JSON.parse(body.messages.filter((item: { role: string }) => item.role === "tool").at(-1).content);
          assert.equal(result.continued, true, JSON.stringify(result));
        }
        return answer("同一成员已承接后续说明。");
      }
      if (ownerCalls === 1) return update({ action: "begin", question: "选择可撤销的路线", budget: { candidates: 3, checks: 3, rounds: 2 }, independentCheck: false });
      if (ownerCalls === 2) return update({ action: "propose", candidate: { title: "分段工作", approach: "检查后执行", assumptions: [], basis: "读取 proof.txt", evidenceIds: [], failureConditions: ["用户推翻前提"], probe: "读取文件", expectedCost: "一个执行成员", remainingWork: ["执行"], dependencies: "读取前提" } });
      if (ownerCalls === 3) return answer("", "read", { path: "proof.txt" }, "read-proof");
      if (ownerCalls === 4) {
        const proof = current.evidence.find(item => item.commandRedacted === "read")!;
        return update({ action: "check", candidateId: route.candidates[0].id, outcome: "ready", summary: "前提已实际读取", findings: [], evidenceIds: [proof.id] });
      }
      if (ownerCalls === 5) return update({ action: "adopt", candidateId: route.candidates[0].id, reason: "剩余工作边界清楚" });
      if (ownerCalls === 6) return update({ action: "work", title: "执行分段工作", completion: "完成后返回文件", dependsOn: [] });
      if (ownerCalls === 7) return answer("", "dcode_team", { action: "delegate", members: [
        { profileId: "builtin-worker", title: "路线执行", instruction: "执行隔离测试命令，等待完成信号", acceptance: "生成结果", route: { purpose: "execute", workItemId: current.taskWorkItems.find(item => item.title === "执行分段工作")!.id } },
        { profileId: "builtin-explore", title: "独立调查", instruction: "等待独立调查结果", acceptance: "返回资料", route: { purpose: "independent", reason: "与当前路线及文件执行没有依赖" } },
      ] }, "delegate");
      if (ownerCalls === 9) return answer("", "dcode_route", { action: "context" }, "read-new-input");
      if (ownerCalls === 10) {
        const latest = JSON.parse(body.messages.filter((message: { role: string }) => message.role === "tool").at(-1).content);
        assert.equal(latest.inputCurrent, false);
        return update({ action: "acknowledge", inputId: latest.pendingInput.id, impact: "changed", reason: "用户已否定核心前提，停止旧路线" });
      }
      return answer("已核对当前任务状态。");
    }
    if (system.includes("worker Agent")) {
      workerCalls++;
      if (workerCalls === 1) return answer("", "bash", { command: "touch route-started; while [ ! -f release-route ]; do sleep 0.02; done; printf forbidden > stale-result.txt" }, "long-work");
      return answer("旧路线执行结束");
    }
    independentStarted = true; await held; return answer("独立调查仍然完成");
  }) as typeof fetch;
  try {
    await host.start(); const initial = await snapshot();
    const task = await host.handle("task.create", { requestId: "task", expectedStoreRevision: initial.storeRevision, scope: { kind: "user", userId: initial.currentUser.id }, title: "路线停止", goal: "验证失效停止与无关成员保留" }) as TaskBundle;
    await host.handle("dcodeSession.prompt", { dcodeSessionId: task.coordinationSession.id, promptId: "start", message: "开始有界探索并执行" });
    await until(async () => independentStarted && await readFile(join(home, "route-started")).then(() => true, () => false), "two members started");
    await until(async () => !(await snapshot()).sessionRuns.some(item => item.sessionId === task.coordinationSession.id && item.status === "running"), "coordinator remains available");
    await host.handle("dcodeSession.prompt", { dcodeSessionId: task.coordinationSession.id, promptId: "change", message: "关键前提已改变，撤销当前路线" });
    await until(async () => (await snapshot()).agentRuns.some(item => item.role === "worker" && ["aborted", "failed"].includes(item.status)), "affected running member stopped");
    assert.equal(released, false);
    assert.ok((await snapshot()).agentRuns.some(item => item.role === "explore" && item.status === "running"));
    await writeFile(join(home, "release-route"), "later");
    await assert.rejects(readFile(join(home, "stale-result.txt")), { code: "ENOENT" });
    release();
    await until(async () => (await snapshot()).agentRuns.some(item => item.role === "explore" && item.status === "completed"), "independent member completes");
    let final = await snapshot();
    assert.equal((final.taskPlans[0]!.document as any).routeExploration.status, "invalidated");
    assert.equal(final.taskWorkItems.find(item => item.title === "执行分段工作")!.state, "cancelled");
    assert.equal(final.tasks.length, 1);
    const originalMember = final.agentRuns.find(item => item.role === "worker")!;
    await until(async () => !(await snapshot()).sessionRuns.some(item => ["prepared", "running"].includes(item.status)), "previous runs settled");
    continuePhase = true;
    await host.handle("dcodeSession.prompt", { dcodeSessionId: task.coordinationSession.id, promptId: "continue-member", message: "让原成员说明失败原因" });
    await until(async () => workerCalls >= 2 && !(await snapshot()).sessionRuns.some(item => ["prepared", "running"].includes(item.status)), "same member continues after cancellation");
    final = await snapshot();
    assert.equal(final.agentRuns.filter(item => item.role === "worker").length, 1);
    assert.equal(final.agentRuns.find(item => item.id === originalMember.id)!.sessionId, originalMember.sessionId);
    assert.equal(final.taskWorkItems.find(item => item.title === "执行分段工作")!.state, "cancelled");
    await assert.rejects(readFile(join(home, "stale-result.txt")), { code: "ENOENT" });
  } catch (error) { console.error(JSON.stringify({ ownerCalls, workerCalls, independentStarted, errors })); throw error; }
  finally { release(); await writeFile(join(home, "release-route"), "cleanup"); await host.close(); globalThis.fetch = previous; await rm(root, { recursive: true, force: true }); }
});
