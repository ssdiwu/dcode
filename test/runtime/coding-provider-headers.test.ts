// 普通扩展provider公开头的真实消费者与边界；运行结果及源码资格见本片验证记录。
// 真实 SDK auth/目录/参数派发；受控 provider stream 只是无网络外部边界，不证明 HTTP 或 Harness owner。
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createProvider, createAssistantMessageEventStream, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import type { Api, AnyModel, AssistantMessage, ImageModel, Model, Provider, ProviderStreams } from '@earendil-works/pi-ai';
import { CodingProviderHeaders } from '../../src/adapters/pi/coding-provider-headers.ts';

const id = 'dcode-public-header-fixture';
const sameId = 'same-id-chat-and-image';
const key = 'isolated-header-fixture-not-a-real-key';
const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const lower = (headers: Readonly<Record<string, unknown>> = {}) => Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
const withoutHeaders = (model: AnyModel) => { const copy = { ...model }; delete copy.headers; return copy; };

async function fixture(t: TestContext, options: { kind?: 'apiKey' | 'oauth'; dynamicPrivate?: string } = {}) {
  const credentials = new InMemoryCredentialStore();
  const oauthCredential = { type: 'oauth' as const, access: key, refresh: 'isolated-refresh-not-real', expires: Date.now() + 86_400_000 };
  await credentials.modify(id, async () => options.kind === 'oauth' ? oauthCredential : { type: 'api_key', key });
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  // 仅隔离未使用的 builtin 边界：所有替换同步完成后才有第一个 await，绝不发现真实环境/文件凭据。
  for (const builtin of runtime.getProviders()) runtime.registerNativeProvider({ ...builtin,
    getModels: () => [], getAllModels: () => [], refreshModels: undefined,
    auth: { apiKey: { name: 'denied ambient fixture', check: async () => undefined, resolve: async () => undefined } } });
  const calls = { resolve: 0, toAuth: 0, login: 0, refresh: 0, filter: 0, filterAll: 0 };
  const dispatches: { model: Model<Api>; headers: Record<string, unknown>; apiKey?: string }[] = [];
  const authHeaders = { 'X-Priority': 'from-auth', 'X-Host-Keep': 'host-kept',
    ...(options.dynamicPrivate ? { [options.dynamicPrivate]: 'host-dynamic-private-value' } : {}) };
  const auth: Provider['auth'] = options.kind === 'oauth' ? { oauth: {
    name: 'controlled OAuth',
    async login() { calls.login++; throw new Error('No interactive login in registration fixture'); },
    async refresh() { calls.refresh++; throw new Error('Unexpired in-memory OAuth must not refresh'); },
    async toAuth(credential) { calls.toAuth++; assert.equal(credential.type, 'oauth'); assert.equal(credential.access, key);
      return { apiKey: credential.access, headers: { ...authHeaders } }; },
  } } : { apiKey: {
    name: 'controlled memory key',
    async check(input) { return input.credential?.key === key ? { type: 'api_key', source: 'controlled memory' } : undefined; },
    async resolve(input) { calls.resolve++; assert.ok(input.credential); assert.equal(input.credential.key, key); assert.equal(input.signal.aborted, false);
      return { auth: { apiKey: input.credential.key, headers: { ...authHeaders } }, source: 'controlled memory' }; },
  } };
  const stream: ProviderStreams['streamSimple'] = (model, _context, opts) => {
    dispatches.push({ model, headers: lower(opts?.headers), apiKey: opts?.apiKey });
    const events = createAssistantMessageEventStream();
    const message: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      content: [{ type: 'text', text: 'controlled SDK dispatch only' }], stopReason: 'stop', timestamp: 1,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...cost, total: 0 } } };
    events.push({ type: 'done', reason: 'stop', message }); events.end(message); return events;
  };
  function makeBase(generation = 1, providerId = id) {
    const chat: Model<Api> = { id: sameId, name: `chat-generation-${generation}`, provider: providerId, api: 'openai-completions',
      baseUrl: 'https://invalid.invalid', input: generation === 1 ? ['text'] : ['text', 'image'], cost,
      reasoning: generation > 1, ...(generation > 1 ? { thinkingLevelMap: { high: 'high' } } : {}),
      contextWindow: generation === 1 ? 32768 : 131072, maxTokens: generation === 1 ? 1024 : 8192,
      headers: { 'x-priority': 'from-original-model', 'X-Model-Only': `model-${generation}` } };
    const secondary: Model<Api> = { ...chat, id: generation === 1 ? 'retired-model' : 'new-model', headers: { 'X-Model-Only': 'secondary' } };
    const image: ImageModel<'openrouter-images'> = { type: 'image', id: sameId, name: `image-generation-${generation}`, provider: providerId,
      api: 'openrouter-images', baseUrl: 'https://invalid.invalid', input: ['text'], output: ['image'], cost,
      headers: { 'X-Typed-Only': 'typed-kept' } };
    const provider = createProvider({ id: providerId, name: 'managed source', headers: { 'X-Provider-Only': 'provider-kept' },
      models: [chat, secondary, image], auth, api: { stream, streamSimple: stream },
      filterModels(models) { calls.filter++; return models.filter(model => model.id !== 'retired-model'); },
      filterAllModels(models) { calls.filterAll++; return models.filter(model => model.type === 'image' || model.id !== 'retired-model'); },
    });
    return { provider, chat, secondary, image };
  }
  const initial = makeBase(); runtime.registerNativeProvider(initial.provider);
  await runtime.refresh({ allowNetwork: false });
  const headers = new CodingProviderHeaders(runtime, [id]);
  const claims: object[] = [];
  const register = (config: unknown, claim: object, previousClaim?: object) => { headers.register(id, config, claim, previousClaim); claims.push(claim); };
  const native = () => { const value = runtime.getRegisteredNativeProvider(id); assert.ok(value); return value; };
  const model = () => { const value = runtime.getModel(id, sameId); assert.ok(value); return value; };
  t.after(async () => { for (const claim of claims) headers.release(id, claim); await runtime.refresh({ allowNetwork: false }); });
  return { runtime, credentials, headers, initial, makeBase, register, native, model, calls, dispatches, authHeaders };
}

