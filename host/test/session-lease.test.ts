import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionLease, SessionLeaseError, sessionSnapshotDigest } from "../src/session-lease.js";

async function fixture(): Promise<{ root: string; agentDir: string; sessionPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-dcode-host-test-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  const sessionPath = join(root, "session.jsonl");
  await writeFile(
    sessionPath,
    `${JSON.stringify({ type: "session", version: 3, id: "session-one", timestamp: new Date().toISOString(), cwd: root })}\n`
      + `${JSON.stringify({ type: "message", id: "leaf-one", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "test", timestamp: Date.now() } })}\n`,
  );
  return { root, agentDir, sessionPath };
}

async function expectLeaseCode(operation: Promise<unknown>, code: SessionLeaseError["code"]): Promise<void> {
  await assert.rejects(
    operation,
    (error: unknown) => error instanceof SessionLeaseError && error.code === code,
  );
}

test("second owner is rejected and release removes the lease", async () => {
  const { root, agentDir, sessionPath } = await fixture();
  try {
    const first = await SessionLease.acquire({ agentDir, sessionId: "session-one", sessionPath, quietWindowMs: 1 });
    await expectLeaseCode(
      SessionLease.acquire({ agentDir, sessionId: "session-one", sessionPath, quietWindowMs: 1 }),
      "SESSION_IN_USE",
    );
    await first.release();
    const second = await SessionLease.acquire({ agentDir, sessionId: "session-one", sessionPath, quietWindowMs: 1 });
    await second.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dead owner lease is reclaimed automatically", async () => {
  const { root, agentDir, sessionPath } = await fixture();
  try {
    const deadPid = 2_147_483_647;
    await SessionLease.acquire({
      agentDir,
      sessionId: "session-one",
      sessionPath,
      quietWindowMs: 1,
      pid: deadPid,
    });

    const recovered = await SessionLease.acquire({
      agentDir,
      sessionId: "session-one",
      sessionPath,
      quietWindowMs: 1,
    });
    const owner = JSON.parse(await readFile(recovered.ownerPath, "utf8")) as { pid?: unknown };
    assert.equal(owner.pid, process.pid);
    await recovered.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent stale-lease recovery grants exactly one owner", async () => {
  const { root, agentDir, sessionPath } = await fixture();
  try {
    await SessionLease.acquire({
      agentDir,
      sessionId: "session-one",
      sessionPath,
      quietWindowMs: 1,
      pid: 2_147_483_647,
    });

    const attempts = await Promise.allSettled([
      SessionLease.acquire({ agentDir, sessionId: "session-one", sessionPath, quietWindowMs: 1 }),
      SessionLease.acquire({ agentDir, sessionId: "session-one", sessionPath, quietWindowMs: 1 }),
    ]);
    const fulfilled = attempts.filter(
      (result): result is PromiseFulfilledResult<SessionLease> => result.status === "fulfilled",
    );
    const rejected = attempts.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0]?.reason instanceof SessionLeaseError);
    assert.equal((rejected[0]?.reason as SessionLeaseError).code, "SESSION_IN_USE");
    await fulfilled[0]?.value.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("quiet window rejects a changing session", async () => {
  const { root, agentDir, sessionPath } = await fixture();
  try {
    const change = setTimeout(() => {
      void writeFile(sessionPath, `${JSON.stringify({ type: "custom", id: "external", parentId: "leaf-one", timestamp: new Date().toISOString(), customType: "probe" })}\n`, { flag: "a" });
    }, 10);
    await expectLeaseCode(
      SessionLease.acquire({ agentDir, sessionId: "session-one", sessionPath, quietWindowMs: 80 }),
      "SESSION_NOT_IDLE",
    );
    clearTimeout(change);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("owned append is accepted only when the runtime snapshot matches the file", async () => {
  const { root, agentDir, sessionPath } = await fixture();
  try {
    const lease = await SessionLease.acquire({ agentDir, sessionId: "session-one", sessionPath, quietWindowMs: 1 });
    const entries = (await readFile(sessionPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as unknown);
    const owned = { type: "custom", id: "owned", parentId: "leaf-one", timestamp: new Date().toISOString(), customType: "probe" };
    await writeFile(sessionPath, `${JSON.stringify(owned)}\n`, { flag: "a" });
    await lease.acceptOwnedChange(sessionSnapshotDigest([...entries, owned]));
    await lease.assertUnchanged();
    await lease.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("external append mixed with an owned append cannot be accepted", async () => {
  const { root, agentDir, sessionPath } = await fixture();
  try {
    const lease = await SessionLease.acquire({ agentDir, sessionId: "session-one", sessionPath, quietWindowMs: 1 });
    const entries = (await readFile(sessionPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as unknown);
    const external = { type: "custom", id: "external", parentId: "leaf-one", timestamp: new Date().toISOString(), customType: "external" };
    const owned = { type: "custom", id: "owned", parentId: "leaf-one", timestamp: new Date().toISOString(), customType: "owned" };
    await writeFile(sessionPath, `${JSON.stringify(external)}\n${JSON.stringify(owned)}\n`, { flag: "a" });
    await expectLeaseCode(lease.acceptOwnedChange(sessionSnapshotDigest([...entries, owned])), "EXTERNAL_WRITE_DETECTED");
    await rm(lease.lockDirectory, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("wrong owner nonce prevents destructive release", async () => {
  const { root, agentDir, sessionPath } = await fixture();
  try {
    const lease = await SessionLease.acquire({ agentDir, sessionId: "session-one", sessionPath, quietWindowMs: 1 });
    const owner = JSON.parse(await readFile(lease.ownerPath, "utf8")) as Record<string, unknown>;
    owner.nonce = "somebody-else";
    await writeFile(lease.ownerPath, `${JSON.stringify(owner)}\n`);
    await expectLeaseCode(lease.release(), "LEASE_OWNER_MISMATCH");
    await rm(lease.lockDirectory, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("corrupt owner record is retained instead of deleting an unverifiable lease", async () => {
  const { root, agentDir, sessionPath } = await fixture();
  try {
    const lease = await SessionLease.acquire({ agentDir, sessionId: "session-one", sessionPath, quietWindowMs: 1 });
    await writeFile(lease.ownerPath, "{bad}\n");
    await expectLeaseCode(lease.release(), "LEASE_OWNER_MISMATCH");
    await assert.rejects(
      SessionLease.acquire({ agentDir, sessionId: "session-one", sessionPath, quietWindowMs: 1 }),
      (error: unknown) => error instanceof SessionLeaseError && error.code === "SESSION_IN_USE",
    );
    await rm(lease.lockDirectory, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
