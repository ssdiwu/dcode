import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PiHost } from "../src/pi-host.js";
import type { FoundationSnapshot, TaskBundle } from "../src/product-store.js";

test("the desktop acceptance request reaches its bound waiting runtime and completes the task", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-accept-runtime-")), agent = join(root,"agent"), home = join(root,"home");
  await mkdir(agent); await mkdir(home);
  await writeFile(join(agent,"settings.json"), JSON.stringify({ defaultProvider:"acceptance-fixture", defaultModel:"fixture", retry:{enabled:false} }));
  await writeFile(join(agent,"models.json"), JSON.stringify({ providers:{"acceptance-fixture":{baseUrl:"https://acceptance.invalid/v1",api:"openai-completions",apiKey:"fixture-only",models:[{id:"fixture",name:"Fixture",reasoning:false,input:["text"],contextWindow:100000,maxTokens:4096}]}} }));
  const previousFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = (async (_url, init) => {
    const tool = ++calls === 1 ? { index:0,id:"ask-acceptance",type:"function",function:{name:"dcode_request_task_acceptance",arguments:JSON.stringify({prompt:"请验收这个隔离测试任务"})} } : undefined;
    if (!tool) assert.match(String(init?.body), /accepted/);
    const chunk = {id:"fixture",object:"chat.completion.chunk",created:1,model:"fixture",choices:[{index:0,delta:tool?{role:"assistant",tool_calls:[tool]}:{role:"assistant",content:"验收已完成"},finish_reason:null}]};
    const end = {...chunk,choices:[{index:0,delta:{},finish_reason:tool?"tool_calls":"stop"}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}};
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`,{headers:{"content-type":"text/event-stream"}});
  }) as typeof fetch;
  const host = new PiHost({agentDir:agent,sessionsDirectory:join(agent,"sessions"),dataRoot:join(root,".dcode"),userHome:home,emit:()=>{}});
  const snapshot = () => host.handle("foundation.snapshot",{}) as Promise<FoundationSnapshot>;
  async function until(check: (snapshot:FoundationSnapshot)=>boolean) { const end=Date.now()+12000; while (!check(await snapshot())) { if(Date.now()>end)throw new Error("Acceptance runtime did not settle"); await new Promise(resolve=>setTimeout(resolve,20)); } }
  try {
    await host.start(); const initial = await snapshot();
    const bundle = await host.handle("task.create",{requestId:"task",expectedStoreRevision:initial.storeRevision,scope:{kind:"user",userId:initial.currentUser.id},title:"验收确认",goal:"确认真正的用户验收路径"}) as TaskBundle;
    await host.handle("dcodeSession.prompt",{dcodeSessionId:bundle.coordinationSession.id,promptId:"start",message:"请求验收"});
    await until(s=>s.agentRequests.some(item=>item.kind==="task_acceptance"&&item.status==="open"));
    let s = await snapshot(); const request = s.agentRequests.find(item=>item.kind==="task_acceptance"&&item.status==="open")!;
    const input = {requestId:"accept",expectedStoreRevision:s.storeRevision,taskId:bundle.task.id,scope:bundle.task.scope,expectedTaskRevision:s.tasks.find(item=>item.id===bundle.task.id)!.revision,
      agentRequestId:request.id,expectedRequestRevision:request.revision,agentRunId:request.agentRunId,sessionRunId:request.sessionRunId,runtimeId:request.runtimeId};
    await assert.rejects(host.handle("task.acceptance",{...input,requestId:"wrong-runtime",runtimeId:"unrelated-runtime"}));
    s = await snapshot(); assert.equal(s.agentRequests.find(item=>item.id===request.id)!.status,"open");
    const result = await host.handle("task.acceptance",{...input,expectedStoreRevision:s.storeRevision}) as {deliveredToRuntime:boolean};
    assert.equal(result.deliveredToRuntime,true);
    await until(s=>s.sessionRuns.find(item=>item.id===request.sessionRunId)?.status==="completed");
    s = await snapshot(); assert.equal(s.tasks.find(item=>item.id===bundle.task.id)!.state,"completed");
    assert.deepEqual(s.agentRequests.find(item=>item.id===request.id)!.answer,{kind:"task_acceptance",outcome:"accepted"});
  } finally { await host.close(); globalThis.fetch=previousFetch; await rm(root,{recursive:true,force:true}); }
});
