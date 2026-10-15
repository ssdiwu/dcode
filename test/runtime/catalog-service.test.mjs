// ProviderCatalogService / remote-catalog 行为：
// A→B 缓存、304 无正文不冒称成功、写盘失败落 lastError（不 refresh ok:true）、换源旧请求不盖新源、
// 取消在 commit 点生效、builtin 精确模型保留本地 baseUrl、同供应商/本地已确认协议的新线上模型
// 以 anchor endpoint 可执行（claude-haiku-5-5 形态）、未知协议显示为不可执行。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderDirectoryStore } from '../../src/adapters/pi/provider-directory-store.ts';
import { ProviderCatalogService } from '../../src/adapters/pi/catalog-service.ts';
import { sanitizeCatalogModel, fetchProviderCatalog } from '../../src/adapters/pi/remote-catalog.ts';
import { registerPresetProviders } from '../../src/adapters/pi/preset-providers.ts';

const stubCipher = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from(s, 'utf8'),
  decrypt: (buf) => Buffer.from(buf).toString('utf8'),
};

const modelA = (id = 'm-a') => sanitizeCatalogModel('testco', {
  id, name: 'Model A', api: 'openai-completions', provider: 'testco',
  baseUrl: 'https://api.testco.com/v1',
  reasoning: false, input: ['text'],
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000, maxTokens: 4096, type: 'chat',
});

test('sanitizeCatalogModel：只保留 chat 并过全形状校验；classifier 与坏形拒绝', () => {
  assert.ok(modelA());
  assert.equal(sanitizeCatalogModel('testco', { id: 'x', type: 'classifier' }), null);
  assert.equal(sanitizeCatalogModel('testco', { id: 'x' }), null); // 缺 api/baseUrl/input
  assert.equal(sanitizeCatalogModel('testco', { id: 'x', api: 'openai-completions', baseUrl: 'not-a-url' }), null);
});

test('公开请求不携带认证头；?types=chat 参数', async () => {
  const captured = [];
  const fakeFetch = async (url, init) => {
    captured.push({ url: String(url), headers: init.headers });
    return new Response(JSON.stringify([modelA()]), {
      status: 200,
      headers: { 'content-type': 'application/json', 'last-modified': new Date(1_800_000_000_000).toUTCString(), 'etag': 'W/"fix-A"' },
    });
  };
  const outcome = await fetchProviderCatalog({ baseUrl: 'http://127.0.0.1:9', providerId: 'testco', fetchImpl: fakeFetch });
  assert.equal(outcome.kind, 'ok');
  assert.equal(captured.length, 1);
  assert.ok(String(captured[0].url).includes('/api/models/providers/testco'));
  assert.ok(String(captured[0].url).includes('types=chat'));
  const headerKeys = Object.keys(captured[0].headers).map((h) => h.toLowerCase());
  assert.ok(!headerKeys.includes('authorization'), '公共请求不得携带 Authorization');
  assert.ok(!headerKeys.some((h) => h.includes('token') || h.includes('key')), '不携带密钥类头');
  assert.ok(headerKeys.includes('accept') && headerKeys.includes('user-agent'));
});

test('304 但没有有效缓存正文：不能当作新目录成功', async () => {
  // 304 不应携带 body；带 body 的 Response 属非法响应（Node fetch 会 reject 处理为 network-failed）
  const fakeFetch = async () => new Response(null, { status: 304 });
  const outcome = await fetchProviderCatalog({ baseUrl: 'http://127.0.0.1:9', providerId: 'testco', fetchImpl: fakeFetch });
  assert.equal(outcome.kind, 'failed');
  assert.match(outcome.message ?? '', /304/);
});

