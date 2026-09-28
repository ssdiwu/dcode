import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProductStore, ProductStoreError } from "../src/product-store.js";
import { validateMethodParams } from "../src/protocol.js";

test("a Task continues in a new coordination Session while its former Session stays readable", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-task-continuation-"));
  const home = join(root, "home");
  await mkdir(home);
  const store = await ProductStore.open({ dataRoot: join(root, ".dcode"), userHome: home });
  try {
    const initial = await store.snapshot();
    const created = await store.createTask({
      requestId: "create-continuation-task",
      expectedStoreRevision: initial.storeRevision,
      scope: { kind: "user", userId: initial.currentUser.id },
      title: "续接任务",
      goal: "保留先前工作并继续",
    });
    const input = { requestId: "continue-once", expectedStoreRevision: created.storeRevision, taskId: created.task.id };
    validateMethodParams("task.session.continue", input);
    const continued = await store.continueTaskSession(input);
    const snapshot = await store.snapshot();
    assert.equal(snapshot.tasks.length, 1);
    assert.equal(continued.task.id, created.task.id);
    assert.equal(continued.previousSessionId, created.coordinationSession.id);
    assert.equal(snapshot.sessions.find(item => item.id === created.coordinationSession.id)?.kind, "standard");
    assert.equal(snapshot.sessions.find(item => item.id === created.coordinationSession.id)?.state, "completed");
    assert.equal(snapshot.sessions.filter(item => item.taskId === created.task.id && item.kind === "coordination").length, 1);
    assert.equal(snapshot.coordinatorAssignments[0]?.sessionId, continued.coordinationSession.id);
    assert.equal(snapshot.sessionPaths.find(item => item.sessionId === continued.coordinationSession.id)?.isCurrent, true);
    assert.equal(snapshot.sessionProvenance.find(item => item.sessionId === continued.coordinationSession.id)?.sourceSessionId, created.coordinationSession.id);
    assert.deepEqual(await store.continueTaskSession(input), continued);
    await assert.rejects(store.continueTaskSession({ ...input, requestId: "stale-continuation" }),
      (error: unknown) => error instanceof ProductStoreError && error.code === "REVISION_CONFLICT");
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a Task summary keeps sourced revisions and a user correction across the next continuation", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-task-summary-"));
  const home = join(root, "home");
  await mkdir(home);
  const store = await ProductStore.open({ dataRoot: join(root, ".dcode"), userHome: home });
  try {
    const initial = await store.snapshot();
    const created = await store.createTask({
      requestId: "create-summary-task", expectedStoreRevision: initial.storeRevision,
      scope: { kind: "user", userId: initial.currentUser.id },
      title: "摘要任务", goal: "持续核对来源",
    });
    const generated = await store.prepareTaskSummary({ requestId: "summary-initial", taskId: created.task.id, trigger: "new_session" });
    assert.equal(generated.summary.sections.confirmed[0]?.sources[0]?.id, created.task.id);
    const correctedSections = { confirmed: [generated.summary.sections.confirmed[0]!.text, "用户确认先核对原始材料"], pending: ["补全证据"], blocked: [], next: ["再次检查来源"] };
    validateMethodParams("task.summary.correct", {
      requestId: "correct-summary", expectedStoreRevision: generated.storeRevision,
      taskId: created.task.id, expectedRevision: generated.summary.revision, sections: correctedSections,
    });
    const corrected = await store.correctTaskSummary({
      requestId: "correct-summary", taskId: created.task.id,
      expectedRevision: generated.summary.revision, sections: correctedSections,
    });
    assert.equal(corrected.summary.sections.confirmed[0]?.sources[0]?.kind, "task");
    assert.equal(corrected.summary.sections.confirmed[1]?.sources[1]?.kind, "user_correction");
    const next = await store.prepareTaskSummary({ requestId: "summary-next", taskId: created.task.id, trigger: "compaction" });
    assert.equal(next.summary.sections.confirmed[1]?.text, "用户确认先核对原始材料");
    assert.equal(next.summary.previousRevision, corrected.summary.revision);
    const history = store.taskSummaryHistory(created.task.id);
    assert.equal(history.length, 3);
    assert.equal(history[0]?.sections.confirmed[0]?.text, generated.summary.sections.confirmed[0]?.text);
    assert.equal(history[1]?.sections.confirmed[1]?.text, "用户确认先核对原始材料");
    assert.equal((await store.snapshot()).taskSummaries[0]?.revision, 3);
    await assert.rejects(store.correctTaskSummary({
      requestId: "stale-correction", taskId: created.task.id,
      expectedRevision: generated.summary.revision, sections: correctedSections,
    }), (error: unknown) => error instanceof ProductStoreError && error.code === "REVISION_CONFLICT");
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("correcting duplicate summary text never reassigns a surviving claim to the wrong Work Item", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-summary-duplicate-")), home = join(root, "home"); await mkdir(home);
  const store = await ProductStore.open({ dataRoot: join(root, ".dcode"), userHome: home });
  try {
    const initial = await store.snapshot(), scope = { kind: "user" as const, userId: initial.currentUser.id };
    const task = await store.createTask({ requestId: "duplicate-task", expectedStoreRevision: initial.storeRevision, scope, title: "重复标题", goal: "核对来源" });
    for (let index = 0; index < 2; index++) await store.createTaskWorkItem({ requestId: `duplicate-work-${index}`, expectedStoreRevision: (await store.snapshot()).storeRevision, taskId: task.task.id, scope, title: "修复检查" });
    const summary = (await store.prepareTaskSummary({ requestId: "duplicate-summary", taskId: task.task.id, trigger: "new_session" })).summary;
    assert.equal(summary.sections.pending.filter(item => item.text === "待处理：修复检查").length, 2);
    assert.notEqual(summary.sections.pending[0]?.sources[0]?.id, summary.sections.pending[1]?.sources[0]?.id);
    const corrected = (await store.correctTaskSummary({ requestId: "duplicate-correction", taskId: task.task.id, expectedRevision: summary.revision,
      sections: { confirmed: summary.sections.confirmed.map(item => item.text), pending: ["待处理：修复检查"], blocked: [], next: summary.sections.next.map(item => item.text) } })).summary;
    assert.equal(corrected.sections.pending[0]?.sources[0]?.kind, "summary_revision");
    assert.equal(corrected.sections.pending[0]?.sources[1]?.kind, "user_correction");
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("a long Task summary keeps an invalidated older decision as historical evidence, not current adoption", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-summary-history-"));
  const home = join(root, "home"); await mkdir(home);
  const store = await ProductStore.open({ dataRoot: join(root, ".dcode"), userHome: home });
  try {
    const initial = await store.snapshot(), scope = { kind: "user" as const, userId: initial.currentUser.id };
    const task = await store.createTask({ requestId: "historical-task", expectedStoreRevision: initial.storeRevision, scope, title: "长期任务", goal: "完成调研" });
    const coordinator = await store.ensureCoordinatorAgentRun({ requestId: "historical-coordinator", taskId: task.task.id, scope });
    for (const [index, message] of ["确认采用方案 A", "方案 A 已失效，改用 B"].entries()) {
      const prepared = await store.prepareSessionRun({ requestId: `historical-run-${index}`, taskId: task.task.id, scope,
        sessionId: task.coordinationSession.id, runtimeId: "historical-runtime", agentRunId: coordinator.agentRun.id,
        workspaceId: "historical-workspace", cwd: home, workspaceAccess: "sharedReadOnly", message,
        attachmentRefs: [], roleRevision: "coordinator:v1", contextRevision: 1, profileSnapshot: { role: "coordinator" },
        tools: [], toolsWritable: false, systemPromptDigest: `sha256:${"f".repeat(64)}`, promptSources: [] });
      await store.startSessionRun(prepared.sessionRunId);
      await store.finishSessionRun({ sessionRunId: prepared.sessionRunId, providerAttemptId: prepared.providerAttemptId, outcome: "succeeded", assistantText: index ? "成员报告：第二段进度已保存" : "已记录方案 A" });
    }
    for (let index = 0; index < 8; index++) await store.createTaskWorkItem({ requestId: `summary-work-${index}`, expectedStoreRevision: (await store.snapshot()).storeRevision, taskId: task.task.id, scope, title: `已完成 ${index + 1}`, state: "completed" });
    const summary = (await store.prepareTaskSummary({ requestId: "historical-summary", taskId: task.task.id, trigger: "new_session" })).summary;
    const decision = summary.sections.blocked.find(item => item.text.includes("确认采用方案 A"));
    assert.equal(decision?.sources[0]?.kind, "raw_input");
    assert.ok(!summary.sections.confirmed.some(item => item.text.includes("确认采用方案 A")));
    assert.ok(summary.sections.pending.some(item => item.text.includes("方案 A 已失效，改用 B")));
    assert.ok(summary.sections.confirmed.some(item => item.text.includes("成员报告：第二段进度已保存")));
    assert.ok(summary.sections.confirmed.some(item => item.text.includes("仅列部分")));
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("recall searches before ranking inside one Task and records only a real read", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-task-recall-"));
  const home = join(root, "home");
  await mkdir(home);
  const store = await ProductStore.open({ dataRoot: join(root, ".dcode"), userHome: home });
  try {
    const initial = await store.snapshot(), scope = { kind: "user" as const, userId: initial.currentUser.id };
    const own = await store.createTask({ requestId: "own-task", expectedStoreRevision: initial.storeRevision, scope, title: "当前", goal: "查找来源" });
    const other = await store.createTask({ requestId: "other-task", expectedStoreRevision: own.storeRevision, scope, title: "另一个", goal: "不可混入" });
    const actor = await store.ensureCoordinatorAgentRun({ requestId: "recall-coordinator", taskId: own.task.id, scope });
    const prepare = async (taskId: string, sessionId: string, message: string, agentRunId?: string) => store.prepareSessionRun({
      requestId: `prepare-${taskId}`, taskId, scope, sessionId, runtimeId: `runtime-${taskId}`,
      ...(agentRunId ? { agentRunId } : {}), workspaceId: `workspace-${taskId}`, cwd: home,
      workspaceAccess: "sharedReadOnly", message, attachmentRefs: [], roleRevision: "coordinator:v1", contextRevision: 1,
      profileSnapshot: { role: "coordinator" }, tools: [], toolsWritable: false,
      systemPromptDigest: `sha256:${"f".repeat(64)}`, promptSources: [],
    });
    const first = await prepare(own.task.id, own.coordinationSession.id, "共同关键词：当前任务的独有原文", actor.agentRun.id);
    await prepare(other.task.id, other.coordinationSession.id, "共同关键词：另一个任务的私有原文");
    const candidates = store.searchTaskEntries(own.task.id, "共同关键词", 12);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.sessionId, own.coordinationSession.id);
    assert.equal((await store.snapshot()).taskSourceUses.length, 0);
    await assert.rejects(async () => store.readTaskEntry(other.task.id, candidates[0]!.entryId), /不属于当前任务/);
    await store.startSessionRun(first.sessionRunId);
    const read = store.readTaskEntry(own.task.id, candidates[0]!.entryId);
    const used = await store.recordTaskSourceUse({ requestId: "record-real-read", taskId: own.task.id,
      sessionRunId: first.sessionRunId, agentRunId: actor.agentRun.id, kind: "task_message", sourceId: read.entryId,
      digest: read.digest, bytes: Buffer.byteLength(read.content) });
    assert.equal(store.taskSourceUse(own.task.id, used.use.id).digest, read.digest);
    assert.equal((await store.snapshot()).taskSourceUses.length, 1);
    assert.deepEqual(store.taskSourceUsesForRun(own.task.id,first.sessionRunId,0,100).items.map(item=>item.id),[used.use.id]);
    await assert.rejects(store.recordTaskSourceUse({ requestId: "record-real-read", taskId: own.task.id,
      sessionRunId: first.sessionRunId, agentRunId: actor.agentRun.id, kind: "task_message", sourceId: read.entryId,
      digest: read.digest, bytes: Buffer.byteLength(read.content) + 1 }), /requestId|different operation|already used/);
    await store.finishSessionRun({ sessionRunId: first.sessionRunId, providerAttemptId: first.providerAttemptId, outcome: "succeeded", assistantText: "已经读取" });
    await store.prepareSessionRun({ requestId: "second-recall-input", taskId: own.task.id, scope, sessionId: own.coordinationSession.id,
      runtimeId: "runtime-second-recall", agentRunId: actor.agentRun.id, workspaceId: "workspace-second-recall", cwd: home,
      workspaceAccess: "sharedReadOnly", message: "共同关键词：当前任务的第二条原文", attachmentRefs: [], roleRevision: "coordinator:v1", contextRevision: 1,
      profileSnapshot: { role: "coordinator" }, tools: [], toolsWritable: false, systemPromptDigest: `sha256:${"f".repeat(64)}`, promptSources: [] });
    const pageOne=store.searchTaskEntriesPage(own.task.id,"共同关键词",1);
    const pageTwo=store.searchTaskEntriesPage(own.task.id,"共同关键词",1,undefined,pageOne.scanned);
    assert.equal(pageOne.items.length,1);assert.equal(pageTwo.items.length,1);
    assert.notEqual(pageOne.items[0]?.entryId,pageTwo.items[0]?.entryId);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic recall leaves edited-away Session Path messages as explicit history", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-recall-branch-")), home = join(root, "home"); await mkdir(home);
  const store = await ProductStore.open({ dataRoot: join(root, ".dcode"), userHome: home });
  try {
    const initial = await store.snapshot(), scope = { kind: "user" as const, userId: initial.currentUser.id };
    const task = await store.createTask({ requestId: "branch-task", expectedStoreRevision: initial.storeRevision, scope, title: "编辑路径", goal: "核对当前要求" });
    const run = await store.prepareSessionRun({ requestId: "branch-run", taskId: task.task.id, scope, sessionId: task.coordinationSession.id,
      runtimeId: "branch-runtime", workspaceId: "branch-workspace", cwd: home, workspaceAccess: "sharedReadOnly", message: "采用方案 A",
      attachmentRefs: [], roleRevision: "coordinator:v1", contextRevision: 1, profileSnapshot: { role: "coordinator" }, tools: [], toolsWritable: false,
      systemPromptDigest: `sha256:${"f".repeat(64)}`, promptSources: [] });
    await store.startSessionRun(run.sessionRunId);
    await store.finishSessionRun({ sessionRunId: run.sessionRunId, providerAttemptId: run.providerAttemptId, outcome: "succeeded", assistantText: "旧答复" });
    await store.linkSessionAdapterEntries(task.coordinationSession.id, [{ userEntryId: run.userEntryId, sourceEntryId: "source-old-a" }]);
    const oldPath = (await store.snapshot()).sessionPaths.find(item => item.sessionId === task.coordinationSession.id && item.isCurrent)!;
    await store.beginNativeSessionPath({ requestId: "edit-branch", sessionId: task.coordinationSession.id,
      action: { kind: "editUser", entryId: "source-old-a", fromPathId: oldPath.id, expectedCurrentPathId: oldPath.id, expectedCurrentPathRevision: oldPath.revision } });
    assert.equal(store.searchTaskEntries(task.task.id, "方案 A").length, 0);
    await assert.rejects(async () => store.readTaskEntry(task.task.id, run.userEntryId, true), /退出当前对话路径/);
    const historical = store.readTaskEntry(task.task.id, run.userEntryId);
    assert.equal(historical.currentPath, false);
    assert.match(historical.content, /方案 A/);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("compaction continuation freezes the adopted summary beside Raw and Effective Input", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-compaction-summary-"));
  const home = join(root, "home"); await mkdir(home);
  const store = await ProductStore.open({ dataRoot: join(root, ".dcode"), userHome: home });
  try {
    const initial = await store.snapshot(), scope = { kind: "user" as const, userId: initial.currentUser.id };
    const task = await store.createTask({ requestId: "compaction-task", expectedStoreRevision: initial.storeRevision, scope, title: "压缩续接", goal: "保持来源" });
    await store.markTaskSummaryResume({ requestId: "compaction-marker", taskId: task.task.id, sessionId: task.coordinationSession.id, trigger: "compaction" });
    assert.equal(store.pendingTaskSummaryTrigger(task.task.id, task.coordinationSession.id), "compaction");
    const saved = await store.prepareTaskSummary({ requestId: "compaction-summary", taskId: task.task.id, trigger: "compaction" });
    const summary = saved.summary;
    const receipt = { id: summary.id, taskId: summary.taskId, revision: summary.revision, digest: summary.digest, trigger: summary.trigger, createdAt: summary.createdAt };
    const prepared = await store.prepareSessionRun({ requestId: "compaction-run", taskId: task.task.id, scope,
      sessionId: task.coordinationSession.id, runtimeId: "compaction-runtime", workspaceId: "compaction-workspace", cwd: home,
      workspaceAccess: "sharedReadOnly", message: "继续处理", effectiveMessage: "<任务摘要>已确认目标</任务摘要>\n继续处理",
      taskSummary: receipt, attachmentRefs: [], roleRevision: "coordinator:v1", contextRevision: 1,
      profileSnapshot: { role: "coordinator" }, tools: [], toolsWritable: false,
      systemPromptDigest: `sha256:${"f".repeat(64)}`, promptSources: [] });
    assert.equal(store.pendingTaskSummaryTrigger(task.task.id, task.coordinationSession.id), undefined);
    const inputs = store.sessionRunInputs(task.task.id, prepared.sessionRunId);
    assert.equal(inputs.rawText, "继续处理");
    assert.match(inputs.effectiveText, /任务摘要/);
    const snapshot = await store.snapshot();
    assert.equal(snapshot.promptReceipts.find(item => item.sessionRunId === prepared.sessionRunId)?.taskSummary?.digest, summary.digest);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});
