import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { prepareManagedDCodeDirectory } from "./dcode-data-root.js";

const execFile = promisify(execFileCallback);
const GIT_OUTPUT_LIMIT = 64 * 1024;

export const MANAGED_WORKER_WORKTREE_ARTIFACT_KIND = "managed_worker_worktree_v1";
export const MANAGED_WORKER_WORKTREE_TARGET_PREFIX = "git.worktree.add:";

export type ManagedWorkerWorktreeErrorCode =
  | "WORKSPACE_GIT_UNAVAILABLE"
  | "WORKSPACE_GIT_REPOSITORY_REQUIRED"
  | "WORKSPACE_SOURCE_DIRTY"
  | "WORKSPACE_SOURCE_HEAD_REQUIRED"
  | "WORKSPACE_CONTEXT_SOURCE_NOT_MATERIALIZED"
  | "WORKSPACE_TARGET_UNSAFE"
  | "WORKSPACE_WORKTREE_CREATE_FAILED"
  | "WORKSPACE_WORKTREE_CREATE_UNKNOWN"
  | "WORKSPACE_WORKTREE_VERIFICATION_FAILED";

export class ManagedWorkerWorktreeError extends Error {
  constructor(
    readonly code: ManagedWorkerWorktreeErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ManagedWorkerWorktreeError";
  }
}

export interface GitCommandResult {
  stdout: string;
  stderr: string;
}

export type GitCommandRunner = (args: readonly string[], cwd?: string) => Promise<GitCommandResult>;

export interface ManagedWorkerWorktreeSource {
  sourceProjectDirectory: string;
  repositoryRoot: string;
  commonGitDirectory: string;
  baseCommit: string;
  projectRelativePath: string;
}

export interface ManagedWorkerWorktreePlan extends ManagedWorkerWorktreeSource {
  agentRunId: string;
  artifactId: string;
  workspaceId: string;
  worktreeRoot: string;
  workspaceCwd: string;
}

export interface ManagedWorkerWorktree extends ManagedWorkerWorktreePlan {
  reused: boolean;
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith("../") && !isAbsolute(path));
}

function trimmedOutput(value: string): string {
  return value.trim();
}

