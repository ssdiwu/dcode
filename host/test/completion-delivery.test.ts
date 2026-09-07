import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,mkdir,writeFile,readFile,appendFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PiHost} from '../src/pi-host.js';
import {ProductStore,type FoundationSnapshot,type TaskBundle} from '../src/product-store.js';
import type {CollaborationMessage} from '../src/collaboration-message.js';
const until=async(check:()=>boolean|Promise<boolean>,label:string)=>{const end=Date.now()+10000;while(!await check()){if(Date.now()>end)throw new Error(label);await new Promise(resolve=>setTimeout(resolve,10));}};
function response(text:string,tool?:{name:string;args:unknown}){return new Response(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:tool?{role:'assistant',tool_calls:[{index:0,id:crypto.randomUUID(),type:'function',function:{name:tool.name,arguments:JSON.stringify(tool.args)}}]}:{role:'assistant',content:text},finish_reason:null}]})}\n\ndata: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});}
async function fixture(onCoordinatorInput?:(body:any)=>Promise<void>){
 const root=await mkdtemp(join(tmpdir(),'dcode-result-save-')),agent=join(root,'agent'),home=join(root,'home');await mkdir(agent);await mkdir(home);await writeFile(join(agent,'settings.json'),JSON.stringify({defaultProvider:'zai-coding-cn',defaultModel:'fixture',retry:{enabled:false}}));await writeFile(join(agent,'models.json'),JSON.stringify({providers:{'zai-coding-cn':{baseUrl:'https://open.bigmodel.cn/api/paas/v4',api:'openai-completions',apiKey:'fixture-only',models:[{id:'fixture',name:'Fixture',reasoning:false,input:['text'],contextWindow:100000,maxTokens:4096}]}}}));
 const previous=globalThis.fetch;let mainCalls=0,memberCalls=0;let memberMode:'normal'|'empty'|'failure'|'stopped'='normal';let stopWaiting=false;
 globalThis.fetch=(async(url,init)=>{if(String(url).includes('quota/limit'))return Response.json({success:true,code:200,data:{limits:[{type:'TOKENS_LIMIT',percentage:20,nextResetTime:Date.now()+3600000}]}});const body=JSON.parse(String(init?.body));if(body.messages.find((message:any)=>message.role==='system').content.includes('coordinator Agent')){mainCalls++;await onCoordinatorInput?.(body);if(mainCalls===1)return response('',{name:'dcode_team',args:{action:'delegate',members:[{profileId:'builtin-worker',title:'结果成员',instruction:'保存真实文件并报告结果',acceptance:'文件可读取'}]}});return response('协调者继续处理当前任务');}memberCalls++;if(memberMode==='stopped'){stopWaiting=true;return new Promise<Response>((_resolve,reject)=>{if(init?.signal?.aborted)reject(new DOMException('stopped','AbortError'));else init?.signal?.addEventListener('abort',()=>reject(new DOMException('stopped','AbortError')),{once:true});});}if(memberMode==='failure')throw new Error('fixture provider failed');if(memberMode==='empty')return response('');if(memberCalls===1)return response('',{name:'write',args:{path:'result.md',content:'已经完成的工作'}});return response('本轮成果已经写入 result.md');}) as typeof fetch;
 const events:Array<{event:string;data:any}>=[];const options={agentDir:agent,sessionsDirectory:join(agent,'sessions'),dataRoot:join(root,'.dcode'),userHome:home,emit:(event:string,data:unknown)=>{events.push({event,data});}};let host=new PiHost(options);await host.start();const snapshot=()=>host.handle('foundation.snapshot',{}) as Promise<FoundationSnapshot>;const snap=await snapshot();const task=await host.handle('task.create',{requestId:'task',expectedStoreRevision:snap.storeRevision,scope:{kind:'user',userId:snap.currentUser.id},title:'结果保存边界',goal:'失败时不丢工作或冒充交付'}) as TaskBundle;
 return {root,home,task,events,snapshot,get host(){return host;},get store(){return (host as unknown as {productStore:ProductStore}).productStore;},get stopWaiting(){return stopWaiting;},get calls(){return {mainCalls,memberCalls};},mode:(mode:typeof memberMode)=>{memberMode=mode;},start:()=>host.handle('dcodeSession.prompt',{dcodeSessionId:task.coordinationSession.id,promptId:'start',message:'安排成员完成工作'}),restart:async()=>{await host.close();host=new PiHost(options);await host.start();},close:async()=>{await host.close();globalThis.fetch=previous;await rm(root,{recursive:true,force:true});}};
}
const isMemberNotice=(message:CollaborationMessage)=>message.author==='member'&&!!message.resultReference;

