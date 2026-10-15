// 树与对话框的纯键盘路径：鼠标不悬停任何行，Tab 直达行与子控件，子目标可见且可激活，
// 退出后焦点回到触发点、父行状态不误变；子控件冒泡不触发父行（回归：首轮红日志见证据目录）。

import { mkdirSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { launchApp, cleanup, ready, assertValidationModel, waitForSnapshot } from "./helpers.mjs";
import { evidenceDir } from "./evidence-root.mjs";
import { join } from "node:path";

test("纯键盘路径：行与子控件可达可辨，激活不误触父行，退出回到触发点", async () => {
  const { page, stateDir, close } = await launchApp();
  try {
    await ready(page);
    await page.getByRole("heading", { name: "开始一项新工作" }).waitFor();
    // 鼠标停在工作区中部（不在任何树行上），全程键盘
    await page.mouse.move(700, 400);

    const focusedInfo = () =>
      page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        return {
          role: el.getAttribute("role") ?? el.tagName.toLowerCase(),
          label: (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 24),
          shadow: getComputedStyle(el).boxShadow,
        };
      });
    const tabUntil = async (pred, cap = 60) => {
      for (let i = 0; i < cap; i++) {
        await page.keyboard.press("Tab");
        const info = await focusedInfo();
        if (info && pred(info)) return info;
      }
      return null;
    };

    // 1) Tab 到 D Code 空间行：持焦行自身有描边，且行内 + 按钮不靠鼠标也变得可见
    const wsRow = page.getByRole("treeitem", { name: "D Code" });
    const wsFocused = await tabUntil((i) => i.role === "treeitem" && i.label.startsWith("D Code"));
    assert.ok(wsFocused, "Tab 应能到达 D Code 空间行");
    assert.notEqual(wsFocused.shadow, "none", "持焦行自身须有焦点描边");
    const plus = wsRow.getByRole("button", { name: "在此空间新建任务" });
    await plus.waitFor({ state: "visible" }); // focus-within 揭示，不经鼠标

    // 2) Tab 到 + 按钮并 Enter：打开创建对话框；父行展开态不变
    const plusFocused = await tabUntil((i) => i.role === "button" && i.label === "在此空间新建任务");
    assert.ok(plusFocused, "Tab 应能到达行内 + 按钮");
    assert.notEqual(plusFocused.shadow, "none", "持焦 + 按钮须有自身描边");
    const wsExpandedBefore = await wsRow.getAttribute("aria-expanded");
    await page.keyboard.press("Enter");
    await page.getByRole("dialog").waitFor();
    // 模态打开期间 Radix 会把背景内容 aria-hide（背景不再出现于可达性树），
    // 父行状态改用 DOM 直读核对：子按钮 Enter 不得改变父行展开态
    const wsExpandedDuring = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[role="treeitem"]')];
      const row = rows.find((r) => (r.textContent ?? "").startsWith("D Code"));
      return row?.getAttribute("aria-expanded") ?? null;
    });
    assert.equal(wsExpandedDuring, wsExpandedBefore, "子按钮 Enter 不得改变父行展开态");

    // 模态焦点圈：先填入标题使「创建」可聚焦，再核 Tab/Shift+Tab 只在面板内首尾循环，背景不成为键盘目标
    await page.getByPlaceholder("任务名称").fill("键盘可达验证");
    await page.keyboard.press("Tab"); // 输入→取消
    assert.equal((await focusedInfo())?.label, "取消", "Tab 输入→取消");
    await page.keyboard.press("Tab");
    assert.equal((await focusedInfo())?.label, "创建", "Tab 取消→创建");
    await page.keyboard.press("Tab");
    console.log("[trap] Tab3:", JSON.stringify(await focusedInfo()));
    console.log("[trap] panel buttons:", await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] button')].map((b) => b.textContent?.trim())));
    assert.equal((await focusedInfo())?.role, "input", "Tab 创建→循环回输入框（不落到背景）");
    await page.keyboard.press("Shift+Tab");
    assert.equal((await focusedInfo())?.label, "创建", "Shift+Tab 输入→创建（尾部）");
    await page.keyboard.press("Shift+Tab");
    assert.equal((await focusedInfo())?.label, "取消", "Shift+Tab 创建→取消");
    // 实际 Dialog 帧：Tab 到创建钮（含焦点描边）
    await page.keyboard.press("Tab");
    assert.equal((await focusedInfo())?.label, "创建", "帧前 Tab 取消→创建");
    const FRAMES = evidenceDir("keyboard-tree", "frames");
    mkdirSync(FRAMES, { recursive: true });
    await page.screenshot({ path: join(FRAMES, "dialog-焦点圈.png") });
    // 对话框关闭后焦点回到触发点所在行（行内操作钮失焦即隐藏不可直接聚焦，回到行后 focus-within 重新揭示）；
    // 恢复发生在 rAF（输入框移除后浏览器先回落 body），须等恢复真实完成而不是即时读取
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.waitForFunction(() => {
      const el = document.activeElement;
      return el?.getAttribute("role") === "treeitem" && (el.textContent ?? "").startsWith("D Code");
    });
    const plusAgain = wsRow.getByRole("button", { name: "在此空间新建任务" });
    await plusAgain.waitFor({ state: "visible" }); // 回到行后操作钮重新可见

    // 3) 行自身 Enter 展开空间；Tab 到任务行的菜单触发钮（此时已可见），Space 开菜单
    await wsRow.focus();
    await page.keyboard.press("Enter"); // 展开 D Code（行自身键盘操作）
    const taskRow = page.getByRole("treeitem", { name: "重构工作台 UI" });
    const taskFocused = await tabUntil((i) => i.role === "treeitem" && i.label.startsWith("重构工作台"));
    assert.ok(taskFocused, "Tab 应能到达任务行");
    const menuTrigger = taskRow.getByRole("button", { name: "任务操作" });
    await menuTrigger.waitFor({ state: "visible" });
    await menuTrigger.evaluate((el) => { window.__kbTriggerA = el; });
    await taskRow.evaluate((el) => { window.__kbRowA = el; });
    const menuFocused = await tabUntil((i) => i.role === "button" && i.label === "任务操作");
    assert.ok(menuFocused, "Tab 应能到达任务菜单触发钮");
    const taskExpandedBefore = await taskRow.getAttribute("aria-expanded");
    await page.keyboard.press("Space");
    await page.getByRole("menu").waitFor();
    // 菜单几何：触发钮在侧栏右缘，菜单须向左内开、不被侧栏横向裁切或逼出横向滚动条
    const clip = await page.evaluate(() => {
      const nav = document.querySelector("nav").getBoundingClientRect();
      const menu = document.querySelector('[role="menu"]').getBoundingClientRect();
      const navEl = document.querySelector("nav");
      return {
        navL: nav.left, navR: nav.right, menuL: menu.left, menuR: menu.right,
        navScrollW: navEl.scrollWidth, navClientW: navEl.clientWidth,
      };
    });
    assert.ok(clip.menuL >= clip.navL && clip.menuR <= clip.navR + 1, `菜单须在侧栏内完整可见（menu[${clip.menuL},${clip.menuR}] vs sidebar[${clip.navL},${clip.navR}]）`);
    assert.ok(clip.navScrollW <= clip.navClientW + 1, "侧栏不得出现横向滚动条");
    await page.getByRole("menuitem", { name: /移动到/ }).waitFor();
    // 首版不提供永久删除（507 归档 A，spec N07）：任务操作菜单不得出现删除类入口
    assert.equal(await page.getByRole("menuitem", { name: /删除任务/ }).count(), 0, "任务操作菜单不得包含永久删除入口");
    assert.equal(await taskRow.getAttribute("aria-expanded"), taskExpandedBefore, "菜单触发 Space 不得切换父行展开态");
    // Tab 进菜单项后 Esc：菜单项随关闭卸载，焦点须回有效触发点而不是滞留在已移除元素上
    await page.keyboard.press("Tab");
    const inItem = await focusedInfo();
    assert.ok(inItem && inItem.role === "menuitem", "Tab 应能进入菜单项");
    assert.notEqual(inItem.shadow, "none", "持焦菜单项须有焦点描边");
    await page.keyboard.press("Escape");
    await page.getByRole("menu").waitFor({ state: "hidden" });
    // 恢复目标按元素身份核：原触发钮或原任务行（且可见），不允许滞留 body 或已卸载的菜单项
    await page.waitForFunction(() => {
      const el = document.activeElement;
      return el && (el === window.__kbTriggerA || el === window.__kbRowA) && (el).offsetParent !== null;
    });
    const afterMenu = await focusedInfo();
    assert.ok(afterMenu && (afterMenu.label === "任务操作" || afterMenu.label.startsWith("重构工作台")), "菜单项内 Esc 后焦点须回到触发钮或可用行");
    const selectedText = await page.evaluate(
      () => document.querySelector('[role="treeitem"].bg-selected')?.textContent ?? null,
    );
    assert.ok(!selectedText?.includes("重构工作台"), "菜单触发 Space 不得选中任务行");

    // 3b) 菜单项键盘激活真实操作（任务移动到另一工作空间）：删除确认流已随永久删除退出，
    //   这里核真实操作自身——对象按目标空间生效、父行状态不被冒泡改变；
    //   移动是状态事实，持久化后活的列表才更新，等真实结果而不是即时读
    const selectedBefore = await page.evaluate(
      () => document.querySelector('[role="treeitem"].bg-selected')?.textContent ?? null,
    );
    const menuTriggerAgain = taskRow.getByRole("button", { name: "任务操作" });
    await menuTriggerAgain.focus();
    await page.keyboard.press("Space");
    await page.getByRole("menu").waitFor();
    const moveItem = page.getByRole("menuitem", { name: /移动到「Home」/ });
    await moveItem.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("menu").waitFor({ state: "hidden" });
    // 移动是状态事实：按正式快照核真实归属（Home 空间默认展开，行名去重）
    await waitForSnapshot(page, (s) =>
        s.tasks.find((t) => t.title === "重构工作台 UI")?.workspaceId === "ws-home",
    );
    assert.equal(await wsRow.getAttribute("aria-expanded"), "true", "菜单操作不得改变父工作空间展开态");
    const selectedAfter = await page.evaluate(
      () => document.querySelector('[role="treeitem"].bg-selected')?.textContent ?? null,
    );
    assert.equal(selectedAfter, selectedBefore, "菜单操作不得改变当前选中态");

    // 4) 行自身键盘选择保留：无会话无子任务的行 Enter 进草稿（D Code 默认任务；Home 默认任务有历史会话会进会话）
    const dcodeDefault = page.getByRole("treeitem", { name: "默认任务" }).nth(1);
    await dcodeDefault.focus();
    await page.keyboard.press("Enter");
    // 选择经桥异步落（先取最新快照再提交），等真实结果而不是即时读
    await page.waitForFunction(() => {
      const ui = JSON.parse(localStorage.getItem("dcode-prototype-ui-v1") ?? "{}");
      return ui.draftTaskId === "task-dcode-default";
    });
    const scene = await page.evaluate(() => JSON.parse(localStorage.getItem("dcode-prototype-ui-v1") ?? "{}"));
    assert.equal(scene.selectedSessionId, null);
    assert.equal(scene.draftTaskId, "task-dcode-default", "行自身 Enter 应选中 D Code 默认任务草稿");
  } finally {
    await close();
    cleanup(stateDir);
  }
});

