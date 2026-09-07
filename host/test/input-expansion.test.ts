import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {PiHost} from '../src/pi-host.js';
import {templateArguments} from '../src/input-expansion.js';
import type {FoundationSnapshot,TaskBundle} from '../src/product-store.js';
import type {ExtensionUIBridge} from '../src/extension-ui.js';
const until=async(check:()=>Promise<boolean>)=>{const deadline=Date.now()+8000;while(!await check()){if(Date.now()>deadline)throw new Error('input did not finish');await new Promise(resolve=>setTimeout(resolve,20));}};
const completion=()=>new Response(`data: ${JSON.stringify({id:'input',object:'chat.completion.chunk',model:'fixture',created:1,choices:[{index:0,delta:{role:'assistant',content:'已按内容处理'},finish_reason:null}]})}\n\ndata: ${JSON.stringify({id:'input',object:'chat.completion.chunk',model:'fixture',created:1,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});

test('template arguments preserve quoted values and do not recursively substitute user input',()=>{
  assert.equal(templateArguments('$1 | $2 | ${3:-fallback} | ${@:2} | $ARGUMENTS','"two words" final'),'two words | final | fallback | final | two words final');
  assert.equal(templateArguments('$1 $2','$@ final'),'$@ final');
});

test('D Code discovers and expands selected skills/templates with original input receipts and routes standard extension requests to their runtime',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dcode-input-expansion-')),agent=join(root,'agent'),home=join(root,'home');await mkdir(home);await mkdir(join(agent,'skills','brief'),{recursive:true});await mkdir(join(agent,'prompts'));
  const skillPath=join(agent,'skills','brief','SKILL.md');await writeFile(skillPath,'---\nname: brief\ndescription: 简短说明\n---\n用两句话说明具体结果。');
  await writeFile(join(agent,'prompts','compare.md'),'---\ndescription: 比较两项\n---\n比较 $1 与 $2；原参数 $ARGUMENTS。');
  await writeFile(join(agent,'settings.json'),JSON.stringify({defaultProvider:'input-fixture',defaultModel:'fixture'}));await writeFile(join(agent,'models.json'),JSON.stringify({providers:{'input-fixture':{baseUrl:'https://input.invalid/v1',api:'openai-completions',apiKey:'fixture-only',models:[{id:'fixture',name:'Fixture',reasoning:false,input:['text'],contextWindow:100000,maxTokens:4096}]}}}));
  const originalFetch=globalThis.fetch;const requests:string[]=[];globalThis.fetch=(async(_url,init)=>{requests.push(String(init?.body));return completion();}) as typeof fetch;
  const host=new PiHost({agentDir:agent,sessionsDirectory:join(agent,'sessions'),dataRoot:join(root,'.dcode'),userHome:home,emit:()=>{}});const snapshot=()=>host.handle('foundation.snapshot',{}) as Promise<FoundationSnapshot>;
  try{
    await host.start();const available=await host.handle('dcodeSession.commands',{}) as {commands:Array<{name:string}>};assert.ok(available.commands.some(command=>command.name==='skill:brief'));assert.ok(available.commands.some(command=>command.name==='compare'));
    const initial=await snapshot();const task=await host.handle('task.create',{requestId:'task',expectedStoreRevision:initial.storeRevision,scope:{kind:'user',userId:initial.currentUser.id},title:'输入展开',goal:'保留原文并使用技能'}) as TaskBundle;
    const send=async(id:string,message:string)=>{await host.handle('dcodeSession.prompt',{dcodeSessionId:task.coordinationSession.id,promptId:id,message});await until(async()=>!(await snapshot()).sessionRuns.some(run=>['prepared','running'].includes(run.status)));};
    await send('skill','/skill:brief 说明文件修改');assert.ok(requests.at(-1)!.includes('用两句话说明具体结果'));assert.ok(requests.at(-1)!.includes('说明文件修改'));
    let snap=await snapshot();assert.equal(snap.promptReceipts.at(-1)?.inputSources?.[0]?.kind,'skill');assert.match(snap.promptReceipts.at(-1)?.inputSources?.[0]?.digest??'',/^sha256:/);
    const presentation=await host.handle('dcodeSession.presentation',{dcodeSessionId:task.coordinationSession.id}) as {runtime:{runtimeId:string};submissions:Array<{text:string;effectiveText:string;sourceEntryId?:string}>};assert.equal(presentation.submissions[0]?.text,'/skill:brief 说明文件修改');assert.ok(presentation.submissions[0]?.effectiveText.includes('用两句话'));assert.ok(presentation.submissions[0]?.sourceEntryId);
    await send('template','/compare "两项内容" 结果');assert.ok(requests.at(-1)!.includes('比较 两项内容 与 结果'));
    const count=requests.length;await send('status','/fast status');snap=await snapshot();assert.equal(requests.length,count,'registered commands do not require a Provider request');assert.equal(snap.sessionRuns.at(-1)?.status,'completed');assert.ok(snap.operationAttempts.some(attempt=>(attempt.outcome as {handledWithoutProvider?:boolean})?.handledWithoutProvider));
    const runtime=(host as unknown as {runtimes:Map<string,{ui:ExtensionUIBridge}>}).runtimes.get(presentation.runtime.runtimeId)!;
    const exercises=[
      {call:()=>runtime.ui.context.select('选择格式',['文档','清单']),response:{value:'清单'},result:'清单'},
      {call:()=>runtime.ui.context.confirm('确认内容','保留当前修改？'),response:{confirmed:true},result:true},
      {call:()=>runtime.ui.context.input('补充名称','请输入名称'),response:{value:'新名称'},result:'新名称'},
      {call:()=>runtime.ui.context.editor('修改说明','原说明'),response:{value:'改后的说明'},result:'改后的说明'},
    ];
    for(const exercise of exercises){const response=exercise.call();const dialog=(await snapshot()).runtimeDialogs?.[0];assert.ok(dialog);assert.equal(dialog.sessionId,task.coordinationSession.id);await assert.rejects(host.handle('extension.respond',{runtimeId:'wrong-runtime',requestId:dialog.requestId,response:exercise.response}));assert.equal((await snapshot()).runtimeDialogs?.length,1);await host.handle('extension.respond',{runtimeId:dialog.runtimeId,requestId:dialog.requestId,response:exercise.response});assert.equal(await response,exercise.result);assert.equal((await snapshot()).runtimeDialogs?.length,0);}
    await host.handle('clientPreferences.set',{requestId:'disable',expectedStoreRevision:(await snapshot()).storeRevision,disabledResources:[`skill:${skillPath}`]});
    await assert.rejects(send('disabled','/skill:brief 不应展开'),/已停用|不可用/);
    const db=new DatabaseSync(join(root,'.dcode','product-store.sqlite3'),{readOnly:true});try{const raw=db.prepare('SELECT submitted_text FROM raw_inputs ORDER BY ordinal').all() as Array<{submitted_text:string}>;assert.deepEqual(raw.map(row=>row.submitted_text),['/skill:brief 说明文件修改','/compare "两项内容" 结果','/fast status']);}finally{db.close();}
  }finally{await host.close();globalThis.fetch=originalFetch;await rm(root,{recursive:true,force:true});}
});
