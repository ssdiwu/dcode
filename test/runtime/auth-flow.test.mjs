// ProviderLoginService + AuthFlowRegistry + store 双授权点的协同：
// flow 提交点核对成功；旧 flow 吊销后提交即时被拒（旧认证保留）；取消挂起 prompt 即时拒绝；
// 同 provider 新 flow 使旧 flow 提交失效；提交完成后再取消不影响已保存。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderDirectoryStore } from '../../src/adapters/pi/provider-directory-store.ts';
import { AuthFlowRegistry } from '../../src/adapters/pi/auth-flow-guard.ts';
import { ProviderLoginService } from '../../src/adapters/pi/login-service.ts';
import { ProviderLoginController } from '../../src/main/provider-login.ts';
import { DCodeApplication } from '../../src/application/index.ts';
import { MockExecutionBackend } from '../../src/adapters/mock/index.ts';

const stubCipher = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from(s, 'utf8'),
  decrypt: (buf) => Buffer.from(buf).toString('utf8'),
};

const presetWithApiKeyLogin = (id = 'testco') => ({
  id,
  name: 'TestCo',
  authKinds: ['api_key'],
  provider: {
    id,
    name: 'TestCo',
    baseUrl: 'https://api.testco.com/v1',
    getModels: () => [],
    auth: {
      apiKey: {
        name: 'TestCo API key',
        login: async (interaction) => {
          const key = await interaction.prompt({ type: 'secret', message: 'Enter key' });
          return { type: 'api_key', key };
        },
        resolve: async ({ credential }) => (credential?.key ? { auth: { apiKey: credential.key } } : undefined),
      },
    },
  },
});

