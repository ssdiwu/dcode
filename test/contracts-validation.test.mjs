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
const { validateOperationInput, validateSettingsPatch, isValidSnapshot, isValidOpResponse, isValidAuthEvent, isValidOnlineStatus, isValidSettings, isModelRoutingAttempt, parseWorkImages, OP_NAMES } = await import(
  pathToFileURL(join(dir, "contracts.mjs")).href
);

after(() => rmSync(dir, { recursive: true, force: true }));

test('工作空间绑定有限契约：选择身份和目录回执受校验，界面不能传任意路径', () => {
  const choose = { operationId: 'create-a', requestId: 'choose-a' };
  const create = { operationId: 'create-a', selectionId: 'selection-a', name: '项目甲' };
  for (const operation of ['chooseProjectFolder', 'discardProjectFolder', 'createWorkspace']) assert.ok(OP_NAMES.includes(operation));
  assert.equal(validateOperationInput('chooseProjectFolder', choose), null);
  assert.equal(validateOperationInput('createWorkspace', create), null);
  assert.ok(validateOperationInput('createWorkspace', { ...create, path: '/unselected' }));
  assert.ok(validateOperationInput('chooseProjectFolder', { ...choose, selectionId: 'borrowed' }));
  assert.ok(validateOperationInput('createWorkspace', { ...create, name: '   ' }));
  assert.ok(validateOperationInput('createWorkspace', { ...create, name: 'bad\u0000name' }));
  assert.equal(isValidOpResponse('chooseProjectFolder', null), true);
  assert.equal(isValidOpResponse('chooseProjectFolder', { ...choose, selectionId: 'selection-a', path: '/owned/project' }), true);
  assert.equal(isValidOpResponse('chooseProjectFolder', { ...choose, selectionId: 'selection-a', path: '../relative' }), false);
  assert.equal(isValidOpResponse('chooseProjectFolder', { ...choose, path: '/owned/project' }), false);
});

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
  settings: { theme: "system", fontSize: 14, coldStart: "restore", language: "system", newSessionModelChoice: { mode: "auto" }, modelCandidates: [{ sourceId: "a", modelId: "m" }] },
  model: { available: true, name: "actual-model" },
  modelSetup: { kind: "unconfigured" },
  // D 片：会话模型状态逐条带在快照里；缺字段会被接收侧拒绝（畸形快照静默丢弃）
  sessionModels: {
    // 逐字段齐备：actualResponseId/usage/requests 缺席会被接收侧判为畸形（旧快照直接丢弃）
    s1: {
      sessionId: "s1",
      choice: { mode: "auto" },
      actual: null,
      actualResponseId: null,
      usage: null,
      requests: [],
      thinkingLevel: null,
      lastRouting: null,
      lastResult: "none",
      invalidReason: null,
      waitingExplicitContinue: false,
    },
  },
  // D 片：任务用量是只读汇总，键必须是真实存在的任务 id
  taskUsage: {
    "task-home-default": {
      taskId: "task-home-default",
      scope: [{ sessionId: "s1", kind: "main", usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, requests: 1 } }],
      totals: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, requests: 1 },
      bySource: [{ sourceId: "dcode-test", sourceLabel: "受控来源", usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, requests: 1 } }],
      incompleteReason: null,
    },
  },
  execution: { kind: "pi" },
  closeError: null,
  closeErrorRevision: 0,
});

