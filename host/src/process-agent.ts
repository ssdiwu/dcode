import {sanitizeRuntimeValue} from "./runtime-privacy.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Agent, type AgentOptions, type AgentEvent, type AgentMessage, type AgentState } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { isProcessPacket, processTools, type ProcessLoopEvent, type ProcessPacket } from "./agent-process-protocol.js";

export interface AgentProcessInfo {
  executionId: string;
  pid: number;
  startedAt: string;
  status: "starting" | "ready" | "running" | "idle" | "exited";
  exitReason?: "idle" | "disposed" | "unexpected" | "supervisor_restarted" | "start_failed" | "failed";
}
export interface ProcessAgentOptions extends AgentOptions {
  idleTimeoutMs?: number;
  runAcceptTimeoutMs?:number;
  processEntry?:URL;
  onProcessChanged?: (info: AgentProcessInfo) => void | Promise<void>;
}

/** Public Pi Agent implementation whose loop is owned by one private process.
 * The Host supplies tool execution and Provider IO so existing source receipts,
 * extension hooks and product transactions keep their single writer.
 */
type MutableProcessState = { -readonly [K in keyof AgentState]: AgentState[K] } & { pendingToolCalls: Set<string> };

export class ProcessAgent extends Agent {
  private localState: MutableProcessState;
  override get state(): AgentState { return this.localState; }
  private child?: ChildProcess;
  private opening?: Promise<void>;
  private processInfoValue?: AgentProcessInfo;
  private sequence = 0;
  private processListeners = new Set<(event: AgentEvent, signal: AbortSignal) => void | Promise<void>>();
  private runController?: AbortController;
  private runPromise?: Promise<void>;
  private resolveRun?: () => void;
  private rejectRun?: (error: Error) => void;
  private runId?: number;
  private acceptRun?:()=>void;
  private acceptanceTimer?:ReturnType<typeof setTimeout>;
  private steeringMessages: AgentMessage[] = [];
  private followUpMessages: AgentMessage[] = [];
  private retiring?: Promise<void>;
  private runScope: <R>(fn: () => R) => R = (fn) => fn();
  private idleTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private readonly idleTimeoutMs: number;
  private readonly runAcceptTimeoutMs:number;
  private readonly processEntry:URL;
  private readonly onProcessChanged?: ProcessAgentOptions["onProcessChanged"];

  constructor(options: ProcessAgentOptions) {
    super(options);
    this.localState = { ...super.state, pendingToolCalls: new Set(super.state.pendingToolCalls) };
    this.idleTimeoutMs = options.idleTimeoutMs ?? 120_000;
    this.runAcceptTimeoutMs=options.runAcceptTimeoutMs??15_000;
    this.processEntry=options.processEntry??new URL("./agent-process-entry.js",import.meta.url);
    this.onProcessChanged = options.onProcessChanged;
  }

  get processInfo(): AgentProcessInfo | undefined { return this.processInfoValue ? { ...this.processInfoValue } : undefined; }
  override get signal(): AbortSignal | undefined { return this.runController?.signal; }
  override subscribe(listener: (event: AgentEvent, signal: AbortSignal) => void | Promise<void>): () => void {
    this.processListeners.add(listener);
    return () => this.processListeners.delete(listener);
  }
  override prompt(message: AgentMessage | AgentMessage[]): Promise<void>;
  override prompt(input: string, images?: ImageContent[]): Promise<void>;
  override prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void> {
    return this.execute(false, input, images);
  }
  override continue(): Promise<void> { return this.execute(true); }
  override abort(): void {
    // D Code keeps unsent inputs in its durable queue. Leaving the private Pi
    // queues nonempty would make AgentSession continue immediately after abort.
    this.clearAllQueues();
    this.runController?.abort();
    this.control("abort");
  }
  override steer(message: AgentMessage): void { this.steeringMessages.push(message); this.control("steer", message); }
  override followUp(message: AgentMessage): void { this.followUpMessages.push(message); this.control("followUp", message); }
  override clearSteeringQueue(): void { this.steeringMessages = []; this.control("clearSteering"); }
  override clearFollowUpQueue(): void { this.followUpMessages = []; this.control("clearFollowUp"); }
  override clearAllQueues(): void { this.steeringMessages = []; this.followUpMessages = []; this.control("clearAll"); }
  override hasQueuedMessages(): boolean { return this.steeringMessages.length > 0 || this.followUpMessages.length > 0; }
  override async waitForIdle(): Promise<void> { await this.runPromise?.catch(() => undefined); }
  override reset(): void {
    if (this.runPromise) throw new Error("Cannot reset a running Agent");
    this.localState.messages = [];
    this.localState.pendingToolCalls.clear();
    this.localState.errorMessage = undefined;
    this.localState.streamingMessage = undefined;
    this.clearAllQueues();
  }

