import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type {
  PiImportSourceRecord,
  ImportedPiSessionEntryInput,
  ImportedPiSessionPathInput,
} from "./product-store.js";
import { redactCredentialText } from "./credential-material.js";

export { redactCredentialText } from "./credential-material.js";
import { SessionReader, type SessionDocumentInspection, type SessionSummary } from "./session-reader.js";
import { sessionDisplayTitle } from "./session-title.js";

export class PiSessionImportError extends Error {
  constructor(
    readonly code:
      | "PI_IMPORT_SOURCE_CHANGED"
      | "PI_IMPORT_SOURCE_MANAGED_BY_DCODE",
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "PiSessionImportError";
  }
}

export interface PiImportCandidate {
  sourceSessionId: string;
  title: string;
  cwd: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
  previouslyImported: boolean;
}

export interface PiImportPreview extends PiImportCandidate {
  sourcePath: string;
  sourceDigest: string;
  importedEntryCount: number;
  lineageStatus: "unknown";
  omittedContent: {
    hiddenThinking: boolean;
    binaryImages: boolean;
    toolArguments: boolean;
    toolResults: boolean;
    redactedSecrets: boolean;
  };
}

export interface PreparedPiSessionImport {
  preview: PiImportPreview;
  entries: ImportedPiSessionEntryInput[];
  paths: ImportedPiSessionPathInput[];
  conversionEvidence: Record<string, unknown>;
}

function digest(contents: Uint8Array): string {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

function title(summary: SessionSummary): string {
  return redactCredentialText(sessionDisplayTitle({
    name: summary.name,
    firstMessage: summary.firstMessage,
    cwd: summary.cwd,
  })).text;
}

function firstMessage(summary: SessionSummary): string {
  return redactCredentialText(summary.firstMessage).text;
}

function messageRole(message: unknown): ImportedPiSessionEntryInput["messageRole"] {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return "other";
  const role = (message as { role?: unknown }).role;
  if (role === "user" || role === "assistant" || role === "toolResult") return role;
  return "other";
}

interface SanitizedContent {
  content: unknown;
  omittedThinking: boolean;
  omittedImages: boolean;
  omittedToolArguments: boolean;
  omittedToolResults: boolean;
  redactedSecrets: boolean;
}

function sanitizeMessageContent(message: unknown): SanitizedContent {
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return {
      content: "",
      omittedThinking: false,
      omittedImages: false,
      omittedToolArguments: false,
      omittedToolResults: false,
      redactedSecrets: false,
    };
  }
  const content = (message as { content?: unknown }).content;
  const role = (message as { role?: unknown }).role;
  if (role === "toolResult") {
    const serialized = JSON.stringify(content ?? null);
    return {
      content: [{
        type: "toolResultReference",
        digest: digest(Buffer.from(serialized)),
        textOmitted: true,
      }],
      omittedThinking: false,
      omittedImages: false,
      omittedToolArguments: false,
      omittedToolResults: true,
      redactedSecrets: false,
    };
  }
  if (typeof content === "string") {
    const redacted = redactCredentialText(content);
    return {
      content: redacted.text,
      omittedThinking: false,
      omittedImages: false,
      omittedToolArguments: false,
      omittedToolResults: false,
      redactedSecrets: redacted.redacted,
    };
  }
  if (!Array.isArray(content)) {
    return {
      content: "",
      omittedThinking: false,
      omittedImages: false,
      omittedToolArguments: false,
      omittedToolResults: false,
      redactedSecrets: false,
    };
  }
  const visible: unknown[] = [];
  let omittedThinking = false;
  let omittedImages = false;
  let omittedToolArguments = false;
  let redactedSecrets = false;
  for (const block of content) {
    if (typeof block !== "object" || block === null || Array.isArray(block)) continue;
    const value = block as Record<string, unknown>;
    if (value.type === "text" && typeof value.text === "string") {
      const redacted = redactCredentialText(value.text);
      redactedSecrets ||= redacted.redacted;
      visible.push({ type: "text", text: redacted.text });
      continue;
    }
    if (value.type === "thinking") {
      omittedThinking = true;
      continue;
    }
    if (value.type === "image") {
      omittedImages = true;
      const data = typeof value.data === "string" ? value.data : "";
      visible.push({
        type: "imageReference",
        mimeType: typeof value.mimeType === "string" ? value.mimeType : "application/octet-stream",
        digest: data ? digest(Buffer.from(data, "base64")) : null,
        source: "pi_import",
        binaryOmitted: true,
      });
      continue;
    }
    if (value.type === "toolCall") {
      omittedToolArguments = true;
      visible.push({
        type: "toolCallReference",
        id: typeof value.id === "string" ? value.id : null,
        name: typeof value.name === "string" ? value.name : "unknown",
        argumentsOmitted: true,
      });
    }
  }
  return {
    content: visible,
    omittedThinking,
    omittedImages,
    omittedToolArguments,
    omittedToolResults: false,
    redactedSecrets,
  };
}

