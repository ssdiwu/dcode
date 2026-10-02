import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import electron from "electron";

const client = fileURLToPath(new URL("../../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "dcode-context-usage-"));
const fixture = join(temporary, "fixture.tsx");
await writeFile(fixture, `
import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import{ContextUsage}from'/src/components/ContextUsage.tsx';import'/src/style.css';
window.calls=[];window.listeners=new Set();window.emit=event=>window.listeners.forEach(listener=>listener(event));window.dcode={subscribe:listener=>{window.listeners.add(listener);return()=>window.listeners.delete(listener)},request:async(method,params)=>{window.calls.push({method,params});if(method==='session.contextBreakdown')return{available:true,totalTokens:42000,contextWindow:100000,parts:[{kind:'systemTools',tokens:5000},{kind:'user',tokens:12000},{kind:'assistant',tokens:10000},{kind:'thinking',tokens:5000},{kind:'toolResult',tokens:10000}]};throw Error('Unexpected '+method);}};
const stamp='2026-09-29T00:00:00.000Z';const refreshPresentation=async()=>{};
function Fixture(){const[mode,setMode]=useState('known');window.setMode=setMode;
 const recorded={input:40000,output:2000,cacheRead:0,cacheWrite:0,totalTokens:42000};const entries=[{type:'message',id:'assistant-one',timestamp:stamp,message:{role:'assistant',provider:'provider-a',model:'model-a',stopReason:'stop',usage:mode==='noUsage'?undefined:recorded,timestamp:stamp}}];if(mode==='newReply')entries.push({type:'message',id:'assistant-two',timestamp:stamp,message:{role:'assistant',provider:'provider-a',model:'model-a',stopReason:'stop',usage:recorded,timestamp:stamp}});
 const presentation={dcodeSession:{id:'main'},selectedNativePathId:mode==='history'?'old':'current',nativePaths:[{id:'current',isCurrent:true},{id:'old',isCurrent:false}],binding:{sessionId:'main',adapterSessionId:'adapter-main'},runtime:mode==='inactive'?null:{runtimeId:'runtime-main',state:{sessionId:'adapter-main',model:{provider:'provider-a',id:mode==='model'?'model-b':'model-a',name:'模型 A'},contextUsage:{tokens:42000,contextWindow:100000,percent:42}}},inspection:{selectedPathId:'current',currentPathId:'current',entries}};
 const work={session:{id:'main'},presentation,refreshPresentation,hostDead:mode==='offline'};const models={data:{models:[{key:'model-a',providerId:'provider-a',modelId:'model-a'}],selectedKey:'model-a'},busy:false};
 return <div className='test-composer'><ContextUsage work={work} models={models}/></div>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`);
await writeFile(join(temporary, "fixture.html"), `<!doctype html><html><head><meta charset="utf-8"><style>html,body,#root{height:100%;margin:0}.test-composer{position:absolute;left:24px;bottom:36px;width:300px;padding:10px;border:1px solid var(--c-line);border-radius:16px;background:var(--c-raised)}</style></head><body><div id="root"></div><script type="module" src="/@fs${fixture}"></script></body></html>`);
const server = await createServer({ configFile: join(client, "vite.config.ts"), resolve: { dedupe: ["react", "react-dom"] }, server: { port: 0, strictPort: false, hmr: false, fs: { allow: [client, temporary] } } });
await server.listen();
const address = server.httpServer.address();
const url = `http://127.0.0.1:${address.port}/@fs${join(temporary, "fixture.html")}`;
const runner = join(temporary, "runner.cjs");
await writeFile(runner, `
const{app,BrowserWindow,nativeTheme}=require('electron');const fs=require('node:fs/promises');const assert=require('node:assert/strict');
app.setPath('userData',${JSON.stringify(join(temporary,"profile"))});
app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:400,height:560,webPreferences:{backgroundThrottling:false,sandbox:true}});const run=code=>win.webContents.executeJavaScript(code,true),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));const until=async(code)=>{for(let i=0;i<120;i++){if(await run(code))return;await sleep(25)}throw Error('Timed out: '+code)};
try{nativeTheme.themeSource='light';await win.loadURL(${JSON.stringify(url)});await until('!!document.querySelector(".context-usage-trigger")');
 assert.equal(await run('document.querySelector(".context-usage-trigger").getAttribute("aria-label").includes("58%")'),true);
 await run('document.querySelector(".context-usage-trigger").click()');await until('!!document.querySelector(".context-usage-popover .context-usage-facts")');
 assert.equal(await run('document.querySelector(".context-usage-popover").textContent.includes("42,000 token")'),true);
 assert.equal(await run('document.querySelector(".context-usage-popover").textContent.includes("58,000 token（约58%）")'),true);
 assert.equal(await run('document.querySelector(".context-usage-popover").textContent.includes("已用 · 估算")'),true);
 assert.equal(await run('document.querySelector(".context-usage-popover").textContent.includes("最近模型用量响应")'),true);
 await until('window.calls.some(call=>call.method==="session.contextBreakdown")');
 assert.equal(await run('window.calls.find(call=>call.method==="session.contextBreakdown").params.runtimeId'), 'runtime-main');
 await until('document.querySelector(".context-usage-popover").textContent.includes("用户输入 · 估算")');
 await until('getComputedStyle(document.querySelector(".context-usage-popover")).visibility==="visible"');
 const bounds=await run('(()=>{const b=document.querySelector(".context-usage-popover").getBoundingClientRect();return{left:b.left,right:b.right,top:b.top,bottom:b.bottom}})()');assert.ok(bounds.left>=8&&bounds.right<=392&&bounds.top>=8&&bounds.bottom<=552,JSON.stringify(bounds));
 await fs.writeFile(${JSON.stringify(join(temporary,"known-light.png"))},(await win.webContents.capturePage()).toPNG());
 await run('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');await until('!document.querySelector(".context-usage-popover")');assert.equal(await run('document.activeElement===document.querySelector(".context-usage-trigger")'),true);
 await run('window.emit({event:"session.event",data:{type:"compaction_end",aborted:false,errorMessage:"压缩失败",runtime:{dcodeSessionId:"main"}}})');await sleep(50);assert.equal(await run('document.querySelector(".context-usage-trigger").textContent.includes("约58%")'),true);
 await run('window.emit({event:"session.event",data:{type:"compaction_end",aborted:false,result:{summary:"完成"},runtime:{dcodeSessionId:"main"}}})');await until('document.querySelector(".context-usage-trigger").textContent.includes("未知")');
 await run('window.setMode("newReply")');await until('document.querySelector(".context-usage-trigger").textContent.includes("58%")');
 await run('window.setMode("noUsage")');await until('document.querySelector(".context-usage-trigger").textContent.includes("未知")');assert.equal(await run('!!document.querySelector(".context-usage-ring")'),false);await run('document.querySelector(".context-usage-trigger").click()');await until('document.querySelector(".context-usage-popover")?.textContent.includes("还没有可核对的模型用量响应")');assert.equal(await run('document.querySelector(".context-usage-popover").textContent.includes("最近模型用量响应")'),false);await run('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');await until('!document.querySelector(".context-usage-popover")');
 await run('window.setMode("history")');await until('document.querySelector(".context-usage-trigger").textContent.includes("未知")');assert.equal(await run('!!document.querySelector(".context-usage-ring")'),false);
 await run('window.setMode("model")');await sleep(50);assert.equal(await run('document.querySelector(".context-usage-trigger").textContent.includes("未知")'),true);
 await run('window.setMode("offline")');await sleep(50);assert.equal(await run('document.querySelector(".context-usage-trigger").textContent.includes("未知")'),true);
 await run('window.setMode("inactive")');await sleep(50);await run('document.querySelector(".context-usage-trigger").click()');await until('document.querySelector(".context-usage-popover")?.textContent.includes("没有活动运行实例")');
 nativeTheme.themeSource='dark';await sleep(70);await fs.writeFile(${JSON.stringify(join(temporary,"unknown-dark.png"))},(await win.webContents.capturePage()).toPNG());console.log(JSON.stringify({temporary:${JSON.stringify(temporary)},bounds,calls:await run('window.calls')}));app.exit(0);
}catch(error){console.error(error);app.exit(1)}}).catch(error=>{console.error(error);app.exit(1)});
`);
try {
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
  const result = await promisify(execFile)(electron, [runner], { cwd: client, env: environment, timeout: 40_000, maxBuffer: 200_000 });
  assert.match(result.stdout, /runtime-main/u);
  console.log(result.stdout.trim());
} finally { await server.close(); }
