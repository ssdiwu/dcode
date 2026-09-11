import assert from 'node:assert/strict';import{execFile}from'node:child_process';import{promisify}from'node:util';import{mkdtemp,mkdir,writeFile,readFile,readdir}from'node:fs/promises';import{join}from'node:path';import{tmpdir}from'node:os';import{fileURLToPath,pathToFileURL}from'node:url';import electron from'electron';
const client=fileURLToPath(new URL('../..',import.meta.url)),host=join(client,'../host/dist/src'),temp=await mkdtemp(join(tmpdir(),'dcode-oauth-ui-'));
await mkdir(join(temp,'agent'));const statsPath=join(temp,'stats.json');
const access='e30.'+Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'ui-fixture-account'}})).toString('base64url')+'.ui-private-access';
const refresh='ui-private-refresh';
const prefix=`import{readFile as fixtureRead,writeFile as fixtureWrite}from'node:fs/promises';import http from'node:http';import{syncBuiltinESMExports}from'node:module';
const stats={browsers:0,manuals:0,selects:0,writes:0,deviceStarts:0,devicePolls:0},vault=new Map();let authUrl='';
const saveStats=()=>fixtureWrite(${JSON.stringify(statsPath)},JSON.stringify(stats));await saveStats();
const originalCreateServer=http.createServer;http.createServer=(...args)=>{const s=originalCreateServer(...args),listen=s.listen;s.listen=(...a)=>{if(a[0]===1455)a[0]=0;return listen.apply(s,a);};return s;};syncBuiltinESMExports();
globalThis.fetch=async(input,init)=>{if(String(input)==='https://auth.openai.com/api/accounts/deviceauth/usercode'){stats.deviceStarts++;await saveStats();return Response.json({device_auth_id:'ui-device-id-private',user_code:'UIQA-7890',interval:0});}
if(String(input)==='https://auth.openai.com/api/accounts/deviceauth/token'){stats.devicePolls++;await saveStats();return new Promise((resolve,reject)=>{
  let settled=false;const finish=response=>{if(settled)return;settled=true;clearInterval(poll);clearTimeout(deadline);init.signal?.removeEventListener('abort',abort);if(response)resolve(response);else reject(new DOMException('Cancelled','AbortError'));},abort=()=>finish();
  const poll=setInterval(()=>fixtureRead(${JSON.stringify(join(temp,'device-complete'))}).then(()=>finish(Response.json({authorization_code:'ui-private-device-auth',code_verifier:'ui-private-device-verifier'})),()=>{}),20),deadline=setTimeout(abort,20000);
  if(init.signal?.aborted)abort();else init.signal?.addEventListener('abort',abort,{once:true});
});}
if(String(input)==='https://auth.openai.com/oauth/token')return Response.json({access_token:${JSON.stringify(access)},refresh_token:${JSON.stringify(refresh)},expires_in:3600});throw Error('Unexpected fixture network');};
const fixtureAdapter={list:async()=>[...vault].map(([providerId,c])=>({providerId,type:c.type})),transaction:async(id,fn)=>{const r=await fn(vault.get(id));if(r.write!==undefined){stats.writes++;if(r.write===null)vault.delete(id);else vault.set(id,r.write);await saveStats();}return r.value;},
 browser:async(url,signal)=>{authUrl=url;stats.browsers++;await saveStats();if(url.endsWith('/codex/device'))return;if(stats.browsers===1)throw Error('controlled failure '+url);if(stats.browsers===2)await new Promise(resolve=>{const done=()=>{clearInterval(poll);clearTimeout(deadline);resolve();},poll=setInterval(()=>fixtureRead(${JSON.stringify(join(temp,'release-open'))}).then(done,()=>{}),20),deadline=setTimeout(done,5000);signal.addEventListener('abort',done,{once:true});});if(stats.browsers>=3)await new Promise((resolve,reject)=>{if(signal.aborted)reject(Error('aborted'));else signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true});});},notice:async()=>{},prompt:async(_name,p)=>{if(p.type==='select'){stats.selects++;await saveStats();return p.options[0].id;}stats.manuals++;await saveStats();if(stats.manuals===1)throw Error('controlled input failure '+authUrl);return 'http://localhost:1455/auth/callback?code=ui-private-code&state='+new URL(authUrl).searchParams.get('state');}};
`;
let entry=await readFile(join(host,'index.js'),'utf8');entry=entry.replace(/^#!.*\n/,'').replace(/from "\.\//g,`from "${pathToFileURL(host+'/').href}`).replace('const host = new PiHost({',`const host = new PiHost({userHome:${JSON.stringify(temp)},modelCredentialAdapter:fixtureAdapter,`);
const entryPath=join(temp,'host-entry.mjs');await writeFile(entryPath,prefix+entry);
const runner=join(temp,'runner.cjs');await writeFile(runner,`
const{app,BrowserWindow,nativeTheme,ipcMain}=require('electron'),fs=require('node:fs/promises'),assert=require('node:assert/strict');BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.focus=function(){};
const requests=[],handle=ipcMain.handle.bind(ipcMain);let displayMode='normal',displayHeld=false,releaseDisplay=()=>{};
ipcMain.handle=(name,fn)=>handle(name,async(event,...args)=>{if(name==='dcode:request')requests.push(args);const value=await fn(event,...args);
 if(name==='dcode:readDeviceCode'&&value){const mode=displayMode;displayMode='normal';if(mode==='delay'){displayHeld=true;return new Promise(resolve=>{releaseDisplay=()=>{displayHeld=false;resolve(value);};});}if(mode==='expire')return {userCode:value.userCode,expiresAt:Date.now()+180};}
 return value;});
app.once('browser-window-created',(_event,win)=>win.webContents.once('did-finish-load',async()=>{
 const run=code=>win.webContents.executeJavaScript(code,true),sleep=ms=>new Promise(r=>setTimeout(r,ms));const until=async(code,label)=>{for(let i=0;i<350;i++){if(await run(code))return;await sleep(25);}throw Error('Timeout '+label);};
 const click=label=>run('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==='+JSON.stringify(label)+').click()');
 const box='document.querySelector('+JSON.stringify('[aria-label="openai-codex 连接"]')+')';
 const inside=async label=>{await until('Array.from('+box+'.querySelectorAll("button")).some(b=>b.textContent.trim()==='+JSON.stringify(label)+'&&!b.disabled)','enabled '+label);return run('Array.from('+box+'.querySelectorAll("button")).find(b=>b.textContent.trim()==='+JSON.stringify(label)+').click()');};
 const stats=()=>fs.readFile(${JSON.stringify(statsPath)},'utf8').then(JSON.parse);
 try{
  await until('!!document.querySelector(".new-task-stage")','startup');await click('设置');await click('模型');await until('!!document.querySelector(".model-search")','model search');
  await run('(()=>{const i=document.querySelector(".model-search");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(i,"OpenAI Codex");i.dispatchEvent(new Event("input",{bubbles:true}));})()');
  await until(box,'provider');assert.equal(await run(box+'.textContent.includes(\"设备码登录\")'),true);await inside('浏览器登录');await until(box+'.textContent.includes("未能自动打开")','recoverable browser error');assert.equal((await stats()).manuals,0);
  await inside('打开登录页面');await until(box+'.querySelector("[aria-label=打开登录页面]").disabled','opening');
  await Promise.race([run('window.dcode.request("dcodeAuth.get",{})'),sleep(1000).then(()=>{throw Error('Status blocked behind browser opening');})]);
  await fs.writeFile(${JSON.stringify(join(temp,'release-open'))},'ready');await until('!'+box+'.textContent.includes("未能自动打开")&&!'+box+'.querySelector("[aria-label=打开登录页面]").disabled','reopen success');assert.equal((await stats()).browsers,2);
  await inside('输入授权结果');await until(box+'.textContent.includes("输入窗口未能打开")','input failure keeps flow');assert.equal(await run('!!'+box+'.querySelector("[aria-label=打开登录页面]")'),true);
  for(const theme of ['light','dark']){nativeTheme.themeSource=theme;await sleep(80);await fs.writeFile(${JSON.stringify(temp)}+'/oauth-'+theme+'.png',(await win.webContents.capturePage()).toPNG());}
  await inside('输入授权结果');await until(box+'.textContent.includes("已连接")&&!'+box+'.querySelector("[aria-label=打开登录页面]")','SDK credentials saved');assert.equal((await stats()).writes,1);
  const publicData=JSON.stringify({requests,view:await run('window.dcode.request("dcodeAuth.get",{})'),diagnostics:await run('window.dcode.diagnostics()'),snapshot:await run('window.dcode.request("foundation.snapshot",{})')});
  for(const secret of [${JSON.stringify(access)},${JSON.stringify(refresh)},'ui-private-code','code_challenge','oauth/authorize'])assert.ok(!publicData.includes(secret),'Sensitive flow data in public output');
  await inside('浏览器登录');await until('!!'+box+'.querySelector("[aria-label=打开登录页面]")','new flow');await inside('取消连接');await until(box+'.textContent.includes("已取消连接")','explicit cancellation');assert.equal((await stats()).writes,1);
  assert.equal((await stats()).selects,0,'Both direct entries bypass the SDK selector');
  await inside('设备码登录');await until(box+'.querySelector(\"[aria-label=设备码]\")?.textContent===\"UIQA-7890\"','private device display');
  assert.equal((await stats()).deviceStarts,1);assert.equal((await stats()).selects,0);
  assert.equal(await run(box+'.textContent.includes(\"输入授权结果\")'),false);
  for(const theme of ['light','dark']){nativeTheme.themeSource=theme;await sleep(80);await fs.writeFile(${JSON.stringify(temp)}+'/device-'+theme+'.png',(await win.webContents.capturePage()).toPNG());}
  await run(box+'.closest(\"details\").open=false');await until(box+'.querySelector(\"[aria-label=设备码]\")?.textContent===\"\"','collapse clears device code');
  await run(box+'.closest(\"details\").open=true');await until(box+'.querySelector(\"[aria-label=设备码]\")?.textContent===\"UIQA-7890\"','reopen reads active code');
  await run(box+'.closest(\"details\").open=false');await until(box+'.querySelector(\"[aria-label=设备码]\")?.textContent===\"\"','clear before delayed reply');
  displayMode='delay';await run(box+'.closest(\"details\").open=true');for(let i=0;i<100&&!displayHeld;i++)await sleep(20);assert.equal(displayHeld,true);
  await run(box+'.closest(\"details\").open=false');await sleep(50);releaseDisplay();await sleep(80);assert.equal(await run(box+'.querySelector(\"[aria-label=设备码]\")?.textContent'),'', 'Late reply must not restore a collapsed code');
  displayMode='expire';await run(box+'.closest(\"details\").open=true');await until(box+'.querySelector(\"[aria-label=设备码]\")?.textContent===\"UIQA-7890\"','short-lived private display');
  await until(box+'.querySelector(\"[aria-label=设备码]\")?.textContent===\"\"','actual DOM expires code');await inside('重新显示设备码');await until(box+'.querySelector(\"[aria-label=设备码]\")?.textContent===\"UIQA-7890\"','retry live display');
  await click('外观');await until('!document.querySelector(\"[aria-label=设备码]\")','leaving clears display');
  await click('模型');await until(box+'.querySelector(\"[aria-label=设备码]\")?.textContent===\"UIQA-7890\"','return reads live code');
  const devicePublic=JSON.stringify({requests,view:await run('window.dcode.request(\"dcodeAuth.get\",{})'),diagnostics:await run('window.dcode.diagnostics()'),snapshot:await run('window.dcode.request(\"foundation.snapshot\",{})')});
  assert.ok(!devicePublic.includes('UIQA-7890'));assert.ok(!devicePublic.includes('ui-device-id-private'));
  const flow=await run('window.dcode.request(\"dcodeAuth.get\",{}).then(v=>v.providers.find(p=>p.providerId===\"openai-codex\").flowId)');
  const foreign=new BrowserWindow({show:false,webPreferences:{...win.webContents.getLastWebPreferences(),preload:${JSON.stringify(join(client,'dist/src/preload/index.js'))}}});
  await foreign.loadURL('data:text/html,<p>untrusted fixture</p>');assert.equal(await foreign.webContents.executeJavaScript('window.dcode.readDeviceCode('+JSON.stringify(flow)+')',true),null);foreign.destroy();
  await run(box+'.closest(\"details\").open=false');await until(box+'.querySelector(\"[aria-label=设备码]\")?.textContent===\"\"','clear before cancellation race');
  displayMode='delay';await run(box+'.closest(\"details\").open=true');for(let i=0;i<100&&!displayHeld;i++)await sleep(20);assert.equal(displayHeld,true);
  await inside('取消连接');await until('!'+box+'.querySelector(\"[aria-label=设备码]\")','cancel clears code');assert.equal(await run('window.dcode.readDeviceCode('+JSON.stringify(flow)+')'),null);releaseDisplay();await sleep(80);assert.equal(await run('!!'+box+'.querySelector(\"[aria-label=设备码]\")'),false,'Late private reply cannot restore a cancelled code');
  await inside('设备码登录');await until(box+'.querySelector(\"[aria-label=设备码]\")?.textContent===\"UIQA-7890\"','device retry');
  await fs.writeFile(${JSON.stringify(join(temp,'device-complete'))},'ready');await until(box+'.textContent.includes(\"已连接\")&&!'+box+'.querySelector(\"[aria-label=设备码]\")','device SDK save');assert.equal((await stats()).writes,2);assert.equal((await stats()).selects,0);
  await fs.unlink(${JSON.stringify(join(temp,'device-complete'))});await inside('设备码登录');await until(box+'.querySelector(\"[aria-label=设备码]\")?.textContent===\"UIQA-7890\"','device before restart');
  const oldFlow=await run('window.dcode.request(\"dcodeAuth.get\",{}).then(v=>v.providers.find(p=>p.providerId===\"openai-codex\").flowId)');
  await run('window.dcode.restartHost()');await until('!'+box+'.querySelector(\"[aria-label=设备码]\")','Host restart clears device code');assert.equal(await run('window.dcode.readDeviceCode('+JSON.stringify(oldFlow)+')'),null);assert.equal((await stats()).deviceStarts,0,'Restart must not replay a device login');
  await fs.writeFile(${JSON.stringify(join(temp,'result.json'))},JSON.stringify({passed:true,actualHost:true,actualSdk:true,directBrowser:true,directDeviceCode:true,privateDeviceDisplay:true,lateReplyAfterCollapseAndCancel:true,deviceDisplayExpiry:true,foreignFrameRejected:true,restartNoReplay:true,deviceCollapseLeaveCancelCompleteClear:true,publicFlowControls:true,statusDuringOpening:true,browserRetry:true,manualFailureRecoverable:true,manualStartsOnlyOnClick:true,cancellation:true,secretProjectionAbsent:true,nativeOperations:'controlled; OS opener verified separately'}));app.quit();
 }catch(error){await fs.writeFile(${JSON.stringify(join(temp,'failure.png'))},(await win.webContents.capturePage()).toPNG());await fs.writeFile(${JSON.stringify(join(temp,'result.json'))},JSON.stringify({passed:false,error:String(error),stack:error.stack}));app.quit();}
}));import(${JSON.stringify(pathToFileURL(join(client,'dist/src/main/index.js')).href)});
`);
const env={...process.env,DCODE_HOST_ENTRY:entryPath,DCODE_DATA_ROOT:join(temp,'.dcode'),DCODE_AGENT_DIR:join(temp,'agent'),DCODE_USER_DATA:join(temp,'profile'),DCODE_WIDTH:'1440',PI_OFFLINE:'1',PI_OAUTH_CALLBACK_HOST:'127.0.0.1'};
for(const name of ['ELECTRON_RUN_AS_NODE','DCODE_RENDERER_URL','DCODE_THEME','DCODE_CAPTURE','DCODE_CREDENTIAL_PIPE_FD','DCODE_DEVICE_CODE_PIPE_FD'])delete env[name];
const output=await promisify(execFile)(electron,[runner],{cwd:client,env,timeout:120000,maxBuffer:2_000_000});const result=JSON.parse(await readFile(join(temp,'result.json'),'utf8'));
const scan=async path=>{for(const e of await readdir(path,{withFileTypes:true})){const p=join(path,e.name);if(e.isDirectory())await scan(p);else if(e.isFile()){const bytes=await readFile(p);for(const value of [access,refresh,'ui-private-code','code_challenge=','UIQA-7890','ui-device-id-private','ui-private-device-auth','ui-private-device-verifier'])assert.ok(!bytes.includes(value),'Private flow data persisted');}}};await scan(join(temp,'.dcode'));await scan(join(temp,'profile'));for(const value of [access,refresh,'ui-private-code','UIQA-7890','ui-device-id-private','ui-private-device-auth','ui-private-device-verifier'])assert.ok(!(output.stdout+output.stderr).includes(value));
console.log(JSON.stringify({temp,...result}));assert.equal(result.passed,true);
