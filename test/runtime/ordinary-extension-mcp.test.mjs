import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { ROOT_CONVERSATION_ID, ToolTask } from '@earendil-works/pi-durable';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { createRealPiBackend, ModelSetupStore, PiExecutionSession } from '../../src/adapters/pi/index.ts';
import { prepareCodingProject, startCodingLoopback, codingKey, codingModel } from '../e2e/ordinary-coding-fixture.mjs';
import { controlledModels, until } from './fixtures.ts';
import { start as startHttpMcp } from '../e2e/ordinary-http-mcp-fixture.mjs';
import { Script } from 'node:vm';
import { Worker } from 'node:worker_threads';
import { createProvider } from '@earendil-works/pi-ai/models';
import * as openaiCompletions from '@earendil-works/pi-ai/api/openai-completions';
import { extensionWorkerSource } from '../../src/adapters/pi/extension-worker.ts';
import { evidenceDir } from '../e2e/evidence-root.mjs';

await test('生产资源线程的实际源码通过原生语法解析',()=>{new Script(extensionWorkerSource);});

const mcpFixture = resolve('test/e2e/ordinary-mcp-fixture.mjs');
async function fixture({ calls, enabled = true, access = 'task-owner', exposure = 'direct', holdFinal = false, extensionSource = '', settings, http = false, subsequentCalls = [], firstRoundCalls, holdCancelAck = false, connectMcp = true, loopbackOptions = {}, additionalSources }) {
  const root = await mkdtemp(join(tmpdir(), 'dcode-ext-mcp-'));
  const project = join(root, 'project'); await prepareCodingProject(project);
  const nonce = randomUUID();
  await writeFile(join(project, '.fixture-owner'), nonce); await writeFile(join(project, 'input.txt'), 'actual MCP input ' + nonce);
  const extensionDir = join(project, '.pi/extensions'); await mkdir(extensionDir, { recursive: true });
  await writeFile(join(extensionDir, 'fixture.ts'), `import { Type } from 'typebox';
export default function(pi) {
  pi.on('tool_call', event => { if (event.toolName === 'extension_block') return {block:true,reason:'blocked by actual extension'}; });
  pi.registerTool({name:'extension_block',label:'block',description:'Must be blocked',parameters:Type.Object({}),
    async execute(){ throw new Error('Block must happen before execution'); }});
  pi.registerTool({name:'extension_chain',label:'chain',description:'Actual nested MCP call',parameters:Type.Object({}),
    async execute(id, args, signal, update, ctx) {
      const called = await ctx.executeTool('mcp__fixture__append_once', {token:'nested',text:${JSON.stringify(nonce)}});
      return {content:called.result.content,details:{nestedError:called.isError}};
    }});
}` + extensionSource);
  if (settings) await writeFile(join(project,'.pi/settings.json'), JSON.stringify(settings));
  const httpMcp = http && connectMcp ? await startHttpMcp(project,nonce,{holdCancelAck}) : undefined;
  await writeFile(join(project, '.pi/mcp.json'), JSON.stringify({ mcpServers: connectMcp ? { fixture: httpMcp ? {url:httpMcp.origin,exposure} : { command: process.execPath,
    args: [mcpFixture, project, nonce], exposure } } : {} }));
  const server = await startCodingLoopback({ prefixCalls: typeof calls==='function' ? calls(nonce) : calls, holdFinal, subsequentCalls,firstRoundCalls, ...loopbackOptions });
  const stateDir = join(root, 'state');
  const cipher = { isAvailable: () => true, encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() };
  const store = new ModelSetupStore({ stateDir }, cipher);
  await store.commitWithCredential({ provider: 'openai-completions', label: 'isolated extension MCP', modelId: codingModel,
    baseUrl: `${server.origin}/v1`, note: 'ready', keyAction: 'replace', apiKey: codingKey });
  const preparedSources = typeof additionalSources === 'function' ? await additionalSources({ server, stateDir, store, nonce }) : additionalSources;
  const backend = createRealPiBackend({ stateDir, cipher, store, additionalSources: preparedSources,
    config: { provider: 'openai-completions', label: 'isolated extension MCP', modelId: codingModel, baseUrl: `${server.origin}/v1` } });
  const target = { workspaceId: 'space', taskId: 'task', sessionId: 'ext-mcp-session' };
  const opening = { target, title: '真实扩展与 MCP', workFolder: project, model: null, initialize: true, projectAccess: access,
    projectExtensionsEnabled: () => enabled };
  const session = await backend.open(opening);
  const input = { target, operationId: 'extension-original', text: '实际扩展、MCP 与编码任务', mode: 'follow-up', references: [], expected: (await session.read()).control };
  return { root, project, nonce, backend, target, opening, session, input, server, stateDir,
    async events() { if(httpMcp)return [...httpMcp.events];const logs = (await readdir(project)).filter(name => name.startsWith('mcp-events-'));
      return (await Promise.all(logs.map(file => readFile(join(project, file), 'utf8')))).flatMap(text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))); },
    async dispose() {
      let failure;
      try { await session.close(); } catch(error) { failure=error; }
      // 关闭失败也必须结束本夹具的真实监听；失败数据留原位置，不让未关闭server拖住整份门槛。
      try { await server.close(); } catch(error) { failure??=error; }
      try { await httpMcp?.close(); } catch(error) { failure??=error; }
      if(failure)throw failure;
      await rm(root, { recursive: true, force: true });
    } };
}

// JSONL公开open会执行恢复和截断；在途证据只读自有临时副本，不能打开原writer目录。
async function readonlyStorageCopy(f,read){
  const dir=join(f.root,'readonly-storage-'+randomUUID());let storage;
  try{
    const original=join(f.stateDir,'runtime',f.target.sessionId);let snapshot;
    // 目录cp会追到正在消失的.reclaim临时文件；只接收连续两读相同的正式JSONL字节。
    // 没有修改或恢复原目录；若稳定副本本身损坏，下面公开open仍原样失败，不吞业务断言。
    await until(async()=>{
      const names=(await readdir(original)).filter(name=>/^(main|doc-\d+|task-\d+)\.jsonl$/.test(name)).sort();
      try{
        const before=await Promise.all(names.map(name=>readFile(join(original,name))));
        const afterNames=(await readdir(original)).filter(name=>/^(main|doc-\d+|task-\d+)\.jsonl$/.test(name)).sort();
        if(JSON.stringify(names)!==JSON.stringify(afterNames))return false;
        const after=await Promise.all(names.map(name=>readFile(join(original,name))));
        if(!before.every((bytes,index)=>bytes.equals(after[index])))return false;
        snapshot=names.map((name,index)=>({name,bytes:before[index]}));return true;
      }catch(error){if(error.code==='ENOENT')return false;throw error;}
    });
    await mkdir(dir);await Promise.all(snapshot.map(({name,bytes})=>writeFile(join(dir,name),bytes)));
    storage=await openNodeJsonlStorage(dir,context);return await read(storage);
  }
  finally{await storage?.close(context);await rm(dir,{recursive:true,force:true});}
}

await test('启用扩展后的技能集合：同一项目技能只进入本次真实请求目录一次', {timeout:30000}, async()=>{
  const f=await fixture({calls:[]});
  try {
    const dir=join(f.project,'.pi/skills/single-resource');await mkdir(dir,{recursive:true});
    const description='SINGLE_SKILL_DESCRIPTION_'+f.nonce;
    await writeFile(join(dir,'SKILL.md'),'---\nname: single-resource\ndescription: '+description+'\n---\n读取本技能正文后再开展工作。');
    assert.equal((await f.session.submit(f.input)).status,'accepted');
    try{await until(async()=>(await f.session.lookupReceipt(f.input)).processing==='done');}catch(error){
      const view=await f.session.read();await writeFile(join(evidenceDir('ordinary-extension-runtime'),'single-skill-timeout-'+f.nonce+'.json'),JSON.stringify({nonce:f.nonce,receipt:await f.session.lookupReceipt(f.input),phase:view.phase,entries:view.entries.map(entry=>({id:entry.id,kind:entry.kind,failureKind:entry.failureKind,tool:entry.toolResult?.name})),requests:f.server.requests.map(request=>({ordinal:request.ordinal,receivedAt:request.receivedAt,authOk:request.authOk})),events:await f.events()},null,2));throw error;
    }
    const request=JSON.stringify(f.server.requests[0].body);
    assert.equal(request.split(description).length-1,1,'公开资源集合不可与基础目录重复拼接');
    assert.deepEqual(f.server.errors,[]);
  }finally{await f.dispose();}
});

