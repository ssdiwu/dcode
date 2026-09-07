import {createContext,useEffect,useRef,useState} from "react";
import type {WorkspaceFile} from "../../../../../host/src/workspace-files.js";
import type {WorkspaceSource} from "../../../../../host/src/workspace-access.js";
import {api,errorText} from "../types";
import type {Workbench} from "../useWorkbench";
export const FileReferenceContext=createContext<((reference:string)=>void)|undefined>(undefined);
export interface FileTab {id:string;scope:string;source:WorkspaceSource;path:string;document?:WorkspaceFile&{absolutePath:string;root:string};draft?:string;mode:"preview"|"source"|"edit";line?:number;loading:boolean;saving:boolean;error?:string;conflict?:boolean}
const sourceKey=(source:WorkspaceSource)=>JSON.stringify([source.taskId??null,source.projectId??null,source.artifactId??null]);
export const fileDirty=(tab:FileTab)=>tab.draft!==undefined&&tab.document?.text!==tab.draft;
export function useWorkspaceFiles(work:Workbench){
  const baseSource:WorkspaceSource|null=work.task?{taskId:work.task.id}:work.newProjectId?{projectId:work.newProjectId}:null;
  const scope=baseSource?sourceKey(baseSource):"none";
  const [browserSources,setBrowserSources]=useState<Record<string,WorkspaceSource>>({});
  const source=browserSources[scope]??baseSource;
  const [tabs,setTabs]=useState<FileTab[]>([]);const latest=useRef(tabs);latest.current=tabs;
  const [selected,setSelected]=useState<Record<string,string|null>>({});
  const [browser,setBrowser]=useState<Record<string,boolean>>({});
  const [closing,setClosing]=useState<string|null>(null);
  const patch=(id:string,value:Partial<FileTab>|((tab:FileTab)=>FileTab))=>setTabs(tabs=>tabs.map(tab=>tab.id===id?typeof value==="function"?value(tab):{...tab,...value}:tab));
  const load=async(id:string,target:WorkspaceSource,path:string)=>{
    patch(id,{loading:true,error:undefined});
    try{const document=await api().request<NonNullable<FileTab["document"]>>("workspace.read",{source:target,path});patch(id,tab=>({...tab,document,draft:document.kind==="html"?document.text:undefined,mode:document.kind==="html"?"edit":"preview",loading:false,conflict:false}));}
    catch(error){patch(id,{error:errorText(error),loading:false});}
  };
  const open=(path:string,target=source,line?:number)=>{
    if(!target)return;
    const id=JSON.stringify([sourceKey(target),path]);
    setBrowser(values=>({...values,[scope]:true}));setSelected(values=>({...values,[scope]:id}));
    if(latest.current.some(tab=>tab.id===id)){patch(id,{line});return;}
    const tab:FileTab={id,scope,source:target,path,line,mode:"preview",loading:true,saving:false};
    setTabs(values=>values.some(value=>value.id===id)?values:[...values,tab]);void load(id,target,path);
  };
  const openReference=async(reference:string)=>{
    if(!work.task){work.fail(new Error("请先选择任务，再打开本机文件引用"));return;}
    try{const target=await api().request<{source:WorkspaceSource;path:string;line?:number}>("workspace.reference",{taskId:work.task.id,reference});open(target.path,target.source,target.line);}catch(error){work.fail(error);}
  };
  const openRelative=(tab:FileTab,reference:string)=>{
    if(/^(?:[a-z][a-z0-9+.-]*:|\/)/iu.test(reference)){void openReference(reference);return;}
    try{
      const pathname=decodeURIComponent(reference.split(/[?#]/u)[0]??""),parts=tab.path.split("/").slice(0,-1);
      if(pathname)for(const part of pathname.split("/")){if(part===".."){if(!parts.length)throw new Error("引用不在当前文件目录范围内");parts.pop();}else if(part&&part!==".")parts.push(part);}
      const line=reference.match(/#L?(\d+)$/u);open(pathname?parts.join("/"):tab.path,tab.source,line?Number(line[1]):undefined);
    }catch(error){work.fail(error);}
  };
  const openArtifact=async(artifactId:string)=>{
    if(!work.task)return;const target={taskId:work.task.id,artifactId};
    try{const info=await api().request<{file?:string}>("workspace.describe",{source:target});if(info.file)open(info.file,target);else{setBrowserSources(values=>({...values,[scope]:target}));setBrowser(values=>({...values,[scope]:true}));}}catch(error){work.fail(error);}
  };
  const browse=(artifactId?:string)=>{if(artifactId)void openArtifact(artifactId);else{setBrowserSources(values=>{const next={...values};delete next[scope];return next;});setBrowser(values=>({...values,[scope]:true}));}};
  const save=async(id:string,overwrite=false):Promise<boolean>=>{
    const tab=latest.current.find(tab=>tab.id===id);if(!tab?.document||tab.draft===undefined||tab.saving)return false;
    const text=tab.draft;patch(id,{saving:true,error:undefined});
    try{
      const document=await api().request<NonNullable<FileTab["document"]>>("workspace.save",{source:tab.source,path:tab.path,text,expectedDigest:tab.document.digest,expectedRoot:tab.document.root,overwrite});
      patch(id,current=>({...current,document,draft:current.draft===text?document.text:current.draft,saving:false,conflict:false}));return true;
    }catch(error){const message=errorText(error);patch(id,{saving:false,error:message,conflict:/FILE_CONFLICT|编辑期间|冲突/u.test(message)});return false;}
  };
  const discard=(id:string)=>{setTabs(values=>values.filter(tab=>tab.id!==id));setSelected(values=>Object.fromEntries(Object.entries(values).map(([key,value])=>[key,value===id?null:value])));setClosing(null);};
  const close=(id:string)=>{const tab=latest.current.find(tab=>tab.id===id);if(tab?.saving)return;if(tab&&fileDirty(tab))setClosing(id);else discard(id);};
  useEffect(()=>work.registerQuitFlush(async()=>{const dirty=latest.current.find(fileDirty);if(dirty){setClosing(dirty.id);throw new Error(`文件 ${dirty.path} 有未保存修改，请先保存或放弃。`);}}),[work.registerQuitFlush]);
  const quote=(tab:FileTab,lineOverride?:number)=>{
    if(!tab.document)return;const line=lineOverride??tab.line??1;const content=(tab.draft??tab.document.text).split("\n")[line-1];
    work.updateDraft(work.draftKey,previous=>({...previous,text:`${previous.text}${previous.text?"\n\n":""}[${tab.path}:${line}](<${encodeURI(tab.document!.absolutePath)}#L${line}>)${fileDirty(tab)?"（未保存编辑）":""}\n> ${content??""}\n`}));
  };
  return {source,baseSource,scope,browse,openArtifact,openRelative,artifacts:work.snapshot?.artifacts.filter(artifact=>artifact.taskId===work.task?.id&&artifact.kind!=="attachment"&&(artifact.managedPath||artifact.externalPath))??[],tabs:tabs.filter(tab=>tab.scope===scope),allTabs:tabs,active:tabs.find(tab=>tab.id===selected[scope])??null,visible:browser[scope]??false,closing:tabs.find(tab=>tab.id===closing)??null,
    show:()=>setBrowser(values=>({...values,[scope]:true})),conversation:()=>setBrowser(values=>({...values,[scope]:false})),select:(id:string)=>{setBrowser(values=>({...values,[scope]:true}));setSelected(values=>({...values,[scope]:id}));},
    open,openReference,save,close,discard,keep:()=>setClosing(null),saveAndClose:async(id:string)=>{if(await save(id))discard(id);},reload:(tab:FileTab)=>load(tab.id,tab.source,tab.path),patch,quote};
}
export type WorkspaceFileModel=ReturnType<typeof useWorkspaceFiles>;
