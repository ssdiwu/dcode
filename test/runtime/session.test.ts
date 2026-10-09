import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, readdir, appendFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BACKGROUND_CONTEXT as context, awaitWithContext } from '@earendil-works/chord/context';
import { createRegistry, defineTool, defineExtension, StorageRejected } from '@earendil-works/pi-durable';
import { Type } from '@earendil-works/pi-ai';
import type { Storage } from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { PiExecutionSession } from '../../src/adapters/pi/index.ts';
import type { PiSessionOptions } from '../../src/adapters/pi/index.ts';
import type { WorkInput } from '../../src/contracts/index.ts';
import { controlledModels, until } from './fixtures.ts';

async function setup(t: TestContext, overrides: Partial<PiSessionOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dcode-pi-integration-'));
  const fixture = controlledModels();
  const options: PiSessionOptions = { directory: join(directory, 'runtime'), cwd: directory, target: { workspaceId: 'space', taskId: 'task', sessionId: 'session' }, models: fixture.models, agent: { model: { provider: fixture.model.provider, modelId: fixture.model.id } }, ...overrides };
  const units: PiExecutionSession[] = [];
  async function open() { const unit = await PiExecutionSession.open(options); units.push(unit); return unit; }
  t.after(async () => { for (const unit of units.reverse()) await unit.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, options, open, ...fixture };
}
async function input(unit: PiExecutionSession, operationId: string, text = 'synthetic instruction', mode: WorkInput['mode'] = 'steer'): Promise<WorkInput> {
  const view = await unit.read();
  return { target: view.target, operationId, text, mode, expected: view.control };
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
  registry.install(defineExtension({ name: 'checkpoint', tools: [defineTool({ name: 'checkpoint', description: 'Test a real tool boundary', parameters: Type.Object({}), execute: async () => ({ content: [{ type: 'text', text: 'tool boundary reached' }] }) })] }));
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
        if (trigger) { state.fired = true; if (state.mode === 'reject' || state.mode === 'pause') throw new StorageRejected('injected rejection before durable write'); }
        const seq = await target.commit(writes, ctx);
        if (trigger && state.mode === 'after-commit') throw new Error('injected response loss after actual commit');
        return seq;
      }) satisfies Storage['commit'];
      const value: unknown = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
}

await test('explicit storage rejection is not accepted; lost commit response stays unknown then resolves by read', { timeout: 15000 }, async t => {
  for (const mode of ['reject', 'after-commit'] as const) {
    const state: Parameters<typeof faultStorage>[0] = { mode: 'none', fired: false };
    const s = await setup(t, { openStorage: faultStorage(state) }); const unit = await s.open();
    const request = await input(unit, mode); state.mode = mode;
    const receipt = await unit.submit(request);
    assert.equal(receipt.status, mode === 'reject' ? 'not-accepted' : 'unknown');
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
        return { content: [{ type: 'text', text: 'safe read completed' }] };
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
