import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,readFile,rm,mkdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ModelRuntime} from "@earendil-works/pi-coding-agent";
import type {Credential,AuthPrompt,Provider} from "@earendil-works/pi-ai";
import {DCodeCredentialStore,MacCredentialAdapter,authCancelled,type CredentialVault,type ConfidentialInteraction} from "../src/secure-model-credentials.js";
import {ModelConnections} from "../src/model-connections.js";
import {validateMethodParams} from "../src/protocol.js";
import {PiHost} from "../src/pi-host.js";
import type {DCodeModelsView} from "../src/model-catalog-view.js";
import type {FoundationSnapshot} from "../src/product-store.js";

class FakeNative implements CredentialVault,ConfidentialInteraction {
  data=new Map<string,Credential>();tail=Promise.resolve();failSave=false;promptCount=0;
  answer:(prompt:AuthPrompt,signal:AbortSignal)=>Promise<string>=async()=>"fixture-private-secret";
  list=async()=>[...this.data].map(([providerId,c])=>({providerId,type:c.type}));
  async transaction<T>(id:string,fn:(c:Credential|undefined)=>Promise<{value:T;write?:Credential|null}>,signal?:AbortSignal):Promise<T>{
    const next=this.tail.then(async()=>{signal?.throwIfAborted();const result=await fn(this.data.get(id));signal?.throwIfAborted();if(result.write!==undefined){if(this.failSave)throw Error("fixture-private-secret storage failed");if(result.write===null)this.data.delete(id);else this.data.set(id,result.write);}return result.value;});
    this.tail=next.then(()=>{},()=>{});return next;
  }
  prompt=async(_name:string,p:AuthPrompt,s:AbortSignal)=>{this.promptCount++;return this.answer(p,s);};
  browser=async()=>{};notice=async()=>{};
}
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),"dcode-auth-fixture-"));
  const native=new FakeNative();
  const store=new DCodeCredentialStore(native,join(root,"external.json"));
  const runtime=await ModelRuntime.create({credentials:store,modelsPath:null,refreshOnCreate:false,allowModelNetwork:false});
  const events:unknown[]=[];
  const manager=new ModelConnections(store,native,async()=>runtime,async()=>{await runtime.refresh({allowNetwork:false});},(event,data)=>events.push({event,data}));
  const close=async()=>{await manager.close();await rm(root,{recursive:true,force:true});};
  return {root,native,store,runtime,manager,events,close};
}
function installFakeOAuth(runtime:ModelRuntime){
  const provider=runtime.getProvider("openai-codex")!;
  runtime.registerNativeProvider({...provider,auth:{oauth:{...provider.auth.oauth!,login:async interaction=>({type:"oauth",access:await interaction.prompt({type:"manual_code",message:"Enter test callback"}),refresh:"fixture-private-refresh",expires:Date.now()+600_000}),toAuth:async c=>({apiKey:c.access})}}});
}
test("built-in methods, safe API setup, duplicate/concurrent starts, restart and external disconnect scope",async()=>{
  const f=await fixture();try{
    const view=await f.manager.get();
    assert.deepEqual(view.providers.find(p=>p.providerId==="openai")?.methods.map(m=>m.type),["api_key"]);
    assert.deepEqual(view.providers.find(p=>p.providerId==="openai-codex")?.methods.map(m=>m.type),["oauth"]);
    const first=f.manager.connectApiKey("openai","fixture-private-secret","one");
    const duplicate=f.manager.connectApiKey("openai","fixture-private-secret","one");
    assert.deepEqual(await f.manager.connectApiKey("minimax-cn","fixture-private-secret","two"),{ok:false,code:"BUSY"});
    assert.deepEqual(await Promise.all([first,duplicate]),[{ok:true},{ok:false,code:"BUSY"}]);
    assert.equal(f.native.promptCount,0);
    await assert.rejects(f.manager.start("openai","api_key","no-popup"),/供应商旁输入/);
    assert.equal((await f.manager.get()).providers.find(p=>p.providerId==="openai")?.state,"configured");
    const restored=new DCodeCredentialStore(f.native,join(f.root,"external.json"));
    assert.equal((await restored.read("openai"))?.type,"api_key");
    await writeFile(join(f.root,"external.json"),JSON.stringify({openai:{type:"api_key",key:"external-private-value"}}));
    await f.manager.disconnect("openai");
    assert.equal(f.native.data.size,0);
    assert.equal((await restored.list()).length,1);
    assert.equal((await f.manager.get()).providers.find(p=>p.providerId==="openai")?.external,true);
    assert.equal(JSON.parse(await readFile(join(f.root,"external.json"),"utf8")).openai.key,"external-private-value");
    assert.ok(!JSON.stringify({events:f.events,view:await f.manager.get()}).includes("private"));
  }finally{await f.close();}
});
test("cancel and a late prompt result cannot save; native cancel, storage and sync failures do not report success",async()=>{
  const f=await fixture();try{
    installFakeOAuth(f.runtime);
    let finish:(v:string)=>void=()=>{};
    f.native.answer=async()=>new Promise(r=>{finish=r;});
    await f.manager.start("openai-codex","oauth","cancel");
    while(!f.native.promptCount)await new Promise(r=>setTimeout(r,5));
    assert.equal(f.manager.cancel("old").cancelled,false);
    assert.equal(f.manager.cancel("cancel").cancelled,true);
    finish("late-private-secret");await f.manager.idle();
    assert.equal(f.native.data.size,0);
    assert.equal((await f.manager.get()).providers.find(p=>p.providerId==="openai-codex")?.state,"cancelled");
    f.native.answer=async()=>{throw authCancelled();};
    await f.manager.start("openai-codex","oauth","native-cancel");await f.manager.idle();
    assert.equal((await f.manager.get()).providers.find(p=>p.providerId==="openai-codex")?.state,"cancelled");
    f.native.answer=async()=>"fixture-private-secret";f.native.failSave=true;
    assert.deepEqual(await f.manager.connectApiKey("openai","fixture-private-secret","fail"),{ok:false,code:"FAILED"});
    assert.equal(f.native.data.size,0);
    assert.equal((await f.manager.get()).providers.find(p=>p.providerId==="openai")?.state,"failed");
    assert.ok(!JSON.stringify(f.events).includes("private"));
  }finally{await f.close();}
});
test("OAuth stays in Host, expired refresh is serialized and external OAuth is never refreshed into auth.json",async()=>{
  const f=await fixture();try{
    const original=f.runtime.getProvider("openai-codex")!;
    let refreshes=0;
    const provider:Provider={...original,auth:{oauth:{...original.auth.oauth!,login:async interaction=>{
      interaction.notify({type:"auth_url",url:"https://example.invalid/login?private-state=fixture"});
      const value=await interaction.prompt({type:"manual_code",message:"Private callback"});
      return {type:"oauth",access:value,refresh:"fixture-private-refresh",expires:Date.now()+600_000};
    },refresh:async credential=>{refreshes++;await new Promise(r=>setTimeout(r,20));return {...credential,access:"fixture-refreshed-access",expires:Date.now()+600_000};},toAuth:async c=>({apiKey:c.access})}}};
    f.runtime.registerNativeProvider(provider);
    await f.manager.start("openai-codex","oauth","oauth");
    for(let i=0;i<100&&!(await f.manager.get()).providers.find(p=>p.providerId==="openai-codex")?.canEnterCode;i++)await new Promise(r=>setTimeout(r,10));
    assert.equal(f.manager.enterCode("oauth").accepted,true);await f.manager.idle();
    assert.equal((await f.manager.get()).providers.find(p=>p.providerId==="openai-codex")?.state,"connected");
    await f.store.save("openai-codex",{type:"oauth",access:"expired-private",refresh:"private-refresh",expires:0});
    assert.equal((await f.manager.get()).providers.find(p=>p.providerId==="openai-codex")?.state,"refresh_pending");
    assert.equal((await f.store.unavailableProviders(["openai-codex"])).size,0);
    await Promise.all([f.runtime.getAuth("openai-codex"),f.runtime.getAuth("openai-codex")]);
    assert.equal(refreshes,1);
    await f.manager.disconnect("openai-codex");
    const bytes=JSON.stringify({"openai-codex":{type:"oauth",access:"old-private",refresh:"old-refresh",expires:0}});
    await writeFile(join(f.root,"external.json"),bytes);
    await assert.rejects(f.runtime.getAuth("openai-codex"),/Reconnect/);
    assert.equal(await readFile(join(f.root,"external.json"),"utf8"),bytes);
    assert.equal((await f.manager.get()).providers.find(p=>p.providerId==="openai-codex")?.state,"reconnect_required");
    assert.ok(!JSON.stringify(f.events).includes("private"));
  }finally{await f.close();}
});
test("public connection controls reject every credential-bearing or extra field",()=>{
  for(const method of ["dcodeAuth.get","dcodeAuth.start","dcodeAuth.authorizeAccess","dcodeAuth.cancel","dcodeAuth.openBrowser","dcodeAuth.enterCode","dcodeAuth.disconnect"] as const){
    const params=method==="dcodeAuth.get"?{}:method==="dcodeAuth.start"?{providerId:"openai",authType:"api_key",flowId:"id"}:method==="dcodeAuth.authorizeAccess"?{providerId:"openai",flowId:"id"}:["dcodeAuth.cancel","dcodeAuth.openBrowser","dcodeAuth.enterCode"].includes(method)?{flowId:"id"}:{providerId:"openai"};
    assert.doesNotThrow(()=>validateMethodParams(method,params));
    for(const key of ["value","apiKey","access","refresh","code","url","runtimeId"]){assert.throws(()=>validateMethodParams(method,{...params,[key]:"private-secret"}),/does not accept credential/);}
  }
});
test("native Keychain private adapter round-trip, serialized transactions and scoped removal using only fake values",async()=>{
  const root=await mkdtemp(join(tmpdir(),"dcode-keychain-test-"));
  const a=new MacCredentialAdapter(root),b=new MacCredentialAdapter(root);
  try{
    assert.deepEqual(await a.list(),[]);
    await a.transaction("fixture",async()=>({value:undefined,write:{type:"api_key",key:"fake-native-value-0"}}));
    let entered:()=>void=()=>{};const locked=new Promise<void>(resolve=>{entered=resolve;});
    const first=a.transaction("fixture",async current=>{entered();assert.equal(current?.type,"api_key");await new Promise(r=>setTimeout(r,100));return {value:1,write:{type:"api_key",key:"fake-native-value-1"}};});
    await locked;
    const second=b.transaction("fixture",async current=>({value:current?.type==="api_key"?current.key:""}));
    assert.equal(await first,1);assert.equal(await second,"fake-native-value-1");
    assert.deepEqual(await b.list(),[{providerId:"fixture",type:"api_key"}]);
    assert.ok(!JSON.stringify(await b.list()).includes("fake-native"));
  }finally{
    await a.transaction("fixture",async()=>({value:undefined,write:null}));assert.deepEqual(await a.list(),[]);a.close();b.close();await rm(root,{recursive:true,force:true});
  }
});
test("real Host API connection refreshes safe Product Store references and models, restores on restart and keeps old IPC disabled",async()=>{
  const root=await mkdtemp(join(tmpdir(),"dcode-auth-host-"));
  const native=new FakeNative(),events:unknown[]=[];
  const options={agentDir:join(root,"agent"),dataRoot:join(root,".dcode"),userHome:root,modelCredentialAdapter:native,emit:(event:string,data?:unknown)=>events.push({event,data})};
  await mkdir(options.agentDir);
  let host=new PiHost(options);
  try{
    await host.start();
    assert.deepEqual(await host.connectApiKey("openai","fixture-private-secret","host-flow"),{ok:true});
    for(let i=0;i<300&&!events.some(e=>(e as {data?:{state?:string}}).data?.state==="configured");i++)await new Promise(r=>setTimeout(r,20));
    assert.ok(events.some(e=>(e as {data?:{state?:string}}).data?.state==="configured"));
    const snapshot=await host.handle("foundation.snapshot",{}) as FoundationSnapshot;
    assert.equal(snapshot.credentialReferences.find(r=>r.providerId==="openai")?.referenceKind,"keychain");
    assert.ok((await host.handle("dcodeModels.get",{}) as DCodeModelsView).models.some(m=>m.providerId==="openai"&&m.available));
    assert.ok(!JSON.stringify({snapshot,events}).includes("fixture-private-secret"));
    await assert.rejects(host.handle("modelAuth.respond",{flowId:"legacy",requestId:"id",value:"private"}),/does not accept credential/);
    await host.close();host=new PiHost(options);await host.start();
    assert.ok((await host.handle("dcodeModels.get",{}) as DCodeModelsView).models.some(m=>m.providerId==="openai"&&m.available));
    await host.handle("dcodeAuth.disconnect",{providerId:"openai"});
    assert.equal(native.data.size,0);
    await assert.rejects(readFile(join(options.agentDir,"auth.json")),{code:"ENOENT"});
  }finally{await host.close();await rm(root,{recursive:true,force:true});}
});

