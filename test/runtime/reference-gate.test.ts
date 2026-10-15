// C05 迟到结果门禁的受控反例（2026-10-11 只读复核 F5）：
//
// 反例全部**受控**——捕获/列出的返回由测试自己掌握，不用固定时长制造竞态：
//  · A→B：A 的在途结果回来时当前目标是 B，旧结果必须整段丢弃；
//  · A→B→A：回到同一归属**也**是新一代——只比归属标量会让 A 的旧结果复活；
//  · 卸载：组件已不存在时不再有任何回写；
//  · 重新挂载：严格模式的「挂载→卸载→挂载」不得让门禁永久失效（否则引用再也加不进去）。
//
// 「不添加／不恢复已移除项／不覆盖另一草稿」用受控草稿所有者直接断言落库结果：
// 判定与 ReferencePicker 的写法一致（只有 applied 才写），门禁判 stale 时三样都不发生。
// 本文件不启动窗口、不触碰文件系统。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createReferenceGate, runGated, scopeKeyOf } from '../../src/renderer/components/reference-gate.ts';

/** 测试自己掌握返回时机的在途调用：resolve/reject 都由测试显式触发，不依赖计时。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** 受控草稿唯一所有者：按草稿键存引用集合，remove 即用户移除。 */
function draftOwner(initial: Record<string, string[]>) {
  const drafts = new Map<string, string[]>(Object.entries(initial).map(([key, values]) => [key, [...values]]));
  return {
    drafts,
    add(key: string, locator: string) {
      const current = drafts.get(key) ?? [];
      if (current.includes(locator)) return;
      drafts.set(key, [...current, locator]);
    },
    remove(key: string, locator: string) {
      drafts.set(key, (drafts.get(key) ?? []).filter((value) => value !== locator));
    },
  };
}

/** 与 ReferencePicker 相同的写入判定：只有 applied 才落草稿，其余一律不动任何状态。 */
async function captureIntoDraft(
  gate: ReturnType<typeof createReferenceGate>,
  draftKey: string,
  owner: ReturnType<typeof draftOwner>,
  call: () => Promise<{ locator: string }>,
): Promise<string> {
  const outcome = await runGated(gate, call);
  if (outcome.status === "applied") owner.add(draftKey, outcome.value.locator);
  return outcome.status;
}

await test('归属未变时结果照常落草稿：门控不误伤正常引用', async () => {
  const gate = createReferenceGate('s:A');
  const owner = draftOwner({ A: [] });
  const pending = deferred<{ locator: string }>();
  const inFlight = captureIntoDraft(gate, 'A', owner, () => pending.promise);
  pending.resolve({ locator: 'r0/src/greet.js' });
  assert.equal(await inFlight, 'applied');
  assert.deepEqual(owner.drafts.get('A'), ['r0/src/greet.js']);
});

await test('A→B：A 的迟到结果不添加、不落到 B，也不留在 A', async () => {
  const gate = createReferenceGate('s:A');
  const owner = draftOwner({ A: [], B: [] });
  const pending = deferred<{ locator: string }>();
  const inFlight = captureIntoDraft(gate, 'A', owner, () => pending.promise);
  // 捕获挂起期间用户切到 B，并在 B 里改了草稿
  gate.advance('s:B');
  pending.resolve({ locator: 'r0/src/greet.js' });
  assert.equal(await inFlight, 'stale');
  assert.deepEqual(owner.drafts.get('A'), [], '旧结果不得落进原归属');
  assert.deepEqual(owner.drafts.get('B'), [], '旧结果不得覆盖当前目标的草稿');
});

await test('A→B→A：回到同一归属仍是新一代，A 的旧结果不复活', async () => {
  const gate = createReferenceGate('s:A');
  const owner = draftOwner({ A: ['r0/keep.js'] });
  const pending = deferred<{ locator: string }>();
  const inFlight = captureIntoDraft(gate, 'A', owner, () => pending.promise);
  gate.advance('s:B');
  gate.advance('s:A');
  assert.equal(gate.current(), 's:A', '归属确实回到了 A');
  pending.resolve({ locator: 'r0/src/greet.js' });
  assert.equal(await inFlight, 'stale', '只比归属标量会误判为当前——这正是要反例掉的行为');
  assert.deepEqual(owner.drafts.get('A'), ['r0/keep.js'], '不得新增，也不得恢复用户已移除的项');
});

