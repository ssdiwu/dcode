/**
 * C05 引用：发现、快照与"内容真的参与本次请求"的执行层证据。
 *
 * - 发现与读取走真实 NodeReferencePort（真实文件系统 + 公共根技能发现），夹具在临时目录。
 * - 参与请求的证据取自受控模型实际收到的 messages：用户原文字与每条引用必须是独立内容块。
 * - 不使用真实凭据、真实网络或真实 profile。
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, realpath, rm, stat, writeFile, chmod, symlink } from 'node:fs/promises';
import { closeSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { DCodeApplication } from '../../src/application/index.ts';
import { sampleState } from '../../src/adapters/mock/index.ts';
import type { ExecutionPort, ExecutionTarget } from '../../src/application/index.ts';
import { referenceSetId } from '../../src/contracts/index.ts';
import type { ExecutionView } from '../../src/contracts/index.ts';
import { NodeReferencePort, type StatLike } from '../../src/adapters/references/index.ts';
import { PiExecutionSession } from '../../src/adapters/pi/index.ts';
import type { WorkReference } from '../../src/contracts/index.ts';
import { controlledModels, until } from './fixtures.ts';

const FILE_MARKER = 'export const greeting = "FILE-CONTENT-4d1f8a";';
const SKILL_MARKER = '调用 greeting 之前先运行 SKILL-BODY-91ab3c 校验流程。';

/** 读取失败的原因码：ReferenceCaptureError 上的有限码（不带宿主错误原文）。 */
function codeOf(error: unknown): string {
  return (error as { code?: string }).code ?? '';
}

/** 隔离工程夹具：一个普通源码文件、一个技能、若干应被忽略的目录。 */
async function fixtureWorkspace(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dcode-references-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
  await mkdir(join(root, '.pi', 'skills', 'greet-verify'), { recursive: true });
  await writeFile(join(root, 'src', 'greet.js'), FILE_MARKER);
  await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'module.exports = "IGNORED-NODE-MODULES";');
  await writeFile(
    join(root, '.pi', 'skills', 'greet-verify', 'SKILL.md'),
    `---\nname: greet-verify\ndescription: 引用入口用的受控技能\n---\n\n${SKILL_MARKER}\n`,
  );
  return root;
}

function scope(root: string) {
  return { workspaceId: 'ws-fixture', sessionId: 'session-fixture', taskId: 'task-fixture', operationId: 'op-fixture', folders: [root] };
}

void test('引用发现只认受控工作空间根：忽略依赖目录，并经公共根发现已接技能', { timeout: 30000 }, async (t) => {
  const root = await fixtureWorkspace(t);
  const port = new NodeReferencePort();
  const listing = await port.list(scope(root));

  const fileLocators = listing.files.map((f) => f.locator);
  assert.ok(fileLocators.includes('r0/src/greet.js'), '真实工作空间文件应可被发现，并带根身份');
  assert.ok(!fileLocators.some((l) => l.startsWith('node_modules/')), '依赖目录不应出现在可引用文件里');
  assert.ok(!fileLocators.some((l) => l.startsWith('.pi/')), '技能目录本身不是可引用文件');

  assert.deepEqual(listing.skills.map((s) => s.label), ['greet-verify'], '公共根技能发现应认出受控技能');
  assert.equal(listing.skills[0]?.sourceId, 'skill:greet-verify');
  assert.equal(listing.scope.sessionId, 'session-fixture');
  assert.equal(listing.scope.taskId, 'task-fixture');
});

void test('选取固化真实内容：哈希与内容一致，来源身份自洽', { timeout: 30000 }, async (t) => {
  const root = await fixtureWorkspace(t);
  const port = new NodeReferencePort();

  const file = await port.capture(scope(root), 'file', 'r0/src/greet.js');
  assert.equal(file.snapshot.content, FILE_MARKER, '参与请求的必须是文件真实内容');
  assert.equal(file.sourceId, 'workspace:ws-fixture');
  assert.equal(file.snapshot.truncated, false);
  assert.match(file.snapshot.contentHash, /^[0-9a-f]{64}$/);

  const skill = await port.capture(scope(root), 'skill', 'r0/.pi/skills/greet-verify/SKILL.md');
  assert.ok(skill.snapshot.content.includes(SKILL_MARKER), '技能引用必须带 SKILL.md 正文，不能只有元数据');
  assert.equal(skill.sourceId, 'skill:greet-verify');
});

void test('越界定位被拒：形状非法、逃出根与不存在各自给出真实原因', { timeout: 30000 }, async (t) => {
  const root = await fixtureWorkspace(t);
  const port = new NodeReferencePort();

  await assert.rejects(() => port.capture(scope(root), 'file', '../outside.js'), (e: unknown) => codeOf(e) === 'outside-root');
  await assert.rejects(() => port.capture(scope(root), 'file', '/etc/passwd'), (e: unknown) => codeOf(e) === 'outside-root');
  await assert.rejects(() => port.capture(scope(root), 'file', 'r0/src/missing.js'), (e: unknown) => codeOf(e) === 'not-found');
  // 根身份不存在：不能被当成某个根内的相对路径
  await assert.rejects(() => port.capture(scope(root), 'file', 'r9/src/greet.js'), (e: unknown) => codeOf(e) === 'outside-root');
});

void test('未绑定目录如实报告，不伪造文件列表', { timeout: 30000 }, async () => {
  const port = new NodeReferencePort();
  const listing = await port.list({ ...scope('/definitely/not/here'), folders: ['~/definitely-not-here-4d1f'] });
  assert.equal(listing.root, null);
  assert.deepEqual(listing.files, []);
  assert.equal(listing.issues[0]?.code, 'workspace-unbound');
});

void test('真实 SDK + 受控模型：引用正文进入本次请求，且与用户原文字分块', { timeout: 40000 }, async (t) => {
  const root = await fixtureWorkspace(t);
  const port = new NodeReferencePort();
  const fileRef = await port.capture(scope(root), 'file', 'r0/src/greet.js');
  const skillRef = await port.capture(scope(root), 'skill', 'r0/.pi/skills/greet-verify/SKILL.md');

  const directory = await mkdtemp(join(tmpdir(), 'dcode-reference-run-'));
  const fixture = controlledModels();
  const unit = await PiExecutionSession.open({
    directory: join(directory, 'runtime'),
    cwd: directory,
    target: { workspaceId: 'space', taskId: 'task', sessionId: 'session' },
    models: fixture.models,
    agent: { model: { provider: fixture.model.provider, modelId: fixture.model.id } },
  });
  t.after(async () => { await unit.close(); await rm(directory, { recursive: true, force: true }); });

  const view = await unit.read();
  const USER_TEXT = '请按这两个引用继续。';
  const receipt = await unit.submit({
    target: view.target,
    operationId: 'with-references',
    text: USER_TEXT,
    references: [fileRef, skillRef],
    mode: 'steer',
    expected: view.control,
  });
  assert.equal(receipt.status, 'accepted');

  await until(() => fixture.requests.length === 1);
  const messages = fixture.requests[0]!.messages as Array<{ role: string; content: unknown }>;
  const userMessage = messages.find((m) => m.role === 'user');
  const blocks = userMessage?.content;
  assert.ok(Array.isArray(blocks), '带引用的提交必须是内容块数组，不是被拼平的字符串');

  const texts = (blocks as Array<{ type: string; text: string }>).map((b) => b.text);
  assert.equal(texts[0], USER_TEXT, '用户原文字必须原样保留在第一块');
  assert.ok(texts.some((t) => t.includes(FILE_MARKER)), '文件真实内容必须出现在本次请求里');
  assert.ok(texts.some((t) => t.includes(SKILL_MARKER)), '技能正文必须出现在本次请求里');
  assert.ok(!texts.some((t) => t.includes(USER_TEXT) && t.includes(FILE_MARKER)), '引用不得被拼进用户原文字');
  assert.ok(texts.some((t) => t.includes('r0/src/greet.js') && t.includes(fileRef.snapshot.contentHash)), '引用块须带来源与快照身份');

  fixture.requests[0]!.finish();
});

