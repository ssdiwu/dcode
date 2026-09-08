import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProductStore,type AgentRunRecord} from '../src/product-store.js';
import {createDCodeFactsExtension} from '../src/dcode-facts.js';

test('native facts preserve Session/Task/actor/run boundaries and never infer file statistics',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dcode-session-facts-')),home=join(root,'home');await mkdir(home);
 const store=await ProductStore.open({dataRoot:join(root,'.dcode'),userHome:home});let serial=0;
 try{
  const initial=await store.snapshot(),scope={kind:'user' as const,userId:initial.currentUser.id};
  const task=await store.createTask({requestId:'a',expectedStoreRevision:initial.storeRevision,scope,title:'Task A',goal:'Facts scope'});
  const owner=(await store.ensureCoordinatorAgentRun({requestId:'owner',taskId:task.task.id,scope})).agentRun;
  const team=await store.createTeamRun({requestId:'team',taskId:task.task.id,scope,coordinatorAgentRunId:owner.id,members:[{profileId:'builtin-verifier',title:'Verifier',taskPacket:{}}]});
  const other=await store.createTask({requestId:'b',expectedStoreRevision:(await store.snapshot()).storeRevision,scope,title:'Task B',goal:'Other Task'});
  const otherOwner=(await store.ensureCoordinatorAgentRun({requestId:'other-owner',taskId:other.task.id,scope})).agentRun;
  const start=async(agent:AgentRunRecord)=>{const id='run-'+(++serial);const run=await store.prepareSessionRun({requestId:id,taskId:agent.taskId,scope,sessionId:agent.sessionId,runtimeId:'runtime-'+agent.id,agentRunId:agent.id,workspaceId:'workspace-'+agent.id,cwd:home,workspaceAccess:'sharedReadOnly',message:id,attachmentRefs:[],roleRevision:agent.role+':v1',contextRevision:1,profileSnapshot:{role:agent.role},tools:[{name:'read',description:'fixture',parameters:{type:'object'}}],toolsWritable:false,systemPromptDigest:'sha256:'+'f'.repeat(64),promptSources:[]});await store.startSessionRun(run.sessionRunId);return run;};
  const record=async(agent:AgentRunRecord,run:Awaited<ReturnType<typeof start>>,tool:string)=>{const id='call-'+(++serial);const a=await store.prepareToolAttempt({taskId:agent.taskId,sessionId:agent.sessionId,sessionRunId:run.sessionRunId,toolCallId:id,toolName:tool,parameterDigest:'sha256:'+'1'.repeat(64)});await store.finishOperationAttempt({attemptId:a.attemptId,outcome:'succeeded',resultDigest:'sha256:'+'2'.repeat(64)});return (await store.recordToolEvidence({requestId:id,attemptId:a.attemptId,toolName:tool,outcome:'succeeded',resultDigest:'sha256:'+'2'.repeat(64)})).evidence;};
  const oldRun=await start(owner),old=await record(owner,oldRun,'write');await store.finishSessionRun({sessionRunId:oldRun.sessionRunId,providerAttemptId:oldRun.providerAttemptId,outcome:'succeeded',assistantText:'Previous check'});
  const run=await start(owner),fresh=await record(owner,run,'read');
  const peer=team.childAgentRuns[0]!,peerRun=await start(peer),peerEvidence=await record(peer,peerRun,'read');
  const otherRun=await start(otherOwner),otherEvidence=await record(otherOwner,otherRun,'read');
  const identity={taskId:owner.taskId,sessionId:owner.sessionId,agentRunId:owner.id,sessionRunId:run.sessionRunId};
  const facts=store.nativeSessionFacts(identity,'evidence');assert.equal(facts.totalEvidence,2);
  assert.equal(facts.evidence.find(e=>e.id===fresh.id)?.isCurrentRun,true);assert.equal(facts.evidence.find(e=>e.id===old.id)?.isCurrentRun,false);
  assert.ok(!JSON.stringify(facts).includes(peerEvidence.id));assert.ok(!JSON.stringify(facts).includes(otherEvidence.id));
  assert.ok(store.nativeSessionFacts({...identity,agentRunId:peer.id},'evidence').evidence.every(e=>!e.isCurrentRun));
  assert.throws(()=>store.nativeSessionFacts({...identity,taskId:other.task.id},'evidence'),/does not belong/);
  const changes=store.nativeSessionFacts(identity,'changes');assert.deepEqual(changes.evidence.map(e=>e.id),[old.id]);assert.deepEqual(changes.historicalFileChanges,[]);
  assert.ok(changes.evidence.every(e=>!('additions' in e)&&!('filePath' in e)&&!('gitRevision' in e)));
  let tool:any;createDCodeFactsExtension({sessionId:()=>owner.sessionId,cwd:()=>home,paths:()=>[],nativeFacts:async kind=>store.nativeSessionFacts(identity,kind)},{factsDir:join(root,'missing-ledger')})({registerTool:(value:any)=>tool=value} as never);
  const rendered=await tool.execute('facts',{kind:'changes'});assert.match(rendered.content[0].text,/currentFileStatisticsAvailable": false/);assert.ok(rendered.content[0].text.includes(old.id));
  const revision=(await store.snapshot()).storeRevision;await tool.execute('facts',{kind:'evidence'});assert.equal((await store.snapshot()).storeRevision,revision,'facade is read-only');
 }finally{await store.close();await rm(root,{recursive:true,force:true});}
});

test('native source failure cannot fall back to legacy evidence or claim available',async()=>{
 let tool:any;createDCodeFactsExtension({sessionId:()=> 'native',cwd:()=>'/tmp',paths:()=>[],nativeFacts:async()=>{throw Error('Native store unavailable');}},{factsDir:'/not-a-ledger'})({registerTool:(value:any)=>tool=value} as never);
 const result=await tool.execute('facts',{kind:'evidence'});assert.equal(result.details.available,false);assert.match(result.content[0].text,/Native store unavailable/);
});