test("whole-flow deadline rejects a late callback even when no native pipe is open",async()=>{
  const f=await fixture();try{
    installFakeOAuth(f.runtime);
    let finish:(value:string)=>void=()=>{};
    f.native.answer=async()=>new Promise(r=>{finish=r;});
    const manager=new ModelConnections(f.store,f.native,async()=>f.runtime,async()=>{},(event,data)=>f.events.push({event,data}),{timeoutMs:30});
    await manager.start("openai-codex","oauth","deadline");
    await manager.idle();finish("late-private-result");await new Promise(r=>setTimeout(r,5));
    assert.equal(f.native.data.size,0);
    assert.equal((await manager.get()).providers.find(p=>p.providerId==="openai-codex")?.state,"timed_out");
    await manager.close();
  }finally{await f.close();}
});
test("safe environment references retain SDK semantics; unresolved command refs never execute or become literal credentials",async()=>{
  const f=await fixture();const prior=process.env.DCODE_AUTH_TEST_REFERENCE;
  try{
    process.env.DCODE_AUTH_TEST_REFERENCE="private-resolved-value";
    const bytes=JSON.stringify({openai:{type:"api_key",key:"${DCODE_AUTH_TEST_REFERENCE}"},command:{type:"api_key",key:"!touch /tmp/dcode-must-not-execute"}});
    await writeFile(join(f.root,"external.json"),bytes);
    assert.equal((await f.store.read("openai") as {key:string}).key,"private-resolved-value");
    assert.equal((await f.store.read("command") as {key?:string}).key,undefined);
    assert.equal((await f.store.connectionMetadata("command")).failed,true);
    assert.equal(await readFile(join(f.root,"external.json"),"utf8"),bytes);
    assert.ok(!JSON.stringify(await f.store.list()).includes("private-resolved-value"));
  }finally{if(prior===undefined)delete process.env.DCODE_AUTH_TEST_REFERENCE;else process.env.DCODE_AUTH_TEST_REFERENCE=prior;await f.close();}
});
test("catalog synchronization failure is distinct from saved connection; retry does not ask for credentials again",async()=>{
  const f=await fixture();try{
    let fail=true;
    const manager=new ModelConnections(f.store,f.native,async()=>f.runtime,async()=>{if(fail)throw Error("private-secret-sync-error");},(event,data)=>f.events.push({event,data}));
    assert.deepEqual(await manager.connectApiKey("openai","fixture-private-secret","sync"),{ok:false,code:"SYNC_REQUIRED"});
    assert.equal((await manager.get()).providers.find(p=>p.providerId==="openai")?.state,"sync_required");
    assert.equal(f.native.data.size,1);fail=false;await manager.refresh();
    assert.equal(f.native.promptCount,0);
    assert.equal((await manager.get()).providers.find(p=>p.providerId==="openai")?.state,"configured");
    await manager.close();
  }finally{await f.close();}
});
test("request result verifies only its original credential generation and 401 disables future use without confusing model 403",async()=>{
  const f=await fixture();try{
    await f.store.save("openai",{type:"api_key",key:"private-old"});const old=f.store.generation("openai");
    await f.store.save("openai",{type:"api_key",key:"private-new"});
    assert.equal(await f.store.recordResponse("openai",old,401),false);
    assert.equal((await f.store.connectionMetadata("openai")).failed,false);
    const current=f.store.generation("openai");await f.store.recordResponse("openai",current,200);
    assert.equal((await f.store.connectionMetadata("openai")).verified,true);
    await f.store.recordResponse("openai",current,403);assert.equal((await f.store.connectionMetadata("openai")).failed,false);
    await f.store.recordResponse("openai",current,401);assert.ok((await f.store.unavailableProviders(["openai"])).has("openai"));
    assert.equal((await f.manager.get()).providers.find(p=>p.providerId==="openai")?.state,"reconnect_required");
  }finally{await f.close();}
});

