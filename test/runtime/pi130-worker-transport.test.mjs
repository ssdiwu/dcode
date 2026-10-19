// 普通资源线程的1.3 transport兼容；只添加有限测试探针，不替换生产包装或SDK。
// This is a real Worker/SDK/loopback transport test, not a model request or product acceptance.
// Probe code adds only finite test operations. It never replaces the production wrapper/SDK methods.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { findPackageJSON } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';

const repo = await realpath(resolve(process.env.DCODE_TEST_REPO ?? process.cwd()));
const { extensionWorkerSource } = await import(pathToFileURL(join(repo, 'src/adapters/pi/extension-worker.ts')).href);
const OBSERVATION_MS = 4_000; // A failing observation deadline, never a resource-completion substitute.

async function publicEntry(name, key = '.', star) {
  const packageFile = findPackageJSON(name, pathToFileURL(join(repo, 'package.json')).href);
  assert.equal(typeof packageFile, 'string', 'Installed public package manifest must resolve');
  const manifest = JSON.parse(await readFile(packageFile, 'utf8'));
  assert.equal(manifest.version, '1.3.0', 'This asset is specifically for the fixed 1.3.0 SDK');
  const entry = manifest.exports?.[key]?.import;
  assert.equal(typeof entry, 'string', 'Use a declared public import export, never a private implementation path');
  return pathToFileURL(resolve(packageFile, '..', star === undefined ? entry : entry.replace('*', star))).href;
}
const sdk = await publicEntry('@earendil-works/pi-coding-agent');
const streamFactory = await publicEntry('@earendil-works/pi-ai', './utils/*', 'event-stream');

function deadline(promise, label, ms = OBSERVATION_MS) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + ': observation deadline; operation is NOT marked complete')), ms);
  })]).finally(() => clearTimeout(timer));
}

// This stays in the real resource Worker and uses the exact same public constructor the
// production initialize() imported/patched. No method prototype is replaced by this probe.
const probePrelude = String.raw`
let __transportTestPort;
const __transportTest = { transport:undefined, client:undefined, tokenCalls:0, held:false,
  released:false, holdNext:false, release:undefined, flight:undefined, outcome:undefined };
async function __transportTestOperation(value) {
  const own=__transportTest;
  if (!value || typeof value.op!=='string') throw new Error('Invalid finite transport probe');
  if (value.op==='open') {
    if (!__transportTestPort || own.transport || typeof value.origin!=='string'
      || !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(value.origin)) throw new Error('Invalid loopback probe preparation');
    own.transport=new __transportTestPort.StreamableHttpTransport({url:value.origin,openGetStream:false,
      authProvider:{async token(){
        own.tokenCalls++;
        if(own.holdNext){
          own.holdNext=false;own.held=true;
          await new Promise(resolve=>{own.release=resolve;
            parentPort.postMessage({type:'transport-test-observation',phase:'token-blocked',tokenCalls:own.tokenCalls});});
        }
        return workerData.transportTestKey;
      }}});
    own.client=new __transportTestPort.McpClient({name:'dcode-real-transport-probe',version:'test',requestTimeoutMs:2000});
    await own.client.connect(own.transport);
    return {connected:own.client.connectionState==='connected',registered:transports.has(own.transport),
      sameConstructor:own.transport.constructor===__transportTestPort.StreamableHttpTransport,
      sessionId:own.transport.sessionId,tokenCalls:own.tokenCalls};
  }
  if(!own.transport)throw new Error('Transport probe was not initialized');
  if(value.op==='pre-aborted-send'){
    const controller=new AbortController();controller.abort();
    let rejected=false,errorName;
    try{await own.transport.send({jsonrpc:'2.0',id:991,method:'tools/list',params:{nonce:value.nonce}},{signal:controller.signal});}
    catch(error){rejected=true;errorName=error?.name;}
    return {rejected,errorName,tokenCalls:own.tokenCalls};
  }
  if(value.op==='hold-cancel'){
    if(own.flight)throw new Error('Only one held cancellation is allowed');
    own.holdNext=true;
    own.flight=own.transport.send({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:321,reason:'test-owned '+value.nonce}});
    own.flight.then(()=>{own.outcome={settled:true,rejected:false};},error=>{own.outcome={settled:true,rejected:true,errorName:error?.name};});
    return {started:true};
  }
  if(value.op==='status')return {held:own.held,released:own.released,settled:!!own.outcome,tokenCalls:own.tokenCalls};
  if(value.op==='close-transport'){
    await own.transport.close();
    return {closed:true,released:own.released,settled:!!own.outcome,tokenCalls:own.tokenCalls};
  }
  if(value.op==='release-auth'){
    if(!own.held||!own.release||own.released)throw new Error('Token gate is not waiting');
    own.released=true;own.release();return {released:true};
  }
  if(value.op==='await-flight'){
    if(!own.flight)throw new Error('Cancellation was never started');
    await own.flight.catch(()=>undefined);return own.outcome;
  }
  throw new Error('Unknown finite transport probe');
}
`;

