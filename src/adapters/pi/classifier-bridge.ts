import type { ClassifierContext, ClassifierResult, Usage } from '@earendil-works/pi-ai';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string';
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const reject = (): never => { throw new Error('分类请求或结果不符合SDK合同'); };

/** Worker外部边界重新核公开问题结构；不让JSON静默丢字段后冒充原请求。 */
export function classifierInput(value: unknown): ClassifierContext {
  if (!object(value) || !object(value.state) || !object(value.questions)
    || Object.keys(value).some(key => key !== 'state' && key !== 'questions')) return reject();
  for (const question of Object.values(value.questions)) {
    if (!object(question) || !text(question.instructions) || Object.keys(question).some(key => !['type', 'instructions', 'criteria'].includes(key))) return reject();
    if (question.type === 'choice') {
      if (!object(question.criteria) || !Object.values(question.criteria).every(text)) return reject();
    } else if (question.type === 'score') {
      if (!Array.isArray(question.criteria) || !question.criteria.every(text)) return reject();
    } else if (question.type === 'bool') {
      if (!object(question.criteria) || Object.keys(question.criteria).length !== 2 || !text(question.criteria.true) || !text(question.criteria.false)) return reject();
    } else return reject();
  }
  return value as unknown as ClassifierContext;
}

export function classifierOptions(options: Record<string, unknown>): void {
  if (Object.keys(options).some(key => !['temperature', 'timeoutMs', 'maxRetries', 'maxRetryDelayMs'].includes(key))
    || (options.maxRetries !== undefined && options.maxRetries !== 0)
    || (options.temperature !== undefined && !finite(options.temperature))
    || (options.timeoutMs !== undefined && (!finite(options.timeoutMs) || options.timeoutMs <= 0))
    || (options.maxRetryDelayMs !== undefined && (!finite(options.maxRetryDelayMs) || options.maxRetryDelayMs < 0))) reject();
}

/** SDK错误也可带真实usage；无usage保持缺席，不补0或伪造chat消息。 */
export function classifierResult(value: unknown): ClassifierResult {
  if (!object(value) || !text(value.api) || !text(value.provider) || !text(value.model) || !finite(value.timestamp)
    || !['stop', 'error', 'aborted'].includes(String(value.stopReason)) || !object(value.answers)
    || (value.errorMessage !== undefined && !text(value.errorMessage))) return reject();
  for (const answer of Object.values(value.answers)) {
    if (!object(answer)) return reject();
    if (answer.type === 'choice') {
      if (!text(answer.choice) || !object(answer.probabilities) || !Object.values(answer.probabilities).every(finite) || !finite(answer.confidence)) return reject();
    } else if (answer.type === 'score') {
      if (!finite(answer.score) || !finite(answer.confidence)) return reject();
    } else if (answer.type === 'bool') { if (!finite(answer.probability)) return reject(); }
    else return reject();
  }
  if (value.usage !== undefined) {
    const usage = value.usage;
    if (!object(usage) || !['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'].every(key => finite(usage[key]))
      || !object(usage.cost) || !['input', 'output', 'cacheRead', 'cacheWrite', 'total'].every(key => finite((usage.cost as Record<string, unknown>)[key]))) return reject();
  }
  return value as unknown as ClassifierResult;
}

export type OwnedModelResult = { readonly usage?: Usage };
