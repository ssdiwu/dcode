// 桌面滚动边界验收：各滚动区独立、整页不成为滚动容器。
// 依据：主目录 spec/开发任务路径.md「桌面滚动边界」。
// 与诊断脚本不同，本文件是验收测试；几何证据归档在 test/e2e/evidence/scroll-2026-10-05/。

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { launchApp, cleanup, ready, assertValidationModel, killApp } from "./helpers.mjs";
import { evidenceDir } from "./evidence-root.mjs";

// 新观测落在本片专用的 integration-observations（r2 原证据保留；对照 r2 的 integration-observations 处理）
const EVIDENCE = evidenceDir("scroll");

async function measure(page) {
  return page.evaluate(() => {
    const rect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom) };
    };
    const scroll = (el) =>
      el && {
        scrollTop: Math.round(el.scrollTop),
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        canScroll: el.scrollHeight > el.clientHeight + 1,
      };
    return {
      win: { w: window.innerWidth, h: window.innerHeight, scrollY: window.scrollY },
      doc: scroll(document.documentElement),
      timeline: scroll(document.querySelector("main .overflow-y-auto")),
      sidebar: scroll(document.querySelector("nav .overflow-y-auto")),
      inspector: scroll(document.querySelector("aside .overflow-y-auto")),
      sidebarRect: rect(document.querySelector("nav")),
      // 几何断言对准「容器」而非内容控件：设置条容器（侧栏底部分隔条）与输入 dock
      // （卡片本体 input-surface 壳 ＋ 卡片之外的 C06 说明，二者同为悬浮输入区的实体）
      settingsBar: rect(document.querySelector("nav .border-t")),
      // 底部留边量的是 dock 的内容底（卡片 ＋ C06 说明）到内容区底的间距＝pb-3＝12·s
      composer: rect(document.querySelector("[data-slot=composer-dock] > .pointer-events-auto")),
      composerControl: rect(document.querySelector("textarea")),
      settingsControl: rect(Array.from(document.querySelectorAll("nav button")).pop() ?? null),
      mainRect: rect(document.querySelector("main")),
    };
  });
}

async function wheelOver(page, selector, dy) {
  await page.locator(selector).first().hover();
  await page.mouse.wheel(0, dy);
  await page.waitForTimeout(250);
}

test("滚动边界：目标溢出才可滚、整页不动、几何关系成立（含真实展开动作）", async () => {
  const { app, page, stateDir, close } = await launchApp();
  const evidence = [];
  try {
    await ready(page);
    await page.getByRole("button", { name: /字号步进器与默认值/ }).click();
    await page.getByRole("button", { name: /本轮改动/ }).waitFor();

    // 真实展开动作：点开种子会话里带长输出的工具块
    await page.getByRole("button", { name: /npm run test:inputs/ }).click();
    await page.getByText("260/260 断言通过", { exact: false }).waitFor();

    // 时间线：先记录真实起点（进入会话自动定位 + 贴底跟随会把视图钉在底部），向上滚离底部再验证向下滚
    let before = await measure(page);
    assert.ok(before.timeline.canScroll, "时间线必须可溢出滚动（不能靠裁切通过）");
    evidence.push({
      step: "timeline-start",
      scrollTop: before.timeline.scrollTop,
      max: before.timeline.scrollHeight - before.timeline.clientHeight,
    });
    await wheelOver(page, "main .overflow-y-auto", -400);
    const mid = await measure(page);
    assert.ok(mid.timeline.scrollTop < before.timeline.scrollTop, "向上滚轮须真实滚离底部");
    await wheelOver(page, "main .overflow-y-auto", 600);
    let after = await measure(page);
    assert.equal(after.doc.scrollTop, 0, "时间线滚动不得带动整页");
    assert.equal(after.win.scrollY, 0, "window.scrollY 不动");
    assert.ok(after.timeline.scrollTop > mid.timeline.scrollTop, `时间线自身滚动：${JSON.stringify({ before: mid.timeline, after: after.timeline })}`);
    assert.equal(after.sidebar.scrollTop, mid.sidebar.scrollTop, "侧栏不被带走");
    evidence.push({ step: "timeline-scroll", before: mid, after });

    // 侧栏：造出真实溢出（25 个新任务），然后只滚侧栏
    await page.evaluate(async () => {
      for (let i = 0; i < 25; i++) {
        await window.dcode.createTask({ workspaceId: "ws-home", parentId: null, title: `滚动压测任务 ${i + 1}` });
      }
    });
    await page.getByRole("treeitem", { name: "滚动压测任务 25" }).waitFor();
    before = await measure(page);
    assert.ok(before.sidebar.canScroll, "侧栏树必须真实溢出");
    await wheelOver(page, "nav .overflow-y-auto", 500);
    after = await measure(page);
    assert.ok(after.sidebar.scrollTop > before.sidebar.scrollTop, "侧栏自身必须能滚动");
    assert.equal(after.timeline.scrollTop, before.timeline.scrollTop, "时间线不被侧栏带走");
    assert.equal(after.doc.scrollTop, 0, "整页不动");
    evidence.push({ step: "sidebar-scroll", before, after });

    // 检查器：打开 diff，选内容最长的文件标签并压到最小窗口，制造真实溢出
    await page.getByRole("button", { name: /本轮改动/ }).click();
    await page.locator("aside .overflow-y-auto").waitFor();
    await page.locator("aside").getByRole("button", { name: "SettingsPage.tsx" }).click();
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setSize(1100, 480);
    });
    await page.waitForTimeout(250);
    before = await measure(page);
    assert.ok(before.inspector.canScroll, "检查器必须真实溢出");
    await wheelOver(page, "aside .overflow-y-auto", 400);
    after = await measure(page);
    assert.ok(after.inspector.scrollTop > before.inspector.scrollTop, "检查器自身必须能滚动");
    assert.equal(after.timeline.scrollTop, before.timeline.scrollTop, "时间线不被检查器带走");
    assert.equal(after.doc.scrollTop, 0, "整页不动");
    evidence.push({ step: "inspector-scroll", before, after });

    // 末尾可达：滚到时间线末尾后，末尾真实「文字行」（Range 末行 rect）与末尾操作须完整显示在输入卡片上方
    // （sticky 卡片在文档流末位回到内容之后；长消息块 top 在屏外属正确行为，只核末行/末尾操作）
    const endGeo = await page.evaluate(() => {
      const scroller = document.querySelector("main .overflow-y-auto");
      scroller.scrollTop = scroller.scrollHeight;
      const contentCol = scroller.querySelector(".space-y-3");
      const rows = [...(contentCol?.children ?? [])];
      const last = rows.reverse().find((el) => el.getBoundingClientRect().height > 1);
      let lastLine = null;
      if (last) {
        const walker = document.createTreeWalker(last, NodeFilter.SHOW_TEXT);
        let node = null;
        let n = null;
        while ((n = walker.nextNode())) node = n;
        if (node && node.textContent?.trim()) {
          const range = document.createRange();
          range.selectNodeContents(node);
          const rects = range.getClientRects();
          lastLine = rects.length ? rects[rects.length - 1] : null;
        }
      }
      // 避让对象是整个输入 dock（卡片 ＋ 卡片之外的 C06 说明），不是只量卡片本体
      const dock = document.querySelector("[data-slot=composer-dock]");
      return {
        endText: (last?.textContent ?? "").slice(-30),
        lineBottom: lastLine ? lastLine.bottom : 0,
        lineTop: lastLine ? lastLine.top : 0,
        cardTop: dock?.getBoundingClientRect().top ?? 0,
        scrollerTop: scroller.getBoundingClientRect().top,
        actionBottom: last?.querySelector("button")?.getBoundingClientRect().bottom ?? null,
      };
    });
    assert.ok(endGeo.endText.length > 0, "末尾定位必须取到真实内容行（非空锚点）");
    assert.ok(endGeo.lineTop >= endGeo.scrollerTop - 1, "末尾文字行须在可视区上边界以内");
    assert.ok(endGeo.lineBottom <= endGeo.cardTop + 1, "末尾文字行须完整显示在输入 dock 上方（不遮挡）");
    if (endGeo.actionBottom !== null) {
      assert.ok(endGeo.actionBottom <= endGeo.cardTop + 1, "末尾操作须完整显示在 dock 上方");
    }
    evidence.push({ step: "end-reachability", endGeo });

    // 卡片外留白仍是时间线表面：在卡片旁的留白条滚轮 → 时间线滚动；命中测试不落在穿透包裹层
    // 探针落在 dock 的水平内边距里（卡片左侧的留白条）：它在 dock 之内但不在卡片之内，
    // 且 dock 根节点 pointer-events:none，命中应穿透到时间线内容
    const strip = await page.evaluate(() => {
      const card = document.querySelector("textarea").closest(".input-surface").getBoundingClientRect();
      return { x: card.left - 8, y: card.top + 4 };
    });
    const hit = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      return { tag: el?.tagName ?? null, inWrapper: !!el?.closest(".pointer-events-none") };
    }, strip);
    assert.ok(hit.tag && !hit.inWrapper, "留白处命中测试须穿透到时间线内容，不落在 dock 包裹层");
    const beforeWheel = await measure(page);
    await page.mouse.move(strip.x, strip.y);
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(200);
    const afterWheel = await measure(page);
    assert.ok(afterWheel.timeline.scrollTop < beforeWheel.timeline.scrollTop, "留白处滚轮须滚动时间线（消息可经过卡片后方）");
    evidence.push({ step: "margin-pass-through", strip, hit });

    // 几何关系：侧栏顶底在窗口内、设置条容器贴侧栏底部；
    // 输入区为悬浮留边 dock（卡片 ＋ 卡片之外的 C06 说明）：dock 底与内容区底之间是 12·s 留边（不再贴底），完整在窗内
    const geo = await measure(page);
    assert.ok(geo.sidebarRect.top >= 0 && geo.sidebarRect.bottom <= geo.win.h + 1, "侧栏顶底须在窗口内");
    assert.ok(Math.abs(geo.settingsBar.bottom - geo.sidebarRect.bottom) <= 1, "设置条容器须贴侧栏底部");
    const margin = 12 * ((await page.evaluate(() => Number(getComputedStyle(document.documentElement).getPropertyValue("--ui-font-size-num")))) / 14);
    const gap = geo.mainRect.bottom - geo.composer.bottom;
    assert.ok(Math.abs(gap - margin) <= 1.5, `输入 dock 底部留边应为 12·s（实际 ${gap.toFixed(1)}，期望 ${margin.toFixed(1)}）`);
    assert.ok(
      geo.composerControl.bottom <= geo.win.h + 1 && geo.settingsControl.bottom <= geo.win.h + 1,
      "控件本体须完全在窗口内可见",
    );
    evidence.push({ step: "geometry", geo });
  } finally {
    mkdirSync(EVIDENCE, { recursive: true });
    writeFileSync(join(EVIDENCE, "scroll-e2e-geometry.json"), JSON.stringify(evidence, null, 1));
    await close();
    cleanup(stateDir);
  }
});

