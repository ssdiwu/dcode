// 应用层的适配接口与持久化形状；单独成文件以避免 index ↔ seed 的文件循环。
// 执行类型引用共享合同；真实运行实例只由应用层持有，界面只接收产品投影。

import type {
  RunState,
  Session,
  Settings,
  Task,
  TimelineBlock,
  Workspace,
} from "@/contracts";

// 执行身份、输入和视图复用正式共享合同；端口只有 ports.ts 一处定义。
import type { ExecutionTarget } from "@/contracts";
import type { ExecutionPort } from "./ports";
export type { ControlToken, ExecutionTarget, ExecutionView, WorkInput } from "@/contracts";
export type { ExecutionPort } from "./ports";

export interface SessionExecutionContext {
  target: ExecutionTarget;
  /** 产品对象的目录信息；当前受控演示后端只使用自己的隔离目录，不访问此目录 */
  workFolder: string | null;
  title: string;
}

export interface ExecutionBackend {
  readonly kind: "unavailable" | "mock" | "pi";
  /** 来自实际装配的模型名称；null 表示没有执行能力，不从旧标签解锁。 */
  readonly modelName: string | null;
  open(context: SessionExecutionContext): Promise<ExecutionPort>;
}

/** 草稿首发的在途关联：对象已建但接收未确认时，重开/重试据其复用同一对象与操作身份，不重复建对象。 */
export type PendingFirstSend = Readonly<{
  sessionId: string;
  text: string;
  mode: "steer" | "follow-up";
  operationId: string;
}>;

export interface PersistedState {
  workspaces: Workspace[];
  tasks: Task[];
  sessions: Session[];
  timelines: Record<string, TimelineBlock[]>;
  runs: Record<string, RunState>;
  settings: Settings;
  /** 旧标签仅保全，不作为可用性依据，不经界面桥输出。 */
  model?: { configured: boolean; label: string | null; simulated: true };
  /** 草稿任务 id → 首发在途关联；接收确认后解除。持久化，重开后仍复用（规格：冷启动与草稿态两阶段可回查） */
  pendingFirstSends: Record<string, PendingFirstSend>;
}

export type LoadResult =
  | { status: "missing" }
  | { status: "ok"; state: PersistedState }
  | { status: "corrupt"; error: string; preservedAs: string }
  | { status: "unreadable"; error: string };

export interface StorageAdapter {
  /** 四分支：确实不存在／读取成功／已确认且成功保全的损坏／读取或保全失败（保留原文件、显式报错、不得种子覆盖） */
  load(): Promise<LoadResult>;
  save(state: PersistedState): Promise<void>;
}
