// D 片请求边界的应用层反例：
// 1) 发送前消费**正式路由判定**：已知全部耗尽／没有适合候选时保留工作、不提交；
// 2) 「等待明确继续」是提交门上的事实：额度恢复与改选都不解除，只有明确继续才解除；
// 3) 端口不具备按会话换模型的能力时不静默回落旧配置；
// 4) 会话累计不随"较小的旧视图"回落：逐次记录才是唯一事实；
// 5) 默认模型保存走既有在途协调：关闭收束不会用旧快照覆盖它。
// 全部内存替身：不启动窗口、不触碰真实账户或凭据。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStorage } from '../../src/adapters/storage/index.ts';
import { DCodeApplication } from '../../src/application/index.ts';
import { sampleState } from '../../src/adapters/mock/index.ts';
import type { QuotaFacts, VerifiedModelCapabilities, WorkCapability, WorkReference } from '../../src/contracts/index.ts';
import { WORK_CAPABILITIES } from '../../src/contracts/index.ts';
import { withRequestAdmission } from '../../src/adapters/pi/index.ts';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import type { ExecutionPort, ExecutionView, PersistedState, StorageAdapter } from '../../src/application/types.ts';

await test('真实 SDK 准入拒绝不调用协议、不把准备身份记成实际物理请求', async () => {
  let starts = 0;
  const stream = withRequestAdmission(() => { starts += 1; return createAssistantMessageEventStream(); },
    { sessionId: 'owned', sourceId: 'planned-A', modelId: 'prepared-model' }, '', { admitRequest: async () => ({ ok: false, target: null, reason: 'controlled hold' }) });
  const events = [];
  for await (const event of stream) events.push(event);
  assert.equal(starts, 0);
  const error = events.find(event => event.type === 'error');
  assert.ok(error?.type === 'error');
  assert.equal(error.error.api, 'pi-virtual');
  assert.equal(error.error.provider, 'dcode-routing');
  assert.equal(error.error.model, 'unissued');
});

type Mode = 'available' | 'exhausted' | 'unknown';
type Supports = VerifiedModelCapabilities['supports'];

/** 逐项构造能力依据：没给出的项按"未核实"表达，不默认支持。 */
function supportsOf(input: Partial<Record<WorkCapability, boolean>>): Supports {
  const out = {} as VerifiedModelCapabilities['supports'] & Record<WorkCapability, unknown>;
  for (const cap of WORK_CAPABILITIES) {
    const value = input[cap];
    out[cap] = value === undefined
      ? { supported: false, evidence: 'none', reason: `夹具未给出 ${cap} 的依据` }
      : { supported: value, evidence: 'catalog', reason: null };
  }
  return out;
}

const CANDIDATE = { sourceId: 'dcode-test', modelId: 'fixture' };
/** 第二条候选：用于"打开窗口里改选到另一个来源"的场景。 */
const CANDIDATE_B = { sourceId: 'dcode-test-b', modelId: 'fixture-b' };

/**
 * 可控端口：记录提交次数；`applyModel: false` 造一个没有按会话换模型能力的端口。
 * 另外可造：首次提交失败（留下可重投的块）、提交前停泊（"裁决后打开端口"的窗口）、应用模型抛错。
 */
function makePort(options: { applyModel?: boolean; failFirstSubmit?: boolean; applyThrows?: boolean; lookup?: 'accepted' | 'not-found' } = {}) {
  const control = { instanceId: 'gate-fixture', revision: 0 };
  const state = {
    submits: 0, observation: 0, phase: 'ready' as 'ready' | 'paused' | 'running', failedOnce: false, enteredSubmit: false,
    /** 每次按会话应用模型的真实下发次数：用来核对关闭收束之后还有没有再下发 */
    applies: 0,
  };
  let hold: { promise: Promise<void>; release: () => void } | null = null;
  /** 真实请求事件里的助手条目：应用层只据此发布「实际采用」，不由夹具直接写状态 */
  let assistantEntries: ExecutionView['entries'] = [];
  const port = {
    target: { workspaceId: 'ws-home', taskId: 't', sessionId: 's' },
    async read() {
      state.observation += 1;
      return {
        target: this.target, control, observation: state.observation, phase: state.phase,
        execution: 'mock' as const, model: null, entries: assistantEntries, pendingInputs: 0,
      };
    },
    async submit() {
      state.enteredSubmit = true;
      const gate = hold;
      if (gate) await gate.promise;
      state.submits += 1;
      if (options.failFirstSubmit && !state.failedOnce) {
        state.failedOnce = true;
        // 明确未接收：留下带发送身份的用户块，才能走真实 retrySend
        return { status: 'not-accepted' as const, operationId: 'op', reason: 'paused' as const };
      }
      return { status: 'accepted' as const, operationId: 'op', submissionId: state.submits, processing: 'queued' as const };
    },
    async lookupReceipt() {
      // 默认恒为已接收（用于"已接收的事实不倒改"这类用例）；
      // 切到 not-found 时，每次查回都给可靠未找到，重投就会真的重新投递。
      if (options.lookup === 'not-found') {
        return { status: 'not-accepted' as const, operationId: 'op', reason: 'not-found' as const };
      }
      return { status: 'accepted' as const, operationId: 'op', submissionId: 1, processing: 'queued' as const };
    },
    async pause() { state.phase = 'paused'; return this.read(); },
    async resume() { state.phase = 'ready'; return this.read(); },
    async close() {},
    ...(options.applyModel === false ? {} : {
      async applySessionModel() {
        state.applies += 1;
        if (options.applyThrows === true) throw new Error('apply-session-model-failed');
        /* 接受应用 */
      },
    }),
  } as ExecutionPort;
  return {
    port,
    state,
    submits: () => state.submits,
    applies: () => state.applies,
    /** 发布一条真实助手条目（provider/model/responseId 齐全），应用层据此认定「实际采用」 */
    publishAssistant: (provider: string, model: string, responseId: string) => {
      assistantEntries = [{
        id: assistantEntries.length + 1,
        kind: 'pi.assistant' as const,
        data: {},
        assistantText: '答复',
        provider,
        model,
        responseId,
      }];
    },
    holdSubmits: () => {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => { release = resolve; });
      hold = { promise, release };
    },
    releaseSubmits: () => { const gate = hold; hold = null; gate?.release(); },
    submitsPending: () => hold !== null,
    submitEntered: () => state.enteredSubmit,
  };
}

/**
 * FIFO 可控存储：每次 save 都**真实入队并各自带一个完成信号**，按到达顺序逐个放行。
 *
 * 不把多次 save 合成一个 promise——那样看不出"哪次写入到了、哪次没完成"。
 * 三类证据都取自这里：`arrived`（写入确实到达，带真实入参）、`done`（该次写盘是否已完成）、
 * `completedOrder`（完成顺序是否等于到达顺序，即真的排队而不是各写各的）。
 */
class QueueStorage implements StorageAdapter {
  /** 每次 save 的到达记录：入参原样保留，完成状态由放行决定 */
  readonly arrived: { state: PersistedState; done: boolean }[] = [];
  readonly completedOrder: number[] = [];
  private hold = false;
  private queue: { index: number; release: () => void }[] = [];

  load(): Promise<{ status: 'missing' }> { return Promise.resolve({ status: 'missing' }); }

  save(next: PersistedState): Promise<void> {
    const index = this.arrived.length;
    this.arrived.push({ state: next, done: false });
    if (!this.hold) {
      this.settled(index);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => { this.queue.push({ index, release: resolve }); });
  }

  private settled(index: number): void {
    const entry = this.arrived[index];
    if (!entry || entry.done) return;
    entry.done = true;
    this.completedOrder.push(index);
  }

  /** 之后的写盘都排队等待 releaseNext()，不再自动完成。 */
  holdAll(): void { this.hold = true; }
  /** 放行当前排队的全部写盘（仍按到达顺序逐个放行）。 */
  releaseAll(): void {
    while (this.queue.length > 0) this.releaseNext();
  }
  /** 放行队首那次写盘（真实 FIFO：只放行最早的）。 */
  releaseNext(): void {
    const head = this.queue.shift();
    if (!head) throw new Error('no-held-save');
    this.settled(head.index);
    head.release();
  }
  /** 已到达但尚未完成的写盘数量。 */
  get pending(): number { return this.arrived.filter((a) => !a.done).length; }
}