test('login 走 SDK 正式通路：prompt 收集 → gated store 提交点写凭据；凭据归属 providerId 精确', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dcode-login-'));
  try {
    const store = new ProviderDirectoryStore({ stateDir }, stubCipher, { catalogBaseUrl: 'https://x' });
    const presets = [presetWithApiKeyLogin()];
    const registry = new AuthFlowRegistry();
    const service = new ProviderLoginService({ directoryStore: store, presets });
    const guard = registry.begin('testco');
    const prompts = [];
    const outcome = await service.runLogin(
      { loginId: 'L1', providerId: 'testco', type: 'api_key' },
      guard,
      new AbortController().signal,
      {
        onPrompt: (event) => {
          prompts.push(event);
          // UI 立即回答（测试直接把回答回送）
          queueMicrotask(() => service.answerPrompt(event.requestId, 'sk-live-key', false));
        },
        onInfo: () => {},
      },
    );
    assert.equal(outcome.ok, true);
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].kind, 'secret');
    const saved = await store.asPiCredentialStore().read('testco');
    assert.equal(saved?.key, 'sk-live-key');
    const other = await store.asPiCredentialStore().read('openai');
    assert.equal(other, undefined, '凭据不写到别的供应商名下');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('同 provider 第二次 begin 后旧 guard 提交失效（新代次使旧流程失效），旧认证保留', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dcode-login-seq-'));
  try {
    const store = new ProviderDirectoryStore({ stateDir }, stubCipher, { catalogBaseUrl: 'https://x' });
    await store.commitCredential('testco', { type: 'api_key', key: 'sk-original' });
    const registry = new AuthFlowRegistry();
    const oldGuard = registry.begin('testco');
    registry.begin('testco'); // 新代次：Registry 自动吊销同 provider 旧 flow（`#latestByProvider` 顶代）
    const sdk = store.asPiCredentialStore({
      beforePrepare: (id) => oldGuard.beforePrepare(id),
      beforeCommit: (id) => oldGuard.beforeCommit(id),
    });
    // 新代次使旧 flow 失效（无需手工 revoke）：旧 guard 提交点核对立即拒，旧认证保留
    await assert.rejects(sdk.modify('testco', async () => ({ type: 'api_key', key: 'sk-overwrite' })), /auth-flow-superseded/);
    const back = await store.asPiCredentialStore().read('testco');
    assert.equal(back?.key, 'sk-original');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

async function authFixture(options = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'dcode-auth-admission-'));
  const store = new ProviderDirectoryStore({ stateDir }, stubCipher, { catalogBaseUrl: 'https://x' });
  await store.commitCredential('testco', { type: 'api_key', key: 'sk-original' });
  await store.commitPresetSelection({ providerId: 'testco', modelId: 'm', note: 'ready' });
  const base = new MockExecutionBackend({ timescale: 0.01, ...(options.backendOptions ?? {}) });
  const appliedTargets = [];
  let armed = false;
  const readEntered = deferred();
  const readGate = deferred();
  const backend = {
    kind: base.kind, modelName: base.modelName,
    async open(context) {
      const port = await base.open(context);
      return new Proxy(port, { get(target, key) {
        // 本夹具聚焦认证准入；保存的单模型现在也必须经过正式应用，不能让缺失接口提前挡住原断言。
        if (key === 'applySessionModel') return async (model) => { appliedTargets.push({ ...model }); };
        if (key === 'read') return async () => {
          if (armed) { armed = false; readEntered.resolve(); await readGate.promise; }
          return target.read();
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    },
  };
  const app = new DCodeApplication(backend, { async load() { return { status: 'missing' }; }, async save() {} }, undefined, () => {}, store, () => backend);
  await app.init();
  assert.equal((await app.getSnapshot()).modelSetup.kind, 'preset', '当前供应商必须真实进入相位核对分支');
  const task = await app.createTask({ workspaceId: 'ws-home', parentId: null, title: 'auth-admit' });
  const session = await app.createSession({ taskId: task.id });
  // 默认暂停：相位核对用例需要一个稳定端口。paused:false 时保持 idle，让「发送被接受」断言
  // 反映真实回执（mock 端口自身就会以 reason=paused 拒 steer，不能与认证门控混为一谈）。
  if (options.paused !== false) await app.pauseRun({ sessionId: session.id });
  return { app, store, session, appliedTargets, readEntered, readGate, arm: () => { armed = true; }, async cleanup() {
    readGate.resolve();
    await app.flush();
    rmSync(stateDir, { recursive: true, force: true });
  } };
}

test('真实当前供应商 read 在途：A/B/A admission 不穿透，send/config 拒绝，SDK token 刷新保留', { timeout: 10000 }, async () => {
  const fixture = await authFixture();
  const { app, store, session, readEntered, readGate } = fixture;
  let releaseA;
  let releaseB;
  let first;
  try {
    fixture.arm();
    first = app.beginProviderAuth('testco');
    await readEntered.promise;
    assert.equal((await app.beginProviderAuth('testco')).ok, false);
    const other = await app.beginProviderAuth('another');
    assert.equal(other.ok, true);
    releaseB = other.release;
    assert.equal((await app.beginProviderAuth('testco')).ok, false, 'B 在途不覆盖 A 的正式认领');
    const config = await app.configureModel({ provider: 'openai-completions', label: 'X', modelId: 'm', baseUrl: 'http://127.0.0.1:9999/v1', keyAction: 'replace', apiKey: 'k' });
    assert.equal(config.issue, 'run-in-flight');
    const send = await app.sendMessage({ sessionId: session.id, text: 'hi', mode: 'steer' });
    assert.equal(send.receipt.status, 'not-accepted');
    await assert.rejects(
      () => app.resumeRun({ sessionId: session.id }),
      /auth-flow-in-flight/,
      'A 自身认证在途仍拒其明确继续',
    );
    await store.asPiCredentialStore().modify('testco', async (current) => ({ type: 'api_key', key: current.key + '-refreshed' }));
    assert.equal((await store.readCredential('testco')).key, 'sk-original-refreshed');
    readGate.resolve();
    const admitted = await first;
    assert.equal(admitted.ok, true);
    releaseA = admitted.release;
    releaseB();
    assert.equal((await app.beginProviderAuth('testco')).ok, false, '释放 B 不释放 A');
    releaseA();
    assert.equal(app.authFlowInFlight, false);
  } finally {
    readGate.resolve();
    const admitted = first ? await first : null;
    if (admitted?.ok) admitted.release();
    releaseA?.(); releaseB?.();
    await fixture.cleanup();
  }
});

test('只给另一供应商 B 登录：当前供应商 A 的发送与继续不被无关阻断；释放 B 不改变 A 工作', { timeout: 10000 }, async () => {
  // spec/模型选择与自动切换.md「认证与自定义保留」：在途门控约束的是**影响该供应商**的发送/继续。
  // 当前使用 A、只为 B 登录时，B 的在途不得阻断 A 的新发送与明确继续（反向：上一条已证 A 自身在途仍拒）。
  const fixture = await authFixture({ paused: false });
  const { app, session } = fixture;
  let releaseB;
  try {
    const other = await app.beginProviderAuth('another');
    assert.equal(other.ok, true, 'B 非当前供应商：跳过 A 的真实相位核对直接放行');
    releaseB = other.release;
    const send = await app.sendMessage({ sessionId: session.id, text: 'A 的工作', mode: 'steer' });
    assert.equal(send.receipt.status, 'accepted', 'B 在途不得阻断 A 的新发送');
    assert.deepEqual(fixture.appliedTargets.at(-1), { sourceId: 'testco', modelId: 'm', thinkingLevel: null }, 'A 的保存目标已实际交到执行接口');
    await app.resumeRun({ sessionId: session.id });
    releaseB();
    releaseB = undefined;
    assert.equal(app.authFlowInFlight, false);
    const after = await app.sendMessage({ sessionId: session.id, text: 'B 释放后 A 继续', mode: 'steer' });
    assert.equal(after.receipt.status, 'accepted', '释放 B 不改变 A 的工作');
    await app.resumeRun({ sessionId: session.id });
  } finally {
    releaseB?.();
    await fixture.cleanup();
  }
});

test('宿主登录 admission 期间取消/重复身份/关闭：不启动 SDK，关闭真实等 read 收束', { timeout: 10000 }, async () => {
  const fixture = await authFixture();
  const { app, store, readEntered, readGate } = fixture;
  const registry = new AuthFlowRegistry();
  const service = new ProviderLoginService({ directoryStore: store, presets: [presetWithApiKeyLogin()] });
  let prompts = 0;
  const controller = new ProviderLoginController({
    admit: (id) => app.beginProviderAuth(id), beginGuard: (id) => registry.begin(id),
    perform: (input, guard, signal) => service.runLogin(input, guard, signal, { onPrompt() { prompts++; }, onInfo() {} }),
    rejectPrompts: (id) => service.rejectLoginPrompts(id, new Error('cancelled')), diagnose() {},
  });
  try {
    fixture.arm();
    const first = controller.start({ loginId: 'L1', providerId: 'testco', type: 'api_key' });
    await readEntered.promise;
    const duplicate = await controller.start({ loginId: 'L1', providerId: 'another', type: 'api_key' });
    assert.equal(duplicate.issue, 'invalid-input');
    controller.cancel('L1');
    let closed = false;
    const closing = controller.close().then(() => { closed = true; });
    await Promise.resolve();
    assert.equal(closed, false, '发送取消信号不等于相位读取已收束');
    assert.equal(prompts, 0);
    readGate.resolve();
    assert.equal((await first).issue, 'cancelled');
    await closing;
    assert.equal(app.authFlowInFlight, false);
    assert.equal((await store.readCredential('testco')).key, 'sk-original');
    assert.equal((await controller.start({ loginId: 'L2', providerId: 'testco', type: 'api_key' })).ok, false);
  } finally {
    readGate.resolve();
    await controller.close();
    await fixture.cleanup();
  }
});

test('应用先同步认领关闭：拒绝新操作，已开始设置保存仍完成再收束', async () => {
  const writeEntered = deferred();
  const writeGate = deferred();
  let armed = false;
  const saved = [];
  const app = new DCodeApplication(new MockExecutionBackend(), {
    async load() { return { status: 'missing' }; },
    async save(state) { if (armed) { armed = false; writeEntered.resolve(); await writeGate.promise; } saved.push(structuredClone(state)); },
  });
  await app.init();
  const task = await app.createTask({ workspaceId: 'ws-home', parentId: null, title: 'closing' });
  const session = await app.createSession({ taskId: task.id });
  armed = true;
  const settings = app.updateSettings({ fontSize: 13 });
  try {
    await writeEntered.promise;
    app.beginClosing();
    const savesAtIntent = saved.length;
    assert.equal((await app.beginProviderAuth('testco')).reason, 'shutting-down');
    assert.equal((await app.sendMessage({ sessionId: session.id, text: 'late', mode: 'steer' })).receipt.status, 'not-accepted');
    assert.equal((await app.configureModel({ provider: 'openai-completions', label: 'X', modelId: 'm', baseUrl: 'http://127.0.0.1:9999/v1', keyAction: 'replace', apiKey: 'k' })).issue, 'storage-failed');
    await assert.rejects(app.resumeRun({ sessionId: session.id }), /app-closing/);
    assert.equal(saved.length, savesAtIntent, '关闭意图不提前启动最终保存');
    let flushed = false;
    const flush = app.flush().then(() => { flushed = true; });
    await Promise.resolve();
    assert.equal(flushed, false, '既有保存未完成前不报关闭成功');
    writeGate.resolve();
    await settings; await flush;
    assert.equal(saved.at(-1).settings.fontSize, 13);
  } finally {
    writeGate.resolve();
    await settings.catch(() => undefined);
    await app.flush().catch(() => undefined);
  }
});

test('cancel：挂起 prompt 即时拒绝，不再悬挂；已撤销后登录回执为 cancelled 且旧凭据不动', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dcode-login-cancel-'));
  try {
    const store = new ProviderDirectoryStore({ stateDir }, stubCipher, { catalogBaseUrl: 'https://x' });
    await store.commitCredential('testco', { type: 'api_key', key: 'sk-before' });
    const presets = [presetWithApiKeyLogin()];
    const registry = new AuthFlowRegistry();
    const service = new ProviderLoginService({ directoryStore: store, presets });
    const guard = registry.begin('testco');
    let promptSeen = null;
    const runPromise = service.runLogin(
      { loginId: 'L-cancel', providerId: 'testco', type: 'api_key' },
      guard,
      new AbortController().signal,
      {
        onPrompt: (event) => {
          promptSeen = event;
          // 等取消发生（不回答、不用 sleep）——直接吊销并拒绝挂起 prompt
          queueMicrotask(() => {
            guard.revoke();
            service.rejectLoginPrompts('L-cancel', new Error('login-cancelled'));
          });
        },
        onInfo: () => {},
      },
    );
    const outcome = await runPromise;
    assert.ok(promptSeen, 'prompt 必须真实到达');
    // runLogin 报 auth-failed（prompt-cancelled 被拒引起）；关键断言是旧凭据不动、prompt 不悬挂
    assert.equal(outcome.ok, false);
    const back = await store.asPiCredentialStore().read('testco');
    assert.equal(back?.key, 'sk-before');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// retrySend 是「所有可能发送入口」里独立的一条：它自己只核关闭与保存 flight，
// 实际投递走 recoverOrSubmit 的「可靠 not-found 才重投」接缝，必须在可能 submit 前消费同一判定。
test('retrySend：A 自身认证在途时不得实际重投；B-only 在途允许同身份重试；已接收的查回不被改报', { timeout: 10000 }, async () => {
  const fixture = await authFixture({ paused: false, backendOptions: { injectUnknownOnce: true } });
  const { app, session } = fixture;
  let releaseA;
  let releaseB;
  try {
    // 首次发送：mock 注入「已提交但结果待核对」且不留下任何提交记录 → 后续查回可靠 not-found
    const first = await app.sendMessage({ sessionId: session.id, text: '原输入', mode: 'steer', operationId: 'op-retry-1' });
    assert.equal(first.receipt.status, 'unknown', '前置条件：执行端结果未知且未留下提交记录');
    const block = (await app.getSnapshot()).timelines[session.id].find((b) => b.kind === 'message' && b.role === 'user');
    assert.ok(block?.id, '前置条件：存在可重试的用户消息块');
    const blockId = block.id;

    // A 自身认证在途：retrySend 不得实际投递
    const admittedA = await app.beginProviderAuth('testco');
    assert.equal(admittedA.ok, true);
    releaseA = admittedA.release;
    const refused = await app.retrySend({ sessionId: session.id, blockId });
    assert.equal(refused.receipt.status, 'not-accepted', 'A 自身认证在途时不得实际重投');
    releaseA();
    releaseA = undefined;
    // 只读回查仍是可靠 not-found：证明上一步确实没有投递（而不是投了又回执丢失）
    const probed = await app.checkReceipt({ sessionId: session.id, blockId });
    assert.equal(probed.receipt.status, 'not-accepted');
    assert.equal(probed.receipt.reason, 'not-found', '被拒的重投不得留下任何提交记录');

    // B-only 在途：同身份重试允许，且真实投递成功
    const admittedB = await app.beginProviderAuth('another');
    assert.equal(admittedB.ok, true);
    releaseB = admittedB.release;
    const retried = await app.retrySend({ sessionId: session.id, blockId });
    assert.equal(retried.receipt.status, 'accepted', 'B-only 在途不得阻断同身份重试');
    assert.equal(retried.receipt.operationId, 'op-retry-1', '同身份重试不得改写 operationId');

    // 已接收的输入：A 在途时再次重试必须靠只读回查返回 accepted，不得改报 not-accepted
    releaseB();
    releaseB = undefined;
    // 重投已让端口真实运行；供应商认证的相位核对对运行中/正在暂停的端口本就拒绝，
    // 先把端口停到 paused 再认领——这是既有门控，不属于本次修复。
    await app.pauseRun({ sessionId: session.id });
    const readmittedA = await app.beginProviderAuth('testco');
    assert.equal(readmittedA.ok, true);
    releaseA = readmittedA.release;
    const found = await app.retrySend({ sessionId: session.id, blockId });
    assert.equal(found.receipt.status, 'accepted', '已接收的输入不得因认证在途被改报未接收');
    assert.equal(found.receipt.operationId, 'op-retry-1');
  } finally {
    releaseA?.();
    releaseB?.();
    await fixture.cleanup();
  }
});
