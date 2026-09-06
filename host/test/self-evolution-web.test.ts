import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProductStore } from "../src/product-store.js";
test("failed rollback is a cancelled attempt and does not settle the source receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-evolution-"));
  const home = join(root, "home");
  await mkdir(home);
  const store = await ProductStore.open({
    dataRoot: join(root, ".dcode"),
    userHome: home,
  });
  let n = 0;
  const revision = async () => ({
    requestId: `evolution-test-${++n}`,
    expectedStoreRevision: (await store.snapshot()).storeRevision,
  });
  const oldApp = "/tmp/dcode-evolution-source/D Code.app",
    newApp = "/Users/diwu/Workspace/Codes/Apps/dcode/dist-candidate/web-4a7449be-0359-40bd-afb9-fc8cb25f8103/mac-arm64/D Code.app";
  const a = `sha256:${"a".repeat(64)}`,
    b = `sha256:${"b".repeat(64)}`;
  try {
    await assert.rejects(store.recordMaintenance({status:"failed",summary:"fixture",output:[],sourceDirectory:"/tmp/sk-testsecretvalue0123456789"}),/credential material/);
    await store.recordMaintenance({
      status: "succeeded",
      summary: "fixture",
      output: [],
      candidatePath: newApp,
    });
    const original = await store.prepareWebEvolution({
      ...(await revision()),
      fromApp: oldApp,
      toApp: newApp,
      fromDigest: a,
      toDigest: b,
    });
    await store.transitionWebEvolution({
      ...(await revision()),
      id: original.receipt.id,
      state: "session_restored",
      selection: { taskId: null, sessionId: null },
    });
    const failed = await store.prepareWebEvolution({
      ...(await revision()),
      fromApp: newApp,
      toApp: oldApp,
      fromDigest: b,
      toDigest: a,
      rollbackOf: original.receipt.id,
    });
    await store.transitionWebEvolution({
      ...(await revision()),
      id: failed.receipt.id,
      state: "cancelled",
    });
    assert.equal(
      store.webEvolutionReceipts().find((r) => r.id === original.receipt.id)
        ?.state,
      "session_restored",
    );
    const retry = await store.prepareWebEvolution({
      ...(await revision()),
      fromApp: newApp,
      toApp: oldApp,
      fromDigest: b,
      toDigest: a,
      rollbackOf: original.receipt.id,
    });
    await store.transitionWebEvolution({
      ...(await revision()),
      id: retry.receipt.id,
      state: "session_restored",
      selection: { taskId: null, sessionId: null },
    });
    assert.equal(
      store.webEvolutionReceipts().find((r) => r.id === original.receipt.id)
        ?.state,
      "session_restored",
    );
    await store.transitionWebEvolution({
      ...(await revision()),
      id: retry.receipt.id,
      state: "rolled_back",
    });
    assert.equal(
      store.webEvolutionReceipts().find((r) => r.id === original.receipt.id)
        ?.state,
      "rolled_back",
    );
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
