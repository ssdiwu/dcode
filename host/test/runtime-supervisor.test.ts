import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiHost, PiHostError } from "../src/pi-host.js";

// Completed work can still publish independent process lifecycle facts. Match
// the client's revision-conflict protocol for new task/project intents, while
// retaining the request identity and every target-specific validation.
async function createDuringRuntime(host:PiHost,method:"project.create"|"task.create",params:Record<string,unknown>):Promise<unknown>{
  let next={...params};
  for(let attempt=0;attempt<8;attempt++) {
    try{return await host.handle(method,next);}catch(error){
      const failure=error as {code?:string;details?:{expectedStoreRevision?:unknown;currentStoreRevision?:unknown}};
      if(failure.code!=="REVISION_CONFLICT"||typeof failure.details?.expectedStoreRevision!=="number"||typeof failure.details.currentStoreRevision!=="number"||attempt===7)throw error;
      next={...next,expectedStoreRevision:(await host.handle("foundation.snapshot",{}) as {storeRevision:number}).storeRevision};
    }
  }
  throw new Error("Unreachable mutation retry");
}

async function writeSession(
  sessionsDirectory: string,
  sessionId: string,
  cwd: string,
  provider = "openai",
  model = "gpt-4o-mini",
): Promise<void> {
  const directory = join(sessionsDirectory, sessionId);
  await mkdir(directory, { recursive: true });
  const timestamp = new Date().toISOString();
  const entries: Record<string, unknown>[] = [
    { type: "session", version: 3, id: sessionId, timestamp, cwd },
    { type: "model_change", id: `${sessionId}-model`, parentId: null, timestamp, provider, modelId: model },
    {
      type: "message",
      id: `${sessionId}-user`,
      parentId: `${sessionId}-model`,
      timestamp,
      message: { role: "user", content: `hello ${sessionId}`, timestamp: Date.now() },
    },
    {
      type: "message",
      id: `${sessionId}-assistant`,
      parentId: `${sessionId}-user`,
      timestamp,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        api: "openai-completions",
        provider,
        model,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} },
        stopReason: "stop",
        timestamp: Date.now(),
      },
    },
  ];
  await writeFile(join(directory, `${sessionId}.jsonl`), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

test("two explicit Runtimes keep different D Code Sessions active concurrently", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-runtime-supervisor-"));
  const agentDir = join(root, "agent");
  const sessionsDirectory = join(agentDir, "sessions");
  const dataRoot = join(root, ".dcode");
  const workspaceA = join(root, "workspace-a");
  const workspaceB = join(root, "workspace-b");
  const workspaceC = join(root, "workspace-c");
  let providerArrivals = 0;
  const providerRequestBodies: string[] = [];
  let childProviderArrivals = 0;
  let releaseChildProviders: (() => void) | undefined;
  const childProviderRelease = new Promise<void>((resolve) => { releaseChildProviders = resolve; });
  let confirmChildOverlap: (() => void) | undefined;
  const childProviderOverlap = new Promise<void>((resolve) => { confirmChildOverlap = resolve; });
  let releaseProvider: (() => void) | undefined;
  const providerRelease = new Promise<void>((resolve) => { releaseProvider = resolve; });
  let confirmOverlap: (() => void) | undefined;
  const providerOverlap = new Promise<void>((resolve) => { confirmOverlap = resolve; });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    const requestBody = typeof init?.body === "string" ? init.body : "";
    if (requestBody) providerRequestBodies.push(requestBody);
    providerArrivals += 1;
    if (providerArrivals === 2) confirmOverlap?.();
    await providerRelease;
    if (requestBody.includes("D Code Agent Assignment")) {
      childProviderArrivals += 1;
      if (childProviderArrivals === 2) confirmChildOverlap?.();
      await childProviderRelease;
    }
    const id = `chatcmpl-${providerArrivals}`;
    const chunks = [`data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1_000),
      model: "barrier-model",
      choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }],
    })}\n\n`, `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1_000),
      model: "barrier-model",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })}\n\n`, "data: [DONE]\n\n"];
    return new Response(chunks.join(""), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
  await mkdir(agentDir, { recursive: true });
  await mkdir(workspaceA);
  await mkdir(workspaceB);
  await mkdir(workspaceC);
  await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({
    defaultProvider: "barrier",
    defaultModel: "barrier-model",
    enabledModels: ["barrier/barrier-model"],
  })}\n`);
  await writeFile(join(agentDir, "auth.json"), "{}\n");
  await writeFile(join(agentDir, "models.json"), `${JSON.stringify({
    providers: {
      barrier: {
        name: "Barrier",
        baseUrl: "https://barrier.invalid/v1",
        api: "openai-completions",
        apiKey: "test-key",
        models: [{
          id: "barrier-model",
          name: "Barrier Model",
          reasoning: false,
          contextWindow: 100_000,
          maxTokens: 4_096,
        }],
      },
    },
  })}\n`);
  await writeSession(sessionsDirectory, "adapter-a", workspaceA, "barrier", "barrier-model");
  await writeSession(sessionsDirectory, "adapter-b", workspaceB, "barrier", "barrier-model");
  const events: Array<{ event: string; data?: unknown }> = [];
  const host = new PiHost({
    agentDir,
    sessionsDirectory,
    dataRoot,
    userHome: root,
    leaseQuietWindowMs: 1,
    emit: (event, data) => events.push({ event, data }),
  });
  try {
    await host.start();
    const initial = await host.handle("foundation.snapshot", {}) as {
      currentUser: { id: string };
      storeRevision: number;
    };
    const projectA = await createDuringRuntime(host,"project.create", {
      requestId: "project-a",
      expectedStoreRevision: initial.storeRevision,
      title: "Project A",
      directory: workspaceA,
    }) as { storeRevision: number; project: { id: string } };
    const projectB = await createDuringRuntime(host,"project.create", {
      requestId: "project-b",
      expectedStoreRevision: projectA.storeRevision,
      title: "Project B",
      directory: workspaceB,
    }) as { storeRevision: number; project: { id: string } };
    const taskA = await createDuringRuntime(host,"task.create", {
      requestId: "task-a",
      expectedStoreRevision: projectB.storeRevision,
      scope: { kind: "project", projectId: projectA.project.id },
      title: "Task A",
      goal: "Run A",
    }) as {
      storeRevision: number;
      task: { id: string };
      coordinationSession: { id: string };
    };
    const taskB = await createDuringRuntime(host,"task.create", {
      requestId: "task-b",
      expectedStoreRevision: taskA.storeRevision,
      scope: { kind: "project", projectId: projectB.project.id },
      title: "Task B",
      goal: "Run B",
    }) as {
      storeRevision: number;
      task: { id: string };
      coordinationSession: { id: string };
    };
    const globalKnowledgeRoot = join(root, "Knowledge");
    await mkdir(globalKnowledgeRoot);
    await writeFile(join(workspaceB, "DESIGN.md"), "# Task Context Design\n\nSELECTED_PROJECT_CONTEXT\n");
    await writeFile(join(globalKnowledgeRoot, "runtime-context.md"), "# Global Context\n\nSELECTED_GLOBAL_CONTEXT\n");
    const contextSnapshot = await host.handle("foundation.snapshot", {}) as {
      storeRevision: number;
      taskContextSets: Array<{ taskId: string; revision: number }>;
    };
    const taskBContext = contextSnapshot.taskContextSets.find((set) => set.taskId === taskB.task.id);
    assert.ok(taskBContext);
    const selectedContext = await host.handle("task.context.replace", {
      requestId: "task-b-context",
      expectedStoreRevision: contextSnapshot.storeRevision,
      taskId: taskB.task.id,
      scope: { kind: "project", projectId: projectB.project.id },
      expectedContextRevision: taskBContext!.revision,
      sources: [
        { kind: "scope_document", relativePath: "DESIGN.md", title: "设计" },
        {
          kind: "global_knowledge",
          rootPath: globalKnowledgeRoot,
          relativePath: "runtime-context.md",
          title: "全局知识",
        },
      ],
    }) as { storeRevision: number; contextSet: { revision: number; sources: Array<{ relativePath: string }> } };
    assert.equal(selectedContext.contextSet.revision, 2);
    assert.deepEqual(selectedContext.contextSet.sources.map((source) => source.relativePath), ["DESIGN.md", "runtime-context.md"]);
    const adapterSessionsBeforeWrongWorkspace = await host.handle("session.list", {}) as { sessions: Array<{ id: string }> };
    await assert.rejects(
      host.handle("runtime.start", {
        requestId: "task-a-wrong-workspace",
        runtimeId: "runtime-a-wrong-workspace",
        taskId: taskA.task.id,
        dcodeSessionId: taskA.coordinationSession.id,
        scope: { kind: "project", projectId: projectA.project.id },
        workspace: { workspaceId: "wrong-workspace", cwd: workspaceB, access: "exclusiveWrite" },
      }),
      (error: unknown) => error instanceof PiHostError && error.code === "WORKSPACE_TASK_SCOPE_REQUIRED",
    );
    const adapterSessionsAfterWrongWorkspace = await host.handle("session.list", {}) as { sessions: Array<{ id: string }> };
    assert.deepEqual(adapterSessionsAfterWrongWorkspace.sessions.map((session) => session.id), adapterSessionsBeforeWrongWorkspace.sessions.map((session) => session.id));
    const projectC = await createDuringRuntime(host,"project.create", {
      requestId: "project-c",
      expectedStoreRevision: selectedContext.storeRevision,
      title: "Project C",
      directory: workspaceC,
    }) as { storeRevision: number; project: { id: string } };
    const taskC = await createDuringRuntime(host,"task.create", {
      requestId: "task-c",
      expectedStoreRevision: projectC.storeRevision,
      scope: { kind: "project", projectId: projectC.project.id },
      title: "Task C",
      goal: "Refuse missing selected Context before Runtime binding",
    }) as {
      storeRevision: number;
      task: { id: string; scope: { kind: "project"; projectId: string } };
      coordinationSession: { id: string };
    };
    const taskCSnapshot = await host.handle("foundation.snapshot", {}) as {
      storeRevision: number;
      taskContextSets: Array<{ taskId: string; revision: number }>;
    };
    const taskCContext = taskCSnapshot.taskContextSets.find((set) => set.taskId === taskC.task.id);
    assert.ok(taskCContext);
    const taskCMissingContext = await host.handle("task.context.replace", {
      requestId: "task-c-missing-context",
      expectedStoreRevision: taskCSnapshot.storeRevision,
      taskId: taskC.task.id,
      scope: taskC.task.scope,
      expectedContextRevision: taskCContext!.revision,
      sources: [{ kind: "scope_document", relativePath: "MISSING-DESIGN.md", title: "缺失设计" }],
    }) as { storeRevision: number };
    const adapterSessionsBeforeRejectedStart = await host.handle("session.list", {}) as { sessions: Array<{ id: string }> };
    await assert.rejects(
      host.handle("runtime.start", {
        requestId: "task-c-missing-context-runtime",
        runtimeId: "runtime-c-missing-context",
        taskId: taskC.task.id,
        dcodeSessionId: taskC.coordinationSession.id,
        scope: taskC.task.scope,
        workspace: { workspaceId: "workspace-c", cwd: workspaceC, access: "exclusiveWrite" },
      }),
      (error: unknown) => error instanceof PiHostError && error.code === "TASK_CONTEXT_UNAVAILABLE",
    );
    const adapterSessionsAfterRejectedStart = await host.handle("session.list", {}) as { sessions: Array<{ id: string }> };
    assert.deepEqual(adapterSessionsAfterRejectedStart.sessions.map((session) => session.id), adapterSessionsBeforeRejectedStart.sessions.map((session) => session.id));
    assert.equal((await host.handle("foundation.snapshot", {}) as { storeRevision: number }).storeRevision, taskCMissingContext.storeRevision);
    const identityA = {
      runtimeId: "runtime-a",
      taskId: taskA.task.id,
      dcodeSessionId: taskA.coordinationSession.id,
      adapterSessionId: "adapter-a",
      scope: { kind: "project", projectId: projectA.project.id },
      workspace: { workspaceId: "workspace-a", cwd: workspaceA, access: "exclusiveWrite" },
    };
    const identityB = {
      runtimeId: "runtime-b",
      taskId: taskB.task.id,
      dcodeSessionId: taskB.coordinationSession.id,
      adapterSessionId: "adapter-b",
      scope: { kind: "project", projectId: projectB.project.id },
      workspace: { workspaceId: "workspace-b", cwd: workspaceB, access: "exclusiveWrite" },
    };

    await Promise.all([
      host.handle("session.open", { ...identityA, sessionId: "adapter-a", mode: "writable", writeIntent: true }),
      host.handle("session.open", { ...identityB, sessionId: "adapter-b", mode: "writable", writeIntent: true }),
    ]);
    const listed = await host.handle("runtime.list", {}) as {
      runtimes: Array<{
        identity: { runtimeId: string };
        sessionId: string;
        systemPromptDigest: string;
        activeToolNames: string[];
      }>;
    };
    assert.deepEqual(
      listed.runtimes.map((runtime) => `${runtime.identity.runtimeId}:${runtime.sessionId}`).sort(),
      ["runtime-a:adapter-a", "runtime-b:adapter-b"],
    );
    assert.ok(listed.runtimes.every((runtime) => /^sha256:[a-f0-9]{64}$/.test(runtime.systemPromptDigest)));
    assert.ok(listed.runtimes.every((runtime) => runtime.activeToolNames.includes("read")));
    const stateA = await host.handle("session.getState", { runtimeId: "runtime-a" }) as { sessionId: string };
    const stateB = await host.handle("session.getState", { runtimeId: "runtime-b" }) as { sessionId: string };
    assert.equal(stateA.sessionId, "adapter-a");
    assert.equal(stateB.sessionId, "adapter-b");
    assert.ok(events.some(({ event, data }) => event === "session.opened"
      && (data as { runtime?: { runtimeId?: unknown } }).runtime?.runtimeId === "runtime-a"));
    assert.ok(events.some(({ event, data }) => event === "session.opened"
      && (data as { runtime?: { runtimeId?: unknown } }).runtime?.runtimeId === "runtime-b"));

    const beforeCredentialRejection = await host.handle("foundation.snapshot", {}) as {
      sessionRuns: unknown[];
      operationAttempts: unknown[];
    };
    await assert.rejects(
      host.handle("session.prompt", {
        runtimeId: "runtime-a",
        message: "Authorization: Bearer credential-material-that-must-not-be-stored",
        promptId: "credential-prompt",
      }),
      (error: unknown) => error instanceof PiHostError && error.code === "CREDENTIAL_MATERIAL_REJECTED",
    );
    const afterCredentialRejection = await host.handle("foundation.snapshot", {}) as {
      sessionRuns: unknown[];
      operationAttempts: unknown[];
    };
    assert.equal(afterCredentialRejection.sessionRuns.length, beforeCredentialRejection.sessionRuns.length);
    assert.equal(afterCredentialRejection.operationAttempts.length, beforeCredentialRejection.operationAttempts.length);
    assert.equal(providerArrivals, 0, "rejected credential material must not reach the Provider");

    const prompts = Promise.all([
      host.handle("session.prompt", {
        runtimeId: "runtime-a",
        message: "run provider A",
        promptId: "prompt-a",
      }),
      host.handle("session.prompt", {
        runtimeId: "runtime-b",
        message: "run provider B",
        promptId: "prompt-b",
      }),
    ]);
    let overlapTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        providerOverlap,
        new Promise<never>((_resolve, reject) => {
          overlapTimer = setTimeout(() => reject(new Error("Provider requests did not overlap")), 5_000);
        }),
      ]);
    } finally {
      if (overlapTimer) clearTimeout(overlapTimer);
    }
    assert.equal(providerArrivals, 2, "both Provider requests must be in flight before either response is released");
    const processA = (await host.handle("session.getState", { runtimeId: "runtime-a" }) as { process: { pid: number; status: string } }).process;
    const processB = (await host.handle("session.getState", { runtimeId: "runtime-b" }) as { process: { pid: number; status: string } }).process;
    assert.equal(processA.status, "running");
    assert.equal(processB.status, "running");
    assert.notEqual(processA.pid, process.pid);
    assert.notEqual(processA.pid, processB.pid);

    releaseProvider?.();
    await prompts;
    const completionDeadline = Date.now() + 5_000;
    while (events.filter(({ event }) => event === "session.durableRunFinished").length < 2) {
      if (Date.now() >= completionDeadline) throw new Error("Durable Session Runs did not finish");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const durable = await host.handle("foundation.snapshot", {}) as {
      sessionRuns: Array<{ status: string }>;
      operationAttempts: Array<{ status: string }>;
    };
    assert.equal(durable.sessionRuns.filter((run) => run.status === "completed").length, 2);
    assert.equal(durable.operationAttempts.filter((attempt) => attempt.status === "succeeded").length, 2);

    await writeFile(join(workspaceB, "AGENTS.md"), "# Next Run Rule\n\nFRESH_NEXT_RUN_RULE\n");
    const bodiesBeforeRefresh = providerRequestBodies.length;
    await host.handle("session.prompt", {
      runtimeId: "runtime-b",
      message: "reload project rules on this run",
      promptId: "prompt-b-next-run",
    });
    const refreshDeadline = Date.now() + 5_000;
    while (events.filter(({ event }) => event === "session.durableRunFinished").length < 3) {
      if (Date.now() >= refreshDeadline) throw new Error("Next Session Run did not finish");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(providerRequestBodies.slice(bodiesBeforeRefresh).some((body) => body.includes("FRESH_NEXT_RUN_RULE")));
    assert.ok(providerRequestBodies.some((body) => body.includes("SELECTED_PROJECT_CONTEXT")));
    assert.ok(providerRequestBodies.some((body) => body.includes("SELECTED_GLOBAL_CONTEXT")));

    const matchingSourceSnapshot = await host.handle("foundation.snapshot", {}) as {
      promptReceipts: Array<{
        id: string;
        sessionId: string;
        sourceReceipts: unknown;
        sourceStates: Array<{ kind?: string; state: string; contentStored: boolean; unavailableReason?: string }>;
      }>;
    };
    const trackedReceipt = matchingSourceSnapshot.promptReceipts
      .filter((receipt) => receipt.sessionId === taskB.coordinationSession.id && receipt.sourceStates.length > 0)
      .at(-1);
    assert.ok(trackedReceipt, "the next Run must expose its Prompt Source state");
    const agentsSource = trackedReceipt.sourceStates.find((source) => source.kind === "required_agents");
    assert.equal(agentsSource?.state, "current_match");
    assert.equal(agentsSource?.contentStored, false);
    assert.equal(JSON.stringify(trackedReceipt.sourceReceipts).includes("FRESH_NEXT_RUN_RULE"), false);

    await writeFile(join(workspaceB, "AGENTS.md"), "# Changed After Receipt\n");
    const mismatchSnapshot = await host.handle("foundation.snapshot", {}) as typeof matchingSourceSnapshot;
    const mismatchedReceipt = mismatchSnapshot.promptReceipts.find((receipt) => receipt.id === trackedReceipt.id);
    assert.equal(mismatchedReceipt?.sourceStates.find((source) => source.kind === "required_agents")?.state, "hash_mismatch");

    await rm(join(workspaceB, "AGENTS.md"));
    const unavailableSnapshot = await host.handle("foundation.snapshot", {}) as typeof matchingSourceSnapshot;
    const unavailableReceipt = unavailableSnapshot.promptReceipts.find((receipt) => receipt.id === trackedReceipt.id);
    assert.equal(unavailableReceipt?.sourceStates.find((source) => source.kind === "required_agents")?.state, "historical_unavailable");
    assert.equal(unavailableReceipt?.sourceStates.find((source) => source.kind === "required_agents")?.unavailableReason, "missing");

    await host.handle("session.close", { runtimeId: "runtime-a", expectedSessionId: "adapter-a" });
    const afterClose = await host.handle("runtime.list", {}) as {
      runtimes: Array<{ identity: { runtimeId: string } }>;
    };
    assert.deepEqual(afterClose.runtimes.map((runtime) => runtime.identity.runtimeId), ["runtime-b"]);
    assert.equal((await host.handle("session.getState", { runtimeId: "runtime-b" }) as { sessionId: string }).sessionId, "adapter-b");

    await assert.rejects(
      host.handle("session.open", {
        ...identityA,
        runtimeId: "runtime-c",
        sessionId: "adapter-b",
        adapterSessionId: "adapter-b",
        taskId: taskB.task.id,
        dcodeSessionId: taskB.coordinationSession.id,
        scope: identityB.scope,
        workspace: identityB.workspace,
        mode: "writable",
        writeIntent: true,
      }),
      (error: unknown) => error instanceof PiHostError
        && (error.code === "ADAPTER_SESSION_ALREADY_ACTIVE" || error.code === "WORKSPACE_IN_USE"),
    );

    const nativeStarted = await host.handle("runtime.start", {
      requestId: "start-native-runtime",
      runtimeId: "runtime-native",
      taskId: taskA.task.id,
      dcodeSessionId: taskA.coordinationSession.id,
      scope: identityA.scope,
      workspace: { workspaceId: "workspace-native", cwd: workspaceA, access: "exclusiveWrite" },
    }) as {
      binding: { adapterSessionId: string; sessionId: string };
    };
    assert.equal(nativeStarted.binding.sessionId, taskA.coordinationSession.id);
    assert.notEqual(nativeStarted.binding.adapterSessionId, "adapter-a");
    const withNative = await host.handle("runtime.list", {}) as {
      runtimes: Array<{ identity: { runtimeId: string } }>;
    };
    assert.deepEqual(
      withNative.runtimes.map((runtime) => runtime.identity.runtimeId).sort(),
      ["runtime-b", "runtime-native"],
    );
    await host.handle("session.close", {
      runtimeId: "runtime-native",
      expectedSessionId: nativeStarted.binding.adapterSessionId,
    });

    await assert.rejects(host.handle("team.create",{}),error=>error instanceof PiHostError&&error.code==="COORDINATOR_REQUIRED");
    await assert.rejects(host.handle("team.start",{}),error=>error instanceof PiHostError&&error.code==="COORDINATOR_REQUIRED");
    const finalFoundation = await host.handle("foundation.snapshot", {}) as {
      promptReceipts: Array<{ systemPromptDigest: string }>;
    };
    const receiptDigests = new Set(finalFoundation.promptReceipts.map((receipt) => receipt.systemPromptDigest));
    for (const body of providerRequestBodies) {
      const parsed = JSON.parse(body) as { messages?: Array<{ role?: string; content?: unknown }>; tools?: unknown[] };
      const systemContent = parsed.messages?.find((message) => message.role === "system")?.content;
      assert.equal(typeof systemContent, "string");
      assert.match(systemContent as string, /- read:/);
      assert.doesNotMatch(systemContent as string, /本轮没有活动工具/);
      const digest = `sha256:${createHash("sha256").update(systemContent as string).digest("hex")}`;
      assert.ok(receiptDigests.has(digest), "Provider-received System Prompt must match a durable Receipt digest");
      assert.ok((parsed.tools?.length ?? 0) > 0);
    }

    const repository = join(root, "same-worktree");
    const repositoryA = join(repository, "packages", "a");
    const repositoryB = join(repository, "packages", "b");
    await mkdir(join(repository, ".git"), { recursive: true });
    await mkdir(repositoryA, { recursive: true });
    await mkdir(repositoryB, { recursive: true });
    const isolationSnapshot = await host.handle("foundation.snapshot", {}) as { storeRevision: number; currentUser: { id: string } };
    const isolationProjectA = await createDuringRuntime(host,"project.create", {
      requestId: "isolation-project-a",
      expectedStoreRevision: isolationSnapshot.storeRevision,
      title: "Isolation A",
      directory: repositoryA,
    }) as { storeRevision: number; project: { id: string } };
    const isolationProjectB = await createDuringRuntime(host,"project.create", {
      requestId: "isolation-project-b",
      expectedStoreRevision: isolationProjectA.storeRevision,
      title: "Isolation B",
      directory: repositoryB,
    }) as { storeRevision: number; project: { id: string } };
    const isolationTaskA = await createDuringRuntime(host,"task.create", {
      requestId: "isolation-task-a",
      expectedStoreRevision: isolationProjectB.storeRevision,
      scope: { kind: "project", projectId: isolationProjectA.project.id },
      title: "Isolation Task A",
      goal: "Own the Git worktree",
    }) as { storeRevision: number; task: { id: string; scope: { kind: "project"; projectId: string } }; coordinationSession: { id: string } };
    const isolationTaskB = await createDuringRuntime(host,"task.create", {
      requestId: "isolation-task-b",
      expectedStoreRevision: isolationTaskA.storeRevision,
      scope: { kind: "project", projectId: isolationProjectB.project.id },
      title: "Isolation Task B",
      goal: "Must conflict with the same Git worktree",
    }) as { task: { id: string; scope: { kind: "project"; projectId: string } }; coordinationSession: { id: string } };
    await host.handle("runtime.start", {
      requestId: "isolation-runtime-a",
      runtimeId: "runtime-isolation-a",
      taskId: isolationTaskA.task.id,
      dcodeSessionId: isolationTaskA.coordinationSession.id,
      scope: isolationTaskA.task.scope,
      workspace: { workspaceId: "isolation-a", cwd: repositoryA, access: "exclusiveWrite" },
    });
    await assert.rejects(
      host.handle("runtime.start", {
        requestId: "isolation-runtime-b",
        runtimeId: "runtime-isolation-b",
        taskId: isolationTaskB.task.id,
        dcodeSessionId: isolationTaskB.coordinationSession.id,
        scope: isolationTaskB.task.scope,
        workspace: { workspaceId: "isolation-b", cwd: repositoryB, access: "exclusiveWrite" },
      }),
      (error: unknown) => error instanceof PiHostError && error.code === "WORKSPACE_IN_USE",
    );
    await host.handle("session.close", { runtimeId: "runtime-isolation-a" });
  } finally {
    releaseProvider?.();
    releaseChildProviders?.();
    await host.close();
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("Provider HTTP failure is durable failed state rather than completed success", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-provider-failure-"));
  const agentDir = join(root, "agent");
  const sessionsDirectory = join(agentDir, "sessions");
  const dataRoot = join(root, ".dcode");
  const home = join(root, "home");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: "unauthorized" } }), {
    status: 401,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;
  await mkdir(sessionsDirectory, { recursive: true });
  await mkdir(home);
  await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({
    defaultProvider: "failure",
    defaultModel: "failure-model",
    enabledModels: ["failure/failure-model"],
  })}\n`);
  await writeFile(join(agentDir, "auth.json"), "{}\n");
  await writeFile(join(agentDir, "models.json"), `${JSON.stringify({
    providers: {
      failure: {
        name: "Failure",
        baseUrl: "https://failure.invalid/v1",
        api: "openai-completions",
        apiKey: "test-key",
        models: [{
          id: "failure-model",
          name: "Failure Model",
          reasoning: false,
          contextWindow: 100_000,
          maxTokens: 4_096,
        }],
      },
    },
  })}\n`);
  const host = new PiHost({ agentDir, sessionsDirectory, dataRoot, userHome: home, emit: () => {} });
  try {
    await host.start();
    const initial = await host.handle("foundation.snapshot", {}) as {
      currentUser: { id: string };
      storeRevision: number;
    };
    const task = await createDuringRuntime(host,"task.create", {
      requestId: "failure-task",
      expectedStoreRevision: initial.storeRevision,
      scope: { kind: "user", userId: initial.currentUser.id },
      title: "Provider failure",
      goal: "Persist the failure honestly",
    }) as { task: { id: string; scope: { kind: "user"; userId: string } }; coordinationSession: { id: string } };
    await host.handle("runtime.start", {
      requestId: "failure-runtime",
      runtimeId: "runtime-failure",
      taskId: task.task.id,
      dcodeSessionId: task.coordinationSession.id,
      scope: task.task.scope,
      workspace: { workspaceId: "failure-workspace", cwd: home, access: "exclusiveWrite" },
    });
    await host.handle("session.prompt", {
      runtimeId: "runtime-failure",
      message: "This request must fail",
      promptId: "failure-prompt",
    });
    const deadline = Date.now() + 5_000;
    while (true) {
      const snapshot = await host.handle("foundation.snapshot", {}) as {
        sessionRuns: Array<{ status: string }>;
        operationAttempts: Array<{ operationKind: string; status: string }>;
      };
      const runStatus = snapshot.sessionRuns.at(-1)?.status;
      if (["failed", "unknown", "completed"].includes(runStatus ?? "")) {
        assert.equal(runStatus, "failed");
        assert.equal(
          snapshot.operationAttempts.filter((attempt) => attempt.operationKind === "provider_request").at(-1)?.status,
          "failed",
        );
        break;
      }
      if (Date.now() >= deadline) throw new Error("Provider failure did not settle durably");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    await host.close();
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("stopping a standalone Coordinator records an idempotent native stop without creating a Team", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-stop-coordinator-"));
  const agentDir = join(root, "agent");
  const sessionsDirectory = join(agentDir, "sessions");
  const dataRoot = join(root, ".dcode");
  const home = join(root, "home");
  let providerRequests = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    providerRequests += 1;
    return await new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(new DOMException("Aborted", "AbortError"));
      if (init?.signal?.aborted) abort();
      else init?.signal?.addEventListener("abort", abort, { once: true });
    });
  }) as typeof fetch;
  await mkdir(sessionsDirectory, { recursive: true });
  await mkdir(home);
  await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({
    defaultProvider: "barrier",
    defaultModel: "barrier-model",
    enabledModels: ["barrier/barrier-model"],
  })}\n`);
  await writeFile(join(agentDir, "auth.json"), "{}\n");
  await writeFile(join(agentDir, "models.json"), `${JSON.stringify({
    providers: {
      barrier: {
        name: "Barrier",
        baseUrl: "https://barrier.invalid/v1",
        api: "openai-completions",
        apiKey: "test-key",
        models: [{ id: "barrier-model", name: "Barrier", reasoning: false, contextWindow: 100_000, maxTokens: 4_096 }],
      },
    },
  })}\n`);
  const host = new PiHost({ agentDir, sessionsDirectory, dataRoot, userHome: home, emit: () => {} });
  try {
    await host.start();
    const initial = await host.handle("foundation.snapshot", {}) as {
      currentUser: { id: string };
      storeRevision: number;
    };
    const task = await createDuringRuntime(host,"task.create", {
      requestId: "stop-team-task",
      expectedStoreRevision: initial.storeRevision,
      scope: { kind: "user", userId: initial.currentUser.id },
      title: "Stop Coordinator",
      goal: "Stop only the selected member",
    }) as { task: { id: string; scope: { kind: "user"; userId: string } }; coordinationSession: { id: string }; storeRevision: number };
    const prompted=await host.handle("dcodeSession.prompt",{dcodeSessionId:task.coordinationSession.id,promptId:"start",message:"开始检查"}) as {runtimeId:string};
    let snapshot=await host.handle("foundation.snapshot",{}) as import("../src/product-store.js").FoundationSnapshot;
    const deadline=Date.now()+10000;while(!providerRequests){if(Date.now()>deadline)throw new Error("Provider did not start");await new Promise(resolve=>setTimeout(resolve,20));}
    snapshot=await host.handle("foundation.snapshot",{}) as typeof snapshot;
    const coordinator=snapshot.agentRuns.find(run=>run.role==="coordinator")!,run=snapshot.sessionRuns.find(run=>run.agentRunId===coordinator.id)!;
    const params={requestId:"stop-once",expectedStoreRevision:snapshot.storeRevision,runtimeId:prompted.runtimeId,scope:task.task.scope,taskId:task.task.id,agentRunId:coordinator.id,sessionRunId:run.id,expectedAgentRunRevision:coordinator.revision};
    const stopped=await host.handle("agentRun.stop",params) as {stopped:boolean;attemptId:string};assert.equal(stopped.stopped,true);
    assert.equal((await host.handle("agentRun.stop",params) as {replayed:boolean}).replayed,true);
    snapshot=await host.handle("foundation.snapshot",{}) as typeof snapshot;
    assert.equal(snapshot.sessionRuns.find(item=>item.id===run.id)!.status,"aborted");assert.equal(snapshot.agentRuns.find(item=>item.id===coordinator.id)!.status,"aborted");assert.equal(snapshot.teamRuns.length,0);assert.equal(providerRequests,1);
    assert.ok(snapshot.operationAttempts.some(attempt=>attempt.id===stopped.attemptId&&attempt.status==="succeeded"));
  }finally{await host.close();globalThis.fetch=originalFetch;await rm(root,{recursive:true,force:true});}
});
