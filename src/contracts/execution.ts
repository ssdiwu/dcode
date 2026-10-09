/** 执行端序列化合同；不依赖 Pi、Electron 或存储实现。 */
export type ExecutionTarget = Readonly<{
  workspaceId: string;
  taskId: string;
  sessionId: string;
}>;

export type ControlToken = Readonly<{ instanceId: string; revision: number }>;
export type WorkInput = Readonly<{
  target: ExecutionTarget;
  operationId: string;
  text: string;
  mode: 'steer' | 'follow-up';
  expected: ControlToken;
}>;
export type InputReceipt =
  | { status: 'accepted'; operationId: string; submissionId: number; processing: 'queued' | 'placed' | 'done' | 'unanswered' }
  | { status: 'not-accepted'; operationId: string; reason: 'paused' | 'stale-control' | 'conflict' | 'not-found' | 'storage-rejected' }
  | { status: 'unknown'; operationId: string; reason: 'storage-unavailable' };

export type ExecutionView = Readonly<{
  target: ExecutionTarget;
  control: ControlToken;
  observation: number;
  phase: 'ready' | 'running' | 'pausing' | 'paused' | 'faulted';
  execution: 'pi-durable-1.0.0' | 'mock';
  model: { provider: string; modelId: string } | null;
  entries: ReadonlyArray<{
    id: number;
    kind: string;
    data: unknown;
    /** 已提交助手消息的正文；按原顺序拼接文本块，不含思考或工具调用块。 */
    assistantText?: string;
    /**
     * 本条记录是否代表真实服务端失败（有限安全码，不携带原文/密钥/URL/HTTP 细节）：
     * - auth-failed：请求被服务端认作未授权/凭据无效（401 / invalid key 等）；
     * - model-request-failed：其他真实 model 端错误（连接失败、4xx/5xx、超时等）；
     * 无此字段 = 正常完成或被用户/暂停路径中断（不等于服务商失败）。
     */
    failureKind?: 'auth-failed' | 'model-request-failed';
  }>;
  pendingInputs: number;
}>;

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid execution request');
  return value as Record<string, unknown>;
}
function text(value: unknown, limit = 256): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > limit) throw new Error('Invalid execution request');
  return value;
}
export function parseTarget(value: unknown): ExecutionTarget {
  const input = record(value);
  return Object.freeze({ workspaceId: text(input.workspaceId), taskId: text(input.taskId), sessionId: text(input.sessionId) });
}
export function parseControl(value: unknown): ControlToken {
  const input = record(value);
  if (!Number.isSafeInteger(input.revision) || (input.revision as number) < 0) throw new Error('Invalid execution control');
  return Object.freeze({ instanceId: text(input.instanceId), revision: input.revision as number });
}
export function parseWorkInput(value: unknown): WorkInput {
  const input = record(value);
  if (input.mode !== 'steer' && input.mode !== 'follow-up') throw new Error('Invalid input mode');
  return Object.freeze({ target: parseTarget(input.target), operationId: text(input.operationId), text: text(input.text, 1_000_000), mode: input.mode, expected: parseControl(input.expected) });
}
