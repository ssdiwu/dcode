import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRealPiBackend, ModelSetupStore } from '../../src/adapters/pi/index.ts';
import { prepareCodingProject, startCodingLoopback, codingKey, codingModel } from '../e2e/ordinary-coding-fixture.mjs';
import { until } from './fixtures.ts';

await test('普通 custom：真实项目指令→四工具→测试真1→同运行修复→真0→暂停重开不重放', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dcode-ordinary-coding-'));
  const project = join(root, 'project'); await prepareCodingProject(project);
  const server = await startCodingLoopback({ holdFinal: true });
  const stateDir = join(root, 'state');
  const cipher = { isAvailable: () => true, encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() };
  const store = new ModelSetupStore({ stateDir }, cipher);
  await store.commitWithCredential({ provider: 'openai-completions', label: 'isolated coding', modelId: codingModel,
    baseUrl: `${server.origin}/v1`, note: 'ready', keyAction: 'replace', apiKey: codingKey });
  const backend = createRealPiBackend({ stateDir, cipher, store,
    config: { provider: 'openai-completions', label: 'isolated coding', modelId: codingModel, baseUrl: `${server.origin}/v1` } });
  const target = { workspaceId: 'space', taskId: 'task', sessionId: 'session' };
  const opening = { target, title: '修复真实项目', workFolder: project, model: null, initialize: true, projectAccess: 'task-owner' };
  let session;
  try {
    session = await backend.open(opening);
    const input = { target, operationId: 'coding-one-input', text: '修复加法，用真实测试确认', mode: 'follow-up', references: [], expected: (await session.read()).control };
    assert.equal((await session.submit(input)).status, 'accepted');
    await until(() => server.requests.length === 6);
    const request = server.requests[0].body;
    assert.match(JSON.stringify(request.messages), /coding-agents-real-context/, '公开资源加载结果进入同次真实请求');
    assert.match(JSON.stringify(request.messages), /coding-project-skill-marker/);
    assert.ok(!JSON.stringify(request.messages).includes(join(homedir(), '.agents', 'skills')), '只加载显式项目／应用资源，不旁读宿主技能');
    assert.deepEqual(request.tools.map(tool => tool.function.name).sort(), ['bash', 'edit', 'find', 'grep', 'ls', 'read', 'write']);
    assert.match(await readFile(join(project, 'index.mjs'), 'utf8'), /return a \+ b/);
    assert.equal(await readFile(join(project, 'build.txt'), 'utf8'), 'actual build output\n');
    await assert.rejects(readFile(join(project, 'audit.txt')), { code: 'ENOENT' });
    const view = await session.read();
    const results = view.entries.flatMap(entry => entry.toolResult ? [entry.toolResult] : []);
    assert.deepEqual(results.map(result => result.name), ['read', 'write', 'bash', 'edit', 'bash']);
    assert.deepEqual(results.filter(result => result.name === 'bash').map(result => [result.exitCode, result.isError]), [[1, true], [0, false]]);
    assert.match(JSON.stringify(server.requests[3].body.messages.filter(message => message.role === 'tool')), /Command exit code: 1/);
    assert.match(JSON.stringify(server.requests[3].body.messages.filter(message => message.role === 'tool')), /actual addition/);
    assert.ok(results[3].changes.some(file => file.hunks.some(hunk => hunk.lines.some(line => line.type === 'add' && /return a \+ b/.test(line.text)))));
    assert.ok(results[4].changes.some(file => file.path.endsWith('/audit.txt') && file.deleted === 1));
    assert.ok(results[4].changes.some(file => file.path.endsWith('/build.txt') && file.added === 1));
    const toolIds = view.entries.filter(entry => entry.toolResult).map(entry => entry.id);
    await session.pause(); await session.close();
    session = await backend.open({ ...opening, workFolder: join(root, 'unselected-new-folder'), initialize: false });
    assert.equal((await session.lookupReceipt(input)).status, 'accepted');
    const reopened = await session.read();
    assert.deepEqual(reopened.entries.filter(entry => entry.toolResult).map(entry => entry.id), toolIds);
    assert.equal(server.requests.length, 6, '重开／回查不发请求或重放完成工具');
    server.releaseFinal(); await session.resume(reopened.control);
    await until(() => server.requests.length === 7);
    await until(async () => (await session.lookupReceipt(input)).processing === 'done');
    const final = await session.read();
    assert.ok(final.entries.some(entry => entry.assistantText === server.nonce));
    assert.deepEqual(final.entries.filter(entry => entry.toolResult).map(entry => entry.id), toolIds);
    assert.deepEqual(server.errors, []);
    assert.ok(server.requests.every(request => request.authOk && request.body.model === codingModel));
  } finally { await session?.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

await test('未有文件范围的会话：恶意模型工具意图不能取得项目读取／写入／命令能力', { timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dcode-member-text-only-'));
  const project = join(root, 'project'); await prepareCodingProject(project);
  const original = await readFile(join(project, 'index.mjs'), 'utf8');
  const server = await startCodingLoopback(); const stateDir = join(root, 'state');
  const cipher = { isAvailable: () => true, encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() };
  const store = new ModelSetupStore({ stateDir }, cipher);
  await store.commitWithCredential({ provider: 'openai-completions', label: 'isolated member', modelId: codingModel,
    baseUrl: `${server.origin}/v1`, note: 'ready', keyAction: 'replace', apiKey: codingKey });
  const backend = createRealPiBackend({ stateDir, cipher, store,
    config: { provider: 'openai-completions', label: 'isolated member', modelId: codingModel, baseUrl: `${server.origin}/v1` } });
  let session;
  try {
    const target = { workspaceId: 'space', taskId: 'task', sessionId: 'member' };
    session = await backend.open({ target, title: 'text-only member', workFolder: project, model: null, initialize: true, projectAccess: null });
    assert.equal((await session.submit({ target, operationId: 'member-one', text: '普通文字对话', mode: 'follow-up', references: [], expected: (await session.read()).control })).status, 'accepted');
    await until(() => server.requests.length > 0);
    assert.equal(server.requests[0].body.tools?.length ?? 0, 0);
    assert.ok(!JSON.stringify(server.requests[0].body.messages).includes('coding-agents-real-context'));
    await until(async () => (await session.read()).entries.some(entry => entry.toolResult?.callId === 'actual-tool-1'));
    const rejected = (await session.read()).entries.find(entry => entry.toolResult?.callId === 'actual-tool-1')?.toolResult;
    assert.equal(rejected?.isError, true, '对端已真实要求 read，正式结果须拒绝，不能只在它执行前关闭');
    assert.ok(!rejected.text.includes('return a - b'), '拒绝结果不能带出项目正文');
    await session.close();
    assert.equal(await readFile(join(project, 'index.mjs'), 'utf8'), original);
    await assert.rejects(readFile(join(project, 'audit.txt')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(project, 'build.txt')), { code: 'ENOENT' });
  } finally { await session?.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});
