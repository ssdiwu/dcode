import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import type { AgentEvent, ThinkingLevel } from "@earendil-works/pi-agent-core";
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
]);

type Emit = (event: string, data?: unknown) => void;
const HOST_VERSION = "0.0.28";

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
  "session.steer",
  "session.abort",
  "extension.respond",
  "agentRequest.answer",
  "agentRun.stop",
]);

type RunPhase = "running" | "waitingForUser" | "stopRequested" | "completed" | "failed" | "aborted" | "unknown";
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
  effectiveInputId?: string;
  promptReceiptId?: string;
  pathEntryId?: string;
  toolCalls: Map<string, { toolName: string; args: unknown }>;
  state: RunState;
  outcome?: RunOutcome;
  finalization?: Promise<void>;
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
  currentRun?: ActiveRun;
  lastRunState?: RunState;
  runtimeIdentity?: RuntimeIdentity;
  runtimeEventSequence: number;
  seenPromptIds: Map<string, string>;
  seenSteerIds: Map<string, string>;
  writePoison?: { sessionId: string; reason: string };
  assembledPrompt?: AssembledDCodePrompt;
  promptEnvironment?: DCodePromptEnvironment;
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
  runtimeIds: Set<string>;
}

interface PendingAgentRequestResolution {
  runtimeId: string;
  resolve: (answer: unknown) => void;
  reject: (error: Error) => void;
  removeAbortListener?: () => void;
}

interface TeamStartFlight {
  requestId: string;
  fingerprint: string;
  promise: Promise<unknown>;
}

