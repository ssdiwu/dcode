import type {
  HostEvent,
  FoundationSnapshot,
  TaskWorkbenchViewStatePatch,
  DCodeSessionPresentation,
  ManagedAttachment,
} from "./types.ts";

export interface MessagePart {
  kind: "text" | "thinking" | "tool" | "image" | "file";
  text: string;
  mimeType?: string;
  toolCallId?: string;
  toolName?: string;
  toolResult?: boolean;
  isError?: boolean;
  attachment?: ManagedAttachment;
}
export interface MessageRow {
  id: string;
  role: "user" | "assistant" | "process";
  time?: string;
  parts: MessagePart[];
  messageId?: string;
  stopReason?: string;
}
const record = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
/** Preserve message ownership; a tool result is never a user utterance. */
export function messageRows(
  entries: readonly {
    id: string;
    type: string;
    timestamp?: string;
    message?: unknown;
  }[],
): MessageRow[] {
  const rows: MessageRow[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const msg = record(entry.message);
    const role =
      msg.role === "user"
        ? "user"
        : msg.role === "assistant"
          ? "assistant"
          : "process";
    const parts: MessagePart[] = [];
    if (msg.stopReason === "error" || msg.stopReason === "aborted")
      parts.push({
        kind: "text",
        text:
          typeof msg.errorMessage === "string"
            ? msg.errorMessage
            : msg.stopReason === "aborted"
              ? "本次执行已停止。"
              : "本次执行失败，请重试。",
      });
    const content =
      typeof msg.content === "string"
        ? [{ type: "text", text: msg.content }]
        : Array.isArray(msg.content)
          ? msg.content
          : [];
    for (const value of content) {
      const part = record(value);
      if (part.type === "text")
        parts.push({
          kind: role === "process" ? "tool" : "text",
          text: String(part.text ?? ""),
          ...(role === "process" ? {toolCallId: String(msg.toolCallId ?? entry.id), toolName: String(msg.toolName ?? "工具"), toolResult: true, isError: msg.isError === true} : {}),
        });
      else if (part.type === "thinking" && String(part.thinking ?? "").trim())
        parts.push({ kind: "thinking", text: String(part.thinking ?? "") });
      else if (part.type === "toolCall")
        parts.push({
          kind: "tool",
          text: `${String(part.name ?? part.toolName ?? "工具")}\n${JSON.stringify(part.arguments ?? {}, null, 2)}`,
          toolCallId: String(part.id ?? entry.id),
          toolName: String(part.name ?? part.toolName ?? "工具"),
        });
      else if (
        part.type === "image" &&
        typeof part.data === "string" &&
        /^image\/(png|jpeg|gif|webp)$/.test(String(part.mimeType))
      )
        parts.push({
          kind: "image",
          text: part.data,
          mimeType: String(part.mimeType),
          ...(role === "process" ? {toolCallId: String(msg.toolCallId ?? entry.id), toolName: String(msg.toolName ?? "工具"), toolResult: true, isError: msg.isError === true} : {}),
        });
    }
    if (role === "process" && parts.length === 0)
      parts.push({ kind: "tool", text: "工具已结束，无文本输出。", toolCallId: String(msg.toolCallId ?? entry.id), toolName: String(msg.toolName ?? "工具"), toolResult: true, isError: msg.isError === true });
    if (parts.length)
      rows.push({ id: entry.id, role, time: entry.timestamp, parts, messageId: msg.timestamp == null ? undefined : String(msg.timestamp), stopReason: typeof msg.stopReason === "string" ? msg.stopReason : undefined });
  }
  return rows;
}
export interface LiveMessage {
  id: string;
  text: string;
  thinking: string;
  ended: boolean;
  parts?: MessagePart[];
  stopReason?: string;
}
export interface LiveTool {
  id: string;
  name: string;
  input: string;
  output: string;
  state: "running" | "complete" | "error";
}
export interface StreamState {
  sessionId: string;
  messages: LiveMessage[];
  active: boolean;
  tools?: LiveTool[];
}
export const emptyStream = (sessionId = ""): StreamState => ({
  sessionId,
  messages: [],
  active: false,
});
/** Consume the actual Protocol v1 message_update envelope, scoped to one adapter. */
export function reduceStream(
  state: StreamState,
  envelope: HostEvent,
  adapterSessionId: string,
): StreamState {
  const data = record(envelope.data);
  if (envelope.event !== "session.event" || data.sessionId !== adapterSessionId)
    return state;
  let next =
    state.sessionId === adapterSessionId
      ? state
      : emptyStream(adapterSessionId);
  if (data.type === "agent_start")
    return { ...emptyStream(adapterSessionId), active: true };
  if (data.type === "agent_end") return { ...next, active: false };
  if (String(data.type).startsWith("tool_execution_")) {
    const tools = [...(next.tools ?? [])];
    const id = String(data.toolCallId);
    const index = tools.findIndex(tool => tool.id === id);
    const previous = tools[index];
    const result = record(data.type === "tool_execution_update" ? data.partialResult : data.result);
    const output = Array.isArray(result.content) ? result.content.map(value => String(record(value).text ?? "")).filter(Boolean).join("\n") : "";
    const tool: LiveTool = {id, name: String(data.toolName ?? previous?.name ?? "工具"), input: data.args === undefined ? previous?.input ?? "" : JSON.stringify(data.args, null, 2), output: output || previous?.output || "", state: data.type === "tool_execution_end" ? data.isError ? "error" : "complete" : "running"};
    if (index < 0) tools.push(tool); else tools[index] = tool;
    return {...next, tools};
  }
  if (
    data.type === "message_start" &&
    record(data.message).role === "assistant"
  ) {
    return {
      ...next,
      active: true,
      messages: [
        ...next.messages,
        {
          id: String(record(data.message).timestamp ?? next.messages.length),
          text: "",
          thinking: "",
          ended: false,
        },
      ],
    };
  }
  if (data.type === "message_end" && (!record(data.message).role || record(data.message).role === "assistant"))
    return {
      ...next,
      messages: next.messages.map((m, i) =>
        i === next.messages.length - 1 ? { ...m, ...liveContent(data.message), ended: true } : m,
      ),
    };
  if (data.type !== "message_update") return next;
  const delta = record(data.assistantMessageEvent);
  const complete = liveContent(data.message ?? delta.partial);
  if (complete.parts) {
    const messages = [...next.messages];
    const last = messages.at(-1);
    const current = last && !last.ended ? last : {id: String(record(data.message ?? delta.partial).timestamp ?? messages.length), text: "", thinking: "", ended: false};
    if (current !== last) messages.push(current);
    messages[messages.length - 1] = {...current, ...complete};
    return {...next, active: true, messages};
  }
  if (delta.type !== "text_delta" && delta.type !== "thinking_delta")
    return next;
  const messages = [...next.messages];
  const last = messages.at(-1);
  const current =
    last && !last.ended
      ? last
      : { id: String(messages.length), text: "", thinking: "", ended: false };
  if (current !== last) messages.push(current);
  messages[messages.length - 1] = {
    ...current,
    [delta.type === "text_delta" ? "text" : "thinking"]:
      (delta.type === "text_delta" ? current.text : current.thinking) +
      String(delta.delta ?? ""),
  };
  return { ...next, active: true, messages };
}

