import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, readdir, appendFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BACKGROUND_CONTEXT as context, awaitWithContext } from '@earendil-works/chord/context';
import { createRegistry, defineTool, defineExtension, StorageRequestError, SessionFailed as Pi130SessionFailed } from '@earendil-works/pi-durable';
import { Type } from '@earendil-works/pi-ai';
import type { Storage } from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { PiExecutionSession } from '../../src/adapters/pi/index.ts';
import type { PiSessionOptions } from '../../src/adapters/pi/index.ts';
import type { WorkInput } from '../../src/contracts/index.ts';
import { controlledModels, until } from './fixtures.ts';

async function setup(t: TestContext, overrides: Partial<PiSessionOptions> = {}, expectedCloseError?: RegExp) {
  const directory = await mkdtemp(join(tmpdir(), 'dcode-pi-integration-'));
  const fixture = controlledModels();
  const options: PiSessionOptions = { directory: join(directory, 'runtime'), cwd: directory, target: { workspaceId: 'space', taskId: 'task', sessionId: 'session' }, models: fixture.models, agent: { model: { provider: fixture.model.provider, modelId: fixture.model.id } }, ...overrides };
  const units: PiExecutionSession[] = [];
  async function open() { const unit = await PiExecutionSession.open(options); units.push(unit); return unit; }
  t.after(async () => { try { for (const unit of units.reverse()) { if (expectedCloseError) await assert.rejects(unit.close(), expectedCloseError); else await unit.close(); } } finally { await rm(directory, { recursive: true, force: true }); } });
  return { directory, options, open, ...fixture };
}
async function input(unit: PiExecutionSession, operationId: string, text = 'synthetic instruction', mode: WorkInput['mode'] = 'steer', references: WorkInput['references'] = []): Promise<WorkInput> {
  const view = await unit.read();
  return { target: view.target, operationId, text, references, mode, expected: view.control };
}

await test('real Pi stores one accepted input, rejects altered retries, and looks up terminal receipts after reopen', { timeout: 15000 }, async t => {
  const s = await setup(t); const unit = await s.open(); const request = await input(unit, 'one');
  const [a, b] = await Promise.all([unit.submit(request), unit.submit(request)]);
  assert.equal(a.status, 'accepted'); assert.deepEqual(a, b);
  await until(() => s.requests.length === 1);
  assert.equal((await unit.submit({ ...request, text: 'changed' })).status, 'not-accepted');
  assert.deepEqual(await unit.submit({ ...request, mode: 'follow-up' }), { status: 'not-accepted', operationId: 'one', reason: 'conflict' });
  const body = '已完成这次修改。\n中文与 English 正文均保留。';
  s.requests[0].finish([{ type: 'text', text: '已完成这次修改。\n' }, { type: 'text', text: '中文与 English 正文均保留。' }]);
  await until(async () => { const r = await unit.lookupReceipt(request); return r.status === 'accepted' && r.processing === 'done'; });
  const assistant = (await unit.read()).entries.find(entry => entry.kind === 'pi.assistant');
  assert.ok(assistant);
  assert.equal(assistant.assistantText, body, '正式读取必须带回已提交助手正文，仅有条目种类不能证明回答可展示');
  await unit.close(); const reopened = await s.open();
  const restored = (await reopened.read()).entries.find(entry => entry.id === assistant.id);
  assert.equal(restored?.assistantText, body, '重开只读保留同一条目身份和完整正文');
  assert.deepEqual(await reopened.lookupReceipt(request), { ...a, processing: 'done' });
  assert.equal((await reopened.submit(request)).status, 'accepted');
  assert.equal(s.requests.length, 1);
  const sameTextNewInput = await input(reopened, 'two');
  assert.equal((await reopened.submit(sameTextNewInput)).status, 'accepted');
  await until(() => s.requests.length === 2); s.requests[1].finish();
});

