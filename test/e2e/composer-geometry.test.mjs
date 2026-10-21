// 输入区几何与收起（507 于 2026-10-10 确认，见 spec/开发任务路径.md#桌面会话输入区 与
// DESIGN.md#会话输入几何与暂收）：
//  · 单行垂直居中于卡片内；
//  · 换行／折行按内容向上展开，不设固定行数上限；
//  · 长内容在卡片内部滚动，内侧滚动条默认不可见；
//  · 会话真实滚动时暂收展开部分，停止滚动后按暂收前的实际高度恢复；
//  · 草稿、光标位置与运行状态在暂收前后不丢失、不改写；
//  · 最后一条消息的末尾内容滚到底时完整显示在输入卡片上方，不被遮挡。
// 断言基于真实渲染几何，不用固定行数、估算高度或截图推断。

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";
import { join } from "node:path";
import { launchApp, ready, cleanup, killApp, assertValidationModel, waitForSnapshot, gotoSession } from "./helpers.mjs";
import { evidenceDir } from "./evidence-root.mjs";

const EVIDENCE = evidenceDir("composer-geometry");
mkdirSync(EVIDENCE, { recursive: true });

/** 等紧凑判定稳定下来：连续若干次读到同一形态才算收束（判定由 ResizeObserver 触发）。 */
const settleCompact = async (area) => {
  let last = null;
  let stable = 0;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const now = await area.evaluate((el) => el.closest(".input-surface")?.classList.contains("composer-compact") ?? false);
    stable = now === last ? stable + 1 : 0;
    last = now;
    if (stable >= 3) return now;
    await new Promise((r) => setTimeout(r, 120));
  }
  return last;
};

/** 输入框与外壳的真实几何；gutter 是滚动条实际占位（offsetWidth − clientWidth − 边框）。 */
const measureArea = (page) =>
  page.locator("textarea").evaluate((el) => {
    const style = getComputedStyle(el);
    const shell = el.closest(".input-surface");
    const shellRect = shell?.getBoundingClientRect() ?? null;
    const areaRect = el.getBoundingClientRect();
    // 末尾动作行（状态说明 + 主按钮 + 次级菜单）在单行形态里与输入行并排
    const tools = el.parentElement?.querySelector('[data-slot="input-group-addon"]') ?? null;
    const toolsRect = tools?.getBoundingClientRect() ?? null;
    return {
      height: el.clientHeight,
      needed: el.scrollHeight,
      lineHeight: parseFloat(style.lineHeight),
      overflowY: style.overflowY,
      padTop: parseFloat(style.paddingTop),
      padBottom: parseFloat(style.paddingBottom),
      gutter: el.offsetWidth - el.clientWidth - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth),
      scrollbarWidth: style.scrollbarWidth,
      shellHeight: shell ? Math.round(shellRect.height) : 0,
      shellTop: shell ? Math.round(shellRect.top) : 0,
      // 真实居中取证：输入行中心与卡片中心、操作行中心的实际偏差（像素）
      areaCenterOffset: shellRect ? Number((areaRect.top + areaRect.height / 2 - (shellRect.top + shellRect.height / 2)).toFixed(2)) : null,
      toolsCenterOffset: shellRect && toolsRect ? Number((toolsRect.top + toolsRect.height / 2 - (shellRect.top + shellRect.height / 2)).toFixed(2)) : null,
      compact: shell?.classList.contains("composer-compact") ?? false,
      // 编辑区的实际可编辑宽度：并排形态下它与操作行争抢同一行，宽度被压到 0 就是不可用
      editWidth: el.clientWidth,
      editHeight: el.clientHeight,
      // C06 说明在 form 层（输入表面之外），不在 textarea 的父元素里：
      // 按 textarea.parentElement 取会得到空串，让「说明变长」的前置永远假成立
      noteText: (el.closest("form")?.querySelector('[data-slot="composer-note"]')?.textContent ?? "").trim(),
    };
  });

const lines = (n, marker = "行") => Array.from({ length: n }, (_, i) => `${marker}${i + 1}`).join("\n");

