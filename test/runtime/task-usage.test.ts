// 任务用量只读汇总（spec/用量与账户额度.md「状态归属与呈现」「数据解释与异常反馈」）：
// 1) 按任务归属聚合主会话与成员会话的真实请求记录，其它关联任务不因同账户被计入；
// 2) 逐次归属按 responseId 恰好一次：重复观测与重开不重复计量，真实新增请求照记；
// 3) 没有可归属记录时 totals 为 null（不补零）；某次缺用量字段时写明缺口而不是按零补齐；
// 4) 查看汇总不改变任务执行、不发送输入、不解除暂停。
// 全部内存替身：不启动窗口、不触碰真实账户或凭据。

import test from 'node:test';
import assert from 'node:assert/strict';
import { DCodeApplication } from '../../src/application/index.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sampleState } from '../../src/adapters/mock/index.ts';
import { JsonFileStorage } from '../../src/adapters/storage/index.ts';
import type { ExecutionView } from '../../src/contracts/index.ts';
import type { ExecutionPort, ExecutionTarget, PersistedState } from '../../src/application/types.ts';

const targetOf = (sessionId: string, taskId: string): ExecutionTarget => ({ workspaceId: 'ws-home', taskId, sessionId });

type Attributed = { kind?: 'pi.assistant' | 'dcode.extension-model-result'; provider: string; model: string; responseId: string; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number } };

/** 每个会话一份可控的助手条目：观测口读几次都返回同一批事实。 */
function makeAttributionPort() {
  const control = { instanceId: 'task-usage-fixture', revision: 0 };
  const byTarget = new Map<string, { entries: ExecutionView['entries']; observation: number; submits: number; phase: ExecutionView['phase'] }>();
  const slotOf = (sessionId: string) => {
    const slot = byTarget.get(sessionId) ?? { entries: [], observation: 0, submits: 0, phase: 'ready' as ExecutionView['phase'] };
    byTarget.set(sessionId, slot);
    return slot;
  };
  /** 每条会话拿到自己的端口实例，但共享同一批可控事实（按 sessionId 分槽）。 */
  const portFor = (target: ExecutionTarget): ExecutionPort => ({
    target,
    async read() {
      const slot = slotOf(target.sessionId);
      slot.observation += 1;
      return {
        target, control, observation: slot.observation, phase: slot.phase,
        execution: 'pi-durable-1.3.0', model: null, entries: slot.entries, pendingInputs: 0,
      };
    },
    async submit() {
      slotOf(target.sessionId).submits += 1;
      return { status: 'accepted' as const, operationId: 'op', submissionId: 1, processing: 'done' as const };
    },
    async lookupReceipt() { return { status: 'accepted' as const, operationId: 'op', submissionId: 1, processing: 'done' as const }; },
    async pause() { slotOf(target.sessionId).phase = 'paused'; return this.read(); },
    async resume() { slotOf(target.sessionId).phase = 'ready'; return this.read(); },
    async close() {},
  });
  const apply = (target: ExecutionTarget, list: Attributed[]) => {
    const slot = slotOf(target.sessionId);
    slot.entries = list.map((a, index) => ({
      id: index + 1,
      kind: a.kind ?? 'pi.assistant',
      data: {},
      assistantText: `答复 ${index + 1}`,
      provider: a.provider,
      model: a.model,
      responseId: a.responseId,
      ...(a.usage ? { usage: a.usage } : {}),
    }));
  };
  return { portFor, apply, submits: (sessionId: string) => byTarget.get(sessionId)?.submits ?? 0 };
}

const fixture = () => {
  const attributed = makeAttributionPort();
  let stored: PersistedState = sampleState();
  const app = new DCodeApplication(
    {
      kind: 'pi',
      modelName: 'controlled-model',
      async open(context: { target: ExecutionTarget }) { return attributed.portFor(context.target); },
    },
    { async load() { return { status: 'missing' as const }; }, async save() {} },
    () => stored,
  );
  return { app, attributed, state: () => stored, replace: (next: PersistedState) => { stored = next; } };
};

const USAGE = (input: number, output: number) => ({ input, output, cacheRead: 0, cacheWrite: 0 });

