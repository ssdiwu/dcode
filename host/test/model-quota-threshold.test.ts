import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,mkdir,writeFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {assessModelQuota,type ModelQuotaSnapshot,type QuotaAssessment} from "../src/model-quota.js";
import {chooseAgentModel} from "../src/model-route.js";
import {PiHost} from "../src/pi-host.js";
import {validateMethodParams} from "../src/protocol.js";
import type {FoundationSnapshot,ClientPreferences,TaskBundle} from "../src/product-store.js";
import type {DCodeModelsView} from "../src/model-catalog-view.js";
const now=1_800_000_000_000;
const snapshot=(remaining:number|null):ModelQuotaSnapshot=>({providerId:"fixture",poolId:"same-pool",status:"known",fetchedAt:now,validUntil:now+60_000,groups:[{id:"general",label:"通用",windows:[{id:"short",label:"短期",remainingPercent:remaining,resetAt:now+1000,capability:"text"}]}]});

test("every permitted integer threshold compares raw percentages, equality skips and invalid policy is rejected",()=>{
  for(let threshold=1;threshold<=30;threshold++){
    assert.equal(assessModelQuota(snapshot(threshold),"model",now,threshold).eligible,false);
    assert.equal(assessModelQuota(snapshot(threshold-.01),"model",now,threshold).eligible,false);
    assert.equal(assessModelQuota(snapshot(threshold+.01),"model",now,threshold).eligible,true);
  }
  for(const value of [0,31,-1,1.1,NaN,Infinity,"20",null,{},[]])assert.throws(()=>assessModelQuota(snapshot(80),"model",now,value as number),/1至30/);
  for(const threshold of [1,20,30]){
    assert.equal(assessModelQuota(snapshot(null),"model",now,threshold).eligible,false);
    assert.equal(assessModelQuota({...snapshot(80),status:"unknown"},"model",now,threshold).eligible,false);
    assert.equal(assessModelQuota(snapshot(80),"model",now+60_000,threshold).eligible,false);
  }
});
test("retry time uses all windows blocked by the chosen threshold",()=>{
  const data=snapshot(1);data.groups[0]!.windows.push({id:"long",label:"长期",remainingPercent:15,resetAt:now+100_000,capability:"text"});
  assert.equal(assessModelQuota(data,"model",now,1).retryAt,now+1000);
  assert.equal(assessModelQuota(data,"model",now,20).retryAt,now+100_000);
});
test("a configurable threshold preserves shared-pool filtering and member order without choosing the largest balance",async()=>{
  const models=[{providerId:"shared",modelId:"a"},{providerId:"shared",modelId:"b"},{providerId:"next",modelId:"c"},{providerId:"largest",modelId:"d"}].map(model=>({...model,enabled:true,available:true}));
  const queries:string[]=[];
  const quotas={get:async(provider:string)=>{queries.push(provider);return {...snapshot(provider==="shared"?20:provider==="next"?20.01:99),poolId:provider};}};
  const result=await chooseAgentModel({candidates:models,models,quotas,thresholdPercent:20,now:()=>now});
  assert.equal(result.selected?.modelId,"c");assert.deepEqual(queries,["shared","next"]);
  assert.deepEqual(result.considered.slice(0,2).map(item=>item.reason),["剩余额度不高于 20%","剩余额度不高于 20%"]);
  const ordinary=snapshot(90);ordinary.groups.push({id:"special",label:"专属",modelIds:["a"],windows:[{id:"special-window",label:"专属",remainingPercent:20,resetAt:now+1000,capability:"text"}]});
  assert.equal(assessModelQuota(ordinary,"a",now,20).eligible,false);assert.equal(assessModelQuota(ordinary,"b",now,20).eligible,true);
});