test('Host completion waits for durable report, input state and exact coordinator notice together; retries do not duplicate',async()=>{
 const f=await fixture();let release=()=>{};let captured:Parameters<ProductStore['finishSessionRun']>[0]|undefined;
 try{
  const finish=f.store.finishSessionRun.bind(f.store),internals=f.store as unknown as {database:DatabaseSync;lease:{assertOwned:()=>Promise<void>}};
  const gate=new Promise<void>(resolve=>{release=resolve;});let blocked=false;
  f.store.finishSessionRun=async input=>{const run=internals.database.prepare('SELECT session_id FROM session_runs WHERE id=?').get(input.sessionRunId)!;if(run.session_id!==f.task.coordinationSession.id)captured=input;return finish(input);};
  const assertOwned=internals.lease.assertOwned.bind(internals.lease);
  internals.lease.assertOwned=async()=>{if(!blocked&&internals.database.isTransaction&&internals.database.prepare("SELECT 1 FROM store_events WHERE kind='collaboration.messageChanged' AND json_extract(payload_json,'$.author')='member' AND json_extract(payload_json,'$.resultReference.sessionRunId') IS NOT NULL LIMIT 1").get()){blocked=true;await gate;}await assertOwned();};
  await f.start();await until(()=>blocked,'member reached the actual pre-commit boundary');
  const outside=new DatabaseSync(join(f.root,'.dcode','product-store.sqlite3'),{readOnly:true});
  const member=outside.prepare("SELECT id,session_id AS sessionId FROM agent_runs WHERE role='worker'").get() as {id:string;sessionId:string};
  const source=JSON.parse(String(outside.prepare("SELECT payload_json FROM store_events WHERE kind='collaboration.messageChanged' AND json_extract(payload_json,'$.targetAgentRunId')=? ORDER BY sequence DESC LIMIT 1").get(member.id)!.payload_json)) as CollaborationMessage;
  assert.equal(source.state,'delivering');assert.equal(outside.prepare('SELECT COUNT(*) AS count FROM agent_reports WHERE agent_run_id=?').get(member.id)!.count,0);assert.equal(outside.prepare("SELECT COUNT(*) AS count FROM store_events WHERE kind='collaboration.messageChanged' AND json_extract(payload_json,'$.author')='member'").get()!.count,0);outside.close();
  let projected=false;const pendingSnapshot=f.snapshot().then(snapshot=>{projected=true;return snapshot;});await new Promise(resolve=>setTimeout(resolve,20));assert.equal(projected,false,'Host snapshot never exposes this connection uncommitted facts');
  assert.equal(f.events.filter(item=>item.event==='session.durableRunFinished'&&item.data.runtime?.agentRunId===member.id).length,0);assert.ok(!f.events.some(item=>item.event==='session.runStateChanged'&&item.data.runtime?.agentRunId===member.id&&item.data.phase==='completed'));
  assert.equal(await readFile(join(f.home,'result.md'),'utf8'),'已经完成的工作');release();await pendingSnapshot;await until(async()=>(await f.snapshot()).collaborationMessages!.find(message=>message.id===source.id)?.state==='completed','atomic completion committed');await until(async()=>!(await f.snapshot()).collaborationMessages!.some(message=>['queued','delivering'].includes(message.state)),'coordinator delivery settled');
  const final=await f.snapshot(),notice=final.collaborationMessages!.filter(isMemberNotice);assert.equal(notice.length,1);assert.equal(notice[0]!.sourceSessionId,member.sessionId);assert.equal(notice[0]!.targetAgentRunId,final.agentRuns.find(run=>run.role==='coordinator')!.id);assert.equal(notice[0]!.resultReference!.sessionRunId,captured!.sessionRunId);const report=final.agentReports.find(report=>report.id===notice[0]!.resultReference!.reportId)!;assert.equal((report.body as {sessionRunId:string}).sessionRunId,captured!.sessionRunId);
  await finish(captured!);await finish(captured!);assert.equal((await f.snapshot()).collaborationMessages!.filter(isMemberNotice).length,1);assert.equal(f.calls.memberCalls,2);assert.equal(final.tasks[0]!.state,'active');
 }finally{release();await f.close();}
});