test("cancelling while a confidential notice is pending remains cancelled instead of becoming a native failure",async()=>{
  const f=await fixture();try{
    const base=f.runtime.getProvider("openai-codex")!;
    let entered:()=>void=()=>{};const noticeEntered=new Promise<void>(resolve=>{entered=resolve;});
    const native:ConfidentialInteraction={...f.native,
      prompt:f.native.prompt,browser:f.native.browser,
      notice:async(_message,signal)=>{entered();await new Promise<void>((_resolve,reject)=>signal.addEventListener("abort",()=>reject(authCancelled()),{once:true}));},
    };
    f.runtime.registerNativeProvider({...base,auth:{oauth:{...base.auth.oauth!,login:async interaction=>{
      interaction.notify({type:"info",message:"Private verification instructions"});
      return {type:"oauth",access:"private-access",refresh:"private-refresh",expires:Date.now()+600_000};
    },toAuth:async c=>({apiKey:c.access})}}});
    const manager=new ModelConnections(f.store,native,async()=>f.runtime,async()=>{},(event,data)=>f.events.push({event,data}));
    await manager.start("openai-codex","oauth","notice");await noticeEntered;
    manager.cancel("notice");await manager.idle();
    assert.equal((await manager.get()).providers.find(p=>p.providerId==="openai-codex")?.state,"cancelled");
    assert.equal(f.native.data.size,0);await manager.close();
  }finally{await f.close();}
});