async function fixture(){
  const root=await mkdtemp(join(tmpdir(),"dcode-quota-setting-")),agent=join(root,"agent"),home=join(root,"home");await mkdir(agent);await mkdir(home);
  await writeFile(join(agent,"settings.json"),JSON.stringify({defaultProvider:"minimax-cn",defaultModel:"threshold-fixture"}));
  await writeFile(join(agent,"models.json"),JSON.stringify({providers:{"minimax-cn":{baseUrl:"https://api.minimaxi.com/v1",api:"openai-completions",apiKey:"quota-threshold-fixture-key",models:[{id:"threshold-fixture",name:"Threshold fixture",reasoning:false,input:["text"],contextWindow:128000,maxTokens:4096}]}}}));
  const options={agentDir:agent,dataRoot:join(root,".dcode"),userHome:home,emit:()=>{},leaseQuietWindowMs:1};
  let host=new PiHost(options),serial=0;
  const snap=()=>host.handle("foundation.snapshot",{}) as Promise<FoundationSnapshot>;
  const set=async(value:unknown)=>host.handle("clientPreferences.set",{requestId:`threshold-${++serial}`,expectedStoreRevision:(await snap()).storeRevision,modelQuotaThresholdPercent:value});
  return {get host(){return host;},snap,set,root,async restart(){await host.close();host=new PiHost(options);await host.start();},async close(){await host.close();await rm(root,{recursive:true,force:true});}};
}
const quotaResponse=()=>Response.json({base_resp:{status_code:0},model_remains:[{model_name:"general",current_interval_remaining_percent:20,current_weekly_remaining_percent:80,end_time:Date.now()+3600_000,weekly_end_time:Date.now()+604800_000}]});
interface QuotaView {modelQuotaThresholdPercent:number;snapshots:ModelQuotaSnapshot[];assessments:Array<QuotaAssessment&{providerId:string;modelId:string}>}

test("Host persists the threshold, re-evaluates cached quotas immediately, restores on restart and rejects invalid input",async()=>{
  const f=await fixture(),originalFetch=globalThis.fetch;let queries=0;
  globalThis.fetch=(async(url)=>{assert.equal(String(url),"https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains");queries++;return quotaResponse();}) as typeof fetch;
  const quotas=()=>f.host.handle("dcodeModels.quotas",{providerIds:["minimax-cn"]}) as Promise<QuotaView>;
  try{
    await f.host.start();assert.equal((await f.host.handle("clientPreferences.get",{}) as ClientPreferences).modelQuotaThresholdPercent,1);
    const first=await quotas();assert.equal(first.modelQuotaThresholdPercent,1);assert.ok(first.assessments.every(item=>item.eligible));
    for(const threshold of [30,20,19]){
      await f.set(threshold);const result=await quotas();
      assert.equal(result.modelQuotaThresholdPercent,threshold);assert.equal(result.assessments[0]?.eligible,threshold<20);
      assert.equal(result.snapshots[0]?.fetchedAt,first.snapshots[0]?.fetchedAt);
      assert.equal((await f.host.handle("dcodeModels.get",{}) as DCodeModelsView).modelQuotaThresholdPercent,threshold);
    }
    assert.equal(queries,1,"changing the rule does not fabricate or discard a fresh quota snapshot");
    for(const value of [0,31,1.5,"20",null,NaN,Infinity,{},[]]){
      const params={requestId:`invalid-${String(value)}`,expectedStoreRevision:(await f.snap()).storeRevision,modelQuotaThresholdPercent:value};
      assert.throws(()=>validateMethodParams("clientPreferences.set",params),/integer/);
      await assert.rejects(f.set(value),/1至30/);
      assert.equal((await f.host.handle("clientPreferences.get",{}) as ClientPreferences).modelQuotaThresholdPercent,19);
    }
    await f.set(30);await f.restart();
    assert.equal((await f.host.handle("clientPreferences.get",{}) as ClientPreferences).modelQuotaThresholdPercent,30);
    assert.equal((await quotas()).assessments[0]?.eligible,false);
  }finally{globalThis.fetch=originalFetch;await f.close();}
});