  private processPersistence = Promise.resolve();
  private changed(): Promise<void> {
    const info=this.processInfoValue?{...this.processInfoValue}:undefined;
    const update=()=>info?this.onProcessChanged?.(info):undefined;
    this.processPersistence=this.processPersistence.then(update,update);
    void this.processPersistence.catch(()=>undefined);
    return this.processPersistence;
  }
  private send(packet: ProcessPacket): void {
    if (!this.child?.connected) throw new Error("Agent execution process is unavailable");
    this.child.send(packet, (error) => { if (error && this.runPromise) this.rejectRun?.(new Error("Agent process communication failed")); });
  }
  private control(action: Extract<ProcessPacket, { kind: "control" }>["action"], value?: unknown): void {
    const packet: Extract<ProcessPacket, { kind: "control" }> = { kind: "control", action, value };
    if (this.child?.connected && this.runId) this.send(packet);
  }

  private async ensureProcess(): Promise<void> {
    if (this.retiring) await this.retiring;
    if (this.disposed) throw new Error("Agent has been disposed");
    if (this.child?.connected && this.processInfoValue?.status !== "exited") return;
    if (this.opening) return this.opening;
    this.opening = new Promise<void>((resolve, reject) => {
      const child = fork(this.processEntry, [], {
        stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced",
        env: { PATH:process.env.PATH, TMPDIR:process.env.TMPDIR, LANG:process.env.LANG, ELECTRON_RUN_AS_NODE: "1" },
        execArgv: ["--disable-warning=ExperimentalWarning"],
      });
      this.child = child;
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Agent execution process did not start")); }, 15_000);
      child.once("error", () => { clearTimeout(timer); reject(new Error("Agent execution process could not be started")); });
      child.once("exit", () => {
        clearTimeout(timer);
        if (this.child !== child) return;
        this.child = undefined;
        if (this.processInfoValue) {
          this.processInfoValue.status = "exited";
          this.processInfoValue.exitReason ??= "unexpected";
          void this.changed().catch(()=>undefined);
        }
        const error = new Error("Agent execution process exited");
        reject(error);
        if (this.runId !== undefined) { this.runController?.abort(); this.rejectRun?.(error); }
      });
      child.on("message", (packet: unknown) => {
        if (this.child !== child || !isProcessPacket(packet)) return;
        if (packet.kind === "ready") {
          if (packet.pid !== child.pid) { child.kill("SIGKILL"); reject(new Error("Agent process identity mismatch")); return; }
          clearTimeout(timer);
          this.processInfoValue = { executionId: randomUUID(), pid: packet.pid, startedAt: new Date().toISOString(), status: "ready" };
          void this.changed().then(resolve,error=>{child.kill("SIGKILL");reject(error);});
        } else if(packet.kind==="accepted"&&packet.id===this.runId){
          if(this.acceptanceTimer)clearTimeout(this.acceptanceTimer);this.acceptanceTimer=undefined;this.acceptRun?.();
        } else if (packet.kind === "finished" && packet.id === this.runId) {
          if (packet.error) this.rejectRun?.(new Error(packet.error));
          else this.resolveRun?.();
        } else if (packet.kind === "call") {
          void this.runScope(() => this.handleCall(packet));
        }
      });
    }).finally(() => { this.opening = undefined; });
    return this.opening;
  }

