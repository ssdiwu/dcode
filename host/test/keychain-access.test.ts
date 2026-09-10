import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm}from'node:fs/promises';import{join}from'node:path';import{tmpdir}from'node:os';
import {ModelRuntime}from'@earendil-works/pi-coding-agent';import type{Credential}from'@earendil-works/pi-ai';
import{DCodeCredentialStore,SecureCredentialError,authCancelled,type CredentialVault}from'../src/secure-model-credentials.js';import{ModelConnections}from'../src/model-connections.js';import{PiHost}from'../src/pi-host.js';import type{DCodeModelsView}from'../src/model-catalog-view.js';
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
class AccessVault implements CredentialVault {
 data=new Map<string,Credential>([['zai-coding-cn',{type:'api_key',key:'fake-existing-zai'}],['openai',{type:'api_key',key:'fake-working-openai'}]]);
 blocked=true;reads=0;interactive=0;decision:(allow:boolean)=>void=()=>{};listFails=false;
 async list(){if(this.listFails)throw new SecureCredentialError('access_required');return [...this.data].map(([providerId,c])=>({providerId,type:c.type,...(c.type==='oauth'?{expires:c.expires}:{})}));}
 async transaction<T>(id:string,fn:(value:Credential|undefined)=>Promise<{value:T;write?:Credential|null}>,signal?:AbortSignal,options?:{interactive?:boolean}):Promise<T>{
  if(options?.interactive){this.interactive++;await new Promise<void>((resolve,reject)=>{const abort=()=>reject(authCancelled());this.decision=allow=>{signal?.removeEventListener('abort',abort);if(signal?.aborted)return;if(!allow){reject(new SecureCredentialError('access_denied'));return;}this.blocked=false;resolve();};if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});});}
  else {if(id==='zai-coding-cn')this.reads++;await sleep(5);if(id==='zai-coding-cn'&&this.blocked)throw new SecureCredentialError('access_required');}
  const result=await fn(this.data.get(id));signal?.throwIfAborted();if(result.write===null)this.data.delete(id);else if(result.write)this.data.set(id,result.write);return result.value;
 }
}
async function fixture(timeoutMs?:number){const root=await mkdtemp(join(tmpdir(),'dcode-access-')),vault=new AccessVault(),events:unknown[]=[];const credentials=new DCodeCredentialStore(vault,join(root,'external.json'));const runtime=await ModelRuntime.create({credentials,modelsPath:null,refreshOnCreate:false,allowModelNetwork:false});const manager=new ModelConnections(credentials,{prompt:async()=>{throw Error('No auth prompt');},browser:async()=>{},notice:async()=>{}},async()=>runtime,async()=>{await runtime.refresh({allowNetwork:false,providers:['openai','zai-coding-cn']});},(event,data)=>events.push({event,data}),{timeoutMs});
 const view=async()=>(await manager.get()).providers.find(p=>p.providerId==='zai-coding-cn')!;
 const until=async(check:()=>boolean|Promise<boolean>)=>{for(let i=0;i<200;i++){if(await check())return;await sleep(5);}throw Error('Access state timeout');};
 return{root,vault,credentials,runtime,manager,view,until,events,close:async()=>{await manager.close();credentials.close();await rm(root,{recursive:true,force:true});}};
}
test('background metadata reads no secret, concurrent denial coalesces and does not automatically retry',async()=>{
 const f=await fixture();try{await Promise.all(Array.from({length:10},()=>f.manager.get()));await f.credentials.unavailableProviders(['zai-coding-cn']);assert.equal(f.vault.reads,0);assert.equal(f.vault.interactive,0);
 const rejected=await Promise.allSettled(Array.from({length:20},()=>f.credentials.read('zai-coding-cn')));assert.ok(rejected.every(r=>r.status==='rejected'));assert.equal(f.vault.reads,1);
 await Promise.allSettled(Array.from({length:20},()=>f.credentials.read('zai-coding-cn')));await f.manager.get();assert.equal(f.vault.reads,1);assert.equal(f.vault.interactive,0);assert.equal((await f.view()).canAuthorizeAccess,true);
 }finally{await f.close();}
});
test('explicit denial/cancel do not replay; a retry authorizes normal subsequent reads without secret caching',async()=>{
 const f=await fixture();try{await assert.rejects(f.credentials.read('zai-coding-cn'));
 f.manager.authorizeAccess('zai-coding-cn','denied');await f.until(()=>f.vault.interactive===1);assert.deepEqual(f.manager.authorizeAccess('zai-coding-cn','duplicate'),{flowId:'denied',accepted:false});assert.equal((await f.view()).state,'awaiting_access');f.vault.decision(false);await f.manager.idle();assert.equal((await f.view()).state,'access_denied');await assert.rejects(f.credentials.read('zai-coding-cn'));assert.equal(f.vault.interactive,1);assert.equal(f.vault.data.size,2);
 f.manager.authorizeAccess('zai-coding-cn','cancelled');await f.until(()=>f.vault.interactive===2);f.manager.cancel('cancelled');await f.manager.idle();f.vault.decision(true);assert.equal((await f.view()).state,'access_cancelled');assert.equal(f.vault.blocked,true);
 f.manager.authorizeAccess('zai-coding-cn','retry');await f.until(()=>f.vault.interactive===3);f.vault.decision(true);await f.manager.idle();assert.equal(f.credentials.accessState('zai-coding-cn'),undefined);
 for(let i=0;i<4;i++)assert.equal((await f.credentials.read('zai-coding-cn'))?.type,'api_key');assert.equal(f.vault.interactive,3);
 const generation=f.credentials.generation('zai-coding-cn');f.vault.data.set('zai-coding-cn',{type:'api_key',key:'fake-replaced'});assert.equal((await f.credentials.read('zai-coding-cn') as {key:string}).key,'fake-replaced');assert.equal(await f.credentials.recordResponse('zai-coding-cn',generation,401),false);
 f.vault.blocked=true;await assert.rejects(f.credentials.read('zai-coding-cn'));const reads=f.vault.reads;await assert.rejects(f.credentials.read('zai-coding-cn'));assert.equal(f.vault.reads,reads,'No old credential bypasses renewed OS denial');
 const restarted=new DCodeCredentialStore(f.vault,join(f.root,'external.json'));await assert.rejects(restarted.read('zai-coding-cn'));assert.equal(f.vault.interactive,3);restarted.close();assert.ok(!JSON.stringify({view:await f.view(),events:f.events}).includes('fake-existing-zai'));
 }finally{await f.close();}
});
test('an aborted reader does not cancel other callers and closed stores return no credential',async()=>{
 const f=await fixture();try{f.vault.blocked=false;const controller=new AbortController();const cancelled=f.credentials.read('zai-coding-cn',{signal:controller.signal});const other=f.credentials.read('zai-coding-cn');controller.abort();await assert.rejects(cancelled);assert.equal((await other)?.type,'api_key');assert.equal(f.vault.reads,1);f.credentials.close();await assert.rejects(f.credentials.read('zai-coding-cn'));}finally{await f.close();}
});
test('known managed ownership survives an unavailable attributes query without external fallback',async()=>{
 const f=await fixture();try{f.vault.listFails=true;const store=new DCodeCredentialStore(f.vault,join(f.root,'external.json'),{knownManagedProviderIds:async()=>['zai-coding-cn']});const metadata=await store.connectionMetadata('zai-coding-cn');assert.equal(metadata.managed,true);assert.equal(metadata.type,undefined);assert.equal(store.accessState('zai-coding-cn'),'access_required');await assert.rejects(store.read('zai-coding-cn'));assert.equal(f.vault.reads,0);assert.equal(f.vault.interactive,0);store.close();}finally{await f.close();}
});
test('real Host retains healthy models while one managed provider requires Keychain access',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dcode-access-host-')),agent=join(root,'agent');await mkdir(agent);const vault=new AccessVault();const host=new PiHost({agentDir:agent,userHome:root,dataRoot:join(root,'.dcode'),modelCredentialAdapter:{...vault,list:vault.list.bind(vault),transaction:vault.transaction.bind(vault),prompt:async()=>{throw Error('No prompt');},browser:async()=>{},notice:async()=>{}},emit:()=>{}});
 try{await host.start();for(let i=0;i<3;i++){const view=await host.handle('dcodeModels.get',{}) as DCodeModelsView;assert.ok(view.models.some(m=>m.providerId==='openai'&&m.available));assert.ok(view.models.filter(m=>m.providerId==='zai-coding-cn').every(m=>!m.available));await host.handle('dcodeAuth.get',{});}assert.equal(vault.interactive,0);assert.equal(vault.reads,1);}finally{await host.close();await rm(root,{recursive:true,force:true});}
});

