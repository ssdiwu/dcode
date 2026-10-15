// C 项反例：认证门与额度失效必须绑定**本次请求实际用的身份**，不能用设置里的当前选择去猜。
//
// 1) 默认来源 A、会话实际跑 B：A 的登录在途不拦 B 的发送；B 的登录在途则拦住 B 的发送与继续；
//    换 B 的凭据要按"正在被使用"核相位，不能因为设置默认是 A 就跳过。
// 2) 额度观测按「来源+模型+账户身份」隔离：换身份后读不到上一个账户的剩余。
// 3) 凭据提交（换 key／清除／登录完成）即让该来源的旧观测失效。
// 4) 观测端与读取端算的是同一个身份指纹（同一份凭据+端点 → 同一个 key；换 key 或换端点 → 不同）。
//
// 额度与凭据用真实实现（PiQuotaPort / ProviderDirectoryStore / recordQuotaObservation），
// 只把 cipher 换成进程内的可逆替身：不发网络、不碰真实账户或凭据。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DCodeApplication } from '../../src/application/index.ts';
import { sampleState } from '../../src/adapters/mock/index.ts';
import {
  ProviderDirectoryStore,
  credentialAccountKey,
  recordQuotaObservation,
} from '../../src/adapters/pi/index.ts';
import { PiQuotaPort } from '../../src/adapters/pi/quota-port.ts';
import type { QuotaFacts, VerifiedModelCapabilities, WorkCapability } from '../../src/contracts/index.ts';
import { WORK_CAPABILITIES } from '../../src/contracts/index.ts';
import type { ExecutionPort, PersistedState, StorageAdapter } from '../../src/application/types.ts';
import type { ProviderDirectoryPort } from '../../src/application/app.ts';

// 用真实的预设来源 id（额度端口只对已核实的响应头来源给事实，夹具不自造来源名）
const SOURCE_A = 'openai';
const SOURCE_B = 'anthropic';
const MODEL_A = 'model-a';
const MODEL_B = 'model-b';

/** 可逆的进程内 cipher 替身：只让加密/解密往返成立，不做任何真实加密。 */
const loopbackCipher = {
  isAvailable: () => true,
  encrypt: (plaintext: string) => Buffer.from(plaintext, 'utf8'),
  decrypt: (encrypted: Buffer) => encrypted.toString('utf8'),
};

function supportsOf(): VerifiedModelCapabilities['supports'] {
  const out = {} as VerifiedModelCapabilities['supports'] & Record<WorkCapability, unknown>;
  for (const cap of WORK_CAPABILITIES) {
    out[cap] = { supported: true, evidence: 'catalog', reason: null };
  }
  return out;
}

function makePort(): { port: ExecutionPort; submits: () => number; phase: () => string; setPhase: (p: 'ready' | 'paused' | 'running') => void } {
  const control = { instanceId: 'identity-fixture', revision: 0 };
  const state = { submits: 0, observation: 0, phase: 'ready' as 'ready' | 'paused' | 'running' };
  const port = {
    target: { workspaceId: 'ws-home', taskId: 't', sessionId: 's' },
    async read() {
      state.observation += 1;
      return {
        target: this.target, control, observation: state.observation, phase: state.phase,
        execution: 'mock' as const, model: null, entries: [], pendingInputs: 0,
      };
    },
    async submit() {
      state.submits += 1;
      return { status: 'accepted' as const, operationId: 'op', submissionId: state.submits, processing: 'queued' as const };
    },
    async lookupReceipt() {
      return { status: 'not-accepted' as const, operationId: 'op', reason: 'not-found' as const };
    },
    async pause() { state.phase = 'paused'; return this.read(); },
    async resume() { state.phase = 'ready'; return this.read(); },
    async close() {},
    async applySessionModel() { /* 接受应用 */ },
  } as ExecutionPort;
  return { port, submits: () => state.submits, phase: () => state.phase, setPhase: (p) => { state.phase = p; } };
}

/**
 * 夹具：设置默认来源为 A，来源目录同时列 A 与 B，会话可显式选 B。
 * 认证门控与额度端口都走真实实现，来源/能力是内存来源目录（不发网络）。
 */
