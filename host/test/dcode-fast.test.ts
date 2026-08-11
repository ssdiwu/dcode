import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DCodeFastController,
  FAST_SERVICE_TIER,
  applyFastServiceTier,
  createFastSnapshot,
  createDCodeFastExtension,
  restoreFastMode,
  shouldApplyFastMode,
} from "../src/dcode-fast.js";

test("fast mode only injects priority for supported openai-codex models", () => {
  const model = { provider: "openai-codex", id: "gpt-5.6-sol" };
  const payload = { model: "gpt-5.6-sol", input: "secret prompt" };

  assert.equal(shouldApplyFastMode(false, model, payload), false);
  assert.equal(shouldApplyFastMode(true, { provider: "anthropic", id: "gpt-5.6-sol" }, payload), false);
  assert.equal(shouldApplyFastMode(true, model, { ...payload, model: "another" }), false);
  assert.equal(shouldApplyFastMode(true, model, payload), true);
  assert.deepEqual(applyFastServiceTier(payload), { ...payload, service_tier: FAST_SERVICE_TIER });
  assert.deepEqual(payload, { model: "gpt-5.6-sol", input: "secret prompt" });
});

test("fast snapshots expose enabled-but-inactive reasons", () => {
  const snapshot = createFastSnapshot(false, undefined);
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.enabled, false);
  assert.equal(snapshot.active, false);
  assert.equal(snapshot.requestedServiceTier, "priority");
  assert.equal(snapshot.reason, "disabled");
  assert.equal(typeof snapshot.updatedAt, "number");
  assert.equal(createFastSnapshot(true, { provider: "openai-codex", id: "gpt-5.4-mini" }).reason, "unsupported-model");
  assert.equal(createFastSnapshot(true, { provider: "openai-codex", id: "gpt-5.6-sol" }).active, true);
});

test("fast mode restores the last compatible session entry", () => {
  assert.equal(restoreFastMode([
    { type: "custom", customType: "pi-dfast-state", data: { version: 1, enabled: true } },
    { type: "custom", customType: "other", data: { version: 1, enabled: false } },
    { type: "custom", customType: "pi-dfast-state", data: { version: 1, enabled: false } },
  ]), false);
  assert.equal(restoreFastMode([
    { type: "custom", customType: "pi-dfast-state", data: { version: 1, enabled: true } },
  ]), true);
});

test("D Code fast mode keeps the shared pi-dfast snapshot event contract", async () => {
  const busHandlers = new Map<string, (data: unknown) => void>();
  const lifecycleHandlers = new Map<string, (event: unknown, context: ExtensionContext) => unknown>();
  const updates: unknown[] = [];
  const pi = {
    events: {
      emit(channel: string, data: unknown) {
        if (channel === "pi-dfast/updated") updates.push(data);
        busHandlers.get(channel)?.(data);
      },
      on(channel: string, handler: (data: unknown) => void) {
        busHandlers.set(channel, handler);
        return () => { busHandlers.delete(channel); };
      },
    },
    appendEntry: () => undefined,
    registerCommand: () => undefined,
    on(event: string, handler: (value: unknown, context: ExtensionContext) => unknown) {
      lifecycleHandlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  const controller = new DCodeFastController();
  await createDCodeFastExtension(controller)(pi);
  const context = {
    model: { provider: "openai-codex", id: "gpt-5.6-sol" },
    sessionManager: { getBranch: () => [] },
  } as unknown as ExtensionContext;

  lifecycleHandlers.get("session_start")?.({}, context);
  const first = updates.at(-1) as { version: number; active: boolean; updatedAt: number };
  assert.equal(first.version, 1);
  assert.equal(first.active, false);
  assert.equal(typeof first.updatedAt, "number");

  const beforeSubscribe = updates.length;
  busHandlers.get("pi-dfast/subscribe")?.({ version: 1, consumerId: "pi-dusage" });
  assert.equal(updates.length, beforeSubscribe + 1);
  assert.equal((updates.at(-1) as { version: number }).version, 1);
});
