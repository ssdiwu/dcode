import { createHash, randomUUID } from "node:crypto";
import { chmod, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, parse, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  assertSafeProductStoreTarget,
  prepareManagedDCodeDirectory,
  resolveDCodeDataRoot,
  type DCodeDataRootLayout,
} from "./dcode-data-root.js";
import { ProductStoreLease } from "./product-store-lease.js";
import {
  PRODUCT_STORE_SCHEMA_VERSION,
  configureWritableProductStore,
  initializeProductStoreAtomically,
  validateProductStoreSchema,
} from "./product-store-schema.js";
import { buildLegacyMigrationPlan, type LegacyStoreKind } from "./legacy-migration.js";
import { redactCredentialText } from "./credential-material.js";
import {
  DCodePromptSourceReceiptError,
  normalizeDCodePromptSourceReceipts,
  type DCodePromptSourceReceipt,
} from "./prompt-source-status.js";

export type TaskScope =
  | { kind: "user"; userId: string }
  | { kind: "project"; projectId: string };

export interface LocalUserRecord {
  id: string;
  homeDirectory: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRecord {
  id: string;
  userId: string;
  title: string;
  directory: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentProfileRecord {
  id: string;
  role: "coordinator" | "explore" | "worker" | "verifier" | "custom";
  name: string;
  roleContract: string;
  enabled: boolean;
  builtin: boolean;
  profileVersion: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRecord {
  id: string;
  scope: TaskScope;
  title: string;
  goal: string;
  acceptance: string[];
  cwd: string;
  state: "draft" | "active" | "waiting" | "completed" | "rejected" | "archived";
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface DCodeSessionRecord {
  id: string;
  taskId: string;
  kind: "coordination" | "child" | "standard";
  title: string;
  runtimeAdapter: "pi";
  lineageStatus: "native" | "unknown";
  state: "idle" | "active" | "waiting" | "completed" | "failed" | "archived";
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface SessionPathRecord {
  id: string;
  sessionId: string;
  sourcePathId?: string;
  sourceLeafEntryId?: string;
  title: string;
  isCurrent: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface SessionProvenanceRecord {
  id: string;
  taskId: string;
  sessionId: string;
  sourceKind: "native" | "pi_import" | "legacy_adoption";
  sourceSessionId?: string;
  sourcePath?: string;
  sourceDigest?: string;
  historicalCwd?: string;
  lineageStatus: "native" | "unknown";
  details: unknown;
  createdAt: string;
}

export interface ImportedPiSessionEntryInput {
  sourceEntryId: string;
  sourceParentEntryId?: string;
  sourceOrdinal: number;
  sourceTimestamp?: string;
  messageRole: "user" | "assistant" | "toolResult" | "other";
  content: unknown;
}

export interface ImportedPiSessionPathInput {
  sourcePathId: string;
  sourceLeafEntryId?: string;
  title: string;
  isCurrent: boolean;
  sourceEntryIds: string[];
}

export interface SessionEntryRecord {
  id: string;
  sessionId: string;
  sourceKind: "native" | "pi_import" | "legacy_adoption";
  lineageStatus: "native" | "unknown";
  sourceEntryId?: string;
  sourceParentEntryId?: string;
  sourceOrdinal?: number;
  sourceTimestamp?: string;
  messageRole: ImportedPiSessionEntryInput["messageRole"];
  content: unknown;
  createdAt: string;
}

export interface PiImportSourceRecord {
  id: string;
  sourceSessionId: string;
  sourcePath: string;
  sourceDigest: string;
  importerVersion: number;
  taskId: string;
  sessionId: string;
  lineageStatus: "unknown";
  state: "completed";
  createdAt: string;
  updatedAt: string;
}

export interface CoordinatorAssignmentRecord {
  id: string;
  taskId: string;
  sessionId: string;
  profileId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface StoreEventRecord {
  sequence: number;
  eventId: string;
  storeRevision: number;
  kind: string;
  entityKind: string;
  entityId: string;
  taskId?: string;
  payload: unknown;
  createdAt: string;
}

export interface TaskBundle {
  storeRevision: number;
  task: TaskRecord;
  coordinationSession: DCodeSessionRecord;
  coordinatorAssignment: CoordinatorAssignmentRecord;
}

export interface PiImportTaskResult extends TaskBundle {
  piImport: PiImportSourceRecord;
  importedEntryCount: number;
}

export interface PreparedSessionRun {
  storeRevision: number;
  rawInputId: string;
  userEntryId: string;
  effectiveInputId: string;
  runtimeEnvironmentId: string;
  activeToolSetId: string;
  sessionRunId: string;
  promptReceiptId: string;
  providerAttemptId: string;
}

export interface SessionRunRecord {
  id: string;
  taskId: string;
  sessionId: string;
  runtimeId: string;
  agentRunId?: string;
  effectiveInputId?: string;
  runtimeEnvironmentId?: string;
  activeToolSetId?: string;
  status: string;
  revision: number;
  startedAt?: string;
  completedAt?: string;
}

export interface OperationAttemptRecord {
  id: string;
  taskId: string;
  sessionId?: string;
  sessionRunId?: string;
  agentRunId?: string;
  operationKind: string;
  targetIdentity: string;
  parameterDigest: string;
  replayPolicy: string;
  status: "prepared" | "succeeded" | "failed" | "unknown";
  outcome?: unknown;
  preparedAt: string;
  completedAt?: string;
}

export interface SessionRuntimeBinding {
  sessionId: string;
  taskId: string;
  adapterKind: "pi";
  adapterSessionId: string;
  adapterSessionPath: string;
  cwd: string;
  state: "ready" | "closed" | "invalid";
  revision: number;
}

export interface TeamRunRecord {
  id: string;
  taskId: string;
  coordinatorAgentRunId: string;
  status: string;
  revision: number;
}

export interface AgentRunRecord {
  id: string;
  taskId: string;
  teamRunId?: string;
  sessionId: string;
  profileId: string;
  profileSnapshot: unknown;
  role: string;
  status: string;
  revision: number;
}

export interface RuntimeEnvironmentRecord {
  id: string;
  taskId: string;
  sessionId: string;
  runtimeId: string;
  workspaceId: string;
  cwd: string;
  workspaceAccess: "sharedReadOnly" | "exclusiveWrite";
  modelProvider?: string;
  modelId?: string;
  environment: unknown;
  revision: number;
  createdAt: string;
}

export interface ActiveToolSetRecord {
  id: string;
  taskId: string;
  sessionId: string;
  revision: number;
  digest: string;
  tools: unknown;
  writable: boolean;
  createdAt: string;
}

export interface PromptReceiptRecord {
  id: string;
  taskId: string;
  sessionId: string;
  sessionRunId: string;
  effectiveInputId: string;
  runtimeEnvironmentId: string;
  activeToolSetId: string;
  systemPromptDigest: string;
  identityRevision: string;
  roleRevision: string;
  sourceReceipts: DCodePromptSourceReceipt[];
  createdAt: string;
}

export interface AgentAssignmentRecord {
  id: string;
  taskId: string;
  teamRunId?: string;
  agentRunId?: string;
  profileId: string;
  assignmentKind: "coordinator" | "member";
  taskPacket: unknown;
  revision: number;
}

export interface AgentReportRecord {
  id: string;
  taskId: string;
  agentRunId: string;
  reportKind: "member" | "coordinator" | "verification";
  body: unknown;
  createdAt: string;
}

export interface AgentRequestRecord {
  id: string;
  taskId: string;
  teamRunId?: string;
  agentRunId: string;
  sessionId: string;
  sessionRunId: string;
  runtimeId: string;
  kind: "choice";
  prompt: string;
  options: AgentRequestOption[];
  status: "open" | "answered" | "cancelled";
  answer?: AgentRequestAnswer;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRequestOption {
  id: string;
  label: string;
  description?: string;
  recommended: boolean;
}

export interface AgentRequestAnswer {
  kind: "choice";
  optionId: string;
}

export interface FindingRecord {
  id: string;
  taskId: string;
  agentRunId: string;
  severity: "info" | "warning" | "blocking";
  body: string;
  evidenceRefs: unknown;
  createdAt: string;
}

export interface ArtifactRecord {
  id: string;
  taskId: string;
  sessionId?: string;
  agentRunId?: string;
  kind: string;
  title: string;
  managedPath?: string;
  externalPath?: string;
  digest?: string;
  metadata: unknown;
  revision: number;
}

export interface EvidenceRecord {
  id: string;
  taskId: string;
  sessionId: string;
  agentRunId?: string;
  evidenceKind: string;
  commandRedacted?: string;
  exitKind?: string;
  exitCode?: number;
  cwd?: string;
  payload: unknown;
  createdAt: string;
}

export interface CreatedTeamRun {
  storeRevision: number;
  teamRun: TeamRunRecord;
  coordinatorAgentRun: AgentRunRecord;
  childSessions: DCodeSessionRecord[];
  childAgentRuns: AgentRunRecord[];
  assignments: AgentAssignmentRecord[];
}

export interface TeamRunStartClaim {
  storeRevision: number;
  teamRun: TeamRunRecord;
  agentRuns: AgentRunRecord[];
}

export interface FoundationSnapshot {
  schemaVersion: number;
  storeRevision: number;
  dataRoot: string;
  currentUser: LocalUserRecord;
  projects: ProjectRecord[];
  agentProfiles: AgentProfileRecord[];
  tasks: TaskRecord[];
  sessions: DCodeSessionRecord[];
  sessionPaths: SessionPathRecord[];
  sessionProvenance: SessionProvenanceRecord[];
  coordinatorAssignments: CoordinatorAssignmentRecord[];
  piImports: PiImportSourceRecord[];
  sessionRuns: SessionRunRecord[];
  operationAttempts: OperationAttemptRecord[];
  runtimeEnvironments: RuntimeEnvironmentRecord[];
  activeToolSets: ActiveToolSetRecord[];
  promptReceipts: PromptReceiptRecord[];
  teamRuns: TeamRunRecord[];
  agentRuns: AgentRunRecord[];
  agentAssignments: AgentAssignmentRecord[];
  agentRequests: AgentRequestRecord[];
  agentReports: AgentReportRecord[];
  findings: FindingRecord[];
  artifacts: ArtifactRecord[];
  evidence: EvidenceRecord[];
  events: StoreEventRecord[];
}

export type ProductStoreFaultPoint =
  | "project.afterProject"
  | "task.afterTask"
  | "task.afterSession"
  | "task.afterAssignment"
  | "piImport.afterTask"
  | "piImport.afterSession"
  | "piImport.afterEntries"
  | "piImport.afterPaths"
  | "piImport.afterProvenance"
  | "profile.afterUpdate";

export interface ProductStoreOptions {
  dataRoot?: string;
  userHome?: string;
  now?: () => string;
  faultInjector?: (point: ProductStoreFaultPoint) => void;
  legacyMigration?: {
    agentDir: string;
    sessionsDirectory: string;
    applicationSupportDirectory?: string;
    userDefaults?: Record<string, unknown>;
    sourcePaths?: Partial<Record<LegacyStoreKind, string>>;
  };
}

export class ProductStoreError extends Error {
  constructor(
    readonly code:
      | "PRODUCT_STORE_CLOSED"
      | "PRODUCT_STORE_CORRUPT"
      | "INVALID_ARGUMENT"
      | "NOT_FOUND"
      | "REVISION_CONFLICT"
      | "CREDENTIAL_MATERIAL_REJECTED"
      | "IDEMPOTENCY_KEY_REUSED"
      | "PI_SESSION_ALREADY_IMPORTED"
      | "SESSION_RUNTIME_ALREADY_BOUND",
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ProductStoreError";
  }
}

type SQLiteRow = Record<string, unknown>;

interface MutationEvent {
  kind: string;
  entityKind: string;
  entityId: string;
  taskId?: string;
  payload: unknown;
}

interface MutationWriteResult<T extends Record<string, unknown>> {
  value: T;
  event: MutationEvent;
}

function rollback(database: DatabaseSync): void {
  if (!database.isTransaction) return;
  try {
    database.exec("ROLLBACK");
  } catch {
    // Preserve the original mutation failure.
  }
}

function stableValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined) continue;
      result[key] = stableValue(child);
    }
    return result;
  }
  throw new ProductStoreError("INVALID_ARGUMENT", "Mutation payload is not canonical JSON", { valueType: typeof value });
}

function canonicalJSON(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function payloadHash(value: unknown): string {
  return createHash("sha256").update(canonicalJSON(value)).digest("hex");
}

function requiredString(value: unknown, field: string, maximum = 4_096): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    throw new ProductStoreError(
      "INVALID_ARGUMENT",
      `${field} must be a non-empty string up to ${maximum} characters`,
    );
  }
  return value;
}

function requiredCredentialFreeString(value: unknown, field: string, maximum = 4_096): string {
  const text = requiredString(value, field, maximum);
  if (redactCredentialText(text).redacted) {
    throw new ProductStoreError("CREDENTIAL_MATERIAL_REJECTED", `${field} contains credential material`);
  }
  return text;
}

function assertCredentialFreeValue(value: unknown, field: string): void {
  if (typeof value === "string") {
    if (redactCredentialText(value).redacted) {
      throw new ProductStoreError("CREDENTIAL_MATERIAL_REJECTED", `${field} contains credential material`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertCredentialFreeValue(item, `${field}[${index}]`));
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      assertCredentialFreeValue(child, `${field}.${key}`);
    }
  }
}

function requiredRevision(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ProductStoreError("INVALID_ARGUMENT", `${field} must be a non-negative safe integer`);
  }
  return value as number;
}

function parseStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length > 2_000)) {
    throw new ProductStoreError("INVALID_ARGUMENT", `${field} must be an array of strings up to 2000 characters`);
  }
  return [...value];
}

function normalizedTaskScope(value: unknown): TaskScope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProductStoreError("INVALID_ARGUMENT", "scope must be an explicit User or Project scope");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (record.kind === "user") {
    if (keys.length !== 2 || keys[0] !== "kind" || keys[1] !== "userId") {
      throw new ProductStoreError("INVALID_ARGUMENT", "User Scope must contain exactly kind and userId");
    }
    return { kind: "user", userId: requiredString(record.userId, "scope.userId", 200) };
  }
  if (record.kind === "project") {
    if (keys.length !== 2 || keys[0] !== "kind" || keys[1] !== "projectId") {
      throw new ProductStoreError("INVALID_ARGUMENT", "Project Scope must contain exactly kind and projectId");
    }
    return { kind: "project", projectId: requiredString(record.projectId, "scope.projectId", 200) };
  }
  throw new ProductStoreError("INVALID_ARGUMENT", "scope must be an explicit User or Project scope");
}

function text(row: SQLiteRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`Invalid Product Store row: ${key}`);
  return value;
}

function integer(row: SQLiteRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`Invalid Product Store row: ${key}`);
  return value;
}

function localUser(row: SQLiteRow): LocalUserRecord {
  return {
    id: text(row, "id"),
    homeDirectory: text(row, "home_directory"),
    revision: integer(row, "revision"),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
  };
}

function project(row: SQLiteRow): ProjectRecord {
  return {
    id: text(row, "id"),
    userId: text(row, "user_id"),
    title: text(row, "title"),
    directory: text(row, "directory"),
    revision: integer(row, "revision"),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
  };
}

function agentProfile(row: SQLiteRow): AgentProfileRecord {
  const role = text(row, "role") as AgentProfileRecord["role"];
  return {
    id: text(row, "id"),
    role,
    name: text(row, "name"),
    roleContract: text(row, "role_contract"),
    enabled: integer(row, "enabled") === 1,
    builtin: integer(row, "builtin") === 1,
    profileVersion: integer(row, "profile_version"),
    revision: integer(row, "revision"),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
  };
}

function task(row: SQLiteRow): TaskRecord {
  const kind = text(row, "scope_kind");
  const scope: TaskScope = kind === "user"
    ? { kind: "user", userId: text(row, "user_id") }
    : { kind: "project", projectId: text(row, "project_id") };
  return {
    id: text(row, "id"),
    scope,
    title: text(row, "title"),
    goal: text(row, "goal"),
    acceptance: parseStringArray(JSON.parse(text(row, "acceptance_json")), "stored acceptance"),
    cwd: text(row, "cwd"),
    state: text(row, "state") as TaskRecord["state"],
    revision: integer(row, "revision"),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
  };
}

function session(row: SQLiteRow): DCodeSessionRecord {
  return {
    id: text(row, "id"),
    taskId: text(row, "task_id"),
    kind: text(row, "kind") as DCodeSessionRecord["kind"],
    title: text(row, "title"),
    runtimeAdapter: text(row, "runtime_adapter") as "pi",
    lineageStatus: text(row, "lineage_status") as DCodeSessionRecord["lineageStatus"],
    state: text(row, "state") as DCodeSessionRecord["state"],
    revision: integer(row, "revision"),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
  };
}

function sessionPath(row: SQLiteRow): SessionPathRecord {
  const optionalText = (key: string): string | undefined => (
    typeof row[key] === "string" ? row[key] as string : undefined
  );
  return {
    id: text(row, "id"),
    sessionId: text(row, "session_id"),
    ...(optionalText("source_path_id") ? { sourcePathId: optionalText("source_path_id") } : {}),
    ...(optionalText("source_leaf_entry_id")
      ? { sourceLeafEntryId: optionalText("source_leaf_entry_id") }
      : {}),
    title: text(row, "title"),
    isCurrent: integer(row, "is_current") === 1,
    revision: integer(row, "revision"),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
  };
}

