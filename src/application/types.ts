// 应用层的适配接口与持久化形状；单独成文件以避免 index ↔ seed 的文件循环。
// 执行类型引用共享合同；真实运行实例只由应用层持有，界面只接收产品投影。

import type {
  RunState,
  Session,
  SessionModelState,
  Settings,
  Task,
  TimelineBlock,
  Workspace,
} from "@/contracts";

// 执行身份、输入和视图复用正式共享合同；端口只有 ports.ts 一处定义。
import type { ExecutionTarget } from "@/contracts";
import type { ExecutionPort } from "./ports";
export type { ControlToken, ExecutionTarget, ExecutionView, WorkInput } from "@/contracts";
export type { ExecutionPort, ReferencePort, ReferenceRequest, ModelSourcePort, ModelSourceEntry } from "./ports";

/** 本次会话**要用的**模型引用：由会话选择与路由判定得出，发请求前才应用。 */
export interface SessionModelRef {
  /** 来源标识（预设 providerId 或自定义接入身份） */
  readonly sourceId: string;
  readonly modelId: string;
  /** 已逐档核实为支持的思考档位；null = 用该模型的默认档位 */
  readonly thinkingLevel: import("@/contracts").ThinkingLevel | null;
}

export interface SessionExecutionContext {
  /** 当前已保存的资源开关；仅执行准备读取，普通打开不加载。 */
  projectExtensionsEnabled?: () => boolean;
  target: ExecutionTarget;
  /** 产品对象的目录信息；当前受控演示后端只使用自己的隔离目录，不访问此目录 */
  workFolder: string | null;
  title: string;
  /** 该会话**本次请求**要用的模型与条件参数。发请求前按它应用，不是只在 open 时定一次。 */
  model: SessionModelRef | null;
  /** 只有明确的新输入可初始化空运行；观察、回查和继续均要求原记录。 */
  initialize?: boolean;
  /** 由应用层现有任务所有者判定；未装配成员文件范围时不启用项目 IO。 */
  projectAccess?: 'task-owner' | null;
}

export interface ExecutionBackend {
  readonly kind: "unavailable" | "mock" | "pi";
  /** 来自实际装配的模型名称；null 表示没有执行能力，不从旧标签解锁。 */
  readonly modelName: string | null;
  open(context: SessionExecutionContext): Promise<ExecutionPort>;
  /**
   * 按当次配置重新登记**已配置来源**的可请求身份（认证提交之后调用）。
   *
   * 凭据刚提交时，这个客户端是在那之前建好的：只刷新目录不会让它认得新来源，
   * 界面显示已认证而实际请求发不出去。可选能力：不具备的实现不提供该方法。
   */
  refreshAdditionalSources?(sources: readonly ConfiguredSourceIdentity[] | undefined): Promise<void>;
}

/** 执行端登记一条已配置来源所需的最小形状（不把适配器的模型类型泄漏到应用层）。 */
export interface ConfiguredSourceIdentity {
  readonly providerId: string;
}

/** 草稿首发的在途关联：对象已建但接收未确认时，重开/重试据其复用同一对象与操作身份，不重复建对象。 */
export type PendingFirstSend = Readonly<{
  sessionId: string;
  text: string;
  mode: "steer" | "follow-up";
  operationId: string;
}>;

export interface PersistedState {
  /** 同次创建的持久回执；仅正式保存成功后加入，旧文件缺省为空，不迁移旧对象。 */
  workspaceBindingReceipts?: Record<string, { workspaceId: string; selectionId: string; name: string }>;
  /** 任务与唯一主会话同次保存的创建身份；只读查回不再次创建。 */
  taskCreationReceipts?: Record<string, { workspaceId: string; title: string; taskId: string; sessionId: string }>;
  workspaces: Workspace[];
  tasks: Task[];
  sessions: Session[];
  timelines: Record<string, TimelineBlock[]>;
  runs: Record<string, RunState>;
  settings: Settings;
  /** 用户已明确保存过候选范围；清空与初始未配置不同，旧文件按已有名单迁移。 */
  modelCandidateScopeConfigured?: boolean;
  /** 旧标签仅保全，不作为可用性依据，不经界面桥输出。 */
  model?: { configured: boolean; label: string | null; simulated: true };
  /** 草稿任务 id → 首发在途关联；接收确认后解除。持久化，重开后仍复用（规格：冷启动与草稿态两阶段可回查） */
  pendingFirstSends: Record<string, PendingFirstSend>;
  /** 新会话的首次运行建立尚未收口；正式提交之前移除并保存，不是输入／运行状态。 */
  runtimeCreationPending?: string[];
  /** sessionId → 该会话的模型状态（选择方式、实际执行模型、路由尝试分别可辨）。
   *  与 settings.newSessionModelChoice 是两份事实：后者只决定此后新建会话的初值。 */
  sessionModels: Record<string, SessionModelState>;
}

export type LoadResult =
  | { status: "missing" }
  | { status: "ok"; state: PersistedState }
  | { status: "corrupt"; error: string; preservedAs: string }
  | { status: "unreadable"; error: string };

export interface StorageAdapter {
  /** 四分支：确实不存在／读取成功／已确认且成功保全的损坏／读取或保全失败（保留原文件、显式报错、不得种子覆盖） */
  load(): Promise<LoadResult>;
  /** 运行中查回：只读正式状态，不改名、不清理、不改变启动期拒写保护；缺此能力时结果仍未知。 */
  readCurrent?(): Promise<LoadResult>;
  save(state: PersistedState): Promise<void>;
}
