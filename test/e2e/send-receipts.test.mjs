// 发送回执三态与消息身份（mock 端口语义）：
// 已接收/确认未接收/接收结果待核对 的呈现与草稿保护、双击与同文字去重、
// 暂停中发送被拒、stale 恢复拒绝且不自动重投、重开只读 + 显式继续、关闭失败可见。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchApp, assertValidationModel, cleanup, ready, killApp, waitForSnapshot } from "./helpers.mjs";
import { evidenceDir } from "./evidence-root.mjs";


const COMPOSER_PLACEHOLDER = "交代需求、提问或粘贴内容…";

// 末尾操作验收的几何/动作证据（悬浮卡片增量 r3 补测）
// 新观测落在本片专用的 integration-observations（r2 原证据保留）
const EVIDENCE = evidenceDir("send-receipts");

// 只观察隔离测试中的输入与草稿保存，不替换产品状态或延迟回执。
// 初次失败缺少放行前的输入证据；保留时序可区分输入未完成与之后的状态覆盖。
async function observeDraftEdits(page) {
  await page.evaluate(() => {
    const trace = [];
    const capture = (kind, event = {}) => {
      try {
      let ui = {};
      const parsed = JSON.parse(localStorage.getItem("dcode-prototype-ui-v1") ?? "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) ui = parsed;
      const area = document.querySelector("textarea");
      const row = {
        kind, timeMs: performance.now(), domValue: area?.value ?? null,
        draftKey: ui.selectedSessionId ?? (ui.draftTaskId ? `draft:${ui.draftTaskId}` : null),
        drafts: ui.drafts ?? {}, pendingDrafts: Object.keys(ui.operationOfDraft ?? {}),
        focused: document.activeElement === area, ...event,
      };
      trace.push(row);
      if (trace.length > 300) trace.shift();
      return row;
      } catch (error) {
        // 观察失败不能把原本成功的产品写入变成失败；诊断本身另留明确记录。
        const failure = { kind: "diagnostic-error", during: kind, error: String(error) };
        trace.push(failure);
        return failure;
      }
    };
    const onInput = (event) => {
      if (!(event.target instanceof HTMLTextAreaElement)) return;
      capture(event.type, { inputType: event.inputType ?? null, data: event.data ?? null, composing: event.isComposing ?? false });
    };
    const types = ["beforeinput", "input", "compositionstart", "compositionend", "focusin", "focusout"];
    types.forEach((type) => document.addEventListener(type, onInput, true));
    const original = Storage.prototype.setItem;
    const observedSetItem = function (key, value) {
      const result = original.call(this, key, value);
      if (this === localStorage && key === "dcode-prototype-ui-v1") capture("persist");
      return result;
    };
    Storage.prototype.setItem = observedSetItem;
    window.__dcodeDraftTrace = trace;
    window.__dcodeCaptureDraft = capture;
    window.__dcodeStopDraftTrace = () => {
      types.forEach((type) => document.removeEventListener(type, onInput, true));
      if (Storage.prototype.setItem === observedSetItem) Storage.prototype.setItem = original;
    };
    capture("installed");
  });
}

test("回执三态：待核对→只读回查→重试已接收；草稿只在已接收后清除", async () => {
  const { page, stateDir, close } = await launchApp(undefined, { DCODE_MOCK_UNKNOWN_ONCE: "1" });
  try {
    await ready(page);
    await page.getByRole("heading", { name: "开始一项新工作" }).waitFor();
    await assertValidationModel(page);

    const text = "验证接收结果待核对的只读回查路径";
    const composer = page.getByPlaceholder(COMPOSER_PLACEHOLDER);
    await composer.fill(text);
    await composer.press("Enter");

    // 接收结果待核对：中性 chip + 只读回查动作；消息块保留原文
    await page.getByText("待核对", { exact: true }).waitFor();
    await page.locator("main").getByText(text, { exact: true }).first().waitFor();
    // 草稿不当已接收清除：原草稿键仍保留原文（界面已带入新会话，回 Home 草稿可取回）
    const drafts = await page.evaluate(() => JSON.parse(localStorage.getItem("dcode-prototype-ui-v1") ?? "{}").drafts ?? {});
    assert.ok(
      Object.values(drafts).some((value) => value === text),
      "待核对不得当作已接收清除草稿",
    );

    // 只读回查：注入场景下无提交记录 → 如实显示未找到，不盲投
    await page.getByRole("button", { name: "回查" }).click();
    await page.getByText("未找到提交记录", { exact: false }).waitFor();

    // 重试：同一次发送的再次投递（复用 operationId）→ 已接收，草稿此时才清除
    await page.getByRole("button", { name: "重试" }).click();
    await page.getByText("已接收", { exact: true }).waitFor();
    const draftsAfter = await page.evaluate(() => JSON.parse(localStorage.getItem("dcode-prototype-ui-v1") ?? "{}").drafts ?? {});
    assert.ok(
      !Object.values(draftsAfter).some((value) => value === text),
      "已接收后原草稿键才清除",
    );
    await page.getByText("执行中", { exact: true }).first().waitFor();
  } finally {
    writeFileSync(join(stateDir, "send-result-gate"), "open");
    try { await close(); } finally { await killApp({ stateDir, close }); cleanup(stateDir); }
  }
});

test("回执丢失但实际已接收：只读回查找回，不盲目重投", async () => {
  // dropReceipt 注入：执行端真实接收并执行，只丢回执；找回走 lookupReceipt，不二次投递
  const { page, stateDir, close } = await launchApp(undefined, { DCODE_MOCK_DROP_RECEIPT_ONCE: "1" });
  try {
    await ready(page);
    await page.getByRole("heading", { name: "开始一项新工作" }).waitFor();
    await assertValidationModel(page);

    const text = "验证回执丢失后只读找回而不是重新投递的同一次发送操作"; // >24 字，会话标题截断后精确匹配只命中消息气泡
    const composer = page.getByPlaceholder(COMPOSER_PLACEHOLDER);
    await composer.fill(text);
    await composer.press("Enter");

    // 回执丢失：待核对；执行端实际已接收（模拟脚本在推进），但界面不据此伪报已接收
    await page.getByText("待核对", { exact: true }).waitFor();
    await page.getByText("执行中", { exact: true }).first().waitFor();
    assert.equal(await page.locator('button[data-slot="composer-primary"]').getAttribute("aria-label"), "暂停", "unknown 不替换已确认运行控制");
    // C06 说明排在输入卡片之外（与原型 .composer-hint 同层），按它的实际位置定位
    await page.locator("[data-slot=composer-note]").getByText("发送结果待核对，请在原消息上选择“回查”", { exact: false }).waitFor();

    // 只读回查找回：已接收；找回后原草稿键清除（与重试已接收同义）
    await page.getByRole("button", { name: "回查" }).click();
    await page.getByText("已接收", { exact: true }).waitFor();
    const drafts = await page.evaluate(() => JSON.parse(localStorage.getItem("dcode-prototype-ui-v1") ?? "{}").drafts ?? {});
    assert.ok(!Object.values(drafts).some((v) => v === text), "回查找回已接收后原草稿应清除");

    // 同一发送只有一条消息块；脚本完成前后不增生（找回未造成任何重投痕迹）
    assert.equal(await page.locator("main").getByText(text, { exact: true }).count(), 1);
    await page.getByText("本轮结束。", { exact: true }).waitFor();
    assert.equal(await page.locator("main").getByText(text, { exact: true }).count(), 1);
  } finally {
    writeFileSync(join(stateDir, "send-result-gate"), "open");
    try { await close(); } finally { await killApp({ stateDir, close }); cleanup(stateDir); }
  }
});

test("外层回包丢失但已 accepted：快照确认清原稿与身份，不把旧稿换 mode 后新投", async () => {
  const { page, stateDir, close } = await launchApp(undefined, { DCODE_TEST_DROP_SEND_RESULT: "1" });
  try {
    await ready(page);
    await assertValidationModel(page);
    const text = "验证外层回包丢失但后端已接受的原稿不能重复发送";
    const composer = page.getByPlaceholder(COMPOSER_PLACEHOLDER);
    await composer.fill(text);
    await composer.press("Enter");
    // 真实快照中的 accepted 是确认依据；不能仅去掉 unknownOps 又保留可再次发送的原稿。
    await page.waitForFunction(() => {
      const ui = JSON.parse(localStorage.getItem("dcode-prototype-ui-v1") ?? "{}");
      return ui.drafts?.["draft:task-home-default"] === "" &&
        !ui.operationOfDraft?.["draft:task-home-default"] && ui.unknownOps.length === 0;
    });
    const before = await page.evaluate(() => window.dcode.getSnapshot());
    assert.equal(await composer.inputValue(), "", "accepted 确认须清原稿");
    assert.equal(await page.getByText("发送结果待核对。原文已保留，请在原消息上选择“回查”。", { exact: true }).count(), 0, "明确回执后不得遗留未知提示");
    await page.getByRole("button", { name: "输入选项" }).click();
    await page.getByRole("menuitemradio", { name: /稍后处理/ }).click();
    await composer.press("Enter");
    const after = await page.evaluate(() => window.dcode.getSnapshot());
    assert.equal(after.tasks.length, before.tasks.length);
    assert.equal(after.sessions.length, before.sessions.length);
    const matches = Object.values(after.timelines).flat().filter((b) => b.kind === "message" && b.role === "user" && b.text === text);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].receipt.status, "accepted");
  } finally {
    try { await close(); } finally { await killApp({ stateDir, close }); cleanup(stateDir); }
  }
});