async function harness() {
  const { port, submits, setPhase } = makePort();
  let stored: PersistedState = sampleState();
  const storage: StorageAdapter = {
    load: async () => ({ status: 'missing' as const }),
    save: async (next: PersistedState) => { stored = next; },
  };
  const directoryPort: ProviderDirectoryPort = {
    read: async () => ({
      format: 2 as const,
      // 设置里的当前选择：默认来源 A（这正是"不能用它猜在途来源"的那一份）
      current: { kind: 'preset' as const, providerId: SOURCE_A, modelId: MODEL_A, note: 'ready' as const },
      credentials: { [SOURCE_A]: { kind: 'api_key' as const, blob: 'x' }, [SOURCE_B]: { kind: 'api_key' as const, blob: 'y' } },
      catalog: {},
      catalogSource: { baseUrl: 'https://example.invalid', lastSuccessAt: null, lastError: null },
    }),
    commitCustomSetup: async () => { throw new Error('not-used'); },
    commitPresetSelection: async () => { throw new Error('not-used'); },
  };
  const app = new DCodeApplication(
    { kind: 'pi', modelName: 'controlled', async open() { return port; } },
    storage,
    () => stored,
    undefined,
    directoryPort,
    undefined,
    undefined,
    undefined,
    {
      sourcePort: {
        list: async () => [
          { sourceId: SOURCE_A, sourceLabel: '来源 A', configured: true, models: [{ modelId: MODEL_A, modelLabel: MODEL_A }] },
          { sourceId: SOURCE_B, sourceLabel: '来源 B', configured: true, models: [{ modelId: MODEL_B, modelLabel: MODEL_B }] },
        ],
      },
      capabilityPort: {
        read: async ({ sourceId, modelId }: { sourceId: string; modelId: string }) => ({
          identity: { sourceId, modelId, sourceLabel: sourceId, modelLabel: modelId, accountLabel: null },
          supports: supportsOf(),
          contextWindow: 32768,
          maxTokens: 1024,
          input: ['text'],
          thinkingLevels: [],
          thinkingNote: null,
        }),
      },
      quotaPort: {
        support: () => ({}),
        read: async ({ candidates }: { candidates: readonly { sourceId: string; modelId: string }[] }): Promise<QuotaFacts[]> =>
          candidates.map((c) => ({
            sourceId: c.sourceId,
            modelId: c.modelId,
            state: 'available' as const,
            poolId: 'pool-1',
            windowLabel: '每分钟请求',
            updatedAt: 1,
            reason: null,
          })),
      },
    },
  );
  await app.init();
  await app.updateSettings({ modelCandidates: [
    { sourceId: SOURCE_A, modelId: MODEL_A },
    { sourceId: SOURCE_B, modelId: MODEL_B },
  ] });
  const sessionId = (await app.getSnapshot()).sessions[0]!.id;
  return { app, sessionId, submits, setPhase, port };
}

await test('认证门按会话实际来源：默认 A 的登录不拦发往 B 的请求，B 的登录才拦', async (t) => {
  const { app, sessionId, submits } = await harness();
  t.after(async () => { await app.flush(); });
  await app.setSessionModelChoice({ sessionId, choice: { mode: 'explicit', sourceId: SOURCE_B, modelId: MODEL_B } });
  await app.sendMessage({ sessionId, text: '第一条', mode: 'follow-up' });
  const baseline = submits();

  // 来源 A 的登录在途：这条请求实际发往 B，不该被 A 的在途拦住
  const authA = await app.beginProviderAuth(SOURCE_A);
  assert.equal(authA.ok, true, '来源 A 的认证应放行');
  const blockedByA = await app.sendMessage({ sessionId, text: 'A 在途时发往 B', mode: 'follow-up' });
  assert.equal(submits(), baseline + 1, 'A 的登录在途不应拦下发往 B 的请求');
  assert.equal(blockedByA.receipt.status, 'accepted');
  if (authA.ok) authA.release();

  // 来源 B 的登录在途：默认选择是 A，但这次请求实际发往 B，必须拦住
  const authB = await app.beginProviderAuth(SOURCE_B);
  assert.equal(authB.ok, true, '来源 B 的认证应放行');
  const blockedByB = await app.sendMessage({ sessionId, text: 'B 在途时发往 B', mode: 'follow-up' });
  assert.equal(blockedByB.receipt.status, 'not-accepted', 'B 的登录在途必须拦住发往 B 的请求');
  assert.equal(submits(), baseline + 1, '被拦的请求不得真的提交到端口');
  // 明确继续同样按实际来源核
  await assert.rejects(
    () => app.resumeRun({ sessionId }),
    /auth-flow-in-flight/,
    'B 的登录在途时继续也必须被拒',
  );
  if (authB.ok) authB.release();
});

