import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import electron from 'electron';
const client=fileURLToPath(new URL('../..',import.meta.url)),host=join(client,'../host/dist/src');
const temp=await mkdtemp(join(tmpdir(),'dcode-project-row-'));
for(const folder of ['agent','project-a','project-b'])await mkdir(join(temp,folder));
await mkdir(join(temp,'agent','sessions','import-fixture'),{recursive:true});
await writeFile(join(temp,'agent','sessions','import-fixture','import-fixture.jsonl'),[
  JSON.stringify({type:'session',version:3,id:'import-fixture',timestamp:'2026-09-29T00:00:00.000Z',cwd:temp}),
  JSON.stringify({type:'message',id:'import-user',parentId:null,timestamp:'2026-09-29T00:00:00.000Z',message:{role:'user',content:'导入测试内容',timestamp:1}}),
].join('\n')+'\n');
for(const folder of ['project-a','project-b'])await writeFile(join(temp,folder,'note.md'),'# Original\n'+folder+'\n');
for(const name of ['a.txt','b.txt','user.txt'])await writeFile(join(temp,name),'Fixture '+name);
await writeFile(join(temp,'project-a','preview.html'),'<!doctype html><h1>Isolated preview</h1>');
await writeFile(join(temp,'agent','settings.json'),JSON.stringify({defaultProvider:'project-fixture',defaultModel:'model',enabledModels:['project-fixture/model']}));
await writeFile(join(temp,'agent','models.json'),JSON.stringify({providers:{'project-fixture':{baseUrl:'https://project-fixture.invalid/v1',api:'openai-completions',apiKey:'fixture-only-key',models:[{id:'model',name:'Fixture',reasoning:false,contextWindow:100000,maxTokens:4096}]}}}));
let entry=await readFile(join(host,'index.js'),'utf8');
entry=entry.replace(/^#!.*\n/,'').replace(/from "\.\//g,`from "${pathToFileURL(host+'/').href}`).replace('const host = new PiHost({',`const host = new PiHost({userHome:${JSON.stringify(temp)},`);
const prefix=`globalThis.fetch=async(input)=>{if(!String(input).startsWith('https://project-fixture.invalid/'))throw Error('Unexpected fixture network');const frame=(text,finish=null)=>'data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:'model',choices:[{index:0,delta:text?{role:'assistant',content:text}:{},finish_reason:finish}],...(finish?{usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}:{})})+'\\n\\n';return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(frame('项目任务已接收')+frame('','stop')+'data: [DONE]\\n\\n'));c.close();}}),{headers:{'content-type':'text/event-stream'}});};\n`;
const hostEntry=join(temp,'host.mjs');await writeFile(hostEntry,prefix+entry);
const runner=join(temp,'runner.cjs');
await writeFile(runner,`
const{app,BrowserWindow,nativeTheme,ipcMain}=require('electron'),fs=require('node:fs/promises'),assert=require('node:assert/strict');
BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.focus=function(){};
let holdProjectUpdate=false,releaseProjectUpdate,holdImport=false,releaseImport;
const registerHandle=ipcMain.handle.bind(ipcMain);
ipcMain.handle=(channel,handler)=>registerHandle(channel,(event,...args)=>{
 if(channel==='dcode:request'&&args[0]==='project.update'&&holdProjectUpdate){
  holdProjectUpdate=false;
  return new Promise((resolve,reject)=>{releaseProjectUpdate=()=>Promise.resolve(handler(event,...args)).then(resolve,reject);});
 }
 if(channel==='dcode:request'&&args[0]==='piImport.importAsTask'&&holdImport){
  holdImport=false;
  return new Promise((resolve,reject)=>{releaseImport=()=>Promise.resolve(handler(event,...args)).then(resolve,reject);});
 }
 return handler(event,...args);
});
app.once('browser-window-created',(_event,win)=>win.webContents.once('did-finish-load',async()=>{
 const run=code=>win.webContents.executeJavaScript(code,true).catch(error=>{throw Error(code.slice(0,120)+": "+error.message);}),sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const until=async(code,label)=>{for(let i=0;i<300;i++){if(await run(code))return;await sleep(25);}throw Error('Timeout '+label);};
 const click=async label=>{await until('Array.from(document.querySelectorAll("button")).some(b=>b.getAttribute("role")!=="tab"&&!b.disabled&&(b.getAttribute("aria-label")==='+JSON.stringify(label)+'||b.textContent.trim()==='+JSON.stringify(label)+'))','button '+label);return run('Array.from(document.querySelectorAll("button")).find(b=>b.getAttribute("role")!=="tab"&&(b.getAttribute("aria-label")==='+JSON.stringify(label)+'||b.textContent.trim()==='+JSON.stringify(label)+')).click()');};
 const key=async(label,keyCode='Return')=>{await run('Array.from(document.querySelectorAll("button")).find(b=>b.getAttribute("aria-label")==='+JSON.stringify(label)+').focus()');win.webContents.sendInputEvent({type:'keyDown',keyCode});win.webContents.sendInputEvent({type:'keyUp',keyCode});};
 const a='A 很长的项目名称用来验证按钮保留位置与文字省略',b='B 项目';
 const row=title=>'Array.from(document.querySelectorAll(".project-group")).find(e=>e.querySelector(".project-title").textContent==='+JSON.stringify(title)+')';
 const draft=async(title,text,keyboard=false)=>{if(await run('!!document.querySelector("[aria-label=项目文件导航]")'))await click('返回任务');if(keyboard)await key('在 '+title+' 中新建任务','Space');else await click('在 '+title+' 中新建任务');await until('document.querySelector("[data-composer]")?.value==='+JSON.stringify(text)+'&&!!document.querySelector(".new-task-stage")','project draft visible');await until('document.activeElement===document.querySelector("[data-composer]")','composer focus');};
 try{
  await until('!!document.querySelector("[data-composer]")','startup');
  const fixture=await run('(async()=>{const mutate=async(method,params)=>{for(let i=0;;i++){const s=await window.dcode.request("foundation.snapshot");try{return await window.dcode.request(method,{...params,requestId:crypto.randomUUID(),expectedStoreRevision:s.storeRevision});}catch(e){if(i>5||!String(e).includes("REVISION_CONFLICT"))throw e;}}};const a=await mutate("project.create",{title:'+JSON.stringify(a)+',directory:'+JSON.stringify(${JSON.stringify(join(temp,'project-a'))})+'}),b=await mutate("project.create",{title:'+JSON.stringify(b)+',directory:'+JSON.stringify(${JSON.stringify(join(temp,'project-b'))})+'});const s=await window.dcode.request("foundation.snapshot"),attachments={};for(const [id,text,path] of [[a.project.id,"A 草稿",'+JSON.stringify(${JSON.stringify(join(temp,'a.txt'))})+'],[b.project.id,"B 草稿",'+JSON.stringify(${JSON.stringify(join(temp,'b.txt'))})+'],[null,"独立草稿",'+JSON.stringify(${JSON.stringify(join(temp,'user.txt'))})+']]){const key="new:"+(id??"user"),attached=await mutate("attachment.import",{draftKey:key,source:{path}});attachments[key]=attached.attachment.id;await mutate("taskDraft.set",{scope:id?{kind:"project",projectId:id}:{kind:"user",userId:s.currentUser.id},text,attachmentIds:[attached.attachment.id]});}return {a:a.project.id,b:b.project.id,attachments};})()');
  await until(row(a),'project row');
  await run(row(a)+'.open=false');await key('更多项目操作 '+a);
  await until('document.querySelector("[role=menuitem]")?.textContent===\"编辑项目\"','management menu');
  assert.equal(await run('document.querySelectorAll("[role=menuitem]").length'),1);assert.equal(await run(row(a)+'.open'),false);
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Down'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Down'});
  await until('document.activeElement?.getAttribute("role")==="menuitem"','menu keyboard focus');
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'});
  await until('document.querySelector("[role=dialog]")?.getAttribute("aria-label")===\"编辑项目\"','real editor');
  await until('document.activeElement===document.querySelector("[role=dialog] input")','project name receives initial focus');
  await run('document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",isComposing:true,bubbles:true}))');
  assert.equal(await run('!!document.querySelector("[role=dialog]")'),true,'IME Escape keeps the dialog open');
  await run('(()=>{const panel=document.querySelector("[role=dialog]"),select=document.createElement("select"),option=document.createElement("option"),link=document.createElement("a"),editable=document.createElement("div");option.textContent="选项";select.append(option);select.setAttribute("aria-label","测试选择框");link.href="#";link.textContent="测试链接";editable.contentEditable="true";editable.textContent="测试可编辑内容";panel.append(select,link,editable);editable.focus();})()');
  assert.equal(await run('document.activeElement===document.querySelector("[role=dialog] [contenteditable]")'),true,'editable control can receive focus');
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});
  await until('document.activeElement===document.querySelector("[role=dialog] button")','Tab wraps from editable content to first dialog control');
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab',modifiers:['shift']});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab',modifiers:['shift']});
  await until('document.activeElement===document.querySelector("[role=dialog] [contenteditable]")','Shift-Tab wraps to last editable control');
  await run('document.querySelector("[role=dialog] select").focus()');
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});
  await until('document.activeElement===document.querySelector("[role=dialog] a[href]")','Tab reaches the dialog link after select');
  holdProjectUpdate=true;await click('保存项目');for(let i=0;i<300&&!releaseProjectUpdate;i++)await sleep(25);assert.equal(typeof releaseProjectUpdate,'function','project save held');
  assert.equal(await run('document.querySelector("[role=dialog] input")?.disabled'),true,'project name is frozen while saving');
  assert.equal(await run('document.querySelector("[role=dialog] .folder-picker")?.disabled'),true,'project directory is frozen while saving');
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await sleep(40);
  assert.equal(await run('!!document.querySelector("[role=dialog]")'),true,'Escape cannot dismiss an in-flight save');
  assert.equal(await run('Array.from(document.querySelectorAll("[role=dialog] button")).find(b=>b.textContent.trim()==="取消")?.disabled'),true,'cancel is unavailable while saving');
  assert.equal(await run('document.querySelector("[role=dialog] button[aria-label=关闭]")?.disabled'),true,'close is unavailable while saving');
  await run('document.querySelector(".overlay").dispatchEvent(new MouseEvent("mousedown",{bubbles:true}))');
  assert.equal(await run('!!document.querySelector("[role=dialog]")'),true,'backdrop cannot dismiss an in-flight save');
  releaseProjectUpdate();await until('!document.querySelector("[role=dialog]")','saved project closes after completion');
  await until('document.activeElement?.getAttribute("aria-label")==='+JSON.stringify('更多项目操作 '+a),'editor returns focus to project action');
  await run('document.querySelector("[aria-label=新建项目]").focus()');await click('新建项目');
  await until('document.querySelector("[role=dialog]")?.getAttribute("aria-label")===\"新建项目\"','new project dialog');
  await until('document.activeElement===document.querySelector("[role=dialog] input")','new project name receives focus');
  await click('取消');await until('document.activeElement?.getAttribute("aria-label")==="新建项目"','new project returns focus');
  await draft(a,'A 草稿',true);assert.equal(await run(row(a)+'.open'),false);assert.equal(await run('document.querySelectorAll(".attachment").length'),1);
  await click('文件与 Git');await until('!!document.querySelector(".file-navigation")','project file view');await click('note.md');await until('!!document.querySelector(".file-markdown")','document');await click('编辑');
  await run('(()=>{const i=document.querySelector(".file-editor");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(i,"# Unsaved A");i.dispatchEvent(new Event("input",{bubbles:true}));})()');
  await draft(b,'B 草稿');await key('任务归属');await until('Array.from(document.querySelectorAll("[role=menuitem]")).some(e=>e.textContent.trim()===\"独立任务\")','scope menu');await run('Array.from(document.querySelectorAll("[role=menuitem]")).find(e=>e.textContent.trim()===\"独立任务\").click()');await until('document.querySelector("[data-composer]")?.value===\"独立草稿\"','independent draft restored');assert.equal(await run('Array.from(document.querySelectorAll("button")).some(b=>b.getAttribute("aria-label")===\"移除附件 user.txt\")'),true);await draft(a,'A 草稿');
  await click('打开文件详情');await click('文件与 Git');await until('document.querySelector(".file-editor")?.value===\"# Unsaved A\"','same buffer retained');
  await click('preview.html');await until('!!document.querySelector(".html-preview-surface")','HTML preview');
  const previewVisible=()=>win.contentView.children.some(v=>v.webContents&&v.webContents!==win.webContents&&v.getBounds().width>0&&v.getBounds().height>0);
  for(let i=0;i<100&&!previewVisible();i++)await sleep(20);assert.equal(previewVisible(),true);
  const previewView=win.contentView.children.find(v=>v.webContents&&v.webContents!==win.webContents);
  const surface=await run('(()=>{const box=document.querySelector(".html-preview-surface").getBoundingClientRect(),bar=document.querySelector(".html-preview .preview-toolbar").getBoundingClientRect();return {x:box.x,y:box.y,width:box.width,height:box.height,toolbarBottom:bar.bottom};})()');
  const viewBounds=previewView.getBounds();
  assert.ok(Math.abs(viewBounds.x-surface.x)<3&&Math.abs(viewBounds.y-surface.y)<3&&Math.abs(viewBounds.width-surface.width)<3,'native HTML view remains inside the no-task file surface');
  assert.ok(surface.toolbarBottom<=viewBounds.y+2,'preview does not cover its permission bar');
  await click('返回任务');await key('更多项目操作 '+a);await until('!!document.querySelector("[role=menuitem]")','menu over preview');for(let i=0;i<100&&previewVisible();i++)await sleep(20);assert.equal(previewVisible(),false);
  win.webContents.send('dcode:event',{version:1,type:'event',event:'shell.settings'});await until('!!document.querySelector("[aria-label=设置分类]")','system settings from open project menu');
  await click('返回工作台');await until('!document.querySelector("[role=menuitem]")','menu unmounted');for(let i=0;i<100&&!previewVisible();i++)await sleep(20);assert.equal(previewVisible(),true,'Preview resumes after menu is unmounted by settings');
  const resumedSurface=await run('(()=>{const box=document.querySelector(".html-preview-surface").getBoundingClientRect(),bar=document.querySelector(".html-preview .preview-toolbar").getBoundingClientRect();return {x:box.x,y:box.y,width:box.width,toolbarBottom:bar.bottom};})()');
  const resumedView=win.contentView.children.find(v=>v.webContents&&v.webContents!==win.webContents&&v.getBounds().width>0);
  const resumedBounds=resumedView.getBounds();
  assert.ok(Math.abs(resumedBounds.x-resumedSurface.x)<3&&Math.abs(resumedBounds.y-resumedSurface.y)<3&&Math.abs(resumedBounds.width-resumedSurface.width)<3,'HTML view repositions after settings return '+JSON.stringify({resumedBounds,resumedSurface}));
  assert.ok(resumedSurface.toolbarBottom<=resumedBounds.y+2,'permission bar remains visible after settings return');
  await key('更多项目操作 '+a);await until('!!document.querySelector("[role=menuitem]")','menu before keyboard escape');
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
  await until('!document.querySelector("[role=menuitem]")&&document.activeElement?.getAttribute("aria-label")==='+JSON.stringify('更多项目操作 '+a),'Escape completes focus return');
  await draft(a,'A 草稿');
  const initialCount=await run('window.dcode.request("foundation.snapshot",{}).then(s=>s.tasks.length)');assert.equal(initialCount,0,'All row navigation is task-free');
  for(const [fontScale,zoom] of [['compact',.92],['standard',1],['large',1.12]]){
   await run('(async()=>{for(let i=0;;i++){const s=await window.dcode.request("foundation.snapshot");try{return await window.dcode.request("clientPreferences.set",{fontScale:'+JSON.stringify(fontScale)+',requestId:crypto.randomUUID(),expectedStoreRevision:s.storeRevision});}catch(e){if(i>5||!String(e).includes("REVISION_CONFLICT"))throw e;}}})()');
   for(let i=0;i<100&&Math.abs(win.webContents.getZoomFactor()-zoom)>.001;i++)await sleep(20);assert.ok(Math.abs(win.webContents.getZoomFactor()-zoom)<.001);
   for(const theme of ['light','dark'])for(const width of [1440,800]){nativeTheme.themeSource=theme;win.setSize(width,900);await sleep(100);const geometry=await run('(()=>{const s='+row(a)+'.querySelector("summary"),r=s.getBoundingClientRect();return [...s.querySelectorAll("button")].map(b=>{const a=b.getBoundingClientRect();return a.left>=r.left&&a.right<=r.right;});})()');assert.ok(geometry.every(Boolean));if(fontScale==='standard')await fs.writeFile(${JSON.stringify(temp)}+'/row-'+theme+'-'+width+'.png',(await win.webContents.capturePage()).toPNG());}
  }
  await key('更多项目操作 '+a);await until('!!document.querySelector("[role=menuitem]")','menu open before global new task');win.webContents.send('dcode:event',{version:1,type:'event',event:'shell.newTask'});await until('!document.querySelector("[role=menuitem]")','global shortcut closes project menu');await until('document.activeElement===document.querySelector("[data-composer]")','global shortcut focus');
  await click('发送');await until('document.querySelector(".workspace-title")?.textContent===\"A 草稿\"','first submit creates target task');
  const saved=await run('window.dcode.request("foundation.snapshot",{})');assert.equal(saved.tasks.length,1);assert.equal(saved.tasks[0].scope.projectId,fixture.a);assert.equal(saved.sessions.filter(s=>s.taskId===saved.tasks[0].id&&s.kind==='coordination').length,1);
  const foreign=saved.composerDrafts.filter(d=>d.draftKind==='new_task'&&(d.scope.kind==='user'||d.scope.projectId===fixture.b));assert.equal(foreign.length,2);assert.ok(foreign.every(d=>d.attachments.length===1));
  // Dispose only this fixture's unsaved buffer, then let normal quit protection run.
  await draft(a,'');await click('打开文件详情');await until('!!document.querySelector(".file-tab-strip")','return to buffers');await click('关闭文件 note.md · '+a);await until('!!document.querySelector("[role=dialog]")','dirty close');await click('放弃更改');
  await click('设置');await click('已归档任务');await click('导入 Pi 会话…');
  await until('document.querySelector("[role=dialog]")?.getAttribute("aria-label")==="导入 Pi 会话"','import dialog');
  await until('Array.from(document.querySelectorAll("[role=dialog] button")).some(b=>b.textContent.trim()==="导入")','import candidate');
  holdImport=true;await click('导入');for(let i=0;i<300&&!releaseImport;i++)await sleep(25);assert.equal(typeof releaseImport,'function','import held');
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await sleep(40);
  assert.equal(await run('!!document.querySelector("[role=dialog]")'),true,'Escape cannot dismiss an in-flight import');
  await run('document.querySelector(".overlay").dispatchEvent(new MouseEvent("mousedown",{bubbles:true}))');
  assert.equal(await run('!!document.querySelector("[role=dialog]")'),true,'backdrop cannot dismiss an in-flight import');
  assert.equal(await run('document.querySelector("[role=dialog] button[aria-label=关闭导入]")?.disabled'),true,'import close is unavailable while saving');
  releaseImport();await until('!document.querySelector("[role=dialog]")','import dialog closes after completion');
  await until('window.dcode.request("foundation.snapshot",{}).then(s=>s.tasks.length===2)','import creates one task');
  await fs.writeFile(${JSON.stringify(join(temp,'result.json'))},JSON.stringify({passed:true,actualHost:true,actualWindowKeyboard:true,independentDrafts:3,firstSubmitOnly:true,projectOwnership:true,unsavedBufferRetained:true,menuOnlyExistingEdit:true,nativePreviewYields:true,editorReturnFocus:true,previewAfterSettings:true,themes:2,widths:2,fontScales:3}));app.quit();
 }catch(error){await fs.writeFile(${JSON.stringify(join(temp,'failure.png'))},(await win.webContents.capturePage()).toPNG());await fs.writeFile(${JSON.stringify(join(temp,'result.json'))},JSON.stringify({passed:false,error:String(error),stack:error.stack}));app.exit(1);}
}));import(${JSON.stringify(pathToFileURL(join(client,'dist/src/main/index.js')).href)});
`);
const env={...process.env,DCODE_HOST_ENTRY:hostEntry,DCODE_DATA_ROOT:join(temp,'.dcode'),DCODE_AGENT_DIR:join(temp,'agent'),DCODE_USER_DATA:join(temp,'profile'),DCODE_WIDTH:'1440',PI_OFFLINE:'1'};
for(const key of ['ELECTRON_RUN_AS_NODE','DCODE_RENDERER_URL','DCODE_THEME','DCODE_CAPTURE','DCODE_CREDENTIAL_PIPE_FD','DCODE_DEVICE_CODE_PIPE_FD'])delete env[key];
let output;try{output=await promisify(execFile)(electron,[runner],{cwd:client,env,timeout:120000,maxBuffer:2_000_000});}catch(error){output=error;}
const result=JSON.parse(await readFile(join(temp,'result.json'),'utf8'));console.log(JSON.stringify({temp,...result}));assert.equal(result.passed,true);
