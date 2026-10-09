// 本片验收：新块/流式增长/几何变化共同尊重阅读意图。
// 上翻阅读时不被拉回；在底部继续跟随；回到底部后新块重新跟随。
// 红证据见 doc/验证记录/滚动阅读与视觉矩阵-2026-10-08/evidence/scroll-red-before.json。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchApp, cleanup, ready, assertValidationModel } from "./helpers.mjs";

const EVIDENCE = join(import.meta.dirname, "../../doc/验证记录/滚动阅读与视觉矩阵-2026-10-08/evidence");
mkdirSync(EVIDENCE, { recursive: true });

const geo = (page) =>
  page.evaluate(() => {
    const s = document.querySelector("main .overflow-y-auto");
    return s
      ? {
          scrollTop: Math.round(s.scrollTop),
          scrollHeight: s.scrollHeight,
          clientHeight: s.clientHeight,
          rows: s.querySelector(".space-y-3")?.children.length ?? 0,
        }
      : null;
  });
const atBottom = (g) => g.scrollTop + g.clientHeight >= g.scrollHeight - 2;

const openLongSample = async (page) => {
  await page.getByRole("button", { name: /字号步进器与默认值/ }).click();
  await page.getByRole("button", { name: /本轮改动|files changed/ }).waitFor();
  await page.getByRole("button", { name: /npm run test:inputs/ }).first().click();
  await page.waitForFunction(() => {
    const s = document.querySelector("main .overflow-y-auto");
    return s && s.scrollHeight > s.clientHeight + 4;
  }, null, { timeout: 10_000 });
};

test("阅读意图：上翻阅读时新块到达保持位置（真实长会话 + 真实发送新输入）", async () => {
  const { page, stateDir, close } = await launchApp();
  const evidence = { steps: [] };
  try {
    await ready(page);
    await page.getByRole("heading", { name: "开始一项新工作" }).waitFor();
    await assertValidationModel(page);

    // 真实前提：取已有长会话（内容充裕溢出、初始贴底），用户上翻到阅读位置后
    // 发送新输入——mock 受控装配将按脚本向该会话追加真实新块（count 分支），
    // 阅读位置不得被拉回。与审计缺口同一路径（发送→上翻→新块到达）。
    await openLongSample(page);
    const scrollerSel = "main .overflow-y-auto";
    // 上翻前起点必须真实贴底（等 mount stick + 展开后 RO 跟随完成；区别于无效红的「无溢出起点」）
    await page.waitForFunction(() => {
      const s = document.querySelector("main .overflow-y-auto");
      return s.scrollTop + s.clientHeight >= s.scrollHeight - 2;
    }, null, { timeout: 10_000 });
    const preWheel = await geo(page);
    assert.ok(preWheel.scrollHeight > preWheel.clientHeight + 4, "起点须真实溢出");
    evidence.steps.push({ step: "pre-wheel-atBottom", geo: preWheel });

    await page.locator(scrollerSel).first().hover();
    for (let i = 0; i < 5; i++) {
      const before = (await geo(page)).scrollTop;
      await page.mouse.wheel(0, -1400);
      try {
        await page.waitForFunction((b) => {
          const s = document.querySelector("main .overflow-y-auto");
          const cur = Math.round(s.scrollTop);
          return cur < b || cur === 0;
        }, before, { timeout: 1500 });
      } catch { /* 已到顶 */ }
      if ((await geo(page)).scrollTop === 0) break;
    }
    const reading = await geo(page);
    evidence.steps.push({ step: "reading", geo: reading });
    assert.ok(reading.scrollTop < preWheel.scrollTop, `上翻须真实减少（${preWheel.scrollTop}→${reading.scrollTop}）`);
    assert.ok(!(reading.scrollTop + reading.clientHeight >= reading.scrollHeight - 2), `上翻后须离底 ${JSON.stringify(reading)}`);

    // 真实发送走产品输入通路（mock 将追加新块）——新块到达后阅读位置不得改变
    const composer = page.getByPlaceholder("追问、补充或纠正…");
    await composer.fill("上翻阅读时收到新内容");
    await composer.press("Enter");
    await page.waitForFunction((r) => {
      const s = document.querySelector("main .overflow-y-auto");
      return (s.querySelector(".space-y-3")?.children.length ?? 0) > r.rows;
    }, reading, { timeout: 15_000 });
    // 等真实渲染/effect/布局处理完成再判（两帧），不 DOM 行一出现就提前通过
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const after = await geo(page);
    evidence.steps.push({ step: "after-new-block", geo: after });
    assert.equal(after.scrollTop, reading.scrollTop, `上翻阅读时新块到达不得带走位置（${reading.scrollTop}→${after.scrollTop}）`);
    assert.ok(!(after.scrollTop + after.clientHeight >= after.scrollHeight - 2), "新块到达后仍须离底");
    evidence.verdict = "pass";
  } finally {
    writeFileSync(join(EVIDENCE, "scroll-reading-intent.json"), JSON.stringify(evidence, null, 1));
    await close();
    cleanup(stateDir);
  }
});