test("外层回包与接收均未知：Enter 和换 mode 不重试旧文；T02 回查后 T03 同身份重试", async () => {
  const { page, stateDir, close } = await launchApp(undefined, { DCODE_TEST_DROP_SEND_RESULT: "1", DCODE_MOCK_UNKNOWN_ONCE: "1" });
  try {
    await ready(page);
    await assertValidationModel(page);
    const text = "验证外层回包丢失且接收未知的旧发送不得由 Enter 隐式重试";
    const composer = page.getByPlaceholder(COMPOSER_PLACEHOLDER);
    await composer.fill(text);
    await composer.press("Enter");
    await page.getByText("发送结果待核对。原文已保留，请在原消息上选择“回查”。", { exact: true }).waitFor();
    const before = await page.evaluate(() => window.dcode.getSnapshot());
    const original = Object.entries(before.timelines).flatMap(([sid, blocks]) => blocks.map((b) => ({ sid, b }))).find(({ b }) => b.kind === "message" && b.text === text);
    assert.ok(original?.b.operationId);
    await composer.press("Enter");
    await page.getByRole("button", { name: "输入选项" }).click();
    await page.getByRole("menuitemradio", { name: /稍后处理/ }).click();
    await composer.press("Enter");
    const guarded = await page.evaluate(() => window.dcode.getSnapshot());
    assert.equal(guarded.tasks.length, before.tasks.length);
    assert.equal(guarded.sessions.length, before.sessions.length);
    const held = guarded.timelines[original.sid].find((b) => b.operationId === original.b.operationId);
    assert.equal(held.receipt.status, "unknown", "Enter 不得读回/重试旧输入");
    assert.equal(held.mode, "steer", "切换用途不改写原操作");
    assert.equal(await composer.inputValue(), text);
    await page.getByRole("button", { name: text.slice(0, 24), exact: false }).first().click();
    await page.getByRole("button", { name: "回查", exact: true }).click();
    await page.getByText("未找到提交记录", { exact: false }).waitFor();
    await page.getByRole("button", { name: "重试", exact: true }).click();
    const after = await page.evaluate(() => window.dcode.getSnapshot());
    const found = after.timelines[original.sid].filter((b) => b.operationId === original.b.operationId);
    assert.equal(found.length, 1);
    assert.equal(found[0].receipt.status, "accepted");
    assert.equal(after.tasks.length, before.tasks.length);
    assert.equal(after.sessions.length, before.sessions.length);
  } finally {
    try { await close(); } finally { await killApp({ stateDir, close }); cleanup(stateDir); }
  }
});

