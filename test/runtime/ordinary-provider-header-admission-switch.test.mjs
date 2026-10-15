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

const headerName='x-dcode-extension-fixture';
const messageText=message=>typeof message?.content==='string'?message.content:Array.isArray(message?.content)?message.content.filter(part=>part?.type==='text').map(part=>part.text).join(''):null;

async function controlledRemote({nonce,keys}){
  const requests=[],invalid=[];
  const server=http.createServer((req,res)=>{
    if(req.url==='/catalog'){res.writeHead(200,{'content-type':'application/json'});res.end('{"models":[],"providers":[]}');return;}
    if(req.method!=='POST'||!['/A/v1/chat/completions','/B/v1/chat/completions'].includes(req.url)){res.writeHead(404);res.end();return;}
    const parts=[];req.on('data',part=>parts.push(Buffer.from(part)));req.on('end',()=>{
      let body;try{body=JSON.parse(Buffer.concat(parts).toString());}catch{invalid.push('owned JSON invalid');res.writeHead(400);res.end();return;}
      const physical=req.url.startsWith('/A/')?'A':'B',ordinal=requests.filter(request=>request.physical===physical).length+1;
      const record={physical,ordinal,path:req.url,model:body.model,authOk:req.headers.authorization==='Bearer '+keys[physical],
        projectMarker:req.headers[headerName]??null,aNativeHeader:req.headers['x-dcode-model-a']??null,bNativeHeader:req.headers['x-dcode-model-b']??null,
        input:messageText(body.messages?.filter(message=>message.role==='user').at(-1)),body,
        responseId:'owned-admission-'+physical+'-'+nonce+'-'+ordinal,reply:'OWNED_ADMISSION_REPLY_'+physical+'_'+nonce+'_'+ordinal};
      requests.push(record);
      if(!record.authOk){res.writeHead(401);res.end('{"error":{"message":"owned source auth mismatch"}}');return;}
      // Public-header absence is the target oracle below. Keep the normal successful owned response so red is an exact field assertion, not a timeout.
      res.writeHead(200,{'content-type':'text/event-stream'});
      const events=[{id:record.responseId,model:body.model,choices:[{index:0,delta:{role:'assistant',content:record.reply},finish_reason:null}]},
        {id:record.responseId,model:body.model,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}];
      res.end(events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join('')+'data: [DONE]\n\n');
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {origin:'http://127.0.0.1:'+server.address().port,requests,invalid,
    of:source=>requests.filter(request=>request.physical===source),
    close:()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);})};
}
async function submitDone(session,target,text,operationId){
  const input={target,operationId,text,references:[],mode:'follow-up',expected:(await session.read()).control};
  const receipt=await session.submit(input);assert.equal(receipt.status,'accepted');
  await until(async()=>['done','unanswered'].includes((await session.lookupReceipt(input)).processing));
  const final=await session.lookupReceipt(input);assert.equal(final.processing,'done','Factory/input preparation failure is not the SDK target-switch header oracle');assert.equal(final.submissionId,receipt.submissionId);
  await until(async()=>(await session.read()).phase==='ready');return {input,receipt,view:await session.read()};
}
function assertReply(view,request,providerId,modelId){
  const rows=view.entries.filter(entry=>entry.responseId===request.responseId&&entry.assistantText===request.reply);assert.equal(rows.length,1);
  assert.equal(rows[0].provider,providerId);assert.equal(rows[0].model,modelId);assert.deepEqual(rows[0].usage,{input:1,output:1,cacheRead:0,cacheWrite:0});assert.equal(rows[0].failureKind,undefined);
}

for(const mode of ['same-source','cross-source'])await test(`provider header/SDK准入${mode} A→B：实际只发B且保B规范/project头、独立认证和原上下文`,{timeout:30000},async()=>{
  // Match the host's canonical cwd (/var may be /private/var); this is only owned fixture setup.
  const root=await realpath(await mkdtemp(join(tmpdir(),'dcode-provider-admission-'))),nonce=randomUUID(),project=join(root,'project');
  const providers={A:'owned-header-admission-a',B:mode==='same-source'?'owned-header-admission-a':'owned-header-admission-b'};
  const keys={A:'owned-source-key-a-'+nonce,B:mode==='same-source'?'owned-source-key-a-'+nonce:'owned-source-key-b-'+nonce};
  const projectMarkers={A:'owned-project-a-'+nonce,B:mode==='same-source'?'owned-project-a-'+nonce:'owned-project-b-'+nonce};
  const nativeMarkers={A:'owned-model-a-'+nonce,B:'owned-model-b-'+nonce};
  let remote,session,switched=false;
  const admissions=[];
  try{
    await prepareCodingProject(project);await writeFile(join(project,'AGENTS.md'),'本隔离项目标记：OWNED_ADMISSION_CWD_'+nonce+'。回复本次输入，不调用工具。\n');
    await mkdir(join(project,'.pi/extensions'),{recursive:true});await writeFile(join(project,'.pi/mcp.json'),'{"mcpServers":{}}');
    // Same source: one provider-wide factory patch is shared by A/B; native model headers distinguish their physical templates.
    // Cross source: two distinct provider patches in the same normal project factory, both confirmed through original resource preparation.
    await writeFile(join(project,'.pi/extensions/provider-header.ts'),`export default function(pi){
      pi.registerProvider(${JSON.stringify(providers.A)},{headers:{${JSON.stringify(headerName)}:${JSON.stringify(projectMarkers.A)}}});
      ${mode==='cross-source'?`pi.registerProvider(${JSON.stringify(providers.B)},{headers:{${JSON.stringify(headerName)}:${JSON.stringify(projectMarkers.B)}}});`:''}
    }`);
    remote=await controlledRemote({nonce,keys});const stateDir=join(root,'state');
    const cipher={isAvailable:()=>true,encrypt:value=>Buffer.from(value),decrypt:bytes=>bytes.toString()};
    const store=new ProviderDirectoryStore({stateDir},cipher,{catalogBaseUrl:remote.origin+'/catalog'});
    await store.commitCredential(providers.A,{type:'api_key',key:keys.A});if(mode==='cross-source')await store.commitCredential(providers.B,{type:'api_key',key:keys.B});
    const model=source=>({id:'owned-'+source+'-'+nonce,name:'Owned '+source,provider:providers[source],api:'openai-completions',baseUrl:remote.origin+'/'+source+'/v1',
      input:['text'],reasoning:false,contextWindow:128000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},
      headers:{[source==='A'?'x-dcode-model-a':'x-dcode-model-b']:nativeMarkers[source]}});
    const models={A:model('A'),B:model('B')};
    const preset=(id,models)=>({id,name:'Owned '+id,authKinds:['api_key'],provider:createProvider({id,name:'Owned '+id,models,
      auth:{apiKey:{name:'owned fixture key',check:async({credential})=>credential?.type==='api_key'?{type:'api_key',source:'owned isolated credential'}:undefined,
        resolve:async({credential})=>credential?.type==='api_key'?{auth:{apiKey:credential.key},source:'owned isolated credential'}:undefined}},
      api:{stream:openaiCompletions.stream,streamSimple:openaiCompletions.streamSimple}})});
    const presetA=preset(providers.A,mode==='same-source'?[models.A,models.B]:[models.A]);
    const presetB=mode==='same-source'?presetA:preset(providers.B,[models.B]);
    const source=(id,preset,models)=>({kind:'preset',providerId:id,preset,models});
    const target={workspaceId:'space',taskId:'task-'+mode,sessionId:'header-admission-'+mode};
    const backend=createPresetPiBackend({stateDir,selection:{providerId:providers.A,modelId:models.A.id},preset:presetA,model:models.A,info:{id:models.A.id,name:models.A.name},store,
      additionalSources:mode==='same-source'?[source(providers.A,presetA,[models.A,models.B])]:[source(providers.B,presetB,[models.B])],
      admitRequest:async request=>{const chosen=switched?{sourceId:providers.B,modelId:models.B.id,thinkingLevel:null}:{sourceId:providers.A,modelId:models.A.id,thinkingLevel:null};
        admissions.push({sessionId:request.sessionId,sourceId:request.sourceId,modelId:request.modelId,chosen});return {ok:true,reason:null,target:chosen};}});
    const opening={target,title:'Header SDK target switch '+mode,workFolder:project,model:null,initialize:true,projectAccess:'task-owner',projectExtensionsEnabled:()=>true};
    session=await backend.open(opening);assert.equal(remote.requests.length,0);
    const first=await submitDone(session,target,'OWNED_FIRST_INPUT_'+nonce,'owned-first-'+nonce);
    assert.equal(remote.requests.length,1);assert.equal(remote.of('A').length,1);assert.equal(remote.of('B').length,0);
    const a=remote.of('A')[0];assert.equal(a.model,models.A.id);assert.equal(a.authOk,true);assert.equal(a.projectMarker,projectMarkers.A);assert.equal(a.aNativeHeader,nativeMarkers.A);assert.equal(a.bNativeHeader,null);assert.equal(a.input,first.input.text);assertReply(first.view,a,providers.A,models.A.id);
    assert.equal(admissions.length,1);assert.deepEqual(admissions[0].chosen,{sourceId:providers.A,modelId:models.A.id,thinkingLevel:null});

    // Do not configure B before submit: the original SDK request must have captured A, then this real admission adopts B.
    const before=remote.requests.length;switched=true;
    const second=await submitDone(session,target,'OWNED_SECOND_INPUT_'+nonce,'owned-second-'+nonce);
    assert.notEqual(second.receipt.submissionId,first.receipt.submissionId);assert.equal((await session.lookupReceipt(first.input)).submissionId,first.receipt.submissionId);
    assert.equal(remote.requests.length,before+1);assert.equal(remote.of('A').length,1,'After actual A precondition, target-switch window sends no A request or probe');assert.equal(remote.of('B').length,1);
    const b=remote.of('B')[0];assert.equal(b.path,'/B/v1/chat/completions');assert.equal(b.model,models.B.id);assert.equal(b.authOk,true,'Adopted B must resolve its original source credential');assert.equal(b.input,second.input.text);
    const window=admissions.slice(1);assert.ok(window.some(record=>record.sourceId===providers.A&&record.modelId===models.A.id),'The current SDK invocation really captured A before admission');
    assert.ok(window.some(record=>record.sourceId===providers.B&&record.modelId===models.B.id),'Actual B provider redispatch must pass complete B SDK admission');
    assert.ok(window.every(record=>record.sessionId===target.sessionId&&record.chosen.sourceId===providers.B&&record.chosen.modelId===models.B.id));
    assertReply(second.view,b,providers.B,models.B.id);
    const body=JSON.stringify(b.body.messages);assert.ok(body.includes('OWNED_ADMISSION_CWD_'+nonce));
    assert.ok(b.body.messages.some(message=>message.role==='user'&&messageText(message)===first.input.text));
    assert.ok(b.body.messages.some(message=>message.role==='assistant'&&messageText(message)===a.reply));
    assert.ok(b.body.messages.some(message=>message.role==='user'&&messageText(message)===second.input.text));
    assert.equal(b.bNativeHeader,nativeMarkers.B,'Canonical B native model header belongs to the selected physical request');assert.equal(b.aNativeHeader,null,'Captured A model headers must not leak into B');
    // Target red in the raw-template implementation: auth and physical request can succeed, but factory projection is absent here.
    assert.equal(b.projectMarker,projectMarkers.B,'Adopted B must use canonical physical model with this project factory header, not the unprojected registered template');
    if(mode==='cross-source')assert.notEqual(b.projectMarker,projectMarkers.A,'Do not carry old A factory header to B');
    assert.equal(second.view.entries.filter(entry=>entry.assistantText).length,2);assert.deepEqual(remote.invalid,[]);
    await session.close();const count=remote.requests.length;
    session=await backend.open({...opening,initialize:false});await session.read();
    assert.equal((await session.submit(second.input)).submissionId,second.receipt.submissionId);assert.equal((await session.lookupReceipt(second.input)).processing,'done');assert.equal(remote.requests.length,count,'RO/same operation does not replay the admitted request');
  }finally{
    // Safe finite evidence from this owned remote: no credential values, raw request headers or user/model protocol logs.
    if(remote)console.log('[owned-provider-admission]',JSON.stringify({mode,requests:remote.requests.map(record=>({physical:record.physical,path:record.path,model:record.model,authOk:record.authOk,projectMarker:record.projectMarker,
      hasAHeader:record.aNativeHeader!==null,hasBHeader:record.bNativeHeader!==null,responseId:record.responseId})),admissions}));
    try{await session?.close();}finally{try{await remote?.close();}finally{await rm(root,{recursive:true,force:true});}}
  }
});
