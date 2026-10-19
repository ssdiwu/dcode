import { ToolTask, ToolResultEntry, UsageDoc, defineDoc, defineDocFamily, defineEntry } from '@earendil-works/pi-durable';
import type { defineTask, ToolExecutionResult, ToolHooks, JsonObject, Tx, TaskId, ConversationId, Session, TaskRecord, EntryId, Cursor } from '@earendil-works/pi-durable';
import type { Context, JsonValue } from '@earendil-works/chord';
import type { ToolCall, Usage, AssistantMessage, AssistantImages } from '@earendil-works/pi-ai';
import { CodingResourcesUnavailable } from './coding-resources';
import { classifierResult } from './classifier-bridge';
import { imagesResult } from './images-bridge';
import { json } from './coding-extension-protocol';

// 只定义原持久协议及事务；活动调用、响应内存认领和生命周期仍由CodingExtensions唯一持有。
export const nestedExtensionTaskName = 'dcode.extension-tool';
export const extensionModelTaskName = 'dcode.extension-model';
export type NestedInput = { caller: string; call: ToolCall };
export type ModelInput = { caller: string; actionId: string; ownerTaskId: number; provider: string; modelId: string; input: JsonObject; options: JsonObject; mode?: 'complete' | 'streamSimple' | 'stream' | 'classify' | 'generateImages' };
export type ImageResponseReceipt = { childId:number; ownerId:number; conversationId:number; actionId:string; caller:string; requestId:string; metadata:JsonSafe<Omit<AssistantImages,'output'>> };
type JsonSafe<T> = T extends string | number | boolean | null | undefined ? T : T extends object ? { [K in keyof T]: JsonSafe<T[K]> } : T;

export const ExtensionModelResult = defineEntry<JsonObject>('dcode.extension-model-result');
export const ExtensionTypedModelResult = defineEntry<JsonObject>('dcode.extension-typed-model-result');
export const ExtensionModelSpend = defineDoc<{usages:Record<string,JsonValue>}>({kind:'dcode.extension-model-spend',version:1,scope:'task',initial:()=>({usages:{}})});
// 这里只存原模型子任务的消费回执；累计数仍只有官方UsageDoc。
export const ModelSpendAccounted = defineDocFamily<{done:boolean;response?:ImageResponseReceipt;publishedToOwner?:boolean;typedPublished?:boolean},null>({kind:'dcode.extension-model-accounted',version:1,scope:'conversation',history:'latest',fork:'current',family:true,initial:()=>({done:false})});

export function sumUsage(reported: readonly Usage[]): Usage | undefined {
  if (!reported.length) return undefined;
  const total = json(reported[0]);
  for (const usage of reported.slice(1)) {
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const) total[key] += usage[key];
    for (const key of ['reasoning', 'cacheWrite1h'] as const) if (usage[key] !== undefined) total[key] = (total[key] ?? 0) + usage[key];
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const) total.cost[key] += usage.cost[key];
  }
  return total;
}

export async function settleNestedTool(input: NestedInput, runtime: Parameters<NonNullable<ReturnType<typeof defineTask<NestedInput, { phase: 'call' | 'execute' }, ToolExecutionResult, ToolHooks>>['definition']['abort']>>[1], result: ToolExecutionResult, status: 'completed' | 'aborted' | 'failed', ctx: Context) {
  await runtime.commit(async tx => {
    const spend = await tx.doc(ExtensionModelSpend, runtime.taskId);
    const usage = sumUsage(Object.values(spend.usages) as unknown as Usage[]);
    if (usage) result = {...result,usage};
    // 内层是扩展真正发起的调用，不伪造模型 assistant；正式工具记录仍写入同一 Session。
    await tx.appendEntry(ToolResultEntry, runtime.conversationId, {
      model: [{ role: 'toolResult', toolName: input.call.name, toolCallId: input.call.id,
        content: result.output ?? [], isError: result.isError ?? false, timestamp: Date.now(),
        ...(result.details === undefined ? {} : { details: result.details }), ...(result.usage ? {usage:result.usage} : {}) }], data: { diagnostics: json([...(result.diagnostics ?? [])]) },
    });
    if (result.usage) {
      // 复用公开工具用量文档；手动的内层工具任务没有SDK ToolTask自动记账步骤。
      const tools = (await tx.doc(UsageDoc, runtime.conversationId)).tools;
      const previous = Object.hasOwn(tools, input.call.name) ? tools[input.call.name] : undefined;
      const fresh:Usage[]=[];
      for(const [childId,value] of Object.entries(spend.usages)){
        const receipt=await tx.doc(ModelSpendAccounted,runtime.conversationId,childId,null);
        if(!receipt.done){fresh.push(value as unknown as Usage);receipt.done=true;}
      }
      const addition=Object.keys(spend.usages).length?sumUsage(fresh):result.usage;
      // Chord文档是事务草稿，仅支持字段赋值；重建记录也保工具名为自有键。
      if(addition)(await tx.doc(UsageDoc, runtime.conversationId)).tools = {...tools, [input.call.name]:sumUsage(previous ? [previous as Usage, addition] : [addition])!};
    }
    return { status: 'terminal', outcome: status === 'failed' ? { status, error: { code: 'extension-tool-interrupted', message: '内部工具中断，保留部分作用且不重放' }, result: json(result) } : { status, result: json(result) } };
  }, ctx);
}

