export const PROTOCOL_VERSION = 1 as const;

export const HOST_METHODS = [
  "host.hello",
  "session.list",
  "session.search",
  "session.inspect",
  "session.refresh",
  "session.create",
  "session.copy",
  "session.trash",
  "session.open",
  "session.close",
  "session.prompt",
  "session.steer",
  "session.abort",
  "session.getState",
  "session.contextBreakdown",
  "permission.respond",
  "permission.list",
  "permission.revoke",
  "session.getCommands",
  "session.getModels",
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
  switch (method) {
    case "host.hello":
    case "session.abort":
    case "session.getState":
    case "session.contextBreakdown":
    case "permission.list":
    case "session.getCommands":
    case "session.getThinkingLevels":
    case "session.refresh":
    case "host.shutdown":
      return;
    case "permission.respond": {
      const requestId = optionalString(params, "requestId");
      const decision = optionalString(params, "decision");
      if (requestId === undefined || decision === undefined
        || !["allowOnce", "allowScope", "deny"].includes(decision)) {
        throw new ProtocolValidationError(
          "INVALID_PARAMS",
          "Expected params.requestId string and params.decision in allowOnce|allowScope|deny",
        );
      }
      return;
    }
    case "permission.revoke": {
      const grantId = optionalString(params, "grantId");
      if (grantId === undefined) {
        throw new ProtocolValidationError("INVALID_PARAMS", "Expected params.grantId string");
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
    case "session.trash":
      requireString(params, "sessionId");
      return;
    case "session.open": {
      requireString(params, "sessionId");
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
      if (message.trim().length === 0) {
        throw new ProtocolValidationError("INVALID_PARAMS", "Expected params.message to contain non-whitespace text");
      }
      const promptId = requireString(params, "promptId");
      if (promptId.length > 128) {
        throw new ProtocolValidationError("INVALID_PARAMS", "Expected params.promptId to be at most 128 characters");
      }
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