test("one expired external OAuth never disables a healthy API provider in the real Host model projection",async()=>{
  const root=await mkdtemp(join(tmpdir(),"dcode-auth-mixed-")),native=new FakeNative();
  const options={agentDir:join(root,"agent"),dataRoot:join(root,".dcode"),userHome:root,modelCredentialAdapter:native,emit:()=>{}};
  await mkdir(options.agentDir);
  await native.transaction("openai",async()=>({value:undefined,write:{type:"api_key",key:"healthy-private-fake"}}));
  const oauth=(expires:number)=>JSON.stringify({"openai-codex":{type:"oauth",access:"external-fake-access",refresh:"external-fake-refresh",expires}});
  await writeFile(join(options.agentDir,"auth.json"),oauth(Date.now()+600_000));
  const host=new PiHost(options);
  try{
    await host.start();
    let view=await host.handle("dcodeModels.get",{}) as DCodeModelsView;
    assert.ok(view.models.some(m=>m.providerId==="openai"&&m.available));assert.ok(view.models.some(m=>m.providerId==="openai-codex"&&m.available));
    await writeFile(join(options.agentDir,"auth.json"),oauth(0));
    view=await host.handle("dcodeModels.get",{}) as DCodeModelsView;
    assert.ok(view.models.some(m=>m.providerId==="openai"&&m.available));assert.equal(view.models.some(m=>m.providerId==="openai-codex"&&m.available),false);
    await host.close();const restarted=new PiHost(options);try{await restarted.start();view=await restarted.handle("dcodeModels.get",{}) as DCodeModelsView;assert.ok(view.models.some(m=>m.providerId==="openai"&&m.available));assert.equal(view.models.some(m=>m.providerId==="openai-codex"&&m.available),false);}finally{await restarted.close();}
  }finally{await host.close();await rm(root,{recursive:true,force:true});}
});

