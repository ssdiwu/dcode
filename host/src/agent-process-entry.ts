// Private execution process. Product storage, credentials and side effects stay
// behind the owning Host; only the Pi agent loop runs here.
import { Agent, type AgentTool, type AgentMessage } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent } from "@earendil-works/pi-ai";
import { isProcessPacket, processTools, type ProcessHook, type ProcessPacket, type ProcessTool } from "./agent-process-protocol.js";

let sequence = 0;
let agent: Agent | undefined;
let running = false;
let startGate:{id:number;resolve:()=>void}|undefined;
const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; update?: (value: unknown) => void }>();
const streams = new Map<number, AssistantMessageEventStream>();

function send(packet: ProcessPacket): void {
  if (!process.connected || !process.send) throw new Error("D Code Host disconnected");
  process.send(packet);
}

function call(method: ProcessHook, args: unknown, update?: (value: unknown) => void): Promise<unknown> {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject, update });
    const context = args && typeof args === "object" && "context" in args ? (args as { context?: { tools?: AgentTool[] } }).context : undefined;
    const wireArgs = context?.tools ? { ...args as object, context: { ...context, tools: processTools(context.tools) } } : args;
    send({ kind: "call", id, method, args: wireArgs });
  });
}

function tools(descriptors: ProcessTool[]): AgentTool[] {
  return descriptors.map((tool) => ({
    ...tool,
    execute: async (toolCallId, args, _signal, onUpdate) => await call("tool", { name: tool.name, toolCallId, args }, onUpdate as ((value: unknown) => void) | undefined) as Awaited<ReturnType<AgentTool["execute"]>>,
  }));
}

async function run(packet: Extract<ProcessPacket, { kind: "run" }>): Promise<void> {
  if (running) { send({ kind: "finished", id: packet.id, error: "Agent process is already running" }); return; }
  running = true;
  try {
    const has = (name: string) => packet.hooks.includes(name);
    agent = new Agent({
      ...packet.options,
      initialState: { ...packet.state, tools: tools(packet.state.tools) },
      convertToLlm: async (messages) => await call("convert", messages) as Awaited<ReturnType<Agent["convertToLlm"]>>,
      transformContext: has("transform") ? async (messages) => await call("transform", messages) as AgentMessage[] : undefined,
      beforeToolCall: has("beforeTool") ? async (context) => await call("beforeTool", context) as Awaited<ReturnType<NonNullable<Agent["beforeToolCall"]>>> : undefined,
      afterToolCall: has("afterTool") ? async (context) => await call("afterTool", context) as Awaited<ReturnType<NonNullable<Agent["afterToolCall"]>>> : undefined,
      shouldStopAfterTurn: has("shouldStop") ? async (context) => Boolean(await call("shouldStop", context)) : undefined,
      prepareNextTurnWithContext: has("prepare") ? async (context) => {
        const next = await call("prepare", context) as Awaited<ReturnType<NonNullable<Agent["prepareNextTurnWithContext"]>>>;
        if (next?.context?.tools) next.context.tools = tools(next.context.tools);
        return next;
      } : undefined,
      streamFn: (model, context, options) => {
        const id = ++sequence;
        const stream = createAssistantMessageEventStream();
        streams.set(id, stream);
        const serializable = Object.fromEntries(Object.entries(options ?? {}).filter(([name, value]) => name !== "signal" && typeof value !== "function"));
        send({ kind: "call", id, method: "stream", args: { model, context: { ...context, tools: context.tools?.map(({ name, description, parameters }) => ({ name, description, parameters })) }, options: serializable } });
        return stream;
      },
    });
    await new Promise<void>(resolve=>{startGate={id:packet.id,resolve};send({kind:"accepted",id:packet.id});});
    agent.subscribe(async (event) => { await call("event", { event, queued: agent!.hasQueuedMessages() }); });
    for (const message of packet.queues.steering) agent.steer(message);
    for (const message of packet.queues.followUp) agent.followUp(message);
    if (packet.continuation) await agent.continue();
    else if (typeof packet.input === "string") await agent.prompt(packet.input, packet.images as Parameters<Agent["prompt"]>[1]);
    else await agent.prompt(packet.input as AgentMessage | AgentMessage[]);
    send({ kind: "finished", id: packet.id });
  } catch (error) {
    send({ kind: "finished", id: packet.id, error: error instanceof Error ? error.message : "Agent process failed" });
  } finally {
    running = false;
    startGate=undefined;
  }
}

process.on("message", (message: unknown) => {
  if (!isProcessPacket(message)) return;
  if(message.kind==="start"&&startGate?.id===message.id){startGate.resolve();startGate=undefined;return;}
  if (message.kind === "run") { void run(message); return; }
  if (message.kind === "control") {
    if (!agent) return;
    switch (message.action) {
      case "abort": agent.abort(); break;
      case "steer": agent.steer(message.value as AgentMessage); break;
      case "followUp": agent.followUp(message.value as AgentMessage); break;
      case "clearSteering": agent.clearSteeringQueue(); break;
      case "clearFollowUp": agent.clearFollowUpQueue(); break;
      case "clearAll": agent.clearAllQueues(); break;
    }
    return;
  }
  if (message.kind === "stream") { streams.get(message.id)?.push(message.value as AssistantMessageEvent); return; }
  if (message.kind === "toolUpdate") { waiting.get(message.id)?.update?.(message.value); return; }
  if (message.kind !== "result") return;
  const stream = streams.get(message.id);
  if (stream) {
    streams.delete(message.id);
    if (message.error) {
      const model = agent!.state.model;
      const failure: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: agent?.signal?.aborted ? "aborted" : "error", errorMessage: message.error, timestamp: Date.now() };
      stream.push({ type: "error", reason: failure.stopReason as "error" | "aborted", error: failure });
      stream.end(failure);
    } else stream.end(message.value as AssistantMessage);
    return;
  }
  const pending = waiting.get(message.id);
  waiting.delete(message.id);
  if (message.error) pending?.reject(new Error(message.error));
  else pending?.resolve(message.value);
});
process.on("disconnect", () => { agent?.abort(); process.exit(0); });
send({ kind: "ready", pid: process.pid });
