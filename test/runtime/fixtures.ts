import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import type { AssistantMessage, Model, ProviderStreams } from '@earendil-works/pi-ai';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

export function controlledModels() {
  type Request = { finish: (content?: AssistantMessage['content'], reason?: 'stop' | 'toolUse') => void; readonly settled: boolean; messages: unknown };
  const requests: Request[] = [];
  const model: Model<'openai-completions'> = { id: 'fixture', name: 'Deterministic local fixture', api: 'openai-completions', provider: 'dcode-test', baseUrl: 'https://invalid.invalid', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 };
  const stream: ProviderStreams['streamSimple'] = (selected, input, options = {}) => {
    const events = createAssistantMessageEventStream();
    let settled = false;
    const message = (content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason']): AssistantMessage => ({ role: 'assistant', api: selected.api, provider: selected.provider, model: selected.id, content, stopReason, timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    const abort = () => { if (!settled) { settled = true; events.push({ type: 'error', reason: 'aborted', error: { ...message([], 'aborted'), errorMessage: 'test request cancelled by Pi' } }); } };
    requests.push({ messages: input.messages, get settled() { return settled; }, finish(content = [{ type: 'text', text: 'local fixture complete' }], reason = 'stop') {
      if (settled) throw new Error('Fixture request already settled');
      settled = true;
      options.signal?.removeEventListener('abort', abort);
      events.push({ type: 'done', reason, message: message(content, reason) });
    } });
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    return events;
  };
  const models = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
  models.setProvider(createProvider({ id: model.provider, models: [model], auth: { apiKey: { name: 'test', resolve: async () => ({ auth: {}, source: 'in-process test; no credential' }) } }, api: { stream, streamSimple: stream } }));
  return { models, requests, model };
}
export async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!(await predicate())) { assert.ok(Date.now() < deadline, 'Expected runtime state was not observed within 8 seconds'); await delay(5); }
}
