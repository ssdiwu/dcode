import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,realpath,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {zstdDecompressSync} from 'node:zlib';
import {createReadToolDefinition,createWriteToolDefinition,createEditToolDefinition,createBashToolDefinition,createGrepToolDefinition,createFindToolDefinition,createLsToolDefinition,SessionManager,ModelRuntime,type ExtensionContext} from '@earendil-works/pi-coding-agent';
import type {AgentSession} from '@earendil-works/pi-coding-agent';
import {PiHost} from '../src/pi-host.js';
import {ProductStore,type FoundationSnapshot,type TaskBundle} from '../src/product-store.js';
import {ProcessAgent} from '../src/process-agent.js';
import {streamSimple as codexStream} from '@earendil-works/pi-ai/api/openai-codex-responses';
import {Type} from 'typebox';
import {createAssistantMessageEventStream,type AssistantMessage,type Model} from '@earendil-works/pi-ai';
const until=async(check:()=>boolean|Promise<boolean>,label:string)=>{const end=Date.now()+12000;while(!await check()){if(Date.now()>end)throw new Error(label);await new Promise(resolve=>setTimeout(resolve,10));}};
const output=(value:{content:Array<{type:string;text?:string}>})=>value.content.filter(part=>part.type==='text').map(part=>part.text).join('\n');

test('SDK built-in tools obey the current context cwd when it differs from their construction directory',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dcode-sdk-cwd-')),a=join(root,'a'),b=join(root,'b');const oldAgentDir=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=join(root,'agent');await mkdir(a);await mkdir(b);await writeFile(join(a,'seed.txt'),'from A');await writeFile(join(b,'seed.txt'),'from B');const ctx={cwd:await realpath(b),sessionManager:SessionManager.inMemory(b)} as unknown as ExtensionContext;
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
