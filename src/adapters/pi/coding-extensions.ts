import { Worker } from 'node:worker_threads';
import { mkdir, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import type { Context, JsonValue } from '@earendil-works/chord';
import { GenerationTask, ToolTask, ToolResultEntry, UsageDoc, defineDoc, defineDocFamily, defineEntry, defineExtension, defineTask, defineTool, hook } from '@earendil-works/pi-durable';
import type { Conversation, Harness, JsonObject, Registry, Session, ToolExecutionApi, ToolExecutionResult, ToolHooks, ToolRegistration } from '@earendil-works/pi-durable';
import { validateToolArguments } from '@earendil-works/pi-ai/utils/validation';
import type { ToolCall, TSchema } from '@earendil-works/pi-ai';
import type { ModelRuntime, BeforeAgentStartEventResult, VirtualModelDefinition, ModelRouteRequest } from '@earendil-works/pi-coding-agent';
import { CodingResourcesUnavailable } from './coding-resources';
import { extensionWorkerSource } from './extension-worker';
import type { CodingProviderHeaders } from './coding-provider-headers';
import { taskToolApi } from './task-tool-api';
import type { DurableModelRouting } from './durable-routing';
import { parseWorkImages } from '@/contracts/index.ts';
import type { InputPreparation, PreparedInput } from './input-preparation';
import type { HookApi, EntryRecord, Cursor, TaskRecord, EntryId, Tx, ConversationId } from '@earendil-works/pi-durable';
import type { Api, Model, ImageContent, Message, AssistantMessage, Usage, Models } from '@earendil-works/pi-ai';

// 只投影 SDK chat 模型的公开描述；原认证与执行请求头仍由宿主 ModelRuntime 持有。
function modelMetadata(model: ReturnType<ModelRuntime['getModels']>[number]) {
  const { id, name, api, provider, baseUrl, input, inputLimits, cost, type, reasoning,
    thinkingLevelMap, promptCache, contextWindow, maxTokens, samplingParams, compat } = model;
  return JSON.parse(JSON.stringify({ id, name, api, provider, baseUrl, input, inputLimits, cost, type,
    reasoning, thinkingLevelMap, promptCache, contextWindow, maxTokens, samplingParams, compat },
    (key, value: unknown) => /^(headers|apikey|authorization|credentials?|env)$/i.test(key) ? undefined : value)) as JsonValue;
}

const context = BACKGROUND_CONTEXT;
const ExtensionEntry = defineEntry<JsonObject>('dcode.extension-entry');
const ExtensionModelResult = defineEntry<JsonObject>('dcode.extension-model-result');
const ExtensionModelSpend = defineDoc<{usages:Record<string,JsonValue>}>({kind:'dcode.extension-model-spend',version:1,scope:'task',initial:()=>({usages:{}})});
// 这里只存原模型子任务的消费回执；累计数仍只有官方UsageDoc。
const ModelSpendAccounted = defineDocFamily<{done:boolean},null>({kind:'dcode.extension-model-accounted',version:1,scope:'conversation',history:'latest',fork:'current',family:true,initial:()=>({done:false})});
const Action = defineDocFamily<{fingerprint:string;applied:boolean;entryId:number},string>({kind:'dcode.extension-action',version:1,scope:'session',family:true,initial:fingerprint=>({fingerprint,applied:false,entryId:-1})});
const Turn = defineDocFamily<{ started: boolean; finished: boolean; messages: JsonValue[] }, null>({ kind: 'dcode.extension-turn', version: 1, scope: 'session', family: true, initial: () => ({ started: false, finished: false, messages: [] }) });
const RequestRound=defineDoc<{assistant:number}>({kind:'dcode.extension-request-round',version:1,scope:'task',initial:()=>({assistant:0})});
type Descriptor = { name: string; description: string; parameters: TSchema; exposure: string; defaultActive?: boolean; constrainedSampling?: import('@earendil-works/pi-ai').ConstrainedSamplingConfig | false; hasPrepareArguments?: boolean };
type NestedInput = { caller: string; call: ToolCall };
type ModelInput = { caller: string; actionId: string; ownerTaskId: number; provider: string; modelId: string; input: JsonObject; options: JsonObject; mode?: 'complete' | 'streamSimple' };
type RuntimeBinding = { harness: Harness; root: Conversation; ownedModel?: DurableModelRouting['withOwnedModelInvocation'] };
type ModelCall = { caller: string; origin: Worker; task?: import('@earendil-works/pi-durable').TaskId; signal?: AbortSignal; aborted: boolean; seq: number };
type VirtualRegistration = { provider: string; id: string; handle: string; origin: Worker; model?: Model<Api> };
const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const virtualKey = (provider: string, id: string) => JSON.stringify([provider, id]);
function virtualDefinition(value: unknown): Omit<VirtualModelDefinition, 'route'> {
  const def = bounded(value, 64 * 1024) as Record<string, unknown>;
  const text = (v: unknown, max: number) => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\x00-\x1f]/.test(v);
  if (!def || typeof def !== 'object' || Array.isArray(def)
    || Object.keys(def).some(key => !['provider', 'id', 'name', 'thinkingLevels', 'contextWindow', 'maxTokens', 'input'].includes(key))
    || !text(def.provider, 128) || !text(def.id, 256) || !text(def.name, 256)
    || ['contextWindow', 'maxTokens'].some(key => def[key] !== undefined && (!Number.isSafeInteger(def[key]) || (def[key] as number) < 0))
    || (def.thinkingLevels !== undefined && (!Array.isArray(def.thinkingLevels) || def.thinkingLevels.length > 7 || def.thinkingLevels.some(level => !thinkingLevels.includes(level))))
    || (def.input !== undefined && (!Array.isArray(def.input) || def.input.length > 2 || def.input.some(type => type !== 'text' && type !== 'image')))) throw new CodingResourcesUnavailable();
  return def as unknown as Omit<VirtualModelDefinition, 'route'>;
}
type ArgumentMemo = {source:string;name:string;inputHash:string;prepared:JsonValue;failed:boolean};
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function sumUsage(reported: readonly Usage[]): Usage | undefined {
  if (!reported.length) return undefined;
  const total = json(reported[0]);
  for (const usage of reported.slice(1)) {
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const) total[key] += usage[key];
    for (const key of ['reasoning', 'cacheWrite1h'] as const) if (usage[key] !== undefined) total[key] = (total[key] ?? 0) + usage[key];
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const) total.cost[key] += usage.cost[key];
  }
  return total;
}
function bounded(value: unknown, maxBytes = 8 * 1024 * 1024): unknown {
  const text = JSON.stringify(value);
  if (!text || Buffer.byteLength(text) > maxBytes) throw new CodingResourcesUnavailable();
  return JSON.parse(text) as unknown;
}
function toolResult(value: unknown): ToolExecutionResult {
  const result = bounded(value) as Record<string, unknown>;
  if (!result || typeof result !== 'object' || !Array.isArray(result.content)) throw new CodingResourcesUnavailable();
  for (const part of result.content as Record<string, unknown>[]) {
    if (!part || (part.type === 'text' ? typeof part.text !== 'string' : part.type !== 'image'
      || typeof part.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(part.data)
      || !['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp'].includes(String(part.mimeType)))) throw new CodingResourcesUnavailable();
  }
  // 写正式结果前与投影接收同一图片合同，非法图片不能先污染历史、再使会话读取失败。
  parseWorkImages((result.content as Record<string, unknown>[]).filter(part=>part.type==='image').map(part=>({type:'image',data:part.data,mimeType:part.mimeType})));
  if (result.isError !== undefined && typeof result.isError !== 'boolean') throw new CodingResourcesUnavailable();
  return { content: result.content as NonNullable<ToolExecutionResult['content']>,
    ...(result.isError === undefined ? {} : { isError: result.isError as boolean }),
    ...((result.details === undefined && result.structuredContent === undefined) ? {} : { details: { ...(result.details && typeof result.details === 'object' && !Array.isArray(result.details) ? result.details as JsonObject : {}), ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent as JsonValue }) } }) };
}

