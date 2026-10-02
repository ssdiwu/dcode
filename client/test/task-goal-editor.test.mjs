import test from "node:test";
import assert from "node:assert/strict";
import {JSDOM} from "jsdom";
import {createServer} from "vite";
import {fileURLToPath} from "node:url";

const dom=new JSDOM("<!doctype html><html><body></body></html>",{url:"http://localhost/",pretendToBeVisual:true});
for(const key of ["window","document","HTMLElement","HTMLTextAreaElement","Node","Element","MutationObserver","Event","KeyboardEvent","MouseEvent","getComputedStyle"])
  Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
Object.defineProperty(globalThis,"navigator",{value:dom.window.navigator,configurable:true});
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const React=await import("react");
const {render,screen,waitFor,cleanup,fireEvent,act}=await import("@testing-library/react");
const server=await createServer({configFile:fileURLToPath(new URL("../vite.config.ts",import.meta.url)),server:{middlewareMode:true},appType:"custom"});
const {TaskGoalEditor}=await server.ssrLoadModule("/src/components/TaskGoalEditor.tsx");
await server.close();

test("terminal Tasks show Goal and history without a mutation control",async()=>{
  let mutations=0;
  window.dcode={request:async()=>[{taskId:"task-a",goal:"既有目标",acceptance:["原验收"],taskRevision:1,changedAt:"2026-09-29T00:00:00.000Z"}]};
  try{
    for(const [state,label] of [["completed","已完成"],["rejected","未通过"],["archived","已归档"]]){
      const task={id:"task-a",scope:{kind:"user",userId:"u"},goal:"既有目标",acceptance:["原验收"],state,revision:2};
      const work={task,draft:{text:"",images:[]},draftKey:"session-a",snapshot:{taskPlans:[]},mutateStore:async()=>{mutations++;},reload:async()=>{},updateDraft(){},flushDrafts:async()=>{}};
      render(React.createElement(TaskGoalEditor,{work,onClose(){}}));
      assert.match(screen.getByText(new RegExp(`任务${label}`)).textContent,/可查看，当前不能修订/);
      assert.equal(screen.getByRole("textbox",{name:"短期结果"}).readOnly,true);
      assert.equal(screen.getByRole("textbox",{name:/验收目的/}).readOnly,true);
      assert.equal(screen.queryByRole("button",{name:"保存修订"}),null);
      await waitFor(()=>assert.match(screen.getByText(/查看目标版本/).textContent,/1/));
      cleanup();
    }
    assert.equal(mutations,0);
  }finally{cleanup();}
});

test("a remote Task revision cannot silently overwrite the Goal being edited",async()=>{
  let mutations=0,historyReads=0;
  window.dcode={request:async()=>{historyReads++;return [{taskId:"task-a",goal:"原目标",acceptance:[],taskRevision:1,changedAt:"2026-09-29T00:00:00.000Z"}];}};
  const base={id:"task-a",scope:{kind:"user",userId:"u"},goal:"原目标",acceptance:[],state:"active",revision:1};
  const workFor=task=>({task,draft:{text:"",images:[]},draftKey:"session-a",snapshot:{taskPlans:[]},mutateStore:async()=>{mutations++;},reload:async()=>{},updateDraft(){},flushDrafts:async()=>{}});
  try{
    const view=render(React.createElement(TaskGoalEditor,{work:workFor(base),onClose(){}}));
    fireEvent.change(screen.getByRole("textbox",{name:"短期结果"}),{target:{value:"我正在写的新目标"}});
    view.rerender(React.createElement(TaskGoalEditor,{work:workFor({...base,goal:"别人刚改的目标",revision:2}),onClose(){}}));
    await waitFor(()=>assert.match(screen.getByRole("alert").textContent,/任务已在别处更新/));
    assert.equal(screen.getByRole("textbox",{name:"短期结果"}).value,"我正在写的新目标");
    assert.equal(screen.getByRole("button",{name:"保存修订"}).disabled,true);
    await waitFor(()=>assert.equal(historyReads,2));
    assert.equal(mutations,0);
  }finally{cleanup();}
});

test("an accepted Goal write locks input and a failed refresh cannot repeat the write",async()=>{
  let resolveWrite,mutations=0,refreshes=0,closes=0;
  window.dcode={request:async()=>[]};
  const task={id:"task-a",scope:{kind:"user",userId:"u"},goal:"原目标",acceptance:[],state:"active",revision:1};
  const reload=async()=>{refreshes++;return refreshes===1?undefined:{tasks:[{...task,goal:"新目标",revision:2}]};};
  const work={task,draft:{text:"",images:[]},draftKey:"session-a",snapshot:{taskPlans:[]},mutateStore:()=>{mutations++;return new Promise(resolve=>{resolveWrite=resolve;});},reload,reloadConfirmed:async()=>{const value=await reload();if(!value)throw Error("刷新未确认");return value;},updateDraft(){},flushDrafts:async()=>{}};
  try{
    render(React.createElement(TaskGoalEditor,{work,onClose(){closes++;}}));
    const goal=screen.getByRole("textbox",{name:"短期结果"});
    fireEvent.change(goal,{target:{value:"新目标"}});
    fireEvent.click(screen.getByRole("button",{name:"保存修订"}));
    assert.equal(goal.readOnly,true);
    assert.equal(screen.getByRole("button",{name:"收起"}).disabled,true);
    fireEvent.change(goal,{target:{value:"保存中又写的内容"}});
    assert.equal(goal.value,"新目标");
    await act(async()=>resolveWrite({task:{...task,goal:"新目标",revision:2}}));
    await waitFor(()=>assert.match(screen.getByRole("alert").textContent,/目标已保存，但界面刷新失败/));
    assert.equal(mutations,1);
    fireEvent.click(screen.getByRole("button",{name:"重新读取已保存目标"}));
    await waitFor(()=>assert.equal(closes,1));
    assert.equal(refreshes,2);
    assert.equal(mutations,1);
  }finally{cleanup();}
});