test("输入卡片输入选项菜单：会话页向上展开完整可见、可选；草稿首屏保持向下", async () => {
  for (const [w, h] of [[1440, 900], [720, 480]]) {
    const { app, page, stateDir, close } = await launchApp();
    try {
      await ready(page);
      await assertValidationModel(page);
      await app.evaluate(({ BrowserWindow }, dims) => BrowserWindow.getAllWindows()[0].setSize(dims[0], dims[1]), [w, h]);

      // 会话页：发送一条进入会话（卡片贴底）
      const draftComposer = page.getByPlaceholder("交代需求、提问或粘贴内容…");
      await draftComposer.fill(`菜单方向验证 ${w}`);
      await draftComposer.press("Enter");
      await page.getByText("已接收", { exact: true }).first().waitFor();

      // 键盘真实打开输入选项菜单（贴底卡片内的触发钮，C03 次级入口）
      const trigger = page.getByRole("button", { name: "输入选项" });
      await trigger.focus();
      await page.keyboard.press("Space");
      await page.getByRole("menu").waitFor();
      const geo = await page.evaluate(() => {
        const menu = document.querySelector('[role="menu"]').getBoundingClientRect();
        const trig = document.querySelector('button[aria-label="输入选项"]').getBoundingClientRect();
        const scroller = document.querySelector("main .overflow-y-auto").getBoundingClientRect();
        return { menuTop: menu.top, menuBottom: menu.bottom, triggerTop: trig.top, winH: window.innerHeight, scrollerBottom: scroller.bottom };
      });
      assert.ok(geo.menuBottom <= geo.triggerTop + 1, `${w} 会话页贴底卡片菜单须向上展开（菜单底 ${geo.menuBottom} ≤ 触发钮顶 ${geo.triggerTop}）`);
      assert.ok(geo.menuTop >= 0 && geo.menuBottom <= geo.winH + 1, `${w} 菜单完整在窗口内`);
      assert.ok(geo.menuBottom <= geo.scrollerBottom + 1, `${w} 菜单不被滚动容器裁切`);
      // 逐项完整文字可读 + 逐项边界记录（不重叠、在菜单内）
      const itemsInfo = await page.evaluate(() => {
        const menu = document.querySelector('[role="menu"]').getBoundingClientRect();
        return {
          menu: { top: menu.top, bottom: menu.bottom, left: menu.left, right: menu.right },
          labels: [...document.querySelectorAll('[data-slot="dropdown-menu-label"]')].map((el) => el.textContent?.trim()).filter(Boolean),
          items: [...document.querySelectorAll('[role="menuitemradio"], [role="menuitem"]')].map((el) => {
            const r = el.getBoundingClientRect();
            return { text: el.textContent?.trim(), disabled: el.getAttribute("aria-disabled") === "true", top: r.top, bottom: r.bottom, left: r.left, right: r.right };
          }),
        };
      });
      // C03（2026-10-10 确认）：菜单只承载发送方式，运行控制只有同位主按钮一个位置。
      // 这里核的是「只有两项发送方式、没有第二个暂停／继续」，不是把旧的运行操作分组弱化掉。
      assert.deepEqual(
        itemsInfo.items.map((i) => i.text),
        ["引导：立即纳入当前工作", "稍后处理：留到本轮结束"],
        `${w} 菜单只承载两项互斥发送方式（C03/C04）`,
      );
      assert.ok(itemsInfo.labels.includes("发送方式"), "菜单须保留发送方式分组（C04）");
      assert.equal(itemsInfo.labels.includes("运行操作"), false, "菜单不得再有运行操作分组：暂停只有同位主按钮（C03）");
      for (const label of ["暂停", "继续", "继续执行"]) {
        assert.equal(
          itemsInfo.items.some((i) => i.text?.includes(label)),
          false,
          `菜单不得出现第二个运行控制入口「${label}」（C03）`,
        );
      }
      for (const it of itemsInfo.items) {
        assert.ok(it.top >= itemsInfo.menu.top - 1 && it.bottom <= itemsInfo.menu.bottom + 1, `${w} 菜单项「${it.text}」须在菜单边界内`);
        assert.ok(it.left >= itemsInfo.menu.left - 1 && it.right <= itemsInfo.menu.right + 1, `${w} 菜单项「${it.text}」不得横向裁切`);
      }
      // 菜单打开时截图（不是关闭后）
      const selectedDot = await page.getByRole("menuitemradio", { name: /引导：立即纳入/ }).evaluate((item) => {
        const dot = item.querySelector(".bg-foreground");
        const rect = dot?.getBoundingClientRect();
        const row = item.getBoundingClientRect();
        return { checked: item.getAttribute("aria-checked"), width: rect?.width ?? 0, height: rect?.height ?? 0,
          inside: rect && rect.left >= row.left && rect.right <= row.right && rect.top >= row.top && rect.bottom <= row.bottom,
          color: dot ? getComputedStyle(dot).backgroundColor : null };
      });
      assert.equal(selectedDot.checked, "true");
      assert.ok(selectedDot.width > 0 && selectedDot.height > 0 && selectedDot.inside && selectedDot.color !== "rgba(0, 0, 0, 0)", `当前发送方式须有实际可见选中标记：${JSON.stringify(selectedDot)}`);
      const AFTER = evidenceDir("keyboard-tree", "after");
      mkdirSync(AFTER, { recursive: true });
      await page.screenshot({ path: join(AFTER, `menu-up-${w}.png`) });

      // 键盘选择「稍后处理」→ 模式切换（共享原操作）；Radix 菜单用方向键导航，
      // 焦点移动是异步的（RovingFocus setTimeout 内执行），按真实焦点到位等待而不是即时读
      await page.keyboard.press("ArrowDown");
      await page.waitForFunction(() => {
        const el = document.activeElement;
        return el?.getAttribute("role") === "menuitemradio" && (el.textContent ?? "").includes("稍后处理");
      });
      await page.keyboard.press("Enter");
      await page.getByRole("menu").waitFor({ state: "hidden" });
      await page.getByText("稍后处理：留到本轮结束", { exact: false }).first().waitFor(); // 模式提示更新

      // 再开：鼠标真实点击「引导」→ 模式切回
      await trigger.click();
      await page.getByRole("menu").waitFor();
      await page.getByRole("menuitemradio", { name: /引导：立即纳入/ }).click();
      await page.getByRole("menu").waitFor({ state: "hidden" });
      await page.getByText("引导：立即纳入当前工作", { exact: false }).first().waitFor();

      // 再开后 Esc：焦点回触发钮
      await trigger.focus();
      await page.keyboard.press("Space");
      await page.getByRole("menu").waitFor();
      await page.keyboard.press("Escape");
      await page.getByRole("menu").waitFor({ state: "hidden" });
      await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "输入选项");
    } finally {
      await close();
      cleanup(stateDir);
    }
  }

  // 草稿首屏（hero 居中）：菜单保持共享默认向下展开
  const { page, stateDir, close } = await launchApp();
  try {
    await ready(page);
    await assertValidationModel(page);
    const trigger = page.getByRole("button", { name: "输入选项" });
    await trigger.focus();
    await page.keyboard.press("Space");
    await page.getByRole("menu").waitFor();
    const geo = await page.evaluate(() => {
      const menu = document.querySelector('[role="menu"]').getBoundingClientRect();
      const trig = document.querySelector('button[aria-label="输入选项"]').getBoundingClientRect();
      return { menuTop: menu.top, triggerBottom: trig.bottom };
    });
    assert.ok(geo.menuTop >= geo.triggerBottom - 1, "草稿首屏菜单须保持向下展开（菜单顶 ≥ 触发钮底）");
    await page.keyboard.press("Escape");
    await page.getByRole("menu").waitFor({ state: "hidden" });
  } finally {
    await close();
    cleanup(stateDir);
  }
});
