import test from 'node:test';
import assert from 'node:assert/strict';
import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import type { AnyModel, Credential, ClassifierOptions } from '@earendil-works/pi-ai';
import { confirmTypedAuth } from '../../src/adapters/pi/typed-auth.ts';
import { NO_AMBIENT_CONTEXT, registerPresetProviders } from '../../src/adapters/pi/preset-providers.ts';

for (const mode of ['api_key', 'oauth'] as const) await test(`classifier当次${mode}认证只读复核：原身份通过，等待期间改凭据不回退旧key`, async () => {
  const preset = registerPresetProviders().find(one => one.id === 'openrouter')!;
  const model = preset.provider.getAllModels!().find(one => one.type === 'classifier')!;
  const store = new InMemoryCredentialStore();
  const credential = (key: string): Credential => mode === 'api_key' ? { type: mode, key } : { type: mode, access: key, refresh: '', expires: Number.MAX_SAFE_INTEGER };
  await store.modify(preset.id, async () => credential('isolated-A'));
  const client = createModels({ credentials: store, authContext: NO_AMBIENT_CONTEXT }); client.setProvider(preset.provider);
  const original = await client.getAuth(model); assert.ok(original);
  const prepared = original.auth.baseUrl ? { ...model, baseUrl: original.auth.baseUrl } : model;
  const options: ClassifierOptions = { apiKey: original.auth.apiKey, headers: original.auth.headers, env: original.env };
  assert.equal(await confirmTypedAuth(preset.provider, store, model, prepared, options), true);
  await store.modify(preset.id, async () => credential('isolated-B'));
  assert.equal(await confirmTypedAuth(preset.provider, store, model, prepared, options), false);
  assert.equal((await store.read(preset.id))?.type, mode);
});

await test('classifier只读核验在OAuth modify callback前拒绝，不refresh、不写档或读取ambient', async () => {
  let refreshed = 0, written = 0;
  const model: AnyModel = { type:'classifier',provider:'readonly-oauth',id:'classifier',name:'classifier',api:'typesafe-system-one',
    baseUrl:'http://127.0.0.1/unused',input:['text'],contextWindow:1024,cost:{input:0,output:0,cacheRead:0,cacheWrite:0} };
  const expired: Credential = { type:'oauth',access:'expired',refresh:'isolated',expires:0 };
  const store = { read: async () => expired, list: async () => [{ providerId:model.provider,type:'oauth' as const }],
    modify: async () => { written++;return expired; },delete:async()=>{written++;} };
  const provider = createProvider({ id:model.provider,name:'readonly',models:[model],
    classifiers:{ 'typesafe-system-one':{ classify:async()=>{throw new Error('checker must not dispatch');} } },
    auth:{ oauth:{name:'readonly',login:async()=>expired,refresh:async()=>{refreshed++;return expired;},toAuth:async credential=>({apiKey:credential.access})} } });
  assert.equal(await confirmTypedAuth(provider,store,model,model,{apiKey:'expired'}),false);
  assert.equal(refreshed,0);assert.equal(written,0);
});

await test('classifier认证比对涵盖有效headers/env/endpoint，大小写或空头仅按实际合并语义规范化', async () => {
  const model: AnyModel = { type:'classifier',provider:'typed-auth-fields',id:'one',name:'one',api:'typesafe-system-one',
    baseUrl:'http://127.0.0.1/unused',input:['text'],contextWindow:1024,cost:{input:0,output:0,cacheRead:0,cacheWrite:0} };
  const store=new InMemoryCredentialStore(); await store.modify(model.provider,async()=>({type:'api_key',key:'isolated'}));
  const provider=createProvider({ id:model.provider,name:'fields',models:[model],classifiers:{'typesafe-system-one':{classify:async()=>{throw new Error('No dispatch from checker');}}},
    auth:{apiKey:{name:'fields',resolve:async()=>({auth:{apiKey:'isolated',headers:{'X-Account':'one'},baseUrl:'http://127.0.0.1/actual'},env:{ACCOUNT:'one'}})}} });
  const prepared={...model,baseUrl:'http://127.0.0.1/actual'};
  const options={apiKey:'isolated',headers:{'x-account':'one'},env:{ACCOUNT:'one'}};
  assert.equal(await confirmTypedAuth(provider,store,model,prepared,options),true);
  assert.equal(await confirmTypedAuth(provider,store,model,prepared,{...options,headers:{'x-account':'other'}}),false);
  assert.equal(await confirmTypedAuth(provider,store,model,prepared,{...options,env:{ACCOUNT:'other'}}),false);
  assert.equal(await confirmTypedAuth(provider,store,model,{...prepared,baseUrl:model.baseUrl},options),false);
});