test("raising the threshold does not abort an already dispatched model request",async()=>{
  const f=await fixture(),originalFetch=globalThis.fetch;
  let release:(r:Response)=>void=()=>{},started:()=>void=()=>{},requestSignal:AbortSignal|undefined;
  const entered=new Promise<void>(resolve=>{started=resolve;});
  globalThis.fetch=(async(url,init)=>{if(String(url).endsWith("/remains"))return quotaResponse();requestSignal=init?.signal??undefined;started();return new Promise<Response>(resolve=>{release=resolve;});}) as typeof fetch;
  try{
    await f.host.start();const snapshot=await f.snap();const task=await f.host.handle("task.create",{requestId:"inflight-task",expectedStoreRevision:snapshot.storeRevision,scope:{kind:"user",userId:snapshot.currentUser.id},title:"在途请求",goal:"验证改变门槛不中断"}) as TaskBundle;
    await f.host.handle("dcodeSession.prompt",{dcodeSessionId:task.coordinationSession.id,promptId:"inflight-prompt",message:"开始受控请求"});
    await Promise.race([entered,new Promise((_,reject)=>setTimeout(()=>reject(Error("request did not start")),8000).unref())]);
    await f.set(30);assert.equal(requestSignal?.aborted,false);
    release(new Response('data: '+JSON.stringify({id:"quota-inflight",object:"chat.completion.chunk",model:"threshold-fixture",choices:[{index:0,delta:{role:"assistant",content:"已完成"},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({id:"quota-inflight",object:"chat.completion.chunk",choices:[{index:0,delta:{},finish_reason:"stop"}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})+'\n\ndata: [DONE]\n\n',{headers:{"content-type":"text/event-stream"}}));
    let finished=false;for(let i=0;i<500;i++){if((await f.snap()).sessionRuns[0]?.status==="completed"){finished=true;break;}await new Promise(r=>setTimeout(r,10));}
    assert.equal(finished,true);assert.equal(requestSignal?.aborted,false);
  }finally{globalThis.fetch=originalFetch;await f.close();}
});

function completion(content:string,tool?:unknown){
  const chunk={id:"threshold-team",object:"chat.completion.chunk",created:1,model:"fixture",choices:[{index:0,delta:tool?{role:"assistant",tool_calls:[tool]}:{role:"assistant",content},finish_reason:null}]};
  const end={...chunk,choices:[{index:0,delta:{},finish_reason:tool?"tool_calls":"stop"}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}};
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`,{headers:{"content-type":"text/event-stream"}});
}
test("team precheck and paused member retry each use the latest threshold without automatic replay or new member identity",async()=>{
  const root=await mkdtemp(join(tmpdir(),"dcode-quota-team-")),agent=join(root,"agent"),home=join(root,"home");await mkdir(agent);await mkdir(home);
  const model={id:"fixture",name:"Fixture",reasoning:false,input:["text"],contextWindow:128000,maxTokens:4096};
  await writeFile(join(agent,"settings.json"),JSON.stringify({defaultProvider:"zai-coding-cn",defaultModel:"fixture"}));
  await writeFile(join(agent,"models.json"),JSON.stringify({providers:{"zai-coding-cn":{baseUrl:"https://open.bigmodel.cn/api/paas/v4",api:"openai-completions",apiKey:"quota-team-fixture-key",models:[model]},"minimax-cn":{baseUrl:"https://api.minimaxi.com/v1",api:"openai-completions",apiKey:"quota-team-fixture-key",models:[model]}}}));
  let delegateNext=true,members=0,release:()=>void=()=>{};const hold=new Promise<void>(resolve=>{release=resolve;});
  const previousFetch=globalThis.fetch;
  globalThis.fetch=(async(url,init)=>{
    if(String(url).includes("quota/limit"))return Response.json({success:true,code:200,data:{limits:[{type:"TOKENS_LIMIT",percentage:20,nextResetTime:Date.now()+3600000}]}});
    if(String(url).endsWith("/remains"))return quotaResponse();
    const body=JSON.parse(String(init?.body)),system=body.messages.find((m:{role:string})=>m.role==="system")?.content??"";
    if(system.includes("coordinator Agent")){
      if(delegateNext){delegateNext=false;return completion("",{index:0,id:"threshold-delegate",type:"function",function:{name:"dcode_team",arguments:JSON.stringify({action:"delegate",members:[{profileId:"builtin-explore",title:"阈值成员",instruction:"处理测试材料",acceptance:"返回结论"}]})}});}
      return completion("协调者已响应");
    }
    members++;if(members===1)await hold;return completion("成员已完成");
  }) as typeof fetch;
  const host=new PiHost({agentDir:agent,dataRoot:join(root,".dcode"),userHome:home,emit:()=>{},agentIdleTimeoutMs:1000,leaseQuietWindowMs:1});
  const snapshot=()=>host.handle("foundation.snapshot",{}) as Promise<FoundationSnapshot>;
  let serial=0;const set=async(value:number)=>host.handle("clientPreferences.set",{requestId:`team-threshold-${++serial}`,expectedStoreRevision:(await snapshot()).storeRevision,modelQuotaThresholdPercent:value});
  const until=async(check:()=>Promise<boolean>,label:string)=>{for(let i=0;i<600;i++){if(await check())return;await new Promise(r=>setTimeout(r,20));}throw Error(label);};
  try{
    await host.start();let snap=await snapshot();const profile=snap.agentProfiles.find(p=>p.id==="builtin-explore")!;
    await host.handle("agentProfile.update",{requestId:"member-route",expectedStoreRevision:snap.storeRevision,profileId:profile.id,expectedProfileRevision:profile.revision,name:profile.name,roleContract:profile.roleContract,enabled:true,modelCandidates:[{providerId:"minimax-cn",modelId:"fixture"}]});
    await set(30);snap=await snapshot();const task=await host.handle("task.create",{requestId:"threshold-team",expectedStoreRevision:snap.storeRevision,scope:{kind:"user",userId:snap.currentUser.id},title:"门槛派发验证",goal:"先阻塞再继续"}) as TaskBundle;
    await host.handle("dcodeSession.prompt",{dcodeSessionId:task.coordinationSession.id,promptId:"blocked-dispatch",message:"派发一次工作"});
    await until(async()=>(await snapshot()).sessionRuns.some(run=>run.sessionId===task.coordinationSession.id&&run.status==="completed"),"initial coordinator completion");
    assert.equal((await snapshot()).agentRuns.filter(run=>run.role!=="coordinator").length,0);assert.equal(members,0);
    await set(19);delegateNext=true;
    await host.handle("dcodeSession.prompt",{dcodeSessionId:task.coordinationSession.id,promptId:"allowed-dispatch",message:"按现在的门槛再派发"});
    await until(async()=>members===1,"member started after lower threshold");
    await until(async()=>!(await snapshot()).sessionRuns.some(run=>run.sessionId===task.coordinationSession.id&&run.status==="running"),"coordinator idle");
    const member=(await snapshot()).agentRuns.find(run=>run.role!=="coordinator")!;
    await set(20);
    await host.handle("dcodeSession.prompt",{dcodeSessionId:task.coordinationSession.id,targetAgentRunId:member.id,promptId:"queued-followup",message:"排队的第二项工作"});
    release();
    await until(async()=>(await snapshot()).collaborationMessages?.some(message=>message.text==="排队的第二项工作"&&message.state==="paused")??false,"queued work uses raised threshold");
    const paused=(await snapshot()).collaborationMessages!.find(message=>message.text==="排队的第二项工作")!;assert.match(paused.error??"",/20%/);assert.equal(members,1);
    await set(19);await new Promise(r=>setTimeout(r,80));assert.equal(members,1,"settings must not replay paused work");
    await host.handle("collaboration.messageControl",{requestId:"resume-same-message",id:paused.id,expectedRevision:paused.revision,state:"queued"});
    await until(async()=>(await snapshot()).collaborationMessages?.some(message=>message.id===paused.id&&message.state==="completed")??false,"explicit retry uses lower threshold");
    const final=await snapshot();assert.equal(members,2);assert.equal(final.agentRuns.filter(run=>run.role!=="coordinator").length,1);assert.equal(final.collaborationMessages!.find(message=>message.id===paused.id)?.targetAgentRunId,member.id);
  }finally{release();await host.close();globalThis.fetch=previousFetch;await rm(root,{recursive:true,force:true});}
});
