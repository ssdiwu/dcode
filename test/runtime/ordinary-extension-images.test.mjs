// 普通扩展image真实SDK、Worker、Durable与持久化生命周期；仅HTTP远端由受控服务提供。
// Only HTTP service responses are controlled. SDK provider/auth/typed parsing/Worker/Durable/storage are real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { ROOT_CONVERSATION_ID, ToolTask } from '@earendil-works/pi-durable';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { createPresetPiBackend, ProviderDirectoryStore, ProviderCatalogService, registerPresetProviders } from '../../src/adapters/pi/index.ts';
import { prepareCodingProject } from '../e2e/ordinary-coding-fixture.mjs';
import { until } from './fixtures.ts';

import { imageFixtureIds as ids, startImageLoopback, imageExtensionSource, makeImageFixtureAssets, makeCapacityImageAssets, imageFixtureFiles } from '../e2e/ordinary-image-fixture.mjs';
const {trace:traceName,effects:effectsName,cancel:cancelName,release:releaseName}=imageFixtureFiles;
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

export async function createImageFixture({ mode = 'success', hold = false, credentialMode = 'api_key', authChange = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dcode-owned-image-')));
  const project = join(root, 'project'), stateDir = join(root, 'state'), nonce = randomUUID(), assets=mode==='capacity'?makeCapacityImageAssets(nonce):makeImageFixtureAssets(nonce),chatModel=mode==='capacity'?'openai/gpt-4.1':ids.chat;
  const fixtureKey = 'owned-image-key-' + randomUUID();
  const originalFetch=globalThis.fetch;
  const loopbackFetch=(input,options)=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
    if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new Error('Owned image runtime requires loopback transport');
    return originalFetch(input,options);};
  globalThis.fetch=loopbackFetch;
  const admissions = [];
  const imageIds=ids;
  let remote, catalog, session;
  try {
    await prepareCodingProject(project);
    await mkdir(join(project, '.pi/extensions'), { recursive: true });
    await writeFile(join(project, '.pi/mcp.json'), '{"mcpServers":{}}');
    await writeFile(join(project, '.pi/extensions/image.ts'), imageExtensionSource(nonce, mode, assets));
    remote = await startImageLoopback({ nonce, key: fixtureKey, mode, hold,assets,chatModel });
    const cipher = encryptedFixtureCipher();
    const store = new ProviderDirectoryStore({ stateDir }, cipher, { catalogBaseUrl: remote.origin + '/catalog' });
    const credential = key => credentialMode === 'oauth' ? { type:'oauth',access:key,refresh:'',expires:Number.MAX_SAFE_INTEGER } : { type:'api_key',key };
    await store.commitCredential(ids.provider, credential(fixtureKey));
    await store.commitPresetSelection({ providerId: ids.provider, modelId: chatModel, note: 'ready' });
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
    const resolution = catalog.resolveExecutable(ids.provider, chatModel);
    assert.ok(resolution?.executable && resolution.model);
    const canonicalImage = preset.provider.getAllModels().find(model => model.type === 'image' && model.id === ids.image);
    assert.ok(canonicalImage, 'The original SDK provider must declare the image, not a test-invented typed model');
    const backend = createPresetPiBackend({
      stateDir, selection: { providerId: ids.provider, modelId: chatModel }, preset,
      model: resolution.model, info: resolution.info, store,
      baseUrlOverrides: { [ids.provider]: remote.origin + '/v1' },
      additionalSources: [{ kind: 'preset', providerId: ids.provider, preset, models: [resolution.model] }],
      admitRequest: async request => {
        admissions.push({ ...request });
        // 真实SDK已准备原认证才进本门；正式store提交另一身份后，旧prepared请求必须零HTTP。
        if(request.operation==='generateImages'&&authChange){await store.commitCredential(ids.provider,credential(fixtureKey+'-rotated'));remote.setKey(fixtureKey+'-rotated');}
        return { ok: true, reason: null, target: { sourceId: request.sourceId, modelId: request.modelId, thinkingLevel: null } };
      },
    });
    const target = { workspaceId: 'owned-space', taskId: 'owned-task', sessionId: 'owned-image-session' };
    const opening = { target, title: 'Owned image contract', workFolder: project, model: null, initialize: true,
      projectAccess: 'task-owner', projectExtensionsEnabled: () => true };
    session = await backend.open(opening);
    const input = { target, operationId: 'owned-image-operation-' + nonce, text: 'Run one owned image generation ' + nonce,
      mode: 'follow-up', references: [], expected: (await session.read()).control };
    return {
      root, project, stateDir, nonce, mode, remote, backend, target, opening, input, admissions, canonicalImage, imageIds, assets,
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


async function withImage(t,options,action){
  const f=await createImageFixture(options);let passed=false,original;
  try{await action(f);passed=true;}catch(error){original=error;throw error;}
  finally{if(!passed){await writeFile(join(f.root,'image-test-failure.json'),JSON.stringify({nonce:f.nonce,mode:f.mode,admissions:f.admissions,requests:f.remote.requests,invalid:f.remote.invalid,error:String(original)},null,2));t.diagnostic('Owned image failure retained at '+f.root);}
    try{await f.dispose(passed);}catch(error){if(!original)throw error;t.diagnostic('Cleanup also failed: '+String(error));}}
}
async function done(f){await until(async()=>(await f.session.lookupReceipt(f.input)).processing==='done');await until(async()=>(await f.session.read()).phase==='ready');}
async function records(f){
 const storage=await openNodeJsonlStorage(join(f.stateDir,'runtime',f.target.sessionId),context);
 const scan=async(method,query)=>{const rows=[];let cursor;do{const page=await storage[method](query,200,cursor,context);rows.push(...page.items);cursor=page.next;}while(cursor!==undefined);return rows;};
 try{const entries=await scan('scanEntries',{conversationId:ROOT_CONVERSATION_ID}),tasks=await scan('scanTasks',{conversationId:ROOT_CONVERSATION_ID});
  const owner=tasks.find(t=>t.kind===ToolTask.definition.name&&t.input.callId===ids.call);assert.ok(owner);
  const children=tasks.filter(t=>t.owner===owner.id);assert.equal(children.length,1);const child=children[0];
  assert.equal(child.input.mode,'generateImages');assert.equal(child.input.provider,ids.provider);assert.equal(child.input.modelId,ids.image);
  const usageDoc=await storage.findDocument({kind:'pi.usage',scope:{kind:'conversation',conversationId:ROOT_CONVERSATION_ID}},'current',context);
  const usage=usageDoc?(await storage.document(usageDoc.id,'current',context)).value:{models:{},tools:{}};
  const accounted=await storage.findDocument({kind:'dcode.extension-model-accounted',scope:{kind:'conversation',conversationId:ROOT_CONVERSATION_ID},key:String(child.id)},'current',context);
  return{entries,tasks,owner,child,usage,accounted:accounted?(await storage.document(accounted.id,'current',context)).value:undefined,messages:entries.flatMap(e=>e.model??[])};
 }finally{await storage.close(context);}
}
const sum=bucket=>Object.values(bucket).reduce((n,u)=>n+u.totalTokens,0);
function assertWire(f){assert.equal(f.remote.images().length,1);const r=f.remote.images()[0];assert.equal(r.accepted,true);assert.equal(r.path,'/v1/chat/completions');assert.equal(r.authOk,true);assert.equal(r.body.model,ids.image);assert.equal(r.body.stream,false);assert.deepEqual(r.body.modalities,['image','text']);assert.ok(f.admissions.some(a=>a.operation==='generateImages'&&a.sessionId===f.target.sessionId&&a.sourceId===ids.provider&&a.modelId===ids.image));assert.deepEqual(f.remote.invalid,[]);}
for(const mode of ['success','billed-malformed-images','bad-pixels','empty-images','no-usage'])test('普通图片/原SDK '+mode+'、原图与已确认费用、关闭只读不重发',{timeout:30000},async t=>withImage(t,{mode},async f=>{
 const accepted=await f.session.submit(f.input);assert.equal(accepted.status,'accepted');await done(f);assertWire(f);
 const trace=await f.trace();assert.equal(trace.steps.filter(s=>s.phase==='promise-rejected').length,0);
 const result=trace.steps.find(s=>s.phase==='result-settled').result;
 const success=mode==='success'||mode==='no-usage';assert.equal(result.stopReason,success?'stop':'error');assert.equal(result.provider,ids.provider);assert.equal(result.model,ids.image);
 if(success){assert.deepEqual(result.output.filter(p=>p.type==='image'),[f.assets.outputImage]);assert.ok(result.output.some(p=>p.type==='text'&&p.text===f.assets.outputText));assert.notEqual(f.assets.inputSha256,f.assets.outputSha256);}
 else assert.equal(result.output.some(p=>p.type==='image'),false,'Unvalidated bytes must never reach the original Worker');
 const view=await f.session.read(),rows=view.entries.filter(e=>e.toolResult?.callId===ids.call);assert.equal(rows.length,1);assert.equal(rows[0].toolResult.isError,!success);assert.deepEqual(rows[0].toolResult.images??[],success?[f.assets.outputImage]:[]);
 const facts=view.entries.filter(e=>e.typedRequest?.operation==='generateImages');assert.equal(facts.length,1);assert.equal(facts[0].typedRequest.result,success?'succeeded':'failed');
 if(mode==='no-usage')assert.equal(result.usage,undefined);else{assert.equal(result.usage.totalTokens,130);assert.deepEqual(facts[0].typedRequest.usage,{input:108,output:13,cacheRead:7,cacheWrite:2});}
 assert.equal(f.remote.chats().length,2);assert.equal(f.remote.chats()[1].hasOriginalToolResult,true);assert.equal(f.remote.chats()[1].forwardedOutputImage,success);
 await f.session.close();const raw=await records(f);assert.equal(raw.child.state.outcome.status,'completed');assert.equal(raw.messages.filter(m=>m.role==='assistant').length,2);assert.equal(raw.entries.filter(e=>e.kind==='pi.user').length,1);assert.equal(sum(raw.usage.models),6);assert.equal(sum(raw.usage.tools),mode==='no-usage'?0:130);
 assert.ok(raw.accounted.response);assert.equal(raw.accounted.done,true);assert.equal(raw.accounted.publishedToOwner,true);assert.ok(!('output' in raw.accounted.response.metadata));
 f.session=await f.backend.open({...f.opening,initialize:false});assert.equal((await f.session.lookupReceipt(f.input)).submissionId,accepted.submissionId);const reopened=await f.session.read();assert.deepEqual(reopened.entries,view.entries);assert.equal(f.remote.images().length,1);assert.equal(f.remote.chats().length,2);
 await f.session.close();const again=await records(f);assert.deepEqual(again.usage,raw.usage);assert.equal(again.child.id,raw.child.id);assert.equal((await f.effects()).filter(e=>e.phase==='tool-start').length,1);
}));
for(const action of ['pause','close'])test('普通图片/HTTP在途'+action+'、只读重开与原输入明确继续零重发',{timeout:30000},async t=>withImage(t,{hold:true},async f=>{
 const accepted=await f.session.submit(f.input);await until(()=>f.remote.images().length===1);assertWire(f);const request=f.remote.images()[0];assert.equal(request.responseWritten,false);
 if(action==='pause'){assert.equal((await f.session.pause()).phase,'paused');await f.session.close();}else await f.session.close();
 await until(()=>request.closedBeforeFinal);const old=await records(f);assert.equal(sum(old.usage.tools),0);assert.ok(!old.accounted?.response);
 f.session=await f.backend.open({...f.opening,initialize:false});assert.equal((await f.session.read()).phase,'paused');assert.equal((await f.session.lookupReceipt(f.input)).submissionId,accepted.submissionId);assert.equal(f.remote.images().length,1);assert.equal(f.remote.chats().length,1);
 await f.session.resume((await f.session.read()).control);await done(f);assert.equal(f.remote.images().length,1);assert.equal(f.remote.chats().length,2);assert.equal((await f.effects()).filter(e=>e.phase==='tool-start').length,1);await f.session.close();const restored=await records(f);assert.equal(restored.child.id,old.child.id);assert.equal(restored.owner.id,old.owner.id);assert.equal(sum(restored.usage.tools),0);
}));
for(const credentialMode of ['api_key','oauth'])test('普通图片/'+credentialMode+'在准入等待换身份、零图片HTTP且原owner保留',{timeout:30000},async t=>withImage(t,{credentialMode,authChange:true},async f=>{
 await f.session.submit(f.input);await done(f);assert.equal(f.remote.images().length,0);assert.equal((await f.trace()).steps.find(s=>s.phase==='result-settled').result.stopReason,'error');await f.session.close();assert.equal(sum((await records(f)).usage.tools),0);
}));

// 只观察真实验证线程online，不增加产品测试门或替换SDK；暂停在响应持久后、解码开始前发生。
for(const phase of ['online','after-validation'])for(const action of ['pause','close'])test('普通图片/响应已确认、核验阶段'+phase+'时'+action+'：实际exit后才收束、费用保留一次',{timeout:30000},async t=>withImage(t,{},async f=>{
 const emit=Worker.prototype.emit;let decoderThreadId,stop,exited=false,intercepted=0;
 Worker.prototype.emit=function(event,...args){
  if(event===(phase==='online'?'online':'exit')&&f.remote.images()[0]?.responseWritten&&intercepted===0){
   intercepted++;decoderThreadId=()=>this.threadId;Worker.prototype.emit=emit;
   const trigger=()=>{stop=action==='pause'?f.session.pause():f.session.close();stop.catch(()=>{});};
   if(phase==='online'){this.once('exit',()=>{exited=true;});trigger();return emit.call(this,event,...args);}
   // 真实exit监听先兑现验证Promise；两次microtask把暂停落在caller继续到发布事务的窗口。
   exited=true;const result=emit.call(this,event,...args);queueMicrotask(()=>queueMicrotask(trigger));return result;
  }
  return emit.call(this,event,...args);
 };
 try{
  const accepted=await f.session.submit(f.input);await until(()=>!!stop);await stop;assert.equal(intercepted,1);assert.equal(exited,true);assert.equal(decoderThreadId(),-1,'No validation resource may outlive pause/close');assertWire(f);
  assert.equal(f.remote.images()[0].finished,true,'This is a real completed HTTP, not the held-HTTP cancellation fixture');
  if(action==='pause')await f.session.close();const raw=await records(f);assert.equal(raw.accounted.response.metadata.stopReason,'stop','Original SDK receipt is immutable despite local cancellation');assert.equal(raw.accounted.done,true);assert.notEqual(raw.accounted.publishedToOwner,true);assert.equal(sum(raw.usage.tools),130);assert.ok(!('output' in raw.accounted.response.metadata));
  const facts=raw.entries.filter(e=>e.kind==='dcode.extension-typed-model-result'&&e.data.operation==='generateImages');assert.equal(facts.length,1);assert.deepEqual(facts[0].data.typed.output,[]);assert.equal(facts[0].data.typed.stopReason,'aborted');
  assert.equal(raw.messages.filter(m=>m.role==='toolResult'&&m.content?.some(p=>p.type==='image')).length,0);
  f.session=await f.backend.open({...f.opening,initialize:false});const ro=await f.session.read();assert.equal(ro.phase,'paused');assert.equal(ro.entries.filter(e=>e.typedRequest?.operation==='generateImages').length,1);assert.equal((await f.session.lookupReceipt(f.input)).submissionId,accepted.submissionId);assert.equal(f.remote.images().length,1);assert.equal(f.remote.chats().length,1);
  await f.session.resume(ro.control);await done(f);assert.equal(f.remote.images().length,1);assert.equal((await f.effects()).filter(e=>e.phase==='tool-start').length,1);await f.session.close();const restored=await records(f);assert.equal(restored.child.id,raw.child.id);assert.deepEqual(restored.usage.tools,raw.usage.tools);assert.equal(restored.entries.filter(e=>e.kind==='dcode.extension-typed-model-result'&&e.data.operation==='generateImages').length,1);
 }finally{if(Worker.prototype.emit!==emit)Worker.prototype.emit=emit;}
}));

test('普通图片/九组本地值与未接选项边界：有限错误、零图片HTTP／费用／typed请求',{timeout:30000},async t=>withImage(t,{mode:'boundary-rejects'},async f=>{
 await f.session.submit(f.input);await done(f);const trace=await f.trace();assert.equal(trace.steps.some(s=>s.phase==='promise-rejected'),false);
 const results=trace.steps.find(s=>s.phase==='boundary-results');assert.equal(results.reads,0);assert.equal(results.results.length,9);for(const {name,value} of results.results){assert.equal(value.stopReason,'error',name);assert.deepEqual(value.output,[],name);assert.equal(value.usage,undefined,name);}
 assert.equal(f.remote.images().length,0);assert.equal(f.remote.chats().length,2);assert.deepEqual(f.remote.invalid,[]);assert.equal((await f.session.read()).entries.some(e=>e.typedRequest),false);
}));
test('普通图片/已确认响应后仅模型取消：原工具仍活、安全aborted保费用，关闭不重复记账',{timeout:30000},async t=>withImage(t,{mode:'model-cancel'},async f=>{
 const emit=Worker.prototype.emit;let online=false,cancel;
 Worker.prototype.emit=function(event,...args){if(event==='online'&&f.remote.images()[0]?.responseWritten&&!online){online=true;Worker.prototype.emit=emit;cancel=f.marker(cancelName);cancel.catch(()=>{});}return emit.call(this,event,...args);};
 try{
  await f.session.submit(f.input);await until(()=>online);await cancel;await until(async()=>(await f.trace()).steps.some(s=>s.phase==='owner-still-active'));
  const trace=await f.trace(),result=trace.steps.find(s=>s.phase==='result-settled');assert.equal(result.ownerAborted,false);assert.equal(result.modelAborted,true);assert.equal(result.result.stopReason,'aborted');assert.equal(result.result.usage.totalTokens,130);assert.deepEqual(result.result.output,[]);assert.equal((await f.session.read()).phase,'running');
  await f.marker(releaseName);await done(f);assertWire(f);await f.session.close();const raw=await records(f);assert.equal(raw.owner.state.outcome.status,'completed');assert.equal(sum(raw.usage.tools),130);assert.equal(raw.accounted.response.metadata.stopReason,'stop');assert.equal(raw.accounted.publishedToOwner,true);assert.equal(raw.accounted.done,true);assert.equal(raw.entries.filter(e=>e.kind==='dcode.extension-typed-model-result'&&e.data.operation==='generateImages').length,1);
 }finally{Worker.prototype.emit=emit;}
}));

test('普通图片/近8MiB原图加1MiB转义文本：16MiB封套完整到原工具、后续HTTP和只读历史',{timeout:30000},async t=>withImage(t,{mode:'capacity'},async f=>{
 assert.ok(f.assets.outputImage.data.length>8*1024*1024-4096);assert.ok(f.assets.outputImage.data.length<=8*1024*1024);assert.equal(Buffer.byteLength(f.assets.outputText),1024*1024);
 await f.session.submit(f.input);await done(f);assertWire(f);const trace=await f.trace(),typed=trace.steps.find(s=>s.phase==='result-settled').result;
 assert.equal(typed.stopReason,'stop');assert.deepEqual(typed.output.filter(p=>p.type==='image'),[f.assets.outputImage]);assert.equal(typed.output.find(p=>p.type==='text').text,f.assets.outputText);assert.ok(Buffer.byteLength(JSON.stringify(typed))>8*1024*1024,'Counterexample must cross the old serialized envelope');
 const view=await f.session.read(),tool=view.entries.find(e=>e.toolResult?.callId===ids.call);assert.ok(tool);assert.equal(tool.toolResult.isError,false);assert.ok(tool.toolResult.text.startsWith(f.assets.outputText.slice(0,128)));assert.match(tool.toolResult.text,/Output truncated to its beginning/,'Original Durable truncation stays explicit rather than altering its budget');assert.deepEqual(tool.toolResult.images,[f.assets.outputImage]);assert.equal(f.remote.chats().length,2);assert.equal(f.remote.chats()[1].forwardedOutputImage,true);assert.equal(f.remote.chats()[1].forwardedOutputText,true);
 await f.session.close();const raw=await records(f);assert.equal(sum(raw.usage.tools),130);assert.equal(raw.accounted.done,true);f.session=await f.backend.open({...f.opening,initialize:false});assert.deepEqual((await f.session.read()).entries,view.entries);assert.equal(f.remote.images().length,1);await f.session.close();assert.deepEqual((await records(f)).usage,raw.usage);
}));
