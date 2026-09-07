import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PiHost} from '../src/pi-host.js';
import type {FoundationSnapshot,TaskBundle} from '../src/product-store.js';
const response=(text:string,tool?:unknown)=>new Response(`data: ${JSON.stringify({id:'fallback',object:'chat.completion.chunk',model:'fixture',created:1,choices:[{index:0,delta:tool?{role:'assistant',tool_calls:[tool]}:{role:'assistant',content:text},finish_reason:null}]})}\n\ndata: ${JSON.stringify({id:'fallback',object:'chat.completion.chunk',model:'fixture',created:1,choices:[{index:0,delta:{},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});
const until=async(check:()=>Promise<boolean>,label:string)=>{const deadline=Date.now()+12000;while(!await check()){if(Date.now()>deadline)throw new Error(label);await new Promise(resolve=>setTimeout(resolve,20));}};

test('a confirmed 429 switches an existing worker at the model boundary, preserves completed writes and records the actual calls',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dcode-safe-fallback-')),agent=join(root,'agent'),home=join(root,'home');await mkdir(agent);await mkdir(home);
  const model={id:'fixture',name:'Fixture',reasoning:false,input:['text'],contextWindow:100000,maxTokens:4096};await writeFile(join(agent,'settings.json'),JSON.stringify({defaultProvider:'zai-coding-cn',defaultModel:'fixture'}));await writeFile(join(agent,'models.json'),JSON.stringify({providers:{'zai-coding-cn':{baseUrl:'https://open.bigmodel.cn/api/paas/v4',api:'openai-completions',apiKey:'fixture-only',models:[model]},'minimax-cn':{baseUrl:'https://api.minimaxi.com/v1',api:'openai-completions',apiKey:'fixture-only',models:[model]}}}));
  const previous=globalThis.fetch;let coordinator=0,workerZai=0,workerMinimax=0;const errors:unknown[]=[];
  globalThis.fetch=(async(url,init)=>{
    const address=String(url);
    if(address.includes('quota/limit'))return Response.json({success:true,code:200,data:{limits:[{type:'TOKENS_LIMIT',percentage:10,nextResetTime:Date.now()+3600000}]}});
    if(address.includes('coding_plan/remains'))return Response.json({base_resp:{status_code:0},model_remains:[{model_name:'general',current_interval_remaining_percent:80,current_weekly_remaining_percent:80,end_time:Date.now()+3600000,weekly_end_time:Date.now()+604800000}]});
    const body=JSON.parse(String(init?.body)),system=body.messages.find((message:{role:string})=>message.role==='system').content;
    if(system.includes('coordinator Agent')){coordinator++;if(coordinator===1)return response('',{index:0,id:'delegate',type:'function',function:{name:'dcode_team',arguments:JSON.stringify({action:'delegate',members:[{profileId:'builtin-worker',title:'后台执行',instruction:'先写 step.md，再检查结果',acceptance:'只写一次并返回结果'}]})}});return response('协调者继续跟进');}
    assert.ok(system.includes('worker Agent'));
    if(address.includes('bigmodel.cn')){workerZai++;if(workerZai===1)return response('',{index:0,id:'write-once',type:'function',function:{name:'write',arguments:JSON.stringify({path:'step.md',content:'已完成的写入'})}});return Response.json({error:{message:'rate limit',type:'rate_limit_error'}},{status:429,headers:{'retry-after':'3600'}});}
    workerMinimax++;assert.ok(system.includes('- Model: minimax-cn/fixture'));assert.equal(body.messages.filter((message:{role:string})=>message.role==='tool').length,1,'the new model receives the completed tool result');return response('已基于现有写入完成检查');
  }) as typeof fetch;
  const host=new PiHost({agentDir:agent,sessionsDirectory:join(agent,'sessions'),dataRoot:join(root,'.dcode'),userHome:home,emit:(event,data)=>{if(/failed|error/iu.test(event))errors.push({event,data});}});const snapshot=()=>host.handle('foundation.snapshot',{}) as Promise<FoundationSnapshot>;
  try{
    await host.start();for(const profileId of ['builtin-coordinator','builtin-worker']){const snap=await snapshot(),profile=snap.agentProfiles.find(profile=>profile.id===profileId)!;await host.handle('agentProfile.update',{requestId:`route-${profileId}`,expectedStoreRevision:snap.storeRevision,profileId,expectedProfileRevision:profile.revision,name:profile.name,roleContract:profile.roleContract,enabled:true,modelCandidates:[{providerId:'zai-coding-cn',modelId:'fixture'},{providerId:'minimax-cn',modelId:'fixture'}]});}
    const initial=await snapshot();const task=await host.handle('task.create',{requestId:'task',expectedStoreRevision:initial.storeRevision,scope:{kind:'user',userId:initial.currentUser.id},title:'安全模型回退',goal:'保留进度并继续'}) as TaskBundle;
    await host.handle('dcodeSession.prompt',{dcodeSessionId:task.coordinationSession.id,promptId:'start',message:'安排后台工作'});
    await until(async()=>(await snapshot()).collaborationMessages?.some(message=>message.author==='coordinator'&&message.state==='completed')??false,'worker did not finish after fallback');
    await until(async()=>!(await snapshot()).collaborationMessages?.some(message=>['queued','delivering'].includes(message.state)),'notifications did not settle');
    const snap=await snapshot(),workers=snap.agentRuns.filter(run=>run.role==='worker');assert.equal(workers.length,1);const worker=workers[0]!;assert.equal(worker.modelProvider,'minimax-cn');assert.equal(workerZai,2);assert.equal(workerMinimax,1);assert.equal(await readFile(join(home,'step.md'),'utf8'),'已完成的写入');assert.equal(snap.evidence.filter(item=>item.agentRunId===worker.id&&item.commandRedacted==='write').length,1);
    const calls=snap.providerCalls!.filter(call=>call.agentRunId===worker.id);assert.deepEqual(calls.map(call=>[call.providerId,call.state,call.httpStatus]),[['zai-coding-cn','completed',200],['zai-coding-cn','failed',429],['minimax-cn','completed',200]]);
    assert.equal(new Set(snap.agentProcesses!.filter(process=>process.agentRunId===worker.id).map(process=>process.process.pid)).size,1,'fallback keeps one worker and one execution process');
    assert.equal(snap.tasks.length,1);assert.ok(snap.events.some(event=>event.kind==='agentModel.rerouted'));
  }catch(error){console.error(JSON.stringify({errors,snapshot:await snapshot()},null,2));throw error;}finally{await host.close();globalThis.fetch=previous;await rm(root,{recursive:true,force:true});}
});

test('manual context compression uses quota fallback and separate receipts without replacing the member identity or selected model',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dcode-summary-route-')),agent=join(root,'agent'),home=join(root,'home');await mkdir(agent);await mkdir(home);
  const model={id:'fixture',name:'Fixture',reasoning:false,input:['text'],contextWindow:100000,maxTokens:4096};await writeFile(join(agent,'settings.json'),JSON.stringify({defaultProvider:'zai-coding-cn',defaultModel:'fixture',compaction:{enabled:false,keepRecentTokens:64,reserveTokens:256},retry:{enabled:false}}));await writeFile(join(agent,'models.json'),JSON.stringify({providers:{'zai-coding-cn':{baseUrl:'https://open.bigmodel.cn/api/paas/v4',api:'openai-completions',apiKey:'fixture-only',models:[model]},'minimax-cn':{baseUrl:'https://api.minimaxi.com/v1',api:'openai-completions',apiKey:'fixture-only',models:[model]}}}));
  const previous=globalThis.fetch;let summarizing=false;const summaryRequests:string[]=[],normalPrompts:string[]=[];
  globalThis.fetch=(async(url,init)=>{
    const address=String(url);if(address.includes('quota/limit'))return Response.json({success:true,code:200,data:{limits:[{type:'TOKENS_LIMIT',percentage:10,nextResetTime:Date.now()+3600000}]}});if(address.includes('coding_plan/remains'))return Response.json({base_resp:{status_code:0},model_remains:[{model_name:'general',current_interval_remaining_percent:80,current_weekly_remaining_percent:80,end_time:Date.now()+3600000,weekly_end_time:Date.now()+604800000}]});
    const body=JSON.parse(String(init?.body)),system=body.messages.find((message:{role:string})=>message.role==='system').content;
    if(summarizing){assert.ok(!system.includes('coordinator Agent'));summaryRequests.push(address.includes('bigmodel.cn')?'zai':'minimax');if(address.includes('bigmodel.cn'))return Response.json({error:{message:'rate limit'}},{status:429,headers:{'retry-after':'60'}});return response('## Goal\n保留所有已确认约束。\n## Progress\n完成资料检查，后续继续核对。');}
    assert.ok(system.includes('coordinator Agent'));normalPrompts.push(system);return response('已记录资料。'.repeat(150));
  }) as typeof fetch;
  const host=new PiHost({agentDir:agent,sessionsDirectory:join(agent,'sessions'),dataRoot:join(root,'.dcode'),userHome:home,emit:()=>{}}),snapshot=()=>host.handle('foundation.snapshot',{}) as Promise<FoundationSnapshot>;
  try{
    await host.start();let snap=await snapshot();const profile=snap.agentProfiles.find(profile=>profile.id==='builtin-coordinator')!;await host.handle('agentProfile.update',{requestId:'route',expectedStoreRevision:snap.storeRevision,profileId:profile.id,expectedProfileRevision:profile.revision,name:profile.name,roleContract:profile.roleContract,enabled:true,modelCandidates:[{providerId:'zai-coding-cn',modelId:'fixture'},{providerId:'minimax-cn',modelId:'fixture'}]});
    snap=await snapshot();const task=await host.handle('task.create',{requestId:'task',expectedStoreRevision:snap.storeRevision,scope:{kind:'user',userId:snap.currentUser.id},title:'压缩上下文',goal:'身份与摘要分离'}) as TaskBundle;
    for(let index=0;index<2;index++){await host.handle('dcodeSession.prompt',{dcodeSessionId:task.coordinationSession.id,promptId:`input-${index}`,message:`第 ${index} 段资料：`+'需要保留原始来源和已确认要求。'.repeat(200)});await until(async()=>(await snapshot()).sessionRuns.length===index+1&&!(await snapshot()).sessionRuns.some(run=>run.status==='running'),'normal input settles');}
    snap=await snapshot();const runtimeId=snap.sessionRuns[0]!.runtimeId;summarizing=true;await host.handle('session.compact',{runtimeId});summarizing=false;
    snap=await snapshot();assert.equal(snap.sessionRuns.length,2,'manual compression does not pretend to be a new user run');const calls=snap.providerCalls!.filter(call=>call.purpose==='context_summary');assert.deepEqual(summaryRequests,['zai','minimax','minimax'],'split-turn summary skips the now rate-limited pool');assert.deepEqual(calls.map(call=>[call.providerId,call.state]),[['zai-coding-cn','failed'],['minimax-cn','completed'],['minimax-cn','completed']]);assert.ok(calls.every(call=>call.sessionId===task.coordinationSession.id&&!call.sessionRunId&&call.sourceLeafEntryId));
    const live=await host.handle('runtime.list',{}) as {runtimes:Array<{state:{model:{provider:string}}}>};assert.equal(live.runtimes[0]!.state.model.provider,'zai-coding-cn','summary fallback does not change the main agent selected model');
    await host.handle('dcodeSession.prompt',{dcodeSessionId:task.coordinationSession.id,promptId:'after-summary',message:'继续检查最新资料'});await until(async()=>(await snapshot()).sessionRuns.length===3&&!(await snapshot()).sessionRuns.some(run=>run.status==='running'),'post-compression run');assert.equal(normalPrompts.length,3);assert.ok(normalPrompts.at(-1)!.includes('coordinator Agent'));
  }catch(error){console.error(JSON.stringify({summaryRequests,snapshot:await snapshot()},null,2));throw error;}finally{await host.close();globalThis.fetch=previous;await rm(root,{recursive:true,force:true});}
});
