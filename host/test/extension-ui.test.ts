import assert from "node:assert/strict";
import test from "node:test";
import { ExtensionUIBridge } from "../src/extension-ui.js";

interface CapturedEvent {
  event: string;
  data?: unknown;
}

function setup(): { bridge: ExtensionUIBridge; events: CapturedEvent[] } {
  const events: CapturedEvent[] = [];
  const bridge = new ExtensionUIBridge((event, data) => events.push(data === undefined ? { event } : { event, data }));
  return { bridge, events };
}

test("standard dialog emits a request and resolves exactly once", async () => {
  const { bridge, events } = setup();
  const pending = bridge.context.select("Choose", ["A", "B"]);
  const request = events.find((entry) => entry.event === "extension.request")?.data as { requestId: string };
  assert.ok(request.requestId);
  assert.equal(bridge.respond(request.requestId, { value: "B" }), true);
  assert.equal(bridge.respond(request.requestId, { value: "A" }), false);
  assert.equal(await pending, "B");
  assert.equal(events.filter((entry) => entry.event === "extension.closed").length, 1);
});

test("custom component is blocked without invoking its TUI factory", async () => {
  const { bridge, events } = setup();
  let factoryInvoked = false;
  await assert.rejects(
    bridge.context.custom<string>(() => {
      factoryInvoked = true;
      throw new Error("factory must not run");
    }),
    (error: unknown) => typeof error === "object"
      && error !== null
      && (error as { code?: unknown }).code === "EXTENSION_UI_UNSUPPORTED",
  );
  assert.equal(factoryInvoked, false);
  assert.deepEqual(events, [{
    event: "extension.unsupported",
    data: {
      capability: "custom",
      behavior: "blocked",
      message: "D Code blocked unsupported extension UI capability: custom",
    },
  }]);
});

test("widgets are ignored explicitly and their factories never run", () => {
  const { bridge, events } = setup();
  let factoryInvoked = false;
  bridge.context.setWidget("status", ["one"], { placement: "aboveEditor" });
  bridge.context.setWidget("status", () => {
    factoryInvoked = true;
    return { render: () => ["two"], invalidate: () => undefined };
  });
  assert.equal(factoryInvoked, false);
  assert.equal(events.filter((entry) => entry.event === "extension.unsupported").length, 1);
  assert.equal(events.some((entry) => entry.event.startsWith("extension.widget")), false);

  bridge.context.setWidget("status", undefined);
  bridge.context.setWidget("status", ["again"], { placement: "belowEditor" });
  const unsupported = events.filter((entry) => entry.event === "extension.unsupported");
  assert.equal(unsupported.length, 2);
  assert.equal((unsupported[1]?.data as { placement?: string }).placement, "belowEditor");
});

test("native structured notification and status events remain available", () => {
  const { bridge, events } = setup();
  bridge.context.notify("ready", "info");
  bridge.context.setStatus("git", "main");
  bridge.context.setWorkingMessage("working");
  assert.deepEqual(events, [
    { event: "extension.notification", data: { message: "ready", level: "info" } },
    { event: "extension.status", data: { key: "git", text: "main" } },
    { event: "extension.working", data: { message: "working" } },
  ]);
});

test("unsupported TUI queries fail explicitly instead of returning normal empty state", () => {
  const { bridge, events } = setup();
  const isUnsupported = (error: unknown) => typeof error === "object"
    && error !== null
    && (error as { code?: unknown }).code === "EXTENSION_UI_UNSUPPORTED";

  assert.throws(() => bridge.context.getEditorComponent(), isUnsupported);
  assert.throws(() => bridge.context.getAllThemes(), isUnsupported);
  assert.throws(() => bridge.context.getTheme("dark"), isUnsupported);
  assert.throws(() => bridge.context.getToolsExpanded(), isUnsupported);
  assert.deepEqual(events.map((entry) => entry.data), [
    {
      capability: "getEditorComponent",
      behavior: "blocked",
      message: "D Code blocked unsupported extension UI capability: getEditorComponent",
    },
    {
      capability: "getAllThemes",
      behavior: "blocked",
      message: "D Code blocked unsupported extension UI capability: getAllThemes",
    },
    {
      capability: "getTheme",
      behavior: "blocked",
      message: "D Code blocked unsupported extension UI capability: getTheme",
    },
    {
      capability: "getToolsExpanded",
      behavior: "blocked",
      message: "D Code blocked unsupported extension UI capability: getToolsExpanded",
    },
  ]);
});
