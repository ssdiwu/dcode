import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {ProductStore,type AgentRunRecord} from "../src/product-store.js";

test("independent verification preserves work ownership, rejects stale/self evidence, and records bounded rework separately from acceptance",async()=>{
  const root=await mkdtemp(join(tmpdir(),"dcode-verification-")),home=join(root,"home");await mkdir(home);
  const store=await ProductStore.open({dataRoot:join(root,".dcode"),userHome:home});let serial=0;
  try {
    const initial=await store.snapshot();const scope={kind:"user" as const,userId:initial.currentUser.id};
    const task=await store.createTask({requestId:"task",expectedStoreRevision:initial.storeRevision,scope,title:"验收循环",goal:"局部返工并保留其他工作"});
    const owner=await store.ensureCoordinatorAgentRun({requestId:"owner",taskId:task.task.id,scope});
    const team=await store.createTeamRun({requestId:"team",taskId:task.task.id,scope,coordinatorAgentRunId:owner.agentRun.id,members:[{profileId:"builtin-explore",title:"工作 A",taskPacket:{}},{profileId:"builtin-explore",title:"工作 B",taskPacket:{}},{profileId:"builtin-verifier",title:"验收 A",taskPacket:{}},{profileId:"builtin-verifier",title:"验收 B",taskPacket:{}}]});
    const [a,b,va,vb]=team.childAgentRuns as [AgentRunRecord,AgentRunRecord,AgentRunRecord,AgentRunRecord];
    const start=async(agent:AgentRunRecord)=>{
      const id=`run-${++serial}`;
      const prepared=await store.prepareSessionRun({requestId:id,taskId:task.task.id,scope,sessionId:agent.sessionId,runtimeId:`runtime-${agent.id}`,agentRunId:agent.id,workspaceId:`workspace-${agent.id}`,cwd:home,workspaceAccess:"sharedReadOnly",message:id,attachmentRefs:[],roleRevision:`${agent.role}:v1`,contextRevision:1,profileSnapshot:{role:agent.role},tools:[{name:"read",description:"Read test fixture",parameters:{type:"object"}}],toolsWritable:false,systemPromptDigest:`sha256:${"f".repeat(64)}`,promptSources:[]});
      await store.startSessionRun(prepared.sessionRunId);return prepared;
    };
    const finish=async(agent:AgentRunRecord)=>{const run=await start(agent);await store.finishSessionRun({sessionRunId:run.sessionRunId,providerAttemptId:run.providerAttemptId,outcome:"succeeded",assistantText:`${agent.id} 结果版本 ${serial}`});return (await store.snapshot()).agentReports.filter(report=>report.agentRunId===agent.id).at(-1)!;};
    const aReport=await finish(a);await finish(b);
    const verifierRun=await start(va);
    const attempt=await store.prepareToolAttempt({taskId:task.task.id,sessionId:va.sessionId,sessionRunId:verifierRun.sessionRunId,toolCallId:"read-artifact",toolName:"read",parameterDigest:`sha256:${"1".repeat(64)}`});
    await store.finishOperationAttempt({attemptId:attempt.attemptId,outcome:"succeeded",resultDigest:`sha256:${"2".repeat(64)}`});
    const evidence=await store.recordToolEvidence({requestId:"evidence",attemptId:attempt.attemptId,toolName:"read",outcome:"succeeded",resultDigest:`sha256:${"2".repeat(64)}`});
    const base={taskId:task.task.id,verifierAgentRunId:va.id,subjectReportId:aReport.id,evidenceIds:[evidence.evidence.id],findings:[{kind:"product" as const,description:"缺少必要内容"}],summary:"实际检查发现缺项",verdict:"fail" as const};
    await assert.rejects(store.submitVerification({...base,requestId:"other-evidence",verifierAgentRunId:vb.id}),/本人/);
    await assert.rejects(store.submitVerification({...base,requestId:"empty-proof",verdict:"pass",findings:[],evidenceIds:[]}),/独立证据/);
    const failed=await store.submitVerification({...base,requestId:"failed"});
    await assert.rejects(store.reviewVerification({requestId:"wrong-accept",taskId:task.task.id,coordinatorAgentRunId:owner.agentRun.id,verificationId:failed.verification.id,outcome:"accepted",reason:"直接通过"}),/未通过/);
    await store.reviewVerification({requestId:"rework",taskId:task.task.id,coordinatorAgentRunId:owner.agentRun.id,verificationId:failed.verification.id,outcome:"rework",reason:"仅补齐工作 A 缺项"});
    const assignments=new Map(team.assignments.map(assignment=>[assignment.agentRunId,assignment.id]));
    let snapshot=await store.snapshot();assert.equal(snapshot.taskWorkItems.find(item=>item.ownerAssignmentId===assignments.get(a.id))?.state,"in_progress");assert.equal(snapshot.taskWorkItems.find(item=>item.ownerAssignmentId===assignments.get(b.id))?.state,"completed");
    const repeated=await store.submitVerification({...base,requestId:"same-evidence"});
    await assert.rejects(store.reviewVerification({requestId:"repeat-without-change",taskId:task.task.id,coordinatorAgentRunId:owner.agentRun.id,verificationId:repeated.verification.id,outcome:"rework",reason:"再试一次"}),/调整方法/);
    await store.reviewVerification({requestId:"change-method",taskId:task.task.id,coordinatorAgentRunId:owner.agentRun.id,verificationId:repeated.verification.id,outcome:"recheck",reason:"确认检查依据",strategyChange:"直接检查保存文件，不再只核对摘要"});
    const newReport=await finish(a);
    await assert.rejects(store.submitVerification({...base,requestId:"stale",verdict:"pass",findings:[]}),/新版/);
    await assert.rejects(store.submitVerification({...base,requestId:"old-proof",subjectReportId:newReport.id,verdict:"pass",findings:[]}),/早于当前报告/);
    const freshAttempt=await store.prepareToolAttempt({taskId:task.task.id,sessionId:va.sessionId,sessionRunId:verifierRun.sessionRunId,toolCallId:"read-current-artifact",toolName:"read",parameterDigest:`sha256:${"3".repeat(64)}`});
    await store.finishOperationAttempt({attemptId:freshAttempt.attemptId,outcome:"succeeded",resultDigest:`sha256:${"4".repeat(64)}`});
    const freshEvidence=await store.recordToolEvidence({requestId:"fresh-evidence",attemptId:freshAttempt.attemptId,toolName:"read",outcome:"succeeded",resultDigest:`sha256:${"4".repeat(64)}`});
    const selfReport=await finish(vb);
    await assert.rejects(store.submitVerification({...base,requestId:"self-verification",verifierAgentRunId:vb.id,subjectReportId:selfReport.id,evidenceIds:[]}),/不同于执行者/);
    const passed=await store.submitVerification({...base,requestId:"passed",subjectReportId:newReport.id,evidenceIds:[freshEvidence.evidence.id],verdict:"pass",findings:[],summary:"必要内容已核对"});
    await store.reviewVerification({requestId:"accepted",taskId:task.task.id,coordinatorAgentRunId:owner.agentRun.id,verificationId:passed.verification.id,outcome:"accepted",reason:"核对覆盖范围与保存证据后通过"});
    snapshot=await store.snapshot();assert.equal(snapshot.tasks[0]!.state,"active");assert.equal(snapshot.coordinatorReviews?.length,3);assert.equal(snapshot.verifications?.length,3);assert.equal(snapshot.taskWorkItems.find(item=>item.ownerAssignmentId===assignments.get(a.id))?.state,"completed");
  } finally {await store.close();await rm(root,{recursive:true,force:true});}
});