/** 失败取证：安装几何连续采样（视口/scrollTop/max/dock 高/data-tight），超时时 dump 可读序列。 */
const installGeoTrace = (page) =>
  page.evaluate(() => {
    const s = document.querySelector("main .overflow-y-auto");
    const dock = document.querySelector("[data-slot=composer-dock]");
    const surface = document.querySelector(".input-surface");
    const area = document.querySelector("main textarea");
    const samples = [];
    const record = (kind) =>
      samples.push({
        t: Math.round(performance.now()),
        kind,
        vp: `${window.innerWidth}x${window.innerHeight}`,
        st: Math.round(s.scrollTop),
        max: Math.round(s.scrollHeight - s.clientHeight),
        dockH: Math.round(dock.getBoundingClientRect().height),
        areaH: Math.round(area.clientHeight),
        compact: surface?.classList.contains("composer-compact") ?? false,
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
const waitTraced = async (page, promiseFactory, label) => {
  try {
    await promiseFactory();
  } catch (err) {
    const trace = await page.evaluate(() => window.__dumpGeoTrace?.() ?? null).catch(() => null);
    console.error(`GEO-TRACE(${label}) ` + JSON.stringify(trace));
    throw err;
  }
};

/**
 * 高度探针：记录观察窗内 textarea 经历过的**全部**实际高度取值，
 * 以及外壳紧凑形态被切换的次数。用于区分「从未暂收」与「闪收又恢复」，
 * 也用于证明紧凑判定不会被自身造成的宽度切换反复逆转。
 * ResizeObserver 只捕获真实发生的尺寸变化，不受逐帧取样的时机影响。
 */
async function startHeightProbe(page) {
  await page.evaluate(() => {
    const shell = document.querySelector(".input-surface");
    const area = document.querySelector("textarea");
    const state = { heights: [], toggles: 0 };
    window.__heightProbe = state;
    const mo = new MutationObserver(() => { state.toggles += 1; });
    mo.observe(shell, { attributes: true, attributeFilter: ["class"] });
    const ro = new ResizeObserver(() => {
      const h = area.clientHeight;
      if (state.heights[state.heights.length - 1] !== h) state.heights.push(h);
    });
    ro.observe(area);
    state.heights.push(area.clientHeight);
    window.__heightProbeStop = () => { mo.disconnect(); ro.disconnect(); };
  });
}

async function stopHeightProbe(page) {
  return page.evaluate(() => {
    window.__heightProbeStop?.();
    const state = window.__heightProbe;
    window.__heightProbe = null;
    window.__heightProbeStop = null;
    return { heights: state.heights, toggles: state.toggles };
  });
}

/**
 * 构造临界折行草稿：在卡片全宽下恰好一行、在并排后的较窄宽度下折成两行。
 * 这正是紧凑判定可能被自身宽度切换反复逆转的那一段文本。
 * 候选用 canvas 量真实排版宽度，再按目标宽度取最长可容的重复串。
 */
const criticalDraft = (page, char) =>
  page.evaluate((ch) => {
    const area = document.querySelector("textarea");
    const shell = area.closest(".input-surface");
    const shellStyle = getComputedStyle(shell);
    const full = shell.clientWidth - parseFloat(shellStyle.paddingLeft) - parseFloat(shellStyle.paddingRight);
    const line = parseFloat(getComputedStyle(area).lineHeight);
    // 并排形态下 textarea 让出操作行的宽度；用 0.62 作为「较窄」参考宽度
    const narrow = Math.round(full * 0.62);
    const original = area.value;
    const heightAt = (width) => {
      const prev = { width: area.style.width, flex: area.style.flex, height: area.style.height, overflow: area.style.overflowY };
      area.style.flex = "0 0 auto";
      area.style.width = `${Math.max(24, Math.floor(width))}px`;
      area.style.overflowY = "auto";
      area.style.height = "0px";
      const measured = area.scrollHeight;
      area.style.width = prev.width;
      area.style.flex = prev.flex;
      area.style.height = prev.height;
      area.style.overflowY = prev.overflow;
      return measured;
    };
    const ctx = document.createElement("canvas").getContext("2d");
    ctx.font = getComputedStyle(area).font;
    const unit = Math.max(1, ctx.measureText(ch).width);
    const maxCount = Math.floor(full / unit);
    for (let n = maxCount; n >= 4; n -= 1) {
      const text = ch.repeat(n);
      area.value = text;
      const atFull = heightAt(full);
      const atNarrow = heightAt(narrow);
      if (atFull === line && atNarrow > line) {
        area.value = original;
        return { text, full, narrow, line, atFull, atNarrow };
      }
    }
    area.value = original;
    return null;
  }, char);

const openSession = async (page) => {
  await ready(page);
  await assertValidationModel(page);
  await page.getByRole("button", { name: "聊聊下个季度的规划", exact: false }).click();
  await page.locator("main header").getByText("聊聊下个季度的规划", { exact: true }).waitFor();
  await page.getByPlaceholder("追问、补充或纠正…").waitFor();
};

test('本组件贴底与外部位移同次派发：位置不同且几何相同不能吞掉后次滚动', async () => {
  const handle = await launchApp();
  const { page } = handle;
  try {
    await ready(page);
    await assertValidationModel(page);
    await page.getByRole('button', { name: /字号步进器与默认值/ }).click();
    await page.getByRole('button', { name: /本轮改动|files changed/ }).waitFor();
    await page.getByRole('button', { name: /npm run test:inputs/ }).first().click();
    const area = page.getByPlaceholder('追问、补充或纠正…');
    await area.fill(lines(6));
    const expanded = await measureArea(page);
    assert.ok(expanded.height > expanded.lineHeight * 3);
    await page.waitForFunction(() => {
      const s = document.querySelector('main .overflow-y-auto');
      return s && s.scrollHeight > s.clientHeight + 200 && s.scrollHeight - s.clientHeight - s.scrollTop <= 2;
    }, null, { timeout: 10_000 });
    // 只在测试侧使两个真实原生位置写入同次派发，不冒称可信滚轮或键盘动作。
    // 不改产品 ref／事件处理器；第一次仍由产品自己的真实重排贴底发起。
    await page.evaluate(() => {
      const s = document.querySelector('main .overflow-y-auto');
      let proto = s;
      let native;
      while (proto && !native) { native = Object.getOwnPropertyDescriptor(proto, 'scrollTop'); proto = Object.getPrototypeOf(proto); }
      if (!native?.set || !native.get) throw new Error('native scrollTop descriptor missing');
      Object.defineProperty(s, 'scrollTop', {
        configurable: true,
        get() { return native.get.call(this); },
        set(value) {
          native.set.call(this, value);
          const max = this.scrollHeight - this.clientHeight;
          if (max > 200 && Math.abs(native.get.call(this) - max) <= 1) {
            const geometry = { sh: this.scrollHeight, ch: this.clientHeight };
            native.set.call(this, max - 140);
            delete this.scrollTop;
            window.__coalescedScroll = { written: value, after: this.scrollTop, max, ...geometry, afterSh: this.scrollHeight, afterCh: this.clientHeight };
          }
        },
      });
    });
    await area.fill(lines(7));
    await page.waitForFunction(() => Boolean(window.__coalescedScroll), null, { timeout: 5_000 });
    const collision = await page.evaluate(() => window.__coalescedScroll);
    assert.equal(collision.afterSh, collision.sh);
    assert.equal(collision.afterCh, collision.ch);
    assert.equal(Math.round(collision.written - collision.after), 140);
    await page.waitForFunction(h => document.querySelector('textarea').clientHeight < h, expanded.height, { timeout: 5_000 });
    assert.equal(await area.inputValue(), lines(7));
  } finally {
    await page.evaluate(() => { const s = document.querySelector('main .overflow-y-auto'); if (s) delete s.scrollTop; }).catch(() => undefined);
    try { await handle.close(); } finally { await killApp(handle); cleanup(handle.stateDir); }
  }
});

test("输入区几何：单行垂直居中、按内容向上展开无固定行数上限、长内容内部滚动且滚动条不可见", async () => {
  const handle = await launchApp();
  const { page } = handle;
  const observations = [];
  try {
    await openSession(page);
    const area = page.getByPlaceholder("追问、补充或纠正…");

    await area.fill(lines(1));
    const one = await measureArea(page);
    observations.push({ case: "one-line", ...one });
    // 单行：只装得下一行（固定 rows=3 会是 3 倍行高），高度随字号尺度派生而不是写独立常数
    assert.ok(one.height < one.lineHeight * 2 + 4, `单行只应装一行（lineHeight=${one.lineHeight}，实得 ${one.height}）`);
    assert.equal(one.needed, one.height, "单行不得内部滚动");
    // 「垂直居中于卡片内，不因图标行偏上或偏下」按真实几何取证：输入行与操作行同在卡片内且
    // 两者的中心都必须落在卡片中心上。对称 padding 只证明 textarea 自身，证明不了相对卡片的位置。
    assert.equal(one.compact, true, "单行应是输入行与操作行并排的紧凑形态（原型 .composer.compact）");
    assert.ok(Math.abs(one.areaCenterOffset) <= 1, `输入行中心须与卡片中心重合（偏差 ${one.areaCenterOffset}px）`);
    assert.ok(Math.abs(one.toolsCenterOffset) <= 1, `操作行中心须与卡片中心重合，不因图标行偏上或偏下（偏差 ${one.toolsCenterOffset}px）`);

    // 按内容向上展开：高度随行数增长，不是固定行数
    const heights = [];
    for (const n of [3, 6, 12]) {
      await area.fill(lines(n));
      const m = await measureArea(page);
      heights.push(m.height);
      observations.push({ case: `${n}-line`, ...m });
    }
    assert.ok(heights[1] > heights[0] + one.lineHeight * 2, `3→6 行应按内容继续展开（${heights[0]} → ${heights[1]}）`);
    assert.ok(heights[2] > heights[1] + one.lineHeight * 5, `6→12 行应继续展开，不存在固定行数上限（${heights[1]} → ${heights[2]}）`);
    assert.equal(observations[2].compact, false, "多行应是输入区在上、操作行在下的堆叠形态");
    assert.ok(observations[2].shellHeight > one.shellHeight, `展开后卡片应按实际高度增高（${one.shellHeight} → ${observations[2].shellHeight}）`);
    for (const [n, h] of [[3, heights[0]], [6, heights[1]], [12, heights[2]]]) {
      assert.ok(h > n * one.lineHeight * 0.8, `${n} 行实得高度 ${h} 明显不足一行 ${one.lineHeight}×${n}`);
    }

    // 长内容：内部滚动，且内侧滚动条不占位
    await area.fill(lines(60));
    const long = await measureArea(page);
    observations.push({ case: "long", ...long });
    assert.ok(long.needed > long.height + one.lineHeight, "超长内容必须在卡片内部滚动，而不是继续长高");
    assert.equal(long.gutter, 0, `内侧滚动条不得占位（实际 gutter=${long.gutter}px）`);
    assert.equal(long.scrollbarWidth, "none", "内侧滚动条默认不可见");
    assert.ok(long.height <= 480, "展开高度仍受可用空间约束，不能顶满整窗");

    // 展开不改变左右留白与卡片宽度：核的是卡片（外壳）本身的几何，以及文字相对卡片的左缩进。
    // 紧凑形态下操作行与输入行并排，输入框右缘本就与展开形态不同，那是形态差异不是留白变化。
    const cardRect = () =>
      page.locator("textarea").evaluate((el) => {
        const card = el.closest(".input-surface").getBoundingClientRect();
        const area = el.getBoundingClientRect();
        return {
          cardLeft: Math.round(card.left),
          cardRight: Math.round(card.right),
          cardWidth: Math.round(card.width),
          textLeftInset: Math.round(area.left - card.left),
        };
      });
    await area.fill(lines(60));
    const wide = await cardRect();
    await area.fill(lines(1));
    const narrow = await cardRect();
    observations.push({ case: "card-expanded", ...wide }, { case: "card-compact", ...narrow });
    assert.equal(narrow.cardLeft, wide.cardLeft, "展开不得改变卡片左缘");
    assert.equal(narrow.cardRight, wide.cardRight, "展开不得改变卡片右缘（左右留白不变）");
    assert.equal(narrow.cardWidth, wide.cardWidth, "展开不得改变卡片宽度");
    assert.equal(narrow.textLeftInset, wide.textLeftInset, "文字相对卡片的左缩进不得变化");
  } finally {
    writeFileSync(join(EVIDENCE, "geometry-observations.json"), JSON.stringify(observations, null, 2));
    try { await handle.close(); } finally { await killApp(handle); cleanup(handle.stateDir); }
  }
});

test("真实滚动时暂收展开部分、停止后按暂收前实际高度恢复，草稿与光标不丢；末尾内容不被卡片遮挡", async () => {
  const handle = await launchApp();
  const { page } = handle;
  const observations = [];
  try {
    await ready(page);
    await assertValidationModel(page);
    // 真实长会话：内容充裕溢出、初始贴底
    await page.getByRole("button", { name: /字号步进器与默认值/ }).click();
    await page.getByRole("button", { name: /本轮改动|files changed/ }).waitFor();
    await page.getByRole("button", { name: /npm run test:inputs/ }).first().click();
    await page.waitForFunction(() => {
      const s = document.querySelector("main .overflow-y-auto");
      return s && s.scrollHeight > s.clientHeight + 4;
    }, null, { timeout: 10_000 });

    const area = page.getByPlaceholder("追问、补充或纠正…");
    await area.fill(lines(6));
    const expanded = await measureArea(page);
    assert.ok(expanded.height > expanded.lineHeight * 3, "前置条件：输入区确实展开到多行");
    // 光标停在末尾，暂收前后都必须保留
    await area.evaluate((el) => el.setSelectionRange(el.value.length, el.value.length));

    // 会话真实滚动（几何不变 → Timeline 判定为真实滚动，不是重排锚定）
    await installGeoTrace(page);
    await page.locator("main .overflow-y-auto").evaluate((el) => el.scrollBy(0, -140));
    await waitTraced(
      page,
      () =>
        page.waitForFunction(
          (h) => {
            const el = document.querySelector("textarea");
            return el && el.clientHeight < h;
          },
          expanded.height,
          { timeout: 5_000 },
        ),
      "暂收失败",
    );
    const collapsed = await measureArea(page);
    observations.push({ case: "collapsed", ...collapsed });
    assert.ok(collapsed.height < expanded.height, `滚动中应暂收展开部分（${expanded.height} → ${collapsed.height}）`);
    assert.ok(collapsed.height < collapsed.lineHeight * 2 + 4, `暂收后只应保留一行形态（实得 ${collapsed.height}）`);
    assert.equal(await area.inputValue(), lines(6), "暂收不得改写草稿");
    const caret = await area.evaluate((el) => ({ start: el.selectionStart, end: el.selectionEnd, len: el.value.length }));
    assert.equal(caret.start, caret.len, "暂收不得丢失光标位置");
    assert.equal(caret.end, caret.len);

    // 停止滚动：按暂收前的实际高度恢复（不是重新估算）
    await waitTraced(
      page,
      () =>
        page.waitForFunction(
          (h) => {
            const el = document.querySelector("textarea");
            return el && el.clientHeight === h;
          },
          expanded.height,
          { timeout: 5_000 },
        ),
      "恢复失败",
    );
    const restored = await measureArea(page);
    observations.push({ case: "restored", ...restored });
    assert.equal(restored.height, expanded.height, "恢复依据是暂收前的实际高度");
    assert.equal(await area.inputValue(), lines(6));

    // 末尾内容不被输入卡片遮挡：滚到底时最后一条消息的末端在卡片上方
    await page.locator("main .overflow-y-auto").evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await page.waitForFunction(() => {
      const s = document.querySelector("main .overflow-y-auto");
      return s && s.scrollTop + s.clientHeight >= s.scrollHeight - 2;
    }, null, { timeout: 5_000 });
    const tail = await page.evaluate(() => {
      const column = document.querySelector("main .overflow-y-auto > div");
      const blocks = column?.querySelectorAll('[data-slot="message"]');
      const last = blocks?.[blocks.length - 1];
      // 避让对象是整个输入 dock（卡片 ＋ 卡片之外的 C06 说明）
      const dock = document.querySelector("[data-slot=composer-dock]");
      if (!last || !dock) return null;
      const l = last.getBoundingClientRect();
      const s = dock.getBoundingClientRect();
      return { lastBottom: Math.round(l.bottom), shellTop: Math.round(s.top) };
    });
    observations.push({ case: "tail-clearance", ...(tail ?? {}) });
    assert.ok(tail, "前置条件：时间线存在消息且输入卡片存在");
    assert.ok(tail.lastBottom <= tail.shellTop + 1, `滚到底时最后一条消息必须完整显示在卡片上方（末 ${tail.lastBottom} vs 卡 ${tail.shellTop}）`);
  } finally {
    writeFileSync(join(EVIDENCE, "collapse-observations.json"), JSON.stringify(observations, null, 2));
    try { await handle.close(); } finally { await killApp(handle); cleanup(handle.stateDir); }
  }
});

test("暂收不改写任何输入事实：非末尾选区、长稿末行键盘编辑、暂收期间编辑、输入法组合与运行状态都保留", async () => {
  // 慢速模拟装配：暂停前的运行窗口足够长，才能取到一个稳定的「运行中 → 已暂停」状态
  const handle = await launchApp(undefined, { DCODE_MOCK_FAST: "0" });
  const { page } = handle;
  const observations = [];
  const blocksCount = () => page.locator('[data-slot="message"]').count();
  try {
    await ready(page);
    await assertValidationModel(page);
    await page.getByRole("button", { name: /字号步进器与默认值/ }).click();
    await page.getByRole("button", { name: /本轮改动|files changed/ }).waitFor();
    await page.waitForFunction(() => {
      const s = document.querySelector("main .overflow-y-auto");
      return s && s.scrollHeight > s.clientHeight + 4;
    }, null, { timeout: 10_000 });

    const area = page.getByPlaceholder("追问、补充或纠正…");
    const primary = page.locator('button[data-slot="composer-primary"]');

    // 真实运行 → 暂停：已暂停是不会自行结束的稳定运行状态，便于观察暂收前后的同一性
    await area.fill("先跑一次模拟运行");
    await area.press("Enter");
    await page.waitForFunction(
      () => document.querySelector('button[data-slot="composer-primary"]')?.getAttribute("aria-label") === "暂停",
      null,
      { timeout: 15_000 },
    );
    await primary.click();
    // 已暂停是稳定状态：主按钮按 C01 呈现「继续执行」，且不因本次草稿而变成发送
    await page.waitForFunction(
      () => document.querySelector('button[data-slot="composer-primary"]')?.getAttribute("aria-label") === "继续执行",
      null,
      { timeout: 15_000 },
    );

    // 长稿 + 非末尾选区（不是只有末尾光标）
    await area.fill(lines(20));
    const expanded = await measureArea(page);
    assert.ok(expanded.height > expanded.lineHeight * 5, `前置条件：长稿确实展开（实得 ${expanded.height}）`);
    const selection = { start: 30, end: 42, direction: "backward" };
    await area.evaluate((el, s) => {
      el.focus();
      el.setSelectionRange(s.start, s.end, s.direction);
    }, selection);
    const blocksBefore = await blocksCount();

    // 真实滚动（几何不变 → Timeline 判定为真实滚动）
    await page.locator("main .overflow-y-auto").evaluate((el) => el.scrollBy(0, -160));
    await page.waitForFunction(
      (h) => {
        const el = document.querySelector("textarea");
        return el && el.clientHeight < h;
      },
      expanded.height,
      { timeout: 5_000 },
    );
    const collapsed = await measureArea(page);
    observations.push({ case: "collapsed", ...collapsed });
    assert.equal(await area.inputValue(), lines(20), "暂收不得改写草稿");
    assert.deepEqual(
      await area.evaluate((el) => ({ start: el.selectionStart, end: el.selectionEnd, direction: el.selectionDirection })),
      selection,
      "暂收不得丢失或改写非末尾选区",
    );

    // 输入法组合期间：暂收不打断组合、组合中的 Enter 不提交。
    // 组合开始前把光标收成折叠态：非折叠选区会被输入法按自己的规则消费，
    // 那是浏览器行为、不是本项目的断言对象。本项目负责的是组合期间不提交、
    // 不改写草稿、不丢编辑焦点、不改写运行状态。
    await area.evaluate((el) => el.setSelectionRange(el.value.length, el.value.length));
    const valueBeforeIme = await area.inputValue();
    await area.evaluate((el) => el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
    // 合成 keydown 而非真实按键：真实 Enter 在无实际 IME 时会被浏览器当换行处理，
    // 那是 IME 实现的行为。本项目负责的是「组合中 Enter 不走提交通路」——
    // 若组合态没被读到，处理器会 requestSubmit 并 preventDefault，两者都能区分。
    const enterDuringComposition = await area.evaluate((el) => {
      const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
      return ev.defaultPrevented;
    });
    assert.equal(enterDuringComposition, false, "输入法组合期间的 Enter 不得走提交通路");
    assert.equal(await blocksCount(), blocksBefore, "输入法组合期间的 Enter 不得提交");
    assert.equal(await primary.getAttribute("aria-label"), "继续执行", "组合期间不得改写运行控制状态");
    assert.equal(await area.inputValue(), valueBeforeIme, "输入法组合期间不得改写草稿");
    assert.equal(
      await page.evaluate(() => document.activeElement?.tagName),
      "TEXTAREA",
      "暂收只改高度不卸载编辑区，组合中的焦点必须保留",
    );
    await area.evaluate((el) => el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" })));
    await area.evaluate((el) => el.setSelectionRange(el.value.length, el.value.length));

    // 暂收期间在长稿末行做键盘编辑（末行不是末尾光标能代表的全部情况）
    const beforeEdit = await area.inputValue();
    // 末尾光标上移一行落在换行符之前，也就是上一行的行尾
    const previousLineEnd = beforeEdit.lastIndexOf("\n");
    await area.press("ArrowUp");
    await page.keyboard.type("补");
    const edited = `${beforeEdit.slice(0, previousLineEnd)}补${beforeEdit.slice(previousLineEnd)}`;
    assert.equal(await area.inputValue(), edited, "暂收期间的键盘编辑必须落到长稿的上一行");
    const caretAfterEdit = await area.evaluate((el) => ({ start: el.selectionStart, end: el.selectionEnd }));
    assert.equal(caretAfterEdit.start, previousLineEnd + 1, "编辑后光标须停在插入位置");
    assert.equal(caretAfterEdit.end, caretAfterEdit.start);

    // 停滚后仍按暂收前的实际高度恢复，且草稿、编辑结果、运行状态都不改写
    await page.waitForFunction(
      (h) => {
        const el = document.querySelector("textarea");
        return el && el.clientHeight === h;
      },
      expanded.height,
      { timeout: 5_000 },
    );
    const restored = await measureArea(page);
    observations.push({ case: "restored", ...restored });
    assert.equal(restored.height, expanded.height, "恢复依据是暂收前的实际高度");
    assert.equal(await area.inputValue(), edited, "恢复不得改写暂收期间的编辑");
    assert.deepEqual(
      await area.evaluate((el) => ({ start: el.selectionStart, end: el.selectionEnd })),
      { start: caretAfterEdit.start, end: caretAfterEdit.end },
      "恢复不得移动光标",
    );
    assert.equal(await primary.getAttribute("aria-label"), "继续执行", "暂收不得改写运行控制状态");
    await page.locator("main header").getByText("已暂停", { exact: true }).first().waitFor({ timeout: 5_000 });
    assert.equal(await blocksCount(), blocksBefore, "暂收前后不得凭空多出用户消息");
  } finally {
    writeFileSync(join(EVIDENCE, "state-observations.json"), JSON.stringify(observations, null, 2));
    try { await handle.close(); } finally { await killApp(handle); cleanup(handle.stateDir); }
  }
});

test("跟随与重排本身不触发暂收：缩窗、检查器开闭与流式追加后输入区保持展开并持续稳定", async () => {
  // 慢速模拟装配：流式追加要持续足够久，才能证明追加过程中的跟随重钉不触发暂收
  const handle = await launchApp(undefined, { DCODE_MOCK_FAST: "0" });
  const { app, page } = handle;
  const observations = [];
  const areaOf = () => page.locator("textarea");
  const height = () => areaOf().evaluate((el) => el.clientHeight);
  try {
    await ready(page);
    await assertValidationModel(page);
    await page.getByRole("button", { name: /字号步进器与默认值/ }).click();
    await page.getByRole("button", { name: /本轮改动|files changed/ }).waitFor();
    await page.waitForFunction(() => {
      const s = document.querySelector("main .overflow-y-auto");
      return s && s.scrollHeight > s.clientHeight + 4;
    }, null, { timeout: 10_000 });

    const area = page.getByPlaceholder("追问、补充或纠正…");
    await area.fill(lines(6));
    const expanded = await measureArea(page);
    assert.ok(expanded.height > expanded.lineHeight * 3, `前置条件：6 行确实展开（实得 ${expanded.height}）`);
    // 「不触发暂收」必须按观察窗内的真实高度轨迹判定，不能只取一次样：
    // 空闲计时是 140ms，单次 500ms 取样会把「闪收再恢复」验成从未暂收。
    // 这里同时记录逐帧高度、观察器捕获到的全部实际高度取值、以及紧凑形态切换次数。
    const settle = async (label) => {
      await startHeightProbe(page);
      const frames = await page.evaluate(async (count) => {
        const el = document.querySelector("textarea");
        const out = [];
        for (let i = 0; i < count; i += 1) {
          out.push(el.clientHeight);
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
        return out;
      }, 40);
      const probe = await stopHeightProbe(page);
      const lowest = Math.min(...frames);
      observations.push({ label, lowest, frames: [...new Set(frames)], observed: probe.heights, toggles: probe.toggles });
      assert.equal(lowest, expanded.height, `${label}：观察窗内最低高度仍须是展开高度（实测最低 ${lowest}，展开 ${expanded.height}）`);
      assert.deepEqual(probe.heights, [expanded.height], `${label}：观察窗内不得出现真实高度变化（实测 ${JSON.stringify(probe.heights)}）`);
      assert.equal(probe.toggles, 0, `${label}：不得触发紧凑形态切换（实测 ${probe.toggles} 次）`);
    };

    // 1) 缩窗：滚动视口高度变化 → 容器 ResizeObserver → 跟随重钉
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 560));
    await settle("shrink-window");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
    await settle("restore-window");

    // 2) 检查器开闭：主区宽度变化 → 内容列重排 → 重钉
    await page.getByRole("button", { name: /本轮改动/ }).first().click();
    await page.locator("aside .overflow-y-auto").waitFor();
    await settle("open-inspector");
    await page.getByRole("button", { name: "关闭检查器" }).click();
    await settle("close-inspector");

    // 3) 流式追加：真实运行的新块持续改变内容高度，跟随重钉反复发生
    await area.fill("触发一次持续流式追加");
    await area.press("Enter");
    await page.waitForFunction(
      () => document.querySelector('button[data-slot="composer-primary"]')?.getAttribute("aria-label") === "暂停",
      null,
      { timeout: 15_000 },
    );
    await area.fill(lines(6));
    await settle("after-stream-start");
    await page.waitForTimeout(1_500);
    await settle("mid-stream");
    // 收束条件按真实运行相位（快照里不再有 running／pausing）判定。
    // 主按钮文案不能当运行相位用：此时已填了 6 行新草稿，运行中本来就显示「发送」。
    await waitForSnapshot(
      page,
      (snapshot) => !Object.values(snapshot.runs).some((run) => run.status === "running" || run.status === "pausing"),
      null,
      "模拟运行未按真实相位收束",
    );
    await settle("after-stream-end");
    assert.equal(await area.inputValue(), lines(6), "运行收束不得改写草稿");
    assert.equal(await height(), expanded.height, "运行收束后输入区仍须是展开高度");

    // 持续稳定：既没有暂收，也没有因为不暂收而丢掉跟随。
    // 先真实滚到最底（这会短暂暂收，随后按暂收前实际高度恢复），再核跟随仍钉在真实底部。
    await page.locator("main .overflow-y-auto").evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await page.waitForTimeout(600);
    assert.equal(await height(), expanded.height, "真实滚动停止后应恢复到暂收前的实际高度");
    const tail = await page.evaluate(() => {
      const s = document.querySelector("main .overflow-y-auto");
      return s ? { top: Math.round(s.scrollTop), gap: Math.round(s.scrollHeight - s.clientHeight - s.scrollTop) } : null;
    });
    observations.push({ label: "tail", height: await height(), ...(tail ?? {}) });
    assert.ok(tail && tail.gap <= 2, `区分程序化滚动不得牺牲跟随：应贴在真实底部（实得 gap=${tail?.gap}）`);
    assert.equal(await area.inputValue(), lines(6), "整个过程草稿不得被改写");
  } finally {
    writeFileSync(join(EVIDENCE, "follow-observations.json"), JSON.stringify(observations, null, 2));
    try { await handle.close(); } finally { await killApp(handle); cleanup(handle.stateDir); }
  }
});

test("紧凑判定稳定：临界折行文本在卡片全宽与并排宽度之间不会来回切换高度（中英文 × 检查器开闭 × 窄窗）", async () => {
  const handle = await launchApp();
  const { app, page } = handle;
  const observations = [];
  try {
    await ready(page);
    await assertValidationModel(page);
    await page.getByRole("button", { name: /字号步进器与默认值/ }).click();
    await page.getByRole("button", { name: /本轮改动|files changed/ }).waitFor();
    const area = page.getByPlaceholder("追问、补充或纠正…");

    // 观察窗内：逐帧高度不得低于设定值、观察器不得捕获到任何真实高度变化、
    // 外壳的紧凑形态不得被切换。三者同时成立才是「持续稳定」，单次取样不算。
    const probe = async (label, draft, inspector, mutate) => {
      if (mutate) await mutate();
      const viewport = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize());
      // setSize／click 返回不证明 renderer 已到目标排版。先核实际视口、检查器和本次草稿，
      // 再以独立离屏 textarea 量当前宽度的内容需求；只等一次目标形态与内容高度到达。
      // 不预采“连续稳定”序列，之后仍保留全部 RO 高度、40 帧及零形态切换的强断言。
      const arrived = await page.waitForFunction(({ viewport: [w, h], inspector, draft }) => {
        const area = document.querySelector("textarea");
        const shell = area?.closest(".input-surface");
        if (!area || !shell || window.innerWidth !== w || window.innerHeight !== h
          || Boolean(document.querySelector("aside .overflow-y-auto")) !== inspector || area.value !== draft) return false;
        const css = getComputedStyle(area);
        const shellCss = getComputedStyle(shell);
        const probeArea = document.createElement("textarea");
        for (const name of ["font-family", "font-size", "font-weight", "font-style", "line-height", "letter-spacing",
          "text-transform", "text-indent", "tab-size", "word-break", "overflow-wrap", "white-space", "box-sizing",
          "padding-top", "padding-bottom", "padding-left", "padding-right", "border-top-width", "border-bottom-width",
          "border-left-width", "border-right-width", "border-style"]) {
          probeArea.style.setProperty(name, css.getPropertyValue(name));
        }
        Object.assign(probeArea.style, { position: "fixed", left: "-10000px", top: "0", height: "0px",
          minHeight: "0px", maxHeight: "none", minWidth: "0px", maxWidth: "none", overflow: "hidden", visibility: "hidden" });
        probeArea.value = draft;
        document.body.append(probeArea);
        try {
          const demandAt = (width) => { probeArea.style.width = `${width}px`; return probeArea.scrollHeight; };
          const fullWidth = shell.clientWidth - parseFloat(shellCss.paddingLeft) - parseFloat(shellCss.paddingRight);
          const singleLine = parseFloat(css.lineHeight) + parseFloat(css.paddingTop) + parseFloat(css.paddingBottom);
          const fullDemand = demandAt(fullWidth);
          const singleAtFullWidth = fullDemand <= singleLine + 1;
          const footer = shell.querySelector('[data-slot="input-group-addon"]');
          const footerWidth = footer.getBoundingClientRect().width;
          const gap = parseFloat(shellCss.columnGap) || 0;
          const expectedEditWidth = singleAtFullWidth ? fullWidth - footerWidth - gap : fullWidth;
          const demand = demandAt(area.getBoundingClientRect().width);
          window.__compactPreflight = { viewport: [window.innerWidth, window.innerHeight], fullWidth, fullDemand,
            singleLine, editWidth: area.clientWidth, expectedEditWidth, footerWidth, height: area.clientHeight, demand,
            compact: shell.classList.contains("composer-compact"), expectedCompact: singleAtFullWidth };
          if (shell.classList.contains("composer-compact") !== singleAtFullWidth
            || Math.abs(area.getBoundingClientRect().width - expectedEditWidth) > 1) return false;
          if (area.clientWidth <= 0 || Math.abs(area.clientHeight - demand) > 1) return false;
          // 前置首次到达就原子开启一次观察窗，避免跨调试通路的间隙错过首个高度样本。
          const state = { heights: [area.clientHeight], toggles: 0 };
          window.__heightProbe = state;
          const mo = new MutationObserver(() => { state.toggles += 1; });
          mo.observe(shell, { attributes: true, attributeFilter: ["class"] });
          const ro = new ResizeObserver(() => {
            const height = area.clientHeight;
            if (state.heights[state.heights.length - 1] !== height) state.heights.push(height);
          });
          ro.observe(area);
          window.__heightProbeStop = () => { mo.disconnect(); ro.disconnect(); };
          return { viewport: [window.innerWidth, window.innerHeight], cardWidth: shell.clientWidth,
            editWidth: area.clientWidth, expectedEditWidth, footerWidth, height: area.clientHeight, demand,
            compact: singleAtFullWidth };
        } finally { probeArea.remove(); }
      }, { viewport, inspector, draft }, { timeout: 5_000 }).catch(async error => {
        observations.push({ label, preconditionFailed: true, last: await page.evaluate(() => window.__compactPreflight ?? null) });
        throw error;
      });
      const arrival = await arrived.jsonValue();
      await arrived.dispose();
      const frames = await page.evaluate(async (count) => {
        const el = document.querySelector("textarea");
        const out = [];
        for (let i = 0; i < count; i += 1) {
          out.push(el.clientHeight);
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
        return out;
      }, 40);
      const captured = await stopHeightProbe(page);
      const cardHeights = await page.locator("textarea").evaluate((el) => Math.round(el.closest(".input-surface").getBoundingClientRect().height));
      observations.push({ label, arrival, frames: [...new Set(frames)], observed: captured.heights, toggles: captured.toggles, cardHeight: cardHeights });
      assert.deepEqual(captured.heights, [frames[0]], `${label}：观察窗内不得出现真实高度变化（实测 ${JSON.stringify(captured.heights)}）`);
      assert.equal(new Set(frames).size, 1, `${label}：逐帧高度必须一致（实测 ${JSON.stringify([...new Set(frames)])}）`);
      assert.equal(captured.toggles, 0, `${label}：紧凑形态不得来回切换（实测 ${captured.toggles} 次）`);
      return frames[0];
    };

    for (const [kind, char] of [["中文", "测"], ["英文", "m"]]) {
      const plan = await criticalDraft(page, char);
      assert.ok(plan, `${kind}：未能构造出临界折行草稿`);
      assert.equal(plan.atFull, plan.line, `${kind} 临界草稿在卡片全宽下应恰好一行（实得 ${plan.atFull}，行高 ${plan.line}）`);
      assert.ok(plan.atNarrow > plan.line, `${kind} 临界草稿在并排宽度下应折成两行（实得 ${plan.atNarrow}）`);
      await area.fill(plan.text);

      const settled = await probe(`${kind}·默认 1440`, plan.text, false);
      await probe(`${kind}·检查器打开`, plan.text, true, () => page.getByRole("button", { name: /本轮改动/ }).first().click());
      await probe(`${kind}·检查器关闭`, plan.text, false, () => page.getByRole("button", { name: "关闭检查器" }).click());
      await probe(`${kind}·窄窗 720×480`, plan.text, false, () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(720, 480)));
      await probe(`${kind}·回到 1440×900`, plan.text, false, () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900)));

      // 草稿在整个观察过程中不得被改写
      assert.equal(await area.inputValue(), plan.text, `${kind}：观察期间不得改写草稿`);
      assert.equal(await area.evaluate((el) => el.clientHeight), settled, `${kind}：观察结束后高度仍须与观察窗一致`);
    }
  } finally {
    writeFileSync(join(EVIDENCE, "compact-stability-observations.json"), JSON.stringify(observations, null, 2));
    try { await handle.close(); } finally { await killApp(handle); cleanup(handle.stateDir); }
  }
});

test("单行垂直居中在窄窗与检查器打开时同样成立：编辑区不被压成零宽", async () => {
  const handle = await launchApp();
  const { app, page } = handle;
  const observations = [];
  try {
    await ready(page);
    await assertValidationModel(page);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(720, 480));
    await page.getByRole("button", { name: /字号步进器与默认值/ }).click();
    await page.getByRole("button", { name: /本轮改动|files changed/ }).waitFor();
    await page.getByRole("button", { name: /本轮改动/ }).click();
    await page.locator("aside .overflow-y-auto").waitFor();
    await page.getByPlaceholder("追问、补充或纠正…").fill("单行");
    const m = await measureArea(page);
    const diag = await page.locator("textarea").evaluate((el) => {
      const shell = el.closest(".input-surface");
      const footer = el.parentElement?.querySelector('[data-slot="input-group-addon"]');
      const entry = shell?.querySelector('[data-slot="model-entry"]');
      const prev = footer?.style.width ?? null;
      let footerMax = 0;
      if (footer) { footer.style.width = "max-content"; footerMax = footer.offsetWidth; footer.style.width = prev ?? ""; }
      const kids = footer ? [...footer.children].map((c) => `${c.getAttribute("data-slot") ?? c.tagName}:${Math.round(c.getBoundingClientRect().width)}`) : [];
      const cs = shell ? getComputedStyle(shell) : null;
      return {
        shellClientWidth: shell?.clientWidth ?? 0,
        shellContentWidth: shell ? shell.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) : 0,
        editWidth: el.clientWidth,
        footerWidthNow: footer ? Math.round(footer.getBoundingClientRect().width) : 0,
        footerMaxContent: footerMax,
        entryWidth: entry ? Math.round(entry.getBoundingClientRect().width) : 0,
        entryTextWidth: entry?.innerText ?? "",
        footerChildren: kids,
        window: { w: window.innerWidth, h: window.innerHeight },
      };
    });
    observations.push({ case: "narrow-inspector", ...m, diag });
    console.log("[diag-narrow]", JSON.stringify(diag));
    // 预算诊断（只作取证不作通过条件）：记录实测操作行固有预算与滚动条槽，供两种滚动条
    // 模式（经典占槽 / 叠加为 0）跨环境比对；单行形态要求不随预算波动——见下方断言。
    const budget = await page.locator("textarea").evaluate((el) => {
      const shell = el.closest(".input-surface");
      const shellStyle = getComputedStyle(shell);
      const footer = shell.querySelector('[data-slot="input-group-addon"]');
      const scroller = el.closest(".overflow-y-auto");
      const cw = shell.clientWidth - parseFloat(shellStyle.paddingLeft) - parseFloat(shellStyle.paddingRight);
      // 操作行固有预算：max-content 一次读数后恢复原宽（模型入口已移出卡片，操作行不再有可收起标签）
      const prevW = footer.style.width;
      footer.style.width = "max-content";
      const footerFull = footer.offsetWidth;
      footer.style.width = prevW ?? "";
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      const s = getComputedStyle(el);
      ctx.font = `${s.fontStyle} ${s.fontWeight} ${s.fontSize}/${s.lineHeight} ${s.fontFamily}`;
      const textWidth = ctx.measureText((el.value ?? "").replace(/\s+/g, " ")).width;
      return { cw, footerFull, textWidth: Math.round(textWidth), scrollerGutter: scroller.offsetWidth - scroller.clientWidth };
    });
    observations.push({ case: "narrow-inspector-budget", ...budget });
    // DESIGN 会话输入几何与开发任务路径行为图：一行→输入行与操作行并排、垂直居中，
    // 窄窗与检查器打开同样成立，没有滚动条模式或预算例外；草稿超宽时按内容折行向上长高。
    assert.equal(m.compact, true, "窄窗＋检查器下的单行仍应是输入行与操作行并排的紧凑形态");
    assert.ok(m.editWidth > 0, `编辑区不得被压成零宽（实得 ${m.editWidth}px）`);
    assert.ok(m.areaCenterOffset !== null && Math.abs(m.areaCenterOffset) <= 1, `输入行中心须与卡片中心重合（偏差 ${m.areaCenterOffset}）`);
    assert.ok(m.toolsCenterOffset !== null && Math.abs(m.toolsCenterOffset) <= 1, `操作行中心须与卡片中心重合（偏差 ${m.toolsCenterOffset}）`);
  } finally {
    writeFileSync(join(EVIDENCE, "narrow-centering-observations.json"), JSON.stringify(observations, null, 2));
    try { await handle.close(); } finally { await killApp(handle); cleanup(handle.stateDir); }
  }
});