test("滚动边界四组合：中文/英文 × 13px/14px", async () => {
  const combos = [
    { lang: "zh", fontSize: 14 },
    { lang: "zh", fontSize: 13 },
    { lang: "en", fontSize: 14 },
    { lang: "en", fontSize: 13 },
  ];
  // 四组只改变同一会话的语言和字号，复用一个隔离窗口，不重复启动客户端。
  const { app, page, stateDir, close } = await launchApp();
  try {
    await ready(page);
    await page.getByRole("button", { name: /字号步进器与默认值/ }).click();
    await page.getByRole("button", { name: /files changed|本轮改动/ }).waitFor();
    for (const combo of combos) {
      await page.evaluate(async (c) => {
        await window.dcode.updateSettings({ language: c.lang, fontSize: c.fontSize });
      }, combo);
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0].setSize(1100, 560);
      });
      await page.waitForTimeout(250);
      const actual = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
      const start = await measure(page);
      await wheelOver(page, "main .overflow-y-auto", -300);
      const before = await measure(page);
      assert.ok(
        before.timeline.scrollTop < start.timeline.scrollTop,
        `${combo.lang}/${combo.fontSize}px 向上滚离底部（起点 scrollTop=${start.timeline.scrollTop}/max=${start.timeline.scrollHeight - start.timeline.clientHeight}）`,
      );
      await wheelOver(page, "main .overflow-y-auto", 500);
      const after = await measure(page);
      assert.equal(after.doc.scrollTop, 0, `${combo.lang}/${combo.fontSize}px 整页不动（实际窗口 ${actual.w}×${actual.h}）`);
      assert.ok(after.timeline.scrollTop > before.timeline.scrollTop, `${combo.lang}/${combo.fontSize}px 时间线可滚`);
    }
  } finally {
    try { await close(); } finally { await killApp({ stateDir, close }); cleanup(stateDir); }
  }
});

