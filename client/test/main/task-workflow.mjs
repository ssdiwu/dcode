import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {createRequire} from "node:module";
import {DatabaseSync} from "node:sqlite";
import {promisify} from "node:util";
import {mkdtemp,mkdir,readFile,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";

// Run after `npm --prefix host run build && npm --prefix client run build`.
// The Electron process, Pi model settings, and Product Store are all isolated.
const client=process.env.DCODE_WORKFLOW_TEST_CLIENT ?? fileURLToPath(new URL("../..",import.meta.url));
const continueAfterFocusRegression=process.env.DCODE_WORKFLOW_INSPECT_THROUGH_FOCUS === "1";
const host=join(client,"../host/dist/src");
const electron=createRequire(join(client,"package.json"))("electron");
const temp=await mkdtemp(join(tmpdir(),"dcode-workflow-ui-"));
await mkdir(join(temp,"agent"));
const attachmentPath=join(temp,"ordinary-draft.txt");
await writeFile(attachmentPath,"普通未发送草稿的附件，不属于这轮工作流。\n");
await writeFile(join(temp,"agent/settings.json"),JSON.stringify({
  defaultProvider:"workflow-fixture",defaultModel:"model",enabledModels:["workflow-fixture/model"],
}));
await writeFile(join(temp,"agent/models.json"),JSON.stringify({providers:{"workflow-fixture":{
  baseUrl:"https://workflow-fixture.invalid/v1",api:"openai-completions",apiKey:"fixture-only-key",
  models:[{id:"model",name:"Fixture",reasoning:false,contextWindow:100000,maxTokens:4096}],
}}}));
let entry=await readFile(join(host,"index.js"),"utf8");
entry=entry.replace(/^#!.*\n/,"").replace(/from "\.\//g,`from "${pathToFileURL(host+"/").href}`)
  .replace("const host = new PiHost({",`const host = new PiHost({userHome:${JSON.stringify(temp)},`);
const prefix=`globalThis.fetch=async(input,init)=>{
  if(!String(input).startsWith('https://workflow-fixture.invalid/'))throw Error('Unexpected fixture network');
  const payload=String(init?.body??'');
  if(payload.includes('ordinary-draft.txt')||payload.includes('这是普通未发送草稿'))
    throw Error('Unsent ordinary Composer content leaked into model request');
  const frame=(text,finish=null)=>'data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:'model',
    choices:[{index:0,delta:text?{role:'assistant',content:text}:{},finish_reason:finish}],
    ...(finish?{usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}:{})})+'\\n\\n';
  return new Response(new ReadableStream({start(c){
    c.enqueue(new TextEncoder().encode(frame('已记录目标；阶段待安排。')+frame('','stop')+'data: [DONE]\\n\\n'));c.close();
  }}),{headers:{'content-type':'text/event-stream'}});
};\n`;
const hostEntry=join(temp,"host.mjs");
await writeFile(hostEntry,prefix+entry);

function runElectron(config){
  const {app,BrowserWindow,nativeTheme}=require("electron");
  const fs=require("node:fs/promises");
  const assert=require("node:assert/strict");
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
      throw Error(`Timeout ${label}; active=`+await run("document.activeElement?.outerHTML?.slice(0,300)"));
    };
    const screenshot=async name=>fs.writeFile(config.temp+"/"+name,(await win.webContents.capturePage()).toPNG());
    const click=async(label,selector="button")=>run(`(()=>{
      const label=${JSON.stringify(label)};
      const button=Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
        .find(node=>node.getAttribute("aria-label")===label||node.textContent.trim()===label);
      if(!button)throw Error("Missing button "+label);button.click();
    })()`);
    const type=async(selector,value)=>run(`(()=>{
      const field=document.querySelector(${JSON.stringify(selector)});
      if(!field)throw Error("Missing field ${selector}");
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(field,${JSON.stringify(value)});
      field.dispatchEvent(new Event("input",{bubbles:true}));
    })()`);
    const snapshot=()=>run('window.dcode.request("foundation.snapshot")');
    try{
      await until('!!document.querySelector("[data-composer]")','new task Composer');
      const ordinaryDraft='这是普通未发送草稿，不应进入工作流原始输入。';
      await type('[data-composer]',ordinaryDraft);
      win.webContents.debugger.attach('1.3');
      const documentNode=await win.webContents.debugger.sendCommand('DOM.getDocument',{depth:1});
      const fileInput=await win.webContents.debugger.sendCommand('DOM.querySelector',{
        nodeId:documentNode.root.nodeId,selector:'input[type="file"][multiple]',
      });
      assert.ok(fileInput.nodeId,'Composer native file input is present');
      await win.webContents.debugger.sendCommand('DOM.setFileInputFiles',{
        nodeId:fileInput.nodeId,files:[config.attachmentPath],
      });
      win.webContents.debugger.detach();
      await until('document.querySelector(".file-attachment .file-name")?.textContent==="ordinary-draft.txt"','isolated file attached through Composer');
      assert.equal(await run('document.querySelector("[data-composer]")?.value'),ordinaryDraft);
      await screenshot("ordinary-draft-with-attachment.png");
      await run('(()=>{const b=document.querySelector("[aria-label=添加内容]");b.focus();b.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",code:"Enter",bubbles:true}));})()');
      await until('Array.from(document.querySelectorAll("[role=menuitem]")).some(e=>e.textContent.trim()==="工作流")','keyboard opened add menu');
      assert.equal(await run('document.querySelector(".composer-add-heading")?.textContent'),"添加");
      await screenshot("add-menu.png");
      await run('Array.from(document.querySelectorAll("[role=menuitem]")).find(e=>e.textContent.trim()==="工作流").click()');
      await until('!!document.querySelector(".task-workflow-create")','workflow create form');
      await sleep(100);
      const goalFocused=await run('document.activeElement===document.querySelector(".task-workflow-create textarea")');
      if(!goalFocused&&config.continueAfterFocusRegression){
        await screenshot('workflow-goal-focus-regression.png');
        await run('document.querySelector(".task-workflow-create textarea").focus()');
      }else assert.equal(goalFocused,true,'+ menu must focus the Workflow goal field; active='+await run('document.activeElement?.outerHTML?.slice(0,350)'));
      await type('.task-workflow-create textarea:first-of-type','交付并核查一个两阶段工作流');
      await type('.task-workflow-create label:nth-of-type(2) textarea','只用隔离数据\n未经核查不得标记完成');
      await run('document.querySelector(".task-workflow-create details").open=true');
      const submitted=await run('document.querySelector(".task-workflow-create pre")?.textContent');
      assert.match(submitted,/交付并核查一个两阶段工作流/);
      assert.match(submitted,/只用隔离数据/);
      assert.ok(!submitted.includes(ordinaryDraft),'workflow submitted text excludes ordinary draft');
      assert.ok(!submitted.includes('ordinary-draft.txt'),'workflow submitted text excludes ordinary attachment');
      await screenshot("workflow-create.png");
      win.setContentSize(800,700);await sleep(160);
      const geometry=await run('(()=>{const panel=document.querySelector(".task-workflow-panel").getBoundingClientRect();return {left:panel.left,right:panel.right,width:innerWidth};})()');
      assert.ok(geometry.left>=0&&geometry.right<=geometry.width,'Workflow create form fits narrow width');
      await screenshot("workflow-create-narrow.png");
      const scrollAccess=await run(`(()=>{
        const panel=document.querySelector(".task-workflow-panel");
        panel.scrollTop=panel.scrollHeight;
        const bounds=panel.getBoundingClientRect();
        const button=Array.from(panel.querySelectorAll("button")).find(value=>value.textContent.trim()==="创建工作流").getBoundingClientRect();
        return {scrollable:panel.scrollHeight>panel.clientHeight,buttonVisible:button.top>=bounds.top&&button.bottom<=bounds.bottom,
          panelTop:bounds.top,panelBottom:bounds.bottom,buttonTop:button.top,buttonBottom:button.bottom,
          scrollTop:panel.scrollTop,scrollHeight:panel.scrollHeight,clientHeight:panel.clientHeight};
      })()`);
      assert.equal(scrollAccess.scrollable,true,'narrow form scrolls inside its panel');
      assert.equal(scrollAccess.buttonVisible,true,'submit remains reachable after panel scroll');
      await sleep(100);await screenshot("workflow-create-narrow-scrolled.png");
      win.setContentSize(1440,900);await sleep(100);
      await run('Array.from(document.querySelectorAll(".task-workflow-create button")).find(b=>b.textContent.trim()==="创建工作流").focus()');
      assert.equal(await run('document.activeElement?.textContent.trim()'),"创建工作流",'submit is keyboard focusable');
      // BrowserWindow is intentionally hidden; native Enter delivery is not reliable here.
      await click('创建工作流','.task-workflow-create button');
      await until('window.dcode.request("foundation.snapshot").then(s=>s.tasks.length===1&&s.taskWorkflows.length===1&&s.taskWorkflowVersions.length===1)','one Task and one Workflow');
      await until('window.dcode.request("foundation.snapshot").then(s=>s.sessionRuns.some(r=>r.taskId===s.tasks[0].id&&["completed","failed","interrupted"].includes(r.status)))','fixture model settled');
      const initial=await snapshot();
      assert.equal(initial.sessionRuns.filter(r=>r.taskId===initial.tasks[0].id).at(-1)?.status,'completed','fixture must not receive unsent ordinary draft or attachment');
      assert.equal(initial.tasks.length,1);
      assert.equal(initial.tasks[0].title,'交付并核查一个两阶段工作流','Task title uses the user-entered goal');
      assert.equal(initial.tasks[0].goal,'交付并核查一个两阶段工作流');
      assert.equal(initial.taskWorkflows.length,1);
      assert.equal(initial.taskWorkflowVersions[0].version,1);
      assert.equal(initial.taskWorkflowVersions[0].goal,'交付并核查一个两阶段工作流');
      assert.deepEqual(initial.taskWorkflowVersions[0].constraints,['只用隔离数据','未经核查不得标记完成']);
      assert.equal(initial.taskWorkflowStages.length,0,'v1 stores no invented stages');
      assert.equal(initial.taskWorkflowRuns.length,0,'creation does not auto start');
      assert.equal(initial.taskWorkflows[0].originRawInputId,initial.taskWorkflowVersions[0].originRawInputId);
      const coordination=initial.sessions.find(s=>s.taskId===initial.tasks[0].id&&s.kind==='coordination');
      await until('window.dcode.request("dcodeSession.presentation",{dcodeSessionId:'+JSON.stringify(coordination.id)+'}).then(p=>p.submissions?.length===1)','one submission');
      const presentation=await run('window.dcode.request("dcodeSession.presentation",{dcodeSessionId:'+JSON.stringify(coordination.id)+'})');
      assert.equal(presentation.submissions[0].text,submitted,'raw submitted text is separate from workflow fields');
      assert.ok(!presentation.submissions[0].text.includes(ordinaryDraft));
      await until('!!Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==="查看本任务工作流")','workflow shortcut');
      await click('查看本任务工作流');
      await until('!!document.querySelector(".task-workflow-panel")','workflow panel');
      await until('document.activeElement===document.querySelector(".task-workflow-panel")','quick workflow panel focus');
      assert.match(await run('document.querySelector(".task-workflow-panel [role=status]")?.textContent'),/协调者正在形成阶段/);
      assert.equal(await run('!!Array.from(document.querySelectorAll(".task-workflow-actions button")).find(b=>b.textContent.trim()==="开始工作流")'),false,'cannot start zero-stage workflow');
      await screenshot("workflow-zero-stage.png");
      const stageRevision=await run(`(async()=>{
        for(let attempt=0;attempt<8;attempt++){
          const s=await window.dcode.request("foundation.snapshot");
          const workflow=s.taskWorkflows[0], task=s.tasks[0];
          try{return await window.dcode.request("task.workflow.revise",{
            requestId:"workflow-ui-two-stages",expectedStoreRevision:s.storeRevision,
            taskId:task.id,scope:task.scope,workflowId:workflow.id,
            expectedWorkflowRevision:workflow.revision,originRawInputId:workflow.originRawInputId,
            goal:"交付并核查一个两阶段工作流",constraints:["只用隔离数据","未经核查不得标记完成"],
            stages:[
              {id:"build",title:"构建",completion:"形成可核查的实际改动",dependsOn:[]},
              {id:"check",title:"独立核查",completion:"检查证据并报告结果",dependsOn:["build"]},
            ],
          });}catch(error){if(attempt===7||!String(error).includes("REVISION_CONFLICT"))throw error;}
        }
      })()`);
      assert.equal(stageRevision.workflowVersion.version,2);
      await until('document.querySelectorAll(".task-workflow-stages li").length===2','two stage UI refreshed');
      assert.deepEqual(await run('Array.from(document.querySelectorAll(".task-workflow-stages li strong")).map(e=>e.textContent)'),['构建','独立核查']);
      assert.deepEqual(await run('Array.from(document.querySelectorAll(".task-workflow-stages li span")).map(e=>e.textContent)'),['待派发','待派发']);
      assert.equal(await run('document.querySelector(".task-workflow-summary span")?.textContent'),'待形成并开始');
      await screenshot("workflow-two-stages.png");
      await click('收起','.task-workflow-panel button');
      await until('!document.querySelector(".task-workflow-panel")','quick workflow closed');
      await until('document.activeElement===document.querySelector(".task-workflow-open")','quick workflow focus restored');
      await run('document.querySelector(".task-workflow-open").focus();document.querySelector(".task-workflow-open").click()');
      await until('document.activeElement===document.querySelector(".task-workflow-panel")','quick workflow reopened and focused');
      await click('收起','.task-workflow-panel button');
      await until('document.activeElement===document.querySelector(".task-workflow-open")','quick workflow refocused after second close');
      await click('任务概览');
      await until('!!document.querySelector("aside[aria-label=任务概览]")','Task HUD');
      if(!await run('!!document.querySelector(".overview-workflow")'))await click('进度','aside[aria-label=任务概览] button');
      await until('!!document.querySelector(".overview-workflow")','Workflow HUD section');
      const hud=await run('document.querySelector(".overview-workflow")?.textContent');
      assert.match(hud,/当前阶段：构建/);
      assert.match(hud,/下一步：等待协调者派发当前阶段/);
      assert.match(hud,/已验收阶段 0\/2/);
      await sleep(350);
      const hudGeometry=await run('(()=>{const el=document.querySelector("aside[aria-label=任务概览]");const r=el.getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth,opacity:getComputedStyle(el).opacity};})()');
      assert.ok(hudGeometry.left>=0&&hudGeometry.right<=hudGeometry.width,'Task HUD fits window');
      await screenshot("workflow-hud.png");
      await click('查看工作流','.overview-workflow button');
      await until('document.activeElement===document.querySelector(".task-workflow-panel")','HUD navigates to focused Workflow panel');
      nativeTheme.themeSource="light";await sleep(120);
      await screenshot("workflow-two-stages-light.png");
      nativeTheme.themeSource="dark";await sleep(120);
      win.setContentSize(800,700);await sleep(150);
      const stageGeometry=await run('(()=>{const p=document.querySelector(".task-workflow-panel").getBoundingClientRect();return {left:p.left,right:p.right,width:innerWidth};})()');
      assert.ok(stageGeometry.left>=0&&stageGeometry.right<=stageGeometry.width,'Two-stage panel fits narrow width');
      await screenshot("workflow-two-stages-narrow.png");
      win.setContentSize(1440,900);
      await click('开始工作流','.task-workflow-actions button');
      await until('document.querySelector(".task-workflow-summary span")?.textContent==="进行中"','started state visible');
      let started=await snapshot();
      assert.equal(started.taskWorkflowRuns.length,1);
      assert.equal(started.taskWorkflowRuns[0].status,'active');
      assert.equal(started.taskWorkflowRuns[0].version,2);
      assert.equal(await run('!!Array.from(document.querySelectorAll(".task-workflow-actions button")).find(b=>b.textContent.includes("完成工作流"))'),false,'no false completion action without evidence');
      assert.equal(await run('document.querySelector(".task-workflow-summary span")?.textContent'),"进行中");
      await screenshot("workflow-active-no-evidence.png");
      await click('停止后续推进','.task-workflow-actions button');
      await until('document.querySelector(".task-workflow-summary span")?.textContent==="已停止后续推进"','stopped state visible');
      assert.equal((await snapshot()).taskWorkflowRuns[0].status,'stopped');
      await screenshot("workflow-stopped.png");
      await new Promise(resolve=>{win.webContents.once("did-finish-load",resolve);win.reload();});
      await until('!!document.querySelector("[data-composer]")','renderer reloaded');
      if(!await run('!!Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==="查看本任务工作流")')){
        await run('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.includes("交付并核查一个两阶段工作流"))?.click()');
      }
      await until('!!Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==="查看本任务工作流")','restored Task workflow shortcut');
      await click('查看本任务工作流');
      await until('document.querySelector(".task-workflow-summary span")?.textContent==="已停止后续推进"','stopped state restored after renderer reload');
      assert.equal((await snapshot()).taskWorkflowRuns[0].id,started.taskWorkflowRuns[0].id);
      await screenshot("workflow-stopped-reloaded.png");
      await click('继续工作流','.task-workflow-actions button');
      await until('document.querySelector(".task-workflow-summary span")?.textContent==="进行中"','continued state visible');
      const after=await snapshot();
      assert.equal(after.taskWorkflowRuns.length,1,'continue reuses same run');
      assert.equal(after.taskWorkflowRuns[0].id,started.taskWorkflowRuns[0].id);
      assert.equal(after.taskWorkflowRuns[0].status,'active');
      assert.equal(after.taskWorkflowReports.length,0);
      assert.equal(await run('document.querySelector(".task-workflow-summary span")?.textContent'),"进行中",'no false completion status');
      assert.deepEqual(await run('Array.from(document.querySelectorAll(".task-workflow-stages li span")).map(e=>e.textContent)'),['待派发','待派发']);
      await screenshot("workflow-continued-no-evidence.png");
      await click('新建任务');
      await until('document.querySelector("[data-composer]")?.value==='+JSON.stringify(ordinaryDraft),'ordinary new Task draft restored');
      await until('document.querySelector(".file-attachment .file-name")?.textContent==="ordinary-draft.txt"','ordinary attachment restored');
      assert.equal((await snapshot()).tasks.length,1,'revisiting new Task draft does not create a Task');
      await screenshot("ordinary-draft-restored.png");
      await click('交付并核查一个两阶段工作流');
      await until('!!Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==="查看本任务工作流")','return to Workflow Task');
      await run('window.dcode.request("dcodeSession.prompt",{dcodeSessionId:'+JSON.stringify(coordination.id)+',promptId:"workflow-ui-second-draft",message:"请先记录第二轮候选工作流，不开始。",workflowDraft:{goal:"下一轮候选检查"}})');
      await until('window.dcode.request("foundation.snapshot").then(s=>s.taskWorkflows.length===2)','second zero-stage Workflow saved');
      await until('window.dcode.request("foundation.snapshot").then(s=>{const runs=s.sessionRuns.filter(r=>r.taskId===s.tasks[0].id);return runs.length===2&&runs.every(r=>r.status==="completed")})','second fixture prompt completed');
      const twoRounds=await snapshot();
      const secondWorkflow=twoRounds.taskWorkflows.find(item=>item.id!==initial.taskWorkflows[0].id);
      assert.ok(secondWorkflow,'second Workflow has separate stable identity');
      assert.equal(twoRounds.taskWorkflowStages.filter(item=>item.workflowId===secondWorkflow.id).length,0,'second Workflow has no invented stages');
      assert.equal(twoRounds.taskWorkflowRuns.length,1,'W2 draft does not create a Run');
      assert.equal(twoRounds.taskWorkflowRuns[0].id,after.taskWorkflowRuns[0].id,'W1 remains the active Run');
      await click('查看本任务工作流');
      await until('document.activeElement===document.querySelector(".task-workflow-panel")','active Workflow panel focused');
      assert.equal(await run('document.querySelector(".task-workflow-summary strong")?.textContent'),'交付并核查一个两阶段工作流','active W1 is default selection');
      assert.equal(await run('document.querySelector(".task-workflow-summary span")?.textContent'),'进行中');
      const history=await run('Array.from(document.querySelectorAll(".task-workflow-history button")).map(b=>b.textContent.trim())');
      assert.equal(history.length,2);
      assert.ok(history.some(value=>value.includes('下一轮候选检查')&&value.includes('待开始')));
      assert.ok(history.some(value=>value.includes('交付并核查一个两阶段工作流')&&value.includes('进行中')));
      await sleep(350);
      await screenshot("workflow-two-rounds-active-first.png");
      await fs.writeFile(config.temp+"/result.json",JSON.stringify({
        passed:true,taskId:initial.tasks[0].id,rawInputId:initial.taskWorkflows[0].originRawInputId,
        runId:after.taskWorkflowRuns[0].id,oneSubmission:true,workflowVersions:2,
        finalStatus:after.taskWorkflowRuns[0].status,ordinaryDraftAndAttachmentRestored:true,
        hudShowsStageAndNextStep:true,workflowQuickFocusRestored:true,goalFocused,secondDraftDoesNotHideActiveRun:true,
        geometry:{create:geometry,createScrolled:scrollAccess,stages:stageGeometry,hud:hudGeometry},
      }));
      app.quit();
    }catch(error){
      await screenshot("failure.png").catch(()=>{});
      await fs.writeFile(config.temp+"/result.json",JSON.stringify({passed:false,error:String(error),stack:error?.stack}));
      app.exit(1);
    }
  }));
  import(config.entry);
}

