import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {fileURLToPath} from "node:url";
import {JSDOM} from "jsdom";
import {createServer} from "vite";
import {PiHost} from "../../host/dist/src/pi-host.js";
import {validateMethodParams} from "../../host/dist/src/protocol.js";
const dom=new JSDOM("<!doctype html><html><body></body></html>",{url:"http://localhost/",pretendToBeVisual:true});
for(const key of ["window","document","HTMLElement","HTMLInputElement","HTMLTextAreaElement","Node","Element","MutationObserver","Event","KeyboardEvent","MouseEvent","CustomEvent","getComputedStyle","File","FileReader"])
  Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
Object.defineProperty(globalThis,"navigator",{value:dom.window.navigator,configurable:true});
window.PointerEvent=window.MouseEvent;globalThis.PointerEvent=window.MouseEvent;
globalThis.requestAnimationFrame=callback=>setTimeout(()=>callback(Date.now()),1);globalThis.cancelAnimationFrame=clearTimeout;
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
globalThis.ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};
window.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}});
HTMLElement.prototype.scrollTo=function({top}){this.scrollTop=top;};
HTMLElement.prototype.scrollIntoView=()=>{};
HTMLElement.prototype.hasPointerCapture=()=>false;HTMLElement.prototype.setPointerCapture=()=>{};HTMLElement.prototype.releasePointerCapture=()=>{};
const React=await import("react");
const {render,screen,fireEvent,waitFor,cleanup,act}=await import("@testing-library/react");
const {SWRConfig}=await import("swr");
const server=await createServer({configFile:fileURLToPath(new URL("../vite.config.ts",import.meta.url)),server:{middlewareMode:true},appType:"custom"});
const {App}=await server.ssrLoadModule("/src/App.tsx");
const {imageNearCanvas}=await server.ssrLoadModule("/src/workbench/useInspiration.ts");await server.close();

test("zoomed images remain loaded while their card overlaps any canvas edge",()=>{
  const camera={x:0,y:0,zoom:2},bounds={width:700,height:600};
  assert.equal(imageNearCanvas({x:-175,y:10},camera,bounds),true);
  assert.equal(imageNearCanvas({x:10,y:-175},camera,bounds),true);
  assert.equal(imageNearCanvas({x:360,y:10},camera,bounds),true);
  assert.equal(imageNearCanvas({x:2000,y:10},camera,bounds),false);
  assert.equal(imageNearCanvas({x:-500,y:10},camera,bounds),false);
});

