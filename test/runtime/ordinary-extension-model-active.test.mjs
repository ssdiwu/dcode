// 真实 SDK 扩展工具内的单次模型消费者；仅脚本化拥有的远端边界。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { GenerationTask, ToolTask, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { createRealPiBackend, ModelSetupStore } from '../../src/adapters/pi/index.ts';
import { prepareCodingProject, codingKey, codingModel } from '../e2e/ordinary-coding-fixture.mjs';
import { until } from './fixtures.ts';

const toolName = 'owned_active_chat';
const callId = 'owned-active-tool-1';

// Only the remote boundary is scripted. Real SDK protocol conversion, tools, tasks and storage remain real.
async function activeHttp({ nonce, method, hold, releaseable = false }) {
  const marker = 'OWNED_SINGLE_CHAT_INPUT_' + nonce;
  const innerText = 'OWNED_SINGLE_CHAT_RESULT_' + nonce;
  const outerText = 'OWNED_OUTER_RESULT_' + nonce;
  const requests = []; const errors = []; const held = new Map();
  const sse = (res, id, delta, finish, usage) => res.write('data: ' + JSON.stringify({ id,
    model: codingModel, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) }) + '\n\n');
  const finishHeld = (record, res) => {
    if (record.finished || res.destroyed) throw new Error('Owned held request cannot be completed twice or after close');
    if (!res.headersSent) res.writeHead(200, { 'content-type': 'text/event-stream' });
    sse(res, record.id, { role:'assistant', content:'OWNED_SINGLE_CHAT_RESULT_' }, null);
    sse(res, record.id, { content:nonce }, null);
    sse(res, record.id, {}, 'stop', { prompt_tokens:117, completion_tokens:13, total_tokens:130 });
    record.finished = true; held.delete(record); res.end('data: [DONE]\n\n');
  };
  const server = http.createServer((req, res) => {
    if (req.url === '/catalog') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"models":[],"providers":[]}'); return; }
    if (req.url !== '/v1/chat/completions' || req.method !== 'POST') { res.writeHead(404); res.end(); return; }
    const chunks = []; req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString()); }
      catch { errors.push('invalid fixture request JSON'); res.writeHead(400); res.end(); return; }
      const direct = body.messages?.some(message => message.role === 'user' && message.content === marker);
      const kind = direct ? 'direct' : 'outer';
      const ordinal = requests.filter(item => item.kind === kind).length + 1;
      const id = 'owned-' + kind + '-' + nonce + '-' + ordinal;
      const record = { kind, ordinal, id, body, authOk: req.headers.authorization === 'Bearer ' + codingKey,
        accepted: true, closedBeforeFinal: false, finished: false };
      requests.push(record);
      if (releaseable && kind === 'outer' && ordinal === 2 && !requests.find(item => item.kind === 'direct')?.finished)
        errors.push('Outer continuation escaped before the owned direct final');
      res.once('close', () => { record.closedBeforeFinal = !record.finished; });
      if (!record.authOk || body.model !== codingModel || ordinal > (direct ? 1 : 2)) {
        errors.push('request identity or duplicate count invalid'); res.writeHead(400); res.end(); return;
      }
      // Holding complete sends no response at all; holding stream sends a genuine partial SSE then waits.
      // In both cases the same recorded request was accepted before cancellation; no terminal result is sent.
      if (direct && hold) {
        held.set(record, res);
        if (method === 'streamSimple') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          sse(res, id, { role: 'assistant', content: 'OWNED_PARTIAL_' + nonce }, null);
        }
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (direct) {
        sse(res, id, { role: 'assistant', content: 'OWNED_SINGLE_CHAT_RESULT_' }, null);
        sse(res, id, { content: nonce }, null);
        sse(res, id, {}, 'stop', { prompt_tokens: 117, completion_tokens: 13, total_tokens: 130 });
      } else if (ordinal === 1) {
        sse(res, id, { role: 'assistant', tool_calls: [{ index: 0, id: callId, type: 'function',
          function: { name: toolName, arguments: JSON.stringify({ method }) } }] }, null);
        sse(res, id, {}, 'tool_calls', { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 });
      } else {
        sse(res, id, { role: 'assistant', content: outerText }, null);
        sse(res, id, {}, 'stop', { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 });
      }
      record.finished = true; res.end('data: [DONE]\n\n');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { origin: 'http://127.0.0.1:' + server.address().port, marker, innerText, outerText, requests, errors,
    direct: () => requests.filter(item => item.kind === 'direct'), outer: () => requests.filter(item => item.kind === 'outer'),
    releaseDirect() { assert.equal(held.size, 1, 'One actual accepted HTTP must be held'); for (const [record, res] of held) finishHeld(record, res); },
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

function extensionSource(nonce, marker) {
  return `import { Type } from 'typebox';
export default function(pi) {
  pi.registerTool({name:${JSON.stringify(toolName)},label:'owned single chat',description:'One owned SDK model request inside the real tool task',
    parameters:Type.Object({method:Type.Union([Type.Literal('complete'),Type.Literal('streamSimple')])}),
    async execute(id,args,signal,onUpdate,ctx) {
      if(!signal || ctx.signal!==signal || signal.aborted)throw new Error('Original tool signal missing');
      const model=ctx.modelRegistry.find('user-defined',${JSON.stringify(codingModel)});
      if(!model)throw new Error('Original configured chat model missing');
      const input={messages:[{role:'user',content:${JSON.stringify(marker)},timestamp:Date.now()}]};
      const options={signal,maxRetries:0,maxTokens:32,temperature:0};
      let result;const eventTypes=[];let deltas='';let synchronousStream=null;
      if(args.method==='complete')result=await ctx.modelRegistry.complete(model,input,options);
      else {
        const stream=ctx.modelRegistry.streamSimple(model,input,options);
        synchronousStream=typeof stream?.then!=='function' && typeof stream?.[Symbol.asyncIterator]==='function' && typeof stream?.result==='function';
        if(!synchronousStream)throw new Error('Public stream contract not preserved');
        for await(const event of stream){eventTypes.push(event.type);if(event.type==='text_delta'){
          deltas+=event.delta;onUpdate?.({content:[{type:'text',text:event.delta}]});}}
        result=await stream.result();
      }
      if(signal.aborted)throw new Error('Late model result cannot finish an aborted owner');
      const observed={probe:'owned-single-chat',nonce:${JSON.stringify(nonce)},originalToolCallId:id,method:args.method,
        signalSame:true,synchronousStream,eventTypes,deltas,
        message:{role:result.role,provider:result.provider,model:result.model,responseId:result.responseId,stopReason:result.stopReason,
          text:result.content.filter(part=>part.type==='text').map(part=>part.text).join(''),usage:result.usage}};
      // AgentToolResult has content/details. Do not invent a model assistant entry or return fake usage to the host.
      // The host must carry real owned model-operation usage into the outer Durable ToolExecutionResult itself.
      return {content:[{type:'text',text:JSON.stringify(observed)}],details:{ownedModelObservation:observed}};
    }});
}`;
}

async function fixture(method, { hold = false, releaseable = false, source = extensionSource } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dcode-owned-model-')); const project = join(root, 'project');
  const nonce = randomUUID(); let remote; let backend; let session;
  try {
    await prepareCodingProject(project); remote = await activeHttp({ nonce, method, hold, releaseable });
    await mkdir(join(project, '.pi/extensions'), { recursive: true });
    await writeFile(join(project, '.pi/mcp.json'), JSON.stringify({ mcpServers: {} }));
    await writeFile(join(project, '.pi/extensions/active-model.ts'), source(nonce, remote.marker));
    const stateDir = join(root, 'state');
    const cipher = { isAvailable: () => true, encrypt: text => Buffer.from(text), decrypt: bytes => bytes.toString() };
    const store = new ModelSetupStore({ stateDir }, cipher);
    const config = { provider: 'openai-completions', label: 'owned active model fixture', modelId: codingModel, baseUrl: remote.origin + '/v1' };
    await store.commitWithCredential({ ...config, note: 'ready', keyAction: 'replace', apiKey: codingKey });
    const admissions = [];
    backend = createRealPiBackend({ stateDir, cipher, store, config, admitRequest: async request => {
      admissions.push({ ...request });
      return { ok: true, reason: null, target: { sourceId: request.sourceId, modelId: request.modelId, thinkingLevel: null } };
    } });
    const target = { workspaceId: 'space', taskId: 'task', sessionId: 'owned-active-model-session' };
    const opening = { target, title: 'Owned single model call', workFolder: project, model: null, initialize: true,
      projectAccess: 'task-owner', projectExtensionsEnabled: () => true };
    session = await backend.open(opening);
    const input = { target, operationId: 'owned-active-operation-' + nonce, text: 'Run the one owned active chat tool',
      mode: 'follow-up', references: [], expected: (await session.read()).control };
    return { root, stateDir, nonce, remote, backend, opening, target, input, admissions, config, cipher,
      get session() { return session; }, set session(value) { session = value; },
      async dispose() { try { await session?.close(); } finally { await remote.close(); await rm(root, { recursive: true, force: true }); } } };
  } catch (error) {
    try { await session?.close(); } finally { await remote?.close(); await rm(root, { recursive: true, force: true }); }
    throw error;
  }
}

// Read only after the real session has closed. This is the public storage reader, not another Harness or model runtime.
async function records(f, nestedToolName) {
  const storage = await openNodeJsonlStorage(join(f.stateDir, 'runtime', f.target.sessionId), context);
  const scan = async (method, query) => {
    const result = []; let cursor;
    do { const page = await storage[method](query, 200, cursor, context); result.push(...page.items); cursor = page.next; } while (cursor !== undefined);
    return result;
  };
  try {
    const entries = await scan('scanEntries', { conversationId: ROOT_CONVERSATION_ID });
    const tasks = await scan('scanTasks', { conversationId: ROOT_CONVERSATION_ID });
    const submissions = await scan('scanSubmissions', { conversationId: ROOT_CONVERSATION_ID });
    // The existing preparation path deliberately has one original receipt and its linked native input.
    // Read that formal link; an active model call must not create another accepted-input identity.
    const preparationRecord = await storage.findDocument({ kind: 'dcode.input-preparation', scope: { kind: 'session' }, key: f.input.operationId }, 'current', context);
    assert.ok(preparationRecord, 'Original prepared-input link must remain available');
    const preparation = await storage.document(preparationRecord.id, 'current', context);
    const innerRequestId = preparation.value.innerRequestId; assert.equal(typeof innerRequestId, 'string');
    const original = await storage.submissionByRequest(ROOT_CONVERSATION_ID, f.input.operationId, context);
    const inner = await storage.submissionByRequest(ROOT_CONVERSATION_ID, innerRequestId, context);
    assert.ok(original); assert.ok(inner); assert.notEqual(original.id, inner.id);
    assert.deepEqual(submissions.map(item => item.id).sort((a,b) => a-b), [original.id, inner.id].sort((a,b) => a-b), 'Only the original receipt and its linked native submission; active calls do not accept new inputs');
    const submissionIdentity = { originalId: original.id, innerId: inner.id, innerRequestId };
    const usageRecord = await storage.findDocument({ kind: 'pi.usage', scope: { kind: 'conversation', conversationId: ROOT_CONVERSATION_ID } }, 'current', context);
    const usage = usageRecord ? (await storage.document(usageRecord.id, 'current', context)).value : { models: {}, tools: {} };
    const messages = entries.flatMap(entry => entry.model ?? []);
    const toolTasks = tasks.filter(task => task.kind === ToolTask.definition.name && task.input.callId === callId);
    assert.equal(toolTasks.length, 1, 'One original model-issued ToolTask, without invented assistant/call identity');
    const directChildren = tasks.filter(task => task.owner === toolTasks[0].id);
    let nestedTask;
    if (nestedToolName) {
      assert.equal(directChildren.length, 1, 'The original tool owns exactly one actual nested tool');
      nestedTask = directChildren[0]; assert.equal(nestedTask.kind, 'dcode.extension-tool');
      assert.equal(nestedTask.input.call.name, nestedToolName); assert.ok(nestedTask.input.call.id.startsWith(callId + '/'));
      assert.equal(nestedTask.conversationId, toolTasks[0].conversationId);
    }
    const children = nestedTask ? tasks.filter(task => task.owner === nestedTask.id) : directChildren;
    assert.equal(children.length, 1, 'Exactly one owned single model task; no detached request or extra execution queue');
    assert.notEqual(children[0].kind, GenerationTask.definition.name, 'The inner request is not a new agent generation loop');
    assert.equal(children[0].conversationId, toolTasks[0].conversationId);
    return { entries, tasks, submissions, submissionIdentity, usage, messages, toolTask: toolTasks[0], child: children[0], ...(nestedTask ? { nestedTask } : {}) };
  } finally { await storage.close(context); }
}

const usageCounts = (actual, input, output) => {
  assert.ok(actual, 'Real usage must be retained'); assert.equal(actual.input, input); assert.equal(actual.output, output);
  assert.equal(actual.cacheRead, 0); assert.equal(actual.cacheWrite, 0); assert.equal(actual.totalTokens, input + output);
};
const sumTokens = bucket => Object.values(bucket).reduce((sum, item) => sum + item.totalTokens, 0);
const formalTool = raw => raw.messages.filter(message => message.role === 'toolResult' && message.toolName === toolName && message.toolCallId === callId);
async function done(f) {
  await until(async () => (await f.session.lookupReceipt(f.input)).processing === 'done');
  await until(async () => (await f.session.read()).phase === 'ready');
}
function assertOriginalAdmission(f) {
  assert.equal(f.admissions.length, f.remote.requests.length, 'Each actual HTTP crosses the original provider admission wrapper once');
  assert.ok(f.admissions.every(item => item.sessionId === f.target.sessionId && item.sourceId === 'user-defined' && item.modelId === codingModel));
}

for (const method of ['complete']) await test(`扩展主动单次chat ${method}：原工具任务拥有、真实SDK HTTP与结果、usage仅记一次`, { timeout: 30000 }, async () => {
  const f = await fixture(method);
  try {
    const accepted = await f.session.submit(f.input); assert.equal(accepted.status, 'accepted'); await done(f);
    assert.equal(f.remote.direct().length, 1); assert.equal(f.remote.outer().length, 2);
    assert.deepEqual(f.remote.errors, []); assert.ok(f.remote.requests.every(item => item.authOk)); assertOriginalAdmission(f);
    const visible = (await f.session.read()).entries.filter(entry => entry.toolResult?.name === toolName);
    assert.equal(visible.length, 1); assert.equal(visible[0].toolResult.isError, false);
    const observed = JSON.parse(visible[0].toolResult.text);
    assert.equal(observed.nonce, f.nonce); assert.equal(observed.originalToolCallId, callId); assert.equal(observed.method, method); assert.equal(observed.signalSame, true);
    assert.equal(observed.message.role, 'assistant'); assert.equal(observed.message.provider, 'user-defined'); assert.equal(observed.message.model, codingModel);
    assert.equal(observed.message.responseId, f.remote.direct()[0].id); assert.equal(observed.message.stopReason, 'stop'); assert.equal(observed.message.text, f.remote.innerText);
    usageCounts(observed.message.usage, 117, 13);
    const actualFact=(await f.session.read()).entries.find(entry=>entry.kind==='dcode.extension-model-result');
    assert.ok(actualFact); assert.equal(actualFact.responseId,observed.message.responseId);
    assert.equal(actualFact.provider,observed.message.provider);assert.equal(actualFact.model,observed.message.model);
    assert.deepEqual(actualFact.usage,{input:117,output:13,cacheRead:0,cacheWrite:0});
    if (method === 'streamSimple') {
      assert.equal(observed.synchronousStream, true); assert.ok(observed.eventTypes.includes('text_delta')); assert.ok(observed.eventTypes.includes('done'));
      assert.equal(observed.deltas, f.remote.innerText);
    }
    assert.ok(f.remote.outer()[1].body.messages.some(message => message.role === 'tool' && message.tool_call_id === callId && message.content === JSON.stringify(observed)), 'Real outer result reaches the same agent continuation SDK HTTP');
    await f.session.close(); const raw = await records(f); const result = formalTool(raw);
    assert.equal(result.length, 1); assert.equal(result[0].isError, false); assert.deepEqual(result[0].usage, observed.message.usage);
    assert.deepEqual(raw.usage.tools[toolName], result[0].usage); assert.equal(sumTokens(raw.usage.models), 6, 'Inner spend belongs to the tool; do not count it again as a conversation assistant');
    assert.equal(raw.child.state.status, 'terminal'); assert.equal(raw.child.state.outcome.status, 'completed');
    assert.ok(JSON.stringify(raw.child.state.outcome.result).includes(f.remote.direct()[0].id), 'Real inner response is recoverable from its original durable task outcome');
    assert.equal(raw.entries.filter(entry => entry.kind === 'pi.user').length, 1);
    assert.equal(raw.messages.filter(message => message.role === 'assistant').length, 2);
    assert.ok(!raw.messages.some(message => message.role === 'assistant' && (message.responseId === observed.message.responseId || JSON.stringify(message.content).includes(f.remote.innerText))), 'Do not project the direct return value as a fake conversation assistant');
    const counts = f.remote.requests.length;
    f.session = await f.backend.open({ ...f.opening, initialize: false }); await f.session.read();
    assert.equal((await f.session.submit(f.input)).submissionId, accepted.submissionId); assert.equal((await f.session.lookupReceipt(f.input)).processing, 'done');
    assert.equal(f.remote.requests.length, counts, 'Completed original operation is read back, without a fresh active call');
    await f.session.close(); const readBack = await records(f);
    assert.equal(readBack.child.id, raw.child.id); assert.equal(readBack.toolTask.id, raw.toolTask.id);
    assert.deepEqual(readBack.submissionIdentity, raw.submissionIdentity); assert.deepEqual(readBack.usage, raw.usage);
    assert.equal(formalTool(readBack).length, 1);
  } finally { await f.dispose(); }
});

for (const [method, stop] of [['complete', 'close'], ['complete', 'pause']]) await test(`扩展主动单次chat ${method}/${stop}：同一在途HTTP取消，原身份只读重开与显式继续均不盲重放`, { timeout: 30000 }, async () => {
  const f = await fixture(method, { hold: true });
  try {
    const accepted = await f.session.submit(f.input); assert.equal(accepted.status, 'accepted');
    await until(() => f.remote.direct().length === 1); const parked = f.remote.direct()[0];
    assert.equal(parked.accepted, true); assert.equal(parked.finished, false);
    if (stop === 'pause') { const paused = await f.session.pause(); assert.equal(paused.phase, 'paused'); await until(() => parked.closedBeforeFinal); }
    await f.session.close(); await until(() => parked.closedBeforeFinal);
    assert.equal(f.remote.outer().length, 1, 'Pause/close must not leak an outer follow-up request');
    const interrupted = await records(f); const childId = interrupted.child.id; const ownerId = interrupted.toolTask.id;
    assert.ok(interrupted.child.state.status !== 'terminal' || interrupted.child.state.outcome.status !== 'completed', 'Accepted remote request has no confirmed terminal result');
    f.session = await f.backend.open({ ...f.opening, initialize: false }); const reopened = await f.session.read(); assert.equal(reopened.phase, 'paused');
    assert.equal((await f.session.submit(f.input)).submissionId, accepted.submissionId);
    await f.session.lookupReceipt(f.input); await f.session.read();
    assert.equal(f.remote.direct().length, 1); assert.equal(f.remote.outer().length, 1, 'Read/retry of the original operation cannot implicitly resume');
    await f.session.resume((await f.session.read()).control); await done(f);
    assert.equal(f.remote.direct().length, 1, 'An already accepted inner request with unknown result must not be sent again, even on explicit continue');
    assert.equal(f.remote.direct()[0], parked); assert.equal(parked.closedBeforeFinal, true);
    assert.equal(f.remote.outer().length, 2); assert.deepEqual(f.remote.errors, []); assertOriginalAdmission(f);
    const visible = (await f.session.read()).entries.filter(entry => entry.toolResult?.name === toolName && entry.toolResult.callId === callId);
    assert.equal(visible.length, 1); assert.equal(visible[0].toolResult.isError, true); assert.ok(visible[0].toolResult.text.length > 0);
    assert.ok(!visible[0].toolResult.text.includes(f.remote.innerText), 'An unknown direct result cannot be turned into a claimed successful response');
    await f.session.close(); const restored = await records(f);
    assert.equal(restored.child.id, childId); assert.equal(restored.toolTask.id, ownerId); assert.deepEqual(restored.submissionIdentity, interrupted.submissionIdentity);
    assert.equal(restored.child.state.status, 'terminal'); assert.notEqual(restored.child.state.outcome.status, 'completed');
    assert.equal(formalTool(restored).length, 1); assert.equal(formalTool(restored)[0].isError, true);
    assert.equal(sumTokens(restored.usage.tools), 0, 'The held server sent no terminal usage; do not invent a completed charge');
    assert.equal(restored.entries.filter(entry => entry.kind === 'pi.user').length, 1);
  } finally { await f.dispose(); }
});


const detachedPhaseFile = 'owned-void-complete-handler-returned.json';
function detachedExtensionSource(nonce, marker) {
  return `import { Type } from 'typebox';import {writeFile,rename} from 'node:fs/promises';import {join} from 'node:path';
export default function(pi){pi.registerTool({name:${JSON.stringify(toolName)},label:'owned detached complete',description:'Return immediately after starting one owned complete',
parameters:Type.Object({method:Type.Literal('complete')}),async execute(id,args,signal,onUpdate,ctx){
  if(!signal||ctx.signal!==signal||signal.aborted)throw new Error('Original tool signal missing');
  const model=ctx.modelRegistry.find('user-defined',${JSON.stringify(codingModel)});if(!model)throw new Error('Original configured model missing');
  void ctx.modelRegistry.complete(model,{messages:[{role:'user',content:${JSON.stringify(marker)},timestamp:Date.now()}]},
    {signal,maxRetries:0,maxTokens:32,temperature:0}).catch(()=>{});
  // 这是隔离夹具的返回后microtask观察，不是产品事实，也不靠固定延时证明join。
  queueMicrotask(()=>{const file=join(ctx.cwd,${JSON.stringify(detachedPhaseFile)});void writeFile(file+'.tmp',JSON.stringify({nonce:${JSON.stringify(nonce)},callId:id,phase:'handler-returned-microtask'})).then(()=>rename(file+'.tmp',file));});
  return {content:[{type:'text',text:${JSON.stringify('OWNED_VOID_TOOL_RESULT_'+nonce)}}]};
}});}`;
}
// JsonlStorage.open may repair torn tails. Never open the original live directory for this observation.
// Only copy owned fixture data, then use the public reader on that disposable copy; no Harness/model is created.
async function copyOwnedRecords(f,destination) {
  const original=join(f.stateDir,'runtime',f.target.sessionId);let snapshot;
  await until(async()=>{
    const names=(await readdir(original)).filter(name=>/^(main|doc-\d+|task-\d+)\.jsonl$/.test(name)).sort();
    try {
      const before=await Promise.all(names.map(name=>readFile(join(original,name))));
      const afterNames=(await readdir(original)).filter(name=>/^(main|doc-\d+|task-\d+)\.jsonl$/.test(name)).sort();
      if(JSON.stringify(names)!==JSON.stringify(afterNames))return false;
      const after=await Promise.all(names.map(name=>readFile(join(original,name))));
      if(!before.every((bytes,index)=>bytes.equals(after[index])))return false;
      snapshot=names.map((name,index)=>({name,bytes:before[index]}));return true;
    } catch(error) {if(error.code==='ENOENT')return false;throw error;}
  });
  await mkdir(destination,{recursive:true});await Promise.all(snapshot.map(({name,bytes})=>writeFile(join(destination,name),bytes)));
}
async function heldOwnedStage(f) {
  const snapshotDir=join(f.root,'held-records-'+randomUUID());let storage;
  try {
    await copyOwnedRecords(f,snapshotDir);
    storage=await openNodeJsonlStorage(snapshotDir,context);
    const scan=async(method)=>{const items=[];let cursor;do{const page=await storage[method]({conversationId:ROOT_CONVERSATION_ID},200,cursor,context);items.push(...page.items);cursor=page.next;}while(cursor!==undefined);return items;};
    const entries=await scan('scanEntries'),tasks=await scan('scanTasks');
    const liveRecord=await storage.findDocument({kind:'pi.live',scope:{kind:'conversation',conversationId:ROOT_CONVERSATION_ID}},'current',context);
    const live=liveRecord?(await storage.document(liveRecord.id,'current',context)).value:undefined;
    return {entries,tasks,live};
  } finally {await storage?.close(context);await rm(snapshotDir,{recursive:true,force:true});}
}
const resultEntries = (raw,name,id) => raw.entries.filter(entry => (entry.model??[]).some(message=>message.role==='toolResult'&&message.toolName===name&&message.toolCallId===id));
const resultFact = (raw,responseId) => raw.entries.filter(entry=>entry.kind==='dcode.extension-model-result'&&JSON.stringify(entry).includes(responseId));

await test('扩展void complete：真实HTTP扣住且handler已返回，原工具阶段不得先结束；放行后子任务与结果有序完成',{timeout:30000},async()=>{
  const f=await fixture('complete',{hold:true,releaseable:true,source:detachedExtensionSource});
  try {
    const accepted=await f.session.submit(f.input);assert.equal(accepted.status,'accepted');
    await until(()=>f.remote.direct().length===1);const parked=f.remote.direct()[0];assert.equal(parked.accepted,true);assert.equal(parked.finished,false);
    const phasePath=join(f.root,'project',detachedPhaseFile);
    await until(()=>readFile(phasePath,'utf8').then(text=>JSON.parse(text).phase==='handler-returned-microtask',error=>{if(error.code==='ENOENT')return false;throw error;}));
    assert.deepEqual(JSON.parse(await readFile(phasePath,'utf8')),{nonce:f.nonce,callId,phase:'handler-returned-microtask'});
    const held=await heldOwnedStage(f),owners=held.tasks.filter(task=>task.kind===ToolTask.definition.name&&task.input.callId===callId);
    assert.equal(owners.length,1);const owner=owners[0],children=held.tasks.filter(task=>task.owner===owner.id);assert.equal(children.length,1);
    const child=children[0];assert.notEqual(child.kind,GenerationTask.definition.name);assert.equal(child.conversationId,owner.conversationId);
    assert.notEqual(owner.state.status,'terminal','handler返回不等于拥有者工具完成');assert.notEqual(child.state.status,'terminal');
    const slot=held.live?.tools?.find(tool=>tool.callId===callId);assert.ok(slot);assert.equal(slot.taskId,owner.id);assert.equal(slot.status,'running');assert.equal(slot.entry,undefined);
    assert.equal(resultEntries(held,toolName,callId).length,0,'真实内层HTTP未放行前不能提交外层正式ToolResult');
    const view=await f.session.read();assert.equal(view.phase,'running');assert.equal(view.entries.filter(entry=>entry.toolResult?.callId===callId).length,0);
    const pending=await f.session.lookupReceipt(f.input);assert.equal(pending.submissionId,accepted.submissionId);assert.ok(['queued','placed'].includes(pending.processing));
    assert.equal(parked.closedBeforeFinal,false);assert.equal(f.remote.outer().length,1);assert.deepEqual(f.remote.errors,[]);
    f.remote.releaseDirect();await done(f);assert.equal(parked.finished,true);assert.equal(parked.closedBeforeFinal,false);
    assert.equal(f.remote.direct().length,1);assert.equal(f.remote.outer().length,2);assertOriginalAdmission(f);assert.deepEqual(f.remote.errors,[]);
    await f.session.close();const raw=await records(f),formal=formalTool(raw);assert.equal(formal.length,1);assert.equal(formal[0].isError,false);
    assert.equal(formal[0].content.filter(part=>part.type==='text').map(part=>part.text).join(''),'OWNED_VOID_TOOL_RESULT_'+f.nonce);
    usageCounts(formal[0].usage,117,13);assert.deepEqual(raw.usage.tools[toolName],formal[0].usage);assert.equal(sumTokens(raw.usage.tools),130);assert.equal(sumTokens(raw.usage.models),6);
    assert.equal(raw.toolTask.id,owner.id);assert.equal(raw.child.id,child.id);assert.equal(raw.child.state.status,'terminal');assert.equal(raw.child.state.outcome.status,'completed');
    assert.ok(JSON.stringify(raw.child.state.outcome.result).includes(parked.id));const facts=resultFact(raw,parked.id);assert.equal(facts.length,1);
    const results=resultEntries(raw,toolName,callId);assert.equal(results.length,1);assert.ok(facts[0].id<results[0].id,'真实模型结果事实必须先于外层正式工具结果');
    assert.equal(results[0].byTaskId,raw.toolTask.id);assert.equal(raw.messages.filter(message=>message.role==='assistant').length,2);
    assert.ok(!raw.messages.some(message=>message.role==='assistant'&&message.responseId===parked.id));assert.equal(raw.entries.filter(entry=>entry.kind==='pi.user').length,1);
  } finally {await f.dispose();}
});

const nestedModelToolName = 'owned_nested_active_chat';
function nestedExtensionSource(nonce, marker) {
  return `import { Type } from 'typebox';export default function(pi){
pi.on('tool_result',event=>{if(event.toolName===${JSON.stringify(nestedModelToolName)})return {content:[{type:'text',text:${JSON.stringify('NESTED_AFTER_TOOL_'+nonce)}},...event.content],details:event.details};});
pi.registerTool({name:${JSON.stringify(nestedModelToolName)},label:'owned nested chat',description:'Actual inner tool owns one model call',parameters:Type.Object({}),async execute(id,args,signal,onUpdate,ctx){
  if(!signal||ctx.signal!==signal||signal.aborted)throw new Error('Nested tool signal missing');
  const model=ctx.modelRegistry.find('user-defined',${JSON.stringify(codingModel)});if(!model)throw new Error('Original model missing');
  const result=await ctx.modelRegistry.complete(model,{messages:[{role:'user',content:${JSON.stringify(marker)},timestamp:Date.now()}]},{signal,maxRetries:0,maxTokens:32,temperature:0});
  const observed={probe:'nested-single-chat',nonce:${JSON.stringify(nonce)},innerCallId:id,signalSame:true,message:{role:result.role,provider:result.provider,model:result.model,responseId:result.responseId,stopReason:result.stopReason,text:result.content.filter(part=>part.type==='text').map(part=>part.text).join(''),usage:result.usage}};
  return {content:[{type:'text',text:JSON.stringify(observed)}],details:{ownedModelObservation:observed}};
}});
pi.registerTool({name:${JSON.stringify(toolName)},label:'owned outer nested chat',description:'Call a real nested extension tool',parameters:Type.Object({method:Type.Literal('complete')}),async execute(id,args,signal,onUpdate,ctx){
  const inner=await ctx.executeTool(${JSON.stringify(nestedModelToolName)},{});if(inner.isError)throw new Error('Actual nested tool failed');
  return {content:[{type:'text',text:${JSON.stringify('NESTED_OUTER_'+nonce)}},...inner.result.content],details:{nestedCallId:inner.toolCall.id}};
}});}`;
}

await test('扩展嵌套工具内complete：两层正式Task及模型子任务保owner，内层真实usage只入一次账且重开不重放',{timeout:30000},async()=>{
  const f=await fixture('complete',{source:nestedExtensionSource});
  try {
    const accepted=await f.session.submit(f.input);assert.equal(accepted.status,'accepted');await done(f);
    assert.equal(f.remote.direct().length,1);assert.equal(f.remote.outer().length,2);assertOriginalAdmission(f);assert.deepEqual(f.remote.errors,[]);
    const visible=(await f.session.read()).entries.filter(entry=>entry.toolResult?.name===nestedModelToolName);assert.equal(visible.length,1);assert.equal(visible[0].toolResult.isError,false);
    assert.ok(visible[0].toolResult.text.includes(f.remote.innerText));assert.ok(visible[0].toolResult.text.includes('NESTED_AFTER_TOOL_'+f.nonce));
    await f.session.close();const raw=await records(f,nestedModelToolName),outer=formalTool(raw);assert.equal(outer.length,1);assert.equal(outer[0].isError,false);
    const nestedId=raw.nestedTask.input.call.id;assert.equal(raw.nestedTask.owner,raw.toolTask.id);assert.equal(raw.child.owner,raw.nestedTask.id);
    for(const task of [raw.toolTask,raw.nestedTask,raw.child]){assert.equal(task.state.status,'terminal');assert.equal(task.state.outcome.status,'completed');assert.equal(task.conversationId,ROOT_CONVERSATION_ID);}
    assert.notEqual(raw.nestedTask.kind,GenerationTask.definition.name);assert.notEqual(raw.child.kind,GenerationTask.definition.name);
    const inner=raw.messages.filter(message=>message.role==='toolResult'&&message.toolName===nestedModelToolName&&message.toolCallId===nestedId);assert.equal(inner.length,1);assert.equal(inner[0].isError,false);
    const observed=inner[0].details.ownedModelObservation;assert.equal(observed.nonce,f.nonce);assert.equal(observed.innerCallId,nestedId);assert.equal(observed.signalSame,true);
    assert.equal(observed.message.role,'assistant');assert.equal(observed.message.provider,'user-defined');assert.equal(observed.message.model,codingModel);
    assert.equal(observed.message.responseId,f.remote.direct()[0].id);assert.equal(observed.message.stopReason,'stop');assert.equal(observed.message.text,f.remote.innerText);usageCounts(observed.message.usage,117,13);
    // D Code既有正式inner记录拥有本调用成本；外层只转交正文，不能再加同一笔费用。
    assert.deepEqual(inner[0].usage,observed.message.usage);assert.deepEqual(raw.usage.tools[nestedModelToolName],inner[0].usage);
    assert.equal(outer[0].usage?.totalTokens??0,0);assert.equal(raw.usage.tools[toolName]?.totalTokens??0,0);
    const paid=raw.messages.filter(message=>message.role==='toolResult'&&(message.usage?.totalTokens??0)>0);assert.deepEqual(paid,[inner[0]]);
    assert.deepEqual(Object.entries(raw.usage.tools).filter(([,usage])=>usage.totalTokens>0).map(([name])=>name),[nestedModelToolName]);assert.equal(sumTokens(raw.usage.tools),130);assert.equal(sumTokens(raw.usage.models),6);
    const innerEntries=resultEntries(raw,nestedModelToolName,nestedId),outerEntries=resultEntries(raw,toolName,callId);assert.equal(innerEntries.length,1);assert.equal(outerEntries.length,1);
    assert.equal(innerEntries[0].byTaskId,raw.nestedTask.id);assert.equal(outerEntries[0].byTaskId,raw.toolTask.id);assert.ok(innerEntries[0].id<outerEntries[0].id);
    assert.ok(JSON.stringify(raw.child.state.outcome.result).includes(f.remote.direct()[0].id));const facts=resultFact(raw,f.remote.direct()[0].id);assert.equal(facts.length,1);assert.ok(facts[0].id<innerEntries[0].id);
    const assistant=raw.entries.find(entry=>entry.id===raw.toolTask.input.assistant);assert.ok(assistant?.model?.some(message=>message.role==='assistant'&&message.content.some(part=>part.type==='toolCall'&&part.id===callId&&part.name===toolName)));
    const assistants=raw.messages.filter(message=>message.role==='assistant');assert.equal(assistants.length,2);
    assert.deepEqual(assistants.map(message=>message.responseId).sort(),f.remote.outer().map(request=>request.id).sort());
    assert.ok(!assistants.some(message=>message.content.some(part=>part.type==='toolCall'&&part.id===nestedId)||JSON.stringify(message.content).includes(f.remote.innerText)),'不伪造内层模型assistant或子工具调用');
    const next=f.remote.outer()[1];assert.equal(next.body.messages.filter(message=>message.role==='tool'&&message.tool_call_id===nestedId).length,0);
    const forwarded=next.body.messages.filter(message=>message.role==='tool'&&message.tool_call_id===callId);assert.equal(forwarded.length,1);assert.ok(forwarded[0].content.includes(f.remote.innerText));assert.ok(forwarded[0].content.includes('NESTED_AFTER_TOOL_'+f.nonce));
    assert.equal(raw.entries.filter(entry=>entry.kind==='pi.user').length,1);const counts=f.remote.requests.length;
    f.session=await f.backend.open({...f.opening,initialize:false});await f.session.read();assert.equal((await f.session.submit(f.input)).submissionId,accepted.submissionId);assert.equal((await f.session.lookupReceipt(f.input)).processing,'done');assert.equal(f.remote.requests.length,counts);
    await f.session.close();const restored=await records(f,nestedModelToolName);
    assert.deepEqual([restored.toolTask.id,restored.nestedTask.id,restored.child.id],[raw.toolTask.id,raw.nestedTask.id,raw.child.id]);assert.deepEqual(restored.submissionIdentity,raw.submissionIdentity);assert.deepEqual(restored.usage,raw.usage);
    assert.equal(resultEntries(restored,nestedModelToolName,nestedId).length,1);assert.equal(formalTool(restored).length,1);assert.equal(sumTokens(restored.usage.tools),130);
  } finally {await f.dispose();}
});


function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length, 2, '受控夹具必须只替换目标返回分支');
  return source.replace(before, after);
}
for (const ending of ['throw', 'invalid-result', 'invalid-after']) await test(`扩展已完成响应后${ending}：真实用量不随原工具错误丢失`, {timeout:30000}, async()=>{
  const source=(nonce,marker)=>{
    let code=extensionSource(nonce,marker);
    if(ending==='invalid-after')code=replaceOnce(code,'export default function(pi) {',`export default function(pi) {pi.on('tool_result',()=>({content:[{type:'text',text:42}]}));`);
    else code=replaceOnce(code,'return {content:[{type:\'text\',text:JSON.stringify(observed)}],details:{ownedModelObservation:observed}};',
      ending==='throw' ? "throw new Error('Owned tool failure after confirmed model');" : "return {content:[{type:'text',text:42}]};");
    return code;
  };
  const f=await fixture('complete',{source});
  try {
    const accepted=await f.session.submit(f.input);assert.equal(accepted.status,'accepted');await done(f);
    assert.equal(f.remote.direct().length,1);assert.equal(f.remote.outer().length,2);assertOriginalAdmission(f);assert.deepEqual(f.remote.errors,[]);
    const actual=(await f.session.read()).entries.find(entry=>entry.kind==='dcode.extension-model-result');assert.equal(actual.responseId,f.remote.direct()[0].id);assert.deepEqual(actual.usage,{input:117,output:13,cacheRead:0,cacheWrite:0});
    await f.session.close();const raw=await records(f),formal=formalTool(raw);assert.equal(formal.length,1);assert.equal(formal[0].isError,true);
    usageCounts(formal[0].usage,117,13);assert.deepEqual(raw.usage.tools[toolName],formal[0].usage);assert.equal(sumTokens(raw.usage.tools),130);assert.equal(sumTokens(raw.usage.models),6);
    assert.equal(raw.child.state.outcome.status,'completed');assert.equal(raw.toolTask.state.outcome.status,ending==='invalid-after'?'completed':'failed');
    const facts=resultFact(raw,f.remote.direct()[0].id);assert.equal(facts.length,1);assert.equal(facts[0].byTaskId,raw.child.id);assert.ok(facts[0].id<resultEntries(raw,toolName,callId)[0].id);
    assert.equal(raw.messages.filter(message=>message.role==='assistant').length,2);assert.equal(raw.entries.filter(entry=>entry.kind==='pi.user').length,1);
    f.session=await f.backend.open({...f.opening,initialize:false});await f.session.read();assert.equal((await f.session.submit(f.input)).submissionId,accepted.submissionId);assert.equal(f.remote.requests.length,3);
    await f.session.close();const reopened=await records(f);assert.deepEqual(reopened.usage,raw.usage);assert.deepEqual(reopened.submissionIdentity,raw.submissionIdentity);
  } finally {await f.dispose();}
});

