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
const temp=await mkdtemp(join(tmpdir(),"dcode-child-header-"));
const projectDirectory=join(temp,"a-long-project-directory-for-source-and-header-checks");
await mkdir(projectDirectory);
await mkdir(join(temp,"agent"));
const store=await ProductStore.open({dataRoot:join(temp,".dcode"),userHome:temp});
let task,children;
try{
  const project=await store.createProject({requestId:"header-project",expectedStoreRevision:0,
    title:"0.0.36 工作台长标题与子成员对话返回验证项目",directory:projectDirectory});
  task=await store.createTask({requestId:"header-task",expectedStoreRevision:project.storeRevision,
    scope:{kind:"project",projectId:project.project.id},
    title:"0.0.36 路线验收：目标是实现满足 SPEC.md 的 NDJSON 解码，请读取材料并核对所有边界条件",
    goal:"验证长任务标题中的子成员返回主对话入口"});
  const team=await store.createTeamRun({requestId:"header-members",taskId:task.task.id,scope:task.task.scope,
    members:[
      {profileId:"builtin-explore",title:"Implement NDJSON decoder after 90-second marker pause with retained evidence",taskPacket:{objective:"只读布局样本"}},
      {profileId:"builtin-verifier",title:"独立核查修复后的 NDJSON 解码器与空白行处理，保留原始验证证据",taskPacket:{objective:"只读布局样本"}},
    ]});
  children=team.childSessions;
  const snapshot=await store.snapshot();
  await store.patchTaskWorkbenchViewState({requestId:"header-select",expectedStoreRevision:snapshot.storeRevision,
    expectedViewStateRevision:snapshot.taskWorkbenchViewState.revision,
    patch:{selection:{taskId:task.task.id,sessionId:children[0].id}}});
}finally{await store.close();}

let hostSource=await readFile(join(host,"index.js"),"utf8");
hostSource=hostSource.replace(/^#!.*\n/,"").replace(/from "\.\//g,`from "${pathToFileURL(host+"/").href}`)
  .replace("const host = new PiHost({",`const host = new PiHost({userHome:${JSON.stringify(temp)},`);
const hostEntry=join(temp,"host.mjs");
await writeFile(hostEntry,hostSource);

const runner=join(temp,"runner.cjs");
await writeFile(runner,`
const {app,BrowserWindow}=require("electron"),fs=require("node:fs/promises"),assert=require("node:assert/strict");
BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.focus=function(){};
app.once("browser-window-created",(_event,win)=>win.webContents.once("did-finish-load",async()=>{
 const run=code=>win.webContents.executeJavaScript(code,true),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const until=async(code,label)=>{for(let i=0;i<300;i++){if(await run(code))return;await sleep(25);}throw Error("Timeout "+label);};
 const screenshot=async name=>fs.writeFile(${JSON.stringify(temp)}+"/"+name,(await win.webContents.capturePage()).toPNG());
 const selectChild=async title=>{await until('Array.from(document.querySelectorAll(".child-sessions button")).some(button=>button.textContent.trim()==='+JSON.stringify(title)+')',"child entry");await run('Array.from(document.querySelectorAll(".child-sessions button")).find(button=>button.textContent.trim()==='+JSON.stringify(title)+').click()');await until('document.querySelector(".workspace-session strong")?.textContent==='+JSON.stringify(title),"child header");};
 const prefs=async(value)=>run('(async()=>{const requestId=crypto.randomUUID();for(let attempt=0;;attempt++){const snapshot=await window.dcode.request("foundation.snapshot");try{return await window.dcode.request("clientPreferences.set",{requestId,expectedStoreRevision:snapshot.storeRevision,...'+JSON.stringify(value)+'});}catch(error){if(attempt>=6||!String(error).includes("REVISION_CONFLICT"))throw error;}}})()');
 const geometry=()=>run('(()=>{const bar=document.querySelector(".workspace-bar"),session=document.querySelector(".workspace-session"),button=session.querySelector("button"),title=session.querySelector("strong"),task=document.querySelector(".workspace-title");const rect=el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};const range=document.createRange();range.selectNodeContents(button);return {bar:rect(bar),button:rect(button),title:rect(title),task:rect(task),text:rect({getBoundingClientRect:()=>range.getBoundingClientRect()}),whiteSpace:getComputedStyle(button).whiteSpace,overflow:document.documentElement.scrollWidth>innerWidth,innerWidth};})()');
 try{
  await until('!!document.querySelector(".workspace-session")',"restored child Session");
  await run('document.querySelectorAll(".project-group,.child-sessions").forEach(details=>details.open=true)');
  const rows=[];
  for(const appearance of ["dark","light"]){
   for(const fontScale of ["standard","large"]){
    await prefs({appearance,fontScale});await sleep(120);
    for(const width of [1440,1024,800]){
     win.setContentSize(width,820);await sleep(80);
     for(const title of ${JSON.stringify(children.map(child=>child.title))}){
      await selectChild(title);
      const value=await geometry();const label=JSON.stringify({appearance,fontScale,width,title,value});
      assert.ok(value.text.height<=value.button.height+.5,"return text must stay on one line: "+label);
      assert.ok(value.button.top>=value.bar.top-.5&&value.button.bottom<=value.bar.bottom+.5,"return button must stay inside header: "+label);
      assert.ok(value.button.width>=40&&value.title.width>=24,"return action and child label remain usable: "+label);
      assert.ok(value.title.right<=value.bar.right+.5&&!value.overflow,"header must not overflow: "+label);
      rows.push({appearance,fontScale,width,...value});
     }
    }
   }
  }
  await screenshot("child-header-narrow.png");
  await prefs({appearance:"dark",fontScale:"standard"});win.setContentSize(1440,820);await sleep(120);
  await screenshot("child-header-wide.png");
  await run('document.querySelector("[aria-label=返回主对话]").click()');
  await until('!document.querySelector(".workspace-session")',"return to main dialogue");
  await until('document.querySelectorAll(".task-row[aria-current=page]").length===1',"one current Task after return");
  await fs.writeFile(${JSON.stringify(join(temp,"result.json"))},JSON.stringify({passed:true,cases:rows.length,returnedToMain:true,rows}));
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
try{processResult=await promisify(execFile)(electron,[runner],{cwd:client,env,timeout:90000,maxBuffer:1_000_000});}
catch(error){processResult=error;}
const result=JSON.parse(await readFile(join(temp,"result.json"),"utf8"));
console.log(JSON.stringify({temp,...result}));
assert.equal(result.passed,true,JSON.stringify(processResult));
