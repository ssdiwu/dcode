import { uiText, localizeUi } from "../../../shared/ui-language.ts";
import {useEffect,useMemo,useRef,useState} from "react";
import type {Workbench} from "../useWorkbench";
import {errorText,type TaskWorkflowRecord,type TaskWorkflowRunRecord} from "../types";

const statusLabel:Record<TaskWorkflowRunRecord["status"],string>=localizeUi({active:"进行中",stopped:"已停止后续推进",interrupted:"中断待核对",completed:"已完成"});
const agentStatusLabel:Record<string,string>=localizeUi({prepared:"待开始",running:"运行中",waiting:"等待处理",completed:"已完成",failed:"失败",aborted:"已停止",interrupted:"已中断",unknown:"待核对"});
const lines=(value:string)=>value.split("\n").map(item=>item.trim()).filter(Boolean);

export function TaskWorkflowPanel({work,onClose,onSubmissionState}:{work:Workbench;onClose:()=>void;onSubmissionState?:(active:boolean,promptId?:string)=>void}){
  const panelRef=useRef<HTMLElement>(null);
  const firstInputRef=useRef<HTMLTextAreaElement>(null);
  const task=work.task,snapshot=work.snapshot;
  const workflows=(snapshot?.taskWorkflows??[]).filter(item=>item.taskId===task?.id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  const [selectedId,setSelectedId]=useState<string|undefined>();
  const activeRun=(snapshot?.taskWorkflowRuns??[]).find(item=>item.taskId===task?.id&&item.status==="active");
  const selected=workflows.find(item=>item.id===selectedId)??workflows.find(item=>item.id===activeRun?.workflowId)??workflows[0];
  const run=selected?(snapshot?.taskWorkflowRuns??[]).filter(item=>item.workflowId===selected.id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0]:undefined;
  const shownVersion=run?.version??selected?.currentVersion;
  const version=selected?snapshot?.taskWorkflowVersions.find(item=>item.workflowId===selected.id&&item.version===shownVersion):undefined;
  const stages=selected?(snapshot?.taskWorkflowStages??[]).filter(item=>item.workflowId===selected.id&&item.version===shownVersion).sort((a,b)=>a.ordinal-b.ordinal):[];
  const [creating,setCreating]=useState(!selected);
  useEffect(()=>{if(creating)firstInputRef.current?.focus();else panelRef.current?.focus();},[creating]);
  const [goal,setGoal]=useState(work.draft.pendingWorkflowSubmission?.kind==="create"?work.draft.pendingWorkflowSubmission.goal??"":"");
  const [constraintsText,setConstraintsText]=useState(work.draft.pendingWorkflowSubmission?.kind==="create"?(work.draft.pendingWorkflowSubmission.constraints??[]).join("\n"):"");
  const [busy,setBusy]=useState(false);
  const busyRef=useRef(false);
  const [syncPending,setSyncPending]=useState(false);
  const [pendingSubmission,setPendingSubmission]=useState<"create"|"report"|null>(work.draft.pendingWorkflowSubmission?.kind??null);
  const [recheckedUnknown,setRecheckedUnknown]=useState(false);
  const pendingPromptId=useRef(work.draft.pendingWorkflowSubmission?.promptId);
  const pendingSourceKey=useRef(work.draft.pendingWorkflowSubmission?.sourceDraftKey??work.draftKey);
  const [error,setError]=useState("");
  const constraints=lines(constraintsText);
  const submittedText=useMemo(()=>[
    uiText("请在当前任务中创建一轮工作流，并先形成可查看的阶段安排。"),
    uiText("要完成的结果：")+goal.trim(),
    ...(constraints.length?[uiText("范围与限制：")+constraints.join("；")]:[]),
  ].join("\n"),[goal,constraintsText]);
  const act=async(method:string,params:Record<string,unknown>)=>{
    if(!task||busyRef.current||syncPending||pendingSubmission)return;
    busyRef.current=true;setBusy(true);setError("");
    try{
      await work.mutateStore(method,{taskId:task.id,scope:task.scope,...params});
      setSyncPending(true);
      try{await work.reloadConfirmed();setSyncPending(false);}
      catch(reason){setError(uiText("操作已保存，但界面刷新失败：{0}。请重新读取，勿重复操作。", [errorText(reason)]));}
    }
    catch(reason){setError(errorText(reason));}
    finally{busyRef.current=false;setBusy(false);}
  };
  const clearPending=async()=>{
    const source=pendingSourceKey.current;
    const clear=(previous:typeof work.draft)=>previous.pendingWorkflowSubmission?.promptId===pendingPromptId.current
      ? {...previous,pendingWorkflowSubmission:undefined}:previous;
    work.updateDraft(source,clear);
    if(source!==work.draftKey)work.updateDraft(work.draftKey,clear);
    await work.flushDrafts();
  };
  const retryReload=async()=>{
    if(busyRef.current||!syncPending&&!pendingSubmission)return;
    busyRef.current=true;setBusy(true);
    try{
      const fresh=await work.reloadConfirmed();
      if(syncPending)setSyncPending(false);
      const receipt=fresh?.events.find(event=>event.kind==="sessionRun.prepared"
        &&(!work.task||event.taskId===work.task.id)
        &&(event.payload as {clientPromptId?:string}|undefined)?.clientPromptId===pendingPromptId.current);
      const receiptValue=receipt?.payload as {workflow?:{id?:string;originRawInputId?:string};rawInputId?:string;sessionRunId?:string}|undefined;
      if(pendingSubmission==="create"){
        const created=!!receiptValue?.workflow?.id&&fresh?.taskWorkflows.some(item=>item.id===receiptValue.workflow?.id
          &&item.originRawInputId===receiptValue.rawInputId&&item.originRawInputId===receiptValue.workflow?.originRawInputId);
        if(created){
          const createdTask=fresh.tasks.find(item=>item.id===receipt?.taskId);
          const coordination=fresh.sessions.find(item=>item.taskId===createdTask?.id&&item.kind==="coordination");
          await clearPending();
          if(createdTask&&coordination&&work.task?.id!==createdTask.id)work.select(createdTask,coordination.id);
          onSubmissionState?.(false);setPendingSubmission(null);setRecheckedUnknown(false);setError("");onClose();return;
        }
        const taskCreation=fresh?.events.find(event=>event.kind==="task.created"
          &&(event.payload as {requestId?:string}|undefined)?.requestId===`workflow-task:${pendingPromptId.current}`);
        if(taskCreation&&fresh){
          const createdTask=fresh.tasks.find(item=>item.id===taskCreation.taskId);
          const coordination=fresh.sessions.find(item=>item.taskId===createdTask?.id&&item.kind==="coordination");
          if(createdTask&&coordination&&work.task?.id!==createdTask.id){onSubmissionState?.(true,pendingPromptId.current);work.select(createdTask,coordination.id);}
        }
        setRecheckedUnknown(true);setError(taskCreation?uiText("任务已经建立，但本轮工作流尚未确认；已回到原任务，请核对后选择继续编辑。"):uiText("重新读取后仍未确认本轮工作流已创建；表单保留，请先核对主对话的提交结果，避免重复创建。"));return;
      }
      if(pendingSubmission==="report"){
        const created=!!receiptValue?.sessionRunId&&fresh?.agentReports.some(item=>{
          const body=item.body as {sessionRunId?:string;workflowReport?:{runId?:string}}|undefined;
          return body?.sessionRunId===receiptValue.sessionRunId&&body?.workflowReport?.runId===run?.id;
        });
        if(created){await clearPending();setPendingSubmission(null);setRecheckedUnknown(false);setError("");return;}
        if(receipt){
          const sessionRun=fresh?.sessionRuns.find(value=>value.id===receiptValue?.sessionRunId);
          if(sessionRun&&["completed","failed","aborted","interrupted","unknown"].includes(sessionRun.status)){
            setRecheckedUnknown(true);setError(uiText("本次汇总运行已结束，但没有可核对的协调报告；请查看运行结果，再明确选择是否重新请求。"));return;
          }
          setError(uiText("本次汇总请求已受理，报告仍在生成或保存；请等待并重新读取，不要再次提交。"));return;
        }
        setRecheckedUnknown(true);setError(uiText("重新读取后汇总报告仍未落盘；请先核对本轮运行状态，避免重复请求。"));return;
      }
      setError("");
    }
    catch(reason){setError(uiText("操作已保存，但界面仍未刷新：{0}。请稍后重新读取。", [errorText(reason)]));}
    finally{busyRef.current=false;setBusy(false);}
  };
  const create=async()=>{
    if(busyRef.current||pendingSubmission||!goal.trim())return;
    busyRef.current=true;setBusy(true);setError("");
    const promptId=pendingPromptId.current??crypto.randomUUID();pendingPromptId.current=promptId;pendingSourceKey.current=work.draftKey;setRecheckedUnknown(false);onSubmissionState?.(true,promptId);
    let keepPanelForRecovery=false;
    try{
      const outcome=await work.send(undefined,undefined,{message:submittedText,promptId,workflowDraft:{goal:goal.trim(),...(constraints.length?{constraints}:{})}});
      if(outcome==="accepted")onClose();
      else if(outcome==="unknown"){keepPanelForRecovery=true;setPendingSubmission("create");setError(uiText("提交结果待核对；请重新读取任务状态，确认后再决定下一步，勿重复创建。"));}
      else setError(uiText("本次工作流请求未提交；请核对输入与任务状态后重试。"));
    }catch(reason){keepPanelForRecovery=true;setPendingSubmission("create");setError(uiText("提交结果待核对：{0}。请先重新读取。", [errorText(reason)]));}
    finally{busyRef.current=false;setBusy(false);if(!keepPanelForRecovery)onSubmissionState?.(false);}
  };
  const report=[...(snapshot?.agentReports??[])].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).find(item=>{
    if(item.taskId!==task?.id||item.reportKind!=="coordinator"||!run)return false;
    const body=item.body as {workflowReport?:{runId?:string;version?:number}}|undefined;
    return body?.workflowReport?.runId===run.id&&body.workflowReport.version===run.version;
  });
  const stageItems=stages.map(stage=>{
    const binding=(snapshot?.taskWorkflowWorkItems??[]).find(item=>item.runId===run?.id&&item.stageId===stage.id);
    const item=binding?(snapshot?.taskWorkItems??[]).find(value=>value.id===binding.workItemId):undefined;
    const members=(snapshot?.agentAssignments??[]).filter(assignment=>{const source=(assignment.taskPacket as {workflowBinding?:{workflowRunId?:string;stageId?:string}}|undefined)?.workflowBinding;return !!source&&source.workflowRunId===run?.id&&source.stageId===stage.id;}).map(assignment=>(snapshot?.agentRuns??[]).find(agent=>agent.id===assignment.agentRunId)).filter((agent):agent is NonNullable<typeof agent>=>!!agent);
    const reports=(snapshot?.agentReports??[]).filter(report=>members.some(agent=>agent.id===report.agentRunId));
    const ownerAgentRunId=(snapshot?.agentAssignments??[]).find(assignment=>assignment.id===item?.ownerAssignmentId)?.agentRunId;
    const accepted=(snapshot?.verifications??[]).filter(record=>{
      if(!item||!ownerAgentRunId||record.verdict!=="pass"||!record.evidenceIds.length||!(snapshot?.coordinatorReviews??[]).some(review=>review.verificationId===record.id&&review.outcome==="accepted"))return false;
      if(record.workItemId===item.id||record.verifierAgentRunId===ownerAgentRunId)return true;
      if(record.subjectAgentRunId!==ownerAgentRunId||!record.subjectReportId)return false;
      const report=(snapshot?.agentReports??[]).find(value=>value.id===record.subjectReportId);
      return (report?.body as {workAssignment?:{workItemId?:string}}|undefined)?.workAssignment?.workItemId===item.id;
    });
    return {stage,item,members,reports,accepted};
  });
  const workItemsDone=!!stages.length&&stageItems.every(({item})=>item?.state==="completed");
  const reportRequest=async()=>{
    if(!run||busyRef.current||pendingSubmission)return;
    busyRef.current=true;setBusy(true);setError("");
    const promptId=pendingPromptId.current??crypto.randomUUID();pendingPromptId.current=promptId;pendingSourceKey.current=work.draftKey;setRecheckedUnknown(false);
    try{
      const outcome=await work.send(undefined,undefined,{message:uiText("请核对本轮工作流各阶段的实际结果、独立检查与证据，形成有来源的整体报告；不要替我接受任务。"),promptId,workflowReportRunId:run.id});
      if(outcome==="unknown"){setPendingSubmission("report");setError(uiText("汇总请求结果待核对；请重新读取当前运行状态，勿重复请求。"));}
      else if(outcome==="rejected")setError(uiText("汇总请求未提交；请核对阶段证据与当前运行状态。"));
    }catch(reason){setError(errorText(reason));}
    finally{busyRef.current=false;setBusy(false);}
  };
  return <section ref={panelRef} tabIndex={-1} className="task-workflow-panel" aria-label={uiText("任务工作流")}>
    <div className="task-workflow-heading"><div><strong>{uiText("任务内工作流")}</strong><p className="secondary">{uiText("一轮工作流属于当前任务；阶段结果来自实际成员、工作项与验收证据。")}</p></div><button type="button" className="text-button" onClick={onClose} disabled={busy||!!pendingSubmission}>{uiText("收起")}</button></div>
    {error&&<p role="alert" className="inline-error">{error}</p>}
    {(syncPending||pendingSubmission)&&<button type="button" className="text-button" disabled={busy} onClick={()=>void retryReload()}>{uiText("重新读取工作流提交状态")}</button>}
    {pendingSubmission&&recheckedUnknown&&<button type="button" className="text-button" disabled={busy} onClick={()=>{void clearPending().then(()=>{pendingPromptId.current=undefined;onSubmissionState?.(false);setPendingSubmission(null);setRecheckedUnknown(false);setError(uiText("已由你核对并选择重新编辑；再次提交前请确认主对话没有收到上一次请求。"));}).catch(reason=>setError(errorText(reason)));}}>{uiText("我已核对，返回编辑")}</button>}
    {activeRun&&selected?.id!==activeRun.workflowId&&<button type="button" className="text-button" onClick={()=>{setSelectedId(activeRun.workflowId);setCreating(false);}}>{uiText("返回正在运行的工作流")}</button>}
    {workflows.length>1&&<div className="task-workflow-history" aria-label={uiText("本任务工作流")}>{workflows.map(item=>{const itemRun=(snapshot?.taskWorkflowRuns??[]).filter(run=>run.workflowId===item.id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];const itemVersion=snapshot?.taskWorkflowVersions.find(version=>version.workflowId===item.id&&version.version===item.currentVersion);return <button type="button" key={item.id} aria-pressed={selected?.id===item.id} onClick={()=>{setSelectedId(item.id);setCreating(false);}}>{itemVersion?.goal.slice(0,28)??item.id.slice(-6)} · {itemRun?statusLabel[itemRun.status]:uiText("待开始")}</button>;})}</div>}
    {selected&&!creating&&<>
      <div className="task-workflow-summary"><strong>{version?.goal??uiText("正在读取安排…")}</strong><span>{run?statusLabel[run.status]:uiText("待形成并开始")}</span></div>
      {run&&selected.currentVersion!==run.version&&<p className="secondary" role="status">{uiText("当前运行仍对应第 ")}{run.version} {uiText(" 版；已保存第 ")}{selected.currentVersion} {uiText(" 版。继续前会核对版本与目标。")}</p>}
      {!run&&activeRun&&activeRun.workflowId!==selected.id&&<p className="secondary" role="status">{uiText("本任务已有另一轮工作流在运行；当前安排可查看，待那一轮收口后再开始。")}</p>}
      {version?.constraints.length?<p className="secondary">{uiText("限制：")}{version.constraints.join("；")}</p>:null}
      {stages.length?<ol className="task-workflow-stages">{stageItems.map(({stage,item,members,reports,accepted})=>{const prerequisites=stage.dependsOn.map(id=>stages.find(value=>value.id===id)).filter((value):value is NonNullable<typeof value>=>!!value);const waiting=prerequisites.filter(value=>stageItems.find(row=>row.stage.id===value.id)?.item?.state!=="completed");return <li key={stage.id}><strong>{stage.title}</strong><span>{item?item.state==="completed"?uiText("已通过工作项验收"):item.state==="in_progress"?uiText("成员处理中"):item.state==="blocked"?uiText("受阻"):item.state==="cancelled"?uiText("已取消"):uiText("待处理"):uiText("待派发")}</span><small>{stage.completion}</small>{prerequisites.length>0&&<small>{uiText("前置阶段：")}{prerequisites.map(value=>value.title).join("、")}{waiting.length>0?uiText(" · 等待 {0} 完成", [waiting.map(value=>value.title).join("、")]):""}</small>}{members.length>0&&<div className="task-workflow-members">{members.map(member=><button type="button" className="text-button" key={member.id} onClick={()=>{if(task)work.select(task,member.sessionId);}}>{snapshot?.sessions.find(session=>session.id===member.sessionId)?.title??uiText("成员")} · {agentStatusLabel[member.status]??uiText("待核对")}</button>)}</div>}{item&&<small>{uiText("成员报告 ")}{reports.length} {uiText(" · 协调复核通过 ")}{accepted.length}{item.state==="blocked"?uiText(" · 请核对阻塞或返工"):""}</small>}</li>;})}</ol>:<p className="secondary" role="status">{uiText("协调者正在形成阶段；安排保存后才能开始。")}</p>}
      {run?.reason&&<p className="secondary">{uiText("停止原因：")}{run.reason}</p>}
      <div className="task-workflow-actions">
        {!run&&stages.length>0&&<button type="button" disabled={busy||syncPending||!!pendingSubmission||work.running||!!activeRun&&activeRun.workflowId!==selected.id} onClick={()=>void act("task.workflow.start",{workflowId:selected.id,expectedWorkflowRevision:selected.revision})}>{uiText("开始工作流")}</button>}
        {run?.status==="active"&&<button type="button" disabled={busy||syncPending||!!pendingSubmission} onClick={()=>void act("task.workflow.stop",{runId:run.id,expectedRunRevision:run.revision,reason:uiText("用户选择停止本轮工作流的后续推进")})}>{uiText("停止后续推进")}</button>}
        {(run?.status==="stopped"||run?.status==="interrupted")&&<button type="button" disabled={busy||syncPending||!!pendingSubmission} onClick={()=>void act("task.workflow.continue",{runId:run.id,expectedRunRevision:run.revision})}>{uiText("继续工作流")}</button>}
        {run?.status==="active"&&workItemsDone&&<button type="button" disabled={busy||syncPending||!!pendingSubmission||work.running} onClick={()=>void reportRequest()}>{report?uiText("按最新要求重新核对并汇总"):uiText("请求协调者核对并汇总")}</button>}
        {run?.status==="active"&&workItemsDone&&report&&<button type="button" disabled={busy||syncPending||!!pendingSubmission||work.running} onClick={()=>void act("task.workflow.complete",{runId:run.id,expectedRunRevision:run.revision,coordinatorReportId:report.id})}>{uiText("核对并完成工作流")}</button>}
        {run?.status==="completed"&&<button type="button" className="text-button" onClick={()=>setCreating(true)}>{uiText("发起新一轮")}</button>}
      </div>
      <p className="secondary">{uiText("工作流完成后，任务仍由你单独验收。停止不会撤销已完成的文件或外部操作。")}</p>
      {report&&run?.status==="active"&&<p className="secondary">{workItemsDone?uiText("完成时会再次核对最新要求、阶段验收与目标版本；若报告已过期，可在这里重新请求汇总。"):uiText("阶段正在返工或未验收，原报告暂不能用于完成；待阶段重新通过后再请求汇总。")}</p>}
    </>}
    {creating&&<div className="task-workflow-create">
      <label>{uiText("要完成的结果")}<textarea ref={firstInputRef} value={goal} maxLength={20_000} readOnly={busy} onChange={event=>{if(!busyRef.current)setGoal(event.target.value);}} placeholder={uiText("这轮工作流最终要交付什么？")}/></label>
      <label>{uiText("范围与限制 ")}<span className="secondary">{uiText("每行一条")}</span><textarea value={constraintsText} readOnly={busy} onChange={event=>{if(!busyRef.current)setConstraintsText(event.target.value);}} placeholder={uiText("目录、时间、验收或副作用边界")}/></label>
      <details><summary>{uiText("查看将提交给协调者的原文")}</summary><pre>{submittedText}</pre></details>
      <p className="secondary">{uiText("工作流表单独立提交；普通输入框中的草稿和附件会继续保留。")}</p>
      <div className="task-workflow-actions"><button type="button" className="text-button" disabled={busy||!!pendingSubmission} onClick={()=>{if(selected)setCreating(false);else onClose();}}>{uiText("取消")}</button><button type="button" disabled={busy||!!pendingSubmission||!goal.trim()||work.running||work.closing} onClick={()=>void create()}>{busy?uiText("提交中…"):uiText("创建工作流")}</button></div>
    </div>}
  </section>;
}
