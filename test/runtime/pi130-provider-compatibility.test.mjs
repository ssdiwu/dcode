// 受控协议兼容：旧 D Code 来源键、旧格式工具上下文与新 SDK 的下一次真实 HTTP。
// 这里只用合成历史核协议转换；真实旧盘升级另见 test/compatibility，不冒充旧盘恢复。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createModels } from '@earendil-works/pi-ai/models';
import { registerPresetProviders, ProviderDirectoryStore, ModelSetupStore, createRealPiBackend } from '../../src/adapters/pi/index.ts';
import { ProviderCatalogService } from '../../src/adapters/pi/catalog-service.ts';
import { until } from './fixtures.ts';

const azureId = 'azure-openai-responses';
const cipher = { isAvailable: () => true, encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() };
const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const oldUsage = { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: zeroCost };
const event = value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;

async function loopback() {
  const nonce = 'pi130-protocol-' + randomUUID(); const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    // 只留合成请求及有限认证判别，不输出头或密钥。
    requests.push({ url: req.url, method: req.method, body, azureAuth: req.headers['api-key'] === 'fixture-azure-key', kimiAuth: req.headers.authorization === 'Bearer fixture-kimi-key',
      customAuth: req.headers['x-api-key'] === 'fixture-custom-key', oldEtag: req.headers['if-none-match'] ?? null });
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json', etag: 'new-azure-resource' }); res.end('[]'); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const id = 'fixture-response-' + requests.length;
    if (req.url?.includes('/responses')) {
      const item = { id: 'msg-' + id, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: nonce }] };
      res.end([
        { type: 'response.created', response: { id, object: 'response', status: 'in_progress', model: body.model } },
        { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
        { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: nonce },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id, status: 'completed', model: body.model, output: [item], usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } } },
      ].map(event).join('')); return;
    }
    if (new URL(req.url, 'http://fixture.invalid').pathname.endsWith('/messages')) {
      res.end([
        { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: 7, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: nonce } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } },
        { type: 'message_stop' },
      ].map(event).join('')); return;
    }
    res.end([
      { id, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: nonce }, finish_reason: null }] },
      { id, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } },
    ].map(value => 'data: ' + JSON.stringify(value) + '\n\n').join('') + 'data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { nonce, requests, origin: 'http://127.0.0.1:' + server.address().port,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

function oldHistory(provider, api, model) {
  const id = provider === azureId ? 'call_legacy|fc_legacy' : 'old_kimi_call';
  return [
    { role: 'user', content: 'original isolated request', timestamp: 1 },
    { role: 'assistant', provider, api, model, timestamp: 2, usage: oldUsage, stopReason: 'toolUse', content: [{ type: 'toolCall', id, name: 'read', arguments: { path: 'old.txt' } }] },
    { role: 'toolResult', toolCallId: id, toolName: 'read', content: [{ type: 'text', text: 'original-tool-output-nonce' }], isError: false, timestamp: 3 },
  ];
}

await test('Pi1.3 Azure：旧来源/加密凭据/选择保留，公共目录查新azure且不借旧资源ETag', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dcode-pi130-directory-')); const remote = await loopback(); let catalog;
  try {
    const presets = registerPresetProviders(); const azure = presets.find(one => one.id === azureId);
    assert.ok(azure); assert.equal(presets.some(one => one.id === 'azure'), false); assert.equal(azure.catalogProviderId, 'azure');
    assert.ok(azure.provider.getModels().length > 0);
    for (const model of azure.provider.getAllModels()) assert.equal(model.provider, azureId);
    assert.ok(azure.provider.getModels().some(model => model.api === 'azure-openai-responses'));
    const store = new ProviderDirectoryStore({ stateDir: root }, cipher, { catalogBaseUrl: remote.origin });
    await store.commitCredential(azureId, { type: 'api_key', key: 'fixture-azure-key' });
    const modelId = azure.provider.getModels()[0].id;
    await store.commitPresetSelection({ providerId: azureId, modelId, note: 'ready' });
    // 使用公开 store 提交旧资源缓存；不是手改其持久格式。
    const cachedModel = { ...azure.provider.getModels()[0], provider: azureId, baseUrl: 'https://old-azure.invalid', type: 'chat' };
    await store.modify(async record => ({ record: { ...record, catalog: { ...record.catalog, [azureId]: { models: [cachedModel], etag: 'legacy-resource-etag', checkedAt: 1, sourceBaseUrl: remote.origin } } }, result: undefined }));
    const diskBefore = JSON.parse(await readFile(join(root, 'provider-directory.json'), 'utf8'));
    assert.equal(diskBefore.catalog[azureId].etag, 'legacy-resource-etag', '反例先确立旧路径的真实持久缓存');
    catalog = new ProviderCatalogService({ store, presets: [azure] }); await catalog.init(); await catalog.refresh();
    assert.equal(remote.requests.length, 1); assert.equal(remote.requests[0].url, '/api/models/providers/azure?types=chat');
    assert.equal(remote.requests[0].oldEtag, null); assert.equal(remote.requests[0].method, 'GET'); assert.equal(remote.requests[0].azureAuth, false);
    const diskAfter = JSON.parse(await readFile(join(root, 'provider-directory.json'), 'utf8'));
    assert.deepEqual(diskAfter.credentials, diskBefore.credentials); assert.deepEqual(diskAfter.current, diskBefore.current);
    assert.equal(diskAfter.catalog.azure, undefined); assert.equal(diskAfter.catalog[azureId].etag, 'new-azure-resource');
    assert.equal((await store.asPiCredentialStore().read(azureId)).key, 'fixture-azure-key');
    assert.equal(await store.asPiCredentialStore().read('azure'), undefined);
  } finally { await catalog?.close(); await remote.close(); await rm(root, { recursive: true, force: true }); }
});