await test('任务用量按归属聚合主会话与成员会话，其它任务不因同账户被计入', async (t) => {
  const { app, attributed, state } = fixture();
  t.after(() => app.flush());
  await app.init();
  const sessions = state().sessions;
  const main = sessions.find((s) => s.taskId === 'task-home-default')!;
  // 成员会话走真实建会话路径，不伪造对象
  const other = await app.createSession({ taskId: main.taskId });
  const foreign = sessions.find((s) => s.taskId !== main.taskId)!;

  const mainTarget = targetOf(main.id, main.taskId);
  const otherTarget = targetOf(other.id, other.taskId);
  const foreignTarget = targetOf(foreign.id, foreign.taskId);
  // 同一来源在两条会话上都有真实请求；另一任务也用了同一来源
  attributed.apply(mainTarget, [{ provider: 'dcode-test', model: 'fixture', responseId: 'r-main-1', usage: USAGE(10, 4) }]);
  attributed.apply(otherTarget, [{ provider: 'dcode-test', model: 'fixture', responseId: 'r-other-1', usage: USAGE(5, 1) }]);
  attributed.apply(foreignTarget, [{ provider: 'dcode-test', model: 'fixture', responseId: 'r-foreign-1', usage: USAGE(100, 100) }]);

  // 触发观测：真实发送打开端口并读一次视图，把助手条目投影进产品状态
  await app.sendMessage({ sessionId: main.id, text: '主会话的请求', mode: 'follow-up' });
  await app.sendMessage({ sessionId: other.id, text: '成员会话的请求', mode: 'follow-up' });
  await app.sendMessage({ sessionId: foreign.id, text: '别的任务的请求', mode: 'follow-up' });
  const task = state().tasks.find((x) => x.id === main.taskId)!;
  const foreignTask = state().tasks.find((x) => x.id === foreign.taskId)!;
  const summary = (await app.getSnapshot()).taskUsage[task.id]!;
  const foreignSummary = (await app.getSnapshot()).taskUsage[foreignTask.id]!;

  assert.equal(summary.totals?.input, 15, '主会话与成员会话的用量都在计量范围内');
  assert.equal(summary.totals?.requests, 2);
  assert.deepEqual(summary.scope.map((s) => s.sessionId).sort(), [main.id, other.id].sort(), '范围只含本任务会话');
  assert.equal(foreignSummary.totals?.input, 100, '其它任务不因同账户被计入本任务');
  assert.equal(
    summary.bySource.length === 1 && summary.bySource[0]!.usage.input === 15,
    true,
    '按实际来源合并，同一来源只列一次',
  );
  assert.equal(summary.incompleteReason, null);
});

await test('逐次归属按 responseId 恰好一次：重复观测与再次读取不重复计量', async (t) => {
  const { app, attributed, state } = fixture();
  t.after(() => app.flush());
  await app.init();
  const main = state().sessions.find((s) => s.kind === 'main')!;
  const target = targetOf(main.id, main.taskId);
  attributed.apply(target, [
    { provider: 'dcode-test', model: 'fixture', responseId: 'r-1', usage: USAGE(10, 4) },
    { provider: 'dcode-test', model: 'fixture', responseId: 'r-2', usage: USAGE(3, 2) },
  ]);

  await app.sendMessage({ sessionId: main.id, text: '触发真实请求', mode: 'follow-up' });
  for (let i = 0; i < 3; i += 1) await app.getSnapshot();
  const task = state().tasks.find((x) => x.id === main.taskId)!;
  const summary = (await app.getSnapshot()).taskUsage[task.id]!;
  const sessionState = (await app.getSnapshot()).sessionModels[main.id]!;

  assert.equal(sessionState.requests.length, 2, '两次真实请求各记一次');
  assert.equal(summary.totals?.requests, 2, '重复观测不得把同一事实重复计量');
  assert.equal(summary.totals?.input, 13);

  // 真实新增的请求即使正文相同也照记
  attributed.apply(target, [
    { provider: 'dcode-test', model: 'fixture', responseId: 'r-1', usage: USAGE(10, 4) },
    { provider: 'dcode-test', model: 'fixture', responseId: 'r-2', usage: USAGE(3, 2) },
    { provider: 'dcode-test', model: 'fixture', responseId: 'r-3', usage: USAGE(7, 1) },
  ]);
  await app.sendMessage({ sessionId: main.id, text: '再触发一次真实请求', mode: 'follow-up' });
  for (let i = 0; i < 3; i += 1) await app.getSnapshot();
  const grown = (await app.getSnapshot()).taskUsage[task.id]!;
  assert.equal(grown.totals?.requests, 3, '真实新增请求计入');
  assert.equal(grown.totals?.input, 20);
});

