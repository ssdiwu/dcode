import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PiHost } from "../src/pi-host.js";
import { validateMethodParams } from "../src/protocol.js";
import type {
  FoundationSnapshot,
  TaskBundle,
  ClientPreferences,
} from "../src/product-store.js";

test("Web recovery stores scoped drafts, reading positions and notification preferences across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-client-recovery-"));
  const agent = join(root, "agent"),
    home = join(root, "home");
  await mkdir(agent);
  await mkdir(home);
  const options = {
    agentDir: agent,
    sessionsDirectory: join(agent, "sessions"),
    dataRoot: join(root, ".dcode"),
    userHome: home,
    emit: () => {},
  };
  let host = new PiHost(options);
  const snapshot = () =>
    host.handle("foundation.snapshot", {}) as Promise<FoundationSnapshot>;
  let serial = 0;
  const mutate = async (
    method: "task.create" | "taskDraft.set" | "clientPreferences.set",
    values: Record<string, unknown>,
  ) => {
    const data = await snapshot();
    const params = {
      ...values,
      requestId: `recovery-${++serial}`,
      expectedStoreRevision: data.storeRevision,
    };
    validateMethodParams(method, params);
    return await host.handle(method, params);
  };
  try {
    await host.start();
    const initial = await snapshot();
    const scope = { kind: "user", userId: initial.currentUser.id };
    await mutate("taskDraft.set", { scope, text: "未创建任务的输入" });
    assert.equal((await snapshot()).tasks.length, 0);
    const task = (await mutate("task.create", {
      scope,
      title: "recovery",
      goal: "restore",
    })) as TaskBundle;
    await mutate("clientPreferences.set", {
      notificationsEnabled: false,
      readingPosition: { sessionId: task.coordinationSession.id, offset: 432 },
    });
    await assert.rejects(
      mutate("clientPreferences.set", {
        readingPosition: { sessionId: "missing", offset: 1 },
      }),
      /does not exist/,
    );
    await assert.rejects(
      mutate("taskDraft.set", {
        scope: { kind: "project", projectId: "missing" },
        text: "bad",
      }),
      /does not exist/,
    );
    assert.throws(
      () =>
        validateMethodParams("clientPreferences.set", {
          requestId: "bad",
          expectedStoreRevision: 1,
          readingPosition: { sessionId: "s", offset: -1 },
        }),
      /integer/,
    );
    await host.close();
    host = new PiHost(options);
    await host.start();
    const restored = await snapshot();
    assert.equal(
      restored.composerDrafts.find((d) => d.draftKind === "new_task")?.text,
      "未创建任务的输入",
    );
    const preferences = (await host.handle(
      "clientPreferences.get",
      {},
    )) as ClientPreferences;
    assert.equal(preferences.notificationsEnabled, false);
    assert.equal(
      preferences.readingPositions[task.coordinationSession.id],
      432,
    );
    await mutate("taskDraft.set", { scope, text: "" });
    assert.equal((await snapshot()).composerDrafts.length, 0);
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});
