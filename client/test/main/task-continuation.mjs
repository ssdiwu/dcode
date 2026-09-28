import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import electron from "electron";
import { ProductStore } from "../../../host/dist/src/product-store.js";

const client=fileURLToPath(new URL("../../",import.meta.url));
const temp=await mkdtemp(join(tmpdir(),"dcode-task-continuation-ui-")),home=join(temp,"home"),agent=join(temp,"agent"),dataRoot=join(home,".dcode");
await mkdir(home);await mkdir(agent);await writeFile(join(agent,"settings.json"),"{}\n");
const store=await ProductStore.open({dataRoot,userHome:home});
let snapshot=await store.snapshot();const scope={kind:"user",userId:snapshot.currentUser.id};
const {task,coordinationSession}=await store.createTask({requestId:"task",expectedStoreRevision:snapshot.storeRevision,scope,title:"续接窗口测试",goal:"核对旧工作与新安排"});
const prepared=await store.prepareSessionRun({requestId:"old-message",taskId:task.id,scope,sessionId:coordinationSession.id,runtimeId:"old-runtime",workspaceId:"old-workspace",cwd:home,workspaceAccess:"sharedReadOnly",message:"旧会话里有原始要求",attachmentRefs:[],roleRevision:"coordinator:v1",contextRevision:1,profileSnapshot:{role:"coordinator"},tools:[],toolsWritable:false,systemPromptDigest:`sha256:${"f".repeat(64)}`,promptSources:[]});
await store.startSessionRun(prepared.sessionRunId);
await store.finishSessionRun({sessionRunId:prepared.sessionRunId,providerAttemptId:prepared.providerAttemptId,outcome:"succeeded",assistantText:"旧工作已记录"});
snapshot=await store.snapshot();const later=await store.createTask({requestId:"version-task",expectedStoreRevision:snapshot.storeRevision,scope,title:"版本归属窗口",goal:"核对实际采用的摘要"});
const firstSummary=(await store.prepareTaskSummary({requestId:"version-summary-one",taskId:later.task.id,trigger:"new_session"})).summary;
const adopted={id:firstSummary.id,taskId:firstSummary.taskId,revision:firstSummary.revision,digest:firstSummary.digest,trigger:firstSummary.trigger,createdAt:firstSummary.createdAt};
const versionRun=await store.prepareSessionRun({requestId:"version-run",taskId:later.task.id,scope,sessionId:later.coordinationSession.id,runtimeId:"version-runtime",workspaceId:"version-workspace",cwd:home,workspaceAccess:"sharedReadOnly",message:"继续核对",effectiveMessage:"已采用任务摘要，继续核对",taskSummary:adopted,attachmentRefs:[],roleRevision:"coordinator:v1",contextRevision:1,profileSnapshot:{role:"coordinator"},tools:[],toolsWritable:false,systemPromptDigest:`sha256:${"f".repeat(64)}`,promptSources:[]});
await store.startSessionRun(versionRun.sessionRunId);await store.finishSessionRun({sessionRunId:versionRun.sessionRunId,providerAttemptId:versionRun.providerAttemptId,outcome:"succeeded",assistantText:"已记录采用版本"});
await store.prepareTaskSummary({requestId:"version-summary-two",taskId:later.task.id,trigger:"member_restart"});
snapshot=await store.snapshot();await store.patchTaskWorkbenchViewState({requestId:"select",expectedStoreRevision:snapshot.storeRevision,expectedViewStateRevision:snapshot.taskWorkbenchViewState.revision,patch:{selection:{taskId:task.id,sessionId:coordinationSession.id}}});
await store.close();