// 末尾定位的共享测量：Range 末行 rect + 卡片/滚动容器几何（与上文末尾断言同口径）
async function measureEnd(page) {
  return page.evaluate(() => {
    const scroller = document.querySelector("main .overflow-y-auto");
    const contentCol = scroller.querySelector(".space-y-3");
    const rows = [...(contentCol?.children ?? [])];
    const last = rows.reverse().find((el) => el.getBoundingClientRect().height > 1);
    let lastLine = null;
    if (last) {
      const walker = document.createTreeWalker(last, NodeFilter.SHOW_TEXT);
      let node = null;
      let n = null;
      while ((n = walker.nextNode())) node = n;
      if (node && node.textContent?.trim()) {
        const range = document.createRange();
        range.selectNodeContents(node);
        const rects = range.getClientRects();
        lastLine = rects.length ? rects[rects.length - 1] : null;
      }
    }
    const dock = document.querySelector("[data-slot=composer-dock]");
    return {
      endText: (last?.textContent ?? "").slice(-30),
      lineBottom: lastLine ? lastLine.bottom : 0,
      lineTop: lastLine ? lastLine.top : 0,
      cardTop: dock?.getBoundingClientRect().top ?? 0,
      scrollerTop: scroller.getBoundingClientRect().top,
      scrollH: scroller.scrollHeight,
      clientH: scroller.clientHeight,
    };
  });
}

test("新内容追加自动定位：末尾文字行在可视区且在卡片上方（不手动滚动）", async () => {
  const { page, stateDir, close } = await launchApp();
  try {
    await ready(page);
    await page.getByRole("heading", { name: "开始一项新工作" }).waitFor();
    await assertValidationModel(page);
    // 真实发送触发产品自动定位（mock 脚本陆续追加多个块）；全程不手动滚动
    const composer = page.getByPlaceholder("交代需求、提问或粘贴内容…");
    await composer.fill("验证新内容追加后自动定位到卡片上方");
    await composer.press("Enter");
    await page.getByText("本轮结束。", { exact: true }).waitFor();
    const geo = await measureEnd(page);
    assert.ok(geo.endText.includes("本轮结束"), `自动定位后末行应为本轮结束标记（实际 ${geo.endText}）`);
    assert.ok(geo.lineTop >= geo.scrollerTop - 1, "自动定位后末行须在可视区上边界以内");
    assert.ok(geo.lineBottom <= geo.cardTop + 1, "自动定位后末行须完整显示在输入卡片上方（不被卡片遮住）");
  } finally {
    await close();
    cleanup(stateDir);
  }
});

test("短会话不多出滚动空间：消息列与 dock 共用自然高度", async () => {
  // 短会话（2 条消息）本可同屏容纳：scrollHeight 不超过视口高（dock 不再额外贡献一卡片高滚动）
  const { page, stateDir, close } = await launchApp();
  try {
    await ready(page);
    await assertValidationModel(page);
    await page.getByRole("button", { name: /聊聊下个季度的规划/ }).click();
    await page.getByText("写作流沉淀", { exact: false }).waitFor();
    const geo = await measureEnd(page);
    assert.ok(
      geo.scrollH <= geo.clientH + 1,
      `短会话不应多出滚动空间（scrollH=${geo.scrollH} clientH=${geo.clientH}）`,
    );
    assert.ok(geo.lineTop >= geo.scrollerTop - 1, "短会话末行在视口内（不在上边界外）");
  } finally {
    await close();
    cleanup(stateDir);
  }
});

