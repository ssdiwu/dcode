import { createReadStream } from "node:fs";
import { chmod, mkdir, open, readdir, realpath, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { D_CODE_SESSION_ORIGIN_TYPE } from "./session-origin.js";
import { extractSearchableMessage, searchEntryDigest } from "./search-entry-digest.js";
import { compactSessionPreview, sessionDisplayTitle } from "./session-title.js";
import type {
  SessionSearchIndexStatus,
  SessionSearchParams,
  SessionSearchResponse,
  SessionSearchResult,
} from "./session-search-index.js";

interface SearchWorkerData {
  sessionsDirectory: string;
  cacheDirectory: string;
}

interface SearchCandidate {
  path: string;
  sessionId: string;
  cwd: string;
  canonicalCwd: string;
  created: string;
  dcodeOrigin: boolean;
  fingerprint: FileFingerprint;
}

interface CandidateDiscovery {
  candidates: SearchCandidate[];
  transientFiles: TransientFile[];
  allPaths: string[];
  visibleFiles: Array<{ path: string; fingerprint: FileFingerprint }>;
}

interface TransientFile {
  path: string;
  sessionId?: string;
  fingerprint: FileFingerprint;
}

interface LeadingRecords {
  records: Record<string, unknown>[];
  transient: boolean;
}

interface CandidateProbe {
  candidate?: SearchCandidate;
  transient?: TransientFile;
}

interface TransientRetry {
  file: TransientFile;
  fingerprint: string;
  attempt: number;
  dueAt: number;
}

interface FileFingerprint {
  device: string;
  inode: string;
  size: string;
  mtimeNs: string;
  modified: string;
}

interface IndexedSessionRow {
  session_id: string;
  path: string;
  canonical_cwd: string;
  device: string;
  inode: string;
  size: string;
  mtime_ns: string;
}

interface StageDocumentRow {
  ordinal: number;
  entry_id: string;
  role: "user" | "assistant";
  body: string;
  tokens: string;
}

interface StagedSession {
  title: string;
  titleEntryId: string | null;
  leafId: string | null;
  dcodeOrigin: boolean;
  fingerprint: FileFingerprint;
}

interface SearchMatchRow {
  doc_id: number;
  session_id: string;
  entry_id: string | null;
  role: "title" | "user" | "assistant";
  body: string;
  score: number;
  title: string;
  cwd: string;
  modified: string;
  match_count: number;
}

interface SearchSessionRow {
  session_id: string;
  title: string;
  cwd: string;
  modified: string;
}

const data = workerData as SearchWorkerData;
if (!parentPort) throw new Error("Search worker requires a parent port");
const port = parentPort;

const DATABASE_VERSION = 2;
const DATABASE_FILENAME = "search-v1.sqlite3";
const LEADING_SCAN_LIMIT = 1_024 * 1_024;
const DISCOVERY_CONCURRENCY = 12;
const TRANSIENT_RETRY_DELAY_MS = 100;
const TRANSIENT_RETRY_MAX_DELAY_MS = 30_000;
const MAX_JSONL_RECORD_BYTES = 16 * 1_024 * 1_024;
const SQLITE_BATCH_SIZE = 128;

let database: DatabaseSync | undefined;
let status: SessionSearchIndexStatus = { state: "idle", complete: false, revision: 0 };
let revision = 0;
let refreshRunning = false;
let requestedScope: string[] = [];
let requestedScopeKey = "";
let completedScopeKey = "";
let invalidationGeneration = 1;
let completedInvalidationGeneration = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let transientRetries = new Map<string, TransientRetry>();
let retryRunning = false;
let workerClosing = false;
let forceDatabaseRebuild = false;
let failedGeneration: number | undefined;
let knownSessionPaths = new Set<string>();
let knownVisibleFingerprints = new Map<string, string>();
let activeFreshnessProbe: {
  scopeKey: string;
  generation: number;
  promise: Promise<boolean>;
} | undefined;

class SearchReadError extends Error {
  constructor(message: string, readonly transient = false) {
    super(message);
    this.name = "SearchReadError";
  }
}

class SearchRefreshCancelled extends Error {
  constructor() {
    super("Search refresh was superseded");
    this.name = "SearchRefreshCancelled";
  }
}

class SearchCacheIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchCacheIntegrityError";
  }
}

class SearchCacheHandleCloseError extends Error {
  constructor(message: string, readonly cause: unknown) {
    super(message);
    this.name = "SearchCacheHandleCloseError";
  }
}

function isRecoverableSQLiteCorruption(error: unknown): boolean {
  if (error instanceof SearchCacheIntegrityError) return true;
  if (error instanceof SearchCacheHandleCloseError) return false;
  if (typeof error !== "object" || error === null) return false;
  const value = error as { code?: unknown; errcode?: unknown };
  if (value.code !== "ERR_SQLITE_ERROR" || typeof value.errcode !== "number") return false;
  const primaryCode = value.errcode & 0xff;
  return primaryCode === 11 || primaryCode === 26;
}

function sendEvent(): void {
  if (workerClosing) return;
  port.postMessage({ type: "event", event: "session.searchIndexChanged", data: status });
}

function updateStatus(next: SessionSearchIndexStatus, emit = true): void {
  status = next;
  if (emit) sendEvent();
}

function markRefreshPending(): void {
  updateStatus({
    state: database ? "updating" : "building",
    complete: false,
    revision,
    progress: { completed: 0, total: 0 },
  });
}

async function canonicalPath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch { return resolve(path); }
}

async function canonicalPaths(paths: readonly string[]): Promise<string[]> {
  return [...new Set(await Promise.all(paths.map(canonicalPath)))].sort();
}

async function collectSessionFiles(root: string, shouldCancel: () => boolean): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    if (shouldCancel()) throw new SearchRefreshCancelled();
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (shouldCancel()) throw new SearchRefreshCancelled();
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
    }
  }
  await visit(root);
  return files;
}

async function mapConcurrent<T, R>(values: readonly T[], limit: number, operation: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  async function run(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      const value = values[index];
      if (value !== undefined) results[index] = await operation(value);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, run));
  return results;
}

