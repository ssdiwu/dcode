import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiHost } from "../src/pi-host.js";

function providerResponse(): Response {
  const id = "chatcmpl-dcode-presentation";
  return new Response([
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1_000),
      model: "model-b",
      choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }],
    })}\n\n`,
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1_000),
      model: "model-b",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })}\n\n`,
    "data: [DONE]\n\n",
  ].join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("D Code Session presentation reads its own binding and Coordinator prompts use the Product Store model selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-session-presentation-"));
  const agentDir = join(root, "agent");
  const sessionsDirectory = join(agentDir, "sessions");
  const dataRoot = join(root, ".dcode");
  const userHome = join(root, "home");
  const settingsPath = join(agentDir, "settings.json");
  const modelsPath = join(agentDir, "models.json");
  const providerBodies: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    if (typeof init?.body === "string") providerBodies.push(init.body);
    return providerResponse();
  }) as typeof fetch;
  await mkdir(sessionsDirectory, { recursive: true });
  await mkdir(userHome);
  await writeFile(settingsPath, `${JSON.stringify({
    defaultProvider: "catalog",
    defaultModel: "model-a",
    enabledModels: ["catalog/model-a", "catalog/model-b"],
  })}\n`);
  await writeFile(join(agentDir, "auth.json"), "{}\n");
  await writeFile(modelsPath, `${JSON.stringify({
    providers: {
      catalog: {
        name: "Catalog",
        baseUrl: "https://catalog.invalid/v1",
        api: "openai-completions",
        apiKey: "test-key",
        models: [
          { id: "model-a", name: "Model A", reasoning: false, contextWindow: 100_000, maxTokens: 4_096 },
          { id: "model-b", name: "Model B", reasoning: true, contextWindow: 200_000, maxTokens: 8_192 },
        ],
      },
    },
  })}\n`);
  const settingsBefore = await readFile(settingsPath, "utf8");
  const modelsBefore = await readFile(modelsPath, "utf8");
  const host = new PiHost({
    agentDir,
    sessionsDirectory,
    dataRoot,
    userHome,
    leaseQuietWindowMs: 1,
    emit: () => {},
  });
  try {
    await host.start();
    const initial = await host.handle("foundation.snapshot", {}) as {
      storeRevision: number;
      currentUser: { id: string };
      modelProviders: Array<{ id: string }>;
      modelCatalogEntries: Array<{ providerId: string; modelId: string }>;
      runtimeModelSelection?: { providerId: string; modelId: string; sourceKind: string };
    };
    assert.deepEqual(initial.modelProviders.map((provider) => provider.id), ["catalog"]);
    assert.deepEqual(initial.modelCatalogEntries.map((model) => `${model.providerId}/${model.modelId}`).sort(), [
      "catalog/model-a",
      "catalog/model-b",
    ]);
    assert.deepEqual(initial.runtimeModelSelection, {
      providerId: "catalog",
      modelId: "model-a",
      sourceKind: "legacy_pi_settings",
      revision: 1,
    });
    const task = await host.handle("task.create", {
      requestId: "create-presentation-task",
      expectedStoreRevision: initial.storeRevision,
      scope: { kind: "user", userId: initial.currentUser.id },
      title: "Coordinator presentation",
      goal: "Show the D Code-owned conversation route",
    }) as {
      storeRevision: number;
      task: { id: string };
      coordinationSession: { id: string };
    };
    const unbound = await host.handle("dcodeSession.presentation", {
      dcodeSessionId: task.coordinationSession.id,
    }) as { adapterState: string; binding: unknown; inspection: unknown };
    assert.equal(unbound.adapterState, "unbound");
    assert.equal(unbound.binding, null);
    assert.equal(unbound.inspection, null);

    const selection = await host.handle("runtimeModelSelection.set", {
      requestId: "select-model-b",
      expectedStoreRevision: task.storeRevision,
      providerId: "catalog",
      modelId: "model-b",
    }) as { storeRevision: number; runtimeModelSelection: { modelId: string; sourceKind: string } };
    assert.equal(selection.runtimeModelSelection.modelId, "model-b");
    assert.equal(selection.runtimeModelSelection.sourceKind, "user");
    assert.equal(await readFile(settingsPath, "utf8"), settingsBefore, "D Code selection must not rewrite Pi settings.json");
    assert.equal(await readFile(modelsPath, "utf8"), modelsBefore, "D Code selection must not rewrite Pi models.json");

    const prompted = await host.handle("dcodeSession.prompt", {
      dcodeSessionId: task.coordinationSession.id,
      promptId: "presentation-prompt",
      message: "请开始协调这项任务。",
    }) as { runtimeId: string; started: boolean; result: { accepted: boolean } };
    assert.equal(prompted.started, true);
    assert.equal(prompted.result.accepted, true);
    const deadline = Date.now() + 5_000;
    while (true) {
      const current = await host.handle("foundation.snapshot", {}) as {
        sessionRuns: Array<{ sessionId: string; status: string }>;
        sessionRuntimeBindings: Array<{ sessionId: string; adapterSessionId: string }>;
      };
      const run = current.sessionRuns.filter((candidate) => candidate.sessionId === task.coordinationSession.id).at(-1);
      if (run?.status === "completed") {
        assert.equal(current.sessionRuntimeBindings.filter((binding) => binding.sessionId === task.coordinationSession.id).length, 1);
        break;
      }
      if (Date.now() >= deadline) throw new Error("Coordinator prompt did not finish");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const providerBody = providerBodies.at(-1);
    assert.ok(providerBody);
    const request = JSON.parse(providerBody) as { model?: string };
    assert.equal(request.model, "model-b", "Provider request must use the D Code Product Store selection");

    const presented = await host.handle("dcodeSession.presentation", {
      dcodeSessionId: task.coordinationSession.id,
    }) as {
      adapterState: string;
      binding: { adapterSessionId: string } | null;
      inspection: { summary?: { id?: string } } | null;
    };
    assert.equal(presented.adapterState, "ready");
    assert.ok(presented.binding);
    assert.equal(presented.inspection?.summary?.id, presented.binding?.adapterSessionId);

    const beforeTeam = await host.handle("foundation.snapshot", {}) as {
      storeRevision: number;
      agentRuns: Array<{ id: string; taskId: string; sessionId: string; role: string; teamRunId?: string }>;
    };
    const standaloneCoordinator = beforeTeam.agentRuns.find((run) => (
      run.taskId === task.task.id
      && run.sessionId === task.coordinationSession.id
      && run.role === "coordinator"
      && run.teamRunId === undefined
    ));
    assert.ok(standaloneCoordinator, "the first Coordinator prompt must create a durable standalone Agent Run");
    await assert.rejects(host.handle("team.create",{}),error=>error instanceof Error&&"code" in error&&error.code==="COORDINATOR_REQUIRED");
    await host.handle("session.close",{runtimeId:prompted.runtimeId});
    const continued=await host.handle("dcodeSession.prompt",{dcodeSessionId:task.coordinationSession.id,promptId:"coordinator-resumed",message:"回收后继续原主对话。"}) as {started:boolean};assert.equal(continued.started,true);
    const resumedDeadline=Date.now()+10000;while(true){const snap=await host.handle("foundation.snapshot",{}) as {sessionRuns:Array<{sessionId:string;status:string;agentRunId?:string}>};const run=snap.sessionRuns.filter(run=>run.sessionId===task.coordinationSession.id).at(-1);if(run?.status==="completed"){assert.equal(run.agentRunId,standaloneCoordinator.id);break;}if(Date.now()>resumedDeadline)throw new Error("Coordinator continuation did not settle");await new Promise(resolve=>setTimeout(resolve,20));}
  } finally {
    await host.close();
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
