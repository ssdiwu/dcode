import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {PiHost} from '../src/pi-host.js';
import {SessionReader} from '../src/session-reader.js';
import {SessionCopier} from '../src/session-copy.js';
import {sanitizeRuntimeValue,guardPrivateSessionPersistence} from '../src/runtime-privacy.js';
import {redactCredentialText} from '../src/credential-material.js';
import type {FoundationSnapshot,TaskBundle} from '../src/product-store.js';
const fake='FictionalCredentialForPrivacyOnly987654321';
const other='AnotherFictionalPasswordForTests7654321';
async function assertNoFixture(path:string){for(const entry of await readdir(path,{withFileTypes:true})){const file=join(path,entry.name);if(entry.isDirectory())await assertNoFixture(file);else if(entry.isFile()){const bytes=await readFile(file);assert.ok(!bytes.includes(fake),`credential found in ${file}`);assert.ok(!bytes.includes(other),`password found in ${file}`);}}}
const usage={input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const assistant=(text:string)=>({role:'assistant' as const,content:[{type:'text' as const,text}],api:'openai-completions',provider:'fixture',model:'fixture',usage,stopReason:'stop' as const,timestamp:Date.now()});
const response=(text:string,tool?:unknown)=>new Response(`data: ${JSON.stringify({id:'privacy',object:'chat.completion.chunk',model:'fixture',created:1,choices:[{index:0,delta:tool?{role:'assistant',tool_calls:[tool]}:{role:'assistant',content:text},finish_reason:null}]})}\n\ndata: ${JSON.stringify({id:'privacy',object:'chat.completion.chunk',model:'fixture',created:1,choices:[{index:0,delta:{},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});

test('quoted credentials and runtime metadata are hidden while image bytes and structural paths stay intact',()=>{
  assert.ok(redactCredentialText(`{"api_key":"${fake}"}`).redacted);assert.ok(redactCredentialText(`{"type":"api_key","key":"${fake}"}`).redacted);
  const path='/Users/Fixture/Workspace/Project20260907VeryLongDirectoryName/readme.md';assert.equal(redactCredentialText(path).text,path);
  const image={type:'image',mimeType:'image/png',data:'Base64ImageDataPreserved1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ'};
  assert.deepEqual(sanitizeRuntimeValue(image),image);assert.deepEqual(sanitizeRuntimeValue({cwd:path,details:{access_token:fake}}),{cwd:path,details:{access_token:'[REDACTED]'}});
});

test('native model/tool messages and custom metadata are sanitized before any private JSONL or Product Store persistence',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dcode-private-boundary-')),home=join(root,'home'),agent=join(root,'agent'),dataRoot=join(root,'.dcode');await mkdir(home);await mkdir(agent);await writeFile(join(home,'source.txt'),`API_KEY=${fake}`);
  await writeFile(join(agent,'settings.json'),JSON.stringify({defaultProvider:'privacy-fixture',defaultModel:'fixture'}));await writeFile(join(agent,'models.json'),JSON.stringify({providers:{'privacy-fixture':{baseUrl:'https://privacy.invalid/v1',api:'openai-completions',apiKey:'fixture-only',models:[{id:'fixture',name:'Fixture',reasoning:false,input:['text'],contextWindow:100000,maxTokens:4096}]}}}));
  const old=globalThis.fetch;let calls=0;const events:string[]=[];globalThis.fetch=(async(_url,init)=>{calls++;if(calls===1)return response('',{index:0,id:'read-fixture',type:'function',function:{name:'read',arguments:JSON.stringify({path:'source.txt'})}});assert.ok(!String(init?.body).includes(fake),'tools cannot send credentials back to the model');return response(`{"password":"${other}"}`);}) as typeof fetch;
  const host=new PiHost({agentDir:agent,sessionsDirectory:join(agent,'sessions'),dataRoot,userHome:home,emit:(event,data)=>events.push(JSON.stringify({event,data}))});
  try{
    await host.start();let snap=await host.handle('foundation.snapshot',{}) as FoundationSnapshot;const task=await host.handle('task.create',{requestId:'task',expectedStoreRevision:snap.storeRevision,scope:{kind:'user',userId:snap.currentUser.id},title:'凭据边界验证',goal:'只使用虚构测试内容'}) as TaskBundle;
    await host.handle('dcodeSession.prompt',{dcodeSessionId:task.coordinationSession.id,promptId:'run',message:'读取 source.txt 并概括'});
    const deadline=Date.now()+8000;do{snap=await host.handle('foundation.snapshot',{}) as FoundationSnapshot;if(snap.sessionRuns.at(-1)?.status==='completed')break;if(Date.now()>deadline)throw new Error('privacy fixture did not finish');await new Promise(resolve=>setTimeout(resolve,20));}while(true);
    await host.close();
    const manager=SessionManager.create(home,join(dataRoot,'runtime','guard-fixture'));guardPrivateSessionPersistence(manager);manager.appendMessage({role:'user',content:'metadata fixture',timestamp:Date.now()});manager.appendMessage(assistant(`API_KEY=${fake}`));manager.appendCustomEntry('metadata-fixture',{access_token:other});
    await assertNoFixture(dataRoot);assert.ok(!events.join('').includes(fake));assert.ok(!events.join('').includes(other));assert.equal(await readFile(join(home,'source.txt'),'utf8'),`API_KEY=${fake}`);
  }finally{await host.close();globalThis.fetch=old;await rm(root,{recursive:true,force:true});}
});

test('native migration makes a sanitized private copy and leaves the original runtime source byte-for-byte unchanged',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dcode-private-copy-')),home=join(root,'home'),sourceRoot=join(root,'legacy'),targetRoot=join(root,'.dcode','runtime','pi-sessions');await mkdir(home);const manager=SessionManager.create(home,sourceRoot);manager.appendMessage({role:'user',content:'original source',timestamp:Date.now()});manager.appendMessage(assistant(`API_KEY=${fake}`));manager.appendCustomEntry('source-extra',{refresh_token:other});const file=manager.getSessionFile()!;const before=await readFile(file);
  try{const summary=await new SessionReader(sourceRoot).resolve(manager.getSessionId());const copied=await new SessionCopier(targetRoot).copy({source:summary,targetCwd:home,sanitizeCredentials:true,assertSourceStable:async()=>assert.deepEqual(await readFile(file),before)});assert.equal(copied.verification.credentialsRedacted,true);await assertNoFixture(join(root,'.dcode'));assert.deepEqual(await readFile(file),before);}finally{await rm(root,{recursive:true,force:true});}
});