await test('有限 header：真实 SDK 合入 Model.headers，保全原目录/typed/filter及原 auth/stream 消费', { timeout: 15000 }, async t => {
  const f = await fixture(t); const claim = {};
  f.register({ headers: { 'X-Visible-One': 'public-patch' } }, claim);
  const projected = f.native(); const model = f.model();
  assert.notEqual(projected, f.initial.provider); assert.notEqual(model, f.initial.chat);
  assert.equal(projected.stream, f.initial.provider.stream); assert.equal(projected.streamSimple, f.initial.provider.streamSimple);
  assert.equal(projected.headers, f.initial.provider.headers, '原managed provider元数据头保留');
  assert.equal(projected.filterModels, f.initial.provider.filterModels); assert.equal(projected.filterAllModels, f.initial.provider.filterAllModels);
  assert.equal(projected.auth.apiKey?.check, f.initial.provider.auth.apiKey?.check);
  assert.deepEqual(withoutHeaders(model), withoutHeaders(f.initial.chat), '只允许 header 变化，不能改身份/API/端点/能力');
  assert.deepEqual(f.runtime.getModels(id).map(m => m.id), [sameId, 'retired-model']);
  const all = f.runtime.getAllModels(id); assert.equal(all.length, 3);
  assert.equal(f.runtime.getModelOfType('image', id, sameId), f.initial.image, '同 id typed 模型保原对象和原头，不冒称 typed patch');
  assert.equal(all.filter(m => m.id === sameId).length, 2, 'chat/image 同 id 不能互相顶掉');
  assert.deepEqual(f.initial.chat.headers, { 'x-priority': 'from-original-model', 'X-Model-Only': 'model-1' });
  assert.equal(f.runtime.getRegisteredProviderConfig(id), undefined, '有限 native 投影不伪造 SDK config introspection');
  const before = f.calls.resolve;
  const resolved = await f.runtime.getAuth(model); assert.ok(resolved);
  assert.equal(f.calls.resolve, before + 1, '必须真实调用原 resolve，而非只合并夹具 headers');
  assert.equal(resolved.auth.apiKey, key);
  assert.deepEqual(lower(resolved.auth.headers), { 'x-priority': 'from-original-model', 'x-host-keep': 'host-kept',
    'x-visible-one': 'public-patch', 'x-model-only': 'model-1' });
  await f.runtime.refresh({ allowNetwork: false });
  assert.deepEqual(f.runtime.getAvailableSnapshot().filter(m => m.provider === id).map(m => m.id), [sameId], '真实 filter 仍排除 retired');
  assert.deepEqual((await f.runtime.getAllAvailable(id)).map(m => `${m.type ?? 'chat'}:${m.id}`), [`chat:${sameId}`, `image:${sameId}`]);
  assert.ok(f.calls.filterAll > 0, 'typed可用集合也继续消费原filterAllModels');
  assert.ok(f.calls.filter > 0); assert.deepEqual(f.authHeaders, { 'X-Priority': 'from-auth', 'X-Host-Keep': 'host-kept' });
});

