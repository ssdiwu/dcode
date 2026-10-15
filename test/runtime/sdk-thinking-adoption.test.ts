// 公开 Auto 准入与真实 SDK 的同一条路径：A 的 high 不得借 SDK 默认映射带给未核实该档位的 B。
// 使用隔离 Durable 状态、真实供应商协议与本地 HTTP，不读取真实账户或发付费探针。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Api, Model } from '@earendil-works/pi-ai';
import { DCodeApplication } from '../../src/application/index.ts';
import type { SdkRequestTarget } from '../../src/application/index.ts';
import { seedState } from '../../src/application/seed.ts';
import { createPresetPiBackend, PiCapabilityPort, ProviderDirectoryStore, registerPresetProviders } from '../../src/adapters/pi/index.ts';

for (const high of ['missing', 'unsupported', 'supported'] as const) await test(`Auto A(high)→B(${high})：正式档位与实际 HTTP 一起重核，不探针或重投`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dcode-sdk-thinking-'));
  const keys = { A: 'isolated-thinking-A-key', B: 'isolated-thinking-B-key' };
  const requests: { source: 'A' | 'B'; model: string; authOk: boolean; effort: string | null; body: unknown; reply: string }[] = [];
  const invalidRequests: { method: string | undefined; path: string | undefined; bytes: number }[] = [];
  const unrelatedRequests: { method: string | undefined; path: string | undefined }[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      const payload = Buffer.concat(chunks);
      // 夹具只接受本次模型 POST；异常传输用有限证据和明确响应呈现，不以 uncaught JSON 掩盖阶段。
      if (req.method !== 'POST' || !['/A/v1/responses', '/B/v1/chat/completions'].includes(req.url ?? '')) {
        unrelatedRequests.push({ method: req.method, path: req.url });
        res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":{"message":"fixture-not-found"}}'); return;
      }
      if (payload.length === 0) {
        invalidRequests.push({ method: req.method, path: req.url, bytes: payload.length });
        res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":{"message":"fixture-invalid-model-request"}}'); return;
      }
      const body = JSON.parse(payload.toString('utf8'));
      const source = req.url?.startsWith('/A/') ? 'A' : 'B';
      const reply = `actual-${source}-${requests.length + 1}`;
      const authOk = req.headers.authorization === `Bearer ${keys[source]}`;
      requests.push({ source, model: body.model, authOk, effort: body.reasoning?.effort ?? null, body, reply });
      if (!authOk) { res.writeHead(401); res.end('{"error":{"message":"fixture wrong source credential"}}'); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (source === 'A') {
        const message = { id: `message-${reply}`, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: reply }], status: 'completed' };
        const events = [
          { type: 'response.created', response: { id: reply, status: 'in_progress' } },
          { type: 'response.output_item.added', output_index: 0, item: { ...message, content: [{ type: 'output_text', text: '' }], status: 'in_progress' } },
          { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: message.id, delta: reply },
          { type: 'response.output_item.done', output_index: 0, item: message },
          { type: 'response.completed', response: { id: reply, status: 'completed', model: body.model, output: [message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
        ];
        res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
      } else {
        const events = [
          { id: reply, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: reply }, finish_reason: null }] },
          { id: reply, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
        ];
        res.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const cipher = { isAvailable: () => true, encrypt: (text: string) => Buffer.from(text), decrypt: (bytes: Buffer) => bytes.toString() };
  const store = new ProviderDirectoryStore({ stateDir: directory }, cipher, { catalogBaseUrl: `${origin}/catalog` });
  const identities = { A: { sourceId: 'openai', modelId: 'thinking-A' }, B: { sourceId: 'openrouter', modelId: 'thinking-B' } };
  for (const source of ['A', 'B'] as const) await store.commitCredential(identities[source].sourceId, { type: 'api_key', key: keys[source] });
  const presets = registerPresetProviders();
  const presetA = presets.find((p) => p.id === identities.A.sourceId)!;
  const presetB = presets.find((p) => p.id === identities.B.sourceId)!;
  const models = Object.fromEntries((['A', 'B'] as const).map((source) => [source, {
    id: identities[source].modelId, name: `Thinking ${source}`, provider: identities[source].sourceId,
    api: source === 'A' ? 'openai-responses' : 'openai-completions', baseUrl: `${origin}/${source}/v1`,
    reasoning: true, thinkingLevelMap: {
      low: 'low', medium: 'medium',
      ...(source === 'A' || high === 'supported' ? { high: 'high' } : high === 'unsupported' ? { high: null } : {}),
    },
    input: ['text'], contextWindow: 128000, maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }])) as Record<'A' | 'B', Model<Api>>;
  let exhaustedA = false;
  let handoffAtSdk = false;
  const admissions: { prepared: string; target: SdkRequestTarget | null }[] = [];
  const backend = createPresetPiBackend({
    stateDir: directory, selection: { providerId: identities.A.sourceId, modelId: models.A.id },
    preset: presetA, model: models.A, info: { id: models.A.id, name: models.A.name }, store,
    additionalSources: [{ kind: 'preset', providerId: identities.B.sourceId, preset: presetB, models: [models.B] }],
    admitRequest: async (input) => {
      // 发送前应用配置时 A 仍可用；到真实 SDK 边界才耗尽，保证反例覆盖已捕获的 A/high。
      if (handoffAtSdk) exhaustedA = true;
      const result = await app.admitSdkRequest(input);
      admissions.push({ prepared: `${input.sourceId}/${input.modelId}`, target: result.target });
      return result;
    },
  });
  const app = new DCodeApplication(backend, { load: async () => ({ status: 'missing' }), save: async () => {} }, () => {
    const state = seedState(); state.workspaces[0]!.folders = [directory]; return state;
  }, undefined, undefined, undefined, undefined, undefined, {
    sourcePort: { list: async () => (['A', 'B'] as const).map((source) => ({
      ...identities[source], sourceLabel: source, configured: true,
      models: [{ modelId: models[source].id, modelLabel: models[source].name }],
    })) },
    capabilityPort: new PiCapabilityPort({ presets, effectiveModel: async (identity) => Object.values(models).find((m) => m.provider === identity.sourceId && m.id === identity.modelId) ?? null }),
    quotaPort: {
      support: () => ({}),
      read: async ({ candidates }) => candidates.map((identity) => ({
        ...identity, state: exhaustedA && identity.sourceId === identities.A.sourceId ? 'exhausted' : 'available',
        poolId: `pool-${identity.sourceId}`, windowLabel: '受控当次额度', updatedAt: 1, reason: null,
      })),
    },
  });
  try {
    await app.init();
    await app.updateSettings({ modelCandidates: [identities.A, identities.B] });
    const session = await app.createSession({ taskId: (await app.getSnapshot()).tasks[0]!.id });
    const send = async (text: string, count: number) => {
      assert.equal((await app.sendMessage({ sessionId: session.id, text, mode: 'follow-up' })).receipt.status, 'accepted');
      const deadline = Date.now() + 5000;
      let snapshot = await app.getSnapshot();
      while ((requests.length < count || snapshot.runs[session.id]?.status !== 'ready'
        || !snapshot.timelines[session.id]!.some((entry) => entry.kind === 'message' && entry.role === 'assistant' && entry.text === requests[count - 1]?.reply)) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        snapshot = await app.getSnapshot();
      }
      assert.equal(requests.length, count, '每份已接收输入只产生这一次真实请求');
      assert.equal(snapshot.runs[session.id]?.status, 'ready', '真实请求已收束');
      assert.ok(snapshot.timelines[session.id]!.some((entry) => entry.kind === 'message' && entry.role === 'assistant' && entry.text === requests[count - 1]!.reply), '本次真实回复归入原会话');
      return snapshot;
    };
    await send('原输入一', 1);
    assert.equal((await app.setSessionThinkingLevel({ sessionId: session.id, level: 'high' })).thinkingLevel, 'high', 'A 的档位已逐项核实');
    await send('原输入二 high', 2);
    assert.equal(requests[1]!.source, 'A');
    assert.equal(requests[1]!.effort, 'high', 'A 的实际 SDK/HTTP 确实已使用 high');
    handoffAtSdk = true;
    const after = await send('原下一输入三', 3);
    const b = requests[2]!;
    assert.equal(b.source, 'B');
    assert.equal(b.model, models.B.id);
    assert.equal(b.authOk, true, 'B 使用自己的认证');
    assert.equal(requests.filter((r) => r.source === 'A').length, 2, '切换后 A 无新增请求');
    assert.ok(admissions.some((a) => a.prepared === `${identities.A.sourceId}/${models.A.id}` && a.target?.modelId === models.B.id), '在已准备 A 的实际 SDK 边界改采 B');
    assert.equal(b.effort, high === 'supported' ? 'high' : 'none', 'B 未核实或明确不支持 high 时不带旧 high，也不自行降到另一个思考档位');
    assert.equal(after.sessionModels[session.id]!.thinkingLevel, high === 'supported' ? 'high' : null, '正式选择与实际请求的档位一致');
    const body = JSON.stringify(b.body);
    assert.ok(body.includes('原输入一') && body.includes('actual-A-1') && body.includes('原输入二 high') && body.includes('actual-A-2') && body.includes('原下一输入三'), '原输入和已完成回复完整保留，无重输或新会话');
    assert.deepEqual(invalidRequests, [], '不能由额外空请求或错误协议探测冒充这三次实际请求');
  } finally {
    await app.flush();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (invalidRequests.length) console.error('[invalid-controlled-transport]', JSON.stringify(invalidRequests));
    if (unrelatedRequests.length) console.error('[unrelated-controlled-http]', JSON.stringify(unrelatedRequests));
    await rm(directory, { recursive: true, force: true });
  }
});
