// 普通分类runtime和桌面路径共用的受控HTTP/项目扩展资产。
// No node:test registrations, product imports, model calls or side effects at import.
import http from 'node:http';

export const classifierFixtureIds = Object.freeze({
  provider: 'openrouter',
  chat: 'openai/gpt-4o',
  classifier: 'typesafe/jev-1.13',
  tool: 'owned_classifier_contract',
  call: 'owned-classifier-call-1',
});
const ids = classifierFixtureIds;
export const traceName = 'owned-classifier-trace.json';
export const effectsName = 'owned-classifier-effects.jsonl';
export const cancelName = 'owned-classifier-cancel.json';
export const releaseName = 'owned-classifier-owner-release.json';
export const classifierFixtureFiles = Object.freeze({trace:traceName,effects:effectsName,cancel:cancelName,release:releaseName});

export const makeQuestions = nonce => ({
  route: { type: 'choice', instructions: 'Choose the explicit owned route ' + nonce, criteria: { keep: 'Keep the current work', revise: 'Revise the owned work' } },
  quality: { type: 'score', instructions: 'Score the owned state ' + nonce, criteria: ['No scope', 'Partially scoped', 'Fully scoped'] },
  safe: { type: 'bool', instructions: 'Evaluate this owned condition ' + nonce, criteria: { true: 'The owned state is safe', false: 'The owned state is unsafe' } },
});

// Actual authenticated System One wire: bool questions are "noul", not a hand-made public result.
export async function startClassifierLoopback({ nonce, key, mode = 'success', hold = false, warmup = false }) {
  const requests = [], invalid = [], held = new Map(), sockets = new Set();
  const answers = {
    route: { type: 'choice', choice: 'keep', probabilities: { keep: 0.8, revise: 0.2 }, confidence: 0.6 },
    quality: { type: 'score', score: 2, confidence: 0.75 },
    safe: { type: 'noul', noul: 0.875 },
  };
  const sse = (res, id, delta, finish, usage) => res.write('data: ' + JSON.stringify({
    id, model: ids.chat, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}),
  }) + '\n\n');
  const server = http.createServer((req, res) => {
    // Public catalog navigation is not a model request and carries no credential/body.
    if (req.method === 'GET') {
      if ((req.url ?? '').startsWith('/catalog')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"models":[],"providers":[]}'); }
      else { res.writeHead(404); res.end(); }
      return;
    }
    const chunks = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { invalid.push('invalid-json'); res.writeHead(400); res.end('{}'); return; }
      const kind = req.url === '/v1/systemone' ? 'classifier' : req.url === '/v1/chat/completions' ? 'chat' : 'unknown';
      const ordinal = requests.filter(item => item.kind === kind).length + 1;
      const record = { kind, ordinal, path: req.url, method: req.method, body,
        authOk: req.headers.authorization === 'Bearer ' + key, accepted: true, finished: false, closedBeforeFinal: false };
      requests.push(record);
      res.once('close', () => { record.closedBeforeFinal = !record.finished; held.delete(record); });
      if (kind === 'unknown' || req.method !== 'POST' || !record.authOk) {
        invalid.push('unexpected-route-method-or-auth'); res.writeHead(401); record.finished = true; res.end('{}'); return;
      }
      if (kind === 'classifier') {
        if (ordinal > 1) invalid.push('classifier-replayed');
        if (hold) { held.set(record, res); return; }
        const returned = mode === 'billed-malformed' ? { ...answers, safe: { type: 'noul', noul: 'invalid-number' } } : answers;
        const response = { answers: returned,
          ...(mode === 'no-usage' ? {} : { usage: { input_tokens: 117, output_tokens: 13 } }) };
        record.response = response; record.finished = true;
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(response)); return;
      }
      if (ordinal > (warmup ? 3 : 2)) invalid.push('unexpected-outer-request');
      if (body.model !== ids.chat) invalid.push('wrong-outer-model');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const responseId = 'outer-classifier-' + nonce + '-' + ordinal;
      record.responseId = responseId;
      if (warmup && ordinal === 1) {
        record.reply = 'CLASSIFIER_WARMUP_REPLY_' + nonce;
        sse(res, responseId, { role: 'assistant', content: record.reply }, null);
        sse(res, responseId, {}, 'stop', { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 });
      } else if (ordinal === (warmup ? 2 : 1)) {
        sse(res, responseId, { role: 'assistant', tool_calls: [{ index: 0, id: ids.call, type: 'function',
          function: { name: ids.tool, arguments: '{}' } }] }, null);
        sse(res, responseId, {}, 'tool_calls', { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 });
      } else {
        record.reply = 'CLASSIFIER_OUTER_REPLY_' + nonce;
        sse(res, responseId, { role: 'assistant', content: record.reply }, null);
        sse(res, responseId, {}, 'stop', { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 });
      }
      record.finished = true; res.end('data: [DONE]\n\n');
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const assertSingleHeld = () => { if (held.size !== 1) throw new Error('Exactly one held actual classifier HTTP required'); };
  return {
    origin: 'http://127.0.0.1:' + server.address().port, requests, invalid,
    setKey(value) { key = value; },
    classifications: () => requests.filter(item => item.kind === 'classifier'),
    chats: () => requests.filter(item => item.kind === 'chat'),
    releaseClassification() {
      assertSingleHeld();
      for (const [record, res] of held) {
        if (res.destroyed || record.finished) throw new Error('Held classifier already closed or completed');
        const returned = mode === 'billed-malformed' ? { ...answers, safe: { type: 'noul', noul: 'invalid-number' } } : answers;
        const response = { answers: returned, ...(mode === 'no-usage' ? {} : { usage: { input_tokens: 117, output_tokens: 13 } }) };
        record.response = response; record.finished = true; held.delete(record);
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(response));
      }
    },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); },
  };
}

