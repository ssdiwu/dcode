/** Type-only imports keep the Host contract authoritative without bundling it. */
import type {
  FoundationSnapshot,
  TaskRecord,
  DCodeSessionRecord,
} from "../../../../host/src/product-store.js";
import type { SessionInspection } from "../../../../host/src/session-reader.js";
import type {
  HostEvent,
  HostMethod,
  PromptImageInput,
} from "../../../../host/src/protocol.js";
export type {
  FoundationSnapshot,
  TaskRecord,
  TaskScope,
  TaskBundle,
  TaskWorkbenchViewStatePatch,
  TaskWorkbenchInspectorTarget,
  DCodeSessionRecord,
  AgentRequestRecord,
  ClientPreferences,
  SessionEntryRecord,
  NativeSessionPathAction,
  ComposerDraftRecord,
} from "../../../../host/src/product-store.js";
export type { SessionInspection, HostEvent, PromptImageInput };
export type { InspirationView, IdeaNode, IdeaDraft, IdeaKind, IdeaPosition, InspirationOperation } from "../../../../host/src/inspiration.js";
export type { ManagedAttachment, AttachmentSource } from "../../../../host/src/attachment-files.js";
export type SessionEntry = SessionInspection["entries"][number];
export type ProviderView =
  import("../../../../host/src/model-providers.js").ProviderView;

export interface DCodeSessionPresentation {
  nativePaths?:import("../../../../host/src/product-store.js").SessionPathRecord[];
  selectedNativePathId?:string;
  nativeEntries?:import("../../../../host/src/product-store.js").SessionEntryRecord[];
  collaborationInputs?: Array<{sourceEntryId:string;author:string;messageId:string}>;
  dcodeSession: DCodeSessionRecord;
  adapterState: "ready" | "unbound" | "unavailable";
  runtime: { runtimeId: string; state: unknown } | null;
  binding: { sessionId: string; adapterSessionId: string } | null;
  inspection: SessionInspection | null;
  submissions?: {sourceEntryId?:string;text:string;effectiveText:string;attachments:import("../../../../host/src/attachment-files.js").ManagedAttachment[]}[];
}
export interface DcodeApi {
  readDeviceCode:(flowId:string)=>Promise<import("../../../../host/src/device-code-types.js").DeviceCodeDisplay|null>;
  connectApiKey:(providerId:string,key:string)=>Promise<import("../../../../host/src/api-key-connection.js").ApiKeyConnectionResult>;
  htmlPreview:(input:Record<string,unknown>)=>Promise<unknown>;
  request: <T = unknown>(
    method: HostMethod,
    params?: Record<string, unknown>,
  ) => Promise<T>;
  subscribe: (handler: (envelope: HostEvent) => void) => () => void;
  notify: (options: { title: string; body?: string }) => Promise<boolean>;
  getPathForFile: (file: File) => string;
  previewInspiration:(nodeId:string,media:boolean)=>Promise<void>;
  previewAttachment: (id: string) => Promise<void>;
  switchCandidate: (direction: "candidate" | "rollback") => Promise<boolean>;
  signalRestoreFailed: () => Promise<void>;
  signalReady: (selection: {
    taskId: string | null;
    sessionId: string | null;
  }) => Promise<void>;
  diagnostics: () => Promise<{
    version: string;
    packaged?: boolean;
    hostReady: boolean;
    events: { time: string; message: string }[];
  }>;
  clearDiagnostics: () => Promise<boolean>;
  openNotificationSettings: () => Promise<void>;
  revealCandidate: (path: string) => Promise<void>;
  chooseContextFiles:()=>Promise<string[]>;
  chooseDirectory: () => Promise<string | null>;
  openExternal: (url: string) => Promise<void>;
  restartHost: () => Promise<boolean>;
  readyToQuit: (error?: string) => void;
}
export function api(): DcodeApi {
  const value = (window as unknown as { dcode?: DcodeApi }).dcode;
  if (!value) throw new Error("无法连接应用，请重新打开 D Code。");
  return value;
}
export function fetchSnapshot(): Promise<FoundationSnapshot> {
  return api().request<FoundationSnapshot>("foundation.snapshot");
}
export function taskProjectId(task: TaskRecord): string | null {
  return task.scope.kind === "project" ? task.scope.projectId : null;
}
export function errorText(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  const readable=message.replace(/^Error invoking remote method '[^']+':\s*/u,"").replace(/^Error:\s*/u,"").replace(/^[A-Z][A-Z0-9_]+:\s*/u,"");
  if(/(?:FILE_|WORKSPACE_|GIT_|HTML_)/u.test(message))return readable;
  if (/REVISION_CONFLICT/.test(message))
    return "数据刚刚更新，请重试。输入内容已保留。";
  if (/MODEL|model.*not|API key|authentication/i.test(message))
    return "模型暂不可用，请检查模型选择和供应商连接。输入内容已保留。";
  return readable;
}
