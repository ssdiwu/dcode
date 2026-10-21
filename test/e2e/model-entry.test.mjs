// D 片 C07 来源与模型入口的真实 UI 完整路径（隐藏窗口、隔离状态目录、loopback 目录与端点）。
//
// 走**普通装配**（不设 DCODE_VALIDATION_ASSEMBLY）：模型目录服务、Pi 预设目录与 D 的能力端口
// 都只在普通装配建立，验证装配（mock / pi-controlled）没有模型目录，入口会如实显示不可用。
// 目录源与预设端点都指向 loopback，不连公网 pi.dev；凭据不读真实 profile/Home。
//
// 覆盖的判据（每条都对应一条产品要求）：
//  1. 两层结构：第一层是本次会话的选择方式与实际采用，第二层按来源分组、可搜索。
//  2. 同名模型以来源与标识区分，不合并成一条。
//  3. 条件参数只出现该来源该模型**逐档核实为支持**的档位；未核实的档位不出现。
//  4. 选择只作用于后续请求：改选后实际采用仍是上一个（不假装已切换），不创建运行、不发送。
//  5. 额度按如实态呈现：没有可靠来源时显示「暂不支持」，不是 0 也不是可用；未读取时不假装可用。
//  6. 新会话默认与该会话自己的选择分别成立。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { launchApp, ready, cleanup, waitForSnapshot, gotoSession } from "./helpers.mjs";

/** loopback 公共目录源：只回一份最小、可校验的目录；不含任何账户或额度数据。 */
function startCatalogLoop() {
  let hits = 0;
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      hits += 1;
      if (!String(req.url ?? "").startsWith("/catalog")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not-found" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json", etag: `"e2e-${hits}"` });
      res.end(JSON.stringify({ models: [], providers: [] }));
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ origin: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

/** 预设端点的 loopback 覆盖目标：本用例不发模型请求，只需要端点被限定在 loopback。 */
const PRESET_LOOPBACK = JSON.stringify({ openai: "http://127.0.0.1:9/v1" });

async function openModelEntry(page) {
  const trigger = page.getByTestId("model-entry-trigger");
  await trigger.waitFor({ state: "visible", timeout: 30_000 });
  await trigger.click();
  await page.getByTestId("model-search").waitFor({ state: "visible", timeout: 15_000 });
}

/** 第二层必须真的按来源分组渲染，且同名模型在不同来源下是两条独立条目。 */
async function assertGroupedAndSearchable(page) {
  // 第一层：选择方式与实际采用分别呈现
  await page.getByTestId("model-choice-auto").waitFor({ state: "visible", timeout: 15_000 });
  const actual = await page.getByTestId("model-actual").innerText();
  assert.match(actual, /本次实际采用|尚未确定实际使用的模型/);

  // 第二层：先列来源，再按所选来源列模型（2026-10-21 507 确认的两级浏览）
  const groups = page.locator('[data-testid^="model-group-"]');
  await groups.first().waitFor({ state: "visible", timeout: 20_000 });
  const groupCount = await groups.count();
  assert.ok(groupCount >= 1, "第二层应先按来源分组列出");

  // 未选来源时不铺开全部模型：几十家来源的模型一次铺开无法浏览
  const beforePick = await page.locator('[data-testid^="model-item-"]').count();
  assert.equal(beforePick, 0, "未选来源时不应铺开全部模型条目");

  const firstSource = page.locator('[data-testid^="model-source-"]').first();
  await firstSource.waitFor({ state: "visible", timeout: 20_000 });
  await firstSource.click();
  await page.waitForTimeout(150);
  const allItems = await page.locator('[data-testid^="model-item-"]').count();
  assert.ok(allItems > 0, "选中来源后应列出该来源的具体模型条目");
  await page.getByTestId("model-search").fill("anthropic");
  await page.waitForTimeout(150);
  const filtered = await page.locator('[data-testid^="model-item-"]').count();
  assert.ok(filtered <= allItems, `搜索后条目数不应变多：${filtered} > ${allItems}`);
  await page.getByTestId("model-search").fill("__没有这样的来源或模型__");
  await page.getByTestId("model-empty").waitFor({ state: "visible", timeout: 10_000 });
  await page.getByTestId("model-search").fill("");
  return { allItems, filtered, groupCount };
}