async function harness(options: {
  applyModel?: boolean;
  /** 能力读取闸：制造"默认选择校验期间"的真实 await 窗口 */
  gateCapabilityReads?: boolean;
  storage?: StorageAdapter;
  failFirstSubmit?: boolean;
  applyThrows?: boolean;
  lookup?: 'accepted' | 'not-found';
  /** 初始空名单必须来自 load，不以配置后清空冒充旧单模型兼容入口。 */
  configureCandidates?: boolean;
  typedConfigured?: boolean;
} = {}) {
  let quotaState: Mode = 'available';
  /** 逐候选额度：给出后压过整盘状态（造混合事实） */
  let quotaByIdentity: ((c: { sourceId: string; modelId: string }) => Mode) | null = null;
  // 额度读取闸：用于制造真实的 await 窗口（裁决在途改选）
  let quotaGate: { promise: Promise<void>; release: () => void } | null = null;
  let quotaPending = false;
  let capabilityGate: { promise: Promise<void>; release: () => void } | null = null;
  /** 一次性闸：只挡住**接下来那一次**目录/能力读取，之后自动放行。
   *  用来造"A 停在真实读取、B 完全不受影响"的交错（普通闸会把 A、B 一起挡住）。 */
  let oneShotCapabilityGate: Promise<void> | null = null;
  let capabilityReadsPending = 0;
  /** 取本次要等的闸：常驻闸优先；否则消耗一次性闸（只用一次）。 */
  const takeCapabilityGate = async (): Promise<void> => {
    if (capabilityGate) {
      capabilityReadsPending += 1;
      await capabilityGate.promise;
      capabilityReadsPending -= 1;
      return;
    }
    if (oneShotCapabilityGate !== null) {
      const gate = oneShotCapabilityGate;
      oneShotCapabilityGate = null;
      capabilityReadsPending += 1;
      await gate;
      capabilityReadsPending -= 1;
    }
  };
  const capabilityEntered = { count: 0 };
  // 夹具默认逐项都有依据：样例时间线里确实有工具块，工作会据此提出 tool-use 要求
  let supports: Supports = supportsOf({
    'code-edit': true, 'tool-use': true, 'image-input': true, 'long-context': true, reasoning: true,
  });
  const { port, state, holdSubmits, releaseSubmits, submitsPending, submitEntered, applies, publishAssistant } = makePort({
    applyModel: options.applyModel,
    failFirstSubmit: options.failFirstSubmit,
    applyThrows: options.applyThrows,
    lookup: options.lookup,
  });
  let stored: PersistedState = sampleState();
  const storage: StorageAdapter = options.storage ?? {
    load: async () => ({ status: 'missing' as const }),
    save: async (next: PersistedState) => { stored = next; },
  };
  let openGate: { promise: Promise<void>; release: () => void } | null = null;
  let openEntered = false;
  const app = new DCodeApplication(
    {
      kind: 'pi',
      modelName: 'controlled',
      async open() {
        const gate = openGate;
        if (gate) {
          openEntered = true;
          await gate.promise;
          openGate = null;
        }
        return port;
      },
    },
    storage,
    () => stored,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      sourcePort: {
        hasTypedModel: async () => options.typedConfigured === true,
        list: async () => {
          capabilityEntered.count += 1;
          await takeCapabilityGate();
          return [
          {
            sourceId: CANDIDATE.sourceId,
            sourceLabel: '受控来源',
            configured: true,
            models: [{ modelId: CANDIDATE.modelId, modelLabel: 'fixture' }],
          },
          {
            sourceId: CANDIDATE_B.sourceId,
            sourceLabel: '受控来源 B',
            configured: true,
            models: [{ modelId: CANDIDATE_B.modelId, modelLabel: 'fixture-b' }],
          },
          ];
        },
      },
      allowlist: () => true,
      capabilityPort: {
        read: async ({ sourceId, modelId }: { sourceId: string; modelId: string }) => {
          capabilityEntered.count += 1;
          await takeCapabilityGate();
          return ({
          identity: { sourceId, modelId, sourceLabel: sourceId, modelLabel: modelId, accountLabel: null },
          supports,
          contextWindow: 32768,
          maxTokens: 1024,
          input: ['text'],
          thinkingLevels: [],
          thinkingNote: null,
        });
        },
      },
      quotaPort: {
        support: () => ({}),
        read: async ({ candidates }: { candidates: readonly { sourceId: string; modelId: string }[] }) => {
          const gate = quotaGate;
          if (gate) {
            quotaPending = true;
            await gate.promise;
            quotaPending = false;
          }
          return candidates.map((c) => ({
            sourceId: c.sourceId,
            modelId: c.modelId,
            // 逐候选额度：造出「A 已耗尽、B 可用」这种混合事实，而不是整盘一个状态
            state: quotaByIdentity ? quotaByIdentity(c) : quotaState,
            // 逐来源各自的额度池：两个来源是两条身份，不共享同一池
            poolId: `pool-${c.sourceId}`,
            windowLabel: '每分钟请求',
            updatedAt: (quotaByIdentity ? quotaByIdentity(c) : quotaState) === 'unknown' ? null : 1,
            reason: (quotaByIdentity ? quotaByIdentity(c) : quotaState) === 'unknown' ? '尚未读到真实响应' : null,
          } as QuotaFacts));
        },
      },
    },
  );
  await app.init();
  if (options.configureCandidates !== false) await app.updateSettings({ modelCandidates: [CANDIDATE, CANDIDATE_B] });
  return {
    app,
    submits: () => state.submits,
    applies,
    publishAssistant,
    holdSubmits,
    releaseSubmits,
    submitsPending,
    submitEntered,
    holdOpen: () => {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => { release = resolve; });
      openGate = { promise, release };
    },
    releaseOpen: () => { const gate = openGate; gate?.release(); },
    openEntered: () => openEntered,
    holdCapabilityReads: () => {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => { release = resolve; });
      capabilityGate = { promise, release };
    },
    releaseCapabilityReads: () => { const gate = capabilityGate; capabilityGate = null; gate?.release(); },
    capabilityReads: () => capabilityEntered.count,
    /** 一次性闸：只挡住下一次目录/能力读取，之后放行；releaseNextCapabilityRead 放行它。 */
    holdNextCapabilityRead: () => {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => { release = resolve; });
      oneShotCapabilityGate = promise;
      return () => release();
    },
    capabilityReadsPending: () => capabilityReadsPending,
    setQuota: (mode: Mode) => { quotaState = mode; },
    /** 逐候选额度：A 耗尽、B 可用这类混合事实 */
    setQuotaByIdentity: (fn: ((c: { sourceId: string; modelId: string }) => Mode) | null) => { quotaByIdentity = fn; },
    holdQuotaReads: () => {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => { release = resolve; });
      quotaGate = { promise, release };
    },
    releaseQuotaReads: () => {
      quotaGate?.release();
      quotaGate = null;
    },
    quotaReadsPending: () => quotaPending,
    setCapabilities: (next: Supports) => { supports = next; },
  };
}

const firstSession = async (app: DCodeApplication): Promise<string> =>
  (await app.getSnapshot()).sessions[0]!.id;

for(const operation of ['classify','generateImages'] as const) await test(`${operation}准入精确保留typed身份，额度未知有界、耗尽等待及关闭后的迟到读取拒绝`, async t => {
  const h = await harness({ typedConfigured: true }); t.after(() => h.app.flush());
  const sessionId = await firstSession(h.app);
  const request = { sessionId, sourceId: 'configured-classifier', modelId: 'typed-model', operation };
  const before = (await h.app.getSnapshot()).sessionModels[sessionId];
  h.setQuota('unknown');
  const allowed = await h.app.admitSdkRequest(request);
  assert.deepEqual(allowed.target, { sourceId: request.sourceId, modelId: request.modelId, thinkingLevel: null });
  assert.equal(allowed.ok, true);
  assert.deepEqual((await h.app.getSnapshot()).sessionModels[sessionId]?.choice, before?.choice);
  h.setQuota('exhausted'); assert.equal((await h.app.admitSdkRequest(request)).ok, false);
  h.setQuota('available'); assert.equal((await h.app.admitSdkRequest(request)).ok, false, '恢复额度不隐式继续');
  assert.equal(h.submits(), 0, '分类准入不能重投原输入');
  const second = await harness({ typedConfigured: true }); t.after(() => second.app.flush());
  const other = { ...request, sessionId: await firstSession(second.app) };
  second.holdQuotaReads(); const pending = second.app.admitSdkRequest(other);
  await waitFor(() => second.quotaReadsPending(), '分类应真实停在额度读取');
  second.app.beginClosing(); second.releaseQuotaReads(); assert.equal((await pending).ok, false);
  const missing = await harness(); t.after(() => missing.app.flush());
  assert.equal((await missing.app.admitSdkRequest({ ...request, sessionId: await firstSession(missing.app) })).ok, false, '无typed资料不凭chat能力放行');
});