await test('扩展嵌套工具已完成响应后throw：内层失败保实际费用，外层不重复计账',{timeout:30000},async()=>{
  const source=(nonce,marker)=>replaceOnce(nestedExtensionSource(nonce,marker),
    "return {content:[{type:'text',text:JSON.stringify(observed)}],details:{ownedModelObservation:observed}};",
    "throw new Error('Nested failure after confirmed model');");
  const f=await fixture('complete',{source});
  try {
    await f.session.submit(f.input);await done(f);assert.equal(f.remote.direct().length,1);assert.equal(f.remote.outer().length,2);assertOriginalAdmission(f);assert.deepEqual(f.remote.errors,[]);
    await f.session.close();const raw=await records(f,nestedModelToolName);const inner=raw.messages.filter(message=>message.role==='toolResult'&&message.toolName===nestedModelToolName);assert.equal(inner.length,1);assert.equal(inner[0].isError,true);usageCounts(inner[0].usage,117,13);
    assert.equal(raw.child.state.outcome.status,'completed');assert.equal(raw.toolTask.state.outcome.status,'failed');assert.equal(formalTool(raw)[0].isError,true);
    assert.equal(formalTool(raw)[0].usage?.totalTokens??0,0);assert.deepEqual(raw.usage.tools[nestedModelToolName],inner[0].usage);assert.equal(sumTokens(raw.usage.tools),130);assert.equal(sumTokens(raw.usage.models),6);
    assert.equal(raw.child.owner,raw.nestedTask.id);assert.equal(raw.nestedTask.owner,raw.toolTask.id);const facts=resultFact(raw,f.remote.direct()[0].id);assert.equal(facts.length,1);assert.equal(facts[0].byTaskId,raw.child.id);
    f.session=await f.backend.open({...f.opening,initialize:false});await f.session.read();assert.equal(f.remote.requests.length,3);await f.session.close();assert.deepEqual((await records(f,nestedModelToolName)).usage,raw.usage);
  } finally {await f.dispose();}
});


