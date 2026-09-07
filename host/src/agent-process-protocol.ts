import type { AgentEvent, AgentState, AgentTool } from "@earendil-works/pi-agent-core";

export type ProcessTool = Pick<AgentTool, "name" | "label" | "description" | "parameters" | "executionMode">;
export type ProcessState = Pick<AgentState, "systemPrompt" | "messages" | "model" | "thinkingLevel"> & {
  tools: ProcessTool[];
};

export function processTools(tools: AgentTool[]): ProcessTool[] {
  return tools.map(({ name, label, description, parameters, executionMode }) => ({ name, label, description, parameters, ...(executionMode?{executionMode}:{}) }));
}

export type ProcessHook = "event" | "convert" | "transform" | "beforeTool" | "afterTool" | "shouldStop" | "prepare" | "tool" | "stream";
export type ProcessPacket =
  | { kind: "ready"; pid: number }
  | { kind: "call"; id: number; method: ProcessHook; args: unknown }
  | { kind: "result"; id: number; value?: unknown; error?: string }
  | { kind: "stream"; id: number; value: unknown }
  | { kind: "toolUpdate"; id: number; value: unknown }
  | { kind: "run"; id: number; state: ProcessState; input?: unknown; images?: unknown; continuation: boolean; queues: { steering: import("@earendil-works/pi-agent-core").AgentMessage[]; followUp: import("@earendil-works/pi-agent-core").AgentMessage[] }; options: Record<string, unknown>; hooks: string[] }
  | { kind: "control"; action: "abort" | "steer" | "followUp" | "clearSteering" | "clearFollowUp" | "clearAll"; value?: unknown }
  | { kind: "accepted"; id:number }
  | { kind: "start"; id:number }
  | { kind: "finished"; id: number; error?: string };

export interface ProcessLoopEvent {
  event: AgentEvent;
  queued: boolean;
}

export function isProcessPacket(value: unknown): value is ProcessPacket {
  if (!value || typeof value !== "object") return false;
  const packet = value as Record<string, unknown>;
  if (packet.kind === "ready") return Number.isInteger(packet.pid) && Number(packet.pid) > 0;
  if (packet.kind === "control") return ["abort", "steer", "followUp", "clearSteering", "clearFollowUp", "clearAll"].includes(String(packet.action));
  return ["call", "result", "stream", "toolUpdate", "run", "accepted", "start", "finished"].includes(String(packet.kind))
    && Number.isSafeInteger(packet.id) && Number(packet.id) > 0;
}
