// D 片真实全链端到端：会话模型选择 → 保存 → **真实发送** → 精确请求/参数/输出 →
// 实际归属与用量 → 改选 / 暂停 / 明确继续。
//
// 与 mock 套件分开报告：本文件走 **真实 Pi Durable + 受控模型**（不连真实服务商）。
// 证据不取自界面自述：
//  · 模型入口与设置经**真实点击**操作；
//  · 实际发给谁用了什么档位，取自受控装配写下的**真实请求记录**（provider/modelId/thinkingLevel）
//    与 Pi 助手条目里的 responseId；
//  · 用量取自真实请求记录的 usage，不做本地推算；
//  · 改选后当前正在输出的请求不被中止，下一次真实请求才用新模型。
//
// 状态目录与演示目录都在本次运行的独立临时根里，不碰真实 profile/Home/凭据。

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchApp, ready, waitForSnapshot, gotoSession } from "./helpers.mjs";
import { evidenceDir } from "./evidence-root.mjs";

const evidence = evidenceDir("session-model-request");

/** 读取受控装配写下的**真实请求记录**（含实际 provider/modelId/thinkingLevel 与用户正文）。 */
function readRequests(demoDir) {
  const log = join(demoDir, "model-requests.jsonl");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/** 进设置页的模型区：真实点击路径，不走桥调用。 */
async function openSettingsModelSection(page) {
  await page.locator("nav").getByRole("button", { name: /设置|Settings/ }).click();
  await page.locator(".w-44").getByRole("button", { name: /模型|Model/ }).click();
  await page.getByTestId("settings-candidates").waitFor({ state: "visible", timeout: 15_000 });
}

/** 勾选一个候选（真实点复选框），返回当前已勾选数量（读界面上的计数文本）。 */
async function toggleCandidate(page, sourceId, modelId) {
  const box = page.getByTestId(`candidate-${sourceId}-${modelId}`);
  await box.waitFor({ state: "visible", timeout: 15_000 });
  await box.click();
  await page.waitForTimeout(250);
  const text = await page.getByTestId("settings-candidates-count").innerText();
  const matched = /(\d+)/.exec(text);
  return matched ? Number(matched[1]) : -1;
}

/** 唯一主运行按钮（发送／暂停／继续互斥）：按真实可访问名称点击，不走桥。 */
async function clickPrimary(page, name) {
  const button = page.locator('button[data-slot="composer-primary"]');
  await button.waitFor({ state: "visible", timeout: 30_000 });
  await button.click();
  await page.waitForFunction(
    (want) => document.querySelector('button[data-slot="composer-primary"]')?.getAttribute("aria-label") !== want,
    name,
    { timeout: 30_000 },
  );
}

async function openModelEntry(page) {
  const trigger = page.getByTestId("model-entry-trigger");
  await trigger.waitFor({ state: "visible", timeout: 30_000 });
  await trigger.click();
  await page.getByTestId("model-search").waitFor({ state: "visible", timeout: 15_000 });
}

/**
 * 运行中改选：**下一次真实 SDK 请求**就用新来源（不是等到下一次发送才生效）。
 *
 * 受控模型的第 0 次请求会发一个真实工具调用，Pi 随后自动发出后续请求——
 * 门控把后续请求挂起，于是"改选发生在运行中、请求还没发出去"这个窗口是可复现的：
 * 改选后放开门控，那条被挂起的后续请求必须记在**新来源**名下，
 * 且第 0 次请求的归属保持原样（历史不被改写）。
 */
await test("D 片运行中改选：下一次真实 SDK 请求就用新来源", async () => {
  const root = mkdtempSync(join(tmpdir(), "dcode-session-model-midrun-"));
  const demoDir = join(root, "demo-work");
  mkdirSync(demoDir, { recursive: true });
  // 第二轮工具回合：第 2 个请求先挂起再发工具调用，于是"运行中改选"落在可复现窗口里
  const env = {
    DCODE_VALIDATION_ASSEMBLY: "pi-controlled",
    DCODE_DEMO_DIR: demoDir,
    DCODE_PI_GATE: "1",
    DCODE_E2E_SECOND_TOOL_ROUND: "1",
  };
  let handle = null;
  try {
    handle = await launchApp(join(root, "state"), env);
    const { page } = handle;
    await ready(page);
    assert.equal((await page.evaluate(() => window.dcode.getSnapshot())).execution?.kind, "pi");

    // 两个受控来源都进候选名单（范围依据唯一来自用户配置）
    await openSettingsModelSection(page);
    assert.equal(await toggleCandidate(page, "dcode-test", "fixture"), 1);
    assert.equal(await toggleCandidate(page, "dcode-test-b", "fixture-b"), 2);
    await page.keyboard.press("Escape");

    const session = await page.evaluate(async () => {
      const snap = await window.dcode.getSnapshot();
      return window.dcode.createSession({ taskId: snap.tasks[0].id });
    });
    await gotoSession(page, session.id);

    // 显式选定来源 A 并发第一条输入：第 0 次真实请求归 A，随后 Pi 的工具回合请求被门控挂起
    await openModelEntry(page);
    await page.locator('[data-testid="model-item-dcode-test-fixture"]').first().click();
    await page.waitForTimeout(200);
    const composer = page.getByPlaceholder(/交代需求、提问或粘贴内容|写下需求|追问、补充或纠正/).first();
    const firstText = `运行中改选的第一条-${crypto.randomUUID()}`;
    await composer.fill(firstText);
    await composer.press("Enter");

    let before = [];
    for (let i = 0; i < 400; i += 1) {
      before = readRequests(demoDir);
      if (before.length >= 1) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(before.length >= 1, "第一次真实请求应已发生");
    assert.equal(before[0].provider, "dcode-test", "第一次请求应发给显式选定的来源 A");
    assert.ok(before[0].userContent.includes(firstText));

    // 等到第 2 个请求已发起并在门控处挂起：此刻"改选"与"下一次请求发出"之间有真实窗口
    let heldBefore = [];
    for (let i = 0; i < 600; i += 1) {
      heldBefore = readRequests(demoDir);
      if (heldBefore.length >= 2) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(heldBefore.length >= 2, `第 2 个请求应已发起并挂起（实读 ${heldBefore.length} 条）`);
    assert.equal(heldBefore[1].provider, "dcode-test", "挂起的那次请求仍属来源 A");
    await waitForSnapshot(page, (st, id) => st.runs[id]?.status === "running", session.id, "第一次请求后运行中");
    const countBeforeChoice = readRequests(demoDir).length;

    // 运行中经界面改选到 B，并为 B 选一个已核实档位
    await openModelEntry(page);
    await page.getByTestId("model-search").fill("fixture-b");
    await page.locator('[data-testid="model-item-dcode-test-b-fixture-b"]').first().click();
    await page.waitForTimeout(200);
    await page.keyboard.press("Escape");
    // 选中模型后菜单收起；重新打开入口才有该来源的档位区（与全链用例同一交互顺序）
    await openModelEntry(page);
    await page.getByTestId("model-level-high").waitFor({ state: "visible", timeout: 15_000 });
    await page.getByTestId("model-level-high").click();
    await page.keyboard.press("Escape");
    const chosenMid = await page.evaluate(async (id) => (await window.dcode.getSnapshot()).sessionModels[id], session.id);
    assert.equal(chosenMid.choice.sourceId, "dcode-test-b", "改选落在来源 B");
    assert.equal(chosenMid.thinkingLevel, "high", "档位选择写入会话状态");
    // 改选这一刻还没有新请求发出（挂起的那次已经在途）
    assert.equal(readRequests(demoDir).length, countBeforeChoice, "改选本身不发模型请求");
    assert.ok(
      readRequests(demoDir).every((r) => r.provider === "dcode-test"),
      "改选不得改写已经发出的请求归属",
    );

    // 放开门控：被挂起的后续请求发出时必须用新来源
    writeFileSync(join(demoDir, ".answer-gate"), "open");
    let after = [];
    for (let i = 0; i < 600; i += 1) {
      after = readRequests(demoDir);
      if (after.slice(countBeforeChoice).some((r) => r.provider === "dcode-test-b")) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const switched = after.slice(countBeforeChoice).find((r) => r.provider === "dcode-test-b");
    assert.ok(switched, `运行中改选后，下一次真实请求必须发给来源 B（实读：${JSON.stringify(after.map((r) => r.provider))}）`);
    assert.equal(switched.modelId, "fixture-b");
    assert.equal(switched.thinkingLevel, "high", "运行中改选的档位也要进这条真实请求");
    assert.ok(
      switched.userContent.includes(firstText),
      "这条请求仍是本轮工作的延续（工具回合），正文应含本轮输入",
    );
    assert.equal(before[0].provider, "dcode-test", "先前那次请求的归属不被改写");

    // 归属按逐次记录保留：先有 A 的那次，再有 B 的这次
    const settled = await waitForSnapshot(
      page,
      (st, id) => st.sessionModels[id]?.requests?.some((r) => r.sourceId === "dcode-test-b"),
      session.id,
      "改选后的真实请求归属应记在来源 B",
    );
    const requests = settled.sessionModels[session.id].requests;
    assert.ok(
      requests.some((r) => r.sourceId === "dcode-test") && requests.some((r) => r.sourceId === "dcode-test-b"),
      "两个来源的逐次归属都要在账上",
    );
    console.log("[d-session-model-midrun]", JSON.stringify({
      firstProvider: before[0].provider,
      switched: { provider: switched.provider, modelId: switched.modelId, thinkingLevel: switched.thinkingLevel },
      requests: requests.map((r) => `${r.sourceId}/${r.responseId}`),
    }));
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
});

test("D 片全链：选择→保存→真实发送→精确请求/参数/输出→改选/暂停/继续", async () => {
  const root = mkdtempSync(join(tmpdir(), "dcode-session-model-"));
  const demoDir = join(root, "demo-work");
  mkdirSync(demoDir, { recursive: true });
  const stateDir = join(root, "state");
  // pi-controlled 装配：真实 Pi Durable + 受控模型；门控让第 2 次起的请求在放行前保持挂起。
  const env = { DCODE_VALIDATION_ASSEMBLY: "pi-controlled", DCODE_DEMO_DIR: demoDir, DCODE_PI_GATE: "1" };

  let handle = null;
  const steps = [];
  try {
    handle = await launchApp(stateDir, env);
    const { page } = handle;
    await ready(page);
    const snap0 = await page.evaluate(() => window.dcode.getSnapshot());
    assert.equal(snap0.execution?.kind, "pi", "装配必须是真实 Pi 执行端");

    // ---- 1. 在**界面**上把受控模型配进候选名单（自动路由的唯一范围依据） ----
    await openSettingsModelSection(page);
    // 诊断用：把面板当前渲染内容取出来，失败时能直接看出是没加载还是没渲染条目
    const panelText = await page.getByTestId("settings-candidates").innerText();
    assert.ok(panelText.length > 0, "候选面板应有内容");
    const afterFirst = await toggleCandidate(page, "dcode-test", "fixture");
    assert.equal(afterFirst, 1, "界面上勾选后候选计数应为 1");
    const afterSecond = await toggleCandidate(page, "dcode-test-b", "fixture-b");
    assert.equal(afterSecond, 2, "两个受控来源都进入候选范围");
    const saved = await page.evaluate(async () => window.dcode.getSnapshot());
    const candidates = saved.settings.modelCandidates;
    assert.ok(candidates.some((c) => c.sourceId === "dcode-test" && c.modelId === "fixture"), "候选名单应已保存");
    assert.ok(candidates.some((c) => c.sourceId === "dcode-test-b" && c.modelId === "fixture-b"), "第二来源也在名单内");
    // 回到工作区
    await page.keyboard.press("Escape");
    steps.push({ phase: "candidate-list-saved", count: candidates.length });

    // ---- 2. 建会话并固定初值（改设置默认不再影响它） ----
    const session = await page.evaluate(async () => {
      const snap = await window.dcode.getSnapshot();
      return window.dcode.createSession({ taskId: snap.tasks[0].id });
    });
    await gotoSession(page, session.id);
    await openModelEntry(page);
    // 先切到自动，明确"选择只作用于后续请求"，并让入口呈现实际采用
    await page.getByTestId("model-choice-auto").waitFor({ state: "visible", timeout: 15_000 });
    await page.keyboard.press("Escape");
    steps.push({ phase: "session-created", sessionId: session.id });

    // ---- 3. **真实发送**：UI 输入 → Enter → 正式接收 → 真实 Pi 请求 ----
    // 正文带一次性随机串：证明"这次请求带的是这次输入"，而不是重放固定样本
    const text = `请处理这段输入-${crypto.randomUUID()}`;
    // 输入框占位随视图切换（草稿 → 时间线追问）：两种都要能取到
    const composer = page.getByPlaceholder(/交代需求、提问或粘贴内容|写下需求|追问、补充或纠正/).first();
    await composer.fill(text);
    await composer.press("Enter");
    await page.getByText("已接收", { exact: true }).first().waitFor({ timeout: 30_000 });

    // 精确请求证据：真实请求记录里必须有这次 provider/modelId 与用户正文
    await waitForSnapshot(
      page,
      () => true,
      undefined,
      "unused",
    );
    let requests = [];
    for (let i = 0; i < 200; i += 1) {
      requests = readRequests(demoDir);
      if (requests.length >= 1) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(requests.length >= 1, "应当有一次真实模型请求");
    const first = requests[0];
    assert.equal(first.provider, "dcode-test", "真实请求确实发给了配置的来源");
    assert.equal(first.modelId, "fixture");
    assert.ok(first.userContent, "请求记录里必须带真实用户正文");
    assert.ok(
      String(first.userContent).includes(text),
      `本次请求带的应是本次输入正文（实读：${String(first.userContent).slice(0, 60)}）`,
    );
    assert.equal(first.thinkingLevel ?? null, null, "还没设档位时不带条件参数（用模型默认档位）");
    // 界面 DOM：请求还在生成时，入口必须说「尚未确定实际使用的模型 · 请求中」，
    // 不能提前宣布已经用了某个模型（实际采用只由真实应答发布）。
    await openModelEntry(page);
    const duringLine = await page.getByTestId("model-actual").innerText();
    assert.match(duringLine, /尚未确定实际使用的模型/, `生成中不得宣布实际采用（实读：${duringLine}）`);
    assert.match(duringLine, /请求中/, `生成中要如实呈现请求状态（实读：${duringLine}）`);
    await page.keyboard.press("Escape");
    steps.push({
      phase: "real-request",
      request: { provider: first.provider, modelId: first.modelId, thinkingLevel: first.thinkingLevel ?? null },
      duringLine,
    });

    // ---- 4. 实际归属与用量由真实请求事件发布（不是计划值） ----
    const afterRequest = await waitForSnapshot(
      page,
      (s, id) => s.sessionModels[id]?.actual != null,
      session.id,
      "真实请求后应发布实际采用的模型",
    );
    const used = afterRequest.sessionModels[session.id];
    assert.equal(used.actual.modelId, "fixture", "实际采用应等于真实请求的模型");
    assert.ok(used.actualResponseId, "实际采用必须带可核对的响应标识");
    assert.equal(used.lastResult, "succeeded", "这次真实请求已完成");
    assert.ok(used.usage && used.usage.requests >= 1, "用量取自真实请求记录");
    assert.ok(used.usage.input >= 1 && used.usage.output >= 1, "用量应带真实 token 数");
    // 逐次归属与累计对账：请求条数、responseId 不重复
    assert.ok(used.requests.length >= 1, "逐次真实请求归属应入账");
    assert.equal(
      new Set(used.requests.map((r) => r.responseId)).size,
      used.requests.length,
      "同一 responseId 不得重复计量",
    );
    assert.equal(
      used.requests.reduce((sum, r) => sum + (r.usage?.requests ?? 0), 0),
      used.usage.requests,
      "累计用量必须等于逐次请求之和",
    );
    steps.push({
      phase: "actual-attribution",
      actual: { sourceId: used.actual.sourceId, modelId: used.actual.modelId },
      responseId: used.actualResponseId,
      usage: used.usage,
      requests: used.requests.length,
    });

    // ---- 4b. 任务用量汇总：只读、按归属聚合、界面可见 ----
    const taskId = session.taskId;
    const taskSummary = afterRequest.taskUsage[taskId];
    assert.ok(taskSummary, "任务用量汇总应存在");
    assert.equal(taskSummary.taskId, taskId, "汇总只挂在本任务上");
    assert.ok(
      taskSummary.scope.some((s) => s.sessionId === session.id),
      "计量范围应含当前会话",
    );
    assert.equal(taskSummary.totals.requests, used.usage.requests, "任务合计与本会话真实记录对账一致");
    assert.ok(
      taskSummary.bySource.some((s) => s.sourceId === used.actual.sourceId && s.usage.requests >= 1),
      "按实际来源分开呈现，不用虚拟模型名猜账户",
    );
    // 界面呈现：模型入口里能看到本会话与本任务用量，并可展开计量范围
    const beforeUi = await page.evaluate(async () => window.dcode.getSnapshot());
    await openModelEntry(page);
    const sessionUsageText = await page.getByTestId("model-usage-session").innerText();
    const taskUsageText = await page.getByTestId("model-usage-task").innerText();
    assert.ok(
      beforeUi.sessionModels[session.id].usage,
      `界面读到会话用量前，快照里应已有真实用量（此刻为 ${JSON.stringify(beforeUi.sessionModels[session.id].usage)}）`,
    );
    assert.match(sessionUsageText, /\d+/, `界面应显示本次会话的真实用量数字（实读：${sessionUsageText}）`);
    assert.match(taskUsageText, /\d+/, `界面应显示本任务的真实用量数字（实读：${taskUsageText}）`);
    await page.getByTestId("model-usage-scope-toggle").click();
    await page.getByTestId(`model-usage-scope-${session.id}`).waitFor({ timeout: 5_000 });
    // 收掉入口：后面的改选步骤要重新打开（openModelEntry 是切换语义）
    await page.keyboard.press("Escape");
    steps.push({
      phase: "task-usage",
      totals: taskSummary.totals,
      sources: taskSummary.bySource.map((s) => ({ sourceId: s.sourceId, requests: s.usage.requests })),
    });

    // ---- 5. 改选到**第二个受控来源**：只作用于后续请求，当前请求归属不变 ----
    // 候选名单先把 B 也纳入（自动与手动都只在这份名单范围内选）。
    await openModelEntry(page);
    await page.getByTestId("model-search").fill("fixture-b");
    const itemB = page.locator('[data-testid="model-item-dcode-test-b-fixture-b"]');
    await itemB.first().waitFor({ state: "visible", timeout: 10_000 });
    await itemB.first().click();
    await page.waitForTimeout(200);
    const afterChoice = await page.evaluate(async () => window.dcode.getSnapshot());
    const chosen = afterChoice.sessionModels[session.id];
    assert.ok(chosen, "改选后状态应存在");
    assert.equal(chosen.choice.mode, "explicit", "改选应是显式选择");
    assert.equal(chosen.choice.sourceId, "dcode-test-b", "选择必须落在第二个受控来源上");
    // 界面 DOM：改选后「本次实际采用」仍指上一次真实应答的来源 A（选择行显示 B）
    await openModelEntry(page);
    const actualAfterChoice = await page.getByTestId("model-actual").innerText();
    assert.match(actualAfterChoice, /受控来源 A/, `实际采用仍应显示来源 A（实读：${actualAfterChoice}）`);
    assert.match(actualAfterChoice, /fixture/, `实际采用的模型应显示为 fixture（实读：${actualAfterChoice}）`);
    const choiceLine = await page.getByTestId("model-choice-explicit").innerText();
    assert.match(choiceLine, /受控来源 B/, `选择行应显示新选的来源 B（实读：${choiceLine}）`);
    steps.push({ phase: "actual-unchanged-after-choice", actual: actualAfterChoice, choice: choiceLine });
    // 已发生的请求归属不被改写
    assert.equal(chosen.actual?.sourceId, "dcode-test", "改选不得把已发生请求的归属改写成新来源");
    assert.equal(chosen.actual?.modelId, "fixture");
    assert.ok(chosen.actualResponseId, "改选不得抹掉已有请求的真实响应身份");
    steps.push({ phase: "choice-changed", chosen: chosen.choice, actualKept: chosen.actual?.sourceId });
    await page.keyboard.press("Escape");

    // ---- 5a2. 在界面上为新来源选一个**已核实的条件参数档位** ----
    await openModelEntry(page);
    await page.getByTestId("model-level-high").waitFor({ state: "visible", timeout: 15_000 });
    await page.getByTestId("model-level-high").click();
    await page.waitForTimeout(250);
    const levelPicked = await page.evaluate(async (id) => {
      const snap = await window.dcode.getSnapshot();
      return snap.sessionModels[id]?.thinkingLevel ?? null;
    }, session.id);
    assert.equal(levelPicked, "high", "档位选择写入会话状态");
    await page.keyboard.press("Escape");

    // ---- 6. 暂停：改选/暂停不唤醒，也不改动已发生请求的历史归属 ----
    // 基线取**暂停调用前一刻**：真实 Pi 的工具回合会在第一次请求之后再发一次请求，
    // 拿更早的计数当基线会把正常工具回合误判成"暂停发了请求"。
    const beforePause = readRequests(demoDir).length;
    const attributionBeforePause = (await page.evaluate(async () => window.dcode.getSnapshot())).sessionModels[session.id];
    // 真实点主按钮暂停（不调桥）
    await clickPrimary(page, "暂停");
    const paused = await waitForSnapshot(
      page,
      (s, id) => s.runs[id]?.status === "paused",
      session.id,
      "暂停应收束为真实状态",
    );
    assert.ok(readRequests(demoDir).length === beforePause, "暂停本身不发模型请求");
    // 与暂停前那一刻对比（此时实际采用已经是来源 B）：暂停既不改写归属，也不回退到更旧的请求
    assert.deepEqual(
      paused.sessionModels[session.id].actual,
      attributionBeforePause.actual,
      "暂停不得改写已发生请求的归属",
    );
    assert.equal(
      paused.sessionModels[session.id].actualResponseId,
      attributionBeforePause.actualResponseId,
      "暂停不得抹掉已发生请求的响应身份",
    );
    steps.push({ phase: "paused", requestsAfter: readRequests(demoDir).length });

    // ---- 6b. 暂停期间做选模与额度读取：不唤醒、不发请求，判定按真实运行状态给 ----
    const whilePaused = readRequests(demoDir).length;
    const quotaWhilePaused = await page.evaluate(
      async (id) => window.dcode.readModelQuota({ sessionId: id, sourceId: "dcode-test", modelId: "fixture" }),
      session.id,
    );
    const routingWhilePaused = await page.evaluate(
      async (id) => window.dcode.resolveSessionRouting({ sessionId: id }),
      session.id,
    );
    const afterPausedProbes = await page.evaluate(async () => window.dcode.getSnapshot());
    assert.equal(afterPausedProbes.runs[session.id].status, "paused", "选模与额度读取不得把暂停中的工作唤醒");
    assert.ok(readRequests(demoDir).length === whilePaused, "选模与额度读取本身不发模型请求");
    assert.ok(quotaWhilePaused, "暂停期间额度读取仍返回真实结果");
    assert.equal(
      routingWhilePaused.lastRouting?.decision.kind,
      "hold-work-not-runnable",
      "暂停中的工作不得被判为可采用",
    );
    assert.equal(routingWhilePaused.waitingExplicitContinue, false, "暂停本身不是全部耗尽等待");
    steps.push({
      phase: "paused-probes",
      quota: quotaWhilePaused.status,
      decision: routingWhilePaused.lastRouting?.decision.kind,
    });

    // ---- 7. 明确继续：真实点主按钮恢复，且不带入被暂停前的在途输入 ----
    await clickPrimary(page, "继续执行");
    const resumed = await waitForSnapshot(
      page,
      (s, id) => s.runs[id]?.status === "ready" || s.runs[id]?.status === "running",
      session.id,
      "显式继续应恢复为可推进状态",
    );
    assert.equal(resumed.runs[session.id].status !== "paused", true);
    steps.push({ phase: "resumed", status: resumed.runs[session.id].status });

    // ---- 8. 恢复之后：下一次**真实请求**才用新来源，且带上界面选的档位 ----
    // 先放开门控让来源 A 的在途回合收束（那几次请求本来就属于 A），
    // 等运行回到可推进状态再发第二次输入——否则测到的是"在途请求被打断"，不是"后续请求用新来源"。
    writeFileSync(join(demoDir, ".answer-gate"), "open");
    await waitForSnapshot(
      page,
      (s, id) => s.runs[id]?.status !== "running",
      session.id,
      "门控放开后本轮应收束",
    );
    // 来源 A 的回复此时才真正产生（门控放开前模型还没应答）：
    // 界面上的回复必须带**这一轮**的随机正文，证明回复与本次请求闭环，而不是固定文案。
    const replyA = page.getByText(new RegExp(`本次正文：\\s*${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    await replyA.first().waitFor({ timeout: 60_000 });
    const replyAText = await replyA.first().innerText();
    assert.ok(replyAText.includes(text), `来源 A 的回复必须带本轮正文（实读：${replyAText}）`);
    steps.push({ phase: "reply-marker-a", reply: replyAText.slice(0, 120) });
    // ---- 5b. 下一次**真实请求**才用新来源；旧来源的记录与响应标识原样保留 ----
    const firstResponseId = chosen.actualResponseId;
    const requestsBefore = readRequests(demoDir).length;
    // 第二次输入同样用一次性随机串：回复 marker 必须只对得上**这一轮**的正文
    const switchText = `第二次真实请求-${crypto.randomUUID()}`;
    await composer.fill(switchText);
    await composer.press("Enter");
    let afterSwitch = [];
    for (let i = 0; i < 400; i += 1) {
      afterSwitch = readRequests(demoDir);
      if (afterSwitch.slice(requestsBefore).some((r) => r.provider === "dcode-test-b")) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const switchRequest = afterSwitch.slice(requestsBefore).find((r) => r.provider === "dcode-test-b");
    assert.ok(switchRequest, "改选之后的新请求必须真的发给第二个受控来源");
    assert.equal(switchRequest.modelId, "fixture-b");
    assert.ok(
      switchRequest.userContent.includes(switchText),
      "新来源收到的确实是这次的新输入，不是重放旧请求",
    );
    assert.equal(switchRequest.thinkingLevel, "high", "条件参数档位真的进了 SDK 请求，不是界面自述");
    let afterSwitchState = null;
    try {
      afterSwitchState = await waitForSnapshot(
        page,
        (s, id) => s.sessionModels[id]?.actual?.sourceId === "dcode-test-b",
        session.id,
        "下一次真实请求后实际采用应切到来源 B",
      );
    } catch (error) {
      const seen = await page.evaluate(async () => window.dcode.getSnapshot());
      const mine = seen.sessionModels[session.id];
      throw new Error(
        `${error.message}；实读 actual=${JSON.stringify(mine?.actual)} `
        + `responseId=${mine?.actualResponseId} `
        + `requests=${JSON.stringify(mine?.requests?.map((r) => `${r.sourceId}/${r.responseId}`))} `
        + `timeline=${JSON.stringify((seen.timelines[session.id] ?? []).map((b) => `${b.kind}:${b.id}`))}`,
      );
    }
    const switched = afterSwitchState.sessionModels[session.id];
    assert.notEqual(switched.actualResponseId, firstResponseId, "新响应必须有新的可核对响应标识");
    // 旧请求的归属记录仍在：逐次归属按 responseId 保留历史，不被改写
    assert.ok(
      switched.requests.some((r) => r.responseId === firstResponseId && r.sourceId === "dcode-test"),
      "改选不得抹掉先前请求的归属记录",
    );
    // 任务汇总按来源分开：两个来源各计各的
    const switchedTask = afterSwitchState.taskUsage[session.taskId];
    assert.ok(
      switchedTask.bySource.some((s) => s.sourceId === "dcode-test")
      && switchedTask.bySource.some((s) => s.sourceId === "dcode-test-b"),
      "任务用量必须按实际来源分开呈现",
    );
    // 回复与请求在界面上闭环：B 的回复里带的是**这一轮**的随机正文，不是上一轮的
    const replyB = page.getByText(new RegExp(`本次正文：\\s*${switchText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    await replyB.first().waitFor({ timeout: 30_000 });
    const replyBText = await replyB.first().innerText();
    assert.ok(replyBText.includes(switchText), `来源 B 的回复必须带本轮正文（实读：${replyBText}）`);
    assert.equal(replyBText.includes(text), false, "来源 B 的回复不得带上一轮的正文");
    steps.push({ phase: "reply-marker-b", reply: replyBText.slice(0, 120) });

    steps.push({
      phase: "switched-request",
      provider: switchRequest.provider,
      modelId: switchRequest.modelId,
      previousResponseId: firstResponseId,
      currentResponseId: switched.actualResponseId,
      sources: switchedTask.bySource.map((s) => ({ sourceId: s.sourceId, requests: s.usage.requests })),
    });



  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }

  const requests = readRequests(demoDir);
  const summary = {
    sessionId: steps.find((s) => s.phase === "session-created")?.sessionId,
    totalRequests: requests.length,
    // 逐次真实请求的精确身份与正文：这是"请求确实发给了谁、带了什么"的原始证据
    requests: requests.map((r) => ({
      index: r.index,
      provider: r.provider,
      modelId: r.modelId,
      thinkingLevel: r.thinkingLevel ?? null,
      api: r.api,
      hasUserContent: Boolean(r.userContent),
      userContentPreview: typeof r.userContent === "string" ? r.userContent.slice(0, 40) : null,
    })),
    steps,
  };
  // 证据落盘到独立输出根（含原始请求记录），由交付者按需归档进验证记录
  writeFileSync(join(evidence, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  writeFileSync(join(evidence, "model-requests.jsonl"), requests.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  console.log("[d-session-model]", JSON.stringify(summary));
});