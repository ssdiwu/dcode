// 真实Worker及原ExtensionRunner的协议组件验证；受控帧不是业务请求／Durable owner证明。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { extensionWorkerSource } from '../../src/adapters/pi/extension-worker.ts';
import { until } from './fixtures.ts';

const model = (id, window) => ({ type:'chat', id, name:id, api:'openai-completions', provider:'frame-provider',
  baseUrl:'https://invalid.invalid', input:['text'], contextWindow:window, maxTokens:256, reasoning:false,
  cost:{input:0,output:0,cacheRead:0,cacheWrite:0} });
const A=model('frame-A',8192), B=model('frame-B',4096), C=model('frame-unknown',0);
const known=(tokens,m=A)=>({tokens,contextWindow:m.contextWindow,percent:tokens/m.contextWindow*100});
async function fixture(t) {
  const root=await realpath(await mkdtemp(join(tmpdir(),'dcode-context-frame-'))),project=join(root,'project'),agent=join(root,'agent');
  await mkdir(join(project,'.pi/extensions'),{recursive:true});await mkdir(agent);
  await writeFile(join(project,'.pi/mcp.json'),'{}');
  await writeFile(join(project,'.pi/settings.json'),JSON.stringify({extensions:['./extensions/frame.mjs']}));
  const sessionId=randomUUID(),resourceEpoch=randomUUID();
  await writeFile(join(project,'.pi/extensions/frame.mjs'),`import {appendFile,access} from 'node:fs/promises';
import {join} from 'node:path';import {setTimeout as delay} from 'node:timers/promises';
export default function(pi){pi.on('before_provider_request',async(event,ctx)=>{
 if(event.payload.mutateModel){const model=ctx.model;if(model){model.id='mutated-client-model';model.contextWindow=-987;}}
 const observe=()=>({model:ctx.model?.id,window:ctx.model?.contextWindow,usage:ctx.getContextUsage()});
 await appendFile(join(ctx.cwd,'trace.jsonl'),JSON.stringify({probe:event.payload.probe,phase:'before',...observe()})+'\\n');
 if(event.payload.wait){for(;;){try{await access(join(ctx.cwd,'release'));break;}catch(error){if(error.code!=='ENOENT')throw error;await delay(5);}}}
 await appendFile(join(ctx.cwd,'trace.jsonl'),JSON.stringify({probe:event.payload.probe,phase:'after',...observe()})+'\\n');
 return event.payload;
});
pi.on('context',async(event,ctx)=>{
 await appendFile(join(ctx.cwd,'trace.jsonl'),JSON.stringify({probe:'context',phase:'after',messages:event.messages,model:ctx.model?.id,window:ctx.model?.contextWindow,usage:ctx.getContextUsage()})+'\\n');
 return {messages:event.messages};
});}`);
  const worker=new Worker(extensionWorkerSource,{eval:true,execArgv:[],stdout:true,stderr:true,
    env:{PATH:process.env.PATH,LANG:'en_US.UTF-8',PI_OFFLINE:'1',PI_CODING_AGENT_DIR:agent},
    workerData:{cwd:project,agentDir:agent,sessionId,resourceEpoch,sessionStartReason:'startup',
      sdk:import.meta.resolve('@earendil-works/pi-coding-agent'),streamFactory:import.meta.resolve('@earendil-works/pi-ai/utils/event-stream'),builtins:[]}});
  worker.stdout.resume();worker.stderr.resume();
  const pending=new Map();let exited=false;
  worker.on('message',message=>{if(message.type!=='result')return;const own=pending.get(message.id);if(!own)return;pending.delete(message.id);
    if(message.ok)own.resolve(message.value);else own.reject(new Error(message.code+' at '+own.method+' #'+message.id));});
  const fail=error=>{for(const own of pending.values())own.reject(error);pending.clear();};
  worker.on('error',fail);worker.on('exit',code=>{exited=true;fail(new Error('Worker exited '+code));});
  const send=(id,method,m,usage,value={},override={},messages=[])=>new Promise((resolve,reject)=>{
    pending.set(id,{resolve,reject,method});
    const state={sessionId,entries:[],messages,model:m,thinkingLevel:'off',systemPrompt:'',
      modelCatalog:{all:[A,B,C],available:[A,B,C],byType:{chat:[A,B,C],image:[],classifier:[]},providerNames:[],registeredProviderIds:[]},
      stateFrame:{sessionId,resourceEpoch,threadId:worker.threadId,requestId:id,...override},...(usage===undefined?{}:{contextUsage:usage})};
    worker.postMessage({type:'request',id,method,value,state,scope:'event/component/'+id});
  });
  const trace=async()=>{try{return (await readFile(join(project,'trace.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}
    catch(error){if(error.code==='ENOENT')return [];throw error;}};
  t.after(async()=>{try{if(!exited){const exit=once(worker,'exit');const id=1000;
      await new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});worker.postMessage({type:'request',id,method:'close',value:{reason:'quit'},scope:'shutdown/component'});});await exit;}}
    finally{if(!exited)await worker.terminate();await rm(root,{recursive:true,force:true});}});
  await send(1,'init',A,known(2));
  return {send,trace,project,worker};
}

