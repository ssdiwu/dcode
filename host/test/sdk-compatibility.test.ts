import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,realpath,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {zstdDecompressSync} from 'node:zlib';
import {createReadToolDefinition,createWriteToolDefinition,createEditToolDefinition,createBashToolDefinition,createGrepToolDefinition,createFindToolDefinition,createLsToolDefinition,SessionManager,ModelRuntime,type ExtensionToolContext} from '@earendil-works/pi-coding-agent';
import type {AgentSession} from '@earendil-works/pi-coding-agent';
import {PiHost} from '../src/pi-host.js';
import {ProductStore,type FoundationSnapshot,type TaskBundle} from '../src/product-store.js';
import {ProcessAgent} from '../src/process-agent.js';
import {streamSimple as codexStream} from '@earendil-works/pi-ai/api/openai-codex-responses';
import {Type} from 'typebox';
import {createAssistantMessageEventStream,type AssistantMessage,type Model} from '@earendil-works/pi-ai';
import {getBuiltinModels} from '@earendil-works/pi-ai/providers/all';
const until=async(check:()=>boolean|Promise<boolean>,label:string)=>{const end=Date.now()+12000;while(!await check()){if(Date.now()>end)throw new Error(label);await new Promise(resolve=>setTimeout(resolve,10));}};
const output=(value:{content:Array<{type:string;text?:string}>})=>value.content.filter(part=>part.type==='text').map(part=>part.text).join('\n');

test('pinned SDK provides GPT-6.1 Sol plus GPT-6 Sol and Luna offline for API and Codex connections',()=>{
 for(const provider of ['openai','openai-codex'] as const){
  const models=getBuiltinModels(provider);
  for(const id of ['gpt-6-sol','gpt-6-luna','gpt-6.1-sol'])assert.ok(models.some(model=>model.id===id&&model.provider===provider));
 }
});

test('SDK built-in tools obey the current context cwd when it differs from their construction directory',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dcode-sdk-cwd-')),a=join(root,'a'),b=join(root,'b');const oldAgentDir=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=join(root,'agent');await mkdir(a);await mkdir(b);await writeFile(join(a,'seed.txt'),'from A');await writeFile(join(b,'seed.txt'),'from B');const ctx={cwd:await realpath(b),sessionManager:SessionManager.inMemory(b),tools:[],executeTool:async()=>{throw new Error('Nested calls are outside this direct built-in tool test');}} as unknown as ExtensionToolContext;
 try{
  assert.match(output(await createReadToolDefinition(a).execute('read',{path:'seed.txt'},undefined,undefined,ctx)),/from B/);
  await createWriteToolDefinition(a).execute('write',{path:'new.md',content:'before edit'},undefined,undefined,ctx);
  await createEditToolDefinition(a).execute('edit',{path:'new.md',edits:[{oldText:'before edit',newText:'after edit'}]},undefined,undefined,ctx);
  assert.equal(await readFile(join(b,'new.md'),'utf8'),'after edit');await assert.rejects(readFile(join(a,'new.md')),{code:'ENOENT'});
  assert.match(output(await createGrepToolDefinition(a).execute('grep',{pattern:'from B',path:'.'},undefined,undefined,ctx)),/seed\.txt/);
  assert.match(output(await createFindToolDefinition(a).execute('find',{pattern:'*.txt',path:'.'},undefined,undefined,ctx)),/seed\.txt/);
  assert.match(output(await createLsToolDefinition(a).execute('ls',{path:'.'},undefined,undefined,ctx)),/new\.md/);
  assert.equal(output(await createBashToolDefinition(a).execute('bash',{command:'pwd'},undefined,undefined,ctx)).trim(),await realpath(b));assert.equal(await readFile(join(a,'seed.txt'),'utf8'),'from A');
 }finally{if(oldAgentDir===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=oldAgentDir;await rm(root,{recursive:true,force:true});}
});