for(const nested of [false,true])for(const stop of ['pause','close'])await test(`扩展已完成模型后工具等待/${nested?'nested':'direct'}/${stop}：确认费用跨暂停关闭恢复只记一次`,{timeout:30000},async()=>{
  const phaseFile='completed-model-tool-held.json';
  const source=(nonce,marker)=>{
    let code=(nested?nestedExtensionSource:extensionSource)(nonce,marker);
    code="import {writeFile} from 'node:fs/promises';import {join} from 'node:path';\n"+code;
    return replaceOnce(code,"return {content:[{type:'text',text:JSON.stringify(observed)}],details:{ownedModelObservation:observed}};",
      `await writeFile(join(ctx.cwd,${JSON.stringify(phaseFile)}),JSON.stringify({nonce:${JSON.stringify(nonce)},callId:id,phase:'model-completed-tool-waiting'}));
       await new Promise((resolve,reject)=>{if(signal.aborted)reject(new Error('Original owner already aborted'));else signal.addEventListener('abort',()=>reject(new Error('Original owner stopped')),{once:true});});
       throw new Error('Wait cannot report success');`);
  };
  const f=await fixture('complete',{source});
  try {
    const accepted=await f.session.submit(f.input);assert.equal(accepted.status,'accepted');
    let phase;await until(async()=>{try{phase=JSON.parse(await readFile(join(f.opening.workFolder,phaseFile),'utf8'));return true;}catch{return false;}});
    assert.equal(phase.nonce,f.nonce);assert.equal(phase.phase,'model-completed-tool-waiting');assert.equal(f.remote.direct().length,1);assert.equal(f.remote.direct()[0].finished,true);assert.equal(f.remote.outer().length,1);
    const actual=(await f.session.read()).entries.find(entry=>entry.kind==='dcode.extension-model-result');assert.equal(actual.responseId,f.remote.direct()[0].id);assert.deepEqual(actual.usage,{input:117,output:13,cacheRead:0,cacheWrite:0});
    if(stop==='pause')assert.equal((await f.session.pause()).phase,'paused');await f.session.close();const saved=await records(f,nested?nestedModelToolName:undefined);
    assert.equal(saved.child.state.outcome.status,'completed');assert.equal(sumTokens(saved.usage.tools),130,'已确认130不能因工具仍等待而从官方工具桶消失');assert.equal(sumTokens(saved.usage.models),3);
    const chargedTool=nested?nestedModelToolName:toolName;usageCounts(saved.usage.tools[chargedTool],117,13);
    f.session=await f.backend.open({...f.opening,initialize:false});assert.equal((await f.session.read()).phase,'paused');assert.equal((await f.session.submit(f.input)).submissionId,accepted.submissionId);assert.equal(f.remote.requests.length,2);
    await f.session.resume((await f.session.read()).control);await done(f);assert.equal(f.remote.direct().length,1);assert.equal(f.remote.outer().length,2);assertOriginalAdmission(f);assert.deepEqual(f.remote.errors,[]);
    const visible=(await f.session.read()).entries.filter(entry=>entry.toolResult?.callId===callId);assert.equal(visible.length,1);assert.equal(visible[0].toolResult.isError,true);
    await f.session.close();const restored=await records(f,nested?nestedModelToolName:undefined);assert.deepEqual(restored.usage.tools,saved.usage.tools);assert.equal(sumTokens(restored.usage.tools),130);assert.equal(sumTokens(restored.usage.models),6);
    assert.equal(restored.child.id,saved.child.id);assert.equal(restored.toolTask.id,saved.toolTask.id);assert.deepEqual(restored.submissionIdentity,saved.submissionIdentity);assert.equal(formalTool(restored).length,1);
    assert.equal(restored.messages.filter(message=>message.role==='assistant').length,2);assert.equal(restored.entries.filter(entry=>entry.kind==='pi.user').length,1);assert.equal(resultFact(restored,f.remote.direct()[0].id).length,1);
    f.session=await f.backend.open({...f.opening,initialize:false});await f.session.read();assert.equal(f.remote.requests.length,3);await f.session.close();assert.deepEqual((await records(f,nested?nestedModelToolName:undefined)).usage,restored.usage);
  } finally {await f.dispose();}
});


