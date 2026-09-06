export const PROTOCOL_VERSION = 1 as const;

export const HOST_METHODS = [
  "host.hello",
  "maintenance.status",
  "selfEvolution.list",
  "selfEvolution.prepare",
  "selfEvolution.transition",
  "maintenance.start",
  "runtime.list",
  "runtime.start",
  "foundation.snapshot",
  "clientPreferences.get",
  "clientPreferences.importLegacy",
  "clientPreferences.set",
  "taskDraft.set",
  "attachment.import",
  "attachment.get",
  "attachment.resolve",
  "runtimeModelSelection.set",
  "dcodeModelProvider.save",
  "dcodeModelProvider.remove",
  "taskWorkbenchViewState.patch",
  "dcodeSession.presentation",
  "dcodeSession.composerDraft.set",
  "dcodeSession.prompt",
  "dcodeSession.copy",
  "project.create",
  "project.gitBranch",
  "task.create",
  "task.manage",
  "task.context.replace",
  "task.plan.create",
  "task.plan.update",
  "task.workItem.create",
  "task.workItem.update",
  "task.workItem.reorder",
  "task.acceptance",
  "team.create",
  "team.start",
  "agentRequest.answer",
  "agentRun.stop",
  "agentProfile.create",
  "agentProfile.update",
  "piImport.listCandidates",
  "piImport.preview",
  "piImport.importAsTask",
  "session.importedEntries",
  "session.list",
  "session.search",
  "session.inspect",
  "session.refresh",
  "session.create",
  "session.copy",
  "session.relocateCwd",
  "session.trash",
  "session.repair",
  "session.open",
  "session.close",
  "session.prompt",
  "session.steer",
  "session.abort",
  "session.getState",
  "session.contextBreakdown",
  "session.getCommands",
  "resources.list",
  "resources.setPackageEnabled",
  "session.compactionInfo",
  "session.compact",
  "modelProviders.list",
  "modelProviders.save",
  "modelProviders.remove",
  "session.getModels",
  "dcodeModels.get",
  "dcodeModels.refresh",
  "dcodeModels.select",
  "dcodeModels.setThinking",
  "modelSettings.get",
  "modelSettings.refresh",
  "modelSettings.setEnabledModels",
  "modelSettings.setDefaultModel",
  "modelAuth.start",
  "modelAuth.respond",
  "modelAuth.cancel",
  "session.getThinkingLevels",
  "session.setModel",
  "session.setName",
  "session.setThinking",
  "session.setFastMode",
  "extension.respond",
  "content.renderMermaid",
  "host.shutdown",
] as const;

export type HostMethod = (typeof HOST_METHODS)[number];

export interface HostRequest {
  version: typeof PROTOCOL_VERSION;
  type: "request";
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface ProtocolErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export interface HostSuccessResponse {
  version: typeof PROTOCOL_VERSION;
  type: "response";
  id: string;
  method: string;
  ok: true;
  result?: unknown;
}

export interface HostErrorResponse {
  version: typeof PROTOCOL_VERSION;
  type: "response";
  id: string;
  method: string;
  ok: false;
  error: ProtocolErrorBody;
}

export type HostResponse = HostSuccessResponse | HostErrorResponse;

export interface HostEvent {
  version: typeof PROTOCOL_VERSION;
  type: "event";
  event: string;
  data?: unknown;
}

export class ProtocolValidationError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ProtocolValidationError";
    this.code = code;
    this.details = details;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
  params: Record<string, unknown>,
  key: string,
  options: { allowEmpty?: boolean } = {},
): string {
  const value = params[key];
  if (typeof value !== "string" || (!options.allowEmpty && value.length === 0)) {
    throw new ProtocolValidationError(
      "INVALID_PARAMS",
      `Expected params.${key} to be ${options.allowEmpty ? "a string" : "a non-empty string"}`,
    );
  }
  return value;
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new ProtocolValidationError("INVALID_PARAMS", `Expected params.${key} to be a string`);
  }
  return value;
}

/** Prompt 图片附件合同（0.0.20）：与 Pi SDK `ImageContent` 结构一致，
 *  经 `session.prompt` 的 `images` 与 `session.steer` 的 `images` 传递。 */
export interface PromptImageInput {
  type: "image";
  data: string;
  mimeType: string;
}

const MAX_PROMPT_IMAGES = 8;
const MAX_PROMPT_IMAGE_BASE64_LENGTH = 7_000_000;

function validatePromptImages(params: Record<string, unknown>, key: string): void {
  const value = params[key];
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PROMPT_IMAGES) {
    throw new ProtocolValidationError(
      "INVALID_PARAMS",
      `Expected params.${key} to be a non-empty array containing at most ${MAX_PROMPT_IMAGES} images`,
    );
  }
  for (const item of value) {
    if (
      !isRecord(item)
      || item.type !== "image"
      || typeof item.data !== "string"
      || typeof item.mimeType !== "string"
    ) {
      throw new ProtocolValidationError(
        "INVALID_PARAMS",
        `Expected every params.${key} item to be { type: "image", data, mimeType }`,
      );
    }
    if (item.data.length === 0 || item.data.length > MAX_PROMPT_IMAGE_BASE64_LENGTH) {
      throw new ProtocolValidationError(
        "INVALID_PARAMS",
        `Expected every params.${key} item data to be base64 of 1..${MAX_PROMPT_IMAGE_BASE64_LENGTH} characters`,
      );
    }
    if (!/^image\/[a-z0-9.+-]+$/i.test(item.mimeType) || item.mimeType.length > 64) {
      throw new ProtocolValidationError(
        "INVALID_PARAMS",
        `Expected every params.${key} item mimeType to be an image/* MIME type`,
      );
    }
  }
}

function requireStringArray(
  params: Record<string, unknown>,
  key: string,
  maximumItems: number,
  optional = false,
): string[] | undefined {
  const value = params[key];
  if (value === undefined && optional) return undefined;
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new ProtocolValidationError(
      "INVALID_PARAMS",
      `Expected params.${key} to be an array containing at most ${maximumItems} paths`,
    );
  }
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0 || item.length > 4_096) {
      throw new ProtocolValidationError(
        "INVALID_PARAMS",
        `Expected every params.${key} item to be a non-empty string up to 4096 characters`,
      );
    }
  }
  return value;
}

