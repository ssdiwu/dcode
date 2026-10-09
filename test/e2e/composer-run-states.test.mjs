// 组件接续第一片（2026-10-07）连续场景，一个后台窗口顺序覆盖：
// 隐藏宿主断言 → C01 单主按钮互斥切换 → 运行中发送（故障1 端到端回归）→
// C03/C04/C05 输入选项菜单（分组、互斥可辨、写字时菜单内暂停）→ Esc 只关浮层 →
// 继续的真实 settle 防重（慢于任意时长仍不重发）→ 工具错误复制的可控剪贴板等待/失败。
// 只验证已授权行为；窗口必须真实隐藏且不可获焦点，禁止前台/原生操作。

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchApp, cleanup, ready, assertValidationModel, killApp, waitForSnapshot } from "./helpers.mjs";

test("C01–C06 单主按钮、输入选项菜单与工具错误复制（连续场景）", async () => {
  const { app, page, stateDir, close } = await launchApp(undefined, { DCODE_TEST_RESUME_GATE: "1" });
  try {
    // 隐藏宿主核验：窗口真实不可见且不可获焦点（仅 env 名字不证明宿主支持）
    const host = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      return { visible: win.isVisible(), focusable: win.isFocusable(), focused: win.isFocused() };
    });
    assert.deepEqual(host, { visible: false, focusable: false, focused: false }, "后台验收窗口必须隐藏且不可获焦点");

    await ready(page);
    assert.equal(await page.evaluate(() => "deleteTask" in window.dcode), false, "永久删除不暴露直接桥接");
    await page.getByRole("heading", { name: "开始一项新工作" }).waitFor();
    await assertValidationModel(page);

    const composer = page.getByPlaceholder("交代需求、提问或粘贴内容…");
    await composer.fill("主按钮与菜单连续验证");
    await composer.press("Enter");
    await page.getByText("执行中", { exact: true }).first().waitFor();

    const primary = page.locator('button[data-slot="composer-primary"]');
    const primaryLabel = () => primary.getAttribute("aria-label");
    const followup = page.getByPlaceholder("追问、补充或纠正…");

    // 运行中无新文字 → 暂停
    assert.equal(await primaryLabel(), "暂停", "运行中无新文字：主按钮应为暂停");
    assert.equal(await primary.isDisabled(), false);

    // 运行中输入新文字 → 发送（故障1：不再被 !busy 禁用）
    await followup.fill("运行中补充的第一段");
    assert.equal(await primaryLabel(), "发送", "运行中有新文字：主按钮应为发送");
    assert.equal(await primary.isDisabled(), false, "运行中发送不得被禁用");
    await primary.click();
    const followupBlock = page.locator("div.bg-card").filter({ has: page.getByText("运行中补充的第一段", { exact: true }) });
    await followupBlock.getByText("已接收", { exact: true }).waitFor();
    // 发送清除草稿后无新文字 → 回到暂停
    await page.waitForFunction(() => document.querySelector('button[data-slot="composer-primary"]')?.getAttribute("aria-label") === "暂停");
    await followup.fill("菜单暂停守候稿");
    assert.equal(await primaryLabel(), "发送", "再次写字后主按钮回到发送");

    // C03/C04/C05 输入选项菜单：分组、互斥可辨、写字时仍能暂停
    await page.getByRole("button", { name: "输入选项" }).click();
    await page.getByRole("menu").waitFor();
    await page.getByText("发送方式").waitFor();
    await page.getByText("运行操作").waitFor();
    const steer = page.getByRole("menuitemradio", { name: /引导：立即纳入/ });
    assert.equal(await steer.getAttribute("aria-checked"), "true", "C04 当前发送方式须可辨");
    const menuPause = page.getByRole("menuitem", { name: "暂停" });
    assert.notEqual(await menuPause.getAttribute("aria-disabled"), "true", "C05 写字时菜单内暂停必须可用");
    await menuPause.click();
    await page.getByRole("menu").waitFor({ state: "hidden" });
    await page.getByText("已暂停", { exact: true }).first().waitFor();
    // 暂停不取消草稿
    assert.equal(await followup.inputValue(), "菜单暂停守候稿", "菜单暂停不得取消草稿");

    // 主按钮为继续执行（只恢复不提交草稿），草稿仍在
    assert.equal(await primaryLabel(), "继续执行");

    // 继续在途防重随真实完成：DCODE_TEST_RESUME_GATE 门未开前本次恢复请求真实在途（非时长注入），
    // 第二击在身份守卫下不得再发 resume；开门后只执行一次
    await primary.click();
    await page.waitForFunction(() => {
      const button = document.querySelector('button[data-slot="composer-primary"]');
      return button?.getAttribute("aria-label") === "继续执行" && button.disabled === true;
    });
    await primary.click({ force: true }); // 在途第二击：必须被忽略
    writeFileSync(join(stateDir, "resume-gate"), "open");
    await page.getByText("执行中", { exact: true }).first().waitFor();
    await page.getByText("本轮结束。", { exact: true }).waitFor();
    let resumedMarkers = await page.getByText("从中断处继续", { exact: false }).count();
    assert.equal(resumedMarkers, 1, "在途第二击不得重复发起恢复");

    // Esc 只关闭当前浮层，不改视图/执行
    await page.getByRole("button", { name: "输入选项" }).click();
    await page.getByRole("menu").waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("menu").waitFor({ state: "hidden" });
    assert.notEqual(await page.getByRole("button", { name: "返回" }).count(), 1, "Esc 关闭菜单不得误退出到设置返回");

    // 工具错误复制：真实 Promise 等待/失败分别反馈，剪贴板只在页面内受控覆写
    // （失败工具块默认已自动展开为失败详情，无需点击——点击反而会折叠）
    await page.evaluate(() => {
      const gate = { mode: "hold", resolve: null };
      window.__clipGate = gate;
      window.__clipCalls = [];
      navigator.clipboard.writeText = (text) => {
        window.__clipCalls.push(text);
        switch (gate.mode) {
          case "hold":
            return new Promise((resolve) => { gate.resolve = resolve; });
          case "ok":
            return Promise.resolve();
          case "reject":
            return Promise.reject(new Error("injected-clipboard-denied"));
          default:
            return Promise.resolve();
        }
      };
    });
    const copyButton = page.getByRole("button", { name: /复制错误/ });
    await copyButton.click();
    await page.getByRole("button", { name: "复制中…" }).waitFor();
    // awaiting：Promise 未决不得报已复制
    assert.equal(await page.getByText("已复制").count(), 0, "剪贴板 Promise 未决不得伪报已复制");
    await page.evaluate(() => window.__clipGate.resolve());
    await page.getByRole("button", { name: "已复制" }).waitFor();
    // 拒绝路径：明确反馈复制失败，不伪报成功
    await page.evaluate(() => { window.__clipGate.mode = "reject"; });
    await copyButton.waitFor(); // 等真实提示回流；不按固定时长猜测
    await copyButton.click();
    await page.getByRole("button", { name: "复制失败" }).waitFor();
    const clipCalls = await page.evaluate(() => window.__clipCalls.length);
    assert.equal(clipCalls, 2, "两次复制只复制错误正文，不联动重试工具");
    // 先回到成功后的 idle，再测不可用；不能让上一次“复制失败”冒充本次失败反馈。
    await page.evaluate(() => { window.__clipGate.mode = "ok"; });
    await page.getByRole("button", { name: "复制失败", exact: true }).click();
    await page.getByRole("button", { name: "已复制", exact: true }).waitFor();
    await copyButton.waitFor();
    // 不可用路径：仍走页面内的受控剪贴板，绝不调用系统剪贴板。
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined }));
    await copyButton.click();
    await page.getByRole("button", { name: "复制失败", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__clipCalls.length), 3, "不可用不能假装已经写入");
    resumedMarkers = await page.getByText("从中断处继续", { exact: false }).count();
    assert.equal(resumedMarkers, 1, "复制不得影响运行事实");
  } finally {
    writeFileSync(join(stateDir, "resume-gate"), "open");
    await page.evaluate(() => window.__clipGate?.resolve?.()).catch(() => undefined);
    try { await close(); } finally { await killApp({ stateDir }); cleanup(stateDir); }
  }
});

