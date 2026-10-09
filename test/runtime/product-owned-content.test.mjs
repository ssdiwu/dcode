import test from 'node:test';
import assert from 'node:assert/strict';
import { DCodeApplication } from '../../src/application/index.ts';
import { MockExecutionBackend } from '../../src/adapters/mock/index.ts';
import { sampleState } from '../../src/adapters/mock/index.ts';
import { assembleExecution } from '../../src/main/assembly.ts';
import { translate } from '../../src/renderer/i18n.ts';

test('正常初始记录只有 Home 和默认任务；没有示例历史或成果', async () => {
  const app = new DCodeApplication(new MockExecutionBackend(), { async load() { return { status: 'missing' }; }, async save() {} });
  try {
    await app.init();
    const state = await app.getSnapshot();
    assert.equal(state.workspaces.length, 1);
    assert.equal(state.tasks.length, 1);
    assert.equal(state.tasks[0].isDefault, true);
    assert.deepEqual(state.sessions, []);
    assert.deepEqual(state.timelines, {});
    assert.deepEqual(state.runs, {});
  } finally { await app.flush(); }
});

test('正常装配与隐藏开关独立；旧标签和任意文字都不能提供执行能力', async () => {
  const { backend, initialState } = await assembleExecution({ DCODE_E2E: '1', DCODE_EXECUTION: 'pi' }, '/isolated-test', undefined);
  assert.equal(backend.kind, 'unavailable');
  assert.equal(backend.modelName, null);
  assert.equal(initialState, undefined);
  const old = sampleState();
  old.model = { configured: true, label: 'arbitrary-nonempty-label', simulated: true };
  old.timelines['session-home-1'].push({ kind: 'message', id: 'later-user-input', role: 'user', text: 'prototype / Pi / storage 是我的原文', streaming: false, at: 1 });
  old.pendingFirstSends = { 'task-home-default': { sessionId: 'session-home-1', text: 'unknown original', mode: 'steer', operationId: 'old-operation' } };
  const expected = structuredClone(old);
  let saved;
  const app = new DCodeApplication(backend, { async load() { return { status: 'ok', state: old }; }, async save(value) { saved = structuredClone(value); } });
  try {
    await app.init();
    const before = await app.getSnapshot();
    assert.deepEqual(before.model, { available: false, name: null });
    for (const key of ['workspaces', 'tasks', 'sessions', 'timelines']) assert.deepEqual(before[key], expected[key]);
    await assert.rejects(app.sendMessage({ taskId: 'task-home-default', text: '任意文字', mode: 'steer' }), /execution-unavailable/);
    const after = await app.getSnapshot();
    assert.deepEqual(after.tasks, before.tasks);
    assert.deepEqual(after.sessions, before.sessions);
    assert.deepEqual(after.timelines, before.timelines);
    await app.flush();
    assert.deepEqual(saved.pendingFirstSends, expected.pendingFirstSends);
    assert.deepEqual(saved.model, expected.model, '保全旧配置原值，不读取或解释为可用能力');
  } finally { await app.flush(); }
});

test('只有显式隔离装配提供样本与模型；误装配缺隔离目录时拒绝', async () => {
  await assert.rejects(assembleExecution({ DCODE_VALIDATION_ASSEMBLY: 'mock' }, '/unused'), /validation-state-directory-required/);
  for (const [assembly, kind, name] of [['mock', 'mock', 'dcode-script'], ['pi-controlled', 'pi', 'Deterministic local fixture']]) {
    const { backend, initialState } = await assembleExecution({ DCODE_VALIDATION_ASSEMBLY: assembly, DCODE_STATE_DIR: '/isolated-test', DCODE_VALIDATION_SAMPLE: '1' }, '/isolated-test', undefined);
    assert.equal(backend.kind, kind);
    assert.equal(backend.modelName, name);
    assert.equal(initialState().sessions.length, 3);
  }
});

test('保存/关闭错误不含底层正文；两个语言各有事件、影响和可用下一步', async () => {
  const diagnostics = [];
  let fail = false;
  const app = new DCodeApplication((await assembleExecution({}, '/isolated-test', undefined)).backend, {
    async load() { return { status: 'missing' }; },
    async save() { if (fail) throw new Error('internal session-id / storage / sensitive-user-text'); },
  }, undefined, (event, cause) => diagnostics.push({ event, cause }));
  await app.init();
  fail = true;
  try {
    await assert.rejects(app.updateSettings({ theme: 'dark' }), /settings-save-failed/);
    const failed = await app.getSnapshot();
    assert.equal(failed.closeError, 'settings-save-failed');
    assert.equal(failed.settings.theme, 'system');
    await assert.rejects(app.flush(), /close-failed/);
    assert.equal((await app.getSnapshot()).closeError, 'close-failed');
    assert.ok(diagnostics.some(({ cause }) => cause instanceof Error && cause.message.includes('sensitive-user-text')));
    for (const language of ['zh', 'en']) {
      for (const issue of ['settings-save-failed', 'close-failed', 'resume-failed', 'resume-unverified']) {
        const message = translate(`issue.${issue}`, undefined, language);
        assert.doesNotMatch(message, /internal|session-id|storage|sensitive-user-text|prototype|原型|控制令牌/);
        assert.match(message, language === 'zh' ? /设置|关闭|继续/ : /Settings|Closing|Resuming/);
        assert.match(message, language === 'zh' ? /选择|查看|打开/ : /Select|Review|Check|reopen/);
      }
      assert.doesNotMatch(translate('app.sendUnknown', undefined, language), /resend|再次发送|身份/);
      assert.doesNotMatch(translate('app.renderError', undefined, language), /prototype|原型/);
    }
  } finally { fail = false; await app.flush().catch(() => undefined); }
});

test('正常启动不带真实配置入口；只有明确写入 model-setup 才推进（凭据不回显）', async () => {
  // 没有 modelSetupIO/modelSetupFactory 的本装配：公开的 configureModel 不被调用——不打造「静默接受并保存」的伪装通路
  const app = new DCodeApplication(new MockExecutionBackend(), { async load() { return { status: 'missing' }; }, async save() {} });
  try {
    await app.init();
    const result = await app.configureModel({ provider: 'openai-responses', label: 'x', modelId: 'm', baseUrl: 'https://api.openai.com/v1', keyAction: 'keep' });
    assert.equal(result.ok, false);
    assert.equal(result.issue, 'backend-unavailable');
    // 即使保存了 message/content 都不应有 key 内容回显到快照
    const snapshot = await app.getSnapshot();
    assert.equal(snapshot.modelSetup.kind, 'unconfigured');
    // 明文 apiKey 请求仅在被当作「真实后端已装配」时才生效——此环境不再用其伪造可用能力
    const snapText = JSON.stringify(snapshot);
    assert.ok(!/apiKey/.test(snapText));
  } finally { await app.flush(); }
});
