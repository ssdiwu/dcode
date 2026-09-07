import test from "node:test";
import assert from "node:assert/strict";
import {JSDOM} from "jsdom";
import {createServer} from "vite";
import {fileURLToPath} from "node:url";

const dom=new JSDOM("<!doctype html><html><body></body></html>",{url:"http://localhost/",pretendToBeVisual:true});
for(const key of ["window","document","HTMLElement","Node","Element","MutationObserver","Event","KeyboardEvent","MouseEvent","getComputedStyle"])
  Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
Object.defineProperty(globalThis,"navigator",{value:dom.window.navigator,configurable:true});
window.PointerEvent=window.MouseEvent;globalThis.PointerEvent=window.MouseEvent;
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
globalThis.requestAnimationFrame=callback=>setTimeout(callback,1);
globalThis.cancelAnimationFrame=clearTimeout;
globalThis.ResizeObserver=class {observe(){}disconnect(){}};
const React=await import("react");
const {render,screen,fireEvent,waitFor,cleanup}=await import("@testing-library/react");
const server=await createServer({configFile:fileURLToPath(new URL("../vite.config.ts",import.meta.url)),server:{middlewareMode:true},appType:"custom"});
const {ConversationRail}=await server.ssrLoadModule("/src/components/conversation/ConversationRail.tsx");
const {Transcript}=await server.ssrLoadModule("/src/components/conversation/Transcript.tsx");
const {useConversationNavigation}=await server.ssrLoadModule("/src/workbench/useConversationNavigation.ts");
await server.close();
const turns=[1,2,3].map(index=>({id:`u${index}`,question:`问题 ${index}`,answer:`回答 ${index}`}));

test("rail previews and jumps with pointer and keyboard, including first/last turns",()=>{
  const chosen=[];
  const view=render(React.createElement(ConversationRail,{turns,activeId:"u2",onNavigate:id=>chosen.push(id)}));
  const button=screen.getByRole("button",{name:/对话导航/});
  button.getBoundingClientRect=()=>({top:0,height:100,left:0,width:32,right:32,bottom:100});
  fireEvent.focus(button);
  fireEvent.keyDown(button,{key:"Home"});
  assert.match(screen.getByRole("tooltip").textContent,/问题 1/);
  fireEvent.keyDown(button,{key:"Enter"});
  fireEvent.keyDown(button,{key:"End"});
  fireEvent.keyDown(button,{key:" "});
  fireEvent.pointerMove(button,{clientY:14});
  assert.match(screen.getByRole("tooltip").textContent,/问题 1/);
  fireEvent.click(button,{detail:1,clientY:14});
  assert.deepEqual(chosen,["u1","u3","u1"]);
  fireEvent.pointerLeave(button);
  assert.match(button.getAttribute("aria-label"),/第 1 轮/);
  fireEvent.keyDown(button,{key:"ArrowDown"});fireEvent.keyDown(button,{key:"Enter"});
  assert.equal(chosen.at(-1),"u2");
  fireEvent.blur(button);fireEvent.pointerLeave(button);
  assert.equal(screen.queryByRole("tooltip"),null);
  view.rerender(React.createElement(ConversationRail,{turns:[],activeId:null,onNavigate:()=>{}}));
  assert.equal(screen.queryByRole("navigation"),null);
  cleanup();
});

