import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  ManagedWorkerWorktreeError,
  planManagedWorkerWorktree,
  provisionManagedWorkerWorktree,
  verifyManagedWorkerWorktree,
  type GitCommandRunner,
} from "../src/managed-worker-worktree.js";

const execFile = promisify(execFileCallback);

const gitRunner: GitCommandRunner = async (args, cwd) => {
  const result = await execFile("git", [...args], { cwd, encoding: "utf8" });
  return { stdout: result.stdout, stderr: result.stderr };
};

async function createRepository(root: string): Promise<{ repository: string; project: string }> {
  const repository = join(root, "repository");
  const project = join(repository, "packages", "app");
  await mkdir(project, { recursive: true });
  await gitRunner(["init", "--initial-branch=main"], repository);
  await gitRunner(["config", "user.email", "dcode-test@example.invalid"], repository);
  await gitRunner(["config", "user.name", "D Code Test"], repository);
  await writeFile(join(project, "README.md"), "source project\n");
  await gitRunner(["add", "."], repository);
  await gitRunner(["commit", "-m", "initial"], repository);
  return { repository, project };
}

test("Managed Worker worktree is detached, isolated and safely reusable by the same Agent Run", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-managed-worker-worktree-"));
  const runtimeDirectory = join(root, ".dcode", "runtime");
  try {
    await mkdir(runtimeDirectory, { recursive: true });
    const { project } = await createRepository(root);
    const plan = await planManagedWorkerWorktree({
      runtimeDirectory,
      projectDirectory: project,
      agentRunId: "agent-run-worker-one",
      gitRunner,
    });
    const worktree = await provisionManagedWorkerWorktree(plan, { gitRunner });
    assert.equal(worktree.reused, false);
    assert.notEqual(worktree.workspaceCwd, project);
    assert.equal((await lstat(join(worktree.worktreeRoot, ".git"))).isFile(), true);
    await writeFile(join(worktree.workspaceCwd, "worker-only.txt"), "isolated\n");
    await assert.rejects(lstat(join(project, "worker-only.txt")), { code: "ENOENT" });

    const reused = await provisionManagedWorkerWorktree(plan, { gitRunner, allowExisting: true });
    assert.equal(reused.reused, true);
    assert.equal((await lstat(join(reused.workspaceCwd, "worker-only.txt"))).isFile(), true);
    await assert.rejects(
      provisionManagedWorkerWorktree(plan, { gitRunner }),
      (error: unknown) => error instanceof ManagedWorkerWorktreeError && error.code === "WORKSPACE_TARGET_UNSAFE",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Managed Worker worktree refuses a dirty source repository before any Git worktree side effect", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-managed-worker-dirty-"));
  const runtimeDirectory = join(root, ".dcode", "runtime");
  try {
    await mkdir(runtimeDirectory, { recursive: true });
    const { project } = await createRepository(root);
    await writeFile(join(project, "uncommitted.txt"), "do not omit this\n");
    await assert.rejects(
      planManagedWorkerWorktree({
        runtimeDirectory,
        projectDirectory: project,
        agentRunId: "agent-run-worker-dirty",
        gitRunner,
      }),
      (error: unknown) => error instanceof ManagedWorkerWorktreeError && error.code === "WORKSPACE_SOURCE_DIRTY",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Managed Worker worktree rechecks the frozen source immediately before Git worktree add", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-managed-worker-source-race-"));
  const runtimeDirectory = join(root, ".dcode", "runtime");
  try {
    await mkdir(runtimeDirectory, { recursive: true });
    const { project } = await createRepository(root);
    const plan = await planManagedWorkerWorktree({
      runtimeDirectory,
      projectDirectory: project,
      agentRunId: "agent-run-worker-source-race",
      gitRunner,
    });
    await writeFile(join(project, "appeared-after-preflight.txt"), "must not be omitted\n");
    await assert.rejects(
      provisionManagedWorkerWorktree(plan, { gitRunner }),
      (error: unknown) => error instanceof ManagedWorkerWorktreeError && error.code === "WORKSPACE_SOURCE_DIRTY",
    );
    await assert.rejects(lstat(plan.worktreeRoot), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Managed Worker worktree rejects replacement by an attached branch at the same commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-managed-worker-attached-"));
  const runtimeDirectory = join(root, ".dcode", "runtime");
  try {
    await mkdir(runtimeDirectory, { recursive: true });
    const { repository, project } = await createRepository(root);
    const plan = await planManagedWorkerWorktree({
      runtimeDirectory,
      projectDirectory: project,
      agentRunId: "agent-run-worker-attached",
      gitRunner,
    });
    await provisionManagedWorkerWorktree(plan, { gitRunner });
    await gitRunner(["worktree", "remove", "--force", plan.worktreeRoot], repository);
    await gitRunner(["worktree", "add", "-b", "dcode-unsafe-attached", plan.worktreeRoot, "HEAD"], repository);

    await assert.rejects(
      verifyManagedWorkerWorktree(plan, gitRunner),
      (error: unknown) => error instanceof ManagedWorkerWorktreeError
        && error.code === "WORKSPACE_WORKTREE_VERIFICATION_FAILED",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