test("悬浮卡片留白真实交互与卡片高度变化（字号/窗口/检查器）", async () => {
  const { page, stateDir, close } = await launchApp();
  const evidenceMargin = { dragSelected: null, wordSelected: null, note: "拖选在本 Electron/CDP 环境不扩展选区（含普通区，探针 drag2），双击选词为文字选择证据" };
  try {
    await ready(page);
    await assertValidationModel(page);
    await page.getByRole("button", { name: /字号步进器与默认值/ }).click();
    await page.getByRole("button", { name: /本轮改动/ }).waitFor();

    // 真实长中英文输入（多行混合）：写入会话输入区并保留
    const longText = "第一段中文：这是一个较长的中文句子，用来验证悬浮卡片在长内容输入下的表现。\nSecond line in English: a longer English sentence to verify mixed input behavior.\n第三段混合 with code `const x = 1` 与路径 src/renderer/views/Timeline.tsx。";
    const composer = page.getByPlaceholder("追问、补充或纠正…");
    await composer.fill(longText);
    assert.equal(await composer.inputValue(), longText, "长中英文输入须完整保留");

    // 展开长工具块，确保时间线充裕溢出（对齐留白带需要真实滚动行程）
    await page.getByRole("button", { name: /npm run test:inputs/ }).click();
    await page.getByText("260/260 断言通过", { exact: false }).waitFor();

    // dock 底部留白穿透：把一条真实消息文本行用滚轮对齐到 dock 下方的 pb 留白带。
    // 测试点必须在 dock 包裹层矩形下方、内容区底部以内，且其下方是真实消息——
    // dock 上方的普通内容区不算留白穿透证据；dock 内部（卡片与 C06 说明）本身是输入区的实体，不算留白。
    const scrollerSel = "main .overflow-y-auto";
    // 目标行：内容里最后一条长度≥12 且足够宽的消息文本节点（靠近内容末尾，才能用真实滚轮对齐进 dock 下方留白带；
    // 靠近顶部的行在 scrollTop=0 处就到不了底部留白带）。按文本内容稳定重新定位，不持有跨 evaluate 的节点引用。
    const findTarget = () =>
      page.evaluate(() => {
        const dockEl = document.querySelector("[data-slot=composer-dock]");
        const card = dockEl.getBoundingClientRect();
        const content = dockEl.querySelector(".pointer-events-auto").getBoundingClientRect();
        const rows = [...document.querySelectorAll("main .overflow-y-auto .space-y-3 > *")];
        let found = null;
        for (const row of rows) {
          const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
          let n;
          while ((n = walker.nextNode())) {
            const t = n.textContent?.trim() ?? "";
            if (t.length < 12) continue;
            const range = document.createRange();
            range.selectNodeContents(n);
            const rects = range.getClientRects();
            const r = rects[rects.length - 1];
            if (!r || r.width < 120) continue;
            found = { text: t.slice(0, 10), cy: r.top + r.height / 2, left: r.left, width: r.width };
          }
        }
        if (!found) return null;
        return {
          ...found,
          // 真实剩余留白＝dock 内容底到 dock 底之间的 pb 条；dock 内部（卡片与 C06 说明）是输入区实体，不算留白
          bandTop: content.bottom + 1,
          bandBottom: card.bottom - 1,
          card: { top: card.top, bottom: card.bottom, left: card.left, right: card.right },
          wrap: { top: content.top, bottom: content.bottom, left: content.left, right: content.right },
        };
      });
    // 正常滚轮把目标行中心对齐进留白带（粗调后精调，不直接设 scrollTop、不设 selection）
    let target = await findTarget();
    assert.ok(target, "须存在可定位的消息文本行");
    for (let i = 0; i < 60; i++) {
      const mid = (target.bandTop + target.bandBottom) / 2;
      if (target.cy >= target.bandTop && target.cy <= target.bandBottom) break;
      const delta = target.cy - mid;
      const step = Math.abs(delta) > 60 ? Math.sign(delta) * 60 : delta;
      await page.locator(scrollerSel).first().hover();
      await page.mouse.wheel(0, step);
      await page.waitForTimeout(150);
      target = await findTarget();
      assert.ok(target, "滚动后目标行须仍可定位");
    }
    assert.ok(
      target.cy >= target.bandTop && target.cy <= target.bandBottom,
      `目标行中心须落入 dock 下方留白带（cy=${target.cy.toFixed(1)}，带=[${target.bandTop.toFixed(1)}, ${target.bandBottom.toFixed(1)}]）`,
    );
    const point = { x: target.left + 8, y: target.cy };
    // 断言测试点位置：dock 包裹层矩形内、卡片矩形外
    assert.ok(
      point.y > target.wrap.bottom && point.y < target.card.bottom,
      "测试点须在 dock 内容底与 dock 底之间的真实剩余留白带内",
    );
    assert.ok(
      !(point.x > target.card.left && point.x < target.card.right && point.y > target.card.top && point.y < target.wrap.bottom),
      "测试点须在输入 dock 的内容矩形外",
    );

    // 留白处命中测试：穿透到下方真实消息文本，不落在穿透包裹层
    const hit = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      return {
        tag: el?.tagName ?? null,
        inWrapper: !!el?.closest(".pointer-events-none"),
        inTimeline: !!el?.closest(".space-y-3"),
        text: el?.textContent?.trim().slice(0, 10) ?? null,
      };
    }, point);
    assert.ok(hit.tag && !hit.inWrapper && hit.inTimeline, `留白处命中须穿透到时间线消息（实际 ${hit.tag}「${hit.text}」）`);

    // 留白处真实点击：选区锚点落在目标消息文本内
    await page.mouse.click(point.x, point.y);
    const anchor = await page.evaluate(() => {
      const sel = window.getSelection();
      const node = sel?.anchorNode;
      const el = node ? (node.nodeType === 3 ? node.parentElement : node) : null;
      return { inTimeline: !!el?.closest(".space-y-3"), text: node?.textContent?.trim().slice(0, 10) ?? null };
    });
    assert.ok(anchor.inTimeline, `留白处点击须作用于时间线消息内容（实际锚点「${anchor.text}」）`);

    // 留白处真实拖选：记录真实结果作证据。边界：本 Electron/CDP 环境下合成鼠标拖拽在任何位置
    //（含无覆盖的普通文本区）都不扩展选区（探针 /tmp/dcode-probe-drag2.log），属工装限制而非本片产品缺陷；
    // 文字可选择性由下同一点的鼠标双击选词证明（真实双击，不直接设置 selection）。
    await page.mouse.move(target.left + 2, target.cy);
    await page.mouse.down();
    await page.mouse.move(target.left + Math.min(target.width - 4, 90), target.cy, { steps: 5 });
    await page.mouse.up();
    const dragSelected = await page.evaluate(() => window.getSelection()?.toString() ?? "");

    // 同一真实留白点双击选词：文字选择须真实作用于消息文本
    await page.mouse.click(point.x, point.y, { clickCount: 2 });
    await page.waitForTimeout(120);
    const wordSelected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
    assert.ok(wordSelected.trim().length > 0, `留白处双击须真实选中消息文字（选中「${wordSelected.trim().slice(0, 14)}」）`);
    evidenceMargin.dragSelected = dragSelected;
    evidenceMargin.wordSelected = wordSelected;

    // 留白处滚轮：时间线真实滚动
    const wheelBefore = await page.locator(scrollerSel).evaluate((el) => el.scrollTop);
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel(0, -240);
    await page.waitForTimeout(200);
    const wheelAfter = await page.locator(scrollerSel).evaluate((el) => el.scrollTop);
    assert.notEqual(wheelAfter, wheelBefore, "留白处滚轮须真实滚动时间线");

    // 卡片高度变化：已到末尾后改字号（13→16→13），不手动再滚，末行与卡片关系仍成立
    await page.locator(scrollerSel).evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await measureEnd(page);
    for (const size of [16, 13]) {
      const cardHBefore = await page.evaluate(() => document.querySelector("textarea")?.closest(".input-surface")?.getBoundingClientRect().height ?? 0);
      await page.evaluate((s) => window.dcode.updateSettings({ fontSize: s }), size);
      await page.waitForFunction((s) => getComputedStyle(document.body).fontSize === `${s}px`, size);
      const cardHAfter = await page.evaluate(() => document.querySelector("textarea")?.closest(".input-surface")?.getBoundingClientRect().height ?? 0);
      assert.notEqual(cardHAfter, cardHBefore, `字号切到 ${size} 卡片高度须真实变化`);
      // 不手动再滚：贴底跟随效应自动钉回真实底部
      await page.waitForFunction(() => {
        const scroller = document.querySelector("main .overflow-y-auto");
        return scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
      });
      const geo = await measureEnd(page);
      assert.ok(geo.lineTop >= geo.scrollerTop - 1 && geo.lineBottom <= geo.cardTop + 1, `${size}px 后末行须在可视区且在卡片上方`);
    }
  } finally {
    mkdirSync(EVIDENCE, { recursive: true });
    writeFileSync(join(EVIDENCE, "margin-interaction.json"), JSON.stringify(evidenceMargin, null, 1));
    await close();
    cleanup(stateDir);
  }
});

