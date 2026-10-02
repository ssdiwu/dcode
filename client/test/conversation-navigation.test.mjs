import test from "node:test";
import assert from "node:assert/strict";
import {conversationTurns, currentTurn} from "../src/renderer/src/workbench/conversation-navigation.ts";

const row = (id, role, text) => ({id,role,parts:[{kind:role === "process" ? "tool" : "text",text}]});

test("conversation navigation uses user turns and keeps repeated questions distinct",()=>{
  const rows=[row("preface","assistant","说明"),row("u1","user","相同问题"),row("tool","process","内部工具内容"),row("a1","assistant","第一段"),row("a2","assistant","第二段"),row("u2","user","相同问题")];
  assert.deepEqual(conversationTurns(rows,"正在生成的回复"),[
    {id:"u1",question:"相同问题",answer:"第一段 第二段"},
    {id:"u2",question:"相同问题",answer:"正在生成的回复"},
  ]);
  assert.equal(conversationTurns([{id:"image",role:"user",parts:[{kind:"image",text:"data"}]}])[0].question,"图片消息（1 张）");
  assert.deepEqual(conversationTurns([]),[]);
});

test("reading anchors stay within actual user inputs",()=>{
  const anchors=[{id:"u1",top:24},{id:"u2",top:640},{id:"u3",top:1200}];
  assert.equal(currentTurn(anchors,0),"u1");
  assert.equal(currentTurn(anchors,800),"u2");
  assert.equal(currentTurn(anchors,2400),"u3");
  assert.equal(currentTurn([],0),null);
});

test("coordinator handoffs and tool boundaries do not become questions or borrow a previous answer",()=>{
  const rows=[row("u1","user","用户要求"),row("a1","assistant","首个回答"),
    {...row("handoff","coordination","主对话的安排"),collaborationGroupId:"g1"},
    {...row("a2","assistant","成员执行结果"),collaborationGroupId:"g1"},
    row("u2","user","用户补充"),row("a3","assistant","补充回答")];
  assert.deepEqual(conversationTurns(rows),[
    {id:"u1",question:"用户要求",answer:"首个回答"},
    {id:"u2",question:"用户补充",answer:"补充回答"},
  ]);
  assert.equal(conversationTurns(rows,"流式回答")[1].answer,"补充回答 流式回答");
  assert.equal(conversationTurns(rows.slice(0,4),"流式协作进展")[0].answer,"首个回答");
  assert.deepEqual(conversationTurns([row("u1","user","真实提问"),
    {...row("system","user","原生系统事件"),navigationEligible:false},row("reply","assistant","系统事件回复")]),
    [{id:"u1",question:"真实提问",answer:""}]);
});