async function readLeadingRecords(path: string, count: number): Promise<LeadingRecords> {
  const handle = await open(path, "r");
  try {
    const chunks: Buffer[] = [];
    let position = 0;
    let lineEnds = 0;
    let reachedEnd = false;
    while (position < LEADING_SCAN_LIMIT && lineEnds < count) {
      const buffer = Buffer.allocUnsafe(Math.min(4_096, LEADING_SCAN_LIMIT - position));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
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
    }
    const text = Buffer.concat(chunks).toString("utf8");
    const parts = text.split("\n");
    const trailing = parts.pop() ?? "";
    const lines = parts.filter((line) => line.trim()).slice(0, count);
    const records: Record<string, unknown>[] = [];
    for (const line of lines) {
      let value: unknown;
      try { value = JSON.parse(line); }
      catch { break; }
      if (typeof value !== "object" || value === null || Array.isArray(value)) break;
      records.push(value as Record<string, unknown>);
    }
    const transient = trailing.trim().length > 0 || (!reachedEnd && lineEnds < count);
    return { records, transient };
  } finally {
    await handle.close();
  }
}

function isDCodeOrigin(record: Record<string, unknown>, sessionId: string): boolean {
  const payload = record.data;
  return record.type === "custom"
    && record.parentId === null
    && record.customType === D_CODE_SESSION_ORIGIN_TYPE
    && typeof payload === "object"
    && payload !== null
    && !Array.isArray(payload)
    && (payload as { version?: unknown }).version === 1
    && (payload as { sessionId?: unknown }).sessionId === sessionId;
}

async function fingerprint(path: string): Promise<FileFingerprint> {
  const value = await stat(path, { bigint: true });
  return {
    device: String(value.dev),
    inode: String(value.ino),
    size: String(value.size),
    mtimeNs: String(value.mtimeNs),
    modified: new Date(Number(value.mtimeMs)).toISOString(),
  };
}

function sameFingerprint(left: FileFingerprint, right: FileFingerprint): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs;
}

function fingerprintKey(value: FileFingerprint): string {
  return `${value.device}:${value.inode}:${value.size}:${value.mtimeNs}`;
}

function refreshCancelled(scopeKey: string, generation: number): boolean {
  return workerClosing
    || requestedScopeKey !== scopeKey
    || invalidationGeneration !== generation;
}

async function yieldToWorker(): Promise<void> {
  await new Promise<void>((resolveYield) => setImmediate(resolveYield));
}

async function probeCandidate(
  path: string,
  sourceSet: ReadonlySet<string>,
  shouldCancel: () => boolean,
): Promise<CandidateProbe | undefined> {
  try {
    if (shouldCancel()) throw new SearchRefreshCancelled();
    const headerProbe = await readLeadingRecords(path, 1);
    const header = headerProbe.records[0];
    if (!header
      || header.type !== "session"
      || typeof header.id !== "string"
      || typeof header.cwd !== "string"
      || typeof header.timestamp !== "string") {
      if (!headerProbe.transient) return undefined;
      return { transient: { path, fingerprint: await fingerprint(path) } };
    }
    const canonicalCwd = await canonicalPath(header.cwd);
    if (shouldCancel()) throw new SearchRefreshCancelled();
    const originProbe = await readLeadingRecords(path, 2);
    const origin = originProbe.records[1];
    const dcodeOrigin = origin ? isDCodeOrigin(origin, header.id) : false;
    const fileFingerprint = await fingerprint(path);
    const prefixIncomplete = originProbe.transient
      && !(await hasFinalNewline(path, fileFingerprint.size));
    return {
      candidate: dcodeOrigin || sourceSet.has(canonicalCwd)
        ? {
            path,
            sessionId: header.id,
            cwd: header.cwd,
            canonicalCwd,
            created: header.timestamp,
            dcodeOrigin,
            fingerprint: fileFingerprint,
          }
        : undefined,
      transient: prefixIncomplete
        ? { path, sessionId: header.id, fingerprint: fileFingerprint }
        : undefined,
    };
  } catch (error) {
    if (error instanceof SearchRefreshCancelled) throw error;
    return undefined;
  }
}

async function discoverCandidates(
  sourceFolders: readonly string[],
  shouldCancel: () => boolean,
): Promise<CandidateDiscovery> {
  const files = await collectSessionFiles(data.sessionsDirectory, shouldCancel);
  const sourceSet = new Set(sourceFolders);
  const candidates = await mapConcurrent(
    files,
    DISCOVERY_CONCURRENCY,
    async (path) => await probeCandidate(path, sourceSet, shouldCancel),
  );
  const grouped = new Map<string, SearchCandidate[]>();
  const transientFiles: TransientFile[] = [];
  const visibleFiles: Array<{ path: string; fingerprint: FileFingerprint }> = [];
  for (const discovered of candidates) {
    if (!discovered) continue;
    if (discovered.transient) transientFiles.push(discovered.transient);
    const candidate = discovered.candidate;
    if (!candidate) continue;
    visibleFiles.push({ path: candidate.path, fingerprint: candidate.fingerprint });
    const group = grouped.get(candidate.sessionId) ?? [];
    group.push(candidate);
    grouped.set(candidate.sessionId, group);
  }
  return {
    candidates: [...grouped.values()].filter((group) => group.length === 1).map((group) => group[0] as SearchCandidate),
    transientFiles,
    allPaths: files,
    visibleFiles,
  };
}

async function hasFinalNewline(path: string, size: string): Promise<boolean> {
  const length = Number(size);
  if (!Number.isSafeInteger(length) || length < 1) return false;
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(1);
    const result = await handle.read(buffer, 0, 1, length - 1);
    return result.bytesRead === 1 && buffer[0] === 0x0A;
  } finally {
    await handle.close();
  }
}

async function* readBoundedLines(path: string, shouldCancel: () => boolean): AsyncGenerator<string> {
  const stream = createReadStream(path);
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  try {
    for await (const value of stream) {
      if (shouldCancel()) throw new SearchRefreshCancelled();
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      let start = 0;
      for (let index = 0; index < chunk.length; index += 1) {
        if (chunk[index] !== 0x0A) continue;
        const segment = chunk.subarray(start, index);
        const lineBytes = pendingBytes + segment.length;
        if (lineBytes > MAX_JSONL_RECORD_BYTES) {
          throw new SearchReadError(`Session record exceeds the search limit: ${path}`);
        }
        const line = pending.length > 0
          ? Buffer.concat([...pending, segment], lineBytes)
          : segment;
        pending = [];
        pendingBytes = 0;
        start = index + 1;
        if (shouldCancel()) throw new SearchRefreshCancelled();
        yield line.toString("utf8");
      }
      const trailing = chunk.subarray(start);
      if (trailing.length > 0) {
        pending.push(trailing);
        pendingBytes += trailing.length;
        if (pendingBytes > MAX_JSONL_RECORD_BYTES) {
          throw new SearchReadError(`Session record exceeds the search limit: ${path}`);
        }
      }
    }
    if (pendingBytes > 0) throw new SearchReadError(`Session is still being appended: ${path}`, true);
  } finally {
    stream.destroy();
  }
}

