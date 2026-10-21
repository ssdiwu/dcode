// 侧栏行内菜单的浮层定位：指针离开触发点后菜单仍贴触发点，不跳到窗口左上角。
// 回归由来：悬停显形的触发按钮在菜单打开后失去盒子，浮层锚点归零被定位到 (0,0)，盖住窗口按钮。

import { test } from "node:test";
import assert from "node:assert/strict";
import { launchApp, ready } from "./helpers.mjs";

async function menuRect(page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-slot="dropdown-menu-content"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  });
}

async function triggerRect(page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-slot="dropdown-menu-trigger"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  });
}

test("侧栏菜单：指针离开触发点后仍停在触发点旁", async () => {
  const handle = await launchApp();
  try {
    const { page } = handle;
    await ready(page);
    const trigger = page.locator('[data-slot="dropdown-menu-trigger"]').first();
    const row = trigger.locator('xpath=ancestor::*[@role="treeitem"]');
    await row.hover();
    await trigger.click();
    await page.getByRole("menuitem").first().waitFor({ state: "visible" });
    const opened = await menuRect(page);
    assert.ok(opened, "菜单已打开");

    // 指针离开该行：触发按钮所在的容器会收起，触发点一度没有盒子
    await page.mouse.move(700, 500);
    await page.waitForTimeout(300);
    const after = await menuRect(page);
    const triggerAfter = await triggerRect(page);
    assert.ok(after, "菜单仍在");
    assert.ok(triggerAfter && triggerAfter.width > 0, "菜单打开期间触发点必须仍有盒子");
    assert.ok(after.x > 40 && after.y > 40,
      `菜单不得跳到窗口左上角：实际 (${after.x}, ${after.y})`);
    assert.ok(Math.abs(after.x - opened.x) <= 8 && Math.abs(after.y - opened.y) <= 8,
      `菜单应留在触发点旁：开 (${opened.x}, ${opened.y}) → 移开 (${after.x}, ${after.y})`);
  } finally {
    await handle.close();
  }
});