function completion(text:string,commands?:string[]){
 const chunk=(delta:unknown)=>({id:'sdk-fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason:null}]});
 const frames:unknown[]=[];
 if(commands)for(const [index,command] of commands.entries()){
  const args=JSON.stringify({command}),cut=Math.floor(args.length/2);
  frames.push(chunk({role:'assistant',tool_calls:[{index,id:`sdk-tool-${index}`,type:'function',function:{name:'bash',arguments:args.slice(0,cut)}}]}));
  frames.push(chunk({tool_calls:[{index,function:{arguments:args.slice(cut)}}]}));
 }else frames.push(chunk({role:'assistant',content:text}));
 frames.push({id:'sdk-fixture',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:commands?'tool_calls':'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}});
 return new Response(frames.map(frame=>`data: ${JSON.stringify(frame)}\n\n`).join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
}
async function fixture(fetcher:(body:any,init?:RequestInit)=>Promise<Response>){
 const root=await mkdtemp(join(tmpdir(),'dcode-sdk-host-')),agent=join(root,'agent'),home=join(root,'home');await mkdir(agent);await mkdir(home);await writeFile(join(agent,'settings.json'),JSON.stringify({defaultProvider:'zai-coding-cn',defaultModel:'fixture',steeringMode:'all',compaction:{enabled:false,keepRecentTokens:64,reserveTokens:256},retry:{enabled:false}}));await writeFile(join(agent,'models.json'),JSON.stringify({providers:{'zai-coding-cn':{baseUrl:'https://open.bigmodel.cn/api/paas/v4',api:'openai-completions',apiKey:'fixture-only',models:[{id:'fixture',name:'Fixture',reasoning:true,input:['text'],contextWindow:100000,maxTokens:4096}]}}}));
 const previous=globalThis.fetch;globalThis.fetch=(async(url,init)=>String(url).includes('quota/limit')?Response.json({success:true,code:200,data:{limits:[{type:'TOKENS_LIMIT',percentage:20,nextResetTime:Date.now()+3600000}]}}):fetcher(JSON.parse(String(init?.body)),init)) as typeof fetch;
 const events:Array<{event:string;data:any}>=[];const host=new PiHost({agentDir:agent,sessionsDirectory:join(agent,'sessions'),dataRoot:join(root,'.dcode'),userHome:home,emit:(event,data)=>{events.push({event,data});}});await host.start();const snapshot=()=>host.handle('foundation.snapshot',{}) as Promise<FoundationSnapshot>,snap=await snapshot();const task=await host.handle('task.create',{requestId:'task',expectedStoreRevision:snap.storeRevision,scope:{kind:'user',userId:snap.currentUser.id},title:'SDK 行为验证',goal:'边界完整且不重放'}) as TaskBundle;
 const store=(host as unknown as {productStore:ProductStore}).productStore,owner=await store.ensureCoordinatorAgentRun({requestId:'owner',taskId:task.task.id,scope:task.task.scope});const runtimeId='sdk-contract-runtime';await host.handle('runtime.start',{runtimeId,taskId:task.task.id,dcodeSessionId:task.coordinationSession.id,agentRunId:owner.agentRun.id,scope:task.task.scope,workspace:{workspaceId:'sdk-contract-workspace',cwd:home,access:'exclusiveWrite'}});const session=(host as unknown as {runtimes:Map<string,{session:AgentSession}>}).runtimes.get(runtimeId)!.session;session.agent.toolExecution='sequential';
 return {root,home,host,events,task,runtimeId,session,store,snapshot,close:async()=>{await host.close();globalThis.fetch=previous;await rm(root,{recursive:true,force:true});}};
}

test('display language follows each new run without rewriting earlier replies or titles',async()=>{
 const bodies:any[]=[];
 const f=await fixture(async body=>{bodies.push(body);return completion(body.messages[0].content.includes('D Code display and communication language: English.')?'English reply':'中文回复');});
 try{
  assert.equal(f.store.clientPreferences().language,'zh-CN');
  await f.host.handle('clientPreferences.set',{requestId:'language-en',expectedStoreRevision:(await f.snapshot()).storeRevision,language:'en'});
  await f.host.handle('dcodeSession.prompt',{dcodeSessionId:f.task.coordinationSession.id,promptId:'english-run',message:'保留这一份中文提交原文'});
  await until(async()=>(await f.snapshot()).sessionRuns.some(run=>run.status==='completed'),'English run completed');
  const before=await f.snapshot();
  assert.match(bodies[0].messages[0].content,/new automatically generated member\/session titles in English/);
  const language=(snapshot:FoundationSnapshot,index:number)=>(snapshot.runtimeEnvironments.find(environment=>environment.id===snapshot.promptReceipts[index]!.runtimeEnvironmentId)!.environment as {profileSnapshot:{responseLanguage:string}}).profileSnapshot.responseLanguage;
  assert.equal(language(before,0),'en');
  await f.host.handle('clientPreferences.set',{requestId:'language-zh',expectedStoreRevision:before.storeRevision,language:'zh-CN'});
  await f.host.handle('dcodeSession.prompt',{dcodeSessionId:f.task.coordinationSession.id,promptId:'chinese-run',message:'Continue while keeping the original English request'});
  await until(async()=>(await f.snapshot()).sessionRuns.filter(run=>run.status==='completed').length===2,'Chinese run completed');
  const after=await f.snapshot();
  assert.match(bodies.at(-1).messages[0].content,/D Code 显示与沟通语言：简体中文/);
  assert.equal(language(after,after.promptReceipts.length-1),'zh-CN');
  assert.equal(language(after,0),'en');
  assert.deepEqual(after.tasks.map(task=>task.title),before.tasks.map(task=>task.title));
  assert.equal(f.store.sessionRunInputs(f.task.task.id,before.sessionRuns[0]!.id).rawText,'保留这一份中文提交原文');
  assert.equal(f.store.sessionRunInputs(f.task.task.id,after.sessionRuns.at(-1)!.id).rawText,'Continue while keeping the original English request');
  const presentation=await f.host.handle('dcodeSession.presentation',{dcodeSessionId:f.task.coordinationSession.id}) as {inspection:{entries:any[]}};
  assert.ok(JSON.stringify(presentation).includes('English reply'));
  assert.ok(JSON.stringify(presentation).includes('中文回复'));
 }finally{await f.close();}
});

test('a newly dispatched independent member receives the selected English communication language',async()=>{
 let coordinatorCalls=0,memberCalls=0;
 const f=await fixture(async body=>{
  const system=body.messages[0].content;
  assert.match(system,/D Code display and communication language: English\./);
  if(system.includes('coordinator Agent')){
   if(++coordinatorCalls===1){
    const chunk={id:'language-member',object:'chat.completion.chunk',model:'fixture',choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'language-delegate',type:'function',function:{name:'dcode_team',arguments:JSON.stringify({action:'delegate',members:[{profileId:'builtin-explore',title:'Check source evidence',instruction:'核对语言传递，不读其他资料',acceptance:'返回验证依据'}]})}}]},finish_reason:null}]};
    const end={...chunk,choices:[{index:0,delta:{},finish_reason:'tool_calls'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}};
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});
   }
   return completion('Coordinator remains available');
  }
  memberCalls++;return completion('Member evidence returned in English');
 });
 try{
  let snap=await f.snapshot();const profile=snap.agentProfiles.find(profile=>profile.id==='builtin-explore')!;
  await f.host.handle('agentProfile.update',{requestId:'language-member-model',expectedStoreRevision:snap.storeRevision,profileId:profile.id,expectedProfileRevision:profile.revision,name:profile.name,roleContract:profile.roleContract,enabled:true,modelCandidates:[{providerId:'zai-coding-cn',modelId:'fixture'}]});
  await f.host.handle('clientPreferences.set',{requestId:'language-member-en',expectedStoreRevision:(await f.snapshot()).storeRevision,language:'en'});
  await f.host.handle('dcodeSession.prompt',{dcodeSessionId:f.task.coordinationSession.id,promptId:'dispatch-language-member',message:'请分工，保持中文提交原文'});
  await until(async()=>(await f.snapshot()).agentReports.some(report=>JSON.stringify(report.body).includes('Member evidence returned in English')),'independent member report');
  snap=await f.snapshot();assert.equal(memberCalls,1);
  const child=snap.sessions.find(session=>session.kind==='child')!;assert.equal(child.title,'Check source evidence');
  const receipt=snap.promptReceipts.find(receipt=>receipt.sessionId===child.id)!;
  const environment=snap.runtimeEnvironments.find(environment=>environment.id===receipt.runtimeEnvironmentId)!.environment as {profileSnapshot:{responseLanguage:string}};
  assert.equal(environment.profileSnapshot.responseLanguage,'en');
  const execution=snap.agentProcesses?.find(execution=>execution.agentRunId===snap.agentRuns.find(run=>run.sessionId===child.id)!.id);
  assert.ok(execution);assert.notEqual(execution.process.pid,process.pid);
 }finally{await f.close();}
});

