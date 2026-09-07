import { useEffect, useState } from "react";
import { ArrowUp, ArrowDown, Pencil, Pause, Play, X } from "lucide-react";
import { api } from "../../types";
import type { Workbench } from "../../useWorkbench";
import type { CollaborationMessage } from "../../../../../../host/src/collaboration-message.js";
import { Markdown } from "../Markdown";
const states={queued:"待发送",delivering:"正在处理",completed:"已回复",failed:"未完成",paused:"已暂停",cancelled:"已取消",interrupted:"上次执行已中断"};

export function CollaborationFeed({work}:{work:Workbench}) {
  const [pending,setPending]=useState<string|null>(null);
  const [editing,setEditing]=useState<{message:CollaborationMessage;text:string}|null>(null);
  useEffect(()=>{setEditing(null);setPending(null);},[work.session?.id]);
  const messages=(work.snapshot?.collaborationMessages??[]).filter(message=>message.author!=="member" && !(message.author==="coordinator"&&work.snapshot?.agentRuns.some(run=>run.id===message.targetAgentRunId&&run.role==="coordinator")) && (
    message.sourceSessionId===work.session?.id&&message.targetSessionId!==work.session.id
    || message.targetSessionId===work.session?.id&&["queued","paused","failed","interrupted"].includes(message.state)
  ));
  const updates=(work.snapshot?.collaborationMessages??[]).filter(message=>message.targetSessionId===work.session?.id&&message.author!=="user"&&work.snapshot?.agentRuns.some(run=>run.id===message.targetAgentRunId&&run.role==="coordinator")&&["queued","paused","failed","interrupted"].includes(message.state));
  const control=async(message:CollaborationMessage,state:"paused"|"queued"|"cancelled")=>{
    setPending(message.id);
    try{const result=await api().request<{message:CollaborationMessage}>("collaboration.messageControl",{requestId:crypto.randomUUID(),id:message.id,expectedRevision:message.revision,state});await work.reload();return result.message;}
    catch(error){work.fail(error);}finally{setPending(null);}
  };
  const startEdit=async(message:CollaborationMessage)=>{const paused=message.state==="paused"?message:await control(message,"paused");if(paused)setEditing({message:paused,text:paused.text});};
  const saveEdit=async()=>{if(!editing)return;setPending(editing.message.id);try{await api().request("collaboration.messageEdit",{requestId:crypto.randomUUID(),id:editing.message.id,expectedRevision:editing.message.revision,text:editing.text});setEditing(null);await work.reload();}catch(error){work.fail(error);}finally{setPending(null);}};
  const queueFor=(message:CollaborationMessage)=>(work.snapshot?.collaborationMessages??[]).filter(item=>item.targetSessionId===message.targetSessionId&&["queued","paused"].includes(item.state));
  const move=async(message:CollaborationMessage,direction:number)=>{const entries=queueFor(message),index=entries.findIndex(item=>item.id===message.id),next=index+direction;if(index<0||next<0||next>=entries.length)return;[entries[index],entries[next]]=[entries[next]!,entries[index]!];setPending(message.id);try{await api().request("collaboration.queueReorder",{requestId:crypto.randomUUID(),sessionId:message.targetSessionId,expectedQueueRevision:work.snapshot?.collaborationQueues?.find(queue=>queue.sessionId===message.targetSessionId)?.revision??0,messages:entries.map(item=>({id:item.id,revision:item.revision}))});await work.reload();}catch(error){work.fail(error);}finally{setPending(null);}};
  if(!messages.length&&!updates.length)return null;
  return <div className="collaboration-feed" aria-label="成员交流与待发送消息">
    {updates.length>0&&<details className="collaboration-inbox"><summary>待处理的协作更新 · {updates.length}</summary><p className="secondary">可继续处理或取消这次更新。成员的成果和原始记录仍会保留。</p>{updates.map(message=>{const source=work.snapshot?.sessions.find(session=>session.id===message.sourceSessionId);return <section className="collaboration-inbox-item" key={message.id}><div className="collaboration-heading"><strong>{source&&source.id!==work.session?.id?`${source.title}的更新`:"成员要求更新"}</strong><span className="secondary">{states[message.state]}</span>{["queued","paused"].includes(message.state)&&<button className="text-button" disabled={pending===message.id} onClick={()=>void control(message,message.state==="paused"?"queued":"paused")}>{message.state==="paused"?"继续处理":"暂停处理"}</button>}<button className="icon-button" disabled={pending===message.id} aria-label="取消协作更新" onClick={()=>void control(message,"cancelled")}><X size={13}/></button></div><details><summary>查看更新内容</summary><div className="user-text">{message.text}</div></details>{message.error&&<p className="inline-error">{message.error}</p>}</section>;})}</details>}
    {messages.map(message=>{
    const target=work.snapshot?.sessions.find(session=>session.id===message.targetSessionId);
    const queue=queueFor(message),position=queue.findIndex(item=>item.id===message.id);
    return <section key={message.id} className="collaboration-exchange">
      <div className="collaboration-heading"><button className="text-button" onClick={()=>{if(work.task)work.select(work.task,message.targetSessionId);}}>{message.author==="user"?"你 → ":"交办 → "}{target?.title??"成员"}</button><span className="secondary">{message.state==="queued"&&message.waitingFor?message.waitingFor==="capacity"?"等待运行名额":"等待目录可写":states[message.state]}</span>
      {(["queued","paused","failed","interrupted"] as string[]).includes(message.state)&&<>{["queued","paused"].includes(message.state)&&<button className="icon-button" disabled={pending===message.id} aria-label={message.state==="queued"?"暂停消息":"继续发送"} onClick={()=>void control(message,message.state==="queued"?"paused":"queued")}>{message.state==="queued"?<Pause size={13}/>:<Play size={13}/>}</button>}<button className="icon-button" disabled={pending===message.id} aria-label="取消消息" onClick={()=>void control(message,"cancelled")}><X size={13}/></button></>}
      {["queued","paused"].includes(message.state)&&<><button className="icon-button" disabled={!!pending} aria-label="编辑待发送消息" onClick={()=>void startEdit(message)}><Pencil size={13}/></button><button className="icon-button" disabled={!!pending||position<=0} aria-label="提前发送" onClick={()=>void move(message,-1)}><ArrowUp size={13}/></button><button className="icon-button" disabled={!!pending||position===queue.length-1} aria-label="延后发送" onClick={()=>void move(message,1)}><ArrowDown size={13}/></button></>}
      </div>
      {editing?.message.id===message.id?<div className="queued-message-editor"><textarea aria-label="修改待发送消息" value={editing.text} onChange={event=>setEditing({...editing,text:event.target.value})}/><div className="form-actions"><button className="text-button" disabled={!!pending} onClick={()=>setEditing(null)}>取消编辑</button><button className="primary-button" disabled={!!pending||!editing.text.trim()} onClick={()=>void saveEdit()}>保存，保持暂停</button></div></div>:<div className="user-text">{message.text}</div>}
      {message.previousRawInputId&&<span className="secondary">发送前已修改，原文仍保留在记录中</span>}
      {message.error&&<p className="inline-error">{message.error}</p>}
      {message.reply&&<article className="message assistant" aria-label={`${target?.title??"成员"}的回复`}><strong className="message-attribution">{target?.title??"成员"}</strong><Markdown text={message.reply}/></article>}
    </section>;
  })}</div>;
}