function sessionProvenance(row: SQLiteRow): SessionProvenanceRecord {
  const optionalText = (key: string): string | undefined => (
    typeof row[key] === "string" ? row[key] as string : undefined
  );
  return {
    id: text(row, "id"),
    taskId: text(row, "task_id"),
    sessionId: text(row, "session_id"),
    sourceKind: text(row, "source_kind") as SessionProvenanceRecord["sourceKind"],
    ...(optionalText("source_session_id") ? { sourceSessionId: optionalText("source_session_id") } : {}),
    ...(optionalText("source_path") ? { sourcePath: optionalText("source_path") } : {}),
    ...(optionalText("source_digest") ? { sourceDigest: optionalText("source_digest") } : {}),
    ...(optionalText("historical_cwd") ? { historicalCwd: optionalText("historical_cwd") } : {}),
    lineageStatus: text(row, "lineage_status") as SessionProvenanceRecord["lineageStatus"],
    details: JSON.parse(text(row, "details_json")),
    createdAt: text(row, "created_at"),
  };
}

function coordinatorAssignment(row: SQLiteRow): CoordinatorAssignmentRecord {
  return {
    id: text(row, "id"),
    taskId: text(row, "task_id"),
    sessionId: text(row, "session_id"),
    profileId: text(row, "profile_id"),
    revision: integer(row, "revision"),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
  };
}

function piImportSource(row: SQLiteRow): PiImportSourceRecord {
  const taskId = text(row, "task_id");
  const sessionId = text(row, "session_id");
  return {
    id: text(row, "id"),
    sourceSessionId: text(row, "source_session_id"),
    sourcePath: text(row, "source_path"),
    sourceDigest: text(row, "source_digest"),
    importerVersion: integer(row, "importer_version"),
    taskId,
    sessionId,
    lineageStatus: "unknown",
    state: "completed",
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
  };
}

function sessionEntry(row: SQLiteRow): SessionEntryRecord {
  const optionalText = (key: string): string | undefined => (
    typeof row[key] === "string" ? row[key] as string : undefined
  );
  const sourceOrdinal = row.source_ordinal;
  return {
    id: text(row, "id"),
    sessionId: text(row, "session_id"),
    sourceKind: text(row, "source_kind") as SessionEntryRecord["sourceKind"],
    lineageStatus: text(row, "lineage_status") as SessionEntryRecord["lineageStatus"],
    ...(optionalText("source_entry_id") ? { sourceEntryId: optionalText("source_entry_id") } : {}),
    ...(optionalText("source_parent_entry_id")
      ? { sourceParentEntryId: optionalText("source_parent_entry_id") }
      : {}),
    ...(typeof sourceOrdinal === "number" ? { sourceOrdinal } : {}),
    ...(optionalText("source_timestamp") ? { sourceTimestamp: optionalText("source_timestamp") } : {}),
    messageRole: text(row, "message_role") as SessionEntryRecord["messageRole"],
    content: JSON.parse(text(row, "content_json")),
    createdAt: text(row, "created_at"),
  };
}

function event(row: SQLiteRow): StoreEventRecord {
  const taskId = row.task_id;
  return {
    sequence: integer(row, "sequence"),
    eventId: text(row, "event_id"),
    storeRevision: integer(row, "store_revision"),
    kind: text(row, "kind") as "choice",
    entityKind: text(row, "entity_kind"),
    entityId: text(row, "entity_id"),
    ...(typeof taskId === "string" ? { taskId } : {}),
    payload: JSON.parse(text(row, "payload_json")),
    createdAt: text(row, "created_at"),
  };
}