test("OAuth rotation advances the generation so an old request cannot invalidate the refreshed token",async()=>{
  const f=await fixture();try{
    await f.store.save("openai-codex",{type:"oauth",access:"old-private",refresh:"old-refresh",expires:0});
    const old=f.store.generation("openai-codex");
    await f.store.modify("openai-codex",async c=>({...c as Extract<Credential,{type:"oauth"}>,access:"new-private",expires:Date.now()+600_000}));
    assert.equal(await f.store.recordResponse("openai-codex",old,401),false);
    assert.equal((await f.store.connectionMetadata("openai-codex")).failed,false);
  }finally{await f.close();}
});

test("a custom catalog provider can be saved without an environment key, securely connected and used after restart",async()=>{
  const root=await mkdtemp(join(tmpdir(),"dcode-auth-custom-")),native=new FakeNative();
  const options={agentDir:join(root,"agent"),dataRoot:join(root,".dcode"),userHome:root,modelCredentialAdapter:native,emit:()=>{}};await mkdir(options.agentDir);
  let host=new PiHost(options);
  try{
    await host.start();
    const snapshot=await host.handle("foundation.snapshot",{}) as FoundationSnapshot;
    await host.handle("dcodeModelProvider.save",{requestId:"custom",expectedStoreRevision:snapshot.storeRevision,provider:{id:"custom-fixture",name:"Custom fixture",apiKind:"openai-completions",baseUrl:"https://example.invalid/v1",managedAuth:true,credentialEnv:"",models:[{modelId:"test",name:"Test",reasoning:false,contextWindow:8192,maxTokens:1024}]}});
    const before=await host.handle("dcodeAuth.get",{}) as Awaited<ReturnType<ModelConnections["get"]>>;
    assert.deepEqual(before.providers.find(p=>p.providerId==="custom-fixture")?.methods.map(m=>m.type),["api_key"]);
    assert.deepEqual(await host.connectApiKey("custom-fixture","fixture-private-secret","custom-flow"),{ok:true});
    for(let i=0;i<200;i++){const v=await host.handle("dcodeAuth.get",{}) as Awaited<ReturnType<ModelConnections["get"]>>;if(v.providers.find(p=>p.providerId==="custom-fixture")?.state==="configured")break;await new Promise(r=>setTimeout(r,10));}
    assert.ok((await host.handle("dcodeModels.get",{}) as DCodeModelsView).models.find(m=>m.providerId==="custom-fixture")?.available);
    await host.close();host=new PiHost(options);await host.start();
    assert.ok((await host.handle("dcodeModels.get",{}) as DCodeModelsView).models.find(m=>m.providerId==="custom-fixture")?.available);
    await host.handle("dcodeAuth.disconnect",{providerId:"custom-fixture"});
    assert.equal((await host.handle("dcodeModels.get",{}) as DCodeModelsView).models.find(m=>m.providerId==="custom-fixture")?.available,false);
  }finally{await host.close();await rm(root,{recursive:true,force:true});}
});