void test('内容与快照哈希不符的引用被拒收，不进入请求', { timeout: 40000 }, async (t) => {
  const root = await fixtureWorkspace(t);
  const port = new NodeReferencePort();
  const honest = await port.capture(scope(root), 'file', 'r0/src/greet.js');
  const tampered: WorkReference = {
    ...honest,
    snapshot: { ...honest.snapshot, content: '这段内容与声明的哈希不一致' },
  };

  const directory = await mkdtemp(join(tmpdir(), 'dcode-reference-tamper-'));
  const fixture = controlledModels();
  const unit = await PiExecutionSession.open({
    directory: join(directory, 'runtime'),
    cwd: directory,
    target: { workspaceId: 'space', taskId: 'task', sessionId: 'session' },
    models: fixture.models,
    agent: { model: { provider: fixture.model.provider, modelId: fixture.model.id } },
  });
  t.after(async () => { await unit.close(); await rm(directory, { recursive: true, force: true }); });

  const view = await unit.read();
  await assert.rejects(
    // submit 在校验失败时同步抛出；用 async 包装保证断言拿到的是同一个真实拒绝。
    async () => unit.submit({ target: view.target, operationId: 'tampered', text: 'x', references: [tampered], mode: 'steer', expected: view.control }),
    /Reference content does not match its snapshot/,
  );
  await new Promise((resolve) => { setTimeout(resolve, 30); });
  assert.equal(fixture.requests.length, 0, '被拒的提交不得产生任何模型请求');
});

void test('无引用时保持既有单字符串内容，不改变既有请求形态', { timeout: 40000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dcode-reference-plain-'));
  const fixture = controlledModels();
  const unit = await PiExecutionSession.open({
    directory: join(directory, 'runtime'),
    cwd: directory,
    target: { workspaceId: 'space', taskId: 'task', sessionId: 'session' },
    models: fixture.models,
    agent: { model: { provider: fixture.model.provider, modelId: fixture.model.id } },
  });
  t.after(async () => { await unit.close(); await rm(directory, { recursive: true, force: true }); });

  const view = await unit.read();
  await unit.submit({ target: view.target, operationId: 'plain', text: '普通发送', references: [], mode: 'steer', expected: view.control });
  await until(() => fixture.requests.length === 1);
  const messages = fixture.requests[0]!.messages as Array<{ role: string; content: unknown }>;
  assert.equal(messages.find((m) => m.role === 'user')?.content, '普通发送');
  fixture.requests[0]!.finish();
});

void test('读取权限失败如实报错，不返回半成品引用', { timeout: 30000 }, async (t) => {
  if (process.getuid?.() === 0) return; // root 无视权限位，跳过该断言而不是假装通过
  const root = await fixtureWorkspace(t);
  const locked = join(root, 'locked.txt');
  await writeFile(locked, 'secret');
  await chmod(locked, 0o000);
  const port = new NodeReferencePort();
  await assert.rejects(
    () => port.capture(scope(root), 'file', 'r0/locked.txt'),
    (e: unknown) => codeOf(e) === 'permission-denied',
  );
});

/**
 * 假执行端口：按**真实 Pi 的输入身份规则**判重——submit 存下指纹，
 * lookupReceipt 指纹不一致即 conflict（src/adapters/pi/session.ts#lookup）。
 * 这里不简化成"永远 accepted"，否则产品侧漏传引用身份这类缺陷在测试里看不出来。
 */
function makeIdentityPort() {
  const control = { instanceId: 'in-memory-refresh', revision: 0 };
  let target: ExecutionTarget | null = null;
  let observations = 0;
  let phase: ExecutionView['phase'] = 'ready';
  let processing: 'queued' | 'placed' | 'done' = 'queued';
  const stored = new Map<string, string>();
  const counts = { submissions: 0, lookups: 0 };
  let nextLookup: 'normal' | 'unknown' | 'not-found' = 'normal';
  const identity = (input: { target: unknown; mode: unknown; text: unknown; references?: readonly WorkReference[] }) =>
    JSON.stringify([input.target, input.mode, input.text, referenceSetId(input.references ?? [])]);
  const port: ExecutionPort = {
    get target() { return target!; },
    async read() {
      return { target: target!, control, observation: ++observations, phase, execution: 'mock', model: null, entries: [], pendingInputs: phase === 'running' ? 1 : 0 };
    },
    async submit(value: unknown) {
      const input = value as { operationId: string };
      counts.submissions += 1;
      stored.set(input.operationId, identity(value as never));
      phase = 'running';
      processing = 'queued';
      return { status: 'accepted', operationId: input.operationId, submissionId: counts.submissions, processing };
    },
    async lookupReceipt(value: unknown) {
      const input = value as { operationId: string };
      counts.lookups += 1;
      if (nextLookup === 'unknown') {
        nextLookup = 'normal';
        return { status: 'unknown', operationId: input.operationId, reason: 'storage-unavailable' };
      }
      if (nextLookup === 'not-found') {
        nextLookup = 'normal';
        return { status: 'not-accepted', operationId: input.operationId, reason: 'not-found' };
      }
      const known = stored.get(input.operationId);
      // 与真实 Pi 端口同口径：根本没有这份输入身份是 not-found（可靠未找到），
      // 身份在但对不上才是 conflict。把两者混成 conflict 会让"可靠未找到后重投"这条路径永远走不到。
      if (known === undefined) return { status: 'not-accepted', operationId: input.operationId, reason: 'not-found' };
      if (known !== identity(value as never)) {
        return { status: 'not-accepted', operationId: input.operationId, reason: 'conflict' };
      }
      if (processing === 'queued') processing = 'placed';
      return { status: 'accepted', operationId: input.operationId, submissionId: 1, processing };
    },
    async pause() { return this.read(); },
    async resume() { return this.read(); },
    async close() {},
  };
  return {
    port, counts,
    setTarget(next: ExecutionTarget) { target = next; },
    finish() { phase = 'ready'; processing = 'done'; },
    unknownNextLookup() { nextLookup = 'unknown'; },
    notFoundNextLookup() { nextLookup = 'not-found'; },
    /** 接收端确实没有这条记录：只读查回应如实 not-found，才轮得到"按原内容重投" */
    forget(operationId: string) { stored.delete(operationId); },
    /** 记录在但身份对不上：端上按指纹判 conflict */
    corruptIdentity(operationId: string) { stored.set(operationId, 'corrupted-fingerprint'); },
  };
}

