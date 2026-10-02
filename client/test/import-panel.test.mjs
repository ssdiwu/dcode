import test from "node:test";
import assert from "node:assert/strict";
import {JSDOM} from "jsdom";
import {createServer} from "vite";
import {fileURLToPath} from "node:url";

const dom=new JSDOM("<!doctype html><html><body></body></html>",{url:"http://localhost/",pretendToBeVisual:true});
for(const key of ["window","document","HTMLElement","Node","Element","MutationObserver","Event","MouseEvent","getComputedStyle"])
  Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
Object.defineProperty(globalThis,"navigator",{value:dom.window.navigator,configurable:true});
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const React=await import("react");
const {render,screen,fireEvent,waitFor,cleanup}=await import("@testing-library/react");
const server=await createServer({configFile:fileURLToPath(new URL("../vite.config.ts",import.meta.url)),server:{middlewareMode:true},appType:"custom"});
const {ImportPanel}=await server.ssrLoadModule("/src/components/ImportPanel.tsx");
await server.close();

test("an imported Task can be reopened after presentation refresh fails without importing twice",async()=>{
  const candidate={sourceSessionId:"pi-one",title:"已有会话",firstMessage:"原始内容",messageCount:1,previouslyImported:false};
  const bundle={task:{id:"task-imported"},coordinationSession:{id:"session-imported"}};
  let imports=0,opens=0,closes=0;
  const busy=[];
  window.dcode={request:async(method)=>{
    if(method==="piImport.listCandidates")return {candidates:[candidate]};
    if(method==="piImport.preview")return {sourceSessionId:candidate.sourceSessionId};
    throw new Error(`Unexpected request ${method}`);
  }};
  render(React.createElement(ImportPanel,{
    onClose:()=>{closes++;},onBusyChange:value=>busy.push(value),userId:"user",
    mutateStore:async()=>{imports++;return bundle;},
    onImported:async()=>{opens++;if(opens===1)throw new Error("Refresh failed after import");},
  }));
  try {
    await waitFor(()=>assert.ok(screen.getByRole("button",{name:"导入",exact:true})));
    fireEvent.click(screen.getByRole("button",{name:"导入",exact:true}));
    await waitFor(()=>assert.match(screen.getByRole("alert").textContent,/已导入.*未能打开/));
    assert.equal(imports,1);
    assert.equal(closes,0);
    fireEvent.click(screen.getByRole("button",{name:"打开已导入任务"}));
    await waitFor(()=>assert.equal(closes,1));
    assert.equal(imports,1,"retrying the view must not repeat the import mutation");
    assert.equal(opens,2);
    assert.deepEqual(busy,[true,false,true,false]);
  } finally {cleanup();}
});

test("a failed pre-import check leaves the candidate available for an explicit retry",async()=>{
  const candidate={sourceSessionId:"pi-retry",title:"待核对会话",firstMessage:"",messageCount:1,previouslyImported:false};
  let previews=0,imports=0,closed=0;
  window.dcode={request:async(method)=>{
    if(method==="piImport.listCandidates")return {candidates:[candidate]};
    if(method==="piImport.preview"){
      previews++;
      if(previews===1)throw new Error("Source temporarily unavailable");
      return {sourceSessionId:candidate.sourceSessionId};
    }
    throw new Error(`Unexpected request ${method}`);
  }};
  render(React.createElement(ImportPanel,{
    onClose:()=>{closed++;},onBusyChange:()=>{},userId:"user",
    mutateStore:async()=>{imports++;return {task:{id:"task-retry"},coordinationSession:{id:"session-retry"}};},
    onImported:async()=>{},
  }));
  try {
    await waitFor(()=>assert.ok(screen.getByRole("button",{name:"导入",exact:true})));
    fireEvent.click(screen.getByRole("button",{name:"导入",exact:true}));
    await waitFor(()=>assert.match(screen.getByRole("alert").textContent,/Source temporarily unavailable/));
    assert.equal(imports,0);
    fireEvent.click(screen.getByRole("button",{name:"导入",exact:true}));
    await waitFor(()=>assert.equal(closed,1));
    assert.equal(previews,2);
    assert.equal(imports,1);
  } finally {cleanup();}
});