await test('pause waits for real request cancellation; reopen/read/receipt do not run; only current explicit resume continues', { timeout: 15000 }, async t => {
  const s = await setup(t); let unit = await s.open(); const request = await input(unit, 'pause');
  await unit.submit(request); await until(() => s.requests.length === 1);
  const old = (await unit.read()).control;
  const paused = await unit.pause(); assert.equal(paused.phase, 'paused'); assert.equal(s.requests[0].settled, true);
  await assert.rejects(unit.resume(old), /Stale/);
  assert.deepEqual(await unit.submit(await input(unit, 'paused-new')), { status: 'not-accepted', operationId: 'paused-new', reason: 'paused' });
  await unit.close(); unit = await s.open();
  assert.equal((await unit.read()).phase, 'paused'); assert.equal((await unit.lookupReceipt(request)).status, 'accepted');
  await delay(40); assert.equal(s.requests.length, 1);
  await unit.resume((await unit.read()).control); await until(() => s.requests.length === 2); s.requests[1].finish();
  await until(async () => (await unit.read()).phase === 'ready');
});

await test('member pause leaves independent lead execution running and new pause invalidates a queued resume', { timeout: 15000 }, async t => {
  const lead = await setup(t); const member = await setup(t, { target: { workspaceId: 'space', taskId: 'task', sessionId: 'member' } });
  const a = await lead.open(); const b = await member.open();
  const ar = await input(a, 'lead'); const br = await input(b, 'member');
  await Promise.all([a.submit(ar), b.submit(br)]); await until(() => lead.requests.length === 1 && member.requests.length === 1);
  const paused = await b.pause(); assert.equal(lead.requests[0].settled, false);
  lead.requests[0].finish(); await until(async () => { const r = await a.lookupReceipt(ar); return r.status === 'accepted' && r.processing === 'done'; });
  const resume = b.resume(paused.control); const pause = b.pause();
  await assert.rejects(resume, /Stale|superseded/); await pause;
  assert.equal(member.requests.length, 1);
});

await test('busy steering and follow-up use Pi persisted inbox and do not abort the current model request', { timeout: 15000 }, async t => {
  const registry = createRegistry();
  registry.install(defineExtension({ name: 'checkpoint', tools: [defineTool({ name: 'checkpoint', description: 'Test a real tool boundary', parameters: Type.Object({}), execute: async () => ({ output: [{ type: 'text', text: 'tool boundary reached' }] }) })] }));
  const s = await setup(t, { registry }); const unit = await s.open();
  await unit.submit(await input(unit, 'first')); await until(() => s.requests.length === 1);
  const steer = await input(unit, 'steer', 'steering input', 'steer');
  const follow = await input(unit, 'follow', 'follow-up input', 'follow-up');
  assert.equal((await unit.submit(steer)).status, 'accepted'); assert.equal((await unit.submit(follow)).status, 'accepted');
  assert.equal(s.requests[0].settled, false); assert.equal(s.requests.length, 1);
  // 两种输入只有跨工具轮与最终回复边界时才分流；纯最终回答会一起接收，不能硬假设三次请求。
  s.requests[0].finish([{ type: 'toolCall', id: 'checkpoint-one', name: 'checkpoint', arguments: {} }], 'toolUse'); await until(() => s.requests.length === 2);
  assert.match(JSON.stringify(s.requests[1].messages), /steering input/); assert.doesNotMatch(JSON.stringify(s.requests[1].messages), /follow-up input/); s.requests[1].finish();
  await until(() => s.requests.length === 3); assert.match(JSON.stringify(s.requests[2].messages), /follow-up input/); s.requests[2].finish();
  await until(async () => { const r = await unit.lookupReceipt(follow); return r.status === 'accepted' && r.processing === 'done'; });
});

