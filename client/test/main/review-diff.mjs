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
const temp=await mkdtemp(join(tmpdir(),"dcode-review-diff-ui-")),home=join(temp,"home"),projectDirectory=join(home,"project"),agent=join(temp,"agent"),dataRoot=join(home,".dcode");
await mkdir(projectDirectory,{recursive:true});await mkdir(agent);await writeFile(join(agent,"settings.json"),"{}\n");
const git=async(...args)=>promisify(execFile)("git",["-C",projectDirectory,...args]);
await git("init");await writeFile(join(projectDirectory,"note.md"),"before\n");await git("add","note.md");
await git("-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-m","seed");
await writeFile(join(projectDirectory,"note.md"),"after\n");
const store=await ProductStore.open({dataRoot,userHome:home});
let snapshot=await store.snapshot();const project=await store.createProject({requestId:"project",expectedStoreRevision:snapshot.storeRevision,title:"审查项目",directory:projectDirectory});
snapshot=await store.snapshot();const {task,coordinationSession}=await store.createTask({requestId:"task",expectedStoreRevision:snapshot.storeRevision,scope:{kind:"project",projectId:project.project.id},title:"项目差异审查",goal:"审查并修复文件"});
snapshot=await store.snapshot();await store.patchTaskWorkbenchViewState({requestId:"select",expectedStoreRevision:snapshot.storeRevision,expectedViewStateRevision:snapshot.taskWorkbenchViewState.revision,patch:{selection:{taskId:task.id,sessionId:coordinationSession.id}}});await store.close();

const runner=join(temp,"runner.cjs");
await writeFile(runner,`
const {app,BrowserWindow,nativeTheme}=require('electron');const fs=require('node:fs/promises');const assert=require('node:assert/strict');
BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.focus=function(){};
app.on('browser-window-created',(_event,win)=>win.webContents.once('did-finish-load',async()=>{
 const run=code=>win.webContents.executeJavaScript(code,true),sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const until=async(code)=>{for(let i=0;i<250;i++){if(await run(code))return;await sleep(40);}throw Error('Review UI timeout: '+code);};
 const button=label=>'[...document.querySelectorAll("button")].find(x=>x.getAttribute("aria-label")==="'+label+'")';
 try{
  await until('!!'+button('文件与 Git'));
  await run(button('文件与 Git')+'.click()');
  await until('!!'+button('Git 改动'));
  await run(button('Git 改动')+'.click()');
  await until('[...document.querySelectorAll(".git-files button")].some(x=>x.textContent.includes("note.md"))');
  await run('[...document.querySelectorAll(".git-files button")].find(x=>x.textContent.includes("note.md")).click()');
  await until('!!document.querySelector(".git-diff") && [...document.querySelectorAll(".file-toolbar button")].some(x=>x.textContent.includes("发起审查"))');
  await run('[...document.querySelectorAll(".file-toolbar button")].find(x=>x.textContent.includes("发起审查")).click()');
  await until('document.body.textContent.includes("审查已加入当前任务") || document.body.textContent.includes("已保存审查范围")');
  await fs.writeFile(${JSON.stringify(join(projectDirectory,"note.md"))},'after second\\n');
  await run(button('刷新差异')+'.click()');
  await until('document.querySelector(".git-diff")?.textContent.includes("after second")');
  await run('[...document.querySelectorAll(".file-toolbar button")].find(x=>x.textContent.includes("发起审查")).click()');
  await until('window.dcode.request("foundation.snapshot").then(s=>s.taskReviewRequests.length===2)');
  await run(button('任务概览')+'.click()');
  await until('!!document.querySelector(".task-reviews")');
  assert.ok(await run('document.querySelector(".task-reviews").textContent.includes("第 1 次") && document.querySelector(".task-reviews").textContent.includes("第 2 次")'));
  const facts=await run('window.dcode.request("foundation.snapshot").then(s=>({reviewCount:s.taskReviewRequests.length,workItems:s.taskWorkItems.filter(x=>x.taskId==="${task.id}").length,scope:s.tasks.find(x=>x.id==="${task.id}").scope.kind}))');
  assert.equal(facts.reviewCount,2);assert.equal(facts.workItems,2);assert.equal(facts.scope,'project');
  for(const theme of ['light','dark']){nativeTheme.themeSource=theme;await sleep(120);await fs.writeFile(${JSON.stringify(temp)}+'/review-'+theme+'.png',(await win.webContents.capturePage()).toPNG());}
  await fs.writeFile(${JSON.stringify(join(temp,"result.json"))},JSON.stringify({passed:true,...facts,themes:['light','dark']}));app.quit();
 }catch(error){await fs.writeFile(${JSON.stringify(join(temp,"failure.png"))},(await win.webContents.capturePage()).toPNG());await fs.writeFile(${JSON.stringify(join(temp,"result.json"))},JSON.stringify({passed:false,error:String(error),stack:error.stack}));app.quit();}
}));
import(${JSON.stringify(pathToFileURL(join(client,"dist/src/main/index.js")).href)});
`);
const env={...process.env,DCODE_DATA_ROOT:dataRoot,DCODE_AGENT_DIR:agent,DCODE_USER_DATA:join(temp,"profile"),PI_OFFLINE:"1"};
for(const key of ["ELECTRON_RUN_AS_NODE","DCODE_THEME","DCODE_CAPTURE","DCODE_RENDERER_URL","DCODE_HOST_ENTRY"])delete env[key];
const {stdout,stderr}=await promisify(execFile)(electron,[runner],{cwd:client,env,timeout:60000,maxBuffer:2000000});
const result=JSON.parse(await readFile(join(temp,"result.json"),"utf8"));console.log(JSON.stringify({temp,...result}));assert.equal(result.passed,true,stderr+stdout);
