import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionCopier, SessionCopyError } from "../src/session-copy.js";
import { SessionReader } from "../src/session-reader.js";

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function assertCopyRejectedWithoutPublishing(
  sourceLines: string[],
  options: { trailingNewline?: boolean; failStabilityCheck?: boolean } = {},
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-dcode-session-copy-invalid-test-"));
  const sessionsDirectory = join(root, "agent", "sessions");
  const sourceCwd = join(root, "source");
  const targetCwd = join(root, "target");
  const sourceDirectory = join(sessionsDirectory, "--source--");
  const sourcePath = join(sourceDirectory, "source-session.jsonl");
  await Promise.all([
    mkdir(sourceDirectory, { recursive: true }),
    mkdir(sourceCwd, { recursive: true }),
    mkdir(targetCwd, { recursive: true }),
  ]);
  const document = `${sourceLines.join("\n")}${options.trailingNewline === false ? "" : "\n"}`;
  await writeFile(sourcePath, document);
  const before = await readFile(sourcePath);
  try {
    await assert.rejects(
      new SessionCopier(sessionsDirectory).copy({
        source: {
          path: sourcePath,
          id: "source-session",
          cwd: await realpath(sourceCwd),
          created: new Date().toISOString(),
          modified: new Date().toISOString(),
          messageCount: 0,
          firstMessage: "",
        },
        targetCwd,
        assertSourceStable: async () => {
          if (options.failStabilityCheck) throw new Error("source changed");
        },
      }),
      (error: unknown) => options.failStabilityCheck
        ? error instanceof Error && error.message === "source changed"
        : error instanceof SessionCopyError && error.code === "INVALID_SESSION",
    );
    assert.equal(sha256(await readFile(sourcePath)), sha256(before));
    const jsonlFiles = (await readdir(sessionsDirectory, { recursive: true }))
      .filter((path) => typeof path === "string" && path.endsWith(".jsonl"));
    assert.deepEqual(jsonlFiles, ["--source--/source-session.jsonl"]);
    const stagingEntries = await readdir(join(root, "agent", ".dcode-session-copy-staging")).catch(() => []);
    assert.equal(stagingEntries.some((entry) => entry.startsWith("operation-")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("copy publishes a new Pi identity with complete history and a fresh D Code origin", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-dcode-session-copy-test-"));
  const sessionsDirectory = join(root, "agent", "sessions");
  const sourceCwd = join(root, "source");
  const targetCwd = join(root, "target");
  const sourceDirectory = join(sessionsDirectory, "--source--");
  const sourcePath = join(sourceDirectory, "2026-08-12_source-session.jsonl");
  await Promise.all([
    mkdir(sourceDirectory, { recursive: true }),
    mkdir(sourceCwd, { recursive: true }),
    mkdir(targetCwd, { recursive: true }),
  ]);
  const timestamp = new Date().toISOString();
  const sourceDocument = [
    { type: "session", version: 3, id: "source-session", timestamp, cwd: await realpath(sourceCwd) },
    {
      type: "custom", id: "source-origin", parentId: null, timestamp,
      customType: "dcode-session-origin-v1", data: { version: 1, sessionId: "source-session" },
    },
    { type: "model_change", id: "model", parentId: "source-origin", timestamp, provider: "openai", modelId: "gpt-test" },
    { type: "thinking_level_change", id: "thinking", parentId: "model", timestamp, thinkingLevel: "high" },
    { type: "session_info", id: "info", parentId: "thinking", timestamp, name: "Copied fixture" },
    { type: "custom", id: "custom-state", parentId: "info", timestamp, customType: "fixture-state", data: { enabled: true } },
    {
      type: "custom_message", id: "custom-message", parentId: "custom-state", timestamp,
      customType: "fixture-context", content: "injected context", display: true,
    },
    { type: "message", id: "user-main", parentId: "custom-message", timestamp, message: { role: "user", content: "main question", timestamp: Date.now() } },
    {
      type: "message", id: "assistant-main", parentId: "user-main", timestamp,
      message: {
        role: "assistant", content: [{ type: "text", text: "main answer" }], api: "test", provider: "openai",
        model: "gpt-test", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} },
        stopReason: "stop", timestamp: Date.now(),
      },
    },
    {
      type: "message", id: "tool-result", parentId: "assistant-main", timestamp,
      message: {
        role: "toolResult", toolCallId: "call-1", toolName: "read",
        content: [{ type: "text", text: "tool output" }], isError: false, timestamp: Date.now(),
      },
    },
    {
      type: "message", id: "bash-result", parentId: "tool-result", timestamp,
      message: {
        role: "bashExecution", command: "pwd", output: "/tmp", exitCode: 0,
        cancelled: false, truncated: false, timestamp: Date.now(),
      },
    },
    {
      type: "compaction", id: "compaction", parentId: "bash-result", timestamp,
      summary: "compact summary", firstKeptEntryId: "user-main", tokensBefore: 42,
    },
    {
      type: "branch_summary", id: "branch-summary", parentId: "compaction", timestamp,
      fromId: "assistant-main", summary: "branch summary",
    },
    { type: "label", id: "label", parentId: "branch-summary", timestamp, targetId: "user-main", label: "checkpoint" },
    { type: "message", id: "user-branch", parentId: "thinking", timestamp, message: { role: "user", content: "branch question", timestamp: Date.now() } },
    {
      type: "message", id: "assistant-branch", parentId: "user-branch", timestamp,
      message: {
        role: "assistant", content: [{ type: "text", text: "branch answer" }], api: "test", provider: "openai",
        model: "gpt-test", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} },
        stopReason: "stop", timestamp: Date.now(),
      },
    },
  ];
  await writeFile(sourcePath, `${sourceDocument.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  const before = await readFile(sourcePath);
  const stagingBase = join(root, "agent", ".dcode-session-copy-staging");
  const staleOperation = join(stagingBase, "operation-stale");
  await mkdir(staleOperation, { recursive: true });
  await writeFile(join(staleOperation, "partial.jsonl"), "partial");
  const old = new Date(Date.now() - 48 * 60 * 60 * 1_000);
  await utimes(staleOperation, old, old);

  try {
    const reader = new SessionReader(sessionsDirectory);
    const source = await reader.resolve("source-session");
    const result = await new SessionCopier(sessionsDirectory).copy({
      source,
      targetCwd,
      assertSourceStable: async () => {
        assert.equal(sha256(await readFile(sourcePath)), sha256(before));
      },
    });
    const targetInspection = await reader.inspect(result.target.id);

    assert.equal(result.copied, true);
    assert.notEqual(result.target.id, source.id);
    assert.equal(result.target.cwd, await realpath(targetCwd));
    assert.equal(targetInspection.header.parentSession, sourcePath);
    assert.equal(targetInspection.parentSessionId, source.id);
    assert.equal(targetInspection.leafId, result.source.leafId);
    assert.equal(result.verification.origin, true);
    assert.equal(sha256(await readFile(sourcePath)), sha256(before));

    const targetDocument = (await readFile(result.target.path, "utf8"))
      .trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(targetDocument[1]?.customType, "dcode-session-origin-v1");
    assert.equal(targetDocument[1]?.parentId, null);
    assert.deepEqual(targetDocument[1]?.data, { version: 1, sessionId: result.target.id });
    assert.deepEqual(targetDocument.slice(2), sourceDocument.slice(1));

    const recent = await reader.list({ origin: "dcode" });
    assert.ok(recent.some((summary) => summary.id === result.target.id));
    await assert.rejects(access(staleOperation));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("copy rejects malformed or unstable sources without publishing a target", async (t) => {
  const timestamp = new Date().toISOString();
  const header = JSON.stringify({
    type: "session",
    version: 3,
    id: "source-session",
    timestamp,
    cwd: "/source",
  });
  const entry = (id: string, parentId: string | null) => JSON.stringify({
    type: "custom",
    id,
    parentId,
    timestamp,
    customType: "fixture",
  });

  await t.test("invalid JSON", async () => {
    await assertCopyRejectedWithoutPublishing([header, "{broken"]);
  });
  await t.test("duplicate entry id", async () => {
    await assertCopyRejectedWithoutPublishing([header, entry("same", null), entry("same", null)]);
  });
  await t.test("missing parent", async () => {
    await assertCopyRejectedWithoutPublishing([header, entry("child", "missing")]);
  });
  await t.test("message record with no readable message", async () => {
    await assertCopyRejectedWithoutPublishing([header, JSON.stringify({
      type: "message",
      id: "bad-message",
      parentId: null,
      timestamp,
      message: null,
    })]);
  });
  await t.test("incomplete trailing entry", async () => {
    await assertCopyRejectedWithoutPublishing([header, entry("complete", null)], { trailingNewline: false });
  });
  await t.test("source stability check fails", async () => {
    await assertCopyRejectedWithoutPublishing([header, entry("complete", null)], { failStabilityCheck: true });
  });
});