function instrument(source) {
  const importLine = source.match(/^  const transportPort=await import\([^\n]+\);$/m)?.[0];
  assert.ok(importLine, 'Preparation failure: locate the original public MCP import without replacing its wrapper');
  const requestLine = 'async function request(message) {';
  assert.equal(source.split(requestLine).length, 2, 'Preparation failure: finite probe must enter the one real request dispatcher');
  return probePrelude + source
    .replace(importLine, importLine + '\n  __transportTestPort=transportPort;')
    .replace(requestLine, requestLine + "\n  if(message.method==='transport-test')return __transportTestOperation(message.value);");
}

async function loopback(key) {
  const events = [], changed = new EventEmitter(), sessionId = 'transport-session-' + randomUUID();
  const record = row => { events.push({sequence:events.length+1,...row});changed.emit('change'); };
  const server = createServer((request, response) => {
    void (async () => {
      const method = request.method;
      const authValid = request.headers.authorization === 'Bearer ' + key;
      const sessionValid = request.headers['mcp-session-id'] === sessionId;
      if(method==='DELETE'){
        record({kind:'delete',authValid,sessionValid});response.writeHead(204);response.end();return;
      }
      if(method!=='POST'){record({kind:'unexpected-method',method});response.writeHead(405);response.end();return;}
      let raw='';for await(const chunk of request){raw+=chunk;if(raw.length>256*1024)throw new Error('Test request too large');}
      const body=JSON.parse(raw);
      record({kind:'post',method:body.method,id:body.id,nonce:body.params?.nonce,authValid,
        sessionValid:body.method==='initialize'||sessionValid});
      if(body.method==='initialize'){
        response.writeHead(200,{'content-type':'application/json','Mcp-Session-Id':sessionId});
        response.end(JSON.stringify({jsonrpc:'2.0',id:body.id,result:{protocolVersion:body.params.protocolVersion,
          capabilities:{tools:{}},serverInfo:{name:'isolated-transport',version:'test'}}}));return;
      }
      if(body.id===undefined){response.writeHead(202);response.end();return;}
      response.writeHead(200,{'content-type':'application/json'});
      response.end(JSON.stringify({jsonrpc:'2.0',id:body.id,result:{tools:[]}}));
    })().catch(error=>{record({kind:'server-error',name:error.name});response.writeHead(500);response.end();});
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const origin='http://127.0.0.1:'+server.address().port+'/';
  const wait = async predicate => {
    if(predicate(events))return;
    await deadline(new Promise(resolve=>{
      const listener=()=>{if(predicate(events)){changed.off('change',listener);resolve();}};
      changed.on('change',listener);
    }),'real loopback observation');
  };
  return {origin,sessionId,events,wait,
    async close(){server.closeAllConnections();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}};
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(),'dcode-pi130-transport-')));
  const project=join(root,'project'),agent=join(root,'agent');
  await mkdir(join(project,'.pi'),{recursive:true});await mkdir(agent);
  await writeFile(join(project,'.pi/settings.json'),JSON.stringify({extensions:[],skills:[],prompts:[],packages:[]}));
  await writeFile(join(project,'.pi/mcp.json'),'{}');
  const key='synthetic-only-'+randomUUID(),remote=await loopback(key);
  const sessionId=randomUUID(),resourceEpoch=randomUUID(),pending=new Map(),observations=[];
  let next=0,exited=false,exitCode,forcedCleanup=false;
  const worker=new Worker(instrument(extensionWorkerSource),{eval:true,execArgv:[],stdout:true,stderr:true,
    env:{PATH:process.env.PATH,LANG:'en_US.UTF-8',PI_OFFLINE:'1',PI_CODING_AGENT_DIR:agent},
    workerData:{cwd:project,agentDir:agent,sessionId,resourceEpoch,sessionStartReason:'startup',sdk,streamFactory,
      builtins:[],transportTestKey:key}});
  worker.stdout.resume();worker.stderr.resume();
  let resolveExit;
  const exit=new Promise(resolve=>{resolveExit=resolve;});
  const fail=error=>{for(const item of pending.values())item.reject(error);pending.clear();};
  worker.on('error',fail);
  worker.on('exit',code=>{exited=true;exitCode=code;resolveExit(code);fail(new Error('Resource Worker exited '+code));});
  worker.on('message',message=>{
    if(message.type==='transport-test-observation'){observations.push(message);return;}
    if(message.type==='host'){
      // Empty extensions must never create a formal host action just to prepare this transport.
      observations.push({phase:'unexpected-host-operation',method:message.method});
      worker.postMessage({type:'reply',id:message.id,ok:false});return;
    }
    if(message.type!=='result')return;
    const item=pending.get(message.id);if(!item)return;pending.delete(message.id);
    if(message.ok)item.resolve(message.value);else item.reject(new Error('Worker rejected '+item.method+': '+message.code));
  });
  const request=(method,value={})=>{
    const id=++next;
    const promise=new Promise((resolve,reject)=>{
      pending.set(id,{resolve,reject,method});
      const state={sessionId,entries:[],messages:[],systemPrompt:'',thinkingLevel:'off',
        modelCatalog:{all:[],available:[],byType:{chat:[],image:[],classifier:[]},providerNames:[],registeredProviderIds:[]},
        stateFrame:{sessionId,resourceEpoch,threadId:worker.threadId,requestId:id}};
      worker.postMessage({type:'request',id,method,value,state,scope:(method==='close'?'shutdown/':'event/')+'transport-test/'+id});
    });
    promise.catch(()=>{});return promise;
  };
  const probe=(op,extra={})=>request('transport-test',{op,...extra});
  const naturalClose=async()=>{
    await deadline(request('close',{reason:'quit'}),'production close result while auth gate remains as arranged');
    const code=await deadline(exit,'natural resource Worker exit');
    assert.equal(forcedCleanup,false,'Forced cleanup must never count as natural product exit');
    assert.equal(code,0,'Real resource Worker must naturally exit, not merely post a close result');
    assert.equal(worker.threadId,-1,'The real Worker thread must be gone');
  };
  t.after(async()=>{
    // Record failure evidence before any cleanup. In particular never release the auth gate
    // first and let the old infinite join look like a successful natural shutdown.
    t.diagnostic(JSON.stringify({productionSourceSha256:createHash('sha256').update(extensionWorkerSource).digest('hex'),
      observations,wire:remote.events,naturalExitBeforeCleanup:exited,exitCode}));
    try{if(!exited){forcedCleanup=true;await worker.terminate();await exit;}}
    finally{await remote.close();await rm(root,{recursive:true,force:true});}
  });
  await deadline(request('init'),'empty resource Worker initialization (preparation, not target behavior)');
  assert.ok(!observations.some(row=>row.phase==='unexpected-host-operation'),'Preparation must not require a fake Durable host');
  const opened=await deadline(probe('open',{origin:remote.origin}),'real MCP initialize/initialized');
  assert.deepEqual({connected:opened.connected,registered:opened.registered,sameConstructor:opened.sameConstructor},
    {connected:true,registered:true,sameConstructor:true},'The production wrapper must own the actual public transport');
  assert.equal(opened.sessionId,remote.sessionId);
  assert.deepEqual(remote.events.filter(e=>e.kind==='post').map(e=>e.method),['initialize','notifications/initialized']);
  assert.ok(remote.events.every(e=>e.authValid&&e.sessionValid),'Synthetic auth/session identity must be valid without logging headers');
  const holdCancel=async()=>{
    await deadline(probe('hold-cancel',{nonce:randomUUID()}),'start real cancelled-notification send');
    const status=await deadline(probe('status'),'observe held token gate');
    assert.equal(status.held,true);assert.equal(status.released,false);assert.equal(status.settled,false);
    assert.ok(observations.some(row=>row.phase==='token-blocked'),'The gate must really intercept the public auth callback');
  };
  return {probe,request,remote,holdCancel,naturalClose};
}

