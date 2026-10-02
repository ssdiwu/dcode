import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath,pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../..",import.meta.url));
const client = join(root, "client");
const host = join(root, "host/dist/src");
const electron = createRequire(join(client, "package.json"))("electron");
const { ProductStore } = await import(pathToFileURL(join(host, "product-store.js")).href);
const temp = await mkdtemp(join(tmpdir(), "dcode-file-mention-ui-"));
const home = join(temp, "home"), project = join(temp, "project"), agent = join(temp, "agent");
const dataRoot = join(temp, ".dcode");
for (const directory of [home, project, agent, join(project, "a"), join(project, "b")]) await mkdir(directory);
await writeFile(join(project, "a/same.ts"), "export const choice = 'A';\n");
await writeFile(join(project, "b/same.ts"), "export const choice = 'B';\n");
await writeFile(join(home, "same.ts"), "HOME CONTENT MUST NOT APPEAR\n");
await writeFile(join(agent, "settings.json"), JSON.stringify({defaultProvider:"mention-fixture", defaultModel:"model", enabledModels:["mention-fixture/model"]}));
await writeFile(join(agent, "models.json"), JSON.stringify({providers:{"mention-fixture":{baseUrl:"https://mention-fixture.invalid/v1",api:"openai-completions",apiKey:"fixture-only-key",models:[{id:"model",name:"Fixture",reasoning:false,contextWindow:100000,maxTokens:4096}]}}}));

const store = await ProductStore.open({dataRoot,userHome:home});
let snapshot = await store.snapshot();
const createdProject = await store.createProject({requestId:"mention-project",expectedStoreRevision:snapshot.storeRevision,title:"文件引用项目",directory:project});
snapshot = await store.snapshot();
const projectTask = await store.createTask({requestId:"mention-project-task",expectedStoreRevision:snapshot.storeRevision,scope:{kind:"project",projectId:createdProject.project.id},title:"项目引用任务",goal:"核对项目文件引用"});
snapshot = await store.snapshot();
const userTask = await store.createTask({requestId:"mention-user-task",expectedStoreRevision:snapshot.storeRevision,scope:{kind:"user",userId:snapshot.currentUser.id},title:"独立引用任务",goal:"核对独立任务不搜索 Home"});
snapshot = await store.snapshot();
await store.patchTaskWorkbenchViewState({requestId:"mention-select",expectedStoreRevision:snapshot.storeRevision,expectedViewStateRevision:snapshot.taskWorkbenchViewState.revision,patch:{selection:{taskId:projectTask.task.id,sessionId:projectTask.coordinationSession.id}}});
await store.close();