export async function saveImageResponse(tx:Tx,response:ImageResponseReceipt):Promise<void>{
  const child=await tx.task(response.childId as TaskId);
  const input=child?.input as unknown as ModelInput|undefined;
  if(!child||child.kind!==extensionModelTaskName||child.conversationId!==response.conversationId||child.owner!==response.ownerId
    ||!input||input.mode!=='generateImages'||input.ownerTaskId!==response.ownerId||input.actionId!==response.actionId||input.caller!==response.caller
    ||input.provider!==response.metadata.provider||input.modelId!==response.metadata.model)throw new CodingResourcesUnavailable();
  const owner=await tx.task(response.ownerId as TaskId);
  if(!owner||owner.conversationId!==child.conversationId||![ToolTask.definition.name,nestedExtensionTaskName].includes(owner.kind))throw new CodingResourcesUnavailable();
  const receipt=await tx.doc(ModelSpendAccounted,child.conversationId,String(child.id),null);
  if(receipt.response&&JSON.stringify(receipt.response)!==JSON.stringify(response))throw new CodingResourcesUnavailable();
  if(!receipt.response)receipt.response=json(response);
}

export async function publishImageResult(tx:Tx,response:ImageResponseReceipt,typed:AssistantImages,isCurrent:()=>boolean=()=>true):Promise<void>{
  const receipt=await tx.doc(ModelSpendAccounted,response.conversationId as ConversationId,String(response.childId),null);
  const spend=typed.usage?await tx.doc(ExtensionModelSpend,response.ownerId as TaskId):undefined;
  if(!isCurrent())throw new CodingResourcesUnavailable();
  if(!receipt.typedPublished){
    await tx.appendEntry(ExtensionTypedModelResult,response.conversationId as ConversationId,{data:json({operation:'generateImages',requestId:response.requestId,typed}) as unknown as JsonObject});
    receipt.typedPublished=true;
  }
  if(typed.usage&&spend)spend.usages[String(response.childId)]=json(typed.usage) as unknown as JsonValue;
  receipt.publishedToOwner=true;
  if(!isCurrent())throw new CodingResourcesUnavailable();
}

