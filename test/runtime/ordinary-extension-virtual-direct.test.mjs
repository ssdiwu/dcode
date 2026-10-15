// 真实 SDK/普通资源装配的 virtual direct 消费者。仅本例拥有的远端被脚本化。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { GenerationTask, ToolTask, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { createProvider } from '@earendil-works/pi-ai/models';
import * as openaiCompletions from '@earendil-works/pi-ai/api/openai-completions';
import { createRealPiBackend, ModelSetupStore } from '../../src/adapters/pi/index.ts';
import { prepareCodingProject, codingKey, codingModel } from '../e2e/ordinary-coding-fixture.mjs';
import { until } from './fixtures.ts';

const toolName='owned_virtual_direct', callId='owned-virtual-direct-tool-1';
const virtualProvider='owned-virtual-direct-source', virtualId='owned-virtual-direct';
const providerB='owned-virtual-physical-b';
const traceName='virtual-direct-observation.json';

// A 与 B 有不同路径、模型、凭据及 B 专属 header。伪造端点仍在本例端口，绝不访问外网。
async function controlledHttp(nonce) {
  const modelB='physical-b-'+nonce, keyB='isolated-b-key-'+nonce, headerB='isolated-b-header-'+nonce;
  const marker='VIRTUAL_DIRECT_INPUT_'+nonce, innerText='VIRTUAL_DIRECT_RESULT_'+nonce;
  const requests=[], errors=[], gates=[], controlGates={cancel:[],owner:[]};
  const chunk=(res,id,model,delta,finish,usage)=>res.write('data: '+JSON.stringify({id,model,
    choices:[{index:0,delta,finish_reason:finish}],...(usage?{usage}:{})})+'\n\n');
  const server=http.createServer((req,res)=>{
    if(req.method==='GET' && req.url==='/route-gate/'+nonce){
      const gate={accepted:true,released:false,closed:false,releaseAttempted:false,delivered:false,res};gates.push(gate);
      res.once('close',()=>{gate.closed=true;});return;
    }
    const controlKind=req.url==='/cancel-model/'+nonce?'cancel':req.url==='/hold-owner/'+nonce?'owner':null;
    if(req.method==='GET'&&controlKind){
      const gate={accepted:true,released:false,closed:false,delivered:false,res};controlGates[controlKind].push(gate);
      res.once('close',()=>{gate.closed=true;});return;
    }
    if(req.url==='/catalog'){res.writeHead(200,{'content-type':'application/json'});res.end('{"models":[],"providers":[]}');return;}
    if(req.method!=='POST'||!['/A/v1/chat/completions','/B/v1/chat/completions','/forged/v1/chat/completions'].includes(req.url)){
      res.writeHead(404);res.end();return;
    }
    const parts=[];req.on('data',p=>parts.push(Buffer.from(p)));req.on('end',()=>{
      let body;try{body=JSON.parse(Buffer.concat(parts).toString());}catch{errors.push('owned JSON invalid');res.writeHead(400);res.end();return;}
      const source=req.url.startsWith('/A/')?'A':req.url.startsWith('/B/')?'B':'forged';
      const ordinal=requests.filter(r=>r.source===source).length+1;
      const record={source,ordinal,id:'virtual-'+source+'-'+nonce+'-'+ordinal,body,path:req.url,
        authOk:req.headers.authorization==='Bearer '+(source==='A'?codingKey:keyB),
        headerOk:source==='A'||req.headers['x-dcode-catalog-secret']===headerB,finished:false};requests.push(record);
      if(source==='forged'||!record.authOk||!record.headerOk||body.model!==(source==='A'?codingModel:modelB)||ordinal>(source==='A'?2:1)){
        errors.push('wrong actual physical identity/auth/header or duplicate');res.writeHead(400);res.end();return;
      }
      if(source==='B'&&!body.messages?.some(m=>m.role==='user'&&m.content===marker)){
        errors.push('B did not receive this direct nonce');res.writeHead(400);res.end();return;
      }
      res.writeHead(200,{'content-type':'text/event-stream'});
      if(source==='A'&&ordinal===1){
        chunk(res,record.id,body.model,{role:'assistant',tool_calls:[{index:0,id:callId,type:'function',function:{name:toolName,arguments:'{}'}}]},null);
        chunk(res,record.id,body.model,{},'tool_calls',{prompt_tokens:2,completion_tokens:1,total_tokens:3});
      }else{
        chunk(res,record.id,body.model,{role:'assistant',content:source==='B'?innerText:'VIRTUAL_OUTER_RESULT_'+nonce},null);
        chunk(res,record.id,body.model,{},'stop',source==='B'?{prompt_tokens:117,completion_tokens:13,total_tokens:130}:{prompt_tokens:2,completion_tokens:1,total_tokens:3});
      }
      record.finished=true;res.end('data: [DONE]\n\n');
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {origin:'http://127.0.0.1:'+server.address().port,modelB,keyB,headerB,marker,innerText,requests,errors,gates,controlGates,
    of:source=>requests.filter(r=>r.source===source),
    releaseGate(){assert.equal(gates.length,1,'One actual accepted route wait');const g=gates[0];g.releaseAttempted=true;g.released=true;
      if(!g.res.destroyed&&!g.res.writableEnded){g.res.writeHead(200,{'content-type':'text/plain'});g.res.end('release '+nonce);g.delivered=true;}return g;},
    releaseControl(kind){const list=controlGates[kind];assert.ok(list);assert.equal(list.length,1,'One actual accepted '+kind+' handshake');
      const gate=list[0];assert.equal(gate.released,false);assert.equal(gate.closed,false);assert.equal(gate.res.destroyed,false);
      gate.released=true;gate.res.writeHead(200,{'content-type':'text/plain'});gate.res.end(nonce);gate.delivered=true;return gate;},
    close:()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);})};
}

function extensionSource(nonce,remote,holdRoute,mutationProbe=false) {
  // The router intentionally ignores its signal while waiting. Files are this isolated project only.
  // No host operation is invoked from the router; the second ctx argument is used for a catalog getter only.
  return `import {Type} from 'typebox';import {writeFile,rename} from 'node:fs/promises';import {join} from 'node:path';
export default function(pi){
  const nonce=${JSON.stringify(nonce)},trace={nonce,steps:[]};let file,activeBefore,serial=0,pending=Promise.resolve();
  const note=(phase,extra={})=>{trace.steps.push({phase,...extra});const bytes=JSON.stringify(trace),temp=file+'.tmp-'+(++serial);
    const save=pending.then(async()=>{await writeFile(temp,bytes);await rename(temp,file);});pending=save;return save;};
  pi.registerVirtualModel({provider:${JSON.stringify(virtualProvider)},id:${JSON.stringify(virtualId)},name:'owned virtual direct',
    thinkingLevels:['off'],input:['text'],contextWindow:128000,maxTokens:4096,
    async route(request,ctx){
      await note('route-entered',{reason:request.reason,stateUndefined:request.state===undefined,
        selected:{provider:request.model.provider,id:request.model.id,api:request.model.api},
        messages:request.messages.map(m=>({role:m.role,content:m.content})),signalPresent:!!request.signal,signalAborted:request.signal?.aborted===true});
      if(${JSON.stringify(holdRoute)}){
        // Deliberately do NOT pass request.signal to this owned remote wait.
        const held=await fetch(${JSON.stringify(remote.origin+'/route-gate/'+nonce)});await held.text();
      }
      if(${JSON.stringify(mutationProbe)}){
        let setRejected=false,registerRejected=false,providerRejected=false;
        try{pi.setActiveTools([]);}catch{setRejected=true;}
        try{pi.registerTool({name:'route_pure_injected',label:'must be rejected',description:'pure route mutation probe',parameters:Type.Object({}),async execute(){return {content:[{type:'text',text:'must not register'}]};}});}catch{registerRejected=true;}
        try{pi.registerProvider(${JSON.stringify(providerB)},{headers:{'x-pure-provider-mutation':'must-not-register'}});}catch{providerRejected=true;}
        await note('pure-mutations',{setRejected,registerRejected,providerRejected});
      }
      const canonical=ctx.modelRegistry.find(${JSON.stringify(providerB)},${JSON.stringify(remote.modelB)});
      if(!canonical)throw new Error('Configured B absent from the real catalog');
      await note('route-returning',{signalAborted:request.signal?.aborted===true});
      return {model:{...canonical,provider:${JSON.stringify(providerB)},id:${JSON.stringify(remote.modelB)},
        baseUrl:${JSON.stringify(remote.origin+'/forged/v1')},headers:{'x-dcode-catalog-secret':'forged-'+nonce,authorization:'Bearer forged-'+nonce}},
        thinkingLevel:'off',state:{directStateMustNotAdvance:nonce}};
    }});
  pi.registerTool({name:${JSON.stringify(toolName)},label:'owned virtual direct',description:'One real owned virtual direct stream',parameters:Type.Object({}),
    async execute(id,args,signal,onUpdate,ctx){
      file=join(ctx.cwd,${JSON.stringify(traceName)});activeBefore=pi.getActiveTools();await note('tool-entered',{originalToolCallId:id,signalSame:!!signal&&ctx.signal===signal});
      const virtual=ctx.modelRegistry.find(${JSON.stringify(virtualProvider)},${JSON.stringify(virtualId)});
      if(!virtual||virtual.api!=='pi-virtual')throw new Error('Factory registration not confirmed in actual catalog');
      await note('catalog-confirmed',{available:ctx.modelRegistry.getAvailable().some(m=>m.provider===virtual.provider&&m.id===virtual.id),count:ctx.modelRegistry.getAll().filter(m=>m.provider===virtual.provider&&m.id===virtual.id).length,containsCredentials:/apiKey|authorization|x-dcode-catalog-secret/i.test(JSON.stringify(virtual))});
      const stream=ctx.modelRegistry.streamSimple(virtual,{messages:[{role:'user',content:${JSON.stringify(remote.marker)},timestamp:Date.now()}]},
        {signal,maxRetries:0,maxTokens:32,temperature:0});
      const synchronous=typeof stream?.then!=='function'&&typeof stream?.[Symbol.asyncIterator]==='function'&&typeof stream?.result==='function';
      await note('factory-returned',{synchronous});if(!synchronous)throw new Error('Synchronous public stream missing');
      const eventTypes=[];let deltas='';for await(const event of stream){eventTypes.push(event.type);if(event.type==='text_delta'){
        deltas+=event.delta;onUpdate?.({content:[{type:'text',text:event.delta}]});}}
      const result=await stream.result();await note('result-settled',{stopReason:result.stopReason,signalAborted:signal.aborted});
      if(signal.aborted||result.stopReason==='error'||result.stopReason==='aborted')throw new Error('Virtual direct did not complete successfully');
      const observed={nonce,originalToolCallId:id,synchronous,eventTypes,deltas,
        message:{role:result.role,provider:result.provider,model:result.model,responseId:result.responseId,stopReason:result.stopReason,
          text:result.content.filter(p=>p.type==='text').map(p=>p.text).join(''),usage:result.usage}};
      if(${JSON.stringify(mutationProbe)})await note('tool-loadout-after',{activeBefore,activeAfter:pi.getActiveTools(),allNames:pi.getAllTools().map(t=>t.name)});
      await note('tool-returning');return {content:[{type:'text',text:JSON.stringify(observed)}],details:{ownedVirtualDirect:observed}};
    }});
}`;
}


// Separate extension source: the original owner remains alive while only the model signal is cancelled.
// This does not change any source/assertion used by the original four cases or the pure-route probe.
function liveOwnerAbortExtension(nonce,remote){
  return `import {Type} from 'typebox';import {writeFile,rename} from 'node:fs/promises';import {join} from 'node:path';
export default function(pi){
  const nonce=${JSON.stringify(nonce)},trace={nonce,steps:[]};let file,ownerSignal,serial=0,pending=Promise.resolve();
  const note=(phase,extra={})=>{trace.steps.push({phase,ownerSignalAborted:ownerSignal?.aborted===true,...extra});
    const bytes=JSON.stringify(trace),temp=file+'.tmp-'+(++serial);const save=pending.then(async()=>{await writeFile(temp,bytes);await rename(temp,file);});pending=save;return save;};
  const summary=result=>({role:result.role,provider:result.provider,model:result.model,responseId:result.responseId,
    stopReason:result.stopReason,text:result.content.filter(p=>p.type==='text').map(p=>p.text).join(''),usage:result.usage});
  pi.registerVirtualModel({provider:${JSON.stringify(virtualProvider)},id:${JSON.stringify(virtualId)},name:'owned virtual direct',
    thinkingLevels:['off'],input:['text'],contextWindow:128000,maxTokens:4096,
    async route(request,ctx){
      const canonical=ctx.modelRegistry.find(${JSON.stringify(providerB)},${JSON.stringify(remote.modelB)});
      if(!canonical)throw new Error('Configured B absent before the held route');
      await note('route-entered',{reason:request.reason,stateUndefined:request.state===undefined,
        selected:{provider:request.model.provider,id:request.model.id,api:request.model.api},
        messages:request.messages.map(m=>({role:m.role,content:m.content})),signalPresent:!!request.signal,signalAborted:request.signal?.aborted===true});
      // Intentionally ignore request.signal. The original worker/owner is kept alive by a different actual HTTP gate.
      const held=await fetch(${JSON.stringify(remote.origin+'/route-gate/'+nonce)});await held.text();
      await note('route-returning',{signalAborted:request.signal?.aborted===true});
      return {model:{...canonical,provider:${JSON.stringify(providerB)},id:${JSON.stringify(remote.modelB)},
        baseUrl:${JSON.stringify(remote.origin+'/forged/v1')},headers:{'x-dcode-catalog-secret':'forged-'+nonce}},
        thinkingLevel:'off',state:{directStateMustNotAdvance:nonce}};
    }});
  pi.registerTool({name:${JSON.stringify(toolName)},label:'owned live route cancellation',description:'Keep owner alive for an actual late virtual route return',parameters:Type.Object({}),
    async execute(id,args,signal,onUpdate,ctx){
      file=join(ctx.cwd,${JSON.stringify(traceName)});ownerSignal=signal;const controller=new AbortController();
      await note('tool-entered',{originalToolCallId:id,signalSame:!!signal&&ctx.signal===signal,signalsDistinct:controller.signal!==signal});
      const virtual=ctx.modelRegistry.find(${JSON.stringify(virtualProvider)},${JSON.stringify(virtualId)});if(!virtual||virtual.api!=='pi-virtual')throw new Error('Actual virtual registration missing');
      await note('catalog-confirmed',{available:ctx.modelRegistry.getAvailable().some(m=>m.provider===virtual.provider&&m.id===virtual.id),count:ctx.modelRegistry.getAll().filter(m=>m.provider===virtual.provider&&m.id===virtual.id).length,containsCredentials:/apiKey|authorization|x-dcode-catalog-secret/i.test(JSON.stringify(virtual))});
      // The owned remote handshake releases only after the route callback is demonstrably parked.
      const cancel=(async()=>{const response=await fetch(${JSON.stringify(remote.origin+'/cancel-model/'+nonce)},{signal});
        if(await response.text()!==nonce)throw new Error('Wrong owned cancellation handshake');
        await note('model-aborting',{modelSignalAborted:controller.signal.aborted});controller.abort(new Error('cancel only this model route'));
        await note('model-aborted',{modelSignalAborted:controller.signal.aborted});})();void cancel.catch(()=>{});
      const stream=ctx.modelRegistry.streamSimple(virtual,{messages:[{role:'user',content:${JSON.stringify(remote.marker)},timestamp:Date.now()}]},
        {signal:controller.signal,maxRetries:0,maxTokens:32,temperature:0});
      const synchronous=typeof stream?.then!=='function'&&typeof stream?.[Symbol.asyncIterator]==='function'&&typeof stream?.result==='function';
      await note('factory-returned',{synchronous});if(!synchronous)throw new Error('Public synchronous stream missing');
      const eventTypes=[];for await(const event of stream){eventTypes.push(event.type);
        if(event.type==='done'||event.type==='error')await note('terminal-event',{type:event.type,reason:event.reason,message:summary(event.type==='error'?event.error:event.message)});}
      const result=await stream.result(),again=await stream.result();await cancel;
      const same=JSON.stringify(summary(result))===JSON.stringify(summary(again));
      await note('result-settled',{modelSignalAborted:controller.signal.aborted,message:summary(result),eventTypes,resultReadbackConsistent:same});
      if(signal.aborted||!controller.signal.aborted||!same||!['error','aborted'].includes(result.stopReason))throw new Error('Model cancellation did not preserve the original owner');
      // Arriving at this distinct HTTP gate proves the handler got a finite local result and remains alive.
      await note('owner-awaiting-release',{modelSignalAborted:controller.signal.aborted});
      const heldOwner=await fetch(${JSON.stringify(remote.origin+'/hold-owner/'+nonce)},{signal});
      if(await heldOwner.text()!==nonce)throw new Error('Wrong owned handler release');
      if(signal.aborted)throw new Error('Original owner was unexpectedly aborted');
      const observed={probe:'virtual-direct-live-owner',nonce,originalToolCallId:id,synchronous,ownerSignalAborted:signal.aborted,
        modelSignalAborted:controller.signal.aborted,eventTypes,resultReadbackConsistent:same,message:summary(result)};
      await note('tool-returning');return {content:[{type:'text',text:JSON.stringify(observed)}],details:{ownedVirtualDirect:observed}};
    }});
}`;
}

async function fixture({rejectB=false,holdRoute=false,mutationProbe=false,source=extensionSource}={}){
  const root=await mkdtemp(join(tmpdir(),'dcode-owned-virtual-direct-')),project=join(root,'project'),nonce=randomUUID();
  let remote,session;
  try{
    await prepareCodingProject(project);remote=await controlledHttp(nonce);
    await mkdir(join(project,'.pi/extensions'),{recursive:true});await writeFile(join(project,'.pi/mcp.json'),'{"mcpServers":{}}');
    await writeFile(join(project,'.pi/extensions/virtual-direct.ts'),source(nonce,remote,holdRoute,mutationProbe));
    const stateDir=join(root,'state'),cipher={isAvailable:()=>true,encrypt:text=>Buffer.from(text),decrypt:bytes=>bytes.toString()};
    const store=new ModelSetupStore({stateDir},cipher);
    const config={provider:'openai-completions',label:'owned outer A',modelId:codingModel,baseUrl:remote.origin+'/A/v1'};
    await store.commitWithCredential({...config,note:'ready',keyAction:'replace',apiKey:codingKey});
    const modelB={provider:providerB,id:remote.modelB,name:remote.modelB,api:'openai-completions',baseUrl:remote.origin+'/B/v1',
      input:['text'],reasoning:false,contextWindow:128000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},
      headers:{'x-dcode-catalog-secret':remote.headerB}};
    // Same formal configured-source assembly as ordinary-extension-mcp/catalog; only synthetic auth is supplied.
    const provider=createProvider({id:providerB,name:'owned physical B',models:[modelB],
      auth:{apiKey:{name:'owned B key',check:async()=>({type:'api_key',source:'owned fixture'}),
        resolve:async()=>({auth:{apiKey:remote.keyB},source:'owned fixture'})}},
      api:{stream:openaiCompletions.stream,streamSimple:openaiCompletions.streamSimple}});
    const preset={id:providerB,name:'owned physical B',provider,authKinds:['api_key']};
    const admissions=[],target={workspaceId:'space',taskId:'task',sessionId:'owned-virtual-direct-session'};
    const backend=createRealPiBackend({stateDir,cipher,store,config,additionalSources:[{kind:'preset',providerId:providerB,preset,models:[modelB]}],
      admitRequest:async request=>{admissions.push({...request});return rejectB&&request.sourceId===providerB
        ?{ok:false,reason:'owned B admission rejected',target:null}
        :{ok:true,reason:null,target:{sourceId:request.sourceId,modelId:request.modelId,thinkingLevel:null}};}});
    const opening={target,title:'Owned virtual direct',workFolder:project,model:null,initialize:true,projectAccess:'task-owner',projectExtensionsEnabled:()=>true};
    session=await backend.open(opening);
    const input={target,operationId:'owned-virtual-'+nonce,text:'Run this one owned virtual direct tool',references:[],mode:'follow-up',expected:(await session.read()).control};
    return {root,project,nonce,stateDir,remote,backend,target,opening,input,admissions,
      get session(){return session;},set session(value){session=value;},
      async dispose(){try{await session?.close();}finally{try{await remote.close();}finally{await rm(root,{recursive:true,force:true});}}}};
  }catch(error){try{await session?.close();}finally{await remote?.close();await rm(root,{recursive:true,force:true});}throw error;}
}
async function trace(f){try{return JSON.parse(await readFile(join(f.project,traceName),'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function acceptedAndStarted(f){
  const accepted=await f.session.submit(f.input);assert.equal(accepted.status,'accepted');
  let receipt;await until(async()=>{receipt=await f.session.lookupReceipt(f.input);return f.remote.of('A').length>0||['unanswered','done'].includes(receipt.processing);});
  assert.ok(f.remote.of('A').length>=1,'Factory/preparation must reach the original real A request before route business assertions; unavailable registration is a distinct prep-stage red');assert.equal(f.remote.of('A')[0].ordinal,1);return accepted;
}
async function done(f){await until(async()=>(await f.session.lookupReceipt(f.input)).processing==='done');await until(async()=>(await f.session.read()).phase==='ready');}
function assertRoute(f,value,{returned=true}={}){
  assert.ok(value);assert.equal(value.nonce,f.nonce);
  const starts=value.steps.filter(s=>s.phase==='route-entered');assert.equal(starts.length,1,'One actual callback, no route replay');
  assert.equal(starts[0].reason,'direct');assert.equal(starts[0].stateUndefined,true);assert.equal(starts[0].signalPresent,true);assert.equal(starts[0].signalAborted,false);
  assert.deepEqual(starts[0].selected,{provider:virtualProvider,id:virtualId,api:'pi-virtual'});
  const users=starts[0].messages.filter(m=>m.role==='user');assert.deepEqual(users,[{role:'user',content:f.remote.marker}],'Direct uses this call messages, not the agent transcript');
  assert.equal(value.steps.filter(s=>s.phase==='route-returning').length,returned?1:0);
  assert.equal(value.steps.find(s=>s.phase==='tool-entered').originalToolCallId,callId);assert.equal(value.steps.find(s=>s.phase==='tool-entered').signalSame,true);
  assert.equal(value.steps.find(s=>s.phase==='factory-returned').synchronous,true);
  const catalog=value.steps.find(s=>s.phase==='catalog-confirmed');assert.ok(catalog);assert.equal(catalog.available,true);assert.equal(catalog.count,1);assert.equal(catalog.containsCredentials,false);
}
const total=bucket=>Object.values(bucket??{}).reduce((sum,v)=>sum+v.totalTokens,0);
// Open original JSONL only after actual Session close. No live second reader or invented TaskRecord.
async function records(f){
  const storage=await openNodeJsonlStorage(join(f.stateDir,'runtime',f.target.sessionId),context);
  const scan=async(method,query)=>{const values=[];let cursor;do{const p=await storage[method](query,200,cursor,context);values.push(...p.items);cursor=p.next;}while(cursor!==undefined);return values;};
  try{
    const query={conversationId:ROOT_CONVERSATION_ID},entries=await scan('scanEntries',query),tasks=await scan('scanTasks',query),submissions=await scan('scanSubmissions',query);
    const address=await storage.findDocument({kind:'dcode.input-preparation',scope:{kind:'session'},key:f.input.operationId},'current',context);assert.ok(address);
    const prepared=await storage.document(address.id,'current',context),original=await storage.submissionByRequest(ROOT_CONVERSATION_ID,f.input.operationId,context),
      inner=await storage.submissionByRequest(ROOT_CONVERSATION_ID,prepared.value.innerRequestId,context);assert.ok(original);assert.ok(inner);assert.notEqual(original.id,inner.id);
    assert.deepEqual(submissions.map(s=>s.id).sort((a,b)=>a-b),[original.id,inner.id].sort((a,b)=>a-b),'No extra accepted input for the direct child');
    const identity={originalId:original.id,innerId:inner.id,innerRequestId:prepared.value.innerRequestId};
    const owners=tasks.filter(t=>t.kind===ToolTask.definition.name&&t.input.callId===callId);assert.equal(owners.length,1);
    const children=tasks.filter(t=>t.owner===owners[0].id);assert.equal(children.length,1);const child=children[0];
    assert.equal(child.kind,'dcode.extension-model');assert.notEqual(child.kind,GenerationTask.definition.name);assert.equal(child.conversationId,ROOT_CONVERSATION_ID);
    assert.equal(child.input.ownerTaskId,owners[0].id);assert.equal(child.input.provider,virtualProvider);assert.equal(child.input.modelId,virtualId);
    const usageAddress=await storage.findDocument({kind:'pi.usage',scope:{kind:'conversation',conversationId:ROOT_CONVERSATION_ID}},'current',context);
    const usage=usageAddress?(await storage.document(usageAddress.id,'current',context)).value:{models:{},tools:{}};
    const stateAddresses=await scan('scanDocuments',{kind:'dcode.virtual-route-state',scope:{kind:'conversation',conversationId:ROOT_CONVERSATION_ID},at:'current'});
    const routeState=[];for(const address of stateAddresses)routeState.push((await storage.document(address.id,'current',context)).value);
    assert.ok(routeState.every(s=>s.revision===0&&s.hasValue===false&&s.value===null&&s.inputs.length===0),'Direct cannot advance session branch state');
    assert.ok(!JSON.stringify(routeState).includes(f.nonce),'Returned direct state must not be persisted');
    const messages=entries.flatMap(e=>e.model??[]),formal=messages.filter(m=>m.role==='toolResult'&&m.toolName===toolName&&m.toolCallId===callId);
    return {entries,tasks,identity,usage,messages,formal,owner:owners[0],child,routeState};
  }finally{await storage.close(context);}
}
function assertAdmission(f,bCount){
  assert.ok(f.admissions.every(r=>r.sessionId===f.target.sessionId));
  assert.deepEqual(f.admissions.filter(r=>r.sourceId==='user-defined').map(r=>r.modelId),[codingModel,codingModel]);
  assert.deepEqual(f.admissions.filter(r=>r.sourceId===providerB).map(r=>r.modelId),Array(bCount).fill(f.remote.modelB));
  assert.equal(f.admissions.length,2+bCount,'No virtual-provider admission and no silently omitted physical admission');assert.deepEqual(f.remote.errors,[]);
}
function assertNoInnerSuccess(raw,{stopped=false}={}){
  // Durable暂停可保存原execute检查点为pending，明确继续才收成未知；这不是仍在跑或允许重发。
  if(stopped&&raw.child.state.status==='pending')assert.equal(raw.child.state.checkpoint.phase,'execute');
  else assert.equal(raw.child.state.status,'terminal');
  if(raw.child.state.status==='terminal'&&raw.child.state.outcome.status==='completed'){
    const message=raw.child.state.outcome.result?.message;assert.ok(message);assert.ok(['error','aborted'].includes(message.stopReason));assert.equal(message.usage?.totalTokens??0,0);
  }
  assert.equal(total(raw.usage.tools),0,'Without actual inner response no inner usage may be invented');
}
async function assertReadOnlyDone(f,accepted,before){
  const requests=f.remote.requests.length,gates=f.remote.gates.length;
  f.session=await f.backend.open({...f.opening,initialize:false});assert.equal((await f.session.read()).phase,'ready');
  assert.equal((await f.session.submit(f.input)).submissionId,accepted.submissionId);assert.equal((await f.session.lookupReceipt(f.input)).processing,'done');
  assert.equal(f.remote.requests.length,requests);assert.equal(f.remote.gates.length,gates,'RO open/query cannot load or run the route');
  await f.session.close();const after=await records(f);assert.deepEqual(after.identity,before.identity);assert.deepEqual(after.usage,before.usage);
  assert.equal(after.owner.id,before.owner.id);assert.equal(after.child.id,before.child.id);assert.equal(after.formal.length,1);return after;
}

await test('普通factory virtual direct：规范物理B HTTP/认证/参数、原child owner与真实usage、direct不推进branch state',{timeout:30000},async()=>{
  const f=await fixture();try{
    const accepted=await acceptedAndStarted(f);await done(f);assertRoute(f,await trace(f));assertAdmission(f,1);
    assert.equal(f.remote.of('A').length,2);assert.equal(f.remote.of('B').length,1);assert.equal(f.remote.of('forged').length,0);
    const b=f.remote.of('B')[0];assert.equal(b.path,'/B/v1/chat/completions');assert.equal(b.authOk,true);assert.equal(b.headerOk,true);assert.equal(b.body.model,f.remote.modelB);assert.equal(b.body.max_completion_tokens,32);assert.equal(b.body.max_tokens,undefined);
    const view=await f.session.read(),visible=view.entries.filter(e=>e.toolResult?.name===toolName&&e.toolResult.callId===callId);assert.equal(visible.length,1);assert.equal(visible[0].toolResult.isError,false);
    const observed=JSON.parse(visible[0].toolResult.text);assert.equal(observed.nonce,f.nonce);assert.equal(observed.originalToolCallId,callId);assert.equal(observed.synchronous,true);
    assert.ok(observed.eventTypes.includes('text_delta'));assert.ok(observed.eventTypes.includes('done'));assert.equal(observed.deltas,f.remote.innerText);
    assert.equal(observed.message.role,'assistant');assert.equal(observed.message.provider,providerB);assert.equal(observed.message.model,f.remote.modelB);assert.equal(observed.message.responseId,b.id);assert.equal(observed.message.stopReason,'stop');assert.equal(observed.message.text,f.remote.innerText);
    assert.equal(observed.message.usage.input,117);assert.equal(observed.message.usage.output,13);assert.equal(observed.message.usage.totalTokens,130);
    assert.equal(f.remote.of('A')[1].body.messages.filter(m=>m.role==='tool'&&m.tool_call_id===callId&&m.content===JSON.stringify(observed)).length,1,'Actual B result reaches the next original A HTTP');
    const facts=view.entries.filter(e=>e.kind==='dcode.extension-model-result'&&e.responseId===b.id);assert.equal(facts.length,1);assert.equal(facts[0].provider,providerB);assert.equal(facts[0].model,f.remote.modelB);assert.deepEqual(facts[0].usage,{input:117,output:13,cacheRead:0,cacheWrite:0});
    await f.session.close();const raw=await records(f);assert.equal(raw.formal.length,1);assert.equal(raw.formal[0].isError,false);assert.deepEqual(raw.formal[0].usage,observed.message.usage);
    assert.equal(total(raw.usage.tools),130);assert.deepEqual(raw.usage.tools[toolName],observed.message.usage);assert.equal(total(raw.usage.models),6);
    assert.equal(raw.child.state.status,'terminal');assert.equal(raw.child.state.outcome.status,'completed');assert.ok(JSON.stringify(raw.child.state.outcome.result).includes(b.id));
    const resultEntries=raw.entries.filter(e=>(e.model??[]).some(m=>m.role==='toolResult'&&m.toolName===toolName&&m.toolCallId===callId));assert.equal(resultEntries.length,1);assert.equal(resultEntries[0].byTaskId,raw.owner.id);
    const innerFacts=raw.entries.filter(e=>e.kind==='dcode.extension-model-result'&&e.data?.message?.responseId===b.id);assert.equal(innerFacts.length,1);assert.equal(innerFacts[0].byTaskId,raw.child.id);assert.ok(innerFacts[0].id<resultEntries[0].id);
    assert.equal(raw.messages.filter(m=>m.role==='toolResult'&&(m.usage?.totalTokens??0)>0).length,1);assert.equal(raw.entries.filter(e=>e.kind==='pi.user').length,1);
    assert.deepEqual(raw.messages.filter(m=>m.role==='assistant').map(m=>m.responseId).sort(),f.remote.of('A').map(r=>r.id).sort(),'Inner B is not a fabricated conversation assistant');
    await assertReadOnlyDone(f,accepted,raw);
  }finally{await f.dispose();}
});

await test('普通factory virtual direct：B完整准入拒绝只拦inner，A原工具错误继续、零B HTTP/零inner费用',{timeout:30000},async()=>{
  const f=await fixture({rejectB:true});try{
    const accepted=await acceptedAndStarted(f);await done(f);assertRoute(f,await trace(f));assertAdmission(f,1);
    assert.equal(f.remote.of('A').length,2);assert.equal(f.remote.of('B').length,0);assert.equal(f.remote.of('forged').length,0);
    const view=await f.session.read(),visible=view.entries.filter(e=>e.toolResult?.name===toolName&&e.toolResult.callId===callId);assert.equal(visible.length,1);assert.equal(visible[0].toolResult.isError,true);assert.ok(visible[0].toolResult.text.length>0);assert.ok(!visible[0].toolResult.text.includes(f.remote.innerText));
    assert.ok(f.remote.of('A')[1].body.messages.some(m=>m.role==='tool'&&m.tool_call_id===callId&&m.content.length>0),'The actual inner error reaches original A continuation');
    assert.equal(view.entries.filter(e=>e.kind==='dcode.extension-model-result'&&e.responseId).length,0);
    await f.session.close();const raw=await records(f);assertNoInnerSuccess(raw);assert.equal(raw.formal.length,1);assert.equal(raw.formal[0].isError,true);assert.equal(total(raw.usage.models),6);
    await assertReadOnlyDone(f,accepted,raw);
  }finally{await f.dispose();}
});

for(const stop of ['pause','close'])await test(`普通factory virtual direct/route等待忽略signal后${stop}：闸未放行已有限停止、RO/原operation继续均不重放`,{timeout:30000},async()=>{
  const f=await fixture({holdRoute:true});try{
    const accepted=await acceptedAndStarted(f);await until(()=>f.remote.gates.length===1);
    let value;await until(async()=>{value=await trace(f);return value?.steps.some(s=>s.phase==='factory-returned');});assertRoute(f,value,{returned:false});
    const running=await f.session.read();assert.equal(running.phase,'running');assert.equal(running.entries.filter(e=>e.toolResult?.name===toolName).length,0);
    assert.equal(f.remote.of('A').length,1);assert.equal(f.remote.of('B').length,0);assert.equal(f.remote.gates[0].released,false);
    // Await public stop before releasing the actual remote wait. Test's unchanged 30s bound rejects a join on the ignoring callback.
    if(stop==='pause')assert.equal((await f.session.pause()).phase,'paused');else await f.session.close();
    assert.equal(f.remote.gates[0].released,false,'A finite stop cannot depend on releasing the ignored callback promise');
    if(stop==='pause')await f.session.close();
    await until(()=>f.remote.gates[0].closed); // 旧Worker的实际fetch连接已关闭，不以task桶名猜仍在执行。
    const interrupted=await records(f);assertNoInnerSuccess(interrupted,{stopped:true});assert.equal(total(interrupted.usage.models),3);
    const released=f.remote.releaseGate();assert.equal(released.releaseAttempted,true);
    // Worker was closed: this is a real server release attempt, not proof that the callback returned or posted a late RPC reply.
    assert.equal(f.remote.of('B').length,0);const routeCount=value.steps.filter(s=>s.phase==='route-entered').length;
    f.session=await f.backend.open({...f.opening,initialize:false});assert.equal((await f.session.read()).phase,'paused');
    assert.equal((await f.session.submit(f.input)).submissionId,accepted.submissionId);await f.session.lookupReceipt(f.input);await f.session.read();
    assert.equal(f.remote.of('A').length,1);assert.equal(f.remote.of('B').length,0);assert.equal(f.remote.gates.length,1);
    await f.session.resume((await f.session.read()).control);await done(f);
    assert.equal(f.remote.of('A').length,2);assert.equal(f.remote.of('B').length,0);assert.equal(f.remote.of('forged').length,0);assert.equal(f.remote.gates.length,1,'Explicit resume cannot execute the original route again');assertAdmission(f,0);
    const finalTrace=await trace(f);assert.equal(finalTrace.steps.filter(s=>s.phase==='tool-entered').length,1);assert.equal(finalTrace.steps.filter(s=>s.phase==='route-entered').length,routeCount);
    assert.equal(finalTrace.steps.filter(s=>s.phase==='tool-returning').length,0);
    // A recorded callback return, if one actually occurred during shutdown, must be aborted; absence is retained as an unproved late-return branch.
    for(const step of finalTrace.steps.filter(s=>s.phase==='route-returning'))assert.equal(step.signalAborted,true);
    const visible=(await f.session.read()).entries.filter(e=>e.toolResult?.name===toolName&&e.toolResult.callId===callId);assert.equal(visible.length,1);assert.equal(visible[0].toolResult.isError,true);assert.ok(visible[0].toolResult.text.length>0);
    await f.session.close();const after=await records(f);assertNoInnerSuccess(after);assert.equal(total(after.usage.models),6);assert.equal(after.formal.length,1);assert.equal(after.formal[0].isError,true);
    assert.equal(after.child.id,interrupted.child.id);assert.equal(after.owner.id,interrupted.owner.id);assert.deepEqual(after.identity,interrupted.identity);assert.equal(after.entries.filter(e=>e.kind==='pi.user').length,1);
  }finally{await f.dispose();}
});


await test('pure route拒绝：真实pi.setActiveTools与registerTool不能改正式loadout或留到后续scope发布',{timeout:30000},async()=>{
  const f=await fixture({mutationProbe:true});try{
    await acceptedAndStarted(f);await done(f);const observed=await trace(f);assertRoute(f,observed);assertAdmission(f,1);
    const denied=observed.steps.find(step=>step.phase==='pure-mutations');assert.ok(denied);
    assert.equal(denied.setRejected,true,'真实route中的pi.setActiveTools必须在写active之前拒绝');
    assert.equal(denied.registerRejected,true,'真实route中的pi.registerTool必须在写SDK工具map之前拒绝');
    assert.equal(denied.providerRejected,true,'真实route中的pi.registerProvider必须在发送登记RPC或写当前claim之前同步拒绝');
    const loadout=observed.steps.find(step=>step.phase==='tool-loadout-after');assert.ok(loadout);assert.deepEqual(loadout.activeAfter,loadout.activeBefore);
    assert.equal(loadout.allNames.includes('route_pure_injected'),false,'后续正常scope也不能发布先前pure的本地注册');
    assert.equal(f.remote.of('B').length,1);assert.equal(f.remote.of('A').length,2);assert.equal(f.remote.of('forged').length,0);
    await f.session.close();const raw=await records(f);assert.equal(raw.formal.length,1);assert.equal(raw.formal[0].isError,false);assert.equal(total(raw.usage.tools),130);
  }finally{await f.dispose();}
});



// Public reader on an immutable owned byte copy only; never open the original live JSONL twice.
async function liveOwnerSnapshot(f){
  const original=join(f.stateDir,'runtime',f.target.sessionId),copy=join(f.root,'live-owner-copy-'+randomUUID());let files,storage;
  await until(async()=>{
    try{
      const names=(await readdir(original)).filter(n=>/^(main|doc-\d+|task-\d+)\.jsonl$/.test(n)).sort();
      const before=await Promise.all(names.map(n=>readFile(join(original,n))));
      const afterNames=(await readdir(original)).filter(n=>/^(main|doc-\d+|task-\d+)\.jsonl$/.test(n)).sort();if(JSON.stringify(names)!==JSON.stringify(afterNames))return false;
      const after=await Promise.all(names.map(n=>readFile(join(original,n))));if(!before.every((v,i)=>v.equals(after[i])))return false;
      files=names.map((name,i)=>({name,bytes:before[i]}));return true;
    }catch(error){if(error.code==='ENOENT')return false;throw error;}
  });
  try{
    await mkdir(copy);await Promise.all(files.map(({name,bytes})=>writeFile(join(copy,name),bytes)));storage=await openNodeJsonlStorage(copy,context);
    const scan=async method=>{const all=[];let cursor;do{const page=await storage[method]({conversationId:ROOT_CONVERSATION_ID},200,cursor,context);all.push(...page.items);cursor=page.next;}while(cursor!==undefined);return all;};
    return {tasks:await scan('scanTasks'),entries:await scan('scanEntries')};
  }finally{await storage?.close(context);await rm(copy,{recursive:true,force:true});}
}
function assertLiveOriginalOwner(raw){
  const owners=raw.tasks.filter(t=>t.kind===ToolTask.definition.name&&t.input.callId===callId);assert.equal(owners.length,1);const owner=owners[0];
  assert.equal(owner.state.status,'running');assert.equal(owner.state.checkpoint.phase,'execute');
  const children=raw.tasks.filter(t=>t.owner===owner.id);assert.equal(children.length,1);const child=children[0];
  assert.equal(child.kind,'dcode.extension-model');assert.equal(child.conversationId,owner.conversationId);assert.equal(child.state.status,'terminal');
  if(child.state.outcome.status==='completed'){
    const result=child.state.outcome.result?.message;assert.ok(result);assert.ok(['error','aborted'].includes(result.stopReason));
    if(result.usage)assert.equal(result.usage.totalTokens,0,'No actual B HTTP means no invented inner charge');
  }
  assert.equal(raw.entries.filter(e=>(e.model??[]).some(m=>m.role==='toolResult'&&m.toolName===toolName&&m.toolCallId===callId)).length,0);
  return {ownerId:owner.id,childId:child.id};
}

await test('virtual direct仅模型取消：原ToolTask仍活、忽略signal的route真实晚返且B HTTP0、RO不重放',{timeout:30000},async()=>{
  const f=await fixture({source:liveOwnerAbortExtension});try{
    const accepted=await acceptedAndStarted(f);await until(()=>f.remote.gates.length===1&&f.remote.controlGates.cancel.length===1);
    let before;await until(async()=>{before=await trace(f);return before?.steps.some(s=>s.phase==='factory-returned');});assertRoute(f,before,{returned:false});
    assert.equal(f.remote.gates[0].closed,false);assert.equal(f.remote.gates[0].released,false);assert.equal(f.remote.of('A').length,1);assert.equal(f.remote.of('B').length,0);
    const cancel=f.remote.releaseControl('cancel');assert.equal(cancel.delivered,true);
    await until(()=>f.remote.controlGates.owner.length===1);
    const cancelled=await trace(f);assertRoute(f,cancelled,{returned:false});
    assert.equal(cancelled.steps.filter(s=>s.phase==='model-aborting').length,1);assert.equal(cancelled.steps.find(s=>s.phase==='model-aborting').modelSignalAborted,false);
    assert.equal(cancelled.steps.filter(s=>s.phase==='model-aborted').length,1);assert.equal(cancelled.steps.find(s=>s.phase==='model-aborted').modelSignalAborted,true);
    const resultSteps=cancelled.steps.filter(s=>s.phase==='result-settled');assert.equal(resultSteps.length,1);const result=resultSteps[0];
    assert.equal(result.ownerSignalAborted,false);assert.equal(result.modelSignalAborted,true);assert.equal(result.resultReadbackConsistent,true);
    assert.equal(result.message.role,'assistant');assert.ok(['error','aborted'].includes(result.message.stopReason));assert.notEqual(result.message.text,f.remote.innerText);
    if(result.message.usage)assert.equal(result.message.usage.totalTokens,0);
    const terminal=cancelled.steps.filter(s=>s.phase==='terminal-event');assert.equal(terminal.length,1);assert.equal(terminal[0].type,'error');assert.deepEqual(terminal[0].message,result.message);
    assert.equal(result.eventTypes.filter(type=>type==='error').length,1);assert.equal(result.eventTypes.filter(type=>type==='done').length,0);
    assert.equal(cancelled.steps.find(s=>s.phase==='tool-entered').signalsDistinct,true);assert.ok(cancelled.steps.every(s=>s.ownerSignalAborted===false));
    const heldOwner=f.remote.controlGates.owner[0];assert.equal(heldOwner.accepted,true);assert.equal(heldOwner.released,false);assert.equal(heldOwner.closed,false);
    assert.equal(f.remote.gates[0].released,false,'Model cancellation must finish locally while the ignoring callback still waits');
    assert.equal(f.remote.gates[0].closed,false,'The ignored route HTTP must actually remain live; a dead Worker cannot prove this case');
    const ids=assertLiveOriginalOwner(await liveOwnerSnapshot(f));assert.equal((await f.session.read()).phase,'running');
    assert.equal((await f.session.lookupReceipt(f.input)).submissionId,accepted.submissionId);assert.equal(f.remote.of('A').length,1);assert.equal(f.remote.of('B').length,0);

    // The original worker is still executing the held owner: now release and demand a real aborted callback return trace.
    const route=f.remote.releaseGate();assert.equal(route.delivered,true);let returned;
    await until(async()=>{returned=await trace(f);return returned?.steps.some(s=>s.phase==='route-returning');});assertRoute(f,returned);
    const late=returned.steps.filter(s=>s.phase==='route-returning');assert.equal(late.length,1);assert.equal(late[0].signalAborted,true);assert.equal(late[0].ownerSignalAborted,false);
    assert.equal(heldOwner.released,false);assert.equal(heldOwner.closed,false);assert.equal(returned.steps.filter(s=>s.phase==='tool-returning').length,0);
    assert.deepEqual(assertLiveOriginalOwner(await liveOwnerSnapshot(f)),ids,'Actual callback late return cannot settle/replace the original live owner or child');
    assert.equal(f.remote.of('A').length,1);assert.equal(f.remote.of('B').length,0);assert.equal(f.remote.of('forged').length,0);
    assert.equal((await f.session.read()).entries.filter(e=>e.toolResult?.callId===callId).length,0);

    f.remote.releaseControl('owner');await done(f);assertAdmission(f,0);assert.equal(f.remote.of('A').length,2);assert.equal(f.remote.of('B').length,0);assert.equal(f.remote.gates.length,1);
    const view=await f.session.read(),visible=view.entries.filter(e=>e.toolResult?.name===toolName&&e.toolResult.callId===callId);assert.equal(visible.length,1);assert.equal(visible[0].toolResult.isError,false,'The original tool handles model-only cancellation and finishes normally');
    const observed=JSON.parse(visible[0].toolResult.text);assert.equal(observed.probe,'virtual-direct-live-owner');assert.equal(observed.nonce,f.nonce);assert.equal(observed.originalToolCallId,callId);
    assert.equal(observed.synchronous,true);assert.equal(observed.ownerSignalAborted,false);assert.equal(observed.modelSignalAborted,true);assert.equal(observed.resultReadbackConsistent,true);assert.deepEqual(observed.message,result.message);
    assert.equal(f.remote.of('A')[1].body.messages.filter(m=>m.role==='tool'&&m.tool_call_id===callId&&m.content===JSON.stringify(observed)).length,1,'The exact cancellation handled by this original tool reaches its next actual A HTTP');
    const finished=await trace(f);assert.equal(finished.steps.filter(s=>s.phase==='tool-returning').length,1);assert.equal(finished.steps.filter(s=>s.phase==='route-entered').length,1);assert.equal(finished.steps.filter(s=>s.phase==='route-returning').length,1);assert.ok(finished.steps.every(s=>s.ownerSignalAborted===false));
    await f.session.close();const raw=await records(f);assert.equal(raw.owner.id,ids.ownerId);assert.equal(raw.child.id,ids.childId);
    assert.equal(raw.owner.state.status,'terminal');assert.equal(raw.owner.state.outcome.status,'completed');assert.equal(raw.formal.length,1);assert.equal(raw.formal[0].isError,false);
    assertNoInnerSuccess(raw);assert.equal(total(raw.usage.models),6,'Only the two actual A responses supplied 2+1 each');assert.equal(raw.entries.filter(e=>e.kind==='pi.user').length,1);
    const counts={requests:f.remote.requests.length,route:f.remote.gates.length,cancel:f.remote.controlGates.cancel.length,owner:f.remote.controlGates.owner.length};
    const restored=await assertReadOnlyDone(f,accepted,raw);assert.equal(restored.child.id,ids.childId);
    assert.deepEqual({requests:f.remote.requests.length,route:f.remote.gates.length,cancel:f.remote.controlGates.cancel.length,owner:f.remote.controlGates.owner.length},counts,'RO/lookup original operation cannot reconnect either gate or replay any request');
    assert.deepEqual(await trace(f),finished,'RO does not reenter the completed tool or router');
  }finally{await f.dispose();}
});
