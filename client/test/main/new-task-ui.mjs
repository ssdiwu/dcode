import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import electron from "electron";

const withoutWebGL = process.argv.includes("--without-webgl");
const root = fileURLToPath(new URL("../../", import.meta.url));
const temp = await mkdtemp(join(tmpdir(),"dcode-new-task-ui-"));
await mkdir(join(temp,"agent"));
await writeFile(join(temp,"agent/settings.json"),"{}\n");
await writeFile(join(temp,"a.md"),"# A\n短文件\n");
await writeFile(join(temp,"long-file-name.md"),"# B\n另一个文件\n");
await writeFile(join(temp,"preview.html"),"<!doctype html><h1>菜单叠层验证</h1>");
const runner = join(temp,"runner.cjs");
await writeFile(runner, `
const {app,BrowserWindow,nativeTheme}=require('electron');
const fs=require('node:fs/promises');
const assert=require('node:assert/strict');

// This process owns a hidden independent window, never the user's acceptance app.
BrowserWindow.prototype.show=function(){};
BrowserWindow.prototype.focus=function(){};
app.on('browser-window-created',(_event,win)=>{
 win.webContents.once('did-finish-load',async()=>{
  const run=code=>win.webContents.executeJavaScript(code,true);
  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const until=async(code,label)=>{for(let i=0;i<300;i++){if(await run(code))return;await sleep(30);}throw new Error('Timed out: '+label);};
  const click=label=>run('(()=>{const label='+JSON.stringify(label)+';const b=Array.from(document.querySelectorAll("button")).find(b=>b.getAttribute("aria-label")===label||b.textContent.trim()===label);if(!b)throw new Error("Missing button: "+label);b.click();})()');
  const results=[];
  try{
   await until('!!document.querySelector(".new-task-stage")','real new draft');
   if (${JSON.stringify(withoutWebGL)}) {
     await until('!!document.querySelector(".new-task-ambient canvas")','initial graphics before simulated refusal');
     await click('设置');await until('!document.querySelector(".new-task-ambient canvas")','old renderer disposed');
     // Simulate a browser refusing new WebGL contexts; do not rely on version-specific CLI flags.
     await run('window.webglRefusals=0;const originalContext=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){if(["webgl","webgl2","experimental-webgl"].includes(type)){window.webglRefusals++;return null;}return originalContext.call(this,type,...args);};void 0;');
     await click('返回工作台');await until('window.webglRefusals>0','renderer attempted a refused context');
     await until('!document.querySelector(".new-task-ambient canvas")','WebGL refusal static fallback');
     assert.equal(await run('!!document.querySelector("[data-composer]") && !document.querySelector("[data-composer]").readOnly'),true);
     await fs.writeFile(${JSON.stringify(join(temp,"static-fallback.png"))},(await win.webContents.capturePage()).toPNG());
     await fs.writeFile(${JSON.stringify(join(temp,"result.json"))},JSON.stringify({passed:true,webglContextRefusal:"simulated in Chromium",inputAvailable:true}));
     app.quit();return;
   }

   await until('!!document.querySelector(".new-task-ambient canvas")','original WebGL scene');
   const geometry=await run('(()=>{const c=document.querySelector(".new-task-ambient canvas");const input=document.querySelector("[data-composer]");return {canvas:c.width>0,inputs:!!input,sceneCount:document.querySelectorAll(".new-task-ambient canvas").length,hidden:document.hidden};})()');
   assert.equal(geometry.sceneCount,1);assert.equal(geometry.inputs,true);nativeTheme.themeSource="light";await sleep(80);
   await fs.writeFile(${JSON.stringify(join(temp,"new-task-light.png"))},(await win.webContents.capturePage()).toPNG());
   await click('选择技能或命令');
   await until('!!document.getElementById("composer-commands")','real commands menu');
   assert.equal(await run('document.activeElement===document.querySelector("[data-composer]")'),true);
   assert.equal(await run('document.querySelector("[data-composer]").getAttribute("aria-controls")'),'composer-commands');
   await run('document.querySelector("[data-composer]").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
   await until('!document.getElementById("composer-commands")','Escape closes commands without leaving draft');
   await click('灵感');await until('!document.querySelector(".new-task-ambient")','inspiration excludes scene');
   await click('新建任务');await until('!!document.querySelector(".new-task-ambient canvas")','scene returns');
   await run('(async()=>{for(let attempt=0;;attempt++){const snapshot=await window.dcode.request("foundation.snapshot");try{await window.dcode.request("project.create",{requestId:"ui-project",expectedStoreRevision:snapshot.storeRevision,title:"UI 测试项目",directory:'+JSON.stringify(${JSON.stringify(temp)})+'});break;}catch(error){if(attempt>=5||!String(error).includes("REVISION_CONFLICT"))throw error;await new Promise(resolve=>setTimeout(resolve,50));}}})()');
   await sleep(200);
   await run('document.querySelector(".scope-tray button").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",code:"Enter",bubbles:true}))');
   await until('Array.from(document.querySelectorAll("[role=menuitem]")).some(item=>item.textContent.trim()==="UI 测试项目")','project scope menu');
   await run('Array.from(document.querySelectorAll("[role=menuitem]")).find(item=>item.textContent.trim()==="UI 测试项目").click()');
   await until('!!Array.from(document.querySelectorAll("button")).find(b=>b.getAttribute("aria-label")==="文件与 Git")','project file action before task');
   await click('文件与 Git');await until('!!document.querySelector(".files-workspace")','project files before creation');
   assert.equal(await run('!!document.querySelector(".new-task-ambient")'),false);
   await until('Array.from(document.querySelectorAll(".file-tree-row")).some(b=>b.textContent.trim()==="a.md")','project file listing loaded');
   await click('a.md');await until('!!document.querySelector(".file-tab-highlight")','selected file highlight');
   await click('long-file-name.md');await until('document.querySelector(".file-tab-strip [aria-selected=true]")?.textContent.includes("long-file-name.md")','second file selected');await sleep(300);
   await run('Array.from(document.querySelectorAll(".file-tab-strip [role=tab]")).find(b=>b.textContent.trim()==="a.md").click()');
   const movingPill=await run('new Promise(resolve=>requestAnimationFrame(()=>{const p=document.querySelector(".file-tab-highlight").getBoundingClientRect(),b=document.querySelector(".file-tab-strip [aria-selected=true]").getBoundingClientRect();resolve({left:p.left,targetLeft:b.left,width:p.width,targetWidth:b.width});}))');
   assert.ok(Math.abs(movingPill.left-movingPill.targetLeft)>1||Math.abs(movingPill.width-movingPill.targetWidth)>1,'file highlight moves before settling');
   await sleep(350);
   assert.equal(await run('document.querySelector(".file-tab-strip [aria-selected=true]")?.textContent.trim()'),'a.md');
   const pill=await run('(()=>{const p=document.querySelector(".file-tab-highlight").getBoundingClientRect(),b=document.querySelector(".file-tab-strip [aria-selected=true]").getBoundingClientRect();return {left:p.left,targetLeft:b.left,width:p.width,targetWidth:b.width};})()');
   assert.ok(Math.abs(pill.left-pill.targetLeft)<1&&Math.abs(pill.width-pill.targetWidth)<1);
   await click('preview.html');await until('!!document.querySelector(".html-preview-surface")','HTML preview surface');
   const previewVisible=()=>win.contentView.children.some(view=>view.webContents&&view.webContents!==win.webContents&&view.getBounds().width>0&&view.getBounds().height>0);
   for(let i=0;i<100&&!previewVisible();i++)await sleep(30);assert.equal(previewVisible(),true);
   await click('选择技能或命令');await until('!!document.getElementById("composer-commands")','commands over native HTML');
   for(let i=0;i<100&&previewVisible();i++)await sleep(30);assert.equal(previewVisible(),false,'native preview yields to command menu');
   await run('document.querySelector("[data-composer]").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
   for(let i=0;i<100&&!previewVisible();i++)await sleep(30);assert.equal(previewVisible(),true,'native preview restores after menu');

   await click('文件与 Git');await until('!!document.querySelector(".new-task-ambient canvas")','return from files to draft');
   await run('(async()=>{for(let attempt=0;;attempt++){const snapshot=await window.dcode.request("foundation.snapshot");try{await window.dcode.request("task.create",{requestId:"ui-empty-task",expectedStoreRevision:snapshot.storeRevision,scope:{kind:"user",userId:snapshot.currentUser.id},title:"已有空任务",goal:"验证既有任务边界",acceptance:[]});break;}catch(error){if(attempt>=5||!String(error).includes("REVISION_CONFLICT"))throw error;await new Promise(resolve=>setTimeout(resolve,50));}}})()');
   await until('Array.from(document.querySelectorAll("button")).some(b=>b.textContent.includes("已有空任务"))','real empty task appears');
   await run('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.includes("已有空任务")).click()');
   await until('!document.querySelector(".new-task-ambient")','existing empty task excludes scene');
   await click('新建任务');await until('!!document.querySelector(".new-task-stage")','new draft after task');
   await run('(()=>{const t=document.querySelector("[data-composer]");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(t,"保留新任务草稿");t.dispatchEvent(new Event("input",{bubbles:true}));})()');
   await click('返回任务');await until('!document.querySelector(".new-task-stage")','return to actual task');
   await click('新建任务');await until('document.querySelector("[data-composer]")?.value==="保留新任务草稿"','draft retained');
   await click('设置');await until('!!document.querySelector(".settings-workbench")','settings');
   await click('外观');
   await run('window.themeFrames=[];const oldAnimate=Element.prototype.animate;Element.prototype.animate=function(frames,options){if(options?.pseudoElement==="::view-transition-new(root)")window.themeFrames.push(frames);return oldAnimate.call(this,frames,options);};void 0;');
   nativeTheme.themeSource='light';await sleep(60);
   const center=await run('(()=>{const b=Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==="深色");const r=b.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2];})()');
   await click('深色');await until('window.themeFrames.length>0','theme transition begins');
   await until('!document.documentElement.classList.contains("theme-changing")','theme transition settles');
   assert.equal(nativeTheme.shouldUseDarkColors,true);
   const frame=await run('window.themeFrames[0].clipPath[0]');
   assert.equal(frame,'circle(0px at '+center[0]+'px '+center[1]+'px)');
   const pref=await run('window.dcode.request("clientPreferences.get")');assert.equal(pref.appearance,'dark');
   const scaleChecks=[];
   for (const [label,zoom,theme] of [['紧凑',.92,'浅色'],['标准',1,'深色'],['大',1.12,'浅色']]) {
     await click(label);for(let i=0;i<100&&Math.abs(win.webContents.getZoomFactor()-zoom)>.001;i++)await sleep(20);
     assert.ok(Math.abs(win.webContents.getZoomFactor()-zoom)<.001);
     await until('Array.from(document.querySelectorAll(".segments button")).some(b=>b.textContent.trim()==='+JSON.stringify(theme)+'&&!b.disabled)','appearance available after font scale');
     await sleep(40);
     const origin=await run('(()=>{const b=Array.from(document.querySelectorAll(".segments button")).find(b=>b.textContent.trim()==='+JSON.stringify(theme)+');const r=b.getBoundingClientRect();window.themeFrames=[];return [r.left+r.width/2,r.top+r.height/2];})()');
     await click(theme);await until('window.themeFrames.length>0&&!document.documentElement.classList.contains("theme-changing")','scaled theme transition');
     const clip=await run('window.themeFrames[0].clipPath[0]');assert.equal(clip,'circle(0px at '+origin[0]+'px '+origin[1]+'px)');
     scaleChecks.push({label,zoom,origin,clip});
   }
   await click('系统');await until('!document.documentElement.classList.contains("theme-changing")&&Array.from(document.querySelectorAll(".segments button")).some(b=>b.textContent.trim()==="系统"&&b.getAttribute("aria-pressed")==="true"&&!b.disabled)','system preference saved');
   assert.equal(nativeTheme.themeSource,'system');
   assert.equal(await run('matchMedia("(prefers-color-scheme:dark)").matches'),nativeTheme.shouldUseDarkColors);
   await click('标准');for(let i=0;i<100&&Math.abs(win.webContents.getZoomFactor()-1)>.001;i++)await sleep(20);
   await until('Array.from(document.querySelectorAll(".segments button")).some(b=>b.textContent.trim()==="深色"&&!b.disabled)','appearance ready');
   await click('深色');await until('!document.documentElement.classList.contains("theme-changing")&&Array.from(document.querySelectorAll(".segments button")).some(b=>b.textContent.trim()==="深色"&&b.getAttribute("aria-pressed")==="true"&&!b.disabled)','dark restored');

   await click('返回工作台');await until('!!document.querySelector(".new-task-ambient canvas")','new scene after settings');
   await sleep(200);
   await fs.writeFile(${JSON.stringify(join(temp,"new-task-dark.png"))},(await win.webContents.capturePage()).toPNG());
   win.setContentSize(960,700);await sleep(100);
   assert.ok(await run('(()=>{const c=document.querySelector(".new-task-ambient canvas"),r=c.getBoundingClientRect();return Math.abs(c.width-r.width*Math.min(devicePixelRatio,2))<2;})()'));
   win.webContents.debugger.attach('1.3');
   await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
   await until('!document.querySelector(".new-task-ambient canvas")','reduced motion static fallback');
   assert.ok(await run('!!document.querySelector("[data-composer]")'));
   await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
   await until('!!document.querySelector(".new-task-ambient canvas")','motion restored');
   await run('document.querySelector(".new-task-ambient canvas").dispatchEvent(new Event("webglcontextlost"))');
   await until('!document.querySelector(".new-task-ambient canvas")','context loss static fallback');
   assert.ok(await run('!!document.querySelector("[data-composer]")'));
   results.push({newDraft:geometry,scope:'inspiration/settings/existing empty task excluded',projectDraftFiles:'open and close before task creation',commandMenuOverHTML:true,fileTabMotion:{start:movingPill,end:pill},draft:'return preserves input',theme:{center,frame,persisted:pref.appearance,scales:scaleChecks,system:true},reducedMotion:'static with input available',contextLoss:'static with input available',resize:'passed'});
   await fs.writeFile(${JSON.stringify(join(temp,"result.json"))},JSON.stringify({passed:true,results},null,2));
   app.quit();
  }catch(error){console.error(error);await fs.writeFile(${JSON.stringify(join(temp,"failure.png"))},(await win.webContents.capturePage()).toPNG());await fs.writeFile(${JSON.stringify(join(temp,"result.json"))},JSON.stringify({passed:false,error:String(error)}));app.quit();}
 });
});
import(${JSON.stringify(pathToFileURL(join(root,"dist/src/main/index.js")).href)});
`);
const env={...process.env,DCODE_DATA_ROOT:join(temp,".dcode"),DCODE_AGENT_DIR:join(temp,"agent"),DCODE_USER_DATA:join(temp,"profile"),DCODE_WIDTH:"1440",PI_OFFLINE:"1"};
delete env.ELECTRON_RUN_AS_NODE;delete env.DCODE_THEME;delete env.DCODE_CAPTURE;delete env.DCODE_RENDERER_URL;
const {stdout,stderr}=await promisify(execFile)(electron,[runner],{cwd:root,env,timeout:90000,maxBuffer:2_000_000});
const result=JSON.parse(await readFile(join(temp,"result.json"),"utf8"));
console.log(JSON.stringify({temp,...result}));
assert.equal(result.passed,true,stderr+stdout);