test('credential replacement invalidates older shared reads without blocking the new connection',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dcode-read-replaced-'));let value:Credential={type:'api_key',key:'old-fixture'},finish:()=>void=()=>{},hold=true;
 const vault:CredentialVault={list:async()=>[{providerId:'openai',type:'api_key'}],transaction:async<T>(_id:string,fn:(v:Credential|undefined)=>Promise<{value:T;write?:Credential|null}>,_signal?:AbortSignal,options?:{interactive?:boolean})=>{const before=value;if(hold&&!options?.interactive){hold=false;await new Promise<void>(r=>{finish=r;});}const result=await fn(before);if(result.write)value=result.write;return result.value;}};
 const store=new DCodeCredentialStore(vault,join(root,'external.json'));
 try{const stale=store.read('openai');await sleep(5);await store.saveApiKey('openai','new-fixture');assert.equal((await store.read('openai') as {key:string}).key,'new-fixture');finish();await assert.rejects(stale);assert.equal(store.accessState('openai'),undefined);}finally{finish();store.close();await rm(root,{recursive:true,force:true});}
});

test('access authorization has a finite deadline and keeps the stored connection',async()=>{
 const f=await fixture(30);try{await assert.rejects(f.credentials.read('zai-coding-cn'));f.manager.authorizeAccess('zai-coding-cn','deadline');await f.manager.idle();assert.equal((await f.view()).state,'access_timeout');assert.equal(f.vault.interactive,1);assert.equal(f.vault.data.size,2);await assert.rejects(f.credentials.read('zai-coding-cn'));assert.equal(f.vault.interactive,1);}finally{await f.close();}
});
test('a directory update failure after access grant retries metadata without authorizing again',async()=>{
 const f=await fixture();let fail=true;const manager=new ModelConnections(f.credentials,{prompt:async()=>'',browser:async()=>{},notice:async()=>{}},async()=>f.runtime,async()=>{if(fail)throw Error('Metadata update failed');},()=>{});
 try{await assert.rejects(f.credentials.read('zai-coding-cn'));manager.authorizeAccess('zai-coding-cn','sync');await f.until(()=>f.vault.interactive===1);f.vault.decision(true);await manager.idle();assert.equal((await manager.get()).providers.find(p=>p.providerId==='zai-coding-cn')?.state,'sync_required');fail=false;await manager.refresh();assert.equal(f.vault.interactive,1);assert.equal(f.credentials.accessState('zai-coding-cn'),undefined);}finally{await manager.close();await f.close();}
});
test('a metadata lookup started before a save cannot hide the newly managed credential',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dcode-stale-metadata-'));let saved:Credential|undefined,finish:(items:any[])=>void=()=>{},first=true;
 const vault:CredentialVault={list:async()=>{if(first){first=false;return new Promise(r=>{finish=r;});}return saved?[{providerId:'openai',type:saved.type}]:[];},transaction:async<T>(_id:string,fn:(v:Credential|undefined)=>Promise<{value:T;write?:Credential|null}>)=>{const result=await fn(saved);if(result.write)saved=result.write;return result.value;}};
 const store=new DCodeCredentialStore(vault,join(root,'external.json'));
 try{const oldLookup=store.read('openai');await sleep(1);await store.saveApiKey('openai','new-metadata-fixture');assert.equal((await store.read('openai') as {key:string}).key,'new-metadata-fixture');finish([]);assert.equal((await oldLookup as {key:string}).key,'new-metadata-fixture');assert.equal((await store.connectionMetadata('openai')).managed,true);}finally{finish([]);store.close();await rm(root,{recursive:true,force:true});}
});

