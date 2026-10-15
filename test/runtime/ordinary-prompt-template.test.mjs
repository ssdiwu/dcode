import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { createRealPiBackend, ModelSetupStore } from '../../src/adapters/pi/index.ts';
import { prepareCodingProject, startCodingLoopback, codingKey, codingModel } from '../e2e/ordinary-coding-fixture.mjs';
import { until } from './fixtures.ts';

await test('普通模板：引号参数实际进入 HTTP，原身份查回／只读重开不重新展开', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dcode-ordinary-template-'));
  const project = join(root, 'project'); await prepareCodingProject(project);
  const prompts = join(project, '.pi/prompts'); await mkdir(prompts, { recursive: true });
  const file = join(prompts, 'repair.md');
  const body = '修复 $1；全部 $@；默认 ${2:-tests}；余项 ${@:2}；切片 ${@:2:1}；缺省 ${4:-fallback}；一次替换 $3';
  await writeFile(file, `---\ndescription: 修复项目\n---\n${body}`);
  const server = await startCodingLoopback({ holdFinal: true });
  const stateDir = join(root, 'state');
  const cipher = { isAvailable: () => true, encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() };
  const store = new ModelSetupStore({ stateDir }, cipher);
  await store.commitWithCredential({ provider: 'openai-completions', label: 'isolated template', modelId: codingModel,
    baseUrl: `${server.origin}/v1`, note: 'ready', keyAction: 'replace', apiKey: codingKey });
  const backend = createRealPiBackend({ stateDir, cipher, store,
    config: { provider: 'openai-completions', label: 'isolated template', modelId: codingModel, baseUrl: `${server.origin}/v1` } });
  const target = { workspaceId: 'space', taskId: 'task', sessionId: 'template-session' };
  const opening = { target, title: '模板真实编码', workFolder: project, model: null, initialize: true, projectAccess: 'task-owner' };
  const raw = '/repair "arithmetic fix" tests "$1"';
  const expanded = '修复 arithmetic fix；全部 arithmetic fix tests $1；默认 tests；余项 tests $1；切片 tests；缺省 fallback；一次替换 $1';
  let session;
  try {
    session = await backend.open(opening);
    const input = { target, operationId: 'template-original', text: raw, mode: 'follow-up', references: [], expected: (await session.read()).control };
    assert.equal((await session.submit(input)).status, 'accepted');
    await until(() => server.requests.length > 0);
    assert.equal(server.requests[0].body.messages.find(message => message.role === 'user').content, expanded, '须核实际 SDK HTTP 正文，不能仅验证资源被列出');
    await until(() => server.requests.length === 6);
    assert.equal((await session.lookupReceipt(input)).status, 'accepted');
    await session.pause(); await session.close();
    // 原实例已经关闭并释放存储，公共正式记录的 model 才是用户正文，data 是有限展示／记账载荷。
    const storage = await openNodeJsonlStorage(join(stateDir, 'runtime', target.sessionId), context);
    try {
      const entries = await storage.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 200, undefined, context);
      const users = entries.items.flatMap(entry => (entry.model ?? []).filter(message => message.role === 'user'));
      assert.deepEqual(users.map(message => typeof message.content === 'string' ? message.content
        : message.content.filter(part => part.type === 'text').map(part => part.text).join('')), [expanded]);
    } finally { await storage.close(context); }
    await writeFile(file, '---\nbroken: [\n---\nLATER_TEMPLATE_MUST_NOT_REWRITE_HISTORY');
    session = await backend.open({ ...opening, initialize: false });
    const reopened = await session.read();
    assert.equal((await session.lookupReceipt(input)).status, 'accepted');
    assert.equal(server.requests.length, 6, '只读重开不加载失效模板、不请求模型');
    await writeFile(file, 'LATER_TEMPLATE_MUST_NOT_REWRITE_HISTORY');
    server.releaseFinal(); await session.resume(reopened.control);
    await until(() => server.requests.length === 7);
    await until(async () => (await session.lookupReceipt(input)).processing === 'done');
    assert.equal(server.requests[6].body.messages.find(message => message.role === 'user').content, expanded);
    assert.ok(!JSON.stringify(server.requests[6].body.messages).includes('LATER_TEMPLATE_MUST_NOT_REWRITE_HISTORY'));
    assert.equal((await session.submit(input)).status, 'accepted', '重试使用原输入指纹，不重新展开新模板');
    assert.equal(server.requests.length, 7);
    assert.deepEqual(server.errors, []);
  } finally { await session?.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

for (const kind of ['project', 'app']) await test(`模板合法根内链接 ${kind}：声明名进入实际 HTTP，应用首定义不被项目抢占`, { timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dcode-template-alias-'));
  const project = join(root, 'project'); await prepareCodingProject(project);
  const stateDir = join(root, 'state'); const prompts = join(project, '.pi/prompts'); await mkdir(prompts, { recursive: true });
  if (kind === 'project') {
    await writeFile(join(project, 'shared-template.md'), 'PROJECT_DECLARED_ALIAS $1');
    await symlink('../../shared-template.md', join(prompts, 'repair.md'));
  } else {
    await writeFile(join(prompts, 'repair.md'), 'PROJECT_MUST_NOT_STEAL_APP_ALIAS $1');
    const app = join(stateDir, 'coding-resources'); const appPrompts = join(app, 'prompts'); await mkdir(appPrompts, { recursive: true });
    await writeFile(join(app, 'shared-template.md'), 'APP_DECLARED_ALIAS $1');
    await symlink('../shared-template.md', join(appPrompts, 'repair.md'));
  }
  const server = await startCodingLoopback();
  const cipher = { isAvailable: () => true, encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() };
  const store = new ModelSetupStore({ stateDir }, cipher);
  await store.commitWithCredential({ provider: 'openai-completions', label: 'isolated template alias', modelId: codingModel,
    baseUrl: `${server.origin}/v1`, note: 'ready', keyAction: 'replace', apiKey: codingKey });
  const backend = createRealPiBackend({ stateDir, cipher, store,
    config: { provider: 'openai-completions', label: 'isolated template alias', modelId: codingModel, baseUrl: `${server.origin}/v1` } });
  let session;
  try {
    const target = { workspaceId: 'space', taskId: 'task', sessionId: kind + '-alias' };
    session = await backend.open({ target, title: '模板声明别名', workFolder: project, model: null, initialize: true, projectAccess: 'task-owner' });
    const input = { target, operationId: kind + '-declared-alias', text: '/repair actual', mode: 'follow-up', references: [], expected: (await session.read()).control };
    assert.equal((await session.submit(input)).status, 'accepted');
    await until(() => server.requests.length > 0);
    assert.equal(server.requests[0].body.messages.find(message => message.role === 'user').content,
      kind === 'project' ? 'PROJECT_DECLARED_ALIAS actual' : 'APP_DECLARED_ALIAS actual');
  } finally { await session?.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

await test('声明模板失效明确未接收且零 HTTP，修复后原 operationId 可真正发送', { timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dcode-template-rejection-'));
  const project = join(root, 'project'); await prepareCodingProject(project);
  const dir = join(project, '.pi/prompts'); await mkdir(dir, { recursive: true });
  const file = join(dir, 'repair.md'); await writeFile(file, '---\nbroken: [\n---\nbody');
  const server = await startCodingLoopback(); const stateDir = join(root, 'state');
  const cipher = { isAvailable: () => true, encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() };
  const store = new ModelSetupStore({ stateDir }, cipher);
  await store.commitWithCredential({ provider: 'openai-completions', label: 'isolated failed template', modelId: codingModel,
    baseUrl: `${server.origin}/v1`, note: 'ready', keyAction: 'replace', apiKey: codingKey });
  const backend = createRealPiBackend({ stateDir, cipher, store,
    config: { provider: 'openai-completions', label: 'isolated failed template', modelId: codingModel, baseUrl: `${server.origin}/v1` } });
  let session;
  try {
    const target = { workspaceId: 'space', taskId: 'task', sessionId: 'failed-template' };
    session = await backend.open({ target, title: '模板失效', workFolder: project, model: null, initialize: true, projectAccess: 'task-owner' });
    const input = { target, operationId: 'same-template-operation', text: '/repair validation', mode: 'follow-up', references: [], expected: (await session.read()).control };
    assert.deepEqual(await session.submit(input), { status: 'not-accepted', operationId: input.operationId, reason: 'execution-unavailable' });
    assert.equal(server.requests.length, 0);
    assert.equal((await session.lookupReceipt(input)).reason, 'not-found');
    assert.equal((await session.read()).phase, 'ready');
    await writeFile(file, '$1 '.repeat(30));
    const oversized = { ...input, text: '/repair ' + 'x'.repeat(100_000) };
    assert.deepEqual(await session.submit(oversized), { status: 'not-accepted', operationId: input.operationId, reason: 'execution-unavailable' });
    assert.equal((await session.lookupReceipt(oversized)).reason, 'not-found');
    assert.equal(server.requests.length, 0, '展开容量不允许靠模型请求探测');
    await writeFile(file, '');
    assert.deepEqual(await session.submit(input), { status: 'not-accepted', operationId: input.operationId, reason: 'execution-unavailable' });
    assert.equal(server.requests.length, 0);
    await writeFile(file, 'PROJECT_TEMPLATE_SHADOW $1');
    const appPrompts = join(stateDir, 'coding-resources/prompts'); await mkdir(appPrompts, { recursive: true });
    await writeFile(join(appPrompts, 'repair.md'), 'TEMPLATE_APP_FIRST_REAL_REQUEST $1');
    assert.equal((await session.submit(input)).status, 'accepted');
    await until(() => server.requests.length > 0);
    assert.equal(server.requests[0].body.messages.find(message => message.role === 'user').content, 'TEMPLATE_APP_FIRST_REAL_REQUEST validation');
  } finally { await session?.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});
