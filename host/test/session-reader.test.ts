import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionReadError, SessionReader } from "../src/session-reader.js";

async function createSessionFixture(
  root: string,
  id: string,
  modifiedOffset = 0,
  cwd = `/tmp/${id}`,
  originSessionId?: string,
): Promise<string> {
  const directory = join(root, `project-${id}`);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `2026-01-01_${id}.jsonl`);
  const timestamp = new Date(Date.now() + modifiedOffset).toISOString();
  const originId = `origin-${id}`;
  const entries = [
    { type: "session", version: 3, id, timestamp, cwd },
    ...(originSessionId === undefined ? [] : [{
      type: "custom",
      id: originId,
      parentId: null,
      timestamp,
      customType: "dcode-session-origin-v1",
      data: { version: 1, sessionId: originSessionId },
    }]),
    { type: "model_change", id: "model-one", parentId: originSessionId === undefined ? null : originId, timestamp, provider: "test", modelId: "model" },
    { type: "thinking_level_change", id: "thinking-one", parentId: "model-one", timestamp, thinkingLevel: "high" },
    { type: "message", id: "user-one", parentId: "thinking-one", timestamp, message: { role: "user", content: "Inspect this project", timestamp: Date.now() } },
    { type: "message", id: "assistant-one", parentId: "user-one", timestamp, message: { role: "assistant", content: [{ type: "text", text: "Done" }], api: "test", provider: "test", model: "model", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() } },
    { type: "custom", id: "plan-one", parentId: "assistant-one", timestamp, customType: "dgoal-work-v1", data: { goal: { id: "goal-one", status: "active", workList: { phases: [] } } } },
    { type: "session_info", id: "name-one", parentId: "plan-one", timestamp, name: `Session ${id}` },
  ];
  await writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  const modified = new Date(Date.now() + modifiedOffset);
  await utimes(path, modified, modified);
  return path;
}