test('a summary conflict before Provider startup rebuilds input once without duplicate user or model calls',async()=>{
 let modelCalls=0;
 const f=await fixture(async()=>{modelCalls++;return completion('使用当前摘要继续');});
 try{
  await f.store.prepareTaskSummary({requestId:'summary-before-start',taskId:f.task.task.id,trigger:'new_session'});
  const runtime=(f.host as unknown as {runtimes:Map<string,{resumeSummaryTrigger?:string}>}).runtimes.get(f.runtimeId)!;
  runtime.resumeSummaryTrigger='compaction';
  const prepare=f.store.prepareSessionRun.bind(f.store);let attempts=0;
  f.store.prepareSessionRun=async input=>{
   attempts++;
   assert.ok(input.taskSummary,JSON.stringify({inputRuntimeId:input.runtimeId,expected:f.runtimeId,events:f.events.filter(event=>event.event==='session.cleanupError')}));
   if(attempts===1&&input.taskSummary){
    await f.store.createTaskWorkItem({requestId:'summary-concurrent-result',expectedStoreRevision:(await f.store.snapshot()).storeRevision,taskId:f.task.task.id,scope:f.task.task.scope,title:'并行结果需要核对'});
    await f.store.prepareTaskSummary({requestId:'summary-concurrent-change',taskId:f.task.task.id,trigger:'new_session'});
   }
   return await prepare(input);
  };
  await f.host.handle('dcodeSession.prompt',{dcodeSessionId:f.task.coordinationSession.id,promptId:'summary-conflict-input',message:'保留这一份提交原文'});
  await until(async()=>(await f.snapshot()).sessionRuns.some(run=>run.status==='completed'),'summary conflict run completed');
  const snapshot=await f.snapshot(),run=snapshot.sessionRuns[0]!;
  assert.equal(attempts,2);assert.equal(modelCalls,1);assert.equal(snapshot.sessionRuns.length,1);
  assert.equal(f.store.sessionRunInputs(f.task.task.id,run.id).rawText,'保留这一份提交原文');
  assert.match(f.store.sessionRunInputs(f.task.task.id,run.id).effectiveText,/并行结果需要核对/);
  assert.equal(snapshot.promptReceipts.find(receipt=>receipt.sessionRunId===run.id)?.taskSummary?.revision,f.store.taskSummaryHistory(f.task.task.id).at(-1)?.revision);
 }finally{await f.close();}
});

