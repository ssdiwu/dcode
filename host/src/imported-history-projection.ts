import { createHash } from "node:crypto";
import { redactCredentialText } from "./credential-material.js";

export const MAX_IMPORTED_HISTORY_ENTRIES = 48;
export const MAX_IMPORTED_HISTORY_BYTES = 24 * 1024;

export interface ImportedHistoryProjectionEntry {
  id: string;
  sourceEntryId?: string;
  messageRole: "user" | "assistant";
  content: unknown;
}

export interface ImportedSessionHistoryReceipt {
  version: 1;
  dcodeSessionId: string;
  sourceSessionId: string;
  sourceDigest: string;
  importerVersion: number;
  sourcePathId: string;
  selectedEntryIdsDigest: string;
  availableEntryCount: number;
  includedEntryCount: number;
  omittedEntryCount: number;
  includedBytes: number;
  maxEntries: number;
  maxBytes: number;
  truncatedEntryCount: number;
  redactedAtImport: boolean;
  redactedAtProjection: boolean;
  digest: string;
}

export interface ImportedSessionHistoryProjection {
  receipt: ImportedSessionHistoryReceipt;
  text: string;
}

export interface ImportedSessionHistoryProjectionInput {
  dcodeSessionId: string;
  sourceSessionId: string;
  sourceDigest: string;
  importerVersion: number;
  sourcePathId: string;
  redactedAtImport: boolean;
  entries: readonly ImportedHistoryProjectionEntry[];
}

export class ImportedSessionHistoryReceiptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportedSessionHistoryReceiptError";
  }
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function visibleText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => {
    if (typeof block !== "object" || block === null || Array.isArray(block)) return [];
    const value = block as { type?: unknown; text?: unknown };
    return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
  }).join("\n");
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  let end = Math.max(0, maxBytes);
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function renderedEntry(role: "user" | "assistant", text: string): string {
  return `${role === "user" ? "用户" : "助手"}：\n${text}`;
}

function readRedactionFlag(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const conversionEvidence = (value as { conversionEvidence?: unknown }).conversionEvidence;
  if (typeof conversionEvidence !== "object" || conversionEvidence === null || Array.isArray(conversionEvidence)) {
    return false;
  }
  return (conversionEvidence as { secretsRedacted?: unknown }).secretsRedacted === true;
}

export function importedHistoryWasRedactedAtImport(details: unknown): boolean {
  return readRedactionFlag(details);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || value.includes("\0")) {
    throw new ImportedSessionHistoryReceiptError(`Imported History Receipt has an invalid ${field}`);
  }
  return value;
}

function requiredDigest(value: unknown, field: string): string {
  const result = requiredString(value, field, 80);
  if (!/^sha256:[a-f0-9]{64}$/.test(result)) {
    throw new ImportedSessionHistoryReceiptError(`Imported History Receipt has an invalid ${field}`);
  }
  return result;
}

function requiredNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ImportedSessionHistoryReceiptError(`Imported History Receipt has an invalid ${field}`);
  }
  return value as number;
}

export function normalizeImportedSessionHistoryReceipt(value: unknown): ImportedSessionHistoryReceipt {
  if (!isRecord(value) || value.version !== 1) {
    throw new ImportedSessionHistoryReceiptError("Imported History Receipt has an invalid version");
  }
  const availableEntryCount = requiredNonNegativeInteger(value.availableEntryCount, "availableEntryCount");
  const includedEntryCount = requiredNonNegativeInteger(value.includedEntryCount, "includedEntryCount");
  const omittedEntryCount = requiredNonNegativeInteger(value.omittedEntryCount, "omittedEntryCount");
  const includedBytes = requiredNonNegativeInteger(value.includedBytes, "includedBytes");
  const maxEntries = requiredNonNegativeInteger(value.maxEntries, "maxEntries");
  const maxBytes = requiredNonNegativeInteger(value.maxBytes, "maxBytes");
  const truncatedEntryCount = requiredNonNegativeInteger(value.truncatedEntryCount, "truncatedEntryCount");
  if (
    includedEntryCount > availableEntryCount
    || omittedEntryCount !== availableEntryCount - includedEntryCount
    || includedEntryCount > maxEntries
    || includedBytes > maxBytes
    || truncatedEntryCount > includedEntryCount
    || maxEntries !== MAX_IMPORTED_HISTORY_ENTRIES
    || maxBytes !== MAX_IMPORTED_HISTORY_BYTES
  ) {
    throw new ImportedSessionHistoryReceiptError("Imported History Receipt counters are inconsistent");
  }
  if (typeof value.redactedAtImport !== "boolean" || typeof value.redactedAtProjection !== "boolean") {
    throw new ImportedSessionHistoryReceiptError("Imported History Receipt has invalid redaction facts");
  }
  return {
    version: 1,
    dcodeSessionId: requiredString(value.dcodeSessionId, "dcodeSessionId", 200),
    sourceSessionId: requiredString(value.sourceSessionId, "sourceSessionId", 200),
    sourceDigest: requiredDigest(value.sourceDigest, "sourceDigest"),
    importerVersion: requiredNonNegativeInteger(value.importerVersion, "importerVersion"),
    sourcePathId: requiredString(value.sourcePathId, "sourcePathId", 200),
    selectedEntryIdsDigest: requiredDigest(value.selectedEntryIdsDigest, "selectedEntryIdsDigest"),
    availableEntryCount,
    includedEntryCount,
    omittedEntryCount,
    includedBytes,
    maxEntries,
    maxBytes,
    truncatedEntryCount,
    redactedAtImport: value.redactedAtImport,
    redactedAtProjection: value.redactedAtProjection,
    digest: requiredDigest(value.digest, "digest"),
  };
}

