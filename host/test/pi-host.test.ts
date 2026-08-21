import assert from "node:assert/strict";
import { access, appendFile, chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentSessionEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import { PiHost, PiHostError } from "../src/pi-host.js";
import { publishNewFileAtomically } from "../src/atomic-file.js";
import { searchEntryDigest } from "../src/search-entry-digest.js";
import { SessionLease } from "../src/session-lease.js";

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

test("host lists, inspects, and opens with immediate takeover", async () => {
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
        modelSettings: boolean;
        sessionSteer: boolean;
        modelAuthentication: boolean;
      };
    };
    assert.equal(hello.protocolVersion, 1);
    assert.equal(hello.hostVersion, "0.0.16");
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
    assert.equal((hello.capabilities as Record<string, boolean>).sessionTrash, true);
    assert.equal((hello.capabilities as Record<string, boolean>).sessionChangeLedger, true);
    assert.equal((hello.capabilities as Record<string, boolean>).sessionRename, true);
    assert.equal((hello.capabilities as Record<string, boolean>).sessionRunCorrelation, true);
    assert.equal((hello.capabilities as Record<string, boolean>).sessionRunState, true);
    assert.equal((hello.capabilities as Record<string, boolean>).preSessionModelSelection, true);
    assert.equal(hello.capabilities.modelSettings, true);
    assert.equal(hello.capabilities.sessionSteer, true);
    assert.equal(hello.capabilities.modelAuthentication, true);
    const listed = await host.handle("session.list", {}) as { sessions: Array<{ id: string }> };
    assert.deepEqual(listed.sessions.map((session) => session.id), [f.sessionId]);
    const opened = await host.handle("session.open", { sessionId: f.sessionId }) as { mode: string };
    assert.equal(opened.mode, "writable");
    const state = await host.handle("session.getState", {}) as {
      mode: string;
      writable: boolean;
      sessionId: string;
      model: { provider: string; id: string } | null;
      fastMode: { enabled: boolean; active: boolean; reason: string } | null;
    };
    assert.equal(state.mode, "writable");
    assert.equal(state.writable, true);
    assert.equal(state.sessionId, f.sessionId);
    assert.equal(state.model?.provider, "openai");
    assert.equal(state.model?.id, "gpt-4o-mini");
    assert.equal(state.fastMode?.enabled, false);
    assert.equal(state.fastMode?.active, false);
    const models = await host.handle("session.getModels", {}) as { models: unknown[] };
    const thinking = await host.handle("session.getThinkingLevels", {}) as { levels: string[] };
    assert.ok(models.models.length > 0);
    assert.ok(thinking.levels.includes("off"));
    // 打开即接管：打开期间租约目录必须存在，关闭后释放。
    await access(join(f.agentDir, "pi-dcode", "leases", `${f.sessionId}.lock`));
    await host.handle("session.close", { expectedSessionId: f.sessionId });
    await assert.rejects(access(join(f.agentDir, "pi-dcode", "leases", `${f.sessionId}.lock`)));
  } finally {
    await host.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("model catalog is available before a Pi session exists and exposes the configured default", async () => {
  const f = await fixture();
  await writeFile(join(f.agentDir, "settings.json"), `${JSON.stringify({
    defaultProvider: "openai",
    defaultModel: "gpt-4o-mini",
    defaultThinkingLevel: "high",
    enabledModels: ["openai/gpt-4o-mini", "openai/gpt-5.6-*"],
  })}\n`);
  const host = new PiHost({ agentDir: f.agentDir, emit: () => {} });
  try {
    const result = await host.handle("session.getModels", { cwd: f.root }) as {
      models: Array<{ provider: string; id: string; fastModeSupported: boolean }>;
      defaultModel: { provider: string; id: string; fastModeSupported: boolean } | null;
      defaultThinkingLevel: string;
    };
    assert.deepEqual(
      result.models.map((model) => `${model.provider}/${model.id}`).sort(),
      [
        "openai/gpt-4o-mini",
        "openai/gpt-5.6-luna",
        "openai/gpt-5.6-sol",
        "openai/gpt-5.6-terra",
      ],
    );
    assert.equal(result.defaultModel?.provider, "openai");
    assert.equal(result.defaultModel?.id, "gpt-4o-mini");
    assert.equal(result.defaultModel?.fastModeSupported, false);
    assert.equal(result.defaultThinkingLevel, "high");

    await host.handle("session.open", { sessionId: f.sessionId, mode: "readOnly" });
    const activeResult = await host.handle("session.getModels", {}) as {
      models: Array<{ provider: string; id: string }>;
    };
    assert.deepEqual(
      activeResult.models.map((model) => `${model.provider}/${model.id}`).sort(),
      [
        "openai/gpt-4o-mini",
        "openai/gpt-5.6-luna",
        "openai/gpt-5.6-sol",
        "openai/gpt-5.6-terra",
      ],
    );
  } finally {
    await host.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("model settings expose safe Pi state and update only global model keys", async () => {
  const f = await fixture();
  await writeFile(join(f.agentDir, "settings.json"), `${JSON.stringify({
    defaultProvider: "openai",
    defaultModel: "gpt-4o-mini",
    defaultThinkingLevel: "high",
    enabledModels: ["openai/gpt-4o-mini"],
    theme: "dark",
  })}\n`);
  await mkdir(join(f.root, ".pi"), { recursive: true });
  await writeFile(join(f.root, ".pi", "settings.json"), `${JSON.stringify({
    enabledModels: ["openai/gpt-5.6-*"],
  })}\n`);
  const host = new PiHost({ agentDir: f.agentDir, emit: () => {} });
  try {
    const initial = await host.handle("modelSettings.get", { cwd: f.root }) as {
      cwd: string;
      providers: Array<{
        id: string;
        auth: { configured: boolean; source: string | null };
        models: Array<{ model: { provider: string; id: string }; globalEnabled: boolean; enabled: boolean }>;
      }>;
      global: { enabledModels: string[]; unrestricted: boolean; defaultProvider: string; defaultModelId: string };
      effective: { enabledModels: string[] };
      projectOverrides: { enabledModels: boolean; defaultModel: boolean };
    };
    assert.equal(initial.cwd, await realpath(f.root));
    assert.deepEqual(initial.global.enabledModels, ["openai/gpt-4o-mini"]);
    assert.equal(initial.global.unrestricted, false);
    assert.equal(initial.global.defaultProvider, "openai");
    assert.equal(initial.global.defaultModelId, "gpt-4o-mini");
    assert.deepEqual(initial.effective.enabledModels, ["openai/gpt-5.6-*"]);
    assert.deepEqual(initial.projectOverrides, { enabledModels: true, defaultModel: false });
    const openai = initial.providers.find((provider) => provider.id === "openai");
    assert.equal(openai?.auth.configured, true);
    assert.ok(openai?.auth.source);
    const mini = openai?.models.find(({ model }) => model.id === "gpt-4o-mini");
    assert.equal(mini?.globalEnabled, true);
    assert.equal(mini?.enabled, false);

    await assert.rejects(
      host.handle("modelSettings.setDefaultModel", {
        cwd: f.root,
        provider: "openai",
        modelId: "gpt-5.6-sol",
      }),
      (error: unknown) => error instanceof PiHostError && error.code === "MODEL_NOT_ENABLED",
    );
    const unchanged = JSON.parse(await readFile(join(f.agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
    assert.equal(unchanged.defaultProvider, "openai");
    assert.equal(unchanged.defaultModel, "gpt-4o-mini");

    const changed = await host.handle("modelSettings.setEnabledModels", {
      cwd: f.root,
      enabledModels: ["openai/gpt-4o-mini", "openai/gpt-5.6-*"],
    }) as { global: { enabledModels: string[] } };
    assert.deepEqual(changed.global.enabledModels, ["openai/gpt-4o-mini", "openai/gpt-5.6-*"]);
    const stored = JSON.parse(await readFile(join(f.agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
    assert.equal(stored.theme, "dark");
    assert.equal(stored.defaultThinkingLevel, "high");
    assert.deepEqual(stored.enabledModels, ["openai/gpt-4o-mini", "openai/gpt-5.6-*"]);

    await host.handle("modelSettings.setDefaultModel", {
      cwd: f.root,
      provider: "openai",
      modelId: "gpt-5.6-sol",
    });
    const withDefault = JSON.parse(await readFile(join(f.agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
    assert.equal(withDefault.defaultProvider, "openai");
    assert.equal(withDefault.defaultModel, "gpt-5.6-sol");
  } finally {
    await host.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("model settings refresh respects offline mode and retains the local catalog", async () => {
  const f = await fixture();
  const previousOffline = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = "1";
  const host = new PiHost({ agentDir: f.agentDir, emit: () => {} });
  try {
    const result = await host.handle("modelSettings.refresh", { cwd: f.root }) as {
      providers: Array<{ id: string; models: Array<{ model: { id: string } }> }>;
      refresh: { attempted: boolean; aborted: boolean; failed: boolean; networkDisabled: boolean };
    };
    assert.deepEqual(result.refresh, {
      attempted: true,
      aborted: false,
      failed: false,
      networkDisabled: true,
    });
    assert.ok(result.providers.find((provider) => provider.id === "openai")?.models.length);
  } finally {
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
    await host.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("model settings refuse to overwrite an unreadable Pi global settings file", async () => {
  const f = await fixture();
  const settingsPath = join(f.agentDir, "settings.json");
  await writeFile(settingsPath, "{not-json\n");
  const host = new PiHost({ agentDir: f.agentDir, emit: () => {} });
  try {
    await assert.rejects(
      host.handle("modelSettings.setEnabledModels", {
        cwd: f.root,
        enabledModels: ["openai/gpt-4o-mini"],
      }),
      (error: unknown) => error instanceof PiHostError && error.code === "MODEL_SETTINGS_UNREADABLE",
    );
    assert.equal(await readFile(settingsPath, "utf8"), "{not-json\n");
  } finally {
    await host.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("unauthenticated providers hide their models and authenticate through Pi without emitting the secret", async () => {
  const f = await fixture();
  const previousOpenAIKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  await writeFile(join(f.agentDir, "auth.json"), "{}\n");
  const emitted: Array<{ event: string; data?: unknown }> = [];
  const host = new PiHost({
    agentDir: f.agentDir,
    emit: (event, data) => emitted.push({ event, data }),
  });
  try {
    await host.handle("session.open", { sessionId: f.sessionId, mode: "readOnly" });
    const initial = await host.handle("modelSettings.get", { cwd: f.root }) as {
      providers: Array<{
        id: string;
        auth: { configured: boolean; methods: Array<{ type: string; interactive: boolean }> };
        models: unknown[];
      }>;
    };
    const unauthenticated = initial.providers.find((provider) => provider.id === "openai");
    assert.equal(unauthenticated?.auth.configured, false);
    assert.deepEqual(unauthenticated?.models, []);
    assert.equal(
      unauthenticated?.auth.methods.some((method) => method.type === "api_key" && method.interactive),
      true,
    );

    const flowId = "auth-openai";
    const login = host.handle("modelAuth.start", {
      cwd: f.root,
      flowId,
      provider: "openai",
      authType: "api_key",
    }) as Promise<{ providers: Array<{ id: string; auth: { configured: boolean }; models: unknown[] }> }>;
    await waitUntil(
      () => emitted.some(({ event }) => event === "modelAuth.request"),
      "model authentication prompt",
    );
    const request = emitted.find(({ event }) => event === "modelAuth.request")?.data as {
      requestId: string;
      prompt: { type: string };
    };
    assert.equal(request.prompt.type, "secret");
    const secret = "test-auth-secret-not-real";
    await host.handle("modelAuth.respond", {
      flowId,
      requestId: request.requestId,
      value: secret,
    });
    const authenticated = await login;
    const openai = authenticated.providers.find((provider) => provider.id === "openai");
    assert.equal(openai?.auth.configured, true);
    assert.ok(openai?.models.length);
    const activeModels = await host.handle("session.getModels", {}) as {
      models: Array<{ provider: string; id: string }>;
    };
    assert.equal(activeModels.models.some((model) => model.provider === "openai"), true);
    assert.equal(JSON.stringify(emitted).includes(secret), false);
    assert.equal((JSON.parse(await readFile(join(f.agentDir, "auth.json"), "utf8")) as {
      openai?: { key?: string };
    }).openai?.key, secret);
  } finally {
    if (previousOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAIKey;
    await host.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("steering an active run uses Pi steer semantics without replacing the run identity", async () => {
  const f = await fixture();
  const host = new PiHost({
    agentDir: f.agentDir,
    leaseQuietWindowMs: 1,
    conflictPollMs: 60_000,
    emit: () => {},
  });
  type PromptOptions = {
    source?: "rpc" | "extension";
    streamingBehavior?: "steer" | "followUp";
  };
  type WritableInternals = {
    session: {
      prompt: (message: string, options?: PromptOptions) => Promise<void>;
      steer: (message: string) => Promise<void>;
    };
    currentRun?: {
      id: string;
      toolCalls: Map<string, unknown>;
      state: {
        sessionId: string;
        runId: string;
        phase: "running";
        startedAt: string;
        updatedAt: string;
        inputPersisted: boolean;
        retryable: boolean;
      };
    };
  };
  const internals = host as unknown as { active?: WritableInternals };
  try {
    await host.handle("session.open", { sessionId: f.sessionId, mode: "writable", writeIntent: true });
    const active = internals.active;
    assert.ok(active);
    const originalSteer = active.session.steer;
    Object.defineProperty(active.session, "isStreaming", { value: true, configurable: true });
    const now = new Date().toISOString();
    active.currentRun = {
      id: "run-active",
      toolCalls: new Map(),
      state: {
        sessionId: f.sessionId,
        runId: "run-active",
        phase: "running",
        startedAt: now,
        updatedAt: now,
        inputPersisted: true,
        retryable: false,
      },
    };
    let observed: string | undefined;
    active.session.steer = async (message) => { observed = message; };

    const result = await host.handle("session.steer", {
      message: "change direction",
      steerId: "steer-1",
      expectedRunId: "run-active",
    }) as { accepted: boolean; steerId: string; runId: string };

    assert.deepEqual(result, { accepted: true, steerId: "steer-1", runId: "run-active" });
    assert.equal(observed, "change direction");
    assert.equal(active.currentRun?.id, "run-active");
    await assert.rejects(
      host.handle("session.steer", {
        message: "must not enter another run",
        steerId: "steer-stale",
        expectedRunId: "run-stale",
      }),
      (error: unknown) => error instanceof PiHostError && error.code === "SESSION_RUN_CHANGED",
    );
    active.currentRun = undefined;
    active.session.steer = originalSteer;
    delete (active.session as { isStreaming?: boolean }).isStreaming;
  } finally {
    await host.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("takeover open exposes incomplete legacy model metadata as null", async () => {
  const f = await fixture();
  const path = join(f.agentDir, "sessions", "project", `${f.sessionId}.jsonl`);
  const entries = (await readFile(path, "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const modelEntry = entries.find((entry) => entry.type === "model_change");
  if (modelEntry) delete modelEntry.modelId;
  const assistant = entries.find((entry) => entry.id === "assistant") as {
    message: Record<string, unknown>;
  };
  delete assistant.message.provider;
  delete assistant.message.model;
  await writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  const host = new PiHost({ agentDir: f.agentDir, emit: () => undefined });
  try {
    const opened = await host.handle("session.open", {
      sessionId: f.sessionId,
    }) as {
      snapshot: { context: { model: unknown } };
      state: { model: unknown };
    };

    assert.equal(opened.snapshot.context.model, null, "检查快照仍如实标记未知模型");
    assert.ok(opened.state.model, "可写运行时会解析出一个可用模型");
  } finally {
    await host.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("opening a historical path keeps the writable runtime on that exact leaf", async () => {
  const f = await fixture();
  const sessionPath = join(f.agentDir, "sessions", "project", `${f.sessionId}.jsonl`);
  await appendFile(sessionPath, `${JSON.stringify({
    type: "message",
    id: "assistant-alternate",
    parentId: "user",
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text: "alternate answer" }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-4o-mini",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} },
      stopReason: "stop",
      timestamp: Date.now(),
    },
  })}\n`);
  const host = new PiHost({
    agentDir: f.agentDir,
    leaseQuietWindowMs: 1,
    conflictPollMs: 60_000,
    emit: () => undefined,
  });
  try {
    const observed = await host.handle("session.open", {
      sessionId: f.sessionId,
      mode: "readOnly",
      pathId: "leaf:assistant",
    }) as { snapshot: { selectedPathId: string; entries: Array<{ id?: string }> } };
    assert.equal(observed.snapshot.selectedPathId, "leaf:assistant");
    assert.ok(observed.snapshot.entries.some((entry) => entry.id === "assistant"));
    assert.equal(observed.snapshot.entries.some((entry) => entry.id === "assistant-alternate"), false);

    const opened = await host.handle("session.open", {
      sessionId: f.sessionId,
      mode: "writable",
      writeIntent: true,
      pathId: "leaf:assistant",
    }) as { snapshot: { selectedPathId: string } };
    assert.equal(opened.snapshot.selectedPathId, "leaf:assistant");
    const active = (host as unknown as {
      active?: { session: { sessionManager: SessionManager } };
    }).active;
    assert.equal(active?.session.sessionManager.getLeafId(), "assistant");
    const refreshed = await host.handle("session.refresh", {}) as { selectedPathId: string };
    assert.equal(refreshed.selectedPathId, "leaf:assistant");
  } finally {
    await host.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("path actions roll back before persistence and stay committed after the user entry persists", async () => {
  const f = await fixture();
  const emitted: Array<{ event: string; data?: unknown }> = [];
  const host = new PiHost({
    agentDir: f.agentDir,
    leaseQuietWindowMs: 1,
    conflictPollMs: 60_000,
    emit: (event, data) => emitted.push({ event, data }),
  });
  type PromptOptions = { preflightResult?: (success: boolean) => void; source?: "rpc" | "extension" };
  type WritableInternals = {
    session: {
      sessionId: string;
      sessionManager: SessionManager;
      prompt: (message: string, options?: PromptOptions) => Promise<void>;
      extensionRunner: {
        emit: (event: { type: string; [key: string]: unknown }) => Promise<unknown>;
      };
    };
  };
  const internals = host as unknown as {
    active?: WritableInternals;
    prompt: (
      message: string,
      promptId: string,
      pathAction?: { kind: "editUser" | "continueAssistant" | "continuePath"; entryId: string },
    ) => Promise<{ accepted: boolean; completed: boolean }>;
    installPromptSourceBoundary: (active: WritableInternals) => void;
    onSessionEvent: (active: WritableInternals, event: AgentSessionEvent) => void;
    onPersistedAgentEvent: (active: WritableInternals, event: AgentSessionEvent) => void;
    applyPathAction: (
      active: WritableInternals,
      action: { kind: "editUser" | "continueAssistant" | "continuePath"; entryId: string },
    ) => Promise<string | null>;
  };
  try {
    await host.handle("session.open", { sessionId: f.sessionId, mode: "writable", writeIntent: true });
    const active = internals.active;
    assert.ok(active);
    const manager = active.session.sessionManager;
    const originalPrompt = active.session.prompt;

    active.session.prompt = async (_message, options) => { options?.preflightResult?.(true); };
    internals.installPromptSourceBoundary(active);
    assert.deepEqual(
      await internals.prompt("handled edit", "handled-path", { kind: "editUser", entryId: "user" }),
      { accepted: true, completed: false },
    );
    await waitUntil(
      () => emitted.some(({ data }) => (data as { promptId?: string } | undefined)?.promptId === "handled-path"),
      "handled path completion",
    );
    assert.equal(manager.getLeafId(), "assistant");

    let continuedEntryId: string | undefined;
    active.session.prompt = async (_message, options) => {
      options?.preflightResult?.(true);
      const ownMessage = { role: "user", content: "continued from user", timestamp: Date.now() };
      const event = { type: "message_end", message: ownMessage } as AgentSessionEvent;
      internals.onSessionEvent(active, event);
      continuedEntryId = manager.appendMessage(ownMessage as never);
      internals.onPersistedAgentEvent(active, event);
    };
    internals.installPromptSourceBoundary(active);
    assert.deepEqual(
      await internals.prompt("continued from user", "continued-path", { kind: "continuePath", entryId: "user" }),
      { accepted: true, completed: false },
    );
    await waitUntil(
      () => emitted.some(({ event, data }) => event === "session.promptCompleted"
        && (data as { promptId?: string } | undefined)?.promptId === "continued-path"),
      "continued path persistence",
    );
    assert.ok(continuedEntryId);
    assert.equal(manager.getEntry(continuedEntryId)?.parentId, "user");

    active.session.prompt = async (_message, options) => {
      options?.preflightResult?.(true);
      const ownMessage = { role: "user", content: "persisted edit", timestamp: Date.now() };
      const event = { type: "message_end", message: ownMessage } as AgentSessionEvent;
      internals.onSessionEvent(active, event);
      manager.appendMessage(ownMessage as never);
      internals.onPersistedAgentEvent(active, event);
      throw new Error("agent failed after persistence");
    };
    internals.installPromptSourceBoundary(active);
    assert.deepEqual(
      await internals.prompt("persisted edit", "persisted-path", { kind: "editUser", entryId: "user" }),
      { accepted: true, completed: false },
    );
    await waitUntil(
      () => emitted.some(({ event, data }) => event === "session.promptFailed"
        && (data as { promptId?: string } | undefined)?.promptId === "persisted-path"),
      "persisted path failure",
    );
    const failed = emitted.find(({ event, data }) => event === "session.promptFailed"
      && (data as { promptId?: string } | undefined)?.promptId === "persisted-path");
    assert.equal(typeof (failed?.data as { persistedEntryId?: string }).persistedEntryId, "string");
    assert.notEqual(manager.getLeafId(), "assistant");
    assert.equal(manager.getLeafEntry()?.type, "message");
    active.session.prompt = originalPrompt;
  } finally {
    await host.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("structured tool completion emits a scoped metadata-only session change", async () => {
  const f = await fixture();
  const emitted: Array<{ event: string; data?: unknown }> = [];
  const host = new PiHost({
    agentDir: f.agentDir,
    leaseQuietWindowMs: 1,
    conflictPollMs: 60_000,
    emit: (event, data) => emitted.push({ event, data }),
  });
  type WritableInternals = {
    session: { sessionId: string };
    currentRun?: {
      id: string;
      pathEntryId?: string;
      toolCalls: Map<string, { toolName: string; args: unknown }>;
    };
  };
  const internals = host as unknown as {
    active?: WritableInternals;
    onSessionEvent: (active: WritableInternals, event: AgentSessionEvent) => void;
  };
  try {
    await host.handle("session.open", { sessionId: f.sessionId, mode: "writable", writeIntent: true });
    const active = internals.active;
    assert.ok(active);
    active.currentRun = { id: "run-structured", pathEntryId: "user", toolCalls: new Map() };
    internals.onSessionEvent(active, {
      type: "tool_execution_start",
      toolCallId: "tool-structured",
      toolName: "edit",
      args: { input: "[src/demo.swift#AABBCCDD]\nSWAP 1:\n+private-token" },
    } as AgentSessionEvent);
    internals.onSessionEvent(active, {
      type: "tool_execution_end",
      toolCallId: "tool-structured",
      toolName: "edit",
      result: {
        content: [{ type: "text", text: "Updated src/demo.swift" }],
        details: {
          patch: "--- a/src/demo.swift\n+++ b/src/demo.swift\n@@ -3,1 +3,2 @@\n-old\n+new\n+next\n",
          firstChangedLine: 3,
        },
      },
      isError: false,
    } as AgentSessionEvent);

    const change = emitted.find(({ event }) => event === "session.changeRecorded");
    assert.ok(change);
    assert.deepEqual(change.data, {
      recordId: `${f.sessionId}:run-structured:tool-structured`,
      sessionId: f.sessionId,
      runId: "run-structured",
      pathEntryId: "user",
      toolCallId: "tool-structured",
      operation: "edit",
      filePath: join(f.root, "src", "demo.swift"),
      firstChangedLine: 3,
      additions: 2,
      deletions: 1,
      occurredAt: (change.data as { occurredAt: string }).occurredAt,
      source: "structured-tool-v1",
    });
    const wire = JSON.stringify(change.data);
    assert.equal(wire.includes("private-token"), false);
    assert.equal(wire.includes("@@ -3,1"), false);
  } finally {
    await host.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("run state distinguishes user wait, stop request, and confirmed abort", async () => {
  const f = await fixture();
  const emitted: Array<{ event: string; data?: unknown }> = [];
  const host = new PiHost({
    agentDir: f.agentDir,
    leaseQuietWindowMs: 1,
    conflictPollMs: 60_000,
    emit: (event, data) => emitted.push({ event, data }),
  });
  type RunState = {
    sessionId: string;
    runId: string;
    phase: string;
    waitingFor?: string;
    startedAt: string;
    updatedAt: string;
    inputPersisted: boolean;
    retryable: boolean;
  };
  type WritableInternals = {
    session: { sessionId: string; abort: () => Promise<void> };
    ui: {
      context: {
        confirm: (title: string, message: string) => Promise<boolean>;
        input: (title: string, placeholder: string) => Promise<string | undefined>;
      };
      respond: (requestId: string, response: unknown) => boolean;
    };
    currentRun?: {
      id: string;
      toolCalls: Map<string, { toolName: string; args: unknown }>;
      state: RunState;
      outcome?: "completed" | "failed" | "aborted" | "unknown";
    };
  };
  const internals = host as unknown as {
    active?: WritableInternals;
    onSessionEvent: (active: WritableInternals, event: AgentSessionEvent) => void;
  };
  try {
    await host.handle("session.open", { sessionId: f.sessionId, mode: "writable", writeIntent: true });
    const active = internals.active;
    assert.ok(active);
    const startedAt = new Date().toISOString();
    active.currentRun = {
      id: "run-state",
      toolCalls: new Map(),
      state: {
        sessionId: f.sessionId,
        runId: "run-state",
        phase: "running",
        startedAt,
        updatedAt: startedAt,
        inputPersisted: true,
        retryable: false,
      },
    };

    const decision = active.ui.context.confirm("Permission", "Continue?");
    const input = active.ui.context.input("Value", "Type here");
    const requests = emitted.filter(({ event }) => event === "extension.request");
    const confirmId = (requests.find(({ data }) => (data as { method?: string }).method === "confirm")?.data as { requestId?: string }).requestId;
    const inputId = (requests.find(({ data }) => (data as { method?: string }).method === "input")?.data as { requestId?: string }).requestId;
    assert.equal(typeof confirmId, "string");
    assert.equal(typeof inputId, "string");
    assert.equal(active.currentRun.state.phase, "waitingForUser");
    assert.equal(active.currentRun.state.waitingFor, "input");
    assert.equal(active.ui.respond(confirmId!, { confirmed: true }), true);
    assert.equal(await decision, true);
    assert.equal(active.currentRun.state.phase, "waitingForUser");
    assert.equal(active.ui.respond(inputId!, { value: "done" }), true);
    assert.equal(await input, "done");
    assert.equal(active.currentRun.state.phase, "running");

    active.session.abort = async () => undefined;
    await host.handle("session.abort", {});
    assert.equal(active.currentRun.state.phase, "stopRequested");
    assert.equal(
      (await host.handle("session.getState", {}) as { runState: RunState }).runState.phase,
      "stopRequested",
    );

    internals.onSessionEvent(active, {
      type: "agent_end",
      willRetry: false,
      messages: [{ role: "assistant", stopReason: "aborted" }],
    } as AgentSessionEvent);
    internals.onSessionEvent(active, { type: "agent_settled" } as AgentSessionEvent);
    await waitUntil(
      () => emitted.some(({ event, data }) => event === "session.runStateChanged"
        && (data as { phase?: string } | undefined)?.phase === "aborted"),
      "confirmed aborted run state",
    );
    const terminal = await host.handle("session.getState", {}) as { runState: RunState };
    assert.equal(terminal.runState.phase, "aborted");
    assert.equal(terminal.runState.retryable, false);
  } finally {
    await host.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("settled run state publishes a stable completion identity", async () => {
  const f = await fixture();
  const emitted: Array<{ event: string; data?: unknown }> = [];
  const host = new PiHost({
    agentDir: f.agentDir,
    leaseQuietWindowMs: 1,
    conflictPollMs: 60_000,
    emit: (event, data) => emitted.push({ event, data }),
  });
  type WritableInternals = {
    session: { sessionId: string; sessionManager: SessionManager };
    currentRun?: {
      id: string;
      pathEntryId?: string;
      toolCalls: Map<string, { toolName: string; args: unknown }>;
      state: {
        sessionId: string;
        runId: string;
        phase: string;
        startedAt: string;
        updatedAt: string;
        inputPersisted: boolean;
        retryable: boolean;
      };
    };
  };
  const internals = host as unknown as {
    active?: WritableInternals;
    onSessionEvent: (active: WritableInternals, event: AgentSessionEvent) => void;
  };
  try {
    await host.handle("session.open", { sessionId: f.sessionId, mode: "writable", writeIntent: true });
    const active = internals.active;
    assert.ok(active);
    const startedAt = new Date().toISOString();
    active.currentRun = {
      id: "run-completed",
      pathEntryId: "user",
      toolCalls: new Map(),
      state: {
        sessionId: f.sessionId,
        runId: "run-completed",
        phase: "running",
        startedAt,
        updatedAt: startedAt,
        inputPersisted: true,
        retryable: false,
      },
    };
    internals.onSessionEvent(active, {
      type: "agent_end",
      willRetry: false,
      messages: [{ role: "assistant", stopReason: "stop" }],
    } as AgentSessionEvent);
    active.session.sessionManager.appendCustomEntry("after-assistant", { stable: true });
    internals.onSessionEvent(active, { type: "agent_settled" } as AgentSessionEvent);
    await waitUntil(
      () => emitted.some(({ event, data }) => event === "session.runStateChanged"
        && (data as { phase?: string } | undefined)?.phase === "completed"),
      "completed run state",
    );
    const completion = emitted.find(({ event, data }) => event === "session.runStateChanged"
      && (data as { phase?: string } | undefined)?.phase === "completed")?.data as {
        completionId: string;
        completionEntryId: string;
        inputPersisted: boolean;
      };
    assert.equal(completion.completionId, "run-completed:assistant");
    assert.equal(completion.completionEntryId, "assistant");
    assert.equal(completion.inputPersisted, true);
  } finally {
    await host.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("settled run state stays unknown when its persisted input boundary is missing", async () => {
  const f = await fixture();
  const emitted: Array<{ event: string; data?: unknown }> = [];
  const host = new PiHost({
    agentDir: f.agentDir,
    leaseQuietWindowMs: 1,
    conflictPollMs: 60_000,
    emit: (event, data) => emitted.push({ event, data }),
  });
  type WritableInternals = {
    session: { sessionId: string };
    currentRun?: {
      id: string;
      pathEntryId?: string;
      toolCalls: Map<string, { toolName: string; args: unknown }>;
      state: {
        sessionId: string;
        runId: string;
        phase: string;
        startedAt: string;
        updatedAt: string;
        inputPersisted: boolean;
        retryable: boolean;
      };
    };
  };
  const internals = host as unknown as {
    active?: WritableInternals;
    onSessionEvent: (active: WritableInternals, event: AgentSessionEvent) => void;
  };
  try {
    await host.handle("session.open", { sessionId: f.sessionId, mode: "writable", writeIntent: true });
    const active = internals.active;
    assert.ok(active);
    const startedAt = new Date().toISOString();
    active.currentRun = {
      id: "run-missing-boundary",
      pathEntryId: "missing-user-entry",
      toolCalls: new Map(),
      state: {
        sessionId: f.sessionId,
        runId: "run-missing-boundary",
        phase: "running",
        startedAt,
        updatedAt: startedAt,
        inputPersisted: true,
        retryable: false,
      },
    };
    internals.onSessionEvent(active, {
      type: "agent_end",
      willRetry: false,
      messages: [{ role: "assistant", stopReason: "stop" }],
    } as AgentSessionEvent);
    internals.onSessionEvent(active, { type: "agent_settled" } as AgentSessionEvent);
    await waitUntil(
      () => emitted.some(({ event, data }) => event === "session.runStateChanged"
        && (data as { phase?: string } | undefined)?.phase === "unknown"),
      "unknown run state",
    );
    assert.equal(emitted.some(({ event, data }) => event === "session.runStateChanged"
      && (data as { phase?: string } | undefined)?.phase === "completed"), false);
    const terminal = await host.handle("session.getState", {}) as {
      runState: { phase: string; inputPersisted: boolean };
    };
    assert.equal(terminal.runState.phase, "unknown");
    assert.equal(terminal.runState.inputPersisted, true);
  } finally {
    await host.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("an extension-cancelled path action keeps the leaf and emits no session_tree", async () => {
  const f = await fixture();
  const host = new PiHost({
    agentDir: f.agentDir,
    leaseQuietWindowMs: 1,
    conflictPollMs: 60_000,
    emit: () => undefined,
  });
  type Active = {
    session: {
      sessionManager: SessionManager;
      extensionRunner: {
        hasHandlers: (eventType: string) => boolean;
        emit: (event: { type: string; [key: string]: unknown }) => Promise<unknown>;
      };
    };
  };
  const internals = host as unknown as {
    active?: Active;
  };
  try {
    await host.handle("session.open", { sessionId: f.sessionId, mode: "writable", writeIntent: true });
    const active = internals.active;
    assert.ok(active);
    const originalLeafId = active.session.sessionManager.getLeafId();
    const originalHasHandlers = active.session.extensionRunner.hasHandlers.bind(active.session.extensionRunner);
    const originalEmit = active.session.extensionRunner.emit.bind(active.session.extensionRunner);
    const lifecycle: string[] = [];
    active.session.extensionRunner.hasHandlers = (eventType) => (
      eventType === "session_before_tree" || originalHasHandlers(eventType)
    );
    active.session.extensionRunner.emit = async (event) => {
      lifecycle.push(event.type);
      if (event.type === "session_before_tree") return { cancel: true };
      return await originalEmit(event);
    };

    await assert.rejects(
      host.handle("session.prompt", {
        message: "edited question",
        promptId: "cancelled-path",
        pathAction: { kind: "editUser", entryId: "user" },
      }),
      (error: unknown) => error instanceof PiHostError && error.code === "SESSION_PATH_CANCELLED",
    );
    assert.equal(active.session.sessionManager.getLeafId(), originalLeafId);
    assert.deepEqual(lifecycle, ["session_before_tree"]);
  } finally {
    await host.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("copy releases a temporary source lease when copying fails", async () => {
  const f = await fixture();
  const host = new PiHost({
    agentDir: f.agentDir,
    leaseQuietWindowMs: 1,
    conflictPollMs: 60_000,
    emit: () => undefined,
  });
  const leasePath = join(f.agentDir, "pi-dcode", "leases", `${f.sessionId}.lock`);
  const sourcePath = join(f.agentDir, "sessions", "project", `${f.sessionId}.jsonl`);
  try {
    await appendFile(sourcePath, "{incomplete");
    await assert.rejects(
      host.handle("session.copy", { sessionId: f.sessionId, targetCwd: f.root }),
      (error: unknown) => typeof error === "object"
        && error !== null
        && (error as { code?: unknown }).code === "INVALID_SESSION",
    );
    await assert.rejects(access(leasePath));
    const retryLease = await SessionLease.acquire({
      agentDir: f.agentDir,
      sessionId: f.sessionId,
      sessionPath: sourcePath,
      quietWindowMs: 1,
    });
    await retryLease.release();
  } finally {
    await host.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("copy rechecks current-session busy state immediately before publish", async () => {
  const f = await fixture();
  const host = new PiHost({
    agentDir: f.agentDir,
    leaseQuietWindowMs: 1,
    conflictPollMs: 60_000,
    emit: () => undefined,
  });
  const copier = host.sessionCopier;
  const originalCopy = copier.copy.bind(copier);
  let busy = false;
  try {
    await host.handle("session.open", { sessionId: f.sessionId, mode: "writable", writeIntent: true });
    const active = (host as unknown as { active?: { session: object } }).active;
    assert.ok(active);
    Object.defineProperty(active.session, "isStreaming", { configurable: true, get: () => busy });
    copier.copy = async (options) => await originalCopy({
      ...options,
      assertSourceStable: async () => {
        busy = true;
        await options.assertSourceStable();
      },
    });

    await assert.rejects(
      host.handle("session.copy", { sessionId: f.sessionId, targetCwd: f.root }),
      (error: unknown) => error instanceof PiHostError && error.code === "SESSION_BUSY",
    );
    const recent = await host.reader.list({ origin: "dcode" });
    assert.deepEqual(recent, []);
    busy = false;
    Reflect.deleteProperty(active.session, "isStreaming");
  } finally {
    busy = false;
    await host.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a stale search target does not close the current session", async () => {
  const f = await fixture();
  const host = new PiHost({ agentDir: f.agentDir, conflictPollMs: 60_000, emit: () => undefined });
  try {
    await host.handle("session.open", { sessionId: f.sessionId });
    await assert.rejects(
      host.handle("session.open", {
        sessionId: f.sessionId,
        expectedEntryId: "missing-search-entry",
      }),
      (error: unknown) => error instanceof PiHostError && error.code === "SEARCH_TARGET_STALE",
    );
    const state = await host.handle("session.getState", {}) as { sessionId: string; writable: boolean };
    assert.equal(state.sessionId, f.sessionId);
    assert.equal(state.writable, true, "过期搜索目标不得关闭当前可写会话");
  } finally {
    await host.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
test("searching within the current writable session reopens with takeover and keeps the lease", async () => {
  const f = await fixture();
  const host = new PiHost({
    agentDir: f.agentDir,
    leaseQuietWindowMs: 10,
    conflictPollMs: 60_000,
    emit: () => undefined,
  });
  const leasePath = join(f.agentDir, "pi-dcode", "leases", `${f.sessionId}.lock`);
  try {
    await host.handle("session.open", { sessionId: f.sessionId });
    const opened = await host.handle("session.open", {
      sessionId: f.sessionId,
      expectedEntryId: "assistant",
    }) as { mode: string; state: { writable: boolean } };
    assert.equal(opened.mode, "writable");
    assert.equal(opened.state.writable, true);
    await access(leasePath);
    await assert.rejects(
      host.handle("session.open", {
        sessionId: f.sessionId,
        expectedEntryId: "missing-search-entry",
      }),
      (error: unknown) => error instanceof PiHostError && error.code === "SEARCH_TARGET_STALE",
    );
    const state = await host.handle("session.getState", {}) as { sessionId: string; writable: boolean };
    assert.equal(state.sessionId, f.sessionId);
    assert.equal(state.writable, true);
    await access(leasePath);
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
test("a search result whose body changed under the same entry ID is stale", async () => {
  const f = await fixture();
  const targetId = "search-rewritten-target";
  const targetPath = await writeTargetSession(f, targetId);
  const host = new PiHost({ agentDir: f.agentDir, leaseQuietWindowMs: 10, conflictPollMs: 60_000, emit: () => undefined });
  try {
    await host.handle("session.open", { sessionId: f.sessionId });
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
    await assert.rejects(
      host.handle("session.open", {
        sessionId: targetId,
        expectedEntryId: "assistant",
        expectedEntryDigest: searchEntryDigest("assistant", "target answer"),
      }),
      (error: unknown) => error instanceof PiHostError && error.code === "SEARCH_TARGET_STALE",
    );
    const state = await host.handle("session.getState", {}) as { sessionId: string; writable: boolean };
    assert.equal(state.sessionId, f.sessionId);
    assert.equal(state.writable, true, "过期目标不得关闭当前会话");
  } finally {
    await host.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a writable conflict stops writes and a takeover reopen resolves it", async () => {
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
    await host.handle("session.open", { sessionId: f.sessionId });
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
    const conflicted = await host.handle("session.getState", {}) as { writable: boolean };
    assert.equal(conflicted.writable, false, "冲突后停止写入");

    const reopened = await host.handle("session.open", {
      sessionId: f.sessionId,
    }) as { mode: string; state: { writable: boolean }; snapshot: { entries: Array<{ id?: string }> } };
    assert.equal(reopened.mode, "writable");
    assert.equal(reopened.state.writable, true);
    assert.ok(reopened.snapshot.entries.some((entry) => entry.id === "external-conflict"), "重开接管能看到外部写入的条目");
  } finally {
    await host.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
test("an abort failure retains the lease and poisons later writes", async () => {
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
    await host.handle("session.open", { sessionId: f.sessionId });
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
    await host.handle("session.close", {});
    await access(leasePath);
    assert.ok(events.some((entry) => entry.event === "host.restartRequired"));
    await assert.rejects(
      host.handle("session.open", { sessionId: f.sessionId }),
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
test("an unverifiable lease release keeps the lock and poisons the host", async () => {
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
    await host.handle("session.open", { sessionId: f.sessionId });
    const owner = JSON.parse(await readFile(ownerPath, "utf8")) as Record<string, unknown>;
    await writeFile(ownerPath, `${JSON.stringify({ ...owner, nonce: "different-owner" })}\n`);
    await host.handle("session.close", {});
    await access(leasePath);
    assert.ok(events.some((entry) => entry.event === "session.cleanupError"));
    assert.ok(events.some((entry) => entry.event === "host.restartRequired"));
    await assert.rejects(
      host.handle("session.open", { sessionId: f.sessionId }),
      (error: unknown) => error instanceof PiHostError && error.code === "HOST_RESTART_REQUIRED",
    );
  } finally {
    await host.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
test("writable open takes over immediately and releases its lease on close", async () => {
  const f = await fixture();
  const host = new PiHost({ agentDir: f.agentDir, leaseQuietWindowMs: 10, conflictPollMs: 60_000, emit: () => undefined });
  const leasePath = join(f.agentDir, "pi-dcode", "leases", `${f.sessionId}.lock`);
  try {
    const opened = await host.handle("session.open", { sessionId: f.sessionId }) as { mode: string };
    assert.equal(opened.mode, "writable");
    await access(leasePath);
    await host.handle("session.close", { expectedSessionId: f.sessionId });
    await assert.rejects(access(leasePath));
  } finally {
    await host.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
test("a writable session rename persists through Pi session_info and can restore the automatic title", async () => {
  const f = await fixture();
  const events: Array<{ event: string; data?: unknown }> = [];
  const host = new PiHost({
    agentDir: f.agentDir,
    leaseAgentDir: f.agentDir,
    leaseQuietWindowMs: 1,
    conflictPollMs: 60_000,
    emit: (event, data) => events.push({ event, data }),
  });
  const sessionPath = join(f.agentDir, "sessions", "project", `${f.sessionId}.jsonl`);
  try {
    await host.handle("session.open", {
      sessionId: f.sessionId,
      mode: "writable",
      writeIntent: true,
    });
    const renamed = await host.handle("session.setName", { name: "真实会话名称" }) as {
      summary: { id: string; name?: string };
    };
    assert.equal(renamed.summary.id, f.sessionId);
    assert.equal(renamed.summary.name, "真实会话名称");
    const state = await host.handle("session.getState", {}) as { sessionName?: string };
    assert.equal(state.sessionName, "真实会话名称");
    const persisted = (await readFile(sessionPath, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as { type?: string; name?: string });
    assert.ok(persisted.some((entry) => entry.type === "session_info" && entry.name === "真实会话名称"));
    assert.ok(events.some((entry) => entry.event === "session.event"));

    const cleared = await host.handle("session.setName", { name: "" }) as {
      summary: { name?: string };
    };
    assert.equal(cleared.summary.name, undefined);
  } finally {
    await host.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("session.close only closes the expected active session", async () => {
  const f = await fixture();
  const host = new PiHost({
    agentDir: f.agentDir,
    emit: () => undefined,
  });
  try {
    await host.handle("session.open", { sessionId: f.sessionId, mode: "readOnly" });
    await assert.rejects(
      host.handle("session.close", { expectedSessionId: "another-session" }),
      (error: unknown) => error instanceof PiHostError && error.code === "SESSION_ACTIVE_CHANGED",
    );
    const retained = await host.handle("session.getState", {}) as { sessionId: string };
    assert.equal(retained.sessionId, f.sessionId);

    const closed = await host.handle("session.close", { expectedSessionId: f.sessionId }) as { closed: boolean };
    assert.equal(closed.closed, true);
    await assert.rejects(
      host.handle("session.getState", {}),
      (error: unknown) => error instanceof PiHostError && error.code === "SESSION_NOT_OPEN",
    );
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

test("a second takeover force-steals the lease and the first owner exits with LEASE_STOLEN", async () => {
  const f = await fixture();
  const firstEvents: Array<{ event: string; data?: unknown }> = [];
  const first = new PiHost({
    agentDir: f.agentDir,
    leaseQuietWindowMs: 10,
    conflictPollMs: 10,
    emit: (event, data) => firstEvents.push({ event, data }),
  });
  const second = new PiHost({ agentDir: f.agentDir, leaseQuietWindowMs: 10, conflictPollMs: 60_000, emit: () => undefined });
  const leasePath = join(f.agentDir, "pi-dcode", "leases", `${f.sessionId}.lock`);
  try {
    await first.handle("session.open", { sessionId: f.sessionId });
    const stolen = await second.handle("session.open", { sessionId: f.sessionId }) as { mode: string };
    assert.equal(stolen.mode, "writable", "打开即接管：第二个实例直接抢占成功");
    await access(join(leasePath, "owner.json"));
    await waitUntil(
      () => firstEvents.some(
        (entry) => entry.event === "session.conflict"
          && (entry.data as { code?: unknown } | undefined)?.code === "LEASE_STOLEN",
      ),
      "the first owner to detect LEASE_STOLEN",
    );
    await assert.rejects(
      first.handle("session.prompt", { message: "no", promptId: "stolen-prompt" }),
      (error: unknown) => error instanceof PiHostError,
    );
  } finally {
    await first.close();
    await second.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
test("host commits a Pi session without opening a runtime or taking a lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-dcode-create-test-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), "{}\n");
  const host = new PiHost({ agentDir, leaseQuietWindowMs: 1, conflictPollMs: 60_000, emit: () => undefined });
  try {
    const created = await host.handle("session.create", { cwd: root }) as {
      created: boolean;
      session: { id: string; path: string; cwd: string };
      activation: { status: string };
    };
    assert.equal(created.created, true);
    assert.equal(created.activation.status, "created");
    assert.equal(created.session.cwd, await realpath(root));
    assert.ok(created.session.path.includes("--"));
    await assert.rejects(
      host.handle("session.getState", {}),
      (error: unknown) => error instanceof PiHostError && error.code === "SESSION_NOT_OPEN",
    );
    await assert.rejects(access(join(agentDir, "pi-dcode", "leases", `${created.session.id}.lock`)));
    await assert.rejects(
      host.handle("session.create", { cwd: join(root, "missing") }),
      (error: unknown) => error instanceof PiHostError && error.code === "CWD_NOT_ACCESSIBLE",
    );
    await assert.rejects(
      host.handle("session.getState", {}),
      (error: unknown) => error instanceof PiHostError && error.code === "SESSION_NOT_OPEN",
    );
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

test("creation does not depend on a global session-id resolve after the file commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-dcode-create-failure-test-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), "{}\n");
  const host = new PiHost({ agentDir, leaseQuietWindowMs: 1, conflictPollMs: 60_000, emit: () => undefined });
  const reader = host.reader as unknown as { resolve: (sessionId: string) => Promise<unknown> };
  reader.resolve = async () => { throw new Error("global resolve must not run during create"); };
  try {
    const created = await host.handle("session.create", { cwd: root }) as {
      created: boolean;
      session: { id: string };
      activation: { status: string };
    };
    assert.equal(created.created, true);
    assert.equal(created.activation.status, "created");
    assert.ok(created.session.id);
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("atomic new-file publication never exposes a partial destination and never overwrites", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-dcode-atomic-publish-test-"));
  const destination = join(root, "created.jsonl");
  const contents = `${"x".repeat(16 * 1024 * 1024)}\n`;
  try {
    let settled = false;
    const publishing = publishNewFileAtomically(destination, contents).finally(() => { settled = true; });
    const visibleSizes: number[] = [];
    while (!settled) {
      try { visibleSizes.push((await stat(destination)).size); }
      catch { /* The atomic destination is intentionally absent before commit. */ }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await publishing;
    visibleSizes.push((await stat(destination)).size);
    assert.ok(visibleSizes.length > 0);
    assert.ok(visibleSizes.every((size) => size === Buffer.byteLength(contents)));

    await assert.rejects(publishNewFileAtomically(destination, "replacement\n"));
    assert.equal(await readFile(destination, "utf8"), contents);
    assert.equal((await readdir(root)).filter((name) => name.endsWith(".pending")).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("creating a new session leaves the existing writable runtime active", async () => {
  const f = await fixture();
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
    const created = await host.handle("session.create", { cwd: f.root }) as {
      session: { id: string; path: string };
      activation: { status: string };
    };
    const state = await host.handle("session.getState", {}) as {
      sessionId: string;
      writable: boolean;
    };
    assert.equal(created.activation.status, "created");
    assert.notEqual(created.session.id, f.sessionId);
    assert.equal(state.sessionId, f.sessionId);
    assert.equal(state.writable, true);
    await access(created.session.path);
    await assert.rejects(access(join(f.agentDir, "pi-dcode", "leases", `${created.session.id}.lock`)));
  } finally {
    await host.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("creation never calls runtime activation after the file commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-dcode-create-unavailable-test-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), "{}\n");
  const host = new PiHost({ agentDir, leaseQuietWindowMs: 1, conflictPollMs: 60_000, emit: () => undefined });
  const internals = host as unknown as {
    openReadOnlySession: (...args: unknown[]) => Promise<unknown>;
  };
  let activationCalls = 0;
  internals.openReadOnlySession = async () => {
    activationCalls += 1;
    throw new PiHostError("SESSION_OBSERVATION_FAILED", "Synthetic observation failure");
  };
  try {
    const created = await host.handle("session.create", { cwd: root }) as {
      created: boolean;
      session: { id: string };
      activation: { status: string };
    };
    assert.equal(created.created, true);
    assert.equal(created.activation.status, "created");
    assert.equal(activationCalls, 0);
    const recent = await host.handle("session.list", { origin: "dcode" }) as { sessions: Array<{ id: string }> };
    assert.deepEqual(recent.sessions.map((session) => session.id), [created.session.id]);
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an empty D Code session moves to the recoverable Trash and disappears from navigation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-dcode-trash-test-"));
  const agentDir = join(root, "agent");
  const trashDirectory = join(root, "Trash");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), "{}\n");
  const host = new PiHost({
    agentDir,
    trashDirectory,
    leaseQuietWindowMs: 1,
    conflictPollMs: 60_000,
    emit: () => undefined,
  });
  try {
    const created = await host.handle("session.create", { cwd: root }) as {
      session: { id: string; path: string };
    };
    await host.handle("session.open", { sessionId: created.session.id, mode: "readOnly" });
    const result = await host.handle("session.trash", { sessionId: created.session.id }) as {
      trashed: boolean;
      trashPath: string;
    };
    assert.equal(result.trashed, true);
    await assert.rejects(access(created.session.path));
    await access(result.trashPath);
    assert.equal((await readdir(trashDirectory)).length, 1);
    const recent = await host.handle("session.list", { origin: "dcode" }) as { sessions: unknown[] };
    assert.deepEqual(recent.sessions, []);
    await assert.rejects(
      host.handle("session.getState", {}),
      (error: unknown) => error instanceof PiHostError && error.code === "SESSION_NOT_OPEN",
    );
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("trash refuses non-empty and non-D Code sessions without removing their files", async () => {
  const f = await fixture();
  const host = new PiHost({
    agentDir: f.agentDir,
    trashDirectory: join(f.root, "Trash"),
    leaseQuietWindowMs: 1,
    conflictPollMs: 60_000,
    emit: () => undefined,
  });
  const originalPath = join(f.agentDir, "sessions", "project", `${f.sessionId}.jsonl`);
  try {
    await assert.rejects(
      host.handle("session.trash", { sessionId: f.sessionId }),
      (error: unknown) => error instanceof PiHostError && error.code === "SESSION_TRASH_NOT_ALLOWED",
    );
    await access(originalPath);

    const created = await host.handle("session.create", { cwd: f.root }) as {
      session: { id: string; path: string };
    };
    const document = (await readFile(created.session.path, "utf8")).trimEnd().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const origin = document[1] as Record<string, unknown>;
    await appendFile(created.session.path, `${JSON.stringify({
      type: "message",
      id: "user-after-create",
      parentId: origin.id,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "keep me", timestamp: Date.now() },
    })}\n`);
    await assert.rejects(
      host.handle("session.trash", { sessionId: created.session.id }),
      (error: unknown) => error instanceof PiHostError && error.code === "SESSION_TRASH_NOT_EMPTY",
    );
    await access(created.session.path);

    const emptySource = await host.handle("session.create", { cwd: f.root }) as {
      session: { id: string; path: string };
    };
    const childPath = join(f.sessionsDir, "child-of-empty-source.jsonl");
    await writeFile(childPath, `${JSON.stringify({
      type: "session",
      version: 3,
      id: "child-of-empty-source",
      timestamp: new Date().toISOString(),
      cwd: f.root,
      parentSession: emptySource.session.path,
    })}\n`);
    await assert.rejects(
      host.handle("session.trash", { sessionId: emptySource.session.id }),
      (error: unknown) => error instanceof PiHostError && error.code === "SESSION_HAS_DESCENDANTS",
    );
    await access(emptySource.session.path);
    await access(childPath);
  } finally {
    await host.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("trash restores the source when an external writer appends after quarantine", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-dcode-trash-append-race-test-"));
  const agentDir = join(root, "agent");
  const trashDirectory = join(root, "Trash");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), "{}\n");
  const host = new PiHost({ agentDir, trashDirectory, leaseQuietWindowMs: 1, emit: () => undefined });
  try {
    const created = await host.handle("session.create", { cwd: root }) as {
      session: { id: string; path: string };
    };
    const origin = JSON.parse((await readFile(created.session.path, "utf8")).trimEnd().split("\n")[1] as string) as {
      id: string;
    };
    const reader = host.reader as unknown as {
      inspectPath: (path: string, sessionId: string, leafId?: string | null) => Promise<unknown>;
    };
    const originalInspect = reader.inspectPath.bind(host.reader);
    let appended = false;
    reader.inspectPath = async (path, sessionId, leafId) => {
      if (!appended && path.endsWith(".trash-pending")) {
        appended = true;
        await appendFile(path, `${JSON.stringify({
          type: "message",
          id: "external-user",
          parentId: origin.id,
          timestamp: new Date().toISOString(),
          message: { role: "user", content: "external", timestamp: Date.now() },
        })}\n`);
      }
      return await originalInspect(path, sessionId, leafId);
    };

    await assert.rejects(
      host.handle("session.trash", { sessionId: created.session.id }),
      (error: unknown) => error instanceof PiHostError && error.code === "SESSION_TRASH_NOT_EMPTY",
    );
    assert.equal(appended, true);
    await access(created.session.path);
    assert.equal((await readdir(trashDirectory)).length, 0);
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("trash restores the source when a descendant appears during the isolated check", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-dcode-trash-child-race-test-"));
  const agentDir = join(root, "agent");
  const trashDirectory = join(root, "Trash");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), "{}\n");
  const host = new PiHost({ agentDir, trashDirectory, leaseQuietWindowMs: 1, emit: () => undefined });
  try {
    const created = await host.handle("session.create", { cwd: root }) as {
      session: { id: string; path: string };
    };
    const reader = host.reader as unknown as {
      hasDescendantSession: (path: string) => Promise<boolean>;
    };
    const originalHasDescendant = reader.hasDescendantSession.bind(host.reader);
    let checks = 0;
    const childPath = join(agentDir, "sessions", "race-child.jsonl");
    reader.hasDescendantSession = async (path) => {
      checks += 1;
      const result = await originalHasDescendant(path);
      if (checks === 3) {
        await writeFile(childPath, `${JSON.stringify({
          type: "session",
          version: 3,
          id: "race-child",
          timestamp: new Date().toISOString(),
          cwd: root,
          parentSession: created.session.path,
        })}\n`);
        return false;
      }
      return result;
    };

    await assert.rejects(
      host.handle("session.trash", { sessionId: created.session.id }),
      (error: unknown) => error instanceof PiHostError && error.code === "SESSION_HAS_DESCENDANTS",
    );
    await access(created.session.path);
    await access(childPath);
    assert.equal((await readdir(trashDirectory)).length, 0);
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("trash failure keeps the source file unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-dcode-trash-failure-test-"));
  const agentDir = join(root, "agent");
  const blockedTrashPath = join(root, "Trash-is-a-file");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), "{}\n");
  await writeFile(blockedTrashPath, "not a directory\n");
  const host = new PiHost({
    agentDir,
    trashDirectory: blockedTrashPath,
    leaseQuietWindowMs: 1,
    emit: () => undefined,
  });
  try {
    const created = await host.handle("session.create", { cwd: root }) as {
      session: { id: string; path: string };
    };
    await assert.rejects(host.handle("session.trash", { sessionId: created.session.id }));
    await access(created.session.path);
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
    const persisted = emitted.find(({ event }) => event === "session.promptCompleted");
    assert.equal(persisted?.event, "session.promptCompleted");
    assert.equal((persisted?.data as { sessionId?: string }).sessionId, f.sessionId);
    assert.equal((persisted?.data as { promptId?: string }).promptId, "owned-prompt-1");
    assert.equal((persisted?.data as { outcome?: string }).outcome, "persisted");
    assert.match((persisted?.data as { entryId?: string }).entryId ?? "", /^[0-9a-f]{8}$/);
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