test('continuous summary changes stop after bounded preparation without sending to a Provider',async()=>{
 let modelCalls=0;
 const f=await fixture(async()=>{modelCalls++;return completion('不应调用');});
 try{
  const runtime=(f.host as unknown as {runtimes:Map<string,{resumeSummaryTrigger?:string}>}).runtimes.get(f.runtimeId)!;
  runtime.resumeSummaryTrigger='compaction';
  const prepare=f.store.prepareSessionRun.bind(f.store);let attempts=0;
  f.store.prepareSessionRun=async input=>{
   attempts++;
   await f.store.createTaskWorkItem({requestId:'continuous-result-'+attempts,expectedStoreRevision:(await f.store.snapshot()).storeRevision,taskId:f.task.task.id,scope:f.task.task.scope,title:'尚在变化的结果 '+attempts});
   return await prepare(input);
  };
  await assert.rejects(f.host.handle('dcodeSession.prompt',{dcodeSessionId:f.task.coordinationSession.id,promptId:'continuous-summary-input',message:'本次输入保留，待结果稳定后重试'}),{code:'REVISION_CONFLICT'});
  assert.equal(attempts,3);assert.equal(modelCalls,0);assert.equal((await f.snapshot()).sessionRuns.length,0);
 }finally{await f.close();}
});

test('historical-path summary conflicts roll back once and preserve the saved edit without automatic rebranching',async()=>{
 let modelCalls=0;
 const f=await fixture(async()=>{modelCalls++;return completion('原始路径回复');});
 try{
  await f.host.handle('dcodeSession.prompt',{dcodeSessionId:f.task.coordinationSession.id,promptId:'path-summary-original',message:'原始路径问题'});
  await until(async()=>(await f.snapshot()).sessionRuns[0]?.status==='completed','original path reply completed');
  const original=(await f.snapshot()).sessionPaths.find(path=>path.isCurrent)!;
  const presented=await f.host.handle('dcodeSession.presentation',{dcodeSessionId:f.task.coordinationSession.id}) as {nativeEntries:Array<{messageRole?:string;sourceEntryId?:string}>};
  const firstUser=presented.nativeEntries.find(entry=>entry.messageRole==='user')!;
  assert.ok(firstUser.sourceEntryId);
  const pathAction={kind:'editUser' as const,entryId:firstUser.sourceEntryId,fromPathId:original.id,expectedCurrentPathId:original.id,expectedCurrentPathRevision:original.revision};
  await f.host.handle('dcodeSession.composerDraft.set',{requestId:'path-summary-edit-draft',expectedStoreRevision:(await f.snapshot()).storeRevision,taskId:f.task.task.id,dcodeSessionId:f.task.coordinationSession.id,text:'保留这份编辑草稿',pathAction,pathDraftBackup:{text:'此前未提交草稿',attachmentIds:[]}});
  const runtime=(f.host as unknown as {runtimes:Map<string,{resumeSummaryTrigger?:string}>}).runtimes.get(f.runtimeId)!;
  runtime.resumeSummaryTrigger='compaction';
  const prepare=f.store.prepareSessionRun.bind(f.store);let attempts=0;
  f.store.prepareSessionRun=async input=>{
   attempts++;
   await f.store.createTaskWorkItem({requestId:'path-summary-concurrent-result',expectedStoreRevision:(await f.store.snapshot()).storeRevision,taskId:f.task.task.id,scope:f.task.task.scope,title:'摘要准备期间出现的新结果'});
   return await prepare(input);
  };
  await assert.rejects(f.host.handle('dcodeSession.prompt',{dcodeSessionId:f.task.coordinationSession.id,promptId:'path-summary-edit',message:'保留这份编辑草稿',pathAction}),{code:'REVISION_CONFLICT'});
  const after=await f.snapshot();
  assert.equal(attempts,1);assert.equal(modelCalls,1);assert.equal(after.sessionRuns.length,1);
  assert.equal(after.sessionPaths.find(path=>path.isCurrent)?.id,original.id);
  assert.equal(after.composerDrafts.find(draft=>draft.sessionId===f.task.coordinationSession.id)?.text,'保留这份编辑草稿');
 }finally{await f.close();}
});