await test('没有可归属记录时为 null（不补零）；某次缺用量字段时写明缺口', async (t) => {
  const { app, attributed, state } = fixture();
  t.after(() => app.flush());
  await app.init();
  const main = state().sessions.find((s) => s.kind === 'main')!;
  const target = targetOf(main.id, main.taskId);
  const task = state().tasks.find((x) => x.id === main.taskId)!;

  const empty = (await app.getSnapshot()).taskUsage[task.id]!;
  assert.equal(empty.totals, null, '没有真实记录不是零用量');
  assert.deepEqual(empty.bySource, []);

  // 有真实请求但该次没有用量字段：归属成立，用量缺口如实说明，不按零补齐
  attributed.apply(target, [
    { provider: 'dcode-test', model: 'fixture', responseId: 'r-no-usage' },
    { provider: 'dcode-test', model: 'fixture', responseId: 'r-usage', usage: USAGE(4, 1) },
  ]);
  await app.sendMessage({ sessionId: main.id, text: '触发真实请求', mode: 'follow-up' });
  for (let i = 0; i < 2; i += 1) await app.getSnapshot();
  const partial = (await app.getSnapshot()).taskUsage[task.id]!;
  assert.ok(partial.incompleteReason, '覆盖不完整必须写明缺口');
  assert.equal(partial.totals?.requests, 1, '只计有真实用量字段的那次');
  assert.equal(partial.totals?.input, 4);
});

await test('查看汇总是只读的：不发输入、不改运行状态、不解除暂停', async (t) => {
  const { app, attributed, state } = fixture();
  t.after(() => app.flush());
  await app.init();
  const main = state().sessions.find((s) => s.kind === 'main')!;
  const target = targetOf(main.id, main.taskId);
  attributed.apply(target, [{ provider: 'dcode-test', model: 'fixture', responseId: 'r-1', usage: USAGE(6, 3) }]);
  await app.sendMessage({ sessionId: main.id, text: '触发真实请求', mode: 'follow-up' });

  await app.pauseRun({ sessionId: main.id });
  const paused = await app.getSnapshot();
  assert.equal(paused.runs[main.id]!.status, 'paused');

  const submitsBefore = attributed.submits(main.id);
  const task = state().tasks.find((x) => x.id === main.taskId)!;
  for (let i = 0; i < 3; i += 1) {
    const read = (await app.getSnapshot()).taskUsage[task.id];
    assert.equal(read.taskId, task.id);
  }
  const after = await app.getSnapshot();
  assert.equal(attributed.submits(main.id), submitsBefore, '查看用量不得发送工作输入');
  assert.equal(after.runs[main.id]!.status, 'paused', '查看用量不得改变运行状态或解除暂停');
  assert.equal(after.taskUsage[task.id]!.totals?.input, 6, '暂停中的真实记录仍如实汇总');
});

await test('较小视图不回落：A+B 之后只看到早期 A 的视图，会话与任务累计都不许退回 A', async (t) => {
  const { app, attributed, state } = fixture();
  t.after(() => app.flush());
  await app.init();
  const main = state().sessions.find((s) => s.taskId === 'task-home-default')!;
  const target = targetOf(main.id, main.taskId);
  const USAGE_A = { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 };
  const USAGE_B = { input: 7, output: 2, cacheRead: 0, cacheWrite: 0 };

  // A 与 B 各发生一次真实请求（同一池、两个来源）
  attributed.apply(target, [
    { provider: 'dcode-test', model: 'fixture', responseId: 'r-a', usage: USAGE_A },
    { provider: 'dcode-test-b', model: 'fixture-b', responseId: 'r-b', usage: USAGE_B },
  ]);
  await app.sendMessage({ sessionId: main.id, text: '触发真实请求', mode: 'follow-up' });
  const full = await app.getSnapshot();
  const sessionFull = full.sessionModels[main.id]!;
  const taskFull = full.taskUsage[main.taskId]!;
  assert.equal(sessionFull.usage?.input, 17, '会话累计 = A + B');
  assert.equal(sessionFull.usage?.requests, 2);
  assert.equal(taskFull.totals?.input, 17, '任务合计与逐次记录一致');
  assert.equal(taskFull.bySource.length, 2, '两个来源分开呈现');

  // 执行端换实例／重开后视图只含更早的 A：观测口径变小不是事实变小
  attributed.apply(target, [{ provider: 'dcode-test', model: 'fixture', responseId: 'r-a', usage: USAGE_A }]);
  await app.sendMessage({ sessionId: main.id, text: '触发一次真实请求', mode: 'follow-up' });
  const smaller = await app.getSnapshot();
  assert.equal(smaller.sessionModels[main.id]!.usage?.input, 17, '会话累计不因视图变小而回落');
  assert.equal(smaller.sessionModels[main.id]!.usage?.requests, 2);
  assert.equal(smaller.taskUsage[main.taskId]!.totals?.input, 17, '任务合计同样不回落');
  assert.equal(smaller.sessionModels[main.id]!.requests.length, 2, '逐次归属不得被去重掉');
  assert.equal(smaller.sessionModels[main.id]!.actualResponseId, 'r-b', '实际采用也不会退回更早的请求');
});

