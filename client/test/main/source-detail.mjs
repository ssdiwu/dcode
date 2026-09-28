import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import electron from "electron";
import { ProductStore } from "../../../host/dist/src/product-store.js";

const client=fileURLToPath(new URL("../../",import.meta.url));
const temp=await mkdtemp(join(tmpdir(),"dcode-source-detail-ui-")),home=join(temp,"home"),agent=join(temp,"agent"),dataRoot=join(home,".dcode");
await mkdir(home);await mkdir(agent);await writeFile(join(agent,"settings.json"),"{}\n");
const store=await ProductStore.open({dataRoot,userHome:home});
let snapshot=await store.snapshot();const scope={kind:"user",userId:snapshot.currentUser.id};
const {task,coordinationSession}=await store.createTask({requestId:"task",expectedStoreRevision:snapshot.storeRevision,scope,title:"来源回查窗口",goal:"只打开已引用的旧灵感版本"});
const nodeId=`idea-${randomUUID()}`;
snapshot=await store.snapshot();await store.mutateInspiration({requestId:"v1",expectedStoreRevision:snapshot.storeRevision,operation:{kind:"save",node:{id:nodeId,kind:"text",title:"旧版依据",markdown:"第一版是当时实际引用的内容"},expectedNodeRevision:0}});
snapshot=await store.snapshot();await store.referenceInspiration({requestId:"reference",expectedStoreRevision:snapshot.storeRevision,taskId:task.id,nodeId,nodeRevision:1});
snapshot=await store.snapshot();await store.mutateInspiration({requestId:"v2",expectedStoreRevision:snapshot.storeRevision,operation:{kind:"save",node:{id:nodeId,kind:"text",title:"旧版依据",markdown:"第二版不能冒充旧来源"},expectedNodeRevision:1}});
snapshot=await store.snapshot();await store.patchTaskWorkbenchViewState({requestId:"select",expectedStoreRevision:snapshot.storeRevision,expectedViewStateRevision:snapshot.taskWorkbenchViewState.revision,patch:{selection:{taskId:task.id,sessionId:coordinationSession.id}}});
await store.close();

const runner=join(temp,"runner.cjs");
await writeFile(runner,`
const {app,BrowserWindow,nativeTheme}=require('electron');const fs=require('node:fs/promises');const assert=require('node:assert/strict');
BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.focus=function(){};
app.on('browser-window-created',(_event,win)=>win.webContents.once('did-finish-load',async()=>{
 const run=code=>win.webContents.executeJavaScript(code,true),sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const until=async(code)=>{for(let i=0;i<200;i++){if(await run(code))return;await sleep(30);}throw Error('Source detail UI timeout');};
 try{
  await until('!!document.querySelector(".idea-context-tag")');
  await run('document.querySelector(".idea-context-tag").click()');
  await until('!!document.querySelector(".source-detail-text")');
  assert.ok(await run('document.querySelector(".source-detail-text").textContent.includes("第一版是当时实际引用的内容")'));
  assert.ok(!await run('document.querySelector(".source-detail-text").textContent.includes("第二版不能冒充旧来源")'));
  assert.ok(await run('document.querySelector(".source-detail").textContent.includes("当前节点已到第 2 版")'));
  for(const theme of ['light','dark']){nativeTheme.themeSource=theme;await sleep(120);win.setContentSize(1100,760);await fs.writeFile(${JSON.stringify(temp)}+'/source-'+theme+'.png',(await win.webContents.capturePage()).toPNG());}
  win.setContentSize(960,700);await sleep(120);assert.ok(await run('document.documentElement.scrollWidth<=innerWidth'));
  await run('document.querySelector(".source-detail .icon-button").click()');
  assert.ok(await run('!document.querySelector(".source-detail") && !!document.querySelector("[data-composer]")'));
  await fs.writeFile(${JSON.stringify(join(temp,"result.json"))},JSON.stringify({passed:true,sourceVersion:1,currentVersion:2,themes:['light','dark'],narrowWidth:960,source:'isolated Product Store'}));app.quit();
 }catch(error){await fs.writeFile(${JSON.stringify(join(temp,"failure.png"))},(await win.webContents.capturePage()).toPNG());await fs.writeFile(${JSON.stringify(join(temp,"result.json"))},JSON.stringify({passed:false,error:String(error),stack:error.stack}));app.quit();}
}));
import(${JSON.stringify(pathToFileURL(join(client,"dist/src/main/index.js")).href)});
`);
const env={...process.env,DCODE_DATA_ROOT:dataRoot,DCODE_AGENT_DIR:agent,DCODE_USER_DATA:join(temp,"profile"),PI_OFFLINE:"1"};
for(const key of ["ELECTRON_RUN_AS_NODE","DCODE_THEME","DCODE_CAPTURE","DCODE_RENDERER_URL","DCODE_HOST_ENTRY"])delete env[key];
const {stdout,stderr}=await promisify(execFile)(electron,[runner],{cwd:client,env,timeout:45000,maxBuffer:2000000});
const result=JSON.parse(await readFile(join(temp,"result.json"),"utf8"));
console.log(JSON.stringify({temp,...result}));assert.equal(result.passed,true,stderr+stdout);
