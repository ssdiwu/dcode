// P1-1 最终消费者：真实 Pi/Durable 端口在 SDK 准入改用 B 时，协议、凭据与上下文一并属于 B。
// 全部状态及 HTTP 端点隔离，不读真实账户；自动路由判定本身由 model-request-gate 覆盖。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Api, Model } from '@earendil-works/pi-ai';
import { createPresetPiBackend, createRealPiBackend, ModelSetupStore, ProviderDirectoryStore, registerPresetProviders } from '../../src/adapters/pi/index.ts';

for (const initial of ['preset', 'custom', 'custom-cross-api'] as const) await test(`SDK ${initial} 采用另一来源：用 B 的协议与独立凭据，只发下一请求且保留原上下文`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dcode-sdk-route-'));
  const requests: { source: string; path: string; model: string; authOk: boolean; body: unknown }[] = [];
  const keys = { A: 'isolated-route-A-key', B: 'isolated-route-B-key' };
  const markers = { A: 'actual-A-reply', B: 'actual-B-reply' };
  const unrelated: Array<{ method: string | undefined; path: string | undefined }> = [];
  const server = http.createServer((req, res) => {
    // 本地端口可收到根路径 GET；它不是受控模型请求，不能把空正文交给JSON模型解码器。
    if (req.method === 'GET' && req.url === '/') {
      unrelated.push({ method: req.method, path: req.url }); res.writeHead(404); res.end(); return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const source = req.url?.startsWith('/A/') ? 'A' : 'B';
      const authOk = req.headers.authorization === `Bearer ${keys[source]}`;
      requests.push({ source, path: req.url ?? '', model: body.model, authOk, body });
      if (!authOk) { res.writeHead(401); res.end('{"error":{"message":"fixture wrong source credential"}}'); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if ((source === 'A' && initial === 'preset') || (source === 'B' && initial === 'custom-cross-api')) {
        const message = { id: 'message-A', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: markers[source] }], status: 'completed' };
        const events = [
          { type: 'response.created', response: { id: 'response-A', status: 'in_progress' } },
          { type: 'response.output_item.added', output_index: 0, item: { ...message, content: [{ type: 'output_text', text: '' }], status: 'in_progress' } },
          { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'message-A', delta: markers[source] },
          { type: 'response.output_item.done', output_index: 0, item: message },
          { type: 'response.completed', response: { id: 'response-A', status: 'completed', model: body.model, output: [message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
        ];
        res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
      } else {
        const chunks = [
          { id: 'response-B', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: markers[source] }, finish_reason: null }] },
          { id: 'response-B', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
        ];
        res.end(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const cipher = { isAvailable: () => true, encrypt: (text: string) => Buffer.from(text), decrypt: (bytes: Buffer) => bytes.toString() };
  const store = new ProviderDirectoryStore({ stateDir: directory }, cipher, { catalogBaseUrl: `${origin}/catalog` });
  const providerA = initial === 'preset' ? 'openai' : 'user-defined';
  await store.commitCredential(providerA, { type: 'api_key', key: keys.A });
  const providerB = initial === 'custom-cross-api' ? 'openai' : 'openrouter';
  await store.commitCredential(providerB, { type: 'api_key', key: keys.B });
  const presets = registerPresetProviders();
  const presetA = presets.find((p) => p.id === 'openai')!;
  const presetB = presets.find((p) => p.id === providerB)!;
  assert.ok(presetA && presetB);
  const model = (source: 'A' | 'B'): Model<Api> => ({
    id: `route-${source}`, name: `Route ${source}`, provider: source === 'A' ? providerA : providerB,
    api: ((source === 'A' && initial === 'preset') || (source === 'B' && initial === 'custom-cross-api')) ? 'openai-responses' : 'openai-completions', baseUrl: `${origin}/${source}/v1`,
    reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  let nextSource: 'A' | 'B' = 'A';
  const target = { workspaceId: 'ws', taskId: 'task', sessionId: 'session-route' };
  const admitRequest = async (request: { sessionId: string }) => {
    assert.equal(request.sessionId, target.sessionId, 'SDK 准入归本条端口');
    return { ok: true, reason: null, target: { sourceId: nextSource === 'A' ? providerA : providerB, modelId: `route-${nextSource}`, thinkingLevel: null } };
  };
  const additionalSources = [{ kind: 'preset' as const, providerId: providerB, preset: presetB, models: [model('B')] }];
  const backend = initial === 'preset'
    ? createPresetPiBackend({
      stateDir: directory, selection: { providerId: providerA, modelId: 'route-A' },
      preset: presetA, model: model('A'), info: { id: 'route-A', name: 'Route A' }, store,
      additionalSources, admitRequest,
    })
    : createRealPiBackend({
      stateDir: directory, config: { provider: 'openai-completions', label: 'Route A', modelId: 'route-A', baseUrl: `${origin}/A/v1` },
      cipher, store: new ModelSetupStore({ stateDir: directory }, cipher), credentialSource: store,
      additionalSources, admitRequest,
    });
  const port = await backend.open({ target, workFolder: null, title: 'route', model: null });
  try {
    for (const source of ['A', 'B'] as const) {
      nextSource = source;
      const current = await port.read();
      const receipt = await port.submit({ target, expected: current.control, operationId: `operation-${source}`, text: `input-${source}`, references: [], mode: 'follow-up' });
      assert.equal(receipt.status, 'accepted');
      const deadline = Date.now() + 5000;
      let view = await port.read();
      while ((view.pendingInputs > 0 || view.phase !== 'ready') && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20)); view = await port.read();
      }
      if (source === 'B') {
        const last = requests.at(-1);
        assert.equal(last?.source, 'B', '采用 B 后实际请求归 B');
        assert.equal(last.authOk, true, 'B 不得沿用 A 的已解析凭据');
      }
      assert.ok(view.entries.some((entry) => entry.assistantText === markers[source] && !entry.failureKind), `本次 ${source} 真实回复须完整成功`);
    }
    assert.equal(requests.filter((r) => r.source === 'A').length, 1, 'A 已耗尽后不再收到下一次请求');
    const b = requests.filter((r) => r.source === 'B');
    assert.equal(b.length, 1, 'B 只有原下一次请求，无探针或重投');
    assert.equal(b[0]!.path, initial === 'custom-cross-api' ? '/B/v1/responses' : '/B/v1/chat/completions', 'B 使用自己的协议');
    assert.equal(b[0]!.model, 'route-B');
    assert.equal(b[0]!.authOk, true, 'B 使用自己的凭据');
    const body = JSON.stringify(b[0]!.body);
    assert.ok(body.includes('input-A') && body.includes(markers.A) && body.includes('input-B'), '原会话上下文完整保留');
  } finally {
    if (unrelated.length) console.log('[unrelated-controlled-http]', JSON.stringify(unrelated));
    await port.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
