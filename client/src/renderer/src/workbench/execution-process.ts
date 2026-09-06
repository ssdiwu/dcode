import type { MessagePart, MessageRow, StreamState } from "../workbench.ts";

export interface ProcessStep {
  id: string;
  kind: "thinking" | "text" | "tool" | "image";
  title: string;
  text: string;
  output?: string;
  mimeType?: string;
  state?: "running" | "complete" | "error";
}
export interface ExecutionTurn {
  id: string;
  user?: MessageRow;
  steps: ProcessStep[];
  answer?: MessageRow;
  running: boolean;
  status: "running" | "complete" | "error" | "aborted";
  hasResponse: boolean;
}
export const toolLabel = (name: string) => ({bash:"终端",read:"读取文件",write:"写入文件",edit:"编辑文件",grep:"搜索内容",find:"查找文件",ls:"查看目录"})[name] ?? name;

/** Merge the live adapter view into the current turn by message identity, never by an older answer's text. */
export function mergeLiveRows(rows: MessageRow[], stream: StreamState): MessageRow[] {
  const result = [...rows];
  const lastUser = result.findLastIndex(row => row.role === "user");
  const claimed = new Set<number>();
  for (const message of stream.messages) {
    const parts: MessagePart[] = message.parts ?? [
      ...(message.thinking.trim() ? [{kind:"thinking" as const,text:message.thinking}] : []),
      ...(message.text ? [{kind:"text" as const,text:message.text}] : []),
    ];
    const index = result.findIndex((row, index) => index > lastUser && !claimed.has(index) && row.role === "assistant" && (
      row.messageId === message.id || (!row.messageId && message.ended && !!message.text && row.parts.filter(part=>part.kind==="text").map(part=>part.text).join("") === message.text)
    ));
    if (index >= 0) {
      claimed.add(index);
      // The durable record takes over only once this message has ended.
      if (!message.ended) result[index] = {...result[index], parts, stopReason:message.stopReason};
    } else if (parts.length) result.push({id:`live-${message.id}`,messageId:message.id,role:"assistant",parts,stopReason:message.stopReason});
  }
  return result;
}

/** One disclosure per user turn; final answer stays outside, intermediate statements and tools stay in order. */
export function executionTurns(rows: MessageRow[], stream: StreamState, running: boolean): ExecutionTurn[] {
  const grouped: {id:string;user?:MessageRow;rows:MessageRow[]}[] = [];
  for (const row of rows) {
    if (row.role === "user") grouped.push({id:row.id,user:row,rows:[]});
    else {
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
          steps.push({id:`${id}:image:${partIndex}`,kind:"image",title:toolLabel(part.toolName ?? "工具"),text:part.text,mimeType:part.mimeType});
          continue;
        }
        const existing = steps.find(step=>step.id===id && step.kind==="tool");
        if (existing) {existing.output = [existing.output,part.text].filter(Boolean).join("\n");existing.state=part.isError?"error":"complete";}
        else steps.push({id,kind:"tool",title:toolLabel(part.toolName ?? "工具"),text:"",output:part.text,state:part.isError?"error":"complete"});
      } else if (part.kind !== "file" && part.text.trim()) steps.push({id,kind:part.kind,title:part.kind==="thinking"?"思考":part.kind==="tool"?toolLabel(part.toolName ?? "工具"):"进展",text:part.kind==="tool"?part.text.slice(part.text.indexOf("\n")+1):part.text,mimeType:part.mimeType});
    }
    if (index === grouped.length-1) for (const tool of stream.tools ?? []) {
      const existing = steps.find(step=>step.id===tool.id);
      if (existing) {existing.output=tool.output || existing.output;existing.state=tool.state;}
      else steps.push({id:tool.id,kind:"tool",title:toolLabel(tool.name),text:tool.input,output:tool.output,state:tool.state});
    }
    const terminal = latestAssistant?.stopReason;
    return {id:group.id,user:group.user,steps,answer:final,running:active,status:active?"running":terminal==="error"?"error":terminal==="aborted"?"aborted":"complete",hasResponse:active||group.rows.length>0};
  });
}

export function processPreview(turn: ExecutionTurn): string {
  const step = turn.steps.at(-1);
  if (!step) return turn.running ? "正在生成回复…" : "";
  const text = (step.output || step.text).replace(/\s+/g," ").trim();
  const tail = text.length > 180 ? `…${text.slice(-180)}` : text;
  return `${step.kind === "tool" ? `${step.title} · ` : ""}${tail}`;
}
