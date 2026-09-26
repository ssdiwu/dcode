import test from "node:test";
import assert from "node:assert/strict";
import { routeFixture } from "./fixtures/task-route-fixture.js";

const candidate = { title: "分段分析", approach: "先读取，再汇总", assumptions: [], basis: "有界验证材料", evidenceIds: [], failureConditions: ["前段结果无效"], probe: "读取检查", expectedCost: "两项工作", remainingWork: ["读取", "汇总"], dependencies: "汇总依赖读取" };

test("continuing a stopped or failed agent reflects the new running execution and rejects a second concurrent start", async () => {
  const f = await routeFixture(); let run = f.ownerRun;
  try {
    for (const outcome of ["aborted", "failed", "unknown"] as const) {
      await f.store.finishSessionRun({ sessionRunId: run.sessionRunId, providerAttemptId: run.providerAttemptId, outcome });
      run = await f.start(f.owner);
      assert.equal((await f.store.snapshot()).agentRuns.find(item => item.id === f.owner.id)!.status, "running");
      await assert.rejects(f.start(f.owner), /cannot start another Session Run/);
    }
  } finally { await f.close(); }
});

test("a coordinator can cancel an unassigned leaf while assigned work and unfinished dependents retain their gates", async () => {
  const f = await routeFixture();
  try {
    await f.act({ action: "begin", question: "按证据安排工作", independentCheck: false, budget: { candidates: 1, checks: 1, rounds: 1 } });
    const id = (await f.act({ action: "propose", candidate })).context.route.candidates[0]!.id;
    await f.act({ action: "check", candidateId: id, outcome: "ready", summary: "已核对", findings: [], evidenceIds: [await f.evidence(f.owner, f.ownerRun)] });
    await f.act({ action: "adopt", candidateId: id, reason: "可以分工" });
    const a = (await f.act({ action: "work", title: "实际实施", completion: "交付实现", dependsOn: [] })).workItem!;
    const b = (await f.act({ action: "work", title: "重复安排", completion: "另有实际验收工作覆盖", dependsOn: [a.id] })).workItem!;
    await assert.rejects(f.act({ action: "cancel_work", workItemId: a.id, reason: "仍有下游" }), /下游依赖/);
    const cancelled = await f.act({ action: "cancel_work", workItemId: b.id, reason: "未派发的重复安排由实际验收覆盖" });
    assert.equal(cancelled.workItem?.state, "cancelled"); assert.equal(cancelled.context.route.status, "ready");
    assert.equal(cancelled.context.route.history.at(-1)?.workItemId, b.id);
    await assert.rejects(f.act({ action: "work", title: "不能依赖已取消安排", completion: "无效", dependsOn: [b.id] }), /有效工作项/);
    await f.store.createTeamRun({ requestId: "assigned", taskId: f.task.id, scope: f.scope, coordinatorAgentRunId: f.owner.id, members: [{ profileId: "builtin-worker", title: "执行", taskPacket: { route: { purpose: "execute", workItemId: a.id } } }] });
    await assert.rejects(f.act({ action: "cancel_work", workItemId: a.id, reason: "不能跳过验收" }), /已派发/);
  } finally { await f.close(); }
});