await test('A→B→A 且期间移除了同一项：迟到结果不得把它恢复回来', async () => {
  const gate = createReferenceGate('s:A');
  // A 的草稿里本来就有这一项（此前已添加），用户随后移除它
  const owner = draftOwner({ A: ['r0/src/greet.js'], B: [] });
  const pending = deferred<{ locator: string }>();
  const inFlight = captureIntoDraft(gate, 'A', owner, () => pending.promise);
  owner.remove('A', 'r0/src/greet.js');
  // 捕获挂起期间切走再切回同一归属
  gate.advance('s:B');
  gate.advance('s:A');
  pending.resolve({ locator: 'r0/src/greet.js' });
  assert.equal(await inFlight, 'stale');
  assert.deepEqual(owner.drafts.get('A'), [], '用户移除后不得被挂起中的旧结果恢复');
  assert.deepEqual(owner.drafts.get('B'), [], '也不得落到另一份草稿上');
});

await test('卸载：组件不存在后不再有任何回写', async () => {
  const gate = createReferenceGate('s:A');
  const owner = draftOwner({ A: [] });
  const pending = deferred<{ locator: string }>();
  const inFlight = captureIntoDraft(gate, 'A', owner, () => pending.promise);
  gate.dispose();
  pending.resolve({ locator: 'r0/src/greet.js' });
  assert.equal(await inFlight, 'stale');
  assert.deepEqual(owner.drafts.get('A'), []);
  assert.equal(gate.isMounted(), false);
});

await test('严格模式的挂载→卸载→挂载后门禁仍可用', async () => {
  const gate = createReferenceGate('s:A');
  const owner = draftOwner({ A: [] });
  gate.mount();
  gate.dispose();
  gate.mount();
  assert.equal(gate.isMounted(), true);
  const pending = deferred<{ locator: string }>();
  const inFlight = captureIntoDraft(gate, 'A', owner, () => pending.promise);
  pending.resolve({ locator: 'r0/src/greet.js' });
  assert.equal(await inFlight, 'applied', '重新挂载后引用必须还能加得进去');
  assert.deepEqual(owner.drafts.get('A'), ['r0/src/greet.js']);
});

await test('失败也受门控：目标已换时不透出旧目标的失败原因', async () => {
  const gate = createReferenceGate('s:A');
  const pending = deferred<{ locator: string }>();
  const inFlight = runGated(gate, () => pending.promise);
  gate.advance('s:B');
  pending.reject(new Error('permission-denied'));
  assert.equal((await inFlight).status, 'stale', '旧目标的失败不得当成当前目标的错误呈现');

  const gate2 = createReferenceGate('s:A');
  const failed = await runGated(gate2, () => Promise.reject(new Error('permission-denied')));
  assert.deepEqual(failed, { status: 'failed', message: 'permission-denied' }, '目标未换时失败原因照实透出');
});

await test('同一归属内的重复 advance 是空操作，不误伤在途结果', async () => {
  const gate = createReferenceGate('s:A');
  const owner = draftOwner({ A: [] });
  const pending = deferred<{ locator: string }>();
  const inFlight = captureIntoDraft(gate, 'A', owner, () => pending.promise);
  gate.advance('s:A');
  pending.resolve({ locator: 'r0/src/greet.js' });
  assert.equal(await inFlight, 'applied');
  assert.deepEqual(owner.drafts.get('A'), ['r0/src/greet.js']);
});

await test('归属身份：会话优先，其次草稿任务，无归属为 null', () => {
  assert.equal(scopeKeyOf({ sessionId: 's1' }), 's:s1');
  assert.equal(scopeKeyOf({ taskId: 't1' }), 't:t1');
  assert.equal(scopeKeyOf({ sessionId: 's1', taskId: 't1' }), 's:s1');
  assert.equal(scopeKeyOf(null), null);
  assert.equal(scopeKeyOf(undefined), null);
  assert.notEqual(scopeKeyOf({ taskId: 't1' }), scopeKeyOf({ sessionId: 't1' }), '会话与草稿任务不得互相顶替');
});
