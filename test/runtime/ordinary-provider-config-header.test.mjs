// 普通扩展provider公开头的真实消费者与边界；运行结果及源码资格见本片验证记录。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { ROOT_CONVERSATION_ID, ToolTask, GenerationTask } from '@earendil-works/pi-durable';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { createRealPiBackend, ModelSetupStore } from '../../src/adapters/pi/index.ts';
import { prepareCodingProject, startCodingLoopback, codingKey, codingModel } from '../e2e/ordinary-coding-fixture.mjs';
import { until } from './fixtures.ts';

const toolName='owned_provider_header', callId='actual-tool-1';
const headerName='x-dcode-extension-fixture';

// Reuse the original scripted remote. This tiny owned transport observer fills its one evidence gap:
// ownedComplete records don't expose request headers, so record only this synthetic marker + auth boolean.
// The endpoint supplied to the real SDK remains this original configured proxy URL throughout registration.
async function observeOwnedHttp(upstream,innerMarker){
  const events=[],failures=[];
  const server=http.createServer((req,res)=>{
    if(req.url!=='/v1/chat/completions'&&req.url!=='/catalog'){res.writeHead(404);res.end();return;}
    const chunks=[];req.on('data',part=>chunks.push(Buffer.from(part)));req.on('end',()=>{
      const bytes=Buffer.concat(chunks);
      if(req.method==='POST'&&req.url==='/v1/chat/completions'){
        let body;try{body=JSON.parse(bytes.toString());}catch{failures.push('invalid owned request JSON');res.writeHead(400);res.end();return;}
        events.push({kind:body.messages?.some(m=>m.role==='user'&&m.content===innerMarker)?'inner':'outer',
          path:req.url,model:body.model,authOk:req.headers.authorization==='Bearer '+codingKey,
          marker:req.headers[headerName]??null,body});
      }
      // Forward only to this test's known listening port, never a caller-controlled origin.
      const target=new URL(req.url,upstream);
      const forward=http.request(target,{method:req.method,headers:req.headers},reply=>{
        res.writeHead(reply.statusCode??500,reply.headers);reply.pipe(res);
      });
      forward.once('error',()=>{failures.push('owned forwarding failed');if(!res.headersSent)res.writeHead(502);res.end();});
      res.once('close',()=>{if(!res.writableEnded)forward.destroy();});forward.end(bytes);
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {origin:'http://127.0.0.1:'+server.address().port,events,failures,
    close:()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);})};
}

function extensionSource(nonce,innerMarker){
  return `import {Type} from 'typebox';
export default function(pi){
  // Only one serializable header patch: no model/API/endpoint/auth/native handler is supplied.
  pi.registerProvider('user-defined',{headers:{${JSON.stringify(headerName)}:${JSON.stringify(nonce)}}});
  pi.registerTool({name:${JSON.stringify(toolName)},label:'owned provider header',description:'Consume the configured model through the original owned stream',parameters:Type.Object({}),
    async execute(id,args,signal,onUpdate,ctx){
      if(!signal||ctx.signal!==signal||signal.aborted)throw new Error('Original tool signal missing');
      const model=ctx.modelRegistry.find('user-defined',${JSON.stringify(codingModel)});
      const all=ctx.modelRegistry.getAll(),available=ctx.modelRegistry.getAvailable();
      if(!model||!Array.isArray(all)||!Array.isArray(available))throw new Error('Existing model catalog contract changed');
      const inspected=[...all,...available,model],unsafeKeys=[];
      const visit=value=>{if(!value||typeof value!=='object')return;for(const [key,item]of Object.entries(value)){
        if(['headers','apikey','authorization','credentials','credential','env'].includes(key.toLowerCase()))unsafeKeys.push(key);visit(item);}};
      inspected.forEach(visit);const encoded=JSON.stringify(inspected);
      const ref=value=>({provider:value.provider,id:value.id,api:value.api});
      const catalog={all:all.map(ref),available:available.map(ref),found:ref(model),unsafeKeys,
        credentialLeaked:encoded.includes(${JSON.stringify(codingKey)}),headerLeaked:encoded.includes(${JSON.stringify(nonce)})};
      const stream=ctx.modelRegistry.streamSimple(model,{messages:[{role:'user',content:${JSON.stringify(innerMarker)},timestamp:Date.now()}]},
        {signal,maxRetries:0,maxTokens:32,temperature:0});
      const synchronous=typeof stream?.then!=='function'&&typeof stream?.[Symbol.asyncIterator]==='function'&&typeof stream?.result==='function';
      if(!synchronous)throw new Error('Public synchronous stream missing');
      const events=[];let deltas='';for await(const event of stream){events.push(event.type);if(event.type==='text_delta'){
        deltas+=event.delta;onUpdate?.({content:[{type:'text',text:event.delta}]});}}
      const result=await stream.result();if(signal.aborted||result.stopReason==='error'||result.stopReason==='aborted')throw new Error('Actual owned request did not succeed');
      const observed={probe:'actual-provider-header',nonce:${JSON.stringify(nonce)},originalToolCallId:id,synchronous,catalog,events,deltas,
        message:{role:result.role,provider:result.provider,model:result.model,responseId:result.responseId,stopReason:result.stopReason,
          text:result.content.filter(p=>p.type==='text').map(p=>p.text).join(''),usage:result.usage}};
      return {content:[{type:'text',text:JSON.stringify(observed)}],details:{ownedProviderHeader:observed}};
    }});
}`;
}

const total=bucket=>Object.values(bucket??{}).reduce((sum,value)=>sum+value.totalTokens,0);
async function finished(session,input){
  await until(async()=>['done','unanswered'].includes((await session.lookupReceipt(input)).processing));
  assert.equal((await session.lookupReceipt(input)).processing,'done','Preparation/registration failure must not be mistaken for a header consumer pass');
  await until(async()=>(await session.read()).phase==='ready');
}
// Read only after real Session.close; no second reader is opened on the original live files.
async function saved(stateDir,target){
  const storage=await openNodeJsonlStorage(join(stateDir,'runtime',target.sessionId),context);
  const scan=async method=>{const values=[];let cursor;do{const page=await storage[method]({conversationId:ROOT_CONVERSATION_ID},200,cursor,context);values.push(...page.items);cursor=page.next;}while(cursor!==undefined);return values;};
  try{
    const entries=await scan('scanEntries'),tasks=await scan('scanTasks');
    const record=await storage.findDocument({kind:'pi.usage',scope:{kind:'conversation',conversationId:ROOT_CONVERSATION_ID}},'current',context);
    const usage=record?(await storage.document(record.id,'current',context)).value:{models:{},tools:{}};
    return {entries,tasks,usage,messages:entries.flatMap(entry=>entry.model??[])};
  }finally{await storage.close(context);}
}

await test('普通factory provider header：首次/owned stream/后续HTTP真实消费，RO不重发且关闭后不污染同backend的S2',{timeout:30000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'dcode-provider-header-')),nonce=randomUUID();
  const marker='PROVIDER_CONFIG_DIRECT_INPUT_'+nonce,text='PROVIDER_CONFIG_DIRECT_RESULT_'+nonce,responseId='provider-header-inner-'+nonce;
  const projectA=join(root,'project-a'),projectB=join(root,'project-b'),stateDir=join(root,'state');
  let remote,observer,s1,s2;
  try{
    await prepareCodingProject(projectA);await prepareCodingProject(projectB);
    await mkdir(join(projectA,'.pi/extensions'),{recursive:true});
    await writeFile(join(projectA,'.pi/extensions/provider-header.ts'),extensionSource(nonce,marker));
    await writeFile(join(projectA,'.pi/mcp.json'),'{"mcpServers":{}}');await writeFile(join(projectB,'.pi/mcp.json'),'{"mcpServers":{}}');
    remote=await startCodingLoopback({callsOverride:[[toolName,{}]],ownedComplete:{marker,text,responseId}});
    observer=await observeOwnedHttp(remote.origin,marker);
    const cipher={isAvailable:()=>true,encrypt:value=>Buffer.from(value),decrypt:bytes=>bytes.toString()};
    const store=new ModelSetupStore({stateDir},cipher),config={provider:'openai-completions',label:'owned provider header fixture',modelId:codingModel,baseUrl:observer.origin+'/v1'};
    await store.commitWithCredential({...config,note:'ready',keyAction:'replace',apiKey:codingKey});
    const admissions=[];
    const backend=createRealPiBackend({stateDir,cipher,store,config,admitRequest:async request=>{
      admissions.push({...request});return {ok:true,reason:null,target:{sourceId:request.sourceId,modelId:request.modelId,thinkingLevel:null}};}});
    const targetA={workspaceId:'space',taskId:'task-a',sessionId:'provider-header-s1'},targetB={workspaceId:'space',taskId:'task-b',sessionId:'provider-header-s2'};
    const openingA={target:targetA,title:'Provider header S1',workFolder:projectA,model:null,initialize:true,projectAccess:'task-owner',projectExtensionsEnabled:()=>true};
    s1=await backend.open(openingA);
    const inputA={target:targetA,operationId:'provider-header-original-'+nonce,text:'S1 actual owned provider request '+nonce,references:[],mode:'follow-up',expected:(await s1.read()).control};
    const accepted=await s1.submit(inputA);assert.equal(accepted.status,'accepted');await finished(s1,inputA);
    assert.equal(remote.requests.length,2,'Actual original generation and following tool continuation');assert.equal(remote.completeRequests.length,1,'One actual owned stream HTTP');
    assert.deepEqual(remote.errors,[]);assert.deepEqual(observer.failures,[]);
    assert.deepEqual(observer.events.map(event=>event.kind),['outer','inner','outer']);
    for(const event of observer.events){assert.equal(event.marker,nonce,'Factory header must reach first, inner and following actual HTTP');assert.equal(event.authOk,true);assert.equal(event.model,codingModel);assert.equal(event.path,'/v1/chat/completions');}
    assert.deepEqual(remote.requests.map(request=>request.extensionHeader),[nonce,nonce],'Original public loopback independently sees both outer header values');
    assert.equal(remote.completeRequests[0].authOk,true);assert.equal(remote.completeRequests[0].model,codingModel);assert.equal(remote.completeRequests[0].finished,true);
    assert.deepEqual(observer.events[1].body.messages.filter(message=>message.role==='user'),[{role:'user',content:marker}],'Owned model input is this call, not an extra conversation loop');
    const view=await s1.read(),results=view.entries.filter(entry=>entry.toolResult?.name===toolName&&entry.toolResult.callId===callId);
    assert.equal(results.length,1);assert.equal(results[0].toolResult.isError,false);const observed=JSON.parse(results[0].toolResult.text);
    assert.equal(observed.probe,'actual-provider-header');assert.equal(observed.nonce,nonce);assert.equal(observed.originalToolCallId,callId);assert.equal(observed.synchronous,true);
    const expectedRef={provider:'user-defined',id:codingModel,api:'openai-completions'};
    assert.deepEqual(observed.catalog.found,expectedRef);assert.deepEqual(observed.catalog.all,[expectedRef]);assert.deepEqual(observed.catalog.available,[expectedRef]);
    assert.deepEqual(observed.catalog.unsafeKeys,[]);assert.equal(observed.catalog.credentialLeaked,false);assert.equal(observed.catalog.headerLeaked,false);
    assert.ok(observed.events.includes('text_delta'));assert.ok(observed.events.includes('done'));assert.equal(observed.deltas,text);
    assert.equal(observed.message.provider,'user-defined');assert.equal(observed.message.model,codingModel);assert.equal(observed.message.responseId,responseId);assert.equal(observed.message.stopReason,'stop');assert.equal(observed.message.text,text);
    assert.equal(observed.message.usage.input,117);assert.equal(observed.message.usage.output,13);assert.equal(observed.message.usage.totalTokens,130);
    assert.equal(remote.requests[1].body.messages.filter(message=>message.role==='tool'&&message.tool_call_id===callId&&message.content===JSON.stringify(observed)).length,1,'Same original tool result reaches the next real HTTP');
    const facts=view.entries.filter(entry=>entry.kind==='dcode.extension-model-result'&&entry.responseId===responseId);assert.equal(facts.length,1);assert.equal(facts[0].provider,'user-defined');assert.equal(facts[0].model,codingModel);assert.deepEqual(facts[0].usage,{input:117,output:13,cacheRead:0,cacheWrite:0});
    assert.equal(admissions.length,3);assert.ok(admissions.every(request=>request.sessionId===targetA.sessionId&&request.sourceId==='user-defined'&&request.modelId===codingModel));
    await s1.close();const before=await saved(stateDir,targetA),owners=before.tasks.filter(task=>task.kind===ToolTask.definition.name&&task.input.callId===callId);
    assert.equal(owners.length,1);const owner=owners[0],children=before.tasks.filter(task=>task.owner===owner.id);assert.equal(children.length,1);const child=children[0];
    assert.equal(child.kind,'dcode.extension-model');assert.notEqual(child.kind,GenerationTask.definition.name);assert.equal(child.conversationId,owner.conversationId);assert.equal(child.input.ownerTaskId,owner.id);
    assert.equal(child.input.provider,'user-defined');assert.equal(child.input.modelId,codingModel);
    for(const task of [owner,child]){assert.equal(task.state.status,'terminal');assert.equal(task.state.outcome.status,'completed');}
    const formal=before.messages.filter(message=>message.role==='toolResult'&&message.toolName===toolName&&message.toolCallId===callId);assert.equal(formal.length,1);assert.equal(formal[0].isError,false);assert.deepEqual(formal[0].usage,observed.message.usage);
    assert.equal(total(before.usage.tools),130);assert.deepEqual(before.usage.tools[toolName],observed.message.usage);
    assert.equal(total(before.usage.models),5,'Existing loopback outer usage is (1+1)+(2+1), not the active fixture constant 6');
    assert.deepEqual(before.messages.filter(message=>message.role==='assistant').map(message=>message.responseId).sort(),['actual-response-1','actual-response-2']);
    assert.equal(before.entries.filter(entry=>entry.kind==='pi.user').length,1);
    const counts={requests:observer.events.length,inner:remote.completeRequests.length,outer:remote.requests.length,admissions:admissions.length};
    s1=await backend.open({...openingA,initialize:false});assert.equal((await s1.read()).phase,'ready');
    assert.equal((await s1.submit(inputA)).submissionId,accepted.submissionId);assert.equal((await s1.lookupReceipt(inputA)).processing,'done');
    assert.deepEqual({requests:observer.events.length,inner:remote.completeRequests.length,outer:remote.requests.length,admissions:admissions.length},counts,'RO/old operation receipt cannot load configuration by executing or replay the owned call');
    await s1.close();const restored=await saved(stateDir,targetA);assert.deepEqual(restored.usage,before.usage);
    assert.equal(restored.tasks.filter(task=>task.owner===owner.id).length,1);assert.equal(restored.tasks.find(task=>task.id===child.id).owner,owner.id);

    // Same backend object, fresh per-session client, no extension in B. A closed S1 provider patch must not become process/global configuration.
    const openingB={...openingA,target:targetB,title:'Provider header S2',workFolder:projectB};s2=await backend.open(openingB);
    const inputB={target:targetB,operationId:'provider-header-clean-s2-'+nonce,text:'S2 independent input '+randomUUID(),references:[],mode:'follow-up',expected:(await s2.read()).control};
    const second=await s2.submit(inputB);assert.equal(second.status,'accepted');await finished(s2,inputB);
    assert.equal(remote.requests.length,3);assert.equal(remote.completeRequests.length,1);assert.equal(observer.events.length,4);
    const clean=observer.events[3];assert.equal(clean.kind,'outer');assert.equal(clean.marker,null,'The next same-backend session must not inherit S1 header registration');assert.equal(clean.authOk,true);assert.equal(clean.model,codingModel);assert.equal(clean.path,'/v1/chat/completions');
    assert.equal(remote.requests[2].extensionHeader,null);const body=JSON.stringify(clean.body.messages);assert.ok(body.includes(inputB.text));assert.ok(!body.includes(inputA.text));assert.ok(!body.includes(marker));
    const secondView=await s2.read();assert.equal(secondView.entries.filter(entry=>entry.toolResult?.name===toolName).length,0);
    assert.ok(secondView.entries.some(entry=>entry.responseId==='actual-response-3'&&entry.assistantText===remote.nonce));
    assert.equal(admissions.length,4);assert.equal(admissions[3].sessionId,targetB.sessionId);assert.equal(admissions[3].sourceId,'user-defined');assert.equal(admissions[3].modelId,codingModel);
    await s2.close();const secondRaw=await saved(stateDir,targetB);assert.equal(secondRaw.tasks.filter(task=>task.kind==='dcode.extension-model').length,0);assert.equal(total(secondRaw.usage.tools),0);assert.equal(total(secondRaw.usage.models),4);
    assert.equal(secondRaw.entries.filter(entry=>entry.kind==='pi.user').length,1);assert.deepEqual(remote.errors,[]);assert.deepEqual(observer.failures,[]);
  }finally{try{await s1?.close();}finally{try{await s2?.close();}finally{try{await observer?.close();}finally{await remote?.close();await rm(root,{recursive:true,force:true});}}}}
});
