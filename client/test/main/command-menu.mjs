import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import electron from "electron";

const client = fileURLToPath(new URL("../../",import.meta.url));
const temp = await mkdtemp(join(tmpdir(),"dcode-command-menu-"));
const baseline = process.argv.includes("--baseline");
const names = ["507-breakdown","507-cast","507-commit","507-explain","507-explore","507-fix","507-forge","507-frame"];
const commands = [
  ...Array.from({length:169},(_,i)=>({name:`skill:${names[i]??`507-workflow-${String(i+1).padStart(3,"0")}`}`,source:"skill",description:i===0?"视频拉片：理解整段结构、定位文字、核对镜头证据，再整理可复用的分析结果。".repeat(8):`根据真实材料处理第 ${i+1} 项工作，保留来源与验收边界。较长说明可查看完整内容。`.repeat(4)})),
  ...["compact","model","session","help","usage","reload","status"].map(name=>({name,source:"extension",description:`运行 ${name} 命令，使用当前任务提供的能力。`})),
  ...["weekly-report","meeting-summary","proposal","research-brief","release-notes"].map(name=>({name,source:"prompt",description:`根据上下文填写 ${name} 模板。`})),
];
const fixture = join(temp,"fixture.tsx");
await writeFile(fixture, `
import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{SWRConfig}from'swr';
import{Composer}from'/src/components/Composer.tsx';import'/src/style.css';import{installMotionTokens}from'/src/workbench/motion.ts';
const catalog=${JSON.stringify(commands)};window.menuMode='loaded';window.submissions=[];
window.dcode={request:async(method)=>{if(method!=='dcodeSession.commands')throw Error('Unexpected '+method);await new Promise(r=>setTimeout(r,window.menuMode==='loading'?900:80));if(window.menuMode==='error')throw Error('测试目录暂不可用');return{commands:window.menuMode==='empty'?[]:catalog};}};
function Fixture(){const[draft,setDraft]=useState({text:'',images:[]});window.currentDraft=draft.text;
 const work={draft,draftKey:'menu-test',snapshot:{projects:[],agentRuns:[],sessions:[],sessionRuns:[]},session:null,newProjectId:null,preferences:{},running:false,sending:false,closing:false,hostDead:false,updateDraft:(_key,next)=>setDraft(old=>typeof next==='function'?next(old):next),send:async()=>window.submissions.push(draft.text),setNewProjectId:()=>{},fail:()=>{},trackAttachmentImport:()=>{}};
 const models={data:{models:[{key:'fixture',name:'测试模型',modelId:'fixture',available:true,enabled:true,providerId:'local',providerName:'测试'}],selectedKey:'fixture',thinkingLevels:[]},choose:()=>{},refresh:()=>{},setThinking:()=>{}};
 return <main className="fixture-area new-task-stage"><div className="fixture-composer"><Composer work={work} models={models} pathForFile={()=>''} onSettings={()=>{}}/></div></main>;}
installMotionTokens(document.documentElement);createRoot(document.getElementById('root')).render(<SWRConfig value={{provider:()=>new Map(),dedupingInterval:0}}><Fixture/></SWRConfig>);
`);
await writeFile(join(temp,"fixture.html"),`<!doctype html><html><head><meta charset="utf-8"><style>html,body,#root{height:100%;margin:0}.fixture-area{height:100%;display:grid;place-items:center}.fixture-composer{width:min(760px,calc(100vw - 48px))}</style></head><body><div id="root"></div><script type="module" src="/@fs${fixture}"></script></body></html>`);
const server = await createServer({configFile:join(client,"vite.config.ts"),resolve:{dedupe:["react","react-dom","swr"]},optimizeDeps:{include:["react","react-dom/client","swr","@floating-ui/react-dom"]},server:{port:0,strictPort:false,hmr:false,fs:{allow:[client,temp]}}});
await server.listen();
const address = server.httpServer.address();
const url = `http://127.0.0.1:${address.port}/@fs${join(temp,"fixture.html")}`;
const runner = join(temp,"runner.cjs");
await writeFile(runner, `
const{app,BrowserWindow,nativeTheme}=require('electron');const fs=require('node:fs/promises');const assert=require('node:assert/strict');
app.setPath('userData',${JSON.stringify(join(temp,"profile"))});
app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1200,height:900,webPreferences:{backgroundThrottling:false,sandbox:true}});const errors=[];win.webContents.on('console-message',d=>{if(d.level==='error')errors.push(d.message)});
 const run=code=>win.webContents.executeJavaScript(code,true),sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const until=async(code,label)=>{for(let i=0;i<200;i++){if(await run(code))return;await sleep(25)}throw Error('Timeout '+label)};
 const click=()=>run('document.querySelector(".composer-command-trigger").click()');
 const key=(key,extra={})=>run('document.querySelector("[data-composer]").dispatchEvent(new KeyboardEvent("keydown",'+JSON.stringify({key,bubbles:true,...extra})+'))');
 const setText=text=>run('(()=>{const t=document.querySelector("[data-composer]");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(t,'+JSON.stringify(text)+');t.dispatchEvent(new Event("input",{bubbles:true}));})()');
 const geometry=()=>run('(()=>{const r=s=>{const b=document.querySelector(s).getBoundingClientRect();return{x:b.x,y:b.y,width:b.width,height:b.height}};return{composer:r(".composer"),input:r("[data-composer]"),controls:r(".composer-controls")};})()');
 try{
  nativeTheme.themeSource='dark';await win.loadURL(${JSON.stringify(url)});await until('!!document.querySelector("[data-composer]")','composer');
  await sleep(120);const before=await geometry();await click();await until('document.querySelectorAll("#composer-commands [role=option]").length>0','catalog');await sleep(180);const after=await geometry();const count=await run('document.querySelectorAll("#composer-commands [role=option]").length');
  await fs.writeFile(${JSON.stringify(join(temp,"menu-dark.png"))},(await win.webContents.capturePage()).toPNG());
  const matrix=[];
  if(!${JSON.stringify(baseline)}){
    assert.equal(await run('document.querySelector("#composer-command-0 .command-name").textContent'),'507 Breakdown');
    assert.equal(await run('document.querySelector("#composer-command-0").title.includes("/skill:")'),false);
    assert.equal(await run('document.querySelector("#composer-command-0 .command-description").textContent.length>200'),true);
    assert.equal(await run('document.querySelector("#composer-command-0").title.endsWith(document.querySelector("#composer-command-0 .command-description").textContent)'),true);
    assert.equal(await run('document.activeElement===document.querySelector("[data-composer]")'),true);
    assert.equal(await run('Array.from(document.querySelectorAll("#composer-commands [role=option]")).every(b=>b.tabIndex===-1)'),true);
    for(let i=0;i<85;i++)await key('ArrowDown');
    const active=await run('(()=>{const t=document.querySelector("[data-composer]"),r=document.getElementById(t.getAttribute("aria-activedescendant")),b=r.getBoundingClientRect(),p=document.querySelector(".command-list").getBoundingClientRect();return{id:r.id,top:b.top,bottom:b.bottom,pTop:p.top,pBottom:p.bottom};})()');
    assert.equal(active.id,'composer-command-85');assert.ok(active.top>=active.pTop-1&&active.bottom<=active.pBottom+1);
    await key('Enter',{isComposing:true});assert.equal(await run('!!document.getElementById("composer-commands")'),true);assert.equal(await run('window.currentDraft'),'');
    await key('Enter',{keyCode:229});assert.equal(await run('window.currentDraft'),'');
    await key('Enter');await until('!document.getElementById("composer-commands")','choose closes');assert.equal(await run('window.currentDraft'),'/skill:507-workflow-086 ');assert.equal(await run('window.submissions.length'),0);
    await setText('/breakdown');await until('document.querySelectorAll("#composer-commands [role=option]").length===1','display search');
    await key('Enter');assert.equal(await run('window.currentDraft'),'/skill:507-breakdown ');
    await setText('/507');await until('!!document.getElementById("composer-commands")','readable search');await setText('/507 Breakdown');await until('document.querySelectorAll("#composer-commands [role=option]").length===1','multiword readable name');await key('Enter');assert.equal(await run('window.currentDraft'),'/skill:507-breakdown ');
    await setText('/compact');await until('!!document.getElementById("composer-commands")','canonical command');await setText('/compact 保留这些参数');await until('!document.getElementById("composer-commands")','arguments close menu');assert.equal(await run('window.currentDraft'),'/compact 保留这些参数');
    await setText('/skill:507-workflow-169');await until('document.querySelectorAll("#composer-commands [role=option]").length===1','canonical search past old limit');
    await run('document.querySelector("#composer-commands [role=option]").click()');assert.equal(await run('window.currentDraft'),'/skill:507-workflow-169 ');
    await setText('/没有这个技能');await until('!!document.getElementById("composer-commands")','empty search');assert.equal(await run('document.querySelectorAll("#composer-commands [role=option]").length'),0);await key('Escape');
    await setText('现有草稿');await click();await until('document.querySelectorAll("#composer-commands [role=option]").length===${commands.length}','all commands');
    win.webContents.focus();win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});
    await until('!document.getElementById("composer-commands")','Tab closes');assert.equal(await run('document.activeElement===document.querySelector("[data-composer]")'),false);assert.equal(await run('window.currentDraft'),'现有草稿');
    await click();await until('!!document.getElementById("composer-commands")','reopen');
    await run('document.querySelector(".model-trigger").dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,button:0,pointerType:"mouse"}))');await until('!document.getElementById("composer-commands")','outside control closes');
    await run('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
    for(const theme of ['light','dark'])for(const [width,height] of [[1200,900],[760,560]])for(const zoom of [.92,1,1.12])for(const edge of ['top','bottom']){
      nativeTheme.themeSource=theme;win.setContentSize(width,height);win.webContents.setZoomFactor(zoom);await sleep(40);
      await run('Object.assign(document.querySelector(".fixture-composer").style,{position:"fixed",left:"50%",transform:"translateX(-50%)",top:'+JSON.stringify(edge==='top'?'48px':'auto')+',bottom:'+JSON.stringify(edge==='bottom'?'36px':'auto')+'});void 0;');
      await setText('');const closed=await geometry();await click();await until('document.querySelectorAll("#composer-commands [role=option]").length===${commands.length}','matrix options');await sleep(80);const opened=await geometry();
      const bounds=await run('(()=>{const p=document.querySelector(".command-popover"),r=p.getBoundingClientRect();return{placement:p.dataset.placement,left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight};})()');
      for(const part of ['composer','input','controls'])for(const dimension of ['x','y','width','height'])assert.ok(Math.abs(closed[part][dimension]-opened[part][dimension])<1,'matrix geometry '+part);
      assert.ok(bounds.left>=7&&bounds.top>=7&&bounds.right<=bounds.width-7&&bounds.bottom<=bounds.height-7,'within viewport '+JSON.stringify(bounds));
      assert.ok(bounds.placement.startsWith(edge==='top'?'bottom':'top'),'flips to available space');
      matrix.push({theme,width,height,zoom,edge,bounds});
      if(zoom===1)await fs.writeFile(${JSON.stringify(temp)}+'/menu-'+theme+'-'+width+'-'+edge+'.png',(await win.webContents.capturePage()).toPNG());
      await key('Escape');await until('!document.getElementById("composer-commands")','matrix close');
    }
    for(const mode of ['loading','error','empty']){
      await run('window.menuMode='+JSON.stringify(mode));await new Promise(resolve=>{win.webContents.once('did-finish-load',resolve);win.reload();});await until('!!document.querySelector("[data-composer]")','state reload');await run('window.menuMode='+JSON.stringify(mode));await click();
      if(mode==='loading'){await until('!!document.querySelector("#composer-commands [role=status]")','loading');assert.equal(await run('document.querySelectorAll("#composer-commands [role=option]").length'),0);}
      if(mode==='error')await until('!!document.querySelector("#composer-commands [role=alert]")','error');
      if(mode==='empty')await until('document.querySelector("#composer-commands")?.textContent.includes("没有匹配")','empty state');
      await key('Escape');
    }
  }
  const report={before,after,count,total:${commands.length},errors,matrix};
  if(!${JSON.stringify(baseline)}){assert.equal(count,${commands.length});for(const part of ['composer','input','controls'])for(const dimension of ['x','y','width','height'])assert.ok(Math.abs(before[part][dimension]-after[part][dimension])<1,part+' '+dimension+' stays fixed');}
  await fs.writeFile(${JSON.stringify(join(temp,"result.json"))},JSON.stringify(report,null,2));app.exit(0);
 }catch(error){await fs.writeFile(${JSON.stringify(join(temp,"failure.png"))},(await win.webContents.capturePage()).toPNG());console.error(error);app.exit(1);}
}).catch(error=>{console.error(error);app.exit(1)});
`);
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
try{
  const result=await promisify(execFile)(electron,[runner],{cwd:client,env,timeout:60000,maxBuffer:2_000_000});
  const evidence=JSON.parse(await readFile(join(temp,"result.json"),"utf8"));
  console.log(JSON.stringify({temp,...evidence}));
}finally{await server.close();}