function importedEntries(inspection: SessionDocumentInspection): {
  entries: ImportedPiSessionEntryInput[];
  omittedThinking: boolean;
  omittedImages: boolean;
  omittedToolArguments: boolean;
  omittedToolResults: boolean;
  redactedSecrets: boolean;
} {
  let omittedThinking = false;
  let omittedImages = false;
  let omittedToolArguments = false;
  let omittedToolResults = false;
  let redactedSecrets = false;
  const entries = inspection.entries.flatMap((entry: SessionEntry, sourceOrdinal) => {
    if (entry.type !== "message") return [];
    const sanitized = sanitizeMessageContent(entry.message);
    omittedThinking ||= sanitized.omittedThinking;
    omittedImages ||= sanitized.omittedImages;
    omittedToolArguments ||= sanitized.omittedToolArguments;
    omittedToolResults ||= sanitized.omittedToolResults;
    redactedSecrets ||= sanitized.redactedSecrets;
    const timestamp = (entry as { timestamp?: unknown }).timestamp;
    return [{
      sourceEntryId: entry.id,
      ...(entry.parentId ? { sourceParentEntryId: entry.parentId } : {}),
      sourceOrdinal,
      ...(typeof timestamp === "string" ? { sourceTimestamp: timestamp } : {}),
      messageRole: messageRole(entry.message),
      content: sanitized.content,
    } satisfies ImportedPiSessionEntryInput];
  });
  return {
    entries,
    omittedThinking,
    omittedImages,
    omittedToolArguments,
    omittedToolResults,
    redactedSecrets,
  };
}

export async function listPiImportCandidates(
  reader: SessionReader,
  imports: readonly PiImportSourceRecord[],
  limit = 200,
): Promise<PiImportCandidate[]> {
  const all = await reader.list();
  const importedIds = new Set(imports.map((item) => item.sourceSessionId));
  const candidates = await Promise.all(all.map(async (summary) => ({
    summary,
    dcodeManaged: await reader.hasDCodeOrigin(summary),
  })));
  return candidates
    .filter(({ dcodeManaged }) => !dcodeManaged)
    .map(({ summary }) => ({
      sourceSessionId: summary.id,
      title: title(summary),
      cwd: summary.cwd,
      created: summary.created,
      modified: summary.modified,
      messageCount: summary.messageCount,
      firstMessage: firstMessage(summary),
      previouslyImported: importedIds.has(summary.id),
    }))
    .slice(0, limit);
}

async function prepareSessionSnapshot(
  reader: SessionReader,
  sourceSessionId: string,
  imports: readonly PiImportSourceRecord[],
  expectedManagement: "external_pi" | "dcode_managed",
): Promise<PreparedPiSessionImport> {
  const summary = await reader.resolve(sourceSessionId);
  const dcodeManaged = await reader.hasDCodeOrigin(summary);
  if (expectedManagement === "external_pi" && dcodeManaged) {
    throw new PiSessionImportError(
      "PI_IMPORT_SOURCE_MANAGED_BY_DCODE",
      "This Pi Session is already managed by D Code and belongs to the upgrade-adoption path",
      { sourceSessionId },
    );
  }
  if (expectedManagement === "dcode_managed" && !dcodeManaged) {
    throw new PiSessionImportError(
      "PI_IMPORT_SOURCE_MANAGED_BY_DCODE",
      "This Pi Session is not a D Code-managed session eligible for automatic adoption",
      { sourceSessionId },
    );
  }
  const before = await readFile(summary.path);
  const inspection = await reader.inspectDocument(sourceSessionId);
  const after = await readFile(summary.path);
  const beforeDigest = digest(before);
  const afterDigest = digest(after);
  if (beforeDigest !== afterDigest) {
    throw new PiSessionImportError(
      "PI_IMPORT_SOURCE_CHANGED",
      "The Pi Session changed while D Code was preparing its import",
      { sourceSessionId, beforeDigest, afterDigest },
    );
  }
  const transformed = importedEntries(inspection);
  const importedEntryIds = new Set(transformed.entries.map((entry) => entry.sourceEntryId));
  const paths: ImportedPiSessionPathInput[] = inspection.paths.map((path) => ({
    sourcePathId: path.id,
    ...(path.leafId ? { sourceLeafEntryId: path.leafId } : {}),
    title: redactCredentialText(path.title).text,
    isCurrent: path.isCurrent,
    sourceEntryIds: path.entryIds.filter((entryId) => importedEntryIds.has(entryId)),
  }));
  const conversionEvidence = {
    version: 1,
    hiddenThinkingOmitted: transformed.omittedThinking,
    binaryImagesOmitted: transformed.omittedImages,
    toolArgumentsOmitted: transformed.omittedToolArguments,
    toolResultsOmitted: transformed.omittedToolResults,
    secretsRedacted: transformed.redactedSecrets,
    importedPathCount: paths.length,
    importedEntryCount: transformed.entries.length,
  };
  return {
    preview: {
      sourceSessionId,
      title: title(inspection.summary),
      cwd: inspection.summary.cwd,
      created: inspection.summary.created,
      modified: inspection.summary.modified,
      messageCount: inspection.summary.messageCount,
      firstMessage: firstMessage(inspection.summary),
      previouslyImported: imports.some((item) => (
        item.sourceSessionId === sourceSessionId && item.sourceDigest === beforeDigest
      )),
      sourcePath: inspection.summary.path,
      sourceDigest: beforeDigest,
      importedEntryCount: transformed.entries.length,
      lineageStatus: "unknown",
      omittedContent: {
        hiddenThinking: transformed.omittedThinking,
        binaryImages: transformed.omittedImages,
        toolArguments: transformed.omittedToolArguments,
        toolResults: transformed.omittedToolResults,
        redactedSecrets: transformed.redactedSecrets,
      },
    },
    entries: transformed.entries,
    paths,
    conversionEvidence,
  };
}

export async function preparePiSessionImport(
  reader: SessionReader,
  sourceSessionId: string,
  imports: readonly PiImportSourceRecord[],
): Promise<PreparedPiSessionImport> {
  return await prepareSessionSnapshot(reader, sourceSessionId, imports, "external_pi");
}

export async function prepareDCodeManagedSessionAdoption(
  reader: SessionReader,
  sourceSessionId: string,
): Promise<PreparedPiSessionImport> {
  return await prepareSessionSnapshot(reader, sourceSessionId, [], "dcode_managed");
}