test("消息身份：同次双击不重复投递；相同文字的新发送是独立消息", async () => {
  // 非快进脚本，保证两次发送的回执窗口足够长
  const { page, stateDir, close } = await launchApp(undefined, { DCODE_MOCK_FAST: "0" });
  try {
    await ready(page);
    await page.getByRole("heading", { name: "开始一项新工作" }).waitFor();
    await assertValidationModel(page);

    const longText = "验证相同文字的两次主动发送应该产生两条彼此独立的消息记录"; // >24 字，会话标题截断，精确匹配只命中消息气泡
    const composer = page.getByPlaceholder(COMPOSER_PLACEHOLDER);
    await composer.fill(longText);
    const sendButton = page.locator('button[data-slot="composer-primary"]');
    // 两次 click() 是两个独立手势，detail 都为 1；真实双击须保留第二击 detail=2。
    await sendButton.dblclick({ force: true });

    await page.getByText("已接收", { exact: true }).waitFor();
    assert.equal(
      await page.locator("main").getByText(longText, { exact: true }).count(),
      1,
      "同次双击只应投递一条消息",
    );

    // 相同文字的新发送：新的发送身份，独立成条
    const followup = page.getByPlaceholder("追问、补充或纠正…");
    await page.getByText("本轮结束。", { exact: true }).waitFor(); // 第一轮回到 ready
    await followup.fill(longText);
    await page.getByRole("button", { name: "发送", exact: true }).click();
    // 快照口径等待：两条同文消息的同一接收状态（chip 可见性存在渲染时序窗口，不作等待锚点）
    await waitForSnapshot(page, (s, t) =>
        Object.values(s.timelines)
          .flat()
          .filter((b) => b.kind === "message" && b.role === "user" && b.text === t && b.receipt?.status === "accepted")
          .length === 2,
      longText);
    assert.equal(
      await page.locator("main").getByText(longText, { exact: true }).count(),
      2,
      "相同文字的再次主动发送应是两条独立消息",
    );
  } finally {
    writeFileSync(join(stateDir, "send-result-gate"), "open");
    try { await close(); } finally { await killApp({ stateDir, close }); cleanup(stateDir); }
  }
});

test("暂停中发送被拒：确认未接收保留原文与原因，重试复用同一发送身份", async () => {
  const { page, stateDir, close } = await launchApp();
  try {
    await ready(page);
    await page.getByRole("heading", { name: "开始一项新工作" }).waitFor();
    await assertValidationModel(page);

    const composer = page.getByPlaceholder(COMPOSER_PLACEHOLDER);
    await composer.fill("先跑起来再验证暂停中发送");
    await composer.press("Enter");
    await page.getByText("执行中", { exact: true }).first().waitFor();

    await page.getByRole("button", { name: "暂停" }).click();
    await page.getByText("已暂停", { exact: true }).first().waitFor();

    // 暂停中发送：不被吞掉，如实回执「确认未接收（已暂停）」
    // C01–C06：暂停时唯一主按钮是「继续执行」（继续只恢复不提交草稿）；
    // C02 输入框 Enter 仍尝试发送新文字，暂停不会被 Enter 代触发
    const followup = page.getByPlaceholder("追问、补充或纠正…");
    await followup.fill("暂停期间补充的要求");
    await followup.press("Enter");
    await page.getByText("目标已暂停，输入未接收", { exact: true }).waitFor();
    assert.equal(
      await followup.inputValue(),
      "暂停期间补充的要求",
      "确认未接收应保留原文（草稿不清除）",
    );

    const rejectedInput = await page.evaluate(() => window.dcode.getSnapshot().then((snapshot) =>
      Object.values(snapshot.timelines).flat().find((block) => block.kind === "message" && block.role === "user" && block.text === "暂停期间补充的要求"),
    ));
    assert.ok(rejectedInput?.operationId, "重试前记录本次未接收输入的身份");
    const inputRow = page.locator('main [data-slot="message"][data-from="user"]').filter({ has: page.getByText("暂停期间补充的要求", { exact: true }) });

    // 暂停中重试：仍是确认未接收，同一 operationId 不重复计入执行
    await inputRow.getByRole("button", { name: "重试" }).click();
    await page.getByText("目标已暂停，输入未接收", { exact: true }).waitFor();

    // 恢复后重试同一消息块：已接收
    await page.getByRole("button", { name: "继续执行" }).click();
    await page.getByText("本轮结束。", { exact: true }).waitFor();
    await inputRow.getByRole("button", { name: "重试" }).click();
    // 同一会话可同时有多条已接收输入，断言必须指向本次重试的消息，不能全页匹配。
    await inputRow.getByText("已接收", { exact: true }).waitFor();
    const retried = await page.evaluate((id) => window.dcode.getSnapshot().then((snapshot) =>
      Object.values(snapshot.timelines).flat().filter((block) => block.kind === "message" && block.operationId === id),
    ), rejectedInput.operationId);
    assert.equal(retried.length, 1, "同一次重试只保留一条输入");
    assert.equal(retried[0].receipt?.status, "accepted");
  } finally {
    writeFileSync(join(stateDir, "send-result-gate"), "open");
    try { await close(); } finally { await killApp({ stateDir, close }); cleanup(stateDir); }
  }
});