export function classifierExtensionSource(nonce, mode = 'success', fixtureIds = ids) {
  const configuration = { nonce, mode, ids: fixtureIds, questions: makeQuestions(nonce), traceName, effectsName, cancelName, releaseName };
  // The generated source is owned fixture code, not a text probe of product/third-party implementation.
  function extension(pi) {
    pi.registerTool({ name: cfg.ids.tool, label: 'owned classifier', description: 'One real SDK classification in the original tool',
      parameters: Type.Object({}),
      async execute(id, _args, signal, _onUpdate, ctx) {
        if (!signal || ctx.signal !== signal || signal.aborted) throw new Error('Original tool signal missing');
        const tracePath = join(ctx.cwd, cfg.traceName), effectsPath = join(ctx.cwd, cfg.effectsName);
        const trace = { nonce: cfg.nonce, callId: id, mode: cfg.mode, steps: [] };
        const save = async () => { await writeFile(tracePath + '.tmp', JSON.stringify(trace)); await rename(tracePath + '.tmp', tracePath); };
        const step = async (phase, value = {}) => { trace.steps.push({ phase, ...value }); await save(); };
        const markerExists = async name => {
          try { const value = JSON.parse(await readFile(join(ctx.cwd, name), 'utf8')); return value.nonce === cfg.nonce; }
          catch (error) { if (error.code === 'ENOENT') return false; throw error; }
        };
        const waitMarker = async name => {
          const watcher = watch(ctx.cwd, { signal });
          try {
            if (await markerExists(name)) return;
            for await (const event of watcher) if (event.filename === name && await markerExists(name)) return;
            throw new Error('Owned marker watcher ended early');
          } finally { await watcher.return(); }
        };
        await appendFile(effectsPath, JSON.stringify({ phase: 'tool-start', nonce: cfg.nonce, callId: id }) + '\n');
        await step('tool-started', { ownerAborted: signal.aborted });
        const model = ctx.modelRegistry.getModelOfType('classifier', cfg.ids.provider, cfg.ids.classifier);
        if (!model || model.type !== 'classifier' || model.api !== 'typesafe-system-one') throw new Error('Configured canonical classifier missing');
        if (cfg.mode === 'boundary-rejects') {
          let accessorReads = 0;
          const throwing = () => { accessorReads++; throw new Error('Owned accessor must not escape'); };
          const revoked = Proxy.revocable(model, {}); revoked.revoke();
          const candidates = [
            ['model-accessor', { ...model, get provider() { return throwing(); } }, {}],
            ['model-proxy', new Proxy(model, { get: throwing }), {}],
            ['model-revoked-proxy', revoked.proxy, {}],
            ['model-descriptor-proxy', new Proxy(model, { getOwnPropertyDescriptor: throwing }), {}],
            ['options-accessor', model, { get signal() { return throwing(); } }],
            ['signal-accessor', model, { signal: { get aborted() { return throwing(); }, get removeEventListener() { return throwing(); } } }],
            ['options-proxy', model, new Proxy({}, { ownKeys: throwing })],
            ['options-own-proto', model, Object.defineProperty({}, '__proto__', { value: 'owned-unsupported', enumerable: true })],
          ];
          const outcomes = [];
          for (const [name, value, options] of candidates) {
            let pending;
            try { pending = ctx.modelRegistry.classify(value, { state: { nonce: cfg.nonce, purpose: 'owned-classifier-contract' }, questions: cfg.questions }, options); }
            catch { outcomes.push({ name, synchronousThrow: true }); continue; }
            if (!pending || typeof pending.then !== 'function') { outcomes.push({ name, notPromise: true }); continue; }
            try { outcomes.push({ name, result: await pending }); }
            catch { outcomes.push({ name, promiseRejected: true }); }
          }
          await step('boundary-results', { outcomes, accessorReads, ownerAborted: signal.aborted });
          return { content: [{ type: 'text', text: JSON.stringify({ nonce: cfg.nonce, outcomes, accessorReads }) }] };
        }
        const local = cfg.mode === 'model-cancel' ? new AbortController() : undefined;
        let cancelFlight;
        if (local) cancelFlight = waitMarker(cfg.cancelName).then(() => local.abort());
        let result;
        try {
          result = await ctx.modelRegistry.classify(model,
            { state: { nonce: cfg.nonce, purpose: 'owned-classifier-contract' }, questions: cfg.questions },
            { signal: local?.signal ?? signal, maxRetries: 0 });
        } catch (error) {
          await step('promise-rejected', { ownerAborted: signal.aborted, message: String(error) });
          throw error;
        }
        await step('result-settled', { ownerAborted: signal.aborted, modelAborted: local?.signal.aborted ?? signal.aborted, result });
        if (local) {
          await cancelFlight;
          if (signal.aborted || !local.signal.aborted) throw new Error('Model cancellation changed the original owner');
          await step('owner-still-active', { ownerAborted: signal.aborted });
          await waitMarker(cfg.releaseName);
        }
        if (signal.aborted) {
          await step('owner-aborted', { ownerAborted: true });
          throw new Error('Aborted owner cannot claim a successful tool result');
        }
        const observation = { probe: 'owned-classifier', nonce: cfg.nonce, originalToolCallId: id,
          ownerAlive: !signal.aborted, method: 'classify', result };
        await step('tool-returning', { ownerAborted: signal.aborted });
        return { content: [{ type: 'text', text: JSON.stringify(observation) }], isError: result.stopReason !== 'stop',
          details: { classifierObservation: observation } };
      },
    });
  }
  return 'import {Type} from "typebox";\nimport {appendFile,writeFile,readFile,rename,watch} from "node:fs/promises";\n'
    + 'import {join} from "node:path";\nconst cfg=' + JSON.stringify(configuration) + ';\nexport default ' + extension.toString() + '\n';
}