await test('已确认费用但未停机收口的真实记录：只读重开及关闭均不补账，明确继续才一次消费',{timeout:30000},async()=>{
  const source=(nonce,marker)=>"import {writeFile} from 'node:fs/promises';import {join} from 'node:path';\n"+replaceOnce(extensionSource(nonce,marker),
    "return {content:[{type:'text',text:JSON.stringify(observed)}],details:{ownedModelObservation:observed}};",
    `await writeFile(join(ctx.cwd,'known-before-stop.json'),JSON.stringify({nonce:${JSON.stringify(nonce)},phase:'known-model-owner-waiting'}));await new Promise((resolve,reject)=>{if(signal.aborted)reject(new Error('Stopped'));else signal.addEventListener('abort',()=>reject(new Error('Stopped')),{once:true});});throw new Error('Wait cannot succeed');`);
  const f=await fixture('complete',{source});let restoredSession;
  try {
    const accepted=await f.session.submit(f.input);assert.equal(accepted.status,'accepted');
    await until(()=>readFile(join(f.opening.workFolder,'known-before-stop.json'),'utf8').then(text=>JSON.parse(text).nonce===f.nonce,()=>false));
    assert.equal(f.remote.direct().length,1);assert.equal(f.remote.direct()[0].finished,true);
    // 复制的是实际SDK完成响应后、原工具尚在等待的正式字节，不编辑任何entry/task/费用。
    // 这是恢复夹具，不宣称已经执行操作系统崩溃；原实例先正常关闭再打开不同自有目录副本。
    const stateDir=join(f.root,'restored-state');await copyOwnedRecords(f,join(stateDir,'runtime',f.target.sessionId));
    const reader={...f,stateDir};const before=await records(reader);assert.equal(before.child.state.outcome.status,'completed');assert.equal(sumTokens(before.usage.tools),0);assert.equal(resultFact(before,f.remote.direct()[0].id).length,1);
    await f.session.close();assert.equal(f.remote.requests.length,2);
    const store=new ModelSetupStore({stateDir},f.cipher);await store.commitWithCredential({...f.config,note:'ready',keyAction:'replace',apiKey:codingKey});
    const backend=createRealPiBackend({stateDir,cipher:f.cipher,store,config:f.config,admitRequest:async request=>{f.admissions.push({...request});return {ok:true,reason:null,target:{sourceId:request.sourceId,modelId:request.modelId,thinkingLevel:null}};}});
    for(let observation=0;observation<2;observation++){
      restoredSession=await backend.open({...f.opening,initialize:false});const view=await restoredSession.read();assert.equal(view.phase,'paused');assert.equal((await restoredSession.lookupReceipt(f.input)).submissionId,accepted.submissionId);assert.equal(f.remote.requests.length,2);
      await restoredSession.close();const onlyRead=await records(reader);assert.equal(sumTokens(onlyRead.usage.tools),0,'只读生命周期不能擅自把待对账事实消费掉');assert.equal(onlyRead.child.id,before.child.id);assert.deepEqual(onlyRead.submissionIdentity,before.submissionIdentity);
    }
    restoredSession=await backend.open({...f.opening,initialize:false});await restoredSession.resume((await restoredSession.read()).control);
    await until(async()=>(await restoredSession.lookupReceipt(f.input)).processing==='done');await until(async()=>(await restoredSession.read()).phase==='ready');
    assert.equal(f.remote.direct().length,1);assert.equal(f.remote.outer().length,2);assertOriginalAdmission(f);assert.deepEqual(f.remote.errors,[]);
    await restoredSession.close();const continued=await records(reader);assert.equal(sumTokens(continued.usage.tools),130);assert.equal(sumTokens(continued.usage.models),6);assert.equal(continued.child.id,before.child.id);assert.equal(continued.toolTask.id,before.toolTask.id);assert.equal(formalTool(continued).length,1);assert.equal(formalTool(continued)[0].isError,true);
  }finally{try{await restoredSession?.close();}finally{await f.dispose();}}
});
