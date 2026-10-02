import { uiText } from "../../../shared/ui-language.ts";
import {useState} from 'react';
import {Square} from 'lucide-react';
import {api} from '../types';
import type {Workbench} from '../useWorkbench';
export function AuxiliaryActivities({work,taskWide=false}:{work:Workbench;taskWide?:boolean}){
  const [stopping,setStopping]=useState<string|null>(null);
  const records=(work.snapshot?.auxiliaryProcesses??[]).filter(record=>record.taskId===work.task?.id&&record.process.status!=='exited'&&(taskWide||work.snapshot?.agentRuns.find(member=>member.id===record.agentRunId)?.sessionId===work.session?.id));
  if(!records.length)return null;
  const stop=async(record:typeof records[number])=>{setStopping(record.process.id);try{await api().request('agentProcess.stopAuxiliary',{taskId:record.taskId,agentRunId:record.agentRunId,processId:record.process.id});await work.reload();}catch(error){work.fail(error);}finally{setStopping(null);}};
  return <div className="auxiliary-activities" aria-label={uiText("后台活动")}>{records.map(record=>{const agent=work.snapshot?.agentRuns.find(member=>member.id===record.agentRunId),session=work.snapshot?.sessions.find(session=>session.id===agent?.sessionId);return <div className="auxiliary-activity" key={record.process.id}><span><strong>{taskWide?session?.title??uiText("成员"):uiText("当前对话")}</strong><small>{record.process.status==='unknown'?uiText("后台活动状态待核对"):record.process.status==='background'?uiText("命令在后台运行"):uiText("命令正在运行")}</small></span><button className="text-button" disabled={stopping===record.process.id} aria-label={uiText("停止 {0} 的后台活动", [session?.title??uiText("当前成员")])} onClick={()=>void stop(record)}><Square size={12}/>{stopping===record.process.id?uiText("正在停止…"):uiText("停止")}</button></div>;})}</div>;
}