async function defaultGitRunner(args: readonly string[], cwd?: string): Promise<GitCommandResult> {
  try {
    const result = await execFile("git", [...args], {
      ...(cwd ? { cwd } : {}),
      encoding: "utf8",
      maxBuffer: GIT_OUTPUT_LIMIT,
      windowsHide: true,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const record = error as NodeJS.ErrnoException & { code?: string; stdout?: string; stderr?: string };
    if (record.code === "ENOENT") {
      throw new ManagedWorkerWorktreeError(
        "WORKSPACE_GIT_UNAVAILABLE",
        "Git is unavailable; D Code cannot create an isolated Worker worktree",
      );
    }
    throw error;
  }
}

async function runGit(
  runner: GitCommandRunner,
  args: readonly string[],
  cwd: string,
  errorCode: ManagedWorkerWorktreeErrorCode,
  message: string,
): Promise<string> {
  try {
    return trimmedOutput((await runner(args, cwd)).stdout);
  } catch (error) {
    if (error instanceof ManagedWorkerWorktreeError) throw error;
    throw new ManagedWorkerWorktreeError(errorCode, message);
  }
}

async function canonicalDirectory(path: string, code: ManagedWorkerWorktreeErrorCode, message: string): Promise<string> {
  try {
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) throw new Error("not a directory");
    return canonical;
  } catch {
    throw new ManagedWorkerWorktreeError(code, message);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function managedWorktreeRoot(runtimeDirectory: string, agentRunId: string): Promise<string> {
  const canonicalRuntimeDirectory = await canonicalDirectory(
    runtimeDirectory,
    "WORKSPACE_TARGET_UNSAFE",
    "D Code runtime directory is unavailable for managed Worker worktrees",
  );
  const workspacesDirectory = join(canonicalRuntimeDirectory, "workspaces");
  const workerDirectory = join(workspacesDirectory, "worker");
  await prepareManagedDCodeDirectory(workspacesDirectory);
  await prepareManagedDCodeDirectory(workerDirectory);
  const target = resolve(workerDirectory, `agent-${stableHash(agentRunId)}`);
  if (!isInside(workerDirectory, target) || target === workerDirectory) {
    throw new ManagedWorkerWorktreeError("WORKSPACE_TARGET_UNSAFE", "Managed Worker worktree target is invalid");
  }
  return target;
}

export function managedWorkerWorktreeArtifactId(agentRunId: string): string {
  return `artifact-managed-worker-worktree-${stableHash(agentRunId)}`;
}

export function managedWorkerWorktreeTargetIdentity(artifactId: string): string {
  return `${MANAGED_WORKER_WORKTREE_TARGET_PREFIX}${artifactId}`;
}

export async function inspectManagedWorkerWorktreeSource(input: {
  projectDirectory: string;
  gitRunner?: GitCommandRunner;
}): Promise<ManagedWorkerWorktreeSource> {
  const runner = input.gitRunner ?? defaultGitRunner;
  const sourceProjectDirectory = await canonicalDirectory(
    input.projectDirectory,
    "WORKSPACE_GIT_REPOSITORY_REQUIRED",
    "Worker requires an accessible Project Scope Git directory",
  );
  const repositoryRootText = await runGit(
    runner,
    ["rev-parse", "--show-toplevel"],
    sourceProjectDirectory,
    "WORKSPACE_GIT_REPOSITORY_REQUIRED",
    "Worker requires a Git repository Project Scope",
  );
  if (!repositoryRootText || !isAbsolute(repositoryRootText)) {
    throw new ManagedWorkerWorktreeError(
      "WORKSPACE_GIT_REPOSITORY_REQUIRED",
      "Worker Project Scope did not resolve to an absolute Git repository root",
    );
  }
  const repositoryRoot = await canonicalDirectory(
    repositoryRootText,
    "WORKSPACE_GIT_REPOSITORY_REQUIRED",
    "Worker Git repository root is unavailable",
  );
  if (!isInside(repositoryRoot, sourceProjectDirectory)) {
    throw new ManagedWorkerWorktreeError(
      "WORKSPACE_GIT_REPOSITORY_REQUIRED",
      "Worker Project Scope is not contained by its Git repository root",
    );
  }
  const baseCommit = await runGit(
    runner,
    ["rev-parse", "HEAD"],
    repositoryRoot,
    "WORKSPACE_SOURCE_HEAD_REQUIRED",
    "Worker source Git repository has no resolvable HEAD commit",
  );
  if (!/^[0-9a-f]{40,64}$/i.test(baseCommit)) {
    throw new ManagedWorkerWorktreeError(
      "WORKSPACE_SOURCE_HEAD_REQUIRED",
      "Worker source Git repository returned an invalid HEAD commit",
    );
  }
  const commonGitDirectoryText = await runGit(
    runner,
    ["rev-parse", "--git-common-dir"],
    repositoryRoot,
    "WORKSPACE_GIT_REPOSITORY_REQUIRED",
    "Worker source Git common directory could not be resolved",
  );
  const commonGitDirectory = await canonicalDirectory(
    resolve(repositoryRoot, commonGitDirectoryText),
    "WORKSPACE_GIT_REPOSITORY_REQUIRED",
    "Worker source Git common directory is unavailable",
  );
  const source: ManagedWorkerWorktreeSource = {
    sourceProjectDirectory,
    repositoryRoot,
    commonGitDirectory,
    baseCommit,
    projectRelativePath: relative(repositoryRoot, sourceProjectDirectory),
  };
  await assertManagedWorkerWorktreeSourceStable(source, runner);
  return source;
}

export async function assertManagedWorkerWorktreeSourceStable(
  source: ManagedWorkerWorktreeSource,
  runner: GitCommandRunner = defaultGitRunner,
): Promise<void> {
  const currentHead = await runGit(
    runner,
    ["rev-parse", "HEAD"],
    source.repositoryRoot,
    "WORKSPACE_SOURCE_HEAD_REQUIRED",
    "Worker source Git repository HEAD could not be rechecked",
  );
  if (currentHead !== source.baseCommit) {
    throw new ManagedWorkerWorktreeError(
      "WORKSPACE_SOURCE_HEAD_REQUIRED",
      "Worker source Git repository changed after preflight; no worktree was created",
    );
  }
  const sourceStatus = await runGit(
    runner,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    source.repositoryRoot,
    "WORKSPACE_GIT_REPOSITORY_REQUIRED",
    "Worker source Git repository status could not be checked",
  );
  if (sourceStatus.length > 0) {
    throw new ManagedWorkerWorktreeError(
      "WORKSPACE_SOURCE_DIRTY",
      "Worker source Git repository has uncommitted or untracked files; D Code will not silently omit them",
    );
  }
}

export async function assertManagedWorkerWorktreeContextSourcesMaterialize(input: {
  source: ManagedWorkerWorktreeSource;
  relativePaths: readonly string[];
  includeCurrentAgents?: boolean;
  gitRunner?: GitCommandRunner;
}): Promise<void> {
  const runner = input.gitRunner ?? defaultGitRunner;
  const seen = new Set<string>();
  const relativePaths = [...input.relativePaths];
  if (input.includeCurrentAgents) {
    try {
      const agents = await lstat(join(input.source.sourceProjectDirectory, "AGENTS.md"));
      if (agents.isFile() && !agents.isSymbolicLink()) relativePaths.push("AGENTS.md");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new ManagedWorkerWorktreeError(
          "WORKSPACE_CONTEXT_SOURCE_NOT_MATERIALIZED",
          "Worker could not inspect the required AGENTS.md source",
        );
      }
    }
  }
  for (const relativePath of relativePaths) {
    if (
      typeof relativePath !== "string"
      || relativePath.length === 0
      || isAbsolute(relativePath)
      || relativePath.includes("\0")
    ) {
      throw new ManagedWorkerWorktreeError(
        "WORKSPACE_CONTEXT_SOURCE_NOT_MATERIALIZED",
        "Worker Context Source has an invalid relative path",
      );
    }
    const normalized = relative("/", resolve("/", relativePath));
    if (!normalized || normalized === ".." || normalized.startsWith("../") || isAbsolute(normalized)) {
      throw new ManagedWorkerWorktreeError(
        "WORKSPACE_CONTEXT_SOURCE_NOT_MATERIALIZED",
        "Worker Context Source escapes the Task Project directory",
      );
    }
    const repositoryPath = input.source.projectRelativePath
      ? `${input.source.projectRelativePath}/${normalized}`
      : normalized;
    if (seen.has(repositoryPath)) continue;
    seen.add(repositoryPath);
    const treeEntry = await runGit(
      runner,
      ["ls-tree", "-z", input.source.baseCommit, "--", repositoryPath],
      input.source.repositoryRoot,
      "WORKSPACE_CONTEXT_SOURCE_NOT_MATERIALIZED",
      "Worker could not verify that the selected Context Source exists in its Git revision",
    );
    const entry = treeEntry.split("\0").find((item) => item.length > 0) ?? "";
    if (!/^100(?:644|755) blob [0-9a-f]{40,64}\t/.test(entry)) {
      throw new ManagedWorkerWorktreeError(
        "WORKSPACE_CONTEXT_SOURCE_NOT_MATERIALIZED",
        "Selected Task Context Source is not a regular file in the Worker Git revision",
        { repositoryPath },
      );
    }
  }
}

export async function planManagedWorkerWorktree(input: {
  runtimeDirectory: string;
  agentRunId: string;
  source?: ManagedWorkerWorktreeSource;
  projectDirectory?: string;
  gitRunner?: GitCommandRunner;
}): Promise<ManagedWorkerWorktreePlan> {
  const runner = input.gitRunner ?? defaultGitRunner;
  const source = input.source ?? await inspectManagedWorkerWorktreeSource({
    projectDirectory: input.projectDirectory ?? "",
    gitRunner: runner,
  });
  const artifactId = managedWorkerWorktreeArtifactId(input.agentRunId);
  const worktreeRoot = await managedWorktreeRoot(input.runtimeDirectory, input.agentRunId);
  const workspaceCwd = resolve(worktreeRoot, source.projectRelativePath);
  if (!isInside(worktreeRoot, workspaceCwd)) {
    throw new ManagedWorkerWorktreeError("WORKSPACE_TARGET_UNSAFE", "Worker worktree cwd would escape its managed root");
  }
  return {
    agentRunId: input.agentRunId,
    artifactId,
    workspaceId: `managed-worker-worktree:${artifactId}`,
    worktreeRoot,
    workspaceCwd,
    ...source,
  };
}

export async function verifyManagedWorkerWorktree(
  plan: ManagedWorkerWorktreePlan,
  runner: GitCommandRunner = defaultGitRunner,
): Promise<ManagedWorkerWorktree> {
  const worktreeRoot = await canonicalDirectory(
    plan.worktreeRoot,
    "WORKSPACE_WORKTREE_VERIFICATION_FAILED",
    "Managed Worker worktree root is unavailable",
  );
  if (worktreeRoot !== plan.worktreeRoot) {
    throw new ManagedWorkerWorktreeError(
      "WORKSPACE_TARGET_UNSAFE",
      "Managed Worker worktree root must not be a symbolic link",
    );
  }
  let gitMarker;
  try {
    gitMarker = await lstat(join(worktreeRoot, ".git"));
  } catch {
    throw new ManagedWorkerWorktreeError(
      "WORKSPACE_WORKTREE_VERIFICATION_FAILED",
      "Managed Worker worktree is missing its linked Git marker",
    );
  }
  if (gitMarker.isSymbolicLink() || !gitMarker.isFile()) {
    throw new ManagedWorkerWorktreeError(
      "WORKSPACE_WORKTREE_VERIFICATION_FAILED",
      "Managed Worker worktree Git marker must be a regular linked-worktree file",
    );
  }
  const resolvedRepositoryRoot = await runGit(
    runner,
    ["rev-parse", "--show-toplevel"],
    worktreeRoot,
    "WORKSPACE_WORKTREE_VERIFICATION_FAILED",
    "Managed Worker worktree did not resolve as a Git worktree",
  );
  if ((await canonicalDirectory(
    resolvedRepositoryRoot,
    "WORKSPACE_WORKTREE_VERIFICATION_FAILED",
    "Managed Worker Git root is unavailable",
  )) !== worktreeRoot) {
    throw new ManagedWorkerWorktreeError(
      "WORKSPACE_WORKTREE_VERIFICATION_FAILED",
      "Managed Worker worktree root does not match Git show-toplevel",
    );
  }
  const commonGitDirectoryText = await runGit(
    runner,
    ["rev-parse", "--git-common-dir"],
    worktreeRoot,
    "WORKSPACE_WORKTREE_VERIFICATION_FAILED",
    "Managed Worker worktree common Git directory could not be resolved",
  );
  const commonGitDirectory = await canonicalDirectory(
    resolve(worktreeRoot, commonGitDirectoryText),
    "WORKSPACE_WORKTREE_VERIFICATION_FAILED",
    "Managed Worker worktree common Git directory is unavailable",
  );
  if (commonGitDirectory !== plan.commonGitDirectory) {
    throw new ManagedWorkerWorktreeError(
      "WORKSPACE_WORKTREE_VERIFICATION_FAILED",
      "Managed Worker worktree is not linked to the expected source repository",
    );
  }
  const head = await runGit(
    runner,
    ["rev-parse", "HEAD"],
    worktreeRoot,
    "WORKSPACE_WORKTREE_VERIFICATION_FAILED",
    "Managed Worker worktree HEAD could not be resolved",
  );
  if (head !== plan.baseCommit) {
    throw new ManagedWorkerWorktreeError(
      "WORKSPACE_WORKTREE_VERIFICATION_FAILED",
      "Managed Worker worktree HEAD does not match the declared source revision",
    );
  }
  const branchName = await runGit(
    runner,
    ["rev-parse", "--abbrev-ref", "HEAD"],
    worktreeRoot,
    "WORKSPACE_WORKTREE_VERIFICATION_FAILED",
    "Managed Worker worktree branch state could not be resolved",
  );
  if (branchName !== "HEAD") {
    throw new ManagedWorkerWorktreeError(
      "WORKSPACE_WORKTREE_VERIFICATION_FAILED",
      "Managed Worker worktree must remain detached from every shared branch",
    );
  }
  const workspaceCwd = await canonicalDirectory(
    plan.workspaceCwd,
    "WORKSPACE_WORKTREE_VERIFICATION_FAILED",
    "Managed Worker project directory is unavailable inside its worktree",
  );
  if (!isInside(worktreeRoot, workspaceCwd)) {
    throw new ManagedWorkerWorktreeError(
      "WORKSPACE_TARGET_UNSAFE",
      "Managed Worker project directory escapes its worktree",
    );
  }
  return { ...plan, worktreeRoot, workspaceCwd, reused: false };
}

export async function provisionManagedWorkerWorktree(
  plan: ManagedWorkerWorktreePlan,
  options: {
    gitRunner?: GitCommandRunner;
    allowExisting?: boolean;
    contextRelativePaths?: readonly string[];
    includeCurrentAgents?: boolean;
  } = {},
): Promise<ManagedWorkerWorktree> {
  const runner = options.gitRunner ?? defaultGitRunner;
  if (await pathExists(plan.worktreeRoot)) {
    if (!options.allowExisting) {
      throw new ManagedWorkerWorktreeError(
        "WORKSPACE_TARGET_UNSAFE",
        "Managed Worker worktree target already exists before creation",
      );
    }
    const verified = await verifyManagedWorkerWorktree(plan, runner);
    return { ...verified, reused: true };
  }
  try {
    await assertManagedWorkerWorktreeSourceStable(plan, runner);
    if (options.contextRelativePaths) {
      await assertManagedWorkerWorktreeContextSourcesMaterialize({
        source: plan,
        relativePaths: options.contextRelativePaths,
        includeCurrentAgents: options.includeCurrentAgents,
        gitRunner: runner,
      });
    }
    await runGit(
      runner,
      ["worktree", "add", "--detach", plan.worktreeRoot, plan.baseCommit],
      plan.repositoryRoot,
      "WORKSPACE_WORKTREE_CREATE_FAILED",
      "Git could not create the managed Worker worktree",
    );
  } catch (error) {
    if (
      error instanceof ManagedWorkerWorktreeError
      && [
        "WORKSPACE_GIT_UNAVAILABLE",
        "WORKSPACE_GIT_REPOSITORY_REQUIRED",
        "WORKSPACE_SOURCE_DIRTY",
        "WORKSPACE_SOURCE_HEAD_REQUIRED",
      ].includes(error.code)
    ) {
      throw error;
    }
    const targetExists = await pathExists(plan.worktreeRoot).catch(() => true);
    throw new ManagedWorkerWorktreeError(
      targetExists ? "WORKSPACE_WORKTREE_CREATE_UNKNOWN" : "WORKSPACE_WORKTREE_CREATE_FAILED",
      targetExists
        ? "Git worktree creation did not complete verifiably; D Code will not retry it automatically"
        : "Git worktree creation failed before a managed worktree became visible",
    );
  }
  return await verifyManagedWorkerWorktree(plan, runner);
}
