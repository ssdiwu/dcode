// 同一正式上下文的同步只读API及原所有者生命周期。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { createRealPiBackend, ModelSetupStore } from '../../src/adapters/pi/index.ts';
import { codingKey, codingModel } from '../e2e/ordinary-coding-fixture.mjs';
import { contextUsageIds as ids, prepareContextUsageProject, startContextUsageLoopback,
  contextUsageTrace, parseContextUsageResult, assertContextUsageObservation } from '../e2e/ordinary-context-usage-fixture.mjs';
import { until } from './fixtures.ts';

async function fixture({ holdFinal = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dcode-context-usage-')), project = join(root, 'project'), stateDir = join(root, 'state');
  const nonce = randomUUID(); let server, session;
  try {
    await prepareContextUsageProject(project, nonce);
    server = await startContextUsageLoopback({ holdFinal });
    const cipher = { isAvailable: () => true, encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() };
    const store = new ModelSetupStore({ stateDir }, cipher);
    const config = { provider: 'openai-completions', label: 'context usage ordinary custom', modelId: codingModel, baseUrl: server.origin + '/v1' };
    await store.commitWithCredential({ ...config, note: 'ready', keyAction: 'replace', apiKey: codingKey });
    const backend = createRealPiBackend({ stateDir, cipher, store, config });
    const target = { workspaceId: 'space', taskId: 'task', sessionId: 'context-usage-' + nonce };
    const opening = { target, title: '普通上下文用量', workFolder: project, model: null, initialize: true,
      projectAccess: 'task-owner', projectExtensionsEnabled: () => true };
    session = await backend.open(opening);
    const input = { target, operationId: 'context-usage-input-' + nonce, text: 'Read original current context usage ' + nonce,
      mode: 'follow-up', references: [], expected: (await session.read()).control };
    return { root, project, stateDir, nonce, server, backend, target, opening, input,
      get session() { return session; }, set session(value) { session = value; },
      async dispose(passed) {
        try { await session?.close(); } finally { await server.close(); if (passed) await rm(root, { recursive: true, force: true }); }
      } };
  } catch (error) { await session?.close(); await server?.close(); throw error; }
}

async function withFixture(t, options, action) {
  const f = await fixture(options); let passed = false;
  try { await action(f); passed = true; }
  finally { await f.dispose(passed); if (!passed) t.diagnostic('Context usage failure data: ' + f.root); }
}
async function originalResults(f) {
  const view = await f.session.read();
  return view.entries.filter(entry => entry.toolResult?.name === ids.tool).map(entry => ({
    id: entry.id, callId: entry.toolResult.callId, isError: entry.toolResult.isError,
    text: entry.toolResult.text, result: parseContextUsageResult(entry.toolResult.text),
  }));
}
async function assertCompletedObservations(f) {
  const results = await originalResults(f); assert.equal(results.length, 2);
  for (let index = 0; index < 2; index++) {
    const row = results[index], ordinal = index + 1;
    assert.equal(row.isError, false); assert.equal(row.callId, ids.calls[index]);
    assertContextUsageObservation(assert, row.result, { nonce: f.nonce, callId: row.callId, ordinal, modelId: codingModel });
    const request = f.server.requests[index];
    assert.equal(request.authOk, true); assert.equal(request.body.model, codingModel);
    assert.equal(request.ordinal, ordinal);
    const next = f.server.requests[index + 1]; assert.ok(next);
    assert.equal(next.body.messages.filter(message => message.role === 'tool' && message.tool_call_id === row.callId && message.content === row.text).length, 1,
      'Actual observed tool result enters the immediately following real SDK HTTP');
  }
  const trace = await contextUsageTrace(f.project);
  const events = trace.filter(item => item.kind === 'event-observed'); assert.equal(events.length, 2);
  for (let index = 0; index < 2; index++) {
    assert.equal(events[index].toolCallId, ids.calls[index]);
    assertContextUsageObservation(assert, { nonce: events[index].nonce, ...events[index].observed }, { nonce: f.nonce, ordinal: index + 1, modelId: codingModel });
  }
  assert.equal(trace.filter(item => item.kind === 'tool-start').length, 2);
  assert.equal(trace.filter(item => item.kind === 'tool-completed').length, 2);
  assert.deepEqual(f.server.errors, []);
  return results;
}
async function persistedResultsAfterClose(f) {
  // 公共 open 可能修复文件尾，必须在原 owner close 后才读原目录。
  const storage = await openNodeJsonlStorage(join(f.stateDir, 'runtime', f.target.sessionId), context);
  try {
    const entries = []; let cursor;
    do { const page = await storage.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 200, cursor, context); entries.push(...page.items); cursor = page.next; } while (cursor !== undefined);
    // 公共存储扫描为最新在前；按正式entry顺序核原工具调用，不能把查询顺序误认作执行回退。
    entries.sort((left, right) => left.id - right.id);
    return entries.flatMap(entry => entry.model ?? []).filter(message => message.role === 'toolResult' && message.toolName === ids.tool);
  } finally { await storage.close(context); }
}