export function projectImportedSessionHistory(
  input: ImportedSessionHistoryProjectionInput,
): ImportedSessionHistoryProjection | undefined {
  let redactedAtProjection = false;
  const available = input.entries.flatMap((entry) => {
    const redacted = redactCredentialText(visibleText(entry.content));
    redactedAtProjection ||= redacted.redacted;
    const text = redacted.text.trim();
    if (text.length === 0) return [];
    return [{
      id: entry.id,
      ...(entry.sourceEntryId ? { sourceEntryId: entry.sourceEntryId } : {}),
      messageRole: entry.messageRole,
      text,
    }];
  });
  if (available.length === 0) return undefined;

  const selected: Array<{ id: string; sourceEntryId?: string; messageRole: "user" | "assistant"; text: string }> = [];
  let includedBytes = 0;
  let truncatedEntryCount = 0;
  for (let index = available.length - 1; index >= 0; index -= 1) {
    if (selected.length >= MAX_IMPORTED_HISTORY_ENTRIES) break;
    const candidate = available[index]!;
    const rendered = renderedEntry(candidate.messageRole, candidate.text);
    const separatorBytes = selected.length === 0 ? 0 : Buffer.byteLength("\n\n", "utf8");
    const candidateBytes = Buffer.byteLength(rendered, "utf8") + separatorBytes;
    if (includedBytes + candidateBytes <= MAX_IMPORTED_HISTORY_BYTES) {
      selected.unshift(candidate);
      includedBytes += candidateBytes;
      continue;
    }
    if (selected.length !== 0) continue;
    const prefix = `${candidate.messageRole === "user" ? "用户" : "助手"}：\n`;
    const marker = "\n[此条历史已按上下文上限截断]";
    const allowedTextBytes = MAX_IMPORTED_HISTORY_BYTES
      - Buffer.byteLength(prefix, "utf8")
      - Buffer.byteLength(marker, "utf8");
    if (allowedTextBytes <= 0) continue;
    const shortened = truncateUtf8(candidate.text, allowedTextBytes).trimEnd();
    if (shortened.length === 0) continue;
    selected.unshift({ ...candidate, text: `${shortened}${marker}` });
    includedBytes = Buffer.byteLength(renderedEntry(candidate.messageRole, `${shortened}${marker}`), "utf8");
    truncatedEntryCount = 1;
  }
  if (selected.length === 0) return undefined;

  const text = selected.map((entry) => renderedEntry(entry.messageRole, entry.text)).join("\n\n");
  const selectedEntryIdsDigest = digest(JSON.stringify(selected.map((entry) => entry.id)));
  const receiptBase = {
    version: 1 as const,
    dcodeSessionId: input.dcodeSessionId,
    sourceSessionId: input.sourceSessionId,
    sourceDigest: input.sourceDigest,
    importerVersion: input.importerVersion,
    sourcePathId: input.sourcePathId,
    selectedEntryIdsDigest,
    availableEntryCount: available.length,
    includedEntryCount: selected.length,
    omittedEntryCount: available.length - selected.length,
    includedBytes: Buffer.byteLength(text, "utf8"),
    maxEntries: MAX_IMPORTED_HISTORY_ENTRIES,
    maxBytes: MAX_IMPORTED_HISTORY_BYTES,
    truncatedEntryCount,
    redactedAtImport: input.redactedAtImport,
    redactedAtProjection,
  };
  return {
    receipt: {
      ...receiptBase,
      digest: digest(JSON.stringify({ ...receiptBase, text })),
    },
    text,
  };
}