test('fragmented two-tool output finishes the whole batch before consecutive steering inputs reach the next provider call',async()=>{
 const bodies:any[]=[];const f=await fixture(async body=>{bodies.push(body);return bodies.length===1?completion('',["printf first > first.txt","touch second-started; while [ ! -f release ]; do sleep 0.02; done; printf second > second.txt"]):completion('已纳入两项补充');});
 try{
  await f.host.handle('dcodeSession.prompt',{dcodeSessionId:f.task.coordinationSession.id,promptId:'batch',message:'完成两项工具工作'});await until(()=>readFile(join(f.home,'second-started')).then(()=>true,()=>false),'second tool is running');const before=await f.snapshot(),run=before.sessionRuns[0]!,pid=before.agentProcesses![0]!.process.pid;
  const ids:string[]=[];for(const [i,message] of ['补充一：保留来源','补充二：增加日期'].entries()){const sent=await f.host.handle('dcodeSession.prompt',{dcodeSessionId:f.task.coordinationSession.id,promptId:`steer-${i}`,message,deliveryMode:'steer',expectedSessionRunId:run.id}) as {message:{id:string}};ids.push(sent.message.id);}
  assert.equal(bodies.length,1);assert.equal(await readFile(join(f.home,'first.txt'),'utf8'),'first');assert.equal((await f.snapshot()).providerCalls!.length,1);
  await writeFile(join(f.home,'release'),'go');await until(async()=>(await f.snapshot()).sessionRuns[0]!.status==='completed','batch and steering finish');const snap=await f.snapshot();assert.equal(bodies.length,2);assert.equal(bodies[1].messages.filter((message:any)=>message.role==='tool').length,2);for(const text of ['补充一：保留来源','补充二：增加日期'])assert.ok(JSON.stringify(bodies[1].messages).includes(text));
  assert.equal(snap.sessionRuns.length,1);assert.equal(new Set(snap.agentProcesses!.map(item=>item.process.pid)).size,1);assert.equal(snap.agentProcesses![0]!.process.pid,pid);assert.equal(await readFile(join(f.home,'second.txt'),'utf8'),'second');
  const inputs=await f.host.handle('sessionRun.inputs',{taskId:f.task.task.id,sessionRunId:run.id}) as {additionalInputs:Array<{text:string}>};assert.deepEqual(inputs.additionalInputs.map(input=>input.text),['补充一：保留来源','补充二：增加日期']);for(const id of ids){const message=snap.collaborationMessages!.find(message=>message.id===id)!;assert.equal(message.state,'completed');assert.ok(snap.providerCalls![1]!.rawInputIds!.includes(message.originRawInputId));assert.ok(!snap.providerCalls![0]!.rawInputIds!.includes(message.originRawInputId));}
 }finally{await writeFile(join(f.home,'release'),'cleanup');await f.close();}
});

