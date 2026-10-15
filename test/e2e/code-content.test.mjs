// 正文代码块：真实窗口里的完整原文、可见性、高亮与复制。
//
// 取证目标不是「元素存在」，而是用户真的读到、看到并复制到了原文：
// - 每一行与围栏原文逐字一致（缩进、空行、尾部空白、中文注释不丢）；
// - 代码块在窗口里真的占位并可见（不是渲染成 0 高度的空壳）；
// - 语法高亮确实补齐（不是一直停在未高亮的原始文本）；
// - 复制写入的是未改写的原文，失败时如实反馈「复制失败」。
//
// 另外覆盖缓存键碰撞：两轮各发一段「语言相同、长度相同、首尾 100 字相同、只有中间不同」
// 的代码，第二段不能复用第一段的高亮结果（见 test/runtime/code-block-highlight-cache.test.ts）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { launchApp, assertValidationModel, cleanup, ready } from "./helpers.mjs";
import { evidenceDir } from "./evidence-root.mjs";

/** 渲染进程控制台：失败时给出真实原因，不只报「等不到」 */
const rendererLogs = [];

const assistantBlocks = (page) =>
  page.locator('[data-slot="message"][data-from="assistant"] [data-slot="code-block"]');

/** 代码块里的行块文本：display:block 承担换行，空行渲染为一个换行符 */
async function blockLines(block) {
  return block.locator("pre code > span").evaluateAll((nodes) =>
    nodes.map((node) => {
      const text = node.textContent ?? "";
      return text === "\n" ? "" : text;
    }),
  );
}

/** 等语法高亮补齐：shiki 双主题 token 带 --shiki-dark 内联变量；未高亮的原始 token 没有内联样式 */
async function waitHighlighted(page, block) {
  try {
    await block
      .locator('pre code span[style*="--shiki-dark"]')
      .first()
      // shiki 的 JavaScript 正则引擎首次编译 TypeScript 语法较慢，等待上限给到 40 秒；
    // 上限只约束等待，不掩盖失败——超时仍按未高亮如实报错。
    .waitFor({ state: "attached", timeout: 40_000 });
  } catch (error) {
    const inventory = await page.evaluate(() =>
      [...document.querySelectorAll("[data-slot=code-block]")].map((node) => ({
        lang: node.getAttribute("data-language"),
        inAssistant: !!node.closest('[data-slot="message"][data-from="assistant"]'),
        styled: node.querySelectorAll("pre code span[style]").length,
        spans: node.querySelectorAll("pre code span").length,
        first: node.querySelector("pre code > span")?.textContent?.slice(0, 40) ?? "",
      })),
    );
    throw new Error(`代码块没有出现高亮 token。页面控制台：${rendererLogs.join(" | ").slice(0, 500)}\n代码块清单：${JSON.stringify(inventory)}`, {
      cause: error,
    });
  }
}

/** 用例内装的剪贴板替身：只记录写入内容，不假装读回系统剪贴板 */
async function stubClipboard(page, mode) {
  await page.evaluate((behaviour) => {
    globalThis.__copied = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text) => {
          if (behaviour === "reject") throw new Error("clipboard unavailable");
          globalThis.__copied.push(text);
        },
      },
    });
  }, mode);
}

const copiedText = (page) => page.evaluate(() => globalThis.__copied ?? []);

async function send(page, text) {
  // 草稿态与会话内的占位文案不同（见 i18n draft.composerPlaceholderNoModel / timeline.followupPlaceholder），
  // 按当前真实占位取值，不用写死的单一文案。
  const composer = page
    .getByPlaceholder("交代需求、提问或粘贴内容…")
    .or(page.getByPlaceholder("追问、补充或纠正…"))
    .or(page.getByPlaceholder("写下需求，保存为草稿…"))
    .first();
  await composer.fill(text);
  await composer.press("Enter");
}

const CODE = [
  "export function 解析(输入: string) {",
  "  // 中文注释：全角空格　在这里",
  "  if (!输入) {",
  "    return null",
  "  }",
  "",
  "  return 输入.trim()   ",
  "}",
].join("\n");

