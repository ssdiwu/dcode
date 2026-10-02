import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ProductStore, ProductStoreError, type TaskWorkflowStageInput } from "../src/product-store.js";
import { PiHost, PiHostError } from "../src/pi-host.js";

const stages: TaskWorkflowStageInput[] = [
  { id: "build", title: "构建", completion: "形成可核查的改动", dependsOn: [] },
  { id: "check", title: "核查", completion: "由不同成员复核结果", dependsOn: ["build"] },
];

test("Workflow input never degrades to an ordinary queued message when the Coordinator becomes busy", async () => {
  const root=await mkdtemp(join(tmpdir(),"dcode-workflow-busy-"));
  const home=join(root,"home"),agentDir=join(root,"agent"),dataRoot=join(root,".dcode");
  await Promise.all([mkdir(home),mkdir(agentDir)]);
  const host=new PiHost({agentDir,dataRoot,userHome:home,emit:()=>{}});
  type BusyRuntime={currentRun?:object;closing:boolean;runtimeIdentity:{agentRunId:string}};
  const internals=host as unknown as {
    runtimeByDCodeSessionId:Map<string,string>;
    runtimes:Map<string,BusyRuntime>;
    workspaceAccess:{validateFileMentions:(taskId:string,message:string)=>Promise<void>};
  };
  try {
    await host.start();
    const initial=await host.handle("foundation.snapshot",{}) as {storeRevision:number;currentUser:{id:string}};
    const created=await host.handle("task.create",{requestId:"busy-workflow-task",expectedStoreRevision:initial.storeRevision,
      scope:{kind:"user",userId:initial.currentUser.id},title:"忙碌门禁",goal:"验证工作流输入"}) as {
        task:{id:string};coordinationSession:{id:string};
      };
    const sessionId=created.coordinationSession.id,runtimeId="busy-workflow-runtime";
    const runtime:BusyRuntime={closing:false,runtimeIdentity:{agentRunId:"busy-coordinator"}};
    internals.runtimeByDCodeSessionId.set(sessionId,runtimeId);
    internals.runtimes.set(runtimeId,runtime);
    const original=internals.workspaceAccess.validateFileMentions.bind(internals.workspaceAccess);
    internals.workspaceAccess.validateFileMentions=async(taskId,message)=>{
      await original(taskId,message);
      runtime.currentRun={};
    };
    for(const [promptId,extra] of [
      ["busy-workflow-create",{workflowDraft:{goal:"有来源的阶段安排"}}],
      ["busy-workflow-report",{workflowReportRunId:"run-that-must-not-queue"}],
    ] as const){
      runtime.currentRun=undefined;
      await assert.rejects(host.handle("dcodeSession.prompt",{dcodeSessionId:sessionId,promptId,message:"不能降级排队",...extra}),
        (error:unknown)=>error instanceof PiHostError&&error.code==="SESSION_BUSY");
    }
    internals.workspaceAccess.validateFileMentions=original;
    runtime.currentRun=undefined;
    runtime.closing=true;
    await assert.rejects(host.handle("dcodeSession.prompt",{dcodeSessionId:sessionId,promptId:"closing-workflow-create",
      message:"关闭中不能排队",workflowDraft:{goal:"关闭中工作流"}}),
    (error:unknown)=>error instanceof PiHostError&&error.code==="SESSION_BUSY");
    internals.runtimeByDCodeSessionId.delete(sessionId);
    internals.runtimes.delete(runtimeId);
    const after=await host.handle("foundation.snapshot",{}) as {
      taskWorkflows:unknown[];collaborationMessages:unknown[];
    };
    const db=new DatabaseSync(join(dataRoot,"product-store.sqlite3"),{readOnly:true});
    try{assert.equal((db.prepare("SELECT COUNT(*) AS count FROM raw_inputs").get() as {count:number}).count,0);}
    finally{db.close();}
    assert.equal(after.taskWorkflows.length,0);
    assert.equal(after.collaborationMessages.length,0);
  } finally {
    internals.runtimeByDCodeSessionId.clear();
    internals.runtimes.clear();
    await host.close();
    await rm(root,{recursive:true,force:true});
  }
});

