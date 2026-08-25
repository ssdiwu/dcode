import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProductStoreLease, ProductStoreLeaseError } from "../src/product-store-lease.js";

test("Product Store lease allows one live writer and releases ownership explicitly", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-product-store-lease-"));
  const leasePath = join(root, "runtime", "product-store.lock");
  try {
    const first = await ProductStoreLease.acquire(leasePath, { nonce: "first-owner" });
    await assert.rejects(
      ProductStoreLease.acquire(leasePath, { nonce: "second-owner" }),
      (error: unknown) => error instanceof ProductStoreLeaseError
        && error.code === "PRODUCT_STORE_IN_USE",
    );
    await first.assertOwned();
    await first.release();
    const second = await ProductStoreLease.acquire(leasePath, { nonce: "second-owner" });
    await second.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Product Store lease reclaims only a well-formed dead-process owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-product-store-stale-lease-"));
  const runtime = join(root, "runtime");
  const leasePath = join(runtime, "product-store.lock");
  await mkdir(runtime, { recursive: true });
  try {
    await writeFile(leasePath, `${JSON.stringify({
      version: 1,
      pid: 2_147_483_647,
      nonce: "dead-owner",
      startedAt: "2026-08-25T00:00:00.000Z",
    })}\n`, { mode: 0o600 });
    const lease = await ProductStoreLease.acquire(leasePath, { nonce: "replacement-owner" });
    assert.equal(lease.owner.nonce, "replacement-owner");
    await lease.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Product Store lease fails closed when a stale file names a still-live PID", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-product-store-reused-pid-"));
  const runtime = join(root, "runtime");
  const leasePath = join(runtime, "product-store.lock");
  await mkdir(runtime, { recursive: true });
  try {
    await writeFile(leasePath, `${JSON.stringify({
      version: 1,
      pid: process.pid,
      nonce: "old-process-with-reused-pid",
      startedAt: "2026-08-24T00:00:00.000Z",
    })}\n`, { mode: 0o600 });
    const staleTime = new Date(Date.now() - 60_000);
    await utimes(leasePath, staleTime, staleTime);
    await assert.rejects(
      ProductStoreLease.acquire(leasePath, { nonce: "current-process-owner" }),
      (error: unknown) => error instanceof ProductStoreLeaseError
        && error.code === "PRODUCT_STORE_IN_USE",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Product Store lease restores a replacement owner detected during stale recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-product-store-lease-race-"));
  const runtime = join(root, "runtime");
  const leasePath = join(runtime, "product-store.lock");
  const samplePath = join(runtime, "sample.lock");
  await mkdir(runtime, { recursive: true });
  const liveSample = await ProductStoreLease.acquire(samplePath, { nonce: "live-replacement" });
  const liveOwner = liveSample.owner;
  await liveSample.release();
  try {
    await writeFile(leasePath, `${JSON.stringify({
      version: 1,
      pid: 2_147_483_647,
      nonce: "dead-owner",
      startedAt: "2026-08-24T00:00:00.000Z",
    })}\n`, { mode: 0o600 });
    await assert.rejects(
      ProductStoreLease.acquire(leasePath, {
        nonce: "racing-acquirer",
        beforeStaleRename: async () => {
          await unlink(leasePath);
          await writeFile(leasePath, `${JSON.stringify(liveOwner)}\n`, { flag: "wx", mode: 0o600 });
        },
      }),
      (error: unknown) => error instanceof ProductStoreLeaseError
        && error.code === "PRODUCT_STORE_LEASE_RACE",
    );
    const restored = JSON.parse(await readFile(leasePath, "utf8")) as { nonce?: unknown };
    assert.equal(restored.nonce, "live-replacement");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Product Store lease fails closed for an invalid owner record", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-product-store-invalid-lease-"));
  const runtime = join(root, "runtime");
  const leasePath = join(runtime, "product-store.lock");
  await mkdir(runtime, { recursive: true });
  try {
    await writeFile(leasePath, "not-json\n", { mode: 0o600 });
    await assert.rejects(
      ProductStoreLease.acquire(leasePath),
      (error: unknown) => error instanceof ProductStoreLeaseError
        && error.code === "PRODUCT_STORE_LEASE_INVALID",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
