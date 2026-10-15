// 焦点/悬停/选中实际渲染帧采集（非测试）：覆盖此前确有问题的三类目标——
// 填色发送钮（反色描边）、壳内 Stepper 子按钮（壳内子目标可辨）、菜单项（菜单内持焦），
// 以及真实 hover 与 selected 行。全部经真实 Tab 到达并断言 matches(":focus-visible") 与实际描边；
// 每帧落 meta 记录（目标/类名/computed 样式），便于区分采集错误与产品问题。
// 首轮失败日志（hover-only 与鼠标 .focus() 版本）保留在 frames 目录与 /tmp 原日志，不覆写。

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchApp, cleanup, ready, assertValidationModel } from "./helpers.mjs";
import { evidenceDir } from "./evidence-root.mjs";

const OUT = evidenceDir("focus-frames");
mkdirSync(OUT, { recursive: true });
const meta = [];

const { page, stateDir, close } = await launchApp();

const focusedInfo = () =>
  page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    return {
      role: el.getAttribute("role") ?? el.tagName.toLowerCase(),
      label: (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 24),
      focusVisible: el.matches(":focus-visible"),
      shadow: getComputedStyle(el).boxShadow,
      cls: typeof el.className === "string" ? el.className.slice(0, 160) : "",
    };
  });

const tabUntil = async (pred, cap = 40) => {
  for (let i = 0; i < cap; i++) {
    await page.keyboard.press("Tab");
    const info = await focusedInfo();
    if (info && pred(info)) return info;
  }
  return null;
};

const shot = async (file, expect) => {
  await page.screenshot({ path: join(OUT, file) });
  meta.push({ file, ...expect });
};

try {
  await ready(page);
  await assertValidationModel(page);

  for (const dark of [false, true]) {
    const tag = dark ? "dark" : "light";
    await page.evaluate((d) => window.dcode.updateSettings({ theme: d ? "dark" : "light" }), dark);
    await page.waitForFunction((d) => document.documentElement.classList.contains("dark") === d, dark);
    const primaryFill = dark ? "rgb(236, 236, 238)" : "rgb(28, 25, 23)";

    // 1) 填色发送钮：填字→Tab→发送钮；等填充过渡落定（最终填色）再存，不截中间灰态
    const composer = page.getByPlaceholder("交代需求、提问或粘贴内容…");
    await composer.fill("焦点帧验证");
    const send = await tabUntil((i) => i.role === "button" && i.label === "发送");
    if (!send) throw new Error(`${tag}: Tab 未到发送钮`);
    if (!send.focusVisible || send.shadow === "none") {
      throw new Error(`${tag}: 发送钮无 :focus-visible 描边（${JSON.stringify(send)}）`);
    }
    await page.waitForFunction((color) => {
      const el = document.activeElement;
      return el?.getAttribute("aria-label") === "发送" && getComputedStyle(el).backgroundColor === color;
    }, primaryFill);
    await shot(`${tag}-发送钮持焦.png`, { target: "发送", ...send, finalFill: primaryFill });

    // 2) 壳内 Stepper 子按钮：设置页 Tab 到「减小」
    await page.getByRole("button", { name: /^设置/ }).click();
    const minus = await tabUntil((i) => i.role === "button" && i.label === "减小");
    if (!minus) throw new Error(`${tag}: Tab 未到步进器子按钮`);
    if (!minus.focusVisible || minus.shadow === "none") {
      throw new Error(`${tag}: 步进器子按钮无 :focus-visible 描边（${JSON.stringify(minus)}）`);
    }
    await shot(`${tag}-步进器子按钮持焦.png`, { target: "减小", ...minus });
    await page.keyboard.press("Escape");
    await page.getByRole("heading", { name: "开始一项新工作" }).waitFor();

    // 3) 菜单项：D Code 展开态保障 → 触发钮 Space 开菜单 → Tab 进菜单项（几何须不被侧栏裁切）
    const wsRow = page.getByRole("treeitem", { name: "D Code" });
    if ((await wsRow.getAttribute("aria-expanded")) !== "true") await wsRow.click();
    const taskRow = page.getByRole("treeitem", { name: "重构工作台 UI" });
    await taskRow.hover();
    const trigger = taskRow.getByRole("button", { name: "任务操作" });
    await trigger.waitFor({ state: "visible" });
    await trigger.focus();
    await page.keyboard.press("Space");
    await page.getByRole("menu").waitFor();
    const clip = await page.evaluate(() => {
      const nav = document.querySelector("nav").getBoundingClientRect();
      const menu = document.querySelector('[role="menu"]').getBoundingClientRect();
      return { navL: nav.left, navR: nav.right, menuL: menu.left, menuR: menu.right };
    });
    if (!(clip.menuL >= clip.navL && clip.menuR <= clip.navR + 1)) {
      throw new Error(`${tag}: 菜单被侧栏裁切（${JSON.stringify(clip)}）`);
    }
    const item = await tabUntil((i) => i.role === "menuitem");
    if (!item) throw new Error(`${tag}: Tab 未进菜单项`);
    if (!item.focusVisible || item.shadow === "none") {
      throw new Error(`${tag}: 菜单项无 :focus-visible 描边（${JSON.stringify(item)}）`);
    }
    await shot(`${tag}-菜单项持焦.png`, { target: "menuitem", ...item, clip });
    await page.keyboard.press("Escape");
    await page.getByRole("menu").waitFor({ state: "hidden" });

    // 4) 真实 hover 与 selected（手风琴可能沿上轮保持展开：已见会话行则直接点它，不再 toggle 任务行）
    const other = page.getByRole("treeitem", { name: "整理读书笔记" });
    await other.hover();
    const hoverBg = await other.evaluate((el) => getComputedStyle(el).backgroundColor);
    const expectHover = dark ? "rgba(245, 245, 244, 0.06)" : "rgba(23, 23, 23, 0.05)";
    if (hoverBg !== expectHover) throw new Error(`${tag}: 悬停底色不符（${hoverBg}）`);
    await shot(`${tag}-悬停行.png`, { target: "treeitem-hover", bg: hoverBg });
    const sessionRow = page.getByRole("treeitem", { name: "《设计中的设计》摘抄" });
    if ((await sessionRow.count()) > 0) {
      await sessionRow.click();
    } else {
      await other.click();
      await sessionRow.waitFor();
    }
    await page.waitForFunction(() =>
      document.querySelector('[role="treeitem"].bg-selected')?.textContent?.includes("摘抄"),
    );
    const selectedBg = await page.evaluate(
      () => getComputedStyle(document.querySelector('[role="treeitem"].bg-selected')).backgroundColor,
    );
    const expectSelected = dark ? "rgba(245, 245, 244, 0.12)" : "rgba(23, 23, 23, 0.09)";
    if (selectedBg !== expectSelected) throw new Error(`${tag}: 选中底色不符（${selectedBg}）`);
    await shot(`${tag}-选中行.png`, { target: "treeitem-selected", bg: selectedBg });

    // 回到草稿起点供下一轮
    await page.getByRole("treeitem", { name: "默认任务" }).nth(1).click();
    await page.getByRole("heading", { name: "开始一项新工作" }).waitFor();
  }
  writeFileSync(join(OUT, "frames-meta.json"), JSON.stringify(meta, null, 2));
  console.log(`frames + meta written to ${OUT}`);
} finally {
  await close();
  cleanup(stateDir);
}