await test('actual Pi coding tools write and read a real isolated file before history is reopened', { timeout: 15000 }, async t => {
  const registry = createRegistry(); registry.install(CodingTools);
  const s = await setup(t, { registry, env: target => new NodeExecutionEnv({ cwd: target.cwd ?? '.' }) });
  const unit = await s.open(); const request = await input(unit, 'file'); await unit.submit(request);
  await until(() => s.requests.length === 1);
  s.requests[0].finish([{ type: 'toolCall', id: 'write-one', name: 'write', arguments: { path: join(s.directory, 'result.txt'), content: 'created by a real Pi tool' } }], 'toolUse');
  await until(() => s.requests.length === 2);
  assert.equal(await readFile(join(s.directory, 'result.txt'), 'utf8'), 'created by a real Pi tool');
  s.requests[1].finish([{ type: 'toolCall', id: 'read-one', name: 'read', arguments: { path: join(s.directory, 'result.txt') } }], 'toolUse');
  await until(() => s.requests.length === 3); assert.match(JSON.stringify(s.requests[2].messages), /created by a real Pi tool/); s.requests[2].finish();
  await until(async () => { const r = await unit.lookupReceipt(request); return r.status === 'accepted' && r.processing === 'done'; });
  await unit.close(); const reopened = await s.open();
  assert.equal((await reopened.read()).entries.filter(e => e.kind === 'pi.tool-result').length, 2);
  assert.equal(s.requests.length, 3);
});