await test('有限 header：caller 头晚于 auth/model/patch，transform 看到真实合并参数再交原 stream', { timeout: 15000 }, async t => {
  const f = await fixture(t); f.register({ headers: { 'x-visible-one': 'patch' } }, {});
  let seen: Record<string, unknown> | undefined;
  const before = f.calls.resolve;
  const result = await f.runtime.streamSimple(f.model(), { messages: [] }, {
    headers: { 'X-Visible-One': 'caller', 'X-Priority': 'caller-priority', 'X-Caller-Only': 'caller-only' },
    transformHeaders(value) { seen = lower(value); return { ...value, 'X-Transform-Only': 'last-stage' }; }, maxRetries: 0,
  }).result();
  assert.equal(result.stopReason, 'stop'); assert.equal(f.calls.resolve, before + 1);
  assert.equal(f.dispatches.length, 1); assert.equal(f.dispatches[0]!.apiKey, key);
  assert.equal(seen?.['x-visible-one'], 'caller'); assert.equal(seen?.['x-priority'], 'caller-priority');
  assert.equal(seen?.['x-model-only'], 'model-1'); assert.equal(seen?.['x-host-keep'], 'host-kept');
  assert.deepEqual(f.dispatches[0]!.headers, { ...seen, 'x-transform-only': 'last-stage' });
  assert.deepEqual(lower(f.model().headers)['x-visible-one'], 'patch', 'caller 不回写目录 patch');
});

await test('重登记：defined headers 替换整块，undefined保留，空块清除；旧claim不能release新登记', { timeout: 15000 }, async t => {
  const f = await fixture(t); const a = {}, b = {}, c = {}, d = {}, e = {};
  f.register({ headers: { 'X-Visible-One': 'one', 'X-Visible-Two': 'two' } }, a);
  f.register({ headers: { 'x-visible-one': 'new-one' } }, b, a);
  const ownedB = f.native(); assert.equal(lower(f.model().headers)['x-visible-one'], 'new-one');
  assert.equal(lower(f.model().headers)['x-visible-two'], undefined, 'defined字段覆盖，不是逐header偷偷保留旧值');
  f.headers.release(id, a); assert.equal(f.native(), ownedB); f.headers.assertCurrent();
  f.register({ headers: undefined }, c, b); assert.equal(lower(f.model().headers)['x-visible-one'], 'new-one');
  f.register({}, d, c); assert.equal(lower(f.model().headers)['x-visible-one'], 'new-one');
  const beforeInvalid = f.native(); assert.throws(() => f.headers.register(id, { headers: null }, {}, d));
  assert.equal(f.native(), beforeInvalid); f.headers.assertCurrent();
  f.register({ headers: {} }, e, d); assert.equal(lower(f.model().headers)['x-visible-one'], undefined);
  f.headers.release(id, e); assert.equal(f.native(), f.initial.provider); f.headers.assertCurrent();
  f.headers.release(id, e); assert.equal(f.native(), f.initial.provider, 'unregister/close重复release幂等；本例不假称真实close');
});

await test('认领：错误previous claim失败；外部native替换后assertCurrent拒绝且旧release不删除外部', { timeout: 15000 }, async t => {
  const f = await fixture(t); const claim = {};
  assert.throws(() => f.headers.register(id, { headers: { 'x-visible-one': 'x' } }, {}, {}));
  assert.equal(f.native(), f.initial.provider);
  f.register({ headers: { 'x-visible-one': 'own' } }, claim); const own = f.native();
  assert.throws(() => f.headers.register(id, { headers: { 'x-visible-two': 'wrong-owner' } }, {}, {})); assert.equal(f.native(), own);
  const external = f.makeBase(3); f.runtime.registerNativeProvider(external.provider);
  f.headers.refresh([]); assert.throws(() => f.headers.assertCurrent());
  f.headers.release(id, claim); assert.equal(f.native(), external.provider);
  assert.equal(f.runtime.getModel(id, sameId), external.chat); f.headers.assertCurrent();
  assert.throws(() => f.headers.register(id, { headers: { 'x-visible-one': 'reclaim' } }, {}), '不能把外部新对象默认为旧managed base');
});

