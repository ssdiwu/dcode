import { uiText } from "../../../shared/ui-language.ts";
import { useEffect, useRef, useState } from "react";
import type { Workbench } from "../useWorkbench";
import { api, errorText, type TaskGoalRevisionRecord, type TaskRecord } from "../types";

const lines = (value: string): string[] => value.split("\n").map(item=>item.trim()).filter(Boolean);

/** Task-owned result and acceptance. The Composer message remains its own raw input. */
export function TaskGoalEditor({work,onClose}:{work:Workbench;onClose:()=>void}) {
  const task=work.task;
  const readOnly=!!task&&!(["draft","active","waiting"] as string[]).includes(task.state);
  const stateLabel=task?.state==="completed"?uiText("已完成"):task?.state==="rejected"?uiText("未通过"):task?.state==="archived"?uiText("已归档"):uiText("当前状态");
  const [goal,setGoal]=useState(task?.goal??work.draft.goal??"");
  const [acceptanceText,setAcceptanceText]=useState((task?.acceptance??work.draft.acceptance??[]).join("\n"));
  const [history,setHistory]=useState<TaskGoalRevisionRecord[]|null>(null);
  const [loading,setLoading]=useState(!!task);
  const [busy,setBusy]=useState(false);
  const busyRef=useRef(false);
  const [savedRemotely,setSavedRemotely]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const initialDraft=useRef({goal:work.draft.goal,acceptance:work.draft.acceptance});
  const openedTaskRevision=useRef(task?.revision);
  const goalInput=useRef<HTMLTextAreaElement>(null);
  useEffect(()=>{const timer=setTimeout(()=>goalInput.current?.focus(),0);return()=>clearTimeout(timer);},[]);
  useEffect(()=>{
    if(!task)return;
    let alive=true;
    setLoading(true);setHistory(null);
    api().request<TaskGoalRevisionRecord[]>("task.goal.history",{taskId:task.id}).then(value=>{if(alive)setHistory(value);}).catch(reason=>{if(alive)setError(errorText(reason));}).finally(()=>{if(alive)setLoading(false);});
    return()=>{alive=false;};
  },[task?.id,task?.revision]);
  useEffect(()=>{
    if(task&&task.revision!==openedTaskRevision.current)
      setError(uiText("任务已在别处更新。当前编辑仍保留在这里；请核对最新目标后再修订。"));
  },[task?.revision]);
  const changeGoal=(value:string)=>{
    if(busyRef.current||savedRemotely||readOnly)return;
    setGoal(value);
    if(!task)work.updateDraft(work.draftKey,previous=>({...previous,goal:value}));
  };
  const changeAcceptance=(value:string)=>{
    if(busyRef.current||savedRemotely||readOnly)return;
    setAcceptanceText(value);
    if(!task)work.updateDraft(work.draftKey,previous=>({...previous,acceptance:lines(value)}));
  };
  const save=async()=>{
    if(busyRef.current||savedRemotely)return;
    if(readOnly){setError(uiText("当前任务目标仅可查看，不能修订。"));return;}
    if(task&&task.revision!==openedTaskRevision.current){setError(uiText("任务已在别处更新。当前编辑仍保留在这里；请核对最新目标后再修订。"));return;}
    if(!goal.trim()&&task){setError(uiText("目标需说明这项任务要达到的结果。"));goalInput.current?.focus();return;}
    if(lines(acceptanceText).length>100){setError(uiText("验收条件最多填写 100 条。"));return;}
    if(lines(acceptanceText).some(item=>item.length>2_000)){setError(uiText("每条验收条件最多 2000 字。"));return;}
    busyRef.current=true;setBusy(true);setError(null);
    try {
      if(task){
        await work.mutateStore<{task:TaskRecord}>("task.goal.update",{
          taskId:task.id,scope:task.scope,expectedTaskRevision:openedTaskRevision.current,
          goal:goal.trim(),acceptance:lines(acceptanceText),
        });
        setSavedRemotely(true);
        try{await work.reloadConfirmed();onClose();}
        catch(reason){setError(uiText("目标已保存，但界面刷新失败：{0}。请重新读取，勿重复保存。", [errorText(reason)]));}
      }else{
        work.updateDraft(work.draftKey,previous=>({...previous,goal:goal.trim(),acceptance:lines(acceptanceText)}));
        await work.flushDrafts();
        onClose();
      }
    }catch(reason){setError(errorText(reason));}
    finally{busyRef.current=false;setBusy(false);}
  };
  const retryReload=async()=>{
    if(busyRef.current||!savedRemotely)return;
    busyRef.current=true;setBusy(true);setError(null);
    try{await work.reloadConfirmed();onClose();}
    catch(reason){setError(uiText("目标已保存，但界面仍未刷新：{0}。请稍后重新读取。", [errorText(reason)]));}
    finally{busyRef.current=false;setBusy(false);}
  };
  const cancel=async()=>{
    if(busyRef.current||savedRemotely)return;
    if(task){onClose();return;}
    busyRef.current=true;setBusy(true);setError(null);
    try {
      work.updateDraft(work.draftKey,previous=>({...previous,goal:initialDraft.current.goal,acceptance:initialDraft.current.acceptance}));
      await work.flushDrafts();
      onClose();
    }catch(reason){setError(errorText(reason));}
    finally{busyRef.current=false;setBusy(false);}
  };
  const route=task&&work.snapshot?.taskPlans.find(item=>item.taskId===task.id&&item.state==="active"&&item.routeContextCurrent!==undefined);
  return <section className="task-goal-editor" aria-label={uiText("任务目标")}>
    <div className="task-goal-heading"><div><strong>{task?uiText("任务目标"):uiText("新任务目标")}</strong><p className="secondary">{readOnly?uiText("任务{0}，目标和历史版本可查看，当前不能修订。", [stateLabel]):task?uiText("修订后保留旧版本，后续路线需要重新核对。"):uiText("填写时暂存，首次发送时采用；消息原文仍按输入内容保存。")}</p></div><button type="button" className="text-button" onClick={onClose} disabled={busy}>{uiText("收起")}</button></div>
    {error&&<p className="inline-error" role="alert">{error}</p>}
    <label>{uiText("短期结果")}<textarea ref={goalInput} value={goal} maxLength={4000} readOnly={readOnly||busy||savedRemotely} onChange={event=>changeGoal(event.target.value)} placeholder={uiText("这项任务完成时要得到什么？")} /></label>
    <label>{uiText("验收目的 ")}<span className="secondary">{uiText("每行一条")}</span><textarea value={acceptanceText} readOnly={readOnly||busy||savedRemotely} onChange={event=>changeAcceptance(event.target.value)} placeholder={uiText("怎样判断结果可接受？")} /></label>
    {route&&route.routeContextCurrent===false&&<p className="secondary" role="status">{uiText("当前路线依据已变化，后续执行前需重新核对。")}</p>}
    {task&&<details><summary>{uiText("查看目标版本")}{history?`（${history.length}）`:""}</summary>{loading?<p className="secondary">{uiText("正在读取版本…")}</p>:history?.length?<ol>{history.map((item,index)=><li key={`${item.taskRevision}:${index}`}><strong>{uiText("第 ")}{index+1} {uiText(" 版")}</strong><small className="secondary"> · {new Date(item.changedAt).toLocaleString()}</small><p>{item.goal}</p>{item.acceptance.length>0&&<p className="secondary">{uiText("验收：")}{item.acceptance.join("；")}</p>}</li>)}</ol>:<p className="secondary">{uiText("暂无可读版本。")}</p>}</details>}
    {!readOnly&&<div className="task-goal-actions"><button type="button" className="text-button" onClick={()=>void cancel()} disabled={busy||savedRemotely}>{uiText("取消本次编辑")}</button>{savedRemotely?<button type="button" onClick={()=>void retryReload()} disabled={busy}>{busy?uiText("读取中…"):uiText("重新读取已保存目标")}</button>:<button type="button" onClick={()=>void save()} disabled={busy||!!task&&(task.revision!==openedTaskRevision.current||goal.trim()===task.goal&&acceptanceText===task.acceptance.join("\n"))}>{busy?uiText("保存中…"):task?uiText("保存修订"):uiText("保存到草稿")}</button>}</div>}
  </section>;
}
