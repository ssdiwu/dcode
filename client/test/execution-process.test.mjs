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
