import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

const DEFAULT_QUIET_WINDOW_MS = 500;
const MAX_TAIL_BYTES = 16 * 1024 * 1024;

export interface SessionFingerprint {
  device: string;
  inode: string;
  size: string;
  mtimeNs: string;
  leafId: string | null;
}

export interface SessionLeaseOwner {
  version: 1;
  pid: number;
  nonce: string;
  sessionId: string;
  sessionPath: string;
  acquiredAt: string;
  fingerprint: SessionFingerprint;
}

export class SessionLeaseError extends Error {
  readonly code:
    | "SESSION_IN_USE"
    | "SESSION_NOT_IDLE"
    | "EXTERNAL_WRITE_DETECTED"
    | "LEASE_OWNER_MISMATCH"
    | "LEASE_STOLEN";
  readonly details?: unknown;

  constructor(code: SessionLeaseError["code"], message: string, details?: unknown) {
    super(message);
    this.name = "SessionLeaseError";
    this.code = code;
    this.details = details;
  }
}

function sameFingerprint(left: SessionFingerprint, right: SessionFingerprint): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.leafId === right.leafId;
}

export function sessionSnapshotDigest(entries: readonly unknown[]): string {
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(JSON.stringify(entry));
    hash.update("\n");
  }
  return hash.digest("hex");
}

async function readSessionSnapshotDigest(path: string): Promise<string> {
  const content = await readFile(path, "utf8");
  const entries = content.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as unknown);
  return sessionSnapshotDigest(entries);
}

async function readLastEntryId(path: string): Promise<string | null> {
  const fileStat = await stat(path, { bigint: true });
  if (fileStat.size === 0n) return null;
  const bytesToRead = Number(fileStat.size > BigInt(MAX_TAIL_BYTES) ? BigInt(MAX_TAIL_BYTES) : fileStat.size);
  const start = fileStat.size - BigInt(bytesToRead);
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(bytesToRead);
    await handle.read(buffer, 0, bytesToRead, start);
    const lines = buffer.toString("utf8").trimEnd().split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as { id?: unknown };
        if (typeof entry.id === "string") return entry.id;
      } catch {
        // If the tail starts in the middle of a large entry, continue to the next complete line.
      }
    }
    return null;
  } finally {
    await handle.close();
  }
}

export async function readSessionFingerprint(path: string): Promise<SessionFingerprint> {
  const canonicalPath = await realpath(path);
  const fileStat = await stat(canonicalPath, { bigint: true });
  return {
    device: String(fileStat.dev),
    inode: String(fileStat.ino),
    size: String(fileStat.size),
    mtimeNs: String(fileStat.mtimeNs),
    leafId: await readLastEntryId(canonicalPath),
  };
}