test("external credential rotation clears its old rejection and a stale response cannot invalidate the replacement",async()=>{
  const f=await fixture();try{
    const path=join(f.root,"external.json");
    await writeFile(path,JSON.stringify({openai:{type:"api_key",key:"external-private-old"}}));
    await f.store.read("openai");const old=f.store.generation("openai");
    await f.store.recordResponse("openai",old,401);assert.ok((await f.store.unavailableProviders(["openai"])).has("openai"));
    await writeFile(path,JSON.stringify({openai:{type:"api_key",key:"external-private-new"}}));
    assert.equal(await f.store.recordResponse("openai",old,401),false);
    assert.equal((await f.store.unavailableProviders(["openai"])).size,0);
    assert.equal((await f.store.read("openai") as {key:string}).key,"external-private-new");
    assert.ok(!JSON.stringify(await f.manager.get()).includes("external-private"));
  }finally{await f.close();}
});

test("connection status observation never turns an already returned response into a failure",async()=>{
  const f=await fixture();try{
    await f.store.save("openai",{type:"api_key",key:"private-managed"});await f.store.managed();const generation=f.store.generation("openai");
    // Once request auth has been resolved, tracking a response must not read its secret again.
    const original=f.native.transaction.bind(f.native);f.native.transaction=async()=>{throw Error("private-storage-failure");};
    assert.equal(await f.store.recordResponse("openai",generation,200),true);
    f.native.transaction=original;
    await writeFile(join(f.root,"external.json"),JSON.stringify({"external-test":{type:"api_key",key:"external-private"}}));await f.store.read("external-test");
    await writeFile(join(f.root,"external.json"),"not JSON private input");
    assert.equal(await f.store.recordResponse("external-test",f.store.generation("external-test"),200),false);
  }finally{await f.close();}
});

