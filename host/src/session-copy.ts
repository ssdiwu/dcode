import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  link,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { uuidv7 } from "@earendil-works/pi-ai";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import { D_CODE_SESSION_ORIGIN_TYPE } from "./session-origin.js";
import type { SessionSummary } from "./session-reader.js";
import { compactSessionPreview } from "./session-title.js";

export interface SessionCopyResult {
  copied: true;
  source: {
    id: string;
    path: string;
    leafId: string | null;
    entryCount: number;
  };
  target: SessionSummary;
  verification: {
    entryCount: number;
    leafId: string | null;
    origin: true;
  };
}

export class SessionCopyError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) {
    super(message);
    this.name = "SessionCopyError";
  }
}

interface StreamedSource {
  entryCount: number;
  leafId: string | null;
  bodyDigest: string;
  name?: string;
  messageCount: number;
  firstMessage: string;
}

const STALE_STAGING_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_SESSION_ENTRY_BYTES = 16 * 1_024 * 1_024;
const MAX_SESSION_ENTRIES = 100_000;

function sessionDirectoryName(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function extractMessageText(message: unknown): string {
  if (typeof message !== "object" || message === null) return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => (
      typeof part === "object"
      && part !== null
      && (part as { type?: unknown }).type === "text"
      && typeof (part as { text?: unknown }).text === "string"
    ))
    .map((part) => part.text)
    .join("\n");
}

async function cleanupStaleStaging(base: string): Promise<void> {
  const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
  const cutoff = Date.now() - STALE_STAGING_AGE_MS;
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory() || !entry.name.startsWith("operation-")) return;
    const path = join(base, entry.name);
    try {
      if ((await stat(path)).mtimeMs < cutoff) {
        await rm(path, { recursive: true, force: true });
      }
    } catch {
      // A concurrent process may have completed cleanup first.
    }
  }));
}