test('stopping a sequential tool batch prevents later tool side effects and retains unconsumed steering',async()=>{
 let calls=0;const f=await fixture(async()=>{calls++;return completion('',["touch first-started; while :; do sleep 1; done","printf forbidden > forbidden.txt"]);});
 try{
  await f.host.handle('dcodeSession.prompt',{dcodeSessionId:f.task.coordinationSession.id,promptId:'stop-batch',message:'开始可停止的工具批次'});await until(()=>readFile(join(f.home,'first-started')).then(()=>true,()=>false),'first actual command started');const snap=await f.snapshot(),run=snap.sessionRuns[0]!;
  const queued=await f.host.handle('dcodeSession.prompt',{dcodeSessionId:f.task.coordinationSession.id,promptId:'not-consumed',message:'停止前尚未消费',deliveryMode:'steer',expectedSessionRunId:run.id}) as {message:{id:string}};
  await f.host.handle('session.abort',{runtimeId:f.runtimeId});await until(async()=>(await f.snapshot()).sessionRuns[0]!.status==='aborted','batch stop persisted');await assert.rejects(readFile(join(f.home,'forbidden.txt')),{code:'ENOENT'});const after=await f.snapshot();assert.equal(calls,1);assert.equal(after.operationAttempts.filter(attempt=>attempt.operationKind==='tool_invocation').length,1);assert.ok(!f.events.some(item=>item.event==='session.event'&&item.data.type==='tool_execution_start'&&item.data.toolCallId==='sdk-tool-1'));assert.equal(after.collaborationMessages!.find(message=>message.id===queued.message.id)!.state,'interrupted');
  for(const record of after.auxiliaryProcesses??[]){assert.equal(record.process.status,'exited');assert.throws(()=>process.kill(record.process.pid,0),{code:'ESRCH'});}
 }finally{await f.close();}
});

test('Host stop cancels an in-flight manual compaction without saving a summary or replaying the conversation',async()=>{
 let summarizing=false,summaryStarted=false,aborted=false,normalCalls=0;const f=await fixture(async(_body,init)=>{if(summarizing){summaryStarted=true;return new Promise<Response>((_resolve,reject)=>{const stop=()=>{aborted=true;reject(new DOMException('compaction stopped','AbortError'));};if(init?.signal?.aborted)stop();else init?.signal?.addEventListener('abort',stop,{once:true});});}normalCalls++;return completion('保留的原始回复。'.repeat(150));});
 try{
  for(let i=0;i<2;i++){await f.host.handle('dcodeSession.prompt',{dcodeSessionId:f.task.coordinationSession.id,promptId:`seed-${i}`,message:'需要保留的工作说明。'.repeat(200)});await until(async()=>(await f.snapshot()).sessionRuns.filter(run=>run.status==='completed').length===i+1,'normal run settled');}
  const before=f.session.sessionManager.getEntries().filter(entry=>entry.type==='compaction').length;summarizing=true;const compact=f.host.handle('session.compact',{runtimeId:f.runtimeId}).then(value=>({value}),error=>({error}));await until(()=>summaryStarted,'summary request entered');assert.equal(f.session.isCompacting,true);await assert.rejects(f.host.handle('dcodeSession.copy',{requestId:'copy-while-compacting',expectedStoreRevision:(await f.snapshot()).storeRevision,dcodeSessionId:f.task.coordinationSession.id}),/压缩|结束/);await f.host.handle('session.abort',{runtimeId:f.runtimeId});await compact;assert.equal(aborted,true);assert.equal(f.session.isCompacting,false);assert.equal(f.session.sessionManager.getEntries().filter(entry=>entry.type==='compaction').length,before);assert.equal(normalCalls,2);const snap=await f.snapshot();assert.equal(snap.sessionRuns.length,2);assert.ok(snap.providerCalls!.filter(call=>call.purpose==='context_summary').every(call=>call.state==='failed'));summarizing=false;
  await f.host.handle('dcodeSession.prompt',{dcodeSessionId:f.task.coordinationSession.id,promptId:'after-stop',message:'取消压缩后继续'});await until(async()=>(await f.snapshot()).sessionRuns.filter(run=>run.status==='completed').length===3,'conversation can continue');assert.equal(normalCalls,3);
 }finally{summarizing=false;await f.session.abort();await f.close();}
});