test('a confirmed missing Keychain item clears stale managed metadata without a permission prompt',async()=>{
 const f=await fixture();try{f.vault.blocked=false;await f.credentials.read('zai-coding-cn');await f.credentials.recordResponse('zai-coding-cn',f.credentials.generation('zai-coding-cn'),200);assert.equal((await f.credentials.connectionMetadata('zai-coding-cn')).verified,true);assert.equal((await f.credentials.connectionMetadata('zai-coding-cn')).managed,true);f.vault.data.delete('zai-coding-cn');assert.equal(await f.credentials.read('zai-coding-cn'),undefined);assert.equal((await f.credentials.connectionMetadata('zai-coding-cn')).managed,false);assert.equal((await f.credentials.connectionMetadata('zai-coding-cn')).verified,false);assert.notEqual((await f.view()).state,'connected');assert.equal(f.vault.interactive,0);}finally{await f.close();}
});

test('a shared background timeout is latched until explicit authorization, independently of caller cancellation',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dcode-access-timeout-'));let attempts=0,authorized=false;
 const vault:CredentialVault={list:async()=>[{providerId:'openai',type:'api_key'}],transaction:async<T>(_id:string,fn:(v:Credential|undefined)=>Promise<{value:T;write?:Credential|null}>,_signal?:AbortSignal,options?:{interactive?:boolean})=>{attempts++;if(options?.interactive)authorized=true;if(!authorized)throw authCancelled();return (await fn({type:'api_key',key:'timeout-fake-key'})).value;}};
 const store=new DCodeCredentialStore(vault,join(root,'external.json'));
 try{for(let i=0;i<3;i++)await assert.rejects(store.read('openai'),SecureCredentialError);assert.equal(attempts,1);assert.equal(store.accessState('openai'),'unavailable');await store.authorize('openai',new AbortController().signal);assert.equal((await store.read('openai'))?.type,'api_key');assert.equal(store.accessState('openai'),undefined);}finally{store.close();await rm(root,{recursive:true,force:true});}
});
test('after a successful grant the access deadline and cancel action cannot mislabel slow directory synchronization',async()=>{
 const f=await fixture();let finish:()=>void=()=>{};const changed=new Promise<void>(r=>{finish=r;});const manager=new ModelConnections(f.credentials,{prompt:async()=>'',browser:async()=>{},notice:async()=>{}},async()=>f.runtime,async()=>changed,()=>{},{timeoutMs:30});
 try{await assert.rejects(f.credentials.read('zai-coding-cn'));manager.authorizeAccess('zai-coding-cn','slow-sync');await f.until(()=>f.vault.interactive===1);f.vault.decision(true);await sleep(60);assert.equal((await manager.get()).providers.find(p=>p.providerId==='zai-coding-cn')?.state,'saving');assert.equal(manager.cancel('slow-sync').cancelled,false);finish();await manager.idle();assert.equal((await manager.get()).providers.find(p=>p.providerId==='zai-coding-cn')?.state,'configured');assert.equal(f.vault.interactive,1);}finally{finish();await manager.close();await f.close();}
});