async function canonicalDirectory(path: string): Promise<string> {
  try {
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) throw new Error("not a directory");
    return canonical;
  } catch (error) {
    throw new SessionCopyError("COPY_TARGET_NOT_ACCESSIBLE", `Copy target is not accessible: ${path}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

async function* readBoundedLines(path: string): AsyncGenerator<string> {
  const input = createReadStream(path);
  let pending = Buffer.alloc(0);
  try {
    for await (const value of input) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      let start = 0;
      for (let index = 0; index < chunk.length; index += 1) {
        if (chunk[index] !== 0x0A) continue;
        const part = chunk.subarray(start, index);
        if (pending.length + part.length > MAX_SESSION_ENTRY_BYTES) {
          throw new SessionCopyError("SESSION_ENTRY_TOO_LARGE", "Session contains an entry larger than 16 MiB");
        }
        const line = pending.length === 0 ? part : Buffer.concat([pending, part]);
        try {
          yield new TextDecoder("utf-8", { fatal: true }).decode(line);
        } catch {
          throw new SessionCopyError("INVALID_SESSION", `Session contains invalid UTF-8: ${path}`);
        }
        pending = Buffer.alloc(0);
        start = index + 1;
      }
      const tail = chunk.subarray(start);
      if (pending.length + tail.length > MAX_SESSION_ENTRY_BYTES) {
        throw new SessionCopyError("SESSION_ENTRY_TOO_LARGE", "Session contains an entry larger than 16 MiB");
      }
      if (tail.length > 0) pending = pending.length === 0 ? Buffer.from(tail) : Buffer.concat([pending, tail]);
    }
    if (pending.length !== 0) {
      throw new SessionCopyError("INVALID_SESSION", `Session has an incomplete trailing JSONL entry: ${path}`);
    }
  } finally {
    input.destroy();
  }
}

function parseRecord(line: string, lineNumber: number, path: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(line); }
  catch {
    throw new SessionCopyError("INVALID_SESSION", `Invalid JSONL at line ${lineNumber}: ${path}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SessionCopyError("INVALID_SESSION", `Invalid session record at line ${lineNumber}: ${path}`);
  }
  return value as Record<string, unknown>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTextContent(value: unknown): boolean {
  return isObject(value) && value.type === "text" && typeof value.text === "string";
}

function isImageContent(value: unknown): boolean {
  return isObject(value)
    && value.type === "image"
    && typeof value.data === "string"
    && typeof value.mimeType === "string";
}

function isThinkingContent(value: unknown): boolean {
  return isObject(value) && value.type === "thinking" && typeof value.thinking === "string";
}

function isToolCall(value: unknown): boolean {
  return isObject(value)
    && value.type === "toolCall"
    && typeof value.id === "string"
    && typeof value.name === "string"
    && isObject(value.arguments);
}

function isContentArray(
  value: unknown,
  accepts: (part: unknown) => boolean,
): boolean {
  return Array.isArray(value) && value.every(accepts);
}

function invalidEntry(lineNumber: number, path: string, detail: string): never {
  throw new SessionCopyError("INVALID_SESSION", `${detail} at line ${lineNumber}: ${path}`);
}

function validateStoredMessage(message: unknown, lineNumber: number, path: string): void {
  if (!isObject(message) || typeof message.role !== "string") {
    invalidEntry(lineNumber, path, "Invalid stored message");
  }
  const timestampIsValid = typeof message.timestamp === "number" && Number.isFinite(message.timestamp);
  switch (message.role) {
    case "user":
      if (!timestampIsValid || !(
        message.content == null
        || typeof message.content === "string"
        || isContentArray(message.content, (part) => isTextContent(part) || isImageContent(part))
      )) invalidEntry(lineNumber, path, "Invalid user message");
      return;
    case "assistant":
      if (!timestampIsValid
        || typeof message.api !== "string"
        || typeof message.provider !== "string"
        || typeof message.model !== "string"
        || !isObject(message.usage)
        || typeof message.stopReason !== "string"
        || !(message.content == null || isContentArray(
          message.content,
          (part) => isTextContent(part) || isThinkingContent(part) || isToolCall(part),
        ))) invalidEntry(lineNumber, path, "Invalid assistant message");
      return;
    case "toolResult":
      if (!timestampIsValid
        || typeof message.toolCallId !== "string"
        || typeof message.toolName !== "string"
        || typeof message.isError !== "boolean"
        || !(message.content == null || isContentArray(
          message.content,
          (part) => isTextContent(part) || isImageContent(part),
        ))) invalidEntry(lineNumber, path, "Invalid tool result message");
      return;
    case "bashExecution":
      if (!timestampIsValid
        || typeof message.command !== "string"
        || typeof message.output !== "string"
        || !(message.exitCode === undefined || typeof message.exitCode === "number")
        || typeof message.cancelled !== "boolean"
        || typeof message.truncated !== "boolean") {
        invalidEntry(lineNumber, path, "Invalid bash execution message");
      }
      return;
    case "custom":
      if (!timestampIsValid
        || typeof message.customType !== "string"
        || typeof message.display !== "boolean"
        || !(message.content == null
          || typeof message.content === "string"
          || isContentArray(message.content, (part) => isTextContent(part) || isImageContent(part)))) {
        invalidEntry(lineNumber, path, "Invalid custom message");
      }
      return;
    case "branchSummary":
      if (!timestampIsValid || typeof message.summary !== "string" || typeof message.fromId !== "string") {
        invalidEntry(lineNumber, path, "Invalid branch summary message");
      }
      return;
    case "compactionSummary":
      if (!timestampIsValid || typeof message.summary !== "string" || typeof message.tokensBefore !== "number") {
        invalidEntry(lineNumber, path, "Invalid compaction summary message");
      }
      return;
    default:
      invalidEntry(lineNumber, path, `Unsupported stored message role: ${message.role}`);
  }
}

function validateSessionEntry(
  record: Record<string, unknown>,
  seenEntryIds: ReadonlySet<string>,
  lineNumber: number,
  path: string,
): void {
  if (typeof record.timestamp !== "string" || !record.timestamp) {
    invalidEntry(lineNumber, path, "Invalid session entry timestamp");
  }
  switch (record.type) {
    case "message":
      validateStoredMessage(record.message, lineNumber, path);
      return;
    case "thinking_level_change":
      if (typeof record.thinkingLevel !== "string") invalidEntry(lineNumber, path, "Invalid thinking level entry");
      return;
    case "model_change":
      if (typeof record.provider !== "string" || typeof record.modelId !== "string") {
        invalidEntry(lineNumber, path, "Invalid model change entry");
      }
      return;
    case "compaction":
      if (typeof record.summary !== "string"
        || typeof record.firstKeptEntryId !== "string"
        || !seenEntryIds.has(record.firstKeptEntryId)
        || typeof record.tokensBefore !== "number") {
        invalidEntry(lineNumber, path, "Invalid compaction entry");
      }
      return;
    case "branch_summary":
      if (typeof record.fromId !== "string"
        || !seenEntryIds.has(record.fromId)
        || typeof record.summary !== "string") {
        invalidEntry(lineNumber, path, "Invalid branch summary entry");
      }
      return;
    case "custom":
      if (typeof record.customType !== "string") invalidEntry(lineNumber, path, "Invalid custom entry");
      return;
    case "custom_message":
      if (typeof record.customType !== "string"
        || typeof record.display !== "boolean"
        || !(record.content == null
          || typeof record.content === "string"
          || isContentArray(record.content, (part) => isTextContent(part) || isImageContent(part)))) {
        invalidEntry(lineNumber, path, "Invalid custom message entry");
      }
      return;
    case "label":
      if (typeof record.targetId !== "string"
        || !seenEntryIds.has(record.targetId)
        || !(record.label === undefined || typeof record.label === "string")) {
        invalidEntry(lineNumber, path, "Invalid label entry");
      }
      return;
    case "session_info":
      if (!(record.name === undefined || typeof record.name === "string")) {
        invalidEntry(lineNumber, path, "Invalid session info entry");
      }
      return;
    default:
      invalidEntry(lineNumber, path, `Unsupported session entry type: ${String(record.type)}`);
  }
}

async function streamSourceIntoPrepared(options: {
  source: SessionSummary;
  preparedPath: string;
  targetHeader: Record<string, unknown>;
  origin: Record<string, unknown>;
}): Promise<StreamedSource> {
  const sourcePath = resolve(options.source.path);
  const handle = await open(options.preparedPath, "wx", 0o600);
  const digest = createHash("sha256");
  const seenEntryIds = new Set<string>();
  let headerSeen = false;
  let lineNumber = 0;
  let entryCount = 0;
  let leafId: string | null = null;
  let name: string | undefined;
  let messageCount = 0;
  let firstMessage = "";
  try {
    await handle.write(`${JSON.stringify(options.targetHeader)}\n`);
    await handle.write(`${JSON.stringify(options.origin)}\n`);
    for await (const line of readBoundedLines(sourcePath)) {
      lineNumber += 1;
      if (!line.trim()) continue;
      const record = parseRecord(line, lineNumber, sourcePath);
      if (!headerSeen) {
        if (record.type !== "session"
          || record.version !== CURRENT_SESSION_VERSION
          || record.id !== options.source.id
          || typeof record.timestamp !== "string"
          || typeof record.cwd !== "string") {
          throw new SessionCopyError("INVALID_SESSION", `Source session Header is invalid: ${sourcePath}`);
        }
        headerSeen = true;
        continue;
      }
      if (record.type === "session"
        || typeof record.type !== "string"
        || typeof record.id !== "string"
        || (record.parentId !== null && typeof record.parentId !== "string")) {
        throw new SessionCopyError("INVALID_SESSION", `Invalid session entry at line ${lineNumber}: ${sourcePath}`);
      }
      if (seenEntryIds.has(record.id) || record.id === options.origin.id) {
        throw new SessionCopyError("INVALID_SESSION", `Duplicate session entry id at line ${lineNumber}: ${sourcePath}`);
      }
      if (typeof record.parentId === "string" && !seenEntryIds.has(record.parentId)) {
        throw new SessionCopyError("INVALID_SESSION", `Missing parent entry at line ${lineNumber}: ${sourcePath}`);
      }
      validateSessionEntry(record, seenEntryIds, lineNumber, sourcePath);
      entryCount += 1;
      if (entryCount > MAX_SESSION_ENTRIES) {
        throw new SessionCopyError("SESSION_TOO_LARGE", `Session contains more than ${MAX_SESSION_ENTRIES} entries`);
      }
      seenEntryIds.add(record.id);
      leafId = record.id;
      if (record.type === "session_info") {
        name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : undefined;
      }
      if (record.type === "message") {
        messageCount += 1;
        if (!firstMessage) {
          const message = record.message;
          if (typeof message === "object" && message !== null && (message as { role?: unknown }).role === "user") {
            firstMessage = compactSessionPreview(extractMessageText(message));
          }
        }
      }
      const serialized = `${line}\n`;
      digest.update(serialized);
      await handle.write(serialized);
    }
    if (!headerSeen) throw new SessionCopyError("INVALID_SESSION", `Missing source session Header: ${sourcePath}`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return {
    entryCount,
    leafId,
    bodyDigest: digest.digest("hex"),
    ...(name ? { name } : {}),
    messageCount,
    firstMessage,
  };
}

async function verifyPrepared(options: {
  path: string;
  sessionId: string;
  originId: string;
  expectedEntryCount: number;
  expectedBodyDigest: string;
}): Promise<void> {
  const digest = createHash("sha256");
  let recordPosition = 0;
  let bodyCount = 0;
  for await (const line of readBoundedLines(options.path)) {
    if (!line.trim()) continue;
    recordPosition += 1;
    const record = parseRecord(line, recordPosition, options.path);
    if (recordPosition === 1) {
      if (record.type !== "session" || record.id !== options.sessionId) {
        throw new SessionCopyError("SESSION_COPY_VERIFICATION_FAILED", "Copied session Header is invalid");
      }
      continue;
    }
    if (recordPosition === 2) {
      const data = record.data as Record<string, unknown> | undefined;
      if (record.type !== "custom"
        || record.id !== options.originId
        || record.customType !== D_CODE_SESSION_ORIGIN_TYPE
        || record.parentId !== null
        || data?.version !== 1
        || data.sessionId !== options.sessionId) {
        throw new SessionCopyError("SESSION_COPY_VERIFICATION_FAILED", "Copied session origin is invalid");
      }
      continue;
    }
    bodyCount += 1;
    digest.update(`${line}\n`);
  }
  if (bodyCount !== options.expectedEntryCount || digest.digest("hex") !== options.expectedBodyDigest) {
    throw new SessionCopyError("SESSION_COPY_VERIFICATION_FAILED", "Copied session history is incomplete");
  }
}

export class SessionCopier {
  constructor(private readonly sessionsDirectory: string) {}

  async copy(options: {
    source: SessionSummary;
    targetCwd: string;
    assertSourceStable: () => Promise<void>;
  }): Promise<SessionCopyResult> {
    const canonicalCwd = await canonicalDirectory(options.targetCwd);
    const sourcePath = resolve(options.source.path);
    const targetDirectory = join(this.sessionsDirectory, sessionDirectoryName(canonicalCwd));
    await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
    const stagingBase = join(dirname(this.sessionsDirectory), ".dcode-session-copy-staging");
    await mkdir(stagingBase, { recursive: true, mode: 0o700 });
    await cleanupStaleStaging(stagingBase);
    const operationDirectory = await mkdtemp(join(stagingBase, "operation-"));
    const targetSessionId = uuidv7();
    const timestamp = new Date().toISOString();
    const fileTimestamp = timestamp.replace(/[:.]/g, "-");
    const fileName = `${fileTimestamp}_${targetSessionId}.jsonl`;
    const preparedPath = join(operationDirectory, `${fileName}.prepared`);
    const finalPath = join(targetDirectory, fileName);
    const targetHeader = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: targetSessionId,
      timestamp,
      cwd: canonicalCwd,
      parentSession: sourcePath,
    };
    const originId = randomUUID();
    const origin = {
      type: "custom",
      id: originId,
      parentId: null,
      timestamp,
      customType: D_CODE_SESSION_ORIGIN_TYPE,
      data: { version: 1, sessionId: targetSessionId },
    };
    try {
      const streamed = await streamSourceIntoPrepared({
        source: options.source,
        preparedPath,
        targetHeader,
        origin,
      });
      await verifyPrepared({
        path: preparedPath,
        sessionId: targetSessionId,
        originId,
        expectedEntryCount: streamed.entryCount,
        expectedBodyDigest: streamed.bodyDigest,
      });
      await options.assertSourceStable();
      await link(preparedPath, finalPath);
      const target: SessionSummary = {
        path: finalPath,
        id: targetSessionId,
        cwd: canonicalCwd,
        ...(streamed.name ? { name: streamed.name } : {}),
        parentSessionPath: sourcePath,
        created: timestamp,
        modified: timestamp,
        messageCount: streamed.messageCount,
        firstMessage: streamed.firstMessage,
      };
      return {
        copied: true,
        source: {
          id: options.source.id,
          path: sourcePath,
          leafId: streamed.leafId,
          entryCount: streamed.entryCount,
        },
        target,
        verification: {
          entryCount: streamed.entryCount,
          leafId: streamed.leafId ?? originId,
          origin: true,
        },
      };
    } finally {
      await rm(operationDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
