import test from "node:test";
import assert from "node:assert/strict";
import { routeFixture } from "./fixtures/task-route-fixture.js";

const candidate = {
  title: "逐段读取", approach: "在读取接口分段处理，不保留整个文件", assumptions: ["各段可独立处理"],
  basis: "当前文件读取路径允许指定偏移", evidenceIds: [], failureConditions: ["输出依赖整份文件状态"],
  probe: "检查跨段边界的结果", expectedCost: "一次边界检查", remainingWork: ["实现有界读取"], dependencies: "先确认接口允许分段",
};


test("task routes retain candidate objections, require fresh independent evidence, and survive restart", async () => {
  const f = await routeFixture();
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
  const f = await routeFixture();
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
  const f = await routeFixture();
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

test("new user input must be acknowledged and can extend a stopped exploration without resetting its history", async () => {
  const f = await routeFixture();
  try {
    await f.act({ action: "begin", question: "有界探索", independentCheck: false, budget: { candidates: 1, checks: 1, rounds: 1 } });
    const proposed = (await f.act({ action: "propose", candidate })).context.route.candidates[0]!;
    await f.act({ action: "check", candidateId: proposed.id, outcome: "ready", summary: "已核对前提", findings: [], evidenceIds: [await f.evidence(f.owner, f.ownerRun)] });
    const firstInput = f.store.latestRouteInput(f.task.id)!.id;
    const next = await f.store.queueCollaborationMessage({ requestId: "new-user", taskId: f.task.id, sourceSessionId: f.owner.sessionId, targetAgentRunId: f.owner.id, author: "user", text: "先告诉我进度，路线暂时不变" });
    assert.equal(f.store.taskRouteContext(f.task.id)!.inputCurrent, false);
    await assert.rejects(f.act({ action: "adopt", candidateId: proposed.id, reason: "用旧要求继续" }), /用户新输入/);
    await assert.rejects(f.act({ action: "acknowledge", inputId: firstInput, impact: "unchanged", reason: "旧输入" }), /用户输入已更新/);
    await f.act({ action: "acknowledge", inputId: next.message.originRawInputId, impact: "unchanged", reason: "用户只查询进度，约束保持有效" });
    await f.act({ action: "adopt", candidateId: proposed.id, reason: "已核对新输入" });
    assert.equal(f.store.taskRouteContext(f.task.id)!.route.candidates.length, 1);
    await f.act({ action: "stop", reason: "达到本轮探索上限" });
    await assert.rejects(f.act({ action: "extend", inputId: firstInput, budget: { candidates: 2, checks: 2, rounds: 2 }, reason: "重复用旧输入" }), /用户新输入/);
    const decision = await f.store.queueCollaborationMessage({ requestId: "continue-user", taskId: f.task.id, sourceSessionId: f.owner.sessionId, targetAgentRunId: f.owner.id, author: "user", text: "再用一轮和一个候选继续验证" });
    await f.act({ action: "extend", inputId: decision.message.originRawInputId, budget: { candidates: 2, checks: 2, rounds: 2 }, reason: "依据本次明确继续要求增加一次有界验证" });
    const reopened = await f.act({ action: "reopen", reason: "检验剩余假设" });
    assert.equal(reopened.context.route.candidates.length, 1); assert.equal(reopened.context.route.checks.length, 1); assert.equal(reopened.context.route.round, 2);
    assert.equal(reopened.context.route.budgetInputId, decision.message.originRawInputId);
    await f.act({ action: "stop", reason: "第二轮仍无足够依据" });
    await assert.rejects(f.act({ action: "extend", inputId: decision.message.originRawInputId, budget: { candidates: 3, checks: 3, rounds: 3 }, reason: "同一个授权反复增加" }), /用户新输入/);
  } finally { await f.close(); }
});

test("repeated failed checks require a method change instead of new ids for the same evidence", async () => {
  const f = await routeFixture();
  try {
    await f.act({ action: "begin", question: "避免无效重复", independentCheck: false, budget: { candidates: 4, checks: 4, rounds: 2 } });
    const id = (await f.act({ action: "propose", candidate })).context.route.candidates[0]!.id;
    for (let i = 0; i < 2; i++) await f.act({ action: "check", candidateId: id, outcome: "revise", findings: ["同一个边界仍未解决"], summary: "重复核查没有新事实", evidenceIds: [await f.evidence(f.owner, f.ownerRun)] });
    await assert.rejects(f.act({ action: "propose", candidate: { ...candidate, title: "换个标题再试" } }), /连续两次/);
    await f.act({ action: "propose", candidate: { ...candidate, derivedFrom: id, approach: "先隔离边界状态再验证" }, strategyChange: "从完整读取改为专门核查跨段状态" });
    assert.equal(f.store.taskRouteContext(f.task.id)!.route.candidates.length, 2);
  } finally { await f.close(); }
});

test("a successful observation submitted as an unresolved finding returns a repairable error without consuming the check budget", async () => {
  const f = await routeFixture();
  try {
    await f.act({ action: "begin", question: "核查可实施依据", independentCheck: false, budget: { candidates: 1, checks: 1, rounds: 1 } });
    const id = (await f.act({ action: "propose", candidate })).context.route.candidates[0]!.id;
    const evidenceIds = [await f.evidence(f.owner, f.ownerRun)];
    await assert.rejects(f.act({ action: "check", candidateId: id, outcome: "ready", findings: ["边界检查通过"], summary: "可以实施", evidenceIds }), /findings 必须为 \[\].*移入 summary/);
    assert.equal(f.store.taskRouteContext(f.task.id)!.route.checks.length, 0);
    await f.act({ action: "check", candidateId: id, outcome: "ready", findings: [], summary: "边界检查通过", evidenceIds });
    assert.equal((await f.act({ action: "adopt", candidateId: id, reason: "证据充分且没有未决问题" })).context.route.status, "ready");
  } finally { await f.close(); }
});

test("an unknown check can be completed by new evidence on the same candidate while historical uncertainty remains visible", async () => {
  const f = await routeFixture();
  try {
    await f.act({ action: "begin", question: "补齐运行证据", independentCheck: false, budget: { candidates: 1, checks: 4, rounds: 1 } });
    const id = (await f.act({ action: "propose", candidate })).context.route.candidates[0]!.id;
    const old = await f.evidence(f.owner, f.ownerRun);
    await f.act({ action: "check", candidateId: id, outcome: "unknown", findings: ["尚无运行证据"], summary: "只完成了静态读取", evidenceIds: [old] });
    await assert.rejects(f.act({ action: "adopt", candidateId: id, reason: "仍然未知" }), /检查尚未/);
    await assert.rejects(f.act({ action: "check", candidateId: id, outcome: "ready", findings: [], summary: "重复使用旧证据", evidenceIds: [old] }), /未知检查之后/);
    await f.act({ action: "check", candidateId: id, outcome: "ready", findings: [], summary: "已实际运行并补齐前次缺证据的结论", evidenceIds: [await f.evidence(f.owner, f.ownerRun)] });
    const result = await f.act({ action: "adopt", candidateId: id, reason: "同一方案的新运行证据已补齐未知项" });
    assert.equal(result.context.route.status, "ready"); assert.equal(result.context.route.candidates.length, 1);
    assert.deepEqual(result.context.route.checks.map(check => check.outcome), ["unknown", "ready"]);
  } finally { await f.close(); }
});
