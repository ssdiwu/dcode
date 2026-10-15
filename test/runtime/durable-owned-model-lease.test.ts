// 显式 owned 模型任务认领的完整身份与拒绝边界；原有六条行为断言保留。
// 只覆盖 DurableModelRouting 的显式 owned lease；真实扩展 Worker 接线与恢复另验。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import type { Api, AssistantMessage, AssistantMessageEvent, Credential, Model, Models, Provider } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createRegistry, defineExtension, defineTask, defineTool, Harness, ToolResultEntry } from '@earendil-works/pi-durable';
import type { ConversationId, JsonObject, ModelRef, TaskId, TaskRuntime } from '@earendil-works/pi-durable';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { DurableModelRouting, registerPresetProviders } from '../../src/adapters/pi/index.ts';

type Mode = 'owned' | 'missing-lease' | 'wrong-ref' | 'wrong-signal';
type AdmissionFault = 'wrong-conversation' | 'tool-kind' | 'nonmodel-kind' | 'wrong-owner-input' | 'wrong-registered-ref' | 'mutated-ref' | 'duplicate-active';
type Input = { caller: string; actionId: string; ownerTaskId: number; provider: string; modelId: string; mode: Mode; admission?: AdmissionFault };
type AdmissionObservation = {
  fault: AdmissionFault; rejected: boolean; operationEntered: boolean; taskId: TaskId; actualKind: string;
  actualConversationId: ConversationId; providedConversationId: ConversationId; actualOwnerId?: TaskId; inputOwnerTaskId?: number;
  requestedBefore: ModelRef; requestedAfter?: ModelRef; duplicateRejected?: boolean; duplicateOperationEntered?: boolean;
  afterDuplicateTargets?: number; afterDuplicateForwards?: number; streamStopReason?: AssistantMessage['stopReason']; afterScopeStopReason?: AssistantMessage['stopReason'];
};
type Checkpoint = { phase: 'call' | 'execute' };
type Runtime = TaskRuntime<Input, Checkpoint, JsonObject, object>;
type LeaseRuntime = Pick<TaskRuntime<unknown, unknown, unknown, object>, 'taskId' | 'conversationId' | 'signal'>;

