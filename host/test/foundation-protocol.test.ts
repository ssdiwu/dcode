import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiHost } from "../src/pi-host.js";
import type { FoundationSnapshot, PiImportTaskResult, TaskBundle } from "../src/product-store.js";

test("Host foundation contract creates and restores a native D Code Task bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-foundation-host-"));
  const agentDir = join(root, "agent");
  const dataRoot = join(root, ".dcode");
  const userHome = join(root, "home");
  const events: Array<{ event: string; data?: unknown }> = [];
  await mkdir(join(agentDir, "sessions"), { recursive: true });
  const piSessionDirectory = join(agentDir, "sessions", "pi-import");
  await mkdir(piSessionDirectory, { recursive: true });
  await mkdir(userHome);
  await writeFile(join(agentDir, "settings.json"), "{}\n");
  const piSessionPath = join(piSessionDirectory, "pi-session.jsonl");
  await writeFile(piSessionPath, [
    {
      type: "session",
      version: 3,
      id: "pi-session",
      timestamp: "2026-08-25T00:00:00.000Z",
      cwd: userHome,
    },
    {
      type: "message",
      id: "pi-user",
      parentId: null,
      timestamp: "2026-08-25T00:00:00.000Z",
      message: { role: "user", content: "从 Pi 导入的原话", timestamp: 1 },
    },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");

  let host = new PiHost({
    agentDir,
    dataRoot,
    userHome,
    emit: (event, data) => events.push({ event, data }),
  });
  try {
    await host.start();
    const hello = await host.handle("host.hello", {}) as {
      capabilities: Record<string, boolean>;
    };
    assert.equal(hello.capabilities.productStore, true);
    assert.equal(hello.capabilities.nativeTasks, true);
    assert.equal(hello.capabilities.foundationSnapshot, true);
    assert.equal(hello.capabilities.taskWorkbenchViewState, true);
    assert.equal(hello.capabilities.piSessionImport, true);
    assert.equal(hello.capabilities.sessionPathFacts, true);

    const initial = await host.handle("foundation.snapshot", {}) as FoundationSnapshot;
    const created = await host.handle("task.create", {
      requestId: "host-create-task",
      expectedStoreRevision: initial.storeRevision,
      scope: { kind: "user", userId: initial.currentUser.id },
      title: "Foundation Console task",
      goal: "Exercise the same contract the Swift UI will consume",
      acceptance: ["Snapshot restores the Task"],
    }) as TaskBundle;
    assert.equal(created.storeRevision, initial.storeRevision + 1);
    assert.equal(created.task.cwd, userHome);
    assert.ok(events.some(({ event, data }) => event === "foundation.changed"
      && (data as { taskId?: unknown }).taskId === created.task.id));
    const plan = await host.handle("task.plan.create", {
      requestId: "host-create-plan",
      expectedStoreRevision: created.storeRevision,
      scope: created.task.scope,
      taskId: created.task.id,
      document: { version: 1, title: "Foundation plan" },
    }) as { storeRevision: number; taskPlan: { id: string; taskId: string } };
    const workItem = await host.handle("task.workItem.create", {
      requestId: "host-create-work-item",
      expectedStoreRevision: plan.storeRevision,
      scope: created.task.scope,
      taskId: created.task.id,
      title: "Read the foundation facts",
      details: { planId: plan.taskPlan.id },
    }) as { storeRevision: number; taskWorkItem: { id: string; taskId: string } };
    assert.equal(plan.taskPlan.taskId, created.task.id);
    assert.equal(workItem.taskWorkItem.taskId, created.task.id);
    assert.ok(events.some(({ event, data }) => event === "foundation.changed"
      && (data as { kind?: unknown }).kind === "taskWorkItem.created"));

    const candidates = await host.handle("piImport.listCandidates", {}) as {
      candidates: Array<{ sourceSessionId: string }>;
    };
    assert.deepEqual(candidates.candidates.map((candidate) => candidate.sourceSessionId), ["pi-session"]);
    const preview = await host.handle("piImport.preview", { sourceSessionId: "pi-session" }) as {
      sourceDigest: string;
      lineageStatus: string;
      importedEntryCount: number;
    };
    assert.match(preview.sourceDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(preview.lineageStatus, "unknown");
    assert.equal(preview.importedEntryCount, 1);
    const imported = await host.handle("piImport.importAsTask", {
      requestId: "host-import-pi",
      expectedStoreRevision: workItem.storeRevision,
      scope: { kind: "user", userId: initial.currentUser.id },
      sourceSessionId: "pi-session",
    }) as PiImportTaskResult;
    assert.equal(imported.storeRevision, workItem.storeRevision + 1);
    assert.equal(imported.coordinationSession.lineageStatus, "unknown");
    const importedEntries = await host.handle("session.importedEntries", {
      sessionId: imported.coordinationSession.id,
    }) as { entries: Array<{ content: unknown; lineageStatus: string }> };
    assert.equal(importedEntries.entries[0]?.content, "从 Pi 导入的原话");
    assert.equal(importedEntries.entries[0]?.lineageStatus, "unknown");
    await appendFile(piSessionPath, `${JSON.stringify({
      type: "message",
      id: "pi-assistant-late",
      parentId: "pi-user",
      timestamp: "2026-08-25T00:00:02.000Z",
      message: { role: "assistant", content: "source changed after commit", timestamp: 2 },
    })}\n`);
    const replayed = await host.handle("piImport.importAsTask", {
      requestId: "host-import-pi",
      expectedStoreRevision: workItem.storeRevision,
      scope: { kind: "user", userId: initial.currentUser.id },
      sourceSessionId: "pi-session",
    }) as PiImportTaskResult;
    assert.deepEqual(replayed, imported, "durable import receipt must replay before the source is read again");

    await host.close();
    host = new PiHost({ agentDir, dataRoot, userHome, emit: () => {} });
    await host.start();
    const restored = await host.handle("foundation.snapshot", { afterEventSequence: 0 }) as FoundationSnapshot;
    assert.equal(restored.storeRevision, imported.storeRevision);
    assert.ok(restored.tasks.some((task) => task.id === created.task.id));
    assert.ok(restored.sessions.some((session) => session.id === created.coordinationSession.id));
    assert.ok(restored.coordinatorAssignments.some((assignment) => assignment.id === created.coordinatorAssignment.id));
    assert.equal(restored.tasks.length, 2);
    assert.ok(restored.taskPlans.some((candidate) => candidate.id === plan.taskPlan.id));
    assert.ok(restored.taskWorkItems.some((candidate) => candidate.id === workItem.taskWorkItem.id));
    assert.equal(restored.piImports[0]?.sourceSessionId, "pi-session");
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});
