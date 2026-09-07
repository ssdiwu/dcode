import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PiHost} from '../src/pi-host.js';
import type {FoundationSnapshot,TaskBundle} from '../src/product-store.js';

function gate(){let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});return {wait,release};}
async function until(check:()=>Promise<boolean>,label:string){const deadline=Date.now()+15000;while(!await check()){if(Date.now()>deadline)throw new Error(label);await new Promise(resolve=>setTimeout(resolve,20));}}
function completion(text:string,action?:unknown){const tool=action?{index:0,id:`call-${crypto.randomUUID()}`,type:'function',function:{name:'dcode_team',arguments:JSON.stringify(action)}}:undefined;return new Response(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:tool?{role:'assistant',tool_calls:[tool]}:{role:'assistant',content:text},finish_reason:null}]})}\n\ndata: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});}
async function fixture(fetcher:(body:any,init:RequestInit|undefined)=>Promise<Response>){
  const root=await mkdtemp(join(tmpdir(),'dcode-steering-')),agent=join(root,'agent'),home=join(root,'home');await mkdir(agent);await mkdir(home);
  await writeFile(join(agent,'settings.json'),JSON.stringify({defaultProvider:'zai-coding-cn',defaultModel:'fixture'}));await writeFile(join(agent,'models.json'),JSON.stringify({providers:{'zai-coding-cn':{baseUrl:'https://open.bigmodel.cn/api/paas/v4',api:'openai-completions',apiKey:'fixture-only',models:[{id:'fixture',name:'Fixture',reasoning:false,input:['text'],contextWindow:100000,maxTokens:4096}]}}}));
  const previous=globalThis.fetch;globalThis.fetch=(async(url,init)=>String(url).includes('quota/limit')?Response.json({success:true,code:200,data:{limits:[{type:'TOKENS_LIMIT',percentage:10,nextResetTime:Date.now()+3600000}]}}):fetcher(JSON.parse(String(init?.body)),init)) as typeof fetch;
  const errors:unknown[]=[];const host=new PiHost({agentDir:agent,sessionsDirectory:join(agent,'sessions'),dataRoot:join(root,'.dcode'),userHome:home,emit:(event,data)=>{if(/failed|error/iu.test(event))errors.push({event,data});}});
  const snapshot=()=>host.handle('foundation.snapshot',{}) as Promise<FoundationSnapshot>;
  await host.start();const snap=await snapshot();const task=await host.handle('task.create',{requestId:'task',expectedStoreRevision:snap.storeRevision,scope:{kind:'user',userId:snap.currentUser.id},title:'执行途中补充',goal:'保留原文、同一运行和成员来源'}) as TaskBundle;
  return {host,task,snapshot,errors,close:async()=>{await host.close();globalThis.fetch=previous;await rm(root,{recursive:true,force:true});}};
}

test('a main-conversation steering input is consumed in the same run and process with original text and provider receipts',async()=>{
  const held=gate();let requests=0;const bodies:any[]=[];
  const f=await fixture(async body=>{bodies.push(body);requests++;if(requests===1)await held.wait;return completion(requests===1?'已开始检查':'已纳入补充要求');});
  try{
    await f.host.handle('dcodeSession.prompt',{dcodeSessionId:f.task.coordinationSession.id,promptId:'start',message:'先检查内容'});await until(async()=>requests===1,'first request');
    const before=await f.snapshot(),run=before.sessionRuns[0]!;const pid=before.agentProcesses![0]!.process.pid;
    const sent=await f.host.handle('dcodeSession.prompt',{dcodeSessionId:f.task.coordinationSession.id,promptId:'steer',message:'增加截止时间：明天。',deliveryMode:'steer',expectedSessionRunId:run.id}) as {message:{id:string}};
    held.release();await until(async()=>(await f.snapshot()).collaborationMessages?.some(message=>message.id===sent.message.id&&message.state==='completed')??false,'steering finishes');
    const snap=await f.snapshot();assert.equal(requests,2);assert.equal(snap.sessionRuns.length,1);assert.equal(snap.sessionRuns[0]!.status,'completed');assert.equal(new Set(snap.agentProcesses!.map(item=>item.process.pid)).size,1);assert.equal(snap.agentProcesses![0]!.process.pid,pid);
    assert.ok(JSON.stringify(bodies[1].messages).includes('增加截止时间：明天。'));assert.ok(!JSON.stringify(bodies).includes('dcodeSteerId'));
    const inputs=await f.host.handle('sessionRun.inputs',{taskId:f.task.task.id,sessionRunId:run.id}) as {rawText:string;additionalInputs:Array<{text:string}>};assert.equal(inputs.rawText,'先检查内容');assert.deepEqual(inputs.additionalInputs.map(item=>item.text),['增加截止时间：明天。']);
    const presentation=await f.host.handle('dcodeSession.presentation',{dcodeSessionId:f.task.coordinationSession.id}) as {submissions:Array<{text:string;sourceEntryId?:string}>};assert.deepEqual(presentation.submissions.map(item=>item.text),['先检查内容','增加截止时间：明天。']);assert.ok(presentation.submissions.every(item=>item.sourceEntryId));
    const message=snap.collaborationMessages!.find(item=>item.id===sent.message.id)!;assert.ok(snap.providerCalls![1]!.rawInputIds?.includes(message.originRawInputId));assert.equal(snap.providerCalls![0]!.rawInputIds?.length,1,'earlier call does not claim to have seen the later input');
  }catch(error){console.error(JSON.stringify({errors:f.errors,snapshot:await f.snapshot()},null,2));throw error;}finally{held.release();await f.close();}
});

