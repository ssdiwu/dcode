export const PROTOCOL_VERSION = 1 as const;

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

export type HostMessage = HostRequest | HostResponse | HostEvent;

export class ProtocolClientError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ProtocolClientError";
    this.code = code;
    this.details = details;
  }
}
