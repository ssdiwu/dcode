import React,{useState} from "react";
import {createRoot} from "react-dom/client";
import {SWRConfig} from "swr";
import {Composer} from "/src/components/Composer.tsx";
import "/src/style.css";

const commands=[
  ...Array.from({length:169},(_,index)=>({name:"skill:"+(index===0?"507-breakdown":"507-workflow-"+String(index+1).padStart(3,"0")),source:"skill",description:index===0?"视频拉片：定位文字、镜头与证据。":"根据真实材料处理第 "+(index+1)+" 项工作。"})),
  ...["compact","model","status"].map(name=>({name,source:"extension",description:"运行 "+name+" 命令"})),
  ...["weekly-report","research-brief"].map(name=>({name,source:"prompt",description:"填写 "+name+" 模板"})),
];
const state=window as any;
state.submissions=[];
state.menuMode=new URLSearchParams(location.search).get("mode")??"loaded";
state.dcode={request:async(method:string)=>{
  if(method!=="dcodeSession.commands")throw Error("Unexpected "+method);
  if(state.menuMode==="loading")await new Promise(resolve=>setTimeout(resolve,900));
  if(state.menuMode==="error")throw Error("能力目录暂不可用");
  return {commands:state.menuMode==="empty"?[]:commands};
}};

function Fixture(){
  const [draft,setDraft]=useState({text:"",images:[],attachments:[]});
  state.currentDraft=draft.text;
  const work={
    draft,draftKey:"new:user",task:null,session:null,newProjectId:null,
    snapshot:{projects:[],agentRuns:[],sessions:[],sessionRuns:[]},preferences:{},
    running:false,sending:false,closing:false,hostDead:false,
    updateDraft:(_key:string,next:any)=>setDraft(previous=>typeof next==="function"?next(previous):next),
    send:async()=>{state.submissions.push(draft.text);},
    setNewProjectId:()=>{},stop:()=>{},addAttachment:async()=>{},trackAttachmentImport:()=>{},fail:()=>{},
  };
  const models={data:{models:[{key:"fixture",name:"测试模型",modelId:"fixture",available:true,enabled:true,providerId:"local",providerName:"测试"}],selectedKey:"fixture",thinkingLevels:[]},choose:()=>{},refresh:()=>{},setThinking:()=>{},refreshing:false,busy:false,loading:false};
  return <main className="fixture-area new-task-stage"><div className="fixture-composer"><Composer work={work as any} models={models as any} pathForFile={()=>""} onSettings={()=>{}}/></div></main>;
}
createRoot(document.getElementById("root")!).render(<SWRConfig value={{provider:()=>new Map(),dedupingInterval:0}}><Fixture/></SWRConfig>);