function sessionRun(row: SQLiteRow): SessionRunRecord {
  const startedAt = typeof row.started_at === "string" ? row.started_at : undefined;
  const completedAt = typeof row.completed_at === "string" ? row.completed_at : undefined;
  return {
    id: text(row, "id"),
    taskId: text(row, "task_id"),
    sessionId: text(row, "session_id"),
    runtimeId: text(row, "runtime_id"),
    ...(typeof row.agent_run_id === "string" ? { agentRunId: row.agent_run_id } : {}),
    ...(typeof row.effective_input_id === "string" ? { effectiveInputId: row.effective_input_id } : {}),
    ...(typeof row.runtime_environment_id === "string" ? { runtimeEnvironmentId: row.runtime_environment_id } : {}),
    ...(typeof row.active_tool_set_id === "string" ? { activeToolSetId: row.active_tool_set_id } : {}),
    status: text(row, "status"),
    revision: integer(row, "revision"),
    ...(startedAt ? { startedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
  };
}

function operationAttempt(row: SQLiteRow): OperationAttemptRecord {
  const optionalText = (key: string): string | undefined => (
    typeof row[key] === "string" ? row[key] as string : undefined
  );
  return {
    id: text(row, "id"),
    taskId: text(row, "task_id"),
    ...(optionalText("session_id") ? { sessionId: optionalText("session_id") } : {}),
    ...(optionalText("session_run_id") ? { sessionRunId: optionalText("session_run_id") } : {}),
    ...(optionalText("agent_run_id") ? { agentRunId: optionalText("agent_run_id") } : {}),
    operationKind: text(row, "operation_kind"),
    targetIdentity: text(row, "target_identity"),
    parameterDigest: text(row, "parameter_digest"),
    replayPolicy: text(row, "replay_policy"),
    status: text(row, "status") as OperationAttemptRecord["status"],
    ...(optionalText("outcome_json") ? { outcome: JSON.parse(optionalText("outcome_json")!) } : {}),
    preparedAt: text(row, "prepared_at"),
    ...(optionalText("completed_at") ? { completedAt: optionalText("completed_at") } : {}),
  };
}

function teamRun(row: SQLiteRow): TeamRunRecord {
  return {
    id: text(row, "id"),
    taskId: text(row, "task_id"),
    coordinatorAgentRunId: text(row, "coordinator_agent_run_id"),
    status: text(row, "status"),
    revision: integer(row, "revision"),
  };
}

function agentRun(row: SQLiteRow): AgentRunRecord {
  const teamRunId = typeof row.team_run_id === "string" ? row.team_run_id : undefined;
  return {
    id: text(row, "id"),
    taskId: text(row, "task_id"),
    ...(teamRunId ? { teamRunId } : {}),
    sessionId: text(row, "session_id"),
    profileId: text(row, "profile_id"),
    profileSnapshot: JSON.parse(text(row, "profile_snapshot_json")),
    role: text(row, "role"),
    status: text(row, "status"),
    revision: integer(row, "revision"),
  };
}

function runtimeEnvironment(row: SQLiteRow): RuntimeEnvironmentRecord {
  return {
    id: text(row, "id"),
    taskId: text(row, "task_id"),
    sessionId: text(row, "session_id"),
    runtimeId: text(row, "runtime_id"),
    workspaceId: text(row, "workspace_id"),
    cwd: text(row, "cwd"),
    workspaceAccess: text(row, "workspace_access") as RuntimeEnvironmentRecord["workspaceAccess"],
    ...(typeof row.model_provider === "string" ? { modelProvider: row.model_provider } : {}),
    ...(typeof row.model_id === "string" ? { modelId: row.model_id } : {}),
    environment: JSON.parse(text(row, "environment_json")),
    revision: integer(row, "revision"),
    createdAt: text(row, "created_at"),
  };
}

function activeToolSet(row: SQLiteRow): ActiveToolSetRecord {
  return {
    id: text(row, "id"),
    taskId: text(row, "task_id"),
    sessionId: text(row, "session_id"),
    revision: integer(row, "revision"),
    digest: text(row, "digest"),
    tools: JSON.parse(text(row, "tools_json")),
    writable: integer(row, "writable") === 1,
    createdAt: text(row, "created_at"),
  };
}

function promptReceipt(row: SQLiteRow): PromptReceiptRecord {
  let sourceReceipts: DCodePromptSourceReceipt[];
  try {
    sourceReceipts = normalizeDCodePromptSourceReceipts(JSON.parse(text(row, "source_receipts_json")));
  } catch (error) {
    throw new ProductStoreError("PRODUCT_STORE_CORRUPT", "Stored Prompt Receipt metadata is invalid", {
      receiptId: text(row, "id"),
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  return {
    id: text(row, "id"),
    taskId: text(row, "task_id"),
    sessionId: text(row, "session_id"),
    sessionRunId: text(row, "session_run_id"),
    effectiveInputId: text(row, "effective_input_id"),
    runtimeEnvironmentId: text(row, "runtime_environment_id"),
    activeToolSetId: text(row, "active_tool_set_id"),
    systemPromptDigest: text(row, "system_prompt_digest"),
    identityRevision: text(row, "identity_revision"),
    roleRevision: text(row, "role_revision"),
    sourceReceipts,
    createdAt: text(row, "created_at"),
  };
}

function agentAssignment(row: SQLiteRow): AgentAssignmentRecord {
  const teamRunId = typeof row.team_run_id === "string" ? row.team_run_id : undefined;
  const agentRunId = typeof row.agent_run_id === "string" ? row.agent_run_id : undefined;
  return {
    id: text(row, "id"),
    taskId: text(row, "task_id"),
    ...(teamRunId ? { teamRunId } : {}),
    ...(agentRunId ? { agentRunId } : {}),
    profileId: text(row, "profile_id"),
    assignmentKind: text(row, "assignment_kind") as AgentAssignmentRecord["assignmentKind"],
    taskPacket: JSON.parse(text(row, "task_packet_json")),
    revision: integer(row, "revision"),
  };
}

function agentReport(row: SQLiteRow): AgentReportRecord {
  return {
    id: text(row, "id"),
    taskId: text(row, "task_id"),
    agentRunId: text(row, "agent_run_id"),
    reportKind: text(row, "report_kind") as AgentReportRecord["reportKind"],
    body: JSON.parse(text(row, "body_json")),
    createdAt: text(row, "created_at"),
  };
}

function agentRequest(row: SQLiteRow): AgentRequestRecord {
  const answer = typeof row.answer_json === "string"
    ? JSON.parse(row.answer_json) as AgentRequestAnswer
    : undefined;
  const teamRunId = typeof row.team_run_id === "string" ? row.team_run_id : undefined;
  return {
    id: text(row, "id"),
    taskId: text(row, "task_id"),
    ...(teamRunId ? { teamRunId } : {}),
    agentRunId: text(row, "agent_run_id"),
    sessionId: text(row, "session_id"),
    sessionRunId: text(row, "session_run_id"),
    runtimeId: text(row, "runtime_id"),
    kind: text(row, "kind") as "choice",
    prompt: text(row, "prompt"),
    options: JSON.parse(text(row, "options_json")) as AgentRequestOption[],
    status: text(row, "status") as AgentRequestRecord["status"],
    ...(answer === undefined ? {} : { answer }),
    revision: integer(row, "revision"),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
  };
}

function finding(row: SQLiteRow): FindingRecord {
  return {
    id: text(row, "id"),
    taskId: text(row, "task_id"),
    agentRunId: text(row, "agent_run_id"),
    severity: text(row, "severity") as FindingRecord["severity"],
    body: text(row, "body"),
    evidenceRefs: JSON.parse(text(row, "evidence_refs_json")),
    createdAt: text(row, "created_at"),
  };
}

function artifact(row: SQLiteRow): ArtifactRecord {
  const optional = (key: string): string | undefined => typeof row[key] === "string" ? row[key] as string : undefined;
  return {
    id: text(row, "id"),
    taskId: text(row, "task_id"),
    ...(optional("session_id") ? { sessionId: optional("session_id") } : {}),
    ...(optional("agent_run_id") ? { agentRunId: optional("agent_run_id") } : {}),
    kind: text(row, "kind"),
    title: text(row, "title"),
    ...(optional("managed_path") ? { managedPath: optional("managed_path") } : {}),
    ...(optional("external_path") ? { externalPath: optional("external_path") } : {}),
    ...(optional("digest") ? { digest: optional("digest") } : {}),
    metadata: JSON.parse(text(row, "metadata_json")),
    revision: integer(row, "revision"),
  };
}

function evidenceRecord(row: SQLiteRow): EvidenceRecord {
  const optional = (key: string): string | undefined => typeof row[key] === "string" ? row[key] as string : undefined;
  return {
    id: text(row, "id"),
    taskId: text(row, "task_id"),
    sessionId: text(row, "session_id"),
    ...(optional("agent_run_id") ? { agentRunId: optional("agent_run_id") } : {}),
    evidenceKind: text(row, "evidence_kind"),
    ...(optional("command_redacted") ? { commandRedacted: optional("command_redacted") } : {}),
    ...(optional("exit_kind") ? { exitKind: optional("exit_kind") } : {}),
    ...(typeof row.exit_code === "number" ? { exitCode: row.exit_code } : {}),
    ...(optional("cwd") ? { cwd: optional("cwd") } : {}),
    payload: JSON.parse(text(row, "payload_json")),
    createdAt: text(row, "created_at"),
  };
}

export class ProductStore {
  readonly layout: DCodeDataRootLayout;
  private closed = false;
  private mutationQueue: Promise<void> = Promise.resolve();

  private constructor(
    layout: DCodeDataRootLayout,
    private readonly database: DatabaseSync,
    private readonly lease: ProductStoreLease,
    private readonly now: () => string,
    private readonly faultInjector?: (point: ProductStoreFaultPoint) => void,
  ) {
    this.layout = layout;
  }

  static async open(options: ProductStoreOptions = {}): Promise<ProductStore> {
    const layout = resolveDCodeDataRoot(options.dataRoot, options.userHome);
    await prepareManagedDCodeDirectory(layout.root);
    const managedDirectories = [
      layout.runtimeDirectory,
      layout.migrationsDirectory,
      layout.artifactsDirectory,
      layout.indexesDirectory,
      layout.logsDirectory,
      layout.recoveryDirectory,
    ];
    for (const directory of managedDirectories) {
      await prepareManagedDCodeDirectory(directory);
    }
    await assertSafeProductStoreTarget(layout.productStorePath);

    const lease = await ProductStoreLease.acquire(layout.productStoreLeasePath);
    let database: DatabaseSync | undefined;
    try {
      const userHome = resolve(options.userHome ?? homedir());
      let storeExists = true;
      try {
        await stat(layout.productStorePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") storeExists = false;
        else throw error;
      }
      const migrationPlan = !storeExists && options.legacyMigration
        ? await buildLegacyMigrationPlan({
          userHome,
          agentDir: options.legacyMigration.agentDir,
          sessionsDirectory: options.legacyMigration.sessionsDirectory,
          ...(options.legacyMigration.applicationSupportDirectory
            ? { applicationSupportDirectory: options.legacyMigration.applicationSupportDirectory }
            : {}),
          ...(options.legacyMigration.userDefaults
            ? { userDefaults: options.legacyMigration.userDefaults }
            : {}),
          ...(options.legacyMigration.sourcePaths
            ? { sourcePaths: options.legacyMigration.sourcePaths }
            : {}),
        })
        : undefined;
      await initializeProductStoreAtomically(layout, {
        userId: `user-${randomUUID()}`,
        userHome,
      }, (options.now ?? (() => new Date().toISOString()))(), migrationPlan);
      await assertSafeProductStoreTarget(layout.productStorePath);
      database = new DatabaseSync(layout.productStorePath);
      validateProductStoreSchema(database);
      configureWritableProductStore(database);
      await chmod(layout.productStorePath, 0o600);
      const store = new ProductStore(
        layout,
        database,
        lease,
        options.now ?? (() => new Date().toISOString()),
        options.faultInjector,
      );
      await store.recoverInterruptedRuns();
      return store;
    } catch (error) {
      try {
        database?.close();
      } finally {
        await lease.release().catch(() => undefined);
      }
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new ProductStoreError("PRODUCT_STORE_CLOSED", "D Code Product Store is closed");
  }

  private async recoverInterruptedRuns(): Promise<void> {
    const pending = this.database.prepare(`
      SELECT COUNT(*) AS count FROM operation_attempts WHERE status = 'prepared'
    `).get() as { count?: unknown } | undefined;
    const running = this.database.prepare(`
      SELECT COUNT(*) AS count FROM session_runs
      WHERE status IN ('prepared', 'running', 'waiting')
    `).get() as { count?: unknown } | undefined;
    const agentRunning = this.database.prepare(`
      SELECT COUNT(*) AS count FROM agent_runs
      WHERE status IN ('prepared', 'running', 'waiting')
    `).get() as { count?: unknown } | undefined;
    const teamRunning = this.database.prepare(`
      SELECT COUNT(*) AS count FROM team_runs
      WHERE status IN ('prepared', 'active', 'waiting')
    `).get() as { count?: unknown } | undefined;
    const openRequests = this.database.prepare(`
      SELECT COUNT(*) AS count FROM agent_requests WHERE status = 'open'
    `).get() as { count?: unknown } | undefined;
    if (
      (pending?.count ?? 0) === 0
      && (running?.count ?? 0) === 0
      && (agentRunning?.count ?? 0) === 0
      && (teamRunning?.count ?? 0) === 0
      && (openRequests?.count ?? 0) === 0
    ) return;
    await this.lease.assertOwned();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const now = this.now();
      this.database.prepare(`
        UPDATE operation_attempts
        SET status = 'unknown', updated_at = ?
        WHERE status = 'prepared'
      `).run(now);
      this.database.prepare(`
        UPDATE session_runs
        SET status = 'interrupted', revision = revision + 1, updated_at = ?
        WHERE status IN ('prepared', 'running', 'waiting')
      `).run(now);
      this.database.prepare(`
        UPDATE agent_runs
        SET status = 'interrupted', revision = revision + 1, updated_at = ?
        WHERE status IN ('prepared', 'running', 'waiting')
      `).run(now);
      this.database.prepare(`
        UPDATE team_runs
        SET status = 'interrupted', revision = revision + 1, updated_at = ?
        WHERE status IN ('prepared', 'active', 'waiting')
      `).run(now);
      this.database.prepare(`
        UPDATE agent_requests
        SET status = 'cancelled', answer_json = ?, revision = revision + 1, updated_at = ?
        WHERE status = 'open'
      `).run(canonicalJSON({ reason: "runtime_interrupted" }), now);
      const storeRevision = this.metaInteger("store_revision") + 1;
      this.database.prepare("UPDATE dcode_meta SET value = ? WHERE key = 'store_revision'")
        .run(String(storeRevision));
      this.database.prepare(`
        INSERT INTO store_events(
          event_id, store_revision, kind, entity_kind, entity_id,
          task_id, payload_json, created_at
        ) VALUES (?, ?, 'runtime.recoveredInterrupted', 'productStore', 'product-store',
          NULL, ?, ?)
      `).run(
        randomUUID(),
        storeRevision,
        canonicalJSON({
          unknownAttempts: typeof pending?.count === "number" ? pending.count : 0,
          interruptedRuns: typeof running?.count === "number" ? running.count : 0,
          interruptedAgentRuns: typeof agentRunning?.count === "number" ? agentRunning.count : 0,
          interruptedTeamRuns: typeof teamRunning?.count === "number" ? teamRunning.count : 0,
          cancelledAgentRequests: typeof openRequests?.count === "number" ? openRequests.count : 0,
        }),
        now,
      );
      await this.lease.assertOwned();
      this.database.exec("COMMIT");
    } catch (error) {
      rollback(this.database);
      throw error;
    }
  }

  private metaInteger(key: string): number {
    const row = this.database.prepare("SELECT value FROM dcode_meta WHERE key = ?").get(key) as SQLiteRow | undefined;
    const value = row?.value;
    if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error(`Invalid Product Store metadata: ${key}`);
    return Number(value);
  }

  private currentUser(): LocalUserRecord {
    const row = this.database.prepare(`
      SELECT u.* FROM local_users u
      JOIN dcode_meta m ON m.key = 'current_user_id' AND m.value = u.id
    `).get() as SQLiteRow | undefined;
    if (!row) throw new Error("D Code Product Store has no current user");
    return localUser(row);
  }

  async snapshot(afterEventSequence = 0): Promise<FoundationSnapshot> {
    this.assertOpen();
    requiredRevision(afterEventSequence, "afterEventSequence");
    return {
      schemaVersion: PRODUCT_STORE_SCHEMA_VERSION,
      storeRevision: this.metaInteger("store_revision"),
      dataRoot: this.layout.root,
      currentUser: this.currentUser(),
      projects: (this.database.prepare("SELECT * FROM projects ORDER BY created_at, id").all() as SQLiteRow[]).map(project),
      agentProfiles: (this.database.prepare("SELECT * FROM agent_profiles ORDER BY builtin DESC, role, id").all() as SQLiteRow[]).map(agentProfile),
      tasks: (this.database.prepare("SELECT * FROM tasks ORDER BY created_at, id").all() as SQLiteRow[]).map(task),
      sessions: (this.database.prepare("SELECT * FROM sessions ORDER BY created_at, id").all() as SQLiteRow[]).map(session),
      sessionPaths: (
        this.database.prepare("SELECT * FROM session_paths ORDER BY session_id, is_current DESC, id").all() as SQLiteRow[]
      ).map(sessionPath),
      sessionProvenance: (
        this.database.prepare("SELECT * FROM session_provenance ORDER BY session_id, id").all() as SQLiteRow[]
      ).map(sessionProvenance),
      coordinatorAssignments: (
        this.database.prepare("SELECT * FROM coordinator_assignments ORDER BY created_at, id").all() as SQLiteRow[]
      ).map(coordinatorAssignment),
      piImports: (
        this.database.prepare("SELECT * FROM pi_import_sources WHERE state = 'completed' ORDER BY created_at, id").all() as SQLiteRow[]
      ).map(piImportSource),
      sessionRuns: (
        this.database.prepare("SELECT * FROM session_runs ORDER BY created_at, id").all() as SQLiteRow[]
      ).map(sessionRun),
      operationAttempts: (
        this.database.prepare("SELECT * FROM operation_attempts ORDER BY prepared_at, id").all() as SQLiteRow[]
      ).map(operationAttempt),
      runtimeEnvironments: (
        this.database.prepare("SELECT * FROM runtime_environments ORDER BY created_at, id").all() as SQLiteRow[]
      ).map(runtimeEnvironment),
      activeToolSets: (
        this.database.prepare("SELECT * FROM active_tool_sets ORDER BY created_at, id").all() as SQLiteRow[]
      ).map(activeToolSet),
      promptReceipts: (
        this.database.prepare("SELECT * FROM prompt_receipts ORDER BY created_at, id").all() as SQLiteRow[]
      ).map(promptReceipt),
      teamRuns: (
        this.database.prepare("SELECT * FROM team_runs ORDER BY created_at, id").all() as SQLiteRow[]
      ).map(teamRun),
      agentRuns: (
        this.database.prepare("SELECT * FROM agent_runs ORDER BY created_at, id").all() as SQLiteRow[]
      ).map(agentRun),
      agentAssignments: (
        this.database.prepare("SELECT * FROM agent_assignments ORDER BY created_at, id").all() as SQLiteRow[]
      ).map(agentAssignment),
      agentRequests: (
        this.database.prepare("SELECT * FROM agent_requests ORDER BY created_at, id").all() as SQLiteRow[]
      ).map(agentRequest),
      agentReports: (
        this.database.prepare("SELECT * FROM agent_reports ORDER BY created_at, id").all() as SQLiteRow[]
      ).map(agentReport),
      findings: (
        this.database.prepare("SELECT * FROM findings ORDER BY created_at, id").all() as SQLiteRow[]
      ).map(finding),
      artifacts: (
        this.database.prepare("SELECT * FROM artifacts ORDER BY created_at, id").all() as SQLiteRow[]
      ).map(artifact),
      evidence: (
        this.database.prepare("SELECT * FROM evidence_records ORDER BY created_at, id").all() as SQLiteRow[]
      ).map(evidenceRecord),
      events: (
        this.database.prepare("SELECT * FROM store_events WHERE sequence > ? ORDER BY sequence").all(afterEventSequence) as SQLiteRow[]
      ).map(event),
    };
  }

  async importedSessionEntries(sessionIdValue: string): Promise<SessionEntryRecord[]> {
    this.assertOpen();
    const sessionId = requiredString(sessionIdValue, "sessionId", 200);
    return (
      this.database.prepare(`
        SELECT * FROM session_entries WHERE session_id = ? ORDER BY source_ordinal, id
      `).all(sessionId) as SQLiteRow[]
    ).map(sessionEntry);
  }

  private receipt<T>(requestId: string, method: string, hash: string): T | undefined {
    const row = this.database.prepare(`
      SELECT method, params_hash, result_json FROM mutation_receipts WHERE request_id = ?
    `).get(requestId) as SQLiteRow | undefined;
    if (!row) return undefined;
    if (text(row, "method") !== method || text(row, "params_hash") !== hash) {
      throw new ProductStoreError(
        "IDEMPOTENCY_KEY_REUSED",
        "The mutation requestId was already used for a different operation",
        { requestId, originalMethod: text(row, "method"), method },
      );
    }
    return JSON.parse(text(row, "result_json")) as T;
  }

  private async replayReceipt<T>(
    method: string,
    requestIdValue: string,
    params: unknown,
  ): Promise<T | undefined> {
    this.assertOpen();
    const requestId = requiredString(requestIdValue, "requestId", 128);
    await this.lease.assertOwned();
    return this.receipt<T>(requestId, method, payloadHash(params));
  }

  private async serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(operation, operation);
    this.mutationQueue = next.then(() => undefined, () => undefined);
    return await next;
  }

  private async mutate<T extends Record<string, unknown>>(
    method: string,
    requestIdValue: string,
    expectedStoreRevisionValue: number | undefined,
    params: unknown,
    write: (storeRevision: number, now: string) => MutationWriteResult<T>,
  ): Promise<T & { storeRevision: number }> {
    return await this.serializeMutation(async () => await this.mutateNow(
      method,
      requestIdValue,
      expectedStoreRevisionValue,
      params,
      write,
    ));
  }

  private async mutateNow<T extends Record<string, unknown>>(
    method: string,
    requestIdValue: string,
    expectedStoreRevisionValue: number | undefined,
    params: unknown,
    write: (storeRevision: number, now: string) => MutationWriteResult<T>,
  ): Promise<T & { storeRevision: number }> {
    this.assertOpen();
    const requestId = requiredString(requestIdValue, "requestId", 128);
    const expectedStoreRevision = expectedStoreRevisionValue === undefined
      ? undefined
      : requiredRevision(expectedStoreRevisionValue, "expectedStoreRevision");
    const hash = payloadHash(params);
    await this.lease.assertOwned();
    const prior = this.receipt<T & { storeRevision: number }>(requestId, method, hash);
    if (prior) return prior;

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const repeated = this.receipt<T & { storeRevision: number }>(requestId, method, hash);
      if (repeated) {
        this.database.exec("COMMIT");
        return repeated;
      }
      const currentRevision = this.metaInteger("store_revision");
      if (expectedStoreRevision !== undefined && currentRevision !== expectedStoreRevision) {
        throw new ProductStoreError(
          "REVISION_CONFLICT",
          "The Product Store changed before this mutation could be applied",
          { expectedStoreRevision, currentStoreRevision: currentRevision },
        );
      }
      const storeRevision = currentRevision + 1;
      const now = this.now();
      const written = write(storeRevision, now);
      this.database.prepare("UPDATE dcode_meta SET value = ? WHERE key = 'store_revision'")
        .run(String(storeRevision));
      this.database.prepare(`
        INSERT INTO store_events(
          event_id, store_revision, kind, entity_kind, entity_id, task_id, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        storeRevision,
        written.event.kind,
        written.event.entityKind,
        written.event.entityId,
        written.event.taskId ?? null,
        canonicalJSON(written.event.payload),
        now,
      );
      const result = { ...written.value, storeRevision };
      this.database.prepare(`
        INSERT INTO mutation_receipts(
          request_id, method, params_hash, result_json, store_revision, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(requestId, method, hash, canonicalJSON(result), storeRevision, now);
      await this.lease.assertOwned();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      rollback(this.database);
      throw error;
    }
  }

  async createProject(input: {
    requestId: string;
    expectedStoreRevision: number;
    title: string;
    directory: string;
  }): Promise<{ storeRevision: number; project: ProjectRecord }> {
    const title = requiredCredentialFreeString(input.title, "title", 200).trim();
    if (!isAbsolute(input.directory)) {
      throw new ProductStoreError("INVALID_ARGUMENT", "Project directory must be an absolute path");
    }
    const requestedDirectory = resolve(input.directory);
    const params = { title, directory: requestedDirectory };
    const replayed = await this.replayReceipt<{ storeRevision: number; project: ProjectRecord }>(
      "project.create",
      input.requestId,
      params,
    );
    if (replayed) return replayed;

    let directory: string;
    try {
      directory = await realpath(requestedDirectory);
      if (!(await stat(directory)).isDirectory()) throw new Error("not a directory");
    } catch (error) {
      throw new ProductStoreError(
        "INVALID_ARGUMENT",
        "Project directory must be an existing accessible directory",
        { directory: requestedDirectory, cause: error instanceof Error ? error.message : String(error) },
      );
    }
    if (directory === parse(directory).root) {
      throw new ProductStoreError("INVALID_ARGUMENT", "Project directory cannot be a filesystem root");
    }
    return await this.mutate(
      "project.create",
      input.requestId,
      input.expectedStoreRevision,
      params,
      (_storeRevision, now) => {
        const currentUser = this.currentUser();
        const record: ProjectRecord = {
          id: `project-${randomUUID()}`,
          userId: currentUser.id,
          title,
          directory,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        this.database.prepare(`
          INSERT INTO projects(id, user_id, title, directory, revision, created_at, updated_at)
          VALUES (?, ?, ?, ?, 1, ?, ?)
        `).run(record.id, record.userId, record.title, record.directory, now, now);
        this.faultInjector?.("project.afterProject");
        return {
          value: { project: record },
          event: {
            kind: "project.created",
            entityKind: "project",
            entityId: record.id,
            payload: record,
          },
        };
      },
    );
  }

  async createTask(input: {
    requestId: string;
    expectedStoreRevision: number;
    scope: TaskScope;
    title: string;
    goal: string;
    acceptance?: string[];
  }): Promise<TaskBundle> {
    const title = requiredCredentialFreeString(input.title, "title", 200).trim();
    const goal = requiredCredentialFreeString(input.goal, "goal", 4_000);
    const acceptance = parseStringArray(input.acceptance ?? [], "acceptance");
    assertCredentialFreeValue(acceptance, "acceptance");
    const scope = normalizedTaskScope(input.scope);
    const params = { scope, title, goal, acceptance };
    return await this.mutate(
      "task.create",
      input.requestId,
      input.expectedStoreRevision,
      params,
      (_storeRevision, now) => {
        const currentUser = this.currentUser();
        let cwd: string;
        if (scope.kind === "user") {
          if (scope.userId !== currentUser.id) {
            throw new ProductStoreError("NOT_FOUND", "User Scope does not belong to the current D Code user", {
              userId: scope.userId,
            });
          }
          cwd = currentUser.homeDirectory;
        } else {
          const row = this.database.prepare("SELECT * FROM projects WHERE id = ?").get(scope.projectId) as SQLiteRow | undefined;
          if (!row) throw new ProductStoreError("NOT_FOUND", "Project Scope does not exist", { projectId: scope.projectId });
          const owner = project(row);
          if (owner.userId !== currentUser.id) {
            throw new ProductStoreError("NOT_FOUND", "Project Scope does not belong to the current D Code user", {
              projectId: scope.projectId,
            });
          }
          cwd = owner.directory;
        }

        const taskRecord: TaskRecord = {
          id: `task-${randomUUID()}`,
          scope,
          title,
          goal,
          acceptance,
          cwd,
          state: "draft",
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        this.database.prepare(`
          INSERT INTO tasks(
            id, scope_kind, user_id, project_id, title, goal, acceptance_json,
            cwd, state, revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', 1, ?, ?)
        `).run(
          taskRecord.id,
          scope.kind,
          scope.kind === "user" ? scope.userId : null,
          scope.kind === "project" ? scope.projectId : null,
          title,
          goal,
          canonicalJSON(acceptance),
          cwd,
          now,
          now,
        );
        this.faultInjector?.("task.afterTask");

        const coordinationSession: DCodeSessionRecord = {
          id: `session-${randomUUID()}`,
          taskId: taskRecord.id,
          kind: "coordination",
          title,
          runtimeAdapter: "pi",
          lineageStatus: "native",
          state: "idle",
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        this.database.prepare(`
          INSERT INTO sessions(
            id, task_id, kind, title, runtime_adapter, lineage_status,
            state, revision, created_at, updated_at
          ) VALUES (?, ?, 'coordination', ?, 'pi', 'native', 'idle', 1, ?, ?)
        `).run(coordinationSession.id, taskRecord.id, title, now, now);
        this.database.prepare(`
          INSERT INTO session_paths(
            id, session_id, parent_path_id, source_path_id, source_leaf_entry_id,
            title, is_current, revision, created_at, updated_at
          ) VALUES (?, ?, NULL, NULL, NULL, '主路径', 1, 1, ?, ?)
        `).run(`path-${randomUUID()}`, coordinationSession.id, now, now);
        this.database.prepare(`
          INSERT INTO session_provenance(
            id, task_id, session_id, source_kind, source_session_id,
            source_path, source_digest, historical_cwd, lineage_status,
            details_json, created_at
          ) VALUES (?, ?, ?, 'native', NULL, NULL, NULL, ?, 'native', '{}', ?)
        `).run(`provenance-${randomUUID()}`, taskRecord.id, coordinationSession.id, cwd, now);
        this.faultInjector?.("task.afterSession");

        const assignment: CoordinatorAssignmentRecord = {
          id: `assignment-${randomUUID()}`,
          taskId: taskRecord.id,
          sessionId: coordinationSession.id,
          profileId: "builtin-coordinator",
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        this.database.prepare(`
          INSERT INTO coordinator_assignments(
            id, task_id, session_id, profile_id, revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 1, ?, ?)
        `).run(assignment.id, taskRecord.id, coordinationSession.id, assignment.profileId, now, now);
        this.faultInjector?.("task.afterAssignment");

        return {
          value: {
            task: taskRecord,
            coordinationSession,
            coordinatorAssignment: assignment,
          },
          event: {
            kind: "task.created",
            entityKind: "task",
            entityId: taskRecord.id,
            taskId: taskRecord.id,
            payload: {
              task: taskRecord,
              coordinationSession,
              coordinatorAssignment: assignment,
            },
          },
        };
      },
    );
  }

  async replayPiImportRequest(input: {
    requestId: string;
    scope: TaskScope;
    sourceSessionId: string;
  }): Promise<PiImportTaskResult | undefined> {
    const scope = normalizedTaskScope(input.scope);
    const sourceSessionId = requiredString(input.sourceSessionId, "sourceSessionId", 200);
    return await this.replayReceipt<PiImportTaskResult>(
      "piImport.importAsTask",
      input.requestId,
      { scope, sourceSessionId, importerVersion: 1 },
    );
  }

  async importPiSessionAsTask(input: {
    requestId: string;
    expectedStoreRevision: number;
    scope: TaskScope;
    sourceSessionId: string;
    sourcePath: string;
    sourceDigest: string;
    historicalCwd: string;
    title: string;
    entries: ImportedPiSessionEntryInput[];
    paths: ImportedPiSessionPathInput[];
    conversionEvidence: Record<string, unknown>;
  }): Promise<PiImportTaskResult> {
    const sourceSessionId = requiredString(input.sourceSessionId, "sourceSessionId", 200);
    if (!isAbsolute(input.sourcePath)) {
      throw new ProductStoreError("INVALID_ARGUMENT", "Pi import sourcePath must be absolute");
    }
    const sourcePath = resolve(input.sourcePath);
    if (!/^sha256:[a-f0-9]{64}$/.test(input.sourceDigest)) {
      throw new ProductStoreError("INVALID_ARGUMENT", "Pi import sourceDigest must be a SHA-256 digest");
    }
    const title = requiredCredentialFreeString(input.title, "title", 200).trim();
    if (!isAbsolute(input.historicalCwd)) {
      throw new ProductStoreError("INVALID_ARGUMENT", "Pi import historicalCwd must be absolute");
    }
    const historicalCwd = resolve(input.historicalCwd);
    const scope = normalizedTaskScope(input.scope);
    if (!Array.isArray(input.entries)) {
      throw new ProductStoreError("INVALID_ARGUMENT", "Pi import entries must be an array");
    }
    const entryIds = new Set<string>();
    const entries = input.entries.map((entry, index): ImportedPiSessionEntryInput => {
      const sourceEntryId = requiredString(entry.sourceEntryId, `entries[${index}].sourceEntryId`, 200);
      if (entryIds.has(sourceEntryId)) {
        throw new ProductStoreError("INVALID_ARGUMENT", "Pi import entries contain a duplicate sourceEntryId", {
          sourceEntryId,
        });
      }
      entryIds.add(sourceEntryId);
      const sourceOrdinal = requiredRevision(entry.sourceOrdinal, `entries[${index}].sourceOrdinal`);
      if (!["user", "assistant", "toolResult", "other"].includes(entry.messageRole)) {
        throw new ProductStoreError("INVALID_ARGUMENT", "Pi import entry has an unsupported messageRole", {
          sourceEntryId,
          messageRole: entry.messageRole,
        });
      }
      const sourceParentEntryId = entry.sourceParentEntryId === undefined
        ? undefined
        : requiredString(entry.sourceParentEntryId, `entries[${index}].sourceParentEntryId`, 200);
      const sourceTimestamp = entry.sourceTimestamp === undefined
        ? undefined
        : requiredString(entry.sourceTimestamp, `entries[${index}].sourceTimestamp`, 200);
      stableValue(entry.content);
      assertCredentialFreeValue(entry.content, `entries[${index}].content`);
      return {
        sourceEntryId,
        ...(sourceParentEntryId ? { sourceParentEntryId } : {}),
        sourceOrdinal,
        ...(sourceTimestamp ? { sourceTimestamp } : {}),
        messageRole: entry.messageRole,
        content: entry.content,
      };
    });

    if (!Array.isArray(input.paths) || input.paths.length === 0) {
      throw new ProductStoreError("INVALID_ARGUMENT", "Pi import paths must contain at least one Session Path");
    }
    const pathIds = new Set<string>();
    const paths = input.paths.map((path, index): ImportedPiSessionPathInput => {
      const sourcePathId = requiredString(path.sourcePathId, `paths[${index}].sourcePathId`, 200);
      if (pathIds.has(sourcePathId)) {
        throw new ProductStoreError("INVALID_ARGUMENT", "Pi import paths contain a duplicate sourcePathId", {
          sourcePathId,
        });
      }
      pathIds.add(sourcePathId);
      const pathTitle = requiredCredentialFreeString(path.title, `paths[${index}].title`, 200);
      if (typeof path.isCurrent !== "boolean" || !Array.isArray(path.sourceEntryIds)) {
        throw new ProductStoreError("INVALID_ARGUMENT", "Pi import Session Path shape is invalid", { sourcePathId });
      }
      const sourceEntryIds = path.sourceEntryIds.map((entryId) => requiredString(entryId, "path.sourceEntryId", 200));
      for (const entryId of sourceEntryIds) {
        if (!entryIds.has(entryId)) {
          throw new ProductStoreError("INVALID_ARGUMENT", "Pi import Session Path references an omitted entry", {
            sourcePathId,
            sourceEntryId: entryId,
          });
        }
      }
      return {
        sourcePathId,
        ...(path.sourceLeafEntryId
          ? { sourceLeafEntryId: requiredString(path.sourceLeafEntryId, "path.sourceLeafEntryId", 200) }
          : {}),
        title: pathTitle,
        isCurrent: path.isCurrent,
        sourceEntryIds,
      };
    });
    if (paths.filter((path) => path.isCurrent).length !== 1) {
      throw new ProductStoreError("INVALID_ARGUMENT", "Pi import paths must identify exactly one current path");
    }
    stableValue(input.conversionEvidence);
    assertCredentialFreeValue(input.conversionEvidence, "conversionEvidence");

    const params = {
      scope,
      sourceSessionId,
      importerVersion: 1,
    };
    return await this.mutate(
      "piImport.importAsTask",
      input.requestId,
      input.expectedStoreRevision,
      params,
      (_storeRevision, now) => {
        const existing = this.database.prepare(`
          SELECT task_id, session_id FROM pi_import_sources
          WHERE source_session_id = ? AND source_digest = ? AND importer_version = 1
        `).get(sourceSessionId, input.sourceDigest) as SQLiteRow | undefined;
        if (existing) {
          throw new ProductStoreError(
            "PI_SESSION_ALREADY_IMPORTED",
            "This Pi Session snapshot has already been imported as a D Code Task",
            {
              sourceSessionId,
              taskId: existing.task_id,
              sessionId: existing.session_id,
            },
          );
        }

        const currentUser = this.currentUser();
        let cwd: string;
        if (scope.kind === "user") {
          if (scope.userId !== currentUser.id) {
            throw new ProductStoreError("NOT_FOUND", "User Scope does not belong to the current D Code user", {
              userId: scope.userId,
            });
          }
          cwd = currentUser.homeDirectory;
        } else {
          const row = this.database.prepare("SELECT * FROM projects WHERE id = ?").get(scope.projectId) as SQLiteRow | undefined;
          if (!row) throw new ProductStoreError("NOT_FOUND", "Project Scope does not exist", { projectId: scope.projectId });
          const owner = project(row);
          if (owner.userId !== currentUser.id) {
            throw new ProductStoreError("NOT_FOUND", "Project Scope does not belong to the current D Code user", {
              projectId: scope.projectId,
            });
          }
          cwd = owner.directory;
        }

        const taskRecord: TaskRecord = {
          id: `task-${randomUUID()}`,
          scope,
          title,
          goal: `继续导入的 Pi 会话：${title}`,
          acceptance: [],
          cwd,
          state: "draft",
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        this.database.prepare(`
          INSERT INTO tasks(
            id, scope_kind, user_id, project_id, title, goal, acceptance_json,
            cwd, state, revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, '[]', ?, 'draft', 1, ?, ?)
        `).run(
          taskRecord.id,
          scope.kind,
          scope.kind === "user" ? scope.userId : null,
          scope.kind === "project" ? scope.projectId : null,
          title,
          taskRecord.goal,
          cwd,
          now,
          now,
        );
        this.faultInjector?.("piImport.afterTask");

        const coordinationSession: DCodeSessionRecord = {
          id: `session-${randomUUID()}`,
          taskId: taskRecord.id,
          kind: "coordination",
          title,
          runtimeAdapter: "pi",
          lineageStatus: "unknown",
          state: "idle",
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        this.database.prepare(`
          INSERT INTO sessions(
            id, task_id, kind, title, runtime_adapter, lineage_status,
            state, revision, created_at, updated_at
          ) VALUES (?, ?, 'coordination', ?, 'pi', 'unknown', 'idle', 1, ?, ?)
        `).run(coordinationSession.id, taskRecord.id, title, now, now);
        this.faultInjector?.("piImport.afterSession");

        const insertEntry = this.database.prepare(`
          INSERT INTO session_entries(
            id, session_id, source_kind, lineage_status, source_entry_id,
            source_parent_entry_id, source_ordinal, source_timestamp,
            message_role, content_json, created_at
          ) VALUES (?, ?, 'pi_import', 'unknown', ?, ?, ?, ?, ?, ?, ?)
        `);
        const importedEntryIds = new Map<string, string>();
        for (const entry of entries) {
          const entryId = `entry-${randomUUID()}`;
          importedEntryIds.set(entry.sourceEntryId, entryId);
          insertEntry.run(
            entryId,
            coordinationSession.id,
            entry.sourceEntryId,
            entry.sourceParentEntryId ?? null,
            entry.sourceOrdinal,
            entry.sourceTimestamp ?? null,
            entry.messageRole,
            canonicalJSON(entry.content),
            now,
          );
        }
        this.faultInjector?.("piImport.afterEntries");

        const insertPath = this.database.prepare(`
          INSERT INTO session_paths(
            id, session_id, parent_path_id, source_path_id, source_leaf_entry_id,
            title, is_current, revision, created_at, updated_at
          ) VALUES (?, ?, NULL, ?, ?, ?, ?, 1, ?, ?)
        `);
        const insertPathEntry = this.database.prepare(`
          INSERT INTO session_path_entries(path_id, entry_id, ordinal)
          VALUES (?, ?, ?)
        `);
        for (const path of paths) {
          const pathId = `path-${randomUUID()}`;
          insertPath.run(
            pathId,
            coordinationSession.id,
            path.sourcePathId,
            path.sourceLeafEntryId ?? null,
            path.title,
            path.isCurrent ? 1 : 0,
            now,
            now,
          );
          for (const [ordinal, sourceEntryId] of path.sourceEntryIds.entries()) {
            const entryId = importedEntryIds.get(sourceEntryId);
            if (!entryId) throw new Error(`Missing imported entry mapping: ${sourceEntryId}`);
            insertPathEntry.run(pathId, entryId, ordinal);
          }
        }
        this.faultInjector?.("piImport.afterPaths");

        const assignment: CoordinatorAssignmentRecord = {
          id: `assignment-${randomUUID()}`,
          taskId: taskRecord.id,
          sessionId: coordinationSession.id,
          profileId: "builtin-coordinator",
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        this.database.prepare(`
          INSERT INTO coordinator_assignments(
            id, task_id, session_id, profile_id, revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 1, ?, ?)
        `).run(assignment.id, taskRecord.id, coordinationSession.id, assignment.profileId, now, now);

        const piImport: PiImportSourceRecord = {
          id: `pi-import-${randomUUID()}`,
          sourceSessionId,
          sourcePath,
          sourceDigest: input.sourceDigest,
          importerVersion: 1,
          taskId: taskRecord.id,
          sessionId: coordinationSession.id,
          lineageStatus: "unknown",
          state: "completed",
          createdAt: now,
          updatedAt: now,
        };
        this.database.prepare(`
          INSERT INTO pi_import_sources(
            id, source_session_id, source_path, source_digest, importer_version,
            task_id, session_id, lineage_status, state, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 1, ?, ?, 'unknown', 'completed', ?, ?)
        `).run(
          piImport.id,
          sourceSessionId,
          sourcePath,
          input.sourceDigest,
          taskRecord.id,
          coordinationSession.id,
          now,
          now,
        );
        this.database.prepare(`
          INSERT INTO session_provenance(
            id, task_id, session_id, source_kind, source_session_id,
            source_path, source_digest, historical_cwd, lineage_status,
            details_json, created_at
          ) VALUES (?, ?, ?, 'pi_import', ?, ?, ?, ?, 'unknown', ?, ?)
        `).run(
          `provenance-${randomUUID()}`,
          taskRecord.id,
          coordinationSession.id,
          sourceSessionId,
          sourcePath,
          input.sourceDigest,
          historicalCwd,
          canonicalJSON({
            importerVersion: 1,
            conversionEvidence: input.conversionEvidence,
            importedPathCount: paths.length,
            importedEntryCount: entries.length,
          }),
          now,
        );
        this.faultInjector?.("piImport.afterProvenance");

        return {
          value: {
            task: taskRecord,
            coordinationSession,
            coordinatorAssignment: assignment,
            piImport,
            importedEntryCount: entries.length,
          },
          event: {
            kind: "piImport.completed",
            entityKind: "task",
            entityId: taskRecord.id,
            taskId: taskRecord.id,
            payload: {
              task: taskRecord,
              coordinationSession,
              coordinatorAssignment: assignment,
              piImport,
              importedEntryCount: entries.length,
            },
          },
        };
      },
    );
  }

  async prepareSessionRun(input: {
    requestId: string;
    taskId: string;
    scope: TaskScope;
    sessionId: string;
    runtimeId: string;
    agentRunId?: string;
    workspaceId: string;
    cwd: string;
    workspaceAccess: "sharedReadOnly" | "exclusiveWrite";
    message: string;
    attachmentRefs: unknown[];
    modelProvider?: string;
    modelId?: string;
    roleRevision: string;
    profileSnapshot: Record<string, unknown>;
    tools: Array<{ name: string; description: string; parameters: unknown }>;
    toolsWritable: boolean;
    systemPromptDigest: string;
    promptSources: DCodePromptSourceReceipt[];
  }): Promise<PreparedSessionRun> {
    const taskId = requiredString(input.taskId, "taskId", 200);
    const scope = normalizedTaskScope(input.scope);
    const sessionId = requiredString(input.sessionId, "sessionId", 200);
    const runtimeId = requiredString(input.runtimeId, "runtimeId", 200);
    const agentRunId = input.agentRunId === undefined
      ? undefined
      : requiredString(input.agentRunId, "agentRunId", 200);
    const workspaceId = requiredString(input.workspaceId, "workspaceId", 200);
    const message = requiredCredentialFreeString(input.message, "message", 200_000);
    if (!isAbsolute(input.cwd)) throw new ProductStoreError("INVALID_ARGUMENT", "Runtime cwd must be absolute");
    if (input.workspaceAccess !== "sharedReadOnly" && input.workspaceAccess !== "exclusiveWrite") {
      throw new ProductStoreError("INVALID_ARGUMENT", "Runtime workspaceAccess is invalid");
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(input.systemPromptDigest)) {
      throw new ProductStoreError("INVALID_ARGUMENT", "systemPromptDigest must be SHA-256");
    }
    stableValue(input.attachmentRefs);
    stableValue(input.profileSnapshot);
    stableValue(input.tools);
    let promptSources: DCodePromptSourceReceipt[];
    try {
      promptSources = normalizeDCodePromptSourceReceipts(input.promptSources);
    } catch (error) {
      if (error instanceof DCodePromptSourceReceiptError) {
        throw new ProductStoreError("INVALID_ARGUMENT", error.message);
      }
      throw error;
    }
    assertCredentialFreeValue(input.profileSnapshot, "profileSnapshot");
    assertCredentialFreeValue(input.tools, "tools");
    const resolvedCwd = resolve(input.cwd);
    for (const [index, source] of promptSources.entries()) {
      const sourceRelativePath = relative(resolvedCwd, resolve(source.path));
      if (
        sourceRelativePath === ""
        || sourceRelativePath === ".."
        || sourceRelativePath.startsWith("../")
        || isAbsolute(sourceRelativePath)
      ) {
        throw new ProductStoreError("INVALID_ARGUMENT", `promptSources[${index}] is outside Runtime cwd`);
      }
    }
    const params = {
      taskId,
      scope,
      sessionId,
      runtimeId,
      ...(agentRunId ? { agentRunId } : {}),
      message,
      attachmentRefs: input.attachmentRefs,
      systemPromptDigest: input.systemPromptDigest,
      toolNames: input.tools.map((tool) => tool.name),
    };
    return await this.mutate(
      "sessionRun.prepare",
      input.requestId,
      undefined,
      params,
      (_storeRevision, now) => {
        const taskRow = this.database.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as SQLiteRow | undefined;
        const sessionRow = this.database.prepare(`
          SELECT id FROM sessions WHERE id = ? AND task_id = ?
        `).get(sessionId, taskId);
        if (!taskRow || !sessionRow) {
          throw new ProductStoreError("NOT_FOUND", "Session Run target does not exist", { taskId, sessionId });
        }
        if (JSON.stringify(task(taskRow).scope) !== JSON.stringify(scope)) {
          throw new ProductStoreError("REVISION_CONFLICT", "Session Run Task Scope changed before preparation");
        }
        if (agentRunId) {
          const agentRun = this.database.prepare(`
            SELECT g.id, g.role, g.status, g.team_run_id, t.status AS team_status
            FROM agent_runs g
            LEFT JOIN team_runs t ON t.id = g.team_run_id
            WHERE g.id = ? AND g.task_id = ? AND g.session_id = ?
          `).get(agentRunId, taskId, sessionId) as SQLiteRow | undefined;
          if (!agentRun) throw new ProductStoreError("NOT_FOUND", "Agent Run does not match the Session Run target");
          const agentStatus = text(agentRun, "status");
          const coordinatorSynthesis = text(agentRun, "role") === "coordinator"
            && agentStatus === "completed"
            && agentRun.team_status === "active";
          if (agentStatus !== "prepared" && !coordinatorSynthesis) {
            throw new ProductStoreError("REVISION_CONFLICT", "Agent Run cannot start another Session Run", {
              agentStatus,
            });
          }
        }
        const ordinalRow = this.database.prepare(`
          SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal FROM raw_inputs WHERE session_id = ?
        `).get(sessionId) as { ordinal?: unknown } | undefined;
        const ordinal = typeof ordinalRow?.ordinal === "number" ? ordinalRow.ordinal : 0;
        const environmentRevisionRow = this.database.prepare(`
          SELECT COALESCE(MAX(revision), 0) + 1 AS revision
          FROM runtime_environments WHERE runtime_id = ?
        `).get(runtimeId) as { revision?: unknown } | undefined;
        const environmentRevision = typeof environmentRevisionRow?.revision === "number"
          ? environmentRevisionRow.revision
          : 1;
        const toolRevisionRow = this.database.prepare(`
          SELECT COALESCE(MAX(revision), 0) + 1 AS revision
          FROM active_tool_sets WHERE session_id = ?
        `).get(sessionId) as { revision?: unknown } | undefined;
        const toolRevision = typeof toolRevisionRow?.revision === "number" ? toolRevisionRow.revision : 1;
        const rawInputId = `raw-${randomUUID()}`;
        const userEntryId = `entry-${randomUUID()}`;
        const effectiveInputId = `effective-${randomUUID()}`;
        const runtimeEnvironmentId = `environment-${randomUUID()}`;
        const activeToolSetId = `tools-${randomUUID()}`;
        const sessionRunId = `session-run-${randomUUID()}`;
        const promptReceiptId = `prompt-receipt-${randomUUID()}`;
        const providerAttemptId = `attempt-${randomUUID()}`;

        this.database.prepare(`
          INSERT INTO raw_inputs(
            id, task_id, session_id, ordinal, submitted_text,
            attachment_refs_json, source_kind, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'user_submit', ?)
        `).run(rawInputId, taskId, sessionId, ordinal, message, canonicalJSON(input.attachmentRefs), now);
        const currentPath = this.database.prepare(`
          SELECT id FROM session_paths WHERE session_id = ? AND is_current = 1
        `).get(sessionId) as { id?: unknown } | undefined;
        if (typeof currentPath?.id !== "string") {
          throw new ProductStoreError("NOT_FOUND", "D Code Session has no current Session Path");
        }
        const previousEntry = this.database.prepare(`
          SELECT e.id
          FROM session_path_entries p
          JOIN session_entries e ON e.id = p.entry_id
          WHERE p.path_id = ?
          ORDER BY p.ordinal DESC
          LIMIT 1
        `).get(currentPath.id) as { id?: unknown } | undefined;
        this.database.prepare(`
          INSERT INTO session_entries(
            id, session_id, parent_entry_id, source_kind, lineage_status,
            source_entry_id, source_parent_entry_id, source_ordinal,
            source_timestamp, message_role, content_json, created_at
          ) VALUES (?, ?, ?, 'native', 'native', NULL, NULL, ?, ?, 'user', ?, ?)
        `).run(
          userEntryId,
          sessionId,
          typeof previousEntry?.id === "string" ? previousEntry.id : null,
          ordinal,
          now,
          canonicalJSON({ type: "text", text: message, attachmentRefs: input.attachmentRefs }),
          now,
        );
        const pathOrdinalRow = this.database.prepare(`
          SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal
          FROM session_path_entries WHERE path_id = ?
        `).get(currentPath.id) as { ordinal?: unknown } | undefined;
        this.database.prepare(`
          INSERT INTO session_path_entries(path_id, entry_id, ordinal) VALUES (?, ?, ?)
        `).run(
          currentPath.id,
          userEntryId,
          typeof pathOrdinalRow?.ordinal === "number" ? pathOrdinalRow.ordinal : 0,
        );
        this.database.prepare(`
          INSERT INTO effective_inputs(
            id, task_id, session_id, raw_input_id, conversion_revision,
            effective_content_json, context_projection_json, created_at
          ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
        `).run(
          effectiveInputId,
          taskId,
          sessionId,
          rawInputId,
          canonicalJSON({ message, attachmentRefs: input.attachmentRefs }),
          canonicalJSON({ version: 1, promptSources }),
          now,
        );
        this.database.prepare(`
          INSERT INTO runtime_environments(
            id, task_id, session_id, runtime_id, workspace_id, cwd,
            workspace_access, model_provider, model_id, environment_json,
            revision, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          runtimeEnvironmentId,
          taskId,
          sessionId,
          runtimeId,
          workspaceId,
          resolvedCwd,
          input.workspaceAccess,
          input.modelProvider ?? null,
          input.modelId ?? null,
          canonicalJSON({ profileSnapshot: input.profileSnapshot }),
          environmentRevision,
          now,
        );
        const toolDigest = payloadHash(input.tools);
        this.database.prepare(`
          INSERT INTO active_tool_sets(
            id, task_id, session_id, revision, digest, tools_json,
            writable, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          activeToolSetId,
          taskId,
          sessionId,
          toolRevision,
          `sha256:${toolDigest}`,
          canonicalJSON(input.tools),
          input.toolsWritable ? 1 : 0,
          now,
        );
        this.database.prepare(`
          INSERT INTO session_runs(
            id, task_id, session_id, runtime_id, agent_run_id,
            user_entry_id, assistant_entry_id,
            effective_input_id, runtime_environment_id, active_tool_set_id,
            status, revision, started_at, completed_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'prepared', 1, ?, NULL, ?, ?)
        `).run(
          sessionRunId,
          taskId,
          sessionId,
          runtimeId,
          agentRunId ?? null,
          userEntryId,
          effectiveInputId,
          runtimeEnvironmentId,
          activeToolSetId,
          now,
          now,
          now,
        );
        if (agentRunId) {
          this.database.prepare(`
            UPDATE agent_runs
            SET status = 'running', revision = revision + 1,
              completed_at = NULL, updated_at = ?
            WHERE id = ? AND status IN ('prepared', 'completed')
          `).run(now, agentRunId);
        }
        this.database.prepare(`
          INSERT INTO prompt_receipts(
            id, task_id, session_id, session_run_id, effective_input_id,
            runtime_environment_id, active_tool_set_id, system_prompt_digest,
            identity_revision, role_revision, source_receipts_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'dcode-identity-v1', ?, ?, ?)
        `).run(
          promptReceiptId,
          taskId,
          sessionId,
          sessionRunId,
          effectiveInputId,
          runtimeEnvironmentId,
          activeToolSetId,
          input.systemPromptDigest,
          input.roleRevision,
          canonicalJSON(promptSources),
          now,
        );
        this.database.prepare(`
          INSERT INTO operation_attempts(
            id, task_id, session_id, session_run_id, agent_run_id,
            operation_kind, target_identity, parameter_digest, replay_policy,
            status, outcome_json, prepared_at, completed_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'provider_request', ?, ?, 'never',
            'prepared', NULL, ?, NULL, ?)
        `).run(
          providerAttemptId,
          taskId,
          sessionId,
          sessionRunId,
          agentRunId ?? null,
          `${input.modelProvider ?? "unknown"}/${input.modelId ?? "unknown"}`,
          `sha256:${payloadHash({ effectiveInputId, systemPromptDigest: input.systemPromptDigest })}`,
          now,
          now,
        );
        const value = {
          rawInputId,
          userEntryId,
          effectiveInputId,
          runtimeEnvironmentId,
          activeToolSetId,
          sessionRunId,
          promptReceiptId,
          providerAttemptId,
        };
        return {
          value,
          event: {
            kind: "sessionRun.prepared",
            entityKind: "sessionRun",
            entityId: sessionRunId,
            taskId,
            payload: value,
          },
        };
      },
    );
  }

  async createTeamRun(input: {
    requestId: string;
    expectedStoreRevision: number;
    taskId: string;
    scope: TaskScope;
    members: Array<{
      profileId: string;
      title: string;
      taskPacket: Record<string, unknown>;
    }>;
  }): Promise<CreatedTeamRun> {
    const taskId = requiredString(input.taskId, "taskId", 200);
    const scope = normalizedTaskScope(input.scope);
    if (!Array.isArray(input.members) || input.members.length < 1 || input.members.length > 8) {
      throw new ProductStoreError("INVALID_ARGUMENT", "Team Run requires between 1 and 8 members");
    }
    const members = input.members.map((member, index) => {
      const profileId = requiredString(member.profileId, `members[${index}].profileId`, 200);
      const title = requiredCredentialFreeString(member.title, `members[${index}].title`, 200).trim();
      stableValue(member.taskPacket);
      assertCredentialFreeValue(member.taskPacket, `members[${index}].taskPacket`);
      return { profileId, title, taskPacket: member.taskPacket };
    });
    return await this.mutate(
      "teamRun.create",
      input.requestId,
      input.expectedStoreRevision,
      { taskId, scope, members },
      (_storeRevision, now) => {
        const taskRow = this.database.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as SQLiteRow | undefined;
        if (!taskRow) throw new ProductStoreError("NOT_FOUND", "Team Run Task does not exist", { taskId });
        const taskRecord = task(taskRow);
        if (JSON.stringify(taskRecord.scope) !== JSON.stringify(scope)) {
          throw new ProductStoreError("REVISION_CONFLICT", "Team Run Task Scope changed before creation");
        }
        const coordination = this.database.prepare(`
          SELECT * FROM sessions WHERE task_id = ? AND kind = 'coordination'
        `).get(taskId) as SQLiteRow | undefined;
        const coordinatorAssignment = this.database.prepare(`
          SELECT * FROM coordinator_assignments WHERE task_id = ?
        `).get(taskId) as SQLiteRow | undefined;
        if (!coordination || !coordinatorAssignment) {
          throw new ProductStoreError("NOT_FOUND", "Task has no Coordination Session or Coordinator assignment");
        }
        const coordinatorProfileRow = this.database.prepare(`
          SELECT * FROM agent_profiles WHERE id = ? AND enabled = 1
        `).get(text(coordinatorAssignment, "profile_id")) as SQLiteRow | undefined;
        if (!coordinatorProfileRow) {
          throw new ProductStoreError("NOT_FOUND", "Coordinator Agent Profile is disabled or missing");
        }
        const coordinatorProfile = agentProfile(coordinatorProfileRow);
        const memberProfiles = members.map((member) => {
          const row = this.database.prepare(`
            SELECT * FROM agent_profiles WHERE id = ? AND enabled = 1
          `).get(member.profileId) as SQLiteRow | undefined;
          if (!row) throw new ProductStoreError("NOT_FOUND", "Member Agent Profile is disabled or missing", {
            profileId: member.profileId,
          });
          return agentProfile(row);
        });
        const activeTeam = this.database.prepare(`
          SELECT id FROM team_runs WHERE task_id = ? AND status IN ('prepared', 'active', 'waiting')
        `).get(taskId);
        if (activeTeam) {
          throw new ProductStoreError("REVISION_CONFLICT", "Task already has an active Team Run", { taskId });
        }

        const teamRunId = `team-run-${randomUUID()}`;
        const coordinatorAgentRunId = `agent-run-${randomUUID()}`;
        const teamRun: TeamRunRecord = {
          id: teamRunId,
          taskId,
          coordinatorAgentRunId,
          status: "active",
          revision: 1,
        };
        this.database.prepare(`
          INSERT INTO team_runs(
            id, task_id, coordinator_agent_run_id, status, revision,
            created_at, updated_at, completed_at
          ) VALUES (?, ?, ?, 'active', 1, ?, ?, NULL)
        `).run(teamRunId, taskId, coordinatorAgentRunId, now, now);
        const coordinatorAgentRun: AgentRunRecord = {
          id: coordinatorAgentRunId,
          taskId,
          teamRunId,
          sessionId: text(coordination, "id"),
          profileId: coordinatorProfile.id,
          profileSnapshot: coordinatorProfile,
          role: coordinatorProfile.role,
          status: "prepared",
          revision: 1,
        };
        const insertAgentRun = this.database.prepare(`
          INSERT INTO agent_runs(
            id, task_id, team_run_id, session_id, profile_id,
            profile_snapshot_json, role, model_provider, model_id,
            status, revision, created_at, updated_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'prepared', 1, ?, ?, NULL)
        `);
        insertAgentRun.run(
          coordinatorAgentRun.id,
          taskId,
          teamRunId,
          coordinatorAgentRun.sessionId,
          coordinatorProfile.id,
          canonicalJSON(coordinatorProfile),
          coordinatorProfile.role,
          now,
          now,
        );
        const assignments: AgentAssignmentRecord[] = [];
        const insertAssignment = this.database.prepare(`
          INSERT INTO agent_assignments(
            id, task_id, team_run_id, agent_run_id, profile_id,
            assignment_kind, task_packet_json, revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        `);
        const coordinatorAgentAssignment: AgentAssignmentRecord = {
          id: `agent-assignment-${randomUUID()}`,
          taskId,
          teamRunId,
          agentRunId: coordinatorAgentRun.id,
          profileId: coordinatorProfile.id,
          assignmentKind: "coordinator",
          taskPacket: { title: taskRecord.title, goal: taskRecord.goal },
          revision: 1,
        };
        insertAssignment.run(
          coordinatorAgentAssignment.id,
          taskId,
          teamRunId,
          coordinatorAgentRun.id,
          coordinatorProfile.id,
          "coordinator",
          canonicalJSON(coordinatorAgentAssignment.taskPacket),
          now,
          now,
        );
        assignments.push(coordinatorAgentAssignment);

        const childSessions: DCodeSessionRecord[] = [];
        const childAgentRuns: AgentRunRecord[] = [];
        const insertChildSession = this.database.prepare(`
          INSERT INTO sessions(
            id, task_id, kind, title, runtime_adapter, lineage_status,
            state, revision, created_at, updated_at
          ) VALUES (?, ?, 'child', ?, 'pi', 'native', 'idle', 1, ?, ?)
        `);
        for (const [index, member] of members.entries()) {
          const profile = memberProfiles[index]!;
          const childSession: DCodeSessionRecord = {
            id: `session-${randomUUID()}`,
            taskId,
            kind: "child",
            title: member.title,
            runtimeAdapter: "pi",
            lineageStatus: "native",
            state: "idle",
            revision: 1,
            createdAt: now,
            updatedAt: now,
          };
          insertChildSession.run(childSession.id, taskId, childSession.title, now, now);
          this.database.prepare(`
            INSERT INTO session_paths(
              id, session_id, parent_path_id, source_path_id, source_leaf_entry_id,
              title, is_current, revision, created_at, updated_at
            ) VALUES (?, ?, NULL, NULL, NULL, '主路径', 1, 1, ?, ?)
          `).run(`path-${randomUUID()}`, childSession.id, now, now);
          this.database.prepare(`
            INSERT INTO session_provenance(
              id, task_id, session_id, source_kind, source_session_id,
              source_path, source_digest, historical_cwd, lineage_status,
              details_json, created_at
            ) VALUES (?, ?, ?, 'native', NULL, NULL, NULL, ?, 'native', ?, ?)
          `).run(
            `provenance-${randomUUID()}`,
            taskId,
            childSession.id,
            taskRecord.cwd,
            canonicalJSON({ teamRunId, memberIndex: index }),
            now,
          );
          const childAgentRun: AgentRunRecord = {
            id: `agent-run-${randomUUID()}`,
            taskId,
            teamRunId,
            sessionId: childSession.id,
            profileId: profile.id,
            profileSnapshot: profile,
            role: profile.role,
            status: "prepared",
            revision: 1,
          };
          insertAgentRun.run(
            childAgentRun.id,
            taskId,
            teamRunId,
            childSession.id,
            profile.id,
            canonicalJSON(profile),
            profile.role,
            now,
            now,
          );
          const assignment: AgentAssignmentRecord = {
            id: `agent-assignment-${randomUUID()}`,
            taskId,
            teamRunId,
            agentRunId: childAgentRun.id,
            profileId: profile.id,
            assignmentKind: "member",
            taskPacket: member.taskPacket,
            revision: 1,
          };
          insertAssignment.run(
            assignment.id,
            taskId,
            teamRunId,
            childAgentRun.id,
            profile.id,
            "member",
            canonicalJSON(member.taskPacket),
            now,
            now,
          );
          childSessions.push(childSession);
          childAgentRuns.push(childAgentRun);
          assignments.push(assignment);
        }
        this.database.prepare(`
          UPDATE tasks SET state = 'active', revision = revision + 1, updated_at = ? WHERE id = ?
        `).run(now, taskId);
        return {
          value: { teamRun, coordinatorAgentRun, childSessions, childAgentRuns, assignments },
          event: {
            kind: "teamRun.created",
            entityKind: "teamRun",
            entityId: teamRunId,
            taskId,
            payload: { teamRun, coordinatorAgentRun, childSessions, childAgentRuns, assignments },
          },
        };
      },
    );
  }

  async claimTeamRunStart(input: {
    requestId: string;
    expectedStoreRevision: number;
    expectedTeamRunRevision: number;
    scope: TaskScope;
    taskId: string;
    teamRunId: string;
  }): Promise<TeamRunStartClaim> {
    const scope = normalizedTaskScope(input.scope);
    const taskId = requiredString(input.taskId, "taskId", 200);
    const teamRunId = requiredString(input.teamRunId, "teamRunId", 200);
    const expectedTeamRunRevision = requiredRevision(input.expectedTeamRunRevision, "expectedTeamRunRevision");
    return await this.mutate(
      "teamRun.start",
      input.requestId,
      input.expectedStoreRevision,
      { scope, taskId, teamRunId, expectedTeamRunRevision },
      (_storeRevision, now) => {
        const taskRow = this.database.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as SQLiteRow | undefined;
        const teamRow = this.database.prepare("SELECT * FROM team_runs WHERE id = ? AND task_id = ?")
          .get(teamRunId, taskId) as SQLiteRow | undefined;
        if (!taskRow || !teamRow) throw new ProductStoreError("NOT_FOUND", "Team Run start target does not exist");
        if (JSON.stringify(task(taskRow).scope) !== JSON.stringify(scope)) {
          throw new ProductStoreError("REVISION_CONFLICT", "Team Run Task Scope changed before start");
        }
        const previous = teamRun(teamRow);
        if (previous.revision !== expectedTeamRunRevision || !["prepared", "active", "waiting"].includes(previous.status)) {
          throw new ProductStoreError("REVISION_CONFLICT", "Team Run changed before start", {
            expectedTeamRunRevision,
            currentTeamRunRevision: previous.revision,
            currentStatus: previous.status,
          });
        }
        const updated: TeamRunRecord = { ...previous, status: "active", revision: previous.revision + 1 };
        this.database.prepare(`
          UPDATE team_runs SET status = 'active', revision = ?, updated_at = ?
          WHERE id = ? AND revision = ?
        `).run(updated.revision, now, teamRunId, previous.revision);
        const agentRuns = (this.database.prepare(`
          SELECT * FROM agent_runs WHERE team_run_id = ? ORDER BY created_at, id
        `).all(teamRunId) as SQLiteRow[]).map(agentRun);
        return {
          value: { teamRun: updated, agentRuns },
          event: {
            kind: "teamRun.startClaimed",
            entityKind: "teamRun",
            entityId: teamRunId,
            taskId,
            payload: { teamRun: updated, agentRuns },
          },
        };
      },
    );
  }

  async finishTeamRun(input: {
    requestId: string;
    taskId: string;
    teamRunId: string;
    status: "failed" | "aborted";
    reason: string;
  }): Promise<{ storeRevision: number; teamRun: TeamRunRecord }> {
    const taskId = requiredString(input.taskId, "taskId", 200);
    const teamRunId = requiredString(input.teamRunId, "teamRunId", 200);
    const reason = requiredCredentialFreeString(input.reason, "reason", 2_000);
    return await this.mutate(
      "teamRun.finish",
      input.requestId,
      undefined,
      { taskId, teamRunId, status: input.status, reason },
      (_storeRevision, now) => {
        const row = this.database.prepare("SELECT * FROM team_runs WHERE id = ? AND task_id = ?")
          .get(teamRunId, taskId) as SQLiteRow | undefined;
        if (!row) throw new ProductStoreError("NOT_FOUND", "Team Run does not exist");
        const previous = teamRun(row);
        if (["completed", "failed", "aborted", "interrupted", "unknown"].includes(previous.status)) {
          return {
            value: { teamRun: previous },
            event: {
              kind: "teamRun.terminalReused",
              entityKind: "teamRun",
              entityId: teamRunId,
              taskId,
              payload: { teamRun: previous, reason },
            },
          };
        }
        const updated: TeamRunRecord = {
          ...previous,
          status: input.status,
          revision: previous.revision + 1,
        };
        this.database.prepare(`
          UPDATE team_runs
          SET status = ?, revision = ?, completed_at = ?, updated_at = ?
          WHERE id = ?
        `).run(updated.status, updated.revision, now, now, teamRunId);
        this.database.prepare(`
          UPDATE agent_runs
          SET status = ?, revision = revision + 1, completed_at = ?, updated_at = ?
          WHERE team_run_id = ? AND status IN ('prepared', 'running', 'waiting')
        `).run(input.status, now, now, teamRunId);
        this.database.prepare(`
          UPDATE session_runs
          SET status = ?, revision = revision + 1, completed_at = ?, updated_at = ?
          WHERE agent_run_id IN (SELECT id FROM agent_runs WHERE team_run_id = ?)
            AND status IN ('prepared', 'running', 'waiting')
        `).run(input.status, now, now, teamRunId);
        this.database.prepare(`
          UPDATE sessions SET state = 'failed', revision = revision + 1, updated_at = ?
          WHERE id IN (SELECT session_id FROM agent_runs WHERE team_run_id = ?)
            AND state != 'archived'
        `).run(now, teamRunId);
        this.database.prepare(`
          UPDATE operation_attempts SET status = 'unknown', updated_at = ?
          WHERE agent_run_id IN (SELECT id FROM agent_runs WHERE team_run_id = ?)
            AND status = 'prepared'
        `).run(now, teamRunId);
        this.database.prepare(`
          UPDATE agent_requests
          SET status = 'cancelled', answer_json = ?, revision = revision + 1, updated_at = ?
          WHERE agent_run_id IN (SELECT id FROM agent_runs WHERE team_run_id = ?)
            AND status = 'open'
        `).run(canonicalJSON({ reason }), now, teamRunId);
        return {
          value: { teamRun: updated },
          event: {
            kind: `teamRun.${input.status}`,
            entityKind: "teamRun",
            entityId: teamRunId,
            taskId,
            payload: { teamRun: updated, reason },
          },
        };
      },
    );
  }

  async createAgentRequest(input: {
    requestId: string;
    taskId: string;
    agentRunId: string;
    sessionId: string;
    sessionRunId: string;
    runtimeId: string;
    kind: "choice";
    prompt: string;
    options: AgentRequestOption[];
  }): Promise<{ storeRevision: number; agentRequest: AgentRequestRecord }> {
    const taskId = requiredString(input.taskId, "taskId", 200);
    const agentRunId = requiredString(input.agentRunId, "agentRunId", 200);
    const sessionId = requiredString(input.sessionId, "sessionId", 200);
    const sessionRunId = requiredString(input.sessionRunId, "sessionRunId", 200);
    const runtimeId = requiredString(input.runtimeId, "runtimeId", 200);
    if (input.kind !== "choice") {
      throw new ProductStoreError("INVALID_ARGUMENT", "Agent Request kind must be choice");
    }
    const kind = input.kind;
    const prompt = requiredCredentialFreeString(input.prompt, "prompt", 20_000).trim();
    if (!Array.isArray(input.options) || input.options.length < 2 || input.options.length > 5) {
      throw new ProductStoreError("INVALID_ARGUMENT", "Agent Request requires 2 to 5 choices");
    }
    const optionIds = new Set<string>();
    let recommendedCount = 0;
    const options = input.options.map((option, index): AgentRequestOption => {
      if (typeof option !== "object" || option === null || Array.isArray(option)) {
        throw new ProductStoreError("INVALID_ARGUMENT", `Agent Request option ${index} is invalid`);
      }
      const id = requiredString(option.id, `options[${index}].id`, 100).trim();
      const label = requiredCredentialFreeString(option.label, `options[${index}].label`, 500).trim();
      const description = option.description === undefined
        ? undefined
        : requiredCredentialFreeString(option.description, `options[${index}].description`, 2_000).trim();
      if (typeof option.recommended !== "boolean") {
        throw new ProductStoreError("INVALID_ARGUMENT", `options[${index}].recommended must be boolean`);
      }
      if (optionIds.has(id)) throw new ProductStoreError("INVALID_ARGUMENT", "Agent Request option IDs must be unique");
      optionIds.add(id);
      if (option.recommended) recommendedCount += 1;
      return { id, label, ...(description ? { description } : {}), recommended: option.recommended };
    });
    if (recommendedCount > 1) {
      throw new ProductStoreError("INVALID_ARGUMENT", "Agent Request has more than one recommended option");
    }
    return await this.mutate(
      "agentRequest.create",
      input.requestId,
      undefined,
      { taskId, agentRunId, sessionId, sessionRunId, runtimeId, kind, prompt, options },
      (_storeRevision, now) => {
        const run = this.database.prepare(`
          SELECT g.id, g.team_run_id, g.status AS agent_status, r.status AS session_status
          FROM agent_runs g
          JOIN session_runs r ON r.agent_run_id = g.id
          WHERE g.id = ? AND g.task_id = ? AND g.session_id = ?
            AND r.id = ? AND r.runtime_id = ?
        `).get(agentRunId, taskId, sessionId, sessionRunId, runtimeId) as SQLiteRow | undefined;
        if (!run) throw new ProductStoreError("NOT_FOUND", "Agent Request source Agent Run does not exist");
        const agentStatus = text(run, "agent_status");
        const sessionStatus = text(run, "session_status");
        if (agentStatus !== "running" || sessionStatus !== "running") {
          throw new ProductStoreError("REVISION_CONFLICT", "Agent Run is not able to request input", {
            agentStatus,
            sessionStatus,
          });
        }
        const existingOpen = this.database.prepare(`
          SELECT id FROM agent_requests WHERE agent_run_id = ? AND status = 'open'
        `).get(agentRunId);
        if (existingOpen) {
          throw new ProductStoreError("REVISION_CONFLICT", "Agent Run already has an open Agent Request");
        }
        const record: AgentRequestRecord = {
          id: `agent-request-${randomUUID()}`,
          taskId,
          ...(typeof run.team_run_id === "string" ? { teamRunId: run.team_run_id } : {}),
          agentRunId,
          sessionId,
          sessionRunId,
          runtimeId,
          kind,
          prompt,
          options,
          status: "open",
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        this.database.prepare(`
          INSERT INTO agent_requests(
            id, task_id, team_run_id, agent_run_id, session_id, session_run_id,
            runtime_id, kind, prompt, options_json,
            status, answer_json, revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, 1, ?, ?)
        `).run(
          record.id,
          taskId,
          record.teamRunId ?? null,
          agentRunId,
          sessionId,
          sessionRunId,
          runtimeId,
          kind,
          prompt,
          canonicalJSON(options),
          now,
          now,
        );
        this.database.prepare(`
          UPDATE agent_runs SET status = 'waiting', revision = revision + 1, updated_at = ?
          WHERE id = ? AND status = 'running'
        `).run(now, agentRunId);
        this.database.prepare(`
          UPDATE session_runs SET status = 'waiting', revision = revision + 1, updated_at = ?
          WHERE id = ? AND status IN ('prepared', 'running')
        `).run(now, sessionRunId);
        this.database.prepare(`
          UPDATE sessions SET state = 'waiting', revision = revision + 1, updated_at = ?
          WHERE id = ? AND state IN ('idle', 'active')
        `).run(now, sessionId);
        if (typeof run.team_run_id === "string") {
          const stillRunning = this.database.prepare(`
            SELECT COUNT(*) AS count FROM agent_runs
            WHERE team_run_id = ? AND status IN ('prepared', 'running')
          `).get(run.team_run_id) as { count?: unknown } | undefined;
          if (stillRunning?.count === 0) {
            this.database.prepare(`
              UPDATE team_runs SET status = 'waiting', revision = revision + 1, updated_at = ?
              WHERE id = ? AND status = 'active'
            `).run(now, run.team_run_id);
          }
        }
        return {
          value: { agentRequest: record },
          event: {
            kind: "agentRequest.created",
            entityKind: "agentRequest",
            entityId: record.id,
            taskId,
            payload: record,
          },
        };
      },
    );
  }

  async answerAgentRequest(input: {
    requestId: string;
    expectedStoreRevision: number;
    agentRequestId: string;
    expectedRequestRevision: number;
    taskId: string;
    scope: TaskScope;
    teamRunId: string;
    agentRunId: string;
    sessionRunId: string;
    runtimeId: string;
    answer: AgentRequestAnswer;
  }): Promise<{ storeRevision: number; agentRequest: AgentRequestRecord }> {
    const agentRequestId = requiredString(input.agentRequestId, "agentRequestId", 200);
    const expectedRequestRevision = requiredRevision(input.expectedRequestRevision, "expectedRequestRevision");
    const taskId = requiredString(input.taskId, "taskId", 200);
    const scope = normalizedTaskScope(input.scope);
    const teamRunId = requiredString(input.teamRunId, "teamRunId", 200);
    const agentRunId = requiredString(input.agentRunId, "agentRunId", 200);
    const sessionRunId = requiredString(input.sessionRunId, "sessionRunId", 200);
    const runtimeId = requiredString(input.runtimeId, "runtimeId", 200);
    if (
      typeof input.answer !== "object"
      || input.answer === null
      || Array.isArray(input.answer)
      || input.answer.kind !== "choice"
    ) {
      throw new ProductStoreError("INVALID_ARGUMENT", "Agent Request answer must be a choice");
    }
    const optionId = requiredString(input.answer.optionId, "answer.optionId", 100).trim();
    const answer: AgentRequestAnswer = { kind: "choice", optionId };
    return await this.mutate(
      "agentRequest.answer",
      input.requestId,
      input.expectedStoreRevision,
      {
        agentRequestId,
        expectedRequestRevision,
        taskId,
        scope,
        teamRunId,
        agentRunId,
        sessionRunId,
        runtimeId,
        answer,
      },
      (_storeRevision, now) => {
        const row = this.database.prepare("SELECT * FROM agent_requests WHERE id = ?")
          .get(agentRequestId) as SQLiteRow | undefined;
        if (!row) throw new ProductStoreError("NOT_FOUND", "Agent Request does not exist", { agentRequestId });
        const previous = agentRequest(row);
        const taskRow = this.database.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as SQLiteRow | undefined;
        if (!taskRow || JSON.stringify(task(taskRow).scope) !== JSON.stringify(scope)) {
          throw new ProductStoreError("REVISION_CONFLICT", "Agent Request Task Scope changed before answer");
        }
        if (
          previous.taskId !== taskId
          || previous.teamRunId !== teamRunId
          || previous.agentRunId !== agentRunId
          || previous.sessionRunId !== sessionRunId
          || previous.runtimeId !== runtimeId
        ) {
          throw new ProductStoreError("REVISION_CONFLICT", "Agent Request identity changed before answer");
        }
        if (previous.revision !== expectedRequestRevision || previous.status !== "open") {
          throw new ProductStoreError("REVISION_CONFLICT", "Agent Request changed before the answer was applied", {
            expectedRequestRevision,
            currentRevision: previous.revision,
            currentStatus: previous.status,
          });
        }
        if (!previous.options.some((option) => option.id === optionId)) {
          throw new ProductStoreError("INVALID_ARGUMENT", "Agent Request answer does not match an available choice");
        }
        this.database.prepare(`
          UPDATE agent_requests
          SET status = 'answered', answer_json = ?, revision = revision + 1, updated_at = ?
          WHERE id = ? AND revision = ? AND status = 'open'
        `).run(canonicalJSON(answer), now, agentRequestId, expectedRequestRevision);
        this.database.prepare(`
          UPDATE agent_runs SET status = 'running', revision = revision + 1, updated_at = ?
          WHERE id = ? AND status = 'waiting'
        `).run(now, previous.agentRunId);
        this.database.prepare(`
          UPDATE session_runs SET status = 'running', revision = revision + 1, updated_at = ?
          WHERE id = ? AND status = 'waiting'
        `).run(now, previous.sessionRunId);
        this.database.prepare(`
          UPDATE sessions SET state = 'active', revision = revision + 1, updated_at = ?
          WHERE id = ? AND state = 'waiting'
        `).run(now, previous.sessionId);
        const team = this.database.prepare(`
          SELECT team_run_id FROM agent_runs WHERE id = ?
        `).get(previous.agentRunId) as { team_run_id?: unknown } | undefined;
        if (typeof team?.team_run_id === "string") {
          const remaining = this.database.prepare(`
            SELECT COUNT(*) AS count
            FROM agent_requests q
            JOIN agent_runs r ON r.id = q.agent_run_id
            WHERE r.team_run_id = ? AND q.status = 'open'
          `).get(team.team_run_id) as { count?: unknown } | undefined;
          if (remaining?.count === 0) {
            this.database.prepare(`
              UPDATE team_runs SET status = 'active', revision = revision + 1, updated_at = ?
              WHERE id = ? AND status = 'waiting'
            `).run(now, team.team_run_id);
          }
        }
        const updated: AgentRequestRecord = {
          ...previous,
          status: "answered",
          answer,
          revision: previous.revision + 1,
          updatedAt: now,
        };
        return {
          value: { agentRequest: updated },
          event: {
            kind: "agentRequest.answered",
            entityKind: "agentRequest",
            entityId: agentRequestId,
            taskId: previous.taskId,
            payload: updated,
          },
        };
      },
    );
  }

  async cancelAgentRequest(input: {
    requestId: string;
    agentRequestId: string;
    reason: "runtime_aborted" | "runtime_closed" | "runtime_interrupted";
  }): Promise<{ storeRevision: number; agentRequest: AgentRequestRecord }> {
    const agentRequestId = requiredString(input.agentRequestId, "agentRequestId", 200);
    return await this.mutate(
      "agentRequest.cancel",
      input.requestId,
      undefined,
      { agentRequestId, reason: input.reason },
      (_storeRevision, now) => {
        const row = this.database.prepare("SELECT * FROM agent_requests WHERE id = ?")
          .get(agentRequestId) as SQLiteRow | undefined;
        if (!row) throw new ProductStoreError("NOT_FOUND", "Agent Request does not exist", { agentRequestId });
        const previous = agentRequest(row);
        if (previous.status !== "open") {
          throw new ProductStoreError("REVISION_CONFLICT", "Agent Request is no longer open", {
            currentStatus: previous.status,
          });
        }
        this.database.prepare(`
          UPDATE agent_requests
          SET status = 'cancelled', answer_json = ?, revision = revision + 1, updated_at = ?
          WHERE id = ? AND status = 'open'
        `).run(canonicalJSON({ reason: input.reason }), now, agentRequestId);
        const updated: AgentRequestRecord = {
          ...previous,
          status: "cancelled",
          revision: previous.revision + 1,
          updatedAt: now,
        };
        return {
          value: { agentRequest: updated },
          event: {
            kind: "agentRequest.cancelled",
            entityKind: "agentRequest",
            entityId: agentRequestId,
            taskId: previous.taskId,
            payload: { ...updated, reason: input.reason },
          },
        };
      },
    );
  }

  async decideTaskAcceptance(input: {
    requestId: string;
    expectedStoreRevision: number;
    taskId: string;
    scope: TaskScope;
    expectedTaskRevision: number;
    decision: "accepted" | "rejected";
  }): Promise<{ storeRevision: number; task: TaskRecord }> {
    const taskId = requiredString(input.taskId, "taskId", 200);
    const scope = normalizedTaskScope(input.scope);
    const expectedTaskRevision = requiredRevision(input.expectedTaskRevision, "expectedTaskRevision");
    if (input.decision !== "accepted" && input.decision !== "rejected") {
      throw new ProductStoreError("INVALID_ARGUMENT", "Task acceptance decision is invalid");
    }
    return await this.mutate(
      "task.acceptance",
      input.requestId,
      input.expectedStoreRevision,
      { taskId, scope, expectedTaskRevision, decision: input.decision },
      (_storeRevision, now) => {
        const row = this.database.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as SQLiteRow | undefined;
        if (!row) throw new ProductStoreError("NOT_FOUND", "Task does not exist", { taskId });
        const previous = task(row);
        if (JSON.stringify(previous.scope) !== JSON.stringify(scope)) {
          throw new ProductStoreError("REVISION_CONFLICT", "Task Scope changed before acceptance");
        }
        if (previous.revision !== expectedTaskRevision) {
          throw new ProductStoreError("REVISION_CONFLICT", "Task changed before acceptance", {
            expectedTaskRevision,
            currentTaskRevision: previous.revision,
          });
        }
        const activeTeam = this.database.prepare(`
          SELECT id FROM team_runs WHERE task_id = ? AND status IN ('prepared', 'active', 'waiting')
        `).get(taskId);
        if (activeTeam) throw new ProductStoreError("REVISION_CONFLICT", "Task still has an active Team Run");
        const updated: TaskRecord = {
          ...previous,
          state: input.decision === "accepted" ? "completed" : "rejected",
          revision: previous.revision + 1,
          updatedAt: now,
        };
        this.database.prepare(`
          UPDATE tasks SET state = ?, revision = ?, updated_at = ? WHERE id = ? AND revision = ?
        `).run(updated.state, updated.revision, now, taskId, expectedTaskRevision);
        return {
          value: { task: updated },
          event: {
            kind: input.decision === "accepted" ? "task.accepted" : "task.rejected",
            entityKind: "task",
            entityId: taskId,
            taskId,
            payload: { task: updated, decision: input.decision },
          },
        };
      },
    );
  }

  async sessionRuntimeBinding(sessionIdValue: string): Promise<SessionRuntimeBinding | undefined> {
    this.assertOpen();
    const sessionId = requiredString(sessionIdValue, "sessionId", 200);
    const row = this.database.prepare(`
      SELECT * FROM session_runtime_bindings WHERE session_id = ?
    `).get(sessionId) as SQLiteRow | undefined;
    if (!row) return undefined;
    return {
      sessionId: text(row, "session_id"),
      taskId: text(row, "task_id"),
      adapterKind: "pi",
      adapterSessionId: text(row, "adapter_session_id"),
      adapterSessionPath: text(row, "adapter_session_path"),
      cwd: text(row, "cwd"),
      state: text(row, "state") as SessionRuntimeBinding["state"],
      revision: integer(row, "revision"),
    };
  }

  async bindSessionRuntime(input: {
    taskId: string;
    sessionId: string;
    adapterSessionId: string;
    adapterSessionPath: string;
    cwd: string;
  }): Promise<{ storeRevision: number; binding: SessionRuntimeBinding }> {
    const taskId = requiredString(input.taskId, "taskId", 200);
    const sessionId = requiredString(input.sessionId, "sessionId", 200);
    const adapterSessionId = requiredString(input.adapterSessionId, "adapterSessionId", 200);
    if (!isAbsolute(input.adapterSessionPath) || !isAbsolute(input.cwd)) {
      throw new ProductStoreError("INVALID_ARGUMENT", "Runtime binding paths must be absolute");
    }
    const params = {
      taskId,
      sessionId,
      adapterSessionId,
      adapterSessionPath: resolve(input.adapterSessionPath),
      cwd: resolve(input.cwd),
    };
    return await this.mutate(
      "sessionRuntime.bind",
      `binding:${sessionId}:${adapterSessionId}`,
      undefined,
      params,
      (_storeRevision, now) => {
        const existing = this.database.prepare(`
          SELECT * FROM session_runtime_bindings WHERE session_id = ?
        `).get(sessionId) as SQLiteRow | undefined;
        if (existing) {
          if (
            existing.adapter_session_id !== adapterSessionId
            || existing.adapter_session_path !== params.adapterSessionPath
          ) {
            throw new ProductStoreError(
              "SESSION_RUNTIME_ALREADY_BOUND",
              "D Code Session is already bound to another Runtime Adapter",
              { sessionId, adapterSessionId: existing.adapter_session_id },
            );
          }
          const binding: SessionRuntimeBinding = {
            sessionId,
            taskId,
            adapterKind: "pi",
            adapterSessionId,
            adapterSessionPath: params.adapterSessionPath,
            cwd: params.cwd,
            state: "ready",
            revision: integer(existing, "revision"),
          };
          return {
            value: { binding },
            event: {
              kind: "sessionRuntime.reused",
              entityKind: "session",
              entityId: sessionId,
              taskId,
              payload: binding,
            },
          };
        }
        const session = this.database.prepare(`
          SELECT id FROM sessions WHERE id = ? AND task_id = ?
        `).get(sessionId, taskId);
        if (!session) throw new ProductStoreError("NOT_FOUND", "D Code Session binding target does not exist");
        const binding: SessionRuntimeBinding = {
          sessionId,
          taskId,
          adapterKind: "pi",
          adapterSessionId,
          adapterSessionPath: params.adapterSessionPath,
          cwd: params.cwd,
          state: "ready",
          revision: 1,
        };
        this.database.prepare(`
          INSERT INTO session_runtime_bindings(
            session_id, task_id, adapter_kind, adapter_session_id,
            adapter_session_path, cwd, state, revision, created_at, updated_at
          ) VALUES (?, ?, 'pi', ?, ?, ?, 'ready', 1, ?, ?)
        `).run(sessionId, taskId, adapterSessionId, params.adapterSessionPath, params.cwd, now, now);
        return {
          value: { binding },
          event: {
            kind: "sessionRuntime.bound",
            entityKind: "session",
            entityId: sessionId,
            taskId,
            payload: binding,
          },
        };
      },
    );
  }

  async finishSessionRun(input: {
    sessionRunId: string;
    providerAttemptId: string;
    outcome: "succeeded" | "failed" | "aborted" | "unknown";
    resultReference?: Record<string, unknown>;
    assistantText?: string;
    assistantSourceEntryId?: string;
  }): Promise<{ storeRevision: number; status: string }> {
    return await this.serializeMutation(async () => await this.finishSessionRunNow(input));
  }

  async startSessionRun(sessionRunIdValue: string): Promise<{ storeRevision: number; status: string }> {
    const sessionRunId = requiredString(sessionRunIdValue, "sessionRunId", 200);
    return await this.mutate(
      "sessionRun.start",
      `session-run-start:${sessionRunId}`,
      undefined,
      { sessionRunId },
      (_storeRevision, now) => {
        const row = this.database.prepare(`
          SELECT id, task_id, session_id, status FROM session_runs WHERE id = ?
        `).get(sessionRunId) as SQLiteRow | undefined;
        if (!row) throw new ProductStoreError("NOT_FOUND", "Session Run does not exist", { sessionRunId });
        const priorStatus = text(row, "status");
        if (priorStatus !== "prepared") {
          throw new ProductStoreError("REVISION_CONFLICT", "Session Run is not prepared", { priorStatus });
        }
        this.database.prepare(`
          UPDATE session_runs SET status = 'running', revision = revision + 1, updated_at = ?
          WHERE id = ? AND status = 'prepared'
        `).run(now, sessionRunId);
        this.database.prepare(`
          UPDATE sessions SET state = 'active', revision = revision + 1, updated_at = ?
          WHERE id = ? AND state != 'archived'
        `).run(now, text(row, "session_id"));
        return {
          value: { status: "running" },
          event: {
            kind: "sessionRun.started",
            entityKind: "sessionRun",
            entityId: sessionRunId,
            taskId: text(row, "task_id"),
            payload: { sessionRunId, status: "running" },
          },
        };
      },
    );
  }

  async prepareAgentRunStop(input: {
    requestId: string;
    expectedStoreRevision: number;
    scope: TaskScope;
    taskId: string;
    teamRunId: string;
    agentRunId: string;
    sessionRunId: string;
    runtimeId: string;
    expectedAgentRunRevision: number;
  }): Promise<{ storeRevision: number; attemptId: string }> {
    const scope = normalizedTaskScope(input.scope);
    const taskId = requiredString(input.taskId, "taskId", 200);
    const teamRunId = requiredString(input.teamRunId, "teamRunId", 200);
    const agentRunId = requiredString(input.agentRunId, "agentRunId", 200);
    const sessionRunId = requiredString(input.sessionRunId, "sessionRunId", 200);
    const runtimeId = requiredString(input.runtimeId, "runtimeId", 200);
    const expectedAgentRunRevision = requiredRevision(input.expectedAgentRunRevision, "expectedAgentRunRevision");
    return await this.mutate(
      "agentRun.stop.prepare",
      input.requestId,
      input.expectedStoreRevision,
      { scope, taskId, teamRunId, agentRunId, sessionRunId, runtimeId, expectedAgentRunRevision },
      (_storeRevision, now) => {
        const taskRow = this.database.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as SQLiteRow | undefined;
        if (!taskRow || JSON.stringify(task(taskRow).scope) !== JSON.stringify(scope)) {
          throw new ProductStoreError("REVISION_CONFLICT", "Agent Run Task Scope changed before stop");
        }
        const row = this.database.prepare(`
          SELECT g.revision AS agent_revision, g.status AS agent_status,
            r.status AS session_run_status
          FROM agent_runs g
          JOIN session_runs r ON r.agent_run_id = g.id
          WHERE g.id = ? AND g.task_id = ? AND g.team_run_id = ?
            AND r.id = ? AND r.runtime_id = ?
        `).get(agentRunId, taskId, teamRunId, sessionRunId, runtimeId) as SQLiteRow | undefined;
        if (!row) throw new ProductStoreError("NOT_FOUND", "Agent Run stop identity does not exist");
        if (integer(row, "agent_revision") !== expectedAgentRunRevision) {
          throw new ProductStoreError("REVISION_CONFLICT", "Agent Run changed before stop", {
            expectedAgentRunRevision,
            currentAgentRunRevision: integer(row, "agent_revision"),
          });
        }
        const agentStatus = text(row, "agent_status");
        const sessionRunStatus = text(row, "session_run_status");
        if (!new Set(["running", "waiting"]).has(agentStatus)
          || !new Set(["running", "waiting"]).has(sessionRunStatus)) {
          throw new ProductStoreError("REVISION_CONFLICT", "Agent Run is not active", {
            agentStatus,
            sessionRunStatus,
          });
        }
        const attemptId = `attempt-${randomUUID()}`;
        this.database.prepare(`
          INSERT INTO operation_attempts(
            id, task_id, session_id, session_run_id, agent_run_id,
            operation_kind, target_identity, parameter_digest, replay_policy,
            status, outcome_json, prepared_at, completed_at, updated_at
          )
          SELECT ?, ?, r.session_id, ?, ?, 'external_side_effect', ?, ?, 'never',
            'prepared', NULL, ?, NULL, ?
          FROM session_runs r WHERE r.id = ?
        `).run(
          attemptId,
          taskId,
          sessionRunId,
          agentRunId,
          `runtime.abort:${runtimeId}`,
          `sha256:${payloadHash({ taskId, teamRunId, agentRunId, sessionRunId, runtimeId })}`,
          now,
          now,
          sessionRunId,
        );
        return {
          value: { attemptId },
          event: {
            kind: "agentRun.stopPrepared",
            entityKind: "operationAttempt",
            entityId: attemptId,
            taskId,
            payload: { attemptId, teamRunId, agentRunId, sessionRunId, runtimeId },
          },
        };
      },
    );
  }

  async prepareToolAttempt(input: {
    taskId: string;
    sessionId: string;
    sessionRunId: string;
    toolCallId: string;
    toolName: string;
    parameterDigest: string;
  }): Promise<{ storeRevision: number; attemptId: string }> {
    const taskId = requiredString(input.taskId, "taskId", 200);
    const sessionId = requiredString(input.sessionId, "sessionId", 200);
    const sessionRunId = requiredString(input.sessionRunId, "sessionRunId", 200);
    const toolCallId = requiredString(input.toolCallId, "toolCallId", 200);
    const toolName = requiredString(input.toolName, "toolName", 200);
    if (!/^sha256:[a-f0-9]{64}$/.test(input.parameterDigest)) {
      throw new ProductStoreError("INVALID_ARGUMENT", "Tool parameterDigest must be SHA-256");
    }
    return await this.mutate(
      "operationAttempt.prepareTool",
      `tool-${createHash("sha256").update(`${sessionRunId}\0${toolCallId}`).digest("hex").slice(0, 48)}`,
      undefined,
      { taskId, sessionId, sessionRunId, toolCallId, toolName, parameterDigest: input.parameterDigest },
      (_storeRevision, now) => {
        const run = this.database.prepare(`
          SELECT id FROM session_runs WHERE id = ? AND task_id = ? AND session_id = ?
        `).get(sessionRunId, taskId, sessionId);
        if (!run) throw new ProductStoreError("NOT_FOUND", "Tool Attempt Session Run does not exist");
        const attemptId = `attempt-${randomUUID()}`;
        this.database.prepare(`
          INSERT INTO operation_attempts(
            id, task_id, session_id, session_run_id, agent_run_id,
            operation_kind, target_identity, parameter_digest, replay_policy,
            status, outcome_json, prepared_at, completed_at, updated_at
          )
          SELECT ?, ?, ?, ?, r.agent_run_id, 'tool_invocation', ?, ?, 'never',
            'prepared', NULL, ?, NULL, ?
          FROM session_runs r WHERE r.id = ?
        `).run(
          attemptId,
          taskId,
          sessionId,
          sessionRunId,
          `${toolName}:${toolCallId}`,
          input.parameterDigest,
          now,
          now,
          sessionRunId,
        );
        return {
          value: { attemptId },
          event: {
            kind: "operationAttempt.prepared",
            entityKind: "operationAttempt",
            entityId: attemptId,
            taskId,
            payload: { attemptId, sessionRunId, toolCallId, toolName },
          },
        };
      },
    );
  }

  async finishOperationAttempt(input: {
    attemptId: string;
    outcome: "succeeded" | "failed" | "unknown";
    resultDigest?: string;
  }): Promise<{ storeRevision: number; status: string }> {
    return await this.serializeMutation(async () => {
      this.assertOpen();
      await this.lease.assertOwned();
      const attemptId = requiredString(input.attemptId, "attemptId", 200);
      if (input.resultDigest !== undefined && !/^sha256:[a-f0-9]{64}$/.test(input.resultDigest)) {
        throw new ProductStoreError("INVALID_ARGUMENT", "Operation resultDigest must be SHA-256");
      }
      this.database.exec("BEGIN IMMEDIATE");
      try {
        const attempt = this.database.prepare(`
          SELECT status, task_id FROM operation_attempts WHERE id = ?
        `).get(attemptId) as { status?: unknown; task_id?: unknown } | undefined;
        if (!attempt || typeof attempt.task_id !== "string") {
          throw new ProductStoreError("NOT_FOUND", "Operation Attempt does not exist", { attemptId });
        }
        if (attempt.status !== "prepared") {
          const revision = this.metaInteger("store_revision");
          this.database.exec("COMMIT");
          return { storeRevision: revision, status: String(attempt.status) };
        }
        const now = this.now();
        this.database.prepare(`
          UPDATE operation_attempts
          SET status = ?, outcome_json = ?, completed_at = ?, updated_at = ?
          WHERE id = ? AND status = 'prepared'
        `).run(
          input.outcome,
          canonicalJSON({ resultDigest: input.resultDigest ?? null }),
          now,
          now,
          attemptId,
        );
        const storeRevision = this.metaInteger("store_revision") + 1;
        this.database.prepare("UPDATE dcode_meta SET value = ? WHERE key = 'store_revision'")
          .run(String(storeRevision));
        this.database.prepare(`
          INSERT INTO store_events(
            event_id, store_revision, kind, entity_kind, entity_id, task_id, payload_json, created_at
          ) VALUES (?, ?, 'operationAttempt.finished', 'operationAttempt', ?, ?, ?, ?)
        `).run(
          randomUUID(),
          storeRevision,
          attemptId,
          attempt.task_id,
          canonicalJSON({ attemptId, outcome: input.outcome }),
          now,
        );
        await this.lease.assertOwned();
        this.database.exec("COMMIT");
        return { storeRevision, status: input.outcome };
      } catch (error) {
        rollback(this.database);
        throw error;
      }
    });
  }

  async recordToolEvidence(input: {
    requestId: string;
    attemptId: string;
    toolName: string;
    outcome: "succeeded" | "failed";
    resultDigest: string;
  }): Promise<{ storeRevision: number; evidence: EvidenceRecord }> {
    const attemptId = requiredString(input.attemptId, "attemptId", 200);
    const toolName = requiredString(input.toolName, "toolName", 200);
    if (!/^sha256:[a-f0-9]{64}$/.test(input.resultDigest)) {
      throw new ProductStoreError("INVALID_ARGUMENT", "Evidence resultDigest must be SHA-256");
    }
    return await this.mutate(
      "evidence.recordTool",
      input.requestId,
      undefined,
      { attemptId, toolName, outcome: input.outcome, resultDigest: input.resultDigest },
      (_storeRevision, now) => {
        const row = this.database.prepare(`
          SELECT task_id, session_id, agent_run_id, status
          FROM operation_attempts WHERE id = ? AND operation_kind = 'tool_invocation'
        `).get(attemptId) as SQLiteRow | undefined;
        if (!row || typeof row.session_id !== "string") {
          throw new ProductStoreError("NOT_FOUND", "Tool Evidence Attempt does not exist");
        }
        if (row.status !== input.outcome) {
          throw new ProductStoreError("REVISION_CONFLICT", "Tool Evidence outcome does not match its Attempt");
        }
        const evidence: EvidenceRecord = {
          id: `evidence-${randomUUID()}`,
          taskId: text(row, "task_id"),
          sessionId: text(row, "session_id"),
          ...(typeof row.agent_run_id === "string" ? { agentRunId: row.agent_run_id } : {}),
          evidenceKind: "tool_result_digest",
          commandRedacted: toolName,
          exitKind: input.outcome === "succeeded" ? "ok" : "failure",
          payload: { attemptId, resultDigest: input.resultDigest },
          createdAt: now,
        };
        this.database.prepare(`
          INSERT INTO evidence_records(
            id, task_id, session_id, legacy_run_id, agent_run_id,
            source_record_id, evidence_kind, command_redacted, exit_kind,
            exit_code, started_at, ended_at, cwd, payload_json, created_at
          ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?, ?)
        `).run(
          evidence.id,
          evidence.taskId,
          evidence.sessionId,
          evidence.agentRunId ?? null,
          attemptId,
          evidence.evidenceKind,
          toolName,
          input.outcome === "succeeded" ? "ok" : "failure",
          now,
          canonicalJSON(evidence.payload),
          now,
        );
        return {
          value: { evidence },
          event: {
            kind: "evidence.recorded",
            entityKind: "evidence",
            entityId: evidence.id,
            taskId: evidence.taskId,
            payload: evidence,
          },
        };
      },
    );
  }

  private async finishSessionRunNow(input: {
    sessionRunId: string;
    providerAttemptId: string;
    outcome: "succeeded" | "failed" | "aborted" | "unknown";
    resultReference?: Record<string, unknown>;
    assistantText?: string;
    assistantSourceEntryId?: string;
  }): Promise<{ storeRevision: number; status: string }> {
    this.assertOpen();
    await this.lease.assertOwned();
    const sessionRunId = requiredString(input.sessionRunId, "sessionRunId", 200);
    const providerAttemptId = requiredString(input.providerAttemptId, "providerAttemptId", 200);
    stableValue(input.resultReference ?? {});
    assertCredentialFreeValue(input.resultReference ?? {}, "resultReference");
    if (input.assistantText !== undefined && redactCredentialText(input.assistantText).redacted) {
      throw new ProductStoreError("CREDENTIAL_MATERIAL_REJECTED", "assistantText contains credential material");
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const attempt = this.database.prepare(`
        SELECT a.status, a.task_id, r.agent_run_id, r.session_id, r.user_entry_id,
          g.team_run_id, g.role AS agent_role
        FROM operation_attempts a
        JOIN session_runs r ON r.id = a.session_run_id
        LEFT JOIN agent_runs g ON g.id = r.agent_run_id
        WHERE a.id = ? AND a.session_run_id = ?
      `).get(providerAttemptId, sessionRunId) as {
        status?: unknown;
        task_id?: unknown;
        agent_run_id?: unknown;
        session_id?: unknown;
        user_entry_id?: unknown;
        team_run_id?: unknown;
        agent_role?: unknown;
      } | undefined;
      if (!attempt || typeof attempt.task_id !== "string") {
        throw new ProductStoreError("NOT_FOUND", "Provider Attempt does not exist", { providerAttemptId });
      }
      if (attempt.status !== "prepared") {
        const revision = this.metaInteger("store_revision");
        this.database.exec("COMMIT");
        return { storeRevision: revision, status: String(attempt.status) };
      }
      const now = this.now();
      const runStatus = input.outcome === "succeeded" ? "completed" : input.outcome;
      const attemptOutcome = input.outcome === "aborted" ? "failed" : input.outcome;
      let assistantEntryId: string | undefined;
      if (
        input.outcome === "succeeded"
        && typeof input.assistantText === "string"
        && input.assistantText.length > 0
        && typeof attempt.session_id === "string"
      ) {
        assistantEntryId = `entry-${randomUUID()}`;
        const currentPath = this.database.prepare(`
          SELECT id FROM session_paths WHERE session_id = ? AND is_current = 1
        `).get(attempt.session_id) as { id?: unknown } | undefined;
        if (typeof currentPath?.id !== "string") {
          throw new ProductStoreError("NOT_FOUND", "D Code Session has no current path for Assistant result");
        }
        const pathOrdinal = this.database.prepare(`
          SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal
          FROM session_path_entries WHERE path_id = ?
        `).get(currentPath.id) as { ordinal?: unknown } | undefined;
        this.database.prepare(`
          INSERT INTO session_entries(
            id, session_id, parent_entry_id, source_kind, lineage_status,
            source_entry_id, source_parent_entry_id, source_ordinal,
            source_timestamp, message_role, content_json, created_at
          ) VALUES (?, ?, ?, 'native', 'native', ?, NULL, ?, ?, 'assistant', ?, ?)
        `).run(
          assistantEntryId,
          attempt.session_id,
          typeof attempt.user_entry_id === "string" ? attempt.user_entry_id : null,
          input.assistantSourceEntryId ?? null,
          typeof pathOrdinal?.ordinal === "number" ? pathOrdinal.ordinal : 0,
          now,
          canonicalJSON({ type: "text", text: input.assistantText }),
          now,
        );
        this.database.prepare(`
          INSERT INTO session_path_entries(path_id, entry_id, ordinal) VALUES (?, ?, ?)
        `).run(
          currentPath.id,
          assistantEntryId,
          typeof pathOrdinal?.ordinal === "number" ? pathOrdinal.ordinal : 0,
        );
      }
      this.database.prepare(`
        UPDATE operation_attempts
        SET status = ?, outcome_json = ?, completed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'prepared'
      `).run(
        attemptOutcome,
        canonicalJSON(input.resultReference ?? {}),
        now,
        now,
        providerAttemptId,
      );
      this.database.prepare(`
        UPDATE session_runs
        SET status = ?, assistant_entry_id = ?, revision = revision + 1, completed_at = ?, updated_at = ?
        WHERE id = ?
      `).run(runStatus, assistantEntryId ?? null, now, now, sessionRunId);
      if (typeof attempt.session_id === "string") {
        const sessionState = runStatus === "completed" ? "completed" : "failed";
        this.database.prepare(`
          UPDATE sessions SET state = ?, revision = revision + 1, updated_at = ?
          WHERE id = ?
        `).run(sessionState, now, attempt.session_id);
      }
      if (typeof attempt.agent_run_id === "string") {
        this.database.prepare(`
          UPDATE agent_runs
          SET status = ?, revision = revision + 1, completed_at = ?, updated_at = ?
          WHERE id = ?
        `).run(runStatus, now, now, attempt.agent_run_id);
        if (assistantEntryId && input.assistantText) {
          this.database.prepare(`
            INSERT INTO agent_reports(
              id, task_id, agent_run_id, report_kind, body_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?)
          `).run(
            `report-${randomUUID()}`,
            attempt.task_id,
            attempt.agent_run_id,
            attempt.agent_role === "coordinator" ? "coordinator" : "member",
            canonicalJSON({
              text: input.assistantText,
              sessionRunId,
              assistantEntryId,
              sourceEntryId: input.assistantSourceEntryId ?? null,
            }),
            now,
          );
        }
        if (typeof attempt.team_run_id === "string") {
          const activeMembers = this.database.prepare(`
            SELECT COUNT(*) AS count FROM agent_runs
            WHERE team_run_id = ? AND status IN ('prepared', 'running', 'waiting')
          `).get(attempt.team_run_id) as { count?: unknown } | undefined;
          if (activeMembers?.count === 0) {
            const coordinatorReports = this.database.prepare(`
              SELECT COUNT(*) AS count
              FROM agent_reports p
              JOIN team_runs t ON t.coordinator_agent_run_id = p.agent_run_id
              WHERE t.id = ? AND p.report_kind = 'coordinator'
            `).get(attempt.team_run_id) as { count?: unknown } | undefined;
            if (typeof coordinatorReports?.count !== "number" || coordinatorReports.count < 2) {
              // Coordinator has planned once but has not yet synthesized member reports.
              // Keep the Team active so the same Coordination Session can run its second phase.
            } else {
            const failedMembers = this.database.prepare(`
              SELECT
                SUM(CASE WHEN status IN ('failed', 'unknown', 'interrupted') THEN 1 ELSE 0 END) AS failed,
                SUM(CASE WHEN status = 'aborted' THEN 1 ELSE 0 END) AS aborted
              FROM agent_runs WHERE team_run_id = ?
            `).get(attempt.team_run_id) as { failed?: unknown; aborted?: unknown } | undefined;
            const terminalStatus = typeof failedMembers?.failed === "number" && failedMembers.failed > 0
              ? "failed"
              : typeof failedMembers?.aborted === "number" && failedMembers.aborted > 0
                ? "aborted"
                : "completed";
            this.database.prepare(`
              UPDATE team_runs
              SET status = ?, revision = revision + 1,
                completed_at = ?, updated_at = ?
              WHERE id = ? AND status IN ('prepared', 'active', 'waiting')
            `).run(terminalStatus, now, now, attempt.team_run_id);
            }
          }
        }
      }
      const storeRevision = this.metaInteger("store_revision") + 1;
      this.database.prepare("UPDATE dcode_meta SET value = ? WHERE key = 'store_revision'")
        .run(String(storeRevision));
      this.database.prepare(`
        INSERT INTO store_events(
          event_id, store_revision, kind, entity_kind, entity_id, task_id, payload_json, created_at
        ) VALUES (?, ?, 'sessionRun.finished', 'sessionRun', ?, ?, ?, ?)
      `).run(
        randomUUID(),
        storeRevision,
        sessionRunId,
        attempt.task_id,
        canonicalJSON({ sessionRunId, providerAttemptId, outcome: input.outcome }),
        now,
      );
      await this.lease.assertOwned();
      this.database.exec("COMMIT");
      return { storeRevision, status: runStatus };
    } catch (error) {
      rollback(this.database);
      throw error;
    }
  }

  async updateAgentProfile(input: {
    requestId: string;
    expectedStoreRevision: number;
    profileId: string;
    expectedProfileRevision: number;
    name: string;
    roleContract: string;
    enabled: boolean;
  }): Promise<{ storeRevision: number; agentProfile: AgentProfileRecord }> {
    const profileId = requiredString(input.profileId, "profileId", 200);
    const expectedProfileRevision = requiredRevision(input.expectedProfileRevision, "expectedProfileRevision");
    const name = requiredCredentialFreeString(input.name, "name", 200).trim();
    const roleContract = requiredCredentialFreeString(input.roleContract, "roleContract", 20_000);
    if (typeof input.enabled !== "boolean") {
      throw new ProductStoreError("INVALID_ARGUMENT", "enabled must be a boolean");
    }
    const params = { profileId, expectedProfileRevision, name, roleContract, enabled: input.enabled };
    return await this.mutate(
      "agentProfile.update",
      input.requestId,
      input.expectedStoreRevision,
      params,
      (_storeRevision, now) => {
        const row = this.database.prepare("SELECT * FROM agent_profiles WHERE id = ?").get(profileId) as SQLiteRow | undefined;
        if (!row) throw new ProductStoreError("NOT_FOUND", "Agent Profile does not exist", { profileId });
        const previous = agentProfile(row);
        if (previous.revision !== expectedProfileRevision) {
          throw new ProductStoreError(
            "REVISION_CONFLICT",
            "The Agent Profile changed before this mutation could be applied",
            { profileId, expectedProfileRevision, currentProfileRevision: previous.revision },
          );
        }
        const updated: AgentProfileRecord = {
          ...previous,
          name,
          roleContract,
          enabled: input.enabled,
          profileVersion: previous.profileVersion + 1,
          revision: previous.revision + 1,
          updatedAt: now,
        };
        this.database.prepare(`
          UPDATE agent_profiles
          SET name = ?, role_contract = ?, enabled = ?, profile_version = ?, revision = ?, updated_at = ?
          WHERE id = ? AND revision = ?
        `).run(
          updated.name,
          updated.roleContract,
          updated.enabled ? 1 : 0,
          updated.profileVersion,
          updated.revision,
          now,
          profileId,
          expectedProfileRevision,
        );
        this.faultInjector?.("profile.afterUpdate");
        return {
          value: { agentProfile: updated },
          event: {
            kind: "agentProfile.updated",
            entityKind: "agentProfile",
            entityId: updated.id,
            payload: updated,
          },
        };
      },
    );
  }

  async createAgentProfile(input: {
    requestId: string;
    expectedStoreRevision: number;
    name: string;
    roleContract: string;
    enabled: boolean;
  }): Promise<{ storeRevision: number; agentProfile: AgentProfileRecord }> {
    const name = requiredCredentialFreeString(input.name, "name", 200).trim();
    const roleContract = requiredCredentialFreeString(input.roleContract, "roleContract", 20_000);
    if (typeof input.enabled !== "boolean") {
      throw new ProductStoreError("INVALID_ARGUMENT", "enabled must be a boolean");
    }
    return await this.mutate(
      "agentProfile.create",
      input.requestId,
      input.expectedStoreRevision,
      { name, roleContract, enabled: input.enabled },
      (_storeRevision, now) => {
        const record: AgentProfileRecord = {
          id: `profile-${randomUUID()}`,
          role: "custom",
          name,
          roleContract,
          enabled: input.enabled,
          builtin: false,
          profileVersion: 1,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        this.database.prepare(`
          INSERT INTO agent_profiles(
            id, role, name, role_contract, enabled, builtin,
            profile_version, revision, created_at, updated_at
          ) VALUES (?, 'custom', ?, ?, ?, 0, 1, 1, ?, ?)
        `).run(record.id, name, roleContract, input.enabled ? 1 : 0, now, now);
        return {
          value: { agentProfile: record },
          event: {
            kind: "agentProfile.created",
            entityKind: "agentProfile",
            entityId: record.id,
            payload: record,
          },
        };
      },
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.mutationQueue;
    this.closed = true;
    let databaseError: unknown;
    try {
      this.database.close();
    } catch (error) {
      databaseError = error;
    }
    try {
      await this.lease.release();
    } catch (leaseError) {
      if (!databaseError) throw leaseError;
    }
    if (databaseError) throw databaseError;
  }
}
