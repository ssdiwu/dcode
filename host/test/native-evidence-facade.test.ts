import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import {syncBuiltinESMExports} from 'node:module';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {PiHost} from '../src/pi-host.js';
import type {FoundationSnapshot,TaskBundle} from '../src/product-store.js';

// Reproduced red on bf7e661; controlled tool mechanism, not autonomous-model evidence.
test('native dcode_facts evidence reflects a real read already present in the same Task Product Store',async()=>{
 const root=await mkdtemp('/tmp/dcode-native-evidence-'),home=join(root,'home'),agent=join(root,'agent');
 await Promise.all([mkdir(home),mkdir(agent)]);await writeFile(join(home,'sample.md'),'SOURCE: local-fixture');
 await writeFile(join(agent,'settings.json'),JSON.stringify({defaultProvider:'zai-coding-cn',defaultModel:'fixture',retry:{enabled:false}}));
 await writeFile(join(agent,'models.json'),JSON.stringify({providers:{'zai-coding-cn':{baseUrl:'https://open.bigmodel.cn/api/paas/v4',api:'openai-completions',apiKey:'fixture-only',models:[{id:'fixture',name:'Fixture',reasoning:false,input:['text'],contextWindow:100000,maxTokens:4096}]}}}));
 const originalFetch=globalThis.fetch,originalHomedir=os.homedir;
 // System boundary: isolate even legacy readers that bypass PiHost.userHome.
 os.homedir=()=>home;syncBuiltinESMExports();
 let step=0;const toolResults=new Map<string,string>();
 function response(name?:string,args?:unknown){const tool=name?{index:0,id:crypto.randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}}:undefined;return new Response(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:tool?{role:'assistant',tool_calls:[tool]}:{role:'assistant',content:'Probe complete'},finish_reason:null}]})}\n\ndata: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});}
 globalThis.fetch=(async(url,init)=>{
  if(String(url).includes('quota/limit'))return Response.json({success:true,code:200,data:{limits:[{type:'TOKENS_LIMIT',percentage:10,nextResetTime:Date.now()+3600000}]}});
  const body=JSON.parse(String(init?.body));for(const m of body.messages??[])if(m.role==='tool')toolResults.set(m.tool_call_id,m.content);
  const actions:[string,unknown][]=[['write',{path:'output.md',content:'native fixture output'}],['dcode_facts',{kind:'changes'}],['read',{path:'sample.md'}],['dcode_verification',{action:'context'}],['dcode_facts',{kind:'evidence'}]];
  const action=actions[step++];return action?response(...action):response();
 }) as typeof fetch;
 const host=new PiHost({agentDir:agent,sessionsDirectory:join(agent,'sessions'),dataRoot:join(home,'.dcode'),userHome:home,emit:()=>{}});
 try{
  await host.start();let snap=await host.handle('foundation.snapshot',{}) as FoundationSnapshot;
  const task=await host.handle('task.create',{requestId:'probe',expectedStoreRevision:snap.storeRevision,scope:{kind:'user',userId:snap.currentUser.id},title:'Native evidence facade probe',goal:'Read fixture then inspect evidence through actual tools'}) as TaskBundle;
  await host.handle('dcodeSession.prompt',{dcodeSessionId:task.coordinationSession.id,promptId:'probe',message:'Read sample.md and inspect its native evidence.'});
  const until=Date.now()+20000;do{await new Promise(r=>setTimeout(r,30));snap=await host.handle('foundation.snapshot',{}) as FoundationSnapshot;}while(!snap.sessionRuns.some(r=>r.status==='completed')&&Date.now()<until);
  assert.ok(snap.sessionRuns.some(r=>r.status==='completed'),'actual Pi tool run completed');
  const readEvidence=snap.evidence.find(e=>e.commandRedacted==='read');assert.ok(readEvidence,'Product Store owns the real read evidence');
  const results=[...toolResults.values()];assert.ok(results.some(t=>t.includes(readEvidence.id)),'verification context exposes that same native evidence');
  const facade=results.at(-1)??'';
  assert.ok(!/账本不可用|没有记录|没有可读取的命令执行证据/u.test(facade),`dcode_facts must not report missing legacy evidence when Product Store has ${readEvidence.id}; actual: ${facade}`);
  assert.match(facade,/read|sample\.md/u,'facade must describe the actual native read, not merely omit the missing-ledger warning');
  const writes=snap.evidence.find(e=>e.commandRedacted==='write');assert.ok(writes);const changes=results.find(t=>t.includes('currentFileStatisticsAvailable'));assert.ok(changes?.includes(writes.id));assert.match(facade,/isCurrentRun": true/);
 }finally{await host.close();globalThis.fetch=originalFetch;os.homedir=originalHomedir;syncBuiltinESMExports();await rm(root,{recursive:true,force:true});}
});
