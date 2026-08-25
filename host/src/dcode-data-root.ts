import { homedir } from "node:os";
import { chmod, lstat, mkdir } from "node:fs/promises";
import { basename, isAbsolute, join, parse, resolve } from "node:path";

export const PRODUCT_STORE_FILENAME = "product-store.sqlite3";

export interface DCodeDataRootLayout {
  root: string;
  productStorePath: string;
  runtimeDirectory: string;
  productStoreLeasePath: string;
  migrationsDirectory: string;
  artifactsDirectory: string;
  indexesDirectory: string;
  logsDirectory: string;
  recoveryDirectory: string;
}

export class DCodeDataRootError extends Error {
  readonly code = "INVALID_DCODE_DATA_ROOT";

  constructor(message: string, readonly details?: unknown) {
    super(message);
    this.name = "DCodeDataRootError";
  }
}

function assertSafeRoot(candidate: string): void {
  if (!isAbsolute(candidate)) {
    throw new DCodeDataRootError("D Code data root must be an absolute path", { path: candidate });
  }
  const canonical = resolve(candidate);
  if (canonical === parse(canonical).root) {
    throw new DCodeDataRootError("D Code data root cannot be a filesystem root", { path: candidate });
  }
  if (basename(canonical) !== ".dcode") {
    throw new DCodeDataRootError("D Code data root must be a dedicated .dcode directory", { path: candidate });
  }
}

export function resolveDCodeDataRoot(
  configuredRoot?: string,
  userHome = homedir(),
): DCodeDataRootLayout {
  if (!isAbsolute(userHome)) {
    throw new DCodeDataRootError("User home must be an absolute path", { userHome });
  }
  const rawRoot = configuredRoot ?? join(userHome, ".dcode");
  assertSafeRoot(rawRoot);
  const root = resolve(rawRoot);
  const runtimeDirectory = join(root, "runtime");
  return {
    root,
    productStorePath: join(root, PRODUCT_STORE_FILENAME),
    runtimeDirectory,
    productStoreLeasePath: join(runtimeDirectory, "product-store.lock"),
    migrationsDirectory: join(root, "migrations"),
    artifactsDirectory: join(root, "artifacts"),
    indexesDirectory: join(root, "indexes"),
    logsDirectory: join(root, "logs"),
    recoveryDirectory: join(root, "recovery"),
  };
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export async function prepareManagedDCodeDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new DCodeDataRootError(
      "D Code managed directories must be real directories, not symbolic links or files",
      { path },
    );
  }
  await chmod(path, 0o700);
}

export async function assertSafeProductStoreTarget(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new DCodeDataRootError(
        "D Code Product Store must be a real regular file",
        { path },
      );
    }
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
}