test('a completed compaction survives D Code copy and later continuation without changing the original history',async()=>{
 let summarizing=false;const bodies:any[]=[];const f=await fixture(async body=>{bodies.push(body);return completion(summarizing?'SDK_SUMMARY_ANCHOR：保留原工作目标和已经确认的结论。':'原有完整回答。'.repeat(180));});
 try{
  for(let i=0;i<2;i++){await f.host.handle('dcodeSession.prompt',{dcodeSessionId:f.task.coordinationSession.id,promptId:`before-copy-${i}`,message:`第${i}轮原始内容：`+'保留已经完成的内容。'.repeat(200)});await until(async()=>(await f.snapshot()).sessionRuns.filter(run=>run.status==='completed').length===i+1,'source run settles');}
  summarizing=true;await f.host.handle('session.compact',{runtimeId:f.runtimeId});summarizing=false;
  const before=f.session.sessionManager.getEntries(),compactions=before.filter(entry=>entry.type==='compaction');assert.ok(compactions.length>0);assert.match(compactions.at(-1)!.summary,/SDK_SUMMARY_ANCHOR/);
  const copied=await f.host.handle('dcodeSession.copy',{requestId:'copy-after-compaction',expectedStoreRevision:(await f.snapshot()).storeRevision,dcodeSessionId:f.task.coordinationSession.id}) as TaskBundle;assert.notEqual(copied.coordinationSession.id,f.task.coordinationSession.id);assert.deepEqual(f.session.sessionManager.getEntries(),before);
  await f.host.handle('dcodeSession.prompt',{dcodeSessionId:copied.coordinationSession.id,promptId:'copied-next',message:'从副本继续，不重复原工作'});await until(async()=>(await f.snapshot()).sessionRuns.some(run=>run.sessionId===copied.coordinationSession.id&&run.status==='completed'),'copy continues');assert.ok(JSON.stringify(bodies.at(-1).messages).includes('SDK_SUMMARY_ANCHOR'));
  const binding=(await f.snapshot()).sessionRuntimeBindings.find(binding=>binding.sessionId===copied.coordinationSession.id)!;const copiedManager=SessionManager.open(binding.adapterSessionPath);const kept=copiedManager.getEntries().filter(entry=>entry.type==='compaction');assert.equal(kept.length,compactions.length);assert.equal(kept.at(-1)!.firstKeptEntryId,compactions.at(-1)!.firstKeptEntryId);assert.deepEqual(f.session.sessionManager.getEntries(),before);
 }finally{await f.close();}
});

test('context edits change canonical provider input while raw history and copied edits stay intact',async()=>{
 const bodies:any[]=[];const f=await fixture(async body=>{bodies.push(body);return completion('RECORDED_REPLY');});
 try{
  await f.host.handle('dcodeSession.prompt',{dcodeSessionId:f.task.coordinationSession.id,promptId:'original',message:'ORIGINAL_CONTEXT_TEXT'});
  await until(async()=>(await f.snapshot()).sessionRuns[0]?.status==='completed','original settles');
  const manager=f.session.sessionManager;
  const target=manager.getEntries().find(entry=>entry.type==='message'&&entry.message.role==='user'&&JSON.stringify(entry.message.content).includes('ORIGINAL_CONTEXT_TEXT'))!;
  const hostInternals=f.host as unknown as {runtimes:Map<string,unknown>;withOwnedMutation<T>(runtime:unknown,body:()=>Promise<T>):Promise<T>};
  await hostInternals.withOwnedMutation(hostInternals.runtimes.get(f.runtimeId),async()=>{manager.appendContextEdit(target.id,{content:'REPLACEMENT_CONTEXT_TEXT'});f.session.refreshContext();});
  await f.host.handle('dcodeSession.prompt',{dcodeSessionId:f.task.coordinationSession.id,promptId:'edited',message:'CONTINUE_AFTER_EDIT'});
  await until(async()=>(await f.snapshot()).sessionRuns.filter(run=>run.status==='completed').length===2,'edited context settles');
  assert.ok(JSON.stringify(bodies.at(-1).messages).includes('REPLACEMENT_CONTEXT_TEXT'));
  assert.ok(!JSON.stringify(bodies.at(-1).messages).includes('ORIGINAL_CONTEXT_TEXT'));
  assert.ok(JSON.stringify(manager.getEntry(target.id)).includes('ORIGINAL_CONTEXT_TEXT'));
  const before=manager.getEntries();
  const copied=await f.host.handle('dcodeSession.copy',{requestId:'copy-edits',expectedStoreRevision:(await f.snapshot()).storeRevision,dcodeSessionId:f.task.coordinationSession.id}) as TaskBundle;
  const binding=(await f.snapshot()).sessionRuntimeBindings.find(item=>item.sessionId===copied.coordinationSession.id)!;
  const copy=SessionManager.open(binding.adapterSessionPath);
  assert.ok(copy.getEntries().some(entry=>entry.type==='context_edit'&&entry.targetId===target.id));
  assert.deepEqual(manager.getEntries(),before);
 }finally{await f.close();}
});

