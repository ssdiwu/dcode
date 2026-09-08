import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {mkdtemp,mkdir,writeFile,readFile,readdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import electron from "electron";
const client=fileURLToPath(new URL("../../",import.meta.url)),host=join(client,"../host/dist/src");
const temp=await mkdtemp(join(tmpdir(),"dcode-inline-key-ui-"));await mkdir(join(temp,"agent"));await writeFile(join(temp,"mode"),"failure");await writeFile(join(temp,"stats.json"),JSON.stringify({writes:0,prompts:0}));
const secret="zai-inline-private-fixture-90817";
// Only the vault is fake. UI, preload, sender guard, fd3 and Host are production code.
const adapter=`{
 data:new Map(),tail:Promise.resolve(),
 async list(){return [...this.data].map(([providerId,c])=>({providerId,type:c.type}));},
 async transaction(id,fn,signal){const next=this.tail.then(async()=>{signal?.throwIfAborted();const r=await fn(this.data.get(id));signal?.throwIfAborted();if(r.write!==undefined){const stats=JSON.parse(await testReadFile(${JSON.stringify(join(temp,"stats.json"))},'utf8'));stats.writes++;await testWriteFile(${JSON.stringify(join(temp,"stats.json"))},JSON.stringify(stats));const mode=await testReadFile(${JSON.stringify(join(temp,"mode"))},'utf8');if(mode==='failure')throw Error('vault refused '+(r.write?.key??''));if(mode==='pending')await new Promise(()=>{});if(r.write===null)this.data.delete(id);else this.data.set(id,r.write);}return r.value;});this.tail=next.then(()=>{},()=>{});return next;},
 async prompt(){const stats=JSON.parse(await testReadFile(${JSON.stringify(join(temp,"stats.json"))},'utf8'));stats.prompts++;await testWriteFile(${JSON.stringify(join(temp,"stats.json"))},JSON.stringify(stats));throw Error('Native prompt must not open');},async browser(){throw Error('No browser in API-key path');},async notice(){throw Error('No native notice in API-key path');}
}`;
let entry=await readFile(join(host,"index.js"),"utf8");entry=entry.replace(/from "\.\//g,`from "${pathToFileURL(host+"/").href}`).replace('const host = new PiHost({',`const host = new PiHost({userHome:${JSON.stringify(temp)},modelCredentialAdapter:${adapter},`);
entry=`import {readFile as testReadFile,writeFile as testWriteFile} from 'node:fs/promises';\nconst fixtureStats=JSON.parse(await testReadFile(${JSON.stringify(join(temp,"stats.json"))},'utf8'));fixtureStats.hostPid=process.pid;await testWriteFile(${JSON.stringify(join(temp,"stats.json"))},JSON.stringify(fixtureStats));\n`+entry.replace(/^#!.*\n/,"");const entryPath=join(temp,"host-entry.mjs");await writeFile(entryPath,entry);
const runner=join(temp,"runner.cjs");
await writeFile(runner,`
const{app,BrowserWindow,nativeTheme,ipcMain}=require('electron');const fs=require('node:fs/promises');const assert=require('node:assert/strict');
BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.focus=function(){};
const publicRequests=[],nativeHandle=ipcMain.handle.bind(ipcMain);ipcMain.handle=(channel,handler)=>nativeHandle(channel,(event,...args)=>{if(channel==='dcode:request')publicRequests.push(args);return handler(event,...args);});
app.once('browser-window-created',(_event,win)=>win.webContents.once('did-finish-load',async()=>{
 const run=code=>win.webContents.executeJavaScript(code,true),sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const until=async(code,label)=>{for(let i=0;i<500;i++){if(await run(code))return;await sleep(25);}throw Error('Timeout '+label);};
 const click=label=>run('(()=>{const b=Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==='+JSON.stringify(label)+');if(!b)throw Error("Button missing");b.click();})()');
 const box='document.querySelector('+JSON.stringify('[aria-label="zai-coding-cn 连接"]')+')',input=box+'.querySelector("input[type=password]")';
 const fill=async()=>run('(()=>{const i='+input+';i.focus();i.value='+JSON.stringify(${JSON.stringify(secret)})+';i.dispatchEvent(new Event("input",{bubbles:true}));})()');
 const submit=async()=>{await until(box+'.querySelector("button[type=submit]")&&!'+box+'.querySelector("button[type=submit]").disabled','submit enabled');await run(box+'.querySelector("button[type=submit]").click()');};
 const search=async()=>{await run('(()=>{const i=document.querySelector(".model-search");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(i,"Z.AI Coding");i.dispatchEvent(new Event("input",{bubbles:true}));})()');await until(input,'inline input');};
 try{
  await until('!!document.querySelector(".new-task-stage")&&!document.body.textContent.includes("正在读取模型")','startup');await sleep(150);await click('设置');await click('模型');await search();
  await until(input+'&&!'+input+'.disabled','inline key ready');assert.equal(await run(input+'.type'),'password');assert.equal(await run(input+'.name'),'');
  await fill();await submit();await until(box+'?.textContent.includes("连接失败")','failed save');assert.equal(await run(input+'.value'),${JSON.stringify(secret)});
  assert.equal(await run('document.body.textContent.includes('+JSON.stringify(${JSON.stringify(secret)})+')'),false);
  const stats=()=>fs.readFile(${JSON.stringify(join(temp,"stats.json"))},'utf8').then(JSON.parse);assert.equal((await stats()).prompts,0);
  await run(box+'.closest("details").open=false');await until(input+'.value===""','collapse clears');await run(box+'.closest("details").open=true');
  await fill();await run('Array.from('+box+'.querySelectorAll("button")).find(b=>b.textContent.trim()==="取消").click()');assert.equal(await run(input+'.value'),'');
  await fill();await run('window.oldPasswordInput='+input);await click('智能体档案');assert.equal(await run('window.oldPasswordInput.value'),'');await click('模型');await search();
  await fill();await fs.writeFile(${JSON.stringify(join(temp,"mode"))},'success');await submit();await until(box+'?.textContent.includes("连接已保存")&&!'+box+'.querySelector("input")','saved and cleared');
  assert.equal((await run('window.dcode.request("dcodeModels.get",{})')).models.some(m=>m.providerId==='zai-coding-cn'&&m.available),true);
  const snapshot=await run('window.dcode.request("foundation.snapshot",{})');assert.ok(!JSON.stringify(snapshot).includes(${JSON.stringify(secret)}));assert.ok(!JSON.stringify(publicRequests).includes(${JSON.stringify(secret)}));
  assert.ok(!JSON.stringify(await run('window.dcode.diagnostics()')).includes(${JSON.stringify(secret)}));
  const before=(await stats()).writes;
  const foreign=new BrowserWindow({show:false,webPreferences:{...win.webContents.getLastWebPreferences(),preload:${JSON.stringify(join(client,"dist/src/preload/index.js"))}}});
  await foreign.loadURL('data:text/html,<p>untrusted test frame</p>');
  const denied=await foreign.webContents.executeJavaScript('window.dcode.connectApiKey("zai-coding-cn",'+JSON.stringify(${JSON.stringify(secret)})+')',true);assert.equal(denied.ok,false);foreign.destroy();assert.equal((await stats()).writes,before);
  await run('Array.from('+box+'.querySelectorAll("button")).find(b=>b.textContent.trim()==="更换密钥").click()');await fill();
  for(const theme of ['light','dark']){nativeTheme.themeSource=theme;await sleep(100);await fs.writeFile(${JSON.stringify(temp)}+'/inline-'+theme+'.png',(await win.webContents.capturePage()).toPNG());}
  await fs.writeFile(${JSON.stringify(join(temp,"mode"))},'pending');await submit();await until(box+'?.textContent.includes("正在连接")','pending request');await sleep(100);
  const beforeRestart=(await stats()).writes;await fs.writeFile(${JSON.stringify(join(temp,"mode"))},'success');
  const fixtureHostPid=(await stats()).hostPid;assert.ok(Number.isInteger(fixtureHostPid));process.kill(fixtureHostPid,'SIGKILL');await sleep(150);
  await run('window.dcode.restartHost()');await until(input+'&&!'+input+'.disabled','restart clears stale saving');await sleep(100);assert.equal((await stats()).writes,beforeRestart,'old key must not replay');
  assert.equal((await stats()).prompts,0);assert.equal(BrowserWindow.getAllWindows().length,1);
  await fill();await submit();await until(box+'?.textContent.includes("连接已保存")&&!'+box+'.querySelector("input")','explicit retry after restart');
  assert.ok(!JSON.stringify(publicRequests).includes(${JSON.stringify(secret)}));
  await fs.writeFile(${JSON.stringify(join(temp,"result.json"))},JSON.stringify({passed:true,actualHost:true,privateFd3:true,provider:'zai-coding-cn',failureRetainsMaskedInput:true,successClears:true,cancelClears:true,collapseClears:true,leaveClears:true,modelAvailable:true,foreignFrameRejected:true,restartNoReplay:true,nativePrompts:0,themes:2,windowCount:1}));app.quit();
 }catch(error){await fs.writeFile(${JSON.stringify(join(temp,"failure.png"))},(await win.webContents.capturePage()).toPNG());await fs.writeFile(${JSON.stringify(join(temp,"result.json"))},JSON.stringify({passed:false,error:String(error),stack:error.stack}));app.quit();}
}));
import(${JSON.stringify(pathToFileURL(join(client,"dist/src/main/index.js")).href)});
`);
const env={...process.env,DCODE_HOST_ENTRY:entryPath,DCODE_DATA_ROOT:join(temp,".dcode"),DCODE_AGENT_DIR:join(temp,"agent"),DCODE_USER_DATA:join(temp,"profile"),DCODE_WIDTH:"1440",PI_OFFLINE:"1"};
for(const key of ["ELECTRON_RUN_AS_NODE","DCODE_THEME","DCODE_CAPTURE","DCODE_RENDERER_URL","DCODE_CREDENTIAL_PIPE_FD"])delete env[key];
const {stdout,stderr}=await promisify(execFile)(electron,[runner],{cwd:client,env,timeout:120000,maxBuffer:2_000_000});
const result=JSON.parse(await readFile(join(temp,"result.json"),"utf8"));
const scan=async path=>{for(const entry of await readdir(path,{withFileTypes:true})){const file=join(path,entry.name);if(entry.isDirectory())await scan(file);else if(entry.isFile())assert.ok(!(await readFile(file)).includes(secret),'Key found in persisted application data');}};
await scan(join(temp,".dcode"));await scan(join(temp,"profile"));assert.ok(!stdout.includes(secret)&&!stderr.includes(secret));
console.log(JSON.stringify({temp,...result}));assert.equal(result.passed,true,stderr+stdout);
