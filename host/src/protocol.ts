export const PROTOCOL_VERSION = 1 as const;

export const HOST_METHODS = [
  "host.hello",
  "session.list",
  "session.inspect",
  "session.create",
  "session.open",
  "session.close",
  "session.prompt",
  "session.abort",
  "session.getState",
  "session.getCommands",
  "session.getModels",
  "session.getThinkingLevels",
  "session.setModel",
  "session.setThinking",
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
    case "session.close":
    case "session.abort":
    case "session.getState":
    case "session.getCommands":
    case "session.getModels":
    case "session.getThinkingLevels":
    case "host.shutdown":
      return;
    case "session.list":
      optionalString(params, "query");
      optionalInteger(params, "limit", 1, 10_000);
      return;
    case "session.inspect":
      requireString(params, "sessionId");
      return;
    case "session.create":
      requireString(params, "cwd");
      return;
    case "session.open": {
      requireString(params, "sessionId");
      const mode = params.mode;
      if (mode !== undefined && mode !== "readOnly" && mode !== "writable") {
        throw new ProtocolValidationError("INVALID_PARAMS", 'Expected params.mode to be "readOnly" or "writable"');
      }
      if (params.exclusiveUseConfirmed !== undefined && typeof params.exclusiveUseConfirmed !== "boolean") {
        throw new ProtocolValidationError("INVALID_PARAMS", "Expected params.exclusiveUseConfirmed to be a boolean");
      }
      if (mode === "writable" && params.exclusiveUseConfirmed !== true) {
        throw new ProtocolValidationError(
          "INVALID_PARAMS",
          "Writable session.open requires params.exclusiveUseConfirmed=true",
        );
      }
      return;
    }
    case "session.prompt": {
      requireString(params, "message", { allowEmpty: true });
      const behavior = params.streamingBehavior;
      if (behavior !== undefined && behavior !== "steer" && behavior !== "followUp") {
        throw new ProtocolValidationError(
          "INVALID_PARAMS",
          'Expected params.streamingBehavior to be "steer" or "followUp"',
        );
      }
      return;
    }
    case "session.setModel":
      requireString(params, "provider");
      requireString(params, "modelId");
      return;
    case "session.setThinking": {
      const level = requireString(params, "level");
      const levels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
      if (!levels.has(level)) {
        throw new ProtocolValidationError("INVALID_PARAMS", `Unsupported thinking level: ${level}`);
      }
      return;
    }
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
