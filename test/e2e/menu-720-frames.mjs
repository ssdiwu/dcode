// 720×480 紧凑窗口下任务菜单实开实证：选项在收窄的侧栏内完整可见、Tab 可达、Esc 回触发点。
// 复用 frames 同一路径；留帧与 meta，供人工评审与差异复审。
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchApp, cleanup, ready, assertValidationModel } from "./helpers.mjs";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "evidence", "style-2026-10-06", "frames");
mkdirSync(OUT, { recursive: true });
const meta = [];

const { app, page, stateDir, close } = await launchApp();
try {
  await ready(page);
  await assertValidationModel(page);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(720, 480));
  await page.getByRole("heading", { name: "开始一项新工作" }).waitFor();

  const wsRow = page.getByRole("treeitem", { name: "D Code" });
  if ((await wsRow.getAttribute("aria-expanded")) !== "true") await wsRow.click();
  const taskRow = page.getByRole("treeitem", { name: "重构工作台 UI" });
  await taskRow.hover();
  const trigger = taskRow.getByRole("button", { name: "任务操作" });
  await trigger.waitFor({ state: "visible" });
  await trigger.evaluate((el) => { window.__t720 = el; });
  await taskRow.evaluate((el) => { window.__r720 = el; });
  await trigger.focus();
  await page.keyboard.press("Space");
  await page.getByRole("menu").waitFor();

  // 几何：菜单（约 163px 最小宽）在 216px 侧栏内完整可见，不逼出横向滚动条
  const geo = await page.evaluate(() => {
    const nav = document.querySelector("nav");
    const navRect = nav.getBoundingClientRect();
    const menu = document.querySelector('[role="menu"]').getBoundingClientRect();
    return {
      win: window.innerWidth,
      navW: navRect.width,
      menu: { l: menu.left, r: menu.right, w: menu.width },
      navL: navRect.left, navR: navRect.right,
      navScrollW: nav.scrollWidth, navClientW: nav.clientWidth,
    };
  });
  if (!(geo.menu.l >= geo.navL && geo.menu.r <= geo.navR + 1)) {
    throw new Error(`720 菜单被侧栏裁切（${JSON.stringify(geo)}）`);
  }
  if (geo.navScrollW > geo.navClientW + 1) throw new Error(`720 侧栏出现横向滚动条（${JSON.stringify(geo)}）`);

  // 菜单项完整可见且 Tab 可达：逐项文字完整（不被裁掉）
  const items = await page.evaluate(() =>
    [...document.querySelectorAll('[role="menuitem"]')].map((el) => ({
      text: el.textContent,
      fullyVisible: el.getBoundingClientRect().right <= document.querySelector("nav").getBoundingClientRect().right + 1,
    })),
  );
  if (!items.every((i) => i.fullyVisible)) throw new Error(`720 菜单项不完整可见（${JSON.stringify(items)}）`);
  await page.keyboard.press("ArrowDown"); // Radix 键盘结构：方向键导航菜单项
  const inItem = await page.evaluate(() => {
    const el = document.activeElement;
    return el ? { role: el.getAttribute("role"), fv: el.matches(":focus-visible"), shadow: getComputedStyle(el).boxShadow } : null;
  });
  if (!inItem || inItem.role !== "menuitem" || !inItem.fv || inItem.shadow === "none") {
    throw new Error(`720 菜单项不可达或无焦点描边（${JSON.stringify(inItem)}）`);
  }
  await page.screenshot({ path: join(OUT, "720-菜单实开.png") });
  meta.push({ file: "720-菜单实开.png", geo, items, inItem });

  // Esc 关闭：焦点回原触发钮或原任务行（同一元素身份且可见）
  await page.keyboard.press("Escape");
  await page.getByRole("menu").waitFor({ state: "hidden" });
  await page.waitForFunction(() => {
    const el = document.activeElement;
    return el && (el === window.__t720 || el === window.__r720) && el.offsetParent !== null;
  });
  meta.push({ escReturn: "trigger-or-row(identity,visible)" });
  writeFileSync(join(OUT, "menu-720-meta.json"), JSON.stringify(meta, null, 2));
  console.log("720 menu evidence written");
} finally {
  await close();
  cleanup(stateDir);
}
