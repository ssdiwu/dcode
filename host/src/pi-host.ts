import { AsyncLocalStorage } from "node:async_hooks";
import { realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentEvent, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import {
  CURRENT_SESSION_VERSION,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  VERSION as PI_VERSION,
  createAgentSession,
  getAgentDir,
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
import { extractSearchableMessage, searchEntryDigest } from "./search-entry-digest.js";
import { SessionSearchIndex } from "./session-search-index.js";

type Emit = (event: string, data?: unknown) => void;
const HOST_VERSION = "0.0.2";

export interface PiHostOptions {
  agentDir?: string;
  sessionsDirectory?: string;
  leaseAgentDir?: string;
  leaseQuietWindowMs?: number;
  conflictPollMs?: number;
  searchCacheDirectory?: string;
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
}

type ActiveSession = ReadOnlySession | WritableSession;

interface PromptCallContext {
  active: WritableSession;
  promptId: string;
  confirmed: boolean;
  confirmation?: Promise<void>;
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

function toWireEvent(event: AgentSessionEvent): unknown {
  if (event.type !== "message_update") return event;
  const assistantMessageEvent = event.assistantMessageEvent;
  if (!("partial" in assistantMessageEvent)) return event;
  const { partial: _partial, ...delta } = assistantMessageEvent;
  return { type: "message_update", assistantMessageEvent: delta };
}

function safeModel(model: unknown): unknown {
  if (typeof model !== "object" || model === null) return null;
  const source = model as Record<string, unknown>;
  const keys = ["provider", "id", "name", "api", "reasoning", "input", "contextWindow", "maxTokens", "cost"];
  return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
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
  private active?: ActiveSession;
  private shutdownRequested = false;
  private operationQueue = Promise.resolve();
  private writePoison?: { sessionId: string; reason: string };
  private searchShutdown?: Promise<void>;
  private readonly leaseQuietWindowMs: number;
  private readonly conflictPollMs: number;
  private readonly promptCall = new AsyncLocalStorage<PromptCallContext | undefined>();

  constructor(private readonly options: PiHostOptions) {
    this.agentDir = options.agentDir ?? getAgentDir();
    this.sessionsDirectory = options.sessionsDirectory ?? join(this.agentDir, "sessions");
    this.leaseAgentDir = options.leaseAgentDir ?? this.agentDir;
    this.leaseQuietWindowMs = options.leaseQuietWindowMs ?? 500;
    this.conflictPollMs = options.conflictPollMs ?? 1_000;
    this.reader = new SessionReader(this.sessionsDirectory);
    this.searchIndex = new SessionSearchIndex({
      sessionsDirectory: this.sessionsDirectory,
      ...(options.searchCacheDirectory ? { cacheDirectory: options.searchCacheDirectory } : {}),
      emit: options.emit,
    });
  }

  get wantsShutdown(): boolean { return this.shutdownRequested; }

  async handle(method: HostMethod, params: Record<string, unknown>): Promise<unknown> {
    if (method === "extension.respond") {
      return await this.handleExtensionResponse(params);
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
        refresh: params.refresh === true,
        ...(params.probe === true ? { probe: true } : {}),
      });
    }
    const operation = this.operationQueue.then(() => this.handleSerial(method, params));
    this.operationQueue = operation.then(() => undefined, () => undefined);
    return await operation;
  }

  async close(): Promise<void> {
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
          }),
        };
      case "session.inspect":
        return await this.reader.inspect(params.sessionId as string);
      case "session.refresh":
        return await this.refreshActiveSession();
      case "content.renderMermaid":
        return this.renderMermaid(params.source as string);
      case "session.create":
        return await this.createSession(params.cwd as string);
      case "session.open":
        return await this.openSession(
          params.sessionId as string,
          params.mode === "writable" ? "writable" : "readOnly",
          params.writeIntent === true,
          typeof params.expectedEntryId === "string" ? params.expectedEntryId : undefined,
          typeof params.expectedEntryDigest === "string" ? params.expectedEntryDigest : undefined,
          params.preserveActive === true,
        );
      case "session.close":
        await this.closeActive();
        return { closed: true };
      case "session.prompt":
        return await this.prompt(params.message as string, params.promptId as string);
      case "session.abort": {
        const active = this.requireWritable();
        await active.session.abort();
        return { aborted: true };
      }
      case "session.getState":
        return this.getState();
      case "session.getCommands":
        return this.getCommands();
      case "session.getModels":
        return this.getModels();
      case "session.getThinkingLevels":
        return this.getThinkingLevels();
      case "session.setModel":
        return await this.setModel(params.provider as string, params.modelId as string);
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
    await writeFile(sessionPath, `${initialDocument}\n`, { flag: "wx", mode: 0o600 });
    this.searchIndex.invalidate();
    let summary: SessionSummary = {
      path: sessionPath,
      id: draft.getSessionId(),
      cwd: canonicalCwd,
      ...(header.parentSession ? { parentSessionPath: header.parentSession } : {}),
      created: header.timestamp,
      modified: header.timestamp,
      messageCount: 0,
      firstMessage: "",
    };
    try {
      summary = await this.reader.resolve(draft.getSessionId());
    } catch {
      // Publishing the complete Header + origin document is the creation commit point.
      // Activation below owns every post-commit failure and must still acknowledge it.
    }
    try {
      const open = await this.openSession(draft.getSessionId(), "writable", true) as Record<string, unknown>;
      return {
        created: true,
        session: (open.snapshot as SessionInspection | undefined)?.summary ?? summary,
        activation: { status: "writable", open },
      };
    } catch (activationError) {
      const activation = errorRecord(activationError);
      try {
        const open = await this.openSession(draft.getSessionId(), "readOnly") as Record<string, unknown>;
        return {
          created: true,
          session: (open.snapshot as SessionInspection | undefined)?.summary ?? summary,
          activation: { status: "observing", open, error: activation },
        };
      } catch (observationError) {
        return {
          created: true,
          session: summary,
          activation: {
            status: "unavailable",
            error: activation,
            observationError: errorRecord(observationError),
          },
        };
      }
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
  ): Record<string, unknown> {
    const active: ReadOnlySession = {
      mode: "readOnly",
      inspection,
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
      active.inspection = refreshed.inspection;
      active.activePlan = refreshed.inspection.activePlan;
    } else {
      active.inspection = refreshed.inspection;
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
  ): Promise<Record<string, unknown>> {
    const current = this.active;
    if (preserveActive && current?.inspection.summary.id === sessionId) {
      return await this.refreshCurrentForSearch(current, expectedEntryId, expectedEntryDigest);
    }

    const preparedTarget = await this.inspectStableObservation(sessionId);
    this.assertExpectedEntry(preparedTarget.inspection, expectedEntryId, expectedEntryDigest);
    const targetRuntime = await ModelRuntime.create({
      authPath: join(this.agentDir, "auth.json"),
      modelsPath: join(this.agentDir, "models.json"),
    });

    let fallback: {
      inspection: SessionInspection;
      version: SessionFileVersion;
      modelRuntime: ModelRuntime;
    } | undefined;
    if (current) {
      const stableCurrent = await this.inspectStablePath(
        current.inspection.summary.path,
        current.inspection.summary.id,
      );
      this.assertSameSessionIdentity(current.inspection.header, stableCurrent.inspection.header);
      fallback = {
        inspection: stableCurrent.inspection,
        version: stableCurrent.version,
        modelRuntime: current.mode === "readOnly" ? current.modelRuntime : targetRuntime,
      };
    }

    await this.closeActive();
    try {
      const finalTarget = await this.inspectStablePath(
        preparedTarget.inspection.summary.path,
        sessionId,
      );
      this.assertSameSessionIdentity(preparedTarget.inspection.header, finalTarget.inspection.header);
      this.assertExpectedEntry(finalTarget.inspection, expectedEntryId, expectedEntryDigest);
      return this.installReadOnlyObservation(finalTarget.inspection, finalTarget.version, targetRuntime);
    } catch (error) {
      if (fallback) {
        let restored = fallback;
        try {
          const refreshedFallback = await this.inspectStablePath(
            fallback.inspection.summary.path,
            fallback.inspection.summary.id,
          );
          this.assertSameSessionIdentity(fallback.inspection.header, refreshedFallback.inspection.header);
          restored = {
            inspection: refreshedFallback.inspection,
            version: refreshedFallback.version,
            modelRuntime: fallback.modelRuntime,
          };
        } catch (restoreError) {
          this.options.emit("session.syncError", {
            sessionId: fallback.inspection.summary.id,
            ...errorRecord(restoreError),
          });
        }
        this.installReadOnlyObservation(restored.inspection, restored.version, restored.modelRuntime);
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
  ): Promise<unknown> {
    if (mode === "readOnly") {
      return await this.openReadOnlySession(sessionId, expectedEntryId, expectedEntryDigest, preserveActive);
    }
    await this.closeActive();
    this.assertWriteHealthy();
    const inspection = await this.reader.inspect(sessionId);
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
      ui = new ExtensionUIBridge((event, data) => this.options.emit(event, data));
      const active: WritableSession = {
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

  private async prompt(message: string, promptId: string): Promise<unknown> {
    const active = this.requireWritable();
    await this.beforeMutation(active);
    const call: PromptCallContext = { active, promptId, confirmed: false };
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
        accept(true);
      }).catch((error) => {
        if (!responded) reject(error);
        else this.options.emit("session.promptFailed", {
          sessionId: active.session.sessionId,
          promptId,
          ...errorRecord(error),
        });
      });
    });
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

  private getModels(): unknown {
    const active = this.requireActive();
    const models = active.mode === "writable"
      ? active.session.modelRuntime.getAvailableSnapshot()
      : active.modelRuntime.getAvailableSnapshot();
    return { models: models.map((model) => safeModel(model)) };
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

  private async setFastMode(enabled: boolean): Promise<unknown> {
    const active = this.requireWritable();
    await this.beforeMutation(active);
    return await this.withOwnedMutation(active, async () => active.fastMode.setEnabled(enabled));
  }

  private onSessionEvent(active: WritableSession, event: AgentSessionEvent): void {
    if (this.active !== active || active.closing) return;
    this.options.emit("session.event", toWireEvent(event));
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
      call.confirmation = this.synchronizeOwnedSnapshot(active).then(() => {
        if (active.conflict || call.confirmed) return;
        call.confirmed = true;
        this.options.emit("session.promptCompleted", {
          sessionId: active.session.sessionId,
          promptId: call.promptId,
          outcome: "persisted",
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

  private async inspectStableObservation(sessionId: string): Promise<{
    inspection: SessionInspection;
    version: SessionFileVersion;
  }> {
    const summary = await this.reader.resolve(sessionId);
    return await this.inspectStablePath(summary.path, sessionId);
  }

  private async inspectStablePath(path: string, sessionId: string): Promise<{
    inspection: SessionInspection;
    version: SessionFileVersion;
  }> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const before = await readSessionFileVersion(path);
      try {
        const inspection = await this.reader.inspectPath(path, sessionId);
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
      );
      this.assertSameSessionIdentity(active.inspection.header, inspection.header);
      return inspection;
    }
    const before = await readSessionFileVersion(active.inspection.summary.path);
    const inspection = await this.reader.inspectPath(
      active.inspection.summary.path,
      active.inspection.summary.id,
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
