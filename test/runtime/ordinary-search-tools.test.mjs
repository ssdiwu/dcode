import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRealPiBackend, ModelSetupStore } from '../../src/adapters/pi/index.ts';
import { prepareCodingProject, startCodingLoopback, codingKey, codingModel, searchCalls } from '../e2e/ordinary-coding-fixture.mjs';
import { until } from './fixtures.ts';

await test('普通搜索→真实修复：目录、文件名与命中正文进入同运行，暂停重开不重放', { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dcode-ordinary-search-'));
  const project = join(root, 'project'); await prepareCodingProject(project);
  const server = await startCodingLoopback({ holdFinal: true, prefixCalls: searchCalls });
  const stateDir = join(root, 'state');
  const cipher = { isAvailable: () => true, encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() };
  const store = new ModelSetupStore({ stateDir }, cipher);
  await store.commitWithCredential({ provider: 'openai-completions', label: 'isolated search', modelId: codingModel,
    baseUrl: `${server.origin}/v1`, note: 'ready', keyAction: 'replace', apiKey: codingKey });
  const backend = createRealPiBackend({ stateDir, cipher, store,
    config: { provider: 'openai-completions', label: 'isolated search', modelId: codingModel, baseUrl: `${server.origin}/v1` } });
  const target = { workspaceId: 'space', taskId: 'task', sessionId: 'session' };
  const opening = { target, title: '查找并修复', workFolder: project, model: null, initialize: true, projectAccess: 'task-owner' };
  let session;
  try {
    session = await backend.open(opening);
    const input = { target, operationId: 'search-one-input', text: '查找加法实现并用真实测试修复', mode: 'follow-up', references: [], expected: (await session.read()).control };
    assert.equal((await session.submit(input)).status, 'accepted');
    try { await until(() => server.requests.length === 9); }
    catch (error) {
      const observed = await session.read();
      console.error('search-progress', JSON.stringify({ requests: server.requests.length, phase: observed.phase,
        tools: observed.entries.flatMap(entry => entry.toolResult ? [{ name: entry.toolResult.name, callId: entry.toolResult.callId, isError: entry.toolResult.isError }] : []) }));
      throw error;
    }
    const view = await session.read();
    const tools = view.entries.flatMap(entry => entry.toolResult ? [entry.toolResult] : []);
    assert.deepEqual(tools.map(tool => tool.name), ['ls', 'find', 'grep', 'read', 'write', 'bash', 'edit', 'bash']);
    assert.equal(tools[0].isError, false, '正式 ls 不能返回未安装工具的错误');
    assert.match(tools[0].text, /index\.mjs/);
    assert.equal(tools[1].isError, false);
    assert.match(tools[1].text, /check\.mjs/);
    assert.equal(tools[2].isError, false);
    assert.match(tools[2].text, /index\.mjs:1:.*return a - b/);
    for (let index = 0; index < 3; index++) {
      const posted = server.requests[index + 1].body.messages.filter(message => message.role === 'tool');
      assert.ok(posted.some(message => message.tool_call_id === `actual-tool-${index + 1}` && message.content.includes(index === 2 ? 'return a - b' : index === 1 ? 'check.mjs' : 'index.mjs')));
    }
    assert.deepEqual(server.requests[0].body.tools.map(tool => tool.function.name).sort(), ['bash', 'edit', 'find', 'grep', 'ls', 'read', 'write']);
    assert.deepEqual(tools.filter(tool => tool.name === 'bash').map(tool => [tool.exitCode, tool.isError]), [[1, true], [0, false]]);
    assert.match(await readFile(join(project, 'index.mjs'), 'utf8'), /return a \+ b/);
    const ids = view.entries.filter(entry => entry.toolResult).map(entry => entry.id);
    await session.pause(); await session.close();
    session = await backend.open({ ...opening, initialize: false });
    assert.equal((await session.lookupReceipt(input)).status, 'accepted');
    assert.deepEqual((await session.read()).entries.filter(entry => entry.toolResult).map(entry => entry.id), ids);
    assert.equal(server.requests.length, 9);
    server.releaseFinal(); await session.resume((await session.read()).control);
    await until(() => server.requests.length === 10);
    await until(async () => (await session.lookupReceipt(input)).processing === 'done');
    assert.deepEqual((await session.read()).entries.filter(entry => entry.toolResult).map(entry => entry.id), ids);
    assert.ok((await session.read()).entries.some(entry => entry.assistantText === server.nonce));
    assert.deepEqual(server.errors, []);
  } finally { await session?.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});

async function fixture(prefixCalls, body, projectAccess = 'task-owner') {
  const root = await mkdtemp(join(tmpdir(), 'dcode-search-boundary-'));
  const project = join(root, 'project'); await prepareCodingProject(project);
  const server = await startCodingLoopback({ holdFinal: true, prefixCalls });
  const stateDir = join(root, 'state');
  const cipher = { isAvailable: () => true, encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() };
  const store = new ModelSetupStore({ stateDir }, cipher);
  await store.commitWithCredential({ provider: 'openai-completions', label: 'isolated search boundary', modelId: codingModel,
    baseUrl: `${server.origin}/v1`, note: 'ready', keyAction: 'replace', apiKey: codingKey });
  const backend = createRealPiBackend({ stateDir, cipher, store,
    config: { provider: 'openai-completions', label: 'isolated search boundary', modelId: codingModel, baseUrl: `${server.origin}/v1` } });
  const target = { workspaceId: 'space', taskId: 'task', sessionId: 'session' };
  let session;
  try {
    session = await backend.open({ target, title: '搜索边界', workFolder: project, model: null, initialize: true, projectAccess });
    await body({ root, project, stateDir, server, session, target, async submit() {
      return await session.submit({ target, operationId: 'search-boundary', text: '受控搜索', mode: 'follow-up', references: [], expected: (await session.read()).control });
    } });
  } finally { await session?.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
}

await test('搜索真实范围：查询根链接到目录外时正式拒绝，不返回目标内容', { timeout: 30000 }, async () => {
  await fixture([['grep', { pattern: 'external-private-marker', path: 'outside' }]], async ({ root, project, server, session, submit }) => {
    const outside = join(root, 'outside'); await mkdir(outside);
    await writeFile(join(outside, 'hidden.txt'), 'external-private-marker\n');
    await symlink(outside, join(project, 'outside'));
    assert.equal((await submit()).status, 'accepted');
    await until(() => server.requests.length === 7);
    const rejected = (await session.read()).entries.find(entry => entry.toolResult?.callId === 'actual-tool-1')?.toolResult;
    assert.equal(rejected?.isError, true);
    assert.match(rejected.text, /搜索路径不在任务工作目录内/);
    assert.ok(!rejected.text.includes('external-private-marker'));
    assert.ok(!JSON.stringify(server.requests[1].body.messages.filter(message => message.role === 'tool')).includes('external-private-marker'));
  });
});

await test('真实搜索在途暂停：取消 SDK 子进程，宿主可读且暂停返回前已退出', { timeout: 30000 }, async () => {
  await fixture([['grep', { pattern: 'waiting-search-marker', path: '.' }]], async ({ root, stateDir, session, submit }) => {
    const dir = join(stateDir, 'coding-resources', 'bin'); await mkdir(dir, { recursive: true });
    const started = join(root, 'search-started'); const stopped = join(root, 'search-stopped');
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    const binary = join(dir, 'rg');
    const handler = quote(`printf cancelled > ${quote(stopped)}; exit 0`);
    await writeFile(binary, `#!/bin/sh\ntrap ${handler} TERM\nprintf '%s' "$$" > ${quote(started)}\nwhile :; do sleep 0.05; done\n`);
    await chmod(binary, 0o700);
    assert.equal((await submit()).status, 'accepted');
    await until(async () => { try { return /^\d+$/.test(await readFile(started, 'utf8')); } catch { return false; } });
    const pid = Number(await readFile(started, 'utf8')); assert.ok(pid > 0);
    const running = await session.read();
    assert.equal(running.phase, 'running', '搜索在途，宿主仍可读取正式运行');
    await session.pause();
    assert.equal(await readFile(stopped, 'utf8'), 'cancelled', '实际子进程收到取消并在暂停收束前结束');
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, '已核本次调用的 PID 退出，不以取消标记替退出');
    assert.equal((await session.read()).phase, 'paused');
    const content = await readFile(binary, 'utf8');
    assert.match(content, /while :/);
  });
});

await test('搜索无匹配与输出上限：实际 SDK 结果进入正式记录，未命中不称执行失败', { timeout: 30000 }, async () => {
  await fixture([
    ['grep', { pattern: 'unmatched-search-pattern', path: 'index.mjs' }],
    ['find', { pattern: 'unmatched-*.absent' }],
    ['ls', { path: '.', limit: 1 }],
  ], async ({ server, session, submit }) => {
    assert.equal((await submit()).status, 'accepted');
    await until(() => server.requests.length === 9);
    const results = (await session.read()).entries.flatMap(entry => entry.toolResult ? [entry.toolResult] : []);
    assert.deepEqual(results.slice(0, 3).map(tool => tool.isError), [false, false, false]);
    assert.match(results[0].text, /No matches found/);
    assert.match(results[1].text, /No files found matching pattern/);
    assert.match(results[2].text, /1 entries limit reached/);
    assert.match(JSON.stringify(server.requests[3].body.messages.filter(message => message.role === 'tool')), /1 entries limit reached/);
  });
});

await test('成员未有文件范围：真实三种搜索意图均拒绝，不加载项目工具或资料', { timeout: 30000 }, async () => {
  await fixture(searchCalls, async ({ server, session, submit }) => {
    assert.equal((await submit()).status, 'accepted');
    await until(() => server.requests.length === 9);
    assert.equal(server.requests[0].body.tools?.length ?? 0, 0);
    assert.ok(!JSON.stringify(server.requests[0].body.messages).includes('coding-agents-real-context'));
    const results = (await session.read()).entries.flatMap(entry => entry.toolResult ? [entry.toolResult] : []);
    assert.deepEqual(results.slice(0, 3).map(tool => [tool.name, tool.isError]), [['ls', true], ['find', true], ['grep', true]]);
    assert.ok(results.slice(0, 3).every(tool => !/index\.mjs|check\.mjs|return a - b/.test(tool.text)));
  }, null);
});