const waitFor = async (predicate: () => Promise<boolean> | boolean, message: string): Promise<void> => {
  const deadline = Date.now() + 5000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

void test('自然观测刷新按原引用身份回查：带引用的已接收发送不会被改写成 conflict', { timeout: 20000 }, async (t) => {
  const fixture = makeIdentityPort();
  const app = new DCodeApplication(
    { kind: 'pi', modelName: 'controlled-test', async open(context) { fixture.setTarget(context.target); return fixture.port; } },
    { async load() { return { status: 'missing' }; }, async save() {} },
  );
  t.after(() => app.flush());
  await app.init();
  const workspaceId = (await app.getSnapshot()).workspaces[0]!.id;
  const references: WorkReference[] = [{
    refId: 'file-refresh-1', kind: 'file', label: 'greet.js', locator: 'r0/src/greet.js', sourceId: `workspace:${workspaceId}`,
    snapshot: { contentHash: 'a'.repeat(64), byteSize: 12, capturedAt: Date.now(), truncated: false, content: 'greet body' },
  }];
  const sent = await app.sendMessage({ taskId: 'task-home-default', text: '带引用的发送', mode: 'steer', operationId: 'ref-refresh-1', references });
  assert.equal(sent.receipt.status, 'accepted', '带引用的首次发送必须被接收');
  const receiptOf = async () => {
    const block = (await app.getSnapshot()).timelines[sent.sessionId]!.find((b) => b.kind === 'message' && b.operationId === 'ref-refresh-1');
    return block?.kind === 'message' ? block.receipt : undefined;
  };
  fixture.finish();
  await waitFor(async () => {
    const r = await receiptOf();
    return r?.status === 'accepted' && r.processing === 'done';
  }, '普通观测没有把带引用发送的回执推进到 done');
  assert.equal((await receiptOf())?.status, 'accepted', '已接收事实不得被自然刷新改写成 conflict');
  assert.equal(fixture.counts.submissions, 1, '只读刷新不得重投');
  assert.ok(fixture.counts.lookups >= 1, '推进必须走只读回查通路');
});

/**
 * C6 竞态：源文件事后被删／被改时，已接收与待核对的发送都只查**原身份**，不盲重投。
 * 真实 NodeReferencePort + 真实临时文件；执行端按真实 Pi 的指纹规则判 conflict。
 */
function referenceScopeInput(workspaceId: string) {
  return { workspaceId, sessionId: 'session-race', taskId: 'task-race', operationId: 'op-race' };
}

/**
 * 竞态夹具：把**隔离临时根**真正绑成应用里的工作空间，再经公开 createTask 建任务、从该目标发送。
 *
 * 之前这里直接发到默认 Home 任务（folders 是 ["~"]），只有 capture 那一步指向隔离根；
 * 于是 retrySend 的"按原定位重取"实际读的是 `~/src/greet.js`——删/改两例可能因**错误根**恒冲突而假绿，
 * 还会碰到真实 Home。现在应用侧与端口侧用的是同一个隔离根。
 */
async function raceApp(t: TestContext, root: string) {
  const fixture = makeIdentityPort();
  const seeded = sampleState();
  seeded.workspaces = [{ id: 'ws-race', name: '竞态夹具', folders: [root], builtinHome: false, defaultTaskId: 'task-race' }];
  seeded.tasks = [];
  seeded.sessions = [];
  seeded.timelines = {};
  seeded.pendingFirstSends = {};
  const app = new DCodeApplication(
    { kind: 'pi', modelName: 'controlled-test', async open(context) { fixture.setTarget(context.target); return fixture.port; } },
    { async load() { return { status: 'ok' as const, state: seeded }; }, async save() {} },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    new NodeReferencePort(),
  );
  t.after(() => app.flush());
  await app.init();
  const task = await app.createTask({ operationId: 'create-fixture-references.test-350', workspaceId: 'ws-race', parentId: null, title: '竞态任务' });
  // 引用经应用自己的公开能力取得：scope 来自该任务所属工作空间，根就是隔离根
  const captured = await new NodeReferencePort().capture(
    { ...referenceScopeInput('ws-race'), folders: [root] }, 'file', 'r0/src/greet.js',
  );
  const sent = await app.sendMessage({
    taskId: task.id, text: '带引用的竞态发送', mode: 'steer', operationId: 'ref-race-1', references: [captured],
  });
  return { app, fixture, sent, captured, taskId: task.id };
}

const blockIdOf = (blocks: ReadonlyArray<{ id: string; kind: string; operationId?: string }>, operationId: string) =>
  blocks.find((b) => b.kind === 'message' && b.operationId === operationId)?.id ?? '';

void test('可靠未找到且原内容仍在：按原身份真正重投一次，不新建对象也不换内容', { timeout: 20000 }, async (t) => {
  const root = await fixtureWorkspace(t);
  const { app, fixture, sent } = await raceApp(t, root);
  assert.equal(sent.receipt.status, 'accepted');
  fixture.finish();
  const before = fixture.counts.submissions;
  const snap = await app.getSnapshot();
  const blockId = blockIdOf(snap.timelines[sent.sessionId] ?? [], 'ref-race-1');
  const sessionBefore = snap.sessions.length;

  // 可靠未找到：接收端确实没有这条记录（不是"下一次查回碰巧没找到"），
  // 且源文件原样还在——这时才允许按原内容重投。
  fixture.forget('ref-race-1');
  const retried = await app.retrySend({ sessionId: sent.sessionId, blockId });
  assert.equal(retried.receipt.status, 'accepted', `原内容仍在时应按原身份真正重投并被接收；`);
  assert.equal(fixture.counts.submissions, before + 1, '恰好重投一次');
  const after = await app.getSnapshot();
  assert.equal(after.sessions.length, sessionBefore, '重投不新建会话对象');
  const blocks = after.timelines[sent.sessionId] ?? [];
  assert.equal(blocks.filter((b) => b.kind === 'message' && b.operationId === 'ref-race-1').length, 1, '不产生第二条同身份消息');
  const userBlock = blocks.find((b) => b.kind === 'message' && b.role === 'user' && b.operationId === 'ref-race-1');
  assert.equal(userBlock?.kind === 'message' ? userBlock.references?.length : null, 1, '重投仍带原引用身份');
  assert.equal(userBlock?.kind === 'message' ? userBlock.references?.[0]?.locator : null, 'r0/src/greet.js');
});

void test('源文件被删：显式回查与重试都只认原接收事实，不重投也不改写', { timeout: 20000 }, async (t) => {
  const root = await fixtureWorkspace(t);
  const { app, fixture, sent } = await raceApp(t, root);
  assert.equal(sent.receipt.status, 'accepted');
  fixture.finish();
  const before = fixture.counts.submissions;
  await rm(join(root, 'src', 'greet.js'), { force: true });

  const snap = await app.getSnapshot();
  const blockId = blockIdOf(snap.timelines[sent.sessionId] ?? [], 'ref-race-1');
  const checked = await app.checkReceipt({ sessionId: sent.sessionId, blockId });
  assert.equal(checked.receipt.status, 'accepted', '只读回查不依赖源文件是否还在');
  const retried = await app.retrySend({ sessionId: sent.sessionId, blockId });
  assert.equal(retried.receipt.status, 'accepted', '已接收的发送不因源文件被删而变成 conflict');
  assert.equal(fixture.counts.submissions, before, '两条通路都不得重投');
});

void test('身份不符（错指纹）与真实 conflict 仍不重投', { timeout: 20000 }, async (t) => {
  const root = await fixtureWorkspace(t);
  const { app, fixture, sent } = await raceApp(t, root);
  assert.equal(sent.receipt.status, 'accepted');
  fixture.finish();
  const before = fixture.counts.submissions;
  const snap = await app.getSnapshot();
  const blockId = blockIdOf(snap.timelines[sent.sessionId] ?? [], 'ref-race-1');

  // 记录在，但身份对不上：端上按指纹判 conflict，不重投、不改写
  fixture.corruptIdentity('ref-race-1');
  const conflicted = await app.retrySend({ sessionId: sent.sessionId, blockId });
  assert.deepEqual(conflicted.receipt, { status: 'not-accepted', operationId: 'ref-race-1', reason: 'conflict' });
  assert.equal(fixture.counts.submissions, before, '身份不符不得重投');
});

void test('回查结果未知：不盲重投，源文件状态不参与判断', { timeout: 20000 }, async (t) => {
  const root = await fixtureWorkspace(t);
  const { app, fixture, sent } = await raceApp(t, root);
  assert.equal(sent.receipt.status, 'accepted');
  fixture.finish();
  const before = fixture.counts.submissions;
  await rm(join(root, 'src', 'greet.js'), { force: true });

  const blockId = blockIdOf((await app.getSnapshot()).timelines[sent.sessionId] ?? [], 'ref-race-1');
  fixture.unknownNextLookup();
  const retried = await app.retrySend({ sessionId: sent.sessionId, blockId });
  assert.equal(retried.receipt.status, 'unknown', '未知就如实报未知，不当成未接收');
  assert.equal(fixture.counts.submissions, before, '未知不得触发重投');
});

void test('可靠未找到且源文件已删/已改：按原身份判冲突，不拿现状内容重投', { timeout: 20000 }, async (t) => {
  for (const mutate of [
    async (root: string) => { await rm(join(root, 'src', 'greet.js'), { force: true }); },
    async (root: string) => { await writeFile(join(root, 'src', 'greet.js'), 'export const greeting = "换过的内容";'); },
  ]) {
    const root = await fixtureWorkspace(t);
    const { app, fixture, sent } = await raceApp(t, root);
    assert.equal(sent.receipt.status, 'accepted');
    fixture.finish();
    const before = fixture.counts.submissions;
    await mutate(root);

    const blockId = blockIdOf((await app.getSnapshot()).timelines[sent.sessionId] ?? [], 'ref-race-1');
    fixture.forget('ref-race-1');
    const retried = await app.retrySend({ sessionId: sent.sessionId, blockId });
    assert.deepEqual(retried.receipt, { status: 'not-accepted', operationId: 'ref-race-1', reason: 'conflict' },
      '可靠未找到才谈重投；源内容已变就是另一份输入');
    assert.equal(fixture.counts.submissions, before, '不得把改过的内容当原内容重投');
  }
});

/**
 * P1-1 授权反例：成员会话（kind=sub）的分工范围尚未装配时，**调用读取端口之前**就拒。
 * 计数端口证明被拒路径上读取与提交各 0 次；主会话的引用照常可用。
 */
void test('成员会话的引用在调端口前被拒：读取与提交端口调用数均为 0，主会话不受影响', { timeout: 20000 }, async (t) => {
  const root = await fixtureWorkspace(t);
  const fixture = makeIdentityPort();
  const counts = { reads: 0, submits: 0 };
  const inner = new NodeReferencePort();
  const countingPort = {
    list: async (request: Parameters<typeof inner.list>[0]) => { counts.reads += 1; return inner.list(request); },
    capture: async (...args: Parameters<typeof inner.capture>) => { counts.reads += 1; return inner.capture(...args); },
  };
  const seeded = sampleState();
  seeded.workspaces = [{ id: 'ws-auth', name: '授权夹具', folders: [root], builtinHome: false, defaultTaskId: 'task-auth' }];
  seeded.tasks = [];
  seeded.sessions = [];
  seeded.timelines = {};
  seeded.pendingFirstSends = {};
  const backend = {
    kind: 'pi' as const, modelName: 'controlled-test',
    async open(context: { target: unknown }) { fixture.setTarget(context.target as never); return fixture.port; },
  };
  const submitsBefore = fixture.counts.submissions;
  const app = new DCodeApplication(backend, {
    async load() { return { status: 'ok' as const, state: seeded }; }, async save() {},
  }, undefined, undefined, undefined, undefined, undefined, countingPort);
  t.after(() => app.flush());
  await app.init();
  const task = await app.createTask({ operationId: 'create-fixture-references.test-487', workspaceId: 'ws-auth', parentId: null, title: '授权任务' });
  const main = (await app.getSnapshot()).sessions.find(item => item.id === task.mainSessionId)!;
  const sub = await app.createSession({ taskId: task.id }); // 已有会话后再建 → kind = sub
  assert.equal(sub.kind, 'sub', '夹具前提：第二个会话是成员会话');

  // 主会话可用（先跑一次，确保后面的 0 不是因为整套能力都没装配）
  const mainListing = await app.listReferences({ sessionId: main.id, operationId: 'auth-main-1' });
  assert.ok(mainListing.files.length > 0, '主会话引用发现正常');
  const mainCapture = await app.captureReference({ sessionId: main.id, kind: 'file', locator: 'r0/src/greet.js', operationId: 'auth-main-2' });
  assert.equal(mainCapture.locator, 'r0/src/greet.js');
  const readsAfterMain = counts.reads;

  await assert.rejects(
    () => app.listReferences({ sessionId: sub.id, operationId: 'auth-sub-1' }),
    /尚未装配/,
    '成员会话的发现必须在调端口前被拒',
  );
  await assert.rejects(
    () => app.captureReference({ sessionId: sub.id, kind: 'file', locator: 'r0/src/greet.js', operationId: 'auth-sub-2' }),
    /尚未装配/,
    '成员会话的捕获必须在调端口前被拒',
  );
  assert.equal(counts.reads, readsAfterMain, '被拒的发现/捕获不得触达读取端口');

  await assert.rejects(
    () => app.sendMessage({
      sessionId: sub.id, text: '成员会话带引用发送', mode: 'steer', operationId: 'auth-sub-3', references: [mainCapture],
    }),
    /尚未装配/,
    '成员会话的带引用提交必须被拒',
  );
  assert.equal(fixture.counts.submissions, submitsBefore, '被拒的带引用提交不得触达提交端口');

  // 无引用的普通发送不受影响：那属于成员授权片，不在本片范围。
  const plain = await app.sendMessage({ sessionId: sub.id, text: '成员会话普通发送', mode: 'steer', operationId: 'auth-sub-4' });
  assert.equal(plain.receipt.status, 'accepted', '无引用发送不受引用授权影响');
});

/**
 * P1-2 根身份反例：根身份按绑定列表位置固定。
 * A/B 同时在列 → A 失效 → B 必须留在 r1；A 的旧定位必须取不到，且不得指向 B 的同名文件。
 */
void test('根失效不让后根前移：旧定位取不到，其余根的定位与同名文件不受影响', { timeout: 30000 }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'dcode-roots-'));
  t.after(async () => { await rm(base, { recursive: true, force: true }); });
  const dirA = join(base, 'A');
  const dirB = join(base, 'B');
  await mkdir(join(dirA, 'src'), { recursive: true });
  await mkdir(join(dirB, 'src'), { recursive: true });
  // 两个根下同名同内容：按旧编号，r0/src/same.js 会因为"前移"而读到 B 的文件且看不出差别
  await writeFile(join(dirA, 'src', 'same.js'), 'export const from = "A";\n');
  await writeFile(join(dirB, 'src', 'same.js'), 'export const from = "A";\n');
  await writeFile(join(dirA, 'src', 'only-a.js'), 'export const only = "A";\n');
  await writeFile(join(dirB, 'src', 'only-b.js'), 'export const only = "B";\n');

  const port = new NodeReferencePort();
  const request = { ...scope(base), folders: [dirA, dirB] };
  const first = await port.list(request);
  assert.deepEqual(
    first.files.filter((f) => f.locator === 'r0/src/only-a.js' || f.locator === 'r1/src/only-b.js').map((f) => f.locator).sort(),
    ['r0/src/only-a.js', 'r1/src/only-b.js'],
    'A/B 各按绑定位置取身份',
  );

  // A 失效（目录被删）：B 必须留在 r1，不能前移成 r0
  await rm(dirA, { recursive: true, force: true });
  const second = await port.list(request);
  assert.equal(second.files.some((f) => f.locator === 'r1/src/only-b.js'), true, 'B 仍在自己的位置 r1');
  assert.equal(second.files.some((f) => f.locator === 'r0/src/only-b.js'), false, 'B 不得前移到 r0');
  assert.equal(second.files.some((f) => f.locator.startsWith('r0/')), false, '失效根不再产出任何定位');

  // 旧定位必须取不到；即使两个根有同名文件，也不能把 A 的旧定位解释成 B 的文件
  await assert.rejects(
    () => port.capture(request, 'file', 'r0/src/same.js'),
    (e: unknown) => codeOf(e) === 'outside-root',
    '失效根的旧定位必须失败，而不是落到另一个根',
  );
  const fromB = await port.capture(request, 'file', 'r1/src/same.js');
  assert.equal(fromB.snapshot.content, 'export const from = "A";\n');
  assert.equal(fromB.sourceId, `workspace:${request.workspaceId}`);
});

