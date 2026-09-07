import {useEffect,useState} from 'react';
import {api} from '../types';
import type {Workbench} from '../useWorkbench';
export function ExtensionRequests({work}:{work:Workbench}){
  const dialogs=(work.snapshot?.runtimeDialogs??[]).filter(dialog=>dialog.taskId===work.task?.id);
  const [values,setValues]=useState<Record<string,string>>({}),[pending,setPending]=useState<string|null>(null),[expanded,setExpanded]=useState<Record<string,boolean>>({});
  useEffect(()=>{const ids=new Set(dialogs.map(dialog=>dialog.requestId));setValues(previous=>Object.fromEntries(Object.entries(previous).filter(([id])=>ids.has(id))));},[dialogs.map(dialog=>dialog.requestId).join(':')]);
  if(!dialogs.length&&!work.notice)return null;
  const respond=async(dialog:typeof dialogs[number],response:Record<string,unknown>)=>{setPending(dialog.requestId);try{await api().request('extension.respond',{runtimeId:dialog.runtimeId,requestId:dialog.requestId,response});await work.reload();}catch(error){work.fail(error);}finally{setPending(null);}};
  return <div className="extension-requests" aria-label="等待处理的扩展请求">{work.notice&&<div className="runtime-notice" role="status"><span>{work.notice}</span><button className="text-button" onClick={work.dismissNotice}>关闭</button></div>}{dialogs.map(dialog=>{
    const owner=work.snapshot?.sessions.find(session=>session.id===dialog.sessionId);const open=expanded[dialog.requestId]??dialog.sessionId===work.session?.id;
    const value=values[dialog.requestId]??dialog.prefill??'';
    return <section className="extension-request" key={dialog.requestId}><button className="section-toggle" aria-expanded={open} onClick={()=>setExpanded(previous=>({...previous,[dialog.requestId]:!open}))}>{owner?.kind==='coordination'?'当前任务':owner?.title??'成员'} · {dialog.title}</button>{open&&<div className="extension-request-body">
      {dialog.message&&<p>{dialog.message}</p>}
      {dialog.method==='select'&&<select aria-label={dialog.title} value={value} disabled={!!pending||work.hostDead} onChange={event=>setValues(previous=>({...previous,[dialog.requestId]:event.target.value}))}><option value="" disabled>请选择</option>{dialog.options?.map((option,index)=><option key={index} value={option}>{option}</option>)}</select>}
      {(dialog.method==='input'||dialog.method==='editor')&&<textarea rows={dialog.method==='editor'?6:2} aria-label={dialog.title} placeholder={dialog.placeholder} value={value} maxLength={200000} disabled={!!pending||work.hostDead} onChange={event=>setValues(previous=>({...previous,[dialog.requestId]:event.target.value}))}/>}
      <div className="form-actions"><button className="text-button" disabled={!!pending||work.hostDead} onClick={()=>void respond(dialog,{cancelled:true})}>取消</button><button className="primary-button" disabled={!!pending||work.hostDead||dialog.method==='select'&&!dialog.options?.includes(value)} onClick={()=>void respond(dialog,dialog.method==='confirm'?{confirmed:true}:{value})}>{pending===dialog.requestId?'提交中…':'确认'}</button></div>
    </div>}</section>;
  })}</div>;
}
