import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {createRequire} from "node:module";
import {DatabaseSync} from "node:sqlite";
import {mkdtemp,mkdir,readFile,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {promisify} from "node:util";

// Three independent hidden Electron instances. Run after Host and client builds.
const client=process.env.DCODE_WORKFLOW_TEST_CLIENT??fileURLToPath(new URL("../..",import.meta.url));
const host=join(client,"../host/dist/src");
const electron=createRequire(join(client,"package.json"))("electron");

function runElectron(config){
  const {app,BrowserWindow}=require("electron");
  const assert=require("node:assert/strict");
  const fs=require("node:fs/promises");
  BrowserWindow.prototype.show=function(){};
  BrowserWindow.prototype.focus=function(){};
  app.once("browser-window-created",(_event,win)=>win.webContents.once("did-finish-load",async()=>{
    const run=code=>win.webContents.executeJavaScript(code,true);
    const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    const until=async(code,label)=>{
      for(let i=0;i<400;i++){
        if(await run(code))return;
        await sleep(30);
      }
      throw Error(`Timeout ${label}; `+await run('document.querySelector(".task-workflow-panel")?.innerText.slice(0,700)'));
    };
    const click=label=>run(`(()=>{const label=${JSON.stringify(label)};const button=Array.from(document.querySelectorAll("button")).find(value=>value.textContent.trim()===label);if(!button)throw Error("Missing button "+label);button.click();})()`);
    const type=(selector,value)=>run(`(()=>{const field=document.querySelector(${JSON.stringify(selector)});if(!field)throw Error("Missing field");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(field,${JSON.stringify(value)});field.dispatchEvent(new Event("input",{bubbles:true}));})()`);
    const snapshot=()=>run('window.dcode.request("foundation.snapshot")');
    const screenshot=async name=>fs.writeFile(config.temp+"/"+name,(await win.webContents.capturePage()).toPNG());
    try{
      await until('!!document.querySelector("[data-composer]")','new Task');
      await run('document.querySelector("[aria-label=添加内容]").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",code:"Enter",bubbles:true}))');
      await until('Array.from(document.querySelectorAll("[role=menuitem]")).some(item=>item.textContent.trim()==="工作流")','add menu');
      await run('Array.from(document.querySelectorAll("[role=menuitem]")).find(item=>item.textContent.trim()==="工作流").click()');
      await until('!!document.querySelector(".task-workflow-create")','Workflow form');
      await type('.task-workflow-create textarea:first-of-type','失败恢复目标');
      await type('.task-workflow-create label:nth-of-type(2) textarea','仅用隔离环境\n核对后再重试');
      assert.equal(await run('document.querySelector(".task-workflow-create textarea")?.value'),'失败恢复目标');
      if(config.kind==="postaccept")await run(`(()=>{window.__workflowTrace=[];window.__workflowTraceTimer=setInterval(()=>{
        const panel=document.querySelector('.task-workflow-panel');
        window.__workflowTrace.push({t:Date.now(),panel:!!panel,alert:panel?.querySelector('[role=alert]')?.textContent??'',
          title:document.querySelector('.workspace-bar')?.textContent?.trim().slice(0,60),
          banner:Array.from(document.querySelectorAll('[role=alert]')).map(e=>e.textContent?.trim()).join('|').slice(0,160)});
      },10)})()`);
      await click('创建工作流');
      await until('document.querySelector(".task-workflow-panel [role=alert]")?.textContent?.includes("提交结果待核对")','unknown submission feedback');
      await until('!Array.from(document.querySelectorAll(".task-workflow-create button")).some(button=>button.textContent.trim()==="提交中…")','submit settled');
      if(config.kind==="postaccept")await sleep(10150);
      const first=await snapshot();
      assert.equal(first.tasks.length,1,'Task created exactly once');
      assert.equal(first.tasks[0].title,'失败恢复目标');
      assert.equal(await run('document.querySelector("[data-composer]")?.value'),'','ordinary Composer must not receive synthesized Workflow prompt');
      assert.equal(await run('document.querySelector(".composer [aria-label=发送]")?.disabled'),true,'Workflow prompt must not enable ordinary send');
      const taskRows=await run('Array.from(document.querySelectorAll(".task-row")).filter(row=>row.textContent.includes("失败恢复目标")).map(row=>row.getAttribute("aria-current"))');
      assert.equal(taskRows.filter(value=>value==='page').length,1,'only Task tree row is aria-current');
      assert.ok(taskRows.length>=2,'same Task appears in recent work and Task tree');
      assert.equal(await run('document.querySelector(".task-workflow-create textarea")?.value'),'失败恢复目标');
      assert.equal(await run('document.querySelector(".task-workflow-create label:nth-of-type(2) textarea")?.value'),'仅用隔离环境\n核对后再重试');
      assert.equal(await run('Array.from(document.querySelectorAll(".task-workflow-create button")).find(button=>button.textContent.trim()==="创建工作流")?.disabled'),true,'unknown state locks repeat submission');
      assert.equal(await run('!!Array.from(document.querySelectorAll("button")).find(button=>button.textContent.trim()==="重新读取工作流提交状态")'),true);
      const coordination=first.sessions.find(session=>session.taskId===first.tasks[0].id&&session.kind==="coordination");
      const pending=first.composerDrafts.find(draft=>draft.sessionId===coordination.id)?.pendingWorkflowSubmission;
      assert.equal(pending?.kind,'create','pending Workflow identity persisted in Coordinator draft');
      assert.equal(pending?.goal,'失败恢复目标');
      assert.ok(pending.promptId);
      await screenshot(config.kind+"-unknown.png");
      if(config.kind==="crossTask"){
        assert.equal(first.taskWorkflows.length,0);
        await run(`(async()=>{for(let attempt=0;attempt<6;attempt++){
          const s=await window.dcode.request("foundation.snapshot");
          try{return await window.dcode.request("task.create",{requestId:"pending-other-task",expectedStoreRevision:s.storeRevision,scope:s.tasks[0].scope,title:"任务 B",goal:"单独任务"});}
          catch(error){if(attempt===5||!String(error).includes("REVISION_CONFLICT"))throw error;}
        }})()`);
        await until('Array.from(document.querySelectorAll("button")).some(button=>button.textContent.trim()==="任务 B")','Task B sidebar row');
        await click('任务 B');
        await until('!document.querySelector(".task-workflow-panel")','Task A pending panel does not attach to Task B');
        await run('document.querySelector("[aria-label=添加内容]").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",code:"Enter",bubbles:true}))');
        await until('Array.from(document.querySelectorAll("[role=menuitem]")).some(item=>item.textContent.trim()==="工作流")','Task B add menu');
        await run('Array.from(document.querySelectorAll("[role=menuitem]")).find(item=>item.textContent.trim()==="工作流").click()');
        await until('!!document.querySelector(".task-workflow-create")','Task B Workflow form');
        assert.equal(await run('document.querySelector(".task-workflow-create textarea")?.value'),'', 'Task B does not inherit A goal');
        assert.equal(await run('!!Array.from(document.querySelectorAll("button")).find(button=>button.textContent.trim()==="重新读取工作流提交状态")'),false,'Task B has no A pending state');
        await screenshot('cross-task-b-clean.png');
        await click('收起');
        await click('失败恢复目标');
        await until('!!document.querySelector("[data-composer]")','Task A restored');
        await run('document.querySelector("[aria-label=添加内容]").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",code:"Enter",bubbles:true}))');
        await until('Array.from(document.querySelectorAll("[role=menuitem]")).some(item=>item.textContent.trim()==="工作流")','Task A add menu');
        await run('Array.from(document.querySelectorAll("[role=menuitem]")).find(item=>item.textContent.trim()==="工作流").click()');
        await until('!!document.querySelector(".task-workflow-create")','Task A pending form');
        assert.equal(await run('document.querySelector(".task-workflow-create textarea")?.value'),'失败恢复目标');
        assert.equal(await run('document.querySelector("[data-composer]")?.value'),'');
        assert.equal(await run('document.querySelector(".composer [aria-label=发送]")?.disabled'),true);
        assert.equal(await run('Array.from(document.querySelectorAll(".task-workflow-create button")).find(button=>button.textContent.trim()==="创建工作流")?.disabled'),true);
        assert.equal(await run('!!Array.from(document.querySelectorAll("button")).find(button=>button.textContent.trim()==="重新读取工作流提交状态")'),true);
        await screenshot('cross-task-a-pending-restored.png');
        await fs.writeFile(config.temp+"/result.json",JSON.stringify({passed:true,kind:config.kind,taskCount:2,workflowCount:0,pendingStayedWithA:true}));
        app.quit();return;
      }
      if(config.kind==="preprepare"){
        assert.equal(first.taskWorkflows.length,0,'rejected pre-prepare prompt left no Workflow');
        assert.equal(first.sessionRuns.length,0,'no Runtime run prepared');
        assert.equal(first.events.some(event=>event.kind==='sessionRun.prepared'&&(event.payload?.clientPromptId===pending.promptId)),false,'failed prompt has no source receipt');
        await click('设置');
        await until('!!Array.from(document.querySelectorAll("button")).find(button=>button.textContent.trim()==="返回工作台")','settings opened');
        await click('返回工作台');
        await until('!!document.querySelector("[data-composer]")','workbench restored');
        await run('document.querySelector("[aria-label=添加内容]").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",code:"Enter",bubbles:true}))');
        await until('Array.from(document.querySelectorAll("[role=menuitem]")).some(item=>item.textContent.trim()==="工作流")','menu after settings');
        await run('Array.from(document.querySelectorAll("[role=menuitem]")).find(item=>item.textContent.trim()==="工作流").click()');
        await until('!!document.querySelector(".task-workflow-create")','Workflow form after settings');
        assert.equal(await run('document.querySelector(".task-workflow-create textarea")?.value'),'失败恢复目标');
        assert.equal(await run('Array.from(document.querySelectorAll(".task-workflow-create button")).find(button=>button.textContent.trim()==="创建工作流")?.disabled'),true,'settings switch did not unlock pending submission');
        await screenshot('preprepare-settings-pending.png');
        await run('window.dcode.request("dcodeSession.prompt",{dcodeSessionId:'+JSON.stringify(coordination.id)+',promptId:"unrelated-workflow",message:"另一条独立工作流请求",workflowDraft:{goal:"无关工作流"}})');
        await until('window.dcode.request("foundation.snapshot").then(s=>s.taskWorkflows.length===1)','unrelated Workflow source saved');
        await click('重新读取工作流提交状态');
        await until('(()=>{const value=document.querySelector(".task-workflow-panel [role=alert]")?.textContent??"";return value.includes("尚未确认")||value.includes("仍未确认")})()','recheck says no Workflow');
        const rechecked=await snapshot();
        assert.equal(rechecked.tasks.length,1);
        assert.equal(rechecked.taskWorkflows.length,1,'unrelated Workflow exists only from separate explicit prompt');
        assert.equal(rechecked.events.some(event=>event.kind==='sessionRun.prepared'&&event.payload?.clientPromptId===pending.promptId),false);
        assert.equal(rechecked.events.some(event=>event.kind==='sessionRun.prepared'&&event.payload?.clientPromptId==='unrelated-workflow'),true);
        assert.equal(await run('!!Array.from(document.querySelectorAll("button")).find(button=>button.textContent.trim()==="我已核对，返回编辑")'),true,'requires explicit user decision before retry');
        assert.equal(await run('Array.from(document.querySelectorAll(".task-workflow-create button")).find(button=>button.textContent.trim()==="创建工作流")?.disabled'),true);
        await screenshot("preprepare-rechecked.png");
        await click('我已核对，返回编辑');
        await until('Array.from(document.querySelectorAll(".task-workflow-create button")).find(button=>button.textContent.trim()==="创建工作流")?.disabled===false','explicit return to edit');
        assert.equal(await run('document.querySelector(".task-workflow-create textarea")?.value'),'失败恢复目标');
        assert.equal(await run('document.querySelector(".task-workflow-create label:nth-of-type(2) textarea")?.value'),'仅用隔离环境\n核对后再重试');
        assert.equal((await snapshot()).taskWorkflows.length,1,'edit alone never plain-sends or silently creates original Workflow');
      }else{
        assert.equal(first.taskWorkflows.length,1,'prompt was accepted before refresh failed');
        assert.equal(first.taskWorkflowStages.length,0);
        const receipt=first.events.find(event=>event.kind==='sessionRun.prepared'&&event.payload?.clientPromptId===pending.promptId);
        assert.equal(receipt?.payload?.workflow?.id,first.taskWorkflows[0].id,'recheckable StoreEvent belongs to this promptId');
        assert.equal(receipt?.payload?.rawInputId,first.taskWorkflows[0].originRawInputId);
        await click('创建工作流');
        assert.equal((await snapshot()).taskWorkflows.length,1,'disabled button cannot duplicate accepted Workflow');
        await click('重新读取工作流提交状态');
        await until('!document.querySelector(".task-workflow-panel")','recheck confirms accepted Workflow and closes form');
        await until('!!Array.from(document.querySelectorAll("button")).find(button=>button.textContent.trim()==="查看本任务工作流")','accepted Workflow shortcut');
        const confirmed=await snapshot();
        assert.equal(confirmed.tasks.length,1);
        assert.equal(confirmed.taskWorkflows.length,1,'recheck does not create duplicate Workflow');
        await screenshot("postaccept-confirmed.png");
      }
      await fs.writeFile(config.temp+"/result.json",JSON.stringify({passed:true,kind:config.kind,taskCount:1,workflowCount:1,formRetained:config.kind==="preprepare",recheckRequired:true,promptId:pending.promptId}));
      app.quit();
    }catch(error){
      if(config.kind==="postaccept"){
        const trace=await run('(()=>{clearInterval(window.__workflowTraceTimer);return window.__workflowTrace??[]})()').catch(()=>[]);
        await fs.writeFile(config.temp+'/ui-trace.json',JSON.stringify(trace));
      }
      await screenshot("failure.png").catch(()=>{});
      await fs.writeFile(config.temp+"/result.json",JSON.stringify({passed:false,kind:config.kind,error:String(error),stack:error?.stack}));
      app.exit(1);
    }
  }));
  import(config.entry);
}

async function runScenario(kind){
  const temp=await mkdtemp(join(tmpdir(),`dcode-workflow-${kind}-`));
  await mkdir(join(temp,"agent"));
  await writeFile(join(temp,"agent/settings.json"),JSON.stringify({defaultProvider:"workflow-fixture",defaultModel:"model",enabledModels:["workflow-fixture/model"]}));
  await writeFile(join(temp,"agent/models.json"),JSON.stringify({providers:{"workflow-fixture":{
    baseUrl:"https://workflow-fixture.invalid/v1",api:"openai-completions",apiKey:"fixture-only-key",
    models:[{id:"model",name:"Fixture",reasoning:false,contextWindow:100000,maxTokens:4096}],
  }}}));
  let entry=await readFile(join(host,"index.js"),"utf8");
  entry=entry.replace(/^#!.*\n/,"").replace(/from "\.\//g,`from "${pathToFileURL(host+"/").href}`)
    .replace("const host = new PiHost({",`const host = new PiHost({userHome:${JSON.stringify(temp)},`);
  const injection=kind==="preprepare"||kind==="crossTask"?`
const testRealHandle=host.handle.bind(host);let testRejected=false;
host.handle=async(method,params)=>{
  if(method==='dcodeSession.prompt'&&!testRejected){testRejected=true;const error=new Error('Injected failure before Workflow prepare');error.code='TEST_PREPARE_REJECTED';throw error;}
  return testRealHandle(method,params);
};
`:`
const testRealHandle=host.handle.bind(host);let testAccepted=false,testRejectUntil=0;
host.handle=async(method,params)=>{
  if(method==='dcodeSession.prompt'){const result=await testRealHandle(method,params);testAccepted=true;testRejectUntil=Date.now()+10000;return result;}
  if(testAccepted&&method==='foundation.snapshot'&&Date.now()<testRejectUntil){const error=new Error('Injected refresh failure after accepted prompt');error.code='TEST_REFRESH_FAILED';throw error;}
  return testRealHandle(method,params);
};
`;
  if(!entry.includes("let credentialInputReady = false;"))throw Error("Host injection point missing");
  entry=entry.replace("let credentialInputReady = false;",injection+"\nlet credentialInputReady = false;");
  const prefix=`globalThis.fetch=async(input)=>{
    if(!String(input).startsWith('https://workflow-fixture.invalid/'))throw Error('Unexpected fixture network');
    const frame=(text,finish=null)=>'data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:'model',choices:[{index:0,delta:text?{role:'assistant',content:text}:{},finish_reason:finish}],...(finish?{usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}:{})})+'\\n\\n';
    return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(frame('已记录工作流目标')+frame('','stop')+'data: [DONE]\\n\\n'));c.close();}}),{headers:{'content-type':'text/event-stream'}});
  };\n`;
  const hostEntry=join(temp,"host.mjs");await writeFile(hostEntry,prefix+entry);
  const runner=join(temp,"runner.cjs");
  await writeFile(runner,`(${runElectron.toString()})(${JSON.stringify({kind,temp,entry:pathToFileURL(join(client,"dist/src/main/index.js")).href})});\n`);
  const env={...process.env,DCODE_HOST_ENTRY:hostEntry,DCODE_DATA_ROOT:join(temp,".dcode"),DCODE_AGENT_DIR:join(temp,"agent"),DCODE_USER_DATA:join(temp,"profile"),DCODE_WIDTH:"1440",PI_OFFLINE:"1"};
  for(const key of ["ELECTRON_RUN_AS_NODE","DCODE_RENDERER_URL","DCODE_THEME","DCODE_CAPTURE","DCODE_CREDENTIAL_PIPE_FD","DCODE_DEVICE_CODE_PIPE_FD"])delete env[key];
  let processResult;
  try{processResult=await promisify(execFile)(electron,[runner],{cwd:client,env,timeout:90000,maxBuffer:1_000_000});}
  catch(error){processResult=error;}
  let result;
  try{result=JSON.parse(await readFile(join(temp,"result.json"),"utf8"));}
  catch(error){console.error(JSON.stringify({kind,temp,error:"Electron exited before result.json",processError:String(processResult)}));throw error;}
  if(result.passed){
    const db=new DatabaseSync(join(temp,".dcode","product-store.sqlite3"),{readOnly:true});
    try{
      const counts={tasks:db.prepare("SELECT COUNT(*) AS count FROM tasks").get().count,
        workflows:db.prepare("SELECT COUNT(*) AS count FROM task_workflows").get().count,
        rawInputs:db.prepare("SELECT COUNT(*) AS count FROM raw_inputs").get().count};
      assert.equal(counts.tasks,kind==="crossTask"?2:1);
      assert.equal(counts.workflows,kind==="crossTask"?0:1);
      assert.equal(counts.rawInputs,kind==="crossTask"?0:1);
      result.database=counts;
    }finally{db.close();}
  }
  console.log(JSON.stringify({temp,...result}));
  assert.equal(result.passed,true,JSON.stringify(processResult));
}

for(const kind of ["preprepare","crossTask","postaccept"])await runScenario(kind);