test("贴底跟随：纯高度缩窗与检查器开闭自动重钉，上翻后不被几何变化拉回", async () => {
  const { app, page, stateDir, close } = await launchApp();
  try {
    await ready(page);
    await assertValidationModel(page);
    await page.getByRole("button", { name: /字号步进器与默认值/ }).click();
    await page.getByRole("button", { name: /本轮改动/ }).waitFor();
    // 展开长工具块，保证充裕溢出
    await page.getByRole("button", { name: /npm run test:inputs/ }).click();
    await page.getByText("260/260 断言通过", { exact: false }).waitFor();

    const geo = () =>
      page.evaluate(() => {
        const s = document.querySelector("main .overflow-y-auto");
        return { w: window.innerWidth, h: window.innerHeight, scrollTop: Math.round(s.scrollTop), max: s.scrollHeight - s.clientHeight };
      });
    const atBottom = (g) => g.scrollTop >= g.max - 2;
    const waitPinned = () =>
      page.waitForFunction(() => {
        const s = document.querySelector("main .overflow-y-auto");
        return s.scrollTop + s.clientHeight >= s.scrollHeight - 2;
      });
    // 失败取证：贴底等待超时时保存几何连续样本（视口/scrollTop/max/dock 高/data-tight），
    // 把“等待超时”变成可读到位置与形态连续变化的证据（0628 两份全量 raw 缺这些样本，
    // 无法把失败动作与源码连接；此后失败会随 raw 留下完整几何序列）。
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
    const waitPinnedTraced = async () => {
      try {
        await waitPinned();
      } catch (err) {
        const trace = await page.evaluate(() => window.__dumpGeoTrace?.() ?? null).catch(() => null);
        console.error("GEO-TRACE(贴底失败) " + JSON.stringify(trace));
        throw err;
      }
    };

    // 先固定到 1100×900 并确认钉底（进入会话自动定位 + 展开重钉）
    await startGeoTrace();
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setSize(1100, 900);
    });
    // setSize 返回早于渲染层 resize；先等真实视口，避免旧几何的“已贴底”提前放行。
    await page.waitForFunction(() => window.innerWidth === 1100 && window.innerHeight === 900);
    await waitPinnedTraced();
    const g900 = await geo();
    assert.ok(atBottom(g900), `进入会话展开后须钉在底部（${JSON.stringify(g900)}）`);

    // 纯高度缩窗：宽不变 900→480。内容列高度不变，仅 clientHeight/最大 scrollTop 变化——
    // 这正是「只观察内容列的 ResizeObserver」覆盖不到的一路（红信号点）
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setSize(1100, 480);
    });
    await page.waitForFunction(() => window.innerWidth === 1100 && window.innerHeight <= 482);
    await waitPinnedTraced();
    const g480 = await geo();
    assert.ok(g480.w === 1100 && g480.h <= 482, `须为纯高度缩窗（实际 ${g480.w}×${g480.h}）`);
    assert.ok(atBottom(g480), `纯高度缩窗后须自动重钉底部，不手动再滚（${JSON.stringify(g480)}）`);
    const end480 = await measureEnd(page);
    assert.ok(
      end480.lineTop >= end480.scrollerTop - 1 && end480.lineBottom <= end480.cardTop + 1,
      "缩窗重钉后末行须在可视区且在卡片上方",
    );

    // 检查器开闭：主区宽度变化 → 自动重钉
    await page.getByRole("button", { name: /本轮改动/ }).click();
    await page.locator("aside .overflow-y-auto").waitFor();
    await waitPinnedTraced();
    assert.ok(atBottom(await geo()), "检查器打开后须仍钉底部");
    await page.getByRole("button", { name: "关闭检查器" }).click();
    await waitPinnedTraced();
    assert.ok(atBottom(await geo()), "检查器关闭后须仍钉底部");

    // 用户上翻后不被几何变化拉回：滚离底部再长高窗口，位置不动、不回底部
    await page.locator("main .overflow-y-auto").first().hover();
    await page.mouse.wheel(0, -600);
    await page.waitForTimeout(200);
    const up = await geo();
    assert.ok(!atBottom(up), `上翻后须离开底部（${JSON.stringify(up)}）`);
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setSize(1100, 700);
    });
    await page.waitForTimeout(300);
    const grown = await geo();
    assert.ok(!atBottom(grown), `上翻后几何变化不得拉回底部（${JSON.stringify(grown)}）`);
    assert.ok(Math.abs(grown.scrollTop - up.scrollTop) <= 2, `上翻后几何变化不得改变滚动位置（${up.scrollTop}→${grown.scrollTop}）`);

    // 反例：贴底时上翻少量（30px）后再开检查器/字号变大，不得把用户拉回底部
    //（重排锚定/钳制的 scroll 与旧几何快照不符，不覆盖保留的「已离开底部」意图。保护「离开底部一点点阅读」的用户）
    await page.locator("main .overflow-y-auto").evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await waitPinnedTraced();
    await page.locator("main .overflow-y-auto").first().hover();
    await page.mouse.wheel(0, -30);
    await page.waitForTimeout(200);
    const slightlyUp = await geo();
    assert.ok(!atBottom(slightlyUp), `上翻 30px 须离开底部（${JSON.stringify(slightlyUp)}）`);
    await page.getByRole("button", { name: /本轮改动/ }).click();
    await page.locator("aside .overflow-y-auto").waitFor();
    await page.waitForTimeout(400);
    const afterOpen = await geo();
    assert.ok(!atBottom(afterOpen), `上翻少量后开检查器不得拉回底部（${JSON.stringify(afterOpen)}）`);
    await page.getByRole("button", { name: "关闭检查器" }).click();
    await page.waitForTimeout(300);
    // 字号变大（内容变高、无钳制方向）同样不得拉回
    await page.evaluate(() => window.dcode.updateSettings({ fontSize: 16 }));
    await page.waitForFunction(() => getComputedStyle(document.body).fontSize === "16px");
    await page.waitForTimeout(300);
    const afterFont = await geo();
    assert.ok(!atBottom(afterFont), `上翻少量后字号变化不得拉回底部（${JSON.stringify(afterFont)}）`);
    await page.evaluate(() => window.dcode.updateSettings({ fontSize: 14 }));
    await page.waitForFunction(() => getComputedStyle(document.body).fontSize === "14px");
    // 字号恢复的重排级联（重包行/卡片重测/贴底重钉）未收束时写 scrollTop 会被
    // 「几何已变＝锚定」分支按旧几何归类，跟随更新落空（GEO-TRACE 取证过的偶发红）。
    // 收束判据是可观察的稳定序列：视口、字号、scrollTop/scrollHeight/clientHeight、
    // dock 高与收起态连续 3 次采样（100ms 轮询，options 须在第三参——第二参是传给
    // 判据的 arg）完全不变；不用固定延时声称收束。每次判据回调记录真实时刻，
    // 等待结束后以间隔断言公开采样资格（排除默认 rAF，见下方 SETTLE-SAMPLING）。
    await page.waitForFunction(
      () => {
        const w0 = window;
        if (!Array.isArray(w0.__settleSamples)) w0.__settleSamples = [];
        w0.__settleSamples.push(performance.now());
        const s = document.querySelector("main .overflow-y-auto");
        const dock = document.querySelector("[data-slot=composer-dock]");
        const surface = document.querySelector(".input-surface");
        const key = [
          window.innerWidth,
          window.innerHeight,
          getComputedStyle(document.body).fontSize,
          Math.round(s.scrollTop),
          Math.round(s.scrollHeight),
          Math.round(s.clientHeight),
          Math.round(dock.getBoundingClientRect().height),
          surface?.dataset.tight ?? null,
        ].join("|");
        const w = window;
        if (w.__settleKey !== key) {
          w.__settleKey = key;
          w.__settleCount = 0;
          return false;
        }
        w.__settleCount = (w.__settleCount ?? 0) + 1;
        return w.__settleCount >= 3;
      },
      undefined,
      { polling: 100, timeout: 10_000 },
    );
    // 采样资格取证：公开真实回调时刻与间隔；可辨断言排除默认 rAF 轮询——
    // rAF 按帧派发（≈16.7ms），100ms 轮询的实际间隔不会低于 50ms。
    // 若 options 误放第二参（arg），实际按默认 rAF 跑，此断言变红，不靠口头声称。
    const settleSamples = await page.evaluate(() => {
      const t = window.__settleSamples ?? [];
      delete window.__settleSamples;
      return t.map((x) => Math.round(x));
    });
    const settleIntervals = settleSamples.slice(1).map((t, i) => t - settleSamples[i]);
    const minInterval = settleIntervals.length ? Math.min(...settleIntervals) : null;
    console.log("SETTLE-SAMPLING(ms)", JSON.stringify({ samples: settleSamples, intervals: settleIntervals, minInterval }));
    assert.ok(
      settleIntervals.length >= 3,
      `稳定判据须来自至少 4 次真实轮询回调（实得 ${settleSamples.length} 次回调、${settleIntervals.length} 个间隔）`,
    );
    assert.ok(
      minInterval !== null && minInterval >= 50,
      `收束采样须为 100ms 轮询档（实得最小间隔 ${minInterval}ms；默认 rAF 帧间隔约 16.7ms，低于 50ms 即说明 options 未生效）`,
    );

    // 非滚轮滚动路径：键盘 PageUp/PageDown 同样更新跟随意图（几何快照方案不枚举输入类型）
    // 先钉回底部；点击时间线内可见的聚合卡按钮持焦（钉底时它可见、点击不触发自动滚动；
    // 它同时打开检查器——本身即一次几何变化，贴底须保持）
    await page.locator("main .overflow-y-auto").evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await waitPinnedTraced();
    await page.getByRole("button", { name: /本轮改动/ }).click();
    await page.locator("aside .overflow-y-auto").waitFor();
    await waitPinnedTraced();
    const kbStart = await geo();
    assert.ok(atBottom(kbStart), `键盘路径起点须钉在底部（${JSON.stringify(kbStart)}）`);
    await page.keyboard.press("PageUp");
    await page.waitForTimeout(200);
    const kbUp = await geo();
    assert.ok(kbUp.scrollTop < kbStart.scrollTop, `键盘 PageUp 须真实滚动时间线（${kbStart.scrollTop}→${kbUp.scrollTop}）`);
    // 键盘上翻后几何变化（纯缩高）不得拉回
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setSize(1100, 560);
    });
    await page.waitForTimeout(300);
    const kbGrown = await geo();
    assert.ok(!atBottom(kbGrown), `键盘上翻后几何变化不得拉回底部（${JSON.stringify(kbGrown)}）`);
    // 键盘 PageDown 回到底部后恢复跟随：再纯缩高须自动重钉
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("PageDown");
      await page.waitForTimeout(120);
      if (atBottom(await geo())) break;
    }
    assert.ok(atBottom(await geo()), "键盘 PageDown 须能回到底部");
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setSize(1100, 480);
    });
    await waitPinnedTraced();
    assert.ok(atBottom(await geo()), "键盘回底后纯缩高须自动重钉");
  } finally {
    await close();
    cleanup(stateDir);
  }
});