let entry = await readFile(join(host,"index.js"),"utf8");
entry = entry.replace(/^#!.*\n/,"").replace(/from "\.\//g,`from "${pathToFileURL(host+"/").href}`).replace("const host = new PiHost({",`const host = new PiHost({userHome:${JSON.stringify(home)},`);
const fixtureNetwork = `globalThis.fetch=async(input)=>{if(!String(input).startsWith('https://mention-fixture.invalid/'))throw Error('Unexpected fixture network');const frame=(text,finish=null)=>'data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:'model',choices:[{index:0,delta:text?{role:'assistant',content:text}:{},finish_reason:finish}],...(finish?{usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}:{})})+'\\n\\n';return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(frame('引用已记录')+frame('','stop')+'data: [DONE]\\n\\n'));c.close();}}),{headers:{'content-type':'text/event-stream'}});};\n`;
const hostEntry = join(temp,"host.mjs");
await writeFile(hostEntry, fixtureNetwork+entry);

const runner = join(temp,"runner.cjs");
await writeFile(runner, `
const {app,BrowserWindow}=require('electron'),fs=require('node:fs/promises'),assert=require('node:assert/strict');
BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.focus=function(){};
app.once('browser-window-created',(_event,win)=>win.webContents.once('did-finish-load',async()=>{
 const run=code=>win.webContents.executeJavaScript(code,true).catch(error=>{throw Error(code.slice(0,180)+': '+error.message)}),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const until=async(code,label)=>{for(let i=0;i<320;i++){if(await run(code))return;await sleep(25)}throw Error('Timeout '+label+'; composer='+await run('document.querySelector("[data-composer]")?.value')+'; alert='+await run('document.querySelector("[role=alert]")?.textContent'))};
 const fill=text=>run('(()=>{const field=document.querySelector("[data-composer]");if(!field)throw Error("Missing composer");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(field,'+JSON.stringify(text)+');field.setSelectionRange(field.value.length,field.value.length);field.dispatchEvent(new Event("input",{bubbles:true}));})()');
 const key=key=>run('document.querySelector("[data-composer]").dispatchEvent(new KeyboardEvent("keydown",'+JSON.stringify({key,bubbles:true})+'))');
 const click=label=>run('(()=>{const label='+JSON.stringify(label)+';const button=Array.from(document.querySelectorAll("button")).find(item=>item.getAttribute("aria-label")===label||item.textContent.trim()===label);if(!button)throw Error("Missing button "+label);button.click();})()');
 const presentation=()=>run('window.dcode.request("dcodeSession.presentation",{dcodeSessionId:'+JSON.stringify(${JSON.stringify(projectTask.coordinationSession.id)})+'})');
 const options=()=>run('Array.from(document.querySelectorAll("#file-mentions [role=option]")).map(node=>node.textContent.trim())');
 const navigate=async title=>{await run('Array.from(document.querySelectorAll(".task-row")).find(item=>item.textContent.includes('+JSON.stringify(title)+')).click()');await until('document.querySelector("[data-composer]")?.getAttribute("aria-label")==="任务消息"','task navigation')};
 try{
  await until('!!document.querySelector("[data-composer]")','project Task composer');
  assert.ok(await run('document.querySelector(".task-row[aria-current=page]")?.textContent.includes("项目引用任务")'),'project Task restored');
  await fill('请查 @same.ts');
  await until('document.querySelectorAll("#file-mentions [role=option]").length===2','two same-name file candidates');
  await fs.writeFile(${JSON.stringify(join(temp,"same-name-candidates.png"))},(await win.webContents.capturePage()).toPNG());
  assert.deepEqual((await options()).sort(),['same.tsa/same.ts','same.tsb/same.ts']);
  assert.equal(await run('document.querySelector("[data-composer]")?.getAttribute("aria-activedescendant")'),null,'no file preselected');
  await key('Enter');
  await until('window.dcode.request("dcodeSession.presentation",{dcodeSessionId:'+JSON.stringify(${JSON.stringify(projectTask.coordinationSession.id)})+'}).then(p=>p.submissions?.some(item=>item.text==="请查 @same.ts"))','plain @ text sent without implicit selection');
  assert.equal((await presentation()).submissions.filter(item=>item.text==='请查 @same.ts').length,1);
  await until('window.dcode.request("foundation.snapshot").then(s=>s.sessionRuns.filter(r=>r.taskId==='+JSON.stringify(${JSON.stringify(projectTask.task.id)})+').at(-1)?.status==="completed")','first fixture run completed');
  await fill('请查看 @same.ts');
  await until('document.querySelectorAll("#file-mentions [role=option]").length===2','same-name candidates reopened');
  await run('Array.from(document.querySelectorAll("#file-mentions [role=option]")).find(item=>item.textContent.includes("b/same.ts")).click()');
  await until('document.querySelector("[data-composer]")?.value.includes("[b/same.ts](dcode-file:")','explicit B selection inserted');
  const selected=await run('document.querySelector("[data-composer]").value');
  assert.equal(selected.startsWith('请查看 [b/same.ts](dcode-file:'),true);
  assert.equal(selected.includes('a/same.ts'),false);
  await click('发送');
  await until('window.dcode.request("dcodeSession.presentation",{dcodeSessionId:'+JSON.stringify(${JSON.stringify(projectTask.coordinationSession.id)})+'}).then(p=>p.submissions?.some(item=>item.text.includes("[b/same.ts](dcode-file:")))','selected B raw submission');
  const saved=await presentation();
  assert.equal(saved.submissions.at(-1).text.trim(),selected.trim(),'Raw Input keeps exactly selected Markdown reference');
  await until('Array.from(document.querySelectorAll(".message.user")).some(item=>item.textContent.includes("b/same.ts"))','selected user message visible');
  await fs.writeFile(${JSON.stringify(join(temp,"submitted-reference.png"))},(await win.webContents.capturePage()).toPNG());
  const clickable=await run('Array.from(document.querySelectorAll(".file-reference")).some(item=>item.textContent.trim()==="b/same.ts")');
  if(clickable){
   await run('Array.from(document.querySelectorAll(".file-reference")).find(item=>item.textContent.trim()==="b/same.ts").click()');
   await until('document.querySelector(".file-origin")?.textContent.includes("b/same.ts")','reference opens B path');
   await until('document.querySelector(".file-content")?.textContent.includes("choice = \\\'B\\\'")','reference opens B content');
   assert.equal(await run('document.querySelector(".file-origin")?.textContent.includes("a/same.ts")'),false);
   await click('收起文件详情');
  }
  await fill('失效文件 @same.ts');
  await until('document.querySelectorAll("#file-mentions [role=option]").length===2','candidates before removal');
  await run('Array.from(document.querySelectorAll("#file-mentions [role=option]")).find(item=>item.textContent.includes("a/same.ts")).click()');
  await until('document.querySelector("[data-composer]")?.value.includes("[a/same.ts](dcode-file:")','explicit A selection inserted');
  const stale=await run('document.querySelector("[data-composer]").value');
  await fs.unlink(${JSON.stringify(join(project,"a/same.ts"))});
  const before=(await presentation()).submissions.length;
  await click('发送');
  await until('document.querySelector(".composer-wrap [role=alert]")?.textContent.includes("已删除")','deleted file rejected');
  assert.equal(await run('document.querySelector("[data-composer]").value'),stale,'rejected send preserves editable draft');
  assert.equal((await presentation()).submissions.length,before,'invalid reference adds no submission');
  await navigate('独立引用任务');
  await fill('@same.ts');
  await until('document.querySelector("#file-mentions")?.textContent.includes("请先进入一个项目任务")','User Scope empty state');
  assert.equal(await run('document.querySelectorAll("#file-mentions [role=option]").length'),0,'Home file is not offered');
  const userSearch=await run('window.dcode.request("workspace.fileSearch",{taskId:'+JSON.stringify(${JSON.stringify(userTask.task.id)})+',query:"same.ts"})');
  assert.deepEqual(userSearch,{scopeRequired:true,entries:[],truncated:false},'Host never scans implicit Home');
  await fs.writeFile(${JSON.stringify(join(temp,"result.json"))},JSON.stringify({passed:clickable,explicitCandidate:'b/same.ts',plainAtPreserved:true,rawInput:true,referenceOpen:clickable,deletedRejected:true,draftPreserved:true,userScopeNoHome:true,...(clickable?{}:{failure:'Submitted user message has no clickable file reference'})}));
  app.quit();
 }catch(error){await fs.writeFile(${JSON.stringify(join(temp,"failure.png"))},(await win.webContents.capturePage()).toPNG());await fs.writeFile(${JSON.stringify(join(temp,"result.json"))},JSON.stringify({passed:false,error:String(error),stack:error.stack}));app.exit(1)}
}));
import(${JSON.stringify(pathToFileURL(join(client,"dist/src/main/index.js")).href)});
`);
const {createServer}=await import(pathToFileURL(join(client,"node_modules/vite/dist/node/index.js")).href);
const vite=await createServer({configFile:join(client,"vite.config.ts"),cacheDir:join(temp,"vite-cache"),server:{port:5173,strictPort:true,hmr:false}});
await vite.listen();
const env={...process.env,DCODE_HOST_ENTRY:hostEntry,DCODE_DATA_ROOT:dataRoot,DCODE_AGENT_DIR:agent,DCODE_USER_DATA:join(temp,"profile"),DCODE_WIDTH:"1440",DCODE_RENDERER_URL:"http://127.0.0.1:5173/",PI_OFFLINE:"1"};
for(const key of ["ELECTRON_RUN_AS_NODE","DCODE_THEME","DCODE_CAPTURE","DCODE_CREDENTIAL_PIPE_FD","DCODE_DEVICE_CODE_PIPE_FD"])delete env[key];
let output;
try{output=await promisify(execFile)(electron,[runner],{cwd:client,env,timeout:120000,maxBuffer:2_000_000});}
catch(error){output=error;}
finally{await vite.close();}
let result;
try{result=JSON.parse(await readFile(join(temp,"result.json"),"utf8"));}
catch(error){throw new Error(`Electron did not produce a result; fixture=${temp}; output=${JSON.stringify(output)}`,{cause:error});}
console.log(JSON.stringify({temp,...result}));
assert.equal(result.passed,true,JSON.stringify(output));
