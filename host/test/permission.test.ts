import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionFactory, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import {
  PermissionStore,
  bashCommandMatchesPattern,
  bashGrantPattern,
  classifyBashRisk,
  classifyWriteRisk,
} from "../src/permission-store.js";
import {
  PermissionGateController,
  createPermissionGuardExtension,
  type PermissionRequestPayload,
} from "../src/permission-guard.js";

function bashEvent(command: string, toolCallId = "t1"): ToolCallEvent {
  return { type: "tool_call", toolName: "bash", toolCallId, input: { command } } as ToolCallEvent;
}

function writeEvent(path: string, toolCallId = "w1"): ToolCallEvent {
  return { type: "tool_call", toolName: "write", toolCallId, input: { path, content: "x" } } as ToolCallEvent;
}

async function makeGate(root: string, sessionId = "session-a") {
  const store = await PermissionStore.open(root);
  const requests: PermissionRequestPayload[] = [];
  const gate = new PermissionGateController(
    (_event, data) => { requests.push(data); },
    store,
    sessionId,
    join(root, "project"),
  );
  const handler = captureHandler(createPermissionGuardExtension(gate));
  return { gate, store, requests, handler, cwd: join(root, "project") };
}

function captureHandler(factory: ExtensionFactory) {
  let handler: (event: ToolCallEvent) => Promise<{ block?: boolean; reason?: string }>;
  const api = {
    on: (_event: "tool_call", registered: (event: ToolCallEvent) => Promise<{ block?: boolean; reason?: string }>) => {
      handler = registered;
    },
  } as unknown as ExtensionAPI;
  factory(api);
  return (event: ToolCallEvent) => handler(event);
}

test("permission store persists grants and bounds audit", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-dcode-permission-store-"));
  try {
    const store = await PermissionStore.open(root);
    store.addBashPrefixGrant("/tmp/p", "npm test", "session-a");
    store.addFileWriteGrant("/tmp/p", "session-a");
    for (let index = 0; index < 205; index += 1) {
      store.recordAudit({ sessionId: "s", tool: "bash", summary: "x", risk: "命令执行", decision: "allowOnce" });
    }
    await store.save();

    const reloaded = await PermissionStore.open(root);
    assert.equal(reloaded.grants.length, 2);
    assert.equal(reloaded.audit.length, 200, "审计环形缓冲保持在 200 条");

    assert.equal(reloaded.revoke(reloaded.grants[0]!.id), true);
    assert.equal(reloaded.revoke("missing"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bash grant pattern matching keeps word boundaries", () => {
  assert.equal(bashCommandMatchesPattern("git status", "git"), true);
  assert.equal(bashCommandMatchesPattern("gitx status", "git"), false, "前缀不得误匹配更长程序名");
  assert.equal(bashCommandMatchesPattern("npm test -- --watch", "npm test"), true);
  assert.equal(bashGrantPattern("git push --force"), "git push");
  assert.equal(bashGrantPattern("npm test -- --watch"), "npm test");
  assert.equal(bashGrantPattern("python script.py"), "python");
  assert.equal(classifyBashRisk("rm -rf /tmp/x").startsWith("commandHighRisk") || classifyBashRisk("rm -rf /tmp/x") === "commandHighRisk", true);
  assert.equal(classifyBashRisk("echo hi"), "command");
  assert.equal(classifyWriteRisk("/tmp/project/a.txt", "/tmp/project"), "fileWriteInside");
  assert.equal(classifyWriteRisk("/tmp/other/a.txt", "/tmp/project"), "fileWriteOutside");
});

test("gate asks for bash, persists scope grants, then auto-allows prefixes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-dcode-permission-gate-"));
  try {
    const { gate, store, requests, handler } = await makeGate(root);

    const first = handler(bashEvent("npm test", "t1"));
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.summary, "npm test");
    assert.equal(gate.settle("t1", "allowScope"), true);
    assert.deepEqual(await first, {}, "允许后不阻塞");

    const second = handler(bashEvent("npm test -- --watch", "t2"));
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    assert.deepEqual(await second, {}, "命中前缀 grant 不再询问");
    assert.equal(requests.length, 1, "第二次不应再发 permission.request");
    assert.equal(store.audit.at(-1)!.decision, "autoAllow");

    const third = handler(bashEvent("rm -rf /tmp/x", "t3"));
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    assert.equal(requests.length, 2, "新前缀必须再次询问");
    assert.equal(requests[1]!.risk, "commandHighRisk");
    gate.settle("t3", "deny");
    const denied = await third;
    assert.equal(denied.block, true);
    assert.ok(denied.reason?.includes("拒绝"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gate auto-allows read tools and scopes file writes inside the project root only", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-dcode-permission-write-"));
  try {
    const { gate, requests, handler, cwd } = await makeGate(root);

    assert.deepEqual(await handler({ type: "tool_call", toolName: "read", toolCallId: "r1", input: { path: "a" } } as ToolCallEvent), {});
    assert.deepEqual(await handler({ type: "tool_call", toolName: "grep", toolCallId: "r2", input: { pattern: "x" } } as ToolCallEvent), {});
    assert.equal(requests.length, 0, "读取类工具不询问");

    const inside = handler(writeEvent(join(cwd, "src/a.swift"), "w1"));
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    assert.equal(requests[0]!.risk, "fileWriteInside");
    gate.settle("w1", "allowScope");
    assert.deepEqual(await inside, {});
    const insideAgain = handler(writeEvent(join(cwd, "src/b.swift"), "w2"));
    assert.deepEqual(await insideAgain, {}, "授权根内写入不再询问");

    const outside = handler(writeEvent("/tmp/outside/c.txt", "w3"));
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    assert.equal(requests[1]!.risk, "fileWriteOutside");
    assert.ok(requests[1]!.scopeHint.includes("只能本次允许或拒绝"), "项目外不给范围授权选项语义");
    gate.settle("w3", "allowOnce");
    assert.deepEqual(await outside, {});
    const outsideAgain = handler(writeEvent("/tmp/outside/d.txt", "w4"));
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    assert.equal(requests.length, 3, "项目外每次都要问");
    gate.settle("w4", "deny");
    const blocked = await outsideAgain;
    assert.equal(blocked.block, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("settling all pending requests denies them as session closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-dcode-permission-close-"));
  try {
    const { gate, handler } = await makeGate(root);
    const pending = handler(bashEvent("cargo build", "t9"));
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    gate.settleAll();
    const result = await pending;
    assert.equal(result.block, true);
    assert.ok(result.reason?.includes("会话已关闭"));
    assert.equal(gate.settle("t9", "allowOnce"), false, "结算后请求不可再回应");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unknown custom tools are always asked and never scope-granted", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-dcode-permission-custom-"));
  try {
    const { gate, requests, handler } = await makeGate(root);
    const pending = handler({ type: "tool_call", toolName: "mcp_fetch", toolCallId: "c1", input: { url: "https://x" } } as ToolCallEvent);
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    assert.equal(requests[0]!.risk, "otherTool");
    gate.settle("c1", "allowScope");
    assert.deepEqual(await pending, {});
    const again = handler({ type: "tool_call", toolName: "mcp_fetch", toolCallId: "c2", input: { url: "https://y" } } as ToolCallEvent);
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    assert.equal(requests.length, 2, "自定义工具不支持范围授权，每次询问");
    gate.settle("c2", "deny");
    (await again).block === true;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
