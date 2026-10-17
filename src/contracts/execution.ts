/** 执行端序列化合同；不依赖 Pi、Electron 或存储实现。 */
import { parseWorkReferences } from "./references";
import type { WorkReference } from "./references";
import type { FileChange } from './changes';

export type ExecutionTarget = Readonly<{
  workspaceId: string;
  taskId: string;
  sessionId: string;
}>;

export type ControlToken = Readonly<{ instanceId: string; revision: number }>;
/** 与 Pi 正式消息相同的有限图片内容；不接收任意 URL 或宿主路径。 */
export type WorkImage = Readonly<{ type: 'image'; data: string; mimeType: string }>;
export function parseWorkImages(value: unknown): readonly WorkImage[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 4) throw new Error('Invalid images');
  let bytes = 0;
  const images = value.map(part => {
    if (typeof part !== 'object' || part === null || Array.isArray(part) || part.type !== 'image'
      || !['image/png','image/jpeg','image/webp','image/gif','image/bmp'].includes(part.mimeType)
      || typeof part.data !== 'string' || !part.data.length || part.data.length % 4 !== 0
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(part.data) || Object.keys(part).some(key => !['type','data','mimeType'].includes(key))) throw new Error('Invalid image content');
    bytes += part.data.length;
    if (bytes > 8 * 1024 * 1024) throw new Error('Image capacity exceeded');
    return Object.freeze({ type: 'image' as const, data: part.data as string, mimeType: part.mimeType as string });
  });
  return Object.freeze(images);
}

export type WorkInput = Readonly<{
  target: ExecutionTarget;
  operationId: string;
  /** 用户原文字：引用不改写它，也不把它与引用内容拼接。 */
  text: string;
  /** 本次发送携带的引用（身份 + 快照），逐条与 text 分开提交给模型。 */
  references: readonly WorkReference[];
  images?: readonly WorkImage[];
  mode: 'steer' | 'follow-up';
  expected: ControlToken;
}>;
export type InputReceipt =
  | { status: 'accepted'; operationId: string; submissionId: number; processing: 'queued' | 'placed' | 'done' | 'unanswered' }
  // `model-unavailable`：本次请求的模型条件不成立（已知全部耗尽／没有适合候选／指定模型不可用）。
  // 与 `paused` 分开：工作被保留是因为**模型条件**，不是因为用户暂停，界面必须能分别呈现。
  | { status: 'not-accepted'; operationId: string; reason: 'paused' | 'stale-control' | 'conflict' | 'not-found' | 'storage-rejected' | 'model-unavailable' | 'execution-unavailable' }
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
    /** 扩展正式接收的输入，供桌面投影补齐原消息身份；不是第二份执行队列。 */
    extensionInput?: { operationId: string; text: string; images?: readonly WorkImage[]; mode: 'steer' | 'follow-up'; submissionId: number; processing: 'queued' | 'placed' | 'done' | 'unanswered' };
    /** Pi 正式模型消息中的工具结果；诊断不能替代正文或数字出口。 */
    toolResult?: { name: string; callId: string; text: string; isError: boolean; exitCode?: number; changes: FileChange[]; changeNotice?: string; images?: readonly WorkImage[] };
    /** 已提交助手消息的正文；按原顺序拼接文本块，不含思考或工具调用块。 */
    assistantText?: string;
    extensionMessage?: { customType: string; text: string; display: boolean };
    /**
     * 本条记录是否代表真实服务端失败（有限安全码，不携带原文/密钥/URL/HTTP 细节）：
     * - auth-failed：请求被服务端认作未授权/凭据无效（401 / invalid key 等）；
     * - model-request-failed：其他真实 model 端错误（连接失败、4xx/5xx、超时等）；
     * 无此字段 = 正常完成或被用户/暂停路径中断（不等于服务商失败）。
     */
    failureKind?: 'auth-failed' | 'model-request-failed';
    /** 本条助手消息的**真实**请求归属：来源、模型与响应标识。
     *  全部来自执行端保存的助手条目，不是界面推断或计划值。 */
    provider?: string;
    model?: string;
    /** 服务端返回的响应标识；缺失说明这条记录没有可核对的响应身份 */
    responseId?: string;
    /** 实际使用的思考档位（Pi 层记录该次请求所用的档位） */
    thinkingLevel?: string;
    /** 该次真实请求的用量；无记录时不出现，绝不由计划或额度推算 */
    usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  }>;
  /** 当前运行工具的有界只读增量；不进入正式历史或用量，也不持久化为产品事实。 */
  toolProgress?: ReadonlyArray<{ taskId: number; callId: string; name: string; text: string; droppedBytes: number; droppedLines: number }>;
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
  return Object.freeze({
    target: parseTarget(input.target),
    operationId: text(input.operationId),
    text: text(input.text, 1_000_000),
    // 引用在接收侧逐条校验；畸形引用让整次提交被拒，不做静默丢弃后照常发送。
    references: parseWorkReferences(input.references),
    ...(input.images === undefined ? {} : { images: parseWorkImages(input.images) }),
    mode: input.mode,
    expected: parseControl(input.expected),
  });
}
