// 普通扩展provider公开头的真实消费者与边界；运行结果及源码资格见本片验证记录。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProvider } from '@earendil-works/pi-ai/models';
import * as openaiCompletions from '@earendil-works/pi-ai/api/openai-completions';
import { createPresetPiBackend, ProviderDirectoryStore } from '../../src/adapters/pi/index.ts';
import { prepareCodingProject } from '../e2e/ordinary-coding-fixture.mjs';
import { until } from './fixtures.ts';

const providerId='owned-provider-live-refresh',headerName='x-dcode-extension-fixture';
const snapshotType='owned-provider-live-snapshot';
const messageText=message=>typeof message?.content==='string'?message.content:Array.isArray(message?.content)?message.content.filter(part=>part?.type==='text').map(part=>part.text).join(''):null;

async function remoteFixture(key){
  const plans=new Map(),requests=[],errors=[];
  const server=http.createServer((req,res)=>{
    if(req.url==='/catalog'){res.writeHead(200,{'content-type':'application/json'});res.end('{"models":[],"providers":[]}');return;}
    if(req.method!=='POST'||req.url!=='/v1/chat/completions'){res.writeHead(404);res.end();return;}
    const parts=[];req.on('data',part=>parts.push(Buffer.from(part)));req.on('end',()=>{
      let body;try{body=JSON.parse(Buffer.concat(parts).toString());}catch{errors.push('invalid owned request JSON');res.writeHead(400);res.end();return;}
      const latest=body.messages?.filter(message=>message.role==='user').at(-1),input=messageText(latest),plan=plans.get(input);
      const record={input,label:plan?.label??null,path:req.url,body,
        model:body.model,marker:req.headers[headerName]??null,authOk:req.headers.authorization==='Bearer '+key,
        responseId:plan?'owned-live-response-'+plan.label:'unmatched',reply:plan?'OWNED_LIVE_REPLY_'+plan.label:'unmatched'};
      requests.push(record);
      const duplicate=plan&&requests.filter(item=>item.label===plan.label).length!==1;
      if(!plan||duplicate||!record.authOk||record.model!==plan.modelId||record.marker!==plan.marker){
        errors.push('unmatched/duplicate input or wrong model/header/auth');res.writeHead(400);res.end('{"error":{"message":"owned identity mismatch"}}');return;
      }
      const whole=JSON.stringify(body.messages);
      if(!whole.includes(plan.contextMarker)||plan.otherContexts.some(value=>whole.includes(value))){
        errors.push('wrong actual cwd/context attribution');res.writeHead(400);res.end('{"error":{"message":"owned context mismatch"}}');return;
      }
      res.writeHead(200,{'content-type':'text/event-stream'});
      const events=[{id:record.responseId,model:body.model,choices:[{index:0,delta:{role:'assistant',content:record.reply},finish_reason:null}]},
        {id:record.responseId,model:body.model,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}];
      res.end(events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join('')+'data: [DONE]\n\n');
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {origin:'http://127.0.0.1:'+server.address().port,requests,errors,
    plan(value){assert.equal(plans.has(value.input),false);plans.set(value.input,value);},
    close:()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);})};
}

function projectExtension(marker,key){
  return `export default function(pi){
  pi.registerProvider(${JSON.stringify(providerId)},{headers:{${JSON.stringify(headerName)}:${JSON.stringify(marker)}}});
  pi.on('before_agent_start',(event,ctx)=>{
    const all=ctx.modelRegistry.getAll(),available=ctx.modelRegistry.getAvailable(),model=ctx.model;
    if(!Array.isArray(all)||!Array.isArray(available))throw new Error('Public catalog is not synchronous');
    const inspected=[...all,...available,...(model?[model]:[])],unsafeKeys=[];
    const visit=value=>{if(!value||typeof value!=='object')return;for(const [key,part]of Object.entries(value)){
      if(['headers','apikey','authorization','credentials','credential','env'].includes(key.toLowerCase()))unsafeKeys.push(key);visit(part);}};
    inspected.forEach(visit);const encoded=JSON.stringify(inspected);
    const ref=value=>value?{provider:value.provider,id:value.id,api:value.api,input:value.input,contextWindow:value.contextWindow,maxTokens:value.maxTokens}:null;
    // An actual accepted-input lifecycle observation, not a new user/model/tool entry or a fabricated assistant response.
    pi.appendEntry(${JSON.stringify(snapshotType)},{marker:${JSON.stringify(marker)},input:event.prompt,cwd:ctx.cwd,current:ref(model),
      all:all.map(ref),available:available.map(ref),unsafeKeys,credentialLeaked:encoded.includes(${JSON.stringify(key)}),markerLeaked:encoded.includes(${JSON.stringify(marker)})});
  });
}`;
}
const modelRef=model=>({provider:model.provider,id:model.id,api:model.api,input:model.input,contextWindow:model.contextWindow,maxTokens:model.maxTokens});
function snapshots(view){return view.entries.filter(entry=>entry.data?.action==='entry'&&entry.data.value?.customType===snapshotType).map(entry=>entry.data.value.data);}
async function send(session,remote,plan){
  remote.plan(plan);const input={target:session.target,operationId:'operation-'+plan.label,text:plan.input,references:[],mode:'follow-up',expected:(await session.read()).control};
  const accepted=await session.submit(input);assert.equal(accepted.status,'accepted');
  await until(async()=>['done','unanswered'].includes((await session.lookupReceipt(input)).processing));
  const receipt=await session.lookupReceipt(input);assert.equal(receipt.processing,'done','Registration/input preparation failure cannot stand in for actual refresh consumption');assert.equal(receipt.submissionId,accepted.submissionId);
  await until(async()=>(await session.read()).phase==='ready');
  const actual=remote.requests.filter(request=>request.label===plan.label);assert.equal(actual.length,1);const request=actual[0],view=await session.read();
  assert.equal(request.model,plan.modelId);assert.equal(request.marker,plan.marker);assert.equal(request.authOk,true);assert.equal(request.path,'/v1/chat/completions');
  const replies=view.entries.filter(entry=>entry.responseId===request.responseId&&entry.assistantText===request.reply);assert.equal(replies.length,1);
  assert.equal(replies[0].provider,providerId);assert.equal(replies[0].model,plan.modelId);assert.deepEqual(replies[0].usage,{input:1,output:1,cacheRead:0,cacheWrite:0});
  assert.equal(replies[0].failureKind,undefined);return {input,accepted,request,view};
}
function assertSnapshot(view,plan,project,model){
  const rows=snapshots(view).filter(row=>row.input===plan.input);assert.equal(rows.length,1,'One formal lifecycle snapshot for this original input');const row=rows[0];
  assert.equal(row.marker,plan.marker);assert.equal(row.cwd,project);assert.deepEqual(row.current,modelRef(model));
  assert.deepEqual(row.all,[modelRef(model)]);assert.deepEqual(row.available,[modelRef(model)],'Fresh per-client effective model/ability snapshot, not an old global source list');
  assert.deepEqual(row.unsafeKeys,[]);assert.equal(row.credentialLeaked,false);assert.equal(row.markerLeaked,false);
}

await test('同preset活S1/S2：独立factory headers随正式同源刷新保留，新model实际HTTP与关闭/S3隔离',{timeout:30000},async()=>{
  // 与正式会话同一真实目录身份；macOS /var 是 /private/var 的链接。
  const root=await realpath(await mkdtemp(join(tmpdir(),'dcode-provider-live-refresh-'))),nonce=randomUUID(),key='owned-live-refresh-key-'+nonce;
  const projects={S1:join(root,'project-s1'),S2:join(root,'project-s2'),S3:join(root,'project-s3')};
  const markers={S1:'owned-header-s1-'+nonce,S2:'owned-header-s2-'+nonce,S3:null};
  const contextMarkers=Object.fromEntries(Object.keys(projects).map(name=>[name,'OWNED_CWD_'+name+'_'+nonce]));
  const sessions=[];let remote;
  try{
    for(const [name,project]of Object.entries(projects)){
      await prepareCodingProject(project);await writeFile(join(project,'AGENTS.md'),'本隔离项目来源：'+contextMarkers[name]+'。只回复本次输入，不调用工具。\n');
      await writeFile(join(project,'.pi/mcp.json'),'{"mcpServers":{}}');
      if(name!=='S3'){await mkdir(join(project,'.pi/extensions'),{recursive:true});await writeFile(join(project,'.pi/extensions/provider-header.ts'),projectExtension(markers[name],key));}
    }
    remote=await remoteFixture(key);const stateDir=join(root,'state');
    const cipher={isAvailable:()=>true,encrypt:value=>Buffer.from(value),decrypt:bytes=>bytes.toString()};
    const store=new ProviderDirectoryStore({stateDir},cipher,{catalogBaseUrl:remote.origin+'/catalog'});await store.commitCredential(providerId,{type:'api_key',key});
    const model=(id,capabilities)=>({provider:providerId,id,name:id,api:'openai-completions',baseUrl:remote.origin+'/v1',reasoning:false,
      cost:{input:0,output:0,cacheRead:0,cacheWrite:0},...capabilities});
    const m0=model('owned-live-old-'+nonce,{input:['text'],contextWindow:128000,maxTokens:4096});
    const m1=model('owned-live-new-'+nonce,{input:['text','image'],contextWindow:192000,maxTokens:8192});
    // Official createProvider + original encrypted CredentialStore; factories receive no key/API/model/endpoint override.
    const provider=createProvider({id:providerId,name:'Owned preset source',models:[m0],
      auth:{apiKey:{name:'owned fixture credential',check:async({credential})=>credential?.type==='api_key'?{type:'api_key',source:'owned encrypted test store'}:undefined,
        resolve:async({credential})=>credential?.type==='api_key'?{auth:{apiKey:credential.key},source:'owned encrypted test store'}:undefined}},
      api:{stream:openaiCompletions.stream,streamSimple:openaiCompletions.streamSimple}});
    const preset={id:providerId,name:'Owned preset source',provider,authKinds:['api_key']};
    const source=models=>({kind:'preset',providerId,preset,models});
    const admissions=[];
    const backend=createPresetPiBackend({stateDir,selection:{providerId,modelId:m0.id},preset,model:m0,info:{id:m0.id,name:m0.name},store,
      additionalSources:[source([m0])],admitRequest:async request=>{admissions.push({...request});return {ok:true,reason:null,target:{sourceId:request.sourceId,modelId:request.modelId,thinkingLevel:null}};}});
    const target=name=>({workspaceId:'space',taskId:'task-'+name,sessionId:'provider-live-'+name});
    const opening=(name,selected)=>({target:target(name),title:'Owned live '+name,workFolder:projects[name],model:selected?{sourceId:providerId,modelId:selected.id,thinkingLevel:null}:null,
      initialize:true,projectAccess:'task-owner',projectExtensionsEnabled:()=>true});
    const s1=await backend.open(opening('S1',m0));sessions.push(s1);const s2=await backend.open(opening('S2',m0));sessions.push(s2);
    assert.notEqual(s1,s2);assert.deepEqual(s1.target,target('S1'));assert.deepEqual(s2.target,target('S2'));assert.equal(remote.requests.length,0,'Opening two ordinary ports does not execute model requests');
    const plan=(name,phase,selected)=>({label:name+'-'+phase+'-'+nonce,input:'OWNED_PROVIDER_INPUT_'+name+'_'+phase+'_'+nonce,
      modelId:selected.id,marker:markers[name],contextMarker:contextMarkers[name],otherContexts:Object.entries(contextMarkers).filter(([key])=>key!==name).map(([,value])=>value)});
    const initialPlans={S1:plan('S1','initial',m0),S2:plan('S2','initial',m0)};
    const [first1,first2]=await Promise.all([send(s1,remote,initialPlans.S1),send(s2,remote,initialPlans.S2)]);
    assertSnapshot(first1.view,initialPlans.S1,projects.S1,m0);assertSnapshot(first2.view,initialPlans.S2,projects.S2,m0);
    assert.equal(remote.requests.length,2);assert.equal((await s1.read()).phase,'ready');assert.equal((await s2.read()).phase,'ready');

    // Real source refresh, not an injected client mutation; authoritative same-source list now contains only m1.
    assert.equal(typeof backend.refreshAdditionalSources,'function');await backend.refreshAdditionalSources([source([m1])]);
    assert.equal(remote.requests.length,2,'Catalog/source refresh is not a probe or model-selection action');
    assert.deepEqual((await s1.read()).model,{provider:providerId,modelId:m0.id});assert.deepEqual((await s2.read()).model,{provider:providerId,modelId:m0.id});
    // Public PiExecutionSession entry: no configureModel exists here. It uses original Conversation.configure internally.
    await s1.applySessionModel({sourceId:providerId,modelId:m1.id,thinkingLevel:null});await s2.applySessionModel({sourceId:providerId,modelId:m1.id,thinkingLevel:null});
    assert.equal(remote.requests.length,2,'Explicit future model configuration cannot emit HTTP');
    const refreshedPlans={S1:plan('S1','refreshed',m1),S2:plan('S2','refreshed',m1)};
    const [next1,next2]=await Promise.all([send(s1,remote,refreshedPlans.S1),send(s2,remote,refreshedPlans.S2)]);
    assertSnapshot(next1.view,refreshedPlans.S1,projects.S1,m1);assertSnapshot(next2.view,refreshedPlans.S2,projects.S2,m1);
    assert.equal(remote.requests.length,4);assert.equal(snapshots(next1.view).length,2);assert.equal(snapshots(next2.view).length,2);
    assert.ok(next1.request.body.messages.some(message=>message.role==='user'&&messageText(message)===initialPlans.S1.input));
    assert.ok(next1.request.body.messages.some(message=>message.role==='assistant'&&messageText(message)===first1.request.reply));
    assert.ok(next2.request.body.messages.some(message=>message.role==='user'&&messageText(message)===initialPlans.S2.input));
    assert.ok(next2.request.body.messages.some(message=>message.role==='assistant'&&messageText(message)===first2.request.reply));
    assert.ok(!JSON.stringify(next1.request.body.messages).includes(initialPlans.S2.input));assert.ok(!JSON.stringify(next2.request.body.messages).includes(initialPlans.S1.input));

    await s1.close();const counts={requests:remote.requests.length,admissions:admissions.length};
    const ro=await backend.open({...opening('S1',m0),initialize:false});sessions.push(ro);
    assert.equal((await ro.read()).phase,'ready');assert.deepEqual((await ro.read()).model,{provider:providerId,modelId:m1.id});
    assert.equal((await ro.submit(next1.input)).submissionId,next1.accepted.submissionId);assert.equal((await ro.lookupReceipt(next1.input)).processing,'done');
    assert.deepEqual({requests:remote.requests.length,admissions:admissions.length},counts,'Close/RO same operation cannot recreate header factories by execution or replay the generation');await ro.close();
    const stillLivePlan=plan('S2','after-s1-close',m1),stillLive=await send(s2,remote,stillLivePlan);assertSnapshot(stillLive.view,stillLivePlan,projects.S2,m1);
    assert.equal(stillLive.request.marker,markers.S2,'Closing S1 cannot release, replace or leak into the original S2 live client');assert.equal(remote.requests.length,5);

    // Newly opened same backend client must consume remembered refresh m1 with original auth, without either project registration.
    const s3=await backend.open(opening('S3',m1));sessions.push(s3);assert.equal(remote.requests.length,5);
    await s3.applySessionModel({sourceId:providerId,modelId:m1.id,thinkingLevel:null});assert.equal(remote.requests.length,5);
    const lastPlan=plan('S3','new-client',m1),last=await send(s3,remote,lastPlan);assert.equal(last.request.marker,null);assert.equal(last.request.authOk,true);assert.equal(last.request.model,m1.id);
    assert.equal(snapshots(last.view).length,0,'S3 has no project extension: no fabricated snapshot or inherited factory');assert.equal(remote.requests.length,6);
    assert.equal(last.view.entries.filter(entry=>entry.assistantText).length,1);assert.ok(!JSON.stringify(last.request.body.messages).includes(initialPlans.S1.input));assert.ok(!JSON.stringify(last.request.body.messages).includes(initialPlans.S2.input));
    assert.equal(admissions.length,6);assert.ok(admissions.every(request=>request.sourceId===providerId));
    assert.deepEqual(admissions.filter(request=>request.sessionId===target('S1').sessionId).map(request=>request.modelId),[m0.id,m1.id]);
    assert.deepEqual(admissions.filter(request=>request.sessionId===target('S2').sessionId).map(request=>request.modelId),[m0.id,m1.id,m1.id]);
    assert.deepEqual(admissions.filter(request=>request.sessionId===target('S3').sessionId).map(request=>request.modelId),[m1.id]);
    assert.deepEqual(remote.errors,[]);
    for(const [session,expected]of [[s2,3],[s3,1]]){
      const view=await session.read();assert.equal(view.entries.filter(entry=>entry.assistantText).length,expected);assert.equal(view.entries.filter(entry=>entry.toolResult).length,0);
      assert.ok(view.entries.filter(entry=>entry.assistantText).every(entry=>entry.provider===providerId&&entry.usage?.input===1&&entry.usage?.output===1));
    }
  }finally{let failure;for(const session of [...sessions].reverse())try{await session.close();}catch(error){failure??=error;}
    try{await remote?.close();}finally{await rm(root,{recursive:true,force:true});}if(failure)throw failure;}
});


await test('可信刷新：S1旧声明与新base撞名须失效，但不能截断S2原活客户端的新model同步',{timeout:30000},async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'dcode-provider-refresh-collision-'))),nonce=randomUUID(),key='owned-collision-key-'+nonce;
  const projects={S1:join(root,'s1'),S2:join(root,'s2')},contexts={S1:'COLLISION_CWD_S1_'+nonce,S2:'COLLISION_CWD_S2_'+nonce};
  const marker='owned-s1-header-'+nonce,baseHeader='new-base-reserved-header-'+nonce,sessions=[];let remote;
  try{
    for(const [name,project]of Object.entries(projects)){
      await prepareCodingProject(project);await writeFile(join(project,'AGENTS.md'),contexts[name]+'。只回复当次输入。\n');
      await writeFile(join(project,'.pi/mcp.json'),'{}');
      if(name==='S1'){await mkdir(join(project,'.pi/extensions'),{recursive:true});await writeFile(join(project,'.pi/extensions/headers.ts'),projectExtension(marker,key));}
    }
    remote=await remoteFixture(key);const stateDir=join(root,'state');
    const store=new ProviderDirectoryStore({stateDir},{isAvailable:()=>true,encrypt:value=>Buffer.from(value),decrypt:bytes=>bytes.toString()},{catalogBaseUrl:remote.origin+'/catalog'});
    await store.commitCredential(providerId,{type:'api_key',key});
    const m0={provider:providerId,id:'collision-old-'+nonce,name:'old',api:'openai-completions',baseUrl:remote.origin+'/v1',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:128000,maxTokens:4096};
    const m1={...m0,id:'collision-new-'+nonce,name:'new',headers:{[headerName]:baseHeader}};
    const provider=createProvider({id:providerId,name:'Owned collision preset',models:[m0],auth:{apiKey:{name:'owned fixture',check:async({credential})=>credential?.type==='api_key'?{type:'api_key',source:'owned store'}:undefined,resolve:async({credential})=>credential?.type==='api_key'?{auth:{apiKey:credential.key}}:undefined}},api:{stream:openaiCompletions.stream,streamSimple:openaiCompletions.streamSimple}});
    const preset={id:providerId,name:'Owned collision preset',provider,authKinds:['api_key']},source=models=>({kind:'preset',providerId,preset,models});
    const backend=createPresetPiBackend({stateDir,selection:{providerId,modelId:m0.id},preset,model:m0,info:{id:m0.id,name:m0.name},store,additionalSources:[source([m0])],admitRequest:async request=>({ok:true,reason:null,target:{sourceId:request.sourceId,modelId:request.modelId,thinkingLevel:null}})});
    const opening=name=>({target:{workspaceId:'space',taskId:'collision-task-'+name,sessionId:'collision-'+name},title:name,workFolder:projects[name],model:{sourceId:providerId,modelId:m0.id,thinkingLevel:null},initialize:true,projectAccess:'task-owner',projectExtensionsEnabled:()=>true});
    // S1先打开，确保冲突发生在openedClients循环的第一项；S2原端口始终保持打开。
    const s1=await backend.open(opening('S1'));sessions.push(s1);const s2=await backend.open(opening('S2'));sessions.push(s2);
    const plan=(name,phase,model,headers)=>({label:name+'-'+phase+'-'+nonce,input:'COLLISION_INPUT_'+name+'_'+phase+'_'+nonce,modelId:model.id,marker:headers,contextMarker:contexts[name],otherContexts:[contexts[name==='S1'?'S2':'S1']]});
    await send(s1,remote,plan('S1','old',m0,marker));await send(s2,remote,plan('S2','old',m0,null));assert.equal(remote.requests.length,2);
    await assert.rejects(backend.refreshAdditionalSources([source([m1])]),'S1撞名必须保留真实失败，不能宣布整体同步成功');
    assert.equal(remote.requests.length,2,'目录同步不能探针执行');
    await s2.applySessionModel({sourceId:providerId,modelId:m1.id,thinkingLevel:null});
    const second=await send(s2,remote,plan('S2','after-s1-collision',m1,baseHeader));
    assert.equal(second.request.model,m1.id);assert.equal(second.request.marker,baseHeader);assert.equal(remote.requests.length,3,'S2必须真实消费新模型与原认证，不能仍被S1中断留在旧目录');
    await s1.applySessionModel({sourceId:providerId,modelId:m1.id,thinkingLevel:null});
    const blocked={target:s1.target,operationId:'collision-blocked-'+nonce,text:'COLLISION_BLOCKED_S1_'+nonce,references:[],mode:'follow-up',expected:(await s1.read()).control};
    assert.equal((await s1.submit(blocked)).status,'accepted');await until(async()=>['done','unanswered'].includes((await s1.lookupReceipt(blocked)).processing));
    assert.equal((await s1.lookupReceipt(blocked)).processing,'unanswered');assert.equal(remote.requests.length,3,'S1失效声明必须阻止后续HTTP，不能借其余会话成功隐式放行');
    assert.deepEqual(remote.errors,[]);
  }finally{let failure;for(const session of [...sessions].reverse())try{await session.close();}catch(error){failure??=error;}try{await remote?.close();}finally{await rm(root,{recursive:true,force:true});}if(failure)throw failure;}
});