function faultStorage(state: { mode: 'none' | 'reject' | 'after-commit' | 'pause'; fired: boolean }): PiSessionOptions['openStorage'] {
  return async directory => {
    const storage = await openNodeJsonlStorage(directory, context, { fsync: true });
    return new Proxy(storage, { get(target, key) {
      if (key === 'commit') return (async (writes, ctx) => {
        const trigger = !state.fired && state.mode !== 'none' && (state.mode === 'pause' || writes.some(write => write.type === 'submission'));
        if (trigger) { state.fired = true; if (state.mode === 'reject' || state.mode === 'pause') throw new StorageRequestError('injected rejection before durable write'); }
        const seq = await target.commit(writes, ctx);
        if (trigger && state.mode === 'after-commit') throw new Error('injected response loss after actual commit');
        return seq;
      }) satisfies Storage['commit'];
      const value: unknown = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
}

await test('commit failure is unknown until reliable readonly lookup; lost commit response retains accepted identity', { timeout: 15000 }, async t => {
  for (const mode of ['reject', 'after-commit'] as const) {
    const state: Parameters<typeof faultStorage>[0] = { mode: 'none', fired: false };
    const s = await setup(t, { openStorage: faultStorage(state) }); const unit = await s.open();
    const request = await input(unit, mode); state.mode = mode;
    const receipt = await unit.submit(request);
    assert.equal(receipt.status, 'unknown', '1.3 commit前异常同样使Session失败，当下不能断言未接收');
    const lookup = await unit.lookupReceipt(request);
    assert.equal(lookup.status, mode === 'reject' ? 'not-accepted' : 'accepted');
    await unit.close(); const reopened = await s.open();
    assert.equal((await reopened.lookupReceipt(request)).status, lookup.status);
    if (mode === 'after-commit') { await delay(30); assert.equal(s.requests.length, 0); await reopened.resume((await reopened.read()).control); await until(() => s.requests.length === 1); s.requests[0].finish(); }
  }
});

await test('pause persistence failure still closes model request and does not report a saved pause', { timeout: 15000 }, async t => {
  const state: Parameters<typeof faultStorage>[0] = { mode: 'none', fired: false };
  const s = await setup(t, { openStorage: faultStorage(state) }); const unit = await s.open();
  await unit.submit(await input(unit, 'pause-error')); await until(() => s.requests.length === 1);
  state.mode = 'pause'; await assert.rejects(unit.pause(), /could not confirm/);
  assert.equal(s.requests[0].settled, true); assert.equal(s.requests.length, 1);
});

await test('malformed and wrong-target requests fail before admission; one directory cannot have two live owners', { timeout: 15000 }, async t => {
  const s = await setup(t); const unit = await s.open(); const request = await input(unit, 'validation');
  assert.throws(() => unit.submit({ ...request, mode: 'invented' }), /Invalid/);
  assert.throws(() => unit.submit({ ...request, target: { ...request.target, sessionId: 'wrong' } }), /another session/);
  await assert.rejects(PiExecutionSession.open(s.options), /live owner/);
  assert.equal(s.requests.length, 0);
  await unit.close();
  const before = await journal(s.options.directory);
  await assert.rejects(PiExecutionSession.open({ ...s.options, target: { ...s.options.target, taskId: 'wrong' } }), /different target/);
  assert.deepEqual(await journal(s.options.directory), before);
  const reopened = await s.open(); assert.equal((await reopened.read()).entries.length, 0);
});
async function journal(directory: string): Promise<string[]> {
  const files = (await readdir(directory, { withFileTypes: true })).filter(file => file.isFile()).map(file => file.name).sort();
  return Promise.all(files.map(async file => `${file}:${await readFile(join(directory, file), 'utf8')}`));
}

for (const replay of ['safe', 'unsafe'] as const) {
  await test(`interrupted ${replay} tool follows Pi replay policy without undoing side effects`, { timeout: 15000 }, async t => {
    let calls = 0; let file = '';
    const registry = createRegistry();
    registry.install(defineExtension({ name: 'interruption', tools: [defineTool({ name: 'interruption', description: 'Controlled interruption boundary', parameters: Type.Object({}), replay,
      execute: async (_args, _api, ctx) => {
        calls += 1;
        if (replay === 'unsafe') await appendFile(file, 'effect\n');
        else await readFile(file, 'utf8');
        if (calls === 1) await awaitWithContext(new Promise<void>(() => undefined), ctx);
        return { output: [{ type: 'text', text: 'safe read completed' }] };
      },
    })] }));
    const s = await setup(t, { registry }); file = join(s.directory, 'effect.txt'); await writeFile(file, '');
    const unit = await s.open(); const request = await input(unit, `tool-${replay}`); await unit.submit(request);
    await until(() => s.requests.length === 1);
    s.requests[0].finish([{ type: 'toolCall', id: `tool-${replay}`, name: 'interruption', arguments: {} }], 'toolUse');
    await until(() => calls === 1); const paused = await unit.pause();
    if (replay === 'unsafe') assert.equal(await readFile(file, 'utf8'), 'effect\n', 'pause does not roll back tool effects');
    await unit.resume(paused.control); await until(() => s.requests.length === 2);
    assert.equal(calls, replay === 'safe' ? 2 : 1);
    if (replay === 'unsafe') { assert.match(JSON.stringify(s.requests[1].messages), /interrupted/i); assert.equal(await readFile(file, 'utf8'), 'effect\n'); }
    s.requests[1].finish();
    await until(async () => { const r = await unit.lookupReceipt(request); return r.status === 'accepted' && r.processing === 'done'; });
  });
}

await test('paused spend maintenance failure retains original close retry eligibility; pure readonly close never consumes it', { timeout:15000 }, async t=>{
  let reconciliations=0;
  const s=await setup(t,{reconcileExecutionSpend:async()=>{reconciliations+=1;if(reconciliations===1)throw new Error('owned maintenance rejected');}});
  const unit=await s.open();await unit.submit(await input(unit,'known-maintenance-failure'));
  await until(()=>s.requests.length===1);
  await assert.rejects(unit.pause(),/could not confirm/);assert.equal(s.requests[0].settled,true);assert.equal(reconciliations,1);
  await unit.close();assert.equal(reconciliations,2,'执行过的原实例暂停维护失败后，close必须继续收口，不能清掉资格');
  const readonly=await s.open();await readonly.read();await readonly.close();assert.equal(reconciliations,2,'纯只读生命周期不执行维护');
});


await test('failed Session receipt lookup waits for actual storage close and resource join while retaining directory claim', { timeout: 15000 }, async t => {
  const state: Parameters<typeof faultStorage>[0] = { mode: 'none', fired: false };
  let closeEntered!: () => void; const closing = new Promise<void>(resolve => { closeEntered = resolve; });
  let releaseStorage!: () => void; const storageGate = new Promise<void>(resolve => { releaseStorage = resolve; });
  let releaseResources!: () => void; const resourceGate = new Promise<void>(resolve => { releaseResources = resolve; });
  let opens = 0; let joined = false;
  const base = faultStorage(state)!;
  const s = await setup(t, { beginCloseExecutionResources: () => ({ shutdownFlushed: Promise.resolve(), done: resourceGate.then(() => { joined = true; }) }),
    openStorage: async directory => {
      const storage = await base(directory); const own = ++opens;
      return new Proxy(storage, { get(target, key) {
        if (key === 'close' && own === 1) return async (ctx: Parameters<Storage['close']>[0]) => { closeEntered(); await storageGate; await target.close(ctx); };
        const value: unknown = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } });
    } });
  const unit = await s.open();
  try {
    const request = await input(unit, 'gated-failed-lookup'); state.mode = 'reject';
    assert.equal((await unit.submit(request)).status, 'unknown'); await closing;
    let settled = false; const lookup = unit.lookupReceipt(request).then(value => { settled = true; return value; });
    await assert.rejects(PiExecutionSession.open(s.options), /live owner/);
    assert.equal(opens, 1); assert.equal(settled, false); assert.equal(s.requests.length, 0);
    releaseStorage();
    await assert.rejects(PiExecutionSession.open(s.options), /live owner/);
    assert.equal(joined, false); assert.equal(opens, 1); assert.equal(settled, false, 'closed通知不能替外部资源真实join');
    releaseResources();
    assert.deepEqual(await lookup, { status: 'not-accepted', operationId: request.operationId, reason: 'not-found' });
    assert.equal(joined, true); assert.equal(opens, 2); assert.equal(s.requests.length, 0);
  } finally { releaseStorage(); releaseResources(); await unit.close(); }
});

for (const operation of ['lookup', 'close'] as const) await test(`failed backend close still joins resources/${operation} before reporting failure`, { timeout: 15000 }, async t => {
  const state: Parameters<typeof faultStorage>[0] = { mode: 'none', fired: false }; let opens = 0; let backendRejected = false; let joined = false;
  let releaseResources!: () => void; const resourceGate = new Promise<void>(resolve => { releaseResources = resolve; });
  const base = faultStorage(state)!;
  const s = await setup(t, { beginCloseExecutionResources: () => ({ shutdownFlushed: Promise.resolve(), done: resourceGate.then(() => { joined = true; }) }), openStorage: async directory => {
    const storage = await base(directory); opens++;
    return new Proxy(storage, { get(target, key) {
      if (key === 'close') return async (ctx: Parameters<Storage['close']>[0]) => { await target.close(ctx); if (state.fired) { backendRejected = true; throw new Error('fixture backend close unconfirmed'); } };
      const value: unknown = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
  } }, /close unconfirmed/);
  const unit = await s.open(); const request = await input(unit, 'failed-close-' + operation); state.mode = 'reject';
  try {
    assert.equal((await unit.submit(request)).status, 'unknown'); await until(() => backendRejected);
    let settled = false;
    // 两种公开动作分开执行，避免close的同步closing标记先挡住排队中的lookup。
    const pending = operation === 'lookup' ? unit.lookupReceipt(request) : unit.close();
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await assert.rejects(PiExecutionSession.open(s.options), /live owner/);
    assert.equal(joined, false); assert.equal(opens, 1); assert.equal(s.requests.length, 0);
    assert.equal(settled, false, '即使backend.close已抛错，当前公开动作也须等待真实资源join');
    releaseResources();
    if (operation === 'lookup') assert.deepEqual(await pending, { status: 'unknown', operationId: request.operationId, reason: 'storage-unavailable' });
    else await assert.rejects(pending, /close unconfirmed/);
    assert.equal(joined, true); assert.equal(opens, 1);
    await assert.rejects(PiExecutionSession.open(s.options), /live owner/);
    await assert.rejects(unit.close(), /close unconfirmed/);
  } finally { releaseResources(); await assert.rejects(unit.close(), /close unconfirmed/); state.fired = false; }
});

for (const preparation of [false, true]) await test(`a saved submission with a lost raw commit response remains unknown when pause already claimed/${preparation ? 'prepared' : 'plain'}`, { timeout: 15000 }, async t => {
  const sentinel = new Error('synthetic response loss after the target submission was saved');
  const operationId = 'pause-after-real-submission-commit';
  let committedSubmissionId: unknown;
  let gateEntered = false;
  let actualCommitCompleted = false;
  let faultCount = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const events: string[] = [];
  const rootSubmitErrors: unknown[] = [];
  let effectFile = '';
  let effectCalls = 0;
  const registry = createRegistry();
  registry.install(defineExtension({ name: 'commit-loss-effect-probe', tools: [defineTool({
    name: 'commit-loss-effect-probe', description: 'Synthetic physical effect probe', parameters: Type.Object({}),
    execute: async () => { effectCalls += 1; await appendFile(effectFile, 'synthetic effect\n'); return { output: [{ type: 'text', text: 'effect recorded' }] }; },
  })] }));
  const openStorage: PiSessionOptions['openStorage'] = async directory => {
    const storage = await openNodeJsonlStorage(directory, context, { fsync: true });
    return new Proxy(storage, { get(target, key) {
      if (key === 'commit') return (async (writes, ctx) => {
        const submission = writes.find(write => write.type === 'submission' && write.value.type === 'input' && write.value.requestId === operationId);
        // 只拦本次正式 submission；先前 Intent、初始化、后续 pause/close 不注入。
        if (!gateEntered && submission?.type === 'submission') {
          committedSubmissionId = submission.value.id;
          gateEntered = true; events.push('target-submission-at-storage');
          await gate;
          const seq = await target.commit(writes, ctx);
          actualCommitCompleted = true; faultCount += 1; events.push('actual-storage-commit-complete');
          void seq;
          // 原始 Error 由 GuardedStorage 首次调用原样抛回；不主动注入 SessionFailed。
          throw sentinel;
        }
        return target.commit(writes, ctx);
      }) satisfies Storage['commit'];
      const value: unknown = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  const s = await setup(t, { registry, openStorage,
    ...(preparation ? { needsInputPreparation: () => true, prepareInput: async () => { throw new Error('Stored preparation must not execute during readonly verification'); } } : {}),
    attachExecution: (_harness, root) => {
    const submit = root.submit.bind(root);
    // 透明观察既有公开通路：参数、成功值及失败对象原样传递，不制造 SDK 拒绝。
    root.submit = async (...args) => {
      try { return await submit(...args); }
      catch (error) { rootSubmitErrors.push(error); throw error; }
    };
  } });
  effectFile = join(s.directory, 'commit-loss-effect.txt');
  const unit = await s.open();
  const request = await input(unit, operationId);
  const settle = <T,>(promise: Promise<T>) => promise.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error: error as unknown }));
  const submitting = settle(unit.submit(request));
  let pausing: ReturnType<typeof settle<Awaited<ReturnType<PiExecutionSession['pause']>>>> | undefined;
  let readonlyUnit: PiExecutionSession | undefined;
  try {
    await until(() => gateEntered);
    assert.equal(actualCommitCompleted, false, '暂停前必须实际停在同一 submission 的底层写入门');
    assert.equal(s.requests.length, 0);
    // pause() 在返回 Promise 之前同步置暂停认领；立即附接处理，避免目标异常变成 unhandled rejection。
    pausing = settle(unit.pause()); events.push('pause-called-before-release');
    release();
    const [submitted, paused] = await Promise.all([submitting, pausing]);
    assert.equal(actualCommitCompleted, true);
    assert.equal(faultCount, 1);
    assert.deepEqual(events, ['target-submission-at-storage', 'pause-called-before-release', 'actual-storage-commit-complete']);
    assert.equal(rootSubmitErrors.length, preparation ? 0 : 1);
    if (!preparation) {
      assert.equal(rootSubmitErrors[0], sentinel, '证明普通 root.submit 收到的是首次原始 Error，而非后续 SessionFailed');
      assert.equal(rootSubmitErrors[0] instanceof Pi130SessionFailed, false);
    }
    assert.equal(paused.ok, false, '失败 Session 不得声称暂停已可靠写盘');
    if (paused.ok) throw new Error('Pause unexpectedly confirmed a saved pause');
    assert.ok(paused.error instanceof Error);
    assert.equal(paused.error.message, 'Pause could not confirm storage and shutdown');
    assert.ok(paused.error.cause instanceof Pi130SessionFailed);
    assert.equal(paused.error.cause.cause, sentinel);
    const found = await unit.lookupReceipt(request);
    assert.equal(found.status, 'accepted', '实际底层已保存，必须沿原 operationId 查回原正式回执');
    if (found.status !== 'accepted') throw new Error('Original saved submission was not found');
    assert.equal(found.operationId, request.operationId);
    assert.equal(found.submissionId, committedSubmissionId);
    assert.equal(s.requests.length, 0);
    assert.equal(effectCalls, 0);
    await assert.rejects(readFile(effectFile, 'utf8'), { code: 'ENOENT' });
    await unit.close();
    const beforeReadonly = await journal(s.options.directory);
    // setup.open() 不接受覆盖参数；此处显式打开只读代，禁止为结束测试而 resume 或重发。
    readonlyUnit = await PiExecutionSession.open({ ...s.options, initialize: false });
    assert.equal((await readonlyUnit.read()).phase, 'paused');
    const restored = await readonlyUnit.lookupReceipt(request);
    assert.equal(restored.status, 'accepted');
    if (restored.status !== 'accepted') throw new Error('Readonly reopen lost the original saved submission');
    assert.equal(restored.operationId, request.operationId);
    assert.equal(restored.submissionId, committedSubmissionId);
    assert.deepEqual(await journal(s.options.directory), beforeReadonly, '查询与只读重开不写盘、不重放');
    // close可将原Binding的paused=false收口为true；它不是上方只读查询动作，不据此声称close零元数据写入。
    await readonlyUnit.close(); readonlyUnit = undefined;
    assert.equal(s.requests.length, 0, '整个查回/关闭/只读重开阶段零模型调用');
    assert.equal(effectCalls, 0);
    await assert.rejects(readFile(effectFile, 'utf8'), { code: 'ENOENT' });
    t.diagnostic(JSON.stringify({ targetSubmissionSaved: actualCommitCompleted, faultCount, preparation, originalErrorPropagated: preparation ? paused.error.cause.cause === sentinel : rootSubmitErrors[0] === sentinel, found: found.status, restored: restored.status, modelCalls: s.requests.length, effects: effectCalls }));
    assert.equal(submitted.ok, true, '接收 API 应返回 unknown 回执，而非把原始存储异常抛给调用者');
    // 旧 catch 的精确目标红：其返回 not-accepted/paused，但以上事实已证明原提交存在。
    assert.deepEqual(submitted.value, { status: 'unknown', operationId: request.operationId, reason: 'storage-unavailable' });
  } finally {
    // 先释放门再收束，任何前置断言失败也不能把真实 commit 或关闭永久挂住。
    release();
    await submitting;
    if (pausing) await pausing;
    await readonlyUnit?.close();
    await unit.close();
  }
});
