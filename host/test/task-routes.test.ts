import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProductStore, type AgentRunRecord } from "../src/product-store.js";
import type { RouteOperation } from "../src/task-routes.js";

const candidate = {
  title: "逐段读取", approach: "在读取接口分段处理，不保留整个文件", assumptions: ["各段可独立处理"],
  basis: "当前文件读取路径允许指定偏移", evidenceIds: [], failureConditions: ["输出依赖整份文件状态"],
  probe: "检查跨段边界的结果", expectedCost: "一次边界检查", remainingWork: ["实现有界读取"], dependencies: "先确认接口允许分段",
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dcode-task-routes-")), home = join(root, "home");
  await mkdir(home);
  const options = { dataRoot: join(root, ".dcode"), userHome: home };
  let store = await ProductStore.open(options), serial = 0;
  const initial = await store.snapshot(), scope = { kind: "user" as const, userId: initial.currentUser.id };
  const { task } = await store.createTask({ requestId: "task", expectedStoreRevision: initial.storeRevision, scope, title: "路线验证", goal: "降低内存并保持输出" });
  const { agentRun: owner } = await store.ensureCoordinatorAgentRun({ requestId: "owner", taskId: task.id, scope });
  const team = await store.createTeamRun({ requestId: "team", taskId: task.id, scope, coordinatorAgentRunId: owner.id,
    members: [{ profileId: "builtin-explore", title: "独立检查", taskPacket: {} }] });
  const reviewer = team.childAgentRuns[0]!;
  async function start(agent: AgentRunRecord) {
    const prepared = await store.prepareSessionRun({ requestId: `start-${++serial}`, taskId: task.id, scope, sessionId: agent.sessionId,
      runtimeId: `runtime-${agent.id}`, agentRunId: agent.id, workspaceId: `workspace-${agent.id}`, cwd: home, workspaceAccess: "sharedReadOnly",
      message: "核查当前路线", attachmentRefs: [], roleRevision: "route-test:v1", contextRevision: 1, profileSnapshot: { role: agent.role },
      tools: [{ name: "read", description: "Read fixture", parameters: { type: "object" } }], toolsWritable: false,
      systemPromptDigest: `sha256:${"f".repeat(64)}`, promptSources: [] });
    await store.startSessionRun(prepared.sessionRunId); return prepared;
  }
  const ownerRun = await start(owner), reviewerRun = await start(reviewer);
  const act = (operation: RouteOperation, actor = owner, run = ownerRun, expectedPlanRevision = store.taskRouteContext(task.id)?.planRevision ?? 0, requestId = `route-${++serial}`) =>
    store.updateTaskRoute({ requestId, taskId: task.id, agentRunId: actor.id, sessionRunId: run.sessionRunId, expectedPlanRevision, operation });
  async function evidence(agent = reviewer, run = reviewerRun, toolName = "read", outcome: "succeeded" | "failed" = "succeeded") {
    const attempt = await store.prepareToolAttempt({ taskId: task.id, sessionId: agent.sessionId, sessionRunId: run.sessionRunId, toolCallId: `read-${++serial}`, toolName, parameterDigest: `sha256:${"1".repeat(64)}` });
    await store.finishOperationAttempt({ attemptId: attempt.attemptId, outcome, resultDigest: `sha256:${"2".repeat(64)}` });
    return (await store.recordToolEvidence({ requestId: `evidence-${++serial}`, attemptId: attempt.attemptId, toolName, outcome, resultDigest: `sha256:${"2".repeat(64)}` })).evidence.id;
  }
  return { get store() { return store; }, task, scope, owner, ownerRun, reviewer, reviewerRun, act, evidence,
    async reopenStore() { await store.close(); store = await ProductStore.open(options); },
    async close() { await store.close(); await rm(root, { recursive: true, force: true }); } };
}

test("task routes retain candidate objections, require fresh independent evidence, and survive restart", async () => {
  const f = await fixture();
  try {
    await f.act({ action: "begin", question: "文件读取能否逐段完成", budget: { candidates: 4, checks: 4, rounds: 2 }, independentCheck: true });
    const oldEvidence = await f.evidence();
    const proposed = await f.act({ action: "propose", candidate });
    const first = proposed.context.route.candidates[0]!;
    await assert.rejects(f.act({ action: "adopt", candidateId: first.id, reason: "应该能用" }), /检查尚未/);
    const check = { action: "check" as const, candidateId: first.id, outcome: "ready" as const, findings: [], summary: "检查完成", evidenceIds: [oldEvidence] };
    await assert.rejects(f.act(check), /不同于候选/);
    await assert.rejects(f.act(check, f.reviewer, f.reviewerRun), /早于候选/);
    await assert.rejects(f.act({ ...check, evidenceIds: [await f.evidence(f.owner, f.ownerRun)] }, f.reviewer, f.reviewerRun), /本人实际核查/);
    await assert.rejects(f.act({ ...check, evidenceIds: [await f.evidence(f.reviewer, f.reviewerRun, "dcode_route")] }, f.reviewer, f.reviewerRun), /本人实际核查/);
    await assert.rejects(f.act({ ...check, evidenceIds: [await f.evidence(f.reviewer, f.reviewerRun, "read", "failed")] }, f.reviewer, f.reviewerRun), /失败或未知/);
    const proof = await f.evidence();
    await f.act({ ...check, outcome: "reject", findings: ["跨段编码会丢失字符"], evidenceIds: [proof] }, f.reviewer, f.reviewerRun);
    await f.act({ ...check, evidenceIds: [proof] }, f.reviewer, f.reviewerRun);
    await assert.rejects(f.act({ action: "adopt", candidateId: first.id, reason: "多数检查支持" }), /未决异议/);
    const repaired = await f.act({ action: "propose", candidate: { ...candidate, title: "保留解码状态的分段读取", approach: "跨段保留解码器状态", derivedFrom: first.id } });
    const second = repaired.context.route.candidates[1]!;
    await f.act({ ...check, candidateId: second.id, evidenceIds: [await f.evidence()] }, f.reviewer, f.reviewerRun);
    const adopted = await f.act({ action: "adopt", candidateId: second.id, reason: "边界检查成立，剩余实现可单独验收" });
    assert.equal(adopted.context.route.status, "ready");
    assert.equal((await f.store.snapshot()).tasks[0]!.state, "active");
    const before = f.store.taskRouteContext(f.task.id);
    await f.reopenStore();
    assert.deepEqual(f.store.taskRouteContext(f.task.id), before);
    assert.equal(before!.route.checks[0]!.findings[0], "跨段编码会丢失字符");
  } finally { await f.close(); }
});