test('a sequential tool keeps its execution policy across the private process boundary',async()=>{
 const model:Model<"openai-completions">={id:"fixture",name:"Fixture",provider:"fixture",api:"openai-completions",baseUrl:"https://fixture.invalid",reasoning:false,input:["text"],contextWindow:10000,maxTokens:1000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
 let release!:()=>void,entered!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;}),order:string[]=[];let calls=0;
 const agent=new ProcessAgent({initialState:{model,tools:[{name:"ordered",label:"Ordered",description:"Perform ordered work",parameters:Type.Object({step:Type.Number()}),executionMode:"sequential",execute:async(_id,args)=>{const step=(args as {step:number}).step;order.push(`start:${step}`);if(step===1){entered();await held;}order.push(`end:${step}`);return {content:[{type:"text",text:"done"}],details:{}};}}]},toolExecution:"parallel",idleTimeoutMs:-1,streamFn:()=>{calls++;const message:AssistantMessage={role:"assistant",api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),content:calls===1?[{type:"toolCall",id:"one",name:"ordered",arguments:{step:1}},{type:"toolCall",id:"two",name:"ordered",arguments:{step:2}}]:[{type:"text",text:"done"}],stopReason:calls===1?"toolUse":"stop",usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};const stream=createAssistantMessageEventStream();stream.push({type:"done",reason:message.stopReason as "stop"|"toolUse",message});stream.end(message);return stream;}});
 try{const pending=agent.prompt("Run both tools");await started;await new Promise(resolve=>setTimeout(resolve,50));assert.deepEqual(order,["start:1"]);release();await pending;assert.deepEqual(order,["start:1","end:1","start:2","end:2"]);assert.notEqual(agent.processInfo!.pid,process.pid);}finally{release();await agent.disposeProcess();}
});

test('GPT-6 Astra Codex SSE terminal events without a trailing blank line finish through the process adapter',async()=>{
 const credentials={read:async()=>undefined,list:async()=>[],modify:async()=>undefined,delete:async()=>{}};
 const runtime=await ModelRuntime.create({modelsPath:null,credentials,allowModelNetwork:false});const model=runtime.getModel("openai-codex","gpt-6-astra") as Model<"openai-codex-responses">;assert.ok(model);
 const payload=Buffer.from(JSON.stringify({"https://api.openai.com/auth":{chatgpt_account_id:"fixture-account"}})).toString("base64");const token=`fixture.${payload}.fixture`;
 const previous=globalThis.fetch;let requested:any;
 const item={type:"message",id:"msg_fixture",status:"completed",role:"assistant",content:[{type:"output_text",text:"CODEX_EOF_OK",annotations:[]}]};
 const frames=[{type:"response.created",response:{id:"response_fixture",model:model.id,status:"in_progress",output:[]}},{type:"response.output_item.added",output_index:0,item:{...item,status:"in_progress",content:[]}},{type:"response.content_part.added",item_id:item.id,output_index:0,content_index:0,part:{type:"output_text",text:"",annotations:[]}},{type:"response.output_text.delta",item_id:item.id,output_index:0,content_index:0,delta:"CODEX_EOF_OK"},{type:"response.output_item.done",output_index:0,item},{type:"response.completed",response:{id:"response_fixture",model:model.id,status:"completed",output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}];
 globalThis.fetch=async(_url,init)=>{const raw=new Headers(init?.headers).get("content-encoding")==="zstd"?zstdDecompressSync(Buffer.from(init!.body as Uint8Array)).toString("utf8"):String(init?.body);requested=JSON.parse(raw);return new Response(frames.map(frame=>`data: ${JSON.stringify(frame)}`).join("\n\n"),{headers:{"content-type":"text/event-stream"}});};
 const agent=new ProcessAgent({initialState:{model,thinkingLevel:"high"},idleTimeoutMs:-1,streamFn:(_model,context,options)=>codexStream(model,context,{...options,apiKey:token,transport:"sse",maxRetries:0})});
 try{await agent.prompt("Return the fixture response");const answer=agent.state.messages.at(-1) as AssistantMessage;assert.equal(answer.stopReason,"stop",answer.errorMessage);assert.ok(answer.content.some(part=>part.type==="text"&&part.text==="CODEX_EOF_OK"));assert.equal(requested.model,"gpt-6-astra");assert.equal(requested.reasoning.effort,"high");assert.equal(agent.state.thinkingLevel,"high");assert.notEqual(agent.processInfo!.pid,process.pid);}finally{await agent.disposeProcess();globalThis.fetch=previous;}
});
