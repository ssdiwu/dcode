// 真实公开MemoryStorage投影的纯计算；不执行任务、HTTP、认证或压缩循环。
import test from 'node:test';
import assert from 'node:assert/strict';
import { explainContextUsage, contextModelKey } from '../../src/adapters/pi/context-usage.ts';
import { Harness,MemoryStorage,createRegistry,UserEntry,AssistantEntry,ToolResultEntry,CompactionEntry,ResetEntry,UsageDoc } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { estimateMessageTokens } from '@earendil-works/pi-ai/utils/estimate';
const base=createModels();base.setProvider(openrouterProvider());
const model=base.getModel('openrouter','openai/gpt-4o');
const alternative=base.getModels('openrouter').find(value=>value.id!==model?.id&&value.contextWindow>0);
assert.ok(model&&alternative);
let forbiddenModelCalls=0;
const forbidden=new Set(['stream','streamSimple','complete','completeSimple','streamDeferred','fetchDeferred','cancelDeferred','generateImages','classify','getAuth','checkAuth','login','logout']);
const models=new Proxy(base,{get(target,key){if(forbidden.has(key))return()=>{forbiddenModelCalls++;throw new Error('No model/auth operation allowed in pure fixture');};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
const usage=n=>({input:n,output:0,cacheRead:0,cacheWrite:0,totalTokens:n,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}});
const user=(text,timestamp)=>({role:'user',content:text,timestamp});
const assistant=(text,n,timestamp,stopReason='stop',selected=model)=>({role:'assistant',api:selected.api,provider:selected.provider,model:selected.id,
  content:[{type:'text',text}],usage:usage(n),stopReason,timestamp});
const cases=[];
async function unit(name,body,initialModel=model){
 await test('上下文用量/'+name,async()=>{
 const storage=new MemoryStorage();const h=await Harness.open(storage,{models,registry:createRegistry(),settings:{compaction:{enabled:false},retry:{maxRetries:0}}},ctx);
 let snapshotId=0;
 const root=await h.root(ctx,{agent:initialModel?{model:{provider:initialModel.provider,modelId:initialModel.id}}:{}});
 const append=entry=>root.commit(tx=>tx.appendEntry(root.id,entry),ctx);
 const boundedEntries=async(tail,handle=root)=>{const all=[];let cursor;do{const page=await handle.entries(tail?{maxEntryId:tail}:{},200,cursor,ctx);all.push(...page.items);cursor=page.next;}while(cursor!==undefined);return all.sort((a,b)=>a.id-b.id);};
 const capture=async(handle=root)=>{
  const beforeAgent=await handle.agent(ctx);
  const beforeModel=beforeAgent.model?base.getModel(beforeAgent.model.provider,beforeAgent.model.modelId):undefined;
  const context=await handle.context(ctx);const tail=context.entries.reduce((n,e)=>Math.max(n,e.id),0);
  const entries=await boundedEntries(tail,handle);
  const afterAgent=await handle.agent(ctx),afterModel=afterAgent.model?base.getModel(afterAgent.model.provider,afterAgent.model.modelId):undefined;
  return {context,entries,model:afterModel,frame:{sessionId:'external-memory-'+name,resourceEpoch:'external-r2',threadId:1,requestId:name+'/'+(++snapshotId),
   beforeModelKey:contextModelKey(beforeModel),afterModelKey:contextModelKey(afterModel),entriesComplete:true}};
 };
 const check=snapshot=>{const before=JSON.stringify(snapshot),observed=explainContextUsage(snapshot);assert.equal(JSON.stringify(snapshot),before,'Pure function leaves original context and model untouched');return observed;};
 try{const result=await body({h,root,append,capture,check,boundedEntries});
  const inspect=await h.inspect(ctx);assert.equal(inspect.tasks.length,0);assert.equal(inspect.submissions.length,0);assert.equal(inspect.scheduling,'paused');
  cases.push({name,qualified:true,...result,taskCount:inspect.tasks.length,submissionCount:inspect.submissions.length,scheduling:inspect.scheduling});
 }finally{await h.close(ctx);}
 });
}
async function history(append,{long=false}={}){
 await append({kind:UserEntry.kind,model:[user(long?'OLD_PREFIX_'+('z'.repeat(80000)):'OLD_PREFIX',100)]});
 await append({kind:AssistantEntry.kind,model:[assistant('OLD_ANSWER',1300,200)]});
 const kept=await append({kind:UserEntry.kind,model:[user('KEPT_TURN',300)]});
 await append({kind:AssistantEntry.kind,model:[assistant('RETAINED_PRE_HEAD_ANSWER',700,400)]});
 return kept;
}
await unit('running-tool-placeholder-is-not-a-formal-contribution',async({append,capture,check})=>{
 await append({kind:UserEntry.kind,model:[user('Q',1)]});
 const call=assistant('CALL',2,2,'toolUse');call.content=[{type:'toolCall',id:'pending-usage',name:'usage',arguments:{}}];
 await append({kind:AssistantEntry.kind,model:[call]});
 const pending=await capture();
 const placeholder=pending.context.messages.find(message=>message.role==='toolResult');
 assert.ok(placeholder,'原Durable会为在途call合成协议占位');
 assert.ok(!pending.context.contributions.flat().includes(placeholder),'占位尚未成为正式模型贡献');
 assert.equal(check(pending).usage.tokens,2,'未完成工具的协议占位不能虚增SDK统计');
 // 相同正文真实保存后仍计入；不能靠文本内容删除合法ToolResult。
 await append({kind:ToolResultEntry.kind,model:[{...placeholder}],data:{diagnostics:[]}});
 const stored=check(await capture());assert.equal(stored.usage.tokens,2+estimateMessageTokens(placeholder));
 return {observed:stored};
});
await unit('empty-active-context',async({capture,check})=>{const got=check(await capture());assert.deepEqual(got.usage,{tokens:0,contextWindow:model.contextWindow,percent:0});return {observed:got};});
await unit('ordinary-chat-usage-plus-tail',async({append,capture,check})=>{
 await append({kind:UserEntry.kind,model:[user('Q',1)]});await append({kind:AssistantEntry.kind,model:[assistant('A',1300,2)]});
 const tail=user('ACTUAL_TRAILING_USER',3);await append({kind:UserEntry.kind,model:[tail]});
 const got=check(await capture());assert.equal(got.usage.tokens,1300+estimateMessageTokens(tail));assert.equal(got.basis,'chat-usage-plus-tail');return {observed:got};
});
await unit('typed-fees-and-usage-doc-do-not-enter-context',async({append,capture,check,root})=>{
 await append({kind:UserEntry.kind,model:[user('Q',1)]});await append({kind:AssistantEntry.kind,model:[assistant('A',90,2)]});
 const before=check(await capture());
 for(const operation of ['classify','generateImages'])await append({kind:'dcode.extension-typed-model-result',data:{operation,typed:{usage:usage(90000000),answers:{},output:[]}}});
 await root.commit(async tx=>{(await tx.doc(UsageDoc,root.id)).tools={classifier:usage(90000000),images:usage(80000000)};},ctx);
 const after=check(await capture());assert.deepEqual(after.usage,before.usage);return {before,after};
});
await unit('actual-tool-image-context-not-image-fee',async({append,capture,check})=>{
 await append({kind:UserEntry.kind,model:[user('Q',1)]});
 const a=assistant('CALL',1300,2,'toolUse');a.content=[{type:'toolCall',id:'tool-image',name:'image_result',arguments:{}}];
 await append({kind:AssistantEntry.kind,model:[a]});
 const tool={role:'toolResult',toolCallId:'tool-image',toolName:'image_result',content:[{type:'text',text:'VISIBLE_TOOL_IMAGE'},
  {type:'image',data:'iVBORw0KGgo=',mimeType:'image/png'}],usage:usage(90000000),isError:false,timestamp:3};
 await append({kind:ToolResultEntry.kind,model:[tool],data:{diagnostics:[]}});
 const got=check(await capture());assert.equal(got.usage.tokens,1300+estimateMessageTokens(tool));assert.ok(got.usage.tokens<10000);return {observed:got,imagePartIsEstimationFixtureOnly:true};
});
await unit('compaction-head-retained-old-chat-usage-is-unknown',async({append,capture,check})=>{
 const kept=await history(append,{long:true});
 await append({kind:CompactionEntry.kind,head:kept.id,model:[user('ACTUAL_SUMMARY',500)],data:{reason:'manual'}});
 const snapshot=await capture(),got=check(snapshot);assert.equal(got.usage.tokens,null);assert.equal(got.usage.percent,null);
 assert.ok(snapshot.entries.length>snapshot.context.entries.length);assert.ok(!snapshot.context.messages.some(m=>JSON.stringify(m).includes('OLD_PREFIX')));
 return {observed:got,rawEntryCount:snapshot.entries.length,activeEntryCount:snapshot.context.entries.length};
});
await unit('compaction-head-new-chat-usage-applies',async({append,capture,check})=>{
 const kept=await history(append);await append({kind:CompactionEntry.kind,head:kept.id,model:[user('ACTUAL_SUMMARY',500)],data:{reason:'manual'}});
 await append({kind:AssistantEntry.kind,model:[assistant('REAL_POST_HEAD',900,600)]});
 const got=check(await capture());assert.equal(got.usage.tokens,900);assert.equal(got.basis,'chat-usage-plus-tail');return {observed:got};
});
await unit('error-aborted-deferred-do-not-supply-post-head-usage',async({append,capture,check})=>{
 const kept=await history(append);await append({kind:CompactionEntry.kind,head:kept.id,model:[user('ACTUAL_SUMMARY',500)],data:{reason:'manual'}});
 for(const reason of ['error','aborted','deferred'])await append({kind:AssistantEntry.kind,model:[assistant('NOT_ACCEPTED_'+reason,90000000,600,reason)]});
 const snapshot=await capture(),got=check(snapshot);assert.equal(got.usage.tokens,null);assert.ok(!snapshot.context.messages.some(m=>JSON.stringify(m).includes('NOT_ACCEPTED')));return {observed:got};
});
await unit('reset-head-estimates-real-handoff',async({append,capture,check})=>{
 await history(append,{long:true});const handoff=user('ACTUAL_RESET_HANDOFF',900);
 await append({kind:ResetEntry.kind,head:'self',model:[handoff]});
 const got=check(await capture());assert.equal(got.usage.tokens,estimateMessageTokens(handoff));assert.equal(got.basis,'active-estimate');return {observed:got};
});
await unit('post-response-prefix-edit-invalidates-old-measurement',async({append,capture,check})=>{
 const first=await append({kind:UserEntry.kind,model:[user('OLD_PREFIX',1)]});await append({kind:AssistantEntry.kind,model:[assistant('A',1300,2)]});
 await append({kind:'external.context-edit',edits:[{target:first.id,action:'replace',messages:[user('NEW_SMALL_PREFIX',1)]}]});
 const got=check(await capture());assert.equal(got.basis,'active-estimate');assert.ok(got.usage.tokens<1300);return {observed:got};
});
await unit('edit-before-response-allows-new-chat-measurement',async({append,capture,check})=>{
 const first=await append({kind:UserEntry.kind,model:[user('OLD_PREFIX',1)]});
 await append({kind:'external.context-edit',edits:[{target:first.id,action:'replace',messages:[user('NEW_PREFIX',2)]}]});
 await append({kind:AssistantEntry.kind,model:[assistant('A',333,3)]});
 const got=check(await capture());assert.equal(got.usage.tokens,333);assert.equal(got.basis,'chat-usage-plus-tail');return {observed:got};
});
await unit('same-tail-model-change-rejects-mixed-frame',async({append,capture,check,root})=>{
 await append({kind:UserEntry.kind,model:[user('SAME_TAIL',1)]});await append({kind:AssistantEntry.kind,model:[assistant('A',100,2)]});
 const before=await capture(),oldResult=check(before);
 await root.configure({model:{provider:alternative.provider,modelId:alternative.id}},ctx);
 const next=await capture(),newResult=check(next);assert.equal(oldResult.tailId,newResult.tailId);assert.notEqual(oldResult.frameKey,newResult.frameKey);
 const mixed={...before,model:next.model,frame:{...before.frame,afterModelKey:next.frame.afterModelKey}};
 const rejected=check(mixed);assert.equal(rejected.usage,undefined);assert.equal(rejected.reason,'incoherent-frame');
 assert.equal(check(before).frameKey,oldResult.frameKey,'Pure helper can still recompute the old captured frame; Worker latest-frame policy is outside this helper');return {oldResult,newResult,rejected,sameTail:true};
});
await unit('mismatched-raw-range-rejected',async({append,capture,check,boundedEntries})=>{
 await append({kind:UserEntry.kind,model:[user('FRAME_OLD',1)]});const snapshot=await capture();
 await append({kind:UserEntry.kind,model:[user('FRAME_NEW',2)]});
 const rejected=check({...snapshot,entries:await boundedEntries(0)});assert.equal(rejected.usage,undefined);return {observed:rejected};
});
await unit('actual-fork-keeps-parent-source-conversation',async({append,capture,check,root})=>{
 await append({kind:UserEntry.kind,model:[user('PARENT_PREFIX',1)]});
 const answer=await append({kind:AssistantEntry.kind,model:[assistant('PARENT_ANSWER',222,2)]});
 const fork=await root.fork(answer.id,{ownership:{kind:'independent'}},ctx);
 const tail=user('FORK_TAIL',3);await fork.commit(tx=>tx.appendEntry(fork.id,{kind:UserEntry.kind,model:[tail]}),ctx);
 const snapshot=await capture(fork),got=check(snapshot);
 assert.ok(snapshot.entries.some(entry=>entry.conversationId===root.id));assert.ok(snapshot.entries.some(entry=>entry.conversationId===fork.id));
 assert.equal(got.usage.tokens,222+estimateMessageTokens(tail));return {observed:got,sourceConversations:[...new Set(snapshot.entries.map(entry=>entry.conversationId))],readConversation:fork.id};
});
await unit('absent-real-model-has-no-invented-window',async({capture,check})=>{
 const snapshot=await capture();assert.equal(snapshot.model,undefined);const got=check(snapshot);assert.equal(got.usage,undefined);assert.equal(got.reason,'physical-chat-model-missing');return {observed:got};
},null);
await unit('older-head-edit-provenance-is-needed-after-new-compaction',async({append,capture,check})=>{
 const target=await append({kind:UserEntry.kind,model:[user('PRE_EDIT_USER',1)]});
 await append({kind:AssistantEntry.kind,model:[assistant('OLD_ANSWER',1300,2)]});
 const older=await append({kind:'external.older-head',head:target.id,model:[user('OLDER_HEAD',3)],
  edits:[{target:target.id,action:'replace',messages:[user('EDIT_FROM_OLDER_HEAD',1)]}]});
 await append({kind:CompactionEntry.kind,head:target.id,model:[user('NEW_SUMMARY',4)],data:{reason:'manual'}});
 await append({kind:AssistantEntry.kind,model:[assistant('NEW_POST_HEAD',444,5)]});
 const snapshot=await capture();assert.ok(!snapshot.context.entries.some(entry=>entry.id===older.id));
 const complete=check(snapshot);assert.equal(complete.usage.tokens,444);
 const incomplete=check({...snapshot,entries:snapshot.entries.filter(entry=>entry.id!==older.id)});assert.equal(incomplete.usage.tokens,null);
 return {complete,incomplete,olderHeadId:older.id};
});
await unit('invalid-tiny-context-window-rejected-before-json',async({append,capture,check})=>{
 await append({kind:UserEntry.kind,model:[user('FINITE_CONTENT',1)]});
 const snapshot=await capture(),invalidModel={...snapshot.model,contextWindow:Number.MIN_VALUE};
 const key=contextModelKey(invalidModel),got=check({...snapshot,model:invalidModel,frame:{...snapshot.frame,beforeModelKey:key,afterModelKey:key}});
 assert.equal(got.usage,undefined);assert.equal(got.reason,'context-window-unknown');
 return {observed:got,invalidFixtureOnly:true,window:Number.MIN_VALUE};
});
await unit('finite-usage-but-percent-overflow-rejected-before-json',async({append,capture,check})=>{
 await append({kind:UserEntry.kind,model:[user('FINITE_CONTENT',1)]});
 await append({kind:AssistantEntry.kind,model:[assistant('DECLARED_EXTREME_FIXTURE_USAGE',Number.MAX_VALUE,2)]});
 const snapshot=await capture(),invalidModel={...snapshot.model,contextWindow:1};
 const key=contextModelKey(invalidModel),got=check({...snapshot,model:invalidModel,frame:{...snapshot.frame,beforeModelKey:key,afterModelKey:key}});
 assert.equal(got.usage,undefined);assert.equal(got.reason,'invalid-estimate-percent');
 return {observed:got,invalidFixtureOnly:true,declaredUsage:Number.MAX_VALUE,window:1};
});
assert.equal(forbiddenModelCalls,0);
