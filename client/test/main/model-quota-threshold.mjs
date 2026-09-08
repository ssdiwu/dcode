import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {mkdtemp,mkdir,writeFile,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import electron from "electron";
const client=fileURLToPath(new URL("../../",import.meta.url));
const temp=await mkdtemp(join(tmpdir(),"dcode-quota-ui-"));await mkdir(join(temp,"agent"));await writeFile(join(temp,"agent/settings.json"),"{}\n");
const runner=join(temp,"runner.cjs");
await writeFile(runner,`
const{app,BrowserWindow,nativeTheme}=require('electron');const fs=require('node:fs/promises');const assert=require('node:assert/strict');
// This process owns one hidden Electron window. No test .app, auth prompt or LS registration.
BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.focus=function(){};
app.on('browser-window-created',(_event,win)=>win.webContents.once('did-finish-load',async()=>{
 const run=code=>win.webContents.executeJavaScript(code,true),sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const until=async(code,label)=>{for(let i=0;i<400;i++){if(await run(code))return;await sleep(25);}throw Error('Timeout '+label);};
 const select='Array.from(document.querySelectorAll("select")).find(s=>s.getAttribute("aria-label")==="自动选择的剩余额度门槛")';
 const click=label=>run('(()=>{const b=Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==='+JSON.stringify(label)+');if(!b)throw Error("Button missing");b.click();})()');
 const set=async value=>{await until(select+'&&!'+select+'.disabled','threshold enabled');await run('(()=>{const s='+select+';s.value='+JSON.stringify(String(value))+';s.dispatchEvent(new Event("change",{bubbles:true}));})()');await until(select+'.value==='+JSON.stringify(String(value))+'&&!'+select+'.disabled','threshold persisted '+value);assert.equal((await run('window.dcode.request("clientPreferences.get",{})')).modelQuotaThresholdPercent,value);};
 try{
  await until('!!document.querySelector(".new-task-stage")&&!document.body.textContent.includes("正在读取模型")','startup');await sleep(150);await click('设置');await click('模型');
  await until(select+'&&!'+select+'.disabled','control');assert.equal(await run(select+'.value'),'1');
  assert.deepEqual(await run('Array.from('+select+'.options).map(o=>Number(o.value))'),Array.from({length:30},(_,i)=>i+1));
  await set(30);await set(1);await set(20);
  // Native select selection via synthetic keys could not be verified while
  // the hidden BrowserWindow was not a key window. Preserve that boundary.
  await set(21);
  assert.equal((await run('window.dcode.request("clientPreferences.get",{})')).modelQuotaThresholdPercent,21);
  win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
  for(const theme of ['light','dark']){nativeTheme.themeSource=theme;await sleep(100);await fs.writeFile(${JSON.stringify(temp)}+'/quota-'+theme+'.png',(await win.webContents.capturePage()).toPNG());}
  const focus=await run('(()=>{const s='+select+';s.focus();const c=getComputedStyle(s);return {outline:c.outlineStyle,boxShadow:c.boxShadow};})()');
  assert.equal(focus.outline,'none');assert.notEqual(focus.boxShadow,'none');
  await click('智能体档案');await until('document.querySelector(".model-route-editor")?.textContent.includes("高于 21%")','route threshold');
  await run('(async()=>{const s=await window.dcode.request("foundation.snapshot",{});await window.dcode.request("clientPreferences.set",{requestId:"external-threshold",expectedStoreRevision:s.storeRevision,modelQuotaThresholdPercent:22});})()');
  await until('document.querySelector(".model-route-editor")?.textContent.includes("高于 22%")','route reflects Host settings event');
  await click('模型');await until(select+'.value==="22"','models agrees');
  const reload=new Promise(resolve=>win.webContents.once('did-finish-load',resolve));win.webContents.reload();await reload;await until('!!document.querySelector(".settings-workbench")||!!document.querySelector(".new-task-stage")','renderer restored');
  if(!await run('!!document.querySelector(".settings-workbench")'))await click('设置');await click('模型');await until(select+'?.value==="22"','persisted after renderer reload');
  win.setContentSize(960,700);await sleep(100);assert.ok(await run('document.documentElement.scrollWidth<=innerWidth'));
  assert.equal(BrowserWindow.getAllWindows().length,1);
  await fs.writeFile(${JSON.stringify(join(temp,"result.json"))},JSON.stringify({passed:true,actualHost:true,thresholds:[1,30,20,21,22],keyboardSelection:"unverified: hidden window is not a key window",range:30,themes:2,routeUpdate:true,reload:true,focus,focusEmulated:true,windowCount:1}));app.quit();
 }catch(error){await fs.writeFile(${JSON.stringify(join(temp,"failure.png"))},(await win.webContents.capturePage()).toPNG());await fs.writeFile(${JSON.stringify(join(temp,"result.json"))},JSON.stringify({passed:false,error:String(error),stack:error.stack}));app.quit();}
}));
import(${JSON.stringify(pathToFileURL(join(client,"dist/src/main/index.js")).href)});
`);
const env={...process.env,DCODE_DATA_ROOT:join(temp,".dcode"),DCODE_AGENT_DIR:join(temp,"agent"),DCODE_USER_DATA:join(temp,"profile"),DCODE_WIDTH:"1440",PI_OFFLINE:"1"};
for(const key of ["ELECTRON_RUN_AS_NODE","DCODE_THEME","DCODE_CAPTURE","DCODE_RENDERER_URL","DCODE_HOST_ENTRY"])delete env[key];
const{stdout,stderr}=await promisify(execFile)(electron,[runner],{cwd:client,env,timeout:90000,maxBuffer:2_000_000});
const result=JSON.parse(await readFile(join(temp,"result.json"),"utf8"));console.log(JSON.stringify({temp,...result}));assert.equal(result.passed,true,stderr+stdout);
