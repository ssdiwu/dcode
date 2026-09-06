import test from "node:test";
import assert from "node:assert/strict";
import {conversationTurns, currentTurn, turnIndexAtPosition} from "../src/renderer/src/workbench/conversation-navigation.ts";

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

test("dense rail pointer positions and reading anchors stay within actual turns",()=>{
  assert.equal(turnIndexAtPosition(0,100,5),0);
  assert.equal(turnIndexAtPosition(50,100,5),2);
  assert.equal(turnIndexAtPosition(100,100,5),4);
  assert.equal(turnIndexAtPosition(-10,100,5),0);
  assert.equal(turnIndexAtPosition(20,0,5),-1);
  assert.equal(turnIndexAtPosition(20,100,0),-1);
  const anchors=[{id:"u1",top:24},{id:"u2",top:640},{id:"u3",top:1200}];
  assert.equal(currentTurn(anchors,0),"u1");
  assert.equal(currentTurn(anchors,800),"u2");
  assert.equal(currentTurn(anchors,2400),"u3");
  assert.equal(currentTurn([],0),null);
});
