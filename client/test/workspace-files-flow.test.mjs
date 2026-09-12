import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { JSDOM } from "jsdom";
import { PiHost } from "../../host/dist/src/pi-host.js";
import { validateMethodParams } from "../../host/dist/src/protocol.js";
import { createServer } from "vite";
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
for (const key of [
  "window",
  "document",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "Node",
  "Element",
  "MutationObserver",
  "Event",
  "KeyboardEvent",
  "MouseEvent",
  "CustomEvent",
  "getComputedStyle",
])
  Object.defineProperty(globalThis, key, {
    value: dom.window[key],
    configurable: true,
    writable: true,
  });
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
});
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 1);
globalThis.cancelAnimationFrame = clearTimeout;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.PointerEvent = window.MouseEvent;
globalThis.PointerEvent = window.MouseEvent;
window.matchMedia = () => ({
  matches: false,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
});
window.HTMLElement.prototype.scrollIntoView = function () {};
window.HTMLElement.prototype.scrollTo = function ({ top }) {
  this.scrollTop = top;
};
window.HTMLElement.prototype.hasPointerCapture = () => false;
window.HTMLElement.prototype.setPointerCapture = () => {};
window.HTMLElement.prototype.releasePointerCapture = () => {};
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
  unobserve() {}
};
const React = await import("react");
const { render, screen, fireEvent, waitFor, cleanup, act } =
  await import("@testing-library/react");
const { SWRConfig } = await import("swr");
const server = await createServer({
  configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
  server: { middlewareMode: true, hmr: false },
  appType: "custom",
});
const {useWorkspaceFiles}=await server.ssrLoadModule("/src/workbench/useWorkspaceFiles.ts");
const {WorkspaceFiles,WorkspaceFileNavigation,FileCloseDialog}=await server.ssrLoadModule("/src/components/WorkspaceFiles.tsx");
await server.close();

test('file workbench edits, conflict recovery, tabs, exact references and quit protection use the real Host',async()=>{
 const fixture=await mkdtemp(join(tmpdir(),'dcode-file-ui-')),agent=join(fixture,'agent'),home=join(fixture,'home');await mkdir(agent);await mkdir(home);await writeFile(join(home,'note.md'),'# Before\nsecond line\n');await writeFile(join(home,'other.md'),'# Other file\n');
 await writeFile(join(agent,'settings.json'),'{}');
 const host=new PiHost({agentDir:agent,sessionsDirectory:join(agent,'sessions'),dataRoot:join(fixture,'.dcode'),userHome:home,emit:()=>{}});const flushers=new Set();let model;let receivedDraft='';
 try{
  await host.start();let snapshot=await host.handle('foundation.snapshot',{});const bundle=await host.handle('task.create',{requestId:'file-ui',expectedStoreRevision:snapshot.storeRevision,scope:{kind:'user',userId:snapshot.currentUser.id},title:'File UI',goal:'Verify file operations'});snapshot=await host.handle('foundation.snapshot',{});const project=await host.handle('project.create',{requestId:'file-project',expectedStoreRevision:snapshot.storeRevision,title:'Directory edits',directory:home});snapshot=await host.handle('foundation.snapshot',{});
  window.dcode={request:async(method,params)=>{validateMethodParams(method,params);return host.handle(method,params);},subscribe:()=>()=>{}};
  const registerQuitFlush=flush=>{flushers.add(flush);return ()=>flushers.delete(flush);};
  function Harness(){const [draft,setDraft]=React.useState({text:'existing draft',images:[]}),[error,setError]=React.useState('');receivedDraft=draft.text;const work={task:bundle.task,session:bundle.coordinationSession,newProjectId:null,snapshot,draftKey:bundle.coordinationSession.id,draft,updateDraft:(_key,update)=>setDraft(previous=>typeof update==='function'?update(previous):update),fail:error=>setError(String(error)),registerQuitFlush};model=useWorkspaceFiles(work);return React.createElement(React.Fragment,null,React.createElement('button',{onClick:()=>model.show()},'Open files'),model.navigationVisible&&React.createElement(WorkspaceFileNavigation,{model}),model.visible&&React.createElement(WorkspaceFiles,{model,work,overlay:false}),React.createElement(FileCloseDialog,{model}),error&&React.createElement('p',{role:'alert'},error));}
  render(React.createElement(Harness));fireEvent.click(screen.getByRole('button',{name:'Open files'}));await waitFor(()=>assert.ok(screen.getByRole('button',{name:'note.md'})));fireEvent.click(screen.getByRole('button',{name:'note.md'}));await waitFor(()=>assert.ok(screen.getByRole('heading',{name:'Before'})));
  fireEvent.click(screen.getByRole('button',{name:'编辑'}));fireEvent.change(screen.getByRole('textbox',{name:'文件编辑内容'}),{target:{value:'# Edited\nupdated second\n'}});await writeFile(join(home,'note.md'),'external change\n');fireEvent.click(screen.getByRole('button',{name:'保存'}));await waitFor(()=>assert.ok(screen.getByRole('button',{name:'用当前编辑覆盖'})));assert.equal(await readFile(join(home,'note.md'),'utf8'),'external change\n');fireEvent.click(screen.getByRole('button',{name:'用当前编辑覆盖'}));await waitFor(()=>assert.equal(screen.getByRole('button',{name:'保存'}).disabled,true));assert.equal(await readFile(join(home,'note.md'),'utf8'),'# Edited\nupdated second\n');
  fireEvent.change(screen.getByRole('textbox',{name:'跳转到文件行'}),{target:{value:'2'}});fireEvent.keyDown(screen.getByRole('textbox',{name:'跳转到文件行'}),{key:'Enter'});fireEvent.click(screen.getByRole('button',{name:'引用当前行'}));await waitFor(()=>assert.match(receivedDraft,/note\.md:2/));assert.match(receivedDraft,/updated second/);
  fireEvent.click(screen.getByRole('button',{name:'other.md'}));await waitFor(()=>assert.ok(screen.getByRole('heading',{name:'Other file'})));assert.equal(screen.getAllByRole('tab').length,2);fireEvent.click(screen.getByRole('tab',{name:'note.md · File UI'}));fireEvent.click(screen.getByRole('button',{name:'编辑'}));fireEvent.change(screen.getByRole('textbox',{name:'文件编辑内容'}),{target:{value:'# Unsaved\n'}});
  assert.doesNotThrow(()=>model.beforeProjectDirectoryChange(project.project.id,join(fixture,'next'),false),'an unrelated User Scope buffer survives metadata-only relocation');assert.throws(()=>model.beforeProjectDirectoryChange(project.project.id,join(fixture,'next'),true),/尚未保存/,'moving actual files sees User Scope editors too');
  await act(async()=>{await assert.rejects([...flushers][0](),/未保存/);});assert.ok(screen.getByRole('dialog',{name:'文件有未保存修改'}));fireEvent.click(screen.getByRole('button',{name:'继续编辑'}));assert.equal(screen.getByRole('textbox',{name:'文件编辑内容'}).value,'# Unsaved\n');fireEvent.click(screen.getByRole('button',{name:'关闭文件 note.md · File UI'}));fireEvent.click(screen.getByRole('button',{name:'保存并关闭'}));await waitFor(()=>assert.ok(!screen.queryByRole('button',{name:'关闭文件 note.md · File UI'})));assert.equal(await readFile(join(home,'note.md'),'utf8'),'# Unsaved\n');await act(async()=>model.invalidateProject(project.project.id,join(fixture,'next'),true));assert.equal(model.allTabs.length,0);
 }finally{cleanup();await host.close();await rm(fixture,{recursive:true,force:true});}
});

