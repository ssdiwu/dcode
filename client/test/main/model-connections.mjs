import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {mkdtemp,mkdir,writeFile,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import electron from "electron";
const client=fileURLToPath(new URL("../../",import.meta.url)),host=join(client,"../host/dist/src");
const temp=await mkdtemp(join(tmpdir(),"dcode-connections-ui-"));await mkdir(join(temp,"agent"));await writeFile(join(temp,"mode"),"pending");
// Run the real Host entry/Protocol with a private fake native adapter. No key is
// ever entered in the renderer, and this wrapper is never a production resource.
const adapter=`{
 data:new Map(),tail:Promise.resolve(),
 async list(){return [...this.data].map(([providerId,c])=>({providerId,type:c.type}));},
 async transaction(id,fn,signal){const next=this.tail.then(async()=>{signal?.throwIfAborted();const r=await fn(this.data.get(id));signal?.throwIfAborted();if(r.write!==undefined){if(r.write===null)this.data.delete(id);else this.data.set(id,r.write);}return r.value;});this.tail=next.then(()=>{},()=>{});return next;},
 async prompt(_name,_prompt,signal){const mode=await testReadFile(${JSON.stringify(join(temp,"mode"))},"utf8");if(mode==='pending')return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true}));if(mode==='failure')throw Error('fixture-private-api-value');await new Promise(r=>setTimeout(r,350));return 'fixture-private-api-value';},
 async browser(){},async notice(){}
}`;
let entry=await readFile(join(host,"index.js"),"utf8");
entry=entry.replace(/from "\.\//g,`from "${pathToFileURL(host+"/").href}`);
entry=entry.replace('const host = new PiHost({',`const host = new PiHost({userHome:${JSON.stringify(temp)},modelCredentialAdapter:${adapter},`);
assert.ok(entry.includes('modelCredentialAdapter:'));
entry=`import {readFile as testReadFile} from 'node:fs/promises';\n`+entry.replace(/^#!.*\n/,"");
const entryPath=join(temp,"host-entry.mjs");await writeFile(entryPath,entry);
const runner=join(temp,"runner.cjs");
await writeFile(runner,`
const{app,BrowserWindow,nativeTheme}=require('electron');const fs=require('node:fs/promises');const assert=require('node:assert/strict');
BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.focus=function(){};
app.on('browser-window-created',(_event,win)=>win.webContents.once('did-finish-load',async()=>{
 const run=code=>win.webContents.executeJavaScript(code,true),sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const until=async(code,label)=>{for(let i=0;i<400;i++){if(await run(code))return;await sleep(25)}throw Error('Timeout '+label)};
 const click=label=>run('(()=>{const b=Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==='+JSON.stringify(label)+');if(!b)throw Error("Button missing");b.click()})()');
 const connection=provider=>'document.querySelector('+JSON.stringify('[aria-label="'+provider+' 连接"]')+')';
 try{
  await until('!!document.querySelector(".new-task-stage")','startup');await until('!document.body.textContent.includes("正在读取模型")','models ready');await sleep(150);await click('设置');await click('模型');
  await until(connection('openai')+'?.textContent.includes("连接 API 密钥")','OpenAI API action');
  assert.ok(await run(connection('openai-codex')+'?.textContent.includes("登录 ChatGPT")'));
  assert.equal(await run(connection('openai')+'?.querySelector("button")?.textContent.includes("浏览器登录")'),false);
  await run('(()=>{const input=document.querySelector(".model-search");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"openai");input.dispatchEvent(new Event("input",{bubbles:true}));})()');
  await sleep(150);await run(connection('openai')+'.closest(".model-provider").scrollIntoView({block:"start"})');
  const button=async(provider,label)=>{const target='Array.from('+connection(provider)+'.querySelectorAll("button")).find(b=>b.textContent.trim()==='+JSON.stringify(label)+')';await until('!!('+target+')&&!('+target+').disabled','enabled '+label);await run(target+'.click()');};
  for(const theme of ['light','dark']){nativeTheme.themeSource=theme;await sleep(100);await fs.writeFile(${JSON.stringify(temp)}+'/connections-'+theme+'.png',(await win.webContents.capturePage()).toPNG());}
  await button('openai','连接 API 密钥');await until(connection('openai')+'?.textContent.includes("请在安全窗口完成连接")','private prompt status');
  assert.equal(await run(connection('openai')+'.querySelectorAll("input").length'),0);
  await fs.writeFile(${JSON.stringify(join(temp,"connections-pending.png"))},(await win.webContents.capturePage()).toPNG());
  await button('openai','取消连接');await until(connection('openai')+'?.textContent.includes("已取消连接")','cancel');
  await fs.writeFile(${JSON.stringify(join(temp,"mode"))},'failure');await button('openai','连接 API 密钥');await until(connection('openai')+'?.textContent.includes("连接失败")','failed');
  assert.equal(await run('document.body.textContent.includes("fixture-private-api-value")'),false);
  await fs.writeFile(${JSON.stringify(join(temp,"mode"))},'success');await button('openai','连接 API 密钥');await until(connection('openai')+'?.textContent.includes("首次请求时验证")','saved');
  assert.ok(await run(connection('openai')+'?.textContent.includes("断开 D Code 连接")'));
  const snapshot=await run('window.dcode.request("foundation.snapshot",{})');
  assert.equal(snapshot.credentialReferences.find(r=>r.providerId==='openai').referenceKind,'keychain');assert.ok(!JSON.stringify(snapshot).includes('fixture-private-api-value'));
  await fs.writeFile(${JSON.stringify(join(temp,"connections-saved.png"))},(await win.webContents.capturePage()).toPNG());
  win.setContentSize(960,700);await sleep(100);assert.ok(await run('document.documentElement.scrollWidth<=innerWidth'));
  await button('openai','断开 D Code 连接');await until(connection('openai')+'?.textContent.includes("未连接")','disconnect');
  assert.equal(await run(connection('openai')+'?.textContent.includes("断开 D Code 连接")'),false);
  await fs.writeFile(${JSON.stringify(join(temp,"result.json"))},JSON.stringify({passed:true,themes:2,actualHost:true,actualSettings:true,secretRendererInputs:0,apiSetup:'cancel/failure/retry/save/disconnect',oauth:'supported button; controlled provider protocol tested in Host tests'}));app.quit();
 }catch(error){await fs.writeFile(${JSON.stringify(join(temp,"failure.png"))},(await win.webContents.capturePage()).toPNG());await fs.writeFile(${JSON.stringify(join(temp,"result.json"))},JSON.stringify({passed:false,error:String(error),stack:error.stack}));app.quit();}
}));
import(${JSON.stringify(pathToFileURL(join(client,"dist/src/main/index.js")).href)});
`);
const env={...process.env,DCODE_HOST_ENTRY:entryPath,DCODE_DATA_ROOT:join(temp,".dcode"),DCODE_AGENT_DIR:join(temp,"agent"),DCODE_USER_DATA:join(temp,"profile"),DCODE_WIDTH:"1440",PI_OFFLINE:"1"};
for(const key of ["ELECTRON_RUN_AS_NODE","DCODE_THEME","DCODE_CAPTURE","DCODE_RENDERER_URL"])delete env[key];
const {stdout,stderr}=await promisify(execFile)(electron,[runner],{cwd:client,env,timeout:90000,maxBuffer:2_000_000});
const result=JSON.parse(await readFile(join(temp,"result.json"),"utf8"));console.log(JSON.stringify({temp,...result}));assert.equal(result.passed,true,stderr+stdout);