await test('换实际在用来源的凭据要核运行相位（默认不是它也不能跳过）', async (t) => {
  const { app, sessionId, setPhase } = await harness();
  t.after(async () => { await app.flush(); });
  await app.setSessionModelChoice({ sessionId, choice: { mode: 'explicit', sourceId: SOURCE_B, modelId: MODEL_B } });
  // 先真正打开一次端口：相位核对读的是已开启的会话端口，没有端口就没有可核的相位
  await app.sendMessage({ sessionId, text: '先跑一次', mode: 'follow-up' });
  setPhase('running');
  // 设置默认仍是 A，但 B 正被这个会话实际使用：换 B 的凭据必须在运行中被拒
  const refused = await app.beginProviderAuth(SOURCE_B);
  assert.equal(refused.ok, false, '正在被实际使用的来源在运行中不得开始认证');
  assert.equal(refused.ok === false ? refused.reason : null, 'running');
});

await test('额度观测按账户身份隔离：换身份后读不到上一个账户的剩余', async () => {
  const baseUrl = 'https://a.invalid/v1';
  const keyOne = credentialAccountKey('key-one', baseUrl);
  const keyTwo = credentialAccountKey('key-two', baseUrl);
  const port = new PiQuotaPort({ resolveAccountKey: async () => keyOne });
  const headers = {
    'x-ratelimit-limit-requests': '1000',
    'x-ratelimit-remaining-requests': '3',
    'x-ratelimit-reset-requests': '1h',
  };
  // 真实观测通路：凭据 key-one 的一次真实响应（观测端用本次请求真正用的 key 算身份）
  const observed = port.observe(recordQuotaObservation(
    { provider: SOURCE_A, id: MODEL_A, baseUrl },
    { status: 200, headers },
    'key-one',
  ));
  assert.equal(observed?.state, 'available');

  // 同一来源+模型、身份不同：不得读出另一个账户的剩余
  const facts = await port.read({ candidates: [{ sourceId: SOURCE_A, modelId: MODEL_A, accountKey: keyTwo }] });
  assert.equal(facts[0]!.state, 'unknown', '换身份后不得采信上一个账户的额度');
  assert.equal(facts[0]!.reason !== null, true, '读不到时要说明原因');

  // 同一身份才读得到那一次真实响应回报的数字
  const same = await port.read({ candidates: [{ sourceId: SOURCE_A, modelId: MODEL_A, accountKey: keyOne }] });
  assert.equal(same[0]!.state, 'available');

  // 读取端不显式给身份时按当前绑定身份补，结果必须与显式给同一身份一致
  const resolved = await port.read({ candidates: [{ sourceId: SOURCE_A, modelId: MODEL_A }] });
  assert.equal(resolved[0]!.state, 'available');

  // 取不到身份的一侧不得采信带身份的观测：那可能属于另一个账户（宁可 unknown，不给别的账户的数字）
  const unidentified = new PiQuotaPort();
  unidentified.observe(recordQuotaObservation({ provider: SOURCE_A, id: MODEL_A, baseUrl }, { status: 200, headers }, 'key-one'));
  const blind = await unidentified.read({ candidates: [{ sourceId: SOURCE_A, modelId: MODEL_A }] });
  assert.equal(blind[0]!.state, 'unknown', '无身份读取不得取用带身份的观测');
});