/**
 * P1-3 越界读取反例：SDK 遍历**之前**挡掉逃出工作空间根的入口。
 * 两类入口各用一组隔离临时根验证——目录符号链接与 SKILL.md 文件符号链接；
 * 根外的正文既不出现在发现结果里，也取不到；同一套根里合法的技能照常可用。
 */
void test('技能目录里的越界链接在发现前被挡：根外正文不呈现也取不到，根内合法技能照常可用', { timeout: 30000 }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'dcode-escape-'));
  t.after(async () => { await rm(base, { recursive: true, force: true }); });
  const outside = join(base, 'outside');
  await mkdir(join(outside, 'evil-skill'), { recursive: true });
  await writeFile(join(outside, 'evil-skill', 'SKILL.md'), '---\nname: evil\ndescription: 根外技能\n---\n\nDIR-LINK-MARKER\n');
  await writeFile(join(outside, 'loose.md'), '---\nname: leaky\ndescription: 根外文件\n---\n\nFILE-LINK-MARKER\n');

  // 每个逃逸根里再放一个**畸形技能**（缺 description）：SDK 读到它必然产生诊断。
  // 于是"SDK 有没有被调用"就有了可观察的判据——只在事后过滤 SDK 输出的话，
  // 它照样会把根外正文读完并给出这些诊断，结果看着对，越界读取却已经发生。
  const dirLinkRoot = join(base, 'dir-link-root');
  await mkdir(join(dirLinkRoot, '.pi', 'skills', 'malformed'), { recursive: true });
  await writeFile(join(dirLinkRoot, '.pi', 'skills', 'malformed', 'SKILL.md'), '---\nname: malformed\n---\n\n没有 description\n');
  await symlink(join(outside, 'evil-skill'), join(dirLinkRoot, '.pi', 'skills', 'linked-skill'), 'dir');

  const fileLinkRoot = join(base, 'file-link-root');
  await mkdir(join(fileLinkRoot, '.pi', 'skills', 'leaky'), { recursive: true });
  await mkdir(join(fileLinkRoot, '.pi', 'skills', 'malformed'), { recursive: true });
  await writeFile(join(fileLinkRoot, '.pi', 'skills', 'malformed', 'SKILL.md'), '---\nname: malformed\n---\n\n没有 description\n');
  await symlink(join(outside, 'loose.md'), join(fileLinkRoot, '.pi', 'skills', 'leaky', 'SKILL.md'), 'file');

  const legalRoot = join(base, 'legal-root');
  await mkdir(join(legalRoot, '.pi', 'skills', 'inside'), { recursive: true });
  await writeFile(join(legalRoot, '.pi', 'skills', 'inside', 'SKILL.md'), '---\nname: inside\ndescription: 根内合法技能\n---\n\nINSIDE-MARKER\n');

  const port = new NodeReferencePort();
  for (const [root, marker, locator] of [
    [dirLinkRoot, 'DIR-LINK-MARKER', 'r0/.pi/skills/linked-skill/SKILL.md'],
    [fileLinkRoot, 'FILE-LINK-MARKER', 'r0/.pi/skills/leaky/SKILL.md'],
  ] as const) {
    const request = { ...scope(root), folders: [root] };
    const listing = await port.list(request);
    const serialized = JSON.stringify(listing);
    assert.equal(serialized.includes(marker), false, `根外正文不得出现在发现结果里（${marker}）`);
    assert.equal(listing.skills.length, 0, '存在越界入口时该根不产出任何技能');
    assert.ok(
      listing.issues.some((issue) => issue.code === 'outside-root'),
      '越界入口必须如实报告',
    );
    // 关键判据：SDK 根本没有在这个目录上跑过（它跑过就必然对畸形技能给出诊断）。
    assert.equal(
      listing.issues.some((issue) => issue.code === 'skills-unavailable'),
      false,
      '越界入口必须在 SDK 遍历之前挡住；事后过滤它的输出已经太晚',
    );
    await assert.rejects(
      () => port.capture(request, 'skill', locator),
      (e: unknown) => codeOf(e) === 'outside-root',
      `越界链接指向的技能取不到（${marker}）`,
    );
  }

  const legalRequest = { ...scope(legalRoot), folders: [legalRoot] };
  // 合法根里也放一个畸形技能：证明上面那条"没有 SDK 诊断"的判据不是恒真。
  await mkdir(join(legalRoot, '.pi', 'skills', 'malformed'), { recursive: true });
  await writeFile(join(legalRoot, '.pi', 'skills', 'malformed', 'SKILL.md'), '---\nname: malformed\n---\n\n没有 description\n');
  const legalListing = await port.list(legalRequest);
  assert.deepEqual(legalListing.skills.map((s) => s.label), ['inside'], '根内合法技能照常可用');
  assert.equal(
    legalListing.issues.some((issue) => issue.code === 'skills-unavailable'),
    true,
    '合法根里 SDK 确实跑过并报告了畸形技能——上一条判据因此不是恒真',
  );
  const legalCapture = await port.capture(legalRequest, 'skill', 'r0/.pi/skills/inside/SKILL.md');
  assert.match(legalCapture.snapshot.content, /INSIDE-MARKER/, '合法技能能取到真实正文');
});