test('project navigation and inspector retain source-owned buffers across tasks and late responses',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dcode-source-ui-')),a=join(root,'a'),b=join(root,'b'),agent=join(root,'agent');
 for(const path of [a,b,agent,join(b,'sub')])await mkdir(path);
 await writeFile(join(a,'note.md'),'# A\nA second\n');await writeFile(join(b,'note.md'),'# B\nB second\n');await writeFile(join(agent,'settings.json'),'{}');
 const host=new PiHost({agentDir:agent,dataRoot:join(root,'.dcode'),userHome:root,emit:()=>{}});
 let releaseRead=()=>{},releaseReference=()=>{},holdRead=false,holdReference=false,model,chooseTask,referenceStarted=false,readStarted=false,quoteCount=0;
 try{
  await host.start();const mutate=async(method,params)=>{const s=await host.handle('foundation.snapshot',{});return host.handle(method,{requestId:crypto.randomUUID(),expectedStoreRevision:s.storeRevision,...params});};
  const pa=await mutate('project.create',{title:'Project A',directory:a}),pb=await mutate('project.create',{title:'Project B',directory:b});
  const ta=await mutate('task.create',{scope:{kind:'project',projectId:pa.project.id},title:'Task A',goal:'A'}),tb=await mutate('task.create',{scope:{kind:'project',projectId:pb.project.id},title:'Task B',goal:'B'});
  const store=await host.getProductStore(),now=new Date().toISOString();
  store.database.prepare("INSERT INTO artifacts(id,task_id,session_id,kind,title,external_path,metadata_json,revision,created_at,updated_at) VALUES (?,?,?,'document','Fixture artifact',?,'{}',1,?,?)").run('fixture-artifact',ta.task.id,ta.coordinationSession.id,join(b,'note.md'),now,now);
  const snapshot=await host.handle('foundation.snapshot',{});
  window.dcode={request:async(method,params)=>{
   validateMethodParams(method,params);const result=await host.handle(method,params);
   if(method==='workspace.read'&&holdRead&&params.source.projectId===pa.project.id){holdRead=false;readStarted=true;await new Promise(resolve=>{releaseRead=resolve;});}
   if(method==='workspace.reference'&&holdReference){holdReference=false;referenceStarted=true;await new Promise(resolve=>{releaseReference=resolve;});}
   return result;
  },subscribe:()=>()=>{}};
  const registerQuitFlush=()=>()=>{};
  function Harness(){const [task,setTask]=React.useState(ta.task);chooseTask=setTask;const work={task,newProjectId:null,snapshot,draftKey:task.id,updateDraft:()=>{quoteCount++;},fail:()=>{},registerQuitFlush};model=useWorkspaceFiles(work);return React.createElement(React.Fragment,null,React.createElement('p',{'aria-label':'current task'},task.title),model.navigationVisible&&React.createElement(WorkspaceFileNavigation,{model}),model.visible&&React.createElement(WorkspaceFiles,{model,work}),React.createElement(FileCloseDialog,{model}));}
  render(React.createElement(Harness));
  holdRead=true;act(()=>model.open('note.md',{projectId:pa.project.id}));await waitFor(()=>assert.equal(readStarted,true));
  act(()=>{model.browseProject(pb.project.id);model.open('note.md',{projectId:pb.project.id});});await waitFor(()=>assert.equal(model.active.document.text,'# B\nB second\n'));
  releaseRead();await waitFor(()=>assert.equal(model.allTabs.find(t=>t.source.projectId===pa.project.id).document.text,'# A\nA second\n'));
  assert.equal(model.active.source.projectId,pb.project.id);assert.equal(screen.getByLabelText('current task').textContent,'Task A');assert.equal(quoteCount,0);
  fireEvent.click(screen.getByRole('button',{name:'编辑'}));fireEvent.change(screen.getByRole('textbox',{name:'文件编辑内容'}),{target:{value:'# Unsaved B\n'}});
  act(()=>model.returnToTasks());assert.equal(model.visible,true);assert.equal(model.active.draft,'# Unsaved B\n');assert.equal(model.navigationVisible,false);
  act(()=>chooseTask(tb.task));assert.equal(model.active.source.projectId,pb.project.id);act(()=>chooseTask(ta.task));assert.equal(model.active.draft,'# Unsaved B\n');
  act(()=>model.open('note.md',{taskId:tb.task.id}));assert.equal(model.allTabs.length,2,'Project and its task share one canonical source');
  await act(async()=>assert.equal(await model.save(model.active.id),true));assert.equal(await readFile(join(b,'note.md'),'utf8'),'# Unsaved B\n');assert.equal(await readFile(join(a,'note.md'),'utf8'),'# A\nA second\n');
  act(()=>model.conversation());assert.equal(model.visible,false);assert.equal(model.allTabs.length,2);act(()=>model.showInspector());assert.equal(model.active.document.text,'# Unsaved B\n');
  holdReference=true;let pending;act(()=>{pending=model.openReference('note.md#L2');});await waitFor(()=>assert.equal(referenceStarted,true));act(()=>model.browseProject(pb.project.id));releaseReference();await act(async()=>pending);assert.equal(model.active.source.projectId,pb.project.id,'Late A reference cannot change the newer B selection');
  await act(async()=>model.openArtifact('fixture-artifact'));await waitFor(()=>assert.equal(model.active.source.projectId,pb.project.id));assert.equal(model.allTabs.length,2,'Artifact and project entry reuse one existing buffer without rebinding its source');
  fireEvent.click(screen.getByRole('button',{name:'预览文件'}));assert.equal(model.active.mode,'preview');
  await act(async()=>model.openReference(join(b,'note.md')+'#L1'));
  await waitFor(()=>{const editor=screen.getByRole('textbox',{name:'文件原文'});assert.equal(model.active.source.projectId,pb.project.id);assert.equal(editor.value.slice(editor.selectionStart,editor.selectionEnd),'# Unsaved B');});
  assert.equal(model.allTabs.length,2);
  fireEvent.click(screen.getByRole('button',{name:'编辑'}));fireEvent.change(screen.getByRole('textbox',{name:'文件编辑内容'}),{target:{value:'# Kept draft\nsecond retained\n'}});
  await act(async()=>model.openReference(join(b,'note.md')+'#L2'));
  await waitFor(()=>{const editor=screen.getByRole('textbox',{name:'文件编辑内容'});assert.equal(model.active.mode,'edit');assert.equal(editor.value,'# Kept draft\nsecond retained\n');assert.equal(editor.value.slice(editor.selectionStart,editor.selectionEnd),'second retained');});
  assert.equal(model.active.source.projectId,pb.project.id);assert.equal(model.allTabs.length,2);
  await act(async()=>model.openRelative(model.active,join(b,'note.md')));assert.equal(model.active.source.projectId,pb.project.id);assert.equal(quoteCount,0);
  await act(async()=>model.openReference('sub/',{projectId:pb.project.id}));assert.equal(model.navigationPath,'sub');assert.equal(model.active.source.projectId,pb.project.id);
  const originalA=model.allTabs.find(t=>t.source.projectId===pa.project.id);holdRead=true;readStarted=false;let oldRead;act(()=>{oldRead=model.reload(originalA);});await waitFor(()=>assert.equal(readStarted,true));
  await writeFile(join(a,'note.md'),'# New A\n');await act(async()=>model.reload(originalA));releaseRead();await act(async()=>oldRead);assert.equal(model.allTabs.find(t=>t.id===originalA.id).document.text,'# New A\n','Old reload cannot replace a newer document version');
 }finally{releaseRead();releaseReference();cleanup();await host.close();await rm(root,{recursive:true,force:true});}
});