test('a delayed coordinator directive must reconcile a directly steered member requirement before dispatch',async()=>{
  const workerFirst=gate(),coordinatorOld=gate(),workerSecond=gate();let coordinators=0,workers=0,workerId='';const toolResults:any[]=[];const newRequirement='仅核对周五的安排，保留旧文件。';
  const f=await fixture(async body=>{
    assert.ok(!JSON.stringify(body).includes('dcodeSteerId'));
    if(body.messages.find((message:any)=>message.role==='system')?.content.includes('coordinator Agent')){
      coordinators++;
      if(coordinators===1)return completion('',{action:'delegate',members:[{profileId:'builtin-explore',title:'检查成员',instruction:'检查周一安排',acceptance:'提供来源'}]});
      if(coordinators===2){await coordinatorOld.wait;return completion('',{action:'send',agentRunId:workerId,message:'继续原来周一的安排'});}
      if(coordinators===3){const tool=body.messages.filter((message:any)=>message.role==='tool').at(-1);toolResults.push(JSON.parse(tool.content));return completion('',{action:'send',agentRunId:workerId,message:'按用户新要求核对周五，保留旧文件。'});}
      return completion('已同步新安排');
    }
    workers++;if(workers===1){await workerFirst.wait;return completion('先前检查已经结束');}
    if(workers===2){assert.ok(JSON.stringify(body.messages).includes(newRequirement));await workerSecond.wait;return completion('已核对周五并保留原文件');}
    assert.ok(!JSON.stringify(body.messages).includes('继续原来周一的安排'));return completion('已按修订安排核对');
  });
  try{
    await f.host.handle('dcodeSession.prompt',{dcodeSessionId:f.task.coordinationSession.id,promptId:'start',message:'安排后台核对'});await until(async()=>workers===1&&coordinators===2,'member and coordinator are independently active');
    let snap=await f.snapshot();const worker=snap.agentRuns.find(run=>run.role==='explore')!;workerId=worker.id;const run=snap.sessionRuns.find(run=>run.agentRunId===worker.id)!;
    const sent=await f.host.handle('dcodeSession.prompt',{dcodeSessionId:f.task.coordinationSession.id,targetAgentRunId:worker.id,promptId:'member-steer',message:newRequirement,deliveryMode:'steer',expectedSessionRunId:run.id}) as {message:{id:string}};
    workerFirst.release();await until(async()=>workers===2,'member consumed direct input');coordinatorOld.release();await until(async()=>(await f.snapshot()).collaborationMessages?.some(message=>message.text==='按用户新要求核对周五，保留旧文件。')??false,'reconciled directive queued');
    assert.equal(toolResults[0].sent,false);assert.equal(toolResults[0].userUpdate,newRequirement);
    snap=await f.snapshot();assert.ok(!snap.collaborationMessages!.some(message=>message.text==='继续原来周一的安排'));assert.equal(snap.collaborationMessages!.find(message=>message.text==='按用户新要求核对周五，保留旧文件。')!.acknowledgedUserMessageId,sent.message.id);
    workerSecond.release();await until(async()=>(await f.snapshot()).collaborationMessages?.some(message=>message.text==='按用户新要求核对周五，保留旧文件。'&&message.state==='completed')??false,'revised directive executes');
    await until(async()=>!(await f.snapshot()).collaborationMessages?.some(message=>['queued','delivering'].includes(message.state)),'notifications settle');
    snap=await f.snapshot();const direct=snap.collaborationMessages!.find(message=>message.id===sent.message.id)!;assert.equal(direct.sourceSessionId,f.task.coordinationSession.id);assert.equal(direct.targetSessionId,worker.sessionId);assert.equal(direct.reply,'已核对周五并保留原文件');assert.equal(snap.agentRuns.filter(run=>run.role==='explore').length,1);
  }catch(error){console.error(JSON.stringify({coordinators,workers,toolResults,errors:f.errors,snapshot:await f.snapshot()},null,2));throw error;}finally{workerFirst.release();coordinatorOld.release();workerSecond.release();await f.close();}
});

test('stopping before steering consumption retains an interrupted input without replay',async()=>{
  let requests=0;const f=await fixture(async(_body,init)=>{requests++;return await new Promise<Response>((_resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('fixture did not receive abort')),5000);const abort=()=>{clearTimeout(timer);reject(new DOMException('stopped','AbortError'));};if(init?.signal?.aborted)abort();else init?.signal?.addEventListener('abort',abort,{once:true});});});
  try{
    await f.host.handle('dcodeSession.prompt',{dcodeSessionId:f.task.coordinationSession.id,promptId:'start',message:'开始检查'});await until(async()=>requests===1,'first call starts');const snap=await f.snapshot(),run=snap.sessionRuns[0]!;
    const sent=await f.host.handle('dcodeSession.prompt',{dcodeSessionId:f.task.coordinationSession.id,promptId:'unconsumed',message:'还没接收的补充',deliveryMode:'steer',expectedSessionRunId:run.id}) as {message:{id:string}};
    await f.host.handle('session.abort',{runtimeId:run.runtimeId});await until(async()=>(await f.snapshot()).collaborationMessages?.some(message=>message.id===sent.message.id&&message.state==='interrupted')??false,'interrupted receipt retained');
    assert.equal(requests,1);const inputs=await f.host.handle('sessionRun.inputs',{taskId:f.task.task.id,sessionRunId:run.id}) as {additionalInputs:unknown[]};assert.deepEqual(inputs.additionalInputs,[],'unconsumed input is not reported as seen');
  }finally{await f.close();}
});
