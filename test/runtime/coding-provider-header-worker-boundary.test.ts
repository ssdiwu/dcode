// 普通扩展provider公开头的真实消费者与边界；运行结果及源码资格见本片验证记录。
// 真实 CodingExtensions Worker/公开 factory + ModelRuntime/认证头派发；不启动模型、HTTP 或 App admission。
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createProvider, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import type { Api, Model, ProviderStreams } from '@earendil-works/pi-ai';
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable';
import { CodingExtensions } from '../../src/adapters/pi/coding-extensions.ts';
import { CodingProviderHeaders } from '../../src/adapters/pi/coding-provider-headers.ts';
import { CodingResourcesUnavailable } from '../../src/adapters/pi/index.ts';
import { until } from './fixtures.ts';

const providerId = 'worker-header-managed';
const modelId = 'worker-header-physical';
const key = 'isolated-worker-header-not-a-real-key';
const gateCount = 4;
const visible = (model: Model<Api>) => Object.fromEntries(Object.entries(model.headers ?? {}).filter(([name]) => name.startsWith('x-visible')));

function factory(project: string, body: string) {
  return `import {access,writeFile} from 'node:fs/promises';
    import {setTimeout as delay} from 'node:timers/promises';
    import {join} from 'node:path';
    const project=${JSON.stringify(project)},id=${JSON.stringify(providerId)};
    const gate=async number=>{
      const deadline=Date.now()+8000;
      for(;;){try{await access(join(project,'.worker-gate-'+number));return;}
        catch(error){if(error.code!=='ENOENT')throw error;}
        if(Date.now()>=deadline)throw new Error('Worker test handshake timed out');
        await delay(5);
      }
    };
    const note=data=>writeFile(join(project,'worker-observation.json'),JSON.stringify(data));
    export default function(pi){
      ${body}
    }`;
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'dcode-worker-provider-headers-'));
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(providerId, async () => ({ type: 'api_key', key }));
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  // 所有 builtin 在第一个 await 前同步替换；本例不扫描环境/文件认证，也不刷新远端目录。
  for (const builtin of runtime.getProviders()) runtime.registerNativeProvider({ ...builtin,
    getModels: () => [], getAllModels: () => [], refreshModels: undefined,
    auth: { apiKey: { name: 'no ambient fixture', check: async () => undefined, resolve: async () => undefined } } });
  let dispatches = 0, authReads = 0;
  const neverDispatch: ProviderStreams['streamSimple'] = () => { dispatches++; throw new Error('Registration fixture must not call a model'); };
  const physical: Model<Api> = { id: modelId, name: 'Worker registration physical control', provider: providerId,
    api: 'openai-completions', baseUrl: 'https://invalid.invalid', input: ['text'], reasoning: false,
    contextWindow: 32768, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    headers: { 'x-model-original': 'model-preserved' } };
  const base = createProvider({ id: providerId, name: 'managed Worker registration control', models: [physical],
    auth: { apiKey: { name: 'isolated memory credential',
      check: async input => input.credential?.key === key ? { type: 'api_key', source: 'isolated fixture' } : undefined,
      resolve: async input => {
        authReads++; assert.equal(input.credential?.key, key);
        return { auth: { apiKey: key, headers: { 'x-original-private': 'host-only' } }, source: 'isolated fixture' };
      } } },
    api: { stream: neverDispatch, streamSimple: neverDispatch } });
  runtime.registerNativeProvider(base);
  await runtime.refresh({ allowNetwork: false });
  assert.equal(runtime.getRegisteredNativeProvider(providerId), base);
  const headers = new CodingProviderHeaders(runtime, [providerId]);
  const resources: { project: string; resource: CodingExtensions; harness: Harness; pending: Promise<void>[] }[] = [];
  const native = () => { const result = runtime.getRegisteredNativeProvider(providerId); assert.ok(result); return result; };
  const model = () => { const result = runtime.getModel(providerId, modelId); assert.ok(result); return result; };
  const authHeaders = async () => {
    const result = await runtime.getAuth(model()); assert.ok(result);
    assert.equal(result.auth.apiKey, key);
    assert.equal(result.auth.headers?.['x-original-private'], 'host-only');
    assert.equal(result.auth.headers?.['x-model-original'], 'model-preserved');
    return result.auth.headers ?? {};
  };
  const open = async (build: (project: string) => string) => {
    const identity = randomUUID(), project = join(directory, identity, 'project'), agentDir = join(directory, identity, 'agent');
    await mkdir(join(project, '.pi/extensions'), { recursive: true }); await mkdir(agentDir);
    await writeFile(join(project, 'AGENTS.md'), 'Isolated Worker provider registration fixture.\n');
    await writeFile(join(project, '.pi/settings.json'), JSON.stringify({ extensions: ['./extensions/lifecycle.mjs'] }));
    await writeFile(join(project, '.pi/mcp.json'), JSON.stringify({ mcpServers: {} }));
    await writeFile(join(project, '.pi/extensions/lifecycle.mjs'), build(project));
    const registry = createRegistry();
    const harness = await Harness.open(new MemoryStorage(), { models: runtime, registry,
      settings: { retry: { maxRetries: 0 }, stream: { maxRetries: 0 }, toolExecution: 'sequential' } }, context);
    const root = await harness.root(context, { agent: { model: { provider: providerId, modelId }, cwd: project } });
    const resource = new CodingExtensions([], agentDir, () => true, runtime, identity, headers);
    resource.attach(harness, root); resource.useRegistry(registry);
    const entry = { project, resource, harness, pending: [] as Promise<void>[] }; resources.push(entry);
    const prepare = () => {
      const pending = (async () => {
        const result = await resource.prepare(project);
        assert.ok('add' in result && result.add?.length === 1);
        for (const extension of result.add) registry.install(extension);
        await root.configure({ extensions: { add: result.add }, tools: result.tools }, context);
        assert.equal((await harness.inspect(context)).tasks.length, 0, '登记/事件不能启动模型或虚构任务');
      })();
      pending.catch(() => {}); entry.pending.push(pending); return pending;
    };
    return { project, resource, prepare, release: (number: number) => writeFile(join(project, '.worker-gate-' + number), 'release'),
      observe: async () => {
        let value: { rows: { label: string; rejected: boolean }[] } | undefined;
        await until(async () => {
          try { value = JSON.parse(await readFile(join(project, 'worker-observation.json'), 'utf8')); return true; }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return false; throw error; }
        });
        assert.ok(value); return value;
      } };
  };
  t.after(async () => {
    try {
      // 只释放测试自己的有限文件闸门，防止失败断言把 init 事件悬挂到清理之后。
      for (const entry of resources) for (let number = 1; number <= gateCount; number++) {
        await writeFile(join(entry.project, '.worker-gate-' + number), 'cleanup-release');
      }
      await Promise.allSettled(resources.flatMap(entry => entry.pending));
      for (const entry of [...resources].reverse()) {
        try { await entry.resource.close(); assert.equal((await entry.harness.inspect(context)).tasks.length, 0); }
        finally { await entry.harness.close(context); }
      }
      assert.equal(dispatches, 0, '本资产没有模型/HTTP执行证明');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  return { runtime, base, physical, native, model, authHeaders, open, authReads: () => authReads };
}

await test('Worker 原始 provider 配置：函数/非有限数/未支持 undefined 不得在 JSON 前失真，原成功 claim 可继续注销', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const r = await f.open(project => factory(project, `
    pi.registerProvider(id,{headers:{'x-visible-one':'initial','x-visible-two':'kept'}});
    pi.on('session_start',async()=>{
      await gate(1);
      const rows=[];
      for(const [label,make] of [
        ['headers:function',()=>({headers:()=>({'x-visible-one':'illegal'})})],
        ['header-value:function',()=>({headers:{'x-visible-one':()=> 'illegal'}})],
        ['header-value:NaN',()=>({headers:{'x-visible-one':NaN}})],
        ['header-value:Infinity',()=>({headers:{'x-visible-one':Infinity}})],
        ['unsupported-models:undefined',()=>({models:undefined})],
        ['header-value:undefined',()=>({headers:{'x-visible-one':undefined}})]
      ]){
        let rejected=false;try{pi.registerProvider(id,make());}catch{rejected=true;}
        rows.push({label,rejected});
      }
      await note({rows});await gate(2);pi.unregisterProvider(id);
    });
  `));
  const preparing = r.prepare();
  await until(() => f.native() !== f.base && f.model().headers?.['x-visible-one'] === 'initial');
  const before = f.native();
  assert.deepEqual(visible(f.model()), { 'x-visible-one': 'initial', 'x-visible-two': 'kept' });
  await r.release(1); const observation = await r.observe();
  const after = f.native(), actualAuth = await f.authHeaders();
  await r.release(2); await preparing;
  assert.deepEqual(observation.rows, [
    { label: 'headers:function', rejected: true }, { label: 'header-value:function', rejected: true },
    { label: 'header-value:NaN', rejected: true }, { label: 'header-value:Infinity', rejected: true },
    { label: 'unsupported-models:undefined', rejected: true }, { label: 'header-value:undefined', rejected: true },
  ], '每项必须由真实 Worker 的公共 pi 入口同步拒绝；Host 事后拒绝或 JSON 丢字段不等价');
  assert.equal(after, before, '非法原定义不能覆盖此前成功认领的 native 对象');
  assert.equal(actualAuth['x-visible-one'], 'initial'); assert.equal(actualAuth['x-visible-two'], 'kept');
  assert.equal(f.native(), f.base, '随后真实 unregister 必须仍能释放原成功 claim');
  assert.equal(f.model(), f.physical);
  assert.ok(f.authReads() > 0, '认证头断言必须消费原 SDK getAuth');
});

await test('Worker 同 origin：有效重登记、headers:undefined 保留、空 headers 清空、unregister 恢复同一原 native', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const r = await f.open(project => factory(project, `
    pi.registerProvider(id,{headers:{'x-visible-one':'initial','x-visible-two':'replaced'}});
    pi.on('session_start',async()=>{
      await gate(1);pi.registerProvider(id,{headers:{'x-visible-one':'second'}});
      await gate(2);pi.registerProvider(id,{headers:undefined});
      await gate(3);pi.registerProvider(id,{headers:{}});
      await gate(4);pi.unregisterProvider(id);
    });
  `));
  const preparing = r.prepare();
  await until(() => f.native() !== f.base && f.model().headers?.['x-visible-one'] === 'initial');
  const initial = f.native();
  await r.release(1); await until(() => f.native() !== initial && f.model().headers?.['x-visible-one'] === 'second');
  const second = f.native(); assert.deepEqual(visible(f.model()), { 'x-visible-one': 'second' });
  await r.release(2); await until(() => f.native() !== second);
  const retained = f.native(); assert.deepEqual(visible(f.model()), { 'x-visible-one': 'second' });
  assert.equal((await f.authHeaders())['x-visible-one'], 'second', '合法 headers:undefined 沿已声明语义保留当前公开 patch');
  await r.release(3); await until(() => f.native() !== retained);
  assert.deepEqual(visible(f.model()), {}, 'headers:{} 明确清空旧 patch，不能按 merge 遗留旧字段');
  assert.equal((await f.authHeaders())['x-visible-one'], undefined);
  await r.release(4); await preparing;
  assert.equal(f.native(), f.base); assert.equal(f.model(), f.physical);
  await r.resource.close(); assert.equal(f.native(), f.base, '已 unregister 后 close 不能重复替换其他对象');
});

await test('Worker 跨 resource origin：共享原 provider 所有者不能抢 claim，失败 close 不释放别人，原 owner close 恢复原 native', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const first = await f.open(project => factory(project, "pi.registerProvider(id,{headers:{'x-visible-one':'first-origin'}});"));
  await first.prepare(); const own = f.native(); assert.notEqual(own, f.base);
  const second = await f.open(project => factory(project, "pi.registerProvider(id,{headers:{'x-visible-one':'second-origin'}});"));
  await assert.rejects(second.prepare(), CodingResourcesUnavailable);
  assert.equal(f.native(), own, '第二个真实 Worker 的登记失败不能抢走第一个 Worker 的对象认领');
  assert.equal((await f.authHeaders())['x-visible-one'], 'first-origin');
  await second.resource.close(); assert.equal(f.native(), own, '失败 Worker 的清理不能释放另一个 origin');
  await first.resource.close(); assert.equal(f.native(), f.base);
  assert.equal(f.model(), f.physical); assert.equal((await f.authHeaders())['x-visible-one'], undefined);
});