test("阅读意图（长会话真实滚轮路径）：离底-回底-发送后跟随恢复", async () => {
  const { page, stateDir, close } = await launchApp();
  const evidence = { steps: [] };
  try {
    await ready(page);
    await page.getByRole("heading", { name: "开始一项新工作" }).waitFor();
    await assertValidationModel(page);
    await openLongSample(page);

    const scrollerSel = "main .overflow-y-auto";
    await page.locator(scrollerSel).first().hover();

    // 真实滚轮离底
    await page.mouse.wheel(0, -1400);
    await page.waitForFunction(() => document.querySelector("main .overflow-y-auto").scrollTop === 0);
    const up = await geo(page);
    evidence.steps.push({ step: "off-bottom", geo: up });

    // 真实滚轮回底
    for (let i = 0; i < 8; i++) {
      await page.mouse.wheel(0, 800);
      await page.waitForTimeout(150);
      if (atBottom(await geo(page))) break;
    }
    const back = await geo(page);
    evidence.steps.push({ step: "back-to-bottom", geo: back });
    assert.ok(atBottom(back), `真实滚轮须回到底部（${JSON.stringify(back)}）`);

    // 新输入触发后续块/流式变化 → 跟随恢复
    const composer = page.getByPlaceholder("追问、补充或纠正…");
    await composer.fill("再验证一次回到底部后的跟随");
    await composer.press("Enter");
    await page.waitForFunction(() => {
      const s = document.querySelector("main .overflow-y-auto");
      return s && s.scrollHeight > s.clientHeight + 4;
    }, null, { timeout: 15_000 });
    // 等 mock 接续段的首块（rows 变化或滚动高度变化）后稳定，跟随应已成
    const before = await geo(page);
    await page.waitForFunction((b) => {
      const s = document.querySelector("main .overflow-y-auto");
      return (s.querySelector(".space-y-3")?.children.length ?? 0) > b.rows || s.scrollHeight > b.scrollHeight;
    }, before, { timeout: 10_000 });
    await page.waitForTimeout(300);
    const after = await geo(page);
    evidence.steps.push({ step: "after-follow", geo: after });
    assert.ok(atBottom(after), `回到底部后跟随须恢复（${JSON.stringify(after)}）`);
    // 末尾内容与操作完整在卡片上方
    const m = await page.evaluate(() => {
      const scroller = document.querySelector("main .overflow-y-auto");
      const col = scroller.querySelector(".space-y-3");
      const rows = [...(col?.children ?? [])];
      const last = rows.reverse().find((el) => el.getBoundingClientRect().height > 1);
      const walker = last ? document.createTreeWalker(last, NodeFilter.SHOW_TEXT) : null;
      let node = null, n = null;
      while (walker && (n = walker.nextNode())) node = n;
      let line = null;
      if (node && node.textContent?.trim()) {
        const range = document.createRange();
        range.selectNodeContents(node);
        const rects = range.getClientRects();
        line = rects.length ? rects[rects.length - 1] : null;
      }
      const card = document.querySelector("textarea")?.closest(".input-surface");
      return {
        endText: (last?.textContent ?? "").slice(-30),
        lineBottom: line ? line.bottom : 0,
        lineTop: line ? line.top : 0,
        cardTop: card?.getBoundingClientRect().top ?? 0,
        scrollerTop: scroller.getBoundingClientRect().top,
      };
    });
    assert.ok(m.endText.length > 0, "末尾定位须取到真实内容行");
    assert.ok(m.lineTop >= m.scrollerTop - 1, "跟随恢复后末行须在可视区上边界以内");
    assert.ok(m.lineBottom <= m.cardTop + 1, "跟随恢复后末行须完整显示在输入卡片上方");
    evidence.verdict = "pass";
  } finally {
    writeFileSync(join(EVIDENCE, "scroll-follow-restore-test.json"), JSON.stringify(evidence, null, 1));
    await close();
    cleanup(stateDir);
  }
});
