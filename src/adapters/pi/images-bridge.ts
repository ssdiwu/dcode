import type { AssistantImages, ImagesContext, Usage } from '@earendil-works/pi-ai';
import { parseWorkImages } from '@/contracts/index.ts';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const reject = (): never => { throw new Error('图片请求或结果不符合SDK合同'); };

/** 只复制已确认元数据；大图/坏图不能先挡住原响应的真实费用。 */
export function imageResponse(value: unknown): Omit<AssistantImages, 'output'> {
  if (!object(value) || typeof value.api !== 'string' || typeof value.provider !== 'string' || typeof value.model !== 'string'
    || !finite(value.timestamp) || !['stop', 'error', 'aborted'].includes(String(value.stopReason))
    || (value.responseId !== undefined && (typeof value.responseId !== 'string' || value.responseId.length > 1024))
    || (value.errorMessage !== undefined && typeof value.errorMessage !== 'string')) return reject();
  if (value.usage !== undefined) {
    const u = value.usage;
    if (!object(u) || !['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'].every(key => finite(u[key]))
      || !object(u.cost) || !['input', 'output', 'cacheRead', 'cacheWrite', 'total'].every(key => finite((u.cost as Record<string, unknown>)[key]))) return reject();
  }
  return { api: value.api as AssistantImages['api'], provider: value.provider, model: value.model, timestamp: value.timestamp,
    stopReason: value.stopReason as AssistantImages['stopReason'], ...(value.responseId === undefined ? {} : { responseId: value.responseId }),
    ...(value.usage === undefined ? {} : { usage: JSON.parse(JSON.stringify(value.usage)) as Usage }),
    ...(value.errorMessage === undefined ? {} : { errorMessage: value.errorMessage.slice(0, 4096) }) };
}

function content(value: unknown): AssistantImages['output'] {
  if (!Array.isArray(value) || value.length > 64) return reject();
  let textBytes = 0;
  for (const part of value) {
    if (!object(part)) return reject();
    if (part.type === 'text') {
      if (typeof part.text !== 'string' || Object.keys(part).some(key => key !== 'type' && key !== 'text')) return reject();
      textBytes += Buffer.byteLength(part.text);
      if (textBytes > 1024 * 1024) return reject();
    } else if (part.type !== 'image') return reject();
  }
  parseWorkImages(value.filter(part => part.type === 'image'));
  return value as AssistantImages['output'];
}

export function imagesInput(value: unknown): ImagesContext {
  if (!object(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'input')) return reject();
  const input = content(value.input);
  if (!input.length) return reject();
  return { input };
}

export function imagesOptions(value: Record<string, unknown>): void {
  // metadata与供应商扩展选项尚无实际消费者证明，先明确拒绝而非静默忽略。
  if (Object.keys(value).some(key => !['timeoutMs', 'maxRetries', 'maxRetryDelayMs'].includes(key))
    || (value.maxRetries !== undefined && value.maxRetries !== 0)
    || (value.timeoutMs !== undefined && (!finite(value.timeoutMs) || value.timeoutMs === 0))
    || (value.maxRetryDelayMs !== undefined && !finite(value.maxRetryDelayMs))) return reject();
}

export function imagesResult(value: unknown): AssistantImages {
  const metadata = imageResponse(value);
  return { ...metadata, output: content((value as Record<string, unknown>).output) };
}
