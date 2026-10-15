// ProviderDirectoryStore：凭据按 providerId 精确隔离、格式 2 元数据不解密即可枚举、
// temp-write→rename 双授权点（取消在两点之间也丢写并清理临时文件）、delete 同门禁、
// 旧 model-setup.json 格式 1 的备份无损迁移、并发首次 read 不多份原子覆盖。
// 使用 stub cipher（明文 base64）；不是正式 safeStorage，验证的是读写与门禁时序。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderDirectoryStore } from '../../src/adapters/pi/provider-directory-store.ts';
import { AuthFlowRegistry } from '../../src/adapters/pi/auth-flow-guard.ts';

const stubCipher = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from(s, 'utf8'),
  decrypt: (buf) => Buffer.from(buf).toString('utf8'),
};

const makeStore = (stateDir) => new ProviderDirectoryStore({ stateDir }, stubCipher, { catalogBaseUrl: 'https://fixture.invalid' });

const readRaw = (stateDir) => JSON.parse(readFileSync(join(stateDir, 'provider-directory.json'), 'utf8'));

test('凭据严格按 providerId 隔离：read/openai 取不到 user-defined 的密钥', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dcode-dir-'));
  try {
    const store = makeStore(stateDir);
    await store.commitCredential('user-defined', { type: 'api_key', key: 'sk-custom' });
    await store.commitCredential('openai', { type: 'api_key', key: 'sk-openai' });
    const sdk = store.asPiCredentialStore();
    const userDefined = await sdk.read('user-defined');
    const openai = await sdk.read('openai');
    assert.equal(userDefined.key, 'sk-custom');
    assert.equal(openai.key, 'sk-openai');
    // asPiCredentialStore.read(other) 不返回另一供应商的内容
    const unknown = await sdk.read('zai');
    assert.equal(unknown, undefined);
    // 目录枚举不解密仍可拿到 kind 元数据（C 收口）
    const listed = await sdk.list();
    const kinds = new Map(listed.map((e) => [e.providerId, e.type]));
    assert.equal(kinds.get('user-defined'), 'api_key');
    assert.equal(kinds.get('openai'), 'api_key');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('双授权点：两点之间被吊销的写入在 rename 前清理临时文件并抛错，旧凭据保留', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dcode-dir-gate-'));
  try {
    const store = makeStore(stateDir);
    // 先落地一个旧凭据（同 id 旧记录不能被新盲覆盖）
    await store.commitCredential('openai', { type: 'api_key', key: 'sk-old' });
    const registry = new AuthFlowRegistry();
    const guard = registry.begin('openai');
    let callCount = 0;
    // 自定义 AuthorizeWrite：beforePrepare 过；beforeCommit 前吊销（模拟取消发生在两点之间）。
    // 关键反例：第二 hook 先核实「临时文件已实际写出、target 仍是被保护的旧记录」，
    // 再吊销——证明拒绝确实发生在异步准备完成之后，不是被提前到 temp-write 之前。
    const hooks = {
      beforePrepare: () => {},
      beforeCommit: (id) => {
        callCount++;
        const files = readdirSync(stateDir);
        const tmp = files.find((f) => f.includes('.work-'));
        assert.ok(tmp, '第二授权点执行时临时文件必须已实际写出（证明 beforeCommit 在 temp-write 之后）');
        const targetContent = JSON.parse(readFileSync(join(stateDir, 'provider-directory.json'), 'utf8'));
        const savedPlain = JSON.parse(stubCipher.decrypt(Buffer.from(targetContent.credentials.openai.blob, 'base64')));
        assert.equal(savedPlain.key, 'sk-old', '旧 target 在第二授权点前未被替换');
        guard.revoke(); // 两点之间吊销
        guard.beforeCommit(id);
      },
    };
    const sdk = store.asPiCredentialStore(hooks);
    await assert.rejects(
      sdk.modify('openai', async () => ({ type: 'api_key', key: 'sk-new' })),
      /auth-flow-superseded/,
    );
    assert.equal(callCount, 1, '第二授权点确实被调用');
    // 旧凭据必须保留
    const saved = readRaw(stateDir);
    const entry = saved.credentials.openai;
    assert.ok(entry?.blob);
    const plain = JSON.parse(stubCipher.decrypt(Buffer.from(entry.blob, 'base64')));
    assert.equal(plain.key, 'sk-old', '旧凭据未被两点间取消覆盖');
    // 临时文件已清理（无 .work- 临时文件残留）
    const leftovers = readdirSync(stateDir).filter((f) => f.includes('.work-'));
    assert.deepEqual(leftovers, [], '临时文件必须被清理');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('list 不解密：poison cipher 的 decrypt 被调用即失败（不只看枚举结果）', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dcode-dir-poison-'));
  try {
    let decryptCalls = 0;
    const poisonCipher = {
      isAvailable: () => true,
      encrypt: (s) => Buffer.from(s, 'utf8'),
      decrypt: (buf) => { decryptCalls++; void buf; throw new Error('decrypt-must-not-be-called-in-list'); },
    };
    const store = new ProviderDirectoryStore({ stateDir }, poisonCipher, { catalogBaseUrl: 'https://fixture.invalid' });
    // commit 需要 encrypt（不经 decrypt）；先落两条
    await store.commitCredential('openai', { type: 'api_key', key: 'k1' });
    await store.commitCredential('anthropic', { type: 'oauth', refresh: 'r', access: 'a', expires: 1 });
    const listed = await store.asPiCredentialStore().list();
    assert.equal(decryptCalls, 0, 'list 不允许解密');
    const kinds = new Map(listed.map((e) => [e.providerId, e.type]));
    assert.equal(kinds.get('openai'), 'api_key');
    assert.equal(kinds.get('anthropic'), 'oauth');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('空目录首次直接 modify / credential commit 不死锁（不依赖 assembly 恰好先 read）', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dcode-dir-cold-'));
  try {
    const store = makeStore(stateDir);
    // 第一次调用就是 modify（未先 read）：必须完成，不等待自己的初始化
    const sdk = store.asPiCredentialStore();
    const saved = await sdk.modify('openai', async () => ({ type: 'api_key', key: 'sk-cold' }));
    assert.equal(saved?.key, 'sk-cold');
    // 首次 commitCredential 也必须直接成功
    await store.commitCredential('zai', { type: 'api_key', key: 'sk-cold-zai' });
    const back = await store.read();
    assert.ok(back);
    assert.ok(back.credentials.openai);
    assert.ok(back.credentials.zai);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('delete 同门禁：吊销 flow 的删除被拒，凭据仍在', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dcode-dir-del-'));
  try {
    const store = makeStore(stateDir);
    await store.commitCredential('openai', { type: 'api_key', key: 'sk-still' });
    const registry = new AuthFlowRegistry();
    const guard = registry.begin('openai');
    guard.revoke(); // 在调用前即吊销
    const sdk = store.asPiCredentialStore({
      beforePrepare: (id) => guard.beforePrepare(id),
      beforeCommit: (id) => guard.beforeCommit(id),
    });
    await assert.rejects(sdk.delete('openai'), /auth-flow-superseded/);
    const still = await store.asPiCredentialStore().read('openai');
    assert.equal(still?.key, 'sk-still');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('真正提交完成后，晚到取消/关闭不能把已保存凭据抹掉', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dcode-dir-committed-'));
  try {
    const store = makeStore(stateDir);
    const registry = new AuthFlowRegistry();
    const guard = registry.begin('openai');
    const sdk = store.asPiCredentialStore({
      beforePrepare: (id) => guard.beforePrepare(id),
      beforeCommit: (id) => guard.beforeCommit(id),
    });
    const saved = await sdk.modify('openai', async () => ({ type: 'api_key', key: 'sk-confirmed' }));
    assert.equal(saved?.key, 'sk-confirmed');
    guard.revoke(); // commit 完成后的取消
    registry.close();
    const after = await store.asPiCredentialStore().read('openai');
    assert.equal(after?.key, 'sk-confirmed', '已提交凭据不被晚到取消抹掉');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('旧 model-setup.json 格式 1 承接：备份保留、凭据归 user-defined、目录迁移完成', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dcode-dir-migrate-'));
  try {
    const legacyPath = join(stateDir, 'model-setup.json');
    const legacy = {
      format: 1,
      provider: 'openai-completions',
      label: '旧自定义',
      modelId: 'test-model',
      baseUrl: 'http://127.0.0.1:9999/v1',
      note: 'ready',
      credential: Buffer.from(JSON.stringify({ type: 'api_key', key: 'sk-legacy' }), 'utf8').toString('base64'),
    };
    writeFileSync(legacyPath, JSON.stringify(legacy));
    const store = makeStore(stateDir);
    const record = await store.read();
    assert.ok(record);
    assert.equal(record.format, 2);
    assert.equal(record.current?.kind, 'custom');
    assert.equal(record.current?.label, '旧自定义');
    // 凭据按 user-defined 归位（不按 OS 协议迁成 OpenAI 账户）
    const entry = record.credentials['user-defined'];
    assert.ok(entry?.blob);
    const back = JSON.parse(stubCipher.decrypt(Buffer.from(entry.blob, 'base64')));
    assert.equal(back.key, 'sk-legacy');
    // 旧文件仍在；备份文件同时存在（不删除、不静默覆盖）
    assert.ok(existsSync(legacyPath));
    const backups = readdirSync(stateDir).filter((f) => f.startsWith('model-setup.backup-'));
    assert.ok(backups.length >= 1, '迁移必须留下备份依据');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('并发首个 read 不多份原子覆盖（迁移只发生一次）', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dcode-dir-migrate-conc-'));
  try {
    const legacyPath = join(stateDir, 'model-setup.json');
    const legacy = {
      format: 1,
      provider: 'openai-completions',
      label: 'X',
      modelId: 'm',
      baseUrl: 'http://127.0.0.1:1/v1',
      note: 'ready',
    };
    writeFileSync(legacyPath, JSON.stringify(legacy));
    const store = makeStore(stateDir);
    const [a, b, c] = await Promise.all([store.read(), store.read(), store.read()]);
    assert.deepEqual(a?.current?.label, 'X');
    assert.deepEqual(b?.current?.label, 'X');
    assert.deepEqual(c?.current?.label, 'X');
    const backups = readdirSync(stateDir).filter((f) => f.startsWith('model-setup.backup-'));
    // 迁移应只发生一次：备份唯一（若非唯一则说明并发迁移，两份都含同一内容，仍有覆盖隐患）
    assert.equal(backups.length, 1, '并发首次读取只应迁移一次');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// temp-write→rename 窗口的确定性时序已由「第二授权点」用例覆盖（beforeCommit 在两点之间吊销即时拒绝并清理临时文件）；
// 这里不依赖 sleep 或运气的另一睡定时方案。