/** 仅由原会话在调度停止后的暂停/关闭，或明确继续前调用；读取历史不对账。 */
export async function reconcileExtensionModelSpend(session:Session,ctx:Context,pending:readonly ImageResponseReceipt[]):Promise<void>{
  await session.commit(async tx=>{
    for(const response of pending)await saveImageResponse(tx,response);
    const groups=new Map<number,TaskRecord<JsonValue,JsonValue,JsonValue>[]>();let cursor:Cursor|undefined;
    const interrupted: {conversationId:ConversationId;data:JsonObject}[]=[];
    do{
      const page=await tx.scanTasks({kind:extensionModelTaskName},200,cursor);
      for(const child of page.items){
        const input=child.input as unknown as ModelInput;
        const imageReceipt=input.mode==='generateImages'?await tx.doc(ModelSpendAccounted,child.conversationId,String(child.id),null):undefined;
        if(child.state.status!=='terminal'||child.state.outcome.status!=='completed'){if(!imageReceipt?.response)continue;}
        if(input.mode==='generateImages'&&imageReceipt?.response&&!imageReceipt.typedPublished){
          // Durable表读取必须先于首个append；先收集，完成全部owner/正式工具核对后统一写。
          interrupted.push({conversationId:child.conversationId,data:json({operation:'generateImages',requestId:imageReceipt.response.requestId,typed:{...imageReceipt.response.metadata,output:[],stopReason:'aborted',errorMessage:'图片响应已到但核验未完成；不自动重发'}}) as unknown as JsonObject});
          imageReceipt.typedPublished=true;
        }
        if(child.owner!==input.ownerTaskId)throw new CodingResourcesUnavailable();
        const own=groups.get(input.ownerTaskId)??[];own.push(child);groups.set(input.ownerTaskId,own);
      }cursor=page.next;
    }while(cursor);
    for(const [ownerId,children] of groups){
      const receipts=await Promise.all(children.map(child=>tx.doc(ModelSpendAccounted,child.conversationId,String(child.id),null)));
      if(receipts.every(receipt=>receipt.done))continue;
      const owner=await tx.task(ownerId as import('@earendil-works/pi-durable').TaskId);
      if(!owner||children.some(child=>child.conversationId!==owner.conversationId))throw new CodingResourcesUnavailable();
      let name:string;let callId:string;
      if(owner.kind===ToolTask.definition.name){
        const input=owner.input as {assistant:number;callId:string};
        const assistant=await tx.entry(input.assistant as EntryId);
        const message=assistant?.model?.find(value=>value.role==='assistant');
        const call=message?.role==='assistant'?message.content.find(value=>value.type==='toolCall'&&value.id===input.callId):undefined;
        if(!call||call.type!=='toolCall')throw new CodingResourcesUnavailable();name=call.name;callId=call.id;
        if(owner.state.status!=='terminal'&&owner.state.status!=='completing'&&(owner.state.checkpoint as JsonObject).replay!=='unsafe')throw new CodingResourcesUnavailable();
      }else if(owner.kind===nestedExtensionTaskName){
        const call=(owner.input as unknown as NestedInput).call;name=call.name;callId=call.id;
      }else throw new CodingResourcesUnavailable();
      const confirmed=children.map((child,index)=>{
        if(receipts[index].response)return receipts[index].response!.metadata.usage;
        if(child.state.status!=='terminal'||child.state.outcome.status!=='completed')throw new CodingResourcesUnavailable();
        const result=child.state.outcome.result as unknown as {message?:AssistantMessage;operation?:string;typed?:unknown};
        if(result.operation==='classify')return classifierResult(result.typed).usage;
        if(result.operation==='generateImages')return imagesResult(result.typed).usage;
        const message=result.message;
        if(message?.role!=='assistant'||!message.usage)throw new CodingResourcesUnavailable();return message.usage;
      });
      // 原SDK正常终态已经与ToolResult同事务记账；取消/unsafe恢复不经afterTool。
      let recorded:Usage|undefined;let entryCursor:Cursor|undefined;
      do{const page=await tx.scanEntries({conversationId:owner.conversationId},200,entryCursor);
        for(const entry of page.items)if(entry.byTaskId===owner.id&&entry.kind===ToolResultEntry.kind){
          const result=entry.model?.find(value=>value.role==='toolResult'&&value.toolCallId===callId);
          if(result?.role==='toolResult'){if(result.toolName!==name)throw new CodingResourcesUnavailable();recorded=result.usage;}
        }entryCursor=page.next;
      }while(entryCursor);
      if(recorded&&JSON.stringify(recorded)!==JSON.stringify(sumUsage(confirmed.filter((usage,index): usage is Usage => usage !== undefined&&(!receipts[index].response||receipts[index].publishedToOwner===true)))))throw new CodingResourcesUnavailable();
      const fresh:Usage[]=[];
      for(let index=0;index<children.length;index++){
        const receipt=receipts[index];
        if(!receipt.done){if((!recorded||!!receipt.response&&!receipt.publishedToOwner)&&confirmed[index])fresh.push(confirmed[index]!);receipt.done=true;}
      }
      const addition=sumUsage(fresh);
      if(addition){const usage=await tx.doc(UsageDoc,owner.conversationId);const previous=Object.hasOwn(usage.tools,name)?usage.tools[name] as Usage:undefined;
        usage.tools={...usage.tools,[name]:sumUsage(previous?[previous,addition]:[addition])!};}
    }
    for(const entry of interrupted)await tx.appendEntry(ExtensionTypedModelResult,entry.conversationId,{data:entry.data});
  },ctx);
}