const runner=join(temp,"runner.cjs");
await writeFile(runner,`
const {app,BrowserWindow,nativeTheme}=require('electron');const fs=require('node:fs/promises');const assert=require('node:assert/strict');
BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.focus=function(){};
app.on('browser-window-created',(_event,win)=>win.webContents.once('did-finish-load',async()=>{
 const run=code=>win.webContents.executeJavaScript(code,true),sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const until=async(code)=>{for(let i=0;i<250;i++){if(await run(code))return;await sleep(40);}throw Error('Task continuation UI timeout: '+code);};
 try{
  await until('!!document.querySelector("[data-composer]") && [...document.querySelectorAll("button")].some(x=>x.getAttribute("aria-label")=="任务操作")');
  await run('(function(){const field=document.querySelector("[data-composer]");const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set;setter.call(field,"尚未发送的草稿");field.dispatchEvent(new Event("input",{bubbles:true}));})()');
  await sleep(450);
  await run('(function(){const button=[...document.querySelectorAll("button")].find(x=>x.getAttribute("aria-label")==="任务操作");button.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,pointerType:"mouse",button:0}));})()');
  await until('[...document.querySelectorAll("[role=menuitem]")].some(x=>x.textContent.includes("开始新一段对话"))');
  await run('[...document.querySelectorAll("[role=menuitem]")].find(x=>x.textContent.includes("开始新一段对话")).click()');
  await until('!!document.querySelector(".task-summary")');
  assert.ok(await run('document.querySelector(".task-summary").textContent.includes("任务当前摘要 · 第 1 版")'));
  assert.equal(await run('document.querySelector("[data-composer]").value'),"尚未发送的草稿");
  assert.ok(await run('document.body.textContent.includes("历史对话")'));
  await run('[...document.querySelectorAll(".task-summary button")].find(x=>x.textContent.includes("纠正摘要")).click()');
  await until('!!document.querySelector(".task-summary-editor textarea")');
  await run('(function(){const field=document.querySelector(".task-summary-editor textarea");const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set;setter.call(field,"用户修正：先核对来源");field.dispatchEvent(new Event("input",{bubbles:true}));})()');
  await run('[...document.querySelectorAll(".task-summary-editor button")].find(x=>x.textContent.includes("保存修订")).click()');
  await until('document.querySelector(".task-summary")?.textContent.includes("任务当前摘要 · 第 2 版")');
  assert.ok(await run('document.querySelector(".task-summary").textContent.includes("用户修正：先核对来源")'));
  await run('[...document.querySelectorAll(".task-summary button")].find(x=>x.textContent.includes("上版摘要")).click()');
  await until('!!document.querySelector(".task-summary-source")');
  assert.ok(await run('document.querySelector(".task-summary-source").textContent.includes("第 1 版")'));
  await run('document.querySelector(".task-summary-source button").click()');
  await run('[...document.querySelectorAll(".task-summary button")].find(x=>x.textContent.includes("历史版本")).click()');
  await until('!!document.querySelector(".task-summary-history")');
  await run('[...document.querySelectorAll(".task-summary-history ol button")].find(x=>x.textContent.includes("查看")).click()');
  await until('!!document.querySelector(".task-summary-history-detail")');
  await run('document.querySelector(".task-summary-history-detail li button").click()');
  await until('document.querySelector(".task-summary-source")?.textContent.includes("任务目标")');
  for(const theme of ['light','dark']){nativeTheme.themeSource=theme;await sleep(120);win.setContentSize(1100,760);await fs.writeFile(${JSON.stringify(temp)}+'/summary-'+theme+'.png',(await win.webContents.capturePage()).toPNG());}
  win.setContentSize(960,700);await sleep(120);assert.ok(await run('document.documentElement.scrollWidth<=innerWidth'));
  await run('[...document.querySelectorAll(".task-row")].find(x=>x.textContent.includes("版本归属窗口")).click()');
  await until('document.querySelector(".task-summary")?.textContent.includes("本对话已采用的任务摘要 · 第 1 版")');
  assert.ok(await run('document.querySelector(".task-summary").textContent.includes("任务当前摘要是第 2 版；本对话运行时采用第 1 版")'));
  await run('[...document.querySelectorAll(".task-summary button")].find(x=>x.textContent.includes("查看任务当前版本")).click()');
  await until('document.querySelector(".task-summary")?.textContent.includes("任务当前摘要 · 第 2 版")');
  assert.ok(await run('document.querySelector(".task-summary").textContent.includes("任务当前摘要是第 2 版；本对话运行时采用第 1 版")'));
  await fs.writeFile(${JSON.stringify(join(temp,"result.json"))},JSON.stringify({passed:true,summaryRevision:2,historyVisible:true,draftPreserved:true,themes:['light','dark'],narrowWidth:960}));app.quit();
 }catch(error){await fs.writeFile(${JSON.stringify(join(temp,"failure.png"))},(await win.webContents.capturePage()).toPNG());await fs.writeFile(${JSON.stringify(join(temp,"result.json"))},JSON.stringify({passed:false,error:String(error),stack:error.stack}));app.quit();}
}));
import(${JSON.stringify(pathToFileURL(join(client,"dist/src/main/index.js")).href)});
`);
const env={...process.env,DCODE_DATA_ROOT:dataRoot,DCODE_AGENT_DIR:agent,DCODE_USER_DATA:join(temp,"profile"),PI_OFFLINE:"1"};
for(const key of ["ELECTRON_RUN_AS_NODE","DCODE_THEME","DCODE_CAPTURE","DCODE_RENDERER_URL","DCODE_HOST_ENTRY"])delete env[key];
const {stdout,stderr}=await promisify(execFile)(electron,[runner],{cwd:client,env,timeout:60000,maxBuffer:2000000});
const result=JSON.parse(await readFile(join(temp,"result.json"),"utf8"));
console.log(JSON.stringify({temp,...result}));assert.equal(result.passed,true,stderr+stdout);
const restored=await ProductStore.open({dataRoot,userHome:home});
try{const facts=await restored.snapshot();const current=facts.sessions.find(item=>item.taskId===task.id&&item.kind==="coordination");assert.ok(current);assert.equal(facts.composerDrafts.find(item=>item.sessionId===current.id)?.text,"尚未发送的草稿");}
finally{await restored.close();}