test("C06 状态说明变长时保持完整可读，且不扰动输入区的排版、草稿与运行状态", async () => {
  // 首次提交返回「待核对」→ C06 说明变长。这是本项目真实会出现的说明变化，不是构造的字符串。
  // 已认可原型把提示放在 composer 之外，提示因此不与输入行争宽度：变长既不该被截断，
  // 也不该改变编辑区的宽度或折行高度。
  const handle = await launchApp(undefined, { DCODE_MOCK_UNKNOWN_ONCE: "1" });
  const { page } = handle;
  const observations = [];
  const noteFit = () =>
    page.evaluate(() => {
      const note = document.querySelector('[data-slot="composer-note"]');
      const el = document.querySelector("textarea");
      if (!note) return null;
      return {
        text: note.textContent.trim(),
        scrollWidth: note.scrollWidth,
        clientWidth: note.clientWidth,
        truncated: note.scrollWidth > note.clientWidth + 1,
        editWidth: el?.clientWidth ?? 0,
        editHeight: el?.clientHeight ?? 0,
      };
    });
  try {
    await ready(page);
    await assertValidationModel(page);
    await page.getByRole("button", { name: /字号步进器与默认值/ }).click();
    await page.getByRole("button", { name: /本轮改动|files changed/ }).waitFor();
    const area = page.getByPlaceholder("追问、补充或纠正…");
    await area.fill("会触发待核对的一句草稿");
    const before = await measureArea(page);
    observations.push({ case: "before", ...before, note: await noteFit() });
    assert.equal(before.compact, true, "前置条件：单行草稿在默认宽度下是紧凑形态");

    await area.press("Enter");
    await page.waitForFunction(
      (old) => {
        const note = document.querySelector('[data-slot="composer-note"]');
        return note && note.textContent.trim().length > old;
      },
      before.noteText.length,
      { timeout: 10_000 },
    );
    await page.waitForTimeout(300);
    const after = await noteFit();
    observations.push({ case: "after", ...after });
    assert.ok(after.text.length > before.noteText.length, "前置条件：C06 说明确实变长");
    assert.equal(after.truncated, false, `C06 说明必须完整可读，不得被输入行挤压截断（内容宽 ${after.scrollWidth} > 可用宽 ${after.clientWidth}）`);
    assert.equal(after.editWidth, before.editWidth, `说明变长不得改变编辑区宽度（${before.editWidth} → ${after.editWidth}）`);
    assert.equal(after.editHeight, before.editHeight, `说明变长不得改变编辑区高度（${before.editHeight} → ${after.editHeight}）`);
    assert.equal(await area.inputValue(), "会触发待核对的一句草稿", "说明变化不得改写草稿");
    // 说明变长与这次发送同时发生，状态本来就该按 C01 变成「待核对」；
    // 这里断言的是说明的加长没有把运行控制替换成别的东西（回执未知仍呈现待核对）
    assert.equal(
      await page.locator('button[data-slot="composer-primary"]').getAttribute("aria-label"),
      "待核对",
      "C01：回执未知时主按钮呈现待核对，说明的加长不替换运行控制",
    );
  } finally {
    writeFileSync(join(EVIDENCE, "note-recalc-observations.json"), JSON.stringify(observations, null, 2));
    try { await handle.close(); } finally { await killApp(handle); cleanup(handle.stateDir); }
  }
});
/**
 * 2026-10-21（507 要求）：来源与模型入口移出输入框，改放会话标题带／草稿标题行。
 * 这组用例守这条新口径：
 *  · 入口不在输入卡片内，卡片工具行只剩引用、主按钮与用途三类入口；
 *  · 窄窗＋检查器打开时入口仍完整可辨，编辑区不被压成零宽；
 *  · 真实改选后标题带里的摘要同步更新，且不改正草稿、不改视口、不改字号。
 */