// F3 独立完整动作：真实 wheel / PageUp-PageDown / 经典滚动条 thumb，分别与重排交错。
// 这条是新受控动作覆盖，不声称逐字复现旧 #617；不写 scrollTop，也不等待稳定来避开交错。
test("F3 真实滚轮/键盘/经典滚动条与重排交错：上翻保阅读、回底恢复跟随、草稿暂收后恢复", async () => {
  const handle = await launchApp(undefined, undefined, ".", { classicScrollbars: true });
  const { app, page, stateDir } = handle;
  let primary = null;
  const evidence = { source: "mock sample 字号步进器与默认值 / long tool", phases: [], trace: null };
  const scrollerSelector = "main .overflow-y-auto";
  const draft = Array.from({ length: 6 }, (_, index) => `第 ${index + 1} 行 F3 草稿：保留文字与光标。Keep this draft editable.`).join("\n");
  try {
    await ready(page);
    await assertValidationModel(page);
    await page.getByRole("button", { name: /字号步进器与默认值/ }).click();
    await page.getByRole("button", { name: /本轮改动/ }).waitFor();
    await page.getByRole("button", { name: /npm run test:inputs/ }).click();
    await page.getByText("260/260 断言通过", { exact: false }).waitFor();
    await page.evaluate(() => window.dcode.updateSettings({ fontSize: 14 }));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 760));
    await page.waitForFunction(() => window.innerWidth === 1100 && window.innerHeight === 760);
    const composer = page.getByPlaceholder("追问、补充或纠正…");
    await composer.fill(draft);
    const original = await page.evaluate(async () => {
      const snapshot = await window.dcode.getSnapshot();
      const area = document.querySelector("textarea");
      return { selection: [area.selectionStart, area.selectionEnd], runs: Object.fromEntries(
        Object.entries(snapshot.runs).map(([id, run]) => [id, { status: run.status, pendingInputs: run.pendingInputs }])) };
    });
    // 只读观测 + 测试侧焦点前置。tabindex 仅使键盘滚动明确落到时间线，结束时恢复；不伪造输入事件。
    await page.evaluate(() => {
      const scroller = document.querySelector("main .overflow-y-auto");
      const dock = document.querySelector('[data-slot="composer-dock"]');
      const area = document.querySelector("textarea");
      const originalTabIndex = scroller.getAttribute("tabindex");
      const samples = [];
      const events = [];
      const commands = [];
      const counters = {};
      let phase = "setup";
      let raf = 0;
      const read = (kind) => {
        const style = getComputedStyle(area);
        const max = scroller.scrollHeight - scroller.clientHeight;
        const sample = {
          t: performance.now(), phase, kind, scrollTop: scroller.scrollTop, max, gap: max - scroller.scrollTop,
          scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight,
          viewport: { w: window.innerWidth, h: window.innerHeight }, font: getComputedStyle(document.body).fontSize,
          dockHeight: dock.getBoundingClientRect().height, areaHeight: area.getBoundingClientRect().height,
          singleLine: Math.ceil(parseFloat(style.lineHeight) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
            + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)),
          tight: area.closest(".input-surface")?.dataset.tight ?? null,
          docTop: document.documentElement.scrollTop, windowY: window.scrollY,
          counts: { ...(counters[phase] ?? {}) },
        };
        samples.push(sample);
        return sample;
      };
      const onInput = (event) => {
        if (!event.isTrusted) return;
        if ((event.type === "wheel" || event.type === "keydown" || event.type === "keyup")
          && !scroller.contains(event.target)) return;
        const count = counters[phase] ??= {};
        count[event.type] = (count[event.type] ?? 0) + 1;
        events.push({ t: performance.now(), phase, type: event.type, trusted: event.isTrusted,
          key: event.key ?? null, deltaY: event.deltaY ?? null, x: event.clientX ?? null, y: event.clientY ?? null,
          buttons: event.buttons ?? null });
        read(event.type);
      };
      const onScroll = () => {
        const count = counters[phase] ??= {};
        count.scroll = (count.scroll ?? 0) + 1;
        read("scroll");
      };
      const types = ["wheel", "keydown", "keyup", "mousedown", "mousemove", "mouseup"];
      for (const type of types) window.addEventListener(type, onInput, { capture: true, passive: true });
      scroller.addEventListener("scroll", onScroll, { passive: true });
      const loop = () => { read("raf"); raf = requestAnimationFrame(loop); };
      raf = requestAnimationFrame(loop);
      window.__rootF3 = {
        begin(name) { phase = name; return read("phase-start"); },
        mark(name, data = null) { commands.push({ t: performance.now(), phase, name, data }); return read(`command:${name}`); },
        now: () => read("read"),
        dump: () => ({ samples, events, commands, counters }),
        stop() {
          cancelAnimationFrame(raf);
          for (const type of types) window.removeEventListener(type, onInput, true);
          scroller.removeEventListener("scroll", onScroll);
          if (originalTabIndex === null) scroller.removeAttribute("tabindex");
          else scroller.setAttribute("tabindex", originalTabIndex);
          return { samples, events, commands, counters };
        },
      };
    });
    const now = () => page.evaluate(() => window.__rootF3.now());
    const begin = (phase) => page.evaluate((name) => window.__rootF3.begin(name), phase);
    const mark = (name, data = null) => page.evaluate((input) => window.__rootF3.mark(input.name, input.data), { name, data });
    const waitBottom = () => page.waitForFunction(() => {
      const s = document.querySelector("main .overflow-y-auto");
      return s.scrollTop + s.clientHeight >= s.scrollHeight - 2;
    });
    const wheelPoint = () => page.locator(scrollerSelector).evaluate((s) => {
      const r = s.getBoundingClientRect();
      // 内容列旁的时间线留白，避免把滚轮发给工具正文内部或 textarea。
      return { x: r.left + s.clientLeft + 5, y: r.top + s.clientTop + Math.min(s.clientHeight / 2, 100) };
    });
    const thumbGeometry = () => page.locator(scrollerSelector).evaluate((s) => {
      const r = s.getBoundingClientRect();
      const style = getComputedStyle(s);
      const leftBorder = parseFloat(style.borderLeftWidth);
      const rightBorder = parseFloat(style.borderRightWidth);
      const gutter = s.offsetWidth - s.clientWidth - leftBorder - rightBorder;
      const max = s.scrollHeight - s.clientHeight;
      const trackTop = r.top + s.clientTop;
      const trackHeight = s.clientHeight;
      const thumbHeight = trackHeight * s.clientHeight / s.scrollHeight;
      const travel = trackHeight - thumbHeight;
      const thumbTop = trackTop + (max > 0 ? s.scrollTop / max : 0) * travel;
      return { gutter, max, scrollTop: s.scrollTop, trackTop, trackHeight, thumbHeight, thumbTop, travel,
        x: r.right - rightBorder - gutter / 2, y: thumbTop + thumbHeight / 2,
        bottomY: trackTop + trackHeight - thumbHeight / 2, right: r.right,
        clientRight: r.left + s.clientLeft + s.clientWidth, direction: style.direction };
    });
    const assertThumb = (g) => {
      assert.ok(g.gutter > 0 && g.gutter <= 30, `须实有经典滚动条占位，不能把 overlay/无 gutter 当拖动已验（${JSON.stringify(g)}）`);
      assert.equal(g.direction, "ltr", "本候选核右侧经典滚动条");
      assert.ok(g.max > 100 && g.thumbHeight >= 20 && g.travel > 120, "长工具样例须提供可辨的 thumb 与足够滚动行程");
      assert.ok(g.x > g.clientRight && g.x < g.right && g.y > g.trackTop && g.y < g.trackTop + g.trackHeight,
        "拖动起点须在实际 gutter 内、按 scrollTop 比例推导的 thumb 中心");
    };
    for (const path of ["wheel", "keyboard", "scrollbar"]) {
      await begin(`${path}-setup`);
      await page.evaluate(() => window.dcode.updateSettings({ fontSize: 14 }));
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 760));
      await page.waitForFunction(() => window.innerWidth === 1100 && window.innerHeight === 760
        && getComputedStyle(document.body).fontSize === "14px");
      // 真实滚轮回到起点；此处仅建立各段起点，目标交错中不插稳定序列或固定等待。
      const point = await wheelPoint();
      await page.mouse.move(point.x, point.y);
      await page.mouse.wheel(0, 1_000_000);
      await waitBottom();
      await page.waitForFunction(() => {
        const area = document.querySelector("textarea");
        const style = getComputedStyle(area);
        return area.getBoundingClientRect().height > parseFloat(style.lineHeight) * 3;
      });
      const start = await begin(`${path}-up`);
      assert.ok(start.gap <= 2 && start.max > 400, `${path} 起点须真实贴底且充裕溢出`);
      if (path === "wheel") {
        await mark("wheel-up-1", { deltaY: -500, point });
        await page.mouse.wheel(0, -500);
        await mark("resize-during-wheel-burst", { w: 1100, h: 700 });
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 700));
        // 只确认这次 resize 真到达；不等滚动/布局稳定，随后立刻继续真实输入突发。
        await page.waitForFunction(() => window.innerHeight === 700);
        await mark("wheel-up-2", { deltaY: -180 });
        await page.mouse.wheel(0, -180);
      } else if (path === "keyboard") {
        // 测试焦点前置（非用户滚动证据）：使 PageUp/PageDown 明确作用于时间线，不作用于 textarea。
        await page.locator(scrollerSelector).evaluate((s) => { s.setAttribute("tabindex", "0"); s.focus({ preventScroll: true }); });
        assert.ok(await page.locator(scrollerSelector).evaluate((s) => document.activeElement === s), "键盘前置焦点落在时间线");
        await mark("PageUp-down");
        await page.keyboard.down("PageUp");
        await mark("resize-while-PageUp-held", { w: 1100, h: 700 });
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 700));
        await page.waitForFunction(() => window.innerHeight === 700);
        await mark("actual-resize-while-PageUp-held");
        await page.keyboard.up("PageUp");
        await mark("PageUp-second");
        await page.keyboard.press("PageUp");
      } else {
        const thumb = await thumbGeometry();
        assertThumb(thumb);
        await mark("thumb-up-start", thumb);
        await page.mouse.move(thumb.x, thumb.y);
        await page.mouse.down();
        try {
          await page.mouse.move(thumb.x, thumb.y - 100, { steps: 6 });
          await mark("resize-while-thumb-held", { w: 1100, h: 700 });
          await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 700));
          await page.waitForFunction(() => window.innerHeight === 700);
          await mark("actual-resize-while-thumb-held");
          await page.mouse.move(thumb.x, Math.max(thumb.trackTop + 10, thumb.y - 170), { steps: 6 });
        } finally {
          await page.mouse.up();
          await mark("thumb-up-released");
        }
      }
      await page.waitForFunction((before) => {
        const sample = window.__rootF3.now();
        return sample.viewport.h === 700 && sample.scrollTop < before.scrollTop - 20 && sample.gap > 20;
      }, start);
      // 收起可短于自动化动作往返：从每帧连续观测证明它曾真实发生，不能只看末态或事件数。
      await page.waitForFunction((phase) => window.__rootF3.dump().samples.some((sample) =>
        sample.phase === phase && sample.areaHeight <= sample.singleLine + 1.5), `${path}-up`);
      await page.waitForFunction((before) => {
        const sample = window.__rootF3.now();
        return sample.viewport.h === 700 && sample.gap > 2 && Math.abs(sample.areaHeight - before.areaHeight) <= 1.5;
      }, start);
      const afterUp = await now();
      const upData = await page.evaluate((phase) => {
        const data = window.__rootF3.dump();
        return { samples: data.samples.filter((sample) => sample.phase === phase),
          events: data.events.filter((event) => event.phase === phase), counts: data.counters[phase] ?? {} };
      }, `${path}-up`);
      assert.ok(upData.samples.length >= 4, `${path} 须有连续真实几何序列`);
      const away = upData.samples.findIndex((sample) => sample.scrollTop < start.scrollTop - 20 && sample.gap > 20);
      assert.ok(away >= 0, `${path} 必须真正上翻，事件存在不算通过`);
      assert.ok(upData.samples.slice(away).every((sample) => sample.gap > 2), `${path} 真上翻后，交错重排不得瞬间拉回底部`);
      assert.ok(upData.samples.some((sample) => sample.viewport.h !== start.viewport.h), `${path} 必须发生实际视口重排`);
      assert.ok((upData.counts.scroll ?? 0) > 0, `${path} 须有实际时间线滚动事件`);
      if (path === "wheel") assert.ok((upData.counts.wheel ?? 0) >= 2, "两次真实 wheel 必须送到时间线");
      if (path === "keyboard") assert.ok(upData.events.some((event) => event.type === "keydown" && event.key === "PageUp"), "须收到真实 PageUp");
      assert.ok(Math.abs(afterUp.areaHeight - start.areaHeight) <= 1.5, `${path} 停止滚动后恢复暂收前实际高度`);
      assert.equal(await composer.inputValue(), draft, `${path} 暂收/恢复不改草稿`);
      evidence.phases.push({ path, start, afterUp, upData });

      await begin(`${path}-return-bottom`);
      if (path === "wheel") {
        const p = await wheelPoint();
        await page.mouse.move(p.x, p.y);
        await mark("wheel-down", { deltaY: 1_000_000 });
        await page.mouse.wheel(0, 1_000_000);
      } else if (path === "keyboard") {
        await page.locator(scrollerSelector).evaluate((s) => s.focus({ preventScroll: true }));
        for (let index = 0; index < 30; index++) {
          const before = await now();
          if (before.gap <= 2) break;
          await mark("PageDown", { index });
          await page.keyboard.press("PageDown");
          await page.waitForFunction((top) => {
            const s = document.querySelector("main .overflow-y-auto");
            return s.scrollTop > top + 1 || s.scrollTop + s.clientHeight >= s.scrollHeight - 2;
          }, before.scrollTop);
        }
      } else {
        const thumb = await thumbGeometry();
        assertThumb(thumb);
        await mark("thumb-down-start", thumb);
        await page.mouse.move(thumb.x, thumb.y);
        await page.mouse.down();
        try { await page.mouse.move(thumb.x, thumb.bottomY, { steps: 12 }); }
        finally { await page.mouse.up(); await mark("thumb-down-released"); }
      }
      await waitBottom();
      const returned = await now();
      assert.ok(returned.scrollTop > afterUp.scrollTop + 20 && returned.gap <= 2, `${path} 须以本路径真实动作回到底部`);
      await begin(`${path}-after-return-reflow`);
      await mark("reflow-after-real-bottom", { w: 1100, h: 640, fontSize: 16 });
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 640));
      await page.evaluate(() => window.dcode.updateSettings({ fontSize: 16 }));
      await page.waitForFunction(() => {
        const sample = window.__rootF3.now();
        return sample.viewport.h === 640 && sample.font === "16px" && sample.gap <= 2;
      });
      const followed = await now();
      assert.ok(followed.gap <= 2, `${path} 真回底后，字号/视口重排恢复自动跟随，不另滚定位`);
      const end = await measureEnd(page);
      assert.ok(end.lineTop >= end.scrollerTop - 1 && end.lineBottom <= end.cardTop + 1, `${path} 回底重排后真实末行可读且不被输入 dock 遮挡`);
      assert.equal(await composer.inputValue(), draft);
      evidence.phases.at(-1).returned = returned;
      evidence.phases.at(-1).followed = followed;
    }
    const final = await page.evaluate(async () => {
      const snapshot = await window.dcode.getSnapshot();
      const area = document.querySelector("textarea");
      return { selection: [area.selectionStart, area.selectionEnd], runs: Object.fromEntries(
        Object.entries(snapshot.runs).map(([id, run]) => [id, { status: run.status, pendingInputs: run.pendingInputs }])) };
    });
    assert.deepEqual(final.selection, original.selection, "真实滚动/重排/焦点前置不丢草稿光标");
    assert.deepEqual(final.runs, original.runs, "暂收只改几何，不改变执行状态或输入队列");
  } catch (error) {
    primary = error;
  } finally {
    try { evidence.trace = await page.evaluate(() => window.__rootF3?.stop() ?? null); }
    catch (error) { primary ??= error; }
    try {
      mkdirSync(EVIDENCE, { recursive: true });
      writeFileSync(join(EVIDENCE, "F3-real-input-reflow-interleaving.json"), JSON.stringify(evidence, null, 2));
    } catch (error) { primary ??= error; }
    try { await handle.close(); } catch (error) { primary ??= error; }
    try { await killApp(handle); } catch (error) { primary ??= error; }
    try { cleanup(stateDir); } catch (error) { primary ??= error; }
  }
  if (primary) throw primary;
});