for(const withAdapterConflict of [false,true])test(`a refused notification insert preserves files and runtime ownership through ${withAdapterConflict?'adapter conflict then ':''}close and restart`,async()=>{
 const f=await fixture();
 try{
  const db=(f.store as unknown as {database:DatabaseSync}).database;
  db.exec(`CREATE TEMP TRIGGER reject_result_notice BEFORE INSERT ON store_events WHEN NEW.kind='collaboration.messageChanged' AND json_extract(NEW.payload_json,'$.author')='member' AND json_extract(NEW.payload_json,'$.resultReference.sessionRunId') IS NOT NULL BEGIN SELECT RAISE(ABORT,'fixture notification write rejected'); END`);
  await f.start();await until(()=>f.events.some(item=>item.event==='session.persistenceError'&&item.data.code==='RESULT_SAVE_FAILED'),'actual result save failed');const snap=await f.snapshot(),member=snap.agentRuns.find(run=>run.role==='worker')!,source=snap.collaborationMessages!.find(message=>message.targetAgentRunId===member.id)!;
  assert.equal(source.state,'delivering');assert.equal(snap.agentReports.filter(report=>report.agentRunId===member.id).length,0);assert.equal(snap.collaborationMessages!.filter(isMemberNotice).length,0);assert.ok(!f.events.some(item=>item.event==='session.durableRunFinished'&&item.data.runtime?.agentRunId===member.id));assert.equal(await readFile(join(f.home,'result.md'),'utf8'),'已经完成的工作');
  await f.host.handle('dcodeSession.prompt',{dcodeSessionId:f.task.coordinationSession.id,promptId:'unrelated-main',message:'主对话继续讨论'});await until(async()=>(await f.snapshot()).sessionRuns.filter(run=>run.sessionId===f.task.coordinationSession.id&&run.status==='completed').length>=2,'main dialogue remains available');
  const failedRun=snap.sessionRuns.find(run=>run.agentRunId===member.id)!;
  if(withAdapterConflict){
    const binding=snap.sessionRuntimeBindings.find(binding=>binding.sessionId===member.sessionId)!;
    await appendFile(binding.adapterSessionPath,JSON.stringify({type:'custom',id:'external-conflict',parentId:null,timestamp:new Date().toISOString(),customType:'fixture',data:{note:'external change'}})+'\n');
    const runtime=(f.host as unknown as {runtimes:Map<string,{conflict?:unknown}>;checkConflict:(runtime:unknown)=>Promise<void>});const active=runtime.runtimes.get(failedRun.runtimeId)!;await runtime.checkConflict(active);await until(()=>!!active.conflict,'real adapter modification is observed');
  }
  await f.host.handle('session.close',{runtimeId:failedRun.runtimeId});
  const file=await f.host.handle('workspace.read',{source:{taskId:f.task.task.id},path:'result.md'}) as {digest:string;root:string};await assert.rejects(f.host.handle('workspace.save',{source:{taskId:f.task.task.id},path:'result.md',text:'cannot bypass failed save',expectedDigest:file.digest,expectedRoot:file.root}),error=>(error as {code:string}).code==='WORKSPACE_IN_USE');
  const same=await f.host.handle('runtime.list',{}) as {runtimes:Array<{identity:{runtimeId:string}}>};assert.ok(same.runtimes.some(run=>run.identity.runtimeId===failedRun.runtimeId),'failed persistence retains the runtime reservation after close');
  const calls=f.calls.memberCalls;await f.restart();const restored=await f.snapshot();assert.equal(restored.collaborationMessages!.find(message=>message.id===source.id)!.state,'interrupted');assert.equal(restored.agentReports.filter(report=>report.agentRunId===member.id).length,0);assert.equal(f.calls.memberCalls,calls);assert.equal(await readFile(join(f.home,'result.md'),'utf8'),'已经完成的工作');await f.restart();assert.equal(f.calls.memberCalls,calls);
 }finally{await f.close();}
});