const modelEntryPlacement = (page) =>
  page.evaluate(() => {
    const trigger = document.querySelector('[data-testid="model-entry-trigger"]');
    const card = document.querySelector(".input-surface");
    if (!trigger || !card) return null;
    const rect = trigger.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    return {
      inCard: !!trigger.closest(".input-surface"),
      inFooter: !!trigger.closest('[data-slot="input-group-addon"]'),
      aboveCard: rect.bottom <= cardRect.top + 1,
      visible: rect.width > 0 && rect.height > 0,
      label: trigger.getAttribute("aria-label") ?? "",
      text: (trigger.textContent ?? "").trim(),
    };
  });

test("模型入口在输入卡片之外：草稿标题行可点可展开，卡片工具行内不再有模型入口", async () => {
  const handle = await launchApp();
  try {
    const { page } = handle;
    await ready(page);
    await page.getByTestId("model-entry-trigger").waitFor({ state: "visible" });
    const placement = await modelEntryPlacement(page);
    assert.ok(placement, "草稿态应有模型入口");
    assert.equal(placement.inCard, false, "模型入口不得在输入卡片内（507：放到输入框以外）");
    assert.equal(placement.inFooter, false, "输入卡片工具行内不得再有模型入口");
    assert.equal(placement.aboveCard, true, "模型入口应在输入卡片上方（草稿标题行）");
    assert.equal(placement.visible, true, "模型入口必须可见");
    assert.ok(placement.label.length > 0, "模型入口须有可访问名称");
    // 展开仍是两级浏览：打开不执行工作，只列来源与模型
    await page.getByTestId("model-entry-trigger").click();
    await page.getByTestId("model-search").waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
  } finally {
    await handle.close();
  }
});