test("stale 恢复拒绝：过期恢复被拒后不自动重投，再恢复须新的明确意图", async () => {
  const { page, stateDir, close } = await launchApp();
  try {
    await ready(page);
    await page.getByRole("heading", { name: "开始一项新工作" }).waitFor();
    await assertValidationModel(page);

    const composer = page.getByPlaceholder(COMPOSER_PLACEHOLDER);
    await composer.fill("验证暂停收束期间的过期恢复");
    await composer.press("Enter");
    await page.getByText("执行中", { exact: true }).first().waitFor();

    // 暂停收束窗口内（暂停处理中）触发恢复：按 stale 拒绝。
    // C01–C06 后界面在暂停处理中不再显示继续按钮；这里用同一桥操作模拟一次在收束窗口内
    // 发出的明确恢复请求（产品语义不变：过期恢复被拒、不自动重投）
    await page.getByRole("button", { name: "暂停" }).click();
    await page.getByText("暂停处理中", { exact: true }).waitFor();
    // 暂停处理中主按钮为禁用的「暂停处理中」，不存在可点的继续入口
    assert.equal(await page.getByRole("button", { name: "继续执行" }).count(), 0, "暂停处理中不得显示继续");
    await page.evaluate(async () => {
      const snapshot = await window.dcode.getSnapshot();
      // 按运行事实定位目标会话，不拿 runs 首个键（也不是全部键）
      const run = Object.values(snapshot.runs).find((r) => r.status === "pausing");
      await window.dcode.resumeRun({ sessionId: run.sessionId }).catch(() => undefined);
    });
    await page.getByText("工作状态已变化", { exact: false }).waitFor();
    // 普通只读观测不吞拒绝原因，也不自动恢复；按真实相位等暂停收束。
    await waitForSnapshot(page, (s) =>
      Object.values(s.runs).some((r) => r.status === "paused" && r.errorNote === "resume-stale"),
    );
    for (let i = 0; i < 3; i++) await page.evaluate(() => window.dcode.getSnapshot());
    assert.equal(await page.getByText("执行中", { exact: true }).count(), 0, "stale 被拒后不得自动恢复执行");

    // 新的明确恢复意图成功后才清除拒绝说明。
    await page.getByRole("button", { name: "继续执行" }).click();
    await page.getByText("从中断处继续", { exact: false }).waitFor();
    await page.getByText("本轮结束。", { exact: true }).waitFor();
  } finally {
    writeFileSync(join(stateDir, "send-result-gate"), "open");
    try { await close(); } finally { await killApp({ stateDir, close }); cleanup(stateDir); }
  }
});

test("重开只读不执行：恢复条等待显式接续，查询不推进时间线", async () => {
  const first = await launchApp();
  const stateDir = first.stateDir;
  try {
    const { page } = first;
    await ready(page);
    await page.getByRole("heading", { name: "开始一项新工作" }).waitFor();
    await assertValidationModel(page);
    const composer = page.getByPlaceholder(COMPOSER_PLACEHOLDER);
    await composer.fill("验证重开只读与显式继续");
    await composer.press("Enter");
    await page.getByText("执行中", { exact: true }).first().waitFor();
    await page.getByRole("button", { name: "暂停" }).click();
    await page.getByText("已暂停", { exact: true }).first().waitFor();
    await first.close();
  } finally {
    await first.app.close().catch(() => {});
  }

  const second = await launchApp(stateDir);
  try {
    const { page } = second;
    await ready(page);
    await page.getByText("已打开上次的工作记录", { exact: false }).waitFor();
    const countBlocks = () => page.locator("main .mx-auto > *").count();
    const before = await countBlocks();
    await page.waitForTimeout(1600); // 只读核对期间：不查询驱动执行
    assert.equal(await countBlocks(), before, "重开后只读不执行，时间线不应增长");
    await page.getByRole("button", { name: "继续执行" }).first().click();
    await page.getByText("从中断处继续", { exact: false }).waitFor();
    await second.close();
  } finally {
    await second.app.close().catch(() => {});
    cleanup(stateDir);
  }
});

test("关闭收束失败：保留可见状态、不伪报成功、应用保持打开", async () => {
  const handle = await launchApp(undefined, { DCODE_MOCK_CLOSE_FAIL: "1" });
  const { page, stateDir } = handle;
  try {
    await ready(page);
    await page.getByRole("heading", { name: "开始一项新工作" }).waitFor();
    await assertValidationModel(page);
    const composer = page.getByPlaceholder(COMPOSER_PLACEHOLDER);
    await composer.fill("验证关闭收束失败可见");
    await composer.press("Enter");
    await page.getByText("已接收", { exact: true }).waitFor();

    // 正常关闭路径（与窗口全部关闭同一 app.quit() 入口）：收束失败 → 不退出、快照如实呈现错误
    // 同一事件轮连续退出，第二次发生在异步收束仍等待时；不得绕过第一次的保存。
    await handle.app.evaluate(({ app }) => { app.quit(); app.quit(); });
    await page.getByText("关闭未完成", { exact: false }).waitFor();
    const alive = handle.app.process().exitCode === null;
    assert.ok(alive, "收束失败时应用应保持打开，不得伪报已保存后退出");
    // 失败之后再次退出仍须保留错误和窗口，不能以 flushStarted 冒充 flushDone。
    await handle.app.evaluate(({ app }) => app.quit());
    await page.getByText("关闭未完成", { exact: false }).waitFor(); // 同实例后续关闭复用同一失败
  } finally {
    await killApp(handle); // 收束失败被保留：只能强制终止，随后才允许清理数据目录
    cleanup(stateDir);
  }
});