test("real Host inspiration: create, preserve same-node edits, move, reference, archive, restore and recover editor draft",{timeout:30000},async()=>{
  const root=await mkdtemp(join(tmpdir(),"dcode-inspiration-ui-")),home=join(root,"home"),agent=join(home,"agent"),dataRoot=join(home,".dcode");await mkdir(join(agent,"sessions"),{recursive:true});await writeFile(join(agent,"settings.json"),"{}\n");await writeFile(join(agent,"auth.json"),"{}\n");
  const offline=process.env.PI_OFFLINE;process.env.PI_OFFLINE="1";
  const listeners=new Set(),options={agentDir:agent,sessionsDirectory:join(agent,"sessions"),dataRoot,userHome:home,emit:(event,data)=>{for(const handler of listeners)handler({version:1,type:"event",event,data});}};
  let host=new PiHost(options);await host.start();let quitCount=0,quitError;
  window.dcode={
    request:async(method,params={})=>{validateMethodParams(method,params);return host.handle(method,params);},
    subscribe:handler=>{listeners.add(handler);return()=>listeners.delete(handler);},
    signalReady:async()=>{},signalRestoreFailed:async()=>{},notify:async()=>{},readyToQuit(error){quitCount++;quitError=error;},
    getPathForFile:file=>join(home,file.name),previewInspiration:async()=>{},previewAttachment:async()=>{},
    chooseDirectory:async()=>null,openExternal:async()=>{},restartHost:async()=>true,
  };
  const mount=()=>render(React.createElement(SWRConfig,{value:{provider:()=>new Map(),dedupingInterval:0}},React.createElement(App)));
  try {
    mount();await waitFor(()=>assert.ok(screen.getByRole("button",{name:"灵感",exact:true})));
    fireEvent.click(screen.getByRole("button",{name:"灵感",exact:true}));
    await waitFor(()=>assert.ok(screen.getByRole("button",{name:"新建文字灵感"})));
    fireEvent.click(screen.getByRole("button",{name:"新建文字灵感"}));
    await waitFor(()=>assert.ok(screen.getByRole("textbox",{name:"灵感标题"})));
    fireEvent.change(screen.getByRole("textbox",{name:"灵感标题"}),{target:{value:"可复用的判断"}});
    fireEvent.change(screen.getByRole("textbox",{name:"灵感内容"}),{target:{value:"保存真实知识内容"}});
    fireEvent.click(screen.getByRole("button",{name:"保存灵感",exact:true}));
    await waitFor(()=>assert.ok(screen.getByRole("button",{name:"灵感 可复用的判断"})));
    await waitFor(()=>assert.equal(screen.queryByRole("textbox",{name:"灵感内容"})===null,true));
    const node=screen.getByRole("button",{name:"灵感 可复用的判断"});
    fireEvent.click(screen.getByRole("button",{name:"将选中灵感成组"}));
    assert.match(screen.getByRole("status",{name:"画布操作提示"}).textContent,/至少.*2.*新建/);
    fireEvent.click(screen.getByRole("button",{name:"连线 L"}));
    assert.match(screen.getByRole("status",{name:"画布操作提示"}).textContent,/至少.*2.*新建/);
    fireEvent.click(node,{detail:0});assert.equal((await host.handle("inspiration.get",{})).edges.length,0);
    fireEvent.click(screen.getByRole("button",{name:"选择 V"}));
    fireEvent.keyDown(screen.getByRole("button",{name:"新建灵感",exact:true}),{key:" ",code:"Space"});
    await waitFor(()=>assert.ok(screen.getByRole("menuitem",{name:"文字"})));
    fireEvent.click(screen.getByRole("menuitem",{name:"文字"}));
    await waitFor(()=>assert.ok(screen.getByRole("textbox",{name:"灵感标题"})));
    fireEvent.change(screen.getByRole("textbox",{name:"灵感标题"}),{target:{value:"第二条内容"}});
    fireEvent.click(screen.getByRole("button",{name:"保存灵感",exact:true}));
    await waitFor(()=>assert.equal(screen.queryByRole("textbox",{name:"灵感内容"})===null,true));
    const two=await host.handle("inspiration.get",{}),a=two.positions[two.nodes[0].id],b=two.positions[two.nodes[1].id];
    assert.ok(Math.abs(a.x-b.x)>=260||Math.abs(a.y-b.y)>=210,"New cards must not hide existing content");
    const canvasTools=screen.getByLabelText("灵感画布");canvasTools.getBoundingClientRect=()=>({left:0,top:0,width:1000,height:650});
    const secondNode=screen.getByRole("button",{name:"灵感 第二条内容"});
    const hint=()=>screen.getByRole("status",{name:"画布操作提示"}).textContent;
    fireEvent.click(screen.getByRole("button",{name:"平移 H"}));
    assert.match(hint(),/拖动.*画布|画布.*拖动/);
    fireEvent.doubleClick(node);assert.equal(screen.queryByRole("textbox",{name:"灵感内容"})===null,true,"Panning must not open the editor");
    fireEvent.pointerDown(node,{button:0,clientX:180,clientY:120,pointerId:1});
    fireEvent.pointerMove(canvasTools,{clientX:230,clientY:150,pointerId:1});fireEvent.pointerUp(canvasTools,{pointerId:1});
    await waitFor(async()=>assert.equal((await host.handle("inspiration.get",{})).viewport.x,50));
    assert.equal(secondNode.getAttribute("aria-pressed"),"true","Panning over a node must preserve selection");
    assert.equal(node.getAttribute("aria-pressed"),"false");
    fireEvent.pointerDown(canvasTools,{button:0,clientX:950,clientY:600,pointerId:1});
    fireEvent.pointerMove(canvasTools,{clientX:900,clientY:570,pointerId:1});fireEvent.pointerUp(canvasTools,{pointerId:1});
    await waitFor(async()=>assert.equal((await host.handle("inspiration.get",{})).viewport.x,0));
    fireEvent.click(screen.getByRole("button",{name:"框选 B"}));
    assert.match(hint(),/拖出选框/);
    fireEvent.keyDown(canvasTools,{key:" ",code:"Space"});assert.match(hint(),/临时平移/);
    fireEvent.blur(window);assert.equal(screen.getByRole("button",{name:"框选 B"}).getAttribute("aria-pressed"),"true");assert.match(hint(),/拖出选框/);
    fireEvent.pointerDown(node,{button:0,clientX:170,clientY:110,pointerId:1});
    fireEvent.pointerMove(canvasTools,{clientX:900,clientY:320,pointerId:1});fireEvent.pointerUp(canvasTools,{pointerId:1});
    assert.equal(node.getAttribute("aria-pressed"),"true");assert.equal(secondNode.getAttribute("aria-pressed"),"true");
    assert.deepEqual((await host.handle("inspiration.get",{})).positions,two.positions,"Box-select from a node must not move it");
    fireEvent.click(screen.getByRole("button",{name:"将选中灵感成组"}));
    await waitFor(async()=>assert.equal((await host.handle("inspiration.get",{})).groups.length,1));
    await waitFor(()=>assert.match(hint(),/已.*成组/));
    fireEvent.click(screen.getByRole("button",{name:"连线 L"}));assert.match(hint(),/起点/);
    fireEvent.click(node,{detail:0});assert.match(hint(),/终点|另一条/);
    fireEvent.pointerMove(canvasTools,{clientX:450,clientY:180,pointerId:1});
    assert.ok(canvasTools.querySelector('[data-connection-preview="true"]'));
    fireEvent.click(secondNode,{detail:0});
    await waitFor(async()=>assert.equal((await host.handle("inspiration.get",{})).edges.length,1));
    await waitFor(()=>assert.match(hint(),/已连接/));
    const edge=(await host.handle("inspiration.get",{})).edges[0];
    await act(async()=>{await window.dcode.request("inspiration.mutate",{requestId:crypto.randomUUID(),expectedStoreRevision:(await host.handle("foundation.snapshot",{})).storeRevision,operation:{kind:"connect",from:edge.to,to:edge.from}});});
    await waitFor(()=>assert.equal(canvasTools.querySelectorAll('.idea-edges path:not([data-connection-preview])').length,2));
    fireEvent.click(secondNode,{detail:0});fireEvent.click(node,{detail:0});
    await waitFor(async()=>assert.equal((await host.handle("inspiration.get",{})).edges.length,0,"Cancel must remove legacy connections in both directions"));
    await waitFor(()=>assert.match(hint(),/已取消/));
    fireEvent.keyDown(canvasTools,{key:"Escape"});
    assert.equal(screen.getByRole("button",{name:"选择 V"}).getAttribute("aria-pressed"),"true");
    fireEvent.click(screen.getByRole("button",{name:"将选中灵感成组"}));assert.match(hint(),/至少.*2/);
    fireEvent.click(screen.getByRole("button",{name:"选择 V"}));
    fireEvent.click(node,{detail:0});assert.equal(node.getAttribute("aria-pressed"),"true","Assistive activation must select the node");
    fireEvent.doubleClick(node);
    await waitFor(()=>assert.equal(screen.getByRole("textbox",{name:"灵感内容"}).value,"保存真实知识内容"));
    fireEvent.change(screen.getByRole("textbox",{name:"灵感内容"}),{target:{value:"尚未保存的新编辑"}});
    fireEvent.doubleClick(node);
    assert.equal(screen.getByRole("textbox",{name:"灵感内容"}).value,"尚未保存的新编辑","Repeated edit entry must not replace the draft");
    fireEvent.click(screen.getByRole("button",{name:"保存灵感",exact:true}));
    await waitFor(()=>assert.equal(screen.queryByRole("textbox",{name:"灵感内容"})===null,true));
    let view=await host.handle("inspiration.get",{}),saved=view.nodes[0];assert.equal(saved.revision,2);
    const canvas=screen.getByLabelText("灵感画布");canvas.getBoundingClientRect=()=>({left:0,top:0,width:1000,height:650});
    fireEvent.pointerDown(node,{clientX:180,clientY:120,button:0,pointerId:1});
    fireEvent.pointerMove(canvas,{clientX:280,clientY:160,button:0,pointerId:1});fireEvent.pointerUp(canvas,{pointerId:1});
    await waitFor(async()=>{view=await host.handle("inspiration.get",{});assert.equal(view.positions[saved.id].x,260);});
    assert.equal(view.nodes[0].markdown,"尚未保存的新编辑");
    // A previous drag finishing must not erase an in-progress second drag.
    const requestBeforeDrag=window.dcode.request;let releaseMove,delayMove=true;
    window.dcode.request=async(method,params={})=>{
      const result=await requestBeforeDrag(method,params);
      if(delayMove&&method==="inspiration.mutate"&&params.operation?.kind==="move"){
        delayMove=false;await new Promise(resolve=>{releaseMove=resolve;});
      }
      return result;
    };
    fireEvent.pointerDown(node,{clientX:280,clientY:160,button:0,pointerId:1});
    fireEvent.pointerMove(canvas,{clientX:330,clientY:160,pointerId:1});fireEvent.pointerUp(canvas,{pointerId:1});
    await waitFor(()=>assert.equal(typeof releaseMove,"function"));
    fireEvent.pointerDown(node,{clientX:330,clientY:160,button:0,pointerId:1});
    fireEvent.pointerMove(canvas,{clientX:410,clientY:160,pointerId:1});
    await act(async()=>{releaseMove();await new Promise(resolve=>setTimeout(resolve,25));});
    fireEvent.pointerUp(canvas,{pointerId:1});
    await waitFor(async()=>assert.equal((await host.handle("inspiration.get",{})).positions[saved.id].x,390));
    window.dcode.request=requestBeforeDrag;
    const menuTrigger=screen.getByRole("button",{name:"新建灵感",exact:true});
    fireEvent.keyDown(menuTrigger,{key:" ",code:"Space"});
    await waitFor(()=>assert.ok(screen.getByRole("menuitem",{name:"文字"})));
    fireEvent.keyDown(screen.getByRole("menuitem",{name:"文字"}),{key:"Escape"});
    await waitFor(()=>assert.equal(screen.queryByRole("menuitem",{name:"文字"})===null,true));
    const pan=screen.getByRole("button",{name:"平移 H"});
    const key=new KeyboardEvent("keydown",{key:" ",code:"Space",bubbles:true,cancelable:true});
    await act(async()=>{pan.dispatchEvent(key);});assert.equal(key.defaultPrevented,false,"Canvas shortcuts must leave standard button activation intact");
    fireEvent.pointerDown(node,{button:0,clientX:280,clientY:160,pointerId:1});fireEvent.pointerUp(canvas,{pointerId:1});
    fireEvent.click(screen.getByRole("button",{name:"创建独立任务并引用"}));
    await waitFor(()=>assert.match(document.body.textContent,/已创建任务/));
    const snapshot=await host.handle("foundation.snapshot",{}),task=snapshot.tasks.find(task=>task.title==="可复用的判断");assert.ok(task);
    assert.ok(snapshot.taskContextSets.find(set=>set.taskId===task.id)?.sources.some(source=>source.relativePath.startsWith(saved.id+"/")));
    fireEvent.click(screen.getByRole("button",{name:"返回任务",exact:true}));
    await waitFor(()=>assert.match(screen.getByLabelText("任务引用的灵感").textContent,/可复用的判断/));
    fireEvent.click(screen.getByRole("button",{name:"灵感",exact:true}));
    await waitFor(()=>assert.ok(screen.getByRole("button",{name:"归档",exact:true})));
    fireEvent.click(screen.getByRole("button",{name:"归档",exact:true}));
    await waitFor(()=>assert.ok(screen.getByRole("button",{name:"已归档 1"})));
    fireEvent.click(screen.getByRole("button",{name:"已归档 1"}));
    fireEvent.pointerDown(screen.getByRole("button",{name:"灵感 可复用的判断"}),{button:0,clientX:100,clientY:100,pointerId:1});
    fireEvent.pointerUp(screen.getByLabelText("灵感画布"),{pointerId:1});
    fireEvent.click(screen.getByRole("button",{name:"恢复到画布"}));
    await waitFor(()=>assert.ok(screen.getByRole("button",{name:"已归档 0"})));
    fireEvent.click(screen.getByRole("button",{name:"编辑",exact:true}));
    fireEvent.change(screen.getByRole("textbox",{name:"灵感内容"}),{target:{value:"重启后继续编辑的草稿"}});
    await waitFor(async()=>assert.equal((await host.handle("inspiration.get",{})).draft?.markdown,"重启后继续编辑的草稿"));
    cleanup();await host.close();host=new PiHost(options);await host.start();mount();
    fireEvent.click(screen.getByRole("button",{name:"灵感",exact:true}));
    await waitFor(()=>assert.equal(screen.getByRole("textbox",{name:"灵感内容"}).value,"重启后继续编辑的草稿"));
    // Exit waits for the last accepted edit and rejects later input while storage is slow.
    const originalRequest=window.dcode.request;let releaseDraft,intercept=true;
    window.dcode.request=async(method,params={})=>{
      if(intercept&&method==="inspiration.mutate"&&params.operation?.kind==="draft"){
        intercept=false;await new Promise(resolve=>{releaseDraft=resolve;});
      }
      return originalRequest(method,params);
    };
    const editor=screen.getByRole("textbox",{name:"灵感内容"});
    fireEvent.change(editor,{target:{value:"退出前最后一次编辑"}});
    await act(async()=>{for(const listener of listeners)listener({version:1,type:"event",event:"shell.quitRequested"});});
    await waitFor(()=>assert.equal(typeof releaseDraft,"function"));
    assert.equal(editor.disabled,true);
    fireEvent.change(editor,{target:{value:"退出时不应接受的新输入"}});
    assert.equal(quitCount,0);
    await act(async()=>{releaseDraft();});
    await waitFor(()=>assert.equal(quitCount,1));assert.equal(quitError,undefined);
    assert.equal((await host.handle("inspiration.get",{})).draft.markdown,"退出前最后一次编辑");
  }finally{cleanup();await host.close();if(offline===undefined)delete process.env.PI_OFFLINE;else process.env.PI_OFFLINE=offline;await rm(root,{recursive:true,force:true});}
});