/** 会话所在工作空间：引用归属必须与发送目标自洽，不能写死别的空间。 */
const workspaceOf = async (app: DCodeApplication, sessionId: string): Promise<string> => {
  const snap = await app.getSnapshot();
  const session = snap.sessions.find((x) => x.id === sessionId)!;
  return snap.tasks.find((t) => t.id === session.taskId)!.workspaceId;
};

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 最后一条用户块：样例时间线里已有历史块，重试身份要取**本次发送**产生的那一条。 */
const firstUserBlock = (snap: Awaited<ReturnType<DCodeApplication['getSnapshot']>>, sessionId: string) =>
  [...(snap.timelines[sessionId] ?? [])].reverse().find((b) => b.kind === 'message' && b.role === 'user') as
    | { kind: 'message'; role: 'user'; id: string; receipt?: { status: string; reason?: string } }
    | undefined;

const firstUserBlockId = (snap: Awaited<ReturnType<DCodeApplication['getSnapshot']>>, sessionId: string): string => {
  const block = firstUserBlock(snap, sessionId);
  assert.ok(block, '应存在用户块');
  return block!.id;
};

const reasonOf = (receipt: Awaited<ReturnType<DCodeApplication['sendMessage']>>['receipt']): string | undefined =>
  receipt.status === 'not-accepted' ? receipt.reason : undefined;

await test('提交门消费正式路由：候选已知全部耗尽时保留工作、不提交', async (t) => {
  const h = await harness();
  t.after(() => h.app.flush());
  const sessionId = await firstSession(h.app);
  h.setQuota('exhausted');

  const blocked = await h.app.sendMessage({ sessionId, text: '在耗尽期间发送', mode: 'follow-up' });
  assert.equal(blocked.receipt.status, 'not-accepted');
  assert.equal(reasonOf(blocked.receipt), 'model-unavailable', '保留工作并如实说明是模型条件不成立');
  assert.equal(h.submits(), 0, '条件不成立时不得向执行端提交');

  // 额度恢复不自动解除等待
  h.setQuota('available');
  const afterRecovery = await h.app.resolveSessionRouting({ sessionId });
  // 额度恢复只让额度事实变可用；「等待明确继续」仍在，因此判定保持等待而不是直接采用
  assert.equal(afterRecovery.lastRouting?.decision.kind, 'hold-work-not-runnable', '额度恢复不自动解除等待明确继续');
  assert.equal(afterRecovery.waitingExplicitContinue, true, '额度恢复不是用户的明确继续');
  assert.equal(
    afterRecovery.lastRouting?.quota.some((q) => q.state === 'available'),
    true,
    '额度事实本身已恢复为可用',
  );
  const stillBlocked = await h.app.sendMessage({ sessionId, text: '恢复后再发一次', mode: 'follow-up' });
  assert.equal(stillBlocked.receipt.status, 'not-accepted', '等待明确继续期间仍不提交');
  assert.equal(h.submits(), 0);

  // 用户明确继续之后才真提交
  await h.app.resumeRun({ sessionId });
  const admitted = await h.app.sendMessage({ sessionId, text: '明确继续后发送', mode: 'follow-up' });
  assert.equal(admitted.receipt.status, 'accepted', '明确继续后条件成立，应当提交');
  assert.equal(h.submits(), 1, '本次请求真的到了执行端');
});

await test('没有适合候选时保留工作：不静默换一个模型把请求发出去', async (t) => {
  const h = await harness();
  t.after(() => h.app.flush());
  const sessionId = await firstSession(h.app);
  // 本次输入带文件引用 → 工作确实提出 code-edit；把该能力设为不满足
  h.setCapabilities(supportsOf({
    'code-edit': false, 'tool-use': true, 'image-input': true, 'long-context': true, reasoning: true,
  }));
  const reference: WorkReference = {
    refId: 'ref-1',
    kind: 'file',
    label: 'a.ts',
    locator: 'a.ts',
    sourceId: `workspace:${await workspaceOf(h.app, sessionId)}`,
    snapshot: { contentHash: 'a'.repeat(64), byteSize: 12, capturedAt: 1, truncated: false, content: 'x' },
  };
  const blocked = await h.app.sendMessage({ sessionId, text: '改这个文件', mode: 'follow-up', references: [reference] });
  assert.equal(blocked.receipt.status, 'not-accepted', '没有适合候选时保留工作');
  assert.equal(reasonOf(blocked.receipt), 'model-unavailable');
  assert.equal(h.submits(), 0, '不得擅自换一个模型把请求发出去');
  // 用**同样的引用**重新判定：能力要求来自本次工作，判定必须仍然是保留工作
  const state = await h.app.resolveSessionRouting({ sessionId, references: [reference] });
  assert.equal(state.lastRouting?.decision.kind, 'hold-no-capable-candidate', '带着同样的文件引用时不得改判为可用');
  assert.equal(h.submits(), 0, '重新判定本身也不发请求');
});

await test('必需能力资料未核实：不把未核实当已核实发出去；有匹配依据才真提交', async (t) => {
  const h = await harness();
  t.after(() => h.app.flush());
  const sessionId = await firstSession(h.app);
  const sourceId = `workspace:${await workspaceOf(h.app, sessionId)}`;
  // 本次输入带**图片**引用 → 工作确实提出 image-input；该能力对这条来源**未核实**（夹具未给出依据）。
  // 额度已确认可用：额度好也不能替代能力依据。
  h.setCapabilities(supportsOf({
    'code-edit': true, 'tool-use': true, 'long-context': true, reasoning: true,
  }));
  const reference: WorkReference = {
    refId: 'ref-img',
    kind: 'file',
    label: 'shot.png',
    locator: 'shot.png',
    sourceId,
    snapshot: { contentHash: 'b'.repeat(64), byteSize: 20, capturedAt: 1, truncated: false, content: 'x' },
  };
  const blocked = await h.app.sendMessage({ sessionId, text: '看这张图', mode: 'follow-up', references: [reference] });
  assert.equal(blocked.receipt.status, 'not-accepted', '缺核实依据时保留工作，不当作已确认能做');
  assert.equal(reasonOf(blocked.receipt), 'model-unavailable');
  assert.equal(h.submits(), 0, '未核实的能力不得推出可执行：实际提交必须是 0');

  // 公开判定也要给同样的结论，并如实说明缺的是哪一项依据
  const state = await h.app.resolveSessionRouting({ sessionId, references: [reference] });
  assert.equal(state.lastRouting?.decision.kind, 'hold-no-capable-candidate', `实得 ${state.lastRouting?.decision.kind}`);
  assert.match(
    state.lastRouting?.attempts.find((a) => a.modelId === CANDIDATE.modelId)?.reason ?? '',
    /未核实/,
    '要写明缺的是 image-input 的核实依据',
  );
  assert.equal(
    state.lastRouting?.attempts.some((a) => a.outcome === 'attempted-unverified-capability'),
    false,
    '未核实能力不产出有界尝试的执行授权',
  );
  assert.equal(h.submits(), 0, '重新判定本身也不发请求');

  // 合法对照：同一来源给出 image-input 的匹配依据后，同样的输入才真的提交
  h.setCapabilities(supportsOf({
    'code-edit': true, 'tool-use': true, 'image-input': true, 'long-context': true, reasoning: true,
  }));
  const accepted = await h.app.sendMessage({ sessionId, text: '看这张图（有依据）', mode: 'follow-up', references: [reference] });
  assert.equal(accepted.receipt.status, 'accepted', `实得 ${accepted.receipt.status} / ${reasonOf(accepted.receipt)}`);
  assert.equal(h.submits(), 1, '有匹配依据时请求真的到达执行端');
});

await test('端口不具备按会话换模型的能力时不静默回落旧配置', async (t) => {
  const h = await harness({ applyModel: false });
  t.after(() => h.app.flush());
  const sessionId = await firstSession(h.app);
  const blocked = await h.app.sendMessage({ sessionId, text: '端口不支持按会话换模型', mode: 'follow-up' });
  assert.equal(blocked.receipt.status, 'not-accepted');
  assert.equal(reasonOf(blocked.receipt), 'model-unavailable');
  assert.equal(h.submits(), 0, '不能带着与用户选择不符的旧配置把请求发出去');
});

