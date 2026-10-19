import type { JsonValue } from '@earendil-works/chord';
import type { JsonObject, ToolExecutionResult } from '@earendil-works/pi-durable';
import type { AnyModel, ModelType, Message, TSchema } from '@earendil-works/pi-ai';
import type { BeforeAgentStartEventResult, VirtualModelDefinition } from '@earendil-works/pi-coding-agent';
import { CodingResourcesUnavailable } from './coding-resources';
import { parseWorkImages } from '@/contracts/index.ts';

// 线程边界只接有限JSON和安全投影；本模块不持有运行、资源代次或请求认领。
export type Descriptor = { name: string; description: string; parameters: TSchema; exposure: string; defaultActive?: boolean; constrainedSampling?: import('@earendil-works/pi-ai').ConstrainedSamplingConfig | false; hasPrepareArguments?: boolean };

export const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export const modelTypes: readonly ModelType[] = ['chat', 'image', 'classifier'];

export const validProviderId = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
  && value.length <= 128 && !/[\x00-\x1f]/.test(value);

export const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// 只投影各类型模型的公开描述；认证材料与执行请求头仍由宿主 ModelRuntime 持有。
export function modelMetadata(model: AnyModel): JsonValue {
  const base = { id: model.id, name: model.name, api: model.api, provider: model.provider, baseUrl: model.baseUrl,
    input: model.input, inputLimits: model.inputLimits, cost: model.cost, ...(model.type ? { type: model.type } : {}) };
  const typed = model.type === 'image' ? { output: model.output }
    : model.type === 'classifier' ? { contextWindow: model.contextWindow }
      : { reasoning: model.reasoning, thinkingLevelMap: model.thinkingLevelMap, promptCache: model.promptCache,
        contextWindow: model.contextWindow, maxTokens: model.maxTokens, samplingParams: model.samplingParams, compat: model.compat };
  return JSON.parse(JSON.stringify({ ...base, ...typed },
    (key, value: unknown) => /^(headers|apikey|authorization|credentials?|env)$/i.test(key) ? undefined : value)) as JsonValue;
}

export function virtualDefinition(value: unknown): Omit<VirtualModelDefinition, 'route'> {
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

export function bounded(value: unknown, maxBytes = 8 * 1024 * 1024): unknown {
  const text = JSON.stringify(value);
  if (!text || Buffer.byteLength(text) > maxBytes) throw new CodingResourcesUnavailable();
  return JSON.parse(text) as unknown;
}
export const RESULT_ENVELOPE_BYTES = 16 * 1024 * 1024;
// 只读SessionManager同时承接正式entries与当次context，允许有限的同图多处投影。
export const STATE_ENVELOPE_BYTES = 64 * 1024 * 1024;
export function toolResult(value: unknown): ToolExecutionResult {
  const result = bounded(value, RESULT_ENVELOPE_BYTES) as Record<string, unknown>;
  if (!result || typeof result !== 'object' || !Array.isArray(result.content)) throw new CodingResourcesUnavailable();
  for (const part of result.content as Record<string, unknown>[]) {
    if (!part || (part.type === 'text' ? typeof part.text !== 'string' : part.type !== 'image'
      || typeof part.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(part.data)
      || !['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp'].includes(String(part.mimeType)))) throw new CodingResourcesUnavailable();
  }
  // 写正式结果前与投影接收同一图片合同，非法图片不能先污染历史、再使会话读取失败。
  parseWorkImages((result.content as Record<string, unknown>[]).filter(part=>part.type==='image').map(part=>({type:'image',data:part.data,mimeType:part.mimeType})));
  if (result.isError !== undefined && typeof result.isError !== 'boolean') throw new CodingResourcesUnavailable();
  // coding-agent 的 content 合同不变，只在进入 Durable 1.3 时投影为 output。
  return { output: result.content as NonNullable<ToolExecutionResult['output']>,
    ...(result.isError === undefined ? {} : { isError: result.isError as boolean }),
    ...((result.details === undefined && result.structuredContent === undefined) ? {} : { details: { ...(result.details && typeof result.details === 'object' && !Array.isArray(result.details) ? result.details as JsonObject : {}), ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent as JsonValue }) } }) };
}

type StartMessage = NonNullable<BeforeAgentStartEventResult['message']>;
export function startedResult(value: unknown) {
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
