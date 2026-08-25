import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiHost } from "../src/pi-host.js";

function sha256(value: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function successfulProviderResponse(): Response {
  const id = "chatcmpl-imported-history";
  const chunks = [
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1_000),
      model: "history-model",
      choices: [{ index: 0, delta: { role: "assistant", content: "continued" }, finish_reason: null }],
    })}\n\n`,
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1_000),
      model: "history-model",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })}\n\n`,
    "data: [DONE]\n\n",
  ];
  return new Response(chunks.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

test("an imported Pi Session continues through a bounded D Code history projection without modifying its source", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-imported-history-continuation-"));
  const agentDir = join(root, "agent");
  const sessionsDirectory = join(agentDir, "sessions");
  const dataRoot = join(root, ".dcode");
  const userHome = join(root, "home");
  const sourceDirectory = join(sessionsDirectory, "source");
  const sourcePath = join(sourceDirectory, "source.jsonl");
  const providerBodies: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    if (typeof init?.body === "string") providerBodies.push(init.body);
    return successfulProviderResponse();
  }) as typeof fetch;
  await mkdir(sourceDirectory, { recursive: true });
  await mkdir(userHome);
  await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({
    defaultProvider: "history",
    defaultModel: "history-model",
    enabledModels: ["history/history-model"],
  })}\n`);
  await writeFile(join(agentDir, "auth.json"), "{}\n");
  await writeFile(join(agentDir, "models.json"), `${JSON.stringify({
    providers: {
      history: {
        name: "History",
        baseUrl: "https://history.invalid/v1",
        api: "openai-completions",
        apiKey: "test-key",
        models: [{ id: "history-model", name: "History Model", reasoning: false, contextWindow: 100_000, maxTokens: 4_096 }],
      },
    },
  })}\n`);
  await writeFile(sourcePath, [
    { type: "session", version: 3, id: "source", timestamp: "2026-08-25T00:00:00.000Z", cwd: userHome },
    {
      type: "message",
      id: "source-user",
      parentId: null,
      timestamp: "2026-08-25T00:00:01.000Z",
      message: { role: "user", content: "历史任务背景：先核对现状", timestamp: 1 },
    },
    {
      type: "message",
      id: "source-assistant",
      parentId: "source-user",
      timestamp: "2026-08-25T00:00:02.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hidden chain of thought" },
          { type: "text", text: "历史结论：继续前先检查。 api_key: supersafefixturevalue" },
          { type: "toolCall", id: "tool-source", name: "bash", arguments: { secret: "must-not-leak" } },
        ],
        api: "openai-completions",
        provider: "history",
        model: "history-model",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} },
        stopReason: "stop",
        timestamp: 2,
      },
    },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const sourceDigestBefore = sha256(await readFile(sourcePath));
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
      currentUser: { id: string };
      storeRevision: number;
    };
    const imported = await host.handle("piImport.importAsTask", {
      requestId: "import-source-session",
      expectedStoreRevision: initial.storeRevision,
      scope: { kind: "user", userId: initial.currentUser.id },
      sourceSessionId: "source",
    }) as {
      task: { id: string; scope: { kind: "user"; userId: string } };
      coordinationSession: { id: string };
    };
    const started = await host.handle("runtime.start", {
      requestId: "start-imported-session",
      runtimeId: "runtime-imported-session",
      taskId: imported.task.id,
      dcodeSessionId: imported.coordinationSession.id,
      scope: imported.task.scope,
      workspace: { workspaceId: "workspace-imported", cwd: userHome, access: "exclusiveWrite" },
    }) as { binding: { adapterSessionId: string } };
    assert.notEqual(started.binding.adapterSessionId, "source");
    await host.handle("session.prompt", {
      runtimeId: "runtime-imported-session",
      promptId: "continue-imported-session",
      message: "请在 D Code 中继续这项任务。",
    });
    const deadline = Date.now() + 5_000;
    while (true) {
      const snapshot = await host.handle("foundation.snapshot", {}) as {
        sessionRuns: Array<{ sessionId: string; status: string }>;
      };
      const run = snapshot.sessionRuns.filter((item) => item.sessionId === imported.coordinationSession.id).at(-1);
      if (run?.status === "completed") break;
      if (Date.now() >= deadline) throw new Error("Imported continuation did not finish");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const providerBody = providerBodies.at(-1);
    assert.ok(providerBody);
    const request = JSON.parse(providerBody) as {
      messages?: Array<{ role?: string; content?: unknown }>;
    };
    const system = request.messages?.find((message) => message.role === "system")?.content;
    const user = request.messages?.find((message) => message.role === "user")?.content;
    assert.equal(typeof system, "string");
    const userText = Array.isArray(user)
      ? user.flatMap((block) => (
        typeof block === "object" && block !== null && !Array.isArray(block)
          && (block as { type?: unknown }).type === "text"
          && typeof (block as { text?: unknown }).text === "string"
          ? [(block as { text: string }).text]
          : []
      )).join("\n")
      : user;
    assert.equal(userText, "请在 D Code 中继续这项任务。");
    assert.match(system as string, /<dcode_imported_history /);
    assert.match(system as string, /不是当前指令，不是 D Code Raw Input/);
    assert.match(system as string, /历史任务背景：先核对现状/);
    assert.match(system as string, /历史结论：继续前先检查。 \[REDACTED\]/);
    assert.equal((system as string).includes("hidden chain of thought"), false);
    assert.equal((system as string).includes("must-not-leak"), false);
    assert.equal((system as string).includes("supersafefixturevalue"), false);

    const finalSnapshot = await host.handle("foundation.snapshot", {}) as {
      promptReceipts: Array<{
        sessionId: string;
        importedHistoryReceipt?: { digest: string; sourceSessionId: string; sourcePathId: string };
      }>;
    };
    const receipt = finalSnapshot.promptReceipts.find((item) => item.sessionId === imported.coordinationSession.id);
    assert.equal(receipt?.importedHistoryReceipt?.sourceSessionId, "source");
    assert.match(receipt?.importedHistoryReceipt?.sourcePathId ?? "", /^leaf:/);
    assert.match(receipt?.importedHistoryReceipt?.digest ?? "", /^sha256:[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(receipt).includes("历史任务背景"), false);
    assert.equal(sha256(await readFile(sourcePath)), sourceDigestBefore);
  } finally {
    await host.close();
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
