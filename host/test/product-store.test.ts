import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { DCodeDataRootError } from "../src/dcode-data-root.js";
import { ProductStoreLeaseError } from "../src/product-store-lease.js";
import { PRODUCT_STORE_SCHEMA_VERSION, ProductStoreSchemaError } from "../src/product-store-schema.js";
import { managedWorkerWorktreeArtifactId } from "../src/managed-worker-worktree.js";
import {
  ProductStore,
  ProductStoreError,
  type ProductStoreFaultPoint,
  type TaskContextSourceInput,
} from "../src/product-store.js";

interface Fixture {
  root: string;
  dataRoot: string;
  home: string;
  projectDirectory: string;
}

async function fixture(prefix = "dcode-product-store-"): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const dataRoot = join(root, ".dcode");
  const home = join(root, "home");
  const projectDirectory = join(root, "project");
  await mkdir(home);
  await mkdir(projectDirectory);
  return { root, dataRoot, home, projectDirectory };
}

function open(f: Fixture, options: { faultInjector?: (point: ProductStoreFaultPoint) => void } = {}): Promise<ProductStore> {
  return ProductStore.open({
    dataRoot: f.dataRoot,
    userHome: f.home,
    now: () => "2026-08-25T00:00:00.000Z",
    ...options,
  });
}

function schemaFingerprintForTest(database: DatabaseSync): string {
  const definitions = database.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_master
    WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all();
  return `sha256:${createHash("sha256").update(JSON.stringify(definitions)).digest("hex")}`;
}

