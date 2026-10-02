import { redactCredentialText } from "./credential-material.js";

const secretField = /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|proxy[-_]authorization|x[-_](?:api[-_]?key|auth[-_]?token|access[-_]?token)|cookie|set[-_]cookie|password|client[_-]?secret|credential|secret|token|key|access|refresh)$/iu;

/** Only diagnostics use this stronger field-aware policy. Runtime messages and
 * media retain their separate persistence and transport rules. */
export function redactDiagnosticValue<T>(value: T, field = "", seen = new WeakSet<object>()): T {
  if (value !== undefined && value !== null && secretField.test(field)) return "[REDACTED]" as T;
  if (typeof value === "string") {
    return redactCredentialText(value).text as T;
  }
  if (!value || typeof value !== "object") return value;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return "[Binary omitted]" as T;
  if (value instanceof Date) return value.toISOString() as T;
  if (seen.has(value)) return "[Circular]" as T;
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map(item => redactDiagnosticValue(item, "", seen)) as T;
    if (value instanceof Error) {
      return redactDiagnosticValue({ name: value.name, message: value.message, stack: value.stack }, field, seen) as T;
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      redactCredentialText(key).text,
      redactDiagnosticValue(child, key, seen),
    ])) as T;
  } finally {
    seen.delete(value);
  }
}

/** SDK tool failures can be wrapped as tool_execution_end, toolResult messages,
 * turn_end or agent_end. Only their diagnostic fields receive the stronger
 * policy; media content retains the normal runtime projection. */
export function redactFailedRuntimeDetails<T>(value: T, failed = false): T {
  if (!value || typeof value !== "object" || ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(item => redactFailedRuntimeDetails(item, failed)) as T;
  const record = value as Record<string, unknown>;
  const inFailure = failed || record.isError === true || record.stopReason === "error";
  return Object.fromEntries(Object.entries(record).map(([key, child]) => [
    key,
    inFailure && /^(?:details|error|cause|stack)$/iu.test(key)
      ? redactDiagnosticValue(child)
      : redactFailedRuntimeDetails(child, inFailure),
  ])) as T;
}

export function diagnosticError(error: unknown): { code: string; message: string; details?: unknown } {
  const record = error && typeof error === "object"
    ? error as { code?: unknown; message?: unknown; details?: unknown }
    : undefined;
  const rawCode = typeof record?.code === "string" && typeof record.message === "string" ? record.code : "INTERNAL_ERROR";
  const code = redactCredentialText(rawCode).redacted ? "INTERNAL_ERROR" : rawCode;
  const message = typeof record?.message === "string"
    ? record.message
    : error instanceof Error ? error.message : String(error);
  return record?.details === undefined
    ? { code, message: redactCredentialText(message).text }
    : { code, message: redactCredentialText(message).text, details: redactDiagnosticValue(record.details) };
}

export function diagnosticText(error: unknown, stack = false): string {
  const raw = error instanceof Error ? stack ? error.stack ?? error.message : error.message : String(error);
  return redactCredentialText(raw).text;
}
