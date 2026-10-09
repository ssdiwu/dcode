import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import type { Storage } from '@earendil-works/pi-durable';
import { PiExecutionSession } from '../../src/adapters/pi/index.ts';
import type { WorkInput } from '../../src/contracts/index.ts';
import { controlledModels, until } from './fixtures.ts';

await test('another live process is rejected; SIGKILL releases dead ownership and reopen waits for explicit resume', { timeout: 20000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'dcode-pi-process-'));
  const directory = join(cwd, 'records'); const fixture = controlledModels();
  const options = { directory, cwd, target: { workspaceId: 'space', taskId: 'task', sessionId: 'session' }, models: fixture.models, agent: { model: { provider: fixture.model.provider, modelId: fixture.model.id } } };
  const child = fork(fileURLToPath(new URL('./crash-child.ts', import.meta.url)), [directory, cwd], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; } await rm(cwd, { recursive: true, force: true }); });
  let stderr = ''; child.stderr?.on('data', chunk => { stderr += String(chunk); });
  const [value] = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error(`child exited before admission: ${stderr}`); })]);
  const message = value as { type: string; request: WorkInput; receipt: { status: string } };
  assert.equal(message.type, 'running'); assert.equal(message.receipt.status, 'accepted');
  await assert.rejects(PiExecutionSession.open(options), /live owner/);
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const unit = await PiExecutionSession.open(options);
  try {
    assert.equal((await unit.read()).phase, 'paused'); assert.equal((await unit.lookupReceipt(message.request)).status, 'accepted');
    await delay(40); assert.equal(fixture.requests.length, 0);
    await unit.resume((await unit.read()).control); await until(() => fixture.requests.length === 1); fixture.requests[0].finish();
    await until(async () => { const r = await unit.lookupReceipt(message.request); return r.status === 'accepted' && r.processing === 'done'; });
  } finally { await unit.close(); }
});

await test('concurrent and repeated close calls preserve a failed shutdown result and keep the ownership claim', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dcode-pi-close-failure-')); const fixture = controlledModels();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { directory, cwd: directory, target: { workspaceId: 's', taskId: 't', sessionId: 'c' }, models: fixture.models, agent: { model: { provider: fixture.model.provider, modelId: fixture.model.id } }, openStorage: async (path: string): Promise<Storage> => {
    const storage = await openNodeJsonlStorage(path, context);
    return new Proxy(storage, { get(target, key) {
      if (key === 'close') return async () => { await target.close(context); throw new Error('injected close response failure'); };
      const value: unknown = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
  const unit = await PiExecutionSession.open(options);
  const [a, b] = await Promise.allSettled([unit.close(), unit.close()]);
  assert.equal(a.status, 'rejected'); assert.equal(b.status, 'rejected');
  await assert.rejects(unit.close(), /close response failure/);
  assert.equal((await readdir(join(directory, '.dcode-owner'))).length, 1);
  await assert.rejects(PiExecutionSession.open(options), /live owner/);
});

await test('a new pause while resume is committing prevents scheduler activation', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dcode-pi-resume-race-')); const fixture = controlledModels();
  let armed = false; let entered!: () => void; let release!: () => void;
  const barrierEntered = new Promise<void>(resolve => { entered = resolve; });
  const barrierReleased = new Promise<void>(resolve => { release = resolve; });
  const unit = await PiExecutionSession.open({ directory, cwd: directory, target: { workspaceId: 's', taskId: 't', sessionId: 'c' }, models: fixture.models, agent: { model: { provider: fixture.model.provider, modelId: fixture.model.id } }, openStorage: async path => {
    const storage = await openNodeJsonlStorage(path, context);
    return new Proxy(storage, { get(target, key) {
      if (key === 'commit') return (async (writes, ctx) => { if (armed) { armed = false; entered(); await barrierReleased; } return target.commit(writes, ctx); }) satisfies Storage['commit'];
      const value: unknown = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
  } });
  t.after(async () => { release(); await unit.close(); await rm(directory, { recursive: true, force: true }); });
  const request = { target: unit.target, operationId: 'one', text: 'synthetic race input', mode: 'steer', expected: (await unit.read()).control };
  await unit.submit(request); await until(() => fixture.requests.length === 1); const paused = await unit.pause();
  armed = true; const resume = unit.resume(paused.control); const rejected = assert.rejects(resume, /superseded/);
  await barrierEntered; const pause = unit.pause(); release();
  await rejected; assert.equal((await pause).phase, 'paused'); assert.equal(fixture.requests.length, 1);
});
