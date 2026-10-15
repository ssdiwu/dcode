// ModelRuntime→单一 Durable 运行的真实路由状态/工具/关闭重开；全部账户、HTTP 和文件隔离。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Api, AssistantMessage, Credential, DeferredHandle, Model, Provider } from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { ModelRouteRequest } from '@earendil-works/pi-coding-agent';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import type { GenerationCheckpoint, Storage } from '@earendil-works/pi-durable';
import { StorageRejected } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { DurableModelRouting, PiExecutionSession, registerPresetProviders } from '../../src/adapters/pi/index.ts';
import type { PiSessionOptions } from '../../src/adapters/pi/index.ts';

async function fixture(options: { holdB?: boolean; invalidState?: boolean; failAOnce?: boolean; holdFirstRoute?: boolean; smallBContext?: boolean; deferredB?: boolean; rotatingHandle?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dcode-durable-route-'));
  const requests: { source: 'A' | 'B'; authOk: boolean; body: unknown; operation?: string }[] = [];
  const routes: { reason: string; before: unknown; next: number; failed: boolean }[] = [];
  let holdB = options.holdB === true;
  let failAOnce = options.failAOnce === true;
  let polls = 0;
  let releaseRoute!: () => void;
  const routeGate = options.holdFirstRoute ? new Promise<void>((resolve) => { releaseRoute = resolve; }) : null;
  const keys = { A: 'isolated-durable-A-key', B: 'isolated-durable-B-key' };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      if (!req.url?.startsWith('/A/') && !req.url?.startsWith('/B/')) { res.writeHead(404); res.end(); return; }
      const source = req.url?.startsWith('/A/') ? 'A' : 'B';
      const authOk = req.headers.authorization === `Bearer ${keys[source]}`;
      if (req.url?.startsWith('/B/job/')) {
        requests.push({ source, authOk, body: { id: req.url.split('/').at(-1) }, operation: req.method === 'DELETE' ? 'cancel' : 'poll' });
        if (req.method !== 'DELETE') polls += 1;
        res.writeHead(authOk ? 200 : 401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: req.method === 'DELETE' ? 'cancelled' : holdB || (options.rotatingHandle && polls === 1) ? 'queued' : 'completed',
          ...(options.rotatingHandle ? { pollAfterMs: 60, data: { revision: polls } } : {}), text: 'actual-deferred-B-nonce' }));
        return;
      }
      const payload = Buffer.concat(chunks).toString('utf8');
      if (!payload) {
        // 只记录本模型通路未完整接收的正文；不生成假响应，也不让夹具进程崩溃。
        requests.push({ source, authOk, operation: 'incomplete', body: { method: req.method, path: req.url } });
        res.writeHead(400); res.end('{"error":{"message":"fixture request body was not received"}}'); return;
      }
      const body = JSON.parse(payload);
      requests.push({ source, authOk, body });
      if (!authOk) { res.writeHead(401); res.end('{"error":{"message":"wrong fixture source credential"}}'); return; }
      if (source === 'A' && failAOnce) { failAOnce = false; res.writeHead(503); res.end('{"error":{"message":"503 fixture retryable unavailable"}}'); return; }
      if (source === 'B' && options.deferredB) {
        res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"id":"isolated-deferred-B","status":"queued"}'); return;
      }
      if (source === 'B' && holdB) return; // 服务已收到但结果尚未知；真实 close 必须取消、保留准备点。
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const id = `actual-${source}-${requests.length}`;
      if (source === 'A') {
        const item = { id: `item-${id}`, type: 'function_call', call_id: `call-${id}`, name: 'write', arguments: JSON.stringify({ path: 'once.txt', content: 'already-written' }), status: 'completed' };
        const events = [
          { type: 'response.created', response: { id, status: 'in_progress' } },
          { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } },
          { type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id, delta: item.arguments },
          { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response: { id, status: 'completed', model: body.model, output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
        ];
        res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
      } else {
        const events = [
          { id, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: id }, finish_reason: null }] },
          { id, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
        ];
        res.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const credentials = new Map<string, Credential>([['openai', { type: 'api_key', key: keys.A }], ['openrouter', { type: 'api_key', key: keys.B }]]);
  const runtime = await ModelRuntime.create({ credentials: {
    read: async (id) => credentials.get(id), list: async () => [...credentials].map(([providerId, value]) => ({ providerId, type: value.type })),
    modify: async (id, change) => { const value = await change(credentials.get(id)); if (value) credentials.set(id, value); return credentials.get(id); },
    delete: async (id) => { credentials.delete(id); },
  }, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  // 所有覆盖同步完成后才 await availability；ModelRuntime 默认 authContext 不用于环境/文件认证。
  const presets = registerPresetProviders();
  for (const preset of presets) runtime.registerNativeProvider(preset.provider);
  const models: Record<'A' | 'B', Model<Api>> = {
    A: { id: 'route-A', name: 'Route A', provider: 'openai', api: 'openai-responses', baseUrl: `${origin}/A/v1`, reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    B: { id: 'route-B', name: 'Route B', provider: 'openrouter', api: 'openai-completions', baseUrl: `${origin}/B/v1`, reasoning: false, input: ['text'], contextWindow: options.smallBContext ? 512 : 128000, maxTokens: options.smallBContext ? 64 : 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
  };
  for (const source of ['A', 'B'] as const) {
    const preset = presets.find((p) => p.id === models[source].provider)!;
    let provider: Provider = { ...preset.provider, getModels: () => [models[source]], getAllModels: () => [models[source]] };
    if (source === 'B' && options.deferredB) {
      // 公开 Provider 合同的隔离 HTTP 作业；不冒称 builtin 服务商支持 deferred。
      const message = (status: string, handle: DeferredHandle): AssistantMessage => ({ role: 'assistant', api: models.B.api,
        provider: models.B.provider, model: models.B.id, timestamp: Date.now(),
        content: status === 'completed' ? [{ type: 'text', text: 'actual-deferred-B-nonce' }] : [],
        stopReason: status === 'completed' ? 'stop' : 'deferred', ...(status === 'completed' ? {} : { deferred: handle }),
        usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
      const responseStream = (read: () => Promise<AssistantMessage>) => {
        const out = createAssistantMessageEventStream();
        void read().then((value) => { out.push({ type: 'done', reason: value.stopReason as 'stop' | 'deferred', message: value }); out.end(value); }).catch((error) => {
          const failure: AssistantMessage = { ...message('completed', { provider: models.B.provider, modelId: models.B.id, api: models.B.api, id: 'unreceived' }),
            content: [], stopReason: error instanceof Error && error.name === 'AbortError' ? 'aborted' : 'error', errorMessage: 'isolated deferred request did not finish' };
          out.push({ type: 'error', reason: failure.stopReason as 'error' | 'aborted', error: failure }); out.end(failure);
        });
        return out;
      };
      provider = { ...provider,
        streamSimple: (model, input, opt) => responseStream(async () => {
          const response = await fetch(`${origin}/B/job-start`, { method: 'POST', signal: opt?.signal,
            headers: { authorization: `Bearer ${opt?.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: model.id, messages: input.messages }) });
          assert.equal(response.status, 200); const value = await response.json() as { id: string; status: string };
          return message(value.status, { provider: model.provider, modelId: model.id, api: model.api, id: value.id, pollAfterMs: 100 });
        }),
        fetchDeferred: (_model, handle, opt) => responseStream(async () => {
          const response = await fetch(`${origin}/B/job/${handle.id}`, { signal: opt?.signal, headers: { authorization: `Bearer ${opt?.apiKey}` } });
          assert.equal(response.status, 200); const value = await response.json() as { status: string; pollAfterMs?: number; data?: { revision: number } };
          return message(value.status, options.rotatingHandle ? { ...handle, pollAfterMs: value.pollAfterMs, data: value.data } : handle);
        }),
        cancelDeferred: async (_model, handle, opt) => {
          const response = await fetch(`${origin}/B/job/${handle.id}`, { method: 'DELETE', signal: opt?.signal, headers: { authorization: `Bearer ${opt?.apiKey}` } });
          assert.equal(response.status, 200);
        },
      };
    }
    runtime.registerNativeProvider(provider);
  }
  await runtime.refresh({ allowNetwork: false });
  runtime.registerVirtualModel({ provider: 'dcode-route', id: 'chosen', name: 'Chosen route', contextWindow: 128000, maxTokens: 4096, input: ['text'],
    async route(request: ModelRouteRequest<{ count: number }>) {
      const next = (request.state?.count ?? 0) + 1;
      routes.push({ reason: request.reason, before: request.state ?? null, next, failed: request.failed !== undefined });
      if (routeGate && routes.length === 1) await routeGate;
      const state = options.invalidState ? { count: next, invalid: () => next } : { count: next };
      return { model: request.reason === 'direct' || next > 1 ? models.B : models.A, thinkingLevel: 'off', state };
    },
  });
  const virtual = runtime.getModel('dcode-route', 'chosen')!;
  assert.ok(virtual && runtime.hasConfiguredAuth('openai') && runtime.hasConfiguredAuth('openrouter'));
  let writes = 0;
  const units = new Set<PiExecutionSession>();
  const open = async (sessionId = 'session', extra: Partial<PiSessionOptions> = {}) => {
    const cwd = join(root, `project-${sessionId}`); await mkdir(cwd, { recursive: true });
    const registry = createRegistry(); registry.install(CodingTools);
    const env = new NodeExecutionEnv({ cwd });
    const write = env.writeFile.bind(env); env.writeFile = async (...args) => { writes += 1; return write(...args); };
    const unit = await PiExecutionSession.open({ directory: join(root, `runtime-${sessionId}`), cwd,
      target: { workspaceId: 'ws', taskId: 'task', sessionId }, models: runtime,
      agent: { model: { provider: virtual.provider, modelId: virtual.id }, extensions: [CodingTools] }, registry, env: async () => env, ...extra });
    units.add(unit); return unit;
  };
  const until = async (predicate: () => Promise<boolean>, label: string) => {
    const deadline = Date.now() + 7000;
    while (!(await predicate()) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(await predicate(), true, label);
  };
  const send = async (unit: PiExecutionSession, operationId = 'same-input', text?: string) => {
    const current = await unit.read();
    const input = { target: unit.target, expected: current.control, operationId, text: text ?? `${unit.target.sessionId}: write then continue`, references: [], mode: 'follow-up' as const };
    assert.equal((await unit.submit(input)).status, 'accepted'); return input;
  };
  const close = async () => {
    for (const unit of units) await unit.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  };
  return { runtime, virtual, root, models, routes, requests, open, until, send, close, writes: () => writes, releaseB: () => { holdB = false; }, releaseRoute: () => releaseRoute?.() };
}

await test('真实 user→write→continuation：第二次路由拿到状态、独立 B 认证和已完成工具上下文', async (t) => {
  const h = await fixture(); t.after(() => h.close()); const unit = await h.open();
  const input = await h.send(unit);
  await h.until(async () => (await unit.lookupReceipt(input)).status === 'accepted' && (await unit.read()).pendingInputs === 0, '原正式输入已处理');
  assert.deepEqual(h.routes.map((r) => [r.reason, r.before, r.next]), [['user', null, 1], ['continuation', { count: 1 }, 2]]);
  assert.deepEqual(h.requests.map((r) => [r.source, r.authOk]), [['A', true], ['B', true]]);
  assert.equal(h.writes(), 1); assert.equal(await readFile(join(h.root, 'project-session/once.txt'), 'utf8'), 'already-written');
  assert.ok(JSON.stringify(h.requests[1]!.body).includes('Successfully wrote to once.txt'), '真实已完成工具正文到下一物理模型');
  const direct = await new DurableModelRouting(h.runtime, () => true).models.completeSimple(h.virtual, { messages: [{ role: 'user', content: 'direct-only', timestamp: 1 }] });
  assert.equal(direct.stopReason, 'stop'); assert.equal(h.routes.at(-1)!.reason, 'direct'); assert.equal(h.routes.at(-1)!.before, null);
  await h.send(unit, 'next-input');
  await h.until(async () => (await unit.read()).pendingInputs === 0, '新原输入也正式处理');
  assert.deepEqual(h.routes.at(-1)!.before, { count: 2 }, 'direct 不读写会话 state'); assert.equal(h.routes.at(-1)!.reason, 'user');
});

await test('计划和 state 已保存但回复未知：关闭重开只读零请求，明确继续复用计划且 write 不重做', async (t) => {
  const h = await fixture({ holdB: true }); t.after(() => h.close()); let unit = await h.open();
  const input = await h.send(unit);
  await h.until(async () => h.requests.length === 2 && h.writes() === 1, '已完成 write，下一 B 请求正在真实等待');
  await unit.close(); const requestCount = h.requests.length; const routeCount = h.routes.length;
  unit = await h.open();
  const view = await unit.read(); assert.equal(view.phase, 'paused');
  assert.equal((await unit.lookupReceipt(input)).status, 'accepted');
  await unit.read(); await unit.read();
  assert.equal(h.requests.length, requestCount); assert.equal(h.routes.length, routeCount); assert.equal(h.writes(), 1);
  h.releaseB(); await unit.resume(view.control);
  await h.until(async () => (await unit.read()).pendingInputs === 0, '原正式输入显式继续后完成');
  assert.equal(h.routes.length, routeCount, '同 task/attempt/cutoff 恢复不重复 resolve/state 递增');
  assert.deepEqual(h.requests.map((r) => r.source), ['A', 'B', 'B']); assert.equal(h.writes(), 1, '已完成 unsafe write 不重复');
  const last = JSON.stringify(h.requests.at(-1)!.body);
  assert.ok(last.includes('session: write then continue') && last.includes('Successfully wrote to once.txt'), '原输入及正式工具结果均保留');
});

await test('两条会话真实交错：各自 user/null→continuation/count1，不共享当前路由或状态', async (t) => {
  const h = await fixture(); t.after(() => h.close()); const a = await h.open('alpha'); const b = await h.open('beta');
  await Promise.all([h.send(a), h.send(b)]);
  await h.until(async () => (await a.read()).pendingInputs === 0 && (await b.read()).pendingInputs === 0, '两份原输入都完成');
  assert.equal(h.writes(), 2); assert.equal(h.requests.length, 4);
  assert.deepEqual(h.routes.filter((r) => r.reason === 'user').map((r) => r.before), [null, null]);
  assert.deepEqual(h.routes.filter((r) => r.reason === 'continuation').map((r) => r.before), [{ count: 1 }, { count: 1 }]);
  for (const session of ['alpha', 'beta']) {
    const own = h.requests.filter((r) => JSON.stringify(r.body).includes(`${session}: write then continue`));
    assert.deepEqual(own.map((r) => r.source), ['A', 'B']);
    assert.ok(own.every((r) => !JSON.stringify(r.body).includes(`${session === 'alpha' ? 'beta' : 'alpha'}: write then continue`)));
  }
});

await test('虚拟调用无 invocation 计划：不降成 direct，不访问任何真实 HTTP', async (t) => {
  const h = await fixture(); t.after(() => h.close());
  const routing = new DurableModelRouting(h.runtime, () => true);
  const message = await routing.models.streamSimple(h.virtual, { messages: [{ role: 'user', content: 'unbound', timestamp: 1 }] }, { signal: new AbortController().signal }).result();
  assert.equal(message.stopReason, 'error'); assert.equal(h.routes.length, 0); assert.equal(h.requests.length, 0);
});

await test('router 返回不可持久化状态：原输入保留失败事实，状态和计划未采纳，不发 HTTP', async (t) => {
  const h = await fixture({ invalidState: true }); t.after(() => h.close()); const unit = await h.open();
  await h.send(unit);
  await h.until(async () => (await unit.read()).pendingInputs === 0, '原正式输入已收束为真实失败');
  const view = await unit.read();
  assert.ok(view.entries.some((e) => e.failureKind === 'model-request-failed')); assert.equal(h.requests.length, 0); assert.equal(h.writes(), 0);
  const failure = view.entries.find((e) => e.failureKind === 'model-request-failed')!;
  assert.equal(failure.provider, undefined, '虚拟路由在发出之前失败，不能作为实际物理来源发布');
  assert.equal(failure.model, undefined, '不把计划或未发出标识称本次实际采用');
  assert.equal(failure.usage, undefined, '不补造未发出请求的账户计量');
});

await test('真正 503 失败后的 Durable retry：reason/failed/state 同属原输入，不重复 write', async (t) => {
  const h = await fixture({ failAOnce: true }); t.after(() => h.close());
  const unit = await h.open('retry', { settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 }, stream: { maxRetries: 0 } } });
  await h.send(unit);
  await h.until(async () => (await unit.read()).pendingInputs === 0, '同一正式输入重试后收束');
  assert.deepEqual(h.routes.map((r) => [r.reason, r.before, r.next, r.failed]), [['user', null, 1, false], ['retry', { count: 1 }, 2, true]]);
  assert.deepEqual(h.requests.map((r) => [r.source, r.authOk]), [['A', true], ['B', true]]);
  assert.equal(h.writes(), 0, '失败的 A 没执行工具，不补造工具成功');
  assert.ok(JSON.stringify(h.requests[1]!.body).includes('retry: write then continue'));
});

await test('路由计划/state 同事务被可靠拒绝：不留半份状态，也不落到真实模型请求', async (t) => {
  const h = await fixture(); t.after(() => h.close()); let kinds: string[] = [];
  const unit = await h.open('save-rejected', { openStorage: async (directory) => {
    const storage = await openNodeJsonlStorage(directory, BACKGROUND_CONTEXT, { fsync: true });
    return new Proxy(storage, { get: (target, key) => {
      if (key === 'commit') return async (writes: Parameters<typeof storage.commit>[0], context: Parameters<typeof storage.commit>[1]) => {
        const routeWrites = writes.filter((write) => write.type === 'document.create' && write.record.kind.startsWith('dcode.virtual-route-'));
        if (routeWrites.length > 0) {
          kinds = routeWrites.map((write) => write.type === 'document.create' ? write.record.kind : '');
          throw new StorageRejected('fixture routing state/plan rejected');
        }
        return target.commit(writes, context);
      };
      const member = Reflect.get(target, key); return typeof member === 'function' ? member.bind(target) : member;
    } });
  } });
  await h.send(unit);
  await h.until(async () => (await unit.read()).pendingInputs === 0, '正式输入保留真实失败事实');
  assert.deepEqual(kinds.sort(), ['dcode.virtual-route-plan', 'dcode.virtual-route-state']);
  assert.equal(h.requests.length, 0); assert.equal(h.writes(), 0);
});

await test('router await 期间改选：迟到 A 计划不保存、不发 A，原输入按正式 B 配置执行', async (t) => {
  const h = await fixture({ holdFirstRoute: true }); t.after(() => h.close()); const unit = await h.open('late-choice');
  await h.send(unit);
  await h.until(async () => h.routes.length === 1, '原 router 正在真实 await');
  await unit.applySessionModel({ sourceId: h.models.B.provider, modelId: h.models.B.id, thinkingLevel: null });
  h.releaseRoute();
  await h.until(async () => (await unit.read()).pendingInputs === 0, '原输入仍沿同一运行完成');
  assert.deepEqual(h.requests.map((r) => [r.source, r.authOk]), [['B', true]]);
  assert.equal(h.writes(), 0, '未发送 A，也没有 A 工具副作用');
});

await test('物理 B 容量小于虚拟目录：按当次真实容量保留失败，不发超限 B 探测请求', async (t) => {
  const h = await fixture({ smallBContext: true }); t.after(() => h.close());
  const unit = await h.open('capacity', { settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } } });
  await h.send(unit, 'one-large-input', 'abcd'.repeat(1024));
  await h.until(async () => (await unit.read()).pendingInputs === 0, '原输入和已完成工具结果保留为容量失败');
  assert.deepEqual(h.requests.map((r) => r.source), ['A'], '不能把虚拟 128k 的展示上限当物理 B 的 512 上限');
  assert.equal(h.writes(), 1, '已有 A 工具结果不重做、不回滚');
  assert.ok((await unit.read()).entries.some((e) => e.failureKind === 'model-request-failed'));
});

await test('direct 容量不足按 Models 结果合同收束：不 reject、不发 B 探测、不写会话 state', async (t) => {
  const h = await fixture({ smallBContext: true }); t.after(() => h.close());
  const message = await new DurableModelRouting(h.runtime, () => true).models.completeSimple(h.virtual,
    { messages: [{ role: 'user', content: 'abcd'.repeat(1024), timestamp: 1 }] });
  assert.equal(message.stopReason, 'error'); assert.equal(message.api, 'pi-virtual');
  assert.equal(h.requests.length, 0); assert.deepEqual(h.routes.map((r) => [r.reason, r.before]), [['direct', null]]);
});

await test('真实 deferred 作业：暂停/重开只读不新发，继续按原 B 句柄回查且 state/write 不再推进', async (t) => {
  const h = await fixture({ deferredB: true, holdB: true, rotatingHandle: true }); t.after(() => h.close());
  let storage!: Storage;
  let unit = await h.open('deferred', { openStorage: async (directory) => {
    storage = await openNodeJsonlStorage(directory, BACKGROUND_CONTEXT, { fsync: true }); return storage;
  } });
  const input = await h.send(unit);
  await h.until(async () => (await storage.scanTasks({ kind: 'pi.generation', status: 'running' }, 100, undefined, BACKGROUND_CONTEXT)).items.some((task) => {
    const cp = task.state.status === 'running' ? task.state.checkpoint as GenerationCheckpoint : null;
    return cp?.phase === 'poll' && ((cp.handle.data as { revision?: number } | undefined)?.revision ?? 0) >= 1;
  }), 'B pending 回查的新句柄已真正写入 checkpoint');
  await unit.pause(); await unit.close();
  const before = h.requests.length; const routeCount = h.routes.length;
  unit = await h.open('deferred'); const view = await unit.read();
  assert.equal(view.phase, 'paused'); assert.equal((await unit.lookupReceipt(input)).status, 'accepted');
  await unit.read(); assert.equal(h.requests.length, before); assert.equal(h.routes.length, routeCount); assert.equal(h.writes(), 1);
  h.releaseB(); await unit.resume(view.control);
  await h.until(async () => (await unit.read()).pendingInputs === 0, '原 deferred 作业继续后收束');
  assert.deepEqual(h.requests.filter((r) => !r.operation).map((r) => [r.source, r.authOk]), [['A', true], ['B', true]], '继续回查原作业而非重建 B');
  assert.ok(h.requests.filter((r) => r.operation === 'poll').every((r) => r.source === 'B' && r.authOk));
  assert.equal(h.routes.length, routeCount); assert.equal(h.writes(), 1);
  assert.ok((await unit.read()).entries.some((e) => e.assistantText?.includes('actual-deferred-B-nonce')));
});

await test('虚拟准备期间改选物理 B 并 deferred：回查仍属 B，不丢本次已采纳身份', async (t) => {
  const h = await fixture({ deferredB: true, holdFirstRoute: true }); t.after(() => h.close()); const unit = await h.open('retarget-deferred');
  await h.send(unit); await h.until(async () => h.routes.length === 1, 'router 尚在 await');
  await unit.applySessionModel({ sourceId: h.models.B.provider, modelId: h.models.B.id, thinkingLevel: null }); h.releaseRoute();
  await h.until(async () => (await unit.read()).pendingInputs === 0, '同一输入采用 B 后完成 deferred 回查');
  assert.deepEqual(h.requests.filter((r) => !r.operation).map((r) => r.source), ['B']);
  assert.ok(h.requests.some((r) => r.operation === 'poll' && r.authOk));
  assert.ok((await unit.read()).entries.some((e) => e.assistantText?.includes('actual-deferred-B-nonce')));
});

await test('公开 Durable abort：已采用 B 的 deferred 作业取消也落 B，不按旧虚拟 ref 发送', async (t) => {
  const h = await fixture({ deferredB: true, holdB: true, holdFirstRoute: true, rotatingHandle: true });
  const storage = await openNodeJsonlStorage(join(h.root, 'abort-runtime'), BACKGROUND_CONTEXT, { fsync: true });
  const routing = new DurableModelRouting(h.runtime, () => true); const registry = createRegistry(); registry.install(routing.extension);
  const harness = await Harness.open(storage, { models: routing.models, registry, settings: { retry: { maxRetries: 0 } } }, BACKGROUND_CONTEXT);
  routing.attach(harness);
  t.after(async () => { await harness.close(BACKGROUND_CONTEXT); await storage.close(BACKGROUND_CONTEXT); await h.close(); });
  const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: h.virtual.provider, modelId: h.virtual.id }, extensions: [routing.extension] } });
  const submission = await root.submit({ type: 'input', content: 'cancel original B job', requestId: 'one-deferred' }, BACKGROUND_CONTEXT);
  await h.until(async () => h.routes.length === 1, '原 router 正在 await');
  await root.configure({ model: { provider: h.models.B.provider, modelId: h.models.B.id } }, BACKGROUND_CONTEXT); h.releaseRoute();
  // inspect 的任务状态摘要不是 TaskRecord；按公开 storage 的正式 checkpoint 核前置。
  await h.until(async () => (await storage.scanTasks({ kind: 'pi.generation', status: 'running' }, 100, undefined, BACKGROUND_CONTEXT)).items.some((task) => {
    const cp = task.state.status === 'running' ? task.state.checkpoint as GenerationCheckpoint : null;
    return cp?.phase === 'poll' && ((cp.handle.data as { revision?: number } | undefined)?.revision ?? 0) >= 1;
  }), 'pending 回查更新后的真实句柄已进入公开 checkpoint');
  await root.abort(BACKGROUND_CONTEXT);
  assert.deepEqual(h.requests.filter((r) => r.operation === 'cancel').map((r) => [r.source, r.authOk]), [['B', true]]);
  assert.ok(h.requests.every((r) => r.source === 'B'), '包括被中止的 HTTP 前置，均不得误投 A');
  assert.equal((await submission.status(BACKGROUND_CONTEXT)).status, 'unanswered');
  assert.deepEqual(h.requests.filter((r) => !r.operation).map((r) => r.source), ['B'], 'abort 不重投旧请求');
});

await test('deferred poll 更新同作业句柄后继续：新数据持久化，下一回查仍落 B 并真实完成', async (t) => {
  const h = await fixture({ deferredB: true, rotatingHandle: true }); t.after(() => h.close()); const unit = await h.open('rotating-handle');
  await h.send(unit);
  await h.until(async () => (await unit.read()).pendingInputs === 0, '同一 B 作业两次回查后收束');
  assert.equal(h.requests.filter((r) => r.operation === 'poll').length, 2, '首次合法 pending handle 更新后必须还能回查');
  assert.ok(h.requests.filter((r) => r.operation === 'poll').every((r) => r.source === 'B' && r.authOk));
  assert.equal(h.routes.length, 2); assert.equal(h.writes(), 1);
  assert.ok((await unit.read()).entries.some((e) => e.assistantText?.includes('actual-deferred-B-nonce')));
});
