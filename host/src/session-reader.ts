import { createReadStream } from "node:fs";
import { open as openFile, readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import {
  buildSessionContext,
  parseSessionEntries,
  type FileEntry,
  type SessionEntry,
  type SessionHeader,
} from "@earendil-works/pi-coding-agent";

const FIRST_MESSAGE_LIMIT = 280;
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

function compactPreview(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= FIRST_MESSAGE_LIMIT ? compact : `${compact.slice(0, FIRST_MESSAGE_LIMIT - 1)}…`;
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

async function readHeaderSessionId(path: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await openFile(path, "r");
    const chunks: Buffer[] = [];
    let position = 0;
    let foundLineEnd = false;
    while (position < HEADER_SCAN_BYTES) {
      const length = Math.min(HEADER_CHUNK_BYTES, HEADER_SCAN_BYTES - position);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead === 0) break;
      const content = buffer.subarray(0, bytesRead);
      const newline = content.indexOf(0x0A);
      chunks.push(newline < 0 ? content : content.subarray(0, newline));
      position += bytesRead;
      if (newline >= 0) {
        foundLineEnd = true;
        break;
      }
      if (bytesRead < length) break;
    }
    if (chunks.length === 0 || (!foundLineEnd && position >= HEADER_SCAN_BYTES)) return undefined;
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8").trim()) as { type?: unknown; id?: unknown };
    return value.type === "session" && typeof value.id === "string" ? value.id : undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

async function readSummary(path: string): Promise<SessionSummary> {
  const fileStatPromise = stat(path);
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let header: SessionHeader | undefined;
  let name: string | undefined;
  let messageCount = 0;
  let firstMessage = "";

  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof entry !== "object" || entry === null) continue;
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
      if (record.type !== "message") continue;
      messageCount += 1;
      if (firstMessage) continue;
      const message = record.message;
      if (typeof message !== "object" || message === null || (message as { role?: unknown }).role !== "user") continue;
      firstMessage = compactPreview(extractMessageText(message));
    }
  } finally {
    lines.close();
    input.destroy();
  }

  if (!header) throw new SessionReadError("INVALID_SESSION", `Missing session header: ${path}`);
  const fileStat = await fileStatPromise;
  return {
    path,
    id: header.id,
    cwd: header.cwd,
    ...(name ? { name } : {}),
    ...(header.parentSession ? { parentSessionPath: header.parentSession } : {}),
    created: header.timestamp,
    modified: fileStat.mtime.toISOString(),
    messageCount,
    firstMessage,
  };
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

  async list(options: { query?: string; limit?: number } = {}): Promise<SessionSummary[]> {
    const files = await collectSessionFiles(this.sessionsDirectory);
    const query = options.query?.trim().toLocaleLowerCase();
    const readSummaries = async (paths: string[]): Promise<SessionSummary[]> => {
      const settled = await mapConcurrent(paths, LIST_CONCURRENCY, async (path) => {
        try { return await readSummary(path); }
        catch { return undefined; }
      });
      return settled.filter((summary): summary is SessionSummary => summary !== undefined);
    };

    if (!query && options.limit !== undefined) {
      if (options.limit <= 0) return [];
      const ranked = (await mapConcurrent(files, LIST_CONCURRENCY * 2, async (path) => {
        try { return { path, modified: (await stat(path)).mtimeMs }; }
        catch { return undefined; }
      }))
        .filter((entry): entry is { path: string; modified: number } => entry !== undefined)
        .sort((left, right) => right.modified - left.modified);
      const sessions: SessionSummary[] = [];
      const batchSize = Math.max(options.limit, LIST_CONCURRENCY);
      for (let offset = 0; offset < ranked.length && sessions.length < options.limit; offset += batchSize) {
        const batch = ranked.slice(offset, offset + batchSize).map(({ path }) => path);
        sessions.push(...await readSummaries(batch));
      }
      return sessions
        .sort((left, right) => right.modified.localeCompare(left.modified))
        .slice(0, options.limit);
    }

    const sessions = (await readSummaries(files))
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
    const parsed = parseSessionEntries(await readFile(summary.path, "utf8"));
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