  private async execute(continuation: boolean, input?: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void> {
    if (this.runPromise) throw new Error("Agent is already processing");
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.runScope = AsyncLocalStorage.snapshot();
    this.runController = new AbortController();
    this.localState.isStreaming = true;
    this.localState.errorMessage = undefined;
    const settled = new Promise<void>((resolve, reject) => { this.resolveRun = resolve; this.rejectRun = reject; });
    // Register the rejection handler before child startup can fail.
    this.runPromise = settled;
    void settled.catch(() => undefined);
    let started=false;
    try {
      await this.ensureProcess();
      this.runId = ++this.sequence;
      this.processInfoValue!.status = "starting";
      await this.changed();
      const accepted=new Promise<void>(resolve=>{this.acceptRun=resolve;});
      this.acceptanceTimer=setTimeout(()=>this.rejectRun?.(new Error("智能体进程已就绪，但未能接收这次工作；已停止该进程")),this.runAcceptTimeoutMs);
      const hooks = [this.transformContext && "transform", this.beforeToolCall && "beforeTool", this.afterToolCall && "afterTool", this.shouldStopAfterTurn && "shouldStop", (this.prepareNextTurnWithContext || this.prepareNextTurn) && "prepare"].filter((x): x is string => typeof x === "string");
      this.send({ kind: "run", id: this.runId, continuation, input, images, hooks, queues: { steering: this.steeringMessages.slice(), followUp: this.followUpMessages.slice() },
        state: { systemPrompt: this.state.systemPrompt, messages: this.state.messages, model: this.state.model, thinkingLevel: this.state.thinkingLevel, tools: processTools(this.state.tools) },
        options: { steeringMode: this.steeringMode, followUpMode: this.followUpMode, sessionId: this.sessionId, thinkingBudgets: this.thinkingBudgets, transport: this.transport, maxRetryDelayMs: this.maxRetryDelayMs, toolExecution: this.toolExecution },
      });
      await Promise.race([accepted,settled.then(()=>{throw new Error("Agent process finished before accepting the run");})]);
      if(this.runController.signal.aborted)throw new Error("Agent start was cancelled");
      this.processInfoValue!.status="running";
      await this.changed();
      this.send({kind:"start",id:this.runId});started=true;
      await settled;
    } catch(error){
      // Rejection is only returned after our private process has actually exited.
      this.runController?.abort();
      await this.releaseProcess(started?"failed":"start_failed");
      await this.processPersistence;
      throw error;
    } finally {
      if(this.acceptanceTimer)clearTimeout(this.acceptanceTimer);this.acceptanceTimer=undefined;this.acceptRun=undefined;
      this.localState.isStreaming = false;
      this.localState.streamingMessage = undefined;
      this.localState.pendingToolCalls = new Set();
      this.runId = undefined;
      this.resolveRun = undefined;
      this.rejectRun = undefined;
      this.runPromise = undefined;
      this.runController = undefined;
      if (this.processInfoValue?.status !== "exited" && this.child) {
        this.processInfoValue!.status = "idle";
        await this.changed();
        if (this.idleTimeoutMs >= 0) {
          this.idleTimer = setTimeout(() => { void this.releaseProcess("idle"); }, this.idleTimeoutMs);
          this.idleTimer.unref();
        }
      }
    }
  }

  private async handleCall(packet: Extract<ProcessPacket, { kind: "call" }>): Promise<void> {
    const child = this.child;
    const signal = this.runController?.signal;
    const respond = (response: ProcessPacket) => { if (this.child === child && child?.connected) child.send(response, () => undefined); };
    try {
      if (!signal || !this.runId) throw new Error("Agent callback outside an active run");
      let value: unknown;
      switch (packet.method) {
        case "event": {
          const { event } = sanitizeRuntimeValue(packet.args as ProcessLoopEvent);
          if (event.type === "message_start") {
            const key = JSON.stringify(event.message);
            const steeringIndex = this.steeringMessages.findIndex((message) => JSON.stringify(message) === key);
            if (steeringIndex >= 0) this.steeringMessages.splice(steeringIndex, 1);
            else { const followUpIndex = this.followUpMessages.findIndex((message) => JSON.stringify(message) === key); if (followUpIndex >= 0) this.followUpMessages.splice(followUpIndex, 1); }
          }
          if (event.type === "message_start" || event.type === "message_update") this.localState.streamingMessage = event.message;
          else if (event.type === "message_end") { this.localState.streamingMessage = undefined; this.state.messages.push(event.message); }
          else if (event.type === "tool_execution_start") this.localState.pendingToolCalls.add(event.toolCallId);
          else if (event.type === "tool_execution_end") this.localState.pendingToolCalls.delete(event.toolCallId);
          else if (event.type === "turn_end" && event.message.role === "assistant" && event.message.errorMessage) this.localState.errorMessage = event.message.errorMessage;
          else if (event.type === "agent_end") this.localState.streamingMessage = undefined;
          for (const listener of this.processListeners) await listener(event, signal);
          break;
        }
        case "convert": value = await this.convertToLlm(packet.args as AgentMessage[]); break;
        case "transform": value = await this.transformContext?.(packet.args as AgentMessage[], signal) ?? packet.args; break;
        case "beforeTool": value = await this.beforeToolCall?.(packet.args as Parameters<NonNullable<Agent["beforeToolCall"]>>[0], signal); break;
        case "afterTool": value = await this.afterToolCall?.(packet.args as Parameters<NonNullable<Agent["afterToolCall"]>>[0], signal); break;
        case "shouldStop": value = await this.shouldStopAfterTurn?.(packet.args as Parameters<NonNullable<Agent["shouldStopAfterTurn"]>>[0], signal) ?? false; break;
        case "prepare": {
          const turn = packet.args as Parameters<NonNullable<Agent["prepareNextTurnWithContext"]>>[0];
          const currentTurn = { ...turn, context: { ...turn.context, messages: this.state.messages.slice(), tools: this.state.tools.slice(), systemPrompt: this.state.systemPrompt } };
          const update = this.prepareNextTurnWithContext
            ? await this.prepareNextTurnWithContext(currentTurn, signal)
            : await this.prepareNextTurn?.(signal);
          value = update?.context ? { ...update, context: { ...update.context, ...(update.context.tools ? { tools: processTools(update.context.tools) } : {}) } } : update;
          break;
        }
        case "tool": {
          const call = packet.args as { name: string; toolCallId: string; args: unknown };
          const tool = this.state.tools.find((candidate) => candidate.name === call.name);
          if (!tool || !Value.Check(tool.parameters, call.args)) throw new Error("Invalid or unavailable Agent tool");
          value = sanitizeRuntimeValue(await tool.execute(call.toolCallId, call.args, signal, (update) => respond({ kind: "toolUpdate", id: packet.id, value: sanitizeRuntimeValue(update) })));
          break;
        }
        case "stream": {
          const args = packet.args as { model: Parameters<Agent["streamFunction"]>[0]; context: Parameters<Agent["streamFunction"]>[1]; options?: Parameters<Agent["streamFunction"]>[2] };
          const stream = await this.streamFunction(args.model, args.context, { ...args.options, signal, onPayload: this.onPayload, onResponse: this.onResponse,
            ...(this.getApiKey ? { apiKey: await this.getApiKey(args.model.provider) } : {}) });
          for await (const event of stream) respond({ kind: "stream", id: packet.id, value: sanitizeRuntimeValue(event) });
          value = sanitizeRuntimeValue(await stream.result());
          break;
        }
        default: throw new Error("Unknown Agent process callback");
      }
      respond({ kind: "result", id: packet.id, value });
    } catch (error) {
      respond({ kind: "result", id: packet.id, error: sanitizeRuntimeValue(error instanceof Error ? error.message : "Agent callback failed") });
    }
  }

  private async releaseProcess(reason: "idle" | "disposed" | "start_failed" | "failed"): Promise<void> {
    if (this.retiring) return this.retiring;
    const child = this.child;
    if (!child) return;
    if (this.runPromise && reason === "idle") return;
    if (this.processInfoValue) this.processInfoValue.exitReason = reason;
    this.retiring = new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      child.kill("SIGTERM");
    }).finally(() => { this.retiring = undefined; });
    return this.retiring;
  }
  async retireIfIdle(): Promise<boolean> {
    if (this.runPromise) return false;
    await this.releaseProcess("idle");
    await this.processPersistence;
    return true;
  }
  async disposeProcess(): Promise<void> {
    this.disposed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.abort();
    await this.releaseProcess("disposed");
    await this.processPersistence;
  }
}