test("会话标题带的模型入口：窄窗＋检查器打开时仍可辨，编辑区不被压成零宽", async () => {
  const handle = await launchApp();
  const { app, page } = handle;
  try {
    await ready(page);
    const session = await page.evaluate(async () => {
      const snap = await window.dcode.getSnapshot();
      return window.dcode.createSession({ taskId: snap.tasks[0].id });
    });
    assert.ok(session?.id, "前置：应能建立会话");
    await gotoSession(page, session.id);
    await page.locator("main textarea").waitFor();
    await page.getByTestId("model-entry-trigger").waitFor({ state: "visible" });
    const placement = await modelEntryPlacement(page);
    assert.ok(placement, "会话态应有模型入口");
    assert.equal(placement.inCard, false, "会话态的模型入口同样不得在输入卡片内");
    assert.equal(placement.visible, true, "会话态的模型入口必须可见");

    // 窄窗＋检查器：入口仍在标题带且可读，编辑区仍有可用宽度
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(720, 480));
    await page.waitForFunction(() => window.innerWidth === 720);
    await page.getByRole("button", { name: /本轮改动|files changed/ }).first().waitFor();
    await page.getByRole("button", { name: /本轮改动|files changed/ }).first().click();
    await page.locator("aside .overflow-y-auto").waitFor();
    await page.waitForTimeout(300);
    const narrow = await modelEntryPlacement(page);
    assert.ok(narrow, "窄窗下仍应有模型入口");
    assert.equal(narrow.visible, true, "窄窗＋检查器下模型入口仍须可见");
    assert.equal(narrow.inCard, false, "窄窗下模型入口仍不得回到输入卡片内");
    assert.ok(narrow.label.length > 0, "窄窗下模型入口的可访问名称仍须完整");
    const editWidth = await page.locator("main textarea").evaluate((el) => el.clientWidth);
    assert.ok(editWidth > 0, `窄窗下编辑区不得被压成零宽（实得 ${editWidth}px）`);
  } finally {
    try { await handle.close(); } finally { await killApp(handle); cleanup(handle.stateDir); }
  }
});