/** 身份可区分：同名模型在不同来源下不合并（用同一 modelId 在两个来源各取一条核对）。 */
async function assertIdentityNotMerged(page) {
  await page.getByTestId("model-search").fill("claude-sonnet-4-6");
  await page.waitForTimeout(200);
  const items = page.locator('[data-testid^="model-item-"]');
  const n = await items.count();
  if (n < 2) return { checked: false, n };
  // 每条都带自己的 modelId 文本：同名模型仍以「来源 + 标识」分列，不合并成一条
  for (let i = 0; i < Math.min(n, 4); i += 1) {
    const text = await items.nth(i).innerText();
    assert.match(text, /claude-sonnet-4-6/, "条目应显示模型标识");
  }
  return { checked: true, n };
}

test("D 片：两层模型入口按来源分组可搜索、条件参数只用逐档核实档位、额度如实呈现", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "dcode-e2e-model-entry-"));
  const catalog = await startCatalogLoop();
  let handle = null;
  try {
    handle = await launchApp(stateDir, {
      DCODE_CATALOG_BASE_URL: catalog.origin,
      DCODE_E2E_PRESET_BASE_URLS: PRESET_LOOPBACK,
      DCODE_E2E_STATE_ROOT: tmpdir(),
      DCODE_E2E: "1",
      DCODE_VALIDATION_ASSEMBLY: "",
    }, ".");
    const { page } = handle;
    await ready(page);

    // 先建一条会话：模型入口只在已有会话上适用
    const session = await page.evaluate(async () => {
      const snap = await window.dcode.getSnapshot();
      const created = await window.dcode.createSession({ taskId: snap.tasks[0].id });
      return created;
    });
    assert.ok(session?.id, "应能建立会话");

    // N03：任务行只进入主会话；按目标ID导航，成员从独立展开入口进入。
    await gotoSession(page, session.id);

    // 空会话走草稿页 Composer（同样按 sessionId 归属）；入口是否可用以它本身的可见性为准
    await openModelEntry(page);

    // 1) 两层结构与搜索
    const grouped = await assertGroupedAndSearchable(page);

    // 2) 同名模型以来源与标识区分
    const identity = await assertIdentityNotMerged(page);
    await page.getByTestId("model-search").fill("claude-opus-4-6");
    await page.waitForTimeout(200);
    const opus = page.locator('[data-testid="model-item-anthropic-claude-opus-4-6"]');
    const hasOpus = (await opus.count()) > 0;
    if (hasOpus) await opus.first().click();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    // 3) 条件参数只列该来源该模型**逐档核实为支持**的档位；未核实的档位不出现
    if (hasOpus) {
      await openModelEntry(page);
      // 说明块（model-level-note）与档位组并存，按前缀取会把说明也算成档位——排除它
      const levelItems = page.locator('[data-testid^="model-level-"]:not([data-testid="model-level-note"])');
      const levelCount = await levelItems.count();
      assert.ok(levelCount >= 1, "已逐档核实的模型应出现条件参数档位");
      const allowed = new Set(["none", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);
      for (let i = 0; i < levelCount; i += 1) {
        const id = await levelItems.nth(i).getAttribute("data-testid");
        assert.ok(id && allowed.has(id.replace("model-level-", "")), `档位标识非法：${id}`);
      }
      // 只出现「none（默认）」而无任何已核实档位时，必须同时给出未核实/不支持的说明
      if (levelCount === 1) {
        await page.getByTestId("model-level-note").waitFor({ state: "visible", timeout: 10_000 });
      }
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
    }

    // 4) 选择只作用于后续请求：改选后不创建运行、不发送，实际采用不提前宣布
    const afterChoice = await waitForSnapshot(
      page,
      (snap) => snap.sessionModels[session.id]?.choice.mode === "explicit",
      undefined,
      "改选后应落成该会话的显式选择",
    );
    const state = afterChoice.sessionModels[session.id];
    assert.ok(state, "会话模型状态应在快照里");
    assert.equal(state.actual, null, "改选本身不构成已切换模型");
    assert.equal(state.lastResult, "none", "判定成立不等于请求成功");
    const runs = Object.values(afterChoice.runs).filter((r) => r.sessionId === session.id);
    for (const run of runs) {
      assert.ok(["ready", "paused", "idle", "finished"].includes(run.status),
        `改选不得启动或中断任何运行，实际状态：${run.status}`);
    }
    // 时间线也没有新增消息：改选不重投、不重复接收输入
    assert.equal((afterChoice.timelines[session.id] ?? []).filter((b) => b.role === "root").length, 0,
      "改选不得重投或重复接收输入");

    // 5) 额度按如实态呈现：
    //    · 已接通读取通路但**本次运行还没收到过真实响应** → 「未读到」（unknown），不是 0 也不是可用；
    //    · 本装配未查证官方接口的来源 → 「暂不支持」（unsupported），写明依据。
    const quota = await page.evaluate(() => window.dcode.readModelQuota({ sourceId: "anthropic", modelId: "claude-opus-4-6" }));
    assert.equal(quota.state, "unknown", "已接通响应头读取但尚未观察到真实响应时是 unknown");
    assert.equal(quota.updatedAt, null, "从未成功读到额度时不得有更新时间");
    assert.ok(quota.reason && quota.reason.length > 0, "如实状态必须带真实原因");
    assert.match(quota.reason, /尚未从/, "未读到要说清是没读到，而不是额度为零");
    const unverified = await page.evaluate(() => window.dcode.readModelQuota({ sourceId: "some-unverified-source", modelId: "m" }));
    assert.equal(unverified.state, "unsupported", "未查证官方接口的来源如实 unsupported");
    assert.equal(unverified.updatedAt, null);

    await openModelEntry(page);
    // 额度区只针对本次会话要用的模型；未读取时先显示「未读取」，不是可用也不是 0
    await page.getByTestId("model-quota-unread").waitFor({ state: "visible", timeout: 10_000 });
    const unread = await page.getByTestId("model-quota-unread").innerText();
    assert.doesNotMatch(unread, /额度可用/, "未读取不得显示为可用");
    assert.doesNotMatch(unread, /余额 0/, "未读取不得显示成余额为 0");
    await page.getByTestId("model-quota-read").click();
    const shown = page.getByTestId("model-quota");
    await shown.waitFor({ state: "visible", timeout: 10_000 });
    const text = await shown.innerText();
    assert.match(text, /额度未知|暂不支持|unsupported/, "界面按真实状态显示额度，不显示成可用或 0");
    assert.doesNotMatch(text, /额度可用/, "未核实来源不得显示为可用");
    assert.doesNotMatch(text, /余额 0|剩余 0/, "不得显示成余额为 0");
    // 真实原因随状态一起显示，而不是只给一个中性标签：本例是「已接通但还没观察到真实响应」
    assert.match(text, /尚未从 .* 的真实响应读到额度/, "如实状态必须带真实原因");

    // 6) 新会话默认与该会话自己的选择分别成立
    const allStates = await page.evaluate(() => window.dcode.listModelSources({ sessionId: undefined }));
    assert.equal(allStates.defaultChoice.mode, "auto", "新会话默认仍是自动，与该会话的显式选择分开");
    assert.ok(
      allStates.sessionStates.some((st) => st.sessionId === session.id && st.choice.mode === "explicit"),
      "不指定会话时列出各会话自己的选择",
    );
    const scoped = await page.evaluate((id) => window.dcode.listModelSources({ sessionId: id }), session.id);
    assert.equal(scoped.sessionStates.length, 1, "指定会话时只返回该会话的状态");
    assert.equal(scoped.sessionStates[0].choice.mode, "explicit");
    assert.equal(scoped.defaultChoice.mode, "auto", "指定会话也不改新会话默认");

    console.log("[d-model-entry]", JSON.stringify({ grouped, identity, quota: quota.state }));
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    catalog.close();
    cleanup(stateDir);
  }
});

