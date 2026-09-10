import assert from 'node:assert/strict';import{execFile}from'node:child_process';import{promisify}from'node:util';import{mkdtemp,mkdir,writeFile,readFile,readdir}from'node:fs/promises';import{join}from'node:path';import{tmpdir}from'node:os';import{fileURLToPath,pathToFileURL}from'node:url';import electron from'electron';
const client=fileURLToPath(new URL('../..',import.meta.url)),host=join(client,'../host/dist/src'),temp=await mkdtemp(join(tmpdir(),'dcode-keychain-ui-'));await mkdir(join(temp,'agent'));
const statsPath=join(temp,'stats.json'),modePath=join(temp,'mode');await writeFile(statsPath,JSON.stringify({reads:0,authorizations:0,writes:0}));await writeFile(modePath,'deny');
const prefix=`import{readFile as testRead,writeFile as testWrite}from'node:fs/promises';import{SecureCredentialError,authCancelled}from ${JSON.stringify(pathToFileURL(join(host,'secure-model-credentials.js')).href)};
const stats=JSON.parse(await testRead(${JSON.stringify(statsPath)},'utf8'));const saveStats=()=>testWrite(${JSON.stringify(statsPath)},JSON.stringify(stats));let blocked=true;const data=new Map([['zai-coding-cn',{type:'api_key',key:'keychain-ui-fixture-zai'}],['openai',{type:'api_key',key:'keychain-ui-fixture-openai'}]]);
const fakeVault={list:async()=>[...data].map(([providerId,c])=>({providerId,type:c.type})),transaction:async(id,fn,signal,options)=>{
 if(id==='zai-coding-cn'){
  if(options?.interactive){stats.authorizations++;await saveStats();while(await testRead(${JSON.stringify(modePath)},'utf8')==='hold'){signal?.throwIfAborted();await new Promise(r=>setTimeout(r,20));}signal?.throwIfAborted();if(await testRead(${JSON.stringify(modePath)},'utf8')==='deny')throw new SecureCredentialError('access_denied');blocked=false;}
  else {stats.reads++;await saveStats();if(blocked)throw new SecureCredentialError('access_required');}
 }
 const result=await fn(data.get(id));signal?.throwIfAborted();if(result.write!==undefined){stats.writes++;await saveStats();if(result.write===null)data.delete(id);else data.set(id,result.write);}return result.value;
},prompt:async()=>{throw Error('No model auth prompt in Keychain test');},browser:async()=>{throw Error('No browser');},notice:async()=>{throw Error('No notice');}};
`;
let entry=await readFile(join(host,'index.js'),'utf8');entry=entry.replace(/^#!.*\n/,'').replace(/from "\.\//g,`from "${pathToFileURL(host+'/').href}`).replace('const host = new PiHost({',`const host = new PiHost({userHome:${JSON.stringify(temp)},modelCredentialAdapter:fakeVault,`);const entryPath=join(temp,'host-entry.mjs');await writeFile(entryPath,prefix+entry);
const runner=join(temp,'runner.cjs');await writeFile(runner,`
const{app,BrowserWindow,nativeTheme,ipcMain}=require('electron'),fs=require('node:fs/promises'),assert=require('node:assert/strict');BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.focus=function(){};
const requests=[],handle=ipcMain.handle.bind(ipcMain);ipcMain.handle=(name,fn)=>handle(name,(event,...args)=>{if(name==='dcode:request')requests.push(args);return fn(event,...args);});
app.once('browser-window-created',(_event,win)=>win.webContents.once('did-finish-load',async()=>{
 const run=code=>win.webContents.executeJavaScript(code,true),sleep=ms=>new Promise(r=>setTimeout(r,ms)),stats=()=>fs.readFile(${JSON.stringify(statsPath)},'utf8').then(JSON.parse);
 const until=async(code,label)=>{for(let i=0;i<400;i++){if(await run(code))return;await sleep(25);}throw Error('Timeout '+label);};
 const click=label=>run('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==='+JSON.stringify(label)+').click()');
 const box='document.querySelector('+JSON.stringify('[aria-label="zai-coding-cn 连接"]')+')';const inside=label=>run('Array.from('+box+'.querySelectorAll("button")).find(b=>b.textContent.trim()==='+JSON.stringify(label)+').click()');
 try{
  await until('!!document.querySelector(".new-task-stage")','startup');await click('设置');await click('模型');await until('!!document.querySelector(".model-search")','models');
  await run('(()=>{const i=document.querySelector(".model-search");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(i,"Z.AI Coding");i.dispatchEvent(new Event("input",{bubbles:true}));})()');await until(box+'.textContent.includes("需要钥匙串访问授权")','blocked state');
  assert.equal((await stats()).authorizations,0);assert.equal((await stats()).reads,1);
  for(let i=0;i<6;i++)await run('Promise.all([window.dcode.request("dcodeAuth.get",{}),window.dcode.request("dcodeModels.get",{}),window.dcode.request("dcodeModels.quotas",{})])');await run('window.dispatchEvent(new Event("focus"));void 0;');await sleep(120);assert.equal((await stats()).authorizations,0);assert.equal((await stats()).reads,1);
  const models=await run('window.dcode.request("dcodeModels.get",{})');assert.ok(models.models.some(m=>m.providerId==='openai'&&m.available));assert.ok(models.models.filter(m=>m.providerId==='zai-coding-cn').every(m=>!m.available));
  await inside('授权访问钥匙串');await until(box+'.textContent.includes("钥匙串访问未获允许")','user denial');assert.equal((await stats()).authorizations,1);
  for(let i=0;i<4;i++)await run('window.dcode.request("dcodeModels.get",{})');assert.equal((await stats()).authorizations,1);
  await fs.writeFile(${JSON.stringify(modePath)},'hold');await inside('授权访问钥匙串');await until(box+'.textContent.includes("等待系统钥匙串授权")','waiting');await inside('取消授权');await until(box+'.textContent.includes("已取消本次钥匙串授权")','cancelled');assert.equal((await stats()).writes,0);
  for(const theme of ['light','dark']){nativeTheme.themeSource=theme;await sleep(80);await fs.writeFile(${JSON.stringify(temp)}+'/keychain-'+theme+'.png',(await win.webContents.capturePage()).toPNG());}
  await fs.writeFile(${JSON.stringify(modePath)},'grant');await inside('授权访问钥匙串');await until('!'+box+'.textContent.includes("等待系统钥匙串授权")&&!'+box+'.textContent.includes("授权访问钥匙串")','explicit grant');
  for(let i=0;i<5;i++){const v=await run('window.dcode.request("dcodeModels.get",{})');assert.ok(v.models.some(m=>m.providerId==='zai-coding-cn'&&m.available));}assert.equal((await stats()).authorizations,3);assert.equal((await stats()).writes,0);
  await run('window.dcode.restartHost()');await until(box+'.textContent.includes("需要钥匙串访问授权")','restart does not auto authorize');assert.equal((await stats()).authorizations,3);
  const publicData=JSON.stringify({requests,auth:await run('window.dcode.request("dcodeAuth.get",{})'),diagnostics:await run('window.dcode.diagnostics()'),snapshot:await run('window.dcode.request("foundation.snapshot",{})')});assert.ok(!publicData.includes('keychain-ui-fixture'));
  await fs.writeFile(${JSON.stringify(join(temp,'result.json'))},JSON.stringify({passed:true,actualHost:true,backgroundInteractiveCalls:0,denialDoesNotRetry:true,cancelPreservesConnection:true,explicitGrant:true,subsequentModelQueriesNeedNoFurtherGrant:true,healthyOtherProvider:true,restartDoesNotAutoAuthorize:true,credentialWrites:0,privateValuesAbsent:true}));app.quit();
 }catch(error){await fs.writeFile(${JSON.stringify(join(temp,'failure.png'))},(await win.webContents.capturePage()).toPNG());await fs.writeFile(${JSON.stringify(join(temp,'result.json'))},JSON.stringify({passed:false,error:String(error),stack:error.stack}));app.quit();}
}));import(${JSON.stringify(pathToFileURL(join(client,'dist/src/main/index.js')).href)});
`);
const env={...process.env,DCODE_HOST_ENTRY:entryPath,DCODE_DATA_ROOT:join(temp,'.dcode'),DCODE_AGENT_DIR:join(temp,'agent'),DCODE_USER_DATA:join(temp,'profile'),DCODE_WIDTH:'1440',PI_OFFLINE:'1'};for(const name of ['ELECTRON_RUN_AS_NODE','DCODE_RENDERER_URL','DCODE_THEME','DCODE_CAPTURE','DCODE_CREDENTIAL_PIPE_FD'])delete env[name];
const output=await promisify(execFile)(electron,[runner],{cwd:client,env,timeout:120000,maxBuffer:2_000_000});const result=JSON.parse(await readFile(join(temp,'result.json'),'utf8'));const scan=async path=>{for(const e of await readdir(path,{withFileTypes:true})){const p=join(path,e.name);if(e.isDirectory())await scan(p);else if(e.isFile())assert.ok(!(await readFile(p)).includes('keychain-ui-fixture'),'Secret in persisted application data');}};await scan(join(temp,'.dcode'));await scan(join(temp,'profile'));assert.ok(!(output.stdout+output.stderr).includes('keychain-ui-fixture'));console.log(JSON.stringify({temp,...result}));assert.equal(result.passed,true);
