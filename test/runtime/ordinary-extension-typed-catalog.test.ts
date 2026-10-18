// 普通扩展 ModelRegistry typed catalog 与安全 provider metadata 只读消费者；真实 Worker、ModelRuntime 与隔离认证。
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
import type { Api, AnyModel, AuthCheck, Model, Provider } from '@earendil-works/pi-ai';
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable';
import { CodingExtensions } from '../../src/adapters/pi/coding-extensions.ts';
import { until } from './fixtures.ts';

const credentialedProvider = 'dcode-typed-catalog-authorized';
const unconfiguredProvider = 'dcode-typed-catalog-unconfigured';
const cancellableProvider = 'dcode-typed-catalog-cancellable';
const sharedModelId = 'shared-id-across-model-types';
const secret = 'isolated-typed-catalog-fixture-secret';

const chatModel: Model<Api> = {
  type: 'chat', id: sharedModelId, name: 'Typed catalog chat', api: 'openai-completions', provider: credentialedProvider,
  baseUrl: 'https://invalid.invalid', input: ['text'], reasoning: false, contextWindow: 8192, maxTokens: 256,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, headers: { 'x-private-catalog-token': secret },
};
const classifierModel: AnyModel = {
  type: 'classifier', id: sharedModelId, name: 'Typed catalog classifier', api: 'typesafe-system-one', provider: credentialedProvider,
  baseUrl: 'https://invalid.invalid', input: ['text'], contextWindow: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, headers: { 'x-private-catalog-token': secret },
};
const imageModel: AnyModel = {
  type: 'image', id: 'typed-image', name: 'Typed catalog image', api: 'openrouter-images', provider: credentialedProvider,
  baseUrl: 'https://invalid.invalid', input: ['text'], output: ['image'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, headers: { 'x-private-catalog-token': secret },
};
const unconfiguredClassifier: AnyModel = {
  type: 'classifier', id: 'unconfigured-classifier', name: 'Unconfigured classifier', api: 'typesafe-system-one', provider: unconfiguredProvider,
  baseUrl: 'https://invalid.invalid', input: ['text'], contextWindow: 2048,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const unconfiguredImage: AnyModel = {
  type: 'image', id: 'unconfigured-image', name: 'Unconfigured image', api: 'openrouter-images', provider: unconfiguredProvider,
  baseUrl: 'https://invalid.invalid', input: ['text'], output: ['image'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const cancellableClassifier: AnyModel = {
  type: 'classifier', id: 'cancellable-classifier', name: 'Cancellable classifier', api: 'typesafe-system-one', provider: cancellableProvider,
  baseUrl: 'https://invalid.invalid', input: ['text'], contextWindow: 2048,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
type CatalogObservation = {
  chat: { provider?: string; id?: string; type?: string };
  classifier: { provider?: string; id?: string; type?: string };
  foundClassifier: { provider?: string; id?: string; type?: string };
  image: { provider?: string; id?: string; type?: string; output?: string[] };
  classRows: { provider: string; id: string; type: string }[];
  filteredClassRows: { provider: string; id: string; type: string }[];
  imageRows: { provider: string; id: string; type: string; output?: string[] }[];
  syncAvailableClassifier: { provider: string; id: string; type: string }[];
  syncAvailableImage: { provider: string; id: string; type: string; output?: string[] }[];
  missingAuthClassifier: string[];
  missingAuthImage: string[];
  providerDisplayName: string;
  unknownProviderDisplayName: string;
  registeredProviderIds: string[];
  providerMetadataIsPlain: boolean;
  unsupportedProviderOperationsRejected: boolean;
  safe: boolean;
  classifierExecutionRejected: boolean;
  imageExecutionRejected: boolean;
  cancellationSettled: boolean;
};

function isolatedProvider(provider: string, models: AnyModel[], available: boolean, onCheck?: (signal: AbortSignal) => Promise<AuthCheck | undefined>, displayName = provider, onExecution = () => {}): Provider {
  const classify = async () => { onExecution(); throw new Error('Catalog reads must not classify'); };
  const generateImages = async () => { onExecution(); throw new Error('Catalog reads must not generate images'); };
  return createProvider({
    id: provider,
    name: displayName,
    models,
    auth: { apiKey: {
      name: 'isolated test credential',
      check: async ({ credential, signal }) => onCheck ? onCheck(signal)
        : available && credential?.type === 'api_key' && credential.key === secret ? { type: 'api_key', source: 'isolated fixture' } : undefined,
      resolve: async ({ credential }) => credential?.type === 'api_key' && credential.key === secret
        ? { auth: { apiKey: secret }, source: 'isolated fixture' } : undefined,
    } },
    images: { 'openrouter-images': { generateImages } },
    classifiers: { 'typesafe-system-one': { classify } },
  });
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'dcode-extension-typed-catalog-'));
  const keepAlive = setInterval(() => {}, 1000);
  const project = join(directory, 'project');
  const agentDir = join(directory, 'agent');
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(credentialedProvider, async () => ({ type: 'api_key', key: secret }));
  await credentials.modify(cancellableProvider, async () => ({ type: 'api_key', key: secret }));
  let slowAuthChecks = 0;
  let slowAuthAborted = false;
  let blockSlowAuth = false;
  let modelExecutionAttempts = 0;
  const onExecution = () => { modelExecutionAttempts++; };
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  // 本资产只核宿主显式登记的三类模型，不让 ambient provider 或本机凭据影响可用性。
  for (const provider of runtime.getProviders()) runtime.registerNativeProvider({ ...provider,
    getModels: () => [], getAllModels: () => [], refreshModels: undefined,
    auth: { apiKey: { name: 'disabled ambient fixture', check: async () => undefined, resolve: async () => undefined } },
  });
  const shared = isolatedProvider(credentialedProvider, [chatModel, classifierModel, imageModel], true, undefined, 'Host credentialed provider', onExecution);
  const unconfigured = isolatedProvider(unconfiguredProvider, [unconfiguredClassifier, unconfiguredImage], false, undefined, undefined, onExecution);
  const cancellable = isolatedProvider(cancellableProvider, [cancellableClassifier], true, async signal => {
    if (!blockSlowAuth) return { type: 'api_key', source: 'isolated fixture' };
    slowAuthChecks++;
    if (signal.aborted) { slowAuthAborted = true; return undefined; }
    return await new Promise<AuthCheck | undefined>(resolve => {
      signal.addEventListener('abort', () => { slowAuthAborted = true; resolve(undefined); }, { once: true });
    });
  }, undefined, onExecution);
  runtime.registerNativeProvider(shared); runtime.registerNativeProvider(unconfigured); runtime.registerNativeProvider(cancellable);
  await runtime.refresh({ allowNetwork: false });

  await mkdir(join(project, '.pi/extensions'), { recursive: true }); await mkdir(agentDir);
  await writeFile(join(project, 'AGENTS.md'), 'Isolated typed model catalog fixture.\n');
  await writeFile(join(project, '.pi/settings.json'), JSON.stringify({ extensions: ['./extensions/catalog.mjs'] }));
  await writeFile(join(project, '.pi/mcp.json'), JSON.stringify({ mcpServers: {} }));
  await writeFile(join(project, '.pi/extensions/catalog.mjs'), `
    import { access, writeFile } from 'node:fs/promises';
    import { setTimeout as delay } from 'node:timers/promises';
    import { join } from 'node:path';
    const project=${JSON.stringify(project)};
    const gate=async name=>{const until=Date.now()+8000;for(;;){try{await access(join(project,name));return;}catch(error){if(error.code!=='ENOENT')throw error;}if(Date.now()>until)throw new Error('typed catalog test gate timed out');await delay(5);}};
    export default function(pi){
      pi.on('session_start',async(_,ctx)=>{
        await writeFile(join(project,'typed-catalog-ready.json'),'ready');
        await gate('.typed-catalog-start-release');
        const registry=ctx.modelRegistry;
        const providerDisplayName=registry.getProviderDisplayName(${JSON.stringify(credentialedProvider)});
        const unknownProviderDisplayName=registry.getProviderDisplayName('unknown-provider');
        const registeredProviderIds=registry.getRegisteredProviderIds();
        const chat=registry.getModelOfType('chat',${JSON.stringify(credentialedProvider)},${JSON.stringify(sharedModelId)});
        let unsupportedProviderOperationsRejected=true;
        for(const call of [
          ()=>registry.refresh(), ()=>registry.getError(), ()=>registry.hasConfiguredAuth(chat),
          ()=>registry.getProviderAuthStatus(${JSON.stringify(credentialedProvider)}), ()=>registry.getProvider(${JSON.stringify(credentialedProvider)}),
          ()=>registry.isUsingOAuth(chat), ()=>registry.getRegisteredProviderConfig(${JSON.stringify(credentialedProvider)}),
          ()=>registry.getRegisteredNativeProvider(${JSON.stringify(credentialedProvider)}),
        ]){try{await call();unsupportedProviderOperationsRejected=false;}catch{}}
        const classifier=registry.getModelOfType('classifier',${JSON.stringify(credentialedProvider)},${JSON.stringify(sharedModelId)});
        const foundClassifier=registry.findOfType('classifier',${JSON.stringify(credentialedProvider)},${JSON.stringify(sharedModelId)});
        const image=registry.getModelOfType('image',${JSON.stringify(credentialedProvider)},'typed-image');
        const classRows=registry.getModelsOfType('classifier').map(model=>({provider:model.provider,id:model.id,type:model.type}));
        const filteredClassRows=registry.getModelsOfType('classifier',${JSON.stringify(credentialedProvider)}).map(model=>({provider:model.provider,id:model.id,type:model.type}));
        const imageRows=registry.getModelsOfType('image').map(model=>({provider:model.provider,id:model.id,type:model.type,output:model.output}));
        const syncAvailableClassifier=await registry.getAvailableOfType('classifier',${JSON.stringify(credentialedProvider)}, {signal:ctx.abortSignal});
        const syncAvailableImage=await registry.getAvailableOfType('image',${JSON.stringify(credentialedProvider)}, {signal:ctx.abortSignal});
        const missingAuthClassifier=await registry.getAvailableOfType('classifier',${JSON.stringify(unconfiguredProvider)}, {signal:ctx.abortSignal});
        const missingAuthImage=await registry.getAvailableOfType('image',${JSON.stringify(unconfiguredProvider)}, {signal:ctx.abortSignal});
        let classifierExecutionRejected=false,imageExecutionRejected=false;
        // typed消费者公开合同以有限结果拒绝；目录事件没有工具owner，不能靠抛错作为唯一失败信号。
        classifierExecutionRejected=(await registry.classify(classifier,{})).stopReason==='error';
        const rejectedImage=await registry.generateImages(image,{});
        // 无工具owner时先拒绝，尚未读取调用方model；不能把未核身份伪装成一次实际请求。
        imageExecutionRejected=rejectedImage.stopReason==='error'&&Array.isArray(rejectedImage.output)&&rejectedImage.output.length===0
          &&rejectedImage.usage===undefined&&rejectedImage.api===''&&rejectedImage.provider===''&&rejectedImage.model==='';
        const controller=new AbortController();
        const pending=registry.getAvailableOfType('classifier',${JSON.stringify(cancellableProvider)},{signal:controller.signal});
        await writeFile(join(project,'typed-catalog-auth-pending.json'),'pending');
        await gate('.typed-catalog-abort-release');controller.abort();
        let cancellationSettled=false;
        try{await pending;cancellationSettled=true;}catch{cancellationSettled=true;}
        await writeFile(join(project,'typed-catalog-observation.json'),JSON.stringify({
          chat:{provider:chat?.provider,id:chat?.id,type:chat?.type??'chat'},
          classifier:{provider:classifier?.provider,id:classifier?.id,type:classifier?.type},
          foundClassifier:{provider:foundClassifier?.provider,id:foundClassifier?.id,type:foundClassifier?.type},
          image:{provider:image?.provider,id:image?.id,type:image?.type,output:image?.output},
          classRows,filteredClassRows,imageRows,
          syncAvailableClassifier:syncAvailableClassifier.map(model=>({provider:model.provider,id:model.id,type:model.type})),
          syncAvailableImage:syncAvailableImage.map(model=>({provider:model.provider,id:model.id,type:model.type,output:model.output})),
          missingAuthClassifier:missingAuthClassifier.map(model=>model.id),missingAuthImage:missingAuthImage.map(model=>model.id),
          providerDisplayName,unknownProviderDisplayName,registeredProviderIds,
          providerMetadataIsPlain:typeof providerDisplayName==='string'&&registeredProviderIds.every(id=>typeof id==='string'),
          unsupportedProviderOperationsRejected,
          safe:!/(x-private-catalog-token|${secret})/i.test(JSON.stringify({chat,classifier,image,classRows,imageRows,syncAvailableClassifier,syncAvailableImage})),
          classifierExecutionRejected,imageExecutionRejected,cancellationSettled,
        }));
      });
    }
  `);

  const registry = createRegistry();
  const harness = await Harness.open(new MemoryStorage(), { models: runtime, registry,
    settings: { retry: { maxRetries: 0 }, stream: { maxRetries: 0 }, toolExecution: 'sequential' } }, context);
  const root = await harness.root(context, { agent: { model: { provider: credentialedProvider, modelId: sharedModelId }, cwd: project } });
  const resource = new CodingExtensions([], agentDir, () => true, runtime, randomUUID());
  resource.attach(harness, root); resource.useRegistry(registry);
  const pending: Promise<unknown>[] = [];
  const prepare = () => {
    const own = (async () => {
      const result = await resource.prepare(project);
      assert.ok('add' in result && result.add?.length === 1);
      for (const extension of result.add) registry.install(extension);
      await root.configure({ extensions: { add: result.add }, tools: result.tools }, context);
      assert.equal((await harness.inspect(context)).tasks.length, 0, '目录读取不得启动模型或虚构 Durable 任务');
    })();
    own.catch(() => {}); pending.push(own); return own;
  };
  t.after(async () => {
    try {
      await writeFile(join(project, '.typed-catalog-start-release'), 'cleanup');
      await writeFile(join(project, '.typed-catalog-abort-release'), 'cleanup');
      await Promise.allSettled(pending);
      try { await resource.close(); } finally { await harness.close(context); }
      assert.equal(slowAuthChecks === 0 || slowAuthAborted, true, '本资产中断的宿主认证检查须收到取消 signal');
    } finally { clearInterval(keepAlive); await rm(directory, { recursive: true, force: true }); }
  });
  return { directory, project, runtime, harness, prepare, slowAuthChecks: () => slowAuthChecks,
    slowAuthAborted: () => slowAuthAborted, modelExecutionAttempts: () => modelExecutionAttempts,
    blockSlowAuth: (enabled: boolean) => { blockSlowAuth = enabled; } };
}

await test('普通扩展 typed model catalog 和 provider metadata 使用宿主目录，认证可取消且敏感/主动操作拒绝', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const marker = (name: string) => readFile(join(f.project, name), 'utf8').then(() => true, error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  });
  const preparing = f.prepare();
  await until(() => marker('typed-catalog-ready.json'));
  f.blockSlowAuth(true);
  await writeFile(join(f.project, '.typed-catalog-start-release'), 'release');
  await until(() => marker('typed-catalog-auth-pending.json'));
  await until(() => f.slowAuthChecks() > 0);
  await writeFile(join(f.project, '.typed-catalog-abort-release'), 'release');
  await preparing;

  const observation = JSON.parse(await readFile(join(f.project, 'typed-catalog-observation.json'), 'utf8')) as CatalogObservation;
  assert.equal(observation.providerDisplayName, 'Host credentialed provider', 'provider display name must come from the host registry, not the Worker default');
  assert.equal(observation.unknownProviderDisplayName, 'unknown-provider', 'unknown provider keeps the SDK identifier fallback');
  assert.deepEqual(observation.registeredProviderIds, f.runtime.getRegisteredProviderIds(), 'registered provider IDs mirror the host registration order');
  assert.ok(observation.registeredProviderIds.includes(credentialedProvider), 'host registrations must not disappear into the Worker default registry');
  assert.equal(observation.providerMetadataIsPlain, true, 'the Worker receives only names and IDs, not Provider objects');
  assert.equal(observation.unsupportedProviderOperationsRejected, true, 'unsupported provider/auth surfaces must reject instead of consulting the Worker default');
  assert.deepEqual(observation.chat, { provider: credentialedProvider, id: sharedModelId, type: 'chat' });
  assert.deepEqual(observation.classifier, { provider: credentialedProvider, id: sharedModelId, type: 'classifier' }, '同 ID 的 classifier 不得误落回 chat 模型');
  assert.deepEqual(observation.foundClassifier, observation.classifier, 'findOfType 与 getModelOfType 使用同一宿主类型目录');
  assert.deepEqual(observation.image, { provider: credentialedProvider, id: 'typed-image', type: 'image', output: ['image'] });
  assert.ok(observation.classRows.some((model: Record<string, string>) => model.provider === credentialedProvider && model.id === sharedModelId && model.type === 'classifier'));
  assert.ok(observation.classRows.some((model: Record<string, string>) => model.provider === unconfiguredProvider), '完整目录保留未配置 provider 的登记模型');
  assert.deepEqual(observation.filteredClassRows, [{ provider: credentialedProvider, id: sharedModelId, type: 'classifier' }]);
  assert.ok(observation.imageRows.some((model: Record<string, unknown>) => model.provider === credentialedProvider && model.id === 'typed-image' && model.type === 'image'));
  assert.deepEqual(observation.syncAvailableClassifier, [{ provider: credentialedProvider, id: sharedModelId, type: 'classifier' }]);
  assert.deepEqual(observation.syncAvailableImage, [{ provider: credentialedProvider, id: 'typed-image', type: 'image', output: ['image'] }]);
  assert.deepEqual(observation.missingAuthClassifier, []); assert.deepEqual(observation.missingAuthImage, []);
  assert.equal(observation.safe, true, 'Worker 仅收到公开模型描述，不得收到 headers/API key');
  assert.equal(observation.classifierExecutionRejected, true); assert.equal(observation.imageExecutionRejected, true);
  assert.equal(f.modelExecutionAttempts(), 0, '目录事件的两类主动模型调用都必须在真正provider执行前有限拒绝');
  assert.equal(observation.cancellationSettled, true); assert.equal(f.slowAuthAborted(), true);
  assert.equal((await f.harness.inspect(context)).tasks.length, 0, '查询、认证可用性与取消没有产生模型子任务');
});
