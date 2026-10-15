import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createRegistry, Harness, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { createRealPiBackend, ModelSetupStore, PiExecutionSession } from '../../src/adapters/pi/index.ts';
import { controlledModels, until } from './fixtures.ts';

const target = { workspaceId: 'space', taskId: 'task', sessionId: 'session' };
const cipher = { isAvailable: () => true, encrypt: (text: string) => Buffer.from(text), decrypt: (bytes: Buffer) => bytes.toString() };

async function journal(directory: string) {
  const files = (await readdir(directory, { withFileTypes: true })).filter(file => file.isFile()).map(file => file.name).sort();
  return Promise.all(files.map(async file => [file, await readFile(join(directory, file), 'utf8')]));
}

await test('普通装配首次绑定项目目录；只读重开不迁移 cwd 或应用当前选择', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dcode-ordinary-directory-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, 'project'); await mkdir(project);
  const stateDir = join(directory, 'state');
  const backend = createRealPiBackend({ stateDir, cipher, store: new ModelSetupStore({ stateDir }, cipher),
    config: { provider: 'openai-completions', label: 'isolated', modelId: 'original-model', baseUrl: 'http://127.0.0.1:1/v1' } });
  const first = await backend.open({ target, title: 'task', workFolder: project, model: null, initialize: true });
  await first.close();
  const runtime = join(stateDir, 'runtime', target.sessionId);
  const before = await journal(runtime);
  const second = await backend.open({ target, title: 'task', workFolder: join(directory, 'missing-new-project'),
    model: { sourceId: 'unconfigured-other', modelId: 'other-model', thinkingLevel: 'high' }, initialize: false });
  try { assert.equal((await second.read()).entries.length, 0); } finally { await second.close(); }
  assert.deepEqual(await journal(runtime), before, '读取原记录不配置新模型或迁移目录');
  const storage = await openNodeJsonlStorage(runtime, context);
  try {
    const address = await storage.findDocument({ kind: 'pi.agent', scope: { kind: 'conversation', conversationId: ROOT_CONVERSATION_ID } }, 'current', context);
    assert.ok(address);
    const agent = await storage.document(address.id, 'current', context);
    assert.equal(agent?.value.cwd, project);
    assert.deepEqual(agent?.value.model, { provider: 'user-defined', modelId: 'original-model' });
  } finally { await storage.close(context); }
  await assert.rejects(readFile(join(stateDir, 'work-dir', 'result.txt')), { code: 'ENOENT' });
});

await test('只读打开缺失运行不创建目录或空根，不替代未知接收事实', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dcode-missing-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = controlledModels();
  const options = { target, directory: join(directory, 'missing'), cwd: directory, models: fixture.models, agent: {}, initialize: false };
  await assert.rejects(PiExecutionSession.open(options), { code: 'ENOENT' });
  assert.deepEqual(await readdir(directory), []);
  await mkdir(options.directory);
  await assert.rejects(PiExecutionSession.open(options), /Runtime record is missing/);
  const storage = await openNodeJsonlStorage(options.directory, context);
  try { assert.equal(await storage.conversation(ROOT_CONVERSATION_ID, context), undefined); } finally { await storage.close(context); }
  assert.equal(fixture.requests.length, 0);
});

await test('已有 AgentDoc 和目录绑定冲突时保全记录并拒绝恢复', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dcode-binding-conflict-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = controlledModels();
  const options = { target, directory: join(directory, 'runtime'), cwd: directory, models: fixture.models, agent: {} };
  const first = await PiExecutionSession.open(options); await first.close();
  const storage = await openNodeJsonlStorage(options.directory, context);
  const harness = await Harness.open(storage, { models: fixture.models, registry: createRegistry() }, context);
  try { await (await harness.root(context)).configure({ cwd: join(directory, 'different') }, context); }
  finally { await harness.close(context); await storage.close(context); }
  const before = await journal(options.directory);
  await assert.rejects(PiExecutionSession.open({ ...options, initialize: false, reuseStoredCwd: true }), /conflicts with session binding/);
  assert.deepEqual(await journal(options.directory), before);
  assert.equal(fixture.requests.length, 0);
});

await test('准备项目资源 await 期间暂停：原输入未接收，仍在同实例明确继续并同身份重试', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dcode-resource-pause-'));
  const fixture = controlledModels();
  let entered!: () => void; let release!: () => void;
  const enteredGate = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const unit = await PiExecutionSession.open({ target, directory: join(directory, 'runtime'), cwd: directory,
    models: fixture.models, agent: { model: { provider: fixture.model.provider, modelId: fixture.model.id } },
    prepareExecution: async () => { entered(); await gate; return { instructions: 'isolated project preparation' }; } });
  t.after(async () => { release(); await unit.close(); await rm(directory, { recursive: true, force: true }); });
  const before = await unit.read();
  const input = { target, operationId: 'resource-pause-one', text: 'same original input', references: [], mode: 'follow-up' as const, expected: before.control };
  const receiving = unit.submit(input); await enteredGate;
  const pausing = unit.pause(); release();
  const receipt = await receiving;
  assert.equal(receipt.status, 'not-accepted', '暂停优先于尚未开始的正式接收');
  assert.equal(receipt.status === 'not-accepted' ? receipt.reason : null, 'paused');
  const paused = await pausing;
  assert.equal(paused.phase, 'paused'); assert.equal(fixture.requests.length, 0);
  assert.equal((await unit.lookupReceipt(input)).status, 'not-accepted', '没有正式提交，可靠回查不得造已接收事实');
  const resumed = await unit.resume(paused.control);
  const retried = await unit.submit({ ...input, expected: resumed.control });
  assert.equal(retried.status, 'accepted', '原实例没有被正常暂停伪成存储故障');
  await until(() => fixture.requests.length === 1); fixture.requests[0]!.finish();
  await until(async () => (await unit.read()).pendingInputs === 0);
});
