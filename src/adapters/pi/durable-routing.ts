// ModelRuntime 有状态路由的公开 Durable 接缝：没有第二套循环、输入或响应历史。
import { createHash } from 'node:crypto';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import type { Context, JsonValue } from '@earendil-works/chord';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { physicalRequestBudget } from './request-budget';
import type { Api, AssistantMessage, DeferredHandle, Message, Model, ModelThinkingLevel, Models, ModelsSimpleStreamOptions } from '@earendil-works/pi-ai';
import { AgentDoc, defineDocFamily, defineExtension, GenerationTask, hook, LiveDoc } from '@earendil-works/pi-durable';
import type { GenerationCheckpoint, Harness, HookApi, ModelRef, TaskRuntime } from '@earendil-works/pi-durable';

type RouteState = { revision: number; value: JsonValue; hasValue: boolean; inputs: number[] };
type RoutePlan = {
  ready: boolean; key: string; taskId: number; conversationId: number; attempt: number; cutoff: number;
  requested: { provider: string; modelId: string }; selected: { provider: string; modelId: string };
  physical: { provider: string; modelId: string }; thinkingLevel: ModelThinkingLevel;
};
const State = defineDocFamily<RouteState, null>({
  kind: 'dcode.virtual-route-state', version: 1, scope: 'conversation', history: 'rewindable', fork: 'asOf', family: true,
  initial: () => ({ revision: 0, value: null, hasValue: false, inputs: [] }),
});
const Plan = defineDocFamily<RoutePlan, string>({
  kind: 'dcode.virtual-route-plan', version: 1, scope: 'task', family: true,
  initial: (key) => ({ ready: false, key, taskId: 0, conversationId: 0, attempt: 0, cutoff: 0,
    requested: { provider: '', modelId: '' }, selected: { provider: '', modelId: '' }, physical: { provider: '', modelId: '' }, thinkingLevel: 'off' }),
});
const DeferredPlan = defineDocFamily<{ ready: boolean; requested: ModelRef; physical: ModelRef }, null>({
  kind: 'dcode.virtual-deferred-plan', version: 1, scope: 'session', family: true,
  initial: () => ({ ready: false, requested: { provider: '', modelId: '' }, physical: { provider: '', modelId: '' } }),
});
const identity = (ref: ModelRef) => JSON.stringify([ref.provider, ref.modelId]);
const isVirtual = (model: Model<Api> | undefined) => model?.api === 'pi-virtual';
const handleKey = (handle: DeferredHandle) => createHash('sha256').update(JSON.stringify(handle)).digest('hex');
class RoutePreparationChanged extends Error {}
class PhysicalContextExceeded extends Error {}

/** 只接受无损 JSON 状态；拒绝丢函数、循环、NaN 等“保存成功但内容变了”的返回值。 */
function routeJson(value: unknown): JsonValue {
  const seen = new Set<object>();
  const valid = (input: unknown, depth: number): boolean => {
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return true;
    if (typeof input === 'number') return Number.isFinite(input);
    if (typeof input !== 'object' || depth > 64 || seen.has(input)) return false;
    seen.add(input);
    const ok = Array.isArray(input) ? input.every((v) => valid(v, depth + 1))
      : Object.getPrototypeOf(input) === Object.prototype && Object.values(input).every((v) => valid(v, depth + 1));
    seen.delete(input);
    return ok;
  };
  if (!valid(value, 0)) throw new Error('Virtual route returned invalid durable state');
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('Virtual route state exceeds durable limit');
  return JSON.parse(text) as JsonValue;
}

/** 每个 Harness 一份；宿主沿 BACKGROUND_CONTEXT 打开，真正取消由 Harness.close 管理。 */
export class DurableModelRouting {
  readonly extension;
  readonly models: Models;
  readonly #runtime: ModelRuntime;
  readonly #runnable: () => boolean;
  readonly #bindings = new WeakMap<AbortSignal, RoutePlan | { physicalOnly: true; requested: ModelRef; selected: ModelRef; thinkingLevel: ModelThinkingLevel }>();
  readonly #ownedInvocations = new WeakMap<AbortSignal, { taskId: number; conversationId: number; requested: string }>();
  #harness: Harness | null = null;

