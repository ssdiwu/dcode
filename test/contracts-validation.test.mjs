// 接收侧校验的纯函数边界测试：不启动 Electron。
// 用 esbuild（既有依赖，electron-vite 传递）把 TS 契约编译为临时 ESM 后动态导入。

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "dcode-contracts-"));
buildSync({
  entryPoints: [join(root, "src/contracts/index.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: join(dir, "contracts.mjs"),
});
const { validateOperationInput, validateSettingsPatch, isValidSnapshot, isValidOpResponse } = await import(
  pathToFileURL(join(dir, "contracts.mjs")).href
);

after(() => rmSync(dir, { recursive: true, force: true }));

/** 与种子形状同构的合法快照 */
const validSnapshot = () => ({
  workspaces: [{ id: "ws-home", name: "Home", folders: ["~"], builtinHome: true, defaultTaskId: "task-home-default" }],
  tasks: [
    {
      id: "task-home-default",
      workspaceId: "ws-home",
      parentId: null,
      kind: "long",
      title: "默认任务",
      boundFolder: null,
      isDefault: true,
      updatedAt: 1,
    },
  ],
  sessions: [{ id: "s1", taskId: "task-home-default", title: "会话", kind: "main", updatedAt: 1 }],
  timelines: {
    s1: [
      {
        kind: "message",
        id: "m1",
        role: "user",
        text: "你好",
        streaming: false,
        at: 1,
        operationId: "op-1",
        mode: "steer",
        receipt: { status: "accepted", operationId: "op-1", processing: "done" },
      },
      {
        kind: "tool",
        id: "t1",
        tool: { name: "read", primaryText: "读", output: "……", status: "done", exitCode: 0, changedFiles: [] },
        at: 2,
      },
      {
        kind: "change-summary",
        id: "c1",
        files: [{ path: "a.ts", added: 1, deleted: 0, hunks: [{ header: "@@", lines: [{ type: "add", text: "+x" }] }] }],
        at: 3,
      },
      { kind: "run-marker", id: "r1", marker: "finished", text: "本轮结束。", at: 4 },
    ],
  },
  runs: { s1: { sessionId: "s1", status: "ready", note: "", errorNote: null, pendingInputs: 0, updatedAt: 1 } },
  settings: { theme: "system", fontSize: 14, coldStart: "restore", language: "system" },
  model: { available: true, name: "actual-model" },
  modelSetup: { kind: "unconfigured" },
  execution: { kind: "pi" },
  closeError: null,
  closeErrorRevision: 0,
});

test("快照校验：合法快照通过；畸形样本逐项拒绝", () => {
  assert.equal(isValidSnapshot(validSnapshot()), true);
  // 调度只读审查上报的误通过样本：timelines/runs 值非数组/非运行态、settings 为空对象
  assert.equal(
    isValidSnapshot({
      workspaces: [],
      tasks: [],
      sessions: [],
      timelines: { s: 17 },
      runs: { s: "running" },
      settings: {},
      model: { configured: true },
      execution: { kind: "pi" },
      closeError: null,
  closeErrorRevision: 0,
    }),
    false,
  );
  // settings 必须四字段齐备（全量对象，不走 Partial 语义）
  assert.equal(isValidSnapshot({ ...validSnapshot(), settings: {} }), false);
  assert.equal(isValidSnapshot({ ...validSnapshot(), settings: { theme: "dark" } }), false);
  // 时间线块：坏枚举、未知 kind、缺必需字段
  assert.equal(
    isValidSnapshot({
      ...validSnapshot(),
      timelines: { s1: [{ kind: "message", id: "m1", role: "root", text: "x", streaming: false, at: 1 }] },
    }),
    false,
  );
  assert.equal(isValidSnapshot({ ...validSnapshot(), timelines: { s1: [{ kind: "unknown-kind", id: "x", at: 1 }] } }), false);
  assert.equal(
    isValidSnapshot({ ...validSnapshot(), timelines: { s1: [{ kind: "tool", id: "t1", tool: { name: "read" }, at: 1 }] } }),
    false,
  );
  // 运行态：旧相位（finished）不再是合法值
  assert.equal(
    isValidSnapshot({
      ...validSnapshot(),
      runs: { s1: { sessionId: "s1", status: "finished", note: "", pendingInputs: 0, updatedAt: 1 } },
    }),
    false,
  );
  // 装配来源与杂项
  assert.equal(isValidSnapshot({ ...validSnapshot(), execution: { kind: "other" } }), false);
  assert.equal(isValidSnapshot({ ...validSnapshot(), closeError: 42 }), false);
  assert.equal(isValidSnapshot({ ...validSnapshot(), model: { available: true, name: null } }), false);
  assert.equal(isValidSnapshot({ ...validSnapshot(), model: { available: false, name: "fake-label" } }), false);
  assert.equal(isValidSnapshot({ ...validSnapshot(), execution: { kind: "unavailable" } }), false);
  assert.equal(isValidSnapshot({ ...validSnapshot(), execution: { kind: "unavailable" }, model: { available: false, name: null } }), true);
  assert.equal(isValidSnapshot({ ...validSnapshot(), closeError: "internal-storage-error" }), false);
  assert.equal(isValidSnapshot({ ...validSnapshot(), closeError: "settings-save-failed", closeErrorRevision: 1 }), true);
  assert.equal(isValidSnapshot({ ...validSnapshot(), closeError: "settings-save-failed", closeErrorRevision: 0 }), false);
  for (const badRevision of [undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"]) {
    assert.equal(isValidSnapshot({ ...validSnapshot(), closeErrorRevision: badRevision }), false, `bad error identity rejected: ${String(badRevision)}`);
  }
  assert.equal(isValidSnapshot(null), false);
});

test("设置部分更新：合法通路保留，畸形逐项拒绝", () => {
  assert.equal(validateSettingsPatch({ theme: "dark" }), null);
  assert.equal(validateSettingsPatch({ fontSize: 13 }), null);
  assert.equal(validateSettingsPatch({}), null); // 空部分更新合法（无实际变化）
  assert.equal(typeof validateSettingsPatch({ theme: "invalid-theme", language: 42, fontSize: "large" }), "string");
  assert.equal(typeof validateSettingsPatch({ fontSize: 12 }), "string");
  assert.equal(typeof validateSettingsPatch({ fontSize: 17 }), "string");
  assert.equal(typeof validateSettingsPatch({ fontSize: 14.5 }), "string");
  assert.equal(typeof validateSettingsPatch({ unexpected: 1 }), "string");
  assert.equal(typeof validateSettingsPatch("dark"), "string");
});

test("操作载荷校验：白名单 + 逐操作形状", () => {
  assert.equal(validateOperationInput("nonsense", {}), "未知操作: nonsense");
  assert.equal(validateOperationInput("deleteTask", { taskId: "task-readme" }), "未知操作: deleteTask", "永久删除已退出接收协议，不能只藏入口");
  assert.equal(validateOperationInput("sendMessage", { sessionId: "s1", text: "x", mode: "steer" }), null);
  assert.equal(typeof validateOperationInput("sendMessage", { sessionId: "s1", text: "", mode: "steer" }), "string");
  assert.equal(typeof validateOperationInput("sendMessage", { sessionId: "s1", text: "x", mode: "now" }), "string");
  assert.equal(validateOperationInput("getSnapshot", undefined), null);
  assert.equal(typeof validateOperationInput("getSnapshot", {}), "string");
});

test("操作返回契约校验：逐操作核对，畸形返回拒绝", () => {
  assert.equal(isValidOpResponse("getSnapshot", validSnapshot()), true);
  assert.equal(isValidOpResponse("getSnapshot", { bad: true }), false);
  assert.equal(
    isValidOpResponse("sendMessage", {
      sessionId: "s1",
      receipt: { status: "unknown", operationId: "op-1", reason: "storage-unavailable" },
    }),
    true,
  );
  assert.equal(
    isValidOpResponse("sendMessage", {
      sessionId: "s1",
      receipt: { status: "accepted", operationId: "op-1", processing: "everything" },
    }),
    false,
  );
  assert.equal(isValidOpResponse("pauseRun", undefined), true);
  assert.equal(isValidOpResponse("pauseRun", {}), false);
  assert.equal(
    isValidOpResponse("updateSettings", { theme: "dark", fontSize: 14, coldStart: "restore", language: "zh" }),
    true,
  );
  assert.equal(isValidOpResponse("updateSettings", { theme: "dark" }), false); // 返回是全量设置对象
  // 本片新增 configureModel：校验字段必填 / URL http(s) / userinfo 拒绝 / key 语义
  assert.equal(validateOperationInput("configureModel", {
    provider: "openai-completions", label: "x", modelId: "gpt-4o-mini", baseUrl: "https://api.openai.com/v1", keyAction: "replace", apiKey: "k",
  }), null);
  assert.ok(typeof validateOperationInput("configureModel", { provider: "openai-completions", label: "", modelId: "m", baseUrl: "https://x/v1", keyAction: "keep" }) === "string");
  assert.ok(typeof validateOperationInput("configureModel", { provider: "openai-completions", label: "x", modelId: "m", baseUrl: "file:///etc/passwd", keyAction: "keep" }) === "string");
  assert.ok(typeof validateOperationInput("configureModel", { provider: "openai-completions", label: "x", modelId: "m", baseUrl: "https://user:pass@x/v1", keyAction: "keep" }) === "string");
  assert.ok(typeof validateOperationInput("configureModel", { provider: "openai-completions", label: "x", modelId: "m", baseUrl: "https://x/v1", keyAction: "replace" }) === "string");
  assert.ok(typeof validateOperationInput("configureModel", { provider: "other-protocol", label: "x", modelId: "m", baseUrl: "https://x/v1", keyAction: "keep" }) === "string");
  assert.ok(typeof validateOperationInput("configureModel", { provider: "openai-completions", label: "x", modelId: "m", baseUrl: "https://x/v1", keyAction: "keep", apiKey: 42 }) === "string");
  assert.equal(validateOperationInput("bogo-op", { label: "any text" }), "未知操作: bogo-op");
});