test("Task Workflow keeps source, immutable versions, explicit Work Item binding, one active Run and conservative restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-task-workflow-"));
  const dataRoot = join(root, ".dcode");
  const home = join(root, "home");
  await mkdir(home);
  let store = await ProductStore.open({ dataRoot, userHome: home });
  try {
    const initial = await store.snapshot();
    const task = await store.createTask({
      requestId: "workflow-task", expectedStoreRevision: initial.storeRevision,
      scope: { kind: "user", userId: initial.currentUser.id },
      title: "Workflow Task", goal: "完成并核查真实工作",
    });
    const prepared = await store.prepareSessionRun({
      requestId: "workflow-source-prompt",
      taskId: task.task.id, scope: task.task.scope,
      sessionId: task.coordinationSession.id,
      runtimeId: "workflow-test-runtime", workspaceId: "workflow-test-workspace",
      cwd: home, workspaceAccess: "exclusiveWrite",
      message: "请完成两阶段工作流", attachmentRefs: [],
      roleRevision: "builtin-coordinator:v1", contextRevision: 1,
      profileSnapshot: { role: "coordinator" }, tools: [], toolsWritable: false,
      systemPromptDigest: `sha256:${"a".repeat(64)}`, promptSources: [],
    });
    await store.finishSessionRun({
      sessionRunId: prepared.sessionRunId, providerAttemptId: prepared.providerAttemptId,
      outcome: "succeeded", resultReference: { completionEntryId: "workflow-test-reply" },
    });
    const sourceRevision = (await store.snapshot()).storeRevision;
    await assert.rejects(store.createTaskWorkflow({
      requestId: "bad-source", expectedStoreRevision: sourceRevision,
      taskId: task.task.id, scope: task.task.scope, originRawInputId: "raw-other-task",
      goal: "无来源", stages,
    }), (error: unknown) => error instanceof ProductStoreError && error.code === "NOT_FOUND");
    await assert.rejects(store.createTaskWorkflow({
      requestId: "bad-dependency", expectedStoreRevision: sourceRevision,
      taskId: task.task.id, scope: task.task.scope, originRawInputId: prepared.rawInputId,
      goal: "反向依赖", stages: [{ ...stages[0]!, dependsOn: ["check"] }, stages[1]!],
    }), (error: unknown) => error instanceof ProductStoreError && error.code === "INVALID_ARGUMENT");

    const created = await store.createTaskWorkflow({
      requestId: "workflow-create", expectedStoreRevision: sourceRevision,
      taskId: task.task.id, scope: task.task.scope,
      originRawInputId: prepared.rawInputId, goal: "产出并独立核查", stages,
    });
    const replay = await store.createTaskWorkflow({
      requestId: "workflow-create", expectedStoreRevision: sourceRevision,
      taskId: task.task.id, scope: task.task.scope,
      originRawInputId: prepared.rawInputId, goal: "产出并独立核查", stages,
    });
    assert.deepEqual(replay, created);
    assert.notEqual(created.workflow.id, task.task.id);
    assert.equal(created.workflow.originRawInputId, prepared.rawInputId);
    const revised = await store.reviseTaskWorkflow({
      requestId: "workflow-revise", expectedStoreRevision: created.storeRevision,
      taskId: task.task.id, scope: task.task.scope, workflowId: created.workflow.id,
      expectedWorkflowRevision: created.workflow.revision,
      originRawInputId: prepared.rawInputId,
      goal: "产出并独立核查", constraints: ["只修改本任务目录"],
      stages: [...stages, { id: "report", title: "汇总", completion: "形成有来源的报告", dependsOn: ["check"] }],
    });
    assert.equal(revised.workflowVersion.version, 2);
    assert.equal((await store.snapshot()).taskWorkflowVersions.length, 2);

    const run = await store.startTaskWorkflow({
      requestId: "workflow-start", expectedStoreRevision: revised.storeRevision,
      taskId: task.task.id, scope: task.task.scope, workflowId: created.workflow.id,
      expectedWorkflowRevision: revised.workflow.revision,
    });
    const second = await store.createTaskWorkflow({
      requestId: "workflow-second", expectedStoreRevision: run.storeRevision,
      taskId: task.task.id, scope: task.task.scope,
      originRawInputId: prepared.rawInputId, goal: "另一轮工作", stages,
    });
    await assert.rejects(store.startTaskWorkflow({
      requestId: "workflow-second-start", expectedStoreRevision: second.storeRevision,
      taskId: task.task.id, scope: task.task.scope, workflowId: second.workflow.id,
      expectedWorkflowRevision: second.workflow.revision,
    }), (error: unknown) => error instanceof ProductStoreError && error.code === "REVISION_CONFLICT");
    const work = await store.createTaskWorkItem({
      requestId: "workflow-work-item", expectedStoreRevision: second.storeRevision,
      taskId: task.task.id, scope: task.task.scope, title: "实现第一阶段",
    });
    const bound = await store.bindTaskWorkflowWorkItem({
      requestId: "workflow-bind", expectedStoreRevision: work.storeRevision,
      taskId: task.task.id, scope: task.task.scope, runId: run.run.id,
      expectedRunRevision: run.run.revision, stageId: "build", workItemId: work.taskWorkItem.id,
    });
    assert.equal(bound.binding.workItemId, work.taskWorkItem.id);
    await assert.rejects(store.reviseTaskWorkflow({
      requestId: "rewrite-bound-stage", expectedStoreRevision: bound.storeRevision,
      taskId: task.task.id, scope: task.task.scope, workflowId: created.workflow.id,
      expectedWorkflowRevision: revised.workflow.revision,
      originRawInputId: prepared.rawInputId,
      goal: "产出并独立核查", stages: [{ ...stages[0]!, completion: "偷偷改完成标准" }, stages[1]!],
    }), (error: unknown) => error instanceof ProductStoreError && error.code === "REVISION_CONFLICT");

    const owner = await store.ensureCoordinatorAgentRun({
      requestId: "workflow-coordinator", taskId: task.task.id, scope: task.task.scope,
    });
    await assert.rejects(store.createTeamRun({
      requestId: "premature-workflow-check", taskId: task.task.id, scope: task.task.scope,
      coordinatorAgentRunId: owner.agentRun.id, workflowRunId: run.run.id,
      members: [{ profileId: "builtin-worker", title: "提前执行后续阶段", taskPacket: {
        instruction: "核查", acceptance: "检查完成", workflowStageId: "check",
      } }],
    }), (error: unknown) => error instanceof ProductStoreError && error.code === "REVISION_CONFLICT");
    await assert.rejects(store.createTeamRun({
      requestId: "unbound-team", taskId: task.task.id, scope: task.task.scope,
      coordinatorAgentRunId: owner.agentRun.id,
      members: [{ profileId: "builtin-worker", title: "普通成员", taskPacket: { instruction: "无阶段" } }],
    }), (error: unknown) => error instanceof ProductStoreError && error.code === "REVISION_CONFLICT");
    const delegated = await store.createTeamRun({
      requestId: "workflow-first-delegate", taskId: task.task.id, scope: task.task.scope,
      coordinatorAgentRunId: owner.agentRun.id, workflowRunId: run.run.id,
      members: [{ profileId: "builtin-worker", title: "执行第一阶段", taskPacket: {
        instruction: "实现", acceptance: "保留实际变更", workflowStageId: "build",
      } }],
    });
    const assigned = (await store.snapshot()).taskWorkItems.find(item => item.id === work.taskWorkItem.id);
    assert.equal(assigned?.state, "in_progress");
    assert.equal(assigned?.ownerAssignmentId, delegated.assignments.find(item => item.assignmentKind === "member")?.id);
    const pendingBeforeStop = await store.queueCollaborationMessage({
      requestId: "workflow-pending-before-stop", taskId: task.task.id,
      sourceSessionId: task.coordinationSession.id,
      targetAgentRunId: delegated.childAgentRuns[0]!.id,
      author: "coordinator", originRawInputId: prepared.rawInputId,
      text: "后续说明需等待工作流恢复",
    });
    const stopped = await store.stopTaskWorkflow({
      requestId: "workflow-stop", expectedStoreRevision: (await store.snapshot()).storeRevision,
      taskId: task.task.id, scope: task.task.scope, runId: run.run.id,
      expectedRunRevision: run.run.revision, reason: "停止后续阶段，当前成员收尾",
    });
    assert.equal(stopped.run.status, "stopped");
    assert.equal(store.collaborationMessages(task.task.id).find(item => item.id === pendingBeforeStop.message.id)?.state,
      "paused", "停止前尚未发送的成员消息不得继续派发");
    const directedWhileStopped = await store.queueCollaborationMessage({
      requestId: "workflow-user-while-stopped", taskId: task.task.id,
      sourceSessionId: task.coordinationSession.id,
      targetAgentRunId: delegated.childAgentRuns[0]!.id,
      author: "user", text: "请保留原修改，恢复后再处理新要求",
    });
    assert.equal(directedWhileStopped.message.state, "paused");
    assert.notEqual(directedWhileStopped.message.originRawInputId, prepared.rawInputId);
    const steerWhileStopped = await store.queueCollaborationMessage({
      requestId: "workflow-steer-while-stopped", taskId: task.task.id,
      sourceSessionId: task.coordinationSession.id,
      targetAgentRunId: delegated.childAgentRuns[0]!.id,
      author: "user", text: "再补一条待继续要求", deliveryMode: "steer",
      targetSessionRunId: "stale-session-run",
    });
    assert.equal(steerWhileStopped.message.state, "paused");
    assert.equal(steerWhileStopped.message.deliveryMode, undefined, "停止期间不能保留过期 steer 目标");
    await assert.rejects(store.createTeamRun({
      requestId: "team-while-workflow-stopped", taskId: task.task.id, scope: task.task.scope,
      coordinatorAgentRunId: owner.agentRun.id,
      members: [{ profileId: "builtin-worker", title: "抢占成员", taskPacket: { instruction: "普通工作" } }],
    }), (error: unknown) => error instanceof ProductStoreError && error.code === "REVISION_CONFLICT");
    const resumedInFlight = await store.continueTaskWorkflow({
      requestId: "workflow-continue-in-flight", expectedStoreRevision: (await store.snapshot()).storeRevision,
      taskId: task.task.id, scope: task.task.scope, runId: run.run.id,
      expectedRunRevision: stopped.run.revision,
    });
    assert.equal(store.collaborationMessages(task.task.id).find(item => item.id === pendingBeforeStop.message.id)?.state,
      "queued", "继续后可向仍在途的同一阶段成员安全送达");
    const stoppedAgain = await store.stopTaskWorkflow({
      requestId: "workflow-stop-again", expectedStoreRevision: resumedInFlight.storeRevision,
      taskId: task.task.id, scope: task.task.scope, runId: run.run.id,
      expectedRunRevision: resumedInFlight.run.revision, reason: "第二次停止后续阶段",
    });
    await store.finishTeamRun({
      requestId: "workflow-team-aborted", taskId: task.task.id, teamRunId: delegated.teamRun.id,
      status: "aborted", reason: "测试停止后保留工作项",
    });
    assert.equal((await store.snapshot()).taskWorkItems.find(item => item.id === work.taskWorkItem.id)?.state, "blocked");

    const continued = await store.continueTaskWorkflow({
      requestId: "workflow-continue", expectedStoreRevision: (await store.snapshot()).storeRevision,
      taskId: task.task.id, scope: task.task.scope, runId: run.run.id,
      expectedRunRevision: stoppedAgain.run.revision,
    });
    assert.equal(continued.run.id, run.run.id);
    assert.equal(continued.run.status, "active");
    await store.close();
    store = await ProductStore.open({ dataRoot, userHome: home });
    const recovered = await store.snapshot();
    const interrupted = recovered.taskWorkflowRuns.find(item => item.id === run.run.id);
    assert.equal(interrupted?.status, "interrupted");
    assert.equal(interrupted?.reason, "host_restarted");
    assert.equal(recovered.taskWorkflowWorkItems[0]?.workItemId, work.taskWorkItem.id);
    assert.equal(recovered.taskWorkflowVersions.length, 3);
    assert.equal(recovered.taskWorkflowStages.filter(stage => stage.workflowId === created.workflow.id && stage.version === 1).length, 2);
    const resumed = await store.continueTaskWorkflow({
      requestId: "workflow-after-restart", expectedStoreRevision: recovered.storeRevision,
      taskId: task.task.id, scope: task.task.scope, runId: run.run.id,
      expectedRunRevision: interrupted!.revision,
    });
    assert.equal(resumed.run.status, "active");
    assert.equal(resumed.run.id, run.run.id);
    const nextOwner = await store.ensureCoordinatorAgentRun({
      requestId: "workflow-after-restart-owner", taskId: task.task.id, scope: task.task.scope,
    });
    const retry = await store.createTeamRun({
      requestId: "workflow-safe-retry", taskId: task.task.id, scope: task.task.scope,
      coordinatorAgentRunId: nextOwner.agentRun.id, workflowRunId: run.run.id,
      members: [{ profileId: "builtin-worker", title: "恢复第一阶段", taskPacket: {
        instruction: "先核对旧工作项，再完成剩余工作", acceptance: "旧事实保留且新增结果可核查",
        workflowStageId: "build",
      } }],
    });
    assert.equal((await store.snapshot()).taskWorkflowWorkItems.find(item => item.stageId === "build")?.workItemId,
      work.taskWorkItem.id);
    assert.equal((await store.snapshot()).taskWorkItems.find(item => item.id === work.taskWorkItem.id)?.ownerAssignmentId,
      retry.assignments.find(item => item.assignmentKind === "member")?.id);
    assert.equal(store.collaborationMessages(task.task.id).find(item => item.id === directedWhileStopped.message.id)?.state,
      "paused", "已终止成员的旧消息不得自动重放给新成员");
    const newDelivery = await store.queueCollaborationMessage({
      requestId: "workflow-new-member-message", taskId: task.task.id,
      sourceSessionId: task.coordinationSession.id,
      targetAgentRunId: retry.childAgentRuns[0]!.id,
      author: "coordinator", originRawInputId: directedWhileStopped.message.originRawInputId,
      text: "先核对旧原文，再处理剩余工作",
    });
    assert.equal(newDelivery.message.state, "queued");
  } finally {
    await store.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("Workflow stages dispatch through Team Runs and complete only after accepted independent evidence and Coordinator report", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-workflow-evidence-"));
  const dataRoot = join(root, ".dcode");
  const home = join(root, "home");
  await mkdir(home);
  const store = await ProductStore.open({ dataRoot, userHome: home });
  try {
    const initial = await store.snapshot();
    const task = await store.createTask({ requestId: "evidence-task", expectedStoreRevision: 0,
      scope: { kind: "user", userId: initial.currentUser.id }, title: "两阶段交付", goal: "产出并验收" });
    const scope = task.task.scope;
    const owner = await store.ensureCoordinatorAgentRun({ requestId: "evidence-owner", taskId: task.task.id, scope });
    let serial = 0;
    const prepare = async (agent: { id: string; sessionId: string; role: string }, label: string,
      collaborationMessageId?: string, workflowReportRunId?: string) => {
      const sequence = ++serial;
      const prepared = await store.prepareSessionRun({
        requestId: `workflow-run-${sequence}`, taskId: task.task.id, scope,
        sessionId: agent.sessionId, agentRunId: agent.id,
        runtimeId: `workflow-runtime-${sequence}`, workspaceId: `workflow-workspace-${sequence}`,
        cwd: home, workspaceAccess: "sharedReadOnly", message: label, attachmentRefs: [],
        roleRevision: `${agent.role}:v1`, contextRevision: 1,
        profileSnapshot: { role: agent.role },
        ...(collaborationMessageId ? { collaborationMessageId } : {}),
        ...(workflowReportRunId ? { workflowReportRunId } : {}),
        tools: [{ name: "read", description: "Read checked result", parameters: { type: "object" } }],
        toolsWritable: false, systemPromptDigest: `sha256:${"f".repeat(64)}`, promptSources: [],
      });
      await store.startSessionRun(prepared.sessionRunId);
      return prepared;
    };
    const source = await prepare({ ...owner.agentRun, role: "coordinator" }, "请执行两阶段工作流");
    await store.finishSessionRun({ sessionRunId: source.sessionRunId,
      providerAttemptId: source.providerAttemptId, outcome: "succeeded", assistantText: "已形成阶段安排" });
    const priorOrdinary = await store.createTeamRun({ requestId: "prior-ordinary-team",
      taskId: task.task.id, scope, coordinatorAgentRunId: owner.agentRun.id,
      members: [{ profileId: "builtin-explore", title: "旧普通成员",
        taskPacket: { instruction: "先完成普通调查" } }] });
    const oldMember = priorOrdinary.childAgentRuns[0]!;
    const stageMembers:typeof oldMember[]=[];
    const oldRun = await prepare(oldMember, "普通工作");
    await store.finishSessionRun({ sessionRunId: oldRun.sessionRunId,
      providerAttemptId: oldRun.providerAttemptId, outcome: "succeeded", assistantText: "普通调查已结束" });
    assert.equal((await store.snapshot()).teamRuns.find(item => item.id === priorOrdinary.teamRun.id)?.status,
      "completed");
    const created = await store.createTaskWorkflow({
      requestId: "evidence-workflow", expectedStoreRevision: (await store.snapshot()).storeRevision,
      taskId: task.task.id, scope, originRawInputId: source.rawInputId,
      goal: "先完成工作，再消费真实结果", stages,
    });
    const run = await store.startTaskWorkflow({
      requestId: "evidence-start", expectedStoreRevision: created.storeRevision,
      taskId: task.task.id, scope, workflowId: created.workflow.id,
      expectedWorkflowRevision: created.workflow.revision,
    });
    await assert.rejects(prepare({ ...owner.agentRun, role: "coordinator" },
      "未验收阶段前伪装工作流报告", undefined, run.run.id),
    (error: unknown) => error instanceof ProductStoreError && error.code === "REVISION_CONFLICT");
    const earlyCoordinatorRun = await prepare({ ...owner.agentRun, role: "coordinator" }, "阶段尚未验收时的旧汇总");
    await store.finishSessionRun({ sessionRunId: earlyCoordinatorRun.sessionRunId,
      providerAttemptId: earlyCoordinatorRun.providerAttemptId, outcome: "succeeded",
      assistantText: "阶段尚未验收，不能作为最终报告" });
    const earlyReport = (await store.snapshot()).agentReports.filter(item => item.agentRunId === owner.agentRun.id).at(-1)!;
    await assert.rejects(store.completeTaskWorkflow({
      requestId: "premature-complete", expectedStoreRevision: (await store.snapshot()).storeRevision,
      taskId: task.task.id, scope, runId: run.run.id,
      expectedRunRevision: run.run.revision,
      coordinatorReportId: (await store.snapshot()).agentReports.find(report => report.agentRunId === owner.agentRun.id)!.id,
    }), (error: unknown) => error instanceof ProductStoreError && error.code === "REVISION_CONFLICT");

    const executeAndVerify = async (stageId: string) => {
      const worker = await store.createTeamRun({ requestId: `stage-${stageId}-worker`, taskId: task.task.id,
        scope, coordinatorAgentRunId: owner.agentRun.id, workflowRunId: run.run.id,
        members: [{ profileId: "builtin-worker", title: `执行 ${stageId}`,
          taskPacket: { instruction: `完成 ${stageId}`, acceptance: "留下真实结果", workflowStageId: stageId } }],
      });
      const workerRun = worker.childAgentRuns[0]!;
      stageMembers.push(workerRun);
      const preparedWorker = await prepare(workerRun, `执行 ${stageId}`);
      await store.finishSessionRun({ sessionRunId: preparedWorker.sessionRunId,
        providerAttemptId: preparedWorker.providerAttemptId, outcome: "succeeded", assistantText: `${stageId} 的可核查结果` });
      const report = (await store.snapshot()).agentReports.filter(item => item.agentRunId === workerRun.id).at(-1)!;
      const verifier = await store.createTeamRun({ requestId: `stage-${stageId}-verifier`, taskId: task.task.id,
        scope, coordinatorAgentRunId: owner.agentRun.id, workflowRunId: run.run.id,
        members: [{ profileId: "builtin-verifier", title: `验收 ${stageId}`,
          taskPacket: { instruction: `独立核查 ${stageId}`, acceptance: "留下检查证据",
            workflowStageId: stageId, workflowPurpose: "verify" } }],
      });
      const verifierRun = verifier.childAgentRuns[0]!;
      const preparedVerifier = await prepare(verifierRun, `检查 ${stageId}`);
      const attempt = await store.prepareToolAttempt({ taskId: task.task.id,
        sessionId: verifierRun.sessionId, sessionRunId: preparedVerifier.sessionRunId,
        toolCallId: `read-${stageId}`, toolName: "read", parameterDigest: `sha256:${"1".repeat(64)}` });
      await store.finishOperationAttempt({ attemptId: attempt.attemptId,
        outcome: "succeeded", resultDigest: `sha256:${"2".repeat(64)}` });
      const evidence = await store.recordToolEvidence({ requestId: `stage-${stageId}-evidence`,
        attemptId: attempt.attemptId, toolName: "read", outcome: "succeeded",
        resultDigest: `sha256:${"2".repeat(64)}` });
      const verification = await store.submitVerification({ requestId: `stage-${stageId}-verification`,
        taskId: task.task.id, verifierAgentRunId: verifierRun.id, subjectReportId: report.id,
        verdict: "pass", evidenceIds: [evidence.evidence.id], findings: [], summary: `${stageId} 已独立核查` });
      const reviewed = await store.reviewVerification({ requestId: `stage-${stageId}-accepted`,
        taskId: task.task.id, coordinatorAgentRunId: owner.agentRun.id,
        verificationId: verification.verification.id, outcome: "accepted", reason: "报告与新检查证据相符" });
      assert.equal(reviewed.workItemCompleted, true);
      await store.finishSessionRun({ sessionRunId: preparedVerifier.sessionRunId,
        providerAttemptId: preparedVerifier.providerAttemptId, outcome: "succeeded", assistantText: `${stageId} 检查完成` });
      const snapshot = await store.snapshot();
      const binding = snapshot.taskWorkflowWorkItems.find(item => item.runId === run.run.id && item.stageId === stageId)!;
      assert.equal(snapshot.taskWorkItems.find(item => item.id === binding.workItemId)?.state, "completed");
      assert.ok(snapshot.verifications?.some(item => item.id === verification.verification.id));
    };
    await executeAndVerify("build");
    await executeAndVerify("check");
    await assert.rejects(store.completeTaskWorkflow({
      requestId: "old-coordinator-report", expectedStoreRevision: (await store.snapshot()).storeRevision,
      taskId: task.task.id, scope, runId: run.run.id, expectedRunRevision: run.run.revision,
      coordinatorReportId: earlyReport.id,
    }), (error: unknown) => error instanceof ProductStoreError && error.code === "REVISION_CONFLICT");
    const summaryRun = await prepare({ ...owner.agentRun, role: "coordinator" }, "汇总工作流结果");
    await store.finishSessionRun({ sessionRunId: summaryRun.sessionRunId,
      providerAttemptId: summaryRun.providerAttemptId, outcome: "succeeded", assistantText: "两阶段结果与证据已核对" });
    const report = (await store.snapshot()).agentReports.filter(item => item.agentRunId === owner.agentRun.id).at(-1)!;
    await assert.rejects(store.completeTaskWorkflow({
      requestId: "unbound-late-report", expectedStoreRevision: (await store.snapshot()).storeRevision,
      taskId: task.task.id, scope, runId: run.run.id, expectedRunRevision: run.run.revision,
      coordinatorReportId: report.id,
    }), (error: unknown) => error instanceof ProductStoreError && error.code === "REVISION_CONFLICT");
    const laterInput = await prepare({ ...owner.agentRun, role: "coordinator" }, "用户后来补充的适用要求");
    await assert.rejects(store.completeTaskWorkflow({
      requestId: "report-before-latest-input", expectedStoreRevision: (await store.snapshot()).storeRevision,
      taskId: task.task.id, scope, runId: run.run.id, expectedRunRevision: run.run.revision,
      coordinatorReportId: report.id,
    }), (error: unknown) => error instanceof ProductStoreError && error.code === "REVISION_CONFLICT");
    await store.finishSessionRun({ sessionRunId: laterInput.sessionRunId,
      providerAttemptId: laterInput.providerAttemptId, outcome: "succeeded",
      assistantText: "已重新核对新增要求和所有阶段证据" });
    const pendingUser = await store.queueCollaborationMessage({ requestId: "workflow-last-user-update",
      taskId: task.task.id, sourceSessionId: task.coordinationSession.id,
      targetAgentRunId: owner.agentRun.id, author: "user",
      text: "最后增加一项适用条件，请先核对" });
    const ignoredRun = await prepare({ ...owner.agentRun, role: "coordinator" }, "未读取待处理用户输入的总结");
    await store.finishSessionRun({ sessionRunId: ignoredRun.sessionRunId,
      providerAttemptId: ignoredRun.providerAttemptId, outcome: "succeeded",
      assistantText: "没有读取新用户输入的总结不能收口" });
    const ignoredReport = (await store.snapshot()).agentReports.filter(item => item.agentRunId === owner.agentRun.id).at(-1)!;
    await assert.rejects(store.completeTaskWorkflow({
      requestId: "unapplied-user-input", expectedStoreRevision: (await store.snapshot()).storeRevision,
      taskId: task.task.id, scope, runId: run.run.id, expectedRunRevision: run.run.revision,
      coordinatorReportId: ignoredReport.id,
    }), (error: unknown) => error instanceof ProductStoreError && error.code === "REVISION_CONFLICT");
    await store.transitionCollaborationMessage({
      requestId: "workflow-input-delivering", id: pendingUser.message.id,
      expectedRevision: pendingUser.message.revision, state: "delivering" });
    const acknowledgedRun = await prepare({ ...owner.agentRun, role: "coordinator" },
      pendingUser.message.text, pendingUser.message.id, run.run.id);
    await store.finishSessionRun({ sessionRunId: acknowledgedRun.sessionRunId,
      providerAttemptId: acknowledgedRun.providerAttemptId, outcome: "succeeded",
      assistantText: "已将最后一项要求与阶段证据一起核对" });
    const appliedMessage = store.collaborationMessages(task.task.id).find(item => item.id === pendingUser.message.id)!;
    if (appliedMessage.state === "delivering") await store.transitionCollaborationMessage({ requestId: "workflow-input-applied",
      id: pendingUser.message.id, expectedRevision: appliedMessage.revision, state: "completed" });
    else assert.equal(appliedMessage.state, "completed");
    const currentReport = (await store.snapshot()).agentReports.filter(item => item.agentRunId === owner.agentRun.id).at(-1)!;
    assert.deepEqual((currentReport.body as { workflowReport?: unknown }).workflowReport,
      { runId: run.run.id, workflowId: created.workflow.id, version: run.run.version, goalRevision: 1 });
    const completed = await store.completeTaskWorkflow({
      requestId: "workflow-evidence-complete", expectedStoreRevision: (await store.snapshot()).storeRevision,
      taskId: task.task.id, scope, runId: run.run.id, expectedRunRevision: run.run.revision,
      coordinatorReportId: currentReport.id,
    });
    assert.equal(completed.run.status, "completed");
    assert.equal(completed.run.completionReportId, currentReport.id);
    assert.equal(completed.reportBinding.runId, run.run.id);
    assert.equal(completed.reportBinding.version, run.run.version);
    assert.equal(completed.reportBinding.coordinatorReportId, currentReport.id);
    assert.ok(completed.reportBinding.finalReviewSequence > 0);
    assert.equal((await store.snapshot()).taskWorkflowReports[0]?.runId, run.run.id);
    assert.equal((await store.snapshot()).tasks.find(item => item.id === task.task.id)?.state, "active");
    const oldMemberAfterWorkflow = await store.queueCollaborationMessage({
      requestId: "old-member-after-workflow-complete", taskId: task.task.id,
      sourceSessionId: task.coordinationSession.id, targetAgentRunId: oldMember.id,
      author: "user", text: "工作流结束后给旧普通成员的新要求，先待协调者核对" });
    assert.equal(oldMemberAfterWorkflow.message.state, "paused");
    assert.equal((await store.snapshot()).teamRuns.find(item => item.id === priorOrdinary.teamRun.id)?.status,
      "completed");
    const recovery = { taskId: task.task.id, coordinatorAgentRunId: owner.agentRun.id,
      agentRunId: oldMember.id, instruction: "明确纳入新用户要求的普通工作",
      acceptance: "重新交付可核查结果",
      route: { purpose: "independent" as const, reason: "工作流已完成后的独立任务" },
      sourceSessionId: task.coordinationSession.id,
      originRawInputId: oldMemberAfterWorkflow.message.originRawInputId };
    await assert.rejects(store.continueRouteMember({ requestId: "old-member-without-review", ...recovery }),
      (error: unknown) => error instanceof ProductStoreError && error.code === "REVISION_CONFLICT");
    await store.transitionCollaborationMessage({ requestId: "old-member-explicit-reconcile",
      id: oldMemberAfterWorkflow.message.id, expectedRevision: oldMemberAfterWorkflow.message.revision,
      state: "cancelled", error: "新交办已明确承接原文" });
    await store.continueRouteMember({ requestId: "old-member-after-review", ...recovery });
    const deliveredAfterReview = await store.queueCollaborationMessage({
      requestId: "old-member-new-assignment-message", taskId: task.task.id,
      sourceSessionId: task.coordinationSession.id, targetAgentRunId: oldMember.id,
      author: "coordinator", originRawInputId: recovery.originRawInputId,
      text: recovery.instruction,
    });
    assert.equal(deliveredAfterReview.message.state, "queued");
    await store.transitionCollaborationMessage({requestId:"old-member-new-work-paused-for-next",id:deliveredAfterReview.message.id,
      expectedRevision:deliveredAfterReview.message.revision,state:"cancelled",error:"本测试先收口普通新工作，再续用旧阶段成员"});
    await store.finishTeamRun({requestId:"old-member-new-work-settled",taskId:task.task.id,
      teamRunId:priorOrdinary.teamRun.id,status:"aborted",reason:"本轮普通交办已收口"});
    const stageMember=stageMembers[0]!;
    const stageInput=await store.queueCollaborationMessage({requestId:"completed-stage-member-new-user",
      taskId:task.task.id,sourceSessionId:task.coordinationSession.id,targetAgentRunId:stageMember.id,
      author:"user",text:"工作流已完成，给原阶段成员一项新的普通工作"});
    assert.equal(stageInput.message.state,"paused","旧阶段消息须先由协调者核对");
    await store.transitionCollaborationMessage({requestId:"completed-stage-member-reconciled",id:stageInput.message.id,
      expectedRevision:stageInput.message.revision,state:"cancelled",error:"新交办已完整承接用户原文"});
    await store.continueRouteMember({requestId:"completed-stage-member-continued",taskId:task.task.id,
      coordinatorAgentRunId:owner.agentRun.id,agentRunId:stageMember.id,
      instruction:"独立处理新工作，不回写旧工作流阶段",acceptance:"新结果单独核查",
      route:{purpose:"independent",reason:"已完成工作流后的普通工作"},
      sourceSessionId:task.coordinationSession.id,originRawInputId:stageInput.message.originRawInputId});
    const newStageMessage=await store.queueCollaborationMessage({requestId:"completed-stage-member-new-delivery",
      taskId:task.task.id,sourceSessionId:task.coordinationSession.id,targetAgentRunId:stageMember.id,
      author:"coordinator",originRawInputId:stageInput.message.originRawInputId,
      text:"独立处理新工作，不回写旧工作流阶段"});
    assert.equal(newStageMessage.message.state,"queued");
    const finalSnapshot=await store.snapshot();
    const latestAssignment=finalSnapshot.agentAssignments.filter(item=>item.agentRunId===stageMember.id).at(-1)!;
    assert.equal((latestAssignment.taskPacket as {workflowBinding?:unknown}).workflowBinding,undefined);
    assert.equal(finalSnapshot.taskWorkflowRuns.find(item=>item.id===run.run.id)?.status,"completed");
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Workflow snapshots Task Goal revision and requires revision before continuing after a Goal change", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-workflow-goal-"));
  const dataRoot = join(root, ".dcode");
  const home = join(root, "home");
  await mkdir(home);
  const store = await ProductStore.open({ dataRoot, userHome: home });
  try {
    const initial = await store.snapshot();
    const task = await store.createTask({ requestId: "goal-task", expectedStoreRevision: 0,
      scope: { kind: "user", userId: initial.currentUser.id }, title: "Goal-bound Workflow",
      goal: "原始任务目标", acceptance: ["原标准"] });
    const source = await store.prepareSessionRun({ requestId: "goal-source", taskId: task.task.id,
      scope: task.task.scope, sessionId: task.coordinationSession.id,
      runtimeId: "goal-runtime", workspaceId: "goal-workspace", cwd: home,
      workspaceAccess: "exclusiveWrite", message: "按原目标执行工作流", attachmentRefs: [],
      roleRevision: "builtin-coordinator:v1", contextRevision: 1,
      profileSnapshot: { role: "coordinator" }, tools: [], toolsWritable: false,
      systemPromptDigest: `sha256:${"f".repeat(64)}`, promptSources: [],
    });
    await store.finishSessionRun({ sessionRunId: source.sessionRunId,
      providerAttemptId: source.providerAttemptId, outcome: "succeeded", assistantText: "已记录工作流目标" });
    const created = await store.createTaskWorkflow({ requestId: "goal-workflow-create",
      expectedStoreRevision: (await store.snapshot()).storeRevision, taskId: task.task.id,
      scope: task.task.scope, originRawInputId: source.rawInputId,
      goal: "执行原目标", stages: [stages[0]!] });
    const run = await store.startTaskWorkflow({ requestId: "goal-workflow-start",
      expectedStoreRevision: created.storeRevision, taskId: task.task.id, scope: task.task.scope,
      workflowId: created.workflow.id, expectedWorkflowRevision: created.workflow.revision });
    const active = await store.snapshot();
    await assert.rejects(store.updateTaskGoal({ requestId: "goal-active-change",
      expectedStoreRevision: active.storeRevision, taskId: task.task.id, scope: task.task.scope,
      expectedTaskRevision: active.tasks.find(item => item.id === task.task.id)!.revision,
      goal: "运行时突然变更", acceptance: ["新标准"] }),
    (error: unknown) => error instanceof ProductStoreError && error.code === "REVISION_CONFLICT");
    const stopped = await store.stopTaskWorkflow({ requestId: "goal-stop",
      expectedStoreRevision: (await store.snapshot()).storeRevision, taskId: task.task.id,
      scope: task.task.scope, runId: run.run.id, expectedRunRevision: run.run.revision,
      reason: "先修订目标" });
    const beforeChange = await store.snapshot();
    const changed = await store.updateTaskGoal({ requestId: "goal-stopped-change",
      expectedStoreRevision: beforeChange.storeRevision, taskId: task.task.id, scope: task.task.scope,
      expectedTaskRevision: beforeChange.tasks.find(item => item.id === task.task.id)!.revision,
      goal: "修订后的任务目标", acceptance: ["新标准"] });
    await assert.rejects(store.continueTaskWorkflow({ requestId: "goal-stale-continue",
      expectedStoreRevision: changed.storeRevision, taskId: task.task.id,
      scope: task.task.scope, runId: run.run.id, expectedRunRevision: stopped.run.revision }),
    (error: unknown) => error instanceof ProductStoreError && error.code === "REVISION_CONFLICT");
    const revised = await store.reviseTaskWorkflow({ requestId: "goal-workflow-revise",
      expectedStoreRevision: changed.storeRevision, taskId: task.task.id, scope: task.task.scope,
      workflowId: created.workflow.id, expectedWorkflowRevision: created.workflow.revision,
      originRawInputId: source.rawInputId, goal: "执行新目标", stages: [stages[0]!] });
    const continued = await store.continueTaskWorkflow({ requestId: "goal-current-continue",
      expectedStoreRevision: revised.storeRevision, taskId: task.task.id,
      scope: task.task.scope, runId: run.run.id, expectedRunRevision: revised.run!.revision });
    assert.equal(continued.run.status, "active");
    assert.equal((revised.workflowVersion as { goalRevision?: number }).goalRevision, 2);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Host steer to a stopped Workflow member preserves submitted text as a paused message", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-workflow-host-steer-"));
  const dataRoot = join(root, ".dcode");
  const home = join(root, "home");
  const agentDir = join(root, "agent");
  await mkdir(home);
  await mkdir(agentDir);
  await writeFile(join(agentDir, "settings.json"), "{}\n");
  let store = await ProductStore.open({ dataRoot, userHome: home });
  let host: PiHost | undefined;
  try {
    const initial = await store.snapshot();
    const task = await store.createTask({ requestId: "steer-task", expectedStoreRevision: 0,
      scope: { kind: "user", userId: initial.currentUser.id }, title: "暂停后输入",
      goal: "保留用户原文" });
    const source = await store.prepareSessionRun({ requestId: "steer-source", taskId: task.task.id,
      scope: task.task.scope, sessionId: task.coordinationSession.id,
      runtimeId: "steer-source-runtime", workspaceId: "steer-source-workspace", cwd: home,
      workspaceAccess: "exclusiveWrite", message: "发起工作流", attachmentRefs: [],
      roleRevision: "builtin-coordinator:v1", contextRevision: 1,
      profileSnapshot: { role: "coordinator" }, tools: [], toolsWritable: false,
      systemPromptDigest: `sha256:${"f".repeat(64)}`, promptSources: [],
    });
    await store.finishSessionRun({ sessionRunId: source.sessionRunId,
      providerAttemptId: source.providerAttemptId, outcome: "succeeded", assistantText: "安排已形成" });
    const workflow = await store.createTaskWorkflow({ requestId: "steer-workflow-create",
      expectedStoreRevision: (await store.snapshot()).storeRevision,
      taskId: task.task.id, scope: task.task.scope,
      originRawInputId: source.rawInputId, goal: "完成阶段", stages: [stages[0]!] });
    const run = await store.startTaskWorkflow({ requestId: "steer-workflow-start",
      expectedStoreRevision: workflow.storeRevision, taskId: task.task.id,
      scope: task.task.scope, workflowId: workflow.workflow.id,
      expectedWorkflowRevision: workflow.workflow.revision });
    const owner = await store.ensureCoordinatorAgentRun({ requestId: "steer-owner",
      taskId: task.task.id, scope: task.task.scope });
    const team = await store.createTeamRun({ requestId: "steer-member", taskId: task.task.id,
      scope: task.task.scope, coordinatorAgentRunId: owner.agentRun.id,
      workflowRunId: run.run.id, members: [{ profileId: "builtin-worker", title: "执行",
        taskPacket: { instruction: "完成阶段", acceptance: "有报告", workflowStageId: "build" } }] });
    await store.stopTaskWorkflow({ requestId: "steer-stop",
      expectedStoreRevision: (await store.snapshot()).storeRevision, taskId: task.task.id,
      scope: task.task.scope, runId: run.run.id, expectedRunRevision: run.run.revision,
      reason: "暂停后续输入" });
    await store.close();
    host = new PiHost({ agentDir, dataRoot, userHome: home, emit: () => {} });
    const response = await host.handle("dcodeSession.prompt", {
      dcodeSessionId: team.childAgentRuns[0]!.sessionId,
      targetAgentRunId: team.childAgentRuns[0]!.id,
      promptId: "stopped-steer", message: "停止期间的用户原文",
      deliveryMode: "steer", expectedSessionRunId: "old-session-run",
    }) as { accepted: boolean; message: { state: string; text: string; originRawInputId: string; deliveryMode?: string } };
    assert.equal(response.accepted, true);
    assert.equal(response.message.state, "paused");
    assert.equal(response.message.text, "停止期间的用户原文");
    assert.equal(response.message.deliveryMode, undefined);
    const snapshot = await host.handle("foundation.snapshot", {}) as {
      collaborationMessages: Array<{ originRawInputId: string; text: string; state: string }>;
    };
    assert.ok(snapshot.collaborationMessages.some(message =>
      message.originRawInputId === response.message.originRawInputId
      && message.text === response.message.text && message.state === "paused"));
  } finally {
    await host?.close();
    await store.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("first Workflow prompt atomically retains user text and a zero-stage draft until Coordinator revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-workflow-first-prompt-"));
  const dataRoot = join(root, ".dcode");
  const home = join(root, "home");
  await mkdir(home);
  const store = await ProductStore.open({ dataRoot, userHome: home });
  try {
    const initial = await store.snapshot();
    const task = await store.createTask({ requestId: "first-prompt-task", expectedStoreRevision: 0,
      scope: { kind: "user", userId: initial.currentUser.id }, title: "唯一任务",
      goal: "交付真实结果" });
    const owner = await store.ensureCoordinatorAgentRun({ requestId: "first-prompt-owner",
      taskId: task.task.id, scope: task.task.scope });
    const prompt = {
      requestId: "first-workflow-prompt", clientPromptId:"workflow-first-stable", taskId: task.task.id, scope: task.task.scope,
      sessionId: task.coordinationSession.id, agentRunId: owner.agentRun.id,
      runtimeId: "first-workflow-runtime", workspaceId: "first-workflow-workspace",
      cwd: home, workspaceAccess: "sharedReadOnly" as const,
      message: "用户原文：请分两步完成并检查", attachmentRefs: [],
      workflowDraft: { goal: "分两步完成并检查", constraints: ["保留原始文件"] },
      roleRevision: "builtin-coordinator:v1", contextRevision: 1,
      profileSnapshot: { role: "coordinator" }, tools: [], toolsWritable: false,
      systemPromptDigest: `sha256:${"f".repeat(64)}`, promptSources: [],
    };
    await assert.rejects(store.prepareSessionRun({ ...prompt, requestId: "bad-first-workflow",
      workflowDraft: { goal: "api_key: fake_secret", constraints: [] } }),
    (error: unknown) => error instanceof ProductStoreError && error.code === "CREDENTIAL_MATERIAL_REJECTED");
    assert.equal((await store.snapshot()).taskWorkflows.length, 0);
    const prepared = await store.prepareSessionRun(prompt);
    const replay = await store.prepareSessionRun(prompt);
    assert.deepEqual(replay, prepared);
    assert.ok(prepared.workflow);
    assert.equal(prepared.workflow.originRawInputId, prepared.rawInputId);
    const snapshot = await store.snapshot();
    assert.equal(snapshot.tasks.length, 1);
    assert.equal(snapshot.taskWorkflows.length, 1);
    assert.equal(snapshot.taskWorkflowVersions[0]?.goal, prompt.workflowDraft.goal);
    assert.equal(snapshot.taskWorkflowStages.length, 0);
    assert.ok(snapshot.events.some(event=>event.kind==="sessionRun.prepared"
      &&(event.payload as {clientPromptId?:string;rawInputId?:string;workflow?:{id?:string}}).clientPromptId===prompt.clientPromptId
      &&(event.payload as {rawInputId?:string;workflow?:{id?:string}}).rawInputId===prepared.rawInputId
      &&(event.payload as {workflow?:{id?:string}}).workflow?.id===prepared.workflow?.id));
    assert.equal(store.sessionRunInputs(task.task.id, prepared.sessionRunId).rawText, prompt.message);
    await assert.rejects(store.startTaskWorkflow({ requestId: "empty-stage-start",
      expectedStoreRevision: snapshot.storeRevision, taskId: task.task.id, scope: task.task.scope,
      workflowId: prepared.workflow.id, expectedWorkflowRevision: prepared.workflow.revision }),
    (error: unknown) => error instanceof ProductStoreError && error.code === "REVISION_CONFLICT");
    await store.finishSessionRun({ sessionRunId: prepared.sessionRunId,
      providerAttemptId: prepared.providerAttemptId, outcome: "succeeded", assistantText: "正在形成阶段安排" });
    const revised = await store.reviseTaskWorkflow({ requestId: "first-workflow-revise",
      expectedStoreRevision: (await store.snapshot()).storeRevision, taskId: task.task.id,
      scope: task.task.scope, workflowId: prepared.workflow.id,
      expectedWorkflowRevision: prepared.workflow.revision, originRawInputId: prepared.rawInputId,
      goal: prompt.workflowDraft.goal, constraints: prompt.workflowDraft.constraints, stages });
    const started = await store.startTaskWorkflow({ requestId: "first-workflow-start",
      expectedStoreRevision: revised.storeRevision, taskId: task.task.id, scope: task.task.scope,
      workflowId: revised.workflow.id, expectedWorkflowRevision: revised.workflow.revision });
    assert.equal(started.run.status, "active");
    assert.equal(started.run.workflowId, prepared.workflow.id);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Workflow submission identity remains in Task and Session drafts across restart",async()=>{
  const root=await mkdtemp(join(tmpdir(),"dcode-workflow-pending-draft-"));
  const dataRoot=join(root,".dcode"),home=join(root,"home");await mkdir(home);
  let store=await ProductStore.open({dataRoot,userHome:home});
  try{
    const initial=await store.snapshot(),scope={kind:"user" as const,userId:initial.currentUser.id};
    const pending={promptId:"workflow-pending-1",kind:"create" as const,sourceDraftKey:"new:user",goal:"跨重启恢复目标",constraints:["保持原草稿"]};
    await store.setTaskDraft({requestId:"pending-new-task",expectedStoreRevision:0,scope,text:"普通未发送草稿",pendingWorkflowSubmission:pending});
    const created=await store.createTask({requestId:"pending-task",expectedStoreRevision:(await store.snapshot()).storeRevision,scope,title:"恢复任务",goal:"跨重启恢复目标"});
    assert.ok((await store.snapshot()).events.some(event=>event.kind==="task.created"&&event.taskId===created.task.id
      &&(event.payload as {requestId?:string}).requestId==="pending-task"));
    await store.setDCodeSessionComposerDraft({requestId:"pending-session",expectedStoreRevision:(await store.snapshot()).storeRevision,taskId:created.task.id,sessionId:created.coordinationSession.id,text:"工作流表单提交原文",pendingWorkflowSubmission:pending});
    await store.close();store=await ProductStore.open({dataRoot,userHome:home});
    const drafts=(await store.snapshot()).composerDrafts;
    assert.deepEqual(drafts.find(item=>item.draftKind==="new_task")?.pendingWorkflowSubmission,pending);
    assert.deepEqual(drafts.find(item=>item.sessionId===created.coordinationSession.id)?.pendingWorkflowSubmission,pending);
    await store.setDCodeSessionComposerDraft({requestId:"clear-pending-session",expectedStoreRevision:(await store.snapshot()).storeRevision,taskId:created.task.id,sessionId:created.coordinationSession.id,text:"工作流表单提交原文",pendingWorkflowSubmission:null});
    assert.equal((await store.snapshot()).composerDrafts.find(item=>item.sessionId===created.coordinationSession.id)?.pendingWorkflowSubmission,undefined);
  }finally{await store.close().catch(()=>undefined);await rm(root,{recursive:true,force:true});}
});

