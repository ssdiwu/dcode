// 模型配置保存的并发与关闭等待：flight 在途时第二保存/发送/恢复被拒；flush 等真实提交；
// 反向互斥：接收在途时 configureModel 被拒。使用确定门控 Promise，不依赖 sleep。
// 不直接访问 app['ports']，通过公开应用/后端接口建立端口。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DCodeApplication } from '../../src/application/index.ts';
import { MockExecutionBackend } from '../../src/adapters/mock/index.ts';
import { ProviderDirectoryStore } from '../../src/adapters/pi/provider-directory-store.ts';

// 简单存根 cipher：明文 base64（不是真实 safeStorage，但覆盖 commitWithCredential → rename 通路）
const stubCipher = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from(s, 'utf8'),
  decrypt: (buf) => Buffer.from(buf).toString('utf8'),
};

const baseInput = (overrides = {}) => ({
  provider: 'openai-completions',
  label: 'Server',
  modelId: 'test-model',
  baseUrl: 'http://127.0.0.1:9999/v1',
  keyAction: 'replace',
  apiKey: 'sk-test-key',
  ...overrides,
});

// 确定门控：enter() 真实进入关键段并停在 release() 前；waitOpen() 同步等真实进入；release() 放行。
function gate() {
  let releaseProceed;
  let entered = false;
  const enterWaiters = [];
  const proceedPromise = new Promise((r) => { releaseProceed = r; });
  return {
    enter: async () => {
      entered = true;
      for (const w of enterWaiters) w();
      enterWaiters.length = 0;
      await proceedPromise;
    },
    waitOpen: () => new Promise((r) => { if (entered) r(); else enterWaiters.push(r); }),
    release: () => releaseProceed(),
  };
}