function liveContent(message: unknown): Partial<LiveMessage> {
  const value = record(message);
  if (!Array.isArray(value.content)) return {};
  const parts = messageRows([{id: "live", type: "message", message: {...value, role: "assistant"}}])[0]?.parts ?? [];
  return {parts, text: parts.filter(part => part.kind === "text").map(part => part.text).join(""), thinking: parts.filter(part => part.kind === "thinking").map(part => part.text).join(""), stopReason: typeof value.stopReason === "string" ? value.stopReason : undefined};
}
export function presentationMatches(
  value: DCodeSessionPresentation | undefined,
  sessionId: string | null,
): boolean {
  return !!value && value.dcodeSession.id === sessionId;
}
export interface RevisionApi {
  request<T>(method: string, params?: Record<string, unknown>): Promise<T>;
}
/** Serialize our own writes and retry only explicit revision conflicts with fresh revisions. */
export function mutationQueue(client: RevisionApi) {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(method: string, params: Record<string, unknown>): Promise<T> => {
    const requestId = crypto.randomUUID();
    const run = async (): Promise<T> => {
      for (let attempt = 0; ; attempt++) {
        const snapshot = await client.request<FoundationSnapshot>(
          "foundation.snapshot",
        );
        try {
          return await client.request<T>(method, {
            ...params,
            requestId,
            expectedStoreRevision: snapshot.storeRevision,
            ...(method === "taskWorkbenchViewState.patch"
              ? {
                  expectedViewStateRevision:
                    snapshot.taskWorkbenchViewState.revision,
                }
              : {}),
          });
        } catch (error) {
          const code = record(error).code;
          if (
            attempt >= 3 ||
            (code !== "REVISION_CONFLICT" &&
              !String(error).includes("REVISION_CONFLICT"))
          )
            throw error;
        }
      }
    };
    const result = tail.then(run);
    tail = result.catch(() => {});
    return result;
  };
}
export function selectionPatch(
  taskId: string | null,
  sessionId: string | null,
): TaskWorkbenchViewStatePatch {
  return {
    selection: { taskId, sessionId },
    inspectorTarget: null,
    workspaceContent: null,
  };
}