function assertSafeSessionId(sessionId: string): void {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(sessionId)) {
    throw new Error("Unsafe session id");
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

interface ExistingLeaseResolution {
  retry: boolean;
  currentOwner?: unknown;
}

function isMissingPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function leaseOwnerPid(owner: unknown, sessionId: string, sessionPath: string): number | null {
  if (typeof owner !== "object" || owner === null) return null;
  const candidate = owner as Partial<SessionLeaseOwner>;
  if (candidate.version !== 1
    || !Number.isSafeInteger(candidate.pid)
    || (candidate.pid ?? 0) <= 0
    || typeof candidate.nonce !== "string"
    || candidate.sessionId !== sessionId
    || candidate.sessionPath !== sessionPath) {
    return null;
  }
  return candidate.pid ?? null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function resolveExistingLease(
  lockDirectory: string,
  ownerPath: string,
  sessionId: string,
  sessionPath: string,
): Promise<ExistingLeaseResolution> {
  let currentOwner: unknown;
  try {
    currentOwner = JSON.parse(await readFile(ownerPath, "utf8"));
  } catch (error) {
    if (isMissingPathError(error)) {
      try {
        await stat(lockDirectory);
      } catch (directoryError) {
        if (isMissingPathError(directoryError)) return { retry: true };
      }
    }
    return { retry: false };
  }

  const ownerPid = leaseOwnerPid(currentOwner, sessionId, sessionPath);
  if (ownerPid === null || isProcessAlive(ownerPid)) {
    return { retry: false, currentOwner };
  }

  const staleDirectory = `${lockDirectory}.stale-${randomUUID()}`;
  try {
    await rename(lockDirectory, staleDirectory);
  } catch (error) {
    if (isMissingPathError(error)) return { retry: true };
    throw error;
  }
  await rm(staleDirectory, { recursive: true, force: true });
  return { retry: true };
}

async function writeOwner(path: string, owner: SessionLeaseOwner, exclusive: boolean): Promise<void> {
  if (exclusive) {
    await writeFile(path, `${JSON.stringify(owner, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    return;
  }
  const temporary = join(dirname(path), `.owner-${owner.nonce}.tmp`);
  await writeFile(temporary, `${JSON.stringify(owner, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
}

export interface AcquireSessionLeaseOptions {
  agentDir: string;
  sessionId: string;
  sessionPath: string;
  quietWindowMs?: number;
  pid?: number;
  nonce?: string;
  /** 打开即接管：发现存活属主时原子抢占（rename 旧锁目录），旧属主经 LEASE_STOLEN 诚实退出。 */
  force?: boolean;
}

export class SessionLease {
  private released = false;

  private constructor(
    readonly lockDirectory: string,
    readonly ownerPath: string,
    readonly owner: SessionLeaseOwner,
    private expectedFingerprint: SessionFingerprint,
  ) {}

  static async acquire(options: AcquireSessionLeaseOptions): Promise<SessionLease> {
    assertSafeSessionId(options.sessionId);
    const canonicalPath = await realpath(options.sessionPath);
    const leaseRoot = join(options.agentDir, "pi-dcode", "leases");
    const lockDirectory = join(leaseRoot, `${options.sessionId}.lock`);
    const ownerPath = join(lockDirectory, "owner.json");
    await mkdir(leaseRoot, { recursive: true, mode: 0o700 });
    let acquired = false;
    let currentOwner: unknown;
    for (let attempt = 0; attempt < 4 && !acquired; attempt += 1) {
      try {
        await mkdir(lockDirectory, { mode: 0o700 });
        acquired = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const resolution = await resolveExistingLease(
          lockDirectory,
          ownerPath,
          options.sessionId,
          canonicalPath,
        );
        currentOwner = resolution.currentOwner;
        if (!resolution.retry) {
          if (!options.force) {
            throw new SessionLeaseError(
              "SESSION_IN_USE",
              `Session ${options.sessionId} already has a lease`,
              currentOwner,
            );
          }
          // 打开即接管：把存活属主的锁目录原子移走，属主记录随目录一起离开原路径；
          // 旧属主在下次 assertUnchanged 自检时发现 owner 消失，以 LEASE_STOLEN 诚实退出。
          const stolenDirectory = `${lockDirectory}.stolen-${randomUUID()}`;
          try {
            await rename(lockDirectory, stolenDirectory);
          } catch (renameError) {
            if (isMissingPathError(renameError)) continue;
            throw renameError;
          }
          continue;
        }
      }
    }
    if (!acquired) {
      throw new SessionLeaseError(
        "SESSION_IN_USE",
        `Session ${options.sessionId} already has a lease`,
        currentOwner,
      );
    }

    try {
      const before = await readSessionFingerprint(canonicalPath);
      const nonce = options.nonce ?? randomUUID();
      const owner: SessionLeaseOwner = {
        version: 1,
        pid: options.pid ?? process.pid,
        nonce,
        sessionId: options.sessionId,
        sessionPath: canonicalPath,
        acquiredAt: new Date().toISOString(),
        fingerprint: before,
      };
      await writeOwner(ownerPath, owner, true);
      await sleep(options.quietWindowMs ?? DEFAULT_QUIET_WINDOW_MS);
      const after = await readSessionFingerprint(canonicalPath);
      if (!sameFingerprint(before, after)) {
        throw new SessionLeaseError(
          "SESSION_NOT_IDLE",
          `Session ${options.sessionId} changed during the quiet window`,
          { before, after },
        );
      }
      owner.fingerprint = after;
      await writeOwner(ownerPath, owner, false);
      return new SessionLease(lockDirectory, ownerPath, owner, after);
    } catch (error) {
      await rm(lockDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  get fingerprint(): SessionFingerprint {
    return { ...this.expectedFingerprint };
  }

  async assertUnchanged(): Promise<void> {
    this.assertActive();
    await this.assertStillOwner();
    const actual = await readSessionFingerprint(this.owner.sessionPath);
    if (!sameFingerprint(this.expectedFingerprint, actual)) {
      throw new SessionLeaseError(
        "EXTERNAL_WRITE_DETECTED",
        `Session ${this.owner.sessionId} changed outside the current lease`,
        { expected: this.expectedFingerprint, actual },
      );
    }
  }

  /** 属主自检：锁目录被抢占（rename 离开原路径）或 nonce 被替换时立即让位。 */
  private async assertStillOwner(): Promise<void> {
    let stored: { nonce?: unknown };
    try {
      stored = JSON.parse(await readFile(this.ownerPath, "utf8")) as { nonce?: unknown };
    } catch (error) {
      if (isMissingPathError(error)) {
        throw new SessionLeaseError(
          "LEASE_STOLEN",
          `Lease for session ${this.owner.sessionId} was taken over by another D Code instance`,
        );
      }
      throw error;
    }
    if (stored.nonce !== this.owner.nonce) {
      throw new SessionLeaseError(
        "LEASE_STOLEN",
        `Lease for session ${this.owner.sessionId} was taken over by another D Code instance`,
      );
    }
  }

  async acceptOwnedChange(expectedSnapshotDigest?: string): Promise<SessionFingerprint> {
    this.assertActive();
    const before = await readSessionFingerprint(this.owner.sessionPath);
    let next = before;
    if (expectedSnapshotDigest !== undefined) {
      let actualDigest: string;
      try {
        actualDigest = await readSessionSnapshotDigest(this.owner.sessionPath);
      } catch (error) {
        throw new SessionLeaseError(
          "EXTERNAL_WRITE_DETECTED",
          `Session ${this.owner.sessionId} cannot be verified after an owned write`,
          { cause: error instanceof Error ? error.message : String(error) },
        );
      }
      const after = await readSessionFingerprint(this.owner.sessionPath);
      if (!sameFingerprint(before, after)) {
        throw new SessionLeaseError(
          "EXTERNAL_WRITE_DETECTED",
          `Session ${this.owner.sessionId} changed while an owned snapshot was being verified`,
          { reason: "changed_during_verification", before, after },
        );
      }
      if (actualDigest !== expectedSnapshotDigest) {
        throw new SessionLeaseError(
          "EXTERNAL_WRITE_DETECTED",
          `Session ${this.owner.sessionId} contains a change not present in the owning Pi runtime`,
          { reason: "snapshot_mismatch", expectedDigest: expectedSnapshotDigest, actualDigest, before, after },
        );
      }
      next = after;
    }
    this.expectedFingerprint = next;
    this.owner.fingerprint = next;
    await writeOwner(this.ownerPath, this.owner, false);
    return { ...next };
  }

  async release(): Promise<void> {
    this.assertActive();
    let stored: Partial<SessionLeaseOwner>;
    try {
      stored = JSON.parse(await readFile(this.ownerPath, "utf8")) as Partial<SessionLeaseOwner>;
    } catch (error) {
      throw new SessionLeaseError(
        "LEASE_OWNER_MISMATCH",
        "Lease owner record cannot be verified; the lock was retained",
        { cause: error instanceof Error ? error.message : String(error) },
      );
    }
    if (stored.nonce !== this.owner.nonce) {
      throw new SessionLeaseError("LEASE_OWNER_MISMATCH", "Lease owner nonce no longer matches");
    }
    await rm(this.lockDirectory, { recursive: true, force: true });
    this.released = true;
  }

  private assertActive(): void {
    if (this.released) throw new Error("Session lease has already been released");
  }
}
