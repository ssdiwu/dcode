import assert from "node:assert/strict";
import { appendFile, chmod, mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { searchEntryDigest } from "../src/search-entry-digest.js";
import { D_CODE_SESSION_ORIGIN_TYPE, SessionReader } from "../src/session-reader.js";
import { SessionSearchIndex, type SessionSearchIndexStatus } from "../src/session-search-index.js";

async function waitForReady(statuses: SessionSearchIndexStatus[]): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!statuses.some((status) => status.state === "ready")) {
    if (statuses.some((status) => status.state === "failed")) {
      throw new Error(`Search index failed: ${statuses.at(-1)?.message ?? "unknown"}`);
    }
    if (Date.now() >= deadline) throw new Error("Timed out waiting for search index");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForReadyAfter(
  statuses: SessionSearchIndexStatus[],
  revision: number,
  afterEventIndex = 0,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!statuses.slice(afterEventIndex)
    .some((status) => status.state === "ready" && (status.revision ?? 0) > revision)) {
    if (statuses.slice(afterEventIndex).some((status) => status.state === "failed")) {
      throw new Error(`Search index failed: ${statuses.at(-1)?.message ?? "unknown"}`);
    }
    if (Date.now() >= deadline) throw new Error("Timed out waiting for a newer search index revision");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForStatus(
  statuses: SessionSearchIndexStatus[],
  predicate: (status: SessionSearchIndexStatus) => boolean,
  timeoutMessage: string,
): Promise<SessionSearchIndexStatus> {
  const deadline = Date.now() + 5_000;
  while (true) {
    const match = statuses.find(predicate);
    if (match) return match;
    if (statuses.some((status) => status.state === "failed")) {
      throw new Error(`Search index failed: ${statuses.at(-1)?.message ?? "unknown"}`);
    }
    if (Date.now() >= deadline) throw new Error(timeoutMessage);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function header(id: string, cwd: string): Record<string, unknown> {
  return { type: "session", version: 3, id, timestamp: "2026-08-11T08:00:00.000Z", cwd };
}

function origin(id: string): Record<string, unknown> {
  return {
    type: "custom",
    id: `${id}-origin`,
    parentId: null,
    timestamp: "2026-08-11T08:00:01.000Z",
    customType: D_CODE_SESSION_ORIGIN_TYPE,
    data: { version: 1, sessionId: id },
  };
}

function message(
  id: string,
  parentId: string | null,
  role: "user" | "assistant",
  text: string,
): Record<string, unknown> {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-08-11T08:00:02.000Z",
    message: role === "user"
      ? { role, content: text, timestamp: 1 }
      : {
          role,
          content: [{ type: "text", text }],
          api: "openai-responses",
          provider: "openai",
          model: "test",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} },
          stopReason: "stop",
          timestamp: 2,
        },
  };
}

async function writeSession(path: string, entries: Record<string, unknown>[]): Promise<void> {
  await writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

test("search indexes only D Code recent and exact project sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-search-test-"));
  const sessions = join(root, "sessions");
  const cache = join(root, "cache");
  const project = join(root, "project");
  const child = join(project, "child");
  const hidden = join(root, "hidden");
  await Promise.all([sessions, project, child, hidden].map((path) => mkdir(path, { recursive: true })));

  const recentPath = join(sessions, "recent.jsonl");
  const projectPath = join(sessions, "project.jsonl");
  const childPath = join(sessions, "child.jsonl");
  const hiddenPath = join(sessions, "hidden.jsonl");
  await writeSession(recentPath, [
    header("recent", hidden),
    origin("recent"),
    message("recent-user", "recent-origin", "user", "讨论项目搜索与中文体验"),
    message("recent-assistant", "recent-user", "assistant", "项目搜索应该立即出现结果"),
  ]);
  await writeSession(projectPath, [
    header("project", project),
    message("project-user", null, "user", "Workspace Search"),
    message("project-assistant", "project-user", "assistant", "English body is searchable"),
  ]);
  await writeSession(childPath, [
    header("child", child),
    message("child-user", null, "user", "项目子目录不应被索引"),
  ]);
  await writeSession(hiddenPath, [
    header("hidden", hidden),
    message("hidden-user", null, "user", "项目未关联旧会话"),
  ]);
  const originalRecent = await readFile(recentPath);
  const statuses: SessionSearchIndexStatus[] = [];
  const index = new SessionSearchIndex({
    sessionsDirectory: sessions,
    cacheDirectory: cache,
    emit: (event, value) => {
      if (event === "session.searchIndexChanged") statuses.push(value as SessionSearchIndexStatus);
    },
  });
  try {
    const first = await index.search({
      query: "项目",
      requestToken: "first",
      limit: 50,
      projectSourceFolders: [project],
      refresh: true,
    });
    assert.equal(first.requestToken, "first");
    assert.ok(["idle", "building", "updating", "rebuilding"].includes(first.index.state));
    await waitForReady(statuses);

    const result = await index.search({
      query: "项目",
      requestToken: "ready",
      limit: 50,
      projectSourceFolders: [project],
      refresh: false,
    });
    assert.equal(result.index.state, "ready");
    assert.deepEqual(result.results.map((row) => row.sessionId), ["recent"]);
    assert.equal(result.results[0]?.matchCount, 2);
    assert.equal(result.results[0]?.matchKind, "title");
    assert.equal(result.results[0]?.entryId, undefined);

    const exactAssistant = await index.search({
      query: "立即出现",
      requestToken: "digest",
      limit: 50,
      projectSourceFolders: [project],
      refresh: false,
    });
    assert.equal(exactAssistant.results[0]?.entryId, "recent-assistant");
    assert.equal(
      exactAssistant.results[0]?.entryDigest,
      searchEntryDigest("assistant", "项目搜索应该立即出现结果"),
    );

    const english = await index.search({
      query: "WORKSPACE",
      requestToken: "english",
      limit: 50,
      projectSourceFolders: [project],
      refresh: false,
    });
    assert.deepEqual(english.results.map((row) => row.sessionId), ["project"]);

    const filtered = await index.search({
      query: "",
      requestToken: "filtered",
      limit: 50,
      projectSourceFolders: [project],
      filterSourceFolders: [project],
      refresh: false,
    });
    assert.deepEqual(filtered.results.map((row) => row.sessionId), ["project"]);
    assert.deepEqual(await readFile(recentPath), originalRecent);
  } finally {
    await index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("freshness probes update, remove, and discover non-active visible sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-search-external-change-test-"));
  const sessions = join(root, "sessions");
  const cache = join(root, "cache");
  const project = join(root, "project");
  const hidden = join(root, "hidden");
  await Promise.all([sessions, project, hidden].map((path) => mkdir(path, { recursive: true })));
  const sessionPath = join(sessions, "external.jsonl");
  const hiddenPath = join(sessions, "hidden.jsonl");
  await writeSession(sessionPath, [
    header("external", project),
    message("external-user", null, "user", "旧正文仍在索引中"),
  ]);
  await writeSession(hiddenPath, [
    header("hidden", hidden),
    message("hidden-user", null, "user", "未关联旧会话"),
  ]);
  const statuses: SessionSearchIndexStatus[] = [];
  const index = new SessionSearchIndex({
    sessionsDirectory: sessions,
    cacheDirectory: cache,
    emit: (event, value) => {
      if (event === "session.searchIndexChanged") statuses.push(value as SessionSearchIndexStatus);
    },
  });
  try {
    await index.search({
      query: "旧正文",
      requestToken: "external-build",
      limit: 20,
      projectSourceFolders: [project],
      refresh: true,
    });
    await waitForReady(statuses);

    const appendRevision = statuses.at(-1)?.revision ?? 0;
    const appendEventIndex = statuses.length;
    await appendFile(
      sessionPath,
      `${JSON.stringify(message("external-assistant", "external-user", "assistant", "外部新增正文自动出现"))}\n`,
    );
    await Promise.all(["a", "b"].map(async (suffix) => await index.search({
      query: "",
      requestToken: `external-append-probe-${suffix}`,
      limit: 1,
      projectSourceFolders: [project],
      refresh: false,
      probe: true,
    })));
    await waitForReadyAfter(statuses, appendRevision, appendEventIndex);
    assert.equal(statuses.at(-1)?.revision, appendRevision + 1);
    const updated = await index.search({
      query: "外部新增",
      requestToken: "external-updated",
      limit: 20,
      projectSourceFolders: [project],
      refresh: false,
    });
    assert.deepEqual(updated.results.map((row) => row.sessionId), ["external"]);

    const deleteRevision = statuses.at(-1)?.revision ?? appendRevision;
    const deleteEventIndex = statuses.length;
    await rm(sessionPath);
    await index.search({
      query: "",
      requestToken: "external-delete-probe",
      limit: 1,
      projectSourceFolders: [project],
      refresh: false,
      probe: true,
    });
    await waitForReadyAfter(statuses, deleteRevision, deleteEventIndex);
    const removed = await index.search({
      query: "外部新增",
      requestToken: "external-removed",
      limit: 20,
      projectSourceFolders: [project],
      refresh: false,
    });
    assert.deepEqual(removed.results, []);

    const newSessionPath = join(sessions, "new-visible.jsonl");
    const newRevision = statuses.at(-1)?.revision ?? deleteRevision;
    const newEventIndex = statuses.length;
    await writeSession(newSessionPath, [
      header("new-visible", project),
      message("new-visible-user", null, "user", "新建可见会话自动发现"),
    ]);
    await index.search({
      query: "",
      requestToken: "external-new-probe",
      limit: 1,
      projectSourceFolders: [project],
      refresh: false,
      probe: true,
    });
    await waitForReadyAfter(statuses, newRevision, newEventIndex);
    const discovered = await index.search({
      query: "自动发现",
      requestToken: "external-new-ready",
      limit: 20,
      projectSourceFolders: [project],
      refresh: false,
    });
    assert.deepEqual(discovered.results.map((row) => row.sessionId), ["new-visible"]);

    const hiddenRevision = statuses.at(-1)?.revision ?? newRevision;
    await appendFile(
      hiddenPath,
      `${JSON.stringify(message("hidden-assistant", "hidden-user", "assistant", "隐藏正文变化"))}\n`,
    );
    const hiddenProbe = await index.search({
      query: "",
      requestToken: "hidden-change-probe",
      limit: 1,
      projectSourceFolders: [project],
      refresh: false,
      probe: true,
    });
    assert.equal(hiddenProbe.index.state, "ready");
    assert.equal(hiddenProbe.index.revision, hiddenRevision);
  } finally {
    await index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a header-only project session remains visible to empty search", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-search-header-only-test-"));
  const sessions = join(root, "sessions");
  const cache = join(root, "cache");
  const project = join(root, "project");
  await Promise.all([sessions, project].map((path) => mkdir(path, { recursive: true })));
  await writeSession(join(sessions, "header-only.jsonl"), [header("header-only", project)]);
  const statuses: SessionSearchIndexStatus[] = [];
  const index = new SessionSearchIndex({
    sessionsDirectory: sessions,
    cacheDirectory: cache,
    emit: (event, value) => {
      if (event === "session.searchIndexChanged") statuses.push(value as SessionSearchIndexStatus);
    },
  });
  try {
    await index.search({
      query: "",
      requestToken: "header-only-build",
      limit: 20,
      projectSourceFolders: [project],
      refresh: true,
    });
    await waitForReady(statuses);
    const result = await index.search({
      query: "",
      requestToken: "header-only-ready",
      limit: 20,
      projectSourceFolders: [project],
      refresh: false,
    });
    assert.deepEqual(result.results.map((row) => row.sessionId), ["header-only"]);
    assert.equal(result.results[0]?.title, basename(project));
  } finally {
    await index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a complete large second record does not masquerade as a partial project session", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-search-large-second-record-test-"));
  const sessions = join(root, "sessions");
  const cache = join(root, "cache");
  const project = join(root, "project");
  await Promise.all([sessions, project].map((path) => mkdir(path, { recursive: true })));
  await writeSession(join(sessions, "large-second.jsonl"), [
    header("large-second", project),
    {
      type: "custom",
      id: "large-custom",
      parentId: null,
      timestamp: "2026-08-11T08:00:01.000Z",
      customType: "large-fixture",
      data: { padding: "x".repeat(1_100_000) },
    },
    message("large-user", "large-custom", "user", "大记录之后仍然可以搜索"),
  ]);
  const statuses: SessionSearchIndexStatus[] = [];
  const index = new SessionSearchIndex({
    sessionsDirectory: sessions,
    cacheDirectory: cache,
    emit: (event, value) => {
      if (event === "session.searchIndexChanged") statuses.push(value as SessionSearchIndexStatus);
    },
  });
  try {
    await index.search({
      query: "大记录",
      requestToken: "large-build",
      limit: 20,
      projectSourceFolders: [project],
      refresh: true,
    });
    await waitForReady(statuses);
    const result = await index.search({
      query: "大记录",
      requestToken: "large-ready",
      limit: 20,
      projectSourceFolders: [project],
      refresh: false,
    });
    assert.deepEqual(result.results.map((row) => row.sessionId), ["large-second"]);
  } finally {
    await index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("search titles match SessionReader name, first-message, and cwd fallback semantics", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-search-title-test-"));
  const sessions = join(root, "sessions");
  const cache = join(root, "cache");
  const project = join(root, "project-title");
  await Promise.all([sessions, project].map((path) => mkdir(path, { recursive: true })));
  const path = join(sessions, "title.jsonl");
  await writeSession(path, [
    header("title", project),
    message("first-user", null, "user", "第一条用户消息就是当前显示标题"),
    { type: "session_info", id: "named", parentId: "first-user", timestamp: "2026-08-11T08:00:03.000Z", name: "稍后清除的名称" },
    { type: "session_info", id: "cleared", parentId: "named", timestamp: "2026-08-11T08:00:04.000Z", name: "" },
    message("current-leaf", "first-user", "assistant", "当前分支"),
  ]);
  const expectedSummary = (await new SessionReader(sessions).list({
    limit: 10,
    cwdScope: { match: "exact", paths: [project] },
  }))[0];
  assert.ok(expectedSummary);
  const expectedTitle = expectedSummary.name
    || expectedSummary.firstMessage
    || basename(expectedSummary.cwd)
    || expectedSummary.cwd;
  const statuses: SessionSearchIndexStatus[] = [];
  const index = new SessionSearchIndex({
    sessionsDirectory: sessions,
    cacheDirectory: cache,
    emit: (event, value) => {
      if (event === "session.searchIndexChanged") statuses.push(value as SessionSearchIndexStatus);
    },
  });
  try {
    await index.search({
      query: "",
      requestToken: "title-build",
      limit: 20,
      projectSourceFolders: [project],
      refresh: true,
    });
    await waitForReady(statuses);
    const result = await index.search({
      query: "",
      requestToken: "title-ready",
      limit: 20,
      projectSourceFolders: [project],
      refresh: false,
    });
    assert.equal(result.results[0]?.title, expectedTitle);
  } finally {
    await index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a changed visibility scope returns an incomplete state instead of stale ready results", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-search-scope-status-test-"));
  const sessions = join(root, "sessions");
  const cache = join(root, "cache");
  const firstProject = join(root, "first");
  const secondProject = join(root, "second");
  await Promise.all([sessions, firstProject, secondProject].map((path) => mkdir(path, { recursive: true })));
  await writeSession(join(sessions, "first.jsonl"), [
    header("first", firstProject),
    message("first-user", null, "user", "只属于第一个项目"),
  ]);
  const statuses: SessionSearchIndexStatus[] = [];
  const index = new SessionSearchIndex({
    sessionsDirectory: sessions,
    cacheDirectory: cache,
    emit: (event, value) => {
      if (event === "session.searchIndexChanged") statuses.push(value as SessionSearchIndexStatus);
    },
  });
  try {
    await index.search({
      query: "第一个项目",
      requestToken: "first-build",
      limit: 20,
      projectSourceFolders: [firstProject],
      refresh: true,
    });
    await waitForReady(statuses);
    const staleBoundary = await index.search({
      query: "第一个项目",
      requestToken: "second-scope",
      limit: 20,
      projectSourceFolders: [secondProject],
      refresh: false,
    });
    assert.equal(staleBoundary.index.complete, false);
    assert.notEqual(staleBoundary.index.state, "ready");
    assert.deepEqual(staleBoundary.results, []);
  } finally {
    await index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a partial header retries only its file and becomes visible after completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-search-partial-header-test-"));
  const sessions = join(root, "sessions");
  const cache = join(root, "cache");
  const project = join(root, "project");
  await Promise.all([sessions, project].map((path) => mkdir(path, { recursive: true })));
  const sessionPath = join(sessions, "partial-header.jsonl");
  const serialized = JSON.stringify(header("partial-header", project));
  const split = Math.floor(serialized.length / 2);
  await writeFile(sessionPath, serialized.slice(0, split));
  const statuses: SessionSearchIndexStatus[] = [];
  const index = new SessionSearchIndex({
    sessionsDirectory: sessions,
    cacheDirectory: cache,
    emit: (event, value) => {
      if (event === "session.searchIndexChanged") statuses.push(value as SessionSearchIndexStatus);
    },
  });
  try {
    await index.search({
      query: "",
      requestToken: "partial-header-build",
      limit: 20,
      projectSourceFolders: [project],
      refresh: true,
    });
    await waitForStatus(statuses, (value) => !value.complete, "Expected an incomplete partial-header index");
    assert.equal(statuses.some((value) => value.state === "ready"), false);
    await appendFile(sessionPath, `${serialized.slice(split)}\n`);
    await waitForReady(statuses);
    const result = await index.search({
      query: "",
      requestToken: "partial-header-ready",
      limit: 20,
      projectSourceFolders: [project],
      refresh: false,
    });
    assert.deepEqual(result.results.map((row) => row.sessionId), ["partial-header"]);
  } finally {
    await index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an unchanged partial file backs off without repeating index status events", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-search-partial-backoff-test-"));
  const sessions = join(root, "sessions");
  const cache = join(root, "cache");
  const project = join(root, "project");
  await Promise.all([sessions, project].map((path) => mkdir(path, { recursive: true })));
  const sessionPath = join(sessions, "partial-backoff.jsonl");
  await writeFile(sessionPath, `${JSON.stringify(header("partial-backoff", project))}\n{"type":"message"`);
  const statuses: SessionSearchIndexStatus[] = [];
  const index = new SessionSearchIndex({
    sessionsDirectory: sessions,
    cacheDirectory: cache,
    emit: (event, value) => {
      if (event === "session.searchIndexChanged") statuses.push(value as SessionSearchIndexStatus);
    },
  });
  try {
    await index.search({
      query: "",
      requestToken: "partial-backoff-build",
      limit: 20,
      projectSourceFolders: [project],
      refresh: true,
    });
    await waitForStatus(
      statuses,
      (value) => value.complete === false && value.message?.includes("后台重试") === true,
      "Expected a background retry status",
    );
    const eventCount = statuses.length;
    const lastRevision = statuses.at(-1)?.revision;
    await new Promise((resolve) => setTimeout(resolve, 850));
    assert.equal(statuses.length, eventCount);
    assert.equal(statuses.at(-1)?.revision, lastRevision);
  } finally {
    await index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a partial update preserves the previous complete build until replacement is ready", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-search-build-pointer-test-"));
  const sessions = join(root, "sessions");
  const cache = join(root, "cache");
  const cwd = join(root, "cwd");
  await Promise.all([sessions, cwd].map((path) => mkdir(path, { recursive: true })));
  const sessionPath = join(sessions, "build-pointer.jsonl");
  await writeSession(sessionPath, [
    header("build-pointer", cwd),
    origin("build-pointer"),
    message("old-user", "build-pointer-origin", "user", "上一份完整索引 OldStableNeedle"),
  ]);
  const statuses: SessionSearchIndexStatus[] = [];
  const index = new SessionSearchIndex({
    sessionsDirectory: sessions,
    cacheDirectory: cache,
    emit: (event, value) => {
      if (event === "session.searchIndexChanged") statuses.push(value as SessionSearchIndexStatus);
    },
  });
  try {
    await index.search({
      query: "OldStableNeedle",
      requestToken: "build-pointer-initial",
      limit: 20,
      projectSourceFolders: [],
      refresh: true,
    });
    await waitForReady(statuses);
    const readyRevision = statuses.at(-1)?.revision ?? 0;
    const next = message("new-assistant", "old-user", "assistant", "完成后替换 NewStableNeedle");
    await appendFile(sessionPath, JSON.stringify(next));
    index.invalidate();
    await waitForStatus(
      statuses,
      (value) => value.complete === false && (value.revision ?? 0) > readyRevision,
      "Expected an incomplete replacement build",
    );
    const preserved = await index.search({
      query: "OldStableNeedle",
      requestToken: "build-pointer-preserved",
      limit: 20,
      projectSourceFolders: [],
      refresh: false,
    });
    assert.deepEqual(preserved.results.map((row) => row.sessionId), ["build-pointer"]);
    await appendFile(sessionPath, "\n");
    await waitForReadyAfter(statuses, readyRevision);
    const replaced = await index.search({
      query: "NewStableNeedle",
      requestToken: "build-pointer-replaced",
      limit: 20,
      projectSourceFolders: [],
      refresh: false,
    });
    assert.deepEqual(replaced.results.map((row) => row.sessionId), ["build-pointer"]);
  } finally {
    await index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("source-folder filtering is applied before the result limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-search-filter-limit-test-"));
  const sessions = join(root, "sessions");
  const cache = join(root, "cache");
  const newerFolder = join(root, "newer");
  const selectedFolder = join(root, "selected");
  await Promise.all([sessions, newerFolder, selectedFolder].map((path) => mkdir(path, { recursive: true })));
  const newerPath = join(sessions, "newer.jsonl");
  const selectedPath = join(sessions, "selected.jsonl");
  await writeSession(newerPath, [
    header("newer", newerFolder),
    message("newer-user", null, "user", "共同筛选词，较新的可见会话"),
  ]);
  await writeSession(selectedPath, [
    header("selected", selectedFolder),
    message("selected-user", null, "user", "共同筛选词，筛选后必须保留的会话"),
  ]);
  await utimes(selectedPath, new Date("2026-08-11T08:00:00.000Z"), new Date("2026-08-11T08:00:00.000Z"));
  await utimes(newerPath, new Date("2026-08-11T09:00:00.000Z"), new Date("2026-08-11T09:00:00.000Z"));

  const statuses: SessionSearchIndexStatus[] = [];
  const index = new SessionSearchIndex({
    sessionsDirectory: sessions,
    cacheDirectory: cache,
    emit: (event, value) => {
      if (event === "session.searchIndexChanged") statuses.push(value as SessionSearchIndexStatus);
    },
  });
  try {
    await index.search({
      query: "共同筛选词",
      requestToken: "filter-limit-build",
      limit: 1,
      projectSourceFolders: [newerFolder, selectedFolder],
      refresh: true,
    });
    await waitForReady(statuses);
    const result = await index.search({
      query: "共同筛选词",
      requestToken: "filter-limit-ready",
      limit: 1,
      projectSourceFolders: [newerFolder, selectedFolder],
      filterSourceFolders: [selectedFolder],
      refresh: false,
    });
    assert.deepEqual(result.results.map((row) => row.sessionId), ["selected"]);
  } finally {
    await index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("archived exclusions are applied before empty-query and FTS result limits", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-search-archive-limit-test-"));
  const sessions = join(root, "sessions");
  const cache = join(root, "cache");
  const project = join(root, "project");
  await Promise.all([sessions, project].map((path) => mkdir(path, { recursive: true })));
  const archivedPath = join(sessions, "archived.jsonl");
  const visiblePath = join(sessions, "visible.jsonl");
  await writeSession(archivedPath, [
    header("archived", project),
    message("archived-user", null, "user", "归档排除共同词"),
  ]);
  await writeSession(visiblePath, [
    header("visible", project),
    message("visible-user", null, "user", "归档排除共同词"),
  ]);
  await utimes(visiblePath, new Date("2026-08-11T08:00:00.000Z"), new Date("2026-08-11T08:00:00.000Z"));
  await utimes(archivedPath, new Date("2026-08-11T09:00:00.000Z"), new Date("2026-08-11T09:00:00.000Z"));
  const statuses: SessionSearchIndexStatus[] = [];
  const index = new SessionSearchIndex({
    sessionsDirectory: sessions,
    cacheDirectory: cache,
    emit: (event, value) => {
      if (event === "session.searchIndexChanged") statuses.push(value as SessionSearchIndexStatus);
    },
  });
  try {
    await index.search({
      query: "",
      requestToken: "archive-limit-build",
      limit: 1,
      projectSourceFolders: [project],
      excludedSessionIds: ["archived"],
      refresh: true,
    });
    await waitForReady(statuses);
    const empty = await index.search({
      query: "",
      requestToken: "archive-limit-empty",
      limit: 1,
      projectSourceFolders: [project],
      excludedSessionIds: ["archived"],
      refresh: false,
    });
    assert.deepEqual(empty.results.map((row) => row.sessionId), ["visible"]);

    const fullText = await index.search({
      query: "归档排除共同词",
      requestToken: "archive-limit-fts",
      limit: 1,
      projectSourceFolders: [project],
      excludedSessionIds: ["archived"],
      refresh: false,
    });
    assert.deepEqual(fullText.results.map((row) => row.sessionId), ["visible"]);
  } finally {
    await index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("document limit is applied after exact per-session grouping and match counting", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-search-group-limit-test-"));
  const sessions = join(root, "sessions");
  const cache = join(root, "cache");
  const project = join(root, "project");
  await Promise.all([sessions, project].map((path) => mkdir(path, { recursive: true })));
  const manyPath = join(sessions, "many.jsonl");
  const onePath = join(sessions, "one.jsonl");
  await writeSession(manyPath, [
    header("many", project),
    message("many-root", null, "user", "不命中起点"),
    message("many-hit-1", "many-root", "user", "共同匹配"),
    message("many-hit-2", "many-hit-1", "assistant", "共同匹配"),
    message("many-hit-3", "many-hit-2", "user", "共同匹配"),
    message("many-hit-4", "many-hit-3", "assistant", "共同匹配"),
  ]);
  await writeSession(onePath, [
    header("one", project),
    message("one-root", null, "user", "不命中起点"),
    message("one-hit", "one-root", "user", "共同匹配"),
  ]);
  await utimes(onePath, new Date("2026-08-11T08:00:00.000Z"), new Date("2026-08-11T08:00:00.000Z"));
  await utimes(manyPath, new Date("2026-08-11T09:00:00.000Z"), new Date("2026-08-11T09:00:00.000Z"));
  const statuses: SessionSearchIndexStatus[] = [];
  const index = new SessionSearchIndex({
    sessionsDirectory: sessions,
    cacheDirectory: cache,
    emit: (event, value) => {
      if (event === "session.searchIndexChanged") statuses.push(value as SessionSearchIndexStatus);
    },
  });
  try {
    await index.search({
      query: "共同匹配",
      requestToken: "group-build",
      limit: 1,
      projectSourceFolders: [project],
      refresh: true,
    });
    await waitForReady(statuses);
    const result = await index.search({
      query: "共同匹配",
      requestToken: "group-ready",
      limit: 1,
      projectSourceFolders: [project],
      refresh: false,
    });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.sessionId, "many");
    assert.equal(result.results[0]?.entryId, "many-hit-1");
    assert.equal(result.results[0]?.role, "user");
    assert.equal(result.results[0]?.matchCount, 4);
    assert.equal(result.results[0]?.entryDigest, searchEntryDigest("user", "共同匹配"));
  } finally {
    await index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Chinese phrases require adjacent bigrams and long multi-term snippets expose a real hit", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-search-phrase-snippet-test-"));
  const sessions = join(root, "sessions");
  const cache = join(root, "cache");
  const project = join(root, "project");
  await Promise.all([sessions, project].map((path) => mkdir(path, { recursive: true })));
  await writeSession(join(sessions, "scattered.jsonl"), [
    header("scattered", project),
    message("scattered-user", null, "user", "甲乙 分隔内容 乙丙"),
  ]);
  await writeSession(join(sessions, "long-snippet.jsonl"), [
    header("long-snippet", project),
    message(
      "long-user",
      null,
      "user",
      `${"开头内容".repeat(90)} alpha nearby beta 真实命中结尾`,
    ),
  ]);
  const statuses: SessionSearchIndexStatus[] = [];
  const index = new SessionSearchIndex({
    sessionsDirectory: sessions,
    cacheDirectory: cache,
    emit: (event, value) => {
      if (event === "session.searchIndexChanged") statuses.push(value as SessionSearchIndexStatus);
    },
  });
  try {
    await index.search({
      query: "甲乙丙",
      requestToken: "phrase-build",
      limit: 20,
      projectSourceFolders: [project],
      refresh: true,
    });
    await waitForReady(statuses);
    const scattered = await index.search({
      query: "甲乙丙",
      requestToken: "phrase-ready",
      limit: 20,
      projectSourceFolders: [project],
      refresh: false,
    });
    assert.deepEqual(scattered.results, []);

    const longSnippet = await index.search({
      query: "alpha beta",
      requestToken: "snippet-ready",
      limit: 20,
      projectSourceFolders: [project],
      refresh: false,
    });
    assert.equal(longSnippet.results.length, 1);
    assert.equal(longSnippet.results[0]?.sessionId, "long-snippet");
    assert.match(longSnippet.results[0]?.snippet ?? "", /alpha nearby beta/);
  } finally {
    await index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an explicit session title outranks a newer message-body match", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-search-title-priority-test-"));
  const sessions = join(root, "sessions");
  const cache = join(root, "cache");
  const project = join(root, "project");
  await Promise.all([sessions, project].map((path) => mkdir(path, { recursive: true })));
  const titlePath = join(sessions, "title-priority.jsonl");
  const messagePath = join(sessions, "message-priority.jsonl");
  await writeSession(titlePath, [
    header("title-priority", project),
    message("title-root", null, "user", "普通正文"),
    { type: "session_info", id: "title-name", parentId: "title-root", timestamp: "2026-08-11T08:00:03.000Z", name: "标题优先词" },
  ]);
  await writeSession(messagePath, [
    header("message-priority", project),
    message("message-root", null, "user", "普通显示标题"),
    message("message-hit", "message-root", "assistant", "标题优先词"),
  ]);
  await utimes(titlePath, new Date("2026-08-11T08:00:00.000Z"), new Date("2026-08-11T08:00:00.000Z"));
  await utimes(messagePath, new Date("2026-08-11T09:00:00.000Z"), new Date("2026-08-11T09:00:00.000Z"));
  const statuses: SessionSearchIndexStatus[] = [];
  const index = new SessionSearchIndex({
    sessionsDirectory: sessions,
    cacheDirectory: cache,
    emit: (event, value) => {
      if (event === "session.searchIndexChanged") statuses.push(value as SessionSearchIndexStatus);
    },
  });
  try {
    await index.search({
      query: "标题优先词",
      requestToken: "title-priority-build",
      limit: 20,
      projectSourceFolders: [project],
      refresh: true,
    });
    await waitForReady(statuses);
    const result = await index.search({
      query: "标题优先词",
      requestToken: "title-priority-ready",
      limit: 20,
      projectSourceFolders: [project],
      refresh: false,
    });
    assert.equal(result.results[0]?.sessionId, "title-priority");
    assert.equal(result.results[0]?.matchKind, "title");
    assert.equal(result.results[0]?.entryId, undefined);
  } finally {
    await index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a title inferred from the first user message keeps title priority without double counting", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-search-inferred-title-priority-test-"));
  const sessions = join(root, "sessions");
  const cache = join(root, "cache");
  const project = join(root, "project");
  await Promise.all([sessions, project].map((path) => mkdir(path, { recursive: true })));
  const titlePath = join(sessions, "inferred-title.jsonl");
  const messagePath = join(sessions, "inferred-message.jsonl");
  await writeSession(titlePath, [
    header("inferred-title", project),
    message("inferred-title-user", null, "user", "推断标题优先词"),
  ]);
  await writeSession(messagePath, [
    header("inferred-message", project),
    message("inferred-message-root", null, "user", "普通显示标题"),
    message("inferred-message-hit", "inferred-message-root", "assistant", "推断标题优先词"),
  ]);
  await utimes(titlePath, new Date("2026-08-11T08:00:00.000Z"), new Date("2026-08-11T08:00:00.000Z"));
  await utimes(messagePath, new Date("2026-08-11T09:00:00.000Z"), new Date("2026-08-11T09:00:00.000Z"));
  const statuses: SessionSearchIndexStatus[] = [];
  const index = new SessionSearchIndex({
    sessionsDirectory: sessions,
    cacheDirectory: cache,
    emit: (event, value) => {
      if (event === "session.searchIndexChanged") statuses.push(value as SessionSearchIndexStatus);
    },
  });
  try {
    await index.search({
      query: "推断标题优先词",
      requestToken: "inferred-title-build",
      limit: 20,
      projectSourceFolders: [project],
      refresh: true,
    });
    await waitForReady(statuses);
    const result = await index.search({
      query: "推断标题优先词",
      requestToken: "inferred-title-ready",
      limit: 20,
      projectSourceFolders: [project],
      refresh: false,
    });
    assert.equal(result.results[0]?.sessionId, "inferred-title");
    assert.equal(result.results[0]?.matchKind, "title");
    assert.equal(result.results[0]?.entryId, undefined);
    assert.equal(result.results[0]?.entryDigest, undefined);
    assert.equal(result.results[0]?.matchCount, 1);
    assert.equal(result.results[1]?.sessionId, "inferred-message");
    assert.equal(result.results[1]?.matchKind, "message");
  } finally {
    await index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("search excludes messages outside the current Pi session path", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-search-branch-test-"));
  const sessions = join(root, "sessions");
  const cache = join(root, "cache");
  const project = join(root, "project");
  await Promise.all([sessions, project].map((path) => mkdir(path, { recursive: true })));
  await writeSession(join(sessions, "branch.jsonl"), [
    header("branch", project),
    message("root-user", null, "user", "共同起点"),
    message("old-assistant", "root-user", "assistant", "旧路径唯一词 AlphaDiscarded"),
    message("current-assistant", "root-user", "assistant", "当前路径唯一词 BetaCurrent"),
  ]);
  const statuses: SessionSearchIndexStatus[] = [];
  const index = new SessionSearchIndex({
    sessionsDirectory: sessions,
    cacheDirectory: cache,
    emit: (event, value) => {
      if (event === "session.searchIndexChanged") statuses.push(value as SessionSearchIndexStatus);
    },
  });
  try {
    await index.search({
      query: "",
      requestToken: "build",
      limit: 20,
      projectSourceFolders: [project],
      refresh: true,
    });
    await waitForReady(statuses);
    const oldPath = await index.search({
      query: "AlphaDiscarded",
      requestToken: "old",
      limit: 20,
      projectSourceFolders: [project],
      refresh: false,
    });
    const currentPath = await index.search({
      query: "BetaCurrent",
      requestToken: "current",
      limit: 20,
      projectSourceFolders: [project],
      refresh: false,
    });
    assert.deepEqual(oldPath.results, []);
    assert.deepEqual(currentPath.results.map((row) => row.entryId), ["current-assistant"]);
  } finally {
    await index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a display title derived from a discarded branch remains searchable as a title", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-search-discarded-title-test-"));
  const sessions = join(root, "sessions");
  const cache = join(root, "cache");
  const project = join(root, "project");
  await Promise.all([sessions, project].map((path) => mkdir(path, { recursive: true })));
  await writeSession(join(sessions, "discarded-title.jsonl"), [
    header("discarded-title", project),
    message("first-user", null, "user", "旧分支标题唯一词 AuroraDiscardedTitle"),
    message("old-assistant", "first-user", "assistant", "旧分支回复"),
    message("current-user", null, "user", "当前路径正文"),
  ]);
  const statuses: SessionSearchIndexStatus[] = [];
  const index = new SessionSearchIndex({
    sessionsDirectory: sessions,
    cacheDirectory: cache,
    emit: (event, value) => {
      if (event === "session.searchIndexChanged") statuses.push(value as SessionSearchIndexStatus);
    },
  });
  try {
    await index.search({
      query: "AuroraDiscardedTitle",
      requestToken: "discarded-title-build",
      limit: 20,
      projectSourceFolders: [project],
      refresh: true,
    });
    await waitForReady(statuses);
    const result = await index.search({
      query: "AuroraDiscardedTitle",
      requestToken: "discarded-title-ready",
      limit: 20,
      projectSourceFolders: [project],
      refresh: false,
    });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0]?.sessionId, "discarded-title");
    assert.equal(result.results[0]?.title, "旧分支标题唯一词 AuroraDiscardedTitle");
    assert.equal(result.results[0]?.matchKind, "title");
    assert.equal(result.results[0]?.entryId, undefined);
    assert.equal(result.results[0]?.matchCount, 1);
  } finally {
    await index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a corrupt disposable cache is rebuilt instead of becoming an empty successful search", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-search-corrupt-test-"));
  const sessions = join(root, "sessions");
  const cache = join(root, "cache");
  const cwd = join(root, "cwd");
  await Promise.all([sessions, cache, cwd].map((path) => mkdir(path, { recursive: true })));
  await writeSession(join(sessions, "recent.jsonl"), [
    header("recent-corrupt", cwd),
    origin("recent-corrupt"),
    message("recent-corrupt-user", "recent-corrupt-origin", "user", "缓存损坏后仍可搜索"),
  ]);

  const build = async (): Promise<void> => {
    const statuses: SessionSearchIndexStatus[] = [];
    const index = new SessionSearchIndex({
      sessionsDirectory: sessions,
      cacheDirectory: cache,
      emit: (event, value) => {
        if (event === "session.searchIndexChanged") statuses.push(value as SessionSearchIndexStatus);
      },
    });
    try {
      await index.search({
        query: "缓存",
        requestToken: "build",
        limit: 20,
        projectSourceFolders: [],
        refresh: true,
      });
      await waitForReady(statuses);
      const result = await index.search({
        query: "缓存",
        requestToken: "ready",
        limit: 20,
        projectSourceFolders: [],
        refresh: false,
      });
      assert.equal(result.index.state, "ready");
      assert.deepEqual(result.results.map((row) => row.sessionId), ["recent-corrupt"]);
    } finally {
      await index.close();
    }
  };

  try {
    await build();
    await writeFile(join(cache, "search-v1.sqlite3"), "not a sqlite database");
    await build();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a cache corrupted while the worker is running rebuilds once and serves results again", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-search-runtime-corrupt-test-"));
  const sessions = join(root, "sessions");
  const cache = join(root, "cache");
  const project = join(root, "project");
  await Promise.all([sessions, cache, project].map((path) => mkdir(path, { recursive: true })));
  await writeSession(join(sessions, "runtime-corrupt.jsonl"), [
    header("runtime-corrupt", project),
    message("runtime-corrupt-user", null, "user", "运行中损坏恢复唯一词"),
  ]);
  const statuses: SessionSearchIndexStatus[] = [];
  const index = new SessionSearchIndex({
    sessionsDirectory: sessions,
    cacheDirectory: cache,
    emit: (event, value) => {
      if (event === "session.searchIndexChanged") statuses.push(value as SessionSearchIndexStatus);
    },
  });
  const search = async (requestToken: string, refresh: boolean) => await index.search({
    query: "运行中损坏恢复唯一词",
    requestToken,
    limit: 20,
    projectSourceFolders: [project],
    refresh,
  });
  const corruptOpenCache = (schemaVersion: number): void => {
    const external = new DatabaseSync(join(cache, "search-v1.sqlite3"));
    try {
      external.exec(`
        PRAGMA writable_schema=ON;
        UPDATE sqlite_schema SET sql='BROKEN SQL' WHERE name='docs';
        PRAGMA writable_schema=OFF;
        PRAGMA schema_version=${schemaVersion};
      `);
    } finally {
      external.close();
    }
  };
  try {
    await search("runtime-build", true);
    await waitForReady(statuses);
    const initialRevision = statuses.at(-1)?.revision ?? 0;
    assert.deepEqual((await search("runtime-ready", false)).results.map((row) => row.sessionId), ["runtime-corrupt"]);

    corruptOpenCache(901);
    const queryBoundary = await search("runtime-query-corrupt", false);
    assert.equal(queryBoundary.index.state, "rebuilding");
    assert.equal(queryBoundary.index.complete, false);
    assert.deepEqual(queryBoundary.results, []);
    await waitForReadyAfter(statuses, initialRevision);
    const queryRecoveryRevision = statuses.at(-1)?.revision ?? initialRevision;
    assert.deepEqual((await search("runtime-query-recovered", false)).results.map((row) => row.sessionId), ["runtime-corrupt"]);

    corruptOpenCache(902);
    const refreshBoundary = await search("runtime-refresh-corrupt", true);
    assert.equal(refreshBoundary.index.complete, false);
    await waitForReadyAfter(statuses, queryRecoveryRevision);
    assert.deepEqual((await search("runtime-refresh-recovered", false)).results.map((row) => row.sessionId), ["runtime-corrupt"]);
    assert.equal(statuses.some((value) => value.state === "failed"), false);
  } finally {
    await index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed cache rebuild stays failed until an explicit retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-search-rebuild-failure-test-"));
  const sessions = join(root, "sessions");
  const cache = join(root, "cache");
  const project = join(root, "project");
  await Promise.all([sessions, cache, project].map((path) => mkdir(path, { recursive: true })));
  await writeSession(join(sessions, "rebuild-failure.jsonl"), [
    header("rebuild-failure", project),
    message("rebuild-failure-user", null, "user", "失败重建不会循环"),
  ]);
  const statuses: SessionSearchIndexStatus[] = [];
  const index = new SessionSearchIndex({
    sessionsDirectory: sessions,
    cacheDirectory: cache,
    emit: (event, value) => {
      if (event === "session.searchIndexChanged") statuses.push(value as SessionSearchIndexStatus);
    },
  });
  const search = async (requestToken: string, refresh: boolean) => await index.search({
    query: "失败重建不会循环",
    requestToken,
    limit: 20,
    projectSourceFolders: [project],
    refresh,
  });
  try {
    await search("failure-build", true);
    await waitForReady(statuses);
    const external = new DatabaseSync(join(cache, "search-v1.sqlite3"));
    try {
      external.exec(`
        PRAGMA writable_schema=ON;
        UPDATE sqlite_schema SET sql='BROKEN SQL' WHERE name='docs';
        PRAGMA writable_schema=OFF;
        PRAGMA schema_version=903;
      `);
    } finally {
      external.close();
    }
    await chmod(cache, 0o500);
    const boundary = await search("failure-trigger", false);
    assert.equal(boundary.index.state, "rebuilding");
    await waitForStatus(
      statuses,
      (value) => value.state === "failed",
      "Expected an inaccessible cache rebuild to fail once",
    );
    const failedEventCount = statuses.length;
    await new Promise((resolve) => setTimeout(resolve, 300));
    const latched = await search("failure-latched", false);
    assert.equal(latched.index.state, "failed");
    assert.deepEqual(latched.results, []);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(statuses.length, failedEventCount, "A failed generation must not restart itself");

    await chmod(cache, 0o700);
    const previousReadyRevision = [...statuses].reverse()
      .find((value) => value.state === "ready")?.revision ?? 0;
    const retryEventStart = statuses.length;
    await search("failure-explicit-retry", true);
    await waitForReadyAfter(statuses, previousReadyRevision, retryEventStart);
    assert.deepEqual((await search("failure-recovered", false)).results.map((row) => row.sessionId), ["rebuild-failure"]);
  } finally {
    await chmod(cache, 0o700).catch(() => undefined);
    await index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an incomplete visible session keeps the index incomplete until an automatic retry succeeds", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-search-transient-test-"));
  const sessions = join(root, "sessions");
  const cache = join(root, "cache");
  const cwd = join(root, "cwd");
  await Promise.all([sessions, cwd].map((path) => mkdir(path, { recursive: true })));
  const sessionPath = join(sessions, "transient.jsonl");
  const entries = [
    header("transient", cwd),
    origin("transient"),
    message("transient-user", "transient-origin", "user", "半写入完成后应该自动出现"),
  ];
  await writeFile(sessionPath, entries.map((entry) => JSON.stringify(entry)).join("\n"));
  const statuses: SessionSearchIndexStatus[] = [];
  const index = new SessionSearchIndex({
    sessionsDirectory: sessions,
    cacheDirectory: cache,
    emit: (event, value) => {
      if (event === "session.searchIndexChanged") statuses.push(value as SessionSearchIndexStatus);
    },
  });
  try {
    await index.search({
      query: "半写入",
      requestToken: "transient-build",
      limit: 20,
      projectSourceFolders: [],
      refresh: true,
    });
    await waitForStatus(
      statuses,
      (status) => !status.complete && status.message?.includes("会话仍在写入") == true,
      "Timed out waiting for an incomplete search index status",
    );
    assert.equal(statuses.some((status) => status.state === "ready" && status.complete), false);

    const statusCountWhileStable = statuses.length;
    const revisionWhileStable = statuses.at(-1)?.revision;
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(statuses.length, statusCountWhileStable, "Stable partial files must not trigger full-directory refreshes");
    assert.equal(statuses.at(-1)?.revision, revisionWhileStable);

    await appendFile(sessionPath, "\n");
    await waitForReady(statuses);
    const result = await index.search({
      query: "半写入",
      requestToken: "transient-ready",
      limit: 20,
      projectSourceFolders: [],
      refresh: false,
    });
    assert.equal(result.index.complete, true);
    assert.deepEqual(result.results.map((row) => row.sessionId), ["transient"]);
  } finally {
    await index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an invalidation arriving during refresh is followed by a complete refresh", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-search-invalidation-test-"));
  const sessions = join(root, "sessions");
  const cache = join(root, "cache");
  const cwd = join(root, "cwd");
  await Promise.all([sessions, cwd].map((path) => mkdir(path, { recursive: true })));
  const seedCount = 80;
  await Promise.all(Array.from({ length: seedCount }, async (_, sessionIndex) => {
    const id = `seed-${sessionIndex}`;
    const entries: Record<string, unknown>[] = [header(id, cwd), origin(id)];
    let parentId = `${id}-origin`;
    for (let messageIndex = 0; messageIndex < 20; messageIndex += 1) {
      const entryId = `${id}-message-${messageIndex}`;
      entries.push(message(entryId, parentId, "user", `索引种子 ${sessionIndex} ${messageIndex}`));
      parentId = entryId;
    }
    await writeSession(join(sessions, `${id}.jsonl`), entries);
  }));
  const statuses: SessionSearchIndexStatus[] = [];
  const index = new SessionSearchIndex({
    sessionsDirectory: sessions,
    cacheDirectory: cache,
    emit: (event, value) => {
      if (event !== "session.searchIndexChanged") return;
      const next = value as SessionSearchIndexStatus;
      statuses.push(next);
    },
  });
  try {
    await index.search({
      query: "",
      requestToken: "invalidation-build",
      limit: 20,
      projectSourceFolders: [],
      refresh: true,
    });
    await waitForStatus(
      statuses,
      (status) => (status.progress?.completed ?? 0) > 0
        && (status.progress?.completed ?? 0) < (status.progress?.total ?? 0),
      "Timed out waiting for an in-progress search refresh",
    );
    await writeSession(join(sessions, "late.jsonl"), [
      header("late", cwd),
      origin("late"),
      message("late-user", "late-origin", "user", "刷新期间新增的唯一内容"),
    ]);
    const previousReadyRevision = Math.max(
      0,
      ...statuses.filter((status) => status.state === "ready").map((status) => status.revision ?? 0),
    );
    index.invalidate();
    await waitForReadyAfter(statuses, previousReadyRevision);
    const result = await index.search({
      query: "唯一内容",
      requestToken: "invalidation-ready",
      limit: 20,
      projectSourceFolders: [],
      refresh: false,
    });
    assert.deepEqual(result.results.map((row) => row.sessionId), ["late"]);
  } finally {
    await index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("search indexes visible dialogue text but excludes thinking, tools, results, custom data, and auth fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-search-private-parts-test-"));
  const sessions = join(root, "sessions");
  const cache = join(root, "cache");
  const cwd = join(root, "cwd");
  await Promise.all([sessions, cwd].map((path) => mkdir(path, { recursive: true })));
  await writeSession(join(sessions, "private-parts.jsonl"), [
    header("private-parts", cwd),
    origin("private-parts"),
    message("visible-user", "private-parts-origin", "user", "公开正文 CommonVisible"),
    {
      type: "message",
      id: "visible-assistant",
      parentId: "visible-user",
      timestamp: "2026-08-11T08:00:03.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "HiddenThinkSecret" },
          { type: "toolCall", id: "call", name: "bash", arguments: { token: "HiddenToolSecret" } },
          { type: "text", text: "助手公开 CommonVisible" },
        ],
        apiKey: "HiddenAuthSecret",
      },
    },
    {
      type: "message",
      id: "tool-result",
      parentId: "visible-assistant",
      timestamp: "2026-08-11T08:00:04.000Z",
      message: { role: "toolResult", content: [{ type: "text", text: "HiddenResultSecret" }] },
    },
    {
      type: "custom",
      id: "custom-secret",
      parentId: "tool-result",
      timestamp: "2026-08-11T08:00:05.000Z",
      customType: "private-fixture",
      data: { credential: "HiddenCustomSecret" },
    },
  ]);
  const statuses: SessionSearchIndexStatus[] = [];
  const index = new SessionSearchIndex({
    sessionsDirectory: sessions,
    cacheDirectory: cache,
    emit: (event, value) => {
      if (event === "session.searchIndexChanged") statuses.push(value as SessionSearchIndexStatus);
    },
  });
  try {
    await index.search({
      query: "CommonVisible",
      requestToken: "private-build",
      limit: 20,
      projectSourceFolders: [],
      refresh: true,
    });
    await waitForReady(statuses);
    const visible = await index.search({
      query: "CommonVisible",
      requestToken: "visible",
      limit: 20,
      projectSourceFolders: [],
      refresh: false,
    });
    assert.deepEqual(visible.results.map((row) => row.sessionId), ["private-parts"]);
    assert.equal(visible.results[0]?.matchCount, 2);
    for (const hidden of [
      "HiddenThinkSecret",
      "HiddenToolSecret",
      "HiddenResultSecret",
      "HiddenCustomSecret",
      "HiddenAuthSecret",
    ]) {
      const result = await index.search({
        query: hidden,
        requestToken: hidden,
        limit: 20,
        projectSourceFolders: [],
        refresh: false,
      });
      assert.deepEqual(result.results, [], `${hidden} must not be searchable`);
    }
  } finally {
    await index.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("closing the search index rejects pending and future searches without recreating its worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-search-close-test-"));
  const sessions = join(root, "sessions");
  const cache = join(root, "cache");
  await mkdir(sessions, { recursive: true });
  const index = new SessionSearchIndex({ sessionsDirectory: sessions, cacheDirectory: cache, emit: () => undefined });
  const params = {
    query: "",
    requestToken: "close-race",
    limit: 20,
    projectSourceFolders: [],
    refresh: true,
  };
  try {
    const pending = index.search(params);
    const pendingRejected = assert.rejects(pending, (error: unknown) => (
      typeof error === "object"
      && error !== null
      && (error as { code?: unknown }).code === "SEARCH_INDEX_CLOSED"
    ));
    await Promise.all([index.close(), index.close()]);
    await pendingRejected;
    index.invalidate();
    await assert.rejects(index.search({ ...params, requestToken: "after-close" }), (error: unknown) => (
      typeof error === "object"
      && error !== null
      && (error as { code?: unknown }).code === "SEARCH_INDEX_CLOSED"
    ));
  } finally {
    await index.close();
    await rm(root, { recursive: true, force: true });
  }
});
