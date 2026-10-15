// 视觉矩阵工装：沿用公开 helper 的显式隔离 mock 装配，按 语言 × 主题 × 字号 × 窗口尺寸 截图，供人工核验。
// 不是行为测试；截图产物在 test/e2e/screenshots/（运行产物，不进交付 source）。
// 每组合记录实际读回：公开 model/execution、settings 快照、真实 DOM 语言/主题/字号/视口、
// 三场景真实到达（不用双语 regex 同时通过两个语言）、同一隐藏窗口身份与真实退出清理。
// 用法：
//   node test/e2e/visual-matrix.mjs            # 默认 12 组合（同一隐藏窗口串行）
//   node test/e2e/visual-matrix.mjs zh-light-14,en-dark-13  # 逗号分隔 name 前缀定向

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchApp, cleanup, ready } from "./helpers.mjs";
import { evidenceDir, overrideEvidencePath } from "./evidence-root.mjs";

// 输出目录可用环境变量改写：同一份工装既跑本轮改造，也跑改前基线快照，
// 两边的截图与观测必须写进各自的记录目录，不能互相覆盖。
// 覆盖路径同样要过 evidence-root 的历史目录校验：这两个变量保留给按用例重定向，
// 但不能成为绕过「doc/验证记录 只读」的入口。
const OUT = overrideEvidencePath(process.env.DCODE_VISUAL_SHOTS_DIR) ?? evidenceDir("visual-matrix", "screenshots");
mkdirSync(OUT, { recursive: true });
const META = overrideEvidencePath(process.env.DCODE_VISUAL_META_DIR) ?? evidenceDir("visual-matrix");
mkdirSync(META, { recursive: true });

const combos = [
  { name: "zh-light-14-1440", lang: "zh", dark: false, fontSize: "14", width: 1440, height: 900 },
  { name: "zh-dark-14-1440", lang: "zh", dark: true, fontSize: "14", width: 1440, height: 900 },
  { name: "zh-light-13-1440", lang: "zh", dark: false, fontSize: "13", width: 1440, height: 900 },
  { name: "zh-dark-13-1440", lang: "zh", dark: true, fontSize: "13", width: 1440, height: 900 },
  { name: "en-light-14-1440", lang: "en", dark: false, fontSize: "14", width: 1440, height: 900 },
  { name: "en-dark-14-1440", lang: "en", dark: true, fontSize: "14", width: 1440, height: 900 },
  { name: "en-light-13-1440", lang: "en", dark: false, fontSize: "13", width: 1440, height: 900 },
  { name: "en-dark-13-1440", lang: "en", dark: true, fontSize: "13", width: 1440, height: 900 },
  { name: "zh-light-13-720", lang: "zh", dark: false, fontSize: "13", width: 720, height: 480 },
  { name: "en-dark-14-720", lang: "en", dark: true, fontSize: "14", width: 720, height: 480 },
  { name: "zh-dark-13-1100", lang: "zh", dark: true, fontSize: "13", width: 1100, height: 700 },
  { name: "en-dark-13-860", lang: "en", dark: true, fontSize: "13", width: 860, height: 600 },
];

// 语言相关的关键文案：用实际值而不是双语 regex——regex 会让错误语言也通过
const TEXT = {
  zh: {
    draftHeading: "开始一项新工作",
    sampleTask: "字号步进器与默认值",
    changesCta: /本轮改动/,
    inspectorTitle: "文件改动（3）",
    closeInspector: "关闭检查器",
    defaultTask: "默认任务",
  },
  en: {
    draftHeading: "Start new work",
    sampleTask: "字号步进器与默认值", // 用户内容不随界面语言翻译
    changesCta: /files changed|本轮改动/, // 键名按产品实际文案核对（英文界面读得是同一产品值）
    inspectorTitle: "File changes (3)",
    closeInspector: "Close inspector",
    defaultTask: "Default task",
  },
};

