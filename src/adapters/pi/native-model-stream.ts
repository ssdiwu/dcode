import { getSupportedThinkingLevels } from '@earendil-works/pi-ai/models';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { SdkRequestTarget } from '@/application';

// 只由宿主已认领的模型子任务添加；JSON Worker 不能伪造 Symbol，也不能把 complete 改成原生流。
export const ownedNativeStream = Symbol('dcode.owned-native-stream');

const supportedOptions = new Set(['temperature', 'maxTokens', 'maxRetries', 'timeoutMs', 'cacheRetention', 'sessionId', 'toolChoice', 'reasoningEffort']);
export function validateNativeStreamOptions(api: string, options: Record<string, unknown>): void {
  if (api !== 'openai-completions' || Object.keys(options).some(key => !supportedOptions.has(key))) {
    throw new Error('该原生模型流的协议或选项尚未接入');
  }
}

export function validateNativeStreamTarget(originalApi: unknown, model: Model<Api>, target: { thinkingLevel?: SdkRequestTarget['thinkingLevel'] }, options: Record<string, unknown>): void {
  if (originalApi !== 'openai-completions' || model.api !== originalApi) throw new Error('原生模型流不能跨协议改选');
  // SDK 在末尾合并 samplingParams，可覆盖身份、正文和思考字段；未核等价的覆盖口不能旁路完整准入。
  if (model.samplingParams && Object.keys(model.samplingParams).length) throw new Error('该模型的原生采样覆盖尚未接入');
  const level = target.thinkingLevel;
  if (level === undefined) throw new Error('原生模型流缺少权威思考裁定');
  if (level === null || level === 'off') {
    if (options.reasoningEffort !== undefined) throw new Error('原生思考参数与当前会话裁定不一致');
  } else if (!model.reasoning || !getSupportedThinkingLevels(model).includes(level) || options.reasoningEffort !== level) {
    throw new Error('原生思考参数与当前会话裁定不一致');
  }
}
