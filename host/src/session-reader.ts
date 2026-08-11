import { createReadStream } from "node:fs";
import { open as openFile, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  buildSessionContext,
  type FileEntry,
  type SessionEntry,
  type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import { D_CODE_SESSION_ORIGIN_TYPE } from "./session-origin.js";
import { compactSessionPreview } from "./session-title.js";

export { D_CODE_SESSION_ORIGIN_TYPE } from "./session-origin.js";

const LIST_CONCURRENCY = 8;
const HEADER_SCAN_BYTES = 1_024 * 1_024;
const HEADER_CHUNK_BYTES = 4 * 1_024;

export interface SessionSummary {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  parentSessionPath?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
}

export interface SessionInspection {
  summary: SessionSummary;
  header: SessionHeader;
  leafId: string | null;
  entries: SessionEntry[];
  context: {
    messageCount: number;
    model: { provider: string; modelId: string } | null;
    thinkingLevel: string;
  };
  activePlan: unknown;
}

export interface SessionCwdScope {
  match: "exact" | "descendantOrEqual";
  paths: string[];
}

export type SessionOrigin = "dcode";

interface IndexedSessionSummary {
  summary: SessionSummary;
  dcodeOrigin: boolean;
}

export class SessionReadError extends Error {
  constructor(
    readonly code: "SESSION_NOT_FOUND" | "DUPLICATE_SESSION_ID" | "INVALID_SESSION",
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "SessionReadError";
  }
}

function parseStrictSessionDocument(content: string, path: string): FileEntry[] {
  if (!content.endsWith("\n")) {
    throw new SessionReadError("INVALID_SESSION", `Session has an incomplete trailing JSONL entry: ${path}`);
  }
  const records: FileEntry[] = [];
  const seenEntryIds = new Set<string>();
  for (const [lineIndex, line] of content.split("\n").entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new SessionReadError("INVALID_SESSION", `Invalid JSONL at line ${lineIndex + 1}: ${path}`);
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new SessionReadError("INVALID_SESSION", `Invalid session entry at line ${lineIndex + 1}: ${path}`);
    }
    const record = value as Record<string, unknown>;
    if (records.length === 0) {
      if (record.type !== "session" || typeof record.id !== "string") {
        throw new SessionReadError("INVALID_SESSION", `Missing session header at line ${lineIndex + 1}: ${path}`);
      }
      records.push(value as FileEntry);
      continue;
    }
    if (record.type === "session" || typeof record.type !== "string" || typeof record.id !== "string") {
      throw new SessionReadError("INVALID_SESSION", `Invalid session entry at line ${lineIndex + 1}: ${path}`);
    }
    if (seenEntryIds.has(record.id)) {
      throw new SessionReadError("INVALID_SESSION", `Duplicate session entry id at line ${lineIndex + 1}: ${path}`);
    }
    if (record.parentId !== null && typeof record.parentId !== "string") {
      throw new SessionReadError("INVALID_SESSION", `Invalid parentId at line ${lineIndex + 1}: ${path}`);
    }
    if (typeof record.parentId === "string" && !seenEntryIds.has(record.parentId)) {
      throw new SessionReadError("INVALID_SESSION", `Missing parent entry at line ${lineIndex + 1}: ${path}`);
    }
    seenEntryIds.add(record.id);
    records.push(value as FileEntry);
  }
  return records;
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

function isDCodeSessionOrigin(record: Record<string, unknown>, sessionId: string): boolean {
  if (record.type !== "custom" || record.customType !== D_CODE_SESSION_ORIGIN_TYPE) return false;
  const data = record.data;
  return typeof data === "object"
    && data !== null
    && !Array.isArray(data)
    && (data as { version?: unknown }).version === 1
    && (data as { sessionId?: unknown }).sessionId === sessionId;
}

async function collectSessionFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
    }
  }
  await visit(root);
  return files;
}

async function mapConcurrent<T, R>(values: readonly T[], limit: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      const value = values[index];
      if (value !== undefined) results[index] = await mapper(value);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()));
  return results;
}