for (const crossModel of [false, true]) await test(`Pi1.3 Azure旧格式工具历史：${crossModel ? '跨模型' : '同模型'}下一HTTP的call/result配对及实际回复`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dcode-pi130-azure-')); const remote = await loopback();
  try {
    const preset = registerPresetProviders().find(one => one.id === azureId); const models = preset.provider.getModels().filter(model => model.api === 'azure-openai-responses');
    assert.ok(models.length >= 2); const selected = models[crossModel ? 1 : 0];
    const store = new ProviderDirectoryStore({ stateDir: root }, cipher, { catalogBaseUrl: remote.origin });
    await store.commitCredential(azureId, { type: 'api_key', key: 'fixture-azure-key', env: { AZURE_OPENAI_BASE_URL: remote.origin + '/openai/v1' } });
    const client = createModels({ credentials: store.asPiCredentialStore(), authContext: { env: async () => undefined, fileExists: async () => false } });
    client.setProvider(preset.provider);
    const history = oldHistory(azureId, 'azure-openai-responses', models[0].id); const original = JSON.stringify(history);
    const answer = await client.streamSimple(selected, { messages: history }, { maxRetries: 0 }).result();
    assert.equal(answer.stopReason, 'stop'); assert.equal(answer.provider, azureId); assert.equal(answer.content[0].text, remote.nonce); assert.equal(answer.usage.totalTokens, 10);
    assert.equal(remote.requests.length, 1); const posted = remote.requests[0]; assert.equal(posted.azureAuth, true);
    assert.equal(posted.url, '/openai/v1/responses?api-version=v1'); assert.equal(posted.body.model, selected.id);
    const call = posted.body.input.find(item => item.type === 'function_call'); const result = posted.body.input.find(item => item.type === 'function_call_output');
    assert.ok(call && result); assert.equal(result.call_id, call.call_id); assert.match(JSON.stringify(result.output), /original-tool-output-nonce/);
    assert.equal(JSON.stringify(history), original, '下一协议转换不修改已保存历史身份和正文');
  } finally { await remote.close(); await rm(root, { recursive: true, force: true }); }
});

await test('Pi1.3 Kimi：受管旧Anthropic上下文进新Completions，普通同名custom仍走原协议', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dcode-pi130-kimi-')); const remote = await loopback(); let session;
  try {
    const preset = registerPresetProviders().find(one => one.id === 'kimi-coding'); const canonical = preset.provider.getModels()[0];
    assert.equal(canonical.api, 'openai-completions'); assert.equal(canonical.baseUrl, 'https://api.kimi.com/coding/v1');
    const store = new ProviderDirectoryStore({ stateDir: root }, cipher, { catalogBaseUrl: remote.origin }); await store.commitCredential(preset.id, { type: 'api_key', key: 'fixture-kimi-key' });
    const client = createModels({ credentials: store.asPiCredentialStore(), authContext: { env: async () => undefined, fileExists: async () => false } });
    const selected = { ...canonical, baseUrl: remote.origin + '/coding/v1' };
    client.setProvider({ ...preset.provider, getModels: () => [selected], getAllModels: () => [selected] });
    const history = oldHistory(preset.id, 'anthropic-messages', canonical.id); const original = JSON.stringify(history);
    const result = await client.streamSimple(selected, { messages: history }, { maxRetries: 0 }).result();
    assert.equal(result.stopReason, 'stop'); assert.equal(result.content[0].text, remote.nonce); assert.equal(result.usage.totalTokens, 10);
    assert.equal(remote.requests[0].url, '/coding/v1/chat/completions'); assert.equal(remote.requests[0].kimiAuth, true);
    const call = remote.requests[0].body.messages.find(message => message.tool_calls)?.tool_calls[0];
    const output = remote.requests[0].body.messages.find(message => message.role === 'tool');
    assert.ok(call && output); assert.equal(call.id, output.tool_call_id); assert.match(output.content, /original-tool-output-nonce/); assert.equal(JSON.stringify(history), original);
    const config = { provider: 'anthropic-messages', label: 'Kimi For Coding', modelId: canonical.id, baseUrl: remote.origin + '/coding' };
    const custom = new ModelSetupStore({ stateDir: root }, cipher);
    await custom.commitWithCredential({ ...config, note: 'ready', keyAction: 'replace', apiKey: 'fixture-custom-key' });
    const backend = createRealPiBackend({ stateDir: root, cipher, store: custom, config });
    const target = { workspaceId: 'space', taskId: 'task', sessionId: 'custom-kimi' }; const work = join(root, 'work'); await mkdir(work);
    session = await backend.open({ target, title: 'custom Kimi boundary', workFolder: work, model: null, initialize: true, projectAccess: 'task-owner' });
    const input = { target, operationId: 'custom-kimi-input', text: 'same label retains explicit custom protocol', mode: 'follow-up', references: [], expected: (await session.read()).control };
    assert.equal((await session.submit(input)).status, 'accepted');
    await until(async () => (await session.lookupReceipt(input)).processing === 'done');
    assert.equal(remote.requests.length, 2); assert.equal(remote.requests[1].url, '/coding/v1/messages?beta=true'); assert.equal(remote.requests[1].customAuth, true);
    assert.ok((await session.read()).entries.some(entry => entry.assistantText === remote.nonce));
  } finally { await session?.close(); await remote.close(); await rm(root, { recursive: true, force: true }); }
});
