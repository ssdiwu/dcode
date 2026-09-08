import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  LegacyMigrationError,
  buildLegacyMigrationPlan,
  verifyLegacyMigrationSources,
} from "../src/legacy-migration.js";
import { D_CODE_SESSION_ORIGIN_TYPE } from "../src/session-reader.js";
import { resolveDCodeDataRoot } from "../src/dcode-data-root.js";
import { initializeProductStoreAtomically } from "../src/product-store-schema.js";
import { ProductStore } from "../src/product-store.js";
import { DatabaseSync } from "node:sqlite";

async function fixture(): Promise<{
  root: string;
  home: string;
  agentDir: string;
  sessionsDirectory: string;
  applicationSupportDirectory: string;
  projectDirectory: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "dcode-legacy-migration-"));
  const home = join(root, "home");
  const agentDir = join(root, "agent");
  const sessionsDirectory = join(agentDir, "sessions");
  const applicationSupportDirectory = join(root, "Application Support", "D Code");
  const projectDirectory = join(root, "project");
  await mkdir(home);
  await mkdir(sessionsDirectory, { recursive: true });
  await mkdir(applicationSupportDirectory, { recursive: true });
  await mkdir(projectDirectory);
  return { root, home, agentDir, sessionsDirectory, applicationSupportDirectory, projectDirectory };
}

async function writePiSession(
  sessionsDirectory: string,
  sessionId: string,
  cwd: string,
  dcodeManaged: boolean,
): Promise<string> {
  const directory = join(sessionsDirectory, sessionId);
  await mkdir(directory, { recursive: true });
  const timestamp = "2026-08-25T00:00:00.000Z";
  const entries: unknown[] = [{ type: "session", version: 3, id: sessionId, timestamp, cwd }];
  let parentId: string | null = null;
  if (dcodeManaged) {
    parentId = `${sessionId}-origin`;
    entries.push({
      type: "custom",
      id: parentId,
      parentId: null,
      timestamp,
      customType: D_CODE_SESSION_ORIGIN_TYPE,
      data: { version: 1, sessionId },
    });
  }
  entries.push({
    type: "message",
    id: `${sessionId}-user`,
    parentId,
    timestamp,
    message: { role: "user", content: `message from ${sessionId}`, timestamp: 1 },
  });
  const path = join(directory, `${sessionId}.jsonl`);
  await writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return path;
}