type StartMessage = NonNullable<BeforeAgentStartEventResult['message']>;
function startedResult(value: unknown) {
  const result = bounded(value) as {messages:Message[];customMessages:StartMessage[]};
  if(!Array.isArray(result.messages)||!Array.isArray(result.customMessages)||result.messages.some(m=>m.role!=='system'||typeof m.content!=='string'))throw new CodingResourcesUnavailable();
  const customs=result.customMessages.map(value=>{
    const message=bounded(value,1024*1024) as StartMessage;
    if(!message||typeof message.customType!=='string'||!message.customType.length||message.customType.length>128||typeof message.display!=='boolean')throw new CodingResourcesUnavailable();
    if(typeof message.content!=='string')toolResult({content:message.content});
    return {message,model:{role:'user' as const,content:message.content,timestamp:Date.now()}};
  });
  return {system:result.messages,customs,messages:[...result.messages,...customs.map(item=>item.model)] as Message[]};
}
async function appendStartedMessages(tx:Tx,conversationId:ConversationId,started:ReturnType<typeof startedResult>,input:JsonObject) {
  // 同一次原输入消费保 CustomMessage 元数据与模型贡献；可见消息不是新输入，也不伪造助手。
  for(const {message,model} of started.customs)await tx.appendEntry(ExtensionEntry,conversationId,{data:json({action:'message',value:{message,source:'before_agent_start',input}}) as JsonObject,model:[model]});
}

/** 普通 ExtensionRunner 的有限线程桥；宿主只持有同一 Harness/registry，不创建 AgentSession。 */
export class CodingExtensions {
  #worker?: Worker;
  #binding?: RuntimeBinding;
  #registry?: Registry;
  #publication: Promise<void> = Promise.resolve();
  #next = 0;
  #pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; abort?: () => void }>();
  #calls = new Map<string, { api: ToolExecutionApi; context: Context; nested: JsonValue[]; models: AssistantMessage[] }>();
  #modelCalls = new Map<string, ModelCall>();
  #virtuals = new Map<string, VirtualRegistration>();
  #providerClaims = new Map<string, { origin: Worker; handle: string; claim: object }>();
  #events = new Map<string, { api?: HookApi; context: Context }>();
  #tools: Descriptor[] = [];
  #active: string[] = [];
  #declarations: string[] = [];
  #configuration = "";
  #resourceEpoch=randomUUID();
  #arguments = new Map<string,ArgumentMemo>();
  #generation = new Map<AbortSignal,HookApi>();
  #closing?: Promise<void>;
  #initializing?: Promise<void>;
  #packageInstructions = '';
  #packagePrompts: { name: string; content: string; filePath: string }[] = [];
  #closed = true;
  #armed = false;
  readonly #models: ModelRuntime;
  readonly #builtins: readonly ToolRegistration[];
  readonly #agentDir: string;
  readonly #enabled: () => boolean;
  readonly #sessionId: string;
  readonly #providerHeaders?: CodingProviderHeaders;
  readonly #nestedTask;
  readonly #modelTask;
  readonly #extensionName = 'dcode-project-extensions';

