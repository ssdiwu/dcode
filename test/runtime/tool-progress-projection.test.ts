// 仅受控ExecutionPort合同对抗；不代表真实Pi轮转、真实SDK/HTTP或桌面验证。
// 经公开DCodeApplication.send/getSnapshot/subscribe/pause/resume/updateSettings；没有getPrivate/私有入口。
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DCodeApplication } from '../../src/application/index.ts';
import { sampleState } from '../../src/adapters/mock/index.ts';
import type { AppSnapshot, InputReceipt } from '../../src/contracts/index.ts';
import type { ExecutionPort, ExecutionTarget, ExecutionView, PersistedState, StorageAdapter } from '../../src/application/types.ts';
import { until } from './fixtures.ts';

const sessionId='session-home-1';
const toolName='owned_stream_projection';
type Progress=NonNullable<ExecutionView['toolProgress']>[number];
const clone=<T>(value:T):T=>structuredClone(value);
function controlledPort() {
  let target:ExecutionTarget;
  let control={instanceId:'owned-progress-A',revision:0};
  let observation=0,phase:ExecutionView['phase']='ready',pendingInputs=0;
  let entries:ExecutionView['entries']=[],progress:unknown=[];
  let heldNext:{lateObservation:boolean;entered:boolean;release:()=>void;promise:Promise<void>}|undefined;
  const held=new Set<{release:()=>void}>();
  const counts={reads:0,lookups:0,submits:0,pauses:0,resumes:0,closes:0};
  const view=():ExecutionView=>({target:clone(target),control:clone(control),observation:++observation,phase,
    execution:'mock',model:null,entries:clone(entries),pendingInputs,toolProgress:clone(progress) as ExecutionView['toolProgress']});
  const receipt=(input:unknown):InputReceipt=>({status:'accepted',operationId:(input as {operationId:string}).operationId,
    submissionId:1,processing:phase==='ready'&&counts.submits>0?'done':'placed'});
  let nextPauseInstance:string|undefined;
  const port:ExecutionPort={
    get target(){return target;},
    async read(){
      counts.reads++;const captured=view(),gate=heldNext;heldNext=undefined;
      if(gate){gate.entered=true;await gate.promise;held.delete(gate);}
      return gate?.lateObservation?{...captured,observation:++observation}:captured;
    },
    async submit(input){counts.submits++;phase='running';pendingInputs=1;return receipt(input);},
    async lookupReceipt(input){counts.lookups++;return receipt(input);},
    async pause(){counts.pauses++;control={instanceId:nextPauseInstance??control.instanceId,revision:control.revision+1};nextPauseInstance=undefined;
      phase='paused';return view();},
    async resume(expected){assert.deepEqual(expected,control,'明确继续消费原应用最近控制令牌');counts.resumes++;
      control={...control,revision:control.revision+1};phase='running';pendingInputs=1;return view();},
    async close(){counts.closes++;},
  };
  return {port,counts,
    setTarget(value:ExecutionTarget){target=clone(value);},
    setProgress(value:unknown){progress=clone(value);},
    publish(value:{phase?:ExecutionView['phase'];entries?:ExecutionView['entries'];progress?:unknown;pendingInputs?:number}){
      if(value.phase!==undefined)phase=value.phase;if(value.entries!==undefined)entries=clone(value.entries);
      if(Object.hasOwn(value,'progress'))progress=clone(value.progress);if(value.pendingInputs!==undefined)pendingInputs=value.pendingInputs;
    },
    holdRead(lateObservation=false){
      assert.equal(heldNext,undefined);let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});
      const gate={lateObservation,entered:false,release,promise};heldNext=gate;held.add(gate);return gate;
    },
    pauseInto(instanceId:string){nextPauseInstance=instanceId;},
    releaseAll(){for(const gate of held)gate.release();held.clear();heldNext=undefined;},
  };
}
async function fixture() {
  const remote=controlledPort(),saved:PersistedState[]=[],pushes:AppSnapshot[]=[];
  const storage:StorageAdapter={async load(){return {status:'missing'};},async save(state){saved.push(clone(state));}};
  const initial=()=>{const state=sampleState();
    // 仅内存测试前置；适配端不做IO，也不把样例的真实Home字符串交给任何文件实现。
    state.workspaces=state.workspaces.filter(item=>item.id==='ws-home').map(item=>({...item,folders:['/controlled-no-io/progress-project']}));
    state.tasks=state.tasks.filter(item=>item.id==='task-home-default');state.sessions=state.sessions.filter(item=>item.id===sessionId);
    state.timelines={[sessionId]:state.timelines[sessionId]};state.runs={[sessionId]:state.runs[sessionId]};return state;};
  const app=new DCodeApplication({kind:'mock',modelName:'controlled-progress',async open(context){remote.setTarget(context.target);
    assert.equal(context.workFolder,'/controlled-no-io/progress-project');return remote.port;}},storage,initial);
  app.subscribe(snapshot=>pushes.push(clone(snapshot)));await app.init();
  return {app,remote,saved,pushes,
    async start(observed=true){const result=await app.sendMessage({sessionId,text:'Observe the original owned stream',mode:'follow-up',operationId:'progress-operation-'+randomUUID()});
      assert.equal(result.sessionId,sessionId);assert.equal(result.receipt.status,'accepted');if(observed)await until(()=>remote.counts.lookups>0);return result;},
    async close(){remote.releaseAll();await app.flush();},
  };
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function live(snapshot:AppSnapshot){return snapshot.timelines[sessionId].filter(block=>block.kind==='tool'&&block.id.startsWith('pi-progress-'));}
function ownTools(snapshot:AppSnapshot){return snapshot.timelines[sessionId].filter(block=>block.kind==='tool'&&block.tool.name===toolName);}
function usage(snapshot:AppSnapshot){const taskId=snapshot.sessions.find(item=>item.id===sessionId)!.taskId;
  return clone({session:snapshot.sessionModels[sessionId]?.usage,requests:snapshot.sessionModels[sessionId]?.requests,
    task:snapshot.taskUsage[taskId]?.totals});}
function assertNeverPersistedProgress(f:Fixture,partialText:string){
  assert.ok(f.saved.length>0);for(const state of f.saved){
    assert.equal(Object.hasOwn(state,'toolProgress'),false);assert.equal(JSON.stringify(state).includes('pi-progress-'),false);
    assert.equal(JSON.stringify(state).includes(partialText),false,'纯运行partial不得被任一真实save入参带入历史/用量/产品状态');
  }
}
const item=(text:string):Progress=>({taskId:101,callId:'actual-owned-call',name:toolName,text,droppedBytes:0,droppedLines:0});
async function show(f:Fixture,progress:Progress){
  const before=f.pushes.length;f.remote.setProgress([progress]);
  await until(()=>f.pushes.slice(before).some(snapshot=>live(snapshot).some(block=>block.kind==='tool'&&block.tool.output===progress.text)));
  const snapshot=await f.app.getSnapshot(),blocks=live(snapshot);assert.equal(blocks.length,1);assert.equal(blocks[0].kind,'tool');
  if(blocks[0].kind==='tool'){assert.equal(blocks[0].tool.status,'running');assert.equal(blocks[0].tool.output,progress.text);assert.deepEqual(blocks[0].tool.changedFiles,[]);
    assert.deepEqual(blocks[0].tool.outputTruncation,progress.droppedBytes||progress.droppedLines?{droppedBytes:progress.droppedBytes,droppedLines:progress.droppedLines}:undefined);}
  return snapshot;
}

await test('运行工具partial：公开快照/推送可见但每次save均不落历史/usage；正式结果替换临时块',async(t)=>{
  const f=await fixture();t.after(()=>f.close());await f.start();const baseline=await f.app.getSnapshot(),beforeUsage=usage(baseline);
  const partial='PARTIAL_ONLY_'+randomUUID(),progress=item(partial);await show(f,progress);
  await show(f,{...progress,droppedBytes:7,droppedLines:1}); // 纯text保持，截断只走正式metadata/双语UI消费。
  const shown=await f.app.getSnapshot();assert.deepEqual(usage(shown),beforeUsage);
  assert.deepEqual(shown.timelines[sessionId].filter(block=>!block.id.startsWith('pi-progress-')),baseline.timelines[sessionId],
    '临时显示不能追加fake正式工具/assistant/输入');
  const writeCount=f.saved.length;await f.app.updateSettings({theme:'light'});assert.ok(f.saved.length>writeCount,'真正让公开设置保存到达storage.save后核入参');
  assertNeverPersistedProgress(f,partial);assert.equal(live(await f.app.getSnapshot()).length,1,'保存普通设置不能吞掉仍在途partial');
  const final='FORMAL_TOOL_RESULT_'+randomUUID();const result:ExecutionView['entries'][number]={id:700001,kind:'pi.tool-result',data:{},
    toolResult:{name:toolName,callId:progress.callId,text:final,isError:false,changes:[]}};
  f.remote.publish({phase:'running',entries:[result],progress:[progress]});
  await until(async()=>ownTools(await f.app.getSnapshot()).some(block=>block.kind==='tool'&&block.tool.status==='done'));
  const completed=await f.app.getSnapshot(),tools=ownTools(completed);assert.equal(tools.length,1);assert.equal(live(completed).length,0);
  assert.equal(tools[0].id,'pi-tool-700001');if(tools[0].kind==='tool'){assert.equal(tools[0].tool.output,final);assert.equal(tools[0].tool.status,'done');}
  assert.deepEqual(usage(completed),beforeUsage,'受控正式ToolResult未给模型费用，不能由partial猜usage');
  await f.app.updateSettings({theme:'dark'});assertNeverPersistedProgress(f,partial);
  const diskTools=f.saved.at(-1)!.timelines[sessionId].filter(block=>block.kind==='tool'&&block.tool.name===toolName);
  assert.equal(diskTools.length,1);assert.equal(diskTools[0].id,'pi-tool-700001');assert.equal(f.remote.counts.submits,1);
});

await test('paused/ready清除纯运行工具：即使执行视图仍携旧progress，也不留作正式结果',async(t)=>{
  const f=await fixture();t.after(()=>f.close());await f.start();const partial='PHASE_PARTIAL_'+randomUUID(),progress=item(partial);
  await show(f,progress);await f.app.pauseRun({sessionId});const paused=await f.app.getSnapshot();assert.equal(paused.runs[sessionId].status,'paused');assert.equal(live(paused).length,0);assert.equal(ownTools(paused).length,0);
  await f.app.updateSettings({theme:'light'});assertNeverPersistedProgress(f,partial);
  await f.app.resumeRun({sessionId});await until(async()=>live(await f.app.getSnapshot()).length===1);
  assert.equal(f.remote.counts.resumes,1,'只有这次公开明确继续进入resume');
  f.remote.publish({phase:'ready',pendingInputs:0,progress:[progress]});
  await until(async()=>(await f.app.getSnapshot()).runs[sessionId].status==='ready');const ready=await f.app.getSnapshot();assert.equal(live(ready).length,0);assert.equal(ownTools(ready).length,0);
  await f.app.updateSettings({theme:'dark'});assertNeverPersistedProgress(f,partial);assert.equal(f.remote.counts.submits,1);
});

await test('控制新鲜度：旧observation/已见旧instance/低revision的迟到read都不能复活paused partial',async()=>{
  for(const mode of ['old-observation','retired-instance','lower-revision-higher-observation'] as const){
    const f=await fixture();try{
      await f.start();const partial='STALE_PARTIAL_'+mode+'_'+randomUUID();await show(f,item(partial));
      // 真正扣住公开read的返回；用户pause在此await窗口内完成，不直接调用应用私有applyView。
      const gate=f.remote.holdRead(mode==='lower-revision-higher-observation');await until(()=>gate.entered);
      if(mode==='retired-instance')f.remote.pauseInto('owned-progress-B');
      await f.app.pauseRun({sessionId});const paused=await f.app.getSnapshot();assert.equal(paused.runs[sessionId].status,'paused');assert.equal(live(paused).length,0);
      const boundary=f.pushes.length,lookups=f.remote.counts.lookups;gate.release();
      // syncSession在applyView之后才调用公开lookupReceipt；到达该阶段能辨别被测旧read确已消费，非仅等一段时间。
      await until(()=>f.remote.counts.lookups>lookups);const after=await f.app.getSnapshot();
      assert.equal(after.runs[sessionId].status,'paused',mode+':迟到旧视图不能回滚暂停');assert.equal(live(after).length,0,mode+':旧partial不能复活');
      assert.ok(f.pushes.slice(boundary).every(snapshot=>live(snapshot).length===0),mode+':短暂旧显示也不能发给订阅者');
      assert.equal(f.remote.counts.pauses,1);assert.equal(f.remote.counts.resumes,0);assert.equal(f.remote.counts.submits,1);
      await f.app.updateSettings({theme:'light'});assertNeverPersistedProgress(f,partial);
    }finally{await f.close();}
  }
});

await test('不可信progress有限字段：null/数值/空身份拒绝，不能污染同批合法项或制造历史/usage',async(t)=>{
  const f=await fixture();t.after(()=>f.close());const partial='VALID_FINITE_PARTIAL_'+randomUUID(),valid=item(partial);
  const malformed:unknown[]=[null,{...valid,taskId:Number.MAX_SAFE_INTEGER+1},{...valid,taskId:202,droppedBytes:Infinity},
    {...valid,taskId:203,text:42},{...valid,taskId:204,callId:''},{...valid,taskId:205,name:''}];
  f.remote.setProgress([...malformed,valid]);await f.start(false);
  // send后的首次running是接收阶段的正面确认；坏null即使令整次sync抛错，也必须在下面以0!=1可辨失败，不能只靠超时。
  await until(async()=>(await f.app.getSnapshot()).runs[sessionId].status==='running');const current=await f.app.getSnapshot(),blocks=live(current);
  assert.equal(blocks.length,1,'坏字段逐项拒绝，同一已消费running视图的合法项必须仍可见');
  assert.equal(blocks[0].kind,'tool');if(blocks[0].kind==='tool'){assert.equal(blocks[0].tool.name,toolName);assert.equal(blocks[0].tool.output,partial);assert.equal(blocks[0].tool.status,'running');}
  const measured=usage(current);assert.equal(measured.requests?.length??0,0,'受控端口未提供任何真实模型请求事实');
  for(const totals of [measured.session,measured.task])if(totals){assert.equal(totals.input,0);assert.equal(totals.output,0);assert.equal(totals.cacheRead,0);assert.equal(totals.cacheWrite,0);assert.equal(totals.requests,0);}
  assert.equal(current.timelines[sessionId].filter(block=>block.kind==='message'&&block.role==='assistant'&&block.text.includes(partial)).length,0);
  await f.app.updateSettings({theme:'light'});assertNeverPersistedProgress(f,partial);assert.equal(f.remote.counts.submits,1);
});
