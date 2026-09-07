import type { MessagePart, MessageRow, StreamState } from "../workbench.ts";

export interface ProcessStep {
  id: string;
  kind: "thinking" | "text" | "tool" | "image";
  title: string;
  text: string;
  output?: string;
  mimeType?: string;
  state?: "running" | "complete" | "error" | "unknown";
}
export interface ExecutionTurn {
  id: string;
  user?: MessageRow;
  updateLabel?:string;
  steps: ProcessStep[];
  answer?: MessageRow;
  running: boolean;
  status: "running" | "complete" | "error" | "aborted" | "interrupted" | "unknown";
  hasResponse: boolean;
}
export const toolLabel = (name: string) => ({bash:"终端",read:"读取文件",write:"写入文件",edit:"编辑文件",grep:"搜索内容",find:"查找文件",ls:"查看目录",dcode_team:"协作安排",dcode_verification:"验收记录",dcode_request:"等待决定",dcode_request_task_acceptance:"任务验收"})[name] ?? name;

/** Merge the live adapter view into the current turn by message identity, never by an older answer's text. */
export function mergeLiveRows(rows: MessageRow[], stream: StreamState): MessageRow[] {
  const result = [...rows];
  const boundary=(row:MessageRow)=>row.role==="user"||row.role==="coordination"||row.inputBoundary;
  const claimed = new Set<string>();
  for (const message of stream.messages) {
    const lastUser=result.findLastIndex(boundary);
    const inputIndex=message.inputMessageId?result.findLastIndex(row=>boundary(row)&&row.messageId===message.inputMessageId):-1;
    const anchor=inputIndex>=0?inputIndex:lastUser;
    const nextInput=result.findIndex((row,index)=>index>anchor&&boundary(row));
    const segmentEnd=nextInput>=0?nextInput:result.length;
    const parts: MessagePart[] = message.parts ?? [
      ...(message.thinking.trim() ? [{kind:"thinking" as const,text:message.thinking}] : []),
      ...(message.text ? [{kind:"text" as const,text:message.text}] : []),
    ];
    // A steering input does not end the Agent run. Earlier live messages can
    // already be durable before the newest input; identities cover every row.
    let index=result.findIndex(row=>!claimed.has(row.id)&&row.role==="assistant"&&row.messageId===message.id);
    if(index<0)index=result.findIndex((row,index)=>index>anchor&&index<segmentEnd&&!claimed.has(row.id)&&row.role==="assistant"&&!row.messageId&&message.ended&&!!message.text&&row.parts.filter(part=>part.kind==="text").map(part=>part.text).join("")===message.text);
    if (index >= 0) {
      claimed.add(result[index]!.id);
      if (!message.ended) result[index] = {...result[index], parts, stopReason:message.stopReason};
    } else if (parts.length) {
      const group=result[anchor]?.collaborationGroupId;
      result.splice(segmentEnd,0,{id:`live-${message.id}`,messageId:message.id,role:"assistant",parts,stopReason:message.stopReason,...(group?{collaborationGroupId:group}:{})});
    }
  }
  return result;
}