function parseSessionRecord(line: string, path: string, position: number): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(line); }
  catch { throw new SearchReadError(`Invalid JSONL at record ${position}: ${path}`); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SearchReadError(`Invalid session record ${position}: ${path}`);
  }
  return value as Record<string, unknown>;
}

function rollback(database: DatabaseSync): void {
  try { database.exec("ROLLBACK"); }
  catch { /* No transaction was active. */ }
}

function resetStage(database: DatabaseSync): void {
  database.exec(`
    DELETE FROM stage_docs;
    DELETE FROM stage_nodes;
  `);
}

async function stageSession(
  database: DatabaseSync,
  candidate: SearchCandidate,
  shouldCancel: () => boolean,
): Promise<StagedSession> {
  const before = await fingerprint(candidate.path);
  if (!(await hasFinalNewline(candidate.path, before.size))) {
    throw new SearchReadError(`Session is still being appended: ${candidate.path}`, true);
  }
  resetStage(database);
  const insertNode = database.prepare(`
    INSERT INTO stage_nodes(id, parent_id, ordinal, session_name, active)
    VALUES(?, ?, ?, ?, 0)
  `);
  const parentExists = database.prepare("SELECT 1 AS found FROM stage_nodes WHERE id=?");
  let header: Record<string, unknown> | undefined;
  let leafId: string | null = null;
  let recordPosition = 0;
  let dcodeOrigin = false;
  let sessionName: string | undefined;
  database.exec("BEGIN");
  try {
    for await (const line of readBoundedLines(candidate.path, shouldCancel)) {
      if (!line.trim()) continue;
      recordPosition += 1;
      const record = parseSessionRecord(line, candidate.path, recordPosition);
      if (!header) {
        if (record.type !== "session"
          || typeof record.id !== "string"
          || typeof record.cwd !== "string"
          || typeof record.timestamp !== "string") {
          throw new SearchReadError(`Invalid session header: ${candidate.path}`);
        }
        header = record;
        continue;
      }
      if (record.type === "session" || typeof record.type !== "string" || typeof record.id !== "string") {
        throw new SearchReadError(`Invalid session entry ${recordPosition}: ${candidate.path}`);
      }
      if (record.parentId !== null && typeof record.parentId !== "string") {
        throw new SearchReadError(`Invalid parent id in ${candidate.path}`);
      }
      if (typeof record.parentId === "string" && !parentExists.get(record.parentId)) {
        throw new SearchReadError(`Missing parent entry in ${candidate.path}`);
      }
      const stagedSessionName = record.type === "session_info"
        ? (typeof record.name === "string" ? record.name.trim() : "")
        : null;
      if (record.type === "session_info") {
        sessionName = typeof record.name === "string" && record.name.trim()
          ? record.name.trim()
          : undefined;
      }
      if (parentExists.get(record.id)) {
        throw new SearchReadError(`Duplicate entry id in ${candidate.path}`);
      }
      insertNode.run(record.id, record.parentId, recordPosition, stagedSessionName);
      if (recordPosition === 2) dcodeOrigin = isDCodeOrigin(record, header.id as string);
      leafId = record.id;
      if (recordPosition % SQLITE_BATCH_SIZE === 0) {
        await yieldToWorker();
        if (shouldCancel()) throw new SearchRefreshCancelled();
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    rollback(database);
    throw error;
  }
  if (!header || header.id !== candidate.sessionId || header.cwd !== candidate.cwd) {
    throw new SearchReadError(`Session identity changed while indexing: ${candidate.path}`);
  }
  const firstPass = await fingerprint(candidate.path);
  if (!sameFingerprint(before, firstPass)) {
    throw new SearchReadError(`Session changed while indexing: ${candidate.path}`, true);
  }

  const selectParent = database.prepare("SELECT parent_id FROM stage_nodes WHERE id=?");
  const markActive = database.prepare("UPDATE stage_nodes SET active=1 WHERE id=?");
  let activeId = leafId;
  let activeCount = 0;
  while (activeId) {
    const row = selectParent.get(activeId) as { parent_id?: string | null } | undefined;
    if (!row) throw new SearchReadError(`Broken active path in ${candidate.path}`);
    markActive.run(activeId);
    activeId = row.parent_id ?? null;
    activeCount += 1;
    if (activeCount % SQLITE_BATCH_SIZE === 0) {
      await yieldToWorker();
      if (shouldCancel()) throw new SearchRefreshCancelled();
    }
  }

  const isActive = database.prepare("SELECT active FROM stage_nodes WHERE id=?");
  const insertStageDocument = database.prepare(`
    INSERT INTO stage_docs(ordinal, entry_id, role, body, tokens)
    VALUES(?, ?, ?, ?, ?)
  `);
  let firstMessage = "";
  let firstMessageEntryId: string | null = null;
  recordPosition = 0;
  database.exec("BEGIN");
  try {
    for await (const line of readBoundedLines(candidate.path, shouldCancel)) {
      if (!line.trim()) continue;
      recordPosition += 1;
      if (recordPosition === 1) continue;
      const record = parseSessionRecord(line, candidate.path, recordPosition);
      if (typeof record.id !== "string") continue;
      if (record.type !== "message"
        || typeof record.message !== "object" || record.message === null) continue;
      const searchable = extractSearchableMessage(record.message);
      if (!searchable) continue;
      const { role, body } = searchable;
      const active = isActive.get(record.id) as { active?: number } | undefined;
      if (!firstMessage && role === "user") {
        firstMessage = compactSessionPreview(body);
        firstMessageEntryId = record.id;
      }
      if (active?.active !== 1) continue;
      const tokens = tokensFor(body);
      if (!tokens) continue;
      insertStageDocument.run(recordPosition, record.id, role, body, tokens);
      if (recordPosition % SQLITE_BATCH_SIZE === 0) {
        await yieldToWorker();
        if (shouldCancel()) throw new SearchRefreshCancelled();
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    rollback(database);
    throw error;
  }
  const after = await fingerprint(candidate.path);
  if (!sameFingerprint(firstPass, after)) {
    throw new SearchReadError(`Session changed while indexing: ${candidate.path}`, true);
  }
  return {
    title: sessionDisplayTitle({ name: sessionName, firstMessage, cwd: candidate.cwd }),
    titleEntryId: sessionName?.trim() || !firstMessage ? null : firstMessageEntryId,
    leafId,
    dcodeOrigin,
    fingerprint: after,
  };
}

function schema(database: DatabaseSync): void {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 3000;
    PRAGMA temp_store = FILE;
    PRAGMA cache_size = -16384;
    PRAGMA temp.cache_size = -16384;
  `);
  const versionRow = database.prepare("PRAGMA user_version").get() as Record<string, unknown> | undefined;
  const version = Number(versionRow ? Object.values(versionRow)[0] : 0);
  const existingRow = database.prepare(`
    SELECT COUNT(*) AS count FROM sqlite_master
    WHERE name IN ('sessions', 'session_builds', 'docs', 'docs_fts')
  `).get() as { count?: number } | undefined;
  if (version !== DATABASE_VERSION && (existingRow?.count ?? 0) > 0) {
    database.exec(`
      DROP TABLE IF EXISTS docs_fts;
      DROP TABLE IF EXISTS docs;
      DROP TABLE IF EXISTS sessions;
      DROP TABLE IF EXISTS session_builds;
    `);
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS session_builds (
      build_id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      path TEXT NOT NULL,
      cwd TEXT NOT NULL,
      canonical_cwd TEXT NOT NULL,
      title TEXT NOT NULL,
      created TEXT NOT NULL,
      modified TEXT NOT NULL,
      device TEXT NOT NULL,
      inode TEXT NOT NULL,
      size TEXT NOT NULL,
      mtime_ns TEXT NOT NULL,
      leaf_id TEXT,
      dcode_origin INTEGER NOT NULL CHECK(dcode_origin IN (0, 1))
    );
    CREATE INDEX IF NOT EXISTS builds_session ON session_builds(session_id, build_id);
    CREATE INDEX IF NOT EXISTS builds_visible ON session_builds(dcode_origin, canonical_cwd, modified DESC);
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      active_build_id INTEGER NOT NULL UNIQUE REFERENCES session_builds(build_id)
    );
    CREATE TABLE IF NOT EXISTS docs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      build_id INTEGER NOT NULL REFERENCES session_builds(build_id) ON DELETE CASCADE,
      entry_id TEXT,
      role TEXT NOT NULL CHECK(role IN ('title', 'user', 'assistant')),
      body TEXT NOT NULL,
      tokens TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS docs_build ON docs(build_id, id);
    CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(tokens, tokenize='unicode61 remove_diacritics 2');
    CREATE TEMP TABLE IF NOT EXISTS stage_nodes (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      ordinal INTEGER NOT NULL UNIQUE,
      session_name TEXT,
      active INTEGER NOT NULL CHECK(active IN (0, 1))
    );
    CREATE INDEX IF NOT EXISTS stage_nodes_active ON stage_nodes(active, ordinal);
    CREATE TEMP TABLE IF NOT EXISTS stage_docs (
      ordinal INTEGER PRIMARY KEY,
      entry_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      body TEXT NOT NULL,
      tokens TEXT NOT NULL
    );
    PRAGMA user_version = ${DATABASE_VERSION};
  `);
  const integrity = database.prepare("PRAGMA quick_check").get() as Record<string, unknown> | undefined;
  if (!integrity || Object.values(integrity)[0] !== "ok") {
    throw new SearchCacheIntegrityError("Search cache integrity check failed");
  }
}

async function removeDatabaseFiles(): Promise<void> {
  const path = join(data.cacheDirectory, DATABASE_FILENAME);
  for (const suffix of ["", "-wal", "-shm"]) await rm(`${path}${suffix}`, { force: true });
}

async function openDatabase(): Promise<{ database: DatabaseSync; rebuilt: boolean }> {
  if (database) return { database, rebuilt: false };
  await mkdir(data.cacheDirectory, { recursive: true, mode: 0o700 });
  await chmod(data.cacheDirectory, 0o700);
  const path = join(data.cacheDirectory, DATABASE_FILENAME);
  let opened: DatabaseSync | undefined;
  try {
    opened = new DatabaseSync(path);
    schema(opened);
    await chmod(path, 0o600);
    database = opened;
    return { database: opened, rebuilt: false };
  } catch (error) {
    try {
      opened?.close();
    } catch (closeError) {
      throw new SearchCacheHandleCloseError(
        "Search cache failed validation and its database handle could not be closed",
        closeError,
      );
    }
    database = undefined;
    throw error;
  }
}

async function closeAndRemoveDatabase(): Promise<void> {
  const current = database;
  if (current) {
    rollback(current);
    try {
      current.close();
    } catch (error) {
      throw new SearchCacheHandleCloseError(
        "Search cache could not be closed safely before rebuilding",
        error,
      );
    }
    database = undefined;
  }
  await removeDatabaseFiles();
}

function indexedSessions(database: DatabaseSync): Map<string, IndexedSessionRow> {
  const rows = database.prepare(`
    SELECT s.session_id, b.path, b.canonical_cwd, b.device, b.inode, b.size, b.mtime_ns
    FROM sessions s
    JOIN session_builds b ON b.build_id=s.active_build_id
  `).all() as unknown as IndexedSessionRow[];
  return new Map(rows.map((row) => [row.session_id, row]));
}

async function probeFreshness(scopeKey: string, generation: number): Promise<boolean> {
  const existing = activeFreshnessProbe;
  if (existing?.scopeKey === scopeKey && existing.generation === generation) {
    return await existing.promise;
  }
  const shouldCancel = (): boolean => refreshCancelled(scopeKey, generation);
  const promise = (async (): Promise<boolean> => {
    const paths = await collectSessionFiles(data.sessionsDirectory, shouldCancel);
    if (paths.length !== knownSessionPaths.size
      || paths.some((path) => !knownSessionPaths.has(path))) return true;
    const changed = await mapConcurrent(
      [...knownVisibleFingerprints],
      DISCOVERY_CONCURRENCY,
      async ([path, expected]) => {
        if (shouldCancel()) throw new SearchRefreshCancelled();
        try {
          return fingerprintKey(await fingerprint(path)) !== expected;
        } catch {
          return true;
        }
      },
    );
    if (shouldCancel()) throw new SearchRefreshCancelled();
    return changed.some(Boolean);
  })();
  activeFreshnessProbe = { scopeKey, generation, promise };
  try {
    return await promise;
  } finally {
    if (activeFreshnessProbe?.promise === promise) activeFreshnessProbe = undefined;
  }
}

async function deleteBuild(
  database: DatabaseSync,
  buildId: number | bigint,
  shouldCancel: () => boolean = () => false,
): Promise<void> {
  const selectIds = database.prepare("SELECT id FROM docs WHERE build_id=? ORDER BY id LIMIT ?");
  const deleteFts = database.prepare("DELETE FROM docs_fts WHERE rowid=?");
  const deleteDocument = database.prepare("DELETE FROM docs WHERE id=?");
  for (;;) {
    const rows = selectIds.all(buildId, SQLITE_BATCH_SIZE) as unknown as Array<{ id: number }>;
    if (rows.length === 0) break;
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        deleteFts.run(row.id);
        deleteDocument.run(row.id);
      }
      database.exec("COMMIT");
    } catch (error) {
      rollback(database);
      throw error;
    }
    await yieldToWorker();
    if (shouldCancel()) throw new SearchRefreshCancelled();
  }
  database.prepare("DELETE FROM session_builds WHERE build_id=?").run(buildId);
}

async function deleteSession(
  database: DatabaseSync,
  sessionId: string,
  shouldCancel: () => boolean = () => false,
): Promise<void> {
  const builds = database.prepare(
    "SELECT build_id FROM session_builds WHERE session_id=? ORDER BY build_id",
  ).all(sessionId) as unknown as Array<{ build_id: number }>;
  database.prepare("DELETE FROM sessions WHERE session_id=?").run(sessionId);
  for (const build of builds) await deleteBuild(database, build.build_id, shouldCancel);
}

async function cleanupInactiveBuilds(database: DatabaseSync, shouldCancel: () => boolean): Promise<void> {
  const rows = database.prepare(`
    SELECT b.build_id FROM session_builds b
    LEFT JOIN sessions s ON s.active_build_id=b.build_id
    WHERE s.active_build_id IS NULL
    ORDER BY b.build_id LIMIT ?
  `).all(SQLITE_BATCH_SIZE) as unknown as Array<{ build_id: number }>;
  for (const row of rows) await deleteBuild(database, row.build_id, shouldCancel);
}

function tokensFor(text: string): string {
  const normalized = text.normalize("NFKC").toLocaleLowerCase();
  const segments = normalized.match(/\p{Script=Han}+|[\p{L}\p{N}_]+/gu) ?? [];
  const tokens: string[] = [];
  for (const segment of segments) {
    if (/^\p{Script=Han}+$/u.test(segment)) {
      const characters = [...segment];
      tokens.push(...characters);
      for (let index = 0; index + 1 < characters.length; index += 1) {
        tokens.push(`${characters[index] as string}${characters[index + 1] as string}`);
      }
    } else {
      tokens.push(segment);
    }
  }
  return tokens.join(" ");
}

function queryExpression(query: string): string | undefined {
  const normalized = query.normalize("NFKC").toLocaleLowerCase();
  const segments = normalized.match(/\p{Script=Han}+|[\p{L}\p{N}_]+/gu) ?? [];
  const expressions: string[] = [];
  for (const segment of segments) {
    if (/^\p{Script=Han}+$/u.test(segment)) {
      const characters = [...segment];
      const tokens = characters.length === 1
        ? [characters[0] as string]
        : characters.slice(0, -1).map((character, index) => `${character}${characters[index + 1] as string}`);
      expressions.push(`"${tokens.map((token) => token.replaceAll('"', '""')).join(" ")}"`);
    } else {
      expressions.push(`"${segment.replaceAll('"', '""')}"`);
    }
  }
  if (expressions.length === 0) return undefined;
  return expressions.join(" AND ");
}

async function publishStagedSession(
  database: DatabaseSync,
  candidate: SearchCandidate,
  staged: StagedSession,
  shouldCancel: () => boolean,
): Promise<void> {
  const insertedBuild = database.prepare(`
    INSERT INTO session_builds(
      session_id, path, cwd, canonical_cwd, title, created, modified,
      device, inode, size, mtime_ns, leaf_id, dcode_origin
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    candidate.sessionId,
    candidate.path,
    candidate.cwd,
    candidate.canonicalCwd,
    staged.title,
    candidate.created,
    staged.fingerprint.modified,
    staged.fingerprint.device,
    staged.fingerprint.inode,
    staged.fingerprint.size,
    staged.fingerprint.mtimeNs,
    staged.leafId,
    staged.dcodeOrigin ? 1 : 0,
  );
  const buildId = insertedBuild.lastInsertRowid;
  const insertDocument = database.prepare(
    "INSERT INTO docs(build_id, entry_id, role, body, tokens) VALUES(?, ?, ?, ?, ?)",
  );
  const insertFts = database.prepare("INSERT INTO docs_fts(rowid, tokens) VALUES(?, ?)");
  try {
    const titleTokens = tokensFor(staged.title);
    if (titleTokens) {
      const title = insertDocument.run(
        buildId,
        staged.titleEntryId,
        "title",
        staged.title,
        titleTokens,
      );
      insertFts.run(title.lastInsertRowid, titleTokens);
    }
    const selectStageDocuments = database.prepare(`
      SELECT ordinal, entry_id, role, body, tokens FROM stage_docs
      WHERE ordinal>? ORDER BY ordinal LIMIT ?
    `);
    let lastOrdinal = 0;
    for (;;) {
      if (shouldCancel()) throw new SearchRefreshCancelled();
      const rows = selectStageDocuments.all(lastOrdinal, SQLITE_BATCH_SIZE) as unknown as StageDocumentRow[];
      if (rows.length === 0) break;
      database.exec("BEGIN IMMEDIATE");
      try {
        for (const row of rows) {
          const inserted = insertDocument.run(buildId, row.entry_id, row.role, row.body, row.tokens);
          insertFts.run(inserted.lastInsertRowid, row.tokens);
          lastOrdinal = row.ordinal;
        }
        database.exec("COMMIT");
      } catch (error) {
        rollback(database);
        throw error;
      }
      await yieldToWorker();
    }
    const finalFingerprint = await fingerprint(candidate.path);
    if (!sameFingerprint(staged.fingerprint, finalFingerprint)) {
      throw new SearchReadError(`Session changed while publishing its search index: ${candidate.path}`, true);
    }
    if (shouldCancel()) throw new SearchRefreshCancelled();
    const previous = database.prepare(
      "SELECT active_build_id FROM sessions WHERE session_id=?",
    ).get(candidate.sessionId) as { active_build_id?: number } | undefined;
    database.exec("BEGIN IMMEDIATE");
    try {
      database.prepare(`
        INSERT INTO sessions(session_id, active_build_id) VALUES(?, ?)
        ON CONFLICT(session_id) DO UPDATE SET active_build_id=excluded.active_build_id
      `).run(candidate.sessionId, buildId);
      database.exec("COMMIT");
    } catch (error) {
      rollback(database);
      throw error;
    }
    if (previous?.active_build_id !== undefined && previous.active_build_id !== Number(buildId)) {
      await deleteBuild(database, previous.active_build_id, shouldCancel);
    }
  } catch (error) {
    const active = database.prepare(
      "SELECT 1 AS active FROM sessions WHERE active_build_id=?",
    ).get(buildId) as { active?: number } | undefined;
    if (!active) await deleteBuild(database, buildId);
    throw error;
  }
}

async function rebuildSession(
  database: DatabaseSync,
  candidate: SearchCandidate,
  shouldCancel: () => boolean,
): Promise<void> {
  const staged = await stageSession(database, candidate, shouldCancel);
  await publishStagedSession(database, candidate, staged, shouldCancel);
}

async function purgeMissing(
  database: DatabaseSync,
  candidateIds: ReadonlySet<string>,
  protectedIds: ReadonlySet<string>,
  protectedPaths: ReadonlySet<string>,
  shouldCancel: () => boolean,
): Promise<void> {
  const rows = database.prepare(`
    SELECT s.session_id, b.path FROM sessions s
    JOIN session_builds b ON b.build_id=s.active_build_id
  `).all() as unknown as Array<{ session_id: string; path: string }>;
  for (const row of rows) {
    if (candidateIds.has(row.session_id)
      || protectedIds.has(row.session_id)
      || protectedPaths.has(row.path)) continue;
    await deleteSession(database, row.session_id, shouldCancel);
  }
}

function retryDelay(attempt: number): number {
  return Math.min(
    TRANSIENT_RETRY_MAX_DELAY_MS,
    TRANSIENT_RETRY_DELAY_MS * (2 ** Math.min(attempt, 12)),
  );
}

function replaceTransientRetries(files: readonly TransientFile[]): void {
  const now = Date.now();
  const next = new Map<string, TransientRetry>();
  for (const file of new Map(files.map((value) => [value.path, value])).values()) {
    const key = fingerprintKey(file.fingerprint);
    const previous = transientRetries.get(file.path);
    const attempt = previous?.fingerprint === key ? previous.attempt + 1 : 0;
    next.set(file.path, {
      file,
      fingerprint: key,
      attempt,
      dueAt: now + retryDelay(attempt),
    });
  }
  transientRetries = next;
  scheduleTransientRetry();
}

function scheduleTransientRetry(): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = undefined;
  if (workerClosing || refreshRunning || retryRunning || transientRetries.size === 0) return;
  const earliest = Math.min(...[...transientRetries.values()].map((retry) => retry.dueAt));
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    void retryTransientFiles();
  }, Math.max(0, earliest - Date.now()));
  retryTimer.unref?.();
}

async function retryTransientFiles(): Promise<void> {
  if (workerClosing || refreshRunning || retryRunning || transientRetries.size === 0) return;
  retryRunning = true;
  const scopeKey = requestedScopeKey;
  const generation = invalidationGeneration;
  let needsFullRefresh = false;
  try {
    const now = Date.now();
    for (const [path, retry] of [...transientRetries]) {
      if (refreshCancelled(scopeKey, generation)) throw new SearchRefreshCancelled();
      if (retry.dueAt > now) continue;
      let current: FileFingerprint;
      try {
        current = await fingerprint(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          transientRetries.delete(path);
          needsFullRefresh = true;
          continue;
        }
        transientRetries.set(path, {
          ...retry,
          attempt: retry.attempt + 1,
          dueAt: Date.now() + retryDelay(retry.attempt + 1),
        });
        continue;
      }
      if (await hasFinalNewline(path, current.size)) {
        transientRetries.delete(path);
        needsFullRefresh = true;
        continue;
      }
      const key = fingerprintKey(current);
      const attempt = retry.fingerprint === key ? retry.attempt + 1 : 0;
      transientRetries.set(path, {
        file: { ...retry.file, fingerprint: current },
        fingerprint: key,
        attempt,
        dueAt: Date.now() + retryDelay(attempt),
      });
    }
  } catch (error) {
    if (!(error instanceof SearchRefreshCancelled)) {
      updateStatus({
        state: "failed",
        complete: false,
        revision,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    retryRunning = false;
    if (workerClosing) {
      database?.close();
      database = undefined;
      return;
    }
    const requestChanged = refreshCancelled(scopeKey, generation);
    if (needsFullRefresh && !requestChanged) {
      invalidationGeneration += 1;
      startRefresh();
    } else if (requestChanged
      || completedScopeKey !== requestedScopeKey
      || completedInvalidationGeneration !== invalidationGeneration) {
      startRefresh();
    } else {
      scheduleTransientRetry();
    }
  }
}

async function refreshAttempt(
  scope: string[],
  scopeKey: string,
  startedGeneration: number,
  rebuilding: boolean,
  shouldCancel: () => boolean,
): Promise<void> {
    const opened = await openDatabase();
    await cleanupInactiveBuilds(opened.database, shouldCancel);
    const current = indexedSessions(opened.database);
    const initial = current.size === 0;
    updateStatus({
      state: rebuilding || opened.rebuilt ? "rebuilding" : initial ? "building" : "updating",
      complete: false,
      revision,
      progress: { completed: 0, total: 0 },
    });
    const discovery = await discoverCandidates(scope, shouldCancel);
    const transientByPath = new Map(discovery.transientFiles.map((file) => [file.path, file]));
    const stableCandidates = discovery.candidates.filter((candidate) => !transientByPath.has(candidate.path));
    updateStatus({ ...status, progress: { completed: 0, total: stableCandidates.length } });
    let completed = 0;
    for (const candidate of stableCandidates) {
      if (shouldCancel()) throw new SearchRefreshCancelled();
      const indexed = current.get(candidate.sessionId);
      const unchanged = indexed
        && indexed.path === candidate.path
        && indexed.canonical_cwd === candidate.canonicalCwd
        && indexed.device === candidate.fingerprint.device
        && indexed.inode === candidate.fingerprint.inode
        && indexed.size === candidate.fingerprint.size
        && indexed.mtime_ns === candidate.fingerprint.mtimeNs;
      if (!unchanged) {
        try {
          await rebuildSession(opened.database, candidate, shouldCancel);
        } catch (error) {
          if (error instanceof SearchRefreshCancelled) throw error;
          if (!(error instanceof SearchReadError)) throw error;
          if (error.transient) {
              let fileFingerprint = candidate.fingerprint;
              try { fileFingerprint = await fingerprint(candidate.path); }
              catch { /* The next full discovery will resolve a removed file. */ }
              transientByPath.set(candidate.path, {
                path: candidate.path,
                sessionId: candidate.sessionId,
                fingerprint: fileFingerprint,
              });
            } else {
              await deleteSession(opened.database, candidate.sessionId, shouldCancel);
          }
        }
      }
      completed += 1;
      if (completed === stableCandidates.length || completed % 10 === 0) {
        updateStatus({ ...status, progress: { completed, total: stableCandidates.length } });
      }
    }
    if (shouldCancel()) throw new SearchRefreshCancelled();
    const candidateIds = new Set(discovery.candidates.map((candidate) => candidate.sessionId));
    const protectedIds = new Set(
      [...transientByPath.values()].flatMap((file) => file.sessionId ? [file.sessionId] : []),
    );
    await purgeMissing(
      opened.database,
      candidateIds,
      protectedIds,
      new Set(transientByPath.keys()),
      shouldCancel,
    );
    if (shouldCancel()) throw new SearchRefreshCancelled();
    replaceTransientRetries([...transientByPath.values()]);
    knownSessionPaths = new Set(discovery.allPaths);
    knownVisibleFingerprints = new Map(
      discovery.visibleFiles.map((file) => [file.path, fingerprintKey(file.fingerprint)]),
    );
    revision += 1;
    completedScopeKey = scopeKey;
    completedInvalidationGeneration = startedGeneration;
    if (transientByPath.size === 0) {
      updateStatus({ state: "ready", complete: true, revision });
    } else {
      updateStatus({
        state: initial ? "building" : "updating",
        complete: false,
        revision,
        message: "会话仍在写入，索引会在后台重试该文件。",
      });
    }
}

async function refreshIndex(scope: string[], scopeKey: string, startedGeneration: number): Promise<void> {
  refreshRunning = true;
  const shouldCancel = (): boolean => refreshCancelled(scopeKey, startedGeneration);
  let rebuildBeforeAttempt = forceDatabaseRebuild;
  let recoveryUsed = rebuildBeforeAttempt;
  forceDatabaseRebuild = false;
  try {
    for (;;) {
      try {
        if (rebuildBeforeAttempt) {
          updateStatus({ state: "rebuilding", complete: false, revision });
          await closeAndRemoveDatabase();
        }
        await refreshAttempt(scope, scopeKey, startedGeneration, rebuildBeforeAttempt, shouldCancel);
        failedGeneration = undefined;
        break;
      } catch (error) {
        if (error instanceof SearchRefreshCancelled) throw error;
        if (!recoveryUsed && isRecoverableSQLiteCorruption(error)) {
          recoveryUsed = true;
          rebuildBeforeAttempt = true;
          continue;
        }
        throw error;
      }
    }
  } catch (error) {
    if (!(error instanceof SearchRefreshCancelled)) {
      failedGeneration = startedGeneration;
      updateStatus({
        state: "failed",
        complete: false,
        revision,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    refreshRunning = false;
    if (workerClosing) {
      database?.close();
      database = undefined;
      return;
    }
    const changedDuringRefresh = requestedScopeKey !== scopeKey
      || invalidationGeneration !== startedGeneration;
    if (changedDuringRefresh) startRefresh();
    else scheduleTransientRetry();
  }
}

function startRefresh(): void {
  if (workerClosing || refreshRunning || retryRunning) return;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = undefined;
  }
  const scope = [...requestedScope];
  const scopeKey = requestedScopeKey;
  const generation = invalidationGeneration;
  void refreshIndex(scope, scopeKey, generation);
}

function requestDatabaseRebuild(): void {
  if (!forceDatabaseRebuild) {
    forceDatabaseRebuild = true;
    failedGeneration = undefined;
    invalidationGeneration += 1;
  }
  updateStatus({ state: "rebuilding", complete: false, revision });
  startRefresh();
}

function visibilityClause(paths: readonly string[], includeOrigin: boolean): { sql: string; values: string[] } {
  const clauses: string[] = [];
  const values: string[] = [];
  if (includeOrigin) clauses.push("b.dcode_origin=1");
  if (paths.length > 0) {
    clauses.push(`b.canonical_cwd IN (${paths.map(() => "?").join(",")})`);
    values.push(...paths);
  }
  return { sql: clauses.length > 0 ? `(${clauses.join(" OR ")})` : "0", values };
}

function snippet(body: string, query: string): string {
  const compact = body.replace(/\s+/g, " ").trim();
  if (compact.length <= 220) return compact;
  let projected = "";
  const sourceOffsets: number[] = [];
  let sourceOffset = 0;
  for (const character of compact) {
    const normalized = character.normalize("NFKC").toLocaleLowerCase();
    projected += normalized;
    for (let index = 0; index < normalized.length; index += 1) sourceOffsets.push(sourceOffset);
    sourceOffset += character.length;
  }
  const querySegments = query.normalize("NFKC").toLocaleLowerCase()
    .match(/\p{Script=Han}+|[\p{L}\p{N}_]+/gu) ?? [];
  let matchOffset = Number.POSITIVE_INFINITY;
  for (const segment of querySegments) {
    const projectedOffset = projected.indexOf(segment);
    if (projectedOffset < 0) continue;
    matchOffset = Math.min(matchOffset, sourceOffsets[projectedOffset] ?? 0);
  }
  const start = Number.isFinite(matchOffset) ? Math.max(0, matchOffset - 72) : 0;
  const end = Math.min(compact.length, start + 220);
  return `${start > 0 ? "…" : ""}${compact.slice(start, end)}${end < compact.length ? "…" : ""}`;
}

function queryIndex(
  database: DatabaseSync,
  params: SessionSearchParams,
  projectPaths: readonly string[],
  filterPaths: readonly string[] | undefined,
): SessionSearchResult[] {
  const visibility = visibilityClause(filterPaths ?? projectPaths, filterPaths === undefined);
  const trimmed = params.query.trim();
  if (!trimmed) {
    const rows = database.prepare(`
      SELECT s.session_id, b.title, b.cwd, b.modified
      FROM sessions s
      JOIN session_builds b ON b.build_id=s.active_build_id
      WHERE ${visibility.sql}
      ORDER BY b.modified DESC, s.session_id ASC LIMIT ?
    `).all(...visibility.values, params.limit) as unknown as SearchSessionRow[];
    return rows.map((row) => ({
      sessionId: row.session_id,
      matchKind: "title",
      title: row.title,
      cwd: row.cwd,
      modified: row.modified,
      snippet: row.title,
      matchCount: 1,
    }));
  }
  const expression = queryExpression(trimmed);
  if (!expression) return [];
  const rows = database.prepare(`
    WITH raw_matches AS (
      SELECT d.id AS doc_id,
             s.session_id,
             COALESCE('e:' || d.entry_id, 'd:' || d.id) AS semantic_key,
             d.role,
             docs_fts.rank AS score,
             b.modified
      FROM docs_fts
      JOIN docs d ON d.id=docs_fts.rowid
      JOIN session_builds b ON b.build_id=d.build_id
      JOIN sessions s ON s.active_build_id=b.build_id
      WHERE docs_fts MATCH ? AND ${visibility.sql}
    ), semantic_matches AS (
      SELECT doc_id, session_id, semantic_key, role, score, modified,
             ROW_NUMBER() OVER (
               PARTITION BY session_id, semantic_key
               ORDER BY CASE WHEN role='title' THEN 0 ELSE 1 END,
                        score ASC, modified DESC, doc_id ASC
             ) AS semantic_rank
      FROM raw_matches
    ), ranked_matches AS (
      SELECT doc_id, session_id, role, score, modified,
             COUNT(*) OVER (PARTITION BY session_id) AS match_count,
             ROW_NUMBER() OVER (
               PARTITION BY session_id
               ORDER BY CASE WHEN role='title' THEN 0 ELSE 1 END,
                        score ASC,
                        modified DESC,
                        doc_id ASC
             ) AS hit_rank
      FROM semantic_matches
      WHERE semantic_rank=1
    ), winning_matches AS MATERIALIZED (
      SELECT doc_id, session_id, role, score, modified, match_count
      FROM ranked_matches
      WHERE hit_rank=1
      ORDER BY CASE WHEN role='title' THEN 0 ELSE 1 END,
               score ASC, modified DESC, doc_id ASC
      LIMIT ?
    )
    SELECT w.doc_id, w.session_id, d.entry_id, d.role, d.body,
           w.score, b.title, b.cwd, b.modified, w.match_count
    FROM winning_matches w
    JOIN docs d ON d.id=w.doc_id
    JOIN session_builds b ON b.build_id=d.build_id
    ORDER BY CASE WHEN w.role='title' THEN 0 ELSE 1 END,
             w.score ASC, w.modified DESC, w.doc_id ASC
  `).all(expression, ...visibility.values, params.limit) as unknown as SearchMatchRow[];
  return rows.map((best) => ({
      sessionId: best.session_id,
      ...(best.entry_id && (best.role === "user" || best.role === "assistant")
        ? { entryId: best.entry_id, entryDigest: searchEntryDigest(best.role, best.body) }
        : {}),
      matchKind: best.role === "title" ? "title" : "message",
      ...(best.role === "user" || best.role === "assistant" ? { role: best.role } : {}),
      title: best.title,
      cwd: best.cwd,
      modified: best.modified,
      snippet: snippet(best.body, trimmed),
      matchCount: best.match_count,
    }));
}

async function search(params: SessionSearchParams): Promise<SessionSearchResponse> {
  if (workerClosing) {
    throw Object.assign(new Error("Search index closed"), { code: "SEARCH_INDEX_CLOSED" });
  }
  const projectPaths = await canonicalPaths(params.projectSourceFolders);
  const requestedFilterPaths = params.filterSourceFolders === undefined
    ? undefined
    : await canonicalPaths(params.filterSourceFolders);
  const projectPathSet = new Set(projectPaths);
  const filterPaths = requestedFilterPaths === undefined
    ? undefined
    : requestedFilterPaths.every((path) => projectPathSet.has(path))
      ? requestedFilterPaths
      : [];
  const scopeKey = projectPaths.join("\n");
  requestedScope = projectPaths;
  requestedScopeKey = scopeKey;
  if (params.refresh) {
    if (status.state === "failed") forceDatabaseRebuild = true;
    failedGeneration = undefined;
    invalidationGeneration += 1;
  }
  if (!params.refresh && failedGeneration === invalidationGeneration) {
    return { requestToken: params.requestToken, index: status, results: [] };
  }
  const needsRefresh = completedInvalidationGeneration !== invalidationGeneration
    || scopeKey !== completedScopeKey
    || status.state === "idle"
    || forceDatabaseRebuild;
  if (needsRefresh) {
    markRefreshPending();
    startRefresh();
    return { requestToken: params.requestToken, index: status, results: [] };
  }
  if (params.probe) {
    if (status.state !== "ready" || !status.complete) {
      return { requestToken: params.requestToken, index: status, results: [] };
    }
    const probeScopeKey = requestedScopeKey;
    const probeGeneration = invalidationGeneration;
    try {
      const stale = await probeFreshness(probeScopeKey, probeGeneration);
      if (stale && !refreshCancelled(probeScopeKey, probeGeneration)) {
        failedGeneration = undefined;
        invalidationGeneration += 1;
        markRefreshPending();
        startRefresh();
      }
    } catch (error) {
      if (!(error instanceof SearchRefreshCancelled)) throw error;
    }
    return { requestToken: params.requestToken, index: status, results: [] };
  }
  let results: SessionSearchResult[] = [];
  if (database && status.state !== "failed") {
    try {
      results = queryIndex(database, params, projectPaths, filterPaths);
    } catch (error) {
      if (isRecoverableSQLiteCorruption(error)) {
        requestDatabaseRebuild();
        return { requestToken: params.requestToken, index: status, results: [] };
      }
      failedGeneration = invalidationGeneration;
      updateStatus({
        state: "failed",
        complete: false,
        revision,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
  return { requestToken: params.requestToken, index: status, results };
}

port.on("message", (message: unknown) => {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return;
  const value = message as Record<string, unknown>;
  if (value.type === "invalidate") {
    if (status.state === "failed") forceDatabaseRebuild = true;
    failedGeneration = undefined;
    invalidationGeneration += 1;
    markRefreshPending();
    startRefresh();
    return;
  }
  if (value.type === "close") {
    workerClosing = true;
    invalidationGeneration += 1;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = undefined;
    transientRetries.clear();
    if (!refreshRunning && !retryRunning) {
      database?.close();
      database = undefined;
    }
    return;
  }
  if (value.type !== "search" || typeof value.id !== "string") return;
  void search(value.params as unknown as SessionSearchParams).then(
    (result) => port.postMessage({ type: "response", id: value.id, ok: true, result }),
    (error: unknown) => port.postMessage({
      type: "response",
      id: value.id,
      ok: false,
      error: {
        code: typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code
          : "SEARCH_INDEX_FAILED",
        message: error instanceof Error ? error.message : String(error),
      },
    }),
  );
});