await test('真实存储重开：用量与归属按持久事实恢复，不重开一次就重计', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dcode-task-usage-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = { workspaceId: 'ws-home', taskId: 'task-home-default', sessionId: 'session-home-1' };
  const storage = new JsonFileStorage(dir);
  const attributed = makeAttributionPort();
  attributed.apply(target as never, [
    { provider: 'dcode-test', model: 'fixture', responseId: 'r-persist-1', usage: USAGE(12, 5) },
    { provider: 'dcode-test', model: 'fixture', responseId: 'r-persist-2', usage: USAGE(3, 1) },
  ]);
  // 首次启动用样例态（有会话与任务），随后全部落盘；重开只读盘里的事实
  const first = new DCodeApplication(
    { kind: 'pi', modelName: 'controlled', async open() { return attributed.portFor(target as never); } },
    storage,
    () => sampleState(),
  );
  t.after(() => first.flush());
  await first.init();
  await first.sendMessage({ sessionId: target.sessionId, text: '真实发送', mode: 'follow-up' });
  const before = await first.getSnapshot();
  assert.equal(before.sessionModels[target.sessionId]!.usage?.input, 15, '关闭前累计来自两条真实请求');
  assert.equal(before.taskUsage[target.taskId]!.totals?.input, 15);
  await first.flush(); // 关闭收束走同一条落盘路径

  // 重新打开同一个状态目录：累计来自持久事实，不因重开而清零或翻倍
  const second = new DCodeApplication(
    { kind: 'pi', modelName: 'controlled', async open() { return attributed.portFor(target as never); } },
    new JsonFileStorage(dir),
  );
  t.after(() => second.flush());
  await second.init();
  const after = await second.getSnapshot();
  const sessionState = after.sessionModels[target.sessionId];
  assert.ok(sessionState, '重开后仍能读到这条会话的模型状态');
  assert.equal(sessionState.usage?.input, 15, '重开后累计与关闭前一致，不清零也不翻倍');
  assert.equal(sessionState.usage?.requests, 2);
  assert.equal(sessionState.actualResponseId, 'r-persist-2', '实际采用按持久事实恢复');
  assert.equal(after.taskUsage[target.taskId]!.totals?.input, 15, '重开后任务合计与关闭前一致');
  assert.equal(after.runs[target.sessionId]?.status !== undefined, true);
});


await test('工具内单次模型响应按真实身份计入任务用量，重复观察不重计、不伪造助手', async (t) => {
  const { app, attributed, state } = fixture(); t.after(() => app.flush()); await app.init();
  const main = state().sessions.find(s => s.kind === 'main')!; const target = targetOf(main.id, main.taskId);
  attributed.apply(target, [
    {provider:'dcode-test',model:'fixture',responseId:'outer-1',usage:USAGE(2,1)},
    {kind:'dcode.extension-model-result',provider:'dcode-test',model:'fixture',responseId:'inner-1',usage:USAGE(117,13)},
    {provider:'dcode-test',model:'fixture',responseId:'outer-2',usage:USAGE(2,1)},
  ]);
  await app.sendMessage({sessionId:main.id,text:'真实工具内请求',mode:'follow-up'});
  for(let i=0;i<3;i++)await app.getSnapshot();
  const snapshot=await app.getSnapshot(); const summary=snapshot.taskUsage[main.taskId]!;
  assert.equal(summary.totals?.requests,3); assert.equal(summary.totals?.input,121); assert.equal(summary.totals?.output,15);
  assert.equal(snapshot.sessionModels[main.id]?.requests.length,3,'内层真实responseId只记一次');
  assert.equal(attributed.submits(main.id),1,'读取归属不产生新执行');
});
