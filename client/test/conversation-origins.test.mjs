import test from 'node:test';
import assert from 'node:assert/strict';
import {projectConversationOrigins} from '../src/renderer/src/workbench/conversation-origins.ts';
import {executionTurns,mergeLiveRows} from '../src/renderer/src/workbench/execution-process.ts';
import {conversationTurns} from '../src/renderer/src/workbench/conversation-navigation.ts';
const row=(id,role,text)=>({id,role,parts:[{kind:'text',text}]});
const inputs=[{sourceEntryId:'generated',author:'member',messageId:'update-1'}];
test('main progress updates do not replace the previous human answer or its navigation preview',()=>{
  const rows=projectConversationOrigins([row('human','user','原问题'),row('answer','assistant','原回答'),row('generated','user','内部成员报告'),row('update','assistant','最新协作进展')],inputs,false);
  assert.deepEqual(rows.map(row=>row.id),['human','answer','origin-update-1','update']);const turns=executionTurns(rows,{messages:[]},false);assert.equal(turns.length,2);assert.equal(turns[0].answer.id,'answer');assert.equal(turns[1].answer.id,'update');assert.equal(turns[1].updateLabel,'进展更新');assert.equal(turns[1].user,undefined);assert.equal(conversationTurns(rows)[0].answer,'原回答');
});
test('child conversations show attributed work instructions while direct human input remains human',()=>{
  const rows=projectConversationOrigins([row('generated','user','请独立检查文件'),row('report','assistant','已检查'),row('human','user','新增要求'),row('answer','assistant','已更新')],[{...inputs[0],author:'coordinator'}],true);
  assert.equal(rows[0].role,'coordination');assert.equal(rows[2].role,'user');assert.equal(rows[2].collaborationGroupId,undefined);const turns=executionTurns(rows,{messages:[]},false);assert.equal(turns.length,2);assert.equal(turns[0].user.role,'coordination');assert.equal(turns[1].user.role,'user');assert.equal(conversationTurns(rows).length,2);
});

test('streaming progress retains its input group through deltas and durable handoff',()=>{
  const original=[row('human','user','原问题'),row('answer','assistant','原回答'),row('generated','user','内部成员报告')];
  const pending=projectConversationOrigins(original,inputs,false);
  const message={id:'live-progress',text:'新进展',thinking:'',ended:false};
  const first=mergeLiveRows(pending,{messages:[message]});assert.equal(first.at(-1).collaborationGroupId,'update-1');assert.equal(conversationTurns(first)[0].answer,'原回答');assert.equal(executionTurns(first,{messages:[]},true).at(-1).updateLabel,'进展更新');
  const updated=mergeLiveRows(pending,{messages:[{...message,text:'新进展已补齐'}]});assert.equal(updated.filter(row=>row.role==='assistant').length,2);assert.equal(conversationTurns(updated)[0].answer,'原回答');
  const durable=projectConversationOrigins([...original,{...row('saved','assistant','新进展已补齐'),messageId:message.id}],inputs,false);const settled=mergeLiveRows(durable,{messages:[{...message,text:'新进展已补齐',ended:true}]});assert.equal(settled.filter(row=>row.parts.some(part=>part.text==='新进展已补齐')).length,1);assert.equal(conversationTurns(settled)[0].answer,'原回答');
});

test('steering keeps preexisting live answers and tools with their original input until durable handoff',()=>{
  const old={...row('old','assistant','同样的回答'),messageId:'a1'};
  const source=[{...row('u','user','原要求'),messageId:'u1'},old,{...row('steer','user','新要求'),messageId:'u2'}];
  const tool={kind:'tool',text:'读取文件',toolCallId:'t1',toolName:'read'};
  old.parts.push(tool);
  const stream={messages:[{id:'a1',inputMessageId:'u1',text:'同样的回答',thinking:'',ended:true,parts:old.parts},{id:'a2',inputMessageId:'u2',text:'同样的回答',thinking:'',ended:false}],tools:[{id:'t1',inputMessageId:'u1',name:'read',input:'',output:'旧轮文件',state:'complete'}]};
  const merged=mergeLiveRows(source,stream);assert.deepEqual(merged.map(item=>item.id),['u','old','steer','live-a2']);
  const turns=executionTurns(merged,stream,true);assert.equal(turns[0].steps.filter(step=>step.id==='t1').length,1);assert.equal(turns[1].steps.filter(step=>step.id==='t1').length,0);assert.equal(turns[1].answer.messageId,'a2');
  const waiting=mergeLiveRows(source.filter(item=>item.id!=='old'),stream);assert.deepEqual(waiting.map(item=>item.id),['u','live-a1','steer','live-a2']);
  const saved=mergeLiveRows([...source,{...row('new','assistant','同样的回答'),messageId:'a2'}],{...stream,messages:stream.messages.map(message=>({...message,ended:true}))});assert.deepEqual(saved.map(item=>item.id),['u','old','steer','new']);
});