interface SessionHeaderIdentity {
  id: string;
  cwd: string;
}

async function readLeadingLines(
  path: string,
  count: number,
  maxBytes: number,
  allowUnterminatedFinalLine = false,
): Promise<string[] | undefined> {
  let handle;
  try {
    handle = await openFile(path, "r");
    const chunks: Buffer[] = [];
    let position = 0;
    let lineEnds = 0;
    let reachedEnd = false;
    while (position < maxBytes && lineEnds < count) {
      const length = Math.min(HEADER_CHUNK_BYTES, maxBytes - position);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead === 0) {
        reachedEnd = true;
        break;
      }
      const content = buffer.subarray(0, bytesRead);
      let end = content.length;
      for (let index = 0; index < content.length; index += 1) {
        if (content[index] !== 0x0A) continue;
        lineEnds += 1;
        if (lineEnds === count) {
          end = index + 1;
          break;
        }
      }
      chunks.push(content.subarray(0, end));
      position += bytesRead;
      if (bytesRead < length) reachedEnd = true;
    }
    if (chunks.length === 0) return undefined;
    const content = Buffer.concat(chunks).toString("utf8");
    if (lineEnds < count) {
      if (!allowUnterminatedFinalLine || !reachedEnd || count !== 1 || !content.trim()) return undefined;
      return [content];
    }
    return content.split("\n").slice(0, count);
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

async function readHeaderIdentity(path: string): Promise<SessionHeaderIdentity | undefined> {
  try {
    const lines = await readLeadingLines(path, 1, HEADER_SCAN_BYTES, true);
    if (!lines?.[0]) return undefined;
    const value = JSON.parse(lines[0]) as {
      type?: unknown;
      id?: unknown;
      cwd?: unknown;
    };
    return value.type === "session" && typeof value.id === "string" && typeof value.cwd === "string"
      ? { id: value.id, cwd: value.cwd }
      : undefined;
  } catch {
    return undefined;
  }
}

async function readHeaderSessionId(path: string): Promise<string | undefined> {
  return (await readHeaderIdentity(path))?.id;
}

async function canonicalPath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch { return resolve(path); }
}

async function createCwdMatcher(scope: SessionCwdScope | undefined): Promise<(cwd: string) => Promise<boolean>> {
  if (!scope) return async () => true;
  const roots = await Promise.all(scope.paths.map(canonicalPath));
  const cache = new Map<string, Promise<string>>();
  return async (cwd: string) => {
    let canonical = cache.get(cwd);
    if (!canonical) {
      canonical = canonicalPath(cwd);
      cache.set(cwd, canonical);
    }
    const candidate = await canonical;
    return roots.some((root) => {
      if (candidate === root) return true;
      if (scope.match === "exact") return false;
      const child = relative(root, candidate);
      return child.length > 0 && child !== ".." && !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
    });
  };
}

