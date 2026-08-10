import { realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  CURRENT_SESSION_VERSION,
  SessionManager,
  VERSION as PI_VERSION,
  createAgentSession,
  getAgentDir,
  type AgentSession,
  type AgentSessionEvent,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { diagramKind, render } from "grok-mermaid";
import { ExtensionUIBridge } from "./extension-ui.js";
import type { HostMethod } from "./protocol.js";
import { SessionLease, sessionSnapshotDigest } from "./session-lease.js";
import { SessionReader, type SessionInspection, type SessionSummary } from "./session-reader.js";

type Emit = (event: string, data?: unknown) => void;

export interface PiHostOptions {
  agentDir?: string;
  sessionsDirectory?: string;
  leaseAgentDir?: string;
  leaseQuietWindowMs?: number;
  conflictPollMs?: number;
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
  leaseSync: Promise<void>;
  ownedMutationDepth: number;
  activePlan: unknown;
}

type ActiveSession = ReadOnlySession | WritableSession;

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
  private active?: ActiveSession;
  private shutdownRequested = false;
  private operationQueue = Promise.resolve();
  private readonly leaseQuietWindowMs: number;
  private readonly conflictPollMs: number;

  constructor(private readonly options: PiHostOptions) {
    this.agentDir = options.agentDir ?? getAgentDir();
    this.sessionsDirectory = options.sessionsDirectory ?? join(this.agentDir, "sessions");
    this.leaseAgentDir = options.leaseAgentDir ?? this.agentDir;
    this.leaseQuietWindowMs = options.leaseQuietWindowMs ?? 500;
    this.conflictPollMs = options.conflictPollMs ?? 1_000;
    this.reader = new SessionReader(this.sessionsDirectory);
  }

  get wantsShutdown(): boolean { return this.shutdownRequested; }

  async handle(method: HostMethod, params: Record<string, unknown>): Promise<unknown> {
    if (method === "extension.respond") {
      return await this.handleExtensionResponse(params);
    }
    const operation = this.operationQueue.then(() => this.handleSerial(method, params));
    this.operationQueue = operation.then(() => undefined, () => undefined);
    return await operation;
  }

  async close(): Promise<void> {
    await this.operationQueue;
    await this.closeActive();
  }

  private async handleSerial(method: HostMethod, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "host.hello":
        return {
          protocolVersion: 1,
          piVersion: PI_VERSION,
          nodeVersion: process.versions.node,
          capabilities: {
            sessionLease: true,
            directTakeover: true,
            extensionDialogs: true,
            extensionCustomHeadless: false,
            extensionWidgets: false,
            structuredPlan: true,
            mermaidUnicode: true,
          },
        };
      case "session.list":
        return {
          sessions: await this.reader.list({
            ...(typeof params.query === "string" ? { query: params.query } : {}),
            ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
          }),
        };
      case "session.inspect":
        return await this.reader.inspect(params.sessionId as string);
      case "content.renderMermaid":
        return this.renderMermaid(params.source as string);
      case "session.create":
        return await this.createSession(params.cwd as string);
      case "session.open":
        return await this.openSession(
          params.sessionId as string,
          params.mode === "writable" ? "writable" : "readOnly",
          params.exclusiveUseConfirmed === true,
        );
      case "session.close":
        await this.closeActive();
        return { closed: true };
      case "session.prompt":
        return await this.prompt(params.message as string, params.streamingBehavior as "steer" | "followUp" | undefined);
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
        return { levels: this.requireWritable().session.getAvailableThinkingLevels() };
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
      case "host.shutdown":
        this.shutdownRequested = true;
        await this.closeActive();
        return { shuttingDown: true };
      case "extension.respond":
        throw new PiHostError("INTERNAL_ERROR", "Extension method was not routed correctly");
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
    await this.closeActive();
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
    await writeFile(sessionPath, `${JSON.stringify(draft.getHeader())}\n`, { flag: "wx", mode: 0o600 });
    const opened = await this.openSession(draft.getSessionId(), "writable", true) as Record<string, unknown>;
    return { created: true, ...opened };
  }

  private async openSession(
    sessionId: string,
    mode: "readOnly" | "writable",
    exclusiveUseConfirmed = false,
  ): Promise<unknown> {
    await this.closeActive();
    const inspection = await this.reader.inspect(sessionId);
    if (mode === "readOnly") {
      this.active = { mode, inspection };
      this.options.emit("session.opened", { mode, sessionId, path: inspection.summary.path });
      return { mode, snapshot: inspection };
    }
    if ((inspection.header.version ?? 1) !== CURRENT_SESSION_VERSION) {
      throw new PiHostError(
        "SESSION_MIGRATION_REQUIRED",
        `Session version ${inspection.header.version ?? 1} must be migrated outside writable open`,
      );
    }
    if (!exclusiveUseConfirmed) {
      throw new PiHostError(
        "EXCLUSIVE_USE_CONFIRMATION_REQUIRED",
        "Confirm that no other client is using this session before writable open",
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
      const created = await createAgentSession({
        cwd: manager.getCwd(),
        agentDir: this.agentDir,
        sessionManager: manager,
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
      };
      clearInterval(active.conflictTimer);
      this.active = active;
      unsubscribe = session.subscribe((event) => this.onSessionEvent(active, event));
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
      active.conflictTimer = setInterval(() => { void this.checkConflict(active); }, this.conflictPollMs);
      active.conflictTimer.unref?.();
      this.options.emit("session.opened", { mode, sessionId, path: inspection.summary.path });
      return {
        mode,
        snapshot: inspection,
        state: this.getState(),
        extensions: {
          loaded: created.extensionsResult.extensions.length,
          errors: created.extensionsResult.errors,
        },
      };
    } catch (error) {
      if (conflictTimer) clearInterval(conflictTimer);
      unsubscribe?.();
      ui?.cancelAll("Session open failed");
      session?.dispose();
      try { await lease.release(); } catch { /* preserve original failure */ }
      this.active = undefined;
      throw error;
    }
  }

  private async closeActive(): Promise<void> {
    const active = this.active;
    if (!active) return;
    this.active = undefined;
    if (active.mode === "readOnly") {
      this.options.emit("session.closed", { mode: active.mode, sessionId: active.inspection.summary.id });
      return;
    }
    clearInterval(active.conflictTimer);
    active.ui.cancelAll("Session closing");
    try {
      await this.cleanupStep(active, "abort", active.session.abort(), 5_000);
      const shutdownSettled = await this.cleanupStep(
        active,
        "extension shutdown",
        active.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }),
        5_000,
      );
      const leaseSettled = await this.cleanupStep(active, "lease synchronization", active.leaseSync, 2_000);
      if (shutdownSettled && leaseSettled) {
        await active.lease.acceptOwnedChange(agentSessionSnapshotDigest(active.session));
      }
    } finally {
      active.unsubscribe();
      active.session.dispose();
      await active.lease.release();
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
    this.shutdownRequested = true;
    this.options.emit("session.cleanupTimeout", { step: name, timeoutMs, action: "host restart required" });
    return false;
  }

  private async prompt(message: string, streamingBehavior?: "steer" | "followUp"): Promise<unknown> {
    const active = this.requireWritable();
    await this.beforeMutation(active);
    return await new Promise((resolve, reject) => {
      let responded = false;
      const accept = (completed = false) => {
        if (responded) return;
        responded = true;
        resolve({ accepted: true, completed });
      };
      void active.session.prompt(message, {
        ...(streamingBehavior ? { streamingBehavior } : {}),
        source: "rpc",
        preflightResult: (success) => { if (success) accept(false); },
      }).then(() => accept(true), (error) => {
        if (!responded) reject(error);
        else this.options.emit("session.operationError", errorRecord(error));
      });
    });
  }

  private getState(): unknown {
    const active = this.requireActive();
    if (active.mode === "readOnly") {
      return {
        mode: active.mode,
        sessionId: active.inspection.summary.id,
        sessionFile: active.inspection.summary.path,
        cwd: active.inspection.summary.cwd,
        model: active.inspection.context.model,
        thinkingLevel: active.inspection.context.thinkingLevel,
        activePlan: active.inspection.activePlan,
        isStreaming: false,
        writable: false,
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
    const active = this.requireWritable();
    return { models: active.session.modelRuntime.getAvailableSnapshot().map((model) => safeModel(model)) };
  }

  private async setModel(provider: string, modelId: string): Promise<unknown> {
    const active = this.requireWritable();
    await this.beforeMutation(active);
    const model = active.session.modelRuntime.getAvailableSnapshot().find((candidate) => candidate.provider === provider && candidate.id === modelId);
    if (!model) throw new PiHostError("MODEL_NOT_FOUND", `Model not found: ${provider}/${modelId}`);
    await this.withOwnedMutation(active, async () => { await active.session.setModel(model); });
    return { model: safeModel(model) };
  }

  private onSessionEvent(active: WritableSession, event: AgentSessionEvent): void {
    this.options.emit("session.event", toWireEvent(event));
    if (event.type === "entry_appended") {
      const plan = planFromEntry(event.entry);
      if (plan.matched) {
        active.activePlan = plan.plan;
        this.options.emit("plan.changed", { entryId: event.entry.id, plan: plan.plan });
      }
    }
    if (
      event.type === "entry_appended"
      || event.type === "message_end"
      || event.type === "thinking_level_changed"
      || event.type === "session_info_changed"
      || event.type === "agent_settled"
      || (event.type === "compaction_end" && !event.aborted && event.result !== undefined)
    ) void this.synchronizeOwnedSnapshot(active);
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
      .catch((error) => { this.markConflict(active, error); });
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
      this.markConflict(active, error);
      try { await active.session.abort(); } catch { /* conflict already reported */ }
    }
  }

  private markConflict(active: WritableSession, error: unknown): void {
    if (active.conflict) return;
    active.conflict = errorRecord(error);
    clearInterval(active.conflictTimer);
    this.options.emit("session.conflict", active.conflict);
  }

  private requireActive(): ActiveSession {
    if (!this.active) throw new PiHostError("SESSION_NOT_OPEN", "No session is open");
    return this.active;
  }

  private requireWritable(): WritableSession {
    const active = this.requireActive();
    if (active.mode !== "writable") throw new PiHostError("SESSION_READ_ONLY", "The open session is read-only");
    if (active.conflict) throw new PiHostError(active.conflict.code, active.conflict.message, active.conflict.details);
    return active;
  }
}