test('普通 getContextUsage：同步有限副本、真实两次 usage 更新、事件/工具结果进入下一 HTTP', { timeout: 30000 }, async t => {
  await withFixture(t, {}, async f => {
    assert.equal(f.server.requests.length, 0); assert.deepEqual(await contextUsageTrace(f.project), []);
    assert.equal((await f.session.submit(f.input)).status, 'accepted');
    await until(async () => f.server.requests.length === 3 && (await f.session.lookupReceipt(f.input)).processing === 'done');
    const results = await assertCompletedObservations(f);
    assert.notEqual(results[0].result.second.tokens, results[1].result.second.tokens, 'Later actual response usage replaces the earlier snapshot');
    await f.session.close();
    const persisted = await persistedResultsAfterClose(f); assert.equal(persisted.length, 2);
    assert.deepEqual(persisted.map(message => message.toolCallId), ids.calls);
    assert.deepEqual(persisted.map(message => message.content[0].text), results.map(row => row.text));
  });
});

test('普通 getContextUsage：pause/direct-close→只读重开零加载零 HTTP→明确继续保原完成工具', { timeout: 60000 }, async t => {
  for (const stop of ['pause', 'close']) await withFixture(t, { holdFinal: true }, async f => {
    const accepted = await f.session.submit(f.input); assert.equal(accepted.status, 'accepted');
    await until(async () => f.server.requests.length === 3 && (await originalResults(f)).length === 2);
    const before = await assertCompletedObservations(f), idsBefore = before.map(row => row.id);
    if (stop === 'pause') assert.equal((await f.session.pause()).phase, 'paused');
    await f.session.close();
    assert.equal(f.server.requests.length, 3, 'Stopping cannot create a new model request');
    const traceBefore = await contextUsageTrace(f.project), persistedBefore = await persistedResultsAfterClose(f);
    f.session = await f.backend.open({ ...f.opening, initialize: false });
    const reopened = await f.session.read(); assert.equal(reopened.phase, 'paused');
    assert.equal((await f.session.submit(f.input)).submissionId, accepted.submissionId);
    await f.session.lookupReceipt(f.input); await f.session.read();
    assert.equal(f.server.requests.length, 3);
    assert.deepEqual(await contextUsageTrace(f.project), traceBefore, 'Read-only open/read/receipt does not load extension or run its callbacks');
    assert.deepEqual((await originalResults(f)).map(row => row.id), idsBefore);
    f.server.releaseFinal();
    await f.session.resume(reopened.control);
    await until(async () => f.server.requests.length === 4 && (await f.session.lookupReceipt(f.input)).processing === 'done');
    assert.equal((await contextUsageTrace(f.project)).filter(item => item.kind === 'tool-start').length, 2, 'Explicit continue does not replay completed tools');
    assert.equal((await contextUsageTrace(f.project)).filter(item => item.kind === 'tool-completed').length, 2);
    assert.deepEqual((await originalResults(f)).map(row => ({ id: row.id, text: row.text })), before.map(row => ({ id: row.id, text: row.text })));
    assert.equal(f.server.requests[3].body.messages.filter(message => message.role === 'tool' && ids.calls.includes(message.tool_call_id)).length, 2);
    await f.session.close(); assert.deepEqual(await persistedResultsAfterClose(f), persistedBefore);
    assert.deepEqual(f.server.errors, []);
  });
});


test('普通context传参迁移保旧Action身份：真实Host请求仍用原空对象digest', {timeout:30000}, async t=>{
  const observed=[],postMessage=Worker.prototype.postMessage;
  Worker.prototype.postMessage=function(message,...args){
    if(message?.type==='request'&&message.method==='context'&&message.state?.sessionId?.startsWith('context-usage-')){
      observed.push({scope:message.scope,hasOwnMessages:Array.isArray(message.value?.messages)});
    }
    return postMessage.call(this,message,...args);
  };
  t.after(()=>{Worker.prototype.postMessage=postMessage;});
  await withFixture(t,{},async f=>{
    const accepted=await f.session.submit(f.input);assert.equal(accepted.status,'accepted');
    await until(async()=>f.server.requests.length===3&&(await f.session.lookupReceipt(f.input)).processing==='done');
    await assertCompletedObservations(f);
    const own=observed.filter(row=>row.scope.startsWith('event/'));
    assert.equal(own.length,3,'两工具＋最终回复，三次实际beforeRequest原作用');
    const legacyDigest=createHash('sha256').update('{}').digest('hex');
    assert.ok(own.every(row=>row.hasOwnMessages&&row.scope.endsWith('/context/'+legacyDigest)),
      '原context正文在独立payload，但已持久化作用的身份算法不能随传参改变');
  });
});
