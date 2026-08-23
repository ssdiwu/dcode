import { randomUUID } from "node:crypto";
import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import type { SessionSummary } from "./session-reader.js";

export interface ProjectDirectoryMigrationResult {
  relocated: true;
  sourceCwd: string;
  targetCwd: string;
  sessionIds: string[];
  movedFileEntries: string[];
}

export class ProjectDirectoryMigrationError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) {
    super(message);
    this.name = "ProjectDirectoryMigrationError";
  }
}

interface SessionRewritePlan {
  summary: SessionSummary;
  temporaryPath: string;
  backupPath: string;
  replacement: string;
  backupCreated: boolean;
}

interface FileMove {
  source: string;
  target: string;
  name: string;
  moved: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rewriteHeader(
  content: string,
  summary: SessionSummary,
  targetCwd: string,
): string {
  if (!content.endsWith("\n")) {
    throw new ProjectDirectoryMigrationError(
      "INVALID_SESSION",
      `Session ${summary.id} has an incomplete JSONL tail`,
      { sessionId: summary.id, path: summary.path },
    );
  }
  const endOfHeader = content.indexOf("\n");
  if (endOfHeader <= 0) {
    throw new ProjectDirectoryMigrationError(
      "INVALID_SESSION",
      `Session ${summary.id} has no readable Header`,
      { sessionId: summary.id, path: summary.path },
    );
  }
  let header: unknown;
  try {
    header = JSON.parse(content.slice(0, endOfHeader));
  } catch {
    throw new ProjectDirectoryMigrationError(
      "INVALID_SESSION",
      `Session ${summary.id} Header is not valid JSON`,
      { sessionId: summary.id, path: summary.path },
    );
  }
  if (!isRecord(header)
    || header.type !== "session"
    || header.id !== summary.id
    || header.cwd !== summary.cwd) {
    throw new ProjectDirectoryMigrationError(
      "SESSION_CHANGED_DURING_MIGRATION",
      `Session ${summary.id} no longer belongs to the source directory`,
      { sessionId: summary.id, path: summary.path, expectedCwd: summary.cwd, observedCwd: isRecord(header) ? header.cwd : undefined },
    );
  }
  return `${JSON.stringify({ ...header, cwd: targetCwd })}${content.slice(endOfHeader)}`;
}

function assertSeparateDirectories(sourceCwd: string, targetCwd: string): void {
  if (sourceCwd === targetCwd) {
    throw new ProjectDirectoryMigrationError("CWD_UNCHANGED", "The target directory is already the Project directory");
  }
  const sourceToTarget = relative(sourceCwd, targetCwd);
  const targetToSource = relative(targetCwd, sourceCwd);
  if (!sourceToTarget.startsWith("..") && sourceToTarget !== "") {
    throw new ProjectDirectoryMigrationError("TARGET_INSIDE_SOURCE", "The target directory must not be inside the current Project directory");
  }
  if (!targetToSource.startsWith("..") && targetToSource !== "") {
    throw new ProjectDirectoryMigrationError("SOURCE_INSIDE_TARGET", "The current Project directory must not be inside the target directory");
  }
}

async function prepareFileMoves(sourceCwd: string, targetCwd: string, moveFiles: boolean): Promise<FileMove[]> {
  if (!moveFiles) return [];
  assertSeparateDirectories(sourceCwd, targetCwd);
  const targetEntries = await readdir(targetCwd);
  if (targetEntries.length > 0) {
    throw new ProjectDirectoryMigrationError(
      "TARGET_DIRECTORY_NOT_EMPTY",
      "Move files requires an empty target directory; existing files will never be merged or overwritten",
      { targetCwd, entries: targetEntries.slice(0, 20) },
    );
  }
  const sourceEntries = await readdir(sourceCwd);
  return sourceEntries.map((name) => ({
    source: join(sourceCwd, name),
    target: join(targetCwd, name),
    name,
    moved: false,
  }));
}

async function restorePlans(plans: SessionRewritePlan[], fileMoves: FileMove[]): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const plan of [...plans].reverse()) {
    try {
      if (plan.backupCreated) {
        await rename(plan.backupPath, plan.summary.path);
      }
    } catch (error) {
      failures.push({ sessionId: plan.summary.id, step: "restore_header", error: error instanceof Error ? error.message : String(error) });
    }
    try {
      await rm(plan.temporaryPath, { force: true });
    } catch (error) {
      failures.push({ sessionId: plan.summary.id, step: "cleanup_temporary", error: error instanceof Error ? error.message : String(error) });
    }
  }
  for (const move of [...fileMoves].reverse()) {
    if (!move.moved) continue;
    try {
      await rename(move.target, move.source);
    } catch (error) {
      failures.push({ entry: move.name, step: "restore_file", error: error instanceof Error ? error.message : String(error) });
    }
  }
  return failures;
}