test("正文代码块：逐行原文、可见、高亮与复制", async () => {
  const { page, stateDir, close } = await launchApp();
  const shots = evidenceDir("code-content");
  try {
    await ready(page);
    page.on("console", (msg) => rendererLogs.push(`${msg.type()}: ${msg.text()}`));
    page.on("pageerror", (error) => rendererLogs.push(`pageerror: ${String(error)}`));
    await page.getByRole("heading", { name: "开始一项新工作" }).waitFor();
    await assertValidationModel(page);
    await stubClipboard(page, "record");

    await send(page, ["看一下这个文件：", "", "```ts", CODE, "```"].join("\n"));

    const blocks = assistantBlocks(page);
    await blocks.first().waitFor({ timeout: 30_000 });
    await waitHighlighted(page, blocks.first());

    const block = blocks.first();
    assert.deepEqual(await blockLines(block), CODE.split("\n"), "代码块每一行都应与原文逐字一致");

    // 真实可见：代码块有实际高度，且首行文字落在视口内
    const box = await block.boundingBox();
    assert.ok(box && box.height > 20, `代码块应实际占位，实际 ${JSON.stringify(box)}`);
    const firstLineVisible = await block.locator("pre code > span").first().isVisible();
    assert.equal(firstLineVisible, true, "代码首行应可见");
    await page.screenshot({ path: join(shots, "code-block-first-line.png") });

    // 语言标注取自围栏本身
    assert.equal(await block.getAttribute("data-language"), "ts");

    // 复制：写入未改写的原文，缩进、空行与尾部空白都在
    await block.getByRole("button", { name: "复制代码" }).click();
    assert.deepEqual(await copiedText(page), [CODE], "复制内容应与原文逐字一致");
    await block.getByRole("button", { name: "已复制代码" }).waitFor({ timeout: 5000 });

    // 窄窗口下代码块仍可横向阅读，不被裁掉
    await page.setViewportSize({ width: 720, height: 720 });
    await page.waitForTimeout(300);
    const narrow = await block.boundingBox();
    assert.ok(narrow && narrow.height > 20, `窄窗口下代码块仍应可读，实际 ${JSON.stringify(narrow)}`);
    await page.screenshot({ path: join(shots, "code-block-720.png") });
  } finally {
    await close();
    cleanup(stateDir);
  }
});

test("手动深色确实切到另一套 token 配色，且关键字、标识符与注释都可读", async () => {
  const { page, stateDir, close } = await launchApp();
  const shots = evidenceDir("code-content");
  try {
    await ready(page);
    await page.getByRole("heading", { name: "开始一项新工作" }).waitFor();
    await assertValidationModel(page);

    await send(page, ["```ts", "const keyword = 1; // trailing comment", "```"].join("\n"));
    const block = assistantBlocks(page).first();
    await block.waitFor({ timeout: 30_000 });
    await waitHighlighted(page, block);
    await block.scrollIntoViewIfNeeded();

    /**
     * 三个代表性 token 的实际计算色 + 代码块实际背景。
     * identifier（`keyword`）在浅色主题里是最暗的一档，深色下若没换配色就会变得不可读，
     * 所以必须单独纳入对比度检查。
     */
    const measure = () =>
      page.evaluate(() => {
        const pre = document.querySelector('[data-slot="code-block"] pre');
        const spans = [...(pre?.querySelectorAll("code span span") ?? [])];
        const colorOf = (predicate) => {
          const node = spans.find(predicate);
          return node ? getComputedStyle(node).color : null;
        };
        const container = document.querySelector('[data-slot="code-block"]');
        return {
          keyword: colorOf((node) => node.textContent === "const"),
          identifier: colorOf((node) => node.textContent === "keyword"),
          comment: colorOf((node) => node.textContent?.startsWith("//")),
          background: container ? getComputedStyle(container).backgroundColor : null,
          dark: document.documentElement.classList.contains("dark"),
        };
      });

    const luminance = (rgb) => {
      const [r, g, b] = rgb.match(/\d+/g).slice(0, 3).map(Number);
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    };

    const measured = {};
    for (const theme of ["light", "dark"]) {
      await page.evaluate(async (value) => {
        await window.dcode.updateSettings({ theme: value, fontSize: 14 });
        await new Promise((resolve) => setTimeout(resolve, 150));
      }, theme);
      await page.waitForFunction((value) => document.documentElement.classList.contains("dark") === (value === "dark"), theme, {
        timeout: 10_000,
      });

      const colors = await measure();
      assert.equal(colors.dark, theme === "dark", `${theme}：html.dark 应与设置一致`);
      for (const role of ["keyword", "identifier", "comment", "background"]) {
        assert.ok(colors[role], `${theme}：应能取到 ${role} 的计算色`);
      }
      assert.notEqual(
        colors.keyword,
        colors.comment,
        `${theme}：关键字与注释同色，说明 token 未真正着色（${colors.keyword}）`,
      );
      for (const [role, value] of [["关键字", colors.keyword], ["标识符", colors.identifier], ["注释", colors.comment]]) {
        const delta = Math.abs(luminance(value) - luminance(colors.background));
        assert.ok(delta > 0.25, `${theme}：${role}与背景对比不足（色 ${value} / 底 ${colors.background}）`);
      }
      measured[theme] = colors;
      // 截图必须真的包含代码块：切主题会重排，滚动位置要重新对准，否则证据里看不到配色。
      await block.scrollIntoViewIfNeeded();
      assert.equal(await block.isVisible(), true, `${theme}：截图前代码块应在视口内可见`);
      await page.screenshot({ path: join(shots, `code-colors-${theme}.png`) });
    }

    // 关键缺口：同一个 token 在手动深色下必须换成另一套取值。
    // 只验「每套内部 keyword!=comment」是拒绝不了「两套其实用的是同一套」的。
    // 注释不在此列：github-light 与 github-dark 的注释灰本就是同一个值（#6A737D），
    // 断言它变色等于要求上游换色；它由上面的每主题可读性检查负责。
    for (const role of ["keyword", "identifier"]) {
      assert.notEqual(
        measured.dark[role],
        measured.light[role],
        `手动深色下 ${role} 仍是浅色主题的取值（${measured.light[role]}）——配色没有随 html.dark 切换`,
      );
    }
  } finally {
    await close();
    cleanup(stateDir);
  }
});