test("route-bound delegation enforces readiness and dependencies; invalidation cancels affected work without erasing independent results", async () => {
  const f = await routeFixture(); let serial = 0;
  const delegate = (route: unknown, title = "成员") => f.store.createTeamRun({ requestId: `delegate-${++serial}`, taskId: f.task.id, scope: f.scope, coordinatorAgentRunId: f.owner.id,
    members: [{ profileId: "builtin-explore", title, taskPacket: { instruction: title, ...(route ? { route } : {}) } }] });
  try {
    await f.act({ action: "begin", question: "读取与汇总路线", independentCheck: false, budget: { candidates: 4, checks: 4, rounds: 3 } });
    await assert.rejects(delegate(undefined), /声明派发/);
    await assert.rejects(f.act({ action: "work", title: "未成熟的执行", completion: "输出", dependsOn: [] }), /成熟路线/);
    const proposed = await f.act({ action: "propose", candidate }); const routeId = proposed.context.route.candidates[0]!.id;
    await f.act({ action: "check", candidateId: routeId, outcome: "ready", summary: "实际检查了前提", findings: [], evidenceIds: [await f.evidence(f.owner, f.ownerRun)] });
    await f.act({ action: "adopt", candidateId: routeId, reason: "前提可核对，依赖清楚" });
    await assert.rejects(delegate({ purpose: "explore" }), /阶段不允许/);
    const a = (await f.act({ action: "work", title: "读取", completion: "返回读取事实", dependsOn: [] })).workItem!;
    const b = (await f.act({ action: "work", title: "汇总", completion: "对照读取事实", dependsOn: [a.id] })).workItem!;
    await assert.rejects(delegate({ purpose: "execute", workItemId: b.id }), /前置依赖/);
    const independent = (await delegate({ purpose: "independent", reason: "核对用户另行提出的文档，与读取路线无依赖" }, "独立工作")).childAgentRuns[0]!;
    const ir = await f.start(independent); await f.store.finishSessionRun({ sessionRunId: ir.sessionRunId, providerAttemptId: ir.providerAttemptId, outcome: "succeeded", assistantText: "独立材料已核对" });
    const reader = (await delegate({ purpose: "execute", workItemId: a.id })).childAgentRuns[0]!;
    await assert.rejects(delegate({ purpose: "execute", workItemId: a.id }), /活动成员/);
    const ar = await f.start(reader); await f.store.finishSessionRun({ sessionRunId: ar.sessionRunId, providerAttemptId: ar.providerAttemptId, outcome: "succeeded", assistantText: "读取完成" });
    const writer = (await delegate({ purpose: "execute", workItemId: b.id })).childAgentRuns[0]!;
    const br = await f.start(writer);
    const invalid = await f.act({ action: "invalidate", reason: "发现读取接口前提不成立", evidenceIds: [] });
    assert.ok(invalid.affectedAgentRunIds.includes(reader.id)); assert.ok(invalid.affectedAgentRunIds.includes(writer.id));
    assert.ok(!invalid.affectedAgentRunIds.includes(independent.id));
    await assert.rejects(f.store.prepareToolAttempt({ taskId: f.task.id, sessionId: writer.sessionId, sessionRunId: br.sessionRunId, toolCallId: "stale-write", toolName: "write", parameterDigest: `sha256:${"b".repeat(64)}` }), /路线已经改变/);
    await f.store.finishSessionRun({ sessionRunId: br.sessionRunId, providerAttemptId: br.providerAttemptId, outcome: "succeeded", assistantText: "迟到的旧路线报告" });
    let snapshot = await f.store.snapshot();
    assert.equal(snapshot.taskWorkItems.find(item => item.id === a.id)!.state, "cancelled");
    assert.equal(snapshot.taskWorkItems.find(item => item.id === b.id)!.state, "cancelled");
    const independentAssignment = snapshot.agentAssignments.find(item => item.agentRunId === independent.id)!;
    assert.equal(snapshot.taskWorkItems.find(item => item.ownerAssignmentId === independentAssignment.id)!.state, "completed");
    assert.ok(snapshot.agentReports.some(report => report.agentRunId === writer.id));
    await f.act({ action: "reopen", reason: "保留已获事实，改查不同接口" });
    await assert.rejects(f.start(writer), /路线已经改变/);
    snapshot = await f.store.snapshot();
    await assert.rejects(f.store.updateTaskWorkItem({ requestId: "erase-dependency", expectedStoreRevision: snapshot.storeRevision, taskId: f.task.id, scope: f.scope, workItemId: b.id, expectedWorkItemRevision: snapshot.taskWorkItems.find(item => item.id === b.id)!.revision, state: "completed", details: {} }), /路线工作项/);
    const oldReport = snapshot.agentReports.filter(report => report.agentRunId === writer.id).at(-1)!;
    const continuation = { requestId: "continue-writer", taskId: f.task.id, coordinatorAgentRunId: f.owner.id, agentRunId: writer.id,
      instruction: "解释已保存的失败原因", acceptance: "说明事实来源", route: { purpose: "independent" as const, reason: "解释已有结果不依赖新探索路线" }, sourceSessionId: f.owner.sessionId, originRawInputId: f.store.latestRouteInput(f.task.id)!.id };
    const reused = await f.store.continueRouteMember(continuation);
    assert.deepEqual(await f.store.continueRouteMember(continuation), reused);
    await assert.rejects(f.store.prepareToolAttempt({ taskId: f.task.id, sessionId: writer.sessionId, sessionRunId: br.sessionRunId, toolCallId: "old-run-after-reassignment", toolName: "write", parameterDigest: `sha256:${"a".repeat(64)}` }), /过期工具/);
    const verifier = (await f.store.createTeamRun({ requestId: "new-verifier", taskId: f.task.id, scope: f.scope, coordinatorAgentRunId: f.owner.id, members: [{ profileId: "builtin-verifier", title: "核查说明", taskPacket: { route: { purpose: "independent", reason: "核查已保存事实" } } }] })).childAgentRuns[0]!;
    await assert.rejects(f.store.submitVerification({ requestId: "verify-old-work", taskId: f.task.id, verifierAgentRunId: verifier.id, subjectReportId: oldReport.id, verdict: "fail", evidenceIds: [], findings: [{ kind: "product", description: "旧报告" }], summary: "不能用于新工作" }), /之前的工作指派/);
    const followup = await f.start(writer);
    await assert.rejects(f.store.continueRouteMember({ ...continuation, requestId: "hot-rebind" }), /仍在执行/);
    await f.store.finishSessionRun({ sessionRunId: followup.sessionRunId, providerAttemptId: followup.providerAttemptId, outcome: "succeeded", assistantText: "失败原因已说明" });
    snapshot = await f.store.snapshot();
    assert.equal(snapshot.taskWorkItems.find(item => item.id === a.id)!.state, "cancelled");
    assert.equal(snapshot.taskWorkItems.find(item => item.id === b.id)!.state, "cancelled");
    assert.equal(snapshot.taskWorkItems.find(item => item.id === reused.workItemId)!.state, "completed");
    assert.equal(snapshot.agentRuns.find(item => item.id === writer.id)!.sessionId, writer.sessionId);
    assert.deepEqual(snapshot.agentReports.find(report => report.id === oldReport.id), oldReport);
    assert.equal((snapshot.agentReports.filter(report => report.agentRunId === writer.id).at(-1)!.body as any).workAssignment.workItemId, reused.workItemId);
  } finally { await f.close(); }
});