test('保存 flight 在途：flush 等真实提交；提交完成后 flush 才能继续', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dcode-ms-flush-gate-'));
  try {
    const store = new ProviderDirectoryStore({ stateDir }, stubCipher, { catalogBaseUrl: "https://fixture.invalid" });
    const g = gate();
    const slowStore = new Proxy(store, {
      get(target, prop) {
        if (prop === 'commitCustomSetup') {
          return async (input) => {
            await g.enter(); // 进入提交段，等测试放行
            return target.commitCustomSetup(input);
          };
        }
        // 非拦截方法绑定到原 target：store.read 之类读此方法里访问 #line 等私有字段，
        // 若不绑定 this 会变成 Proxy（Proxy 没有私有字段）导致 ERR_INVALID_THIS。
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const app = new DCodeApplication(
      new MockExecutionBackend({ timescale: 0.01 }),
      { async load() { return { status: 'missing' }; }, async save() {} },
      undefined,
      () => {},
      slowStore,
      () => new MockExecutionBackend({ timescale: 0.01 }),
    );
    await app.init();
    try {
      // 开始保存，等它真实进入提交段
      const pSave = app.configureModel(baseInput());
      await g.waitOpen();

      // 提交进入但未放行——flush 必须等真实提交完成
      let flushResolved = false;
      const pFlush = app.flush().then(() => { flushResolved = true; });
      // 释放若干 microtask 让 flush 有机会执行——若不 converge 到 release，证明 flush 在等
      for (let i = 0; i < 5; i++) await Promise.resolve();
      assert.equal(flushResolved, false, 'flush 不能在提交未放行前完成');

      // 关闭收束已开始：flushPromise 登记后，即使 modelSetupFlight 仍非空（pSave 在途），
      // configureModel 也必须被拒；接受任一明确拒绝文案，不检查具体哪条路径先命中（二者同时成立）。
      const duringClose = await app.configureModel(baseInput({ label: 'X' }));
      assert.equal(duringClose.ok, false, '关闭开始后不接纳新模型配置写入');
      // 必须明确拒绝：busy / 关闭 任一都是合法拒绝；不能静默通过返回 ok=true
      assert.match(duringClose.message ?? '', /仍在保存|关闭/, '关闭开始后保存必须明确被拒');

      g.release();
      const firstSave = await pSave;
      assert.equal(firstSave.ok, true, '保存应成功');
      await pFlush;
      assert.equal(flushResolved, true, 'flush 必须在真实提交完成后完成');

      // flush 完成后（flushPromise 仍在，缓存永久不重做，modelSetupFlight 已清）：
      // 此时唯一拒绝路径是 flushPromise 登记，命中「关闭」文案。
      const afterClose = await app.configureModel(baseInput({ label: 'Y' }));
      assert.equal(afterClose.ok, false, 'flush 完成后不接纳新模型配置写入');
      assert.match(afterClose.message ?? '', /关闭/, 'flush 完成后保存必须以关闭路径拒');
    } finally {
      // 即便断言失败也要放行已 gate 的 store，避免 flush/save 永远挂起
      try { g.release(); } catch { /* noop */ }
      await app.flush().catch(() => undefined);
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('真实会话的 resume 在保存 flight 在途时被拒（不是 Unknown session）', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dcode-ms-resume-gate-'));
  try {
    const store = new ProviderDirectoryStore({ stateDir }, stubCipher, { catalogBaseUrl: "https://fixture.invalid" });
    const g = gate();
    const slowStore = new Proxy(store, {
      get(target, prop) {
        if (prop === 'commitCustomSetup') {
          return async (input) => {
            await g.enter();
            return target.commitCustomSetup(input);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const app = new DCodeApplication(
      new MockExecutionBackend({ timescale: 0.01 }),
      { async load() { return { status: 'missing' }; }, async save() {} },
      undefined,
      () => {},
      slowStore,
      () => new MockExecutionBackend({ timescale: 0.01 }),
    );
    await app.init();
    try {
      // 先真实建 task + session（公开接口，不触碰私有字段）
      const task = await app.createTask({ operationId: 'create-fixture-model-setup-concurrent.test-144', workspaceId: 'ws-home', parentId: null, title: 'resume-test' });
      const session = (await app.getSnapshot()).sessions.find(item => item.id === task.mainSessionId);

      // 开始保存：门控在 store 提交段
      const pSave = app.configureModel(baseInput());
      await g.waitOpen();

      // 保存 flight 在途时，resume 真实存在的会话必须被 model-setup-in-flight 拒（不是 Unknown session）
      await assert.rejects(app.resumeRun({ sessionId: session.id }), /model-setup-in-flight/);

      g.release();
      const first = await pSave;
      assert.equal(first.ok, true);
    } finally {
      g.release();
      await app.flush().catch(() => undefined);
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});


// 使用公开目标与端口造确定反例；门控只延迟 submit 后的投影，不阻塞发送前控制读取。
function bounded(promise, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} 未在 5 秒内完成`)), 5_000); }),
  ]).finally(() => clearTimeout(timer));
}

function executionFixture(beforeRead = async () => {}) {
  const state = { target: null, phase: 'ready', pending: 0, submitted: false, operationId: null,
    reads: 0, closes: 0, resumes: 0, readError: false };
  const view = (observation) => ({ target: state.target, control: { instanceId: 'fixture-instance', revision: 0 },
    observation, phase: state.phase, execution: 'mock', model: null, entries: [], pendingInputs: state.pending });
  const port = {
    async read() {
      const observation = ++state.reads;
      if (state.readError) throw new Error('fixture-read-failed');
      await beforeRead(state);
      return view(observation);
    },
    async close() { state.closes++; },
    async pause() { state.phase = 'paused'; state.pending = 1; return view(++state.reads); },
    async resume() { state.resumes++; throw new Error('unexpected-resume'); },
    async submit(input) {
      state.submitted = true; state.operationId = input.operationId; state.phase = 'running'; state.pending = 1;
      return { status: 'accepted', operationId: input.operationId, submissionId: 1, processing: 'placed' };
    },
    async lookupReceipt(input) {
      if (!state.submitted || state.operationId !== input.operationId) return { status: 'not-accepted', operationId: input.operationId, reason: 'not-found' };
      return { status: 'accepted', operationId: input.operationId, submissionId: 1,
        processing: state.phase === 'ready' ? 'done' : state.phase === 'paused' ? 'queued' : 'placed' };
    },
  };
  const backend = { kind: 'mock', modelName: 'fixture-model', async open(context) { state.target = context.target; return port; } };
  return { state, backend };
}

function fixtureApplication(store, fixture, storage = { async load() { return { status: 'missing' }; }, async save() {} }) {
  return new DCodeApplication(fixture.backend, storage, undefined, () => {}, store, () => fixture.backend);
}

async function openPausedPort(app) {
  const task = await app.createTask({ operationId: 'create-fixture-model-setup-concurrent.test-210', workspaceId: 'ws-home', parentId: null, title: 'paused-config' });
  const session = (await app.getSnapshot()).sessions.find(item => item.id === task.mainSessionId);
  await app.pauseRun({ sessionId: session.id });
  return session;
}

test('accepted 后投影仍 ready：真实运行中拒绝保存，实际 ready 后允许', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dcode-ms-observation-gate-'));
  const submitting = gate(); const projection = gate();
  let heldProjection = false;
  const store = new ProviderDirectoryStore({ stateDir }, stubCipher, { catalogBaseUrl: "https://fixture.invalid" });
  const fixture = executionFixture(async (state) => {
    if (state.submitted && !heldProjection) { heldProjection = true; await projection.enter(); }
  });
  const app = fixtureApplication(store, fixture, {
    async load() { return { status: 'missing' }; },
    async save(state) { if (Object.keys(state.pendingFirstSends ?? {}).length) await submitting.enter(); },
  });
  let snapshot;
  const unsubscribe = app.subscribe(value => { snapshot = value; });
  await app.init();
  try {
    const sending = app.sendMessage({ taskId: 'task-home-default', text: 'first', mode: 'steer' });
    await bounded(submitting.waitOpen(), '进入正式接收');
    const receiving = await app.configureModel(baseInput());
    assert.equal(receiving.issue, 'run-in-flight');
    submitting.release();
    const sent = await bounded(sending, '发送回执');
    assert.equal(sent.receipt.status, 'accepted');
    await bounded(projection.waitOpen(), '接收后读取投影');
    assert.equal(snapshot.runs[sent.sessionId].status, 'ready', '反例必须确实处于旧 ready 投影');
    assert.equal(fixture.state.phase, 'running');
    assert.equal(fixture.state.target.sessionId, sent.sessionId);
    const running = await app.configureModel(baseInput());
    assert.equal(running.ok, false);
    assert.equal(running.issue, 'run-in-flight');
    assert.equal(fixture.state.closes, 0, '真实运行中不能关闭端口');
    assert.equal(await store.read(), null, '真实运行中不能提交配置');

    const observedReady = new Promise(resolve => {
      const off = app.subscribe(value => {
        if (value.runs[sent.sessionId]?.status === 'ready' && value.runs[sent.sessionId]?.pendingInputs === 0) { off(); resolve(); }
      });
    });
    fixture.state.phase = 'ready'; fixture.state.pending = 0;
    projection.release();
    await bounded(observedReady, '实际 ready 状态发布');
    const readySave = await app.configureModel(baseInput());
    assert.equal(readySave.ok, true);
    assert.equal(fixture.state.closes, 1);
    assert.ok(await store.read());
  } finally {
    submitting.release(); projection.release(); unsubscribe();
    await app.flush().catch(() => undefined);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('已打开的 paused 端口保留 pending 队列：配置可保存且不恢复工作', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dcode-ms-paused-edit-'));
  const store = new ProviderDirectoryStore({ stateDir }, stubCipher, { catalogBaseUrl: "https://fixture.invalid" });
  const fixture = executionFixture(); const app = fixtureApplication(store, fixture);
  let snapshot; const unsubscribe = app.subscribe(value => { snapshot = value; });
  await app.init();
  try {
    const session = await openPausedPort(app);
    assert.equal(fixture.state.target.sessionId, session.id);
    assert.equal(fixture.state.phase, 'paused'); assert.equal(fixture.state.pending, 1);
    const saved = await app.configureModel(baseInput());
    assert.equal(saved.ok, true); assert.equal(fixture.state.closes, 1);
    assert.equal(fixture.state.resumes, 0, '改配置不能恢复暂停工作');
    assert.equal(snapshot.runs[session.id].status, 'paused');
    assert.equal(snapshot.runs[session.id].pendingInputs, 1);
    assert.ok(await store.read());
  } finally {
    unsubscribe(); await app.flush().catch(() => undefined);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('已打开端口的状态读取失败：不 close，不提交，保留 A 配置与凭据', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dcode-ms-read-failure-'));
  const store = new ProviderDirectoryStore({ stateDir }, stubCipher, { catalogBaseUrl: "https://fixture.invalid" });
  const fixture = executionFixture(); const app = fixtureApplication(store, fixture);
  await app.init();
  try {
    assert.equal((await app.configureModel(baseInput({ label: 'A' }))).ok, true);
    await openPausedPort(app);
    const original = await store.read(); assert.ok(original?.credentials?.['user-defined'], 'A 凭据必须已落盘');
    fixture.state.readError = true;
    const rejected = await app.configureModel(baseInput({ label: 'B', apiKey: 'replacement-key' }));
    assert.equal(rejected.ok, false); assert.equal(rejected.issue, 'storage-failed');
    assert.equal(fixture.state.closes, 0);
    assert.deepEqual(await store.read(), original);
    assert.equal(fixture.state.resumes, 0);
  } finally {
    await app.flush().catch(() => undefined);
    rmSync(stateDir, { recursive: true, force: true });
  }
});
