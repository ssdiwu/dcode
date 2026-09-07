import test from "node:test";
import assert from "node:assert/strict";
import { messageRows, emptyStream, reduceStream } from "../src/renderer/src/workbench.ts";
import { executionTurns, mergeLiveRows, processPreview } from "../src/renderer/src/workbench/execution-process.ts";

test("empty provider thinking never becomes an empty expandable block", () => {
  const rows = messageRows([{id:"answer",type:"message",message:{role:"assistant",content:[{type:"thinking",thinking:"",thinkingSignature:"opaque"},{type:"text",text:"17 × 19 = 323。"}]}}]);
  assert.equal(rows[0].parts.filter(part=>part.kind==="thinking").length,0);
  assert.equal(rows[0].parts[0].text,"17 × 19 = 323。");
});

test("one turn keeps intermediate text, thinking and paired tool results inside a complete process", () => {
  const rows=messageRows([
    {id:"u",type:"message",message:{role:"user",content:"检查文件"}},
    {id:"a1",type:"message",message:{role:"assistant",timestamp:1,content:[{type:"thinking",thinking:"先检查目录"},{type:"text",text:"开始检查文件。"},{type:"toolCall",id:"read1",name:"read",arguments:{path:"/tmp/example.md"}}]}},
    {id:"tool",type:"message",message:{role:"toolResult",toolCallId:"read1",toolName:"read",content:[{type:"text",text:"这是文件原文"}]}},
    {id:"a2",type:"message",message:{role:"assistant",timestamp:2,content:[{type:"thinking",thinking:"检查完成"},{type:"text",text:"文件内容正常。"}],stopReason:"stop"}},
  ]);
  const [turn]=executionTurns(rows,emptyStream(),false);
  assert.equal(turn.answer.id,"a2");
  assert.deepEqual(turn.steps.map(step=>step.kind),["thinking","text","tool","thinking"]);
  assert.equal(turn.steps[2].output,"这是文件原文");
  assert.equal(turn.steps[2].state,"complete");
  assert.equal(processPreview(turn),"检查完成");
});

test("live tools update the single process row, preserve final results, and only the matching assistant ends", () => {
  const event=(type,more={})=>({event:"session.event",data:{sessionId:"s",type,...more}});
  let stream=emptyStream("s");
  stream=reduceStream(stream,event("message_start",{message:{role:"assistant",timestamp:10}}),"s");
  stream=reduceStream(stream,event("message_update",{message:{role:"assistant",timestamp:10,content:[{type:"thinking",thinking:"正在检查"},{type:"toolCall",id:"t1",name:"bash",arguments:{command:"pwd"}}]},assistantMessageEvent:{type:"toolcall_delta"}}),"s");
  stream=reduceStream(stream,event("tool_execution_start",{toolCallId:"t1",toolName:"bash",args:{command:"pwd"}}),"s");
  stream=reduceStream(stream,event("tool_execution_update",{toolCallId:"t1",partialResult:{content:[{type:"text",text:"第一行\n最新输出"}]}}),"s");
  stream=reduceStream(stream,event("message_end",{message:{role:"toolResult",content:[]}}),"s");
  assert.equal(stream.messages[0].ended,false);
  const rows=mergeLiveRows(messageRows([{id:"u",type:"message",message:{role:"user",content:"运行"}}]),stream);
  const [turn]=executionTurns(rows,stream,true);
  assert.match(processPreview(turn),/终端 · 第一行 最新输出/);
  assert.equal(turn.steps.filter(step=>step.kind==="tool").length,1);
  stream=reduceStream(stream,event("tool_execution_end",{toolCallId:"t1",result:{content:[{type:"text",text:"终端完整输出"}]},isError:true}),"s");
  assert.equal(stream.tools[0].state,"error");
  assert.equal(stream.tools[0].output,"终端完整输出");
});

test("repeated answers in older turns do not hide the live reply, and durable identity takes over once", () => {
  const rows=messageRows([{id:"u1",type:"message",message:{role:"user",content:"先问"}},{id:"a1",type:"message",message:{role:"assistant",timestamp:1,content:"相同回复"}},{id:"u2",type:"message",message:{role:"user",content:"再问"}}]);
  const stream={...emptyStream("s"),messages:[{id:"2",text:"相同回复",thinking:"",ended:true}]};
  assert.equal(mergeLiveRows(rows,stream).length,4);
  rows.push(...messageRows([{id:"a2",type:"message",message:{role:"assistant",timestamp:2,content:"相同回复"}}]));
  assert.equal(mergeLiveRows(rows,stream).length,4);
});