test("upstream rework blocks only its dependents and requires fresh downstream verification", async () => {
  const f = await routeFixture(); let serial = 0;
  const delegate = async (workItemId: string, purpose: "execute" | "review") => (await f.store.createTeamRun({ requestId: `member-${++serial}`, taskId: f.task.id, scope: f.scope, coordinatorAgentRunId: f.owner.id,
    members: [{ profileId: purpose === "review" ? "builtin-verifier" : "builtin-explore", title: `${purpose}-${serial}`, taskPacket: { route: { purpose, workItemId } } }] })).childAgentRuns[0]!;
  const finish = async (agent: Parameters<typeof f.start>[0]) => {
    const run = await f.start(agent); await f.store.finishSessionRun({ sessionRunId: run.sessionRunId, providerAttemptId: run.providerAttemptId, outcome: "succeeded", assistantText: `完成事实 ${++serial}` });
    return (await f.store.snapshot()).agentReports.filter(report => report.agentRunId === agent.id).at(-1)!;
  };
  try {
    await f.act({ action: "begin", question: "核对依赖", independentCheck: false, budget: { candidates: 3, checks: 3, rounds: 2 } });
    const routeId = (await f.act({ action: "propose", candidate })).context.route.candidates[0]!.id;
    await f.act({ action: "check", candidateId: routeId, outcome: "ready", summary: "已检查", findings: [], evidenceIds: [await f.evidence(f.owner, f.ownerRun)] });
    await f.act({ action: "adopt", candidateId: routeId, reason: "可实施" });
    const a = (await f.act({ action: "work", title: "上游", completion: "返回事实", dependsOn: [] })).workItem!;
    const b = (await f.act({ action: "work", title: "下游", completion: "核对上游事实", dependsOn: [a.id] })).workItem!;
    const unrelated = (await f.act({ action: "work", title: "同路线的独立工作", completion: "独立完成", dependsOn: [] })).workItem!;
    const authorA = await delegate(a.id, "execute"), reportA = await finish(authorA);
    const authorB = await delegate(b.id, "execute"), reportB = await finish(authorB);
    const authorU = await delegate(unrelated.id, "execute"); await finish(authorU);
    const verifierB = await delegate(b.id, "review"), vb = await f.start(verifierB);
    const oldB = await f.store.submitVerification({ requestId: "old-b-check", taskId: f.task.id, verifierAgentRunId: verifierB.id, subjectReportId: reportB.id,
      verdict: "pass", evidenceIds: [await f.evidence(verifierB, vb)], findings: [], summary: "依原上游检查通过" });
    await f.store.finishSessionRun({ sessionRunId: vb.sessionRunId, providerAttemptId: vb.providerAttemptId, outcome: "succeeded", assistantText: "先前检查" });
    const verifierA = await delegate(a.id, "review"), va = await f.start(verifierA);
    const failedA = await f.store.submitVerification({ requestId: "failed-a", taskId: f.task.id, verifierAgentRunId: verifierA.id, subjectReportId: reportA.id,
      verdict: "fail", evidenceIds: [await f.evidence(verifierA, va)], findings: [{ kind: "product", description: "上游输入遗漏" }], summary: "需要补齐输入" });
    const rework = await f.store.reviewVerification({ requestId: "rework-a", taskId: f.task.id, coordinatorAgentRunId: f.owner.id, verificationId: failedA.verification.id, outcome: "rework", reason: "上游遗漏影响下游" });
    assert.ok(rework.affectedAgentRunIds.includes(authorB.id)); assert.ok(rework.affectedAgentRunIds.includes(verifierB.id));
    assert.ok(!rework.affectedAgentRunIds.includes(authorU.id));
    assert.throws(() => f.store.assertAgentRouteCurrent(authorB.id), /依赖/);
    await finish(authorA);
    await assert.rejects(f.store.reviewVerification({ requestId: "stale-b-accept", taskId: f.task.id, coordinatorAgentRunId: f.owner.id, verificationId: oldB.verification.id, outcome: "accepted", reason: "误用旧检查" }), /上游已返工/);
    const freshRun = await f.start(verifierB);
    const freshB = await f.store.submitVerification({ requestId: "fresh-b", taskId: f.task.id, verifierAgentRunId: verifierB.id, subjectReportId: reportB.id,
      verdict: "pass", evidenceIds: [await f.evidence(verifierB, freshRun)], findings: [], summary: "对照更新后上游重新核对" });
    await f.store.reviewVerification({ requestId: "fresh-b-accept", taskId: f.task.id, coordinatorAgentRunId: f.owner.id, verificationId: freshB.verification.id, outcome: "accepted", reason: "新证据覆盖依赖变化" });
    const snapshot = await f.store.snapshot();
    assert.equal(snapshot.taskWorkItems.find(item => item.id === b.id)!.state, "completed");
    assert.equal(snapshot.taskWorkItems.find(item => item.id === unrelated.id)!.state, "completed");
  } finally { await f.close(); }
});