test('startup repairs an older committed-result notification gap once and keeps the repaired notice paused',async()=>{
 const f=await fixture();
 try{
  await f.start();await until(async()=>(await f.snapshot()).collaborationMessages!.filter(isMemberNotice).length===1,'initial notification exists');await until(async()=>!(await f.snapshot()).collaborationMessages!.some(message=>['queued','delivering'].includes(message.state)),'first delivery settled');const before=await f.snapshot(),notice=before.collaborationMessages!.find(isMemberNotice)!,sourceId=notice.resultReference!.sourceMessageIds[0]!;const calls=f.calls.memberCalls;
  // Recreate only the durable gap left by the older candidate: report + completed
  // input survive, while their generated notification and result link are absent.
  const db=(f.store as unknown as {database:DatabaseSync}).database;db.prepare('DELETE FROM store_events WHERE entity_id=?').run(notice.id);db.prepare("UPDATE store_events SET payload_json=json_remove(payload_json,'$.completionReference') WHERE kind='collaboration.messageChanged' AND entity_id=?").run(sourceId);
  await f.restart();let restored=await f.snapshot();let notices=restored.collaborationMessages!.filter(isMemberNotice);assert.equal(notices.length,1);assert.equal(notices[0]!.state,'paused');assert.equal(notices[0]!.resultReference!.sessionRunId,notice.resultReference!.sessionRunId);assert.equal(notices[0]!.resultReference!.reportId,notice.resultReference!.reportId);assert.equal(f.calls.memberCalls,calls);
  await f.restart();restored=await f.snapshot();notices=restored.collaborationMessages!.filter(isMemberNotice);assert.equal(notices.length,1);assert.equal(notices[0]!.state,'paused');assert.equal(f.calls.memberCalls,calls);
 }finally{await f.close();}
});

test('a later empty or failed member run never returns an earlier report as its own result',async()=>{
 const f=await fixture();
 try{
  await f.start();await until(async()=>!(await f.snapshot()).collaborationMessages!.some(message=>['queued','delivering'].includes(message.state))&&(await f.snapshot()).collaborationMessages!.some(isMemberNotice),'first result settled');const first=await f.snapshot(),member=first.agentRuns.find(run=>run.role==='worker')!,oldReport=first.agentReports.find(report=>report.agentRunId===member.id)!;
  for(const mode of ['empty','failure','stopped'] as const){f.mode(mode);const sent=await f.host.handle('dcodeSession.prompt',{dcodeSessionId:member.sessionId,promptId:mode,message:`本轮${mode}没有新成果`}) as {message:CollaborationMessage};if(mode==='stopped'){await until(()=>f.stopWaiting,'member entered the current provider call');const running=(await f.snapshot()).sessionRuns.filter(run=>run.agentRunId===member.id).at(-1)!;await f.host.handle('session.abort',{runtimeId:running.runtimeId});}await until(async()=>['completed','failed'].includes((await f.snapshot()).collaborationMessages!.find(message=>message.id===sent.message.id)?.state??''),'current member run settled');const snap=await f.snapshot(),current=snap.collaborationMessages!.find(message=>message.id===sent.message.id)!;assert.equal(current.reply,undefined);if(mode==='stopped')assert.equal(current.completionReference!.outcome,'aborted');assert.equal(current.completionReference!.reportId,undefined);assert.notEqual(current.completionReference!.sessionRunId,(oldReport.body as {sessionRunId:string}).sessionRunId);assert.equal(snap.agentReports.filter(report=>report.agentRunId===member.id).length,1);const notice=snap.collaborationMessages!.find(message=>isMemberNotice(message)&&message.resultReference!.sessionRunId===current.completionReference!.sessionRunId)!;assert.equal(notice.resultReference!.reportId,undefined);assert.ok(!notice.text.includes('本轮成果已经写入'));
   await until(async()=>!(await f.snapshot()).collaborationMessages!.some(message=>['queued','delivering'].includes(message.state)),'empty/failure notices settle');}
 }finally{await f.close();}
});