  constructor(runtime: ModelRuntime, runnable: () => boolean) {
    this.#runtime = runtime;
    this.#runnable = runnable;
    this.extension = defineExtension({ name: 'dcode.virtual-routing', hooks: [hook(GenerationTask, {
      beforeRequest: async (input, api, context) => { await this.#prepare(input.messages, api, context); return undefined; },
    })] });
    // 仅代理公开 Models 方法，不访问 ModelRuntime 的私有 models、认证或 scheduler 字段。
    const names = new Set<keyof Models>(['getProviders', 'getProvider', 'getModels', 'getModel', 'getModelsOfType', 'getModelOfType', 'getAllModels',
      'refresh', 'checkAuth', 'getAvailable', 'getAvailableOfType', 'getAllAvailable', 'getAuth', 'login', 'logout',
      'stream', 'complete', 'streamSimple', 'completeSimple', 'streamDeferred', 'fetchDeferred', 'cancelDeferred', 'generateImages', 'classify']);
    const overrides: Partial<Models> = {
      streamSimple: (model, input, options) => this.#stream(model, input.messages ?? [], input, options),
      // Compaction/显式单次调用是公开的独立消费者；绝不以“信号没绑定”猜 direct。
      completeSimple: async (model, input, options) => {
        if (!isVirtual(model)) return runtime.completeSimple(model, input, options);
        try {
          const route = await runtime.resolveModel(model, normalizeContext(input).messages, { reason: 'direct', thinkingLevel: options?.reasoning ?? 'off', signal: options?.signal });
          // direct 明确不传/保存 state；摘要同样核物理容量，不能按虚拟展示上限发探针。
          return await runtime.completeSimple(route.model, input, this.#requestOptions(route.model, { provider: model.provider, modelId: model.id }, input, options, route.thinkingLevel));
        } catch (error) {
          // 与公开 Models 消费者同一结果合同：本地准备失败也返回有限错误消息，不变成未处理 reject。
          const out = createAssistantMessageEventStream(); this.#fail(out, error); return out.result();
        }
      },
      streamDeferred: (model, handle, options) => {
        const out = createAssistantMessageEventStream();
        // pending 回查可更新转换资料、期限或下一次间隔；新句柄同样先存归属再交给 poll checkpoint。
        void this.#deferredModel(model, handle).then((physical) => this.#relay(out, runtime.streamDeferred(physical, handle, options), { requested: { provider: model.provider, modelId: model.id } }))
          .catch((error) => this.#fail(out, error));
        return out;
      },
      fetchDeferred: (model, handle, options) => this.models.streamDeferred(model, handle, options).result(),
      cancelDeferred: async (model, handle, options) => runtime.cancelDeferred(await this.#deferredModel(model, handle), handle, options),
    };
    this.models = new Proxy({} as Models, { get: (_target, key) => {
      if (typeof key !== 'string' || !names.has(key as keyof Models)) return undefined;
      const replacement = Reflect.get(overrides, key);
      if (replacement) return replacement;
      const fn = Reflect.get(runtime, key);
      return typeof fn === 'function' ? fn.bind(runtime) : undefined;
    } });
  }

  attach(harness: Harness): void {
    if (this.#harness !== null) throw new Error('Route adapter already belongs to a Harness');
    this.#harness = harness;
  }

  #owner(): Harness {
    if (!this.#harness) throw new Error('Route adapter has no Harness owner');
    return this.#harness;
  }

  /** 仅由可信Host把当前模型child认领到原Models；不借缺少Generation计划放行direct。 */
  async withOwnedModelInvocation<T>(runtime: Pick<TaskRuntime<unknown, unknown, unknown, object>, 'taskId' | 'conversationId' | 'signal'>,
    requested: ModelRef, operation: () => Promise<T>): Promise<T> {
    const { signal, taskId, conversationId } = runtime;
    const checkActive = () => {
      signal.throwIfAborted();
      if (!this.#runnable() || this.#bindings.has(signal) || this.#ownedInvocations.has(signal)) throw new Error('Owned model invocation is not available');
    };
    checkActive();
    if (typeof requested.provider !== 'string' || typeof requested.modelId !== 'string') throw new Error('Owned model identity missing');
    // 登记前固定值；调用方随后改同一ref对象不能把已核A的权限带到B。
    const expected = identity({ provider: requested.provider, modelId: requested.modelId });
    const task = await this.#owner().getTask(taskId, withAbortSignal(signal, BACKGROUND_CONTEXT));
    checkActive();
    if (!task || task.kind !== 'dcode.extension-model' || task.id !== taskId || task.conversationId !== conversationId
      || task.abortRequested || task.state.status !== 'running') throw new Error('Owned model task does not match this invocation');
    const input = task.input;
    const cp = task.state.checkpoint;
    if (!input || typeof input !== 'object' || Array.isArray(input) || !cp || typeof cp !== 'object' || Array.isArray(cp)
      || cp.phase !== 'execute' || typeof input.ownerTaskId !== 'number' || task.owner !== input.ownerTaskId
      || typeof input.caller !== 'string' || !input.caller.startsWith('tool/') || typeof input.actionId !== 'string'
      || !input.actionId.startsWith(input.caller + '/') || typeof input.provider !== 'string' || typeof input.modelId !== 'string'
      || identity({ provider: input.provider, modelId: input.modelId }) !== expected || !(input.mode === 'classify' || input.mode === 'generateImages' ? this.#runtime.getModelOfType(input.mode === 'classify' ? 'classifier' : 'image', input.provider, input.modelId) : this.#runtime.getModel(input.provider, input.modelId))) {
      throw new Error('Owned model request does not match its committed owner and identity');
    }
    const lease = { taskId, conversationId, requested: expected };
    this.#ownedInvocations.set(signal, lease);
    try { return await operation(); }
    finally { if (this.#ownedInvocations.get(signal) === lease) this.#ownedInvocations.delete(signal); }
  }

  async #prepare(messages: readonly Message[], api: HookApi, context: Context, passes = 0): Promise<void> {
    const signal = context.abortSignal;
    if (!signal || signal.aborted || !this.#runnable()) throw new Error('Route invocation is not runnable');
    this.#bindings.delete(signal);
    const harness = this.#owner();
    const task = await harness.getTask(api.taskId, context);
    if (!task || (task.state.status !== 'running' && task.state.status !== 'pending')) throw new Error('Route request has no live generation');
    const checkpoint = task.state.checkpoint as GenerationCheckpoint;
    if (checkpoint.phase !== 'request') throw new Error('Route request checkpoint does not match');
    const conversation = await harness.conversation(api.conversationId, context);
    const agent = await conversation?.agent(context);
    const selected = agent?.model ?? checkpoint.model;
    const virtual = this.#runtime.getModel(selected.provider, selected.modelId);
    if (!isVirtual(virtual)) { this.#bindings.set(signal, { physicalOnly: true, requested: checkpoint.model, selected, thinkingLevel: agent!.thinkingLevel }); return; }
    // 本次与下一次配置分开；重开同一 checkpoint/选择/档位复用原计划。
    const thinking = agent!.thinkingLevel;
    const key = JSON.stringify([api.conversationId, api.taskId, checkpoint.attempt, checkpoint.cutoff, selected, thinking]);
    const existing = await harness.snapshot(Plan, api.taskId, key, context);
    if (existing?.ready) { this.#bindings.set(signal, existing); return; }
    const stateKey = identity(selected);
    const state = await harness.snapshot(State, api.conversationId, stateKey, context);
    const live = await api.snapshot(LiveDoc, api.conversationId, context);
    const placed: number[] = [];
    for (const id of live?.run?.inputs ?? []) {
      const record = await (await harness.submission(id, context))?.status(context);
      if (record?.type === 'input' && record.entry !== undefined && record.entry <= checkpoint.cutoff) placed.push(id);
    }
    const before = state?.inputs ?? [];
    let overflow = false;
    if (checkpoint.compacted !== undefined) {
      const compacted = await harness.getTask(checkpoint.compacted, context);
      overflow = compacted?.input && typeof compacted.input === 'object' && !Array.isArray(compacted.input) && compacted.input.reason === 'overflow' || false;
    }
    const reason = checkpoint.attempt > 1 || overflow ? 'retry' : placed.some((id) => !before.includes(id)) ? 'user' : 'continuation';
    let failed: AssistantMessage | undefined;
    if (reason === 'retry') {
      const page = await conversation!.entries({}, 256, undefined, context);
      for (const entry of page.items) {
        const message = entry.model?.find((m) => m.role === 'assistant' && m.stopReason === 'error');
        if (message?.role === 'assistant' && entry.byTaskId === api.taskId && entry.id <= checkpoint.cutoff) { failed = message; break; }
      }
    }
    const resolved = await this.#runtime.resolveModel(virtual!, messages, {
      reason, thinkingLevel: thinking, signal, ...(failed ? { failed } : {}),
      ...(state?.hasValue ? { state: state.value } : {}),
    });
    const next = resolved.state === undefined ? undefined : routeJson(resolved.state);
    const plan: RoutePlan = { ready: true, key, taskId: api.taskId, conversationId: api.conversationId,
      attempt: checkpoint.attempt, cutoff: checkpoint.cutoff, requested: checkpoint.model, selected,
      physical: { provider: resolved.model.provider, modelId: resolved.model.id }, thinkingLevel: resolved.thinkingLevel };
    // 一个公开 Session 事务同时采纳计划和状态；不可把两个 memo 提交当成同一原子步骤。
    let saved: RoutePlan;
    try { saved = await harness.commit(async (tx) => {
      signal.throwIfAborted();
      if (!this.#runnable()) throw new Error('Route owner paused or closed during preparation');
      const current = await tx.task(api.taskId);
      if (!current || current.abortRequested || current.state.status !== 'running') throw new Error('Route task changed during preparation');
      const cp = current.state.checkpoint as GenerationCheckpoint;
      if (cp.phase !== 'request' || cp.attempt !== checkpoint.attempt || cp.cutoff !== checkpoint.cutoff || identity(cp.model) !== identity(checkpoint.model)) throw new Error('Route checkpoint changed during preparation');
      const currentAgent = await tx.doc(AgentDoc, api.conversationId);
      if (identity(currentAgent.model ?? checkpoint.model) !== identity(selected) || (currentAgent.thinkingLevel ?? 'off') !== thinking) throw new RoutePreparationChanged('Route selection changed during preparation');
      const ledger = await tx.doc(State, api.conversationId, stateKey, null);
      const document = await tx.doc(Plan, api.taskId, key, key);
      if (document.ready) return { ...document };
      if (ledger.revision !== (state?.revision ?? 0)) throw new RoutePreparationChanged('Route state changed during preparation');
      Object.assign(document, plan);
      if (next !== undefined) { ledger.value = next; ledger.hasValue = true; }
      ledger.inputs = placed;
      ledger.revision += 1;
      return plan;
    }, context); } catch (error) {
      // 迟到 router 结果不覆盖新的配置。只重读未发出的准备，不推进 state 或重投正式输入。
      if (error instanceof RoutePreparationChanged && passes < 3 && !signal.aborted && this.#runnable()) return this.#prepare(messages, api, context, passes + 1);
      throw error;
    }
    signal.throwIfAborted();
    this.#bindings.set(signal, saved);
  }

  #stream(model: Model<Api>, _messages: readonly Message[], input: Parameters<Models['streamSimple']>[1], options?: ModelsSimpleStreamOptions) {
    const owned = options?.signal && this.#ownedInvocations.get(options.signal);
    if (owned) {
      try {
        options!.signal!.throwIfAborted();
        if (!this.#runnable() || identity({ provider: model.provider, modelId: model.id }) !== owned.requested) throw new Error('Owned model request identity changed');
        // 原simple入口持有认证/完整准入与参数；不能套Generation off计划把显式reasoning抹掉。
        return this.#runtime.streamSimple(model, input, options);
      } catch (error) { const out = createAssistantMessageEventStream(); this.#fail(out, error); return out; }
    }
    const binding = options?.signal && this.#bindings.get(options.signal);
    if (!binding) {
      const out = createAssistantMessageEventStream();
      this.#fail(out, new Error('Virtual request has no committed invocation plan'));
      return out;
    }
    if ('physicalOnly' in binding) {
      const selected = this.#runtime.getPhysicalModel(binding.selected.provider, binding.selected.modelId);
      if (selected && this.#runnable() && identity({ provider: model.provider, modelId: model.id }) === identity(binding.requested)) {
        const out = createAssistantMessageEventStream();
        try { void this.#relay(out, this.#runtime.streamSimple(selected, input, this.#requestOptions(selected, binding.requested, input, options, binding.thinkingLevel)), binding)
          .catch((error) => this.#fail(out, error)); } catch (error) { this.#fail(out, error); }
        return out;
      }
      const out = createAssistantMessageEventStream(); this.#fail(out, new Error('Physical generation invocation changed')); return out;
    }
    const plan = binding;
    const out = createAssistantMessageEventStream();
    void (async () => {
      options?.signal?.throwIfAborted();
      if (!this.#runnable() || identity({ provider: model.provider, modelId: model.id }) !== identity(plan.requested)) throw new Error('Virtual request does not belong to its committed plan');
      const physical = this.#runtime.getPhysicalModel(plan.physical.provider, plan.physical.modelId);
      if (!physical) throw new Error('Planned physical model is no longer registered');
      // 物理来源重新认证；原信号/上下文保留，输出上限只收紧到该模型的公开真实上限。
      const actual = this.#requestOptions(physical, plan.requested, input, options, plan.thinkingLevel);
      await this.#relay(out, this.#runtime.streamSimple(physical, input, actual), plan);
    })().catch((error) => this.#fail(out, error));
    return out;
  }

  #requestOptions(physical: Model<Api>, requested: ModelRef, input: Parameters<Models['streamSimple']>[1], options: ModelsSimpleStreamOptions | undefined, thinking: ModelThinkingLevel): ModelsSimpleStreamOptions {
    const actual = { ...options };
    if (physical.provider !== requested.provider) { delete actual.apiKey; delete actual.headers; delete actual.env; }
    delete actual.reasoning;
    if (thinking !== 'off') actual.reasoning = thinking;
    const budget = physicalRequestBudget(physical, input, actual.maxTokens);
    if (budget.capacityExceeded) throw new PhysicalContextExceeded('Physical model context is insufficient');
    actual.maxTokens = budget.maxTokens;
    return actual;
  }

  async #relay(out: ReturnType<typeof createAssistantMessageEventStream>, inner: ReturnType<typeof createAssistantMessageEventStream>, owner?: { requested: ModelRef }) {
    // 等最终消息及 deferred 计划持久化后再发布 done，防止 Harness 先采纳不可回查的句柄。
    for await (const event of inner) if (event.type !== 'done') out.push(event);
    const message = await inner.result();
    if (message.deferred && owner) {
      // await 改选或正式 SDK 门再次采用模型后，句柄归属取自真实返回；原 checkpoint 仅负责调用身份。
      const handle = message.deferred;
      const delivered = this.#runtime.getPhysicalModel(handle.provider, handle.modelId);
      if (!delivered || delivered.api !== handle.api || message.provider !== handle.provider || message.model !== handle.modelId) throw new Error('Deferred response has no registered physical owner');
      const physical = { provider: delivered.provider, modelId: delivered.id };
      await this.#owner().commit(async (tx) => {
        const d = await tx.doc(DeferredPlan, handleKey(handle), null);
        if (d.ready && (identity(d.requested) !== identity(owner.requested) || identity(d.physical) !== identity(physical))) throw new Error('Deferred handle belongs to another request');
        Object.assign(d, { ready: true, requested: owner.requested, physical });
      }, BACKGROUND_CONTEXT);
    }
    if (message.stopReason === 'stop' || message.stopReason === 'length' || message.stopReason === 'toolUse' || message.stopReason === 'deferred') out.push({ type: 'done', reason: message.stopReason, message });
    out.end(message);
  }

  async #deferredModel(requested: Model<Api>, handle: DeferredHandle): Promise<Model<Api>> {
    const saved = await this.#owner().snapshot(DeferredPlan, handleKey(handle), BACKGROUND_CONTEXT);
    if (!saved?.ready) {
      if (!isVirtual(requested)) return requested;
      throw new Error('Virtual deferred request has no durable physical plan');
    }
    if (identity(saved.requested) !== identity({ provider: requested.provider, modelId: requested.id })) throw new Error('Deferred request identity does not match');
    const physical = this.#runtime.getPhysicalModel(saved.physical.provider, saved.physical.modelId);
    if (!physical) throw new Error('Deferred physical model is no longer registered');
    return physical;
  }

  #fail(out: ReturnType<typeof createAssistantMessageEventStream>, error: unknown) {
    // 路由失败不把物理来源或实际响应补造出来，也不向产品历史透传可能含凭据的 router 异常正文。
    const message: AssistantMessage = { role: 'assistant', api: 'pi-virtual', provider: 'dcode-routing', model: 'unissued', content: [], stopReason: 'error',
      errorMessage: error instanceof PhysicalContextExceeded ? 'Context overflow: physical model capacity is insufficient for this request' : '路由或模型请求未完成，请保留原工作并核对状态', timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    out.push({ type: 'error', reason: 'error', error: message }); out.end(message);
  }
}