test("a provider echo of an arbitrary managed key cannot enter public events, runtime history or Product Store",async()=>{
  const echo="no-standard-prefix-for-this-private-credential";
  const root=await mkdtemp(join(tmpdir(),"dcode-auth-echo-")),native=new FakeNative(),events:string[]=[];
  native.answer=async()=>echo;
  const options={agentDir:join(root,"agent"),dataRoot:join(root,".dcode"),userHome:root,modelCredentialAdapter:native,emit:(event:string,data?:unknown)=>events.push(JSON.stringify({event,data}))};await mkdir(options.agentDir);
  const host=new PiHost(options),previousFetch=globalThis.fetch;let called=false;
  globalThis.fetch=(async(input,init)=>{
    assert.ok(String(input).startsWith("https://credential-echo.invalid/"));
    assert.equal(new Headers(init?.headers).get("authorization"),`Bearer ${echo}`);called=true;
    return Response.json({error:{message:`Provider rejected credential ${echo}`}}, {status:401});
  }) as typeof fetch;
  try{
    await host.start();let snapshot=await host.handle("foundation.snapshot",{}) as FoundationSnapshot;
    await host.handle("dcodeModelProvider.save",{requestId:"echo-provider",expectedStoreRevision:snapshot.storeRevision,provider:{id:"echo-provider",name:"Echo Provider",apiKind:"openai-completions",baseUrl:"https://credential-echo.invalid/v1",managedAuth:true,credentialEnv:"",models:[{modelId:"fixture",name:"Fixture",reasoning:false,contextWindow:64000,maxTokens:4096}]}});
    assert.deepEqual(await host.connectApiKey("echo-provider",echo,"echo-login"),{ok:true});
    for(let i=0;i<200;i++){const view=await host.handle("dcodeAuth.get",{}) as Awaited<ReturnType<ModelConnections["get"]>>;if(view.providers.find(p=>p.providerId==="echo-provider")?.state==="configured")break;await new Promise(r=>setTimeout(r,10));}
    snapshot=await host.handle("foundation.snapshot",{}) as FoundationSnapshot;
    await host.handle("dcodeModels.select",{requestId:"echo-model",expectedStoreRevision:snapshot.storeRevision,providerId:"echo-provider",modelId:"fixture"});
    snapshot=await host.handle("foundation.snapshot",{}) as FoundationSnapshot;
    const task=await host.handle("task.create",{requestId:"echo-task",expectedStoreRevision:snapshot.storeRevision,scope:{kind:"user",userId:snapshot.currentUser.id},title:"错误回显验证",goal:"保留错误但移除机密"}) as import("../src/product-store.js").TaskBundle;
    await host.handle("dcodeSession.prompt",{dcodeSessionId:task.coordinationSession.id,promptId:"echo-prompt",message:"开始一次受控调用"});
    for(let i=0;i<500;i++){snapshot=await host.handle("foundation.snapshot",{}) as FoundationSnapshot;if(snapshot.sessionRuns.at(-1)?.status==="failed")break;await new Promise(r=>setTimeout(r,10));}
    assert.equal(called,true);assert.equal(snapshot.sessionRuns.at(-1)?.status,"failed");
    assert.ok(snapshot.providerCalls?.some(c=>c.state==="failed"));
    assert.ok(!JSON.stringify(snapshot).includes(echo));assert.ok(!events.join("").includes(echo));
    const presentation=await host.handle("dcodeSession.presentation",{dcodeSessionId:task.coordinationSession.id});assert.ok(!JSON.stringify(presentation).includes(echo));
    await host.close();
    const {readdir}=await import("node:fs/promises");
    const check=async(path:string):Promise<void>=>{for(const entry of await readdir(path,{withFileTypes:true})){const file=join(path,entry.name);if(entry.isDirectory())await check(file);else if(entry.isFile())assert.ok(!(await readFile(file)).includes(echo),"Known credential found in persisted data");}};
    await check(options.dataRoot);
  }finally{globalThis.fetch=previousFetch;await host.close();await rm(root,{recursive:true,force:true});}
});
