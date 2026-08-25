import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export const MAX_DCODE_PROMPT_DOCUMENT_BYTES = 64 * 1024;
const MAX_PROMPT_SOURCE_RECEIPTS = 32;

export interface DCodePromptSourceReceipt {
  path: string;
  digest: string;
  bytes: number;
}

export type DCodePromptSourceUnavailableReason =
  | "runtime_cwd_unavailable"
  | "outside_runtime_cwd"
  | "missing"
  | "not_regular_file"
  | "symbolic_link"
  | "too_large"
  | "unreadable"
  | "changed_during_read";

export type DCodePromptSourceReadResult =
  | { kind: "available"; bytes: Buffer }
  | { kind: "unavailable"; reason: DCodePromptSourceUnavailableReason; currentBytes?: number };

export type DCodePromptSourceReadCache = Map<string, Promise<DCodePromptSourceReadResult>>;

export interface DCodePromptSourceState {
  path: string;
  receiptDigest: string;
  receiptBytes: number;
  state: "current_match" | "hash_mismatch" | "historical_unavailable";
  contentStored: false;
  currentDigest?: string;
  currentBytes?: number;
  unavailableReason?: DCodePromptSourceUnavailableReason;
}

export class DCodePromptSourceReceiptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DCodePromptSourceReceiptError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isContainedPath(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== "" && path !== ".." && !path.startsWith("../") && !isAbsolute(path);
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function unavailableReason(error: unknown): DCodePromptSourceUnavailableReason {
  const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
  if (code === "ENOENT") return "missing";
  return "unreadable";
}

export function normalizeDCodePromptSourceReceipts(value: unknown): DCodePromptSourceReceipt[] {
  if (!Array.isArray(value) || value.length > MAX_PROMPT_SOURCE_RECEIPTS) {
    throw new DCodePromptSourceReceiptError("Prompt source receipts must be a bounded array");
  }
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new DCodePromptSourceReceiptError(`Prompt source receipt ${index} is invalid`);
    }
    const path = item.path;
    const receiptDigest = item.digest;
    const bytes = item.bytes;
    if (typeof path !== "string" || path.length === 0 || path.length > 4_096 || !isAbsolute(path) || path.includes("\0")) {
      throw new DCodePromptSourceReceiptError(`Prompt source receipt ${index} has an invalid path`);
    }
    if (typeof receiptDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(receiptDigest)) {
      throw new DCodePromptSourceReceiptError(`Prompt source receipt ${index} has an invalid digest`);
    }
    if (!Number.isSafeInteger(bytes) || (bytes as number) < 0 || (bytes as number) > MAX_DCODE_PROMPT_DOCUMENT_BYTES) {
      throw new DCodePromptSourceReceiptError(`Prompt source receipt ${index} has an invalid byte count`);
    }
    return { path, digest: receiptDigest, bytes: bytes as number };
  });
}

async function canonicalRuntimeRoot(cwd: string): Promise<string | undefined> {
  try {
    const root = await realpath(resolve(cwd));
    const metadata = await lstat(root);
    return metadata.isDirectory() ? root : undefined;
  } catch {
    return undefined;
  }
}

