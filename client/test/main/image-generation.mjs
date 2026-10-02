import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {mkdtemp,mkdir,readFile,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import electron from "electron";
import {ProductStore} from "../../../host/dist/src/product-store.js";

// Exercise the real App header and return action with isolated product data.
const client=fileURLToPath(new URL("../..",import.meta.url));
const host=join(client,"../host/dist/src");
const temp=await mkdtemp(join(tmpdir(),"dcode-image-window-"));
const projectDirectory=join(temp,"a-long-project-directory-for-source-and-header-checks");
await mkdir(projectDirectory);
await mkdir(join(temp,"agent"));
const store=await ProductStore.open({dataRoot:join(temp,".dcode"),userHome:temp});
let task,children;
try{
  const project=await store.createProject({requestId:"header-project",expectedStoreRevision:0,
    title:"0.0.37 图像生成验收项目",directory:projectDirectory});
  task=await store.createTask({requestId:"header-task",expectedStoreRevision:project.storeRevision,
    scope:{kind:"project",projectId:project.project.id},
    title:"0.0.37 任务内单图生成与产物归档验收",
    goal:"验证单图生成、预览、附件与项目导出"});
  const team=await store.createTeamRun({requestId:"header-members",taskId:task.task.id,scope:task.task.scope,
    members:[
      {profileId:"builtin-explore",title:"Implement NDJSON decoder after 90-second marker pause with retained evidence",taskPacket:{objective:"只读布局样本"}},
      {profileId:"builtin-verifier",title:"独立核查修复后的 NDJSON 解码器与空白行处理，保留原始验证证据",taskPacket:{objective:"只读布局样本"}},
    ]});
  children=team.childSessions;
  const snapshot=await store.snapshot();
  await store.patchTaskWorkbenchViewState({requestId:"header-select",expectedStoreRevision:snapshot.storeRevision,
    expectedViewStateRevision:snapshot.taskWorkbenchViewState.revision,
    patch:{selection:{taskId:task.task.id,sessionId:task.coordinationSession.id}}});
}finally{await store.close();}

let hostSource=await readFile(join(host,"index.js"),"utf8");
hostSource=hostSource.replace(/^#!.*\n/,"").replace(/from "\.\//g,`from "${pathToFileURL(host+"/").href}`)
  .replace("const host = new PiHost({",`const host = new PiHost({userHome:${JSON.stringify(temp)},`);
if(process.env.DCODE_TEST_LIVE_IMAGE!=='1'){
 hostSource=hostSource.replace('const host = new PiHost({','const host = new PiHost({imageBackendFactory:async signal=>{let requested=false;return {get turnRequested(){return requested;},capability:async()=>({available:true,experimental:true,quota:"unknown",plan:"pro"}),login:async()=>{},close:async()=>{},generate:async(description,language,submitted)=>{requested=true;await submitted({threadId:"image-test-thread",turnId:"image-test-turn"});return {threadId:"image-test-thread",turnId:"image-test-turn",data:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="};}}},');
}
const hostEntry=join(temp,"host.mjs");
await writeFile(hostEntry,hostSource);

const runner=join(temp,"runner.cjs");
await writeFile(runner,`
const {app,BrowserWindow,dialog}=require("electron"),fs=require("node:fs/promises"),assert=require("node:assert/strict");
BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.focus=function(){};
app.once("browser-window-created",(_event,win)=>win.webContents.once("did-finish-load",async()=>{
 const run=code=>win.webContents.executeJavaScript(code,true),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const until=async(code,label)=>{await fs.writeFile(${JSON.stringify(join(temp,"progress.json"))},JSON.stringify({label,body:await run("document.body.innerText.slice(0,3500)")}));for(let i=0;i<14000;i++){if(await run(code))return;await sleep(25);}throw Error("Timeout "+label);};
 const screenshot=async name=>fs.writeFile(${JSON.stringify(temp)}+"/"+name,(await win.webContents.capturePage()).toPNG());
 const selectChild=async title=>{await until('Array.from(document.querySelectorAll(".child-sessions button")).some(button=>button.textContent.trim()==='+JSON.stringify(title)+')',"child entry");await run('Array.from(document.querySelectorAll(".child-sessions button")).find(button=>button.textContent.trim()==='+JSON.stringify(title)+').click()');await until('document.querySelector(".workspace-session strong")?.textContent==='+JSON.stringify(title),"child header");};
 const prefs=async(value)=>run('(async()=>{const requestId=crypto.randomUUID();for(let attempt=0;;attempt++){const snapshot=await window.dcode.request("foundation.snapshot");try{return await window.dcode.request("clientPreferences.set",{requestId,expectedStoreRevision:snapshot.storeRevision,...'+JSON.stringify(value)+'});}catch(error){if(attempt>=6||!String(error).includes("REVISION_CONFLICT"))throw error;}}})()');
 const geometry=()=>run('(()=>{const bar=document.querySelector(".workspace-bar"),session=document.querySelector(".workspace-session"),button=session.querySelector("button"),title=session.querySelector("strong"),task=document.querySelector(".workspace-title");const rect=el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};const range=document.createRange();range.selectNodeContents(button);return {bar:rect(bar),button:rect(button),title:rect(title),task:rect(task),text:rect({getBoundingClientRect:()=>range.getBoundingClientRect()}),whiteSpace:getComputedStyle(button).whiteSpace,overflow:document.documentElement.scrollWidth>innerWidth,innerWidth};})()');
 try{
  dialog.showSaveDialog=async()=>({canceled:false,filePath:${JSON.stringify(join(projectDirectory,"generated-export.png"))}});
  await until('!!document.querySelector("[data-composer]")',"main composer");
  await run('(()=>{const input=document.querySelector("[data-composer]");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(input,"普通消息草稿 KEEP");input.dispatchEvent(new Event("input",{bubbles:true}));})()');
  const openImages=async()=>{await run('document.querySelector("[aria-label=添加内容]").dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,button:0,pointerType:"mouse"}))');await until('Array.from(document.querySelectorAll("[role=menuitem]")).some(item=>item.textContent.includes("生成图片"))',"image menu");await run('Array.from(document.querySelectorAll("[role=menuitem]")).find(item=>item.textContent.includes("生成图片")).click()');await until('!!document.querySelector(".image-generation-panel")',"image panel");};
  await openImages();await run('document.querySelector("[aria-label=关闭图像生成]").click()');
  const before=await run('(async()=>{return await window.dcode.request("imageGeneration.list",{taskId:${JSON.stringify(task.task.id)}});})()');assert.equal(before.generations.length,0,"opening and cancelling does not submit");
  await openImages();
  await run('(()=>{const input=document.querySelector("[aria-label=图像描述]");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(input,"Generate exactly one simple flat illustration of a warm copper mug on a pale green background. No text. No reference images.");input.dispatchEvent(new Event("input",{bubbles:true}));})()');
  await run('Array.from(document.querySelectorAll(".image-generation-panel button")).find(button=>button.textContent.trim()==="生成一张").click()');
  await until('!!document.querySelector("[data-generation-state=succeeded]")',"generated image saved");
  assert.equal(await run('document.querySelector("[data-composer]").value'),"普通消息草稿 KEEP");
  await run('Array.from(document.querySelectorAll(".image-generation-panel button")).find(button=>button.textContent.includes("预览生成图片")).click()');await until('document.querySelector(".image-preview-dialog img")?.naturalWidth>0',"image preview decoded");
  const dimensions=await run('(()=>{const image=document.querySelector(".image-preview-dialog img");return {width:image.naturalWidth,height:image.naturalHeight};})()');await screenshot("image-preview.png");
  await run('document.querySelector("[aria-label=关闭图片预览]").click()');
  await run('Array.from(document.querySelectorAll(".image-generation-panel button")).find(button=>button.textContent.includes("用作输入附件")).click()');await until('!!document.querySelector(".attachments")',"generated image attached");
  assert.equal(await run('document.querySelector("[data-composer]").value'),"普通消息草稿 KEEP");
  await run('Array.from(document.querySelectorAll(".image-generation-panel button")).find(button=>button.textContent.includes("导出图片")).click()');await until('(async()=>{try{return (await window.dcode.request("workspace.read",{source:{taskId:${JSON.stringify(task.task.id)}},path:"generated-export.png"})).kind==="image";}catch{return false;}})()',"exported Project image");
  await screenshot("image-panel-completed.png");
  const data=await run('(async()=>{const list=await window.dcode.request("imageGeneration.list",{taskId:${JSON.stringify(task.task.id)}});const generation=list.generations[0];const image=await window.dcode.request("imageGeneration.image",{taskId:${JSON.stringify(task.task.id)},generationId:generation.id});return {generationId:generation.id,artifactId:image.artifactId,bytes:image.bytes,digest:image.digest};})()');
  await fs.writeFile(${JSON.stringify(join(temp,"result.json"))},JSON.stringify({passed:true,dimensions,...data,ordinaryDraftRetained:true,attachment:true,exported:true}));
  app.quit();
 }catch(error){await screenshot("failure.png").catch(()=>{});await fs.writeFile(${JSON.stringify(join(temp,"result.json"))},JSON.stringify({passed:false,error:String(error),stack:error.stack}));app.exit(1);}
}));
import(${JSON.stringify(pathToFileURL(join(client,"dist/src/main/index.js")).href)});
`);
const env={...process.env,DCODE_HOST_ENTRY:hostEntry,DCODE_DATA_ROOT:join(temp,".dcode"),DCODE_AGENT_DIR:join(temp,"agent"),
  DCODE_USER_DATA:join(temp,"profile"),DCODE_WIDTH:"1440",PI_OFFLINE:"1"};
for(const name of ["ELECTRON_RUN_AS_NODE","DCODE_RENDERER_URL","DCODE_CAPTURE","DCODE_THEME"])
  delete env[name];
let processResult;
try{processResult=await promisify(execFile)(electron,[runner],{cwd:client,env,timeout:420000,maxBuffer:1_000_000});}
catch(error){processResult=error;}
const result=JSON.parse(await readFile(join(temp,"result.json"),"utf8"));
console.log(JSON.stringify({temp,...result}));
assert.equal(result.passed,true,JSON.stringify(processResult));