await test('认领：外部SDK config登记替换native后，旧release保留真实config对象', { timeout: 15000 }, async t => {
  const f = await fixture(t); const claim = {}; f.register({ headers: { 'x-visible-one': 'own' } }, claim);
  f.runtime.registerProvider(id, { api: 'openai-completions', baseUrl: f.initial.chat.baseUrl, models: [f.initial.chat] });
  const external = f.runtime.getRegisteredProviderConfig(id); assert.ok(external);
  assert.equal(f.runtime.getRegisteredNativeProvider(id), undefined); assert.throws(() => f.headers.assertCurrent());
  f.headers.release(id, claim); assert.equal(f.runtime.getRegisteredProviderConfig(id), external);
  assert.equal(f.runtime.getRegisteredNativeProvider(id), undefined);
});

await test('可信refresh：使用真实新base模型集/能力，保patch，release恢复最新base而非最初对象', { timeout: 15000 }, async t => {
  const f = await fixture(t); const claim = {}; f.register({ headers: { 'x-visible-one': 'survives-refresh' } }, claim);
  const updated = f.makeBase(2); f.runtime.registerNativeProvider(updated.provider);
  f.headers.refresh([id, id]); f.headers.assertCurrent();
  assert.notEqual(f.native(), updated.provider); assert.equal(f.native().streamSimple, updated.provider.streamSimple);
  assert.deepEqual(f.runtime.getModels(id).map(m => m.id), [sameId, 'new-model']);
  assert.equal(f.runtime.getModel(id, 'retired-model'), undefined);
  assert.deepEqual(withoutHeaders(f.model()), withoutHeaders(updated.chat));
  assert.equal(f.model().contextWindow, 131072); assert.equal(f.model().maxTokens, 8192);
  assert.deepEqual(f.model().input, ['text', 'image']); assert.equal(f.model().thinkingLevelMap?.high, 'high');
  assert.equal(lower(f.model().headers)['x-visible-one'], 'survives-refresh');
  assert.equal(f.runtime.getModelOfType('image', id, sameId), updated.image);
  f.headers.release(id, claim); assert.equal(f.native(), updated.provider);
  assert.equal(f.runtime.getModel(id, sameId), updated.chat); assert.equal(f.runtime.getModel(id, 'new-model'), updated.secondary);
  assert.equal(lower(f.model().headers)['x-visible-one'], undefined);
});

await test('登记范围：未知id、已注册但未managed来源、无chat来源不能被当作受管来源', { timeout: 15000 }, async t => {
  const f = await fixture(t); const other = f.makeBase(1, 'registered-but-not-managed'); f.runtime.registerNativeProvider(other.provider);
  const imageOnly = { ...other.provider, id: 'image-only-not-managed', getModels: () => [],
    getAllModels: () => [{ ...other.image, provider: 'image-only-not-managed' }] };
  f.runtime.registerNativeProvider(imageOnly);
  const scope = new CodingProviderHeaders(f.runtime, [id, imageOnly.id]);
  for (const unknown of ['unknown-source', 'registered-but-not-managed', imageOnly.id, '', ' ']) {
    assert.throws(() => scope.register(unknown, { headers: { 'x-visible-one': 'bad-scope' } }, {}), unknown);
  }
  assert.equal(f.native(), f.initial.provider); assert.equal(f.runtime.getRegisteredNativeProvider(other.provider.id), other.provider);
  assert.equal(f.runtime.getRegisteredNativeProvider(imageOnly.id), imageOnly);
});