async function readFromCanonicalRoot(
  cwd: string,
  canonicalRoot: string,
  sourcePath: string,
): Promise<DCodePromptSourceReadResult> {
  const lexicalRoot = resolve(cwd);
  const lexicalTarget = resolve(sourcePath);
  if (!isContainedPath(lexicalRoot, lexicalTarget)) {
    return { kind: "unavailable", reason: "outside_runtime_cwd" };
  }
  let metadata;
  try {
    metadata = await lstat(lexicalTarget);
  } catch (error) {
    return { kind: "unavailable", reason: unavailableReason(error) };
  }
  if (metadata.isSymbolicLink()) return { kind: "unavailable", reason: "symbolic_link" };
  if (!metadata.isFile()) return { kind: "unavailable", reason: "not_regular_file" };
  if (metadata.size > MAX_DCODE_PROMPT_DOCUMENT_BYTES) {
    return { kind: "unavailable", reason: "too_large", currentBytes: metadata.size };
  }

  let canonicalTarget: string;
  try {
    canonicalTarget = await realpath(lexicalTarget);
  } catch (error) {
    return { kind: "unavailable", reason: unavailableReason(error) };
  }
  const lexicalRelativePath = relative(lexicalRoot, lexicalTarget);
  const expectedCanonicalTarget = resolve(canonicalRoot, lexicalRelativePath);
  if (canonicalTarget !== expectedCanonicalTarget) {
    return { kind: "unavailable", reason: "symbolic_link" };
  }
  if (!isContainedPath(canonicalRoot, canonicalTarget)) {
    return { kind: "unavailable", reason: "outside_runtime_cwd" };
  }

  let handle;
  try {
    handle = await open(canonicalTarget, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile()) return { kind: "unavailable", reason: "not_regular_file" };
    if (before.size > MAX_DCODE_PROMPT_DOCUMENT_BYTES) {
      return { kind: "unavailable", reason: "too_large", currentBytes: before.size };
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.byteLength > MAX_DCODE_PROMPT_DOCUMENT_BYTES) {
      return { kind: "unavailable", reason: "too_large", currentBytes: bytes.byteLength };
    }
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || after.size !== bytes.byteLength
    ) {
      return { kind: "unavailable", reason: "changed_during_read", currentBytes: after.size };
    }
    let finalCanonicalTarget: string;
    let finalMetadata;
    try {
      [finalCanonicalTarget, finalMetadata] = await Promise.all([
        realpath(lexicalTarget),
        lstat(lexicalTarget),
      ]);
    } catch {
      return { kind: "unavailable", reason: "changed_during_read", currentBytes: after.size };
    }
    if (
      finalCanonicalTarget !== canonicalTarget
      || finalMetadata.isSymbolicLink()
      || !finalMetadata.isFile()
      || finalMetadata.dev !== after.dev
      || finalMetadata.ino !== after.ino
      || finalMetadata.size !== after.size
      || finalMetadata.mtimeMs !== after.mtimeMs
    ) {
      return { kind: "unavailable", reason: "changed_during_read", currentBytes: finalMetadata.size };
    }
    return { kind: "available", bytes };
  } catch (error) {
    return { kind: "unavailable", reason: unavailableReason(error) };
  } finally {
    await handle?.close();
  }
}

export async function readDCodePromptSource(cwd: string, sourcePath: string): Promise<DCodePromptSourceReadResult> {
  const root = await canonicalRuntimeRoot(cwd);
  if (!root) return { kind: "unavailable", reason: "runtime_cwd_unavailable" };
  return await readFromCanonicalRoot(cwd, root, sourcePath);
}

export async function inspectDCodePromptSourceReceipts(
  cwd: string | undefined,
  value: unknown,
  readCache?: DCodePromptSourceReadCache,
): Promise<DCodePromptSourceState[]> {
  const receipts = normalizeDCodePromptSourceReceipts(value);
  if (cwd === undefined) {
    return receipts.map((receipt) => ({
      path: receipt.path,
      receiptDigest: receipt.digest,
      receiptBytes: receipt.bytes,
      state: "historical_unavailable",
      contentStored: false,
      unavailableReason: "runtime_cwd_unavailable",
    }));
  }
  const root = await canonicalRuntimeRoot(cwd);
  if (!root) {
    return receipts.map((receipt) => ({
      path: receipt.path,
      receiptDigest: receipt.digest,
      receiptBytes: receipt.bytes,
      state: "historical_unavailable",
      contentStored: false,
      unavailableReason: "runtime_cwd_unavailable",
    }));
  }
  return await Promise.all(receipts.map(async (receipt) => {
    const cacheKey = `${root}\0${receipt.path}`;
    let currentPromise = readCache?.get(cacheKey);
    if (!currentPromise) {
      currentPromise = readFromCanonicalRoot(cwd, root, receipt.path);
      readCache?.set(cacheKey, currentPromise);
    }
    const current = await currentPromise;
    if (current.kind === "available") {
      const currentDigest = digest(current.bytes);
      return {
        path: receipt.path,
        receiptDigest: receipt.digest,
        receiptBytes: receipt.bytes,
        state: currentDigest === receipt.digest ? "current_match" as const : "hash_mismatch" as const,
        contentStored: false as const,
        currentDigest,
        currentBytes: current.bytes.byteLength,
      };
    }
    if (current.reason === "too_large" && current.currentBytes !== undefined && current.currentBytes !== receipt.bytes) {
      return {
        path: receipt.path,
        receiptDigest: receipt.digest,
        receiptBytes: receipt.bytes,
        state: "hash_mismatch" as const,
        contentStored: false as const,
        currentBytes: current.currentBytes,
      };
    }
    return {
      path: receipt.path,
      receiptDigest: receipt.digest,
      receiptBytes: receipt.bytes,
      state: "historical_unavailable" as const,
      contentStored: false as const,
      ...(current.currentBytes === undefined ? {} : { currentBytes: current.currentBytes }),
      unavailableReason: current.reason,
    };
  }));
}