function rewriteAsSchemaV1Fixture(database: DatabaseSync): void {
  database.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE task_context_sources;
    DROP TABLE task_context_sets;
    DELETE FROM schema_migrations;
    INSERT INTO schema_migrations(version, applied_at, product_version)
    VALUES (1, '2026-08-24T00:00:00.000Z', '0.0.28');
    PRAGMA user_version = 1;
  `);
  database.prepare("UPDATE dcode_meta SET value = '1' WHERE key IN ('schema_version', 'minimum_reader_schema_version')").run();
  database.prepare("UPDATE dcode_meta SET value = ? WHERE key = 'schema_fingerprint'")
    .run(schemaFingerprintForTest(database));
  database.exec("PRAGMA foreign_keys = ON");
}

async function prewriteSchemaV1PromotionBackup(f: Fixture): Promise<void> {
  const path = join(f.dataRoot, "product-store.sqlite3");
  const checkpoint = new DatabaseSync(path);
  try {
    const result = checkpoint.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
      busy?: unknown;
      log?: unknown;
      checkpointed?: unknown;
    } | undefined;
    assert.equal(result?.busy, 0);
    assert.equal(result?.log, result?.checkpointed);
  } finally {
    checkpoint.close();
  }
  const bytes = await readFile(path);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const migrationID = `schema-v1-to-v2-${digest.slice("sha256:".length, "sha256:".length + 16)}`;
  const directory = join(f.dataRoot, "migrations", migrationID);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "product-store-before.sqlite3"), bytes);
  await writeFile(
    join(directory, "manifest.json"),
    `${JSON.stringify({
      migrationId: migrationID,
      fromSchemaVersion: 1,
      toSchemaVersion: PRODUCT_STORE_SCHEMA_VERSION,
      sourceDigest: digest,
    }, null, 2)}\n`,
  );
}

test("fresh Product Store creates private managed storage and four built-in Agent Profiles", async () => {
  const f = await fixture();
  const store = await open(f);
  try {
    const snapshot = await store.snapshot();
    assert.equal(snapshot.schemaVersion, PRODUCT_STORE_SCHEMA_VERSION);
    assert.equal(snapshot.storeRevision, 0);
    assert.equal(snapshot.dataRoot, f.dataRoot);
    assert.equal(snapshot.currentUser.homeDirectory, f.home);
    assert.deepEqual(
      snapshot.agentProfiles.map((profile) => profile.role).sort(),
      ["coordinator", "explore", "verifier", "worker"],
    );
    assert.deepEqual(snapshot.tasks, []);
    assert.deepEqual(snapshot.taskContextSets, []);
    assert.equal((await stat(f.dataRoot)).mode & 0o777, 0o700);
    assert.equal((await stat(join(f.dataRoot, "product-store.sqlite3"))).mode & 0o777, 0o600);
    for (const directory of ["artifacts", "indexes", "logs", "migrations", "recovery", "runtime"]) {
      assert.equal((await stat(join(f.dataRoot, directory))).mode & 0o777, 0o700);
    }
  } finally {
    await store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Product Store rejects a symbolic-link data root without changing the target", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-product-store-symlink-root-"));
  const target = join(root, "unrelated-target");
  const dataRoot = join(root, ".dcode");
  const home = join(root, "home");
  await mkdir(target, { mode: 0o755 });
  await mkdir(home);
  await chmod(target, 0o755);
  await symlink(target, dataRoot);
  try {
    await assert.rejects(
      ProductStore.open({ dataRoot, userHome: home }),
      (error: unknown) => error instanceof DCodeDataRootError,
    );
    assert.equal((await stat(target)).mode & 0o777, 0o755);
    await assert.rejects(stat(join(target, "product-store.sqlite3")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("task.create atomically creates a User Scope Task, Coordination Session and Coordinator assignment", async () => {
  const f = await fixture();
  let store = await open(f);
  try {
    const initial = await store.snapshot();
    const created = await store.createTask({
      requestId: "create-user-task",
      expectedStoreRevision: 0,
      scope: { kind: "user", userId: initial.currentUser.id },
      title: "Build the Product Store",
      goal: "Create the first durable D Code task",
      acceptance: ["The task survives restart"],
    });
    assert.equal(created.storeRevision, 1);
    assert.equal(created.task.scope.kind, "user");
    assert.equal(created.task.cwd, f.home);
    assert.equal(created.coordinationSession.kind, "coordination");
    assert.equal(created.coordinationSession.taskId, created.task.id);
    assert.equal(created.coordinatorAssignment.taskId, created.task.id);
    assert.equal(created.coordinatorAssignment.sessionId, created.coordinationSession.id);
    assert.equal(created.coordinatorAssignment.profileId, "builtin-coordinator");

    const taskId = created.task.id;
    const sessionId = created.coordinationSession.id;
    await store.close();
    store = await open(f);
    const restored = await store.snapshot();
    assert.equal(restored.storeRevision, 1);
    assert.equal(restored.tasks[0]?.id, taskId);
    assert.equal(restored.sessions[0]?.id, sessionId);
    assert.equal(restored.taskContextSets[0]?.taskId, taskId);
    assert.equal(restored.taskContextSets[0]?.revision, 1);
    assert.equal(restored.events[0]?.kind, "task.created");
  } finally {
    await store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Project Scope resolves to a real Project and never uses a nullable owner", async () => {
  const f = await fixture();
  const store = await open(f);
  try {
    const createdProject = await store.createProject({
      requestId: "create-project",
      expectedStoreRevision: 0,
      title: "D Code",
      directory: f.projectDirectory,
    });
    const createdTask = await store.createTask({
      requestId: "create-project-task",
      expectedStoreRevision: 1,
      scope: { kind: "project", projectId: createdProject.project.id },
      title: "Implement multi-session",
      goal: "Run two D Code Sessions concurrently",
    });
    assert.deepEqual(createdTask.task.scope, { kind: "project", projectId: createdProject.project.id });
    assert.equal(createdTask.task.cwd, await realpath(f.projectDirectory));
    assert.equal(createdTask.storeRevision, 2);

    const currentUser = (await store.snapshot()).currentUser;
    await assert.rejects(
      store.createTask({
        requestId: "mixed-scope",
        expectedStoreRevision: 2,
        scope: { kind: "user", userId: currentUser.id, projectId: createdProject.project.id } as never,
        title: "Invalid",
        goal: "Must fail",
      }),
      (error: unknown) => error instanceof ProductStoreError && error.code === "INVALID_ARGUMENT",
    );
    await assert.rejects(
      store.createTask({
        requestId: "extra-scope-field",
        expectedStoreRevision: 2,
        scope: { kind: "user", userId: currentUser.id, unexpected: "must-not-persist" } as never,
        title: "Invalid",
        goal: "Must fail",
      }),
      (error: unknown) => error instanceof ProductStoreError && error.code === "INVALID_ARGUMENT",
    );
    await assert.rejects(
      store.createTask({
        requestId: "unknown-project",
        expectedStoreRevision: 2,
        scope: { kind: "project", projectId: "missing" },
        title: "Invalid",
        goal: "Must fail",
      }),
      (error: unknown) => error instanceof ProductStoreError && error.code === "NOT_FOUND",
    );
  } finally {
    await store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Task Context Selection is explicit, ordered, revisioned, and bounded to Task Scope or user knowledge", async () => {
  const f = await fixture();
  const store = await open(f);
  try {
    const initial = await store.snapshot();
    const created = await store.createTask({
      requestId: "create-context-task",
      expectedStoreRevision: initial.storeRevision,
      scope: { kind: "user", userId: initial.currentUser.id },
      title: "Select context",
      goal: "Use only explicit source files",
    });
    const firstSet = (await store.snapshot()).taskContextSets.find((set) => set.taskId === created.task.id);
    assert.equal(firstSet?.revision, 1);
    const globalKnowledgeRoot = join(f.home, "Workspace", "Write", "Content");
    await mkdir(globalKnowledgeRoot, { recursive: true });
    const canonicalGlobalKnowledgeRoot = await realpath(globalKnowledgeRoot);
    const selectedSources: TaskContextSourceInput[] = [
      { kind: "scope_document", relativePath: "DESIGN.md", title: "设计" },
      {
        kind: "global_knowledge",
        rootPath: canonicalGlobalKnowledgeRoot,
        relativePath: "AI/上下文.md",
        title: "全局知识",
      },
    ];
    const updated = await store.replaceTaskContext({
      requestId: "replace-task-context",
      expectedStoreRevision: created.storeRevision,
      taskId: created.task.id,
      scope: created.task.scope,
      expectedContextRevision: firstSet!.revision,
      sources: selectedSources,
    });
    assert.equal(updated.contextSet.revision, 2);
    assert.deepEqual(
      updated.contextSet.sources.map((source) => ({
        kind: source.kind,
        relativePath: source.relativePath,
        rootPath: source.rootPath,
        title: source.title,
      })),
      [
        { kind: "scope_document", relativePath: "DESIGN.md", rootPath: undefined, title: "设计" },
        {
          kind: "global_knowledge",
          relativePath: "AI/上下文.md",
          rootPath: canonicalGlobalKnowledgeRoot,
          title: "全局知识",
        },
      ],
    );
    await rm(globalKnowledgeRoot, { recursive: true, force: true });
    const replayed = await store.replaceTaskContext({
      requestId: "replace-task-context",
      expectedStoreRevision: updated.storeRevision,
      taskId: created.task.id,
      scope: created.task.scope,
      expectedContextRevision: firstSet!.revision,
      sources: selectedSources,
    });
    assert.deepEqual(replayed, updated);
    await assert.rejects(
      store.replaceTaskContext({
        requestId: "stale-context-replace",
        expectedStoreRevision: updated.storeRevision,
        taskId: created.task.id,
        scope: created.task.scope,
        expectedContextRevision: 1,
        sources: [],
      }),
      (error: unknown) => error instanceof ProductStoreError && error.code === "REVISION_CONFLICT",
    );
    await assert.rejects(
      store.replaceTaskContext({
        requestId: "context-outside-home",
        expectedStoreRevision: updated.storeRevision,
        taskId: created.task.id,
        scope: created.task.scope,
        expectedContextRevision: 2,
        sources: [{
          kind: "global_knowledge",
          rootPath: f.root,
          relativePath: "secret.md",
        }],
      }),
      (error: unknown) => error instanceof ProductStoreError && error.code === "INVALID_ARGUMENT",
    );
    const outsideKnowledgeRoot = join(f.root, "outside-knowledge");
    const linkedKnowledgeRoot = join(f.home, "linked-knowledge");
    await mkdir(outsideKnowledgeRoot);
    await symlink(outsideKnowledgeRoot, linkedKnowledgeRoot);
    await assert.rejects(
      store.replaceTaskContext({
        requestId: "context-symlinked-root",
        expectedStoreRevision: updated.storeRevision,
        taskId: created.task.id,
        scope: created.task.scope,
        expectedContextRevision: 2,
        sources: [{
          kind: "global_knowledge",
          rootPath: linkedKnowledgeRoot,
          relativePath: "outside.md",
        }],
      }),
      (error: unknown) => error instanceof ProductStoreError && error.code === "INVALID_ARGUMENT",
    );
    const sharedKnowledgeRoot = join(f.home, "SharedKnowledge");
    const nestedProjectDirectory = join(sharedKnowledgeRoot, "Project");
    await mkdir(nestedProjectDirectory, { recursive: true });
    const project = await store.createProject({
      requestId: "context-project",
      expectedStoreRevision: updated.storeRevision,
      title: "Context Project",
      directory: nestedProjectDirectory,
    });
    const projectTask = await store.createTask({
      requestId: "context-project-task",
      expectedStoreRevision: project.storeRevision,
      scope: { kind: "project", projectId: project.project.id },
      title: "Context Project Task",
      goal: "Keep AGENTS mandatory",
    });
    const projectContext = (await store.snapshot()).taskContextSets.find((set) => set.taskId === projectTask.task.id);
    await assert.rejects(
      store.replaceTaskContext({
        requestId: "context-global-agents-duplicate",
        expectedStoreRevision: projectTask.storeRevision,
        taskId: projectTask.task.id,
        scope: projectTask.task.scope,
        expectedContextRevision: projectContext!.revision,
        sources: [{
          kind: "global_knowledge",
          rootPath: sharedKnowledgeRoot,
          relativePath: "Project/AGENTS.md",
        }],
      }),
      (error: unknown) => error instanceof ProductStoreError && error.code === "INVALID_ARGUMENT",
    );
    await assert.rejects(
      store.replaceTaskContext({
        requestId: "context-redundant-agents",
        expectedStoreRevision: updated.storeRevision,
        taskId: created.task.id,
        scope: created.task.scope,
        expectedContextRevision: 2,
        sources: [{ kind: "scope_document", relativePath: "AGENTS.md" }],
      }),
      (error: unknown) => error instanceof ProductStoreError && error.code === "INVALID_ARGUMENT",
    );
  } finally {
    await store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("opening a schema v1 Product Store creates a private backup then promotes every Task Context Selection atomically", async () => {
  const f = await fixture("dcode-schema-v1-promotion-");
  let store = await open(f);
  try {
    const initial = await store.snapshot();
    const created = await store.createTask({
      requestId: "create-v1-task",
      expectedStoreRevision: initial.storeRevision,
      scope: { kind: "user", userId: initial.currentUser.id },
      title: "Migrate me",
      goal: "Keep a durable empty selection set",
    });
    await store.close();
    const path = join(f.dataRoot, "product-store.sqlite3");
    const legacy = new DatabaseSync(path);
    rewriteAsSchemaV1Fixture(legacy);
    legacy.close();

    store = await open(f);
    const promoted = await store.snapshot();
    assert.equal(promoted.schemaVersion, PRODUCT_STORE_SCHEMA_VERSION);
    assert.equal(promoted.storeRevision, created.storeRevision + 1);
    assert.deepEqual(
      promoted.taskContextSets.map((set) => ({ taskId: set.taskId, revision: set.revision, sourceCount: set.sources.length })),
      [{ taskId: created.task.id, revision: 1, sourceCount: 0 }],
    );
    assert.equal(promoted.events.some((event) => event.kind === "schema.promoted"), true);
    const directories = await readdir(join(f.dataRoot, "migrations"));
    const migrationDirectory = directories.find((entry) => entry.startsWith("schema-v1-to-v2-"));
    assert.ok(migrationDirectory);
    assert.equal((await stat(join(f.dataRoot, "migrations", migrationDirectory!, "product-store-before.sqlite3"))).isFile(), true);
    assert.equal((await stat(join(f.dataRoot, "migrations", migrationDirectory!, "manifest.json"))).isFile(), true);
  } finally {
    await store.close().catch(() => undefined);
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Task Plan and Work List retain history, revisions, order, and durable request receipts", async () => {
  const f = await fixture("dcode-task-plan-work-list-");
  let store = await open(f);
  try {
    const initial = await store.snapshot();
    const task = await store.createTask({
      requestId: "plan-work-task",
      expectedStoreRevision: initial.storeRevision,
      scope: { kind: "user", userId: initial.currentUser.id },
      title: "Plan and work list",
      goal: "Keep Task planning facts outside Session prose",
    });
    const firstPlan = await store.createTaskPlan({
      requestId: "plan-one",
      expectedStoreRevision: task.storeRevision,
      taskId: task.task.id,
      scope: task.task.scope,
      state: "active",
      document: { version: 1, title: "First plan", phases: [{ title: "Explore" }] },
    });
    const secondPlan = await store.createTaskPlan({
      requestId: "plan-two",
      expectedStoreRevision: firstPlan.storeRevision,
      taskId: task.task.id,
      scope: task.task.scope,
      state: "active",
      document: { version: 1, title: "Revised plan", phases: [{ title: "Implement" }] },
    });
    let snapshot = await store.snapshot();
    const superseded = snapshot.taskPlans.find((plan) => plan.id === firstPlan.taskPlan.id);
    assert.equal(superseded?.state, "superseded");
    assert.equal(superseded?.revision, 2);
    assert.equal(snapshot.taskPlans.find((plan) => plan.id === secondPlan.taskPlan.id)?.state, "active");

    const pausedPlan = await store.updateTaskPlan({
      requestId: "plan-two-pause",
      expectedStoreRevision: secondPlan.storeRevision,
      taskId: task.task.id,
      scope: task.task.scope,
      planId: secondPlan.taskPlan.id,
      expectedPlanRevision: secondPlan.taskPlan.revision,
      state: "paused",
      document: { version: 1, title: "Paused plan", reason: "Need a decision" },
    });
    assert.equal(pausedPlan.taskPlan.revision, 2);

    const firstWork = await store.createTaskWorkItem({
      requestId: "work-one",
      expectedStoreRevision: pausedPlan.storeRevision,
      taskId: task.task.id,
      scope: task.task.scope,
      title: "Explore facts",
      details: { evidenceNeeded: ["source"] },
    });
    const replayedFirstWork = await store.createTaskWorkItem({
      requestId: "work-one",
      expectedStoreRevision: firstWork.storeRevision,
      taskId: task.task.id,
      scope: task.task.scope,
      title: "Explore facts",
      details: { evidenceNeeded: ["source"] },
    });
    assert.deepEqual(replayedFirstWork, firstWork);
    const secondWork = await store.createTaskWorkItem({
      requestId: "work-two",
      expectedStoreRevision: firstWork.storeRevision,
      taskId: task.task.id,
      scope: task.task.scope,
      title: "Implement change",
      state: "in_progress",
      details: { dependsOn: [firstWork.taskWorkItem.id] },
    });
    const blockedWork = await store.updateTaskWorkItem({
      requestId: "work-two-blocked",
      expectedStoreRevision: secondWork.storeRevision,
      taskId: task.task.id,
      scope: task.task.scope,
      workItemId: secondWork.taskWorkItem.id,
      expectedWorkItemRevision: secondWork.taskWorkItem.revision,
      state: "blocked",
      details: { reason: "Need API confirmation" },
    });
    const reordered = await store.reorderTaskWorkItems({
      requestId: "work-reorder",
      expectedStoreRevision: blockedWork.storeRevision,
      taskId: task.task.id,
      scope: task.task.scope,
      items: [
        { id: blockedWork.taskWorkItem.id, expectedRevision: blockedWork.taskWorkItem.revision },
        { id: firstWork.taskWorkItem.id, expectedRevision: firstWork.taskWorkItem.revision },
      ],
    });
    assert.deepEqual(reordered.taskWorkItems.map((item) => item.id), [blockedWork.taskWorkItem.id, firstWork.taskWorkItem.id]);
    assert.deepEqual(reordered.taskWorkItems.map((item) => item.ordinal), [0, 1]);
    await assert.rejects(
      store.updateTaskWorkItem({
        requestId: "work-stale",
        expectedStoreRevision: reordered.storeRevision,
        taskId: task.task.id,
        scope: task.task.scope,
        workItemId: firstWork.taskWorkItem.id,
        expectedWorkItemRevision: firstWork.taskWorkItem.revision,
        state: "completed",
      }),
      (error: unknown) => error instanceof ProductStoreError && error.code === "REVISION_CONFLICT",
    );

    await store.close();
    store = await open(f);
    snapshot = await store.snapshot();
    assert.deepEqual(
      snapshot.taskPlans.filter((plan) => plan.taskId === task.task.id).map((plan) => [plan.id, plan.state, plan.revision]),
      [
        [firstPlan.taskPlan.id, "superseded", 2],
        [secondPlan.taskPlan.id, "paused", 2],
      ],
    );
    assert.deepEqual(
      snapshot.taskWorkItems.filter((item) => item.taskId === task.task.id).map((item) => [item.id, item.state, item.ordinal]),
      [
        [blockedWork.taskWorkItem.id, "blocked", 0],
        [firstWork.taskWorkItem.id, "pending", 1],
      ],
    );
  } finally {
    await store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a schema v1 promotion resumes after its stable backup already exists", async () => {
  const f = await fixture("dcode-schema-v1-resume-");
  let store = await open(f);
  try {
    await store.close();
    const path = join(f.dataRoot, "product-store.sqlite3");
    const legacy = new DatabaseSync(path);
    rewriteAsSchemaV1Fixture(legacy);
    legacy.close();
    await prewriteSchemaV1PromotionBackup(f);

    store = await open(f);
    const snapshot = await store.snapshot();
    assert.equal(snapshot.schemaVersion, PRODUCT_STORE_SCHEMA_VERSION);
    assert.equal(snapshot.events.filter((event) => event.kind === "schema.promoted").length, 1);
  } finally {
    await store.close().catch(() => undefined);
    await rm(f.root, { recursive: true, force: true });
  }
});

test("durable requestId is idempotent and cannot be reused for another payload", async () => {
  const f = await fixture();
  const store = await open(f);
  try {
    const user = (await store.snapshot()).currentUser;
    const input = {
      requestId: "stable-request",
      expectedStoreRevision: 0,
      scope: { kind: "user" as const, userId: user.id },
      title: "Idempotent task",
      goal: "Create exactly once",
    };
    const first = await store.createTask(input);
    const repeated = await store.createTask(input);
    assert.deepEqual(repeated, first);
    assert.equal((await store.snapshot()).tasks.length, 1);

    await assert.rejects(
      store.createTask({ ...input, title: "Different task" }),
      (error: unknown) => error instanceof ProductStoreError
        && error.code === "IDEMPOTENCY_KEY_REUSED",
    );
    await assert.rejects(
      store.createTask({ ...input, requestId: "stale-revision" }),
      (error: unknown) => error instanceof ProductStoreError
        && error.code === "REVISION_CONFLICT",
    );
  } finally {
    await store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("project.create replays its durable receipt even after the external directory disappears", async () => {
  const f = await fixture();
  const store = await open(f);
  try {
    const input = {
      requestId: "project-replay",
      expectedStoreRevision: 0,
      title: "Ephemeral project",
      directory: f.projectDirectory,
    };
    const first = await store.createProject(input);
    await rm(f.projectDirectory, { recursive: true, force: true });
    const replayed = await store.createProject(input);
    assert.deepEqual(replayed, first);
  } finally {
    await store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("project.create rejects a regular file as a Project Directory", async () => {
  const f = await fixture();
  const file = join(f.root, "not-a-directory");
  await writeFile(file, "not a project directory\n");
  const store = await open(f);
  try {
    await assert.rejects(
      store.createProject({
        requestId: "file-project",
        expectedStoreRevision: 0,
        title: "Invalid project",
        directory: file,
      }),
      (error: unknown) => error instanceof ProductStoreError && error.code === "INVALID_ARGUMENT",
    );
  } finally {
    await store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("faults after Task, Session or Assignment insertion leave no partial product objects", async () => {
  const f = await fixture();
  let fault: ProductStoreFaultPoint | undefined;
  const store = await open(f, {
    faultInjector: (point) => {
      if (point === fault) throw new Error(`Injected ${point}`);
    },
  });
  try {
    const user = (await store.snapshot()).currentUser;
    for (const point of ["task.afterTask", "task.afterSession", "task.afterAssignment"] as const) {
      fault = point;
      await assert.rejects(store.createTask({
        requestId: `fault-${point}`,
        expectedStoreRevision: 0,
        scope: { kind: "user", userId: user.id },
        title: "Atomic task",
        goal: "Leave no partial rows",
      }), new RegExp(`Injected ${point}`));
      const snapshot = await store.snapshot();
      assert.equal(snapshot.storeRevision, 0);
      assert.deepEqual(snapshot.tasks, []);
      assert.deepEqual(snapshot.sessions, []);
      assert.deepEqual(snapshot.coordinatorAssignments, []);
      assert.deepEqual(snapshot.events, []);
    }
  } finally {
    await store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Agent Profile updates are revisioned and do not rewrite the built-in identity", async () => {
  const f = await fixture();
  const store = await open(f);
  try {
    const coordinator = (await store.snapshot()).agentProfiles.find((profile) => profile.role === "coordinator");
    assert.ok(coordinator);
    const updated = await store.updateAgentProfile({
      requestId: "update-coordinator",
      expectedStoreRevision: 0,
      profileId: coordinator.id,
      expectedProfileRevision: 1,
      name: "D Code Coordinator",
      roleContract: "Coordinate this Task and preserve evidence.",
      enabled: true,
    });
    assert.equal(updated.storeRevision, 1);
    assert.equal(updated.agentProfile.id, coordinator.id);
    assert.equal(updated.agentProfile.profileVersion, 2);
    assert.equal(updated.agentProfile.revision, 2);
    assert.equal(updated.agentProfile.builtin, true);
    const created = await store.createAgentProfile({
      requestId: "create-custom-profile",
      expectedStoreRevision: updated.storeRevision,
      name: "Researcher",
      roleContract: "Research one bounded question and report evidence.",
      enabled: true,
    });
    assert.equal(created.agentProfile.role, "custom");
    assert.equal(created.agentProfile.builtin, false);
    assert.ok((await store.snapshot()).agentProfiles.some((profile) => profile.id === created.agentProfile.id));
  } finally {
    await store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Session Run preparation persists Raw/Effective input, Prompt receipt and Provider Attempt before execution", async () => {
  const f = await fixture();
  let store = await open(f);
  try {
    const user = (await store.snapshot()).currentUser;
    const task = await store.createTask({
      requestId: "run-task",
      expectedStoreRevision: 0,
      scope: { kind: "user", userId: user.id },
      title: "Run task",
      goal: "Persist intent before Provider execution",
    });
    await assert.rejects(
      store.prepareSessionRun({
        requestId: "reject-credential-run",
        taskId: task.task.id,
        scope: task.task.scope,
        sessionId: task.coordinationSession.id,
        runtimeId: "runtime-credential",
        workspaceId: "workspace-credential",
        cwd: f.home,
        workspaceAccess: "exclusiveWrite",
        message: "api_key: fixture_value",
        attachmentRefs: [],
        roleRevision: "builtin-coordinator:v1",
        contextRevision: 1,
        profileSnapshot: { role: "coordinator" },
        tools: [],
        toolsWritable: false,
        systemPromptDigest: `sha256:${"b".repeat(64)}`,
        promptSources: [],
      }),
      (error: unknown) => error instanceof ProductStoreError && error.code === "CREDENTIAL_MATERIAL_REJECTED",
    );
    await assert.rejects(
      store.prepareSessionRun({
        requestId: "reject-invalid-prompt-source",
        taskId: task.task.id,
        scope: task.task.scope,
        sessionId: task.coordinationSession.id,
        runtimeId: "runtime-invalid-source",
        workspaceId: "workspace-invalid-source",
        cwd: f.home,
        workspaceAccess: "exclusiveWrite",
        message: "safe input",
        attachmentRefs: [],
        roleRevision: "builtin-coordinator:v1",
        contextRevision: 1,
        profileSnapshot: { role: "coordinator" },
        tools: [],
        toolsWritable: false,
        systemPromptDigest: `sha256:${"b".repeat(64)}`,
        promptSources: [{ path: join(f.home, "AGENTS.md"), digest: `sha256:${"d".repeat(64)}`, bytes: -1 }],
      }),
      (error: unknown) => error instanceof ProductStoreError && error.code === "INVALID_ARGUMENT",
    );
    const prepared = await store.prepareSessionRun({
      requestId: "prepare-run-one",
      taskId: task.task.id,
      scope: task.task.scope,
      sessionId: task.coordinationSession.id,
      runtimeId: "runtime-one",
      workspaceId: "workspace-one",
      cwd: f.home,
      workspaceAccess: "exclusiveWrite",
      message: "user raw input",
      attachmentRefs: [],
      modelProvider: "test",
      modelId: "model",
      roleRevision: "builtin-coordinator:v1",
      contextRevision: 1,
      profileSnapshot: { role: "coordinator" },
      tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
      toolsWritable: false,
      systemPromptDigest: `sha256:${"c".repeat(64)}`,
      promptSources: [{ path: join(f.home, "AGENTS.md"), digest: `sha256:${"d".repeat(64)}`, bytes: 0 }],
    });
    let snapshot = await store.snapshot();
    assert.equal(snapshot.sessionRuns.find((run) => run.id === prepared.sessionRunId)?.status, "prepared");
    assert.equal(
      snapshot.operationAttempts.find((attempt) => attempt.id === prepared.providerAttemptId)?.status,
      "prepared",
    );
    assert.equal(snapshot.runtimeEnvironments.find((item) => item.id === prepared.runtimeEnvironmentId)?.runtimeId, "runtime-one");
    assert.equal(snapshot.activeToolSets.find((item) => item.id === prepared.activeToolSetId)?.tools instanceof Array, true);
    assert.equal(snapshot.promptReceipts.find((item) => item.id === prepared.promptReceiptId)?.sessionRunId, prepared.sessionRunId);
    await store.finishSessionRun({
      sessionRunId: prepared.sessionRunId,
      providerAttemptId: prepared.providerAttemptId,
      outcome: "succeeded",
      resultReference: { completionEntryId: "assistant-one" },
    });
    snapshot = await store.snapshot();
    assert.equal(snapshot.sessionRuns.find((run) => run.id === prepared.sessionRunId)?.status, "completed");
    assert.equal(
      snapshot.operationAttempts.find((attempt) => attempt.id === prepared.providerAttemptId)?.status,
      "succeeded",
    );

    const interrupted = await store.prepareSessionRun({
      requestId: "prepare-run-two",
      taskId: task.task.id,
      scope: task.task.scope,
      sessionId: task.coordinationSession.id,
      runtimeId: "runtime-two",
      workspaceId: "workspace-two",
      cwd: f.home,
      workspaceAccess: "exclusiveWrite",
      message: "crash before result",
      attachmentRefs: [],
      roleRevision: "builtin-coordinator:v1",
      contextRevision: 1,
      profileSnapshot: { role: "coordinator" },
      tools: [],
      toolsWritable: false,
      systemPromptDigest: `sha256:${"e".repeat(64)}`,
      promptSources: [],
    });
    await store.close();
    store = await open(f);
    snapshot = await store.snapshot();
    assert.equal(snapshot.sessionRuns.find((run) => run.id === interrupted.sessionRunId)?.status, "interrupted");
    assert.equal(
      snapshot.operationAttempts.find((attempt) => attempt.id === interrupted.providerAttemptId)?.status,
      "unknown",
      "a prepared external operation must never auto-replay after restart",
    );
  } finally {
    await store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Team Run creates one Coordinator and two child Agent Sessions without completing the Task", async () => {
  const f = await fixture();
  const store = await open(f);
  try {
    const initial = await store.snapshot();
    const task = await store.createTask({
      requestId: "team-task",
      expectedStoreRevision: 0,
      scope: { kind: "user", userId: initial.currentUser.id },
      title: "Coordinate two members",
      goal: "Explore and verify independently",
    });
    const created = await store.createTeamRun({
      requestId: "team-run-one",
      expectedStoreRevision: task.storeRevision,
      taskId: task.task.id,
      scope: task.task.scope,
      members: [
        {
          profileId: "builtin-explore",
          title: "Explore the architecture",
          taskPacket: { objective: "Collect facts" },
        },
        {
          profileId: "builtin-verifier",
          title: "Verify the contract",
          taskPacket: { objective: "Check evidence" },
        },
      ],
    });
    assert.equal(created.teamRun.status, "active");
    assert.equal(created.coordinatorAgentRun.sessionId, task.coordinationSession.id);
    assert.equal(created.childSessions.length, 2);
    assert.equal(created.childAgentRuns.length, 2);
    assert.equal(created.assignments.filter((assignment) => assignment.assignmentKind === "coordinator").length, 1);
    assert.equal(created.assignments.filter((assignment) => assignment.assignmentKind === "member").length, 2);
    const snapshot = await store.snapshot();
    assert.equal(snapshot.teamRuns.length, 1);
    assert.equal(snapshot.agentRuns.length, 3);
    assert.equal(snapshot.tasks[0]?.state, "active", "Team creation starts work but does not accept the Task");
    assert.equal(snapshot.sessions.filter((session) => session.kind === "child").length, 2);
    await assert.rejects(
      store.createTeamRun({
        requestId: "team-run-two",
        expectedStoreRevision: created.storeRevision,
        taskId: task.task.id,
        scope: task.task.scope,
        members: [{
          profileId: "builtin-worker",
          title: "Overlapping team",
          taskPacket: { objective: "Must fail" },
        }],
      }),
      (error: unknown) => error instanceof ProductStoreError && error.code === "REVISION_CONFLICT",
    );
  } finally {
    await store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Managed Worker worktree writes Artifact and external Attempt before Git, then preserves both across recovery", async () => {
  const f = await fixture("dcode-managed-worktree-store-");
  let store = await open(f);
  try {
    const project = await store.createProject({
      requestId: "managed-worktree-project",
      expectedStoreRevision: 0,
      title: "Worker Project",
      directory: f.projectDirectory,
    });
    const task = await store.createTask({
      requestId: "managed-worktree-task",
      expectedStoreRevision: project.storeRevision,
      scope: { kind: "project", projectId: project.project.id },
      title: "Isolate Worker",
      goal: "Create a durable Worker worktree mapping",
    });
    const team = await store.createTeamRun({
      requestId: "managed-worktree-team",
      expectedStoreRevision: task.storeRevision,
      taskId: task.task.id,
      scope: task.task.scope,
      members: [
        { profileId: "builtin-explore", title: "Explore", taskPacket: { objective: "Read" } },
        { profileId: "builtin-worker", title: "Worker", taskPacket: { objective: "Write" } },
      ],
    });
    const worker = team.childAgentRuns.find((run) => run.role === "worker");
    assert.ok(worker);
    const claimed = await store.claimTeamRunStart({
      requestId: "managed-worktree-claim",
      expectedStoreRevision: team.storeRevision,
      expectedTeamRunRevision: team.teamRun.revision,
      scope: task.task.scope,
      taskId: task.task.id,
      teamRunId: team.teamRun.id,
    });
    const artifactId = managedWorkerWorktreeArtifactId(worker.id);
    const worktreeRoot = join(f.dataRoot, "runtime", "workspaces", "worker", "agent-test");
    const workspaceCwd = join(worktreeRoot, "packages", "app");
    const prepared = await store.prepareManagedWorkerWorktrees({
      requestId: "managed-worktree-prepare",
      expectedStoreRevision: claimed.storeRevision,
      scope: task.task.scope,
      taskId: task.task.id,
      teamRunId: team.teamRun.id,
      plans: [{
        agentRunId: worker.id,
        artifactId,
        workspaceId: `managed-worker-worktree:${artifactId}`,
        worktreeRoot,
        workspaceCwd,
        sourceProjectDirectory: f.projectDirectory,
        repositoryRoot: f.projectDirectory,
        commonGitDirectory: join(f.projectDirectory, ".git"),
        baseCommit: "a".repeat(40),
        projectRelativePath: "packages/app",
      }],
    });
    assert.equal(prepared.worktrees[0]?.state, "preparing");
    let snapshot = await store.snapshot();
    const preparedWorktree = snapshot.managedWorkerWorktrees.find((item) => item.agentRunId === worker.id);
    assert.equal(preparedWorktree?.state, "preparing");
    assert.equal(
      snapshot.operationAttempts.find((attempt) => attempt.id === preparedWorktree?.provisionAttemptId)?.status,
      "prepared",
    );

    await store.close();
    store = await open(f);
    snapshot = await store.snapshot();
    const recoveredWorktree = snapshot.managedWorkerWorktrees.find((item) => item.agentRunId === worker.id);
    assert.equal(recoveredWorktree?.state, "unknown");
    assert.equal(recoveredWorktree?.failureCode, "RUNTIME_INTERRUPTED");
    assert.equal(
      snapshot.operationAttempts.find((attempt) => attempt.id === recoveredWorktree?.provisionAttemptId)?.status,
      "unknown",
      "a prepared Git worktree Attempt must never auto-replay after restart",
    );
  } finally {
    await store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Agent Request waits only its member, resumes from a valid choice, and cancels on restart", async () => {
  const f = await fixture();
  let store = await open(f);
  try {
    const initial = await store.snapshot();
    const task = await store.createTask({
      requestId: "request-task",
      expectedStoreRevision: initial.storeRevision,
      scope: { kind: "user", userId: initial.currentUser.id },
      title: "Request decisions",
      goal: "One member waits while another continues",
    });
    const team = await store.createTeamRun({
      requestId: "request-team",
      expectedStoreRevision: task.storeRevision,
      taskId: task.task.id,
      scope: task.task.scope,
      members: [
        { profileId: "builtin-explore", title: "Explore", taskPacket: { objective: "Explore" } },
        { profileId: "builtin-verifier", title: "Verify", taskPacket: { objective: "Verify" } },
      ],
    });
    const [explore, verifier] = team.childAgentRuns;
    assert.ok(explore && verifier);
    const prepare = async (agentRun: typeof explore, runtimeId: string) => {
      const prepared = await store.prepareSessionRun({
        requestId: `prepare-${runtimeId}`,
        taskId: task.task.id,
        scope: task.task.scope,
        sessionId: agentRun.sessionId,
        runtimeId,
        agentRunId: agentRun.id,
        workspaceId: `workspace-${runtimeId}`,
        cwd: f.home,
        workspaceAccess: "sharedReadOnly",
        message: `run ${runtimeId}`,
        attachmentRefs: [],
        roleRevision: `${agentRun.role}:v1`,
        contextRevision: 1,
        profileSnapshot: { role: agentRun.role },
        tools: [{ name: "dcode_request", description: "Request a choice", parameters: { type: "object" } }],
        toolsWritable: false,
        systemPromptDigest: `sha256:${"f".repeat(64)}`,
        promptSources: [],
      });
      await store.startSessionRun(prepared.sessionRunId);
      return prepared;
    };
    const exploreRun = await prepare(explore, "runtime-explore");
    const verifierRun = await prepare(verifier, "runtime-verifier");
    const beforeRequest = await store.snapshot();
    const opened = await store.createAgentRequest({
      requestId: "open-agent-request",
      taskId: task.task.id,
      agentRunId: explore.id,
      sessionId: explore.sessionId,
      sessionRunId: exploreRun.sessionRunId,
      runtimeId: "runtime-explore",
      kind: "choice",
      prompt: "Which evidence boundary should I use?",
      options: [
        { id: "bounded", label: "Bounded evidence", recommended: true },
        { id: "broad", label: "Broad scan", recommended: false },
      ],
    });
    let snapshot = await store.snapshot();
    assert.equal(snapshot.agentRuns.find((run) => run.id === explore.id)?.status, "waiting");
    assert.equal(snapshot.sessionRuns.find((run) => run.id === exploreRun.sessionRunId)?.status, "waiting");
    assert.equal(snapshot.agentRuns.find((run) => run.id === verifier.id)?.status, "running");
    assert.equal(snapshot.sessionRuns.find((run) => run.id === verifierRun.sessionRunId)?.status, "running");
    assert.equal(snapshot.teamRuns.find((run) => run.id === team.teamRun.id)?.status, "active");
    assert.equal(snapshot.agentRequests.find((request) => request.id === opened.agentRequest.id)?.status, "open");
    assert.ok(opened.storeRevision > beforeRequest.storeRevision);

    await assert.rejects(
      store.answerAgentRequest({
        requestId: "invalid-agent-answer",
        expectedStoreRevision: snapshot.storeRevision,
        agentRequestId: opened.agentRequest.id,
        expectedRequestRevision: opened.agentRequest.revision,
        scope: task.task.scope,
        taskId: task.task.id,
        teamRunId: team.teamRun.id,
        agentRunId: explore.id,
        sessionRunId: exploreRun.sessionRunId,
        runtimeId: "runtime-explore",
        answer: { kind: "choice", optionId: "missing" },
      }),
      (error: unknown) => error instanceof ProductStoreError && error.code === "INVALID_ARGUMENT",
    );
    const answered = await store.answerAgentRequest({
      requestId: "answer-agent-request",
      expectedStoreRevision: snapshot.storeRevision,
      agentRequestId: opened.agentRequest.id,
      expectedRequestRevision: opened.agentRequest.revision,
      scope: task.task.scope,
      taskId: task.task.id,
      teamRunId: team.teamRun.id,
      agentRunId: explore.id,
      sessionRunId: exploreRun.sessionRunId,
      runtimeId: "runtime-explore",
      answer: { kind: "choice", optionId: "bounded" },
    });
    snapshot = await store.snapshot();
    assert.equal(answered.agentRequest.answer?.optionId, "bounded");
    assert.equal(snapshot.agentRuns.find((run) => run.id === explore.id)?.status, "running");
    assert.equal(snapshot.sessionRuns.find((run) => run.id === exploreRun.sessionRunId)?.status, "running");

    const second = await store.createAgentRequest({
      requestId: "open-restart-request",
      taskId: task.task.id,
      agentRunId: verifier.id,
      sessionId: verifier.sessionId,
      sessionRunId: verifierRun.sessionRunId,
      runtimeId: "runtime-verifier",
      kind: "choice",
      prompt: "Should verification continue?",
      options: [
        { id: "continue", label: "Continue", recommended: true },
        { id: "stop", label: "Stop", recommended: false },
      ],
    });
    snapshot = await store.snapshot();
    const waitingVerifier = snapshot.agentRuns.find((run) => run.id === verifier.id);
    assert.ok(waitingVerifier);
    const stop = await store.prepareAgentRunStop({
      requestId: "stop-waiting-verifier",
      expectedStoreRevision: snapshot.storeRevision,
      scope: task.task.scope,
      taskId: task.task.id,
      teamRunId: team.teamRun.id,
      agentRunId: verifier.id,
      sessionRunId: verifierRun.sessionRunId,
      runtimeId: "runtime-verifier",
      expectedAgentRunRevision: waitingVerifier.revision,
    });
    await store.finishOperationAttempt({ attemptId: stop.attemptId, outcome: "succeeded" });
    await store.finishSessionRun({
      sessionRunId: verifierRun.sessionRunId,
      providerAttemptId: verifierRun.providerAttemptId,
      outcome: "aborted",
    });
    snapshot = await store.snapshot();
    assert.equal(snapshot.agentRuns.find((run) => run.id === verifier.id)?.status, "aborted");
    assert.equal(snapshot.agentRuns.find((run) => run.id === explore.id)?.status, "running");
    assert.equal(snapshot.teamRuns.find((run) => run.id === team.teamRun.id)?.status, "active");
    assert.equal(snapshot.operationAttempts.find((attempt) => attempt.id === stop.attemptId)?.status, "succeeded");
    await store.close();
    store = await open(f);
    snapshot = await store.snapshot();
    assert.equal(snapshot.agentRequests.find((request) => request.id === second.agentRequest.id)?.status, "cancelled");
    assert.equal(snapshot.agentRuns.find((run) => run.id === verifier.id)?.status, "aborted");
    assert.equal(snapshot.teamRuns.find((run) => run.id === team.teamRun.id)?.status, "interrupted");
  } finally {
    await store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Pi import publishes one Task bundle with unknown historical lineage and immutable provenance", async () => {
  const f = await fixture();
  const store = await open(f);
  try {
    const user = (await store.snapshot()).currentUser;
    const imported = await store.importPiSessionAsTask({
      requestId: "import-pi-session",
      expectedStoreRevision: 0,
      scope: { kind: "user", userId: user.id },
      sourceSessionId: "pi-session-1",
      sourcePath: join(f.root, "pi-session-1.jsonl"),
      sourceDigest: `sha256:${"a".repeat(64)}`,
      historicalCwd: f.home,
      title: "Imported Pi session",
      entries: [
        {
          sourceEntryId: "u1",
          sourceOrdinal: 0,
          sourceTimestamp: "2026-08-25T00:00:00.000Z",
          messageRole: "user",
          content: "原始用户文字",
        },
        {
          sourceEntryId: "a1",
          sourceParentEntryId: "u1",
          sourceOrdinal: 1,
          sourceTimestamp: "2026-08-25T00:00:01.000Z",
          messageRole: "assistant",
          content: [{ type: "text", text: "原始助手文字" }],
        },
      ],
      paths: [{
        sourcePathId: "leaf:a1",
        sourceLeafEntryId: "a1",
        title: "Current path",
        isCurrent: true,
        sourceEntryIds: ["u1", "a1"],
      }],
      conversionEvidence: { version: 1, hiddenThinkingOmitted: false },
    });
    assert.equal(imported.storeRevision, 1);
    assert.equal(imported.coordinationSession.lineageStatus, "unknown");
    assert.equal(imported.piImport.lineageStatus, "unknown");
    assert.equal(imported.importedEntryCount, 2);
    const entries = await store.importedSessionEntries(imported.coordinationSession.id);
    assert.equal(entries[0]?.lineageStatus, "unknown");
    assert.equal(entries[0]?.content, "原始用户文字");
    assert.equal(entries[1]?.sourceParentEntryId, "u1");
    const snapshot = await store.snapshot();
    assert.equal(snapshot.piImports[0]?.sourceSessionId, "pi-session-1");
    assert.equal(snapshot.events[0]?.kind, "piImport.completed");

    await assert.rejects(
      store.importPiSessionAsTask({
        requestId: "import-pi-session-again",
        expectedStoreRevision: 1,
        scope: { kind: "user", userId: user.id },
        sourceSessionId: "pi-session-1",
        sourcePath: join(f.root, "pi-session-1.jsonl"),
        sourceDigest: `sha256:${"a".repeat(64)}`,
        historicalCwd: f.home,
        title: "Imported Pi session",
        entries: [],
        paths: [{
          sourcePathId: "root",
          title: "Root",
          isCurrent: true,
          sourceEntryIds: [],
        }],
        conversionEvidence: { version: 1 },
      }),
      (error: unknown) => error instanceof ProductStoreError
        && error.code === "PI_SESSION_ALREADY_IMPORTED",
    );
  } finally {
    await store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Pi import fault injection never publishes a half Task or provenance record", async () => {
  const f = await fixture();
  let fault: ProductStoreFaultPoint | undefined = "piImport.afterEntries";
  const store = await open(f, {
    faultInjector: (point) => {
      if (point === fault) throw new Error(`Injected ${point}`);
    },
  });
  try {
    const user = (await store.snapshot()).currentUser;
    await assert.rejects(store.importPiSessionAsTask({
      requestId: "faulted-pi-import",
      expectedStoreRevision: 0,
      scope: { kind: "user", userId: user.id },
      sourceSessionId: "pi-session-fault",
      sourcePath: join(f.root, "pi-session-fault.jsonl"),
      sourceDigest: `sha256:${"b".repeat(64)}`,
      historicalCwd: f.home,
      title: "Faulted import",
      entries: [{ sourceEntryId: "u1", sourceOrdinal: 0, messageRole: "user", content: "hello" }],
      paths: [{
        sourcePathId: "leaf:u1",
        sourceLeafEntryId: "u1",
        title: "Current path",
        isCurrent: true,
        sourceEntryIds: ["u1"],
      }],
      conversionEvidence: { version: 1 },
    }), /Injected piImport\.afterEntries/);
    fault = undefined;
    const snapshot = await store.snapshot();
    assert.equal(snapshot.storeRevision, 0);
    assert.deepEqual(snapshot.tasks, []);
    assert.deepEqual(snapshot.sessions, []);
    assert.deepEqual(snapshot.piImports, []);
  } finally {
    await store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a second Product Store writer is rejected until the first Host releases its lease", async () => {
  const f = await fixture();
  const first = await open(f);
  try {
    await assert.rejects(
      open(f),
      (error: unknown) => error instanceof ProductStoreLeaseError
        && error.code === "PRODUCT_STORE_IN_USE",
    );
  } finally {
    await first.close();
  }
  const next = await open(f);
  await next.close();
  await rm(f.root, { recursive: true, force: true });
});

test("an unknown Product Store schema is blocked without changing its bytes", async () => {
  const f = await fixture();
  await mkdir(f.dataRoot, { recursive: true });
  const path = join(f.dataRoot, "product-store.sqlite3");
  const unknown = new DatabaseSync(path);
  unknown.exec("PRAGMA application_id = 1145257796; PRAGMA user_version = 99; CREATE TABLE keep_me(value TEXT);");
  unknown.close();
  const before = createHash("sha256").update(await readFile(path)).digest("hex");
  try {
    await assert.rejects(
      open(f),
      (error: unknown) => error instanceof ProductStoreSchemaError
        && error.code === "PRODUCT_STORE_SCHEMA_UNSUPPORTED",
    );
    const after = createHash("sha256").update(await readFile(path)).digest("hex");
    assert.equal(after, before);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a known schema missing required metadata is rejected during Product Store startup", async () => {
  const f = await fixture();
  const store = await open(f);
  await store.close();
  const path = join(f.dataRoot, "product-store.sqlite3");
  const damaged = new DatabaseSync(path);
  damaged.exec("DELETE FROM dcode_meta WHERE key = 'store_revision'");
  damaged.close();
  try {
    await assert.rejects(
      open(f),
      (error: unknown) => error instanceof ProductStoreSchemaError
        && error.code === "PRODUCT_STORE_SCHEMA_INVALID",
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a known schema missing a contract index is rejected during Product Store startup", async () => {
  const f = await fixture();
  const store = await open(f);
  await store.close();
  const path = join(f.dataRoot, "product-store.sqlite3");
  const damaged = new DatabaseSync(path);
  damaged.exec("DROP INDEX one_coordination_session_per_task");
  damaged.close();
  try {
    await assert.rejects(
      open(f),
      (error: unknown) => error instanceof ProductStoreSchemaError
        && error.code === "PRODUCT_STORE_SCHEMA_INVALID",
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
