import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, rename, rm, unlink, utimes } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface ProductStoreLeaseOwner {
  version: 1;
  pid: number;
  nonce: string;
  startedAt: string;
}

interface ProductStoreLeaseSnapshot {
  owner: ProductStoreLeaseOwner;
  device: string;
  inode: string;
  size: number;
  modifiedAt: number;
}

const HEARTBEAT_INTERVAL_MS = 5_000;

export class ProductStoreLeaseError extends Error {
  constructor(
    readonly code:
      | "PRODUCT_STORE_IN_USE"
      | "PRODUCT_STORE_LEASE_INVALID"
      | "PRODUCT_STORE_LEASE_LOST"
      | "PRODUCT_STORE_LEASE_RACE",
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ProductStoreLeaseError";
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function parseOwner(value: unknown): ProductStoreLeaseOwner | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Partial<ProductStoreLeaseOwner>;
  if (
    candidate.version !== 1
    || !Number.isSafeInteger(candidate.pid)
    || (candidate.pid ?? 0) <= 0
    || typeof candidate.nonce !== "string"
    || candidate.nonce.length === 0
    || typeof candidate.startedAt !== "string"
  ) return undefined;
  return candidate as ProductStoreLeaseOwner;
}

function sameSnapshotIdentity(
  left: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint },
  right: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint },
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs;
}

async function readSnapshot(path: string): Promise<ProductStoreLeaseSnapshot> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const before = await lstat(path, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile()) {
      throw new ProductStoreLeaseError(
        "PRODUCT_STORE_LEASE_INVALID",
        "The D Code Product Store writer lease must be a regular file",
        { path },
      );
    }
    const owner = await readOwner(path);
    const after = await lstat(path, { bigint: true });
    if (!sameSnapshotIdentity(before, after)) continue;
    return {
      owner,
      device: String(after.dev),
      inode: String(after.ino),
      size: Number(after.size),
      modifiedAt: Number(after.mtimeNs / 1_000_000n),
    };
  }
  throw new ProductStoreLeaseError(
    "PRODUCT_STORE_LEASE_RACE",
    "The Product Store writer lease kept changing while D Code read it",
    { path },
  );
}

function sameOwner(left: ProductStoreLeaseOwner, right: ProductStoreLeaseOwner): boolean {
  return left.pid === right.pid && left.nonce === right.nonce && left.startedAt === right.startedAt;
}

async function readOwner(path: string): Promise<ProductStoreLeaseOwner> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (isMissing(error)) throw error;
    throw new ProductStoreLeaseError(
      "PRODUCT_STORE_LEASE_INVALID",
      "The D Code Product Store writer lease is missing or invalid",
      { path, cause: error instanceof Error ? error.message : String(error) },
    );
  }
  const owner = parseOwner(parsed);
  if (!owner) {
    throw new ProductStoreLeaseError(
      "PRODUCT_STORE_LEASE_INVALID",
      "The D Code Product Store writer lease has an unknown shape",
      { path },
    );
  }
  return owner;
}

async function publishOwnerAtomically(path: string, owner: ProductStoreLeaseOwner): Promise<boolean> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${basename(path)}-${owner.nonce}.pending`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(owner, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, path);
    return true;
  } catch (error) {
    if (isAlreadyExists(error)) return false;
    throw error;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export class ProductStoreLease {
  private released = false;
  private heartbeatInFlight = false;
  private readonly heartbeatTimer: ReturnType<typeof setInterval>;

  private constructor(
    readonly path: string,
    readonly owner: ProductStoreLeaseOwner,
  ) {
    this.heartbeatTimer = setInterval(() => { void this.heartbeat(); }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  static async acquire(
    path: string,
    options: {
      pid?: number;
      nonce?: string;
      startedAt?: string;
      beforeStaleRename?: (owner: ProductStoreLeaseOwner) => Promise<void>;
    } = {},
  ): Promise<ProductStoreLease> {
    const pid = options.pid ?? process.pid;
    const owner: ProductStoreLeaseOwner = {
      version: 1,
      pid,
      nonce: options.nonce ?? randomUUID(),
      startedAt: options.startedAt ?? new Date().toISOString(),
    };

    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (await publishOwnerAtomically(path, owner)) return new ProductStoreLease(path, owner);
      let observed: ProductStoreLeaseSnapshot;
      try {
        observed = await readSnapshot(path);
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      const current = observed.owner;
      if (isProcessAlive(current.pid)) {
        throw new ProductStoreLeaseError(
          "PRODUCT_STORE_IN_USE",
          "Another live process owns the Product Store writer lease; D Code fails closed instead of guessing PID reuse",
          { owner: current, heartbeatAge: Date.now() - observed.modifiedAt },
        );
      }
      await options.beforeStaleRename?.(current);
      const stale = `${path}.stale-${randomUUID()}`;
      try {
        await rename(path, stale);
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      let quarantined: ProductStoreLeaseOwner | undefined;
      try {
        quarantined = await readOwner(stale);
      } catch {
        // The path changed after observation. Restore the quarantined evidence below.
      }
      if (
        !quarantined
        || !sameOwner(quarantined, current)
      ) {
        let restored = false;
        try {
          await link(stale, path);
          restored = true;
        } catch (error) {
          if (!isAlreadyExists(error)) throw error;
        }
        if (restored) await unlink(stale);
        throw new ProductStoreLeaseError(
          "PRODUCT_STORE_LEASE_RACE",
          "The Product Store writer lease changed during stale-owner recovery",
          { observed: current, quarantined, evidencePath: restored ? undefined : stale },
        );
      }
      await rm(stale, { force: true });
    }
    throw new ProductStoreLeaseError(
      "PRODUCT_STORE_IN_USE",
      "The D Code Product Store writer lease kept changing during acquisition",
      { path },
    );
  }

  async assertOwned(): Promise<void> {
    if (this.released) {
      throw new ProductStoreLeaseError(
        "PRODUCT_STORE_LEASE_LOST",
        "The D Code Product Store writer lease has already been released",
        { path: this.path },
      );
    }
    let current: ProductStoreLeaseOwner;
    try {
      current = (await readSnapshot(this.path)).owner;
    } catch (error) {
      if (isMissing(error)) {
        throw new ProductStoreLeaseError(
          "PRODUCT_STORE_LEASE_LOST",
          "The D Code Product Store writer lease disappeared",
          { path: this.path },
        );
      }
      throw error;
    }
    if (!sameOwner(current, this.owner)) {
      throw new ProductStoreLeaseError(
        "PRODUCT_STORE_LEASE_LOST",
        "The D Code Product Store writer lease no longer belongs to this Host",
        { expected: this.owner, actual: current },
      );
    }
  }

  private async heartbeat(): Promise<void> {
    if (this.released || this.heartbeatInFlight) return;
    this.heartbeatInFlight = true;
    try {
      await this.assertOwned();
      const now = new Date();
      await utimes(this.path, now, now);
    } catch {
      // The next mutation or release reports lease loss through assertOwned().
    } finally {
      this.heartbeatInFlight = false;
    }
  }

  async release(): Promise<void> {
    if (this.released) return;
    clearInterval(this.heartbeatTimer);
    await this.assertOwned();
    const releasedPath = `${this.path}.released-${this.owner.nonce}`;
    try {
      await rename(this.path, releasedPath);
      await rm(releasedPath, { force: true });
      this.released = true;
    } catch (error) {
      if (isMissing(error)) {
        throw new ProductStoreLeaseError(
          "PRODUCT_STORE_LEASE_LOST",
          "The D Code Product Store writer lease disappeared before release",
          { path: this.path },
        );
      }
      throw error;
    }
  }
}