test("unfinished output and a lost Host never become a successful execution",()=>{
  const rows=messageRows([{id:"u1",type:"message",message:{role:"user",content:"历史问题"}},{id:"a1",type:"message",message:{role:"assistant",content:"完成的历史"}},{id:"u2",type:"message",message:{role:"user",content:"当前问题"}}]);
  const stream={...emptyStream("s"),messages:[{id:"partial",text:"尚未结束",thinking:"",ended:false}]};
  const live=mergeLiveRows(rows,stream);
  assert.equal(executionTurns(live,stream,true).at(-1).status,"running");
  assert.equal(executionTurns(live,stream,false).at(-1).status,"interrupted");
  const disconnected=executionTurns(live,emptyStream("s"),false,"interrupted");
  assert.equal(disconnected[0].status,"complete");
  assert.equal(disconnected.at(-1).status,"interrupted");
  assert.equal(executionTurns(live,stream,false,"failed").at(-1).status,"error");
  assert.equal(executionTurns(live,stream,false,"aborted").at(-1).status,"aborted");
  assert.equal(executionTurns(live,stream,false,"completed").at(-1).status,"complete");
  assert.equal(executionTurns(live,emptyStream("s"),false,"unknown").at(-1).status,"unknown");
});


test("interrupted execution stops stale tool spinners without rewriting completed results",()=>{
  const rows=messageRows([{id:"u",type:"message",message:{role:"user",content:"读两份文件"}},{id:"a",type:"message",message:{role:"assistant",content:[{type:"toolCall",id:"t1",name:"read",arguments:{path:"a.md"}},{type:"toolCall",id:"t2",name:"read",arguments:{path:"b.md"}}]}},{id:"r",type:"message",message:{role:"toolResult",toolCallId:"t1",toolName:"read",content:[{type:"text",text:"已返回的内容"}]}}]);
  const stream={...emptyStream("s"),tools:[{id:"t2",name:"read",input:"b.md",output:"",state:"running"}]};
  const turn=executionTurns(rows,stream,false,"interrupted").at(-1);
  assert.equal(turn.status,"interrupted");
  assert.equal(turn.steps.find(step=>step.id==="t1").state,"complete");
  assert.equal(turn.steps.find(step=>step.id==="t2").state,"unknown");
  assert.equal(turn.steps.some(step=>step.state==="running"),false);
});


test("a continuing input does not complete an earlier input whose tool is still running",()=>{
  const rows=[{id:"u1",messageId:"input-a",role:"user",parts:[{kind:"text",text:"先读文件"}]},{id:"a1",role:"assistant",parts:[{kind:"tool",text:'read\n{"path":"a.md"}',toolCallId:"pending",toolName:"read"}]},{id:"u2",messageId:"input-b",role:"user",parts:[{kind:"text",text:"继续补充"}]}];
  const stream={...emptyStream("s"),tools:[{id:"pending",inputMessageId:"input-a",name:"read",input:"a.md",output:"",state:"running"}]};
  const live=executionTurns(rows,stream,true);
  assert.equal(live[0].status,"running");
  const ended=executionTurns(rows,stream,false,"interrupted");
  assert.equal(ended[0].status,"unknown");
  assert.equal(ended[0].steps[0].state,"unknown");
});


test("an image-only tool result proves its paired tool completed",()=>{
  const rows=messageRows([{id:"u",type:"message",message:{role:"user",content:"查看图片"}},{id:"a",type:"message",message:{role:"assistant",content:[{type:"toolCall",id:"image-tool",name:"read",arguments:{path:"image.png"}}]}},{id:"image",type:"message",message:{role:"toolResult",toolCallId:"image-tool",toolName:"read",content:[{type:"image",mimeType:"image/png",data:"AQID"}]}}]);
  const turn=executionTurns(rows,emptyStream(),false,"completed").at(-1);
  assert.equal(turn.steps.find(step=>step.id==="image-tool").state,"complete");
  assert.equal(turn.steps.filter(step=>step.kind==="image").length,1);
  assert.equal(turn.status,"complete");
});
