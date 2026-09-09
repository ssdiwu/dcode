import http from 'node:http';import{syncBuiltinESMExports}from'node:module';
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';
import{ModelRuntime}from'@earendil-works/pi-coding-agent';import type{AuthPrompt,Credential}from'@earendil-works/pi-ai';
import{ModelConnections}from'../src/model-connections.js';import{DCodeCredentialStore,authCancelled}from'../src/secure-model-credentials.js';
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function fixture(timeoutMs=3000){
 const root=await mkdtemp(join(tmpdir(),'dcode-browser-oauth-'));const previousHost=process.env.PI_OAUTH_CALLBACK_HOST;process.env.PI_OAUTH_CALLBACK_HOST='127.0.0.1';
 let callbackPort=0;const originalCreateServer=http.createServer;
 // Keep the SDK callback handler/state checks; only allocate an isolated test port.
 http.createServer=((...args:any[])=>{const server=Reflect.apply(originalCreateServer,http,args),listen=server.listen;server.listen=function(...values:any[]){if(values[0]===1455)values[0]=0;server.once('listening',()=>{callbackPort=(server.address() as {port:number}).port;});return Reflect.apply(listen,server,values);};return server;}) as typeof http.createServer;syncBuiltinESMExports();
 const events:unknown[]=[],data=new Map<string,Credential>();let failBrowser=false,inputMode='success',failSave=false,url='',browserCalls=0,manualCalls=0,selectId='';
 const token='e30.'+Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'fixture-account'}})).toString('base64url')+'.fixture';
 const originalFetch=globalThis.fetch;globalThis.fetch=(async(input,init)=>{
   if(String(input)==='https://auth.openai.com/oauth/token'){assert.equal(new URLSearchParams(String(init?.body)).get('code'),'fixture-code');return Response.json({access_token:token,refresh_token:'private-fixture-refresh',expires_in:3600});}
   assert.ok(callbackPort>0&&String(input).startsWith('http://127.0.0.1:'+callbackPort+'/auth/callback'),'Only isolated loopback callback may use actual network');return originalFetch(input,init);
 }) as typeof fetch;
 const native={list:async()=>[...data].map(([providerId,c])=>({providerId,type:c.type})),
   transaction:async<T>(id:string,fn:(value:Credential|undefined)=>Promise<{value:T;write?:Credential|null}>)=>{const result=await fn(data.get(id));if(result.write){if(failSave)throw Error('private storage error');data.set(id,result.write);}return result.value;},
   prompt:async(_name:string,p:AuthPrompt,_signal:AbortSignal)=>{if(p.type==='select'){selectId=p.options[0]!.id;return selectId;}manualCalls++;if(inputMode==='failure')throw Error('input unavailable '+url);if(inputMode==='cancel')throw authCancelled();return 'http://localhost:1455/auth/callback?code=fixture-code&state='+new URL(url).searchParams.get('state');},
   browser:async(value:string,_signal:AbortSignal)=>{url=value;browserCalls++;if(failBrowser)throw Error('browser unavailable '+url);},notice:async()=>{}};
 const store=new DCodeCredentialStore(native,join(root,'external.json')),runtime=await ModelRuntime.create({credentials:store,modelsPath:null,refreshOnCreate:false,allowModelNetwork:false});
 const manager=new ModelConnections(store,native,async()=>runtime,async()=>{},(event,data)=>events.push({event,data}),{timeoutMs});
 const view=async()=> (await manager.get()).providers.find(p=>p.providerId==='openai-codex')!;
 const until=async(predicate:(v:Awaited<ReturnType<typeof view>>)=>boolean)=>{for(let i=0;i<200;i++){const v=await view();if(predicate(v))return v;await sleep(5);}throw Error('OAuth state timeout');};
 const close=async()=>{await manager.close();globalThis.fetch=originalFetch;http.createServer=originalCreateServer;syncBuiltinESMExports();if(previousHost===undefined)delete process.env.PI_OAUTH_CALLBACK_HOST;else process.env.PI_OAUTH_CALLBACK_HOST=previousHost;await rm(root,{recursive:true,force:true});};
 return{manager,native,data,events,view,until,close,get callback(){return 'http://127.0.0.1:'+callbackPort+'/auth/callback';},get url(){return url;},get browserCalls(){return browserCalls;},get manualCalls(){return manualCalls;},get selectId(){return selectId;},set failBrowser(v:boolean){failBrowser=v;},set inputMode(v:string){inputMode=v;},set failSave(v:boolean){failSave=v;},token};
}
test('actual SDK browser choice keeps failed automatic opening recoverable without starting a manual window',async()=>{
 const f=await fixture();try{f.failBrowser=true;await f.manager.start('openai-codex','oauth','browser');const v=await f.until(v=>!!v.browserFailed);assert.equal(f.selectId,'browser');assert.equal(v.state,'awaiting_browser');assert.equal(v.canOpenBrowser,true);assert.equal(f.manualCalls,0);const url=f.url;
 f.failBrowser=false;assert.deepEqual(f.manager.openBrowser('browser'),{accepted:true});await f.until(v=>!v.browserOpening);assert.equal(f.browserCalls,2);assert.equal(f.url,url);assert.equal((await f.view()).browserFailed,false);
 assert.equal(f.manager.cancel('browser').cancelled,true);await f.manager.idle();assert.deepEqual(await f.manager.openBrowser('browser'),{accepted:false,reason:'inactive'});assert.equal(f.manager.enterCode('browser').accepted,false);assert.equal(f.data.size,0);assert.ok(!JSON.stringify({events:f.events,view:await f.view()}).includes('https://'));
 }finally{await f.close();}
});
test('optional manual helper failure or cancellation preserves browser flow, retry stores only SDK credentials',async()=>{
 const f=await fixture();try{await f.manager.start('openai-codex','oauth','manual');await f.until(v=>!!v.canEnterCode);f.inputMode='failure';assert.equal(f.manager.enterCode('manual').accepted,true);assert.equal(f.manager.enterCode('manual').accepted,false);await f.until(v=>v.inputIssue==='input_unavailable');assert.equal((await f.view()).state,'awaiting_browser');
 f.inputMode='cancel';f.manager.enterCode('manual');await f.until(v=>v.inputIssue==='input_cancelled');assert.equal((await f.view()).canOpenBrowser,true);
 f.inputMode='success';f.manager.enterCode('manual');await f.manager.idle();const v=await f.view();assert.equal(v.state,'connected');assert.equal(v.canOpenBrowser,false);assert.equal(v.canEnterCode,false);assert.equal(f.data.get('openai-codex')?.type,'oauth');
 const publicText=JSON.stringify({events:f.events,v});for(const value of [f.url,f.token,'private-fixture-refresh','fixture-code'])assert.ok(!publicText.includes(value));
 }finally{await f.close();}
});
test('real SDK callback validates state and completes without a manual window',async()=>{
 const f=await fixture();try{await f.manager.start('openai-codex','oauth','callback');await f.until(v=>!!v.canEnterCode);const state=new URL(f.url).searchParams.get('state');
 assert.equal((await fetch(f.callback+'?state=wrong&code=fixture-code')).status,400);assert.equal(f.data.size,0);assert.equal((await f.view()).state,'awaiting_browser');
 assert.equal((await fetch(f.callback+'?state='+state+'&code=fixture-code')).status,200);await f.manager.idle();assert.equal((await f.view()).state,'connected');assert.equal(f.manualCalls,0);
 }finally{await f.close();}
});
test('expired flow cannot reopen or accept manual input; storage failure is distinct',async()=>{
 const timed=await fixture(60);try{await timed.manager.start('openai-codex','oauth','expired');await timed.manager.idle();assert.equal((await timed.view()).state,'timed_out');assert.deepEqual(await timed.manager.openBrowser('expired'),{accepted:false,reason:'inactive'});assert.equal(timed.manager.enterCode('expired').accepted,false);}finally{await timed.close();}
 const f=await fixture();try{f.failSave=true;await f.manager.start('openai-codex','oauth','storage');await f.until(v=>!!v.canEnterCode);f.manager.enterCode('storage');await f.manager.idle();assert.equal((await f.view()).failureCode,'credential_save_failed');assert.equal((await f.view()).state,'failed');assert.equal(f.data.size,0);}finally{await f.close();}
});
test('selection helper failure and deliberate user cancellation have distinct safe states',async()=>{
 for(const mode of ['failure','cancel']){const f=await fixture();try{f.native.prompt=async()=>{if(mode==='cancel')throw authCancelled();throw Error('private helper diagnostics');};await f.manager.start('openai-codex','oauth','select-'+mode);await f.manager.idle();const v=await f.view();assert.equal(v.state,mode==='cancel'?'cancelled':'failed');assert.equal(v.failureCode,mode==='cancel'?undefined:'interaction_unavailable');assert.ok(!JSON.stringify({events:f.events,v}).includes('private'));}finally{await f.close();}}
});
test('duplicate browser requests are bounded and a late completion cannot revive a cancelled flow',async()=>{
 const f=await fixture();let finish:()=>void=()=>{};try{const open=f.native.browser;f.native.browser=async(url,signal)=>{await open(url,signal);await new Promise<void>(resolve=>{finish=resolve;});};await f.manager.start('openai-codex','oauth','late');await f.until(v=>!!v.browserOpening&&!!v.canEnterCode);assert.deepEqual(await f.manager.openBrowser('late'),{accepted:false,reason:'busy'});assert.equal(f.browserCalls,1);f.manager.cancel('late');await f.manager.idle();const count=f.events.length;finish();await sleep(10);assert.equal((await f.view()).state,'cancelled');assert.equal(f.events.length,count);assert.equal(f.data.size,0);}finally{finish();await f.close();}
});