const requested = (process.argv[2] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const selected = requested.length
  ? combos.filter((c) => requested.some((p) => c.name.startsWith(p)))
  : combos;
if (requested.length && selected.length === 0) {
  throw new Error(`定向未匹配任何组合：${requested.join(",")}；可选：${combos.map((c) => c.name).join(",")}`);
}

const { app, page, stateDir, close } = await launchApp();
const evidence = { combos: [], host: null, exit: null };
try {
  await ready(page);
  // 宿主身份：每个组合都要证明仍是这一扇隐藏、不可聚焦窗口（无新旧窗口混淆）
  const host = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => ({
    id: w.id, visible: w.isVisible(), focusable: w.isFocusable(), focused: w.isFocused(),
  })));
  if (host.length !== 1 || host[0].visible || host[0].focusable || host[0].focused) {
    throw new Error(`预期唯一隐藏不可聚焦窗口，实际 ${JSON.stringify(host)}`);
  }
  evidence.host = host;

  for (const combo of selected) {
    const txt = TEXT[combo.lang];
    const entry = { name: combo.name, readback: {}, steps: [] };
    await app.evaluate(({ BrowserWindow }, c) => {
      BrowserWindow.getAllWindows()[0].setSize(c.width, c.height);
    }, combo);
    // 真实设置通道
    await page.evaluate(async (c) => {
      await window.dcode.updateSettings({
        language: c.lang,
        theme: c.dark ? "dark" : "light",
        fontSize: Number(c.fontSize),
      });
    }, combo);
    // 实际读回：settings 快照 + 真实 DOM 语言属性 + 主题语义 + 字号 + 视口（真实就绪条件，非固定 250ms）
    await page.waitForFunction((c) => {
      return getComputedStyle(document.body).fontSize === `${c.fontSize}px`
        && window.innerWidth === c.width && window.innerHeight === c.height
        && document.documentElement.lang === (c.lang === "zh" ? "zh-CN" : "en");
    }, combo, { timeout: 10_000 });
    // 等一帧真实绘制后截图
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const snapshot = await page.evaluate(() => window.dcode.getSnapshot());
    const domState = await page.evaluate(() => ({
      lang: document.documentElement.lang,
      bodyFontSize: getComputedStyle(document.body).fontSize,
      darkClass: document.documentElement.classList.contains("dark"),
      viewport: { w: window.innerWidth, h: window.innerHeight },
    }));
    entry.readback = {
      model: snapshot.model,
      execution: snapshot.execution,
      settings: snapshot.settings,
      dom: domState,
    };
    // 语言/主题/字号/视口必须是实际请求值
    if (snapshot.settings.language !== combo.lang) throw new Error(`${combo.name}: 语言读回不符（settings=${snapshot.settings.language}）`);
    if (snapshot.settings.theme !== (combo.dark ? "dark" : "light")) throw new Error(`${combo.name}: 主题读回不符（settings=${snapshot.settings.theme}）`);
    if (String(snapshot.settings.fontSize) !== combo.fontSize) throw new Error(`${combo.name}: 字号读回不符（settings=${snapshot.settings.fontSize}）`);
    if (domState.lang !== (combo.lang === "zh" ? "zh-CN" : "en")) throw new Error(`${combo.name}: DOM lang 不符（${domState.lang}）`);
    if (domState.bodyFontSize !== `${combo.fontSize}px`) throw new Error(`${combo.name}: DOM 字号不符（${domState.bodyFontSize}）`);
    if (domState.darkClass !== combo.dark) throw new Error(`${combo.name}: DOM dark 类不符（${domState.darkClass} ≠ ${combo.dark}）`);
    if (domState.viewport.w !== combo.width || domState.viewport.h !== combo.height) throw new Error(`${combo.name}: 视口不符（${domState.viewport.w}×${domState.viewport.h}）`);
    if (!snapshot.model.available) throw new Error(`${combo.name}: 验证装配 model 须可用`);
    if (snapshot.execution.kind !== "mock") throw new Error(`${combo.name}: 验证装配须为显式 mock（实际 ${snapshot.execution.kind}）`);

    // 场景一：草稿态真实到达（该语言的标题——不能用双语 regex）
    await page.getByRole("heading", { name: txt.draftHeading, exact: true }).waitFor();
    const s1 = join(OUT, `${combo.name}-草稿态.png`);
    await page.screenshot({ path: s1 });
    entry.steps.push({ shot: "草稿态", path: s1, reached: true });

    // 场景二：时间线 + 检查器真实到达（该语言的检查器标题）
    await page.getByRole("button", { name: txt.sampleTask }).click();
    await page.getByRole("button", { name: txt.changesCta }).waitFor();
    await page.getByRole("button", { name: txt.changesCta }).click();
    await page.getByText(txt.inspectorTitle, { exact: true }).waitFor();
    const s2 = join(OUT, `${combo.name}-时间线与检查器.png`);
    await page.screenshot({ path: s2 });
    entry.steps.push({ shot: "时间线与检查器", path: s2, reached: true });
    await page.getByRole("button", { name: txt.closeInspector }).click();
    await page.getByText(txt.inspectorTitle, { exact: true }).waitFor({ state: "hidden" });

    // 场景三：键盘持焦（该语言的树行与标题）
    await page.getByRole("treeitem", { name: txt.defaultTask }).nth(1).click();
    await page.getByRole("heading", { name: txt.draftHeading, exact: true }).waitFor();
    let focusHit = false;
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press("Tab");
      focusHit = await page.evaluate(() => document.activeElement?.getAttribute("role") === "treeitem");
      if (focusHit) break;
    }
    if (!focusHit) throw new Error(`键盘持焦场景未能在 40 次 Tab 内到达树行（${combo.name}），不允许空存`);
    const s3 = join(OUT, `${combo.name}-焦点.png`);
    await page.screenshot({ path: s3 });
    entry.steps.push({ shot: "焦点", path: s3, reached: true });

    evidence.combos.push(entry);
  }
  writeFileSync(join(META, "visual-matrix-observations.json"), JSON.stringify(evidence, null, 1));
  console.log(`screenshots: ${selected.map((c) => c.name).join(",")}`);
} finally {
  await close(); // 真实 exit 收束（helpers.close 等真实退出信号）
  cleanup(stateDir);
  evidence.exit = { closed: true, stateDirCleaned: true };
  writeFileSync(join(META, "visual-matrix-observations.json"), JSON.stringify(evidence, null, 1));
}