test('Pi1.3 MCP原包装透明保留send options：已取消signal不得产生真实POST', {timeout:20_000}, async t=>{
  const f=await fixture(t),nonce=randomUUID();
  const result=await deadline(f.probe('pre-aborted-send',{nonce}),'pre-aborted public SDK send');
  const posts=f.remote.events.filter(row=>row.kind==='post'&&row.nonce===nonce);
  assert.deepEqual({actualLatePosts:posts.length,rejected:result.rejected},{actualLatePosts:0,rejected:true},
    'Dropping send(message,{signal}) would dispatch this real tools/list POST');
  await f.naturalClose();
});

test('Pi1.3 MCP原wrapped close不反锁既有token等待：DELETE/关闭先完成，真放门后仍零迟发POST', {timeout:20_000}, async t=>{
  const f=await fixture(t);await f.holdCancel();
  const closing=f.probe('close-transport');
  await f.remote.wait(rows=>rows.some(row=>row.kind==='delete'));
  const closed=await deadline(closing,'wrapped transport close must finish BEFORE token release');
  assert.deepEqual({closed:closed.closed,released:closed.released,settled:closed.settled},
    {closed:true,released:false,settled:false},'Do not implicitly release the auth gate to make close pass');
  assert.equal(f.remote.events.filter(row=>row.kind==='delete').length,1);
  assert.ok(f.remote.events.filter(row=>row.kind==='delete').every(row=>row.authValid&&row.sessionValid));
  await deadline(f.probe('release-auth'),'explicitly release the still-live token callback');
  const outcome=await deadline(f.probe('await-flight'),'real send settles after explicit gate release');
  assert.equal(outcome.rejected,true);
  assert.equal(f.remote.events.filter(row=>row.kind==='post'&&row.method==='notifications/cancelled').length,0,
    'After a real gate release, the closed transport must not dispatch the delayed cancellation POST');
  await f.naturalClose();
});

test('Pi1.3 MCP生产资源关闭独立证明真实Worker退出：不靠释放token或强制cleanup冒充完成', {timeout:20_000}, async t=>{
  const f=await fixture(t);await f.holdCancel();
  const closing=f.naturalClose();
  await f.remote.wait(rows=>rows.some(row=>row.kind==='delete'));
  await closing;
  assert.equal(f.remote.events.filter(row=>row.kind==='delete').length,1);
  assert.equal(f.remote.events.filter(row=>row.kind==='post'&&row.method==='notifications/cancelled').length,0);
  // This case deliberately never releases a token in a dead Worker. The preceding case is
  // the distinct proof that a live callback was actually released and did not dispatch late.
});