test("首发未知：草稿 Enter 不重投，回查后同身份重试复用原任务与主会话", async () => {
  // unknownOnce 首发 → 待核对 → 草稿 Enter 不重投 → 原消息回查/重试：对象和身份不变
  const { page, stateDir, close } = await launchApp(undefined, { DCODE_MOCK_UNKNOWN_ONCE: "1" });
  try {
    await ready(page);
    await page.getByRole("heading", { name: "开始一项新工作" }).waitFor();
    await assertValidationModel(page);

    // 用无会话的新任务草稿做首发，草稿在接收未确认后可回取
    const workspaceRow = page.getByRole("treeitem", { name: "D Code" });
    await workspaceRow.hover();
    const plusButton = workspaceRow.getByRole("button", { name: "在此空间新建任务" });
    await plusButton.waitFor({ state: "visible" });
    await plusButton.click({ force: true });
    await page.getByPlaceholder("任务名称").fill("对象复用验证");
    await page.getByRole("button", { name: "创建" }).click();
    await page.getByText("D Code / 对象复用验证", { exact: true }).waitFor();

    const text = "首发接收未确认后从草稿重发复用对象";
    const composer = page.getByPlaceholder(COMPOSER_PLACEHOLDER);
    await composer.fill(text);
    await composer.press("Enter");
    await page.getByText("待核对", { exact: true }).waitFor();

    // 回到草稿（对象已建但接收未确认；原文保留在草稿键上）
    await page.getByRole("treeitem", { name: "对象复用验证" }).click();
    await page.getByRole("heading", { name: "开始一项新工作" }).waitFor();
    assert.equal(await page.getByPlaceholder(COMPOSER_PLACEHOLDER).inputValue(), text, "接收未确认后草稿应保留原文");

    const before = await page.evaluate(() => window.dcode.getSnapshot());
    const original = Object.entries(before.timelines).flatMap(([sid, blocks]) => blocks.map((b) => ({ sid, b }))).find(({ b }) => b.kind === "message" && b.text === text);
    assert.ok(original?.b.operationId);
    await page.getByPlaceholder(COMPOSER_PLACEHOLDER).press("Enter");
    const guarded = await page.evaluate(() => window.dcode.getSnapshot());
    assert.equal(guarded.timelines[original.sid].find((b) => b.operationId === original.b.operationId).receipt.status, "unknown", "草稿 Enter 不得隐式重试待核对旧文");
    await page.getByRole("button", { name: text.slice(0, 24), exact: false }).first().click();
    await page.getByRole("button", { name: "回查", exact: true }).click();
    await page.getByText("未找到提交记录", { exact: false }).waitFor();
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await page.getByText("已接收", { exact: true }).waitFor();
    const after = await page.evaluate(() => window.dcode.getSnapshot());
    assert.equal(after.tasks.length, before.tasks.length, "同身份重试不得重复建任务");
    assert.equal(after.sessions.length, before.sessions.length, "同身份重试不得重复建主会话");
    const same = after.timelines[original.sid].filter((b) => b.operationId === original.b.operationId);
    assert.equal(same.length, 1);
    assert.equal(same[0].receipt.status, "accepted");
    await page.getByText("执行中", { exact: true }).first().waitFor();
  } finally {
    writeFileSync(join(stateDir, "send-result-gate"), "open");
    try { await close(); } finally { await killApp({ stateDir, close }); cleanup(stateDir); }
  }
});

test("首发接收未确认后重开：复用同一任务、主会话与操作身份", async () => {
  // 第一棒注入 unknown：首发对象已建、接收待核对；关联必须随状态落盘，进程退出后仍可复用
  const text = "首发接收未确认后重开复用同一对象与操作身份";
  const first = await launchApp(undefined, { DCODE_MOCK_UNKNOWN_ONCE: "1" });
  const stateDir = first.stateDir;
  let before;
  try {
    const { page } = first;
    await ready(page);
    await page.getByRole("heading", { name: "开始一项新工作" }).waitFor();
    await assertValidationModel(page);

    const workspaceRow = page.getByRole("treeitem", { name: "D Code" });
    await workspaceRow.hover();
    const plusButton = workspaceRow.getByRole("button", { name: "在此空间新建任务" });
    await plusButton.waitFor({ state: "visible" });
    await plusButton.click({ force: true });
    await page.getByPlaceholder("任务名称").fill("重开复用验证");
    await page.getByRole("button", { name: "创建" }).click();
    await page.getByText("D Code / 重开复用验证", { exact: true }).waitFor();

    const composer = page.getByPlaceholder(COMPOSER_PLACEHOLDER);
    await composer.fill(text);
    await composer.press("Enter");
    await page.getByText("待核对", { exact: true }).waitFor();

    // 对象口径以快照为准（树行数含手风琴会话行，随展开状态变化，不作对象判据）
    const snap = await page.evaluate(() => window.dcode.getSnapshot());
    const found = Object.entries(snap.timelines)
      .flatMap(([sid, blocks]) => blocks.map((b) => ({ sid, b })))
      .find(({ b }) => b.kind === "message" && b.role === "user" && b.text === text);
    assert.ok(found?.b.operationId, "首发消息块必须携带发送身份");
    before = { sessionId: found.sid, operationId: found.b.operationId, tasks: snap.tasks.length, sessions: snap.sessions.length };
    await first.close();
  } finally {
    await first.app.close().catch(() => {});
  }

  // 第二棒不带注入：重开只读恢复；旧文 Enter 不重投，原消息回查后同身份重试
  const second = await launchApp(stateDir);
  try {
    const { page } = second;
    await ready(page);
    await page.getByText("待核对", { exact: true }).waitFor();

    await page.getByRole("treeitem", { name: "重开复用验证" }).click();
    await page.getByRole("heading", { name: "开始一项新工作" }).waitFor();
    assert.equal(await page.getByPlaceholder(COMPOSER_PLACEHOLDER).inputValue(), text, "重开后草稿应保留原文");

    await page.getByPlaceholder(COMPOSER_PLACEHOLDER).press("Enter");
    const guarded = await page.evaluate(() => window.dcode.getSnapshot());
    assert.equal(guarded.timelines[before.sessionId].find((b) => b.operationId === before.operationId).receipt.status, "unknown");
    await page.getByRole("button", { name: text.slice(0, 24), exact: false }).first().click();
    await page.getByRole("button", { name: "回查", exact: true }).click();
    await page.getByText("未找到提交记录", { exact: false }).waitFor();
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await page.getByText("已接收", { exact: true }).waitFor();

    const snap2 = await page.evaluate(() => window.dcode.getSnapshot());
    assert.equal(snap2.tasks.length, before.tasks, "重开后重发不得重复建任务");
    assert.equal(snap2.sessions.length, before.sessions, "重开后重发不得重复建会话");
    const matches = Object.entries(snap2.timelines)
      .flatMap(([sid, blocks]) => blocks.map((b) => ({ sid, b })))
      .filter(({ b }) => b.kind === "message" && b.role === "user" && b.text === text);
    assert.equal(matches.length, 1, "同一操作身份重发不得产生第二条消息块");
    assert.equal(matches[0].sid, before.sessionId, "重开后重发必须复用原主会话");
    assert.equal(matches[0].b.operationId, before.operationId, "同次重试必须复用同一操作身份");
    assert.equal(matches[0].b.receipt?.status, "accepted", "重发后回执应为已接收");
    await second.close();
  } finally {
    await second.app.close().catch(() => {});
    cleanup(stateDir);
  }
});