// D 片路由判定的公开接收：接收侧必须认识**可能出现**的每种 outcome，
// 否则合法判定会在接收侧被当成畸形丢弃（有界尝试的事实就此丢失）。
// 方向要说清：这里证明的是「接收侧认识该形状」，**不是**「router 获准产出该执行策略」。
// `attempted-unverified-capability` 属于历史/合法形状（老现场、其它生产者可能带回），
// 接收侧必须继续认得；但能力缺依据已不是执行许可，router 不再产出它
// （见 model-routing.test.ts：未核实能力保留工作，不借用额度未知的放行规则）。
test("路由判定公开接收：每种 outcome（含历史形状）都被接受，未知 outcome 被拒", () => {
  const outcomes = [
    "adopted",
    "attempted-unknown-quota",
    "attempted-unverified-capability",
    "skipped-exhausted",
    "skipped-incapable",
    "failed",
  ];
  for (const outcome of outcomes) {
    const attempts = [
      { sourceId: "dcode-test", modelId: "fixture", outcome, reason: outcome === "adopted" ? null : "测试原因" },
    ];
    assert.equal(
      isModelRoutingAttempt(attempts[0]),
      true,
      `接收侧必须接受生产端会产出的 outcome：${outcome}`,
    );
  }
  assert.equal(
    isModelRoutingAttempt({ sourceId: "dcode-test", modelId: "fixture", outcome: "not-a-real-outcome", reason: null }),
    false,
    "未知 outcome 仍须被拒（校验不因为补全合法值就放松）",
  );
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
  // 候选名单是 D 片必需字段：缺席＝旧快照，不当作"自动包含目录全部"
  assert.equal(isValidSnapshot({ ...validSnapshot(), settings: { ...validSnapshot().settings, modelCandidates: undefined } }), false);
  assert.equal(isValidSnapshot({ ...validSnapshot(), settings: { ...validSnapshot().settings, modelCandidates: [{ sourceId: "a" }] } }), false);
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
    isValidOpResponse("updateSettings", { theme: "dark", fontSize: 14, coldStart: "restore", language: "zh", newSessionModelChoice: { mode: "auto" }, modelCandidates: [] }),
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


test("供应商专用契约：畸形登录/取消/来源/认证事件不穿过共享边界", () => {
  assert.equal(validateOperationInput("loginProvider", { loginId: "L1", providerId: "openai", type: "api_key" }), null);
  for (const input of [null, { loginId: 1, providerId: "openai", type: "api_key" }, { loginId: "L1", providerId: "openai", type: "wrong" }, { loginId: "L1", providerId: "openai", type: "oauth", extra: true }]) {
    assert.ok(validateOperationInput("loginProvider", input));
  }
  assert.ok(validateOperationInput("cancelLogin", { loginId: 1 }));
  assert.ok(validateOperationInput("replyAuthPrompt", { requestId: "P1", cancel: "yes" }));
  assert.ok(validateOperationInput("setCatalogSource", { baseUrl: "http://remote.example" }));
  assert.equal(isValidOnlineStatus({ online: true }), true);
  assert.equal(isValidOnlineStatus({ online: false }), true);
  for (const input of [{ online: "true" }, { online: true, op: "send" }, [], null]) assert.equal(isValidOnlineStatus(input), false);
  const catalog = { providers: [], models: {}, source: { baseUrl: "https://pi.dev", lastSuccessAt: null, updating: false, lastError: null, revision: 0 } };
  assert.equal(isValidOpResponse("listModelCatalog", catalog), true);
  assert.equal(isValidOpResponse("listModelCatalog", { ...catalog, providers: [{}] }), false);
  assert.equal(isValidOpResponse("listModelCatalog", { ...catalog, models: { openai: [{}] } }), false);
  assert.equal(isValidOpResponse("refreshModelCatalog", { ok: true, revision: "0" }), false);
  assert.equal(isValidOpResponse("loginProvider", { ok: false, issue: 1, message: "bad" }), false);
  assert.equal(isValidAuthEvent({ type: "prompt", loginId: "L1", requestId: "P1", kind: "secret", message: "key" }), true);
  assert.equal(isValidAuthEvent({ type: "auth_url", loginId: "L1", url: "https://auth.example" }), true);
  assert.equal(isValidAuthEvent({ type: "device_code", loginId: "L1", userCode: "AB", verificationUri: "https://auth.example", intervalSeconds: 5 }), true);
  for (const event of [
    { type: "auth_url", loginId: "L1" },
    { type: "auth_url", loginId: "L1", url: "javascript:alert(1)" },
    { type: "device_code", loginId: "L1", userCode: "AB", verificationUri: "https://auth.example", expiresInSeconds: Infinity },
    { type: "prompt", loginId: "L1", requestId: "P1", kind: "select", message: "choose", options: [{ id: 1, label: "bad" }] },
    { type: "progress", loginId: "L1", message: {} },
  ]) assert.equal(isValidAuthEvent(event), false);
});

test("D 片契约：模型入口操作的载荷与回执在共享边界上逐项核对", () => {
  // 载荷：合法形状通过
  assert.equal(validateOperationInput("setSessionModelChoice", { sessionId: "s1", choice: { mode: "auto" } }), null);
  assert.equal(validateOperationInput("setSessionModelChoice", { sessionId: "s1", choice: { mode: "explicit", sourceId: "a", modelId: "m" } }), null);
  assert.equal(validateOperationInput("setSessionThinkingLevel", { sessionId: "s1", level: null }), null);
  assert.equal(validateOperationInput("setSessionThinkingLevel", { sessionId: "s1", level: "xhigh" }), null);
  assert.equal(validateOperationInput("readModelQuota", { sourceId: "a", modelId: "m" }), null);
  assert.equal(validateOperationInput("resolveSessionRouting", { sessionId: "s1" }), null);
  assert.equal(validateOperationInput("setDefaultModelChoice", { choice: { mode: "auto" } }), null);
  assert.equal(validateOperationInput("listModelSources", undefined), null);
  assert.equal(validateOperationInput("listModelSources", { sessionId: "s1" }), null);

  // 载荷：畸形一律在入口拒绝，不建对象、不接收、不执行
  for (const input of [
    null, {}, [], "x",
    { sessionId: "", choice: { mode: "auto" } },
    { sessionId: "s1" },
    { sessionId: "s1", choice: { mode: "explicit", sourceId: "a" } },
    { sessionId: "s1", choice: { mode: "manual", sourceId: "a", modelId: "m" } },
    { sessionId: "s1", choice: { mode: "auto" }, extra: 1 },
  ]) assert.ok(validateOperationInput("setSessionModelChoice", input), `setSessionModelChoice 应拒绝 ${JSON.stringify(input)}`);

  assert.ok(validateOperationInput("setSessionThinkingLevel", { sessionId: "s1", level: "ultra" }));
  assert.ok(validateOperationInput("setSessionThinkingLevel", { sessionId: "s1", level: 3 }));
  assert.ok(validateOperationInput("readModelQuota", { sourceId: "a" }));
  assert.ok(validateOperationInput("readModelQuota", { sourceId: "", modelId: "m" }));
  assert.ok(validateOperationInput("resolveSessionRouting", { sessionId: 1 }));
  assert.ok(validateOperationInput("setDefaultModelChoice", { choice: "auto" }));
  assert.ok(validateOperationInput("listModelSources", { sessionId: 5 }));

  // 设置里的新会话默认：合法枚举通过，未知设置项仍拒绝
  assert.equal(validateSettingsPatch({ newSessionModelChoice: { mode: "auto" } }), null);
  assert.ok(validateSettingsPatch({ newSessionModelChoice: { mode: "nope" } }));
  assert.ok(validateSettingsPatch({ newSessionModelChoice: "auto" }));
  assert.ok(validateSettingsPatch({ unknownKey: 1 }));
});

test("D 片契约：额度、模型状态与来源视图的接收侧校验", () => {
  const quota = { sourceId: "a", modelId: "m", state: "available", poolId: null, windowLabel: null, updatedAt: 1, reason: null };
  assert.equal(isValidOpResponse("readModelQuota", quota), true);
  // 「可用」必须带更新时间与可核对来源，否则无可核对的依据
  assert.equal(isValidOpResponse("readModelQuota", { ...quota, updatedAt: null }), false);
  assert.equal(isValidOpResponse("readModelQuota", { ...quota, reason: "x" }), false);
  assert.equal(isValidOpResponse("readModelQuota", { ...quota, state: "unsupported", updatedAt: null, reason: "no-source" }), true);
  assert.equal(isValidOpResponse("readModelQuota", { ...quota, state: "zero" }), false);
  assert.equal(isValidOpResponse("readModelQuota", { ...quota, poolId: 1 }), false);

  const state = {
    sessionId: "s1",
    choice: { mode: "auto" },
    actual: null,
    actualResponseId: null,
    usage: null,
    requests: [],
    thinkingLevel: null,
    lastRouting: null,
    lastResult: "none",
    invalidReason: null,
    waitingExplicitContinue: false,
  };
  assert.equal(isValidOpResponse("resolveSessionRouting", state), true);
  assert.equal(isValidOpResponse("setSessionModelChoice", { ...state, lastResult: "maybe" }), false);
  assert.equal(isValidOpResponse("setSessionModelChoice", { ...state, thinkingLevel: "ultra" }), false);
  assert.equal(isValidOpResponse("setSessionThinkingLevel", { ...state, actual: { sourceId: "a" } }), false);
  // 判定成立不等于请求成功：这两条分别可辨。实际采用必须同时带可核对的响应身份，
  // 否则"有 actual"仍不能证明发生过真实请求。
  const actuallyUsed = { ...state, actual: { sourceId: "a", modelId: "m", sourceLabel: "A", modelLabel: "M", accountLabel: null }, actualResponseId: "resp-1", lastResult: "failed" };
  assert.equal(isValidOpResponse("resolveSessionRouting", actuallyUsed), true);
  assert.equal(isValidOpResponse("resolveSessionRouting", { ...actuallyUsed, actualResponseId: null }), false);

  assert.equal(isValidOpResponse("setDefaultModelChoice", { ok: true, choice: { mode: "auto" } }), true);
  assert.equal(isValidOpResponse("setDefaultModelChoice", { ok: false, choice: "auto" }), false);

  const sources = {
    sources: [{ sourceId: "a", sourceLabel: "A", configured: true, models: [{ sourceId: "a", modelId: "m", modelLabel: "M", capabilities: null, quota: null }] }],
    defaultChoice: { mode: "auto" },
    sessionStates: [state],
  };
  assert.equal(isValidOpResponse("listModelSources", sources), true);
  // 未核实能力资料必须是 null 或合法形状；额度未读取必须是 null（不假报可用）
  assert.equal(isValidOpResponse("listModelSources", { ...sources, sources: [{ ...sources.sources[0], models: [{ ...sources.sources[0].models[0], quota: { ...quota, updatedAt: null } }] }] }), false);
  assert.equal(isValidOpResponse("listModelSources", { ...sources, sources: [{ ...sources.sources[0], models: [{ ...sources.sources[0].models[0], capabilities: { identity: {} } }] }] }), false);
  assert.equal(isValidOpResponse("listModelSources", { ...sources, defaultChoice: { mode: "manual" } }), false);
  assert.equal(isValidOpResponse("listModelSources", { ...sources, sessionStates: [{ ...state, choice: {} }] }), false);

  // 逐次真实请求归属：同一 responseId 不得重复出现，否则同一事实会被重复计量
  const attributed = { ...state, actual: { sourceId: "a", modelId: "m", sourceLabel: "A", modelLabel: "M", accountLabel: null }, actualResponseId: "resp-1", requests: [{ responseId: "resp-1", sourceId: "a", sourceLabel: "A", modelId: "m", result: "succeeded", usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, requests: 1 } }] };
  assert.equal(isValidOpResponse("resolveSessionRouting", attributed), true);
  assert.equal(isValidOpResponse("resolveSessionRouting", { ...attributed, requests: [...attributed.requests, { ...attributed.requests[0] }] }), false);
  assert.equal(isValidOpResponse("resolveSessionRouting", { ...attributed, requests: [{ ...attributed.requests[0], responseId: "" }] }), false);
  assert.equal(isValidOpResponse("resolveSessionRouting", { ...attributed, requests: [{ ...attributed.requests[0], result: "pending" }] }), false);
  // actual 存在但没有响应身份 → 不是一次可核对的真实请求
  assert.equal(isValidOpResponse("resolveSessionRouting", { ...attributed, actualResponseId: null }), false);
});

test("D 片契约：任务用量汇总逐项核对，挂错任务或补零都被拒", () => {
  const summary = validSnapshot().taskUsage["task-home-default"];
  assert.equal(isValidSnapshot(validSnapshot()), true);
  // 汇总键与自身 taskId 不一致（挂错任务）
  assert.equal(isValidSnapshot({ ...validSnapshot(), taskUsage: { other: { ...summary, taskId: "other" } } }), false);
  // 汇总指向不存在的任务
  assert.equal(isValidSnapshot({ ...validSnapshot(), taskUsage: { "task-x": { ...summary, taskId: "task-x" } } }), false);
  // 没有可归属记录时不得按来源给出数字（不补零）
  assert.equal(
    isValidSnapshot({ ...validSnapshot(), taskUsage: { "task-home-default": { ...summary, totals: null, bySource: summary.bySource } } }),
    false,
  );
  // 无记录 = null 合法
  assert.equal(
    isValidSnapshot({ ...validSnapshot(), taskUsage: { "task-home-default": { ...summary, totals: null, bySource: [] } } }),
    true,
  );
  // 计量范围成员类型必须是 main/sub
  assert.equal(
    isValidSnapshot({ ...validSnapshot(), taskUsage: { "task-home-default": { ...summary, scope: [{ ...summary.scope[0], kind: "other" }] } } }),
    false,
  );
  // 缺口说明必须是真的字符串或 null
  assert.equal(isValidSnapshot({ ...validSnapshot(), taskUsage: { "task-home-default": { ...summary, incompleteReason: 3 } } }), false);
});

test("D 片契约：快照里的会话模型状态逐条核对", () => {
  const valid = {
    sessionId: "s1", choice: { mode: "auto" }, actual: null,
    thinkingLevel: null, lastRouting: null, lastResult: "none", invalidReason: null,
  };
  // 快照缺 sessionModels 会被接收侧拒绝（畸形快照静默丢弃，渲染层保留上一份）
  assert.ok(OP_NAMES.includes("setSessionModelChoice"));
  assert.ok(OP_NAMES.includes("listModelSources"));
  assert.ok(OP_NAMES.includes("readModelQuota"));
  assert.ok(OP_NAMES.includes("resolveSessionRouting"));
  assert.ok(OP_NAMES.includes("setSessionThinkingLevel"));
  assert.ok(OP_NAMES.includes("setDefaultModelChoice"));
  assert.equal(isValidSettings({ theme: "system", fontSize: 14, coldStart: "restore", language: "system", newSessionModelChoice: { mode: "auto" }, modelCandidates: [] }), true);
  // 候选名单是必需字段：缺席（=旧设置）不是"自动包含目录全部"
  assert.equal(isValidSettings({ theme: "system", fontSize: 14, coldStart: "restore", language: "system", newSessionModelChoice: { mode: "auto" } }), false);
  assert.equal(isValidSettings({ theme: "system", fontSize: 14, coldStart: "restore", language: "system" }), false);
  assert.equal(isValidSettings({ theme: "system", fontSize: 14, coldStart: "restore", language: "system", newSessionModelChoice: { mode: "x" } }), false);
  assert.ok(valid);
});


test('待核工作空间快照：原创建身份、名称和绝对目录可读，畸形投影被拒绝', () => {
  const snapshot = validSnapshot();
  const intent = { operationId: 'original-create', selectionId: 'original-selection', name: '待核项目', path: '/owned/project' };
  assert.equal(isValidSnapshot({ ...snapshot, pendingWorkspaceCreation: intent }), true);
  for (const patch of [{ operationId: '' }, { selectionId: null }, { name: 'bad\u0000name' }, { path: '../unselected' }])
    assert.equal(isValidSnapshot({ ...snapshot, pendingWorkspaceCreation: { ...intent, ...patch } }), false);
  assert.equal(isValidSnapshot({ ...snapshot, pendingWorkspaceCreation: null }), true);
});

test('扩展消息／工具图片有限契约：独立来源与有限图片字段，不接任意URL／字段或畸形内容',()=>{
  const s=validSnapshot();s.timelines.s1.push({kind:'extension-message',id:'extension-1',customType:'project-result',text:'真实项目扩展正文',at:5});
  const image={type:'image',mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9YAAAAASUVORK5CYII='};s.timelines.s1[1].tool.images=[image];
  assert.equal(isValidSnapshot(s),true);assert.deepEqual(parseWorkImages([image]),[image]);
  for(const customType of ['',null,'x'.repeat(129)]){const invalid=structuredClone(s);invalid.timelines.s1.at(-1).customType=customType;assert.equal(isValidSnapshot(invalid),false);}
  for(const invalid of [{...image,data:'not base64?'},{...image,mimeType:'text/html'},{...image,url:'file:///outside'},...Array.from({length:1},()=>[image,image,image,image,image])]){
    assert.throws(()=>parseWorkImages(Array.isArray(invalid)?invalid:[invalid]));
  }
  const invalid=structuredClone(s);invalid.timelines.s1[1].tool.images=[{...image,data:'bad'}];assert.equal(isValidSnapshot(invalid),false);
});

test('运行工具截断量只接收有限非负整数，原正文与工具状态保持独立', () => {
  const snapshot = validSnapshot();
  const tool = snapshot.timelines.s1[1].tool;
  tool.status = 'running';
  tool.outputTruncation = { droppedBytes: 123, droppedLines: 2 };
  assert.equal(isValidSnapshot(snapshot), true);
  assert.equal(tool.output, '……');
  for (const invalid of [null, { droppedBytes: -1, droppedLines: 2 }, { droppedBytes: 1.5, droppedLines: 2 },
    { droppedBytes: 1, droppedLines: NaN }, { droppedBytes: 1 }, { droppedBytes: '1', droppedLines: 2 }]) {
    const bad = structuredClone(snapshot); bad.timelines.s1[1].tool.outputTruncation = invalid;
    assert.equal(isValidSnapshot(bad), false);
  }
});
