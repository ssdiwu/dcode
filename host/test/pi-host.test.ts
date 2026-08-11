import assert from "node:assert/strict";
import { access, appendFile, chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentSessionEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import { PiHost, PiHostError } from "../src/pi-host.js";
import { searchEntryDigest } from "../src/search-entry-digest.js";

interface Fixture {
  root: string;
  agentDir: string;
  sessionsDir: string;
  sessionId: string;
}

async function waitUntil(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pi-dcode-pi-host-test-"));
  const agentDir = join(root, "agent");
  const sessionsDir = join(agentDir, "sessions", "project");
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), "{}\n");
  await writeFile(join(agentDir, "auth.json"), `${JSON.stringify({
    openai: { type: "api_key", key: "test-key" },
  })}\n`);
  const sessionId = "session-host";
  const timestamp = new Date().toISOString();
  const entries: Record<string, unknown>[] = [
    { type: "session", version: 3, id: sessionId, timestamp, cwd: root },
    { type: "model_change", id: "model", parentId: null, timestamp, provider: "test", modelId: "model" },
    { type: "thinking_level_change", id: "thinking", parentId: "model", timestamp, thinkingLevel: "medium" },
    { type: "message", id: "user", parentId: "thinking", timestamp, message: { role: "user", content: "hello", timestamp: Date.now() } },
    {
      type: "message",
      id: "assistant",
      parentId: "user",
      timestamp,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-4o-mini",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: Date.now(),
      },
    },
  ];
  await writeFile(join(sessionsDir, `${sessionId}.jsonl`), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return { root, agentDir, sessionsDir: join(agentDir, "sessions"), sessionId };
}

async function writeTargetSession(f: Fixture, sessionId = "search-target"): Promise<string> {
  const timestamp = new Date().toISOString();
  const path = join(f.agentDir, "sessions", "project", `${sessionId}.jsonl`);
  const entries = [
    { type: "session", version: 3, id: sessionId, timestamp, cwd: f.root },
    { type: "message", id: `${sessionId}-user`, parentId: null, timestamp, message: { role: "user", content: "target", timestamp: Date.now() } },
    {
      type: "message",
      id: `${sessionId}-assistant`,
      parentId: `${sessionId}-user`,
      timestamp,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "target answer" }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-4o-mini",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} },
        stopReason: "stop",
        timestamp: Date.now(),
      },
    },
  ];
  await writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return path;
}

