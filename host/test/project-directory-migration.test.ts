import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectDirectoryMigrationError, ProjectDirectoryMigrator } from "../src/project-directory-migration.js";
import type { SessionSummary } from "../src/session-reader.js";

async function fixture(): Promise<{ root: string; source: string; target: string; summary: SessionSummary; body: string }> {
  const root = await mkdtemp(join(tmpdir(), "dcode-project-directory-migration-"));
  const source = join(root, "source");
  const target = join(root, "target");
  await mkdir(source);
  await mkdir(target);
  const body = `${JSON.stringify({ type: "custom", id: "entry-1", parentId: null, timestamp: "2026-08-23T00:00:01.000Z", customType: "sample", display: false, message: { role: "custom", timestamp: Date.now(), customType: "sample", display: false, content: null } })}\n`;
  const path = join(root, "session.jsonl");
  await writeFile(path, `${JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp: "2026-08-23T00:00:00.000Z", cwd: source })}\n${body}`);
  return {
    root,
    source,
    target,
    summary: {
      path,
      id: "session-1",
      cwd: source,
      created: "2026-08-23T00:00:00.000Z",
      modified: "2026-08-23T00:00:00.000Z",
      messageCount: 0,
      firstMessage: "",
    },
    body,
  };
}

test("project directory migration rewrites only the Session Header cwd and preserves the Session identity", async () => {
  const f = await fixture();
  try {
    const result = await new ProjectDirectoryMigrator().relocate({
      sourceCwd: f.source,
      targetCwd: f.target,
      sessions: [f.summary],
      moveFiles: false,
      assertStable: async () => undefined,
    });
    assert.deepEqual(result.sessionIds, [f.summary.id]);
    assert.deepEqual(result.movedFileEntries, []);
    const rewritten = await readFile(f.summary.path, "utf8");
    const [headerLine, ...bodyLines] = rewritten.split("\n");
    assert.equal(JSON.parse(headerLine ?? "{}").cwd, f.target);
    assert.equal(JSON.parse(headerLine ?? "{}").id, f.summary.id);
    assert.equal(`${bodyLines.filter(Boolean).join("\n")}\n`, f.body);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("project directory migration moves files only when explicitly requested", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.source, "README.md"), "keep me\n");
    const result = await new ProjectDirectoryMigrator().relocate({
      sourceCwd: f.source,
      targetCwd: f.target,
      sessions: [f.summary],
      moveFiles: true,
      assertStable: async () => undefined,
    });
    assert.deepEqual(result.movedFileEntries, ["README.md"]);
    assert.equal(await readFile(join(f.target, "README.md"), "utf8"), "keep me\n");
    assert.deepEqual(await readdir(f.source), []);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("project directory migration may point cwd at a nested directory when files stay in place", async () => {
  const f = await fixture();
  try {
    const nestedTarget = join(f.source, "nested");
    await mkdir(nestedTarget);
    await new ProjectDirectoryMigrator().relocate({
      sourceCwd: f.source,
      targetCwd: nestedTarget,
      sessions: [f.summary],
      moveFiles: false,
      assertStable: async () => undefined,
    });
    const [headerLine] = (await readFile(f.summary.path, "utf8")).split("\n");
    assert.equal(JSON.parse(headerLine ?? "{}").cwd, nestedTarget);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("project directory migration rejects a non-empty target without touching sessions or files", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.source, "README.md"), "source\n");
    await writeFile(join(f.target, "existing.md"), "target\n");
    const before = await readFile(f.summary.path, "utf8");
    await assert.rejects(
      new ProjectDirectoryMigrator().relocate({
        sourceCwd: f.source,
        targetCwd: f.target,
        sessions: [f.summary],
        moveFiles: true,
        assertStable: async () => undefined,
      }),
      (error: unknown) => error instanceof ProjectDirectoryMigrationError && error.code === "TARGET_DIRECTORY_NOT_EMPTY",
    );
    assert.equal(await readFile(f.summary.path, "utf8"), before);
    assert.equal(await readFile(join(f.source, "README.md"), "utf8"), "source\n");
    assert.equal(await readFile(join(f.target, "existing.md"), "utf8"), "target\n");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
