import {WorkspaceWriteGuard,workspacePathsOverlap} from "./workspace-write-guard.js";
import {verificationContext} from "./verification-context.js";
import {AuxiliaryProcesses} from "./auxiliary-process.js";
import type {ProviderRouteControl,ProviderModel} from "./provider-route-stream.js";
import {sanitizeRuntimeValue} from "./runtime-privacy.js";
import {directoryChangeTargets,directoryPosition,swapProjectDirectories,privateSessionDigest,type ProjectDirectoryChange} from "./project-directory-change.js";
import {expandDCodeInput} from "./input-expansion.js";
import {WorkspaceAccess} from "./workspace-access.js";
import {createVerificationExtension,DCODE_VERIFICATION_TOOL_NAME,type VerificationAction} from "./collaboration-verification.js";
import { createCollaborationExtension, DCODE_TEAM_TOOL_NAME, type TeamAction } from "./collaboration-extension.js";
import type { CollaborationMessage } from "./collaboration-message.js";
import { ModelQuotaService, assessModelQuota } from "./model-quota.js";
import { chooseAgentModel, type ModelRouteDecision, type AgentModelCandidate } from "./model-route.js";
import { ProcessAgent } from "./process-agent.js";
import { createProcessAgentSession } from "./process-agent-session.js";
import { type ManagedAttachment, attachmentPrompt } from "./attachment-files.js";
import type { ClientPreferences } from "./product-store.js";
import type { DCodeModelsView, ModelChoice } from "./model-catalog-view.js";
import { MaintenanceController } from "./maintenance.js";
import { catalogProviderInput, providerCatalogSeed, registerCatalogProviders } from "./model-catalog-configuration.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { link, lstat, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve, relative, isAbsolute } from "node:path";
import {fileURLToPath} from "node:url";
import type { AgentEvent, AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AuthType } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import {
  CURRENT_SESSION_VERSION,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  VERSION as PI_VERSION,
  buildSessionContext,
  collectEntriesForBranchSummary,
  createAgentSession,
  estimateTokens,
  getAgentDir,
  resolveModelScopeWithDiagnostics,
  type AgentSession,
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
  type SessionEntry,
  type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import { diagramKind, render } from "grok-mermaid";
import {
  DCodeFastController,
  createDCodeFastExtension,
  createFastSnapshot,
  restoreFastMode,
} from "./dcode-fast.js";
import { createDCodeFactsExtension } from "./dcode-facts.js";
import { ModelProvidersStore } from "./model-providers.js";
import {
  DisabledPackageStore,
  collectResourcesSnapshot,
  disabledPackageStorePath,
  packageSourceKey,
} from "./resources.js";
import { ExtensionUIBridge } from "./extension-ui.js";
import type { HostMethod, PromptImageInput } from "./protocol.js";
import { SessionLease, SessionLeaseError, sessionSnapshotDigest } from "./session-lease.js";
import {
  SessionReader,
  SessionReadError,
  D_CODE_SESSION_ORIGIN_TYPE,
  type SessionCwdScope,
  type SessionOrigin,
  type SessionInspection,
  type SessionSummary,
} from "./session-reader.js";
import { DCodeResourceLoader } from "./resource-policy.js";
import { ModelAuthBridge } from "./model-auth.js";
import { publishNewFileAtomically } from "./atomic-file.js";
import { extractSearchableMessage, searchEntryDigest } from "./search-entry-digest.js";
import { SessionCopier } from "./session-copy.js";
import { ProjectDirectoryMigrator, ProjectDirectoryMigrationError } from "./project-directory-migration.js";
import { SessionSearchIndex } from "./session-search-index.js";
import { structuredToolChange } from "./session-change.js";
import {
  ProductStore,
  ProductStoreError,
  type AgentRunRecord,
  type ManagedWorkerWorktreeRecord,
  type RuntimeModelCatalogProviderInput,
  type RuntimeModelSelectionRecord,
  type TaskContextSourceRecord,
  type TaskContextSourceInput,
  type TaskPlanState,
  type TaskRecord,
  type TaskScope,
  type TaskWorkItemState,
} from "./product-store.js";
import {
  listPiImportCandidates,
  preparePiSessionImport,
} from "./pi-session-import.js";
import { redactCredentialText } from "./credential-material.js";
import {
  ManagedWorkerWorktreeError,
  assertManagedWorkerWorktreeContextSourcesMaterialize,
  inspectManagedWorkerWorktreeSource,
  planManagedWorkerWorktree,
  provisionManagedWorkerWorktree,
  verifyManagedWorkerWorktree,
} from "./managed-worker-worktree.js";
import type { LegacyStoreKind } from "./legacy-migration.js";
import {
  assembleDCodeSystemPrompt,
  DCodePromptContextSelectionError,
  DCodePromptCredentialError,
  loadDCodePromptDocuments,
  type AssembledDCodePrompt,
  type DCodePromptEnvironment,
  type DCodePromptTool,
} from "./prompt-assembler.js";
import {
  inspectDCodePromptSourceReceipts,
  type DCodePromptSourceReadCache,
} from "./prompt-source-status.js";
import {
  DCodeOperationAttemptController,
  createDCodeOperationAttemptExtension,
} from "./operation-attempt-extension.js";
import {
  DCODE_AGENT_REQUEST_TOOL_NAME,
  DCODE_TASK_ACCEPTANCE_TOOL_NAME,
  DCodeAgentRequestController,
  createDCodeAgentRequestExtension,
  type DCodeAgentRequestInput,
} from "./agent-request-extension.js";

// Pi 0.84.1 uses medium when settings.json does not override the default.
// Keep this pinned-version fallback next to the Host compatibility boundary.
const PI_DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";
const MAX_ACTIVE_RUNTIMES = 12;
const SHARED_READ_ONLY_TOOL_NAMES = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "dcode_facts",
  DCODE_AGENT_REQUEST_TOOL_NAME,
  DCODE_TASK_ACCEPTANCE_TOOL_NAME,
  DCODE_TEAM_TOOL_NAME,
  DCODE_VERIFICATION_TOOL_NAME,
]);

function ownerRuntimeModel(owner:AgentRunRecord):AgentModelCandidate|undefined{return owner.modelProvider&&owner.modelId?{providerId:owner.modelProvider,modelId:owner.modelId}:undefined;}

type Emit = (event: string, data?: unknown) => void;
const HOST_VERSION = "0.0.29";

const RUNTIME_SCOPED_METHODS = new Set<HostMethod>([
  "runtime.start",
  "session.open",
  "session.close",
  "session.refresh",
  "session.prompt",
  "session.steer",
  "session.abort",
  "session.getState",
  "session.contextBreakdown",
  "session.getCommands",
  "session.getModels",
  "session.compactionInfo",
  "session.compact",
  "session.getThinkingLevels",
  "session.setModel",
  "session.setName",
  "session.setThinking",
  "session.setFastMode",
  "extension.respond",
  "agentRequest.answer",
  "agentRun.stop",
]);

const RUNTIME_CONTROL_METHODS = new Set<HostMethod>([
  "session.getModels",
  "session.getThinkingLevels",
  "session.setModel",
  "session.setThinking",
  "session.steer",
  "session.abort",
  "extension.respond",
  "agentRequest.answer",
  "agentRun.stop",
]);

type RunPhase = "saving" | "running" | "waitingForUser" | "stopRequested" | "completed" | "failed" | "aborted" | "unknown";
type RunOutcome = "completed" | "failed" | "aborted" | "unknown";
type RunWaitKind = "select" | "confirm" | "input" | "editor";

interface RunState {
  sessionId: string;
  runId: string;
  phase: RunPhase;
  waitingFor?: RunWaitKind;
  startedAt: string;
  updatedAt: string;
  completionId?: string;
  completionEntryId?: string;
  completedAt?: string;
  inputPersisted: boolean;
  retryable: boolean;
}

interface ActiveRun {
  id: string;
  sessionRunId?: string;
  providerAttemptId?: string;
  rawInputId?: string;
  latestRawInputId?:string;
  knownUserUpdates?:Map<string,string>;
  messageReadCoverage?:Map<string,number>;
  steering?:Map<string,{message:CollaborationMessage;effectiveText:string;inputSources:import("./input-expansion.js").InputSourceReceipt[];knownUserUpdates:Map<string,string>;timestamp:number;sourceEntryId?:string;effectiveInputId?:string}>;
  steeringPersistence?:Promise<void>;
  effectiveInputId?: string;
  promptReceiptId?: string;
  pathEntryId?: string;
  persistenceFailed?:boolean;
  pathAction?:import("./product-store.js").NativeSessionPathAction;
  toolCalls: Map<string, { toolName: string; args: unknown }>;
  state: RunState;
  outcome?: RunOutcome;
  handledInput?:boolean;
  commandFailed?:boolean;
  finalization?: Promise<void>;
  completion?:Promise<void>;
}

function runWaitKind(value: unknown): RunWaitKind | undefined {
  return value === "select" || value === "confirm" || value === "input" || value === "editor"
    ? value
    : undefined;
}

export interface PiHostOptions {
  agentDir?: string;
  sessionsDirectory?: string;
  dataRoot?: string;
  userHome?: string;
  legacyUserDefaults?: Record<string, unknown>;
  legacySourcePaths?: Partial<Record<LegacyStoreKind, string>>;
  leaseAgentDir?: string;
  leaseQuietWindowMs?: number;
  conflictPollMs?: number;
  agentIdleTimeoutMs?: number;
  searchCacheDirectory?: string;
  trashDirectory?: string;
  emit: Emit;
}

export class PiHostError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) {
    super(message);
    this.name = "PiHostError";
  }
}

interface WritableSession {
  inspection: SessionInspection;
  session: AgentSession;
  lease: SessionLease;
  ui: ExtensionUIBridge;
  unsubscribe: () => void;
  conflictTimer: ReturnType<typeof setInterval>;
  conflict?: { code: string; message: string; details?: unknown };
  conflictAbort?: Promise<void>;
  leaseSync: Promise<void>;
  ownedMutationDepth: number;
  activePlan: unknown;
  /** dgoal-work-v1 最新条目的待批计划提案；无提案或无活动 goal 时为 null。 */
  activeProposal: unknown;
  fastMode: DCodeFastController;
  closing: boolean;
  auxiliary?:AuxiliaryProcesses;
  closePromise?:Promise<void>;
  currentRun?: ActiveRun;
  lastRunState?: RunState;
  runtimeIdentity?: RuntimeIdentity;
  runtimeEventSequence: number;
  seenPromptIds: Map<string, string>;
  seenSteerIds: Map<string, string>;
  writePoison?: { sessionId: string; reason: string };
  assembledPrompt?: AssembledDCodePrompt;
  promptEnvironment?: DCodePromptEnvironment;
  promptDocuments?:Awaited<ReturnType<typeof loadDCodePromptDocuments>>;
  promptImportedHistory?:Awaited<ReturnType<ProductStore["importedSessionHistoryProjection"]>>;
  activePromptTools: DCodePromptTool[];
  toolsWritable: boolean;
  attemptController?: DCodeOperationAttemptController;
  agentRequestController?: DCodeAgentRequestController;
}

type ActiveSession = WritableSession;

interface RuntimeIdentity {
  runtimeId: string;
  scope: TaskScope;
  taskId: string;
  dcodeSessionId: string;
  agentRunId?: string;
  adapterSessionId: string;
  workspace: {
    workspaceId: string;
    cwd: string;
    access: "sharedReadOnly" | "exclusiveWrite";
    isolationKey?: string;
  };
}

type RuntimePromptIdentity = Omit<RuntimeIdentity, "adapterSessionId">;

interface WorkspaceClaim {
  access: "sharedReadOnly" | "exclusiveWrite";
  writerRuntimeId?: string;
  runtimeIds: Set<string>;
}

interface PendingAgentRequestResolution {
  runtimeId: string;
  resolve: (answer: unknown) => void;
  reject: (error: Error) => void;
  removeAbortListener?: () => void;
}


interface PromptCallContext {
  active: WritableSession;
  promptId: string;
  confirmed: boolean;
  confirmation?: Promise<void>;
  persistedEntryId?: string;
  rollbackLeafId?: string | null;
  nativePath?:{id:string;previousId:string};
}

interface ModelScopeProjection {
  unrestricted: boolean;
  enabledKeys: Set<string>;
  matchedPatterns: Map<string, string[]>;
  diagnostics: Array<{ code: string; message: string; pattern: string }>;
}

interface ModelCacheMetadata {
  checkedAt?: number;
  lastModified?: number;
}

interface ModelRefreshAttempt {
  attempted: boolean;
  aborted: boolean;
  failed: boolean;
  providerErrors: Set<string>;
}

function modelKey(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

interface SessionPathAction {
  fromPathId?:string;
  expectedCurrentPathId?:string;
  expectedCurrentPathRevision?:number;
  kind: "editUser" | "continueAssistant" | "continuePath";
  entryId: string;
}

function leafIdForPathId(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === "root") return null;
  if (typeof value === "string" && value.startsWith("leaf:") && value.length > 5) return value.slice(5);
  throw new PiHostError("SESSION_PATH_NOT_FOUND", `Unknown session path: ${String(value)}`);
}

interface SessionFileVersion {
  device: string;
  inode: string;
  size: string;
  mtimeNs: string;
}

async function readSessionFileVersion(path: string): Promise<SessionFileVersion> {
  const fileStat = await stat(path, { bigint: true });
  return {
    device: String(fileStat.dev),
    inode: String(fileStat.ino),
    size: String(fileStat.size),
    mtimeNs: String(fileStat.mtimeNs),
  };
}

function sameSessionFileVersion(left: SessionFileVersion, right: SessionFileVersion): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs;
}

function sameSessionIdentity(left: SessionHeader, right: SessionHeader): boolean {
  return left.id === right.id
    && (left.version ?? 1) === (right.version ?? 1)
    && left.timestamp === right.timestamp
    && left.cwd === right.cwd
    && (left.parentSession ?? null) === (right.parentSession ?? null);
}

function toWireEvent(active: WritableSession, event: AgentSessionEvent): unknown {
  let wire: Record<string, unknown>;
  if (event.type !== "message_update") {
    wire = event as unknown as Record<string, unknown>;
  } else {
    const assistantMessageEvent = event.assistantMessageEvent;
    if (!("partial" in assistantMessageEvent)) {
      wire = event as unknown as Record<string, unknown>;
    } else {
      const { partial: _partial, ...delta } = assistantMessageEvent;
      wire = { type: "message_update", assistantMessageEvent: delta };
    }
  }
  return {
    ...wire,
    sessionId: active.session.sessionId,
    ...(active.currentRun ? { runId: active.currentRun.id } : {}),
    ...(active.currentRun?.pathEntryId ? { pathEntryId: active.currentRun.pathEntryId } : {}),
  };
}

function outcomeFromAgentEnd(event: AgentSessionEvent): RunOutcome {
  if (event.type !== "agent_end") return "unknown";
  const assistant = [...event.messages].reverse().find((message) => message.role === "assistant");
  if (!assistant || !("stopReason" in assistant)) return "unknown";
  switch (assistant.stopReason) {
    case "aborted": return "aborted";
    case "error": return "failed";
    case "pending":
    case "deferred": return "unknown";
    default: return "completed";
  }
}

type SafeModelSnapshot = Record<string, unknown> & {
  provider: string;
  id: string;
  name?: string;
};

function safeModel(model: unknown): SafeModelSnapshot | null {
  if (typeof model !== "object" || model === null) return null;
  const source = model as Record<string, unknown>;
  if (typeof source.provider !== "string" || source.provider.trim() === "") return null;
  if (typeof source.id !== "string" || source.id.trim() === "") return null;
  const keys = ["provider", "id", "name", "api", "reasoning", "input", "contextWindow", "maxTokens", "cost"];
  return {
    ...Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]])),
    provider: source.provider,
    id: source.id,
    ...(typeof source.name === "string" ? { name: source.name } : {}),
    thinkingLevels: getSupportedThinkingLevels(model as Parameters<typeof getSupportedThinkingLevels>[0]),
    fastModeSupported: createFastSnapshot(true, { provider: source.provider, id: source.id }).active,
  };
}

function redactCredentialValue(value: unknown): unknown {
  if (typeof value === "string") return redactCredentialText(value).text;
  if (Array.isArray(value)) return value.map(redactCredentialValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [
    key,
    redactCredentialValue(child),
  ]));
}

function planFromEntry(entry: SessionEntry): { matched: boolean; plan: unknown; proposal: unknown } {
  if (entry.type !== "custom") return { matched: false, plan: null, proposal: null };
  if (entry.customType === "dgoal-work-v1") {
    const data = entry.data as { goal?: unknown; pendingProposal?: unknown } | undefined;
    const goal = data?.goal;
    const status = typeof goal === "object" && goal !== null ? (goal as { status?: unknown }).status : undefined;
    const plan = typeof goal === "object" && goal !== null && (status === "active" || status === "paused") ? goal : null;
    return { matched: true, plan, proposal: plan ? data?.pendingProposal ?? null : null };
  }
  if (entry.customType === "dgoal-plan-v2") {
    return { matched: true, plan: (entry.data as { goal?: unknown } | undefined)?.goal ?? null, proposal: null };
  }
  return { matched: false, plan: null, proposal: null };
}

function agentSessionSnapshotDigest(session: AgentSession): string {
  return sessionSnapshotDigest([session.sessionManager.getHeader(), ...session.sessionManager.getEntries()]);
}

function sessionDirectoryName(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function errorRecord(error: unknown): { code: string; message: string; details?: unknown } {
  if (error instanceof PiHostError) {
    return error.details === undefined
      ? { code: error.code, message: error.message }
      : { code: error.code, message: error.message, details: error.details };
  }
  if (typeof error === "object" && error !== null) {
    const record = error as { code?: unknown; message?: unknown; details?: unknown };
    if (typeof record.code === "string" && typeof record.message === "string") {
      return record.details === undefined
        ? { code: record.code, message: record.message }
        : { code: record.code, message: record.message, details: record.details };
    }
  }
  return { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) };
}


function derivedRequestId(prefix: string, values: Record<string, unknown>): string {
  return `${prefix}-${createHash("sha256").update(JSON.stringify(values)).digest("hex").slice(0, 48)}`;
}

function leaseVerificationFailureReason(error: unknown): unknown {
  if (typeof error !== "object" || error === null) return undefined;
  const details = (error as { details?: unknown }).details;
  return typeof details === "object" && details !== null
    ? (details as { reason?: unknown }).reason
    : undefined;
}

export class PiHost {
  readonly agentDir: string;
  readonly sessionsDirectory: string;
  readonly leaseAgentDir: string;
  readonly reader: SessionReader;
  readonly searchIndex: SessionSearchIndex;
  readonly sessionCopier: SessionCopier;
  readonly projectDirectoryMigrator = new ProjectDirectoryMigrator();
  readonly trashDirectory: string;
  private legacyActive?: ActiveSession;
  private readonly runtimes = new Map<string, ActiveSession>();
  private readonly runtimeByAdapterSessionId = new Map<string, string>();
  private readonly openingAdapterSessionIds = new Map<string, string>();
  private readonly runtimeByDCodeSessionId = new Map<string, string>();
  private readonly openingDCodeSessionIds = new Map<string, string>();
  private readonly runtimeWorkspaceClaims = new Map<string, WorkspaceClaim>();
  private readonly openingWorkspaceClaims = new Map<string, WorkspaceClaim>();
  private readonly runtimeContext = new AsyncLocalStorage<string | undefined>();
  private readonly runtimeQueues = new Map<string, Promise<void>>();
  private readonly pendingAgentRequests = new Map<string, PendingAgentRequestResolution>();
  private shutdownRequested = false;
  private operationQueue = Promise.resolve();
  private writePoison?: { sessionId: string; reason: string };
  private readonly runtimeWritePoisons = new Map<string, { sessionId: string; reason: string }>();
  private searchShutdown?: Promise<void>;
  private readonly leaseQuietWindowMs: number;
  private readonly conflictPollMs: number;
  private readonly promptCall = new AsyncLocalStorage<PromptCallContext | undefined>();
  private readonly modelAuth: ModelAuthBridge;
  private productStore?: ProductStore;
  private productStoreOpening?: Promise<ProductStore>;
  private attachmentSweep?: ReturnType<typeof setInterval>;
  /** ADR 0027 决定 5：已见 promptId / steerId 的幂等登记（有界 LRU），
   * 重复提交返回诚实错误而不是重复执行。 */
  private static readonly seenIdLimit = 256;

  private get active(): ActiveSession | undefined {
    const runtimeId = this.runtimeContext.getStore();
    return runtimeId ? this.runtimes.get(runtimeId) : this.legacyActive;
  }

  private set active(value: ActiveSession | undefined) {
    const runtimeId = this.runtimeContext.getStore();
    if (!runtimeId) {
      this.legacyActive = value;
      return;
    }
    const previous = this.runtimes.get(runtimeId);
    if (previous?.runtimeIdentity) {
      this.runtimeByAdapterSessionId.delete(previous.runtimeIdentity.adapterSessionId);
      this.runtimeByDCodeSessionId.delete(previous.runtimeIdentity.dcodeSessionId);
      this.releaseWorkspaceClaim(
        this.runtimeWorkspaceClaims,
        this.workspaceClaimKey(previous.runtimeIdentity.workspace),
        runtimeId,
      );
    }
    if (!value) {
      this.runtimes.delete(runtimeId);
      return;
    }
    if (value.runtimeIdentity?.runtimeId !== runtimeId) {
      throw new PiHostError("RUNTIME_IDENTITY_MISMATCH", "Runtime activation identity does not match its routing context");
    }
    this.runtimes.set(runtimeId, value);
    this.runtimeByAdapterSessionId.set(value.runtimeIdentity.adapterSessionId, runtimeId);
    this.runtimeByDCodeSessionId.set(value.runtimeIdentity.dcodeSessionId, runtimeId);
    this.addWorkspaceClaim(
      this.runtimeWorkspaceClaims,
      this.workspaceClaimKey(value.runtimeIdentity.workspace),
      runtimeId,
      value.runtimeIdentity.workspace.access,
    );
  }

  private addWorkspaceClaim(
    claims: Map<string, WorkspaceClaim>,
    cwd: string,
    runtimeId: string,
    access: WorkspaceClaim["access"],
  ): void {
    for(const [path,claim] of claims){
      if(this.workspacesOverlap(path,cwd) && this.claimConflict(claim,runtimeId,access))throw new PiHostError("WORKSPACE_IN_USE","Runtime workspace claim conflicts with an active writer",{cwd});
    }
    const current=claims.get(cwd);
    if(!current){claims.set(cwd,{access,...(access==="exclusiveWrite"?{writerRuntimeId:runtimeId}:{}),runtimeIds:new Set([runtimeId])});return;}
    current.runtimeIds.add(runtimeId);
    if(access==="exclusiveWrite"){current.writerRuntimeId=runtimeId;current.access=access;}
  }

  private workspacesOverlap(a:string,b:string):boolean {return workspacePathsOverlap(a,b);}

  private claimConflict(claim:WorkspaceClaim,runtimeId:string,access:WorkspaceClaim["access"]):string|undefined {
    const other=[...claim.runtimeIds].find(id=>id!==runtimeId);if(!other)return;
    if(access==="exclusiveWrite") {
      if(claim.writerRuntimeId&&claim.writerRuntimeId!==runtimeId || !this.directWorkerRuntimes.has(runtimeId))return other;
    }else if(claim.writerRuntimeId&&!this.directWorkerRuntimes.has(claim.writerRuntimeId))return other;
    return;
  }

  private releaseWorkspaceClaim(
    claims: Map<string, WorkspaceClaim>,
    cwd: string,
    runtimeId: string,
  ): void {
    const current = claims.get(cwd);
    if (!current) return;
    current.runtimeIds.delete(runtimeId);
    if(current.writerRuntimeId===runtimeId){delete current.writerRuntimeId;current.access="sharedReadOnly";}
    if (current.runtimeIds.size === 0) claims.delete(cwd);
    this.wakeCollaboration();
  }

  private workspaceConflict(cwd: string, runtimeId: string, access: WorkspaceClaim["access"]): string | undefined {
    if(access==="exclusiveWrite"&&this.pendingProjectDirectories().some(path=>this.workspacesOverlap(path,cwd)))return "project-directory-change";
    const fileWriter=this.workspaceFileWrites.conflict(cwd);if(fileWriter)return fileWriter;
    if(access==="exclusiveWrite")for(const record of this.productStore?.auxiliaryProcessExecutions()??[]){if(record.process.status==="unknown"&&!this.runtimes.has(record.runtimeId)&&this.workspacesOverlap(record.process.cwd,cwd))return record.runtimeId;}
    for(const claims of [this.runtimeWorkspaceClaims,this.openingWorkspaceClaims])for(const [path,claim] of claims){
      if(!this.workspacesOverlap(path,cwd))continue;
      const conflict=this.claimConflict(claim,runtimeId,access);if(conflict)return conflict;
    }
    return undefined;
  }

  private workspaceClaimKey(workspace: RuntimeIdentity["workspace"]): string {
    return workspace.isolationKey ?? workspace.cwd;
  }

