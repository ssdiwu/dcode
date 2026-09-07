import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

const dom = new JSDOM("<!doctype html><html><body></body></html>",{url:"http://localhost",pretendToBeVisual:true});
for(const key of ["window","document","HTMLElement","Element","Node","MutationObserver","Event","MouseEvent","getComputedStyle"])
  Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
Object.defineProperty(globalThis,"navigator",{value:dom.window.navigator,configurable:true});
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const React=await import("react");
const {render,screen,fireEvent,cleanup,act,waitFor}=await import("@testing-library/react");
const server=await createServer({configFile:fileURLToPath(new URL("../vite.config.ts",import.meta.url)),server:{middlewareMode:true,hmr:false},appType:"custom"});
const {CopyButton}=await server.ssrLoadModule("/src/components/CopyButton.tsx");
const {LoadingPlaceholder}=await server.ssrLoadModule("/src/components/LoadingPlaceholder.tsx");
const {useCommands}=await server.ssrLoadModule("/src/workbench/useCommands.ts");
const {SWRConfig}=await import("swr");
await server.close();
test("copy feedback waits for actual clipboard success and preserves submitted text",async()=>{
  let complete,received;
  Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:text=>{received=text;return new Promise(resolve=>{complete=resolve;});}}});
  try{
    render(React.createElement(CopyButton,{text:"原始内容\n第二行",onError:()=>assert.fail("Unexpected copy error")}));
    fireEvent.click(screen.getByRole("button",{name:"复制消息"}));
    assert.equal(received,"原始内容\n第二行");
    assert.equal(screen.getByRole("button",{name:"正在复制"}).disabled,true);
    assert.equal(screen.queryByRole("button",{name:"已复制"}),null);
    await act(async()=>complete());
    assert.ok(screen.getByRole("button",{name:"已复制"}));
  }finally{cleanup();}
});
test("copy failure remains actionable and a later retry can succeed",async()=>{
  let fail=true;const failures=[];
  Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async()=>{if(fail)throw new Error("Clipboard unavailable");}}});
  try{
    render(React.createElement(CopyButton,{text:"待复制",onError:error=>failures.push(error.message)}));
    fireEvent.click(screen.getByRole("button",{name:"复制消息"}));
    await waitFor(()=>assert.ok(screen.getByRole("button",{name:"复制失败，点击重试"})));
    assert.deepEqual(failures,["Clipboard unavailable"]);
    fail=false;fireEvent.click(screen.getByRole("button",{name:"复制失败，点击重试"}));
    await waitFor(()=>assert.ok(screen.getByRole("button",{name:"已复制"})));
  }finally{cleanup();}
});
test("a short read never flashes loading shapes, while a pending read can show them",async()=>{
  try{
    const view=render(React.createElement(LoadingPlaceholder,{label:"正在读取消息…"}));
    assert.equal(document.querySelector(".loading-shapes"),null);
    view.unmount();
    await act(async()=>new Promise(resolve=>setTimeout(resolve,190)));
    assert.equal(document.querySelector(".loading-shapes"),null);
    render(React.createElement(LoadingPlaceholder,{label:"正在读取消息…"}));
    await waitFor(()=>assert.ok(document.querySelector(".loading-shapes")));
    assert.equal(screen.getByRole("status").getAttribute("aria-busy"),"true");
  }finally{cleanup();}
});

test("commands distinguish an in-flight read from an empty completed result",async()=>{
  let complete;
  window.dcode={request:method=>{assert.equal(method,"dcodeSession.commands");return new Promise(resolve=>{complete=resolve;});}};
  const work={session:null,newProjectId:null,preferences:null};
  function Probe(){const {commands,loading}=useCommands(work,true);return React.createElement("output",{"data-loading":String(loading)},String(commands.length));}
  try{
    render(React.createElement(SWRConfig,{value:{provider:()=>new Map(),dedupingInterval:0}},React.createElement(Probe)));
    await waitFor(()=>assert.equal(document.querySelector("output").dataset.loading,"true"));
    await act(async()=>complete({commands:[]}));
    await waitFor(()=>assert.equal(document.querySelector("output").dataset.loading,"false"));
    assert.equal(document.querySelector("output").textContent,"0");
  }finally{cleanup();}
});
