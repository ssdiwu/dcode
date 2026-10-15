import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DCodeApplication } from '../../src/application/index.ts';
import { seedState } from '../../src/application/seed.ts';
import { PiExecutionSession } from '../../src/adapters/pi/index.ts';
import { controlledModels, until } from './fixtures.ts';

await test('首次对象保存明确拒绝后，同 operationId 重试能建立原运行，不重复建对象', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dcode-first-runtime-'));
  const fixture = controlledModels(); let failNextSave = false;
  const backend = { kind: 'pi' as const, modelName: 'controlled SDK fixture', open: (context: import('../../src/application/index.ts').SessionExecutionContext) => PiExecutionSession.open({
    target: context.target, directory: join(root, context.target.sessionId), cwd: root, initialize: context.initialize,
    models: fixture.models, agent: { model: { provider: fixture.model.provider, modelId: fixture.model.id } },
  }) };
  const app = new DCodeApplication(backend, { load: async () => ({ status: 'missing' }), save: async () => {
    if (failNextSave) { failNextSave = false; throw new Error('controlled initial save rejection'); }
  } }, () => { const state = seedState(); state.workspaces[0]!.folders = [root]; return state; });
  try {
    await app.init();
    failNextSave = true;
    const first = await app.sendMessage({ taskId: 'task-home-default', text: 'same initial input', operationId: 'original-first-operation', mode: 'follow-up' });
    assert.deepEqual(first.receipt, { status: 'not-accepted', operationId: 'original-first-operation', reason: 'storage-rejected' });
    assert.equal(fixture.requests.length, 0);
    const before = await app.getSnapshot();
    const retry = await app.sendMessage({ taskId: 'task-home-default', text: 'same initial input', operationId: 'original-first-operation', mode: 'follow-up' });
    assert.equal(retry.sessionId, first.sessionId);
    assert.equal(retry.receipt.status, 'accepted');
    assert.equal((await app.getSnapshot()).sessions.length, before.sessions.length);
    await until(() => fixture.requests.length === 1); fixture.requests[0]!.finish();
    assert.equal(fixture.requests.length, 1);
  } finally { try { await app.flush(); } finally { await rm(root, { recursive: true, force: true }); } }
});