test('generated inputs keep their exact source before the coordinator has produced an answer',async()=>{
 let waiting=false;let release!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve;});
 const f=await fixture(async body=>{
  const user=body.messages?.filter((item:any)=>item.role==='user').at(-1);
  if(!waiting&&JSON.stringify(user?.content).includes('本轮返回 succeeded')){waiting=true;await hold;}
 });
 try{
  await f.start();await until(()=>waiting,'coordinator model call is held after the generated input was persisted');
  const snap=await f.snapshot(),run=snap.sessionRuns.find(run=>run.sessionId===f.task.coordinationSession.id&&run.status==='running')!;
  const presentation=await f.host.handle('dcodeSession.presentation',{dcodeSessionId:f.task.coordinationSession.id}) as any;
  const db=new DatabaseSync(join(f.root,'.dcode','product-store.sqlite3'),{readOnly:true});
  const input=db.prepare('SELECT user_entry_id,assistant_entry_id FROM session_runs WHERE id=?').get(run.id);db.close();
  const native=presentation.nativeEntries.find((entry:any)=>entry.id===input!.user_entry_id);
  assert.equal(native.content.author,'member');assert.equal(input!.assistant_entry_id,null);
  const adapterUser=presentation.inspection.entries.filter((entry:any)=>entry.type==='message'&&entry.message?.role==='user').at(-1);
  assert.ok(adapterUser,'the actual Adapter input exists while no reply exists');
  assert.equal(presentation.collaborationInputs.find((input:any)=>input.sourceEntryId===adapterUser.id)?.messageId,native.content.collaborationMessageId,'the live input must already carry its native collaboration identity');
  release();await until(async()=>!(await f.snapshot()).collaborationMessages!.some(message=>['queued','delivering'].includes(message.state)),'result notification completed');
  const completed=await f.host.handle('dcodeSession.presentation',{dcodeSessionId:f.task.coordinationSession.id}) as any;
  assert.equal(completed.collaborationInputs.filter((input:any)=>input.sourceEntryId===adapterUser.id).length,1);
  // A human may type the same text. Attribution is by execution/input identity,
  // never by a textual prefix that would hide a real user submission.
  await f.host.handle('dcodeSession.prompt',{dcodeSessionId:f.task.coordinationSession.id,promptId:'same-text-human',message:native.content.text});
  await until(async()=>(await f.snapshot()).sessionRuns.filter(run=>run.sessionId===f.task.coordinationSession.id&&run.status==='completed').length===3,'human reply completed');
  const human=await f.host.handle('dcodeSession.presentation',{dcodeSessionId:f.task.coordinationSession.id}) as any;
  const humanInput=human.nativeEntries.filter((entry:any)=>entry.messageRole==='user').at(-1);
  assert.equal(humanInput.content.text,native.content.text);
  assert.ok(!human.collaborationInputs.some((input:any)=>input.sourceEntryId===humanInput.sourceEntryId&&input.author!=='user'));
 }finally{release();await f.close();}
});
