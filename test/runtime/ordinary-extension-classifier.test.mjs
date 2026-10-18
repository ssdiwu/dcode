// 普通扩展classifier真实SDK、Worker、Durable与持久化生命周期；仅HTTP远端由受控服务提供。
// Only HTTP service responses are controlled. SDK provider/auth/typed parsing/Worker/Durable/storage are real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { ROOT_CONVERSATION_ID, ToolTask } from '@earendil-works/pi-durable';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { createPresetPiBackend, ProviderDirectoryStore, ProviderCatalogService, registerPresetProviders } from '../../src/adapters/pi/index.ts';
import { prepareCodingProject } from '../e2e/ordinary-coding-fixture.mjs';
import { until } from './fixtures.ts';

import { classifierFixtureIds as ids, startClassifierLoopback, classifierExtensionSource, makeQuestions, traceName, effectsName, cancelName, releaseName } from '../e2e/ordinary-classifier-fixture.mjs';
// This is only a fixture cipher. It actually encrypts bytes, never imports a real user key.
function encryptedFixtureCipher() {
  const cipherKey = randomBytes(32);
  return {
    isAvailable: () => true,
    encrypt(text) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', cipherKey, iv);
      const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    },
    decrypt(bytes) {
      const decipher = createDecipheriv('aes-256-gcm', cipherKey, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}

export async function createClassifierFixture({ mode = 'success', hold = false, credentialMode = 'api_key', authChange = false, tamper = false, typedOnly = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dcode-owned-classifier-')));
  const project = join(root, 'project'), stateDir = join(root, 'state'), nonce = randomUUID();
  const fixtureKey = 'owned-classifier-key-' + randomUUID();
  const originalFetch=globalThis.fetch;
  const loopbackFetch=(input,options)=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
    if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new Error('Owned classifier runtime requires loopback transport');
    return originalFetch(input,options);};
  globalThis.fetch=loopbackFetch;
  const admissions = [];
  const classifierIds=typedOnly?{...ids,provider:'typesafe',classifier:'jev-latest'}:ids;
  let remote, catalog, session;
  try {
    await prepareCodingProject(project);
    await mkdir(join(project, '.pi/extensions'), { recursive: true });
    await writeFile(join(project, '.pi/mcp.json'), '{"mcpServers":{}}');
    await writeFile(join(project, '.pi/extensions/classifier.ts'), classifierExtensionSource(nonce, mode, classifierIds));
    if(tamper)await writeFile(join(project,'.pi/extensions/tamper-classifier.ts'),`export default function(pi){pi.on('before_provider_request',event=>event.payload?.questions?{...event.payload,state:{changed:true}}:undefined);}`);
    remote = await startClassifierLoopback({ nonce, key: fixtureKey, mode, hold });
    const cipher = encryptedFixtureCipher();
    const store = new ProviderDirectoryStore({ stateDir }, cipher, { catalogBaseUrl: remote.origin + '/catalog' });
    const credential = key => credentialMode === 'oauth' ? { type:'oauth',access:key,refresh:'',expires:Number.MAX_SAFE_INTEGER } : { type:'api_key',key };
    await store.commitCredential(ids.provider, credential(fixtureKey));
    if(typedOnly)await store.commitCredential(classifierIds.provider,credential(fixtureKey));
    await store.commitPresetSelection({ providerId: ids.provider, modelId: ids.chat, note: 'ready' });
    const disk = await store.read();
    assert.equal(disk.current.kind, 'preset'); assert.equal(disk.current.providerId, ids.provider);
    assert.ok(disk.credentials[ids.provider].blob.length > 0);
    assert.ok(!disk.credentials[ids.provider].blob.includes(fixtureKey), 'ProviderDirectoryStore must persist encrypted fixture credentials');
    const savedCredential=await store.readCredential(ids.provider);
    assert.equal(savedCredential.type==='oauth'?savedCredential.access:savedCredential.key,fixtureKey);
    const preset = registerPresetProviders().find(provider => provider.id === ids.provider);
    assert.ok(preset, 'Use the actual managed OpenRouter preset');
    catalog = new ProviderCatalogService({ store, presets: [preset], defaultBaseUrl: remote.origin + '/catalog' });
    await catalog.init();
    const resolution = catalog.resolveExecutable(ids.provider, ids.chat);
    assert.ok(resolution?.executable && resolution.model);
    const canonicalClassifier = preset.provider.getAllModels().find(model => model.type === 'classifier' && model.id === ids.classifier);
    assert.ok(canonicalClassifier, 'The original SDK provider must declare the classifier, not a test-invented typed model');
    const onlyPreset=typedOnly?registerPresetProviders().find(one=>one.id===classifierIds.provider):undefined;
    const backend = createPresetPiBackend({
      stateDir, selection: { providerId: ids.provider, modelId: ids.chat }, preset,
      model: resolution.model, info: resolution.info, store,
      baseUrlOverrides: { [ids.provider]: remote.origin + '/v1', ...(typedOnly?{[classifierIds.provider]:remote.origin+'/v1'}:{}) },
      additionalSources: [{ kind: 'preset', providerId: ids.provider, preset, models: [resolution.model] },...(typedOnly?[{kind:'preset',providerId:classifierIds.provider,preset:onlyPreset,models:[]}]:[])],
      admitRequest: async request => {
        admissions.push({ ...request });
        // 真实SDK已准备原认证才进本门；正式store提交另一身份后，旧prepared请求必须零HTTP。
        if(request.operation==='classify'&&authChange){await store.commitCredential(ids.provider,credential(fixtureKey+'-rotated'));remote.setKey(fixtureKey+'-rotated');}
        return { ok: true, reason: null, target: { sourceId: request.sourceId, modelId: request.modelId, thinkingLevel: null } };
      },
    });
    const target = { workspaceId: 'owned-space', taskId: 'owned-task', sessionId: 'owned-classifier-session' };
    const opening = { target, title: 'Owned classifier contract', workFolder: project, model: null, initialize: true,
      projectAccess: 'task-owner', projectExtensionsEnabled: () => true };
    session = await backend.open(opening);
    const input = { target, operationId: 'owned-classifier-operation-' + nonce, text: 'Run one owned classification ' + nonce,
      mode: 'follow-up', references: [], expected: (await session.read()).control };
    return {
      root, project, stateDir, nonce, mode, remote, backend, target, opening, input, admissions, canonicalClassifier, classifierIds,
      get session() { return session; }, set session(value) { session = value; },
      trace: async () => JSON.parse(await readFile(join(project, traceName), 'utf8')),
      effects: async () => (await readFile(join(project, effectsName), 'utf8')).trim().split('\n').filter(Boolean).map(row => JSON.parse(row)),
      marker: name => writeFile(join(project, name), JSON.stringify({ nonce })),
      async dispose(remove = true) {
        const outcomes = await Promise.allSettled([session?.close(), catalog?.close()]);
        await remote.close();
        if(globalThis.fetch===loopbackFetch)globalThis.fetch=originalFetch;
        const failure = outcomes.find(item => item.status === 'rejected');
        if (failure) throw failure.reason;
        if (remove) await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await Promise.allSettled([session?.close(), catalog?.close()]);
    await remote?.close();
    if(globalThis.fetch===loopbackFetch)globalThis.fetch=originalFetch;
    throw error;
  }
}

async function withClassifier(t, options, action) {
  const f = await createClassifierFixture(options);
  let passed = false, original;
  try { await action(f); passed = true; }
  catch (error) { original = error; throw error; }
  finally {
    // Failure artifacts retain owned fixture data; diagnostics contain no key/auth headers.
    if (!passed) {
      await writeFile(join(f.root, 'classifier-test-failure.json'), JSON.stringify({
        nonce: f.nonce, mode: f.mode, admissions: f.admissions, requests: f.remote.requests,
        invalid: f.remote.invalid, error: String(original),
      }, null, 2));
      t.diagnostic('Owned classifier failure data retained at ' + f.root);
    }
    try { await f.dispose(passed); }
    catch (cleanupError) { if (!original) throw cleanupError; t.diagnostic('Cleanup also failed: ' + String(cleanupError)); }
  }
}

async function done(f) {
  await until(async () => (await f.session.lookupReceipt(f.input)).processing === 'done');
  await until(async () => (await f.session.read()).phase === 'ready');
}
function assertWire(f) {
  const inner = f.remote.classifications();
  assert.equal(inner.length, 1, 'Exactly one actual classifier HTTP; no retries or probes');
  assert.equal(inner[0].path, '/v1/systemone'); assert.equal(inner[0].method, 'POST'); assert.equal(inner[0].authOk, true);
  assert.equal(inner[0].body.model, ids.classifier);
  assert.deepEqual(inner[0].body.state, { nonce: f.nonce, purpose: 'owned-classifier-contract' });
  const expected = makeQuestions(f.nonce);
  assert.deepEqual(inner[0].body.questions, { ...expected, safe: { ...expected.safe, type: 'noul' } });
  assert.ok(f.admissions.some(request => request.operation === 'classify' && request.sessionId === f.target.sessionId
    && request.sourceId === ids.provider && request.modelId === ids.classifier), 'Real typed dispatch must consume the original session admission');
  assert.deepEqual(f.remote.invalid, []);
}
async function readRecords(f) {
  // Public storage.open may recover torn tails: only use the original directory after its real owner has closed.
  const storage = await openNodeJsonlStorage(join(f.stateDir, 'runtime', f.target.sessionId), context);
  const scan = async (method, query) => {
    const items = []; let cursor;
    do { const page = await storage[method](query, 200, cursor, context); items.push(...page.items); cursor = page.next; } while (cursor !== undefined);
    return items;
  };
  try {
    const entries = await scan('scanEntries', { conversationId: ROOT_CONVERSATION_ID });
    const tasks = await scan('scanTasks', { conversationId: ROOT_CONVERSATION_ID });
    const submissions = await scan('scanSubmissions', { conversationId: ROOT_CONVERSATION_ID });
    const record = await storage.findDocument({ kind: 'pi.usage', scope: { kind: 'conversation', conversationId: ROOT_CONVERSATION_ID } }, 'current', context);
    const usage = record ? (await storage.document(record.id, 'current', context)).value : { models: {}, tools: {} };
    const owner = tasks.find(task => task.kind === ToolTask.definition.name && task.input.callId === ids.call);
    assert.ok(owner, 'The actual model-issued ToolTask must exist');
    const children = tasks.filter(task => task.owner === owner.id);
    assert.equal(children.length, 1); const child = children[0];
    assert.equal(child.kind, 'dcode.extension-model'); assert.equal(child.input.mode, 'classify');
    assert.equal(child.conversationId, owner.conversationId);
    assert.equal(child.input.provider, ids.provider); assert.equal(child.input.modelId, ids.classifier);
    const preparation = await storage.findDocument({ kind: 'dcode.input-preparation', scope: { kind: 'session' }, key: f.input.operationId }, 'current', context);
    assert.ok(preparation); const value = (await storage.document(preparation.id, 'current', context)).value;
    const original = await storage.submissionByRequest(ROOT_CONVERSATION_ID, f.input.operationId, context);
    const linked = await storage.submissionByRequest(ROOT_CONVERSATION_ID, value.innerRequestId, context);
    assert.ok(original && linked);
    assert.deepEqual(submissions.map(item => item.id).sort((a, b) => a - b), [original.id, linked.id].sort((a, b) => a - b),
      'Classifier must not create another accepted input or agent loop');
    const messages = entries.flatMap(entry => entry.model ?? []);
    return { entries, tasks, submissions, usage, owner, child, messages,
      submissionIdentity: { originalId: original.id, innerId: linked.id, innerRequestId: value.innerRequestId } };
  } finally { await storage.close(context); }
}
const formalTool = raw => raw.messages.filter(message => message.role === 'toolResult' && message.toolName === ids.tool && message.toolCallId === ids.call);
const sumTokens = bucket => Object.values(bucket).reduce((sum, usage) => sum + usage.totalTokens, 0);
test('普通classifier/恶意属性边界：accessor、Proxy与未知选项均有限不reject且不创建请求', { timeout: 30000 }, async t => {
  await withClassifier(t, { mode: 'boundary-rejects' }, async f => {
    const accepted = await f.session.submit(f.input); assert.equal(accepted.status, 'accepted'); await done(f);
    const result = await visibleResult(f); assert.equal(result.row.toolResult.isError, false);
    const observed = result.observed;
    assert.equal(observed.nonce, f.nonce); assert.equal(observed.outcomes.length, 8);
    for (const outcome of observed.outcomes) {
      assert.equal(outcome.synchronousThrow, undefined, outcome.name + ' must return a Promise');
      assert.equal(outcome.promiseRejected, undefined, outcome.name + ' must settle a finite result');
      assert.equal(outcome.notPromise, undefined, outcome.name + ' must return a Promise');
      assert.equal(outcome.result.stopReason, 'error', outcome.name);
      assert.deepEqual(outcome.result.answers, {}); assert.equal(Object.hasOwn(outcome.result, 'usage'), false);
    }
    assert.equal(observed.accessorReads, 0, 'Boundary validation must not execute accessors or Proxy traps');
    assert.equal(f.remote.classifications().length, 0); assert.equal(f.remote.chats().length, 2);
    assert.equal(f.admissions.filter(request => request.operation === 'classify').length, 0);
    assert.equal((await f.session.read()).entries.some(entry => entry.typedRequest), false);
    await f.session.close();
    const storage = await openNodeJsonlStorage(join(f.stateDir, 'runtime', f.target.sessionId), context);
    try {
      const tasks = await storage.scanTasks({ conversationId: ROOT_CONVERSATION_ID }, 200, undefined, context);
      assert.equal(tasks.items.filter(task => task.kind === 'dcode.extension-model').length, 0,
        'Local rejected values cannot create Durable model children');
    } finally { await storage.close(context); }
  });
});
async function visibleResult(f) {
  const rows = (await f.session.read()).entries.filter(entry => entry.toolResult?.name === ids.tool && entry.toolResult.callId === ids.call);
  assert.equal(rows.length, 1);
  return { row: rows[0], observed: JSON.parse(rows[0].toolResult.text) };
}
async function assertSuccessfulReadback(f, accepted, raw) {
  const before = f.remote.requests.length;
  f.session = await f.backend.open({ ...f.opening, initialize: false });
  const view = await f.session.read();
  assert.equal((await f.session.submit(f.input)).submissionId, accepted.submissionId);
  assert.equal((await f.session.lookupReceipt(f.input)).processing, 'done');
  assert.equal(f.remote.requests.length, before, 'Read-only reopen/read/original-operation readback has zero HTTP');
  assert.equal(view.entries.filter(entry => entry.toolResult?.callId === ids.call).length, 1);
  await f.session.close();
  const after = await readRecords(f);
  assert.equal(after.child.id, raw.child.id); assert.equal(after.owner.id, raw.owner.id);
  assert.deepEqual(after.submissionIdentity, raw.submissionIdentity); assert.deepEqual(after.usage, raw.usage);
  assert.equal(formalTool(after).length, 1);
}

for (const mode of ['success', 'billed-malformed', 'no-usage']) test('普通classifier/' + mode + '：原preset认证、三题HTTP与真实typed结果／费用／只读重开', { timeout: 30000 }, async t => {
  await withClassifier(t, { mode }, async f => {
    assert.equal(f.remote.requests.length, 0, 'Opening the port does not execute extensions or models');
    const accepted = await f.session.submit(f.input); assert.equal(accepted.status, 'accepted'); await done(f);
    assertWire(f); assert.equal(f.remote.chats().length, 2);
    const { row, observed } = await visibleResult(f);
    assert.equal(observed.nonce, f.nonce); assert.equal(observed.originalToolCallId, ids.call); assert.equal(observed.ownerAlive, true);
    const result = observed.result;
    assert.equal(result.api, 'typesafe-system-one'); assert.equal(result.provider, ids.provider); assert.equal(result.model, ids.classifier);
    assert.equal(Object.hasOwn(result, 'responseId'), false, 'The classifier SDK does not invent a responseId');
    assert.equal(row.toolResult.isError, mode === 'billed-malformed');
    if (mode === 'billed-malformed') { assert.equal(result.stopReason, 'error'); assert.deepEqual(result.answers, {}); assert.ok(result.errorMessage); }
    else {
      assert.equal(result.stopReason, 'stop');
      assert.deepEqual(result.answers, {
        route: { type: 'choice', choice: 'keep', probabilities: { keep: 0.8, revise: 0.2 }, confidence: 0.6 },
        quality: { type: 'score', score: 2, confidence: 0.75 },
        safe: { type: 'bool', probability: 0.875 },
      });
    }
    if (mode === 'no-usage') assert.equal(Object.hasOwn(result, 'usage'), false, 'Unknown usage remains absent, not zero-filled');
    else {
      assert.equal(result.usage.input, 117); assert.equal(result.usage.output, 13);
      assert.equal(result.usage.totalTokens, 130); assert.equal(result.usage.cacheRead, 0); assert.equal(result.usage.cacheWrite, 0);
    }
    const view = await f.session.read();
    const facts = view.entries.filter(entry => entry.typedRequest?.operation === 'classify');
    assert.equal(facts.length, 1); assert.equal(typeof facts[0].typedRequest.requestId, 'string');
    assert.equal(facts[0].typedRequest.provider, ids.provider); assert.equal(facts[0].typedRequest.model, ids.classifier);
    assert.equal(facts[0].typedRequest.result, mode === 'billed-malformed' ? 'failed' : 'succeeded');
    if (mode === 'no-usage') assert.equal(facts[0].typedRequest.usage, undefined);
    else assert.deepEqual(facts[0].typedRequest.usage, { input: 117, output: 13, cacheRead: 0, cacheWrite: 0 });
    assert.ok(f.remote.chats()[1].body.messages.some(message => message.role === 'tool' && message.tool_call_id === ids.call
      && message.content === row.toolResult.text), 'Typed result is consumed by the same original outer continuation');
    const trace = await f.trace();
    assert.equal(trace.steps.filter(step => step.phase === 'promise-rejected').length, 0);
    assert.equal(trace.steps.filter(step => step.phase === 'result-settled').length, 1);
    assert.equal((await f.effects()).filter(item => item.phase === 'tool-start').length, 1);
    await f.session.close(); const raw = await readRecords(f), tool = formalTool(raw);
    assert.equal(tool.length, 1); assert.equal(raw.child.state.status, 'terminal'); assert.equal(raw.child.state.outcome.status, 'completed');
    assert.equal(raw.child.state.outcome.result.operation, 'classify');
    assert.deepEqual(raw.child.state.outcome.result.typed, result);
    assert.equal(raw.child.state.outcome.result.requestId, facts[0].typedRequest.requestId);
    assert.equal(sumTokens(raw.usage.models), 6, 'Classifier does not become another conversation assistant/model bucket');
    assert.equal(raw.messages.filter(message => message.role === 'assistant').length, 2);
    assert.equal(raw.entries.filter(entry => entry.kind === 'pi.user').length, 1);
    assert.ok(!raw.messages.some(message => message.role === 'assistant' && message.model === ids.classifier));
    if (mode === 'no-usage') { assert.equal(tool[0].usage, undefined); assert.equal(sumTokens(raw.usage.tools), 0); }
    else { assert.deepEqual(tool[0].usage, result.usage); assert.deepEqual(raw.usage.tools[ids.tool], result.usage); }
    await assertSuccessfulReadback(f, accepted, raw);
  });
});

test('普通classifier/独立signal取消：真实HTTP关闭，Promise有限aborted而原owner仍活，原工具收口不重放', { timeout: 30000 }, async t => {
  await withClassifier(t, { mode: 'model-cancel', hold: true }, async f => {
    const accepted = await f.session.submit(f.input); assert.equal(accepted.status, 'accepted');
    await until(() => f.remote.classifications().length === 1); const parked = f.remote.classifications()[0]; assertWire(f);
    assert.equal(parked.finished, false); assert.equal(f.remote.chats().length, 1);
    await f.marker(cancelName); await until(() => parked.closedBeforeFinal);
    let trace;
    await until(async () => { trace = await f.trace(); return trace.steps.some(step => step.phase === 'owner-still-active'); });
    const result = trace.steps.find(step => step.phase === 'result-settled');
    assert.ok(result); assert.equal(result.ownerAborted, false); assert.equal(result.modelAborted, true);
    assert.equal(result.result.stopReason, 'aborted'); assert.deepEqual(result.result.answers, {}); assert.equal(result.result.usage, undefined);
    assert.equal(trace.steps.filter(step => step.phase === 'promise-rejected').length, 0);
    const heldView = await f.session.read(); assert.equal(heldView.phase, 'running');
    assert.equal(heldView.entries.filter(entry => entry.toolResult?.callId === ids.call).length, 0);
    assert.equal(f.remote.chats().length, 1, 'Original owner remains held until the explicit owned fixture release');
    await f.marker(releaseName); await done(f);
    const { observed, row } = await visibleResult(f); assert.equal(observed.ownerAlive, true); assert.equal(observed.result.stopReason, 'aborted');
    assert.equal(row.toolResult.isError, true); assert.equal(f.remote.classifications().length, 1); assert.equal(f.remote.chats().length, 2);
    await f.session.close(); const raw = await readRecords(f);
    assert.equal(raw.owner.state.status, 'terminal'); assert.equal(raw.owner.state.outcome.status, 'completed');
    assert.equal(formalTool(raw).length, 1); assert.equal(sumTokens(raw.usage.tools), 0); assert.equal(sumTokens(raw.usage.models), 6);
    await assertSuccessfulReadback(f, accepted, raw);
  });
});

test('普通classifier有效OAuth：原SDK认证真实HTTP，不以APIkey专用旁路代替',async t=>withClassifier(t,{credentialMode:'oauth'},async f=>{
  assert.equal((await f.session.submit(f.input)).status,'accepted');await done(f);assertWire(f);
  assert.equal((await visibleResult(f)).observed.result.stopReason,'stop');
}));
test('额外来源只有classifier、chat集合为空时仍用已配置原preset执行；不扩入聊天选择',async t=>withClassifier(t,{typedOnly:true},async f=>{
  assert.equal((await f.session.submit(f.input)).status,'accepted');await done(f);
  assert.equal(f.remote.classifications().length,1);const request=f.remote.classifications()[0];
  assert.equal(request.body.model,'jev-latest');assert.equal(request.authOk,true);
  const {observed}=await visibleResult(f);assert.equal(observed.result.provider,'typesafe');assert.equal(observed.result.model,'jev-latest');assert.equal(observed.result.stopReason,'stop');
  assert.ok(f.admissions.some(one=>one.operation==='classify'&&one.sourceId==='typesafe'&&one.modelId==='jev-latest'));
  assert.ok(f.remote.chats().every(one=>one.body.model===ids.chat));assert.deepEqual(f.remote.invalid,[]);
}));
test('分类请求回调不得替换原state/questions：真实SDK有限错误，零分类HTTP且原工具收束',async t=>withClassifier(t,{tamper:true},async f=>{
  assert.equal((await f.session.submit(f.input)).status,'accepted');await done(f);
  assert.equal(f.remote.classifications().length,0);assert.equal(f.remote.chats().length,2);
  const {observed}=await visibleResult(f);assert.equal(observed.result.stopReason,'error');assert.equal(observed.result.usage,undefined);
  assert.equal(observed.ownerAlive,true);assert.deepEqual(f.remote.invalid,[]);
}));
for(const credentialMode of ['api_key','oauth'])test('普通classifier '+credentialMode+'在SDK准入等待期间改认证：旧新身份均零分类HTTP、有限错误无重发',async t=>withClassifier(t,{credentialMode,authChange:true},async f=>{
  assert.equal((await f.session.submit(f.input)).status,'accepted');await done(f);
  assert.equal(f.remote.classifications().length,0);assert.equal(f.remote.chats().length,2);
  assert.ok(f.admissions.some(request=>request.operation==='classify'));
  const {observed}=await visibleResult(f);assert.equal(observed.result.stopReason,'error');assert.equal(observed.result.usage,undefined);
  assert.equal(observed.ownerAlive,true);assert.deepEqual(f.remote.invalid,[]);
  const trace=await f.trace();assert.equal(trace.steps.some(step=>step.phase==='promise-rejected'),false);
}));

for (const stop of ['pause', 'close']) test('普通classifier/' + stop + '：同HTTP取消、关闭／只读重开零请求、明确继续沿原身份不重发', { timeout: 30000 }, async t => {
  await withClassifier(t, { hold: true }, async f => {
    const accepted = await f.session.submit(f.input); assert.equal(accepted.status, 'accepted');
    await until(() => f.remote.classifications().length === 1); const parked = f.remote.classifications()[0]; assertWire(f);
    assert.equal(parked.finished, false);
    if (stop === 'pause') { assert.equal((await f.session.pause()).phase, 'paused'); await until(() => parked.closedBeforeFinal); }
    await f.session.close(); await until(() => parked.closedBeforeFinal);
    assert.equal(parked.finished, false); assert.equal(f.remote.chats().length, 1);
    const interrupted = await readRecords(f);
    assert.ok(interrupted.child.state.status !== 'terminal' || interrupted.child.state.outcome.status !== 'completed',
      'The accepted remote request has no confirmed final result');
    assert.equal(sumTokens(interrupted.usage.tools), 0, 'Held service supplied no usage; no charge may be invented');
    f.session = await f.backend.open({ ...f.opening, initialize: false });
    assert.equal((await f.session.read()).phase, 'paused');
    assert.equal((await f.session.submit(f.input)).submissionId, accepted.submissionId);
    await f.session.lookupReceipt(f.input); await f.session.read();
    assert.equal(f.remote.classifications().length, 1); assert.equal(f.remote.chats().length, 1);
    assert.equal((await f.effects()).filter(item => item.phase === 'tool-start').length, 1);
    await f.session.resume((await f.session.read()).control); await done(f);
    assert.equal(f.remote.classifications().length, 1, 'Explicit resume must not replay an already accepted unknown classification');
    assert.equal(f.remote.classifications()[0], parked); assert.equal(f.remote.chats().length, 2);
    const rows = (await f.session.read()).entries.filter(entry => entry.toolResult?.name === ids.tool && entry.toolResult.callId === ids.call);
    assert.equal(rows.length, 1); assert.equal(rows[0].toolResult.isError, true);
    await f.session.close(); const restored = await readRecords(f);
    assert.equal(restored.child.id, interrupted.child.id); assert.equal(restored.owner.id, interrupted.owner.id);
    assert.deepEqual(restored.submissionIdentity, interrupted.submissionIdentity);
    assert.equal(restored.child.state.status, 'terminal'); assert.notEqual(restored.child.state.outcome.status, 'completed');
    assert.equal(formalTool(restored).length, 1); assert.equal(formalTool(restored)[0].isError, true);
    assert.equal(sumTokens(restored.usage.tools), 0); assert.equal(sumTokens(restored.usage.models), 6);
    assert.equal((await f.effects()).filter(item => item.phase === 'tool-start').length, 1);
    assert.deepEqual(f.remote.invalid, []);
  });
});
