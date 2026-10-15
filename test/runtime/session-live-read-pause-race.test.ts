// 真实PiExecutionSession + 原Harness/工具/JsonlStorage；只在公开observer返回Promise上注入等待。
// 固定Pi会缓存LiveDoc，因此不谎称每次snapshot都从Storage冷读；没有私有cache/unload入口。
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context, awaitWithContext } from '@earendil-works/chord/context';
import { createRegistry, defineTool, defineExtension, LiveDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';
import type { Harness, Storage, ToolExecutionApi } from '@earendil-works/pi-durable';
import { Type } from '@earendil-works/pi-ai';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { PiExecutionSession } from '../../src/adapters/pi/index.ts';
import type { PiSessionOptions } from '../../src/adapters/pi/index.ts';
import type { ExecutionView, WorkInput } from '../../src/contracts/index.ts';
import { controlledModels, until } from './fixtures.ts';

function deferred() {let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}

await test('Session真实LiveDoc observer等待窗：pause同步认领后，迟到read不能带新control恢复旧running partial', {timeout:15000}, async t=>{
  const directory=await mkdtemp(join(tmpdir(),'dcode-session-live-pause-'));
  const models=controlledModels(),nonce='REAL_TOOL_PARTIAL_'+randomUUID(),toolName='owned_live_pause_probe',callId='live-pause-call-'+randomUUID();
  const registry=createRegistry(),gate=deferred();let armed=false,gateEntered=false,gateHits=0,toolCalls=0,toolCancelled=false;
  let storage:Storage|undefined,harness:Harness|undefined;
  const pending:{unit?:PiExecutionSession;read?:Promise<ExecutionView>;pause?:Promise<ExecutionView>}={};
  let toolIdentity:Pick<ToolExecutionApi,'taskId'|'callId'|'conversationId'>|undefined;
  let atGate:{runTaskId:number|undefined;taskId:number|undefined;callId:string|undefined;output:string|undefined;status:string|undefined}|undefined;
  t.after(async()=>{
    gate.release();
    await Promise.allSettled([pending.read,pending.pause].filter((value):value is Promise<ExecutionView>=>value!==undefined));
    try{await pending.unit?.close();}finally{await rm(directory,{recursive:true,force:true});}
  });
  registry.install(defineExtension({name:'owned-live-pause-probe',tools:[defineTool({name:toolName,description:'Publish actual owned output then remain in the original tool invocation',parameters:Type.Object({}),replay:'unsafe',
    async execute(_args,api,ctx){
      toolCalls++;toolIdentity={taskId:api.taskId,callId:api.callId,conversationId:api.conversationId};
      api.output(nonce);
      try{await awaitWithContext(new Promise<void>(()=>undefined),ctx);}catch(error){toolCancelled=true;throw error;}
      throw new Error('Owned waiting tool must not complete before cancellation');
    },
  })]}));
  const options:PiSessionOptions={directory:join(directory,'runtime'),cwd:directory,target:{workspaceId:'space',taskId:'task',sessionId:'session'},
    models:models.models,registry,agent:{model:{provider:models.model.provider,modelId:models.model.id}},
    async openStorage(path){storage=await openNodeJsonlStorage(path,context,{fsync:true});return storage;},
    attachExecution(actual){
      harness=actual;
      // 既有公开装配口拿到原Harness；原方法真实读取其LiveDoc。只延后一次observer Promise的交回。
      actual.snapshot=new Proxy(actual.snapshot,{apply(original,self,args){
        const result=Reflect.apply(original,self,args);
        if(args[0]!==LiveDoc||args[1]!==ROOT_CONVERSATION_ID||!armed)return result;
        armed=false;gateHits++;
        return Promise.resolve(result).then(async live=>{
          const slot=live?.tools?.find((item:{callId?:string})=>item.callId===callId);
          atGate={runTaskId:live?.run?.taskId,taskId:slot?.taskId,callId:slot?.callId,output:slot?.output,status:slot?.status};
          gateEntered=true;await gate.promise;return live;
        });
      }});
    },
  };
  const unit=await PiExecutionSession.open(options);pending.unit=unit;
  const initial=await unit.read();const request:WorkInput={target:initial.target,operationId:'owned-live-pause-operation-'+randomUUID(),
    text:'Run the owned output tool and retain the original invocation',references:[],mode:'steer',expected:initial.control};
  assert.equal((await unit.submit(request)).status,'accepted');await until(()=>models.requests.length===1);
  models.requests[0].finish([{type:'toolCall',id:callId,name:toolName,arguments:{}}],'toolUse');
  await until(()=>toolCalls===1);
  let before:ExecutionView|undefined;
  await until(async()=>{before=await unit!.read();return before.phase==='running'&&before.toolProgress?.some(progress=>progress.callId===callId&&progress.name===toolName&&progress.text===nonce)===true;});
  assert.ok(before);assert.ok(toolIdentity);assert.equal(toolIdentity.callId,callId);assert.equal(toolIdentity.conversationId,ROOT_CONVERSATION_ID);
  const observed=before.toolProgress!.filter(progress=>progress.callId===callId);assert.equal(observed.length,1);assert.equal(observed[0].taskId,toolIdentity.taskId);
  assert.equal(before.entries.some(entry=>entry.toolResult?.callId===callId),false,'原工具保持等待，不能用正式结果伪造运行输出');
  assert.equal(toolCancelled,false);assert.equal(models.requests.length,1);assert.ok(harness);assert.ok(storage);

  // 用同一真实Storage公开接口核记录身份与真实提交正文。没有另开原目录或手造LiveState/TaskRecord。
  const record=await storage.findDocument({kind:LiveDoc.definition.kind,scope:{kind:'conversation',conversationId:ROOT_CONVERSATION_ID}},'current',context);
  assert.ok(record);assert.equal(record.kind,'pi.live');assert.deepEqual(record.scope,{kind:'conversation',conversationId:ROOT_CONVERSATION_ID});
  const stored=await storage.document(record.id,'current',context);assert.ok(stored);assert.equal(stored.record.id,record.id);
  assert.ok(JSON.stringify(stored.value).includes(nonce),'api.output确已提交原LiveDoc，而非测试手造输出');

  // 闸只在上述真实running/toolProgress已可读后启用。原工具只输出一次后等待，不再驱动另一个generation。
  armed=true;const pendingRead=unit.read();pending.read=pendingRead;void pendingRead.catch(()=>undefined);
  await until(()=>gateEntered);assert.equal(gateHits,1);assert.ok(atGate);
  assert.equal(atGate.taskId,toolIdentity.taskId);assert.equal(atGate.callId,callId);assert.equal(atGate.output,nonce);assert.equal(atGate.status,'running');assert.ok(Number.isSafeInteger(atGate.runTaskId));
  const pendingPause=unit.pause();pending.pause=pendingPause;void pendingPause.catch(()=>undefined);
  // pause()同步认领revision/pausing，但真正关闭仍排在原read后；此时工具还没有被取消。
  assert.equal(toolCancelled,false);assert.equal(toolCalls,1);assert.equal(models.requests.length,1);
  gate.release();const late=await pendingRead,paused=await pendingPause;
  assert.equal(gateHits,1);assert.equal(paused.phase,'paused');assert.equal(paused.toolProgress?.length??0,0);
  assert.equal(toolCancelled,true,'真实pause必须取消同一等待工具并join');assert.equal(toolCalls,1);assert.equal(models.requests.length,1,'暂停不能漏出下一模型请求');

  // 允许保留旧代次只读视图；不允许把旧running/partial与pause刚认领的较新控制令牌拼成一份视图。
  assert.ok(['running','pausing','paused'].includes(late.phase));
  if(late.phase==='running'){
    assert.deepEqual(late.control,before.control,'旧running/progress只能携原观测control，不能在await后偷读pause的新revision');
    assert.equal(late.toolProgress?.find(progress=>progress.callId===callId)?.text,nonce);
  }else{
    assert.equal(late.toolProgress?.length??0,0,'若认领到pausing/paused相位，必须去掉运行工具partial');
    assert.ok(late.control.instanceId!==before.control.instanceId||late.control.revision>=before.control.revision);
  }
  const current=await unit.read();assert.equal(current.phase,'paused');assert.equal(current.toolProgress?.length??0,0);assert.equal(models.requests.length,1);
  const receipt=await unit.lookupReceipt(request);assert.equal(receipt.status,'accepted','原已接收输入身份不会因等待窗被另建/撤销');
});