await test('普通扩展与真实 MCP：拦截、业务错误、同 Harness 内部调用、正式结果／后续 HTTP 与只读重开', { timeout: 45000 }, async () => {
  const f = await fixture({ calls: [['extension_block', {}], ['mcp__fixture__fail', { token: 'expected' }], ['extension_chain', {}]], holdFinal: true });
  let session = f.session;
  try {
    assert.equal((await session.submit(f.input)).status, 'accepted');
    const sentAt=Date.now();
    try{await until(() => f.server.requests.length === 9);}catch(error){
      const view=await session.read();
      await writeFile(join(evidenceDir('ordinary-extension-runtime'),'first-path-timeout.json'),JSON.stringify({sentAt,observedAt:Date.now(),requests:f.server.requests.map(r=>({ordinal:r.ordinal,receivedAt:r.receivedAt,authOk:r.authOk})),receipt:await session.lookupReceipt(f.input),phase:view.phase,entries:view.entries.map(e=>({id:e.id,kind:e.kind,...(e.toolResult?{tool:e.toolResult.name,isError:e.toolResult.isError}:{}),...(e.failureKind?{failureKind:e.failureKind}:{})})),events:await f.events()},null,2));throw error;
    }
    const view = await session.read();
    const block = view.entries.find(e => e.toolResult?.name === 'extension_block')?.toolResult;
    assert.equal(block?.isError, true); assert.match(block.text, /blocked by actual extension/);
    const failure = view.entries.find(e => e.toolResult?.name === 'mcp__fixture__fail')?.toolResult;
    assert.equal(failure?.isError, true); assert.ok(failure.text.includes(f.nonce));
    const nested = view.entries.find(e => e.toolResult?.name === 'mcp__fixture__append_once')?.toolResult;
    assert.equal(nested?.isError, false); assert.ok(nested.text.includes(f.nonce));
    assert.deepEqual((await readFile(join(f.project, 'effects.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse), [{ nonce: f.nonce, token: 'nested', text: f.nonce }]);
    assert.ok(f.server.requests[3].body.messages.some(m => m.role === 'tool' && m.content.includes(f.nonce)), '内部真实结果须由外层结果进入下一 SDK HTTP');
    assert.ok(f.server.requests[0].body.tools.some(t => t.function.name === 'extension_chain'));
    await session.pause(); await session.close();
    const events = await f.events(); assert.equal(events.filter(e => e.type === 'call.start' && e.tool === 'append_once').length, 1);
    assert.ok(events.some(e => e.type === 'close.drained' && e.pending === 0)); assert.ok(events.some(e => e.type === 'exit'));
    const storage = await openNodeJsonlStorage(join(f.stateDir, 'runtime', f.target.sessionId), context);
    try {
      const entries = (await storage.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 200, undefined, context)).items;
      const child = entries.flatMap(e => e.model ?? []).find(m => m.role === 'toolResult' && m.toolName === 'mcp__fixture__append_once');
      assert.ok(child); assert.ok(child.toolCallId.startsWith('actual-tool-3/'));
      const outer = entries.flatMap(e => e.model ?? []).find(m => m.role === 'toolResult' && m.toolName === 'extension_chain');
      assert.equal(outer.details.nestedCalls.length, 1);
      assert.ok(!entries.flatMap(e => e.model ?? []).some(m => m.role === 'assistant' && m.content.some(p => p.type === 'toolCall' && p.id === child.toolCallId)), '真实内部调用不伪造模型 assistant');
    } finally { await storage.close(context); }
    const startCount = events.filter(e => e.type === 'start').length;
    session = await f.backend.open({ ...f.opening, initialize: false }); const reopened = await session.read();
    assert.equal(f.server.requests.length, 9); assert.equal((await f.events()).filter(e => e.type === 'start').length, startCount);
    f.server.releaseFinal(); await session.resume(reopened.control);
    await until(() => f.server.requests.length === 10);
    await until(async () => (await session.lookupReceipt(f.input)).processing === 'done');
    assert.equal((await f.events()).filter(e => e.type === 'call.start' && e.tool === 'append_once').length, 1, '明确继续也不重放已完成副作用');
    assert.deepEqual(f.server.errors, []);
  } finally { await session.close(); await f.dispose(); }
});

for (const access of [null, 'task-owner']) await test(`项目扩展未启用／成员无范围 ${access ?? 'member'}：不加载、不连接、不泄露资源`, { timeout: 20000 }, async () => {
  const f = await fixture({ calls: [['extension_chain', {}]], enabled: access === null, access });
  try {
    assert.equal((await f.session.submit(f.input)).status, 'accepted');
    await until(() => f.server.requests.length > 1);
    assert.ok(!f.server.requests[0].body.tools?.some(t => t.function.name === 'extension_chain'));
    assert.deepEqual(await f.events(), []);
    await assert.rejects(readFile(join(f.project, 'effects.jsonl')), { code: 'ENOENT' });
  } finally { await f.dispose(); }
});

await test('真实 MCP 在途取消：服务器核到同 requestId 的取消，暂停／关闭实际收束，继续不重放', { timeout: 30000 }, async () => {
  const f = await fixture({ calls: [['mcp__fixture__wait', { token: 'parked' }]] });
  let session = f.session;
  try {
    assert.equal((await session.submit(f.input)).status, 'accepted');
    await until(async () => (await f.events()).some(e => e.type === 'wait.pending'));
    const parked = (await f.events()).find(e => e.type === 'wait.pending');
    const paused = await session.pause(); assert.equal(paused.phase, 'paused');
    const events = await f.events();
    assert.ok(events.some(e => e.type === 'cancel.received' && e.requestId === parked.requestId && e.matched));
    assert.ok(events.some(e => e.type === 'close.drained' && e.pending === 0));
    assert.ok(events.some(e => e.type === 'exit'));
    assert.equal(f.server.requests.length, 1, '取消到达与 Harness 停止之间不得泄漏下一次模型请求');
    await assert.rejects(readFile(join(f.project, 'effects.jsonl')), { code: 'ENOENT' });
    await session.close();
    session = await f.backend.open({ ...f.opening, initialize: false }); const restored = await session.read();
    assert.equal(f.server.requests.length, 1);
    const count = (await f.events()).filter(e => e.type === 'start').length;
    assert.equal(count, 1);
    await session.resume(restored.control);
    await until(async () => (await session.lookupReceipt(f.input)).processing === 'done');
    assert.equal((await f.events()).filter(e => e.type === 'call.start' && e.tool === 'wait').length, 1);
    assert.equal((await f.events()).filter(e => e.type === 'effect.committed').length, 0);
  } finally { await session.close(); await f.dispose(); }
});

await test('真实 MCP deferred：先工具搜索，再同次新 HTTP 声明和直接调用；不能靠初始全量工具假装搜索', { timeout: 30000 }, async () => {
  const f = await fixture({ exposure: 'deferred', calls: [['tool_search', { query: 'fixture append_once', limit: 1 }], ['mcp__fixture__append_once', { token: 'searched', text: 'actual searched' }]] });
  try {
    assert.equal((await f.session.submit(f.input)).status, 'accepted');
    await until(async () => (await f.session.lookupReceipt(f.input)).processing === 'done');
    assert.ok(f.server.requests[0].body.tools.some(t => t.function.name === 'tool_search'));
    assert.ok(!f.server.requests[0].body.tools.some(t => t.function.name === 'mcp__fixture__append_once'));
    assert.ok(f.server.requests[1].body.tools.some(t => t.function.name === 'mcp__fixture__append_once'));
    const actual = (await f.session.read()).entries.find(e => e.toolResult?.name === 'mcp__fixture__append_once');
    assert.equal(actual.toolResult.isError, false);
    assert.ok(actual.toolResult.text.includes(f.nonce));
    assert.equal((await f.events()).filter(e => e.type === 'effect.committed').length, 1);
    assert.deepEqual(f.server.errors, []);
  } finally { await f.dispose(); }
});

await test('真实 MCP Codemode：内部调用保原父身份，脚本 store 可从正式记录只读派生取回', { timeout: 30000 }, async () => {
  const code = "const value = await tools.mcp__fixture__append_once({token:'script',text:'script actual'}); text(value.content[0].text); store('effect','stored actual');";
  const f = await fixture({ exposure: 'codemode', calls: [['codemode', { code }], ['codemode', { code: "text(load('effect'));" }]] });
  try {
    assert.equal((await f.session.submit(f.input)).status, 'accepted');
    await until(async () => (await f.session.lookupReceipt(f.input)).processing === 'done');
    const scripts = (await f.session.read()).entries.filter(e => e.toolResult?.name === 'codemode');
    assert.equal(scripts.length, 2);
    assert.equal(scripts[0].toolResult.isError, false); assert.ok(scripts[0].toolResult.text.includes(f.nonce));
    assert.equal(scripts[1].toolResult.isError, false); assert.ok(scripts[1].toolResult.text.includes('stored actual'));
    assert.equal((await f.events()).filter(e => e.type === 'effect.committed').length, 1);
    assert.ok(!f.server.requests[0].body.tools.some(t => t.function.name === 'mcp__fixture__append_once'));
    assert.deepEqual(f.server.errors, []);
  } finally { await f.dispose(); }
});

await test('扩展正式输入：transform 先于模板展开，真实启动/请求钩子与动作只进入原 operation；同身份查回不再处理', {timeout:30000}, async () => {
  const f = await fixture({calls:[], extensionSource:`
export const ignored = 0;`});
  try {
    await writeFile(join(f.project,'.pi/extensions/events.ts'), `export default function(pi) {
      pi.on('session_start', (_,ctx) => { pi.appendEntry('startup-id',{sessionId:ctx.sessionManager.getSessionId()}); });
      pi.on('input', event => { pi.appendEntry('input-once',{source:event.source}); return {action:'transform',text:'/actual hooked'}; });
      pi.on('before_agent_start', event => ({message:{customType:'prepared',content:'ACTUAL_START '+event.prompt,display:true}}));
      pi.on('before_agent_start',()=>({message:{customType:'prepared-hidden',content:'CONTEXT_ONLY_START',display:false}}));
      pi.on('before_provider_request', event => ({...event.payload, extensionMarker:'actual-hook'}));
    }`);
    await mkdir(join(f.project,'.pi/prompts'),{recursive:true}); await writeFile(join(f.project,'.pi/prompts/actual.md'),'REAL_TEMPLATE $1');
    assert.equal((await f.session.submit(f.input)).status,'accepted');
    await until(async()=> (await f.session.lookupReceipt(f.input)).processing==='done');
    assert.ok(f.server.requests[0].body.messages.some(m=>m.role==='user' && m.content.includes('REAL_TEMPLATE hooked')));
    await readonlyStorageCopy(f,async storage=>{const entries=(await storage.scanEntries({conversationId:ROOT_CONVERSATION_ID},200,undefined,context)).items;const user=entries.find(e=>e.kind==='pi.user').model[0];assert.equal(user.content[0].text,'REAL_TEMPLATE hooked');});
    await until(async()=>(await f.session.read()).pendingInputs===0);
    assert.ok(f.server.requests[0].body.messages.some(m=>m.content.includes('ACTUAL_START REAL_TEMPLATE hooked')));
    assert.ok(f.server.requests.every(r=>r.body.extensionMarker==='actual-hook'));
    let view=await f.session.read();
    assert.deepEqual(view.entries.filter(e=>e.extensionMessage?.customType==='prepared').map(e=>e.extensionMessage),[{customType:'prepared',text:'ACTUAL_START REAL_TEMPLATE hooked',display:true}]);
    assert.deepEqual(view.entries.filter(e=>e.extensionMessage?.customType==='prepared-hidden').map(e=>e.extensionMessage),[{customType:'prepared-hidden',text:'CONTEXT_ONLY_START',display:false}]);
    assert.ok(f.server.requests[0].body.messages.some(m=>m.content==='CONTEXT_ONLY_START'));
    assert.equal(view.entries.filter(e=>e.kind==='dcode.extension-entry' && e.data.action==='entry' && e.data.value.customType==='input-once').length,1);
    assert.equal(view.entries.find(e=>e.data?.value?.customType==='startup-id').data.value.data.sessionId,f.target.sessionId);
    const count=f.server.requests.length; await f.session.submit(f.input); await f.session.lookupReceipt(f.input);
    view=await f.session.read(); assert.equal(f.server.requests.length,count);
    assert.equal(view.entries.filter(e=>e.data?.value?.customType==='input-once').length,1);
  } finally {await f.dispose();}
});

await test('扩展 session_info_changed 只在 Durable 名称改变后触发，事件上下文读取已保存名称且只读重开不重放', {timeout:30000}, async()=>{
  const f=await fixture({calls:[]});let session=f.session;
  try{
    await writeFile(join(f.project,'.pi/extensions/session-info.ts'),`export default function(pi){
      pi.on('input',()=>{
        pi.setSessionName('  Session\\ntitle  ');
        pi.setSessionName('Session title');
        return {action:'continue'};
      });
      pi.on('session_info_changed',(event,ctx)=>pi.appendEntry('observed-session-info',{
        eventName:event.name,sessionManagerName:ctx.sessionManager.getSessionName(),apiName:pi.getSessionName()
      }));
    }`);
    assert.equal((await session.submit(f.input)).status,'accepted');
    await until(async()=>(await session.lookupReceipt(f.input)).processing==='done');
    await until(async()=>(await session.read()).phase==='ready');
    let view=await session.read();
    const names=view.entries.filter(entry=>entry.kind==='dcode.extension-entry'&&entry.data?.action==='name');
    const observed=view.entries.filter(entry=>entry.kind==='dcode.extension-entry'&&entry.data?.value?.customType==='observed-session-info');
    assert.equal(observed.length,1,'连续设置同一规范化名称只触发一次元数据事件');
    assert.equal(names.length,1,'重复名称不再追加等价的会话元数据');
    assert.deepEqual(observed[0].data.value.data,{eventName:'Session title',sessionManagerName:'Session title',apiName:'Session title'});
    assert.ok(names[0].id<observed[0].id,'SDK event follows the Durable name entry');

    const next={...f.input,operationId:'extension-name-same-value',text:'same-name follow-up',expected:view.control};
    assert.equal((await session.submit(next)).status,'accepted');
    await until(async()=>(await session.lookupReceipt(next)).processing==='done');
    await until(async()=>(await session.read()).phase==='ready');
    view=await session.read();
    assert.equal(view.entries.filter(entry=>entry.kind==='dcode.extension-entry'&&entry.data?.value?.customType==='observed-session-info').length,1,
      'same normalized title does not emit another metadata-change event');
    const requests=f.server.requests.length;
    await session.close();session=await f.backend.open({...f.opening,initialize:false});
    const reopened=await session.read();
    assert.equal(f.server.requests.length,requests,'read-only reopen must not execute or send a model request');
    assert.equal(reopened.entries.filter(entry=>entry.kind==='dcode.extension-entry'&&entry.data?.value?.customType==='observed-session-info').length,1,
      'read-only reopen reads the recorded event result without replaying its handler');
  }finally{await session.close();await f.dispose();}
});

await test('扩展 Worker 的晚到普通状态快照不能回滚已确认的 Durable 会话名称', {timeout:30000}, async()=>{
  const root=await mkdtemp(join(tmpdir(),'dcode-extension-state-revision-'));
  const projectPath=join(root,'project');await mkdir(projectPath,{recursive:true});
  const project=await realpath(projectPath),agentDir=join(root,'app'),extensionDir=join(project,'.pi/extensions');
  await mkdir(extensionDir,{recursive:true});await mkdir(agentDir,{recursive:true});
  await writeFile(join(project,'.pi/settings.json'),JSON.stringify({extensions:['./extensions/observe-session.mjs']}));await writeFile(join(project,'.pi/mcp.json'),'{}');
  await writeFile(join(extensionDir,'observe-session.mjs'),`export default function(pi){
    pi.on('input',event=>{
      if(event.text==='rename')pi.setSessionName('New Name');
      if(event.text==='observe-late-state')pi.appendEntry('observed-late-state',{name:pi.getSessionName()});
      return {action:'handled'};
    });
    pi.on('session_info_changed',(event,ctx)=>pi.appendEntry('event-saw-name',{name:ctx.sessionManager.getSessionName()}));
  }`);
  const oldEntries=[{id:1,kind:'dcode.extension-entry',data:{action:'name',value:{name:'Old Name'}},model:[]}];
  const newEntries=[...oldEntries,{id:2,kind:'dcode.extension-entry',data:{action:'name',value:{name:'New Name'}},model:[]}];
  const worker=new Worker(extensionWorkerSource,{eval:true,execArgv:[],env:{...process.env,PI_CODING_AGENT_DIR:agentDir,PI_OFFLINE:'1',NODE_TEST_CONTEXT:undefined},workerData:{
    cwd:project,agentDir,sdk:import.meta.resolve('@earendil-works/pi-coding-agent'),
    streamFactory:import.meta.resolve('@earendil-works/pi-ai/utils/event-stream'),builtins:[]
  }});
  const messages=[],waiters=[];
  const waitFor=predicate=>{
    const index=messages.findIndex(predicate);if(index>=0)return Promise.resolve(messages.splice(index,1)[0]);
    return new Promise(resolve=>waiters.push({predicate,resolve}));
  };
  worker.on('message',message=>{
    const index=waiters.findIndex(waiter=>waiter.predicate(message));
    if(index>=0)waiters.splice(index,1)[0].resolve(message);else messages.push(message);
  });
  const state=entries=>({sessionId:'worker-state-test',entries,messages:[],systemPrompt:'',modelCatalog:{all:[],available:[]},thinkingLevel:'off'});
  const request=(id,method,entries,value={})=>worker.postMessage({type:'request',id,method,value,state:state(entries),scope:'test-scope-'+id});
  try{
    request(1,'init',oldEntries,{});
    const initialized=await waitFor(message=>message.type==='result'&&message.id===1);
    assert.equal(initialized.ok,true);

    request(2,'input',oldEntries,{text:'rename',source:'rpc',mode:'steer'});
    const nameWrite=await waitFor(message=>message.type==='host'&&message.method==='name');
    // Durable 已写入，但先让普通 Host 请求带着新快照到达，延后名称 RPC 的正式回执。
    request(3,'configuration',newEntries,{});
    assert.equal((await waitFor(message=>message.type==='result'&&message.id===3)).ok,true);
    worker.postMessage({type:'reply',id:nameWrite.id,ok:true,value:{entries:newEntries,nameChanged:true}});
    const eventOrInputResult=await waitFor(message=>(message.type==='host'&&message.method==='entry'&&message.value?.customType==='event-saw-name')
      ||(message.type==='result'&&message.id===2));
    assert.equal(eventOrInputResult.type,'host','a newer ordinary snapshot must not suppress an undelivered name-change event');
    const changedEvent=eventOrInputResult;
    assert.equal(changedEvent.value.data.name,'New Name');
    worker.postMessage({type:'reply',id:changedEvent.id,ok:true,value:{}});
    assert.equal((await waitFor(message=>message.type==='result'&&message.id===2)).ok,true);

    // 模拟 Host 在异步状态读取后才投递的旧请求快照：它到达时新名称已确认。
    request(4,'configuration',oldEntries,{});
    assert.equal((await waitFor(message=>message.type==='result'&&message.id===4)).ok,true);
    request(5,'input',oldEntries,{text:'observe-late-state',source:'rpc',mode:'steer'});
    const observed=await waitFor(message=>message.type==='host'&&message.method==='entry'&&message.value?.customType==='observed-late-state');
    assert.equal(observed.value.data.name,'New Name','late old request must not replace the current read-only session view');
    worker.postMessage({type:'reply',id:observed.id,ok:true,value:{}});
    assert.equal((await waitFor(message=>message.type==='result'&&message.id===5)).ok,true);

    worker.postMessage({type:'request',id:6,method:'close',value:{}});
    assert.equal((await waitFor(message=>message.type==='result'&&message.id===6)).ok,true);
  }finally{await worker.terminate();await rm(root,{recursive:true,force:true});}
});

await test('扩展 handled：原正式被动回执，不造模型回复；暂停重开只读查原 operation 零重处理', {timeout:30000}, async()=>{
  const f=await fixture({calls:[]}); let session=f.session;
  try {
    await writeFile(join(f.project,'.pi/extensions/handled.ts'),`export default function(pi){pi.on('input',()=>{pi.appendEntry('handled-once',{actual:true});pi.sendMessage({customType:'local-command',content:'真实扩展已处理',display:true});return {action:'handled'};});}`);
    const accepted=await session.submit(f.input); assert.equal(accepted.status,'accepted'); await until(async()=>(await session.lookupReceipt(f.input)).processing==='done');
    assert.equal(f.server.requests.length,0); let view=await session.read();
    assert.equal(view.entries.filter(e=>e.kind==='dcode.handled-input').length,1);
    assert.ok(view.entries.some(e=>e.extensionMessage?.customType==='local-command' && e.extensionMessage.text==='真实扩展已处理'));
    await session.pause(); await session.close(); const starts=(await f.events()).filter(e=>e.type==='start').length;
    session=await f.backend.open({...f.opening,initialize:false}); await session.read();
    assert.equal((await session.submit(f.input)).submissionId,accepted.submissionId);
    assert.equal((await f.events()).filter(e=>e.type==='start').length,starts); assert.equal(f.server.requests.length,0);
    view=await session.read(); assert.equal(view.entries.filter(e=>e.data?.value?.customType==='handled-once').length,1);
  }finally{await session.close();await f.dispose();}
});

await test('可见扩展消息不冒充新用户输入；同文本不同 operation 各消费一次真实启动', {timeout:30000}, async()=>{
  const f=await fixture({calls:[['visible_turn',{}]]});
  try{
    await writeFile(join(f.project,'.pi/extensions/turns.ts'),`import {Type} from 'typebox';export default function(pi){
      pi.on('before_agent_start',event=>{pi.appendEntry('actual-input-start',{prompt:event.prompt});});
      pi.registerTool({name:'visible_turn',label:'visible',description:'Actual visible contribution',parameters:Type.Object({}),execute:async()=>{
        pi.sendMessage({customType:'turn-visible',content:'VISIBLE_CONTEXT_IS_NOT_INPUT',display:true});return {content:[{type:'text',text:'visible tool completed'}]};}});
    }`);
    const first=await f.session.submit(f.input);await until(async()=>(await f.session.lookupReceipt(f.input)).processing==='done');
    let view=await f.session.read();const starts=v=>v.entries.filter(e=>e.data?.value?.customType==='actual-input-start');
    assert.equal(starts(view).length,1);assert.equal(starts(view)[0].data.value.data.prompt,f.input.text);
    assert.ok(f.server.requests[1].body.messages.some(m=>m.content==='VISIBLE_CONTEXT_IS_NOT_INPUT'));
    const next={...f.input,operationId:'same-text-new-operation',expected:view.control};
    const second=await f.session.submit(next);assert.notEqual(second.submissionId,first.submissionId);
    await until(async()=>(await f.session.lookupReceipt(next)).processing==='done');view=await f.session.read();
    assert.equal(starts(view).length,2);assert.ok(starts(view).every(e=>e.data.value.data.prompt===f.input.text));
    assert.equal(view.entries.filter(e=>e.kind==='pi.user').length,2);assert.deepEqual(f.server.errors,[]);
  }finally{await f.dispose();}
});

await test('扩展 sendUserMessage 复用 Durable 输入准备并遵守模板选项与扩展来源', {timeout:30000}, async()=>{
  const f=await fixture({calls:[],loopbackOptions:{callsOverride:[['send_followups',{}]]},subsequentCalls:[undefined]});
  try{
    await mkdir(join(f.project,'.pi/prompts'),{recursive:true});
    await writeFile(join(f.project,'.pi/prompts/actual.md'),'EXPANDED $ARGUMENTS');
    await writeFile(join(f.project,'.pi/extensions/send-followups.ts'),`import {Type} from 'typebox';export default function(pi){
      pi.on('input',event=>{pi.appendEntry('send-user-input',{source:event.source,mode:event.streamingBehavior,text:event.text});return {action:'transform',text:event.text+' hooked'};});
      pi.registerTool({name:'send_followups',label:'send followups',description:'Use the formal input path',parameters:Type.Object({}),execute:async()=>{
        await pi.sendUserMessage('/actual plain',{deliverAs:'followUp'});
        await pi.sendUserMessage('/actual expanded',{deliverAs:'followUp',expandPromptTemplates:true});
        await pi.sendUserMessage([{type:'text',text:'/actual blocks'},{type:'text',text:'second part'}]);
        await pi.sendUserMessage([{type:'text',text:'/actual image'},{type:'image',mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII='}]);
        return {content:[{type:'text',text:'both extension inputs admitted'}]};
      }});
    }`);
    assert.equal((await f.session.submit(f.input)).status,'accepted');
    try{await until(async()=>f.server.requests.length===5);}catch(error){const view=await f.session.read();throw new Error(`Extension inputs stopped: ${error.message}; requests=${f.server.requests.length}; pending=${view.pendingInputs}; phase=${view.phase}; userEntries=${view.entries.filter(e=>e.kind==='pi.user').length}`);}
    try{await until(async()=>{const view=await f.session.read();return view.pendingInputs===0&&view.phase==='ready'&&view.entries.filter(e=>e.kind==='pi.user').length===5;});}
    catch(error){const view=await f.session.read();throw new Error(`Extension input path did not settle: ${error.message}; requests=${f.server.requests.length}; pending=${view.pendingInputs}; phase=${view.phase}; userEntries=${view.entries.filter(e=>e.kind==='pi.user').length}`);}
    const view=await f.session.read();
    const users=view.entries.filter(e=>e.kind==='pi.user').map(e=>e.model?.find(m=>m.role==='user')?.content);
    assert.equal(users.length,5);
    const extensionInputViews=view.entries.filter(e=>e.extensionInput);
    assert.equal(extensionInputViews.length,4,'同会话 ExecutionView 暴露扩展正式接收的用户消息给桌面投影');
    assert.deepEqual(extensionInputViews.map(e=>e.extensionInput.text),['/actual plain','/actual expanded','/actual blocks\nsecond part','/actual image']);
    assert.ok(extensionInputViews.every(e=>e.extensionInput.submissionId>0));
    assert.ok(JSON.stringify(f.server.requests[2].body.messages).includes('/actual plain hooked'),'SDK default must not expand prompt templates');
    assert.ok(JSON.stringify(f.server.requests[3].body.messages).includes('EXPANDED expanded hooked'),'explicit template expansion follows the input transform');
    assert.ok(f.server.requests[4].body.messages.some(m=>m.role==='user'&&JSON.stringify(m.content).includes('/actual blocks\\nsecond part hooked')),'text content parts use the SDK newline normalization');
    const events=view.entries.filter(e=>e.kind==='dcode.extension-entry'&&e.data?.value?.customType==='send-user-input').map(e=>e.data.value.data);
    assert.deepEqual(events.map(e=>({source:e.source,mode:e.mode})),[
      {source:'rpc',mode:'followUp'},{source:'extension',mode:'followUp'},{source:'extension',mode:'followUp'},{source:'extension',mode:'followUp'},{source:'extension',mode:'followUp'},
    ]);
    assert.deepEqual(f.server.errors,[]);
    const requestCount=f.server.requests.length,acceptedInputs=extensionInputViews.map(entry=>entry.extensionInput);
    await f.session.pause();await f.session.close();
    f.session=await f.backend.open({...f.opening,initialize:false});
    const reopened=await f.session.read();assert.equal(reopened.phase,'paused');assert.equal(f.server.requests.length,requestCount);
    for(const admitted of acceptedInputs){
      const found=await f.session.lookupReceipt({target:f.target,operationId:admitted.operationId,text:admitted.text,...(admitted.images?.length?{images:admitted.images}:{}),references:[],mode:admitted.mode,expected:reopened.control});
      assert.equal(found.status,'accepted');assert.equal(found.processing,admitted.images?.length?'unanswered':'done');
    }
    assert.equal(f.server.requests.length,requestCount,'暂停、关闭与只读重开不重放已完成扩展输入');
    assert.equal((await f.session.read()).entries.filter(e=>e.extensionInput).length,4);
  }finally{await f.dispose();}
});

await test('显式展开的扩展注册命令由同一 Durable 输入处理；不发送原命令正文或静默执行会话控制', {timeout:30000}, async()=>{
  const f=await fixture({calls:[],loopbackOptions:{callsOverride:[['extension_command_sender',{}]]}});
  try{
    await writeFile(join(f.project,'.pi/extensions/commands.ts'),`import {Type} from 'typebox';export default function(pi){
      pi.on('input',event=>{if(event.text.startsWith('/known '))pi.appendEntry('command-input-leaked-to-model',{text:event.text});});
      pi.registerCommand('known',{description:'Controlled durable extension command',handler:async(args,ctx)=>{pi.sendMessage({customType:'command-result',content:'COMMAND_ARGS '+args,display:true});}});
      pi.registerCommand('tree-control',{description:'Unsupported session control must reject',handler:async(_args,ctx)=>{await ctx.newSession();}});
      pi.registerCommand('headless-control',{description:'Headless command context preserves SDK boolean contract',handler:async(_args,ctx)=>{if(ctx.hasUI!==false)throw new Error('D Code command context must expose hasUI=false');pi.sendMessage({customType:'headless-command-result',content:'HEADLESS_COMMAND',display:true});}});
      pi.registerCommand('ui-control',{description:'Unsupported UI must reject',handler:async(_args,ctx)=>{if(ctx.hasUI!==false)throw new Error('D Code command context must expose hasUI=false');ctx.ui.notify('not supported');}});
      pi.registerTool({name:'extension_command_sender',label:'send extension command',description:'Explicitly expand registered commands through sendUserMessage',parameters:Type.Object({}),execute:async()=>{await pi.sendUserMessage('/known nested args',{deliverAs:'followUp',expandPromptTemplates:true});await pi.sendUserMessage('/headless-control',{deliverAs:'followUp',expandPromptTemplates:true});return {content:[{type:'text',text:'command inputs accepted '+JSON.stringify(pi.getCommands().map(command=>command.invocationName))}]};}});
    }`);
    assert.equal((await f.session.submit(f.input)).status,'accepted');
    await until(async()=>f.server.requests.length===2);
    await until(async()=>(await f.session.lookupReceipt(f.input)).processing==='done');
    await until(async()=>{const current=await f.session.read();const command=current.entries.find(entry=>entry.extensionInput?.text==='/known nested args')?.extensionInput;return command&&['done','unanswered'].includes(command.processing);});
    let view=await f.session.read();
    const commandMessage=view.entries.find(entry=>entry.extensionMessage?.customType==='command-result');
    assert.ok(commandMessage,JSON.stringify({commands:view.entries.filter(entry=>entry.toolResult?.name==='extension_command_sender').map(entry=>entry.toolResult.text),entries:view.entries.map(entry=>({kind:entry.kind,extensionMessage:entry.extensionMessage,data:entry.data,tool:entry.toolResult?.name}))}));assert.equal(commandMessage.extensionMessage.text,'COMMAND_ARGS nested args');
    assert.equal(view.entries.some(entry=>entry.kind==='dcode.extension-entry'&&entry.data?.value?.customType==='command-input-leaked-to-model'),false,'注册命令在input事件前分派，不将命令文本交给普通模型输入处理');
    assert.equal(f.server.requests.length,2,'命令handler的sendMessage不隐式产生新模型请求');
    const commandInput=view.entries.find(entry=>entry.extensionInput?.text==='/known nested args')?.extensionInput;
    assert.ok(commandInput);assert.equal(commandInput.processing,'done');

    await until(async()=>{const current=await f.session.read();return current.entries.some(entry=>entry.extensionInput?.text==='/headless-control'&&entry.extensionInput.processing==='done');});
    view=await f.session.read();const headless=view.entries.find(entry=>entry.extensionInput?.text==='/headless-control')?.extensionInput;
    assert.ok(headless);assert.equal((await f.session.lookupReceipt({target:f.target,operationId:headless.operationId,text:headless.text,references:[],mode:headless.mode,expected:view.control})).processing,'done','合法 headless 命令应按 SDK boolean 属性走成功分支');
    assert.ok(view.entries.some(entry=>entry.extensionMessage?.customType==='headless-command-result'&&entry.extensionMessage.text==='HEADLESS_COMMAND'));
    assert.equal(f.server.requests.length,2,'headless 命令副作用仍不产生模型请求');

    const unsupported={...f.input,operationId:'unsupported-command-control',text:'/tree-control',expected:view.control};
    assert.equal((await f.session.submit(unsupported)).status,'accepted');
    await until(async()=>['done','unanswered'].includes((await f.session.lookupReceipt(unsupported)).processing));
    view=await f.session.read();
    assert.equal((await f.session.lookupReceipt(unsupported)).processing,'unanswered','不支持的命令会话控制必须沿已接收路径显式失败');
    assert.ok(view.entries.some(entry=>entry.kind==='dcode.preparation-error'));
    assert.equal(f.server.requests.length,2,'命令失败不把原命令静默发送给模型');
    const unsupportedUI={...f.input,operationId:'unsupported-command-ui',text:'/ui-control',expected:view.control};
    assert.equal((await f.session.submit(unsupportedUI)).status,'accepted');
    await until(async()=>(await f.session.lookupReceipt(unsupportedUI)).processing==='unanswered');
    view=await f.session.read();assert.ok(view.entries.filter(entry=>entry.kind==='dcode.preparation-error').length>=2);
    assert.equal(f.server.requests.length,2,'未接入命令UI action明确失败而不静默完成');
    assert.deepEqual(f.server.errors,[]);
  }finally{await f.dispose();}
});

await test('暂停后显式继续时 session_start 可提交一次 Durable 输入且只读重开不执行', {timeout:30000}, async()=>{
  const f=await fixture({calls:[]});let session=f.session;
  const extension=join(f.project,'.pi/extensions/resume-start.ts');
  try{
    await writeFile(extension,`export default function(pi){
      pi.on('session_start',event=>pi.appendEntry('resume-start-event',{seen:'initial',reason:event.reason}));
    }`);
    assert.equal((await session.submit(f.input)).status,'accepted');
    await until(async()=>(await session.lookupReceipt(f.input)).processing==='done');
    await until(async()=>(await session.read()).phase==='ready');
    const requestsBeforePause=f.server.requests.length;
    await session.pause();await session.close();
    // 改变已装配扩展的真实字节，令明确继续重新装配；只读重开本身仍不得加载或执行它。
    await writeFile(extension,`export default function(pi){let sent=false;
      pi.on('session_start',event=>{pi.appendEntry('resume-start-event',{seen:'continued',reason:event.reason});if(!sent){sent=true;pi.sendUserMessage('EXTENSION_SESSION_START_AFTER_RESUME',{deliverAs:'followUp'});}});
    }`);
    session=await f.backend.open({...f.opening,initialize:false});
    const reopened=await session.read();assert.equal(reopened.phase,'paused');
    assert.equal(f.server.requests.length,requestsBeforePause,'只读重开不得执行 session_start');
    assert.deepEqual(reopened.entries.filter(e=>e.kind==='dcode.extension-entry'&&e.data?.value?.customType==='resume-start-event').map(e=>e.data.value.data),[
      {seen:'initial',reason:'startup'},
    ],'只读重开只读旧 session_start 结果，不再装载扩展');
    const resumed=await session.resume(reopened.control);
    assert.ok(['running','ready'].includes(resumed.phase));
    try{await until(async()=>f.server.requests.length===requestsBeforePause+1);}catch(error){
      const view=await session.read();
      throw new Error(`resume extension input did not reach HTTP: ${error.message}; requests=${f.server.requests.length}/${requestsBeforePause}; phase=${view.phase}; pending=${view.pendingInputs}; users=${view.entries.filter(e=>e.kind==='pi.user').length}; startEvents=${JSON.stringify(view.entries.filter(e=>e.data?.value?.customType==='resume-start-event').map(e=>e.data.value.data))}; preparationErrors=${view.entries.filter(e=>e.kind==='dcode.preparation-error').length}`);
    }
    await until(async()=>{const view=await session.read();return view.phase==='ready'&&view.entries.filter(e=>e.kind==='pi.user').length===2;});
    const view=await session.read();
    assert.equal(view.entries.filter(e=>e.kind==='pi.user').length,2);
    assert.equal(view.entries.filter(e=>e.extensionInput?.text==='EXTENSION_SESSION_START_AFTER_RESUME').length,1);
    assert.deepEqual(view.entries.filter(e=>e.kind==='dcode.extension-entry'&&e.data?.value?.customType==='resume-start-event').map(e=>e.data.value.data),[
      {seen:'initial',reason:'startup'},
      {seen:'continued',reason:'resume'},
    ],'新资源运行应把 SDK 公开的显式接续原因交给 session_start');
    assert.equal(f.server.requests.slice(requestsBeforePause).filter(r=>JSON.stringify(r.body.messages).includes('EXTENSION_SESSION_START_AFTER_RESUME')).length,1);
    assert.equal(f.server.requests.length,requestsBeforePause+1);
    assert.deepEqual(f.server.errors,[]);
  }finally{await session.close();await f.dispose();}
});

await test('扩展资源实际变化后 session_start 与 resources_discover 标记 SDK reload 原因', {timeout:30000}, async()=>{
  const f=await fixture({calls:[]});
  const extension=join(f.project,'.pi/extensions/reload-start.ts');
  try{
    await writeFile(extension,`export default function(pi){
      pi.on('session_start',event=>pi.appendEntry('resource-start-reason',{version:1,reason:event.reason}));
      pi.on('resources_discover',event=>pi.appendEntry('resource-discovery-reason',{version:1,reason:event.reason}));
    }`);
    assert.equal((await f.session.submit(f.input)).status,'accepted');
    await until(async()=> (await f.session.lookupReceipt(f.input)).processing==='done');
    await until(async()=> (await f.session.read()).phase==='ready');

    await writeFile(extension,`export default function(pi){
      pi.on('session_start',event=>pi.appendEntry('resource-start-reason',{version:2,reason:event.reason}));
      pi.on('resources_discover',event=>pi.appendEntry('resource-discovery-reason',{version:2,reason:event.reason}));
    }`);
    const current=await f.session.read();
    const next={...f.input,operationId:'extension-after-resource-reload',text:'reload extension resources',expected:current.control};
    assert.equal((await f.session.submit(next)).status,'accepted');
    await until(async()=> (await f.session.lookupReceipt(next)).processing==='done');
    await until(async()=> (await f.session.read()).phase==='ready');
    const view=await f.session.read();
    assert.deepEqual(view.entries.filter(e=>e.kind==='dcode.extension-entry'&&e.data?.value?.customType==='resource-start-reason').map(e=>e.data.value.data),[
      {version:1,reason:'startup'},
      {version:2,reason:'reload'},
    ]);
    assert.deepEqual(view.entries.filter(e=>e.kind==='dcode.extension-entry'&&e.data?.value?.customType==='resource-discovery-reason').map(e=>e.data.value.data),[
      {version:1,reason:'startup'},
      {version:2,reason:'reload'},
    ]);
    assert.equal(view.entries.filter(entry=>entry.kind==='pi.user').length,2,'资源reload不建立额外正式用户输入');
    assert.deepEqual(f.server.errors,[]);
  }finally{await f.dispose();}
});

await test('session_shutdown 按资源重载、暂停待恢复及最终关闭传递原因且不重放输入', {timeout:30000}, async()=>{
  const f=await fixture({calls:[]});let session=f.session;let reopened;let afterClose;
  const extension=join(f.project,'.pi/extensions/shutdown-lifecycle.ts');
  const observed=join(f.project,'.pi/shutdown-events.ndjson');
  const source=version=>`import { appendFileSync } from 'node:fs';
  export default function(pi){
    pi.on('session_shutdown',async event=>{
      appendFileSync(${JSON.stringify(observed)},JSON.stringify({version:${version},reason:event.reason})+'\\n');
      await pi.appendEntry('shutdown-reason',{version:${version},reason:event.reason});
    });
  }`;
  const shutdownRows=view=>view.entries.filter(e=>e.kind==='dcode.extension-entry'&&e.data?.value?.customType==='shutdown-reason').map(e=>e.data.value.data);
  const readShutdowns=async()=>{
    try{return (await readFile(observed,'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line));}
    catch(error){if(error?.code==='ENOENT')return [];throw error;}
  };
  try{
    await writeFile(extension,source(1));
    assert.equal((await session.submit(f.input)).status,'accepted');
    await until(async()=>(await session.lookupReceipt(f.input)).processing==='done');
    await until(async()=>(await session.read()).phase==='ready');

    await writeFile(extension,source(2));
    const beforeReload=await session.read();
    const next={...f.input,operationId:'extension-shutdown-reload',text:'reload shutdown reason',expected:beforeReload.control};
    assert.equal((await session.submit(next)).status,'accepted');
    await until(async()=>(await session.lookupReceipt(next)).processing==='done');
    await until(async()=>(await session.read()).phase==='ready');
    assert.deepEqual(shutdownRows(await session.read()),[{version:1,reason:'reload'}],
      'shutdown回调的正式扩展记录必须在reload替换旧Worker前提交');
    assert.deepEqual(await readShutdowns(),[{version:1,reason:'reload'}],
      '资源变化关闭旧Worker时必须向旧扩展传递Pi session_shutdown(reload)');

    const requestsAfterReload=f.server.requests.length;
    await session.pause();
    await session.close();
    reopened=await f.backend.open({...f.opening,initialize:false});
    const paused=await reopened.read();
    assert.equal(paused.phase,'paused');
    assert.deepEqual(shutdownRows(paused),[
      {version:1,reason:'reload'},
      {version:2,reason:'resume'},
    ],'暂停时shutdown事件的正式扩展记录须在Harness关闭前提交');
    const afterReadonlyReopen=await readShutdowns();
    assert.deepEqual(afterReadonlyReopen,[{version:1,reason:'reload'},{version:2,reason:'resume'}],
      '暂停关闭旧Worker须以resume原因收束；只读重开不装载扩展或再发事件');
    assert.equal(f.server.requests.length,requestsAfterReload,'只读重开不得重新请求模型');

    const resumed=await reopened.resume(paused.control);
    assert.ok(['running','ready'].includes(resumed.phase));
    await until(async()=>(await reopened.read()).phase==='ready');
    assert.equal((await reopened.read()).entries.filter(e=>e.kind==='pi.user').length,2,'明确继续不重放已完成输入');
    await reopened.close();
    afterClose=await f.backend.open({...f.opening,initialize:false});
    const closed=await afterClose.read();
    assert.deepEqual(shutdownRows(closed),[
      {version:1,reason:'reload'},
      {version:2,reason:'resume'},
      {version:2,reason:'quit'},
    ],'最终关闭时shutdown事件的正式扩展记录须在Harness关闭前提交');
    assert.deepEqual(await readShutdowns(),[
      {version:1,reason:'reload'},
      {version:2,reason:'resume'},
      {version:2,reason:'quit'},
    ],'最终关闭须传递quit；关闭后的只读重开不重复事件');
    assert.equal(f.server.requests.length,requestsAfterReload,'暂停、只读重开、继续与关闭不重发模型请求');
    assert.deepEqual(f.server.errors,[]);
  }finally{
    await Promise.allSettled([session?.close(),reopened?.close(),afterClose?.close(),f.dispose()]);
  }
});

await test('session_shutdown 有动作拒绝时仍排空同批记录并清理自有子进程', {timeout:30000}, async()=>{
  const f=await fixture({calls:[]});
  const extension=join(f.project,'.pi/extensions/shutdown-rejected-action.ts');
  const pidFile=join(f.root,'shutdown-child.pid'),stoppedFile=join(f.root,'shutdown-child-stopped');
  let childPid;
  const childScript=`const fs=require('node:fs');process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(stoppedFile)},'SIGTERM');process.exit(0)});fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.stdout.write('ready');setInterval(()=>{},1000);`;
  try{
    await writeFile(extension,`import {spawn} from 'node:child_process';export default function(pi){
      pi.on('session_start',async()=>{
        const child=spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:['ignore','pipe','ignore']});
        await new Promise((resolve,reject)=>{child.once('error',reject);child.stdout.once('data',resolve);});
      });
      pi.on('session_shutdown',async event=>{
        pi.sendUserMessage('SHUTDOWN_REJECTED_INPUT');
        pi.appendEntry('shutdown-drained',{reason:event.reason});
      });
    }`);
    assert.equal((await f.session.submit(f.input)).status,'accepted');
    await until(async()=>(await f.session.lookupReceipt(f.input)).processing==='done');
    await until(async()=>(await f.session.read()).phase==='ready');
    const requestCount=f.server.requests.length;
    const closing=f.session.close();
    await until(async()=>{
      try{childPid=Number(await readFile(pidFile,'utf8'));return Number.isSafeInteger(childPid)&&childPid>0;}
      catch(error){if(error?.code==='ENOENT')return false;throw error;}
    });
    await assert.rejects(closing,'a rejected new input from session_shutdown remains visible as a close failure');
    assert.equal((await readFile(stoppedFile,'utf8')),'SIGTERM','close must kill and join the actual child owned by the extension Worker');
    assert.equal(f.server.requests.length,requestCount,'rejected shutdown input must not start a model request');
    await readonlyStorageCopy(f,async storage=>{
      const entries=(await storage.scanEntries({conversationId:ROOT_CONVERSATION_ID},200,undefined,context)).items;
      assert.equal(entries.filter(entry=>entry.kind==='pi.user').length,1,'rejected shutdown input must not enter Durable history');
      assert.ok(!entries.flatMap(entry=>entry.model??[]).some(message=>message.role==='user'&&JSON.stringify(message.content).includes('SHUTDOWN_REJECTED_INPUT')));
      assert.ok(entries.some(entry=>entry.kind==='dcode.extension-entry'&&entry.data?.value?.customType==='shutdown-drained'
        &&entry.data.value.data?.reason==='quit'),'allowed shutdown metadata action must be persisted in the original Durable conversation');
    });
  }finally{
    if(childPid){try{await readFile(stoppedFile,'utf8');}catch{try{process.kill(childPid,'SIGKILL');}catch{}}}
    try{await f.dispose();}catch{}
    await rm(f.root,{recursive:true,force:true});
  }
});

await test('session_shutdown 批次不被在途工具的普通 flush 抢走', {timeout:45000}, async()=>{
  const f=await fixture({calls:[['shutdown_scope_gate',{}]],connectMcp:false});
  const extension=join(f.project,'.pi/extensions/shutdown-scope-gate.ts');
  const toolEntered=join(f.root,'shutdown-scope-tool-entered'),releaseTool=join(f.root,'shutdown-scope-release-tool');
  const toolReturned=join(f.root,'shutdown-scope-tool-returned'),shutdownQueued=join(f.root,'shutdown-scope-queued');
  const releaseShutdown=join(f.root,'shutdown-scope-release-event'),metadataWaiting=join(f.root,'shutdown-scope-metadata-waiting');
  const releaseMetadata=join(f.root,'shutdown-scope-release-metadata');
  let closeState='pending';
  const writeRelease=file=>writeFile(file,'release');
  const source=`import {Type} from 'typebox';import {appendFileSync} from 'node:fs';import {readFile} from 'node:fs/promises';
    const waitForFile=async file=>{for(;;){try{await readFile(file);return;}catch(error){if(error?.code!=='ENOENT')throw error;await new Promise(resolve=>setTimeout(resolve,5));}}};
    export default function(pi){
      pi.registerTool({name:'shutdown_scope_gate',label:'shutdown scope gate',description:'Hold the original tool while shutdown queues actions',parameters:Type.Object({}),execute:async()=>{
        appendFileSync(${JSON.stringify(toolEntered)},'entered');await waitForFile(${JSON.stringify(releaseTool)});
        appendFileSync(${JSON.stringify(toolReturned)},'returned');return {content:[{type:'text',text:'original tool returned'}]};
      }});
      pi.on('session_shutdown',async()=>{
        pi.sendUserMessage('SHUTDOWN_SCOPE_REJECTED_INPUT');pi.setSessionName('Shutdown Scope Name');
        appendFileSync(${JSON.stringify(shutdownQueued)},'queued');await waitForFile(${JSON.stringify(releaseShutdown)});
      });
      pi.on('session_info_changed',async event=>{
        if(event.name!=='Shutdown Scope Name')return;
        appendFileSync(${JSON.stringify(metadataWaiting)},'waiting');await waitForFile(${JSON.stringify(releaseMetadata)});
        pi.appendEntry('shutdown-derived-name',{name:event.name});
      });
    }`;
  try{
    await writeFile(extension,source);
    assert.equal((await f.session.submit(f.input)).status,'accepted');
    await until(async()=>{try{await readFile(toolEntered);return true;}catch(error){if(error?.code==='ENOENT')return false;throw error;}});
    const requestCount=f.server.requests.length;
    const closing=f.session.close();
    void closing.then(()=>{closeState='resolved';},()=>{closeState='rejected';});
    await until(async()=>{try{await readFile(shutdownQueued);return true;}catch(error){if(error?.code==='ENOENT')return false;throw error;}});
    await until(async()=>{try{await readFile(metadataWaiting);return true;}catch(error){if(error?.code==='ENOENT')return false;throw error;}});
    await writeRelease(releaseTool);
    await until(async()=>{try{await readFile(toolReturned);return true;}catch(error){if(error?.code==='ENOENT')return false;throw error;}});
    await until(async()=>readonlyStorageCopy(f,async storage=>{
      const tasks=(await storage.scanTasks({conversationId:ROOT_CONVERSATION_ID},200,undefined,context)).items;
      return tasks.some(task=>task.kind===ToolTask.definition.name&&task.input.callId==='actual-tool-1'&&task.state.status==='terminal');
    }));

    // 先允许 shutdown event 返回，但把其 afterCommit 派生事件留在受控 Host 回调中。
    await writeRelease(releaseShutdown);
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal(closeState,'pending','close barrier must wait for the shutdown scope afterCommit callback, even after a tool finally flushes');
    await writeRelease(releaseMetadata);
    await assert.rejects(closing,'the rejected shutdown input remains the close failure after all allowed shutdown actions settle');
    assert.equal(closeState,'rejected');
    assert.equal(f.server.requests.length,requestCount,'closing an in-flight tool must not dispatch another model request');
    await readonlyStorageCopy(f,async storage=>{
      const entries=(await storage.scanEntries({conversationId:ROOT_CONVERSATION_ID},200,undefined,context)).items;
      assert.equal(entries.filter(entry=>entry.kind==='pi.user').length,1);
      assert.ok(!entries.flatMap(entry=>entry.model??[]).some(message=>message.role==='user'&&JSON.stringify(message.content).includes('SHUTDOWN_SCOPE_REJECTED_INPUT')));
      assert.ok(entries.some(entry=>entry.kind==='dcode.extension-entry'&&entry.data?.value?.customType==='shutdown-derived-name'
        &&entry.data.value.data?.name==='Shutdown Scope Name'),'the derived permitted metadata action must settle before shutdown-flushed');
    });
  }finally{
    await Promise.allSettled([writeRelease(releaseTool),writeRelease(releaseShutdown),writeRelease(releaseMetadata)]);
    try{await f.dispose();}catch{}
    await rm(f.root,{recursive:true,force:true});
  }
});

await test('worker 在 JSON 序列化前拒绝 sendUserMessage 的函数值和未知 undefined 选项', {timeout:30000}, async()=>{
  const f=await fixture({calls:[]});
  try{
    await mkdir(join(f.project,'.pi/prompts'),{recursive:true});
    await writeFile(join(f.project,'.pi/prompts/actual.md'),'EXPANDED $ARGUMENTS');
    await writeFile(join(f.project,'.pi/extensions/invalid-send-options.ts'),`export default function(pi){let sent=false;
      pi.on('input',event=>{pi.appendEntry('send-option-input',{source:event.source,mode:event.streamingBehavior});return {action:'transform',text:event.text+' hooked'};});
      pi.on('session_start',()=>{
        if(sent)return;sent=true;
        try{pi.sendUserMessage('MUST_NOT_SEND',{deliverAs:()=> 'steer'});}catch{pi.appendEntry('invalid-send-option-rejected',{kind:'function'});}
        try{pi.sendUserMessage('MUST_NOT_SEND',{expandPromptTemplates:()=>true});}catch{pi.appendEntry('invalid-send-option-rejected',{kind:'function-template'});}
        try{pi.sendUserMessage('MUST_NOT_SEND',{unsupported:undefined});}catch{pi.appendEntry('invalid-send-option-rejected',{kind:'undefined-key'});}
        pi.sendUserMessage('VALID_UNDEFINED_DEFAULTS',{deliverAs:undefined,expandPromptTemplates:undefined});
        const nonEnumerable={};Object.defineProperty(nonEnumerable,'deliverAs',{value:'steer'});Object.defineProperty(nonEnumerable,'expandPromptTemplates',{value:true});
        pi.sendUserMessage('/actual preserved-options',nonEnumerable);
      });
    }`);
    const accepted=await f.session.submit(f.input);assert.equal(accepted.status,'accepted');
    await until(async()=>{const view=await f.session.read();return view.phase==='ready'&&view.entries.filter(e=>e.kind==='pi.user').length===3;});
    const view=await f.session.read();
    const rejected=view.entries.filter(e=>e.data?.value?.customType==='invalid-send-option-rejected');
    assert.deepEqual(rejected.map(e=>e.data.value.data.kind),['function','function-template','undefined-key']);
    const users=view.entries.filter(e=>e.kind==='pi.user');
    assert.equal(users.length,3,'三个非法调用没有进入 Durable 输入或 HTTP');
    assert.equal(f.server.requests.filter(r=>JSON.stringify(r.body.messages).includes('MUST_NOT_SEND')).length,0);
    assert.ok(f.server.requests.some(r=>JSON.stringify(r.body.messages).includes('VALID_UNDEFINED_DEFAULTS')));
    assert.ok(f.server.requests.some(r=>JSON.stringify(r.body.messages).includes('EXPANDED preserved-options hooked')),'合法非枚举模板选项须在 JSON 序列化后保留');
    const modes=view.entries.filter(e=>e.kind==='dcode.extension-entry'&&e.data?.value?.customType==='send-option-input').map(e=>e.data.value.data);
    assert.deepEqual(modes,[{source:'rpc',mode:'followUp'},{source:'extension',mode:'followUp'},{source:'extension',mode:'steer'}]);
    assert.deepEqual(f.server.errors,[]);
  }finally{await f.dispose();}
});

await test('扩展输入查回期间原调用失效与未知 owner 均不能创建新收件', {timeout:30000}, async()=>{
  const f=await fixture({calls:[]});
  try{
    const before=await f.session.read(), controller=new AbortController();let checks=0;
    const canceled={abortSignal:controller.signal,value:()=>undefined,toString:()=> 'extension-cancel-context'};
    const receipt=await f.session.submitExtensionMessage('CANCELED_DURING_LOOKUP',{deliverAs:'followUp',expandPromptTemplates:false},'cancel-before-admission',canceled,{
      isCurrent:()=>{checks+=1;if(checks===2)controller.abort();return !controller.signal.aborted;},
    });
    assert.notEqual(receipt.status,'accepted');assert.ok(checks>=2,'在正式提交前重新核对原调用代次');
    const inactive=await f.session.submitExtensionMessage('TERMINAL_OWNER_MUST_NOT_ADMIT',{deliverAs:'followUp',expandPromptTemplates:false},'terminal-owner',context,{
      ownerTaskId:2147483647,isCurrent:()=>true,
    });
    assert.notEqual(inactive.status,'accepted');
    const after=await f.session.read();assert.equal(after.entries.filter(e=>e.kind==='pi.user').length,before.entries.filter(e=>e.kind==='pi.user').length);
    assert.equal(f.server.requests.length,0,'取消调用或失效 owner 不创建 Durable 输入／模型 HTTP');
  }finally{await f.dispose();}
});

await test('扩展提交后存储丢失 ack 保持 unknown；按原 operation 查回而不重投', {timeout:30000}, async t=>{
  const directory=await mkdtemp(join(tmpdir(),'dcode-extension-lost-ack-'));
  const models=controlledModels();let loseNextCommit=false,abortAfterCommit;
  t.after(async()=>await rm(directory,{recursive:true,force:true}));
  const unit=await PiExecutionSession.open({directory,cwd:directory,target:{workspaceId:'space',taskId:'task',sessionId:'lost-ack'},models:models.models,
    agent:{model:{provider:models.model.provider,modelId:models.model.id}},needsInputPreparation:()=>true,
    prepareInput:async input=>({content:input.content,handled:true}),
    openStorage:async path=>{const storage=await openNodeJsonlStorage(path,context);return new Proxy(storage,{get(target,key){
      if(key==='commit')return async(change,ctx)=>{const value=await target.commit(change,ctx);if(loseNextCommit){loseNextCommit=false;abortAfterCommit?.abort();throw new Error('Durable commit ack lost after settlement');}return value;};
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});},
  });
  try{
    const control=(await unit.read()).control;const actionId='extension-lost-ack';loseNextCommit=true;abortAfterCommit=new AbortController();
    const cancelContext={abortSignal:abortAfterCommit.signal,value:()=>undefined,toString:()=> 'extension-lost-ack-context'};
    const submitted=await unit.submitExtensionMessage('ONCE_ONLY_EXTENSION_INPUT',{deliverAs:'followUp',expandPromptTemplates:false},actionId,cancelContext,{isCurrent:()=>!abortAfterCommit.signal.aborted});
    assert.equal(submitted.status,'unknown','写盘后丢回执不能声称未接收');
    const input={target:unit.target,operationId:`pi-extension/${createHash('sha256').update(actionId).digest('hex')}`,
      text:'ONCE_ONLY_EXTENSION_INPUT',references:[],mode:'follow-up',expected:control};
    const found=await unit.lookupReceipt(input);assert.equal(found.status,'accepted');
    const retry=await unit.submitExtensionMessage('ONCE_ONLY_EXTENSION_INPUT',{deliverAs:'followUp',expandPromptTemplates:false},actionId,context,{isCurrent:()=>true});
    assert.equal(retry.status,'unknown','faulted owner 不重投未知的原 operation');
    assert.equal((await unit.lookupReceipt(input)).submissionId,found.submissionId);
    assert.equal(models.requests.length,0);
  }finally{await unit.close();}
});

await test('原 native inbox 后续同文本输入不能借前次准备标记跳过真实启动', {timeout:30000}, async()=>{
  const f=await fixture({calls:[['native_followup',{}]]});
  try{
    await writeFile(join(f.project,'.pi/extensions/followup.ts'),`import {Type} from 'typebox';export default function(pi){
      pi.on('before_agent_start',event=>{pi.appendEntry('native-input-start',{prompt:event.prompt});});
      pi.registerTool({name:'native_followup',label:'followup',description:'Actual native follow-up',parameters:Type.Object({}),execute:async()=>{
        pi.sendUserMessage(${JSON.stringify(f.input.text)},{deliverAs:'followUp'});return {content:[{type:'text',text:'native follow-up admitted'}]};}});
    }`);
    await f.session.submit(f.input);await until(()=>f.server.requests.length===8);
    await until(async()=>(await f.session.read()).entries.filter(e=>e.data?.value?.customType==='native-input-start').length===2);
    const view=await f.session.read();assert.equal(view.entries.filter(e=>e.kind==='pi.user').length,2);
    const starts=view.entries.filter(e=>e.data?.value?.customType==='native-input-start');
    assert.ok(starts.every(e=>e.data.value.data.prompt===f.input.text));assert.deepEqual(f.server.errors,[]);
  }finally{await f.dispose();}
});

// 资源集合预期由隔离文件字节和当次真实 HTTP 独立确定，不调用产品 formatter 生成 expected。
const resourceWireText = message => typeof message.content === 'string' ? message.content
  : Array.isArray(message.content) ? message.content.filter(part => part?.type === 'text').map(part => part.text).join('\n') : '';
const resourceHeader = request => request.body.messages.filter(message => ['system','developer'].includes(message.role)).map(resourceWireText).join('\n');
const resourceOccurrences = (text, marker) => text.split(marker).length - 1;
async function resourceSkill(project, path, name, description, body) {
  const folder=join(project,path);await mkdir(folder,{recursive:true});
  const content=`---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;
  await writeFile(join(folder,'SKILL.md'),content);return content;
}
async function resourceSubmitDone(f,input) {
  const receipt=await f.session.submit(input);assert.equal(receipt.status,'accepted');
  await until(async()=>(await f.session.lookupReceipt(input)).processing==='done');
  await until(async()=>(await f.session.read()).phase==='ready');return receipt;
}

await test('技能统一集合：启用后同一目录只出现一次；全文经真实read进入紧邻HTTP', {timeout:30000}, async()=>{
  const f=await fixture({calls:[['read',{path:'.pi/skills/checker/SKILL.md'}]]});
  try{
    const description=`SKILL_ONCE_${f.nonce}`,body=`SKILL_BODY_ONLY_AFTER_READ_${f.nonce}`;
    const content=await resourceSkill(f.project,'.pi/skills/checker','checker',description,body);
    await resourceSubmitDone(f,f.input);assert.equal(f.server.requests.length,7);
    const header=resourceHeader(f.server.requests[0]);assert.equal(resourceOccurrences(header,description),1,'基础与Loader不得重复同一已发现技能');
    assert.ok(header.includes('.pi/skills/checker/SKILL.md'));assert.ok(!JSON.stringify(f.server.requests[0].body.messages).includes(body),'技能目录不自动注入全部正文');
    const read=(await f.session.read()).entries.find(entry=>entry.toolResult?.callId==='actual-tool-1')?.toolResult;
    assert.ok(read);assert.equal(read.name,'read');assert.equal(read.isError,false);assert.ok(read.text.includes(content));
    const next=f.server.requests[1];assert.equal(next.ordinal,2);
    const forwarded=next.body.messages.filter(message=>message.role==='tool'&&message.tool_call_id==='actual-tool-1');
    assert.equal(forwarded.length,1);assert.ok(resourceWireText(forwarded[0]).includes(content),'真实技能全文进入紧邻下一模型HTTP');
    assert.ok(f.server.requests.every(request=>request.authOk&&request.body.model===codingModel));assert.deepEqual(f.server.errors,[]);
  }finally{await f.dispose();}
});

await test('技能明确禁用：项目selector对当次唯一集合生效，允许技能仍真实进入HTTP', {timeout:30000}, async()=>{
  const f=await fixture({calls:[],settings:{skills:['-skills/checker/SKILL.md']}});
  try{
    const disabled=`SKILL_DISABLED_${f.nonce}`,allowed=`SKILL_ALLOWED_${f.nonce}`;
    await resourceSkill(f.project,'.pi/skills/checker','checker',disabled,`DISABLED_BODY_${f.nonce}`);
    await resourceSkill(f.project,'.pi/skills/allowed','allowed',allowed,`ALLOWED_BODY_${f.nonce}`);
    await resourceSubmitDone(f,f.input);assert.equal(f.server.requests.length,6);
    const header=resourceHeader(f.server.requests[0]);assert.equal(resourceOccurrences(header,allowed),1);assert.equal(resourceOccurrences(header,disabled),0);
    assert.ok(!header.includes('.pi/skills/checker/SKILL.md'),'被明确禁用的路径不能由基础集合加回');
    assert.ok(f.server.requests.every(request=>!JSON.stringify(request.body.messages).includes(disabled)));assert.deepEqual(f.server.errors,[]);
  }finally{await f.dispose();}
});

await test('普通技能idle刷新：仅改description，查回不加载；下一原会话真实HTTP采用新目录', {timeout:30000}, async()=>{
  const f=await fixture({calls:[]});
  try{
    const first=`SKILL_DESCRIPTION_FIRST_${f.nonce}`,second=`SKILL_DESCRIPTION_SECOND_${f.nonce}`,body=`UNCHANGED_SKILL_BODY_${f.nonce}`;
    await resourceSkill(f.project,'.pi/skills/checker','checker',first,body);
    const original=await resourceSubmitDone(f,f.input);assert.equal(f.server.requests.length,6);
    assert.equal(resourceOccurrences(resourceHeader(f.server.requests[0]),first),1);
    const starts=(await f.events()).filter(event=>event.type==='start').length;
    // 只改普通技能，不改包、扩展、settings或mcp：防止其他指纹变化掩盖漏刷新。
    await resourceSkill(f.project,'.pi/skills/checker','checker',second,body);
    const found=await f.session.lookupReceipt(f.input);assert.equal(found.submissionId,original.submissionId);assert.equal(found.processing,'done');await f.session.read();
    assert.equal(f.server.requests.length,6);assert.equal((await f.events()).filter(event=>event.type==='start').length,starts,'查回与读取不是资源刷新或执行');
    const next={...f.input,operationId:`skill-refresh-${f.nonce}`,text:'采用已修改技能目录的实际新输入',expected:(await f.session.read()).control};
    await resourceSubmitDone(f,next);assert.equal(f.server.requests.length,7);
    const header=resourceHeader(f.server.requests[6]);assert.equal(resourceOccurrences(header,second),1);assert.equal(resourceOccurrences(header,first),0);
    assert.ok(!header.includes(body));assert.equal(resourceOccurrences(resourceHeader(f.server.requests[0]),first),1,'既有请求证据不被新目录改写');assert.deepEqual(f.server.errors,[]);
  }finally{await f.dispose();}
});

await test('项目本地能力包：实际 manifest/filter 与 .pi 相对路径、默认工具选择及 idle 配置刷新；不用新包格式', {timeout:30000}, async()=>{
  const f=await fixture({calls:[['package_tool',{}]],subsequentCalls:[['package_tool',{}]],settings:{packages:[{source:'./package',extensions:['+first.ts','-hidden.ts'],skills:[],prompts:[]}],defaultTools:['read','bash','edit','write','package_tool']}});
  try {
    const pkg=join(f.project,'.pi/package');await mkdir(pkg,{recursive:true});
    await writeFile(join(pkg,'package.json'),JSON.stringify({name:'owned-local',pi:{extensions:['first.ts','hidden.ts']}}));
    await writeFile(join(pkg,'first.ts'),`import {Type} from 'typebox';export default function(pi){pi.registerTool({name:'package_tool',label:'package',description:'real package',parameters:Type.Object({}),execute:async()=>({content:[{type:'text',text:'PACKAGE_FIRST'}]})});}`);
    await writeFile(join(pkg,'hidden.ts'),`throw new Error('filtered extension must not load');`);
    assert.equal((await f.session.submit(f.input)).status,'accepted');await until(async()=>(await f.session.lookupReceipt(f.input)).processing==='done');
    assert.ok(f.server.requests[0].body.tools.some(t=>t.function.name==='package_tool'));
    assert.ok(!f.server.requests[0].body.tools.some(t=>t.function.name==='grep'));
    assert.ok((await f.session.read()).entries.some(e=>e.toolResult?.text==='PACKAGE_FIRST'));
    const starts=(await f.events()).filter(e=>e.type==='start').length;
    await writeFile(join(pkg,'first.ts'),`import {Type} from 'typebox';export default function(pi){pi.registerTool({name:'package_tool',label:'package',description:'changed package',parameters:Type.Object({}),execute:async()=>({content:[{type:'text',text:'PACKAGE_SECOND'}]})});}`);
    // 已完成输入查回不加载新文件或启动连接；新配置留待下一次实际输入。
    await f.session.lookupReceipt(f.input); assert.equal((await f.events()).filter(e=>e.type==='start').length,starts);
    const next={...f.input,operationId:'package-next-actual-input',text:'配置刷新后的真实输入',expected:(await f.session.read()).control};
    assert.equal((await f.session.submit(next)).status,'accepted');await until(async()=>(await f.session.lookupReceipt(next)).processing==='done');
    assert.ok((await f.session.read()).entries.some(e=>e.toolResult?.text==='PACKAGE_SECOND'));
    assert.ok(f.server.requests[7].body.tools.some(t=>t.function.name==='package_tool'&&t.function.description==='changed package'));
    assert.ok(f.server.requests[8].body.messages.some(m=>m.role==='tool'&&m.content==='PACKAGE_SECOND'));assert.deepEqual(f.server.errors,[]);
  }finally{await f.dispose();}
});

// 后补资产使用 Root-resource-consistency-tests 的共用资源观察/写入助手；仍复用原 fixture。
await test('本地包skills/prompts：精确selector、真实全文read、模板正文与idle更新进入原会话HTTP', {timeout:30000}, async()=>{
  const f=await fixture({calls:[['read',{path:'.pi/package/skills/visible/SKILL.md'}]],settings:{packages:[{
    source:'./package',extensions:[],skills:['skills/visible/SKILL.md','-skills/hidden/SKILL.md'],
    prompts:['prompts/pkg-note.md','-prompts/hidden.md'],
  }]}});
  try{
    const pkg=join(f.project,'.pi/package');await mkdir(join(pkg,'prompts'),{recursive:true});
    await writeFile(join(pkg,'package.json'),JSON.stringify({name:'owned-local-resources',pi:{extensions:[],
      skills:['skills/visible/SKILL.md','skills/hidden/SKILL.md'],prompts:['prompts/pkg-note.md','prompts/hidden.md'],
    }}));
    const visible=`PACKAGE_SKILL_VISIBLE_${f.nonce}`,hidden=`PACKAGE_SKILL_HIDDEN_${f.nonce}`,body=`PACKAGE_SKILL_BODY_${f.nonce}`;
    const content=await resourceSkill(f.project,'.pi/package/skills/visible','visible',visible,body);
    await resourceSkill(f.project,'.pi/package/skills/hidden','hidden',hidden,`PACKAGE_HIDDEN_BODY_${f.nonce}`);
    await writeFile(join(pkg,'prompts/pkg-note.md'),`PACKAGE_PROMPT_FIRST_${f.nonce} $1 | $@\n`);
    await writeFile(join(pkg,'prompts/hidden.md'),`PACKAGE_PROMPT_HIDDEN_${f.nonce} $1\n`);
    const original={...f.input,text:'/pkg-note "alpha beta" gamma'};const receipt=await resourceSubmitDone(f,original);
    assert.equal(f.server.requests.length,7);const first=f.server.requests[0],header=resourceHeader(first);
    assert.equal(resourceOccurrences(header,visible),1);assert.equal(resourceOccurrences(header,hidden),0);
    assert.ok(!header.includes('package/skills/hidden/SKILL.md'));assert.ok(!JSON.stringify(first.body.messages).includes(body));
    const latestUser=request=>resourceWireText(request.body.messages.filter(message=>message.role==='user').at(-1));
    assert.equal(latestUser(first),`PACKAGE_PROMPT_FIRST_${f.nonce} alpha beta | alpha beta gamma\n`);
    const read=(await f.session.read()).entries.find(entry=>entry.toolResult?.callId==='actual-tool-1')?.toolResult;
    assert.ok(read);assert.equal(read.name,'read');assert.equal(read.isError,false);assert.ok(read.text.includes(content));
    const nextHttp=f.server.requests[1];assert.equal(nextHttp.ordinal,2);
    const forwarded=nextHttp.body.messages.filter(message=>message.role==='tool'&&message.tool_call_id==='actual-tool-1');
    assert.equal(forwarded.length,1);assert.ok(resourceWireText(forwarded[0]).includes(content),'被选中的包技能全文由实际read贡献到紧邻请求');
    const starts=(await f.events()).filter(event=>event.type==='start').length;
    await writeFile(join(pkg,'prompts/pkg-note.md'),`PACKAGE_PROMPT_SECOND_${f.nonce} $1 | $@\n`);
    const found=await f.session.lookupReceipt(original);assert.equal(found.submissionId,receipt.submissionId);assert.equal(found.processing,'done');await f.session.read();
    assert.equal(f.server.requests.length,7);assert.equal((await f.events()).filter(event=>event.type==='start').length,starts,'只读查回不会加载修改后的包');
    const next={...f.input,operationId:`package-prompt-next-${f.nonce}`,text:'/pkg-note "next value" delta',expected:(await f.session.read()).control};
    await resourceSubmitDone(f,next);assert.equal(f.server.requests.length,8);
    assert.equal(latestUser(f.server.requests[7]),`PACKAGE_PROMPT_SECOND_${f.nonce} next value | next value delta\n`);
    assert.equal(latestUser(first),`PACKAGE_PROMPT_FIRST_${f.nonce} alpha beta | alpha beta gamma\n`,'原输入证据不被模板变更改写');
    const excluded={...f.input,operationId:`package-filtered-prompt-${f.nonce}`,text:`/hidden ${f.nonce}`,expected:(await f.session.read()).control};
    await resourceSubmitDone(f,excluded);assert.equal(f.server.requests.length,9);
    assert.equal(latestUser(f.server.requests[8]),excluded.text,'被过滤模板按未知命令保普通原文，不能暗中展开');
    assert.ok(!JSON.stringify(f.server.requests[8].body.messages).includes(`PACKAGE_PROMPT_HIDDEN_${f.nonce}`));
    assert.equal((await f.session.read()).entries.filter(entry=>entry.toolResult?.callId==='actual-tool-1').length,1,'后续输入不重放完成的技能read');
    assert.ok(f.server.requests.every(request=>request.authOk&&request.body.model===codingModel));assert.deepEqual(f.server.errors,[]);
  }finally{await f.dispose();}
});

await test('扩展发现的技能与模板：真实目录及按需正文由同一Loader消费并可idle刷新', {timeout:30000}, async()=>{
  const f=await fixture({calls:[['read',{path:'.pi/resources/discovered/SKILL.md'}]]});
  try {
    const description='DISCOVERED_SKILL_'+f.nonce,body='DISCOVERED_BODY_'+f.nonce;
    const content=await resourceSkill(f.project,'.pi/resources/discovered','discovered',description,body);
    await writeFile(join(f.project,'.pi/resources/discovered-note.md'),'DISCOVERED_PROMPT_FIRST_'+f.nonce+' $1');
    await writeFile(join(f.project,'.pi/extensions/discover.ts'),`export default function(pi){pi.on('resources_discover',()=>({skillPaths:['../resources/discovered'],promptPaths:['../resources/discovered-note.md']}));}`);
    const original={...f.input,text:'/discovered-note value'};await resourceSubmitDone(f,original);
    assert.equal(resourceOccurrences(resourceHeader(f.server.requests[0]),description),1);
    assert.ok(!JSON.stringify(f.server.requests[0].body.messages).includes(body));
    assert.equal(resourceWireText(f.server.requests[0].body.messages.filter(m=>m.role==='user').at(-1)),'DISCOVERED_PROMPT_FIRST_'+f.nonce+' value');
    assert.ok(f.server.requests[1].body.messages.some(m=>m.role==='tool'&&m.tool_call_id==='actual-tool-1'&&resourceWireText(m).includes(content)));
    const count=f.server.requests.length,starts=(await f.events()).filter(e=>e.type==='start').length;
    await writeFile(join(f.project,'.pi/resources/discovered-note.md'),'DISCOVERED_PROMPT_SECOND_'+f.nonce+' $1');
    await f.session.lookupReceipt(original);await f.session.read();assert.equal(f.server.requests.length,count);assert.equal((await f.events()).filter(e=>e.type==='start').length,starts);
    const next={...f.input,operationId:'discovered-refresh-'+f.nonce,text:'/discovered-note next',expected:(await f.session.read()).control};await resourceSubmitDone(f,next);
    assert.equal(resourceWireText(f.server.requests[count].body.messages.filter(m=>m.role==='user').at(-1)),'DISCOVERED_PROMPT_SECOND_'+f.nonce+' next');
    assert.deepEqual(f.server.errors,[]);
  }finally{await f.dispose();}
});

await test('扩展发现路径越界：正式准备拒绝，不发送模型也不把外部技能当作已加载', {timeout:30000}, async()=>{
  const f=await fixture({calls:[]});
  try {
    await resourceSkill(f.root,'outside-skill','outside','OUTSIDE_DISCOVERY_'+f.nonce,'outside owned canary');
    await writeFile(join(f.project,'.pi/extensions/discover.ts'),`export default function(pi){pi.on('resources_discover',()=>({skillPaths:[${JSON.stringify(join(f.root,'outside-skill'))}]}));}`);
    const sent=await f.session.submit(f.input);assert.equal(sent.status,'accepted');
    await until(async()=>(await f.session.lookupReceipt(f.input)).processing==='unanswered');
    assert.equal(f.server.requests.length,0);assert.ok((await f.session.read()).entries.some(e=>e.kind==='dcode.preparation-error'));
    assert.equal((await f.session.lookupReceipt(f.input)).submissionId,sent.submissionId);
  }finally{await f.dispose();}
});

await test('扩展开启后的应用模板优先：项目同名模板不改变已确认首次定义顺序', {timeout:30000}, async()=>{
  const f=await fixture({calls:[]});
  try {
    const app=join(f.stateDir,'coding-resources/prompts'),project=join(f.project,'.pi/prompts');await mkdir(app,{recursive:true});await mkdir(project,{recursive:true});
    await writeFile(join(app,'same.md'),'APP_TEMPLATE_'+f.nonce+' $1');await writeFile(join(project,'same.md'),'PROJECT_TEMPLATE_'+f.nonce+' $1');
    await resourceSubmitDone(f,{...f.input,text:'/same value'});
    assert.equal(resourceWireText(f.server.requests[0].body.messages.filter(m=>m.role==='user').at(-1)),'APP_TEMPLATE_'+f.nonce+' value');
    assert.deepEqual(f.server.errors,[]);
  }finally{await f.dispose();}
});

await test('被明确选中的包SKILL无description：保原接收、准备失败零HTTP；修复只供新输入且旧身份不重处理', {timeout:30000}, async()=>{
  const f=await fixture({calls:[],settings:{packages:[{source:'./package',extensions:[],skills:['skills/bad/SKILL.md'],prompts:[]}]}});
  try{
    const pkg=join(f.project,'.pi/package');await mkdir(join(pkg,'skills/bad'),{recursive:true});
    await writeFile(join(pkg,'package.json'),JSON.stringify({name:'owned-invalid-skill',pi:{extensions:[],skills:['skills/bad/SKILL.md'],prompts:[]}}));
    await writeFile(join(pkg,'skills/bad/SKILL.md'),`---\nname: bad\n---\nDECLARED_SKILL_MISSING_DESCRIPTION_${f.nonce}\n`);
    const receipt=await f.session.submit(f.input);assert.equal(receipt.status,'accepted','启用扩展仍沿原正式接收后准备，不丢接收身份');
    await until(async()=>(await f.session.lookupReceipt(f.input)).processing==='unanswered');
    const view=await f.session.read();assert.ok(view.entries.some(entry=>entry.kind==='dcode.preparation-error'));assert.equal(f.server.requests.length,0,'不能丢掉已选择的非法SKILL后空载执行');
    const retried=await f.session.submit(f.input);assert.equal(retried.submissionId,receipt.submissionId);assert.equal(retried.processing,'unanswered');assert.equal(f.server.requests.length,0);
    const description=`REPAIRED_PACKAGE_SKILL_${f.nonce}`;await resourceSkill(f.project,'.pi/package/skills/bad','bad',description,'Owned repaired skill body.');
    const found=await f.session.lookupReceipt(f.input);assert.equal(found.submissionId,receipt.submissionId);assert.equal(found.processing,'unanswered');await f.session.read();assert.equal(f.server.requests.length,0,'修复文件和只读查回不自动重处理原已接收输入');
    const next={...f.input,operationId:`package-skill-repaired-${f.nonce}`,text:'原会话的新实际工作输入',expected:(await f.session.read()).control};
    await resourceSubmitDone(f,next);assert.equal(f.server.requests.length,6);
    assert.equal(resourceOccurrences(resourceHeader(f.server.requests[0]),description),1);assert.deepEqual(f.server.errors,[]);
  }finally{await f.dispose();}
});

for (const source of ['settings', 'discover', 'package']) for (const invalid of ['no-description', 'bad-frontmatter']) {
  await test(`明确选择普通md技能 ${source}/${invalid}：准备失败保原回执、零HTTP，不静默丢声明`, {timeout:30000}, async()=>{
    const settings=source==='settings'?{skills:['./selected.md']}:source==='package'?{packages:[{source:'./package',extensions:[],skills:['selected.md'],prompts:[]}]}:undefined;
    const f=await fixture({calls:[],settings});
    try{
      const file=source==='package'?join(f.project,'.pi/package/selected.md'):join(f.project,'.pi/selected.md');await mkdir(resolve(file,'..'),{recursive:true});
      if(source==='package')await writeFile(join(f.project,'.pi/package/package.json'),JSON.stringify({name:'owned-selected-md',pi:{extensions:[],skills:['selected.md'],prompts:[]}}));
      if(source==='discover')await writeFile(join(f.project,'.pi/extensions/selected.ts'),`export default function(pi){pi.on('resources_discover',()=>({skillPaths:['../selected.md']}));}`);
      await writeFile(file,invalid==='no-description'?`---\nname: selected-md\n---\nDECLARED_MD_${f.nonce}`:`---\nname: selected-md\ndescription: [not closed\n---\nDECLARED_MD_${f.nonce}`);
      const accepted=await f.session.submit(f.input);assert.equal(accepted.status,'accepted');
      await until(async()=>['done','unanswered'].includes((await f.session.lookupReceipt(f.input)).processing));
      const receipt=await f.session.lookupReceipt(f.input);assert.equal(receipt.processing,'unanswered','明确选择的非法md不能空载执行');assert.equal(f.server.requests.length,0);
      assert.ok((await f.session.read()).entries.some(entry=>entry.kind==='dcode.preparation-error'));assert.equal(receipt.submissionId,accepted.submissionId);
      const retried=await f.session.submit(f.input);assert.equal(retried.submissionId,accepted.submissionId);assert.equal(retried.processing,'unanswered');assert.equal(f.server.requests.length,0);
    }finally{await f.dispose();}
  });
}

for(const selected of ['valid','excluded-invalid','empty','directory'])await test(`普通md声明合法边界 ${selected}：原完整请求成立，不把负筛选或合法空集合当失败`,{timeout:30000},async()=>{
  const f=await fixture({calls:[],settings:{skills:selected==='empty'?[]:selected==='directory'?['./skills']:selected==='valid'?['./selected.md']:['./selected.md','!./selected.md']}});
  try{
    const desc='VALID_DIRECT_MD_'+f.nonce;
    if(selected!=='empty')await writeFile(join(f.project,'.pi/selected.md'),selected==='valid'?`---\nname: direct-md\ndescription: ${desc}\n---\nOwned direct skill.`:'ordinary documentation without skill description');
    // 自动发现的普通文档不是声明技能；不得因为本轮严格接收而拒绝整个合法目录。
    await mkdir(join(f.project,'.pi/skills'),{recursive:true});await writeFile(join(f.project,'.pi/skills/README.md'),'ordinary automatically discovered documentation');
    await resourceSubmitDone(f,f.input);assert.equal(f.server.requests.length,6);assert.deepEqual(f.server.errors,[]);
    assert.equal(resourceOccurrences(resourceHeader(f.server.requests[0]),desc),selected==='valid'?1:0);
  }finally{await f.dispose();}
});

await test('显式包普通md：保Pi合法BOM清单和官方过滤，不校验已排除坏文件', {timeout:30000},async()=>{
  const f=await fixture({calls:[],settings:{packages:[{source:'./package',extensions:[],skills:['selected.md'],prompts:[]}]}});
  try{
    const pkg=join(f.project,'.pi/package');await mkdir(pkg,{recursive:true});const desc='BOM_SELECTED_MD_'+f.nonce;
    await writeFile(join(pkg,'package.json'),'\uFEFF'+JSON.stringify({name:'owned-bom-selected-md',pi:{extensions:[],skills:['selected.md','ignored.md'],prompts:[]}}));
    await writeFile(join(pkg,'selected.md'),`---\nname: package-direct\ndescription: ${desc}\n---\nOwned selected skill.`);await writeFile(join(pkg,'ignored.md'),'excluded document without description');
    const accepted=await f.session.submit(f.input);assert.equal(accepted.status,'accepted');await until(async()=>['done','unanswered'].includes((await f.session.lookupReceipt(f.input)).processing));
    assert.equal((await f.session.lookupReceipt(f.input)).processing,'done','声明预审不能拒绝原Pi已支持的合法包格式');assert.equal(f.server.requests.length,6);
    assert.equal(resourceOccurrences(resourceHeader(f.server.requests[0]),desc),1);assert.deepEqual(f.server.errors,[]);
  }finally{await f.dispose();}
});

for(const spelling of ['actual','alias'])await test(`扩展发现应用根 ${spelling}：同一已核授权目录含一次技能，保持正文按需`,{timeout:30000},async()=>{
  const f=await fixture({calls:[]});
  try{
    const app=join(f.stateDir,'coding-resources'),dir=join(app,'owned-discovered');await mkdir(dir,{recursive:true});const description='APP_DISCOVERY_'+f.nonce;
    await writeFile(join(dir,'SKILL.md'),`---\nname: app-discovered\ndescription: ${description}\n---\nAPP_DISCOVERY_BODY_${f.nonce}`);
    const selected=spelling==='actual'?await realpath(dir):dir;
    await writeFile(join(f.project,'.pi/extensions/app-discover.ts'),`export default function(pi){pi.on('resources_discover',()=>({skillPaths:[${JSON.stringify(selected)}]}));}`);
    const accepted=await f.session.submit(f.input);assert.equal(accepted.status,'accepted');await until(async()=>['done','unanswered'].includes((await f.session.lookupReceipt(f.input)).processing));
    assert.equal((await f.session.lookupReceipt(f.input)).processing,'done','真实appRoot和原词法别名必须承接同一授权根');assert.equal(f.server.requests.length,6);
    assert.equal(resourceOccurrences(resourceHeader(f.server.requests[0]),description),1);assert.ok(!JSON.stringify(f.server.requests[0].body).includes('APP_DISCOVERY_BODY_'));assert.deepEqual(f.server.errors,[]);
  }finally{await f.dispose();}
});

await test('普通 HTTP MCP：资源目录／模板／真实正文、业务错误和副作用进入下一 SDK HTTP；关闭 DELETE 与只读重开', {timeout:45000}, async()=>{
  const f=await fixture({http:true,holdFinal:true,calls:nonce=>[
    ['list_mcp_resources',{server:'fixture'}],['list_mcp_resource_templates',{server:'fixture'}],
    ['read_mcp_resource',{server:'fixture',uri:`fixture://${nonce}/input`}],
    ['read_mcp_resource',{server:'fixture',uri:'file:///outside-authorized-resource'}],
    ['mcp__fixture__append_once',{token:'http_once',text:nonce}],['mcp__fixture__fail',{token:'expected'}],
  ]});let session=f.session;
  try{
    const receipt=await session.submit(f.input);assert.equal(receipt.status,'accepted');await until(()=>f.server.requests.length===12);
    const view=await session.read();const read=view.entries.find(e=>e.toolResult?.name==='read_mcp_resource'&&!e.toolResult.isError)?.toolResult;
    const directory=view.entries.find(e=>e.toolResult?.name==='list_mcp_resources')?.toolResult;
    assert.ok(directory);assert.equal(directory.isError,false);
    assert.deepEqual(JSON.parse(directory.text),{server:'fixture',resources:[{
      server:'fixture',uri:`fixture://${f.nonce}/input`,name:'fixture input',mimeType:'text/plain',
    }]},'正式目录结果须保本轮真实 URI、资源名及类型');
    const templates=view.entries.find(e=>e.toolResult?.name==='list_mcp_resource_templates')?.toolResult;
    assert.ok(templates);assert.equal(templates.isError,false);
    assert.deepEqual(JSON.parse(templates.text),{server:'fixture',resourceTemplates:[{
      server:'fixture',uriTemplate:`fixture://${f.nonce}/files/{name}`,name:'owned fixture files',mimeType:'text/plain',
    }]},'正式模板结果须保服务端实际模板字段');
    assert.ok(read.text.includes(`actual MCP input ${f.nonce}`));assert.ok(f.server.requests[3].body.messages.some(m=>m.role==='tool'&&m.content.includes(f.nonce)));
    assert.ok(view.entries.some(e=>e.toolResult?.name==='read_mcp_resource'&&e.toolResult.isError));
    assert.equal((await f.events()).filter(e=>e.type==='resource.read'&&e.ownURI===false).length,1);
    const failure=view.entries.find(e=>e.toolResult?.name==='mcp__fixture__fail')?.toolResult;
    assert.ok(failure);assert.equal(failure.isError,true);
    assert.deepEqual(JSON.parse(failure.text),{nonce:f.nonce,kind:'expected-tool-error',token:'expected'},'实际 MCP 业务错误不能转成成功或丢失本次正文');
    // 固定场景第 6 次响应调用 fail；第 7 个真实模型请求必须紧邻消费它的结果。
    const preceding=f.server.requests[5],next=f.server.requests[6];assert.ok(preceding&&next);
    assert.equal(preceding.ordinal,6);assert.equal(next.ordinal,7);assert.equal(next.authOk,true);assert.equal(next.body.model,codingModel);
    assert.equal(preceding.body.messages.filter(message=>message.role==='tool'&&message.tool_call_id==='actual-tool-6').length,0);
    const forwarded=next.body.messages.filter(message=>message.role==='tool'&&message.tool_call_id==='actual-tool-6');
    assert.equal(forwarded.length,1,'紧邻下一 HTTP 须包含原 fail 调用的唯一正式工具结果');
    assert.equal(typeof forwarded[0].content,'string');assert.ok(forwarded[0].content.includes(f.nonce));
    assert.match(forwarded[0].content,/expected-tool-error/);assert.match(forwarded[0].content,/"token"\s*:\s*"expected"/);
    assert.ok((await f.events()).some(e=>e.type==='get.unsupported'));
    await session.pause();await session.close();const closed=await f.events();
    assert.ok(closed.some(e=>e.type==='delete.received'));assert.ok(closed.some(e=>e.type==='session.drained'&&e.reason==='DELETE'&&e.pending===0));
    await until(async()=>(await f.events()).some(e=>e.type==='socket.closed'));
    const initialized=(await f.events()).filter(e=>e.type==='initialize').length;
    session=await f.backend.open({...f.opening,initialize:false});const restored=await session.read();
    assert.equal((await session.lookupReceipt(f.input)).submissionId,receipt.submissionId);assert.equal(f.server.requests.length,12);
    assert.equal((await f.events()).filter(e=>e.type==='initialize').length,initialized);
    f.server.releaseFinal();await session.resume(restored.control);await until(async()=>(await session.lookupReceipt(f.input)).processing==='done');
    assert.equal((await f.events()).filter(e=>e.type==='call.start'&&e.tool==='append_once').length,1);
    assert.deepEqual(JSON.parse((await readFile(join(f.project,'effects.jsonl'),'utf8')).trim()),{nonce:f.nonce,token:'http_once',text:f.nonce});assert.deepEqual(f.server.errors,[]);
  }finally{await session.close();await f.dispose();}
});

for(const closing of ['pause','close'])await test(`HTTP MCP 在途 ${closing}：同 requestId 实际取消与 DELETE drain，继续不重放`, {timeout:30000}, async()=>{
  const f=await fixture({http:true,calls:[['mcp__fixture__wait',{token:'http_parked'}]]});let session=f.session;
  try{await session.submit(f.input);await until(async()=>(await f.events()).some(e=>e.type==='wait.pending'));const parked=(await f.events()).find(e=>e.type==='wait.pending');
    if(closing==='pause')await session.pause();else await session.close();const closed=await f.events();assert.ok(closed.some(e=>e.type==='cancel.received'&&e.matched&&e.requestId===parked.requestId));
    assert.ok(closed.some(e=>e.type==='call.cancelled'&&e.requestId===parked.requestId));assert.ok(closed.some(e=>e.type==='session.drained'&&e.pending===0));assert.equal(f.server.requests.length,1);
    await session.close();session=await f.backend.open({...f.opening,initialize:false});const restored=await session.read();assert.equal(restored.phase,'paused');assert.equal(f.server.requests.length,1);
    const count=(await f.events()).filter(e=>e.type==='initialize').length;await session.lookupReceipt(f.input);assert.equal((await f.events()).filter(e=>e.type==='initialize').length,count);
    await session.resume(restored.control);await until(async()=>(await session.lookupReceipt(f.input)).processing==='done');assert.equal((await f.events()).filter(e=>e.type==='call.start'&&e.tool==='wait').length,1);
  }finally{await session.close();await f.dispose();}
});

await test('两次扩展输入按同一 Durable 准备 task 串行；合法外部前缀身份不隐藏回执，处理不造模型请求', {timeout:30000}, async()=>{
  const f=await fixture({calls:[]});try{
    await writeFile(join(f.project,'.pi/extensions/order.ts'),`import {appendFile,readFile} from 'node:fs/promises';import {watch} from 'node:fs';import {join} from 'node:path';
      export default function(pi){pi.on('input',async(event,ctx)=>{
        await appendFile(join(ctx.cwd,'input-order.jsonl'),JSON.stringify({phase:'start',text:event.text})+'\\n');
        if(event.text==='first')await new Promise((resolve,reject)=>{const signal=ctx.signal;let settled=false;const end=error=>{if(settled)return;settled=true;watcher.close();signal.removeEventListener('abort',abort);if(error)reject(error);else resolve();};const abort=()=>end(new Error('aborted'));const check=()=>readFile(join(ctx.cwd,'release-input'),'utf8').then(()=>end(),()=>{});const watcher=watch(ctx.cwd,()=>void check());signal.addEventListener('abort',abort,{once:true});void check();});
        await appendFile(join(ctx.cwd,'input-order.jsonl'),JSON.stringify({phase:'end',text:event.text})+'\\n');return {action:'handled'};
      });}`);
    const first={...f.input,text:'first'},second={...f.input,operationId:'dcode.processed-input/legal-external',text:'second'};
    const a=await f.session.submit(first);await until(()=>readFile(join(f.project,'input-order.jsonl'),'utf8').then(s=>s.includes('first'),()=>false));const b=await f.session.submit(second);
    assert.equal(a.status,'accepted');assert.equal(b.status,'accepted');assert.notEqual(a.submissionId,b.submissionId);assert.equal((await f.session.read()).pendingInputs,2);
    await readonlyStorageCopy(f,async storage=>{const tasks=(await storage.scanTasks({conversationId:ROOT_CONVERSATION_ID},200,undefined,context)).items;
      assert.ok(tasks.some(t=>t.kind==='dcode.input-preparation'&&t.input.requestId===second.operationId&&t.input.previousTaskId!==undefined&&t.state.checkpoint.phase==='previous'));
    });
    assert.deepEqual((await readFile(join(f.project,'input-order.jsonl'),'utf8')).trim().split('\n').map(JSON.parse),[{phase:'start',text:'first'}]);
    await writeFile(join(f.project,'release-input'),'released');await until(async()=>(await f.session.lookupReceipt(second)).processing==='done');
    assert.deepEqual((await readFile(join(f.project,'input-order.jsonl'),'utf8')).trim().split('\n').map(JSON.parse),[{phase:'start',text:'first'},{phase:'end',text:'first'},{phase:'start',text:'second'},{phase:'end',text:'second'}]);
    assert.equal((await f.session.lookupReceipt(first)).processing,'done');assert.equal((await f.session.read()).pendingInputs,0);assert.equal(f.server.requests.length,0);
  }finally{await f.dispose();}
});

const argumentExtension=`import {Type} from 'typebox';import {writeFile} from 'node:fs/promises';import {join} from 'node:path';
export default function(pi){pi.registerTool({name:'prepared_tool',label:'prepared',description:'Actual synchronous pure preparation',parameters:Type.Object({items:Type.Array(Type.String())}),
 prepareArguments(args){if(args.items==='bad-prepared')return {...args,items:[{unexpected:true}]};if(args.items==='coercible')return {...args,items:[3]};if(args.items==='throws')throw new Error('Expected prepare failure');return {...args,items:typeof args.items==='string'?JSON.parse(args.items):args.items};},
 async execute(id,args,signal,update,ctx){await writeFile(join(ctx.cwd,'prepared-effect.json'),JSON.stringify({id,items:args.items}));return {content:[{type:'text',text:'PREPARED '+args.items.join(',')}]};}});}`;

const actualPng='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=';
await test('原公开 read 图片仍保合法正式结果与可读会话；未知 vision 不冒称请求已发出',{timeout:30000},async()=>{
  const f=await fixture({calls:[['read',{path:'actual.png'}]]});try{
    await writeFile(join(f.project,'actual.png'),Buffer.from(actualPng,'base64'));await f.session.submit(f.input);
    await until(async()=>['done','unanswered'].includes((await f.session.lookupReceipt(f.input)).processing));
    const view=await f.session.read(),result=view.entries.find(e=>e.toolResult?.name==='read')?.toolResult;assert.ok(result);assert.equal(result.isError,false,result.text);
    assert.equal(result.images.length,1);assert.equal(result.images[0].mimeType,'image/png');assert.ok(result.images[0].data.length>0);assert.equal(result.images[0].data.length%4,0);
    assert.equal(f.server.requests.length,1);assert.deepEqual(f.server.errors,[]);
  }finally{await f.dispose();}
});
for(const [name,images] of [['empty',[{type:'image',mimeType:'image/png',data:''}]],['unaligned',[{type:'image',mimeType:'image/png',data:'a'}]],['too-many',Array.from({length:5},()=>({type:'image',mimeType:'image/png',data:actualPng}))],['valid',[{type:'image',mimeType:'image/png',data:actualPng}]]])await test(`扩展图片 ${name} 在正式结果前统一接收；原会话可读及后续输入仍正常`,{timeout:30000},async()=>{
  const f=await fixture({calls:[['image_result',{}]]});try{
    await writeFile(join(f.project,'.pi/extensions/image.ts'),`import {Type} from 'typebox';export default function(pi){pi.registerTool({name:'image_result',label:'image',description:'Actual image tool result',parameters:Type.Object({}),execute:async()=>({content:[{type:'text',text:'IMAGE_TEXT_RETAINED'},...${JSON.stringify(images)}]})});}`);
    assert.equal((await f.session.submit(f.input)).status,'accepted');
    try{await until(async()=>['done','unanswered'].includes((await f.session.lookupReceipt(f.input)).processing));}catch(error){
      await readonlyStorageCopy(f,async storage=>{
        const entries=(await storage.scanEntries({conversationId:ROOT_CONVERSATION_ID},200,undefined,context)).items;
        await writeFile(join(evidenceDir('ordinary-extension-runtime'),`image-${name}-failure.json`),JSON.stringify({receipt:await f.session.lookupReceipt(f.input),requests:f.server.requests.map(r=>({ordinal:r.ordinal,authOk:r.authOk})),entries:entries.map(e=>({kind:e.kind,messages:(e.model??[]).map(m=>({role:m.role,...(m.role==='toolResult'?{name:m.toolName,isError:m.isError,content:m.content.map(p=>p.type==='image'?{type:p.type,length:p.data.length,mimeType:p.mimeType}:p)}:{})}))}))},null,2));
      });throw error;
    }
    const view=await f.session.read(),result=view.entries.find(e=>e.toolResult?.name==='image_result')?.toolResult;assert.ok(result);
    assert.equal(result.isError,name!=='valid');
    if(name==='valid'){assert.equal(result.text,'IMAGE_TEXT_RETAINED');assert.deepEqual(result.images,images);}else{assert.ok(result.text.length>0);assert.equal(result.images,undefined);}
    if(name==='valid'){
      // 自定义受控模型没有已核 vision 能力；合法图像保留，原能力准入有限拒绝，不借对照放宽模型条件。
      assert.equal((await f.session.lookupReceipt(f.input)).processing,'unanswered');assert.equal(f.server.requests.length,1);
    }else assert.ok(f.server.requests[1].body.messages.some(m=>m.role==='tool'&&m.content.length>0));
    const next={...f.input,operationId:`after-image-${name}`,text:'原会话继续可用',expected:view.control};assert.equal((await f.session.submit(next)).status,'accepted');
    await until(async()=>(await f.session.lookupReceipt(next)).processing===(name==='valid'?'unanswered':'done'));await until(async()=>(await f.session.read()).phase==='ready');assert.equal((await f.session.read()).phase,'ready');assert.deepEqual(f.server.errors,[]);
  }finally{await f.dispose();}
});

await test('普通扩展纯参数准备在原首轮 schema 校验前消费；原 assistant/raw arguments/callId 保留', {timeout:30000}, async()=>{
  const f=await fixture({calls:[['prepared_tool',{items:'["actual","prepared"]'}]]});try{
    await writeFile(join(f.project,'.pi/extensions/prepared.ts'),argumentExtension);await f.session.submit(f.input);await until(async()=>(await f.session.lookupReceipt(f.input)).processing==='done');
    const view=await f.session.read();assert.equal(view.entries.find(e=>e.toolResult?.name==='prepared_tool')?.toolResult.text,'PREPARED actual,prepared');
    assert.deepEqual(JSON.parse(await readFile(join(f.project,'prepared-effect.json'),'utf8')),{id:'actual-tool-1',items:['actual','prepared']});
    assert.ok(f.server.requests[1].body.messages.some(m=>m.role==='assistant'&&m.tool_calls?.some(call=>call.id==='actual-tool-1'&&JSON.parse(call.function.arguments).items==='["actual","prepared"]')));
    assert.ok(f.server.requests[1].body.messages.some(m=>m.role==='tool'&&m.content==='PREPARED actual,prepared'));assert.deepEqual(f.server.errors,[]);
  }finally{await f.dispose();}
});

for(const items of ['bad-prepared','throws'])await test(`参数准备 ${items} 保原 schema 和调用失败；不能放弱校验后执行`,{timeout:30000},async()=>{
  const f=await fixture({calls:[['prepared_tool',{items}]]});try{
    await writeFile(join(f.project,'.pi/extensions/prepared.ts'),argumentExtension);await f.session.submit(f.input);await until(async()=>(await f.session.lookupReceipt(f.input)).processing==='done');
    assert.equal((await f.session.read()).entries.find(e=>e.toolResult?.name==='prepared_tool')?.toolResult.isError,true);
    await assert.rejects(readFile(join(f.project,'prepared-effect.json')),{code:'ENOENT'});assert.ok(f.server.requests[1].body.messages.some(m=>m.role==='tool'&&m.content.length));
  }finally{await f.dispose();}
});

await test('纯参数准备保 SDK 原有可转换校验语义：数组数值转换为已声明字符串，不改模型原消息',{timeout:30000},async()=>{
  const f=await fixture({calls:[['prepared_tool',{items:'coercible'}]]});try{
    await writeFile(join(f.project,'.pi/extensions/prepared.ts'),argumentExtension);await f.session.submit(f.input);await until(async()=>(await f.session.lookupReceipt(f.input)).processing==='done');
    assert.deepEqual(JSON.parse(await readFile(join(f.project,'prepared-effect.json'),'utf8')).items,['3']);assert.equal((await f.session.read()).entries.find(e=>e.toolResult?.name==='prepared_tool')?.toolResult.text,'PREPARED 3');
    assert.ok(f.server.requests[1].body.messages.some(m=>m.role==='assistant'&&m.tool_calls?.some(call=>JSON.parse(call.function.arguments).items==='coercible')));
  }finally{await f.dispose();}
});

await test('HTTP 取消已送达但确认挂起：关闭有界 grace 后实际关闭原运输／DELETE，不等逻辑 closed 冒称收束', {timeout:25000},async()=>{
  const f=await fixture({http:true,holdCancelAck:true,calls:[['mcp__fixture__wait',{token:'held_cancel'}]]});try{
    await f.session.submit(f.input);await until(async()=>(await f.events()).some(e=>e.type==='wait.pending'));const parked=(await f.events()).find(e=>e.type==='wait.pending');
    await f.session.pause();const events=await f.events();assert.ok(events.some(e=>e.type==='cancel.received'&&e.requestId===parked.requestId&&e.matched));
    assert.ok(events.some(e=>e.type==='cancel.ack-held'));assert.ok(events.some(e=>e.type==='cancel.ack-released'));assert.ok(events.some(e=>e.type==='delete.received'));
    assert.ok(events.some(e=>e.type==='session.drained'&&e.pending===0));assert.equal(f.server.requests.length,1);
  }finally{await f.dispose();}
});

await test('同轮顺序调用暂停／重开：恢复原 generation memo 与尚未建 ToolTask 的 prepared 调用；不重放 MCP wait', {timeout:35000}, async()=>{
  const f=await fixture({calls:[['mcp__fixture__wait',{token:'argument_wait'}]],firstRoundCalls:[['mcp__fixture__wait',{token:'argument_wait'}],['prepared_tool',{items:'["after","reopen"]'}]]});let session=f.session;
  try{await writeFile(join(f.project,'.pi/extensions/prepared.ts'),argumentExtension);const receipt=await session.submit(f.input);
    await until(async()=>(await f.events()).some(e=>e.type==='wait.pending'));
    await readonlyStorageCopy(f,async storage=>{
      const tasks=(await storage.scanTasks({conversationId:ROOT_CONVERSATION_ID},200,undefined,context)).items;const generation=tasks.find(t=>t.kind==='pi.generation'&&t.state.checkpoint?.phase==='tools');
      assert.ok(generation.state.checkpoint.pending.includes('actual-tool-1-1'));assert.deepEqual(generation.memos['dcode.extension-arguments/actual-tool-1-1'].prepared,{items:['after','reopen']});
    });
    await session.pause();await session.close();session=await f.backend.open({...f.opening,initialize:false});const restored=await session.read();assert.equal(f.server.requests.length,1);
    assert.equal((await session.lookupReceipt(f.input)).submissionId,receipt.submissionId);await assert.rejects(readFile(join(f.project,'prepared-effect.json')),{code:'ENOENT'});
    await session.resume(restored.control);await until(async()=>(await session.lookupReceipt(f.input)).processing==='done');
    assert.deepEqual(JSON.parse(await readFile(join(f.project,'prepared-effect.json'),'utf8')),{id:'actual-tool-1-1',items:['after','reopen']});
    assert.equal((await f.events()).filter(e=>e.type==='call.start'&&e.tool==='wait').length,1);assert.equal((await session.read()).entries.filter(e=>e.toolResult?.name==='prepared_tool').length,1);assert.deepEqual(f.server.errors,[]);
  }finally{await session.close();await f.dispose();}
});

for(const event of ['before_provider_request','before_provider_headers'])await test(`扩展 ${event} 不得更换已准入模型／模型认证；拒绝发生在 HTTP 前`,{timeout:20000},async()=>{
  const f=await fixture({calls:[]});try{
    await writeFile(join(f.project,'.pi/extensions/protected.ts'),`export default function(pi){pi.on('${event}',event=>(${event==='before_provider_request'?"{...event.payload,model:'unadmitted-model'}":"event.headers.authorization='Bearer unadmitted-key'"}));}`);
    assert.equal((await f.session.submit(f.input)).status,'accepted');await until(async()=>(await f.session.lookupReceipt(f.input)).processing==='unanswered');assert.equal(f.server.requests.length,0);
  }finally{await f.dispose();}
});

await test('请求头扩展只读协议公开投影：线程拿不到模型凭据；普通新头确实进入 HTTP 且原认证保持',{timeout:30000},async()=>{
  const f=await fixture({calls:[]});try{
    await writeFile(join(f.project,'.pi/extensions/headers.ts'),`export default function(pi){pi.on('before_provider_headers',event=>{
      pi.appendEntry('header-scope',{keys:Object.keys(event.headers),credentialSeen:JSON.stringify(event.headers).includes(${JSON.stringify(codingKey)})});
      event.headers['X-DCode-Extension-Fixture']='actual-public-header';
    });}`);
    await f.session.submit(f.input);await until(async()=>(await f.session.lookupReceipt(f.input)).processing==='done');
    const entries=(await f.session.read()).entries.filter(e=>e.data?.value?.customType==='header-scope');assert.equal(entries.length,f.server.requests.length,'相同头的不同真实请求也各有一次动作，不能按同 task/value 去重');
    assert.equal(new Set(entries.map(e=>e.data.value.actionId)).size,entries.length);
    for(const entry of entries){assert.equal(entry.data.value.data.credentialSeen,false);assert.ok(entry.data.value.data.keys.every(name=>['accept','content-type','user-agent'].includes(name.toLowerCase())));}
    assert.ok(f.server.requests.every(r=>r.authOk&&r.extensionHeader==='actual-public-header'));assert.deepEqual(f.server.errors,[]);
  }finally{await f.dispose();}
});

await test('扩展 input 真在途：先存原接收记录，副作用完成后暂停关闭；只读查回与明确继续不重放 handler', {timeout:30000}, async()=>{
  const f=await fixture({calls:[]});let session=f.session;
  try {
    await writeFile(join(f.project,'.pi/extensions/pending.ts'),`import {appendFile} from 'node:fs/promises';import {join} from 'node:path';
      export default function(pi){pi.on('input',async(_,ctx)=>{
        await appendFile(join(ctx.cwd,'input-effects.jsonl'),'completed-once\\n');
        await new Promise((resolve,reject)=>{if(ctx.signal.aborted)return reject(new Error('aborted'));ctx.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});});
      });}`);
    const receipt=await session.submit(f.input);assert.equal(receipt.status,'accepted');
    await until(async()=>readFile(join(f.project,'input-effects.jsonl'),'utf8').then(s=>s==='completed-once\n',()=>false));
    assert.equal((await session.lookupReceipt(f.input)).status,'accepted');assert.equal(f.server.requests.length,0);
    await session.pause();await session.close();
    const starts=(await f.events()).filter(e=>e.type==='start').length;
    session=await f.backend.open({...f.opening,initialize:false});const view=await session.read();
    assert.equal((await session.lookupReceipt(f.input)).submissionId,receipt.submissionId);
    assert.equal((await f.events()).filter(e=>e.type==='start').length,starts);assert.equal(f.server.requests.length,0);
    await session.resume(view.control);await until(async()=>(await session.lookupReceipt(f.input)).processing==='unanswered');
    assert.equal(await readFile(join(f.project,'input-effects.jsonl'),'utf8'),'completed-once\n');assert.equal(f.server.requests.length,0);
    const final=await session.read();assert.ok(final.entries.some(e=>e.kind==='dcode.preparation-error'));
  }finally{await session.close();await f.dispose();}
});


// 具体普通.md链接的声明须按目标文件校验；两入口分开，不能被SKILL.md诊断或另一明示入口掩盖。
const packageLinkedSkillPath = '.pi/package/skills/selected.md';
function packageLinkedSkillSettings(declaration, disabled = false) {
  const selected = 'skills/selected.md', allowed = 'skills/allowed.md';
  const item = { source:'./package', extensions:[], prompts:[] };
  if(declaration === 'filter') item.skills = disabled ? [selected, allowed, `-${selected}`] : [selected];
  else if(disabled) item.skills = [`-${selected}`];
  return { packages:[item] };
}
async function preparePackageLinkedSkill(f, declaration, content, {disabled = false, outside = false} = {}) {
  const pkg = join(f.project,'.pi/package'); await mkdir(join(pkg,'skills'),{recursive:true});
  const manifestSkills = declaration === 'manifest'
    ? ['skills/selected.md', ...(disabled ? ['skills/allowed.md'] : [])] : ['skills'];
  await writeFile(join(pkg,'package.json'),JSON.stringify({name:'owned-linked-skill',pi:{extensions:[],skills:manifestSkills,prompts:[]}}));
  // 目标在根内独立文件，不在自动skills目录，也不叫SKILL.md；外部对照仅为fixture自有兄弟目录。
  const target = join(outside ? f.root : f.project, `owned-linked-target-${f.nonce}`);
  await writeFile(target,content); await symlink(target,join(f.project,packageLinkedSkillPath),'file');
  assert.equal(await realpath(join(f.project,packageLinkedSkillPath)),await realpath(target));
  if(disabled) await writeFile(join(pkg,'skills/allowed.md'),`---\nname: linked-allowed\ndescription: LINK_ALLOWED_${f.nonce}\n---\nOwned enabled skill.\n`);
  return target;
}
async function packageLinkedSkillRejected(f, body) {
  const accepted=await f.session.submit(f.input); assert.equal(accepted.status,'accepted'); assert.ok(accepted.submissionId!==undefined);
  // 旧实现会正常done；先等两种真实终态，再断言unanswered，不能把准备超时当作业务目标红。
  await until(async()=>['done','unanswered'].includes((await f.session.lookupReceipt(f.input)).processing));
  const receipt=await f.session.lookupReceipt(f.input); assert.equal(receipt.status,'accepted');
  assert.equal(receipt.processing,'unanswered','明示的非法或越界普通md链接不能被静默丢声明后执行');
  assert.equal(receipt.submissionId,accepted.submissionId); assert.equal(f.server.requests.length,0);
  const view=await f.session.read(),failures=view.entries.filter(entry=>entry.kind==='dcode.preparation-error');
  assert.equal(failures.length,1); assert.deepEqual(failures[0].data,{requestId:f.input.operationId});
  assert.equal(failures[0].extensionMessage?.display,true); assert.match(failures[0].extensionMessage.text,/项目资源或输入处理未完成/);
  assert.ok(!JSON.stringify(view.entries).includes(body),'有限失败记录不搬入所声明文件正文');
  const starts=(await f.events()).filter(event=>event.type==='start').length;
  const retried=await f.session.submit(f.input); assert.equal(retried.status,'accepted');
  assert.equal(retried.submissionId,accepted.submissionId); assert.equal(retried.processing,'unanswered');
  assert.equal((await f.session.lookupReceipt(f.input)).submissionId,accepted.submissionId);
  assert.equal((await f.session.read()).entries.filter(entry=>entry.kind==='dcode.preparation-error').length,1);
  assert.equal(f.server.requests.length,0); assert.equal((await f.events()).filter(event=>event.type==='start').length,starts);
  assert.deepEqual(f.server.errors,[]);
}
for(const declaration of ['manifest','filter']) {
  for(const invalid of ['no-description','bad-frontmatter']) await test(`包具体md文件链接 ${declaration}/${invalid}：根内目标仍须声明校验，保原接收并零HTTP`,{timeout:30000},async()=>{
    const f=await fixture({calls:[],settings:packageLinkedSkillSettings(declaration)});
    try {
      const body=`DECLARED_LINK_BODY_${f.nonce}`;
      const content=invalid==='no-description' ? `---\nname: linked-selected\n---\n${body}\n` : `---\nname: linked-selected\ndescription: [not closed\n---\n${body}\n`;
      await preparePackageLinkedSkill(f,declaration,content); await packageLinkedSkillRejected(f,body);
    } finally {await f.dispose();}
  });
  await test(`包具体md文件链接 ${declaration}/valid：根内合法文件进唯一目录，实际read全文进紧邻HTTP`,{timeout:30000},async()=>{
    const f=await fixture({calls:[['read',{path:packageLinkedSkillPath}]],settings:packageLinkedSkillSettings(declaration)});
    try {
      const description=`VALID_PACKAGE_LINK_${f.nonce}`,body=`VALID_PACKAGE_LINK_BODY_${f.nonce}`;
      const content=`---\nname: linked-selected\ndescription: ${description}\n---\n${body}\n`;
      await preparePackageLinkedSkill(f,declaration,content); const accepted=await resourceSubmitDone(f,f.input);
      assert.equal((await f.session.lookupReceipt(f.input)).submissionId,accepted.submissionId); assert.equal(f.server.requests.length,7);
      const header=resourceHeader(f.server.requests[0]); assert.equal(resourceOccurrences(header,description),1);
      assert.ok(header.includes(packageLinkedSkillPath)); assert.ok(!JSON.stringify(f.server.requests[0].body.messages).includes(body));
      const read=(await f.session.read()).entries.find(entry=>entry.toolResult?.callId==='actual-tool-1')?.toolResult;
      assert.ok(read); assert.equal(read.name,'read'); assert.equal(read.isError,false); assert.ok(read.text.includes(content));
      const next=f.server.requests[1]; assert.equal(next.ordinal,2);
      const forwarded=next.body.messages.filter(message=>message.role==='tool'&&message.tool_call_id==='actual-tool-1');
      assert.equal(forwarded.length,1); assert.ok(resourceWireText(forwarded[0]).includes(content));
      assert.ok(f.server.requests.every(request=>request.authOk&&request.body.model===codingModel)); assert.deepEqual(f.server.errors,[]);
    } finally {await f.dispose();}
  });
  await test(`包具体md文件链接 ${declaration}/disabled：已排除非法文件不误拒绝，允许技能和原完整工作仍执行`,{timeout:30000},async()=>{
    const f=await fixture({calls:[],settings:packageLinkedSkillSettings(declaration,true)});
    try {
      const body=`DISABLED_PACKAGE_LINK_BODY_${f.nonce}`;
      await preparePackageLinkedSkill(f,declaration,`---\nname: linked-disabled\ndescription: [not closed\n---\n${body}\n`,{disabled:true});
      await resourceSubmitDone(f,f.input); assert.equal(f.server.requests.length,6);
      const header=resourceHeader(f.server.requests[0]); assert.equal(resourceOccurrences(header,`LINK_ALLOWED_${f.nonce}`),1);
      assert.ok(!header.includes(packageLinkedSkillPath)); assert.ok(f.server.requests.every(request=>!JSON.stringify(request.body.messages).includes(body)));
      assert.equal((await f.session.read()).entries.filter(entry=>entry.kind==='dcode.preparation-error').length,0);
      assert.ok(f.server.requests.every(request=>request.authOk&&request.body.model===codingModel)); assert.deepEqual(f.server.errors,[]);
    } finally {await f.dispose();}
  });
  await test(`包具体md文件链接 ${declaration}/outside：自有根外canary仍拒绝，不扩项目授权`,{timeout:30000},async()=>{
    const f=await fixture({calls:[],settings:packageLinkedSkillSettings(declaration)});
    try {
      const body=`OUTSIDE_PACKAGE_LINK_CANARY_${f.nonce}`;
      const content=`---\nname: linked-outside\ndescription: OUTSIDE_PACKAGE_LINK_${f.nonce}\n---\n${body}\n`;
      const target=await preparePackageLinkedSkill(f,declaration,content,{outside:true});
      await packageLinkedSkillRejected(f,body); assert.equal(await readFile(target,'utf8'),content,'自有canary字节保持');
    } finally {await f.dispose();}
  });
}


// 模型目录的普通 SDK 消费者；不覆盖主动模型调用/provider 登记/virtual/typed。
await test('扩展同步完整模型目录：未选来源刷新仍可查；正式选择后的SDK HTTP身份与安全投影一致', { timeout: 30000 }, async () => {
  let f; let serverB; let configured; let authAvailable = true;
  try {
    f = await fixture({
      calls: [], connectMcp: false,
      loopbackOptions: { callsOverride: [['catalog_snapshot', { stage: 'initial' }]] },
      subsequentCalls: [['catalog_snapshot', { stage: 'refreshed-still-a' }], undefined, ['catalog_snapshot', { stage: 'b-auth-unavailable' }]],
      additionalSources: async ({ nonce }) => {
        const providerId = 'owned-catalog-source-b';
        const initialId = 'owned-catalog-b0-' + nonce;
        const refreshedId = 'owned-catalog-b1-' + nonce;
        // 全是本用例拥有的假凭据；不读取环境、用户账户或模型探针。
        const key = 'owned-catalog-key-' + nonce;
        const header = 'owned-catalog-header-' + nonce;
        serverB = await startCodingLoopback({
          callsOverride: [['catalog_snapshot', { stage: 'selected-b1' }]],
          expectedModels: [refreshedId], expectedKey: key, expectedCatalogHeader: header,
        });
        const model = id => ({ id, name: id, api: 'openai-completions', provider: providerId,
          baseUrl: serverB.origin + '/v1', input: ['text'], reasoning: false,
          contextWindow: 128000, maxTokens: 4096,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          headers: { 'x-dcode-catalog-secret': header } });
        const initial = model(initialId); const refreshed = model(refreshedId);
        const provider = createProvider({ id: providerId, name: 'owned catalog B', models: [initial],
          auth: { apiKey: { name: 'owned fixture key',
            check: async () => authAvailable ? ({ type: 'api_key', source: 'owned fixture configuration' }) : undefined,
            resolve: async () => ({ auth: { apiKey: key }, source: 'owned fixture configuration' }) } },
          api: { stream: openaiCompletions.stream, streamSimple: openaiCompletions.streamSimple } });
        const preset = { id: providerId, name: 'owned catalog B', provider, authKinds: ['api_key'] };
        configured = { providerId, initial, refreshed, key, header,
          source: models => ({ kind: 'preset', providerId, preset, models }) };
        return [configured.source([initial])];
      },
    });
    const a = { provider: 'user-defined', id: codingModel };
    const b0 = { provider: configured.providerId, id: configured.initial.id };
    const b1 = { provider: configured.providerId, id: configured.refreshed.id };
    const queries = [a, b0, b1];
    // 固定r3 ownedModels已替换全部builtin chat目录为空；本例原客户端只登记A与B。
    // 精确all是该原客户端的完整chat集合，不是按认证裁剪；available独立对应原认证快照。
    // A有本例自管凭据、B.check返回本例认证且无filterModels，因此本例两集合恰好同值。
    const allBeforeRefresh = [a,b0]; const availableBeforeRefresh = [a,b0];
    const allAfterRefresh = [a,b0,b1]; const availableAfterRefresh = [a,b0,b1];
    await writeFile(join(f.project, '.pi/extensions/catalog.ts'), `import { Type } from 'typebox';
export default function(pi) {
  const queries = ${JSON.stringify(queries)};
  const secrets = ${JSON.stringify([codingKey, configured.key, configured.header])};
  const ref = model => model ? {provider:model.provider,id:model.id} : null;
  const refs = values => values.map(ref).sort((a,b)=>(a.provider+'/'+a.id).localeCompare(b.provider+'/'+b.id));
  function snapshot(ctx,stage) {
    const all = ctx.modelRegistry.getAll();
    const available = ctx.modelRegistry.getAvailable(); // 故意不await：正式公开合同为同步数组。
    const found = queries.map(query=>ctx.modelRegistry.find(query.provider,query.id));
    const inspected = [...(Array.isArray(all)?all:[]),...(Array.isArray(available)?available:[]),...found.filter(Boolean)];
    const unsafeKeys = [];
    const visit = value => {if(!value||typeof value!=='object')return;for(const [key,part] of Object.entries(value)){
      if(['headers','apikey','authorization','credentials','credential','env'].includes(key.toLowerCase()))unsafeKeys.push(key);
      visit(part);}};
    inspected.forEach(visit);
    const encoded = JSON.stringify(inspected);
    return {probe:'actual-model-catalog',nonce:${JSON.stringify(f.nonce)},stage,current:ref(ctx.model),
      allKind:Array.isArray(all)?'array':typeof all,
      availableKind:Array.isArray(available)?'array':typeof available?.then==='function'?'thenable':typeof available,
      allRefs:Array.isArray(all)?refs(all):[],availableRefs:Array.isArray(available)?refs(available):[],
      found:found.map(ref),unsafeKeys,secretLeaks:secrets.map(secret=>encoded.includes(secret))};
  }
  pi.on('session_start',(_,ctx)=>{pi.appendEntry('catalog-factory-observation',snapshot(ctx,'startup'));});
  pi.registerTool({name:'catalog_snapshot',label:'catalog',description:'Read original runtime chat catalog and synchronous availability snapshot',
    parameters:Type.Object({stage:Type.String()}),
    execute:async(_id,args,_signal,_update,ctx)=>({content:[{type:'text',text:JSON.stringify(snapshot(ctx,args.stage))}]})});
}`);
    const sort = refs => [...refs].sort((a,b)=>(a.provider+'/'+a.id).localeCompare(b.provider+'/'+b.id));
    const assertSnapshot = (actual, stage, current, expectedAll, expectedAvailable) => {
      assert.equal(actual.probe, 'actual-model-catalog'); assert.equal(actual.nonce, f.nonce);
      assert.equal(actual.stage, stage); assert.deepEqual(actual.current, current);
      assert.equal(actual.allKind, 'array', 'getAll保持同步数组');
      assert.equal(actual.availableKind, 'array', 'getAvailable不能改成Promise或等待探针');
      assert.deepEqual(actual.allRefs, sort(expectedAll), 'getAll对应原runtime.getModels的完整chat集合，不能按认证裁剪或只用state.model');
      assert.deepEqual(actual.availableRefs, sort(expectedAvailable), 'getAvailable对应原runtime.getAvailableSnapshot，不重新定义为all或异步查询');
      assert.deepEqual(actual.found, queries.map(query=>expectedAll.some(value=>value.provider===query.provider&&value.id===query.id)?query:null));
      assert.deepEqual(actual.unsafeKeys, [], 'getAll/getAvailable/find不得暴露headers或凭据字段');
      assert.deepEqual(actual.secretLeaks, [false,false,false], '安全投影不能包含测试凭据与请求头标记');
    };
    const observations = async () => {
      const entries = (await f.session.read()).entries;
      return entries.filter(entry=>entry.toolResult?.name==='catalog_snapshot').map(entry=>{
        assert.equal(entry.toolResult.isError, false, '真实注册工具须成功返回目录');
        return JSON.parse(entry.toolResult.text);
      });
    };
    const submit = async (operationId, text) => {
      const input = { ...f.input, operationId, text, expected: (await f.session.read()).control };
      assert.equal((await f.session.submit(input)).status, 'accepted');
      await until(async () => (await f.session.lookupReceipt(input)).processing === 'done');
      await until(async () => (await f.session.read()).phase === 'ready');
    };
    assert.equal(f.server.requests.length, 0); assert.equal(serverB.requests.length, 0);
    await submit('catalog-initial', '观察完整模型目录');
    const first = await observations(); assert.equal(first.length, 1);
    assertSnapshot(first[0], 'initial', a, allBeforeRefresh, availableBeforeRefresh);
    const startup = (await f.session.read()).entries.filter(entry=>entry.data?.action==='entry'
      && entry.data.value?.customType==='catalog-factory-observation');
    assert.equal(startup.length, 1, '工厂注册的启动消费者沿原正式entry保存一次');
    assertSnapshot(startup[0].data.value.data, 'startup', a, allBeforeRefresh, availableBeforeRefresh);
    assert.equal(f.server.requests.length, 2); assert.ok(f.server.requests.every(r=>r.authOk&&r.body.model===codingModel));
    assert.ok(f.server.requests[1].body.messages.some(m=>m.role==='tool'&&m.content===JSON.stringify(first[0])), '实际工具正文进入同次SDK后续HTTP');
    assert.equal(serverB.requests.length, 0, '查目录不调用未选来源模型');

    assert.equal(typeof f.backend.refreshAdditionalSources, 'function');
    await f.backend.refreshAdditionalSources([configured.source([configured.initial, configured.refreshed])]);
    assert.deepEqual((await f.session.read()).model, {provider:a.provider,modelId:a.id}, '刷新其他来源目录不改当前选择');
    assert.equal(f.server.requests.length, 2); assert.equal(serverB.requests.length, 0, '刷新不发模型探针');
    await submit('catalog-after-refresh', '选中模型保持A，读取刷新后的B目录');
    const second = await observations(); assert.equal(second.length, 2);
    assertSnapshot(second[1], 'refreshed-still-a', a, allAfterRefresh, availableAfterRefresh);
    assert.equal(f.server.requests.length, 4); assert.equal(serverB.requests.length, 0);
    assert.ok(f.server.requests.every(r=>r.authOk&&r.body.model===codingModel));
    assert.ok(f.server.requests[3].body.messages.some(m=>m.role==='tool'&&m.content===JSON.stringify(second[1])));

    await f.session.applyModelRef({ provider: b1.provider, modelId: b1.id });
    assert.equal(f.server.requests.length, 4); assert.equal(serverB.requests.length, 0, '明确改选只配置后续请求');
    await submit('catalog-select-refreshed-b', '使用刷新后明确选中的B新模型');
    const third = await observations(); assert.equal(third.length, 3);
    assertSnapshot(third[2], 'selected-b1', b1, allAfterRefresh, availableAfterRefresh);
    assert.equal(f.server.requests.length, 4, 'B请求不能静默回落旧A');
    assert.equal(serverB.requests.length, 2);
    assert.ok(serverB.requests.every(r=>r.authOk&&r.body.model===b1.id&&r.catalogHeaderOk), '真实SDK保B自己的模型/认证/执行请求头');
    assert.ok(serverB.requests[1].body.messages.some(m=>m.role==='tool'&&m.content===JSON.stringify(third[2])));
    authAvailable = false;
    await f.session.applyModelRef({provider:a.provider,modelId:a.id});
    await f.backend.refreshAdditionalSources([configured.source([configured.initial, configured.refreshed])]);
    assert.equal(f.server.requests.length,4); assert.equal(serverB.requests.length,2,'认证快照刷新不发模型请求');
    await submit('catalog-b-auth-unavailable','目录仍登记B，但认证可用集合不含B');
    const fourth=await observations(); assert.equal(fourth.length,4);
    assertSnapshot(fourth[3],'b-auth-unavailable',a,allAfterRefresh,[a]);
    assert.equal(f.server.requests.length,6); assert.equal(serverB.requests.length,2);
    assert.ok(f.server.requests[5].body.messages.some(m=>m.role==='tool'&&m.content===JSON.stringify(fourth[3])));
    assert.deepEqual(f.server.errors, []); assert.deepEqual(serverB.errors, []);
  } finally { await f?.dispose(); await serverB?.close(); }
});