test('catalog 服务刷新：A→B 实际进入生效视图、304 有缓存则延长 freshness、写盘失败落 lastError 且不报 ok', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dcode-cat-'));
  try {
    const store = new ProviderDirectoryStore({ stateDir }, stubCipher, { catalogBaseUrl: 'http://fixture.catalog' });
    const presets = [{ id: 'testco', name: 'TestCo', provider: { id: 'testco', name: 'TestCo', baseUrl: 'https://api.testco.com/v1', auth: {}, getModels: () => [] }, authKinds: ['api_key'] }];
    let phase = 'A';
    let lastModified = 1_800_000_000_000;
    const fetchOne = async ({ providerId }) => {
      if (providerId !== 'testco') return { kind: 'failed', message: 'unexpected-provider' };
      if (phase === 'A') return { kind: 'ok', entry: { models: [modelA('m-a')], checkedAt: 100, lastModified, etag: 'W/"A"' } };
      if (phase === 'B') return { kind: 'ok', entry: { models: [modelA('m-a'), modelA('m-b')], checkedAt: 200, lastModified: lastModified + 1, etag: 'W/"B"' } };
      return { kind: 'not-modified', checkedAt: 300 };
    };
    const svc = new ProviderCatalogService({ store, presets, fetchOne });
    await svc.init();
    let refreshed = await svc.refresh();
    assert.equal(refreshed.ok, true);
    let view = await svc.view();
    assert.equal(view.models.testco.length, 1);
    assert.equal(view.models.testco[0].id, 'm-a');
    // B 更新与新模型进入
    phase = 'B';
    refreshed = await svc.refresh();
    assert.equal(refreshed.ok, true);
    view = await svc.view();
    assert.equal(view.models.testco.length, 2, 'B 更新的新模型进入目录');
    assert.ok(view.models.testco.some((m) => m.id === 'm-b'));
    // 304 有有效缓存：延长 freshness，不丢目录
    phase = '304';
    refreshed = await svc.refresh();
    assert.equal(refreshed.ok, true);
    view = await svc.view();
    assert.equal(view.models.testco.length, 2);
    assert.equal(view.source.lastSuccessAt, 300);
    // 写盘失败：lastError 落档，refresh 不再报 true
    // modify 走 #writeAtomic 不按类方法 write；用 store 的隔离注入（仅供测试）触发相同失败
    store.injectWriteFailureOnce(new Error('disk-full'));
    phase = 'B';
    refreshed = await svc.refresh();
    assert.equal(refreshed.ok, false, '写盘失败不能 refresh ok:true');
    await store.read().catch(() => null);
    const after = await svc.view();
    assert.ok(after.source.lastError, '写盘失败必须落 lastError');
    assert.ok((after.source.lastError ?? '').includes('catalog-cache-commit-failed'));
    // 有效资料仍在（B 目录没被丢）
    assert.equal(after.models.testco.length, 2);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('换源立即吊销在途；旧源结果在 commit 点被拒不写新源', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dcode-cat-switch-'));
  try {
    const store = new ProviderDirectoryStore({ stateDir }, stubCipher, { catalogBaseUrl: 'http://source-a' });
    const presets = [{ id: 'testco', name: 'TestCo', provider: { id: 'testco', name: 'TestCo', baseUrl: 'https://api.testco.com/v1', auth: {}, getModels: () => [] }, authKinds: ['api_key'] }];
    let releaseOldFetch;
    const oldFetchGate = new Promise((r) => { releaseOldFetch = r; });
    const fetchOne = async ({ baseUrl }) => {
      if (baseUrl === 'http://source-a') {
        await oldFetchGate;
        return { kind: 'ok', entry: { models: [modelA('m-a')], checkedAt: 1, lastModified: 1, etag: 'W/"A"' } };
      }
      return { kind: 'ok', entry: { models: [modelA('m-b')], checkedAt: 2, lastModified: 2, etag: 'W/"B"' } };
    };
    const svc = new ProviderCatalogService({ store, presets, fetchOne });
    await svc.init();
    const first = svc.refresh();
    await Promise.resolve(); await Promise.resolve();
    const switchedPromise = svc.setSource('http://source-b');
    releaseOldFetch();
    const switched = await switchedPromise;
    await first.catch(() => undefined);
    assert.equal(switched.ok, true);
    const view = await svc.view();
    assert.equal(view.source.baseUrl, 'http://source-b');
    assert.equal(view.models.testco.length, 1);
    assert.equal(view.models.testco[0].id, 'm-b', '旧源迟到结果不得覆盖新源');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('跨源反例：A 源 200 缓存后换 B 源，旧 ETag 不带去 B；B 返回 304 无 B 正文不能当成功，B 失败保留 A 的正文与 A 的成功时间', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dcode-cat-cross-'));
  try {
    const store = new ProviderDirectoryStore({ stateDir }, stubCipher, { catalogBaseUrl: 'http://source-a' });
    const presets = [{ id: 'testco', name: 'TestCo', provider: { id: 'testco', name: 'TestCo', baseUrl: 'https://api.testco.com/v1', auth: {}, getModels: () => [] }, authKinds: ['api_key'] }];
    const captured = [];
    let mode = 'A-200';
    const fetchOne = async ({ baseUrl, etag }) => {
      captured.push({ baseUrl, etag: etag ?? null });
      if (mode === 'A-200') return { kind: 'ok', entry: { models: [modelA('m-a')], checkedAt: 111, lastModified: 111, etag: 'W/"A-etag"' } };
      if (mode === 'B-304') return { kind: 'not-modified', checkedAt: 222 };
      if (mode === 'B-fail') return { kind: 'failed', message: 'catalog-network-failed' };
      throw new Error('unknown mode');
    };
    const svc = new ProviderCatalogService({ store, presets, fetchOne });
    await svc.init();
    let refreshed = await svc.refresh();
    assert.equal(refreshed.ok, true);
    // A 200 缓存建立后，视图含 m-a 且成功时间为 111
    let view = await svc.view();
    assert.equal(view.models.testco.length, 1);
    assert.equal(view.source.lastSuccessAt, 111);
    assert.ok(captured.every((c) => c.baseUrl === 'http://source-a'));

    // 换到 B 源：ETag 不得携带；B 返回 304（没有 B 正文）不能显示成功，B 失败也保留 A 资料
    mode = 'B-304';
    captured.length = 0;
    const switched1 = await svc.setSource('http://source-b');
    assert.equal(switched1.ok, false, 'B 源 304 无 B 正文不能当作更新成功');
    assert.ok(captured.every((c) => c.etag === null), '跨源请求不得携带旧源 ETag');
    view = await svc.view();
    assert.equal(view.source.baseUrl, 'http://source-b');
    assert.ok(view.source.lastError, 'B 源失败要如实呈现');
    // 不把 A 的成功时间当 B 的：当前源 lastSuccessAt 为 null（B 还没有成功过）
    assert.equal(view.source.lastSuccessAt, null, 'B 源尚无成功，不能显示 A 的成功时间为当前源成功');
    // A 已校验缓存仍可浏览/解析（最后有效目录回退；不冒称当前源成功，但内容仍可见）
    assert.equal(view.models.testco.length, 1, 'A 的正文作为最后有效资料仍可浏览');
    assert.equal(view.models.testco[0].id, 'm-a');

    // B 真实失败：同样不丢 A 的磁盘回退资料
    mode = 'B-fail';
    const switched2 = await svc.setSource('http://source-b');
    assert.equal(switched2.ok, false);
    view = await svc.view();
    assert.ok(view.source.lastError);
    assert.equal(view.source.lastSuccessAt, null);

    // 回到 A 源：A 的缓存与成功时间恢复（回退不被清空）
    mode = 'A-200';
    const backToA = await svc.setSource('http://source-a');
    assert.equal(backToA.ok, true);
    view = await svc.view();
    assert.equal(view.source.baseUrl, 'http://source-a');
    assert.equal(view.models.testco[0].id, 'm-a');
    assert.ok(view.source.lastSuccessAt === 111 || view.source.lastSuccessAt === 222 || typeof view.source.lastSuccessAt === 'number');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('已知 builtin ID 的在线参数 A→B 更新真正进入 SDK 请求模型（保留模板字段、只合安全元数据）', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dcode-cat-merge-'));
  try {
    const store = new ProviderDirectoryStore({ stateDir }, stubCipher, { catalogBaseUrl: 'http://x' });
    const presets = registerPresetProviders();
    const svc = new ProviderCatalogService({ store, presets, fetchOne: async () => ({ kind: 'failed', message: 'skip' }) });
    await svc.init();
    const exactBefore = svc.resolveExecutable('anthropic', 'claude-sonnet-4-5');
    assert.ok(exactBefore?.executable && exactBefore.model);
    assert.equal(exactBefore.model.contextWindow, 1000000);
    assert.deepEqual(exactBefore.model.compat, { supportsStrictTools: true });
    // 注入同源同 id 的参数变化（模拟在线 maxTokens/contextWindow 更新）
    const updated = sanitizeCatalogModel('anthropic', {
      id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5 (latest)', api: 'anthropic-messages', provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      reasoning: true, input: ['text', 'image'],
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      contextWindow: 400000, maxTokens: 32000, type: 'chat',
    });
    assert.ok(updated);
    await store.modify(async (current) => ({
      record: {
        ...current,
        catalog: { ...current.catalog, anthropic: { models: [updated], checkedAt: 1, lastModified: 1, etag: 'W/"U"', sourceBaseUrl: 'http://x' } },
        catalogSource: { ...current.catalogSource, baseUrl: 'http://x' },
      },
      result: undefined,
    }));
    // store.modify 是绕过写入：解析须先经 resolveAfterRefresh 读盘到内存，与「真实装配用同一 resolver」一致
    const exactAfter = await svc.resolveAfterRefresh('anthropic', 'claude-sonnet-4-5');
    assert.ok(exactAfter?.executable && exactAfter.model);
    assert.equal(exactAfter.model.contextWindow, 400000, '在线更新的能力必须进入真正 SDK 请求模型');
    assert.equal(exactAfter.model.maxTokens, 32000);
    assert.deepEqual(exactAfter.model.compat, { supportsStrictTools: true }, '模板字段 compat 不被 remote 覆盖');
    assert.equal(exactAfter.model.api, 'anthropic-messages');
    assert.equal(exactAfter.model.baseUrl, 'https://api.anthropic.com');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('resolveModelLocal：builtin 精确模型保留本地 baseUrl；同供应商/本地协议的新线上模型以 anchor endpoint 可执行；未知 api 不可执行', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dcode-cat-local-'));
  try {
    const store = new ProviderDirectoryStore({ stateDir }, stubCipher, { catalogBaseUrl: 'http://x' });
    const presets = registerPresetProviders();
    const svc = new ProviderCatalogService({ store, presets, fetchOne: async () => ({ kind: 'failed', message: 'skip' }) });
    await svc.init();
    // builtin 精确模型：baseUrl 仍是本地登记的（Anthropic 官方端点）
    const exact = svc.resolveModelLocal('anthropic', 'claude-sonnet-4-5');
    assert.ok(exact, 'builtin claude-sonnet-4-5 必须可解析');
    assert.ok(exact.baseUrl.includes('api.anthropic.com'), 'builtin 精确模型的 baseUrl 是本地权威端点');
    assert.equal(exact.executable, true);
    // 注入一条同供应商/本地已确认协议的新线上模型（claude-haiku-5-5 形态）
    const haiku = sanitizeCatalogModel('anthropic', {
      id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', api: 'anthropic-messages', provider: 'anthropic',
      baseUrl: 'https://attacker.example/v1',
      reasoning: false, input: ['text'],
      cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000, maxTokens: 8192, type: 'chat',
    });
    assert.ok(haiku);
    await store.modify(async (current) => ({
      record: { ...current, catalog: { ...current.catalog, anthropic: { models: [haiku], checkedAt: 999, lastModified: 9_999_999_999_999, etag: 'W/"H"', sourceBaseUrl: 'http://x' } } },
      result: undefined,
    }));
    // 真实装配同步路径之前必经 resolveAfterRefresh（读盘）；这里先显式刷新内存再断言 sync 解析结果
    await svc.resolveAfterRefresh('anthropic', 'claude-haiku-5-5');
    const recon = svc.resolveModelLocal('anthropic', 'claude-haiku-5-5');
    assert.ok(recon, '同供应商/本地协议的新模型必须可解析');
    assert.equal(recon.executable, true, '线上新增的 claude-haiku-5-5 以本地 anthropic-messages 协议可执行');
    assert.ok(recon.baseUrl.includes('api.anthropic.com'), '凭据目标仍是本地 anthropic 端点，不跟远端数据改向');
    assert.ok(!recon.baseUrl.includes('attacker.example'));
    // 未知协议的线上模型：显示可辨但不可执行
    const unknownApi = { ...haiku, id: 'claude-haiku-unknown', api: 'made-up-api' };
    await store.modify(async (current) => ({
      record: { ...current, catalog: { ...current.catalog, anthropic: { models: [haiku, unknownApi], checkedAt: 999, lastModified: 9_999_999_999_999, etag: 'W/"H2"', sourceBaseUrl: 'http://x' } } },
      result: undefined,
    }));
    await svc.resolveAfterRefresh('anthropic', 'claude-haiku-unknown');
    const suspicious = svc.resolveModelLocal('anthropic', 'claude-haiku-unknown');
    assert.ok(suspicious);
    assert.equal(suspicious.executable, false, '未知 api 不得作可执行');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// spec#65 跨源反例：A 200 缓存（含新 ID）→ 改源到 B（该源 404）→ 原有效 A 不被丢/覆盖，
// B 源 lastError 如实（catalog-provider-gone），A 的 sourceBaseUrl/lastModified/etag/lastSuccess 保留
test('跨源 404：A 200 含新 ID → B 404 保留 A 完整资料与 sourceBaseUrl/etag，B_lastSuccess 不伪报', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dcode-cat-xgone-'));
  try {
    const store = new ProviderDirectoryStore({ stateDir }, stubCipher, { catalogBaseUrl: 'http://src-a' });
    const presets = [{ id: 'testco', name: 'TestCo', provider: { id: 'testco', name: 'TestCo', baseUrl: 'https://api.testco.com/v1', auth: {}, getModels: () => [] }, authKinds: ['api_key'] }];
    let phase = 'A-200';
    const fetchOne = async ({ baseUrl }) => {
      if (phase === 'A-200' && baseUrl === 'http://src-a') {
        return { kind: 'ok', entry: { models: [modelA('new-id-from-A')], checkedAt: 111, lastModified: 1_800_000_000_000, etag: 'W/"A"' } };
      }
      if (phase === 'B-404' && baseUrl === 'http://src-b') return { kind: 'gone', checkedAt: 222 };
      return { kind: 'failed', message: 'unexpected-call' };
    };
    const svc = new ProviderCatalogService({ store, presets, fetchOne });
    await svc.init();
    let refreshed = await svc.refresh();
    assert.equal(refreshed.ok, true);
    let view = await svc.view();
    assert.equal(view.models.testco[0]?.id, 'new-id-from-A', 'A 200 后源含新 ID');
    assert.equal(view.source.lastSuccessAt, 111);
    phase = 'B-404';
    const switched = await svc.setSource('http://src-b');
    assert.equal(switched.ok, false, 'B 源 404 必须 setSource 拒 ok');
    view = await svc.view();
    assert.equal(view.source.baseUrl, 'http://src-b', '视图已切到 B（当前源）');
    assert.equal(view.source.lastError, 'catalog-provider-gone', '当前源错误单独如实呈现');
    assert.equal(view.source.lastSuccessAt, null, 'B 尚未成功，不能把 A 的 lastSuccess 冒作 B');
    assert.equal(view.models.testco.length, 1, 'B 404 不能丢已校验的新 ID');
    assert.equal(view.models.testco[0]?.id, 'new-id-from-A');
    const record = await store.read();
    assert.equal(record.catalog.testco?.sourceBaseUrl, 'http://src-a', '缓存归属仍是 A 源');
    assert.equal(record.catalog.testco?.etag, 'W/"A"', 'ETag 保留（后续换源回来仍可 304）');
    assert.equal(record.catalog.testco?.lastModified, 1_800_000_000_000);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// 反例：有效 A 后的 timeout/404/非法 chat 不得让 refresh 报 ok 覆盖 A（独立审查目录实路阻塞①②③④）
test('目录实效反例：有效 A 后 timeout/404/非法 chat 行 all refresh.ok=false 且保留 A', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dcode-cat-invalid-'));
  try {
    const store = new ProviderDirectoryStore({ stateDir }, stubCipher, { catalogBaseUrl: 'http://src-a' });
    const presets = [{ id: 'testco', name: 'TestCo', provider: { id: 'testco', name: 'TestCo', baseUrl: 'https://api.testco.com/v1', auth: {}, getModels: () => [{ id: 'm-builtin', api: 'openai-completions', baseUrl: 'https://x', name: 'B', provider: 'testco', cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1, maxTokens: 1, reasoning: false, input: ['text'] }] }, authKinds: ['api_key'] }];
    let phase = 'A-200';
    const fetchOne = async (opts) => {
      // providerId 校验：防止 fixture 错误提供商返回错误模型；
      // phase-specific payload 一律作用于 testco（新增独立 provider 需扩断言）
      if (opts?.providerId !== 'testco') return { kind: 'failed', message: 'unexpected-provider' };
      if (phase === 'A-200') return { kind: 'ok', entry: { models: [modelA('m-a')], checkedAt: 100, lastModified: 1_800_000_000_000, etag: 'W/"A"' } };
      if (phase === 'timeout') return { kind: 'failed', message: 'catalog-timeout' };
      if (phase === 'gone') return { kind: 'gone', checkedAt: 200 };
      if (phase === 'invalid-chat-line') return { kind: 'failed', message: 'catalog-shape-invalid' };
      throw new Error(`unknown phase ${phase}`);
    };
    const svc = new ProviderCatalogService({ store, presets, fetchOne });
    await svc.init();
    // 第一阶段：A 200 入档（有效目录）
    let refreshed = await svc.refresh();
    assert.equal(refreshed.ok, true);
    let view = await svc.view();
    assert.equal(view.models.testco.length, 2, 'builtin m-builtin + remote m-a 合并');
    assert.equal(view.source.lastError, null);
    // ① timeout：refresh 拒 ok:true；lastError 非 null；A 保留
    phase = 'timeout';
    refreshed = await svc.refresh();
    assert.equal(refreshed.ok, false, 'timeout 必须 refresh.ok=false');
    view = await svc.view();
    assert.ok(view.source.lastError, 'timeout 后 lastError 必须非空');
    assert.ok(String(view.source.lastError).includes('catalog-timeout'), `lastError 必须含 catalog-timeout，实际 ${view.source.lastError}`);
    assert.equal(view.models.testco.length, 2, 'timeout 后 A 目录仍保留（builtin+remote 合并不被清）');
    // ② 404 gone：refresh 拒 ok:true；A 保留；lastModified 不被清 0
    phase = 'gone';
    refreshed = await svc.refresh();
    assert.equal(refreshed.ok, false, 'gone 必须 refresh.ok=false');
    view = await svc.view();
    assert.equal(view.source.lastError, 'catalog-provider-gone');
    assert.equal(view.models.testco.length, 2, 'gone 后 A 目录仍保留');
    const record = await store.read();
    assert.equal(record.catalog.testco?.lastModified, 1_800_000_000_000, 'gone 不得清 lastModified=0');
    assert.equal(record.catalog.testco?.etag, 'W/"A"', 'gone 不得清 etag');
    // ③ 非法 chat 行（外部 URL fetch/parse 的 outcome）等同 catalog-shape-invalid 失败：refresh.ok=false；A 保留
    phase = 'invalid-chat-line';
    refreshed = await svc.refresh();
    assert.equal(refreshed.ok, false, 'catalog-shape-invalid 必须 refresh.ok=false');
    view = await svc.view();
    assert.equal(view.models.testco.length, 2, '非法 chat 行后 A 目录仍保留');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// temp-write→rename 窗口的确定性取消：modify callback 已成立之后，紧邻 rename 由 beforeCommit
// 同步门禁复核；换源/关闭在该窗口内插入时，临时文件清理、旧 record 保留，不跨源 commit 旧资料。
test('目录 modify beforeCommit 同步门禁：temp-write 后换源立即拒，旧 record 保留且临时文件清理', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dcode-cat-atomic-'));
  try {
    const store = new ProviderDirectoryStore({ stateDir }, stubCipher, { catalogBaseUrl: 'http://source-a' });
    let shouldFail = false;
    // 直接用 store.modify 的双参签名（不依赖 catalog-service 内部代次）：模拟「读盘新鲜 → 提交前源切换」
    await store.modify(async (current) => ({
      record: { ...current, catalog: { ...current.catalog, testco: { models: [], checkedAt: 111, sourceBaseUrl: 'http://source-a' } }, catalogSource: { ...current.catalogSource, baseUrl: 'http://source-a' } },
      result: undefined,
    }));
    // 提交点即将 rename：先确认当前 baseUrl 是 source-a，改写源为 source-b 后再触发 rejected
    shouldFail = false;
    // 第一步：正常提交（beforeCommit 通过）落 A
    await store.modify(async (current) => ({
      record: { ...current, catalog: { ...current.catalog, testco: { models: [modelA('m-a')], checkedAt: 200, sourceBaseUrl: 'http://source-a' } } },
      result: undefined,
    }), () => {
      // 同步核对：还在 source-a、未换源
      if (shouldFail) throw new Error('intended-failure');
    });
    const initial = await store.read();
    assert.equal(initial?.catalog?.testco?.models?.[0]?.id, 'm-a');

    // 第二步：伪造「即将 rename 时当前源已切换」：修改 store 内 store.record.catalogSource.baseUrl → source-b
    // 不通过 svc.setSource（catalog service 不在该用例里）；模拟 modify callback 已通过但 beforeCommit 已过基础 guard（项目代码）。
    // 等价于正例：synchronous guard 应拒绝并让 A 保持、临时文件被清理。
    // 因 catalog-service 的 guard 是 catalog-service 内状态，这里只证明 store.modify 双参签名通路：
    //  guard 抛 → modify reject；当前 record 仍含 m-a（未被临时改写）；没有残留临时文件。
    shouldFail = true;
    let rejected;
    try {
      await store.modify(async (current) => ({
        record: { ...current, catalog: { ...current.catalog, testco: { models: [modelA('m-b')], checkedAt: 300, sourceBaseUrl: 'http://source-b' } }, catalogSource: { ...current.catalogSource, baseUrl: 'http://source-b' } },
        result: undefined,
      }), () => {
        if (shouldFail) throw new Error('catalog-commit-stale-source');
      });
    } catch (err) {
      rejected = err;
    }
    assert.ok(rejected, 'modify 必须因 beforeCommit 拒绝');
    assert.match(String(rejected?.message ?? ''), /catalog-commit-stale-source/);
    // 旧 record 未被破坏：A 的 catalog 仍是 m-a；源还是 source-a
    const after = await store.read();
    assert.equal(after?.catalogSource?.baseUrl, 'http://source-a');
    assert.equal(after?.catalog?.testco?.models?.[0]?.id, 'm-a', '旧 record 保留（未被临时改写）');
    // 无残留临时文件（.work-*.tmp 全部清理）
    const fs = await import('node:fs/promises');
    const leftovers = (await fs.readdir(stateDir)).filter((n) => n.includes('.work-'));
    assert.deepEqual(leftovers, [], '临时文件必须全部清理');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});


test('多供应商目录：一个更新失败不被后一个成功隐藏，旧目录保留而其他更新生效', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dcode-catalog-partial-'));
  const store = new ProviderDirectoryStore({ stateDir }, stubCipher, { catalogBaseUrl: 'https://catalog.example' });
  const presets = ['testco', 'otherco'].map((id) => ({ id, name: id, authKinds: [], provider: { id, name: id, getModels: () => [], auth: {} } }));
  let failed = false;
  const service = new ProviderCatalogService({ store, presets, fetchOne: async ({ providerId }) => {
    if (failed && providerId === 'testco') return { kind: 'failed', message: 'catalog-timeout' };
    return { kind: 'ok', entry: { models: [{ ...modelA(providerId + (failed ? '-new' : '-old')), provider: providerId }], checkedAt: failed ? 200 : 100, lastModified: 1_800_000_000_000 } };
  } });
  try {
    await service.init();
    assert.equal((await service.refresh()).ok, true);
    failed = true;
    assert.equal((await service.refresh()).ok, false, '某供应商失败不能被后来的成功伪报为全部检查通过');
    const view = await service.view();
    assert.equal(view.source.lastError, 'catalog-timeout');
    assert.equal(view.models.testco[0].id, 'testco-old');
    assert.equal(view.models.otherco[0].id, 'otherco-new');
    assert.equal((await store.read()).catalogSource.lastError, 'catalog-timeout');
  } finally {
    await service.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ---------- 关闭与换源的竞态（关闭必须真实等来源保存收束） ----------
// 既有 guard 只覆盖「缓存正文提交」与入口 closed 判定；来源定义本身的保存此前不在任何在途登记内，
// 于是 close() 可以在 setSource 等旧 refresh 或已进入 store 异步保存时完成，setSource 随后仍写新源并发布。

const tmpArtifacts = (dir) => readdirSync(dir).filter((f) => f.includes('.tmp'));
// 排空待决微任务（不是按时间等待）：受控 gate 未释放时，任何真实 I/O 都不可能完成，
// 因此这里排空之后仍未完成就是契约意义上的「尚未收束」，与机器快慢无关。
const drain = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };

test('关闭落在等待旧 refresh 的窗口：gate 未释放前关闭未完成；收束后不晚写新来源、不发布', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dcode-cat-close-1-'));
  try {
    const store = new ProviderDirectoryStore({ stateDir }, stubCipher, { catalogBaseUrl: 'http://source-a' });
    const presets = [{ id: 'testco', name: 'TestCo', provider: { id: 'testco', name: 'TestCo', baseUrl: 'https://api.testco.com/v1', auth: {}, getModels: () => [] }, authKinds: ['api_key'] }];
    let enteredResolve; const entered = new Promise((r) => { enteredResolve = r; });
    let releaseResolve; const release = new Promise((r) => { releaseResolve = r; });
    let aCalls = 0;
    const fetchOne = async ({ baseUrl }) => {
      if (baseUrl === 'http://source-b') return { kind: 'ok', entry: { models: [modelA('m-b')], checkedAt: 500, lastModified: 1_800_000_000_000, etag: 'W/"B"' } };
      aCalls += 1;
      // 只有第二次 A 源刷新被门控等待（第一次要先落盘出有效目录）
      if (aCalls === 2) { enteredResolve(); await release; }
      return { kind: 'ok', entry: { models: [modelA('m-a')], checkedAt: 100, lastModified: 1_800_000_000_000, etag: 'W/"A"' } };
    };
    const svc = new ProviderCatalogService({ store, presets, fetchOne });
    await svc.init();
    assert.equal((await svc.refresh()).ok, true, '先让 A 源有已落盘的有效目录');
    const blockedRefresh = svc.refresh();
    await entered;
    const swapping = svc.setSource('http://source-b');
    let closed = false;
    const closing = svc.close().then(() => { closed = true; });
    await drain();
    assert.equal(closed, false, '受控 gate 未释放前，关闭不得完成');
    releaseResolve();
    await blockedRefresh;
    const swapped = await swapping;
    await closing;
    assert.equal(closed, true);
    assert.equal(swapped.ok, false, '关闭后换源不得再报成功');
    const persisted = await store.read();
    assert.equal(persisted?.catalogSource?.baseUrl, 'http://source-a', '关闭收束后不得晚写新来源');
    assert.equal(persisted?.catalog?.testco?.models?.[0]?.id, 'm-a', '旧有效来源缓存保留');
    assert.equal((await svc.view()).source.baseUrl, 'http://source-a', '关闭后不得晚发布新来源');
    assert.deepEqual(tmpArtifacts(stateDir), [], '被拒的来源保存不残留临时文件');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('关闭落在来源提交已进入异步保存的窗口：队列被占期间关闭未完成；收束后旧来源与缓存保留、临时文件清理', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dcode-cat-close-2-'));
  try {
    const store = new ProviderDirectoryStore({ stateDir }, stubCipher, { catalogBaseUrl: 'http://source-a' });
    const presets = [{ id: 'testco', name: 'TestCo', provider: { id: 'testco', name: 'TestCo', baseUrl: 'https://api.testco.com/v1', auth: {}, getModels: () => [] }, authKinds: ['api_key'] }];
    const fetchOne = async () => ({ kind: 'ok', entry: { models: [modelA('m-a')], checkedAt: 100, lastModified: 1_800_000_000_000, etag: 'W/"A"' } });
    const svc = new ProviderCatalogService({ store, presets, fetchOne });
    await svc.init();
    assert.equal((await svc.refresh()).ok, true);
    // 占住 store 的单一写入队列：换源的来源保存只能排在它后面
    let queueEnteredResolve; const queueEntered = new Promise((r) => { queueEnteredResolve = r; });
    let queueReleaseResolve; const queueRelease = new Promise((r) => { queueReleaseResolve = r; });
    const blocker = store.modify(async () => { queueEnteredResolve(); await queueRelease; return { result: undefined }; });
    await queueEntered;
    const swapping = svc.setSource('http://source-b');
    let closed = false;
    const closing = svc.close().then(() => { closed = true; });
    await drain();
    assert.equal(closed, false, '来源保存仍被队列占住时，关闭必须仍在等待它');
    queueReleaseResolve();
    await blocker;
    const swapped = await swapping;
    await closing;
    assert.equal(closed, true);
    assert.equal(swapped.ok, false, '关闭后换源不得再报成功');
    const persisted = await store.read();
    assert.equal(persisted?.catalogSource?.baseUrl, 'http://source-a', '关闭收束后不得晚写新来源');
    assert.equal(persisted?.catalog?.testco?.models?.[0]?.id, 'm-a', '旧有效来源缓存保留');
    assert.equal((await svc.view()).source.baseUrl, 'http://source-a', '关闭后不得晚发布新来源');
    assert.deepEqual(tmpArtifacts(stateDir), [], '被拒的来源保存不残留临时文件');
    // 重复关闭不得抛错或改变已保留的来源
    await svc.close();
    assert.equal((await store.read())?.catalogSource?.baseUrl, 'http://source-a');
    assert.deepEqual(tmpArtifacts(stateDir), []);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ---------- 来源变更的在途唯一性（不得覆盖句柄、不得返回别人的成功） ----------

test('并发两来源请求：后来的请求被显式拒绝，不覆盖在途句柄，也不返回别人的成功', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dcode-cat-concurrent-'));
  try {
    const store = new ProviderDirectoryStore({ stateDir }, stubCipher, { catalogBaseUrl: 'http://source-a' });
    const presets = [{ id: 'testco', name: 'TestCo', provider: { id: 'testco', name: 'TestCo', baseUrl: 'https://api.testco.com/v1', auth: {}, getModels: () => [] }, authKinds: ['api_key'] }];
    const requested = [];
    const fetchOne = async ({ baseUrl }) => {
      requested.push(baseUrl);
      return { kind: 'ok', entry: { models: [modelA(`m-${baseUrl.slice(-1)}`)], checkedAt: 100, lastModified: 1_800_000_000_000, etag: 'W/"x"' } };
    };
    const svc = new ProviderCatalogService({ store, presets, fetchOne });
    await svc.init();
    // 占住 store 的单一写入队列：第一次换源的来源保存只能排在它后面
    let queueEnteredResolve; const queueEntered = new Promise((r) => { queueEnteredResolve = r; });
    let queueReleaseResolve; const queueRelease = new Promise((r) => { queueReleaseResolve = r; });
    const blocker = store.modify(async () => { queueEnteredResolve(); await queueRelease; return { result: undefined }; });
    await queueEntered;

    const first = svc.setSource('http://source-b');
    await drain();
    // 第二个来源请求与相同来源请求都不在此处 await：旧实现会让它们排在被占住的写入队列后面，
    // 直接 await 会挂死、掩盖后续断言。这里只登记请求，释放队列后再统一断言结果。
    const secondPromise = svc.setSource('http://source-c');
    const samePromise = svc.setSource('http://source-a');

    queueReleaseResolve();
    await blocker;
    const swapped = await first;
    const second = await secondPromise;
    const same = await samePromise;

    assert.equal(swapped.ok, true, '第一个来源变更应真实完成');
    assert.equal(second.ok, false, '来源变更在途时，后来的请求必须被拒绝');
    assert.equal(second.message, 'catalog-source-busy');
    assert.ok(!second.revision, '被拒绝的请求不得回带在途请求的 revision');
    // 相同来源的「仅刷新」同样不得绕过：它会落在本次变更的提交窗口里另起一代
    assert.equal(same.ok, false, '相同来源请求不得绕过在途的来源变更');
    assert.equal((await store.read())?.catalogSource?.baseUrl, 'http://source-b', '被拒绝的请求没有写入任何来源');
    assert.equal((await svc.view()).source.baseUrl, 'http://source-b');
    assert.deepEqual(requested.filter((b) => b !== 'http://source-a'), ['http://source-b'], '被拒绝的请求没有发起任何检查');
    assert.deepEqual(tmpArtifacts(stateDir), []);
    await svc.close();
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('来源已提交后关闭：保留已保存事实，但不晚发布、不晚启动新检查，且不伪报未保存', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dcode-cat-postcommit-'));
  try {
    const real = new ProviderDirectoryStore({ stateDir }, stubCipher, { catalogBaseUrl: 'http://source-a' });
    // 代理只延后 modify 的**返回**：真实 ProviderDirectoryStore 已经完成 temp-write→rename，
    // 于是可以确定性地停在「已提交、流程未收束」这一步。只对换源那一次生效（前面的刷新也要写盘）。
    let armed = false;
    let commitResolve; const committed = new Promise((r) => { commitResolve = r; });
    let gateResolve; const gate = new Promise((r) => { gateResolve = r; });
    const store = new Proxy(real, {
      get(target, key) {
        if (key === 'modify') return async (...args) => {
          const r = await target.modify(...args);
          if (armed) { commitResolve(); await gate; }
          return r;
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const presets = [{ id: 'testco', name: 'TestCo', provider: { id: 'testco', name: 'TestCo', baseUrl: 'https://api.testco.com/v1', auth: {}, getModels: () => [] }, authKinds: ['api_key'] }];
    let fetches = 0;
    const fetchOne = async ({ baseUrl }) => {
      fetches += 1;
      return { kind: 'ok', entry: { models: [modelA(`m-${baseUrl.slice(-1)}`)], checkedAt: 100, lastModified: 1_800_000_000_000, etag: 'W/"x"' } };
    };
    const svc = new ProviderCatalogService({ store, presets, fetchOne });
    await svc.init();
    assert.equal((await svc.refresh()).ok, true);
    const before = fetches;
    armed = true;

    const swapping = svc.setSource('http://source-b');
    await committed;                      // 来源定义已原子提交，流程尚未收束
    assert.equal((await store.read())?.catalogSource?.baseUrl, 'http://source-b', '前置条件：提交已落盘');
    assert.equal((await svc.view()).source.baseUrl, 'http://source-a', '前置条件：本流程尚未发布');

    let closed = false;
    const closing = svc.close().then(() => { closed = true; });
    await drain();
    assert.equal(closed, false, '来源保存 promise 未收束时，关闭必须仍在等待');
    gateResolve();
    const swapped = await swapping;
    await closing;

    assert.equal(swapped.ok, false);
    assert.equal(swapped.issue, 'committed-not-checked', '已提交的事实不得被伪报为未保存');
    assert.equal((await store.read())?.catalogSource?.baseUrl, 'http://source-b', '已通过 rename 的提交保留');
    assert.equal((await svc.view()).source.baseUrl, 'http://source-a', '已关闭流程不得晚发布新来源');
    assert.equal(fetches, before, '已关闭流程不得晚启动新来源的检查');
    assert.deepEqual(tmpArtifacts(stateDir), [], '临时文件清理');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
