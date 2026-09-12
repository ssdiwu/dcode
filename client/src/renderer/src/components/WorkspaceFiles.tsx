import {motion, LayoutGroup} from "motion/react";
import {uiMotion, useMotionReduction} from "../workbench/motion";
import {diffLines} from "../workbench/git-diff";
import {useEffect,useRef,useState,useId} from "react";
import {ChevronRight,FileText,Folder,GitBranch,RefreshCw,Save,X,Quote,Code,Eye} from "lucide-react";
import type {WorkspaceSource,GitFile} from "../../../../../host/src/workspace-access.js";
import type {WorkspaceTree} from "../../../../../host/src/workspace-files.js";
import {api,errorText} from "../types";
import {FileReferenceContext,fileDirty,type FileTab,type WorkspaceFileModel} from "../workbench/useWorkspaceFiles";
import {Markdown} from "./Markdown";
import type {Workbench} from "../useWorkbench";

function Tree({source,path="",onOpen}:{source:WorkspaceSource;path?:string;onOpen:(path:string)=>void}){
  const [tree,setTree]=useState<WorkspaceTree|null>(null),[error,setError]=useState("");const [expanded,setExpanded]=useState<string[]>([]);
  useEffect(()=>{let alive=true;setTree(null);setError("");void api().request<WorkspaceTree>("workspace.tree",{source,path}).then(value=>{if(alive)setTree(value);}).catch(error=>{if(alive)setError(errorText(error));});return()=>{alive=false;};},[JSON.stringify(source),path]);
  return <ul className="file-tree">{error&&<li role="alert">{error}</li>}{!tree&&!error&&<li className="secondary">正在读取…</li>}{tree?.entries.map(entry=><li key={entry.relativePath}>
    <button className="file-tree-row" disabled={entry.kind==="link"||entry.kind==="other"} title={entry.kind==="link"?"符号链接不进入项目预览":entry.name} onClick={()=>entry.kind==="directory"?setExpanded(values=>values.includes(entry.relativePath)?values.filter(value=>value!==entry.relativePath):[...values,entry.relativePath]):onOpen(entry.relativePath)}>
      {entry.kind==="directory"?<><ChevronRight size={12} className={expanded.includes(entry.relativePath)?"expanded":""}/><Folder size={13}/></>:<FileText size={13}/>}<span>{entry.name}</span>
    </button>{entry.kind==="directory"&&expanded.includes(entry.relativePath)&&<Tree source={source} path={entry.relativePath} onOpen={onOpen}/>}
  </li>)}{tree?.truncated&&<li className="secondary">当前目录仅显示前 1000 项。</li>}</ul>;
}
function HTMLBufferPreview({tab,visible}:{tab:FileTab;visible:boolean}){
  const box=useRef<HTMLDivElement>(null);const clientId=useRef(crypto.randomUUID());const identity=useRef("");
  const [state,setState]=useState<{id:string;network:boolean;blocked:boolean}|null>(null);const [error,setError]=useState("");
  const text=tab.draft??tab.document!.text;
  useEffect(()=>{let alive=true;const timer=setTimeout(()=>{
    const bounds=box.current?.getBoundingClientRect();if(!bounds)return;
    void api().htmlPreview({action:"update",clientId:clientId.current,source:tab.source,path:tab.path,root:tab.document!.root,text,bounds:{x:bounds.x,y:bounds.y,width:visible?bounds.width:0,height:visible?bounds.height:0}}).then(value=>{if(alive){const next=value as NonNullable<typeof state>;if(next.id){identity.current=next.id;setState(next);setError("");}}}).catch(error=>{if(alive)setError(errorText(error));});
  },400);return()=>{alive=false;clearTimeout(timer);};},[text,visible,tab.id,tab.document?.root]);
  useEffect(()=>{
    const observe=()=>{const bounds=box.current?.getBoundingClientRect();if(bounds)void api().htmlPreview({action:"bounds",clientId:clientId.current,bounds:{x:bounds.x,y:bounds.y,width:visible?bounds.width:0,height:visible?bounds.height:0}}).catch(()=>{});};
    const observer=new ResizeObserver(observe);if(box.current)observer.observe(box.current);window.addEventListener("resize",observe);observe();
    return()=>{observer.disconnect();window.removeEventListener("resize",observe);};
  },[visible]);
  useEffect(()=>api().subscribe(event=>{if(["preview.blocked","preview.navigationBlocked"].includes(event.event)&&(event.data as {id?:string})?.id===identity.current)setState(previous=>previous?{...previous,blocked:true}:previous);}),[]);
  useEffect(()=>()=>{void api().htmlPreview({action:"close",clientId:clientId.current}).catch(()=>{});},[]);
  const network=async()=>{if(!state)return;try{await api().htmlPreview({action:"network",id:state.id,allow:!state.network});setState({...state,network:!state.network,blocked:false});}catch(error){setError(errorText(error));}};
  return <section className="html-preview"><div className="preview-toolbar"><span>预览随编辑更新</span><span className="secondary">联网资源：{state?.network?"本次允许":"已阻止"}</span><button className="text-button" disabled={!state} onClick={()=>void network()}>{state?.network?"恢复阻止":"本次允许"}</button></div>{state?.blocked&&<p className="secondary">页面跳转或联网请求已被阻止。</p>}{error&&<p role="alert" className="inline-error">{error}</p>}<div className="html-preview-surface" ref={box}/></section>;
}
function FileBody({tab,model,overlay}:{tab:FileTab;model:WorkspaceFileModel;overlay:boolean}){
  const editor=useRef<HTMLTextAreaElement>(null);const [lineText,setLineText]=useState(String(tab.line??1));const body=tab.draft??tab.document?.text??"";const count=body.split("\n").length;
  useEffect(()=>setLineText(String(tab.line??1)),[tab.line]);
  useEffect(()=>{if(!tab.line||!editor.current)return;const lines=editor.current.value.split("\n");if(tab.line>lines.length)return;const offset=lines.slice(0,tab.line-1).reduce((sum,line)=>sum+line.length+1,0);editor.current.setSelectionRange(offset,offset+(lines[tab.line-1]?.length??0));editor.current.scrollTop=(tab.line-1)*20;},[tab.line,tab.mode,tab.document]);
  if(tab.loading)return <p className="loading">正在读取文件…</p>;
  if(!tab.document)return <div className="inline-error" role="alert">{tab.error??"文件不可用"}<button onClick={()=>void model.reload(tab)}>重试</button></div>;
  const html=tab.document.kind==="html",editing=html||tab.mode==="edit";
  return <div className="file-content">
    <div className="file-toolbar"><span className="file-path" title={tab.document.absolutePath}>{tab.path}</span>{fileDirty(tab)&&<span className="secondary">未保存</span>}<span className="spacer"/>
      {tab.document.kind!=="image"&&<label className="file-line-input">行<input aria-label="跳转到文件行" inputMode="numeric" value={lineText} onChange={event=>setLineText(event.target.value)} onKeyDown={event=>{if(event.key==="Enter"){const line=Number(lineText);if(Number.isSafeInteger(line)&&line>0)model.patch(tab.id,{line,mode:html?"edit":"source"});}}}/></label>}
      {tab.document.kind!=="image"&&<button className="icon-button" aria-label="引用当前行" onClick={()=>model.quote(tab,editor.current?editor.current.value.slice(0,editor.current.selectionStart).split("\n").length:tab.line)}><Quote size={14}/></button>}
      {tab.document.kind==="markdown"&&<button className="icon-button" aria-label={tab.mode==="preview"?"查看文件原文":"预览文件"} onClick={()=>model.patch(tab.id,{mode:tab.mode==="preview"?"source":"preview"})}>{tab.mode==="preview"?<Code size={14}/>:<Eye size={14}/>}</button>}
      {tab.document.editable&&!html&&tab.mode!=="edit"&&<button className="text-button" onClick={()=>model.patch(tab.id,{mode:"edit",draft:tab.draft??tab.document!.text})}>编辑</button>}
      {tab.draft!==undefined&&<button className="text-button" disabled={tab.saving||!fileDirty(tab)} onClick={()=>void model.save(tab.id)}><Save size={13}/>{tab.saving?"保存中…":"保存"}</button>}
    </div>
    {tab.line&&tab.line>count&&<p role="status" className="inline-error">请求第 {tab.line} 行，当前文件只有 {count} 行。</p>}
    {tab.error&&<div role="alert" className="inline-error">{tab.error}{tab.conflict&&<div className="dialog-actions"><button className="text-button" onClick={()=>void model.reload(tab)}>重新加载磁盘内容</button><button className="text-button" onClick={()=>model.patch(tab.id,{error:undefined})}>继续编辑</button><button className="text-button" onClick={()=>void model.save(tab.id,true)}>用当前编辑覆盖</button></div>}</div>}
    <div className={html?"html-split":"file-document"}>
      {tab.document.kind==="image"?<div className="file-image"><img src={tab.document.dataUrl} alt={tab.path}/></div>:tab.mode==="preview"&&tab.document.kind==="markdown"?<FileReferenceContext.Provider value={reference=>model.openRelative(tab,reference)}><div className="file-markdown"><Markdown text={body}/></div></FileReferenceContext.Provider>:<textarea className="file-editor" ref={editor} aria-label={editing?"文件编辑内容":"文件原文"} readOnly={!editing||tab.saving} spellCheck={false} value={body} onChange={event=>model.patch(tab.id,{draft:event.target.value})} onKeyDown={event=>{if(editing&&(event.metaKey||event.ctrlKey)&&event.key==="s"){event.preventDefault();void model.save(tab.id);}}}/>}
      {html&&<HTMLBufferPreview key={tab.id} tab={tab} visible={!overlay}/>}
    </div>
  </div>;
}
export function WorkspaceFileNavigation({model}:{model:WorkspaceFileModel}){
  const [revision,setRevision]=useState(0),[git,setGit]=useState<{repository:boolean;branch:string|null;files:GitFile[];hiddenCount?:number;truncated?:boolean}|null>(null),[error,setError]=useState("");
  const [info,setInfo]=useState<{root:string;title:string}|null>(null);
  useEffect(()=>{let alive=true;setInfo(null);setError("");if(model.source)void api().request<NonNullable<typeof info>>("workspace.describe",{source:model.source}).then(value=>{if(alive)setInfo(value);}).catch(error=>{if(alive)setError(errorText(error));});return()=>{alive=false;};},[model.scope,revision]);
  useEffect(()=>{let alive=true;setGit(null);if(model.navigationView==="git"&&model.source)void api().request<NonNullable<typeof git>>("workspace.git",{source:model.source}).then(value=>{if(alive)setGit(value);}).catch(error=>{if(alive)setError(errorText(error));});return()=>{alive=false;};},[model.navigationView,model.scope,revision]);
  return <section className="file-navigation" aria-label="项目文件导航">
    <div className="file-navigation-heading"><button className="text-button" onClick={model.returnToTasks}>返回任务</button><strong title={info?.root}>{model.source?model.sourceTitle(model.source):"文件"}</strong></div>
    <div className="file-navigation-toolbar"><button className="icon-button" aria-label="项目文件" aria-pressed={model.navigationView==="files"} onClick={()=>{setError("");model.setNavigationView("files");}}><Folder size={15}/></button><button className="icon-button" aria-label="Git 改动" aria-pressed={model.navigationView==="git"} onClick={()=>{setError("");model.setNavigationView("git");}}><GitBranch size={15}/></button><span className="spacer"/><button className="icon-button" aria-label="刷新文件与改动" onClick={()=>setRevision(value=>value+1)}><RefreshCw size={13}/></button></div>
    {model.navigationPath&&<p className="file-navigation-path" title={model.navigationPath}>{model.navigationPath}</p>}
    {error&&<p className="inline-error" role="alert">{error}</p>}
    {info&&model.source&&model.navigationView==="files"&&<Tree key={`${model.scope}:${model.navigationPath}:${revision}`} source={model.source} path={model.navigationPath} onOpen={path=>model.open(path)}/>}
    {info&&model.navigationView==="git"&&<div className="git-files">{git?.repository?<><p className="secondary">{git.branch??"当前分支"}</p>{git.files.map(file=><button className="file-tree-row" key={file.path} onClick={()=>model.openDiff(file.path,model.source,file.status[1]===" "&&file.status[0]!==" ")}><span className="git-state">{file.status}</span><span>{file.path}</span></button>)}{!!git.hiddenCount&&<p className="secondary">有 {git.hiddenCount} 个受限路径未显示。</p>}{git.truncated&&<p className="secondary">仅显示前 1000 项改动。</p>}{git.files.length===0&&<p className="secondary">没有可显示的改动。</p>}</>:<p className="secondary">{git?"当前目录没有可用的 Git 仓库。":"正在读取改动…"}</p>}</div>}
  </section>;
}
function DiffBody({tab,model,work}:{tab:FileTab;model:WorkspaceFileModel;work:Workbench}){
  if(tab.loading)return <p className="loading">正在读取差异…</p>;
  const diff=tab.diff;
  if(!diff)return <p role="alert" className="inline-error">{tab.error??"差异不可用"}<button className="text-button" onClick={()=>void model.reload(tab)}>重试</button></p>;
  const quote=(body:string)=>work.updateDraft(work.draftKey,previous=>({...previous,text:`${previous.text}${previous.text?"\n\n":""}[${tab.path}](<${encodeURI(diff.absolutePath)}>)（${tab.staged?"暂存差异":"工作区差异"}）\n差异版本：${diff.digest}\n\`\`\`diff\n${body}\n\`\`\`\n`}));
  return <><div className="file-toolbar"><strong>{tab.path}</strong><button className="text-button" onClick={()=>model.openDiff(tab.path,tab.source,!tab.staged)}>{tab.staged?"查看工作区改动":"查看暂存改动"}</button><button className="text-button" onClick={()=>model.open(tab.path,tab.source)}>打开文件</button><button className="text-button" onClick={()=>quote(diff.diff.slice(0,12000)+(diff.diff.length>12000?"\n（差异较长，仅引用开头部分）":""))}>引用差异</button><button className="icon-button" aria-label="刷新差异" onClick={()=>void model.reload(tab)}><RefreshCw size={13}/></button></div>{tab.error&&<p role="alert">{tab.error}</p>}<div className="git-diff" aria-label="文件差异">{diff.diff?diffLines(diff.diff).map((line,index)=><button key={index} className={`diff-line ${line.kind}`} disabled={line.kind==="header"} aria-label={line.kind==="header"?undefined:`引用差异${line.kind==="remove"?"旧":"新"}侧第 ${line.newLine??line.oldLine} 行`} onClick={()=>quote(`${line.newLine!==undefined?`新侧第 ${line.newLine} 行`:`旧侧第 ${line.oldLine} 行`}\n${line.hunk}\n${line.text}`)}><span className="diff-number">{line.oldLine??""}</span><span className="diff-number">{line.newLine??""}</span><span>{line.text}</span></button>):"这一侧没有改动。"}</div></>;
}
export function WorkspaceFiles({model,work,overlay=false}:{model:WorkspaceFileModel;work:Workbench;overlay?:boolean}){
  const stripId=useId(),reduced=useMotionReduction();
  const strip=useRef<HTMLDivElement>(null);
  useEffect(()=>{strip.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({block:"nearest",inline:"nearest"});},[model.active?.id,model.visible]);
  return <section className="files-workspace" aria-label="文件内容">
    {model.tabs.length>0&&<LayoutGroup id={stripId}><div ref={strip} className="file-tab-strip" role="tablist" aria-label="工作区标签">{model.tabs.map(tab=><div className="file-tab" key={tab.id}><button role="tab" title={`${model.sourceTitle(tab.source)} · ${tab.document?.absolutePath??tab.diff?.absolutePath??tab.path}`} aria-label={`${tab.path} · ${model.sourceTitle(tab.source)}${tab.kind==="diff"?tab.staged?" · 暂存差异":" · 工作区差异":""}`} aria-selected={model.active?.id===tab.id} onClick={()=>model.select(tab.id)}>{model.active?.id===tab.id&&<motion.span className="file-tab-highlight" layoutId="selected-file" initial={false} transition={{duration:reduced?0:uiMotion.settle,ease:uiMotion.inertia}} aria-hidden="true"/>}{tab.path.split("/").at(-1)}{model.tabs.some(other=>other.id!==tab.id&&other.path.split("/").at(-1)===tab.path.split("/").at(-1)&&model.sourceTitle(other.source)!==model.sourceTitle(tab.source))?` · ${model.sourceTitle(tab.source)}`:""}{tab.kind==="diff"?" · 差异":""}{fileDirty(tab)?" ·":""}</button><button className="icon-button" aria-label={`关闭文件 ${tab.path} · ${model.sourceTitle(tab.source)}`} title={`关闭 ${model.sourceTitle(tab.source)} · ${tab.path}`} onClick={()=>model.close(tab.id)}><X size={12}/></button></div>)}</div></LayoutGroup>}
    {model.notice&&<p className="inline-error" role="alert">{model.notice}</p>}
    {model.active&&<div className="file-origin" title={model.active.document?.absolutePath??model.active.diff?.absolutePath}>{model.sourceTitle(model.active.source)} · {model.active.path}</div>}
    <div className="file-main">{model.active?model.active.kind==="diff"?<DiffBody tab={model.active} model={model} work={work}/>:<FileBody key={model.active.id} tab={model.active} model={model} overlay={overlay||!model.visible||!!model.closing}/>:<p className="files-empty secondary">选择项目文件或 Git 改动。</p>}</div>
  </section>;
}
export function FileCloseDialog({model}:{model:WorkspaceFileModel}){
  const tab=model.closing;if(!tab)return null;
  return <div className="overlay" role="presentation"><section className="dialog" role="dialog" aria-modal="true" aria-label="文件有未保存修改"><h2>{tab.path} 有未保存修改</h2><p className="source-path">{tab.document?.absolutePath??tab.path}</p><p>关闭前保存，或保留编辑内容继续处理。</p>{tab.error&&<p role="alert" className="inline-error">{tab.error}</p>}<div className="dialog-actions"><button className="text-button" disabled={tab.saving} onClick={model.keep}>继续编辑</button><button className="text-button" disabled={tab.saving} onClick={()=>model.discard(tab.id)}>放弃更改</button><button className="primary-button" disabled={tab.saving} onClick={()=>void model.saveAndClose(tab.id)}>{tab.saving?"保存中…":"保存并关闭"}</button></div></section></div>;
}
