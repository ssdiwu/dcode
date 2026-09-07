import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,readFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {PiHost} from "../src/pi-host.js";
import type {DCodeModelsView} from "../src/model-catalog-view.js";
import {getBuiltinModelDataGeneratedAt} from "@earendil-works/pi-ai/providers/all";
import type {FoundationSnapshot} from "../src/product-store.js";

test("online model refresh reaches native selection and survives restart without replacing custom providers or Pi settings",async()=>{
  const root=await mkdtemp(join(tmpdir(),"dcode-catalog-refresh-"));
  const agent=join(root,"agent"),home=join(root,"home");
  await mkdir(agent);await mkdir(home);
  const settings=JSON.stringify({defaultProvider:"openai",defaultModel:"gpt-5.5"});
  const providers=JSON.stringify({providers:{openai:{baseUrl:"https://catalog-test.invalid/v1",apiKey:"fixture-private-value"}}});
  await writeFile(join(agent,"settings.json"),settings);await writeFile(join(agent,"models.json"),providers);
  const options={agentDir:agent,sessionsDirectory:join(agent,"sessions"),dataRoot:join(root,".dcode"),userHome:home,emit:()=>{}};
  let host=new PiHost(options);const originalFetch=globalThis.fetch;
  const priorKey=process.env.DCODE_UNUSED_CATALOG_FIXTURE;process.env.DCODE_UNUSED_CATALOG_FIXTURE="fixture-only";
  globalThis.fetch=async input=>{
    assert.match(String(input),/^https:\/\/pi.dev\/api\/models\/providers\//);
    const models=String(input).endsWith("/openai")?[{id:"catalog-update-fixture",name:"Updated catalog model",provider:"openai",api:"openai-responses",baseUrl:"https://api.openai.com/v1",contextWindow:372000,maxTokens:128000,reasoning:true,input:["text","image"],cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]:[];
    return new Response(JSON.stringify(models),{headers:{"content-type":"application/json","last-modified":new Date((getBuiltinModelDataGeneratedAt()??Date.now())+1000).toUTCString()}});
  };
  try {
    await host.start();
    const initial=await host.handle("dcodeModels.get",{}) as DCodeModelsView;
    assert.equal(initial.models.some(m=>m.modelId==="catalog-update-fixture"),false);
    const snapshot=()=>host.handle("foundation.snapshot",{}) as Promise<FoundationSnapshot>;
    await host.handle("dcodeModelProvider.save",{requestId:"custom-provider",expectedStoreRevision:(await snapshot()).storeRevision,provider:{id:"retained-custom",name:"Retained custom",baseUrl:"https://retained.invalid/v1",apiKind:"openai-completions",credentialEnv:"DCODE_UNUSED_CATALOG_FIXTURE",models:[{modelId:"retained",name:"Retained model",reasoning:false,contextWindow:8192,maxTokens:1024}]}});
    const updated=await host.handle("dcodeModels.refresh",{force:true}) as DCodeModelsView;
    assert.ok(updated.models.find(m=>m.modelId==="catalog-update-fixture")?.available);
    assert.equal(updated.refresh.failedProviders.length,0);
    assert.ok(updated.refresh.updatedAt);
    assert.ok((await snapshot()).modelProviders.find(p=>p.id==="retained-custom"));
    assert.ok(!JSON.stringify(updated).includes("fixture-private-value"));
    await host.handle("dcodeModels.select",{requestId:"choose-fresh",expectedStoreRevision:(await snapshot()).storeRevision,providerId:"openai",modelId:"catalog-update-fixture"});
    assert.equal((await host.handle("dcodeModels.get",{}) as DCodeModelsView).defaultKey,"openai::catalog-update-fixture");
    await assert.rejects(host.handle("dcodeModels.select",{requestId:"missing-session",expectedStoreRevision:(await snapshot()).storeRevision,dcodeSessionId:"missing",providerId:"openai",modelId:"gpt-5.5"}),/会话不存在/);
    await host.handle("dcodeModels.get",{});
    await host.handle("dcodeModelProvider.remove",{requestId:"remove-custom",expectedStoreRevision:(await snapshot()).storeRevision,providerId:"retained-custom"});
    await host.handle("dcodeModels.refresh",{force:true});
    assert.equal((await snapshot()).modelProviders.some(p=>p.id==="retained-custom"),false);
    await host.close();host=new PiHost(options);await host.start();
    const restored=await host.handle("dcodeModels.get",{}) as DCodeModelsView;
    assert.equal(restored.providers.some(p=>p.id==="retained-custom"),false);
    assert.equal(restored.defaultKey,"openai::catalog-update-fixture");
    assert.ok(restored.models.find(m=>m.modelId==="catalog-update-fixture")?.available);
    assert.equal(await readFile(join(agent,"settings.json"),"utf8"),settings);
    assert.equal(await readFile(join(agent,"models.json"),"utf8"),providers);
    await assert.rejects(readFile(join(agent,"models-store.json")),{code:"ENOENT"});
  } finally {await host.close();globalThis.fetch=originalFetch;if(priorKey===undefined)delete process.env.DCODE_UNUSED_CATALOG_FIXTURE;else process.env.DCODE_UNUSED_CATALOG_FIXTURE=priorKey;await rm(root,{recursive:true,force:true});}
});