await test('默认模型保存走既有在途协调：关闭收束等的是这次写入，不是旧快照', async (t) => {
  const storage = new QueueStorage();
  const h = await harness({ storage });
  t.after(() => h.app.flush());
  const sessionId = await firstSession(h.app);
  await h.app.sendMessage({ sessionId, text: '先发一次让会话存在', mode: 'follow-up' });
  const arrivedBefore = storage.arrived.length;

  // 默认改为显式指定来源：这次写盘真实到达但**不完成**（模拟"B 保存尚未落地"）
  storage.holdAll();
  const pending = h.app.setDefaultModelChoice({
    choice: { mode: 'explicit', sourceId: CANDIDATE.sourceId, modelId: CANDIDATE.modelId },
  });
  const settled = pending.then(() => 'ok' as const, () => 'failed' as const);
  // 证据①：写入确实到达存储，且带的是这次要保存的默认值（不是入队前的旧快照）。
  // 保存经在途协调异步落盘，这里等它**真的到达**再断言，不靠闸门预设。
  const deadline = Date.now() + 5000;
  while (storage.arrived.length <= arrivedBefore && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const arrived = storage.arrived.slice(arrivedBefore);
  assert.ok(arrived.length >= 1, '默认保存确实写到了存储');
  assert.equal(
    arrived[0].state.settings.newSessionModelChoice.mode,
    'explicit',
    '到达存储的应是这次的新默认值',
  );
  assert.equal(storage.pending, 1, '到达的这次写盘尚未完成');

  // 证据②：关闭收束在这次写入完成前**没有**真的完成（不是靠闸门预设）
  let flushDone = false;
  const flush = h.app.flush().then(() => { flushDone = true; });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(flushDone, false, '写盘未完成前关闭收束不得报完成');
  assert.equal(storage.pending, 1, '收束期间这次写入仍在排队');

  // 放行：每次都只放行队首（真的排队）。关闭收束本身还会再写一次盘，
  // 它同样在队列里——逐个放行直到收束真的成立，而不是一次性放开闸门。
  let flushed = false;
  const flushPromise = flush.then(() => { flushed = true; });
  for (let i = 0; i < 50 && !flushed; i += 1) {
    storage.releaseAll();
    await new Promise((r) => setTimeout(r, 10));
  }
  await flushPromise;
  assert.equal(flushed, true, '在途写入全部完成后关闭收束才成立');
  assert.equal(await settled, 'ok', '保存成立后回执为成功');
  assert.deepEqual(
    storage.completedOrder,
    storage.arrived.map((_, i) => i),
    '写盘必须按到达顺序完成（FIFO），不能后来的先完成',
  );

  const snapshot = await h.app.getSnapshot();
  assert.equal(snapshot.settings.newSessionModelChoice.mode, 'explicit', '发布的是保存成立后的默认值');
  const persistedDefault = storage.arrived.at(-1)?.state.settings.newSessionModelChoice;
  assert.equal(persistedDefault?.mode, 'explicit', '最后一次落盘也必须是新默认值，不得被旧快照覆盖');
});

/**
 * 反例：默认选择的**校验**在途时关闭收束不得先完成。
 *
 * 校验要读来源目录与能力资料（有真实 await）。若在途保护登记在校验之后，
 * 收束会在校验挂起期间跑完并返回，随后校验结束又发起新写入——收束之后还在写。
 */
for (const endpoint of ['default', 'settings'] as const) await test(`默认选择校验在途（${endpoint}）：关闭收束必须等校验与写盘一起成立`, async (t) => {
  const h = await harness({ gateCapabilityReads: true });
  t.after(async () => { await h.app.flush(); });
  const sessionId = await firstSession(h.app);
  await h.app.sendMessage({ sessionId, text: '先跑一次', mode: 'follow-up' });

  h.holdCapabilityReads();
  const before = h.capabilityReads();
  const choice = { mode: 'explicit', sourceId: CANDIDATE.sourceId, modelId: CANDIDATE.modelId } as const;
  const pending = endpoint === 'default' ? h.app.setDefaultModelChoice({ choice })
    : h.app.updateSettings({ newSessionModelChoice: choice });
  // 等校验真的读到了来源目录（证明停在 await 窗口里，而不是还没开始）
  const deadline = Date.now() + 5000;
  while (h.capabilityReads() <= before && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.ok(h.capabilityReads() > before, '默认选择校验应已读取来源目录');

  let flushDone = false;
  const flush = h.app.flush().then(() => { flushDone = true; });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(flushDone, false, '校验在途时关闭收束不得报完成');

  h.releaseCapabilityReads();
  const [result] = await Promise.all([pending, flush]);
  if (endpoint === 'default') assert.ok('ok' in result && result.ok, `校验与写盘应一起成立（实得 ${JSON.stringify(result)}）`);
  else assert.ok('newSessionModelChoice' in result && result.newSessionModelChoice.mode === 'explicit');
  const snapshot = await h.app.getSnapshot();
  assert.equal(snapshot.settings.newSessionModelChoice.mode, 'explicit', '发布的是写盘成立后的默认值');
});

await test('已接收的同一输入：后来额度耗尽也不倒改接收事实，也不重复投递', async (t) => {
  const h = await harness();
  t.after(() => h.app.flush());
  const sessionId = await firstSession(h.app);
  const accepted = await h.app.sendMessage({ sessionId, text: '先正常发一次', mode: 'follow-up' });
  assert.equal(accepted.receipt.status, 'accepted', '第一次真实接收');
  const submitsAfterFirst = h.submits();
  const blockId = firstUserBlockId(await h.app.getSnapshot(), sessionId);

  // 之后条件失效（已知全部耗尽）：同一次发送身份的重投必须先查回、不得改报未接收
  h.setQuota('exhausted');
  const retried = await h.app.retrySend({ sessionId, blockId });
  assert.equal(retried.receipt.status, 'accepted', '已接收的事实不被后来的额度条件倒改');
  assert.equal(h.submits(), submitsAfterFirst, '查回后不得再次真实投递');

  const block = firstUserBlock(await h.app.getSnapshot(), sessionId);
  assert.equal(block?.receipt?.status, 'accepted', '时间线上的回执仍是已接收');
});

await test('裁决在途改选到不可用来源：旧结论释放后仍不提交', async (t) => {
  const h = await harness();
  t.after(() => h.app.flush());
  const sessionId = await firstSession(h.app);

  // 让额度读取挂住，给"裁决在途"一个真实 await 窗口
  h.holdQuotaReads();
  const inflight = h.app.sendMessage({ sessionId, text: '裁决在途', mode: 'follow-up' });
  await waitFor(() => h.quotaReadsPending(), '额度读取尚未到达');
  const chosen = await h.app.setSessionModelChoice({ sessionId, choice: { mode: 'explicit', sourceId: 'not-in-catalog', modelId: 'nope' } });
  assert.equal(chosen.choice.mode, 'explicit', '改选落下来了');
  assert.ok(chosen.invalidReason, '不在目录里的来源必须给出真实原因');
  h.releaseQuotaReads();
  const receipt = await inflight;
  assert.equal(receipt.receipt.status, 'not-accepted', '失效的裁决不能推出新的选择可执行');
  assert.equal(h.submits(), 0, '一次也不得提交');
});

/**
 * 反例：候选名单为空（自动模式）也不等于**无条件**放行。
 * 没有范围可判的是额度与能力；等待明确继续与认证在途与范围无关，任何范围下都要拦。
 */
await test('空名单的自动模式：认证在途仍然拦得住本次发送', async (t) => {
  const h = await harness({ configureCandidates: false });
  t.after(async () => { await h.app.flush(); });
  const sessionId = await firstSession(h.app);

  const release = h.app.enterAuthFlow('user-defined');
  const refused = await h.app.sendMessage({ sessionId, text: '空名单时的输入', mode: 'follow-up' });
  assert.equal(refused.receipt.status, 'not-accepted', '空名单不解除认证在途门控');
  assert.equal(h.submits(), 0, '一次也不得提交');
  release();

  // 门控解除后仍按原样投递（证明拦的是条件本身，不是把请求永久拒绝）
  const accepted = await h.app.sendMessage({ sessionId, text: '解除后重发', mode: 'follow-up' });
  assert.equal(accepted.receipt.status, 'accepted', `解除后应正常投递（实得 ${JSON.stringify(accepted.receipt)}）`);
});

/**
 * 反例：已经进入「等待明确继续」之后把名单清空，重投仍然被拒。
 * 空范围让额度与能力无从判起，等待明确继续与范围无关，不能因此被放过去。
 */
await test('等待明确继续期间清空名单：重投仍被拒', async (t) => {
  const h = await harness();
  t.after(async () => { await h.app.flush(); });
  const sessionId = await firstSession(h.app);

  h.setQuota('exhausted');
  const first = await h.app.sendMessage({ sessionId, text: '会进入等待的输入', mode: 'follow-up' });
  assert.equal(first.receipt.status, 'not-accepted', '前置：耗尽时不得投递');
  const waiting = await h.app.getSnapshot();
  assert.equal(waiting.sessionModels[sessionId]!.waitingExplicitContinue, true, '前置：应进入等待明确继续');

  // 把候选名单清空：此后自动模式没有范围可判
  await h.app.updateSettings({ modelCandidates: [] });
  const again = await h.app.sendMessage({ sessionId, text: '空名单下的重投', mode: 'follow-up' });
  assert.equal(again.receipt.status, 'not-accepted', '清空名单不得解除等待明确继续');
  assert.equal(h.submits(), 0, '一次也不得提交');
});

/**
 * 反例：裁决通过、端口正在打开时改选到**已耗尽**来源，本次不得提交。
 *
 * 窗口要停在 `ensurePort`（打开端口）上——提交已经进入执行端之后，任何条件变化都不能把它变回去；
 * 但"裁决已过、请求还没发出"这段等待里发生的变化，还没有消费过。
 */
await test('打开端口窗口里改选到已耗尽来源：本次不提交', async (t) => {
  const h = await harness();
  t.after(async () => { await h.app.flush(); });
  const sessionId = await firstSession(h.app);

  h.holdOpen();
  const inflight = h.app.sendMessage({ sessionId, text: '打开窗口里的输入', mode: 'follow-up' });
  const deadline = Date.now() + 5000;
  while (!h.openEntered() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.openEntered(), true, '应当真实停在"裁决已过、端口正在打开"的窗口里');

  // 窗口内改选到另一来源，并把条件变成该来源已知全部耗尽
  await h.app.setSessionModelChoice({ sessionId, choice: { mode: 'explicit', ...CANDIDATE_B } });
  h.setQuota('exhausted');
  h.releaseOpen();

  const result = await inflight;
  assert.equal(result.receipt.status, 'not-accepted', `窗口里目标已换成耗尽来源，本次不得投递（实得 ${JSON.stringify(result.receipt)}）`);
  assert.equal(h.submits(), 0, '一次也不得提交');
});

/**
 * 反例：恢复前权威应用模型失败时，保持暂停与用户的选择。
 * 已开 A / 已暂停 / 选到可用 B，但 apply 抛错 → 不得带着旧 A 恢复。
 */
await test('恢复前应用模型失败：保持暂停并保留这次选择', async (t) => {
  const h = await harness({ applyThrows: true });
  t.after(async () => { await h.app.flush(); });
  const sessionId = await firstSession(h.app);
  await h.app.sendMessage({ sessionId, text: '先跑一次', mode: 'follow-up' });
  await h.app.pauseRun({ sessionId });
  const chosen = await h.app.setSessionModelChoice({
    sessionId,
    choice: { mode: 'explicit', sourceId: CANDIDATE.sourceId, modelId: CANDIDATE.modelId },
  });
  assert.equal(chosen.choice.mode, 'explicit', '选择已落地');

  await h.app.resumeRun({ sessionId });
  const after = await h.app.getSnapshot();
  assert.equal(after.runs[sessionId]!.status, 'paused', '应用失败时不得恢复运行（否则会用旧模型跑）');
  assert.equal(after.sessionModels[sessionId]!.choice.mode, 'explicit', '用户的这次选择要保留');
  assert.equal(
    after.sessionModels[sessionId]!.waitingExplicitContinue,
    true,
    '应如实保留工作并说明原因，而不是假称已继续',
  );
});

/**
 * 反例：可靠 not-found 后的**同身份重投**必须真的走 retrySend，并消费完整裁决。
 * 夹具让 lookupReceipt 恒为可靠未找到，所以重投就是一次真实重新投递，不是查回挡住。
 */
await test('同身份 retrySend：条件不成立不重投，条件恢复后用同一发送身份重投成功', async (t) => {
  const h = await harness({ failFirstSubmit: true, lookup: 'not-found' });
  t.after(async () => { await h.app.flush(); });
  const sessionId = await firstSession(h.app);

  // 第一次提交明确未接收：留下带发送身份的用户块
  const first = await h.app.sendMessage({ sessionId, text: '可重投的输入', mode: 'follow-up' });
  assert.equal(first.receipt.status, 'not-accepted', '前置：第一次提交明确未接收');
  assert.equal(h.submits(), 1);
  const snapshot = await h.app.getSnapshot();
  // 取本次追加的那一块（时间线末位）：样例时间线里本来就有用户消息块，不能取第一个。
  // 回执为 not-accepted 才说明定位对了块。
  const userBlocks = (snapshot.timelines[sessionId] ?? []).filter(
    (b) => b.kind === 'message' && b.role === 'user',
  );
  const block = userBlocks.at(-1);
  assert.ok(block, '应有本次发送对应的用户块');
  const blockReceipt = (block as { receipt?: { status?: string } }).receipt;
  assert.equal(blockReceipt?.status, 'not-accepted', '该块应是第一次未接收的回执');
  const blockId = block.id;

  // 条件不成立：重投必须被拒，且一次也不得真的提交
  h.setQuota('exhausted');
  const refused = await h.app.retrySend({ sessionId, blockId });
  assert.equal(refused.receipt.status, 'not-accepted', '条件不成立时同身份重投必须被拒');
  assert.equal(h.submits(), 1, '被拒的重投不得真的提交');

  // 条件恢复：同一次发送身份重新投递成功
  // 额度恢复本身**不解除**等待明确继续：重投仍然不投（spec 已确认的接续方式 A）
  h.setQuota('available');
  const stillWaiting = await h.app.retrySend({ sessionId, blockId });
  assert.equal(stillWaiting.receipt.status, 'not-accepted', '额度恢复不得让重投自行续跑');
  assert.equal(h.submits(), 1, '等待明确继续期间一次也不得重投');

  // 用户明确继续之后：用**同一个发送身份**重投，这次才真的投递
  await h.app.resumeRun({ sessionId });
  const retried = await h.app.retrySend({ sessionId, blockId });
  assert.equal(retried.receipt.status, 'accepted', `明确继续后应重投成功（实得 ${JSON.stringify(retried.receipt)}）`);
  assert.equal(h.submits(), 2, '明确继续后这次才真的重投一次');
  assert.equal(retried.receipt.operationId, first.receipt.operationId, '重投保持同一次发送身份');
});

await test('对暂停工作明确继续：条件成立就真的恢复（暂停相位不否决自己的恢复）', async (t) => {
  const h = await harness();
  t.after(() => h.app.flush());
  const sessionId = await firstSession(h.app);
  await h.app.sendMessage({ sessionId, text: '先跑一次', mode: 'follow-up' });
  await h.app.pauseRun({ sessionId });
  const paused = await h.app.getSnapshot();
  assert.equal(paused.runs[sessionId]!.status, 'paused', '前置：工作确实已暂停');

  // 只读判定按**此刻**相位：暂停中就是不可推进（这仍是正确口径）
  const whilePaused = await h.app.resolveSessionRouting({ sessionId });
  assert.equal(whilePaused.lastRouting?.decision.kind, 'hold-work-not-runnable', '只读判定不得把暂停当成可推进');

  // 明确继续是用户对这次暂停的正式指令：条件成立时必须真的恢复
  await h.app.resumeRun({ sessionId });
  const resumed = await h.app.getSnapshot();
  assert.notEqual(resumed.runs[sessionId]!.status, 'paused', '条件成立的明确继续必须恢复运行');
  assert.equal(
    resumed.runs[sessionId]!.status === 'ready' || resumed.runs[sessionId]!.status === 'running',
    true,
    `恢复后应是可推进状态（实读：${resumed.runs[sessionId]!.status}）`,
  );
});

await test('暂停中且已知全部耗尽：明确继续不免除条件，可靠 not-found 重投也不穿透', async (t) => {
  const h = await harness();
  t.after(() => h.app.flush());
  const sessionId = await firstSession(h.app);
  await h.app.pauseRun({ sessionId });
  h.setQuota('exhausted');

  // 暂停中的明确继续：条件不成立就不恢复运行
  await h.app.resumeRun({ sessionId });
  const afterResume = await h.app.getSnapshot();
  assert.equal(afterResume.runs[sessionId]!.status, 'paused', '条件不成立时不得恢复运行');
  assert.equal(h.submits(), 0);

  // 新的输入在暂停中：不得被接收
  const receipt = await h.app.sendMessage({ sessionId, text: '暂停中发送', mode: 'follow-up' });
  assert.equal(receipt.receipt.status, 'not-accepted', '暂停中的输入不得被接收');
  assert.equal(h.submits(), 0);
});

/**
 * 反例 A：默认选择的校验停在真实目录读取，**普通设置保存 B 先完成**，关闭收束仍须等 A。
 *
 * B 与 A 是两次独立的保存认领。若在途保护是"当前那一个"，B 完成时会把 A 的保护一并清掉，
 * flush 就只看得到 B——A 还挂着就能报关闭完成，之后 A 再写一次盘。
 * 同时核对普通设置的旧合同：B 改主题仍然成立，不因与 A 重叠而被拒绝。
 */
await test('默认校验在途时普通设置先完成：收束仍等 A，释放 A 后不再新写', async (t) => {
  const storage = new QueueStorage();
  const h = await harness({ storage });
  t.after(async () => { await h.app.flush(); });

  h.holdCapabilityReads();
  const before = h.capabilityReads();
  const pendingA = h.app.setDefaultModelChoice({
    choice: { mode: 'explicit', sourceId: CANDIDATE.sourceId, modelId: CANDIDATE.modelId },
  });
  const deadline = Date.now() + 5000;
  while (h.capabilityReads() <= before && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.ok(h.capabilityReads() > before, 'A 的默认选择校验应已读到来源目录');
  assert.ok(h.capabilityReadsPending() > 0, 'A 应真的停在 await 窗口里');

  // B：普通主题保存，与 A 完全不相关，不读来源目录，因此会先完成
  const saved = await h.app.updateSettings({ theme: 'dark' });
  assert.equal(saved.theme, 'dark', '普通设置保存照常成立：不得因与默认校验重叠而拒绝旧主题合同');
  assert.equal(storage.arrived.filter((a) => a.state.settings.theme === 'dark').length, 1, 'B 的写盘确实到达');

  let flushDone = false;
  const flush = h.app.flush().then(() => { flushDone = true; });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(flushDone, false, 'A 仍未收束时关闭收束不得报完成（B 先完成不能顶掉 A 的在途保护）');

  h.releaseCapabilityReads();
  const [resultA] = await Promise.all([pendingA, flush]);
  assert.equal(resultA.ok, true, `A 的默认值应真的保存成立（实得 ${JSON.stringify(resultA)}）`);
  assert.equal(flushDone, true, 'A 收束后关闭收束才完成');
  const arrivedAtFlush = storage.arrived.length;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(storage.arrived.length, arrivedAtFlush, '关闭完成之后不得再开始新的写盘');
  const persisted = storage.arrived.at(-1)?.state.settings;
  assert.equal(persisted?.theme, 'dark', '最后落盘的普通设置仍在');
  assert.equal(persisted?.newSessionModelChoice.mode, 'explicit', 'A 的默认值也在同一份落盘里');
});

/**
 * 反例 B：第二个默认选择保存 B **先完成**，关闭收束仍须等先开始的 A。
 *
 * 这里的缺陷形状与 A 不同：先前认领者的释放函数能清掉"依赖它的聚合"——
 * 后来的 B 一完成就把聚合整条摘掉，A 的保护随之消失。
 */
await test('第二个默认保存先完成：先认领的 A 仍受保护，收束不得提前完成', async (t) => {
  const storage = new QueueStorage();
  const h = await harness({ storage });
  t.after(async () => { await h.app.flush(); });

  // 一次性闸：只挡 A 的这一次目录读取，B 完全不受影响，于是 B 必然先完成
  const releaseARead = h.holdNextCapabilityRead();
  const before = h.capabilityReads();
  const pendingA = h.app.setDefaultModelChoice({
    choice: { mode: 'explicit', sourceId: CANDIDATE.sourceId, modelId: CANDIDATE.modelId },
  });
  const deadline = Date.now() + 5000;
  while (h.capabilityReads() <= before && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.ok(h.capabilityReads() > before, 'A 应已读到来源目录');
  assert.ok(h.capabilityReadsPending() > 0, 'A 应真的停在 await 窗口里');

  const resultB = await h.app.setDefaultModelChoice({
    choice: { mode: 'explicit', sourceId: CANDIDATE_B.sourceId, modelId: CANDIDATE_B.modelId },
  });
  assert.equal(resultB.ok, true, 'B 这次默认保存应先成立');
  const persistedB = storage.arrived.map((a) => a.state.settings.newSessionModelChoice)
    .filter((c) => c.mode === 'explicit' && c.sourceId === CANDIDATE_B.sourceId);
  assert.equal(persistedB.length, 1, 'B 的写盘确实到达');

  let flushDone = false;
  const flush = h.app.flush().then(() => { flushDone = true; });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(flushDone, false, 'B 先完成不得把仍在进行的 A 从收束视野里清掉');

  releaseARead();
  const [resultA] = await Promise.all([pendingA, flush]);
  assert.equal(resultA.ok, true, `A 的默认值应真的保存成立（实得 ${JSON.stringify(resultA)}）`);
  assert.equal(flushDone, true, 'A 收束后关闭收束才完成');
  const arrivedAtFlush = storage.arrived.length;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(storage.arrived.length, arrivedAtFlush, '关闭完成之后不得再开始新的写盘');
});

/**
 * 反例 C：会话改选停在真实目录读取，关闭收束已经开始，释放后**不得再向端口下发**。
 *
 * 入口只核过一次 closing；目录 await 之后必须核关闭代次，否则关闭已收束还会再下发一次配置。
 */
await test('会话改选校验在途关闭：释放后不再下发模型配置', async (t) => {
  const h = await harness();
  t.after(async () => { await h.app.flush(); });
  const sessionId = await firstSession(h.app);
  const sent = await h.app.sendMessage({ sessionId, text: '先跑一次开端口', mode: 'follow-up' });
  assert.equal(sent.receipt.status, 'accepted', '端口已打开');
  const appliesBefore = h.applies();

  const releaseRead = h.holdNextCapabilityRead();
  const before = h.capabilityReads();
  const changing = h.app.setSessionModelChoice({
    sessionId,
    choice: { mode: 'explicit', sourceId: CANDIDATE_B.sourceId, modelId: CANDIDATE_B.modelId },
  });
  const deadline = Date.now() + 5000;
  while (h.capabilityReads() <= before && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.ok(h.capabilityReadsPending() > 0, '改选应真的停在目录读取的 await 窗口里');

  const flush = h.app.flush();
  await new Promise((r) => setTimeout(r, 20));
  releaseRead();
  // 改选本身仍如实返回选择状态（它已经落在注册表里），不抛"应用已关闭"给界面
  const state = await changing;
  assert.equal(state.choice.mode, 'explicit', '改选仍如实返回本次选择');
  await flush;
  assert.equal(h.applies(), appliesBefore, '关闭已开始后不得再向执行端口下发配置');
});

/**
 * 反例 D：每次 SDK 请求前消费**完整准入**。
 *
 * 走的是适配器里真实的那道准入门（`withRequestAdmission`）与应用层真实的裁定
 * （`app.admitSdkRequest`）：第一条请求放行并产出事件；上一响应之后额度变为已知耗尽，
 * 第二条请求（工具回合自己发起的下一次）**不得**真的发起——已输出保持。
 * 只证明「发送那一刻核过」的实现在这里一定会失败：它压根没有这道门。
 */
await test('每请求准入：上一响应后额度耗尽，下一工具回合不发起请求', async (t) => {
  const h = await harness();
  t.after(() => h.app.flush());
  const sessionId = await firstSession(h.app);
  const sent = await h.app.sendMessage({ sessionId, text: '跑一次', mode: 'follow-up' });
  assert.equal(sent.receipt.status, 'accepted', `前置发送应被接收（实得 ${sent.receipt.status}）`);

  let started = 0;
  const start = (text: string) => {
    started += 1;
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'text-delta', delta: text } as never);
    stream.end({ role: 'assistant', content: [], stopReason: 'stop' } as never);
    return stream;
  };
  const request = { sessionId, sourceId: CANDIDATE.sourceId, modelId: CANDIDATE.modelId };
  const gate = (r: typeof request) => h.app.admitSdkRequest(r);
  const collect = async (text: string): Promise<string> => {
    const out = withRequestAdmission(() => start(text), request, '', { admitRequest: gate });
    const deltas: string[] = [];
    let failure: string | null = null;
    for await (const event of out) {
      const e = event as { type?: string; delta?: string; error?: { errorMessage?: string } };
      if (e.type === 'text-delta' && typeof e.delta === 'string') deltas.push(e.delta);
      if (e.type === 'error') failure = e.error?.errorMessage ?? null;
    }
    return `${deltas.join('')}|${failure ?? ''}`;
  };

  const first = await collect('第一轮输出');
  assert.equal(started, 1, '条件成立时第一次请求真的发出去');
  assert.equal(first, '第一轮输出|', `已输出应保持（实得 ${first}）`);

  // 上一响应之后额度变为**已知耗尽**：下一次请求不再成立
  h.setQuota('exhausted');
  const second = await collect('第二轮输出');
  assert.equal(started, 1, `额度耗尽后不得再发起下一次 SDK 请求（实得发起 ${started} 次）`);
  assert.ok(!second.includes('第二轮输出'), `不放行时不得产出新的正文（实得 ${second}）`);
  assert.match(second, /本次请求未发出/, `要给出可辨的不放行原因（实得 ${second}）`);

  // 额度恢复**不**是用户的明确继续：准入门照实不放行，不得借恢复自动续跑原工作
  h.setQuota('available');
  const afterRecovery = await collect('恢复后的输出');
  assert.equal(started, 1, '额度恢复不解除等待明确继续，下一次请求仍不发起');
  assert.match(afterRecovery, /本次请求未发出/, `仍要给出不放行原因（实得 ${afterRecovery}）`);

  // 明确继续之后才重新放行：同一道门不是把会话永久封死
  await h.app.resumeRun({ sessionId });
  const third = await collect('第三轮输出');
  assert.equal(started, 2, '明确继续后下一次请求照常发起');
  assert.equal(third, '第三轮输出|', `继续后输出正常（实得 ${third}）`);
});

/**
 * 反例 E：候选名单被移除、**尚未**形成等待时，不得继续用名单外的旧采用模型。
 *
 * 发送入口的空名单分支核的是「已形成的等待」与认证在途；这里核的是此刻的采用关系。
 */
await test('候选名单移除后尚未形成等待：不得继续用旧采用模型发起请求', async (t) => {
  const h = await harness();
  t.after(() => h.app.flush());
  const sessionId = await firstSession(h.app);
  const sent = await h.app.sendMessage({ sessionId, text: '跑一次', mode: 'follow-up' });
  assert.equal(sent.receipt.status, 'accepted');
  // 执行端回报一次真实请求：应用层据此认定「实际采用」的是名单里那个模型
  h.publishAssistant(CANDIDATE.sourceId, CANDIDATE.modelId, 'resp-1');
  // 「实际采用」只由真实请求事件的观测投影发布：等轮询把这次新观测投影出来，不用写状态绕过
  const deadline = Date.now() + 5000;
  let actual: string | undefined;
  while (Date.now() < deadline) {
    const view = await h.app.listModelSources({ sessionId });
    actual = view.sessionStates[0]?.actual?.modelId;
    if (actual !== undefined) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(actual, CANDIDATE.modelId, '实际采用应来自真实请求事件');

  // 条件成立时准入门放行
  const admitted = await h.app.admitSdkRequest({
    sessionId, sourceId: CANDIDATE.sourceId, modelId: CANDIDATE.modelId,
  });
  assert.equal(admitted.ok, true, `名单内且额度可用时应放行（实得 ${JSON.stringify(admitted)}）`);

  // 用户把候选名单清空：此时**还没有**形成「等待明确继续」
  await h.app.updateSettings({ modelCandidates: [] });
  const waiting = await h.app.listModelSources({ sessionId });
  assert.equal(waiting.sessionStates[0]?.waitingExplicitContinue, false, '清空名单本身不是明确继续，也未形成等待');

  const denied = await h.app.admitSdkRequest({
    sessionId, sourceId: CANDIDATE.sourceId, modelId: CANDIDATE.modelId,
  });
  assert.equal(denied.ok, false, '名单里已没有实际采用的模型时不得继续发起请求');
  assert.match(denied.reason ?? '', /候选名单/, `要如实说明原因（实得 ${denied.reason}）`);
});

await test('P1-3 清空名单保存后关闭重开：不得恢复成从未配置的兼容入口', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dcode-candidate-scope-'));
  const storage = new JsonFileStorage(directory);
  const first = await harness({ storage });
  const id = await firstSession(first.app);
  await first.app.updateSettings({ modelCandidates: [] });
  await first.app.flush();
  const saved = JSON.parse(await readFile(join(directory, 'dcode-prototype-state.json'), 'utf8'));
  assert.equal(saved.modelCandidateScopeConfigured, true, '真实原子 JSON 文件持有范围语义');
  assert.deepEqual(saved.settings.modelCandidates, []);
  const reopened = await harness({ storage, configureCandidates: false });
  try {
    const admitted = await reopened.app.admitSdkRequest({ sessionId: id, ...CANDIDATE });
    assert.equal(admitted.ok, false, '保存后清空的范围重开仍拒绝，不能需要先出现 actual 才拒绝');
    assert.match(admitted.reason ?? '', /候选名单/);
  } finally { await reopened.app.flush(); await rm(directory, { recursive: true, force: true }); }
});

await test('P1-3 初始合法单模型：额度可用放行，已知耗尽不发下一请求', async (t) => {
  const h = await harness({ configureCandidates: false });
  t.after(() => h.app.flush());
  const id = await firstSession(h.app);
  const request = { sessionId: id, ...CANDIDATE };
  assert.equal((await h.app.admitSdkRequest(request)).ok, true, '旧单模型无需先手工配置名单');
  h.setQuota('unknown');
  assert.equal((await h.app.admitSdkRequest(request)).ok, true, '能力与其他条件成立时，额度未知允许原请求的有界尝试');
  h.setQuota('exhausted');
  assert.equal((await h.app.admitSdkRequest(request)).ok, false, '初始空名单不是已知耗尽豁免');
  h.setQuota('unknown');
  assert.equal((await h.app.admitSdkRequest(request)).ok, false, '耗尽后的未知不得解除明确继续等待');
});

await test('P1-3 首次名单保存失败：同实例及重开仍保持原兼容范围', async () => {
  let stored: PersistedState | null = null;
  let rejectSave = false;
  const storage: StorageAdapter = {
    load: async () => stored ? { status: 'ok', state: structuredClone(stored) } : { status: 'missing' },
    save: async (next) => {
      if (rejectSave) throw new Error('fixture-save-rejected');
      stored = structuredClone(next);
    },
  };
  const h = await harness({ storage, configureCandidates: false });
  const id = await firstSession(h.app);
  rejectSave = true;
  await assert.rejects(h.app.updateSettings({ modelCandidates: [CANDIDATE] }), /settings-save-failed/);
  rejectSave = false;
  const request = { sessionId: id, ...CANDIDATE };
  assert.equal((await h.app.admitSdkRequest(request)).ok, true, '失败保存不能在内存中宣称已配置范围');
  await h.app.flush();
  const reopened = await harness({ storage, configureCandidates: false });
  try { assert.equal((await reopened.app.admitSdkRequest(request)).ok, true); }
  finally { await reopened.app.flush(); }
});

/**
 * 反例 P1-1：准入裁定的身份必须落到**实际发起的那次请求**上。
 *
 * Auto 名单含 A/B，执行端已经按 A 准备好这一次请求；此时 A 已耗尽而 B 可用。
 * 裁定会改用 B——那么这一次请求就**必须真的发往 B**：
 * 只断言「准入被调用」证明不了任何事，这里核的是**实际发起的身份**与次数。
 * 同时核：上下文与已完成工具结果保留（不重投输入、不重复工具）。
 */
await test('Auto A/B：准备 A 时 A 已耗尽，真实下一次请求必须发往裁定采用的 B', async (t) => {
  const h = await harness();
  t.after(() => h.app.flush());
  const sessionId = await firstSession(h.app);

  // 先正常跑一次：两条候选都可用时按名单顺序采用 A，并留下真实请求事实
  const sent = await h.app.sendMessage({ sessionId, text: '先跑一次', mode: 'follow-up' });
  assert.equal(sent.receipt.status, 'accepted', `前置发送应被接收（实得 ${sent.receipt.status}）`);
  const submitsAfterFirst = h.submits();
  const timelineAfterFirst = (await h.app.getSnapshot()).timelines[sessionId]!.length;

  // A 已耗尽、B 可用：执行端仍按 A 准备好了下一次请求
  h.setQuotaByIdentity((c) => (c.sourceId === CANDIDATE.sourceId ? 'exhausted' : 'available'));
  await h.app.resolveSessionRouting({ sessionId });

  // 已登记来源的模型对象：与执行端同一份登记（按来源分组）
  const registered = new Map([
    [CANDIDATE.sourceId, [{ provider: CANDIDATE.sourceId, id: CANDIDATE.modelId }]],
    [CANDIDATE_B.sourceId, [{ provider: CANDIDATE_B.sourceId, id: CANDIDATE_B.modelId }]],
  ]);
  const resolveModel = (target: { sourceId: string; modelId: string }) =>
    registered.get(target.sourceId)?.find((m) => m.id === target.modelId) ?? null;

  const issued: { sourceId: string; modelId: string }[] = [];
  const deltas: string[] = [];
  const start = (chosen: { sessionId: string; sourceId: string; modelId: string }) => {
    issued.push({ sourceId: chosen.sourceId, modelId: chosen.modelId });
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'text-delta', delta: `${chosen.sourceId}/${chosen.modelId}` } as never);
    stream.end({ role: 'assistant', content: [], stopReason: 'stop' } as never);
    return stream;
  };
  const request = { sessionId, sourceId: CANDIDATE.sourceId, modelId: CANDIDATE.modelId };
  const out = withRequestAdmission(start, request, '', {
    admitRequest: (r) => h.app.admitSdkRequest(r),
    resolveModel,
  });
  let failure: string | null = null;
  for await (const event of out) {
    const e = event as { type?: string; delta?: string; error?: { errorMessage?: string } };
    if (e.type === 'text-delta' && typeof e.delta === 'string') deltas.push(e.delta);
    if (e.type === 'error') failure = e.error?.errorMessage ?? null;
  }

  // 实际发起的那一次：精确来源与 modelId 必须是裁定采用的 B
  assert.equal(failure, null, `条件成立时这一轮不该被拒（实得 ${failure}）`);
  assert.equal(issued.length, 1, `这次请求应真的发出去一次（实得 ${issued.length} 次）`);
  assert.deepEqual(issued[0], { sourceId: CANDIDATE_B.sourceId, modelId: CANDIDATE_B.modelId },
    `实际发起的身份必须是裁定采用的 B，而不是执行端已准备的 A（实得 ${JSON.stringify(issued[0])}）`);
  // A 的请求数不得增加
  assert.equal(issued.filter((x) => x.sourceId === CANDIDATE.sourceId).length, 0, 'A 的请求数不得增加');
  assert.deepEqual(deltas, [`${CANDIDATE_B.sourceId}/${CANDIDATE_B.modelId}`], '输出按实际发往的身份如实呈现');

  // 上下文与已完成工具结果保留：不重投输入、不重复工具
  assert.equal(h.submits(), submitsAfterFirst, '后续请求不得再次投递用户输入');
  const after = await h.app.getSnapshot();
  assert.equal(after.timelines[sessionId]!.length, timelineAfterFirst, '时间线不得因这次请求被改写或重复');
  assert.equal(after.timelines[sessionId]!.some((b) => b.kind === 'message' && b.role === 'user' && b.receipt?.status === 'accepted'), true,
    '已接收的输入事实保持不变');
});

/**
 * 反例 P1-1 另一侧：裁定给的身份执行端解析不到时**不放行**，
 * 而不是发出去一个与裁定不符的模型。
 */
await test('裁定身份执行端解析不到：如实不放行，不发出与裁定不符的请求', async (t) => {
  const h = await harness();
  t.after(() => h.app.flush());
  const sessionId = await firstSession(h.app);
  await h.app.sendMessage({ sessionId, text: '先跑一次', mode: 'follow-up' });

  h.setQuotaByIdentity((c) => (c.sourceId === CANDIDATE.sourceId ? 'exhausted' : 'available'));
  await h.app.resolveSessionRouting({ sessionId });

  let started = 0;
  let failure: string | null = null;
  const out = withRequestAdmission(
    () => { started += 1; const s = createAssistantMessageEventStream(); s.end({ role: 'assistant', content: [], stopReason: 'stop' } as never); return s; },
    { sessionId, sourceId: CANDIDATE.sourceId, modelId: CANDIDATE.modelId },
    '',
    {
      // 执行端解析不到 B：只能是 null，不能拿 A 顶替
      admitRequest: (r) => h.app.admitSdkRequest(r),
      resolveModel: (target) => (target.sourceId === CANDIDATE.sourceId ? { id: target.modelId } : null),
    },
  );
  for await (const event of out) {
    const e = event as { type?: string; error?: { errorMessage?: string } };
    if (e.type === 'error') failure = e.error?.errorMessage ?? null;
  }
  assert.equal(started, 0, '解析不到裁定身份时不得发起请求');
  assert.match(failure ?? '', /本次请求未发出/, `要如实说明不放行原因（实得 ${failure}）`);
});


for (const boundary of ['beginClosing', 'flush'] as const) await test(`关闭后的新默认保存（${boundary}）：不校验、不写盘、不发布`, async () => {
  let saved = sampleState();
  let saves = 0;
  const storage: StorageAdapter = {
    load: async () => ({ status: 'ok', state: JSON.parse(JSON.stringify(saved)) }),
    save: async (next) => { saves += 1; saved = JSON.parse(JSON.stringify(next)); },
  };
  const h = await harness({ storage });
  if (boundary === 'flush') await h.app.flush(); else h.app.beginClosing();
  const before = await h.app.getSnapshot();
  const count = saves;
  const reads = h.capabilityReads();
  const result = await h.app.setDefaultModelChoice({ choice: { mode: 'explicit', ...CANDIDATE } });
  assert.equal(result.ok, false, '关闭后不得认领新的默认保存');
  assert.equal(saves, count, '不启动任何新写盘');
  assert.equal(h.capabilityReads(), reads, '不开始目录/能力校验');
  assert.deepEqual((await h.app.getSnapshot()).settings.newSessionModelChoice, before.settings.newSessionModelChoice);
  await h.app.flush();
});

for (const field of ['candidates', 'default'] as const) await test(`保存 A 失败（${field}）、仅主题 B 成功：不携带失败字段，同实例和重开只认实际提交`, async (t) => {
  let stored: PersistedState | null = null;
  let rejectA!: (error: Error) => void;
  let holdNext = false;
  let arrived = false;
  let line: Promise<void> = Promise.resolve();
  const storage: StorageAdapter = {
    load: async () => stored ? { status: 'ok', state: JSON.parse(JSON.stringify(stored)) } : { status: 'missing' },
    save: (next) => {
      const draft = JSON.parse(JSON.stringify(next)) as PersistedState;
      const gate = holdNext ? new Promise<void>((_resolve, reject) => { rejectA = reject; arrived = true; }) : null;
      holdNext = false;
      if (gate) void gate.catch(() => undefined);
      const work = line.then(async () => { if (gate) await gate; stored = draft; });
      line = work.catch(() => undefined);
      return work;
    },
  };
  const h = await harness({ configureCandidates: false, storage });
  t.after(() => h.app.flush());
  await h.app.updateSettings({ theme: 'system' });
  holdNext = true;
  const a = field === 'candidates' ? h.app.updateSettings({ modelCandidates: [CANDIDATE] })
    : h.app.setDefaultModelChoice({ choice: { mode: 'explicit', ...CANDIDATE } });
  void a.catch(() => undefined);
  const deadline = Date.now() + 5000;
  while (!arrived && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(arrived, true, 'A 的写盘真实到达并停泊');
  const b = h.app.updateSettings({ theme: 'light' });
  rejectA(new Error('controlled A candidate save failure'));
  if (field === 'candidates') await assert.rejects(a, /settings-save-failed/);
  else assert.equal((await a as { ok: boolean }).ok, false, 'A 默认保存如实失败');
  await b;
  assert.deepEqual((await h.app.getSnapshot()).settings.newSessionModelChoice, { mode: 'auto' }, '主题保存不发布失败默认');
  assert.deepEqual((await h.app.getSnapshot()).settings.modelCandidates, [], '主题保存不发布失败名单');
  assert.equal((await h.app.getSnapshot()).settings.theme, 'light', 'B 自己的主题真实保存');
  assert.equal(stored!.modelCandidateScopeConfigured, false, '失败的首次名单不变成已配置范围');
  await h.app.flush();
  const reopened = await harness({ configureCandidates: false, storage });
  t.after(() => reopened.app.flush());
  assert.deepEqual((await reopened.app.getSnapshot()).settings.modelCandidates, [], '重开不复活失败名单');
  const sessionId = await firstSession(reopened.app);
  const input = await reopened.app.sendMessage({ sessionId, text: '初始兼容入口仍可按完整条件提交', mode: 'follow-up' });
  assert.equal(input.receipt.status, 'accepted');
});