test("reading navigation scrolls to the user anchor and follows later manual scrolling",async()=>{
  const originalRect=HTMLElement.prototype.getBoundingClientRect;
  const originalScrollTo=HTMLElement.prototype.scrollTo;
  HTMLElement.prototype.getBoundingClientRect=function(){
    if(this.dataset.viewport!==undefined)return {top:0,height:400};
    if(this.dataset.conversationTurn){const index=Number(this.dataset.conversationTurn.slice(1))-1;return {top:24+index*600-(document.querySelector('[data-viewport]')?.scrollTop??0),height:100};}
    return originalRect.call(this);
  };
  HTMLElement.prototype.scrollTo=function({top}){this.scrollTop=top;this.dispatchEvent(new Event("scroll"));};
  function Harness(){
    const viewport=React.useRef(null),content=React.useRef(null);
    const navigation=useConversationNavigation(turns,viewport,content);
    return React.createElement(React.Fragment,null,
      React.createElement("div",{ref:element=>{viewport.current=element;if(element){Object.defineProperty(element,"scrollHeight",{value:1600,configurable:true});Object.defineProperty(element,"clientHeight",{value:400,configurable:true});}},"data-viewport":""},
        React.createElement("div",{ref:content},turns.map(turn=>React.createElement("article",{key:turn.id,"data-conversation-turn":turn.id},turn.question)))),
      React.createElement(ConversationRail,{turns,activeId:navigation.activeId,onNavigate:navigation.navigate}),
      React.createElement("output",{"data-testid":"active"},navigation.activeId));
  }
  try {
    render(React.createElement(Harness));
    const button=screen.getByRole("button",{name:/对话导航/});
    fireEvent.focus(button);fireEvent.keyDown(button,{key:"End"});fireEvent.keyDown(button,{key:"Enter"});
    const viewport=document.querySelector('[data-viewport]');
    assert.equal(viewport.scrollTop,1200);
    await waitFor(()=>assert.equal(screen.getByTestId("active").textContent,"u3"));
    fireEvent.wheel(viewport);viewport.scrollTop=620;fireEvent.scroll(viewport);
    await waitFor(()=>assert.equal(screen.getByTestId("active").textContent,"u2"));
    fireEvent.keyDown(button,{key:"Home"});fireEvent.keyDown(button,{key:"Enter"});
    assert.equal(viewport.scrollTop,0);
    await waitFor(()=>assert.equal(screen.getByTestId("active").textContent,"u1"));
  } finally {cleanup();HTMLElement.prototype.getBoundingClientRect=originalRect;HTMLElement.prototype.scrollTo=originalScrollTo;}
});


test("explicit turn navigation stays paused during streaming even when its target clamps to the bottom",async()=>{
  let height=420;
  const proto=HTMLElement.prototype;
  const originalRect=proto.getBoundingClientRect, originalScrollTo=proto.scrollTo;
  const properties=["scrollHeight","clientHeight","scrollTop"].map(key=>[key,Object.getOwnPropertyDescriptor(proto,key)]);
  const offsets=new WeakMap();
  Object.defineProperty(proto,"scrollHeight",{configurable:true,get(){return this.classList.contains("transcript")?height:0;}});
  Object.defineProperty(proto,"clientHeight",{configurable:true,get(){return this.classList.contains("transcript")?400:0;}});
  Object.defineProperty(proto,"scrollTop",{configurable:true,get(){return offsets.get(this)??0;},set(value){offsets.set(this,Math.max(0,Math.min(value,height-400)));}});
  proto.getBoundingClientRect=function(){
    if(this.classList.contains("transcript"))return {top:0,height:400};
    if(this.dataset.conversationTurn)return {top:24+(Number(this.dataset.conversationTurn.slice(1))-1)*200-(document.querySelector('.transcript')?.scrollTop??0),height:100};
    return originalRect.call(this);
  };
  proto.scrollTo=function({top}){this.scrollTop=top;this.dispatchEvent(new Event("scroll"));};
  const entries=[{id:"u1",type:"message",message:{role:"user",content:"第一个问题"}},{id:"a1",type:"message",message:{role:"assistant",content:"第一段回复"}},{id:"u2",type:"message",message:{role:"user",content:"第二个问题"}}];
  const base={imported:[],session:{id:"test"},preferences:{},presentation:{adapterState:"ready",inspection:{entries}},readingPosition:()=>0,saveReading:()=>{},draft:{text:"",images:[]},draftKey:"test",updateDraft:()=>{},fail:()=>{},running:true};
  const work=text=>({...base,stream:{messages:[{id:"live",text,thinking:"",ended:false}]}});
  try {
    const view=render(React.createElement(Transcript,{work:work("正在回复"),emptyBrand:null}));
    const rail=screen.getByRole("button",{name:/对话导航/});
    fireEvent.focus(rail);fireEvent.keyDown(rail,{key:"End"});fireEvent.keyDown(rail,{key:"Enter"});
    const viewport=document.querySelector('.transcript');
    assert.equal(viewport.scrollTop,20);
    height=600;
    view.rerender(React.createElement(Transcript,{work:work("新的流式内容正在追加"),emptyBrand:null}));
    assert.equal(viewport.scrollTop,20,"New output must not reclaim explicit navigation");
    fireEvent.click(screen.getByRole("button",{name:"回到最新消息"}));
    assert.equal(viewport.scrollTop,200);
    assert.equal(screen.queryByRole("button",{name:"回到最新消息"}),null);
    height=800;
    view.rerender(React.createElement(Transcript,{work:work("用户恢复跟随后，后续输出应继续自动跟随"),emptyBrand:null}));
    assert.equal(viewport.scrollTop,400);
  } finally {
    cleanup();proto.getBoundingClientRect=originalRect;proto.scrollTo=originalScrollTo;
    for(const [key,descriptor] of properties){if(descriptor)Object.defineProperty(proto,key,descriptor);else delete proto[key];}
  }
});