function optionalInteger(
  params: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ProtocolValidationError(
      "INVALID_PARAMS",
      `Expected params.${key} to be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value as number;
}

function requireInteger(
  params: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): number {
  const value = optionalInteger(params, key, minimum, maximum);
  if (value === undefined) {
    throw new ProtocolValidationError("INVALID_PARAMS", `Expected params.${key} to be an integer`);
  }
  return value;
}

function requireBoundedString(params: Record<string, unknown>, key: string, maximum: number): string {
  const value = requireString(params, key);
  if (value.length > maximum) {
    throw new ProtocolValidationError(
      "INVALID_PARAMS",
      `Expected params.${key} to be at most ${maximum} characters`,
    );
  }
  return value;
}

function validateTaskScope(params: Record<string, unknown>): void {
  const value = params.scope;
  if (!isRecord(value)) {
    throw new ProtocolValidationError("INVALID_PARAMS", "Expected params.scope to be an object");
  }
  const keys = Object.keys(value).sort();
  if (value.kind === "user") {
    if (keys.length !== 2 || keys[0] !== "kind" || keys[1] !== "userId") {
      throw new ProtocolValidationError(
        "INVALID_PARAMS",
        "Expected User Scope to contain exactly kind and userId",
      );
    }
    if (typeof value.userId !== "string" || value.userId.length === 0 || value.userId.length > 200) {
      throw new ProtocolValidationError(
        "INVALID_PARAMS",
        "Expected User Scope to contain a non-empty userId up to 200 characters",
      );
    }
    return;
  }
  if (value.kind === "project") {
    if (keys.length !== 2 || keys[0] !== "kind" || keys[1] !== "projectId") {
      throw new ProtocolValidationError(
        "INVALID_PARAMS",
        "Expected Project Scope to contain exactly kind and projectId",
      );
    }
    if (typeof value.projectId !== "string" || value.projectId.length === 0 || value.projectId.length > 200) {
      throw new ProtocolValidationError(
        "INVALID_PARAMS",
        "Expected Project Scope to contain a non-empty projectId up to 200 characters",
      );
    }
    return;
  }
  throw new ProtocolValidationError(
    "INVALID_PARAMS",
    'Expected params.scope.kind to be "user" or "project"',
  );
}

function validateTaskContextSources(params: Record<string, unknown>): void {
  const sources = params.sources;
  if (!Array.isArray(sources) || sources.length > 32) {
    throw new ProtocolValidationError("INVALID_PARAMS", "Expected params.sources to contain at most 32 Context Sources");
  }
  for (const [index, value] of sources.entries()) {
    if (!isRecord(value)) {
      throw new ProtocolValidationError("INVALID_PARAMS", `Expected params.sources[${index}] to be an object`);
    }
    const kind = value.kind;
    const allowedKeys = kind === "scope_document"
      ? ["kind", "relativePath", "title"]
      : kind === "global_knowledge"
        ? ["kind", "rootPath", "relativePath", "title"]
        : undefined;
    if (!allowedKeys || Object.keys(value).some((key) => !allowedKeys.includes(key))) {
      throw new ProtocolValidationError("INVALID_PARAMS", `params.sources[${index}] has an invalid Context Source shape`);
    }
    if (typeof value.relativePath !== "string" || value.relativePath.length === 0 || value.relativePath.length > 4_096) {
      throw new ProtocolValidationError("INVALID_PARAMS", `params.sources[${index}].relativePath is invalid`);
    }
    if (value.title !== undefined && (typeof value.title !== "string" || value.title.length === 0 || value.title.length > 200)) {
      throw new ProtocolValidationError("INVALID_PARAMS", `params.sources[${index}].title is invalid`);
    }
    if (kind === "global_knowledge" && (
      typeof value.rootPath !== "string" || value.rootPath.length === 0 || value.rootPath.length > 4_096
    )) {
      throw new ProtocolValidationError("INVALID_PARAMS", `params.sources[${index}].rootPath is invalid`);
    }
  }
}

function validateTaskMutationTarget(params: Record<string, unknown>): void {
  requireBoundedString(params, "requestId", 128);
  requireInteger(params, "expectedStoreRevision", 0, Number.MAX_SAFE_INTEGER);
  validateTaskScope(params);
  requireBoundedString(params, "taskId", 200);
}

function validateTaskPlanState(value: unknown, field: string): void {
  if (!["draft", "active", "paused", "completed", "superseded"].includes(value as string)) {
    throw new ProtocolValidationError("INVALID_PARAMS", `${field} is not a valid Task Plan state`);
  }
}

function validateTaskWorkItemState(value: unknown, field: string): void {
  if (!["pending", "in_progress", "completed", "blocked", "cancelled"].includes(value as string)) {
    throw new ProtocolValidationError("INVALID_PARAMS", `${field} is not a valid Work Item state`);
  }
}

function validateOptionalOwnerAssignment(params: Record<string, unknown>): void {
  const owner = params.ownerAssignmentId;
  if (owner !== undefined && owner !== null) requireBoundedString(params, "ownerAssignmentId", 200);
}

function validateRuntimeOpenIdentity(params: Record<string, unknown>): void {
  if (params.runtimeId === undefined) return;
  const runtimeId = requireBoundedString(params, "runtimeId", 128);
  if (!runtimeId.trim()) throw new ProtocolValidationError("INVALID_PARAMS", "runtimeId cannot be whitespace");
  requireBoundedString(params, "taskId", 200);
  requireBoundedString(params, "dcodeSessionId", 200);
  if (params.agentRunId !== undefined) requireBoundedString(params, "agentRunId", 200);
  const adapterSessionId = requireBoundedString(params, "adapterSessionId", 200);
  if (adapterSessionId !== params.sessionId) {
    throw new ProtocolValidationError("INVALID_PARAMS", "adapterSessionId must match params.sessionId");
  }
  validateTaskScope(params);
  if (!isRecord(params.workspace)) {
    throw new ProtocolValidationError("INVALID_PARAMS", "Expected params.workspace to be an object");
  }
  const workspace = params.workspace;
  const keys = Object.keys(workspace).sort();
  if (
    keys.length !== 3
    || keys[0] !== "access"
    || keys[1] !== "cwd"
    || keys[2] !== "workspaceId"
    || typeof workspace.workspaceId !== "string"
    || workspace.workspaceId.length === 0
    || workspace.workspaceId.length > 200
    || typeof workspace.cwd !== "string"
    || workspace.cwd.length === 0
    || workspace.cwd.length > 4_096
    || (workspace.access !== "sharedReadOnly" && workspace.access !== "exclusiveWrite")
  ) {
    throw new ProtocolValidationError("INVALID_PARAMS", "Runtime workspace identity is invalid");
  }
}

function validateRuntimeStart(params: Record<string, unknown>): void {
  requireBoundedString(params, "requestId", 128);
  requireBoundedString(params, "runtimeId", 128);
  requireBoundedString(params, "taskId", 200);
  requireBoundedString(params, "dcodeSessionId", 200);
  if (params.agentRunId !== undefined) requireBoundedString(params, "agentRunId", 200);
  validateTaskScope(params);
  if (!isRecord(params.workspace)) {
    throw new ProtocolValidationError("INVALID_PARAMS", "Expected params.workspace to be an object");
  }
  const workspace = params.workspace;
  const keys = Object.keys(workspace).sort();
  if (
    keys.length !== 3
    || keys[0] !== "access"
    || keys[1] !== "cwd"
    || keys[2] !== "workspaceId"
    || typeof workspace.workspaceId !== "string"
    || workspace.workspaceId.length === 0
    || typeof workspace.cwd !== "string"
    || workspace.cwd.length === 0
    || (workspace.access !== "sharedReadOnly" && workspace.access !== "exclusiveWrite")
  ) {
    throw new ProtocolValidationError("INVALID_PARAMS", "runtime.start workspace access is invalid");
  }
}

function optionalCwdScope(params: Record<string, unknown>): void {
  const value = params.cwdScope;
  if (value === undefined) return;
  if (!isRecord(value)) {
    throw new ProtocolValidationError("INVALID_PARAMS", "Expected params.cwdScope to be an object");
  }
  if (value.match !== "exact" && value.match !== "descendantOrEqual") {
    throw new ProtocolValidationError(
      "INVALID_PARAMS",
      'Expected params.cwdScope.match to be "exact" or "descendantOrEqual"',
    );
  }
  if (!Array.isArray(value.paths) || value.paths.length === 0 || value.paths.length > 64) {
    throw new ProtocolValidationError(
      "INVALID_PARAMS",
      "Expected params.cwdScope.paths to contain between 1 and 64 paths",
    );
  }
  for (const path of value.paths) {
    if (typeof path !== "string" || path.length === 0 || path.length > 4_096) {
      throw new ProtocolValidationError(
        "INVALID_PARAMS",
        "Expected every params.cwdScope.paths item to be a non-empty string up to 4096 characters",
      );
    }
  }
}

function optionalSessionOrigin(params: Record<string, unknown>): void {
  const value = params.origin;
  if (value !== undefined && value !== "dcode") {
    throw new ProtocolValidationError("INVALID_PARAMS", 'Expected params.origin to be "dcode"');
  }
}

function requireCwd(params: Record<string, unknown>): string {
  const cwd = requireString(params, "cwd");
  if (cwd.length > 4_096) {
    throw new ProtocolValidationError(
      "INVALID_PARAMS",
      "Expected params.cwd to be a non-empty string up to 4096 characters",
    );
  }
  return cwd;
}

function requireModelPatterns(params: Record<string, unknown>): string[] {
  const value = params.enabledModels;
  if (!Array.isArray(value) || value.length > 256) {
    throw new ProtocolValidationError(
      "INVALID_PARAMS",
      "Expected params.enabledModels to be an array containing at most 256 patterns",
    );
  }
  for (const pattern of value) {
    if (typeof pattern !== "string" || pattern.trim().length === 0 || pattern.length > 512) {
      throw new ProtocolValidationError(
        "INVALID_PARAMS",
        "Expected every params.enabledModels item to be non-empty and at most 512 characters",
      );
    }
  }
  return value;
}

function requireModelIdentifier(params: Record<string, unknown>, key: string): string {
  const value = requireString(params, key);
  if (value.trim().length === 0 || value.length > 512) {
    throw new ProtocolValidationError(
      "INVALID_PARAMS",
      `Expected params.${key} to be non-empty and at most 512 characters`,
    );
  }
  return value;
}

export function isHostMethod(method: string): method is HostMethod {
  return (HOST_METHODS as readonly string[]).includes(method);
}

export function parseRequest(value: unknown): HostRequest {
  if (!isRecord(value)) {
    throw new ProtocolValidationError("INVALID_REQUEST", "Request must be an object");
  }
  if (value.version !== PROTOCOL_VERSION) {
    throw new ProtocolValidationError(
      "UNSUPPORTED_VERSION",
      `Expected protocol version ${PROTOCOL_VERSION}`,
      { received: value.version },
    );
  }
  if (value.type !== "request") {
    throw new ProtocolValidationError("INVALID_REQUEST", 'Expected type="request"');
  }
  if (typeof value.id !== "string" || value.id.length === 0 || value.id.length > 128) {
    throw new ProtocolValidationError("INVALID_REQUEST", "Request id must be a non-empty string up to 128 characters");
  }
  if (typeof value.method !== "string" || value.method.length === 0 || value.method.length > 128) {
    throw new ProtocolValidationError("INVALID_REQUEST", "Request method must be a non-empty string up to 128 characters");
  }
  const params = value.params === undefined ? {} : value.params;
  if (!isRecord(params)) {
    throw new ProtocolValidationError("INVALID_PARAMS", "Request params must be an object");
  }
  return {
    version: PROTOCOL_VERSION,
    type: "request",
    id: value.id,
    method: value.method,
    params,
  };
}

export function validateMethodParams(method: HostMethod, params: Record<string, unknown>): void {
  if (params.runtimeId !== undefined) requireBoundedString(params, "runtimeId", 128);
  switch (method) {
    case "host.hello":
    case "runtime.list":
    case "session.abort":
    case "session.getState":
    case "session.contextBreakdown":
    case "session.getCommands":
    case "resources.list":
    case "session.compactionInfo":
    case "session.compact":
    case "modelProviders.list":
    case "session.getThinkingLevels":
    case "session.refresh":
    case "host.shutdown":
      return;
    case "runtime.start":
      validateRuntimeStart(params);
      return;
    case "foundation.snapshot":
      optionalInteger(params, "afterEventSequence", 0, Number.MAX_SAFE_INTEGER);
      return;
    case "selfEvolution.list": return;
    case "selfEvolution.prepare":
      requireBoundedString(params,"requestId",128); requireInteger(params,"expectedStoreRevision",0,Number.MAX_SAFE_INTEGER);
      for(const key of ["fromApp","toApp","fromDigest","toDigest"])requireBoundedString(params,key,4096);
      if(params.rollbackOf!==undefined)requireBoundedString(params,"rollbackOf",200);
      return;
    case "selfEvolution.transition":
      requireBoundedString(params,"requestId",128); requireInteger(params,"expectedStoreRevision",0,Number.MAX_SAFE_INTEGER);requireBoundedString(params,"id",200);
      if(!["session_restored","manual_accepted","recovery_required","rolled_back","cancelled"].includes(params.state as string))throw new ProtocolValidationError("INVALID_PARAMS","Invalid evolution state");
      return;
    case "maintenance.status": return;
    case "maintenance.start":
      requireBoundedString(params,"sourceDirectory",4096);
      if (params.action !== "verify" && params.action !== "build") throw new ProtocolValidationError("INVALID_PARAMS","Invalid maintenance action");
      return;
    case "clientPreferences.importLegacy":
      requireBoundedString(params,"requestId",128);requireInteger(params,"expectedStoreRevision",0,Number.MAX_SAFE_INTEGER);
      if(!isRecord(params.values))throw new ProtocolValidationError("INVALID_PARAMS","Legacy preferences required");
      return;
    case "clientPreferences.get":
      return;
    case "clientPreferences.set": {
      requireBoundedString(params, "requestId", 128);
      requireInteger(params, "expectedStoreRevision", 0, Number.MAX_SAFE_INTEGER);
      if (params.notificationsEnabled !== undefined && typeof params.notificationsEnabled !== "boolean") throw new ProtocolValidationError("INVALID_PARAMS", "notificationsEnabled must be boolean");
      if (params.readingPosition !== undefined) {
        if (!isRecord(params.readingPosition)) throw new ProtocolValidationError("INVALID_PARAMS", "readingPosition must be an object");
        requireBoundedString(params.readingPosition, "sessionId", 200);
        requireInteger(params.readingPosition, "offset", 0, 100_000_000);
      }
      const keys = ["notificationsEnabled", "readingPosition", "appearance", "fontScale", "sidebarVisible", "overviewVisible", "sidebarWidth", "inspectorWidth", "defaultThinking", "enabledModels", "disabledResources"];
      if (!keys.some(key => params[key] !== undefined)) throw new ProtocolValidationError("INVALID_PARAMS", "Preference change required");

      return;
    }
    case "attachment.import": {
      requireBoundedString(params,"requestId",128);
      requireInteger(params,"expectedStoreRevision",0,Number.MAX_SAFE_INTEGER);
      requireBoundedString(params,"draftKey",220);
      const source=params.source;
      if(!source||typeof source!=="object"||Array.isArray(source))throw new ProtocolValidationError("INVALID_PARAMS","Expected attachment source");
      const value=source as Record<string,unknown>;
      if(typeof value.path === "string") {requireBoundedString(value,"path",4096);if(!value.path.startsWith("/"))throw new ProtocolValidationError("INVALID_PARAMS","Expected absolute file path");if(value.data!==undefined)throw new ProtocolValidationError("INVALID_PARAMS","Expected one attachment source");}
      else {requireBoundedString(value,"name",200);requireBoundedString(value,"mimeType",100);const data=requireBoundedString(value,"data",7_000_000);if(!/^[A-Za-z0-9+/]*={0,2}$/.test(data)||data.length%4!==0)throw new ProtocolValidationError("INVALID_PARAMS","Invalid image data");}
      return;
    }
    case "attachment.get":
    case "attachment.resolve":
      requireBoundedString(params,"id",80);
      if(!/^attachment-[a-f0-9]{32}$/.test(params.id as string))throw new ProtocolValidationError("INVALID_PARAMS","Invalid attachment id");
      return;
    case "taskDraft.set": {
      if(params.attachmentIds!==undefined)requireStringArray(params,"attachmentIds",32,true);
      requireBoundedString(params, "requestId", 128);
      requireInteger(params, "expectedStoreRevision", 0, Number.MAX_SAFE_INTEGER);
      validateTaskScope(params);
      const text = requireString(params, "text", { allowEmpty: true });
      if (text.length > 200_000) throw new ProtocolValidationError("INVALID_PARAMS", "Task draft exceeds 200000 characters");
      return;
    }
    case "dcodeModelProvider.save":
      requireBoundedString(params, "requestId", 128);
      requireInteger(params, "expectedStoreRevision", 0, Number.MAX_SAFE_INTEGER);
      if (!isRecord(params.provider)) throw new ProtocolValidationError("INVALID_PARAMS", "Provider configuration required");
      return;
    case "dcodeModelProvider.remove":
      requireBoundedString(params, "requestId", 128);
      requireInteger(params, "expectedStoreRevision", 0, Number.MAX_SAFE_INTEGER);
      requireBoundedString(params, "providerId", 200);
      return;
    case "runtimeModelSelection.set":
      requireBoundedString(params, "requestId", 128);
      requireInteger(params, "expectedStoreRevision", 0, Number.MAX_SAFE_INTEGER);
      requireModelIdentifier(params, "providerId");
      requireModelIdentifier(params, "modelId");
      return;
    case "taskWorkbenchViewState.patch": {
      requireBoundedString(params, "requestId", 128);
      requireInteger(params, "expectedStoreRevision", 0, Number.MAX_SAFE_INTEGER);
      requireInteger(params, "expectedViewStateRevision", 0, Number.MAX_SAFE_INTEGER);
      if (!isRecord(params.patch) || Object.keys(params.patch).length === 0) {
        throw new ProtocolValidationError("INVALID_PARAMS", "Expected params.patch to contain a Task Workbench state change");
      }
      const patch = params.patch;
      if (patch.selection !== undefined) {
        if (!isRecord(patch.selection) || Object.keys(patch.selection).length !== 2) {
          throw new ProtocolValidationError("INVALID_PARAMS", "Expected params.patch.selection to contain taskId and sessionId");
        }
        for (const key of ["taskId", "sessionId"] as const) {
          const value = patch.selection[key];
          if (value !== null && (typeof value !== "string" || value.length === 0 || value.length > 200)) {
            throw new ProtocolValidationError("INVALID_PARAMS", `Expected params.patch.selection.${key} to be a non-empty string or null`);
          }
        }
        if ((patch.selection.taskId === null) !== (patch.selection.sessionId === null)) {
          throw new ProtocolValidationError("INVALID_PARAMS", "Expected params.patch.selection to contain both identities or neither");
        }
      }
      if (patch.expandedHudSections !== undefined) requireStringArray(patch, "expandedHudSections", 4);
      if (patch.inspectorTarget !== undefined && patch.inspectorTarget !== null) {
        if (!isRecord(patch.inspectorTarget)) {
          throw new ProtocolValidationError("INVALID_PARAMS", "Expected params.patch.inspectorTarget to be an object or null");
        }
        const target = patch.inspectorTarget;
        if (
          Object.keys(target).length !== 2
          || !["artifact", "evidence", "report", "context"].includes(target.kind as string)
          || typeof target.id !== "string"
          || target.id.length === 0
          || target.id.length > 200
        ) {
          throw new ProtocolValidationError("INVALID_PARAMS", "Expected params.patch.inspectorTarget to contain kind and id");
        }
      }
      if (patch.workspaceContent !== undefined && patch.workspaceContent !== null) {
        if (!isRecord(patch.workspaceContent)) {
          throw new ProtocolValidationError("INVALID_PARAMS", "Expected params.patch.workspaceContent to be an object or null");
        }
        const content = patch.workspaceContent;
        const allowed = new Set(["kind", "id", "sourceRevision", "anchorLine"]);
        if (
          Object.keys(content).some((key) => !allowed.has(key))
          || !["artifact", "report"].includes(content.kind as string)
          || typeof content.id !== "string"
          || content.id.length === 0
          || content.id.length > 200
          || (content.sourceRevision !== undefined && (!Number.isInteger(content.sourceRevision) || (content.sourceRevision as number) < 1))
          || (content.anchorLine !== undefined && (!Number.isInteger(content.anchorLine) || (content.anchorLine as number) < 1))
          || (content.kind !== "artifact" && content.sourceRevision !== undefined)
        ) {
          throw new ProtocolValidationError("INVALID_PARAMS", "Expected params.patch.workspaceContent to contain a valid content identity");
        }
      }
      return;
    }
    case "dcodeSession.copy":
      requireBoundedString(params,"requestId",128);
      requireInteger(params,"expectedStoreRevision",0,Number.MAX_SAFE_INTEGER);
      requireBoundedString(params,"dcodeSessionId",200);
      return;
    case "dcodeSession.presentation":
      requireBoundedString(params, "dcodeSessionId", 200);
      return;
    case "dcodeSession.composerDraft.set": {
      if(params.attachmentIds!==undefined)requireStringArray(params,"attachmentIds",32,true);
      requireBoundedString(params, "requestId", 128);
      requireInteger(params, "expectedStoreRevision", 0, Number.MAX_SAFE_INTEGER);
      requireBoundedString(params, "taskId", 200);
      requireBoundedString(params, "dcodeSessionId", 200);
      const draft = requireString(params, "text", { allowEmpty: true });
      if (draft.length > 200_000) {
        throw new ProtocolValidationError("INVALID_PARAMS", "Expected params.text to be at most 200000 characters");
      }
      return;
    }
    case "dcodeSession.prompt": {
      requireBoundedString(params, "dcodeSessionId", 200);
      const message = requireString(params, "message", { allowEmpty: true });
      if(params.attachmentIds!==undefined)requireStringArray(params,"attachmentIds",32,true);
      if (message.trim().length === 0 && !(Array.isArray(params.attachmentIds)&&params.attachmentIds.length)) {
        throw new ProtocolValidationError("INVALID_PARAMS", "Expected text or managed attachments");
      }
      const promptId = requireString(params, "promptId");
      if (promptId.length > 128) {
        throw new ProtocolValidationError("INVALID_PARAMS", "Expected params.promptId to be at most 128 characters");
      }
      validatePromptImages(params, "images");
      return;
    }
    case "project.gitBranch":
      requireBoundedString(params, "projectId", 200);
      return;
    case "project.create":
      requireBoundedString(params, "requestId", 128);
      requireInteger(params, "expectedStoreRevision", 0, Number.MAX_SAFE_INTEGER);
      requireBoundedString(params, "title", 200);
      requireBoundedString(params, "directory", 4_096);
      return;
    case "task.manage":
      requireBoundedString(params,"requestId",128);
      requireInteger(params,"expectedStoreRevision",0,Number.MAX_SAFE_INTEGER);
      requireBoundedString(params,"taskId",200);
      if (!["rename","archive","restore","trash"].includes(params.action as string)) throw new ProtocolValidationError("INVALID_PARAMS","Invalid task action");
      if (params.action === "rename") requireBoundedString(params,"title",200);
      return;
    case "task.create":
      requireBoundedString(params, "requestId", 128);
      requireInteger(params, "expectedStoreRevision", 0, Number.MAX_SAFE_INTEGER);
      validateTaskScope(params);
      requireBoundedString(params, "title", 200);
      requireBoundedString(params, "goal", 4_000);
      requireStringArray(params, "acceptance", 100, true);
      return;
    case "task.context.replace":
      requireBoundedString(params, "requestId", 128);
      requireInteger(params, "expectedStoreRevision", 0, Number.MAX_SAFE_INTEGER);
      validateTaskScope(params);
      requireBoundedString(params, "taskId", 200);
      requireInteger(params, "expectedContextRevision", 1, Number.MAX_SAFE_INTEGER);
      validateTaskContextSources(params);
      return;
    case "task.plan.create":
      validateTaskMutationTarget(params);
      if (params.state !== undefined) validateTaskPlanState(params.state, "params.state");
      if (!isRecord(params.document)) {
        throw new ProtocolValidationError("INVALID_PARAMS", "params.document must be a structured Plan object");
      }
      return;
    case "task.plan.update":
      validateTaskMutationTarget(params);
      requireBoundedString(params, "planId", 200);
      requireInteger(params, "expectedPlanRevision", 1, Number.MAX_SAFE_INTEGER);
      validateTaskPlanState(params.state, "params.state");
      if (!isRecord(params.document)) {
        throw new ProtocolValidationError("INVALID_PARAMS", "params.document must be a structured Plan object");
      }
      return;
    case "task.workItem.create":
      validateTaskMutationTarget(params);
      requireBoundedString(params, "title", 500);
      if (params.state !== undefined) validateTaskWorkItemState(params.state, "params.state");
      validateOptionalOwnerAssignment(params);
      return;
    case "task.workItem.update":
      validateTaskMutationTarget(params);
      requireBoundedString(params, "workItemId", 200);
      requireInteger(params, "expectedWorkItemRevision", 1, Number.MAX_SAFE_INTEGER);
      if (params.title !== undefined) requireBoundedString(params, "title", 500);
      if (params.state !== undefined) validateTaskWorkItemState(params.state, "params.state");
      validateOptionalOwnerAssignment(params);
      if (params.title === undefined && params.state === undefined && params.ownerAssignmentId === undefined && params.details === undefined) {
        throw new ProtocolValidationError("INVALID_PARAMS", "Task Work Item update needs at least one mutable field");
      }
      return;
    case "task.workItem.reorder":
      validateTaskMutationTarget(params);
      if (!Array.isArray(params.items) || params.items.length > 200) {
        throw new ProtocolValidationError("INVALID_PARAMS", "params.items must contain at most 200 Work Item identities");
      }
      for (const [index, item] of params.items.entries()) {
        if (
          !isRecord(item)
          || Object.keys(item).length !== 2
          || typeof item.id !== "string"
          || item.id.length === 0
          || typeof item.expectedRevision !== "number"
          || !Number.isInteger(item.expectedRevision)
          || item.expectedRevision < 1
        ) {
          throw new ProtocolValidationError("INVALID_PARAMS", `params.items[${index}] must contain id and expectedRevision`);
        }
      }
      return;
    case "task.acceptance":
      requireBoundedString(params, "requestId", 128);
      requireInteger(params, "expectedStoreRevision", 0, Number.MAX_SAFE_INTEGER);
      validateTaskScope(params);
      requireBoundedString(params, "taskId", 200);
      requireInteger(params, "expectedTaskRevision", 1, Number.MAX_SAFE_INTEGER);
      requireBoundedString(params, "runtimeId", 128);
      {
        const teamRunId = optionalString(params, "teamRunId");
        if (teamRunId !== undefined && (teamRunId.length === 0 || teamRunId.length > 200)) {
          throw new ProtocolValidationError("INVALID_PARAMS", "Expected params.teamRunId to be a non-empty string up to 200 characters");
        }
      }
      requireBoundedString(params, "agentRunId", 200);
      requireBoundedString(params, "sessionRunId", 200);
      requireBoundedString(params, "agentRequestId", 200);
      requireInteger(params, "expectedRequestRevision", 1, Number.MAX_SAFE_INTEGER);
      if (params.feedback !== undefined) {
        const feedback = requireString(params, "feedback", { allowEmpty: true });
        if (feedback.length > 20_000) {
          throw new ProtocolValidationError("INVALID_PARAMS", "params.feedback exceeds the maximum length of 20000");
        }
      }
      if (params.decision !== undefined) {
        throw new ProtocolValidationError(
          "INVALID_PARAMS",
          "Task acceptance is bound to an acceptance request; legacy decision is not accepted",
        );
      }
      return;
    case "team.create": {
      requireBoundedString(params, "requestId", 128);
      requireInteger(params, "expectedStoreRevision", 0, Number.MAX_SAFE_INTEGER);
      validateTaskScope(params);
      requireBoundedString(params, "taskId", 200);
      if (!Array.isArray(params.members) || params.members.length < 1 || params.members.length > 8) {
        throw new ProtocolValidationError("INVALID_PARAMS", "Expected params.members to contain 1...8 members");
      }
      for (const member of params.members) {
        if (!isRecord(member) || !isRecord(member.taskPacket)) {
          throw new ProtocolValidationError("INVALID_PARAMS", "Team member shape is invalid");
        }
        const keys = Object.keys(member).sort();
        if (
          keys.length !== 3
          || keys[0] !== "profileId"
          || keys[1] !== "taskPacket"
          || keys[2] !== "title"
          || typeof member.profileId !== "string"
          || member.profileId.length === 0
          || typeof member.title !== "string"
          || member.title.trim().length === 0
        ) {
          throw new ProtocolValidationError("INVALID_PARAMS", "Team member identity is invalid");
        }
      }
      return;
    }
    case "team.start":
      requireBoundedString(params, "requestId", 128);
      requireInteger(params, "expectedStoreRevision", 0, Number.MAX_SAFE_INTEGER);
      requireInteger(params, "expectedTeamRunRevision", 1, Number.MAX_SAFE_INTEGER);
      validateTaskScope(params);
      requireBoundedString(params, "taskId", 200);
      requireBoundedString(params, "teamRunId", 200);
      requireBoundedString(params, "message", 200_000);
      if (params.workspace !== undefined) {
        throw new ProtocolValidationError("INVALID_PARAMS", "team.start workspace is derived by the D Code Host");
      }
      return;
    case "agentRequest.answer": {
      requireBoundedString(params, "requestId", 128);
      requireInteger(params, "expectedStoreRevision", 0, Number.MAX_SAFE_INTEGER);
      requireBoundedString(params, "runtimeId", 128);
      validateTaskScope(params);
      requireBoundedString(params, "taskId", 200);
      {
        const teamRunId = optionalString(params, "teamRunId");
        if (teamRunId !== undefined && (teamRunId.length === 0 || teamRunId.length > 200)) {
          throw new ProtocolValidationError("INVALID_PARAMS", "Expected params.teamRunId to be a non-empty string up to 200 characters");
        }
      }
      requireBoundedString(params, "agentRunId", 200);
      requireBoundedString(params, "sessionRunId", 200);
      requireBoundedString(params, "agentRequestId", 200);
      requireInteger(params, "expectedRequestRevision", 1, Number.MAX_SAFE_INTEGER);
      if (!isRecord(params.answer)) {
        throw new ProtocolValidationError("INVALID_PARAMS", "Expected params.answer to be a choice object");
      }
      const answerKeys = Object.keys(params.answer).sort();
      if (
        answerKeys.length !== 2
        || answerKeys[0] !== "kind"
        || answerKeys[1] !== "optionId"
        || params.answer.kind !== "choice"
        || typeof params.answer.optionId !== "string"
        || params.answer.optionId.length === 0
        || params.answer.optionId.length > 100
      ) {
        throw new ProtocolValidationError("INVALID_PARAMS", "Agent Request answer is invalid");
      }
      return;
    }
    case "agentRun.stop":
      requireBoundedString(params, "requestId", 128);
      requireInteger(params, "expectedStoreRevision", 0, Number.MAX_SAFE_INTEGER);
      requireBoundedString(params, "runtimeId", 128);
      validateTaskScope(params);
      requireBoundedString(params, "taskId", 200);
      {
        const teamRunId = optionalString(params, "teamRunId");
        if (teamRunId !== undefined && (teamRunId.length === 0 || teamRunId.length > 200)) {
          throw new ProtocolValidationError("INVALID_PARAMS", "Expected params.teamRunId to be a non-empty string up to 200 characters");
        }
      }
      requireBoundedString(params, "agentRunId", 200);
      requireBoundedString(params, "sessionRunId", 200);
      requireInteger(params, "expectedAgentRunRevision", 1, Number.MAX_SAFE_INTEGER);
      return;
    case "agentProfile.update":
      requireBoundedString(params, "requestId", 128);
      requireInteger(params, "expectedStoreRevision", 0, Number.MAX_SAFE_INTEGER);
      requireBoundedString(params, "profileId", 200);
      requireInteger(params, "expectedProfileRevision", 0, Number.MAX_SAFE_INTEGER);
      requireBoundedString(params, "name", 200);
      requireBoundedString(params, "roleContract", 20_000);
      if (typeof params.enabled !== "boolean") {
        throw new ProtocolValidationError("INVALID_PARAMS", "Expected params.enabled to be a boolean");
      }
      return;
    case "agentProfile.create":
      requireBoundedString(params, "requestId", 128);
      requireInteger(params, "expectedStoreRevision", 0, Number.MAX_SAFE_INTEGER);
      requireBoundedString(params, "name", 200);
      requireBoundedString(params, "roleContract", 20_000);
      if (typeof params.enabled !== "boolean") {
        throw new ProtocolValidationError("INVALID_PARAMS", "Expected params.enabled to be a boolean");
      }
      return;
    case "piImport.listCandidates":
      optionalInteger(params, "limit", 1, 1_000);
      return;
    case "piImport.preview":
      requireBoundedString(params, "sourceSessionId", 200);
      return;
    case "piImport.importAsTask":
      requireBoundedString(params, "requestId", 128);
      requireInteger(params, "expectedStoreRevision", 0, Number.MAX_SAFE_INTEGER);
      validateTaskScope(params);
      requireBoundedString(params, "sourceSessionId", 200);
      return;
    case "session.importedEntries":
      requireBoundedString(params, "sessionId", 200);
      return;
    case "modelProviders.save": {
      const provider = params.provider;
      if (typeof provider !== "object" || provider === null || Array.isArray(provider)) {
        throw new ProtocolValidationError("INVALID_PARAMS", "Expected params.provider to be an object");
      }
      return;
    }
    case "modelProviders.remove": {
      const id = optionalString(params, "id");
      if (id === undefined || id.length === 0) {
        throw new ProtocolValidationError("INVALID_PARAMS", "Expected params.id to be a non-empty string");
      }
      return;
    }
    case "resources.setPackageEnabled": {
      const source = optionalString(params, "source");
      if (source === undefined || source.length === 0) {
        throw new ProtocolValidationError("INVALID_PARAMS", "Expected params.source to be a non-empty string");
      }
      if (typeof params.enabled !== "boolean") {
        throw new ProtocolValidationError("INVALID_PARAMS", "Expected params.enabled to be a boolean");
      }
      return;
    }
    case "session.getModels": {
      const cwd = optionalString(params, "cwd");
      if (cwd !== undefined && (cwd.length === 0 || cwd.length > 4_096)) {
        throw new ProtocolValidationError(
          "INVALID_PARAMS",
          "Expected params.cwd to be a non-empty string up to 4096 characters",
        );
      }
      return;
    }
    case "dcodeModels.get":
    case "dcodeModels.refresh":
      if (params.dcodeSessionId !== undefined) requireBoundedString(params,"dcodeSessionId",200);
      if (params.force !== undefined && typeof params.force !== "boolean") throw new ProtocolValidationError("INVALID_PARAMS","force must be boolean");
      return;
    case "dcodeModels.select":
    case "dcodeModels.setThinking":
      requireBoundedString(params,"requestId",128);
      requireInteger(params,"expectedStoreRevision",0,Number.MAX_SAFE_INTEGER);
      if (params.dcodeSessionId !== undefined) requireBoundedString(params,"dcodeSessionId",200);
      if(method === "dcodeModels.select") { requireModelIdentifier(params,"providerId"); requireModelIdentifier(params,"modelId"); }
      else requireBoundedString(params,"level",30);
      return;
    case "modelSettings.get":
    case "modelSettings.refresh":
      requireCwd(params);
      return;
    case "modelSettings.setEnabledModels":
      requireCwd(params);
      requireModelPatterns(params);
      return;
    case "modelSettings.setDefaultModel":
      requireCwd(params);
      requireModelIdentifier(params, "provider");
      requireModelIdentifier(params, "modelId");
      return;
    case "session.close": {
      const expectedSessionId = optionalString(params, "expectedSessionId");
      if (expectedSessionId !== undefined && (expectedSessionId.length === 0 || expectedSessionId.length > 4_096)) {
        throw new ProtocolValidationError(
          "INVALID_PARAMS",
          "Expected params.expectedSessionId to be a non-empty string up to 4096 characters",
        );
      }
      return;
    }
    case "session.list":
      optionalString(params, "query");
      optionalInteger(params, "limit", 1, 10_000);
      optionalCwdScope(params);
      optionalSessionOrigin(params);
      requireStringArray(params, "sessionIds", 10_000, true);
      requireStringArray(params, "excludedSessionIds", 10_000, true);
      return;
    case "session.search": {
      const query = requireString(params, "query", { allowEmpty: true });
      if (query.length > 512) {
        throw new ProtocolValidationError("INVALID_PARAMS", "Expected params.query to be at most 512 characters");
      }
      const requestToken = requireString(params, "requestToken");
      if (requestToken.length > 128) {
        throw new ProtocolValidationError("INVALID_PARAMS", "Expected params.requestToken to be at most 128 characters");
      }
      optionalInteger(params, "limit", 1, 100);
      const projectSourceFolders = requireStringArray(params, "projectSourceFolders", 1_024) ?? [];
      const filterSourceFolders = requireStringArray(params, "filterSourceFolders", 1_024, true);
      requireStringArray(params, "excludedSessionIds", 10_000, true);
      if (filterSourceFolders) {
        const projectSet = new Set(projectSourceFolders);
        if (filterSourceFolders.some((path) => !projectSet.has(path))) {
          throw new ProtocolValidationError(
            "INVALID_PARAMS",
            "Expected params.filterSourceFolders to be a subset of params.projectSourceFolders",
          );
        }
      }
      if (params.refresh !== undefined && typeof params.refresh !== "boolean") {
        throw new ProtocolValidationError("INVALID_PARAMS", "Expected params.refresh to be a boolean");
      }
      if (params.probe !== undefined && typeof params.probe !== "boolean") {
        throw new ProtocolValidationError("INVALID_PARAMS", "Expected params.probe to be a boolean");
      }
      return;
    }
    case "session.inspect":
      requireString(params, "sessionId");
      if (params.pathId !== undefined) {
        const pathId = requireString(params, "pathId");
        if (pathId.length > 160) {
          throw new ProtocolValidationError("INVALID_PARAMS", "Expected params.pathId to be at most 160 characters");
        }
      }
      return;
    case "session.create":
      requireString(params, "cwd");
      return;
    case "session.copy":
      requireString(params, "sessionId");
      requireString(params, "targetCwd");
      return;
    case "session.relocateCwd":
      requireString(params, "sourceCwd");
      requireString(params, "targetCwd");
      if (typeof params.moveFiles !== "boolean") {
        throw new ProtocolValidationError("INVALID_PARAMS", "Expected params.moveFiles to be a boolean");
      }
      return;
    case "session.trash":
      requireString(params, "sessionId");
      return;
    case "session.repair":
      requireString(params, "sessionId");
      return;
    case "session.open": {
      requireString(params, "sessionId");
      validateRuntimeOpenIdentity(params);
      const expectedEntryId = optionalString(params, "expectedEntryId");
      if (expectedEntryId !== undefined && (expectedEntryId.length === 0 || expectedEntryId.length > 128)) {
        throw new ProtocolValidationError(
          "INVALID_PARAMS",
          "Expected params.expectedEntryId to be a non-empty string up to 128 characters",
        );
      }
      const expectedEntryDigest = optionalString(params, "expectedEntryDigest");
      if (expectedEntryDigest !== undefined && !/^v1:[a-f0-9]{64}$/.test(expectedEntryDigest)) {
        throw new ProtocolValidationError(
          "INVALID_PARAMS",
          "Expected params.expectedEntryDigest to be a v1 SHA-256 digest",
        );
      }
      if (expectedEntryDigest !== undefined && expectedEntryId === undefined) {
        throw new ProtocolValidationError(
          "INVALID_PARAMS",
          "params.expectedEntryDigest requires params.expectedEntryId",
        );
      }
      const mode = params.mode;
      if (mode !== undefined && mode !== "readOnly" && mode !== "writable") {
        throw new ProtocolValidationError("INVALID_PARAMS", 'Expected params.mode to be "readOnly" or "writable"');
      }
      if (params.writeIntent !== undefined && typeof params.writeIntent !== "boolean") {
        throw new ProtocolValidationError("INVALID_PARAMS", "Expected params.writeIntent to be a boolean");
      }
      if (params.preserveActive !== undefined && typeof params.preserveActive !== "boolean") {
        throw new ProtocolValidationError("INVALID_PARAMS", "Expected params.preserveActive to be a boolean");
      }
      if (params.pathId !== undefined) {
        const pathId = requireString(params, "pathId");
        if (pathId.length > 160) {
          throw new ProtocolValidationError("INVALID_PARAMS", "Expected params.pathId to be at most 160 characters");
        }
      }
      if (mode === "writable" && params.writeIntent !== true) {
        throw new ProtocolValidationError(
          "INVALID_PARAMS",
          "Writable session.open requires params.writeIntent=true",
        );
      }
      if (mode === "writable" && expectedEntryDigest !== undefined) {
        throw new ProtocolValidationError(
          "INVALID_PARAMS",
          "params.expectedEntryDigest is only valid for read-only search navigation",
        );
      }
      return;
    }
    case "session.prompt": {
      const message = requireString(params, "message", { allowEmpty: true });
      if (message.trim().length === 0 && !(Array.isArray(params.attachmentIds)&&params.attachmentIds.length)) {
        throw new ProtocolValidationError("INVALID_PARAMS", "Expected params.message to contain non-whitespace text");
      }
      if(params.attachmentIds!==undefined)requireStringArray(params,"attachmentIds",32,true);
      const promptId = requireString(params, "promptId");
      if (promptId.length > 128) {
        throw new ProtocolValidationError("INVALID_PARAMS", "Expected params.promptId to be at most 128 characters");
      }
      validatePromptImages(params, "images");
      if (params.streamingBehavior !== undefined) {
        throw new ProtocolValidationError(
          "INVALID_PARAMS",
          "Queued streaming prompts are not part of D Code Protocol v1",
        );
      }
      if (params.pathAction !== undefined) {
        if (!isRecord(params.pathAction)) {
          throw new ProtocolValidationError("INVALID_PARAMS", "Expected params.pathAction to be an object");
        }
        const kind = params.pathAction.kind;
        if (kind !== "editUser" && kind !== "continueAssistant" && kind !== "continuePath") {
          throw new ProtocolValidationError(
            "INVALID_PARAMS",
            'Expected params.pathAction.kind to be "editUser", "continueAssistant", or "continuePath"',
          );
        }
        const entryId = params.pathAction.entryId;
        if (typeof entryId !== "string" || entryId.length === 0 || entryId.length > 128) {
          throw new ProtocolValidationError(
            "INVALID_PARAMS",
            "Expected params.pathAction.entryId to be a non-empty string up to 128 characters",
          );
        }
      }
      return;
    }
    case "session.steer": {
      const message = requireString(params, "message", { allowEmpty: true });
      if (message.trim().length === 0 || message.length > 200_000) {
        throw new ProtocolValidationError(
          "INVALID_PARAMS",
          "Expected params.message to contain non-whitespace text up to 200000 characters",
        );
      }
      if (message.trimStart().startsWith("/")) {
        throw new ProtocolValidationError(
          "INVALID_PARAMS",
          "Slash commands cannot be delivered as steering messages",
        );
      }
      const steerId = requireString(params, "steerId");
      const expectedRunId = requireString(params, "expectedRunId");
      if (steerId.length > 128 || expectedRunId.length > 128) {
        throw new ProtocolValidationError(
          "INVALID_PARAMS",
          "Expected steer and run identifiers to be at most 128 characters",
        );
      }
      validatePromptImages(params, "images");
      return;
    }
    case "modelAuth.start": {
      requireCwd(params);
      const flowId = requireString(params, "flowId");
      if (flowId.length > 128) {
        throw new ProtocolValidationError("INVALID_PARAMS", "Expected params.flowId to be at most 128 characters");
      }
      requireModelIdentifier(params, "provider");
      if (params.authType !== "api_key" && params.authType !== "oauth") {
        throw new ProtocolValidationError(
          "INVALID_PARAMS",
          'Expected params.authType to be "api_key" or "oauth"',
        );
      }
      return;
    }
    case "modelAuth.respond": {
      const flowId = requireString(params, "flowId");
      const requestId = requireString(params, "requestId");
      if (flowId.length > 128 || requestId.length > 128) {
        throw new ProtocolValidationError(
          "INVALID_PARAMS",
          "Expected auth flow and request identifiers to be at most 128 characters",
        );
      }
      if (params.cancelled !== undefined && typeof params.cancelled !== "boolean") {
        throw new ProtocolValidationError("INVALID_PARAMS", "Expected params.cancelled to be a boolean");
      }
      if (params.cancelled !== true) {
        const value = requireString(params, "value", { allowEmpty: true });
        if (value.length > 16_384) {
          throw new ProtocolValidationError("INVALID_PARAMS", "Expected params.value to be at most 16384 characters");
        }
      }
      return;
    }
    case "modelAuth.cancel": {
      const flowId = requireString(params, "flowId");
      if (flowId.length > 128) {
        throw new ProtocolValidationError("INVALID_PARAMS", "Expected params.flowId to be at most 128 characters");
      }
      return;
    }
    case "session.setModel":
      requireString(params, "provider");
      requireString(params, "modelId");
      return;
    case "session.setName": {
      const name = requireString(params, "name", { allowEmpty: true });
      if (name.length > 200 || /[\r\n\0]/u.test(name)) {
        throw new ProtocolValidationError(
          "INVALID_PARAMS",
          "Expected params.name to be a single-line string up to 200 characters",
        );
      }
      return;
    }
    case "session.setThinking": {
      const level = requireString(params, "level");
      const levels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
      if (!levels.has(level)) {
        throw new ProtocolValidationError("INVALID_PARAMS", `Unsupported thinking level: ${level}`);
      }
      return;
    }
    case "session.setFastMode":
      if (typeof params.enabled !== "boolean") {
        throw new ProtocolValidationError("INVALID_PARAMS", "Expected params.enabled to be a boolean");
      }
      return;
    case "content.renderMermaid": {
      const source = requireString(params, "source");
      if (source.length > 100_000) {
        throw new ProtocolValidationError("INVALID_PARAMS", "Expected params.source to be at most 100000 characters");
      }
      return;
    }
    case "extension.respond":
      requireString(params, "requestId");
      if (!("response" in params)) {
        throw new ProtocolValidationError("INVALID_PARAMS", "Expected params.response");
      }
      return;
  }
}

export function successResponse(id: string, method: string, result?: unknown): HostSuccessResponse {
  return result === undefined
    ? { version: PROTOCOL_VERSION, type: "response", id, method, ok: true }
    : { version: PROTOCOL_VERSION, type: "response", id, method, ok: true, result };
}

export function errorResponse(
  id: string,
  method: string,
  code: string,
  message: string,
  details?: unknown,
): HostErrorResponse {
  const error: ProtocolErrorBody = details === undefined ? { code, message } : { code, message, details };
  return { version: PROTOCOL_VERSION, type: "response", id, method, ok: false, error };
}

export function protocolEvent(event: string, data?: unknown): HostEvent {
  return data === undefined
    ? { version: PROTOCOL_VERSION, type: "event", event }
    : { version: PROTOCOL_VERSION, type: "event", event, data };
}