test("等待回执期间继续编辑：旧回执不得清新稿，已切走不被拉回", async () => {
  // 注入：应用层已接收，给界面的应答在门文件放行前暂不返回（编辑窗口由测试控制，不靠偶然时序）
  const { page, stateDir, close } = await launchApp(undefined, { DCODE_TEST_SEND_RESULT_GATE: "1" });
  try {
    await ready(page);
    await page.getByRole("heading", { name: "开始一项新工作" }).waitFor();
    await assertValidationModel(page);
    await observeDraftEdits(page);

    const textA = "等待回执期间的原稿甲（已经发送出去的原文内容）";
    const textB = "回执未回时改写的新稿乙（尚未发送）";
    const textC = "另一草稿里的新稿丙（同样不应被覆盖）";
    const composer = page.getByPlaceholder(COMPOSER_PLACEHOLDER);
    await composer.fill(textA);
    await composer.press("Enter");
    // 确认本次提交已在途（唯一主按钮进入「发送中」防重），再开始编辑
    await page.waitForFunction(() => {
      const button = document.querySelector('button[data-slot="composer-primary"]');
      return button?.getAttribute("aria-label") === "发送中" && button.disabled === true;
    });

    // 应答未返回：textarea 仍可编辑 —— 原处改写为 B；再切到另一草稿写 C
    await composer.fill(textB);
    const workspaceRow = page.getByRole("treeitem", { name: "D Code" });
    await workspaceRow.hover();
    const plusButton = workspaceRow.getByRole("button", { name: "在此空间新建任务" });
    await plusButton.waitFor({ state: "visible" });
    await plusButton.click({ force: true });
    await page.getByPlaceholder("任务名称").fill("互不干扰验证");
    await page.getByRole("button", { name: "创建" }).click();
    await page.getByText("D Code / 互不干扰验证", { exact: true }).waitFor();
    await page.getByPlaceholder(COMPOSER_PLACEHOLDER).fill(textC);
    const beforeReceipt = await page.evaluate(() => window.__dcodeCaptureDraft("before-receipt"));
    assert.equal(beforeReceipt.domValue, textC, "放行回执前，新草稿应已完整输入");

    // 放行旧回执：A 已接收。推送通道可能先于应答到达——必须再等「应答续跑」真实完成
    // （发送身份登记被清除为信号），否则断言会跑在续跑之前造成假绿。
    writeFileSync(join(stateDir, "send-result-gate"), "open");
    await waitForSnapshot(page, (s, t) =>
        Object.values(s.timelines)
          .flat()
          .some((b) => b.kind === "message" && b.role === "user" && b.text === t && b.receipt?.status === "accepted"),
      textA);
    await page.waitForFunction(() => {
      const ui = JSON.parse(localStorage.getItem("dcode-prototype-ui-v1") ?? "{}");
      return !("draft:task-home-default" in (ui.operationOfDraft ?? {}));
    });

    await page.evaluate(() => window.__dcodeCaptureDraft("after-receipt"));

    // 用户不被拉回 A 的会话：当前仍是「互不干扰验证」草稿，C 仍在
    await page.getByRole("heading", { name: "开始一项新工作" }).waitFor();
    assert.equal(
      await page.getByPlaceholder(COMPOSER_PLACEHOLDER).inputValue(),
      textC,
      "切走后的新草稿不得被旧回执覆盖",
    );
    const drafts = await page.evaluate(
      () => JSON.parse(localStorage.getItem("dcode-prototype-ui-v1") ?? "{}").drafts ?? {},
    );
    assert.ok(Object.values(drafts).some((v) => v === textB), "等待回执期间改写的 B 不得被旧回执清除");
    assert.ok(Object.values(drafts).some((v) => v === textC), "他处草稿 C 不得被旧快照整体覆盖");

    // A 正确接收：唯一消息块、accepted
    const snap = await page.evaluate(() => window.dcode.getSnapshot());
    const matches = Object.values(snap.timelines)
      .flat()
      .filter((b) => b.kind === "message" && b.role === "user" && b.text === textA);
    assert.equal(matches.length, 1, "A 应只有一条消息记录");
    assert.equal(matches[0].receipt?.status, "accepted", "A 应为已接收");
  } finally {
    try {
      // 任一断言提前失败也要先放行外层应答门，不让取证或退出等待未释放的 hold。
      writeFileSync(join(stateDir, "send-result-gate"), "open");
      const recording = await page.evaluate(() => {
        window.__dcodeStopDraftTrace?.();
        return { captureError: null, trace: window.__dcodeDraftTrace ?? [] };
      }).catch((error) => ({ captureError: String(error), trace: null }));
      mkdirSync(EVIDENCE, { recursive: true });
      writeFileSync(join(EVIDENCE, "draft-input-trace.json"), JSON.stringify(recording, null, 2));
      assert.equal(recording.captureError, null, "取证失败必须明确报告，不能记成空轨迹通过");
    } finally {
      // 证据采集或写盘失败也必须收束隔离应用；关闭失败后强制清理，不遗留测试窗口。
      try { await close(); } finally { await killApp({ stateDir, close }); cleanup(stateDir); }
    }
  }
});