/** One disclosure per user turn; final answer stays outside, intermediate statements and tools stay in order. */
export function executionTurns(rows: MessageRow[], stream: StreamState, running: boolean, runStatus?: string): ExecutionTurn[] {
  const grouped: {id:string;user?:MessageRow;rows:MessageRow[];collaborationGroupId?:string;updateLabel?:string}[] = [];
  for (const row of rows) {
    if (row.role === "user"||row.role==="coordination") grouped.push({id:row.id,user:row,rows:[],collaborationGroupId:row.collaborationGroupId});
    else {
      if(row.collaborationGroupId&&grouped.at(-1)?.collaborationGroupId!==row.collaborationGroupId)grouped.push({id:`update-${row.collaborationGroupId}`,rows:[],collaborationGroupId:row.collaborationGroupId,updateLabel:"进展更新"});
      if (!grouped.length) grouped.push({id:row.id,rows:[]});
      grouped.at(-1)!.rows.push(row);
    }
  }
  return grouped.map((group,index) => {
    const active = index === grouped.length - 1 && running;
    const latestAssistant = group.rows.findLast(row=>row.role==="assistant");
    const final = latestAssistant && !latestAssistant.parts.some(part=>part.kind==="tool" && !part.toolResult) && latestAssistant.parts.some(part=>part.kind==="text" || part.kind==="image") ? latestAssistant : undefined;
    const steps: ProcessStep[] = [];
    for (const row of group.rows) for (const [partIndex,part] of row.parts.entries()) {
      if (row === final && (part.kind === "text" || part.kind === "image")) continue;
      const id = part.toolCallId ?? `${row.id}:${partIndex}`;
      if (part.toolResult) {
        if (part.kind === "image") {
          const existing = steps.find(step => step.id === id && step.kind === "tool");
          if (existing) existing.state = part.isError ? "error" : "complete";
          else steps.push({id,kind:"tool",title:toolLabel(part.toolName ?? "工具"),text:"",state:part.isError?"error":"complete"});
          steps.push({id:`${id}:image:${partIndex}`,kind:"image",title:toolLabel(part.toolName ?? "工具"),text:part.text,mimeType:part.mimeType});
          continue;
        }
        const existing = steps.find(step=>step.id===id && step.kind==="tool");
        if (existing) {existing.output = [existing.output,part.text].filter(Boolean).join("\n");existing.state=part.isError?"error":"complete";}
        else steps.push({id,kind:"tool",title:toolLabel(part.toolName ?? "工具"),text:"",output:part.text,state:part.isError?"error":"complete"});
      } else if (part.kind !== "file" && part.text.trim()) steps.push({id,kind:part.kind,title:part.kind==="thinking"?"思考":part.kind==="tool"?toolLabel(part.toolName ?? "工具"):"进展",text:part.kind==="tool"?part.text.slice(part.text.indexOf("\n")+1):part.text,mimeType:part.mimeType});
    }
    for (const tool of stream.tools ?? []) {
      const recordedOwner=grouped.findIndex(candidate=>candidate.rows.some(row=>row.parts.some(part=>part.toolCallId===tool.id)));
      const inputOwner=tool.inputMessageId?grouped.findIndex(candidate=>candidate.user?.messageId===tool.inputMessageId||candidate.rows.some(row=>row.inputBoundary&&row.messageId===tool.inputMessageId)):-1;
      if(index!==(recordedOwner>=0?recordedOwner:inputOwner>=0?inputOwner:grouped.length-1))continue;
      const existing = steps.find(step=>step.id===tool.id);
      if (existing) {existing.output=tool.output || existing.output;existing.state=tool.state;}
      else steps.push({id:tool.id,kind:"tool",title:toolLabel(tool.name),text:tool.input,output:tool.output,state:tool.state});
    }
    const terminal = latestAssistant?.stopReason;
    const last = index === grouped.length - 1;
    const unfinished = last && stream.messages.some(message => !message.ended);
    const pendingTool = steps.some(step => step.kind === "tool" && (!step.state || step.state === "running"));
    const processing = active || running && steps.some(step => step.state === "running");
    const status: ExecutionTurn["status"] = processing ? "running"
      : terminal === "error" || last && runStatus === "failed" ? "error"
      : terminal === "aborted" || last && ["aborted","cancelled"].includes(runStatus ?? "") ? "aborted"
      : last && runStatus === "unknown" ? "unknown"
      : last && (runStatus === "interrupted" || unfinished && runStatus !== "completed") ? "interrupted"
      : pendingTool ? "unknown" : "complete";
    // A terminal run does not prove the outcome of a tool whose result never arrived.
    const projectedSteps = status === "running" ? steps : steps.map(step => step.kind === "tool" && (!step.state || step.state === "running") ? {...step,state:"unknown" as const} : step);
    return {id:group.id,user:group.user,updateLabel:group.updateLabel,steps:projectedSteps,answer:final,running:processing,status,hasResponse:processing||group.rows.some(row=>!row.inputBoundary)};
  });
}

export function processPreview(turn: ExecutionTurn): string {
  const step = turn.steps.at(-1);
  if (!step) return turn.running ? "正在生成回复…" : "";
  if(["协作安排","验收记录","等待决定","任务验收"].includes(step.title)) return `${step.title} · ${step.state==="error"?"未完成，展开查看原因":step.state==="running"?"正在处理…":step.state==="unknown"?"状态待核对":"已返回结果"}`;
  const text = (step.output || step.text).replace(/\s+/g," ").trim();
  const tail = text.length > 180 ? `…${text.slice(-180)}` : text;
  return `${step.kind === "tool" ? `${step.title} · ` : ""}${tail}`;
}
