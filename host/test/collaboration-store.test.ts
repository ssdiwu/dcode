import {DatabaseSync} from "node:sqlite";
import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {ProductStore} from "../src/product-store.js";

test("recovery pauses unsent input, marks uncertain delivery interrupted, and never resurrects an execution PID",async()=>{
  const root=await mkdtemp(join(tmpdir(),"dcode-collab-recovery-")),home=join(root,"home");await mkdir(home);
  const options={dataRoot:join(root,".dcode"),userHome:home};let store=await ProductStore.open(options);
  try {
    const initial=await store.snapshot();const scope={kind:"user" as const,userId:initial.currentUser.id};
    const task=await store.createTask({requestId:"task",expectedStoreRevision:initial.storeRevision,scope,title:"恢复验证",goal:"保存待发送消息"});
    const owner=await store.ensureCoordinatorAgentRun({requestId:"owner",taskId:task.task.id,scope});
    const team=await store.createTeamRun({requestId:"members",taskId:task.task.id,scope,coordinatorAgentRunId:owner.agentRun.id,members:[{profileId:"builtin-explore",title:"草稿目标",taskPacket:{instruction:"检查"}}]});
    await store.setDCodeSessionComposerDraft({requestId:"target-draft",expectedStoreRevision:(await store.snapshot()).storeRevision,taskId:task.task.id,sessionId:task.coordinationSession.id,text:"@草稿目标 补充说明",targetAgentRunId:team.childAgentRuns[0]!.id});
    const input={taskId:task.task.id,sourceSessionId:task.coordinationSession.id,targetAgentRunId:owner.agentRun.id,author:"user" as const};
    const first=await store.queueCollaborationMessage({...input,requestId:"first",text:"已经交给模型的工作"});
    await store.transitionCollaborationMessage({requestId:"delivering",id:first.message.id,expectedRevision:1,state:"delivering"});
    const second=await store.queueCollaborationMessage({...input,requestId:"second",text:"尚未发送的工作"});
    assert.equal((await store.queueCollaborationMessage({...input,requestId:"second",text:"尚未发送的工作"})).message.id,second.message.id);
    await store.recordAgentProcess({requestId:"process",taskId:task.task.id,agentRunId:owner.agentRun.id,runtimeId:"runtime-fixture",process:{executionId:"execution-fixture",pid:12345,startedAt:new Date().toISOString(),status:"running"}});
    await store.close();store=await ProductStore.open(options);
    const restored=store.collaborationMessages();
    const recoveredDraft=(await store.snapshot()).composerDrafts.find(draft=>draft.sessionId===task.coordinationSession.id);
    assert.equal(recoveredDraft?.targetAgentRunId,team.childAgentRuns[0]!.id);assert.equal(recoveredDraft?.text,"@草稿目标 补充说明");
    assert.equal(restored.find(message=>message.id===first.message.id)?.state,"interrupted");
    assert.equal(restored.find(message=>message.id===second.message.id)?.state,"paused");
    assert.equal(restored.find(message=>message.id===second.message.id)?.originRawInputId,second.message.originRawInputId);
    assert.equal(store.agentProcessExecutions()[0]?.process.status,"exited");assert.equal(store.agentProcessExecutions()[0]?.process.exitReason,"supervisor_restarted");
    await assert.rejects(store.transitionCollaborationMessage({requestId:"unsafe-replay",id:first.message.id,expectedRevision:3,state:"queued"}),/不能执行/);
    const resumed=await store.transitionCollaborationMessage({requestId:"resume-unsent",id:second.message.id,expectedRevision:2,state:"queued"});assert.equal(resumed.message.text,"尚未发送的工作");
  } finally {await store.close();await rm(root,{recursive:true,force:true});}
});

test("pending messages can be edited and reordered without rewriting submitted originals or replaying in-flight input",async()=>{
  const root=await mkdtemp(join(tmpdir(),"dcode-message-edit-")),home=join(root,"home");await mkdir(home);const options={dataRoot:join(root,".dcode"),userHome:home};let store=await ProductStore.open(options);
  try{
    const initial=await store.snapshot(),scope={kind:"user" as const,userId:initial.currentUser.id};
    const task=await store.createTask({requestId:"task",expectedStoreRevision:initial.storeRevision,scope,title:"队列编辑",goal:"原文保留"});
    const owner=await store.ensureCoordinatorAgentRun({requestId:"owner",taskId:task.task.id,scope});
    const base={taskId:task.task.id,sourceSessionId:task.coordinationSession.id,targetAgentRunId:owner.agentRun.id,author:"user" as const};
    const a=(await store.queueCollaborationMessage({...base,requestId:"a",text:"第一项原文"})).message;
    const b=(await store.queueCollaborationMessage({...base,requestId:"b",text:"第二项原文"})).message;
    await assert.rejects(store.editCollaborationMessage({requestId:"edit-running-queue",id:a.id,expectedRevision:1,text:"先暂停才能改"}),/已暂停/);
    await store.transitionCollaborationMessage({requestId:"pause",id:a.id,expectedRevision:1,state:"paused"});
    const edited=(await store.editCollaborationMessage({requestId:"edit",id:a.id,expectedRevision:2,text:"第一项修订"})).message;
    assert.equal(edited.state,"paused");assert.equal(edited.previousRawInputId,a.originRawInputId);assert.notEqual(edited.originRawInputId,a.originRawInputId);
    const order={requestId:"order",expectedQueueRevision:0,sessionId:task.coordinationSession.id,messages:[{id:b.id,revision:b.revision},{id:edited.id,revision:edited.revision}]};
    await store.reorderCollaborationMessages(order);assert.deepEqual(store.collaborationMessages().map(message=>message.id),[b.id,a.id]);
    await assert.rejects(store.reorderCollaborationMessages({...order,requestId:"duplicates",messages:[order.messages[0]!,order.messages[0]!]}),/已改变/);
    await assert.rejects(store.reorderCollaborationMessages({...order,requestId:"stale-identical-messages"}),/顺序已改变/);
    await store.close();store=await ProductStore.open(options);
    const restored=store.collaborationMessages();assert.deepEqual(restored.map(message=>message.id),[b.id,a.id]);assert.equal(restored[1]!.text,"第一项修订");assert.equal(restored[1]!.originRawInputId,edited.originRawInputId);
    const db=new DatabaseSync(join(root,".dcode","product-store.sqlite3"),{readOnly:true});try{assert.equal((db.prepare("SELECT submitted_text FROM raw_inputs WHERE id=?").get(a.originRawInputId) as {submitted_text:string}).submitted_text,"第一项原文");assert.equal((db.prepare("SELECT submitted_text FROM raw_inputs WHERE id=?").get(edited.originRawInputId) as {submitted_text:string}).submitted_text,"第一项修订");}finally{db.close();}
    const resumed=await store.transitionCollaborationMessage({requestId:"resume",id:b.id,expectedRevision:restored[0]!.revision,state:"queued"});await store.transitionCollaborationMessage({requestId:"deliver",id:b.id,expectedRevision:resumed.message.revision,state:"delivering"});
    await assert.rejects(store.reorderCollaborationMessages({...order,requestId:"late-order"}),/已改变/);
    await assert.rejects(store.editCollaborationMessage({requestId:"late-edit",id:b.id,expectedRevision:resumed.message.revision+1,text:"不能修改在途输入"}),/已暂停/);
  }finally{await store.close();await rm(root,{recursive:true,force:true});}
});