function digest(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

test("list and inspect retain stable session identity without writing", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-dcode-reader-test-"));
  try {
    const path = await createSessionFixture(root, "session-one");
    const before = digest(await readFile(path));
    const reader = new SessionReader(root);
    const sessions = await reader.list();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.id, "session-one");
    assert.equal(sessions[0]?.name, "Session session-one");
    assert.equal(sessions[0]?.firstMessage, "Inspect this project");

    const inspection = await reader.inspect("session-one");
    assert.equal(inspection.header.id, "session-one");
    assert.equal(inspection.leafId, "name-one");
    assert.deepEqual(inspection.context.model, { provider: "test", modelId: "model" });
    assert.equal(inspection.context.thinkingLevel, "high");
    assert.deepEqual(inspection.activePlan, { id: "goal-one", status: "active", workList: { phases: [] } });
    assert.equal(digest(await readFile(path)), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("list filters and sorts sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-dcode-reader-test-"));
  try {
    await createSessionFixture(root, "older", -5_000);
    await createSessionFixture(root, "newer", 0);
    const invalidDirectory = join(root, "project-invalid");
    await mkdir(invalidDirectory, { recursive: true });
    const invalidPath = join(invalidDirectory, "invalid.jsonl");
    await writeFile(invalidPath, "not-json\n");
    const future = new Date(Date.now() + 60_000);
    await utimes(invalidPath, future, future);
    const reader = new SessionReader(root);
    const all = await reader.list();
    assert.deepEqual(all.map((session) => session.id), ["newer", "older"]);
    const limited = await reader.list({ limit: 1 });
    assert.deepEqual(limited.map((session) => session.id), ["newer"]);
    const filtered = await reader.list({ query: "OLDER", limit: 1 });
    assert.deepEqual(filtered.map((session) => session.id), ["older"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("list scopes summaries to exact project folders or the user home", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-dcode-reader-test-"));
  try {
    const home = join(root, "home");
    const sourceA = join(home, "code", "a");
    const sourceB = join(home, "code", "b");
    const outside = join(root, "outside");
    await Promise.all([sourceA, sourceB, outside].map((path) => mkdir(path, { recursive: true })));
    const aPath = await createSessionFixture(root, "a", 0, sourceA);
    const bPath = await createSessionFixture(root, "b", -1_000, sourceB);
    const outsidePath = await createSessionFixture(root, "outside", 1_000, outside);
    const now = Date.now();
    await utimes(aPath, new Date(now), new Date(now));
    await utimes(bPath, new Date(now - 1_000), new Date(now - 1_000));
    await utimes(outsidePath, new Date(now + 1_000), new Date(now + 1_000));
    const reader = new SessionReader(root);

    const exact = await reader.list({
      limit: 10,
      cwdScope: { match: "exact", paths: [sourceA, sourceB] },
    });
    assert.deepEqual(exact.map((session) => session.id), ["a", "b"]);

    const homeSessions = await reader.list({
      limit: 10,
      cwdScope: { match: "descendantOrEqual", paths: [home] },
    });
    assert.deepEqual(homeSessions.map((session) => session.id), ["a", "b"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("D Code origin filtering happens before pagination and rejects inherited markers", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-dcode-reader-test-"));
  try {
    const cwd = join(root, "source");
    await mkdir(cwd, { recursive: true });
    for (let index = 0; index < 12; index += 1) {
      await createSessionFixture(root, `external-${index}`, 20_000 + index, cwd);
    }
    for (let index = 0; index < 11; index += 1) {
      const id = `dcode-${index}`;
      await createSessionFixture(root, id, index, cwd, id);
    }
    await createSessionFixture(root, "copied", 30_000, cwd, "source-session-id");
    const lateMarkerPath = await createSessionFixture(root, "late-marker", 40_000, cwd);
    await appendFile(lateMarkerPath, `${JSON.stringify({
      type: "custom",
      id: "late-origin",
      parentId: null,
      timestamp: new Date().toISOString(),
      customType: "dcode-session-origin-v1",
      data: { version: 1, sessionId: "late-marker" },
    })}\n`);

    const reader = new SessionReader(root);
    const recent = await reader.list({ origin: "dcode", limit: 10 });
    assert.deepEqual(
      recent.map((session) => session.id),
      Array.from({ length: 10 }, (_, offset) => `dcode-${10 - offset}`),
    );

    const project = await reader.list({
      cwdScope: { match: "exact", paths: [cwd] },
      limit: 100,
    });
    assert.equal(project.length, 25);
    assert.ok(project.some((session) => session.id === "external-0"));
    assert.ok(project.some((session) => session.id === "copied"));
    assert.ok(project.some((session) => session.id === "late-marker"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolve handles a multi-chunk header and reports a named invalid session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-dcode-reader-test-"));
  try {
    const directory = join(root, "project-long");
    await mkdir(directory, { recursive: true });
    const timestamp = new Date().toISOString();
    const header = { type: "session", version: 3, id: "long-header", timestamp, cwd: "/tmp/long", metadata: "x".repeat(12_000) };
    const message = { type: "message", id: "user", parentId: null, timestamp, message: { role: "user", content: "hello", timestamp: Date.now() } };
    await writeFile(join(directory, "renamed.jsonl"), `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`);
    await writeFile(join(directory, "2026_broken-id.jsonl"), "not-json\n");
    const reader = new SessionReader(root);
    const inspection = await reader.inspect("long-header");
    assert.equal(inspection.header.id, "long-header");
    await assert.rejects(
      reader.inspect("broken-id"),
      (error: unknown) => error instanceof SessionReadError && error.code === "INVALID_SESSION",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspect rejects a missing session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-dcode-reader-test-"));
  try {
    const reader = new SessionReader(root);
    await assert.rejects(
      reader.inspect("missing"),
      (error: unknown) => error instanceof SessionReadError && error.code === "SESSION_NOT_FOUND",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
