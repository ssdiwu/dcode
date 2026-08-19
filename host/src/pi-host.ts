import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
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
  collectEntriesForBranchSummary,
  createAgentSession,
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
import { ExtensionUIBridge } from "./extension-ui.js";
import type { HostMethod } from "./protocol.js";
import { SessionLease, sessionSnapshotDigest } from "./session-lease.js";
import {
  SessionReader,
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
import { SessionSearchIndex } from "./session-search-index.js";
import { structuredToolChange } from "./session-change.js";

// Pi 0.84.1 uses medium when settings.json does not override the default.
// Keep this pinned-version fallback next to the Host compatibility boundary.
const PI_DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";

type Emit = (event: string, data?: unknown) => void;
const HOST_VERSION = "0.0.8";

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

interface ReadOnlySession {
  mode: "readOnly";
  inspection: SessionInspection;
  pinnedLeafId?: string | null;
  modelRuntime: ModelRuntime;
  observedVersion: SessionFileVersion;
  notifiedVersion?: SessionFileVersion;
  refreshTimer?: ReturnType<typeof setInterval>;
  isChecking: boolean;
  lastSyncError?: string;
}

interface WritableSession {
  mode: "writable";
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
  fastMode: DCodeFastController;
  closing: boolean;
  currentRun?: ActiveRun;
  lastRunState?: RunState;
}

type ActiveSession = ReadOnlySession | WritableSession;

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

function planFromEntry(entry: SessionEntry): { matched: boolean; plan: unknown } {
  if (entry.type !== "custom") return { matched: false, plan: null };
  if (entry.customType === "dgoal-work-v1") {
    const goal = (entry.data as { goal?: unknown } | undefined)?.goal;
    return {
      matched: true,
      plan: typeof goal === "object" && goal !== null && (goal as { status?: unknown }).status === "active" ? goal : null,
    };
  }
  if (entry.customType === "dgoal-plan-v2") {
    return { matched: true, plan: (entry.data as { goal?: unknown } | undefined)?.goal ?? null };
  }
  return { matched: false, plan: null };
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
  readonly trashDirectory: string;
  private active?: ActiveSession;
  private shutdownRequested = false;
  private operationQueue = Promise.resolve();
  private writePoison?: { sessionId: string; reason: string };
  private searchShutdown?: Promise<void>;
  private readonly leaseQuietWindowMs: number;
  private readonly conflictPollMs: number;
  private readonly promptCall = new AsyncLocalStorage<PromptCallContext | undefined>();
  private readonly modelAuth: ModelAuthBridge;

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

  async handle(method: HostMethod, params: Record<string, unknown>): Promise<unknown> {
    if (method === "extension.respond") {
      return await this.handleExtensionResponse(params);
    }
    if (method === "modelAuth.respond") {
      return this.handleModelAuthResponse(params);
    }
    if (method === "modelAuth.cancel") {
      return this.handleModelAuthCancel(params);
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
    const operation = this.operationQueue.then(() => this.handleSerial(method, params));
    this.operationQueue = operation.then(() => undefined, () => undefined);
    return await operation;
  }

  async close(): Promise<void> {
    this.modelAuth.close();
    const searchClose = this.searchShutdown ?? this.searchIndex.close();
    this.searchShutdown = searchClose;
    try {
      await this.operationQueue;
      await this.closeActive();
    } finally {
      await searchClose;
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
            fastMode: true,
            sessionExternalSync: true,
            dcodeSessionOrigin: true,
            sessionSearch: true,
            sessionPaths: true,
            sessionCopy: true,
            sessionTrash: true,
            sessionVisibilityExclusions: true,
            sessionChangeLedger: true,
            sessionRename: true,
            sessionRunCorrelation: true,
            sessionRunState: true,
            preSessionModelSelection: true,
            modelSettings: true,
            sessionSteer: true,
            modelAuthentication: true,
          },
        };
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
      case "session.trash":
        return await this.trashSession(params.sessionId as string);
      case "session.open":
        return await this.openSession(
          params.sessionId as string,
          params.mode === "writable" ? "writable" : "readOnly",
          params.writeIntent === true,
          typeof params.expectedEntryId === "string" ? params.expectedEntryId : undefined,
          typeof params.expectedEntryDigest === "string" ? params.expectedEntryDigest : undefined,
          params.preserveActive === true,
          leafIdForPathId(params.pathId),
        );
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
        );
      case "session.steer":
        return await this.steer(
          params.message as string,
          params.steerId as string,
          params.expectedRunId as string,
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
      case "session.getCommands":
        return this.getCommands();
      case "session.getModels":
        return await this.getModels(typeof params.cwd === "string" ? params.cwd : undefined);
      case "modelSettings.get":
        return await this.getModelSettings(params.cwd as string, false);
      case "modelSettings.refresh":
        return await this.getModelSettings(params.cwd as string, true);
      case "modelSettings.setEnabledModels":
        return await this.setGlobalEnabledModels(
          params.cwd as string,
          params.enabledModels as string[],
        );
      case "modelSettings.setDefaultModel":
        return await this.setGlobalDefaultModel(
          params.cwd as string,
          params.provider as string,
          params.modelId as string,
        );
      case "modelAuth.start":
        return await this.startModelAuth(
          params.cwd as string,
          params.flowId as string,
          params.provider as string,
          params.authType as AuthType,
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
      if (current?.mode === "writable" && current.inspection.summary.id === sessionId) {
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

  private async trashSession(sessionId: string): Promise<unknown> {
    this.assertWriteHealthy();
    const summary = await this.assertTrashEligible(sessionId);
    const summaryPath = summary.path;
    const current = this.active;
    let restoreObservation: ReadOnlySession | undefined;
    if (current?.inspection.summary.id === sessionId) {
      if (current.mode === "writable") {
        throw new PiHostError(
          "SESSION_BUSY",
          "Close the writable session before moving it to the Trash",
          { sessionId },
        );
      }
      restoreObservation = current;
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
      if (restoreObservation && movedPath === summaryPath) {
        this.installReadOnlyObservation(
          restoreObservation.inspection,
          restoreObservation.observedVersion,
          restoreObservation.modelRuntime,
          restoreObservation.pinnedLeafId,
        );
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

  private installReadOnlyObservation(
    inspection: SessionInspection,
    version: SessionFileVersion,
    modelRuntime: ModelRuntime,
    pinnedLeafId?: string | null,
  ): Record<string, unknown> {
    const active: ReadOnlySession = {
      mode: "readOnly",
      inspection,
      pinnedLeafId,
      modelRuntime,
      observedVersion: version,
      isChecking: false,
    };
    this.active = active;
    active.refreshTimer = setInterval(() => { void this.checkReadOnlyChange(active); }, this.conflictPollMs);
    active.refreshTimer.unref?.();
    this.options.emit("session.opened", {
      mode: active.mode,
      sessionId: inspection.summary.id,
      path: inspection.summary.path,
    });
    return { mode: active.mode, snapshot: inspection, state: this.getState() };
  }

  private async refreshCurrentForSearch(
    active: ActiveSession,
    expectedEntryId?: string,
    expectedEntryDigest?: string,
  ): Promise<Record<string, unknown>> {
    if (active.mode === "writable") await this.assertLeaseStable(active);
    const refreshed = await this.inspectStablePath(
      active.inspection.summary.path,
      active.inspection.summary.id,
    );
    this.assertSameSessionIdentity(active.inspection.header, refreshed.inspection.header);
    this.assertExpectedEntry(refreshed.inspection, expectedEntryId, expectedEntryDigest);
    if (active.mode === "writable") {
      await this.assertLeaseStable(active);
      if (refreshed.inspection.leafId === null) active.session.sessionManager.resetLeaf();
      else active.session.sessionManager.branch(refreshed.inspection.leafId);
      active.session.agent.state.messages = active.session.sessionManager.buildSessionContext().messages;
      active.inspection = refreshed.inspection;
      active.activePlan = refreshed.inspection.activePlan;
    } else {
      active.inspection = refreshed.inspection;
      active.pinnedLeafId = undefined;
      active.observedVersion = refreshed.version;
      active.notifiedVersion = undefined;
      active.lastSyncError = undefined;
    }
    return { mode: active.mode, snapshot: refreshed.inspection, state: this.getState() };
  }

  private async openReadOnlySession(
    sessionId: string,
    expectedEntryId?: string,
    expectedEntryDigest?: string,
    preserveActive = false,
    selectedLeafId?: string | null,
    knownPath?: string,
  ): Promise<Record<string, unknown>> {
    const current = this.active;
    if (preserveActive && current?.inspection.summary.id === sessionId) {
      return await this.refreshCurrentForSearch(current, expectedEntryId, expectedEntryDigest);
    }

    const preparedTarget = knownPath
      ? await this.inspectStablePath(knownPath, sessionId, selectedLeafId)
      : await this.inspectStableObservation(sessionId, selectedLeafId);
    this.assertExpectedEntry(preparedTarget.inspection, expectedEntryId, expectedEntryDigest);
    const targetRuntime = await ModelRuntime.create({
      authPath: join(this.agentDir, "auth.json"),
      modelsPath: join(this.agentDir, "models.json"),
    });

    let fallback: {
      inspection: SessionInspection;
      version: SessionFileVersion;
      modelRuntime: ModelRuntime;
      pinnedLeafId?: string | null;
    } | undefined;
    if (current) {
      const stableCurrent = await this.inspectStablePath(
        current.inspection.summary.path,
        current.inspection.summary.id,
        current.mode === "readOnly" ? current.pinnedLeafId : undefined,
      );
      this.assertSameSessionIdentity(current.inspection.header, stableCurrent.inspection.header);
      fallback = {
        inspection: stableCurrent.inspection,
        version: stableCurrent.version,
        modelRuntime: current.mode === "readOnly" ? current.modelRuntime : targetRuntime,
        pinnedLeafId: current.mode === "readOnly" ? current.pinnedLeafId : undefined,
      };
    }

    await this.closeActive();
    try {
      const finalTarget = await this.inspectStablePath(
        preparedTarget.inspection.summary.path,
        sessionId,
        selectedLeafId,
      );
      this.assertSameSessionIdentity(preparedTarget.inspection.header, finalTarget.inspection.header);
      this.assertExpectedEntry(finalTarget.inspection, expectedEntryId, expectedEntryDigest);
      return this.installReadOnlyObservation(
        finalTarget.inspection,
        finalTarget.version,
        targetRuntime,
        selectedLeafId,
      );
    } catch (error) {
      if (fallback) {
        let restored = fallback;
        try {
          const refreshedFallback = await this.inspectStablePath(
            fallback.inspection.summary.path,
            fallback.inspection.summary.id,
            fallback.pinnedLeafId,
          );
          this.assertSameSessionIdentity(fallback.inspection.header, refreshedFallback.inspection.header);
          restored = {
            inspection: refreshedFallback.inspection,
            version: refreshedFallback.version,
            modelRuntime: fallback.modelRuntime,
            pinnedLeafId: fallback.pinnedLeafId,
          };
        } catch (restoreError) {
          this.options.emit("session.syncError", {
            sessionId: fallback.inspection.summary.id,
            ...errorRecord(restoreError),
          });
        }
        this.installReadOnlyObservation(
          restored.inspection,
          restored.version,
          restored.modelRuntime,
          restored.pinnedLeafId,
        );
      }
      throw error;
    }
  }

  private async openSession(
    sessionId: string,
    mode: "readOnly" | "writable",
    writeIntent = false,
    expectedEntryId?: string,
    expectedEntryDigest?: string,
    preserveActive = false,
    selectedLeafId?: string | null,
  ): Promise<unknown> {
    if (mode === "readOnly") {
      return await this.openReadOnlySession(
        sessionId,
        expectedEntryId,
        expectedEntryDigest,
        preserveActive,
        selectedLeafId,
      );
    }
    await this.closeActive();
    this.assertWriteHealthy();
    const inspection = await this.reader.inspect(sessionId, selectedLeafId);
    if ((inspection.header.version ?? 1) !== CURRENT_SESSION_VERSION) {
      throw new PiHostError(
        "SESSION_MIGRATION_REQUIRED",
        `Session version ${inspection.header.version ?? 1} must be migrated outside writable open`,
      );
    }
    if (!writeIntent) {
      throw new PiHostError(
        "WRITE_INTENT_REQUIRED",
        "Writable open requires an explicit write intent",
        { sessionId },
      );
    }
    const lease = await SessionLease.acquire({
      agentDir: this.leaseAgentDir,
      sessionId,
      sessionPath: inspection.summary.path,
      quietWindowMs: this.leaseQuietWindowMs,
    });

    let session: AgentSession | undefined;
    let ui: ExtensionUIBridge | undefined;
    let unsubscribe: (() => void) | undefined;
    let conflictTimer: ReturnType<typeof setInterval> | undefined;
    try {
      const manager = SessionManager.open(inspection.summary.path);
      if (selectedLeafId !== undefined) {
        if (selectedLeafId === null) manager.resetLeaf();
        else manager.branch(selectedLeafId);
      }
      await lease.assertUnchanged();
      const fastMode = new DCodeFastController();
      const sourceSettingsManager = SettingsManager.create(manager.getCwd(), this.agentDir);
      const resourceLoader = new DCodeResourceLoader({
        cwd: manager.getCwd(),
        agentDir: this.agentDir,
        sourceSettingsManager,
        extensionFactories: [{ name: "dcode-fast", hidden: true, factory: createDCodeFastExtension(fastMode) }],
      });
      await resourceLoader.reload();
      const created = await createAgentSession({
        cwd: manager.getCwd(),
        agentDir: this.agentDir,
        sessionManager: manager,
        settingsManager: sourceSettingsManager,
        resourceLoader,
        sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile: inspection.summary.path },
      });
      session = created.session;
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
        this.options.emit(event, {
          ...details,
          sessionId: active.session.sessionId,
          ...(run ? { runId: run.id } : {}),
        });
      });
      active = {
        mode,
        inspection,
        session,
        lease,
        ui,
        unsubscribe: () => undefined,
        conflictTimer: setInterval(() => undefined, 2 ** 30),
        leaseSync: Promise.resolve(),
        ownedMutationDepth: 0,
        activePlan: inspection.activePlan,
        fastMode,
        closing: false,
      };
      this.installPromptSourceBoundary(active);
      clearInterval(active.conflictTimer);
      this.active = active;
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
      active.conflictTimer = setInterval(() => { void this.checkConflict(active); }, this.conflictPollMs);
      active.conflictTimer.unref?.();
      this.options.emit("session.opened", { mode, sessionId, path: synchronizedInspection.summary.path });
      return {
        mode,
        snapshot: synchronizedInspection,
        state: this.getState(),
        extensions: {
          loaded: created.extensionsResult.extensions.filter((extension) => !extension.hidden).length,
          errors: created.extensionsResult.errors,
        },
      };
    } catch (error) {
      if (conflictTimer) clearInterval(conflictTimer);
      unsubscribe?.();
      ui?.cancelAll("Session open failed");
      session?.dispose();
      if (this.active?.mode === "writable") {
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
    if (active.mode === "readOnly") {
      if (active.refreshTimer) clearInterval(active.refreshTimer);
      this.options.emit("session.closed", { mode: active.mode, sessionId: active.inspection.summary.id });
      return;
    }
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
      if (safeToRelease) {
        try {
          await active.lease.release();
        } catch (error) {
          safeToRelease = false;
          this.options.emit("session.cleanupError", { step: "lease release", ...errorRecord(error) });
        }
      }
      if (!safeToRelease) this.poisonWrites(active, "The previous runtime did not stop cleanly");
      this.options.emit("session.closed", { mode: active.mode, sessionId: active.inspection.summary.id });
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
  ): Promise<unknown> {
    if (pathAction && message.trim().length === 0) {
      throw new PiHostError("EMPTY_PATH_PROMPT", "路径草稿不能为空");
    }
    const active = this.requireWritable();
    await this.beforeMutation(active);
    this.assertPathActionIdle(active);
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
    const startedAt = new Date().toISOString();
    const run: ActiveRun = {
      id: promptId,
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
    active.currentRun = run;
    this.options.emit("session.runStateChanged", run.state);
    return await new Promise((resolve, reject) => {
      let responded = false;
      const accept = (completed = false) => {
        if (responded) return;
        responded = true;
        resolve({ accepted: true, completed });
      };
      const operation = this.promptCall.run(call, () => active.session.prompt(message, {
          source: "rpc",
          preflightResult: (success) => { if (success) accept(false); },
        }));
      void operation.then(async () => {
        if (call.confirmation) await call.confirmation;
        if (!call.confirmed) {
          await this.rollbackPromptPath(call);
          await active.leaseSync;
          if (active.conflict) {
            throw new PiHostError(active.conflict.code, active.conflict.message, active.conflict.details);
          }
          call.confirmed = true;
          this.options.emit("session.promptCompleted", {
            sessionId: active.session.sessionId,
            promptId,
            outcome: "handled",
          });
        }
        await this.finalizeRun(active, run);
        accept(true);
      }).catch(async (error) => {
        if (call.confirmation) await call.confirmation;
        await this.rollbackPromptPath(call);
        await this.finalizeRun(active, run, run.outcome ?? "failed");
        if (!responded) reject(error);
        else this.options.emit("session.promptFailed", {
          sessionId: active.session.sessionId,
          promptId,
          ...(call.persistedEntryId ? { persistedEntryId: call.persistedEntryId } : {}),
          ...errorRecord(error),
        });
      });
    });
  }

  private async steer(message: string, steerId: string, expectedRunId: string): Promise<unknown> {
    const active = this.requireWritable();
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
      await active.session.steer(message);
    } catch {
      throw new PiHostError("STEER_REJECTED", "Pi did not accept the steering message");
    }
    return { accepted: true, steerId, runId: run.id };
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
    this.options.emit("session.runStateChanged", run.state);
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

  private getState(): unknown {
    const active = this.requireActive();
    if (active.mode === "readOnly") {
      const model = active.inspection.context.model
        ? active.modelRuntime.getModel(
            active.inspection.context.model.provider,
            active.inspection.context.model.modelId,
          )
        : undefined;
      const fastMode = createFastSnapshot(
        restoreFastMode(active.inspection.entries),
        active.inspection.context.model
          ? {
              provider: active.inspection.context.model.provider,
              id: active.inspection.context.model.modelId,
            }
          : undefined,
      );
      return {
        mode: active.mode,
        sessionId: active.inspection.summary.id,
        sessionFile: active.inspection.summary.path,
        cwd: active.inspection.summary.cwd,
        model: active.inspection.context.model
          ? {
              provider: active.inspection.context.model.provider,
              id: active.inspection.context.model.modelId,
            }
          : null,
        thinkingLevel: active.inspection.context.thinkingLevel,
        activePlan: active.inspection.activePlan,
        isStreaming: false,
        runState: null,
        writable: false,
        contextUsage: model && model.contextWindow > 0
          ? { tokens: null, contextWindow: model.contextWindow, percent: null }
          : null,
        fastMode,
      };
    }
    return {
      mode: active.mode,
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

  private getCommands(): unknown {
    const active = this.requireWritable();
    const commands = [];
    for (const command of active.session.extensionRunner.getRegisteredCommands()) {
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
      runtime = active.mode === "writable"
        ? active.session.modelRuntime
        : active.modelRuntime;
    } else {
      try {
        canonicalCwd = await realpath(cwd);
        if (!(await stat(canonicalCwd)).isDirectory()) throw new Error("not a directory");
      } catch (error) {
        throw new PiHostError("CWD_NOT_ACCESSIBLE", `Working directory is not accessible: ${cwd}`, {
          cause: error instanceof Error ? error.message : String(error),
        });
      }

      runtime = await ModelRuntime.create({
        authPath: join(this.agentDir, "auth.json"),
        modelsPath: join(this.agentDir, "models.json"),
        allowModelNetwork: false,
      });
    }

    if (cwd === undefined) {
      const active = this.requireActive();
      const canRefreshRuntime = active.mode === "readOnly"
        || (!active.session.isStreaming
          && !active.session.isCompacting
          && active.session.pendingMessageCount === 0);
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

  private async createModelSettingsRuntime(): Promise<ModelRuntime> {
    return await ModelRuntime.create({
      authPath: join(this.agentDir, "auth.json"),
      modelsPath: join(this.agentDir, "models.json"),
      modelsStorePath: join(this.agentDir, "models-store.json"),
      allowModelNetwork: false,
    });
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
    if (active.mode === "writable") {
      return { levels: active.session.getAvailableThinkingLevels() };
    }
    const modelRef = active.inspection.context.model;
    const model = modelRef
      ? active.modelRuntime.getModel(modelRef.provider, modelRef.modelId)
      : undefined;
    return { levels: model ? getSupportedThinkingLevels(model) : ["off"] };
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
    if (this.active !== active || active.closing) return;
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
      if (change) this.options.emit("session.changeRecorded", change);
    }
    this.options.emit("session.event", toWireEvent(active, event));
    if (event.type === "entry_appended") {
      const plan = planFromEntry(event.entry);
      if (plan.matched) {
        active.activePlan = plan.plan;
        this.options.emit("plan.changed", { entryId: event.entry.id, plan: plan.plan });
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
    if (this.active !== active || active.closing) return;
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
        this.options.emit("session.promptCompleted", {
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
    if (this.active !== active || active.conflict || active.ownedMutationDepth > 0) return;
    try {
      await this.assertLeaseStable(active);
    } catch (error) {
      if (this.active !== active || active.conflict) return;
      this.markConflict(active, error);
    }
  }

  private markConflict(active: WritableSession, error: unknown): void {
    if (this.active !== active || active.closing || active.conflict) return;
    active.conflict = errorRecord(error);
    clearInterval(active.conflictTimer);
    const abort = active.session.abort();
    void abort.catch(() => undefined);
    active.conflictAbort = abort;
    this.options.emit("session.conflict", {
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
    if (active.mode === "writable") {
      const inspection = await this.reader.inspectPath(
        active.inspection.summary.path,
        active.inspection.summary.id,
        active.session.sessionManager.getLeafId(),
      );
      this.assertSameSessionIdentity(active.inspection.header, inspection.header);
      return inspection;
    }
    const before = await readSessionFileVersion(active.inspection.summary.path);
    const inspection = await this.reader.inspectPath(
      active.inspection.summary.path,
      active.inspection.summary.id,
      active.mode === "readOnly" ? active.pinnedLeafId : undefined,
    );
    const after = await readSessionFileVersion(active.inspection.summary.path);
    if (!sameSessionFileVersion(before, after)) {
      throw new PiHostError(
        "SESSION_CHANGED_DURING_REFRESH",
        "The session changed while D Code was refreshing it",
        { sessionId: active.inspection.summary.id },
      );
    }
    this.assertSameSessionIdentity(active.inspection.header, inspection.header);
    active.inspection = inspection;
    active.observedVersion = after;
    active.notifiedVersion = undefined;
    active.lastSyncError = undefined;
    return inspection;
  }

  private async checkReadOnlyChange(active: ReadOnlySession): Promise<void> {
    if (this.active !== active || active.isChecking) return;
    active.isChecking = true;
    try {
      const baseline = active.observedVersion;
      const observed = await readSessionFileVersion(active.inspection.summary.path);
      if (this.active !== active || !sameSessionFileVersion(active.observedVersion, baseline)) return;
      if (!sameSessionFileVersion(active.observedVersion, observed)) {
        this.searchIndex.invalidate();
        active.lastSyncError = undefined;
        if (active.notifiedVersion && sameSessionFileVersion(active.notifiedVersion, observed)) return;
        active.notifiedVersion = observed;
        this.options.emit("session.changed", {
          sessionId: active.inspection.summary.id,
          path: active.inspection.summary.path,
        });
      }
    } catch (error) {
      if (this.active !== active) return;
      const record = errorRecord(error);
      const signature = `${record.code}:${record.message}`;
      if (active.lastSyncError !== signature) {
        active.lastSyncError = signature;
        this.options.emit("session.syncError", {
          sessionId: active.inspection.summary.id,
          ...record,
        });
      }
    } finally {
      active.isChecking = false;
    }
  }

  private requireActive(): ActiveSession {
    if (!this.active) throw new PiHostError("SESSION_NOT_OPEN", "No session is open");
    return this.active;
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
    if (active.mode !== "writable") throw new PiHostError("SESSION_READ_ONLY", "The open session is read-only");
    if (active.conflict) throw new PiHostError(active.conflict.code, active.conflict.message, active.conflict.details);
    return active;
  }

  private assertWriteHealthy(): void {
    if (!this.writePoison) return;
    throw new PiHostError(
      "HOST_RESTART_REQUIRED",
      "D Code must restart its Host before another write",
      this.writePoison,
    );
  }

  private poisonWrites(active: WritableSession, reason: string): void {
    this.poisonWritesForSession(active.inspection.summary.id, reason);
  }

  private poisonWritesForSession(sessionId: string, reason: string): void {
    if (this.writePoison) return;
    this.writePoison = { sessionId, reason };
    this.options.emit("host.restartRequired", this.writePoison);
  }
}