test("复制不可用时如实反馈，不伪报成功", async () => {
  const { page, stateDir, close } = await launchApp();
  try {
    await ready(page);
    page.on("console", (msg) => rendererLogs.push(`${msg.type()}: ${msg.text()}`));
    await page.getByRole("heading", { name: "开始一项新工作" }).waitFor();
    await assertValidationModel(page);
    await stubClipboard(page, "reject");

    await send(page, ["```ts", "const x = 1", "```"].join("\n"));
    const block = assistantBlocks(page).first();
    await block.waitFor({ timeout: 30_000 });
    await waitHighlighted(page, block);

    await block.getByRole("button", { name: "复制代码" }).click();
    await block.getByRole("button", { name: "复制失败" }).waitFor({ timeout: 5000 });
    assert.deepEqual(await copiedText(page), [], "失败时不应写入任何内容");
  } finally {
    await close();
    cleanup(stateDir);
  }
});

test("同语言同长度、首尾相同而中间不同的两段代码各显示各的原文", async () => {
  const { page, stateDir, close } = await launchApp();
  try {
    await ready(page);
    await page.getByRole("heading", { name: "开始一项新工作" }).waitFor();
    await assertValidationModel(page);

    // 两段构造好的反例：长度、首 100 字、尾 100 字全同，只有中间不同
    const head = "export const marker = 1; // ".repeat(8);
    const tail = " // tail-marker-".repeat(8);
    const first = `${head}${"A".repeat(200)}${tail}`;
    const second = `${head}${"B".repeat(200)}${tail}`;
    assert.equal(first.length, second.length);
    assert.equal(first.slice(-100), second.slice(-100));

    await send(page, ["```ts", first, "```"].join("\n"));
    const blocks = assistantBlocks(page);
    await blocks.first().waitFor({ timeout: 30_000 });
    // 第一轮先让高亮完成并进入缓存，第二轮才会撞上「键不足以区分」的历史缺陷
    await waitHighlighted(page, blocks.first());
    // 等本轮真实收束：运行中追加的输入会被正常排队接收（同一执行不另起脚本），
    // 那样第二轮不会产生新的助手代码块，测的就不是缓存碰撞而是排队语义了。
    await page.getByText("本轮结束。").waitFor({ timeout: 30_000 });

    await send(page, ["```ts", second, "```"].join("\n"));
    try {
      await blocks.nth(1).waitFor({ timeout: 20_000 });
    } catch (error) {
      const timeline = await page.evaluate(() =>
        [...document.querySelectorAll("[data-slot=message]")].map((node) => ({
          from: node.getAttribute("data-from"),
          blocks: node.querySelectorAll("[data-slot=code-block]").length,
          text: (node.textContent ?? "").slice(0, 60),
        })),
      );
      throw new Error(`第二轮没有产生第二个助手代码块。时间线实况：${JSON.stringify(timeline)}`, { cause: error });
    }
    await waitHighlighted(page, blocks.nth(1));

    assert.equal(await blocks.count(), 2, "两轮各应有一个助手代码块");
    assert.deepEqual(await blockLines(blocks.nth(0)), first.split("\n"), "第一个代码块应显示第一段原文");
    assert.deepEqual(
      await blockLines(blocks.nth(1)),
      second.split("\n"),
      "第二个代码块不能复用第一段的高亮结果",
    );
  } finally {
    await close();
    cleanup(stateDir);
  }
});