// 共享样式落实的定向检查：几何随字号联动的计算值、焦点目标可辨、选中与悬停可辨、720px 紧凑窗口实测。
// 视觉验收仍以矩阵截图供人工核对；本文件只断言计算值与结构事实，不代替视觉评审。

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { launchApp, cleanup, ready, assertValidationModel, waitForSnapshot, gotoSession } from "./helpers.mjs";
import { evidenceDir } from "./evidence-root.mjs";

const EVIDENCE = evidenceDir("style-geometry");
mkdirSync(EVIDENCE, { recursive: true });

const closeTo = (actual, expected, tolerance, label) => {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: 期望 ${expected}±${tolerance}，实际 ${actual}`,
  );
};

test("几何随字号联动：按钮/图标/内边距/圆角/侧栏/阅读列在 14→13 档按 s=13/14 派生", async () => {
  const { page, stateDir, close } = await launchApp();
  try {
    await ready(page);
    await page.getByRole("heading", { name: "开始一项新工作" }).waitFor();

    const measure = () =>
      page.evaluate(() => {
        const nav = document.querySelector("nav");
        const sendBtn = document.querySelector('button[aria-label="发送"]');
        const composerShell = sendBtn?.closest(".input-surface");
        const icon = sendBtn?.querySelector("svg");
        const body = document.body;
        const reading = document.querySelector("main .max-w-172");
        return {
          bodyFont: parseFloat(getComputedStyle(body).fontSize),
          sidebarW: nav?.getBoundingClientRect().width ?? 0,
          sendBtnH: sendBtn?.getBoundingClientRect().height ?? 0,
          iconBox: icon?.getBoundingClientRect().width ?? 0,
          composerPad: composerShell ? parseFloat(getComputedStyle(composerShell).paddingTop) : 0,
          composerRadius: composerShell ? parseFloat(getComputedStyle(composerShell).borderTopLeftRadius) : 0,
          readingMax: reading ? parseFloat(getComputedStyle(reading).maxWidth) : 0,
        };
      });

    const at14 = await measure();
    closeTo(at14.bodyFont, 14, 0.1, "14 档正文字号");
    closeTo(at14.sidebarW, 264, 0.5, "14 档侧栏宽");
    closeTo(at14.sendBtnH, 32, 0.5, "14 档发送钮高（size-8）");
    closeTo(at14.iconBox, 16, 0.5, "14 档图标（size-4）");
    closeTo(at14.composerPad, 12, 0.5, "14 档输入壳内边距（p-3）");
    closeTo(at14.composerRadius, 16, 0.5, "14 档输入壳圆角（2xl）");
    closeTo(at14.readingMax, 688, 0.5, "14 档阅读列上限");

    // 经真实设置通道降到 13px
    await page.getByRole("button", { name: /^设置/ }).click();
    await page.getByRole("button", { name: "减小" }).click();
    await page.waitForFunction(() => getComputedStyle(document.body).fontSize === "13px");
    await page.keyboard.press("Escape");
    await page.getByRole("heading", { name: "开始一项新工作" }).waitFor();

    const s = 13 / 14;
    const at13 = await measure();
    closeTo(at13.bodyFont, 13, 0.1, "13 档正文字号");
    closeTo(at13.sidebarW, 264 * s, 0.6, "13 档侧栏宽");
    closeTo(at13.sendBtnH, 32 * s, 0.6, "13 档发送钮高");
    closeTo(at13.iconBox, 16 * s, 0.6, "13 档图标");
    closeTo(at13.composerPad, 12 * s, 0.6, "13 档输入壳内边距");
    closeTo(at13.composerRadius, 16 * s, 0.6, "13 档输入壳圆角");
    closeTo(at13.readingMax, 688 * s, 0.6, "13 档阅读列上限");
    writeFileSync(join(EVIDENCE, "geometry-14-13.json"), JSON.stringify({ at14, at13 }, null, 2));
  } finally {
    await close();
    cleanup(stateDir);
  }
});

test("焦点目标可辨：Tab 持焦目标自身有清晰内描边（壳内 Stepper 按钮同样可辨）", async () => {
  const { page, stateDir, close } = await launchApp();
  try {
    await ready(page);
    await page.getByRole("heading", { name: "开始一项新工作" }).waitFor();

    // 键盘 Tab 走到一个树行（壳外控件）：焦点内描边非 none 且为 border-strong 色
    let focused = null;
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press("Tab");
      focused = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const role = el.getAttribute("role") ?? el.tagName.toLowerCase();
        return { role, tag: el.tagName, text: (el.textContent ?? "").slice(0, 20), shadow: getComputedStyle(el).boxShadow };
      });
      if (focused && focused.role === "treeitem") break;
    }
    assert.ok(focused && focused.role === "treeitem", "Tab 应能到达树行");
    assert.notEqual(focused.shadow, "none", "壳外持焦目标须有可见内描边");
    assert.match(focused.shadow, /rgba?\(28, 25, 23\)/, "焦点描边应为完整前景色（focus-ring）");

    // 壳内目标：设置页字号步进器——先 Tab 到壳（role=spinbutton），再进壳内按钮
    await page.getByRole("button", { name: /^设置/ }).click();
    let shell = null;
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press("Tab");
      shell = await page.evaluate(() => {
        const el = document.activeElement;
        return el?.getAttribute("role") === "spinbutton"
          ? { shadow: getComputedStyle(el).boxShadow, focusVisible: el.matches(":focus-visible") }
          : null;
      });
      if (shell) break;
    }
    assert.ok(shell, "Tab 应能到达步进器壳");
    assert.ok(shell.focusVisible, "步进器壳自持焦须命中 :focus-visible");
    assert.match(shell.shadow, /rgba?\(28, 25, 23\) 0px 0px 0px 2px inset/, "壳自持焦须为完整前景 2px 描边（不是容器 1px 弱框）");
    await page.keyboard.press("Tab");
    const inner = await page.evaluate(() => {
      const el = document.activeElement;
      return el ? { label: el.getAttribute("aria-label"), shadow: getComputedStyle(el).boxShadow } : null;
    });
    assert.ok(inner && (inner.label === "减小" || inner.label === "增加"), "壳内应能 Tab 到步进按钮");
    assert.match(inner.shadow, /0px 0px 0px 2px inset/, "壳内持焦子按钮自身须有 2px 描边（不只壳整体亮）");

    // 假标签表单退出后，沿真实任务命名输入验证自持焦与完整前景 2px 描边。
    await page.keyboard.press("Escape");
    const workspace = page.getByRole("treeitem", { name: "D Code" });
    await workspace.hover();
    await workspace.getByRole("button", { name: "在此空间新建任务" }).click();
    await page.getByRole('menuitem', { name: '新建长期任务' }).click();
    const labelInput = page.getByPlaceholder("任务名称");
    await labelInput.focus();
    const inputFocus = await page.evaluate(() => {
      const el = document.activeElement;
      return el ? { fv: el.matches(":focus-visible"), shadow: getComputedStyle(el).boxShadow } : null;
    });
    assert.ok(inputFocus?.fv, "文本输入框自持焦须命中 :focus-visible");
    assert.match(inputFocus?.shadow ?? "", /rgba?\(28, 25, 23\) 0px 0px 0px 2px inset/, "文本输入框自持焦须为完整前景 2px 描边");

    // 填色主按钮：发送钮填充后为深色底，焦点描边应为反色（border-strong 在深底上不可辨）
    // 模型能力来自专用测试装配，发送钮仍验实际焦点与反色描边。
    await page.keyboard.press("Escape"); // 取消命名对话框，回原草稿
    await page.getByRole("heading", { name: "开始一项新工作" }).waitFor();
    await assertValidationModel(page);
    const composer = page.getByPlaceholder("交代需求、提问或粘贴内容…");
    await composer.click();
    await composer.fill("焦点验证");
    // 操作行顺序（C05 起）：引用入口 → 唯一同位主按钮 → 输入选项菜单。
    // Tab 逐个走过，每个都要有可辨焦点；这里不跳步，直接断言顺序本身。
    await page.keyboard.press("Tab"); // textarea → 引用入口
    const referenceFocus = await page.evaluate(() => {
      const el = document.activeElement;
      return el ? { label: el.getAttribute("aria-label"), slot: el.getAttribute("data-slot"), shadow: getComputedStyle(el).boxShadow } : null;
    });
    assert.equal(referenceFocus?.slot, "composer-references-trigger", "Tab 第一站应是引用入口");
    assert.equal(referenceFocus?.label, "添加文件与技能引用");
    assert.match(referenceFocus?.shadow ?? "", /2px inset/, "引用入口同样要有键盘焦点描边");
    await page.keyboard.press("Tab"); // 引用入口 → 发送钮
    const sendFocus = await page.evaluate(() => {
      const el = document.activeElement;
      return el ? { label: el.getAttribute("aria-label"), shadow: getComputedStyle(el).boxShadow } : null;
    });
    assert.equal(sendFocus?.label, "发送", "Tab 第二站应是唯一同位主按钮");
    assert.match(sendFocus?.shadow ?? "", /rgba?\(250, 250, 249/, "填色发送钮的焦点描边应为反色（primary-foreground）");

    // 深色主题：树行焦点描边应为深色档 border-strong
    await page.evaluate(() => window.dcode.updateSettings({ theme: "dark" }));
    await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
    let darkFocused = null;
    for (let i = 0; i < 60; i++) {
      await page.keyboard.press("Tab");
      darkFocused = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        return { role: el.getAttribute("role"), shadow: getComputedStyle(el).boxShadow };
      });
      if (darkFocused && darkFocused.role === "treeitem") break;
    }
    assert.ok(darkFocused, "深色下 Tab 应能到达树行");
    assert.match(darkFocused?.shadow ?? "", /rgba?\(236, 236, 238\)/, "深色焦点描边应为深色档完整前景色");
  } finally {
    await close();
    cleanup(stateDir);
  }
});

test("选中与悬停可辨（真实行交互）：点击迁移选中，悬停色与选中色不同", async () => {
  const { page, stateDir, close } = await launchApp();
  try {
    await ready(page);
    await page.getByRole("heading", { name: "开始一项新工作" }).waitFor();

    // 当前选中：Home 默认任务草稿（启动落点），计算底色应为 selected 浅 0.09
    const homeDefault = page.getByRole("treeitem", { name: "默认任务" }).first();
    const selBg = await homeDefault.evaluate((el) => getComputedStyle(el).backgroundColor);
    assert.equal(selBg, "rgba(23, 23, 23, 0.09)", "选中行应为 selected 浅色 0.09α");

    // 真实悬停另一行：hover 色 0.05α，与选中可辨
    const other = page.getByRole("treeitem", { name: "整理读书笔记" });
    await other.hover();
    const hovBg = await other.evaluate((el) => getComputedStyle(el).backgroundColor);
    assert.equal(hovBg, "rgba(23, 23, 23, 0.05)", "悬停行应为 hover 浅色 0.05α");
    assert.notEqual(selBg, hovBg, "选中与悬停必须可辨");

    // N03主会话由任务行呈现选中；真实目标ID和原selected颜色分别核实。
    await gotoSession(page, 'session-readme-1');
    const sessionRow = page.locator('[data-task-id="task-readme"]');
    await page.waitForFunction(() => document.querySelector('[data-task-id="task-readme"]')?.classList.contains('bg-selected'), null, { timeout: 15_000 });
    const selBg2 = await sessionRow.evaluate((el) => getComputedStyle(el).backgroundColor);
    assert.equal(selBg2, "rgba(23, 23, 23, 0.09)", "点击后主会话所属任务行呈现原选中态");

    // 深色主题：selected 深 0.12α
    await page.evaluate(() => window.dcode.updateSettings({ theme: "dark" }));
    await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
    const selBgDark = await sessionRow.evaluate((el) => getComputedStyle(el).backgroundColor);
    assert.equal(selBgDark, "rgba(245, 245, 244, 0.12)", "深色选中应为 0.12α");
  } finally {
    await close();
    cleanup(stateDir);
  }
});

test("720px 最小窗口：三档字号各自完成阅读、编辑发送、diff 横滚、文件入口与关闭返回", async () => {
  const { app, page, stateDir, close } = await launchApp();
  try {
    await ready(page);
    await assertValidationModel(page); // 会话输入区在配置模型后才可用
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(720, 480));
    // 时间线就绪锚点：聚合卡按钮出现（历史会话无「已完成」相，不拿旧文案当锚点）
    await page.getByRole("button", { name: /字号步进器与默认值/ }).click();
    await page.getByRole("button", { name: /本轮改动/ }).waitFor();
    await page.getByRole("button", { name: /本轮改动/ }).click();
    await page.getByText(/文件改动（3）/).waitFor();

    // 进入时记录演示会话 ID：本档正式接收必须落在它上面，不许用别的会话或旧消息顶替
    const demoSessionId = await page.evaluate(() => {
      return window.dcode.getSnapshot().then((s) => {
        for (const [sid, blocks] of Object.entries(s.timelines)) {
          if (blocks.some((b) => (b.text ?? "").includes("完成。改动三个文件"))) return sid;
        }
        return null;
      });
    });
    assert.ok(demoSessionId, "演示会话 ID 可定位");

    // 分配公式（主树 DESIGN）：S=min(g264,max(g188,0.30W))；I=min(g440,W−S−g232)；M=W−S−I
    const expected = (f) => {
      const s = f / 14;
      const W = 720;
      const S = Math.min(264 * s, Math.max(188 * s, 0.3 * W));
      const I = Math.min(440 * s, W - S - 232 * s);
      const M = W - S - I;
      return { S, I, M };
    };
    const measure = () =>
      page.evaluate(() => ({
        sidebar: document.querySelector("nav").getBoundingClientRect().width,
        inspector: document.querySelector("aside").getBoundingClientRect().width,
        main: document.querySelector("main").getBoundingClientRect().width,
        overlap: (() => {
          const n = document.querySelector("nav").getBoundingClientRect();
          const m = document.querySelector("main").getBoundingClientRect();
          const a = document.querySelector("aside").getBoundingClientRect();
          return n.right > m.left + 1 || m.right > a.left + 1 || a.right > window.innerWidth + 1;
        })(),
      }));

    const layouts = {};
    const acceptAt = async (f) => {
      await page.evaluate((size) => window.dcode.updateSettings({ fontSize: size }), f);
      await page.waitForFunction((size) => getComputedStyle(document.body).fontSize === `${size}px`, f);
      const actual = await measure();
      const want = expected(f);
      layouts[f] = { actual, want };
      assert.ok(!actual.overlap, `${f}px 下三区不得重叠/出窗`);
      closeTo(actual.sidebar, want.S, 1.5, `${f}px 侧栏宽`);
      closeTo(actual.inspector, want.I, 1.5, `${f}px 检查器宽`);
      closeTo(actual.main, want.M, 1.5, `${f}px 主区宽`);

      // 真实阅读消息
      await page.getByText("完成。改动三个文件", { exact: false }).first().waitFor();

      // 长行 diff 横滚：经真实文件入口选 SettingsPage.tsx（hint 中英混排长行，各档实测均溢出），
      // 以 DiffView 内容（完整路径头 + 特有行）确认活动文件后，在「内容区内的 DiffView 滚动容器」上测——
      // aside 下首个 overflow-x-auto 是页签条，不是 diff 内容（此前工装曾取错目标）
      await page.locator("aside").getByRole("button", { name: "SettingsPage.tsx", exact: true }).click();
      await page.waitForFunction(() => {
        const view = document.querySelector("aside .overflow-y-auto");
        return (
          !!view &&
          view.textContent.includes("src/renderer/views/SettingsPage.tsx") &&
          view.textContent.includes("SettingsRow")
        );
      });
      const diffScroll = await page.evaluate(() => {
        const view = document.querySelector("aside .overflow-y-auto");
        const el = view?.querySelector(".overflow-x-auto");
        if (!el) return null;
        el.scrollLeft = 0;
        const before = el.scrollLeft;
        const max = el.scrollWidth - el.clientWidth;
        el.scrollLeft = 400;
        const after = el.scrollLeft;
        el.scrollLeft = max; // 长行另一端直达
        const atEnd = max > 0 ? el.scrollLeft >= max - 1 : true;
        return {
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          before,
          after,
          max,
          atEnd,
          path: view.querySelector(".truncate")?.textContent ?? null,
        };
      });
      assert.ok(diffScroll, `${f}px DiffView 内容滚动容器须在`);
      assert.ok(diffScroll.path?.includes("SettingsPage.tsx"), `${f}px 活动文件须确认为 SettingsPage.tsx（实际 ${diffScroll.path}）`);
      assert.equal(diffScroll.before, 0, `${f}px 横向起点须归零`);
      assert.ok(
        diffScroll.scrollWidth > diffScroll.clientWidth,
        `${f}px SettingsPage.tsx 长行须真实溢出（sw=${diffScroll.scrollWidth}/cw=${diffScroll.clientWidth}）`,
      );
      assert.ok(diffScroll.after > 0, `${f}px 溢出时长行须能真实横向滚动（scrollLeft=${diffScroll.after}）`);
      assert.ok(diffScroll.atEnd, `${f}px 长行另一端须可达（max=${diffScroll.max}）`);
      layouts[f].diffScroll = diffScroll;

      // 文件入口可切换：切到 styles.css 并以其内容确认，再切回
      await page.locator("aside").getByRole("button", { name: "styles.css", exact: true }).click();
      await page.waitForFunction(() => {
        const view = document.querySelector("aside .overflow-y-auto");
        return !!view && view.textContent.includes("src/renderer/styles.css") && view.textContent.includes("--ui-font-size");
      });
      await page.locator("aside").getByRole("button", { name: "SettingsPage.tsx", exact: true }).click();
      await page.waitForFunction(() => {
        const view = document.querySelector("aside .overflow-y-auto");
        return !!view && view.textContent.includes("src/renderer/views/SettingsPage.tsx");
      });

      // 编辑并发送该档唯一文本：先填写，再等发送钮可用（上轮运行未结束时不可发），正式回执落在演示会话
      const text = `紧凑窗口受控需求-${f}px档`;
      const composer = page.getByPlaceholder("追问、补充或纠正…");
      await composer.fill(text);
      await page.waitForFunction(() => {
        const btn = document.querySelector('button[aria-label="发送"]');
        return btn && !btn.disabled;
      });
      await composer.press("Enter");
      await waitForSnapshot(page,
        (s, { sid, t }) =>
            (s.timelines[sid] ?? []).some(
              (b) => b.kind === "message" && b.role === "user" && b.text === t && b.receipt?.status === "accepted",
            ),
        { sid: demoSessionId, t: text },
      );
      // 当前选择仍在演示会话（紧凑操作未把用户带走）
      const scene = await page.evaluate(() => JSON.parse(localStorage.getItem("dcode-prototype-ui-v1") ?? "{}"));
      assert.equal(scene.selectedSessionId, demoSessionId, `${f}px 发送后仍应停在演示会话`);

      // 每档收尾：留未发草稿后关/开检查器——主区恢复、重开后原对象与草稿保持
      const draftText = `紧凑窗口未发送草稿-${f}px档`;
      await composer.fill(draftText);
      await page.getByRole("button", { name: "关闭检查器" }).click();
      await page.waitForFunction(() => !document.querySelector("aside"));
      const mainAfterClose = await page.evaluate(() => document.querySelector("main")?.getBoundingClientRect().width ?? 0);
      closeTo(mainAfterClose, 720 - expected(f).S, 1.5, `${f}px 关闭检查器后主区恢复`);
      await page.getByRole("button", { name: /本轮改动/ }).first().click();
      await page.getByText(/文件改动（3）/).waitFor();
      const composerAfter = page.getByPlaceholder("追问、补充或纠正…");
      assert.equal(await composerAfter.inputValue(), draftText, `${f}px 关/开检查器后未发草稿须保持`);
      const kept = await page.evaluate((sid) => {
        return window.dcode.getSnapshot().then((s) => ({
          demo: s.sessions.some((x) => x.id === sid),
          content: (s.timelines[sid] ?? []).some((b) => (b.text ?? "").includes("完成。改动三个文件")),
        }));
      }, demoSessionId);
      assert.ok(kept.demo && kept.content, `${f}px 关/开后原会话与内容不得丢失`);
    };

    for (const f of [14, 13, 16]) await acceptAt(f);
    writeFileSync(join(EVIDENCE, "narrow-720.json"), JSON.stringify(layouts, null, 2));
  } finally {
    await close();
    cleanup(stateDir);
  }
});
