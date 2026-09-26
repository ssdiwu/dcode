import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import electron from "electron";
import { ProductStore } from "../../../host/dist/src/product-store.js";

const client = fileURLToPath(new URL("../../", import.meta.url));
const temp = await mkdtemp(join(tmpdir(), "dcode-routes-ui-")), home = join(temp, "home");
await mkdir(home); await mkdir(join(temp, "agent")); await writeFile(join(temp, "agent/settings.json"), "{}\n");
const store = await ProductStore.open({ dataRoot: join(temp, ".dcode"), userHome: home });
let snapshot = await store.snapshot();
const scope = { kind: "user", userId: snapshot.currentUser.id };
const { task, coordinationSession } = await store.createTask({ requestId: "task", expectedStoreRevision: snapshot.storeRevision, scope, title: "路线界面验证", goal: "核对采用依据、候选与失败记录" });
const { agentRun } = await store.ensureCoordinatorAgentRun({ requestId: "owner", taskId: task.id, scope });
const run = await store.prepareSessionRun({ requestId: "run", taskId: task.id, scope, sessionId: coordinationSession.id, runtimeId: "fixture", agentRunId: agentRun.id, workspaceId: "fixture", cwd: home, workspaceAccess: "sharedReadOnly", message: "受控界面验证", attachmentRefs: [], roleRevision: "fixture:v1", contextRevision: 1, profileSnapshot: {}, tools: [], toolsWritable: false, systemPromptDigest: `sha256:${"f".repeat(64)}`, promptSources: [] });
await store.startSessionRun(run.sessionRunId);
let serial = 0;
const act = operation => store.updateTaskRoute({ requestId: `route-${++serial}`, taskId: task.id, agentRunId: agentRun.id, sessionRunId: run.sessionRunId, expectedPlanRevision: store.taskRouteContext(task.id)?.planRevision ?? 0, operation });
await act({ action: "begin", question: "文件如何分段读取", budget: { candidates: 3, checks: 3, rounds: 2 }, independentCheck: false });
await act({ action: "propose", candidate: { title: "保留解码状态", approach: "逐段读取，跨段保留解码状态", assumptions: ["接口允许分段"], basis: "受控界面测试材料", evidenceIds: [], failureConditions: ["跨段字符丢失"], probe: "检查边界样例", expectedCost: "一次边界检查", remainingWork: ["实现并验证"], dependencies: "读取接口允许保留状态" } });
await act({ action: "stop", reason: "保留未验证候选，等待边界证据" });
await store.finishSessionRun({ sessionRunId: run.sessionRunId, providerAttemptId: run.providerAttemptId, outcome: "succeeded", assistantText: "已保存候选，尚未采用。" });
snapshot = await store.snapshot();
await store.patchTaskWorkbenchViewState({ requestId: "select", expectedStoreRevision: snapshot.storeRevision, expectedViewStateRevision: snapshot.taskWorkbenchViewState.revision, patch: { selection: { taskId: task.id, sessionId: coordinationSession.id }, expandedHudSections: ["progress", "team"] } });
await store.setClientPreferences({ requestId: "overview", expectedStoreRevision: (await store.snapshot()).storeRevision, overviewVisible: true });
await store.close();

const runner = join(temp, "runner.cjs");
await writeFile(runner, `
const {app,BrowserWindow,nativeTheme}=require('electron');const fs=require('node:fs/promises');const assert=require('node:assert/strict');
BrowserWindow.prototype.show=function(){};BrowserWindow.prototype.focus=function(){};
app.on('browser-window-created',(_event,win)=>win.webContents.once('did-finish-load',async()=>{
 const run=code=>win.webContents.executeJavaScript(code,true),sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const until=async(code)=>{for(let i=0;i<200;i++){if(await run(code))return;await sleep(30);}throw Error('Route UI timeout');};
 try {
  await until('!!document.querySelector(".task-route-summary")');
  assert.ok(await run('document.querySelector(".task-route-summary").textContent.includes("探索已停止")'));
  await run('document.querySelector(".task-route-summary summary").click()');
  assert.ok(await run('document.querySelector(".task-route-summary details").open'));
  await run('document.querySelector(".task-route-summary details details summary").click()');
  assert.ok(await run('document.querySelector(".task-route-summary").textContent.includes("跨段字符丢失")'));
  assert.ok(!await run('document.querySelector(".task-route-summary").textContent.includes("路线已采用")'));
  for(const theme of ['light','dark']){nativeTheme.themeSource=theme;await sleep(150);win.setContentSize(1100,800);await fs.writeFile(${JSON.stringify(temp)}+'/routes-'+theme+'.png',(await win.webContents.capturePage()).toPNG());}
  win.setContentSize(960,700);await sleep(150);assert.ok(await run('document.documentElement.scrollWidth<=innerWidth'));
  win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
  await run('document.querySelector(".task-route-summary summary").focus()');
  assert.ok(await run('document.activeElement.tagName==="SUMMARY"'));
  await run('window.routeKeyLog=[];for(const t of ["keydown","keypress","keyup","click"])document.addEventListener(t,e=>window.routeKeyLog.push({type:t,key:e.key,target:e.target.tagName,prevented:e.defaultPrevented}),true)');
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\\r'});await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await sleep(100);
  assert.ok(!await run('document.querySelector(".task-route-summary details").open'),JSON.stringify(await run('({events:window.routeKeyLog,focused:document.hasFocus(),active:document.activeElement.tagName})')));
  await fs.writeFile(${JSON.stringify(join(temp, "result.json"))},JSON.stringify({passed:true,themes:2,keyboardToggle:'Chromium input with focus emulation',narrowWidth:960,source:'isolated Product Store',modelSelection:'not tested'}));app.quit();
 }catch(error){await fs.writeFile(${JSON.stringify(join(temp, "failure.png"))},(await win.webContents.capturePage()).toPNG());await fs.writeFile(${JSON.stringify(join(temp, "result.json"))},JSON.stringify({passed:false,error:String(error),stack:error.stack}));app.quit();}
}));
import(${JSON.stringify(pathToFileURL(join(client, "dist/src/main/index.js")).href)});
`);
const env = { ...process.env, DCODE_DATA_ROOT: join(temp, ".dcode"), DCODE_AGENT_DIR: join(temp, "agent"), DCODE_USER_DATA: join(temp, "profile"), PI_OFFLINE: "1" };
for (const key of ["ELECTRON_RUN_AS_NODE", "DCODE_THEME", "DCODE_CAPTURE", "DCODE_RENDERER_URL", "DCODE_HOST_ENTRY"]) delete env[key];
const { stdout, stderr } = await promisify(execFile)(electron, [runner], { cwd: client, env, timeout: 45000, maxBuffer: 2000000 });
const result = JSON.parse(await readFile(join(temp, "result.json"), "utf8"));
console.log(JSON.stringify({ temp, ...result })); assert.equal(result.passed, true, stderr + stdout);
