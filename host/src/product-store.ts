import { createHash, randomUUID } from "node:crypto";
import { chmod, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, parse, relative, resolve } from "node:path";
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
  migrateProductStoreSchemaIfNeeded,
  validateProductStoreSchema,
} from "./product-store-schema.js";
import { buildLegacyMigrationPlan, type LegacyStoreKind } from "./legacy-migration.js";
import { redactCredentialText } from "./credential-material.js";
import {
  DCodePromptSourceReceiptError,
  normalizeDCodePromptSourceReceipts,
  type DCodePromptSourceReceipt,
} from "./prompt-source-status.js";
import {
  importedHistoryWasRedactedAtImport,
  ImportedSessionHistoryReceiptError,
  normalizeImportedSessionHistoryReceipt,
  projectImportedSessionHistory,
  type ImportedSessionHistoryProjection,
  type ImportedSessionHistoryReceipt,
} from "./imported-history-projection.js";
import {
  MANAGED_WORKER_WORKTREE_ARTIFACT_KIND,
  MANAGED_WORKER_WORKTREE_TARGET_PREFIX,
  managedWorkerWorktreeArtifactId,
  type ManagedWorkerWorktreePlan,
} from "./managed-worker-worktree.js";

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

export interface ModelProviderRecord {
  id: string;
  name: string;
  baseUrl?: string;
  apiKind?: string;
  authMode?: string;
  nonsecret: unknown;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ModelCatalogEntryRecord {
  id: string;
  providerId: string;
  modelId: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning: boolean;
  nonsecret: unknown;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface CredentialReferenceRecord {
  id: string;
  providerId: string;
  referenceKind: "keychain" | "environment" | "external_auth_bridge";
  locator: string;
  configured: boolean;
  sourceDigest?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeModelSelectionRecord {
  providerId: string;
  modelId: string;
  sourceKind: "legacy_pi_settings" | "user";
  revision: number;
}

export type TaskWorkbenchInspectorTarget =
  | { kind: "artifact"; id: string }
  | { kind: "evidence"; id: string }
  | { kind: "report"; id: string }
  | { kind: "context"; id: string };

/**
 * A small, credential-free view preference that belongs to the D Code Product
 * Store rather than the App sandbox. It restores object identity only — never
 * transcript, prompt, artifact, or any other content body.
 */
export interface TaskWorkbenchViewStateRecord {
  version: 1;
  selection: { taskId: string | null; sessionId: string | null };
  expandedHudSections: string[];
  inspectorTarget: TaskWorkbenchInspectorTarget | null;
  revision: number;
}

export interface TaskWorkbenchViewStatePatch {
  selection?: { taskId: string | null; sessionId: string | null };
  expandedHudSections?: string[];
  inspectorTarget?: TaskWorkbenchInspectorTarget | null;
}

export interface ComposerDraftRecord {
  id: string;
  taskId?: string;
  sessionId?: string;
  draftKind: "new_task" | "session_path";
  text: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeModelCatalogProviderInput {
  id: string;
  name: string;
  baseUrl?: string;
  apiKind?: string;
  authMode?: string;
  nonsecret?: unknown;
  credential: {
    locator: string;
    configured: boolean;
    sourceDigest?: string;
  };
  models: Array<{
    modelId: string;
    name: string;
    contextWindow?: number;
    maxTokens?: number;
    reasoning: boolean;
    nonsecret?: unknown;
  }>;
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

export type TaskContextSourceKind = "scope_document" | "global_knowledge";

export interface TaskContextSourceInput {
  kind: TaskContextSourceKind;
  relativePath: string;
  title?: string;
  rootPath?: string;
}

export interface TaskContextSourceRecord {
  id: string;
  taskId: string;
  kind: TaskContextSourceKind;
  relativePath: string;
  title: string;
  ordinal: number;
  rootPath?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskContextSetRecord {
  taskId: string;
  revision: number;
  sources: TaskContextSourceRecord[];
  createdAt: string;
  updatedAt: string;
}

export type TaskPlanState = "draft" | "active" | "paused" | "completed" | "superseded";

export interface TaskPlanRecord {
  id: string;
  taskId: string;
  state: TaskPlanState;
  document: unknown;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export type TaskWorkItemState = "pending" | "in_progress" | "completed" | "blocked" | "cancelled";

export interface TaskWorkItemRecord {
  id: string;
  taskId: string;
  ordinal: number;
  title: string;
  state: TaskWorkItemState;
  ownerAssignmentId?: string;
  details: unknown;
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

export type { ImportedSessionHistoryProjection, ImportedSessionHistoryReceipt } from "./imported-history-projection.js";

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
  modelProvider?: string;
  modelId?: string;
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
  importedHistoryReceipt?: ImportedSessionHistoryReceipt;
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

export interface ManagedWorkerWorktreeRecord {
  artifactId: string;
  taskId: string;
  teamRunId: string;
  agentRunId: string;
  projectId: string;
  workspaceId: string;
  managedPath: string;
  workspaceCwd: string;
  sourceProjectDirectory: string;
  repositoryRoot: string;
  commonGitDirectory: string;
  baseCommit: string;
  projectRelativePath: string;
  provisionAttemptId: string;
  state: "preparing" | "ready" | "failed" | "unknown";
  failureCode?: string;
  revision: number;
}

export interface TeamFailureRecord {
  teamRunId: string;
  taskId: string;
  status: "failed" | "aborted";
  reason: string;
  reasonCode?: string;
  eventSequence: number;
  createdAt: string;
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
  modelProviders: ModelProviderRecord[];
  modelCatalogEntries: ModelCatalogEntryRecord[];
  credentialReferences: CredentialReferenceRecord[];
  runtimeModelSelection?: RuntimeModelSelectionRecord;
  taskWorkbenchViewState: TaskWorkbenchViewStateRecord;
  agentProfiles: AgentProfileRecord[];
  tasks: TaskRecord[];
  taskContextSets: TaskContextSetRecord[];
  taskPlans: TaskPlanRecord[];
  taskWorkItems: TaskWorkItemRecord[];
  composerDrafts: ComposerDraftRecord[];
  sessions: DCodeSessionRecord[];
  sessionPaths: SessionPathRecord[];
  sessionProvenance: SessionProvenanceRecord[];
  coordinatorAssignments: CoordinatorAssignmentRecord[];
  piImports: PiImportSourceRecord[];
  sessionRuntimeBindings: SessionRuntimeBinding[];
  sessionRuns: SessionRunRecord[];
  operationAttempts: OperationAttemptRecord[];
  runtimeEnvironments: RuntimeEnvironmentRecord[];
  activeToolSets: ActiveToolSetRecord[];
  promptReceipts: PromptReceiptRecord[];
  teamRuns: TeamRunRecord[];
  teamFailures: TeamFailureRecord[];
  agentRuns: AgentRunRecord[];
  agentAssignments: AgentAssignmentRecord[];
  agentRequests: AgentRequestRecord[];
  agentReports: AgentReportRecord[];
  findings: FindingRecord[];
  artifacts: ArtifactRecord[];
  managedWorkerWorktrees: ManagedWorkerWorktreeRecord[];
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

const TASK_WORKBENCH_HUD_SECTIONS = new Set(["progress", "team", "waiting", "deliverables"]);
const DEFAULT_TASK_WORKBENCH_HUD_SECTIONS = [...TASK_WORKBENCH_HUD_SECTIONS].sort();
const TASK_WORKBENCH_INSPECTOR_KINDS = new Set(["artifact", "evidence", "report", "context"]);

function normalizedTaskWorkbenchInspectorTarget(value: unknown): TaskWorkbenchInspectorTarget | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ProductStoreError("INVALID_ARGUMENT", "Task Workbench inspectorTarget must be an object or null");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || !TASK_WORKBENCH_INSPECTOR_KINDS.has(record.kind as string)) {
    throw new ProductStoreError("INVALID_ARGUMENT", "Task Workbench inspectorTarget is invalid");
  }
  const kind = record.kind as TaskWorkbenchInspectorTarget["kind"];
  const id = requiredCredentialFreeString(record.id, "Task Workbench inspectorTarget.id", 200);
  return { kind, id } as TaskWorkbenchInspectorTarget;
}

function normalizedTaskWorkbenchViewState(
  value: unknown,
  revision: number,
): TaskWorkbenchViewStateRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProductStoreError("INVALID_ARGUMENT", "Task Workbench View State must be an object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(["version", "selection", "expandedHudSections", "inspectorTarget"]);
  if (Object.keys(record).some((key) => !allowed.has(key)) || record.version !== 1) {
    throw new ProductStoreError("INVALID_ARGUMENT", "Task Workbench View State has an unsupported shape");
  }
  if (typeof record.selection !== "object" || record.selection === null || Array.isArray(record.selection)) {
    throw new ProductStoreError("INVALID_ARGUMENT", "Task Workbench View State selection is invalid");
  }
  const selection = record.selection as Record<string, unknown>;
  if (Object.keys(selection).length !== 2 || !("taskId" in selection) || !("sessionId" in selection)) {
    throw new ProductStoreError("INVALID_ARGUMENT", "Task Workbench View State selection has an unsupported shape");
  }
  const identity = (value: unknown, field: string): string | null => {
    if (value === null) return null;
    return requiredCredentialFreeString(value, field, 200);
  };
  const taskId = identity(selection.taskId, "Task Workbench View State selection.taskId");
  const sessionId = identity(selection.sessionId, "Task Workbench View State selection.sessionId");
  if ((taskId === null) !== (sessionId === null)) {
    throw new ProductStoreError("INVALID_ARGUMENT", "Task Workbench View State selection must contain both identities or neither");
  }
  if (!Array.isArray(record.expandedHudSections) || record.expandedHudSections.length > TASK_WORKBENCH_HUD_SECTIONS.size) {
    throw new ProductStoreError("INVALID_ARGUMENT", "Task Workbench View State expandedHudSections is invalid");
  }
  const expandedHudSections = [...new Set(record.expandedHudSections.map((section, index) => {
    const sectionID = requiredCredentialFreeString(section, `Task Workbench View State.expandedHudSections[${index}]`, 40);
    if (!TASK_WORKBENCH_HUD_SECTIONS.has(sectionID)) {
      throw new ProductStoreError("INVALID_ARGUMENT", "Task Workbench View State contains an unknown HUD section");
    }
    return sectionID;
  }))].sort();
  return {
    version: 1,
    selection: { taskId, sessionId },
    expandedHudSections,
    inspectorTarget: normalizedTaskWorkbenchInspectorTarget(record.inspectorTarget),
    revision,
  };
}

function normalizedTaskWorkbenchViewStatePatch(value: unknown): TaskWorkbenchViewStatePatch {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProductStoreError("INVALID_ARGUMENT", "Task Workbench View State patch must be an object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(["selection", "expandedHudSections", "inspectorTarget"]);
  if (Object.keys(record).length === 0 || Object.keys(record).some((key) => !allowed.has(key))) {
    throw new ProductStoreError("INVALID_ARGUMENT", "Task Workbench View State patch has an unsupported shape");
  }
  const patch: TaskWorkbenchViewStatePatch = {};
  if ("selection" in record) {
    const selection = record.selection;
    if (typeof selection !== "object" || selection === null || Array.isArray(selection)) {
      throw new ProductStoreError("INVALID_ARGUMENT", "Task Workbench View State patch selection is invalid");
    }
    const source = selection as Record<string, unknown>;
    if (Object.keys(source).length !== 2 || !("taskId" in source) || !("sessionId" in source)) {
      throw new ProductStoreError("INVALID_ARGUMENT", "Task Workbench View State patch selection has an unsupported shape");
    }
    const identity = (candidate: unknown, field: string): string | null => (
      candidate === null ? null : requiredCredentialFreeString(candidate, field, 200)
    );
    const taskId = identity(source.taskId, "Task Workbench View State patch selection.taskId");
    const sessionId = identity(source.sessionId, "Task Workbench View State patch selection.sessionId");
    if ((taskId === null) !== (sessionId === null)) {
      throw new ProductStoreError("INVALID_ARGUMENT", "Task Workbench View State patch selection must contain both identities or neither");
    }
    patch.selection = { taskId, sessionId };
  }
  if ("expandedHudSections" in record) {
    const state = normalizedTaskWorkbenchViewState({
      version: 1,
      selection: { taskId: null, sessionId: null },
      expandedHudSections: record.expandedHudSections,
      inspectorTarget: null,
    }, 0);
    patch.expandedHudSections = state.expandedHudSections;
  }
  if ("inspectorTarget" in record) {
    patch.inspectorTarget = normalizedTaskWorkbenchInspectorTarget(record.inspectorTarget);
  }
  return patch;
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

function strictlyInside(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath !== "" && relativePath !== ".." && !relativePath.startsWith("../") && !isAbsolute(relativePath);
}

function normalizedContextRelativePath(value: unknown, field: string): string {
  const source = requiredString(value, field, 4_096);
  if (isAbsolute(source) || source.includes("\0")) {
    throw new ProductStoreError("INVALID_ARGUMENT", `${field} must be a relative path`);
  }
  const normalized = relative(parse(resolve("/")).root, resolve("/", source));
  if (!normalized || normalized === ".." || normalized.startsWith("../") || isAbsolute(normalized)) {
    throw new ProductStoreError("INVALID_ARGUMENT", `${field} escapes its declared context root`);
  }
  return normalized;
}

async function normalizeTaskContextSources(
  value: unknown,
  userHome: string,
  taskCwd: string,
): Promise<TaskContextSourceInput[]> {
  if (!Array.isArray(value) || value.length > 32) {
    throw new ProductStoreError("INVALID_ARGUMENT", "context sources must be an array of at most 32 entries");
  }
  const normalized: TaskContextSourceInput[] = [];
  const seen = new Set<string>();
  let canonicalUserHome: string;
  try {
    canonicalUserHome = await realpath(userHome);
    if (!(await stat(canonicalUserHome)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new ProductStoreError("INVALID_ARGUMENT", "Current D Code user home is unavailable for Global Knowledge selection");
  }
  let canonicalTaskCwd: string;
  try {
    canonicalTaskCwd = await realpath(taskCwd);
    if (!(await stat(canonicalTaskCwd)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new ProductStoreError("INVALID_ARGUMENT", "Task Scope directory is unavailable for Context Selection");
  }
  const requiredAgentsPath = resolve(canonicalTaskCwd, "AGENTS.md");
  for (const [index, item] of value.entries()) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new ProductStoreError("INVALID_ARGUMENT", `context sources[${index}] must be an object`);
    }
    const source = item as Record<string, unknown>;
    const kind = source.kind;
    if (kind !== "scope_document" && kind !== "global_knowledge") {
      throw new ProductStoreError("INVALID_ARGUMENT", `context sources[${index}].kind is invalid`);
    }
    const allowedKeys = kind === "scope_document"
      ? new Set(["kind", "relativePath", "title"])
      : new Set(["kind", "rootPath", "relativePath", "title"]);
    if (Object.keys(source).some((key) => !allowedKeys.has(key))) {
      throw new ProductStoreError("INVALID_ARGUMENT", `context sources[${index}] has unsupported fields`);
    }
    const relativePath = normalizedContextRelativePath(source.relativePath, `context sources[${index}].relativePath`);
    if (kind === "scope_document" && relativePath === "AGENTS.md") {
      throw new ProductStoreError(
        "INVALID_ARGUMENT",
        "AGENTS.md is a required context source and must not be selected redundantly",
      );
    }
    const title = source.title === undefined
      ? basename(relativePath)
      : requiredCredentialFreeString(source.title, `context sources[${index}].title`, 200);
    let rootPath: string | undefined;
    if (kind === "global_knowledge") {
      const rawRoot = requiredString(source.rootPath, `context sources[${index}].rootPath`, 4_096);
      if (!isAbsolute(rawRoot) || rawRoot.includes("\0")) {
        throw new ProductStoreError("INVALID_ARGUMENT", `context sources[${index}].rootPath must be absolute`);
      }
      let canonicalRoot: string;
      try {
        canonicalRoot = await realpath(resolve(rawRoot));
        if (!(await stat(canonicalRoot)).isDirectory()) throw new Error("not a directory");
      } catch {
        throw new ProductStoreError(
          "INVALID_ARGUMENT",
          `context sources[${index}].rootPath must be an accessible Global Knowledge directory`,
        );
      }
      if (!strictlyInside(canonicalUserHome, canonicalRoot)) {
        throw new ProductStoreError(
          "INVALID_ARGUMENT",
          `context sources[${index}].rootPath must resolve inside the current user home`,
        );
      }
      rootPath = canonicalRoot;
    }
    const sourcePath = source.kind === "scope_document"
      ? resolve(canonicalTaskCwd, relativePath)
      : resolve(rootPath as string, relativePath);
    if (sourcePath === requiredAgentsPath) {
      throw new ProductStoreError(
        "INVALID_ARGUMENT",
        "AGENTS.md is a required context source and must not be selected through another root",
      );
    }
    const identity = `${kind}\0${rootPath ?? ""}\0${relativePath}`;
    if (seen.has(identity)) {
      throw new ProductStoreError("INVALID_ARGUMENT", "context sources must not select the same source twice");
    }
    seen.add(identity);
    normalized.push({
      kind,
      relativePath,
      ...(title ? { title } : {}),
      ...(rootPath ? { rootPath } : {}),
    });
  }
  return normalized;
}

function normalizedTaskPlanState(value: unknown, field: string): TaskPlanState {
  if (value === "draft" || value === "active" || value === "paused" || value === "completed" || value === "superseded") {
    return value;
  }
  throw new ProductStoreError("INVALID_ARGUMENT", `${field} is not a valid Task Plan state`);
}

function normalizedTaskWorkItemState(value: unknown, field: string): TaskWorkItemState {
  if (value === "pending" || value === "in_progress" || value === "completed" || value === "blocked" || value === "cancelled") {
    return value;
  }
  throw new ProductStoreError("INVALID_ARGUMENT", `${field} is not a valid Work Item state`);
}

function normalizedPlanDocument(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProductStoreError("INVALID_ARGUMENT", `${field} must be a structured object`);
  }
  const document = stableValue(value) as Record<string, unknown>;
  assertCredentialFreeValue(document, field);
  return document;
}

function normalizedWorkItemDetails(value: unknown, field: string): unknown {
  const details = stableValue(value);
  assertCredentialFreeValue(details, field);
  return details;
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

function modelProvider(row: SQLiteRow): ModelProviderRecord {
  const optionalText = (key: string): string | undefined => (
    typeof row[key] === "string" ? row[key] as string : undefined
  );
  return {
    id: text(row, "id"),
    name: text(row, "name"),
    ...(optionalText("base_url") ? { baseUrl: optionalText("base_url") } : {}),
    ...(optionalText("api_kind") ? { apiKind: optionalText("api_kind") } : {}),
    ...(optionalText("auth_mode") ? { authMode: optionalText("auth_mode") } : {}),
    nonsecret: JSON.parse(text(row, "nonsecret_json")),
    revision: integer(row, "revision"),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
  };
}

function modelCatalogEntry(row: SQLiteRow): ModelCatalogEntryRecord {
  const optionalInteger = (key: string): number | undefined => (
    typeof row[key] === "number" && Number.isSafeInteger(row[key]) ? row[key] as number : undefined
  );
  return {
    id: text(row, "id"),
    providerId: text(row, "provider_id"),
    modelId: text(row, "model_id"),
    name: text(row, "name"),
    ...(optionalInteger("context_window") ? { contextWindow: optionalInteger("context_window") } : {}),
    ...(optionalInteger("max_tokens") ? { maxTokens: optionalInteger("max_tokens") } : {}),
    reasoning: integer(row, "reasoning") === 1,
    nonsecret: JSON.parse(text(row, "nonsecret_json")),
    revision: integer(row, "revision"),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
  };
}

function credentialReference(row: SQLiteRow): CredentialReferenceRecord {
  const sourceDigest = typeof row.source_digest === "string" ? row.source_digest as string : undefined;
  return {
    id: text(row, "id"),
    providerId: text(row, "provider_id"),
    referenceKind: text(row, "reference_kind") as CredentialReferenceRecord["referenceKind"],
    locator: text(row, "locator"),
    configured: integer(row, "configured") === 1,
    ...(sourceDigest ? { sourceDigest } : {}),
    revision: integer(row, "revision"),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
  };
}

function sessionRuntimeBinding(row: SQLiteRow): SessionRuntimeBinding {
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

function taskContextSource(row: SQLiteRow): TaskContextSourceRecord {
  const kind = text(row, "source_kind") as TaskContextSourceKind;
  const rootPath = text(row, "root_path");
  return {
    id: text(row, "id"),
    taskId: text(row, "task_id"),
    kind,
    relativePath: text(row, "relative_path"),
    title: text(row, "title"),
    ordinal: integer(row, "ordinal"),
    ...(kind === "global_knowledge" ? { rootPath } : {}),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
  };
}

function taskContextSet(row: SQLiteRow, sources: TaskContextSourceRecord[]): TaskContextSetRecord {
  return {
    taskId: text(row, "task_id"),
    revision: integer(row, "revision"),
    sources,
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
  };
}

function taskPlan(row: SQLiteRow): TaskPlanRecord {
  return {
    id: text(row, "id"),
    taskId: text(row, "task_id"),
    state: text(row, "state") as TaskPlanState,
    document: JSON.parse(text(row, "document_json")),
    revision: integer(row, "revision"),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
  };
}

function taskWorkItem(row: SQLiteRow): TaskWorkItemRecord {
  const ownerAssignmentId = row.owner_assignment_id;
  return {
    id: text(row, "id"),
    taskId: text(row, "task_id"),
    ordinal: integer(row, "ordinal"),
    title: text(row, "title"),
    state: text(row, "state") as TaskWorkItemState,
    ...(typeof ownerAssignmentId === "string" ? { ownerAssignmentId } : {}),
    details: JSON.parse(text(row, "details_json")),
    revision: integer(row, "revision"),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
  };
}

function composerDraft(row: SQLiteRow): ComposerDraftRecord {
  return {
    id: text(row, "id"),
    ...(typeof row.task_id === "string" ? { taskId: row.task_id } : {}),
    ...(typeof row.session_id === "string" ? { sessionId: row.session_id } : {}),
    draftKind: text(row, "draft_kind") as ComposerDraftRecord["draftKind"],
    text: text(row, "text"),
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

function teamFailuresFromEvents(events: StoreEventRecord[]): TeamFailureRecord[] {
  const latest = new Map<string, TeamFailureRecord>();
  for (const item of events) {
    if (item.kind !== "teamRun.failed" && item.kind !== "teamRun.aborted") continue;
    if (typeof item.taskId !== "string" || typeof item.payload !== "object" || item.payload === null || Array.isArray(item.payload)) {
      continue;
    }
    const payload = item.payload as Record<string, unknown>;
    const reason = typeof payload.reason === "string" ? payload.reason : undefined;
    if (!reason) continue;
    latest.set(item.entityId, {
      teamRunId: item.entityId,
      taskId: item.taskId,
      status: item.kind === "teamRun.failed" ? "failed" : "aborted",
      reason,
      ...(typeof payload.reasonCode === "string" ? { reasonCode: payload.reasonCode } : {}),
      eventSequence: item.sequence,
      createdAt: item.createdAt,
    });
  }
  return [...latest.values()].sort((left, right) => left.eventSequence - right.eventSequence);
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
  const modelProvider = typeof row.model_provider === "string" ? row.model_provider : undefined;
  const modelId = typeof row.model_id === "string" ? row.model_id : undefined;
  return {
    id: text(row, "id"),
    taskId: text(row, "task_id"),
    ...(teamRunId ? { teamRunId } : {}),
    sessionId: text(row, "session_id"),
    profileId: text(row, "profile_id"),
    profileSnapshot: JSON.parse(text(row, "profile_snapshot_json")),
    role: text(row, "role"),
    ...(modelProvider ? { modelProvider } : {}),
    ...(modelId ? { modelId } : {}),
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

function promptReceiptSources(value: unknown): {
  sourceReceipts: DCodePromptSourceReceipt[];
  importedHistoryReceipt?: ImportedSessionHistoryReceipt;
} {
  if (Array.isArray(value)) {
    return { sourceReceipts: normalizeDCodePromptSourceReceipts(value) };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DCodePromptSourceReceiptError("Prompt Receipt sources are invalid");
  }
  const payload = value as {
    version?: unknown;
    documentSources?: unknown;
    importedHistory?: unknown;
  };
  if (payload.version !== 2) {
    throw new DCodePromptSourceReceiptError("Prompt Receipt sources have an unsupported version");
  }
  return {
    sourceReceipts: normalizeDCodePromptSourceReceipts(payload.documentSources),
    ...(payload.importedHistory === undefined
      ? {}
      : { importedHistoryReceipt: normalizeImportedSessionHistoryReceipt(payload.importedHistory) }),
  };
}

function promptReceipt(row: SQLiteRow): PromptReceiptRecord {
  let sources: {
    sourceReceipts: DCodePromptSourceReceipt[];
    importedHistoryReceipt?: ImportedSessionHistoryReceipt;
  };
  try {
    sources = promptReceiptSources(JSON.parse(text(row, "source_receipts_json")));
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
    sourceReceipts: sources.sourceReceipts,
    ...(sources.importedHistoryReceipt ? { importedHistoryReceipt: sources.importedHistoryReceipt } : {}),
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

interface ManagedWorkerWorktreeMetadata {
  version: 1;
  state: ManagedWorkerWorktreeRecord["state"];
  teamRunId: string;
  agentRunId: string;
  projectId: string;
  workspaceId: string;
  sourceProjectDirectory: string;
  repositoryRoot: string;
  commonGitDirectory: string;
  baseCommit: string;
  projectRelativePath: string;
  workspaceCwd: string;
  provisionAttemptId: string;
  failureCode?: string;
}

function managedWorkerWorktree(artifactRecord: ArtifactRecord): ManagedWorkerWorktreeRecord {
  const metadata = artifactRecord.metadata;
  if (
    artifactRecord.kind !== MANAGED_WORKER_WORKTREE_ARTIFACT_KIND
    || !artifactRecord.agentRunId
    || !artifactRecord.managedPath
    || typeof metadata !== "object"
    || metadata === null
    || Array.isArray(metadata)
  ) {
    throw new ProductStoreError("PRODUCT_STORE_CORRUPT", "Managed Worker worktree Artifact is incomplete", {
      artifactId: artifactRecord.id,
    });
  }
  const value = metadata as Record<string, unknown>;
  const read = (key: keyof ManagedWorkerWorktreeMetadata, maximum = 4_096): string => (
    requiredString(value[key], `managedWorktree.${key}`, maximum)
  );
  const state = value.state;
  if (value.version !== 1 || !["preparing", "ready", "failed", "unknown"].includes(String(state))) {
    throw new ProductStoreError("PRODUCT_STORE_CORRUPT", "Managed Worker worktree Artifact metadata is invalid", {
      artifactId: artifactRecord.id,
    });
  }
  const projectRelativePath = value.projectRelativePath;
  if (typeof projectRelativePath !== "string" || projectRelativePath.length > 4_096) {
    throw new ProductStoreError("PRODUCT_STORE_CORRUPT", "Managed Worker worktree relative path is invalid", {
      artifactId: artifactRecord.id,
    });
  }
  const baseCommit = read("baseCommit", 64);
  if (!/^[0-9a-f]{40,64}$/i.test(baseCommit)) {
    throw new ProductStoreError("PRODUCT_STORE_CORRUPT", "Managed Worker worktree base commit is invalid", {
      artifactId: artifactRecord.id,
    });
  }
  if (artifactRecord.agentRunId !== read("agentRunId", 200)) {
    throw new ProductStoreError("PRODUCT_STORE_CORRUPT", "Managed Worker worktree Agent Run identity is invalid", {
      artifactId: artifactRecord.id,
    });
  }
  return {
    artifactId: artifactRecord.id,
    taskId: artifactRecord.taskId,
    teamRunId: read("teamRunId", 200),
    agentRunId: artifactRecord.agentRunId,
    projectId: read("projectId", 200),
    workspaceId: read("workspaceId", 200),
    managedPath: artifactRecord.managedPath,
    workspaceCwd: read("workspaceCwd"),
    sourceProjectDirectory: read("sourceProjectDirectory"),
    repositoryRoot: read("repositoryRoot"),
    commonGitDirectory: read("commonGitDirectory"),
    baseCommit,
    projectRelativePath,
    provisionAttemptId: read("provisionAttemptId", 200),
    state: state as ManagedWorkerWorktreeRecord["state"],
    ...(typeof value.failureCode === "string" ? { failureCode: value.failureCode } : {}),
    revision: artifactRecord.revision,
  };
}

function markPreparingManagedWorkerWorktreesUnknown(
  database: DatabaseSync,
  now: string,
  failureCode: string,
  teamRunId?: string,
): number {
  const rows = database.prepare(`
    SELECT * FROM artifacts
    WHERE kind = ? ${teamRunId ? "AND task_id IN (SELECT task_id FROM team_runs WHERE id = ?)" : ""}
  `).all(
    ...(teamRunId ? [MANAGED_WORKER_WORKTREE_ARTIFACT_KIND, teamRunId] : [MANAGED_WORKER_WORKTREE_ARTIFACT_KIND]),
  ) as SQLiteRow[];
  let changed = 0;
  const attemptStatus = database.prepare("SELECT status FROM operation_attempts WHERE id = ?");
  const updateArtifact = database.prepare(`
    UPDATE artifacts
    SET metadata_json = ?, revision = ?, updated_at = ?
    WHERE id = ? AND revision = ?
  `);
  for (const row of rows) {
    const current = managedWorkerWorktree(artifact(row));
    if (teamRunId !== undefined && current.teamRunId !== teamRunId) continue;
    const attempt = attemptStatus.get(current.provisionAttemptId) as { status?: unknown } | undefined;
    if (current.state !== "preparing" || attempt?.status !== "prepared") continue;
    const metadata: ManagedWorkerWorktreeMetadata = {
      version: 1,
      state: "unknown",
      teamRunId: current.teamRunId,
      agentRunId: current.agentRunId,
      projectId: current.projectId,
      workspaceId: current.workspaceId,
      sourceProjectDirectory: current.sourceProjectDirectory,
      repositoryRoot: current.repositoryRoot,
      commonGitDirectory: current.commonGitDirectory,
      baseCommit: current.baseCommit,
      projectRelativePath: current.projectRelativePath,
      workspaceCwd: current.workspaceCwd,
      provisionAttemptId: current.provisionAttemptId,
      failureCode,
    };
    updateArtifact.run(canonicalJSON(metadata), current.revision + 1, now, current.artifactId, current.revision);
    changed += 1;
  }
  return changed;
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
      const now = options.now ?? (() => new Date().toISOString());
      await initializeProductStoreAtomically(layout, {
        userId: `user-${randomUUID()}`,
        userHome,
      }, now(), migrationPlan);
      await assertSafeProductStoreTarget(layout.productStorePath);
      database = new DatabaseSync(layout.productStorePath);
      await migrateProductStoreSchemaIfNeeded(database, layout, now());
      validateProductStoreSchema(database);
      configureWritableProductStore(database);
      await chmod(layout.productStorePath, 0o600);
      const store = new ProductStore(
        layout,
        database,
        lease,
        now,
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
      const unknownManagedWorktrees = markPreparingManagedWorkerWorktreesUnknown(
        this.database,
        now,
        "RUNTIME_INTERRUPTED",
      );
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
          unknownManagedWorktrees,
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

  runtimeModelSelection(): RuntimeModelSelectionRecord | undefined {
    this.assertOpen();
    const stored = this.database.prepare(`
      SELECT * FROM product_settings WHERE key = 'runtime.modelSelection'
    `).get() as SQLiteRow | undefined;
    const parseStoredSelection = (row: SQLiteRow, sourceKind: RuntimeModelSelectionRecord["sourceKind"]): RuntimeModelSelectionRecord => {
      let value: unknown;
      try {
        value = JSON.parse(text(row, "value_json"));
      } catch (error) {
        throw new ProductStoreError("PRODUCT_STORE_CORRUPT", "Runtime Model Selection is not valid JSON", {
          cause: error instanceof Error ? error.message : String(error),
        });
      }
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new ProductStoreError("PRODUCT_STORE_CORRUPT", "Runtime Model Selection is invalid");
      }
      const providerId = (value as { providerId?: unknown }).providerId;
      const modelId = (value as { modelId?: unknown }).modelId;
      if (
        typeof providerId !== "string" || providerId.trim().length === 0 || providerId.length > 200
        || typeof modelId !== "string" || modelId.trim().length === 0 || modelId.length > 200
      ) {
        throw new ProductStoreError("PRODUCT_STORE_CORRUPT", "Runtime Model Selection is incomplete");
      }
      return { providerId, modelId, sourceKind, revision: integer(row, "revision") };
    };
    if (stored) {
      const sourceKind = text(stored, "source_kind");
      if (sourceKind !== "legacy_pi_settings" && sourceKind !== "user") {
        throw new ProductStoreError("PRODUCT_STORE_CORRUPT", "Runtime Model Selection has an invalid source kind");
      }
      return parseStoredSelection(stored, sourceKind);
    }

    const legacyRows = this.database.prepare(`
      SELECT * FROM product_settings
      WHERE key IN ('runtime.defaultProvider', 'runtime.defaultModel')
    `).all() as SQLiteRow[];
    const legacy = new Map(legacyRows.map((row) => [text(row, "key"), row]));
    const provider = legacy.get("runtime.defaultProvider");
    const model = legacy.get("runtime.defaultModel");
    if (!provider && !model) return undefined;
    if (!provider || !model) {
      throw new ProductStoreError("PRODUCT_STORE_CORRUPT", "Legacy Runtime Model Selection is incomplete");
    }
    let providerId: unknown;
    let modelId: unknown;
    try {
      providerId = JSON.parse(text(provider, "value_json"));
      modelId = JSON.parse(text(model, "value_json"));
    } catch (error) {
      throw new ProductStoreError("PRODUCT_STORE_CORRUPT", "Legacy Runtime Model Selection is not valid JSON", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    if (
      typeof providerId !== "string" || providerId.trim().length === 0 || providerId.length > 200
      || typeof modelId !== "string" || modelId.trim().length === 0 || modelId.length > 200
    ) {
      throw new ProductStoreError("PRODUCT_STORE_CORRUPT", "Legacy Runtime Model Selection is invalid");
    }
    return {
      providerId,
      modelId,
      sourceKind: "legacy_pi_settings",
      revision: Math.max(integer(provider, "revision"), integer(model, "revision")),
    };
  }

  taskWorkbenchViewState(): TaskWorkbenchViewStateRecord {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT * FROM product_settings WHERE key = 'workbench.taskViewState'
    `).get() as SQLiteRow | undefined;
    if (!row) {
      return {
        version: 1,
        selection: { taskId: null, sessionId: null },
        expandedHudSections: DEFAULT_TASK_WORKBENCH_HUD_SECTIONS,
        inspectorTarget: null,
        revision: 0,
      };
    }
    const sourceKind = text(row, "source_kind");
    if (sourceKind !== "legacy_user_defaults" && sourceKind !== "user") {
      throw new ProductStoreError("PRODUCT_STORE_CORRUPT", "Task Workbench View State has an invalid source kind");
    }
    let value: unknown;
    try {
      value = JSON.parse(text(row, "value_json"));
    } catch (error) {
      throw new ProductStoreError(
        "PRODUCT_STORE_CORRUPT",
        "Task Workbench View State is invalid JSON",
        { cause: error instanceof Error ? error.message : String(error) },
      );
    }
    try {
      return normalizedTaskWorkbenchViewState(value, integer(row, "revision"));
    } catch (error) {
      if (error instanceof ProductStoreError) {
        throw new ProductStoreError("PRODUCT_STORE_CORRUPT", error.message, error.details);
      }
      throw error;
    }
  }

  async patchTaskWorkbenchViewState(input: {
    requestId: string;
    expectedStoreRevision: number;
    expectedViewStateRevision: number;
    patch: TaskWorkbenchViewStatePatch;
  }): Promise<{ storeRevision: number; taskWorkbenchViewState: TaskWorkbenchViewStateRecord }> {
    const patch = normalizedTaskWorkbenchViewStatePatch(input.patch);
    return await this.mutate(
      "taskWorkbenchViewState.patch",
      input.requestId,
      input.expectedStoreRevision,
      { expectedViewStateRevision: input.expectedViewStateRevision, patch },
      (_storeRevision, now) => {
        const current = this.taskWorkbenchViewState();
        if (current.revision !== requiredRevision(input.expectedViewStateRevision, "expectedViewStateRevision")) {
          throw new ProductStoreError(
            "REVISION_CONFLICT",
            "The Task Workbench View State changed before this patch could be applied",
            { expectedViewStateRevision: input.expectedViewStateRevision, currentViewStateRevision: current.revision },
          );
        }
        const state: TaskWorkbenchViewStateRecord = {
          version: 1,
          selection: patch.selection ?? current.selection,
          expandedHudSections: patch.expandedHudSections ?? current.expandedHudSections,
          inspectorTarget: patch.inspectorTarget === undefined ? current.inspectorTarget : patch.inspectorTarget,
          revision: current.revision,
        };
        this.validateTaskWorkbenchViewStateReferences(state);
        const existing = this.database.prepare(`
          SELECT revision FROM product_settings WHERE key = 'workbench.taskViewState'
        `).get() as SQLiteRow | undefined;
        const revision = existing ? integer(existing, "revision") + 1 : 1;
        this.database.prepare(`
          INSERT INTO product_settings(key, value_json, source_kind, revision, created_at, updated_at)
          VALUES ('workbench.taskViewState', ?, 'user', ?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET
            value_json = excluded.value_json,
            source_kind = 'user',
            revision = excluded.revision,
            updated_at = excluded.updated_at
        `).run(canonicalJSON({
          version: 1,
          selection: state.selection,
          expandedHudSections: state.expandedHudSections,
          inspectorTarget: state.inspectorTarget,
        }), revision, now, now);
        const taskWorkbenchViewState: TaskWorkbenchViewStateRecord = { ...state, revision };
        return {
          value: { taskWorkbenchViewState },
          event: {
            kind: "taskWorkbenchViewState.updated",
            entityKind: "taskWorkbenchViewState",
            entityId: "workbench.taskViewState",
            payload: { taskWorkbenchViewState },
          },
        };
      },
    );
  }

  async setDCodeSessionComposerDraft(input: {
    requestId: string;
    expectedStoreRevision: number;
    taskId: string;
    sessionId: string;
    text: string;
  }): Promise<{ storeRevision: number; composerDraft?: ComposerDraftRecord }> {
    const taskId = requiredString(input.taskId, "taskId", 200);
    const sessionId = requiredString(input.sessionId, "sessionId", 200);
    if (typeof input.text !== "string" || input.text.length > 200_000) {
      throw new ProductStoreError("INVALID_ARGUMENT", "D Code Session Composer Draft text must be a string up to 200000 characters");
    }
    if (redactCredentialText(input.text).redacted) {
      throw new ProductStoreError("CREDENTIAL_MATERIAL_REJECTED", "D Code Session Composer Draft contains credential material");
    }
    const textValue = input.text;
    return await this.mutate<{ composerDraft?: ComposerDraftRecord }>(
      "dcodeSession.composerDraft.set",
      input.requestId,
      input.expectedStoreRevision,
      { taskId, sessionId, text: textValue },
      (_storeRevision, now) => {
        const sessionRow = this.database.prepare(`
          SELECT id FROM sessions WHERE id = ? AND task_id = ?
        `).get(sessionId, taskId) as SQLiteRow | undefined;
        if (!sessionRow) {
          throw new ProductStoreError("NOT_FOUND", "D Code Session Composer Draft target does not exist", { taskId, sessionId });
        }
        const existing = this.database.prepare(`
          SELECT * FROM composer_drafts
          WHERE session_id = ? AND draft_kind = 'session_path'
          ORDER BY updated_at DESC, id DESC LIMIT 1
        `).get(sessionId) as SQLiteRow | undefined;
        if (textValue.length === 0) {
          if (existing) {
            this.database.prepare("DELETE FROM composer_drafts WHERE id = ?").run(text(existing, "id"));
          }
          return {
            value: {},
            event: {
              kind: "dcodeSession.composerDraft.cleared",
              entityKind: "composerDraft",
              entityId: existing ? text(existing, "id") : `composer-draft:${sessionId}`,
              taskId,
              payload: { sessionId },
            },
          };
        }
        const id = existing ? text(existing, "id") : `composer-draft:${sessionId}`;
        const revision = existing ? integer(existing, "revision") + 1 : 1;
        if (existing) {
          this.database.prepare(`
            UPDATE composer_drafts
            SET task_id = ?, text = ?, payload_json = ?, revision = ?, updated_at = ?
            WHERE id = ? AND revision = ?
          `).run(taskId, textValue, canonicalJSON({ source: "dcode_task_workbench" }), revision, now, id, integer(existing, "revision"));
        } else {
          this.database.prepare(`
            INSERT INTO composer_drafts(
              id, task_id, session_id, draft_kind, text, payload_json,
              source_ordinal, revision, created_at, updated_at
            ) VALUES (?, ?, ?, 'session_path', ?, ?, NULL, 1, ?, ?)
          `).run(id, taskId, sessionId, textValue, canonicalJSON({ source: "dcode_task_workbench" }), now, now);
        }
        const composerDraft: ComposerDraftRecord = {
          id,
          taskId,
          sessionId,
          draftKind: "session_path",
          text: textValue,
          revision,
          createdAt: existing ? text(existing, "created_at") : now,
          updatedAt: now,
        };
        return {
          value: { composerDraft },
          event: {
            kind: "dcodeSession.composerDraft.saved",
            entityKind: "composerDraft",
            entityId: id,
            taskId,
            payload: {
              composerDraft: {
                id,
                taskId,
                sessionId,
                draftKind: composerDraft.draftKind,
                revision,
                createdAt: composerDraft.createdAt,
                updatedAt: now,
                textBytes: Buffer.byteLength(textValue, "utf8"),
              },
            },
          },
        };
      },
    );
  }

  async seedRuntimeModelCatalog(input: {
    requestId: string;
    providers: RuntimeModelCatalogProviderInput[];
    defaultSelection?: { providerId: string; modelId: string };
  }): Promise<{ storeRevision: number; runtimeModelSelection?: RuntimeModelSelectionRecord }> {
    if (!Array.isArray(input.providers) || input.providers.length === 0 || input.providers.length > 128) {
      throw new ProductStoreError("INVALID_ARGUMENT", "Runtime Model Catalog must contain 1…128 Providers");
    }
    const providers = input.providers.map((provider, providerIndex) => {
      const id = requiredCredentialFreeString(provider.id, `providers[${providerIndex}].id`, 200);
      const name = requiredCredentialFreeString(provider.name, `providers[${providerIndex}].name`, 200);
      const baseUrl = provider.baseUrl === undefined
        ? undefined
        : requiredCredentialFreeString(provider.baseUrl, `providers[${providerIndex}].baseUrl`, 4_096);
      const apiKind = provider.apiKind === undefined
        ? undefined
        : requiredCredentialFreeString(provider.apiKind, `providers[${providerIndex}].apiKind`, 200);
      const authMode = provider.authMode === undefined
        ? undefined
        : requiredCredentialFreeString(provider.authMode, `providers[${providerIndex}].authMode`, 200);
      const locator = requiredCredentialFreeString(provider.credential?.locator, `providers[${providerIndex}].credential.locator`, 4_096);
      if (typeof provider.credential?.configured !== "boolean") {
        throw new ProductStoreError("INVALID_ARGUMENT", `providers[${providerIndex}].credential.configured is invalid`);
      }
      const sourceDigest = provider.credential.sourceDigest;
      if (sourceDigest !== undefined && !/^sha256:[a-f0-9]{64}$/.test(sourceDigest)) {
        throw new ProductStoreError("INVALID_ARGUMENT", `providers[${providerIndex}].credential.sourceDigest is invalid`);
      }
      const nonsecret = stableValue(provider.nonsecret ?? {});
      assertCredentialFreeValue(nonsecret, `providers[${providerIndex}].nonsecret`);
      if (!Array.isArray(provider.models) || provider.models.length === 0 || provider.models.length > 2_048) {
        throw new ProductStoreError("INVALID_ARGUMENT", `providers[${providerIndex}].models must contain 1…2048 Models`);
      }
      const seenModelIds = new Set<string>();
      const models = provider.models.map((model, modelIndex) => {
        const modelId = requiredCredentialFreeString(model.modelId, `providers[${providerIndex}].models[${modelIndex}].modelId`, 200);
        if (seenModelIds.has(modelId)) {
          throw new ProductStoreError("INVALID_ARGUMENT", `providers[${providerIndex}].models contains duplicate modelId`);
        }
        seenModelIds.add(modelId);
        const modelName = requiredCredentialFreeString(model.name, `providers[${providerIndex}].models[${modelIndex}].name`, 200);
        for (const [field, value] of [["contextWindow", model.contextWindow], ["maxTokens", model.maxTokens]] as const) {
          if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
            throw new ProductStoreError("INVALID_ARGUMENT", `providers[${providerIndex}].models[${modelIndex}].${field} is invalid`);
          }
        }
        if (typeof model.reasoning !== "boolean") {
          throw new ProductStoreError("INVALID_ARGUMENT", `providers[${providerIndex}].models[${modelIndex}].reasoning is invalid`);
        }
        const modelNonsecret = stableValue(model.nonsecret ?? {});
        assertCredentialFreeValue(modelNonsecret, `providers[${providerIndex}].models[${modelIndex}].nonsecret`);
        return {
          modelId,
          name: modelName,
          ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
          ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
          reasoning: model.reasoning,
          nonsecret: modelNonsecret,
        };
      });
      return {
        id,
        name,
        ...(baseUrl ? { baseUrl } : {}),
        ...(apiKind ? { apiKind } : {}),
        ...(authMode ? { authMode } : {}),
        nonsecret,
        credential: {
          locator,
          configured: provider.credential.configured,
          ...(sourceDigest ? { sourceDigest } : {}),
        },
        models,
      };
    });
    const providerIds = new Set<string>();
    for (const provider of providers) {
      if (providerIds.has(provider.id)) throw new ProductStoreError("INVALID_ARGUMENT", "Runtime Model Catalog has duplicate Provider ids");
      providerIds.add(provider.id);
    }
    const defaultSelection = input.defaultSelection === undefined
      ? undefined
      : {
        providerId: requiredCredentialFreeString(input.defaultSelection.providerId, "defaultSelection.providerId", 200),
        modelId: requiredCredentialFreeString(input.defaultSelection.modelId, "defaultSelection.modelId", 200),
      };
    if (defaultSelection && !providers.some((provider) => (
      provider.id === defaultSelection.providerId
      && provider.models.some((model) => model.modelId === defaultSelection.modelId)
    ))) {
      throw new ProductStoreError("INVALID_ARGUMENT", "Runtime Model Catalog defaultSelection is not part of the supplied Catalog");
    }
    return await this.mutate(
      "runtimeModelCatalog.seed",
      input.requestId,
      undefined,
      { providers, ...(defaultSelection ? { defaultSelection } : {}) },
      (_storeRevision, now) => {
        const upsertProvider = this.database.prepare(`
          INSERT INTO model_providers(
            id, name, base_url, api_kind, auth_mode, nonsecret_json,
            revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            base_url = excluded.base_url,
            api_kind = excluded.api_kind,
            auth_mode = excluded.auth_mode,
            nonsecret_json = excluded.nonsecret_json,
            revision = model_providers.revision + 1,
            updated_at = excluded.updated_at
        `);
        const upsertModel = this.database.prepare(`
          INSERT INTO model_catalog_entries(
            id, provider_id, model_id, name, context_window, max_tokens,
            reasoning, nonsecret_json, revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
          ON CONFLICT(provider_id, model_id) DO UPDATE SET
            name = excluded.name,
            context_window = excluded.context_window,
            max_tokens = excluded.max_tokens,
            reasoning = excluded.reasoning,
            nonsecret_json = excluded.nonsecret_json,
            revision = model_catalog_entries.revision + 1,
            updated_at = excluded.updated_at
        `);
        const existingCredential = this.database.prepare(`
          SELECT id, revision FROM credential_references
          WHERE provider_id = ? AND reference_kind = 'external_auth_bridge'
          ORDER BY created_at, id LIMIT 1
        `);
        const insertCredential = this.database.prepare(`
          INSERT INTO credential_references(
            id, provider_id, reference_kind, locator, configured,
            source_digest, revision, created_at, updated_at
          ) VALUES (?, ?, 'external_auth_bridge', ?, ?, ?, 1, ?, ?)
        `);
        const updateCredential = this.database.prepare(`
          UPDATE credential_references
          SET locator = ?, configured = ?, source_digest = ?, revision = ?, updated_at = ?
          WHERE id = ?
        `);
        for (const provider of providers) {
          upsertProvider.run(
            provider.id,
            provider.name,
            provider.baseUrl ?? null,
            provider.apiKind ?? null,
            provider.authMode ?? null,
            canonicalJSON(provider.nonsecret),
            now,
            now,
          );
          for (const model of provider.models) {
            upsertModel.run(
              `model-${createHash("sha256").update(`${provider.id}\0${model.modelId}`).digest("hex").slice(0, 32)}`,
              provider.id,
              model.modelId,
              model.name,
              model.contextWindow ?? null,
              model.maxTokens ?? null,
              model.reasoning ? 1 : 0,
              canonicalJSON(model.nonsecret),
              now,
              now,
            );
          }
          const credential = existingCredential.get(provider.id) as SQLiteRow | undefined;
          if (credential) {
            updateCredential.run(
              provider.credential.locator,
              provider.credential.configured ? 1 : 0,
              provider.credential.sourceDigest ?? null,
              integer(credential, "revision") + 1,
              now,
              text(credential, "id"),
            );
          } else {
            insertCredential.run(
              `credential-${createHash("sha256").update(provider.id).digest("hex").slice(0, 32)}`,
              provider.id,
              provider.credential.locator,
              provider.credential.configured ? 1 : 0,
              provider.credential.sourceDigest ?? null,
              now,
              now,
            );
          }
        }
        let runtimeModelSelection = this.runtimeModelSelection();
        if (!runtimeModelSelection && defaultSelection) {
          this.database.prepare(`
            INSERT INTO product_settings(key, value_json, source_kind, revision, created_at, updated_at)
            VALUES ('runtime.modelSelection', ?, 'legacy_pi_settings', 1, ?, ?)
          `).run(canonicalJSON(defaultSelection), now, now);
          runtimeModelSelection = {
            ...defaultSelection,
            sourceKind: "legacy_pi_settings",
            revision: 1,
          };
        }
        return {
          value: { ...(runtimeModelSelection ? { runtimeModelSelection } : {}) },
          event: {
            kind: "runtimeModelCatalog.seeded",
            entityKind: "runtimeModelCatalog",
            entityId: "runtime.modelCatalog",
            payload: { providerCount: providers.length, ...(runtimeModelSelection ? { runtimeModelSelection } : {}) },
          },
        };
      },
    );
  }

  async setRuntimeModelSelection(input: {
    requestId: string;
    expectedStoreRevision: number;
    providerId: string;
    modelId: string;
  }): Promise<{ storeRevision: number; runtimeModelSelection: RuntimeModelSelectionRecord }> {
    const providerId = requiredCredentialFreeString(input.providerId, "providerId", 200);
    const modelId = requiredCredentialFreeString(input.modelId, "modelId", 200);
    return await this.mutate(
      "runtimeModelSelection.set",
      input.requestId,
      input.expectedStoreRevision,
      { providerId, modelId },
      (_storeRevision, now) => {
        const catalogEntry = this.database.prepare(`
          SELECT id FROM model_catalog_entries WHERE provider_id = ? AND model_id = ?
        `).get(providerId, modelId) as SQLiteRow | undefined;
        if (!catalogEntry) {
          throw new ProductStoreError(
            "NOT_FOUND",
            "D Code Model Catalog does not contain this Provider / Model pair",
            { providerId, modelId },
          );
        }
        const existing = this.database.prepare(`
          SELECT revision FROM product_settings WHERE key = 'runtime.modelSelection'
        `).get() as SQLiteRow | undefined;
        const revision = existing ? integer(existing, "revision") + 1 : 1;
        this.database.prepare(`
          INSERT INTO product_settings(key, value_json, source_kind, revision, created_at, updated_at)
          VALUES ('runtime.modelSelection', ?, 'user', ?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET
            value_json = excluded.value_json,
            source_kind = 'user',
            revision = excluded.revision,
            updated_at = excluded.updated_at
        `).run(canonicalJSON({ providerId, modelId }), revision, now, now);
        const runtimeModelSelection: RuntimeModelSelectionRecord = {
          providerId,
          modelId,
          sourceKind: "user",
          revision,
        };
        return {
          value: { runtimeModelSelection },
          event: {
            kind: "runtimeModelSelection.updated",
            entityKind: "runtimeModelSelection",
            entityId: "runtime.modelSelection",
            payload: { runtimeModelSelection },
          },
        };
      },
    );
  }

  async snapshot(afterEventSequence = 0): Promise<FoundationSnapshot> {
    this.assertOpen();
    requiredRevision(afterEventSequence, "afterEventSequence");
    const artifacts = (
      this.database.prepare("SELECT * FROM artifacts ORDER BY created_at, id").all() as SQLiteRow[]
    ).map(artifact);
    const managedWorkerWorktrees = artifacts
      .filter((item) => item.kind === MANAGED_WORKER_WORKTREE_ARTIFACT_KIND)
      .map(managedWorkerWorktree);
    const teamFailures = teamFailuresFromEvents((
      this.database.prepare(`
        SELECT * FROM store_events
        WHERE kind IN ('teamRun.failed', 'teamRun.aborted')
        ORDER BY sequence
      `).all() as SQLiteRow[]
    ).map(event));
    const taskContextSources = (
      this.database.prepare("SELECT * FROM task_context_sources ORDER BY task_id, ordinal").all() as SQLiteRow[]
    ).map(taskContextSource);
    const taskContextSourcesByTask = new Map<string, TaskContextSourceRecord[]>();
    for (const source of taskContextSources) {
      const sources = taskContextSourcesByTask.get(source.taskId) ?? [];
      sources.push(source);
      taskContextSourcesByTask.set(source.taskId, sources);
    }
    const taskContextSets = (
      this.database.prepare("SELECT * FROM task_context_sets ORDER BY task_id").all() as SQLiteRow[]
    ).map((row) => taskContextSet(row, taskContextSourcesByTask.get(text(row, "task_id")) ?? []));
    const runtimeModelSelection = this.runtimeModelSelection();
    const taskWorkbenchViewState = this.taskWorkbenchViewState();
    return {
      schemaVersion: PRODUCT_STORE_SCHEMA_VERSION,
      storeRevision: this.metaInteger("store_revision"),
      dataRoot: this.layout.root,
      currentUser: this.currentUser(),
      projects: (this.database.prepare("SELECT * FROM projects ORDER BY created_at, id").all() as SQLiteRow[]).map(project),
      modelProviders: (
        this.database.prepare("SELECT * FROM model_providers ORDER BY name, id").all() as SQLiteRow[]
      ).map(modelProvider),
      modelCatalogEntries: (
        this.database.prepare("SELECT * FROM model_catalog_entries ORDER BY provider_id, name, model_id").all() as SQLiteRow[]
      ).map(modelCatalogEntry),
      credentialReferences: (
        this.database.prepare("SELECT * FROM credential_references ORDER BY provider_id, id").all() as SQLiteRow[]
      ).map(credentialReference),
      ...(runtimeModelSelection ? { runtimeModelSelection } : {}),
      taskWorkbenchViewState,
      agentProfiles: (this.database.prepare("SELECT * FROM agent_profiles ORDER BY builtin DESC, role, id").all() as SQLiteRow[]).map(agentProfile),
      tasks: (this.database.prepare("SELECT * FROM tasks ORDER BY created_at, id").all() as SQLiteRow[]).map(task),
      taskContextSets,
      taskPlans: (
        this.database.prepare("SELECT * FROM task_plans ORDER BY task_id, created_at, rowid").all() as SQLiteRow[]
      ).map(taskPlan),
      taskWorkItems: (
        this.database.prepare("SELECT * FROM task_work_items ORDER BY task_id, ordinal, id").all() as SQLiteRow[]
      ).map(taskWorkItem),
      composerDrafts: (
        this.database.prepare("SELECT * FROM composer_drafts ORDER BY updated_at, id").all() as SQLiteRow[]
      ).map(composerDraft),
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
      sessionRuntimeBindings: (
        this.database.prepare("SELECT * FROM session_runtime_bindings ORDER BY session_id").all() as SQLiteRow[]
      ).map(sessionRuntimeBinding),
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
      teamFailures,
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
      artifacts,
      managedWorkerWorktrees,
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

  async importedSessionHistoryProjection(
    sessionIdValue: string,
  ): Promise<ImportedSessionHistoryProjection | undefined> {
    this.assertOpen();
    const sessionId = requiredString(sessionIdValue, "sessionId", 200);
    const provenance = this.database.prepare(`
      SELECT * FROM session_provenance
      WHERE session_id = ?
    `).get(sessionId) as SQLiteRow | undefined;
    if (!provenance || text(provenance, "source_kind") !== "pi_import") return undefined;

    const importSource = this.database.prepare(`
      SELECT * FROM pi_import_sources
      WHERE session_id = ? AND state = 'completed'
    `).get(sessionId) as SQLiteRow | undefined;
    if (!importSource) {
      throw new ProductStoreError(
        "PRODUCT_STORE_CORRUPT",
        "Pi-imported Session has no completed import provenance",
        { sessionId },
      );
    }
    if (
      text(importSource, "source_session_id") !== text(provenance, "source_session_id")
      || text(importSource, "source_digest") !== text(provenance, "source_digest")
    ) {
      throw new ProductStoreError(
        "PRODUCT_STORE_CORRUPT",
        "Pi-imported Session provenance does not match its import source",
        { sessionId },
      );
    }
    const currentPath = this.database.prepare(`
      SELECT id, source_path_id FROM session_paths
      WHERE session_id = ? AND is_current = 1
    `).get(sessionId) as SQLiteRow | undefined;
    if (!currentPath) {
      throw new ProductStoreError(
        "PRODUCT_STORE_CORRUPT",
        "Pi-imported Session has no current Session Path",
        { sessionId },
      );
    }
    if (typeof currentPath.source_path_id !== "string" || currentPath.source_path_id.length === 0) {
      throw new ProductStoreError(
        "PRODUCT_STORE_CORRUPT",
        "Pi-imported Session current path has no Pi source path identity",
        { sessionId },
      );
    }

    let provenanceDetails: unknown;
    try {
      provenanceDetails = JSON.parse(text(provenance, "details_json"));
    } catch (error) {
      throw new ProductStoreError(
        "PRODUCT_STORE_CORRUPT",
        "Pi-imported Session provenance details are invalid",
        { sessionId, cause: error instanceof Error ? error.message : String(error) },
      );
    }
    const entries = (
      this.database.prepare(`
        SELECT e.*
        FROM session_path_entries p
        JOIN session_entries e ON e.id = p.entry_id
        WHERE p.path_id = ?
          AND e.source_kind = 'pi_import'
          AND e.message_role IN ('user', 'assistant')
        ORDER BY p.ordinal, e.id
      `).all(text(currentPath, "id")) as SQLiteRow[]
    ).map(sessionEntry);
    return projectImportedSessionHistory({
      dcodeSessionId: sessionId,
      sourceSessionId: text(importSource, "source_session_id"),
      sourceDigest: text(importSource, "source_digest"),
      importerVersion: integer(importSource, "importer_version"),
      sourcePathId: text(currentPath, "source_path_id"),
      redactedAtImport: importedHistoryWasRedactedAtImport(provenanceDetails),
      entries: entries.map((entry) => ({
        id: entry.id,
        ...(entry.sourceEntryId ? { sourceEntryId: entry.sourceEntryId } : {}),
        messageRole: entry.messageRole as "user" | "assistant",
        content: entry.content,
      })),
    });
  }

  private validateTaskWorkbenchViewStateReferences(state: TaskWorkbenchViewStateRecord): void {
    const { taskId, sessionId } = state.selection;
    if (taskId === null || sessionId === null) {
      if (state.inspectorTarget !== null) {
        throw new ProductStoreError(
          "INVALID_ARGUMENT",
          "Task Workbench inspectorTarget requires an active Task selection",
        );
      }
      return;
    }
    const taskRow = this.database.prepare("SELECT id FROM tasks WHERE id = ?").get(taskId) as SQLiteRow | undefined;
    if (!taskRow) throw new ProductStoreError("NOT_FOUND", "Task Workbench selected Task does not exist", { taskId });
    const sessionRow = this.database.prepare(`
      SELECT id FROM sessions WHERE id = ? AND task_id = ?
    `).get(sessionId, taskId) as SQLiteRow | undefined;
    if (!sessionRow) {
      throw new ProductStoreError(
        "INVALID_ARGUMENT",
        "Task Workbench selected Session does not belong to its selected Task",
        { taskId, sessionId },
      );
    }
    const target = state.inspectorTarget;
    if (!target) return;
    const table = target.kind === "artifact"
      ? "artifacts"
      : target.kind === "evidence"
        ? "evidence_records"
        : target.kind === "report"
          ? "agent_reports"
          : "task_context_sources";
    const targetRow = this.database.prepare(`
      SELECT id FROM ${table} WHERE id = ? AND task_id = ?
    `).get(target.id, taskId) as SQLiteRow | undefined;
    if (!targetRow) {
      throw new ProductStoreError(
        "INVALID_ARGUMENT",
        "Task Workbench inspectorTarget does not belong to its selected Task",
        { taskId, inspectorTarget: target },
      );
    }
  }

  private taskForScope(taskId: string, scope: TaskScope): TaskRecord {
    const row = this.database.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as SQLiteRow | undefined;
    if (!row) throw new ProductStoreError("NOT_FOUND", "Task does not exist", { taskId });
    const record = task(row);
    if (JSON.stringify(record.scope) !== JSON.stringify(scope)) {
      throw new ProductStoreError("REVISION_CONFLICT", "Task Scope changed before this mutation", { taskId });
    }
    return record;
  }

  private validateWorkItemOwner(taskId: string, ownerAssignmentId?: string | null): string | null {
    if (ownerAssignmentId === undefined || ownerAssignmentId === null) return null;
    const id = requiredString(ownerAssignmentId, "ownerAssignmentId", 200);
    const assignment = this.database.prepare(`
      SELECT id FROM agent_assignments WHERE id = ? AND task_id = ?
    `).get(id, taskId) as SQLiteRow | undefined;
    if (!assignment) {
      throw new ProductStoreError("NOT_FOUND", "Work Item owner assignment does not belong to its Task", { taskId, ownerAssignmentId: id });
    }
    return id;
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
        this.database.prepare(`
          INSERT INTO task_context_sets(task_id, revision, created_at, updated_at)
          VALUES (?, 1, ?, ?)
        `).run(taskRecord.id, now, now);
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

  async replaceTaskContext(input: {
    requestId: string;
    expectedStoreRevision: number;
    taskId: string;
    scope: TaskScope;
    expectedContextRevision: number;
    sources: TaskContextSourceInput[];
  }): Promise<{ storeRevision: number; contextSet: TaskContextSetRecord }> {
    const taskId = requiredString(input.taskId, "taskId", 200);
    const scope = normalizedTaskScope(input.scope);
    const expectedContextRevision = requiredRevision(input.expectedContextRevision, "expectedContextRevision");
    if (expectedContextRevision < 1) {
      throw new ProductStoreError("INVALID_ARGUMENT", "expectedContextRevision must be at least 1");
    }
    const params = {
      taskId,
      scope,
      expectedContextRevision,
      sources: stableValue(input.sources),
    };
    const replayed = await this.replayReceipt<{ storeRevision: number; contextSet: TaskContextSetRecord }>(
      "task.context.replace",
      input.requestId,
      params,
    );
    if (replayed) return replayed;
    const currentUser = this.currentUser();
    const preflightTaskRow = this.database.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as SQLiteRow | undefined;
    if (!preflightTaskRow) throw new ProductStoreError("NOT_FOUND", "Task context target does not exist", { taskId });
    const sources = await normalizeTaskContextSources(input.sources, currentUser.homeDirectory, task(preflightTaskRow).cwd);
    return await this.mutate(
      "task.context.replace",
      input.requestId,
      input.expectedStoreRevision,
      params,
      (_storeRevision, now) => {
        const taskRow = this.database.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as SQLiteRow | undefined;
        if (!taskRow) throw new ProductStoreError("NOT_FOUND", "Task context target does not exist", { taskId });
        const taskRecord = task(taskRow);
        if (JSON.stringify(taskRecord.scope) !== JSON.stringify(scope)) {
          throw new ProductStoreError("REVISION_CONFLICT", "Task Scope changed before its Context Selection could be saved");
        }
        const setRow = this.database.prepare("SELECT * FROM task_context_sets WHERE task_id = ?").get(taskId) as SQLiteRow | undefined;
        if (!setRow) {
          throw new ProductStoreError("NOT_FOUND", "Task has no durable Context Selection set", { taskId });
        }
        const currentSet = taskContextSet(setRow, []);
        if (currentSet.revision !== expectedContextRevision) {
          throw new ProductStoreError("REVISION_CONFLICT", "Task Context Selection changed before this update", {
            expectedContextRevision,
            currentContextRevision: currentSet.revision,
          });
        }
        this.database.prepare("DELETE FROM task_context_sources WHERE task_id = ?").run(taskId);
        const insert = this.database.prepare(`
          INSERT INTO task_context_sources(
            id, task_id, source_kind, root_path, relative_path,
            title, ordinal, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const records = sources.map((source, ordinal): TaskContextSourceRecord => {
          const record: TaskContextSourceRecord = {
            id: `context-source-${randomUUID()}`,
            taskId,
            kind: source.kind,
            relativePath: source.relativePath,
            title: source.title ?? basename(source.relativePath),
            ordinal,
            ...(source.rootPath ? { rootPath: source.rootPath } : {}),
            createdAt: now,
            updatedAt: now,
          };
          insert.run(
            record.id,
            record.taskId,
            record.kind,
            record.rootPath ?? "",
            record.relativePath,
            record.title,
            record.ordinal,
            now,
            now,
          );
          return record;
        });
        const revision = currentSet.revision + 1;
        this.database.prepare(`
          UPDATE task_context_sets SET revision = ?, updated_at = ?
          WHERE task_id = ? AND revision = ?
        `).run(revision, now, taskId, currentSet.revision);
        const contextSet: TaskContextSetRecord = {
          taskId,
          revision,
          sources: records,
          createdAt: currentSet.createdAt,
          updatedAt: now,
        };
        return {
          value: { contextSet },
          event: {
            kind: "task.contextSelection.replaced",
            entityKind: "taskContextSet",
            entityId: taskId,
            taskId,
            payload: contextSet,
          },
        };
      },
    );
  }

  async createTaskPlan(input: {
    requestId: string;
    expectedStoreRevision: number;
    taskId: string;
    scope: TaskScope;
    state?: TaskPlanState;
    document: Record<string, unknown>;
  }): Promise<{ storeRevision: number; taskPlan: TaskPlanRecord }> {
    const taskId = requiredString(input.taskId, "taskId", 200);
    const scope = normalizedTaskScope(input.scope);
    const state = normalizedTaskPlanState(input.state ?? "active", "state");
    const document = normalizedPlanDocument(input.document, "document");
    const params = { taskId, scope, state, document };
    return await this.mutate(
      "task.plan.create",
      input.requestId,
      input.expectedStoreRevision,
      params,
      (_storeRevision, now) => {
        this.taskForScope(taskId, scope);
        if (state === "active") {
          this.database.prepare(`
            UPDATE task_plans
            SET state = 'superseded', revision = revision + 1, updated_at = ?
            WHERE task_id = ? AND state = 'active'
          `).run(now, taskId);
        }
        const createdPlan: TaskPlanRecord = {
          id: `task-plan-${randomUUID()}`,
          taskId,
          state,
          document,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        this.database.prepare(`
          INSERT INTO task_plans(
            id, task_id, state, document_json, revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 1, ?, ?)
        `).run(createdPlan.id, taskId, state, canonicalJSON(document), now, now);
        return {
          value: { taskPlan: createdPlan },
          event: {
            kind: "taskPlan.created",
            entityKind: "taskPlan",
            entityId: createdPlan.id,
            taskId,
            payload: createdPlan,
          },
        };
      },
    );
  }

  async updateTaskPlan(input: {
    requestId: string;
    expectedStoreRevision: number;
    taskId: string;
    scope: TaskScope;
    planId: string;
    expectedPlanRevision: number;
    state: TaskPlanState;
    document: Record<string, unknown>;
  }): Promise<{ storeRevision: number; taskPlan: TaskPlanRecord }> {
    const taskId = requiredString(input.taskId, "taskId", 200);
    const scope = normalizedTaskScope(input.scope);
    const planId = requiredString(input.planId, "planId", 200);
    const expectedPlanRevision = requiredRevision(input.expectedPlanRevision, "expectedPlanRevision");
    if (expectedPlanRevision < 1) throw new ProductStoreError("INVALID_ARGUMENT", "expectedPlanRevision must be at least 1");
    const state = normalizedTaskPlanState(input.state, "state");
    const document = normalizedPlanDocument(input.document, "document");
    const params = { taskId, scope, planId, expectedPlanRevision, state, document };
    return await this.mutate(
      "task.plan.update",
      input.requestId,
      input.expectedStoreRevision,
      params,
      (_storeRevision, now) => {
        this.taskForScope(taskId, scope);
        const row = this.database.prepare("SELECT * FROM task_plans WHERE id = ? AND task_id = ?").get(planId, taskId) as SQLiteRow | undefined;
        if (!row) throw new ProductStoreError("NOT_FOUND", "Task Plan does not belong to this Task", { taskId, planId });
        const current = taskPlan(row);
        if (current.revision !== expectedPlanRevision) {
          throw new ProductStoreError("REVISION_CONFLICT", "Task Plan changed before this update", {
            expectedPlanRevision,
            currentPlanRevision: current.revision,
          });
        }
        if (state === "active") {
          this.database.prepare(`
            UPDATE task_plans
            SET state = 'superseded', revision = revision + 1, updated_at = ?
            WHERE task_id = ? AND state = 'active' AND id <> ?
          `).run(now, taskId, planId);
        }
        const updatedPlan: TaskPlanRecord = {
          ...current,
          state,
          document,
          revision: current.revision + 1,
          updatedAt: now,
        };
        this.database.prepare(`
          UPDATE task_plans
          SET state = ?, document_json = ?, revision = ?, updated_at = ?
          WHERE id = ? AND task_id = ? AND revision = ?
        `).run(state, canonicalJSON(document), updatedPlan.revision, now, planId, taskId, current.revision);
        return {
          value: { taskPlan: updatedPlan },
          event: {
            kind: "taskPlan.updated",
            entityKind: "taskPlan",
            entityId: planId,
            taskId,
            payload: updatedPlan,
          },
        };
      },
    );
  }

  async createTaskWorkItem(input: {
    requestId: string;
    expectedStoreRevision: number;
    taskId: string;
    scope: TaskScope;
    title: string;
    state?: TaskWorkItemState;
    ownerAssignmentId?: string | null;
    details?: unknown;
  }): Promise<{ storeRevision: number; taskWorkItem: TaskWorkItemRecord }> {
    const taskId = requiredString(input.taskId, "taskId", 200);
    const scope = normalizedTaskScope(input.scope);
    const title = requiredCredentialFreeString(input.title, "title", 500).trim();
    const state = normalizedTaskWorkItemState(input.state ?? "pending", "state");
    const details = normalizedWorkItemDetails(input.details ?? {}, "details");
    const ownerAssignmentId = input.ownerAssignmentId === undefined
      ? undefined
      : input.ownerAssignmentId === null
        ? null
        : requiredString(input.ownerAssignmentId, "ownerAssignmentId", 200);
    const params = { taskId, scope, title, state, ...(ownerAssignmentId === undefined ? {} : { ownerAssignmentId }), details };
    return await this.mutate(
      "task.workItem.create",
      input.requestId,
      input.expectedStoreRevision,
      params,
      (_storeRevision, now) => {
        this.taskForScope(taskId, scope);
        const owner = this.validateWorkItemOwner(taskId, ownerAssignmentId);
        const ordinalRow = this.database.prepare(`
          SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal FROM task_work_items WHERE task_id = ?
        `).get(taskId) as { ordinal?: unknown } | undefined;
        const ordinal = typeof ordinalRow?.ordinal === "number" ? ordinalRow.ordinal : 0;
        const createdWorkItem: TaskWorkItemRecord = {
          id: `task-work-item-${randomUUID()}`,
          taskId,
          ordinal,
          title,
          state,
          ...(owner ? { ownerAssignmentId: owner } : {}),
          details,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        this.database.prepare(`
          INSERT INTO task_work_items(
            id, task_id, ordinal, title, state, owner_assignment_id,
            details_json, revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        `).run(
          createdWorkItem.id,
          taskId,
          ordinal,
          title,
          state,
          owner,
          canonicalJSON(details),
          now,
          now,
        );
        return {
          value: { taskWorkItem: createdWorkItem },
          event: {
            kind: "taskWorkItem.created",
            entityKind: "taskWorkItem",
            entityId: createdWorkItem.id,
            taskId,
            payload: createdWorkItem,
          },
        };
      },
    );
  }

  async updateTaskWorkItem(input: {
    requestId: string;
    expectedStoreRevision: number;
    taskId: string;
    scope: TaskScope;
    workItemId: string;
    expectedWorkItemRevision: number;
    title?: string;
    state?: TaskWorkItemState;
    ownerAssignmentId?: string | null;
    details?: unknown;
  }): Promise<{ storeRevision: number; taskWorkItem: TaskWorkItemRecord }> {
    const taskId = requiredString(input.taskId, "taskId", 200);
    const scope = normalizedTaskScope(input.scope);
    const workItemId = requiredString(input.workItemId, "workItemId", 200);
    const expectedWorkItemRevision = requiredRevision(input.expectedWorkItemRevision, "expectedWorkItemRevision");
    if (expectedWorkItemRevision < 1) {
      throw new ProductStoreError("INVALID_ARGUMENT", "expectedWorkItemRevision must be at least 1");
    }
    const title = input.title === undefined ? undefined : requiredCredentialFreeString(input.title, "title", 500).trim();
    const state = input.state === undefined ? undefined : normalizedTaskWorkItemState(input.state, "state");
    const details = input.details === undefined ? undefined : normalizedWorkItemDetails(input.details, "details");
    const ownerAssignmentId = input.ownerAssignmentId === undefined
      ? undefined
      : input.ownerAssignmentId === null
        ? null
        : requiredString(input.ownerAssignmentId, "ownerAssignmentId", 200);
    if (title === undefined && state === undefined && details === undefined && ownerAssignmentId === undefined) {
      throw new ProductStoreError("INVALID_ARGUMENT", "Task Work Item update must change at least one field");
    }
    const params = {
      taskId,
      scope,
      workItemId,
      expectedWorkItemRevision,
      ...(title === undefined ? {} : { title }),
      ...(state === undefined ? {} : { state }),
      ...(ownerAssignmentId === undefined ? {} : { ownerAssignmentId }),
      ...(details === undefined ? {} : { details }),
    };
    return await this.mutate(
      "task.workItem.update",
      input.requestId,
      input.expectedStoreRevision,
      params,
      (_storeRevision, now) => {
        this.taskForScope(taskId, scope);
        const row = this.database.prepare(`
          SELECT * FROM task_work_items WHERE id = ? AND task_id = ?
        `).get(workItemId, taskId) as SQLiteRow | undefined;
        if (!row) throw new ProductStoreError("NOT_FOUND", "Task Work Item does not belong to this Task", { taskId, workItemId });
        const current = taskWorkItem(row);
        if (current.revision !== expectedWorkItemRevision) {
          throw new ProductStoreError("REVISION_CONFLICT", "Task Work Item changed before this update", {
            expectedWorkItemRevision,
            currentWorkItemRevision: current.revision,
          });
        }
        const owner = ownerAssignmentId === undefined
          ? current.ownerAssignmentId ?? null
          : this.validateWorkItemOwner(taskId, ownerAssignmentId);
        const updatedWorkItem: TaskWorkItemRecord = {
          ...current,
          ...(title === undefined ? {} : { title }),
          ...(state === undefined ? {} : { state }),
          ...(owner ? { ownerAssignmentId: owner } : {}),
          ...(owner ? {} : { ownerAssignmentId: undefined }),
          ...(details === undefined ? {} : { details }),
          revision: current.revision + 1,
          updatedAt: now,
        };
        this.database.prepare(`
          UPDATE task_work_items
          SET title = ?, state = ?, owner_assignment_id = ?, details_json = ?, revision = ?, updated_at = ?
          WHERE id = ? AND task_id = ? AND revision = ?
        `).run(
          updatedWorkItem.title,
          updatedWorkItem.state,
          owner,
          canonicalJSON(updatedWorkItem.details),
          updatedWorkItem.revision,
          now,
          workItemId,
          taskId,
          current.revision,
        );
        return {
          value: { taskWorkItem: updatedWorkItem },
          event: {
            kind: "taskWorkItem.updated",
            entityKind: "taskWorkItem",
            entityId: workItemId,
            taskId,
            payload: updatedWorkItem,
          },
        };
      },
    );
  }

  async reorderTaskWorkItems(input: {
    requestId: string;
    expectedStoreRevision: number;
    taskId: string;
    scope: TaskScope;
    items: Array<{ id: string; expectedRevision: number }>;
  }): Promise<{ storeRevision: number; taskWorkItems: TaskWorkItemRecord[] }> {
    const taskId = requiredString(input.taskId, "taskId", 200);
    const scope = normalizedTaskScope(input.scope);
    if (!Array.isArray(input.items) || input.items.length > 200) {
      throw new ProductStoreError("INVALID_ARGUMENT", "items must contain at most 200 Work Items");
    }
    const items = input.items.map((item, index) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        throw new ProductStoreError("INVALID_ARGUMENT", `items[${index}] is invalid`);
      }
      return {
        id: requiredString(item.id, `items[${index}].id`, 200),
        expectedRevision: requiredRevision(item.expectedRevision, `items[${index}].expectedRevision`),
      };
    });
    if (items.some((item) => item.expectedRevision < 1) || new Set(items.map((item) => item.id)).size !== items.length) {
      throw new ProductStoreError("INVALID_ARGUMENT", "Work Item order requires unique IDs with revisions of at least 1");
    }
    const params = { taskId, scope, items };
    return await this.mutate(
      "task.workItem.reorder",
      input.requestId,
      input.expectedStoreRevision,
      params,
      (_storeRevision, now) => {
        this.taskForScope(taskId, scope);
        const current = (
          this.database.prepare("SELECT * FROM task_work_items WHERE task_id = ? ORDER BY ordinal, id").all(taskId) as SQLiteRow[]
        ).map(taskWorkItem);
        if (current.length !== items.length || new Set(current.map((item) => item.id)).size !== items.length) {
          throw new ProductStoreError("REVISION_CONFLICT", "Work Item set changed before this reorder", { taskId });
        }
        const currentByID = new Map(current.map((item) => [item.id, item]));
        for (const item of items) {
          const existing = currentByID.get(item.id);
          if (!existing || existing.revision !== item.expectedRevision) {
            throw new ProductStoreError("REVISION_CONFLICT", "Work Item changed before this reorder", {
              workItemId: item.id,
              expectedWorkItemRevision: item.expectedRevision,
              currentWorkItemRevision: existing?.revision,
            });
          }
        }
        const changing = items.flatMap((item, ordinal) => {
          const currentItem = currentByID.get(item.id)!;
          return currentItem.ordinal === ordinal ? [] : [{ currentItem, ordinal }];
        });
        const reserveOrdinal = this.database.prepare(`
          UPDATE task_work_items
          SET ordinal = ?
          WHERE id = ? AND task_id = ? AND revision = ?
        `);
        const temporaryBase = current.length + items.length + 1;
        for (const [index, change] of changing.entries()) {
          reserveOrdinal.run(temporaryBase + index, change.currentItem.id, taskId, change.currentItem.revision);
        }
        const update = this.database.prepare(`
          UPDATE task_work_items
          SET ordinal = ?, revision = ?, updated_at = ?
          WHERE id = ? AND task_id = ? AND revision = ?
        `);
        const changedByID = new Map(changing.map((change) => [change.currentItem.id, change]));
        const taskWorkItems = items.map((item, ordinal) => {
          const currentItem = currentByID.get(item.id)!;
          if (!changedByID.has(currentItem.id)) return currentItem;
          const updated: TaskWorkItemRecord = { ...currentItem, ordinal, revision: currentItem.revision + 1, updatedAt: now };
          update.run(ordinal, updated.revision, now, updated.id, taskId, currentItem.revision);
          return updated;
        });
        return {
          value: { taskWorkItems },
          event: {
            kind: "taskWorkItem.reordered",
            entityKind: "task",
            entityId: taskId,
            taskId,
            payload: { taskId, taskWorkItems },
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
        this.database.prepare(`
          INSERT INTO task_context_sets(task_id, revision, created_at, updated_at)
          VALUES (?, 1, ?, ?)
        `).run(taskRecord.id, now, now);
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
    contextRevision: number;
    profileSnapshot: Record<string, unknown>;
    tools: Array<{ name: string; description: string; parameters: unknown }>;
    toolsWritable: boolean;
    systemPromptDigest: string;
    promptSources: DCodePromptSourceReceipt[];
    importedHistoryReceipt?: ImportedSessionHistoryReceipt;
  }): Promise<PreparedSessionRun> {
    const taskId = requiredString(input.taskId, "taskId", 200);
    const scope = normalizedTaskScope(input.scope);
    const sessionId = requiredString(input.sessionId, "sessionId", 200);
    const runtimeId = requiredString(input.runtimeId, "runtimeId", 200);
    const agentRunId = input.agentRunId === undefined
      ? undefined
      : requiredString(input.agentRunId, "agentRunId", 200);
    const workspaceId = requiredString(input.workspaceId, "workspaceId", 200);
    const contextRevision = requiredRevision(input.contextRevision, "contextRevision");
    if (contextRevision < 1) {
      throw new ProductStoreError("INVALID_ARGUMENT", "contextRevision must be at least 1");
    }
    const message = requiredCredentialFreeString(input.message, "message", 200_000);
    if (!isAbsolute(input.cwd)) throw new ProductStoreError("INVALID_ARGUMENT", "Runtime cwd must be absolute");
    if (input.workspaceAccess !== "sharedReadOnly" && input.workspaceAccess !== "exclusiveWrite") {
      throw new ProductStoreError("INVALID_ARGUMENT", "Runtime workspaceAccess is invalid");
    }
    if (input.toolsWritable && input.workspaceAccess !== "exclusiveWrite") {
      throw new ProductStoreError(
        "INVALID_ARGUMENT",
        "Writable Active Tool Set requires an exclusiveWrite Runtime workspace",
      );
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(input.systemPromptDigest)) {
      throw new ProductStoreError("INVALID_ARGUMENT", "systemPromptDigest must be SHA-256");
    }
    stableValue(input.attachmentRefs);
    stableValue(input.profileSnapshot);
    stableValue(input.tools);
    let promptSources: DCodePromptSourceReceipt[];
    let importedHistoryReceipt: ImportedSessionHistoryReceipt | undefined;
    try {
      promptSources = normalizeDCodePromptSourceReceipts(input.promptSources);
      importedHistoryReceipt = input.importedHistoryReceipt === undefined
        ? undefined
        : normalizeImportedSessionHistoryReceipt(input.importedHistoryReceipt);
    } catch (error) {
      if (error instanceof DCodePromptSourceReceiptError || error instanceof ImportedSessionHistoryReceiptError) {
        throw new ProductStoreError("INVALID_ARGUMENT", error.message);
      }
      throw error;
    }
    const currentImportedHistory = await this.importedSessionHistoryProjection(sessionId);
    if (
      currentImportedHistory?.receipt.digest !== importedHistoryReceipt?.digest
      || currentImportedHistory?.receipt.dcodeSessionId !== importedHistoryReceipt?.dcodeSessionId
    ) {
      throw new ProductStoreError(
        "REVISION_CONFLICT",
        "Imported History Projection changed before this Session Run could be prepared",
        { sessionId },
      );
    }
    if (importedHistoryReceipt && importedHistoryReceipt.dcodeSessionId !== sessionId) {
      throw new ProductStoreError(
        "INVALID_ARGUMENT",
        "Imported History Receipt does not belong to this D Code Session",
        { sessionId },
      );
    }
    assertCredentialFreeValue(input.profileSnapshot, "profileSnapshot");
    assertCredentialFreeValue(input.tools, "tools");
    const resolvedCwd = resolve(input.cwd);
    let canonicalUserHome: string;
    try {
      canonicalUserHome = await realpath(this.currentUser().homeDirectory);
    } catch {
      throw new ProductStoreError("INVALID_ARGUMENT", "Current D Code user home is unavailable for Prompt Source validation");
    }
    for (const [index, source] of promptSources.entries()) {
      const sourceRoot = resolve(source.rootPath ?? resolvedCwd);
      if (source.rootPath && !strictlyInside(canonicalUserHome, sourceRoot) && sourceRoot !== resolvedCwd) {
        throw new ProductStoreError("INVALID_ARGUMENT", `promptSources[${index}] source root is outside the current user home`);
      }
      const sourceRelativePath = relative(sourceRoot, resolve(source.path));
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
      contextRevision,
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
        const contextSetRow = this.database.prepare(`
          SELECT revision FROM task_context_sets WHERE task_id = ?
        `).get(taskId) as SQLiteRow | undefined;
        if (!contextSetRow) {
          throw new ProductStoreError("NOT_FOUND", "Session Run Task has no Context Selection set", { taskId });
        }
        if (integer(contextSetRow, "revision") !== contextRevision) {
          throw new ProductStoreError(
            "REVISION_CONFLICT",
            "Task Context Selection changed before Session Run preparation",
            { expectedContextRevision: contextRevision, currentContextRevision: integer(contextSetRow, "revision") },
          );
        }
        if (agentRunId) {
          const agentRun = this.database.prepare(`
            SELECT g.id, g.role, g.status, g.team_run_id,
              COALESCE(
                t.status,
                (SELECT c.status FROM team_runs c
                  WHERE c.coordinator_agent_run_id = g.id AND c.status = 'active'
                  ORDER BY c.created_at DESC, c.id DESC LIMIT 1)
              ) AS team_status
            FROM agent_runs g
            LEFT JOIN team_runs t ON t.id = g.team_run_id
            WHERE g.id = ? AND g.task_id = ? AND g.session_id = ?
          `).get(agentRunId, taskId, sessionId) as SQLiteRow | undefined;
          if (!agentRun) throw new ProductStoreError("NOT_FOUND", "Agent Run does not match the Session Run target");
          const agentStatus = text(agentRun, "status");
          const coordinatorContinuation = text(agentRun, "role") === "coordinator"
            && agentStatus === "completed"
            && (agentRun.team_status === "active" || agentRun.team_run_id === null);
          if (agentStatus !== "prepared" && !coordinatorContinuation) {
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
          canonicalJSON({
            version: 3,
            taskContextRevision: contextRevision,
            promptSources,
            ...(importedHistoryReceipt ? { importedHistoryReceipt } : {}),
          }),
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
              model_provider = ?, model_id = ?,
              completed_at = NULL, updated_at = ?
            WHERE id = ? AND status IN ('prepared', 'completed')
          `).run(input.modelProvider ?? null, input.modelId ?? null, now, agentRunId);
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
          canonicalJSON({
            version: 2,
            documentSources: promptSources,
            ...(importedHistoryReceipt ? { importedHistory: importedHistoryReceipt } : {}),
          }),
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

  async ensureCoordinatorAgentRun(input: {
    requestId: string;
    taskId: string;
    scope: TaskScope;
  }): Promise<{ storeRevision: number; agentRun: AgentRunRecord; assignment: AgentAssignmentRecord }> {
    const taskId = requiredString(input.taskId, "taskId", 200);
    const scope = normalizedTaskScope(input.scope);
    return await this.mutate(
      "coordinatorAgentRun.ensure",
      input.requestId,
      undefined,
      { taskId, scope },
      (_storeRevision, now) => {
        const taskRecord = this.taskForScope(taskId, scope);
        const coordination = this.database.prepare(`
          SELECT * FROM sessions WHERE task_id = ? AND kind = 'coordination'
        `).get(taskId) as SQLiteRow | undefined;
        const coordinatorAssignment = this.database.prepare(`
          SELECT * FROM coordinator_assignments WHERE task_id = ?
        `).get(taskId) as SQLiteRow | undefined;
        if (!coordination || !coordinatorAssignment) {
          throw new ProductStoreError("NOT_FOUND", "Task has no Coordination Session or Coordinator assignment");
        }
        const profileRow = this.database.prepare(`
          SELECT * FROM agent_profiles WHERE id = ? AND enabled = 1
        `).get(text(coordinatorAssignment, "profile_id")) as SQLiteRow | undefined;
        if (!profileRow) {
          throw new ProductStoreError("NOT_FOUND", "Coordinator Agent Profile is disabled or missing");
        }
        const existing = this.database.prepare(`
          SELECT * FROM agent_runs
          WHERE task_id = ? AND session_id = ? AND role = 'coordinator' AND team_run_id IS NULL
            AND status IN ('prepared', 'running', 'waiting', 'completed')
          ORDER BY created_at DESC, id DESC LIMIT 1
        `).get(taskId, text(coordination, "id")) as SQLiteRow | undefined;
        if (existing) {
          const agentRunRecord = agentRun(existing);
          const assignmentRow = this.database.prepare(`
            SELECT * FROM agent_assignments
            WHERE agent_run_id = ? AND assignment_kind = 'coordinator'
            ORDER BY created_at DESC, id DESC LIMIT 1
          `).get(agentRunRecord.id) as SQLiteRow | undefined;
          if (!assignmentRow) {
            throw new ProductStoreError("PRODUCT_STORE_CORRUPT", "Coordinator Agent Run has no assignment", {
              agentRunId: agentRunRecord.id,
            });
          }
          return {
            value: { agentRun: agentRunRecord, assignment: agentAssignment(assignmentRow) },
            event: {
              kind: "coordinatorAgentRun.reused",
              entityKind: "agentRun",
              entityId: agentRunRecord.id,
              taskId,
              payload: { agentRun: agentRunRecord },
            },
          };
        }
        const profile = agentProfile(profileRow);
        const agentRunRecord: AgentRunRecord = {
          id: `agent-run-${randomUUID()}`,
          taskId,
          sessionId: text(coordination, "id"),
          profileId: profile.id,
          profileSnapshot: profile,
          role: "coordinator",
          status: "prepared",
          revision: 1,
        };
        this.database.prepare(`
          INSERT INTO agent_runs(
            id, task_id, team_run_id, session_id, profile_id,
            profile_snapshot_json, role, model_provider, model_id,
            status, revision, created_at, updated_at, completed_at
          ) VALUES (?, ?, NULL, ?, ?, ?, 'coordinator', NULL, NULL, 'prepared', 1, ?, ?, NULL)
        `).run(
          agentRunRecord.id,
          taskId,
          agentRunRecord.sessionId,
          profile.id,
          canonicalJSON(profile),
          now,
          now,
        );
        const assignment: AgentAssignmentRecord = {
          id: `agent-assignment-${randomUUID()}`,
          taskId,
          agentRunId: agentRunRecord.id,
          profileId: profile.id,
          assignmentKind: "coordinator",
          taskPacket: { title: taskRecord.title, goal: taskRecord.goal },
          revision: 1,
        };
        this.database.prepare(`
          INSERT INTO agent_assignments(
            id, task_id, team_run_id, agent_run_id, profile_id,
            assignment_kind, task_packet_json, revision, created_at, updated_at
          ) VALUES (?, ?, NULL, ?, ?, 'coordinator', ?, 1, ?, ?)
        `).run(
          assignment.id,
          taskId,
          agentRunRecord.id,
          profile.id,
          canonicalJSON(assignment.taskPacket),
          now,
          now,
        );
        this.database.prepare(`
          UPDATE tasks SET state = 'active', revision = revision + 1, updated_at = ?
          WHERE id = ? AND state IN ('draft', 'waiting')
        `).run(now, taskId);
        return {
          value: { agentRun: agentRunRecord, assignment },
          event: {
            kind: "coordinatorAgentRun.created",
            entityKind: "agentRun",
            entityId: agentRunRecord.id,
            taskId,
            payload: { agentRun: agentRunRecord, assignment },
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
        const reusableCoordinatorRow = this.database.prepare(`
          SELECT * FROM agent_runs
          WHERE task_id = ? AND session_id = ? AND role = 'coordinator' AND team_run_id IS NULL
          ORDER BY created_at DESC, id DESC LIMIT 1
        `).get(taskId, text(coordination, "id")) as SQLiteRow | undefined;
        if (reusableCoordinatorRow && ["running", "waiting"].includes(text(reusableCoordinatorRow, "status"))) {
          throw new ProductStoreError(
            "REVISION_CONFLICT",
            "Coordinator Agent Run is still active; D Code did not start a Team beside the same Coordination Runtime",
            { agentRunId: text(reusableCoordinatorRow, "id") },
          );
        }
        const reusableCoordinator = reusableCoordinatorRow
          && ["prepared", "completed"].includes(text(reusableCoordinatorRow, "status"))
          ? agentRun(reusableCoordinatorRow)
          : undefined;
        const coordinatorAgentRunId = reusableCoordinator?.id ?? `agent-run-${randomUUID()}`;
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
        const coordinatorAgentRun: AgentRunRecord = reusableCoordinator ?? {
          id: coordinatorAgentRunId,
          taskId,
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
        if (!reusableCoordinator) {
          insertAgentRun.run(
            coordinatorAgentRun.id,
            taskId,
            null,
            coordinatorAgentRun.sessionId,
            coordinatorProfile.id,
            canonicalJSON(coordinatorProfile),
            coordinatorProfile.role,
            now,
            now,
          );
        }
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
          SELECT * FROM agent_runs
          WHERE team_run_id = ?
            OR id = (SELECT coordinator_agent_run_id FROM team_runs WHERE id = ?)
          ORDER BY created_at, id
        `).all(teamRunId, teamRunId) as SQLiteRow[]).map(agentRun);
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

  async prepareManagedWorkerWorktrees(input: {
    requestId: string;
    expectedStoreRevision: number;
    scope: TaskScope;
    taskId: string;
    teamRunId: string;
    plans: ManagedWorkerWorktreePlan[];
  }): Promise<{ storeRevision: number; worktrees: ManagedWorkerWorktreeRecord[] }> {
    const scope = normalizedTaskScope(input.scope);
    const taskId = requiredString(input.taskId, "taskId", 200);
    const teamRunId = requiredString(input.teamRunId, "teamRunId", 200);
    if (scope.kind !== "project") {
      throw new ProductStoreError("INVALID_ARGUMENT", "Managed Worker worktrees require a Project Scope");
    }
    if (!Array.isArray(input.plans) || input.plans.length < 1 || input.plans.length > 8) {
      throw new ProductStoreError("INVALID_ARGUMENT", "Managed Worker worktree plans must contain 1...8 members");
    }
    const seenAgentRuns = new Set<string>();
    const plans = input.plans.map((plan, index) => {
      const agentRunId = requiredString(plan.agentRunId, `plans[${index}].agentRunId`, 200);
      if (seenAgentRuns.has(agentRunId)) {
        throw new ProductStoreError("INVALID_ARGUMENT", "Managed Worker worktree plans repeat an Agent Run", { agentRunId });
      }
      seenAgentRuns.add(agentRunId);
      const artifactId = requiredString(plan.artifactId, `plans[${index}].artifactId`, 200);
      if (artifactId !== managedWorkerWorktreeArtifactId(agentRunId)) {
        throw new ProductStoreError("INVALID_ARGUMENT", "Managed Worker worktree Artifact identity is invalid", { agentRunId });
      }
      const workspaceId = requiredString(plan.workspaceId, `plans[${index}].workspaceId`, 200);
      if (!workspaceId.endsWith(artifactId)) {
        throw new ProductStoreError("INVALID_ARGUMENT", "Managed Worker workspace identity is invalid", { agentRunId });
      }
      const requiredPath = (value: unknown, field: string): string => {
        const path = requiredString(value, field, 4_096);
        if (!isAbsolute(path)) throw new ProductStoreError("INVALID_ARGUMENT", `${field} must be absolute`);
        return resolve(path);
      };
      const worktreeRoot = requiredPath(plan.worktreeRoot, `plans[${index}].worktreeRoot`);
      const workspaceCwd = requiredPath(plan.workspaceCwd, `plans[${index}].workspaceCwd`);
      const workspaceRelative = relative(worktreeRoot, workspaceCwd);
      if (workspaceRelative === ".." || workspaceRelative.startsWith("../") || isAbsolute(workspaceRelative)) {
        throw new ProductStoreError("INVALID_ARGUMENT", "Managed Worker worktree cwd escapes its root", { agentRunId });
      }
      const sourceProjectDirectory = requiredPath(plan.sourceProjectDirectory, `plans[${index}].sourceProjectDirectory`);
      const repositoryRoot = requiredPath(plan.repositoryRoot, `plans[${index}].repositoryRoot`);
      const commonGitDirectory = requiredPath(plan.commonGitDirectory, `plans[${index}].commonGitDirectory`);
      const baseCommit = requiredString(plan.baseCommit, `plans[${index}].baseCommit`, 64);
      if (!/^[0-9a-f]{40,64}$/i.test(baseCommit)) {
        throw new ProductStoreError("INVALID_ARGUMENT", "Managed Worker worktree base commit is invalid", { agentRunId });
      }
      if (typeof plan.projectRelativePath !== "string" || plan.projectRelativePath.length > 4_096) {
        throw new ProductStoreError("INVALID_ARGUMENT", "Managed Worker worktree relative path is invalid", { agentRunId });
      }
      return {
        agentRunId,
        artifactId,
        workspaceId,
        worktreeRoot,
        workspaceCwd,
        sourceProjectDirectory,
        repositoryRoot,
        commonGitDirectory,
        baseCommit,
        projectRelativePath: plan.projectRelativePath,
      };
    });
    return await this.mutate(
      "managedWorkerWorktree.prepare",
      input.requestId,
      input.expectedStoreRevision,
      { scope, taskId, teamRunId, plans },
      (_storeRevision, now) => {
        const taskRow = this.database.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as SQLiteRow | undefined;
        const teamRow = this.database.prepare("SELECT * FROM team_runs WHERE id = ? AND task_id = ?")
          .get(teamRunId, taskId) as SQLiteRow | undefined;
        if (!taskRow || !teamRow) {
          throw new ProductStoreError("NOT_FOUND", "Managed Worker worktree target does not exist", { taskId, teamRunId });
        }
        const taskRecord = task(taskRow);
        if (JSON.stringify(taskRecord.scope) !== JSON.stringify(scope)) {
          throw new ProductStoreError("REVISION_CONFLICT", "Managed Worker worktree Task Scope changed", { taskId });
        }
        if (teamRun(teamRow).status !== "active") {
          throw new ProductStoreError("REVISION_CONFLICT", "Managed Worker worktree Team Run is not active", { teamRunId });
        }
        const worktrees: ManagedWorkerWorktreeRecord[] = [];
        const insertArtifact = this.database.prepare(`
          INSERT INTO artifacts(
            id, task_id, session_id, agent_run_id, kind, title,
            managed_path, external_path, digest, metadata_json,
            revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 1, ?, ?)
        `);
        const insertAttempt = this.database.prepare(`
          INSERT INTO operation_attempts(
            id, task_id, session_id, session_run_id, agent_run_id,
            operation_kind, target_identity, parameter_digest, replay_policy,
            status, outcome_json, prepared_at, completed_at, updated_at
          ) VALUES (?, ?, ?, NULL, ?, 'external_side_effect', ?, ?, 'never',
            'prepared', NULL, ?, NULL, ?)
        `);
        for (const plan of plans) {
          const agentRow = this.database.prepare(`
            SELECT id, session_id, role, status FROM agent_runs
            WHERE id = ? AND task_id = ? AND team_run_id = ?
          `).get(plan.agentRunId, taskId, teamRunId) as SQLiteRow | undefined;
          if (!agentRow || text(agentRow, "role") !== "worker" || text(agentRow, "status") !== "prepared") {
            throw new ProductStoreError("REVISION_CONFLICT", "Managed Worker Agent Run is not ready", {
              agentRunId: plan.agentRunId,
            });
          }
          const existing = this.database.prepare("SELECT id FROM artifacts WHERE id = ?").get(plan.artifactId);
          if (existing) {
            throw new ProductStoreError("REVISION_CONFLICT", "Managed Worker worktree already has an Artifact", {
              artifactId: plan.artifactId,
            });
          }
          const attemptId = `attempt-${randomUUID()}`;
          const metadata: ManagedWorkerWorktreeMetadata = {
            version: 1,
            state: "preparing",
            teamRunId,
            agentRunId: plan.agentRunId,
            projectId: scope.projectId,
            workspaceId: plan.workspaceId,
            sourceProjectDirectory: plan.sourceProjectDirectory,
            repositoryRoot: plan.repositoryRoot,
            commonGitDirectory: plan.commonGitDirectory,
            baseCommit: plan.baseCommit,
            projectRelativePath: plan.projectRelativePath,
            workspaceCwd: plan.workspaceCwd,
            provisionAttemptId: attemptId,
          };
          insertArtifact.run(
            plan.artifactId,
            taskId,
            text(agentRow, "session_id"),
            plan.agentRunId,
            MANAGED_WORKER_WORKTREE_ARTIFACT_KIND,
            "受管 Worker 工作树",
            plan.worktreeRoot,
            `sha256:${payloadHash({ ...metadata, managedPath: plan.worktreeRoot })}`,
            canonicalJSON(metadata),
            now,
            now,
          );
          insertAttempt.run(
            attemptId,
            taskId,
            text(agentRow, "session_id"),
            plan.agentRunId,
            `${MANAGED_WORKER_WORKTREE_TARGET_PREFIX}${plan.artifactId}`,
            `sha256:${payloadHash({ artifactId: plan.artifactId, ...metadata, managedPath: plan.worktreeRoot })}`,
            now,
            now,
          );
          worktrees.push({
            artifactId: plan.artifactId,
            taskId,
            teamRunId,
            agentRunId: plan.agentRunId,
            projectId: scope.projectId,
            workspaceId: plan.workspaceId,
            managedPath: plan.worktreeRoot,
            workspaceCwd: plan.workspaceCwd,
            sourceProjectDirectory: plan.sourceProjectDirectory,
            repositoryRoot: plan.repositoryRoot,
            commonGitDirectory: plan.commonGitDirectory,
            baseCommit: plan.baseCommit,
            projectRelativePath: plan.projectRelativePath,
            provisionAttemptId: attemptId,
            state: "preparing",
            revision: 1,
          });
        }
        return {
          value: { worktrees },
          event: {
            kind: "managedWorkerWorktree.prepared",
            entityKind: "artifact",
            entityId: teamRunId,
            taskId,
            payload: { teamRunId, worktrees },
          },
        };
      },
    );
  }

  async finishManagedWorkerWorktree(input: {
    requestId: string;
    artifactId: string;
    provisionAttemptId: string;
    state: "ready" | "failed" | "unknown";
    resultDigest?: string;
    failureCode?: string;
  }): Promise<{ storeRevision: number; worktree: ManagedWorkerWorktreeRecord }> {
    const artifactId = requiredString(input.artifactId, "artifactId", 200);
    const provisionAttemptId = requiredString(input.provisionAttemptId, "provisionAttemptId", 200);
    if (input.resultDigest !== undefined && !/^sha256:[a-f0-9]{64}$/.test(input.resultDigest)) {
      throw new ProductStoreError("INVALID_ARGUMENT", "Managed Worker worktree resultDigest must be SHA-256");
    }
    const failureCode = input.failureCode === undefined
      ? undefined
      : requiredString(input.failureCode, "failureCode", 200);
    return await this.mutate(
      "managedWorkerWorktree.finish",
      input.requestId,
      undefined,
      { artifactId, provisionAttemptId, state: input.state, resultDigest: input.resultDigest ?? null, failureCode: failureCode ?? null },
      (_storeRevision, now) => {
        const row = this.database.prepare("SELECT * FROM artifacts WHERE id = ?").get(artifactId) as SQLiteRow | undefined;
        if (!row) throw new ProductStoreError("NOT_FOUND", "Managed Worker worktree Artifact does not exist", { artifactId });
        const current = managedWorkerWorktree(artifact(row));
        if (current.provisionAttemptId !== provisionAttemptId) {
          throw new ProductStoreError("REVISION_CONFLICT", "Managed Worker worktree Attempt does not match its Artifact", {
            artifactId,
          });
        }
        if (current.state !== "preparing") {
          throw new ProductStoreError("REVISION_CONFLICT", "Managed Worker worktree is already terminal", {
            artifactId,
            state: current.state,
          });
        }
        const attempt = this.database.prepare(`
          SELECT status, task_id FROM operation_attempts WHERE id = ? AND target_identity = ?
        `).get(provisionAttemptId, `${MANAGED_WORKER_WORKTREE_TARGET_PREFIX}${artifactId}`) as SQLiteRow | undefined;
        if (!attempt || text(attempt, "status") !== "prepared") {
          throw new ProductStoreError("REVISION_CONFLICT", "Managed Worker worktree Attempt is not prepared", {
            provisionAttemptId,
          });
        }
        const nextMetadata: ManagedWorkerWorktreeMetadata = {
          version: 1,
          state: input.state,
          teamRunId: current.teamRunId,
          agentRunId: current.agentRunId,
          projectId: current.projectId,
          workspaceId: current.workspaceId,
          sourceProjectDirectory: current.sourceProjectDirectory,
          repositoryRoot: current.repositoryRoot,
          commonGitDirectory: current.commonGitDirectory,
          baseCommit: current.baseCommit,
          projectRelativePath: current.projectRelativePath,
          workspaceCwd: current.workspaceCwd,
          provisionAttemptId: current.provisionAttemptId,
          ...(failureCode ? { failureCode } : {}),
        };
        const nextRevision = current.revision + 1;
        this.database.prepare(`
          UPDATE artifacts
          SET metadata_json = ?, revision = ?, updated_at = ?
          WHERE id = ? AND revision = ?
        `).run(canonicalJSON(nextMetadata), nextRevision, now, artifactId, current.revision);
        const outcome = input.state === "ready" ? "succeeded" : input.state;
        this.database.prepare(`
          UPDATE operation_attempts
          SET status = ?, outcome_json = ?, completed_at = ?, updated_at = ?
          WHERE id = ? AND status = 'prepared'
        `).run(
          outcome,
          canonicalJSON({ resultDigest: input.resultDigest ?? null, workspaceId: current.workspaceId, state: input.state }),
          now,
          now,
          provisionAttemptId,
        );
        const worktree: ManagedWorkerWorktreeRecord = {
          ...current,
          state: input.state,
          ...(failureCode ? { failureCode } : {}),
          revision: nextRevision,
        };
        return {
          value: { worktree },
          event: {
            kind: `managedWorkerWorktree.${input.state}`,
            entityKind: "artifact",
            entityId: artifactId,
            taskId: current.taskId,
            payload: { worktree },
          },
        };
      },
    );
  }

  async invalidateManagedWorkerWorktree(input: {
    requestId: string;
    artifactId: string;
    failureCode: string;
  }): Promise<{ storeRevision: number; worktree: ManagedWorkerWorktreeRecord }> {
    const artifactId = requiredString(input.artifactId, "artifactId", 200);
    const failureCode = requiredString(input.failureCode, "failureCode", 200);
    return await this.mutate(
      "managedWorkerWorktree.invalidate",
      input.requestId,
      undefined,
      { artifactId, failureCode },
      (_storeRevision, now) => {
        const row = this.database.prepare("SELECT * FROM artifacts WHERE id = ?").get(artifactId) as SQLiteRow | undefined;
        if (!row) throw new ProductStoreError("NOT_FOUND", "Managed Worker worktree Artifact does not exist", { artifactId });
        const current = managedWorkerWorktree(artifact(row));
        if (current.state === "unknown") {
          return {
            value: { worktree: current },
            event: {
              kind: "managedWorkerWorktree.unknownReused",
              entityKind: "artifact",
              entityId: artifactId,
              taskId: current.taskId,
              payload: { worktree: current },
            },
          };
        }
        if (current.state !== "ready") {
          throw new ProductStoreError("REVISION_CONFLICT", "Managed Worker worktree cannot be invalidated from its current state", {
            artifactId,
            state: current.state,
          });
        }
        const metadata: ManagedWorkerWorktreeMetadata = {
          version: 1,
          state: "unknown",
          teamRunId: current.teamRunId,
          agentRunId: current.agentRunId,
          projectId: current.projectId,
          workspaceId: current.workspaceId,
          sourceProjectDirectory: current.sourceProjectDirectory,
          repositoryRoot: current.repositoryRoot,
          commonGitDirectory: current.commonGitDirectory,
          baseCommit: current.baseCommit,
          projectRelativePath: current.projectRelativePath,
          workspaceCwd: current.workspaceCwd,
          provisionAttemptId: current.provisionAttemptId,
          failureCode,
        };
        const nextRevision = current.revision + 1;
        this.database.prepare(`
          UPDATE artifacts
          SET metadata_json = ?, revision = ?, updated_at = ?
          WHERE id = ? AND revision = ?
        `).run(canonicalJSON(metadata), nextRevision, now, artifactId, current.revision);
        const worktree: ManagedWorkerWorktreeRecord = {
          ...current,
          state: "unknown",
          failureCode,
          revision: nextRevision,
        };
        return {
          value: { worktree },
          event: {
            kind: "managedWorkerWorktree.invalidated",
            entityKind: "artifact",
            entityId: artifactId,
            taskId: current.taskId,
            payload: { worktree },
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
    reasonCode?: string;
  }): Promise<{ storeRevision: number; teamRun: TeamRunRecord }> {
    const taskId = requiredString(input.taskId, "taskId", 200);
    const teamRunId = requiredString(input.teamRunId, "teamRunId", 200);
    const reason = requiredCredentialFreeString(input.reason, "reason", 2_000);
    const reasonCode = input.reasonCode === undefined
      ? undefined
      : requiredString(input.reasonCode, "reasonCode", 200);
    return await this.mutate(
      "teamRun.finish",
      input.requestId,
      undefined,
      { taskId, teamRunId, status: input.status, reason, reasonCode: reasonCode ?? null },
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
              payload: { teamRun: previous, reason, ...(reasonCode ? { reasonCode } : {}) },
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
          WHERE (team_run_id = ? OR id = (SELECT coordinator_agent_run_id FROM team_runs WHERE id = ?))
            AND status IN ('prepared', 'running', 'waiting')
        `).run(input.status, now, now, teamRunId, teamRunId);
        this.database.prepare(`
          UPDATE session_runs
          SET status = ?, revision = revision + 1, completed_at = ?, updated_at = ?
          WHERE agent_run_id IN (
            SELECT id FROM agent_runs
            WHERE team_run_id = ? OR id = (SELECT coordinator_agent_run_id FROM team_runs WHERE id = ?)
          )
            AND status IN ('prepared', 'running', 'waiting')
        `).run(input.status, now, now, teamRunId, teamRunId);
        this.database.prepare(`
          UPDATE sessions SET state = 'failed', revision = revision + 1, updated_at = ?
          WHERE id IN (
            SELECT session_id FROM agent_runs
            WHERE team_run_id = ? OR id = (SELECT coordinator_agent_run_id FROM team_runs WHERE id = ?)
          )
            AND state != 'archived'
        `).run(now, teamRunId, teamRunId);
        markPreparingManagedWorkerWorktreesUnknown(
          this.database,
          now,
          input.status === "failed" ? "TEAM_RUN_FAILED" : "TEAM_RUN_ABORTED",
          teamRunId,
        );
        this.database.prepare(`
          UPDATE operation_attempts SET status = 'unknown', updated_at = ?
          WHERE agent_run_id IN (
            SELECT id FROM agent_runs
            WHERE team_run_id = ? OR id = (SELECT coordinator_agent_run_id FROM team_runs WHERE id = ?)
          )
            AND status = 'prepared'
        `).run(now, teamRunId, teamRunId);
        this.database.prepare(`
          UPDATE agent_requests
          SET status = 'cancelled', answer_json = ?, revision = revision + 1, updated_at = ?
          WHERE agent_run_id IN (
            SELECT id FROM agent_runs
            WHERE team_run_id = ? OR id = (SELECT coordinator_agent_run_id FROM team_runs WHERE id = ?)
          )
            AND status = 'open'
        `).run(canonicalJSON({ reason }), now, teamRunId, teamRunId);
        return {
          value: { teamRun: updated },
          event: {
            kind: `teamRun.${input.status}`,
            entityKind: "teamRun",
            entityId: teamRunId,
            taskId,
            payload: { teamRun: updated, reason, ...(reasonCode ? { reasonCode } : {}) },
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
          SELECT g.id, g.team_run_id,
            (SELECT id FROM team_runs
              WHERE coordinator_agent_run_id = g.id AND status IN ('prepared', 'active', 'waiting')
              ORDER BY created_at DESC, id DESC LIMIT 1) AS coordinator_team_run_id,
            g.status AS agent_status, r.status AS session_status
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
        const resolvedTeamRunId = typeof run.team_run_id === "string"
          ? run.team_run_id
          : typeof run.coordinator_team_run_id === "string"
            ? run.coordinator_team_run_id
            : undefined;
        const record: AgentRequestRecord = {
          id: `agent-request-${randomUUID()}`,
          taskId,
          ...(resolvedTeamRunId ? { teamRunId: resolvedTeamRunId } : {}),
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
        if (resolvedTeamRunId) {
          const stillRunning = this.database.prepare(`
            SELECT COUNT(*) AS count FROM agent_runs
            WHERE (team_run_id = ? OR id = (SELECT coordinator_agent_run_id FROM team_runs WHERE id = ?))
              AND status IN ('prepared', 'running')
          `).get(resolvedTeamRunId, resolvedTeamRunId) as { count?: unknown } | undefined;
          if (stillRunning?.count === 0) {
            this.database.prepare(`
              UPDATE team_runs SET status = 'waiting', revision = revision + 1, updated_at = ?
              WHERE id = ? AND status = 'active'
            `).run(now, resolvedTeamRunId);
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
    teamRunId?: string;
    agentRunId: string;
    sessionRunId: string;
    runtimeId: string;
    answer: AgentRequestAnswer;
  }): Promise<{ storeRevision: number; agentRequest: AgentRequestRecord }> {
    const agentRequestId = requiredString(input.agentRequestId, "agentRequestId", 200);
    const expectedRequestRevision = requiredRevision(input.expectedRequestRevision, "expectedRequestRevision");
    const taskId = requiredString(input.taskId, "taskId", 200);
    const scope = normalizedTaskScope(input.scope);
    const teamRunId = input.teamRunId === undefined ? undefined : requiredString(input.teamRunId, "teamRunId", 200);
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
        if (previous.teamRunId) {
          const remaining = this.database.prepare(`
            SELECT COUNT(*) AS count
            FROM agent_requests q
            JOIN agent_runs r ON r.id = q.agent_run_id
            WHERE (r.team_run_id = ? OR r.id = (SELECT coordinator_agent_run_id FROM team_runs WHERE id = ?))
              AND q.status = 'open'
          `).get(previous.teamRunId, previous.teamRunId) as { count?: unknown } | undefined;
          if (remaining?.count === 0) {
            this.database.prepare(`
              UPDATE team_runs SET status = 'active', revision = revision + 1, updated_at = ?
              WHERE id = ? AND status = 'waiting'
            `).run(now, previous.teamRunId);
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
    teamRunId?: string;
    agentRunId: string;
    sessionRunId: string;
    runtimeId: string;
    expectedAgentRunRevision: number;
  }): Promise<{ storeRevision: number; attemptId: string }> {
    const scope = normalizedTaskScope(input.scope);
    const taskId = requiredString(input.taskId, "taskId", 200);
    const teamRunId = input.teamRunId === undefined ? undefined : requiredString(input.teamRunId, "teamRunId", 200);
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
          WHERE g.id = ? AND g.task_id = ?
            AND (
              (? IS NULL AND g.team_run_id IS NULL AND NOT EXISTS(
                SELECT 1 FROM team_runs standalone WHERE standalone.coordinator_agent_run_id = g.id
              ))
              OR (? IS NOT NULL AND (
                g.team_run_id = ? OR g.id = (SELECT coordinator_agent_run_id FROM team_runs WHERE id = ?)
              ))
            )
            AND r.id = ? AND r.runtime_id = ?
        `).get(agentRunId, taskId, teamRunId ?? null, teamRunId ?? null, teamRunId ?? null, teamRunId ?? null, sessionRunId, runtimeId) as SQLiteRow | undefined;
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
          `sha256:${payloadHash({ taskId, teamRunId: teamRunId ?? null, agentRunId, sessionRunId, runtimeId })}`,
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
            payload: { attemptId, ...(teamRunId ? { teamRunId } : {}), agentRunId, sessionRunId, runtimeId },
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
          COALESCE(
            g.team_run_id,
            (SELECT c.id FROM team_runs c
              WHERE c.coordinator_agent_run_id = g.id AND c.status = 'active'
              ORDER BY c.created_at DESC, c.id DESC LIMIT 1)
          ) AS team_run_id,
          g.role AS agent_role
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
