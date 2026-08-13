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
  parentSessionId?: string;
  leafId: string | null;
  currentPathId: string;
  selectedPathId: string;
  paths: SessionPathSummary[];
  entries: SessionEntry[];
  context: {
    messageCount: number;
    model: { provider: string; modelId: string } | null;
    thinkingLevel: string;
  };
  activePlan: unknown;
}

export interface SessionPathSummary {
  id: string;
  leafId: string | null;
  title: string;
  updated: string;
  entryCount: number;
  branchFromEntryId?: string;
  branchFromPreview?: string;
  isCurrent: boolean;
  isSelected: boolean;
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

function normalizedContextModel(
  model: unknown,
): { provider: string; modelId: string } | null {
  if (typeof model !== "object" || model === null) return null;
  const source = model as Record<string, unknown>;
  if (typeof source.provider !== "string" || source.provider.trim() === "") return null;
  if (typeof source.modelId !== "string" || source.modelId.trim() === "") return null;
  return { provider: source.provider, modelId: source.modelId };
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
  parentSession?: string;
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
      parentSession?: unknown;
    };
    return value.type === "session" && typeof value.id === "string" && typeof value.cwd === "string"
      ? {
          id: value.id,
          cwd: value.cwd,
          ...(typeof value.parentSession === "string" ? { parentSession: value.parentSession } : {}),
        }
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

function pathId(leafId: string | null): string {
  return leafId ? `leaf:${leafId}` : "root";
}

function buildBranch(entries: SessionEntry[], requestedLeafId?: string | null): { leafId: string | null; branch: SessionEntry[] } {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const leafId = requestedLeafId === undefined ? entries.at(-1)?.id ?? null : requestedLeafId;
  if (leafId !== null && !byId.has(leafId)) {
    throw new SessionReadError("INVALID_SESSION", `Session path leaf not found: ${leafId}`);
  }
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

function pathTitle(branch: readonly SessionEntry[], fallback: string): string {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (!entry || entry.type !== "message") continue;
    const role = typeof entry.message === "object" && entry.message !== null
      ? (entry.message as { role?: unknown }).role
      : undefined;
    const preview = compactSessionPreview(extractMessageText(entry.message));
    if (preview) return `${role === "user" ? "用户" : role === "assistant" ? "助手" : "消息"} · ${preview}`;
  }
  return fallback;
}

function entryPreview(entry: SessionEntry | undefined): string | undefined {
  if (!entry || entry.type !== "message") return undefined;
  const preview = compactSessionPreview(extractMessageText(entry.message));
  return preview || undefined;
}

function sessionPaths(
  entries: SessionEntry[],
  selectedLeafId: string | null,
  fallbackUpdated: string,
): SessionPathSummary[] {
  if (entries.length === 0) {
    return [{
      id: "root",
      leafId: null,
      title: "初始路径",
      updated: fallbackUpdated,
      entryCount: 0,
      isCurrent: true,
      isSelected: selectedLeafId === null,
    }];
  }
  const parentIds = new Set(entries.flatMap((entry) => entry.parentId ? [entry.parentId] : []));
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const childCounts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.parentId) childCounts.set(entry.parentId, (childCounts.get(entry.parentId) ?? 0) + 1);
  }
  const currentLeafId = entries.at(-1)?.id ?? null;
  return entries
    .filter((entry) => !parentIds.has(entry.id))
    .filter((entry) => {
      if (entry.id === currentLeafId) return true;
      return buildBranch(entries, entry.id).branch.some((candidate) => candidate.type === "message");
    })
    .map((entry) => {
      const branch = buildBranch(entries, entry.id).branch;
      const branchStart = branch.find((candidate) => (
        candidate.parentId !== null && (childCounts.get(candidate.parentId) ?? 0) > 1
      ));
      const branchFromEntryId = branchStart?.parentId ?? undefined;
      const branchFromPreview = entryPreview(branchFromEntryId ? byId.get(branchFromEntryId) : undefined);
      const timestamp = (entry as { timestamp?: unknown }).timestamp;
      return {
        id: pathId(entry.id),
        leafId: entry.id,
        title: pathTitle(branch, "会话路径"),
        updated: typeof timestamp === "string" ? timestamp : fallbackUpdated,
        entryCount: branch.length,
        ...(branchFromEntryId ? { branchFromEntryId } : {}),
        ...(branchFromPreview ? { branchFromPreview } : {}),
        isCurrent: entry.id === currentLeafId,
        isSelected: entry.id === selectedLeafId,
      };
    })
    .sort((left, right) => {
      if (left.isCurrent !== right.isCurrent) return left.isCurrent ? -1 : 1;
      if (left.updated !== right.updated) return right.updated.localeCompare(left.updated);
      return left.id.localeCompare(right.id);
    });
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
    sessionIds?: string[];
    excludedSessionIds?: string[];
  } = {}): Promise<SessionSummary[]> {
    const files = await collectSessionFiles(this.sessionsDirectory);
    const query = options.query?.trim().toLocaleLowerCase();
    const matchesCwd = await createCwdMatcher(options.cwdScope);
    const includedSessionIds = options.sessionIds ? new Set(options.sessionIds) : undefined;
    const excludedSessionIds = new Set(options.excludedSessionIds ?? []);
    const scopePaths = async (paths: string[]): Promise<string[]> => {
      if (!options.cwdScope && !includedSessionIds && excludedSessionIds.size === 0) return paths;
      const identities = await mapConcurrent(paths, LIST_CONCURRENCY * 2, async (path) => ({
        path,
        identity: await readHeaderIdentity(path),
      }));
      const matches = await Promise.all(identities.map(async ({ path, identity }) => (
        identity
          && (!includedSessionIds || includedSessionIds.has(identity.id))
          && !excludedSessionIds.has(identity.id)
          && await matchesCwd(identity.cwd)
          ? path
          : undefined
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

    if (!query && (
      options.limit !== undefined
      || options.cwdScope !== undefined
      || options.origin !== undefined
      || includedSessionIds !== undefined
      || excludedSessionIds.size > 0
    )) {
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

  async hasDCodeOrigin(summary: SessionSummary): Promise<boolean> {
    const record = await readIndexedSummary(summary.path, "dcode");
    return record?.summary.id === summary.id;
  }

  async hasDescendantSession(parentPath: string): Promise<boolean> {
    const canonicalParent = await canonicalPath(parentPath);
    const files = await collectSessionFiles(this.sessionsDirectory);
    for (const path of files) {
      if (path === parentPath) continue;
      const identity = await readHeaderIdentity(path);
      if (!identity?.parentSession) continue;
      if (await canonicalPath(identity.parentSession) === canonicalParent) return true;
    }
    return false;
  }

  async inspect(sessionId: string, leafId?: string | null): Promise<SessionInspection> {
    const summary = await this.resolve(sessionId);
    return await this.inspectSummary(summary, sessionId, leafId);
  }

  async inspectPath(path: string, sessionId: string, leafId?: string | null): Promise<SessionInspection> {
    const summary = await readSummary(path);
    return await this.inspectSummary(summary, sessionId, leafId);
  }

  private async inspectSummary(
    summary: SessionSummary,
    sessionId: string,
    requestedLeafId?: string | null,
  ): Promise<SessionInspection> {
    const parsed = parseStrictSessionDocument(await readFile(summary.path, "utf8"), summary.path);
    const header = parsed.find((entry): entry is SessionHeader => entry.type === "session");
    if (!header || header.id !== sessionId) {
      throw new SessionReadError("INVALID_SESSION", `Session header mismatch: ${summary.path}`);
    }
    const entries = parsed.filter((entry): entry is SessionEntry => entry.type !== "session");
    const currentLeafId = entries.at(-1)?.id ?? null;
    const { leafId, branch } = buildBranch(entries, requestedLeafId);
    const context = buildSessionContext(entries, leafId);
    const parentSessionId = header.parentSession
      ? (await readHeaderIdentity(header.parentSession))?.id
      : undefined;
    return {
      summary,
      header,
      ...(parentSessionId ? { parentSessionId } : {}),
      leafId,
      currentPathId: pathId(currentLeafId),
      selectedPathId: pathId(leafId),
      paths: sessionPaths(entries, leafId, summary.modified),
      entries: branch,
      context: {
        messageCount: context.messages.length,
        model: normalizedContextModel(context.model),
        thinkingLevel: context.thinkingLevel,
      },
      activePlan: findActivePlan(branch),
    };
  }
}