/**
 * A bounded, Host-owned Project directory migration. It intentionally rewrites
 * only the persisted Session Header `cwd`: Session IDs, bodies and JSONL paths
 * stay stable, so parent-session references remain valid. Callers must hold and
 * verify a lease for every supplied Session before invoking this transaction.
 */
export class ProjectDirectoryMigrator {
  async relocate(options: {
    sourceCwd: string;
    targetCwd: string;
    sessions: SessionSummary[];
    moveFiles: boolean;
    assertStable: (summary: SessionSummary) => Promise<void>;
  }): Promise<ProjectDirectoryMigrationResult> {
    if (options.sourceCwd === options.targetCwd) {
      throw new ProjectDirectoryMigrationError(
        "CWD_UNCHANGED",
        "The target directory is already the Project directory",
      );
    }
    const targetStat = await stat(options.targetCwd).catch(() => undefined);
    if (!targetStat?.isDirectory()) {
      throw new ProjectDirectoryMigrationError("TARGET_CWD_NOT_ACCESSIBLE", "The target Project directory is not accessible", {
        targetCwd: options.targetCwd,
      });
    }
    const sourceStat = await stat(options.sourceCwd).catch(() => undefined);
    if (!sourceStat?.isDirectory()) {
      throw new ProjectDirectoryMigrationError("SOURCE_CWD_NOT_ACCESSIBLE", "The current Project directory is not accessible", {
        sourceCwd: options.sourceCwd,
      });
    }

    const operationID = randomUUID();
    const plans: SessionRewritePlan[] = [];
    const fileMoves = await prepareFileMoves(options.sourceCwd, options.targetCwd, options.moveFiles);
    try {
      for (const summary of [...options.sessions].sort((left, right) => left.id.localeCompare(right.id))) {
        await options.assertStable(summary);
        const content = await readFile(summary.path, "utf8");
        const replacement = rewriteHeader(content, summary, options.targetCwd);
        const sourceStat = await stat(summary.path);
        const temporaryPath = join(dirname(summary.path), `.${basename(summary.path)}.${operationID}.cwd-pending`);
        const backupPath = join(dirname(summary.path), `.${basename(summary.path)}.${operationID}.cwd-backup`);
        await writeFile(temporaryPath, replacement, { encoding: "utf8", flag: "wx", mode: sourceStat.mode & 0o777 });
        const verified = await readFile(temporaryPath, "utf8");
        if (verified !== replacement) {
          throw new ProjectDirectoryMigrationError("CWD_REWRITE_VERIFY_FAILED", `Cannot verify staged Session ${summary.id}`, {
            sessionId: summary.id,
          });
        }
        plans.push({ summary, temporaryPath, backupPath, replacement, backupCreated: false });
      }

      for (const summary of options.sessions) await options.assertStable(summary);
      for (const move of fileMoves) {
        await rename(move.source, move.target);
        move.moved = true;
      }
      for (const plan of plans) {
        await rename(plan.summary.path, plan.backupPath);
        plan.backupCreated = true;
        await rename(plan.temporaryPath, plan.summary.path);
      }
      for (const plan of plans) {
        const committed = await readFile(plan.summary.path, "utf8");
        if (committed !== plan.replacement) {
          throw new ProjectDirectoryMigrationError("CWD_REWRITE_VERIFY_FAILED", `Cannot verify committed Session ${plan.summary.id}`, {
            sessionId: plan.summary.id,
          });
        }
      }
      for (const plan of plans) await rm(plan.backupPath, { force: true });
      return {
        relocated: true,
        sourceCwd: options.sourceCwd,
        targetCwd: options.targetCwd,
        sessionIds: plans.map((plan) => plan.summary.id),
        movedFileEntries: fileMoves.map((move) => move.name),
      };
    } catch (error) {
      const rollbackFailures = await restorePlans(plans, fileMoves);
      if (rollbackFailures.length > 0) {
        throw new ProjectDirectoryMigrationError(
          "CWD_MIGRATION_ROLLBACK_FAILED",
          "Project directory migration stopped, but one or more staged changes could not be restored",
          {
            cause: error instanceof Error ? error.message : String(error),
            rollbackFailures,
          },
        );
      }
      throw error;
    }
  }
}
