import {useCallback,useEffect,useMemo,useRef,useState} from "react";
import useSWR from "swr";
import {api,errorText,type IdeaDraft,type IdeaKind,type IdeaNode,type IdeaPosition,type InspirationOperation,type InspirationView,type TaskRecord} from "../types";
import type {Workbench} from "../useWorkbench";

export const ideaLabels:Record<IdeaKind,string>={text:"文字",image:"图片",link:"链接",video:"视频"};
export function imageNearCanvas(position:IdeaPosition,viewport:{x:number;y:number;zoom:number},bounds:{width:number;height:number}){
  const left=position.x*viewport.zoom+viewport.x,top=position.y*viewport.zoom+viewport.y;
  // A 350px card is the upper bound for both axes; keep a 100px preload margin.
  const extent=350*viewport.zoom;
  return left+extent>-100&&top+extent>-100&&left<bounds.width+100&&top<bounds.height+100;
}
export function useInspiration(work:Workbench,active:boolean){
  const requested=useRef(false);if(active)requested.current=true;
  const {data:loaded,error:loadError,mutate}=useSWR(requested.current&&!work.hostDead?"inspiration":null,()=>api().request<InspirationView>("inspiration.get"),{revalidateOnFocus:false});
  const last=useRef<InspirationView|undefined>(undefined);if(loaded)last.current=loaded;
  const data=loaded??last.current;
  const [error,setError]=useState<string|null>(null),[notice,setNotice]=useState("");
  const [query,setQuery]=useState(""),[archive,setArchive]=useState(false),[selected,setSelected]=useState<string[]>([]);
  const [draft,setDraftState]=useState<IdeaDraft|null>(null),draftRef=useRef<IdeaDraft|null>(null),hydrated=useRef(false),draftDirty=useRef(false);
  const [busy,setBusy]=useState(false),[pending,setPending]=useState(0),[draftSaving,setDraftSaving]=useState(false);
  const [targetTaskId,setTargetTaskId]=useState<string|null>(null);
  const tail=useRef<Promise<unknown>>(Promise.resolve()),draftTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),viewTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const [viewport,setViewportState]=useState({x:0,y:0,zoom:1}),viewRef=useRef(viewport),viewDirty=useRef(false);
  const [canvasBounds,setCanvasBounds]=useState({width:0,height:0});
  const workRef=useRef(work);workRef.current=work;
  useEffect(()=>{if(data&&!hydrated.current){hydrated.current=true;if(!draftDirty.current){draftRef.current=data.draft??null;setDraftState(draftRef.current);}viewRef.current=data.viewport;setViewportState(data.viewport);}},[data]);
  useEffect(()=>{if(active&&!work.hostDead)void mutate();},[active,work.hostDead,mutate]);
  useEffect(()=>api().subscribe(event=>{if(active&&event.event==="inspiration.changed")void mutate();}),[active,mutate]);
  const execute=useCallback((operation:InspirationOperation)=>{
    setPending(n=>n+1);setError(null);setNotice("");
    const request=tail.current.catch(()=>{}).then(async()=>{
      const result=await workRef.current.mutateStore<{view:InspirationView}>("inspiration.mutate",{operation});
      last.current=result.view;await mutate(result.view,false);return result.view;
    });
    tail.current=request.catch(reason=>{setError(errorText(reason));}).finally(()=>setPending(n=>n-1));
    return request;
  },[mutate]);
  const flushDraft=useCallback(async()=>{
    clearTimeout(draftTimer.current);
    while(draftDirty.current){const value=draftRef.current;await execute({kind:"draft",draft:value});if(draftRef.current===value){draftDirty.current=false;setDraftSaving(false);}}
  },[execute]);
  const flushView=useCallback(async()=>{
    clearTimeout(viewTimer.current);
    while(viewDirty.current){const value=viewRef.current;await execute({kind:"viewport",viewport:value});if(viewRef.current===value)viewDirty.current=false;}
  },[execute]);
  useEffect(()=>work.registerQuitFlush(async()=>{await flushDraft();await flushView();await tail.current;}),[work.registerQuitFlush,flushDraft,flushView]);
  useEffect(()=>()=>{clearTimeout(draftTimer.current);clearTimeout(viewTimer.current);},[]);
  const updateDraft=(value:IdeaDraft|null)=>{
    if(workRef.current.closing)return;
    draftRef.current=value;setDraftState(value);draftDirty.current=true;setDraftSaving(true);clearTimeout(draftTimer.current);
    draftTimer.current=setTimeout(()=>void flushDraft().catch(reason=>setError(errorText(reason))),350);
  };
  const begin=async(kind:IdeaKind,source?:{title:string;markdown:string;sourceTaskId?:string})=>{
    if(workRef.current.closing)return;
    try {
      if(!hydrated.current){const value=last.current??await api().request<InspirationView>("inspiration.get");last.current=value;hydrated.current=true;draftRef.current=value.draft??null;setDraftState(draftRef.current);viewRef.current=value.viewport;setViewportState(value.viewport);}
      if(workRef.current.closing)return;
      if(draftRef.current){setNotice("已有编辑草稿，请先保存或放弃。");return;}
      updateDraft({id:`idea-${crypto.randomUUID()}`,kind,title:source?.title??"",markdown:source?.markdown??"",url:"",tags:"",expectedNodeRevision:0,...(source?.sourceTaskId?{sourceTaskId:source.sourceTaskId}:{})});
    }catch(reason){setError(errorText(reason));}
  };
  const edit=(node:IdeaNode)=>{
    if(busy||workRef.current.closing)return;
    if(draftRef.current){if(draftRef.current.id!==node.id)setNotice("已有编辑草稿，请先保存或放弃。");return;}
    updateDraft({id:node.id,kind:node.kind,title:node.title,markdown:node.markdown,url:node.url??"",tags:node.tags.join("，"),expectedNodeRevision:node.revision,...(node.sourceTaskId?{sourceTaskId:node.sourceTaskId}:{})});
  };
  const save=async()=>{
    const value=draftRef.current;if(!value||busy||workRef.current.closing)return;setBusy(true);
    try {
      await flushDraft();
      const origin={x:(160-viewRef.current.x)/viewRef.current.zoom,y:(100-viewRef.current.y)/viewRef.current.zoom};
      const occupied=(last.current?.nodes??[]).filter(node=>!node.archived).map(node=>last.current!.positions[node.id]!);
      let position=origin;
      // Keep a new card visible without stacking it over existing content.
      for(let slot=0;occupied.some(p=>Math.abs(p.x-position.x)<365&&Math.abs(p.y-position.y)<365);slot++)position={x:origin.x+(slot+1)%3*380,y:origin.y+Math.floor((slot+1)/3)*380};
      const saved=await execute({kind:"save",node:{id:value.id,kind:value.kind,title:value.title,markdown:value.markdown,url:value.url,tags:value.tags.split(/[,，]/).map(t=>t.trim()).filter(Boolean),...(value.sourceTaskId?{sourceTaskId:value.sourceTaskId}:{})},expectedNodeRevision:value.expectedNodeRevision,position,...(value.mediaPath?{mediaPath:value.mediaPath}:{})});
      draftRef.current=null;setDraftState(null);draftDirty.current=false;setDraftSaving(false);setSelected([value.id]);setArchive(saved.nodes.find(node=>node.id===value.id)?.archived??false);setNotice("灵感已保存。");
    }catch(reason){setError(errorText(reason));}finally{setBusy(false);}
  };
  const command=(operation:InspirationOperation)=>workRef.current.closing?Promise.resolve(undefined):execute(operation).catch(()=>undefined);
  const setViewport=(value:typeof viewport)=>{
    if(workRef.current.closing)return;
    viewRef.current=value;setViewportState(value);viewDirty.current=true;clearTimeout(viewTimer.current);
    viewTimer.current=setTimeout(()=>void flushView().catch(reason=>setError(errorText(reason))),350);
  };
  const tasks=(work.snapshot?.tasks??[]).filter(task=>task.state!=="archived");
  const target=tasks.find(task=>task.id===(targetTaskId??work.task?.id))??tasks[0];
  const reference=async(node:IdeaNode)=>{
    if(!target||busy||workRef.current.closing)return;setBusy(true);setError(null);
    try {await tail.current;await work.mutateStore("inspiration.reference",{nodeId:node.id,nodeRevision:node.revision,taskId:target.id});await work.reload();work.select(target);setNotice(`已引用到“${target.title}”，下次运行会使用第 ${node.revision} 版。`);}catch(reason){setError(errorText(reason));}finally{setBusy(false);}
  };
  const visibleNodes=useMemo(()=>{
    const needle=query.trim().toLocaleLowerCase();
    return (data?.nodes??[]).filter(node=>node.archived===archive&&(!needle||[node.title,node.markdown,node.url,...node.tags].join(" ").toLocaleLowerCase().includes(needle)));
  },[data,query,archive]);
  const bounds=canvasBounds.width&&canvasBounds.height?canvasBounds:{width:window.innerWidth,height:window.innerHeight};
  const imageNodes=visibleNodes.filter(node=>{const p=data?.positions[node.id];return node.kind==="image"&&node.media&&p&&imageNearCanvas(p,viewport,bounds);});
  const mediaKey=imageNodes.map(node=>`${node.id}:${node.media!.digest}`).join(",");
  const {data:images}=useSWR(active&&mediaKey?["inspiration-images",mediaKey]:null,async()=>Object.fromEntries(await Promise.all(imageNodes.map(async node=>{try {const result=await api().request<{data?:string;mimeType:string}>("inspiration.media",{nodeId:node.id});return [node.id,result.data?`data:${result.mimeType};base64,${result.data}`:undefined];}catch{return [node.id,undefined];}}))),{revalidateOnFocus:false,keepPreviousData:true});
  const sources=work.snapshot?.taskContextSets.flatMap(set=>set.sources)??[];
  const references=(node:IdeaNode)=>sources.filter(source=>source.kind==="global_knowledge"&&source.relativePath.startsWith(`${node.id}/`)&&source.rootPath?.endsWith("/knowledge/inspiration")).map(source=>({task:work.snapshot?.tasks.find(task=>task.id===source.taskId),current:source.relativePath.startsWith(`${node.id}/r${node.revision}-`)}));
  return {data,loading:active&&!data&&!loadError,error:error??(loadError?errorText(loadError):null),notice,query,setQuery,archive,setArchive,selected,setSelected,draft,draftSaving,updateDraft,begin,edit,save,busy:busy||work.closing,closing:work.closing,pending,viewport,setViewport,visibleNodes,images:images??{},command,target,tasks,setTargetTaskId,reference,references,
    refresh:()=>mutate(),clearError:()=>setError(null),reportError:(message:string)=>setError(message),
    measureCanvas:(width:number,height:number)=>setCanvasBounds(previous=>previous.width===width&&previous.height===height?previous:{width,height}),
    preview:(node:IdeaNode,media=true)=>api().previewInspiration(node.id,media&&!!node.media).catch(reason=>setError(errorText(reason))),
    openLink:(url:string)=>api().openExternal(url).catch(reason=>setError(errorText(reason))),
    fromTask:()=>{if(work.task)begin("text",{title:work.task.title,markdown:work.draft.text.trim()||work.task.goal,sourceTaskId:work.task.id});},
    sourceTask:(node:IdeaNode):TaskRecord|undefined=>work.snapshot?.tasks.find(task=>task.id===node.sourceTaskId),
    newTask:async(node:IdeaNode)=>{
      if(!work.snapshot||busy||workRef.current.closing)return;setBusy(true);setError(null);
      try {
        const bundle=await work.mutateStore<import("../types").TaskBundle>("task.create",{scope:{kind:"user",userId:work.snapshot.currentUser.id},title:node.title,goal:`基于灵感“${node.title}”继续推进。`,acceptance:[]});
        await work.reload();work.select(bundle.task);setTargetTaskId(bundle.task.id);
        await work.mutateStore("inspiration.reference",{nodeId:node.id,nodeRevision:node.revision,taskId:bundle.task.id});await work.reload();setNotice(`已创建任务“${node.title}”并引用灵感。`);
      }catch(reason){setError(errorText(reason));}finally{setBusy(false);}
    },
  };
}
export type InspirationControls=ReturnType<typeof useInspiration>;
