// 组件接续第一片的无窗口正向/反例回归（2026-10-07）：
// 1) updateSettings 只认真实持久化结果——pending-save 反例、失败可辨、并发迟到结果、
//    真实 FIFO 次序（A 挂起 B 失败时 A 已落盘的磁盘/内存一致性；旧快照不得覆盖已确认配置）；
// 2) receipt.processing 随普通观测自然刷新，不要求用户/测试额外调用 checkReceipt；
// 3) C01–C06 唯一主按钮状态表：运行约束优先于回执等待/未知，区分新文字与同次旧输入。
// 全部内存替身与静态渲染：不启动窗口、不触碰剪贴板、不连真实服务。

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DCodeApplication } from '../../src/application/index.ts';
import { MockExecutionBackend, sampleState } from '../../src/adapters/mock/index.ts';
import type { AppSnapshot, ExecutionView, InputReceipt, RunState } from '../../src/contracts/index.ts';
import type { ExecutionPort, ExecutionTarget, PersistedState, StorageAdapter } from '../../src/application/types.ts';
import { Composer, derivePrimaryAction } from '../../src/renderer/components/Composer.tsx';
import { TooltipProvider } from '../../src/renderer/components/ui/tooltip.tsx';

const waitFor = async (predicate: () => Promise<boolean> | boolean, message: string): Promise<void> => {
  const deadline = Date.now() + 5000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const aRun = (status: RunState['status']): RunState => ({
  sessionId: 's', status, note: '', pendingInputs: status === 'ready' ? 0 : 1, updatedAt: 0,
});

// ---------- 1) updateSettings：先保存后呈现；失败可辨；并发与真实落盘次序 ----------

/** 与 JsonFileStorage 对齐的 FIFO 可控存储：调用按序串行执行；attempt 与真实 committed 分开记录。
 *  持有（hold）在 save 调用时同步登记——测试可立即 release/reject，不受队列执行时机影响。 */
class HoldStorage implements StorageAdapter {
  attempts: Array<{ settings: unknown; order: number }> = [];
  committed: Array<{ settings: unknown; order: number }> = [];
  private order = 0;
  private holds = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
  private heldOrders = new Set<number>();
  private failOrders = new Set<number>();
  private line: Promise<unknown> = Promise.resolve();

  async load() { return { status: 'missing' as const }; }

  holdNext(): void { this.heldOrders.add(this.order); }
  failNext(): void { this.failOrders.add(this.order); }
  get heldCount(): number { return this.holds.size; }
  heldOrder(): number {
    assert.equal(this.holds.size, 1, 'exactly one held write expected');
    return [...this.holds.keys()][0];
  }
  /** release/reject 最早登记的那位；存取多份 hold 时即 A 在 B 前 */
  releaseHeld(order?: number): void {
    const target = order ?? this.heldOrder();
    this.holds.get(target)!.resolve();
    this.holds.delete(target);
  }
  releaseOldest(): void {
    const target = Math.min(...this.holds.keys());
    this.holds.get(target)?.resolve();
    this.holds.delete(target);
  }
  rejectHeld(message: string): void {
    const order = this.heldOrder();
    this.holds.get(order)!.reject(new Error(message));
    this.holds.delete(order);
  }

  releaseAll(): void {
    for (const hold of this.holds.values()) hold.resolve();
    this.holds.clear();
  }

  async save(state: PersistedState): Promise<void> {
    const order = this.order++;
    const snapshot = JSON.parse(JSON.stringify(state)) as PersistedState;
    this.attempts.push({ settings: snapshot.settings, order });
    const held = this.heldOrders.has(order)
      ? new Promise<void>((resolve, reject) => this.holds.set(order, { resolve, reject }))
      : null;
    if (held) void held.catch(() => undefined); // 早于 FIFO 执行的注入拒绝同样有接收者
    const run = this.line.then(async () => {
      if (held) await held;
      if (this.failOrders.has(order)) throw new Error(`injected-save-failure-${order}`);
      this.committed.push({ settings: snapshot.settings, order });
    });
    this.line = run.catch(() => undefined);
    return run;
  }
}

await test('真实设置错误身份：每次新失败推进，读取不推进；成功清除内容但保留编号与最后持久值', async (t) => {
  const storage = new HoldStorage();
  const app = new DCodeApplication({ kind: 'unavailable', modelName: null, async open() { throw new Error('unexpected execution'); } }, storage);
  t.after(async () => { storage.releaseAll(); await app.flush(); });
  await app.init();
  assert.equal((await app.getSnapshot()).closeErrorRevision, 0);
  const fail = async () => {
    storage.holdNext();
    const pending = app.updateSettings({ theme: 'light' });
    void pending.catch(() => undefined);
    storage.rejectHeld('controlled-settings-failure');
    await assert.rejects(pending, /settings-save-failed/);
    return app.getSnapshot();
  };
  const first = await fail();
  assert.equal(first.closeError, 'settings-save-failed');
  assert.equal(first.settings.theme, 'system');
  assert.equal(first.closeErrorRevision, 1);
  for (let i = 0; i < 3; i++) assert.equal((await app.getSnapshot()).closeErrorRevision, first.closeErrorRevision);
  const second = await fail();
  assert.equal(second.closeErrorRevision, first.closeErrorRevision + 1);
  assert.equal(second.settings.theme, 'system');
  await app.updateSettings({ theme: 'dark' });
  const saved = await app.getSnapshot();
  assert.equal(saved.closeError, null);
  assert.equal(saved.closeErrorRevision, second.closeErrorRevision);
  assert.equal(saved.settings.theme, 'dark');
  const third = await fail();
  assert.equal(third.closeErrorRevision, second.closeErrorRevision + 1);
  assert.equal(third.settings.theme, 'dark');
  assert.equal((storage.committed.at(-1)!.settings as { theme: string }).theme, 'dark');
});

await test('updateSettings: pending save 期间任何读取与普通更新都看不到未保存的新设置；失败可辨并保留原值', { timeout: 15000 }, async (t) => {
  const storage = new HoldStorage();
  const app = new DCodeApplication(
    { kind: 'mock', modelName: 'controlled-test', async open() { throw new Error('unexpected execution'); } },
    storage,
  );
  t.after(async () => { storage.releaseAll(); await app.flush(); });
  await app.init();
  const pushes: AppSnapshot[] = [];
  app.subscribe((snap) => pushes.push(snap));

  storage.holdNext();
  const pending = app.updateSettings({ theme: 'dark' });
  let rejection: unknown = null;
  void pending.catch((e: unknown) => { rejection = e; });

  // 保存未决：本次设置尚未成立——常规读取与另一个普通状态更新的广播都不呈现未保存设置
  assert.equal(storage.heldCount, 1, 'held save did not arrive');
  assert.equal((await app.getSnapshot()).settings.theme, 'system');
  const pushesBefore = pushes.length;
  await app.createTask({ workspaceId: 'ws-home', parentId: null, title: 'unrelated committed task' });
  await waitFor(() => pushes.length > pushesBefore, 'unrelated update was not broadcast');
  const latest = pushes[pushes.length - 1];
  assert.equal(latest.settings.theme, 'system', 'unrelated broadcast must not expose the unsaved configuration');
  assert.equal(latest.tasks.at(-1)!.title, 'unrelated committed task');

  // 在途设置保存期间，普通延迟落盘不得把旧设置快照写进队列覆盖在途写入
  const updatesBefore = storage.committed.length;
  await new Promise((r) => setTimeout(r, 400));
  storage.rejectHeld('injected-config-save-failure');
  // 保存拒绝：调用方能辨认失败（reject），内存保留原有效设置，错误进入可见通路
  await assert.rejects(pending, /settings-save-failed/);
  assert.ok(rejection);
  const afterFail = await app.getSnapshot();
  assert.equal(afterFail.settings.theme, 'system');
  assert.equal(afterFail.settings.language, 'system');
  assert.equal(afterFail.closeError, 'settings-save-failed');
  assert.ok(pushes.some((snap) => snap.closeError === 'settings-save-failed'));
  // 真实 FIFO：在途写入收束前，没有旧快照插队覆盖（theme 更新的延迟落盘被设置保存在途拦下）
  const staleOverwrites = storage.committed.slice(updatesBefore).filter((c) =>
    (c.settings as { theme: string }).theme === 'dark',
  );
  assert.equal(staleOverwrites.length, 0, 'no committed write may carry the unsaved configuration');

  // 同一失效存储上的重试成功：真实保存依持久化结果成立
  const retried = await app.updateSettings({ theme: 'dark' });
  assert.equal(retried.theme, 'dark');
  assert.equal((await app.getSnapshot()).settings.theme, 'dark');
  assert.ok(
    storage.committed.some((c) => (c.settings as { theme: string | null }).theme === 'dark'),
    'persisted states must contain the saved configuration, not just the in-memory one',
  );
  await app.flush();
});

await test('updateSettings: 并发的迟到失败不回滚也不覆盖更新的设置结果', { timeout: 15000 }, async (t) => {
  const storage = new HoldStorage();
  const app = new DCodeApplication(
    { kind: 'mock', modelName: 'controlled-test', async open() { throw new Error('unexpected execution'); } },
    storage,
  );
  t.after(async () => { storage.releaseAll(); await app.flush(); });
  await app.init();

  // 真实 FIFO 下的迟到失败：A 写盘挂起、B 排队在 A 之后；A 被拒绝后 B 才执行——
  // A 的失败晚于 B 的提交开始，但不得回滚或覆盖 B 随后真实保存的结果
  storage.holdNext();
  const first = app.updateSettings({ theme: 'dark' });
  void first.catch(() => undefined);
  assert.equal(storage.heldCount, 1, 'first held save did not arrive');
  const second = app.updateSettings({ theme: 'light' });
  storage.rejectHeld('late-a-failure');
  await assert.rejects(first, /settings-save-failed/);
  const secondResult = await second;
  assert.equal(secondResult.theme, 'light');
  const final = await app.getSnapshot();
  assert.equal(final.settings.theme, 'light', 'late failure must not roll back the newer saved configuration');
  assert.equal(final.settings.theme, 'light');
  assert.equal(final.closeError, null, 'late failure must not clobber the result presented by the newer operation');
  assert.equal(final.closeErrorRevision, 0, '过期失败不能伪造新的可见错误事件');
  assert.equal((storage.committed[storage.committed.length - 1].settings as { theme: string | null }).theme, 'light');
  await app.flush();
});

await test('updateSettings: 真实 FIFO 下 A 先成功、B 后失败时，以实际成功持久化的设置为依据', { timeout: 15000 }, async (t) => {
  const storage = new HoldStorage();
  const app = new DCodeApplication(
    { kind: 'mock', modelName: 'controlled-test', async open() { throw new Error('unexpected execution'); } },
    storage,
  );
  t.after(async () => { storage.releaseAll(); await app.flush(); });
  await app.init();

  storage.holdNext(); // A 的写盘挂起
  const first = app.updateSettings({ theme: 'dark' });
  void first.catch(() => undefined);
  assert.equal(storage.heldCount, 1, 'held A save did not arrive');
  storage.failNext(); // B（排队在 A 之后）失败
  const secondPromise = app.updateSettings({ theme: 'light' });
  void secondPromise.catch(() => undefined);
  let secondDone = false;
  void secondPromise.then(() => { secondDone = true; }, () => { secondDone = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(secondDone, false, 'A 停泊时 B 已认领但不能提前收束');

  // A 真实落盘成功；B 在 FIFO 中随后失败
  storage.releaseHeld();
  await waitFor(() => storage.attempts.length >= 2, 'B 的实际保存应在 A 收束后到达存储');
  await assert.rejects(secondPromise, /settings-save-failed/);
  const firstResult = await first;
  assert.equal(firstResult.theme, 'dark', 'A durably saved and is the actual persisted configuration');

  // 磁盘最后一份 committed 是 A（B 未 committed）；内存同步为 A，不留在与磁盘不同的状态
  const lastCommitted = storage.committed[storage.committed.length - 1];
  assert.equal((lastCommitted.settings as { theme: string | null }).theme, 'dark');
  const snapshot = await app.getSnapshot();
  assert.equal(snapshot.settings.theme, 'dark', 'memory must track the durably saved configuration');
  assert.equal(snapshot.settings.theme, 'dark');
  // 不 flush：确认在最终一致性收束前，内存/磁盘的依据已是实际成功持久化的 A
  await app.flush();
});

await test('updateSettings: A 成功而 B 挂起期间普通 commit 不得把旧设置排到 B 之后', { timeout: 15000 }, async (t) => {
  const storage = new HoldStorage();
  const app = new DCodeApplication(
    { kind: 'mock', modelName: 'controlled-test', async open() { throw new Error('unexpected execution'); } },
    storage,
  );
  t.after(async () => { storage.releaseAll(); await app.flush(); });
  await app.init();

  // A 受控挂起；B 也受控挂起；先放行 A（真实成功持久化）
  storage.holdNext();
  const first = app.updateSettings({ theme: 'dark' });
  void first.catch(() => undefined);
  assert.equal(storage.heldCount, 1, 'held A save did not arrive');
  storage.holdNext();
  const second = app.updateSettings({ theme: 'light' });
  void second.catch(() => undefined);
  storage.releaseOldest(); // A 真实写入成功
  await assert.doesNotReject(first);
  // B 仍在 FIFO 队列里排在 A 后（等到 B 真实处于被挂状态）
  await waitFor(() => storage.heldCount === 1, 'held B save did not arrive');

  // B 未决期间的普通状态更新：其延迟保存不得在 B 之后用旧 settings 快照落盘
  await app.createTask({ workspaceId: 'ws-home', parentId: null, title: 'unrelated committed task' });
  await new Promise((r) => setTimeout(r, 400)); // 覆盖 150ms 防抖与旧退避
  storage.releaseHeld(); // B 真实写入成功
  const secondResult = await second;
  assert.equal(secondResult.theme, 'light');

  // 等设置结果的统一落盘调度完成（真实完成次序，不看定时器数值）
  await waitFor(
    () => storage.committed.some((c) => (c.settings as { theme: string | null }).theme === 'light'),
    'cfg-b durable save did not arrive',
  );

  // 不 flush：内存与最后一份 durable 保存都必须是 B；旧 A 快照不得在 B 之后覆盖
  const lastCommitted = storage.committed[storage.committed.length - 1];
  assert.equal((lastCommitted.settings as { theme: string | null }).theme, 'light', 'older A snapshot must not land after B succeeded');
  assert.equal((await app.getSnapshot()).settings.theme, 'light');
  await app.flush();
});

for (const boundary of ['persistNow', 'flush'] as const) {
  await test(`updateSettings: ${boundary} 等已认领的 A/B 实际收束后再保存最新设置；关闭拒绝新写入`, { timeout: 15000 }, async (t) => {
    const storage = new HoldStorage();
    const app = new DCodeApplication(new MockExecutionBackend({ timescale: 0.01 }), storage);
    t.after(async () => { storage.releaseAll(); await app.flush(); });
    await app.init();
    await app.updateSettings({ theme: 'system' });
    storage.holdNext();
    const first = app.updateSettings({ theme: 'dark' });
    let finished = false;
    storage.holdNext();
    // flush 是真实关闭：A/B 都须先正式认领；关闭后的新设置必须拒绝，不能借测试绕过关闭门。
    // persistNow 保留“等待 A 期间 B 到达”的原动作，继续证明等待者会核后来登记的保存。
    const beforeClose = boundary === 'flush' ? app.updateSettings({ theme: 'light' }) : null;
    const waiting = boundary === 'flush' ? app.flush() : app.sendMessage({
      taskId: 'task-home-default', text: 'controlled persistNow input', mode: 'steer', operationId: `persist-${boundary}`,
    });
    void waiting.then(() => { finished = true; }, () => undefined);
    const second = beforeClose ?? app.updateSettings({ theme: 'light' });
    if (boundary === 'flush') await assert.rejects(app.updateSettings({ theme: 'system' }), /settings-closing/);
    storage.releaseOldest();
    await first;
    // 让等待 A 的续跑经过一个完整事件循环；B 的控制门仍关闭，无时长推定。
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(finished, false, `${boundary} must still be waiting for B`);
    assert.equal(storage.heldCount, 1);
    storage.releaseHeld();
    await second;
    await waiting;
    assert.equal((await app.getSnapshot()).settings.theme, 'light');
    assert.equal((storage.committed.at(-1)!.settings as { theme: string }).theme, 'light');
    const b = storage.committed.findIndex((c) => (c.settings as { theme: string }).theme === 'light');
    assert.ok(storage.committed.slice(b).every((c) => (c.settings as { theme: string }).theme === 'light'), 'no old settings may commit after B');
  });
}

await test('应用合同：同身份找回/可靠未接收后的同身份重试不增加对象或消息；独立于 C02 键盘入口', async (t) => {
  for (const injectUnknownOnce of [false, true]) {
    const backend = new MockExecutionBackend({ injectUnknownOnce, timescale: 0.01 });
    let submitCalls = 0;
    const app = new DCodeApplication({ kind: 'mock', modelName: 'controlled-test', async open(context) {
      const port = await backend.open(context);
      const submit = port.submit.bind(port);
      port.submit = (value: unknown) => { submitCalls++; return submit(value); };
      return port;
    } }, {
      async load() { return { status: 'missing' }; }, async save() {},
    });
    t.after(() => app.flush());
    assert.equal(Reflect.get(app, 'deleteTask'), undefined, '永久删除无应用层直接入口');
    await app.init();
    const input = { taskId: 'task-home-default', text: 'same identity recovery', mode: 'steer' as const, operationId: `same-${injectUnknownOnce}` };
    const first = await app.sendMessage(input);
    const before = await app.getSnapshot();
    const second = await app.sendMessage(input);
    const after = await app.getSnapshot();
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(second.receipt.status, 'accepted');
    assert.equal(after.tasks.length, before.tasks.length);
    assert.equal(after.sessions.length, before.sessions.length);
    const blocks = Object.values(after.timelines).flat().filter((b) => b.kind === 'message' && b.operationId === input.operationId);
    assert.equal(blocks.length, 1);
    assert.equal(second.receipt.operationId, first.receipt.operationId);
    assert.equal(submitCalls, injectUnknownOnce ? 2 : 1, 'accepted 找回只读；可靠未找到才同身份投递一次');
    await app.flush();
  }
});

// ---------- 2) receipt.processing 随普通观测自然刷新 ----------

function makeReceiptPort() {
  const control = { instanceId: 'in-memory-regression', revision: 0 };
  let phase: ExecutionView['phase'] = 'ready';
  let observations = 0;
  let entries: ExecutionView['entries'] = [];
  let pendingInputs = 0;
  let processing: 'queued' | 'placed' | 'done' | 'unanswered' = 'queued';
  const counts = { reads: 0, lookups: 0, submissions: 0, unknowns: 0 };
  let unknownNext = false;
  const receipt = (operationId: string): InputReceipt => ({
    status: 'accepted', operationId, submissionId: 1, processing,
  });
  let target: ExecutionTarget | null = null;
  const port: ExecutionPort = {
    get target() { return target!; },
    async read() {
      counts.reads++;
      return {
        target: target!, control, observation: ++observations, phase, execution: 'mock',
        model: null, entries, pendingInputs,
      };
    },
    async submit(value: unknown) {
      counts.submissions++;
      const input = value as { operationId: string };
      phase = 'running';
      pendingInputs = 1;
      return receipt(input.operationId);
    },
    async lookupReceipt(value: unknown) {
      counts.lookups++;
      if (unknownNext) {
        unknownNext = false; counts.unknowns++;
        return { status: 'unknown', operationId: (value as { operationId: string }).operationId, reason: 'storage-unavailable' };
      }
      if (processing === 'queued') processing = 'placed';
      const input = value as { operationId: string };
      return receipt(input.operationId);
    },
    async pause() { return this.read(); },
    async resume() { return this.read(); },
    async close() {},
  };
  return {
    port, counts,
    setTarget(next: ExecutionTarget) { target = next; },
    setPhase(next: ExecutionView['phase']) { phase = next; },
    unknownNextLookup() { unknownNext = true; },
    finish(answer: string) {
      phase = 'ready'; pendingInputs = 0; processing = 'done';
      entries = [{ id: 1, kind: 'pi.assistant', data: {}, assistantText: answer }];
    },
  };
}

await test('恢复失败以只读确认的真实相位呈现，普通观测不吞原因', { timeout: 15000 }, async (t) => {
  for (const phase of ['paused', 'faulted'] as const) {
    const fixture = makeReceiptPort();
    fixture.port.resume = async () => { throw new Error('controlled-resume-failure'); };
    const app = new DCodeApplication({
      kind: 'mock', modelName: 'controlled-test', async open(context) { fixture.setTarget(context.target); return fixture.port; },
    }, { async load() { return { status: 'missing' }; }, async save() {} }, sampleState);
    t.after(() => app.flush());
    await app.init();
    fixture.setPhase(phase);
    await app.resumeRun({ sessionId: 'session-home-1' });
    const result = await app.getSnapshot();
    assert.equal(result.runs['session-home-1'].status, phase);
    assert.equal(result.runs['session-home-1'].errorNote, 'resume-failed');
    const readsBefore = fixture.counts.reads;
    await waitFor(() => fixture.counts.reads > readsBefore, 'ordinary observation did not run');
    assert.equal((await app.getSnapshot()).runs['session-home-1'].status, phase);
    assert.equal((await app.getSnapshot()).runs['session-home-1'].errorNote, 'resume-failed');
    await app.flush();
  }
});

await test('普通观测自然刷新原消息的处理状态：不需额外 checkReceipt，不重投（门控：finish 在发送后那次同步收束之后才发生）', { timeout: 15000 }, async (t) => {
  const fixture = makeReceiptPort();
  const app = new DCodeApplication(
    { kind: 'pi', modelName: 'controlled-test', async open(context) { fixture.setTarget(context.target); return fixture.port; } },
    { async load() { return { status: 'missing' }; }, async save() {} },
  );
  t.after(() => app.flush());
  await app.init();
  let initialSyncCommitted = false;
  app.subscribe((snap) => {
    const block = Object.values(snap.timelines).flat().find((b) => b.kind === 'message' && b.operationId === 'regression-obs-1');
    if (block?.kind === 'message' && block.receipt?.status === 'accepted' && block.receipt.processing === 'placed') initialSyncCommitted = true;
  });

  const userBlock = async () => {
    const snap = await app.getSnapshot();
    const sessions = Object.values(snap.timelines);
    return sessions.flat().find((b) => b.kind === 'message' && b.role === 'user' && b.operationId === 'regression-obs-1');
  };

  const first = await app.sendMessage({
    taskId: 'task-home-default', text: 'ordinary observation regression',
    mode: 'steer', operationId: 'regression-obs-1',
  });
  assert.equal(first.receipt.status, 'accepted');

  // 门控反例：发送后那次 sync/lookup 已观测到 queued（finish 尚未发生）。
  // 若 finish 恰落在发送后同步的刷新窗口内，就无法证明普通 tick 能独立推进——
  // 必须先核 queued，再 finish，再只等普通轮询。
  await waitFor(() => initialSyncCommitted, 'post-submit sync did not commit its placed receipt before finish');
  const staged = await userBlock();
  assert.equal(
    staged && staged.kind === 'message' && staged.receipt?.status === 'accepted'
      ? (staged.receipt as { processing: string }).processing
      : null,
    'placed',
    'before finish, initial sync must have committed the pending processing state',
  );

  fixture.finish('regression completed answer');
  const readsBefore = fixture.counts.reads;
  await waitFor(async () => {
    const snap = await app.getSnapshot();
    const block = snap.timelines[first.sessionId]?.find(
      (b) => b.kind === 'message' && b.role === 'user' && b.operationId === 'regression-obs-1',
    );
    const answer = snap.timelines[first.sessionId]?.find(
      (b) => b.kind === 'message' && b.role === 'assistant' && b.text === 'regression completed answer',
    );
    return Boolean(answer) && block && block.kind === 'message' && block.receipt?.status === 'accepted'
      ? (block.receipt as { processing: string }).processing === 'done'
      : false;
  }, 'ordinary poll ticks did not refresh the original receipt to done (no checkReceipt/resend allowed)');
  assert.ok(fixture.counts.reads > readsBefore, 'no ordinary observation happened after finish');
  assert.equal(fixture.counts.submissions, 1, 'refresh must not resubmit');
  assert.ok(fixture.counts.lookups > 1, 'poll ticks must advance via the read-only lookup path');
  await app.flush();
});

await test('accepted/placed 后一次 lookup unknown 不降级已接收事实，后续自然 tick 仍到 done', { timeout: 15000 }, async (t) => {
  const fixture = makeReceiptPort();
  const app = new DCodeApplication({ kind: 'pi', modelName: 'controlled-test', async open(context) { fixture.setTarget(context.target); return fixture.port; } }, {
    async load() { return { status: 'missing' }; }, async save() {},
  });
  t.after(() => app.flush());
  await app.init();
  const result = await app.sendMessage({ taskId: 'task-home-default', text: 'accepted receipt transient read failure', mode: 'steer', operationId: 'transient-receipt-1' });
  const receipt = async () => {
    const snap = await app.getSnapshot();
    const block = snap.timelines[result.sessionId].find((b) => b.kind === 'message' && b.operationId === 'transient-receipt-1');
    return block?.kind === 'message' ? block.receipt : undefined;
  };
  await waitFor(async () => { const r = await receipt(); return r?.status === 'accepted' && r.processing === 'placed'; }, 'initial sync must commit placed before injection');
  fixture.unknownNextLookup();
  await waitFor(() => fixture.counts.unknowns === 1, 'ordinary tick did not encounter injected unknown result');
  const preserved = await receipt();
  assert.equal(preserved?.status, 'accepted', '单次读失败不能撤销此前正式接收事实');
  assert.equal(preserved?.status === 'accepted' ? preserved.processing : null, 'placed', 'unknown 不证明完成，保留此前处理进度');
  fixture.finish('controlled answer after read recovered');
  await waitFor(async () => { const r = await receipt(); return r?.status === 'accepted' && r.processing === 'done'; }, 'natural tick remained stuck after transient lookup failure');
  assert.equal(fixture.counts.submissions, 1, '读失败不能重投');
  assert.equal(fixture.counts.unknowns, 1);
  await app.flush();
});

// ---------- 3) C01–C06 唯一主按钮：运行约束优先，区分新文字与同次旧输入 ----------

await test('C01 derivePrimaryAction：先看运行约束，再看本次输入；回执在途/未知不取消有效控制', () => {
  const D: {
    hasNewDraft: boolean; run: RunState | null; unconfigured: boolean; sendPending: boolean; sendUnknown: boolean;
  } = { hasNewDraft: false, run: aRun('ready'), unconfigured: false, sendPending: false, sendUnknown: false };
  const d = (over: Partial<typeof D>) => derivePrimaryAction({ ...D, ...over });
  // 运行中：有新文字→发送；无新文字→暂停；配置不足只限制发送，不禁用仍然有效的暂停
  assert.deepEqual(d({ hasNewDraft: true, run: aRun('running') }), { action: 'send', enabled: true });
  assert.deepEqual(d({ run: aRun('running') }), { action: 'pause', enabled: true });
  assert.deepEqual(d({ hasNewDraft: true, run: aRun('running'), unconfigured: true }), { action: 'send', enabled: false });
  assert.deepEqual(d({ run: aRun('running'), unconfigured: true }), { action: 'pause', enabled: true });
  // 已确认运行时，回执在途/未知不取消暂停（旧输入未变即无新文字）
  assert.deepEqual(d({ run: aRun('running'), sendPending: true }), { action: 'pause', enabled: true });
  assert.deepEqual(d({ run: aRun('running'), sendUnknown: true }), { action: 'pause', enabled: true });
  // 已确认运行时编辑的新稿 B：不因 A 未返回被锁死
  assert.deepEqual(d({ hasNewDraft: true, run: aRun('running'), sendPending: true }), { action: 'send', enabled: true });
  // 暂停处理中的防重优先于发送在途
  assert.deepEqual(d({ run: aRun('pausing'), sendPending: true }), { action: 'pausing', enabled: false });
  assert.deepEqual(d({ hasNewDraft: true, run: aRun('pausing') }), { action: 'pausing', enabled: false });
  // 已暂停+旧发送未知：仍按真实继续条件呈现
  assert.deepEqual(d({ run: aRun('paused'), sendUnknown: true }), { action: 'resume', enabled: true });
  assert.deepEqual(d({ run: aRun('paused'), unconfigured: true }), { action: 'resume', enabled: true });
  // 运行故障：控制不可用
  assert.deepEqual(d({ hasNewDraft: true, run: aRun('faulted') }), { action: 'unavailable', enabled: false });
  // 尚无已确认运行状态：同次回执在途→发送中防重；同次未知→待核对
  assert.deepEqual(d({ sendPending: true }), { action: 'sending', enabled: false });
  assert.deepEqual(d({ sendUnknown: true }), { action: 'checking', enabled: false });
  // 待发送/草稿：空文本禁用发送
  assert.deepEqual(d({ hasNewDraft: true }), { action: 'send', enabled: true });
  assert.deepEqual(d({}), { action: 'send', enabled: false });
  assert.deepEqual(d({ hasNewDraft: true, run: null }), { action: 'send', enabled: true });
  assert.deepEqual(d({ hasNewDraft: true, unconfigured: true }), { action: 'send', enabled: false });
});

const renderComposer = (overrides: Partial<React.ComponentProps<typeof Composer>>) =>
  renderToStaticMarkup(React.createElement(TooltipProvider, null, React.createElement(Composer, {
    draft: 'synthetic correction', onDraftChange() {}, onSend() {}, onPause() {}, onResume: () => Promise.resolve(),
    disabled: false, placeholder: 'probe', mode: 'steer' as const, onModeChange() {},
    run: aRun('ready'),
    ...overrides,
  })));

const buttonTag = (html: string, ariaLabel: string) =>
  [...html.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]).find((tag) => tag.includes(`aria-label="${ariaLabel}"`));

await test('C01 静态渲染：互斥呈现与禁用形态；菜单为输入选项次级入口', () => {
  // 运行中有新文字：发送呈现且可用，暂停不呈现（运行中发送不再被 !busy 禁用——故障1回归）
  const runningWithText = renderComposer({ run: aRun('running'), draft: 'correction' });
  const sendTag = buttonTag(runningWithText, '发送');
  assert.ok(sendTag, 'send button must exist while running with text');
  assert.ok(!/\sdisabled(?:=|\s|>)/.test(sendTag), 'send must be enabled while running with text');
  assert.ok(!buttonTag(runningWithText, '暂停'), 'pause must not coexist next to send');
  // 运行中无新文字：暂停呈现，发送不呈现
  const runningEmpty = renderComposer({ run: aRun('running'), draft: '' });
  assert.ok(buttonTag(runningEmpty, '暂停'), 'pause must be the single primary action while running without text');
  assert.ok(!buttonTag(runningEmpty, '发送'), 'send must not render when running without text');
  // 运行中+同次旧发送在途（文字未变）：仍是真实暂停，不是「发送中」
  const runningPending = renderComposer({ run: aRun('running'), draft: 'old text', pendingSendText: 'old text' });
  assert.ok(buttonTag(runningPending, '暂停'), 'in-flight receipt must not demote confirmed running control');
  // 暂停处理中：不显示继续
  const pausing = renderComposer({ run: aRun('pausing'), draft: '' });
  assert.ok(!buttonTag(pausing, '继续执行'), 'resume must not appear while pausing');
  const pausingTag = buttonTag(pausing, '暂停处理中');
  assert.ok(pausingTag && /\sdisabled(?:=|\s|>)/.test(pausingTag), 'pausing state must disable repeat run control');
  // 已暂停：继续（只恢复不提交草稿），旧发送待核对不影响继续呈现
  const paused = renderComposer({ run: aRun('paused'), draft: 'kept text', unknownSendText: 'kept text' });
  assert.ok(buttonTag(paused, '继续执行'), 'pause state must offer explicit resume');
  assert.ok(!buttonTag(paused, '暂停'), 'pause state must not show pause');
  // 尚无已确认运行状态：同次未知→待核对，同次在途→发送中
  const checking = renderComposer({ run: aRun('ready'), draft: 'ghost text', unknownSendText: 'ghost text' });
  const checkingTag = buttonTag(checking, '待核对');
  assert.ok(checkingTag && /\sdisabled(?:=|\s|>)/.test(checkingTag), 'unknown receipt must show checking, not a new send');
  const sendingPending = renderComposer({ run: aRun('ready'), draft: 'ghost text', pendingSendText: 'ghost text' });
  const sendingTag = buttonTag(sendingPending, '发送中');
  assert.ok(sendingTag && /\sdisabled(?:=|\s|>)/.test(sendingTag), 'in-flight old send must show sending, not duplicate send');
  // 输入选项菜单为次级入口（C03）
  assert.ok(buttonTag(runningWithText, '输入选项'), 'input options menu trigger must exist');
});