test("C01 发送身份 A→B→A：第一次 A 迟到完成不释放第三次 A 的在途标记", async () => {
  const handle = await launchApp(undefined, { DCODE_TEST_SEND_RESULT_GATE: "all", DCODE_MOCK_FAST: "0" });
  const { page, stateDir } = handle;
  const waitFile = async (name) => {
    const deadline = Date.now() + 5000;
    while (!existsSync(join(stateDir, name))) {
      if (Date.now() > deadline) throw new Error(`controlled send marker did not arrive: ${name}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  try {
    await ready(page);
    await assertValidationModel(page);
    await page.getByRole("button", { name: "聊聊下个季度的规划", exact: false }).click();
    await page.locator("main header").getByText("聊聊下个季度的规划", { exact: true }).waitFor();
    const composer = page.getByPlaceholder("追问、补充或纠正…");
    const textA = "受控同文交错原稿甲";
    const textB = "受控同文交错新稿乙";
    for (const [index, text] of [textA, textB, textA].entries()) {
      await composer.fill(text);
      await composer.press("Enter");
      await waitFile(`send-result-waiting-${index + 1}`);
    }
    const operations = [1, 2, 3].map((n) => JSON.parse(readFileSync(join(stateDir, `send-result-waiting-${n}`), "utf8")).operationId);
    assert.equal(new Set(operations).size, 3, "三次明确发送各持独立身份，同文不合并");
    const primary = page.locator('button[data-slot="composer-primary"]');
    assert.equal(await primary.getAttribute("aria-label"), "暂停", "第三次 A 已提交，不能再作为新稿");
    writeFileSync(join(stateDir, "send-result-gate-1"), "open");
    await waitFile("send-result-released-1");
    // 同一 IPC 通路的只读往返和下一渲染帧，确认第一份应答的续跑已处理；没有靠长 sleep 推断。
    await page.evaluate(() => window.dcode.getSnapshot());
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    assert.equal(await primary.getAttribute("aria-label"), "暂停", "第一次 A 迟到完成不得清第三次 A 的在途守卫");
    assert.equal(await composer.inputValue(), textA, "第三份应答未回前不清当前草稿");
    const before = await page.evaluate(() => window.dcode.getSnapshot());
    await composer.press("Enter");
    const after = await page.evaluate(() => window.dcode.getSnapshot());
    assert.equal(after.timelines['session-home-1'].filter((b) => b.kind === "message" && b.role === "user" && b.text === textA).length, 2);
    const userCount = (snap) => snap.timelines['session-home-1'].filter((b) => b.kind === "message" && b.role === "user").length;
    assert.equal(userCount(after), userCount(before), "当前旧稿 Enter 不能增加新输入");
    assert.equal(existsSync(join(stateDir, "send-result-waiting-4")), false);
    writeFileSync(join(stateDir, "send-result-gate-3"), "open");
    await page.waitForFunction(() => document.querySelector("textarea")?.value === "");
    writeFileSync(join(stateDir, "send-result-gate-2"), "open");
  } finally {
    writeFileSync(join(stateDir, "send-result-gate"), "open");
    try { await handle.close(); } finally { await killApp(handle); cleanup(stateDir); }
  }
});

test("T08/C01 恢复共用会话 Promise：同帧交错、A 完成时 B 仍在途均不重复", async () => {
  const first = await launchApp();
  const stateDir = first.stateDir;
  let second;
  const ids = ["session-home-1", "session-readme-1"];
  const waitGate = async (sessionId) => {
    const deadline = Date.now() + 5000;
    while (!existsSync(join(stateDir, `resume-waiting-${sessionId}`))) {
      if (Date.now() > deadline) throw new Error(`resume gate did not arrive: ${sessionId}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  try {
    await ready(first.page);
    await assertValidationModel(first.page);
    for (const sessionId of ids) {
      await first.page.evaluate(async (sid) => {
        await window.dcode.sendMessage({ sessionId: sid, text: `controlled recovery ${sid}`, mode: "steer", operationId: `recovery-${sid}` });
        await window.dcode.pauseRun({ sessionId: sid });
      }, sessionId);
    }
    await first.page.getByRole("button", { name: "聊聊下个季度的规划", exact: false }).click();
    await first.page.locator("main header").getByText("聊聊下个季度的规划", { exact: true }).waitFor();
    await first.page.waitForFunction(() => JSON.parse(localStorage.getItem("dcode-prototype-ui-v1") ?? "{}").lastScene?.sessionId === "session-home-1");
    await first.close();
    // 真正重开产生 T08，不能用手填一个恢复条状态冒充生命周期。
    second = await launchApp(stateDir, { DCODE_TEST_RESUME_GATE: "1" });
    const { page } = second;
    await ready(page);
    await page.getByText("已打开上次的工作记录", { exact: false }).waitFor();
    const interleave = () => page.evaluate(() => {
      const primary = document.querySelector('button[data-slot="composer-primary"]');
      const banner = [...document.querySelectorAll("main button")].find((b) => b.textContent.trim() === "继续执行");
      if (!primary || !banner) throw new Error("both recovery entries required");
      primary.click(); banner.click(); primary.click();
    });
    const assertPending = async (sid) => {
      await waitGate(sid);
      const snap = await page.evaluate(() => window.dcode.getSnapshot());
      assert.equal(snap.runs[sid].status, "paused", "门未开不得绕过在途请求恢复");
      assert.equal(snap.timelines[sid].filter((b) => b.kind === "run-marker" && b.marker === "resumed").length, 0);
      const buttons = page.getByRole("button", { name: "继续执行", exact: true });
      assert.equal(await buttons.count(), 2, "恢复条和唯一主按钮都存在");
      for (const button of await buttons.all()) assert.equal(await button.isDisabled(), true);
    };
    await interleave();
    await assertPending(ids[0]);
    await page.getByRole("treeitem", { name: "整理读书笔记", exact: true }).click();
    await page.locator("main header").getByText("《设计中的设计》摘抄", { exact: true }).waitFor();
    await interleave();
    await assertPending(ids[1]);
    writeFileSync(join(stateDir, `resume-gate-${ids[0]}`), "open");
    await waitForSnapshot(page, (s, sid) => s.timelines[sid].some((b) => b.kind === "run-marker" && b.marker === "resumed"), ids[0]);
    // 回 A 等真实请求的 aria-busy 解除，再回 B：不用固定时长猜 A 的外层 Promise 已完成。
    await page.getByRole("treeitem", { name: /^默认任务/ }).first().click();
    await page.locator("main header").getByText("聊聊下个季度的规划", { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('button[data-slot="composer-primary"]')?.getAttribute("aria-busy") === "false");
    await page.getByRole("treeitem", { name: "整理读书笔记", exact: true }).click();
    await page.locator("main header").getByText("《设计中的设计》摘抄", { exact: true }).waitFor();
    await interleave();
    await assertPending(ids[1]);
    writeFileSync(join(stateDir, `resume-gate-${ids[1]}`), "open");
    await page.getByText("本轮结束。", { exact: true }).waitFor();
    const final = await page.evaluate(() => window.dcode.getSnapshot());
    for (const sid of ids) {
      assert.equal(final.timelines[sid].filter((b) => b.kind === "run-marker" && b.marker === "resumed").length, 1);
      assert.equal(final.timelines[sid].filter((b) => b.kind === "message" && b.operationId === `recovery-${sid}`).length, 1);
    }
  } finally {
    writeFileSync(join(stateDir, "resume-gate"), "open");
    if (second) { try { await second.close(); } finally { await killApp(second); } }
    await killApp(first);
    cleanup(stateDir);
  }
});