/**
 * P1-3 续：目录预审**没审完**时不能当安全。
 *
 * 上一版 `auditSkillEntries` 在 `readdir` 抛错时直接 `return null`，等于宣布"审过且没有越界入口"，
 * SDK 于是照着走进那个目录——预审形同虚设。而超预算/层级超限又被一律报成 `outside-root`，
 * 把可修的真实原因伪装成"有东西跑出去了"。
 *
 * 用可观察判据证明 SDK 没有被调用：每个夹具根里都放一个**畸形技能**（缺 description），
 * SDK 读到它必然产生 `skills-unavailable` 诊断；同一批里的合法根同样有畸形技能且**确实**有该诊断，
 * 所以"没有诊断"不是恒真。
 */
void test('目录预审没审完就不进 SDK：真实原因分别报告，合法文件链接与合法目录照常可用', { timeout: 30000 }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'dcode-audit-incomplete-'));
  t.after(async () => { await chmod(join(base, 'perm-root', '.pi', 'skills', 'locked'), 0o755).catch(() => undefined); await rm(base, { recursive: true, force: true }); });

  const malformed = (root: string, at = 'malformed') => {
    const dir = join(root, '.pi', 'skills', at);
    return mkdir(dir, { recursive: true }).then(() => writeFile(join(dir, 'SKILL.md'), '---\nname: malformed\n---\n\n没有 description\n'));
  };

  // ① 无权限目录：预审在这一层就断了，后面的内容根本没被看过
  const permRoot = join(base, 'perm-root');
  await malformed(permRoot);
  await mkdir(join(permRoot, '.pi', 'skills', 'locked'), { recursive: true });
  await chmod(join(permRoot, '.pi', 'skills', 'locked'), 0o000);
  // 环境若不强制目录权限（root / 某些挂载），这一条就无从证明：先探，再决定是否纳入断言。
  const permissionEnforced = await readdir(join(permRoot, '.pi', 'skills', 'locked')).then(() => false, () => true);
  t.diagnostic(`目录权限在本机${permissionEnforced ? '生效' : '不生效（跳过 permission-denied 断言）'}`);

  // ② 层级超预算：目录合法可读，但预审在到达畸形技能之前就停了
  const deepRoot = join(base, 'deep-root');
  let deep = join(deepRoot, '.pi', 'skills', 'legal');
  for (let i = 0; i < 8; i += 1) deep = join(deep, `d${i}`);
  await mkdir(deep, { recursive: true });
  await writeFile(join(deep, 'SKILL.md'), '---\nname: too-deep\ndescription: 深到审不完\n---\n\nDEEP-MARKER\n');
  await malformed(deepRoot);

  const port = new NodeReferencePort();
  const sdkRan = (listing: { issues: readonly { code: string }[] }) => listing.issues.some((issue) => issue.code === 'skills-unavailable');

  if (permissionEnforced) {
    const listing = await port.list({ ...scope(permRoot), folders: [permRoot] });
    assert.equal(sdkRan(listing), false, '目录读不到时预审没审完，SDK 不得进入');
    assert.equal(listing.skills.length, 0, '没审完就不产出任何技能');
    assert.ok(
      listing.issues.some((issue) => issue.code === 'permission-denied' || issue.code === 'unreadable'),
      '无权限必须按真实原因报告，不能报成 outside-root',
    );
    assert.equal(
      listing.issues.some((issue) => issue.code === 'outside-root'),
      false,
      '没有东西逃出根，就不该报 outside-root',
    );
  }

  const deepListing = await port.list({ ...scope(deepRoot), folders: [deepRoot] });
  assert.equal(sdkRan(deepListing), false, '层级超预算时预审没审完，SDK 不得进入');
  assert.equal(deepListing.skills.length, 0, '没审完就不产出任何技能');
  assert.ok(
    deepListing.issues.some((issue) => issue.code === 'too-large'),
    `层级超限必须报 too-large（实得 ${deepListing.issues.map((i) => i.code).join(',')}），不能一律说成 outside-root`,
  );
  assert.equal(
    deepListing.issues.some((issue) => issue.code === 'outside-root'),
    false,
    '超限不是越界',
  );

  // ③ 条目预算必须**跨递归累计**：每一层单独看都没超预算，加起来超了才算"没审完"。
  // 若预算不共享，每层各自重新给满额度，深层目录就能把总量顶穿——这一条专抓那个缺口。
  const budgetRoot = join(base, 'budget-root');
  const buckets: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    const bucket = join(budgetRoot, '.pi', 'skills', `b${i}`);
    await mkdir(bucket, { recursive: true });
    buckets.push(bucket);
  }
  // 畸形技能放在最后一层：预算若没触发，预审会一路读完并让 SDK 跑起来给出诊断。
  await malformed(budgetRoot, 'b4/malformed');
  for (const bucket of buckets) {
    await Promise.all(Array.from({ length: 1000 }, (_, i) => writeFile(join(bucket, `e${i}.md`), 'x')));
  }

  const budgetListing = await port.list({ ...scope(budgetRoot), folders: [budgetRoot] });
  assert.equal(sdkRan(budgetListing), false, '条目预算累计超限时预审没审完，SDK 不得进入');
  assert.ok(
    budgetListing.issues.some((issue) => issue.code === 'too-large'),
    `条目预算超限必须报 too-large（实得 ${budgetListing.issues.map((i) => i.code).join(',')}）`,
  );
  assert.equal(
    budgetListing.issues.some((issue) => issue.code === 'outside-root'),
    false,
    '条目超限不是越界',
  );

  // ④ 根内链接环：`.pi/skills/loop` 指回 `.pi/skills` 本身。重入防护到位时**不该**报层级超限，
  //    合法技能照常可用——否则一个完全在根内的结构会被误报成"审不完"，把技能全丢掉。
  const loopRoot = join(base, 'loop-root');
  await mkdir(join(loopRoot, '.pi', 'skills', 'ok'), { recursive: true });
  await writeFile(join(loopRoot, '.pi', 'skills', 'ok', 'SKILL.md'), '---\nname: loopok\ndescription: 环旁边的合法技能\n---\n\nLOOP-OK-MARKER\n');
  await symlink(join(loopRoot, '.pi', 'skills'), join(loopRoot, '.pi', 'skills', 'loop'), 'dir');
  const loopListing = await port.list({ ...scope(loopRoot), folders: [loopRoot] });
  assert.equal(
    loopListing.issues.some((issue) => issue.code === 'too-large'),
    false,
    `根内链接环不是"审不完"，不应报 too-large（实得 ${loopListing.issues.map((i) => i.code).join(',')}）`,
  );
  assert.ok(
    loopListing.skills.length > 0 && loopListing.skills.every((s) => s.label === 'loopok'),
    `环旁边的合法技能照常可用（实得 ${loopListing.skills.map((s) => s.label).join(',')}）`,
  );
  // 附带观察（不作为断言）：SDK 沿环会重复发现同名技能，这是它自己的发现规则的产物。
  t.diagnostic(`根内环下 SDK 返回的技能条目数：${loopListing.skills.length}`);

  // ⑤ 链接指向工作空间根**本身**：它在根内（不是 outside-root），但已经跳出技能子树，
  //    预算内审不完——必须按真实成因说，不能含糊成"审完了"。
  const rootLinkRoot = join(base, 'root-link-root');
  await malformed(rootLinkRoot);
  await symlink(rootLinkRoot, join(rootLinkRoot, '.pi', 'skills', 'self-root'), 'dir');
  const rootLinkListing = await port.list({ ...scope(rootLinkRoot), folders: [rootLinkRoot] });
  assert.equal(sdkRan(rootLinkListing), false, '链接指向工作空间根时已跳出可审范围，SDK 不得进入');
  assert.ok(
    rootLinkListing.issues.some((issue) => issue.code === 'too-large'),
    `指向根的链接必须报 too-large（实得 ${rootLinkListing.issues.map((i) => i.code).join(',')}）`,
  );
  assert.equal(
    rootLinkListing.issues.some((issue) => issue.code === 'outside-root'),
    false,
    '指向工作空间根的链接确实在根内，不是越界',
  );

  // ⑥ 链接解析失败（非 ENOENT）：自指链接让 realpath 抛 ELOOP，判不出指向就不放行。
  const eloopRoot = join(base, 'eloop-root');
  await malformed(eloopRoot);
  await mkdir(join(eloopRoot, '.pi', 'skills', 'self'), { recursive: true });
  await symlink(join(eloopRoot, '.pi', 'skills', 'self', 'ping'), join(eloopRoot, '.pi', 'skills', 'self', 'ping'), 'dir');
  const eloopListing = await port.list({ ...scope(eloopRoot), folders: [eloopRoot] });
  assert.equal(sdkRan(eloopListing), false, '链接解析失败（非断链）时判不出指向，SDK 不得进入');
  assert.ok(
    eloopListing.issues.some((issue) => issue.code === 'unreadable'),
    `链接解析失败必须报 unreadable（实得 ${eloopListing.issues.map((i) => i.code).join(',')}）`,
  );

  // ⑥ 目录链接分支的预算也要累计：上一条只钉住了普通目录分支。
  const linkBudgetRoot = join(base, 'link-budget-root');
  const linkDirs: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    const dir = join(linkBudgetRoot, `shared${i}`);
    await mkdir(dir, { recursive: true });
    linkDirs.push(dir);
  }
  await malformed(linkBudgetRoot, 'zz-malformed');
  await Promise.all(linkDirs.map((dir) =>
    Promise.all(Array.from({ length: 1200 }, (_, i) => writeFile(join(dir, `e${i}.md`), 'x'))),
  ));
  // 每个目录链接各自只有 1200 条目（单层不超预算），加总才超。
  for (const dir of linkDirs) {
    await symlink(dir, join(linkBudgetRoot, '.pi', 'skills', `link-${dir.slice(-1)}`), 'dir');
  }
  const linkBudgetListing = await port.list({ ...scope(linkBudgetRoot), folders: [linkBudgetRoot] });
  assert.equal(sdkRan(linkBudgetListing), false, '目录链接分支的预算也必须累计，SDK 不得进入');
  assert.ok(
    linkBudgetListing.issues.some((issue) => issue.code === 'too-large'),
    `目录链接累计超预算必须报 too-large（实得 ${linkBudgetListing.issues.map((i) => i.code).join(',')}）`,
  );

  // ⑦ 非 EACCES 的 readdir 失败（遍历中途目标消失一类）。用"把目录换成文件"无法稳定构造，
  //    这里改用进程 fd 耗尽（EMFILE）——同样是 readdir 的非权限失败，且能力可探测。
  const emfileRoot = join(base, 'emfile-root');
  await malformed(emfileRoot);
  const probe = join(base, '.fd-probe');
  const exhaust: number[] = [];
  let emfileEnforced = false;
  try {
    for (;;) exhaust.push(openSync(probe, 'w'));
  } catch {
    emfileEnforced = true;
  } finally {
    for (const fd of exhaust) closeSync(fd);
  }
  t.diagnostic(`fd 耗尽在本机${emfileEnforced ? '生效' : '不生效（跳过 EMFILE 断言）'}`);
  if (emfileEnforced) {
    const held: number[] = [];
    try {
      for (;;) held.push(openSync(probe, 'w'));
    } catch {
      // 保持耗尽状态，下面这一次 list 的 readdir 就会拿到 EMFILE
    }
    try {
      const emfileListing = await port.list({ ...scope(emfileRoot), folders: [emfileRoot] });
      assert.equal(sdkRan(emfileListing), false, 'readdir 因 fd 耗尽失败时预审没审完，SDK 不得进入');
      assert.ok(
        emfileListing.issues.some((issue) => issue.code === 'unreadable'),
        `非权限的 readdir 失败必须报 unreadable 而不是 permission-denied（实得 ${emfileListing.issues.map((i) => i.code).join(',')}）`,
      );
    } finally {
      for (const fd of held) closeSync(fd);
    }
  }

  // ⑧ 链接目标的 stat 失败（公共路径证据）。这一条此前**没有任何夹具真正走到**：
  //    去掉普通目录递归会让 M3 转红，只能证明"正常目录需要递归"，证明不了失败处理器被调用。
  //    这里用端口的测试接缝注入可辨的 errno，经**同一个公开 NodeReferencePort.list** 观察
  //    实际原因码与 SDK 是否进入；不做真实权限改动，也不新增产品权限模式。
  const statRoot = join(base, 'stat-root');
  await mkdir(join(statRoot, '.pi', 'skills', 'ok'), { recursive: true });
  await writeFile(join(statRoot, '.pi', 'skills', 'ok', 'SKILL.md'), '---\nname: statok\ndescription: 合法技能\n---\n\nSTAT-OK-MARKER\n');
  // 畸形技能：SDK 一旦进入这个根就必然产生 skills-unavailable 诊断，
  // 于是"没有诊断"才是有意义的断言——不放它，上面几条会恒真。
  await malformed(statRoot, 'malformed');
  const linkedDir = join(statRoot, 'shared');
  await mkdir(linkedDir, { recursive: true });
  await writeFile(join(linkedDir, 'shared-skill.md'), '---\nname: shared\ndescription: 链接目标\n---\n\nSHARED-MARKER\n');
  await symlink(linkedDir, join(statRoot, '.pi', 'skills', 'linked-dir'), 'dir');

  // 比较用 realpath 后的真实路径：临时根在 /var 下，而 /var 本身是符号链接，
  // 预审拿到的是解析后的串，拿原串比会永远不相等（等于这条夹具验的是别处）。
  const linkedDirReal = await realpath(linkedDir);

  /** 只让链接目标的 stat 按指定 errno 失败；其余一切走真实 fs.stat。 */
  const statFailing = (errno: string) => {
    const calls: string[] = [];
    const fn: StatLike = async (path) => {
      if (path === linkedDirReal) {
        calls.push(path);
        const error = new Error(`注入：stat ${errno}`) as NodeJS.ErrnoException;
        error.code = errno;
        throw error;
      }
      return stat(path);
    };
    return { fn, calls };
  };

  for (const [errno, expected] of [['EACCES', 'permission-denied'], ['EPERM', 'permission-denied'], ['ELOOP', 'unreadable'], ['EMFILE', 'unreadable']] as const) {
    const injected = statFailing(errno);
    const listing = await new NodeReferencePort({ stat: injected.fn }).list({ ...scope(statRoot), folders: [statRoot] });
    assert.deepEqual(injected.calls, [linkedDirReal], `${errno} 注入必须真的打到链接目标的 stat 上（否则这条用例验的是别处）`);
    assert.equal(sdkRan(listing), false, `stat ${errno} 时预审没审完，SDK 不得进入`);
    assert.equal(listing.skills.length, 0, `stat ${errno} 时不产出任何技能`);
    assert.ok(
      listing.issues.some((issue) => issue.code === expected),
      `stat ${errno} 必须报 ${expected}（实得 ${listing.issues.map((i) => i.code).join(',')}）`,
    );
    assert.equal(
      listing.issues.some((issue) => issue.code === 'outside-root'),
      false,
      '链接在根内，元数据读不到不是越界',
    );
  }

  // ENOENT 沿用既定断链策略：目标读不到任何内容，跳过即可，不因此整体放弃。
  const dangling = statFailing('ENOENT');
  const danglingListing = await new NodeReferencePort({ stat: dangling.fn }).list({ ...scope(statRoot), folders: [statRoot] });
  assert.ok(dangling.calls.length > 0, 'ENOENT 注入同样必须真的打到链接目标的 stat 上');
  assert.equal(
    danglingListing.issues.some((issue) => issue.code === 'unreadable' || issue.code === 'permission-denied'),
    false,
    '断链（ENOENT）沿用既定策略跳过，不按"审不完"整体放弃',
  );
  assert.ok(danglingListing.skills.length > 0, '断链跳过后其余合法技能照常可用');

  // 对照：stat 不注入失败时，同一夹具的链接与嵌套技能都照常发现（证明上面几条不是恒绿）。
  const control = await new NodeReferencePort().list({ ...scope(statRoot), folders: [statRoot] });
  assert.equal(sdkRan(control), true, '同一夹具在 stat 正常时 SDK 确实进入并诊断了畸形技能——上面几条"没有诊断"因此不是恒真');
  assert.ok(control.skills.length > 0, '同一夹具在 stat 正常时技能照常可用');
  assert.equal(
    control.issues.some((issue) => issue.code === 'outside-root' || issue.code === 'unreadable' || issue.code === 'permission-denied' || issue.code === 'too-large'),
    false,
    `stat 正常时不该有任何预审问题（实得 ${control.issues.map((i) => `${i.code}:${i.message}`).join(' | ')}）`,
  );

  // 对照：合法根内同时有**普通文件符号链接**与**合法子目录**，都不该被判成"读不到"。
  // 这条守住的是修复本身的边界——对文件链接做目录递归会得到 ENOTDIR，
  // 若把它当成 unreadable，合法技能就会被误伤。
  const okRoot = join(base, 'ok-root');
  await malformed(okRoot);
  const shared = join(okRoot, 'shared');
  await mkdir(shared, { recursive: true });
  await writeFile(join(shared, 'shared-skill.md'), '---\nname: shared\ndescription: 根内共享正文\n---\n\nSHARED-MARKER\n');
  await mkdir(join(okRoot, '.pi', 'skills', 'nested', 'deep'), { recursive: true });
  await writeFile(join(okRoot, '.pi', 'skills', 'nested', 'deep', 'SKILL.md'), '---\nname: nested\ndescription: 根内嵌套技能\n---\n\nNESTED-MARKER\n');
  await symlink(join(shared, 'shared-skill.md'), join(okRoot, '.pi', 'skills', 'linked-skill.md'), 'file');
  await symlink(shared, join(okRoot, '.pi', 'skills', 'linked-dir'), 'dir');

  const okListing = await port.list({ ...scope(okRoot), folders: [okRoot] });
  assert.equal(sdkRan(okListing), true, '合法根里 SDK 确实跑过——上面几条"没有诊断"的断言不是恒真');
  assert.equal(
    okListing.issues.filter((issue) => issue.code === 'unreadable' || issue.code === 'permission-denied' || issue.code === 'too-large').length,
    0,
    '根内普通文件链接与合法目录都不是"读不到"，不得被误伤',
  );
  assert.deepEqual(
    okListing.skills.map((s) => s.label).sort(),
    ['nested', 'shared'],
    '根内文件链接与嵌套目录里的技能照常可用（技能名取自各自的 frontmatter）',
  );
  const linked = await port.capture({ ...scope(okRoot), folders: [okRoot] }, 'skill', 'r0/shared/shared-skill.md');
  assert.match(linked.snapshot.content, /SHARED-MARKER/, '合法文件链接的技能能取到真实正文');
});
