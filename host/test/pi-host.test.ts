import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentSessionEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import { PiHost, PiHostError } from "../src/pi-host.js";

interface Fixture {
  root: string;
  agentDir: string;
  sessionsDir: string;
  sessionId: string;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pi-dcode-pi-host-test-"));
  const agentDir = join(root, "agent");
  const sessionsDir = join(agentDir, "sessions", "project");
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), "{}\n");
  const sessionId = "session-host";
  const timestamp = new Date().toISOString();
  const entries: Record<string, unknown>[] = [
    { type: "session", version: 3, id: sessionId, timestamp, cwd: root },
    { type: "thinking_level_change", id: "thinking", parentId: null, timestamp, thinkingLevel: "medium" },
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

test("host lists, inspects, and opens a read-only session", async () => {
  const f = await fixture();
  const events: Array<{ event: string; data?: unknown }> = [];
  const host = new PiHost({ agentDir: f.agentDir, emit: (event, data) => events.push({ event, data }) });
  try {
    const hello = await host.handle("host.hello", {}) as {
      protocolVersion: number;
      piVersion: string;
      capabilities: { extensionDialogs: boolean; extensionCustomHeadless: boolean; extensionWidgets: boolean };
    };
    assert.equal(hello.protocolVersion, 1);
    assert.equal(hello.piVersion, "0.84.1");
    assert.equal(hello.capabilities.extensionDialogs, true);
    assert.equal(hello.capabilities.extensionCustomHeadless, false);
    assert.equal(hello.capabilities.extensionWidgets, false);
    const listed = await host.handle("session.list", {}) as { sessions: Array<{ id: string }> };
    assert.deepEqual(listed.sessions.map((session) => session.id), [f.sessionId]);
    const opened = await host.handle("session.open", { sessionId: f.sessionId, mode: "readOnly" }) as { mode: string };
    assert.equal(opened.mode, "readOnly");
    const state = await host.handle("session.getState", {}) as { writable: boolean; sessionId: string };
    assert.equal(state.writable, false);
    assert.equal(state.sessionId, f.sessionId);
    await assert.rejects(
      host.handle("session.prompt", { message: "no" }),
      (error: unknown) => error instanceof PiHostError && error.code === "SESSION_READ_ONLY",
    );
  } finally {
    await host.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("writable open requires exclusive-use confirmation and releases its lease", async () => {
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
        && (error as { code?: unknown }).code === "EXCLUSIVE_USE_CONFIRMATION_REQUIRED",
    );
    const opened = await host.handle("session.open", {
      sessionId: f.sessionId,
      mode: "writable",
      exclusiveUseConfirmed: true,
    }) as { mode: string; extensions: { loaded: number; errors: unknown[] } };
    assert.equal(opened.mode, "writable");
    assert.equal(opened.extensions.loaded, 0);
    assert.deepEqual(opened.extensions.errors, []);
    const state = await host.handle("session.getState", {}) as { writable: boolean; sessionId: string };
    assert.equal(state.writable, true);
    assert.equal(state.sessionId, f.sessionId);
    assert.ok(events.some((entry) => entry.event === "session.opened"));
    await host.handle("session.close", {});
  } finally {
    await host.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a second direct takeover is rejected until the first owner releases its lease", async () => {
  const f = await fixture();
  const first = new PiHost({ agentDir: f.agentDir, leaseQuietWindowMs: 1, conflictPollMs: 60_000, emit: () => undefined });
  const second = new PiHost({ agentDir: f.agentDir, leaseQuietWindowMs: 1, conflictPollMs: 60_000, emit: () => undefined });
  const params = { sessionId: f.sessionId, mode: "writable", exclusiveUseConfirmed: true };
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
      mode: string;
      snapshot: { summary: { id: string; path: string; cwd: string } };
    };
    assert.equal(created.created, true);
    assert.equal(created.mode, "writable");
    assert.equal(created.snapshot.summary.cwd, await realpath(root));
    assert.ok(created.snapshot.summary.path.includes("--"));
    const state = await host.handle("session.getState", {}) as { writable: boolean; sessionId: string };
    assert.equal(state.writable, true);
    assert.equal(state.sessionId, created.snapshot.summary.id);
    await host.handle("session.close", {});
    const listed = await host.handle("session.list", {}) as { sessions: Array<{ id: string }> };
    assert.ok(listed.sessions.some((session) => session.id === created.snapshot.summary.id));
    await assert.rejects(
      host.handle("session.create", { cwd: join(root, "missing") }),
      (error: unknown) => error instanceof PiHostError && error.code === "CWD_NOT_ACCESSIBLE",
    );
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("owned message persistence does not race the conflict poller", async () => {
  const f = await fixture();
  const host = new PiHost({
    agentDir: f.agentDir,
    leaseAgentDir: f.agentDir,
    leaseQuietWindowMs: 1,
    conflictPollMs: 1,
    emit: () => undefined,
  });
  type WritableInternals = {
    session: { sessionManager: SessionManager };
    conflict?: { code: string };
  };
  const internals = host as unknown as {
    active?: WritableInternals;
    onSessionEvent: (active: WritableInternals, event: AgentSessionEvent) => void;
    beforeMutation: (active: WritableInternals) => Promise<void>;
  };
  try {
    await host.handle("session.open", { sessionId: f.sessionId, mode: "writable", exclusiveUseConfirmed: true });
    const active = internals.active;
    assert.ok(active);
    const manager = active.session.sessionManager;
    const seedId = manager.appendCustomEntry("large-owned-seed", { payload: "x".repeat(8 * 1024 * 1024) });
    const seed = manager.getEntry(seedId);
    assert.ok(seed);
    internals.onSessionEvent(active, { type: "entry_appended", entry: seed });
    await internals.beforeMutation(active);

    const first = { role: "user", content: "owned-one", timestamp: Date.now() };
    internals.onSessionEvent(active, { type: "message_end", message: first } as AgentSessionEvent);
    manager.appendMessage(first as never);
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
