// 普通工厂的真实登记生命周期；运行结果及版本归属见本片验证记录。
// 真实 ModelRuntime + MemoryStorage/Harness + 原 CodingExtensions/Worker/SDK 普通工厂；不提交输入或调用模型。
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Api, Credential, Model, Provider } from '@earendil-works/pi-ai';
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable';
import { CodingExtensions } from '../../src/adapters/pi/coding-extensions.ts';
import { CodingResourcesUnavailable, registerPresetProviders } from '../../src/adapters/pi/index.ts';

const providerId = 'openrouter';
const physicalId = 'registration-physical';
const virtualId = 'registration-virtual';
const definition = (id: string, extra = '') => `{
  provider:${JSON.stringify(providerId)},id:${JSON.stringify(id)},name:'ordinary virtual registration',
  thinkingLevels:['off','high'],contextWindow:32768,maxTokens:1024,input:['text'],
  route(){throw new Error('Registration-only fixture must not route');}${extra}
}`;
const factory = (body: string) => `export default function(pi){\n${body}\n}\n`;

async function fixture(t: TestContext, source: string) {
  const directory = await mkdtemp(join(tmpdir(), 'dcode-virtual-registration-'));
  const project = join(directory, 'project');
  const agentDir = join(directory, 'agent');
  await mkdir(join(project, '.pi/extensions'), { recursive: true });
  await mkdir(agentDir);
  await writeFile(join(project, 'AGENTS.md'), 'Isolated registration-only project.\n');
  await writeFile(join(project, '.pi/extensions/lifecycle.mjs'), source);
  await writeFile(join(project, '.pi/settings.json'), JSON.stringify({ extensions: ['./extensions/lifecycle.mjs'] }));
  await writeFile(join(project, '.pi/mcp.json'), JSON.stringify({ mcpServers: {} }));
  const credentials = new Map<string, Credential>();
  const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
    credentials: {
      read: async id => credentials.get(id),
      list: async () => [...credentials].map(([providerId, value]) => ({ providerId, type: value.type })),
      modify: async (id, change) => { const next = await change(credentials.get(id)); if (next) credentials.set(id, next); return credentials.get(id); },
      delete: async id => { credentials.delete(id); },
    } });
  // 复用正式 deny-ambient 包装；create 跳过初刷，modelsPath:null 同时选用 SDK 内存 ModelsStore。
  const presets = registerPresetProviders();
  for (const preset of presets) runtime.registerNativeProvider(preset.provider);
  const preset = presets.find(item => item.id === providerId); assert.ok(preset);
  const physical: Model<Api> = { id: physicalId, name: 'physical registration control', provider: providerId,
    api: 'openai-completions', baseUrl: 'https://invalid.invalid', reasoning: false, input: ['text'],
    contextWindow: 32768, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const provider: Provider = { ...preset.provider, getModels: () => [physical], getAllModels: () => [physical] };
  runtime.registerNativeProvider(provider);
  await runtime.refresh({ allowNetwork: false });
  assert.equal(runtime.getModel(providerId, physicalId), physical);
  assert.equal(runtime.getProvider(providerId), provider);
  const registered: { provider: string; id: string; model: Model<Api> | undefined }[] = [];
  const register = runtime.registerVirtualModel.bind(runtime);
  // 仅观察原 SDK 公开调用成功后的目录对象，不替代登记实现或制造内部状态。
  runtime.registerVirtualModel = value => {
    register(value);
    registered.push({ provider: value.provider, id: value.id, model: runtime.getModel(value.provider, value.id) });
  };
  const registry = createRegistry();
  const harness = await Harness.open(new MemoryStorage(), { models: runtime, registry,
    settings: { retry: { maxRetries: 0 }, stream: { maxRetries: 0 }, toolExecution: 'sequential' } }, context);
  const root = await harness.root(context, { agent: { model: { provider: providerId, modelId: physicalId }, cwd: project } });
  const resource = new CodingExtensions([], agentDir, () => true, runtime, randomUUID());
  resource.attach(harness, root); resource.useRegistry(registry);
  t.after(async () => {
    try { await resource.close(); assert.equal((await harness.inspect(context)).tasks.length, 0, '登记不能启动模型或另建任务'); }
    finally { try { await harness.close(context); } finally { await rm(directory, { recursive: true, force: true }); } }
  });
  const prepare = async () => {
    const prepared = await resource.prepare(project);
    assert.ok('add' in prepared && prepared.add && prepared.add.length === 1, '普通工厂必须经真实资源准备成功');
    for (const extension of prepared.add) registry.install(extension);
    await root.configure({ extensions: { add: prepared.add }, tools: prepared.tools }, context);
    assert.equal((await harness.inspect(context)).tasks.length, 0);
  };
  const physicalPreserved = (bareProvider = true) => {
    assert.equal(runtime.getModel(providerId, physicalId), physical, '原 physical 对象未被覆盖');
    assert.equal(runtime.getRegisteredNativeProvider(providerId), provider, '原 native provider 包装未被替换');
    assert.equal(runtime.getProvider(providerId)?.auth, provider.auth, '原 auth 包装未被覆盖');
    if (bareProvider) {
      assert.equal(runtime.getProvider(providerId), provider, '无 virtual 时恢复同一个 provider 包装');
      assert.equal(runtime.getProvider(providerId)?.stream, provider.stream);
      assert.equal(runtime.getProvider(providerId)?.streamSimple, provider.streamSimple);
    }
  };
  const absent = (...ids: string[]) => {
    for (const id of ids) {
      assert.equal(runtime.getModel(providerId, id), undefined, `getModel 不留 ${id}`);
      assert.equal(runtime.getModels(providerId).some(model => model.id === id), false, `getModels 不留 ${id}`);
      assert.equal(runtime.getAvailableSnapshot().some(model => model.provider === providerId && model.id === id), false, `available 不留 ${id}`);
    }
  };
  return { runtime, resource, project, prepare, registered, physicalPreserved, absent };
}