test('上下文帧/同tail改选：await后新窗口、迟到旧帧不回滚且原operation仍返回', {timeout:20000}, async t=>{
  const f=await fixture(t);
  const waiting=f.send(2,'provider-body',A,known(2),{probe:'await',wait:true});
  await until(async()=> (await f.trace()).some(row=>row.probe==='await'&&row.phase==='before'));
  await f.send(3,'configuration',B,known(7,B));
  await writeFile(join(f.project,'release'),'release');await waiting;
  const after=(await f.trace()).find(row=>row.probe==='await'&&row.phase==='after');
  assert.equal(after.model,B.id);assert.deepEqual(after.usage,known(7,B));
  await f.send(5,'configuration',B,known(11,B));
  const reply=await f.send(4,'provider-body',A,known(2),{probe:'late-original'});
  assert.equal(reply.probe,'late-original','丢弃旧state不能丢弃原合法operation');
  const late=(await f.trace()).find(row=>row.probe==='late-original'&&row.phase==='after');
  assert.equal(late.model,B.id);assert.equal(late.window,B.contextWindow);assert.deepEqual(late.usage,known(11,B));
});

test('上下文帧/known→unknown→旧known：不残留旧数，null与真0独立，错绑定拒绝', {timeout:20000}, async t=>{
  const f=await fixture(t);
  await f.send(3,'configuration',C,undefined);
  await f.send(2,'provider-body',A,known(2),{probe:'late-known'});
  const late=(await f.trace()).find(row=>row.probe==='late-known'&&row.phase==='after');
  assert.equal(late.model,C.id);assert.equal(Object.hasOwn(late,'usage'),false,'缺席unknown必须清掉旧数字');
  await f.send(4,'provider-body',A,{tokens:null,contextWindow:A.contextWindow,percent:null},{probe:'compaction-null'});
  assert.deepEqual((await f.trace()).find(row=>row.probe==='compaction-null'&&row.phase==='after').usage,{tokens:null,contextWindow:A.contextWindow,percent:null});
  await f.send(5,'provider-body',A,known(0),{probe:'empty-zero'});
  assert.deepEqual((await f.trace()).find(row=>row.probe==='empty-zero'&&row.phase==='after').usage,known(0));
  for(const [index,bad] of [{sessionId:'another-session'},{resourceEpoch:'another-resource'},{threadId:f.worker.threadId+99},{requestId:999}].entries()){
    await assert.rejects(f.send(6+index,'configuration',B,known(99,B),{},bad),/resources-unavailable/);
  }
  await f.send(2,'provider-body',B,known(99,B),{probe:'after-bad-bindings'});
  const final=(await f.trace()).find(row=>row.probe==='after-bad-bindings'&&row.phase==='after');
  assert.equal(final.model,A.id);assert.deepEqual(final.usage,known(0),'被拒的关联不能推进帧或覆盖原值');
});


test('上下文帧/模型对象副本：扩展突变所得模型不得改原帧和用量', {timeout:20000}, async t=>{
  const f=await fixture(t);
  await f.send(2,'provider-body',A,known(2),{probe:'mutated-model',mutateModel:true});
  const observed=(await f.trace()).find(row=>row.probe==='mutated-model'&&row.phase==='after');
  assert.equal(observed.model,A.id,'扩展得到的model对象不能作为正式帧写入口');
  assert.equal(observed.window,A.contextWindow);
  assert.deepEqual(observed.usage,known(2),'窗口和tokens从原正式帧读取');
});


test('上下文帧/迟到context保当次正文：原handler与Host回包不被新帧正文替换', {timeout:20000}, async t=>{
  const f=await fixture(t),nonce=randomUUID();
  const context2=[{role:'user',content:'ORIGINAL_CONTEXT_OPERATION_2_'+nonce,timestamp:200}];
  const frame3=[{role:'user',content:'NEWER_GLOBAL_FRAME_3_'+nonce,timestamp:300}];
  assert.notDeepEqual(context2,frame3);
  await f.send(3,'configuration',B,known(11,B),{},{},frame3);
  const reply=await f.send(2,'context',A,known(2),{messages:context2},{},context2);
  const rows=(await f.trace()).filter(row=>row.probe==='context');
  assert.equal(rows.length,1,'旧state被跳过仍执行原context operation且恰一次');
  const seen=rows[0];assert.equal(seen.model,B.id);assert.equal(seen.window,B.contextWindow);assert.deepEqual(seen.usage,known(11,B));
  assert.deepEqual({handlerMessages:seen.messages,hostReplyMessages:reply.messages},{handlerMessages:context2,hostReplyMessages:context2},
    '原context2 handler与Host回包都须消费自己的正文；同步getter仍读最新帧B');
  assert.notDeepEqual(reply.messages,frame3);
});