test("live Coordinator uses dcode_team to revise, start, stop and continue the first Workflow draft", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-workflow-tool-"));
  const dataRoot = join(root, ".dcode");
  const home = join(root, "home");
  const agentDir = join(root, "agent");
  await mkdir(home);
  await mkdir(agentDir);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "zai-coding-cn", defaultModel: "fixture" }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: {
    "zai-coding-cn": { baseUrl: "https://open.bigmodel.cn/api/paas/v4", api: "openai-completions",
      apiKey: "fixture-only", models: [{ id: "fixture", name: "Fixture", reasoning: false,
        input: ["text"], contextWindow: 100_000, maxTokens: 4_096 }] },
  } }));
  const previousFetch = globalThis.fetch;
  let coordinatorCalls = 0;
  let host: PiHost | undefined;
  const completion = (message: string, action?: unknown): Response => {
    const tool = action ? { index: 0, id: `workflow-tool-${coordinatorCalls}`, type: "function",
      function: { name: "dcode_team", arguments: JSON.stringify(action) } } : undefined;
    const chunk = { id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture",
      choices: [{ index: 0, delta: tool ? { role: "assistant", tool_calls: [tool] }
        : { role: "assistant", content: message }, finish_reason: null }] };
    const end = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } });
  };
  globalThis.fetch = (async (url, init) => {
    if (String(url).includes("quota/limit")) return Response.json({ success: true, code: 200,
      data: { limits: [{ type: "TOKENS_LIMIT", percentage: 98, nextResetTime: Date.now() + 3_600_000 }] } });
    const body = JSON.parse(String(init?.body)) as { tools?: Array<{ function?: { name?: string } }> };
    assert.ok(body.tools?.some(tool => tool.function?.name === "dcode_team"));
    coordinatorCalls++;
    if (coordinatorCalls === 1) return completion("", { action: "list" });
    const snapshot = await host!.handle("foundation.snapshot", {}) as {
      taskWorkflows: Array<{ id: string; revision: number }>;
      taskWorkflowRuns: Array<{ id: string; revision: number; status: string }>;
    };
    const workflow = snapshot.taskWorkflows[0]!;
    if (coordinatorCalls === 2) return completion("", { action: "workflow_revise",
      workflowId: workflow.id, expectedWorkflowRevision: workflow.revision,
      workflowGoal: "按两个有界阶段推进", workflowStages: stages });
    if (coordinatorCalls === 3) return completion("", { action: "workflow_start",
      workflowId: workflow.id, expectedWorkflowRevision: workflow.revision });
    const workflowRun=snapshot.taskWorkflowRuns[0]!;
    if (coordinatorCalls === 4) return completion("", { action: "workflow_stop",
      workflowRunId: workflowRun.id, expectedWorkflowRunRevision: workflowRun.revision,
      reason: "等待一次显式核对" });
    if (coordinatorCalls === 5) return completion("", { action: "workflow_continue",
      workflowRunId: workflowRun.id, expectedWorkflowRunRevision: workflowRun.revision });
    return completion("工作流已安排，阶段执行待后续派发");
  }) as typeof fetch;
  host = new PiHost({ agentDir, dataRoot, userHome: home, emit: () => {} });
  try {
    await host.start();
    const initial = await host.handle("foundation.snapshot", {}) as {
      storeRevision: number; currentUser: { id: string };
    };
    const task = await host.handle("task.create", { requestId: "tool-task",
      expectedStoreRevision: initial.storeRevision, scope: { kind: "user", userId: initial.currentUser.id },
      title: "首轮工作流", goal: "交付真实结果" }) as {
      task: { id: string }; coordinationSession: { id: string };
    };
    const submitted = await host.handle("dcodeSession.prompt", {
      dcodeSessionId: task.coordinationSession.id, promptId: "first-workflow-input",
      message: "用户原文：请分阶段完成", workflowDraft: { goal: "分阶段完成" },
    }) as { workflow?: { id: string }; rawInputId?: string;
      result?: { accepted?: boolean; workflow?: { id: string }; rawInputId?: string } };
    assert.equal(submitted.result?.accepted, true);
    assert.ok(submitted.workflow?.id);
    assert.equal(submitted.result?.workflow?.id, submitted.workflow?.id);
    assert.equal(submitted.rawInputId, submitted.result?.rawInputId);
    const deadline = Date.now() + 12_000;
    let latest: { taskWorkflows: Array<{ id: string; currentVersion: number }>;
      taskWorkflowRuns: Array<{ workflowId: string; status: string }>; tasks: Array<{ id: string }> };
    do {
      latest = await host.handle("foundation.snapshot", {}) as typeof latest;
      if (coordinatorCalls >= 6 && latest.taskWorkflowRuns.some(run => run.workflowId === submitted.workflow!.id && run.status === "active")) break;
      if (Date.now() >= deadline) throw new Error("Coordinator did not revise and start the Workflow draft");
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (true);
    assert.equal(latest.tasks.filter(item => item.id === task.task.id).length, 1);
    assert.equal(latest.taskWorkflows.find(item => item.id === submitted.workflow!.id)?.currentVersion, 2);
    assert.ok(coordinatorCalls >= 6);
  } finally {
    await host.close();
    globalThis.fetch = previousFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("Workflow delegation never reuses the same Coordinator's previous ordinary Team Run", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-workflow-team-identity-"));
  const dataRoot = join(root, ".dcode");
  const home = join(root, "home");
  await mkdir(home);
  const store = await ProductStore.open({ dataRoot, userHome: home });
  try {
    const initial = await store.snapshot();
    const task = await store.createTask({ requestId: "team-identity-task", expectedStoreRevision: 0,
      scope: { kind: "user", userId: initial.currentUser.id }, title: "不同团队来源",
      goal: "普通工作结束后再执行工作流" });
    const owner = await store.ensureCoordinatorAgentRun({ requestId: "team-identity-owner",
      taskId: task.task.id, scope: task.task.scope });
    const source = await store.prepareSessionRun({ requestId: "team-identity-source",
      taskId: task.task.id, scope: task.task.scope, sessionId: task.coordinationSession.id,
      agentRunId: owner.agentRun.id, runtimeId: "team-identity-runtime",
      workspaceId: "team-identity-workspace", cwd: home, workspaceAccess: "sharedReadOnly",
      message: "稍后开始工作流", attachmentRefs: [], roleRevision: "coordinator:v1",
      contextRevision: 1, profileSnapshot: { role: "coordinator" }, tools: [], toolsWritable: false,
      systemPromptDigest: `sha256:${"f".repeat(64)}`, promptSources: [],
    });
    await store.finishSessionRun({ sessionRunId: source.sessionRunId,
      providerAttemptId: source.providerAttemptId, outcome: "succeeded", assistantText: "先完成普通团队" });
    const ordinary = await store.createTeamRun({ requestId: "ordinary-team", taskId: task.task.id,
      scope: task.task.scope, coordinatorAgentRunId: owner.agentRun.id,
      members: [{ profileId: "builtin-explore", title: "普通调研", taskPacket: { instruction: "普通任务" } }] });
    const ordinaryMember = ordinary.childAgentRuns[0]!;
    const ordinaryRun = await store.prepareSessionRun({ requestId: "ordinary-member-run",
      taskId: task.task.id, scope: task.task.scope, sessionId: ordinaryMember.sessionId,
      agentRunId: ordinaryMember.id, runtimeId: "ordinary-member-runtime",
      workspaceId: "ordinary-member-workspace", cwd: home, workspaceAccess: "sharedReadOnly",
      message: "完成普通调研", attachmentRefs: [], roleRevision: "explore:v1",
      contextRevision: 1, profileSnapshot: { role: "explore" }, tools: [], toolsWritable: false,
      systemPromptDigest: `sha256:${"f".repeat(64)}`, promptSources: [],
    });
    await store.finishSessionRun({ sessionRunId: ordinaryRun.sessionRunId,
      providerAttemptId: ordinaryRun.providerAttemptId, outcome: "succeeded", assistantText: "普通调研已完成" });
    assert.equal((await store.snapshot()).teamRuns.find(item => item.id === ordinary.teamRun.id)?.status, "completed");
    const workflow = await store.createTaskWorkflow({ requestId: "new-workflow-after-team",
      expectedStoreRevision: (await store.snapshot()).storeRevision,
      taskId: task.task.id, scope: task.task.scope, originRawInputId: source.rawInputId,
      goal: "启动不同来源的阶段", stages: [stages[0]!] });
    const run = await store.startTaskWorkflow({ requestId: "start-after-ordinary-team",
      expectedStoreRevision: workflow.storeRevision, taskId: task.task.id, scope: task.task.scope,
      workflowId: workflow.workflow.id, expectedWorkflowRevision: workflow.workflow.revision });
    const oldDirected = await store.queueCollaborationMessage({ requestId: "old-member-user-input",
      taskId: task.task.id, sourceSessionId: task.coordinationSession.id,
      targetAgentRunId: ordinaryMember.id, author: "user",
      text: "旧普通成员请先等待工作流收口" });
    assert.equal(oldDirected.message.state, "paused");
    assert.notEqual(oldDirected.message.originRawInputId, source.rawInputId);
    const oldCoordinatorMessage = await store.queueCollaborationMessage({ requestId: "old-member-coordinator-input",
      taskId: task.task.id, sourceSessionId: task.coordinationSession.id,
      targetAgentRunId: ordinaryMember.id, author: "coordinator",
      originRawInputId: oldDirected.message.originRawInputId,
      text: "旧普通成员的新安排必须等待核对" });
    assert.equal(oldCoordinatorMessage.message.state, "paused");
    const oldSteer = await store.queueCollaborationMessage({ requestId: "old-member-steer-input",
      taskId: task.task.id, sourceSessionId: task.coordinationSession.id,
      targetAgentRunId: ordinaryMember.id, author: "user",
      text: "旧成员的即时补充也先保留", deliveryMode: "steer",
      targetSessionRunId: "stale-old-member-run" });
    assert.equal(oldSteer.message.state, "paused");
    assert.equal(oldSteer.message.deliveryMode, undefined);
    assert.equal((await store.snapshot()).teamRuns.find(item => item.id === ordinary.teamRun.id)?.status,
      "completed", "旧 Team Run 不得被定向输入重开");
    const delegated = await store.createTeamRun({ requestId: "first-workflow-member",
      taskId: task.task.id, scope: task.task.scope, coordinatorAgentRunId: owner.agentRun.id,
      workflowRunId: run.run.id, members: [{ profileId: "builtin-worker", title: "工作流阶段成员",
        taskPacket: { instruction: "只执行工作流阶段", acceptance: "独立核查", workflowStageId: "build" } }] });
    assert.notEqual(delegated.teamRun.id, ordinary.teamRun.id);
    const snapshot = await store.snapshot();
    assert.equal(snapshot.teamRuns.find(item => item.id === ordinary.teamRun.id)?.status, "completed");
    assert.equal(snapshot.teamRuns.find(item => item.id === delegated.teamRun.id)?.status, "active");
    await store.stopTaskWorkflow({ requestId: "team-identity-workflow-stop",
      expectedStoreRevision: snapshot.storeRevision, taskId: task.task.id, scope: task.task.scope,
      runId: run.run.id, expectedRunRevision: run.run.revision, reason: "暂停工作流后续推进" });
    await store.finishTeamRun({ requestId: "team-identity-stage-abort", taskId: task.task.id,
      teamRunId: delegated.teamRun.id, status: "aborted", reason: "清理阶段成员" });
    for (const message of [oldDirected.message, oldCoordinatorMessage.message, oldSteer.message]) {
      await store.transitionCollaborationMessage({ requestId: `reconcile-${message.id}`,
        id: message.id, expectedRevision: message.revision, state: "cancelled",
        error: "原文已记录，待工作流收口后重派" });
    }
    await assert.rejects(store.continueRouteMember({ requestId: "old-member-while-workflow-stopped",
      taskId: task.task.id, coordinatorAgentRunId: owner.agentRun.id,
      agentRunId: ordinaryMember.id, instruction: "普通成员旧工作暂不续派",
      acceptance: "工作流收口后核对", route: { purpose: "independent", reason: "另行安排" },
      sourceSessionId: task.coordinationSession.id,
      originRawInputId: oldDirected.message.originRawInputId }),
    (error: unknown) => error instanceof ProductStoreError && error.code === "REVISION_CONFLICT");
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Workflow cannot bind a Route Work Item and skip its original dependency contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-workflow-route-boundary-"));
  const dataRoot = join(root, ".dcode");
  const home = join(root, "home");
  await mkdir(home);
  let store = await ProductStore.open({ dataRoot, userHome: home });
  try {
    const initial = await store.snapshot();
    const task = await store.createTask({ requestId: "route-boundary-task", expectedStoreRevision: 0,
      scope: { kind: "user", userId: initial.currentUser.id }, title: "原路线依赖",
      goal: "不能绕过工作项依赖" });
    const source = await store.prepareSessionRun({ requestId: "route-boundary-source",
      taskId: task.task.id, scope: task.task.scope, sessionId: task.coordinationSession.id,
      runtimeId: "route-boundary-runtime", workspaceId: "route-boundary-workspace",
      cwd: home, workspaceAccess: "exclusiveWrite", message: "建立任务工作流",
      attachmentRefs: [], roleRevision: "coordinator:v1", contextRevision: 1,
      profileSnapshot: { role: "coordinator" }, tools: [], toolsWritable: false,
      systemPromptDigest: `sha256:${"f".repeat(64)}`, promptSources: [],
    });
    await store.finishSessionRun({ sessionRunId: source.sessionRunId,
      providerAttemptId: source.providerAttemptId, outcome: "succeeded", assistantText: "待形成安排" });
    const workflow = await store.createTaskWorkflow({ requestId: "route-boundary-workflow",
      expectedStoreRevision: (await store.snapshot()).storeRevision,
      taskId: task.task.id, scope: task.task.scope, originRawInputId: source.rawInputId,
      goal: "执行阶段", stages: [stages[0]!] });
    const run = await store.startTaskWorkflow({ requestId: "route-boundary-start",
      expectedStoreRevision: workflow.storeRevision, taskId: task.task.id, scope: task.task.scope,
      workflowId: workflow.workflow.id, expectedWorkflowRevision: workflow.workflow.revision });
    const work = await store.createTaskWorkItem({ requestId: "route-boundary-work",
      expectedStoreRevision: run.storeRevision, taskId: task.task.id, scope: task.task.scope,
      title: "带原路线前置条件的工作" });
    await store.close();
    const database = new DatabaseSync(join(dataRoot, "product-store.sqlite3"));
    try {
      database.prepare("UPDATE task_work_items SET details_json = ? WHERE id = ?").run(JSON.stringify({
        routeWork: { planId: "route-plan", round: 1, candidateId: "candidate",
          completion: "核对原路线的前置工作", dependsOn: ["not-yet-completed"] },
      }), work.taskWorkItem.id);
    } finally { database.close(); }
    store = await ProductStore.open({ dataRoot, userHome: home });
    const interrupted = (await store.snapshot()).taskWorkflowRuns.find(item => item.id === run.run.id)!;
    const continued = await store.continueTaskWorkflow({ requestId: "route-boundary-continue",
      expectedStoreRevision: (await store.snapshot()).storeRevision,
      taskId: task.task.id, scope: task.task.scope, runId: run.run.id,
      expectedRunRevision: interrupted.revision });
    await assert.rejects(store.bindTaskWorkflowWorkItem({ requestId: "route-boundary-bind",
      expectedStoreRevision: continued.storeRevision, taskId: task.task.id,
      scope: task.task.scope, runId: run.run.id, expectedRunRevision: continued.run.revision,
      stageId: "build", workItemId: work.taskWorkItem.id }),
    (error: unknown) => error instanceof ProductStoreError && error.code === "INVALID_ARGUMENT");
  } finally {
    await store.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
