import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderDirectoryStore } from '../../src/adapters/pi/provider-directory-store.ts';

// 存根 cipher：明文 base64（不是真实 safeStorage，只覆盖记录读写通路）
const stubCipher = {
  isAvailable: () => true,
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (buf: Buffer) => Buffer.from(buf).toString('utf8'),
};

const DIRECTORY_FILE = 'provider-directory.json';

/** 造一份带 N 家供应商的目录记录：catalog 体积接近真实目录（每家 50 个模型）。 */
function directoryFixture(count: number) {
  const credentials: Record<string, { kind: 'api_key'; blob: string }> = {};
  const catalog: Record<string, unknown> = {};
  for (let index = 0; index < count; index++) {
    const id = `provider-${index}`;
    credentials[id] = {
      kind: 'api_key',
      blob: Buffer.from(JSON.stringify({ type: 'api_key', key: `key-${index}` }), 'utf8').toString('base64'),
    };
    catalog[id] = {
      checkedAt: 1,
      models: Array.from({ length: 50 }, (_, n) => ({
        id: `model-${n}`, name: `model-${n}`, api: 'anthropic-messages', provider: id,
        baseUrl: 'https://fixture.invalid', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 204800, maxTokens: 131072, type: 'chat',
      })),
    };
  }
  return {
    format: 2 as const,
    credentials,
    current: null,
    catalog,
    catalogSource: { baseUrl: 'https://fixture.invalid', lastSuccessAt: 1, lastError: null },
  };
}

await test('逐供应商高频读取凭据：同一份记录只解析一次', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'dcode-dir-cache-'));
  try {
    const store = new ProviderDirectoryStore({ stateDir }, stubCipher, { catalogBaseUrl: 'https://fixture.invalid' });
    const record = directoryFixture(40);
    await store.write(record as never);

    const first = await store.read();
    assert.ok(first);
    // SDK 的 checkAuth / getAuthenticatedProviders 会逐个供应商读凭据；高频读取不得各解析一份。
    for (const [index, id] of Object.keys(record.credentials).entries()) {
      const credential = await store.readCredential(id);
      assert.equal((credential as { key: string }).key, `key-${index}`);
    }
    const after = await store.read();
    assert.equal(after, first, '高频凭据读取不应产生新的记录解析副本');

    // 连续两轮同样成立：缓存跨调用保持同一份记录。
    for (const id of Object.keys(record.credentials)) await store.readCredential(id);
    assert.equal(await store.read(), first);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

await test('记录文件被别处改动后读到新值：缓存按文件事实校验，不返回陈旧记录', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'dcode-dir-cache-ext-'));
  try {
    const store = new ProviderDirectoryStore({ stateDir }, stubCipher, { catalogBaseUrl: 'https://fixture.invalid' });
    await store.write(directoryFixture(3) as never);
    const first = await store.read();
    assert.ok(first);

    // 模拟别处写入：内容与体积都变了（体积变化保证任何时间戳粒度下都能判出不同）。
    const changed = { ...directoryFixture(3), current: { kind: 'preset', providerId: 'provider-0', modelId: 'model-0', note: 'ready' } } as never;
    await writeFile(join(stateDir, DIRECTORY_FILE), JSON.stringify(changed, null, 2), { encoding: 'utf8' });

    const second = await store.read();
    assert.notEqual(second, first, '文件已改时不得继续返回缓存的那一份');
    assert.equal(second?.current?.modelId, 'model-0');
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

await test('写入后缓存失效：下一次读取拿到刚提交的那一份', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'dcode-dir-cache-write-'));
  try {
    const store = new ProviderDirectoryStore({ stateDir }, stubCipher, { catalogBaseUrl: 'https://fixture.invalid' });
    await store.write(directoryFixture(2) as never);
    const before = await store.read();
    assert.ok(before);

    await store.commitCustomSetup({
      provider: 'openai-completions', label: '本地服务', modelId: 'm-1', baseUrl: 'http://127.0.0.1:9/v1',
      note: 'ready', keyAction: 'replace', apiKey: 'sk-after-write',
    });

    const after = await store.read();
    assert.notEqual(after, before, '写盘后不得继续返回旧记录');
    assert.equal(after?.current?.kind, 'custom');
    const credential = await store.readCredential('user-defined');
    assert.equal((credential as { key: string }).key, 'sk-after-write');
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});
