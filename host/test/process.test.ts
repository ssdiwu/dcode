import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { D_CODE_SESSION_ORIGIN_TYPE } from "../src/session-origin.js";

const hostEntry = fileURLToPath(new URL("../src/index.js", import.meta.url));
const processEventTimeoutMs = 10_000;

type JsonMessage = Record<string, unknown>;

function collectMessages(stream: NodeJS.ReadableStream): {
  waitFor: (predicate: (message: JsonMessage) => boolean, description: string) => Promise<JsonMessage>;
} {
  const messages: JsonMessage[] = [];
  const waiters = new Set<{
    predicate: (message: JsonMessage) => boolean;
    resolve: (message: JsonMessage) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  let buffer = "";

  stream.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as JsonMessage;
      messages.push(message);
      for (const waiter of [...waiters]) {
        if (!waiter.predicate(message)) continue;
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.resolve(message);
      }
    }
  });

  return {
    waitFor(predicate, description) {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise<JsonMessage>((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          reject,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            reject(new Error(`Timed out waiting for ${description}`));
          }, processEventTimeoutMs),
        };
        waiters.add(waiter);
      });
    },
  };
}

function request(id: string, method: string, params: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ version: 1, type: "request", id, method, params })}\n`;
}

test("host process keeps stdout as JSONL and shuts down cleanly", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-dcode-process-test-"));
  const agentDir = join(root, "agent");
  await mkdir(join(agentDir, "sessions"), { recursive: true });
  await writeFile(join(agentDir, "settings.json"), "{}\n");
  const child = spawn(process.execPath, [hostEntry, "--agent-dir", agentDir], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });

  child.stdin.write("{bad}\n");
  child.stdin.write(`${JSON.stringify({ version: 1, type: "request", method: "host.hello", params: {} })}\n`);
  for (const request of [
    { version: 1, type: "request", id: "hello", method: "host.hello", params: {} },
    { version: 1, type: "request", id: "unknown", method: "missing.method", params: {} },
    { version: 1, type: "request", id: "shutdown", method: "host.shutdown", params: {} },
  ]) child.stdin.write(`${JSON.stringify(request)}\n`);

  const [code] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
  assert.equal(code, 0);
  assert.equal(stderr, "");
  const messages = stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.ok(messages.every((message) => message.version === 1));
  assert.ok(messages.some((message) => message.type === "event" && message.event === "host.ready"));
  assert.equal(messages.filter((message) => message.type === "event" && message.event === "protocol.error").length, 2);
  assert.ok(messages.some((message) => message.id === "hello" && message.ok === true));
  assert.ok(messages.some((message) => message.id === "unknown" && message.ok === false));
  assert.ok(messages.some((message) => message.id === "shutdown" && message.ok === true));
  await rm(root, { recursive: true, force: true });
});

test("search worker keeps the Host process JSONL-only and does not create a session lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-dcode-search-process-test-"));
  const agentDir = join(root, "agent");
  const sessionsDir = join(agentDir, "sessions", "project");
  const cacheDir = join(root, "search-cache");
  const sessionId = "search-process-session";
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), "{}\n");
  const timestamp = new Date().toISOString();
  await writeFile(join(sessionsDir, `${sessionId}.jsonl`), [
    {
      type: "session",
      version: 3,
      id: sessionId,
      timestamp,
      cwd: root,
    },
    {
      type: "custom",
      id: `${sessionId}-origin`,
      parentId: null,
      timestamp,
      customType: D_CODE_SESSION_ORIGIN_TYPE,
      data: { version: 1, sessionId },
    },
    {
      type: "message",
      id: `${sessionId}-user`,
      parentId: `${sessionId}-origin`,
      timestamp,
      message: { role: "user", content: "进程级搜索验证", timestamp: Date.now() },
    },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");

  const child = spawn(process.execPath, [
    hostEntry,
    "--agent-dir", agentDir,
    "--search-cache-dir", cacheDir,
  ], { stdio: ["pipe", "pipe", "pipe"] });
  const collector = collectMessages(child.stdout);
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  try {
    await collector.waitFor((message) => message.event === "host.ready", "host.ready");
    child.stdin.write(request("search-build", "session.search", {
      query: "进程级",
      requestToken: "build",
      limit: 20,
      projectSourceFolders: [],
      refresh: true,
    }));
    await collector.waitFor((message) => message.id === "search-build" && message.ok === true, "initial search");
    await collector.waitFor(
      (message) => message.event === "session.searchIndexChanged"
        && (message.data as { state?: unknown }).state === "ready",
      "ready search index",
    );
    child.stdin.write(request("search-ready", "session.search", {
      query: "进程级",
      requestToken: "ready",
      limit: 20,
      projectSourceFolders: [],
      refresh: false,
    }));
    const searched = await collector.waitFor((message) => message.id === "search-ready", "ready search");
    assert.equal(searched.ok, true);
    const results = ((searched.result as { results?: unknown[] }).results ?? []) as Array<{ sessionId?: unknown }>;
    assert.deepEqual(results.map((result) => result.sessionId), [sessionId]);
    await assert.rejects(access(join(agentDir, "pi-dcode", "leases")));

    child.stdin.write(request("shutdown", "host.shutdown"));
    const [code] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
    assert.equal(code, 0);
    assert.equal(stderr, "");
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("extension dialog responses bypass a prompt waiting for native UI", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-dcode-dialog-process-test-"));
  const agentDir = join(root, "agent");
  const sessionId = "dialog-session";
  const sessionDir = join(agentDir, "sessions", "project");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), "{}\n");
  await writeFile(join(agentDir, "extensions", "native-dialog.ts"), `
    export default function (pi) {
      pi.registerCommand("native-dialog", {
        description: "Exercise the native dialog bridge",
        handler: async (_args, ctx) => {
          const value = await ctx.ui.input("Native input", "type a value");
          ctx.ui.notify("received:" + value, "info");
        },
      });
    }
  `);
  await writeFile(join(sessionDir, `${sessionId}.jsonl`), `${JSON.stringify({
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: new Date().toISOString(),
    cwd: root,
  })}\n`);

  const child = spawn(process.execPath, [hostEntry, "--agent-dir", agentDir], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const collector = collectMessages(child.stdout);
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });

  try {
    await collector.waitFor((message) => message.event === "host.ready", "host.ready");
    child.stdin.write(request("open", "session.open", {
      sessionId,
      mode: "writable",
      writeIntent: true,
    }));
    const opened = await collector.waitFor((message) => message.id === "open", "writable session response");
    assert.equal(opened.ok, true);

    child.stdin.write(request("prompt", "session.prompt", {
      message: "/native-dialog",
      promptId: "native-dialog-prompt",
    }));
    const dialog = await collector.waitFor(
      (message) => message.type === "event" && message.event === "extension.request",
      "extension.request",
    );
    const requestId = (dialog.data as { requestId?: unknown }).requestId;
    assert.equal(typeof requestId, "string");

    child.stdin.write(request("dialog-response", "extension.respond", {
      requestId,
      response: { value: "done" },
    }));
    const response = await collector.waitFor(
      (message) => message.id === "dialog-response",
      "extension.respond response",
    );
    assert.equal(response.ok, true);
    const prompt = await collector.waitFor((message) => message.id === "prompt", "session.prompt response");
    assert.equal(prompt.ok, true);
    const notification = await collector.waitFor(
      (message) => message.type === "event"
        && message.event === "extension.notification"
        && (message.data as { message?: unknown }).message === "received:done",
      "extension.notification",
    );
    assert.ok(notification);

    child.stdin.write(request("shutdown", "host.shutdown"));
    const [code] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
    assert.equal(code, 0);
    assert.equal(stderr, "");
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("host exits after its launching parent disappears", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-dcode-parent-exit-test-"));
  const agentDir = join(root, "agent");
  await mkdir(join(agentDir, "sessions"), { recursive: true });
  await writeFile(join(agentDir, "settings.json"), "{}\n");
  const launcherSource = `
    const { spawn } = require("node:child_process");
    const child = spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(hostEntry)}, "--agent-dir", ${JSON.stringify(agentDir)}], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    child.stdout.once("data", () => {
      process.stdout.write(String(child.pid) + "\\n");
      setTimeout(() => process.exit(0), 10);
    });
  `;
  const launcher = spawn(process.execPath, ["-e", launcherSource], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let pidText = "";
  launcher.stdout.on("data", (chunk: Buffer) => { pidText += chunk.toString("utf8"); });
  const [launcherCode] = await once(launcher, "exit") as [number | null, NodeJS.Signals | null];
  assert.equal(launcherCode, 0);
  const hostPid = Number.parseInt(pidText.trim(), 10);
  assert.ok(Number.isInteger(hostPid) && hostPid > 0);

  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    try {
      process.kill(hostPid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        await rm(root, { recursive: true, force: true });
        return;
      }
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  process.kill(hostPid, "SIGKILL");
  await rm(root, { recursive: true, force: true });
  assert.fail(`orphaned host process ${hostPid} did not exit`);
});
