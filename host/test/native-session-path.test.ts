import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {PiHost} from '../src/pi-host.js';
import type {FoundationSnapshot,TaskBundle,NativeSessionPathAction,SessionEntryRecord} from '../src/product-store.js';
import type {SessionInspection} from '../src/session-reader.js';
const until=async(check:()=>Promise<boolean>)=>{const end=Date.now()+10000;while(!await check()){if(Date.now()>end)throw new Error('session did not settle');await new Promise(resolve=>setTimeout(resolve,20));}};
const completion=(content:string,tool?:unknown)=>{const base={id:'path-fixture',object:'chat.completion.chunk',created:1,model:'fixture'};return new Response(`data: ${JSON.stringify({...base,choices:[{index:0,delta:tool?{role:'assistant',tool_calls:[tool]}:{role:'assistant',content},finish_reason:null}]})}\n\ndata: ${JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});};

test('native path edits retain original submissions and branches, return to old history, and reject stale path changes',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dcode-native-path-')),agent=join(root,'agent'),home=join(root,'home');await mkdir(agent);await mkdir(home);
  await writeFile(join(agent,'settings.json'),JSON.stringify({defaultProvider:'path-fixture',defaultModel:'fixture'}));
  await writeFile(join(agent,'models.json'),JSON.stringify({providers:{'path-fixture':{baseUrl:'https://path.invalid/v1',api:'openai-completions',apiKey:'fixture-only',models:[{id:'fixture',name:'Fixture',reasoning:false,input:['text'],contextWindow:100000,maxTokens:4096}]}}}));
  const previousFetch=globalThis.fetch;const bodies:Array<{messages:Array<{role:string;content:unknown}>}>=[];
  globalThis.fetch=(async(_url,init)=>{const body=JSON.parse(String(init?.body));bodies.push(body);if(bodies.length===1)return completion('',{index:0,id:'write-once',type:'function',function:{name:'write',arguments:JSON.stringify({path:'result.md',content:'第一次产生的文件仍保留'})}});return completion(`回答 ${bodies.length}`);}) as typeof fetch;
  const options={agentDir:agent,sessionsDirectory:join(agent,'sessions'),dataRoot:join(root,'.dcode'),userHome:home,emit:()=>{}};let host=new PiHost(options);
  const snapshot=()=>host.handle('foundation.snapshot',{}) as Promise<FoundationSnapshot>;
  try{
    await host.start();const initial=await snapshot();const task=await host.handle('task.create',{requestId:'task',expectedStoreRevision:initial.storeRevision,scope:{kind:'user',userId:initial.currentUser.id},title:'历史路径',goal:'原文保留'}) as TaskBundle;
    const sessionId=task.coordinationSession.id;
    const send=async(id:string,message:string,pathAction?:NativeSessionPathAction)=>{await host.handle('dcodeSession.prompt',{dcodeSessionId:sessionId,promptId:id,message,...(pathAction?{pathAction}:{})});await until(async()=>{const s=await snapshot();return s.sessionRuns.length>0&&!s.sessionRuns.some(run=>['prepared','running'].includes(run.status));});};
    await send('one','原始问题');await send('two','第二个问题');
    let presented=await host.handle('dcodeSession.presentation',{dcodeSessionId:sessionId}) as {nativeEntries:SessionEntryRecord[];inspection:SessionInspection};
    const firstUser=presented.nativeEntries.find(entry=>entry.messageRole==='user')!,firstAnswer=presented.nativeEntries.find(entry=>entry.messageRole==='assistant')!;assert.ok(firstUser.sourceEntryId);assert.ok(firstAnswer.sourceEntryId);
    const original=(await snapshot()).sessionPaths.find(path=>path.isCurrent)!;
    const edit:NativeSessionPathAction={kind:'editUser',entryId:firstUser.sourceEntryId!,fromPathId:original.id,expectedCurrentPathId:original.id,expectedCurrentPathRevision:original.revision};
    await host.handle('dcodeSession.composerDraft.set',{requestId:'path-draft',expectedStoreRevision:(await snapshot()).storeRevision,taskId:task.task.id,dcodeSessionId:sessionId,text:'修订的问题',pathAction:edit,pathDraftBackup:{text:'原输入框未发送草稿',attachmentIds:[]}});
    assert.equal((await snapshot()).composerDrafts.find(draft=>draft.sessionId===sessionId)?.pathAction?.entryId,firstUser.sourceEntryId);
    assert.equal((await snapshot()).composerDrafts.find(draft=>draft.sessionId===sessionId)?.pathDraftBackup?.text,'原输入框未发送草稿');
    await send('edit','修订的问题',edit);
    let snap=await snapshot();assert.equal(snap.sessionPaths.length,2);const revised=snap.sessionPaths.find(path=>path.isCurrent)!;assert.notEqual(revised.id,original.id);
    const context=bodies.at(-1)!.messages.filter(message=>message.role==='user');assert.equal(context.length,1);assert.ok(JSON.stringify(context).includes('修订的问题'));assert.ok(!JSON.stringify(context).includes('第二个问题'));
    const old=await host.handle('dcodeSession.presentation',{dcodeSessionId:sessionId,pathId:original.id}) as {nativeEntries:SessionEntryRecord[];inspection:SessionInspection};assert.equal(old.nativeEntries.filter(entry=>entry.messageRole==='user').length,2);assert.equal(old.inspection.entries.filter(entry=>entry.type==='message'&&(entry.message as {role:string}).role==='user').length,2);
    assert.equal(await readFile(join(home,'result.md'),'utf8'),'第一次产生的文件仍保留');
    const beforeCalls=bodies.length;await assert.rejects(send('stale','不应提交',edit),/路径已经改变/);assert.equal(bodies.length,beforeCalls);
    presented=await host.handle('dcodeSession.presentation',{dcodeSessionId:sessionId}) as typeof presented;assert.ok(presented.inspection.entries.some(entry=>entry.type==='message'&&JSON.stringify(entry.message).includes('修订的问题')),'adapter rolls back after stale native path rejected');
    const continuation:NativeSessionPathAction={kind:'continueAssistant',entryId:firstAnswer.sourceEntryId!,fromPathId:original.id,expectedCurrentPathId:revised.id,expectedCurrentPathRevision:revised.revision};
    await send('continue','沿原回答继续',continuation);snap=await snapshot();assert.equal(snap.sessionPaths.length,3);const lastUsers=bodies.at(-1)!.messages.filter(message=>message.role==='user');assert.equal(lastUsers.length,2);assert.ok(JSON.stringify(lastUsers).includes('原始问题'));assert.ok(!JSON.stringify(lastUsers).includes('修订的问题'));assert.ok(!JSON.stringify(lastUsers).includes('第二个问题'));
    assert.equal(snap.evidence.filter(evidence=>evidence.commandRedacted==='write').length,1,'history branching never replays completed tools');
    const db=new DatabaseSync(join(root,'.dcode','product-store.sqlite3'),{readOnly:true});try{assert.deepEqual((db.prepare('SELECT submitted_text,source_kind FROM raw_inputs ORDER BY ordinal').all() as Array<{submitted_text:string;source_kind:string}>).map(row=>[row.submitted_text,row.source_kind]),[['原始问题','user_submit'],['第二个问题','user_submit'],['修订的问题','edit_and_rerun'],['沿原回答继续','continue_path']]);}finally{db.close();}
    await host.close();host=new PiHost(options);await host.start();assert.equal((await snapshot()).sessionPaths.length,3);assert.equal((await snapshot()).sessionPaths.find(path=>path.isCurrent)?.id,snap.sessionPaths.find(path=>path.isCurrent)?.id);
  }finally{await host.close();globalThis.fetch=previousFetch;await rm(root,{recursive:true,force:true});}
});