async function readIndexedSummary(
  path: string,
  requiredOrigin?: SessionOrigin,
): Promise<IndexedSessionSummary | undefined> {
  const fileStat = await stat(path);
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let header: SessionHeader | undefined;
  let name: string | undefined;
  let messageCount = 0;
  let firstMessage = "";
  let dcodeOrigin = false;
  let recordPosition = 0;

  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      recordPosition += 1;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        if (requiredOrigin === "dcode" && recordPosition === 2) return undefined;
        continue;
      }
      if (typeof entry !== "object" || entry === null) {
        if (requiredOrigin === "dcode" && recordPosition === 2) return undefined;
        continue;
      }
      const record = entry as Record<string, unknown>;
      if (!header) {
        if (
          record.type !== "session"
          || typeof record.id !== "string"
          || typeof record.timestamp !== "string"
          || typeof record.cwd !== "string"
        ) {
          throw new SessionReadError("INVALID_SESSION", `Invalid session header: ${path}`);
        }
        header = record as unknown as SessionHeader;
        continue;
      }
      if (record.type === "session_info") {
        name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : undefined;
      }
      if (recordPosition === 2) {
        dcodeOrigin = record.parentId === null && isDCodeSessionOrigin(record, header.id);
        if (requiredOrigin === "dcode" && !dcodeOrigin) return undefined;
      }
      if (record.type !== "message") continue;
      messageCount += 1;
      if (firstMessage) continue;
      const message = record.message;
      if (typeof message !== "object" || message === null || (message as { role?: unknown }).role !== "user") continue;
      firstMessage = compactSessionPreview(extractMessageText(message));
    }
  } finally {
    lines.close();
    input.destroy();
  }

  if (!header) throw new SessionReadError("INVALID_SESSION", `Missing session header: ${path}`);
  if (requiredOrigin === "dcode" && !dcodeOrigin) return undefined;
  return {
    summary: {
      path,
      id: header.id,
      cwd: header.cwd,
      ...(name ? { name } : {}),
      ...(header.parentSession ? { parentSessionPath: header.parentSession } : {}),
      created: header.timestamp,
      modified: fileStat.mtime.toISOString(),
      messageCount,
      firstMessage,
    },
    dcodeOrigin,
  };
}

async function readSummary(path: string): Promise<SessionSummary> {
  const record = await readIndexedSummary(path);
  if (!record) throw new SessionReadError("INVALID_SESSION", `Missing session summary: ${path}`);
  return record.summary;
}

function buildActiveBranch(entries: SessionEntry[]): { leafId: string | null; branch: SessionEntry[] } {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const leafId = entries.at(-1)?.id ?? null;
  const reverse: SessionEntry[] = [];
  const visited = new Set<string>();
  let current = leafId ? byId.get(leafId) : undefined;
  while (current && !visited.has(current.id)) {
    reverse.push(current);
    visited.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  reverse.reverse();
  return { leafId, branch: reverse };
}

function findActivePlan(entries: SessionEntry[]): unknown {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || entry.type !== "custom") continue;
    if (entry.customType === "dgoal-work-v1") {
      const goal = (entry.data as { goal?: unknown } | undefined)?.goal;
      if (typeof goal === "object" && goal !== null && (goal as { status?: unknown }).status === "active") return goal;
      return null;
    }
    if (entry.customType === "dgoal-plan-v2") {
      const goal = (entry.data as { goal?: unknown } | undefined)?.goal;
      if (typeof goal === "object" && goal !== null) return goal;
      return null;
    }
  }
  return null;
}

export class SessionReader {
  constructor(readonly sessionsDirectory: string) {}

