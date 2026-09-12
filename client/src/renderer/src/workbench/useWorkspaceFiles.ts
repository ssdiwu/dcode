import {createContext,useEffect,useRef,useState} from "react";
import type {WorkspaceFile} from "../../../../../host/src/workspace-files.js";
import type {WorkspaceSource} from "../../../../../host/src/workspace-access.js";
import {api,errorText} from "../types";
import type {Workbench} from "../useWorkbench";
export const FileReferenceContext=createContext<((reference:string)=>void)|undefined>(undefined);
export interface FileTab {id:string;source:WorkspaceSource;path:string;kind:"file"|"diff";staged?:boolean;diff?:{diff:string;digest:string;absolutePath:string};document?:WorkspaceFile&{absolutePath:string;root:string};draft?:string;mode:"preview"|"source"|"edit";line?:number;loading:boolean;saving:boolean;error?:string;conflict?:boolean}
const sourceKey=(source:WorkspaceSource)=>JSON.stringify([source.taskId??null,source.projectId??null,source.artifactId??null]);
export const fileDirty=(tab:FileTab)=>tab.draft!==undefined&&tab.document?.text!==tab.draft;
export function useWorkspaceFiles(work:Workbench){
  const canonical=(source:WorkspaceSource):WorkspaceSource=>{
    if(source.artifactId)return {...source};
    const task=work.snapshot?.tasks.find(task=>task.id===source.taskId);
    return source.projectId?{projectId:source.projectId}:task?.scope.kind==="project"?{projectId:task.scope.projectId}:{...source};
  };
  const baseSource:WorkspaceSource|null=work.task?canonical({taskId:work.task.id}):work.newProjectId?{projectId:work.newProjectId}:null;
  const [browserSource,setBrowserSource]=useState<WorkspaceSource|null>(null);
  const source=browserSource??baseSource;
  const [navigationVersion,setNavigationVersion]=useState(0);
  const sourcePath=source?.projectId?work.snapshot?.projects.find(p=>p.id===source.projectId)?.directory:source?.taskId?work.snapshot?.tasks.find(t=>t.id===source.taskId)?.cwd:"";
  const scope=JSON.stringify([source?sourceKey(source):null,sourcePath,navigationVersion]);
  const [navigationRequest,setNavigationRequest]=useState(0);
  const [navigationVisible,setNavigationVisible]=useState(false),[navigationPath,setNavigationPath]=useState("");
  const [navigationView,setNavigationView]=useState<"files"|"git">("files");
  const [visible,setVisible]=useState(false),[notice,setNotice]=useState("");
  const [tabs,setTabs]=useState<FileTab[]>([]);const latest=useRef(tabs);latest.current=tabs;
  const [selected,setSelected]=useState<string|null>(null);const selectedRef=useRef(selected);selectedRef.current=selected;
  const [closing,setClosing]=useState<string|null>(null);
  const requests=useRef(new Map<string,number>()),selectionRequest=useRef(0),taskRef=useRef(work.task?.id);taskRef.current=work.task?.id;
  const updateTabs=(fn:(tabs:FileTab[])=>FileTab[])=>{const value=fn(latest.current);latest.current=value;setTabs(value);};
  const activate=(id:string)=>{selectedRef.current=id;setSelected(id);setVisible(true);setNotice("");};
  const patch=(id:string,value:Partial<FileTab>|((tab:FileTab)=>FileTab))=>updateTabs(tabs=>tabs.map(tab=>tab.id===id?typeof value==="function"?value(tab):{...tab,...value}:tab));
  const ticket=(id:string)=>{const next=(requests.current.get(id)??0)+1;requests.current.set(id,next);return next;};
  const load=async(tab:FileTab)=>{
    const request=ticket(tab.id);patch(tab.id,{loading:true,error:undefined});
    try{
      if(tab.kind==="diff"){
        const diff=await api().request<NonNullable<FileTab["diff"]>>("workspace.diff",{source:tab.source,path:tab.path,staged:!!tab.staged});
        if(requests.current.get(tab.id)===request)patch(tab.id,{diff,loading:false});
      }else{
        const document=await api().request<NonNullable<FileTab["document"]>>("workspace.read",{source:tab.source,path:tab.path});
        if(requests.current.get(tab.id)===request){
          const existing=latest.current.find(other=>other.id!==tab.id&&other.kind==="file"&&document.editable&&other.document?.editable&&other.document.absolutePath===document.absolutePath);
          if(existing){
            ticket(tab.id);updateTabs(values=>values.filter(value=>value.id!==tab.id));
            if(selectedRef.current===tab.id){selectedRef.current=existing.id;setSelected(existing.id);if(tab.line!==undefined)patch(existing.id,current=>({...current,line:tab.line,mode:current.mode==="edit"?"edit":"source"}));}
            return;
          }
        }
        if(requests.current.get(tab.id)===request)patch(tab.id,current=>({...current,document,draft:document.kind==="html"?document.text:undefined,mode:document.kind==="html"?"edit":current.line?"source":"preview",loading:false,conflict:false}));
      }
    }catch(error){if(requests.current.get(tab.id)===request)patch(tab.id,{error:errorText(error),loading:false});}
  };
  const open=(path:string,target=source,line?:number,kind:"file"|"diff"="file",staged=false)=>{
    if(!target)return;selectionRequest.current++;
    const owner=canonical(target),id=JSON.stringify([sourceKey(owner),path,kind,kind==="diff"?staged:null]);
    activate(id);
    if(latest.current.some(tab=>tab.id===id)){if(line!==undefined)patch(id,current=>({...current,line,mode:current.mode==="edit"?"edit":"source"}));return;}
    const tab:FileTab={id,source:owner,path,kind,staged:kind==="diff"?staged:undefined,line,mode:"preview",loading:true,saving:false};
    updateTabs(values=>[...values,tab]);void load(tab);
  };
  const navigate=(target:WorkspaceSource,path="")=>{selectionRequest.current++;setNavigationRequest(value=>value+1);setBrowserSource(canonical(target));setNavigationPath(path);setNavigationView("files");setNavigationVisible(true);setNotice("");};
  const openReference=async(reference:string,referenceSource?:WorkspaceSource)=>{
    const taskId=referenceSource?undefined:work.task?.id,request=++selectionRequest.current;
    if(!referenceSource&&!taskId){setNotice("请先选择任务，再打开本机文件引用");setVisible(true);return;}
    try{
      const target=await api().request<{source:WorkspaceSource;path:string;line?:number;kind:"file"|"directory"}>("workspace.reference",{...(referenceSource?{source:referenceSource}:{taskId}),reference});
      if(request!==selectionRequest.current||(taskId&&taskRef.current!==taskId))return;
      if(target.kind==="directory")navigate(target.source,target.path);else open(target.path,target.source,target.line);
    }catch(error){if(request===selectionRequest.current&&(!taskId||taskRef.current===taskId)){setNotice(errorText(error));setVisible(true);}}
  };
  const openRelative=(tab:FileTab,reference:string)=>{
    if(/^(?:[a-z][a-z0-9+.-]*:|\/)/iu.test(reference)){void openReference(reference,tab.source);return;}
    try{
      const pathname=decodeURIComponent(reference.split(/[?#]/u)[0]??""),parts=tab.path.split("/").slice(0,-1);
      if(pathname)for(const part of pathname.split("/")){if(part===".."){if(!parts.length)throw new Error("引用不在当前文件目录范围内");parts.pop();}else if(part&&part!==".")parts.push(part);}
      const line=reference.match(/#L?(\d+)$/u);void openReference((pathname?parts.join("/"):tab.path)+(line?"#L"+line[1]:""),tab.source);
    }catch(error){setNotice(errorText(error));}
  };
  const openArtifact=async(artifactId:string)=>{
    const artifact=work.snapshot?.artifacts.find(item=>item.id===artifactId);if(!artifact)return;
    const target={taskId:artifact.taskId,artifactId},request=++selectionRequest.current;
    try{const info=await api().request<{file?:string}>("workspace.describe",{source:target});if(request!==selectionRequest.current)return;if(info.file)open(info.file,target);else navigate(target);}
    catch(error){if(request===selectionRequest.current){setNotice(errorText(error));setVisible(true);}}
  };
  const browse=(artifactId?:string)=>{if(artifactId)void openArtifact(artifactId);else if(baseSource)navigate(baseSource);};
  const save=async(id:string,overwrite=false):Promise<boolean>=>{
    const tab=latest.current.find(tab=>tab.id===id);if(!tab?.document||tab.draft===undefined||tab.saving)return false;
    ticket(id);const text=tab.draft;patch(id,{saving:true,error:undefined});
    try{
      const document=await api().request<NonNullable<FileTab["document"]>>("workspace.save",{source:tab.source,path:tab.path,text,expectedDigest:tab.document.digest,expectedRoot:tab.document.root,overwrite});
      patch(id,current=>({...current,document,draft:current.draft===text?document.text:current.draft,saving:false,conflict:false}));return true;
    }catch(error){patch(id,{saving:false,error:errorText(error),conflict:/FILE_CONFLICT|编辑期间|冲突/u.test(errorText(error))});return false;}
  };
  const discard=(id:string)=>{
    ticket(id);const index=latest.current.findIndex(tab=>tab.id===id),remaining=latest.current.filter(tab=>tab.id!==id);
    updateTabs(()=>remaining);
    if(selectedRef.current===id){const next=remaining[Math.min(Math.max(index,0),remaining.length-1)]?.id??null;selectedRef.current=next;setSelected(next);if(!next)setVisible(false);}
    setClosing(null);
  };
  const close=(id:string)=>{const tab=latest.current.find(tab=>tab.id===id);if(tab?.saving)return;if(tab&&fileDirty(tab))setClosing(id);else discard(id);};
  useEffect(()=>work.registerQuitFlush(async()=>{const dirty=latest.current.find(fileDirty);if(dirty){setClosing(dirty.id);throw new Error(`文件 ${dirty.path} 有未保存修改，请先保存或放弃。`);}}),[work.registerQuitFlush]);
  const quote=(tab:FileTab,lineOverride?:number)=>{
    if(!tab.document)return;const line=lineOverride??tab.line??1,content=(tab.draft??tab.document.text).split("\n")[line-1];
    work.updateDraft(work.draftKey,previous=>({...previous,text:`${previous.text}${previous.text?"\n\n":""}[${tab.path}:${line}](<${encodeURI(tab.document!.absolutePath)}#L${line}>)${fileDirty(tab)?"（未保存编辑）":""}\n> ${content??""}\n`}));
  };
  const projectFileScope=(projectId:string,targetDirectory:string,moveFiles:boolean)=>{
    const taskIds=new Set(work.snapshot?.tasks.filter(task=>task.scope.kind==="project"&&task.scope.projectId===projectId).map(task=>task.id));
    const normalize=(path:string)=>path.replace(/^\/(var|tmp|etc)(?=\/|$)/u,"/private/$1").normalize("NFD").toLowerCase().replace(/\/+$/u,"");
    const roots=[work.snapshot?.projects.find(project=>project.id===projectId)?.directory,targetDirectory].filter((path):path is string=>!!path).map(normalize);
    const sourceOwned=(source:WorkspaceSource)=>source.projectId===projectId||!!source.taskId&&taskIds.has(source.taskId);
    const contains=(tab:FileTab)=>sourceOwned(tab.source)||moveFiles&&!!tab.document&&roots.some(root=>{const path=normalize(tab.document!.absolutePath);return path===root||path.startsWith(root+"/");});
    return {sourceOwned,contains};
  };
  const beforeProjectDirectoryChange=(projectId:string,targetDirectory:string,moveFiles:boolean)=>{
    const {contains}=projectFileScope(projectId,targetDirectory,moveFiles);
    if(latest.current.some(tab=>contains(tab)&&(fileDirty(tab)||tab.saving)))throw new Error("请先保存或关闭相关目录中尚未保存的文件，再更换目录");
  };
  const invalidateProject=(projectId:string,targetDirectory:string,moveFiles:boolean)=>{
    const {sourceOwned,contains}=projectFileScope(projectId,targetDirectory,moveFiles);
    for(const tab of latest.current)if(!fileDirty(tab)&&!tab.saving&&contains(tab))discard(tab.id);
    if(browserSource&&sourceOwned(browserSource))setNavigationVersion(value=>value+1);
  };
  const sourceTitle=(target:WorkspaceSource)=>{
    if(target.artifactId)return work.snapshot?.artifacts.find(item=>item.id===target.artifactId)?.title??"产物不可用";
    if(target.projectId)return work.snapshot?.projects.find(item=>item.id===target.projectId)?.title??"项目不可用";
    return work.snapshot?.tasks.find(item=>item.id===target.taskId)?.title??"任务不可用";
  };
  const hide=()=>{selectionRequest.current++;setVisible(false);setNotice("");};
  return {source,baseSource,scope,navigationRequest,navigationVisible,navigationPath,navigationView,setNavigationView,sourceTitle,notice,
    beforeProjectDirectoryChange,invalidateProject,browse,openArtifact,openRelative,
    artifacts:work.snapshot?.artifacts.filter(artifact=>artifact.taskId===work.task?.id&&artifact.kind!=="attachment"&&(artifact.managedPath||artifact.externalPath))??[],
    tabs,allTabs:tabs,active:tabs.find(tab=>tab.id===selected)??null,visible,closing:tabs.find(tab=>tab.id===closing)??null,
    browseProject:(projectId:string)=>navigate({projectId}),returnToTasks:()=>{selectionRequest.current++;setNavigationVisible(false);},
    show:(reopenNavigation=false)=>{const target=reopenNavigation?source:baseSource??source;if(target)navigate(target);},showInspector:()=>setVisible(true),conversation:hide,
    hideForDraft:()=>{hide();setNavigationVisible(false);},select:(id:string)=>{selectionRequest.current++;activate(id);},
    open,openReference,openDiff:(path:string,target=source,staged=false)=>open(path,target,undefined,"diff",staged),
    save,close,discard,keep:()=>setClosing(null),saveAndClose:async(id:string)=>{if(await save(id))discard(id);},reload:load,patch,quote};
}
export type WorkspaceFileModel=ReturnType<typeof useWorkspaceFiles>;