await test('凭据提交即让该来源的旧观测失效（换 key / 清除 / 登录完成）', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'dcode-identity-'));
  const committed: string[] = [];
  const port = new PiQuotaPort();
  const store = new ProviderDirectoryStore(
    { stateDir },
    loopbackCipher,
    { catalogBaseUrl: 'https://example.invalid' },
    { onCredentialCommitted: (providerId) => { committed.push(providerId); port.invalidateSource(providerId); } },
  );
  const headers = {
    'x-ratelimit-limit-requests': '1000',
    'x-ratelimit-remaining-requests': '7',
    'x-ratelimit-reset-requests': '1h',
  };
  const keyOne = credentialAccountKey('key-one', 'https://a.invalid/v1');
  const keyTwo = credentialAccountKey('key-two', 'https://a.invalid/v1');
  port.observe(recordQuotaObservation({ provider: SOURCE_A, id: MODEL_A, baseUrl: 'https://a.invalid/v1' }, { status: 200, headers }, 'key-one'));
  assert.equal((await port.read({ candidates: [{ sourceId: SOURCE_A, modelId: MODEL_A, accountKey: keyOne }] }))[0]!.state, 'available');

  // 换 key：提交后旧身份的观测不再可采信（新身份也没有自己的观测，如实未读到）
  await store.commitCredential(SOURCE_A, { type: 'api_key', key: 'key-two' } as never);
  assert.deepEqual(committed, [SOURCE_A], '凭据提交要通知派生事实失效');
  assert.equal((await port.read({ candidates: [{ sourceId: SOURCE_A, modelId: MODEL_A, accountKey: keyOne }] }))[0]!.state, 'unknown', '旧身份的观测必须失效');
  assert.equal((await port.read({ candidates: [{ sourceId: SOURCE_A, modelId: MODEL_A, accountKey: keyTwo }] }))[0]!.state, 'unknown');

  // 自定义接入换 key 同样走这条通知
  await store.commitCustomSetup({
    provider: 'openai-completions', label: '自定义', modelId: 'custom-model', baseUrl: 'https://c.invalid/v1',
    note: 'ready', keyAction: 'replace', apiKey: 'custom-key',
  });
  assert.deepEqual(committed, [SOURCE_A, 'user-defined']);

  // 写盘失败不通知：凭据没变，让旧事实失效反而是无依据的丢弃
  store.injectWriteFailureOnce(new Error('disk-full'));
  await assert.rejects(() => store.commitCredential(SOURCE_A, { type: 'api_key', key: 'key-three' } as never));
  assert.deepEqual(committed, [SOURCE_A, 'user-defined'], '写盘失败不得让已生效的凭据事实失效');
});

await test('观测端与读取端算同一个身份指纹：同凭据同端点同 key，换 key 或换端点即不同', async () => {
  const headers = {
    'x-ratelimit-limit-requests': '1000',
    'x-ratelimit-remaining-requests': '5',
    'x-ratelimit-reset-requests': '1h',
  };
  const first = recordQuotaObservation({ provider: SOURCE_A, id: MODEL_A, baseUrl: 'https://a.invalid/v1' }, { status: 200, headers }, 'key-one');
  const second = recordQuotaObservation({ provider: SOURCE_A, id: MODEL_A, baseUrl: 'https://a.invalid/v1' }, { status: 200, headers }, 'key-one');
  assert.equal(first.accountKey, second.accountKey, '同凭据同端点必须是同一个身份');
  assert.equal(first.accountKey, credentialAccountKey('key-one', 'https://a.invalid/v1'));
  // 端点不同 = 另一个区域/账户的事实
  assert.notEqual(
    recordQuotaObservation({ provider: SOURCE_A, id: MODEL_A, baseUrl: 'https://b.invalid/v1' }, { status: 200, headers }, 'key-one').accountKey,
    first.accountKey,
  );
  // 没有凭据时如实不给身份，不编一个
  assert.equal(recordQuotaObservation({ provider: SOURCE_A, id: MODEL_A, baseUrl: 'https://a.invalid/v1' }, { status: 200, headers }, undefined).accountKey, undefined);

  // 读取端走真实目录存储算出的凭据指纹，必须与观测端一致
  const stateDir = await mkdtemp(join(tmpdir(), 'dcode-identity-match-'));
  const store = new ProviderDirectoryStore({ stateDir }, loopbackCipher, { catalogBaseUrl: 'https://example.invalid' });
  await store.commitCredential(SOURCE_A, { type: 'api_key', key: 'key-one' } as never);
  const stored = await store.readCredential(SOURCE_A);
  const key = (stored as { type?: string; key?: unknown } | undefined)?.key;
  assert.equal(typeof key, 'string');
  const port = new PiQuotaPort({
    resolveAccountKey: async () => credentialAccountKey(key as string, 'https://a.invalid/v1'),
  });
  port.observe(first);
  assert.equal((await port.read({ candidates: [{ sourceId: SOURCE_A, modelId: MODEL_A }] }))[0]!.state, 'available', '真实凭据算出的身份必须命中同一次真实响应');
});