await test('virtual 登记：物理同 id 使整个 prepare 失败，原物理模型与 provider 包装保留', { timeout: 15000 }, async t => {
  const f = await fixture(t, factory(`pi.registerVirtualModel(${definition(physicalId)});`));
  await assert.rejects(f.resource.prepare(f.project), CodingResourcesUnavailable);
  assert.equal(f.registered.length, 0, '冲突不能落成一个已接收 virtual');
  f.physicalPreserved();
});

await test('virtual 登记：同一资源 register 后在 session_start unregister，确认原登记后目录不留项', { timeout: 15000 }, async t => {
  const f = await fixture(t, factory(`pi.registerVirtualModel(${definition(virtualId)});
    pi.on('session_start',()=>pi.unregisterVirtualModel(${JSON.stringify(providerId)},${JSON.stringify(virtualId)}));`));
  await f.prepare();
  assert.equal(f.registered.length, 1, '必须先经真实 Host/ModelRuntime 接收，不能靠 SDK 工厂预绑定队列抵消凑通过');
  assert.equal(f.registered[0]?.model?.api, 'pi-virtual');
  f.absent(virtualId); f.physicalPreserved();
  await f.resource.close(); f.absent(virtualId); f.physicalPreserved();
});

await test('virtual 登记：外部用公开 Runtime 同 key 替换后，旧 resource.close 不删除新定义', { timeout: 15000 }, async t => {
  const f = await fixture(t, factory(`pi.registerVirtualModel(${definition(virtualId)});`));
  await f.prepare();
  const own = f.runtime.getModel(providerId, virtualId); assert.ok(own); assert.equal(own.api, 'pi-virtual');
  f.runtime.registerVirtualModel({ provider: providerId, id: virtualId, name: 'external replacement remains owned externally',
    route() { throw new Error('Registration-only external definition must not route'); } });
  const replacement = f.runtime.getModel(providerId, virtualId); assert.ok(replacement);
  assert.notEqual(replacement, own, '必须确实替换成一个后来登记的目录对象');
  await f.resource.close();
  assert.equal(f.runtime.getModel(providerId, virtualId), replacement, '旧资源只能清理自身，不能按同名字符串误删');
  assert.equal(f.runtime.getModel(providerId, virtualId)?.name, 'external replacement remains owned externally');
  f.physicalPreserved(false);
  f.runtime.unregisterVirtualModel(providerId, virtualId);
  f.absent(virtualId); f.physicalPreserved();
});

await test('virtual 登记：一有效一非法定义导致整体 prepare 失败，已接收有效项也回滚', { timeout: 15000 }, async t => {
  const invalidId = 'registration-invalid';
  const f = await fixture(t, factory(`pi.registerVirtualModel(${definition(virtualId)});
    pi.registerVirtualModel(${definition(invalidId, ',maxTokens:-1')});`));
  await assert.rejects(f.resource.prepare(f.project), CodingResourcesUnavailable);
  assert.equal(f.registered.length, 1, '第一项必须真实接收后才能证明失败回滚');
  assert.equal(f.registered[0]?.id, virtualId); assert.equal(f.registered[0]?.model?.api, 'pi-virtual');
  f.absent(virtualId, invalidId); f.physicalPreserved();
});

for (const [label, value] of [
  ['thinkingLevels:function', ',thinkingLevels:()=>["high"]'],
  ['contextWindow:NaN', ',contextWindow:NaN'],
  ['maxTokens:Infinity', ',maxTokens:Infinity'],
] as const) await test(`virtual 登记：${label} 不得经 JSON 丢弃或改写后冒称 prepare 成功`, { timeout: 15000 }, async t => {
  const f = await fixture(t, factory(`pi.registerVirtualModel(${definition(virtualId, value)});`));
  await assert.rejects(f.resource.prepare(f.project), CodingResourcesUnavailable);
  assert.equal(f.registered.length, 0, '非法原定义不能被净化成默认元数据再接收');
  f.absent(virtualId); f.physicalPreserved();
});
