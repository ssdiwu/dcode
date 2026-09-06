import {useEffect,useLayoutEffect,useMemo,useRef,useState,type PointerEvent as ReactPointerEvent} from "react";
import {Archive,ArrowUpRight,BoxSelect,Check,FileText,Group,Hand,Image as ImageIcon,Link2,MousePointer2,Plus,Scan,Sparkles,Video,X,ZoomIn,ZoomOut} from "lucide-react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import {Markdown} from "./Markdown";
import {ideaLabels,type InspirationControls} from "../workbench/useInspiration";
import type {IdeaKind,IdeaNode,IdeaPosition} from "../types";

const icons={text:FileText,image:ImageIcon,link:Link2,video:Video};
type Tool="select"|"pan"|"box"|"link";
const canvasTools=[
  {id:"select",label:"选择",key:"V",hint:"点击查看灵感，拖动移动；按住 Shift 可多选。",Icon:MousePointer2},
  {id:"pan",label:"平移",key:"H",hint:"按住并拖动画布，移动整个视图；灵感位置保持不变。",Icon:Hand},
  {id:"box",label:"框选",key:"B",hint:"按住并拖出选框，一次选择多条灵感；Shift 可追加选择。",Icon:BoxSelect},
  {id:"link",label:"连线",key:"L",hint:"先点击一条灵感作为起点，再点击另一条连接。",Icon:Link2},
] as const;
type Gesture={kind:"pan"|"nodes"|"box";start:IdeaPosition;camera:InspirationControls["viewport"];positions:Record<string,IdeaPosition>;ids:string[];additive:boolean};
export function InspirationWorkspace({model,pathForFile,canSaveFromTask}:{model:InspirationControls;pathForFile:(file:File)=>string;canSaveFromTask:boolean}){
  const mediaInput=useRef<HTMLInputElement>(null);
  const canvas=useRef<HTMLDivElement>(null),gesture=useRef<Gesture|null>(null),space=useRef(false),gestureVersion=useRef(0),interactionVersion=useRef(0),linkBusy=useRef(false);
  const [tool,setTool]=useState<Tool>("select"),[box,setBox]=useState<{x:number;y:number;width:number;height:number}|null>(null),[ghost,setGhost]=useState<Record<string,IdeaPosition>>({}),[linkFrom,setLinkFrom]=useState<string|null>(null),[tab,setTab]=useState("knowledge"),[discard,setDiscard]=useState(false);
  const [temporaryPan,setTemporaryPan]=useState(false),[dragging,setDragging]=useState<Gesture["kind"]|null>(null),[interactionHint,setInteractionHint]=useState(""),[linkPointer,setLinkPointer]=useState<IdeaPosition|null>(null),[grouping,setGrouping]=useState(false),[linkSaving,setLinkSaving]=useState(false);
  const [nodeSizes,setNodeSizes]=useState<Record<string,{width:number;height:number}>>({});
  const size=(id:string)=>nodeSizes[id]??{width:240,height:180};
  const visibleIds=model.visibleNodes.map(node=>node.id).join(",");
  useLayoutEffect(()=>{
    const surface=canvas.current;if(!surface)return;const elements=surface.querySelectorAll<HTMLElement>(".idea-node");
    const capture=()=>{modelRef.current.measureCanvas(surface.clientWidth,surface.clientHeight);setNodeSizes(previous=>{let next=previous;for(const element of elements){const id=element.dataset.nodeId!,width=element.offsetWidth,height=element.offsetHeight;if(width&&height&&(previous[id]?.width!==width||previous[id]?.height!==height)){if(next===previous)next={...previous};next[id]={width,height};}}return next;});};
    const observer=new ResizeObserver(capture);observer.observe(surface);for(const element of elements)observer.observe(element);capture();return()=>observer.disconnect();
  },[visibleIds,model.loading]);
  const positions={...(model.data?.positions??{}),...ghost},positionsRef=useRef(positions);positionsRef.current=positions;
  const modelRef=useRef(model);modelRef.current=model;
  const selectedNodes=model.data?.nodes.filter(node=>model.selected.includes(node.id))??[];
  const selectedNode=selectedNodes.length===1?selectedNodes[0]:undefined;
  const needsTwo=(action:string)=>`${action}需要至少 2 条灵感。${model.query?"请清除搜索后重试。":model.archive?"请先恢复灵感并返回画布。":"请先新建灵感。"}`;
  const chooseTool=(next:Tool)=>{
    interactionVersion.current++;
    if(gesture.current?.kind==="nodes")setGhost({});
    gesture.current=null;setDragging(null);setBox(null);setTool(next);setLinkFrom(null);setLinkPointer(null);setInteractionHint("");
  };
  const point=(event:{clientX:number;clientY:number})=>{const rect=canvas.current!.getBoundingClientRect();return {x:event.clientX-rect.left,y:event.clientY-rect.top};};
  const zoom=(factor:number,anchor?:IdeaPosition)=>{
    const current=modelRef.current.viewport,rect=canvas.current?.getBoundingClientRect();
    const at=anchor??{x:(rect?.width??900)/2,y:(rect?.height??650)/2};
    const next=Math.max(.25,Math.min(2,current.zoom*factor));
    modelRef.current.setViewport({x:at.x-(at.x-current.x)*next/current.zoom,y:at.y-(at.y-current.y)*next/current.zoom,zoom:next});
  };
  useEffect(()=>{
    const el=canvas.current;if(!el)return;
    const wheel=(event:WheelEvent)=>{event.preventDefault();if(event.ctrlKey||event.metaKey)zoom(Math.exp(-event.deltaY*.005),point(event));else {const current=modelRef.current.viewport;modelRef.current.setViewport({...current,x:current.x-event.deltaX,y:current.y-event.deltaY});}};
    el.addEventListener("wheel",wheel,{passive:false});return()=>el.removeEventListener("wheel",wheel);
  },[model.loading]);
  useEffect(()=>{
    const down=(event:KeyboardEvent)=>{
      const target=event.target instanceof Element?event.target:null;
      if(modelRef.current.closing||event.defaultPrevented||target?.closest("input,textarea,select,[contenteditable],[role=menu],[role=menuitem],[role=option],[role=combobox]"))return;
      if(event.code==="Space"){
        if(target?.closest("button,a,summary,[role=button],[role=tab]"))return;
        space.current=true;setTemporaryPan(true);event.preventDefault();
      }
      if(!event.metaKey&&!event.ctrlKey&&!event.altKey){const picked=({v:"select",h:"pan",b:"box",l:"link"} as const)[event.key.toLowerCase() as "v"|"h"|"b"|"l"];if(picked)chooseTool(picked);}
      if(event.key==="Escape"){space.current=false;setTemporaryPan(false);chooseTool("select");modelRef.current.setSelected([]);}
    };
    const up=(event:KeyboardEvent)=>{if(event.code==="Space"){space.current=false;setTemporaryPan(false);}};
    const blur=()=>{space.current=false;setTemporaryPan(false);};
    window.addEventListener("keydown",down);window.addEventListener("keyup",up);window.addEventListener("blur",blur);return()=>{window.removeEventListener("keydown",down);window.removeEventListener("keyup",up);window.removeEventListener("blur",blur);};
  },[]);
  const focusNode=(node:IdeaNode)=>{
    const pos=positionsRef.current[node.id]??{x:0,y:0};model.setSelected([node.id]);setTab("knowledge");
    const rect=canvas.current?.getBoundingClientRect();model.setViewport({zoom:1,x:(rect?.width??900)/2-pos.x-size(node.id).width/2,y:(rect?.height??650)/2-pos.y-size(node.id).height/2});
  };
  const fit=()=>{
    const nodes=model.visibleNodes;if(!nodes.length){model.setViewport({x:0,y:0,zoom:1});return;}
    const points=nodes.map(node=>({...positionsRef.current[node.id],...size(node.id)})),left=Math.min(...points.map(p=>p.x)),top=Math.min(...points.map(p=>p.y)),right=Math.max(...points.map(p=>p.x+p.width)),bottom=Math.max(...points.map(p=>p.y+p.height));
    const rect=canvas.current!.getBoundingClientRect(),scale=Math.max(.25,Math.min(1,(rect.width-100)/(right-left),(rect.height-100)/(bottom-top)));
    model.setViewport({x:(rect.width-(right-left)*scale)/2-left*scale,y:(rect.height-(bottom-top)*scale)/2-top*scale,zoom:scale});
  };
  const beginGesture=(event:ReactPointerEvent<HTMLElement>,kind:Gesture["kind"],ids=model.selected)=>{
    if(kind!=="nodes")event.preventDefault();
    interactionVersion.current++;
    gestureVersion.current++;
    gesture.current={kind,start:point(event),camera:model.viewport,positions,ids,additive:event.shiftKey};setDragging(kind);setInteractionHint("");
    if(kind==="box"&&!event.shiftKey)model.setSelected([]);
    if(kind==="nodes")event.currentTarget.setPointerCapture(event.pointerId);
    else {canvas.current?.setPointerCapture(event.pointerId);canvas.current?.focus({preventScroll:true});}
  };
  const start=(event:ReactPointerEvent<HTMLDivElement>)=>{
    if(event.button>1||(event.target as Element).closest("button,input,textarea,select,.idea-node,.idea-tool-guidance"))return;
    if(tool==="pan"||space.current||event.button===1)beginGesture(event,"pan");
    else if(tool!=="link")beginGesture(event,"box");
  };
  const move=(event:ReactPointerEvent<HTMLDivElement>)=>{
    if(tool==="link"&&linkFrom){const p=point(event);setLinkPointer({x:(p.x-model.viewport.x)/model.viewport.zoom,y:(p.y-model.viewport.y)/model.viewport.zoom});}
    const action=gesture.current;if(!action)return;
    const p=point(event),dx=p.x-action.start.x,dy=p.y-action.start.y;
    if(action.kind==="pan")model.setViewport({...action.camera,x:action.camera.x+dx,y:action.camera.y+dy});
    else if(action.kind==="nodes")setGhost(Object.fromEntries(action.ids.map(id=>{const old=action.positions[id]??{x:0,y:0};return [id,{x:old.x+dx/action.camera.zoom,y:old.y+dy/action.camera.zoom}];})));
    else {
      const selection={x:Math.min(action.start.x,p.x),y:Math.min(action.start.y,p.y),width:Math.abs(dx),height:Math.abs(dy)};setBox(selection);
      const hits=model.visibleNodes.filter(node=>{const n=positions[node.id]??{x:0,y:0};const x=n.x*model.viewport.zoom+model.viewport.x,y=n.y*model.viewport.zoom+model.viewport.y;return x<selection.x+selection.width&&x+size(node.id).width*model.viewport.zoom>selection.x&&y<selection.y+selection.height&&y+size(node.id).height*model.viewport.zoom>selection.y;}).map(node=>node.id);
      model.setSelected([...new Set([...(action.additive?action.ids:[]),...hits])]);
    }
  };
  const end=()=>{
    const action=gesture.current,version=gestureVersion.current;if(action?.kind==="nodes"){const updates=Object.fromEntries(action.ids.map(id=>[id,positionsRef.current[id]!]));if(action.ids.some(id=>updates[id]?.x!==action.positions[id]?.x||updates[id]?.y!==action.positions[id]?.y))void model.command({kind:"move",positions:updates}).then(()=>{if(gestureVersion.current===version)setGhost({});});else setGhost({});}
    gesture.current=null;setDragging(null);setBox(null);
  };
  const connectNode=(node:IdeaNode)=>{
    if(linkBusy.current)return;
    if(model.visibleNodes.length<2){setInteractionHint(needsTwo("连线"));return;}
    const version=++interactionVersion.current;
    setInteractionHint("");model.setSelected([node.id]);
    if(!linkFrom){setLinkFrom(node.id);setLinkPointer(null);return;}
    if(linkFrom===node.id){setInteractionHint("已选好起点，请点击另一条灵感作为终点。");return;}
    const existing=model.data?.edges.filter(edge=>edge.from===linkFrom&&edge.to===node.id||edge.from===node.id&&edge.to===linkFrom)??[];
    const from=linkFrom;setLinkFrom(null);setLinkPointer(null);linkBusy.current=true;setLinkSaving(true);
    void (async()=>{
      try {
        if(existing.length){for(const edge of existing){if(!await model.command({kind:"disconnect",from:edge.from,to:edge.to}))return;}}
        else if(!await model.command({kind:"connect",from,to:node.id}))return;
        if(interactionVersion.current===version)setInteractionHint(existing.length?"已取消这两条灵感的连线。":"已连接两条灵感。再选这两条可取消连线，Esc 返回选择。");
      } finally {linkBusy.current=false;setLinkSaving(false);}
    })();
  };
  const activateNode=(node:IdeaNode,additive=false)=>{
    if(tool==="pan"||space.current)return;
    if(tool==="link"){connectNode(node);return;}
    interactionVersion.current++;setInteractionHint("");
    model.setSelected(additive||tool==="box"?model.selected.includes(node.id)?model.selected.filter(id=>id!==node.id):[...model.selected,node.id]:[node.id]);setTab("knowledge");
  };
  const nodeDown=(event:ReactPointerEvent<HTMLElement>,node:IdeaNode)=>{
    if(event.button>1)return;event.stopPropagation();
    if(tool==="pan"||space.current||event.button===1){beginGesture(event,"pan");return;}
    if(tool==="box"){beginGesture(event,"box");return;}
    if(tool==="link"){connectNode(node);return;}
    if(event.shiftKey){model.setSelected(model.selected.includes(node.id)?model.selected.filter(id=>id!==node.id):[...model.selected,node.id]);return;}
    const ids=model.selected.includes(node.id)?model.selected:[node.id];model.setSelected(ids);setTab("knowledge");
    beginGesture(event,"nodes",ids);
  };
  const groupSelected=async()=>{
    if(grouping)return;
    if(model.visibleNodes.length<2){chooseTool("select");setInteractionHint(needsTwo("成组"));return;}
    if(model.selected.length<2){chooseTool("box");setInteractionHint("成组需要至少选择 2 条灵感。拖出选框，再点击成组。");return;}
    const nodeIds=[...model.selected],version=++interactionVersion.current;setGrouping(true);
    try{const result=await model.command({kind:"group",id:crypto.randomUUID(),title:"灵感分组",nodeIds});if(result&&interactionVersion.current===version)setInteractionHint(`已将 ${nodeIds.length} 条灵感成组。`);}finally{setGrouping(false);}
  };
  const groups=useMemo(()=>(model.data?.groups??[]).map(group=>{
    const points=group.nodeIds.filter(id=>model.visibleNodes.some(node=>node.id===id)).map(id=>({...positions[id],...size(id)}));
    if(points.length<2)return null;const x=Math.min(...points.map(p=>p.x))-14,y=Math.min(...points.map(p=>p.y))-34;
    return {...group,x,y,width:Math.max(...points.map(p=>p.x+p.width))+14-x,height:Math.max(...points.map(p=>p.y+p.height))+14-y};
  }).filter(group=>group!==null),[model.data,model.visibleNodes,ghost,nodeSizes]);
  if(model.loading)return <div className="loading" role="status">正在读取灵感…</div>;
  if(!model.data)return <div className="workspace-error" role="alert"><p>{model.error??"灵感暂不可用。"}</p><button className="text-button" onClick={()=>void model.refresh()}>重试</button></div>;
  const visible=new Set(model.visibleNodes.map(node=>node.id));
  const activeTool=canvasTools.find(item=>item.id===(temporaryPan?"pan":tool))!;
  const guidance=temporaryPan?"临时平移：按住并拖动画布，松开空格返回原工具。":tool==="link"&&linkSaving?"正在保存连线，请稍候。":interactionHint||(tool==="link"?(model.visibleNodes.length<2?needsTwo("连线"):linkFrom?"起点已选好，请点击另一条灵感作为终点；Esc 取消。":activeTool.hint):activeTool.hint);
  const linkOrigin=linkFrom&&positions[linkFrom]?{x:positions[linkFrom].x+size(linkFrom).width,y:positions[linkFrom].y+size(linkFrom).height/2}:null;
  const linkEnd=linkPointer??(linkOrigin?{x:linkOrigin.x+60,y:linkOrigin.y}:null);
  return <section className="inspiration-page" aria-label="灵感工作区" inert={model.closing} aria-busy={model.closing}>
    <div className="idea-toolbar">
      <div className="idea-search input-surface"><SearchIcon/><input aria-label="搜索灵感" placeholder="搜索灵感…" value={model.query} onChange={event=>model.setQuery(event.target.value)} onKeyDown={event=>{if(event.key==="Enter"&&model.visibleNodes[0]){focusNode(model.visibleNodes[0]);model.setQuery("");}if(event.key==="Escape")model.setQuery("");}}/></div>
      <span className="spacer"/>
      <button className="text-button" onClick={model.fromTask} disabled={!canSaveFromTask||!!model.draft}>从当前任务保存</button>
      <button className={`text-button ${model.archive?"selected":""}`} aria-pressed={model.archive} onClick={()=>{model.setArchive(!model.archive);model.setSelected([]);}}><Archive size={15}/>{model.archive?"返回画布":`已归档 ${model.data.nodes.filter(node=>node.archived).length}`}</button>
      <Menu.Root><Menu.Trigger asChild><button className="primary-button" disabled={!!model.draft}><Plus size={15}/>新建灵感</button></Menu.Trigger><Menu.Portal><Menu.Content className="menu" align="end">{(Object.keys(ideaLabels) as IdeaKind[]).map(kind=>{const Icon=icons[kind];return <Menu.Item key={kind} className="menu-item" onSelect={()=>model.begin(kind)}><Icon size={15}/>{ideaLabels[kind]}</Menu.Item>;})}</Menu.Content></Menu.Portal></Menu.Root>
    </div>
    {(model.error||model.notice)&&<div className={model.error?"inline-error idea-feedback":"idea-feedback"} role={model.error?"alert":"status"}>{model.error??model.notice}{model.error&&<button className="icon-button" aria-label="关闭灵感提示" onClick={model.clearError}><X size={14}/></button>}</div>}
    <div className="idea-layout">
      <div className={`idea-canvas tool-${temporaryPan?"pan":tool}`} data-dragging={dragging??undefined} ref={canvas} tabIndex={0} onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={()=>{gesture.current=null;setDragging(null);setGhost({});setBox(null);}} aria-label="灵感画布">
        <div className="idea-tools" role="toolbar" aria-label="画布工具">
          {canvasTools.map(({id,label,key,hint,Icon})=><button key={id} className="idea-tool-button" aria-label={`${label} ${key}`} aria-description={hint} title={`${label} (${key})：${hint}`} aria-pressed={activeTool.id===id} onClick={()=>chooseTool(id)}><Icon size={18}/><span>{label}</span></button>)}
          <span className="idea-tool-divider"/>
          <button className="idea-tool-button" aria-label="将选中灵感成组" title={model.selected.length<2?"成组：先框选或按住 Shift 选择至少 2 条灵感。":`将选中的 ${model.selected.length} 条灵感成组`} disabled={grouping} onClick={()=>void groupSelected()}><Group size={18}/><span>{grouping?"保存中":"成组"}</span></button>
        </div>
        <div className="idea-tool-guidance" role="status" aria-label="画布操作提示" aria-live="polite"><strong>{activeTool.label}<kbd>{temporaryPan?"Space":activeTool.key}</kbd></strong><span>{guidance}</span></div>
        {model.query&&<div className="idea-search-results">{model.visibleNodes.length?model.visibleNodes.slice(0,8).map(node=><button key={node.id} onClick={()=>{focusNode(node);model.setQuery("");}}>{node.title}</button>):<p>没有找到匹配的灵感。</p>}</div>}
        <div className="idea-world" style={{transform:`translate(${model.viewport.x}px, ${model.viewport.y}px) scale(${model.viewport.zoom})`}}>
          {groups.map(group=><div className="idea-group" key={group.id} style={{left:group.x,top:group.y,width:group.width,height:group.height}}><span>{group.title}</span><button className="icon-button" aria-label={`取消分组 ${group.title}`} onClick={()=>void model.command({kind:"ungroup",id:group.id})}><X size={12}/></button></div>)}
          <svg className="idea-edges" aria-label="灵感连线">{model.data.edges.filter(edge=>visible.has(edge.from)&&visible.has(edge.to)).map(edge=>{const from={...positions[edge.from]!,...size(edge.from)},to={...positions[edge.to]!,...size(edge.to)};return <path key={`${edge.from}-${edge.to}`} d={`M ${from.x+from.width} ${from.y+from.height/2} C ${from.x+from.width+60} ${from.y+from.height/2}, ${to.x-60} ${to.y+to.height/2}, ${to.x} ${to.y+to.height/2}`}/>;})}{tool==="link"&&linkOrigin&&linkEnd&&<path data-connection-preview="true" className="idea-connection-preview" d={`M ${linkOrigin.x} ${linkOrigin.y} C ${linkOrigin.x+60} ${linkOrigin.y}, ${linkEnd.x-60} ${linkEnd.y}, ${linkEnd.x} ${linkEnd.y}`}/>}</svg>
          {model.visibleNodes.map(node=>{const Icon=icons[node.kind],position=positions[node.id]??{x:0,y:0};return <article data-node-id={node.id} data-kind={node.kind} tabIndex={0} role="button" aria-label={`灵感 ${node.title}`} aria-pressed={model.selected.includes(node.id)} className={`idea-node ${model.selected.includes(node.id)?"selected":""}`} key={node.id} style={{left:position.x,top:position.y}} onPointerDown={event=>nodeDown(event,node)} onDoubleClick={()=>{if(tool==="select"&&!space.current)model.edit(node);}} onClick={event=>{if(event.detail===0)activateNode(node,event.shiftKey);}} onKeyDown={event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();activateNode(node,event.shiftKey);}}}>
            <div className="idea-node-title"><Icon size={15}/><strong>{node.title}</strong></div>
            {node.kind==="image"&&model.images[node.id]?<img className="idea-node-image" src={model.images[node.id]} alt={node.title} draggable={false}/>:node.kind==="video"?<div className="idea-node-video"><Video size={25}/><span>{node.media?.name??"视频链接"}</span></div>:<p className="idea-node-summary">{node.markdown||node.url||"添加说明与内容"}</p>}
            <div className="idea-node-meta"><span>{ideaLabels[node.kind]}</span><span>{node.tags.slice(0,2).join(" · ")}</span></div>
          </article>;})}
        </div>
        {!model.visibleNodes.length&&!model.query&&<div className="idea-empty"><Sparkles size={30}/><h2>{model.archive?"没有已归档灵感":"把想法留在这里"}</h2><p>{model.archive?"归档的灵感可以随时恢复。":"保存文字、图片、链接和视频，整理后用于任务。"}</p>{!model.archive&&<button className="primary-button" disabled={!!model.draft} onClick={()=>model.begin("text")}><Plus size={16}/>新建文字灵感</button>}</div>}
        {box&&<div className="idea-selection-box" style={{left:box.x,top:box.y,width:box.width,height:box.height}}/>}
        <div className="idea-zoom"><button className="icon-button" aria-label="缩小画布" onClick={()=>zoom(1/1.2)}><ZoomOut size={16}/></button><output>{Math.round(model.viewport.zoom*100)}%</output><button className="icon-button" aria-label="放大画布" onClick={()=>zoom(1.2)}><ZoomIn size={16}/></button><button className="icon-button" aria-label="适应全部灵感" onClick={fit}><Scan size={16}/></button></div>
        <div className="idea-canvas-status" role="status">{model.selected.length?`已选择 ${model.selected.length} 条`:`${model.visibleNodes.length} 条灵感`}{model.pending?" · 正在保存…":""}</div>
      </div>
      {model.draft?<aside className="idea-inspector" aria-label="编辑灵感"><form className="idea-editor" onSubmit={event=>{event.preventDefault();void model.save();}}>
        <div className="idea-inspector-heading"><strong>{model.draft.expectedNodeRevision?"编辑灵感":"新建灵感"}</strong><span className="spacer"/><small>{model.draftSaving?(model.error?"草稿尚未保留":"保存草稿中…"):"草稿已保留"}</small></div>
        <label>类型<select aria-label="灵感类型" value={model.draft.kind} disabled={model.busy||model.draft.expectedNodeRevision>0} onChange={event=>model.updateDraft({...model.draft!,kind:event.target.value as IdeaKind,mediaPath:undefined})}>{(Object.keys(ideaLabels) as IdeaKind[]).map(kind=><option key={kind} value={kind}>{ideaLabels[kind]}</option>)}</select></label>
        <label>标题<input aria-label="灵感标题" autoFocus required maxLength={200} value={model.draft.title} disabled={model.busy} onChange={event=>model.updateDraft({...model.draft!,title:event.target.value})}/></label>
        {(["link","video"] as IdeaKind[]).includes(model.draft.kind)&&<label>{model.draft.kind==="video"?"视频链接（或添加本地文件）":"链接地址"}<input aria-label="灵感链接" type="url" value={model.draft.url} placeholder="https://" required={model.draft.kind==="link"} maxLength={4096} disabled={model.busy} onChange={event=>model.updateDraft({...model.draft!,url:event.target.value})}/></label>}
        {(["image","video"] as IdeaKind[]).includes(model.draft.kind)&&<label className="idea-file-picker">{model.draft.kind==="image"?"图片文件":"视频文件"}<input ref={mediaInput} hidden aria-label="灵感媒体文件" type="file" accept={model.draft.kind==="image"?"image/png,image/jpeg,image/gif,image/webp":"video/mp4,video/quicktime,video/webm,.m4v"} disabled={model.busy} onChange={event=>{const file=event.target.files?.[0];if(file){const path=pathForFile(file);if(path)model.updateDraft({...model.draft!,mediaPath:path});else model.reportError("无法读取文件路径，请通过文件选择器重新选择。");}event.target.value="";}}/><button type="button" className="folder-picker" disabled={model.busy} onClick={()=>mediaInput.current?.click()}>{model.draft.kind==="image"?"选择图片…":"选择视频…"}</button><span>{model.draft.mediaPath?.split("/").at(-1)??model.data.nodes.find(node=>node.id===model.draft?.id)?.media?.name??"保存后会长期保留媒体副本。"}</span></label>}
        <label>内容<textarea aria-label="灵感内容" rows={10} maxLength={50000} value={model.draft.markdown} disabled={model.busy} onChange={event=>model.updateDraft({...model.draft!,markdown:event.target.value})} placeholder="写下想法，支持 Markdown…"/></label>
        <label>标签<input aria-label="灵感标签" value={model.draft.tags} maxLength={500} disabled={model.busy} onChange={event=>model.updateDraft({...model.draft!,tags:event.target.value})} placeholder="用逗号分隔"/></label>
        {discard?<div className="idea-discard" role="alert"><p>放弃这份未发布的编辑草稿？已保存的灵感保留。</p><button type="button" className="text-button" onClick={()=>setDiscard(false)}>继续编辑</button><button type="button" className="text-button" onClick={()=>{model.updateDraft(null);setDiscard(false);}}>放弃草稿</button></div>:<div className="idea-editor-actions"><button type="button" className="text-button" disabled={model.busy} onClick={()=>setDiscard(true)}>放弃草稿</button><button className="primary-button" disabled={model.busy}>{model.busy?"正在保存…":"保存灵感"}</button></div>}
      </form></aside>:selectedNodes.length>1?<aside className="idea-inspector" aria-label="已选灵感">
        <div className="idea-inspector-heading"><strong>已选择 {selectedNodes.length} 条灵感</strong><button className="icon-button" aria-label="清除灵感选择" onClick={()=>model.setSelected([])}><X size={16}/></button></div>
        <div className="idea-detail-content"><p>切换到选择工具，可拖动这些灵感一起移动；点击成组可整理到同一分组。</p><ul>{selectedNodes.map(node=><li key={node.id}>{node.title}</li>)}</ul></div>
      </aside>:selectedNode?<aside className="idea-inspector" aria-label="灵感详情">
        <div className="idea-inspector-heading"><strong>{selectedNode.title}</strong><button className="icon-button" aria-label="关闭灵感详情" onClick={()=>model.setSelected([])}><X size={16}/></button></div>
        <div className="idea-tabs" role="tablist" aria-label="灵感详情内容">{[["knowledge","内容"],["markdown","Markdown"],["source","来源与引用"]].map(([value,label])=><button key={value} role="tab" aria-selected={tab===value} onClick={()=>setTab(value)}>{label}</button>)}</div>
        <div className="idea-detail-content">{tab==="source"?<><p>第 {selectedNode.revision} 版 · {new Date(selectedNode.updatedAt).toLocaleString("zh-CN")}</p><p>来源：{model.sourceTask(selectedNode)?.title??"在灵感中创建"}</p><h3>任务引用</h3>{model.references(selectedNode).length?model.references(selectedNode).map((ref,index)=><p key={index}>{ref.task?.title??"任务"} · {ref.current?"当前版本":"较早版本"}</p>):<p>尚未引用到任务。</p>}</>:tab==="markdown"?<pre>{selectedNode.markdown||"尚未填写正文。"}</pre>:<>{selectedNode.media&&<button className="idea-media-preview" onClick={()=>void model.preview(selectedNode)}>{selectedNode.kind==="image"&&model.images[selectedNode.id]?<img src={model.images[selectedNode.id]} alt={selectedNode.title}/>:<Video size={30}/>}<span>{selectedNode.kind==="image"?"放大查看图片":"播放本地视频"}</span></button>}{selectedNode.url&&<button className="text-button idea-link" onClick={()=>void model.openLink(selectedNode.url!)}><ArrowUpRight size={15}/>{selectedNode.kind==="video"?"打开视频链接":"打开原始链接"}</button>}<Markdown text={selectedNode.markdown}/>{selectedNode.tags.length>0&&<p className="idea-tags">{selectedNode.tags.join(" · ")}</p>}</>}</div>
        <div className="idea-detail-actions"><button className="text-button" onClick={()=>model.edit(selectedNode)} disabled={model.busy}>编辑</button><button className="text-button" onClick={()=>void model.preview(selectedNode,false)}>查看 Markdown</button><button className="text-button" onClick={()=>void model.command({kind:"archive",nodeId:selectedNode.id,archived:!selectedNode.archived}).then(result=>{if(!result)return;if(selectedNode.archived){model.setArchive(false);model.setSelected([selectedNode.id]);focusNode(selectedNode);}else model.setSelected([]);})}>{selectedNode.archived?"恢复到画布":"归档"}</button></div>
        {!selectedNode.archived&&<div className="idea-reference"><label>引用到任务<select aria-label="灵感引用目标任务" value={model.target?.id??""} disabled={!model.tasks.length||model.busy} onChange={event=>model.setTargetTaskId(event.target.value)}>{!model.tasks.length&&<option value="">暂无任务</option>}{model.tasks.map(task=><option key={task.id} value={task.id}>{task.title}</option>)}</select></label><button className="primary-button" disabled={!model.target||model.busy} onClick={()=>void model.reference(selectedNode)}><Check size={14}/>引用此版本</button><button className="text-button" disabled={model.busy} onClick={()=>void model.newTask(selectedNode)}>创建独立任务并引用</button></div>}
      </aside>:null}
    </div>
  </section>;
}
function SearchIcon(){return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg>;}