interface PromptCallContext {
  active: WritableSession;
  promptId: string;
  confirmed: boolean;
  confirmation?: Promise<void>;
  persistedEntryId?: string;
  rollbackLeafId?: string | null;
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

function teamStartFingerprint(params: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify({
    requestId: params.requestId,
    expectedStoreRevision: params.expectedStoreRevision,
    expectedTeamRunRevision: params.expectedTeamRunRevision,
    scope: params.scope,
    taskId: params.taskId,
    teamRunId: params.teamRunId,
    message: params.message,
    ...(params.workspace === undefined ? {} : { workspace: params.workspace }),
  })).digest("hex");
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
  private readonly teamLifecycles = new Map<string, Promise<void>>();
  private readonly teamStartFlights = new Map<string, TeamStartFlight>();
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
    const current = claims.get(cwd);
    if (!current) {
      claims.set(cwd, { access, runtimeIds: new Set([runtimeId]) });
      return;
    }
    if (current.access !== "sharedReadOnly" || access !== "sharedReadOnly") {
      if (!current.runtimeIds.has(runtimeId) || current.runtimeIds.size > 1) {
        throw new PiHostError("WORKSPACE_IN_USE", "Runtime workspace claim conflicts with an active writer", { cwd });
      }
    }
    current.runtimeIds.add(runtimeId);
  }

  private releaseWorkspaceClaim(
    claims: Map<string, WorkspaceClaim>,
    cwd: string,
    runtimeId: string,
  ): void {
    const current = claims.get(cwd);
    if (!current) return;
    current.runtimeIds.delete(runtimeId);
    if (current.runtimeIds.size === 0) claims.delete(cwd);
  }

  private workspaceConflict(cwd: string, runtimeId: string, access: WorkspaceClaim["access"]): string | undefined {
    for (const claims of [this.runtimeWorkspaceClaims, this.openingWorkspaceClaims]) {
      const current = claims.get(cwd);
      if (!current) continue;
      const otherRuntime = [...current.runtimeIds].find((candidate) => candidate !== runtimeId);
      if (!otherRuntime) continue;
      if (current.access === "exclusiveWrite" || access === "exclusiveWrite") return otherRuntime;
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
    await this.ensureDCodeRuntimeModelCatalog();
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
    const runtimeModelSelection = snapshot.runtimeModelSelection;
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
    if (!credentialReference) {
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
      },
      documents,
      importedHistory,
      runtimeModelSelection,
    };
  }

  private async refreshRuntimePrompt(active: WritableSession): Promise<void> {
    const identity = active.runtimeIdentity;
    if (!identity) return;
    const context = await this.runtimePromptContext(identity);
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

  async handle(method: HostMethod, params: Record<string, unknown>): Promise<unknown> {
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
    this.modelAuth.close();
    const searchClose = this.searchShutdown ?? this.searchIndex.close();
    this.searchShutdown = searchClose;
    try {
      await this.operationQueue;
      await Promise.all([...this.runtimeQueues.values()]);
      await Promise.all([...this.runtimes.keys()].map(async (runtimeId) => {
        await this.runtimeContext.run(runtimeId, async () => { await this.closeActive(); });
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
            dcodeSessionPresentation: true,
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
      case "dcodeSession.presentation":
        return await this.dcodeSessionPresentation(params.dcodeSessionId as string);
      case "dcodeSession.prompt":
        return await this.promptDCodeSession({
          dcodeSessionId: params.dcodeSessionId as string,
          promptId: params.promptId as string,
          message: params.message as string,
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
      case "task.create": {
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
        const result = await (await this.getProductStore()).decideTaskAcceptance({
          requestId: params.requestId as string,
          expectedStoreRevision: params.expectedStoreRevision as number,
          taskId: params.taskId as string,
          scope: params.scope as TaskScope,
          expectedTaskRevision: params.expectedTaskRevision as number,
          decision: params.decision as "accepted" | "rejected",
        });
        this.options.emit("foundation.changed", {
          storeRevision: result.storeRevision,
          kind: result.task.state === "completed" ? "task.accepted" : "task.rejected",
          entityKind: "task",
          entityId: result.task.id,
          taskId: result.task.id,
        });
        return result;
      }
      case "team.create": {
        const result = await (await this.getProductStore()).createTeamRun({
          requestId: params.requestId as string,
          expectedStoreRevision: params.expectedStoreRevision as number,
          taskId: params.taskId as string,
          scope: params.scope as TaskScope,
          members: params.members as Array<{
            profileId: string;
            title: string;
            taskPacket: Record<string, unknown>;
          }>,
        });
        this.options.emit("foundation.changed", {
          storeRevision: result.storeRevision,
          kind: "teamRun.created",
          entityKind: "teamRun",
          entityId: result.teamRun.id,
          taskId: result.teamRun.taskId,
        });
        return result;
      }
      case "team.start":
        return await this.startTeamRun(params);
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
          teamRunId: params.teamRunId as string,
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
        if (active.currentRun) this.updateRunState(active, active.currentRun, "stopRequested");
        try {
          await active.session.abort();
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
      case "host.shutdown":
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
    const store = await this.getProductStore();
    const prepared = await store.prepareAgentRunStop({
      requestId: params.requestId as string,
      expectedStoreRevision: params.expectedStoreRevision as number,
      scope: params.scope as TaskScope,
      taskId: params.taskId as string,
      teamRunId: params.teamRunId as string,
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
      await active.session.abort();
      await active.session.waitForIdle();
      await this.finalizeRun(active, run, "aborted");
      await this.finishDurableSessionRun(active, run, "aborted");
      const finished = await store.finishOperationAttempt({
        attemptId: prepared.attemptId,
        outcome: "succeeded",
      });
      this.options.emit("foundation.changed", {
        storeRevision: finished.storeRevision,
        kind: "agentRun.stopped",
        entityKind: "agentRun",
        entityId: identity.agentRunId,
        taskId: identity.taskId,
        runtimeId: identity.runtimeId,
      });
      return { stopped: true, attemptId: prepared.attemptId, storeRevision: finished.storeRevision };
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

  private async dcodeSessionPresentation(dcodeSessionIdValue: string): Promise<unknown> {
    const dcodeSessionId = dcodeSessionIdValue.trim();
    const store = await this.getProductStore();
    const snapshot = await store.snapshot();
    const dcodeSession = snapshot.sessions.find((candidate) => candidate.id === dcodeSessionId);
    if (!dcodeSession) {
      throw new PiHostError("DCODE_SESSION_NOT_FOUND", "D Code Session does not exist", { dcodeSessionId });
    }
    const binding = snapshot.sessionRuntimeBindings.find((candidate) => candidate.sessionId === dcodeSession.id);
    const active = [...this.runtimes.values()].find((candidate) => (
      candidate.runtimeIdentity?.dcodeSessionId === dcodeSession.id
    ));
    if (!binding) {
      return {
        dcodeSession,
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
        binding,
        runtime: active?.runtimeIdentity
          ? { runtimeId: active.runtimeIdentity.runtimeId, state: this.runtimeState(active) }
          : null,
        adapterState: "ready",
        inspection: await this.reader.inspect(binding.adapterSessionId),
      };
    } catch (error) {
      if (error instanceof SessionReadError) {
        return {
          dcodeSession,
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
    promptId: string;
    message: string;
    images?: PromptImageInput[];
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
    let runtimeId = this.runtimeByDCodeSessionId.get(dcodeSession.id);
    const existingRuntime = runtimeId ? this.runtimes.get(runtimeId) : undefined;
    let agentRunId = existingRuntime?.runtimeIdentity?.agentRunId;
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
        requestId: `coordinator-agent-run:${dcodeSession.id}`,
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
    }
    const result = await this.handleRuntimeRequest("session.prompt", {
      runtimeId,
      promptId: input.promptId,
      message: input.message,
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

  private async startTeamRun(params: Record<string, unknown>): Promise<unknown> {
    const taskId = params.taskId as string;
    const teamRunId = params.teamRunId as string;
    const requestId = params.requestId as string;
    const key = `${taskId}\0${teamRunId}`;
    const fingerprint = teamStartFingerprint(params);
    const existing = this.teamStartFlights.get(key);
    if (existing) {
      if (existing.requestId !== requestId) {
        throw new PiHostError(
          "TEAM_START_IN_PROGRESS",
          "Another Team start request is still provisioning this Team; D Code did not merge their inputs",
          { taskId, teamRunId },
        );
      }
      if (existing.fingerprint !== fingerprint) {
        throw new PiHostError(
          "IDEMPOTENCY_KEY_REUSED",
          "The same Team start requestId was reused with different parameters",
          { taskId, teamRunId, requestId },
        );
      }
      return await existing.promise;
    }
    const promise = this.startTeamRunOnce(params);
    const flight: TeamStartFlight = { requestId, fingerprint, promise };
    this.teamStartFlights.set(key, flight);
    try {
      return await promise;
    } finally {
      if (this.teamStartFlights.get(key) === flight) this.teamStartFlights.delete(key);
    }
  }

  private async startTeamRunOnce(params: Record<string, unknown>): Promise<unknown> {
    const taskId = params.taskId as string;
    const teamRunId = params.teamRunId as string;
    const message = params.message as string;
    const store = await this.getProductStore();
    const claimed = await store.claimTeamRunStart({
      requestId: params.requestId as string,
      expectedStoreRevision: params.expectedStoreRevision as number,
      expectedTeamRunRevision: params.expectedTeamRunRevision as number,
      scope: params.scope as TaskScope,
      taskId,
      teamRunId,
    });
    this.options.emit("foundation.changed", {
      storeRevision: claimed.storeRevision,
      kind: "teamRun.startClaimed",
      entityKind: "teamRun",
      entityId: teamRunId,
      taskId,
    });
    const snapshot = await store.snapshot();
    const task = snapshot.tasks.find((candidate) => candidate.id === taskId);
    const teamRun = snapshot.teamRuns.find((candidate) => candidate.id === teamRunId && candidate.taskId === taskId);
    if (!task || !teamRun) {
      throw new PiHostError("TEAM_RUN_NOT_ACTIVE", "Team Run is missing", { taskId, teamRunId });
    }
    if (JSON.stringify(task.scope) !== JSON.stringify(params.scope)) {
      throw new PiHostError("RUNTIME_IDENTITY_MISMATCH", "Team Run Task Scope does not match the stored Task");
    }
    const agentRuns = snapshot.agentRuns.filter((candidate) => (
      candidate.teamRunId === teamRunId || candidate.id === teamRun.coordinatorAgentRunId
    ));
    const taskContextSet = snapshot.taskContextSets.find((candidate) => candidate.taskId === taskId);
    if (agentRuns.length < 2) {
      throw new PiHostError("TEAM_RUN_INCOMPLETE", "Team Run requires a Coordinator and at least one member");
    }
    if (!taskContextSet) {
      throw new PiHostError("RUNTIME_IDENTITY_MISMATCH", "Team Run Task has no durable Context Selection set");
    }
    const runtimeDescriptors = agentRuns.map((agentRun) => ({
      runtimeId: this.runtimeByDCodeSessionId.get(agentRun.sessionId) ?? `runtime-${agentRun.id}`,
      agentRunId: agentRun.id,
      sessionId: agentRun.sessionId,
    }));
    if (["completed", "failed", "aborted", "interrupted", "unknown"].includes(teamRun.status)) {
      const agentRunIds = new Set(agentRuns.map((agentRun) => agentRun.id));
      const started = snapshot.sessionRuns.some((run) => run.agentRunId && agentRunIds.has(run.agentRunId));
      return {
        taskId,
        teamRunId,
        runtimes: runtimeDescriptors,
        coordinatorManaged: true,
        started,
        terminalStatus: teamRun.status,
        replayed: true,
      };
    }
    if (this.teamLifecycles.has(teamRunId)) {
      return { taskId, teamRunId, runtimes: runtimeDescriptors, coordinatorManaged: true, started: true, replayed: true };
    }
    let managedWorkerWorktrees: Map<string, ManagedWorkerWorktreeRecord>;
    try {
      managedWorkerWorktrees = await this.provisionTeamWorkerWorktrees({
        store,
        task,
        teamRunId,
        agentRuns,
        expectedStoreRevision: claimed.storeRevision,
        requestId: params.requestId as string,
        projects: snapshot.projects,
        taskContextSources: taskContextSet.sources,
      });
    } catch (error) {
      const reasonCode = error instanceof PiHostError ? error.code : "WORKSPACE_WORKTREE_CREATE_UNKNOWN";
      await this.finishTeamRunDurably({
        requestId: `team-start-failed:${teamRunId}:${reasonCode}`,
        taskId,
        teamRunId,
        status: "failed",
        reason: error instanceof Error ? error.message : "Worker worktree provisioning failed before Runtime start",
        reasonCode,
      });
      return {
        taskId,
        teamRunId,
        runtimes: runtimeDescriptors,
        coordinatorManaged: true,
        started: false,
        terminalStatus: "failed",
        reasonCode,
      };
    }
    const sourceWorkspace = {
      workspaceId: `source:${task.id}`,
      cwd: task.cwd,
      access: "sharedReadOnly" as const,
    };
    const settlements = await Promise.allSettled(agentRuns.map(async (agentRun) => {
      const existingRuntimeId = this.runtimeByDCodeSessionId.get(agentRun.sessionId);
      const existingRuntime = existingRuntimeId ? this.runtimes.get(existingRuntimeId) : undefined;
      if (existingRuntime && existingRuntimeId) {
        if (
          agentRun.id !== teamRun.coordinatorAgentRunId
          || existingRuntime.runtimeIdentity?.agentRunId !== agentRun.id
        ) {
          throw new PiHostError(
            "SESSION_ALREADY_ACTIVE",
            "An active D Code Session Runtime does not belong to this Team Coordinator Agent Run",
            {
              dcodeSessionId: agentRun.sessionId,
              runtimeId: existingRuntimeId,
              agentRunId: agentRun.id,
            },
          );
        }
        return { agentRun, runtimeId: existingRuntimeId, result: { reused: true } };
      }
      const runtimeId = `runtime-${agentRun.id}`;
      const workerWorktree = managedWorkerWorktrees.get(agentRun.id);
      const runtimeWorkspace = workerWorktree
        ? {
          workspaceId: workerWorktree.workspaceId,
          cwd: workerWorktree.workspaceCwd,
          access: "exclusiveWrite" as const,
        }
        : {
          workspaceId: `${sourceWorkspace.workspaceId}:${agentRun.id}`,
          cwd: sourceWorkspace.cwd,
          access: sourceWorkspace.access,
        };
      const result = await this.runtimeContext.run(runtimeId, async () => await this.startDCodeRuntime({
        requestId: `${params.requestId as string}:${agentRun.id}`,
        runtimeId,
        taskId,
        dcodeSessionId: agentRun.sessionId,
        agentRunId: agentRun.id,
        scope: task.scope,
        workspace: runtimeWorkspace,
      }));
      return { agentRun, runtimeId, result };
    }));
    const started = settlements.flatMap((settlement) => settlement.status === "fulfilled" ? [settlement.value] : []);
    const failedStart = settlements.find((settlement) => settlement.status === "rejected");
    if (failedStart?.status === "rejected") {
      await Promise.all(started.map(async ({ runtimeId }) => await this.closeRuntime(runtimeId)));
      await this.finishTeamRunDurably({
        requestId: `team-start-failed:${teamRunId}:partial-runtime-open`,
        taskId,
        teamRunId,
        status: "failed",
        reason: "One or more Team Runtimes could not be opened safely",
      });
      return {
        taskId,
        teamRunId,
        runtimes: runtimeDescriptors,
        coordinatorManaged: true,
        started: false,
        terminalStatus: "failed",
        reasonCode: errorRecord(failedStart.reason).code,
      };
    }
    const assignments = snapshot.agentAssignments.filter((candidate) => candidate.teamRunId === teamRunId);
    const rawLifecycle = this.runCoordinatedTeamLifecycle({
      taskId,
      teamRunId,
      message,
      coordinatorAgentRunId: teamRun.coordinatorAgentRunId,
      started,
      assignments,
    });
    const lifecycle = rawLifecycle.catch(async (error) => {
      await this.finishTeamRunDurably({
        requestId: `team-lifecycle-failed:${teamRunId}`,
        taskId,
        teamRunId,
        status: "failed",
        reason: "Coordinator lifecycle failed before durable completion",
      }).catch(() => undefined);
      throw error;
    }).finally(async () => {
      await Promise.all(started.map(async ({ runtimeId }) => await this.closeRuntime(runtimeId)));
    });
    this.teamLifecycles.set(teamRunId, lifecycle);
    void lifecycle.catch((error) => {
      this.options.emit("team.lifecycleFailed", {
        taskId,
        teamRunId,
        ...errorRecord(error),
      });
    }).finally(() => {
      if (this.teamLifecycles.get(teamRunId) === lifecycle) this.teamLifecycles.delete(teamRunId);
    });
    return {
      taskId,
      teamRunId,
      runtimes: runtimeDescriptors,
      coordinatorManaged: true,
      started: true,
      claimStoreRevision: claimed.storeRevision,
    };
  }

  private async closeRuntime(runtimeId: string): Promise<void> {
    await this.runtimeContext.run(runtimeId, async () => { await this.closeActive(); });
  }

  private async finishTeamRunDurably(input: {
    requestId: string;
    taskId: string;
    teamRunId: string;
    status: "failed" | "aborted";
    reason: string;
    reasonCode?: string;
  }): Promise<void> {
    const result = await (await this.getProductStore()).finishTeamRun(input);
    this.options.emit("foundation.changed", {
      storeRevision: result.storeRevision,
      kind: `teamRun.${result.teamRun.status}`,
      entityKind: "teamRun",
      entityId: result.teamRun.id,
      taskId: result.teamRun.taskId,
    });
  }

  private async provisionTeamWorkerWorktrees(input: {
    store: ProductStore;
    task: TaskRecord;
    teamRunId: string;
    agentRuns: AgentRunRecord[];
    expectedStoreRevision: number;
    requestId: string;
    projects: Array<{ id: string; directory: string }>;
    taskContextSources: TaskContextSourceRecord[];
  }): Promise<Map<string, ManagedWorkerWorktreeRecord>> {
    const workers = input.agentRuns.filter((agentRun) => agentRun.role === "worker");
    if (workers.length === 0) return new Map();
    const scope = input.task.scope;
    if (scope.kind !== "project") {
      throw new PiHostError(
        "WORKSPACE_PROJECT_SCOPE_REQUIRED",
        "Worker requires a Project Scope with a Git repository; User Scope remains read-only in this release",
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

  private async runCoordinatedTeamLifecycle(input: {
    taskId: string;
    teamRunId: string;
    message: string;
    coordinatorAgentRunId: string;
    started: Array<{ agentRun: { id: string; sessionId: string }; runtimeId: string; result: unknown }>;
    assignments: Array<{ agentRunId?: string; taskPacket: unknown }>;
  }): Promise<void> {
    const coordinator = input.started.find(({ agentRun }) => agentRun.id === input.coordinatorAgentRunId);
    if (!coordinator) throw new PiHostError("TEAM_RUN_INCOMPLETE", "Team Run has no Coordinator Runtime");
    const members = input.started.filter(({ agentRun }) => agentRun.id !== input.coordinatorAgentRunId);
    await this.handleRuntimeRequest("session.prompt", {
      runtimeId: coordinator.runtimeId,
      message: `${input.message}\n\n第一阶段：先理解目标、边界和成员职责，形成协调计划；不要假装成员已经完成。`,
      promptId: `team:${input.teamRunId}:coordinator-plan`,
    });
    const planningStatus = await this.waitForAgentRunTerminal(input.coordinatorAgentRunId);
    if (planningStatus !== "completed") {
      await this.finishTeamRunDurably({
        requestId: `team-lifecycle-terminal:${input.teamRunId}:planning`,
        taskId: input.taskId,
        teamRunId: input.teamRunId,
        status: planningStatus === "aborted" ? "aborted" : "failed",
        reason: `Coordinator planning ended as ${planningStatus}`,
      });
      return;
    }

    await Promise.all(members.map(async ({ agentRun, runtimeId }) => {
      const assignment = input.assignments.find((candidate) => candidate.agentRunId === agentRun.id);
      await this.handleRuntimeRequest("session.prompt", {
        runtimeId,
        message: `执行 D Code Agent Assignment（智能体指派）：\n${JSON.stringify(assignment?.taskPacket ?? {})}`,
        promptId: `team:${input.teamRunId}:${agentRun.id}:work`,
      });
    }));
    await Promise.all(members.map(async ({ agentRun }) => await this.waitForAgentRunTerminal(agentRun.id)));

    const memberIds = new Set(members.map(({ agentRun }) => agentRun.id));
    const snapshot = await (await this.getProductStore()).snapshot();
    const reports = snapshot.agentReports
      .filter((report) => memberIds.has(report.agentRunId))
      .map((report) => ({
        agentRunId: report.agentRunId,
        reportKind: report.reportKind,
        body: report.body,
      }));
    await this.handleRuntimeRequest("session.prompt", {
      runtimeId: coordinator.runtimeId,
      message: [
        "第二阶段：下面是已经持久化的 Child Agent Reports（子代理报告）。",
        "只综合报告中真实存在的事实、分歧、未知与证据；不要把成员完成自动等同于 Task 验收。",
        JSON.stringify(reports),
      ].join("\n"),
      promptId: `team:${input.teamRunId}:coordinator-synthesis`,
    });
    const synthesisStatus = await this.waitForAgentRunTerminal(input.coordinatorAgentRunId);
    if (synthesisStatus !== "completed") {
      await this.finishTeamRunDurably({
        requestId: `team-lifecycle-terminal:${input.teamRunId}:synthesis`,
        taskId: input.taskId,
        teamRunId: input.teamRunId,
        status: synthesisStatus === "aborted" ? "aborted" : "failed",
        reason: `Coordinator synthesis ended as ${synthesisStatus}`,
      });
      return;
    }
    await this.waitForTeamTerminal(input.teamRunId);
    this.options.emit("foundation.changed", {
      kind: "teamRun.coordinatorSynthesized",
      entityKind: "teamRun",
      entityId: input.teamRunId,
      taskId: input.taskId,
    });
  }

  private async waitForAgentRunTerminal(agentRunId: string, timeoutMs = 120_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const snapshot = await (await this.getProductStore()).snapshot();
      const status = snapshot.agentRuns.find((run) => run.id === agentRunId)?.status;
      if (["completed", "failed", "aborted", "interrupted", "unknown"].includes(status ?? "")) return status!;
      if (Date.now() >= deadline) {
        throw new PiHostError("TEAM_RUN_TIMEOUT", "Timed out while waiting for an Agent Run", { agentRunId, status });
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  private async waitForTeamTerminal(teamRunId: string, timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const snapshot = await (await this.getProductStore()).snapshot();
      const status = snapshot.teamRuns.find((run) => run.id === teamRunId)?.status;
      if (["completed", "failed", "aborted", "interrupted", "unknown"].includes(status ?? "")) return;
      if (Date.now() >= deadline) {
        throw new PiHostError("TEAM_RUN_TIMEOUT", "Timed out while waiting for Coordinator synthesis", { teamRunId, status });
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
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
    const sessionDir = join(this.sessionsDirectory, sessionDirectoryName(canonicalCwd));
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

  private async copySession(sessionId: string, targetCwd: string): Promise<unknown> {
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
      const result = await this.sessionCopier.copy({ source, targetCwd, assertSourceStable });
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
      const sourceSettingsManager = SettingsManager.create(manager.getCwd(), this.agentDir);
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
          ...(agentRequestController
            ? [{
              name: "dcode-agent-request",
              hidden: true,
              factory: createDCodeAgentRequestExtension(agentRequestController),
            }]
            : []),
        ],
        ...(runtimeIdentity ? { systemPromptOverride: () => assembledPrompt?.text } : {}),
        ...(runtimeIdentity ? { allowExternalExtensions: false } : {}),
      });
      await resourceLoader.reload();
      const created = await createAgentSession({
        cwd: manager.getCwd(),
        agentDir: this.agentDir,
        sessionManager: manager,
        settingsManager: sourceSettingsManager,
        resourceLoader,
        ...(promptContext && new Set(["coordinator", "explore", "verifier", "custom"]).has(promptContext.environment.role)
          ? { tools: ["read", "grep", "find", "ls", "dcode_facts", DCODE_AGENT_REQUEST_TOOL_NAME] }
          : {}),
        sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile: inspection.summary.path },
      });
      session = created.session;
      if (promptContext) {
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
          const credentialProbe = JSON.stringify({ prompt: input.prompt, options: normalizedOptions });
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
            kind: "choice",
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
        onError: (error) => this.options.emit("extension.error", error),
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
    this.active = undefined;
    clearInterval(active.conflictTimer);
    active.closing = true;
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
    } finally {
      active.unsubscribe();
      active.session.dispose();
      active.fastMode.dispose();
      active.attemptController?.dispose();
      active.agentRequestController?.dispose();
      if (safeToRelease) {
        try {
          await active.lease.release();
        } catch (error) {
          safeToRelease = false;
          this.options.emit("session.cleanupError", { step: "lease release", ...errorRecord(error) });
        }
      }
      if (!safeToRelease) this.poisonWrites(active, "The previous runtime did not stop cleanly");
      this.emitRuntimeEvent(active, "session.closed", { mode: "writable", sessionId: active.inspection.summary.id });
    }
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
    if (oldLeafId === rollbackLeafId) return;
    try {
      await this.withOwnedMutation(active, async () => {
        if (rollbackLeafId === null) manager.resetLeaf();
        else manager.branch(rollbackLeafId);
        active.session.agent.state.messages = manager.buildSessionContext().messages;
        await active.session.extensionRunner.emit({
          type: "session_tree",
          newLeafId: manager.getLeafId(),
          oldLeafId,
        });
      });
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
  ): Promise<unknown> {
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
    if (runtimeIdentity) await this.refreshRuntimePrompt(active);
    const call: PromptCallContext = {
      active,
      promptId,
      confirmed: false,
    };
    if (pathAction) {
      call.rollbackLeafId = await this.applyPathAction(active, pathAction);
      try {
        this.assertPathActionIdle(active);
      } catch (error) {
        await this.rollbackPromptPath(call);
        throw error;
      }
    }
    let preparedRun: Awaited<ReturnType<ProductStore["prepareSessionRun"]>> | undefined;
    if (runtimeIdentity) {
      const assembledPrompt = active.assembledPrompt;
      const promptEnvironment = active.promptEnvironment;
      if (!assembledPrompt || !promptEnvironment) {
        throw new PiHostError("PROMPT_ASSEMBLY_FAILED", "Runtime has no D Code Prompt Receipt source");
      }
      const attachmentRefs = (images ?? []).map((image) => ({
        type: "image",
        mimeType: image.mimeType,
        digest: `sha256:${createHash("sha256").update(Buffer.from(image.data, "base64")).digest("hex")}`,
        bytes: Buffer.byteLength(image.data, "base64"),
      }));
      preparedRun = await (await this.getProductStore()).prepareSessionRun({
        requestId: `provider-${createHash("sha256")
          .update(`${runtimeIdentity.runtimeId}\0${promptId}`)
          .digest("hex")
          .slice(0, 48)}`,
        taskId: runtimeIdentity.taskId,
        scope: runtimeIdentity.scope,
        sessionId: runtimeIdentity.dcodeSessionId,
        runtimeId: runtimeIdentity.runtimeId,
        ...(runtimeIdentity.agentRunId ? { agentRunId: runtimeIdentity.agentRunId } : {}),
        workspaceId: runtimeIdentity.workspace.workspaceId,
        cwd: runtimeIdentity.workspace.cwd,
        workspaceAccess: runtimeIdentity.workspace.access,
        message,
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
      });
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
        return await active.session.prompt(message, {
          source: "rpc",
          ...(runtimeIdentity ? { expandPromptTemplates: false } : {}),
          ...(images && images.length > 0 ? { images } : {}),
          preflightResult: (success) => { if (success) accept(false); },
        });
      });
      void operation.then(async () => {
        if (call.confirmation) await call.confirmation;
        if (!call.confirmed) {
          await this.rollbackPromptPath(call);
          await active.leaseSync;
          if (active.conflict) {
            throw new PiHostError(active.conflict.code, active.conflict.message, active.conflict.details);
          }
          call.confirmed = true;
          this.emitRuntimeEvent(active, "session.promptCompleted", {
            sessionId: active.session.sessionId,
            promptId,
            outcome: "handled",
          });
        }
        await this.finalizeRun(active, run);
        const durableOutcome = run.state.phase === "completed"
          ? "succeeded"
          : run.state.phase === "aborted"
            ? "aborted"
            : run.state.phase === "failed"
              ? "failed"
              : "unknown";
        await this.finishDurableSessionRun(active, run, durableOutcome).catch((storeError) => {
          this.emitRuntimeEvent(active, "session.persistenceError", errorRecord(storeError));
        });
        accept(true);
      }).catch(async (error) => {
        if (call.confirmation) await call.confirmation;
        await this.rollbackPromptPath(call);
        await this.finalizeRun(active, run, run.outcome ?? "failed");
        const durableOutcome = run.outcome === "aborted" ? "aborted" : "failed";
        await this.finishDurableSessionRun(active, run, durableOutcome).catch((storeError) => {
          this.emitRuntimeEvent(active, "session.persistenceError", errorRecord(storeError));
        });
        if (!responded) reject(error);
        else this.emitRuntimeEvent(active, "session.promptFailed", {
          sessionId: active.session.sessionId,
          promptId,
          ...(call.persistedEntryId ? { persistedEntryId: call.persistedEntryId } : {}),
          ...errorRecord(error),
        });
      });
    });
  }

  private async finishDurableSessionRun(
    active: WritableSession,
    run: ActiveRun,
    outcome: "succeeded" | "failed" | "aborted" | "unknown",
  ): Promise<void> {
    if (!run.sessionRunId || !run.providerAttemptId) return;
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
      resultReference: {
        piRunId: run.id,
        ...(run.state.completionEntryId ? { completionEntryId: run.state.completionEntryId } : {}),
      },
      ...(assistantText ? { assistantText } : {}),
      ...(run.state.completionEntryId ? { assistantSourceEntryId: run.state.completionEntryId } : {}),
    });
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
      if (outcome === "completed") {
        const manager = active.session.sessionManager;
        const leaf = manager.getLeafEntry();
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
          : leaf?.type === "message" && leaf.message.role === "assistant" ? leaf : undefined;
        if (completionEntry?.type === "message" && completionEntry.message.role === "assistant") {
          this.updateRunState(active, run, "completed", {
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
        this.updateRunState(active, run, outcome, {
          completedAt,
          inputPersisted: run.pathEntryId !== undefined,
          retryable: outcome === "failed" && run.pathEntryId === undefined,
        });
      }
      if (active.currentRun === run) active.currentRun = undefined;
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
    const cwd = this.active?.inspection.summary.cwd ?? homedir();
    const settingsManager = SettingsManager.create(cwd, this.agentDir);
    const loader = new DCodeResourceLoader({
      cwd,
      agentDir: this.agentDir,
      sourceSettingsManager: settingsManager,
      extensionFactories: [],
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

  private modelRuntimePromise: Promise<ModelRuntime> | undefined;

  /** agentDir 固定，目录级 ModelRuntime 在 Host 生命周期内复用；cwd 只影响 settings 解析。 */
  private sharedModelRuntime(): Promise<ModelRuntime> {
    this.modelRuntimePromise ??= ModelRuntime.create({
      authPath: join(this.agentDir, "auth.json"),
      modelsPath: join(this.agentDir, "models.json"),
      modelsStorePath: join(this.agentDir, "models-store.json"),
      allowModelNetwork: false,
    });
    return this.modelRuntimePromise;
  }

  private async createModelSettingsRuntime(): Promise<ModelRuntime> {
    return await this.sharedModelRuntime();
  }

  private async ensureDCodeRuntimeModelCatalog(): Promise<void> {
    const store = await this.getProductStore();
    const current = await store.snapshot();
    if (current.modelCatalogEntries.length > 0 && current.runtimeModelSelection) return;

    const runtime = await this.createModelSettingsRuntime();
    const providers: RuntimeModelCatalogProviderInput[] = runtime.getProviders().flatMap((provider) => {
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
    await store.seedRuntimeModelCatalog({ requestId, providers, ...(defaultSelection ? { defaultSelection } : {}) });
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
    if (!this.isActiveSession(active) || active.closing) return;
    const call = this.promptCall.getStore();
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