  constructor(builtins: readonly ToolRegistration[], agentDir: string, enabled: () => boolean, models: ModelRuntime, sessionId: string, providerHeaders?: CodingProviderHeaders) {
    this.#builtins = builtins; this.#agentDir = agentDir; this.#enabled = enabled; this.#models = models; this.#sessionId = sessionId;
    this.#providerHeaders = providerHeaders;
    const settle = async (input: NestedInput, runtime: Parameters<NonNullable<ReturnType<typeof defineTask<NestedInput, { phase: 'call' | 'execute' }, ToolExecutionResult, ToolHooks>>['definition']['abort']>>[1], result: ToolExecutionResult, status: 'completed' | 'aborted' | 'failed', ctx: Context) => {
      await runtime.commit(async tx => {
        const spend = await tx.doc(ExtensionModelSpend, runtime.taskId);
        const usage = sumUsage(Object.values(spend.usages) as unknown as Usage[]);
        if (usage) result = {...result,usage};
        // 内层是扩展真正发起的调用，不伪造模型 assistant；正式工具记录仍写入同一 Session。
        await tx.appendEntry(ToolResultEntry, runtime.conversationId, {
          model: [{ role: 'toolResult', toolName: input.call.name, toolCallId: input.call.id,
            content: result.content ?? [], isError: result.isError ?? false, timestamp: Date.now(),
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
    };
    this.#nestedTask = defineTask<NestedInput, { phase: 'call' | 'execute' }, ToolExecutionResult, ToolHooks>({
      name: 'dcode.extension-tool', version: 1, initial: () => ({ phase: 'call' }),
      phases: {
        call: async (task, runtime, ctx) => {
          const registered = runtime.registry.tools().find(({ tool }) => tool.name === task.input.call.name)?.tool;
          const descriptor = this.#tools.find(tool => tool.name === task.input.call.name);
          if (!registered || descriptor?.exposure === 'hidden' || descriptor?.exposure === 'model-only' || ((descriptor?.exposure ?? 'direct') === 'direct' && !this.#active.includes(task.input.call.name))) {
            await settle(task.input, runtime, { content: [{ type: 'text', text: '工具不在本次可调用范围内' }], isError: true }, 'completed', ctx); return;
          }
          // 与直接工具同一参数校验、Runner 前后拦截及正式环境；只有认领后才执行副作用。
          let result: ToolExecutionResult;
          try {
            await this.#prepareArguments(task.input.call, runtime, ctx);
            let args = validateToolArguments(registered, { ...task.input.call, arguments: (registered.prepareArguments?.(task.input.call.arguments) ?? task.input.call.arguments) as JsonObject });
            let block: string | undefined;
            await runtime.hooks.each('beforeTool', async handler => {
              if (block !== undefined) return;
              try { const decision = await handler({ ...task.input.call, arguments: args }, runtime, ctx);
                if (decision?.block !== undefined) block = decision.block; else if (decision?.arguments) args = decision.arguments;
              } catch (error) { if (runtime.signal.aborted) throw error; block = '工具拦截失败'; }
            });
            const before = { block: block !== undefined, reason: block };
            args = validateToolArguments(registered, { ...task.input.call, arguments: args });
            if (before.block) result = { content: [{ type: 'text', text: before.reason ?? '扩展拒绝本次工具调用' }], isError: true };
            else {
              await runtime.commit(() => ({ status: 'running', checkpoint: { phase: 'execute' } }), ctx);
              const invocation = await taskToolApi(runtime, task.input.call.id, ctx);
              try { result = invocation.finish(await registered.execute(args, invocation.api, ctx)); }
              finally { invocation.finish({}); }
            }
            await runtime.hooks.each('afterTool', async handler => { result = await handler({ ...task.input.call, arguments: args }, result, runtime, ctx) ?? result; });
          } catch (error) {
            if (runtime.signal.aborted) throw error;
            result = { content: [{ type: 'text', text: '扩展工具调用失败' }], isError: true };
          }
          await settle(task.input, runtime, result, 'completed', ctx);
        },
        execute: async (task, runtime, ctx) => settle(task.input, runtime, { content: [{ type: 'text', text: '内部工具曾被中断，可能已产生部分作用；不会自动重放' }], isError: true }, 'failed', ctx),
      },
      abort: async (task, runtime, ctx) => settle(task.input, runtime, { content: [{ type: 'text', text: '内部工具已取消，可能存在部分作用' }], isError: true }, 'aborted', ctx),
    });
    this.#modelTask = defineTask<ModelInput, { phase: 'call' | 'execute' }, JsonObject>({
      name: 'dcode.extension-model', version: 1, initial: () => ({ phase: 'call' }),
      phases: {
        call: async (task, runtime, ctx) => {
          const owned = this.#modelCalls.get(task.input.actionId);
          if (!owned || owned.origin !== this.#worker || owned.aborted || this.#closed) throw new CodingResourcesUnavailable();
          const caller = this.#calls.get(owned.caller);
          if (!caller || caller.api.taskId !== task.input.ownerTaskId || owned.caller !== task.input.caller || (owned.task !== undefined && owned.task !== runtime.taskId)) throw new CodingResourcesUnavailable();
          owned.task = runtime.taskId;
          owned.signal = runtime.signal;
          const model = runtime.models.getModel(task.input.provider, task.input.modelId);
          if (!model) throw new CodingResourcesUnavailable();
          // 先保存已进入请求的检查点；中断后不能把结果未知的付费请求再发一次。
          await runtime.commit(() => ({ status: 'running', checkpoint: { phase: 'execute' } }), ctx);
          if (owned.aborted || runtime.signal.aborted) throw new CodingResourcesUnavailable();
          const persist = async (message: AssistantMessage, terminal?: { type: 'done' | 'error'; reason: string }) => {
          const result = bounded({ message, ...(terminal ? { terminal } : {}) }) as JsonObject;
          await runtime.commit(async tx => {
            // 返回值属于原工具；只另存真实请求事实，绝不伪造会话 assistant/model 投影。
            await tx.appendEntry(ExtensionModelResult, runtime.conversationId, { data: result });
            // 线程scope可能随后抛错或失效；已完成开销与结果同事务按真实工具owner保留。
            const spend = await tx.doc(ExtensionModelSpend, task.input.ownerTaskId as import('@earendil-works/pi-durable').TaskId);
            if (message.usage) spend.usages[String(runtime.taskId)] = bounded(message.usage) as JsonValue;
            return { status: 'terminal', outcome: { status: 'completed', result } };
          }, ctx);
          };
          if (task.input.mode === 'streamSimple') {
            if (!this.#binding?.ownedModel) throw new CodingResourcesUnavailable();
            await this.#binding.ownedModel(runtime, { provider: model.provider, modelId: model.id }, async () => {
              const stream = runtime.models.streamSimple(model, task.input.input as unknown as Parameters<Models['streamSimple']>[1], { ...task.input.options, signal: runtime.signal });
              let terminal: { type: 'done' | 'error'; reason: string } | undefined;
              for await (const event of stream) {
                if (event.type === 'done' || event.type === 'error') terminal = { type: event.type, reason: event.reason };
                else {
                  // partial 只是原请求的事件投影；旧worker/scope失效后不再投递，不能成为正式成功事实。
                  if (owned.origin !== this.#worker || owned.aborted || this.#closed || caller.context.abortSignal?.aborted || runtime.signal.aborted) throw new CodingResourcesUnavailable();
                  owned.origin.postMessage(bounded({ type: 'model-event', actionId: task.input.actionId, scope: owned.caller, taskId: runtime.taskId, seq: ++owned.seq, event }));
                }
              }
              const message = await stream.result();
              if (!terminal) throw new CodingResourcesUnavailable();
              // 公共流 push(done/error) 会立即 resolve result；终态只在原任务提交成功后由host reply交付。
              await persist(message, terminal);
            });
          } else {
            await persist(await runtime.models.complete(model, task.input.input as unknown as Parameters<Models['complete']>[1], { ...task.input.options, signal: runtime.signal }));
          }
        },
        execute: async (_task, runtime, ctx) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'failed', error: { code: 'model-result-unknown', message: '单次模型请求曾进入执行，结果未知，不自动重放' } } }), ctx),
      },
      abort: async (_task, runtime, ctx) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
    });
  }
  /** 仅由原会话在调度停止后的暂停/关闭，或明确继续前调用；读取历史不对账。 */
  async reconcileModelSpend(session:Session,ctx:Context):Promise<void>{
    await session.commit(async tx=>{
      const groups=new Map<number,TaskRecord<JsonValue,JsonValue,JsonValue>[]>();let cursor:Cursor|undefined;
      do{
        const page=await tx.scanTasks({kind:this.#modelTask.definition.name,status:'terminal'},200,cursor);
        for(const child of page.items){
          if(child.state.status!=='terminal'||child.state.outcome.status!=='completed')continue;
          const input=child.input as unknown as ModelInput;
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
        }else if(owner.kind===this.#nestedTask.definition.name){
          const call=(owner.input as unknown as NestedInput).call;name=call.name;callId=call.id;
        }else throw new CodingResourcesUnavailable();
        const confirmed=children.map(child=>{
          if(child.state.status!=='terminal'||child.state.outcome.status!=='completed')throw new CodingResourcesUnavailable();
          const message=(child.state.outcome.result as unknown as {message:AssistantMessage}).message;
          if(message.role!=='assistant'||!message.usage)throw new CodingResourcesUnavailable();return message.usage;
        });
        // 原SDK正常终态已经与ToolResult同事务记账；取消/unsafe恢复不经afterTool。
        let recorded:Usage|undefined;let entryCursor:Cursor|undefined;
        do{const page=await tx.scanEntries({conversationId:owner.conversationId},200,entryCursor);
          for(const entry of page.items)if(entry.byTaskId===owner.id&&entry.kind===ToolResultEntry.kind){
            const result=entry.model?.find(value=>value.role==='toolResult'&&value.toolCallId===callId);
            if(result?.role==='toolResult'){if(result.toolName!==name)throw new CodingResourcesUnavailable();recorded=result.usage;}
          }entryCursor=page.next;
        }while(entryCursor);
        if(recorded&&JSON.stringify(recorded)!==JSON.stringify(sumUsage(confirmed)))throw new CodingResourcesUnavailable();
        const fresh:Usage[]=[];
        for(let index=0;index<children.length;index++){
          const receipt=receipts[index];
          if(!receipt.done){if(!recorded)fresh.push(confirmed[index]);receipt.done=true;}
        }
        const addition=sumUsage(fresh);
        if(addition){const usage=await tx.doc(UsageDoc,owner.conversationId);const previous=Object.hasOwn(usage.tools,name)?usage.tools[name] as Usage:undefined;
          usage.tools={...usage.tools,[name]:sumUsage(previous?[previous,addition]:[addition])!};}
      }
    },ctx);
  }
  guardModels(models: ModelRuntime): ModelRuntime {
    return new Proxy(models, { get: (owner, key) => {
      const value: unknown = Reflect.get(owner, key);
      if (typeof value !== 'function') return value;
      if (['stream','streamSimple','complete','completeSimple','streamDeferred','fetchDeferred','generateImages','classify'].includes(String(key))) {
        return (...args: unknown[]) => {
          if (this.#armed && this.#closed) throw new CodingResourcesUnavailable();
          this.#providerHeaders?.assertCurrent();
          if (this.#worker && !this.#closed && ['stream','streamSimple','complete','completeSimple'].includes(String(key))) {
            const previous = (args[2] ?? {}) as { signal?: AbortSignal; onPayload?: (payload: unknown, model: unknown) => unknown; transformHeaders?: (headers: unknown, model: unknown) => unknown };
            args[2] = { ...previous,
              onPayload: async (payload: unknown, model: unknown) => { const prior = await previous.onPayload?.(payload, model); const before=prior??payload; const ctx=previous.signal?withAbortSignal(previous.signal,context):context;
                const after=await this.#event('provider-body',before,previous.signal?this.#generation.get(previous.signal):undefined,ctx) as Record<string,unknown>;
                const current=before as Record<string,unknown>;
                for(const field of ['model','messages','contents','input','system','tools','tool_choice','thinking','reasoning','reasoning_effort','thinking_budget','thinking_budget_tokens','max_tokens','max_completion_tokens','max_output_tokens','extra_body']) if(JSON.stringify(after?.[field])!==JSON.stringify(current?.[field]))throw new CodingResourcesUnavailable();
                return after; },
              transformHeaders: async (headers: unknown, model: unknown) => { const prior = await previous.transformHeaders?.(headers, model); const before=(prior??headers) as Record<string,unknown>;const ctx=previous.signal?withAbortSignal(previous.signal,context):context;
                // 项目线程不拿模型凭据：只给协议公开头，私有头由原执行端保留，回调只形成有限覆盖层。
                const visible=new Set(['accept','content-type','user-agent']);
                const publicHeaders=Object.fromEntries(Object.entries(before).filter(([name])=>visible.has(name.toLowerCase())));
                const privateNames=new Set(Object.keys(before).filter(name=>!visible.has(name.toLowerCase())).map(name=>name.toLowerCase()));
                const after=await this.#event('provider-headers',publicHeaders,previous.signal?this.#generation.get(previous.signal):undefined,ctx) as Record<string,unknown>;
                if(!after||typeof after!=='object'||Array.isArray(after)||Object.entries(after).some(([name,value])=>typeof value!=='string'||privateNames.has(name.toLowerCase())||/auth|api.?key|token|cookie|secret|organization|project|account/i.test(name)))throw new CodingResourcesUnavailable();
                return {...before,...after}; } };
          }
          return value.apply(owner, args);
        };
      }
      return value.bind(owner);
    } });
  }
  get packageResources() { return { instructions: this.#packageInstructions, prompts: this.#packagePrompts }; }
  attach(harness: Harness, root: Conversation, ownedModel?: DurableModelRouting['withOwnedModelInvocation']): void { this.#binding = { harness, root, ownedModel }; }
  useRegistry(registry: Registry): void { this.#registry = registry; }
  #argumentKey(call:Pick<ToolCall,'name'|'arguments'>):string{return `${call.name}/${createHash('sha256').update(JSON.stringify(call.arguments)).digest('hex')}`;}
  async #prepareArguments(call:ToolCall, api:HookApi, ctx:Context):Promise<void>{
    if(!this.#tools.find(tool=>tool.name===call.name)?.hasPrepareArguments)return;
    const key=this.#argumentKey(call),memoName=`dcode.extension-arguments/${call.id}`;
    let memo=await api.memo<ArgumentMemo>(memoName,ctx);
    if(!memo){
      let prepared:JsonValue=null,failed=false;
      try{const result=await this.#event('arguments',call,api,ctx) as {arguments:JsonValue};prepared=bounded(result.arguments) as JsonValue;}catch(error){if(ctx.abortSignal?.aborted)throw error;failed=true;}
      memo=await api.memo(memoName,{source:this.#configuration,name:call.name,inputHash:key,prepared,failed},ctx);
    }
    this.#arguments.set(key,memo);
  }
  async #restoreArguments():Promise<void>{
    if(!this.#binding||!this.#tools.some(tool=>tool.hasPrepareArguments))return;
    const tasks=(await this.#binding.harness.inspect(context)).tasks.map(item=>item.record);
    const restore=async(record:TaskRecord<JsonValue,JsonValue,JsonValue>,assistant:EntryId,ids:readonly string[],owner:{memos?:Readonly<Record<string,JsonValue>>}=record)=>{
      const conversation=await this.#binding!.harness.conversation(record.conversationId,context);if(!conversation)throw new CodingResourcesUnavailable();
      const entry=(await conversation.entries({minEntryId:assistant,maxEntryId:assistant},1,undefined,context)).items[0];
      for(const call of (entry?.model??[]).flatMap(message=>message.role==='assistant'?message.content.filter(part=>part.type==='toolCall'):[])){
        if(!ids.includes(call.id)||!this.#tools.find(tool=>tool.name===call.name)?.hasPrepareArguments)continue;
        const key=this.#argumentKey(call),memo=owner.memos?.[`dcode.extension-arguments/${call.id}`] as ArgumentMemo|undefined;
        if(memo)this.#arguments.set(key,memo);
        else{
          const result=await this.#event('arguments',call,undefined,context) as {arguments:JsonValue};
          // 缺早期 memo 时只重新计算契约规定的纯函数；原 assistant、schema、callId 不改。
          this.#arguments.set(key,{source:this.#configuration,name:call.name,inputHash:key,prepared:bounded(result.arguments) as JsonValue,failed:false});
        }
      }
    };
    for(const record of tasks){
      if(record.abortRequested||record.state.status==='terminal'||record.state.status==='completing')continue;
      const checkpoint=record.state.checkpoint as JsonObject,input=record.input as JsonObject;
      if(record.kind===GenerationTask.definition.name&&checkpoint.phase==='tools')await restore(record,checkpoint.assistant as EntryId,checkpoint.pending as string[]);
      if(record.kind===ToolTask.definition.name&&checkpoint.phase==='call'&&record.owner!==undefined){
        const owner=await this.#binding.harness.getTask(record.owner,context);if(!owner)throw new CodingResourcesUnavailable();
        await restore(record,input.assistant as EntryId,[String(input.callId)],owner);
      }
    }
  }
  #extension() {
    const tools = this.#tools.map(descriptor => defineTool({ name: descriptor.name, description: descriptor.description,
      ...(descriptor.hasPrepareArguments?{prepareArguments:(args:unknown)=>{const key=this.#argumentKey({name:descriptor.name,arguments:args as JsonObject}),memo=this.#arguments.get(key);
        if(!memo||memo.failed||memo.source!==this.#configuration||memo.name!==descriptor.name||memo.inputHash!==key)throw new CodingResourcesUnavailable();return json(memo.prepared) as never;}}:{}),
      parameters: descriptor.parameters, ...(descriptor.constrainedSampling === undefined ? {} : {constrainedSampling:descriptor.constrainedSampling}), replay: 'unsafe', execute: async (args, api, ctx) => {
        const nested: JsonValue[] = []; const models: AssistantMessage[] = []; const scope=`tool/${api.taskId}/${api.callId}`; this.#calls.set(scope, { api, context: ctx, nested, models });
        try {
          const result = toolResult(await this.#request('execute', { name: descriptor.name, id: api.callId, arguments: args }, ctx.abortSignal, {scope}));
          return { ...result, ...(models.length ? { usage: sumUsage(models.map(message => message.usage)) } : {}), details: json({ ...(result.details && typeof result.details === 'object' && !Array.isArray(result.details) ? result.details : {}), nestedCalls: nested }) as JsonObject };
        } finally { this.#calls.delete(scope); }
      } }));
    return defineExtension({ name: this.#extensionName, tools, tasks: [this.#nestedTask, this.#modelTask], hooks: [
      hook(GenerationTask, { beforeRequest: async (request, api, ctx) => {
        if (this.#closed) throw new CodingResourcesUnavailable();
        if (ctx.abortSignal) { this.#generation.set(ctx.abortSignal,api);ctx.abortSignal.addEventListener('abort',()=>this.#generation.delete(ctx.abortSignal!),{once:true}); }
        let messages = await this.#beforeTurn(request.messages, api, ctx);
        const result = await this.#event('context', {}, api, ctx, { messages });
        messages = (result as { messages: Message[] }).messages; return { messages };
      },afterResponse:async(message,api,ctx)=>{for(const call of message.content.filter(part=>part.type==='toolCall'))await this.#prepareArguments(call,api,ctx);},
      afterTools:async(assistant,_results,api,ctx)=>{await this.#binding!.harness.commit(async tx=>{(await tx.doc(RequestRound,api.taskId)).assistant=assistant;},ctx);}
      }),
      ...[ToolTask, this.#nestedTask].map(task => hook(task, {
        beforeTool: async (call, api, ctx) => {
          const before = await this.#event('before', call, api, ctx) as { block?: boolean; reason?: string };
          return before.block ? { block: before.reason ?? '扩展拒绝本次工具调用' } : undefined;
        },
        afterTool: async (call, result, api, ctx) => {
          const spend = await api.snapshot(ExtensionModelSpend, api.taskId, ctx);
          const usage = spend ? sumUsage(Object.values(spend.usages) as unknown as Usage[]) : undefined;
          const actual = usage ? {...result,usage} : result;
          try {
            const after = await this.#event('after', { ...call, result: { ...actual, content: actual.content ?? [] } }, api, ctx) as Record<string, unknown>;
            return after.content ? { ...toolResult({ ...actual, ...after }), ...(actual.usage ? {usage:actual.usage} : {}) } : actual;
          } catch (error) {
            if (ctx.abortSignal?.aborted) throw error;
            return {...actual,isError:true,content:[{type:'text',text:'扩展结果处理失败，已完成的模型作用与用量仍保留'}]};
          }
        },
      })),
    ] });
  }
  async #event(method: string, value: unknown, api: HookApi | undefined, ctx: Context, extra: object = {}) {
    const digest = createHash('sha256').update(JSON.stringify(value)).digest('hex');
    let requestIdentity='';
    if(api&&this.#binding){
      const task=await this.#binding.harness.getTask(api.taskId,ctx);
      if(task?.kind===GenerationTask.definition.name&&task.state.status!=='terminal'&&task.state.status!=='completing'){
        const checkpoint=task.state.checkpoint as JsonObject;
        const round=await api.snapshot(RequestRound,api.taskId,ctx);let input=0,cursor:Cursor|undefined;
        do{const page=await this.#binding.root.entries(typeof checkpoint.cutoff==='number'?{maxEntryId:checkpoint.cutoff as EntryId}:{},200,cursor,ctx);const original=page.items.find(entry=>entry.kind==='pi.user');if(original){input=original.id;break;}cursor=page.next;}while(cursor);
        requestIdentity=`/${input}/${round?.assistant??0}/${checkpoint.attempt??0}`;
      }
    }
    // 同一 generation 可有多次正文相同的 headers/context；按原输入、工具轮次与 attempt 分开，恢复仍用原身份。
    const scope = api ? `event/${api.taskId}${requestIdentity}/${method}/${digest}` : `resource/${this.#sessionId}/${this.#resourceEpoch}/${method}/${++this.#next}`;
    this.#events.set(scope, { api, context: ctx });
    try { return await this.#request(method, value, ctx.abortSignal, { ...extra, scope }); }
    finally { this.#events.delete(scope); }
  }
  async prepareInput(input: InputPreparation, api: ToolExecutionApi, ctx: Context, expand: (text: string) => string): Promise<PreparedInput> {
    if (!this.#worker || this.#closed) return { content: typeof input.content === 'string' ? expand(input.content) : input.content.map((part, index) => index === 0 && part.type === 'text' ? { ...part, text: expand(part.text) } : part), handled: false };
    const scope=`input/${api.taskId}/${input.requestId}`; this.#calls.set(scope, { api, context: ctx, nested: [], models: [] });
    try {
      const result = await this.#request('input', { text: input.text, images: input.images, mode: input.mode }, ctx.abortSignal, { scope }) as { action: string; text?: string; images?: ImageContent[] };
      if(!['continue','transform','handled'].includes(result.action)||(result.action==='transform'&&typeof result.text!=='string'))throw new CodingResourcesUnavailable();
      if (result.action === 'handled') return { content: input.content, handled: true };
      const text = expand(result.action === 'transform' ? String(result.text) : input.text);
      const images = parseWorkImages(result.images ?? input.images);
      const references = typeof input.content === 'string' ? [] : input.content.filter(part => part.type === 'text').slice(1);
      const content: import('@earendil-works/pi-durable').UserInput = [{ type: 'text', text }, ...references, ...images];
      // 普通 MCP 的异步发现须在 GenerationTask 取得 agent/tool 快照前完成；消费真实本次 prompt，不用空事件探测。
      const started = startedResult(await this.#request('agent-start', { prompt: text, images }, ctx.abortSignal, { scope }));
      await api.commit(async tx => {
        const identity={requestId:input.requestId,innerRequestId:input.innerRequestId};
        await tx.appendEntry(ExtensionEntry, api.conversationId, { data: { action: 'prepared-input', value: identity }, ...(started.system.length ? { model: started.system } : {}) });
        await appendStartedMessages(tx,api.conversationId,started,identity);
      }, ctx);
      return { content, handled: false };
    } finally { this.#calls.delete(scope); }
  }
  async #beforeTurn(messages: readonly Message[], api: HookApi, ctx: Context): Promise<readonly Message[]> {
    const full = await this.#state() as { entries: EntryRecord[] };
    const task = await this.#binding!.harness.getTask(api.taskId, ctx);
    const checkpoint = task?.state.status !== 'terminal' && task?.state.status !== 'completing' ? task?.state.checkpoint as JsonObject | undefined : undefined;
    // 可见扩展消息也有 user 模型投影，不能凭 role 或正文认领一次新输入；以原 pi.user 及正式接收关联为准。
    const latestUser = [...full.entries].reverse().find(entry => entry.kind === 'pi.user' && (typeof checkpoint?.cutoff !== 'number' || entry.id <= checkpoint.cutoff));
    const user = latestUser?.model?.find(message => message.role === 'user');
    if (!latestUser || !user || !messages.some(message => message.role === 'user' && message.timestamp === user.timestamp && JSON.stringify(message.content) === JSON.stringify(user.content))) return messages;
    const prepared = await this.#binding!.harness.commit(async tx => {
      for (const entry of full.entries) {
        if (entry.kind !== 'dcode.extension-entry' || (entry.data as JsonObject)?.action !== 'prepared-input') continue;
        const value = (entry.data as JsonObject).value as JsonObject;
        if (typeof value?.innerRequestId !== 'string') continue;
        const receipt = await tx.submissionByRequest(api.conversationId, value.innerRequestId);
        if (receipt?.type === 'input' && 'entry' in receipt && receipt.entry === latestUser.id) return true;
      }
      return false;
    }, ctx);
    if (prepared) return messages;
    const key = String(latestUser.id);
    const stored = await this.#binding!.harness.snapshot(Turn, key, context);
    if (stored?.started) { if (!stored.finished) { this.#fail(); throw new CodingResourcesUnavailable(); } return messages; }
    await this.#binding!.harness.commit(async tx => { (await tx.doc(Turn, key, null)).started = true; }, ctx);
    const prompt = typeof user.content === 'string' ? user.content : user.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
    const images = typeof user.content === 'string' ? [] : user.content.filter(part => part.type === 'image');
    const result = startedResult(await this.#event('agent-start', { prompt, images }, api, ctx));
    // MCP 延迟发现发生在正式 turn 启动；当前这次请求也须消费同一实际工具集合。
    const loadout:Message={ role: 'system', content: '', timestamp: Date.now(), toolsAdded: [...this.#builtins, ...this.#tools].filter(tool => this.#declarations.includes(tool.name)).map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters, ...(tool.constrainedSampling === undefined ? {} : {constrainedSampling:tool.constrainedSampling}) })) };
    result.system.push(loadout);result.messages.push(loadout);
    result.messages = json(result.messages);
    await this.#binding!.harness.commit(async tx => {
      if (this.#closed || ctx.abortSignal?.aborted) throw new CodingResourcesUnavailable();
      const turn = await tx.doc(Turn, key, null);
      turn.started = true; turn.finished = true; turn.messages = json(result.messages) as unknown as JsonValue[];
      await tx.appendEntry(ExtensionEntry, this.#binding!.root.id, { model: result.system, data: { action: 'agent-start', value: { key } } });
      await appendStartedMessages(tx,this.#binding!.root.id,result,{entryId:latestUser.id});
    }, ctx);
    return [...messages, ...result.messages];
  }
  async prepare(cwd: string, expectedEnabled = this.#enabled()) {
    if (expectedEnabled !== this.#enabled()) throw new CodingResourcesUnavailable();
    if (!this.#enabled()) {
      if (this.#worker && this.#binding && (await this.#binding.harness.inspect(context)).tasks.length) throw new CodingResourcesUnavailable();
      await this.close(); this.#armed = false; this.#packageInstructions = ''; this.#packagePrompts = [];
      return { remove: [this.#extension()], tools: null };
    }
    if (this.#worker && !this.#closed) {
      await this.#initializing;
      const current = await this.#request('configuration', {}) as {configuration:string};
      if (current.configuration !== this.#configuration) {
        if (this.#binding && (await this.#binding.harness.inspect(context)).tasks.some(({record})=>!['dcode.input-preparation','dcode.input-receipt'].includes(record.kind))) throw new CodingResourcesUnavailable();
        await this.close();
      }
    }
    if (!this.#worker) {
      await mkdir(this.#agentDir, { recursive: true, mode: 0o700 });
      this.#armed = true; this.#closed = false; this.#closing = undefined; this.#tools = []; this.#active = [];this.#arguments.clear();this.#resourceEpoch=randomUUID();
      const worker = new Worker(extensionWorkerSource, { eval: true, execArgv: [], stdout: true, stderr: true,
        env: { ...process.env, PI_CODING_AGENT_DIR: this.#agentDir, PI_OFFLINE: '1', NODE_TEST_CONTEXT: undefined },
        workerData: { cwd: await realpath(cwd), agentDir: this.#agentDir, sdk: import.meta.resolve('@earendil-works/pi-coding-agent'), streamFactory: import.meta.resolve('@earendil-works/pi-ai/utils/event-stream'),
          builtins: this.#builtins.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters, exposure: 'direct' })) } });
      this.#worker = worker; worker.stdout.resume(); worker.stderr.resume();
      worker.on('message', (message: Record<string, unknown>) => this.#message(message,worker));
      worker.on('error',()=>{if(this.#worker===worker)this.#fail();}); worker.on('exit',()=>{if(this.#worker===worker)this.#fail();});
      this.#initializing = this.#event('init', {}, undefined, context).then(value => {
        const resources = bounded(value, 1024 * 1024) as { configuration: string; packageInstructions: string; packagePrompts: { name: string; content: string; filePath: string }[] };
        if (typeof resources.packageInstructions !== 'string' || !Array.isArray(resources.packagePrompts)
          || resources.packagePrompts.some(item => !item || typeof item.name !== 'string' || typeof item.content !== 'string' || typeof item.filePath !== 'string')) throw new CodingResourcesUnavailable();
        this.#configuration = resources.configuration; this.#packageInstructions = resources.packageInstructions; this.#packagePrompts = resources.packagePrompts;
      });
      try { await this.#initializing; } catch { await this.close(); throw new CodingResourcesUnavailable(); }
    }
    await this.#restoreArguments();
    if (expectedEnabled !== this.#enabled()) throw new CodingResourcesUnavailable();
    const extension = this.#extension();
    return { add: [extension], tools: [...this.#builtins, ...(extension.tools ?? [])].filter(tool => this.#declarations.includes(tool.name)) };
  }
  async #state(extra: object = {}) {
    if (!this.#binding) throw new CodingResourcesUnavailable();
    const agent = await this.#binding.root.agent(context);
    const formal = await this.#binding.root.context(context);
    const model = agent.model ? this.#models.getModel(agent.model.provider, agent.model.modelId) : undefined;
    const entries: EntryRecord[] = []; let cursor: Cursor | undefined;
    do { const page = await this.#binding.root.entries({}, 200, cursor, context); entries.push(...page.items); cursor = page.next; } while (cursor !== undefined);
    entries.sort((a, b) => a.id - b.id);
    return { sessionId: this.#sessionId, entries, messages: formal.messages, model: model ? modelMetadata(model) : undefined, modelCatalog: { all: this.#models.getModels().map(modelMetadata), available: this.#models.getAvailableSnapshot().map(modelMetadata) }, thinkingLevel: agent.thinkingLevel, systemPrompt: agent.instructions ?? '', ...extra };
  }
  async #request(method: string, value: unknown, signal?: AbortSignal, extra: object = {}): Promise<unknown> {
    const worker = this.#worker; if (!worker || (this.#closed && method !== 'close')) throw new CodingResourcesUnavailable();
    const id = ++this.#next;
    const ownCall = typeof value === 'object' && value && 'id' in value ? String(value.id) : undefined;
    const abortId = 'scope' in extra && typeof extra.scope === 'string' ? extra.scope : ownCall;
    const abort = () => {
      if (abortId) worker.postMessage({ type: 'abort', callId: abortId });
      // 选路可能忽略signal；只退出本次route等待，不能让child/execute/close彼此join成环。
      if (method === 'virtual-route') {
        const pending = this.#pending.get(id); this.#pending.delete(id); pending?.reject(new CodingResourcesUnavailable());
      }
    };
    if (signal?.aborted) throw new CodingResourcesUnavailable();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      return await new Promise((resolve, reject) => {
        this.#pending.set(id, { resolve, reject, ...(method === 'virtual-route' ? { abort } : {}) });
        void (method === 'close' ? Promise.resolve({}) : this.#state(extra)).then(state => {
          // 只读快照 await 期间可能被暂停／关闭取代；不能把早到但未认领的 abort 丢掉后再启动调用。
          if(signal?.aborted||this.#worker!==worker||(this.#closed&&method!=='close'))throw new CodingResourcesUnavailable();
          worker.postMessage({type:'request',id,method,value:bounded(value),state:bounded(state),scope:'scope' in extra?extra.scope:undefined});
        }).catch(() => {
          this.#pending.delete(id); reject(new CodingResourcesUnavailable());
        });
      });
    } finally { signal?.removeEventListener('abort', abort); }
  }
  #catalog() {
    return { all: this.#models.getModels().map(modelMetadata), available: this.#models.getAvailableSnapshot().map(modelMetadata) };
  }
  #removeVirtuals(): void {
    for (const [key, own] of this.#virtuals) {
      this.#virtuals.delete(key);
      // 原public目录对象是本次登记的认领；外部后来同名替换不归旧资源清理。
      if (own.model && this.#models.getModel(own.provider, own.id) === own.model) this.#models.unregisterVirtualModel(own.provider, own.id);
    }
  }
  #removeProviderHeaders(): void {
    for (const [id, owned] of this.#providerClaims) {
      this.#providerClaims.delete(id); this.#providerHeaders?.release(id, owned.claim);
    }
  }
  async #route(own: VirtualRegistration, request: ModelRouteRequest) {
    const signal = request.signal;
    const current = () => this.#virtuals.get(virtualKey(own.provider, own.id)) === own && own.origin === this.#worker
      && !this.#closed && !signal?.aborted && this.#models.getModel(own.provider, own.id) === own.model;
    const [actionId, call] = [...this.#modelCalls.entries()].find(([, item]) => item.origin === own.origin && item.signal === signal && !item.aborted) ?? [];
    if (!signal || request.reason !== 'direct' || !call?.task || !this.#calls.has(call.caller) || !current()) throw new CodingResourcesUnavailable();
    const reply = bounded(await this.#request('virtual-route', { handle: own.handle, request: {
      model: modelMetadata(request.model), thinkingLevel: request.thinkingLevel, reason: request.reason,
      messages: request.messages, ...(request.previous ? { previous: { ...request.previous, model: modelMetadata(request.previous.model) } } : {}),
      ...(request.failed ? { failed: { ...request.failed, model: modelMetadata(request.failed.model) } } : {}),
    } }, signal, { scope: `route/${call.task}/${randomUUID()}` })) as JsonObject;
    if (!current() || !actionId || this.#modelCalls.get(actionId) !== call || call.aborted
      || typeof reply.provider !== 'string' || typeof reply.modelId !== 'string'
      || typeof reply.thinkingLevel !== 'string' || !thinkingLevels.includes(reply.thinkingLevel)) throw new CodingResourcesUnavailable();
    // 只消费引用：扩展返回的端点/headers/凭据不得参与真实物理请求，认证与完整准入仍由原Runtime持有。
    const model = this.#models.getPhysicalModel(reply.provider, reply.modelId);
    if (!model) throw new CodingResourcesUnavailable();
    return { model, thinkingLevel: reply.thinkingLevel as import('@earendil-works/pi-ai').ModelThinkingLevel };
  }
  #message(message: Record<string, unknown>, origin: Worker): void {
    if (origin !== this.#worker) return;
    if (message.type === 'result') {
      const pending = this.#pending.get(Number(message.id)); if (!pending) return; this.#pending.delete(Number(message.id));
      // route不发布工具/状态；不能在回执已摘pending后又等publication，丢掉可取消等待的认领。
      if (message.ok === true && pending.abort) pending.resolve(message.value);
      else if (message.ok === true) void this.#publication.then(() => pending.resolve(message.value), () => pending.reject(new CodingResourcesUnavailable())); else pending.reject(new CodingResourcesUnavailable());
    } else if (message.type === 'tools' && !this.#closed) {
      try {
        const tools = bounded(message.tools, 1024 * 1024) as Descriptor[];
        if (!Array.isArray(tools) || tools.length > 256 || tools.some(tool => !tool || !/^[\w.-]{1,128}$/.test(tool.name)
          || typeof tool.description !== 'string' || !tool.parameters || typeof tool.parameters !== 'object'
          || this.#builtins.some(builtin => builtin.name === tool.name)) || !Array.isArray(message.active)) throw new Error();
        this.#declarations = Array.isArray(message.declarations) ? (message.declarations as unknown[]).filter((name): name is string => typeof name === 'string') : [];
        this.#tools = tools; this.#active = (message.active as unknown[]).filter((name): name is string => typeof name === 'string');
        const extension = this.#extension(); this.#registry?.install(extension);
        if (this.#binding) this.#publication = this.#publication.then(async () => {
          if (!this.#closed) await this.#binding!.root.configure({ tools: [...this.#builtins, ...(extension.tools ?? [])].filter(tool => this.#declarations.includes(tool.name)) }, context);
        });
      } catch { this.#fail(); }
    } else if (message.type === 'progress') {
      const caller = this.#calls.get(String(message.scope));
      if (caller && !caller.context.abortSignal?.aborted) {
        try { const result = toolResult(message.value); if (result.content?.length) caller.api.output(result.content.filter(part => part.type === 'text').map(part => part.text).join('\n'));
          if (result.details !== undefined) void caller.api.details(result.details, caller.context).catch(() => {}); } catch { this.#fail(); }
      }
    } else if (message.type === 'host') {
      void this.#host(String(message.method), message.value, String(message.callId ?? ''), origin).then(value => {
        if(this.#worker===origin) origin.postMessage({ type: 'reply', id: message.id, ok: true, value: bounded(value) });
      }, () => {if(this.#worker===origin)origin.postMessage({ type: 'reply', id: message.id, ok: false });});
    }
  }
  async #host(method: string, value: unknown, callId: string, origin: Worker): Promise<unknown> {
    if (this.#closed || origin !== this.#worker || !this.#binding) throw new CodingResourcesUnavailable();
    const payload = bounded(value, 1024 * 1024) as JsonObject;
    if (method === 'model-complete' || method === 'model-stream' || method === 'model-cancel') {
      const caller = this.#calls.get(callId);
      if (!caller || !callId.startsWith('tool/') || caller.context.abortSignal?.aborted || typeof payload.actionId !== 'string' || !payload.actionId.startsWith(callId + '/')) throw new CodingResourcesUnavailable();
      if (method === 'model-cancel') {
        const pending = this.#modelCalls.get(payload.actionId);
        if (pending && pending.caller === callId && pending.origin === origin) {
          pending.aborted = true;
          if (pending.task) await this.#binding.harness.abortTask(pending.task, context);
        }
        return {};
      }
      if (typeof payload.provider !== 'string' || typeof payload.modelId !== 'string' || !payload.input || !Array.isArray((payload.input as JsonObject).messages) || !payload.options || typeof payload.options !== 'object' || Array.isArray(payload.options) || this.#modelCalls.has(payload.actionId)) throw new CodingResourcesUnavailable();
      const options = payload.options as JsonObject;
      if (['apiKey', 'headers', 'env', 'onPayload', 'transformHeaders', 'onResponse'].some(key => key in options) || (options.maxRetries !== undefined && options.maxRetries !== 0)) throw new CodingResourcesUnavailable();
      const pending: ModelCall = { caller: callId, origin, aborted: false, seq: 0 };
      this.#modelCalls.set(payload.actionId, pending);
      try {
        const child = await caller.api.createTask(this.#modelTask, {...payload,ownerTaskId:caller.api.taskId,mode:method==='model-stream'?'streamSimple':'complete'} as unknown as ModelInput, { ownership: { kind: 'task', taskId: caller.api.taskId } }, caller.context);
        pending.task = child;
        if (pending.aborted) await this.#binding.harness.abortTask(child, context);
        const settled = await caller.api.waitForTask(child, caller.context);
        const outcome = settled.state.outcome;
        if (outcome.status !== 'completed' || !outcome.result || !('message' in outcome.result)) throw new CodingResourcesUnavailable();
        if (origin !== this.#worker || this.#closed || pending.aborted || caller.context.abortSignal?.aborted) throw new CodingResourcesUnavailable();
        const message = outcome.result.message as unknown as AssistantMessage;
        caller.models.push(message);
        return { message, ...(method === 'model-stream' ? { terminal: outcome.result.terminal, taskId: child, seq: ++pending.seq } : {}) };
      } finally { this.#modelCalls.delete(payload.actionId); }
    }
    if (method === 'nested') {
      const caller = this.#calls.get(callId); if (!caller || caller.context.abortSignal?.aborted) throw new CodingResourcesUnavailable();
      const call = { type: 'toolCall' as const, id: `${caller.api.callId}/${randomUUID()}`, name: String(payload.name), arguments: payload.args as JsonObject };
      const child = await caller.api.createTask(this.#nestedTask, { caller: callId, call }, { ownership: { kind: 'task', taskId: caller.api.taskId } }, caller.context);
      const settled = await caller.api.waitForTask(child, caller.context);
      const outcome = settled.state.outcome;
      const result = outcome && 'result' in outcome && outcome.result ? outcome.result : { content: [{ type: 'text' as const, text: '内部工具未完成' }], isError: true };
      caller.nested.push(bounded({ toolCall: call, result, taskId: child }) as JsonValue);
      const details = result.details && typeof result.details === 'object' && !Array.isArray(result.details) ? result.details as JsonObject : {};
      return { toolCall: call, result: { ...result, ...(details.structuredContent === undefined ? {} : { structuredContent: details.structuredContent }) }, isError: result.isError ?? false };
    }
    const caller = this.#calls.get(callId); const event = this.#events.get(callId);
    if (!caller && !event) throw new CodingResourcesUnavailable();
    const ctx = caller?.context ?? event!.context;
    if (method === 'provider-register' || method === 'provider-unregister') {
      if (!this.#providerHeaders || ctx.abortSignal?.aborted || typeof payload.provider !== 'string' || !payload.provider.trim()
        || payload.provider.length > 128 || /[\x00-\x1f]/.test(payload.provider)
        || typeof payload.handle !== 'string' || !/^provider\/[1-9]\d*$/.test(payload.handle)) throw new CodingResourcesUnavailable();
      const id = payload.provider, previous = this.#providerClaims.get(id);
      if (method === 'provider-register') {
        if (previous && previous.origin !== origin) throw new CodingResourcesUnavailable();
        const claim = {};
        this.#providerHeaders.register(id, bounded(payload.config, 64 * 1024), claim, previous?.claim);
        this.#providerClaims.set(id, { origin, handle: payload.handle, claim });
      } else if (previous?.origin === origin && previous.handle === payload.handle) {
        this.#providerClaims.delete(id); this.#providerHeaders.release(id, previous.claim);
      }
      return { catalog: this.#catalog() };
    }
    if (method === 'virtual-register' || method === 'virtual-unregister') {
      if (ctx.abortSignal?.aborted || typeof payload.handle !== 'string' || !/^virtual\/[1-9]\d*$/.test(payload.handle)) throw new CodingResourcesUnavailable();
      if (method === 'virtual-register') {
        const definition = virtualDefinition(payload.definition);
        const key = virtualKey(definition.provider, definition.id), previous = this.#virtuals.get(key);
        const existing = this.#models.getModel(definition.provider, definition.id);
        if (existing && (!previous || previous.origin !== origin || previous.model !== existing)) throw new CodingResourcesUnavailable();
        const own: VirtualRegistration = { provider: definition.provider, id: definition.id, handle: payload.handle, origin };
        this.#models.registerVirtualModel({ ...definition, route: request => this.#route(own, request) });
        own.model = this.#models.getModel(definition.provider, definition.id);
        if (!own.model) { this.#models.unregisterVirtualModel(definition.provider, definition.id); throw new CodingResourcesUnavailable(); }
        this.#virtuals.set(key, own);
      } else {
        if (typeof payload.provider !== 'string' || typeof payload.modelId !== 'string') throw new CodingResourcesUnavailable();
        const key = virtualKey(payload.provider, payload.modelId), own = this.#virtuals.get(key);
        if (own && own.origin === origin && own.handle === payload.handle) {
          this.#virtuals.delete(key);
          if (this.#models.getModel(own.provider, own.id) === own.model) this.#models.unregisterVirtualModel(own.provider, own.id);
        }
      }
      return { catalog: this.#catalog() };
    }
    const commit = caller ? caller.api.commit.bind(caller.api) : async <T>(change: (tx: import('@earendil-works/pi-durable').Tx) => Promise<T>, ownContext: Context) => {
      let value!: T; await this.#binding!.harness.commit(async tx => {
        if (this.#closed || this.#worker!==origin || ownContext.abortSignal?.aborted) throw new CodingResourcesUnavailable();
        if (event?.api) { const task = await tx.task(event.api.taskId); if (!task || task.state.status === 'terminal' || 'abort' in task) throw new CodingResourcesUnavailable(); }
        value = await change(tx);
      }, ownContext); return value;
    };
    if (method === 'entry' || method === 'message' || method === 'name' || method === 'label') {
      await commit(async tx => {
        const actionId=typeof payload.actionId==='string'?payload.actionId:''; if(!actionId) throw new CodingResourcesUnavailable();
        const fingerprint=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
        const receipt=await tx.doc(Action,actionId,fingerprint); if(receipt.fingerprint!==fingerprint) throw new CodingResourcesUnavailable(); if(receipt.applied)return;
        const value = payload;
        const message = method === 'message' && typeof payload.message === 'object' && payload.message ? payload.message as JsonObject : undefined;
        if (method === 'message' && (!message || typeof message.customType !== 'string' || !message.customType.length || message.customType.length > 128 || typeof message.display !== 'boolean')) throw new CodingResourcesUnavailable();
        const content = message?.content;
        const model = message && (typeof content === 'string' || Array.isArray(content)) ? [{ role: 'user' as const, content: content as import('@earendil-works/pi-durable').UserInput, timestamp: Date.now() }] : undefined;
        const entry=await tx.appendEntry(ExtensionEntry,this.#binding!.root.id,{data:{action:method,value},...(model?{model}:{})}); receipt.entryId=entry.id;receipt.applied=true;
      }, ctx); return {};
    }
    if (method === 'user') {
      if (typeof payload.content !== 'string' && !Array.isArray(payload.content)) throw new CodingResourcesUnavailable();
      const id = typeof payload.actionId === 'string' ? payload.actionId : undefined; if (!id) throw new CodingResourcesUnavailable();
      await this.#binding.root.submit({ type: 'input', content: payload.content as import('@earendil-works/pi-durable').UserInput, requestId: id, whenBusy: 'followUp' }, ctx); return {};
    }
    if (method === 'compact') {
      const admitted = await this.#binding.root.compact(typeof payload.instructions === 'string' ? payload.instructions : undefined, ctx);
      const settled = await this.#binding.harness.waitForTask(admitted, context);
      if (settled.state.outcome.status !== 'completed') throw new CodingResourcesUnavailable();
      const result = settled.state.outcome.result;
      if (result.submissionId !== undefined) {
        const submission = await this.#binding.harness.submission(result.submissionId, context);
        if (!submission || (await submission.wait(context)).status !== 'done') throw new CodingResourcesUnavailable();
      }
      return {};
    }
    throw new CodingResourcesUnavailable();
  }
  #fail(): void { this.#closed = true; this.#removeVirtuals(); this.#removeProviderHeaders(); for (const pending of this.#pending.values()) pending.reject(new CodingResourcesUnavailable()); this.#pending.clear(); }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    const worker = this.#worker; if (!worker) return Promise.resolve();
    // 在等待关闭前提升代次；旧回调不能提交新任务，取消由同一 Harness 所有权级联。
    this.#closed = true;
    this.#removeVirtuals();
    this.#removeProviderHeaders();
    for (const pending of this.#pending.values()) pending.abort?.();
    this.#closing = (async () => {
      try { await this.#request('close', {}); await this.#publication; }
      finally { await worker.terminate(); this.#worker = undefined; this.#fail(); }
    })();
    return this.#closing;
  }
}