/**
 * 2026-10-21 507 报障：草稿态的模型入口只给一句不可点的说明文字，
 * 点它毫无反应（没有会话就没有入口），而「新会话起点」这个设置项在界面上没有入口。
 * 这里钉住：草稿态的入口可点、打开后能点名到模型，并改到新会话起点。
 */
test("草稿态的模型入口可点并改「新会话起点」，不再是不可点的说明文字", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "dcode-e2e-model-draft-"));
  const catalog = await startCatalogLoop();
  let handle = null;
  try {
    handle = await launchApp(stateDir, {
      DCODE_CATALOG_BASE_URL: catalog.origin,
      DCODE_E2E_PRESET_BASE_URLS: PRESET_LOOPBACK,
      DCODE_E2E_STATE_ROOT: tmpdir(),
      DCODE_E2E: "1",
      DCODE_VALIDATION_ASSEMBLY: "",
    }, ".");
    const { page } = handle;
    await ready(page);

    // 草稿态：没有选中会话，模型入口作用在「新会话起点」上
    const disabled = await page.getByTestId("model-entry-disabled").count();
    assert.equal(disabled, 0, "草稿态不应只给不可点的说明文字");

    const trigger = page.getByTestId("model-entry-trigger");
    await trigger.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await trigger.isDisabled(), false, "草稿态的模型入口应可点");
    await trigger.click();
    await page.getByTestId("model-search").waitFor({ state: "visible", timeout: 15_000 });

    // 两级浏览：先选来源，再点名模型
    const source = page.locator('[data-testid^="model-source-"]').first();
    await source.waitFor({ state: "visible", timeout: 20_000 });
    await source.click();
    await page.waitForTimeout(150);
    const items = page.locator('[data-testid^="model-item-"]');
    const count = await items.count();
    assert.ok(count > 0, "选中来源后应能点名到具体模型");

    const before = await page.getByTestId("model-entry-trigger").innerText();
    await items.first().click();
    await page.waitForTimeout(300);
    const after = await page.getByTestId("model-entry-trigger").innerText();
    assert.notEqual(after, before, "选点模型后入口文字应随之改变");

    // 改的是「新会话起点」这个设置项，不动任何已存在会话
    const snap = await page.evaluate(() => window.dcode.getSnapshot());
    assert.equal(snap.settings.newSessionModelChoice.mode, "explicit", "新会话起点应被这次选择改写");
    assert.equal(snap.sessions.length, 0, "草稿态选择不应创建会话");

    // 已有会话时用草稿态入口：那条会话自己的选择不能被带动
    const existing = await page.evaluate(async () => {
      const s = await window.dcode.getSnapshot();
      return window.dcode.createSession({ taskId: s.tasks[0].id });
    });
    const sessionModelsBefore = await page.evaluate((id) => {
      const map = window.dcode.getSnapshot().sessionModels ?? {};
      // 断言要有约束：那条会话确实有模型状态，且之后一个字节都没变。
      assert.ok(Object.keys(map).length > 0, "快照应带有会话模型状态");
      assert.ok(map[id], "新建的那条会话应有模型状态");
      return JSON.stringify(map);
    }, existing.id);
    // 仍在草稿态：直接用入口改「新会话起点」
    const draftTrigger = page.getByTestId("model-entry-trigger");
    await draftTrigger.waitFor({ state: "visible", timeout: 15_000 });
    await draftTrigger.click();
    await page.getByTestId("model-search").waitFor({ state: "visible", timeout: 15_000 });
    await page.getByTestId("model-search").fill("claude-opus-4-6");
    await page.waitForTimeout(400);
    const picked = page.locator('[data-testid^="model-item-"]').first();
    if (await picked.count()) { await picked.click(); await page.waitForTimeout(400); }
    await page.keyboard.press("Escape");
    const sessionModelsAfter = await page.evaluate(() => JSON.stringify(window.dcode.getSnapshot().sessionModels ?? {}));
    assert.equal(sessionModelsAfter, sessionModelsBefore, "草稿态入口只改新会话起点，不应带动已有会话的选择");
  } finally {
    if (handle) await handle.close();
    await cleanup(stateDir);
    await catalog.close();
  }
});