  async list(options: {
    query?: string;
    limit?: number;
    cwdScope?: SessionCwdScope;
    origin?: SessionOrigin;
  } = {}): Promise<SessionSummary[]> {
    const files = await collectSessionFiles(this.sessionsDirectory);
    const query = options.query?.trim().toLocaleLowerCase();
    const matchesCwd = await createCwdMatcher(options.cwdScope);
    const scopePaths = async (paths: string[]): Promise<string[]> => {
      if (!options.cwdScope) return paths;
      const identities = await mapConcurrent(paths, LIST_CONCURRENCY * 2, async (path) => ({
        path,
        identity: await readHeaderIdentity(path),
      }));
      const matches = await Promise.all(identities.map(async ({ path, identity }) => (
        identity && await matchesCwd(identity.cwd) ? path : undefined
      )));
      return matches.filter((path): path is string => path !== undefined);
    };
    const readSummaries = async (paths: string[]): Promise<IndexedSessionSummary[]> => {
      const settled = await mapConcurrent(paths, LIST_CONCURRENCY, async (path) => {
        try { return await readIndexedSummary(path, options.origin); }
        catch { return undefined; }
      });
      return settled.filter((summary): summary is IndexedSessionSummary => summary !== undefined);
    };

    const matchesOrigin = (record: IndexedSessionSummary): boolean => (
      options.origin === undefined || (options.origin === "dcode" && record.dcodeOrigin)
    );

    if (!query && (options.limit !== undefined || options.cwdScope !== undefined || options.origin !== undefined)) {
      const ranked = (await mapConcurrent(files, LIST_CONCURRENCY * 2, async (path) => {
        try { return { path, modified: (await stat(path)).mtimeMs }; }
        catch { return undefined; }
      }))
        .filter((entry): entry is { path: string; modified: number } => entry !== undefined)
        .sort((left, right) => right.modified - left.modified);
      const sessions: IndexedSessionSummary[] = [];
      const batchSize = Math.max(options.limit ?? LIST_CONCURRENCY, LIST_CONCURRENCY);
      for (
        let offset = 0;
        offset < ranked.length && (options.limit === undefined || sessions.length < options.limit);
        offset += batchSize
      ) {
        const batch = ranked.slice(offset, offset + batchSize).map(({ path }) => path);
        sessions.push(...(await readSummaries(await scopePaths(batch))).filter(matchesOrigin));
      }
      return sessions
        .map((record) => record.summary)
        .sort((left, right) => right.modified.localeCompare(left.modified))
        .slice(0, options.limit ?? sessions.length);
    }

    const sessions = (await readSummaries(await scopePaths(files)))
      .filter(matchesOrigin)
      .map((record) => record.summary)
      .filter((summary) => !query || [summary.id, summary.name, summary.cwd, summary.firstMessage]
        .some((value) => value?.toLocaleLowerCase().includes(query)))
      .sort((left, right) => right.modified.localeCompare(left.modified));
    return sessions.slice(0, options.limit ?? sessions.length);
  }

  async resolve(sessionId: string): Promise<SessionSummary> {
    const files = await collectSessionFiles(this.sessionsDirectory);
    const namedCandidates = files.filter((path) => basename(path).includes(sessionId));
    const ids = await mapConcurrent(files, LIST_CONCURRENCY * 2, async (path) => ({
      path,
      id: await readHeaderSessionId(path),
    }));
    const matchingPaths = ids.filter((entry) => entry.id === sessionId).map(({ path }) => path);
    if (matchingPaths.length === 0) {
      if (namedCandidates.length > 0) {
        throw new SessionReadError("INVALID_SESSION", `Session header is invalid or exceeds the scan limit: ${namedCandidates[0] as string}`);
      }
      throw new SessionReadError("SESSION_NOT_FOUND", `Session not found: ${sessionId}`);
    }
    if (matchingPaths.length > 1) {
      throw new SessionReadError("DUPLICATE_SESSION_ID", `Session id is not unique: ${sessionId}`, matchingPaths);
    }
    return await readSummary(matchingPaths[0] as string);
  }

  async inspect(sessionId: string): Promise<SessionInspection> {
    const summary = await this.resolve(sessionId);
    return await this.inspectSummary(summary, sessionId);
  }

  async inspectPath(path: string, sessionId: string): Promise<SessionInspection> {
    const summary = await readSummary(path);
    return await this.inspectSummary(summary, sessionId);
  }

  private async inspectSummary(summary: SessionSummary, sessionId: string): Promise<SessionInspection> {
    const parsed = parseStrictSessionDocument(await readFile(summary.path, "utf8"), summary.path);
    const header = parsed.find((entry): entry is SessionHeader => entry.type === "session");
    if (!header || header.id !== sessionId) {
      throw new SessionReadError("INVALID_SESSION", `Session header mismatch: ${summary.path}`);
    }
    const entries = parsed.filter((entry): entry is SessionEntry => entry.type !== "session");
    const { leafId, branch } = buildActiveBranch(entries);
    const context = buildSessionContext(entries, leafId);
    return {
      summary,
      header,
      leafId,
      entries: branch,
      context: {
        messageCount: context.messages.length,
        model: context.model,
        thinkingLevel: context.thinkingLevel,
      },
      activePlan: findActivePlan(branch),
    };
  }
}