  private async resolveWorkspaceIsolationKey(cwd: string): Promise<string> {
    let current = cwd;
    while (true) {
      try {
        const marker = await lstat(join(current, ".git"));
        if (marker.isDirectory() || marker.isFile() || marker.isSymbolicLink()) return current;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const parent = dirname(current);
      if (parent === current) return cwd;
      current = parent;
    }
  }

  private rememberSeenId(map: Map<string, string>, id: string, runId: string): void {
    if (map.has(id)) return;
    map.set(id, runId);
    while (map.size > PiHost.seenIdLimit) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  constructor(private readonly options: PiHostOptions) {
    this.agentDir = options.agentDir ?? getAgentDir();
    this.sessionsDirectory = options.sessionsDirectory ?? join(this.agentDir, "sessions");
    this.leaseAgentDir = options.leaseAgentDir ?? this.agentDir;
    this.leaseQuietWindowMs = options.leaseQuietWindowMs ?? 500;
    this.conflictPollMs = options.conflictPollMs ?? 1_000;
    this.reader = new SessionReader(this.sessionsDirectory);
    this.sessionCopier = new SessionCopier(this.sessionsDirectory);
    this.trashDirectory = options.trashDirectory ?? join(homedir(), ".Trash");
    this.searchIndex = new SessionSearchIndex({
      sessionsDirectory: this.sessionsDirectory,
      ...(options.searchCacheDirectory ? { cacheDirectory: options.searchCacheDirectory } : {}),
      emit: options.emit,
    });
    this.modelAuth = new ModelAuthBridge(options.emit);
  }

  get wantsShutdown(): boolean { return this.shutdownRequested; }
  get productDataRoot(): string | undefined { return this.productStore?.layout.root; }

  async start(): Promise<void> {
    await this.getProductStore();
    await this.recoverProjectDirectoryChanges();
    if(this.productStore)for(const assignment of (await this.productStore.snapshot()).agentAssignments)if(assignment.assignmentKind!=="coordinator"&&assignment.agentRunId)await this.ensureAdaptiveInitialInput(this.productStore,assignment.agentRunId,true);
    await this.ensureDCodeRuntimeModelCatalog();
    await this.productStore?.sweepAttachments().catch(error=>this.options.emit("attachment.cleanupFailed",{message:error instanceof Error?error.message:String(error)}));
    this.attachmentSweep=setInterval(()=>{void this.productStore?.sweepAttachments().catch(error=>this.options.emit("attachment.cleanupFailed",{message:error instanceof Error?error.message:String(error)}));},60*60*1000);
    this.attachmentSweep.unref();
  }

  private async getProductStore(): Promise<ProductStore> {
    if (this.productStore) return this.productStore;
    this.productStoreOpening ??= ProductStore.open({
      ...(this.options.dataRoot ? { dataRoot: this.options.dataRoot } : {}),
      ...(this.options.userHome ? { userHome: this.options.userHome } : {}),
      legacyMigration: {
        agentDir: this.agentDir,
        sessionsDirectory: this.sessionsDirectory,
        ...(this.options.legacyUserDefaults ? { userDefaults: this.options.legacyUserDefaults } : {}),
        ...(this.options.legacySourcePaths ? { sourcePaths: this.options.legacySourcePaths } : {}),
      },
    });
    try {
      this.productStore = await this.productStoreOpening;
      const privateSessions=join(this.productStore.layout.runtimeDirectory,"pi-sessions");
      this.reader.addDirectory(privateSessions);this.searchIndex.addDirectory(privateSessions);
      return this.productStore;
    } catch (error) {
      this.productStoreOpening = undefined;
      throw error;
    }
  }

  private async foundationSnapshot(afterEventSequence: number): Promise<unknown> {
    const snapshot = await (await this.getProductStore()).snapshot(afterEventSequence);
    const runtimeEnvironments = new Map(
      snapshot.runtimeEnvironments.map((environment) => [environment.id, environment]),
    );
    const promptSourceReadCache: DCodePromptSourceReadCache = new Map();
    return {
      ...snapshot,
      runtimeDialogs:[...this.runtimes.values()].flatMap(runtime=>runtime.runtimeIdentity?runtime.ui.pendingRequests.map(request=>({...request,runtimeId:runtime.runtimeIdentity!.runtimeId,taskId:runtime.runtimeIdentity!.taskId,sessionId:runtime.runtimeIdentity!.dcodeSessionId})):[]),
      promptReceipts: await Promise.all(snapshot.promptReceipts.map(async (receipt) => ({
        ...receipt,
        sourceStates: await inspectDCodePromptSourceReceipts(
          runtimeEnvironments.get(receipt.runtimeEnvironmentId)?.cwd,
          receipt.sourceReceipts,
          promptSourceReadCache,
        ),
      }))),
    };
  }

  private runtimeIdentityFromParams(params: Record<string, unknown>): RuntimeIdentity | undefined {
    if (params.runtimeId === undefined) return undefined;
    const runtimeId = params.runtimeId;
    const taskId = params.taskId;
    const dcodeSessionId = params.dcodeSessionId;
    const agentRunId = params.agentRunId;
    const adapterSessionId = params.adapterSessionId;
    const scope = params.scope;
    const workspace = params.workspace;
    if (
      typeof runtimeId !== "string"
      || typeof taskId !== "string"
      || typeof dcodeSessionId !== "string"
      || typeof adapterSessionId !== "string"
      || (agentRunId !== undefined && typeof agentRunId !== "string")
      || typeof scope !== "object"
      || scope === null
      || Array.isArray(scope)
      || typeof workspace !== "object"
      || workspace === null
      || Array.isArray(workspace)
    ) {
      throw new PiHostError("RUNTIME_IDENTITY_INVALID", "Runtime identity is incomplete");
    }
    const taskScope = scope as Record<string, unknown>;
    const normalizedScope: TaskScope = taskScope.kind === "user" && typeof taskScope.userId === "string"
      ? { kind: "user", userId: taskScope.userId }
      : taskScope.kind === "project" && typeof taskScope.projectId === "string"
        ? { kind: "project", projectId: taskScope.projectId }
        : (() => { throw new PiHostError("RUNTIME_IDENTITY_INVALID", "Runtime Task Scope is invalid"); })();
    const runtimeWorkspace = workspace as Record<string, unknown>;
    if (
      typeof runtimeWorkspace.workspaceId !== "string"
      || typeof runtimeWorkspace.cwd !== "string"
      || (runtimeWorkspace.access !== "sharedReadOnly" && runtimeWorkspace.access !== "exclusiveWrite")
    ) {
      throw new PiHostError("RUNTIME_IDENTITY_INVALID", "Runtime workspace identity is invalid");
    }
    return {
      runtimeId,
      scope: normalizedScope,
      taskId,
      dcodeSessionId,
      ...(typeof agentRunId === "string" ? { agentRunId } : {}),
      adapterSessionId,
      workspace: {
        workspaceId: runtimeWorkspace.workspaceId,
        cwd: runtimeWorkspace.cwd,
        access: runtimeWorkspace.access,
      },
    };
  }

  private async validateRuntimeIdentity(identity: RuntimeIdentity, adapterSessionId: string): Promise<void> {
    if (identity.adapterSessionId !== adapterSessionId) {
      throw new PiHostError("RUNTIME_IDENTITY_MISMATCH", "Runtime adapterSessionId does not match session.open");
    }
    let canonicalWorkspace: string;
    try {
      canonicalWorkspace = await realpath(identity.workspace.cwd);
      if (!(await stat(canonicalWorkspace)).isDirectory()) throw new Error("not a directory");
    } catch (error) {
      throw new PiHostError("WORKSPACE_NOT_ACCESSIBLE", "Runtime workspace is not an accessible directory", {
        cwd: identity.workspace.cwd,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    identity.workspace.cwd = canonicalWorkspace;
    identity.workspace.isolationKey = await this.resolveWorkspaceIsolationKey(canonicalWorkspace);
    const snapshot = await (await this.getProductStore()).snapshot();
    const task = snapshot.tasks.find((candidate) => candidate.id === identity.taskId);
    const session = snapshot.sessions.find((candidate) => candidate.id === identity.dcodeSessionId);
    if (!task || !session || session.taskId !== task.id) {
      throw new PiHostError("RUNTIME_IDENTITY_MISMATCH", "Runtime Task or D Code Session does not exist");
    }
    if (JSON.stringify(task.scope) !== JSON.stringify(identity.scope)) {
      throw new PiHostError("RUNTIME_IDENTITY_MISMATCH", "Runtime Task Scope does not match the Product Store");
    }
    const declaredAgentRun = identity.agentRunId
      ? snapshot.agentRuns.find((candidate) => candidate.id === identity.agentRunId)
      : undefined;
    if (!identity.agentRunId || declaredAgentRun?.role !== "worker") {
      let canonicalTaskCwd: string;
      try {
        canonicalTaskCwd = await realpath(task.cwd);
      } catch {
        throw new PiHostError("WORKSPACE_TASK_SCOPE_REQUIRED", "Task Scope directory is unavailable for this Runtime");
      }
      if (identity.workspace.cwd !== canonicalTaskCwd) {
        throw new PiHostError(
          "WORKSPACE_TASK_SCOPE_REQUIRED",
          "Non-Worker Runtime workspace must exactly match its Task Scope directory",
          { taskCwd: canonicalTaskCwd, workspaceCwd: identity.workspace.cwd },
        );
      }
    }
    if (identity.agentRunId) {
      const agentRun = snapshot.agentRuns.find((candidate) => candidate.id === identity.agentRunId);
      if (!agentRun || agentRun.taskId !== task.id || agentRun.sessionId !== session.id) {
        throw new PiHostError("RUNTIME_IDENTITY_MISMATCH", "Runtime Agent Run does not match its Task and Session");
      }
      if (agentRun.role === "worker") {
        if(await this.checkDirectWorkerWorkspace(snapshot,agentRun,task,identity.workspace))return;
        const managedWorktree = snapshot.managedWorkerWorktrees.find((candidate) => (
          candidate.agentRunId === agentRun.id && candidate.taskId === task.id
        ));
        if (!managedWorktree || managedWorktree.state !== "ready") {
          throw new PiHostError(
            "WORKSPACE_MANAGED_WORKTREE_UNKNOWN",
            "Worker Runtime requires a ready managed worktree owned by the same Agent Run",
          );
        }
        if (
          identity.workspace.access !== "exclusiveWrite"
          || identity.workspace.workspaceId !== managedWorktree.workspaceId
          || identity.workspace.cwd !== managedWorktree.workspaceCwd
        ) {
          throw new PiHostError(
            "WORKSPACE_MANAGED_WORKTREE_REQUIRED",
            "Worker Runtime workspace must exactly match its managed worktree Artifact",
          );
        }
      }
    }
  }

  private async assertWorkerRuntimeWorkspaceBeforeBinding(input: {
    store: ProductStore;
    runtimeId: string;
    taskId: string;
    dcodeSessionId: string;
    agentRunId?: string;
    scope: TaskScope;
    workspace: { workspaceId: string; cwd: string; access: "sharedReadOnly" | "exclusiveWrite" };
  }): Promise<void> {
    if (!input.agentRunId) return;
    const snapshot = await input.store.snapshot();
    const task = snapshot.tasks.find((candidate) => candidate.id === input.taskId);
    const session = snapshot.sessions.find((candidate) => candidate.id === input.dcodeSessionId);
    const agentRun = snapshot.agentRuns.find((candidate) => candidate.id === input.agentRunId);
    if (
      !task
      || !session
      || !agentRun
      || session.taskId !== task.id
      || agentRun.taskId !== task.id
      || agentRun.sessionId !== session.id
      || JSON.stringify(task.scope) !== JSON.stringify(input.scope)
    ) {
      throw new PiHostError("RUNTIME_IDENTITY_MISMATCH", "Runtime Agent Run does not match its Task or D Code Session");
    }
    if (agentRun.role !== "worker") return;
    if(await this.checkDirectWorkerWorkspace(snapshot,agentRun,task,input.workspace))return;
    const managedWorktree = snapshot.managedWorkerWorktrees.find((candidate) => (
      candidate.agentRunId === agentRun.id && candidate.taskId === task.id
    ));
    if (!managedWorktree || managedWorktree.state !== "ready") {
      throw new PiHostError(
        "WORKSPACE_MANAGED_WORKTREE_UNKNOWN",
        "Worker Runtime requires a ready managed worktree before any Pi Session can be created",
      );
    }
    if (
      input.workspace.access !== "exclusiveWrite"
      || input.workspace.workspaceId !== managedWorktree.workspaceId
    ) {
      throw new PiHostError(
        "WORKSPACE_MANAGED_WORKTREE_REQUIRED",
        "Worker Runtime workspace identity must match its managed worktree before Session creation",
      );
    }
    let canonicalCwd: string;
    try {
      canonicalCwd = await realpath(input.workspace.cwd);
    } catch {
      throw new PiHostError(
        "WORKSPACE_MANAGED_WORKTREE_REQUIRED",
        "Worker Runtime workspace directory is not the ready managed worktree",
      );
    }
    if (canonicalCwd !== managedWorktree.workspaceCwd) {
      throw new PiHostError(
        "WORKSPACE_MANAGED_WORKTREE_REQUIRED",
        "Worker Runtime cwd must exactly match its managed worktree before Session creation",
      );
    }
    try {
      await verifyManagedWorkerWorktree({
        agentRunId: managedWorktree.agentRunId,
        artifactId: managedWorktree.artifactId,
        workspaceId: managedWorktree.workspaceId,
        worktreeRoot: managedWorktree.managedPath,
        workspaceCwd: managedWorktree.workspaceCwd,
        sourceProjectDirectory: managedWorktree.sourceProjectDirectory,
        repositoryRoot: managedWorktree.repositoryRoot,
        commonGitDirectory: managedWorktree.commonGitDirectory,
        baseCommit: managedWorktree.baseCommit,
        projectRelativePath: managedWorktree.projectRelativePath,
      });
    } catch (error) {
      const failureCode = error instanceof ManagedWorkerWorktreeError
        ? error.code
        : "WORKSPACE_WORKTREE_VERIFICATION_FAILED";
      let invalidated;
      try {
        invalidated = await input.store.invalidateManagedWorkerWorktree({
          requestId: `worktree-invalidate-${createHash("sha256")
            .update(`${managedWorktree.artifactId}\0${failureCode}`)
            .digest("hex")
            .slice(0, 48)}`,
          artifactId: managedWorktree.artifactId,
          failureCode,
        });
      } catch (invalidationError) {
        throw new PiHostError(
          "WORKSPACE_MANAGED_WORKTREE_UNKNOWN",
          "Worker worktree verification failed and D Code could not persist its unknown state",
          { failureCode, persistence: errorRecord(invalidationError).code },
        );
      }
      this.options.emit("foundation.changed", {
        storeRevision: invalidated.storeRevision,
        kind: "managedWorkerWorktree.invalidated",
        entityKind: "artifact",
        entityId: invalidated.worktree.artifactId,
        taskId: invalidated.worktree.taskId,
        agentRunId: invalidated.worktree.agentRunId,
      });
      throw new PiHostError(
        "WORKSPACE_MANAGED_WORKTREE_UNKNOWN",
        "Worker managed worktree no longer passes Git identity verification; D Code did not create a Pi Session",
        { failureCode },
      );
    }
  }

  private async assertNonWorkerRuntimeWorkspaceBeforeBinding(input: {
    store: ProductStore;
    taskId: string;
    dcodeSessionId: string;
    agentRunId?: string;
    scope: TaskScope;
    workspace: { workspaceId: string; cwd: string; access: "sharedReadOnly" | "exclusiveWrite" };
  }): Promise<void> {
    const snapshot = await input.store.snapshot();
    const task = snapshot.tasks.find((candidate) => candidate.id === input.taskId);
    const session = snapshot.sessions.find((candidate) => candidate.id === input.dcodeSessionId);
    const agentRun = input.agentRunId
      ? snapshot.agentRuns.find((candidate) => candidate.id === input.agentRunId)
      : undefined;
    if (
      !task
      || !session
      || session.taskId !== task.id
      || JSON.stringify(task.scope) !== JSON.stringify(input.scope)
      || (input.agentRunId !== undefined && (
        !agentRun || agentRun.taskId !== task.id || agentRun.sessionId !== session.id
      ))
    ) {
      throw new PiHostError("RUNTIME_IDENTITY_MISMATCH", "Runtime Task, Session, or Agent Run does not match the Product Store");
    }
    if (agentRun?.role === "worker") return;
    let canonicalTaskCwd: string;
    let canonicalWorkspaceCwd: string;
    try {
      [canonicalTaskCwd, canonicalWorkspaceCwd] = await Promise.all([
        realpath(task.cwd),
        realpath(input.workspace.cwd),
      ]);
      if (!(await stat(canonicalTaskCwd)).isDirectory() || !(await stat(canonicalWorkspaceCwd)).isDirectory()) {
        throw new Error("not a directory");
      }
    } catch {
      throw new PiHostError("WORKSPACE_TASK_SCOPE_REQUIRED", "Task Scope directory or Runtime workspace is unavailable");
    }
    if (canonicalWorkspaceCwd !== canonicalTaskCwd) {
      throw new PiHostError(
        "WORKSPACE_TASK_SCOPE_REQUIRED",
        "Non-Worker Runtime workspace must exactly match its Task Scope before Pi Session creation",
        { taskCwd: canonicalTaskCwd, workspaceCwd: canonicalWorkspaceCwd },
      );
    }
  }

  private async runtimePromptContext(identity: RuntimePromptIdentity): Promise<{
    environment: DCodePromptEnvironment;
    documents: Awaited<ReturnType<typeof loadDCodePromptDocuments>>;
    importedHistory: Awaited<ReturnType<ProductStore["importedSessionHistoryProjection"]>>;
    runtimeModelSelection: RuntimeModelSelectionRecord;
  }> {
    const store = await this.getProductStore();
    const snapshot = await store.snapshot();
    const task = snapshot.tasks.find((candidate) => candidate.id === identity.taskId);
    const taskContextSet = snapshot.taskContextSets.find((candidate) => candidate.taskId === identity.taskId);
    const session = snapshot.sessions.find((candidate) => candidate.id === identity.dcodeSessionId);
    const assignment = snapshot.coordinatorAssignments.find((candidate) => (
      candidate.taskId === identity.taskId && candidate.sessionId === identity.dcodeSessionId
    ));
    const childRun = snapshot.agentRuns.find((candidate) => (
      candidate.taskId === identity.taskId
      && candidate.sessionId === identity.dcodeSessionId
      && (identity.agentRunId === undefined || candidate.id === identity.agentRunId)
    ));
    const childAssignment = childRun
      ? snapshot.agentAssignments.find((candidate) => candidate.agentRunId === childRun.id)
      : undefined;
    const profileId = assignment?.profileId ?? childAssignment?.profileId;
    const liveProfile = profileId
      ? snapshot.agentProfiles.find((candidate) => candidate.id === profileId)
      : undefined;
    const storedProfile = typeof childRun?.profileSnapshot === "object"
      && childRun.profileSnapshot !== null
      && !Array.isArray(childRun.profileSnapshot)
      ? childRun.profileSnapshot as Record<string, unknown>
      : undefined;
    const role = typeof storedProfile?.role === "string" ? storedProfile.role : liveProfile?.role;
    const roleContract = typeof storedProfile?.roleContract === "string"
      ? storedProfile.roleContract
      : liveProfile?.roleContract;
    const storedProfileId = typeof storedProfile?.id === "string" ? storedProfile.id : liveProfile?.id;
    const profileVersion = typeof storedProfile?.profileVersion === "number"
      ? storedProfile.profileVersion
      : liveProfile?.profileVersion;
    if (!task || !taskContextSet || !session || !role || !roleContract || !storedProfileId || profileVersion === undefined) {
      throw new PiHostError("RUNTIME_IDENTITY_MISMATCH", "Runtime prompt facts are incomplete in the Product Store");
    }
    const runtimeModelSelection = childRun?.modelProvider && childRun.modelId
      ? {providerId:childRun.modelProvider,modelId:childRun.modelId,sourceKind:"user" as const,revision:childRun.revision}
      : store.sessionModelSelection(session.id)??snapshot.runtimeModelSelection;
    if (!runtimeModelSelection) {
      throw new PiHostError(
        "D_CODE_MODEL_SELECTION_REQUIRED",
        "D Code has no selected Model for future Runtimes; Pi defaults were not used implicitly",
      );
    }
    const catalogEntry = snapshot.modelCatalogEntries.find((candidate) => (
      candidate.providerId === runtimeModelSelection.providerId
      && candidate.modelId === runtimeModelSelection.modelId
    ));
    if (!catalogEntry) {
      throw new PiHostError(
        "D_CODE_MODEL_NOT_IN_CATALOG",
        "D Code selected a Provider / Model pair that is not in its Product Store Catalog",
        { runtimeModelSelection },
      );
    }
    const credentialReference = snapshot.credentialReferences.find((candidate) => (
      candidate.providerId === runtimeModelSelection.providerId && candidate.configured
    ));
    if (!credentialReference || (credentialReference.locator.startsWith("environment:") && !process.env[credentialReference.locator.slice("environment:".length)])) {
      throw new PiHostError(
        "D_CODE_MODEL_AUTH_REQUIRED",
        "D Code has no configured credential reference for the selected Provider",
        { providerId: runtimeModelSelection.providerId },
      );
    }
    let documents: Awaited<ReturnType<typeof loadDCodePromptDocuments>>;
    try {
      documents = await loadDCodePromptDocuments(identity.workspace.cwd, taskContextSet);
    } catch (error) {
      if (error instanceof DCodePromptContextSelectionError) {
        throw new PiHostError(
          "TASK_CONTEXT_UNAVAILABLE",
          "A selected Task Context Source is unavailable; D Code did not start this Runtime",
          { path: error.path, reason: error.reason },
        );
      }
      if (error instanceof DCodePromptCredentialError) {
        throw new PiHostError(
          "TASK_CONTEXT_CREDENTIAL_REJECTED",
          "A Task Context Source appears to contain credential material; D Code did not start this Runtime",
          { path: error.path },
        );
      }
      throw error;
    }
    let importedHistory: Awaited<ReturnType<ProductStore["importedSessionHistoryProjection"]>>;
    try {
      importedHistory = await store.importedSessionHistoryProjection(session.id);
    } catch (error) {
      if (error instanceof ProductStoreError) {
        throw new PiHostError(
          "IMPORTED_HISTORY_UNAVAILABLE",
          "Imported Session history cannot be safely projected; D Code did not start this Runtime",
          { sessionId: session.id, cause: error.code },
        );
      }
      throw error;
    }
    const taskAcceptanceFeedback = role === "coordinator"
      ? snapshot.agentRequests
        .filter((request) => (
          request.taskId === task.id
          && request.sessionId === session.id
          && request.kind === "task_acceptance"
          && request.status === "answered"
          && request.answer?.kind === "task_acceptance"
          && request.answer.outcome === "feedback"
          && typeof request.answer.feedback === "string"
          && request.answer.feedback.trim().length > 0
        ))
        .slice(-3)
        .map((request) => ({
          requestId: request.id,
          feedback: request.answer?.kind === "task_acceptance" ? request.answer.feedback ?? "" : "",
          updatedAt: request.updatedAt,
        }))
      : [];
    return {
      environment: {
        runtimeId: identity.runtimeId,
        scope: identity.scope,
        taskId: task.id,
        taskTitle: task.title,
        taskGoal: task.goal,
        sessionId: session.id,
        sessionKind: session.kind,
        workspaceId: identity.workspace.workspaceId,
        cwd: identity.workspace.cwd,
        workspaceAccess: identity.workspace.access,
        role,
        roleRevision: `${storedProfileId}:v${profileVersion}`,
        roleContract,
        contextRevision: taskContextSet.revision,
        ...(taskAcceptanceFeedback.length > 0 ? { taskAcceptanceFeedback } : {}),
      },
      documents,
      importedHistory,
      runtimeModelSelection,
    };
  }

  private async refreshRuntimePrompt(active: WritableSession): Promise<void> {
    const identity = active.runtimeIdentity;
    if (!identity) return;
    const context = active.currentRun&&active.promptEnvironment&&active.promptDocuments?{environment:{...active.promptEnvironment,workspaceAccess:identity.workspace.access},documents:active.promptDocuments,importedHistory:active.promptImportedHistory}:await this.runtimePromptContext(identity);
    const activeToolNames = active.session.getActiveToolNames();
    const activeToolNameSet = new Set(activeToolNames);
    const tools = active.session.getAllTools()
      .filter((tool) => activeToolNameSet.has(tool.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));
    const toolsWritable = tools.some((tool) => !SHARED_READ_ONLY_TOOL_NAMES.has(tool.name));
    if (identity.workspace.access === "sharedReadOnly" && toolsWritable) {
      throw new PiHostError(
        "WORKSPACE_ISOLATION_REQUIRED",
        "A sharedReadOnly Runtime resolved a write-capable Active Tool Set",
      );
    }
    const assembled = assembleDCodeSystemPrompt({
      environment: {
        ...context.environment,
        ...(active.session.model
          ? { modelProvider: active.session.model.provider, modelId: active.session.model.id }
          : {}),
      },
      documents: context.documents,
      ...(context.importedHistory ? { importedHistory: context.importedHistory } : {}),
      tools,
    });
    active.session.setActiveToolsByName(activeToolNames);
    const internals = active.session as unknown as {
      _baseSystemPrompt: string;
      _systemPromptOverride?: string;
    };
    internals._baseSystemPrompt = assembled.text;
    internals._systemPromptOverride = undefined;
    active.session.agent.state.systemPrompt = assembled.text;
    active.assembledPrompt = assembled;
    active.promptEnvironment = context.environment;
    active.promptDocuments=context.documents;active.promptImportedHistory=context.importedHistory;
    active.activePromptTools = tools;
    active.toolsWritable = toolsWritable;
    if (active.session.systemPrompt !== assembled.text) {
      throw new PiHostError("PROMPT_ASSEMBLY_FAILED", "D Code could not install its System Prompt");
    }
    const manifestNames = [...tools.map((tool) => tool.name)].sort();
    const apiToolNames = [...active.session.getActiveToolNames()].sort();
    if (JSON.stringify(manifestNames) !== JSON.stringify(apiToolNames)) {
      throw new PiHostError("TOOL_MANIFEST_MISMATCH", "D Code Active Tool Manifest does not match API tools");
    }
  }

  private readonly changingProjects=new Set<string>();
  private readonly projectChangeFlights=new Map<string,{projectId:string;fingerprint:string;promise:Promise<unknown>}>();
  private pendingProjectDirectories():string[]{return this.productStore?.projectDirectoryChanges().filter(change=>["prepared","unknown"].includes(change.status)).flatMap(change=>[change.sourceDirectory,change.targetDirectory])??[];}
  private assertProjectAvailable(scope:TaskScope):void {
    if(scope.kind==="project"&&(this.changingProjects.has(scope.projectId)||this.productStore?.projectDirectoryChanges().some(change=>change.projectId===scope.projectId&&["prepared","unknown"].includes(change.status))))throw new PiHostError("PROJECT_DIRECTORY_BUSY","项目目录正在更换或等待恢复，请稍后再继续这个项目");
  }

  private async recoverProjectDirectoryChanges(projectId?:string):Promise<void> {
    const store=await this.getProductStore();
    for(const change of store.projectDirectoryChanges().filter(change=>(!projectId||change.projectId===projectId)&&["prepared","unknown"].includes(change.status))){
      this.changingProjects.add(change.projectId);
      try {
        const position=await directoryPosition(change);
        if(!change.moveFiles||position==="original"){
          await store.finishProjectDirectoryChange(change.id,"cancelled","上次目录更换尚未提交，原项目及文件保持原位");this.changingProjects.delete(change.projectId);continue;
        }
        if(position!=="swapped")throw new Error("目录状态不能确认");
        for(const candidate of change.bindings){const privateRoot=join(store.layout.runtimeDirectory,"pi-sessions");const path=relative(privateRoot,candidate.adapterSessionPath);if(!path||path.startsWith("..")||isAbsolute(path)||await privateSessionDigest(candidate.adapterSessionPath)!==candidate.digest)throw new Error("会话副本不能确认");}
        await store.finishProjectDirectoryChange(change.id,"committed");this.changingProjects.delete(change.projectId);this.searchIndex.invalidate();
      }catch{
        await store.finishProjectDirectoryChange(change.id,"unknown","目录或会话副本发生变化，未覆盖任何现有内容，请核对原目录和目标目录");
      }
    }
    this.options.emit("foundation.changed",{kind:"project.directoryRecovered"});
  }

  private async updateNativeProject(params:Record<string,unknown>):Promise<unknown> {
    const requestId=params.requestId as string;
    const fingerprint=createHash("sha256").update(JSON.stringify({projectId:params.projectId,expectedProjectRevision:params.expectedProjectRevision,title:params.title,directory:params.directory,moveFiles:params.moveFiles})).digest("hex");
    const existing=this.projectChangeFlights.get(requestId);if(existing){if(existing.fingerprint!==fingerprint)throw new PiHostError("IDEMPOTENCY_KEY_REUSED","同一请求不能用于不同的项目修改");return existing.promise;}
    const operation=this.performNativeProjectUpdate(params);this.projectChangeFlights.set(requestId,{projectId:params.projectId as string,fingerprint,promise:operation});
    try{return await operation;}finally{this.projectChangeFlights.delete(requestId);}
  }

  private async performNativeProjectUpdate(params:Record<string,unknown>):Promise<unknown> {
    const store=await this.getProductStore();let snapshot=await store.snapshot();
    if(typeof params.directory!=="string"||!isAbsolute(params.directory))throw new PiHostError("INVALID_ARGUMENT","请选择已有项目文件夹");
    const id=params.projectId as string,title=String(params.title??"").trim(),requestedDirectory=resolve(params.directory);
    if(!title||title.length>200||redactCredentialText(title).redacted)throw new PiHostError("INVALID_ARGUMENT","项目名称无效");
    const previous=store.projectDirectoryChanges().find(change=>change.id===params.requestId);
    if(previous){
      if(previous.projectId!==id||previous.title!==title||previous.requestedDirectory!==requestedDirectory||previous.moveFiles!==(params.moveFiles===true)||previous.expectedProjectRevision!==params.expectedProjectRevision)throw new PiHostError("IDEMPOTENCY_KEY_REUSED","同一请求不能用于不同的目录修改");
      if(previous.status==="prepared"||previous.status==="unknown")await this.recoverProjectDirectoryChanges(id);
      const status=store.projectDirectoryChanges().find(change=>change.id===previous.id)!;
      if(status.status!=="committed")throw new PiHostError("PROJECT_DIRECTORY_NOT_COMMITTED",status.error??"上次目录修改未完成，请重新核对后操作");
      return {project:(await store.snapshot()).projects.find(project=>project.id===id),change:status,replayed:true};
    }
    const project=snapshot.projects.find(project=>project.id===id);if(!project)throw new PiHostError("PROJECT_NOT_FOUND","项目不存在");
    this.assertProjectAvailable({kind:"project",projectId:id});
    if(requestedDirectory===project.directory||await realpath(requestedDirectory)===project.directory){const result=await store.renameProject({requestId:params.requestId as string,projectId:id,expectedProjectRevision:params.expectedProjectRevision as number,title});this.options.emit("foundation.changed",{kind:"project.renamed",storeRevision:result.storeRevision});return result;}
    if(project.revision!==params.expectedProjectRevision)throw new PiHostError("REVISION_CONFLICT","项目刚刚更新，请刷新后重试");
    this.assertProjectAvailable({kind:"project",projectId:id});
    this.changingProjects.add(id);
    const claimId=`project-change:${params.requestId}`;const claimed:string[]=[];
    let change:ProjectDirectoryChange|undefined;
    try {
      const target=await directoryChangeTargets(project.directory,requestedDirectory,params.moveFiles===true);
      if(snapshot.projects.some(other=>other.id!==id&&(other.directory===target.targetDirectory||params.moveFiles===true&&[target.sourceDirectory,target.targetDirectory].some(root=>this.workspacesOverlap(root,other.directory)))))throw new PiHostError("PROJECT_DIRECTORY_OVERLAP","这次更换会影响另一个已登记项目，请使用不重叠的目录");
      const modulePath=fileURLToPath(import.meta.url),applicationRoot=modulePath.match(/^(.+?\.app)(?:\/|$)/u)?.[1]??fileURLToPath(new URL("../../../",import.meta.url));
      const ownedPaths=[store.layout.root,this.agentDir,applicationRoot];
      if(params.moveFiles===true&&(target.sourceDirectory===snapshot.currentUser.homeDirectory||ownedPaths.some(path=>[target.sourceDirectory,target.targetDirectory].some(directory=>this.workspacesOverlap(directory,path)))))throw new PiHostError("PROJECT_DIRECTORY_PROTECTED","源、目标目录不能与运行数据或当前应用重叠，也不能移动用户主目录");
      if(params.moveFiles===true){
        const marker=await lstat(join(target.sourceDirectory,".git")).catch(()=>undefined);
        if(marker?.isFile())throw new PiHostError("PROJECT_WORKTREE_MOVE_UNSUPPORTED","该目录是 Git 工作树，请先通过 Git 完成移动，再更换项目目录");
        if(marker?.isDirectory()){const {stdout}=await promisify(execFileCallback)("git",["--no-optional-locks","-c","core.fsmonitor=false","-c","core.hooksPath=/dev/null","-C",target.sourceDirectory,"worktree","list","--porcelain"],{encoding:"utf8",timeout:10000,maxBuffer:1024*1024});if(stdout.split("\n").filter(line=>line.startsWith("worktree ")).length>1)throw new PiHostError("PROJECT_WORKTREE_MOVE_UNSUPPORTED","这个仓库还有关联工作树，请先处理关联后再移动项目文件");}
      }
      const taskIds=new Set(snapshot.tasks.filter(task=>task.scope.kind==="project"&&task.scope.projectId===id).map(task=>task.id));
      if([...this.openingDCodeSessionIds.keys()].some(sessionId=>snapshot.sessions.some(session=>session.id===sessionId&&taskIds.has(session.taskId))))throw new PiHostError("PROJECT_IS_RUNNING","项目会话仍在启动，请等待收尾后再更换目录");
      if(snapshot.collaborationMessages?.some(message=>taskIds.has(message.taskId)&&["queued","paused","delivering","interrupted","failed"].includes(message.state)))throw new PiHostError("PROJECT_HAS_PENDING_WORK","请先处理这个项目的待发送或中断工作，再更换目录");
      for(const [runtimeId,runtime] of this.runtimes){const identity=runtime.runtimeIdentity;if(!identity)continue;if(taskIds.has(identity.taskId)||[target.sourceDirectory,target.targetDirectory].some(root=>this.workspacesOverlap(root,this.workspaceClaimKey(identity.workspace)))){
        if(runtime.currentRun||runtime.session.isStreaming||runtime.auxiliary?.hasLive||runtime.ui.hasPendingDialogs||this.collaborationDrains.has(identity.dcodeSessionId))throw new PiHostError("PROJECT_IS_RUNNING","相关目录仍有工作运行，请先停止并等待收尾");
        await this.closeRuntime(runtimeId);
      }}
      for(const root of [target.sourceDirectory,target.targetDirectory]){const key=await this.resolveWorkspaceIsolationKey(root);if(this.workspaceConflict(key,claimId,"exclusiveWrite"))throw new PiHostError("WORKSPACE_IN_USE","相关目录正在使用");this.addWorkspaceClaim(this.openingWorkspaceClaims,key,claimId,"exclusiveWrite");claimed.push(key);}
      snapshot=await store.snapshot();const bindings=snapshot.sessionRuntimeBindings.filter(binding=>taskIds.has(binding.taskId)&&binding.cwd===target.sourceDirectory);if(bindings.length>200)throw new PiHostError("PROJECT_MIGRATION_LIMIT","这个项目超过单次会话迁移上限，需要分步处理");
      const candidates:ProjectDirectoryChange["bindings"]=[];
      for(const binding of bindings){const copied=await this.copySession(binding.adapterSessionId,target.targetDirectory,true) as import("./session-copy.js").SessionCopyResult;candidates.push({sessionId:binding.sessionId,previousAdapterId:binding.adapterSessionId,previousBindingRevision:binding.revision,adapterSessionId:copied.target.id,adapterSessionPath:copied.target.path,digest:await privateSessionDigest(copied.target.path)});}
      change={id:params.requestId as string,projectId:id,expectedProjectRevision:project.revision,requestedDirectory,title,...target,moveFiles:params.moveFiles===true,bindings:candidates,status:"prepared"};
      await store.prepareProjectDirectoryChange(change);
      if(change.moveFiles)await swapProjectDirectories(change);
      for(const candidate of candidates)if(await privateSessionDigest(candidate.adapterSessionPath)!==candidate.digest)throw new PiHostError("PROJECT_SESSION_CHANGED","会话副本在提交前发生变化");
      const result=await store.finishProjectDirectoryChange(change.id,"committed");change=result.change;this.searchIndex.invalidate();
      this.options.emit("foundation.changed",{kind:"project.directoryChanged",storeRevision:result.storeRevision});
      return {project:(await store.snapshot()).projects.find(project=>project.id===id),change:result.change};
    }catch(error){
      if(change&&change.status!=="committed"){
        try{
          if(change.moveFiles){const position=await directoryPosition(change);if(position==="unknown")throw new Error("目录位置未知");if(position==="swapped")await swapProjectDirectories(change,true);if(await directoryPosition(change)!=="original")throw new Error("不能确认文件已恢复");}
          await store.finishProjectDirectoryChange(change.id,"cancelled",change.moveFiles?"目录更换未提交，文件已恢复到原位置":"目录更换未提交，未移动项目文件");
        }catch{await store.finishProjectDirectoryChange(change.id,"unknown","目录更换需要核对，未覆盖其他内容").catch(()=>undefined);}
      }
      throw error;
    }finally{
      for(const key of claimed)this.releaseWorkspaceClaim(this.openingWorkspaceClaims,key,claimId);
      if(!store.projectDirectoryChanges().some(change=>change.projectId===id&&["prepared","unknown"].includes(change.status)))this.changingProjects.delete(id);
    }
  }

  private readonly openingLegacyWorkspaces=new Set<string>();
  private readonly closingWorkspaces=new Map<ActiveSession,string>();
  private workspaceFileWrites=new WorkspaceWriteGuard(()=>[
    ...this.openingLegacyWorkspaces, ...this.closingWorkspaces.values(), ...this.pendingProjectDirectories(),
    ...[...this.runtimeWorkspaceClaims].filter(([,claim])=>claim.access==="exclusiveWrite").map(([root])=>root),
    ...this.openingWorkspaceClaims.keys(),
    ...(this.productStore?.auxiliaryProcessExecutions().filter(record=>record.process.status==="unknown").map(record=>record.process.cwd)??[]),
    ...(this.legacyActive?[this.legacyActive.inspection.summary.cwd]:[]),
  ]);
  private workspaceAccess=new WorkspaceAccess(()=>this.getProductStore(),async(root,save)=>{
    const key=await this.resolveWorkspaceIsolationKey(await realpath(root));
    try{return await this.workspaceFileWrites.run(key,save);}finally{this.wakeCollaboration();}
  });

  async handle(method: HostMethod, params: Record<string, unknown>): Promise<unknown> {
    if(method==="project.update")return this.updateNativeProject(params);
    if(method==="project.recover"){if([...this.projectChangeFlights.values()].some(flight=>flight.projectId===params.projectId))throw new PiHostError("PROJECT_DIRECTORY_BUSY","项目目录更换仍在进行，请等待收尾");await this.recoverProjectDirectoryChanges(params.projectId as string);return this.foundationSnapshot(0);}
    if(method.startsWith("workspace."))return this.workspaceAccess.handle(method,params);
    if (method === "dcodeModels.quotas") return this.modelQuotaSnapshot(params);

    if (method === "extension.respond") {
      if (typeof params.runtimeId === "string") {
        return await this.handleRuntimeRequest(method, params);
      }
      return await this.handleExtensionResponse(params);
    }
    if (method === "modelAuth.respond" || method === "modelAuth.cancel") {
      throw new PiHostError(
        "D_CODE_CREDENTIAL_IPC_DISABLED",
        "D Code does not accept credential values or Pi authentication responses through its IPC Protocol",
      );
    }
    if (method === "session.search") {
      return await this.searchIndex.search({
        query: params.query as string,
        requestToken: params.requestToken as string,
        limit: typeof params.limit === "number" ? params.limit : 50,
        projectSourceFolders: params.projectSourceFolders as string[],
        ...(Array.isArray(params.filterSourceFolders)
          ? { filterSourceFolders: params.filterSourceFolders as string[] }
          : {}),
        excludedSessionIds: Array.isArray(params.excludedSessionIds)
          ? params.excludedSessionIds as string[]
          : [],
        refresh: params.refresh === true,
        ...(params.probe === true ? { probe: true } : {}),
      });
    }
    if (typeof params.runtimeId === "string") {
      if (!RUNTIME_SCOPED_METHODS.has(method)) {
        throw new PiHostError("RUNTIME_METHOD_NOT_SCOPED", `Method ${method} cannot be routed to a Runtime`);
      }
      return await this.handleRuntimeRequest(method, params);
    }
    const operation = this.operationQueue.then(() => this.handleSerial(method, params));
    this.operationQueue = operation.then(() => undefined, () => undefined);
    return await operation;
  }

  private async handleRuntimeRequest(method: HostMethod, params: Record<string, unknown>): Promise<unknown> {
    const runtimeId = params.runtimeId;
    if (typeof runtimeId !== "string" || runtimeId.length === 0) {
      throw new PiHostError("RUNTIME_ID_REQUIRED", "A non-empty runtimeId is required");
    }
    const execute = async (): Promise<unknown> => await this.runtimeContext.run(runtimeId, async () => {
      if (method === "extension.respond") return await this.handleExtensionResponse(params);
      return await this.handleSerial(method, params);
    });
    if (RUNTIME_CONTROL_METHODS.has(method)) return await execute();
    const previous = this.runtimeQueues.get(runtimeId) ?? Promise.resolve();
    const operation = previous.then(execute);
    const tail = operation.then(() => undefined, () => undefined);
    this.runtimeQueues.set(runtimeId, tail);
    try {
      return await operation;
    } finally {
      if (this.runtimeQueues.get(runtimeId) === tail) this.runtimeQueues.delete(runtimeId);
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.projectChangeFlights.values()].map(flight=>flight.promise));
    this.collaborationClosing = true;
    clearInterval(this.attachmentSweep);
    await this.maintenance?.close();
    this.modelAuth.close();
    const searchClose = this.searchShutdown ?? this.searchIndex.close();
    this.searchShutdown = searchClose;
    try {
      await this.operationQueue;
      await Promise.all([...this.runtimeQueues.values()]);
      await Promise.all([...this.runtimes.keys()].map(async (runtimeId) => {
        await this.runtimeContext.run(runtimeId, async () => { await this.closeActive(); });
    this.directWorkerRuntimes.delete(runtimeId);
      }));
      await this.closeActive();
    } finally {
      try {
        await searchClose;
      } finally {
        const store = this.productStore
          ?? (this.productStoreOpening ? await this.productStoreOpening.catch(() => undefined) : undefined);
        await store?.close();
      }
    }
  }

  private async handleSerial(method: HostMethod, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "host.hello":
        return {
          protocolVersion: 1,
          hostVersion: HOST_VERSION,
          piVersion: PI_VERSION,
          nodeVersion: process.versions.node,
          capabilities: {
            sessionLease: true,
            onDemandWrite: true,
            extensionDialogs: true,
            extensionCustomHeadless: false,
            extensionWidgets: false,
            structuredPlan: true,
            mermaidUnicode: true,
            projectCwdScope: true,
            contextUsage: true,
            contextBreakdown: true,
            fastMode: true,
            sessionExternalSync: true,
            dcodeSessionOrigin: true,
            sessionSearch: true,
            sessionPaths: true,
            sessionCopy: true,
            sessionCwdRelocation: true,
            sessionTrash: true,
            sessionVisibilityExclusions: true,
            sessionChangeLedger: true,
            sessionRename: true,
            sessionRunCorrelation: true,
            sessionRunState: true,
            sessionRepair: true,
            promptImages: true,
            preSessionModelSelection: true,
            modelSettings: true,
            sessionSteer: true,
            modelAuthentication: true,
            productStore: true,
            nativeTasks: true,
            foundationSnapshot: true,
            dcodeModelCatalog: true,
            taskWorkbenchViewState: true,
            dcodeSessionComposerDrafts: true,
            dcodeSessionPresentation: true,
            managedAttachments: true,
            piSessionImport: true,
            sessionPathFacts: true,
            multiRuntime: true,
            runtimeIdentity: true,
            runtimeEventSequence: true,
            workspaceIsolation: true,
            managedWorkerWorktree: true,
            taskContextSelection: true,
            taskPlanWorkList: true,
            agentRequests: true,
          },
        };
      case "runtime.list":
        return {
          limits: {
            maxActiveRuntimes: MAX_ACTIVE_RUNTIMES,
            maxConcurrentProviderRequests: MAX_ACTIVE_RUNTIMES,
          },
          runtimes: [...this.runtimes.values()].map((runtime) => ({
            identity: runtime.runtimeIdentity,
            sessionId: runtime.session.sessionId,
            state: this.runtimeState(runtime),
            sequence: runtime.runtimeEventSequence,
            systemPromptDigest: runtime.assembledPrompt?.digest ?? null,
            activeToolNames: runtime.activePromptTools.map((tool) => tool.name),
          })),
        };
      case "runtime.start":
        return await this.startDCodeRuntime(params);
      case "foundation.snapshot":
        return await this.foundationSnapshot(
          typeof params.afterEventSequence === "number" ? params.afterEventSequence : 0,
        );
      case "selfEvolution.list": return {receipts:(await this.getProductStore()).webEvolutionReceipts()};
      case "selfEvolution.prepare": {
        if(typeof params.fromApp!=="string"||process.execPath!==join(params.fromApp,"Contents/MacOS/D Code"))throw new PiHostError("EVOLUTION_APP_MISMATCH","重启来源必须是当前运行应用");
        const snapshot=await (await this.getProductStore()).snapshot();
        if(this.openingDCodeSessionIds.size||[...this.runtimes.values()].some(runtime=>runtime.currentRun)||snapshot.sessionRuns.some(r=>["prepared","running","waiting"].includes(r.status))||snapshot.teamRuns.some(r=>["prepared","active","waiting"].includes(r.status))||(await this.maintenance?.status())?.status==="running")throw new PiHostError("HOST_BUSY","请先停止所有运行和维护操作");
        return await (await this.getProductStore()).prepareWebEvolution(params as unknown as Parameters<ProductStore["prepareWebEvolution"]>[0]);
      }
      case "selfEvolution.transition": {
        const store=await this.getProductStore();const receipt=store.webEvolutionReceipts().find(r=>r.id===params.id);
        if(receipt&&(params.state==="session_restored"||params.state==="manual_accepted")&&process.execPath!==join(receipt.toApp,"Contents/MacOS/D Code"))throw new PiHostError("EVOLUTION_APP_MISMATCH","当前应用不是该候选，不能确认其恢复或验收");
        return await store.transitionWebEvolution(params as unknown as Parameters<ProductStore["transitionWebEvolution"]>[0]);
      }
      case "maintenance.status":
      case "maintenance.start": {
        this.maintenance ??= new MaintenanceController(await this.getProductStore(), (event,data)=>this.options.emit(event,data));
        return method === "maintenance.status" ? await this.maintenance.status() : await this.maintenance.start(params.sourceDirectory as string,params.action as "verify"|"build");
      }
      case "clientPreferences.importLegacy":return await (await this.getProductStore()).importLegacyPreferences(params as unknown as Parameters<ProductStore["importLegacyPreferences"]>[0]);
      case "clientPreferences.get": {
        const store=await this.getProductStore();const preferences=store.clientPreferences();const patterns=store.importedSetting("runtime.enabledModels");
        if(preferences.enabledModels===undefined&&Array.isArray(patterns)&&patterns.length&&patterns.every(value=>typeof value==="string")){
          const runtime=await this.sharedModelRuntime();await registerCatalogProviders(runtime,await store.snapshot());
          const resolved=await resolveModelScopeWithDiagnostics(patterns,runtime);
          return {...preferences,enabledModels:resolved.scopedModels.map(({model})=>`${model.provider}::${model.id}`),enabledModelPatterns:patterns};
        }
        return preferences;
      }
      case "clientPreferences.set": {
        const result = await (await this.getProductStore()).setClientPreferences({
          requestId: params.requestId as string, expectedStoreRevision: params.expectedStoreRevision as number,
          ...(typeof params.notificationsEnabled === "boolean" ? { notificationsEnabled: params.notificationsEnabled } : {}),
          ...Object.fromEntries(["appearance", "fontScale", "sidebarVisible", "overviewVisible", "sidebarWidth", "inspectorWidth", "defaultThinking", "enabledModels", "disabledResources"].filter(key => params[key] !== undefined).map(key => [key, params[key]])),
          ...(params.readingPosition ? { readingPosition: params.readingPosition as { sessionId: string; offset: number } } : {}),
        });
        this.options.emit("foundation.changed", { kind: "clientPreferences.updated", storeRevision: result.storeRevision });
        return result;
      }
      case "inspiration.get": return (await this.getProductStore()).inspirationView();
      case "inspiration.mutate": {
        const result=await (await this.getProductStore()).mutateInspiration(params as unknown as Parameters<ProductStore["mutateInspiration"]>[0]);
        this.options.emit("inspiration.changed",{revision:result.view.revision});
        return result;
      }
      case "inspiration.reference": {
        const result=await (await this.getProductStore()).referenceInspiration(params as unknown as Parameters<ProductStore["referenceInspiration"]>[0]);
        this.options.emit("foundation.changed",{kind:"task.context.replaced",storeRevision:result.storeRevision});
        return result;
      }
      case "inspiration.media": return await (await this.getProductStore()).inspirationMedia(params.nodeId as string);
      case "inspiration.export": return await (await this.getProductStore()).inspirationMarkdown(params.nodeId as string);
      case "attachment.import": {
        const result=await (await this.getProductStore()).importAttachment(params as unknown as Parameters<ProductStore["importAttachment"]>[0]);
        this.options.emit("foundation.changed",{storeRevision:result.storeRevision,kind:"attachment.imported"});
        return result;
      }
      case "attachment.get": {
        const value=await (await this.getProductStore()).resolveAttachment(params.id as string);
        return {attachment:value.attachment,...(value.data?{data:value.data}:{})};
      }
      case "attachment.resolve": {
        const value=await (await this.getProductStore()).resolveAttachment(params.id as string);
        return {path:value.path,name:value.attachment.name};
      }
      case "taskDraft.set": {
        const result = await (await this.getProductStore()).setTaskDraft({ requestId: params.requestId as string, expectedStoreRevision: params.expectedStoreRevision as number, scope: params.scope as TaskScope, text: params.text as string, attachmentIds:params.attachmentIds as string[]|undefined });
        this.options.emit("foundation.changed", { kind: "taskDraft.updated", storeRevision: result.storeRevision });
        return result;
      }
      case "dcodeModelProvider.save": {
        const input = catalogProviderInput(params.provider);
        const legacy = (await this.modelProviders().list()).providers.find(p=>p.id===input.id);
        const existing=(await (await this.getProductStore()).snapshot()).modelProviders.find(p=>p.id===input.id);
        if(input.adoptExisting&&!legacy)throw new PiHostError("PROVIDER_SOURCE_NOT_FOUND","找不到可接管的旧供应商配置");
        if(input.keepExistingAuth&&!legacy&&(existing?.nonsecret as {keepExistingAuth?:boolean})?.keepExistingAuth!==true)throw new PiHostError("PROVIDER_AUTH_REFERENCE_REQUIRED","请选择已有认证来源或填写环境变量名称");
        const runtime=await this.sharedModelRuntime();
        const result = await (await this.getProductStore()).seedRuntimeModelCatalog({ requestId: params.requestId as string, expectedStoreRevision: params.expectedStoreRevision as number, ...(input.adoptExisting?{adoptExistingProviderIds:[input.id]}:{}), providers: [await (async()=>{const seed=providerCatalogSeed(input,runtime.getProviderAuthStatus(input.id).configured);if(input.adoptExisting){const metadata=await this.modelProviders().modelMetadata(input.id);seed.models=seed.models.map(model=>({...model,nonsecret:{...metadata[model.modelId],...model.nonsecret as Record<string,unknown>}}));}return seed;})()] });
        this.options.emit("foundation.changed", { kind: "modelProvider.updated", storeRevision: result.storeRevision });
        return result;
      }
      case "dcodeModelProvider.remove": {
        const result = await (await this.getProductStore()).removeCatalogProvider({ requestId: params.requestId as string, expectedStoreRevision: params.expectedStoreRevision as number, providerId: params.providerId as string });
        this.options.emit("foundation.changed", { kind: "modelProvider.removed", storeRevision: result.storeRevision });
        return result;
      }
      case "runtimeModelSelection.set": {
        const result = await (await this.getProductStore()).setRuntimeModelSelection({
          requestId: params.requestId as string,
          expectedStoreRevision: params.expectedStoreRevision as number,
          providerId: params.providerId as string,
          modelId: params.modelId as string,
        });
        this.options.emit("foundation.changed", {
          storeRevision: result.storeRevision,
          kind: "runtimeModelSelection.updated",
          entityKind: "runtimeModelSelection",
          entityId: "runtime.modelSelection",
        });
        return result;
      }
      case "taskWorkbenchViewState.patch": {
        const result = await (await this.getProductStore()).patchTaskWorkbenchViewState({
          requestId: params.requestId as string,
          expectedStoreRevision: params.expectedStoreRevision as number,
          expectedViewStateRevision: params.expectedViewStateRevision as number,
          patch: params.patch as import("./product-store.js").TaskWorkbenchViewStatePatch,
        });
        this.options.emit("foundation.changed", {
          storeRevision: result.storeRevision,
          kind: "taskWorkbenchViewState.updated",
          entityKind: "taskWorkbenchViewState",
          entityId: "workbench.taskViewState",
        });
        return result;
      }
      case "dcodeSession.copy": {
        const store=await this.getProductStore();const sourceSessionId=params.dcodeSessionId as string;
        const replayed=await store.replaySessionCopy(params.requestId as string,sourceSessionId);if(replayed)return replayed;
        const snapshot=await store.snapshot();const source=snapshot.sessions.find(s=>s.id===sourceSessionId);const task=snapshot.tasks.find(t=>t.id===source?.taskId);
        if(!source||!task)throw new PiHostError("DCODE_SESSION_NOT_FOUND","Source task/session does not exist");
        const binding=snapshot.sessionRuntimeBindings.find(b=>b.sessionId===sourceSessionId);
        const runtimeId=this.runtimeByDCodeSessionId.get(sourceSessionId);
        const copied=binding ? await this.runtimeContext.run(runtimeId??"",async()=>await this.copySession(binding.adapterSessionId,task.cwd,true)) as import("./session-copy.js").SessionCopyResult : undefined;
        let result;
        try { result=await store.copyTaskSession({requestId:params.requestId as string,expectedStoreRevision:params.expectedStoreRevision as number,sourceSessionId,...(copied?{adapter:{id:copied.target.id,path:copied.target.path}}:{})}); }
        catch(error) {
          if(copied){
            const current=await store.snapshot();
            if(!current.sessionRuntimeBindings.some(b=>b.adapterSessionId===copied.target.id)){
              const lease=await SessionLease.acquire({agentDir:this.leaseAgentDir,sessionId:copied.target.id,sessionPath:copied.target.path,quietWindowMs:this.leaseQuietWindowMs});
              try{await lease.assertUnchanged();await unlink(copied.target.path);}finally{await lease.release();}
            }
          }
          throw error;
        }
        this.options.emit("foundation.changed",{kind:"dcodeSession.copied",storeRevision:result.storeRevision,taskId:result.task.id});return result;
      }
      case "dcodeSession.commands":return this.dcodeCommands(params.dcodeSessionId as string|undefined,params.projectId as string|undefined);
      case "dcodeSession.presentation":
        return sanitizeRuntimeValue(await this.dcodeSessionPresentation(params.dcodeSessionId as string,params.pathId as string|undefined));
      case "dcodeSession.composerDraft.set": {
        const result = await (await this.getProductStore()).setDCodeSessionComposerDraft({
          requestId: params.requestId as string,
          expectedStoreRevision: params.expectedStoreRevision as number,
          taskId: params.taskId as string,
          sessionId: params.dcodeSessionId as string,
          text: params.text as string,
          targetAgentRunId: params.targetAgentRunId as string|null|undefined,
          pathAction:params.pathAction as import("./product-store.js").NativeSessionPathAction|null|undefined,
          pathDraftBackup:params.pathDraftBackup as import("./product-store.js").ComposerDraftRecord["pathDraftBackup"]|null|undefined,
          attachmentIds:params.attachmentIds as string[]|undefined,
        });
        this.options.emit("foundation.changed", {
          storeRevision: result.storeRevision,
          kind: result.composerDraft ? "dcodeSession.composerDraft.saved" : "dcodeSession.composerDraft.cleared",
          entityKind: "composerDraft",
          entityId: result.composerDraft?.id ?? `composer-draft:${params.dcodeSessionId as string}`,
          taskId: params.taskId as string,
        });
        return result;
      }
      case "collaboration.messageEdit": {
        const result=await (await this.getProductStore()).editCollaborationMessage(params as Parameters<ProductStore["editCollaborationMessage"]>[0]);
        this.options.emit("foundation.changed",{kind:"collaboration.messageChanged",storeRevision:result.storeRevision,taskId:result.message.taskId});return result;
      }
      case "collaboration.queueReorder": {
        const result=await (await this.getProductStore()).reorderCollaborationMessages(params as Parameters<ProductStore["reorderCollaborationMessages"]>[0]);
        this.options.emit("foundation.changed",{kind:"collaboration.queueOrdered",storeRevision:result.storeRevision});return result;
      }
      case "collaboration.messageControl": {
        const result=await (await this.getProductStore()).transitionCollaborationMessage({requestId:params.requestId as string,id:params.id as string,expectedRevision:params.expectedRevision as number,state:params.state as "queued"|"paused"|"cancelled"});
        this.options.emit("foundation.changed",{kind:"collaboration.messageChanged",storeRevision:result.storeRevision,taskId:result.message.taskId});
        if(result.message.state==="queued") void this.drainCollaboration(result.message.targetSessionId);
        return result;
      }
      case "dcodeSession.prompt":
        return await this.promptDCodeSession({
          dcodeSessionId: params.dcodeSessionId as string,
          targetAgentRunId: params.targetAgentRunId as string|undefined,
          deliveryMode:params.deliveryMode as "steer"|undefined,
          expectedSessionRunId:params.expectedSessionRunId as string|undefined,
          pathAction:params.pathAction as import("./product-store.js").NativeSessionPathAction|undefined,
          promptId: params.promptId as string,
          message: params.message as string,
          attachmentIds:params.attachmentIds as string[]|undefined,
          ...(Array.isArray(params.images) ? { images: params.images as PromptImageInput[] } : {}),
        });
      case "project.create": {
        const result = await (await this.getProductStore()).createProject({
          requestId: params.requestId as string,
          expectedStoreRevision: params.expectedStoreRevision as number,
          title: params.title as string,
          directory: params.directory as string,
        });
        this.options.emit("foundation.changed", {
          storeRevision: result.storeRevision,
          kind: "project.created",
          entityKind: "project",
          entityId: result.project.id,
        });
        return result;
      }
      case "workspace.describe": case "workspace.tree": case "workspace.read": case "workspace.asset": case "workspace.preview": case "workspace.save": case "workspace.git": case "workspace.diff": case "workspace.reference": return this.workspaceAccess.handle(method,params);
      case "project.gitBranch":
        return await this.projectGitBranch(params.projectId as string);
      case "task.manage": {
        if(params.action!=="rename"&&[...this.runtimes.values()].some(runtime=>runtime.runtimeIdentity?.taskId===params.taskId&&runtime.currentRun))throw new PiHostError("TASK_BUSY","该任务仍在收尾，请稍后再归档或恢复");
        const result = await (await this.getProductStore()).manageTask({requestId:params.requestId as string,expectedStoreRevision:params.expectedStoreRevision as number,taskId:params.taskId as string,action:params.action as "rename"|"archive"|"restore"|"trash",...(typeof params.title === "string" ? {title:params.title} : {})});
        this.options.emit("foundation.changed",{kind:"task.updated",storeRevision:result.storeRevision,taskId:result.task.id});
        return result;
      }
      case "task.create": {
        this.assertProjectAvailable(params.scope as TaskScope);
        const result = await (await this.getProductStore()).createTask({
          requestId: params.requestId as string,
          expectedStoreRevision: params.expectedStoreRevision as number,
          scope: params.scope as TaskScope,
          title: params.title as string,
          goal: params.goal as string,
          ...(Array.isArray(params.acceptance) ? { acceptance: params.acceptance as string[] } : {}),
        });
        this.options.emit("foundation.changed", {
          storeRevision: result.storeRevision,
          kind: "task.created",
          entityKind: "task",
          entityId: result.task.id,
          taskId: result.task.id,
          scope: result.task.scope,
        });
        return result;
      }
      case "task.context.inspectFiles":return this.inspectTaskContextFiles(params.taskId as string,params.paths as string[]);
      case "sessionRun.inputs":return (await this.getProductStore()).sessionRunInputs(params.taskId as string,params.sessionRunId as string);
      case "task.context.replace": {
        const result = await (await this.getProductStore()).replaceTaskContext({
          requestId: params.requestId as string,
          expectedStoreRevision: params.expectedStoreRevision as number,
          taskId: params.taskId as string,
          scope: params.scope as TaskScope,
          expectedContextRevision: params.expectedContextRevision as number,
          sources: params.sources as TaskContextSourceInput[],
        });
        this.options.emit("foundation.changed", {
          storeRevision: result.storeRevision,
          kind: "task.contextSelection.replaced",
          entityKind: "taskContextSet",
          entityId: result.contextSet.taskId,
          taskId: result.contextSet.taskId,
        });
        return result;
      }
      case "task.plan.create": {
        const result = await (await this.getProductStore()).createTaskPlan({
          requestId: params.requestId as string,
          expectedStoreRevision: params.expectedStoreRevision as number,
          taskId: params.taskId as string,
          scope: params.scope as TaskScope,
          ...(params.state === undefined ? {} : { state: params.state as TaskPlanState }),
          document: params.document as Record<string, unknown>,
        });
        this.options.emit("foundation.changed", {
          storeRevision: result.storeRevision,
          kind: "taskPlan.created",
          entityKind: "taskPlan",
          entityId: result.taskPlan.id,
          taskId: result.taskPlan.taskId,
        });
        return result;
      }
      case "task.plan.update": {
        const result = await (await this.getProductStore()).updateTaskPlan({
          requestId: params.requestId as string,
          expectedStoreRevision: params.expectedStoreRevision as number,
          taskId: params.taskId as string,
          scope: params.scope as TaskScope,
          planId: params.planId as string,
          expectedPlanRevision: params.expectedPlanRevision as number,
          state: params.state as TaskPlanState,
          document: params.document as Record<string, unknown>,
        });
        this.options.emit("foundation.changed", {
          storeRevision: result.storeRevision,
          kind: "taskPlan.updated",
          entityKind: "taskPlan",
          entityId: result.taskPlan.id,
          taskId: result.taskPlan.taskId,
        });
        return result;
      }
      case "task.workItem.create": {
        const result = await (await this.getProductStore()).createTaskWorkItem({
          requestId: params.requestId as string,
          expectedStoreRevision: params.expectedStoreRevision as number,
          taskId: params.taskId as string,
          scope: params.scope as TaskScope,
          title: params.title as string,
          ...(params.state === undefined ? {} : { state: params.state as TaskWorkItemState }),
          ...(params.ownerAssignmentId === undefined ? {} : { ownerAssignmentId: params.ownerAssignmentId as string | null }),
          ...(params.details === undefined ? {} : { details: params.details }),
        });
        this.options.emit("foundation.changed", {
          storeRevision: result.storeRevision,
          kind: "taskWorkItem.created",
          entityKind: "taskWorkItem",
          entityId: result.taskWorkItem.id,
          taskId: result.taskWorkItem.taskId,
        });
        return result;
      }
      case "task.workItem.update": {
        const result = await (await this.getProductStore()).updateTaskWorkItem({
          requestId: params.requestId as string,
          expectedStoreRevision: params.expectedStoreRevision as number,
          taskId: params.taskId as string,
          scope: params.scope as TaskScope,
          workItemId: params.workItemId as string,
          expectedWorkItemRevision: params.expectedWorkItemRevision as number,
          ...(params.title === undefined ? {} : { title: params.title as string }),
          ...(params.state === undefined ? {} : { state: params.state as TaskWorkItemState }),
          ...(params.ownerAssignmentId === undefined ? {} : { ownerAssignmentId: params.ownerAssignmentId as string | null }),
          ...(params.details === undefined ? {} : { details: params.details }),
        });
        this.options.emit("foundation.changed", {
          storeRevision: result.storeRevision,
          kind: "taskWorkItem.updated",
          entityKind: "taskWorkItem",
          entityId: result.taskWorkItem.id,
          taskId: result.taskWorkItem.taskId,
        });
        return result;
      }
      case "task.workItem.reorder": {
        const result = await (await this.getProductStore()).reorderTaskWorkItems({
          requestId: params.requestId as string,
          expectedStoreRevision: params.expectedStoreRevision as number,
          taskId: params.taskId as string,
          scope: params.scope as TaskScope,
          items: params.items as Array<{ id: string; expectedRevision: number }>,
        });
        this.options.emit("foundation.changed", {
          storeRevision: result.storeRevision,
          kind: "taskWorkItem.reordered",
          entityKind: "task",
          entityId: params.taskId as string,
          taskId: params.taskId as string,
        });
        return result;
      }
      case "task.acceptance": {
        const feedback = typeof params.feedback === "string" ? params.feedback : undefined;
        if (feedback && redactCredentialText(feedback).redacted) {
          throw new PiHostError(
            "CREDENTIAL_MATERIAL_REJECTED",
            "D Code 检测到反馈中可能包含凭据。请移除密钥、Token 或密码。",
          );
        }
        const result = await (await this.getProductStore()).respondTaskAcceptance({
          requestId: params.requestId as string,
          expectedStoreRevision: params.expectedStoreRevision as number,
          taskId: params.taskId as string,
          scope: params.scope as TaskScope,
          expectedTaskRevision: params.expectedTaskRevision as number,
          agentRequestId: params.agentRequestId as string,
          expectedRequestRevision: params.expectedRequestRevision as number,
          ...(typeof params.teamRunId === "string" ? { teamRunId: params.teamRunId } : {}),
          agentRunId: params.agentRunId as string,
          sessionRunId: params.sessionRunId as string,
          runtimeId: params.runtimeId as string,
          ...(feedback === undefined ? {} : { feedback }),
        });
        const pending = this.pendingAgentRequests.get(result.agentRequest.id);
        let deliveredToRuntime = false;
        if (pending) {
          this.pendingAgentRequests.delete(result.agentRequest.id);
          pending.removeAbortListener?.();
          const runtime = this.runtimes.get(pending.runtimeId);
          if (runtime?.currentRun?.sessionRunId === result.agentRequest.sessionRunId) {
            this.updateRunState(runtime, runtime.currentRun, "running");
          }
          pending.resolve(result.agentRequest.answer);
          deliveredToRuntime = true;
        }
        const acceptanceAnswer = result.agentRequest.answer;
        this.options.emit("foundation.changed", {
          storeRevision: result.storeRevision,
          kind: acceptanceAnswer?.kind === "task_acceptance" && acceptanceAnswer.outcome === "accepted"
            ? "task.accepted"
            : "task.acceptanceFeedback",
          entityKind: "task",
          entityId: result.task.id,
          taskId: result.task.id,
        });
        return { ...result, deliveredToRuntime };
      }
      case "team.create":
      case "team.start":
        throw new PiHostError("COORDINATOR_REQUIRED","旧团队入口已停用，请在任务主对话中交办，由协调者按需创建成员");
      case "agentRequest.answer": {
        const serializedAnswer = JSON.stringify(params.answer);
        if (redactCredentialText(serializedAnswer).redacted) {
          throw new PiHostError(
            "CREDENTIAL_MATERIAL_REJECTED",
            "D Code 检测到回答中可能包含凭据。请移除密钥、Token 或密码。",
          );
        }
        const result = await (await this.getProductStore()).answerAgentRequest({
          requestId: params.requestId as string,
          expectedStoreRevision: params.expectedStoreRevision as number,
          agentRequestId: params.agentRequestId as string,
          expectedRequestRevision: params.expectedRequestRevision as number,
          taskId: params.taskId as string,
          scope: params.scope as TaskScope,
          ...(typeof params.teamRunId === "string" ? { teamRunId: params.teamRunId } : {}),
          agentRunId: params.agentRunId as string,
          sessionRunId: params.sessionRunId as string,
          runtimeId: params.runtimeId as string,
          answer: params.answer as { kind: "choice"; optionId: string },
        });
        const pending = this.pendingAgentRequests.get(result.agentRequest.id);
        let deliveredToRuntime = false;
        if (pending) {
          this.pendingAgentRequests.delete(result.agentRequest.id);
          pending.removeAbortListener?.();
          const runtime = this.runtimes.get(pending.runtimeId);
          if (runtime?.currentRun?.sessionRunId === result.agentRequest.sessionRunId) {
            this.updateRunState(runtime, runtime.currentRun, "running");
          }
          pending.resolve(result.agentRequest.answer);
          deliveredToRuntime = true;
        }
        this.options.emit("foundation.changed", {
          storeRevision: result.storeRevision,
          kind: "agentRequest.answered",
          entityKind: "agentRequest",
          entityId: result.agentRequest.id,
          taskId: result.agentRequest.taskId,
        });
        return { ...result, deliveredToRuntime };
      }
      case "agentProcess.stopAuxiliary": {
        const store=await this.getProductStore(),record=store.auxiliaryProcessExecutions().find(item=>item.process.id===params.processId&&item.taskId===params.taskId&&item.agentRunId===params.agentRunId);
        if(!record)throw new PiHostError("PROCESS_NOT_FOUND","后台活动不属于所选任务和成员");
        if(record.process.status==="exited")return {stopped:true};
        const runtime=this.runtimes.get(record.runtimeId);if(!runtime?.auxiliary)throw new PiHostError("PROCESS_NOT_OWNED","该活动来自上次运行，当前无法确认控制权，请先核对进程状态");
        await runtime.auxiliary.stop(record.process.id);return {stopped:true};
      }
      case "agentRun.stop":
        return await this.stopAgentRun(params);
      case "agentProfile.update": {
        const result = await (await this.getProductStore()).updateAgentProfile({
          requestId: params.requestId as string,
          expectedStoreRevision: params.expectedStoreRevision as number,
          profileId: params.profileId as string,
          expectedProfileRevision: params.expectedProfileRevision as number,
          name: params.name as string,
          roleContract: params.roleContract as string,
          enabled: params.enabled as boolean,
          ...(params.modelCandidates !== undefined ? { modelCandidates: params.modelCandidates as AgentModelCandidate[] | null } : {}),
        });
        this.options.emit("foundation.changed", {
          storeRevision: result.storeRevision,
          kind: "agentProfile.updated",
          entityKind: "agentProfile",
          entityId: result.agentProfile.id,
        });
        return result;
      }
      case "agentProfile.create": {
        const result = await (await this.getProductStore()).createAgentProfile({
          requestId: params.requestId as string,
          expectedStoreRevision: params.expectedStoreRevision as number,
          name: params.name as string,
          roleContract: params.roleContract as string,
          enabled: params.enabled as boolean,
          ...(params.modelCandidates !== undefined ? { modelCandidates: params.modelCandidates as AgentModelCandidate[] | null } : {}),
        });
        this.options.emit("foundation.changed", {
          storeRevision: result.storeRevision,
          kind: "agentProfile.created",
          entityKind: "agentProfile",
          entityId: result.agentProfile.id,
        });
        return result;
      }
      case "piImport.listCandidates": {
        const store = await this.getProductStore();
        const snapshot = await store.snapshot();
        return {
          candidates: await listPiImportCandidates(
            this.reader,
            snapshot.piImports,
            typeof params.limit === "number" ? params.limit : 200,
          ),
        };
      }
      case "piImport.preview": {
        const store = await this.getProductStore();
        const snapshot = await store.snapshot();
        const prepared = await preparePiSessionImport(
          this.reader,
          params.sourceSessionId as string,
          snapshot.piImports,
        );
        return prepared.preview;
      }
      case "piImport.importAsTask": {
        const store = await this.getProductStore();
        const replayed = await store.replayPiImportRequest({
          requestId: params.requestId as string,
          scope: params.scope as TaskScope,
          sourceSessionId: params.sourceSessionId as string,
        });
        if (replayed) return replayed;
        const snapshot = await store.snapshot();
        const prepared = await preparePiSessionImport(
          this.reader,
          params.sourceSessionId as string,
          snapshot.piImports,
        );
        const result = await store.importPiSessionAsTask({
          requestId: params.requestId as string,
          expectedStoreRevision: params.expectedStoreRevision as number,
          scope: params.scope as TaskScope,
          sourceSessionId: prepared.preview.sourceSessionId,
          sourcePath: prepared.preview.sourcePath,
          sourceDigest: prepared.preview.sourceDigest,
          historicalCwd: prepared.preview.cwd,
          title: prepared.preview.title,
          entries: prepared.entries,
          paths: prepared.paths,
          conversionEvidence: prepared.conversionEvidence,
        });
        this.options.emit("foundation.changed", {
          storeRevision: result.storeRevision,
          kind: "piImport.completed",
          entityKind: "task",
          entityId: result.task.id,
          taskId: result.task.id,
          scope: result.task.scope,
          sourceSessionId: result.piImport.sourceSessionId,
        });
        return result;
      }
      case "session.importedEntries": {
        const entries = await (await this.getProductStore()).importedSessionEntries(params.sessionId as string);
        return { entries };
      }
      case "session.list":
        return {
          sessions: await this.reader.list({
            ...(typeof params.query === "string" ? { query: params.query } : {}),
            ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
            ...(typeof params.cwdScope === "object" && params.cwdScope !== null
              ? { cwdScope: params.cwdScope as SessionCwdScope }
              : {}),
            ...(params.origin === "dcode" ? { origin: params.origin as SessionOrigin } : {}),
            ...(Array.isArray(params.sessionIds) ? { sessionIds: params.sessionIds as string[] } : {}),
            ...(Array.isArray(params.excludedSessionIds)
              ? { excludedSessionIds: params.excludedSessionIds as string[] }
              : {}),
          }),
        };
      case "session.inspect":
        return await this.reader.inspect(
          params.sessionId as string,
          leafIdForPathId(params.pathId),
        );
      case "session.refresh":
        return await this.refreshActiveSession();
      case "content.renderMermaid":
        return this.renderMermaid(params.source as string);
      case "session.create":
        return await this.createSession(params.cwd as string);
      case "session.copy":
        return await this.copySession(params.sessionId as string, params.targetCwd as string);
      case "session.relocateCwd":
        return await this.relocateSessionCwd(
          params.sourceCwd as string,
          params.targetCwd as string,
          params.moveFiles as boolean,
        );
      case "session.trash":
        return await this.trashSession(params.sessionId as string);
      case "session.repair":
        return await this.reader.repair(params.sessionId as string);
      case "session.open":
        {
          const identity = this.runtimeIdentityFromParams(params);
          if (identity) {
            await this.validateRuntimeIdentity(identity, params.sessionId as string);
            const existing = this.active;
            if (existing) {
              if (JSON.stringify(existing.runtimeIdentity) !== JSON.stringify(identity)) {
                throw new PiHostError("RUNTIME_ID_CONFLICT", "runtimeId is already bound to a different identity");
              }
              return {
                mode: "writable" as const,
                snapshot: existing.inspection,
                state: this.getState(),
                extensions: { loaded: 0, errors: [] },
                reused: true,
              };
            }
            const adapterOwner = this.runtimeByAdapterSessionId.get(identity.adapterSessionId)
              ?? this.openingAdapterSessionIds.get(identity.adapterSessionId);
            if (adapterOwner && adapterOwner !== identity.runtimeId) {
              throw new PiHostError(
                "ADAPTER_SESSION_ALREADY_ACTIVE",
                "The Pi adapter session is already owned by another Runtime",
                { adapterSessionId: identity.adapterSessionId, runtimeId: adapterOwner },
              );
            }
            const dcodeSessionOwner = this.runtimeByDCodeSessionId.get(identity.dcodeSessionId)
              ?? this.openingDCodeSessionIds.get(identity.dcodeSessionId);
            if (dcodeSessionOwner && dcodeSessionOwner !== identity.runtimeId) {
              throw new PiHostError(
                "SESSION_ALREADY_ACTIVE",
                "The D Code Session is already owned by another Runtime",
                { dcodeSessionId: identity.dcodeSessionId, runtimeId: dcodeSessionOwner },
              );
            }
          }
          return await this.openSessionWithRepairHint(
            params.sessionId as string,
            typeof params.expectedEntryId === "string" ? params.expectedEntryId : undefined,
            typeof params.expectedEntryDigest === "string" ? params.expectedEntryDigest : undefined,
            leafIdForPathId(params.pathId),
            identity,
          );
        }
      case "session.close":
        if (typeof params.expectedSessionId === "string"
          && this.active?.inspection.summary.id !== params.expectedSessionId) {
          throw new PiHostError(
            "SESSION_ACTIVE_CHANGED",
            "The active session changed before it could be closed",
            {
              expectedSessionId: params.expectedSessionId,
              activeSessionId: this.active?.inspection.summary.id ?? null,
            },
          );
        }
        await this.closeActive();
        return { closed: true };
      case "session.prompt":
        return await this.prompt(
          params.message as string,
          params.promptId as string,
          typeof params.pathAction === "object" && params.pathAction !== null
            ? params.pathAction as unknown as SessionPathAction
            : undefined,
          params.images as PromptImageInput[] | undefined,
          params.attachmentIds as string[] | undefined,
        );
      case "session.steer":
        return await this.steer(
          params.message as string,
          params.steerId as string,
          params.expectedRunId as string,
          params.images as PromptImageInput[] | undefined,
        );
      case "session.abort": {
        const active = this.requireWritable();
        if(active.currentRun?.persistenceFailed)throw new PiHostError("RESULT_SAVE_FAILED","本轮已结束但结果尚未保存，请重新连接后核对");
        if(active.runtimeIdentity) {
          const store=await this.getProductStore();
          for(const message of store.collaborationMessages(active.runtimeIdentity.taskId).filter(message=>message.targetSessionId===active.runtimeIdentity!.dcodeSessionId&&message.state==="queued")) await store.transitionCollaborationMessage({requestId:`stop-queue:${message.id}:${message.revision}`,id:message.id,expectedRevision:message.revision,state:"paused"});
        }
        if (active.currentRun) this.updateRunState(active, active.currentRun, "stopRequested");
        try {
          await Promise.all([active.auxiliary?.stopAll(),active.session.abort()]);
          return { aborted: true };
        } catch (error) {
          if (active.currentRun) {
            this.updateRunState(active, active.currentRun, "unknown", {
              retryable: false,
            });
          }
          throw error;
        }
      }
      case "session.getState":
        return this.getState();
      case "session.contextBreakdown":
        return this.getContextBreakdown();
      case "session.getCommands":
        return this.getCommands();
      case "resources.list":
        return await this.listResources();
      case "session.compactionInfo":
        return await this.getCompactionInfo();
      case "session.compact":
        return await this.compactSession();
      case "dcodeModels.get": return await this.dcodeModelsView(params.dcodeSessionId as string | undefined);
      case "dcodeModels.refresh": {
        const runtime=await this.sharedModelRuntime();
        const offline=process.env.PI_OFFLINE !== undefined;
        const controller=new AbortController();
        const timeout=setTimeout(()=>controller.abort(),12000);
        try {
          await registerCatalogProviders(runtime,await (await this.getProductStore()).snapshot());
          const result=await runtime.refresh({allowNetwork:!offline,force:params.force === true,signal:controller.signal});
          this.modelRefreshState={updatedAt:!offline&&!result.aborted?new Date().toISOString():undefined,failedProviders:[...result.errors.keys()],offline};
          await this.ensureDCodeRuntimeModelCatalog(true);
          this.options.emit("foundation.changed",{kind:"runtimeModelCatalog.updated"});
        } finally {clearTimeout(timeout);}
        return await this.dcodeModelsView(params.dcodeSessionId as string | undefined);
      }
      case "dcodeModels.select":
      case "dcodeModels.setThinking": {
        const store=await this.getProductStore();
        const sessionId=params.dcodeSessionId as string | undefined;
        if(sessionId){const session=(await store.snapshot()).sessions.find(s=>s.id===sessionId);if(!session||session.state==="archived")throw new PiHostError("SESSION_NOT_AVAILABLE","会话不存在或已归档");}
        const selectionInput=sessionId&&method==="dcodeModels.select"?{requestId:params.requestId as string,sessionId,providerId:params.providerId as string,modelId:params.modelId as string}:undefined;
        if(selectionInput&&await store.replaySessionModelSelection(selectionInput))return this.dcodeModelsView(sessionId);
        const runtimeId=sessionId?this.runtimeByDCodeSessionId.get(sessionId):undefined;
        if(runtimeId){const active=this.runtimes.get(runtimeId);if(active)this.assertSessionMetadataIdle(active);}
        const view=await this.dcodeModelsView(sessionId);
        if(method === "dcodeModels.select"){
          const model=view.models.find(m=>m.providerId===params.providerId&&m.modelId===params.modelId);
          if(!model?.available)throw new PiHostError("MODEL_NOT_AVAILABLE","模型尚未连接，请刷新连接或配置供应商");
          if(!model.enabled)throw new PiHostError("MODEL_DISABLED","该模型已停用，请先在模型设置中启用");
        } else if(!view.thinkingLevels.includes(params.level as string))throw new PiHostError("THINKING_NOT_SUPPORTED","当前模型不支持这个思考强度");
        if(runtimeId && sessionId) {
          const command=await store.prepareRuntimeModelControl({requestId:params.requestId as string,expectedStoreRevision:params.expectedStoreRevision as number,method,sessionId,runtimeId,values:method==="dcodeModels.select"?{providerId:params.providerId,modelId:params.modelId}:{level:params.level}});
          if(command.replayed){
            const attempt=(await store.snapshot()).operationAttempts.find(a=>a.id===command.attemptId);
            if(attempt?.status!=="succeeded")throw new PiHostError("MODEL_COMMAND_UNKNOWN","上次选择未确认完成，请重新选择模型");
            return await this.dcodeModelsView(sessionId);
          }
          try {
            const active=this.runtimes.get(runtimeId);
            if(active)await registerCatalogProviders(active.session.modelRuntime,await store.snapshot());
            if(method==="dcodeModels.select")await this.handleRuntimeRequest("session.setModel",{runtimeId,provider:params.providerId,modelId:params.modelId});
            else await this.handleRuntimeRequest("session.setThinking",{runtimeId,level:params.level});
            if(selectionInput)await store.setSessionModelSelection(selectionInput);
            await store.finishOperationAttempt({attemptId:command.attemptId,outcome:"succeeded"});
          } catch(error){await store.finishOperationAttempt({attemptId:command.attemptId,outcome:"unknown"});throw error;}
        } else if(selectionInput)await store.setSessionModelSelection(selectionInput);
        else if(method === "dcodeModels.select")await store.setRuntimeModelSelection({requestId:params.requestId as string,expectedStoreRevision:params.expectedStoreRevision as number,providerId:params.providerId as string,modelId:params.modelId as string});
        else await store.setClientPreferences({requestId:params.requestId as string,expectedStoreRevision:params.expectedStoreRevision as number,defaultThinking:params.level as string});
        this.options.emit("foundation.changed",{kind:"runtimeModelSelection.updated"});
        return await this.dcodeModelsView(sessionId);
      }
      case "modelProviders.list":
        return await this.modelProviders().list();
      case "modelProviders.save":
      case "modelProviders.remove":
        throw new PiHostError(
          "D_CODE_MODEL_CONFIGURATION_REPLACED",
          "Pi models.json is no longer a writable D Code Product configuration; use the D Code Model Catalog and secure credential setup",
        );
      case "resources.setPackageEnabled":
        return await this.setPackageEnabled(
          params.source as string,
          params.enabled === true,
        );
      case "session.getModels":
        return await this.getModels(typeof params.cwd === "string" ? params.cwd : undefined);
      case "modelSettings.get":
        return await this.getModelSettings(params.cwd as string, false);
      case "modelSettings.refresh":
        return await this.getModelSettings(params.cwd as string, true);
      case "modelSettings.setEnabledModels":
      case "modelSettings.setDefaultModel":
        throw new PiHostError(
          "D_CODE_MODEL_CONFIGURATION_REPLACED",
          "Pi settings.json is no longer a writable D Code Model configuration; select the future Runtime Model in the D Code Product Store",
        );
      case "modelAuth.start":
        throw new PiHostError(
          "D_CODE_CREDENTIAL_IPC_DISABLED",
          "D Code credential setup must use a secure external reference; Pi interactive authentication is not exposed through D Code IPC",
        );
      case "session.getThinkingLevels":
        return this.getThinkingLevels();
      case "session.setModel":
        return await this.setModel(params.provider as string, params.modelId as string);
      case "session.setName":
        return await this.setSessionName(params.name as string);
      case "session.setThinking": {
        const active = this.requireWritable();
        await this.beforeMutation(active);
        const level = await this.withOwnedMutation(active, async () => {
          active.session.setThinkingLevel(params.level as ThinkingLevel);
          return active.session.thinkingLevel;
        });
        return { level };
      }
      case "session.setFastMode":
        return await this.setFastMode(params.enabled as boolean);
      case "dcodeModels.quotas":
        return this.modelQuotaSnapshot(params);
      case "host.shutdown":
        if(params.requireIdle===true){
          const snapshot=await (await this.getProductStore()).snapshot();
          if(this.openingDCodeSessionIds.size>0||[...this.runtimes.values()].some(runtime=>runtime.currentRun)||snapshot.sessionRuns.some(run=>["prepared","running","waiting"].includes(run.status))||snapshot.teamRuns.some(run=>["prepared","active","waiting"].includes(run.status))||(await this.maintenance?.status())?.status==="running")throw new PiHostError("HOST_BUSY","还有任务或维护操作正在运行，请先停止后重启服务");
        }
        this.shutdownRequested = true;
        this.searchShutdown ??= this.searchIndex.close();
        void this.searchShutdown.catch(() => undefined);
        return { shuttingDown: true };
      case "extension.respond":
      case "modelAuth.respond":
      case "modelAuth.cancel":
        throw new PiHostError("INTERNAL_ERROR", "Extension method was not routed correctly");
      case "session.search":
        throw new PiHostError("INTERNAL_ERROR", "Search method was not routed correctly");
    }
  }

  private async handleExtensionResponse(params: Record<string, unknown>): Promise<unknown> {
    const active = this.requireWritable();
    const accepted = active.ui.respond(params.requestId as string, params.response);
    if (!accepted) throw new PiHostError("UI_REQUEST_NOT_FOUND", `Extension request not found: ${params.requestId as string}`);
    return { accepted };
  }

  private async stopAgentRun(params: Record<string, unknown>): Promise<unknown> {
    if(this.active?.currentRun?.persistenceFailed)throw new PiHostError("RESULT_SAVE_FAILED","本轮已结束但结果尚未保存，停止不能替代保存或改写执行结果");
    const store = await this.getProductStore();
    const prepared = await store.prepareAgentRunStop({
      requestId: params.requestId as string,
      expectedStoreRevision: params.expectedStoreRevision as number,
      scope: params.scope as TaskScope,
      taskId: params.taskId as string,
      ...(typeof params.teamRunId === "string" ? { teamRunId: params.teamRunId } : {}),
      agentRunId: params.agentRunId as string,
      sessionRunId: params.sessionRunId as string,
      runtimeId: params.runtimeId as string,
      expectedAgentRunRevision: params.expectedAgentRunRevision as number,
    });
    const afterPrepare = await store.snapshot();
    const durableAttempt = afterPrepare.operationAttempts.find((attempt) => attempt.id === prepared.attemptId);
    if (durableAttempt?.status === "succeeded") {
      return { stopped: true, attemptId: prepared.attemptId, storeRevision: afterPrepare.storeRevision, replayed: true };
    }
    if (durableAttempt?.status === "unknown") {
      return { stopped: false, outcome: "unknown", attemptId: prepared.attemptId, storeRevision: afterPrepare.storeRevision, replayed: true };
    }
    const active = this.active;
    const identity = active?.runtimeIdentity;
    const run = active?.currentRun;
    if (!active || !identity?.agentRunId || !run?.sessionRunId) {
      const unknown = await store.finishOperationAttempt({ attemptId: prepared.attemptId, outcome: "unknown" });
      return {
        stopped: false,
        outcome: "unknown",
        reasonCode: "AGENT_RUN_NOT_ACTIVE",
        attemptId: prepared.attemptId,
        storeRevision: unknown.storeRevision,
      };
    }
    if (
      identity.runtimeId !== params.runtimeId
      || identity.taskId !== params.taskId
      || identity.agentRunId !== params.agentRunId
      || run.sessionRunId !== params.sessionRunId
      || JSON.stringify(identity.scope) !== JSON.stringify(params.scope)
    ) {
      await store.finishOperationAttempt({ attemptId: prepared.attemptId, outcome: "unknown" });
      throw new PiHostError("RUNTIME_IDENTITY_MISMATCH", "Agent Run stop identity does not match the active Runtime");
    }
    this.options.emit("foundation.changed", {
      storeRevision: prepared.storeRevision,
      kind: "agentRun.stopPrepared",
      entityKind: "operationAttempt",
      entityId: prepared.attemptId,
      taskId: identity.taskId,
      runtimeId: identity.runtimeId,
      agentRunId: identity.agentRunId,
    });
    this.updateRunState(active, run, "stopRequested");
    try {
      await Promise.all([active.auxiliary?.stopAll(),active.session.abort()]);
      await active.session.waitForIdle();
      await this.finalizeRun(active, run, "aborted");
      await this.finishDurableSessionRun(active, run, "aborted");
      const finished = await store.finishOperationAttempt({
        attemptId: prepared.attemptId,
        outcome: "succeeded",
        confirmedRuntimeAbort: identity.runtimeId,
      });
      this.options.emit("foundation.changed", {
        storeRevision: finished.storeRevision,
        kind: "agentRun.stopped",
        entityKind: "agentRun",
        entityId: identity.agentRunId,
        taskId: identity.taskId,
        runtimeId: identity.runtimeId,
      });
      return { stopped: true, attemptId: prepared.attemptId, storeRevision: (await store.snapshot()).storeRevision };
    } catch (error) {
      await store.finishOperationAttempt({
        attemptId: prepared.attemptId,
        outcome: "unknown",
      }).catch(() => undefined);
      this.updateRunState(active, run, "unknown", { retryable: false });
      throw error;
    }
  }

  private renderMermaid(source: string): unknown {
    const kind = diagramKind(source);
    try {
      const art = render(source);
      if (!art) {
        return {
          rendered: false,
          kind,
          error: kind
            ? "Mermaid syntax could not be rendered"
            : "Mermaid diagram type is not supported by the native renderer",
        };
      }
      return {
        rendered: true,
        kind,
        width: art.width,
        lines: art.plain,
        styled: art.styled,
        warnings: art.warnings,
      };
    } catch {
      return { rendered: false, kind, error: "Mermaid rendering failed" };
    }
  }

  /** 只读 Git 事实：注册项目目录的当前分支（面二上下文条/只读 Git 页共用）。 */
  private async projectGitBranch(projectIdValue: string): Promise<unknown> {
    const projectId = projectIdValue.trim();
    const store = await this.getProductStore();
    const snapshot = await store.snapshot();
    const project = snapshot.projects.find(
      (candidate) => candidate.id === projectId,
    );
    if (!project) {
      throw new PiHostError(
        "PROJECT_NOT_FOUND",
        "Project does not exist",
        { projectId },
      );
    }
    const execFile = promisify(execFileCallback);
    try {
      const { stdout } = await execFile(
        "git",
        ["-C", project.directory, "rev-parse", "--abbrev-ref", "HEAD"],
        { timeout: 5_000, maxBuffer: 1024 * 64 },
      );
      const branch = stdout.trim();
      return {
        projectId: project.id,
        directory: project.directory,
        branch: branch.length > 0 ? branch : null,
      };
    } catch {
      // 目录不是 Git 仓库或 git 不可用：如实返回空分支，不猜测。
      return { projectId: project.id, directory: project.directory, branch: null };
    }
  }

  private readonly directWorkerRuntimes = new Set<string>();
  private readonly collaborationDrains = new Set<string>();

  private isDirectWorker(snapshot:Awaited<ReturnType<ProductStore["snapshot"]>>,run:AgentRunRecord):boolean {
    if(run.role!=="worker" || snapshot.managedWorkerWorktrees.some(tree=>tree.agentRunId===run.id))return false;
    const assignment=snapshot.agentAssignments.find(item=>item.agentRunId===run.id);
    const packet=assignment?.taskPacket as {workspacePolicy?:string}|undefined;
    return packet?.workspacePolicy==="task_directory" && snapshot.agentAssignments.some(item=>item.teamRunId===assignment?.teamRunId && item.assignmentKind==="coordinator" && (item.taskPacket as {adaptive?:boolean})?.adaptive===true);
  }

  private async checkDirectWorkerWorkspace(snapshot:Awaited<ReturnType<ProductStore["snapshot"]>>,run:AgentRunRecord,task:TaskRecord,workspace:RuntimeIdentity["workspace"]):Promise<boolean> {
    if(!this.isDirectWorker(snapshot,run))return false;
    const packet=snapshot.agentAssignments.find(item=>item.agentRunId===run.id)!.taskPacket as {workspaceRootDigest:string};
    const canonical=await realpath(task.cwd);
    if(workspace.access!=="exclusiveWrite" || workspace.workspaceId!==`task-directory:${run.id}` || await realpath(workspace.cwd)!==canonical || packet.workspaceRootDigest!==createHash("sha256").update(canonical).digest("hex"))throw new PiHostError("WORKSPACE_TASK_SCOPE_REQUIRED","成员目录已改变，需要重新安排工作");
    return true;
  }

  private async adaptiveWorkspacePolicy(task:TaskRecord,snapshot:Awaited<ReturnType<ProductStore["snapshot"]>>):Promise<"managed_worktree"|"task_directory"> {
    if(task.scope.kind==="user")return "task_directory";
    try {
      const source=await inspectManagedWorkerWorktreeSource({projectDirectory:task.cwd});
      await assertManagedWorkerWorktreeContextSourcesMaterialize({source,relativePaths:(snapshot.taskContextSets.find(set=>set.taskId===task.id)?.sources??[]).filter(item=>item.kind==="scope_document").map(item=>item.relativePath),includeCurrentAgents:true});
      return "managed_worktree";
    }catch(error){
      if(error instanceof ManagedWorkerWorktreeError && ["WORKSPACE_GIT_REPOSITORY_REQUIRED","WORKSPACE_SOURCE_HEAD_REQUIRED","WORKSPACE_SOURCE_DIRTY","WORKSPACE_CONTEXT_SOURCE_NOT_MATERIALIZED"].includes(error.code))return "task_directory";
      throw error;
    }
  }

  private collaborationClosing = false;

  private async setCoordinatorAccess(active:WritableSession,access:"sharedReadOnly"|"exclusiveWrite"):Promise<void> {
    if(access==="sharedReadOnly"&&active.auxiliary?.hasLive)throw new PiHostError("WORKSPACE_BUSY","当前成员仍有后台活动，请停止后再移交目录写入权");
    const identity=active.runtimeIdentity;
    if(!identity||active.promptEnvironment?.role!=="coordinator") return;
    const key=this.workspaceClaimKey(identity.workspace);
    if(access==="exclusiveWrite"&&this.workspaceConflict(key,identity.runtimeId,access))return;
    const names=active.session.getAllTools().filter(tool=>SHARED_READ_ONLY_TOOL_NAMES.has(tool.name)||(access==="exclusiveWrite"&&["bash","edit","write"].includes(tool.name))).map(tool=>tool.name);
    active.session.setActiveToolsByName(names);
    this.releaseWorkspaceClaim(this.runtimeWorkspaceClaims,key,identity.runtimeId);
    identity.workspace.access=access;
    this.addWorkspaceClaim(this.runtimeWorkspaceClaims,key,identity.runtimeId,access);
    await this.refreshRuntimePrompt(active);
  }

  private async prepareCoordinatorDirectWork(active:WritableSession):Promise<void> {
    const identity=active.runtimeIdentity;
    if(!identity||active.promptEnvironment?.role!=="coordinator"||active.currentRun)return;
    const snapshot=await (await this.getProductStore()).snapshot();
    if(snapshot.agentRuns.some(run=>run.taskId===identity.taskId&&run.role!=="coordinator"&&["prepared","running","waiting"].includes(run.status)))return;
    const key=this.workspaceClaimKey(identity.workspace);
    for(const [otherId,other] of this.runtimes) {
      if(otherId!==identity.runtimeId&&other.runtimeIdentity&&this.workspaceClaimKey(other.runtimeIdentity.workspace)===key&&!other.currentRun&&!other.session.isStreaming&&!other.auxiliary?.hasLive&&!this.collaborationDrains.has(other.runtimeIdentity.dcodeSessionId))await this.closeRuntime(otherId);
    }
    await this.setCoordinatorAccess(active,"exclusiveWrite");
  }

  private async handleVerification(identity:RuntimePromptIdentity,callId:string,input:VerificationAction):Promise<unknown> {
    const store=await this.getProductStore();const snapshot=await store.snapshot();
    const actor=snapshot.agentRuns.find(run=>run.id===identity.agentRunId&&run.taskId===identity.taskId&&run.sessionId===identity.dcodeSessionId);
    if(!actor||!["coordinator","verifier"].includes(actor.role)) throw new PiHostError("VERIFICATION_ROLE_REQUIRED","当前成员没有验收权限");
    const taskId=identity.taskId;
    if(input.action==="context")return verificationContext(snapshot,taskId);
    if(input.action==="read_report"){
      const report=snapshot.agentReports.find(report=>report.id===input.subjectReportId&&report.taskId===taskId);if(!report)throw new PiHostError("REPORT_NOT_FOUND","报告不属于当前任务");
      const body=JSON.stringify(report.body),offset=input.offset??0,end=Math.min(body.length,offset+(input.limit??12000));return {reportId:report.id,agentRunId:report.agentRunId,reportKind:report.reportKind,content:body.slice(offset,end),totalLength:body.length,...(end<body.length?{nextOffset:end}:{})};
    }
    const run=this.runtimes.get(identity.runtimeId)?.currentRun;
    const requestId=`verification:${createHash("sha256").update(`${taskId}\0${run?.id}\0${callId}`).digest("hex").slice(0,48)}`;
    if(input.action==="submit") {
      if(actor.role!=="verifier"||!input.subjectReportId||!input.verdict||!input.summary) throw new PiHostError("VERIFIER_REQUIRED","需要验收成员指定报告、结论和依据");
      const result=await store.submitVerification({requestId,taskId,verifierAgentRunId:actor.id,subjectReportId:input.subjectReportId,verdict:input.verdict,evidenceIds:input.evidenceIds??[],findings:input.findings??[],summary:input.summary});
      this.options.emit("foundation.changed",{kind:"verification.submitted",taskId,storeRevision:result.storeRevision});return result;
    }
    if(actor.role!=="coordinator"||!input.verificationId||!input.outcome||!input.reason) throw new PiHostError("COORDINATOR_REQUIRED","需要协调者对已有验收做复核");
    const result=await store.reviewVerification({requestId,taskId,coordinatorAgentRunId:actor.id,verificationId:input.verificationId,outcome:input.outcome,reason:input.reason,...(input.strategyChange?{strategyChange:input.strategyChange}:{})});
    if(input.outcome!=="accepted")await this.enqueueCollaboration({requestId:`follow-${requestId}`,taskId,sourceSessionId:identity.dcodeSessionId,targetAgentRunId:input.outcome==="rework"?result.verification.subjectAgentRunId:result.verification.verifierAgentRunId,author:"coordinator",originRawInputId:run?.rawInputId,text:`${input.outcome==="rework"?"请修复对应成果":"请重新独立核验"}：${input.reason}\n${input.strategyChange?`方法调整：${input.strategyChange}`:""}\n验收记录：${result.verification.id}。完成后提交具体结果与新证据，保留无关已通过工作。`});
    this.options.emit("foundation.changed",{kind:"verification.reviewed",taskId,storeRevision:result.storeRevision});return result;
  }

  private async coordinateTeam(identity:RuntimePromptIdentity, callId:string, action:TeamAction):Promise<unknown> {
    const store=await this.getProductStore();
    let snapshot=await store.snapshot();
    const owner=snapshot.agentRuns.find(run=>run.id===identity.agentRunId && run.taskId===identity.taskId && run.sessionId===identity.dcodeSessionId && run.role==="coordinator");
    const task=snapshot.tasks.find(task=>task.id===identity.taskId);
    const ownerRun=this.runtimes.get(identity.runtimeId)?.currentRun;
    const originRawInputId=ownerRun?.latestRawInputId??ownerRun?.rawInputId;
    callId=createHash("sha256").update(`${identity.taskId}\0${identity.agentRunId}\0${originRawInputId}\0${callId}`).digest("hex").slice(0,48);
    if(!owner||!task) throw new PiHostError("COORDINATOR_REQUIRED","只有本任务协调者可以创建与安排成员");
    if(action.action==="list") return {profiles:snapshot.agentProfiles.filter(profile=>profile.enabled&&profile.role!=="coordinator"),members:snapshot.agentRuns.filter(run=>run.taskId===task.id&&run.role!=="coordinator").map(run=>({...run,title:snapshot.sessions.find(session=>session.id===run.sessionId)?.title})),messages:store.collaborationMessages(task.id).slice(-50).map(message=>({...message,text:message.text.slice(0,1200),complete:message.text.length<=1200})),artifacts:snapshot.artifacts.filter(artifact=>artifact.taskId===task.id)};
    if(action.action==="read_message"){
      const message=store.collaborationMessages(task.id).find(message=>message.id===action.messageId);if(!message)throw new PiHostError("MESSAGE_NOT_FOUND","消息不属于当前任务");
      const offset=action.offset??0,end=Math.min(message.text.length,offset+(action.limit??20000));
      if(ownerRun){ownerRun.messageReadCoverage??=new Map();const previous=ownerRun.messageReadCoverage.get(message.id)??0;if(offset<=previous){ownerRun.messageReadCoverage.set(message.id,Math.max(previous,end));if(end>=message.text.length&&message.author==="user")this.acknowledgeUserUpdate(ownerRun,message,store);}}
      return {messageId:message.id,author:message.author,sourceSessionId:message.sourceSessionId,targetAgentRunId:message.targetAgentRunId,text:message.text.slice(offset,end),...(end<message.text.length?{nextOffset:end}:{}),totalLength:message.text.length};
    }
    if(action.action==="cancel_input"||action.action==="resume_input") {
      const message=store.collaborationMessages(task.id).find(message=>message.id===action.messageId);
      if(!message||!action.reason?.trim())throw new PiHostError("INVALID_ARGUMENT","需要本任务的消息和取消依据");
      const result=await store.transitionCollaborationMessage({requestId:`cancel-input:${callId}`,id:message.id,expectedRevision:message.revision,state:action.action==="resume_input"?"queued":"cancelled",error:action.reason});
      if(action.action==="resume_input")void this.drainCollaboration(result.message.targetSessionId);
      this.options.emit("foundation.changed",{kind:"collaboration.messageChanged",taskId:task.id,storeRevision:result.storeRevision});return result;
    }
    if(action.action==="send"||action.action==="stop") {
      const target=snapshot.agentRuns.find(run=>run.id===action.agentRunId&&run.taskId===task.id&&run.role!=="coordinator");
      if(!target) throw new PiHostError("MEMBER_NOT_FOUND","只能选择本任务已创建的成员");
      if(action.action==="stop") {
        let paused=0;for(const message of store.collaborationMessages(task.id).filter(message=>message.targetAgentRunId===target.id&&message.state==="queued")){await store.transitionCollaborationMessage({requestId:`stop-member:${callId}:${message.id}`,id:message.id,expectedRevision:message.revision,state:"paused",error:"该成员的后续工作已停止，继续后才会发送"});paused++;}
        const runtimeId=this.runtimeByDCodeSessionId.get(target.sessionId);
        if(runtimeId) await this.handleRuntimeRequest("session.abort",{runtimeId});
        this.options.emit("foundation.changed",{kind:"collaboration.messageChanged",taskId:task.id});
        return {agentRunId:target.id,stopped:true,hadActiveRuntime:!!runtimeId,pausedInputs:paused};
      }
      if(!action.message?.trim()) throw new PiHostError("INVALID_ARGUMENT","需要发送的内容");
      const pendingUser=store.collaborationMessages(task.id).find(message=>message.targetAgentRunId===target.id&&message.author==="user"&&["queued","delivering"].includes(message.state)&&!store.isCollaborationMessageApplied(message.id));
      if(pendingUser)return {sent:false,reason:"用户的新要求正在等待该成员接收，请在生效后核对再交办",messageId:pendingUser.id};
      const latest=store.latestAppliedUserMessage(target.id),newer=latest&&!ownerRun?.knownUserUpdates?.has(latest.id)?latest:undefined;
      if(newer){if(newer.text.length<=8000)this.acknowledgeUserUpdate(ownerRun,newer,store);return {sent:false,reason:"先核对该成员最新直接要求与当前用户要求的关系，再交办修订内容",messageId:newer.id,userUpdate:newer.text.slice(0,8000),complete:newer.text.length<=8000,sourceSessionId:newer.sourceSessionId,...(newer.text.length>8000?{nextAction:"用 read_message 读取完整要求"}:{})};}
      if(action.deliveryMode==="steer")return this.queueSteering({requestId:`team-steer:${callId}`,taskId:task.id,sourceSessionId:identity.dcodeSessionId,targetAgentRunId:target.id,author:"coordinator",originRawInputId,text:action.message});
      return this.enqueueCollaboration({requestId:`team-send:${callId}`,taskId:task.id,sourceSessionId:identity.dcodeSessionId,targetAgentRunId:target.id,author:"coordinator",originRawInputId,text:action.message});
    }
    if(!action.members?.length) throw new PiHostError("INVALID_ARGUMENT","需要有边界的成员工作说明");
    const original=await store.replayAdaptiveTeam(`team-delegate:${callId}`,task.id,task.scope,owner.id,action.members.map(member=>({profileId:member.profileId,title:member.title,taskPacket:{instruction:member.instruction,acceptance:member.acceptance}})));
    if(original){for(const run of original.childAgentRuns)await this.ensureAdaptiveInitialInput(store,run.id);return {created:true,scheduled:true,replayed:true,teamRunId:original.teamRun.id,members:original.childAgentRuns};}
    for(const [runtimeId,runtime] of this.runtimes) {
      if(this.runtimes.size+action.members.length<=MAX_ACTIVE_RUNTIMES) break;
      if(runtimeId!==identity.runtimeId&&!runtime.currentRun&&!runtime.session.isStreaming&&!runtime.auxiliary?.hasLive&&runtime.promptEnvironment?.role!=="coordinator") await this.closeRuntime(runtimeId);
    }

    const models=await this.dcodeModelsView();
    const decisions:ModelRouteDecision[]=[];
    const resolvedChains:AgentModelCandidate[][]=[];
    const quotaReads=new Map<string,ReturnType<ModelQuotaService["get"]>>();
    for(const member of action.members) {
      const profile=snapshot.agentProfiles.find(profile=>profile.id===member.profileId&&profile.enabled&&profile.role!=="coordinator");
      if(!profile) throw new PiHostError("PROFILE_UNAVAILABLE","成员档案不可用");
      const candidates=profile.modelCandidates??(ownerRuntimeModel(owner) ? [ownerRuntimeModel(owner)!] : snapshot.runtimeModelSelection?[snapshot.runtimeModelSelection]:[]);
      resolvedChains.push(candidates);
      const decision=await chooseAgentModel({candidates,models:models.models,quotas:{get:(provider)=>{let read=quotaReads.get(provider);if(!read){read=this.quotaService().get(provider,true);quotaReads.set(provider,read);}return read;}}});
      if(!decision.selected) return {started:false,blockedMember:member.title,reason:"回退链中没有额度明确高于 1% 的可用模型",decision};
      decisions.push(decision);
    }
    const ownerRuntime=this.runtimes.get(identity.runtimeId);
    if(ownerRuntime) {
      if([...ownerRuntime.currentRun?.toolCalls.values()??[]].some(call=>!SHARED_READ_ONLY_TOOL_NAMES.has(call.toolName))) throw new PiHostError("WORKSPACE_BUSY","写入工作正在收尾，完成后再派发成员");
      await this.setCoordinatorAccess(ownerRuntime,"sharedReadOnly");
    }
    const workspacePolicy=action.members.some(member=>snapshot.agentProfiles.find(profile=>profile.id===member.profileId)?.role==="worker")?await this.adaptiveWorkspacePolicy(task,snapshot):"managed_worktree";
    const workspaceRootDigest=createHash("sha256").update(await realpath(task.cwd)).digest("hex");
    const created=await store.createTeamRun({requestId:`team-delegate:${callId}`,taskId:task.id,scope:task.scope,coordinatorAgentRunId:owner.id,members:action.members.map((member,index)=>({profileId:member.profileId,title:member.title,taskPacket:{instruction:member.instruction,acceptance:member.acceptance,sourceSessionId:identity.dcodeSessionId,originRawInputId,workspacePolicy,workspaceRootDigest,modelDecision:decisions[index],resolvedModelCandidates:resolvedChains[index]}}))});
    const members=[];
    for(const [index,run] of created.childAgentRuns.entries()) {
      const queued=await this.ensureAdaptiveInitialInput(store,run.id);
      members.push({agentRunId:run.id,sessionId:run.sessionId,title:action.members[index]!.title,plannedModel:decisions[index]!.selected,message:queued});
    }
    this.options.emit("foundation.changed",{kind:"teamRun.created",taskId:task.id});
    return {created:true,scheduled:true,members};
  }

  private async ensureAdaptiveInitialInput(store:ProductStore,agentRunId:string,recovery=false):Promise<CollaborationMessage|undefined>{
    const initial=store.initialCollaborationMessage(agentRunId);if(initial)return initial;
    const snapshot=await store.snapshot(),assignment=snapshot.agentAssignments.find(item=>item.agentRunId===agentRunId),packet=assignment?.taskPacket as {instruction?:string;acceptance?:string;sourceSessionId?:string;originRawInputId?:string}|undefined;
    if(!assignment||!packet?.instruction||!packet.sourceSessionId||!packet.originRawInputId)return;
    const body=`${packet.instruction}\n\n验收要求：${packet.acceptance??""}`;
    const previous=store.collaborationMessages(assignment.taskId).find(message=>message.targetAgentRunId===agentRunId&&message.author==="coordinator"&&message.text===body&&message.originRawInputId===packet.originRawInputId);if(previous)return previous;
    const result=await store.queueCollaborationMessage({requestId:`delegate-initial:${agentRunId}`,taskId:assignment.taskId,sourceSessionId:packet.sourceSessionId,targetAgentRunId:agentRunId,author:"coordinator",originRawInputId:packet.originRawInputId,text:body});
    let message=result.message;
    if(recovery)message=(await store.transitionCollaborationMessage({requestId:`recover-initial:${agentRunId}`,id:message.id,expectedRevision:message.revision,state:"paused",error:"已恢复创建成员时尚未发出的工作说明，请核对后继续"})).message;
    else void this.drainCollaboration(message.targetSessionId);
    this.options.emit("foundation.changed",{kind:"collaboration.messageChanged",taskId:assignment.taskId});return message;
  }

  private async openMemberRuntime(run:AgentRunRecord,task:TaskRecord,tree?:ManagedWorkerWorktreeRecord):Promise<string> {
    const existing=this.runtimeByDCodeSessionId.get(run.sessionId);
    if(existing) {
      if(this.runtimes.get(existing)?.runtimeIdentity?.agentRunId!==run.id)throw new PiHostError("RUNTIME_IDENTITY_MISMATCH","该会话已有其他成员持有的运行");
      return existing;
    }
    if(this.runtimes.size+this.openingDCodeSessionIds.size>=MAX_ACTIVE_RUNTIMES){
      for(const [runtimeId,runtime] of this.runtimes){
        if(runtime.currentRun||runtime.closing||runtime.session.isCompacting||runtime.auxiliary?.hasLive||this.runtimeQueues.has(runtimeId)||this.collaborationDrains.has(runtime.runtimeIdentity?.dcodeSessionId??""))continue;
        if(runtime.promptEnvironment?.role==="coordinator"&&runtime.runtimeIdentity?.taskId===task.id)continue;
        await this.closeRuntime(runtimeId);break;
      }
    }
    const snapshot=await (await this.getProductStore()).snapshot();
    const direct=this.isDirectWorker(snapshot,run);
    if(!tree && run.role==="worker")tree=snapshot.managedWorkerWorktrees.find(item=>item.agentRunId===run.id&&item.state==="ready");
    if(!tree&&run.role==="worker"&&!direct&&run.teamRunId){
      const existingTree=snapshot.managedWorkerWorktrees.find(item=>item.agentRunId===run.id);
      if(existingTree)tree=await this.recoverAdaptiveWorktree(existingTree,task);
      else {const provisioned=await this.provisionTeamWorkerWorktrees({store:await this.getProductStore(),task,teamRunId:run.teamRunId,agentRuns:[run],requestId:`adaptive-worktree:${run.id}`,projects:snapshot.projects,taskContextSources:snapshot.taskContextSets.find(set=>set.taskId===task.id)?.sources??[]});tree=provisioned.get(run.id);}
    }
    const runtimeId=`runtime-${run.id}`;
    if(direct)this.directWorkerRuntimes.add(runtimeId);
    try {
      await this.runtimeContext.run(runtimeId,()=>this.startDCodeRuntime({runtimeId,taskId:task.id,dcodeSessionId:run.sessionId,agentRunId:run.id,scope:task.scope,workspace:tree?{workspaceId:tree.workspaceId,cwd:tree.workspaceCwd,access:"exclusiveWrite"}:{workspaceId:direct?`task-directory:${run.id}`:`source:${run.id}`,cwd:task.cwd,access:direct?"exclusiveWrite":"sharedReadOnly"}}));
    }catch(error){this.directWorkerRuntimes.delete(runtimeId);throw error;}
    return runtimeId;
  }

  private async recoverAdaptiveWorktree(previous:ManagedWorkerWorktreeRecord,task:TaskRecord):Promise<ManagedWorkerWorktreeRecord>{
    if(await realpath(task.cwd)!==await realpath(previous.sourceProjectDirectory))throw new PiHostError("WORKSPACE_SCOPE_CHANGED","原任务目录已变化，请重新核对成员工作范围");
    const store=await this.getProductStore(),snapshot=await store.snapshot();
    const plan={...previous,worktreeRoot:previous.managedPath};
    // Verify any existing directory before recording another attempt. Never
    // delete, replace or merge a target whose identity cannot be established.
    const present=await lstat(plan.worktreeRoot).then(()=>true,error=>{if((error as NodeJS.ErrnoException).code==="ENOENT")return false;throw error;});
    if(present)await verifyManagedWorkerWorktree(plan);
    const prepared=await store.retryManagedWorkerWorktree({artifactId:previous.artifactId,expectedRevision:previous.revision});
    try{
      const ready=await provisionManagedWorkerWorktree(plan,{allowExisting:present,contextRelativePaths:(snapshot.taskContextSets.find(set=>set.taskId===task.id)?.sources??[]).filter(source=>source.kind==="scope_document").map(source=>source.relativePath),includeCurrentAgents:true});
      const result=await store.finishManagedWorkerWorktree({requestId:`worktree-recovered:${prepared.provisionAttemptId}`,artifactId:prepared.artifactId,provisionAttemptId:prepared.provisionAttemptId,state:"ready",resultDigest:`sha256:${createHash("sha256").update(JSON.stringify({workspaceId:ready.workspaceId,baseCommit:ready.baseCommit,worktreeRoot:ready.worktreeRoot,reused:ready.reused})).digest("hex")}`});
      this.options.emit("foundation.changed",{kind:"managedWorkerWorktree.ready",taskId:task.id});return result.worktree;
    }catch(error){await store.finishManagedWorkerWorktree({requestId:`worktree-retry-failed:${prepared.provisionAttemptId}`,artifactId:prepared.artifactId,provisionAttemptId:prepared.provisionAttemptId,state:"unknown",failureCode:errorRecord(error).code}).catch(()=>undefined);throw error;}
  }

  private async coordinatorUpdates(active:WritableSession,text:string):Promise<{text:string;known:Map<string,string>}> {
    const known=new Map<string,string>();if(active.promptEnvironment?.role!=="coordinator"||!active.runtimeIdentity)return {text,known};
    const store=await this.getProductStore(),snapshot=await store.snapshot();
    const updates=snapshot.agentRuns.filter(run=>run.taskId===active.runtimeIdentity!.taskId&&run.role!=="coordinator").flatMap(run=>{const message=store.latestAppliedUserMessage(run.id);return message?[{message,member:snapshot.sessions.find(session=>session.id===run.sessionId)?.title??"成员"}]:[];});
    if(!updates.length||text.length>194000)return {text,known};
    let budget=Math.min(30000,198000-text.length);const rows=[];
    for(const {message,member} of updates){const length=Math.max(0,Math.min(4000,budget-500)),complete=message.text.length<=length;const content=message.text.slice(0,length);budget-=content.length+500;if(budget<0)break;if(complete)known.set(message.id,message.originRawInputId);rows.push({messageId:message.id,member,userText:content,complete,...(!complete?{nextAction:"用 dcode_team read_message 继续读取，再安排此成员"}:{})});}
    return {text:`${text}\n\n<dcode_member_updates>\n以下是用户在成员对话中已经生效的直接要求。保留来源，核对与当前要求的关系，不用旧安排默默覆盖它们。\n${JSON.stringify(rows)}\n</dcode_member_updates>`,known};
  }

  private acknowledgeUserUpdate(run:ActiveRun|undefined,message:CollaborationMessage,store:ProductStore):void {
    if(!run)return;run.knownUserUpdates??=new Map();run.knownUserUpdates.set(message.id,message.originRawInputId);
    const previous=run.latestRawInputId??run.rawInputId;if(!previous||store.rawInputSequence(message.originRawInputId)>store.rawInputSequence(previous))run.latestRawInputId=message.originRawInputId;
  }

  private async queueSteering(input:Parameters<ProductStore["queueCollaborationMessage"]>[0],expectedSessionRunId?:string):Promise<{message:CollaborationMessage;queued:boolean}> {
    const id=this.runtimeByDCodeSessionId.get((await (await this.getProductStore()).snapshot()).agentRuns.find(run=>run.id===input.targetAgentRunId)?.sessionId??"");
    const runtime=id?this.runtimes.get(id):undefined,run=runtime?.currentRun;
    if(!runtime||!run?.sessionRunId||run.state.phase!=="running"||!runtime.session.isStreaming||runtime.ui.hasPendingDialogs||expectedSessionRunId&&expectedSessionRunId!==run.sessionRunId)throw new PiHostError("SESSION_NOT_RUNNING","当前工作已结束或正在等待回答，输入内容已保留");
    const expansion=await expandDCodeInput(input.text,runtime.session);if(expansion.command)throw new PiHostError("STEER_COMMAND_UNSUPPORTED","命令需要单独执行，请选择排到后面");
    const store=await this.getProductStore();const managed=await Promise.all((input.attachmentIds??[]).map(id=>store.resolveAttachment(id)));
    const projected=await this.coordinatorUpdates(runtime,attachmentPrompt(expansion.text,managed.map(item=>item.attachment),store.layout));
    const effectiveText=projected.text;
    input=this.acknowledgedCoordinatorInput(store,input);
    const result=await store.queueCollaborationMessage({...input,deliveryMode:"steer",targetSessionRunId:run.sessionRunId});
    const latest=store.collaborationMessages().find(message=>message.id===result.message.id)!;
    if(latest.state!=="queued")return {message:latest,queued:false};
    if(runtime.currentRun!==run||!runtime.session.isStreaming){const paused=await store.transitionCollaborationMessage({requestId:`late-steer:${latest.id}`,id:latest.id,expectedRevision:latest.revision,state:"paused",error:"前一轮已经结束，已保留为待发送消息"});this.options.emit("foundation.changed",{kind:"collaboration.messageChanged",taskId:input.taskId});return {message:paused.message,queued:true};}
    const delivered=await store.transitionCollaborationMessage({requestId:`steer-deliver:${latest.id}`,id:latest.id,expectedRevision:latest.revision,state:"delivering"});
    run.steering??=new Map();const timestamp=Date.now();run.steering.set(latest.id,{message:delivered.message,effectiveText,inputSources:expansion.sources,knownUserUpdates:projected.known,timestamp});
    if(runtime.currentRun!==run||!runtime.session.isStreaming){await store.transitionCollaborationMessage({requestId:`steer-ended:${latest.id}`,id:latest.id,expectedRevision:delivered.message.revision,state:"interrupted",error:"运行在接收补充前结束，未自动重发"});run.steering.delete(latest.id);return {message:store.collaborationMessages().find(message=>message.id===latest.id)!,queued:false};}
    if(input.author==="coordinator"&&this.unacknowledgedMemberInput(store,delivered.message)){
      await store.transitionCollaborationMessage({requestId:`stale-steer:${latest.id}`,id:latest.id,expectedRevision:delivered.message.revision,state:"interrupted",error:"成员收到更新的用户要求，当前补充未注入，请核对后重新交办"});run.steering.delete(latest.id);this.options.emit("foundation.changed",{kind:"collaboration.messageChanged",taskId:input.taskId});return {message:store.collaborationMessages().find(message=>message.id===latest.id)!,queued:false};
    }
    runtime.session.agent.steer({role:"user",content:[{type:"text",text:effectiveText},...managed.filter(item=>item.data&&item.attachment.mimeType.startsWith("image/")).map(item=>({type:"image" as const,mimeType:item.attachment.mimeType,data:item.data!}))],timestamp,dcodeSteerId:latest.id} as AgentMessage);
    this.options.emit("foundation.changed",{kind:"collaboration.messageChanged",taskId:input.taskId});return {message:delivered.message,queued:false};
  }

  private acknowledgedCoordinatorInput(store:ProductStore,input:Parameters<ProductStore["queueCollaborationMessage"]>[0]):Parameters<ProductStore["queueCollaborationMessage"]>[0] {
    if(input.author!=="coordinator")return input;
    const id=this.runtimeByDCodeSessionId.get(input.sourceSessionId),source=id?this.runtimes.get(id):undefined;
    const latest=store.latestAppliedUserMessage(input.targetAgentRunId);
    return source?.promptEnvironment?.role==="coordinator"&&latest&&source.currentRun?.knownUserUpdates?.has(latest.id)?{...input,acknowledgedUserMessageId:latest.id}:input;
  }

  private unacknowledgedMemberInput(store:ProductStore,message:CollaborationMessage):CollaborationMessage|undefined {
    const pending=store.collaborationMessages(message.taskId).find(item=>item.targetAgentRunId===message.targetAgentRunId&&item.author==="user"&&["queued","delivering"].includes(item.state)&&!store.isCollaborationMessageApplied(item.id));
    const applied=store.latestAppliedUserMessage(message.targetAgentRunId);
    return pending??(applied&&message.acknowledgedUserMessageId!==applied.id?applied:undefined);
  }

  private memberInputNotice(message:CollaborationMessage):string {
    return `消息 ${message.id}（${message.state}）：\n${message.text.slice(0,8000)}${message.text.length>8000?"\n内容尚未完整显示，请用 dcode_team read_message 分段读取。":""}`;
  }

  private async enqueueCollaboration(input:Parameters<ProductStore["queueCollaborationMessage"]>[0]):Promise<Awaited<ReturnType<ProductStore["queueCollaborationMessage"]>>> {
    const store=await this.getProductStore();
    input=this.acknowledgedCoordinatorInput(store,input);
    const result=await store.queueCollaborationMessage(input);
    this.options.emit("foundation.changed",{kind:"collaboration.messageChanged",storeRevision:result.storeRevision,taskId:input.taskId});
    void this.drainCollaboration(result.message.targetSessionId);
    return result;
  }

  private async drainCollaboration(sessionId:string):Promise<void> {
    if(this.collaborationClosing||this.collaborationDrains.has(sessionId)) return;
    const runtimeId=this.runtimeByDCodeSessionId.get(sessionId);
    if(runtimeId&&(this.runtimes.get(runtimeId)?.currentRun||this.runtimes.get(runtimeId)?.closing)) return;
    this.collaborationDrains.add(sessionId);
    let delivered:CollaborationMessage|undefined;
    let pending:CollaborationMessage|undefined;
    try {
      const store=await this.getProductStore();
      const message=store.collaborationMessages().find(message=>message.targetSessionId===sessionId&&message.state==="queued"&&message.deliveryMode!=="steer");
      if(!message){this.collaborationDrains.delete(sessionId);return;}
      pending=message;
      const snapshot=await store.snapshot();
      const target=snapshot.agentRuns.find(run=>run.id===message.targetAgentRunId)!;
      const task=snapshot.tasks.find(task=>task.id===message.taskId)!;
      const newer=message.author==="coordinator"&&target.role!=="coordinator"?this.unacknowledgedMemberInput(store,message):undefined;
      if(newer){
        await store.transitionCollaborationMessage({requestId:`stale-input:${message.id}`,id:message.id,expectedRevision:message.revision,state:"paused",error:"这条安排早于用户已生效的新要求，需由协调者核对后重新交办"});
        const owner=snapshot.agentRuns.find(run=>run.taskId===task.id&&run.role==="coordinator");
        if(owner)await this.enqueueCollaboration({requestId:`stale-awareness:${message.id}`,taskId:task.id,sourceSessionId:target.sessionId,targetAgentRunId:owner.id,author:"member",originRawInputId:newer.originRawInputId,text:`成员 ${target.id} 的旧安排 ${message.id} 已暂停。用户最新要求：\n${this.memberInputNotice(newer)}\n请核对后取消旧消息并交办更新内容，不要覆盖用户已生效的要求。`});
        this.collaborationDrains.delete(sessionId);this.wakeCollaboration();this.options.emit("foundation.changed",{kind:"collaboration.messageChanged",taskId:task.id});return;
      }
      if(target.role!=="coordinator") {
        const profile=target.profileSnapshot as {modelCandidates?:AgentModelCandidate[]};
        const packet=snapshot.agentAssignments.find(assignment=>assignment.agentRunId===target.id)?.taskPacket as {resolvedModelCandidates?:AgentModelCandidate[]}|undefined;
        const candidates=this.memberModelCandidates(store,target.sessionId,packet?.resolvedModelCandidates??profile.modelCandidates??(target.modelProvider&&target.modelId?[{providerId:target.modelProvider,modelId:target.modelId}]:snapshot.runtimeModelSelection?[snapshot.runtimeModelSelection]:[]));
        const decision=await chooseAgentModel({candidates,models:(await this.dcodeModelsView()).models,quotas:this.quotaService(),capabilities:message.attachmentIds?.some(id=>store.attachmentCatalog().find(item=>item.id===id)?.mimeType.startsWith("image/"))?["image"]:[]});
        if(!decision.selected) {
          await store.transitionCollaborationMessage({requestId:`quota-paused:${message.id}:${message.revision}`,id:message.id,expectedRevision:message.revision,state:"paused",error:"没有额度明确高于 1% 的可用候选，请刷新额度后继续"});
          this.collaborationDrains.delete(sessionId);
          this.options.emit("foundation.changed",{kind:"collaboration.messageChanged",taskId:message.taskId});
          return;
        }
        await store.selectAgentModel({requestId:`message-model:${message.id}:${message.revision}:${createHash("sha256").update(JSON.stringify(decision)).digest("hex").slice(0,16)}`,agentRunId:target.id,decision});
        target.modelProvider=decision.selected.providerId;target.modelId=decision.selected.modelId;
      }
      const selected=store.sessionModelSelection(target.sessionId);
      if(target.role==="coordinator"&&selected){target.modelProvider=selected.providerId;target.modelId=selected.modelId;}
      const targetRuntimeId=await this.openMemberRuntime(target,task);
      if(target.role!=="coordinator"&&target.modelProvider&&target.modelId) await this.handleRuntimeRequest("session.setModel",{runtimeId:targetRuntimeId,provider:target.modelProvider,modelId:target.modelId});
      delivered=(await store.transitionCollaborationMessage({requestId:`deliver:${message.id}`,id:message.id,expectedRevision:message.revision,state:"delivering"})).message;
      await this.handleRuntimeRequest("session.prompt",{runtimeId:targetRuntimeId,promptId:`collab:${message.id}`,message:message.text,...(message.pathAction?{pathAction:message.pathAction}:{}),...(message.attachmentIds?.length?{attachmentIds:message.attachmentIds}:{})});
    } catch(error) {
      this.collaborationDrains.delete(sessionId);
      if(delivered) await (await this.getProductStore()).transitionCollaborationMessage({requestId:`delivery-failed:${delivered.id}`,id:delivered.id,expectedRevision:delivered.revision,state:"failed",error:"成员未能接收消息，请查看运行结果"}).catch(()=>undefined);
      const waiting=error instanceof PiHostError&&["WORKSPACE_IN_USE","RUNTIME_LIMIT_REACHED"].includes(error.code)?error.code==="WORKSPACE_IN_USE"?"workspace":"capacity":undefined;
      if(!delivered&&pending&&waiting){await (await this.getProductStore()).waitCollaborationMessage(pending.id,pending.revision,waiting).catch(()=>undefined);this.options.emit("foundation.changed",{kind:"collaboration.messageChanged",taskId:pending.taskId});}
      else if(!delivered&&pending){await (await this.getProductStore()).transitionCollaborationMessage({requestId:`delivery-paused:${pending.id}:${pending.revision}`,id:pending.id,expectedRevision:pending.revision,state:"paused",error:errorRecord(error).message}).catch(()=>undefined);}
      if(!waiting)this.options.emit("collaboration.failed",errorRecord(error));
    }
  }

  private collaborationWakePending=false;
  private wakeCollaboration():void {
    if(this.collaborationClosing||this.collaborationWakePending||!this.productStore)return;
    this.collaborationWakePending=true;
    setImmediate(()=>{
      this.collaborationWakePending=false;if(this.collaborationClosing)return;
      const messages=this.productStore?.collaborationMessages().filter(message=>message.state==="queued")??[];
      for(const sessionId of new Set(messages.map(message=>message.targetSessionId)))void this.drainCollaboration(sessionId);
    });
  }

  private async afterPromptSettled(active:WritableSession,run:ActiveRun):Promise<void> {
    if(run.persistenceFailed)return;
    if(active.currentRun===run)active.currentRun=undefined;
    const identity=active.runtimeIdentity;if(!identity)return;
    try {
      if(!active.closing&&!active.auxiliary?.hasLive&&this.directWorkerRuntimes.has(identity.runtimeId))await this.closeRuntime(identity.runtimeId);
    }finally{
      this.collaborationDrains.delete(identity.dcodeSessionId);
      this.wakeCollaboration();
    }
  }


  private async dcodeSessionPresentation(dcodeSessionIdValue: string,pathId?:string): Promise<unknown> {
    const dcodeSessionId = dcodeSessionIdValue.trim();
    const store = await this.getProductStore();
    const snapshot = await store.snapshot();
    const dcodeSession = snapshot.sessions.find((candidate) => candidate.id === dcodeSessionId);
    if (!dcodeSession) {
      throw new PiHostError("DCODE_SESSION_NOT_FOUND", "D Code Session does not exist", { dcodeSessionId });
    }
    const binding = snapshot.sessionRuntimeBindings.find(candidate=>candidate.sessionId===dcodeSession.id);
    const anchors=store.sessionAdapterAnchors(dcodeSessionId);
    if(binding&&anchors.length){
      const document=await this.reader.inspectDocument(binding.adapterSessionId);
      const entries=new Map(document.entries.map(entry=>[entry.id,entry]));const links=[];
      for(const anchor of anchors){let entry=entries.get(anchor.assistantSourceEntryId);let steps=0;while(entry&&steps++<10000){entry=entry.parentId?entries.get(entry.parentId):undefined;if(entry?.type==="message"&&(entry.message as {role?:string}).role==="user")break;}
        if(entry?.type==="message"&&extractSearchableMessage(entry.message)?.body===anchor.effectiveText)links.push({userEntryId:anchor.userEntryId,sourceEntryId:entry.id});}
      if(links.length)await store.linkSessionAdapterEntries(dcodeSessionId,links);
    }
    const nativePaths=snapshot.sessionPaths.filter(path=>path.sessionId===dcodeSessionId);
    const selectedNativePath=nativePaths.find(path=>pathId?path.id===pathId:path.isCurrent);
    if(!selectedNativePath)throw new PiHostError("SESSION_PATH_NOT_FOUND","对话路径不存在");
    const nativeEntries=await store.sessionPathEntries(dcodeSessionId,selectedNativePath.id);
    const pathPresentation={nativePaths,selectedNativePathId:selectedNativePath.id,nativeEntries};
    const collaborationInputs=nativeEntries.flatMap(entry=>{
      const content=entry.content as {collaborationMessageId?:string;author?:string};
      return content.collaborationMessageId&&entry.sourceEntryId?[{sourceEntryId:entry.sourceEntryId,author:content.author,messageId:content.collaborationMessageId}]:[];
    });
    const submissions=store.sessionSubmittedInputs(dcodeSessionId,selectedNativePath.id);
    const active = [...this.runtimes.values()].find((candidate) => (
      candidate.runtimeIdentity?.dcodeSessionId === dcodeSession.id
    ));
    if (!binding) {
      return {
        dcodeSession,
        ...pathPresentation,
        submissions,
        collaborationInputs,
        binding: null,
        runtime: active?.runtimeIdentity
          ? { runtimeId: active.runtimeIdentity.runtimeId, state: this.runtimeState(active) }
          : null,
        adapterState: "unbound",
        inspection: null,
      };
    }
    try {
      return {
        dcodeSession,
        ...pathPresentation,
        submissions,
        collaborationInputs,
        binding,
        runtime: active?.runtimeIdentity
          ? { runtimeId: active.runtimeIdentity.runtimeId, state: this.runtimeState(active) }
          : null,
        adapterState: "ready",
        inspection: !selectedNativePath.isCurrent&&!selectedNativePath.sourceLeafEntryId?null:await this.reader.inspect(binding.adapterSessionId,selectedNativePath.isCurrent?undefined:selectedNativePath.sourceLeafEntryId??undefined),
      };
    } catch (error) {
      if (error instanceof SessionReadError) {
        return {
          dcodeSession,
        ...pathPresentation,
        submissions,
        collaborationInputs,
          binding,
          runtime: active?.runtimeIdentity
            ? { runtimeId: active.runtimeIdentity.runtimeId, state: this.runtimeState(active) }
            : null,
          adapterState: "unavailable",
          inspection: null,
        };
      }
      throw error;
    }
  }

  private async promptDCodeSession(input: {
    dcodeSessionId: string;
    targetAgentRunId?: string;
    deliveryMode?:"steer";
    expectedSessionRunId?:string;
    pathAction?:import("./product-store.js").NativeSessionPathAction;
    promptId: string;
    message: string;
    images?: PromptImageInput[];
    attachmentIds?: string[];
  }): Promise<unknown> {
    const store = await this.getProductStore();
    const snapshot = await store.snapshot();
    const dcodeSession = snapshot.sessions.find((candidate) => candidate.id === input.dcodeSessionId);
    const task = dcodeSession ? snapshot.tasks.find((candidate) => candidate.id === dcodeSession.taskId) : undefined;
    if (!dcodeSession || !task) {
      throw new PiHostError("DCODE_SESSION_NOT_FOUND", "D Code Session or its Task does not exist", {
        dcodeSessionId: input.dcodeSessionId,
      });
    }
    this.assertProjectAvailable(task.scope);
    if(task.state==="archived")throw new PiHostError("TASK_ARCHIVED","请先恢复归档任务，再发送消息");
    if(input.pathAction){
      if(input.targetAgentRunId)throw new PiHostError("INVALID_PATH_ACTION","历史路径操作只能在消息所属会话中进行");
      const runningId=this.runtimeByDCodeSessionId.get(dcodeSession.id);
      if(runningId&&this.runtimes.get(runningId)?.currentRun || store.collaborationMessages(task.id).some(message=>message.targetSessionId===dcodeSession.id&&["queued","paused","delivering"].includes(message.state)))throw new PiHostError("SESSION_BUSY","请先结束当前运行并处理待发送消息，再从历史继续");
    }
    if(input.deliveryMode==="steer"){
      if(input.pathAction)throw new PiHostError("INVALID_ARGUMENT","历史路径修改需要单独开始，不能作为即时补充");
      const target=snapshot.agentRuns.find(run=>run.taskId===task.id&&(input.targetAgentRunId?run.id===input.targetAgentRunId:run.sessionId===dcodeSession.id));
      if(!target)throw new PiHostError("MEMBER_NOT_FOUND","当前会话没有运行成员");
      const result=await this.queueSteering({requestId:`user-steer:${input.promptId}`,taskId:task.id,sourceSessionId:dcodeSession.id,targetAgentRunId:target.id,author:"user",text:input.message,attachmentIds:input.attachmentIds},input.expectedSessionRunId);
      const coordinator=snapshot.agentRuns.find(run=>run.taskId===task.id&&run.role==="coordinator");
      if(coordinator&&coordinator.id!==target.id)await this.enqueueCollaboration({requestId:`steer-awareness:${input.promptId}`,taskId:task.id,sourceSessionId:dcodeSession.id,targetAgentRunId:coordinator.id,author:"coordinator",originRawInputId:result.message.originRawInputId,text:`用户正在向成员 ${target.id} 补充当前工作要求，请核对最新输入并同步安排：\n${this.memberInputNotice(result.message)}`});
      return {accepted:true,...result};
    }
    if(input.targetAgentRunId || dcodeSession.kind==="child") {
      const target=snapshot.agentRuns.find(run=>run.taskId===task.id && (input.targetAgentRunId?run.id===input.targetAgentRunId:run.sessionId===dcodeSession.id));
      if(!target||target.role==="coordinator") throw new PiHostError("MEMBER_NOT_FOUND","请选择本任务已创建的成员");
      const queued=await this.enqueueCollaboration({requestId:`user-directed:${input.promptId}`,taskId:task.id,sourceSessionId:dcodeSession.id,targetAgentRunId:target.id,author:"user",text:input.message,attachmentIds:input.attachmentIds,...(input.pathAction?{pathAction:input.pathAction}:{})});
      const coordinator=snapshot.agentRuns.filter(run=>run.taskId===task.id&&run.role==="coordinator").at(-1);
      if(coordinator) await this.enqueueCollaboration({requestId:`directed-awareness:${input.promptId}`,taskId:task.id,sourceSessionId:dcodeSession.id,targetAgentRunId:coordinator.id,author:"coordinator",originRawInputId:queued.message.originRawInputId,text:`用户正在向成员 ${target.id} 定向补充要求，请同步调整安排，不重复执行该成员的工作：\n${this.memberInputNotice(queued.message)}`});
      return {accepted:true,queued:true,message:queued.message};
    }
    const busyId=this.runtimeByDCodeSessionId.get(dcodeSession.id);
    const busyRuntime=busyId?this.runtimes.get(busyId):undefined;
    if((busyRuntime?.currentRun||busyRuntime?.closing||this.collaborationDrains.has(dcodeSession.id))&&busyRuntime?.runtimeIdentity?.agentRunId) {
      const queued=await this.enqueueCollaboration({requestId:`user-queued:${input.promptId}`,taskId:task.id,sourceSessionId:dcodeSession.id,targetAgentRunId:busyRuntime.runtimeIdentity.agentRunId,author:"user",text:input.message,attachmentIds:input.attachmentIds});
      return {accepted:true,queued:true,message:queued.message};
    }
    let runtimeId = this.runtimeByDCodeSessionId.get(dcodeSession.id);
    let existingRuntime = runtimeId ? this.runtimes.get(runtimeId) : undefined;
    let agentRunId = existingRuntime?.runtimeIdentity?.agentRunId;
    let settledModel: { provider: string; modelId: string } | undefined;
    let settledThinking: ThinkingLevel | undefined;
    const previousAgent = snapshot.agentRuns.find((candidate) => candidate.id === agentRunId);
    if (
      runtimeId && existingRuntime && dcodeSession.kind === "coordination"
      && previousAgent && ["aborted", "failed", "interrupted", "unknown"].includes(previousAgent.status)
    ) {
      if (existingRuntime.currentRun) {
        throw new PiHostError("DCODE_SESSION_SETTLING", "The previous Coordinator run is still settling; retry after it finishes");
      }
      // Keep the task's coordinator identity. Only the execution process and
      // new Session Run change; prior run results remain durable evidence.
      if (existingRuntime.session.model) {
        settledModel = { provider: existingRuntime.session.model.provider, modelId: existingRuntime.session.model.id };
      }
      settledThinking = existingRuntime.session.thinkingLevel;
      await this.closeRuntime(runtimeId);
      runtimeId = undefined;
      existingRuntime = undefined;
      agentRunId = undefined;
    }
    if (runtimeId && !agentRunId) {
      throw new PiHostError(
        "DCODE_SESSION_RUNTIME_UNMANAGED",
        "D Code Session has an unmanaged Runtime and cannot receive a Task-owned prompt",
        { dcodeSessionId: dcodeSession.id, runtimeId },
      );
    }
    let started = false;
    if (!runtimeId) {
      if (this.openingDCodeSessionIds.has(dcodeSession.id)) {
        throw new PiHostError("DCODE_SESSION_OPENING", "D Code Session is still opening; its prompt was not duplicated", {
          dcodeSessionId: dcodeSession.id,
        });
      }
      if (dcodeSession.kind !== "coordination") {
        throw new PiHostError(
          "DCODE_CHILD_SESSION_NOT_ACTIVE",
          "A Child Agent Session can receive a user message only while its own Agent Run is active",
          { dcodeSessionId: dcodeSession.id },
        );
      }
      const coordinator = await store.ensureCoordinatorAgentRun({
        requestId: `coordinator-agent-run:${createHash("sha256").update(`${dcodeSession.id}\0${input.promptId}`).digest("hex")}`,
        taskId: task.id,
        scope: task.scope,
      });
      agentRunId = coordinator.agentRun.id;
      this.options.emit("foundation.changed", {
        storeRevision: coordinator.storeRevision,
        kind: "coordinatorAgentRun.ensured",
        entityKind: "agentRun",
        entityId: coordinator.agentRun.id,
        taskId: task.id,
      });
      runtimeId = `runtime-dcode-ui-${createHash("sha256").update(dcodeSession.id).digest("hex").slice(0, 24)}`;
      await this.runtimeContext.run(runtimeId, async () => await this.startDCodeRuntime({
        runtimeId,
        taskId: task.id,
        dcodeSessionId: dcodeSession.id,
        agentRunId,
        scope: task.scope,
        workspace: {
          workspaceId: `dcode-session:${dcodeSession.id}`,
          cwd: task.cwd,
          access: "sharedReadOnly",
        },
      }));
      started = true;
      const thinking = store.clientPreferences().defaultThinking;
      if (thinking) await this.handleRuntimeRequest("session.setThinking", { runtimeId, level: thinking });
    }
    if (settledModel) await this.handleRuntimeRequest("session.setModel", { runtimeId, ...settledModel });
    if (settledThinking) await this.handleRuntimeRequest("session.setThinking", { runtimeId, level: settledThinking });
    const coordinatorRuntime=this.runtimes.get(runtimeId);
    if(coordinatorRuntime)await this.prepareCoordinatorDirectWork(coordinatorRuntime);
    const result = await this.handleRuntimeRequest("session.prompt", {
      runtimeId,
      promptId: input.promptId,
      message: input.message,
      ...(input.pathAction?{pathAction:input.pathAction}:{}),
      ...(input.attachmentIds?.length ? {attachmentIds:input.attachmentIds} : {}),
      ...(input.images ? { images: input.images } : {}),
    });
    return { runtimeId, started, result };
  }

  private async startDCodeRuntime(params: Record<string, unknown>): Promise<unknown> {
    const runtimeId = params.runtimeId as string;
    const taskId = params.taskId as string;
    const dcodeSessionId = params.dcodeSessionId as string;
    const agentRunId = typeof params.agentRunId === "string" ? params.agentRunId : undefined;
    const scope = params.scope as TaskScope;
    this.assertProjectAvailable(scope);
    const workspace = params.workspace as {
      workspaceId: string;
      cwd: string;
      access: "sharedReadOnly" | "exclusiveWrite";
    };
    const active = this.active;
    if (active) {
      if (
        active.runtimeIdentity?.taskId === taskId
        && active.runtimeIdentity.dcodeSessionId === dcodeSessionId
      ) {
        return {
          reused: true,
          binding: await (await this.getProductStore()).sessionRuntimeBinding(dcodeSessionId),
          runtime: { identity: active.runtimeIdentity, state: this.runtimeState(active) },
        };
      }
      throw new PiHostError("RUNTIME_ID_CONFLICT", "runtimeId is already active for another D Code Session");
    }
    if (this.runtimes.size + this.openingDCodeSessionIds.size >= MAX_ACTIVE_RUNTIMES) {
      throw new PiHostError(
        "RUNTIME_LIMIT_REACHED",
        "D Code has reached its active Runtime limit; existing runs were left untouched",
        { maxActiveRuntimes: MAX_ACTIVE_RUNTIMES },
      );
    }
    const dcodeOwner = this.runtimeByDCodeSessionId.get(dcodeSessionId)
      ?? this.openingDCodeSessionIds.get(dcodeSessionId);
    if (dcodeOwner && dcodeOwner !== runtimeId) {
      throw new PiHostError("SESSION_ALREADY_ACTIVE", "D Code Session is already active", {
        dcodeSessionId,
        runtimeId: dcodeOwner,
      });
    }
    this.openingDCodeSessionIds.set(dcodeSessionId, runtimeId);
    try {
      const store = await this.getProductStore();
      await this.assertWorkerRuntimeWorkspaceBeforeBinding({
        store,
        runtimeId,
        taskId,
        dcodeSessionId,
        ...(agentRunId ? { agentRunId } : {}),
        scope,
        workspace,
      });
      await this.assertNonWorkerRuntimeWorkspaceBeforeBinding({
        store,
        taskId,
        dcodeSessionId,
        ...(agentRunId ? { agentRunId } : {}),
        scope,
        workspace,
      });
      await this.ensureDCodeRuntimeModelCatalog();
      await this.runtimePromptContext({
        runtimeId,
        scope,
        taskId,
        dcodeSessionId,
        ...(agentRunId ? { agentRunId } : {}),
        workspace,
      });
      let binding = await store.sessionRuntimeBinding(dcodeSessionId);
      if (!binding) {
        const created = await this.createSession(workspace.cwd) as {
          session: SessionSummary;
        };
        binding = (await store.bindSessionRuntime({
          taskId,
          sessionId: dcodeSessionId,
          adapterSessionId: created.session.id,
          adapterSessionPath: created.session.path,
          cwd: created.session.cwd,
        })).binding;
      }
      const identity: RuntimeIdentity = {
        runtimeId,
        scope,
        taskId,
        dcodeSessionId,
        ...(agentRunId ? { agentRunId } : {}),
        adapterSessionId: binding.adapterSessionId,
        workspace: {
          workspaceId: workspace.workspaceId,
          cwd: workspace.cwd,
          access: workspace.access,
        },
      };
      await this.validateRuntimeIdentity(identity, binding.adapterSessionId);
      const opened = await this.openSessionWithRepairHint(
        binding.adapterSessionId,
        undefined,
        undefined,
        undefined,
        identity,
      );
      return { binding, runtime: opened };
    } finally {
      this.openingDCodeSessionIds.delete(dcodeSessionId);
    }
  }



  private async closeRuntime(runtimeId: string): Promise<void> {
    await this.runtimeContext.run(runtimeId, async () => { await this.closeActive(); });
  }


  private async provisionTeamWorkerWorktrees(input: {
    store: ProductStore;
    task: TaskRecord;
    teamRunId: string;
    agentRuns: AgentRunRecord[];
    expectedStoreRevision?: number;
    requestId: string;
    projects: Array<{ id: string; directory: string }>;
    taskContextSources: TaskContextSourceRecord[];
  }): Promise<Map<string, ManagedWorkerWorktreeRecord>> {
    const workspaceSnapshot=await input.store.snapshot();
    const workers = input.agentRuns.filter((agentRun) => agentRun.role === "worker" && !this.isDirectWorker(workspaceSnapshot,agentRun));
    if (workers.length === 0) return new Map();
    const scope = input.task.scope;
    if (scope.kind !== "project") {
      throw new PiHostError(
        "WORKSPACE_PROJECT_SCOPE_REQUIRED",
        "Managed worktrees require a Git Project; ordinary directories use the task-directory worker policy",
      );
    }
    const project = input.projects.find((candidate) => candidate.id === scope.projectId);
    if (!project) {
      throw new PiHostError("WORKSPACE_GIT_REPOSITORY_REQUIRED", "Worker Project Scope has no Project directory");
    }
    const selectedScopeDocumentPaths = input.taskContextSources
      .filter((contextSource) => contextSource.kind === "scope_document")
      .map((contextSource) => contextSource.relativePath);
    let plans;
    try {
      const source = await inspectManagedWorkerWorktreeSource({ projectDirectory: project.directory });
      await assertManagedWorkerWorktreeContextSourcesMaterialize({
        source,
        relativePaths: selectedScopeDocumentPaths,
        includeCurrentAgents: true,
      });
      plans = [];
      for (const worker of workers) {
        plans.push(await planManagedWorkerWorktree({
          runtimeDirectory: input.store.layout.runtimeDirectory,
          agentRunId: worker.id,
          source,
        }));
      }
    } catch (error) {
      if (error instanceof ManagedWorkerWorktreeError) {
        throw new PiHostError(error.code, error.message);
      }
      throw error;
    }
    const prepared = await input.store.prepareManagedWorkerWorktrees({
      requestId: derivedRequestId("managed-worktree-prepare", {
        requestId: input.requestId,
        taskId: input.task.id,
        teamRunId: input.teamRunId,
      }),
      expectedStoreRevision: input.expectedStoreRevision,
      scope: input.task.scope,
      taskId: input.task.id,
      teamRunId: input.teamRunId,
      plans,
    });
    this.options.emit("foundation.changed", {
      storeRevision: prepared.storeRevision,
      kind: "managedWorkerWorktree.prepared",
      entityKind: "artifact",
      entityId: input.teamRunId,
      taskId: input.task.id,
    });
    const preparedByAgentRun = new Map(prepared.worktrees.map((worktree) => [worktree.agentRunId, worktree]));
    const ready = new Map<string, ManagedWorkerWorktreeRecord>();
    for (const plan of plans) {
      const preparedWorktree = preparedByAgentRun.get(plan.agentRunId);
      if (!preparedWorktree) {
        throw new PiHostError("WORKSPACE_MANAGED_WORKTREE_UNKNOWN", "Worker worktree preparation returned no durable mapping");
      }
      let provisioned;
      try {
        provisioned = await provisionManagedWorkerWorktree(plan, {
          contextRelativePaths: selectedScopeDocumentPaths,
          includeCurrentAgents: true,
        });
      } catch (error) {
        const code = error instanceof ManagedWorkerWorktreeError
          ? error.code
          : "WORKSPACE_WORKTREE_CREATE_UNKNOWN";
        const state = [
          "WORKSPACE_WORKTREE_CREATE_FAILED",
          "WORKSPACE_GIT_UNAVAILABLE",
          "WORKSPACE_GIT_REPOSITORY_REQUIRED",
          "WORKSPACE_SOURCE_DIRTY",
          "WORKSPACE_SOURCE_HEAD_REQUIRED",
          "WORKSPACE_CONTEXT_SOURCE_NOT_MATERIALIZED",
        ].includes(code)
          ? "failed" as const
          : "unknown" as const;
        const resultDigest = `sha256:${createHash("sha256").update(`${code}\0${plan.artifactId}`).digest("hex")}`;
        let finished;
        try {
          finished = await input.store.finishManagedWorkerWorktree({
            requestId: derivedRequestId("managed-worktree-failure", {
              requestId: input.requestId,
              artifactId: preparedWorktree.artifactId,
              state,
              code,
            }),
            artifactId: preparedWorktree.artifactId,
            provisionAttemptId: preparedWorktree.provisionAttemptId,
            state,
            resultDigest,
            failureCode: code,
          });
        } catch (persistenceError) {
          throw new PiHostError(
            "WORKSPACE_MANAGED_WORKTREE_UNKNOWN",
            "Worker worktree operation failed and D Code could not persist its terminal state",
            { failureCode: code, persistence: errorRecord(persistenceError).code },
          );
        }
        this.options.emit("foundation.changed", {
          storeRevision: finished.storeRevision,
          kind: `managedWorkerWorktree.${state}`,
          entityKind: "artifact",
          entityId: finished.worktree.artifactId,
          taskId: input.task.id,
          agentRunId: plan.agentRunId,
        });
        throw new PiHostError(
          code,
          error instanceof Error ? error.message : "Worker worktree could not be provisioned safely",
        );
      }
      const resultDigest = `sha256:${createHash("sha256").update(JSON.stringify({
        workspaceId: provisioned.workspaceId,
        worktreeRoot: provisioned.worktreeRoot,
        workspaceCwd: provisioned.workspaceCwd,
        baseCommit: provisioned.baseCommit,
      })).digest("hex")}`;
      let finished;
      try {
        finished = await input.store.finishManagedWorkerWorktree({
          requestId: derivedRequestId("managed-worktree-ready", {
            requestId: input.requestId,
            artifactId: preparedWorktree.artifactId,
          }),
          artifactId: preparedWorktree.artifactId,
          provisionAttemptId: preparedWorktree.provisionAttemptId,
          state: "ready",
          resultDigest,
        });
      } catch (persistenceError) {
        throw new PiHostError(
          "WORKSPACE_MANAGED_WORKTREE_UNKNOWN",
          "Worker worktree was created but D Code could not persist its ready state",
          { persistence: errorRecord(persistenceError).code },
        );
      }
      ready.set(plan.agentRunId, finished.worktree);
      this.options.emit("foundation.changed", {
        storeRevision: finished.storeRevision,
        kind: "managedWorkerWorktree.ready",
        entityKind: "artifact",
        entityId: finished.worktree.artifactId,
        taskId: input.task.id,
        agentRunId: plan.agentRunId,
      });
    }
    return ready;
  }




  private async createSession(cwd: string): Promise<unknown> {
    this.assertWriteHealthy();
    let canonicalCwd: string;
    try {
      canonicalCwd = await realpath(cwd);
      if (!(await stat(canonicalCwd)).isDirectory()) throw new Error("not a directory");
    } catch (error) {
      throw new PiHostError("CWD_NOT_ACCESSIBLE", `Working directory is not accessible: ${cwd}`, {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    const baseDirectory=this.runtimeContext.getStore()?join((await this.getProductStore()).layout.runtimeDirectory,"pi-sessions"):this.sessionsDirectory;
    const sessionDir = join(baseDirectory, sessionDirectoryName(canonicalCwd));
    const draft = SessionManager.create(canonicalCwd, sessionDir);
    const sessionPath = draft.getSessionFile();
    if (!sessionPath) throw new PiHostError("SESSION_CREATE_FAILED", "Pi did not allocate a session path");
    const header = draft.getHeader();
    if (!header) throw new PiHostError("SESSION_CREATE_FAILED", "Pi did not create a session header");
    draft.appendCustomEntry(D_CODE_SESSION_ORIGIN_TYPE, {
      version: 1,
      sessionId: draft.getSessionId(),
    });
    const initialDocument = [header, ...draft.getEntries()]
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    this.assertWriteHealthy();
    await publishNewFileAtomically(sessionPath, `${initialDocument}\n`);
    this.searchIndex.invalidate();
    const summary: SessionSummary = {
      path: sessionPath,
      id: draft.getSessionId(),
      cwd: canonicalCwd,
      ...(header.parentSession ? { parentSessionPath: header.parentSession } : {}),
      created: header.timestamp,
      modified: header.timestamp,
      messageCount: 0,
      firstMessage: "",
    };
    // The complete Header + origin document is the creation commit point. Return
    // before closing an existing writable runtime: that cleanup can legitimately
    // take several seconds, but it must not delay confirmation that the new file
    // already exists. The App opens this Session as a separate follow-up request.
    return {
      created: true,
      session: summary,
      activation: { status: "created" },
    };
  }

  private async copySession(sessionId: string, targetCwd: string,productOwned=false): Promise<unknown> {
    this.assertWriteHealthy();
    const current = this.active;
    let source: SessionSummary;
    let temporaryLease: SessionLease | undefined;
    let assertSourceStable: () => Promise<void>;

    try {
      if (current && current.inspection.summary.id === sessionId) {
        this.assertCopyIdle(current);
        await this.assertLeaseStable(current);
        const stableVersion = await readSessionFileVersion(current.inspection.summary.path);
        source = current.inspection.summary;
        assertSourceStable = async () => {
          this.assertCopyIdle(current);
          await this.assertLeaseStable(current);
          const finalVersion = await readSessionFileVersion(source.path);
          if (!sameSessionFileVersion(stableVersion, finalVersion)) {
            throw new PiHostError(
              "SESSION_CHANGED_DURING_COPY",
              "源会话在复制期间发生了变化，请重试",
              { sessionId },
            );
          }
          this.assertCopyIdle(current);
          await this.assertLeaseStable(current);
        };
      } else {
        const summary = await this.reader.resolve(sessionId);
        const lease = await SessionLease.acquire({
          agentDir: this.leaseAgentDir,
          sessionId,
          sessionPath: summary.path,
          quietWindowMs: this.leaseQuietWindowMs,
        });
        temporaryLease = lease;
        const stableVersion = await readSessionFileVersion(summary.path);
        source = summary;
        assertSourceStable = async () => {
          await lease.assertUnchanged();
          const finalVersion = await readSessionFileVersion(source.path);
          if (!sameSessionFileVersion(stableVersion, finalVersion)) {
            throw new PiHostError(
              "SESSION_CHANGED_DURING_COPY",
              "源会话在复制期间发生了变化，请重试",
              { sessionId },
            );
          }
          await lease.assertUnchanged();
        };
      }
      const copier=productOwned?new SessionCopier(join((await this.getProductStore()).layout.runtimeDirectory,"pi-sessions")):this.sessionCopier;
      const result = await copier.copy({ source, targetCwd, assertSourceStable, sanitizeCredentials:productOwned });
      this.searchIndex.invalidate();
      return result;
    } finally {
      if (temporaryLease) {
        try { await temporaryLease.release(); }
        catch (error) {
          this.options.emit("session.cleanupError", {
            sessionId,
            step: "copy lease release",
            ...errorRecord(error),
          });
          this.poisonWritesForSession(sessionId, "A copied session lease could not be released");
        }
      }
    }
  }

  /**
   * Project directory migration keeps existing Pi Session identities. The Host
   * owns every JSONL write and closes a matching active runtime before Header
   * `cwd` values change, so Swift never edits Pi storage directly.
   */
  private async relocateSessionCwd(sourceCwd: string, targetCwd: string, moveFiles: boolean): Promise<unknown> {
    this.assertWriteHealthy();
    const canonicalDirectory = async (cwd: string, code: string): Promise<string> => {
      try {
        const canonical = await realpath(cwd);
        if (!(await stat(canonical)).isDirectory()) throw new Error("not a directory");
        return canonical;
      } catch (error) {
        throw new PiHostError(code, `Project directory is not accessible: ${cwd}`, {
          cwd,
          cause: error instanceof Error ? error.message : String(error),
        });
      }
    };
    const canonicalSource = await canonicalDirectory(sourceCwd, "SOURCE_CWD_NOT_ACCESSIBLE");
    const canonicalTarget = await canonicalDirectory(targetCwd, "TARGET_CWD_NOT_ACCESSIBLE");
    if (canonicalSource === canonicalTarget) {
      throw new PiHostError("CWD_UNCHANGED", "The target directory is already the Project directory");
    }

    let closedActiveSessionId: string | undefined;
    const active = this.active;
    const activeCwd = active
      ? await realpath(active.inspection.summary.cwd).catch(() => active.inspection.summary.cwd)
      : undefined;
    if (active && activeCwd === canonicalSource) {
      this.assertCopyIdle(active);
      await this.assertLeaseStable(active);
      closedActiveSessionId = active.inspection.summary.id;
      await this.closeActive();
      this.assertWriteHealthy();
    }

    const sessions = await this.reader.list({
      cwdScope: { match: "exact", paths: [canonicalSource] },
    });
    const leases = new Map<string, SessionLease>();
    try {
      for (const summary of [...sessions].sort((left, right) => left.id.localeCompare(right.id))) {
        const lease = await SessionLease.acquire({
          agentDir: this.leaseAgentDir,
          sessionId: summary.id,
          sessionPath: summary.path,
          quietWindowMs: this.leaseQuietWindowMs,
        });
        leases.set(summary.id, lease);
        await lease.assertUnchanged();
        const inspection = await this.reader.inspect(summary.id);
        if (inspection.summary.path !== summary.path || inspection.summary.cwd !== summary.cwd) {
          throw new PiHostError(
            "SESSION_CHANGED_DURING_MIGRATION",
            "A Project session changed before its directory could be migrated",
            { sessionId: summary.id, expectedPath: summary.path, expectedCwd: summary.cwd, actual: inspection.summary },
          );
        }
      }
      const result = await this.projectDirectoryMigrator.relocate({
        sourceCwd: canonicalSource,
        targetCwd: canonicalTarget,
        sessions,
        moveFiles,
        assertStable: async (summary) => {
          const lease = leases.get(summary.id);
          if (!lease) throw new PiHostError("SESSION_LEASE_MISSING", "Migration lost its Session lease", { sessionId: summary.id });
          await lease.assertUnchanged();
          const actual = await this.reader.resolve(summary.id);
          if (actual.path !== summary.path || actual.cwd !== summary.cwd) {
            throw new PiHostError(
              "SESSION_CHANGED_DURING_MIGRATION",
              "A Project session changed during directory migration",
              { sessionId: summary.id, expectedPath: summary.path, expectedCwd: summary.cwd, actual },
            );
          }
        },
      });
      this.searchIndex.invalidate();
      this.options.emit("session.cwdRelocated", {
        ...result,
        ...(closedActiveSessionId ? { closedActiveSessionId } : {}),
      });
      return { ...result, ...(closedActiveSessionId ? { closedActiveSessionId } : {}) };
    } catch (error) {
      if (error instanceof ProjectDirectoryMigrationError) {
        throw new PiHostError(error.code, error.message, error.details);
      }
      throw error;
    } finally {
      for (const lease of [...leases.values()].reverse()) {
        try {
          await lease.release();
        } catch (error) {
          this.options.emit("session.cleanupError", {
            step: "project directory migration lease release",
            ...errorRecord(error),
          });
        }
      }
    }
  }

  private async trashSession(sessionId: string): Promise<unknown> {
    this.assertWriteHealthy();
    const summary = await this.assertTrashEligible(sessionId);
    const summaryPath = summary.path;
    const current = this.active;
    if (current?.inspection.summary.id === sessionId) {
      await this.closeActive();
    }

    let lease: SessionLease | undefined;
    let trashed = false;
    let movedPath = summaryPath;
    const extension = extname(summaryPath) || ".jsonl";
    const originalName = basename(summaryPath, extension);
    const trashPath = join(this.trashDirectory, `${originalName}-${randomUUID()}${extension}`);
    const quarantinePath = join(
      dirname(summaryPath),
      `.${basename(summaryPath)}-${randomUUID()}.trash-pending`,
    );
    try {
      // Do all potentially slow directory preparation before the final source
      // checks. There must be no mkdir gap between validation and isolation.
      await mkdir(this.trashDirectory, { recursive: true, mode: 0o700 });
      lease = await SessionLease.acquire({
        agentDir: this.leaseAgentDir,
        sessionId,
        sessionPath: summaryPath,
        quietWindowMs: this.leaseQuietWindowMs,
      });
      // Eligibility was first checked for a fast user-facing error. Re-read it
      // under the Lease so an external append or duplicate identity cannot turn
      // an empty-session cleanup into removal of a non-empty Session.
      await this.assertTrashEligible(sessionId, summaryPath);
      await lease.assertUnchanged();

      // First remove the JSONL from ordinary discovery without deleting it.
      // A Pi process with an existing file descriptor may still append, so the
      // quarantined document is held through another quiet window and checked
      // again before and after entering the Trash.
      await rename(summaryPath, quarantinePath);
      movedPath = quarantinePath;
      await this.assertQuarantinedTrashEligible(quarantinePath, summaryPath, sessionId);
      await rename(quarantinePath, trashPath);
      movedPath = trashPath;
      await this.assertQuarantinedTrashEligible(trashPath, summaryPath, sessionId);
      trashed = true;
      this.searchIndex.invalidate();
      this.options.emit("session.trashed", { sessionId, originalPath: summaryPath, trashPath });
      return { trashed: true, sessionId, originalPath: summaryPath, trashPath };
    } catch (error) {
      let failure = error;
      if (!trashed && movedPath !== summaryPath) {
        try {
          // link() is intentionally no-replace. Never overwrite a path that an
          // external Pi process may have recreated while this file was hidden.
          await link(movedPath, summaryPath);
          await unlink(movedPath);
          movedPath = summaryPath;
          this.searchIndex.invalidate();
        } catch (restoreError) {
          failure = new PiHostError(
            "SESSION_TRASH_RESTORE_FAILED",
            "The session was preserved, but its original path could not be restored",
            {
              sessionId,
              preservedPath: movedPath,
              originalPath: summaryPath,
              failure: errorRecord(error),
              restoreFailure: errorRecord(restoreError),
            },
          );
        }
      }
      throw failure;
    } finally {
      if (lease) {
        try {
          await lease.release();
        } catch (error) {
          this.options.emit("session.cleanupError", {
            sessionId,
            step: "trash lease release",
            ...errorRecord(error),
          });
          this.poisonWritesForSession(sessionId, "A trashed session lease could not be released");
        }
      }
    }
  }

  private async assertQuarantinedTrashEligible(
    quarantinedPath: string,
    originalPath: string,
    sessionId: string,
  ): Promise<void> {
    const beforeQuiet = await readSessionFileVersion(quarantinedPath);
    await new Promise((resolve) => setTimeout(resolve, this.leaseQuietWindowMs));
    const afterQuiet = await readSessionFileVersion(quarantinedPath);
    if (!sameSessionFileVersion(beforeQuiet, afterQuiet)) {
      throw new PiHostError(
        "SESSION_NOT_IDLE",
        "The session changed while it was being moved to the Trash",
        { sessionId },
      );
    }
    const stable = await this.inspectStablePath(quarantinedPath, sessionId);
    if (!await this.reader.hasDCodeOrigin(stable.inspection.summary)) {
      throw new PiHostError(
        "SESSION_TRASH_NOT_ALLOWED",
        "Only sessions created by D Code can be moved to the Trash",
        { sessionId },
      );
    }
    if (stable.inspection.summary.messageCount !== 0) {
      throw new PiHostError(
        "SESSION_TRASH_NOT_EMPTY",
        "Only empty D Code sessions can be moved to the Trash in this version",
        { sessionId, messageCount: stable.inspection.summary.messageCount },
      );
    }
    if (await this.reader.hasDescendantSession(originalPath)) {
      throw new PiHostError(
        "SESSION_HAS_DESCENDANTS",
        "This session is referenced by a copied or forked session; archive it instead",
        { sessionId },
      );
    }
    const finalVersion = await readSessionFileVersion(quarantinedPath);
    if (!sameSessionFileVersion(stable.version, finalVersion)) {
      throw new PiHostError(
        "SESSION_NOT_IDLE",
        "The session changed while its descendants were being checked",
        { sessionId },
      );
    }
  }

  private async assertTrashEligible(sessionId: string, expectedPath?: string): Promise<SessionSummary> {
    const summary = await this.reader.resolve(sessionId);
    if (expectedPath && summary.path !== expectedPath) {
      throw new PiHostError(
        "SESSION_IDENTITY_CHANGED",
        "The session path changed before it could be moved to the Trash",
        { sessionId, expectedPath, actualPath: summary.path },
      );
    }
    if (!await this.reader.hasDCodeOrigin(summary)) {
      throw new PiHostError(
        "SESSION_TRASH_NOT_ALLOWED",
        "Only sessions created by D Code can be moved to the Trash",
        { sessionId },
      );
    }
    if (summary.messageCount !== 0) {
      throw new PiHostError(
        "SESSION_TRASH_NOT_EMPTY",
        "Only empty D Code sessions can be moved to the Trash in this version",
        { sessionId, messageCount: summary.messageCount },
      );
    }
    if (await this.reader.hasDescendantSession(summary.path)) {
      throw new PiHostError(
        "SESSION_HAS_DESCENDANTS",
        "This session is referenced by a copied or forked session; archive it instead",
        { sessionId },
      );
    }
    return summary;
  }

  private assertCopyIdle(active: WritableSession): void {
    if (active.conflict
      || active.session.isStreaming
      || active.session.isCompacting
      || active.session.pendingMessageCount > 0
      || active.session.isBashRunning
      || active.session.hasPendingBashMessages
      || active.ui.hasPendingDialogs) {
      throw new PiHostError(
        "SESSION_BUSY",
        "请等待当前生成、工具、压缩或结构化交互结束后再复制会话",
        { sessionId: active.session.sessionId },
      );
    }
  }

  private assertPathActionIdle(active: WritableSession): void {
    if (active.conflict
      || active.session.isStreaming
      || active.session.isCompacting
      || active.session.pendingMessageCount > 0
      || active.session.isBashRunning
      || active.session.hasPendingBashMessages
      || active.ui.hasPendingDialogs) {
      throw new PiHostError(
        "SESSION_BUSY",
        "请等待当前生成、工具、压缩或结构化交互结束后再切换会话路径",
        { sessionId: active.session.sessionId },
      );
    }
  }

  private assertSessionMetadataIdle(active: WritableSession): void {
    if (active.conflict
      || active.session.isStreaming
      || active.session.isCompacting
      || active.session.pendingMessageCount > 0
      || active.session.isBashRunning
      || active.session.hasPendingBashMessages
      || active.ui.hasPendingDialogs) {
      throw new PiHostError(
        "SESSION_BUSY",
        "请等待当前生成、工具、压缩或结构化交互结束后再重命名会话",
        { sessionId: active.session.sessionId },
      );
    }
  }

  private assertExpectedEntry(
    inspection: SessionInspection,
    expectedEntryId?: string,
    expectedEntryDigest?: string,
  ): void {
    if (!expectedEntryId) return;
    const entry = inspection.entries.find((candidate) => candidate.id === expectedEntryId);
    if (entry && expectedEntryDigest === undefined) return;
    if (entry?.type === "message" && expectedEntryDigest !== undefined) {
      const searchable = extractSearchableMessage(entry.message);
      if (searchable && searchEntryDigest(searchable.role, searchable.body) === expectedEntryDigest) return;
    }
    throw new PiHostError(
      "SEARCH_TARGET_STALE",
      "The search result is no longer unchanged on the current session path",
      { sessionId: inspection.summary.id, expectedEntryId, expectedEntryDigest },
    );
  }

  /** 打开即接管的租约获取：force 抢占其他 D Code 实例；静默窗口内文件仍在变时轮询等待稳定。 */
  private async acquireLeaseUntilIdle(sessionId: string, sessionPath: string): Promise<SessionLease> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        return await SessionLease.acquire({
          agentDir: this.leaseAgentDir,
          sessionId,
          sessionPath,
          quietWindowMs: this.leaseQuietWindowMs,
          force: true,
        });
      } catch (error) {
        if (!(error instanceof SessionLeaseError) || error.code !== "SESSION_NOT_IDLE") throw error;
        lastError = error;
        await new Promise<void>((resolve) => setTimeout(resolve, this.leaseQuietWindowMs));
      }
    }
    throw new PiHostError(
      "SESSION_NOT_IDLE",
      "The session kept changing while D Code was taking it over",
      { sessionId, cause: lastError instanceof Error ? lastError.message : String(lastError) },
    );
  }

  /** session.open 的 ADR 0027 包装：INVALID_SESSION 时在错误 details 附带
   * 可修性与原因，供 Swift 呈现“备份并修复后打开”入口。 */
  private async openSessionWithRepairHint(
    sessionId: string,
    expectedEntryId?: string,
    expectedEntryDigest?: string,
    selectedLeafId?: string | null,
    runtimeIdentity?: RuntimeIdentity,
  ): Promise<unknown> {
    try {
      return await this.openSession(sessionId, expectedEntryId, expectedEntryDigest, selectedLeafId, runtimeIdentity);
    } catch (error) {
      if (error instanceof SessionReadError && error.code === "INVALID_SESSION") {
        const inspection = await this.reader.inspectRepairability(sessionId).catch(() => null);
        const baseDetails = typeof error.details === "object" && error.details !== null
          ? error.details as Record<string, unknown>
          : {};
        throw new PiHostError("INVALID_SESSION", error.message, {
          ...baseDetails,
          repairable: inspection?.repairable ?? false,
          ...(inspection ? { repairReason: inspection.reason } : {}),
          ...(inspection?.repairable ? { trimmedContent: inspection.trimmedContent } : {}),
        });
      }
      throw error;
    }
  }

  private async openSession(
    sessionId: string,
    expectedEntryId?: string,
    expectedEntryDigest?: string,
    selectedLeafId?: string | null,
    runtimeIdentity?: RuntimeIdentity,
  ): Promise<unknown> {
    this.assertWriteHealthy();
    const inspection = await this.reader.inspect(sessionId, selectedLeafId);
    if(this.workspaceFileWrites.conflict(inspection.summary.cwd))throw new PiHostError("WORKSPACE_IN_USE","目录正在保存文件，请稍后打开运行");
    if(!runtimeIdentity&&this.pendingProjectDirectories().some(path=>this.workspacesOverlap(path,inspection.summary.cwd)))throw new PiHostError("WORKSPACE_IN_USE","目录更换结果尚未确认，请先完成恢复");
    const legacyRoot=runtimeIdentity?undefined:inspection.summary.cwd;
    if(legacyRoot)this.openingLegacyWorkspaces.add(legacyRoot);
    try{return await this.openInspectedSession(sessionId,inspection,expectedEntryId,expectedEntryDigest,selectedLeafId,runtimeIdentity);}
    finally{if(legacyRoot)this.openingLegacyWorkspaces.delete(legacyRoot);}
  }

  private async openInspectedSession(
    sessionId:string,
    inspection:SessionInspection,
    expectedEntryId?:string,
    expectedEntryDigest?:string,
    selectedLeafId?:string|null,
    runtimeIdentity?:RuntimeIdentity,
  ):Promise<unknown>{
    if ((inspection.header.version ?? 1) !== CURRENT_SESSION_VERSION) {
      throw new PiHostError(
        "SESSION_MIGRATION_REQUIRED",
        `Session version ${inspection.header.version ?? 1} must be migrated outside writable open`,
      );
    }
    // 先校验搜索目标与版本，失败时不影响当前已打开的会话。
    this.assertExpectedEntry(inspection, expectedEntryId, expectedEntryDigest);
    if (runtimeIdentity) {
      const adapterCwd = await realpath(inspection.summary.cwd);
      if (adapterCwd !== runtimeIdentity.workspace.cwd) {
        throw new PiHostError(
          "RUNTIME_IDENTITY_MISMATCH",
          "Runtime workspace does not match the Pi adapter session cwd",
          { workspaceCwd: runtimeIdentity.workspace.cwd, adapterCwd },
        );
      }
      const workspaceOwner = this.workspaceConflict(
        this.workspaceClaimKey(runtimeIdentity.workspace),
        runtimeIdentity.runtimeId,
        runtimeIdentity.workspace.access,
      );
      if (workspaceOwner) {
        throw new PiHostError(
          "WORKSPACE_IN_USE",
          "The write-capable Runtime workspace is already active",
          { cwd: runtimeIdentity.workspace.cwd, runtimeId: workspaceOwner },
        );
      }
      this.openingAdapterSessionIds.set(runtimeIdentity.adapterSessionId, runtimeIdentity.runtimeId);
      this.openingDCodeSessionIds.set(runtimeIdentity.dcodeSessionId, runtimeIdentity.runtimeId);
      this.addWorkspaceClaim(
        this.openingWorkspaceClaims,
        this.workspaceClaimKey(runtimeIdentity.workspace),
        runtimeIdentity.runtimeId,
        runtimeIdentity.workspace.access,
      );
    }
    await this.closeActive();
    // 打开即接管：D Code 是一等公民。force 抢占其他 D Code 实例的租约；
    // 静默窗口内文件仍在变（Pi CLI 在途写入）时轮询到稳定再完成接管，超时如实报错。
    let lease: SessionLease;
    try {
      lease = await this.acquireLeaseUntilIdle(sessionId, inspection.summary.path);
    } catch (error) {
      if (runtimeIdentity) {
        this.openingAdapterSessionIds.delete(runtimeIdentity.adapterSessionId);
        this.openingDCodeSessionIds.delete(runtimeIdentity.dcodeSessionId);
        this.releaseWorkspaceClaim(
          this.openingWorkspaceClaims,
          this.workspaceClaimKey(runtimeIdentity.workspace),
          runtimeIdentity.runtimeId,
        );
      }
      throw error;
    }

    let session: AgentSession | undefined;
    let auxiliary:AuxiliaryProcesses|undefined;
    let ui: ExtensionUIBridge | undefined;
    let unsubscribe: (() => void) | undefined;
    let conflictTimer: ReturnType<typeof setInterval> | undefined;
    let attemptController: DCodeOperationAttemptController | undefined;
    let agentRequestController: DCodeAgentRequestController | undefined;
    try {
      const manager = SessionManager.open(inspection.summary.path);
      if (selectedLeafId !== undefined) {
        if (selectedLeafId === null) manager.resetLeaf();
        else manager.branch(selectedLeafId);
      }
      await lease.assertUnchanged();
      const fastMode = new DCodeFastController();
      let activeForFacts: WritableSession | undefined;
      const promptContext = runtimeIdentity ? await this.runtimePromptContext(runtimeIdentity) : undefined;
      attemptController = runtimeIdentity ? new DCodeOperationAttemptController() : undefined;
      agentRequestController = runtimeIdentity?.agentRunId ? new DCodeAgentRequestController() : undefined;
      let assembledPrompt = promptContext
        ? assembleDCodeSystemPrompt({
          environment: promptContext.environment,
          documents: promptContext.documents,
          ...(promptContext.importedHistory ? { importedHistory: promptContext.importedHistory } : {}),
          tools: [],
        })
        : undefined;
      const factsContext = {
        sessionId: () => activeForFacts?.inspection.summary.id,
        cwd: () => activeForFacts?.inspection.summary.cwd,
        paths: () => (activeForFacts?.inspection.paths ?? []).map((path) => ({
          id: path.id,
          title: path.title,
          isCurrent: path.isCurrent,
          entryCount: path.entryCount,
        })),
      };
      const legacySettings = SettingsManager.create(manager.getCwd(), this.agentDir);
      // Pi may save defaults from setModel/setThinking. Native Runtime settings
      // are private copies: D Code Product Store remains the persistent owner.
      const privateSettings = {
        global: JSON.stringify(legacySettings.getGlobalSettings()),
        project: JSON.stringify(legacySettings.getProjectSettings()),
      };
      const sourceSettingsManager = runtimeIdentity
        ? SettingsManager.fromStorage({
          withLock: (scope, update) => {
            const next = update(privateSettings[scope]);
            if (next !== undefined) privateSettings[scope] = next;
          },
        }, { projectTrusted: legacySettings.isProjectTrusted() })
        : legacySettings;
      const resourceLoader = new DCodeResourceLoader({
        cwd: manager.getCwd(),
        agentDir: this.agentDir,
        sourceSettingsManager,
        extensionFactories: [
          { name: "dcode-fast", hidden: true, factory: createDCodeFastExtension(fastMode) },
          { name: "dcode-facts", hidden: true, factory: createDCodeFactsExtension(factsContext) },
          ...(attemptController
            ? [{
              name: "dcode-operation-attempts",
              hidden: true,
              factory: createDCodeOperationAttemptExtension(attemptController),
            }]
            : []),
          ...(runtimeIdentity && ["coordinator","verifier"].includes(promptContext?.environment.role??"")
            ? [{name:"dcode-verification",hidden:true,factory:createVerificationExtension(promptContext!.environment.role,(callId,action)=>this.handleVerification(runtimeIdentity,callId,action))}] : []),
          ...(runtimeIdentity && promptContext?.environment.role === "coordinator"
            ? [{name:"dcode-collaboration",hidden:true,factory:createCollaborationExtension((callId,action)=>this.coordinateTeam(runtimeIdentity,callId,action))}] : []),
          ...(agentRequestController
            ? [{
              name: "dcode-agent-request",
              hidden: true,
              factory: createDCodeAgentRequestExtension(agentRequestController, {
                allowTaskAcceptance: promptContext?.environment.role === "coordinator",
              }),
            }]
            : []),
        ],
        ...(runtimeIdentity ? { systemPromptOverride: () => assembledPrompt?.text } : {}),
        ...(runtimeIdentity ? { allowExternalExtensions: false, disabledResources: () => new Set(this.productStore?.clientPreferences().disabledResources ?? []) } : {}),
      });
      await resourceLoader.reload();
      const sessionOptions = {
        cwd: manager.getCwd(),
        agentDir: this.agentDir,
        sessionManager: manager,
        settingsManager: sourceSettingsManager,
        resourceLoader,
        ...(promptContext && new Set(["explore", "verifier", "custom"]).has(promptContext.environment.role)
          ? {
            tools: [
              "read",
              "grep",
              "find",
              "ls",
              "dcode_facts",
              DCODE_AGENT_REQUEST_TOOL_NAME,
              ...(["coordinator","verifier"].includes(promptContext.environment.role)?[DCODE_VERIFICATION_TOOL_NAME]:[]),
              ...(promptContext.environment.role === "coordinator" ? [DCODE_TASK_ACCEPTANCE_TOOL_NAME, DCODE_TEAM_TOOL_NAME] : []),
            ],
          }
          : {}),
        sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile: inspection.summary.path },
      } satisfies CreateAgentSessionOptions;
      if(runtimeIdentity?.agentRunId){
        const sourceRuns=new Map<string,string>();
        auxiliary=new AuxiliaryProcesses(async(processInfo)=>{
          const store=await this.getProductStore();let sourceRun=sourceRuns.get(processInfo.id);
          if(!sourceRun){sourceRun=activeForFacts?.currentRun?.sessionRunId;if(!sourceRun)throw new PiHostError("RUN_REQUIRED","辅助进程缺少所属运行");sourceRuns.set(processInfo.id,sourceRun);}
          const result=await store.recordAuxiliaryProcess({requestId:`auxiliary:${randomUUID()}`,taskId:runtimeIdentity.taskId,agentRunId:runtimeIdentity.agentRunId!,runtimeId:runtimeIdentity.runtimeId,sessionRunId:sourceRun,process:processInfo});
          this.options.emit("foundation.changed",{kind:"auxiliaryProcess.changed",taskId:runtimeIdentity.taskId,storeRevision:result.storeRevision});
          if(processInfo.status==="exited"){sourceRuns.delete(processInfo.id);setImmediate(()=>{const active=activeForFacts;if(active&&!active.closing&&!active.currentRun&&!active.auxiliary?.hasLive){
            if(this.directWorkerRuntimes.has(runtimeIdentity.runtimeId))void this.closeRuntime(runtimeIdentity.runtimeId).catch(error=>this.options.emit("collaboration.failed",errorRecord(error)));
            else if(active.promptEnvironment?.role==="coordinator")void this.setCoordinatorAccess(active,"sharedReadOnly").catch(error=>this.options.emit("collaboration.failed",errorRecord(error)));
          }this.wakeCollaboration();});}
        });
      }
      const created = runtimeIdentity
        ? await createProcessAgentSession({
          ...sessionOptions,
          modelRuntime: await ModelRuntime.create({ authPath: join(this.agentDir, "auth.json"), modelsPath: join(this.agentDir, "models.json"), modelsStorePath: join((await this.getProductStore()).layout.root, "models-cache.json"), allowModelNetwork: false }),
          providerControl:this.providerRouteControl(runtimeIdentity,()=>activeForFacts),
          ...(auxiliary?{baseToolsOverride:{bash:auxiliary.tool(manager.getCwd())}}:{}),
          processOptions: {
            idleTimeoutMs: this.options.agentIdleTimeoutMs,
            onProcessChanged: async (processInfo) => {
              if(runtimeIdentity.agentRunId) {
                const recorded=await (await this.getProductStore()).recordAgentProcess({requestId:`process:${randomUUID()}`,runtimeId:runtimeIdentity.runtimeId,taskId:runtimeIdentity.taskId,agentRunId:runtimeIdentity.agentRunId,process:processInfo});
                this.options.emit("foundation.changed",{storeRevision:recorded.storeRevision,kind:"agentProcess.changed",taskId:runtimeIdentity.taskId});
              }
              this.options.emit("runtime.processChanged", {runtimeId:runtimeIdentity.runtimeId,taskId:runtimeIdentity.taskId,agentRunId:runtimeIdentity.agentRunId,process:processInfo});
            },
          },
        })
        : await createAgentSession(sessionOptions);
      session = created.session;
      if(promptContext?.environment.role==="coordinator" && runtimeIdentity?.workspace.access==="sharedReadOnly") session.setActiveToolsByName(session.getAllTools().filter(tool=>SHARED_READ_ONLY_TOOL_NAMES.has(tool.name)).map(tool=>tool.name));
      if (promptContext) {
        await registerCatalogProviders(session.modelRuntime, await (await this.getProductStore()).snapshot());
        const selectedModel = session.modelRuntime.getAvailableSnapshot().find((candidate) => (
          candidate.provider === promptContext.runtimeModelSelection.providerId
          && candidate.id === promptContext.runtimeModelSelection.modelId
        ));
        if (!selectedModel) {
          throw new PiHostError(
            "D_CODE_MODEL_RUNTIME_UNAVAILABLE",
            "The D Code-selected Model is unavailable in this Pi Runtime Adapter",
            { runtimeModelSelection: promptContext.runtimeModelSelection },
          );
        }
        await session.setModel(selectedModel);
      }
      let activePromptTools: DCodePromptTool[] = [];
      let toolsWritable = false;
      if (promptContext) {
        const activeToolNames = session.getActiveToolNames();
        const activeToolNameSet = new Set(activeToolNames);
        activePromptTools = session.getAllTools()
          .filter((tool) => activeToolNameSet.has(tool.name))
          .map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          }));
        toolsWritable = activePromptTools.some((tool) => !SHARED_READ_ONLY_TOOL_NAMES.has(tool.name));
        if (runtimeIdentity?.workspace.access === "sharedReadOnly" && toolsWritable) {
          throw new PiHostError(
            "WORKSPACE_ISOLATION_REQUIRED",
            "A sharedReadOnly Runtime resolved a write-capable Active Tool Set",
          );
        }
        assembledPrompt = assembleDCodeSystemPrompt({
          environment: {
            ...promptContext.environment,
            ...(session.model ? { modelProvider: session.model.provider, modelId: session.model.id } : {}),
          },
          documents: promptContext.documents,
          ...(promptContext.importedHistory ? { importedHistory: promptContext.importedHistory } : {}),
          tools: activePromptTools,
        });
        session.setActiveToolsByName(activeToolNames);
        // Pi 0.84.1 resets every turn to _baseSystemPrompt during preflight.
        // Install the D Code prompt as that base after the exact tool set is frozen;
        // a private one-turn override would be cleared before the Provider request.
        const internals = session as unknown as {
          _baseSystemPrompt: string;
          _systemPromptOverride?: string;
        };
        internals._baseSystemPrompt = assembledPrompt.text;
        internals._systemPromptOverride = undefined;
        session.agent.state.systemPrompt = assembledPrompt.text;
        if (session.systemPrompt !== assembledPrompt.text) {
          throw new PiHostError(
            "PROMPT_ASSEMBLY_FAILED",
            "D Code could not install its own System Prompt before Runtime activation",
          );
        }
        const manifestNames = [...activePromptTools.map((tool) => tool.name)].sort();
        const apiToolNames = [...session.getActiveToolNames()].sort();
        if (JSON.stringify(manifestNames) !== JSON.stringify(apiToolNames)) {
          throw new PiHostError(
            "TOOL_MANIFEST_MISMATCH",
            "D Code Active Tool Manifest does not match the Runtime API tools",
          );
        }
      }
      let active: WritableSession;
      ui = new ExtensionUIBridge((event, data) => {
        const run = active.currentRun;
        const details = typeof data === "object" && data !== null && !Array.isArray(data)
          ? data as Record<string, unknown>
          : {};
        if (run && event === "extension.request") {
          this.updateRunState(active, run, "waitingForUser", { waitingFor: runWaitKind(details.method) });
        } else if (run && event === "extension.closed" && run.state.phase === "waitingForUser") {
          if (active.ui.hasPendingDialogs) {
            this.updateRunState(active, run, "waitingForUser", {
              waitingFor: runWaitKind(active.ui.pendingDialogMethod),
            });
          } else {
            this.updateRunState(active, run, "running");
          }
        }
        this.emitRuntimeEvent(active, event, {
          ...details,
          sessionId: active.session.sessionId,
          ...(run ? { runId: run.id } : {}),
        });
      });
      active = {
        inspection,
        session,
        lease,
        ui,
        unsubscribe: () => undefined,
        conflictTimer: setInterval(() => undefined, 2 ** 30),
        leaseSync: Promise.resolve(),
        ownedMutationDepth: 0,
        activePlan: inspection.activePlan,
        activeProposal: inspection.activeProposal,
        fastMode,
        closing: false,
        ...(auxiliary?{auxiliary}:{}),
        ...(runtimeIdentity ? { runtimeIdentity } : {}),
        runtimeEventSequence: 0,
        seenPromptIds: new Map(),
        seenSteerIds: new Map(),
        ...(assembledPrompt ? { assembledPrompt } : {}),
        ...(promptContext ? { promptEnvironment: promptContext.environment } : {}),
        activePromptTools,
        toolsWritable,
        ...(attemptController ? { attemptController } : {}),
        ...(agentRequestController ? { agentRequestController } : {}),
      };
      activeForFacts = active;
      if (attemptController && runtimeIdentity) {
        const toolAttemptIds = new Map<string, string>();
        attemptController.bind({
          prepare: async (event) => {
            const run = active.currentRun;
            if (!run?.sessionRunId) {
              throw new PiHostError("OPERATION_ATTEMPT_MISSING_RUN", "Tool execution has no durable Session Run");
            }
            const parameterDigest = `sha256:${createHash("sha256")
              .update(JSON.stringify(event.input))
              .digest("hex")}`;
            const prepared = await (await this.getProductStore()).prepareToolAttempt({
              taskId: runtimeIdentity.taskId,
              sessionId: runtimeIdentity.dcodeSessionId,
              sessionRunId: run.sessionRunId,
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              parameterDigest,
            });
            toolAttemptIds.set(event.toolCallId, prepared.attemptId);
            this.emitRuntimeEvent(active, "operationAttempt.prepared", {
              attemptId: prepared.attemptId,
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              storeRevision: prepared.storeRevision,
            });
          },
          finish: async (event) => {
            const attemptId = toolAttemptIds.get(event.toolCallId);
            if (!attemptId) {
              throw new PiHostError("OPERATION_ATTEMPT_NOT_FOUND", "Tool Result has no prepared Operation Attempt");
            }
            const resultDigest = `sha256:${createHash("sha256")
              .update(JSON.stringify({ content: event.content, isError: event.isError }))
              .digest("hex")}`;
            const finished = await (await this.getProductStore()).finishOperationAttempt({
              attemptId,
              outcome: event.isError ? "failed" : "succeeded",
              resultDigest,
            });
            const evidence = await (await this.getProductStore()).recordToolEvidence({
              requestId: `tool-evidence:${attemptId}`,
              attemptId,
              toolName: event.toolName,
              outcome: event.isError ? "failed" : "succeeded",
              resultDigest,
            });
            toolAttemptIds.delete(event.toolCallId);
            this.emitRuntimeEvent(active, "operationAttempt.finished", {
              attemptId,
              toolCallId: event.toolCallId,
              outcome: finished.status,
              storeRevision: finished.storeRevision,
            });
            this.options.emit("foundation.changed", {
              storeRevision: evidence.storeRevision,
              kind: "evidence.recorded",
              entityKind: "evidence",
              entityId: evidence.evidence.id,
              taskId: runtimeIdentity.taskId,
              runtimeId: runtimeIdentity.runtimeId,
              agentRunId: runtimeIdentity.agentRunId,
            });
          },
        });
      }
      if (agentRequestController && runtimeIdentity?.agentRunId) {
        agentRequestController.bind(async (
          toolCallId: string,
          input: DCodeAgentRequestInput,
          signal?: AbortSignal,
        ) => {
          const run = active.currentRun;
          if (!run?.sessionRunId) {
            throw new PiHostError("AGENT_REQUEST_MISSING_RUN", "Agent Request has no durable Session Run");
          }
          const normalizedOptions = input.options.map((option) => ({
            id: option.id,
            label: option.label,
            ...(option.description ? { description: option.description } : {}),
            recommended: option.recommended === true,
          }));
          const credentialProbe = JSON.stringify({ kind: input.kind, prompt: input.prompt, options: normalizedOptions });
          if (redactCredentialText(credentialProbe).redacted) {
            throw new PiHostError(
              "CREDENTIAL_MATERIAL_REJECTED",
              "Agent Request may not write credential material into Product Store",
            );
          }
          const created = await (await this.getProductStore()).createAgentRequest({
            requestId: `agent-request-${createHash("sha256")
              .update(`${run.sessionRunId}\0${toolCallId}`)
              .digest("hex")
              .slice(0, 48)}`,
            taskId: runtimeIdentity.taskId,
            agentRunId: runtimeIdentity.agentRunId!,
            sessionId: runtimeIdentity.dcodeSessionId,
            sessionRunId: run.sessionRunId,
            runtimeId: runtimeIdentity.runtimeId,
            kind: input.kind,
            prompt: input.prompt,
            options: normalizedOptions,
          });
          this.updateRunState(active, run, "waitingForUser", { waitingFor: "input" });
          return await new Promise((resolve, reject) => {
            const onAbort = () => {
              const pending = this.pendingAgentRequests.get(created.agentRequest.id);
              if (pending) {
                this.pendingAgentRequests.delete(created.agentRequest.id);
                pending.removeAbortListener?.();
              }
              void this.getProductStore().then(async (store) => await store.cancelAgentRequest({
                requestId: `agent-request-cancel:${created.agentRequest.id}`,
                agentRequestId: created.agentRequest.id,
                reason: "runtime_aborted",
              })).then((cancelled) => {
                this.options.emit("foundation.changed", {
                  storeRevision: cancelled.storeRevision,
                  kind: "agentRequest.cancelled",
                  entityKind: "agentRequest",
                  entityId: cancelled.agentRequest.id,
                  taskId: cancelled.agentRequest.taskId,
                });
              }).catch((error) => {
                this.emitRuntimeEvent(active, "agentRequest.cancelFailed", errorRecord(error));
              });
              reject(new PiHostError("AGENT_REQUEST_ABORTED", "Agent Request was interrupted before it was answered"));
            };
            if (signal?.aborted) {
              onAbort();
              return;
            }
            if (signal) signal.addEventListener("abort", onAbort, { once: true });
            this.pendingAgentRequests.set(created.agentRequest.id, {
              runtimeId: runtimeIdentity.runtimeId,
              resolve: (answer) => resolve({ requestId: created.agentRequest.id, answer }),
              reject,
              ...(signal ? { removeAbortListener: () => signal.removeEventListener("abort", onAbort) } : {}),
            });
            this.options.emit("foundation.changed", {
              storeRevision: created.storeRevision,
              kind: "agentRequest.created",
              entityKind: "agentRequest",
              entityId: created.agentRequest.id,
              taskId: created.agentRequest.taskId,
              runtimeId: runtimeIdentity.runtimeId,
              agentRunId: runtimeIdentity.agentRunId,
            });
          });
        });
      }
      this.installPromptSourceBoundary(active);
      clearInterval(active.conflictTimer);
      this.active = active;
      if (runtimeIdentity) {
        this.openingAdapterSessionIds.delete(runtimeIdentity.adapterSessionId);
        this.openingDCodeSessionIds.delete(runtimeIdentity.dcodeSessionId);
        this.releaseWorkspaceClaim(
          this.openingWorkspaceClaims,
          this.workspaceClaimKey(runtimeIdentity.workspace),
          runtimeIdentity.runtimeId,
        );
      }
      const unsubscribeSession = session.subscribe((event) => this.onSessionEvent(active, event));
      const unsubscribePersistedEvents = session.agent.subscribe((event) => this.onPersistedAgentEvent(active, event));
      unsubscribe = () => {
        unsubscribeSession();
        unsubscribePersistedEvents();
      };
      active.unsubscribe = unsubscribe;
      await lease.acceptOwnedChange(agentSessionSnapshotDigest(session));
      await session.bindExtensions({
        uiContext: ui.context,
        mode: "rpc",
        commandContextActions: {
          waitForIdle: () => session?.waitForIdle() ?? Promise.resolve(),
          newSession: async () => ({ cancelled: true }),
          fork: async () => ({ cancelled: true }),
          navigateTree: async (targetId, options) => {
            if (!session) return { cancelled: true };
            return await this.withOwnedMutation(active, async () => {
              const result = await active.session.navigateTree(targetId, options);
              return { cancelled: result.cancelled };
            });
          },
          switchSession: async () => ({ cancelled: true }),
          reload: async () => { await session?.reload(); },
        },
        shutdownHandler: () => {
          this.shutdownRequested = true;
          this.options.emit("host.shutdownRequested", { source: "extension" });
        },
        onError: (error) => {if(active.currentRun&&error.event==="command")active.currentRun.commandFailed=true;this.emitRuntimeEvent(active,"extension.error",error);},
      });
      await this.synchronizeOwnedSnapshot(active);
      if (active.conflict) throw new PiHostError(active.conflict.code, active.conflict.message, active.conflict.details);
      await this.assertLeaseStable(active);
      const { inspection: synchronizedInspection } = await this.inspectStablePath(
        inspection.summary.path,
        sessionId,
        session.sessionManager.getLeafId(),
      );
      this.assertSameSessionIdentity(inspection.header, synchronizedInspection.header);
      await this.assertLeaseStable(active);
      active.inspection = synchronizedInspection;
      active.activePlan = synchronizedInspection.activePlan;
      active.activeProposal = synchronizedInspection.activeProposal;
      active.conflictTimer = setInterval(() => { void this.checkConflict(active); }, this.conflictPollMs);
      active.conflictTimer.unref?.();
      this.emitRuntimeEvent(active, "session.opened", {
        mode: "writable",
        sessionId,
        path: synchronizedInspection.summary.path,
      });
      return {
        mode: "writable" as const,
        snapshot: synchronizedInspection,
        state: this.getState(),
        extensions: {
          loaded: created.extensionsResult.extensions.filter((extension) => !extension.hidden).length,
          errors: created.extensionsResult.errors,
        },
      };
    } catch (error) {
      if (runtimeIdentity) {
        this.openingAdapterSessionIds.delete(runtimeIdentity.adapterSessionId);
        this.openingDCodeSessionIds.delete(runtimeIdentity.dcodeSessionId);
        this.releaseWorkspaceClaim(
          this.openingWorkspaceClaims,
          this.workspaceClaimKey(runtimeIdentity.workspace),
          runtimeIdentity.runtimeId,
        );
      }
      if (conflictTimer) clearInterval(conflictTimer);
      unsubscribe?.();
      ui?.cancelAll("Session open failed");
      await auxiliary?.dispose();
      session?.dispose();
      attemptController?.dispose();
      agentRequestController?.dispose();
      if (this.active) {
        clearInterval(this.active.conflictTimer);
        this.active.fastMode.dispose();
      }
      try {
        await lease.release();
      } catch (releaseError) {
        const cleanup = errorRecord(releaseError);
        this.options.emit("session.cleanupError", { sessionId, step: "failed activation lease release", ...cleanup });
        this.poisonWritesForSession(sessionId, "A failed session activation could not release its lease");
      }
      this.active = undefined;
      throw error;
    }
  }

  private async closeActive(): Promise<void> {
    const active = this.active;
    if (!active) return;
    active.closePromise??=this.disposeActiveRuntime(active);
    await active.closePromise;
  }

  private async disposeActiveRuntime(active:WritableSession):Promise<void> {
    this.closingWorkspaces.set(active,active.inspection.summary.cwd);
    clearInterval(active.conflictTimer);
    active.closing = true;
    if(active.currentRun)active.currentRun.outcome??="aborted";
    active.ui.cancelAll("Session closing");
    let safeToRelease = true;
    try {
      if (active.conflict) {
        safeToRelease = await this.cleanupStep(
          active,
          "conflict abort",
          active.conflictAbort ?? Promise.resolve(),
          5_000,
        );
      } else {
        const abortSettled = await this.cleanupStep(active, "abort", active.session.abort(), 5_000);
        const shutdownSettled = await this.cleanupStep(
          active,
          "extension shutdown",
          active.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }),
          5_000,
        );
        const leaseSettled = await this.cleanupStep(active, "lease synchronization", active.leaseSync, 2_000);
        safeToRelease = abortSettled && shutdownSettled && leaseSettled;
      }
      const persistenceSettled=active.currentRun?.completion?await this.cleanupStep(active,"run persistence",active.currentRun.completion,5000):true;
      safeToRelease=safeToRelease&&persistenceSettled&&!active.currentRun?.persistenceFailed;
    } finally {
      await active.auxiliary?.dispose();
      active.unsubscribe();
      active.session.dispose();
      if (active.session.agent instanceof ProcessAgent) await active.session.agent.disposeProcess();
      active.fastMode.dispose();
      active.attemptController?.dispose();
      active.agentRequestController?.dispose();
      safeToRelease=safeToRelease&&!active.currentRun?.persistenceFailed;
      if (safeToRelease) {
        try {
          await active.lease.release();
        } catch (error) {
          safeToRelease = false;
          this.options.emit("session.cleanupError", { step: "lease release", ...errorRecord(error) });
        }
      }
      if (!safeToRelease) this.poisonWrites(active, active.currentRun?.persistenceFailed?"本轮结果尚未保存，重新连接后需核对执行记录":"The previous runtime did not stop cleanly");
      this.emitRuntimeEvent(active, "session.closed", { mode: "writable", sessionId: active.inspection.summary.id });
    }
    if(safeToRelease&&this.active===active)this.active=undefined;
    if(safeToRelease)this.closingWorkspaces.delete(active);
  }

  private async cleanupStep(
    _active: WritableSession,
    name: string,
    operation: Promise<unknown>,
    timeoutMs: number,
  ): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      operation.then(
        () => ({ status: "settled" as const }),
        (error) => ({ status: "error" as const, error }),
      ),
      new Promise<{ status: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ status: "timeout" }), timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (result.status === "settled") return true;
    if (result.status === "error") {
      this.options.emit("session.cleanupError", { step: name, ...errorRecord(result.error) });
      return false;
    }
    this.options.emit("session.cleanupTimeout", { step: name, timeoutMs, action: "host restart required" });
    return false;
  }

  private async refreshWritablePathSnapshot(active: WritableSession): Promise<void> {
    await this.assertLeaseStable(active);
    const selectedLeafId = active.session.sessionManager.getLeafId();
    const { inspection } = await this.inspectStablePath(
      active.inspection.summary.path,
      active.inspection.summary.id,
      selectedLeafId,
    );
    this.assertSameSessionIdentity(active.inspection.header, inspection.header);
    await this.assertLeaseStable(active);
    active.inspection = inspection;
    active.activePlan = inspection.activePlan;
    active.activeProposal = inspection.activeProposal;
  }

  private async navigateToExactLeaf(active: WritableSession, targetId: string): Promise<void> {
    const manager = active.session.sessionManager;
    const oldLeafId = manager.getLeafId();
    if (oldLeafId === targetId) return;
    const { entries, commonAncestorId } = collectEntriesForBranchSummary(manager, oldLeafId, targetId);
    const controller = new AbortController();
    const result = await active.session.extensionRunner.emit({
      type: "session_before_tree",
      preparation: {
        targetId,
        oldLeafId,
        commonAncestorId,
        entriesToSummarize: entries,
        userWantsSummary: false,
      },
      signal: controller.signal,
    });
    if (result?.cancel) {
      throw new PiHostError(
        "SESSION_PATH_CANCELLED",
        "会话路径切换被扩展取消",
        { sessionId: active.session.sessionId, targetId },
      );
    }
    manager.branch(targetId);
    active.session.agent.state.messages = manager.buildSessionContext().messages;
    await active.session.extensionRunner.emit({
      type: "session_tree",
      newLeafId: manager.getLeafId(),
      oldLeafId,
    });
  }

  private async applyPathAction(active: WritableSession, action: SessionPathAction): Promise<string | null> {
    this.assertPathActionIdle(active);
    const manager = active.session.sessionManager;
    const target = manager.getEntry(action.entryId);
    if (!target) {
      const native=active.runtimeIdentity&&action.fromPathId?(await (await this.getProductStore()).sessionPathEntries(active.runtimeIdentity.dcodeSessionId,action.fromPathId)).find(entry=>entry.sourceEntryId===action.entryId&&entry.sourceKind==="pi_import"):undefined;
      if(native){const oldLeaf=manager.getLeafId();await this.withOwnedMutation(active,async()=>{manager.resetLeaf();active.session.agent.state.messages=manager.buildSessionContext().messages;await active.session.extensionRunner.emit({type:"session_tree",newLeafId:manager.getLeafId(),oldLeafId:oldLeaf});});await this.refreshWritablePathSnapshot(active);return oldLeaf;}
      throw new PiHostError("SESSION_PATH_NOT_FOUND", `Session path entry not found: ${action.entryId}`);
    }
    if (action.kind === "editUser" && (
      target.type !== "message"
      || typeof target.message !== "object"
      || target.message === null
      || (target.message as { role?: unknown }).role !== "user"
    )) {
      throw new PiHostError("INVALID_PATH_ACTION", "编辑并重走只能从用户消息开始");
    }
    if (action.kind === "continueAssistant" && (
      target.type !== "message"
      || typeof target.message !== "object"
      || target.message === null
      || (target.message as { role?: unknown }).role !== "assistant"
    )) {
      throw new PiHostError("INVALID_PATH_ACTION", "从这里继续只能从助手消息开始");
    }
    const oldLeafId = manager.getLeafId();
    try {
      await this.withOwnedMutation(active, async () => {
        if (action.kind === "continuePath") {
          await this.navigateToExactLeaf(active, target.id);
        } else {
          const result = await active.session.navigateTree(target.id, { summarize: false });
          if (result.cancelled) {
            throw new PiHostError(
              "SESSION_PATH_CANCELLED",
              "会话路径切换被扩展取消",
              { sessionId: active.session.sessionId, targetId: target.id },
            );
          }
        }
      });
      this.assertPathActionIdle(active);
      await this.refreshWritablePathSnapshot(active);
      return oldLeafId;
    } catch (error) {
      await this.rollbackPromptPath({
        active,
        promptId: "path-action",
        confirmed: false,
        rollbackLeafId: oldLeafId,
      });
      throw error;
    }
  }

  private async rollbackPromptPath(call: PromptCallContext): Promise<void> {
    if (call.rollbackLeafId === undefined || call.persistedEntryId !== undefined) return;
    const rollbackLeafId = call.rollbackLeafId;
    call.rollbackLeafId = undefined;
    const active = call.active;
    const manager = active.session.sessionManager;
    const oldLeafId = manager.getLeafId();
    try {
      if(oldLeafId!==rollbackLeafId)await this.withOwnedMutation(active, async () => {
        if (rollbackLeafId === null) manager.resetLeaf();
        else manager.branch(rollbackLeafId);
        active.session.agent.state.messages = manager.buildSessionContext().messages;
        await active.session.extensionRunner.emit({
          type: "session_tree",
          newLeafId: manager.getLeafId(),
          oldLeafId,
        });
      });
      if(call.nativePath&&active.runtimeIdentity){await (await this.getProductStore()).restoreNativeSessionPath(active.runtimeIdentity.dcodeSessionId,call.nativePath.id,call.nativePath.previousId);call.nativePath=undefined;}
      await this.refreshWritablePathSnapshot(active);
    } catch (error) {
      this.markConflict(active, new PiHostError(
        "SESSION_PATH_ROLLBACK_FAILED",
        "会话路径未能安全回滚，需要重新打开会话",
        { cause: errorRecord(error) },
      ));
    }
  }

  private async prompt(
    message: string,
    promptId: string,
    pathAction?: SessionPathAction,
    images?: PromptImageInput[],
    attachmentIds?: string[],
  ): Promise<unknown> {
    const attachmentStore=attachmentIds?.length?await this.getProductStore():undefined;
    const managed = attachmentStore?await Promise.all((attachmentIds??[]).map(id=>attachmentStore.resolveAttachment(id))):[];
    const rawMessage=message;
    let effectiveMessage=attachmentStore?attachmentPrompt(message,managed.map(item=>item.attachment),attachmentStore.layout):message;
    images=[...(images??[]),...managed.filter(item=>item.data).map(item=>({type:"image" as const,mimeType:item.attachment.mimeType,data:item.data!}))];
    if(images.length>8||images.reduce((sum,item)=>sum+item.data.length,0)>12_000_000)throw new PiHostError("ATTACHMENT_LIMIT","图片附件超过本次提交上限，请减少后重试。");
    if (pathAction && message.trim().length === 0) {
      throw new PiHostError("EMPTY_PATH_PROMPT", "路径草稿不能为空");
    }
    if (redactCredentialText(message).redacted) {
      throw new PiHostError(
        "CREDENTIAL_MATERIAL_REJECTED",
        "D Code 检测到输入中可能包含凭据。请先移除密钥、Token 或密码；Product Store 不会保存凭据正文。",
      );
    }
    const active = this.requireWritable();
    const seenRunId = active.seenPromptIds.get(promptId);
    if (seenRunId !== undefined) {
      throw new PiHostError(
        "SESSION_DUPLICATE_PROMPT",
        `该 promptId 已提交过（关联 runId：${seenRunId}）。请核对上一条消息的结果，不要重发同一 ID。`,
        { runId: seenRunId },
      );
    }
    await this.beforeMutation(active);
    this.assertPathActionIdle(active);
    const runtimeIdentity = active.runtimeIdentity;
    const expansion=runtimeIdentity?await expandDCodeInput(rawMessage,active.session):{text:rawMessage,sources:[]};
    if(runtimeIdentity)effectiveMessage=attachmentStore?attachmentPrompt(expansion.text,managed.map(item=>item.attachment),attachmentStore.layout):expansion.text;
    const memberUpdates=runtimeIdentity?await this.coordinatorUpdates(active,effectiveMessage):{text:effectiveMessage,known:new Map<string,string>()};effectiveMessage=memberUpdates.text;
    const call: PromptCallContext = {
      active,
      promptId,
      confirmed: false,
    };
    if (pathAction) {
      if(runtimeIdentity&&(!pathAction.fromPathId||!pathAction.expectedCurrentPathId||!Number.isInteger(pathAction.expectedCurrentPathRevision)))throw new PiHostError("INVALID_PATH_ACTION","历史路径需要有效的来源和当前版本");
      call.rollbackLeafId=active.session.sessionManager.getLeafId();
      try {
        if(runtimeIdentity){const changed=await (await this.getProductStore()).beginNativeSessionPath({requestId:`path:${createHash("sha256").update(`${runtimeIdentity.runtimeId}\0${promptId}`).digest("hex")}`,sessionId:runtimeIdentity.dcodeSessionId,action:pathAction as import("./product-store.js").NativeSessionPathAction});call.nativePath={id:changed.pathId,previousId:pathAction.expectedCurrentPathId!};}
        await this.applyPathAction(active,pathAction);
        this.assertPathActionIdle(active);
      } catch(error){await this.rollbackPromptPath(call);throw error;}
    }
    try{if(runtimeIdentity)await this.refreshRuntimePrompt(active);}catch(error){await this.rollbackPromptPath(call);throw error;}

    let preparedRun: Awaited<ReturnType<ProductStore["prepareSessionRun"]>> | undefined;
    if (runtimeIdentity) {
      const assembledPrompt = active.assembledPrompt;
      const promptEnvironment = active.promptEnvironment;
      if (!assembledPrompt || !promptEnvironment) {
        throw new PiHostError("PROMPT_ASSEMBLY_FAILED", "Runtime has no D Code Prompt Receipt source");
      }
      const attachmentRefs: unknown[] = [...managed.map(item=>item.attachment),...(images ?? []).filter(image=>!managed.some(item=>item.data===image.data)).map((image) => ({
        type: "image",
        mimeType: image.mimeType,
        digest: `sha256:${createHash("sha256").update(Buffer.from(image.data, "base64")).digest("hex")}`,
        bytes: Buffer.byteLength(image.data, "base64"),
      }))];
      try { preparedRun = await (await this.getProductStore()).prepareSessionRun({
        requestId: `provider-${createHash("sha256")
          .update(`${runtimeIdentity.runtimeId}\0${promptId}`)
          .digest("hex")
          .slice(0, 48)}`,
        taskId: runtimeIdentity.taskId,
        scope: runtimeIdentity.scope,
        ...(pathAction?{pathAction:pathAction as import("./product-store.js").NativeSessionPathAction,...(call.nativePath?{preparedPathId:call.nativePath.id}:{})}:{}),
        ...(promptId.startsWith("collab:")?{collaborationMessageId:promptId.slice(7)}:{}),
        sessionId: runtimeIdentity.dcodeSessionId,
        runtimeId: runtimeIdentity.runtimeId,
        ...(runtimeIdentity.agentRunId ? { agentRunId: runtimeIdentity.agentRunId } : {}),
        workspaceId: runtimeIdentity.workspace.workspaceId,
        cwd: runtimeIdentity.workspace.cwd,
        workspaceAccess: runtimeIdentity.workspace.access,
        message: rawMessage,
        effectiveMessage,
        inputSources:expansion.sources,
        managedAttachmentIds: attachmentIds,
        attachmentRefs,
        ...(active.session.model
          ? { modelProvider: active.session.model.provider, modelId: active.session.model.id }
          : {}),
        roleRevision: promptEnvironment.roleRevision,
        contextRevision: promptEnvironment.contextRevision,
        profileSnapshot: {
          role: promptEnvironment.role,
          roleRevision: promptEnvironment.roleRevision,
          roleContract: promptEnvironment.roleContract,
        },
        tools: active.activePromptTools,
        toolsWritable: active.toolsWritable,
        systemPromptDigest: assembledPrompt.digest,
        promptSources: assembledPrompt.sources,
        ...(assembledPrompt.importedHistory ? { importedHistoryReceipt: assembledPrompt.importedHistory } : {}),
      }); }catch(error){await this.rollbackPromptPath(call);throw error;}
      this.options.emit("foundation.changed", {
        storeRevision: preparedRun.storeRevision,
        kind: "sessionRun.prepared",
        entityKind: "sessionRun",
        entityId: preparedRun.sessionRunId,
        taskId: runtimeIdentity.taskId,
        runtimeId: runtimeIdentity.runtimeId,
      });
    }
    const startedAt = new Date().toISOString();
    const run: ActiveRun = {
      id: promptId,
      knownUserUpdates:memberUpdates.known,
      ...(pathAction&&runtimeIdentity?{pathAction:pathAction as import("./product-store.js").NativeSessionPathAction}:{}),
      ...(preparedRun ? {
        sessionRunId: preparedRun.sessionRunId,
        providerAttemptId: preparedRun.providerAttemptId,
        rawInputId: preparedRun.rawInputId,
        effectiveInputId: preparedRun.effectiveInputId,
        promptReceiptId: preparedRun.promptReceiptId,
      } : {}),
      toolCalls: new Map(),
      state: {
        sessionId: active.session.sessionId,
        runId: promptId,
        phase: "running",
        startedAt,
        updatedAt: startedAt,
        inputPersisted: false,
        retryable: false,
      },
    };
    this.rememberSeenId(active.seenPromptIds, promptId, promptId);
    active.currentRun = run;
    this.emitRuntimeEvent(active, "session.runStateChanged", run.state);
    return await new Promise((resolve, reject) => {
      let responded = false;
      const accept = (completed = false) => {
        if (responded) return;
        responded = true;
        resolve({ accepted: true, completed });
      };
      const operation = this.promptCall.run(call, async () => {
        if (run.sessionRunId) {
          const started = await (await this.getProductStore()).startSessionRun(run.sessionRunId);
          this.options.emit("foundation.changed", {
            storeRevision: started.storeRevision,
            kind: "sessionRun.started",
            entityKind: "sessionRun",
            entityId: run.sessionRunId,
            taskId: runtimeIdentity?.taskId,
            runtimeId: runtimeIdentity?.runtimeId,
          });
        }
        return await active.session.prompt(effectiveMessage, {
          source: "rpc",
          ...(runtimeIdentity ? { expandPromptTemplates:!!expansion.command } : {}),
          ...(images && images.length > 0 ? { images } : {}),
          preflightResult: (success) => { if (success) accept(false); },
        });
      });
      run.completion=operation.then(async () => {
        if (call.confirmation) await call.confirmation;
        if (!call.confirmed) {
          await this.rollbackPromptPath(call);
          await active.leaseSync;
          if (active.conflict) {
            throw new PiHostError(active.conflict.code, active.conflict.message, active.conflict.details);
          }
          call.confirmed = true;
          run.handledInput=true;run.outcome=run.commandFailed?"failed":"completed";
          this.emitRuntimeEvent(active, "session.promptCompleted", {
            sessionId: active.session.sessionId,
            promptId,
            outcome: "handled",
          });
        }
        await this.finalizeRun(active, run);
        const durableOutcome = run.outcome === "completed"
          ? "succeeded"
          : run.outcome === "aborted"
            ? "aborted"
            : run.outcome === "failed"
              ? "failed"
              : "unknown";
        await this.finishDurableSessionRun(active, run, durableOutcome).catch((storeError) => {
          run.persistenceFailed=true;
          this.updateRunState(active,run,"unknown",{retryable:false});
          this.emitRuntimeEvent(active,"session.persistenceError",{code:"RESULT_SAVE_FAILED",message:"本轮结果未能保存，交付尚未完成。请重新连接后核对本轮记录；不会自动重新执行。",cause:errorRecord(storeError).code});
        });
        if(!run.persistenceFailed)accept(true);
        else if(!responded)reject(new PiHostError("RESULT_SAVE_FAILED","本轮结果未能保存，未宣告交付完成"));
      }).catch(async (error) => {
        if (call.confirmation) await call.confirmation;
        await this.rollbackPromptPath(call);
        await this.finalizeRun(active, run, run.outcome ?? "failed");
        const durableOutcome = run.outcome === "aborted" ? "aborted" : "failed";
        await this.finishDurableSessionRun(active, run, durableOutcome).catch((storeError) => {
          run.persistenceFailed=true;
          this.updateRunState(active,run,"unknown",{retryable:false});
          this.emitRuntimeEvent(active,"session.persistenceError",{code:"RESULT_SAVE_FAILED",message:"本轮结果未能保存，交付尚未完成。请重新连接后核对本轮记录；不会自动重新执行。",cause:errorRecord(storeError).code});
        });
        if (!responded) reject(error);
        else this.emitRuntimeEvent(active, "session.promptFailed", {
          sessionId: active.session.sessionId,
          promptId,
          ...(call.persistedEntryId ? { persistedEntryId: call.persistedEntryId } : {}),
          ...errorRecord(error),
        });
      });
      void run.completion.finally(()=>this.afterPromptSettled(active,run)).catch(error=>this.options.emit("collaboration.failed",errorRecord(error)));
    });
  }

  private async finishDurableSessionRun(
    active: WritableSession,
    run: ActiveRun,
    outcome: "succeeded" | "failed" | "aborted" | "unknown",
  ): Promise<void> {
    if (!run.sessionRunId || !run.providerAttemptId) return;
    await run.steeringPersistence;
    const completionEntry = run.state.completionEntryId
      ? active.session.sessionManager.getEntry(run.state.completionEntryId)
      : undefined;
    const searchable = completionEntry?.type === "message"
      ? extractSearchableMessage(completionEntry.message)
      : undefined;
    const assistantText = searchable?.role === "assistant"
      ? redactCredentialText(searchable.body).text
      : undefined;
    const result = await (await this.getProductStore()).finishSessionRun({
      sessionRunId: run.sessionRunId,
      providerAttemptId: run.providerAttemptId,
      outcome,
      ...(run.handledInput?{handledInput:true}:{}),
      resultReference: {
        piRunId: run.id,
        ...(run.handledInput?{handledWithoutProvider:true}:{}),
        ...(run.state.completionEntryId ? { completionEntryId: run.state.completionEntryId } : {}),
      },
      ...(assistantText ? { assistantText } : {}),
      ...(run.state.completionEntryId ? { assistantSourceEntryId: run.state.completionEntryId } : {}),
      ...(run.pathEntryId?{userSourceEntryId:run.pathEntryId}:{}),
      ...(active.session.sessionManager.getLeafId()&&(!run.pathAction||run.pathEntryId)?{sourceLeafEntryId:active.session.sessionManager.getLeafId()!}:{}),
      ...(run.pathAction&&!run.pathEntryId?{rollbackPathId:run.pathAction.expectedCurrentPathId}:{}),
    });
    if(active.promptEnvironment?.role==="coordinator"&&!active.auxiliary?.hasLive) await this.setCoordinatorAccess(active,"sharedReadOnly");
    if(run.steering?.size)active.session.agent.clearSteeringQueue();
    this.updateRunState(active,run,outcome==="succeeded"?"completed":outcome);
    this.options.emit("foundation.changed",{kind:"collaboration.messageChanged",taskId:active.runtimeIdentity?.taskId,storeRevision:result.storeRevision});
    this.emitRuntimeEvent(active, "session.durableRunFinished", {
      sessionRunId: run.sessionRunId,
      providerAttemptId: run.providerAttemptId,
      outcome,
      storeRevision: result.storeRevision,
    });
  }

  private async steer(
    message: string,
    steerId: string,
    expectedRunId: string,
    images?: PromptImageInput[],
  ): Promise<unknown> {
    const active = this.requireWritable();
    const seenSteerRunId = active.seenSteerIds.get(steerId);
    if (seenSteerRunId !== undefined) {
      throw new PiHostError(
        "SESSION_DUPLICATE_STEER",
        `该 steerId 已提交过（关联 runId：${seenSteerRunId}）。请核对上一条转向消息，不要重发同一 ID。`,
        { runId: seenSteerRunId },
      );
    }
    await this.beforeMutation(active);
    const run = active.currentRun;
    if (!run || run.state.phase !== "running" || !active.session.isStreaming) {
      throw new PiHostError(
        "SESSION_NOT_RUNNING",
        "A steering message requires a currently running Pi turn",
      );
    }
    if (run.id !== expectedRunId) {
      throw new PiHostError(
        "SESSION_RUN_CHANGED",
        "The active Pi run changed before the steering message could be delivered",
        { expectedRunId, activeRunId: run.id },
      );
    }
    if (active.ui.hasPendingDialogs) {
      throw new PiHostError(
        "SESSION_WAITING_FOR_USER",
        "Answer the active structured request before steering the run",
      );
    }
    try {
      await active.session.steer(message, images && images.length > 0 ? images : undefined);
    } catch {
      throw new PiHostError("STEER_REJECTED", "Pi did not accept the steering message");
    }
    this.rememberSeenId(active.seenSteerIds, steerId, run.id);
    return { accepted: true, steerId, runId: run.id };
  }

  private emitRuntimeEvent(active: WritableSession, event: string, data?: unknown): void {
    const identity = active.runtimeIdentity;
    if (!identity) {
      this.options.emit(event, data);
      return;
    }
    active.runtimeEventSequence += 1;
    const details = typeof data === "object" && data !== null && !Array.isArray(data)
      ? data as Record<string, unknown>
      : data === undefined ? {} : { value: data };
    this.options.emit(event, {
      ...details,
      runtime: {
        runtimeId: identity.runtimeId,
        scope: identity.scope,
        taskId: identity.taskId,
        dcodeSessionId: identity.dcodeSessionId,
        ...(identity.agentRunId ? { agentRunId: identity.agentRunId } : {}),
        adapter: { kind: "pi", sessionId: identity.adapterSessionId },
        workspace: identity.workspace,
        ...(active.currentRun ? { runId: active.currentRun.id } : {}),
      },
      sequence: active.runtimeEventSequence,
    });
  }

  private updateRunState(
    active: WritableSession,
    run: ActiveRun,
    phase: RunPhase,
    changes: Partial<Pick<RunState, "waitingFor" | "completionId" | "completionEntryId" | "completedAt" | "inputPersisted" | "retryable">> = {},
  ): void {
    run.state = {
      ...run.state,
      ...changes,
      phase,
      waitingFor: phase === "waitingForUser" ? changes.waitingFor : undefined,
      updatedAt: changes.completedAt ?? new Date().toISOString(),
    };
    if (!run.state.phase || run.state.sessionId !== active.session.sessionId) return;
    if (["completed", "failed", "aborted", "unknown"].includes(phase)) {
      active.lastRunState = run.state;
    }
    this.emitRuntimeEvent(active, "session.runStateChanged", run.state);
  }

  private async finalizeRun(
    active: WritableSession,
    run: ActiveRun,
    forcedOutcome?: RunOutcome,
  ): Promise<void> {
    if (run.finalization) return await run.finalization;
    run.finalization = (async () => {
      await this.synchronizeOwnedSnapshot(active);
      await active.leaseSync;
      let outcome = forcedOutcome ?? run.outcome ?? "unknown";
      if (active.conflict) outcome = "unknown";
      const completedAt = new Date().toISOString();
      if(outcome==="completed"&&run.handledInput){
        this.updateRunState(active,run,run.sessionRunId?"saving":"completed",{completionId:`${run.id}:handled`,completedAt,inputPersisted:false,retryable:false});
      }else if (outcome === "completed") {
        const manager = active.session.sessionManager;
        const branch = manager.getBranch();
        const boundary = run.pathEntryId
          ? branch.findIndex((entry) => entry.id === run.pathEntryId)
          : -1;
        const completionEntry = run.pathEntryId
          ? boundary >= 0
            ? branch.slice(boundary + 1).reverse().find((entry) => (
                entry.type === "message" && entry.message.role === "assistant"
              ))
            : undefined
          : undefined;
        if (completionEntry?.type === "message" && completionEntry.message.role === "assistant") {
          this.updateRunState(active, run, run.sessionRunId?"saving":"completed", {
            completionId: `${run.id}:${completionEntry.id}`,
            completionEntryId: completionEntry.id,
            completedAt,
            inputPersisted: run.pathEntryId !== undefined,
            retryable: false,
          });
        } else {
          outcome = "unknown";
        }
      }
      if (outcome !== "completed") {
        this.updateRunState(active, run, run.sessionRunId?"saving":outcome, {
          completedAt,
          inputPersisted: run.pathEntryId !== undefined,
          retryable: outcome === "failed" && run.pathEntryId === undefined,
        });
      }
      run.outcome=outcome;
    })();
    await run.finalization;
  }

  private installPromptSourceBoundary(active: WritableSession): void {
    const prompt = active.session.prompt.bind(active.session);
    active.session.prompt = (text, options) => {
      const currentCall = this.promptCall.getStore();
      const correlatedCall = options?.source === "rpc" && currentCall?.active === active
        ? currentCall
        : undefined;
      return this.promptCall.run(correlatedCall, () => prompt(text, options));
    };
  }

  /**
   * 上下文构成占比：按消息种类估算分项 token，用最近一次真实 usage 总量锚定，
   * 差值反推“系统与工具”。全部为估算口径（chars/4，与 Pi 压缩判断一致），如实标注。
   */
  private getContextBreakdown(): unknown {
    const active = this.requireActive();
    const messages = active.session.sessionManager.buildSessionContext().messages;
    const parts = {
      user: 0,
      assistant: 0,
      thinking: 0,
      toolCall: 0,
      toolResult: 0,
    };
    for (const message of messages) {
      if (message.role === "user") {
        parts.user += estimateTokens(message);
      } else if (message.role === "toolResult") {
        parts.toolResult += estimateTokens(message);
      } else if (message.role === "assistant") {
        const whole = estimateTokens(message);
        let thinkingChars = 0;
        const blocks = Array.isArray((message as { content?: unknown[] }).content)
          ? ((message as { content: unknown[] }).content)
          : [];
        for (const block of blocks) {
          if (
            typeof block === "object" && block !== null
            && (block as { type?: unknown }).type === "thinking"
          ) {
            const text = (block as { text?: unknown }).text;
            if (typeof text === "string") thinkingChars += text.length;
          }
        }
        const thinking = Math.ceil(thinkingChars / 4);
        parts.thinking += thinking;
        parts.assistant += Math.max(0, whole - thinking);
      }
    }
    const usage = active.session.getContextUsage() ?? { tokens: null, contextWindow: 0, percent: null };
    const estimatedTotal = parts.user + parts.assistant + parts.thinking + parts.toolCall + parts.toolResult;
    const anchored = typeof usage.tokens === "number" && usage.tokens > 0 ? usage.tokens : null;
    const systemAndTools = anchored !== null ? Math.max(0, anchored - estimatedTotal) : null;
    return {
      available: true,
      estimated: anchored === null,
      totalTokens: anchored,
      estimatedMessageTokens: estimatedTotal,
      contextWindow: usage.contextWindow,
      parts: [
        { kind: "systemTools", tokens: systemAndTools },
        { kind: "user", tokens: parts.user },
        { kind: "assistant", tokens: parts.assistant },
        { kind: "thinking", tokens: parts.thinking },
        { kind: "toolResult", tokens: parts.toolResult },
      ],
    };
  }

  private getState(): unknown {
    const active = this.requireActive();
    return this.runtimeState(active);
  }

  private runtimeState(active: WritableSession): unknown {
    return {
      mode: "writable" as const,
      sessionId: active.session.sessionId,
      sessionFile: active.session.sessionFile,
      sessionName: active.session.sessionName,
      cwd: active.session.sessionManager.getCwd(),
      model: safeModel(active.session.model),
      auxiliaryProcesses:active.auxiliary?.snapshot??[],
      process: active.session.agent instanceof ProcessAgent ? active.session.agent.processInfo ?? null : null,
      thinkingLevel: active.session.thinkingLevel,
      activePlan: active.activePlan,
      isStreaming: active.session.isStreaming,
      runState: active.currentRun?.state ?? active.lastRunState ?? null,
      isCompacting: active.session.isCompacting,
      pendingMessageCount: active.session.pendingMessageCount,
      contextUsage: active.session.getContextUsage() ?? null,
      fastMode: active.fastMode.snapshot,
      writable: !active.conflict,
      conflict: active.conflict ?? null,
    };
  }

  private modelProvidersStore: ModelProvidersStore | undefined;

  private modelProviders(): ModelProvidersStore {
    this.modelProvidersStore ??= ModelProvidersStore.forAgentDir(this.agentDir);
    return this.modelProvidersStore;
  }

  /**
   * 本机资源快照（ADR 0024 / 0.0.15）：不依赖打开的会话——用当前会话 cwd
   * （无会话时用户目录）构造独立 loader 真实加载一次，返回包 / 扩展 / Skill /
   * Prompt / 命令与诊断。隐藏的 D Code 内联扩展不出现在用户面。
   */
  private async listResources(): Promise<unknown> {
    const cwd = this.options.userHome ?? homedir();
    const settingsManager = SettingsManager.create(cwd, this.agentDir);
    const loader = new DCodeResourceLoader({
      cwd,
      agentDir: this.agentDir,
      sourceSettingsManager: settingsManager,
      extensionFactories: [],
      allowExternalExtensions: false,
    });
    await loader.reload();
    const disabledStore = new DisabledPackageStore(disabledPackageStorePath(this.agentDir));
    return collectResourcesSnapshot({
      loader,
      settingsManager,
      disabled: await disabledStore.load(),
    });
  }

  /**
   * 扩展包停用 / 启用：停用即从 Pi 全局 `packages` 移除原始条目并完整保存到
   * 影子清单；启用从影子原样恢复。写入经 Pi SettingsManager 真实配置合同并
   * flush；有活跃会话时热重载其资源。Skill / Prompt 无对应配置合同，不提供开关。
   */
  private async setPackageEnabled(source: string, enabled: boolean): Promise<unknown> {
    if (typeof source !== "string" || source.length === 0) {
      throw new PiHostError("INVALID_PARAMS", "Expected params.source to be a non-empty string");
    }
    const cwd = this.active?.inspection.summary.cwd ?? homedir();
    const settingsManager = SettingsManager.create(cwd, this.agentDir);
    const disabledStore = new DisabledPackageStore(disabledPackageStorePath(this.agentDir));
    const disabled = await disabledStore.load();
    const current = settingsManager.getGlobalSettings().packages ?? [];
    const matches = (entry: unknown) => packageSourceKey(entry) === source;

    if (!enabled) {
      const removed = current.find(matches);
      if (removed !== undefined || !disabled.some(matches)) {
        if (removed !== undefined) {
          settingsManager.setPackages(current.filter((entry) => !matches(entry)));
          await settingsManager.flush();
        }
        if (removed !== undefined && !disabled.some(matches)) disabled.push(removed);
        await disabledStore.save(disabled);
      }
    } else {
      const restored = disabled.find(matches) as import("@earendil-works/pi-coding-agent").PackageSource | undefined;
      if (!current.some(matches)) {
        settingsManager.setPackages([...current, restored ?? source]);
        await settingsManager.flush();
      }
      if (restored !== undefined || disabled.length > 0) {
        await disabledStore.save(disabled.filter((entry) => !matches(entry)));
      }
    }

    if (this.active) {
      await this.active.session.resourceLoader.reload();
    }
    return { ok: true, source, enabled };
  }

  /** 压缩设置（0.0.16 弹层）：项目覆盖全局、缺省回落 Pi 默认（预留 16384）。 */
  private async getCompactionInfo(): Promise<unknown> {
    const cwd = this.active?.inspection.summary.cwd ?? homedir();
    const settings = SettingsManager.create(cwd, this.agentDir);
    const global = settings.getGlobalSettings().compaction ?? {};
    const project = settings.getProjectSettings().compaction ?? {};
    const merged = {
      enabled: project.enabled ?? global.enabled ?? true,
      reserveTokens: project.reserveTokens ?? global.reserveTokens ?? 16384,
      keepRecentTokens: project.keepRecentTokens ?? global.keepRecentTokens ?? 20000,
    };
    return merged;
  }

  /** 手动压缩：Pi 合同 `session.compact()`——会先中止当前操作；事件流照常驱动 isCompacting。 */
  private async compactSession(): Promise<unknown> {
    const active = this.requireWritable();
    await active.session.compact();
    return { ok: true };
  }

  private async inspectTaskContextFiles(taskId:string,paths:string[]):Promise<{sources:TaskContextSourceInput[];requiredAgents:boolean}> {
    const snapshot=await (await this.getProductStore()).snapshot();const task=snapshot.tasks.find(task=>task.id===taskId);if(!task)throw new PiHostError("TASK_NOT_FOUND","任务不存在");
    const cwd=await realpath(task.cwd),home=await realpath(snapshot.currentUser.homeDirectory);const sources:TaskContextSourceInput[]=[];let requiredAgents=false;
    const required=await stat(join(cwd,"AGENTS.md")).catch(()=>undefined);
    for(const requested of paths){const path=await realpath(requested),info=await stat(path);if(required&&info.dev===required.dev&&info.ino===required.ino){requiredAgents=true;continue;}
      const local=relative(cwd,path);const inTask=local!==""&&local!==".."&&!local.startsWith("../")&&!isAbsolute(local);
      const root=inTask?cwd:dirname(path),localHome=relative(home,root);
      if(!inTask&&(!localHome||localHome===".."||localHome.startsWith("../")||isAbsolute(localHome)))throw new PiHostError("CONTEXT_SOURCE_OUTSIDE_SCOPE","附加资料需位于任务目录内，或个人目录中的资料文件夹");
      const relativePath=inTask?local:basename(path);const file=await this.workspaceAccess.files.read(root,relativePath);
      if(file.kind==="image"||file.bytes>64*1024)throw new PiHostError("CONTEXT_SOURCE_TOO_LARGE","附加资料需为不超过 64 KB 的文本；较大的文件可以在对话中引用");
      const source:TaskContextSourceInput={kind:inTask?"scope_document":"global_knowledge",relativePath,title:basename(path),...(!inTask?{rootPath:root}:{})};
      if(!sources.some(item=>item.kind===source.kind&&item.rootPath===source.rootPath&&item.relativePath===source.relativePath))sources.push(source);
    }
    return {sources,requiredAgents};
  }

  private async dcodeCommands(sessionId?:string,projectId?:string):Promise<unknown> {
    const snapshot=await (await this.getProductStore()).snapshot();
    const session=sessionId?snapshot.sessions.find(session=>session.id===sessionId):undefined;
    if(sessionId&&!session)throw new PiHostError("DCODE_SESSION_NOT_FOUND","会话不存在");
    const runtimeId=sessionId?this.runtimeByDCodeSessionId.get(sessionId):undefined;
    if(runtimeId)return this.runtimeContext.run(runtimeId,()=>this.getCommands());
    const task=session?snapshot.tasks.find(task=>task.id===session.taskId):undefined;
    const project=projectId?snapshot.projects.find(project=>project.id===projectId):undefined;
    if(projectId&&!project)throw new PiHostError("PROJECT_NOT_FOUND","项目不存在");
    const cwd=task?.cwd??project?.directory??snapshot.currentUser.homeDirectory;
    const settings=SettingsManager.create(cwd,this.agentDir);
    const loader=new DCodeResourceLoader({cwd,agentDir:this.agentDir,sourceSettingsManager:settings,extensionFactories:[],allowExternalExtensions:false,disabledResources:()=>new Set(this.productStore?.clientPreferences().disabledResources??[])});
    await loader.reload();
    return {commands:[...loader.getPrompts().prompts.map(prompt=>({name:prompt.name,description:prompt.description,source:"prompt"})),...loader.getSkills().skills.map(skill=>({name:`skill:${skill.name}`,description:skill.description,source:"skill"}))]};
  }

  private getCommands(): unknown {
    const active = this.requireWritable();
    const commands = [];    for (const command of active.session.extensionRunner.getRegisteredCommands()) {
      commands.push({
        name: command.invocationName,
        description: command.description,
        source: "extension",
        sourceInfo: command.sourceInfo,
      });
    }
    for (const template of active.session.promptTemplates) {
      commands.push({ name: template.name, description: template.description, source: "prompt", sourceInfo: template.sourceInfo });
    }
    for (const skill of active.session.resourceLoader.getSkills().skills) {
      commands.push({ name: `skill:${skill.name}`, description: skill.description, source: "skill", sourceInfo: skill.sourceInfo });
    }
    return { commands };
  }

  private async getModels(cwd?: string): Promise<unknown> {
    let canonicalCwd: string;
    let runtime: ModelRuntime;
    if (cwd === undefined) {
      const active = this.requireActive();
      canonicalCwd = active.inspection.summary.cwd;
      runtime = active.session.modelRuntime;
    } else {
      try {
        canonicalCwd = await realpath(cwd);
        if (!(await stat(canonicalCwd)).isDirectory()) throw new Error("not a directory");
      } catch (error) {
        throw new PiHostError("CWD_NOT_ACCESSIBLE", `Working directory is not accessible: ${cwd}`, {
          cause: error instanceof Error ? error.message : String(error),
        });
      }

      runtime = await this.sharedModelRuntime();
    }

    if (cwd === undefined) {
      const active = this.requireActive();
      const canRefreshRuntime = !active.session.isStreaming
        && !active.session.isCompacting
        && active.session.pendingMessageCount === 0;
      if (canRefreshRuntime) {
        try {
          await runtime.refresh({ allowNetwork: false });
        } catch {
          // Keep the last valid active snapshot; explicit model settings surfaces the read issue.
        }
      }
    }

    const settings = SettingsManager.create(canonicalCwd, this.agentDir);
    const enabledPatterns = settings.getEnabledModels();
    const models = enabledPatterns && enabledPatterns.length > 0
      ? (await resolveModelScopeWithDiagnostics(enabledPatterns, runtime)).scopedModels.map(({ model }) => model)
      : [...runtime.getAvailableSnapshot()];
    const defaultProvider = settings.getDefaultProvider();
    const defaultModelId = settings.getDefaultModel();
    const defaultThinkingLevel = settings.getDefaultThinkingLevel() ?? PI_DEFAULT_THINKING_LEVEL;
    const defaultModel = defaultProvider && defaultModelId
      ? models.find((model) => model.provider === defaultProvider && model.id === defaultModelId)
      : undefined;
    return {
      models: models.map((model) => safeModel(model)),
      defaultModel: defaultModel ? safeModel(defaultModel) : null,
      defaultThinkingLevel,
    };
  }

  private async canonicalModelSettingsCwd(cwd: string): Promise<string> {
    try {
      const canonicalCwd = await realpath(cwd);
      if (!(await stat(canonicalCwd)).isDirectory()) throw new Error("not a directory");
      return canonicalCwd;
    } catch (error) {
      throw new PiHostError("CWD_NOT_ACCESSIBLE", `Working directory is not accessible: ${cwd}`, {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private maintenance: MaintenanceController | undefined;

  private modelRuntimePromise: Promise<ModelRuntime> | undefined;

  /** agentDir 固定，目录级 ModelRuntime 在 Host 生命周期内复用；cwd 只影响 settings 解析。 */
  private sharedModelRuntime(): Promise<ModelRuntime> {
    this.modelRuntimePromise ??= this.getProductStore().then(store => ModelRuntime.create({
      authPath: join(this.agentDir, "auth.json"),
      modelsPath: join(this.agentDir, "models.json"),
      modelsStorePath: join(store.layout.root, "models-cache.json"),
      allowModelNetwork: false,
    }));
    return this.modelRuntimePromise;
  }

  private async createModelSettingsRuntime(): Promise<ModelRuntime> {
    return await this.sharedModelRuntime();
  }

  private async ensureDCodeRuntimeModelCatalog(force = false): Promise<void> {
    const store = await this.getProductStore();
    const current = await store.snapshot();
    if (!force && current.modelCatalogEntries.length > 0 && current.runtimeModelSelection) return;

    const runtime = await this.createModelSettingsRuntime();
    const removedProviderIds=store.removedModelProviderIds();
    const providers: RuntimeModelCatalogProviderInput[] = runtime.getProviders().flatMap((provider) => {
      if(removedProviderIds.has(provider.id)||current.modelProviders.some(p=>p.id===provider.id&&(p.nonsecret as {source?:string}).source==="dcode_custom"))return [];
      const raw = provider as unknown as Record<string, unknown>;
      const providerId = redactCredentialText(provider.id);
      if (providerId.redacted) return [];
      const auth = runtime.getProviderAuthStatus(provider.id);
      const models = runtime.getModels(provider.id)
        .map((model) => safeModel(model))
        .filter((model): model is SafeModelSnapshot => model !== null)
        .flatMap((model) => {
          const modelId = redactCredentialText(model.id);
          if (modelId.redacted) return [];
          const modelName = redactCredentialText(model.name ?? model.id).text;
          const contextWindow = model.contextWindow;
          const maxTokens = model.maxTokens;
          return [{
            modelId: modelId.text,
            name: modelName,
            ...(typeof contextWindow === "number" && Number.isSafeInteger(contextWindow)
              ? { contextWindow }
              : {}),
            ...(typeof maxTokens === "number" && Number.isSafeInteger(maxTokens)
              ? { maxTokens }
              : {}),
            reasoning: model.reasoning === true,
            nonsecret: redactCredentialValue(model),
          }];
        });
      if (models.length === 0) return [];
      const apiKey = raw.auth && typeof raw.auth === "object" && !Array.isArray(raw.auth)
        ? (raw.auth as { apiKey?: unknown }).apiKey
        : undefined;
      const oauth = raw.auth && typeof raw.auth === "object" && !Array.isArray(raw.auth)
        ? (raw.auth as { oauth?: unknown }).oauth
        : undefined;
      const providerName = redactCredentialText(provider.name).text;
      const baseUrl = typeof raw.baseUrl === "string" ? redactCredentialText(raw.baseUrl) : undefined;
      const apiKind = typeof raw.api === "string" ? redactCredentialText(raw.api) : undefined;
      return [{
        id: providerId.text,
        name: providerName,
        ...(baseUrl && !baseUrl.redacted ? { baseUrl: baseUrl.text } : {}),
        ...(apiKind && !apiKind.redacted ? { apiKind: apiKind.text } : {}),
        authMode: apiKey ? "api_key" : oauth ? "oauth" : "none",
        nonsecret: { source: "pi_runtime_discovery" },
        credential: {
          locator: `pi-runtime-auth-bridge:${providerId.text}`,
          configured: auth.configured,
        },
        models,
      } satisfies RuntimeModelCatalogProviderInput];
    });
    if (providers.length === 0) return;
    const settings = SettingsManager.create(current.currentUser.homeDirectory, this.agentDir);
    const defaultProvider = settings.getGlobalSettings().defaultProvider;
    const defaultModel = settings.getGlobalSettings().defaultModel;
    const defaultSelection = defaultProvider && defaultModel && providers.some((provider) => (
      provider.id === defaultProvider && provider.models.some((model) => model.modelId === defaultModel)
    ))
      ? { providerId: defaultProvider, modelId: defaultModel }
      : undefined;
    const requestId = `runtime-model-catalog:${createHash("sha256")
      .update(JSON.stringify({ providers, defaultSelection }))
      .digest("hex")
      .slice(0, 48)}`;
    await store.seedRuntimeModelCatalog({ requestId: force ? `catalog-refresh-${randomUUID()}` : requestId, providers, ...(defaultSelection ? { defaultSelection } : {}) });
  }

  private memberModelCandidates(store:ProductStore,sessionId:string,base:AgentModelCandidate[]):AgentModelCandidate[]{
    const chosen=store.sessionModelSelection(sessionId);if(!chosen)return base;
    const preferred={providerId:chosen.providerId,modelId:chosen.modelId};return [preferred,...base.slice(1).filter(candidate=>candidate.providerId!==preferred.providerId||candidate.modelId!==preferred.modelId)];
  }

  private providerRouteControl(identity:RuntimeIdentity,active:()=>WritableSession|undefined):ProviderRouteControl {
    const callInputs=new Map<string,Pick<Parameters<ProductStore["recordProviderCall"]>[0],"sessionId"|"sessionRunId"|"taskId"|"agentRunId"|"rawInputIds"|"effectiveInputIds"|"purpose"|"sourceLeafEntryId">>();
    return {
      response:(model,status,headers)=>{if(status===429)this.quotaService().blockProvider(model.provider,headers["retry-after"]);},
      select:async(model,context,signal,rejected)=>{
        const runtime=active(),run=runtime?.currentRun;if(!runtime)throw new PiHostError("RUNTIME_UNAVAILABLE","模型调用所属运行环境已关闭");
        const auxiliary=runtime.session.isCompacting;
        if(!auxiliary&&!run?.sessionRunId)throw new PiHostError("RUN_REQUIRED","普通模型调用缺少当前运行");
        await run?.steeringPersistence;
        if(signal?.aborted)throw new PiHostError("ABORTED","执行已停止");
        const store=await this.getProductStore(),snapshot=await store.snapshot();
        const agent=snapshot.agentRuns.find(agent=>agent.id===identity.agentRunId);
        const packet=snapshot.agentAssignments.find(assignment=>assignment.agentRunId===agent?.id)?.taskPacket as {resolvedModelCandidates?:AgentModelCandidate[]}|undefined;
        const profile=agent?.profileSnapshot as {modelCandidates?:AgentModelCandidate[]}|undefined;
        const automatic=auxiliary||!!packet?.resolvedModelCandidates||!!profile?.modelCandidates||!!run?.id.startsWith("collab:");
        const availableChoices=(await this.dcodeModelsView()).models;
        const currentChoice=availableChoices.find(choice=>choice.providerId===model.provider&&choice.modelId===model.id);
        if(!automatic&&!rejected.size&&currentChoice?.enabled&&currentChoice.available){const quota=await this.quotaService().get(model.provider);if(quota.status==="unknown"||assessModelQuota(quota,model.id,Date.now()).eligible)return {model,context};}
        const candidates=this.memberModelCandidates(store,identity.dcodeSessionId,packet?.resolvedModelCandidates??profile?.modelCandidates??[{providerId:model.provider,modelId:model.id}]);
        const models=availableChoices.map(choice=>rejected.has(choice.providerId)?{...choice,available:false}:choice);
        const hasImages=context.messages.some(message=>Array.isArray(message.content)&&message.content.some(part=>part.type==="image"));
        const usage=runtime.session.getContextUsage();let imageCount=0;
        const textSize=Buffer.byteLength(JSON.stringify(context,(_key,value)=>{if(value&&typeof value==="object"&&value.type==="image"){imageCount++;return {type:"image"};}return value;}));
        const minimumContext=Math.max(!auxiliary&&typeof usage?.tokens==="number"?usage.tokens+1024:0,Math.ceil(textSize/2)+imageCount*4096+2048);
        const decision=await chooseAgentModel({candidates,models,quotas:this.quotaService(),capabilities:hasImages?["image"]:[],minimumContext});
        if(!decision.selected)throw new PiHostError("MODEL_ROUTE_BLOCKED",`回退链暂无可调用模型（${[...new Set(decision.considered.map(item=>item.reason))].join("；")}），当前进度已保留`);
        if(decision.selected.providerId===model.provider&&decision.selected.modelId===model.id)return {model,context};
        if(run?.toolCalls.size||runtime.ui.hasPendingDialogs||snapshot.operationAttempts.some(attempt=>run&&attempt.sessionRunId===run.sessionRunId&&attempt.operationKind==="tool_invocation"&&(["prepared","unknown"].includes(attempt.status)||attempt.status==="failed"&&!SHARED_READ_ONLY_TOOL_NAMES.has(attempt.targetIdentity))))throw new PiHostError("MODEL_ROUTE_UNSAFE","工具执行尚未确认，已停止模型切换并保留进度");
        const next=runtime.session.modelRuntime.getAvailableSnapshot().find(candidate=>candidate.provider===decision.selected!.providerId&&candidate.id===decision.selected!.modelId);if(!next)throw new PiHostError("MODEL_NOT_FOUND","候选模型已不可用");
        // Summary prompts are private to this call. They must never replace the
        // member's main identity, chosen model or current prompt receipt.
        if(auxiliary)return {model:next as ProviderModel,context};
        if(!run?.sessionRunId)throw new PiHostError("RUN_REQUIRED","模型切换缺少当前运行");
        const systemPrompt=(context.systemPrompt??"").replace(/^- Model: .*$/mu,`- Model: ${next.provider}/${next.id}`);
        const digest=`sha256:${createHash("sha256").update(systemPrompt).digest("hex")}`;
        await this.withOwnedMutation(runtime,async()=>{await runtime.session.setModel(next);});
        const internals=runtime.session as unknown as {_baseSystemPrompt:string;_systemPromptOverride?:string};internals._baseSystemPrompt=systemPrompt;internals._systemPromptOverride=undefined;runtime.session.agent.state.systemPrompt=systemPrompt;
        if(runtime.assembledPrompt)runtime.assembledPrompt={...runtime.assembledPrompt,text:systemPrompt,digest};
        await store.recordRunningModelRoute({requestId:`reroute:${randomUUID()}`,sessionRunId:run.sessionRunId,agentRunId:identity.agentRunId!,decision,systemPromptDigest:digest});

        this.options.emit("foundation.changed",{kind:"agentModel.rerouted",taskId:identity.taskId});
        return {model:next as ProviderModel,context:{...context,systemPrompt},reasoning:runtime.session.thinkingLevel==="off"?null:runtime.session.thinkingLevel};
      },
      record:async(call)=>{
        const runtime=active(),run=runtime?.currentRun;const store=await this.getProductStore();
        if(call.state==="started"){
          const auxiliary=runtime?.session.isCompacting===true;
          if(!runtime||!auxiliary&&!run?.sessionRunId)throw new PiHostError("RUN_REQUIRED","模型调用缺少所属运行");
          const rawInputIds=auxiliary?[]:[...new Set([run?.rawInputId,...(run?.knownUserUpdates?.values()??[]),...[...run?.steering?.values()??[]].filter(item=>item.effectiveInputId).map(item=>item.message.originRawInputId)].filter((id):id is string=>!!id))];
          const effectiveInputIds=auxiliary?[]:[run?.effectiveInputId,...[...run?.steering?.values()??[]].map(item=>item.effectiveInputId)].filter((id):id is string=>!!id);
          callInputs.set(call.id,{taskId:identity.taskId,sessionId:identity.dcodeSessionId,...(run?.sessionRunId?{sessionRunId:run.sessionRunId}:{}),...(identity.agentRunId?{agentRunId:identity.agentRunId}:{}),purpose:auxiliary?"context_summary":"agent",...(auxiliary&&runtime.session.sessionManager.getLeafId()?{sourceLeafEntryId:runtime.session.sessionManager.getLeafId()!}:{}),rawInputIds,effectiveInputIds});
        }
        const inputs=callInputs.get(call.id);if(!inputs)throw new PiHostError("PROVIDER_CALL_NOT_STARTED","模型结果缺少对应的调用记录");
        await store.recordProviderCall({...sanitizeRuntimeValue(call),...inputs});
        if(call.state!=="started")callInputs.delete(call.id);
        this.options.emit("foundation.changed",{kind:"providerCall.changed",taskId:identity.taskId});
      },
    };
  }

  private quotaServiceValue?: ModelQuotaService;
  private quotaService(): ModelQuotaService {
    this.quotaServiceValue ??= new ModelQuotaService({
      offline:()=>process.env.PI_OFFLINE!==undefined,
      resolveCredential: async (providerId) => {
        const runtime = await this.sharedModelRuntime();
        await registerCatalogProviders(runtime, await (await this.getProductStore()).snapshot());
        const model = runtime.getModels(providerId)[0];
        if (!model) return undefined;
        const resolved = await runtime.getAuth(model);
        return resolved ? { auth: resolved.auth, sourceBaseUrl: model.baseUrl } : undefined;
      },
      onUpdated: (snapshot) => this.options.emit("modelQuota.updated", snapshot),
    });
    return this.quotaServiceValue;
  }

  private async modelQuotaSnapshot(params: Record<string, unknown>): Promise<unknown> {
    const view = await this.dcodeModelsView();
    const eligibleProviders = new Set(view.models.filter((model) => model.enabled && model.available).map((model) => model.providerId));
    const requested = params.providerIds as string[] | undefined;
    if (requested?.some((id) => !view.providers.some((provider) => provider.id === id))) throw new PiHostError("MODEL_PROVIDER_NOT_FOUND", "配额查询来源不在模型目录中");
    const providers = (requested ?? [...eligibleProviders]).filter((id) => eligibleProviders.has(id));
    const snapshots = await this.quotaService().collect(providers, params.force === true);
    return { snapshots, assessments: view.models.filter((model) => eligibleProviders.has(model.providerId)).map((model) => {
      const quota = snapshots.find((snapshot) => snapshot.providerId === model.providerId);
      return { providerId: model.providerId, modelId: model.modelId, ...(quota ? assessModelQuota(quota, model.modelId, Date.now()) : { eligible: false, reason: "额度尚未查询" }) };
    }) };
  }

  private modelRefreshState: DCodeModelsView["refresh"] = {failedProviders:[],offline:false};

  private async dcodeModelsView(sessionId?: string): Promise<DCodeModelsView> {
    const store=await this.getProductStore();
    const snapshot=await store.snapshot();
    const runtime=await this.sharedModelRuntime();
    await registerCatalogProviders(runtime,snapshot);
    const available=new Set((await runtime.getAvailable()).map(m=>`${m.provider}::${m.id}`));
    const preferences=await this.handleSerial("clientPreferences.get",{}) as ClientPreferences;
    const runtimeId=sessionId?this.runtimeByDCodeSessionId.get(sessionId):undefined;
    const active=runtimeId?this.runtimes.get(runtimeId):undefined;
    const defaultKey=snapshot.runtimeModelSelection?`${snapshot.runtimeModelSelection.providerId}::${snapshot.runtimeModelSelection.modelId}`:null;
    const sessionSelection=sessionId?store.sessionModelSelection(sessionId):undefined;
    const prior=sessionId?snapshot.agentRuns.find(run=>run.sessionId===sessionId):undefined;
    const selectedKey=active?.session.model?`${active.session.model.provider}::${active.session.model.id}`:sessionSelection?`${sessionSelection.providerId}::${sessionSelection.modelId}`:prior?.modelProvider&&prior.modelId?`${prior.modelProvider}::${prior.modelId}`:defaultKey;
    const models:ModelChoice[]=snapshot.modelCatalogEntries.map(model=>{
      const key=`${model.providerId}::${model.modelId}`;
      const definition=runtime.getModel(model.providerId,model.modelId);
      return {key,providerId:model.providerId,providerName:snapshot.modelProviders.find(p=>p.id===model.providerId)?.name??model.providerId,modelId:model.modelId,name:model.name,available:available.has(key),enabled:preferences.enabledModels==null||preferences.enabledModels.includes(key),reasoning:model.reasoning,input:definition?.input,contextWindow:model.contextWindow??null,thinkingLevels:definition?[...getSupportedThinkingLevels(definition)]:["off"]};
    });
    const thinkingLevels=models.find(m=>m.key===selectedKey)?.thinkingLevels??["off","minimal","low","medium","high","xhigh","max"];
    const defaultThinking=preferences.defaultThinking??"medium";
    const desired=active?.session.thinkingLevel??defaultThinking;
    return {models,providers:snapshot.modelProviders.map(p=>({id:p.id,name:p.name,connected:models.some(m=>m.providerId===p.id&&m.available)})),legacyProviders:(await this.modelProviders().list()).providers,selectedKey,defaultKey,defaultThinking,thinking:thinkingLevels.includes(desired)?desired:(thinkingLevels.includes("medium")?"medium":thinkingLevels[0]??"off"),thinkingLevels,refresh:{...this.modelRefreshState,offline:process.env.PI_OFFLINE!==undefined}};
  }

  private async projectModelScope(
    patterns: string[] | undefined,
    runtime: ModelRuntime,
  ): Promise<ModelScopeProjection> {
    const availableModels = [...runtime.getAvailableSnapshot()];
    if (!patterns || patterns.length === 0) {
      return {
        unrestricted: true,
        enabledKeys: new Set(availableModels.map((model) => modelKey(model.provider, model.id))),
        matchedPatterns: new Map(),
        diagnostics: [],
      };
    }

    const resolved = await resolveModelScopeWithDiagnostics(patterns, runtime);
    const enabledKeys = new Set(
      resolved.scopedModels.map(({ model }) => modelKey(model.provider, model.id)),
    );
    const matchedPatterns = new Map<string, string[]>();
    for (const pattern of patterns) {
      const match = await resolveModelScopeWithDiagnostics([pattern], runtime);
      for (const { model } of match.scopedModels) {
        const key = modelKey(model.provider, model.id);
        matchedPatterns.set(key, [...(matchedPatterns.get(key) ?? []), pattern]);
      }
    }
    return {
      unrestricted: false,
      enabledKeys,
      matchedPatterns,
      diagnostics: resolved.diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        message: diagnostic.message,
        pattern: diagnostic.pattern,
      })),
    };
  }

  private async readModelCacheMetadata(): Promise<{
    entries: Map<string, ModelCacheMetadata>;
    invalid: boolean;
  }> {
    const path = join(this.agentDir, "models-store.json");
    try {
      const metadata = await stat(path);
      if (!metadata.isFile() || metadata.size > 32 * 1_024 * 1_024) {
        return { entries: new Map(), invalid: true };
      }
      const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      const entries = new Map<string, ModelCacheMetadata>();
      for (const [providerId, rawEntry] of Object.entries(parsed)) {
        if (typeof rawEntry !== "object" || rawEntry === null || Array.isArray(rawEntry)) continue;
        const entry = rawEntry as Record<string, unknown>;
        entries.set(providerId, {
          ...(typeof entry.checkedAt === "number" && Number.isFinite(entry.checkedAt)
            ? { checkedAt: entry.checkedAt }
            : {}),
          ...(typeof entry.lastModified === "number" && Number.isFinite(entry.lastModified)
            ? { lastModified: entry.lastModified }
            : {}),
        });
      }
      return { entries, invalid: false };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { entries: new Map(), invalid: false };
      }
      return { entries: new Map(), invalid: true };
    }
  }

  private async getModelSettings(cwd: string, refreshNetwork: boolean): Promise<unknown> {
    const canonicalCwd = await this.canonicalModelSettingsCwd(cwd);
    const runtime = await this.createModelSettingsRuntime();
    const refresh: ModelRefreshAttempt = {
      attempted: refreshNetwork,
      aborted: false,
      failed: false,
      providerErrors: new Set(),
    };
    const networkDisabled = process.env.PI_OFFLINE !== undefined;

    if (refreshNetwork && !networkDisabled) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12_000);
      try {
        const result = await runtime.refresh({
          allowNetwork: true,
          force: true,
          signal: controller.signal,
        });
        refresh.aborted = result.aborted;
        refresh.providerErrors = new Set(result.errors.keys());
      } catch {
        refresh.failed = true;
      } finally {
        clearTimeout(timeout);
      }
    }

    const settings = SettingsManager.create(canonicalCwd, this.agentDir);
    const settingsErrors = settings.drainErrors();
    const globalSettings = settings.getGlobalSettings();
    const projectSettings = settings.getProjectSettings();
    const globalPatterns = globalSettings.enabledModels;
    const effectivePatterns = settings.getEnabledModels();
    const [globalScope, effectiveScope, cache] = await Promise.all([
      this.projectModelScope(globalPatterns, runtime),
      this.projectModelScope(effectivePatterns, runtime),
      this.readModelCacheMetadata(),
    ]);

    const globalDefaultProvider = globalSettings.defaultProvider;
    const globalDefaultModelId = globalSettings.defaultModel;
    const effectiveDefaultProvider = settings.getDefaultProvider();
    const effectiveDefaultModelId = settings.getDefaultModel();

    const scope = (
      patterns: string[] | undefined,
      projection: ModelScopeProjection,
      defaultProvider: string | undefined,
      defaultModelId: string | undefined,
    ) => {
      const defaultKey = defaultProvider && defaultModelId
        ? modelKey(defaultProvider, defaultModelId)
        : undefined;
      return {
        enabledModels: patterns ?? [],
        unrestricted: projection.unrestricted,
        defaultProvider: defaultProvider ?? null,
        defaultModelId: defaultModelId ?? null,
        defaultInScope: defaultKey ? projection.enabledKeys.has(defaultKey) : null,
        diagnostics: projection.diagnostics,
      };
    };

    const providers = runtime.getProviders()
      .map((provider) => {
        const auth = runtime.getProviderAuthStatus(provider.id);
        const cached = cache.entries.get(provider.id);
        const dynamic = typeof provider.refreshModels === "function";
        const methods = [
          ...(provider.auth.apiKey ? [{
            type: "api_key",
            label: provider.auth.apiKey.name,
            interactive: typeof provider.auth.apiKey.login === "function",
          }] : []),
          ...(provider.auth.oauth ? [{
            type: "oauth",
            label: provider.auth.oauth.loginLabel ?? provider.auth.oauth.name,
            interactive: true,
          }] : []),
        ];
        const models = (auth.configured ? runtime.getModels(provider.id) : [])
          .map((model) => {
            const safe = safeModel(model);
            if (!safe) return null;
            const key = modelKey(model.provider, model.id);
            return {
              model: safe,
              globalEnabled: globalScope.enabledKeys.has(key),
              enabled: effectiveScope.enabledKeys.has(key),
              globalMatchedPatterns: globalScope.matchedPatterns.get(key) ?? [],
              matchedPatterns: effectiveScope.matchedPatterns.get(key) ?? [],
            };
          })
          .filter((model) => model !== null)
          .sort((left, right) => {
            return (left.model.name ?? left.model.id)
              .localeCompare(right.model.name ?? right.model.id);
          });
        return {
          id: provider.id,
          name: provider.name,
          auth: {
            configured: auth.configured,
            source: auth.source ?? null,
            methods,
          },
          catalog: {
            kind: dynamic ? (cached ? "cached" : "builtIn") : "static",
            checkedAt: cached?.checkedAt ? new Date(cached.checkedAt).toISOString() : null,
            lastModified: cached?.lastModified ? new Date(cached.lastModified).toISOString() : null,
            refreshFailed: refresh.providerErrors.has(provider.id),
          },
          models,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

    return {
      cwd: canonicalCwd,
      providers,
      global: scope(
        globalPatterns,
        globalScope,
        globalDefaultProvider,
        globalDefaultModelId,
      ),
      effective: scope(
        effectivePatterns,
        effectiveScope,
        effectiveDefaultProvider,
        effectiveDefaultModelId,
      ),
      projectOverrides: {
        enabledModels: projectSettings.enabledModels !== undefined,
        defaultModel: projectSettings.defaultProvider !== undefined
          || projectSettings.defaultModel !== undefined,
      },
      settingsErrors: settingsErrors.map((error) => ({
        scope: error.scope,
        message: error.scope === "global"
          ? "Pi 全局设置无法读取，D Code 不会覆盖原文件。"
          : "当前项目 Pi 设置无法读取，已保留全局设置视图。",
      })),
      cacheInvalid: cache.invalid,
      refresh: {
        attempted: refresh.attempted,
        aborted: refresh.aborted,
        failed: refresh.failed,
        networkDisabled,
      },
    };
  }

  private throwForGlobalSettingsErrors(settings: SettingsManager): void {
    const globalError = settings.drainErrors().find((error) => error.scope === "global");
    if (globalError) {
      throw new PiHostError(
        "MODEL_SETTINGS_UNREADABLE",
        "Pi global settings could not be read; the existing file was preserved",
      );
    }
  }

  private async setGlobalEnabledModels(cwd: string, patterns: string[]): Promise<unknown> {
    const canonicalCwd = await this.canonicalModelSettingsCwd(cwd);
    const normalized = [...new Set(patterns.map((pattern) => pattern.trim()))];
    const settings = SettingsManager.create(canonicalCwd, this.agentDir);
    this.throwForGlobalSettingsErrors(settings);
    settings.setEnabledModels(normalized.length > 0 ? normalized : undefined);
    await settings.flush();
    this.throwForGlobalSettingsErrors(settings);
    return await this.getModelSettings(canonicalCwd, false);
  }

  private async setGlobalDefaultModel(
    cwd: string,
    provider: string,
    modelId: string,
  ): Promise<unknown> {
    const canonicalCwd = await this.canonicalModelSettingsCwd(cwd);
    const runtime = await this.createModelSettingsRuntime();
    const model = runtime.getModel(provider, modelId);
    if (!model || !runtime.hasConfiguredAuth(provider)) {
      throw new PiHostError(
        "MODEL_NOT_AVAILABLE",
        `Model is not available with configured Pi authentication: ${provider}/${modelId}`,
      );
    }

    const settings = SettingsManager.create(canonicalCwd, this.agentDir);
    this.throwForGlobalSettingsErrors(settings);
    const globalScope = await this.projectModelScope(
      settings.getGlobalSettings().enabledModels,
      runtime,
    );
    if (!globalScope.enabledKeys.has(modelKey(provider, modelId))) {
      throw new PiHostError(
        "MODEL_NOT_ENABLED",
        `Model is outside the global enabledModels scope: ${provider}/${modelId}`,
      );
    }

    settings.setDefaultModelAndProvider(provider, modelId);
    await settings.flush();
    this.throwForGlobalSettingsErrors(settings);
    return await this.getModelSettings(canonicalCwd, false);
  }

  private async startModelAuth(
    cwd: string,
    flowId: string,
    providerId: string,
    authType: AuthType,
  ): Promise<unknown> {
    const canonicalCwd = await this.canonicalModelSettingsCwd(cwd);
    const runtime = await this.createModelSettingsRuntime();
    const provider = runtime.getProvider(providerId);
    if (!provider) {
      throw new PiHostError("MODEL_AUTH_NOT_AVAILABLE", "The requested Provider is not available");
    }
    const method = authType === "oauth" ? provider.auth.oauth : provider.auth.apiKey;
    const interactive = authType === "oauth" || typeof provider.auth.apiKey?.login === "function";
    if (!method || !interactive) {
      throw new PiHostError(
        "MODEL_AUTH_NOT_INTERACTIVE",
        "This Provider must be configured through its ambient Pi or system environment",
      );
    }
    try {
      await this.modelAuth.login(flowId, runtime, providerId, authType);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new PiHostError("MODEL_AUTH_CANCELLED", "Provider authentication was cancelled");
      }
      throw new PiHostError("MODEL_AUTH_FAILED", "Provider authentication failed");
    }
    return await this.getModelSettings(canonicalCwd, false);
  }

  private handleModelAuthResponse(params: Record<string, unknown>): unknown {
    const accepted = this.modelAuth.respond(
      params.flowId as string,
      params.requestId as string,
      typeof params.value === "string" ? params.value : undefined,
      params.cancelled === true,
    );
    if (!accepted) throw new PiHostError("MODEL_AUTH_REQUEST_NOT_FOUND", "Authentication prompt is no longer active");
    return { accepted: true };
  }

  private handleModelAuthCancel(params: Record<string, unknown>): unknown {
    const cancelled = this.modelAuth.cancel(params.flowId as string);
    return { cancelled };
  }

  private getThinkingLevels(): unknown {
    const active = this.requireActive();
    return { levels: active.session.getAvailableThinkingLevels() };
  }

  private async setModel(provider: string, modelId: string): Promise<unknown> {
    const active = this.requireWritable();
    this.assertSessionMetadataIdle(active);
    await this.beforeMutation(active);
    const model = active.session.modelRuntime.getAvailableSnapshot().find((candidate) => candidate.provider === provider && candidate.id === modelId);
    if (!model) throw new PiHostError("MODEL_NOT_FOUND", `Model not found: ${provider}/${modelId}`);
    await this.withOwnedMutation(active, async () => { await active.session.setModel(model); });
    return { model: safeModel(model) };
  }

  private async setSessionName(name: string): Promise<unknown> {
    const active = this.requireWritable();
    this.assertSessionMetadataIdle(active);
    await this.beforeMutation(active);
    await this.withOwnedMutation(active, async () => {
      active.session.setSessionName(name);
    });
    await this.refreshWritablePathSnapshot(active);
    this.searchIndex.invalidate();
    return { summary: active.inspection.summary };
  }

  private async setFastMode(enabled: boolean): Promise<unknown> {
    const active = this.requireWritable();
    await this.beforeMutation(active);
    return await this.withOwnedMutation(active, async () => active.fastMode.setEnabled(enabled));
  }

  private onSessionEvent(active: WritableSession, event: AgentSessionEvent): void {
    if (!this.isActiveSession(active) || active.closing) return;
    if (event.type === "agent_start" && active.currentRun && active.currentRun.state.phase !== "stopRequested") {
      this.updateRunState(active, active.currentRun, "running");
    }
    if (event.type === "agent_end" && active.currentRun && !event.willRetry) {
      active.currentRun.outcome = outcomeFromAgentEnd(event);
    }
    if (event.type === "tool_execution_start" && active.currentRun) {
      active.currentRun.toolCalls.set(event.toolCallId, { toolName: event.toolName, args: event.args });
    }
    if (event.type === "tool_execution_end" && active.currentRun) {
      const call = active.currentRun.toolCalls.get(event.toolCallId);
      active.currentRun.toolCalls.delete(event.toolCallId);
      const change = structuredToolChange({
        sessionId: active.session.sessionId,
        runId: active.currentRun.id,
        ...(active.currentRun.pathEntryId ? { pathEntryId: active.currentRun.pathEntryId } : {}),
        cwd: active.session.sessionManager.getCwd(),
        toolCallId: event.toolCallId,
        toolName: call?.toolName ?? event.toolName,
        args: call?.args,
        result: event.result,
        isError: event.isError,
      });
      if (change) this.emitRuntimeEvent(active, "session.changeRecorded", change);
    }
    this.emitRuntimeEvent(active, "session.event", toWireEvent(active, event));
    if (event.type === "entry_appended") {
      const plan = planFromEntry(event.entry);
      if (plan.matched) {
        active.activePlan = plan.plan;
        active.activeProposal = plan.proposal;
        this.emitRuntimeEvent(active, "plan.changed", { entryId: event.entry.id, plan: plan.plan, proposal: plan.proposal });
      }
    }
    const shouldSynchronize = (
      event.type === "entry_appended"
      || event.type === "message_end"
      || event.type === "thinking_level_changed"
      || event.type === "session_info_changed"
      || event.type === "agent_settled"
      || (event.type === "compaction_end" && !event.aborted && event.result !== undefined)
    );
    if (!shouldSynchronize) return;
    this.searchIndex.invalidate();
    this.synchronizeOwnedSnapshot(active);
    if (event.type === "agent_settled" && active.currentRun) {
      void this.finalizeRun(active, active.currentRun);
    }
  }

  private onPersistedAgentEvent(active: WritableSession, event: AgentEvent): void {
    if (!this.isActiveSession(active)) return;
    const call = this.promptCall.getStore();
    if(event.type==="message_end"&&event.message.role==="user"&&active.currentRun?.steering){
      const run=active.currentRun,leaf=active.session.sessionManager.getLeafEntry();
      const pending=[...run.steering!.values()].find(item=>!item.sourceEntryId&&(event.message as {dcodeSteerId?:string}).dcodeSteerId===item.message.id&&extractSearchableMessage(event.message)?.body===item.effectiveText);
      if(pending&&leaf?.type==="message"&&leaf.message===event.message){
        pending.sourceEntryId=leaf.id;run.latestRawInputId=pending.message.originRawInputId;
        run.steeringPersistence=(run.steeringPersistence??Promise.resolve()).then(async()=>{const saved=await (await this.getProductStore()).consumeSteeringMessage({messageId:pending.message.id,sessionRunId:run.sessionRunId!,sourceEntryId:leaf.id,effectiveText:pending.effectiveText,inputSources:pending.inputSources});pending.effectiveInputId=saved.effectiveInputId;for(const [id,raw] of pending.knownUserUpdates){run.knownUserUpdates??=new Map();run.knownUserUpdates.set(id,raw);}this.options.emit("foundation.changed",{kind:"collaboration.steeringConsumed",taskId:pending.message.taskId});});
        void run.steeringPersistence.catch(error=>this.markConflict(active,error));
      }
    }

    if (
      event.type === "message_end"
      && event.message.role === "user"
      && call?.active === active
      && !call.confirmed
      && !call.confirmation
    ) {
      const leaf = active.session.sessionManager.getLeafEntry();
      if (leaf?.type !== "message" || leaf.message !== event.message) return;
      call.persistedEntryId = leaf.id;
      if (active.currentRun?.id === call.promptId) {
        active.currentRun.pathEntryId = leaf.id;
        this.updateRunState(active, active.currentRun, active.currentRun.state.phase, {
          inputPersisted: true,
          retryable: false,
        });
      }
      call.confirmation = this.synchronizeOwnedSnapshot(active).then(() => {
        if (active.conflict || call.confirmed) return;
        call.confirmed = true;
        this.emitRuntimeEvent(active, "session.promptCompleted", {
          sessionId: active.session.sessionId,
          promptId: call.promptId,
          outcome: "persisted",
          entryId: leaf.id,
        });
      });
    }
  }

  private synchronizeOwnedSnapshot(active: WritableSession): Promise<void> {
    active.leaseSync = active.leaseSync
      .then(async () => {
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const expectedDigest = agentSessionSnapshotDigest(active.session);
          try {
            await active.lease.acceptOwnedChange(expectedDigest);
            return;
          } catch (error) {
            const reason = leaseVerificationFailureReason(error);
            if (attempt === 7 || (reason !== "changed_during_verification" && reason !== "snapshot_mismatch")) throw error;
            await new Promise<void>((resolve) => setImmediate(resolve));
            if (reason === "snapshot_mismatch" && agentSessionSnapshotDigest(active.session) === expectedDigest) throw error;
          }
        }
      })
      .catch((error) => {
        if (!active.closing) this.markConflict(active, error);
      });
    return active.leaseSync;
  }

  private async withOwnedMutation<T>(active: WritableSession, operation: () => Promise<T>): Promise<T> {
    active.ownedMutationDepth += 1;
    try {
      const result = await operation();
      await this.synchronizeOwnedSnapshot(active);
      if (active.conflict) throw new PiHostError(active.conflict.code, active.conflict.message, active.conflict.details);
      return result;
    } finally {
      active.ownedMutationDepth -= 1;
    }
  }

  private async assertLeaseStable(active: WritableSession): Promise<void> {
    for (;;) {
      const observedSync = active.leaseSync;
      await observedSync;
      if (active.conflict) throw new PiHostError(active.conflict.code, active.conflict.message, active.conflict.details);
      try {
        await active.lease.assertUnchanged();
        return;
      } catch (error) {
        await Promise.resolve();
        if (observedSync !== active.leaseSync) continue;
        throw error;
      }
    }
  }

  private async beforeMutation(active: WritableSession): Promise<void> {
    await this.assertLeaseStable(active);
  }

  private async checkConflict(active: WritableSession): Promise<void> {
    if (!this.isActiveSession(active) || active.conflict || active.ownedMutationDepth > 0) return;
    try {
      await this.assertLeaseStable(active);
    } catch (error) {
      if (!this.isActiveSession(active) || active.conflict) return;
      this.markConflict(active, error);
    }
  }

  private markConflict(active: WritableSession, error: unknown): void {
    if (!this.isActiveSession(active) || active.closing || active.conflict) return;
    active.conflict = errorRecord(error);
    clearInterval(active.conflictTimer);
    const abort = active.session.abort();
    void abort.catch(() => undefined);
    active.conflictAbort = abort;
    this.emitRuntimeEvent(active, "session.conflict", {
      sessionId: active.inspection.summary.id,
      ...active.conflict,
    });
  }

  private async inspectStableObservation(sessionId: string, leafId?: string | null): Promise<{
    inspection: SessionInspection;
    version: SessionFileVersion;
  }> {
    const summary = await this.reader.resolve(sessionId);
    return await this.inspectStablePath(summary.path, sessionId, leafId);
  }

  private async inspectStablePath(path: string, sessionId: string, leafId?: string | null): Promise<{
    inspection: SessionInspection;
    version: SessionFileVersion;
  }> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const before = await readSessionFileVersion(path);
      try {
        const inspection = await this.reader.inspectPath(path, sessionId, leafId);
        const after = await readSessionFileVersion(path);
        if (sameSessionFileVersion(before, after)) return { inspection, version: after };
      } catch (error) {
        let after: SessionFileVersion;
        try {
          after = await readSessionFileVersion(path);
        } catch {
          if (attempt === 3) throw error;
          await new Promise<void>((resolve) => setImmediate(resolve));
          continue;
        }
        if (sameSessionFileVersion(before, after)) throw error;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new PiHostError(
      "SESSION_CHANGED_DURING_REFRESH",
      "The session kept changing while D Code was opening it",
      { sessionId },
    );
  }

  private async refreshActiveSession(): Promise<SessionInspection> {
    const active = this.requireActive();
    const inspection = await this.reader.inspectPath(
      active.inspection.summary.path,
      active.inspection.summary.id,
      active.session.sessionManager.getLeafId(),
    );
    this.assertSameSessionIdentity(active.inspection.header, inspection.header);
    return inspection;
  }

  private requireActive(): ActiveSession {
    if (!this.active) throw new PiHostError("SESSION_NOT_OPEN", "No session is open");
    return this.active;
  }

  private isActiveSession(active: ActiveSession): boolean {
    const runtimeId = active.runtimeIdentity?.runtimeId;
    return runtimeId ? this.runtimes.get(runtimeId) === active : this.legacyActive === active;
  }

  private assertSameSessionIdentity(expected: SessionHeader, actual: SessionHeader): void {
    if (sameSessionIdentity(expected, actual)) return;
    throw new PiHostError(
      "SESSION_IDENTITY_CHANGED",
      "The session file identity changed while D Code was observing it",
      { sessionId: expected.id },
    );
  }

  private requireWritable(): WritableSession {
    this.assertWriteHealthy();
    const active = this.requireActive();
    if(active.closing)throw new PiHostError("SESSION_CLOSING","当前运行正在收尾");
    if (active.conflict) throw new PiHostError(active.conflict.code, active.conflict.message, active.conflict.details);
    return active;
  }

  private assertWriteHealthy(): void {
    const runtimeId = this.runtimeContext.getStore();
    const poison = runtimeId
      ? this.runtimeWritePoisons.get(runtimeId) ?? this.active?.writePoison
      : this.writePoison;
    if (!poison) return;
    throw new PiHostError(
      "HOST_RESTART_REQUIRED",
      runtimeId
        ? "This Runtime must be reopened before another write"
        : "D Code must restart its Host before another write",
      poison,
    );
  }

  private poisonWrites(active: WritableSession, reason: string): void {
    const poison = { sessionId: active.inspection.summary.id, reason };
    active.writePoison = poison;
    const runtimeId = active.runtimeIdentity?.runtimeId;
    if (runtimeId) {
      this.runtimeWritePoisons.set(runtimeId, poison);
      this.emitRuntimeEvent(active, "host.restartRequired", poison);
      return;
    }
    this.poisonWritesForSession(active.inspection.summary.id, reason);
  }

  private poisonWritesForSession(sessionId: string, reason: string): void {
    const runtimeId = this.runtimeContext.getStore();
    if (runtimeId) {
      if (this.runtimeWritePoisons.has(runtimeId)) return;
      const poison = { sessionId, reason };
      this.runtimeWritePoisons.set(runtimeId, poison);
      this.options.emit("host.restartRequired", { ...poison, runtimeId });
      return;
    }
    if (this.writePoison) return;
    this.writePoison = { sessionId, reason };
    this.options.emit("host.restartRequired", this.writePoison);
  }
}