test("等待回执期间原地改写且外层回包丢失：accepted 快照不清新稿、不离开当前草稿", async () => {
  // 同一草稿内 A→B（不切换）：旧应答到达时 B 必须在场且不导航走
  const { page, stateDir, close } = await launchApp(undefined, { DCODE_TEST_SEND_RESULT_GATE: "1", DCODE_TEST_DROP_SEND_RESULT: "1" });
  try {
    await ready(page);
    await page.getByRole("heading", { name: "开始一项新工作" }).waitFor();
    await assertValidationModel(page);

    const textA = "原地改写的原稿甲（已经发送出去的原文内容）";
    const textB = "原地改写的新稿乙（回执未回时写）";
    const composer = page.getByPlaceholder(COMPOSER_PLACEHOLDER);
    await composer.fill(textA);
    await composer.press("Enter");
    await page.waitForFunction(() => {
      const button = document.querySelector('button[data-slot="composer-primary"]');
      return button?.getAttribute("aria-label") === "发送中" && button.disabled === true;
    });
    await composer.fill(textB);

    writeFileSync(join(stateDir, "send-result-gate"), "open");
    // 等应答续跑真实完成（发送身份登记清除为信号），不断言推送先行到达的中间态
    await page.waitForFunction(() => {
      const ui = JSON.parse(localStorage.getItem("dcode-prototype-ui-v1") ?? "{}");
      return !("draft:task-home-default" in (ui.operationOfDraft ?? {}));
    });

    // 仍在同一草稿页，B 在场
    await page.getByRole("heading", { name: "开始一项新工作" }).waitFor();
    assert.equal(await composer.inputValue(), textB, "原地改写的新稿不得被旧回执清除或覆盖");
    const scene = await page.evaluate(() => {
      const ui = JSON.parse(localStorage.getItem("dcode-prototype-ui-v1") ?? "{}");
      return { selectedSessionId: ui.selectedSessionId ?? null, draftTaskId: ui.draftTaskId ?? null };
    });
    assert.equal(scene.draftTaskId, "task-home-default", "已原地改写时不得进入新会话");
    assert.equal(scene.selectedSessionId, null);

    // A 正确接收
    const snap = await page.evaluate(() => window.dcode.getSnapshot());
    const matches = Object.values(snap.timelines)
      .flat()
      .filter((b) => b.kind === "message" && b.role === "user" && b.text === textA);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].receipt?.status, "accepted");
  } finally {
    writeFileSync(join(stateDir, "send-result-gate"), "open");
    try { await close(); } finally { await killApp({ stateDir, close }); cleanup(stateDir); }
  }
});

