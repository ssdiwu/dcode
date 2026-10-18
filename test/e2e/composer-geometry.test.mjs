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

/** 等紧凑判定稳定下来：连续若干次读到同一个 tight 才算收束（判定由 ResizeObserver 触发）。 */
const settleTight = async (area) => {
  let last = null;
  let stable = 0;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const now = await area.evaluate((el) => el.closest(".input-surface")?.dataset.tight ?? null);
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
            compact: singleAtFullWidth, tight: shell.dataset.tight };
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
    // 预算诊断（只作取证不作通过条件）：记录实测两态固有预算与滚动条槽，供两种滚动条
    // 模式（经典占槽 / 叠加为 0）跨环境比对；单行形态要求不随预算波动——见下方断言。
    const budget = await page.locator("textarea").evaluate((el) => {
      const shell = el.closest(".input-surface");
      const shellStyle = getComputedStyle(shell);
      const footer = shell.querySelector('[data-slot="input-group-addon"]');
      const label = shell.querySelector('[data-slot="model-entry-label"]');
      const scroller = el.closest(".overflow-y-auto");
      const cw = shell.clientWidth - parseFloat(shellStyle.paddingLeft) - parseFloat(shellStyle.paddingRight);
      // 两态预算与当前显示态/形态无关：摘 data-tight、max-content 贯穿两次读数（与组件内测量同一资格）
      const prevTight = shell.dataset.tight ?? null;
      if (prevTight !== null) delete shell.dataset.tight;
      const prevW = footer.style.width;
      footer.style.width = "max-content";
      const footerFull = footer.offsetWidth;
      const prevD = label.style.display;
      label.style.display = "none";
      const footerTight = footer.offsetWidth;
      label.style.display = prevD ?? "";
      footer.style.width = prevW ?? "";
      if (prevTight !== null) shell.dataset.tight = prevTight;
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      const s = getComputedStyle(el);
      ctx.font = `${s.fontStyle} ${s.fontWeight} ${s.fontSize}/${s.lineHeight} ${s.fontFamily}`;
      const textWidth = ctx.measureText((el.value ?? "").replace(/\s+/g, " ")).width;
      return { cw, footerFull, footerTight, textWidth: Math.round(textWidth), scrollerGutter: scroller.offsetWidth - scroller.clientWidth };
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
 * 反例：宽窗里空间充足时，C07 要求第一层显示当前来源、模型与条件参数——
 * 收起只能因为**完整预算真的放不下**，不能只看收起后放得下。
 *
 * 走真实渲染：宽窗 → 720 + 检查器打开 → 回到宽窗，逐步核对模型名标签的可见性。
 */
test("模型名只在完整预算放不下时收起：宽窗→窄窗+检查器→宽窗 始终可辨", async () => {
  const handle = await launchApp();
  const { app, page } = handle;
  const seen = [];
  try {
    await ready(page);
    await assertValidationModel(page);
    const label = page.locator('[data-slot="model-entry-label"]');
    const state = async (where) => {
      const probe = await label.evaluate((el) => {
        const shell = el.closest(".input-surface");
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const area = shell?.querySelector("textarea");
        const shellStyle = shell ? getComputedStyle(shell) : null;
        // 独立复算两态预算：不复用组件内部的判定，只量真实几何。
        // 完整宽必须先摘掉 data-tight 呈现态再量；两态都取固有预算——max-content
        // 贯穿两次读数后一并恢复：先恢复原宽度再读收起宽，堆叠形态下会拿到容器宽。
        const footer = shell?.querySelector('[data-slot="input-group-addon"]');
        const prevTight = shell?.dataset.tight ?? null;
        if (shell && prevTight !== null) delete shell.dataset.tight;
        const prev = footer?.style.width ?? null;
        let footerFull = 0;
        let footerTight = 0;
        if (footer) {
          footer.style.width = "max-content";
          footerFull = footer.offsetWidth;
          const prevLabel = el.style.display;
          el.style.display = "none";
          footerTight = footer.offsetWidth;
          el.style.display = prevLabel ?? "";
          footer.style.width = prev ?? "";
        }
        if (shell && prevTight !== null) shell.dataset.tight = prevTight;
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (ctx && area) ctx.font = `${getComputedStyle(area).fontStyle} ${getComputedStyle(area).fontWeight} ${getComputedStyle(area).fontSize}/${getComputedStyle(area).lineHeight} ${getComputedStyle(area).fontFamily}`;
        const textWidth = ctx && area ? ctx.measureText((area.value ?? "").replace(/\s+/g, " ")).width : 0;
        const contentWidth = shell ? shell.clientWidth - parseFloat(shellStyle.paddingLeft) - parseFloat(shellStyle.paddingRight) : 0;
        return {
          tight: shell?.dataset.tight ?? null,
          display: style.display,
          visible: style.display !== "none" && style.visibility !== "hidden" && rect.width > 0,
          text: (el.textContent ?? "").trim(),
          contentWidth: Math.round(contentWidth),
          footerFull,
          footerTight,
          textWidth: Math.round(textWidth),
          draftLength: area?.value?.length ?? 0,
        };
      });
      seen.push({ where, ...probe });
      return probe;
    };

    // 先跑一轮：跟随后续输入的占位符（"追问、补充或纠正…"）才存在
    await page.getByRole("button", { name: /字号步进器与默认值/ }).click();

    // 宽窗 + 短稿：空间充足，模型名必须可见
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
    await page.getByPlaceholder("追问、补充或纠正…").fill("短");
    await settleTight(page.locator("textarea"));
    const wide = await state("宽窗 1440×900 · 短稿");
    assert.equal(wide.tight, "false", `宽窗短稿不应判定为紧凑（实得 tight=${wide.tight}）`);
    assert.equal(wide.visible, true, "宽窗空间充足时必须显示当前模型名");
    assert.ok(wide.text.length > 0, "模型名标签有可读内容");

    // 空稿同样如此：没有内容要占行，不代表可以隐藏模型名
    await page.getByPlaceholder("追问、补充或纠正…").fill("");
    await settleTight(page.locator("textarea"));
    const empty = await state("宽窗 1440×900 · 空稿");
    assert.equal(empty.tight, "false", `宽窗空稿不应判定为紧凑（实得 tight=${empty.tight}）`);
    assert.equal(empty.visible, true, "空稿时也必须显示当前模型名");

    // 窄窗 + 检查器打开：草稿足量、卡片变窄，完整预算真的放不下时才收起
    await page.getByPlaceholder("追问、补充或纠正…").fill("这一条草稿足够长，长到在窄卡片里连模型名标签都放不下，只能收成图标形态才腾得出编辑区与主按钮的位置");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(720, 480));
    await page.getByRole("button", { name: /本轮改动/ }).first().waitFor();
    await page.getByRole("button", { name: /本轮改动/ }).first().click();
    await page.locator("aside .overflow-y-auto").waitFor();
    await settleTight(page.locator("textarea"));
    const narrow = await state("窄窗 720×480 + 检查器打开 · 长稿");
    // 判定式本身：只在「完整预算放不下**且**收起预算放得下」时收起。
    // 这里独立复算两态预算（不复用组件内部判定），避免把实现写死成硬编码期望。
    const fullMisses = narrow.footerFull + narrow.textWidth > narrow.contentWidth;
    const collapsedFits = narrow.footerTight + narrow.textWidth <= narrow.contentWidth;
    assert.equal(
      narrow.tight,
      String(fullMisses && collapsedFits),
      `窄窗判定应等于「完整预算放不下且收起放得下」（完整 ${narrow.footerFull}+${narrow.textWidth} vs ${narrow.contentWidth}；收起 ${narrow.footerTight}+${narrow.textWidth}）`,
    );
    if (!(fullMisses && collapsedFits)) {
      // 连收起也放不下：收起帮不上忙，就不该隐藏模型名——宁可长高也不裁内容
      assert.equal(narrow.visible, true, "收起也放不下时不应隐藏当前模型名");
    }

    // 回到宽窗：必须恢复显示，不能停在收起态（草稿同时回到短稿）
    await page.getByRole("button", { name: "关闭检查器" }).click();
    await page.getByPlaceholder("追问、补充或纠正…").fill("短");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
    await settleTight(page.locator("textarea"));
    const back = await state("回到宽窗 1440×900");
    assert.equal(back.footerFull + back.textWidth <= back.contentWidth, true,
      `回到宽窗后完整预算应放得下（${back.footerFull}+${back.textWidth} vs ${back.contentWidth}）`);
    assert.equal(back.tight, "false", `回到宽窗后应退出紧凑（实得 tight=${back.tight}）`);
    assert.equal(back.visible, true, "回到宽窗后当前模型名必须重新可见");
    assert.ok(back.text.length > 0, "恢复后标签仍有可读内容");
  } finally {
    writeFileSync(join(EVIDENCE, "model-label-visibility.json"), JSON.stringify(seen, null, 2));
    try { await handle.close(); } finally { await killApp(handle); cleanup(handle.stateDir); }
  }
});

/**
 * 反例（预审第 4 项的临界区间）：「收起后恰好放得下、完整标签放不下」。
 * 完整预算的测量若继承当前 data-tight 隐藏态，两态预算会互相矛盾，判定在
 * 收起/完整间无限翻转；两态固有预算必须与当前显示态独立。本用例按实测
 * 宽度构造临界草稿，断言：确实命中区间、真正进入收起态、连续帧不翻转；
 * 宽窗模型名恢复可见；长稿在窄卡仍可编辑（且收起也放不下时不收起）。
 */
/** 量两态固有预算与滚动条槽（诊断/前置自证用）；与组件内测量同一资格：
 *  摘 data-tight、max-content 贯穿两次读数，预算不依赖当前显示态/形态。 */
const measureBudgets = (page) =>
  page.evaluate(() => {
    const area = document.querySelector("main textarea");
    const shell = area.closest(".input-surface");
    const footer = shell.querySelector('[data-slot="input-group-addon"]');
    const label = shell.querySelector('[data-slot="model-entry-label"]');
    if (!footer || !label) return { error: "structure-missing", footerFound: !!footer, labelFound: !!label };
    const scroller = area.closest(".overflow-y-auto");
    const shellStyle = getComputedStyle(shell);
    const cw = shell.clientWidth - parseFloat(shellStyle.paddingLeft) - parseFloat(shellStyle.paddingRight);
    const prevTight = shell.dataset.tight ?? null;
    if (prevTight !== null) delete shell.dataset.tight;
    const prevW = footer.style.width;
    footer.style.width = "max-content";
    const footerFull = footer.offsetWidth;
    const prevD = label.style.display;
    label.style.display = "none";
    const footerTight = footer.offsetWidth;
    label.style.display = prevD ?? "";
    footer.style.width = prevW ?? "";
    if (prevTight !== null) shell.dataset.tight = prevTight;
    if (!footer || !label) {
      // 结构缺失时返回可读诊断（不抛 TypeError），由前置断言带上下文失败
      return {
        error: "structure-missing",
        areaPlaceholder: area?.getAttribute("placeholder"),
        hasShell: !!shell,
        footerFound: !!footer,
        labelFound: !!label,
        mainTextareas: document.querySelectorAll("main textarea").length,
      };
    }
    return {
      cw,
      footerFull,
      footerTight,
      labelText: (label.textContent ?? "").trim(),
      // 草稿页 composer 外层没有滚动容器（产品侧同Nullable），无槽记 null
      scrollerGutter: scroller ? scroller.offsetWidth - scroller.clientWidth : null,
    };
  });

/** 连续 count 个 rAF 帧采样收起判定与标签可见性。 */
const sampleTightFrames = (page, count) =>
  page.evaluate(
    (frames) =>
      new Promise((resolve) => {
        const surface = document.querySelector(".input-surface");
        const label = document.querySelector('[data-slot="model-entry-label"]');
        const out = [];
        const step = () => {
          out.push({
            t: Math.round(performance.now()),
            tight: surface.dataset.tight ?? null,
            labelShown: getComputedStyle(label).display !== "none",
          });
          if (out.length >= frames) resolve(out);
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
    count,
  );

/** 等收起判定到达给定值（5s 内未到达返回 false，由调用方断言）。 */
const waitForTight = (page, value) =>
  page
    .waitForFunction(
      (v) => document.querySelector(".input-surface")?.dataset.tight === v,
      value,
      { timeout: 5000 },
    )
    .then(() => true, () => false);

test("窄卡临界宽度：完整操作行保不住最小编辑宽、收起后保得住 → 进入收起且连续帧不翻转；放宽恢复、长稿不收起可编辑、堆叠起点同宽一致", async () => {
  const handle = await launchApp();
  const { app, page } = handle;
  const seen = [];
  try {
    await ready(page);
    await assertValidationModel(page);
    await page.getByRole("button", { name: /字号步进器与默认值/ }).click();
    await page.getByPlaceholder("追问、补充或纠正…").waitFor();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(720, 480));
    await page.waitForFunction(() => window.innerWidth === 720 && window.innerHeight <= 482);
    await page.getByRole("button", { name: /本轮改动/ }).first().click();
    await page.locator("aside .overflow-y-auto").waitFor();

    // 阶段一（窄卡临界宽度区间 [footerTight+24, footerFull+24)）：单行短稿下完整操作行
    // 保不住最小编辑宽、收起后保得住——这正是标签收起的设计触发点；测量若继承隐藏态
    // （完整宽读到收起宽），两档地板互相矛盾，判定会在收起/完整间持续翻转。
    await page.getByPlaceholder("追问、补充或纠正…").fill("单行");
    const budget = await measureBudgets(page);
    seen.push({ step: "narrow-budget", ...budget });
    assert.ok(
      budget.footerFull + 24 > budget.cw && budget.footerTight + 24 <= budget.cw,
      `前置：窄卡须落在临界宽度区间（完整 ${budget.footerFull}+24 > ${budget.cw}；收起 ${budget.footerTight}+24 ≤ ${budget.cw}；滚动条槽 ${budget.scrollerGutter}）`,
    );
    const entered = await waitForTight(page, "true");
    assert.equal(entered, true, "临界宽度下单行短稿必须真正进入收起态");

    const frames = await sampleTightFrames(page, 16);
    seen.push({ step: "frames", samples: frames });
    const distinct = [...new Set(frames.map((f) => f.tight))];
    assert.equal(distinct.length, 1, `临界宽度连续 16 帧判定须稳定（实测取值 ${JSON.stringify(distinct)}，前几帧 ${JSON.stringify(frames.slice(0, 6))}）`);
    assert.equal(frames[0].tight, "true", "临界宽度的稳定判定必须是收起态");
    assert.ok(frames.every((f) => !f.labelShown), "收起态下模型名标签不可见（可访问名称仍在触发器 aria-label 上）");

    // 阶段二（放宽恢复）：关检查器放宽卡片，标签必须重新可见，不能停在收起态
    await page.getByRole("button", { name: "关闭检查器" }).click();
    const restored = await settleTight(page.locator("textarea"));
    assert.equal(restored, "false", "放宽后应退出收起（完整操作行重新保得住最小编辑宽）");
    const labelVisibleAgain = await page.locator('[data-slot="model-entry-label"]').evaluate((el) => getComputedStyle(el).display !== "none" && el.getBoundingClientRect().width > 0);
    assert.equal(labelVisibleAgain, true, "放宽后当前模型名必须重新可见");

    // 阶段三（长稿）：多行堆叠时操作行独占一行，收起换不回编辑宽 → 不收起、仍可编辑。
    // 键入可达草稿即证可编辑：光标位置由 click/End 既有语义决定，不把「追加在末尾」当断言对象。
    await page.getByPlaceholder("追问、补充或纠正…").fill("长".repeat(400));
    const longSettled = await settleTight(page.locator("textarea"));
    assert.equal(longSettled, "false", "多行长稿不得进入收起态（堆叠时操作行独占一行，收起换不回编辑宽）");
    const area = page.locator("textarea");
    await area.click();
    await area.press("End");
    await area.pressSequentially("tail9", { delay: 20 });
    const value = await area.inputValue();
    assert.ok(value.includes("tail9") && value.length === 405, `长稿仍可编辑（实际长度 ${value.length}，含 tail9=${value.includes("tail9")}）`);
    seen.push({ step: "long-draft-editable", valueLength: value.length, typedReached: value.includes("tail9") });

    // 阶段四（同宽堆叠起点）：同一窄宽度下从堆叠长稿直接换回短稿，固有预算不依赖起点形态
    // （收起宽读到容器宽的旧缺陷会随形态给出不同判定），判定须与阶段一一致。
    await page.getByRole("button", { name: /本轮改动/ }).first().click();
    await page.locator("aside .overflow-y-auto").waitFor();
    const budget4 = await measureBudgets(page);
    seen.push({ step: "stacked-start-budget", ...budget4 });
    assert.ok(
      budget4.footerFull + 24 > budget4.cw && budget4.footerTight + 24 <= budget4.cw,
      `阶段四卡宽须仍在临界区间（${JSON.stringify(budget4)}）`,
    );
    await page.getByPlaceholder("追问、补充或纠正…").fill("单行");
    const entered2 = await waitForTight(page, "true");
    assert.equal(entered2, true, "堆叠起点换短稿后须同样进入收起态");
    const frames2 = await sampleTightFrames(page, 16);
    const distinct2 = [...new Set(frames2.map((f) => f.tight))];
    assert.equal(distinct2.length, 1, `堆叠起点的连续 16 帧判定须稳定（${JSON.stringify(distinct2)}）`);
    assert.equal(frames2[0].tight, "true", "堆叠起点的稳定判定必须是收起态");
    seen.push({ step: "stacked-start-narrow", distinct: distinct2 });
  } finally {
    writeFileSync(join(EVIDENCE, "critical-band-observations.json"), JSON.stringify(seen, null, 2));
    try { await handle.close(); } finally { await killApp(handle); cleanup(handle.stateDir); }
  }
});

/**
 * F2 反例（普通装配 + loopback 受控目录；验证装配无模型目录，走不了真实改选）：
 * 收起态下标签盒宽 0→0，仅靠盒尺寸观察捕不到内容变化——真实改选把摘要换成更短
 * （完整操作行重新保得住最小编辑宽）时必须自动恢复标签可见；草稿、视口、字号全程不变。
 */
test("收起态真实改选更短摘要：完整预算重新放得下时标签自动恢复可见（草稿/视口/字号不变）", async () => {
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
  const stateDir = mkdtempSync(join(tmpdir(), "dcode-e2e-tight-reselect-"));
  let handle = null;
  try {
    handle = await launchApp(stateDir, {
      DCODE_CATALOG_BASE_URL: catalog.origin,
      DCODE_E2E_PRESET_BASE_URLS: JSON.stringify({ openai: "http://127.0.0.1:9/v1" }),
      DCODE_E2E_STATE_ROOT: tmpdir(),
      DCODE_E2E: "1",
      DCODE_VALIDATION_ASSEMBLY: "",
    }, ".");
    const { app, page } = handle;
    await ready(page);
    // 建会话并真实进入（侧栏 treeitem 点击）；空会话走草稿页 Composer（同样按 sessionId 归属）
    const session = await page.evaluate(async () => {
      const snap = await window.dcode.getSnapshot();
      return window.dcode.createSession({ taskId: snap.tasks[0].id });
    });
    assert.ok(session?.id, "前置：应能建立会话");
    await gotoSession(page, session.id);
    await page.locator("main textarea").waitFor();
    const area = page.locator("main textarea");

    // 真实改选长名模型（第二层文本最长的条目），让第一层标签成为长摘要
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
    await page.waitForFunction(() => window.innerWidth === 1440);
    await page.getByTestId("model-entry-trigger").click();
    await page.getByTestId("model-search").waitFor({ state: "visible", timeout: 15_000 });
    const items = page.locator('[data-testid^="model-item-"]');
    const itemCount = await items.count();
    assert.ok(itemCount > 0, "前置：普通装配第二层应列出可选模型");
    let longestIdx = 0;
    let longestText = "";
    for (let i = 0; i < itemCount; i += 1) {
      const text = await items.nth(i).innerText();
      if (text.length > longestText.length) {
        longestText = text;
        longestIdx = i;
      }
    }
    await items.nth(longestIdx).click();
    await page.keyboard.press("Escape");
    await waitForSnapshot(
      page,
      (snap) => Object.values(snap.sessionModels ?? {}).some((s) => s?.choice?.mode === "explicit"),
      undefined,
      "改选长名模型后应落成显式选择",
    );
    await page.waitForFunction(() => (document.querySelector('[data-slot="model-entry-label"]')?.textContent ?? "").includes("·"));

    // 目标卡宽：完整操作行（长标签）保不住最小编辑宽、改回「auto」短标签后保得住——
    // 两档地板之间标签长度决定可见性。自适应调窗命中区间中点（映射近似线性，逐步收敛）。
    const longBudget = await measureBudgets(page);
    const autoW = await page.evaluate(() => {
      const label = document.querySelector('[data-slot="model-entry-label"]');
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      const s = getComputedStyle(label);
      ctx.font = `${s.fontStyle} ${s.fontWeight} ${s.fontSize}/${s.lineHeight} ${s.fontFamily}`;
      return ctx.measureText("auto").width;
    });
    const fullFloorLong = longBudget.footerFull + 24;
    const fullFloorAuto = longBudget.footerTight + autoW + 24 + 2;
    seen.push({ step: "long-budget", ...longBudget, autoW: Math.round(autoW), fullFloorLong, fullFloorAuto });
    assert.ok(
      fullFloorAuto < fullFloorLong - 8,
      `前置：长短两档完整地板须拉开差距（auto ${Math.round(fullFloorAuto)} vs long ${fullFloorLong}）`,
    );
    const target = Math.round((fullFloorAuto + fullFloorLong) / 2);
    // 正常桌面最小宽720，草稿页没有检查器；缩到更小的窗口会被宿主钳回720，
    // 无法命中窄卡预算。此反例只控制卡片边界，保真实普通装配与改选通路；
    // 实际窄窗+检查器的强居中路径由前面的完整用例验证，不降低宿主最小窗口约束。
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(720, 480));
    await page.waitForFunction(() => window.innerWidth === 720 && window.innerHeight === 480);
    await page.locator(".input-surface").evaluate((shell, contentWidth) => {
      const style = getComputedStyle(shell);
      const outerWidth = contentWidth + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
        + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
      shell.style.width = `${outerWidth}px`;
      shell.style.maxWidth = `${outerWidth}px`;
    }, target);
    const narrowBudget = await measureBudgets(page);
    seen.push({ step: "narrow-budget", ...narrowBudget });
    assert.ok(
      !narrowBudget.error && narrowBudget.footerFull + 24 > narrowBudget.cw && narrowBudget.footerTight + autoW + 24 + 2 <= narrowBudget.cw,
      `前置：目标卡宽须使长标签保不住、auto 标签保得住最小编辑宽（${JSON.stringify({ ...narrowBudget, autoW: Math.round(autoW), target })}）`,
    );

    // 单行短稿 → 长标签下真实进入收起态，确认标签隐藏；记录此后不得变化的不变量
    await area.fill("单行");
    const entered = await waitForTight(page, "true");
    assert.equal(entered, true, "长标签窄卡下单行短稿须真实进入收起态");
    const hiddenBefore = await page.locator('[data-slot="model-entry-label"]').evaluate((el) => getComputedStyle(el).display === "none" || el.getBoundingClientRect().width === 0);
    assert.equal(hiddenBefore, true, "前置：收起态下标签不可见");
    const before = await page.evaluate(() => ({
      draft: document.querySelector("main textarea").value,
      vp: `${window.innerWidth}x${window.innerHeight}`,
      font: getComputedStyle(document.body).fontSize,
    }));

    // 真实改选回「自动」：摘要变短；此后不再动草稿/视口/字号。
    // 收起态标签盒宽 0→0、无盒尺寸 RO 通知；内容变化必须仍触发重测并恢复可见。
    await page.getByTestId("model-entry-trigger").click();
    await page.getByTestId("model-choice-auto").waitFor({ state: "visible", timeout: 15_000 });
    await page.getByTestId("model-choice-auto").click();
    await page.keyboard.press("Escape");
    const restoredVisible = await page
      .waitForFunction(
        () => {
          const label = document.querySelector('[data-slot="model-entry-label"]');
          return !!label && getComputedStyle(label).display !== "none" && label.getBoundingClientRect().width > 0;
        },
        undefined,
        { timeout: 5000 },
      )
      .then(() => true, () => false);
    assert.equal(restoredVisible, true, "改选更短摘要后标签须自动恢复可见（收起态内容变化也要重测）");
    const after = await page.evaluate(() => ({
      draft: document.querySelector("main textarea").value,
      vp: `${window.innerWidth}x${window.innerHeight}`,
      font: getComputedStyle(document.body).fontSize,
      tight: document.querySelector(".input-surface")?.dataset.tight ?? null,
    }));
    assert.equal(after.draft, before.draft, "改选不得改写草稿");
    assert.equal(after.vp, before.vp, "改选期间视口不变");
    assert.equal(after.font, before.font, "改选期间字号不变");
    assert.equal(after.tight, "false", "短摘要放得下后不得再判定收起");
    seen.push({ step: "re-selected-auto", ...after });
  } finally {
    writeFileSync(join(EVIDENCE, "tight-reselect-observations.json"), JSON.stringify(seen, null, 2));
    try {
      await handle?.close();
    } finally {
      if (handle) await killApp(handle);
      cleanup(stateDir);
      await catalog.close();
    }
  }
});