/**
 * F2 反例（普通装配 + loopback 受控目录；验证装配无模型目录，走不了真实改选）：
 * 真实改选后标题带里的摘要必须同步更新，且草稿、视口、字号全程不变。
 */
test("真实改选后标题带的模型摘要同步更新（草稿/视口/字号不变，输入卡片内仍无模型入口）", async () => {
  const seen = [];
  const catalog = await new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (!String(req.url ?? "").startsWith("/catalog")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not-found" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [], providers: [] }));
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ origin: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
  const stateDir = mkdtempSync(join(tmpdir(), "dcode-e2e-model-outside-card-"));
  let handle = null;
  try {
    handle = await launchApp(stateDir, {
      DCODE_CATALOG_BASE_URL: catalog.origin,
      DCODE_E2E_PRESET_BASE_URLS: JSON.stringify({ openai: "http://127.0.0.1:9/v1" }),
      DCODE_E2E_STATE_ROOT: tmpdir(),
      DCODE_E2E: "1",
      DCODE_VALIDATION_ASSEMBLY: "",
    }, ".");
    const { page } = handle;
    await ready(page);
    const session = await page.evaluate(async () => {
      const snap = await window.dcode.getSnapshot();
      return window.dcode.createSession({ taskId: snap.tasks[0].id });
    });
    assert.ok(session?.id, "前置：应能建立会话");
    await gotoSession(page, session.id);
    await page.locator("main textarea").waitFor();
    const area = page.locator("main textarea");
    await area.fill("保持这行草稿");

    const before = await page.evaluate(() => ({
      draft: document.querySelector("main textarea").value,
      vp: `${window.innerWidth}x${window.innerHeight}`,
      font: getComputedStyle(document.body).fontSize,
      label: (document.querySelector('[data-testid="model-entry-trigger"]')?.textContent ?? "").trim(),
    }));
    assert.equal(before.label.length > 0, true, "前置：标题带的模型入口须有摘要文字");

    // 真实改选：两级浏览（先选来源，再点模型）落在标题带的入口上
    await page.getByTestId("model-entry-trigger").click();
    await page.getByTestId("model-search").waitFor({ state: "visible", timeout: 15_000 });
    const sources = page.locator('[data-testid^="model-source-"]');
    await sources.first().waitFor({ state: "visible", timeout: 15_000 });
    await sources.first().click();
    await page.waitForTimeout(150);
    const items = page.locator('[data-testid^="model-item-"]');
    const itemCount = await items.count();
    assert.ok(itemCount > 0, "前置：选中来源后第二层应列出可选模型");
    await items.first().click();
    await page.keyboard.press("Escape");
    await waitForSnapshot(
      page,
      (snap) => Object.values(snap.sessionModels ?? {}).some((s) => s?.choice?.mode === "explicit"),
      undefined,
      "改选模型后应落成显式选择",
    );
    await page.waitForFunction(
      () => (document.querySelector('[data-testid="model-entry-trigger"]')?.textContent ?? "").includes("·"),
      undefined,
      { timeout: 5000 },
    );

    const after = await page.evaluate(() => ({
      draft: document.querySelector("main textarea").value,
      vp: `${window.innerWidth}x${window.innerHeight}`,
      font: getComputedStyle(document.body).fontSize,
      label: (document.querySelector('[data-testid="model-entry-trigger"]')?.textContent ?? "").trim(),
    }));
    assert.equal(after.draft, before.draft, "改选不得改写草稿");
    assert.equal(after.vp, before.vp, "改选期间视口不变");
    assert.equal(after.font, before.font, "改选期间字号不变");
    assert.notEqual(after.label, before.label, "改选后标题带的模型摘要必须同步更新");
    assert.ok(after.label.includes("·"), `改选后摘要应显示来源与模型（实得 ${JSON.stringify(after.label)}）`);
    const placement = await modelEntryPlacement(page);
    assert.equal(placement.inCard, false, "改选后模型入口仍在输入卡片之外");
    seen.push({ step: "re-selected", before: before.label, after: after.label });
  } finally {
    writeFileSync(join(EVIDENCE, "model-outside-card-observations.json"), JSON.stringify(seen, null, 2));
    try {
      await handle?.close();
    } finally {
      if (handle) await killApp(handle);
      cleanup(stateDir);
      await catalog.close();
    }
  }
});