test("route mutation is scoped, idempotent, revision checked, and cannot reset budget through a generic Plan", async () => {
  const f = await fixture();
  try {
    const begin = { action: "begin" as const, question: "选择路线", budget: { candidates: 2, checks: 2, rounds: 1 }, independentCheck: true };
    await assert.rejects(f.act(begin, f.reviewer, f.reviewerRun), /只有协调者/);
    const first = await f.act(begin, f.owner, f.ownerRun, 0, "begin-once");
    const replay = await f.act(begin, f.owner, f.ownerRun, 0, "begin-once");
    assert.deepEqual(replay, first);
    await assert.rejects(f.act({ action: "propose", candidate }, f.owner, f.ownerRun, 0), /新版本/);
    await assert.rejects(f.act(begin), /清空记录/);
    const snap = await f.store.snapshot();
    await assert.rejects(f.store.createTaskPlan({ requestId: "reset", expectedStoreRevision: snap.storeRevision, taskId: f.task.id, scope: f.scope, document: {} }), /保留已有路线/);
    await assert.rejects(f.store.updateTaskPlan({ requestId: "erase", expectedStoreRevision: snap.storeRevision, taskId: f.task.id, scope: f.scope,
      planId: first.context.planId, expectedPlanRevision: first.context.planRevision, state: "active", document: {} }), /路线记录/);
    await f.act({ action: "propose", candidate });
    await f.act({ action: "propose", candidate: { ...candidate, title: "另一条路线" } });
    await assert.rejects(f.act({ action: "propose", candidate }), /投入已达上限/);
    await f.act({ action: "stop", reason: "目前证据不足，达到本轮投入边界" });
    await assert.rejects(f.act({ action: "reopen", reason: "换个名字再试" }), /累计探索投入/);
    assert.equal(f.store.taskRouteContext(f.task.id)!.route.candidates.length, 2);
    await assert.rejects(f.store.updateTaskRoute({ requestId: "spoof", taskId: "another-task", agentRunId: f.owner.id, sessionRunId: f.ownerRun.sessionRunId, expectedPlanRevision: 0, operation: begin }), /当前任务/);
    await assert.rejects(f.act({ action: "propose", candidate: { ...candidate, title: " " } }), /必要内容/);
  } finally { await f.close(); }
});

test("small exploration can check its own tools, while changed context and reopened rounds cannot reuse an old decision", async () => {
  const f = await fixture();
  try {
    await f.act({ action: "begin", question: "验证一条可逆路线", independentCheck: false, budget: { candidates: 3, checks: 3, rounds: 2 } });
    const first = (await f.act({ action: "propose", candidate })).context.route.candidates[0]!;
    await f.act({ action: "check", candidateId: first.id, outcome: "ready", findings: [], summary: "实际工具验证了主要前提", evidenceIds: [await f.evidence(f.owner, f.ownerRun)] });
    await f.act({ action: "adopt", candidateId: first.id, reason: "小范围且可逆，证据已齐" });
    const snapshot = await f.store.snapshot();
    await f.store.replaceTaskContext({ requestId: "new-context", taskId: f.task.id, scope: f.scope, expectedStoreRevision: snapshot.storeRevision,
      expectedContextRevision: snapshot.taskContextSets.find(item => item.taskId === f.task.id)!.revision, sources: [] });
    assert.equal(f.store.taskRouteContext(f.task.id)!.contextCurrent, false);
    assert.equal((await f.store.snapshot()).taskPlans[0]!.routeContextCurrent, false);
    await f.act({ action: "invalidate", reason: "上下文已变，原依据需重新核对", evidenceIds: [] });
    const reopened = await f.act({ action: "reopen", reason: "在新上下文中验证剩余疑点" });
    assert.equal(reopened.context.route.candidates.length, 1);
    assert.equal(reopened.context.route.checks.length, 1);
    assert.equal(reopened.context.route.round, 2);
    await assert.rejects(f.act({ action: "adopt", candidateId: first.id, reason: "沿用旧结果" }), /当前探索轮次/);
  } finally { await f.close(); }
});
