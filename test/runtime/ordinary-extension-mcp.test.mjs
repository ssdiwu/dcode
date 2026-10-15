import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { createRealPiBackend, ModelSetupStore } from '../../src/adapters/pi/index.ts';
import { prepareCodingProject, startCodingLoopback, codingKey, codingModel } from '../e2e/ordinary-coding-fixture.mjs';
import { until } from './fixtures.ts';
import { start as startHttpMcp } from '../e2e/ordinary-http-mcp-fixture.mjs';
import { Script } from 'node:vm';
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