const runner=join(temp,"runner.cjs");
await writeFile(runner,`(${runElectron.toString()})(${JSON.stringify({temp,attachmentPath,continueAfterFocusRegression,entry:pathToFileURL(join(client,"dist/src/main/index.js")).href})});\n`);
const env={...process.env,DCODE_HOST_ENTRY:hostEntry,DCODE_DATA_ROOT:join(temp,".dcode"),
  DCODE_AGENT_DIR:join(temp,"agent"),DCODE_USER_DATA:join(temp,"profile"),DCODE_WIDTH:"1440",PI_OFFLINE:"1"};
for(const key of ["ELECTRON_RUN_AS_NODE","DCODE_RENDERER_URL","DCODE_THEME","DCODE_CAPTURE","DCODE_CREDENTIAL_PIPE_FD","DCODE_DEVICE_CODE_PIPE_FD"])delete env[key];
let processResult;
try{processResult=await promisify(execFile)(electron,[runner],{cwd:client,env,timeout:150000,maxBuffer:2_000_000});}
catch(error){processResult=error;}
let result;
try{result=JSON.parse(await readFile(join(temp,"result.json"),"utf8"));}
catch(error){console.error(JSON.stringify({temp,error:"Electron exited before result.json",processError:String(processResult)}));throw error;}
if(result.passed){
  const db=new DatabaseSync(join(temp,".dcode","product-store.sqlite3"),{readOnly:true});
  try{
    const taskCount=db.prepare("SELECT COUNT(*) AS count FROM tasks").get().count;
    const raws=db.prepare("SELECT id,task_id,submitted_text,attachment_refs_json FROM raw_inputs").all();
    assert.equal(taskCount,1,"one Task in isolated Product Store");
    assert.equal(raws.length,2,"two explicit Workflow submissions yield two Raw Inputs");
    assert.ok(raws.every(raw=>raw.task_id===result.taskId));
    const firstRaw=raws.find(raw=>raw.id===result.rawInputId);
    const secondRaw=raws.find(raw=>raw.id!==result.rawInputId);
    assert.ok(firstRaw&&secondRaw);
    assert.match(firstRaw.submitted_text,/交付并核查一个两阶段工作流/);
    assert.equal(secondRaw.submitted_text,'请先记录第二轮候选工作流，不开始。');
    assert.ok(!firstRaw.submitted_text.includes('这是普通未发送草稿'));
    assert.ok(!secondRaw.submitted_text.includes('这是普通未发送草稿'));
    assert.deepEqual(JSON.parse(firstRaw.attachment_refs_json),[],'W1 Raw Input has no ordinary attachment');
    assert.deepEqual(JSON.parse(secondRaw.attachment_refs_json),[],'W2 Raw Input has no ordinary attachment');
    result.database={taskCount,rawInputCount:raws.length};
  }finally{db.close();}
}
console.log(JSON.stringify({temp,...result}));
assert.equal(result.passed,true,JSON.stringify(processResult));
