import type { Api, Model, Models } from '@earendil-works/pi-ai';
import { clampMaxTokensToContext } from '@earendil-works/pi-ai/api/simple-options';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { estimateTokens } from '@earendil-works/pi-coding-agent';

/** 两次物理准入共用预算：SDK 的输出上限还须容纳本次完整正文，旧 usage 不替代跨模型容量核对。 */
export function physicalRequestBudget(model: Model<Api>, input: Parameters<Models['streamSimple']>[1], requested: number | undefined) {
  const transcript = normalizeContext(input);
  const estimated = transcript.messages.reduce((total, message) => total + estimateTokens(message), 0);
  let maxTokens = model.maxTokens > 0
    ? clampMaxTokensToContext(model, transcript, Math.min(requested ?? model.maxTokens, model.maxTokens)) : requested;
  if (model.contextWindow > 0) {
    const room = model.contextWindow - estimated;
    if (room < 1) return { maxTokens, capacityExceeded: true };
    // 旧响应的 usage 可比完整待发正文小；收紧输出预算，而非拒绝仍可容纳的普通后续请求。
    if (maxTokens !== undefined) maxTokens = Math.min(maxTokens, room);
  }
  return { maxTokens, capacityExceeded: false };
}
