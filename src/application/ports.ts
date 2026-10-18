import type { ControlToken, ExecutionTarget, ExecutionView, InputReceipt } from '@/contracts/index.ts';
import type { ReferenceKind, ReferenceListing, WorkReference } from '@/contracts/index.ts';
import type { ThinkingLevel } from '@/contracts/index.ts';
import type { ProjectFolderSelection } from '@/contracts/index.ts';

/** 本次用户目录选择事实；应用只按不透明身份核对，不接收界面任意路径。 */
export interface ProjectFolderPort {
  choose(input: { operationId: string; requestId: string }): Promise<ProjectFolderSelection | null>;
  resolve(input: { operationId: string; selectionId: string }): Promise<string>;
  discard(operationId: string): void;
}

/** 宿主核对任务/成员授权后调用；这里不接受第二份输入队列。 */
export interface ExecutionPort {
  readonly target: ExecutionTarget;
  read(): Promise<ExecutionView>;
  submit(input: unknown): Promise<InputReceipt>;
  lookupReceipt(input: unknown): Promise<InputReceipt>;
  pause(): Promise<ExecutionView>;
  resume(expected: ControlToken): Promise<ExecutionView>;
  close(): Promise<void>;
}

/** 一次已配置模型的请求身份（裁定与实际发起必须一致的那一份）。 */
export interface SdkRequestTarget {
  readonly sourceId: string;
  readonly modelId: string;
  /** 已按这个目标逐档核实；null 清除旧模型档位，交由该模型的正式默认通路。 */
  readonly thinkingLevel: ThinkingLevel | null;
}

/** 每次 SDK 请求前的完整准入裁定：放行，或给出不放行的真实原因。 */
export interface SdkRequestAdmission {
  readonly ok: boolean;
  /** 不放行的原因（界面与诊断用；只含产品事实，不含凭据或服务端正文） */
  readonly reason: string | null;
  /**
   * 放行时**本次该发往的身份**。
   *
   * 执行端在这一步之前已经准备好了某个模型；裁定可能改用另一个（额度、能力或名单变化）。
   * 裁定不给身份，执行端就只能继续发它原来准备的那个——「核准 B、发出 A」。
   * null 表示这次没有可核对身份，调用方不得凭空挑一个发出去。
   */
  readonly target: SdkRequestTarget | null;
}

/**
 * 执行端在**每次** SDK 请求前调用的准入门（由应用层提供，适配器只消费裁定）。
 *
 * 发送、可靠重投与恢复只是**三次**准入；工具回合会在长输出过程中自己发起后续请求，
 * 那之后额度、能力依据、候选范围与认证在途都可能已变。没有这道门，
 * "下一次请求前核对这些事实"就只是发送那一刻的结论。
 */
export type SdkRequestAdmissionGate = (request: {
  readonly sessionId: string;
  readonly sourceId: string;
  readonly modelId: string;
  readonly requires?: readonly import('@/contracts/index.ts').WorkCapability[];
  /** typed 显式消费者不参与聊天 Auto；仍核相位、来源、能力种类及账户额度。 */
  readonly operation?: 'classify' | 'generateImages';
}) => Promise<SdkRequestAdmission>;

/** 一次引用读取请求的归属：会话、其所属工作空间，以及该空间绑定的文件夹（可能含 `~`）。
 *  适配器负责解析 `~`、核对根边界并如实报告不可读；应用层不碰文件系统。 */
export interface ReferenceRequest {
  readonly workspaceId: string;
  /** 已有会话时为其 id；新任务草稿尚无会话，为 null */
  readonly sessionId: string | null;
  /** 归属任务（会话任务或草稿任务），迟到结果按它与当前目标比对 */
  readonly taskId: string;
  /** 本次请求身份：迟到结果按它与当前会话/工作空间比对，不匹配即丢弃。 */
  readonly operationId: string;
  readonly folders: readonly string[];
}

/** 读取事实的正式端口：只发现与读取，不发送、不执行、不安装、不新增授权。 */
export interface ReferencePort {
  list(request: ReferenceRequest): Promise<ReferenceListing>;
  /** 读取并固化一份快照。失败以带原因码的错误抛出，不返回半成品引用。 */
  capture(request: ReferenceRequest, kind: ReferenceKind, locator: string): Promise<WorkReference>;
}

/** 一个来源下的一个模型（只带身份与显示名；能力资料另经 CapabilityPort 读，不在此复制）。 */
export interface ModelSourceEntry {
  readonly sourceId: string;
  readonly sourceLabel: string;
  /** 该来源是否已有凭据；只表达凭据存在，不代表已验证可调用 */
  readonly configured: boolean;
  readonly models: readonly { readonly modelId: string; readonly modelLabel: string }[];
}

/**
 * 模型来源目录端口（两层入口的第一层）。
 * 读取本身**不**启动执行、不发送输入、不读额度；界面按需再显式读取额度。
 * 应用层不从来源目录推断能力或额度：目录只回答「有哪些来源和模型」。
 */
export interface ModelSourcePort {
  list(): Promise<readonly ModelSourceEntry[]>;
  /** 只核已配置来源的原生 typed 身份，不把它加入聊天列表或启动模型。 */
  hasTypedModel?(request: { sourceId: string; modelId: string; type: 'classifier' | 'image' }): Promise<boolean>;
}