test("host lists, inspects, and opens a read-only session", async () => {
  const f = await fixture();
  const events: Array<{ event: string; data?: unknown }> = [];
  const host = new PiHost({ agentDir: f.agentDir, emit: (event, data) => events.push({ event, data }) });
  try {
    const hello = await host.handle("host.hello", {}) as {
      protocolVersion: number;
      hostVersion: string;
      piVersion: string;
      capabilities: {
        extensionDialogs: boolean;
        extensionCustomHeadless: boolean;
        extensionWidgets: boolean;
        projectCwdScope: boolean;
        contextUsage: boolean;
        fastMode: boolean;
        sessionExternalSync: boolean;
        dcodeSessionOrigin: boolean;
      };
    };
    assert.equal(hello.protocolVersion, 1);
    assert.equal(hello.hostVersion, "0.0.2");
    assert.equal(hello.piVersion, "0.84.1");
    assert.equal(hello.capabilities.extensionDialogs, true);
    assert.equal(hello.capabilities.extensionCustomHeadless, false);
    assert.equal(hello.capabilities.extensionWidgets, false);
    assert.equal(hello.capabilities.projectCwdScope, true);
    assert.equal(hello.capabilities.contextUsage, true);
    assert.equal(hello.capabilities.fastMode, true);
    assert.equal(hello.capabilities.sessionExternalSync, true);
    assert.equal(hello.capabilities.dcodeSessionOrigin, true);
    assert.equal((hello.capabilities as Record<string, boolean>).sessionSearch, true);
    const listed = await host.handle("session.list", {}) as { sessions: Array<{ id: string }> };
    assert.deepEqual(listed.sessions.map((session) => session.id), [f.sessionId]);
    const opened = await host.handle("session.open", { sessionId: f.sessionId, mode: "readOnly" }) as { mode: string };
    assert.equal(opened.mode, "readOnly");
    const state = await host.handle("session.getState", {}) as {
      writable: boolean;
      sessionId: string;
      model: { provider: string; id: string } | null;
      contextUsage: { tokens: null; contextWindow: number; percent: null } | null;
      fastMode: { enabled: boolean; active: boolean; reason: string } | null;
    };
    assert.equal(state.writable, false);
    assert.equal(state.sessionId, f.sessionId);
    assert.equal(state.model?.provider, "openai");
    assert.equal(state.model?.id, "gpt-4o-mini");
    assert.deepEqual(state.contextUsage, { tokens: null, contextWindow: 128_000, percent: null });
    assert.equal(state.fastMode?.enabled, false);
    assert.equal(state.fastMode?.active, false);
    const models = await host.handle("session.getModels", {}) as { models: unknown[] };
    const thinking = await host.handle("session.getThinkingLevels", {}) as { levels: string[] };
    assert.ok(models.models.length > 0);
    assert.ok(thinking.levels.includes("off"));
    await assert.rejects(access(join(f.agentDir, "pi-dcode", "leases", `${f.sessionId}.lock`)));
    await assert.rejects(
      host.handle("session.prompt", { message: "no", promptId: "read-only-prompt" }),
      (error: unknown) => error instanceof PiHostError && error.code === "SESSION_READ_ONLY",
    );
  } finally {
    await host.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("read-only open retries when Pi appends between inspection and version capture", async () => {
  const f = await fixture();
  const host = new PiHost({ agentDir: f.agentDir, conflictPollMs: 60_000, emit: () => undefined });
  const sessionPath = join(f.agentDir, "sessions", "project", `${f.sessionId}.jsonl`);
  const originalInspectPath = host.reader.inspectPath.bind(host.reader);
  let appended = false;
  host.reader.inspectPath = async (path, sessionId) => {
    const inspection = await originalInspectPath(path, sessionId);
    if (!appended) {
      appended = true;
      await appendFile(sessionPath, `${JSON.stringify({
        type: "custom",
        id: "open-race",
        parentId: "assistant",
        timestamp: new Date().toISOString(),
        customType: "open-race",
      })}\n`);
    }
    return inspection;
  };
  try {
    const opened = await host.handle("session.open", {
      sessionId: f.sessionId,
      mode: "readOnly",
    }) as { snapshot: { entries: Array<{ id?: string }> } };
    assert.ok(opened.snapshot.entries.some((entry) => entry.id === "open-race"));
  } finally {
    await host.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a stale search target does not close the current session", async () => {
  const f = await fixture();
  const host = new PiHost({ agentDir: f.agentDir, conflictPollMs: 60_000, emit: () => undefined });
  try {
    await host.handle("session.open", { sessionId: f.sessionId, mode: "readOnly" });
    await assert.rejects(
      host.handle("session.open", {
        sessionId: f.sessionId,
        mode: "readOnly",
        expectedEntryId: "missing-search-entry",
      }),
      (error: unknown) => error instanceof PiHostError && error.code === "SEARCH_TARGET_STALE",
    );
    const state = await host.handle("session.getState", {}) as { sessionId: string; writable: boolean };
    assert.equal(state.sessionId, f.sessionId);
    assert.equal(state.writable, false);
  } finally {
    await host.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("searching within the current writable session keeps its runtime and lease", async () => {
  const f = await fixture();
  const events: Array<{ event: string; data?: unknown }> = [];
  const host = new PiHost({
    agentDir: f.agentDir,
    leaseQuietWindowMs: 10,
    conflictPollMs: 60_000,
    emit: (event, data) => events.push({ event, data }),
  });
  const leasePath = join(f.agentDir, "pi-dcode", "leases", `${f.sessionId}.lock`);
  try {
    await host.handle("session.open", {
      sessionId: f.sessionId,
      mode: "writable",
      writeIntent: true,
    });
    const closedBefore = events.filter((event) => event.event === "session.closed").length;
    const opened = await host.handle("session.open", {
      sessionId: f.sessionId,
      mode: "readOnly",
      expectedEntryId: "assistant",
      preserveActive: true,
    }) as { mode: string; state: { writable: boolean } };
    assert.equal(opened.mode, "writable");
    assert.equal(opened.state.writable, true);
    await access(leasePath);
    await assert.rejects(
      host.handle("session.open", {
        sessionId: f.sessionId,
        mode: "readOnly",
        expectedEntryId: "missing-search-entry",
        preserveActive: true,
      }),
      (error: unknown) => error instanceof PiHostError && error.code === "SEARCH_TARGET_STALE",
    );
    const state = await host.handle("session.getState", {}) as { sessionId: string; writable: boolean };
    assert.equal(state.sessionId, f.sessionId);
    assert.equal(state.writable, true);
    await access(leasePath);
    assert.equal(events.filter((event) => event.event === "session.closed").length, closedBefore);
  } finally {
    await host.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a target append during current-session cleanup opens the final complete snapshot", async () => {
  const f = await fixture();
  const targetId = "search-append-target";
  const targetPath = await writeTargetSession(f, targetId);
  const host = new PiHost({ agentDir: f.agentDir, leaseQuietWindowMs: 10, conflictPollMs: 60_000, emit: () => undefined });
  try {
    await host.handle("session.open", {
      sessionId: f.sessionId,
      mode: "writable",
      writeIntent: true,
    });
    const internals = host as unknown as { closeActive: () => Promise<void> };
    const originalClose = internals.closeActive.bind(host);
    let appended = false;
    internals.closeActive = async () => {
      await originalClose();
      if (appended) return;
      appended = true;
      await appendFile(targetPath, `${JSON.stringify({
        type: "custom",
        id: `${targetId}-latest`,
        parentId: `${targetId}-assistant`,
        timestamp: new Date().toISOString(),
        customType: "latest",
      })}\n`);
    };
    const opened = await host.handle("session.open", {
      sessionId: targetId,
      mode: "readOnly",
      expectedEntryId: `${targetId}-assistant`,
    }) as { snapshot: { entries: Array<{ id?: string }> } };
    assert.ok(opened.snapshot.entries.some((entry) => entry.id === `${targetId}-latest`));
  } finally {
    await host.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a target branch change during cleanup restores the previous session as observation", async () => {
  const f = await fixture();
  const targetId = "search-branch-target";
  const targetPath = await writeTargetSession(f, targetId);
  const host = new PiHost({ agentDir: f.agentDir, leaseQuietWindowMs: 10, conflictPollMs: 60_000, emit: () => undefined });
  try {
    await host.handle("session.open", {
      sessionId: f.sessionId,
      mode: "writable",
      writeIntent: true,
    });
    const internals = host as unknown as { closeActive: () => Promise<void> };
    const originalClose = internals.closeActive.bind(host);
    let branched = false;
    internals.closeActive = async () => {
      await originalClose();
      if (branched) return;
      branched = true;
      await appendFile(join(f.agentDir, "sessions", "project", `${f.sessionId}.jsonl`), `${JSON.stringify({
        type: "custom",
        id: "fallback-latest",
        parentId: "assistant",
        timestamp: new Date().toISOString(),
        customType: "fallback-latest",
      })}\n`);
      await appendFile(targetPath, `${JSON.stringify({
        type: "custom",
        id: `${targetId}-alternate-leaf`,
        parentId: `${targetId}-user`,
        timestamp: new Date().toISOString(),
        customType: "alternate",
      })}\n`);
    };
    await assert.rejects(
      host.handle("session.open", {
        sessionId: targetId,
        mode: "readOnly",
        expectedEntryId: `${targetId}-assistant`,
      }),
      (error: unknown) => error instanceof PiHostError && error.code === "SEARCH_TARGET_STALE",
    );
    const state = await host.handle("session.getState", {}) as { sessionId: string; writable: boolean };
    assert.equal(state.sessionId, f.sessionId);
    assert.equal(state.writable, false);
    const refreshed = await host.handle("session.refresh", {}) as { entries: Array<{ id?: string }> };
    assert.ok(refreshed.entries.some((entry) => entry.id === "fallback-latest"));
    await assert.rejects(access(join(f.agentDir, "pi-dcode", "leases", `${f.sessionId}.lock`)));
  } finally {
    await host.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a search result whose body changed under the same entry ID is stale", async () => {
  const f = await fixture();
  const targetId = "search-rewritten-target";
  const targetPath = await writeTargetSession(f, targetId);
  const host = new PiHost({ agentDir: f.agentDir, leaseQuietWindowMs: 10, conflictPollMs: 60_000, emit: () => undefined });
  try {
    await host.handle("session.open", {
      sessionId: f.sessionId,
      mode: "writable",
      writeIntent: true,
    });
    const internals = host as unknown as { closeActive: () => Promise<void> };
    const originalClose = internals.closeActive.bind(host);
    let rewritten = false;
    internals.closeActive = async () => {
      await originalClose();
      if (rewritten) return;
      rewritten = true;
      const entries = (await readFile(targetPath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const assistant = entries.find((entry) => entry.id === `${targetId}-assistant`);
      if (!assistant) throw new Error("Missing assistant fixture entry");
      assistant.message = {
        ...(assistant.message as Record<string, unknown>),
        content: [{ type: "text", text: "rewritten answer" }],
      };
      await writeFile(targetPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    };
    await assert.rejects(
      host.handle("session.open", {
        sessionId: targetId,
        mode: "readOnly",
        expectedEntryId: `${targetId}-assistant`,
        expectedEntryDigest: searchEntryDigest("assistant", "target answer"),
      }),
      (error: unknown) => error instanceof PiHostError && error.code === "SEARCH_TARGET_STALE",
    );
    const state = await host.handle("session.getState", {}) as { sessionId: string; writable: boolean };
    assert.equal(state.sessionId, f.sessionId);
    assert.equal(state.writable, false);
  } finally {
    await host.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("read-only open retries a transient invalid snapshot only when its file version changed", async () => {
  const f = await fixture();
  const host = new PiHost({ agentDir: f.agentDir, conflictPollMs: 60_000, emit: () => undefined });
  const sessionPath = join(f.agentDir, "sessions", "project", `${f.sessionId}.jsonl`);
  const originalInspectPath = host.reader.inspectPath.bind(host.reader);
  let firstAttempt = true;
  host.reader.inspectPath = async (path, sessionId) => {
    if (firstAttempt) {
      firstAttempt = false;
      await appendFile(sessionPath, "\n");
      throw new Error("transient rewrite window");
    }
    return await originalInspectPath(path, sessionId);
  };
  try {
    const opened = await host.handle("session.open", {
      sessionId: f.sessionId,
      mode: "readOnly",
    }) as { snapshot: { summary: { id: string } } };
    assert.equal(opened.snapshot.summary.id, f.sessionId);
  } finally {
    await host.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a read-only observation emits a change and refreshes from the known session path", async () => {
  const f = await fixture();
  const events: Array<{ event: string; data?: unknown }> = [];
  const host = new PiHost({
    agentDir: f.agentDir,
    conflictPollMs: 10,
    emit: (event, data) => events.push({ event, data }),
  });
  const sessionPath = join(f.agentDir, "sessions", "project", `${f.sessionId}.jsonl`);
  try {
    await host.handle("session.open", { sessionId: f.sessionId, mode: "readOnly" });
    await appendFile(sessionPath, `${JSON.stringify({
      type: "custom",
      id: "external-observed",
      parentId: "assistant",
      timestamp: new Date().toISOString(),
      customType: "external-observed",
      data: { source: "pi-cli" },
    })}\n`);

    await waitUntil(
      () => events.some((entry) => entry.event === "session.changed"),
      "session.changed",
    );
    const refreshed = await host.handle("session.refresh", {}) as {
      entries: Array<{ id?: string }>;
    };
    assert.ok(refreshed.entries.some((entry) => entry.id === "external-observed"));
    assert.equal(events.filter((entry) => entry.event === "session.changed").length, 1);
  } finally {
    await host.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("observation never accepts a partial Pi entry and notifies once per file version", async () => {
  const f = await fixture();
  const events: Array<{ event: string; data?: unknown }> = [];
  const host = new PiHost({
    agentDir: f.agentDir,
    conflictPollMs: 10,
    emit: (event, data) => events.push({ event, data }),
  });
  const sessionPath = join(f.agentDir, "sessions", "project", `${f.sessionId}.jsonl`);
  const external = JSON.stringify({
    type: "custom",
    id: "completed-after-partial",
    parentId: "assistant",
    timestamp: new Date().toISOString(),
    customType: "external-observed",
  });
  const split = Math.floor(external.length / 2);
  try {
    await host.handle("session.open", { sessionId: f.sessionId, mode: "readOnly" });
    await appendFile(sessionPath, external.slice(0, split));
    await waitUntil(
      () => events.filter((entry) => entry.event === "session.changed").length === 1,
      "the partial file version notification",
    );
    await assert.rejects(
      host.handle("session.refresh", {}),
      (error: unknown) => typeof error === "object"
        && error !== null
        && (error as { code?: unknown }).code === "INVALID_SESSION",
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(events.filter((entry) => entry.event === "session.changed").length, 1);

    await appendFile(sessionPath, `${external.slice(split)}\n`);
    await waitUntil(
      () => events.filter((entry) => entry.event === "session.changed").length === 2,
      "the completed file version notification",
    );
    const refreshed = await host.handle("session.refresh", {}) as { entries: Array<{ id?: string }> };
    assert.ok(refreshed.entries.some((entry) => entry.id === "completed-after-partial"));
  } finally {
    await host.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("observation rejects a replacement that reuses the session id with a different header identity", async () => {
  const f = await fixture();
  const events: Array<{ event: string; data?: unknown }> = [];
  const host = new PiHost({
    agentDir: f.agentDir,
    conflictPollMs: 10,
    emit: (event, data) => events.push({ event, data }),
  });
  const sessionPath = join(f.agentDir, "sessions", "project", `${f.sessionId}.jsonl`);
  const original = await readFile(sessionPath, "utf8");
  const replacement = original.split("\n").map((line, index) => {
    if (index !== 0 || !line) return line;
    const header = JSON.parse(line) as Record<string, unknown>;
    return JSON.stringify({ ...header, cwd: join(f.root, "different-cwd") });
  }).join("\n");
  try {
    await host.handle("session.open", { sessionId: f.sessionId, mode: "readOnly" });
    await writeFile(sessionPath, replacement);
    await waitUntil(
      () => events.filter((entry) => entry.event === "session.changed").length === 1,
      "the replacement notification",
    );
    await assert.rejects(
      host.handle("session.refresh", {}),
      (error: unknown) => error instanceof PiHostError && error.code === "SESSION_IDENTITY_CHANGED",
    );
    const unchanged = await host.handle("session.getState", {}) as { cwd: string };
    assert.equal(unchanged.cwd, f.root);

    await writeFile(sessionPath, original);
    await waitUntil(
      () => events.filter((entry) => entry.event === "session.changed").length === 2,
      "the restored identity notification",
    );
    const refreshed = await host.handle("session.refresh", {}) as { summary: { cwd: string } };
    assert.equal(refreshed.summary.cwd, f.root);
  } finally {
    await host.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a writable conflict can release its lease and return to observation", async () => {
  const f = await fixture();
  const events: Array<{ event: string; data?: unknown }> = [];
  const host = new PiHost({
    agentDir: f.agentDir,
    leaseQuietWindowMs: 1,
    conflictPollMs: 10,
    emit: (event, data) => events.push({ event, data }),
  });
  const sessionPath = join(f.agentDir, "sessions", "project", `${f.sessionId}.jsonl`);
  try {
    await host.handle("session.open", {
      sessionId: f.sessionId,
      mode: "writable",
      writeIntent: true,
    });
    await appendFile(sessionPath, `${JSON.stringify({
      type: "custom",
      id: "external-conflict",
      parentId: "assistant",
      timestamp: new Date().toISOString(),
      customType: "external-conflict",
    })}\n`);
    await waitUntil(
      () => events.some((entry) => entry.event === "session.conflict"),
      "session.conflict",
    );

    const observed = await host.handle("session.open", {
      sessionId: f.sessionId,
      mode: "readOnly",
    }) as { mode: string; snapshot: { entries: Array<{ id?: string }> } };
    assert.equal(observed.mode, "readOnly");
    assert.ok(observed.snapshot.entries.some((entry) => entry.id === "external-conflict"));
    const state = await host.handle("session.getState", {}) as { writable: boolean };
    assert.equal(state.writable, false);
  } finally {
    await host.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("an abort failure retains the lease, preserves observation, and poisons later writes", async () => {
  const f = await fixture();
  const events: Array<{ event: string; data?: unknown }> = [];
  const host = new PiHost({
    agentDir: f.agentDir,
    leaseQuietWindowMs: 1,
    conflictPollMs: 10,
    emit: (event, data) => events.push({ event, data }),
  });
  const sessionPath = join(f.agentDir, "sessions", "project", `${f.sessionId}.jsonl`);
  const leasePath = join(f.agentDir, "pi-dcode", "leases", `${f.sessionId}.lock`);
  const internals = host as unknown as {
    active?: { session: { abort: () => Promise<void> } };
  };
  try {
    await host.handle("session.open", { sessionId: f.sessionId, mode: "writable", writeIntent: true });
    assert.ok(internals.active);
    internals.active.session.abort = async () => { throw new Error("abort failed"); };
    await appendFile(sessionPath, `${JSON.stringify({
      type: "custom",
      id: "external-abort-failure",
      parentId: "assistant",
      timestamp: new Date().toISOString(),
      customType: "external-conflict",
    })}\n`);
    await waitUntil(
      () => events.some((entry) => entry.event === "session.conflict"),
      "session.conflict",
    );

    const observed = await host.handle("session.open", {
      sessionId: f.sessionId,
      mode: "readOnly",
    }) as { mode: string; snapshot: { entries: Array<{ id?: string }> } };
    assert.equal(observed.mode, "readOnly");
    assert.ok(observed.snapshot.entries.some((entry) => entry.id === "external-abort-failure"));
    await access(leasePath);
    assert.ok(events.some((entry) => entry.event === "host.restartRequired"));
    await assert.rejects(
      host.handle("session.open", { sessionId: f.sessionId, mode: "writable", writeIntent: true }),
      (error: unknown) => error instanceof PiHostError && error.code === "HOST_RESTART_REQUIRED",
    );
    await assert.rejects(
      host.handle("session.create", { cwd: f.root }),
      (error: unknown) => error instanceof PiHostError && error.code === "HOST_RESTART_REQUIRED",
    );
    const listed = await host.handle("session.list", {}) as { sessions: Array<{ id: string }> };
    assert.deepEqual(listed.sessions.map((session) => session.id), [f.sessionId]);
  } finally {
    await host.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("an unverifiable lease release does not block observation or delete the lock", async () => {
  const f = await fixture();
  const events: Array<{ event: string; data?: unknown }> = [];
  const host = new PiHost({
    agentDir: f.agentDir,
    leaseQuietWindowMs: 1,
    conflictPollMs: 60_000,
    emit: (event, data) => events.push({ event, data }),
  });
  const leasePath = join(f.agentDir, "pi-dcode", "leases", `${f.sessionId}.lock`);
  const ownerPath = join(leasePath, "owner.json");
  try {
    await host.handle("session.open", { sessionId: f.sessionId, mode: "writable", writeIntent: true });
    const owner = JSON.parse(await readFile(ownerPath, "utf8")) as Record<string, unknown>;
    await writeFile(ownerPath, `${JSON.stringify({ ...owner, nonce: "different-owner" })}\n`);

    const observed = await host.handle("session.open", {
      sessionId: f.sessionId,
      mode: "readOnly",
    }) as { mode: string };
    assert.equal(observed.mode, "readOnly");
    await access(leasePath);
    assert.ok(events.some((entry) => entry.event === "session.cleanupError"));
    assert.ok(events.some((entry) => entry.event === "host.restartRequired"));
    await assert.rejects(
      host.handle("session.open", { sessionId: f.sessionId, mode: "writable", writeIntent: true }),
      (error: unknown) => error instanceof PiHostError && error.code === "HOST_RESTART_REQUIRED",
    );
  } finally {
    await host.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("writable open requires explicit write intent and releases its lease", async () => {
  const f = await fixture();
  const events: Array<{ event: string; data?: unknown }> = [];
  const host = new PiHost({
    agentDir: f.agentDir,
    leaseAgentDir: f.agentDir,
    leaseQuietWindowMs: 1,
    conflictPollMs: 60_000,
    emit: (event, data) => events.push({ event, data }),
  });
  try {
    await assert.rejects(
      host.handle("session.open", { sessionId: f.sessionId, mode: "writable" }),
      (error: unknown) => typeof error === "object"
        && error !== null
        && (error as { code?: unknown }).code === "WRITE_INTENT_REQUIRED",
    );
    const opened = await host.handle("session.open", {
      sessionId: f.sessionId,
      mode: "writable",
      writeIntent: true,
    }) as { mode: string; extensions: { loaded: number; errors: unknown[] } };
    assert.equal(opened.mode, "writable");
    assert.equal(opened.extensions.loaded, 0);
    assert.deepEqual(opened.extensions.errors, []);
    const state = await host.handle("session.getState", {}) as {
      writable: boolean;
      sessionId: string;
      fastMode: { enabled: boolean; active: boolean; reason: string };
    };
    assert.equal(state.writable, true);
    assert.equal(state.sessionId, f.sessionId);
    assert.equal(state.fastMode.enabled, false);
    const fast = await host.handle("session.setFastMode", { enabled: true }) as {
      enabled: boolean;
      active: boolean;
      reason: string;
    };
    assert.equal(fast.enabled, true);
    assert.equal(fast.active, false);
    assert.notEqual(fast.reason, "supported");
    const updatedState = await host.handle("session.getState", {}) as { fastMode: { enabled: boolean } };
    assert.equal(updatedState.fastMode.enabled, true);
    assert.ok(events.some((entry) => entry.event === "session.opened"));
    await host.handle("session.close", {});
  } finally {
    await host.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("writable open returns every complete Pi entry accepted before write ownership", async () => {
  const f = await fixture();
  const host = new PiHost({
    agentDir: f.agentDir,
    leaseQuietWindowMs: 1,
    conflictPollMs: 60_000,
    emit: () => undefined,
  });
  const sessionPath = join(f.agentDir, "sessions", "project", `${f.sessionId}.jsonl`);
  const originalInspect = host.reader.inspect.bind(host.reader);
  let appended = false;
  host.reader.inspect = async (sessionId) => {
    const inspection = await originalInspect(sessionId);
    if (!appended) {
      appended = true;
      await appendFile(sessionPath, `${JSON.stringify({
        type: "custom",
        id: "before-write-ownership",
        parentId: "assistant",
        timestamp: new Date().toISOString(),
        customType: "external-observed",
      })}\n`);
    }
    return inspection;
  };
  try {
    const opened = await host.handle("session.open", {
      sessionId: f.sessionId,
      mode: "writable",
      writeIntent: true,
    }) as { snapshot: { entries: Array<{ id?: string }> } };
    assert.ok(opened.snapshot.entries.some((entry) => entry.id === "before-write-ownership"));
  } finally {
    await host.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("writable open excludes external pi-dfast before extension factories execute", async () => {
  const f = await fixture();
  const extensionsDirectory = join(f.agentDir, "extensions");
  const fastMarker = join(f.root, "external-fast-called");
  const keptMarker = join(f.root, "retained-extension-called");
  await mkdir(extensionsDirectory, { recursive: true });
  const extensionSource = (marker: string) => `
    import { appendFileSync } from "node:fs";
    appendFileSync(${JSON.stringify(marker)}, "module\\n");
    export default function activate() { appendFileSync(${JSON.stringify(marker)}, "factory\\n"); }
  `;
  await writeFile(join(extensionsDirectory, "pi-dfast.ts"), extensionSource(fastMarker));
  await writeFile(join(extensionsDirectory, "retained.ts"), extensionSource(keptMarker));

  const host = new PiHost({
    agentDir: f.agentDir,
    leaseQuietWindowMs: 1,
    conflictPollMs: 60_000,
    emit: () => undefined,
  });
  try {
    await host.handle("session.open", {
      sessionId: f.sessionId,
      mode: "writable",
      writeIntent: true,
    });
    assert.equal(await readFile(keptMarker, "utf8"), "module\nfactory\n");
    await assert.rejects(access(fastMarker));
  } finally {
    await host.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("fast mode restores only for the session where it was enabled", async () => {
  const f = await fixture();
  const firstPath = join(f.agentDir, "sessions", "project", `${f.sessionId}.jsonl`);
  const secondSessionID = "session-other";
  const secondPath = join(f.agentDir, "sessions", "project", `${secondSessionID}.jsonl`);
  const secondEntries = (await readFile(firstPath, "utf8"))
    .trimEnd()
    .split("\n")
    .map((line, index) => {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (index === 0) entry.id = secondSessionID;
      return JSON.stringify(entry);
    });
  await writeFile(secondPath, `${secondEntries.join("\n")}\n`);

  const host = new PiHost({
    agentDir: f.agentDir,
    leaseQuietWindowMs: 1,
    conflictPollMs: 60_000,
    emit: () => undefined,
  });
  const writable = (sessionId: string) => ({ sessionId, mode: "writable", writeIntent: true });
  try {
    await host.handle("session.open", writable(f.sessionId));
    await host.handle("session.setFastMode", { enabled: true });
    await host.handle("session.close", {});

    await host.handle("session.open", writable(f.sessionId));
    const restored = await host.handle("session.getState", {}) as { fastMode: { enabled: boolean } };
    assert.equal(restored.fastMode.enabled, true);
    await host.handle("session.close", {});

    await host.handle("session.open", writable(secondSessionID));
    const isolated = await host.handle("session.getState", {}) as { fastMode: { enabled: boolean } };
    assert.equal(isolated.fastMode.enabled, false);
  } finally {
    await host.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("writable open does not install a configured external pi-dfast package", async () => {
  const f = await fixture();
  const npmMarker = join(f.root, "npm-command-called");
  const fakeNpm = join(f.root, "fake-npm");
  await writeFile(
    fakeNpm,
    `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(npmMarker)}, "called");\nprocess.exit(99);\n`,
  );
  await chmod(fakeNpm, 0o755);
  await writeFile(join(f.agentDir, "settings.json"), `${JSON.stringify({
    npmCommand: [fakeNpm],
    packages: ["npm:pi-dfast@999.0.0"],
  })}\n`);

  const host = new PiHost({
    agentDir: f.agentDir,
    leaseQuietWindowMs: 1,
    conflictPollMs: 60_000,
    emit: () => undefined,
  });
  try {
    const opened = await host.handle("session.open", {
      sessionId: f.sessionId,
      mode: "writable",
      writeIntent: true,
    }) as { mode: string };
    assert.equal(opened.mode, "writable");
    await assert.rejects(access(npmMarker));
  } finally {
    await host.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a second direct takeover is rejected until the first owner releases its lease", async () => {
  const f = await fixture();
  const first = new PiHost({ agentDir: f.agentDir, leaseQuietWindowMs: 1, conflictPollMs: 60_000, emit: () => undefined });
  const second = new PiHost({ agentDir: f.agentDir, leaseQuietWindowMs: 1, conflictPollMs: 60_000, emit: () => undefined });
  const params = { sessionId: f.sessionId, mode: "writable", writeIntent: true };
  try {
    await first.handle("session.open", params);
    await assert.rejects(
      second.handle("session.open", params),
      (error: unknown) => typeof error === "object"
        && error !== null
        && (error as { code?: unknown }).code === "SESSION_IN_USE",
    );
    await first.handle("session.close", {});
    const reopened = await second.handle("session.open", params) as { mode: string };
    assert.equal(reopened.mode, "writable");
  } finally {
    await first.close();
    await second.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("host creates a writable Pi session in the cwd-scoped directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-dcode-create-test-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), "{}\n");
  const host = new PiHost({ agentDir, leaseQuietWindowMs: 1, conflictPollMs: 60_000, emit: () => undefined });
  try {
    const created = await host.handle("session.create", { cwd: root }) as {
      created: boolean;
      session: { id: string; path: string; cwd: string };
      activation: {
        status: string;
        open: { mode: string; snapshot: { summary: { id: string; path: string; cwd: string } } };
      };
    };
    assert.equal(created.created, true);
    assert.equal(created.activation.status, "writable");
    assert.equal(created.activation.open.mode, "writable");
    assert.equal(created.session.cwd, await realpath(root));
    assert.ok(created.session.path.includes("--"));
    const state = await host.handle("session.getState", {}) as { writable: boolean; sessionId: string };
    assert.equal(state.writable, true);
    assert.equal(state.sessionId, created.session.id);
    await assert.rejects(
      host.handle("session.create", { cwd: join(root, "missing") }),
      (error: unknown) => error instanceof PiHostError && error.code === "CWD_NOT_ACCESSIBLE",
    );
    const stateAfterFailedCreate = await host.handle("session.getState", {}) as {
      writable: boolean;
      sessionId: string;
    };
    assert.equal(stateAfterFailedCreate.writable, true);
    assert.equal(stateAfterFailedCreate.sessionId, created.session.id);
    await host.handle("session.close", {});
    const document = (await readFile(created.session.path, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(document[0]?.type, "session");
    assert.equal(document[0]?.id, created.session.id);
    assert.equal(document[1]?.type, "custom");
    assert.equal(document[1]?.customType, "dcode-session-origin-v1");
    assert.deepEqual(document[1]?.data, { version: 1, sessionId: created.session.id });
    const listed = await host.handle("session.list", {}) as { sessions: Array<{ id: string }> };
    assert.ok(listed.sessions.some((session) => session.id === created.session.id));
    const recent = await host.handle("session.list", { origin: "dcode" }) as { sessions: Array<{ id: string }> };
    assert.deepEqual(recent.sessions.map((session) => session.id), [created.session.id]);
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed writable activation acknowledges creation and falls back to observation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-dcode-create-failure-test-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), "{}\n");
  const host = new PiHost({ agentDir, leaseQuietWindowMs: 1, conflictPollMs: 60_000, emit: () => undefined });
  const internals = host as unknown as {
    openSession: (sessionId: string, mode: "readOnly" | "writable", writeIntent?: boolean) => Promise<unknown>;
  };
  const originalOpenSession = internals.openSession.bind(host);
  internals.openSession = async (sessionId, mode, writeIntent) => {
    if (mode === "writable") throw new PiHostError("SESSION_ACTIVATION_FAILED", "Synthetic activation failure");
    return await originalOpenSession(sessionId, mode, writeIntent);
  };
  try {
    const created = await host.handle("session.create", { cwd: root }) as {
      created: boolean;
      session: { id: string };
      activation: { status: string; open: { mode: string }; error: { code: string } };
    };
    assert.equal(created.created, true);
    assert.equal(created.activation.status, "observing");
    assert.equal(created.activation.open.mode, "readOnly");
    assert.equal(created.activation.error.code, "SESSION_ACTIVATION_FAILED");
    const recent = await host.handle("session.list", { origin: "dcode" }) as { sessions: Array<{ id: string }> };
    assert.deepEqual(recent.sessions.map((session) => session.id), [created.session.id]);
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("creation remains acknowledged when writable activation and observation both fail", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-dcode-create-unavailable-test-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), "{}\n");
  const host = new PiHost({ agentDir, leaseQuietWindowMs: 1, conflictPollMs: 60_000, emit: () => undefined });
  const internals = host as unknown as {
    openSession: (sessionId: string, mode: "readOnly" | "writable", writeIntent?: boolean) => Promise<unknown>;
  };
  internals.openSession = async (_sessionId, mode) => {
    throw new PiHostError(
      mode === "writable" ? "SESSION_ACTIVATION_FAILED" : "SESSION_OBSERVATION_FAILED",
      `Synthetic ${mode} failure`,
    );
  };
  try {
    const created = await host.handle("session.create", { cwd: root }) as {
      created: boolean;
      session: { id: string };
      activation: {
        status: string;
        error: { code: string };
        observationError: { code: string };
      };
    };
    assert.equal(created.created, true);
    assert.equal(created.activation.status, "unavailable");
    assert.equal(created.activation.error.code, "SESSION_ACTIVATION_FAILED");
    assert.equal(created.activation.observationError.code, "SESSION_OBSERVATION_FAILED");
    const recent = await host.handle("session.list", { origin: "dcode" }) as { sessions: Array<{ id: string }> };
    assert.deepEqual(recent.sessions.map((session) => session.id), [created.session.id]);
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("owned message persistence does not race the conflict poller", async () => {
  const f = await fixture();
  const emitted: Array<{ event: string; data?: unknown }> = [];
  const host = new PiHost({
    agentDir: f.agentDir,
    leaseAgentDir: f.agentDir,
    leaseQuietWindowMs: 1,
    conflictPollMs: 1,
    emit: (event, data) => emitted.push({ event, data }),
  });
  type PromptOptions = {
    preflightResult?: (success: boolean) => void;
    source?: "rpc" | "extension";
  };
  type WritableInternals = {
    session: {
      sessionId: string;
      sessionManager: SessionManager;
      prompt: (message: string, options?: PromptOptions) => Promise<void>;
    };
    conflict?: { code: string };
  };
  const internals = host as unknown as {
    active?: WritableInternals;
    onSessionEvent: (active: WritableInternals, event: AgentSessionEvent) => void;
    onPersistedAgentEvent: (active: WritableInternals, event: AgentSessionEvent) => void;
    beforeMutation: (active: WritableInternals) => Promise<void>;
    prompt: (message: string, promptId: string) => Promise<{ accepted: boolean; completed: boolean }>;
    installPromptSourceBoundary: (active: WritableInternals) => void;
  };
  try {
    await host.handle("session.open", { sessionId: f.sessionId, mode: "writable", writeIntent: true });
    const active = internals.active;
    assert.ok(active);
    const manager = active.session.sessionManager;
    const seedId = manager.appendCustomEntry("large-owned-seed", { payload: "x".repeat(8 * 1024 * 1024) });
    const seed = manager.getEntry(seedId);
    assert.ok(seed);
    internals.onSessionEvent(active, { type: "entry_appended", entry: seed });
    await internals.beforeMutation(active);

    const originalPrompt = active.session.prompt;
    let nestedExtensionMessagePersisted: (() => void) | undefined;
    const nestedExtensionMessage = new Promise<void>((resolve) => { nestedExtensionMessagePersisted = resolve; });
    let emitPromptMessage: (() => void) | undefined;
    let finishPrompt: (() => void) | undefined;
    active.session.prompt = async (message, options) => {
      if (options?.source === "extension") {
        const extensionMessage = { role: "user", content: message, timestamp: Date.now() };
        const extensionEvent = { type: "message_end", message: extensionMessage } as AgentSessionEvent;
        internals.onSessionEvent(active, extensionEvent);
        manager.appendMessage(extensionMessage as never);
        internals.onPersistedAgentEvent(active, extensionEvent);
        nestedExtensionMessagePersisted?.();
        return;
      }
      options?.preflightResult?.(true);
      await active.session.prompt("nested extension prompt", { source: "extension" });
      await new Promise<void>((resolve) => { emitPromptMessage = resolve; });
      const ownMessage = { role: "user", content: "owned prompt", timestamp: Date.now() };
      const ownEvent = { type: "message_end", message: ownMessage } as AgentSessionEvent;
      internals.onSessionEvent(active, ownEvent);
      manager.appendMessage(ownMessage as never);
      internals.onPersistedAgentEvent(active, ownEvent);
      await new Promise<void>((resolve) => { finishPrompt = resolve; });
    };
    internals.installPromptSourceBoundary(active);
    const accepted = await internals.prompt("owned prompt", "owned-prompt-1");
    assert.deepEqual(accepted, { accepted: true, completed: false });

    await nestedExtensionMessage;
    await internals.beforeMutation(active);
    assert.equal(emitted.some(({ event }) => event === "session.promptCompleted"), false);

    const first = { role: "user", content: "extension-owned-one", timestamp: Date.now() };
    const firstEvent = { type: "message_end", message: first } as AgentSessionEvent;
    internals.onSessionEvent(active, firstEvent);
    manager.appendMessage(first as never);
    internals.onPersistedAgentEvent(active, firstEvent);
    await internals.beforeMutation(active);
    assert.equal(emitted.some(({ event }) => event === "session.promptCompleted"), false);

    assert.ok(emitPromptMessage);
    emitPromptMessage();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await internals.beforeMutation(active);
    assert.deepEqual(
      emitted.find(({ event }) => event === "session.promptCompleted"),
      {
        event: "session.promptCompleted",
        data: { sessionId: f.sessionId, promptId: "owned-prompt-1", outcome: "persisted" },
      },
    );
    const sessionFile = manager.getSessionFile();
    assert.ok(sessionFile);
    assert.match(await readFile(sessionFile, "utf8"), /owned prompt/);

    assert.ok(finishPrompt);
    finishPrompt();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await internals.beforeMutation(active);
    active.session.prompt = originalPrompt;
    assert.equal(emitted.filter(({ event }) => event === "session.promptCompleted").length, 1);

    active.session.prompt = async (_message, options) => { options?.preflightResult?.(true); };
    internals.installPromptSourceBoundary(active);
    const handled = await internals.prompt("/handled", "handled-prompt-1");
    assert.deepEqual(handled, { accepted: true, completed: false });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(
      emitted.find(({ data }) => (data as { promptId?: string } | undefined)?.promptId === "handled-prompt-1"),
      {
        event: "session.promptCompleted",
        data: { sessionId: f.sessionId, promptId: "handled-prompt-1", outcome: "handled" },
      },
    );
    active.session.prompt = originalPrompt;

    const secondAppend = new Promise<void>((resolve) => {
      setImmediate(() => {
        const second = { role: "user", content: "owned-two", timestamp: Date.now() };
        internals.onSessionEvent(active, { type: "message_end", message: second } as AgentSessionEvent);
        manager.appendMessage(second as never);
        resolve();
      });
    });
    await Promise.all([internals.beforeMutation(active), secondAppend]);
    await internals.beforeMutation(active);
    assert.equal(active.conflict, undefined);
  } finally {
    await host.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
