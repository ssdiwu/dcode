import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiHost } from "../src/pi-host.js";

const execFile = promisify(execFileCallback);

async function initGitProject(directory: string, branch: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await execFile("git", ["init", "-b", branch, directory]);
  await execFile("git", ["-C", directory, "config", "user.email", "test@dcode.local"]);
  await execFile("git", ["-C", directory, "config", "user.name", "D Code Test"]);
  await execFile("git", ["-C", directory, "commit", "--allow-empty", "-m", "init"]);
}

test("project.gitBranch returns the registered project branch and null for non-git directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-git-branch-"));
  const agentDir = join(root, "agent");
  const dataRoot = join(root, ".dcode");
  const userHome = join(root, "home");
  const gitProjectDir = join(root, "project-git");
  const plainProjectDir = join(root, "project-plain");
  await mkdir(join(agentDir, "sessions"), { recursive: true });
  await writeFile(join(agentDir, "settings.json"), "{}\n");
  await initGitProject(gitProjectDir, "feature/visual");
  await mkdir(plainProjectDir, { recursive: true });

  const host = new PiHost({
    agentDir,
    dataRoot,
    userHome,
    emit: () => {},
  });
  try {
    await host.start();
    const snapshot = await host.handle("foundation.snapshot", {}) as {
      storeRevision: number;
      currentUser: { id: string };
    };
    const gitProject = await host.handle("project.create", {
      requestId: "git-project",
      expectedStoreRevision: snapshot.storeRevision,
      title: "Git Project",
      directory: gitProjectDir,
    }) as { project: { id: string }; storeRevision: number };
    const plainProject = await host.handle("project.create", {
      requestId: "plain-project",
      expectedStoreRevision: gitProject.storeRevision,
      title: "Plain Project",
      directory: plainProjectDir,
    }) as { project: { id: string } };

    const gitBranch = await host.handle("project.gitBranch", {
      projectId: gitProject.project.id,
    }) as { branch: string | null };
    assert.equal(gitBranch.branch, "feature/visual");

    const plainBranch = await host.handle("project.gitBranch", {
      projectId: plainProject.project.id,
    }) as { branch: string | null };
    assert.equal(plainBranch.branch, null);

    await assert.rejects(
      host.handle("project.gitBranch", { projectId: "project-missing" }),
      /does not exist/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
