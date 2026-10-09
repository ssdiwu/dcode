// 滚动故障复现与量测（诊断脚本，非验收测试）：几何矩形、window.scrollY、祖先计算样式、完整日志落盘。
// 用法：node test/e2e/scroll-repro.mjs <prefix>；截图与原始日志写入 test/e2e/screenshots/scroll-<prefix>-*。

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchApp, cleanup, ready } from "./helpers.mjs";

const OUT = join(import.meta.dirname, "screenshots");
mkdirSync(OUT, { recursive: true });
const prefix = process.argv[2];
if (!prefix) throw new Error("需要 prefix（pre/post），不覆盖同名证据");
const lines = [];
const log = (...args) => {
  const line = args.join(" ");
  lines.push(line);
  console.log(line);
};

const { page, stateDir, close } = await launchApp();
try {
  await ready(page);
  await page.getByRole("button", { name: /字号步进器与默认值/ }).click();
  await page.getByRole("button", { name: /本轮改动/ }).waitFor();

  const measure = async () =>
    page.evaluate(() => {
      const rectOf = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) };
      };
      const scrollOf = (el) =>
        el && {
          scrollTop: Math.round(el.scrollTop),
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
        };
      const chain = [];
      let el = document.querySelector("main .overflow-y-auto");
      while (el && el !== document.documentElement) {
        const cs = getComputedStyle(el);
        chain.push({
          tag: el.tagName.toLowerCase() + (el.className && typeof el.className === "string" ? `.${el.className.split(" ").slice(0, 3).join(".")}` : ""),
          height: cs.height,
          minHeight: cs.minHeight,
          overflowY: cs.overflowY,
          flex: cs.flex,
        });
        el = el.parentElement;
      }
      const de = document.documentElement;
      const settingsBtn = Array.from(document.querySelectorAll("nav button")).pop();
      return {
        windowScrollY: window.scrollY,
        documentElement: scrollOf(de),
        body: scrollOf(document.body),
        timeline: scrollOf(document.querySelector("main .overflow-y-auto")),
        sidebar: scrollOf(document.querySelector("nav .overflow-y-auto")),
        inspector: scrollOf(document.querySelector("aside .overflow-y-auto")),
        rects: {
          sidebarNav: rectOf(document.querySelector("nav")),
          settingsBar: rectOf(settingsBtn),
          composer: rectOf(document.querySelector("textarea")?.closest(".input-surface") ?? document.querySelector("textarea")),
          inspectorAside: rectOf(document.querySelector("aside")),
        },
        windowInner: window.innerHeight,
        ancestorsOfTimelineScroller: chain,
      };
    });

  const before = await measure();
  log("BEFORE:", JSON.stringify(before, null, 1));
  await page.screenshot({ path: join(OUT, `scroll-${prefix}-before.png`) });

  await page.locator("main .overflow-y-auto").first().hover();
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(300);
  const afterTl = await measure();
  log("AFTER-TIMELINE-SCROLL:", JSON.stringify(afterTl, null, 1));
  await page.screenshot({ path: join(OUT, `scroll-${prefix}-after-timeline.png`) });

  await page.locator("nav .overflow-y-auto").first().hover();
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(300);
  const afterSide = await measure();
  log("AFTER-SIDEBAR-SCROLL:", JSON.stringify(afterSide, null, 1));
  await page.screenshot({ path: join(OUT, `scroll-${prefix}-after-sidebar.png`) });

  log("VERDICT:", JSON.stringify({
    outerMovedByTimeline: afterTl.documentElement.scrollTop !== before.documentElement.scrollTop || afterTl.windowScrollY !== before.windowScrollY,
    timelineMoved: afterTl.timeline && before.timeline ? afterTl.timeline.scrollTop !== before.timeline.scrollTop : null,
    sidebarMoved: afterSide.sidebar && before.sidebar ? afterSide.sidebar.scrollTop !== before.sidebar.scrollTop : null,
  }));
} finally {
  writeFileSync(join(OUT, `scroll-${prefix}.log`), lines.join("\n"));
  await close();
  cleanup(stateDir);
}
