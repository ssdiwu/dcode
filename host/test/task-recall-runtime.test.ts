import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiHost } from "../src/pi-host.js";
import { ProductStore, type FoundationSnapshot } from "../src/product-store.js";

function completion(content: string, action?: unknown, id = "recall") {
  const tool = action ? { index: 0, id, type: "function", function: { name: "dcode_recall", arguments: JSON.stringify(action) } } : undefined;
  const chunk = { id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: tool ? { role: "assistant", tool_calls: [tool] } : { role: "assistant", content }, finish_reason: null }] };
  const end = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}

test("the live recall tool stays inside its Task and Project and cites only a read inspiration version", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-recall-runtime-")), home = join(root, "home"), agent = join(root, "agent");
  const a = join(home, "a"), b = join(home, "b"), dataRoot = join(home, ".dcode");
  await mkdir(agent); await mkdir(a, { recursive: true }); await mkdir(b);
  await writeFile(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "zai-coding-cn", defaultModel: "fixture", retry: { enabled: false } }));
  await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { "zai-coding-cn": { baseUrl: "https://open.bigmodel.cn/api/paas/v4", api: "openai-completions", apiKey: "fixture-only", models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 4096 }] } } }));
  await writeFile(join(a, "study.md"), "shared-key: Project A source\n");
  await writeFile(join(b, "study.md"), "shared-key: Project B private source\n");
  const store = await ProductStore.open({ dataRoot, userHome: home });
  let snapshot = await store.snapshot();
  const pa = await store.createProject({ requestId: "project-a", expectedStoreRevision: snapshot.storeRevision, title: "A", directory: a });
  const pb = await store.createProject({ requestId: "project-b", expectedStoreRevision: pa.storeRevision, title: "B", directory: b });
  const ta = await store.createTask({ requestId: "task-a", expectedStoreRevision: pb.storeRevision, scope: { kind: "project", projectId: pa.project.id }, title: "A Task", goal: "核对 shared-key" });
  const tb = await store.createTask({ requestId: "task-b", expectedStoreRevision: ta.storeRevision, scope: { kind: "project", projectId: pb.project.id }, title: "B Task", goal: "私有历史" });
  const seed = async (id: string, task: typeof ta, cwd: string, message: string) => {
    const prepared = await store.prepareSessionRun({ requestId: id, taskId: task.task.id, scope: task.task.scope,
      sessionId: task.coordinationSession.id, runtimeId: `${id}-runtime`, workspaceId: `${id}-workspace`, cwd,
      workspaceAccess: "sharedReadOnly", message, attachmentRefs: [], roleRevision: "coordinator:v1", contextRevision: 1,
      profileSnapshot: { role: "coordinator" }, tools: [], toolsWritable: false, systemPromptDigest: `sha256:${"f".repeat(64)}`, promptSources: [] });
    await store.startSessionRun(prepared.sessionRunId);
    await store.finishSessionRun({ sessionRunId: prepared.sessionRunId, providerAttemptId: prepared.providerAttemptId, outcome: "succeeded", assistantText: "已记录" });
  };
  await seed("seed-a", ta, a, "shared-key: Task A message");
  await seed("seed-b", tb, b, "shared-key: Task B private message");
  snapshot = await store.snapshot();
  await store.mutateInspiration({ requestId: "idea", expectedStoreRevision: snapshot.storeRevision,
    operation: { kind: "save", node: { id: `idea-${randomUUID()}`, kind: "text", title: "shared-key 灵感", markdown: "第一版灵感原文" }, expectedNodeRevision: 0 } });
  await store.close();

  const previousFetch = globalThis.fetch;
  const seen: Array<{kind:string;title:string}> = [];
  const readResults: Array<{ citation?: string; content?: string; sourceUseId?: string }> = [];
  let projectCandidateId: string | undefined;
  let calls = 0;
  globalThis.fetch = (async (_url, init) => {
    if (String(_url).includes("quota/limit")) return Response.json({ success: true, code: 200, data: { limits: [{ type: "TOKENS_LIMIT", percentage: 20, nextResetTime: Date.now() + 3600000 }] } });
    const body = JSON.parse(String(init?.body)); calls++;
    assert.ok(body.tools.some((item: { function: { name: string } }) => item.function.name === "dcode_recall"));
    const last = body.messages.filter((message: { role: string }) => message.role === "tool").at(-1);
    const result = last ? JSON.parse(last.content) : undefined;
    if (calls === 1) return completion("", { action: "search", query: "shared-key", limit: 12 }, "search");
    if (calls === 2) {
      const candidates = result.candidates as Array<{id:string;kind:string;title:string}>;
      assert.equal(typeof result.searchIncomplete,"boolean");assert.ok(result.coverage.taskHistory.scanned>0);
      seen.push(...candidates.map(({kind,title})=>({kind,title})));
      assert.ok(candidates.some(item => item.kind === "task_message"));
      assert.ok(candidates.some(item => item.kind === "project_file"));
      assert.ok(candidates.some(item => item.kind === "inspiration"));
      assert.ok(!candidates.some(item => item.title.includes("B Task") || item.title.includes("Project B")));
      projectCandidateId = candidates.find(item => item.kind === "project_file")?.id;
      return completion("", { action: "read", candidateId: candidates.find(item => item.kind === "inspiration")!.id }, "read");
    }
    readResults.push(result);
    if (calls === 3) return completion("", { action: "read", candidateId: projectCandidateId }, "read-project");
    return completion(`已核对。${readResults.map(item=>item.citation).join(" ")}`);
  }) as typeof fetch;
  const host = new PiHost({ agentDir: agent, sessionsDirectory: join(agent, "sessions"), dataRoot, userHome: home, emit: () => {} });
  try {
    await host.start();
    await host.handle("dcodeSession.prompt", { dcodeSessionId: ta.coordinationSession.id, promptId: "recall-run", message: "查找 shared-key 的来源" });
    const deadline = Date.now() + 12000;
    while ((await host.handle("foundation.snapshot", {}) as FoundationSnapshot).sessionRuns.some(run => ["prepared", "running"].includes(run.status))) {
      if (Date.now() > deadline) throw new Error(`Recall did not settle after ${calls} calls`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const final = await host.handle("foundation.snapshot", {}) as FoundationSnapshot;
    assert.ok(seen.length >= 3 && seen.length <= 12);
    assert.equal(final.taskSourceUses.length, 2, JSON.stringify({calls,seen,readResults,runs:final.sessionRuns,providerCalls:final.providerCalls}));
    assert.deepEqual(final.taskSourceUses.map(item=>item.kind).sort(),["inspiration","project_file"]);
    assert.match(readResults[0]?.content ?? "", /第一版灵感原文/);
    assert.match(readResults[1]?.content ?? "", /Project A source/);
    assert.ok(readResults.every(item=>/dcode-source:source-use-/.test(item.citation??"")));
    const opened = await host.handle("task.source.used.read", { taskId: ta.task.id, sourceUseId: readResults[0]!.sourceUseId }) as { state: string; content: string };
    assert.equal(opened.state, "available"); assert.match(opened.content, /第一版灵感原文/);
    await writeFile(join(a,"study.md"),"shared-key: Project A updated source\n");
    const changed = await host.handle("task.source.used.read", { taskId: ta.task.id, sourceUseId: readResults[1]!.sourceUseId }) as { state: string };
    assert.equal(changed.state,"hash_mismatch");
  } finally { await host.close(); globalThis.fetch = previousFetch; await rm(root, { recursive: true, force: true }); }
});
