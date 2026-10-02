import { DEFAULT_MODEL_QUOTA_THRESHOLD_PERCENT, isModelQuotaThresholdPercent } from "./model-quota-policy.js";
import { CODEX_IMAGE_CLI_VERSION, type ImageGenerationRecord, type GeneratedImageInfo } from "./image-generation-types.js";
import {recoverAuxiliaryProcess,type AuxiliaryProcessInfo} from "./auxiliary-process.js";
import type {ProjectDirectoryChange} from "./project-directory-change.js";
import {inputSourceReceipts,type InputSourceReceipt} from "./input-expansion.js";
import type { VerificationRecord, CoordinatorReviewRecord } from "./collaboration-verification.js";
import { parseRouteOperation, readTaskRoute, readRouteWork, bindingMatchesRoute, RouteDispatchSchema, transitionTaskRoute, type RouteBinding, type RouteDispatch, type RouteWork, type RouteOperation, type TaskRouteContext } from "./task-routes.js";
import { Value } from "typebox/value";
import type { CollaborationMessage, CollaborationMessageState } from "./collaboration-message.js";
import { agentModelCandidates, type AgentModelCandidate } from "./model-route.js";
import { INSPIRATION_KEY, emptyInspiration, changeInspiration, exportIdeaMarkdown, publishIdeaMedia, removeUnreferencedIdeaMedia, resolveIdeaMedia, inspirationRoot, assertIdeaSnapshotDigest, InspirationError, type InspirationDocument, type InspirationOperation, type InspirationView } from "./inspiration.js";
import { stageAttachment, readAttachment, sweepAttachmentFiles, stagedAttachmentBytes, discardStagedAttachment, attachmentPath, attachmentPrompt, ATTACHMENT_DAY, ATTACHMENT_RETENTION_DAYS, type ManagedAttachment, type AttachmentSource } from "./attachment-files.js";
import type { MaintenanceState } from "./maintenance.js";
import { createHash, randomUUID } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { chmod, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, parse, relative, resolve } from "node:path";
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
  readDCodePromptSource,
  type DCodePromptSourceReceipt,
  type DCodePromptSourceState,
  type DCodePromptSourceUnavailableReason,
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

export interface TaskWorkbenchWorkspaceContent {
  kind: "artifact" | "report";
  id: string;
  sourceRevision?: number;
  anchorLine?: number;
}

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
  workspaceContent: TaskWorkbenchWorkspaceContent | null;
  revision: number;
}

export interface TaskWorkbenchViewStatePatch {
  selection?: { taskId: string | null; sessionId: string | null };
  expandedHudSections?: string[];
  inspectorTarget?: TaskWorkbenchInspectorTarget | null;
  workspaceContent?: TaskWorkbenchWorkspaceContent | null;
}

export interface WebEvolutionReceipt {
  id:string;kind:"web_switch";state:"restart_requested"|"session_restored"|"manual_accepted"|"recovery_required"|"rolled_back"|"cancelled";
  fromApp:string;toApp:string;fromDigest:string;toDigest:string;rollbackOf?:string;
  selection:{taskId:string|null;sessionId:string|null};createdAt:string;updatedAt:string;
  events:{kind:string;occurredAt:string;issue?:string}[];
}

export interface ClientPreferences {
  /** UI and new Agent output language; historical source text remains immutable. */
  language?: "zh-CN" | "en";
  modelQuotaThresholdPercent: number;
  appearance?: "system" | "light" | "dark";
  fontScale?: "compact" | "standard" | "large";
  sidebarVisible?: boolean;
  overviewVisible?: boolean;
  sidebarWidth?: number;
  inspectorWidth?: number;
  defaultThinking?: string;
  enabledModels?: string[] | null;
  /** Derived from one-way imported rules; not a mutable preference field. */
  enabledModelPatterns?: string[];
  disabledResources?: string[];
  notificationsEnabled: boolean;
  readingPositions: Record<string, number>;
}

export interface ComposerDraftRecord {
  /** Explicit Task Goal draft for a new Task; never replaces submitted message text. */
  goal?: string;
  acceptance?: string[];
  pendingWorkflowSubmission?: PendingWorkflowSubmissionRecord;
  pathAction?:NativeSessionPathAction;
  pathDraftBackup?:{text:string;attachmentIds:string[];attachments?:ManagedAttachment[];targetAgentRunId?:string};
  targetAgentRunId?: string;
  attachments?: ManagedAttachment[];
  scope?: TaskScope;
  id: string;
  taskId?: string;
  sessionId?: string;
  draftKind: "new_task" | "session_path";
  text: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface PendingWorkflowSubmissionRecord {
  promptId:string;
  kind:"create"|"report";
  sourceDraftKey:string;
  goal?:string;
  constraints?:string[];
  runId?:string;
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
  modelCandidates?: AgentModelCandidate[];
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

export interface TaskGoalRevisionRecord {
  taskId: string;
  goal: string;
  acceptance: string[];
  taskRevision: number;
  changedAt: string;
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
  inspirationVersion?: { nodeId: string; revision: number; digest: string };
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
  /** Derived at read time; not another persisted plan state. */
  routeContextCurrent?: boolean;
  routeInputCurrent?: boolean;
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

export interface TaskWorkflowStageInput {
  id: string;
  title: string;
  completion: string;
  dependsOn: string[];
}

export interface TaskWorkflowDraftInput {
  goal: string;
  constraints?: string[];
}

export interface TaskWorkflowRecord {
  id: string;
  taskId: string;
  originRawInputId: string;
  currentVersion: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskWorkflowVersionRecord {
  workflowId: string;
  version: number;
  originRawInputId: string;
  goalRevision: number;
  goal: string;
  constraints: string[];
  createdAt: string;
}

export interface TaskWorkflowStageRecord extends TaskWorkflowStageInput {
  workflowId: string;
  version: number;
  ordinal: number;
}

export interface TaskWorkflowRunRecord {
  id: string;
  taskId: string;
  workflowId: string;
  version: number;
  status: "active" | "stopped" | "interrupted" | "completed";
  reason?: string;
  completionReportId?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface TaskWorkflowWorkItemBinding {
  runId: string;
  stageId: string;
  workItemId: string;
  createdAt: string;
}

export interface TaskWorkflowReportBinding {
  runId: string;
  workflowId: string;
  version: number;
  coordinatorReportId: string;
  goalRevision: number;
  latestInputSequence: number;
  finalReviewSequence: number;
  createdAt: string;
}

export type TaskSummarySection = "confirmed" | "pending" | "blocked" | "next";
export interface TaskSummarySourceRef {
  kind: "task" | "task_route" | "work_item" | "agent_report" | "raw_input" | "summary_revision" | "user_correction";
  id: string;
  revision?: number;
}
export interface TaskSummaryClaim {
  text: string;
  sources: TaskSummarySourceRef[];
}
export interface TaskSummaryRecord {
  id: string;
  taskId: string;
  revision: number;
  trigger: "new_session" | "compaction" | "member_restart" | "user_correction";
  factsDigest: string;
  digest: string;
  sections: Record<TaskSummarySection, TaskSummaryClaim[]>;
  basedOnRevision: number;
  previousRevision?: number;
  createdAt: string;
  /** Derived from current Task facts when read, never used to rewrite an old run. */
  current?: boolean;
}
export interface TaskSummaryFailureRecord { taskId: string; sessionId: string; trigger: string; reasonCode: string; createdAt: string }
export interface TaskReviewRequestRecord {
  id: string;
  taskId: string;
  sessionId: string;
  evidenceId: string;
  path: string;
  staged: boolean;
  digest: string;
  baseHead: string;
  rootDigest: string;
  workItemId?: string;
  workItemExplicit: boolean;
  createdAt: string;
}
export interface TaskRecallEntryCandidate {
  sessionId: string;
  entryId: string;
  role: string;
  title: string;
  digest: string;
  createdAt: string;
}
export interface TaskSourceUseRecord {
  id: string;
  taskId: string;
  sessionRunId: string;
  agentRunId?: string;
  kind: "task_message" | "work_item" | "agent_report" | "evidence" | "project_file" | "inspiration";
  sourceId: string;
  digest: string;
  bytes: number;
  version?: number;
  projectId?: string;
  rootDigest?: string;
  createdAt: string;
}
export type TaskSummaryReceipt = Pick<TaskSummaryRecord, "id" | "taskId" | "revision" | "digest" | "trigger" | "createdAt">;

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

export interface NativeSessionPathAction {
  kind:"editUser"|"continueAssistant"|"continuePath";
  entryId:string;
  fromPathId:string;
  expectedCurrentPathId:string;
  expectedCurrentPathRevision:number;
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
  workflow?: TaskWorkflowRecord;
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
  inputSources?:InputSourceReceipt[];
  taskSummary?: TaskSummaryReceipt;
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

export type TaskSourceSelector =
  | { taskId: string; contextSourceId: string }
  | { taskId: string; promptReceiptId: string; sourceIndex: number };

export interface TaskSourceReadResult {
  title: string;
  path: string;
  kind: DCodePromptSourceReceipt["kind"];
  digest: string;
  state: DCodePromptSourceState["state"];
  contentStored: false;
  content?: string;
  version?: number;
  currentVersion?: number;
  currentDigest?: string;
  unavailableReason?: DCodePromptSourceUnavailableReason | "credential_material" | "invalid_utf8" | "snapshot_identity_mismatch";
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

export type AgentRequestKind = "choice" | "task_acceptance";

export interface AgentRequestRecord {
  id: string;
  taskId: string;
  teamRunId?: string;
  agentRunId: string;
  sessionId: string;
  sessionRunId: string;
  runtimeId: string;
  kind: AgentRequestKind;
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

export interface AgentRequestChoiceAnswer {
  kind: "choice";
  optionId: string;
}

export interface TaskAcceptanceAnswer {
  kind: "task_acceptance";
  outcome: "accepted" | "feedback";
  feedback?: string;
}

export type AgentRequestAnswer = AgentRequestChoiceAnswer | TaskAcceptanceAnswer;

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

/** Read-only facts bound by the Host to a native Task, Session and running actor. */
export interface NativeSessionFacts {
  taskId:string;sessionId:string;agentRunId?:string;sessionRunId?:string;
  totalEvidence:number;
  evidence:Array<Pick<EvidenceRecord,"id"|"evidenceKind"|"commandRedacted"|"exitKind"|"exitCode"|"agentRunId"|"createdAt">&{sessionRunId?:string;legacyRunId?:string;resultDigest?:string;isCurrentRun:boolean}>;
  totalHistoricalFileChanges:number;
  historicalFileChanges:Array<{id:string;legacyRunId?:string;filePath:string;operation:string;additions:number;deletions:number;firstChangedLine?:number;occurredAt:string;sourceKind:string}>;
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
  taskWorkflows: TaskWorkflowRecord[];
  taskWorkflowVersions: TaskWorkflowVersionRecord[];
  taskWorkflowStages: TaskWorkflowStageRecord[];
  taskWorkflowRuns: TaskWorkflowRunRecord[];
  taskWorkflowWorkItems: TaskWorkflowWorkItemBinding[];
  taskWorkflowReports: TaskWorkflowReportBinding[];
  taskSummaries: TaskSummaryRecord[];
  taskSummaryFailures: TaskSummaryFailureRecord[];
  taskReviewRequests: TaskReviewRequestRecord[];
  taskSourceUses: TaskSourceUseRecord[];
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
  verifications?: VerificationRecord[];
  coordinatorReviews?: CoordinatorReviewRecord[];
  agentProcesses?: ReturnType<ProductStore["agentProcessExecutions"]>;
  auxiliaryProcesses?:ReturnType<ProductStore["auxiliaryProcessExecutions"]>;
  collaborationMessages?: CollaborationMessage[];
  collaborationQueues?:Array<{sessionId:string;revision:number;messageIds:string[]}>;
  providerCalls?:Array<import("./provider-route-stream.js").ProviderCallRecord&{taskId:string;sessionId?:string;sessionRunId?:string;agentRunId?:string}>;
  projectDirectoryChanges?:ProjectDirectoryChange[];
  runtimeDialogs?:Array<import("./extension-ui.js").RuntimeDialog&{runtimeId:string;taskId:string;sessionId:string}>;
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
      | "SESSION_RUNTIME_ALREADY_BOUND"
      | "ATTACHMENT_STORAGE_FULL" | "ATTACHMENT_LIMIT" | "ATTACHMENT_EXPIRED",
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

function normalizedWorkflowConstraints(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw new ProductStoreError("INVALID_ARGUMENT", "Workflow constraints must contain at most 32 items");
  }
  return value.map((item, index) => requiredCredentialFreeString(item, `constraints[${index}]`, 2_000).trim());
}

function normalizedWorkflowDraft(value: unknown): { goal: string; constraints: string[] } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProductStoreError("INVALID_ARGUMENT", "Workflow draft must contain a goal and optional constraints");
  }
  const draft = value as Record<string, unknown>;
  if (Object.keys(draft).some(key => !["goal", "constraints"].includes(key))) {
    throw new ProductStoreError("INVALID_ARGUMENT", "Workflow draft contains unsupported fields");
  }
  return { goal: requiredCredentialFreeString(draft.goal, "workflowDraft.goal", 20_000).trim(),
    constraints: normalizedWorkflowConstraints(draft.constraints ?? []) };
}

function normalizedPendingWorkflowSubmission(value:unknown):PendingWorkflowSubmissionRecord {
  if(typeof value!=="object"||value===null||Array.isArray(value))throw new ProductStoreError("INVALID_ARGUMENT","待核对工作流提交无效");
  const input=value as Record<string,unknown>;
  if(Object.keys(input).some(key=>!["promptId","kind","sourceDraftKey","goal","constraints","runId"].includes(key)))throw new ProductStoreError("INVALID_ARGUMENT","待核对工作流提交字段无效");
  const promptId=requiredString(input.promptId,"pendingWorkflowSubmission.promptId",128);
  const sourceDraftKey=requiredString(input.sourceDraftKey,"pendingWorkflowSubmission.sourceDraftKey",250);
  if(input.kind==="create"){
    const draft=normalizedWorkflowDraft({goal:input.goal,constraints:input.constraints??[]});
    return {promptId,kind:"create",sourceDraftKey,goal:draft.goal,constraints:draft.constraints};
  }
  if(input.kind==="report")return {promptId,kind:"report",sourceDraftKey,runId:requiredString(input.runId,"pendingWorkflowSubmission.runId",200)};
  throw new ProductStoreError("INVALID_ARGUMENT","待核对工作流提交类型无效");
}

function normalizedWorkflowStages(value: unknown): TaskWorkflowStageInput[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 24) {
    throw new ProductStoreError("INVALID_ARGUMENT", "Workflow requires 1…24 stages");
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new ProductStoreError("INVALID_ARGUMENT", `stages[${index}] must be an object`);
    }
    const stage = entry as Record<string, unknown>;
    if (Object.keys(stage).some(key => !["id", "title", "completion", "dependsOn"].includes(key))) {
      throw new ProductStoreError("INVALID_ARGUMENT", `stages[${index}] contains unsupported fields`);
    }
    const id = requiredString(stage.id, `stages[${index}].id`, 100);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id) || seen.has(id)) {
      throw new ProductStoreError("INVALID_ARGUMENT", `stages[${index}].id must be unique and stable`);
    }
    const title = requiredCredentialFreeString(stage.title, `stages[${index}].title`, 500).trim();
    const completion = requiredCredentialFreeString(stage.completion, `stages[${index}].completion`, 10_000).trim();
    if (!Array.isArray(stage.dependsOn) || stage.dependsOn.length > 24) {
      throw new ProductStoreError("INVALID_ARGUMENT", `stages[${index}].dependsOn is invalid`);
    }
    const dependsOn = stage.dependsOn.map((dependency, dependencyIndex) =>
      requiredString(dependency, `stages[${index}].dependsOn[${dependencyIndex}]`, 100));
    if (new Set(dependsOn).size !== dependsOn.length || dependsOn.some(dependency => !seen.has(dependency))) {
      throw new ProductStoreError("INVALID_ARGUMENT", `stages[${index}] may depend only on distinct earlier stages`);
    }
    seen.add(id);
    return { id, title, completion, dependsOn };
  });
}

const TASK_WORKBENCH_HUD_SECTIONS = new Set(["progress", "team", "waiting", "deliverables"]);
const DEFAULT_TASK_WORKBENCH_HUD_SECTIONS = [...TASK_WORKBENCH_HUD_SECTIONS].sort();
const TASK_WORKBENCH_INSPECTOR_KINDS = new Set(["artifact", "evidence", "report", "context"]);
const TASK_WORKBENCH_CONTENT_KINDS = new Set(["artifact", "report"]);

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

function normalizedTaskWorkbenchWorkspaceContent(value: unknown): TaskWorkbenchWorkspaceContent | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ProductStoreError("INVALID_ARGUMENT", "Task Workbench workspaceContent must be an object or null");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(["kind", "id", "sourceRevision", "anchorLine"]);
  if (
    Object.keys(record).some((key) => !allowed.has(key))
    || !TASK_WORKBENCH_CONTENT_KINDS.has(record.kind as string)
  ) {
    throw new ProductStoreError("INVALID_ARGUMENT", "Task Workbench workspaceContent is invalid");
  }
  const kind = record.kind as TaskWorkbenchWorkspaceContent["kind"];
  const id = requiredCredentialFreeString(record.id, "Task Workbench workspaceContent.id", 200);
  const sourceRevision = record.sourceRevision === undefined
    ? undefined
    : requiredRevision(record.sourceRevision, "Task Workbench workspaceContent.sourceRevision");
  const anchorLine = record.anchorLine === undefined
    ? undefined
    : requiredRevision(record.anchorLine, "Task Workbench workspaceContent.anchorLine");
  if (kind !== "artifact" && sourceRevision !== undefined) {
    throw new ProductStoreError("INVALID_ARGUMENT", "Only Artifact workspace content can carry sourceRevision");
  }
  return {
    kind,
    id,
    ...(sourceRevision === undefined ? {} : { sourceRevision }),
    ...(anchorLine === undefined ? {} : { anchorLine }),
  };
}

function normalizedTaskWorkbenchViewState(
  value: unknown,
  revision: number,
): TaskWorkbenchViewStateRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProductStoreError("INVALID_ARGUMENT", "Task Workbench View State must be an object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(["version", "selection", "expandedHudSections", "inspectorTarget", "workspaceContent"]);
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
    workspaceContent: normalizedTaskWorkbenchWorkspaceContent(record.workspaceContent),
    revision,
  };
}

function normalizedTaskWorkbenchViewStatePatch(value: unknown): TaskWorkbenchViewStatePatch {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProductStoreError("INVALID_ARGUMENT", "Task Workbench View State patch must be an object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(["selection", "expandedHudSections", "inspectorTarget", "workspaceContent"]);
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
      workspaceContent: null,
    }, 0);
    patch.expandedHudSections = state.expandedHudSections;
  }
  if ("inspectorTarget" in record) {
    patch.inspectorTarget = normalizedTaskWorkbenchInspectorTarget(record.inspectorTarget);
  }
  if ("workspaceContent" in record) {
    patch.workspaceContent = normalizedTaskWorkbenchWorkspaceContent(record.workspaceContent);
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

function managedInspirationVersion(source:Pick<TaskContextSourceRecord,"kind"|"rootPath"|"relativePath">,managedRoot:string|undefined):TaskContextSourceRecord["inspirationVersion"] {
  if(source.kind!=="global_knowledge"||!managedRoot||!source.rootPath||resolve(source.rootPath)!==resolve(managedRoot))return undefined;
  const match=/^(idea-[a-f0-9-]{36})\/r([1-9]\d*)-([a-f0-9]{64})\.md$/.exec(source.relativePath);
  return match?{nodeId:match[1]!,revision:Number(match[2]),digest:`sha256:${match[3]}`}:undefined;
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

function taskWorkflow(row: SQLiteRow): TaskWorkflowRecord {
  return {
    id: text(row, "id"),
    taskId: text(row, "task_id"),
    originRawInputId: text(row, "origin_raw_input_id"),
    currentVersion: integer(row, "current_version"),
    revision: integer(row, "revision"),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
  };
}

function taskWorkflowVersion(row: SQLiteRow): TaskWorkflowVersionRecord {
  return {
    workflowId: text(row, "workflow_id"),
    version: integer(row, "version"),
    originRawInputId: text(row, "origin_raw_input_id"),
    goalRevision: integer(row, "goal_revision"),
    goal: text(row, "goal"),
    constraints: JSON.parse(text(row, "constraints_json")) as string[],
    createdAt: text(row, "created_at"),
  };
}

function taskWorkflowStage(row: SQLiteRow): TaskWorkflowStageRecord {
  return {
    workflowId: text(row, "workflow_id"),
    version: integer(row, "version"),
    id: text(row, "id"),
    ordinal: integer(row, "ordinal"),
    title: text(row, "title"),
    completion: text(row, "completion"),
    dependsOn: JSON.parse(text(row, "depends_on_json")) as string[],
  };
}

function taskWorkflowRun(row: SQLiteRow): TaskWorkflowRunRecord {
  return {
    id: text(row, "id"),
    taskId: text(row, "task_id"),
    workflowId: text(row, "workflow_id"),
    version: integer(row, "version"),
    status: text(row, "status") as TaskWorkflowRunRecord["status"],
    ...(typeof row.reason === "string" ? { reason: row.reason } : {}),
    ...(typeof row.completion_report_id === "string" ? { completionReportId: row.completion_report_id } : {}),
    revision: integer(row, "revision"),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
    ...(typeof row.completed_at === "string" ? { completedAt: row.completed_at } : {}),
  };
}

function taskWorkflowWorkItem(row: SQLiteRow): TaskWorkflowWorkItemBinding {
  return {
    runId: text(row, "run_id"),
    stageId: text(row, "stage_id"),
    workItemId: text(row, "work_item_id"),
    createdAt: text(row, "created_at"),
  };
}

function taskWorkflowReport(row: SQLiteRow): TaskWorkflowReportBinding {
  return {
    runId: text(row, "run_id"), workflowId: text(row, "workflow_id"),
    version: integer(row, "version"), coordinatorReportId: text(row, "coordinator_report_id"),
    goalRevision: integer(row, "goal_revision"),
    latestInputSequence: integer(row, "latest_input_sequence"),
    finalReviewSequence: integer(row, "final_review_sequence"),
    createdAt: text(row, "created_at"),
  };
}

function composerDraft(row: SQLiteRow): ComposerDraftRecord {
  const payload = JSON.parse(text(row, "payload_json")) as { scope?: unknown; goal?: unknown; acceptance?: unknown; pendingWorkflowSubmission?:unknown; attachments?: ManagedAttachment[]; targetAgentRunId?: string;pathAction?:NativeSessionPathAction;pathDraftBackup?:ComposerDraftRecord["pathDraftBackup"] };
  return {
    ...(payload?.scope ? { scope: normalizedTaskScope(payload.scope) } : {}),
    ...(typeof payload.goal === "string" ? {goal:payload.goal} : {}),
    ...(Array.isArray(payload.acceptance) ? {acceptance:parseStringArray(payload.acceptance,"stored acceptance")} : {}),
    ...(payload.pendingWorkflowSubmission?{pendingWorkflowSubmission:normalizedPendingWorkflowSubmission(payload.pendingWorkflowSubmission)}:{}),
    ...(payload.attachments?.length ? {attachments:payload.attachments} : {}),
    ...(payload.targetAgentRunId?{targetAgentRunId:payload.targetAgentRunId}:{}),
    ...(payload.pathAction?{pathAction:payload.pathAction}:{}),
    ...(payload.pathDraftBackup?{pathDraftBackup:payload.pathDraftBackup}:{}),
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
    kind: text(row, "kind") as AgentRequestKind,
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
  inputSources?:InputSourceReceipt[];
  taskSummary?: TaskSummaryReceipt;
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
    inputSources?:unknown;
    taskSummary?:unknown;
  };
  if (payload.version !== 2) {
    throw new DCodePromptSourceReceiptError("Prompt Receipt sources have an unsupported version");
  }
  return {
    sourceReceipts: normalizeDCodePromptSourceReceipts(payload.documentSources),
    ...(payload.inputSources!==undefined?{inputSources:inputSourceReceipts(payload.inputSources)}:{}),
    ...(payload.taskSummary === undefined ? {} : { taskSummary: normalizedTaskSummaryReceipt(payload.taskSummary) }),
    ...(payload.importedHistory === undefined
      ? {}
      : { importedHistoryReceipt: normalizeImportedSessionHistoryReceipt(payload.importedHistory) }),
  };
}

function normalizedTaskSummaryReceipt(value: unknown): TaskSummaryReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProductStoreError("INVALID_ARGUMENT", "任务摘要回执无效");
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some(key => !["id", "taskId", "revision", "digest", "trigger", "createdAt"].includes(key))
    || typeof item.id !== "string" || item.id.length > 240 || typeof item.taskId !== "string" || item.taskId.length > 200
    || !Number.isSafeInteger(item.revision) || (item.revision as number) < 1
    || typeof item.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(item.digest)
    || !["new_session", "compaction", "member_restart", "user_correction"].includes(item.trigger as string)
    || typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt))) {
    throw new ProductStoreError("INVALID_ARGUMENT", "任务摘要回执无效");
  }
  return item as unknown as TaskSummaryReceipt;
}

function promptReceipt(row: SQLiteRow): PromptReceiptRecord {
  let sources: {
    sourceReceipts: DCodePromptSourceReceipt[];
    importedHistoryReceipt?: ImportedSessionHistoryReceipt;
    inputSources?:InputSourceReceipt[];
    taskSummary?: TaskSummaryReceipt;
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
    ...(sources.inputSources?{inputSources:sources.inputSources}:{}),
    ...(sources.taskSummary ? { taskSummary: sources.taskSummary } : {}),
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
  private closing = false;
  private closePromise?: Promise<void>;
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
      await store.recoverCollaborationResults();
      await store.recoverInterruptedRuns();
      for(const execution of store.agentProcessExecutions()) {
        if(execution.process.status!=="exited") await store.recordAgentProcess({requestId:`recover-process:${randomUUID()}`,taskId:execution.taskId,agentRunId:execution.agentRunId,runtimeId:execution.runtimeId,process:{...execution.process,status:"exited",exitReason:"supervisor_restarted"}});
      }
      for(const execution of store.auxiliaryProcessExecutions())if(execution.process.status!=="exited")await store.recordAuxiliaryProcess({...execution,requestId:`recover-auxiliary:${randomUUID()}`,process:await recoverAuxiliaryProcess(execution.process)});
      for(const message of store.collaborationMessages()) {
        if(message.state==="delivering"||message.state==="queued") await store.transitionCollaborationMessage({requestId:`recover-message:${randomUUID()}`,id:message.id,expectedRevision:message.revision,state:message.state==="delivering"?"interrupted":"paused",error:message.state==="delivering"?"上次运行已中断，请先核对结果再交办新工作":"已恢复未发送消息，继续后才会发送"});
      }
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
    const workflowRunning = this.database.prepare(`
      SELECT COUNT(*) AS count FROM task_workflow_runs WHERE status = 'active'
    `).get() as { count?: unknown } | undefined;
    const openRequests = this.database.prepare(`
      SELECT COUNT(*) AS count FROM agent_requests
      WHERE status = 'open' AND kind <> 'task_acceptance'
    `).get() as { count?: unknown } | undefined;
    const openAcceptanceRequests = this.database.prepare(`
      SELECT COUNT(*) AS count FROM agent_requests
      WHERE status = 'open' AND kind = 'task_acceptance'
    `).get() as { count?: unknown } | undefined;
    if (
      (pending?.count ?? 0) === 0
      && (running?.count ?? 0) === 0
      && (agentRunning?.count ?? 0) === 0
      && (teamRunning?.count ?? 0) === 0
      && (workflowRunning?.count ?? 0) === 0
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
      this.database.prepare("UPDATE task_work_items SET state='blocked',revision=revision+1,updated_at=? WHERE state='in_progress' AND owner_assignment_id IN (SELECT a.id FROM agent_assignments a JOIN agent_runs g ON a.agent_run_id=g.id WHERE g.status='interrupted')").run(now);
      this.database.prepare(`
        UPDATE team_runs
        SET status = 'interrupted', revision = revision + 1, updated_at = ?
        WHERE status IN ('prepared', 'active', 'waiting')
      `).run(now);
      this.database.prepare(`
        UPDATE task_workflow_runs
        SET status = 'interrupted', reason = 'host_restarted',
            revision = revision + 1, updated_at = ?
        WHERE status = 'active'
      `).run(now);
      this.database.prepare(`
        UPDATE agent_requests
        SET status = 'cancelled', answer_json = ?, revision = revision + 1, updated_at = ?
        WHERE status = 'open' AND kind <> 'task_acceptance'
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
          interruptedWorkflowRuns: typeof workflowRunning?.count === "number" ? workflowRunning.count : 0,
          cancelledAgentRequests: typeof openRequests?.count === "number" ? openRequests.count : 0,
          preservedTaskAcceptanceRequests: typeof openAcceptanceRequests?.count === "number"
            ? openAcceptanceRequests.count
            : 0,
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

  sessionModelSelection(sessionId:string):RuntimeModelSelectionRecord|undefined {
    this.assertOpen();const row=this.database.prepare("SELECT * FROM product_settings WHERE key=?").get(`session.modelSelection:${sessionId}`) as SQLiteRow|undefined;if(!row)return undefined;
    const value=JSON.parse(text(row,"value_json"));return {providerId:value.providerId,modelId:value.modelId,sourceKind:"user",revision:integer(row,"revision")};
  }

  async replaySessionModelSelection(input:{requestId:string;sessionId:string;providerId:string;modelId:string}):Promise<unknown>{return this.replayReceipt("sessionModel.select",`session-model:${payloadHash(input.requestId).slice(0,48)}`,{sessionId:input.sessionId,providerId:input.providerId,modelId:input.modelId});}

  async setSessionModelSelection(input:{requestId:string;sessionId:string;providerId:string;modelId:string}):Promise<{storeRevision:number}> {
    return this.mutate("sessionModel.select",`session-model:${payloadHash(input.requestId).slice(0,48)}`,undefined,{sessionId:input.sessionId,providerId:input.providerId,modelId:input.modelId},(_revision,now)=>{
      const session=this.database.prepare("SELECT task_id FROM sessions WHERE id=?").get(input.sessionId) as SQLiteRow|undefined;
      if(!session||!this.database.prepare("SELECT id FROM model_catalog_entries WHERE provider_id=? AND model_id=?").get(input.providerId,input.modelId))throw new ProductStoreError("NOT_FOUND","会话或模型不存在");
      if(this.database.prepare("SELECT id FROM session_runs WHERE session_id=? AND status IN ('prepared','running','waiting')").get(input.sessionId))throw new ProductStoreError("REVISION_CONFLICT","当前运行尚未结束，不能更换模型");
      this.database.prepare("INSERT INTO product_settings(key,value_json,source_kind,revision,created_at,updated_at) VALUES (?,?,'user',1,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,revision=product_settings.revision+1,updated_at=excluded.updated_at").run(`session.modelSelection:${input.sessionId}`,canonicalJSON({providerId:input.providerId,modelId:input.modelId}),now,now);
      this.database.prepare("UPDATE agent_runs SET model_provider=?,model_id=?,revision=revision+1,updated_at=? WHERE session_id=?").run(input.providerId,input.modelId,now,input.sessionId);
      return {value:{},event:{kind:"sessionModel.selected",entityKind:"session",entityId:input.sessionId,taskId:text(session,"task_id"),payload:input}};
    });
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
        workspaceContent: null,
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
          workspaceContent: patch.workspaceContent === undefined ? current.workspaceContent : patch.workspaceContent,
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
          workspaceContent: state.workspaceContent,
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

  webEvolutionReceipts(): WebEvolutionReceipt[] {
    return (this.database.prepare("SELECT payload_json FROM self_evolution_runs WHERE json_extract(payload_json,'$.kind')='web_switch' ORDER BY created_at DESC LIMIT 50").all() as SQLiteRow[]).map(row=>JSON.parse(text(row,"payload_json")) as WebEvolutionReceipt);
  }
  async prepareWebEvolution(input:{requestId:string;expectedStoreRevision:number;fromApp:string;toApp:string;fromDigest:string;toDigest:string;rollbackOf?:string}):Promise<{storeRevision:number;receipt:WebEvolutionReceipt}> {
    for(const key of ["fromApp","toApp"] as const)if(!isAbsolute(input[key])||!input[key].endsWith(".app"))throw new ProductStoreError("INVALID_ARGUMENT","Invalid application bundle");
    for(const key of ["fromDigest","toDigest"] as const)if(!/^sha256:[a-f0-9]{64}$/.test(input[key]))throw new ProductStoreError("INVALID_ARGUMENT","Invalid application digest");
    return this.mutate("selfEvolution.prepare",input.requestId,input.expectedStoreRevision,input,(_revision,now)=>{
      const history=this.webEvolutionReceipts();
      if(!input.rollbackOf&&history.some(r=>["restart_requested","session_restored","recovery_required"].includes(r.state)))throw new ProductStoreError("REVISION_CONFLICT","请先验收或回滚上一次候选");
      if(input.rollbackOf){const previous=history.find(r=>r.id===input.rollbackOf);if(!previous||previous.fromApp!==input.toApp||previous.toApp!==input.fromApp||previous.fromDigest!==input.toDigest)throw new ProductStoreError("INVALID_ARGUMENT","Rollback identity does not match previous application");}
      else if(this.maintenanceState()?.candidatePath!==input.toApp||this.maintenanceState()?.status!=="succeeded")throw new ProductStoreError("INVALID_ARGUMENT","Candidate has not completed the local build");
      const id=`evolution-${randomUUID()}`;
      const receipt:WebEvolutionReceipt={id,kind:"web_switch",state:"restart_requested",fromApp:input.fromApp,toApp:input.toApp,fromDigest:input.fromDigest,toDigest:input.toDigest,...(input.rollbackOf?{rollbackOf:input.rollbackOf}:{}),selection:this.taskWorkbenchViewState().selection,createdAt:now,updatedAt:now,events:[{kind:"restart_requested",occurredAt:now}]};
      this.database.prepare("INSERT INTO self_evolution_runs(id,source_run_id,state,document_revision,payload_json,created_at,updated_at) VALUES (?,?,?,1,?,?,?)").run(id,id,receipt.state,canonicalJSON(receipt),now,now);
      this.database.prepare("INSERT INTO self_evolution_events(id,self_evolution_run_id,ordinal,event_json,created_at) VALUES (?,?,0,?,?)").run(`event-${randomUUID()}`,id,canonicalJSON(receipt.events[0]),now);
      return {value:{receipt},event:{kind:"selfEvolution.restartRequested",entityKind:"selfEvolution",entityId:id,payload:{fromApp:input.fromApp,toApp:input.toApp}}};
    });
  }
  async transitionWebEvolution(input:{requestId:string;expectedStoreRevision:number;id:string;state:WebEvolutionReceipt["state"];selection?:WebEvolutionReceipt["selection"];issue?:string}):Promise<{storeRevision:number;receipt:WebEvolutionReceipt}> {
    return this.mutate("selfEvolution.transition",input.requestId,input.expectedStoreRevision,input,(_revision,now)=>{
      const previous=this.webEvolutionReceipts().find(r=>r.id===input.id);if(!previous)throw new ProductStoreError("NOT_FOUND","Evolution receipt not found");
      const allowed:Record<string,string[]>={restart_requested:["session_restored","recovery_required","rolled_back","cancelled"],session_restored:["manual_accepted","recovery_required","rolled_back","cancelled"],manual_accepted:[],recovery_required:["rolled_back","session_restored","cancelled"],rolled_back:[],cancelled:[]};
      if(!(allowed[previous.state]??[]).includes(input.state))throw new ProductStoreError("REVISION_CONFLICT","Evolution state has changed");
      if(input.state==="session_restored"&&(previous.selection.taskId!==input.selection?.taskId||previous.selection.sessionId!==input.selection?.sessionId))throw new ProductStoreError("REVISION_CONFLICT","原任务尚未恢复");
      if(input.issue)requiredCredentialFreeString(input.issue,"issue",2000);
      const event={kind:input.state,occurredAt:now,...(input.issue?{issue:input.issue}:{})};const receipt={...previous,state:input.state,updatedAt:now,events:[...previous.events,event]};
      this.database.prepare("UPDATE self_evolution_runs SET state=?,document_revision=document_revision+1,payload_json=?,updated_at=? WHERE id=?").run(receipt.state,canonicalJSON(receipt),now,receipt.id);
      this.database.prepare("INSERT INTO self_evolution_events(id,self_evolution_run_id,ordinal,event_json,created_at) VALUES (?,?,?,?,?)").run(`event-${randomUUID()}`,receipt.id,receipt.events.length-1,canonicalJSON(event),now);
      if(previous.rollbackOf&&input.state==="rolled_back"){
        const original=this.webEvolutionReceipts().find(r=>r.id===previous.rollbackOf);if(original){const updated={...original,state:"rolled_back",updatedAt:now,events:[...original.events,event]};this.database.prepare("UPDATE self_evolution_runs SET state='rolled_back',document_revision=document_revision+1,payload_json=?,updated_at=? WHERE id=?").run(canonicalJSON(updated),now,original.id);}
      }
      return {value:{receipt},event:{kind:`selfEvolution.${input.state}`,entityKind:"selfEvolution",entityId:input.id,payload:{state:input.state}}};
    });
  }

  maintenanceState(): MaintenanceState | undefined {
    const row=this.database.prepare("SELECT value_json FROM product_settings WHERE key='maintenance.latest'").get() as SQLiteRow | undefined;
    return row ? JSON.parse(text(row,"value_json")) as MaintenanceState : undefined;
  }
  async recordMaintenance(state: MaintenanceState): Promise<void> {
    const {sourceDirectory,candidatePath,...details}=state;
    assertCredentialFreeValue(details,"maintenance");
    for(const [key,path] of Object.entries({sourceDirectory,candidatePath}))if(path!==undefined){
      if(!isAbsolute(path)||/[\r\n\0]/.test(path))throw new ProductStoreError("INVALID_ARGUMENT","Invalid maintenance path");
      // Validate path components separately: a full source path plus build UUID
      // resembles a mixed-case token to the generic credential detector.
      assertCredentialFreeValue(path.split("/"),`maintenance.${key}`);
    }
    await this.mutate("maintenance.record",`maintenance-${randomUUID()}`,undefined,{id:state.id,status:state.status,updatedAt:state.updatedAt},(_revision,now)=>{
      this.database.prepare("INSERT INTO product_settings(key,value_json,source_kind,revision,created_at,updated_at) VALUES ('maintenance.latest',?,'user',1,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,revision=product_settings.revision+1,updated_at=excluded.updated_at").run(canonicalJSON(state),now,now);
      return {value:{},event:{kind:"maintenance.updated",entityKind:"maintenance",entityId:state.id??"latest",payload:{status:state.status}}};
    });
  }

  importedSetting(key:string): unknown {
    const row=this.database.prepare("SELECT value_json FROM product_settings WHERE key=?").get(key) as SQLiteRow|undefined;
    return row ? JSON.parse(text(row,"value_json")) : undefined;
  }
  async importLegacyPreferences(input:{requestId:string;expectedStoreRevision:number;values:Record<string,unknown>}):Promise<{storeRevision:number;imported:boolean}> {
    if(this.importedSetting("workbench.webLegacyPreferencesImported")===true)return {storeRevision:this.metaInteger("store_revision"),imported:false};
    const allowed=new Set(["dcode.appearance","dcode.appearance.fontScale","dcode.sidebar.userHidden","dcode.inspector.userHidden","dcode.sidebar.width","dcode.inspector.width","dcode.notifications.completionEnabled"]);
    const entries=Object.entries(input.values).filter(([key])=>allowed.has(key));
    for(const [key,value] of entries){if(key.endsWith("width")?typeof value!=="number"||!Number.isFinite(value)||value<180||value>600:key.endsWith("userHidden")||key.endsWith("completionEnabled")?typeof value!=="boolean":key.endsWith("fontScale")?!["compact","standard","large"].includes(value as string):!["system","light","dark"].includes(value as string))throw new ProductStoreError("INVALID_ARGUMENT","Invalid legacy preference");}
    return this.mutate<{imported:boolean}>("clientPreferences.importLegacy",input.requestId,input.expectedStoreRevision,{entries},(_revision,now)=>{
      if(this.importedSetting("workbench.webLegacyPreferencesImported")===true)return {value:{imported:false},event:{kind:"clientPreferences.imported",entityKind:"productSetting",entityId:"workbench.webLegacyPreferencesImported",payload:{keys:[]}}};
      for(const [key,value] of entries)this.database.prepare("INSERT INTO product_settings(key,value_json,source_kind,revision,created_at,updated_at) VALUES (?,?,'legacy_user_defaults',1,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,revision=product_settings.revision+1,updated_at=excluded.updated_at WHERE product_settings.source_kind='legacy_user_defaults'").run(key,canonicalJSON(value),now,now);
      this.database.prepare("INSERT INTO product_settings(key,value_json,source_kind,revision,created_at,updated_at) VALUES ('workbench.webLegacyPreferencesImported','true','user',1,?,?)").run(now,now);
      return {value:{imported:true},event:{kind:"clientPreferences.imported",entityKind:"productSetting",entityId:"workbench.webLegacyPreferencesImported",payload:{keys:entries.map(([key])=>key)}}};
    });
  }

  imageGenerations(taskId?:string):ImageGenerationRecord[] {
    this.assertOpen();
    if(taskId)requiredString(taskId,'taskId',200);
    const rows=this.database.prepare(`SELECT * FROM operation_attempts WHERE operation_kind='external_side_effect' AND json_extract(outcome_json,'$.kind')='image_generation' ${taskId?'AND task_id=?':''} ORDER BY prepared_at,id`).all(...(taskId?[taskId]:[])) as SQLiteRow[];
    return rows.map(row=>{
      const outcome=JSON.parse(text(row,'outcome_json')) as {version:number;record:ImageGenerationRecord};
      const record=outcome.record;
      if(outcome.version!==1||!record||record.id!==text(row,'id')||record.taskId!==text(row,'task_id')||record.sessionId!==text(row,'session_id')||typeof record.description!=='string'||!['zh-CN','en'].includes(record.language))throw new ProductStoreError('PRODUCT_STORE_CORRUPT','Image generation record is invalid');
      const status=text(row,'status');
      return {...record,state:status==='unknown'?'unknown':status==='succeeded'?'succeeded':status==='failed'?(record.state==='cancelled'?'cancelled':'failed'):record.state,updatedAt:text(row,'updated_at')};
    });
  }

  async prepareImageGeneration(input:{requestId:string;expectedStoreRevision:number;taskId:string;sessionId:string;description:string}):Promise<{storeRevision:number;generation:ImageGenerationRecord}> {
    const taskId=requiredString(input.taskId,'taskId',200),sessionId=requiredString(input.sessionId,'sessionId',200),description=requiredString(input.description,'description',8000);
    if(redactCredentialText(description).redacted)throw new ProductStoreError('INVALID_ARGUMENT','IMAGE_DESCRIPTION_CONTAINS_CREDENTIAL');
    return this.mutate('imageGeneration.prepare',input.requestId,input.expectedStoreRevision,{taskId,sessionId,description},(_revision,now)=>{
      const current=this.database.prepare('SELECT state FROM tasks WHERE id=?').get(taskId) as SQLiteRow|undefined;
      const main=this.database.prepare("SELECT id FROM sessions WHERE id=? AND task_id=? AND kind='coordination'").get(sessionId,taskId);
      if(!current||!main)throw new ProductStoreError('NOT_FOUND','IMAGE_TASK_MAIN_REQUIRED');
      if(['archived','accepted'].includes(text(current,'state')))throw new ProductStoreError('REVISION_CONFLICT','IMAGE_TASK_INACTIVE');
      if(this.imageGenerations(taskId).some(record=>['queued','running'].includes(record.state)))throw new ProductStoreError('REVISION_CONFLICT','IMAGE_TASK_BUSY');
      const id=`attempt-${randomUUID()}`;
      const generation:ImageGenerationRecord={id,requestId:input.requestId,taskId,sessionId,description,language:this.clientPreferences().language??'zh-CN',state:'queued',phase:'queued',createdAt:now,updatedAt:now,source:'codex_chatgpt',componentVersion:CODEX_IMAGE_CLI_VERSION,revision:1};
      this.database.prepare(`INSERT INTO operation_attempts(id,task_id,session_id,operation_kind,target_identity,parameter_digest,replay_policy,status,outcome_json,prepared_at,updated_at) VALUES (?,?,?,'external_side_effect',?,?,'never','prepared',?,?,?)`).run(id,taskId,sessionId,`imageGeneration:${id}`,`sha256:${payloadHash({taskId,sessionId,description})}`,canonicalJSON({kind:'image_generation',version:1,record:generation}),now,now);
      return {value:{generation},event:{kind:'imageGeneration.prepared',entityKind:'operationAttempt',entityId:id,taskId,payload:{generationId:id}}};
    });
  }

  async transitionImageGeneration(id:string,patch:Pick<ImageGenerationRecord,'state'|'phase'>&Partial<Pick<ImageGenerationRecord,'threadId'|'turnId'|'accountFingerprint'|'plan'|'errorCode'>>):Promise<{storeRevision:number;generation:ImageGenerationRecord}> {
    const current=this.imageGenerations().find(record=>record.id===id);
    if(!current)throw new ProductStoreError('NOT_FOUND','IMAGE_RECORD_NOT_FOUND');
    for(const key of ['threadId','turnId','accountFingerprint','plan','errorCode'] as const)if(patch[key]!==undefined)requiredString(patch[key],key,200);
    if(!['queued','running','failed','cancelled','unknown'].includes(patch.state)||!['queued','submitting','active','finished'].includes(patch.phase))throw new ProductStoreError('INVALID_ARGUMENT','Invalid image state');
    return this.mutate('imageGeneration.transition',`image-state:${id}:${current.revision}`,undefined,{id,patch},(_revision,now)=>{
      const live=this.imageGenerations(current.taskId).find(record=>record.id===id)!;
      if(['succeeded','failed','cancelled'].includes(live.state))return {value:{generation:live},event:{kind:'imageGeneration.unchanged',entityKind:'operationAttempt',entityId:id,taskId:live.taskId,payload:{generationId:id}}};
      const generation:ImageGenerationRecord={...live,...patch,updatedAt:now,revision:live.revision+1};
      const status=['queued','running'].includes(generation.state)?'prepared':generation.state==='unknown'?'unknown':'failed';
      this.database.prepare('UPDATE operation_attempts SET status=?,outcome_json=?,completed_at=?,updated_at=? WHERE id=?').run(status,canonicalJSON({kind:'image_generation',version:1,record:generation}),status==='prepared'?null:now,now,id);
      return {value:{generation},event:{kind:'imageGeneration.updated',entityKind:'operationAttempt',entityId:id,taskId:live.taskId,payload:{generationId:id,state:generation.state}}};
    });
  }

  async completeImageGeneration(id:string,info:GeneratedImageInfo):Promise<{storeRevision:number;generation:ImageGenerationRecord;artifact:ArtifactRecord}> {
    const current=this.imageGenerations().find(record=>record.id===id);
    if(!current||!current.threadId||!current.turnId)throw new ProductStoreError('NOT_FOUND','IMAGE_RESULT_SOURCE_MISSING');
    if(!current.resultInfo||canonicalJSON(current.resultInfo)!==canonicalJSON(info))throw new ProductStoreError('INVALID_ARGUMENT','IMAGE_RESULT_DIGEST_MISMATCH');
    if(current.terminalStatus!=='completed')throw new ProductStoreError('REVISION_CONFLICT','IMAGE_TURN_INCOMPLETE');
    if(!/^sha256:[a-f0-9]{64}$/u.test(info.digest)||!['png','jpg','webp'].includes(info.extension)||!['image/png','image/jpeg','image/webp'].includes(info.mimeType)||!Number.isSafeInteger(info.bytes)||info.bytes<1||info.bytes>5_000_000)throw new ProductStoreError('INVALID_ARGUMENT','Invalid generated image result');
    return this.mutate('imageGeneration.complete',`image-complete:${id}`,undefined,{id,info},(_revision,now)=>{
      const live=this.imageGenerations(current.taskId).find(record=>record.id===id)!;
      if(!['running','unknown'].includes(live.state))throw new ProductStoreError('REVISION_CONFLICT','IMAGE_RESULT_STATE_CHANGED');
      const artifactId=`image-${id}`;
      const path=join(this.layout.artifactsDirectory,'generated-images',id,`image.${info.extension}`);
      const title=`${live.language==='en'?'Generated image':'生成图片'} · ${live.description.split('\n')[0]!.trim().slice(0,80)}`;
      const metadata={...info,generationId:id,source:live.source,componentVersion:live.componentVersion,threadId:live.threadId,turnId:live.turnId};
      this.database.prepare(`INSERT INTO artifacts(id,task_id,session_id,kind,title,managed_path,digest,metadata_json,revision,created_at,updated_at) VALUES (?,?,?,'generated_image',?,?,?,?,1,?,?)`).run(artifactId,live.taskId,live.sessionId,title,path,info.digest,canonicalJSON(metadata),now,now);
      const generation:ImageGenerationRecord={...live,state:'succeeded',phase:'finished',artifactId,updatedAt:now,revision:live.revision+1};delete generation.errorCode;
      this.database.prepare("UPDATE operation_attempts SET status='succeeded',outcome_json=?,completed_at=?,updated_at=? WHERE id=?").run(canonicalJSON({kind:'image_generation',version:1,record:generation}),now,now,id);
      const artifact:ArtifactRecord={id:artifactId,taskId:live.taskId,sessionId:live.sessionId,kind:'generated_image',title,managedPath:path,digest:info.digest,metadata,revision:1};
      return {value:{generation,artifact},event:{kind:'imageGeneration.succeeded',entityKind:'artifact',entityId:artifactId,taskId:live.taskId,payload:{generationId:id,artifactId,digest:info.digest}}};
    });
  }

  async retainImageResultProof(id:string,info:GeneratedImageInfo,terminalStatus:NonNullable<ImageGenerationRecord['terminalStatus']>='completed'):Promise<void>{
    const current=this.imageGenerations().find(record=>record.id===id);
    if(!current||!current.threadId||!current.turnId||current.state!=='running')throw new ProductStoreError('REVISION_CONFLICT','IMAGE_RESULT_SOURCE_MISSING');
    if(!/^sha256:[a-f0-9]{64}$/u.test(info.digest)||info.bytes<1||info.bytes>5_000_000||!['png','jpg','webp'].includes(info.extension))throw new ProductStoreError('INVALID_ARGUMENT','Invalid image proof');
    await this.mutate('imageGeneration.proof',`image-proof:${id}`,undefined,{id,info},(_revision,now)=>{
      const live=this.imageGenerations(current.taskId).find(record=>record.id===id)!;
      if(live.resultInfo&&canonicalJSON(live.resultInfo)!==canonicalJSON(info))throw new ProductStoreError('REVISION_CONFLICT','IMAGE_RESULT_DIGEST_MISMATCH');
      const generation={...live,resultInfo:info,terminalStatus,revision:live.revision+1,updatedAt:now};
      this.database.prepare('UPDATE operation_attempts SET outcome_json=?,updated_at=? WHERE id=?').run(canonicalJSON({kind:'image_generation',version:1,record:generation}),now,id);
      return {value:{},event:{kind:'imageGeneration.resultRetained',entityKind:'operationAttempt',entityId:id,taskId:live.taskId,payload:{generationId:id,digest:info.digest}}};
    });
  }

  clientPreferences(): ClientPreferences {
    const row = this.database.prepare("SELECT value_json FROM product_settings WHERE key = 'workbench.clientPreferences'").get() as SQLiteRow | undefined;
    const defaults:ClientPreferences={language:"zh-CN",modelQuotaThresholdPercent:DEFAULT_MODEL_QUOTA_THRESHOLD_PERCENT,notificationsEnabled:typeof this.importedSetting("dcode.notifications.completionEnabled")==="boolean" ? this.importedSetting("dcode.notifications.completionEnabled") as boolean : true,readingPositions:{}};
    const appearance=this.importedSetting("dcode.appearance"),fontScale=this.importedSetting("dcode.appearance.fontScale");
    if(["system","light","dark"].includes(appearance as string))defaults.appearance=appearance as ClientPreferences["appearance"];
    if(["compact","standard","large"].includes(fontScale as string))defaults.fontScale=fontScale as ClientPreferences["fontScale"];
    const left=this.importedSetting("dcode.sidebar.width"),right=this.importedSetting("dcode.inspector.width");
    if(typeof left==="number")defaults.sidebarWidth=Math.max(180,Math.min(600,Math.round(left)));
    if(typeof right==="number")defaults.inspectorWidth=Math.max(180,Math.min(600,Math.round(right)));
    const hidden=this.importedSetting("dcode.sidebar.userHidden");if(typeof hidden==="boolean")defaults.sidebarVisible=!hidden;
    const inspectorHidden=this.importedSetting("dcode.inspector.userHidden");if(typeof inspectorHidden==="boolean")defaults.overviewVisible=!inspectorHidden;
    const thinking=this.importedSetting("runtime.defaultThinkingLevel");if(typeof thinking==="string")defaults.defaultThinking=thinking;
    if (!row) return defaults;
    try {
      const value = JSON.parse(text(row, "value_json")) as ClientPreferences;
      if(value.language!==undefined&&!['zh-CN','en'].includes(value.language))throw new Error("invalid language");
      if (typeof value.notificationsEnabled !== "boolean" || !value.readingPositions || Object.values(value.readingPositions).some(offset => !Number.isInteger(offset) || offset < 0 || offset > 100_000_000)) throw new Error("invalid shape");
      if(value.modelQuotaThresholdPercent!==undefined&&!isModelQuotaThresholdPercent(value.modelQuotaThresholdPercent))throw new Error("invalid quota threshold");
      return {...defaults,...value};
    } catch { throw new ProductStoreError("PRODUCT_STORE_CORRUPT", "Client preferences are invalid"); }
  }

  async setClientPreferences(input: { requestId: string; expectedStoreRevision: number; language?: ClientPreferences["language"]; notificationsEnabled?: boolean; appearance?: ClientPreferences["appearance"]; fontScale?: ClientPreferences["fontScale"]; sidebarVisible?: boolean; overviewVisible?: boolean; sidebarWidth?: number; inspectorWidth?: number; defaultThinking?: string; modelQuotaThresholdPercent?: number; enabledModels?: string[] | null; disabledResources?: string[]; readingPosition?: { sessionId: string; offset: number } }): Promise<{ storeRevision: number; preferences: ClientPreferences }> {
    if (input.notificationsEnabled !== undefined && typeof input.notificationsEnabled !== "boolean") throw new ProductStoreError("INVALID_ARGUMENT", "notificationsEnabled must be boolean");
    const settingKeys = ["language", "appearance", "fontScale", "sidebarVisible", "overviewVisible", "sidebarWidth", "inspectorWidth", "defaultThinking", "modelQuotaThresholdPercent", "enabledModels", "disabledResources"] as const;
    const changes: Partial<ClientPreferences> = {};
    for (const key of settingKeys) if (input[key] !== undefined) Object.assign(changes, { [key]: input[key] });
    if(changes.language!==undefined&&!['zh-CN','en'].includes(changes.language))throw new ProductStoreError("INVALID_ARGUMENT","Invalid display language");
    if (changes.appearance && !["system", "light", "dark"].includes(changes.appearance)) throw new ProductStoreError("INVALID_ARGUMENT", "Invalid appearance");
    if (changes.fontScale && !["compact", "standard", "large"].includes(changes.fontScale)) throw new ProductStoreError("INVALID_ARGUMENT", "Invalid font scale");
    for (const key of ["sidebarVisible", "overviewVisible"] as const) if (changes[key] !== undefined && typeof changes[key] !== "boolean") throw new ProductStoreError("INVALID_ARGUMENT", "Invalid visibility preference");
    for (const key of ["sidebarWidth", "inspectorWidth"] as const) if (changes[key] !== undefined && (!Number.isInteger(changes[key]) || changes[key]! < 180 || changes[key]! > 600)) throw new ProductStoreError("INVALID_ARGUMENT", "Invalid rail width");
    if (changes.enabledModels !== undefined && changes.enabledModels !== null && (!Array.isArray(changes.enabledModels) || changes.enabledModels.length > 4096 || changes.enabledModels.some(id => typeof id !== "string" || id.length > 500))) throw new ProductStoreError("INVALID_ARGUMENT", "Invalid enabled models");
    if(changes.modelQuotaThresholdPercent!==undefined&&!isModelQuotaThresholdPercent(changes.modelQuotaThresholdPercent))throw new ProductStoreError("INVALID_ARGUMENT","配额门槛必须是1至30的整数百分比");
    if (changes.defaultThinking && !["off","minimal","low","medium","high","xhigh","max"].includes(changes.defaultThinking)) throw new ProductStoreError("INVALID_ARGUMENT", "Invalid thinking level");
    if(changes.disabledResources && (!Array.isArray(changes.disabledResources)||changes.disabledResources.length>4096||changes.disabledResources.some(key=>typeof key!=="string"||key.length>5000||!/^skill:|^prompt:/.test(key))))throw new ProductStoreError("INVALID_ARGUMENT","Invalid resource selection");
    const position = input.readingPosition;
    if (position && (!Number.isInteger(position.offset) || position.offset < 0 || position.offset > 100_000_000)) throw new ProductStoreError("INVALID_ARGUMENT", "Invalid reading offset");
    return await this.mutate("clientPreferences.set", input.requestId, input.expectedStoreRevision, { notificationsEnabled: input.notificationsEnabled, readingPosition: position, ...changes }, (_revision, now) => {
      const current = this.clientPreferences();
      if (position && !this.database.prepare("SELECT id FROM sessions WHERE id = ?").get(position.sessionId)) throw new ProductStoreError("NOT_FOUND", "Reading position session does not exist");
      const entries = Object.entries(current.readingPositions).filter(([id]) => id !== position?.sessionId);
      if (position) entries.push([position.sessionId, position.offset]);
      const preferences: ClientPreferences = { ...current, ...changes, notificationsEnabled: input.notificationsEnabled ?? current.notificationsEnabled, readingPositions: Object.fromEntries(entries.slice(-200)) };
      this.database.prepare(`INSERT INTO product_settings(key,value_json,source_kind,revision,created_at,updated_at) VALUES ('workbench.clientPreferences',?,'user',1,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,revision=product_settings.revision+1,updated_at=excluded.updated_at`).run(canonicalJSON(preferences),now,now);
      return { value: { preferences }, event: { kind: "clientPreferences.updated", entityKind: "productSetting", entityId: "workbench.clientPreferences", payload: {} } };
    });
  }

  inspirationView(): InspirationView {
    const row=this.database.prepare("SELECT value_json,revision FROM product_settings WHERE key=?").get(INSPIRATION_KEY) as SQLiteRow|undefined;
    const document:InspirationDocument=row?JSON.parse(text(row,"value_json")):emptyInspiration();
    if(document.version!==1||!Array.isArray(document.nodes))throw new InspirationError("INVALID_INSPIRATION","灵感资料暂时无法读取，原始数据已保留。");
    return {...document,revision:row?integer(row,"revision"):0,documentRoot:inspirationRoot(this.layout)};
  }

  async mutateInspiration(input:{requestId:string;expectedStoreRevision:number;operation:InspirationOperation}):Promise<{storeRevision:number;view:InspirationView}> {
    return await this.serializeMutation(async()=>{
      const params={operation:input.operation};
      const replay=await this.replayReceipt<{storeRevision:number;view:InspirationView}>("inspiration.mutate",input.requestId,params);if(replay)return replay;
      const current=this.inspirationView(),operation=input.operation;
      const sourceTaskId=operation.kind==="save"?operation.node?.sourceTaskId:operation.kind==="draft"?operation.draft?.sourceTaskId:undefined;
      if(sourceTaskId!==undefined&&(typeof sourceTaskId!=="string"||!this.database.prepare("SELECT id FROM tasks WHERE id=?").get(sourceTaskId)))throw new InspirationError("IDEA_SOURCE_NOT_FOUND","来源任务已不存在。");
      let published:Awaited<ReturnType<typeof publishIdeaMedia>>|undefined;
      try {
        if(operation.kind==="save"&&operation.mediaPath)published=await publishIdeaMedia(this.layout,operation.mediaPath,operation.node.kind);
        const next=changeInspiration(current,operation,this.now(),published?.media);
        // Only the typed document is persisted, never the returned projection fields.
        const {revision:_revision,documentRoot:_root,...document}=next as InspirationView;
        return await this.mutateNow("inspiration.mutate",input.requestId,input.expectedStoreRevision,params,(_revision,now)=>{
          this.database.prepare("INSERT INTO product_settings(key,value_json,source_kind,revision,created_at,updated_at) VALUES (?,?,'user',1,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,revision=product_settings.revision+1,updated_at=excluded.updated_at").run(INSPIRATION_KEY,canonicalJSON(document),now,now);
          return {value:{view:this.inspirationView()},event:{kind:"inspiration.updated",entityKind:"inspiration",entityId:"global",payload:{operation:operation.kind}}};
        });
      }catch(error){if(published?.created&&!this.inspirationView().nodes.some(node=>node.media?.fileName===published!.media.fileName))await removeUnreferencedIdeaMedia(this.layout,published.media);throw error;}
    });
  }

  async inspirationMedia(nodeId:string):Promise<Awaited<ReturnType<typeof resolveIdeaMedia>>> {
    return await this.serializeMutation(async()=>{await this.lease.assertOwned();const node=this.inspirationView().nodes.find(node=>node.id===nodeId);if(!node?.media)throw new InspirationError("IDEA_MEDIA_NOT_FOUND","这条灵感没有本地媒体。");return await resolveIdeaMedia(this.layout,node.media);});
  }

  async inspirationMarkdown(nodeId:string,expectedRevision?:number):Promise<Awaited<ReturnType<typeof exportIdeaMarkdown>>> {
    return await this.serializeMutation(async()=>{await this.lease.assertOwned();const node=this.inspirationView().nodes.find(node=>node.id===nodeId);if(!node)throw new InspirationError("IDEA_NOT_FOUND","灵感不存在。");if(expectedRevision!==undefined&&node.revision!==expectedRevision)throw new InspirationError("IDEA_REVISION_CONFLICT","灵感已更新，请重新检索后读取当前版本。");return await exportIdeaMarkdown(this.layout,node);});
  }

  async referenceInspiration(input:{requestId:string;expectedStoreRevision:number;nodeId:string;nodeRevision:number;taskId:string}):Promise<{storeRevision:number;contextRevision:number}> {
    return await this.serializeMutation(async()=>{
      const params={nodeId:input.nodeId,nodeRevision:input.nodeRevision,taskId:input.taskId};
      const replay=await this.replayReceipt<{storeRevision:number;contextRevision:number}>("inspiration.reference",input.requestId,params);if(replay)return replay;
      const node=this.inspirationView().nodes.find(node=>node.id===input.nodeId);
      if(!node||node.archived)throw new InspirationError("IDEA_NOT_FOUND","请先恢复这条灵感，再引用到任务。");
      if(node.revision!==input.nodeRevision)throw new InspirationError("IDEA_REVISION_CONFLICT","灵感已经更新，请重新选择引用版本。");
      const taskRow=this.database.prepare("SELECT * FROM tasks WHERE id=?").get(input.taskId) as SQLiteRow|undefined;
      if(!taskRow||task(taskRow).state==="archived")throw new InspirationError("IDEA_TASK_NOT_FOUND","请先选择一个可用任务。");
      const exported=await exportIdeaMarkdown(this.layout,node);
      const [source]=await normalizeTaskContextSources([{kind:"global_knowledge",rootPath:exported.rootPath,relativePath:exported.relativePath,title:node.title}],this.currentUser().homeDirectory,task(taskRow).cwd);
      if(!source)throw new InspirationError("INVALID_IDEA","灵感引用无效。");
      return await this.mutateNow("inspiration.reference",input.requestId,input.expectedStoreRevision,params,(_revision,now)=>{
        const context=this.database.prepare("SELECT * FROM task_context_sets WHERE task_id=?").get(input.taskId) as SQLiteRow|undefined;
        if(!context)throw new InspirationError("IDEA_TASK_NOT_FOUND","任务上下文不存在。");
        const matching=this.database.prepare("SELECT id,ordinal FROM task_context_sources WHERE task_id=? AND source_kind='global_knowledge' AND root_path=? AND relative_path LIKE ? ORDER BY ordinal").all(input.taskId,source.rootPath!,`${node.id}/%`) as SQLiteRow[];
        const count=this.database.prepare("SELECT COUNT(*) AS total FROM task_context_sources WHERE task_id=?").get(input.taskId) as SQLiteRow;
        if(integer(count,"total")-matching.length+1>32)throw new InspirationError("TASK_CONTEXT_LIMIT","任务已选满 32 项上下文，请先移除其他引用。");
        const maximum=this.database.prepare("SELECT COALESCE(MAX(ordinal),-1)+1 AS next FROM task_context_sources WHERE task_id=?").get(input.taskId) as SQLiteRow;
        const ordinal=matching[0]?integer(matching[0],"ordinal"):integer(maximum,"next");
        for(const row of matching)this.database.prepare("DELETE FROM task_context_sources WHERE id=?").run(text(row,"id"));
        this.database.prepare("INSERT INTO task_context_sources(id,task_id,source_kind,root_path,relative_path,title,ordinal,created_at,updated_at) VALUES (?,?,'global_knowledge',?,?,?,?,?,?)").run(`context-source-${randomUUID()}`,input.taskId,source.rootPath!,source.relativePath,node.title,ordinal,now,now);
        const revision=integer(context,"revision")+1;
        this.database.prepare("UPDATE task_context_sets SET revision=?,updated_at=? WHERE task_id=?").run(revision,now,input.taskId);
        return {value:{contextRevision:revision},event:{kind:"task.context.replaced",entityKind:"taskContext",entityId:input.taskId,taskId:input.taskId,payload:{nodeId:node.id,nodeRevision:node.revision}}};
      });
    });
  }

  async readTaskSource(input:TaskSourceSelector):Promise<TaskSourceReadResult> {
    this.assertOpen();
    if(!input||typeof input!=="object")throw new ProductStoreError("INVALID_ARGUMENT","来源读取只接受已保存的身份");
    const context="contextSourceId" in input;
    if(typeof input.taskId!=="string"||!input.taskId||Object.keys(input).some(key=>!(context?["taskId","contextSourceId"]:["taskId","promptReceiptId","sourceIndex"]).includes(key))||context&&typeof input.contextSourceId!=="string"||!context&&typeof input.promptReceiptId!=="string")throw new ProductStoreError("INVALID_ARGUMENT","来源读取只接受已保存的身份");
    if(!this.database.prepare("SELECT id FROM tasks WHERE id=?").get(input.taskId))throw new ProductStoreError("NOT_FOUND","任务不存在");
    const ideaRoot=await realpath(inspirationRoot(this.layout)).catch(()=>inspirationRoot(this.layout));
    let source:DCodePromptSourceReceipt;
    let runtimeCwd:string|undefined;
    if("contextSourceId" in input){
      const row=this.database.prepare("SELECT * FROM task_context_sources WHERE id=? AND task_id=?").get(input.contextSourceId,input.taskId) as SQLiteRow|undefined;
      if(!row)throw new ProductStoreError("NOT_FOUND","任务来源已不在当前选择中");
      const selected=taskContextSource(row),root=ideaRoot,version=managedInspirationVersion(selected,root);
      if(!version)throw new ProductStoreError("INVALID_ARGUMENT","此入口只打开任务引用的灵感版本");
      source={path:resolve(root,selected.relativePath),rootPath:root,kind:"global_knowledge",title:selected.title,digest:version.digest,bytes:0};
    }else{
      const row=this.database.prepare("SELECT * FROM prompt_receipts WHERE id=? AND task_id=?").get(input.promptReceiptId,input.taskId) as SQLiteRow|undefined;
      if(!row)throw new ProductStoreError("NOT_FOUND","这项任务没有对应运行来源");
      const receipt=promptReceipt(row);
      if(!Number.isSafeInteger(input.sourceIndex)||input.sourceIndex<0||input.sourceIndex>=receipt.sourceReceipts.length)throw new ProductStoreError("INVALID_ARGUMENT","运行来源序号无效");
      source=receipt.sourceReceipts[input.sourceIndex]!;
      const environment=this.database.prepare("SELECT cwd FROM runtime_environments WHERE id=? AND task_id=? AND session_id=?").get(receipt.runtimeEnvironmentId,input.taskId,receipt.sessionId) as SQLiteRow|undefined;
      runtimeCwd=environment?text(environment,"cwd"):undefined;
    }
    const root=source.rootPath??runtimeCwd;
    const ideaVersion=managedInspirationVersion({kind:source.kind==="global_knowledge"?"global_knowledge":"scope_document",rootPath:source.rootPath,relativePath:relative(ideaRoot,source.path)},ideaRoot);
    const version=ideaVersion?.revision;
    const currentVersion=ideaVersion?this.inspirationView().nodes.find(node=>node.id===ideaVersion.nodeId)?.revision:undefined;
    const result:TaskSourceReadResult={title:source.title??basename(source.path),path:source.path,kind:source.kind,digest:source.digest,state:"historical_unavailable",contentStored:false,...(version?{version}:{}),...(currentVersion?{currentVersion}:{})};
    if(ideaVersion&&source.digest!==ideaVersion.digest)return {...result,unavailableReason:"snapshot_identity_mismatch"};
    if(!root)return {...result,unavailableReason:"runtime_cwd_unavailable"};
    if(source.rootPath&&source.kind!=="global_knowledge"){
      if(!runtimeCwd)return {...result,unavailableReason:"runtime_cwd_unavailable"};
      let originalRoot:string,recordedRoot:string;
      try{[originalRoot,recordedRoot]=await Promise.all([realpath(runtimeCwd),realpath(root)]);}catch{return {...result,unavailableReason:"runtime_cwd_unavailable"};}
      if(originalRoot!==recordedRoot)return {...result,unavailableReason:"outside_runtime_cwd"};
    }
    if(source.kind==="global_knowledge"){
      if(!source.rootPath)return {...result,unavailableReason:"source_root_unavailable"};
      let home:string,canonicalRoot:string;
      try{[home,canonicalRoot]=await Promise.all([realpath(this.currentUser().homeDirectory),realpath(root)]);}catch{return {...result,unavailableReason:"source_root_unavailable"};}
      if(!strictlyInside(home,canonicalRoot))return {...result,unavailableReason:"outside_source_root"};
    }
    const current=await readDCodePromptSource(root,source.path,source.kind==="global_knowledge");
    if(current.kind==="unavailable")return {...result,state:current.reason==="too_large"&&source.bytes>0&&current.currentBytes!==source.bytes?"hash_mismatch":"historical_unavailable",unavailableReason:current.reason};
    const digest=`sha256:${createHash("sha256").update(current.bytes).digest("hex")}`;
    if(digest!==source.digest||source.bytes>0&&current.bytes.length!==source.bytes)return {...result,state:"hash_mismatch",currentDigest:digest};
    if(!isUtf8(current.bytes))return {...result,unavailableReason:"invalid_utf8"};
    const content=current.bytes.toString("utf8");
    if(redactCredentialText(content).redacted)return {...result,unavailableReason:"credential_material"};
    return {...result,state:"current_match",content};
  }

  private attachmentDraftTarget(key: string): {id:string;scope?:TaskScope;taskId?:string;sessionId?:string} {
    if (key.startsWith("new:")) {
      const scope:TaskScope = key === "new:user" ? {kind:"user",userId:this.currentUser().id} : {kind:"project",projectId:key.slice(4)};
      if (scope.kind === "project" && !this.database.prepare("SELECT id FROM projects WHERE id=? AND user_id=?").get(scope.projectId,this.currentUser().id)) throw new ProductStoreError("NOT_FOUND","附件的项目不存在");
      return {id:`task-draft:${scope.kind}:${scope.kind === "user" ? scope.userId : scope.projectId}`,scope};
    }
    const session=this.database.prepare("SELECT task_id FROM sessions WHERE id=?").get(key) as SQLiteRow|undefined;
    if (!session) throw new ProductStoreError("NOT_FOUND","附件的任务不存在");
    const draft=this.database.prepare("SELECT id FROM composer_drafts WHERE session_id=? AND draft_kind='session_path' ORDER BY updated_at DESC LIMIT 1").get(key) as SQLiteRow|undefined;
    return {id:draft?text(draft,"id"):`composer-draft:${key}`,sessionId:key,taskId:text(session,"task_id")};
  }

  attachmentCatalog(): ManagedAttachment[] {
    const result=new Map<string,ManagedAttachment>();
    for(const row of this.database.prepare("SELECT payload_json FROM composer_drafts").all() as SQLiteRow[]){
      const payload=JSON.parse(text(row,"payload_json"));
      for(const item of payload.attachments??[]) if(item?.id) result.set(item.id,item);
    }
    for(const row of this.database.prepare("SELECT metadata_json FROM artifacts WHERE kind='attachment'").all() as SQLiteRow[]){
      const item=JSON.parse(text(row,"metadata_json")) as ManagedAttachment;
      if (!result.has(item.id)||Date.parse(item.expiresAt)>=Date.parse(result.get(item.id)!.expiresAt)) result.set(item.id,item);
    }
    return [...result.values()];
  }

  private attachmentsForIds(ids: string[] | undefined, previous: ManagedAttachment[] = []): ManagedAttachment[] {
    if(ids === undefined)return previous;
    if(!Array.isArray(ids)||ids.length>32||ids.some(id=>typeof id!=="string"))throw new ProductStoreError("INVALID_ARGUMENT","附件列表无效");
    const records=this.attachmentCatalog();
    return [...new Set(ids)].map(id=>{const item=records.find(item=>item.id===id);if(!item)throw new ProductStoreError("NOT_FOUND","附件不存在，请重新添加");return item;});
  }

  async importAttachment(input: {requestId:string;expectedStoreRevision:number;draftKey:string;source:AttachmentSource}):Promise<{attachment:ManagedAttachment;storeRevision:number}> {
    return await this.serializeMutation(async()=>{
      const params={draftKey:input.draftKey,source:input.source};
      const replay=await this.replayReceipt<{attachment:ManagedAttachment;storeRevision:number}>("attachment.import",input.requestId,params);
      if(replay)return replay;
      const target=this.attachmentDraftTarget(input.draftKey);
      const now=this.now();
      await sweepAttachmentFiles(this.layout,this.attachmentCatalog(),now);
      const id=`attachment-${createHash("sha256").update(input.requestId).digest("hex").slice(0,32)}`;
      const total=await stagedAttachmentBytes(this.layout,id);
      const current=this.database.prepare("SELECT payload_json FROM composer_drafts WHERE id=?").get(target.id) as SQLiteRow|undefined;
      const existing:ManagedAttachment[]=current?JSON.parse(text(current,"payload_json")).attachments??[]:[];
      try {
      const attachment=await stageAttachment(this.layout,input.source,id,now,item=>{
        const attachments=[...existing.filter(value=>value.id!==id),item];
        if(attachments.length>32||attachments.filter(value=>value.mimeType.startsWith("image/")).length>8||attachments.filter(value=>value.mimeType.startsWith("image/")).reduce((n,value)=>n+Math.ceil(value.bytes/3)*4,0)>12_000_000)throw new ProductStoreError("ATTACHMENT_LIMIT","最多添加 8 张图片、32 个附件；请减少附件后重试。");
        if(total+item.bytes+16_000>500_000_000)throw new ProductStoreError("ATTACHMENT_STORAGE_FULL","附件暂存空间已满，请等待过期清理后重试。");
      });
      return await this.mutateNow("attachment.import",input.requestId,input.expectedStoreRevision,params,(_revision,now)=>{
        const row=this.database.prepare("SELECT * FROM composer_drafts WHERE id=?").get(target.id) as SQLiteRow|undefined;
        const payload=row?JSON.parse(text(row,"payload_json")):target.scope?{scope:target.scope}:{source:"dcode_task_workbench"};
        const attachments:ManagedAttachment[]=[...(payload.attachments??[]).filter((item:ManagedAttachment)=>item.id!==attachment.id),attachment];
        if(attachments.length>32||attachments.filter(item=>item.mimeType.startsWith("image/")).length>8||attachments.filter(item=>item.mimeType.startsWith("image/")).reduce((n,item)=>n+Math.ceil(item.bytes/3)*4,0)>12_000_000)throw new ProductStoreError("ATTACHMENT_LIMIT","最多添加 8 张图片、32 个附件；请减少附件后重试。");
        const body=canonicalJSON({...payload,attachments});
        if(row)this.database.prepare("UPDATE composer_drafts SET payload_json=?,revision=revision+1,updated_at=? WHERE id=?").run(body,now,target.id);
        else this.database.prepare("INSERT INTO composer_drafts(id,task_id,session_id,draft_kind,text,payload_json,source_ordinal,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,NULL,1,?,?)").run(target.id,target.taskId??null,target.sessionId??null,target.scope?"new_task":"session_path","",body,now,now);
        return {value:{attachment},event:{kind:"attachment.imported",entityKind:"attachment",entityId:attachment.id,payload:{draftKey:input.draftKey}}};
      });
      } catch(error) {if(!this.attachmentCatalog().some(item=>item.id===id))await discardStagedAttachment(this.layout,id);throw error;}

    });
  }

  async resolveAttachment(id:string):Promise<{attachment:ManagedAttachment;path:string;data?:string}> {
    return await this.serializeMutation(async()=>{
      const attachment=this.attachmentCatalog().find(item=>item.id===id);
      if(!attachment)throw new ProductStoreError("NOT_FOUND","附件不存在，请重新添加。");
      const file=await readAttachment(this.layout,attachment,this.now());
      return {attachment,path:file.path,...(attachment.mimeType.startsWith("image/")?{data:file.bytes.toString("base64")}: {})};
    });
  }

  async sweepAttachments():Promise<number> {
    return await this.serializeMutation(()=>sweepAttachmentFiles(this.layout,this.attachmentCatalog(),this.now()));
  }

  async setTaskDraft(input: { requestId: string; expectedStoreRevision: number; scope: TaskScope; text: string; goal?: string; acceptance?: string[]; pendingWorkflowSubmission?:PendingWorkflowSubmissionRecord|null; attachmentIds?: string[] }): Promise<{ storeRevision: number; composerDraft?: ComposerDraftRecord }> {
    const scope = normalizedTaskScope(input.scope);
    if (typeof input.text !== "string" || input.text.length > 200_000) throw new ProductStoreError("INVALID_ARGUMENT", "Invalid task draft text");
    if (redactCredentialText(input.text).redacted) throw new ProductStoreError("CREDENTIAL_MATERIAL_REJECTED", "Task draft contains credential material");
    if (input.goal !== undefined && (typeof input.goal !== "string" || input.goal.length > 4_000)) throw new ProductStoreError("INVALID_ARGUMENT", "Invalid Task Goal draft");
    if (input.goal !== undefined) assertCredentialFreeValue(input.goal, "goal");
    if (input.acceptance !== undefined && (!Array.isArray(input.acceptance) || input.acceptance.length > 100)) throw new ProductStoreError("INVALID_ARGUMENT", "Invalid Task acceptance draft");
    if (input.acceptance !== undefined) assertCredentialFreeValue(parseStringArray(input.acceptance, "acceptance"), "acceptance");
    const pending=input.pendingWorkflowSubmission?normalizedPendingWorkflowSubmission(input.pendingWorkflowSubmission):input.pendingWorkflowSubmission;
    const scopeId = scope.kind === "user" ? scope.userId : scope.projectId;
    const id = `task-draft:${scope.kind}:${scopeId}`;
    return await this.mutate<{ composerDraft?: ComposerDraftRecord }>("taskDraft.set", input.requestId, input.expectedStoreRevision, { scope, text: input.text, goal:input.goal??null, acceptance:input.acceptance??null, pendingWorkflowSubmission:pending??null, attachmentIds:input.attachmentIds??null }, (_revision, now) => {
      const user = this.currentUser();
      if (scope.kind === "user" ? scope.userId !== user.id : !this.database.prepare("SELECT id FROM projects WHERE id = ? AND user_id = ?").get(scope.projectId, user.id)) throw new ProductStoreError("NOT_FOUND", "Task draft scope does not exist");
      const existing=this.database.prepare("SELECT payload_json FROM composer_drafts WHERE id=?").get(id) as SQLiteRow|undefined;
      const payload=existing?JSON.parse(text(existing,"payload_json")):{};
      const attachments=this.attachmentsForIds(input.attachmentIds,payload.attachments??[]);
      const goal=input.goal??payload.goal??"";
      const acceptance=input.acceptance??payload.acceptance??[];
      const pendingWorkflowSubmission=input.pendingWorkflowSubmission===undefined?payload.pendingWorkflowSubmission:pending;
      if (input.text.length === 0 && !attachments.length && !goal && !acceptance.length && !pendingWorkflowSubmission) this.database.prepare("DELETE FROM composer_drafts WHERE id = ?").run(id);
      else this.database.prepare(`INSERT INTO composer_drafts(id,task_id,session_id,draft_kind,text,payload_json,source_ordinal,revision,created_at,updated_at) VALUES (?,NULL,NULL,'new_task',?,?,NULL,1,?,?) ON CONFLICT(id) DO UPDATE SET text=excluded.text,payload_json=excluded.payload_json,revision=composer_drafts.revision+1,updated_at=excluded.updated_at`).run(id,input.text,canonicalJSON({ ...payload, scope, goal, acceptance, pendingWorkflowSubmission:pendingWorkflowSubmission??null, attachments }),now,now);
      const row = this.database.prepare("SELECT * FROM composer_drafts WHERE id = ?").get(id) as SQLiteRow | undefined;
      return { value: row ? { composerDraft: composerDraft(row) } : {}, event: { kind: "taskDraft.updated", entityKind: "composerDraft", entityId: id, payload: { textBytes: Buffer.byteLength(input.text, "utf8") } } };
    });
  }

  async setDCodeSessionComposerDraft(input: {
    requestId: string;
    expectedStoreRevision: number;
    taskId: string;
    sessionId: string;
    text: string;
    attachmentIds?: string[];
    pendingWorkflowSubmission?:PendingWorkflowSubmissionRecord|null;
    targetAgentRunId?: string | null;
    pathAction?:NativeSessionPathAction|null;
    pathDraftBackup?:ComposerDraftRecord["pathDraftBackup"]|null;
  }): Promise<{ storeRevision: number; composerDraft?: ComposerDraftRecord }> {
    const taskId = requiredString(input.taskId, "taskId", 200);
    const sessionId = requiredString(input.sessionId, "sessionId", 200);
    if (typeof input.text !== "string" || input.text.length > 200_000) {
      throw new ProductStoreError("INVALID_ARGUMENT", "D Code Session Composer Draft text must be a string up to 200000 characters");
    }
    if (redactCredentialText(input.text).redacted) {
      throw new ProductStoreError("CREDENTIAL_MATERIAL_REJECTED", "D Code Session Composer Draft contains credential material");
    }
    const pending=input.pendingWorkflowSubmission?normalizedPendingWorkflowSubmission(input.pendingWorkflowSubmission):input.pendingWorkflowSubmission;
    const textValue = input.text;
    return await this.mutate<{ composerDraft?: ComposerDraftRecord }>(
      "dcodeSession.composerDraft.set",
      input.requestId,
      input.expectedStoreRevision,
      { taskId, sessionId, text: textValue, attachmentIds:input.attachmentIds??null, pendingWorkflowSubmission:pending??null, targetAgentRunId:input.targetAgentRunId??null,pathAction:input.pathAction??null,pathDraftBackup:input.pathDraftBackup??null },
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
        const payload=existing?JSON.parse(text(existing,"payload_json")):{};
        const attachments=this.attachmentsForIds(input.attachmentIds,payload.attachments??[]);
        if(input.pendingWorkflowSubmission!==undefined)payload.pendingWorkflowSubmission=pending??null;
        const targetAgentRunId=input.targetAgentRunId===undefined?payload.targetAgentRunId:input.targetAgentRunId;
        if(targetAgentRunId && !this.database.prepare("SELECT id FROM agent_runs WHERE id=? AND task_id=? AND role<>'coordinator'").get(targetAgentRunId,taskId)) throw new ProductStoreError("INVALID_ARGUMENT","定向草稿只能选择本任务已创建的成员");
        payload.targetAgentRunId=targetAgentRunId??null;
        if(input.pathAction!==undefined)payload.pathAction=input.pathAction;
        if(input.pathDraftBackup!==undefined)payload.pathDraftBackup=input.pathDraftBackup;
        if(payload.pathAction){const action=payload.pathAction as NativeSessionPathAction;
          if(!["editUser","continueAssistant","continuePath"].includes(action.kind)||!this.database.prepare("SELECT id FROM session_paths WHERE id=? AND session_id=?").get(action.fromPathId,sessionId))throw new ProductStoreError("INVALID_ARGUMENT","草稿路径不属于当前会话");
          assertCredentialFreeValue(action,"pathAction");
        }
        if(payload.pathDraftBackup){const backup=payload.pathDraftBackup as NonNullable<ComposerDraftRecord["pathDraftBackup"]>;if(typeof backup.text!=="string"||backup.text.length>200000||!Array.isArray(backup.attachmentIds)||backup.attachmentIds.length>32)throw new ProductStoreError("INVALID_ARGUMENT","原草稿备份无效");assertCredentialFreeValue(backup,"pathDraftBackup");backup.attachments=this.attachmentsForIds(backup.attachmentIds);}

        if (textValue.length === 0 && !attachments.length && !targetAgentRunId && !payload.pathAction && !payload.pathDraftBackup && !payload.pendingWorkflowSubmission) {
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
          `).run(taskId, textValue, canonicalJSON({ ...payload, source: "dcode_task_workbench", attachments }), revision, now, id, integer(existing, "revision"));
        } else {
          this.database.prepare(`
            INSERT INTO composer_drafts(
              id, task_id, session_id, draft_kind, text, payload_json,
              source_ordinal, revision, created_at, updated_at
            ) VALUES (?, ?, ?, 'session_path', ?, ?, NULL, 1, ?, ?)
          `).run(id, taskId, sessionId, textValue, canonicalJSON({ ...payload, source: "dcode_task_workbench", attachments }), now, now);
        }
        const composerDraft: ComposerDraftRecord = {
          id,
          taskId,
          sessionId,
          draftKind: "session_path",
          attachments,
          ...(payload.pendingWorkflowSubmission?{pendingWorkflowSubmission:normalizedPendingWorkflowSubmission(payload.pendingWorkflowSubmission)}:{}),
          ...(targetAgentRunId?{targetAgentRunId}:{}),
          ...(payload.pathAction?{pathAction:payload.pathAction}:{}),
          ...(payload.pathDraftBackup?{pathDraftBackup:payload.pathDraftBackup}:{}),
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

  removedModelProviderIds(): Set<string> {
    return new Set((this.database.prepare("SELECT DISTINCT entity_id FROM store_events WHERE kind='modelProvider.removed'").all() as SQLiteRow[]).map(row=>text(row,"entity_id")));
  }

  async prepareRuntimeModelControl(input:{requestId:string;expectedStoreRevision:number;method:"dcodeModels.select"|"dcodeModels.setThinking";sessionId:string;runtimeId:string;values:Record<string,unknown>}):Promise<{attemptId:string;storeRevision:number;replayed:boolean}> {
    const params={sessionId:input.sessionId,values:input.values};
    assertCredentialFreeValue(params,"modelControl");
    return await this.serializeMutation(async()=>{
      const previous=this.receipt<{attemptId:string;storeRevision:number}>(input.requestId,input.method,payloadHash(params));
      if(previous)return {...previous,replayed:true};
      const result=await this.mutateNow(input.method,input.requestId,input.expectedStoreRevision,params,(_revision,now)=>{
        const row=this.database.prepare("SELECT task_id,state FROM sessions WHERE id=?").get(input.sessionId) as SQLiteRow|undefined;
        if(!row||text(row,"state")==="archived")throw new ProductStoreError("NOT_FOUND","Session is unavailable");
        const taskId=text(row,"task_id");const attemptId=`attempt-${randomUUID()}`;
        this.database.prepare("INSERT INTO operation_attempts(id,task_id,session_id,operation_kind,target_identity,parameter_digest,replay_policy,status,prepared_at,updated_at) VALUES (?,?,?,'external_side_effect',?,?,'explicit_idempotent','prepared',?,?)").run(attemptId,taskId,input.sessionId,`${input.method}:${input.runtimeId}`,`sha256:${payloadHash(params)}`,now,now);
        return {value:{attemptId},event:{kind:"runtimeModelSelection.prepared",entityKind:"operationAttempt",entityId:attemptId,taskId,payload:{sessionId:input.sessionId}}};
      });
      return {...result,replayed:false};
    });
  }

  async removeCatalogProvider(input: { requestId: string; expectedStoreRevision: number; providerId: string }): Promise<{ storeRevision: number; removed: boolean }> {
    const providerId = requiredString(input.providerId, "providerId", 200);
    return this.mutate("dcodeModelProvider.remove", input.requestId, input.expectedStoreRevision, { providerId }, () => {
      const row = this.database.prepare("SELECT nonsecret_json FROM model_providers WHERE id = ?").get(providerId) as SQLiteRow | undefined;
      if (!row || (JSON.parse(text(row, "nonsecret_json")) as { source?: string }).source !== "dcode_custom") throw new ProductStoreError("INVALID_ARGUMENT", "Only D Code custom providers can be removed here");
      if(this.runtimeModelSelection()?.providerId===providerId)throw new ProductStoreError("INVALID_ARGUMENT","请先切换默认供应商，再删除当前默认供应商");
      this.database.prepare("DELETE FROM model_catalog_entries WHERE provider_id = ?").run(providerId);
      this.database.prepare("DELETE FROM credential_references WHERE provider_id = ?").run(providerId);
      this.database.prepare("DELETE FROM model_providers WHERE id = ?").run(providerId);
      if (this.runtimeModelSelection()?.providerId === providerId) this.database.prepare("DELETE FROM product_settings WHERE key = 'runtime.modelSelection'").run();
      return { value: { removed: true }, event: { kind: "modelProvider.removed", entityKind: "modelProvider", entityId: providerId, payload: {} } };
    });
  }

  async syncModelCredentialReferences(providers: {providerId:string;locator:string;configured:boolean}[]): Promise<void> {
    const safe=providers.map(p=>({providerId:requiredCredentialFreeString(p.providerId,"providerId",200),locator:requiredCredentialFreeString(p.locator,"locator",4096),configured:p.configured===true}));
    await this.mutate("modelCredentialReferences.sync",`credential-sync:${randomUUID()}`,undefined,{providers:safe},(_revision,now)=>{
      for(const provider of safe){
        const kind=provider.locator.startsWith("keychain:dcode:")?"keychain":provider.locator.startsWith("environment:")?"environment":"external_auth_bridge";
        this.database.prepare("UPDATE credential_references SET reference_kind=?,locator=?,configured=?,revision=revision+1,updated_at=? WHERE provider_id=? AND (reference_kind<>? OR locator<>? OR configured<>?)").run(kind,provider.locator,provider.configured?1:0,now,provider.providerId,kind,provider.locator,provider.configured?1:0);
      }
      return {value:{},event:{kind:"modelCredentials.changed",entityKind:"modelCredential",entityId:"connections",payload:{providers:safe.map(p=>p.providerId)}}};
    });
  }

  async seedRuntimeModelCatalog(input: {
    requestId: string;
    expectedStoreRevision?: number;
    adoptExistingProviderIds?: readonly string[];
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
      input.expectedStoreRevision,
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
          WHERE provider_id = ?
          ORDER BY created_at, id LIMIT 1
        `);
        const insertCredential = this.database.prepare(`
          INSERT INTO credential_references(
            id, provider_id, reference_kind, locator, configured,
            source_digest, revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
        `);
        const updateCredential = this.database.prepare(`
          UPDATE credential_references
          SET reference_kind = ?, locator = ?, configured = ?, source_digest = ?, revision = ?, updated_at = ?
          WHERE id = ?
        `);
        for (const provider of providers) {
          if ((provider.nonsecret as {source?:string}).source === "dcode_custom") {
            const existing=this.database.prepare("SELECT nonsecret_json FROM model_providers WHERE id=?").get(provider.id) as SQLiteRow|undefined;
            if(existing && (JSON.parse(text(existing,"nonsecret_json")) as {source?:string}).source !== "dcode_custom" && !input.adoptExistingProviderIds?.includes(provider.id)) throw new ProductStoreError("INVALID_ARGUMENT","该供应商 ID 已被内置或导入目录使用，请选择新的 ID");
            const selected=this.runtimeModelSelection();
            if(selected?.providerId===provider.id && !provider.models.some(m=>m.modelId===selected.modelId)) throw new ProductStoreError("INVALID_ARGUMENT","请先切换默认模型，再移除原默认模型");
          }
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
          if ((provider.nonsecret as { source?: string }).source === "dcode_custom") {
            const ids = provider.models.map(model => model.modelId);
            this.database.prepare(`DELETE FROM model_catalog_entries WHERE provider_id = ? AND model_id NOT IN (${ids.map(() => "?").join(",")})`).run(provider.id, ...ids);
          }
          for (const model of provider.models) {
            const priorModel=(provider.nonsecret as {source?:string}).source==="dcode_custom" ? this.database.prepare("SELECT nonsecret_json FROM model_catalog_entries WHERE provider_id=? AND model_id=?").get(provider.id,model.modelId) as SQLiteRow|undefined : undefined;
            const preservedMetadata=priorModel?JSON.parse(text(priorModel,"nonsecret_json")):{};
            upsertModel.run(
              `model-${createHash("sha256").update(`${provider.id}\0${model.modelId}`).digest("hex").slice(0, 32)}`,
              provider.id,
              model.modelId,
              model.name,
              model.contextWindow ?? null,
              model.maxTokens ?? null,
              model.reasoning ? 1 : 0,
              canonicalJSON({...preservedMetadata,...model.nonsecret as Record<string,unknown>}),
              now,
              now,
            );
          }
          const credential = existingCredential.get(provider.id) as SQLiteRow | undefined;
          if (credential) {
            updateCredential.run(
              provider.credential.locator.startsWith("keychain:dcode:") ? "keychain" : provider.credential.locator.startsWith("environment:") ? "environment" : "external_auth_bridge",
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
              provider.credential.locator.startsWith("keychain:dcode:") ? "keychain" : provider.credential.locator.startsWith("environment:") ? "environment" : "external_auth_bridge",
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
    return this.serializeMutation(()=>this.snapshotNow(afterEventSequence));
  }

  private async snapshotNow(afterEventSequence:number): Promise<FoundationSnapshot> {
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
    const managedIdeaRoot=await realpath(inspirationRoot(this.layout)).catch(()=>undefined);
    const taskContextSources = (
      this.database.prepare("SELECT * FROM task_context_sources ORDER BY task_id, ordinal").all() as SQLiteRow[]
    ).map(taskContextSource).map(source=>{const version=managedInspirationVersion(source,managedIdeaRoot);return version?{...source,inspirationVersion:version}:source;});
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
      ).map(credentialReference).map(reference => reference.locator.startsWith("environment:") ? {...reference,configured:!!process.env[reference.locator.slice("environment:".length)]} : reference),
      ...(runtimeModelSelection ? { runtimeModelSelection } : {}),
      taskWorkbenchViewState,
      agentProfiles: (this.database.prepare("SELECT * FROM agent_profiles ORDER BY builtin DESC, role, id").all() as SQLiteRow[]).map((row) => this.profileRecord(row)),
      tasks: (this.database.prepare("SELECT * FROM tasks ORDER BY created_at, id").all() as SQLiteRow[]).map(task),
      taskContextSets,
      taskPlans: (
        this.database.prepare("SELECT * FROM task_plans ORDER BY task_id, created_at, rowid").all() as SQLiteRow[]
      ).map(row => {
        const plan = taskPlan(row), route = readTaskRoute(plan.document);
        return { ...plan, ...(route ? { routeContextCurrent: route.contextKey === this.routeContextKey(plan.taskId), routeInputCurrent: route.acknowledgedInputId === this.latestRouteInput(plan.taskId)?.id } : {}) };
      }),
      taskWorkItems: (
        this.database.prepare("SELECT * FROM task_work_items ORDER BY task_id, ordinal, id").all() as SQLiteRow[]
      ).map(taskWorkItem),
      taskWorkflows: (
        this.database.prepare("SELECT * FROM task_workflows ORDER BY task_id, created_at, id").all() as SQLiteRow[]
      ).map(taskWorkflow),
      taskWorkflowVersions: (
        this.database.prepare("SELECT * FROM task_workflow_versions ORDER BY workflow_id, version").all() as SQLiteRow[]
      ).map(taskWorkflowVersion),
      taskWorkflowStages: (
        this.database.prepare("SELECT * FROM task_workflow_stages ORDER BY workflow_id, version, ordinal").all() as SQLiteRow[]
      ).map(taskWorkflowStage),
      taskWorkflowRuns: (
        this.database.prepare("SELECT * FROM task_workflow_runs ORDER BY task_id, created_at, id").all() as SQLiteRow[]
      ).map(taskWorkflowRun),
      taskWorkflowWorkItems: (
        this.database.prepare("SELECT * FROM task_workflow_work_items ORDER BY run_id, stage_id").all() as SQLiteRow[]
      ).map(taskWorkflowWorkItem),
      taskWorkflowReports: (
        this.database.prepare("SELECT * FROM task_workflow_reports ORDER BY run_id").all() as SQLiteRow[]
      ).map(taskWorkflowReport),
      taskSummaries: (this.database.prepare("SELECT id FROM tasks ORDER BY created_at,id").all() as SQLiteRow[])
        .flatMap(row => this.taskSummaryHistory(text(row, "id")).slice(-1)),
      taskSummaryFailures: (this.database.prepare("SELECT payload_json FROM store_events WHERE kind='taskSummary.failed' ORDER BY sequence DESC LIMIT 200").all() as SQLiteRow[])
        .map(row => JSON.parse(text(row, "payload_json")) as TaskSummaryFailureRecord),
      taskReviewRequests: (this.database.prepare("SELECT payload_json FROM evidence_records WHERE evidence_kind='review_diff_snapshot' ORDER BY created_at,id").all() as SQLiteRow[])
        .map(row => { const { diff: _diff, ...review } = JSON.parse(text(row, "payload_json")) as TaskReviewRequestRecord & { diff: string }; return review; }),
      taskSourceUses: (this.database.prepare("SELECT payload_json FROM store_events WHERE kind='taskSource.used' ORDER BY sequence DESC LIMIT 1000").all() as SQLiteRow[])
        .map(row => JSON.parse(text(row, "payload_json")) as TaskSourceUseRecord),
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
      ).map(evidenceRecord).map(item => {
        if (item.evidenceKind !== "review_diff_snapshot") return item;
        const { diff: _diff, ...payload } = item.payload as Record<string, unknown>;
        return { ...item, payload };
      }),
      verifications: this.verifications(),
      coordinatorReviews: this.coordinatorReviews(),
      agentProcesses: this.agentProcessExecutions(),
      collaborationMessages: this.collaborationMessages(),
      collaborationQueues:[...new Set(this.collaborationMessages().map(message=>message.targetSessionId))].map(id=>this.collaborationQueueState(id)),
      projectDirectoryChanges:this.projectDirectoryChanges(),
      providerCalls:this.providerCalls(),
      auxiliaryProcesses:this.auxiliaryProcessExecutions(),
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
    if (!provenance) return undefined;
    const copyDetails=JSON.parse(text(provenance,"details_json")) as {copiedFrom?:string;adapterContainsHistory?:boolean;copiedEntryIds?:string[]};
    if(text(provenance,"source_kind")==="native" && copyDetails.copiedFrom){
      if(copyDetails.adapterContainsHistory)return undefined;
      const copiedIds=new Set(copyDetails.copiedEntryIds??[]);
      const current=this.database.prepare("SELECT * FROM session_paths WHERE session_id=? AND is_current=1").get(sessionId) as SQLiteRow;
      const entries=(this.database.prepare("SELECT e.* FROM session_path_entries p JOIN session_entries e ON e.id=p.entry_id WHERE p.path_id=? AND e.message_role IN ('user','assistant') ORDER BY p.ordinal").all(text(current,"id")) as SQLiteRow[]).map(sessionEntry).filter(entry=>copiedIds.has(entry.id));
      return projectImportedSessionHistory({dcodeSessionId:sessionId,sourceSessionId:copyDetails.copiedFrom,sourceDigest:text(provenance,"source_digest"),importerVersion:1,sourcePathId:typeof current.source_path_id==="string"?current.source_path_id:text(current,"id"),redactedAtImport:false,entries:entries.map(entry=>({id:entry.id,messageRole:entry.messageRole as "user"|"assistant",content:entry.content}))});
    }
    if(text(provenance,"source_kind")!=="pi_import")return undefined;

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

    if(typeof currentPath.source_path_id!=="string"||!currentPath.source_path_id)throw new ProductStoreError("PRODUCT_STORE_CORRUPT","Pi-imported Session current path has no Pi source path identity",{sessionId});

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
      sourcePathId: typeof currentPath.source_path_id==="string"?currentPath.source_path_id:`native:${text(currentPath,"id")}`,
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
      if (state.inspectorTarget !== null || state.workspaceContent !== null) {
        throw new ProductStoreError(
          "INVALID_ARGUMENT",
          "Task Workbench object selection requires an active Task selection",
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
    const validateTarget = (target: { kind: string; id: string }, field: string): void => {
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
          `Task Workbench ${field} does not belong to its selected Task`,
          { taskId, [field]: target },
        );
      }
    };
    const target = state.inspectorTarget;
    if (target) validateTarget(target, "inspectorTarget");
    if (state.workspaceContent) validateTarget(state.workspaceContent, "workspaceContent");
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
    if (this.closing || this.closed) throw new ProductStoreError("PRODUCT_STORE_CLOSED", "D Code Product Store is closed");
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

  projectDirectoryChanges():ProjectDirectoryChange[]{
    this.assertOpen();return (this.database.prepare("SELECT payload_json FROM store_events WHERE sequence IN (SELECT MAX(sequence) FROM store_events WHERE kind='project.directoryChange' GROUP BY entity_id) ORDER BY sequence").all() as SQLiteRow[]).map(row=>JSON.parse(text(row,"payload_json")));
  }

  async renameProject(input:{requestId:string;projectId:string;expectedProjectRevision:number;title:string}):Promise<{storeRevision:number;project:ProjectRecord}> {
    const title=requiredCredentialFreeString(input.title,"title",200).trim();if(!title)throw new ProductStoreError("INVALID_ARGUMENT","项目名称不能为空");
    return this.mutate("project.rename",input.requestId,undefined,{...input,title},(_revision,now)=>{
      const previous=this.database.prepare("SELECT * FROM projects WHERE id=?").get(input.projectId) as SQLiteRow|undefined;
      if(!previous||integer(previous,"revision")!==input.expectedProjectRevision)throw new ProductStoreError("REVISION_CONFLICT","项目刚刚更新，请刷新后重试");
      this.database.prepare("UPDATE projects SET title=?,revision=revision+1,updated_at=? WHERE id=?").run(title,now,input.projectId);
      const updated={...project(previous),title,revision:integer(previous,"revision")+1,updatedAt:now};return {value:{project:updated},event:{kind:"project.renamed",entityKind:"project",entityId:input.projectId,payload:updated}};
    });
  }

  async prepareProjectDirectoryChange(change:ProjectDirectoryChange):Promise<{storeRevision:number}> {
    return this.mutate("project.directoryPrepare",`prepare:${change.id}`,undefined,change,()=>{
      const current=this.database.prepare("SELECT * FROM projects WHERE id=?").get(change.projectId) as SQLiteRow|undefined;
      if(!current||integer(current,"revision")!==change.expectedProjectRevision||current.directory!==change.sourceDirectory)throw new ProductStoreError("REVISION_CONFLICT","项目目录已改变，尚未移动文件");
      if(this.projectDirectoryChanges().some(item=>item.projectId===change.projectId&&["prepared","unknown"].includes(item.status)))throw new ProductStoreError("REVISION_CONFLICT","项目还有未确认的目录更换");
      if(change.status!=="prepared"||change.bindings.length>200)throw new ProductStoreError("INVALID_ARGUMENT","目录更换计划无效");
      const overlaps=(a:string,b:string)=>a===b||strictlyInside(a,b)||strictlyInside(b,a);
      if((this.database.prepare("SELECT id,directory FROM projects WHERE id<>?").all(change.projectId) as SQLiteRow[]).some(project=>project.directory===change.targetDirectory||change.moveFiles&&[change.sourceDirectory,change.targetDirectory].some(root=>overlaps(root,text(project,"directory")))))throw new ProductStoreError("REVISION_CONFLICT","准备期间另一个项目登记了相关目录，尚未移动文件");
      const bindings=this.database.prepare("SELECT b.* FROM session_runtime_bindings b JOIN tasks t ON t.id=b.task_id WHERE t.project_id=? AND b.cwd=?").all(change.projectId,change.sourceDirectory) as SQLiteRow[];
      if(bindings.length!==change.bindings.length||new Set(change.bindings.map(candidate=>candidate.sessionId)).size!==bindings.length||change.bindings.some(candidate=>!bindings.some(binding=>binding.session_id===candidate.sessionId&&binding.adapter_session_id===candidate.previousAdapterId&&integer(binding,"revision")===candidate.previousBindingRevision)))throw new ProductStoreError("REVISION_CONFLICT","项目会话在准备期间发生变化");
      requiredCredentialFreeString(change.title,"title",200);
      return {value:{},event:{kind:"project.directoryChange",entityKind:"projectDirectoryChange",entityId:change.id,payload:change}};
    });
  }

  async finishProjectDirectoryChange(id:string,status:"committed"|"cancelled"|"unknown",reason?:string):Promise<{storeRevision:number;change:ProjectDirectoryChange}> {
    return this.mutate("project.directoryFinish",`finish:${id}:${status}:${payloadHash(reason??null).slice(0,12)}`,undefined,{id,status,reason:reason??null},(_revision,now)=>{
      const change=this.projectDirectoryChanges().find(change=>change.id===id);
      if(!change||!["prepared","unknown"].includes(change.status))throw new ProductStoreError("REVISION_CONFLICT","目录更换已结束，请刷新项目状态");
      if(status==="committed"){
        const current=this.database.prepare("SELECT * FROM projects WHERE id=?").get(change.projectId) as SQLiteRow|undefined;
        if(!current||integer(current,"revision")!==change.expectedProjectRevision||current.directory!==change.sourceDirectory)throw new ProductStoreError("REVISION_CONFLICT","项目已被其他修改更新，不能覆盖");
        const bound=this.database.prepare("SELECT b.session_id FROM session_runtime_bindings b JOIN tasks t ON t.id=b.task_id WHERE t.project_id=? AND b.cwd=?").all(change.projectId,change.sourceDirectory) as SQLiteRow[];
        if(bound.length!==change.bindings.length||bound.some(row=>!change.bindings.some(candidate=>candidate.sessionId===row.session_id)))throw new ProductStoreError("REVISION_CONFLICT","项目会话在提交前发生变化");
        for(const candidate of change.bindings){
          const row=this.database.prepare("SELECT b.* FROM session_runtime_bindings b JOIN tasks t ON t.id=b.task_id WHERE b.session_id=? AND t.project_id=?").get(candidate.sessionId,change.projectId) as SQLiteRow|undefined;
          if(!row||row.adapter_session_id!==candidate.previousAdapterId||integer(row,"revision")!==candidate.previousBindingRevision)throw new ProductStoreError("REVISION_CONFLICT","会话绑定已改变，不能替换");
          this.database.prepare("UPDATE session_runtime_bindings SET adapter_session_id=?,adapter_session_path=?,cwd=?,state='ready',revision=revision+1,updated_at=? WHERE session_id=?").run(candidate.adapterSessionId,candidate.adapterSessionPath,change.targetDirectory,now,candidate.sessionId);
        }
        this.database.prepare("UPDATE projects SET title=?,directory=?,revision=revision+1,updated_at=? WHERE id=?").run(change.title,change.targetDirectory,now,change.projectId);
        this.database.prepare("UPDATE tasks SET cwd=?,revision=revision+1,updated_at=? WHERE project_id=?").run(change.targetDirectory,now,change.projectId);
        const digest=createHash("sha256").update(change.targetDirectory).digest("hex");
        this.database.prepare("UPDATE agent_assignments SET task_packet_json=json_set(task_packet_json,'$.workspaceRootDigest',?),revision=revision+1 WHERE task_id IN (SELECT id FROM tasks WHERE project_id=?) AND json_extract(task_packet_json,'$.workspacePolicy')='task_directory'").run(digest,change.projectId);
        this.database.prepare("UPDATE artifacts SET metadata_json=json_set(metadata_json,'$.state','unknown','$.failureCode','PROJECT_DIRECTORY_CHANGED'),revision=revision+1,updated_at=? WHERE task_id IN (SELECT id FROM tasks WHERE project_id=?) AND kind=? AND json_extract(metadata_json,'$.state')='ready'").run(now,change.projectId,MANAGED_WORKER_WORKTREE_ARTIFACT_KIND);
      }
      const next={...change,status,...(reason?{error:requiredCredentialFreeString(reason,"reason",2000)}:{})};
      return {value:{change:next},event:{kind:"project.directoryChange",entityKind:"projectDirectoryChange",entityId:change.id,payload:next}};
    });
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
        if(this.projectDirectoryChanges().some(change=>["prepared","unknown"].includes(change.status)&&[change.sourceDirectory,change.targetDirectory].some(root=>root===directory||strictlyInside(root,directory)||strictlyInside(directory,root))))throw new ProductStoreError("REVISION_CONFLICT","相关目录更换结果尚未确认，不能重新登记为其他项目");
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

  async replaySessionCopy(requestId:string,sourceSessionId:string): Promise<TaskBundle|undefined> {
    return this.replayReceipt<TaskBundle>("dcodeSession.copy",requestId,{sourceSessionId});
  }
  async copyTaskSession(input:{requestId:string;expectedStoreRevision:number;sourceSessionId:string;adapter?:{id:string;path:string}}):Promise<TaskBundle> {
    const sourceSessionId=requiredString(input.sourceSessionId,"sourceSessionId",200);
    return this.mutate("dcodeSession.copy",input.requestId,input.expectedStoreRevision,{sourceSessionId},(_revision,now)=>{
      const sourceSession=this.database.prepare("SELECT * FROM sessions WHERE id=?").get(sourceSessionId) as SQLiteRow|undefined;
      if(!sourceSession)throw new ProductStoreError("NOT_FOUND","Source session does not exist");
      const sourceTask=this.database.prepare("SELECT * FROM tasks WHERE id=?").get(text(sourceSession,"task_id")) as SQLiteRow;
      if(this.database.prepare("SELECT id FROM session_runs WHERE session_id=? AND status IN ('prepared','running','waiting') LIMIT 1").get(sourceSessionId))throw new ProductStoreError("REVISION_CONFLICT","请等待当前运行结束后再复制");
      const taskId=`task-${randomUUID()}`,sessionId=`session-${randomUUID()}`;
      const title=`${text(sourceSession,"title")} ${this.clientPreferences().language==='en'?'Copy':'副本'}`.slice(0,200);
      const insert=(table:string,row:SQLiteRow,overrides:Record<string,unknown>)=>{const next={...row,...overrides};const keys=Object.keys(next);this.database.prepare(`INSERT INTO ${table}(${keys.map(k=>`"${k}"`).join(",")}) VALUES (${keys.map(()=>"?").join(",")})`).run(...keys.map(k=>next[k]) as (string|number|bigint|Uint8Array|null)[]);};
      insert("tasks",sourceTask,{id:taskId,title,state:"draft",revision:1,created_at:now,updated_at:now});
      const context=this.database.prepare("SELECT * FROM task_context_sets WHERE task_id=?").get(text(sourceTask,"id")) as SQLiteRow;
      insert("task_context_sets",context,{task_id:taskId,revision:1,created_at:now,updated_at:now});
      for(const row of this.database.prepare("SELECT * FROM task_context_sources WHERE task_id=?").all(text(sourceTask,"id")) as SQLiteRow[]) insert("task_context_sources",row,{id:`context-${randomUUID()}`,task_id:taskId,created_at:now});
      insert("sessions",sourceSession,{id:sessionId,task_id:taskId,kind:"coordination",title,state:"idle",revision:1,created_at:now,updated_at:now});
      const entries=this.database.prepare("SELECT * FROM session_entries WHERE session_id=? ORDER BY source_ordinal,id").all(sourceSessionId) as SQLiteRow[];
      const entryIds=new Map(entries.map(row=>[text(row,"id"),`entry-${randomUUID()}`]));
      entries.forEach((row,index)=>insert("session_entries",row,{id:entryIds.get(text(row,"id")),session_id:sessionId,parent_entry_id:typeof row.parent_entry_id==="string"?entryIds.get(row.parent_entry_id)??null:null,source_entry_id:row.source_entry_id??row.id,source_timestamp:row.source_timestamp??row.created_at,source_ordinal:row.source_ordinal??index,created_at:now}));
      const paths=this.database.prepare("SELECT * FROM session_paths WHERE session_id=?").all(sourceSessionId) as SQLiteRow[];
      const pathIds=new Map(paths.map(row=>[text(row,"id"),`path-${randomUUID()}`]));
      for(const row of paths){insert("session_paths",row,{id:pathIds.get(text(row,"id")),session_id:sessionId,parent_path_id:typeof row.parent_path_id==="string"?pathIds.get(row.parent_path_id)??null:null,revision:1,created_at:now,updated_at:now});for(const link of this.database.prepare("SELECT * FROM session_path_entries WHERE path_id=?").all(text(row,"id")) as SQLiteRow[])insert("session_path_entries",link,{path_id:pathIds.get(text(row,"id")),entry_id:entryIds.get(text(link,"entry_id"))});}
      const sourceAssignment=this.database.prepare("SELECT * FROM coordinator_assignments WHERE task_id=?").get(text(sourceTask,"id")) as SQLiteRow;
      const assignmentId=`assignment-${randomUUID()}`;insert("coordinator_assignments",sourceAssignment,{id:assignmentId,task_id:taskId,session_id:sessionId,revision:1,created_at:now,updated_at:now});
      this.database.prepare("INSERT INTO session_provenance(id,task_id,session_id,source_kind,source_session_id,source_path,source_digest,historical_cwd,lineage_status,details_json,created_at) VALUES (?,?,?,'native',?,NULL,?,?,?, ?,?)").run(`provenance-${randomUUID()}`,taskId,sessionId,sourceSessionId,`sha256:${createHash("sha256").update(canonicalJSON(entries)).digest("hex")}`,text(sourceTask,"cwd"),text(sourceSession,"lineage_status"),canonicalJSON({copiedFrom:sourceSessionId,copyVersion:1,adapterContainsHistory:!!input.adapter,copiedEntryIds:[...entryIds.values()]}),now);
      if(input.adapter)this.database.prepare("INSERT INTO session_runtime_bindings(session_id,task_id,adapter_kind,adapter_session_id,adapter_session_path,cwd,state,revision,created_at,updated_at) VALUES (?,?,'pi',?,?,?,'ready',1,?,?)").run(sessionId,taskId,input.adapter.id,input.adapter.path,text(sourceTask,"cwd"),now,now);
      const newTask=task(this.database.prepare("SELECT * FROM tasks WHERE id=?").get(taskId) as SQLiteRow);
      return {value:{task:newTask,coordinationSession:session(this.database.prepare("SELECT * FROM sessions WHERE id=?").get(sessionId) as SQLiteRow),coordinatorAssignment:coordinatorAssignment(this.database.prepare("SELECT * FROM coordinator_assignments WHERE id=?").get(assignmentId) as SQLiteRow)},event:{kind:"dcodeSession.copied",entityKind:"session",entityId:sessionId,taskId,payload:{sourceSessionId,entryCount:entries.length}}};
    });
  }

  async manageTask(input: { requestId: string; expectedStoreRevision: number; taskId: string; action: "rename" | "archive" | "restore" | "trash"; title?: string }): Promise<{ storeRevision: number; task: TaskRecord }> {
    const taskId = requiredString(input.taskId, "taskId", 200);
    const title = input.action === "rename" ? requiredCredentialFreeString(input.title, "title", 200).trim() : undefined;
    if (input.action === "rename" && !title) throw new ProductStoreError("INVALID_ARGUMENT", "Task title cannot be empty");
    if (!["rename", "archive", "restore", "trash"].includes(input.action)) throw new ProductStoreError("INVALID_ARGUMENT", "Unsupported task action");
    return this.mutate("task.manage", input.requestId, input.expectedStoreRevision, { taskId, action: input.action, title }, (_revision, now) => {
      const row = this.database.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as SQLiteRow | undefined;
      if (!row) throw new ProductStoreError("NOT_FOUND", "Task does not exist");
      const previous = task(row);
      if (input.action === "restore" && previous.state !== "archived") throw new ProductStoreError("INVALID_ARGUMENT", "Only archived tasks can be restored");
      if (input.action !== "rename" && this.database.prepare("SELECT id FROM session_runs WHERE task_id = ? AND status IN ('prepared','running','waiting') UNION SELECT id FROM team_runs WHERE task_id = ? AND status IN ('prepared','active','waiting') LIMIT 1").get(taskId,taskId)) throw new ProductStoreError("REVISION_CONFLICT", "请先停止任务，再归档或恢复");
      if (input.action === "trash" && this.database.prepare("SELECT e.id FROM session_entries e JOIN sessions s ON s.id=e.session_id WHERE s.task_id=? LIMIT 1").get(taskId)) throw new ProductStoreError("INVALID_ARGUMENT", "只能将空任务移入废纸篓；已有消息请使用归档");
      const previousSessions = (this.database.prepare("SELECT id,state FROM sessions WHERE task_id=?").all(taskId) as SQLiteRow[]).map(s=>({id:text(s,"id"),state:text(s,"state")}));
      let state = previous.state;
      if (input.action === "rename") {
        this.database.prepare("UPDATE tasks SET title=?,revision=revision+1,updated_at=? WHERE id=?").run(title!,now,taskId);
        this.database.prepare("UPDATE sessions SET title=?,revision=revision+1,updated_at=? WHERE task_id=? AND kind='coordination'").run(title!,now,taskId);
      } else if (input.action === "restore") {
        const event = this.database.prepare("SELECT payload_json FROM store_events WHERE entity_id=? AND kind='task.archived' ORDER BY sequence DESC LIMIT 1").get(taskId) as SQLiteRow | undefined;
        const saved = event ? JSON.parse(text(event,"payload_json")) as {previousState:TaskRecord["state"];sessions:{id:string;state:string}[]} : undefined;
        state = saved?.previousState && saved.previousState !== "archived" ? saved.previousState : "draft";
        this.database.prepare("UPDATE tasks SET state=?,revision=revision+1,updated_at=? WHERE id=?").run(state,now,taskId);
        for (const session of saved?.sessions ?? previousSessions.map(s=>({...s,state:"idle"}))) this.database.prepare("UPDATE sessions SET state=?,revision=revision+1,updated_at=? WHERE id=? AND task_id=?").run(session.state,now,session.id,taskId);
      } else {
        if (previous.state === "archived") throw new ProductStoreError("INVALID_ARGUMENT", "Task is already archived");
        state="archived";
        this.database.prepare("UPDATE tasks SET state='archived',revision=revision+1,updated_at=? WHERE id=?").run(now,taskId);
        this.database.prepare("UPDATE sessions SET state='archived',revision=revision+1,updated_at=? WHERE task_id=?").run(now,taskId);
      }
      const updated = task(this.database.prepare("SELECT * FROM tasks WHERE id=?").get(taskId) as SQLiteRow);
      return { value: {task:updated}, event: {kind: input.action === "rename" ? "task.renamed" : input.action === "restore" ? "task.restored" : "task.archived",entityKind:"task",entityId:taskId,taskId,payload:{previousState:previous.state,sessions:previousSessions,trashed:input.action==="trash"}} };
    });
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
              requestId:input.requestId,
              task: taskRecord,
              coordinationSession,
              coordinatorAssignment: assignment,
            },
          },
        };
      },
    );
  }

  taskGoalHistory(taskId: string): TaskGoalRevisionRecord[] {
    this.assertOpen();
    const id = requiredString(taskId,"taskId",200);
    const currentRow = this.database.prepare("SELECT * FROM tasks WHERE id=?").get(id) as SQLiteRow | undefined;
    if (!currentRow) throw new ProductStoreError("NOT_FOUND","任务不存在");
    const current = task(currentRow);
    const created = this.database.prepare("SELECT payload_json,created_at FROM store_events WHERE task_id=? AND kind IN ('task.created','piImport.completed') ORDER BY sequence LIMIT 1").get(id) as SQLiteRow | undefined;
    const updates = this.database.prepare("SELECT payload_json,created_at FROM store_events WHERE task_id=? AND kind='task.goalUpdated' ORDER BY sequence").all(id) as SQLiteRow[];
    const result:TaskGoalRevisionRecord[]=[];
    if (created) {
      const original=(JSON.parse(text(created,"payload_json")) as {task:TaskRecord}).task;
      result.push({taskId:id,goal:original.goal,acceptance:original.acceptance,taskRevision:original.revision,changedAt:text(created,"created_at")});
    } else if (updates.length) {
      const original=(JSON.parse(text(updates[0]!,"payload_json")) as {previous:TaskGoalRevisionRecord}).previous;
      result.push(original);
    }
    for (const row of updates) result.push((JSON.parse(text(row,"payload_json")) as {current:TaskGoalRevisionRecord}).current);
    if (!result.length) result.push({taskId:id,goal:current.goal,acceptance:current.acceptance,taskRevision:current.revision,changedAt:current.updatedAt});
    return result;
  }

  async continueTaskSession(input: {
    requestId: string;
    expectedStoreRevision: number;
    taskId: string;
  }): Promise<TaskBundle & { previousSessionId: string }> {
    const taskId = requiredString(input.taskId, "taskId", 200);
    return await this.mutate(
      "task.session.continue",
      input.requestId,
      input.expectedStoreRevision,
      { taskId },
      (_storeRevision, now) => {
        const taskRow = this.database.prepare("SELECT * FROM tasks WHERE id=?").get(taskId) as SQLiteRow | undefined;
        if (!taskRow) throw new ProductStoreError("NOT_FOUND", "Task does not exist");
        const currentTask = task(taskRow);
        if (currentTask.state === "archived") throw new ProductStoreError("REVISION_CONFLICT", "归档任务不能开始新会话");
        const previous = this.database.prepare("SELECT * FROM sessions WHERE task_id=? AND kind='coordination'").get(taskId) as SQLiteRow | undefined;
        const assignment = this.database.prepare("SELECT * FROM coordinator_assignments WHERE task_id=?").get(taskId) as SQLiteRow | undefined;
        if (!previous || !assignment || text(assignment, "session_id") !== text(previous, "id")) {
          throw new ProductStoreError("PRODUCT_STORE_CORRUPT", "当前协调会话与指派不一致");
        }
        // In-flight work still routes reports and requests to the old coordinator.
        // A fresh segment is safe only after those obligations have settled.
        const busy = this.database.prepare(`
          SELECT id FROM session_runs WHERE task_id=? AND status IN ('prepared','running','waiting')
          UNION SELECT id FROM team_runs WHERE task_id=? AND status IN ('prepared','active','waiting')
          UNION SELECT id FROM agent_requests WHERE task_id=? AND status='open'
          LIMIT 1
        `).get(taskId, taskId, taskId);
        if (busy || this.collaborationMessages(taskId).some(message => ["queued", "paused", "delivering"].includes(message.state))) {
          throw new ProductStoreError("REVISION_CONFLICT", "任务仍有运行、待答请求或待发送消息，请先完成或停止后再开始新会话");
        }
        const previousSessionId = text(previous, "id");
        this.database.prepare("UPDATE sessions SET kind='standard',state='completed',revision=revision+1,updated_at=? WHERE id=?")
          .run(now, previousSessionId);
        const ordinalRow = this.database.prepare("SELECT COUNT(*) AS total FROM sessions WHERE task_id=? AND kind='standard'").get(taskId) as SQLiteRow;
        const coordinationSession: DCodeSessionRecord = {
          id: `session-${randomUUID()}`,
          taskId,
          kind: "coordination",
          title: `${currentTask.title.slice(0, 175)} · ${this.clientPreferences().language==='en'?`Conversation ${integer(ordinalRow,"total")+1}`:`第 ${integer(ordinalRow,"total")+1} 段`}`,
          runtimeAdapter: "pi",
          lineageStatus: "native",
          state: "idle",
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        this.database.prepare(`INSERT INTO sessions(id,task_id,kind,title,runtime_adapter,lineage_status,state,revision,created_at,updated_at)
          VALUES (?,?, 'coordination',?, 'pi','native','idle',1,?,?)`)
          .run(coordinationSession.id, taskId, coordinationSession.title, now, now);
        this.database.prepare(`INSERT INTO session_paths(id,session_id,parent_path_id,source_path_id,source_leaf_entry_id,title,is_current,revision,created_at,updated_at)
          VALUES (?,?,NULL,NULL,NULL,'主路径',1,1,?,?)`)
          .run(`path-${randomUUID()}`, coordinationSession.id, now, now);
        this.database.prepare(`INSERT INTO session_provenance(id,task_id,session_id,source_kind,source_session_id,source_path,source_digest,historical_cwd,lineage_status,details_json,created_at)
          VALUES (?,?,?,'native',?,NULL,NULL,?,'native',?,?)`)
          .run(`provenance-${randomUUID()}`, taskId, coordinationSession.id, previousSessionId, currentTask.cwd, canonicalJSON({ continuedFromSessionId: previousSessionId }), now);
        const oldDraft = this.database.prepare("SELECT * FROM composer_drafts WHERE session_id=? AND draft_kind='session_path'").get(previousSessionId) as SQLiteRow | undefined;
        if (oldDraft) {
          const draft = composerDraft(oldDraft);
          if (draft.targetAgentRunId || draft.pathAction || draft.pathDraftBackup) throw new ProductStoreError("REVISION_CONFLICT", "请先处理定向成员或历史续写草稿，再开始新对话");
          const payload = JSON.parse(text(oldDraft, "payload_json")) as Record<string, unknown>;
          const { targetAgentRunId: _target, pathAction: _path, pathDraftBackup: _backup, ...portable } = payload;
          this.database.prepare(`INSERT INTO composer_drafts(id,task_id,session_id,draft_kind,text,payload_json,source_ordinal,revision,created_at,updated_at)
            VALUES (?,?,?,'session_path',?,?,NULL,1,?,?)`)
            .run(`composer-draft:${coordinationSession.id}`, taskId, coordinationSession.id, text(oldDraft, "text"), canonicalJSON(portable), now, now);
          this.database.prepare("DELETE FROM composer_drafts WHERE id=?").run(text(oldDraft, "id"));
        }
        const oldModel = this.database.prepare("SELECT value_json FROM product_settings WHERE key=?").get(`session.modelSelection:${previousSessionId}`) as SQLiteRow | undefined;
        if (oldModel) {
          const selection = JSON.parse(text(oldModel, "value_json")) as { providerId?: string; modelId?: string };
          if (selection.providerId && selection.modelId && this.database.prepare("SELECT id FROM model_catalog_entries WHERE provider_id=? AND model_id=?").get(selection.providerId, selection.modelId)) {
            this.database.prepare("INSERT INTO product_settings(key,value_json,source_kind,revision,created_at,updated_at) VALUES (?,?,'user',1,?,?)")
              .run(`session.modelSelection:${coordinationSession.id}`, text(oldModel, "value_json"), now, now);
          }
        }
        this.database.prepare("UPDATE coordinator_assignments SET session_id=?,revision=revision+1,updated_at=? WHERE id=?")
          .run(coordinationSession.id, now, text(assignment, "id"));
        const updatedAssignment = coordinatorAssignment(this.database.prepare("SELECT * FROM coordinator_assignments WHERE id=?").get(text(assignment, "id")) as SQLiteRow);
        return {
          value: { task: currentTask, coordinationSession, coordinatorAssignment: updatedAssignment, previousSessionId },
          event: { kind: "task.sessionContinued", entityKind: "session", entityId: coordinationSession.id, taskId,
            payload: { previousSessionId, coordinationSession, coordinatorAssignment: updatedAssignment } },
        };
      },
    );
  }

  async replayTaskSessionContinuation(requestId: string, taskId: string): Promise<(TaskBundle & { previousSessionId: string }) | undefined> {
    return await this.replayReceipt("task.session.continue", requestId, { taskId });
  }

  async requestTaskReview(input: {
    requestId: string; expectedStoreRevision: number; taskId: string;
    path: string; staged: boolean; diff: string; digest: string; baseHead: string; rootDigest: string; workItemId?: string;
  }): Promise<{ storeRevision: number; review: TaskReviewRequestRecord }> {
    const taskId = requiredString(input.taskId, "taskId", 200);
    const path = normalizedContextRelativePath(input.path, "review path");
    const diff = requiredCredentialFreeString(input.diff, "review diff", 32_768);
    const digest = requiredString(input.digest, "review digest", 71);
    const baseHead = requiredString(input.baseHead, "review base HEAD", 64);
    const rootDigest = requiredString(input.rootDigest, "review root identity", 71);
    if (!/^sha256:[a-f0-9]{64}$/.test(digest) || `sha256:${createHash("sha256").update(diff).digest("hex")}` !== digest
      || !(baseHead === "unborn" || /^[a-f0-9]{40,64}$/.test(baseHead)) || !/^sha256:[a-f0-9]{64}$/.test(rootDigest)
      || typeof input.staged !== "boolean") throw new ProductStoreError("INVALID_ARGUMENT", "审查差异身份无效");
    const workItemId = input.workItemId === undefined ? undefined : requiredString(input.workItemId, "workItemId", 200);
    return await this.mutate("task.review.request", input.requestId, input.expectedStoreRevision,
      { taskId, path, staged: input.staged, digest, baseHead, rootDigest, workItemId }, (_storeRevision, now) => {
        const taskRow = this.database.prepare("SELECT * FROM tasks WHERE id=?").get(taskId) as SQLiteRow | undefined;
        const currentSession = this.database.prepare("SELECT id FROM sessions WHERE task_id=? AND kind='coordination'").get(taskId) as SQLiteRow | undefined;
        if (!taskRow || !currentSession || task(taskRow).state === "archived") throw new ProductStoreError("NOT_FOUND", "审查任务不可用");
        if (workItemId && !this.database.prepare("SELECT id FROM task_work_items WHERE id=? AND task_id=? AND state<>'cancelled'").get(workItemId, taskId)) {
          throw new ProductStoreError("NOT_FOUND", "工作项不属于当前任务或已取消");
        }
        if (workItemId) {
          const priorRow = this.database.prepare(`SELECT payload_json FROM evidence_records WHERE task_id=? AND evidence_kind='review_diff_snapshot'
            AND json_extract(payload_json,'$.workItemId')=? ORDER BY created_at DESC,id DESC LIMIT 1`).get(taskId, workItemId) as SQLiteRow | undefined;
          if (priorRow) {
            const prior = JSON.parse(text(priorRow, "payload_json")) as TaskReviewRequestRecord;
            if (prior.digest === digest) throw new ProductStoreError("REVISION_CONFLICT", "该工作项的差异版本未变化；请继续原审查并提供新证据，或先产生新变更");
          }
        }
        const resolvedWorkItemId = workItemId ?? `work-${randomUUID()}`;
        if (!workItemId) {
          const ordinal = this.database.prepare("SELECT COALESCE(MAX(ordinal),-1)+1 AS next FROM task_work_items WHERE task_id=?").get(taskId) as SQLiteRow;
          this.database.prepare(`INSERT INTO task_work_items(id,task_id,ordinal,title,state,owner_assignment_id,details_json,revision,created_at,updated_at)
            VALUES (?,?,?,?,'pending',NULL,?,1,?,?)`)
            .run(resolvedWorkItemId, taskId, integer(ordinal, "next"), `审查 ${path}`.slice(0, 500), canonicalJSON({ reviewScope: { path, digest } }), now, now);
        }
        const review: TaskReviewRequestRecord = {
          id: `review-${randomUUID()}`, taskId, sessionId: text(currentSession, "id"),
          evidenceId: `evidence-${randomUUID()}`, path, staged: input.staged, digest,
          baseHead, rootDigest,
          workItemId: resolvedWorkItemId, createdAt: now,
          workItemExplicit: workItemId !== undefined,
        };
        const evidence: EvidenceRecord = {
          id: review.evidenceId, taskId, sessionId: review.sessionId,
          evidenceKind: "review_diff_snapshot", payload: { ...review, diff }, createdAt: now,
        };
        this.database.prepare(`INSERT INTO evidence_records(id,task_id,session_id,legacy_run_id,agent_run_id,source_record_id,evidence_kind,command_redacted,exit_kind,exit_code,started_at,ended_at,cwd,payload_json,created_at)
          VALUES (?,?,?,NULL,NULL,?,'review_diff_snapshot',NULL,NULL,NULL,NULL,NULL,?,?,?)`)
          .run(evidence.id, taskId, review.sessionId, review.id, task(taskRow).cwd, canonicalJSON(evidence.payload), now);
        return { value: { review }, event: { kind: "evidence.recorded", entityKind: "evidence", entityId: evidence.id, taskId, payload: evidence } };
      });
  }

  async replayTaskReviewRequest(input: { requestId: string; taskId: string; path: string; staged: boolean; digest: string; workItemId?: string }): Promise<{ storeRevision: number; review: TaskReviewRequestRecord } | undefined> {
    this.assertOpen();
    await this.lease.assertOwned();
    const row = this.database.prepare("SELECT method,result_json FROM mutation_receipts WHERE request_id=?").get(input.requestId) as SQLiteRow | undefined;
    if (!row) return undefined;
    if (text(row, "method") !== "task.review.request") throw new ProductStoreError("IDEMPOTENCY_KEY_REUSED", "审查请求标识已用于其他操作");
    const result = JSON.parse(text(row, "result_json")) as { storeRevision: number; review: TaskReviewRequestRecord };
    const review = result.review;
    if (review.taskId !== input.taskId || review.path !== input.path || review.staged !== input.staged || review.digest !== input.digest
      || review.workItemExplicit !== (input.workItemId !== undefined) || input.workItemId !== undefined && review.workItemId !== input.workItemId) throw new ProductStoreError("IDEMPOTENCY_KEY_REUSED", "审查请求标识对应不同范围");
    return result;
  }

  readTaskReview(taskId: string, reviewId: string): { review: TaskReviewRequestRecord; diff: string } {
    this.assertOpen();
    const evidence = this.database.prepare("SELECT payload_json FROM evidence_records WHERE source_record_id=? AND task_id=? AND evidence_kind='review_diff_snapshot'").get(reviewId, taskId) as SQLiteRow | undefined;
    if (!evidence) throw new ProductStoreError("NOT_FOUND", "审查请求不属于当前任务");
    const payload = JSON.parse(text(evidence, "payload_json")) as { diff?: string };
    const { diff: _diff, ...record } = payload as TaskReviewRequestRecord & { diff: string };
    if (typeof payload.diff !== "string" || `sha256:${createHash("sha256").update(payload.diff).digest("hex")}` !== record.digest) {
      throw new ProductStoreError("PRODUCT_STORE_CORRUPT", "审查差异证据已改变");
    }
    return { review: record, diff: payload.diff };
  }

  async inspectTaskReview(input: { requestId: string; taskId: string; reviewId: string; verifierAgentRunId: string; sessionRunId: string }): Promise<{ storeRevision: number; evidenceId: string }> {
    return await this.mutate("task.review.inspect", input.requestId, undefined, input, (_revision, now) => {
      const { review } = this.readTaskReview(input.taskId, input.reviewId);
      const run = this.database.prepare(`SELECT r.session_id FROM session_runs r JOIN agent_runs g ON g.id=r.agent_run_id
        WHERE r.id=? AND r.task_id=? AND r.agent_run_id=? AND r.status='running' AND g.role='verifier'`)
        .get(input.sessionRunId, input.taskId, input.verifierAgentRunId) as SQLiteRow | undefined;
      if (!run) throw new ProductStoreError("REVISION_CONFLICT", "只有正在运行的独立验收成员可检查固定差异");
      const evidenceId = `evidence-${randomUUID()}`;
      const evidence: EvidenceRecord = { id: evidenceId, taskId: input.taskId, sessionId: text(run, "session_id"), agentRunId: input.verifierAgentRunId,
        evidenceKind: "review_diff_inspection", commandRedacted: "dcode_verification.read_review", exitKind: "ok",
        payload: { reviewId: review.id, digest: review.digest, resultDigest: review.digest, sessionRunId: input.sessionRunId }, createdAt: now };
      this.database.prepare(`INSERT INTO evidence_records(id,task_id,session_id,legacy_run_id,agent_run_id,source_record_id,evidence_kind,command_redacted,exit_kind,exit_code,started_at,ended_at,cwd,payload_json,created_at)
        VALUES (?,?,?,NULL,?,?,'review_diff_inspection','dcode_verification.read_review','ok',0,?,?,NULL,?,?)`)
        .run(evidenceId, input.taskId, evidence.sessionId, input.verifierAgentRunId, review.id, now, now, canonicalJSON(evidence.payload), now);
      return { value: { evidenceId }, event: { kind: "evidence.recorded", entityKind: "evidence", entityId: evidenceId, taskId: input.taskId, payload: evidence } };
    });
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

  taskRouteContext(taskId: string): TaskRouteContext | undefined {
    const row = this.database.prepare("SELECT * FROM task_plans WHERE task_id=? AND state='active'").get(taskId) as SQLiteRow | undefined;
    if (!row) return undefined;
    const plan = taskPlan(row), route = readTaskRoute(plan.document);
    const latest = this.latestRouteInput(taskId), inputCurrent = route?.acknowledgedInputId === latest?.id;
    return route ? { planId: plan.id, planRevision: plan.revision, contextCurrent: route.contextKey === this.routeContextKey(taskId), inputCurrent, ...(!inputCurrent && latest ? { pendingInput: { ...latest, text: latest.text.slice(0, 4000), complete: latest.text.length <= 4000 } } : {}), route } : undefined;
  }

  private taskSummaryFacts(taskId: string): { digest: string; sections: TaskSummaryRecord["sections"] } {
    const taskRow = this.database.prepare("SELECT * FROM tasks WHERE id=?").get(taskId) as SQLiteRow | undefined;
    if (!taskRow) throw new ProductStoreError("NOT_FOUND", "任务不存在");
    const currentTask = task(taskRow);
    const route = this.taskRouteContext(taskId);
    const items = this.routeWorkItems(taskId);
    const reports = (this.database.prepare("SELECT * FROM agent_reports WHERE task_id=? ORDER BY created_at DESC,id DESC LIMIT 3").all(taskId) as SQLiteRow[]).map(agentReport);
    const inputs = (this.database.prepare(`SELECT r.id,r.submitted_text,r.session_id FROM raw_inputs r WHERE r.task_id=?
      AND r.source_kind IN ('user_submit','edit_and_rerun','continue_path') AND NOT EXISTS (
        SELECT 1 FROM store_events e WHERE e.task_id=r.task_id AND e.kind='collaboration.messageChanged'
        AND json_extract(e.payload_json,'$.originRawInputId')=r.id AND json_extract(e.payload_json,'$.uiAction.kind')='task.review.request'
      ) ORDER BY r.created_at DESC,r.rowid DESC LIMIT 12`).all(taskId) as SQLiteRow[])
      .map(row => ({ id: text(row, "id"), text: text(row, "submitted_text"), sessionId: text(row, "session_id") }));
    const latestInput = inputs[0];
    const facts = {
      task: { id: currentTask.id, goal: currentTask.goal, acceptance: currentTask.acceptance, revision: currentTask.revision },
      route: route ? { planId: route.planId, planRevision: route.planRevision, contextCurrent: route.contextCurrent, inputCurrent: route.inputCurrent, status: route.route.status, selectedCandidateId: route.route.selectedCandidateId, reason: route.route.reason } : null,
      items: items.map(item => ({ id: item.id, title: item.title, state: item.state, revision: item.revision })),
      reports: reports.map(report => ({ id: report.id, createdAt: report.createdAt, agentRunId: report.agentRunId })),
      inputs: inputs.map(item => ({ id: item.id, digest: payloadHash(item.text) })),
    };
    const sections: TaskSummaryRecord["sections"] = { confirmed: [], pending: [], blocked: [], next: [] };
    const add = (section: TaskSummarySection, value: string, source: TaskSummarySourceRef) => {
      if (sections[section].length >= 8) return;
      const concise = value.trim().slice(0, 500);
      if (!concise || redactCredentialText(concise).redacted) return;
      sections[section].push({ text: concise, sources: [source] });
    };
    add("confirmed", `任务目标：${currentTask.goal}`, { kind: "task", id: taskId, revision: currentTask.revision });
    if (route) {
      const source: TaskSummarySourceRef = { kind: "task_route", id: route.planId, revision: route.planRevision };
      if (route.route.status === "ready" && route.contextCurrent && route.inputCurrent !== false) {
        const selected = route.route.candidates.find(candidate => candidate.id === route.route.selectedCandidateId);
        if (selected) add("confirmed", `当前采用路线：${selected.title}。${selected.approach}`, source);
      } else if (route.route.status === "invalidated" || !route.contextCurrent || route.inputCurrent === false) {
        add("blocked", `既有路线需要重新核对：${route.route.reason || "目标、资料或最新输入已变化"}`, source);
      } else if (route.route.status === "exploring") {
        add("pending", `路线仍在探索：${route.route.question}`, source);
      }
    }
    const explicitDecision = inputs.find(item => /(?:^|[。！\n])\s*(?:我(?:们)?(?:确认|决定|选择|采用)|确认(?:采用|选择|按)|决定|选择|采用)/u.test(item.text));
    if (explicitDecision) {
      add("blocked", `历史用户表述，当前适用性待核对：${explicitDecision.text}`, { kind: "raw_input", id: explicitDecision.id });
    }
    if (latestInput) add("pending", `最近用户输入（需核对是否改变既有结论）：${latestInput.text}`, { kind: "raw_input", id: latestInput.id });
    for (const report of reports) {
      const body = report.body && typeof report.body === "object" && !Array.isArray(report.body) ? report.body as { text?: unknown } : undefined;
      const excerpt = typeof body?.text === "string" ? body.text.slice(0, 220) : "";
      add("confirmed", `已收到${report.reportKind === "verification" ? "验收" : "成员"}报告${excerpt ? `，报告称：${excerpt}` : ""}（仍需独立核对）`, { kind: "agent_report", id: report.id });
    }
    const completedCount = items.filter(item => item.state === "completed").length;
    if (completedCount > 4) add("confirmed", `共有 ${completedCount} 项工作记录为已完成；下方仅列部分，请回工作清单核对其余项。`, { kind: "task", id: taskId, revision: currentTask.revision });
    const openCount = items.filter(item => item.state === "pending" || item.state === "in_progress").length;
    if (openCount > 6) add("pending", `还有 ${openCount} 项待处理或进行中工作；下方仅列部分，请回工作清单核对。`, { kind: "task", id: taskId, revision: currentTask.revision });
    for (const item of items) {
      const source: TaskSummarySourceRef = { kind: "work_item", id: item.id, revision: item.revision };
      if (item.state === "completed") add("confirmed", `工作项已记录完成（仍需单独验收）：${item.title}`, source);
      else if (item.state === "blocked") add("blocked", `工作项受阻：${item.title}`, source);
      else if (item.state !== "cancelled") add("pending", `${item.state === "in_progress" ? "进行中" : "待处理"}：${item.title}`, source);
    }
    const next = items.find(item => item.state === "pending" || item.state === "in_progress" || item.state === "blocked");
    if (next) add("next", `核对并推进工作项：${next.title}`, { kind: "work_item", id: next.id, revision: next.revision });
    else add("next", "核对任务验收条件与尚缺证据。", { kind: "task", id: taskId, revision: currentTask.revision });
    return { digest: payloadHash(facts), sections };
  }

  taskSummaryHistory(taskId: string): TaskSummaryRecord[] {
    this.assertOpen();
    const currentFacts = this.taskSummaryFacts(taskId).digest;
    return (this.database.prepare("SELECT payload_json FROM store_events WHERE task_id=? AND kind='taskSummary.revised' ORDER BY sequence").all(taskId) as SQLiteRow[])
      .map(row => JSON.parse(text(row, "payload_json")) as TaskSummaryRecord)
      .map(record => ({ ...record, current: record.factsDigest === currentFacts }));
  }

  readTaskSummarySource(taskId: string, source: TaskSummarySourceRef): { state: "available" | "historical_unavailable"; title: string; content?: string } {
    this.assertOpen();
    requiredString(taskId, "taskId", 200);
    if (!source || !["task", "task_route", "work_item", "agent_report", "raw_input", "summary_revision", "user_correction"].includes(source.kind)
      || typeof source.id !== "string" || source.id.length > 200 || !source.id
      || source.revision !== undefined && (!Number.isSafeInteger(source.revision) || source.revision < 1)) {
      throw new ProductStoreError("INVALID_ARGUMENT", "摘要来源身份无效");
    }
    if (!this.database.prepare("SELECT id FROM tasks WHERE id=?").get(taskId)) throw new ProductStoreError("NOT_FOUND", "任务不存在");
    const english=this.clientPreferences().language==='en';
    const label=(zh:string,en:string)=>english?en:zh;
    const goalContent=(goal:string,acceptance:string[])=>`${label('任务目标：','Task goal: ')}${goal}\n${label('验收要求：','Acceptance criteria: ')}${acceptance.join(english?'; ':'；')||label('未单独列出','Not specified')}`;
    let title = label("来源","Source");
    let content: string | undefined;
    if (source.kind === "summary_revision" || source.kind === "user_correction") {
      if (source.id !== `task-summary-${taskId}` || !source.revision) throw new ProductStoreError("NOT_FOUND", "摘要来源不属于当前任务");
      const old = this.taskSummaryHistory(taskId).find(item => item.revision === source.revision);
      title = english?`Task summary · Version ${source.revision}`:`任务摘要 · 第 ${source.revision} 版`;
      if (old) content = (["confirmed", "pending", "blocked", "next"] as TaskSummarySection[])
        .map(key => `${({ confirmed:label("已确认","Confirmed"),pending:label("未完成","Incomplete"),blocked:label("阻塞与待核对","Blockers and unconfirmed items"),next:label("下一步","Next step") })[key]}\n${old.sections[key].map(claim => `• ${claim.text}`).join("\n") || label("暂无记录","No records yet")}`)
        .join("\n\n");
    } else {
      const table = source.kind === "task" ? "tasks" : source.kind === "task_route" ? "task_plans" : source.kind === "work_item" ? "task_work_items" : source.kind === "raw_input" ? "raw_inputs" : "agent_reports";
      const row = this.database.prepare(`SELECT * FROM ${table} WHERE id=? ${table === "tasks" ? "" : "AND task_id=?"}`)
        .get(...(table === "tasks" ? [source.id] : [source.id, taskId])) as SQLiteRow | undefined;
      if (!row || source.kind === "task" && source.id !== taskId) throw new ProductStoreError("NOT_FOUND", "摘要来源不属于当前任务");
      const revision = typeof row.revision === "number" ? row.revision : undefined;
      title = source.kind === "task" ? text(row, "title") : source.kind === "work_item" ? text(row, "title") : source.kind === "task_route" ? label("任务路线","Task route") : source.kind === "raw_input" ? label("用户提交原文","Submitted original text") : label("成员报告","Member report");
      if (source.revision === undefined || source.revision === revision) {
        content = source.kind === "task"
          ? goalContent(text(row,"goal"),JSON.parse(text(row,"acceptance_json")) as string[])
          : source.kind === "work_item"
            ? `${label('工作项：','Work item: ')}${text(row, "title")}\n${label('当前状态：','Current state: ')}${text(row, "state")}`
            : source.kind === "task_route" ? JSON.stringify(JSON.parse(text(row, "document_json")), null, 2)
              : source.kind === "raw_input" ? text(row, "submitted_text")
              : (() => { const body = JSON.parse(text(row, "body_json")) as { text?: unknown }; return typeof body.text === "string" ? body.text : JSON.stringify(body, null, 2); })();
      } else if (source.kind === "task") {
        const historical=this.taskGoalHistory(taskId).filter(item=>item.taskRevision<=source.revision!).at(-1);
        if (historical) content=goalContent(historical.goal,historical.acceptance);
      }
    }
    if (!content || content.length > 65_536 || redactCredentialText(content).redacted) return { state: "historical_unavailable", title };
    return { state: "available", title, content };
  }

  private recallEntryText(row: SQLiteRow): string | undefined {
    const value = JSON.parse(text(row, "content_json")) as unknown;
    const content = typeof value === "string" ? value
      : value && typeof value === "object" && !Array.isArray(value) && typeof (value as { text?: unknown }).text === "string"
        ? (value as { text: string }).text
        : value && typeof value === "object" && !Array.isArray(value) && Array.isArray((value as { content?: unknown }).content)
          ? ((value as { content: Array<{ type?: string; text?: string }> }).content).filter(part => part.type === "text").map(part => part.text ?? "").join("\n")
          : undefined;
    if (!content || Buffer.byteLength(content) > 32_768 || redactCredentialText(content).redacted) return undefined;
    return content;
  }

  taskRecallEntryCount(taskId: string, excludeEntryId?: string): number {
    this.assertOpen();
    const row=this.database.prepare(`SELECT COUNT(*) AS total FROM session_entries e JOIN sessions s ON s.id=e.session_id
      JOIN session_path_entries pe ON pe.entry_id=e.id JOIN session_paths p ON p.id=pe.path_id AND p.session_id=s.id AND p.is_current=1
      WHERE s.task_id=? AND e.message_role IN ('user','assistant') AND (? IS NULL OR e.id<>?)`).get(taskId,excludeEntryId??null,excludeEntryId??null) as SQLiteRow;
    return integer(row,"total");
  }

  searchTaskEntries(taskId: string, query: string, limit = 12, excludeEntryId?: string, offset = 0): TaskRecallEntryCandidate[] {
    return this.searchTaskEntriesPage(taskId,query,limit,excludeEntryId,offset).items;
  }

  searchTaskEntriesPage(taskId: string, query: string, limit = 12, excludeEntryId?: string, offset = 0): {items:TaskRecallEntryCandidate[];scanned:number;total:number} {
    this.assertOpen();
    requiredString(taskId, "taskId", 200);
    const needle = requiredString(query.trim(), "query", 200).toLocaleLowerCase();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 12 || !Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) throw new ProductStoreError("INVALID_ARGUMENT", "召回数量无效");
    const rows = this.database.prepare(`SELECT e.*,s.title AS session_title FROM session_entries e
      JOIN sessions s ON s.id=e.session_id
      JOIN session_path_entries pe ON pe.entry_id=e.id
      JOIN session_paths p ON p.id=pe.path_id AND p.session_id=s.id AND p.is_current=1
      WHERE s.task_id=? AND e.message_role IN ('user','assistant')
      AND (? IS NULL OR e.id<>?) ORDER BY e.created_at DESC,e.id DESC LIMIT 600 OFFSET ?`).all(taskId,excludeEntryId??null,excludeEntryId??null,offset) as SQLiteRow[];
    const matches: TaskRecallEntryCandidate[] = [];
    let scanned=0;
    for (const row of rows) {
      scanned++;
      const content = this.recallEntryText(row);
      if (!content || !content.toLocaleLowerCase().includes(needle)) continue;
      matches.push({ sessionId: text(row, "session_id"), entryId: text(row, "id"), role: text(row, "message_role"),
        title: `${text(row, "session_title")} · ${text(row, "message_role") === "user" ? "用户" : "助手"}消息`,
        digest: `sha256:${createHash("sha256").update(content).digest("hex")}`, createdAt: text(row, "created_at") });
      if (matches.length >= limit) break;
    }
    return {items:matches,scanned,total:this.taskRecallEntryCount(taskId,excludeEntryId)};
  }

  readTaskEntry(taskId: string, entryId: string, requireCurrentPath = false): { sessionId: string; entryId: string; role: string; content: string; digest: string; currentPath: boolean } {
    this.assertOpen();
    const row = this.database.prepare(`SELECT e.* FROM session_entries e JOIN sessions s ON s.id=e.session_id
      WHERE s.task_id=? AND e.id=? AND e.message_role IN ('user','assistant')`).get(taskId, entryId) as SQLiteRow | undefined;
    if (!row) throw new ProductStoreError("NOT_FOUND", "消息不属于当前任务");
    const currentPath = !!this.database.prepare(`SELECT pe.entry_id FROM session_path_entries pe JOIN session_paths p ON p.id=pe.path_id
      WHERE pe.entry_id=? AND p.session_id=? AND p.is_current=1`).get(entryId,text(row,"session_id"));
    if (requireCurrentPath && !currentPath) throw new ProductStoreError("REVISION_CONFLICT", "候选已退出当前对话路径，请重新检索");
    const content = this.recallEntryText(row);
    if (!content) throw new ProductStoreError("NOT_FOUND", "消息正文不可安全读取");
    return { sessionId: text(row, "session_id"), entryId, role: text(row, "message_role"), content, currentPath,
      digest: `sha256:${createHash("sha256").update(content).digest("hex")}` };
  }

  async recordTaskSourceUse(input: Omit<TaskSourceUseRecord, "id" | "createdAt"> & { requestId: string }): Promise<{ storeRevision: number; use: TaskSourceUseRecord }> {
    const taskId = requiredString(input.taskId, "taskId", 200);
    if (!["task_message", "work_item", "agent_report", "evidence", "project_file", "inspiration"].includes(input.kind)
      || !/^sha256:[a-f0-9]{64}$/.test(input.digest) || !Number.isSafeInteger(input.bytes) || input.bytes < 0 || input.bytes > 65_536) {
      throw new ProductStoreError("INVALID_ARGUMENT", "召回来源记录无效");
    }
    const sourceId = requiredString(input.sourceId, "sourceId", 4096);
    return await this.mutate("task.source.use", input.requestId, undefined,
      { taskId, sessionRunId: input.sessionRunId, agentRunId: input.agentRunId ?? null, kind: input.kind, sourceId,
        digest: input.digest, bytes: input.bytes, version: input.version ?? null, projectId: input.projectId ?? null, rootDigest: input.rootDigest ?? null }, (_revision, now) => {
        const run = this.database.prepare("SELECT agent_run_id,status FROM session_runs WHERE id=? AND task_id=?").get(input.sessionRunId, taskId) as SQLiteRow | undefined;
        if (!run || !["prepared", "running", "waiting"].includes(text(run, "status")) || (input.agentRunId ?? null) !== (run.agent_run_id ?? null)) {
          throw new ProductStoreError("REVISION_CONFLICT", "召回读取不属于当前运行");
        }
        if (input.kind === "task_message" && !this.database.prepare("SELECT e.id FROM session_entries e JOIN sessions s ON s.id=e.session_id WHERE e.id=? AND s.task_id=?").get(sourceId, taskId)) throw new ProductStoreError("NOT_FOUND", "消息不属于当前任务");
        if (["work_item", "agent_report", "evidence"].includes(input.kind)) {
          const table = input.kind === "work_item" ? "task_work_items" : input.kind === "agent_report" ? "agent_reports" : "evidence_records";
          if (!this.database.prepare(`SELECT id FROM ${table} WHERE id=? AND task_id=?`).get(sourceId, taskId)) throw new ProductStoreError("NOT_FOUND", "事实不属于当前任务");
        }
        if (input.kind === "project_file") {
          const taskRow = this.database.prepare("SELECT project_id FROM tasks WHERE id=? AND scope_kind='project'").get(taskId) as SQLiteRow | undefined;
          if (!taskRow || input.projectId !== taskRow.project_id || !input.rootDigest || !/^sha256:[a-f0-9]{64}$/.test(input.rootDigest)) throw new ProductStoreError("NOT_FOUND", "文件不属于任务项目");
          normalizedContextRelativePath(sourceId, "project source");
        }
        if (input.kind === "inspiration" && (!input.version || !Number.isSafeInteger(input.version))) throw new ProductStoreError("INVALID_ARGUMENT", "灵感来源版本无效");
        const use: TaskSourceUseRecord = {
          id: `source-use-${randomUUID()}`, taskId, sessionRunId: input.sessionRunId,
          ...(input.agentRunId ? { agentRunId: input.agentRunId } : {}),
          kind: input.kind, sourceId, digest: input.digest, bytes: input.bytes,
          ...(input.version ? { version: input.version } : {}),
          ...(input.projectId ? { projectId: input.projectId } : {}),
          ...(input.rootDigest ? { rootDigest: input.rootDigest } : {}), createdAt: now,
        };
        return { value: { use }, event: { kind: "taskSource.used", entityKind: "taskSourceUse", entityId: use.id, taskId, payload: use } };
      });
  }

  taskSourceUse(taskId: string, useId: string): TaskSourceUseRecord {
    this.assertOpen();
    const row = this.database.prepare("SELECT payload_json FROM store_events WHERE kind='taskSource.used' AND task_id=? AND entity_id=?").get(taskId, useId) as SQLiteRow | undefined;
    if (!row) throw new ProductStoreError("NOT_FOUND", "来源读取不属于当前任务");
    return JSON.parse(text(row, "payload_json")) as TaskSourceUseRecord;
  }

  taskSourceUsesForRun(taskId: string, sessionRunId: string, offset = 0, limit = 100): { items: TaskSourceUseRecord[]; total: number; hasMore: boolean } {
    this.assertOpen();
    if (!this.database.prepare("SELECT id FROM session_runs WHERE id=? AND task_id=?").get(sessionRunId, taskId)) throw new ProductStoreError("NOT_FOUND", "运行不属于当前任务");
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ProductStoreError("INVALID_ARGUMENT", "来源分页范围无效");
    const total = this.database.prepare("SELECT COUNT(*) AS total FROM store_events WHERE kind='taskSource.used' AND task_id=? AND json_extract(payload_json,'$.sessionRunId')=?").get(taskId, sessionRunId) as SQLiteRow;
    const items = (this.database.prepare("SELECT payload_json FROM store_events WHERE kind='taskSource.used' AND task_id=? AND json_extract(payload_json,'$.sessionRunId')=? ORDER BY sequence LIMIT ? OFFSET ?").all(taskId, sessionRunId, limit, offset) as SQLiteRow[])
      .map(row => JSON.parse(text(row, "payload_json")) as TaskSourceUseRecord);
    return { items, total: integer(total, "total"), hasMore: offset + items.length < integer(total, "total") };
  }

  async prepareTaskSummary(input: { requestId: string; taskId: string; trigger: "new_session" | "compaction" | "member_restart" }): Promise<{ storeRevision: number; summary: TaskSummaryRecord }> {
    const taskId = requiredString(input.taskId, "taskId", 200);
    return await this.mutate("task.summary.prepare", input.requestId, undefined, input, (storeRevision, now) => {
      const facts = this.taskSummaryFacts(taskId);
      const previous = this.taskSummaryHistory(taskId).at(-1);
      const revision = (previous?.revision ?? 0) + 1;
      // A user's correction remains effective while the underlying Task facts
      // are unchanged. Changed facts require a fresh projection and review.
      const sections = previous?.trigger === "user_correction" && previous.factsDigest === facts.digest
        ? previous.sections : facts.sections;
      if (previous?.trigger === "user_correction" && previous.factsDigest !== facts.digest) {
        sections.blocked.push({ text: "上次用户修订的摘要基于旧任务事实，请重新核对。", sources: [{ kind: "summary_revision", id: previous.id, revision: previous.revision }] });
      }
      const summary: TaskSummaryRecord = {
        id: `task-summary-${taskId}`,
        taskId, revision, trigger: input.trigger, factsDigest: facts.digest,
        digest: `sha256:${payloadHash({ taskId, revision, sections, factsDigest: facts.digest })}`,
        sections, basedOnRevision: storeRevision - 1,
        ...(previous ? { previousRevision: previous.revision } : {}),
        createdAt: now,
      };
      return { value: { summary }, event: { kind: "taskSummary.revised", entityKind: "taskSummary", entityId: summary.id, taskId, payload: summary } };
    });
  }

  async markTaskSummaryResume(input: { requestId: string; taskId: string; sessionId: string; trigger: "compaction" }): Promise<{ storeRevision: number }> {
    return await this.mutate("task.summary.resumeRequired", input.requestId, undefined, input, (_revision, now) => {
      if (!this.database.prepare("SELECT id FROM sessions WHERE id=? AND task_id=?").get(input.sessionId, input.taskId)) throw new ProductStoreError("NOT_FOUND", "续接会话不属于当前任务");
      return { value: {}, event: { kind: "taskSummary.resumeRequired", entityKind: "session", entityId: input.sessionId, taskId: input.taskId,
        payload: { sessionId: input.sessionId, trigger: input.trigger, createdAt: now } } };
    });
  }

  async recordTaskSummaryFailure(input: { requestId: string; taskId: string; sessionId: string; trigger: string; reasonCode: string }): Promise<{ storeRevision: number }> {
    if (!/^[A-Z0-9_]{1,80}$/.test(input.reasonCode)) throw new ProductStoreError("INVALID_ARGUMENT", "摘要失败代码无效");
    return await this.mutate("task.summary.failed", input.requestId, undefined, input, (_revision, now) => {
      if (!this.database.prepare("SELECT id FROM sessions WHERE id=? AND task_id=?").get(input.sessionId, input.taskId)) throw new ProductStoreError("NOT_FOUND", "摘要会话不属于当前任务");
      const failure: TaskSummaryFailureRecord = { taskId: input.taskId, sessionId: input.sessionId, trigger: input.trigger.slice(0, 40), reasonCode: input.reasonCode, createdAt: now };
      return { value: {}, event: { kind: "taskSummary.failed", entityKind: "session", entityId: input.sessionId, taskId: input.taskId, payload: failure } };
    });
  }

  pendingTaskSummaryTrigger(taskId: string, sessionId: string): "compaction" | undefined {
    this.assertOpen();
    const marked = this.database.prepare("SELECT sequence FROM store_events WHERE kind='taskSummary.resumeRequired' AND task_id=? AND entity_id=? ORDER BY sequence DESC LIMIT 1").get(taskId, sessionId) as SQLiteRow | undefined;
    if (!marked) return undefined;
    const consumed = this.database.prepare(`SELECT sequence FROM store_events WHERE sequence>? AND kind='sessionRun.prepared' AND task_id=?
      AND json_extract(payload_json,'$.sessionId')=? AND json_extract(payload_json,'$.taskSummary.trigger')='compaction' LIMIT 1`)
      .get(integer(marked, "sequence"), taskId, sessionId);
    return consumed ? undefined : "compaction";
  }

  async correctTaskSummary(input: { requestId: string; taskId: string; expectedRevision: number; sections: Record<TaskSummarySection, string[]> }): Promise<{ storeRevision: number; summary: TaskSummaryRecord }> {
    const taskId = requiredString(input.taskId, "taskId", 200);
    const expectedRevision = requiredRevision(input.expectedRevision, "expectedRevision");
    const keys: TaskSummarySection[] = ["confirmed", "pending", "blocked", "next"];
    if (!input.sections || Object.keys(input.sections).sort().join(",") !== [...keys].sort().join(",")) throw new ProductStoreError("INVALID_ARGUMENT", "摘要必须提供四个部分");
    const content = Object.fromEntries(keys.map(key => {
      const values = input.sections[key];
      if (!Array.isArray(values) || values.length > 8) throw new ProductStoreError("INVALID_ARGUMENT", "每个摘要部分最多八条");
      return [key, values.map((value, index) => requiredCredentialFreeString(value, `${key}[${index}]`, 500).trim()).filter(Boolean)];
    })) as Record<TaskSummarySection, string[]>;
    if (Object.values(content).flat().join("\n").length > 8_000) throw new ProductStoreError("INVALID_ARGUMENT", "摘要过长");
    return await this.mutate("task.summary.correct", input.requestId, undefined, { taskId, expectedRevision, content }, (storeRevision, now) => {
      const previous = this.taskSummaryHistory(taskId).at(-1);
      if (!previous || previous.revision !== expectedRevision || !previous.current) throw new ProductStoreError("REVISION_CONFLICT", "摘要已变化，请重新查看后修订");
      const revision = previous.revision + 1;
      const sections = Object.fromEntries(keys.map(key => [key, content[key].map(value => {
        const matches = previous.sections[key].filter(claim => claim.text === value);
        const unchanged = matches.length === 1 ? matches[0] : undefined;
        return { text: value, sources: unchanged?.sources ?? [
          { kind: "summary_revision", id: previous.id, revision: previous.revision },
          { kind: "user_correction", id: `task-summary-${taskId}`, revision },
        ] };
      })])) as TaskSummaryRecord["sections"];
      const summary: TaskSummaryRecord = {
        id: previous.id, taskId, revision, trigger: "user_correction", factsDigest: previous.factsDigest,
        digest: `sha256:${payloadHash({ taskId, revision, sections, factsDigest: previous.factsDigest })}`,
        sections, basedOnRevision: storeRevision - 1, previousRevision: previous.revision, createdAt: now,
      };
      return { value: { summary }, event: { kind: "taskSummary.revised", entityKind: "taskSummary", entityId: summary.id, taskId, payload: summary } };
    });
  }

  latestRouteInput(taskId: string): { id: string; text: string; sessionId: string } | undefined {
    const row = this.database.prepare(`SELECT r.id,r.submitted_text,r.session_id FROM raw_inputs r WHERE r.task_id=?
      AND r.source_kind IN ('user_submit','edit_and_rerun','continue_path') AND NOT EXISTS (
        SELECT 1 FROM store_events e WHERE e.task_id=r.task_id AND e.kind='collaboration.messageChanged'
        AND json_extract(e.payload_json,'$.originRawInputId')=r.id AND json_extract(e.payload_json,'$.uiAction.kind')='task.review.request'
      ) ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1`).get(taskId) as SQLiteRow | undefined;
    return row ? { id: text(row,"id"), text: text(row,"submitted_text"), sessionId: text(row,"session_id") } : undefined;
  }

  private routeContextKey(taskId: string): string {
    const row = this.database.prepare("SELECT goal,acceptance_json FROM tasks WHERE id=?").get(taskId) as SQLiteRow | undefined;
    if (!row) throw new ProductStoreError("NOT_FOUND", "任务不存在");
    const context = this.database.prepare("SELECT revision FROM task_context_sets WHERE task_id=?").get(taskId) as SQLiteRow | undefined;
    const changed=this.database.prepare("SELECT MAX(sequence) AS sequence FROM store_events WHERE task_id=? AND kind='task.goalUpdated'").get(taskId) as SQLiteRow;
    // Preserve existing route keys until a Goal revision; reverting wording still needs recheck.
    return payloadHash({ goal: text(row, "goal"), acceptance: text(row, "acceptance_json"), contextRevision: context ? integer(context, "revision") : 0,
      ...(typeof changed.sequence==="number"?{goalChangeSequence:changed.sequence}:{}) });
  }

  private routeWorkItems(taskId: string): TaskWorkItemRecord[] {
    return (this.database.prepare("SELECT * FROM task_work_items WHERE task_id=? ORDER BY ordinal,id").all(taskId) as SQLiteRow[]).map(taskWorkItem);
  }

  private resolveRouteBinding(taskId: string, directive: unknown): RouteBinding | undefined {
    const context = this.taskRouteContext(taskId);
    if (directive === undefined) {
      if (context) throw new ProductStoreError("INVALID_ARGUMENT", "当前任务有路线记录，请声明派发用于探索、检查、执行或无关工作");
      return undefined;
    }
    if (!Value.Check(RouteDispatchSchema, directive)) throw new ProductStoreError("INVALID_ARGUMENT", "派发的路线关系无效");
    if (directive.purpose === "independent") {
      if (!directive.reason?.trim() || directive.workItemId || directive.candidateId) throw new ProductStoreError("INVALID_ARGUMENT", "无关工作需要说明独立原因，不能同时绑定路线工作项");
      return undefined;
    }
    if (!context?.contextCurrent || context.inputCurrent === false) throw new ProductStoreError("REVISION_CONFLICT", "路线缺失、上下文或用户输入已变，请先核对");
    const binding: RouteBinding = { planId: context.planId, round: context.route.round, purpose: directive.purpose };
    if (directive.purpose === "execute" || directive.purpose === "review") {
      const work = this.routeWorkItems(taskId).find(item => item.id === directive.workItemId), routeWork = readRouteWork(work?.details);
      if (!work || !routeWork || routeWork.invalidatedReason || routeWork.planId !== context.planId || routeWork.round !== context.route.round || routeWork.candidateId !== context.route.selectedCandidateId) {
        throw new ProductStoreError("INVALID_ARGUMENT", "执行需要本任务当前路线的有效工作项");
      }
      if (work.state === "cancelled" || directive.purpose === "execute" && work.state === "completed") throw new ProductStoreError("REVISION_CONFLICT", "工作项已收口，请先明确返工范围");
      const items = this.routeWorkItems(taskId);
      if (routeWork.dependsOn.some(id => !items.some(item => item.id === id && item.state === "completed" && !readRouteWork(item.details)?.invalidatedReason))) {
        throw new ProductStoreError("REVISION_CONFLICT", "工作项的前置依赖尚未完成或已经失效");
      }
      if (directive.purpose === "execute" && work.ownerAssignmentId) {
        const owner = this.database.prepare("SELECT g.status FROM agent_assignments a JOIN agent_runs g ON g.id=a.agent_run_id WHERE a.id=?").get(work.ownerAssignmentId) as SQLiteRow | undefined;
        if (owner && ["prepared", "running", "waiting"].includes(text(owner, "status"))) throw new ProductStoreError("REVISION_CONFLICT", "工作项仍有活动成员，请先停止或向原成员交办");
      }
      binding.candidateId = routeWork.candidateId; binding.workItemId = work.id;
    } else if (directive.candidateId) {
      if (!context.route.candidates.some(candidate => candidate.id === directive.candidateId && candidate.round === context.route.round)) throw new ProductStoreError("INVALID_ARGUMENT", "检查对象不属于当前探索轮次");
      binding.candidateId = directive.candidateId;
    }
    if (!bindingMatchesRoute(binding, context)) throw new ProductStoreError("REVISION_CONFLICT", "当前路线阶段不允许这项派发");
    return binding;
  }

  assertAgentRouteCurrent(agentRunId: string, requireInputCurrent = false): void {
    const assignment = this.database.prepare("SELECT * FROM agent_assignments WHERE agent_run_id=? AND assignment_kind='member' ORDER BY created_at DESC,rowid DESC LIMIT 1").get(agentRunId) as SQLiteRow | undefined;
    if (!assignment) return;
    const packet = JSON.parse(text(assignment, "task_packet_json")) as {
      routeBinding?: RouteBinding;
      workflowBinding?: { workflowRunId?: string; stageId?: string; workItemId?: string;
        purpose?: string; targetWorkItemId?: string };
    };
    const workflowBinding = packet.workflowBinding;
    if (workflowBinding) {
      const run = this.database.prepare("SELECT workflow_id, version, status FROM task_workflow_runs WHERE id = ? AND task_id = ?")
        .get(workflowBinding.workflowRunId ?? null, text(assignment, "task_id")) as SQLiteRow | undefined;
      if (run) this.assertWorkflowGoalCurrent(text(run,"workflow_id"),integer(run,"version"),text(assignment,"task_id"));
      const stage = run ? this.database.prepare(`
        SELECT id FROM task_workflow_stages WHERE workflow_id = ? AND version = ? AND id = ?
      `).get(run.workflow_id as string, run.version as number, workflowBinding.stageId ?? null) : undefined;
      const ownWork = this.database.prepare("SELECT id FROM task_work_items WHERE id = ? AND owner_assignment_id = ?")
        .get(workflowBinding.workItemId ?? null, text(assignment, "id"));
      const target = this.database.prepare(`
        SELECT work_item_id FROM task_workflow_work_items WHERE run_id = ? AND stage_id = ?
      `).get(workflowBinding.workflowRunId ?? null, workflowBinding.stageId ?? null) as SQLiteRow | undefined;
      if (!run || !["active", "stopped"].includes(text(run, "status")) || !stage || !ownWork
        || target?.work_item_id !== (workflowBinding.purpose === "verify"
          ? workflowBinding.targetWorkItemId : workflowBinding.workItemId)) {
        throw new ProductStoreError("REVISION_CONFLICT", "Workflow member assignment is no longer current");
      }
    }
    if (!packet.routeBinding) return;
    const taskId = text(assignment, "task_id");
    const context = this.taskRouteContext(taskId);
    if (!bindingMatchesRoute(packet.routeBinding, context)) throw new ProductStoreError("REVISION_CONFLICT", "成员所依据的路线已经改变或失效，原安排已暂停");
    if (requireInputCurrent && context?.inputCurrent === false) throw new ProductStoreError("REVISION_CONFLICT", "用户有新输入，待协调者核对路线后继续");
    if (packet.routeBinding.workItemId) {
      const work = this.routeWorkItems(taskId).find(item => item.id === packet.routeBinding!.workItemId), routeWork = readRouteWork(work?.details);
      if (!work || packet.routeBinding.purpose === "execute" && work.ownerAssignmentId !== text(assignment, "id") || routeWork?.invalidatedReason) throw new ProductStoreError("REVISION_CONFLICT", "成员的工作项已失效或重新指派");
      const items = this.routeWorkItems(taskId);
      if (routeWork?.dependsOn.some(id => !items.some(item => item.id === id && item.state === "completed" && !readRouteWork(item.details)?.invalidatedReason))) throw new ProductStoreError("REVISION_CONFLICT", "成员依赖的成果尚未完成或需要复查");
    }
  }

  private agentRouteIsCurrent(agentRunId: string): boolean {
    try { this.assertAgentRouteCurrent(agentRunId); return true; }
    catch (error) { if (error instanceof ProductStoreError && error.code === "REVISION_CONFLICT") return false; throw error; }
  }

  private memberWorkScope(agentRunId: string): { assignmentId: string; revision: number; workItemId?: string } | undefined {
    const row = this.database.prepare("SELECT * FROM agent_assignments WHERE agent_run_id=? AND assignment_kind='member' ORDER BY created_at DESC,rowid DESC LIMIT 1").get(agentRunId) as SQLiteRow | undefined;
    if (!row) return undefined;
    const packet = JSON.parse(text(row, "task_packet_json"));
    return { assignmentId: text(row, "id"), revision: packet.currentWorkRevision ?? 1, ...(packet.currentWorkItemId ? { workItemId: packet.currentWorkItemId } : {}) };
  }

  private sessionWorkScope(sessionRunId: string): ReturnType<ProductStore["memberWorkScope"]> {
    const row = this.database.prepare("SELECT e.context_projection_json FROM session_runs r JOIN effective_inputs e ON e.id=r.effective_input_id WHERE r.id=?").get(sessionRunId) as SQLiteRow | undefined;
    return row ? JSON.parse(text(row, "context_projection_json")).workAssignment : undefined;
  }

  private sessionWorkflowReport(sessionRunId: string): {
    runId: string; workflowId: string; version: number; goalRevision: number;
  } | undefined {
    const row = this.database.prepare(`
      SELECT e.context_projection_json FROM session_runs r
      JOIN effective_inputs e ON e.id = r.effective_input_id WHERE r.id = ?
    `).get(sessionRunId) as SQLiteRow | undefined;
    if (!row) return undefined;
    return (JSON.parse(text(row, "context_projection_json")) as {
      workflowReport?: { runId: string; workflowId: string; version: number; goalRevision: number };
    }).workflowReport;
  }

  private assertReportWorkCurrent(report: SQLiteRow): void {
    const current = this.memberWorkScope(text(report, "agent_run_id"));
    if (current?.workItemId && canonicalJSON(JSON.parse(text(report, "body_json")).workAssignment ?? null) !== canonicalJSON(current)) {
      throw new ProductStoreError("REVISION_CONFLICT", "报告属于成员之前的工作指派，请检查本次工作的新报告");
    }
  }

  private setAssignedWorkState(agentRunId: string, state: TaskWorkItemRecord["state"], now: string): void {
    const scope = this.memberWorkScope(agentRunId);
    this.database.prepare("UPDATE task_work_items SET state=?,revision=revision+1,updated_at=? WHERE owner_assignment_id IN (SELECT id FROM agent_assignments WHERE agent_run_id=?) AND (? IS NULL OR id=?)")
      .run(state, now, agentRunId, scope?.workItemId ?? null, scope?.workItemId ?? null);
  }

  private completeWorkflowVerifierStage(verification: VerificationRecord, now: string): void {
    if (verification.verdict !== "pass" || verification.evidenceIds.length === 0) return;
    const assignment = this.database.prepare(`
      SELECT * FROM agent_assignments WHERE agent_run_id = ? AND assignment_kind = 'member'
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(verification.verifierAgentRunId) as SQLiteRow | undefined;
    if (!assignment) return;
    const packet = JSON.parse(text(assignment, "task_packet_json")) as {
      workflowBinding?: { workflowRunId?: string; stageId?: string; workItemId?: string; version?: number;
        purpose?: string; targetWorkItemId?: string };
    };
    const binding = packet.workflowBinding;
    if (!binding?.workflowRunId || !binding.stageId || !binding.workItemId
      || binding.purpose !== "verify" || !binding.targetWorkItemId) return;
    const workflowRunId = binding.workflowRunId;
    const run = this.database.prepare("SELECT * FROM task_workflow_runs WHERE id = ? AND status IN ('active', 'stopped')")
      .get(workflowRunId) as SQLiteRow | undefined;
    if (!run) return;
    const stage = this.workflowStages(text(run, "workflow_id"), integer(run, "version"))
      .find(item => item.id === binding.stageId);
    if (!stage) return;
    const subjectWorkItemId = verification.workItemId ?? (verification.subjectReportId
      ? (() => {
        const report = this.database.prepare("SELECT body_json FROM agent_reports WHERE id = ?")
          .get(verification.subjectReportId!) as SQLiteRow | undefined;
        return report ? (JSON.parse(text(report, "body_json")) as { workAssignment?: { workItemId?: string } }).workAssignment?.workItemId : undefined;
      })()
      : undefined);
    const target = this.database.prepare(`
      SELECT work_item_id FROM task_workflow_work_items WHERE run_id = ? AND stage_id = ?
    `).get(workflowRunId, binding.stageId) as SQLiteRow | undefined;
    if (!subjectWorkItemId || subjectWorkItemId !== binding.targetWorkItemId
      || target?.work_item_id !== subjectWorkItemId) return;
    this.database.prepare(`
      UPDATE task_work_items SET state = 'completed', revision = revision + 1, updated_at = ?
      WHERE id = ? AND owner_assignment_id = ? AND state = 'in_progress'
    `).run(now, binding.workItemId, text(assignment, "id"));
  }

  private invalidateRouteWork(taskId: string, context: TaskRouteContext, now: string): string[] {
    const items = this.routeWorkItems(taskId), affected = new Set<string>();
    for (const item of items) {
      const work = readRouteWork(item.details);
      if (work && work.planId === context.planId && work.round === context.route.round && !work.invalidatedReason) affected.add(item.id);
    }
    let changed = true;
    while (changed) { changed = false; for (const item of items) if (!affected.has(item.id) && readRouteWork(item.details)?.dependsOn.some(id => affected.has(id))) { affected.add(item.id); changed = true; } }
    for (const item of items.filter(item => affected.has(item.id))) {
      const details = { ...(item.details as Record<string, unknown>), routeWork: { ...readRouteWork(item.details), invalidatedReason: context.route.reason } };
      this.database.prepare("UPDATE task_work_items SET state='cancelled',details_json=?,revision=revision+1,updated_at=? WHERE id=?").run(canonicalJSON(details), now, item.id);
    }
    return (this.database.prepare("SELECT * FROM agent_assignments WHERE task_id=? AND assignment_kind='member'").all(taskId) as SQLiteRow[]).flatMap(row => {
      const binding = (JSON.parse(text(row, "task_packet_json")) as { routeBinding?: RouteBinding }).routeBinding;
      if (!binding || binding.planId !== context.planId || binding.round !== context.route.round) return [];
      this.setAssignedWorkState(text(row, "agent_run_id"), "cancelled", now);
      this.database.prepare("UPDATE agent_runs SET status='aborted',revision=revision+1,updated_at=? WHERE id=? AND status='prepared' AND NOT EXISTS(SELECT 1 FROM session_runs WHERE agent_run_id=? AND status IN ('prepared','running'))").run(now, text(row, "agent_run_id"), text(row, "agent_run_id"));
      return [text(row, "agent_run_id")];
    });
  }

  private blockRouteDependents(taskId: string, agentRunId: string, reason: string, revision: number, now: string): string[] {
    const items = this.routeWorkItems(taskId);
    const sources = new Set((this.database.prepare("SELECT id FROM agent_assignments WHERE agent_run_id=?").all(agentRunId) as SQLiteRow[]).map(row => text(row, "id")));
    const current = this.memberWorkScope(agentRunId)?.workItemId;
    const affected = new Set(items.filter(item => item.ownerAssignmentId && sources.has(item.ownerAssignmentId) && (!current || item.id === current)).map(item => item.id));
    const originals = new Set(affected);
    let changed = true;
    while (changed) { changed = false; for (const item of items) if (!affected.has(item.id) && !readRouteWork(item.details)?.invalidatedReason && readRouteWork(item.details)?.dependsOn.some(id => affected.has(id))) { affected.add(item.id); changed = true; } }
    const members: string[] = [];
    for (const item of items.filter(item => affected.has(item.id) && !originals.has(item.id))) {
      const details = { ...(item.details as Record<string, unknown>), routeWork: { ...readRouteWork(item.details), recheckAfterRevision: revision, recheckReason: reason } };
      this.database.prepare("UPDATE task_work_items SET state='blocked',details_json=?,revision=revision+1,updated_at=? WHERE id=?").run(canonicalJSON(details), now, item.id);
      if (item.ownerAssignmentId) {
        const assignment = this.database.prepare("SELECT agent_run_id FROM agent_assignments WHERE id=?").get(item.ownerAssignmentId) as SQLiteRow | undefined;
        if (assignment) members.push(text(assignment, "agent_run_id"));
      }
    }
    for (const assignment of this.database.prepare("SELECT * FROM agent_assignments WHERE task_id=? AND assignment_kind='member'").all(taskId) as SQLiteRow[]) {
      const binding = (JSON.parse(text(assignment, "task_packet_json")) as { routeBinding?: RouteBinding }).routeBinding;
      if (binding?.purpose === "review" && binding.workItemId && affected.has(binding.workItemId) && !originals.has(binding.workItemId)) {
        members.push(text(assignment, "agent_run_id"));
        this.setAssignedWorkState(text(assignment, "agent_run_id"), "cancelled", now);
      }
    }
    return [...new Set(members)];
  }

  private routeRecheckRevision(agentRunId: string): number {
    const rows = this.database.prepare("SELECT w.* FROM task_work_items w JOIN agent_assignments a ON a.id=w.owner_assignment_id WHERE a.agent_run_id=?").all(agentRunId) as SQLiteRow[];
    const current = this.memberWorkScope(agentRunId)?.workItemId;
    return Math.max(0, ...rows.filter(row => !current || text(row,"id") === current).map(row => readRouteWork(taskWorkItem(row).details)?.recheckAfterRevision ?? 0));
  }

  private assertEvidenceCompletesUnknownCheck(taskId: string, candidateId: string, evidenceIds: string[]): void {
    const unknown = this.database.prepare("SELECT sequence FROM store_events WHERE task_id=? AND kind='taskRoute.updated' AND json_extract(payload_json,'$.operation.action')='check' AND json_extract(payload_json,'$.operation.candidateId')=? AND json_extract(payload_json,'$.operation.outcome')='unknown' ORDER BY sequence DESC LIMIT 1").get(taskId, candidateId) as SQLiteRow | undefined;
    if (!unknown) return;
    const fresh = evidenceIds.length > 0 && evidenceIds.every(id => {
      const event = this.database.prepare("SELECT sequence FROM store_events WHERE task_id=? AND kind='evidence.recorded' AND entity_id=? ORDER BY sequence DESC LIMIT 1").get(taskId, id) as SQLiteRow | undefined;
      return event && integer(event, "sequence") > integer(unknown, "sequence");
    });
    if (!fresh) throw new ProductStoreError("INVALID_ARGUMENT", "补齐未知结论需要最近一次未知检查之后的新工具证据，不能重复使用旧证据");
  }

  async updateTaskRoute(input: {
    requestId: string; taskId: string; agentRunId: string; sessionRunId: string;
    expectedPlanRevision: number; operation: RouteOperation;
  }): Promise<{ storeRevision: number; context: TaskRouteContext; workItem?: TaskWorkItemRecord; affectedAgentRunIds: string[] }> {
    const operation = parseRouteOperation(input.operation);
    requiredRevision(input.expectedPlanRevision, "expectedPlanRevision");
    assertCredentialFreeValue(input, "taskRoute");
    return this.mutate("taskRoute.update", input.requestId, undefined, input, (_revision, now) => {
      const actor = this.database.prepare("SELECT a.* FROM agent_runs a JOIN session_runs r ON r.agent_run_id=a.id WHERE a.id=? AND a.task_id=? AND r.id=? AND r.status='running'")
        .get(input.agentRunId, input.taskId, input.sessionRunId) as SQLiteRow | undefined;
      if (!actor) throw new ProductStoreError("INVALID_ARGUMENT", "路线操作必须来自当前任务正在执行的智能体");
      const row = this.database.prepare("SELECT * FROM task_plans WHERE task_id=? AND state='active'").get(input.taskId) as SQLiteRow | undefined;
      const plan = row ? taskPlan(row) : undefined;
      if ((plan?.revision ?? 0) !== input.expectedPlanRevision) throw new ProductStoreError("REVISION_CONFLICT", "计划已有新版本，请读取后再修改路线");
      const previous = readTaskRoute(plan?.document);
      const contextKey = this.routeContextKey(input.taskId);
      const id = `route-${randomUUID()}`;
      const route = transitionTaskRoute(previous, operation, { agentRunId: input.agentRunId, sessionRunId: input.sessionRunId, role: text(actor, "role"), contextKey, now, id, latestInputId: this.latestRouteInput(input.taskId)?.id });
      const evidenceIds = operation.action === "propose" ? operation.candidate.evidenceIds : "evidenceIds" in operation ? operation.evidenceIds : [];
      for (const evidenceId of evidenceIds) {
        const item = this.database.prepare("SELECT * FROM evidence_records WHERE id=? AND task_id=?").get(evidenceId, input.taskId) as SQLiteRow | undefined;
        if (!item) throw new ProductStoreError("INVALID_ARGUMENT", "证据不属于当前任务");
        if (operation.action === "check") {
          if (text(item, "agent_run_id") !== input.agentRunId || text(item, "command_redacted").startsWith("dcode_")) throw new ProductStoreError("INVALID_ARGUMENT", "检查证据必须来自本人实际核查，不能使用协调操作代替");
          if (operation.outcome === "ready" && text(item, "exit_kind") !== "ok") throw new ProductStoreError("INVALID_ARGUMENT", "失败或未知检查不能作为路线成熟的证据");
          const boundary = this.database.prepare("SELECT sequence FROM store_events WHERE kind='taskRoute.updated' AND json_extract(payload_json,'$.candidateId')=? AND json_extract(payload_json,'$.operation.action')='propose' ORDER BY sequence DESC LIMIT 1").get(operation.candidateId) as SQLiteRow | undefined;
          const evidenceEvent = this.database.prepare("SELECT sequence FROM store_events WHERE kind='evidence.recorded' AND entity_id=? ORDER BY sequence DESC LIMIT 1").get(evidenceId) as SQLiteRow | undefined;
          if (!boundary || !evidenceEvent || integer(evidenceEvent, "sequence") <= integer(boundary, "sequence")) throw new ProductStoreError("INVALID_ARGUMENT", "证据早于候选，请核查当前版本后再提交");
        }
      }
      if (operation.action === "check" && operation.outcome === "ready") this.assertEvidenceCompletesUnknownCheck(input.taskId, operation.candidateId, operation.evidenceIds);
      // Recheck on adoption as well: a ready record written by an older build
      // may predate the evidence-freshness rule for completing an unknown check.
      if (operation.action === "adopt") this.assertEvidenceCompletesUnknownCheck(input.taskId, operation.candidateId, previous!.checks.filter(check => check.candidateId === operation.candidateId).at(-1)!.evidenceIds);
      if (operation.action === "check") {
        const evidence = evidenceIds.map(evidenceId => {
          const row = this.database.prepare("SELECT command_redacted,payload_json FROM evidence_records WHERE id=?").get(evidenceId) as SQLiteRow;
          return { tool: text(row,"command_redacted"), resultDigest: JSON.parse(text(row,"payload_json")).resultDigest };
        });
        route.checks[route.checks.length - 1]!.evidenceFingerprint = payloadHash({ outcome: operation.outcome, findings: operation.findings, evidence: evidence.sort((a,b) => canonicalJSON(a).localeCompare(canonicalJSON(b))) });
      }
      const planId = plan?.id ?? `task-plan-${randomUUID()}`;
      const revision = (plan?.revision ?? 0) + 1;
      const document = { ...(plan?.document as Record<string, unknown> ?? {}), routeExploration: route };
      if (canonicalJSON(document).length > 200000) throw new ProductStoreError("INVALID_ARGUMENT", "路线记录已达大小限制，请精简本次候选并保留原始证据引用");
      if (plan) this.database.prepare("UPDATE task_plans SET document_json=?,revision=?,updated_at=? WHERE id=?").run(canonicalJSON(document), revision, now, planId);
      else this.database.prepare("INSERT INTO task_plans(id,task_id,state,document_json,revision,created_at,updated_at) VALUES (?,?,'active',?,1,?,?)").run(planId, input.taskId, canonicalJSON(document), now, now);
      const context: TaskRouteContext = this.taskRouteContext(input.taskId)!;
      delete context.pendingInput;
      let workItem: TaskWorkItemRecord | undefined;
      if (operation.action === "work") {
        const items = this.routeWorkItems(input.taskId);
        if (items.length >= 200 || operation.dependsOn.some(id => !items.some(item => item.id === id && item.state !== "cancelled" && !readRouteWork(item.details)?.invalidatedReason))) throw new ProductStoreError("INVALID_ARGUMENT", "工作项依赖必须来自本任务的有效工作项，且总量须有界");
        const details = { routeWork: { planId, round: route.round, candidateId: route.selectedCandidateId!, completion: operation.completion, dependsOn: operation.dependsOn } satisfies RouteWork };
        workItem = { id: `work-item-${randomUUID()}`, taskId: input.taskId, ordinal: (items.at(-1)?.ordinal ?? -1) + 1, title: operation.title, state: "pending", details, revision: 1, createdAt: now, updatedAt: now };
        this.database.prepare("INSERT INTO task_work_items(id,task_id,ordinal,title,state,owner_assignment_id,details_json,revision,created_at,updated_at) VALUES (?,?,?,?,'pending',NULL,?,1,?,?)").run(workItem.id, input.taskId, workItem.ordinal, workItem.title, canonicalJSON(details), now, now);
      }
      if (operation.action === "cancel_work") {
        const items = this.routeWorkItems(input.taskId), item = items.find(item => item.id === operation.workItemId), work = readRouteWork(item?.details);
        if (!item || !work || work.planId !== planId || work.round !== route.round || work.candidateId !== route.selectedCandidateId) throw new ProductStoreError("INVALID_ARGUMENT", "只能收口本轮路线中尚未派发的工作项");
        if (item.ownerAssignmentId || !["pending", "blocked"].includes(item.state)) throw new ProductStoreError("INVALID_ARGUMENT", "已派发或已结束的工作须保留原执行与验收流程，不能通过取消未派发安排跳过验收");
        if (items.some(other => !["completed", "cancelled"].includes(other.state) && readRouteWork(other.details)?.dependsOn.includes(item.id))) throw new ProductStoreError("REVISION_CONFLICT", "尚有未完成的下游依赖，请先核对并收口下游安排");
        const details = { ...(item.details as Record<string, unknown>), routeWork: { ...work, cancelledReason: operation.reason } };
        this.database.prepare("UPDATE task_work_items SET state='cancelled',details_json=?,revision=revision+1,updated_at=? WHERE id=?").run(canonicalJSON(details), now, item.id);
        workItem = { ...item, state: "cancelled", details, revision: item.revision + 1, updatedAt: now };
      }
      const affectedAgentRunIds = ["invalidate", "stop"].includes(operation.action) || operation.action === "acknowledge" && operation.impact === "changed" ? this.invalidateRouteWork(input.taskId, context, now) : [];
      if (operation.action === "adopt") {
        for (const assignment of this.database.prepare("SELECT * FROM agent_assignments WHERE task_id=? AND assignment_kind='member'").all(input.taskId) as SQLiteRow[]) {
          const binding = (JSON.parse(text(assignment, "task_packet_json")) as { routeBinding?: RouteBinding }).routeBinding;
          if (binding?.planId === planId && binding.round === route.round && ["explore", "check"].includes(binding.purpose)) {
            affectedAgentRunIds.push(text(assignment, "agent_run_id"));
            const workId = this.memberWorkScope(text(assignment,"agent_run_id"))?.workItemId;
            this.database.prepare("UPDATE task_work_items SET state='cancelled',revision=revision+1,updated_at=? WHERE owner_assignment_id=? AND state<>'completed' AND (? IS NULL OR id=?)").run(now, text(assignment, "id"), workId ?? null, workId ?? null);
          }
        }
      }
      return { value: { context, ...(workItem ? { workItem } : {}), affectedAgentRunIds }, event: { kind: "taskRoute.updated", entityKind: "taskPlan", entityId: planId, taskId: input.taskId, payload: { context, operation, affectedAgentRunIds, ...(workItem ? { workItem } : {}), ...(operation.action === "propose" ? { candidateId: id } : {}) } } };
    });
  }

  async updateTaskGoal(input: {
    requestId: string; expectedStoreRevision: number; taskId: string; scope: TaskScope;
    expectedTaskRevision: number; goal: string; acceptance: string[];
  }): Promise<{ storeRevision: number; task: TaskRecord }> {
    const taskId = requiredString(input.taskId, "taskId", 200);
    const scope = normalizedTaskScope(input.scope);
    const expectedTaskRevision = requiredRevision(input.expectedTaskRevision, "expectedTaskRevision");
    const goal = requiredCredentialFreeString(input.goal.trim(), "goal", 4_000);
    const acceptance = parseStringArray(input.acceptance, "acceptance").map(item => item.trim()).filter(Boolean);
    if (acceptance.length > 100) throw new ProductStoreError("INVALID_ARGUMENT", "验收条件最多 100 条");
    assertCredentialFreeValue(acceptance, "acceptance");
    return this.mutate("task.goal.update", input.requestId, input.expectedStoreRevision,
      { taskId, scope, expectedTaskRevision, goal, acceptance }, (_revision, now) => {
        const previous = this.taskForScope(taskId, scope);
        if (previous.scope.kind === "user" && previous.scope.userId !== this.currentUser().id
          || previous.scope.kind === "project" && !this.database.prepare("SELECT id FROM projects WHERE id = ? AND user_id = ?")
            .get(previous.scope.projectId, this.currentUser().id)) {
          throw new ProductStoreError("NOT_FOUND", "任务不属于当前用户");
        }
        if (!["draft", "active", "waiting"].includes(previous.state)) {
          throw new ProductStoreError("REVISION_CONFLICT", "请先恢复此任务，再修订目标");
        }
        if (previous.revision !== expectedTaskRevision) {
          throw new ProductStoreError("REVISION_CONFLICT", "目标已被其他修改更新，请核对新版本");
        }
        if (this.database.prepare("SELECT id FROM session_runs WHERE task_id = ? AND status IN ('prepared','running','waiting') LIMIT 1")
          .get(taskId)) throw new ProductStoreError("REVISION_CONFLICT", "任务已有在途运行，请先停止并等待收尾，再修订目标");
        if (this.database.prepare("SELECT id FROM team_runs WHERE task_id = ? AND status IN ('prepared','active','waiting') LIMIT 1")
          .get(taskId)) throw new ProductStoreError("REVISION_CONFLICT", "任务还有未收口的团队工作，请先完成或停止并核对结果，再修订目标");
        if (this.database.prepare("SELECT id FROM task_workflow_runs WHERE task_id = ? AND status = 'active' LIMIT 1")
          .get(taskId)) throw new ProductStoreError("REVISION_CONFLICT", "任务有活动工作流；请先停止后续推进，再修订目标和安排");
        if (previous.goal === goal && canonicalJSON(previous.acceptance) === canonicalJSON(acceptance)) {
          throw new ProductStoreError("INVALID_ARGUMENT", "目标没有变化");
        }
        this.database.prepare("UPDATE tasks SET goal = ?, acceptance_json = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?")
          .run(goal, canonicalJSON(acceptance), now, taskId, expectedTaskRevision);
        const updated = task(this.database.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as SQLiteRow);
        const revisionOf = (value: TaskRecord, changedAt: string) => ({ taskId, goal: value.goal,
          acceptance: value.acceptance, taskRevision: value.revision, changedAt });
        return { value: { task: updated }, event: {
          kind: "task.goalUpdated", entityKind: "task", entityId: taskId, taskId,
          payload: { previous: revisionOf(previous, previous.updatedAt), current: revisionOf(updated, now) },
        } };
      });
  }

  private workflowForTask(workflowId: string, taskId: string): TaskWorkflowRecord {
    const row = this.database.prepare("SELECT * FROM task_workflows WHERE id = ? AND task_id = ?")
      .get(workflowId, taskId) as SQLiteRow | undefined;
    if (!row) throw new ProductStoreError("NOT_FOUND", "Workflow does not belong to this Task", { workflowId, taskId });
    return taskWorkflow(row);
  }

  private taskGoalRevision(taskId: string): number {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS changes FROM store_events WHERE task_id = ? AND kind = 'task.goalUpdated'
    `).get(taskId) as SQLiteRow;
    return integer(row, "changes") + 1;
  }

  private assertWorkflowGoalCurrent(workflowId: string, version: number, taskId: string): void {
    const row = this.database.prepare(`
      SELECT goal_revision FROM task_workflow_versions WHERE workflow_id = ? AND version = ?
    `).get(workflowId, version) as SQLiteRow | undefined;
    if (!row || integer(row, "goal_revision") !== this.taskGoalRevision(taskId)) {
      throw new ProductStoreError("REVISION_CONFLICT", "Task Goal changed; revise the Workflow before continuing");
    }
  }

  private workflowReportContext(taskId: string, runId: string, agentRunId: string,
    consumingMessageId?: string): { runId: string; workflowId: string; version: number; goalRevision: number } {
    const runRow = this.database.prepare(`
      SELECT * FROM task_workflow_runs WHERE id = ? AND task_id = ? AND status = 'active'
    `).get(runId, taskId) as SQLiteRow | undefined;
    const coordinator = this.database.prepare(`
      SELECT g.id FROM agent_runs g JOIN sessions s ON s.id = g.session_id
      WHERE g.id = ? AND g.task_id = ? AND g.role = 'coordinator' AND s.kind = 'coordination'
    `).get(agentRunId, taskId);
    if (!runRow || !coordinator) throw new ProductStoreError("INVALID_ARGUMENT", "Workflow report must be prepared by its Task Coordinator");
    const run = taskWorkflowRun(runRow);
    this.assertWorkflowGoalCurrent(run.workflowId, run.version, taskId);
    if (this.database.prepare("SELECT id FROM team_runs WHERE task_id = ? AND status IN ('prepared','active','waiting') LIMIT 1")
      .get(taskId)) throw new ProductStoreError("REVISION_CONFLICT", "Settle Team work before preparing the Workflow report");
    const stages = this.workflowStages(run.workflowId, run.version);
    const completed = this.database.prepare(`
      SELECT b.stage_id FROM task_workflow_work_items b
      JOIN task_work_items i ON i.id = b.work_item_id
      WHERE b.run_id = ? AND i.task_id = ? AND i.state = 'completed'
    `).all(runId, taskId) as SQLiteRow[];
    if (completed.length !== stages.length || stages.some(stage => !completed.some(row => row.stage_id === stage.id))) {
      throw new ProductStoreError("REVISION_CONFLICT", "Workflow report requires every stage to be verified complete");
    }
    const pendingUser = this.collaborationMessages(taskId).find(message =>
      message.author === "user" && message.id !== consumingMessageId
      && message.state !== "cancelled" && !this.isCollaborationMessageApplied(message.id));
    if (pendingUser) throw new ProductStoreError("REVISION_CONFLICT", "Read or resolve current user requirements before preparing the Workflow report");
    return { runId, workflowId: run.workflowId, version: run.version, goalRevision: this.taskGoalRevision(taskId) };
  }

  private workflowStages(workflowId: string, version: number): TaskWorkflowStageRecord[] {
    return (this.database.prepare(`
      SELECT * FROM task_workflow_stages WHERE workflow_id = ? AND version = ? ORDER BY ordinal
    `).all(workflowId, version) as SQLiteRow[]).map(taskWorkflowStage);
  }

  private insertWorkflowVersion(
    workflowId: string,
    version: number,
    originRawInputId: string,
    goalRevision: number,
    goal: string,
    constraints: string[],
    stages: TaskWorkflowStageInput[],
    now: string,
  ): { workflowVersion: TaskWorkflowVersionRecord; stages: TaskWorkflowStageRecord[] } {
    this.database.prepare(`
      INSERT INTO task_workflow_versions(workflow_id, version, origin_raw_input_id, goal_revision, goal, constraints_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(workflowId, version, originRawInputId, goalRevision, goal, canonicalJSON(constraints), now);
    const insert = this.database.prepare(`
      INSERT INTO task_workflow_stages(
        workflow_id, version, id, ordinal, title, completion, depends_on_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const records = stages.map((stage, ordinal) => {
      insert.run(workflowId, version, stage.id, ordinal, stage.title, stage.completion,
        canonicalJSON(stage.dependsOn));
      return { ...stage, workflowId, version, ordinal };
    });
    return { workflowVersion: { workflowId, version, originRawInputId, goalRevision, goal, constraints, createdAt: now }, stages: records };
  }

  async createTaskWorkflow(input: {
    requestId: string;
    expectedStoreRevision: number;
    taskId: string;
    scope: TaskScope;
    originRawInputId: string;
    goal: string;
    constraints?: string[];
    stages: TaskWorkflowStageInput[];
  }): Promise<{ storeRevision: number; workflow: TaskWorkflowRecord; workflowVersion: TaskWorkflowVersionRecord; stages: TaskWorkflowStageRecord[] }> {
    const taskId = requiredString(input.taskId, "taskId", 200);
    const scope = normalizedTaskScope(input.scope);
    const originRawInputId = requiredString(input.originRawInputId, "originRawInputId", 200);
    const goal = requiredCredentialFreeString(input.goal, "goal", 20_000).trim();
    const constraints = normalizedWorkflowConstraints(input.constraints ?? []);
    const stages = normalizedWorkflowStages(input.stages);
    const params = { taskId, scope, originRawInputId, goal, constraints, stages };
    return this.mutate("task.workflow.create", input.requestId, input.expectedStoreRevision, params,
      (_storeRevision, now) => {
        const task = this.taskForScope(taskId, scope);
        if (["completed", "rejected", "archived"].includes(task.state)) {
          throw new ProductStoreError("REVISION_CONFLICT", "Workflow cannot be added to a closed Task");
        }
        const raw = this.database.prepare("SELECT id FROM raw_inputs WHERE id = ? AND task_id = ?")
          .get(originRawInputId, taskId);
        if (!raw) throw new ProductStoreError("NOT_FOUND", "Workflow source input does not belong to this Task");
        const workflow: TaskWorkflowRecord = {
          id: `workflow-${randomUUID()}`, taskId, originRawInputId,
          currentVersion: 1, revision: 1, createdAt: now, updatedAt: now,
        };
        this.database.prepare(`
          INSERT INTO task_workflows(id, task_id, origin_raw_input_id, current_version, revision, created_at, updated_at)
          VALUES (?, ?, ?, 1, 1, ?, ?)
        `).run(workflow.id, taskId, originRawInputId, now, now);
        const definition = this.insertWorkflowVersion(workflow.id, 1, originRawInputId,
          this.taskGoalRevision(taskId), goal, constraints, stages, now);
        return { value: { workflow, ...definition }, event: {
          kind: "taskWorkflow.created", entityKind: "taskWorkflow", entityId: workflow.id, taskId,
          payload: { workflowId: workflow.id, version: 1, stageIds: stages.map(stage => stage.id), originRawInputId },
        } };
      });
  }

  async reviseTaskWorkflow(input: {
    requestId: string;
    expectedStoreRevision: number;
    taskId: string;
    scope: TaskScope;
    workflowId: string;
    expectedWorkflowRevision: number;
    originRawInputId: string;
    goal: string;
    constraints?: string[];
    stages: TaskWorkflowStageInput[];
  }): Promise<{ storeRevision: number; workflow: TaskWorkflowRecord; workflowVersion: TaskWorkflowVersionRecord; stages: TaskWorkflowStageRecord[]; run?: TaskWorkflowRunRecord }> {
    const taskId = requiredString(input.taskId, "taskId", 200);
    const scope = normalizedTaskScope(input.scope);
    const workflowId = requiredString(input.workflowId, "workflowId", 200);
    const expectedWorkflowRevision = requiredRevision(input.expectedWorkflowRevision, "expectedWorkflowRevision");
    const originRawInputId = requiredString(input.originRawInputId, "originRawInputId", 200);
    const goal = requiredCredentialFreeString(input.goal, "goal", 20_000).trim();
    const constraints = normalizedWorkflowConstraints(input.constraints ?? []);
    const stages = normalizedWorkflowStages(input.stages);
    const params = { taskId, scope, workflowId, expectedWorkflowRevision, originRawInputId, goal, constraints, stages };
    return this.mutate("task.workflow.revise", input.requestId, input.expectedStoreRevision, params,
      (_storeRevision, now) => {
        this.taskForScope(taskId, scope);
        const current = this.workflowForTask(workflowId, taskId);
        if (!this.database.prepare("SELECT id FROM raw_inputs WHERE id = ? AND task_id = ?")
          .get(originRawInputId, taskId)) {
          throw new ProductStoreError("NOT_FOUND", "Workflow revision source input does not belong to this Task");
        }
        if (current.revision !== expectedWorkflowRevision) {
          throw new ProductStoreError("REVISION_CONFLICT", "Workflow changed before revision", {
            expectedWorkflowRevision, currentWorkflowRevision: current.revision,
          });
        }
        const runRow = this.database.prepare(`
          SELECT * FROM task_workflow_runs WHERE workflow_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1
        `).get(workflowId) as SQLiteRow | undefined;
        const previousRun = runRow ? taskWorkflowRun(runRow) : undefined;
        if (previousRun?.status === "completed") {
          throw new ProductStoreError("REVISION_CONFLICT", "Completed Workflow history is immutable; create a new Workflow round");
        }
        if (previousRun) {
          const previous = new Map(this.workflowStages(workflowId, previousRun.version)
            .map(stage => [stage.id, stage]));
          const next = new Map(stages.map(stage => [stage.id, stage]));
          const bindings = this.database.prepare(`
            SELECT stage_id FROM task_workflow_work_items WHERE run_id = ?
          `).all(previousRun.id) as SQLiteRow[];
          for (const binding of bindings) {
            const id = text(binding, "stage_id");
            const oldStage = previous.get(id);
            const newStage = next.get(id);
            if (!oldStage || !newStage || oldStage.title !== newStage.title
              || oldStage.completion !== newStage.completion
              || canonicalJSON(oldStage.dependsOn) !== canonicalJSON(newStage.dependsOn)) {
              throw new ProductStoreError("REVISION_CONFLICT", "A bound Workflow stage cannot be rewritten; revise future stages only", { stageId: id });
            }
          }
        }
        const version = current.currentVersion + 1;
        const definition = this.insertWorkflowVersion(workflowId, version, originRawInputId,
          this.taskGoalRevision(taskId), goal, constraints, stages, now);
        this.database.prepare(`
          UPDATE task_workflows SET current_version = ?, revision = revision + 1, updated_at = ? WHERE id = ?
        `).run(version, now, workflowId);
        const workflow: TaskWorkflowRecord = { ...current, currentVersion: version, revision: current.revision + 1, updatedAt: now };
        let run: TaskWorkflowRunRecord | undefined;
        if (previousRun) {
          this.database.prepare(`
            UPDATE task_workflow_runs SET version = ?, revision = revision + 1, updated_at = ? WHERE id = ?
          `).run(version, now, previousRun.id);
          run = { ...previousRun, version, revision: previousRun.revision + 1, updatedAt: now };
        }
        return { value: { workflow, ...definition, ...(run ? { run } : {}) }, event: {
          kind: "taskWorkflow.revised", entityKind: "taskWorkflow", entityId: workflowId, taskId,
          payload: { workflowId, previousVersion: current.currentVersion, version, originRawInputId, stageIds: stages.map(stage => stage.id) },
        } };
      });
  }

  async startTaskWorkflow(input: {
    requestId: string;
    expectedStoreRevision: number;
    taskId: string;
    scope: TaskScope;
    workflowId: string;
    expectedWorkflowRevision: number;
  }): Promise<{ storeRevision: number; run: TaskWorkflowRunRecord }> {
    const taskId = requiredString(input.taskId, "taskId", 200);
    const scope = normalizedTaskScope(input.scope);
    const workflowId = requiredString(input.workflowId, "workflowId", 200);
    const expectedWorkflowRevision = requiredRevision(input.expectedWorkflowRevision, "expectedWorkflowRevision");
    const params = { taskId, scope, workflowId, expectedWorkflowRevision };
    return this.mutate("task.workflow.start", input.requestId, input.expectedStoreRevision, params,
      (_storeRevision, now) => {
        const task = this.taskForScope(taskId, scope);
        if (["completed", "rejected", "archived"].includes(task.state)) {
          throw new ProductStoreError("REVISION_CONFLICT", "Workflow cannot start in a closed Task");
        }
        const workflow = this.workflowForTask(workflowId, taskId);
        if (workflow.revision !== expectedWorkflowRevision) {
          throw new ProductStoreError("REVISION_CONFLICT", "Workflow changed before start");
        }
        this.assertWorkflowGoalCurrent(workflowId, workflow.currentVersion, taskId);
        if (this.workflowStages(workflowId, workflow.currentVersion).length === 0) {
          throw new ProductStoreError("REVISION_CONFLICT", "Coordinator must define Workflow stages before start");
        }
        if (this.database.prepare("SELECT id FROM task_workflow_runs WHERE workflow_id = ? LIMIT 1").get(workflowId)) {
          throw new ProductStoreError("REVISION_CONFLICT", "This Workflow already has a Run; continue its existing Run or create a new round");
        }
        if (this.database.prepare("SELECT id FROM task_workflow_runs WHERE task_id = ? AND status = 'active' LIMIT 1").get(taskId)
          || this.database.prepare("SELECT id FROM team_runs WHERE task_id = ? AND status IN ('prepared','active','waiting') LIMIT 1").get(taskId)) {
          throw new ProductStoreError("REVISION_CONFLICT", "Another Workflow or Team Run is active in this Task");
        }
        const run: TaskWorkflowRunRecord = {
          id: `workflow-run-${randomUUID()}`, taskId, workflowId, version: workflow.currentVersion,
          status: "active", revision: 1, createdAt: now, updatedAt: now,
        };
        this.database.prepare(`
          INSERT INTO task_workflow_runs(id, task_id, workflow_id, version, status, revision, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'active', 1, ?, ?)
        `).run(run.id, taskId, workflowId, run.version, now, now);
        return { value: { run }, event: {
          kind: "taskWorkflow.started", entityKind: "taskWorkflowRun", entityId: run.id, taskId,
          payload: { workflowId, runId: run.id, version: run.version },
        } };
      });
  }

  async bindTaskWorkflowWorkItem(input: {
    requestId: string;
    expectedStoreRevision: number;
    taskId: string;
    scope: TaskScope;
    runId: string;
    expectedRunRevision: number;
    stageId: string;
    workItemId: string;
  }): Promise<{ storeRevision: number; binding: TaskWorkflowWorkItemBinding }> {
    const taskId = requiredString(input.taskId, "taskId", 200);
    const scope = normalizedTaskScope(input.scope);
    const runId = requiredString(input.runId, "runId", 200);
    const expectedRunRevision = requiredRevision(input.expectedRunRevision, "expectedRunRevision");
    const stageId = requiredString(input.stageId, "stageId", 100);
    const workItemId = requiredString(input.workItemId, "workItemId", 200);
    const params = { taskId, scope, runId, expectedRunRevision, stageId, workItemId };
    return this.mutate("task.workflow.bindWorkItem", input.requestId, input.expectedStoreRevision, params,
      (_storeRevision, now) => {
        this.taskForScope(taskId, scope);
        const runRow = this.database.prepare("SELECT * FROM task_workflow_runs WHERE id = ? AND task_id = ?")
          .get(runId, taskId) as SQLiteRow | undefined;
        if (!runRow) throw new ProductStoreError("NOT_FOUND", "Workflow Run does not belong to this Task");
        const run = taskWorkflowRun(runRow);
        if (run.revision !== expectedRunRevision || run.status !== "active") {
          throw new ProductStoreError("REVISION_CONFLICT", "Workflow Run is not active at the expected revision");
        }
        const stage = this.database.prepare(`
          SELECT id FROM task_workflow_stages WHERE workflow_id = ? AND version = ? AND id = ?
        `).get(run.workflowId, run.version, stageId);
        if (!stage) throw new ProductStoreError("NOT_FOUND", "Workflow stage does not belong to this Run version");
        const workRow = this.database.prepare("SELECT * FROM task_work_items WHERE id = ? AND task_id = ?")
          .get(workItemId, taskId) as SQLiteRow | undefined;
        const work = workRow ? taskWorkItem(workRow) : undefined;
        if (!work || work.state !== "pending" || work.ownerAssignmentId) {
          throw new ProductStoreError("REVISION_CONFLICT", "Only a pending, unassigned Work Item in this Task may be bound");
        }
        if (readRouteWork(work.details)) {
          throw new ProductStoreError("INVALID_ARGUMENT", "Route Work Items keep their original dependency contract and cannot be rebound as Workflow execution stages");
        }
        if (this.database.prepare("SELECT run_id FROM task_workflow_work_items WHERE work_item_id = ? OR (run_id = ? AND stage_id = ?) LIMIT 1")
          .get(workItemId, runId, stageId)) {
          throw new ProductStoreError("REVISION_CONFLICT", "The Work Item or stage is already bound to a Workflow Run");
        }
        const binding: TaskWorkflowWorkItemBinding = { runId, stageId, workItemId, createdAt: now };
        this.database.prepare(`
          INSERT INTO task_workflow_work_items(run_id, stage_id, work_item_id, created_at) VALUES (?, ?, ?, ?)
        `).run(runId, stageId, workItemId, now);
        return { value: { binding }, event: {
          kind: "taskWorkflow.workItemBound", entityKind: "taskWorkflowRun", entityId: runId, taskId,
          payload: { workflowId: run.workflowId, ...binding },
        } };
      });
  }

  async stopTaskWorkflow(input: {
    requestId: string;
    expectedStoreRevision: number;
    taskId: string;
    scope: TaskScope;
    runId: string;
    expectedRunRevision: number;
    reason: string;
  }): Promise<{ storeRevision: number; run: TaskWorkflowRunRecord }> {
    return this.transitionTaskWorkflowRun("task.workflow.stop", input, "active", "stopped");
  }

  async continueTaskWorkflow(input: {
    requestId: string;
    expectedStoreRevision: number;
    taskId: string;
    scope: TaskScope;
    runId: string;
    expectedRunRevision: number;
  }): Promise<{ storeRevision: number; run: TaskWorkflowRunRecord }> {
    return this.transitionTaskWorkflowRun("task.workflow.continue", input, ["stopped", "interrupted"], "active");
  }

  private async transitionTaskWorkflowRun(inputMethod: "task.workflow.stop" | "task.workflow.continue", input: {
    requestId: string;
    expectedStoreRevision: number;
    taskId: string;
    scope: TaskScope;
    runId: string;
    expectedRunRevision: number;
    reason?: string;
  }, from: TaskWorkflowRunRecord["status"] | TaskWorkflowRunRecord["status"][], to: TaskWorkflowRunRecord["status"]): Promise<{ storeRevision: number; run: TaskWorkflowRunRecord }> {
    const taskId = requiredString(input.taskId, "taskId", 200);
    const scope = normalizedTaskScope(input.scope);
    const runId = requiredString(input.runId, "runId", 200);
    const expectedRunRevision = requiredRevision(input.expectedRunRevision, "expectedRunRevision");
    const reason = inputMethod === "task.workflow.stop"
      ? requiredCredentialFreeString(input.reason, "reason", 2_000).trim()
      : undefined;
    const params = { taskId, scope, runId, expectedRunRevision, ...(reason ? { reason } : {}) };
    return this.mutate(inputMethod, input.requestId, input.expectedStoreRevision, params,
      (_storeRevision, now) => {
        const task = this.taskForScope(taskId, scope);
        if (to === "active" && ["completed", "rejected", "archived"].includes(task.state)) {
          throw new ProductStoreError("REVISION_CONFLICT", "Workflow cannot continue in a closed Task");
        }
        const row = this.database.prepare("SELECT * FROM task_workflow_runs WHERE id = ? AND task_id = ?")
          .get(runId, taskId) as SQLiteRow | undefined;
        if (!row) throw new ProductStoreError("NOT_FOUND", "Workflow Run does not belong to this Task");
        const previous = taskWorkflowRun(row);
        if (previous.revision !== expectedRunRevision || !(Array.isArray(from) ? from : [from]).includes(previous.status)) {
          throw new ProductStoreError("REVISION_CONFLICT", "Workflow Run changed before transition", {
            expectedRunRevision, currentRunRevision: previous.revision, currentStatus: previous.status,
          });
        }
        if (to === "active") this.assertWorkflowGoalCurrent(previous.workflowId, previous.version, taskId);
        if (to === "active") {
          const team = this.database.prepare("SELECT id FROM team_runs WHERE task_id = ? AND status IN ('prepared','active','waiting') LIMIT 1")
            .get(taskId) as SQLiteRow | undefined;
          if (team && this.database.prepare(`
            SELECT id FROM agent_assignments WHERE team_run_id = ? AND assignment_kind = 'member'
              AND json_extract(task_packet_json, '$.workflowBinding.workflowRunId') IS NOT ? LIMIT 1
          `).get(text(team,"id"),runId)) {
            throw new ProductStoreError("REVISION_CONFLICT", "Another Team Run still owns this Task progression");
          }
        }
        if (to === "active" && this.database.prepare("SELECT id FROM task_workflow_runs WHERE task_id = ? AND status = 'active' AND id <> ? LIMIT 1").get(taskId, runId)) {
          throw new ProductStoreError("REVISION_CONFLICT", "Another Workflow Run is active in this Task");
        }
        const run: TaskWorkflowRunRecord = {
          ...previous, status: to, ...(reason ? { reason } : { reason: undefined }),
          revision: previous.revision + 1, updatedAt: now,
        };
        this.database.prepare(`
          UPDATE task_workflow_runs SET status = ?, reason = ?, revision = ?, updated_at = ? WHERE id = ?
        `).run(to, reason ?? null, run.revision, now, runId);
        return { value: { run }, event: {
          kind: to === "active" ? "taskWorkflow.continued" : "taskWorkflow.stopped",
          entityKind: "taskWorkflowRun", entityId: runId, taskId,
          payload: { workflowId: run.workflowId, runId, version: run.version, reason: reason ?? null },
        } };
      });
  }

  async completeTaskWorkflow(input: {
    requestId: string;
    expectedStoreRevision: number;
    taskId: string;
    scope: TaskScope;
    runId: string;
    expectedRunRevision: number;
    coordinatorReportId: string;
  }): Promise<{ storeRevision: number; run: TaskWorkflowRunRecord; reportBinding: TaskWorkflowReportBinding }> {
    const taskId = requiredString(input.taskId, "taskId", 200);
    const scope = normalizedTaskScope(input.scope);
    const runId = requiredString(input.runId, "runId", 200);
    const expectedRunRevision = requiredRevision(input.expectedRunRevision, "expectedRunRevision");
    const coordinatorReportId = requiredString(input.coordinatorReportId, "coordinatorReportId", 200);
    const params = { taskId, scope, runId, expectedRunRevision, coordinatorReportId };
    return this.mutate("task.workflow.complete", input.requestId, input.expectedStoreRevision, params,
      (_storeRevision, now) => {
        this.taskForScope(taskId, scope);
        const row = this.database.prepare("SELECT * FROM task_workflow_runs WHERE id = ? AND task_id = ?")
          .get(runId, taskId) as SQLiteRow | undefined;
        if (!row) throw new ProductStoreError("NOT_FOUND", "Workflow Run does not belong to this Task");
        const previous = taskWorkflowRun(row);
        if (previous.status !== "active" || previous.revision !== expectedRunRevision) {
          throw new ProductStoreError("REVISION_CONFLICT", "Workflow Run changed before completion");
        }
        this.assertWorkflowGoalCurrent(previous.workflowId, previous.version, taskId);
        if (this.database.prepare("SELECT id FROM team_runs WHERE task_id = ? AND status IN ('prepared','active','waiting') LIMIT 1")
          .get(taskId)) {
          throw new ProductStoreError("REVISION_CONFLICT", "Team work must settle before Workflow completion");
        }
        const report = this.database.prepare(`
          SELECT p.*, g.role FROM agent_reports p JOIN agent_runs g ON g.id = p.agent_run_id
          WHERE p.id = ? AND p.task_id = ? AND p.report_kind = 'coordinator'
        `).get(coordinatorReportId, taskId) as SQLiteRow | undefined;
        if (!report || text(report, "role") !== "coordinator") {
          throw new ProductStoreError("NOT_FOUND", "Workflow completion requires a Coordinator report in this Task");
        }
        const unconsumedUser = this.collaborationMessages(taskId).find(message =>
          message.author === "user" && message.state !== "cancelled" && !this.isCollaborationMessageApplied(message.id));
        if (unconsumedUser) {
          throw new ProductStoreError("REVISION_CONFLICT", "A submitted user requirement is still waiting to reach its target");
        }
        const reportBody = JSON.parse(text(report, "body_json")) as {
          sessionRunId?: unknown;
          workflowReport?: { runId?: unknown; workflowId?: unknown; version?: unknown; goalRevision?: unknown };
        };
        if (reportBody.workflowReport?.runId !== runId
          || reportBody.workflowReport.workflowId !== previous.workflowId
          || reportBody.workflowReport.version !== previous.version
          || reportBody.workflowReport.goalRevision !== this.taskGoalRevision(taskId)) {
          throw new ProductStoreError("REVISION_CONFLICT", "Coordinator report was not prepared for this Workflow Run and version");
        }
        const started = this.database.prepare(`
          SELECT sequence FROM store_events WHERE kind = 'taskWorkflow.started' AND entity_id = ? LIMIT 1
        `).get(runId) as SQLiteRow | undefined;
        const reportPrepared = typeof reportBody.sessionRunId === "string" ? this.database.prepare(`
          SELECT sequence FROM store_events WHERE kind = 'sessionRun.prepared' AND entity_id = ? ORDER BY sequence DESC LIMIT 1
        `).get(reportBody.sessionRunId) as SQLiteRow | undefined : undefined;
        const finished = typeof reportBody.sessionRunId === "string" ? this.database.prepare(`
          SELECT sequence FROM store_events WHERE kind = 'sessionRun.finished' AND entity_id = ? ORDER BY sequence DESC LIMIT 1
        `).get(reportBody.sessionRunId) as SQLiteRow | undefined : undefined;
        if (!started || !reportPrepared || !finished
          || integer(reportPrepared, "sequence") <= integer(started, "sequence")
          || integer(finished, "sequence") <= integer(reportPrepared, "sequence")) {
          throw new ProductStoreError("REVISION_CONFLICT", "Coordinator report must come from a finished Run after Workflow start");
        }
        const stages = this.workflowStages(previous.workflowId, previous.version);
        const bindings = (this.database.prepare(`
          SELECT * FROM task_workflow_work_items WHERE run_id = ?
        `).all(runId) as SQLiteRow[]).map(taskWorkflowWorkItem);
        if (bindings.length !== stages.length) {
          throw new ProductStoreError("REVISION_CONFLICT", "Every Workflow stage needs a real Work Item result");
        }
        const byStage = new Map(bindings.map(binding => [binding.stageId, binding]));
        const verifications = this.verifications();
        const acceptedReviews = this.coordinatorReviews().filter(review => review.outcome === "accepted");
        const accepted = new Set(acceptedReviews.map(review => review.verificationId));
        let finalReviewSequence = 0;
        for (const stage of stages) {
          const binding = byStage.get(stage.id);
          if (!binding) throw new ProductStoreError("REVISION_CONFLICT", "Workflow stage has no bound Work Item", { stageId: stage.id });
          const work = this.database.prepare("SELECT * FROM task_work_items WHERE id = ? AND task_id = ?")
            .get(binding.workItemId, taskId) as SQLiteRow | undefined;
          if (!work || text(work, "state") !== "completed" || typeof work.owner_assignment_id !== "string") {
            throw new ProductStoreError("REVISION_CONFLICT", "Workflow stage work is not verified complete", { stageId: stage.id });
          }
          const owner = this.database.prepare("SELECT agent_run_id FROM agent_assignments WHERE id = ?")
            .get(work.owner_assignment_id) as SQLiteRow | undefined;
          const agentRunId = owner?.agent_run_id;
          const supported = typeof agentRunId === "string" && verifications.find(verification => {
            if (verification.verdict !== "pass" || verification.evidenceIds.length === 0 || !accepted.has(verification.id)) return false;
            if (verification.workItemId === binding.workItemId) return true;
            if (verification.verifierAgentRunId === agentRunId) return true;
            if (verification.subjectAgentRunId !== agentRunId || !verification.subjectReportId) return false;
            const subject = this.database.prepare("SELECT body_json FROM agent_reports WHERE id = ?")
              .get(verification.subjectReportId) as SQLiteRow | undefined;
            const assigned = subject ? (JSON.parse(text(subject, "body_json")) as { workAssignment?: { workItemId?: string } }).workAssignment : undefined;
            return assigned?.workItemId === binding.workItemId;
          });
          if (!supported) throw new ProductStoreError("REVISION_CONFLICT", "Workflow stage lacks accepted independent evidence", { stageId: stage.id });
          for (const review of acceptedReviews.filter(item => item.verificationId === supported.id)) {
            const event = this.database.prepare(`
              SELECT sequence FROM store_events WHERE kind = 'verification.reviewed' AND entity_id = ? LIMIT 1
            `).get(review.id) as SQLiteRow | undefined;
            if (!event) throw new ProductStoreError("PRODUCT_STORE_CORRUPT", "Accepted verification lacks its review event");
            finalReviewSequence = Math.max(finalReviewSequence, integer(event, "sequence"));
          }
        }
        const latestRunInput = this.database.prepare(`
          SELECT COALESCE(MAX(sequence), 0) AS sequence FROM store_events
          WHERE task_id = ? AND kind = 'sessionRun.prepared'
            AND json_extract(payload_json, '$.rawInputId') IS NOT NULL
        `).get(taskId) as SQLiteRow;
        const latestUserSubmission = this.database.prepare(`
          SELECT COALESCE(MAX(first_sequence), 0) AS sequence FROM (
            SELECT MIN(sequence) AS first_sequence FROM store_events
            WHERE task_id = ? AND kind = 'collaboration.messageChanged'
              AND json_extract(payload_json, '$.author') = 'user'
            GROUP BY json_extract(payload_json, '$.originRawInputId')
          )
        `).get(taskId) as SQLiteRow;
        const goalChange = this.database.prepare(`
          SELECT COALESCE(MAX(sequence), 0) AS sequence FROM store_events
          WHERE task_id = ? AND kind = 'task.goalUpdated'
        `).get(taskId) as SQLiteRow;
        const latestInputSequence = Math.max(integer(latestRunInput, "sequence"),
          integer(latestUserSubmission, "sequence"));
        const reportPreparedSequence = integer(reportPrepared, "sequence");
        if (reportPreparedSequence <= finalReviewSequence
          || reportPreparedSequence < latestInputSequence
          || reportPreparedSequence <= integer(goalChange, "sequence")) {
          throw new ProductStoreError("REVISION_CONFLICT", "Coordinator report predates final review, current input, or Task Goal");
        }
        const reportBinding: TaskWorkflowReportBinding = {
          runId, workflowId: previous.workflowId, version: previous.version,
          coordinatorReportId, goalRevision: this.taskGoalRevision(taskId),
          latestInputSequence, finalReviewSequence, createdAt: now,
        };
        this.database.prepare(`
          INSERT INTO task_workflow_reports(
            run_id, workflow_id, version, coordinator_report_id, goal_revision,
            latest_input_sequence, final_review_sequence, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(runId, previous.workflowId, previous.version, coordinatorReportId,
          reportBinding.goalRevision, latestInputSequence, finalReviewSequence, now);
        const run: TaskWorkflowRunRecord = {
          ...previous, status: "completed", completionReportId: coordinatorReportId,
          revision: previous.revision + 1, updatedAt: now, completedAt: now,
        };
        this.database.prepare(`
          UPDATE task_workflow_runs
          SET status = 'completed', completion_report_id = ?, revision = ?, updated_at = ?, completed_at = ?
          WHERE id = ?
        `).run(coordinatorReportId, run.revision, now, now, runId);
        return { value: { run, reportBinding }, event: {
          kind: "taskWorkflow.completed", entityKind: "taskWorkflowRun", entityId: runId, taskId,
          payload: { workflowId: run.workflowId, runId, version: run.version, coordinatorReportId,
            goalRevision: reportBinding.goalRevision, latestInputSequence, finalReviewSequence },
        } };
      });
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
    if ("routeExploration" in document) throw new ProductStoreError("INVALID_ARGUMENT", "路线记录只能通过任务路线操作维护");
    const params = { taskId, scope, state, document };
    return await this.mutate(
      "task.plan.create",
      input.requestId,
      input.expectedStoreRevision,
      params,
      (_storeRevision, now) => {
        this.taskForScope(taskId, scope);
        if (state === "active" && this.taskRouteContext(taskId)) throw new ProductStoreError("REVISION_CONFLICT", "请更新当前计划，保留已有路线与累计投入");
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
        if (state === "active" && this.taskRouteContext(taskId)?.planId !== undefined && this.taskRouteContext(taskId)!.planId !== current.id) {
          throw new ProductStoreError("REVISION_CONFLICT", "不能用另一计划替换当前路线与累计投入");
        }
        if (canonicalJSON(document.routeExploration ?? null) !== canonicalJSON((current.document as Record<string, unknown>).routeExploration ?? null)
          || readTaskRoute(current.document) && state !== "active") {
          throw new ProductStoreError("INVALID_ARGUMENT", "路线记录和阶段只能通过任务路线操作维护");
        }
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
    if (readRouteWork(details)) throw new ProductStoreError("INVALID_ARGUMENT", "路线工作项由协调者通过任务路线操作建立");
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
        if ((state !== undefined || ownerAssignmentId !== undefined || details !== undefined)
          && this.database.prepare("SELECT run_id FROM task_workflow_work_items WHERE work_item_id = ? LIMIT 1").get(workItemId)) {
          throw new ProductStoreError("INVALID_ARGUMENT", "Workflow-bound Work Item state and ownership require the Task execution and evidence path");
        }
        if (readRouteWork(current.details) && (state !== undefined || ownerAssignmentId !== undefined || details !== undefined) || readRouteWork(details)) {
          throw new ProductStoreError("INVALID_ARGUMENT", "路线工作项的状态、依赖和归属由派发与验收流程维护");
        }
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

  async beginNativeSessionPath(input:{requestId:string;sessionId:string;action:NativeSessionPathAction}):Promise<{storeRevision:number;pathId:string}> {
    return this.mutate("session.pathBegin",input.requestId,undefined,input,(_revision,now)=>{
      if(this.database.prepare("SELECT id FROM session_runs WHERE session_id=? AND status IN ('prepared','running','waiting')").get(input.sessionId))throw new ProductStoreError("REVISION_CONFLICT","会话仍在运行，不能改变路径");
      const pathId=this.branchNativePath(input.sessionId,input.action,now);
      return {value:{pathId},event:{kind:"session.pathStarted",entityKind:"sessionPath",entityId:pathId,payload:input}};
    });
  }

  async restoreNativeSessionPath(sessionId:string,fromPathId:string,pathId:string):Promise<{storeRevision:number}> {
    return this.mutate("session.pathRestore",`restore-path:${payloadHash({sessionId,fromPathId,pathId})}`,undefined,{sessionId,fromPathId,pathId},(_revision,now)=>{
      const current=this.database.prepare("SELECT id FROM session_paths WHERE session_id=? AND is_current=1").get(sessionId) as SQLiteRow|undefined;
      if(current?.id!==pathId){
        if(current?.id!==fromPathId||!this.database.prepare("SELECT id FROM session_paths WHERE session_id=? AND id=?").get(sessionId,pathId))throw new ProductStoreError("REVISION_CONFLICT","原路径已改变，不能自动回退");
        this.database.prepare("UPDATE session_paths SET is_current=0,revision=revision+1,updated_at=? WHERE id=?").run(now,fromPathId);
        this.database.prepare("UPDATE session_paths SET is_current=1,revision=revision+1,updated_at=? WHERE id=?").run(now,pathId);
      }
      return {value:{},event:{kind:"session.pathRestored",entityKind:"sessionPath",entityId:pathId,payload:{sessionId,fromPathId,pathId}}};
    });
  }

  private branchNativePath(sessionId:string,action:NativeSessionPathAction,now:string):string {
    const current=this.database.prepare("SELECT * FROM session_paths WHERE session_id=? AND is_current=1").get(sessionId) as SQLiteRow|undefined;
    const source=this.database.prepare("SELECT * FROM session_paths WHERE id=? AND session_id=?").get(action.fromPathId,sessionId) as SQLiteRow|undefined;
    const target=this.database.prepare("SELECT e.*,p.ordinal AS path_ordinal FROM session_entries e JOIN session_path_entries p ON p.entry_id=e.id WHERE p.path_id=? AND e.session_id=? AND e.source_entry_id=?").get(action.fromPathId,sessionId,action.entryId) as SQLiteRow|undefined;
    if(!current||current.id!==action.expectedCurrentPathId||integer(current,"revision")!==action.expectedCurrentPathRevision)throw new ProductStoreError("REVISION_CONFLICT","当前对话路径已经改变，编辑内容已保留");
    if(!source||!target)throw new ProductStoreError("NOT_FOUND","消息不属于选定的对话路径");
    if(action.kind==="editUser"&&target.message_role!=="user" || action.kind==="continueAssistant"&&target.message_role!=="assistant")throw new ProductStoreError("INVALID_ARGUMENT","路径操作与消息类型不一致");
    const include=integer(target,"path_ordinal")-(action.kind==="editUser"?1:0);
    const pathId=`session-path-${randomUUID()}`;
    this.database.prepare("UPDATE session_paths SET is_current=0,revision=revision+1,updated_at=? WHERE session_id=? AND is_current=1").run(now,sessionId);
    this.database.prepare("INSERT INTO session_paths(id,session_id,source_path_id,source_leaf_entry_id,title,is_current,revision,created_at,updated_at) VALUES (?,?,?,NULL,?,1,1,?,?)").run(pathId,sessionId,`native:${pathId}`,action.kind==="editUser"?"编辑后继续":"从历史继续",now,now);
    this.database.prepare("INSERT INTO session_path_entries(path_id,entry_id,ordinal) SELECT ?,entry_id,ordinal FROM session_path_entries WHERE path_id=? AND ordinal<=? ORDER BY ordinal").run(pathId,action.fromPathId,include);
    return pathId;
  }

  async sessionPathEntries(sessionId:string,pathId?:string):Promise<SessionEntryRecord[]> {
    this.assertOpen();const path=this.database.prepare("SELECT id FROM session_paths WHERE session_id=? AND "+(pathId?"id=?":"is_current=1")).get(...(pathId?[sessionId,pathId]:[sessionId])) as SQLiteRow|undefined;
    if(!path)throw new ProductStoreError("NOT_FOUND","会话路径不存在");
    return (this.database.prepare("SELECT e.* FROM session_entries e JOIN session_path_entries p ON p.entry_id=e.id WHERE p.path_id=? ORDER BY p.ordinal").all(text(path,"id")) as SQLiteRow[]).map(sessionEntry);
  }

  sessionRunInputs(taskId:string,sessionRunId:string):{rawText:string;effectiveText:string;additionalInputs:Array<{author:string;text:string;effectiveText:string}>} {
    this.assertOpen();const row=this.database.prepare("SELECT raw.submitted_text,e.effective_content_json FROM session_runs r JOIN effective_inputs e ON e.id=r.effective_input_id JOIN raw_inputs raw ON raw.id=e.raw_input_id WHERE r.id=? AND r.task_id=?").get(sessionRunId,taskId) as SQLiteRow|undefined;
    if(!row)throw new ProductStoreError("NOT_FOUND","这项任务中没有对应运行记录");
    const additional=(this.database.prepare("SELECT effective_content_json,context_projection_json FROM effective_inputs WHERE task_id=? AND json_extract(context_projection_json,'$.steeringSource.sessionRunId')=? ORDER BY created_at,id").all(taskId,sessionRunId) as SQLiteRow[]).flatMap(input=>{const messageId=JSON.parse(text(input,"context_projection_json")).steeringSource.messageId;const message=this.collaborationMessages(taskId).find(message=>message.id===messageId);return message?[{author:message.author,text:message.text,effectiveText:String(JSON.parse(text(input,"effective_content_json")).message)}]:[];});
    return {rawText:text(row,"submitted_text"),effectiveText:String(JSON.parse(text(row,"effective_content_json")).message),additionalInputs:additional};
  }

  sessionSubmittedInputs(sessionId:string,pathId:string):Array<{sourceEntryId?:string;text:string;effectiveText:string;attachments:ManagedAttachment[]}> {
    const rows=this.database.prepare("SELECT e.source_entry_id,raw.submitted_text,raw.attachment_refs_json,i.effective_content_json FROM session_path_entries p JOIN session_entries e ON e.id=p.entry_id LEFT JOIN session_runs r ON r.user_entry_id=e.id JOIN effective_inputs i ON i.id=r.effective_input_id OR (json_extract(e.content_json,'$.steering')=1 AND json_extract(i.context_projection_json,'$.steeringSource.messageId')=json_extract(e.content_json,'$.collaborationMessageId')) JOIN raw_inputs raw ON raw.id=i.raw_input_id WHERE p.path_id=? AND e.session_id=? AND e.message_role='user' ORDER BY p.ordinal").all(pathId,sessionId) as SQLiteRow[];
    const catalog=this.attachmentCatalog();
    return rows.map(row=>({...(typeof row.source_entry_id==="string"?{sourceEntryId:row.source_entry_id}:{}),text:text(row,"submitted_text"),effectiveText:String(JSON.parse(text(row,"effective_content_json")).message),attachments:(JSON.parse(text(row,"attachment_refs_json")) as ManagedAttachment[]).filter(item=>typeof item?.id==="string"&&item.id.startsWith("attachment-")).map(item=>catalog.find(current=>current.id===item.id)??item)}));
  }

  sessionAdapterAnchors(sessionId:string):Array<{userEntryId:string;effectiveText:string;assistantSourceEntryId:string}> {
    this.assertOpen();const rows=this.database.prepare("SELECT r.user_entry_id,i.effective_content_json,a.source_entry_id FROM session_runs r JOIN session_entries u ON u.id=r.user_entry_id JOIN session_entries a ON a.id=r.assistant_entry_id JOIN effective_inputs i ON i.id=r.effective_input_id WHERE r.session_id=? AND u.source_entry_id IS NULL AND a.source_entry_id IS NOT NULL").all(sessionId) as SQLiteRow[];
    return rows.map(row=>({userEntryId:text(row,"user_entry_id"),effectiveText:String((JSON.parse(text(row,"effective_content_json")) as {message:string}).message),assistantSourceEntryId:text(row,"source_entry_id")}));
  }

  async linkSessionAdapterEntries(sessionId:string,links:Array<{userEntryId:string;sourceEntryId:string}>):Promise<{storeRevision:number}> {
    return this.mutate("session.sourcesLink",`source-links:${payloadHash({sessionId,links})}`,undefined,{sessionId,links},()=>{
      for(const link of links){const entry=this.database.prepare("SELECT source_entry_id FROM session_entries WHERE id=? AND session_id=? AND source_kind='native' AND message_role IN ('user','other')").get(link.userEntryId,sessionId) as SQLiteRow|undefined;if(!entry||entry.source_entry_id&&entry.source_entry_id!==link.sourceEntryId)throw new ProductStoreError("REVISION_CONFLICT","输入来源已改变");this.database.prepare("UPDATE session_entries SET source_entry_id=? WHERE id=?").run(link.sourceEntryId,link.userEntryId);}
      return {value:{},event:{kind:"session.sourcesLinked",entityKind:"session",entityId:sessionId,payload:{sessionId,links}}};
    });
  }

  async prepareSessionRun(input: {
    requestId: string;
    clientPromptId?: string;
    collaborationMessageId?: string;
    workflowReportRunId?: string;
    workflowDraft?: TaskWorkflowDraftInput;
    pathAction?:NativeSessionPathAction;
    preparedPathId?:string;
    effectiveMessage?:string;
    inputSources?:InputSourceReceipt[];
    taskSummary?: TaskSummaryReceipt;
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
    managedAttachmentIds?: string[];
    modelProvider?: string;
    modelId?: string;
    roleRevision: string;
    contextRevision: number;
    expectedTaskRevision?: number;
    profileSnapshot: Record<string, unknown>;
    tools: Array<{ name: string; description: string; parameters: unknown }>;
    toolsWritable: boolean;
    systemPromptDigest: string;
    promptSources: DCodePromptSourceReceipt[];
    importedHistoryReceipt?: ImportedSessionHistoryReceipt;
  }): Promise<PreparedSessionRun> {
    const taskId = requiredString(input.taskId, "taskId", 200);
    const clientPromptId=input.clientPromptId===undefined?undefined:requiredString(input.clientPromptId,"clientPromptId",128);
    const scope = normalizedTaskScope(input.scope);
    const sessionId = requiredString(input.sessionId, "sessionId", 200);
    const runtimeId = requiredString(input.runtimeId, "runtimeId", 200);
    const agentRunId = input.agentRunId === undefined
      ? undefined
      : requiredString(input.agentRunId, "agentRunId", 200);
    const workspaceId = requiredString(input.workspaceId, "workspaceId", 200);
    const contextRevision = requiredRevision(input.contextRevision, "contextRevision");
    const expectedTaskRevision=input.expectedTaskRevision===undefined?undefined:requiredRevision(input.expectedTaskRevision,"expectedTaskRevision");
    if (contextRevision < 1) {
      throw new ProductStoreError("INVALID_ARGUMENT", "contextRevision must be at least 1");
    }
    const message = input.message.trim().length === 0 && input.managedAttachmentIds?.length ? input.message : requiredCredentialFreeString(input.message, "message", 200_000);
    const effectiveMessage=input.effectiveMessage??attachmentPrompt(message,this.attachmentsForIds(input.managedAttachmentIds??[]),this.layout);
    const inputSources=inputSourceReceipts(input.inputSources);
    const summaryReceipt = input.taskSummary === undefined ? undefined : normalizedTaskSummaryReceipt(input.taskSummary);
    const workflowDraft = input.workflowDraft === undefined ? undefined : normalizedWorkflowDraft(input.workflowDraft);
    if(typeof effectiveMessage!=="string")throw new ProductStoreError("INVALID_ARGUMENT","生效输入无效");
    if(effectiveMessage.length>200_000)throw new ProductStoreError("INVALID_ARGUMENT","本次提交加附件引用超过长度限制。");
    let attachmentRefs=[...input.attachmentRefs];
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
      await assertIdeaSnapshotDigest(this.layout,source.path,source.digest);
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
      clientPromptId: clientPromptId ?? null,
      collaborationMessageId: input.collaborationMessageId ?? null,
      workflowReportRunId: input.workflowReportRunId ?? null,
      workflowDraft: workflowDraft ?? null,
      pathAction:input.pathAction??null,preparedPathId:input.preparedPathId??null,
      sessionId,
      runtimeId,
      ...(agentRunId ? { agentRunId } : {}),
      message,
      attachmentRefs: input.attachmentRefs,
      managedAttachmentIds:input.managedAttachmentIds??[],
      effectiveMessage,inputSources,
      ...(summaryReceipt ? { taskSummary: summaryReceipt } : {}),
      contextRevision,
      expectedTaskRevision:expectedTaskRevision??null,
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
          SELECT id, kind FROM sessions WHERE id = ? AND task_id = ?
        `).get(sessionId, taskId) as SQLiteRow | undefined;
        if (!taskRow || !sessionRow) {
          throw new ProductStoreError("NOT_FOUND", "Session Run target does not exist", { taskId, sessionId });
        }
        if (JSON.stringify(task(taskRow).scope) !== JSON.stringify(scope)) {
          throw new ProductStoreError("REVISION_CONFLICT", "Session Run Task Scope changed before preparation");
        }
        if (expectedTaskRevision!==undefined && integer(taskRow,"revision")!==expectedTaskRevision) {
          throw new ProductStoreError("REVISION_CONFLICT","Task Goal or Task metadata changed before this prompt could start");
        }
        if (summaryReceipt) {
          const saved = this.taskSummaryHistory(taskId).find(item => item.revision === summaryReceipt.revision);
          if (!saved || !saved.current || saved.id !== summaryReceipt.id || saved.digest !== summaryReceipt.digest || saved.taskId !== summaryReceipt.taskId) {
            throw new ProductStoreError("REVISION_CONFLICT", "任务摘要版本已变化，请重新准备本轮输入",{reasonCode:"TASK_SUMMARY_STALE"});
          }
        }
        for(const id of input.managedAttachmentIds??[]){
          const item=this.attachmentCatalog().find(item=>item.id===id);
          if(!item||Date.parse(item.expiresAt)<=Date.parse(now))throw new ProductStoreError("ATTACHMENT_EXPIRED","附件已过期，请重新添加。");
          const retained={...item,submittedAt:now,expiresAt:new Date(Math.max(Date.parse(item.expiresAt),Date.parse(now)+ATTACHMENT_RETENTION_DAYS*ATTACHMENT_DAY)).toISOString()};
          this.database.prepare(`INSERT INTO artifacts(id,task_id,session_id,agent_run_id,kind,title,managed_path,external_path,digest,metadata_json,revision,created_at,updated_at) VALUES (?,?,?,NULL,'attachment',?,?,NULL,?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET metadata_json=excluded.metadata_json,revision=artifacts.revision+1,updated_at=excluded.updated_at`).run(id,taskId,sessionId,item.name,attachmentPath(this.layout,item),item.digest,canonicalJSON(retained),item.createdAt,now);
          attachmentRefs=attachmentRefs.filter(value=>!(value&&typeof value==="object"&&(value as {id?:unknown}).id===id));
          attachmentRefs.push(retained);
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
          this.assertAgentRouteCurrent(agentRunId, true);
          const agentStatus = text(agentRun, "status");
          // A member persists beyond one turn and may be explicitly resumed after
          // completion/recovery. Only the new input runs; prior effects are not replayed.
          const continuation = ["completed", "failed", "aborted", "interrupted", "unknown"].includes(agentStatus);
          if (agentStatus !== "prepared" && !continuation) {
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
        const collaboration = input.collaborationMessageId ? this.collaborationMessages(taskId).find(item=>item.id===input.collaborationMessageId&&item.targetSessionId===sessionId&&item.targetAgentRunId===agentRunId&&item.state==="delivering"&&item.text===message) : undefined;
        if(input.collaborationMessageId&&!collaboration) throw new ProductStoreError("INVALID_ARGUMENT","协作来源与本次输入不一致");
        if (workflowDraft && (collaboration || input.pathAction || input.workflowReportRunId
          || text(sessionRow, "kind") !== "coordination"
          || !agentRunId || !this.database.prepare(`
            SELECT id FROM agent_runs WHERE id = ? AND task_id = ? AND session_id = ? AND role = 'coordinator'
          `).get(agentRunId, taskId, sessionId))) {
          throw new ProductStoreError("INVALID_ARGUMENT", "Workflow draft must originate from one direct Coordinator prompt");
        }
        const workflowReport = input.workflowReportRunId
          ? this.workflowReportContext(taskId,
            requiredString(input.workflowReportRunId, "workflowReportRunId", 200),
            requiredString(agentRunId, "agentRunId", 200), input.collaborationMessageId)
          : undefined;
        const generatedInput=collaboration&&collaboration.author!=="user";
        const sourceRaw = collaboration ? this.database.prepare("SELECT id FROM raw_inputs WHERE id=? AND task_id=?").get(collaboration.originRawInputId,taskId) as SQLiteRow|undefined : undefined;
        if(collaboration&&!sourceRaw) throw new ProductStoreError("INVALID_ARGUMENT","协作输入缺少发起任务的用户原文");
        const rawInputId = sourceRaw ? text(sourceRaw,"id") : `raw-${randomUUID()}`;
        const userEntryId = `entry-${randomUUID()}`;
        const effectiveInputId = `effective-${randomUUID()}`;
        const runtimeEnvironmentId = `environment-${randomUUID()}`;
        const activeToolSetId = `tools-${randomUUID()}`;
        const sessionRunId = `session-run-${randomUUID()}`;
        const promptReceiptId = `prompt-receipt-${randomUUID()}`;
        const providerAttemptId = `attempt-${randomUUID()}`;

        if(!collaboration) this.database.prepare(`
          INSERT INTO raw_inputs(
            id, task_id, session_id, ordinal, submitted_text,
            attachment_refs_json, source_kind, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(rawInputId, taskId, sessionId, ordinal, message, canonicalJSON(attachmentRefs), input.pathAction?.kind==="editUser"?"edit_and_rerun":input.pathAction?"continue_path":"user_submit", now);
        let workflow: TaskWorkflowRecord | undefined;
        if (workflowDraft) {
          workflow = { id: `workflow-${randomUUID()}`, taskId, originRawInputId: rawInputId,
            currentVersion: 1, revision: 1, createdAt: now, updatedAt: now };
          this.database.prepare(`
            INSERT INTO task_workflows(id,task_id,origin_raw_input_id,current_version,revision,created_at,updated_at)
            VALUES (?,?,?,1,1,?,?)
          `).run(workflow.id, taskId, rawInputId, now, now);
          this.insertWorkflowVersion(workflow.id, 1, rawInputId, this.taskGoalRevision(taskId),
            workflowDraft.goal, workflowDraft.constraints, [], now);
        }
        if(input.pathAction){
          if(input.preparedPathId){if(!this.database.prepare("SELECT id FROM session_paths WHERE session_id=? AND id=? AND is_current=1").get(sessionId,input.preparedPathId))throw new ProductStoreError("REVISION_CONFLICT","新路径已改变，输入没有被发送");}
          else this.branchNativePath(sessionId,input.pathAction,now);
        }
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
          ) VALUES (?, ?, ?, 'native', 'native', NULL, NULL, ?, ?, ?, ?, ?)
        `).run(
          userEntryId,
          sessionId,
          typeof previousEntry?.id === "string" ? previousEntry.id : null,
          ordinal,
          now,
          generatedInput ? "other" : "user",
          canonicalJSON({ type: "text", text: message, attachmentRefs, ...(collaboration?{collaborationMessageId:collaboration.id,author:collaboration.author}:{}) }),
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
          canonicalJSON({ message:effectiveMessage, attachmentRefs }),
          canonicalJSON({
            version: 3,
            ...(inputSources.length?{inputSources}:{}),
            ...(input.pathAction?{pathAction:input.pathAction}:{}),
            ...(collaboration?{collaborationSource:{messageId:collaboration.id,author:collaboration.author,sourceSessionId:collaboration.sourceSessionId}}:{}),
            ...(workflowReport ? { workflowReport } : {}),
            taskContextRevision: contextRevision,
            ...(agentRunId && this.memberWorkScope(agentRunId) ? { workAssignment: this.memberWorkScope(agentRunId) } : {}),
            promptSources,
            ...(summaryReceipt ? { taskSummary: summaryReceipt } : {}),
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
            WHERE id = ?
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
            ...(summaryReceipt ? { taskSummary: summaryReceipt } : {}),
            ...(inputSources.length?{inputSources}:{}),
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
          ...(workflow ? { workflow } : {}),
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
            payload: { ...value, sessionId, ...(clientPromptId?{clientPromptId}:{}), ...(summaryReceipt ? { taskSummary: summaryReceipt } : {}) },
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
        const profile = this.profileRecord(profileRow);
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

  async replayAdaptiveTeam(requestId:string,taskId:string,scope:TaskScope,coordinatorAgentRunId:string,members:Array<{profileId:string;title:string;taskPacket:Record<string,unknown>}>,workflowRunId?:string):Promise<CreatedTeamRun|undefined> {
    return this.replayReceipt("teamRun.create",requestId,{taskId,scope,members,coordinatorAgentRunId,...(workflowRunId?{workflowRunId}:{})});
  }

  async createTeamRun(input: {
    requestId: string;
    expectedStoreRevision?: number;
    /** Internal authority from the bound Coordinator Runtime; not a client parameter. */
    coordinatorAgentRunId?: string;
    /** Bound Coordinator may attach members to explicit stages of an active Task Workflow. */
    workflowRunId?: string;
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
      if (["routeBinding", "workflowBinding", "currentWorkItemId", "currentWorkRevision"].some(key => key in member.taskPacket)) throw new ProductStoreError("INVALID_ARGUMENT", "成员路线和工作项绑定由 Host 根据实际计划生成");
      return { profileId, title, taskPacket: member.taskPacket };
    });
    return await this.mutate(
      "teamRun.create",
      input.requestId,
      input.expectedStoreRevision,
      { taskId, scope, members: input.coordinatorAgentRunId ? members.map(member=>{const {modelDecision,resolvedModelCandidates,workspacePolicy,workspaceRootDigest,sourceSessionId,originRawInputId,...packet}=member.taskPacket;return {...member,taskPacket:packet};}) : members, ...(input.coordinatorAgentRunId ? { coordinatorAgentRunId: input.coordinatorAgentRunId } : {}), ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}) },
      (_storeRevision, now) => {
        const taskRow = this.database.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as SQLiteRow | undefined;
        if (!taskRow) throw new ProductStoreError("NOT_FOUND", "Team Run Task does not exist", { taskId });
        const taskRecord = task(taskRow);
        if (JSON.stringify(taskRecord.scope) !== JSON.stringify(scope)) {
          throw new ProductStoreError("REVISION_CONFLICT", "Team Run Task Scope changed before creation");
        }
        const activeWorkflowRow = this.database.prepare("SELECT * FROM task_workflow_runs WHERE task_id = ? AND status = 'active' LIMIT 1").get(taskId) as SQLiteRow | undefined;
        const activeWorkflow = activeWorkflowRow ? taskWorkflowRun(activeWorkflowRow) : undefined;
        if (activeWorkflow) this.assertWorkflowGoalCurrent(activeWorkflow.workflowId, activeWorkflow.version, taskId);
        if (activeWorkflow?.id !== input.workflowRunId || input.workflowRunId && (!activeWorkflow || !input.coordinatorAgentRunId)) {
          throw new ProductStoreError("REVISION_CONFLICT", "A Workflow stage delegation requires its active Run and bound Coordinator");
        }
        if (!activeWorkflow && this.database.prepare(`
          SELECT t.id FROM team_runs t
          JOIN agent_assignments a ON a.team_run_id = t.id AND a.assignment_kind = 'member'
          JOIN task_workflow_runs w ON w.id = json_extract(a.task_packet_json, '$.workflowBinding.workflowRunId')
          WHERE t.task_id = ? AND t.status IN ('prepared', 'active', 'waiting') AND w.status = 'stopped'
          LIMIT 1
        `).get(taskId)) {
          throw new ProductStoreError("REVISION_CONFLICT", "Stopped Workflow still has members finishing their stage");
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
        const coordinatorProfile = this.profileRecord(coordinatorProfileRow);
        const memberProfiles = members.map((member) => {
          const row = this.database.prepare(`
            SELECT * FROM agent_profiles WHERE id = ? AND enabled = 1
          `).get(member.profileId) as SQLiteRow | undefined;
          if (!row) throw new ProductStoreError("NOT_FOUND", "Member Agent Profile is disabled or missing", {
            profileId: member.profileId,
          });
          return this.profileRecord(row);
        });
        if (input.coordinatorAgentRunId) {
          const owner = this.database.prepare("SELECT id FROM agent_runs WHERE id = ? AND task_id = ? AND session_id = ? AND role = 'coordinator'").get(input.coordinatorAgentRunId,taskId,text(coordination,"id"));
          if (!owner) throw new ProductStoreError("INVALID_ARGUMENT", "只有本任务协调者可以创建成员");
          if (memberProfiles.some(profile=>profile.role === "coordinator")) throw new ProductStoreError("INVALID_ARGUMENT", "成员不能创建另一个任务协调者");
        }
        const workflowAssignments = members.map((member, index) => {
          if (!activeWorkflow) {
            if (member.taskPacket.workflowStageId !== undefined || member.taskPacket.workflowPurpose !== undefined) {
              throw new ProductStoreError("INVALID_ARGUMENT", "No active Workflow Run owns this stage delegation");
            }
            return undefined;
          }
          const stageId = requiredString(member.taskPacket.workflowStageId, `members[${index}].workflowStageId`, 100);
          const purpose = member.taskPacket.workflowPurpose ?? "execute";
          if (purpose !== "execute" && purpose !== "verify") {
            throw new ProductStoreError("INVALID_ARGUMENT", "Workflow member purpose must be execute or verify");
          }
          if (purpose === "verify" && memberProfiles[index]?.role !== "verifier"
            || purpose === "execute" && memberProfiles[index]?.role === "verifier") {
            throw new ProductStoreError("INVALID_ARGUMENT", "Workflow verification needs a verifier; stage execution needs an execution member");
          }
          if (member.taskPacket.reviewWorkItemId || member.taskPacket.route &&
            (member.taskPacket.route as { purpose?: string }).purpose !== "independent") {
            throw new ProductStoreError("INVALID_ARGUMENT", "Workflow stage delegation cannot also claim route execution or unrelated rework");
          }
          const stage = this.workflowStages(activeWorkflow.workflowId, activeWorkflow.version)
            .find(item => item.id === stageId);
          if (!stage) throw new ProductStoreError("NOT_FOUND", "Workflow stage does not belong to its active Run");
          const binding = this.database.prepare(`
            SELECT work_item_id FROM task_workflow_work_items WHERE run_id = ? AND stage_id = ?
          `).get(activeWorkflow.id, stageId) as SQLiteRow | undefined;
          const workItemId = typeof binding?.work_item_id === "string" ? binding.work_item_id : undefined;
          if (purpose === "verify") {
            if (!workItemId) throw new ProductStoreError("REVISION_CONFLICT", "Workflow stage has no execution result to verify");
            const subject = this.database.prepare(`
              SELECT i.state, g.id AS agent_run_id, g.status AS agent_status
              FROM task_work_items i
              JOIN agent_assignments a ON a.id = i.owner_assignment_id
              JOIN agent_runs g ON g.id = a.agent_run_id
              WHERE i.id = ? AND i.task_id = ?
            `).get(workItemId, taskId) as SQLiteRow | undefined;
            if (!subject || text(subject, "state") !== "in_progress" || text(subject, "agent_status") !== "completed"
              || !this.database.prepare(`
                SELECT id FROM agent_reports WHERE agent_run_id = ? AND report_kind = 'member' LIMIT 1
              `).get(subject.agent_run_id as string)) {
              throw new ProductStoreError("REVISION_CONFLICT", "Workflow stage execution must finish with a report before verification");
            }
            return { stageId, purpose, targetWorkItemId: workItemId, version: activeWorkflow.version };
          }
          if (workItemId) {
            const work = this.database.prepare("SELECT state, owner_assignment_id FROM task_work_items WHERE id = ? AND task_id = ?")
              .get(workItemId, taskId) as SQLiteRow | undefined;
            const retry = work && text(work, "state") === "blocked" && typeof work.owner_assignment_id === "string"
              ? this.database.prepare(`
                SELECT g.id, g.status FROM agent_assignments a JOIN agent_runs g ON g.id = a.agent_run_id
                WHERE a.id = ? AND g.task_id = ?
              `).get(work.owner_assignment_id, taskId) as SQLiteRow | undefined
              : undefined;
            const safeRetry = !!retry && ["aborted", "failed", "interrupted"].includes(text(retry, "status"))
              && !this.database.prepare(`
                SELECT id FROM operation_attempts WHERE agent_run_id = ? AND status = 'unknown' LIMIT 1
              `).get(text(retry, "id"));
            if (!work || !(text(work, "state") === "pending" && !work.owner_assignment_id || safeRetry)) {
              throw new ProductStoreError("REVISION_CONFLICT", "Workflow stage already has work in progress or a completed result");
            }
          }
          for (const dependency of stage.dependsOn) {
            const previous = this.database.prepare(`
              SELECT i.state FROM task_workflow_work_items b
              JOIN task_work_items i ON i.id = b.work_item_id
              WHERE b.run_id = ? AND b.stage_id = ?
            `).get(activeWorkflow.id, dependency) as SQLiteRow | undefined;
            if (!previous || text(previous, "state") !== "completed") {
              throw new ProductStoreError("REVISION_CONFLICT", "Workflow stage dependency is not verified complete", { stageId, dependency });
            }
          }
          return { stageId, purpose, workItemId, version: activeWorkflow.version };
        });
        const stageIds = workflowAssignments.flatMap(item => item ? [item.stageId] : []);
        if (new Set(stageIds).size !== stageIds.length) {
          throw new ProductStoreError("INVALID_ARGUMENT", "One Workflow stage may have only one member assignment in this dispatch");
        }
        const reviewWorkIds = members.map((member,index) => {
          const value = member.taskPacket.reviewWorkItemId;
          if (value === undefined) return undefined;
          const id = requiredString(value, `members[${index}].reviewWorkItemId`, 200);
          if (!input.coordinatorAgentRunId || memberProfiles[index]?.role !== "worker" || member.taskPacket.route !== undefined) {
            throw new ProductStoreError("INVALID_ARGUMENT", "审查返工工作项只能由协调者派给执行成员，不能同时绑定路线");
          }
          const row = this.database.prepare("SELECT * FROM task_work_items WHERE id=? AND task_id=? AND state IN ('pending','blocked','in_progress')").get(id, taskId) as SQLiteRow | undefined;
          const details = row ? JSON.parse(text(row, "details_json")) as { reviewScope?: unknown } : undefined;
          const reworked = new Set(this.coordinatorReviews().filter(item => item.outcome === "rework").map(item => item.verificationId));
          if (!row || !details?.reviewScope || !this.verifications().some(item => item.workItemId === id && reworked.has(item.id))) {
            throw new ProductStoreError("REVISION_CONFLICT", "工作项没有可派发的审查返工");
          }
          if (typeof row.owner_assignment_id === "string") {
            const owner = this.database.prepare("SELECT g.status FROM agent_assignments a JOIN agent_runs g ON g.id=a.agent_run_id WHERE a.id=?").get(row.owner_assignment_id) as SQLiteRow | undefined;
            if (owner && ["prepared", "running", "waiting"].includes(text(owner, "status"))) throw new ProductStoreError("REVISION_CONFLICT", "原执行者仍在处理该工作项");
          }
          return id;
        });
        const routeBindings = members.map((member,index) => reviewWorkIds[index] ? undefined : this.resolveRouteBinding(taskId, member.taskPacket.route));
        const assignedWork = routeBindings.flatMap(binding => binding?.purpose === "execute" && binding.workItemId ? [binding.workItemId] : [])
          .concat(reviewWorkIds.filter((id): id is string => !!id))
          .concat(workflowAssignments.flatMap(item => item?.workItemId ? [item.workItemId] : []));
        if (new Set(assignedWork).size !== assignedWork.length) throw new ProductStoreError("INVALID_ARGUMENT", "同一工作项不能在同批派发给多个执行成员");
        let activeTeam = this.database.prepare(`
          SELECT * FROM team_runs WHERE task_id = ? AND status IN ('prepared', 'active', 'waiting')
        `).get(taskId) as SQLiteRow|undefined;
        const workflowRunId = activeWorkflow?.id ?? null;
        const ownsWorkflowRun = (teamRunId: string): boolean => {
          const ownership = this.database.prepare(`
            SELECT
              EXISTS(SELECT 1 FROM agent_assignments a WHERE a.team_run_id = ?
                AND a.assignment_kind = 'member'
                AND json_extract(a.task_packet_json, '$.workflowBinding.workflowRunId') = ?) AS matched,
              EXISTS(SELECT 1 FROM agent_assignments a WHERE a.team_run_id = ?
                AND a.assignment_kind = 'member'
                AND json_extract(a.task_packet_json, '$.workflowBinding.workflowRunId') IS NOT ?) AS foreign_member
          `).get(teamRunId, workflowRunId, teamRunId, workflowRunId) as SQLiteRow;
          return workflowRunId ? ownership.matched === 1 && ownership.foreign_member === 0
            : ownership.foreign_member === 0;
        };
        if(activeTeam && !ownsWorkflowRun(text(activeTeam,"id")))
          throw new ProductStoreError("REVISION_CONFLICT","活动团队与当前工作流运行不属于同一轮，不能追加成员");
        if(!activeTeam&&input.coordinatorAgentRunId) {
          activeTeam=this.database.prepare(`
            SELECT t.* FROM team_runs t WHERE t.task_id = ? AND t.coordinator_agent_run_id = ?
              AND EXISTS (SELECT 1 FROM agent_assignments a WHERE a.team_run_id=t.id
                AND a.assignment_kind='coordinator' AND json_extract(a.task_packet_json,'$.adaptive')=1)
              AND NOT EXISTS (SELECT 1 FROM agent_assignments a WHERE a.team_run_id=t.id
                AND a.assignment_kind='member'
                AND json_extract(a.task_packet_json,'$.workflowBinding.workflowRunId') IS NOT ?)
              AND (? IS NULL OR EXISTS (SELECT 1 FROM agent_assignments a WHERE a.team_run_id=t.id
                AND a.assignment_kind='member'
                AND json_extract(a.task_packet_json,'$.workflowBinding.workflowRunId') = ?))
            ORDER BY t.created_at DESC,t.id DESC LIMIT 1
          `).get(taskId,input.coordinatorAgentRunId,workflowRunId,workflowRunId,workflowRunId) as SQLiteRow|undefined;
        }
        if (activeTeam && !input.coordinatorAgentRunId) {
          throw new ProductStoreError("REVISION_CONFLICT", "Task already has an active Team Run", { taskId });
        }

        if(activeTeam&&text(activeTeam,"coordinator_agent_run_id")!==input.coordinatorAgentRunId) throw new ProductStoreError("REVISION_CONFLICT","现有团队由其他协调运行持有");
        const teamRunId = activeTeam?text(activeTeam,"id"):`team-run-${randomUUID()}`;
        const reusableCoordinatorRow = this.database.prepare(`
          SELECT * FROM agent_runs
          WHERE task_id = ? AND session_id = ? AND role = 'coordinator' AND team_run_id IS NULL
          ORDER BY created_at DESC, id DESC LIMIT 1
        `).get(taskId, text(coordination, "id")) as SQLiteRow | undefined;
        if (!input.coordinatorAgentRunId && reusableCoordinatorRow && ["running", "waiting"].includes(text(reusableCoordinatorRow, "status"))) {
          throw new ProductStoreError(
            "REVISION_CONFLICT",
            "Coordinator Agent Run is still active; D Code did not start a Team beside the same Coordination Runtime",
            { agentRunId: text(reusableCoordinatorRow, "id") },
          );
        }
        const reusableCoordinator = reusableCoordinatorRow
          && (input.coordinatorAgentRunId === text(reusableCoordinatorRow,"id") || ["prepared", "completed"].includes(text(reusableCoordinatorRow, "status")))
          ? agentRun(reusableCoordinatorRow)
          : undefined;
        const coordinatorAgentRunId = reusableCoordinator?.id ?? `agent-run-${randomUUID()}`;
        const teamRun: TeamRunRecord = {
          id: teamRunId,
          taskId,
          coordinatorAgentRunId,
          status: "active",
          revision: activeTeam?integer(activeTeam,"revision")+1:1,
        };
        if(activeTeam)this.database.prepare("UPDATE team_runs SET status='active',revision=revision+1,completed_at=NULL,updated_at=? WHERE id=?").run(now,teamRunId);
        else this.database.prepare(`
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
          taskPacket: { title: taskRecord.title, goal: taskRecord.goal, ...(input.coordinatorAgentRunId?{adaptive:true}:{}) },
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
          const routeBinding = routeBindings[index];
          const reviewWorkItemId = reviewWorkIds[index];
          const workflowAssignment = workflowAssignments[index];
          const workItemId = workflowAssignment?.workItemId ?? reviewWorkItemId ?? (routeBinding?.purpose === "execute" ? routeBinding.workItemId! : `work-item-${randomUUID()}`);
          const workflowBinding = workflowAssignment && activeWorkflow
            ? { workflowRunId: activeWorkflow.id, workflowId: activeWorkflow.workflowId,
              version: activeWorkflow.version, stageId: workflowAssignment.stageId, workItemId,
              purpose: workflowAssignment.purpose,
              ...(workflowAssignment.purpose === "verify" ? { targetWorkItemId: workflowAssignment.targetWorkItemId } : {}) }
            : undefined;
          const taskPacket = { ...member.taskPacket,
            ...(member.taskPacket.route || reviewWorkItemId || workflowBinding ? { currentWorkItemId: workItemId, currentWorkRevision: 1 } : {}),
            ...(routeBinding ? { routeBinding } : {}), ...(workflowBinding ? { workflowBinding } : {}) };
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
            taskPacket,
            revision: 1,
          };
          insertAssignment.run(
            assignment.id,
            taskId,
            teamRunId,
            childAgentRun.id,
            profile.id,
            "member",
            canonicalJSON(taskPacket),
            now,
            now,
          );
          if (routeBinding?.purpose === "execute" && routeBinding.workItemId || reviewWorkItemId || workflowAssignment?.purpose === "execute" && workflowAssignment.workItemId) {
            this.database.prepare("UPDATE task_work_items SET owner_assignment_id=?,state='in_progress',revision=revision+1,updated_at=? WHERE id=? AND task_id=?").run(assignment.id, now, workItemId, taskId);
          } else if (workflowBinding) {
            const ordinal=this.database.prepare("SELECT COALESCE(MAX(ordinal),-1)+1 AS ordinal FROM task_work_items WHERE task_id=?").get(taskId) as SQLiteRow;
            this.database.prepare("INSERT INTO task_work_items(id,task_id,ordinal,title,state,owner_assignment_id,details_json,revision,created_at,updated_at) VALUES (?,?,?,?,'in_progress',?,?,1,?,?)")
              .run(workItemId,taskId,integer(ordinal,"ordinal"),member.title,assignment.id,canonicalJSON({ workflowBinding }),now,now);
            if (workflowBinding.purpose === "execute") this.database.prepare("INSERT INTO task_workflow_work_items(run_id,stage_id,work_item_id,created_at) VALUES (?,?,?,?)")
              .run(activeWorkflow!.id,workflowBinding.stageId,workItemId,now);
          } else if(input.coordinatorAgentRunId) {
            const ordinal=this.database.prepare("SELECT COALESCE(MAX(ordinal),-1)+1 AS ordinal FROM task_work_items WHERE task_id=?").get(taskId) as SQLiteRow;
            this.database.prepare("INSERT INTO task_work_items(id,task_id,ordinal,title,state,owner_assignment_id,details_json,revision,created_at,updated_at) VALUES (?,?,?,?,'in_progress',?,?,1,?,?)").run(workItemId,taskId,integer(ordinal,"ordinal"),member.title,assignment.id,canonicalJSON(taskPacket),now,now);
          }
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

  async continueRouteMember(input: {
    requestId: string; taskId: string; coordinatorAgentRunId: string; agentRunId: string;
    instruction: string; acceptance: string; route: RouteDispatch; sourceSessionId: string; originRawInputId: string;
  }): Promise<{ storeRevision: number; assignmentRevision: number; workItemId: string }> {
    requiredCredentialFreeString(input.instruction, "instruction", 20000);
    requiredCredentialFreeString(input.acceptance, "acceptance", 10000);
    assertCredentialFreeValue(input, "continueRouteMember");
    return this.mutate("teamRun.continueMember", input.requestId, undefined, input, (_revision, now) => {
      const owner = this.database.prepare("SELECT id FROM agent_runs WHERE id=? AND task_id=? AND role='coordinator'").get(input.coordinatorAgentRunId, input.taskId);
      const assignment = this.database.prepare("SELECT a.* FROM agent_assignments a JOIN agent_runs g ON g.id=a.agent_run_id WHERE a.agent_run_id=? AND a.task_id=? AND a.assignment_kind='member' AND g.role<>'coordinator' ORDER BY a.created_at DESC,a.rowid DESC LIMIT 1").get(input.agentRunId, input.taskId) as SQLiteRow | undefined;
      if (!owner || !assignment) throw new ProductStoreError("INVALID_ARGUMENT", "只有本任务协调者可以续用已有成员");
      const latestWorkflow = this.database.prepare(`
        SELECT status FROM task_workflow_runs WHERE task_id = ?
        ORDER BY created_at DESC, rowid DESC LIMIT 1
      `).get(input.taskId) as SQLiteRow | undefined;
      if (latestWorkflow && ["active", "stopped", "interrupted"].includes(text(latestWorkflow,"status"))) {
        throw new ProductStoreError("REVISION_CONFLICT", "当前工作流尚未收口；旧普通成员需在收口后明确核对并重新交办");
      }
      if (!this.database.prepare("SELECT id FROM raw_inputs WHERE id=? AND task_id=?").get(input.originRawInputId,input.taskId)
        || !this.database.prepare("SELECT id FROM agent_runs WHERE id=? AND session_id=?").get(input.coordinatorAgentRunId,input.sourceSessionId)) throw new ProductStoreError("INVALID_ARGUMENT", "继续工作必须保留当前任务原文与协调会话来源");
      if (this.database.prepare("SELECT id FROM session_runs WHERE agent_run_id=? AND status IN ('prepared','running') LIMIT 1").get(input.agentRunId)
        || this.collaborationMessages(input.taskId).some(message => message.targetAgentRunId === input.agentRunId && message.state === "delivering")) throw new ProductStoreError("REVISION_CONFLICT", "成员仍在执行或接收消息，请等待停止完成后续用");
      const previous = JSON.parse(text(assignment, "task_packet_json"));
      const oldItems = this.routeWorkItems(input.taskId).filter(item => item.ownerAssignmentId === text(assignment,"id") && (!previous.currentWorkItemId || item.id === previous.currentWorkItemId));
      if (oldItems.some(item => !["completed", "cancelled"].includes(item.state))) throw new ProductStoreError("REVISION_CONFLICT", "原工作尚未收口，请先完成验收、返工或停止对应路线");
      if (this.collaborationMessages(input.taskId).some(message => message.targetAgentRunId === input.agentRunId && ["queued", "paused", "interrupted", "failed"].includes(message.state))) throw new ProductStoreError("REVISION_CONFLICT", "成员仍有未处理消息，请核对后继续原消息，或明确新安排已包含其要求并取消旧排队项");
      if (this.taskRouteContext(input.taskId)?.inputCurrent === false) throw new ProductStoreError("REVISION_CONFLICT", "请先核对最新用户输入再续用成员");
      const binding = this.resolveRouteBinding(input.taskId, input.route);
      const workItemId = binding?.purpose === "execute" ? binding.workItemId! : `work-item-${randomUUID()}`;
      const { routeBinding: _oldBinding, workflowBinding: _oldWorkflowBinding, ...retained } = previous;
      const packet = { ...retained, instruction: input.instruction, acceptance: input.acceptance, sourceSessionId: input.sourceSessionId, originRawInputId: input.originRawInputId, route: input.route, currentWorkItemId: workItemId, currentWorkRevision: (previous.currentWorkRevision ?? 1) + 1, ...(binding ? { routeBinding: binding } : {}) };
      const assignmentRevision = integer(assignment,"revision") + 1;
      this.database.prepare("UPDATE agent_assignments SET task_packet_json=?,revision=?,updated_at=? WHERE id=?").run(canonicalJSON(packet), assignmentRevision, now, text(assignment,"id"));
      if (binding?.purpose === "execute") this.database.prepare("UPDATE task_work_items SET owner_assignment_id=?,state='pending',revision=revision+1,updated_at=? WHERE id=?").run(text(assignment,"id"), now, workItemId);
      else {
        const items = this.routeWorkItems(input.taskId);
        if (items.length >= 200) throw new ProductStoreError("INVALID_ARGUMENT", "任务工作项已达到上限");
        this.database.prepare("INSERT INTO task_work_items(id,task_id,ordinal,title,state,owner_assignment_id,details_json,revision,created_at,updated_at) VALUES (?,?,?,?,'pending',?,?,1,?,?)")
          .run(workItemId, input.taskId, (items.at(-1)?.ordinal ?? -1) + 1, input.instruction.slice(0,200), text(assignment,"id"), canonicalJSON(packet), now, now);
      }
      return { value: { assignmentRevision, workItemId }, event: { kind: "agentAssignment.continued", entityKind: "agentAssignment", entityId: text(assignment,"id"), taskId: input.taskId, payload: { agentRunId: input.agentRunId, previous, current: packet, assignmentRevision } } };
    });
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
    expectedStoreRevision?: number;
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

  async retryManagedWorkerWorktree(input:{artifactId:string;expectedRevision:number}):Promise<ManagedWorkerWorktreeRecord>{
    const result=await this.mutate("managedWorkerWorktree.retry",`worktree-retry:${input.artifactId}:${input.expectedRevision}`,undefined,input,(_revision,now)=>{
      const row=this.database.prepare("SELECT * FROM artifacts WHERE id=?").get(input.artifactId) as SQLiteRow|undefined;if(!row)throw new ProductStoreError("NOT_FOUND","原工作树记录不存在");
      const current=managedWorkerWorktree(artifact(row));
      const member=this.database.prepare("SELECT session_id,status FROM agent_runs WHERE id=?").get(current.agentRunId) as SQLiteRow|undefined;
      if(current.revision!==input.expectedRevision||current.state==="ready"||!member||member.status!=="prepared")throw new ProductStoreError("REVISION_CONFLICT","成员或目录状态已改变，不能重试目录准备");
      const attemptId=`attempt-${randomUUID()}`;
      this.database.prepare("UPDATE operation_attempts SET status='unknown',outcome_json=?,completed_at=?,updated_at=? WHERE id=? AND status='prepared'").run(canonicalJSON({reason:"recovery_prepared",nextAttemptId:attemptId}),now,now,current.provisionAttemptId);
      const metadata={...JSON.parse(text(row,"metadata_json")),state:"preparing",provisionAttemptId:attemptId};delete metadata.failureCode;
      this.database.prepare("INSERT INTO operation_attempts(id,task_id,session_id,agent_run_id,operation_kind,target_identity,parameter_digest,replay_policy,status,prepared_at,updated_at) VALUES (?,?,?,?,'external_side_effect',?,?,'never','prepared',?,?)").run(attemptId,current.taskId,text(member,"session_id"),current.agentRunId,`${MANAGED_WORKER_WORKTREE_TARGET_PREFIX}${current.artifactId}`,`sha256:${payloadHash({artifactId:current.artifactId,previousAttempt:current.provisionAttemptId})}`,now,now);
      this.database.prepare("UPDATE artifacts SET metadata_json=?,revision=revision+1,updated_at=? WHERE id=?").run(canonicalJSON(metadata),now,current.artifactId);
      const worktree={...current,state:"preparing" as const,provisionAttemptId:attemptId,revision:current.revision+1};delete worktree.failureCode;
      return {value:{worktree},event:{kind:"managedWorkerWorktree.retryPrepared",entityKind:"artifact",entityId:current.artifactId,taskId:current.taskId,payload:{worktree,previousAttemptId:current.provisionAttemptId}}};
    });return result.worktree;
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
          UPDATE task_work_items SET state = 'blocked', revision = revision + 1, updated_at = ?
          WHERE state = 'in_progress' AND id IN (
            SELECT b.work_item_id FROM task_workflow_work_items b
            JOIN task_work_items i ON i.id = b.work_item_id
            JOIN agent_assignments a ON a.id = i.owner_assignment_id
            WHERE a.team_run_id = ? AND a.assignment_kind = 'member'
          )
        `).run(now, teamRunId);
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
    kind: AgentRequestKind;
    prompt: string;
    options: AgentRequestOption[];
  }): Promise<{ storeRevision: number; agentRequest: AgentRequestRecord }> {
    const taskId = requiredString(input.taskId, "taskId", 200);
    const agentRunId = requiredString(input.agentRunId, "agentRunId", 200);
    const sessionId = requiredString(input.sessionId, "sessionId", 200);
    const sessionRunId = requiredString(input.sessionRunId, "sessionRunId", 200);
    const runtimeId = requiredString(input.runtimeId, "runtimeId", 200);
    if (input.kind !== "choice" && input.kind !== "task_acceptance") {
      throw new ProductStoreError("INVALID_ARGUMENT", "Agent Request kind is invalid");
    }
    const kind = input.kind;
    const prompt = requiredCredentialFreeString(input.prompt, "prompt", 20_000).trim();
    const options = kind === "choice"
      ? (() => {
        if (!Array.isArray(input.options) || input.options.length < 2 || input.options.length > 5) {
          throw new ProductStoreError("INVALID_ARGUMENT", "Agent Request requires 2 to 5 choices");
        }
        const optionIds = new Set<string>();
        let recommendedCount = 0;
        const normalized = input.options.map((option, index): AgentRequestOption => {
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
        return normalized;
      })()
      : (() => {
        if (!Array.isArray(input.options) || input.options.length !== 0) {
          throw new ProductStoreError("INVALID_ARGUMENT", "Task acceptance must not contain choice options");
        }
        return [] as AgentRequestOption[];
      })();
    return await this.mutate(
      "agentRequest.create",
      input.requestId,
      undefined,
      { taskId, agentRunId, sessionId, sessionRunId, runtimeId, kind, prompt, options },
      (_storeRevision, now) => {
        const run = this.database.prepare(`
          SELECT g.id, g.team_run_id, g.role AS agent_role, s.kind AS session_kind, t.state AS task_state,
            (SELECT id FROM team_runs
              WHERE coordinator_agent_run_id = g.id AND status IN ('prepared', 'active', 'waiting')
              ORDER BY created_at DESC, id DESC LIMIT 1) AS coordinator_team_run_id,
            g.status AS agent_status, r.status AS session_status
          FROM agent_runs g
          JOIN session_runs r ON r.agent_run_id = g.id
          JOIN sessions s ON s.id = g.session_id
          JOIN tasks t ON t.id = g.task_id
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
        if (kind === "task_acceptance") {
          if (text(run, "agent_role") !== "coordinator" || text(run, "session_kind") !== "coordination") {
            throw new ProductStoreError(
              "REVISION_CONFLICT",
              "Only the Task Coordinator may request Task Acceptance from its Coordination Session",
            );
          }
          if (text(run, "task_state") !== "active") {
            throw new ProductStoreError("REVISION_CONFLICT", "Only an active Task may request acceptance");
          }
          const unreviewed=this.database.prepare(`SELECT w.id FROM task_work_items w JOIN agent_assignments a ON a.id=w.owner_assignment_id WHERE w.task_id=? AND w.state NOT IN ('completed','cancelled') AND a.team_run_id IN (SELECT team_run_id FROM agent_assignments WHERE assignment_kind='coordinator' AND json_extract(task_packet_json,'$.adaptive')=1) LIMIT 1`).get(taskId);
          if(unreviewed) throw new ProductStoreError("REVISION_CONFLICT","任务还有待处理或待复核的工作项");
          const activeTeam = this.database.prepare(`
            SELECT id FROM team_runs WHERE task_id = ? AND status IN ('prepared', 'active', 'waiting')
          `).get(taskId);
          if (activeTeam) {
            throw new ProductStoreError(
              "REVISION_CONFLICT",
              "Task Acceptance can only be requested after the active Agent Team has concluded",
            );
          }
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
        if (previous.kind !== "choice") {
          throw new ProductStoreError("REVISION_CONFLICT", "Task Acceptance must be answered through task.acceptance");
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

  async respondTaskAcceptance(input: {
    requestId: string;
    expectedStoreRevision: number;
    taskId: string;
    scope: TaskScope;
    expectedTaskRevision: number;
    agentRequestId: string;
    expectedRequestRevision: number;
    teamRunId?: string;
    agentRunId: string;
    sessionRunId: string;
    runtimeId: string;
    feedback?: string;
  }): Promise<{ storeRevision: number; task: TaskRecord; agentRequest: AgentRequestRecord }> {
    const taskId = requiredString(input.taskId, "taskId", 200);
    const scope = normalizedTaskScope(input.scope);
    const expectedTaskRevision = requiredRevision(input.expectedTaskRevision, "expectedTaskRevision");
    const agentRequestId = requiredString(input.agentRequestId, "agentRequestId", 200);
    const expectedRequestRevision = requiredRevision(input.expectedRequestRevision, "expectedRequestRevision");
    const teamRunId = input.teamRunId === undefined ? undefined : requiredString(input.teamRunId, "teamRunId", 200);
    const agentRunId = requiredString(input.agentRunId, "agentRunId", 200);
    const sessionRunId = requiredString(input.sessionRunId, "sessionRunId", 200);
    const runtimeId = requiredString(input.runtimeId, "runtimeId", 200);
    const feedback = input.feedback === undefined
      ? undefined
      : requiredCredentialFreeString(input.feedback, "feedback", 20_000).trim() || undefined;
    const answer: TaskAcceptanceAnswer = feedback
      ? { kind: "task_acceptance", outcome: "feedback", feedback }
      : { kind: "task_acceptance", outcome: "accepted" };
    return await this.mutate(
      "task.acceptance",
      input.requestId,
      input.expectedStoreRevision,
      {
        taskId,
        scope,
        expectedTaskRevision,
        agentRequestId,
        expectedRequestRevision,
        teamRunId,
        agentRunId,
        sessionRunId,
        runtimeId,
        feedback: feedback ?? null,
      },
      (_storeRevision, now) => {
        const requestRow = this.database.prepare("SELECT * FROM agent_requests WHERE id = ?")
          .get(agentRequestId) as SQLiteRow | undefined;
        if (!requestRow) throw new ProductStoreError("NOT_FOUND", "Task Acceptance Request does not exist", { agentRequestId });
        const previousRequest = agentRequest(requestRow);
        const taskRow = this.database.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as SQLiteRow | undefined;
        if (!taskRow) throw new ProductStoreError("NOT_FOUND", "Task does not exist", { taskId });
        const previousTask = task(taskRow);
        if (JSON.stringify(previousTask.scope) !== JSON.stringify(scope)) {
          throw new ProductStoreError("REVISION_CONFLICT", "Task Scope changed before acceptance");
        }
        if (
          previousRequest.taskId !== taskId
          || previousRequest.teamRunId !== teamRunId
          || previousRequest.agentRunId !== agentRunId
          || previousRequest.sessionRunId !== sessionRunId
          || previousRequest.runtimeId !== runtimeId
        ) {
          throw new ProductStoreError("REVISION_CONFLICT", "Task Acceptance Request identity changed before response");
        }
        if (
          previousRequest.kind !== "task_acceptance"
          || previousRequest.status !== "open"
          || previousRequest.revision !== expectedRequestRevision
        ) {
          throw new ProductStoreError("REVISION_CONFLICT", "Task Acceptance Request changed before response", {
            expectedRequestRevision,
            currentRequestRevision: previousRequest.revision,
            currentRequestStatus: previousRequest.status,
            currentRequestKind: previousRequest.kind,
          });
        }
        if (previousTask.revision !== expectedTaskRevision || previousTask.state !== "active") {
          throw new ProductStoreError("REVISION_CONFLICT", "Task changed before acceptance", {
            expectedTaskRevision,
            currentTaskRevision: previousTask.revision,
            currentTaskState: previousTask.state,
          });
        }
        const activeTeam = this.database.prepare(`
          SELECT id FROM team_runs WHERE task_id = ? AND status IN ('prepared', 'active', 'waiting')
        `).get(taskId);
        if (activeTeam) throw new ProductStoreError("REVISION_CONFLICT", "Task still has an active Team Run");
        if (answer.outcome === "accepted" && this.database.prepare(`
          SELECT id FROM task_workflow_runs WHERE task_id = ? AND status = 'active' LIMIT 1
        `).get(taskId)) {
          throw new ProductStoreError("REVISION_CONFLICT", "Active Workflow must be completed or stopped before Task acceptance");
        }

        this.database.prepare(`
          UPDATE agent_requests
          SET status = 'answered', answer_json = ?, revision = revision + 1, updated_at = ?
          WHERE id = ? AND revision = ? AND status = 'open'
        `).run(canonicalJSON(answer), now, agentRequestId, expectedRequestRevision);
        this.database.prepare(`
          UPDATE agent_runs SET status = 'running', revision = revision + 1, updated_at = ?
          WHERE id = ? AND status = 'waiting'
        `).run(now, previousRequest.agentRunId);
        this.database.prepare(`
          UPDATE session_runs SET status = 'running', revision = revision + 1, updated_at = ?
          WHERE id = ? AND status = 'waiting'
        `).run(now, previousRequest.sessionRunId);
        this.database.prepare(`
          UPDATE sessions SET state = 'active', revision = revision + 1, updated_at = ?
          WHERE id = ? AND state = 'waiting'
        `).run(now, previousRequest.sessionId);

        const updatedTask: TaskRecord = answer.outcome === "accepted"
          ? {
            ...previousTask,
            state: "completed",
            revision: previousTask.revision + 1,
            updatedAt: now,
          }
          : previousTask;
        if (answer.outcome === "accepted") {
          this.database.prepare(`
            UPDATE tasks SET state = ?, revision = ?, updated_at = ? WHERE id = ? AND revision = ?
          `).run(updatedTask.state, updatedTask.revision, now, taskId, expectedTaskRevision);
        }
        const updatedRequest: AgentRequestRecord = {
          ...previousRequest,
          status: "answered",
          answer,
          revision: previousRequest.revision + 1,
          updatedAt: now,
        };
        return {
          value: { task: updatedTask, agentRequest: updatedRequest },
          event: {
            kind: answer.outcome === "accepted" ? "task.accepted" : "task.acceptanceFeedback",
            entityKind: "task",
            entityId: taskId,
            taskId,
            payload: { task: updatedTask, agentRequest: updatedRequest },
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
    userSourceEntryId?:string;
    sourceLeafEntryId?:string;
    rollbackPathId?:string;
    handledInput?:boolean;
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
        const member=this.database.prepare("SELECT g.id,g.role,g.team_run_id FROM agent_runs g JOIN session_runs r ON r.agent_run_id=g.id WHERE r.id=?").get(sessionRunId) as SQLiteRow|undefined;
        if(member&&text(member,"role")!=="coordinator") {
          this.setAssignedWorkState(text(member,"id"), "in_progress", now);
          if(typeof member.team_run_id==="string"&&this.database.prepare("SELECT id FROM agent_assignments WHERE team_run_id=? AND assignment_kind='coordinator' AND json_extract(task_packet_json,'$.adaptive')=1 LIMIT 1").get(member.team_run_id))this.reopenAdaptiveTeam(member.team_run_id,now);
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
          SELECT id,agent_run_id,status FROM session_runs WHERE id = ? AND task_id = ? AND session_id = ?
        `).get(sessionRunId, taskId, sessionId) as SQLiteRow | undefined;
        if (!run) throw new ProductStoreError("NOT_FOUND", "Tool Attempt Session Run does not exist");
        if (typeof run.agent_run_id === "string") {
          this.assertAgentRouteCurrent(run.agent_run_id);
          const current = this.memberWorkScope(run.agent_run_id);
          if (current?.workItemId && (text(run,"status") !== "running" || canonicalJSON(this.sessionWorkScope(sessionRunId) ?? null) !== canonicalJSON(current))) throw new ProductStoreError("REVISION_CONFLICT", "本次运行的工作指派已结束，不能执行过期工具");
        }
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
    /** Only the Host may certify this after the matching SDK Runtime has stopped. */
    confirmedRuntimeAbort?: string;
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
          SELECT status, task_id, operation_kind, target_identity FROM operation_attempts WHERE id = ?
        `).get(attemptId) as { status?: unknown; task_id?: unknown; operation_kind?: unknown; target_identity?: unknown } | undefined;
        if (!attempt || typeof attempt.task_id !== "string") {
          throw new ProductStoreError("NOT_FOUND", "Operation Attempt does not exist", { attemptId });
        }
        const confirmedAbort = input.outcome === "succeeded" && input.confirmedRuntimeAbort !== undefined
          && attempt.operation_kind === "external_side_effect"
          && attempt.target_identity === `runtime.abort:${input.confirmedRuntimeAbort}`;
        if (input.confirmedRuntimeAbort !== undefined && !confirmedAbort) throw new ProductStoreError("INVALID_ARGUMENT", "Runtime stop confirmation does not match its operation");
        if (attempt.status !== "prepared" && !(attempt.status === "unknown" && confirmedAbort)) {
          const revision = this.metaInteger("store_revision");
          this.database.exec("COMMIT");
          return { storeRevision: revision, status: String(attempt.status) };
        }
        const now = this.now();
        this.database.prepare(`
          UPDATE operation_attempts
          SET status = ?, outcome_json = ?, completed_at = ?, updated_at = ?
          WHERE id = ? AND status = ?
        `).run(
          input.outcome,
          canonicalJSON({ resultDigest: input.resultDigest ?? null }),
          now,
          now,
          attemptId,
          attempt.status,
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

  nativeSessionFacts(identity:{taskId:string;sessionId:string;agentRunId?:string;sessionRunId?:string},kind:"evidence"|"changes"):NativeSessionFacts {
    this.assertOpen();
    const {taskId,sessionId,agentRunId,sessionRunId}=identity;
    if(!this.database.prepare("SELECT id FROM sessions WHERE id=? AND task_id=?").get(sessionId,taskId))throw new ProductStoreError("NOT_FOUND","Native facts Session does not belong to Task");
    // Scope is fixed by the Host, never supplied by the model. The join also
    // checks ownership so a stale/foreign attempt cannot label evidence current.
    const filter=kind==="changes"?"AND e.command_redacted IN ('write','edit')":"AND (e.command_redacted IS NULL OR substr(e.command_redacted,1,6)!='dcode_')";
    const counts=this.database.prepare(`SELECT COUNT(*) AS n FROM evidence_records e WHERE e.task_id=? AND e.session_id=? ${filter}`).get(taskId,sessionId) as SQLiteRow;
    const rows=this.database.prepare(`SELECT e.*,a.session_run_id AS operation_session_run_id FROM evidence_records e
      LEFT JOIN operation_attempts a ON a.id=e.source_record_id AND a.task_id=e.task_id AND a.session_id=e.session_id AND a.agent_run_id=e.agent_run_id
      WHERE e.task_id=? AND e.session_id=? ${filter} ORDER BY e.created_at DESC,e.id DESC LIMIT 30`).all(taskId,sessionId) as SQLiteRow[];
    const evidence=rows.reverse().map(row=>{
      const record=evidenceRecord(row),operationRun=typeof row.operation_session_run_id==="string"?row.operation_session_run_id:undefined;
      const payload=record.payload&&typeof record.payload==="object"?record.payload as Record<string,unknown>:{};
      return {id:record.id,evidenceKind:record.evidenceKind,commandRedacted:record.commandRedacted,exitKind:record.exitKind,exitCode:record.exitCode,agentRunId:record.agentRunId,createdAt:record.createdAt,
        ...(operationRun?{sessionRunId:operationRun}:{}),...(typeof row.legacy_run_id==="string"?{legacyRunId:row.legacy_run_id}:{}),
        ...(typeof payload.resultDigest==="string"&&/^sha256:[a-f0-9]{64}$/.test(payload.resultDigest)?{resultDigest:payload.resultDigest}:{}),
        isCurrentRun:!!sessionRunId&&!!agentRunId&&operationRun===sessionRunId&&record.agentRunId===agentRunId};
    });
    // session_mutations currently contains explicitly adopted legacy changes.
    // Preserve their recorded values as history; native tool digests do not
    // provide file paths, line counts or Git revisions and must not invent them.
    const changeCount=kind==="changes"?this.database.prepare("SELECT COUNT(*) AS n FROM session_mutations WHERE task_id=? AND session_id=?").get(taskId,sessionId) as SQLiteRow:undefined;
    const changes=kind==="changes"?this.database.prepare("SELECT * FROM session_mutations WHERE task_id=? AND session_id=? ORDER BY occurred_at DESC,id DESC LIMIT 30").all(taskId,sessionId) as SQLiteRow[]:[];
    return {...identity,totalEvidence:Number(counts.n),evidence,totalHistoricalFileChanges:Number(changeCount?.n??0),historicalFileChanges:changes.reverse().map(row=>({
      id:text(row,"id"),...(typeof row.legacy_run_id==="string"?{legacyRunId:row.legacy_run_id}:{}),filePath:text(row,"file_path"),operation:text(row,"operation"),additions:Number(row.additions),deletions:Number(row.deletions),
      ...(typeof row.first_changed_line==="number"?{firstChangedLine:row.first_changed_line}:{}),occurredAt:text(row,"occurred_at"),sourceKind:text(row,"source_kind"),
    }))};
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
    userSourceEntryId?:string;
    sourceLeafEntryId?:string;
    rollbackPathId?:string;
    handledInput?:boolean;
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
      if(input.handledInput&&typeof attempt.user_entry_id==="string")this.database.prepare("UPDATE session_entries SET content_json=json_set(content_json,'$.handled',json('true')) WHERE id=?").run(attempt.user_entry_id);
      if(input.userSourceEntryId&&typeof attempt.user_entry_id==="string")this.database.prepare("UPDATE session_entries SET source_entry_id=COALESCE(source_entry_id,?) WHERE id=?").run(input.userSourceEntryId,attempt.user_entry_id);
      if(input.sourceLeafEntryId&&typeof attempt.session_id==="string")this.database.prepare("UPDATE session_paths SET source_leaf_entry_id=?,revision=revision+1,updated_at=? WHERE session_id=? AND is_current=1").run(input.sourceLeafEntryId,now,attempt.session_id);
      if(input.rollbackPathId&&typeof attempt.session_id==="string"){
        if(!this.database.prepare("SELECT id FROM session_paths WHERE id=? AND session_id=?").get(input.rollbackPathId,attempt.session_id))throw new ProductStoreError("NOT_FOUND","原路径已不可用");
        this.database.prepare("UPDATE session_paths SET is_current=0,revision=revision+1,updated_at=? WHERE session_id=? AND is_current=1").run(now,attempt.session_id);
        this.database.prepare("UPDATE session_paths SET is_current=1,revision=revision+1,updated_at=? WHERE id=?").run(now,input.rollbackPathId);
      }
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
          (this.database.prepare("SELECT entry_id FROM session_path_entries WHERE path_id=? ORDER BY ordinal DESC LIMIT 1").get(currentPath.id) as {entry_id?:string}|undefined)?.entry_id??(typeof attempt.user_entry_id === "string" ? attempt.user_entry_id : null),
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
        if (this.agentRouteIsCurrent(text(attempt, "agent_run_id"))) this.setAssignedWorkState(text(attempt,"agent_run_id"), runStatus==="completed"?(attempt.agent_role==="worker"||attempt.agent_role==="verifier"&&!this.verifications().some(record=>record.verifierSessionRunId===sessionRunId)?"in_progress":"completed"):"blocked", now);
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
              ...(this.sessionWorkScope(sessionRunId) ? { workAssignment: this.sessionWorkScope(sessionRunId) } : {}),
              ...(this.sessionWorkflowReport(sessionRunId) ? { workflowReport: this.sessionWorkflowReport(sessionRunId) } : {}),
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
            const adaptive=this.database.prepare("SELECT id FROM agent_assignments WHERE team_run_id=? AND assignment_kind='coordinator' AND json_extract(task_packet_json,'$.adaptive')=1 LIMIT 1").get(attempt.team_run_id);
            if(adaptive) {
              this.reconcileAdaptiveTeam(text(attempt,"team_run_id"),now);
            } else if (typeof coordinatorReports?.count !== "number" || coordinatorReports.count < 2) {
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
      this.finishCollaborationFacts(sessionRunId,now);
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


  /** Commit the input terminal states and its result notice beside the report.
   * All identifiers come from this run's persisted input and report receipts. */
  private finishCollaborationFacts(sessionRunId:string,now:string):boolean {
    const run=this.database.prepare(`SELECT r.*,g.role,g.team_run_id,e.raw_input_id,e.context_projection_json FROM session_runs r JOIN agent_runs g ON g.id=r.agent_run_id JOIN effective_inputs e ON e.id=r.effective_input_id WHERE r.id=?`).get(sessionRunId) as SQLiteRow|undefined;
    if(!run||!["completed","failed","aborted","unknown"].includes(text(run,"status")))return false;
    const projection=JSON.parse(text(run,"context_projection_json")) as {collaborationSource?:{messageId?:string}};
    const all=this.collaborationMessages(text(run,"task_id"));
    const sources=all.filter(message=>message.targetSessionId===run.session_id&&message.targetAgentRunId===run.agent_run_id&&(message.id===projection.collaborationSource?.messageId||message.deliveryMode==="steer"&&message.targetSessionRunId===sessionRunId));
    if(!sources.length)return false;
    const report=this.database.prepare("SELECT id,body_json FROM agent_reports WHERE agent_run_id=? AND json_extract(body_json,'$.sessionRunId')=? ORDER BY created_at DESC,id DESC LIMIT 1").get(text(run,"agent_run_id"),sessionRunId) as SQLiteRow|undefined;
    const body=report?JSON.parse(text(report,"body_json")) as {text?:string}:undefined;
    const reply=run.status==="completed"&&typeof body?.text==="string"?body.text:undefined;
    const outcome=run.status==="completed"?"succeeded":text(run,"status");
    const resultReference={sessionRunId,agentRunId:text(run,"agent_run_id"),...(report?{reportId:text(report,"id")}:{}),outcome,sourceMessageIds:sources.map(message=>message.id)};
    const write=(message:CollaborationMessage)=>{
      const revision=this.metaInteger("store_revision")+1;
      this.database.prepare("INSERT INTO store_events(event_id,store_revision,kind,entity_kind,entity_id,task_id,payload_json,created_at) VALUES (?,?,'collaboration.messageChanged','collaborationMessage',?,?,?,?)").run(randomUUID(),revision,message.id,message.taskId,canonicalJSON(message),now);
      this.database.prepare("UPDATE dcode_meta SET value=? WHERE key='store_revision'").run(String(revision));
    };
    let changed=false;
    for(const previous of sources){
      if(previous.completionReference?.sessionRunId===sessionRunId||!["delivering","completed","failed","interrupted"].includes(previous.state))continue;
      if(previous.completionReference)throw new ProductStoreError("INVALID_ARGUMENT","消息结果已经属于另一轮运行");
      const consumed=previous.deliveryMode!=="steer"||!!this.database.prepare("SELECT id FROM effective_inputs WHERE json_extract(context_projection_json,'$.steeringSource.messageId')=? AND json_extract(context_projection_json,'$.steeringSource.sessionRunId')=?").get(previous.id,sessionRunId);
      const message:CollaborationMessage={...previous,state:consumed?(outcome==="succeeded"?"completed":"failed"):"interrupted",revision:previous.revision+1,updatedAt:now,completionReference:resultReference};
      delete message.waitingFor;delete message.reply;
      if(consumed&&reply)message.reply=reply.slice(0,190000);
      if(!consumed)message.error="补充尚未确认被接收，未自动重发";
      write(message);changed=true;
    }
    if(run.role==="coordinator")return changed;
    const prior=all.find(message=>message.author==="member"&&message.resultReference?.sessionRunId===sessionRunId);
    if(prior)return changed;
    const coordinator=this.database.prepare("SELECT g.id,g.session_id FROM agent_runs g WHERE g.task_id=? AND g.role='coordinator' AND (g.id=(SELECT coordinator_agent_run_id FROM team_runs WHERE id=?) OR ? IS NULL) ORDER BY g.created_at,g.id LIMIT 1").get(text(run,"task_id"),typeof run.team_run_id==="string"?run.team_run_id:null,typeof run.team_run_id==="string"?run.team_run_id:null) as SQLiteRow|undefined;
    if(!coordinator)throw new ProductStoreError("NOT_FOUND","本轮结果的协调者不存在，未提交交付状态");
    const primary=sources.find(message=>message.id===projection.collaborationSource?.messageId)??sources[0]!;
    const legacyReceipt=this.database.prepare("SELECT result_json FROM mutation_receipts WHERE request_id=? AND method='collaboration.queue'").get(`member-result:${primary.id}`) as SQLiteRow|undefined;
    const legacyId=legacyReceipt?(JSON.parse(text(legacyReceipt,"result_json")) as {message?:{id:string}}).message?.id:undefined;
    const legacy=legacyId?all.find(message=>message.id===legacyId&&message.targetAgentRunId===coordinator.id&&message.sourceSessionId===run.session_id):undefined;
    const title=this.database.prepare("SELECT title FROM sessions WHERE id=?").get(text(run,"session_id")) as SQLiteRow|undefined;
    const notice:CollaborationMessage=legacy?{...legacy,resultReference,revision:legacy.revision+1,updatedAt:now}:{
      id:`collaboration-result-${sessionRunId}`,taskId:text(run,"task_id"),originRawInputId:text(run,"raw_input_id"),sourceSessionId:text(run,"session_id"),targetSessionId:text(coordinator,"session_id"),targetAgentRunId:text(coordinator,"id"),author:"member",state:"queued",revision:1,createdAt:now,updatedAt:now,resultReference,
      text:`成员 ${title?text(title,"title"):"成员"}（${run.agent_run_id}）本轮返回 ${outcome}。\n执行：${sessionRunId}\n${report?`报告：${report.id}`:"本轮没有可交付报告"}\n这是成员结果，请独立复核，必要时安排验收或返工；执行结束不等于验收通过或用户接受。\n${reply?`${reply.slice(0,12000)}${reply.length>12000?"\n（完整内容见本轮报告）":""}`:"没有可交付回复，请检查本轮运行状态。"}`,
    };
    write(notice);return true;
  }

  private async recoverCollaborationResults():Promise<void>{
    const runs=this.database.prepare("SELECT r.id FROM session_runs r WHERE r.status IN ('completed','failed','aborted','unknown') AND EXISTS(SELECT 1 FROM operation_attempts a WHERE a.session_run_id=r.id AND json_extract(a.outcome_json,'$.piRunId') IS NOT NULL)").all() as SQLiteRow[];
    if(!runs.length)return;
    await this.lease.assertOwned();this.database.exec("BEGIN IMMEDIATE");
    try{
      const now=this.now();
      for(const run of runs)this.finishCollaborationFacts(text(run,"id"),now);
      await this.lease.assertOwned();this.database.exec("COMMIT");
    }catch(error){rollback(this.database);throw error;}
  }

  private reopenAdaptiveTeam(teamRunId:string,now:string):void {
    const team=this.database.prepare("SELECT task_id FROM team_runs WHERE id=?").get(teamRunId) as SQLiteRow|undefined;
    if(!team)return;
    const other=this.database.prepare("SELECT id FROM team_runs WHERE task_id=? AND id<>? AND status IN ('prepared','active','waiting')").get(text(team,"task_id"),teamRunId);
    if(other)throw new ProductStoreError("REVISION_CONFLICT","当前团队仍在执行，请先完成当前安排再恢复历史团队");
    this.database.prepare("UPDATE team_runs SET status='active',completed_at=NULL,revision=revision+1,updated_at=? WHERE id=?").run(now,teamRunId);
  }

  private reconcileAdaptiveTeam(teamRunId:string,now:string):void {
    const pending=this.database.prepare("SELECT COUNT(*) AS count FROM task_work_items WHERE owner_assignment_id IN (SELECT id FROM agent_assignments WHERE team_run_id=?) AND state NOT IN ('completed','cancelled')").get(teamRunId) as SQLiteRow;
    if(integer(pending,"count")===0)this.database.prepare("UPDATE team_runs SET status='completed',revision=revision+1,completed_at=?,updated_at=? WHERE id=? AND status IN ('prepared','active','waiting')").run(now,now,teamRunId);
  }

  verifications():VerificationRecord[] {
    return (this.database.prepare("SELECT payload_json FROM store_events WHERE kind='verification.submitted' ORDER BY sequence").all() as SQLiteRow[]).map(row=>JSON.parse(text(row,"payload_json")));
  }
  coordinatorReviews():CoordinatorReviewRecord[] {
    return (this.database.prepare("SELECT payload_json FROM store_events WHERE kind='verification.reviewed' ORDER BY sequence").all() as SQLiteRow[]).map(row=>JSON.parse(text(row,"payload_json")));
  }
  async submitVerification(input:{requestId:string;taskId:string;verifierAgentRunId:string;subjectReportId?:string;subjectReviewId?:string;verdict:"pass"|"fail";evidenceIds:string[];findings:VerificationRecord["findings"];summary:string}):Promise<{storeRevision:number;verification:VerificationRecord}> {
    assertCredentialFreeValue(input,"verification");
    if(!["pass","fail"].includes(input.verdict)||!input.summary?.trim()||input.evidenceIds.length>64||input.findings.length>32) throw new ProductStoreError("INVALID_ARGUMENT","验收报告格式无效");
    if(input.verdict==="pass"&&(!input.evidenceIds.length||input.findings.length)) throw new ProductStoreError("INVALID_ARGUMENT","通过验收需要独立证据且没有未解决问题");
    if(input.verdict==="fail"&&!input.findings.length) throw new ProductStoreError("INVALID_ARGUMENT","未通过时需要说明问题");
    if (!!input.subjectReportId === !!input.subjectReviewId) throw new ProductStoreError("INVALID_ARGUMENT", "请选择一份执行报告或一项固定差异");
    if (input.subjectReviewId) return this.submitReviewRequestVerification({ ...input, subjectReviewId: input.subjectReviewId });
    const subjectReportId = input.subjectReportId!;
    return this.mutate("verification.submit",input.requestId,undefined,input,(_revision,now)=>{
      const verifier=this.database.prepare("SELECT id FROM agent_runs WHERE id=? AND task_id=? AND role='verifier'").get(input.verifierAgentRunId,input.taskId);
      const subject=this.database.prepare("SELECT * FROM agent_reports WHERE id=? AND task_id=?").get(subjectReportId,input.taskId) as SQLiteRow|undefined;
      if(!verifier||!subject||text(subject,"agent_run_id")===input.verifierAgentRunId) throw new ProductStoreError("INVALID_ARGUMENT","独立验收必须由同任务不同于执行者的验收成员承担");
      this.assertReportWorkCurrent(subject);
      this.assertAgentRouteCurrent(text(subject,"agent_run_id"));
      this.assertAgentRouteCurrent(input.verifierAgentRunId);
      const latest=this.database.prepare("SELECT id FROM agent_reports WHERE agent_run_id=? AND report_kind<>'verification' ORDER BY created_at DESC,rowid DESC LIMIT 1").get(text(subject,"agent_run_id")) as SQLiteRow|undefined;
      if(!latest||text(latest,"id")!==subjectReportId)throw new ProductStoreError("REVISION_CONFLICT","执行成果已有新版，请重新读取当前报告");
      const reportRunId=JSON.parse(text(subject,"body_json")).sessionRunId;
      const boundary=typeof reportRunId==="string"?this.database.prepare("SELECT sequence FROM store_events WHERE kind='sessionRun.finished' AND entity_id=? ORDER BY sequence DESC LIMIT 1").get(reportRunId) as SQLiteRow|undefined:undefined;
      if(input.verdict==="pass"&&!boundary)throw new ProductStoreError("INVALID_ARGUMENT","报告没有可验证的提交边界");
      const evidence=input.evidenceIds.map(id=>this.database.prepare("SELECT * FROM evidence_records WHERE id=? AND task_id=? AND agent_run_id=?").get(id,input.taskId,input.verifierAgentRunId) as SQLiteRow|undefined);
      if(evidence.some(item=>!item||text(item,"command_redacted").startsWith("dcode_"))) throw new ProductStoreError("INVALID_ARGUMENT","验收证据必须来自本人实际检查成果的工具执行，不能用协调记录代替");
      if(boundary&&input.evidenceIds.some(id=>{
        const event=this.database.prepare("SELECT sequence FROM store_events WHERE kind='evidence.recorded' AND entity_id=? ORDER BY sequence DESC LIMIT 1").get(id) as SQLiteRow|undefined;
        return !event||integer(event,"sequence")<=integer(boundary,"sequence");
      }))throw new ProductStoreError("INVALID_ARGUMENT","验收证据早于当前报告，必须重新检查新版成果");
      const recheckRevision = this.routeRecheckRevision(text(subject,"agent_run_id"));
      if (recheckRevision && input.evidenceIds.some(id => {
        const event = this.database.prepare("SELECT store_revision FROM store_events WHERE kind='evidence.recorded' AND entity_id=? ORDER BY sequence DESC LIMIT 1").get(id) as SQLiteRow | undefined;
        return !event || integer(event,"store_revision") <= recheckRevision;
      })) throw new ProductStoreError("INVALID_ARGUMENT", "上游成果已改变，验收必须使用依赖变更之后的新证据");
      if(input.verdict==="pass"&&evidence.some(item=>text(item!,"exit_kind")!=="ok")) throw new ProductStoreError("INVALID_ARGUMENT","失败的检查不能作为通过证据");
      const verifierRun=this.database.prepare("SELECT id FROM session_runs WHERE agent_run_id=? AND status='running' ORDER BY created_at DESC,id DESC LIMIT 1").get(input.verifierAgentRunId) as SQLiteRow|undefined;
      if(!verifierRun)throw new ProductStoreError("INVALID_ARGUMENT","验收报告必须来自正在执行的验收运行");
      const fingerprint=payloadHash({subjectAgentRunId:text(subject,"agent_run_id"),verdict:input.verdict,findings:input.findings,evidence:evidence.map(item=>({tool:text(item!,"command_redacted"),resultDigest:JSON.parse(text(item!,"payload_json")).resultDigest})).sort((a,b)=>canonicalJSON(a).localeCompare(canonicalJSON(b)))});
      const verification:VerificationRecord={id:`verification-${randomUUID()}`,taskId:input.taskId,verifierAgentRunId:input.verifierAgentRunId,verifierSessionRunId:text(verifierRun,"id"),subjectAgentRunId:text(subject,"agent_run_id"),subjectReportId,verdict:input.verdict,evidenceIds:[...new Set(input.evidenceIds)],findings:input.findings,summary:input.summary,fingerprint,createdAt:now};
      this.setAssignedWorkState(text(subject,"agent_run_id"), "in_progress", now);
      const subjectTeam=this.database.prepare("SELECT team_run_id FROM agent_runs WHERE id=?").get(text(subject,"agent_run_id")) as SQLiteRow|undefined;
      if(typeof subjectTeam?.team_run_id==="string")this.reopenAdaptiveTeam(subjectTeam.team_run_id,now);
      this.database.prepare("INSERT INTO agent_reports(id,task_id,agent_run_id,report_kind,body_json,created_at) VALUES (?,?,?,'verification',?,?)").run(verification.id,input.taskId,input.verifierAgentRunId,canonicalJSON(verification),now);
      return {value:{verification},event:{kind:"verification.submitted",entityKind:"verification",entityId:verification.id,taskId:input.taskId,payload:verification}};
    });
  }
  private async submitReviewRequestVerification(input:{requestId:string;taskId:string;verifierAgentRunId:string;subjectReviewId:string;verdict:"pass"|"fail";evidenceIds:string[];findings:VerificationRecord["findings"];summary:string}):Promise<{storeRevision:number;verification:VerificationRecord}> {
    return this.mutate("verification.submit",input.requestId,undefined,input,(_revision,now)=>{
      const { review } = this.readTaskReview(input.taskId,input.subjectReviewId);
      if (!review.workItemId) throw new ProductStoreError("PRODUCT_STORE_CORRUPT", "审查请求缺少受影响工作项");
      const reworked = new Set(this.coordinatorReviews().filter(item => item.outcome === "rework").map(item => item.verificationId));
      if (this.verifications().some(item => item.subjectReviewId === review.id && reworked.has(item.id))) {
        throw new ProductStoreError("REVISION_CONFLICT", "成果已安排修改，请从新的差异发起复查并关联原工作项");
      }
      const verifier=this.database.prepare("SELECT id FROM agent_runs WHERE id=? AND task_id=? AND role='verifier'").get(input.verifierAgentRunId,input.taskId);
      const verifierRun=this.database.prepare("SELECT id FROM session_runs WHERE agent_run_id=? AND status='running' ORDER BY created_at DESC,id DESC LIMIT 1").get(input.verifierAgentRunId) as SQLiteRow|undefined;
      const work=this.database.prepare("SELECT * FROM task_work_items WHERE id=? AND task_id=? AND state<>'cancelled'").get(review.workItemId,input.taskId) as SQLiteRow|undefined;
      if(!verifier||!verifierRun||!work)throw new ProductStoreError("INVALID_ARGUMENT","审查必须由本任务正在运行的独立验收成员承担");
      this.assertAgentRouteCurrent(input.verifierAgentRunId);
      const owner=typeof work.owner_assignment_id==="string"?this.database.prepare("SELECT agent_run_id FROM agent_assignments WHERE id=?").get(work.owner_assignment_id) as SQLiteRow|undefined:undefined;
      const subjectAgentRunId=typeof owner?.agent_run_id==="string"?owner.agent_run_id as string:undefined;
      if(subjectAgentRunId===input.verifierAgentRunId)throw new ProductStoreError("INVALID_ARGUMENT","不能独立验收自己的工作项");
      if(input.verdict==="pass"&&subjectAgentRunId){
        const subject=this.database.prepare("SELECT status FROM agent_runs WHERE id=?").get(subjectAgentRunId) as SQLiteRow|undefined;
        if(!subject||text(subject,"status")!=="completed")throw new ProductStoreError("REVISION_CONFLICT","执行者仍在修改，不能通过当前差异审查");
      }
      const boundary=this.database.prepare("SELECT sequence FROM store_events WHERE kind='evidence.recorded' AND entity_id=?").get(review.evidenceId) as SQLiteRow|undefined;
      if(!boundary)throw new ProductStoreError("PRODUCT_STORE_CORRUPT","固定差异缺少来源事件");
      const sameReviewVerifications = new Set(this.verifications().filter(item => item.subjectReviewId === review.id).map(item => item.id));
      const rechecks = this.coordinatorReviews().filter(item => item.outcome === "recheck" && sameReviewVerifications.has(item.verificationId));
      const recheckBoundary = rechecks.map(item => this.database.prepare("SELECT sequence FROM store_events WHERE kind='verification.reviewed' AND entity_id=?").get(item.id) as SQLiteRow | undefined)
        .reduce((latest, row) => row ? Math.max(latest, integer(row, "sequence")) : latest, 0);
      const minimumSequence = Math.max(integer(boundary, "sequence"), recheckBoundary);
      const subjectFinish=subjectAgentRunId?this.database.prepare(`SELECT MAX(e.sequence) AS sequence FROM store_events e WHERE e.kind='sessionRun.finished'
        AND e.entity_id IN (SELECT id FROM session_runs WHERE agent_run_id=?)`).get(subjectAgentRunId) as SQLiteRow|undefined:undefined;
      const minimumFreshSequence=Math.max(minimumSequence,typeof subjectFinish?.sequence==="number"?subjectFinish.sequence:0);
      const evidence=input.evidenceIds.map(id=>this.database.prepare("SELECT * FROM evidence_records WHERE id=? AND task_id=? AND agent_run_id=?").get(id,input.taskId,input.verifierAgentRunId) as SQLiteRow|undefined);
      if(evidence.some(item=>!item||text(item,"command_redacted").startsWith("dcode_")&&text(item,"evidence_kind")!=="review_diff_inspection"))throw new ProductStoreError("INVALID_ARGUMENT","需要验收成员本人产生的实际检查证据");
      if(input.evidenceIds.some(id=>{const event=this.database.prepare("SELECT sequence FROM store_events WHERE kind='evidence.recorded' AND entity_id=?").get(id) as SQLiteRow|undefined;return !event||integer(event,"sequence")<=minimumFreshSequence;}))throw new ProductStoreError("INVALID_ARGUMENT","检查证据必须晚于本次差异、执行者最后完成及最近复查要求");
      if(evidence.some(item=>{
        if(!item)return true;
        if(text(item,"evidence_kind")==="review_diff_inspection")return JSON.parse(text(item,"payload_json")).sessionRunId!==text(verifierRun,"id");
        const attempt=this.database.prepare("SELECT session_run_id FROM operation_attempts WHERE id=? AND operation_kind='tool_invocation'").get(text(item,"source_record_id")) as SQLiteRow|undefined;
        return !attempt||attempt.session_run_id!==text(verifierRun,"id");
      }))throw new ProductStoreError("INVALID_ARGUMENT","复查证据必须来自当前验收运行");
      const inspected=evidence.some(item=>item&&text(item,"evidence_kind")==="review_diff_inspection"&&JSON.parse(text(item,"payload_json")).reviewId===review.id&&JSON.parse(text(item,"payload_json")).digest===review.digest);
      if(!inspected)throw new ProductStoreError("INVALID_ARGUMENT","请先读取并检查本次固定差异");
      if(input.verdict==="pass"&&(!evidence.some(item=>item&&text(item,"evidence_kind")!=="review_diff_inspection")||evidence.some(item=>item&&text(item,"exit_kind")!=="ok")))throw new ProductStoreError("INVALID_ARGUMENT","通过审查还需要实际验证且不能使用失败的检查");
      const fingerprint=payloadHash({subjectReviewId:review.id,digest:review.digest,verdict:input.verdict,findings:input.findings,evidence:evidence.map(item=>({kind:text(item!,"evidence_kind"),resultDigest:JSON.parse(text(item!,"payload_json")).resultDigest})).sort((a,b)=>canonicalJSON(a).localeCompare(canonicalJSON(b)))});
      const verification:VerificationRecord={id:`verification-${randomUUID()}`,taskId:input.taskId,verifierAgentRunId:input.verifierAgentRunId,verifierSessionRunId:text(verifierRun,"id"),subjectKind:"review_request",subjectReviewId:review.id,workItemId:review.workItemId,...(subjectAgentRunId?{subjectAgentRunId}:{}),verdict:input.verdict,evidenceIds:[...new Set(input.evidenceIds)],findings:input.findings,summary:input.summary,fingerprint,createdAt:now};
      this.database.prepare("INSERT INTO agent_reports(id,task_id,agent_run_id,report_kind,body_json,created_at) VALUES (?,?,?,'verification',?,?)").run(verification.id,input.taskId,input.verifierAgentRunId,canonicalJSON(verification),now);
      return {value:{verification},event:{kind:"verification.submitted",entityKind:"verification",entityId:verification.id,taskId:input.taskId,payload:verification}};
    });
  }
  async reviewVerification(input:{requestId:string;taskId:string;coordinatorAgentRunId:string;verificationId:string;outcome:CoordinatorReviewRecord["outcome"];reason:string;strategyChange?:string;acknowledgedInputId?:string}):Promise<{storeRevision:number;review:CoordinatorReviewRecord;verification:VerificationRecord;workItemCompleted:boolean;affectedAgentRunIds:string[]}> {
    assertCredentialFreeValue(input,"review");
    if(!["accepted","rework","recheck"].includes(input.outcome)||!input.reason?.trim()) throw new ProductStoreError("INVALID_ARGUMENT","需要明确复核结论与依据");
    return this.mutate("verification.review",input.requestId,undefined,input,(_revision,now)=>{
      const owner=this.database.prepare("SELECT id FROM agent_runs WHERE id=? AND task_id=? AND role='coordinator'").get(input.coordinatorAgentRunId,input.taskId);
      const verification=this.verifications().find(item=>item.id===input.verificationId&&item.taskId===input.taskId);
      if(!owner||!verification) throw new ProductStoreError("INVALID_ARGUMENT","只有本任务协调者可以复核已有验收");
      if(verification.subjectKind==="review_request") {
        if(!verification.subjectReviewId||!verification.workItemId)throw new ProductStoreError("PRODUCT_STORE_CORRUPT","审查验收缺少固定范围");
        const {review:request}=this.readTaskReview(input.taskId,verification.subjectReviewId);
        if(request.workItemId!==verification.workItemId)throw new ProductStoreError("REVISION_CONFLICT","审查工作项已变化");
        const work=this.database.prepare("SELECT * FROM task_work_items WHERE id=? AND task_id=? AND state<>'cancelled'").get(verification.workItemId,input.taskId) as SQLiteRow|undefined;
        if(!work)throw new ProductStoreError("REVISION_CONFLICT","受影响工作项已不可用");
        if(this.coordinatorReviews().some(item=>item.verificationId===verification.id))throw new ProductStoreError("REVISION_CONFLICT","该次验收已经复核");
        if(input.outcome==="accepted"&&verification.verdict!=="pass")throw new ProductStoreError("INVALID_ARGUMENT","不能把未通过的审查标为通过");
        if(input.outcome==="accepted"&&verification.subjectAgentRunId){
          const subject=this.database.prepare("SELECT status FROM agent_runs WHERE id=? AND task_id=?").get(verification.subjectAgentRunId,input.taskId) as SQLiteRow|undefined;
          if(!subject||text(subject,"status")!=="completed"||this.collaborationMessages(input.taskId).some(message=>message.targetAgentRunId===verification.subjectAgentRunId&&["queued","delivering","paused","interrupted","failed"].includes(message.state)))throw new ProductStoreError("REVISION_CONFLICT","执行者仍有待处理工作，请核对新版结果");
          const verified=this.database.prepare("SELECT sequence FROM store_events WHERE kind='verification.submitted' AND entity_id=?").get(verification.id) as SQLiteRow|undefined;
          const later=this.database.prepare(`SELECT e.sequence FROM store_events e WHERE e.kind='sessionRun.finished' AND e.sequence>?
            AND e.entity_id IN (SELECT id FROM session_runs WHERE agent_run_id=?) LIMIT 1`).get(verified?integer(verified,"sequence"):0,verification.subjectAgentRunId);
          if(later)throw new ProductStoreError("REVISION_CONFLICT","验收后执行者又提交了修改，请对新成果重新检查");
        }
        if(input.outcome==="accepted"&&this.taskRouteContext(input.taskId)?.inputCurrent===false)throw new ProductStoreError("REVISION_CONFLICT","用户有新输入，请先核对再接受成果");
        if(input.outcome==="accepted"){
          const verified=this.database.prepare("SELECT sequence FROM store_events WHERE kind='verification.submitted' AND entity_id=?").get(verification.id) as SQLiteRow|undefined;
          const latest=this.latestRouteInput(input.taskId);
          if(latest&&this.rawInputSequence(latest.id)>(verified?integer(verified,"sequence"):0)&&input.acknowledgedInputId!==latest.id){
            throw new ProductStoreError("REVISION_CONFLICT","验收后有新用户输入；请核对适用性并明确引用最新输入，或重新检查");
          }
        }
        const recent=this.verifications().filter(item=>item.taskId===input.taskId&&item.subjectReviewId===request.id).slice(-2);
        if(input.outcome!=="accepted"&&recent.length===2&&recent[0]!.fingerprint===recent[1]!.fingerprint&&!input.strategyChange?.trim())throw new ProductStoreError("INVALID_ARGUMENT","连续两次没有新证据，需要调整方法或重新分工");
        const review:CoordinatorReviewRecord={id:`review-${randomUUID()}`,taskId:input.taskId,coordinatorAgentRunId:input.coordinatorAgentRunId,verificationId:verification.id,outcome:input.outcome,reason:input.reason,...(input.strategyChange?{strategyChange:input.strategyChange}:{}),...(input.acknowledgedInputId?{acknowledgedInputId:input.acknowledgedInputId}:{}),createdAt:now};
        const state=input.outcome==="accepted"?"completed":input.outcome==="rework"?(work.owner_assignment_id?"in_progress":"pending"):text(work,"state");
        this.database.prepare("UPDATE task_work_items SET state=?,revision=revision+1,updated_at=? WHERE id=?").run(state,now,verification.workItemId);
        if (input.outcome === "accepted") this.completeWorkflowVerifierStage(verification, now);
        if(input.outcome==="recheck")this.setAssignedWorkState(verification.verifierAgentRunId,"in_progress",now);
        const affectedAgentRunIds=input.outcome==="rework"&&verification.subjectAgentRunId?this.blockRouteDependents(input.taskId,verification.subjectAgentRunId,input.reason,_revision,now):[];
        return {value:{review,verification,workItemCompleted:input.outcome==="accepted",affectedAgentRunIds},event:{kind:"verification.reviewed",entityKind:"coordinatorReview",entityId:review.id,taskId:input.taskId,payload:review}};
      }
      const subjectAgentRunId=verification.subjectAgentRunId;
      const subjectReportId=verification.subjectReportId;
      if(!subjectAgentRunId||!subjectReportId)throw new ProductStoreError("PRODUCT_STORE_CORRUPT","报告验收缺少执行者来源");
      this.assertAgentRouteCurrent(subjectAgentRunId);
      this.assertReportWorkCurrent(this.database.prepare("SELECT * FROM agent_reports WHERE id=?").get(subjectReportId) as SQLiteRow);
      if (input.outcome === "accepted") {
        const route = this.taskRouteContext(input.taskId);
        if (route?.inputCurrent === false) throw new ProductStoreError("REVISION_CONFLICT", "用户有新输入，请核对后再接受成果");
        const recheckRevision = this.routeRecheckRevision(subjectAgentRunId);
        const event = this.database.prepare("SELECT store_revision FROM store_events WHERE kind='verification.submitted' AND entity_id=?").get(verification.id) as SQLiteRow | undefined;
        if (recheckRevision && (!event || integer(event, "store_revision") <= recheckRevision)) throw new ProductStoreError("REVISION_CONFLICT", "上游已返工，请重新核查受影响成果后再接受");
      }
      if(this.coordinatorReviews().some(review=>review.verificationId===verification.id)) throw new ProductStoreError("REVISION_CONFLICT","该验收已经复核，应复验后提交新记录");
      const latest=this.database.prepare("SELECT id FROM agent_reports WHERE agent_run_id=? AND report_kind<>'verification' ORDER BY created_at DESC,rowid DESC LIMIT 1").get(subjectAgentRunId) as SQLiteRow|undefined;
      if(!latest||text(latest,"id")!==subjectReportId) throw new ProductStoreError("REVISION_CONFLICT","执行成果已有新版，需要对新报告验收");
      if(input.outcome==="accepted"&&verification.verdict!=="pass") throw new ProductStoreError("INVALID_ARGUMENT","不能把未通过验收的成果标为复核通过");
      const recent=this.verifications().filter(item=>item.taskId===input.taskId&&item.subjectAgentRunId===subjectAgentRunId).slice(-2);
      if(input.outcome!=="accepted"&&recent.length===2&&recent[0]!.fingerprint===recent[1]!.fingerprint&&!input.strategyChange?.trim()) throw new ProductStoreError("INVALID_ARGUMENT","连续两次没有新证据，需要调整方法或重新分工后再返工");
      const review:CoordinatorReviewRecord={id:`review-${randomUUID()}`,taskId:input.taskId,coordinatorAgentRunId:input.coordinatorAgentRunId,verificationId:verification.id,outcome:input.outcome,reason:input.reason,...(input.strategyChange?{strategyChange:input.strategyChange}:{}),createdAt:now};
      const subjectRun=this.database.prepare("SELECT status,team_run_id FROM agent_runs WHERE id=?").get(subjectAgentRunId) as SQLiteRow;
      if(input.outcome==="accepted"&&(text(subjectRun,"status")!=="completed"||this.collaborationMessages(input.taskId).some(message=>message.targetAgentRunId===subjectAgentRunId&&["queued","delivering","paused","interrupted","failed"].includes(message.state)))) throw new ProductStoreError("REVISION_CONFLICT","执行者还有新工作待处理，需要核对新版结果");
      const latestByVerifier=new Map<string,VerificationRecord>();
      for(const item of this.verifications().filter(item=>item.subjectReportId===subjectReportId))latestByVerifier.set(item.verifierAgentRunId,item);
      const reviews=[...this.coordinatorReviews(),review];
      const workItemCompleted=input.outcome==="accepted"&&[...latestByVerifier.values()].every(item=>item.verdict==="pass"&&reviews.some(candidate=>candidate.verificationId===item.id&&candidate.outcome==="accepted"));
      this.setAssignedWorkState(subjectAgentRunId, workItemCompleted ? "completed" : "in_progress", now);
      if (input.outcome === "accepted" && workItemCompleted) this.completeWorkflowVerifierStage(verification, now);
      if(input.outcome==="recheck") this.setAssignedWorkState(verification.verifierAgentRunId, "in_progress", now);
      const affectedAgentRunIds = input.outcome !== "accepted" ? this.blockRouteDependents(input.taskId, subjectAgentRunId, input.reason, _revision, now) : [];
      if(typeof subjectRun.team_run_id==="string") {
        if(workItemCompleted)this.reconcileAdaptiveTeam(subjectRun.team_run_id,now);
        else this.reopenAdaptiveTeam(subjectRun.team_run_id,now);
      }
      return {value:{review,verification,workItemCompleted,affectedAgentRunIds},event:{kind:"verification.reviewed",entityKind:"coordinatorReview",entityId:review.id,taskId:input.taskId,payload:review}};
    });
  }

  collaborationMessages(taskId?:string):CollaborationMessage[] {
    this.assertOpen();
    const rows = this.database.prepare(`SELECT payload_json FROM store_events WHERE sequence IN (
      SELECT MAX(sequence) FROM store_events WHERE kind='collaboration.messageChanged' GROUP BY entity_id
    ) ORDER BY sequence`).all() as SQLiteRow[];
    const holds = new Map<string, ReturnType<ProductStore["workflowMessageHold"]>>();
    const messages=rows.map(row=>JSON.parse(text(row,"payload_json")) as CollaborationMessage)
      .filter(message=>!taskId || message.taskId===taskId)
      .map(message=>{
        if(message.state!=="queued")return message;
        if(!holds.has(message.targetAgentRunId))holds.set(message.targetAgentRunId,this.workflowMessageHold(message.targetAgentRunId));
        const hold=holds.get(message.targetAgentRunId);
        return hold?{...message,state:"paused" as const,error:hold.reason}:message;
      });
    const orders=this.database.prepare("SELECT payload_json FROM store_events WHERE sequence IN (SELECT MAX(sequence) FROM store_events WHERE kind='collaboration.queueOrdered' GROUP BY entity_id)").all() as SQLiteRow[];
    const ranks=new Map<string,Map<string,number>>();
    for(const row of orders){const order=JSON.parse(text(row,"payload_json")) as {sessionId:string;messageIds:string[]};ranks.set(order.sessionId,new Map(order.messageIds.map((id,index)=>[id,index])));}
    const bySession=new Map<string,CollaborationMessage[]>();
    for(const message of messages){const group=bySession.get(message.targetSessionId)??[];group.push(message);bySession.set(message.targetSessionId,group);}
    return [...bySession.values()].flatMap(group=>group.sort((a,b)=>{
      const pending=(message:CollaborationMessage)=>["queued","paused"].includes(message.state);
      if(pending(a)!==pending(b))return pending(a)?1:-1;
      if(pending(a)&&pending(b)){const order=ranks.get(a.targetSessionId);const difference=(order?.get(a.id)??Number.MAX_SAFE_INTEGER)-(order?.get(b.id)??Number.MAX_SAFE_INTEGER);if(difference)return difference;}
      return a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id);
    }));
  }

  workflowMessageHold(agentRunId: string): { runId: string; reason: string } | undefined {
    this.assertOpen();
    const assignment = this.database.prepare(`
      SELECT id, task_id, team_run_id, task_packet_json FROM agent_assignments
      WHERE agent_run_id = ? AND assignment_kind = 'member'
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(agentRunId) as SQLiteRow | undefined;
    if (!assignment) return undefined;
    const binding = (JSON.parse(text(assignment, "task_packet_json")) as {
      workflowBinding?: { workflowRunId?: string; workItemId?: string };
    }).workflowBinding;
    const latest = this.database.prepare(`
      SELECT id, status FROM task_workflow_runs WHERE task_id = ?
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(text(assignment,"task_id")) as SQLiteRow | undefined;
    if (!latest) return binding?.workflowRunId
      ? { runId: binding.workflowRunId, reason: "工作流来源不可用，消息保留待核对" }
      : undefined;
    const latestRunId = text(latest,"id"), latestStatus = text(latest,"status");
    if (binding?.workflowRunId !== latestRunId) {
      if (latestStatus !== "completed") {
        return { runId: latestRunId, reason: "本任务工作流正在推进或等待继续，旧成员消息保留待协调者核对" };
      }
      const completed = this.database.prepare(`
        SELECT sequence FROM store_events WHERE kind = 'taskWorkflow.completed' AND entity_id = ?
        ORDER BY sequence DESC LIMIT 1
      `).get(latestRunId) as SQLiteRow | undefined;
      const resumed = this.database.prepare(`
        SELECT MAX(e.sequence) AS sequence FROM store_events e
        WHERE (e.kind = 'teamRun.created' AND EXISTS (
          SELECT 1 FROM json_each(e.payload_json, '$.assignments') item
          WHERE json_extract(item.value, '$.id') = ?
        )) OR (e.kind = 'agentAssignment.continued' AND e.entity_id = ?)
      `).get(text(assignment,"id"),text(assignment,"id")) as SQLiteRow | undefined;
      if (!completed || !resumed || typeof resumed.sequence !== "number"
        || integer(resumed,"sequence") <= integer(completed,"sequence")) {
        return { runId: latestRunId, reason: "旧成员安排早于已结束的工作流，需明确重新交办后再发送" };
      }
      return undefined;
    }
    if (latestStatus !== "active") {
      return { runId: latestRunId, reason: "工作流已停止或中断，消息保留至继续后核对" };
    }
    const agent = this.database.prepare("SELECT status FROM agent_runs WHERE id = ?")
      .get(agentRunId) as SQLiteRow | undefined;
    const work = binding.workItemId ? this.database.prepare("SELECT state FROM task_work_items WHERE id = ?")
      .get(binding.workItemId) as SQLiteRow | undefined : undefined;
    if (!agent || ["completed", "failed", "aborted", "interrupted", "unknown"].includes(text(agent, "status"))
      || !work || ["completed", "blocked", "cancelled"].includes(text(work, "state"))) {
      return { runId: binding.workflowRunId, reason: "原阶段成员已收口，消息保留待协调者重新指派" };
    }
    return undefined;
  }

  initialCollaborationMessage(agentRunId:string):CollaborationMessage|undefined{
    const revision = this.memberWorkScope(agentRunId)?.revision ?? 1;
    const receipt=this.database.prepare("SELECT result_json FROM mutation_receipts WHERE request_id=? AND method='collaboration.queue'").get(revision===1?`delegate-initial:${agentRunId}`:`member-work:${agentRunId}:${revision}`) as SQLiteRow|undefined;
    if(!receipt)return;const id=(JSON.parse(text(receipt,"result_json")) as {message?:{id?:string}}).message?.id;
    return this.collaborationMessages().find(message=>message.id===id&&message.targetAgentRunId===agentRunId);
  }

  async queueCollaborationMessage(input:{requestId:string;taskId:string;sourceSessionId:string;targetAgentRunId:string;author:CollaborationMessage["author"];text:string;submittedText?:string;uiAction?:CollaborationMessage["uiAction"];attachmentIds?:string[];originRawInputId?:string;pathAction?:NativeSessionPathAction;deliveryMode?:"steer";targetSessionRunId?:string;acknowledgedUserMessageId?:string}):Promise<{storeRevision:number;message:CollaborationMessage}> {
    if(typeof input.text!=="string"||input.text.length>200000||!input.text.trim()&&!input.attachmentIds?.length)throw new ProductStoreError("INVALID_ARGUMENT","需要消息或附件，正文不能超过 200000 字符");
    if(redactCredentialText(input.text).redacted)throw new ProductStoreError("CREDENTIAL_MATERIAL_REJECTED","消息包含凭据内容");
    if(input.uiAction){
      if(input.author!=="user"||input.uiAction.kind!=="task.review.request"||!input.submittedText)throw new ProductStoreError("INVALID_ARGUMENT","界面动作来源无效");
      requiredCredentialFreeString(input.submittedText,"submittedText",500);
    }else if(input.submittedText!==undefined)throw new ProductStoreError("INVALID_ARGUMENT","普通消息不能另给提交原文");
    const body=input.text;
    return this.mutate("collaboration.queue",input.requestId,undefined,{...input,text:body},(_revision,now)=>{
      const target=this.database.prepare("SELECT * FROM agent_runs WHERE id=? AND task_id=?").get(input.targetAgentRunId,input.taskId) as SQLiteRow|undefined;
      const source=this.database.prepare("SELECT id FROM sessions WHERE id=? AND task_id=?").get(input.sourceSessionId,input.taskId);
      if(!target||!source) throw new ProductStoreError("NOT_FOUND","只能向本任务已创建的成员发送消息");
      const workflowHold = text(target,"role") === "coordinator" ? undefined : this.workflowMessageHold(input.targetAgentRunId);
      if(input.attachmentIds?.some(id=>!this.attachmentCatalog().some(attachment=>attachment.id===id))) throw new ProductStoreError("NOT_FOUND","附件不存在");
      if (text(target,"role") !== "coordinator" && !workflowHold && (input.author === "coordinator" || input.author === "user"))
        this.assertAgentRouteCurrent(input.targetAgentRunId, input.author === "coordinator");
      if(text(target,"role")!=="coordinator" && !workflowHold && this.agentRouteIsCurrent(input.targetAgentRunId)) {
        this.setAssignedWorkState(input.targetAgentRunId, "in_progress", now);
        if(typeof target.team_run_id==="string")this.reopenAdaptiveTeam(target.team_run_id,now);
      }
      if(input.author==="user")this.database.prepare("UPDATE tasks SET state='active',revision=revision+1,updated_at=? WHERE id=? AND state IN ('completed','rejected')").run(now,input.taskId);
      let originRawInputId=input.originRawInputId;
      if(input.author==="user") {
        if(input.uiAction)this.readTaskReview(input.taskId,input.uiAction.reviewId);
        originRawInputId=`raw-${randomUUID()}`;
        const ordinal=this.database.prepare("SELECT COALESCE(MAX(ordinal),-1)+1 AS ordinal FROM raw_inputs WHERE session_id=?").get(input.sourceSessionId) as SQLiteRow;
        const attachments=(input.attachmentIds??[]).map(id=>this.attachmentCatalog().find(item=>item.id===id));
        this.database.prepare("INSERT INTO raw_inputs(id,task_id,session_id,ordinal,submitted_text,attachment_refs_json,source_kind,created_at) VALUES (?,?,?,?,?,?,'user_submit',?)").run(originRawInputId,input.taskId,input.sourceSessionId,integer(ordinal,"ordinal"),input.submittedText??body,canonicalJSON(attachments),now);
      } else if(!originRawInputId||!this.database.prepare("SELECT id FROM raw_inputs WHERE id=? AND task_id=?").get(originRawInputId,input.taskId)) throw new ProductStoreError("INVALID_ARGUMENT","协作消息必须保留发起原文的固定引用");
      const message:CollaborationMessage={id:`collaboration-${randomUUID()}`,taskId:input.taskId,originRawInputId:originRawInputId!,sourceSessionId:input.sourceSessionId,targetSessionId:text(target,"session_id"),targetAgentRunId:input.targetAgentRunId,author:input.author,text:body,...(input.uiAction?{uiAction:input.uiAction}:{}),...(input.acknowledgedUserMessageId?{acknowledgedUserMessageId:input.acknowledgedUserMessageId}:{}),...(!workflowHold&&input.deliveryMode?{deliveryMode:input.deliveryMode,targetSessionRunId:input.targetSessionRunId}:{}),...(input.pathAction?{pathAction:input.pathAction}:{}),...(input.attachmentIds?.length?{attachmentIds:input.attachmentIds}:{}),state:"queued",revision:1,createdAt:now,updatedAt:now};
      const visible=workflowHold?{...message,state:"paused" as const,error:workflowHold.reason}:message;
      return {value:{message:visible},event:{kind:"collaboration.messageChanged",entityKind:"collaborationMessage",entityId:message.id,taskId:message.taskId,payload:message}};
    });
  }

  async consumeSteeringMessage(input:{messageId:string;sessionRunId:string;sourceEntryId:string;effectiveText:string;inputSources?:InputSourceReceipt[]}):Promise<{storeRevision:number;effectiveInputId:string}> {
    return this.mutate("collaboration.steeringConsumed",`steering-consumed:${input.messageId}`,undefined,input,(_revision,now)=>{
      const message=this.collaborationMessages().find(message=>message.id===input.messageId);
      const run=this.database.prepare("SELECT * FROM session_runs WHERE id=?").get(input.sessionRunId) as SQLiteRow|undefined;
      if(!message||message.state!=="delivering"||message.deliveryMode!=="steer"||message.targetSessionRunId!==input.sessionRunId||!run||run.session_id!==message.targetSessionId||run.agent_run_id!==message.targetAgentRunId||!["running","waiting"].includes(String(run.status)))throw new ProductStoreError("REVISION_CONFLICT","即时补充不再属于当前运行");
      const current=this.database.prepare("SELECT id FROM session_paths WHERE session_id=? AND is_current=1").get(message.targetSessionId) as SQLiteRow;
      const previous=this.database.prepare("SELECT entry_id,ordinal FROM session_path_entries WHERE path_id=? ORDER BY ordinal DESC LIMIT 1").get(text(current,"id")) as SQLiteRow|undefined;
      const entryId=`entry-${randomUUID()}`,ordinal=previous?integer(previous,"ordinal")+1:0;
      const attachments=(message.attachmentIds??[]).map(id=>this.attachmentCatalog().find(item=>item.id===id));
      this.database.prepare("INSERT INTO session_entries(id,session_id,parent_entry_id,source_kind,lineage_status,source_entry_id,source_ordinal,source_timestamp,message_role,content_json,created_at) VALUES (?,?,?,'native','native',?,?,?,?,?,?)").run(entryId,message.targetSessionId,previous?text(previous,"entry_id"):null,input.sourceEntryId,ordinal,now,message.author==="user"?"user":"other",canonicalJSON({type:"text",text:message.text,attachmentRefs:attachments,collaborationMessageId:message.id,author:message.author,steering:true}),now);
      this.database.prepare("INSERT INTO session_path_entries(path_id,entry_id,ordinal) VALUES (?,?,?)").run(text(current,"id"),entryId,ordinal);
      const effectiveInputId=`effective-${randomUUID()}`;
      this.database.prepare("INSERT INTO effective_inputs(id,task_id,session_id,raw_input_id,conversion_revision,effective_content_json,context_projection_json,created_at) VALUES (?,?,?,?,1,?,?,?)").run(effectiveInputId,message.taskId,message.targetSessionId,message.originRawInputId,canonicalJSON({message:input.effectiveText,attachmentRefs:attachments}),canonicalJSON({version:3,steeringSource:{messageId:message.id,sessionRunId:input.sessionRunId,sourceSessionId:message.sourceSessionId},inputSources:inputSourceReceipts(input.inputSources)}),now);
      return {value:{effectiveInputId},event:{kind:"collaboration.steeringConsumed",entityKind:"collaborationMessage",entityId:message.id,taskId:message.taskId,payload:{messageId:message.id,sessionRunId:input.sessionRunId,entryId,effectiveInputId,rawInputId:message.originRawInputId}}};
    });
  }

  rawInputSequence(rawInputId:string):number {
    const row=this.database.prepare("SELECT MIN(sequence) AS sequence FROM store_events WHERE (kind='sessionRun.prepared' AND json_extract(payload_json,'$.rawInputId')=?) OR (kind='collaboration.messageChanged' AND json_extract(payload_json,'$.author')='user' AND json_extract(payload_json,'$.originRawInputId')=?)").get(rawInputId,rawInputId) as SQLiteRow;
    return typeof row.sequence==="number"?row.sequence:0;
  }

  latestAppliedUserMessage(agentRunId:string):CollaborationMessage|undefined {
    return this.collaborationMessages().filter(message=>message.targetAgentRunId===agentRunId&&message.author==="user"&&message.state!=="cancelled"&&this.isCollaborationMessageApplied(message.id)).sort((a,b)=>this.rawInputSequence(b.originRawInputId)-this.rawInputSequence(a.originRawInputId))[0];
  }

  isCollaborationMessageApplied(messageId:string):boolean {
    return !!this.database.prepare("SELECT id FROM effective_inputs WHERE json_extract(context_projection_json,'$.collaborationSource.messageId')=? OR json_extract(context_projection_json,'$.steeringSource.messageId')=? LIMIT 1").get(messageId,messageId);
  }

  async editCollaborationMessage(input:{requestId:string;id:string;expectedRevision:number;text:string}):Promise<{storeRevision:number;message:CollaborationMessage}> {
    const body=requiredCredentialFreeString(input.text,"message text",200000);
    return this.mutate("collaboration.edit",input.requestId,undefined,input,(_revision,now)=>{
      const previous=this.collaborationMessages().find(message=>message.id===input.id);
      if(!previous||previous.revision!==input.expectedRevision||previous.state!=="paused")throw new ProductStoreError("REVISION_CONFLICT","只能修改已暂停且尚未发送的消息，请刷新状态");
      const rawId=`raw-${randomUUID()}`;
      const ordinal=this.database.prepare("SELECT COALESCE(MAX(ordinal),-1)+1 AS ordinal FROM raw_inputs WHERE session_id=?").get(previous.sourceSessionId) as SQLiteRow;
      const attachments=(previous.attachmentIds??[]).map(id=>this.attachmentCatalog().find(item=>item.id===id));
      this.database.prepare("INSERT INTO raw_inputs(id,task_id,session_id,ordinal,submitted_text,attachment_refs_json,source_kind,created_at) VALUES (?,?,?,?,?,?,'user_submit',?)").run(rawId,previous.taskId,previous.sourceSessionId,integer(ordinal,"ordinal"),body,canonicalJSON(attachments),now);
      const message:CollaborationMessage={...previous,previousRawInputId:previous.originRawInputId,originRawInputId:rawId,author:"user",text:body,revision:previous.revision+1,updatedAt:now};delete message.error;delete message.uiAction;
      return {value:{message},event:{kind:"collaboration.messageChanged",entityKind:"collaborationMessage",entityId:message.id,taskId:message.taskId,payload:message}};
    });
  }

  collaborationQueueState(sessionId:string):{sessionId:string;revision:number;messageIds:string[]} {
    const row=this.database.prepare("SELECT payload_json FROM store_events WHERE kind='collaboration.queueOrdered' AND entity_id=? ORDER BY sequence DESC LIMIT 1").get(sessionId) as SQLiteRow|undefined;
    if(!row)return {sessionId,revision:0,messageIds:[]};
    const payload=JSON.parse(text(row,"payload_json"));return {...payload,revision:payload.revision??1};
  }

  async reorderCollaborationMessages(input:{requestId:string;sessionId:string;expectedQueueRevision:number;messages:Array<{id:string;revision:number}>}):Promise<{storeRevision:number}> {
    return this.mutate("collaboration.reorder",input.requestId,undefined,input,()=>{
      const queue=this.collaborationQueueState(input.sessionId);
      if(queue.revision!==input.expectedQueueRevision)throw new ProductStoreError("REVISION_CONFLICT","队列顺序已改变，请刷新后重新排序");
      const pending=this.collaborationMessages().filter(message=>message.targetSessionId===input.sessionId&&["queued","paused"].includes(message.state));
      if(!pending.length||input.messages.length!==pending.length||new Set(input.messages.map(item=>item.id)).size!==pending.length||input.messages.some(item=>!pending.some(message=>message.id===item.id&&message.revision===item.revision)))throw new ProductStoreError("REVISION_CONFLICT","待发送队列已改变，请刷新后重新排序");
      return {value:{},event:{kind:"collaboration.queueOrdered",entityKind:"collaborationQueue",entityId:input.sessionId,taskId:pending[0]!.taskId,payload:{sessionId:input.sessionId,revision:queue.revision+1,messageIds:input.messages.map(item=>item.id)}}};
    });
  }

  async waitCollaborationMessage(id:string,expectedRevision:number,waitingFor:"capacity"|"workspace"):Promise<void>{
    const previous=this.collaborationMessages().find(item=>item.id===id);if(previous?.waitingFor===waitingFor&&previous.state==="queued")return;
    await this.mutate("collaboration.wait",`wait:${id}:${expectedRevision}:${waitingFor}`,undefined,{id,expectedRevision,waitingFor},(_revision,now)=>{
      const current=this.collaborationMessages().find(item=>item.id===id);if(!current||current.revision!==expectedRevision||current.state!=="queued")throw new ProductStoreError("REVISION_CONFLICT","待发送消息已改变");
      const message={...current,waitingFor,revision:current.revision+1,updatedAt:now};return {value:{},event:{kind:"collaboration.messageChanged",entityKind:"collaborationMessage",entityId:id,taskId:current.taskId,payload:message}};
    });
  }

  async transitionCollaborationMessage(input:{requestId:string;id:string;expectedRevision:number;state:CollaborationMessageState;reply?:string;error?:string}):Promise<{storeRevision:number;message:CollaborationMessage}> {
    return this.mutate("collaboration.transition",input.requestId,undefined,input,(_revision,now)=>{
      const previous=this.collaborationMessages().find(message=>message.id===input.id);
      if(!previous) throw new ProductStoreError("NOT_FOUND","协作消息不存在");
      if(previous.revision!==input.expectedRevision) throw new ProductStoreError("REVISION_CONFLICT","消息状态已改变");
      if(["queued","delivering"].includes(input.state) && this.workflowMessageHold(previous.targetAgentRunId)) {
        throw new ProductStoreError("REVISION_CONFLICT","工作流或成员尚未恢复，消息保留待核对");
      }
      const allowed:Record<CollaborationMessageState,CollaborationMessageState[]>={queued:["delivering","paused","cancelled"],delivering:["completed","failed","interrupted"],paused:["queued","cancelled"],interrupted:["cancelled"],completed:[],failed:["cancelled"],cancelled:[]};
      if(!allowed[previous.state].includes(input.state)) throw new ProductStoreError("INVALID_ARGUMENT","不能执行此消息状态变更");
      const message:CollaborationMessage={...previous,state:input.state,revision:previous.revision+1,updatedAt:now,...(input.reply?{reply:requiredCredentialFreeString(input.reply,"reply",200000)}:{}),...(input.error?{error:requiredCredentialFreeString(input.error,"error",2000)}:{})};
      delete message.waitingFor;
      if(input.state==="queued"){delete message.error;delete message.deliveryMode;delete message.targetSessionRunId;}
      return {value:{message},event:{kind:"collaboration.messageChanged",entityKind:"collaborationMessage",entityId:message.id,taskId:message.taskId,payload:message}};
    });
  }

  agentProcessExecutions():Array<{taskId:string;agentRunId:string;runtimeId:string;process:import("./process-agent.js").AgentProcessInfo}> {
    const rows=this.database.prepare("SELECT payload_json FROM store_events WHERE sequence IN (SELECT MAX(sequence) FROM store_events WHERE kind='agentProcess.changed' GROUP BY entity_id) ORDER BY sequence").all() as SQLiteRow[];
    return rows.map(row=>JSON.parse(text(row,"payload_json")));
  }

  async recordAgentProcess(input: { requestId: string; taskId: string; agentRunId: string; runtimeId: string; process: import("./process-agent.js").AgentProcessInfo }): Promise<{storeRevision:number}> {
    return this.mutate("agentProcess.record",input.requestId,undefined,input,()=>{
      if (!this.database.prepare("SELECT id FROM agent_runs WHERE id=? AND task_id=?").get(input.agentRunId,input.taskId)) throw new ProductStoreError("NOT_FOUND","进程所属成员不存在");
      return {value:{},event:{kind:"agentProcess.changed",entityKind:"agentProcess",entityId:input.process.executionId,taskId:input.taskId,payload:input}};
    });
  }

  auxiliaryProcessExecutions():Array<{taskId:string;agentRunId:string;runtimeId:string;sessionRunId:string;process:AuxiliaryProcessInfo}> {
    return (this.database.prepare("SELECT payload_json FROM store_events WHERE sequence IN (SELECT MAX(sequence) FROM store_events WHERE kind='auxiliaryProcess.changed' GROUP BY entity_id) ORDER BY sequence").all() as SQLiteRow[]).map(row=>JSON.parse(text(row,"payload_json")));
  }

  async recordAuxiliaryProcess(input:{requestId:string;taskId:string;agentRunId:string;runtimeId:string;sessionRunId:string;process:AuxiliaryProcessInfo}):Promise<{storeRevision:number}>{
    return this.mutate("auxiliaryProcess.record",input.requestId,undefined,input,()=>{
      if(!this.database.prepare("SELECT id FROM session_runs WHERE id=? AND task_id=? AND agent_run_id=? AND runtime_id=?").get(input.sessionRunId,input.taskId,input.agentRunId,input.runtimeId))throw new ProductStoreError("NOT_FOUND","辅助进程缺少所属运行");
      return {value:{},event:{kind:"auxiliaryProcess.changed",entityKind:"auxiliaryProcess",entityId:input.process.id,taskId:input.taskId,payload:input}};
    });
  }

  providerCalls():NonNullable<FoundationSnapshot["providerCalls"]>{
    return (this.database.prepare("SELECT payload_json FROM store_events WHERE sequence IN (SELECT MAX(sequence) FROM store_events WHERE kind='providerCall.changed' GROUP BY entity_id) ORDER BY sequence").all() as SQLiteRow[]).map(row=>JSON.parse(text(row,"payload_json")));
  }

  async recordProviderCall(input:import("./provider-route-stream.js").ProviderCallRecord&{taskId:string;sessionId?:string;sessionRunId?:string;agentRunId?:string}):Promise<{storeRevision:number}>{
    return this.mutate("providerCall.record",`provider-call:${input.id}:${input.state}`,undefined,input,()=>{
      if(input.sessionRunId){
        const run=this.database.prepare("SELECT id FROM session_runs WHERE id=? AND task_id=? AND status IN ('running','waiting')").get(input.sessionRunId,input.taskId);if(!run)throw new ProductStoreError("REVISION_CONFLICT","模型调用不属于当前运行");
      }else if(input.purpose!=="context_summary"||!input.sessionId||!input.agentRunId||!this.database.prepare("SELECT id FROM agent_runs WHERE id=? AND task_id=? AND session_id=?").get(input.agentRunId,input.taskId,input.sessionId))throw new ProductStoreError("REVISION_CONFLICT","辅助模型调用缺少所属会话与成员");
      return {value:{},event:{kind:"providerCall.changed",entityKind:"providerCall",entityId:input.id,taskId:input.taskId,payload:input}};
    });
  }

  async recordRunningModelRoute(input:{requestId:string;sessionRunId:string;agentRunId:string;decision:import("./model-route.js").ModelRouteDecision;systemPromptDigest:string}):Promise<{storeRevision:number}>{
    return this.mutate("agentModel.reroute",input.requestId,undefined,input,(_revision,now)=>{
      const run=this.database.prepare("SELECT task_id FROM session_runs WHERE id=? AND agent_run_id=? AND status='running'").get(input.sessionRunId,input.agentRunId) as SQLiteRow|undefined;
      if(!run||!input.decision.selected)throw new ProductStoreError("REVISION_CONFLICT","当前运行不能更换模型");
      this.database.prepare("UPDATE agent_runs SET model_provider=?,model_id=?,revision=revision+1,updated_at=? WHERE id=?").run(input.decision.selected.providerId,input.decision.selected.modelId,now,input.agentRunId);
      return {value:{},event:{kind:"agentModel.rerouted",entityKind:"agentRun",entityId:input.agentRunId,taskId:text(run,"task_id"),payload:input}};
    });
  }

  async selectAgentModel(input: {requestId:string;agentRunId:string;decision:import("./model-route.js").ModelRouteDecision}):Promise<{storeRevision:number}> {
    assertCredentialFreeValue(input.decision,"decision");
    return this.mutate("agentModel.select",input.requestId,undefined,input,(_revision,now)=>{
      const run = this.database.prepare("SELECT * FROM agent_runs WHERE id=?").get(input.agentRunId) as SQLiteRow|undefined;
      if (!run) throw new ProductStoreError("NOT_FOUND","成员不存在");
      if (["running","waiting"].includes(text(run,"status"))) throw new ProductStoreError("REVISION_CONFLICT","运行期间不能切换模型");
      const selected = input.decision.selected;
      if (!selected) throw new ProductStoreError("INVALID_ARGUMENT","没有可用的候选模型");
      this.database.prepare("UPDATE agent_runs SET model_provider=?,model_id=?,revision=revision+1,updated_at=? WHERE id=?").run(selected.providerId,selected.modelId,now,input.agentRunId);
      return {value:{},event:{kind:"agentModel.selected",entityKind:"agentRun",entityId:input.agentRunId,taskId:text(run,"task_id"),payload:input}};
    });
  }

  private profileModels(profileId: string): AgentModelCandidate[] | undefined {
    const row = this.database.prepare("SELECT value_json FROM product_settings WHERE key = ?").get(`agent.models.${profileId}`) as SQLiteRow | undefined;
    return row ? agentModelCandidates(JSON.parse(text(row, "value_json"))) : undefined;
  }

  private profileRecord(row: SQLiteRow): AgentProfileRecord {
    const profile = agentProfile(row);
    const models = this.profileModels(profile.id);
    return { ...profile, ...(models ? { modelCandidates: models } : {}) };
  }

  private writeProfileModels(profileId: string, models: AgentModelCandidate[] | null, now: string): void {
    const key = `agent.models.${profileId}`;
    if (models === null) { this.database.prepare("DELETE FROM product_settings WHERE key = ?").run(key); return; }
    for (const model of models) {
      if (!this.database.prepare("SELECT id FROM model_catalog_entries WHERE provider_id = ? AND model_id = ?").get(model.providerId, model.modelId)) throw new ProductStoreError("NOT_FOUND", "回退链中的模型不在目录中");
    }
    this.database.prepare(`INSERT INTO product_settings(key, value_json, source_kind, revision, created_at, updated_at)
      VALUES (?, ?, 'user', 1, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, revision=product_settings.revision+1, updated_at=excluded.updated_at`)
      .run(key, canonicalJSON(models), now, now);
  }

  async updateAgentProfile(input: {
    requestId: string;
    expectedStoreRevision: number;
    profileId: string;
    expectedProfileRevision: number;
    name: string;
    roleContract: string;
    enabled: boolean;
    modelCandidates?: AgentModelCandidate[] | null;
  }): Promise<{ storeRevision: number; agentProfile: AgentProfileRecord }> {
    const profileId = requiredString(input.profileId, "profileId", 200);
    const expectedProfileRevision = requiredRevision(input.expectedProfileRevision, "expectedProfileRevision");
    const name = requiredCredentialFreeString(input.name, "name", 200).trim();
    const roleContract = requiredCredentialFreeString(input.roleContract, "roleContract", 20_000);
    if (typeof input.enabled !== "boolean") {
      throw new ProductStoreError("INVALID_ARGUMENT", "enabled must be a boolean");
    }
    const models = input.modelCandidates === undefined ? undefined : input.modelCandidates === null ? null : agentModelCandidates(input.modelCandidates);
    const params = { profileId, expectedProfileRevision, name, roleContract, enabled: input.enabled, ...(models !== undefined ? { modelCandidates: models } : {}) };
    return await this.mutate(
      "agentProfile.update",
      input.requestId,
      input.expectedStoreRevision,
      params,
      (_storeRevision, now) => {
        const row = this.database.prepare("SELECT * FROM agent_profiles WHERE id = ?").get(profileId) as SQLiteRow | undefined;
        if (!row) throw new ProductStoreError("NOT_FOUND", "Agent Profile does not exist", { profileId });
        const previous = this.profileRecord(row);
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
        if (models !== undefined) this.writeProfileModels(profileId, models, now);
        const updatedModels = this.profileModels(profileId);
        if (updatedModels) updated.modelCandidates = updatedModels;
        else delete updated.modelCandidates;
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
    modelCandidates?: AgentModelCandidate[] | null;
  }): Promise<{ storeRevision: number; agentProfile: AgentProfileRecord }> {
    const name = requiredCredentialFreeString(input.name, "name", 200).trim();
    const roleContract = requiredCredentialFreeString(input.roleContract, "roleContract", 20_000);
    if (typeof input.enabled !== "boolean") {
      throw new ProductStoreError("INVALID_ARGUMENT", "enabled must be a boolean");
    }
    const models = input.modelCandidates == null ? null : agentModelCandidates(input.modelCandidates);
    return await this.mutate(
      "agentProfile.create",
      input.requestId,
      input.expectedStoreRevision,
      { name, roleContract, enabled: input.enabled, modelCandidates: models },
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
        if (models) {
          this.writeProfileModels(record.id, models, now);
          record.modelCandidates = models;
        }
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
    if (this.closePromise) return await this.closePromise;
    if (this.closed) return;
    this.closing = true;
    this.closePromise = (async () => {
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
    })();
    await this.closePromise;
  }
}