await test('非法config/header在当前成功登记上拒绝，且不丢原claim或改变原模型/认证', { timeout: 15000 }, async t => {
  const f = await fixture(t); const claim = {}; f.register({ headers: { 'x-visible-one': 'kept' } }, claim); const own = f.native();
  const cases: [string, () => unknown][] = [
    ['undefined config', () => undefined], ['null config', () => null], ['array config', () => []], ['primitive config', () => 'headers'],
    ['unsupported api', () => ({ api: 'openai-completions' })], ['unsupported models even undefined', () => ({ models: undefined })],
    ['unsupported stream function', () => ({ streamSimple() {} })], ['unsupported OAuth', () => ({ oauth: {} })],
    ['null headers', () => ({ headers: null })], ['array headers', () => ({ headers: [] })], ['function headers', () => ({ headers() {} })],
    ['number value', () => ({ headers: { 'x-visible-two': 3 } })], ['boolean value', () => ({ headers: { 'x-visible-two': true } })],
    ['object value', () => ({ headers: { 'x-visible-two': { nested: 'not a string' } } })], ['NaN', () => ({ headers: { 'x-visible-two': NaN } })],
    ['Infinity', () => ({ headers: { 'x-visible-two': Infinity } })], ['function value', () => ({ headers: { 'x-visible-two': () => 'not serializable' } })],
    ['undefined value', () => ({ headers: { 'x-visible-two': undefined } })], ['null value', () => ({ headers: { 'x-visible-two': null } })],
    ['invalid name', () => ({ headers: { 'bad name': 'x' } })], ['long name', () => ({ headers: { ['x'.repeat(129)]: 'x' } })],
    ['same name case collision', () => ({ headers: { 'X-Visible-Two': 'one', 'x-visible-two': 'two' } })],
    ['CRLF value', () => ({ headers: { 'x-visible-two': 'one\r\nInjected: x' } })], ['DEL value', () => ({ headers: { 'x-visible-two': 'one\x7f' } })],
    ['environment reference', () => ({ headers: { 'x-visible-two': '$SHOULD_NEVER_BE_READ' } })],
    ['template reference', () => ({ headers: { 'x-visible-two': '${SHOULD_NEVER_BE_READ}' } })],
    ['command reference', () => ({ headers: { 'x-visible-two': '  !never-execute-this-fixture' } })],
    ['overlong value', () => ({ headers: { 'x-visible-two': 'x'.repeat(8193) } })],
    ['too many headers', () => ({ headers: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`x-n-${i}`, 'v'])) })],
    ['total config too large', () => ({ headers: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`x-n-${i}`, 'v'.repeat(8000)])) })],
    ['cyclic config', () => { const config: { headers: Record<string, unknown> } = { headers: {} }; config.headers['x-cycle'] = config; return config; }],
    ['throwing getter', () => Object.defineProperty({}, 'headers', { enumerable: true, get() { throw new Error('invalid getter fixture'); } })],
    ...['Authorization', 'x-API-key', 'X-Token', 'Cookie', 'x-secret', 'x-organization', 'x-project', 'x-account',
      'Accept', 'Content-Type', 'User-Agent', 'Host', 'Connection', 'Content-Length', 'Transfer-Encoding',
      'x-model-only', 'x-PROVIDER-only', 'x-TYPED-only'].map(name => [`reserved ${name}`, () => ({ headers: { [name]: 'forbidden' } })] as [string, () => unknown]),
  ];
  for (const [name, make] of cases) await t.test(name, () => {
    assert.throws(() => f.headers.register(id, make(), {}, claim), name);
    assert.equal(f.native(), own, `${name}: 不能先改SDK再报失败`); f.headers.assertCurrent();
    assert.equal(lower(f.model().headers)['x-visible-one'], 'kept');
  });
  const before = f.calls.resolve; assert.ok(await f.runtime.getAuth(f.model())); assert.equal(f.calls.resolve, before + 1);
  assert.equal(f.dispatches.length, 0); f.headers.release(id, claim); assert.equal(f.native(), f.initial.provider);
});

for (const kind of ['apiKey', 'oauth'] as const) await test(`动态私有名碰撞：原${kind}真实派生成功后拒绝x-probe大小写覆盖，release后恢复`, { timeout: 15000 }, async t => {
  const f = await fixture(t, { kind, dynamicPrivate: 'X-PrObE' });
  const before = await f.runtime.getAuth(f.model()); assert.ok(before); assert.equal(lower(before.auth.headers)['x-probe'], 'host-dynamic-private-value');
  const claim = {}; f.register({ headers: { 'x-probe': 'extension-must-not-win' } }, claim);
  assert.equal(lower(f.model().headers)['x-probe'], 'extension-must-not-win', '先证明确已接受非regex名称，拒绝必须来自原认证派生碰撞');
  const originalCalls = kind === 'apiKey' ? f.calls.resolve : f.calls.toAuth;
  await assert.rejects(f.runtime.getAuth(f.model()));
  assert.equal(kind === 'apiKey' ? f.calls.resolve : f.calls.toAuth, originalCalls + 1, '原auth必须被真实调用，不能仅按名称正则挡在外面');
  assert.equal(f.dispatches.length, 0, '仅证明认证阶段未派发受控provider，不能称真实HTTP0');
  assert.equal(f.calls.login, 0); assert.equal(f.calls.refresh, 0);
  f.headers.release(id, claim); assert.equal(f.native(), f.initial.provider);
  const after = await f.runtime.getAuth(f.model()); assert.ok(after); assert.equal(lower(after.auth.headers)['x-probe'], 'host-dynamic-private-value');
  assert.equal(after.auth.apiKey, key);
});
