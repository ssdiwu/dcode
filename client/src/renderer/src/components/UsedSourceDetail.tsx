import { uiText } from "../../../shared/ui-language.ts";
import { useEffect, useState } from "react";
import { api, errorText } from "../types";

interface UsedSourceResult {
  state: "available" | "hash_mismatch" | "historical_unavailable";
  title?: string;
  content?: string;
  reason?: string;
  sessionId?: string;
  currentPath?: boolean;
  use: { kind: string; sourceId: string; digest: string; version?: number; createdAt: string };
}

export function UsedSourceDetail({ taskId, sourceUseId, onOpenSession }: { taskId: string; sourceUseId: string; onOpenSession: (sessionId: string) => void }) {
  const [data,setData]=useState<UsedSourceResult|null>(null);
  const [error,setError]=useState<unknown>(null);
  const [attempt,setAttempt]=useState(0);
  useEffect(()=>{let alive=true;setData(null);setError(null);void api().request<UsedSourceResult>("task.source.used.read",{taskId,sourceUseId}).then(result=>{if(alive)setData(result);}).catch(reason=>{if(alive)setError(reason);});return()=>{alive=false;};},[taskId,sourceUseId,attempt]);
  if (error) return <div role="alert" className="inline-error">{uiText("来源暂时无法读取：")}{errorText(error)}<button className="text-button" onClick={() => setAttempt(value=>value+1)}>{uiText("重试")}</button></div>;
  if (!data) return <p>{uiText("正在读取原始材料…")}</p>;
  return <div className="used-source-detail">
    <h3>{data.title ?? uiText("已用来源")}</h3>
    <p className="secondary">{data.use.kind === "inspiration" ? uiText("灵感第 {0} 版", [data.use.version]) : ({task_message:uiText("任务历史消息"),work_item:uiText("任务工作项"),agent_report:uiText("成员报告"),evidence:uiText("检查证据"),project_file:uiText("项目文件")} as Record<string,string>)[data.use.kind] ?? uiText("来源")} · {new Date(data.use.createdAt).toLocaleString("zh-CN")}</p>
    {data.use.kind === "task_message" && data.currentPath === false && <p className="task-summary-stale" role="status">{uiText("这条消息属于已退出的历史对话路径，不能直接当作当前要求。")}</p>}
    {data.state === "available" ? <pre className="source-detail-text">{data.content}</pre>
      : <p role="status">{data.state === "hash_mismatch" ? uiText("来源内容已经变化，当时的正文无法恢复。") : uiText("来源已不可读取。")}{data.reason ? ` ${data.reason}` : ""}{uiText("原引用身份仍保留。")}</p>}
    {data.sessionId && <button className="text-button" onClick={() => onOpenSession(data.sessionId!)}>{uiText("查看所属对话")}</button>}
    <details><summary>{uiText("来源身份")}</summary><p className="secondary">{data.use.sourceId} · {data.use.digest}</p></details>
  </div>;
}
