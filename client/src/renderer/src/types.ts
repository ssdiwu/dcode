/** 与 host/src/product-store.ts 对齐的呈现层只读投影类型（子集）。 */

export type TaskScope =
  | { kind: "user"; userId: string }
  | { kind: "project"; projectId: string };

export type TaskState =
  | "draft"
  | "active"
  | "waiting"
  | "completed"
  | "rejected"
  | "archived";

export interface TaskRecord {
  id: string;
  scope: TaskScope;
  title: string;
  goal: string;
  acceptance: string[];
  cwd: string;
  state: TaskState;
  updatedAt: string;
}

export interface ProjectRecord {
  id: string;
  title: string;
}

export type TaskWorkItemState =
  | "pending"
  | "in_progress"
  | "completed"
  | "blocked"
  | "cancelled";

export interface TaskWorkItemRecord {
  id: string;
  taskId: string;
  ordinal: number;
  title: string;
  state: TaskWorkItemState;
}

export interface AgentProfileRecord {
  id: string;
  name: string;
}

export interface CoordinatorAssignmentRecord {
  id: string;
  taskId: string;
  sessionId: string;
  profileId: string;
}

export interface FoundationSnapshot {
  schemaVersion: number;
  storeRevision: number;
  dataRoot: string;
  currentUser: { id: string };
  projects: ProjectRecord[];
  tasks: TaskRecord[];
  taskWorkItems: TaskWorkItemRecord[];
  agentProfiles: AgentProfileRecord[];
  coordinatorAssignments: CoordinatorAssignmentRecord[];
  sessions: { id: string; taskId?: string }[];
}

export interface DcodeApi {
  request: (
    method: string,
    params?: Record<string, unknown>,
  ) => Promise<unknown>;
  subscribe: (handler: (envelope: unknown) => void) => () => void;
}

export function api(): DcodeApi {
  const value = (window as unknown as { dcode?: DcodeApi }).dcode;
  if (!value) throw new Error("dcode bridge missing: preload 未加载");
  return value;
}

export async function fetchSnapshot(): Promise<FoundationSnapshot> {
  return (await api().request("foundation.snapshot")) as FoundationSnapshot;
}

export function taskProjectId(task: TaskRecord): string | null {
  return task.scope.kind === "project" ? task.scope.projectId : null;
}
