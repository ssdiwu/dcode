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
const {WorkspaceFiles,FileCloseDialog}=await server.ssrLoadModule("/src/components/WorkspaceFiles.tsx");
await server.close();

test('file workbench edits, conflict recovery, tabs, exact references and quit protection use the real Host',async()=>{
 const fixture=await mkdtemp(join(tmpdir(),'dcode-file-ui-')),agent=join(fixture,'agent'),home=join(fixture,'home');await mkdir(agent);await mkdir(home);await writeFile(join(home,'note.md'),'# Before\nsecond line\n');await writeFile(join(home,'other.md'),'# Other file\n');
 await writeFile(join(agent,'settings.json'),'{}');
 const host=new PiHost({agentDir:agent,sessionsDirectory:join(agent,'sessions'),dataRoot:join(fixture,'.dcode'),userHome:home,emit:()=>{}});const flushers=new Set();let model;let receivedDraft='';
 try{
  await host.start();let snapshot=await host.handle('foundation.snapshot',{});const bundle=await host.handle('task.create',{requestId:'file-ui',expectedStoreRevision:snapshot.storeRevision,scope:{kind:'user',userId:snapshot.currentUser.id},title:'File UI',goal:'Verify file operations'});snapshot=await host.handle('foundation.snapshot',{});const project=await host.handle('project.create',{requestId:'file-project',expectedStoreRevision:snapshot.storeRevision,title:'Directory edits',directory:home});snapshot=await host.handle('foundation.snapshot',{});
  window.dcode={request:async(method,params)=>{validateMethodParams(method,params);return host.handle(method,params);},subscribe:()=>()=>{}};
  const registerQuitFlush=flush=>{flushers.add(flush);return ()=>flushers.delete(flush);};
  function Harness(){const [draft,setDraft]=React.useState({text:'existing draft',images:[]}),[error,setError]=React.useState('');receivedDraft=draft.text;const work={task:bundle.task,session:bundle.coordinationSession,newProjectId:null,snapshot,draftKey:bundle.coordinationSession.id,draft,updateDraft:(_key,update)=>setDraft(previous=>typeof update==='function'?update(previous):update),fail:error=>setError(String(error)),registerQuitFlush};model=useWorkspaceFiles(work);return React.createElement(React.Fragment,null,React.createElement('button',{onClick:()=>model.show()},'Open files'),model.visible&&React.createElement(WorkspaceFiles,{model,work,overlay:false}),React.createElement(FileCloseDialog,{model}),error&&React.createElement('p',{role:'alert'},error));}
  render(React.createElement(Harness));fireEvent.click(screen.getByRole('button',{name:'Open files'}));await waitFor(()=>assert.ok(screen.getByRole('button',{name:'note.md'})));fireEvent.click(screen.getByRole('button',{name:'note.md'}));await waitFor(()=>assert.ok(screen.getByRole('heading',{name:'Before'})));
  fireEvent.click(screen.getByRole('button',{name:'编辑'}));fireEvent.change(screen.getByRole('textbox',{name:'文件编辑内容'}),{target:{value:'# Edited\nupdated second\n'}});await writeFile(join(home,'note.md'),'external change\n');fireEvent.click(screen.getByRole('button',{name:'保存'}));await waitFor(()=>assert.ok(screen.getByRole('button',{name:'用当前编辑覆盖'})));assert.equal(await readFile(join(home,'note.md'),'utf8'),'external change\n');fireEvent.click(screen.getByRole('button',{name:'用当前编辑覆盖'}));await waitFor(()=>assert.equal(screen.getByRole('button',{name:'保存'}).disabled,true));assert.equal(await readFile(join(home,'note.md'),'utf8'),'# Edited\nupdated second\n');
  fireEvent.change(screen.getByRole('textbox',{name:'跳转到文件行'}),{target:{value:'2'}});fireEvent.keyDown(screen.getByRole('textbox',{name:'跳转到文件行'}),{key:'Enter'});fireEvent.click(screen.getByRole('button',{name:'引用当前行'}));await waitFor(()=>assert.match(receivedDraft,/note\.md:2/));assert.match(receivedDraft,/updated second/);
  fireEvent.click(screen.getByRole('button',{name:'other.md'}));await waitFor(()=>assert.ok(screen.getByRole('heading',{name:'Other file'})));assert.equal(screen.getAllByRole('tab').length,3);fireEvent.click(screen.getByRole('tab',{name:'note.md'}));fireEvent.click(screen.getByRole('button',{name:'编辑'}));fireEvent.change(screen.getByRole('textbox',{name:'文件编辑内容'}),{target:{value:'# Unsaved\n'}});
  assert.doesNotThrow(()=>model.beforeProjectDirectoryChange(project.project.id,join(fixture,'next'),false),'an unrelated User Scope buffer survives metadata-only relocation');assert.throws(()=>model.beforeProjectDirectoryChange(project.project.id,join(fixture,'next'),true),/尚未保存/,'moving actual files sees User Scope editors too');
  await act(async()=>{await assert.rejects([...flushers][0](),/未保存/);});assert.ok(screen.getByRole('dialog',{name:'文件有未保存修改'}));fireEvent.click(screen.getByRole('button',{name:'继续编辑'}));assert.equal(screen.getByRole('textbox',{name:'文件编辑内容'}).value,'# Unsaved\n');fireEvent.click(screen.getByRole('button',{name:'关闭文件 note.md'}));fireEvent.click(screen.getByRole('button',{name:'保存并关闭'}));await waitFor(()=>assert.ok(!screen.queryByRole('button',{name:'关闭文件 note.md'})));assert.equal(await readFile(join(home,'note.md'),'utf8'),'# Unsaved\n');await act(async()=>model.invalidateProject(project.project.id,join(fixture,'next'),true));assert.equal(model.allTabs.length,0);
 }finally{cleanup();await host.close();await rm(fixture,{recursive:true,force:true});}
});