test("stream feedback belongs only to the unfinished live reply and never remounts history",()=>{
  const entries=[{id:"u1",type:"message",message:{role:"user",content:"历史问题"}},{id:"a1",type:"message",message:{role:"assistant",content:"历史回答"}},{id:"u2",type:"message",message:{role:"user",content:"当前问题"}}];
  const base={imported:[],session:{id:"stream-test"},preferences:{},presentation:{adapterState:"ready",inspection:{entries}},readingPosition:()=>0,saveReading:()=>{},draft:{text:"",images:[]},draftKey:"stream-test",updateDraft:()=>{},fail:()=>{}};
  const work=(text,running=true)=>({...base,running,stream:{messages:[{id:"live-reply",text,thinking:"",ended:!running}]}});
  try{
    const view=render(React.createElement(Transcript,{work:work("第一段"),emptyBrand:null}));
    const history=document.querySelector('.message.assistant');
    const live=document.querySelector('.message[data-live="true"]');
    assert.notEqual(history,live);assert.equal(history.dataset.live,undefined);
    assert.equal(document.querySelectorAll('.reply-writing').length,1);
    view.rerender(React.createElement(Transcript,{work:work("第一段，继续追加"),emptyBrand:null}));
    assert.equal(document.querySelector('.message.assistant'),history);
    assert.equal(document.querySelector('.message[data-live="true"]'),live);
    view.rerender(React.createElement(Transcript,{work:work("第一段，继续追加",false),emptyBrand:null}));
    assert.equal(document.querySelector('.reply-writing')===null,true);
    assert.equal(document.querySelector('.message[data-live="true"]')===null,true);
    assert.equal(document.querySelector('.message.assistant'),history);
  }finally{cleanup();}
});


test("a Host exit after partial output renders interruption instead of a completion check",()=>{
  const entries=[{id:"u",type:"message",message:{role:"user",content:"执行当前任务"}},{id:"a",type:"message",message:{role:"assistant",timestamp:12,content:"部分内容"}}];
  const base={imported:[],session:{id:"host-exit"},preferences:{},presentation:{adapterState:"ready",inspection:{entries}},readingPosition:()=>0,saveReading:()=>{},draft:{text:"",images:[]},draftKey:"host-exit",updateDraft:()=>{},fail:()=>{},run:{status:"running"}};
  try{
    const view=render(React.createElement(Transcript,{work:{...base,running:true,hostDead:false,stream:{messages:[{id:"12",text:"部分内容",thinking:"",ended:false}]}},emptyBrand:null}));
    view.rerender(React.createElement(Transcript,{work:{...base,running:false,hostDead:true,stream:{messages:[]}},emptyBrand:null}));
    assert.ok(screen.getByText("执行已中断"));
    assert.equal(document.querySelector('.execution-state-icon[data-state="complete"]')===null,true);
    assert.equal(document.querySelector('[data-completing="true"]')===null,true);
    view.rerender(React.createElement(Transcript,{work:{...base,viewingHistory:true,running:true,hostDead:false,stream:{messages:[]}},emptyBrand:null}));
    assert.equal(document.querySelector('.execution-state-icon[data-state="running"]')===null,true);
    assert.equal(document.querySelector('.reply-writing')===null,true);
  }finally{cleanup();}
});