test("legacy migration plan is empty and deterministic for a fresh user", async () => {
  const f = await fixture();
  try {
    const plan = await buildLegacyMigrationPlan({
      userHome: f.home,
      agentDir: f.agentDir,
      sessionsDirectory: f.sessionsDirectory,
      applicationSupportDirectory: f.applicationSupportDirectory,
    });
    assert.deepEqual(plan.sources, []);
    assert.deepEqual(plan.projects, []);
    assert.deepEqual(plan.adoptedSessions, []);
    assert.match(plan.id, /^migration-[a-f0-9]{32}$/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("legacy migration maps a D Code-managed Pi Session to its unique Project Scope", async () => {
  const f = await fixture();
  try {
    const projectDocument = {
      version: 2,
      projects: [{ id: "project-one", name: "D Code", directory: { path: f.projectDirectory } }],
    };
    const projectPath = join(f.applicationSupportDirectory, "projects-v1.json");
    await writeFile(projectPath, `${JSON.stringify(projectDocument)}\n`);
    const managedPath = await writePiSession(f.sessionsDirectory, "managed-session", f.projectDirectory, true);
    await writePiSession(f.sessionsDirectory, "external-pi-session", f.projectDirectory, false);

    const options = {
      userHome: f.home,
      agentDir: f.agentDir,
      sessionsDirectory: f.sessionsDirectory,
      applicationSupportDirectory: f.applicationSupportDirectory,
    };
    const first = await buildLegacyMigrationPlan(options);
    const second = await buildLegacyMigrationPlan(options);
    assert.equal(first.id, second.id);
    assert.deepEqual(first.projects, second.projects);
    assert.equal(first.projects[0]?.id, "project-one");
    assert.equal(first.adoptedSessions.length, 1, "non-D Code Pi sessions must never be auto-adopted");
    const adoption = first.adoptedSessions[0];
    assert.deepEqual(adoption?.scope, { kind: "project", projectId: "project-one" });
    assert.equal(adoption?.sourceSessionId, "managed-session");
    assert.equal(adoption?.sourcePath, managedPath);
    assert.match(adoption?.taskId ?? "", /^legacy-task-[a-f0-9]{32}$/);
    assert.equal(adoption?.entries[0]?.content, "message from managed-session");
    assert.equal(await readFile(projectPath, "utf8"), `${JSON.stringify(projectDocument)}\n`);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("legacy Project v1 expansion uses stable IDs and User Scope remains the fallback", async () => {
  const f = await fixture();
  const secondProjectDirectory = join(f.root, "project-two");
  await mkdir(secondProjectDirectory);
  try {
    await writeFile(join(f.applicationSupportDirectory, "projects-v1.json"), `${JSON.stringify({
      version: 1,
      projects: [{
        id: "legacy-project-id",
        name: "Legacy",
        sourceFolders: [{ path: f.projectDirectory }, { path: secondProjectDirectory }],
      }],
    })}\n`);
    await writePiSession(f.sessionsDirectory, "home-session", join(f.root, "unmapped"), true);
    const options = {
      userHome: f.home,
      agentDir: f.agentDir,
      sessionsDirectory: f.sessionsDirectory,
      applicationSupportDirectory: f.applicationSupportDirectory,
    };
    const first = await buildLegacyMigrationPlan(options);
    const second = await buildLegacyMigrationPlan(options);
    assert.equal(first.projects.length, 2);
    assert.equal(first.projects[0]?.id, "legacy-project-id");
    assert.match(first.projects[1]?.id ?? "", /^legacy-project-[a-f0-9]{32}$/);
    assert.deepEqual(first.projects, second.projects);
    assert.deepEqual(first.adoptedSessions[0]?.scope, { kind: "user" });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("an existing malformed legacy Store blocks planning instead of becoming empty", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.applicationSupportDirectory, "verification-evidence-v1.json"), "{bad}\n");
    await assert.rejects(
      buildLegacyMigrationPlan({
        userHome: f.home,
        agentDir: f.agentDir,
        sessionsDirectory: f.sessionsDirectory,
        applicationSupportDirectory: f.applicationSupportDirectory,
      }),
      (error: unknown) => error instanceof LegacyMigrationError
        && error.code === "LEGACY_SOURCE_INVALID",
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("legacy source CAS detects changes after planning", async () => {
  const f = await fixture();
  try {
    const path = join(f.applicationSupportDirectory, "session-pins-v1.json");
    await writeFile(path, `${JSON.stringify({ version: 1, records: [] })}\n`);
    const plan = await buildLegacyMigrationPlan({
      userHome: f.home,
      agentDir: f.agentDir,
      sessionsDirectory: f.sessionsDirectory,
      applicationSupportDirectory: f.applicationSupportDirectory,
    });
    await writeFile(path, `${JSON.stringify({ version: 1, records: [{ sessionID: "changed" }] })}\n`);
    await assert.rejects(
      verifyLegacyMigrationSources(plan),
      (error: unknown) => error instanceof LegacyMigrationError
        && error.code === "LEGACY_SOURCE_CHANGED",
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("legacy migration candidate atomically publishes Projects and adopted Legacy Tasks", async () => {
  const f = await fixture();
  const dataRoot = join(f.home, ".dcode");
  try {
    const projectPath = join(f.applicationSupportDirectory, "projects-v1.json");
    const projectBytes = `${JSON.stringify({
      version: 2,
      projects: [{ id: "project-one", name: "D Code", directory: { path: f.projectDirectory } }],
    })}\n`;
    await writeFile(projectPath, projectBytes);
    await writePiSession(f.sessionsDirectory, "managed-session", f.projectDirectory, true);
    const plan = await buildLegacyMigrationPlan({
      userHome: f.home,
      agentDir: f.agentDir,
      sessionsDirectory: f.sessionsDirectory,
      applicationSupportDirectory: f.applicationSupportDirectory,
    });
    const layout = resolveDCodeDataRoot(dataRoot, f.home);
    assert.equal(await initializeProductStoreAtomically(layout, {
      userId: "current-user",
      userHome: f.home,
    }, "2026-08-25T00:00:00.000Z", plan), true);

    const store = await ProductStore.open({ dataRoot, userHome: f.home });
    try {
      const snapshot = await store.snapshot();
      assert.equal(snapshot.projects[0]?.id, "project-one");
      assert.equal(snapshot.tasks.length, 1);
      assert.match(snapshot.tasks[0]?.title ?? "", /^Legacy Task · /);
      assert.deepEqual(snapshot.tasks[0]?.scope, { kind: "project", projectId: "project-one" });
      assert.equal(snapshot.sessions[0]?.lineageStatus, "unknown");
      assert.equal(snapshot.coordinatorAssignments[0]?.profileId, "builtin-coordinator");
      const entries = await store.importedSessionEntries(snapshot.sessions[0]!.id);
      assert.equal(entries[0]?.sourceKind, "legacy_adoption");
      assert.equal(entries[0]?.lineageStatus, "unknown");
    } finally {
      await store.close();
    }

    const backupDirectory = join(dataRoot, "migrations", plan.id, "sources");
    const backups = await readdir(backupDirectory);
    assert.ok(backups.some((name) => name.endsWith("-projects.json")));
    assert.equal(await readFile(projectPath, "utf8"), projectBytes);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("ProductStore.open builds the legacy plan before first publication", async () => {
  const f = await fixture();
  const dataRoot = join(f.home, ".dcode");
  try {
    await writeFile(join(f.applicationSupportDirectory, "projects-v1.json"), `${JSON.stringify({
      version: 2,
      projects: [{ id: "project-first-open", name: "D Code", directory: { path: f.projectDirectory } }],
    })}\n`);
    await writePiSession(f.sessionsDirectory, "first-open-session", f.projectDirectory, true);
    const store = await ProductStore.open({
      dataRoot,
      userHome: f.home,
      legacyMigration: {
        agentDir: f.agentDir,
        sessionsDirectory: f.sessionsDirectory,
        applicationSupportDirectory: f.applicationSupportDirectory,
        userDefaults: { "dcode.appearance": "dark" },
      },
    });
    try {
      const snapshot = await store.snapshot();
      assert.equal(snapshot.projects[0]?.id, "project-first-open");
      assert.equal(snapshot.tasks.length, 1);
      assert.equal(snapshot.sessionProvenance[0]?.sourceKind, "legacy_adoption");
    } finally {
      await store.close();
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("legacy migration source drift prevents Product Store publication", async () => {
  const f = await fixture();
  const dataRoot = join(f.home, ".dcode");
  try {
    const sourcePath = join(f.applicationSupportDirectory, "session-pins-v1.json");
    await writeFile(sourcePath, `${JSON.stringify({ version: 1, records: [] })}\n`);
    const plan = await buildLegacyMigrationPlan({
      userHome: f.home,
      agentDir: f.agentDir,
      sessionsDirectory: f.sessionsDirectory,
      applicationSupportDirectory: f.applicationSupportDirectory,
    });
    await writeFile(sourcePath, `${JSON.stringify({ version: 1, records: [{ sessionID: "changed" }] })}\n`);
    await assert.rejects(
      initializeProductStoreAtomically(
        resolveDCodeDataRoot(dataRoot, f.home),
        { userId: "current-user", userHome: f.home },
        "2026-08-25T00:00:00.000Z",
        plan,
      ),
      (error: unknown) => error instanceof LegacyMigrationError
        && error.code === "LEGACY_SOURCE_CHANGED",
    );
    await assert.rejects(access(join(dataRoot, "product-store.sqlite3")));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("legacy migration projects session metadata, settings, capabilities and redacted evidence", async () => {
  const f = await fixture();
  const dataRoot = join(f.home, ".dcode");
  const sessionId = "managed-session";
  try {
    await writeFile(join(f.applicationSupportDirectory, "projects-v1.json"), `${JSON.stringify({
      version: 2,
      projects: [{ id: "project-one", name: "D Code", directory: { path: f.projectDirectory } }],
    })}\n`);
    await writePiSession(f.sessionsDirectory, sessionId, f.projectDirectory, true);
    const secret = "AWS_SECRET_ACCESS_KEY=abcdefghijklmnopqrstuvwx";
    const prefixedSecret = "api_key: fixture_value";
    await writeFile(join(f.applicationSupportDirectory, "session-drafts-v1.json"), `${JSON.stringify({
      version: 1,
      records: [{
        target: { path: { sessionID: sessionId, pathID: "leaf:u1" } },
        text: `draft text ${secret}`,
        updatedAt: "2026-08-25T00:00:00Z",
      }],
      activeTargets: { [sessionId]: { path: { sessionID: sessionId, pathID: "leaf:u1" } } },
      newSessionDraft: {
        projectID: null,
        directoryPath: f.home,
        text: `new task ${prefixedSecret}`,
        fastModeEnabled: false,
      },
    })}\n`);
    await writeFile(join(f.applicationSupportDirectory, "session-archives-v1.json"), `${JSON.stringify({
      version: 1,
      records: [{
        sessionID: sessionId,
        archivedAt: "2026-08-25T00:00:00Z",
        copiedToSessionID: null,
        copiedToTitle: null,
        copiedToCwd: null,
        sourceTitle: "Legacy",
        sourceCwd: f.projectDirectory,
      }],
    })}\n`);
    await writeFile(join(f.applicationSupportDirectory, "session-pins-v1.json"), `${JSON.stringify({
      version: 1,
      records: [{ sessionID: sessionId, pinnedAt: "2026-08-25T00:00:00Z" }],
    })}\n`);
    await writeFile(join(f.applicationSupportDirectory, "follow-up-queues-v1.json"), `${JSON.stringify({
      version: 1,
      queues: [{
        id: "queue-one",
        sessionID: sessionId,
        createdAt: "2026-08-25T00:00:00Z",
        pathID: "leaf:u1",
        lineageEntryID: "u1",
        activeRunID: "run-one",
        activeRunEntryID: "u1",
        pauseReason: null,
        updatedAt: "2026-08-25T00:00:01Z",
        items: [{
          id: "queue-item-one",
          text: `follow up ${secret}`,
          createdAt: "2026-08-25T00:00:00Z",
          updatedAt: "2026-08-25T00:00:01Z",
          state: "dispatching",
          promptID: "prompt-one",
        }],
      }],
    })}\n`);
    await writeFile(join(f.applicationSupportDirectory, "activity-attention-v1.json"), `${JSON.stringify({
      version: 1,
      records: [{
        sessionID: sessionId,
        runID: "run-two",
        completionID: "completion-two",
        entryID: "a2",
        completedAt: "2026-08-25T00:00:02Z",
      }],
    })}\n`);
    await writeFile(join(f.applicationSupportDirectory, "session-changes-v1.json"), `${JSON.stringify({
      version: 1,
      records: [{
        recordId: "change-one",
        sessionId,
        runId: "run-one",
        toolCallId: "tool-one",
        operation: "edit",
        filePath: join(f.projectDirectory, "README.md"),
        additions: 1,
        deletions: 0,
        occurredAt: "2026-08-25T00:00:01Z",
        source: "structured-tool-v1",
      }],
    })}\n`);
    await writeFile(join(f.applicationSupportDirectory, "verification-evidence-v1.json"), `${JSON.stringify({
      version: 1,
      records: [{
        recordId: "evidence-one",
        sessionId,
        runId: "run-one",
        toolCallId: "tool-one",
        command: `echo ok ${secret}`,
        exitKind: "ok",
        exitCode: 0,
        startedAt: "2026-08-25T00:00:00Z",
        endedAt: "2026-08-25T00:00:01Z",
        cwd: f.projectDirectory,
      }],
    })}\n`);
    await writeFile(join(f.applicationSupportDirectory, "self-evolution-runs-v1.json"), `${JSON.stringify({
      version: 1,
      revision: 1,
      runs: [{
        id: "self-run",
        state: "manual_accepted",
        createdAt: "2026-08-25T00:00:00Z",
        updatedAt: "2026-08-25T00:00:01Z",
        events: [{ id: "self-event", kind: "manual_accepted", occurredAt: "2026-08-25T00:00:01Z" }],
      }],
    })}\n`);
    await mkdir(join(f.agentDir, "pi-dcode"), { recursive: true });
    await writeFile(join(f.agentDir, "pi-dcode", "disabled-packages.json"), `${JSON.stringify(["npm:disabled"])}\n`);
    await writeFile(join(f.agentDir, "settings.json"), `${JSON.stringify({
      defaultProvider: "custom",
      defaultModel: "model-one",
      enabledModels: ["custom/model-one"],
      packages: ["npm:enabled", "npm:disabled"],
    })}\n`);
    await writeFile(join(f.agentDir, "models.json"), `{
      // ModelConfig supports comments.
      "providers": {
        "custom": {
          "name": "Custom",
          "baseUrl": "https://example.invalid/v1",
          "api": "openai-completions",
          "apiKey": "${secret}",
          "models": [{
            "id": "model-one",
            "name": "Model One",
            "reasoning": true,
            "contextWindow": 100000,
            "maxTokens": 4096
          }]
        }
      }
    }\n`);

    const plan = await buildLegacyMigrationPlan({
      userHome: f.home,
      agentDir: f.agentDir,
      sessionsDirectory: f.sessionsDirectory,
      applicationSupportDirectory: f.applicationSupportDirectory,
      userDefaults: {
        "dcode.appearance": "dark",
        "dcode.sidebar.width": 420,
        "dcode.selfBuildSourceRoot": f.projectDirectory,
        "dcode.selfBuildRestart": true,
        "dcode.selfBuildPendingSessionId": sessionId,
      },
    });
    await initializeProductStoreAtomically(
      resolveDCodeDataRoot(dataRoot, f.home),
      { userId: "current-user", userHome: f.home },
      "2026-08-25T00:00:00.000Z",
      plan,
    );
    const databasePath = join(dataRoot, "product-store.sqlite3");
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const count = (table: string): number => (
        database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }
      ).count;
      assert.equal(count("composer_drafts"), 2);
      assert.equal(count("session_archive_states"), 1);
      assert.equal(count("session_user_states"), 1);
      assert.equal(count("follow_up_queues"), 1);
      assert.equal(count("follow_up_items"), 1);
      assert.equal(count("session_attention"), 1);
      assert.equal(count("session_mutations"), 1);
      assert.equal(count("evidence_records"), 1);
      assert.equal(count("self_evolution_runs"), 1);
      assert.equal(count("self_evolution_events"), 1);
      assert.equal(count("capability_sources"), 2);
      assert.equal(count("model_providers"), 1);
      assert.equal(count("model_catalog_entries"), 1);
      assert.equal(count("credential_references"), 1);
      assert.ok(count("product_settings") >= 4);
      assert.equal(count("creation_mode_settings"), 1);
      assert.equal(count("recovery_intents"), 1);
      const queue = database.prepare("SELECT pause_reason FROM follow_up_queues").get() as { pause_reason: string };
      assert.equal(queue.pause_reason, "runOutcomeUnknown");
      const item = database.prepare("SELECT state FROM follow_up_items").get() as { state: string };
      assert.equal(item.state, "unknown");
      const evidence = database.prepare("SELECT command_redacted FROM evidence_records").get() as {
        command_redacted: string;
      };
      assert.equal(evidence.command_redacted.includes(secret), false);
    } finally {
      database.close();
    }
    const databaseBytes = await readFile(databasePath);
    assert.equal(databaseBytes.includes(Buffer.from(secret)), false, "Product Store must not contain legacy credentials");
    assert.equal(databaseBytes.includes(Buffer.from(prefixedSecret)), false, "Product Store must redact prefixed credentials");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});


test("native facts keep explicitly adopted file changes separate from current execution",async()=>{
  const f=await fixture();let store:ProductStore|undefined;
  try{
    await writePiSession(f.sessionsDirectory,"managed-facts",f.home,true);
    await writePiSession(f.sessionsDirectory,"external-facts",f.home,false);
    const record={recordId:"change-one",sessionId:"managed-facts",runId:"legacy-run",toolCallId:"old-edit",operation:"edit",filePath:join(f.home,"old.md"),additions:9,deletions:3,firstChangedLine:12,occurredAt:"2026-08-25T00:00:00.000Z",source:"structured-tool-v1"};
    await writeFile(join(f.applicationSupportDirectory,"session-changes-v1.json"),JSON.stringify({version:1,records:[record,{...record,recordId:"external-change",sessionId:"external-facts",filePath:join(f.home,"external.md")}]}));
    store=await ProductStore.open({dataRoot:join(f.home,".dcode"),userHome:f.home,legacyMigration:{agentDir:f.agentDir,sessionsDirectory:f.sessionsDirectory,applicationSupportDirectory:f.applicationSupportDirectory}});
    const snapshot=await store.snapshot(),session=snapshot.sessions[0]!;assert.equal(snapshot.sessions.length,1);
    const facts=store.nativeSessionFacts({taskId:session.taskId,sessionId:session.id},"changes");assert.equal(facts.totalHistoricalFileChanges,1);assert.equal(facts.evidence.length,0);
    const imported=facts.historicalFileChanges[0]!;assert.equal(imported.filePath,record.filePath);assert.equal(imported.additions,9);assert.equal(imported.deletions,3);assert.equal(imported.firstChangedLine,12);assert.ok(imported.legacyRunId);assert.equal(imported.sourceKind,"structured-tool-v1");
    assert.ok(!JSON.stringify(facts).includes("external.md"));
    const fresh=await store.createTask({requestId:"fresh",expectedStoreRevision:snapshot.storeRevision,scope:{kind:"user",userId:snapshot.currentUser.id},title:"Fresh",goal:"No history mixing"});
    assert.deepEqual(store.nativeSessionFacts({taskId:fresh.task.id,sessionId:fresh.coordinationSession.id},"changes").historicalFileChanges,[]);
  }finally{await store?.close();await rm(f.root,{recursive:true,force:true});}
});
