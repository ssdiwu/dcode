// 错误清理定向：服务端 401 errorMessage 中的 key 替换为 <redacted>；
// 但 model/provider/usage/正常 partial content / done / text / tool 事件完全不变；
// 最终 result() 里的 AssistantMessage.errorMessage 同样净化、content 保留。
// 用例同时覆盖短凭据（ab），防止"深扫整个 error 对象"误伤正常字段（modelId/partial 含 ab）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { relayStreamWithSanitization } from '../../src/adapters/pi/index.ts';

function assistantMessage(partial) {
  return {
    role: 'assistant',
    provider: 'test-provider-ab', // 含 ab（应该保留不被清洗）
    model: 'test-model-ab', // 含 ab
    api: 'openai-completions',
    content: [{ type: 'text', text: partial }],
    stopReason: 'error',
    errorMessage: 'x',
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, costU16: 0 },
  };
}

test('401 事件：errorMessage 中的完整短凭据（ab）被替换，其他身份字段/正文完整', async () => {
  const inner = createAssistantMessageEventStream();
  const key = 'ab';
  // 模拟服务端 401：errorMessage 含 Bearer ab（应清理），error.message 其他模型归属含 ab（应保留）
  const partial = { ...assistantMessage('lab normal正文 lab') };
  partial.errorMessage = `401 Unauthorized: token='Bearer ${key}' reason=key-lookup-failed`;
  inner.push({ type: 'error', reason: 'error', error: partial });
  inner.end(partial);

  const out = relayStreamWithSanitization(inner, key);
  const events = [];
  for await (const e of out) events.push(e);

  assert.equal(events.length >= 1, true, '必须至少转出一条事件');
  const errorEvent = events.find((e) => e && typeof e === 'object' && e.type === 'error');
  assert.ok(errorEvent, '必须含 error 事件');

  // 1. errorMessage 中的 Bearer ab 被净化
  const em = errorEvent.error?.errorMessage;
  assert.equal(typeof em, 'string', 'AssistantMessage.errorMessage 必须仍是字符串');
  assert.ok(!em.includes(`Bearer ${key}`), 'errorMessage 不得残留 Bearer ab 原文');
  assert.ok(em.includes('<redacted>'), 'errorMessage 必须写入 <redacted>');

  // 2. 身份与正文字段完整保留（含 ab 内容不能因短子串扫描被误改）
  assert.equal(errorEvent.error.provider, 'test-provider-ab');
  assert.equal(errorEvent.error.model, 'test-model-ab');
  assert.deepEqual(errorEvent.error.content, [{ type: 'text', text: 'lab normal正文 lab' }]);
  assert.deepEqual(errorEvent.error.usage, { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, costU16: 0 });
  assert.equal(errorEvent.error.stopReason, 'error');
  assert.equal(errorEvent.error.api, 'openai-completions');

  // 3. result() 中的最终 AssistantMessage：errorMessage 净化 + content/model/provider 保留
  const finalMessage = await out.result();
  assert.ok(finalMessage);
  assert.equal(typeof finalMessage.errorMessage, 'string');
  assert.ok(!finalMessage.errorMessage.includes(`Bearer ${key}`));
  assert.ok(finalMessage.errorMessage.includes('<redacted>'));
  assert.equal(finalMessage.model, 'test-model-ab');
  assert.equal(finalMessage.provider, 'test-provider-ab');
  assert.deepEqual(finalMessage.content, [{ type: 'text', text: 'lab normal正文 lab' }]);
});

test('正常 text/done 事件完全不变（即使其字符串与 key 同字符）', async () => {
  const inner = createAssistantMessageEventStream();
  const key = 'ab';
  const done = assistantMessage('normal absolutely fine text about lab');
  done.stopReason = 'stop';
  delete done.errorMessage;
  inner.push({ type: 'textDelta', partial: done, delta: 'delta' });
  inner.push({ type: 'done', reason: 'stop', message: done });
  inner.end(done);

  const out = relayStreamWithSanitization(inner, key);
  const events = [];
  for await (const e of out) events.push(e);
  // 非 error 事件原样转交**逐字段比对**
  assert.deepEqual(events[0], { type: 'textDelta', partial: done, delta: 'delta' });
  assert.deepEqual(events[1], { type: 'done', reason: 'stop', message: done });
  // result() 拿到的 done 事件也是原对象（不需要也不应该清洗正常 stopReason=stop 的 AssistantMessage）
  const finalMessage = await out.result();
  assert.deepEqual(finalMessage, done);
});

test('inner 同步迭代失败（stream.push 后 throw）：cleaned error 事件 + 不保留含秘密的 message', async () => {
  const inner = createAssistantMessageEventStream();
  const key = 'supersecret-key';
  // iteration 阶段同步失败：error.message 含 key 原文
  inner.push({
    type: 'error',
    reason: 'error',
    error: Object.assign(new Error(`stream-fail with key ${key} inside`), { name: 'StreamError' }),
  });
  inner.end();

  const out = relayStreamWithSanitization(inner, key);
  const events = [];
  for await (const e of out) events.push(e);
  const errorEvent = events.find((e) => e && typeof e === 'object' && e.type === 'error');
  assert.ok(errorEvent);
  // 通用错误载荷：只净化 message 字段
  assert.equal(typeof errorEvent.error?.message, 'string');
  assert.ok(!errorEvent.error.message.includes(key), `error.message 不得残留 secret（实测: ${errorEvent.error.message.replaceAll(key, '<KEY>')}）`);
  assert.ok(errorEvent.error.message.includes('<redacted>'));
});

test('result() 的最终 AssistantMessage 也净化 errorMessage（result() 转出独立 promise 同样安全）', async () => {
  const inner = createAssistantMessageEventStream();
  const key = 'zz';
  const msg = assistantMessage('正文保留');
  msg.errorMessage = `Provider says: mismatch key ${key} on record`;
  inner.push({ type: 'error', reason: 'error', error: msg });
  inner.end(msg);
  const out = relayStreamWithSanitization(inner, key);
  for await (const event of out) { void event; }
  const finalMessage = await out.result();
  assert.ok(!finalMessage.errorMessage.includes(key), 'result() 里 AssistantMessage.errorMessage 必须无原文');
  assert.ok(finalMessage.errorMessage.includes('<redacted>'));
  assert.deepEqual(finalMessage.content, [{ type: 'text', text: '正文保留' }]);
});