test("末尾操作验收：长消息待核对→字号/窗口变化后末尾文字行与回查/重试按钮在卡片上方可点", async () => {
  // 依据：主目录 spec/开发任务路径.md「桌面会话输入区」——滚到末尾时末尾内容及末尾操作完整显示在输入卡片上方。
  // 不手工滚到末尾（不掩盖产品自动定位）；每轮几何变化后等贴底跟随重钉（等待产品行为，非手动滚动）。
  const { app, page, stateDir, close } = await launchApp(undefined, { DCODE_MOCK_UNKNOWN_ONCE: "1" });
  const evidence = [];
  try {
    await ready(page);
    await page.getByRole("heading", { name: "开始一项新工作" }).waitFor();
    await assertValidationModel(page);

    // 足够长的多行中英混合消息：时间线真实溢出，末尾操作不钉底就在视口外（验收不自欺）
    const items = [];
    for (let i = 1; i <= 34; i++) {
      items.push(`- 第 ${i} 段中文内容：验证长消息末尾的回查/重试操作在悬浮卡片上方完整可见 line ${i} with English words to wrap around`);
    }
    const text = `末尾操作验收：长多行中英混合消息。\n\n${items.join("\n")}\n\n末段标记：末尾文字行与操作按钮在几何变化后须在卡片上方。`;
    const composer = page.getByPlaceholder(COMPOSER_PLACEHOLDER);
    await composer.fill(text);
    await composer.press("Enter");

    // 待核对：末尾真实用户消息 + 回查按钮
    await page.getByText("待核对", { exact: true }).waitFor();
    // 待核对时取真实 operationId（重试后须不变，且按该 ID 过滤只有一条）
    const opId = await page.evaluate(async (t) => {
      const snap = await window.dcode.getSnapshot();
      const m = Object.values(snap.timelines)
        .flat()
        .find((b) => b.kind === "message" && b.role === "user" && b.text === t);
      return m?.receipt?.operationId ?? null;
    }, text);
    assert.ok(opId, "待核对消息块须有真实 operationId");

    const atBottom = () =>
      page.waitForFunction(() => {
        const s = document.querySelector("main .overflow-y-auto");
        return s.scrollTop + s.clientHeight >= s.scrollHeight - 2;
      });
    // 失败取证：贴底等待超时时保存几何连续样本（视口/scrollTop/max/dock 高/data-tight），
    // 把“等待超时”变成可读到位置与形态连续变化的证据（0628 全量 raw 缺这些样本）。
    const startGeoTrace = () =>
      page.evaluate(() => {
        const s = document.querySelector("main .overflow-y-auto");
        const dock = document.querySelector("[data-slot=composer-dock]");
        const surface = document.querySelector(".input-surface");
        const samples = [];
        const record = (kind) =>
          samples.push({
            t: Math.round(performance.now()),
            kind,
            vp: `${window.innerWidth}x${window.innerHeight}`,
            st: Math.round(s.scrollTop),
            max: Math.round(s.scrollHeight - s.clientHeight),
            dockH: Math.round(dock.getBoundingClientRect().height),
            tight: surface?.dataset.tight ?? null,
          });
        record("init");
        const onScroll = () => record("scroll");
        s.addEventListener("scroll", onScroll, { passive: true });
        let raf = 0;
        const loop = () => {
          record("raf");
          raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);
        window.__dumpGeoTrace = () => {
          cancelAnimationFrame(raf);
          s.removeEventListener("scroll", onScroll);
          return samples.slice(-300);
        };
      });
    const atBottomTraced = async () => {
      try {
        await atBottom();
      } catch (err) {
        const trace = await page.evaluate(() => window.__dumpGeoTrace?.() ?? null).catch(() => null);
        console.error("GEO-TRACE(贴底失败) " + JSON.stringify(trace));
        throw err;
      }
    };
    await startGeoTrace();
    await atBottom(); // 等产品自动定位钉底

    // 末尾测量：末文字行限定在消息正文（.leading-relaxed，排除回执行的徽标/按钮文本）；
    // 按钮按真实 DOM 名称取矩形，中心 elementFromPoint 须命中该按钮（不条件跳过）
    const measureEnd = (btnName) =>
      page.evaluate((name) => {
        const scroller = document.querySelector("main .overflow-y-auto");
        const sr = scroller.getBoundingClientRect();
        // 避让对象是整个输入 dock（卡片 ＋ 卡片之外的 C06 说明）
        const card = document.querySelector("[data-slot=composer-dock]").getBoundingClientRect();
        const col = scroller.querySelector(".space-y-3");
        const rows = [...col.children].filter((el) => el.getBoundingClientRect().height > 1);
        const last = rows[rows.length - 1];
        // 正文容器必须存在：不退回整行（否则末文字行可能测成回执行的按钮/徽标文字）
        const body = last.querySelector('[data-slot="message-body"]');
        const walker = body ? document.createTreeWalker(body, NodeFilter.SHOW_TEXT) : null;
        let node = null;
        let n = null;
        while (walker && (n = walker.nextNode())) {
          if (n.textContent?.trim()) node = n;
        }
        let line = null;
        if (node) {
          const range = document.createRange();
          range.selectNodeContents(node);
          const rects = range.getClientRects();
          line = rects.length ? rects[rects.length - 1] : null;
        }
        const btn = [...scroller.querySelectorAll("button")].find((b) => b.textContent.trim() === name) ?? null;
        const br = btn?.getBoundingClientRect() ?? null;
        const hit = btn && br ? document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2) : null;
        return {
          canScroll: scroller.scrollHeight > scroller.clientHeight + 1,
          bodyFound: !!body,
          scrollerTop: Math.round(sr.top),
          scrollerBottom: Math.round(sr.bottom),
          cardTop: Math.round(card.top),
          lineTop: line ? Math.round(line.top) : null,
          lineBottom: line ? Math.round(line.bottom) : null,
          lineText: node?.textContent?.trim().slice(0, 16) ?? null,
          btnFound: !!btn,
          btnTop: br ? Math.round(br.top) : null,
          btnBottom: br ? Math.round(br.bottom) : null,
          btnHit: btn && br && hit ? hit === btn || btn.contains(hit) : false,
          win: { w: window.innerWidth, h: window.innerHeight },
        };
      }, btnName);
    const assertEnd = (g, label) => {
      assert.ok(g.canScroll, `${label}：时间线须真实溢出（验收不自欺）`);
      assert.ok(g.bodyFound, `${label}：末尾正文容器（[data-slot=message-body]）须存在（不退回整行测量）`);
      assert.ok(g.lineTop !== null, `${label}：须取到末尾正文文字行`);
      assert.ok(g.lineText?.includes("末段标记"), `${label}：末文字行须来自正文末段标记（实际「${g.lineText}」）`);
      assert.ok(g.lineTop >= g.scrollerTop - 1 && g.lineBottom <= g.cardTop + 1, `${label}：末文字行在可视区且在卡片上方 ${JSON.stringify(g)}`);
      assert.ok(g.btnFound, `${label}：须找到按钮`);
      assert.ok(g.btnTop >= g.scrollerTop - 1 && g.btnBottom <= g.cardTop + 1, `${label}：按钮在可视区且在卡片上方 ${JSON.stringify(g)}`);
      assert.ok(g.btnHit, `${label}：按钮中心命中测试须命中该按钮`);
    };

    // 轮次一：14px 默认窗口（发送后自动定位钉底）
    let g = await measureEnd("回查");
    assertEnd(g, "14px/默认窗口");
    evidence.push({ round: "font14-default-window", action: "回查", ...g });

    // 字号 13 → 16：每档变化后等重钉再测
    for (const size of [13, 16]) {
      await page.evaluate((s) => window.dcode.updateSettings({ fontSize: s }), size);
      await page.waitForFunction((s) => getComputedStyle(document.body).fontSize === `${s}px`, size);
      await atBottomTraced();
      g = await measureEnd("回查");
      assertEnd(g, `${size}px`);
      evidence.push({ round: `font${size}`, action: "回查", ...g });
    }

    // 窗口从宽/高到 720×480（16px 保持）：等重钉再测
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setSize(720, 480);
    });
    // setSize 返回早于渲染层 resize：先等真实新视口落地再等重钉（与 scroll.test 同资格），
    // 旧几何上的“已贴底”不得提前放行，也不把未落地的视口当作通过（0628 预审指出的资格缺口）
    await page.waitForFunction(() => window.innerWidth === 720 && window.innerHeight <= 482);
    await atBottomTraced();
    g = await measureEnd("回查");
    assertEnd(g, "16px/720×480");
    evidence.push({ round: "font16-720x480", action: "回查", ...g });

    // 真实点回查：注入场景无提交记录 → 如实显示未找到，不盲投
    await page.getByRole("button", { name: "回查" }).click();
    await page.getByText("未找到提交记录", { exact: false }).waitFor();
    evidence.push({ round: "lookup", result: "未找到提交记录已显示" });

    // 最大字号/紧凑窗口下按真实 DOM 测重试按钮，再真实点击
    await atBottomTraced();
    g = await measureEnd("重试");
    assertEnd(g, "16px/720×480 重试");
    evidence.push({ round: "font16-720x480", action: "重试", ...g });
    await page.getByRole("button", { name: "重试" }).click();
    await page.getByText("已接收", { exact: true }).waitFor();

    // 同 operation 核验：按待核对时记录的真实 operationId 过滤——只有一条、ID 未变、回执已接收
    const snap = await page.evaluate(() => window.dcode.getSnapshot());
    const byOp = Object.values(snap.timelines)
      .flat()
      .filter((b) => b.receipt?.operationId === opId);
    assert.equal(byOp.length, 1, "按 operationId 过滤须只有一条消息块（同 operation 不产生第二条）");
    assert.equal(byOp[0].receipt?.status, "accepted", "重试后该 operation 回执应为已接收");
    assert.equal(byOp[0].text, text, "该 operation 原文不变");
    evidence.push({ round: "final", operationId: opId, sameOperationIdCount: byOp.length, receipt: byOp[0].receipt?.status });
  } finally {
    mkdirSync(EVIDENCE, { recursive: true });
    writeFileSync(join(EVIDENCE, "end-actions-geometry.json"), JSON.stringify(evidence, null, 1));
    writeFileSync(join(stateDir, "send-result-gate"), "open");
    try { await close(); } finally { await killApp({ stateDir, close }); cleanup(stateDir); }
  }
});