// 这是 D Code 内部接缝，不是 Pi 1.0.0 自带 API。
// 只在原 model child 的真实调用栈内有效，不接受 Worker 提交的 task/signal 假对象。
type OwnedLeaseSeam = {
  withOwnedModelInvocation<T>(runtime: LeaseRuntime, requested: ModelRef, operation: () => Promise<T>): Promise<T>;
};
function withLease<T>(routing: DurableModelRouting, runtime: LeaseRuntime, requested: ModelRef, operation: () => Promise<T>) {
  const candidate = routing as DurableModelRouting & OwnedLeaseSeam;
  assert.equal(typeof candidate.withOwnedModelInvocation, 'function', '待实现的显式 owned invocation lease 接缝缺失');
  return candidate.withOwnedModelInvocation(runtime, requested, operation);
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function ended(signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}
const input = { messages: [{ role: 'user' as const, content: 'owned-stream-input-nonce', timestamp: 1 }] };
const messageText = (message: AssistantMessage) => message.content.filter((part) => part.type === 'text').map((part) => part.text).join('');

async function fixture(mode: Mode = 'owned', options: { holdTarget?: boolean; emitTool?: boolean; admission?: AdmissionFault } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dcode-owned-stream-lease-'));
  const requests: { model: string; authOk: boolean; body: Record<string, unknown> }[] = [];
  const forwarded: { model: Model<Api>; input: Parameters<Models['streamSimple']>[1]; options: Parameters<Models['streamSimple']>[2] }[] = [];
  const partial = gate(); const release = gate();
  const captures: { runtime: Runtime; signal: AbortSignal; events: AssistantMessageEvent[]; owner: TaskId; taskId: TaskId; end: Promise<void>; afterScope?: AssistantMessage }[] = [];
  const toolCalls: { taskId: TaskId; childId: TaskId }[] = [];
  const admissions: AdmissionObservation[] = [];
  let otherConversationId: ConversationId | undefined;
  const key = 'isolated-owned-lease-fixture-key';
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      let body: Record<string, unknown>;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; }
      catch { res.writeHead(400); res.end('{"error":{"message":"fixture request body was not received"}}'); return; }
      const model = String(body.model);
      const authOk = req.headers.authorization === `Bearer ${key}`;
      requests.push({ model, authOk, body });
      if (!authOk) { res.writeHead(401); res.end('{"error":{"message":"fixture credential missing"}}'); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (delta: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({
        id: `lease-http-${requests.length}`, model, choices: [{ index: 0, delta, finish_reason: finish }],
        ...(finish ? { usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } } : {}),
      })}\n\n`);
      if (model === 'lease-controller') {
        const hasTool = Array.isArray(body.messages) && body.messages.some((message) => (message as { role?: string }).role === 'tool');
        if (options.emitTool !== false && !hasTool) {
          send({ role: 'assistant', tool_calls: [{ index: 0, id: 'real-controller-tool-call', type: 'function', function: { name: 'lease_probe', arguments: '{}' } }] });
          send({}, 'tool_calls');
        } else { send({ role: 'assistant', content: 'controller-finished' }); send({}, 'stop'); }
        res.end('data: [DONE]\n\n'); return;
      }
      send({ role: 'assistant', content: `actual-owned-stream-${model}` });
      const finish = () => { if (!res.destroyed) { send({}, 'stop'); res.end('data: [DONE]\n\n'); } };
      if (options.holdTarget) void release.promise.then(finish); else finish();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const credentials = new Map<string, Credential>([['openrouter', { type: 'api_key', key }]]);
  const runtime = await ModelRuntime.create({ credentials: {
    read: async (id) => credentials.get(id),
    list: async () => [...credentials].map(([providerId, value]) => ({ providerId, type: value.type })),
    modify: async (id, change) => { const value = await change(credentials.get(id)); if (value) credentials.set(id, value); return credentials.get(id); },
    delete: async (id) => { credentials.delete(id); },
  }, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  const model = (id: string): Model<Api> => ({ id, name: id, provider: 'openrouter', api: 'openai-completions', baseUrl,
    reasoning: true, input: ['text'], contextWindow: 128000, maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
  const models = { controller: model('lease-controller'), A: model('lease-A'), B: model('lease-B') };
  // 先覆盖全部 builtin auth 消费者，避免 refresh 触及真实 env/file 认证来源。
  const presets = registerPresetProviders();
  for (const item of presets) runtime.registerNativeProvider(item.provider);
  const preset = presets.find((item) => item.id === 'openrouter'); assert.ok(preset);
  const provider: Provider = { ...preset.provider, getModels: () => Object.values(models), getAllModels: () => Object.values(models) };
  runtime.registerNativeProvider(provider);
  await runtime.refresh({ allowNetwork: false });
  const original = runtime.streamSimple.bind(runtime);
  // 仅包裹原公开方法记录真实转交参数；解析、认证、HTTP、流事件都继续走原 ModelRuntime。
  runtime.streamSimple = (selected, value, options) => { forwarded.push({ model: selected, input: value, options }); return original(selected, value, options); };
  const routing = new DurableModelRouting(runtime, () => true);
  const childTask = defineTask<Input, Checkpoint, JsonObject>({
    name: options.admission === 'nonmodel-kind' ? 'dcode.lease-nonmodel-fixture' : 'dcode.extension-model', version: 1, initial: () => ({ phase: 'call' }),
    phases: {
      call: async (task, runtime, ctx) => {
        const record = await runtime.getTask(runtime.taskId, ctx); assert.ok(record);
        assert.equal(record.id, task.id);
        if (task.input.admission === 'wrong-owner-input') {
          assert.notEqual(record.owner, task.input.ownerTaskId, '仅原始 Input 错报真实存在的 Generation owner；不改 SDK owner 边');
          assert.equal(record.owner, toolCalls[0]!.taskId);
        } else assert.equal(record.owner, task.input.ownerTaskId);
        assert.equal(record.conversationId, runtime.conversationId);
        assert.equal(record.kind, task.input.admission === 'nonmodel-kind' ? 'dcode.lease-nonmodel-fixture' : 'dcode.extension-model');
        assert.equal(record.state.status, 'running');
        const selected = runtime.models.getModel(task.input.provider, task.input.modelId); assert.ok(selected);
        const capture = { runtime, signal: runtime.signal, events: [] as AssistantMessageEvent[], owner: record.owner!, taskId: task.id, end: ended(runtime.signal), afterScope: undefined as AssistantMessage | undefined };
        captures.push(capture);
        // 与正式 model child 一样，HTTP 前先落不可盲重放的 execute intent。
        await runtime.commit(() => ({ status: 'running', checkpoint: { phase: 'execute' } }), ctx);
        const actual = task.input.mode === 'wrong-ref' ? runtime.models.getModel(models.B.provider, models.B.id)! : selected;
        const signal = task.input.mode === 'wrong-signal' ? new AbortController().signal : runtime.signal;
        const invoke = async (streamModel = actual) => {
          const stream = runtime.models.streamSimple(streamModel, input, { signal, reasoning: 'low', temperature: 0.25, maxTokens: 19, maxRetries: 0 });
          assert.equal(typeof (stream as { then?: unknown }).then, 'undefined', 'streamSimple 必须同步返回流对象');
          assert.equal(typeof stream[Symbol.asyncIterator], 'function'); assert.equal(typeof stream.result, 'function');
          const result = stream.result();
          for await (const event of stream) { capture.events.push(event); if (event.type === 'text_delta') partial.resolve(); }
          return result;
        };
        const requested = { provider: selected.provider, modelId: selected.id };
        if (task.input.admission) {
          const fault = task.input.admission;
          const provided = { taskId: runtime.taskId, conversationId: runtime.conversationId, signal: runtime.signal };
          if (fault === 'wrong-conversation') { assert.ok(otherConversationId); provided.conversationId = otherConversationId; }
          if (fault === 'wrong-registered-ref') { requested.provider = models.B.provider; requested.modelId = models.B.id; }
          const observed: AdmissionObservation = { fault, rejected: false, operationEntered: false, taskId: task.id, actualKind: record.kind,
            actualConversationId: record.conversationId, providedConversationId: provided.conversationId, actualOwnerId: record.owner,
            inputOwnerTaskId: task.input.ownerTaskId, requestedBefore: { ...requested } };
          admissions.push(observed);
          let message: AssistantMessage | undefined;
          try {
            message = await withLease(routing, provided, requested, async () => {
              observed.operationEntered = true;
              if (fault === 'duplicate-active') {
                observed.duplicateOperationEntered = false; observed.duplicateRejected = false;
                try {
                  await withLease(routing, provided, { ...requested }, async () => { observed.duplicateOperationEntered = true; });
                } catch { observed.duplicateRejected = true; }
                observed.afterDuplicateTargets = requests.filter((request) => request.model !== models.controller.id).length;
                observed.afterDuplicateForwards = forwarded.filter((request) => request.model.id !== models.controller.id).length;
                return invoke(); // 内层拒绝后原外层必须仍可真正请求 A，拒绝不能误清原 lease。
              }
              if (fault === 'mutated-ref') {
                requested.provider = models.B.provider; requested.modelId = models.B.id;
                observed.requestedAfter = { ...requested };
                return invoke(models.B); // 不可借修改传入对象扩大到 B。
              }
              return invoke();
            });
          } catch { observed.rejected = true; }
          if (message) observed.streamStopReason = message.stopReason;
          if (fault === 'duplicate-active') {
            observed.afterScopeStopReason = (await runtime.models.streamSimple(selected, input, { signal: runtime.signal, maxRetries: 0 }).result()).stopReason;
          }
          // 拒绝只持久保存探针观察，不造一个没有 HTTP 来源的 assistant 消息。
          const result = JSON.parse(JSON.stringify({ admission: observed, ...(message ? { message } : {}) })) as JsonObject;
          await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result } }), ctx);
          return;
        }
        const message = task.input.mode === 'missing-lease' ? await invoke() : await withLease(routing, runtime, requested, invoke);
        if (task.input.mode === 'owned') {
          assert.equal(runtime.signal.aborted, false, 'lease 清理时原 task invocation 仍活跃');
          capture.afterScope = await runtime.models.streamSimple(selected, input, { signal: runtime.signal, maxRetries: 0 }).result();
        }
        const result = JSON.parse(JSON.stringify({ message })) as JsonObject;
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result } }), ctx);
      },
      execute: async (_task, runtime, ctx) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'failed', error: { code: 'model-result-unknown', message: 'request intent was entered; no automatic replay' } } }), ctx),
    },
    abort: async (_task, runtime, ctx) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
  });
  const extension = defineExtension({ name: 'owned-lease-fixture', tasks: [childTask], tools: [defineTool({
    name: 'lease_probe', description: 'Exercise one original SDK model child', parameters: Type.Object({}),
    execute: async (_args, api, ctx) => {
      let claimedOwner = api.taskId;
      if (options.admission === 'tool-kind' || options.admission === 'wrong-owner-input') {
        const realTool = await api.getTask(api.taskId, ctx); assert.ok(realTool);
        assert.equal(realTool.kind, 'pi.tool'); assert.equal(realTool.state.status, 'running');
        assert.equal((realTool.state.checkpoint as JsonObject).phase, 'execute');
        if (options.admission === 'tool-kind') {
          assert.ok(ctx.abortSignal);
          const requested = { provider: models.A.provider, modelId: models.A.id };
          const observed: AdmissionObservation = { fault: 'tool-kind', rejected: false, operationEntered: false, taskId: realTool.id,
            actualKind: realTool.kind, actualConversationId: realTool.conversationId, providedConversationId: api.conversationId,
            actualOwnerId: realTool.owner, requestedBefore: { ...requested } };
          admissions.push(observed);
          try {
            await withLease(routing, { taskId: api.taskId, conversationId: api.conversationId, signal: ctx.abortSignal }, requested, async () => {
              observed.operationEntered = true;
              const message = await routing.models.streamSimple(models.A, input, { signal: ctx.abortSignal, maxRetries: 0 }).result();
              observed.streamStopReason = message.stopReason;
            });
          } catch { observed.rejected = true; }
          return { content: [{ type: 'text', text: 'real ToolTask admission probe finished' }] };
        }
        assert.ok(realTool.owner, '真实 ToolTask 必须由实际 Generation 创建');
        const generation = await api.getTask(realTool.owner, ctx); assert.equal(generation?.kind, 'pi.generation');
        claimedOwner = realTool.owner;
      }
      const childId = await api.createTask(childTask, { caller: `tool/${api.callId}`, actionId: `tool/${api.callId}/model/1`, ownerTaskId: claimedOwner,
        provider: models.A.provider, modelId: models.A.id, mode, ...(options.admission ? { admission: options.admission } : {}) }, { ownership: { kind: 'task', taskId: api.taskId } }, ctx);
      toolCalls.push({ taskId: api.taskId, childId });
      const receipt = await api.waitForTask(childId, ctx);
      assert.equal(receipt.state.outcome.status, 'completed', '原模型子任务必须正式收束，不能只靠夹具响应');
      if (options.admission) {
        const result = receipt.state.outcome.result as JsonObject;
        const message = result.message as unknown as AssistantMessage | undefined;
        return { content: [{ type: 'text', text: message ? messageText(message) || `refused:${message.stopReason}` : 'model child admission probe finished' }],
          ...(message && message.stopReason === 'stop' ? { usage: message.usage } : {}) };
      }
      const message = (receipt.state.outcome.result as JsonObject).message as unknown as AssistantMessage;
      return { content: [{ type: 'text', text: messageText(message) || `refused:${message.stopReason}` }], ...(mode === 'owned' ? { usage: message.usage } : {}) };
    },
  })] });
  const registry = createRegistry(); registry.install(routing.extension); registry.install(extension);
  const storage = await openNodeJsonlStorage(join(directory, 'runtime'), context, { fsync: true });
  const harness = await Harness.open(storage, { models: routing.models, registry,
    settings: { retry: { maxRetries: 0 }, stream: { maxRetries: 0 }, toolExecution: 'sequential' } }, context);
  routing.attach(harness);
  const root = await harness.root(context, { agent: { model: { provider: models.controller.provider, modelId: models.controller.id },
    thinkingLevel: 'off', extensions: [routing.extension, extension] } });
  if (options.admission === 'wrong-conversation') {
    const other = await harness.createConversation({ ownership: { kind: 'ownerless' } }, context);
    otherConversationId = other.id;
  }
  const run = async () => {
    const submission = await root.submit({ type: 'input', content: 'one original user submission', requestId: 'owned-lease-single-request' }, context);
    const receipt = await submission.wait(context); await root.waitForIdle(context); assert.equal(receipt.status, 'done'); return receipt;
  };
  const targetRequests = () => requests.filter((request) => request.model !== models.controller.id);
  const targetForwards = () => forwarded.filter((request) => request.model.id !== models.controller.id);
  const childMessage = async () => {
    assert.equal(toolCalls.length, 1); const child = await harness.getTask(toolCalls[0]!.childId, context); assert.ok(child);
    assert.equal(child.owner, toolCalls[0]!.taskId); assert.equal(child.conversationId, root.id); assert.equal(child.state.status, 'terminal');
    assert.equal(child.state.outcome?.status, 'completed');
    return (child.state.outcome?.result as JsonObject).message as unknown as AssistantMessage;
  };
  const close = async () => {
    release.resolve(); await harness.close(context); server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve())); await rm(directory, { recursive: true, force: true });
  };
  return { routing, models, runtime, harness, root, requests, forwarded, captures, toolCalls, partial, release, run, close, targetRequests, targetForwards, childMessage, admissions };
}

await test('owned lease：真实 ToolTask 子任务沿原 ModelRuntime 同步流/原 signal 请求并保存真实结果', { timeout: 15000 }, async (t) => {
  const h = await fixture('owned', { holdTarget: true }); t.after(h.close);
  const running = h.run();
  await Promise.race([h.partial.promise, running.then(() => { throw new Error('未收到真实 SDK text_delta，原运行已提前结束'); })]);
  assert.equal(h.targetRequests().length, 1, '目标 HTTP 已收到请求，但服务端终态仍被夹具持有');
  assert.ok(h.captures[0]!.events.some((event) => event.type === 'text_delta'));
  h.release.resolve(); await running;
  const message = await h.childMessage(); assert.equal(message.stopReason, 'stop'); assert.equal(messageText(message), 'actual-owned-stream-lease-A');
  assert.equal(message.provider, h.models.A.provider); assert.equal(message.model, h.models.A.id);
  assert.deepEqual(h.targetRequests().map((request) => [request.model, request.authOk]), [['lease-A', true]]);
  const forward = h.targetForwards(); assert.equal(forward.length, 1);
  assert.strictEqual(forward[0]!.options?.signal, h.captures[0]!.signal, '原 TaskRuntime signal 必须到原 runtime');
  assert.equal(forward[0]!.options?.reasoning, 'low', '不能套 Generation 的 off 覆写显式单次 reasoning');
  assert.equal(forward[0]!.options?.maxTokens, 19); assert.equal(forward[0]!.options?.temperature, 0.25); assert.equal(forward[0]!.options?.maxRetries, 0);
  assert.deepEqual(forward[0]!.input, input);
  assert.equal(h.captures[0]!.afterScope?.stopReason, 'error', '作用域结束立即撤销 lease，即使原 invocation 尚未结束');
  assert.equal(h.captures[0]!.owner, h.toolCalls[0]!.taskId);
  const owner = await h.harness.getTask(h.toolCalls[0]!.taskId, context); assert.equal(owner?.kind, 'pi.tool');
  const entries = (await h.root.context(context)).entries;
  assert.ok(entries.some((entry) => entry.kind === ToolResultEntry.kind && entry.byTaskId === h.toolCalls[0]!.taskId && JSON.stringify(entry).includes('actual-owned-stream-lease-A')));
  assert.equal(h.requests.filter((request) => request.model === 'lease-controller').length, 2, '原 Generation 两次请求仍走已绑定通路');
  await h.captures[0]!.end;
  assert.equal(h.captures[0]!.signal.aborted, true, '正常结束同样终止 invocation signal，不能误称产品取消');
  const before = h.requests.length;
  const stale = await h.routing.models.streamSimple(h.models.A, input, { signal: h.captures[0]!.signal, maxRetries: 0 }).result();
  assert.equal(stale.stopReason, 'error');
  let staleBodyEntered = false;
  await assert.rejects(withLease(h.routing, h.captures[0]!.runtime, { provider: h.models.A.provider, modelId: h.models.A.id }, async () => {
    staleBodyEntered = true;
  }), '已结束的真实 runtime 不能重新认领');
  assert.equal(staleBodyEntered, false, '拒绝必须发生在 operation body 之前');
  assert.equal(h.requests.length, before, '旧 signal 和重新登记都不得访问 HTTP');
});

for (const mode of ['missing-lease', 'wrong-ref', 'wrong-signal'] as const) {
  await test(`${mode}：真实 model child 不得绕过认领，目标 HTTP/原 runtime 转交均为 0`, { timeout: 15000 }, async (t) => {
    const h = await fixture(mode); t.after(h.close); await h.run();
    assert.equal((await h.childMessage()).stopReason, 'error');
    assert.equal(h.targetRequests().length, 0); assert.equal(h.targetForwards().length, 0, '必须在原 ModelRuntime.streamSimple 之前拒绝');
    assert.equal(h.requests.length, 2, '这两条仅是原 Generation 请求；不能把它们冒称目标模型 HTTP=0');
    assert.ok(h.requests.every((request) => request.model === 'lease-controller' && request.authOk));
  });
}

await test('没有任何 lease 的普通 signal：物理模型也不得以未绑定推断 direct，HTTP 总数为 0', { timeout: 15000 }, async (t) => {
  const h = await fixture(); t.after(h.close);
  assert.equal((await h.harness.inspect(context)).scheduling, 'paused');
  const message = await h.routing.models.streamSimple(h.models.A, input, { signal: new AbortController().signal, maxRetries: 0 }).result();
  assert.equal(message.stopReason, 'error'); assert.equal(h.requests.length, 0); assert.equal(h.forwarded.length, 0);
});

await test('Generation 原绑定保持：无 owned child 的正式 user 请求仍真实完成，不给未绑定旁路', { timeout: 15000 }, async (t) => {
  const h = await fixture('owned', { emitTool: false }); t.after(h.close); await h.run();
  assert.equal(h.captures.length, 0); assert.equal(h.requests.length, 1); assert.equal(h.requests[0]!.model, 'lease-controller');
  assert.equal(h.forwarded.length, 1); assert.ok(h.forwarded[0]!.options?.signal);
  const view = await h.root.context(context); assert.ok(view.messages.some((message) => message.role === 'assistant' && messageText(message) === 'controller-finished'));
  const refused = await h.routing.models.streamSimple(h.models.controller, input, { signal: new AbortController().signal, maxRetries: 0 }).result();
  assert.equal(refused.stopReason, 'error'); assert.equal(h.requests.length, 1);
});


// 身份登记反例：仅用公开真实 task/conversation 和真实原始输入分支；没有手造 TaskRecord。
for (const fault of ['wrong-conversation', 'tool-kind', 'nonmodel-kind', 'wrong-owner-input', 'wrong-registered-ref'] as const) {
  await test(`lease registration ${fault}: operation 前拒绝，主动 HTTP 0，原 Generation 仍两请求`, { timeout: 15000 }, async (t) => {
    const h = await fixture('owned', { admission: fault }); t.after(h.close); await h.run();
    assert.equal(h.admissions.length, 1, '必须实际执行到登记探针');
    const observed = h.admissions[0]!;
    assert.equal(observed.fault, fault); assert.equal(observed.rejected, true, '不能只靠随后 stream ref 检查掩盖登记时未核身份');
    assert.equal(observed.operationEntered, false, '拒绝必须发生在 operation body 之前');
    assert.equal(h.targetRequests().length, 0); assert.equal(h.targetForwards().length, 0);
    assert.equal(h.requests.length, 2); assert.ok(h.requests.every((request) => request.model === 'lease-controller' && request.authOk));
    const task = await h.harness.getTask(observed.taskId, context); assert.ok(task);
    assert.equal(task.kind, observed.actualKind); assert.equal(task.conversationId, observed.actualConversationId);
    assert.equal(task.state.status, 'terminal'); assert.equal(task.state.outcome?.status, 'completed');
    if (fault === 'tool-kind') {
      assert.equal(task.kind, 'pi.tool'); assert.equal(h.toolCalls.length, 0); assert.equal(h.captures.length, 0);
    } else {
      assert.equal(h.toolCalls.length, 1); assert.equal(task.id, h.toolCalls[0]!.childId); assert.equal(task.owner, h.toolCalls[0]!.taskId);
      const stored = task.input as JsonObject; assert.equal(stored.admission, fault);
      assert.deepEqual((task.state.outcome?.result as JsonObject).admission, JSON.parse(JSON.stringify(observed)), '外层断言核原 child 持久结果，不依赖被 SDK 吞掉的工具内 assert');
      assert.equal(task.kind, fault === 'nonmodel-kind' ? 'dcode.lease-nonmodel-fixture' : 'dcode.extension-model');
      if (fault === 'wrong-owner-input') {
        assert.notEqual(task.owner, stored.ownerTaskId); assert.equal(stored.ownerTaskId, observed.inputOwnerTaskId);
        const claimed = await h.harness.getTask(stored.ownerTaskId as TaskId, context); assert.equal(claimed?.kind, 'pi.generation');
      } else assert.equal(task.owner, stored.ownerTaskId);
      if (fault === 'wrong-conversation') {
        assert.notEqual(observed.actualConversationId, observed.providedConversationId);
        assert.ok(await h.harness.conversation(observed.providedConversationId, context), '错报的是另一条真实 conversation ID');
      } else assert.equal(observed.actualConversationId, observed.providedConversationId);
      if (fault === 'wrong-registered-ref') {
        assert.equal(stored.modelId, 'lease-A'); assert.equal(observed.requestedBefore.modelId, 'lease-B');
      }
    }
  });
}

await test('lease ref 在合法登记后改成 B：不得扩大原 A 认领，转交/目标 HTTP 0，Generation 仍两请求', { timeout: 15000 }, async (t) => {
  const h = await fixture('owned', { admission: 'mutated-ref' }); t.after(h.close); await h.run();
  assert.equal(h.admissions.length, 1); const observed = h.admissions[0]!;
  assert.equal(observed.rejected, false, '原 A 登记合法，不能以全拒绝冒充 ref 快照保护');
  assert.equal(observed.operationEntered, true); assert.equal(observed.requestedBefore.modelId, 'lease-A'); assert.equal(observed.requestedAfter?.modelId, 'lease-B');
  assert.equal(observed.streamStopReason, 'error'); assert.equal(h.targetRequests().length, 0); assert.equal(h.targetForwards().length, 0);
  assert.equal((await h.childMessage()).stopReason, 'error');
  assert.equal(h.requests.length, 2); assert.ok(h.requests.every((request) => request.model === 'lease-controller' && request.authOk));
});

await test('同 signal 的重复 active scope 必须拒绝且不能清掉原 lease：内层 HTTP 0，外层 A 仍真实一次', { timeout: 15000 }, async (t) => {
  const h = await fixture('owned', { admission: 'duplicate-active' }); t.after(h.close); await h.run();
  assert.equal(h.admissions.length, 1); const observed = h.admissions[0]!;
  assert.equal(observed.rejected, false); assert.equal(observed.operationEntered, true, '原 scope 合法进入');
  assert.equal(observed.duplicateRejected, true); assert.equal(observed.duplicateOperationEntered, false, '相同 ref/signal/task 的重入也不能覆盖');
  assert.equal(observed.afterDuplicateTargets, 0); assert.equal(observed.afterDuplicateForwards, 0);
  assert.equal(observed.streamStopReason, 'stop', '内层拒绝后原外层 lease 仍有效');
  assert.equal(observed.afterScopeStopReason, 'error', '外层 finally 后认领撤销');
  assert.equal(messageText(await h.childMessage()), 'actual-owned-stream-lease-A');
  assert.deepEqual(h.targetRequests().map((request) => [request.model, request.authOk]), [['lease-A', true]]);
  assert.equal(h.targetForwards().length, 1); assert.strictEqual(h.targetForwards()[0]!.options?.signal, h.captures[0]!.signal);
  assert.equal(h.requests.filter((request) => request.model === 'lease-controller').length, 2);
});
