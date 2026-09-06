import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {mkdtemp, readdir, writeFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import electron from "electron";

// A hidden, isolated Chromium window measures the shipped CSS, not a user's app.
const client = fileURLToPath(new URL("../../", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "dcode-layout-test-"));
try {
  const assetDir = join(client, "dist/renderer/assets");
  const links = (await readdir(assetDir)).filter(name => name.endsWith(".css")).map(name => `<link rel="stylesheet" href="${pathToFileURL(join(assetDir,name)).href}">`).join("");
  assert.ok(links, "Build the renderer before measuring its layout");
  const html = join(root, "fixture.html");
  await writeFile(html, `<!doctype html><html><head>${links}</head><body><div id="root"></div></body></html>`);
  const cases = [
    {width:1520,nav:280}, {width:1440,nav:240}, {width:1200,nav:240},
    {width:1024,nav:280}, {width:800,nav:240}, {width:1440,nav:0},
    {width:1520,nav:280,inspector:true}, {width:1024,nav:280,inspector:true},
    {width:1200,nav:280,inspector:true,inspectorWidth:600}, {width:1520,nav:280,inspector:true,inspectorWidth:600},
  ].flatMap(item => [{...item,overview:false},{...item,overview:true}]).flatMap(item=>[{...item,empty:false},{...item,empty:true}]);
  const runner = join(root,"runner.cjs");
  await writeFile(runner, `
const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(join(root,"user-data"))});
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false,sandbox:true,contextIsolation:true}});
 await win.loadFile(${JSON.stringify(html)});
 const results=[];
 for(const fixture of ${JSON.stringify(cases)}){
  win.setContentSize(fixture.width,900);
  results.push(await win.webContents.executeJavaScript('('+(${function(fixture){
    document.getElementById("root").innerHTML = `<div class="workbench ${fixture.nav ? "" : "nav-hidden"}" style="--nav-width:${fixture.nav}px;--inspector-width:${fixture.inspectorWidth ?? 340}px">${fixture.nav ? '<nav class="navigation"></nav>' : ''}<main class="workspace"><header class="workspace-bar">标题</header><div class="work-area ${fixture.inspector ? 'with-inspector' : ''}"><section class="conversation-space"><div class="transcript-frame"><nav class="conversation-rail" style="--turn-count:6"><button class="conversation-rail-track">${'<span class="conversation-rail-mark"></span>'.repeat(6)}</button></nav><div class="transcript"><div class="reading-lane" id="message-lane">${fixture.empty?'<div class="empty-conversation"><h1>开始这项任务</h1><p>任务目标</p></div>':'<article class="message">正文</article>'}</div></div><button class="jump-latest icon-button">↓</button></div><div class="reading-lane" id="composer-lane"><div class="composer"><textarea aria-label="消息"></textarea></div></div></section>${fixture.overview&&!fixture.inspector?'<aside class="overview">概览</aside>':''}${fixture.inspector?'<aside class="inspector">详情</aside>':''}</div></main></div>`;
    return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{
      const rect = selector => {const el=document.querySelector(selector); if(!el)return null; const r=el.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width,top:r.top,bottom:r.bottom};};
      const textarea = document.querySelector('.composer textarea');
      const inputStyle = getComputedStyle(textarea);
      resolve({inputStyle:{resize:inputStyle.resize},fixture,workspace:rect('.workspace'),conversation:rect('.conversation-space'),message:rect('#message-lane'),composer:rect('#composer-lane'),empty:rect('.empty-conversation h1'),jump:rect('.jump-latest'),rail:rect('.conversation-rail-track'),overview:rect('.overview'),inspector:rect('.inspector'),overflow:document.documentElement.scrollWidth>innerWidth});
    })));
  }.toString()})+')('+JSON.stringify(fixture)+')'));
 }
 console.log(JSON.stringify(results));app.exit(0);
}).catch(error=>{console.error(error);app.exit(1)});
`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const {stdout}=await promisify(execFile)(electron,[runner],{env,timeout:60000,maxBuffer:1_000_000});
  const results=JSON.parse(stdout.trim().split("\n").at(-1));
  for(const result of results){
    const context=JSON.stringify(result);
    const inset=result.message.left-result.workspace.left;
    assert.ok(inset>=47.5,context);
    const center=rect=>(rect.left+rect.right)/2;
    if(!result.overview)assert.ok(Math.abs(center(result.message)-center(result.conversation))<.5,`No overview: reading content must be centered. ${context}`);
    else assert.ok(inset<=92.5,context);
    if(result.empty)assert.ok(Math.abs(center(result.empty)-center(result.composer))<.5,context);
    assert.ok(Math.abs(center(result.jump)-center(result.composer))<.5,context);
    assert.ok(Math.abs(result.message.left-result.composer.left)<.5,context);
    assert.ok(Math.abs(result.message.width-result.composer.width)<.5,context);
    assert.ok(result.message.right<=result.conversation.right-.5,context);
    assert.ok(result.rail.right<result.message.left,context);
    assert.equal(result.overflow,false,context);
    assert.equal(result.inputStyle.resize,"none",context);
    if(result.overview&&result.workspace.width>=950)assert.ok(result.message.right+16<=result.overview.left,context);
  }
  for(const closed of results.filter(result=>!result.fixture.overview)){
    const opened=results.find(result=>result.fixture.overview&&result.fixture.width===closed.fixture.width&&result.fixture.nav===closed.fixture.nav&&result.fixture.inspector===closed.fixture.inspector&&result.fixture.inspectorWidth===closed.fixture.inspectorWidth&&result.fixture.empty===closed.fixture.empty);
    const center=rect=>(rect.left+rect.right)/2;
    if(opened.overview&&opened.conversation.width>=650)assert.ok(center(opened.message)<center(closed.message)-1,"Opening the overview must move the reading column left when there is room");
    if(!opened.overview)assert.deepEqual(opened.message,closed.message,"An inspector must not reserve a second hidden overview gutter");
  }
  console.log(JSON.stringify({passed:results.length,layouts:results.map(r=>({width:r.fixture.width,nav:r.fixture.nav,inspector:!!r.fixture.inspector,overview:r.fixture.overview,inset:Math.round(r.message.left-r.workspace.left),content:Math.round(r.message.width)}))}));
} finally {await rm(root,{recursive:true,force:true});}
