import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PiHost } from "../src/pi-host.js";
import type { FoundationSnapshot, TaskBundle } from "../src/product-store.js";

async function until(check:()=>Promise<boolean>,label:string) {
  const deadline=Date.now()+12000;
  while(!await check()) { if(Date.now()>deadline)throw new Error(`Timed out: ${label}`); await new Promise(resolve=>setTimeout(resolve,20)); }
}
function completion(content:string,tool?:unknown) {
  const chunk={id:"fixture",object:"chat.completion.chunk",created:1,model:"fixture",choices:[{index:0,delta:tool?{role:"assistant",tool_calls:[tool]}:{role:"assistant",content},finish_reason:null}]};
  const end={...chunk,choices:[{index:0,delta:{},finish_reason:tool?"tool_calls":"stop"}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}};
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`,{headers:{"content-type":"text/event-stream"}});
}

test("coordinator tool dispatches independent members, routes main mentions, and stays available during member work",async()=>{
  const root=await mkdtemp(join(tmpdir(),"dcode-adaptive-"));const agent=join(root,"agent"),home=join(root,"home");
  await mkdir(agent);await mkdir(home);
  await writeFile(join(agent,"settings.json"),JSON.stringify({defaultProvider:"zai-coding-cn",defaultModel:"fixture"}));
  const model={id:"fixture",name:"Fixture",reasoning:false,input:["text"],contextWindow:100000,maxTokens:4096};
  await writeFile(join(agent,"models.json"),JSON.stringify({providers:{"zai-coding-cn":{baseUrl:"https://open.bigmodel.cn/api/paas/v4",api:"openai-completions",apiKey:"fixture-only",models:[model]},"minimax-cn":{baseUrl:"https://api.minimaxi.com/v1",api:"openai-completions",apiKey:"fixture-only",models:[model]}}}));
  const previousFetch=globalThis.fetch;let coordinators=0,members=0;const requests:Record<string,unknown>[]=[];const quotaRequests:string[]=[];
  let release!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve;});
  globalThis.fetch=(async(url,init)=>{
    const endpoint=String(url);
    if(endpoint.includes("quota/limit")){quotaRequests.push("zai");return Response.json({success:true,code:200,data:{limits:[{type:"TOKENS_LIMIT",percentage:98,nextResetTime:Date.now()+3600000}]}});}
    if(endpoint.includes("coding_plan/remains")){quotaRequests.push("minimax");return Response.json({base_resp:{status_code:0},model_remains:[{model_name:"general",current_interval_remaining_percent:1,current_weekly_remaining_percent:80,end_time:Date.now()+3600000,weekly_end_time:Date.now()+604800000}]});}
    const body=JSON.parse(String(init?.body));requests.push(body);
    const system=body.messages.find((m:{role:string})=>m.role==="system")?.content??"";
    if(system.includes("coordinator Agent")) {
      coordinators++;
      assert.ok(body.tools.some((tool:{function:{name:string}})=>tool.function.name==="dcode_team"));
      if(coordinators===1)return completion("",{index:0,id:"simple-write",type:"function",function:{name:"write",arguments:JSON.stringify({path:"result.md",content:"由主智能体完成的小工作"})}});
      if(coordinators===2||coordinators===3)return completion("",{index:0,id:"delegate-first",type:"function",function:{name:"dcode_team",arguments:JSON.stringify({action:"delegate",members:[{profileId:"builtin-explore",title:"调研",instruction:"检查材料",acceptance:"提供证据"},{profileId:"builtin-verifier",title:"核验",instruction:"独立核查",acceptance:"说明验证边界"}]})}});
      if(coordinators===5)return completion("",{index:0,id:"delegate-later",type:"function",function:{name:"dcode_team",arguments:JSON.stringify({action:"delegate",members:[{profileId:"builtin-explore",title:"补充调查",instruction:"另一项独立工作",acceptance:"返回来源"}]})}});
      return completion("协调者继续回应");
    }
    assert.ok(!body.tools.some((tool:{function:{name:string}})=>tool.function.name==="dcode_team"));
    members++;if(members<=2)await hold;
    return completion("成员提供了验证结果");
  }) as typeof fetch;
  const errors:unknown[]=[];
  const host=new PiHost({agentDir:agent,sessionsDirectory:join(agent,"sessions"),dataRoot:join(root,".dcode"),userHome:home,agentIdleTimeoutMs:1000,emit:(event,data)=>{if(/failed|error/i.test(event))errors.push({event,data});}});
  const snapshot=()=>host.handle("foundation.snapshot",{}) as Promise<FoundationSnapshot>;
  try{
    await host.start();
    let snap=await snapshot();
    for(const profileId of ["builtin-explore","builtin-verifier"]){const profile=snap.agentProfiles.find(p=>p.id===profileId)!;await host.handle("agentProfile.update",{requestId:`route-${profileId}`,expectedStoreRevision:snap.storeRevision,profileId,expectedProfileRevision:profile.revision,name:profile.name,roleContract:profile.roleContract,enabled:true,modelCandidates:[{providerId:"minimax-cn",modelId:"fixture"},{providerId:"zai-coding-cn",modelId:"fixture"}]});snap=await snapshot();}
    const task=await host.handle("task.create",{requestId:"task",expectedStoreRevision:snap.storeRevision,scope:{kind:"user",userId:snap.currentUser.id},title:"协作验证",goal:"持续交流与并行执行"}) as TaskBundle;
    await host.handle("taskWorkbenchViewState.patch",{requestId:"select",expectedStoreRevision:(await snapshot()).storeRevision,expectedViewStateRevision:0,patch:{selection:{taskId:task.task.id,sessionId:task.coordinationSession.id}}});
    await host.handle("dcodeSession.prompt",{dcodeSessionId:task.coordinationSession.id,promptId:"first",message:"启动工作"});
    await until(async()=>members===2,"two background members");
    assert.equal(await readFile(join(home,"result.md"),"utf8"),"由主智能体完成的小工作");
    snap=await snapshot();const children=snap.agentRuns.filter(run=>run.role!=="coordinator");assert.equal(children.length,2);assert.ok(children.every(run=>run.modelProvider==="zai-coding-cn"));assert.ok(quotaRequests.includes("minimax"));
    const live=await host.handle("runtime.list",{}) as {runtimes:Array<{identity:{agentRunId:string};state:{process:{pid:number}}}>};
    const pids=live.runtimes.filter(run=>children.some(child=>child.id===run.identity.agentRunId)).map(run=>run.state.process.pid);assert.equal(new Set(pids).size,2);assert.ok(pids.every(pid=>pid!==process.pid));
    await until(async()=>!(await snapshot()).sessionRuns.some(run=>run.sessionId===task.coordinationSession.id&&run.status==="running"),"coordinator free");
    await host.handle("dcodeSession.prompt",{dcodeSessionId:task.coordinationSession.id,promptId:"while-working",message:"继续聊新要求"});
    await until(async()=>coordinators>=5,"coordinator replies while members still blocked");
    await until(async()=>(await snapshot()).agentRuns.filter(run=>run.role!=="coordinator").length===3,"add a member while the first team is active");
    const directed=await host.handle("dcodeSession.prompt",{dcodeSessionId:task.coordinationSession.id,targetAgentRunId:children[0]!.id,promptId:"directed",message:"请补充时间说明"}) as {queued:boolean};assert.equal(directed.queued,true);
    await assert.rejects(host.handle("dcodeSession.prompt",{dcodeSessionId:task.coordinationSession.id,targetAgentRunId:"nonexistent",promptId:"unknown",message:"不能创建"}),/已创建/);
    release();
    try {await until(async()=>(await snapshot()).collaborationMessages?.some(message=>message.text==="请补充时间说明"&&message.state==="completed")??false,"directed reply returns to main");}
    catch(error){console.error(JSON.stringify({errors,messages:(await snapshot()).collaborationMessages},null,2));throw error;}
    await until(async()=>(await snapshot()).collaborationMessages?.filter(message=>message.author==="coordinator"&&message.text.includes("验收要求")).length===3,"later member receives its assignment");
    await until(async()=>!(await snapshot()).collaborationMessages?.some(message=>["queued","delivering"].includes(message.state)),"all queued responses settle before shutdown");
    snap=await snapshot();const directedMessage=snap.collaborationMessages!.find(message=>message.text==="请补充时间说明")!;
    assert.equal(directedMessage.sourceSessionId,task.coordinationSession.id);assert.equal(directedMessage.targetAgentRunId,children[0]!.id);assert.equal(directedMessage.reply,"成员提供了验证结果");
    assert.ok(snap.events.some(event=>event.kind==="agentProcess.changed"));
    assert.equal(snap.tasks.length,1);
    const db=new DatabaseSync(join(root,".dcode","product-store.sqlite3"),{readOnly:true});
    try {
      const raw=(id:string)=>db.prepare("SELECT submitted_text FROM raw_inputs WHERE id=?").get(id) as {submitted_text:string};
      const delegated=snap.collaborationMessages!.filter(message=>message.author==="coordinator"&&message.text.includes("验收要求"));
      assert.equal(delegated.length,3,"a repeated delegate call reuses original members; a later call adds one");
      for(const message of delegated.filter(message=>message.text!=="另一项独立工作\n\n验收要求：返回来源")) assert.equal(raw(message.originRawInputId).submitted_text,"启动工作");
      for(const message of snap.collaborationMessages!.filter(message=>message.author==="member"&&message.text.includes(children[1]!.id))) assert.equal(raw(message.originRawInputId).submitted_text,"启动工作");
      assert.equal(raw(directedMessage.originRawInputId).submitted_text,"请补充时间说明");
      const generated=db.prepare("SELECT COUNT(*) AS count FROM raw_inputs WHERE submitted_text LIKE '成员 %' OR submitted_text LIKE '%验收要求：%' OR submitted_text LIKE '用户正在%'").get() as {count:number};
      assert.equal(generated.count,0,"generated coordination context never becomes a user submission");
    } finally {db.close();}
  }catch(error){console.error(JSON.stringify({errors,toolResults:requests.map(request=>(request.messages as Array<{role:string}>).filter(message=>message.role==="tool")),snapshot:await snapshot()},null,2));throw error;}finally{release();await host.close();globalThis.fetch=previousFetch;if(process.env.DCODE_COLLAB_UI_KEEP)console.log(`UI_FIXTURE=${root}`);else await rm(root,{recursive:true,force:true});}
});

test("User Scope workers own independent processes, serialize writes and preserve main dialogue",async()=>{
  const root=await mkdtemp(join(tmpdir(),"dcode-direct-worker-")),agent=join(root,"agent"),home=join(root,"home");await mkdir(agent);await mkdir(home);
  await writeFile(join(agent,"settings.json"),JSON.stringify({defaultProvider:"zai-coding-cn",defaultModel:"fixture"}));
  await writeFile(join(agent,"models.json"),JSON.stringify({providers:{"zai-coding-cn":{baseUrl:"https://open.bigmodel.cn/api/paas/v4",api:"openai-completions",apiKey:"fixture-only",models:[{id:"fixture",name:"Fixture",reasoning:false,input:["text"],contextWindow:100000,maxTokens:4096}]}}}));
  await writeFile(join(home,"note.md"),"保持原内容");
  const nested=join(home,"nested");await mkdir(nested);await writeFile(join(nested,"note.md"),"子目录原文");
  const previousFetch=globalThis.fetch;let coordinatorCalls=0,childCoordinatorCalls=0,started=0;const order:string[]=[];
  let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
  globalThis.fetch=(async(url,init)=>{
    if(String(url).includes("quota/limit"))return Response.json({success:true,code:200,data:{limits:[{type:"TOKENS_LIMIT",percentage:10,nextResetTime:Date.now()+3600000}]}});
    const body=JSON.parse(String(init?.body));const system=body.messages.find((m:{role:string})=>m.role==="system")?.content??"";
    if(system.includes("coordinator Agent")){
      if(system.includes("子目录写入")){
        childCoordinatorCalls++;
        if(childCoordinatorCalls===1)return completion("",{index:0,id:"nested-worker",type:"function",function:{name:"dcode_team",arguments:JSON.stringify({action:"delegate",members:[{profileId:"builtin-worker",title:"嵌套工作",instruction:"写入 nested.md",acceptance:"文件存在"}]})}});
        return completion("子目录协调者回应");
      }
      coordinatorCalls++;
      if(coordinatorCalls===1)return completion("",{index:0,id:"workers",type:"function",function:{name:"dcode_team",arguments:JSON.stringify({action:"delegate",members:[{profileId:"builtin-worker",title:"第一项",instruction:"写入 first.md",acceptance:"文件存在"},{profileId:"builtin-worker",title:"第二项",instruction:"写入 second.md",acceptance:"文件存在"}]})}});
      return completion("主对话仍可继续");
    }
    assert.ok(system.includes("worker Agent"));assert.ok(body.tools.some((tool:{function:{name:string}})=>tool.function.name==="write"));
    const first=body.messages.some((message:{content:unknown})=>JSON.stringify(message.content).includes("first.md"));const file=first?"first.md":body.messages.some((message:{content:unknown})=>JSON.stringify(message.content).includes("nested.md"))?"nested.md":"second.md";
    if(!body.messages.some((message:{role:string})=>message.role==="tool")){
      started++;order.push(`start:${file}`);if(started===1)await held;
      return completion("",{index:0,id:`write-${file}`,type:"function",function:{name:"write",arguments:JSON.stringify({path:file,content:`独立完成 ${file}`})}});
    }
    order.push(`finish:${file}`);return completion(`${file} 已完成`);
  }) as typeof fetch;
  const errors:unknown[]=[];const host=new PiHost({agentDir:agent,sessionsDirectory:join(agent,"sessions"),dataRoot:join(root,".dcode"),userHome:home,emit:(event,data)=>{if(/failed|error/i.test(event))errors.push({event,data});}});
  const snapshot=()=>host.handle("foundation.snapshot",{}) as Promise<FoundationSnapshot>;
  try {
    await host.start();let snap=await snapshot();const task=await host.handle("task.create",{requestId:"task",expectedStoreRevision:snap.storeRevision,scope:{kind:"user",userId:snap.currentUser.id},title:"普通目录后台工作",goal:"持续对话"}) as TaskBundle;
    snap=await snapshot();const project=await host.handle("project.create",{requestId:"project",expectedStoreRevision:snap.storeRevision,title:"嵌套目录",directory:nested}) as {project:{id:string}};
    const nestedTask=await host.handle("task.create",{requestId:"nested-task",expectedStoreRevision:(await snapshot()).storeRevision,scope:{kind:"project",projectId:project.project.id},title:"子目录写入",goal:"父子目录共享写入边界"}) as TaskBundle;
    await host.handle("dcodeSession.prompt",{dcodeSessionId:task.coordinationSession.id,promptId:"start",message:"安排两项后台写入"});
    await until(async()=>started===1,"first direct writer started");
    await until(async()=>!(await snapshot()).sessionRuns.some(run=>run.sessionId===task.coordinationSession.id&&run.status==="running"),"coordinator free");
    const file=await host.handle("workspace.read",{source:{taskId:task.task.id},path:"note.md"}) as {digest:string;root:string};
    await assert.rejects(host.handle("workspace.save",{source:{taskId:task.task.id},path:"note.md",text:"不能抢写",expectedDigest:file.digest,expectedRoot:file.root}),error=>(error as {code:string}).code==="WORKSPACE_IN_USE");
    const nestedFile=await host.handle("workspace.read",{source:{taskId:nestedTask.task.id},path:"note.md"}) as {digest:string;root:string};
    await assert.rejects(host.handle("workspace.save",{source:{taskId:nestedTask.task.id},path:"note.md",text:"不得穿过父目录锁",expectedDigest:nestedFile.digest,expectedRoot:nestedFile.root}),error=>(error as {code:string}).code==="WORKSPACE_IN_USE");
    await host.handle("dcodeSession.prompt",{dcodeSessionId:nestedTask.coordinationSession.id,promptId:"nested-start",message:"安排子目录工作"});
    await until(async()=>(await snapshot()).collaborationMessages?.some(message=>message.taskId===nestedTask.task.id&&message.author==="coordinator"&&message.state==="queued")??false,"nested Task worker waits for parent directory writer");
    await host.handle("dcodeSession.prompt",{dcodeSessionId:task.coordinationSession.id,promptId:"talk",message:"继续沟通"});
    await until(async()=>coordinatorCalls>=3,"main replies while writer held");assert.equal(started,1,"second writer waits without blocking dialogue");
    release();await until(async()=>(await snapshot()).collaborationMessages?.filter(message=>message.author==="coordinator"&&message.state==="completed").length===3,"both worker assignments complete");
    await until(async()=>!(await snapshot()).collaborationMessages?.some(message=>["queued","delivering"].includes(message.state)),"result messages settle");
    snap=await snapshot();assert.ok(["start:first.md","start:second.md"].includes(order[0]!));assert.equal(order.length,6);for(let i=0;i<order.length;i+=2)assert.equal(order[i]!.replace("start:",""),order[i+1]!.replace("finish:",""),"overlapping directories never write concurrently");
    assert.equal(await readFile(join(home,"first.md"),"utf8"),"独立完成 first.md");assert.equal(await readFile(join(home,"second.md"),"utf8"),"独立完成 second.md");
    assert.equal(await readFile(join(home,"note.md"),"utf8"),"保持原内容");assert.equal(snap.managedWorkerWorktrees.length,0);
    const workerIds=snap.agentRuns.filter(run=>run.role==="worker").map(run=>run.id);const processes=snap.agentProcesses!.filter(item=>workerIds.includes(item.agentRunId));
    assert.equal(new Set(processes.map(item=>item.process.pid)).size,3);assert.equal(await readFile(join(nested,"nested.md"),"utf8"),"独立完成 nested.md");
    await until(async()=>{const live=await host.handle("runtime.list",{}) as {runtimes:Array<{identity:{agentRunId:string}}>};return !live.runtimes.some(item=>workerIds.includes(item.identity.agentRunId));},"writers release directory after completion");
    const saved=await host.handle("workspace.save",{source:{taskId:task.task.id},path:"note.md",text:"成员完成后保存",expectedDigest:file.digest,expectedRoot:file.root});assert.ok(saved);
  }catch(error){console.error(JSON.stringify({errors,order,snapshot:await snapshot()},null,2));throw error;}
  finally{release();await host.close();globalThis.fetch=previousFetch;await rm(root,{recursive:true,force:true});}
});
