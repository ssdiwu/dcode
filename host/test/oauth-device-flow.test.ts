import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import type {Credential} from '@earendil-works/pi-ai';
import {ModelConnections} from '../src/model-connections.js';
import {DCodeCredentialStore} from '../src/secure-model-credentials.js';
import {validateMethodParams} from '../src/protocol.js';

const code='WXYZ-1234';
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function fixture(timeoutMs=3000){
  const root=await mkdtemp(join(tmpdir(),'dcode-device-flow-'));
  const data=new Map<string,Credential>(),events:unknown[]=[];
  let prompts=0,notices=0,browsers=0,requests=0,complete:(response:Response)=>void=()=>{};
  const oldFetch=globalThis.fetch;
  globalThis.fetch=(async(input,init)=>{
    requests++;
    if(String(input)==='https://auth.openai.com/api/accounts/deviceauth/usercode')return Response.json({device_auth_id:'private-device-id',user_code:code,interval:0});
    if(String(input)==='https://auth.openai.com/api/accounts/deviceauth/token'){
      assert.deepEqual(JSON.parse(String(init?.body)),{device_auth_id:'private-device-id',user_code:code});
      return new Promise<Response>((resolve,reject)=>{
        const abort=()=>reject(new DOMException('Cancelled','AbortError'));
        complete=response=>{init?.signal?.removeEventListener('abort',abort);resolve(response);};
        if(init?.signal?.aborted)abort();else init?.signal?.addEventListener('abort',abort,{once:true});
      });
    }
    if(String(input)==='https://auth.openai.com/oauth/token'){
      const body=new URLSearchParams(String(init?.body));assert.equal(body.get('code'),'private-device-auth-code');assert.equal(body.get('code_verifier'),'private-device-verifier');
      return Response.json({access_token:'e30.'+Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'fixture-account'}})).toString('base64url')+'.private-device-access',refresh_token:'private-device-refresh',expires_in:3600});
    }
    throw Error('Unexpected network');
  }) as typeof fetch;
  const native={list:async()=>[...data].map(([providerId,c])=>({providerId,type:c.type})),
    transaction:async<T>(id:string,fn:(c:Credential|undefined)=>Promise<{value:T;write?:Credential|null}>)=>{const result=await fn(data.get(id));if(result.write)data.set(id,result.write);return result.value;},
    prompt:async()=>{prompts++;throw Error('No second prompt is permitted');},notice:async()=>{notices++;throw Error('No device code modal is permitted');},
    browser:async(url:string)=>{browsers++;assert.equal(url,'https://auth.openai.com/codex/device');}};
  const store=new DCodeCredentialStore(native,join(root,'external.json'));
  const runtime=await ModelRuntime.create({credentials:store,modelsPath:null,refreshOnCreate:false,allowModelNetwork:false});
  const manager=new ModelConnections(store,native,async()=>runtime,async()=>{},(event,data)=>events.push({event,data}),{timeoutMs});
  const view=async()=>(await manager.get()).providers.find(p=>p.providerId==='openai-codex')!;
  const ready=async()=>{for(let i=0;i<200;i++){if((await view()).canReadDeviceCode&&requests>=2)return;await sleep(5);}throw Error('Device code did not become ready');};
  return{manager,runtime,data,events,view,ready,get prompts(){return prompts;},get notices(){return notices;},get browsers(){return browsers;},get requests(){return requests;},
    complete:(failed=false)=>complete(failed?new Response('private-error '+code,{status:500}):Response.json({authorization_code:'private-device-auth-code',code_verifier:'private-device-verifier'})),
    close:async()=>{await manager.close();store.close();globalThis.fetch=oldFetch;await rm(root,{recursive:true,force:true});}};
}
test('two direct methods use exact SDK device flow without a selector or notice, and clear after save',async()=>{
  const f=await fixture();try{
    assert.deepEqual((await f.view()).methods,[{type:'oauth',label:'浏览器登录',oauthMode:'browser'},{type:'oauth',label:'设备码登录',oauthMode:'device_code'}]);
    await f.manager.start('openai-codex','oauth','device','device_code');await f.ready();
    const display=f.manager.readDeviceCode('device');assert.equal(display?.userCode,code);assert.ok(display!.expiresAt>Date.now());
    assert.equal(f.manager.readDeviceCode('wrong'),null);assert.equal(f.prompts,0);assert.equal(f.notices,0);assert.equal(f.browsers,1);assert.equal((await f.view()).canEnterCode,false);
    assert.deepEqual(await f.manager.start('openai-codex','oauth','device','device_code'),{flowId:'device',accepted:false});
    f.complete();await f.manager.idle();assert.equal((await f.view()).state,'connected');assert.equal(f.data.size,1);assert.equal(f.manager.readDeviceCode('device'),null);assert.equal((await f.view()).canReadDeviceCode,false);
    const publicOutput=JSON.stringify({events:f.events,view:await f.view()});
    for(const secret of [code,'private-device-id','private-device-refresh','private-device-auth-code','private-device-verifier','https://'])assert.ok(!publicOutput.includes(secret));
  }finally{await f.close();}
});
test('cancel, timeout, failure and delayed polling results never revive or retain a device code',async()=>{
  for(const outcome of ['cancel','timeout','failure']){
    const f=await fixture(outcome==='timeout'?200:3000);try{
      await f.manager.start('openai-codex','oauth',outcome,'device_code');await f.ready();
      if(outcome==='cancel'){f.manager.cancel(outcome);assert.equal(f.manager.readDeviceCode(outcome),null);}
      if(outcome==='failure')f.complete(true);
      await f.manager.idle();f.complete();await sleep(5);
      assert.equal(f.manager.readDeviceCode(outcome),null);assert.equal(f.data.size,0);assert.equal((await f.view()).state,outcome==='cancel'?'cancelled':outcome==='timeout'?'timed_out':'failed');
      assert.ok(!JSON.stringify({events:f.events,view:await f.view()}).includes(code));
    }finally{await f.close();}
  }
});
test('OAuth mode is restricted to OpenAI Codex and public control rejects private display fields',async()=>{
  for(const oauthMode of ['browser','device_code'])validateMethodParams('dcodeAuth.start',{providerId:'openai-codex',authType:'oauth',flowId:'direct',oauthMode});
  for(const bad of [{providerId:'anthropic',oauthMode:'browser'},{providerId:'openai-codex',oauthMode:'other'},{providerId:'openai-codex',userCode:code},{providerId:'openai-codex',display:{userCode:code}}]){
    assert.throws(()=>validateMethodParams('dcodeAuth.start',{authType:'oauth',flowId:'invalid',...bad}));
  }
  const f=await fixture();try{
    await assert.rejects(f.manager.start('anthropic','oauth','other','device_code'));assert.equal(f.requests,0);
    const base=f.runtime.getProvider('openai-codex')!;
    f.runtime.registerNativeProvider({...base,auth:{oauth:{...base.auth.oauth!,login:async interaction=>{
      await interaction.prompt({type:'select',message:'Select OpenAI Codex login method:',options:[{id:'changed',label:'Changed'}]});throw Error('Must reject changed SDK choices');
    }}}});
    await f.manager.start('openai-codex','oauth','invalid-choices','device_code');await f.manager.idle();assert.equal((await f.view()).state,'failed');assert.equal(f.prompts,0);assert.equal(f.requests,0);
  }finally{await f.close();}
});
