import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PiHost} from '../src/pi-host.js';
import type {FoundationSnapshot,TaskBundle} from '../src/product-store.js';
const until=async(check:()=>Promise<boolean>,label:string)=>{const deadline=Date.now()+25000;while(!await check()){if(Date.now()>deadline)throw new Error(label);await new Promise(resolve=>setTimeout(resolve,30));}};
function response(text:string,name?:string,args?:unknown){return new Response(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:name?{role:'assistant',tool_calls:[{index:0,id:crypto.randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}}]}:{role:'assistant',content:text},finish_reason:null}]})}\n\ndata: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:name?'tool_calls':'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});}

test('two workers and two independent verifiers complete targeted rework and recheck through real Pi tools',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dcode-verification-loop-')),agent=join(root,'agent'),home=join(root,'home');await mkdir(agent);await mkdir(home);await writeFile(join(agent,'settings.json'),JSON.stringify({defaultProvider:'zai-coding-cn',defaultModel:'fixture',retry:{enabled:false}}));await writeFile(join(agent,'models.json'),JSON.stringify({providers:{'zai-coding-cn':{baseUrl:'https://open.bigmodel.cn/api/paas/v4',api:'openai-completions',apiKey:'fixture-only',models:[{id:'fixture',name:'Fixture',reasoning:false,input:['text'],contextWindow:100000,maxTokens:4096}]}}}));
  const previous=globalThis.fetch,phases=new Map<string,number>(),workerRuns=new Map<string,Set<string>>(),verifierRuns=new Map<string,Set<string>>(),sent=new Set<string>(),toolErrors:unknown[]=[];let host!:PiHost;
  const snapshot=()=>host.handle('foundation.snapshot',{}) as Promise<FoundationSnapshot>;
  globalThis.fetch=(async(url,init)=>{
    if(String(url).includes('quota/limit'))return Response.json({success:true,code:200,data:{limits:[{type:'TOKENS_LIMIT',percentage:10,nextResetTime:Date.now()+3600000}]}});
    const body=JSON.parse(String(init?.body)),system=body.messages.find((message:any)=>message.role==='system')?.content??'',sessionId=system.match(/- D Code Session: (\S+)/)?.[1];const snap=await snapshot(),actor=snap.agentRuns.find(run=>run.sessionId===sessionId)!;assert.ok(actor,system);
    const run=snap.sessionRuns.filter(run=>run.agentRunId===actor.id&&run.status==='running').at(-1)!;assert.ok(run);const phase=phases.get(run.id)??0;phases.set(run.id,phase+1);const title=snap.sessions.find(session=>session.id===actor.sessionId)!.title;
    for(const message of body.messages.filter((message:any)=>message.role==='tool'))if(String(message.content).includes('isError'))toolErrors.push(message.content);
    const invoke=(name:string,args:unknown)=>response('',name,args);
    if(actor.role==='worker'){
      const name=title.includes('工作 A')?'a':'b',set=workerRuns.get(name)??new Set<string>();set.add(run.id);workerRuns.set(name,set);
      if(phase===0)return invoke('write',{path:`${name}.md`,content:name==='a'&&set.size===1?'A 缺少必要来源':`${name.toUpperCase()} 内容完整，来源已核对`});return response(`工作 ${name.toUpperCase()} 第 ${set.size} 版已经保存到 ${name}.md`);
    }
    if(actor.role==='verifier'){
      const name=title.includes('验收 A')?'a':'b',set=verifierRuns.get(name)??new Set<string>();set.add(run.id);verifierRuns.set(name,set);
      if(phase===0)return invoke('read',{path:`${name}.md`});if(phase===1)return invoke('dcode_verification',{action:'context'});
      if(phase===2){const subject=snap.agentRuns.find(member=>member.role==='worker'&&snap.sessions.find(session=>session.id===member.sessionId)?.title.includes(`工作 ${name.toUpperCase()}`))!,report=snap.agentReports.filter(report=>report.agentRunId===subject.id).at(-1)!;const evidence=snap.evidence.filter(item=>item.agentRunId===actor.id&&item.createdAt>=run.startedAt!&&item.commandRedacted==='read');assert.ok(evidence.length);const fail=set.size===1;return invoke('dcode_verification',{action:'submit',subjectReportId:report.id,verdict:fail?'fail':'pass',evidenceIds:evidence.map(item=>item.id),findings:fail?[{kind:name==='a'?'product':'verification',description:name==='a'?'A 缺少必要来源':'B 内容正确，但还需要独立复核检查范围'}]:[],summary:fail?'需要定向补齐后继续':'已经再次读取文件，内容和来源齐全'});}
      return response(`验收 ${name.toUpperCase()} 第 ${set.size} 次检查已提交`);
    }
    assert.equal(actor.role,'coordinator');if(phase===0)return invoke('dcode_verification',{action:'context'});
    const workers=snap.agentRuns.filter(member=>member.role==='worker'),verifiers=snap.agentRuns.filter(member=>member.role==='verifier');
    if(!workers.length)return invoke('dcode_team',{action:'delegate',members:['A','B'].map(name=>({profileId:'builtin-worker',title:`工作 ${name}`,instruction:`完成 ${name.toLowerCase()}.md`,acceptance:'内容完整并有来源'}))});
    if(workers.every(worker=>snap.agentReports.some(report=>report.agentRunId===worker.id))&&!verifiers.length)return invoke('dcode_team',{action:'delegate',members:['A','B'].map(name=>({profileId:'builtin-verifier',title:`验收 ${name}`,instruction:`独立读取 ${name.toLowerCase()}.md 并提交对应工作报告的验收`,acceptance:'留下本人检查证据'}))});
    const unreviewed=snap.verifications?.find(verification=>!snap.coordinatorReviews?.some(review=>review.verificationId===verification.id));
    if(unreviewed)return invoke('dcode_verification',{action:'review',verificationId:unreviewed.id,outcome:unreviewed.verdict==='pass'?'accepted':unreviewed.findings.some(finding=>finding.kind==='product')?'rework':'recheck',reason:unreviewed.verdict==='pass'?'已核对独立读取证据与报告版本':'只处理这项验收的问题，保留其他成果',strategyChange:unreviewed.verdict==='fail'?'按缺项重新读取具体文件并复核来源':undefined});
    for(const worker of workers){const reports=snap.agentReports.filter(report=>report.agentRunId===worker.id);if(reports.length<2)continue;const report=reports.at(-1)!;const verification=snap.verifications?.find(verification=>verification.subjectReportId===report.id);if(verification||sent.has(report.id))continue;const prior=snap.verifications?.find(verification=>verification.subjectAgentRunId===worker.id);if(prior){sent.add(report.id);return invoke('dcode_team',{action:'send',agentRunId:prior.verifierAgentRunId,message:'执行者已修复，请读取新文件并对最新报告重新验收。'});}}
    return response('继续保持主对话，逐项回收验收结果。');
  }) as typeof fetch;
  const errors:unknown[]=[];host=new PiHost({agentDir:agent,sessionsDirectory:join(agent,'sessions'),dataRoot:join(root,'.dcode'),userHome:home,emit:(event,data)=>{if(/failed|error/iu.test(event))errors.push({event,data});}});
  try{
    await host.start();const initial=await snapshot(),task=await host.handle('task.create',{requestId:'task',expectedStoreRevision:initial.storeRevision,scope:{kind:'user',userId:initial.currentUser.id},title:'多成员独立验收',goal:'一项返工、一项重查，已通过成果保持不变'}) as TaskBundle;
    await host.handle('dcodeSession.prompt',{dcodeSessionId:task.coordinationSession.id,promptId:'start',message:'并行安排两项工作，分别独立验收并复核'});
    await until(async()=>{const snap=await snapshot();if(snap.sessionRuns.some(run=>run.status==='failed')){const presentation=await host.handle('dcodeSession.presentation',{dcodeSessionId:task.coordinationSession.id}) as any;throw new Error(JSON.stringify(presentation.inspection?.entries?.filter((entry:any)=>entry.message?.stopReason==='error').map((entry:any)=>entry.message.errorMessage)));}return snap.coordinatorReviews?.filter(review=>review.outcome==='accepted').length===2;},'both independent checks accepted after targeted corrections');await until(async()=>!(await snapshot()).collaborationMessages?.some(message=>['queued','delivering'].includes(message.state)),'all result notifications settle');
    const snap=await snapshot();assert.equal(snap.tasks.length,1);assert.equal(snap.tasks[0]!.state,'active','coordinator review does not impersonate user acceptance');assert.equal(snap.agentRuns.filter(member=>member.role==='worker').length,2);assert.equal(snap.agentRuns.filter(member=>member.role==='verifier').length,2);
    assert.equal(workerRuns.get('a')!.size,2);assert.equal(workerRuns.get('b')!.size,1,'unaffected file is never rewritten');assert.equal(verifierRuns.get('a')!.size,2);assert.equal(verifierRuns.get('b')!.size,2);assert.equal(snap.verifications!.length,4);assert.deepEqual(snap.coordinatorReviews!.map(review=>review.outcome).sort(),['accepted','accepted','recheck','rework']);assert.ok(snap.taskWorkItems.every(item=>item.state==='completed'));assert.equal(snap.teamRuns[0]!.status,'completed');
    assert.equal(await readFile(join(home,'a.md'),'utf8'),'A 内容完整，来源已核对');assert.equal(await readFile(join(home,'b.md'),'utf8'),'B 内容完整，来源已核对');for(const verifier of snap.agentRuns.filter(member=>member.role==='verifier'))assert.ok(snap.agentProcesses!.some(process=>process.agentRunId===verifier.id));
  }catch(error){console.error(JSON.stringify({errors,toolErrors,workerRuns:[...workerRuns].map(([key,runs])=>[key,runs.size]),verifierRuns:[...verifierRuns].map(([key,runs])=>[key,runs.size]),snapshot:await snapshot()},null,2));throw error;}finally{await host.close();globalThis.fetch=previous;await rm(root,{recursive:true,force:true});}
});
