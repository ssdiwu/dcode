// 正文代码围栏的原文保真（真实渲染断言，不是元素存在性）：
// 用 react-dom/server 渲染界面真实的 MessageResponse，断言代码块容器内的每一行
// 与 Markdown 围栏里的原文逐字一致——缩进、空行、尾部空白、全角空格都不能丢。
//
// 两点取证说明：
// 1. CodeFence 曾从 node.children[0].value 取文本。hast 里 pre > code > text，
//    children[0] 是 code 元素（value 为 undefined），代码块因此渲染成空白。
// 2. 行渲染用 display:block 承担换行（不改造成 span 内嵌 \n：那会在 pre 里多出空行），
//    因此 DOM 文本不含换行，断言按「每个行块等于原文一行」逐行比对，
//    并另外断言行的顺序与数量。逐字可复制的通路是复制按钮写入的原始字符串，
//    由 e2e/code-content.test.mjs 在真实窗口里核对。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageResponse } from "../../src/renderer/components/ai/message";

interface RenderedBlock {
  language: string;
  /** 行块的显示文本（block 元素之间的换行由 CSS 承担，文本里不含） */
  lines: string[];
}

const decodeEntities = (input: string) =>
  input
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

/** 从渲染结果取出每个代码块容器的语言与行块文本（按容器起始标签切分，不依赖嵌套层数） */
function codeBlocks(html: string): RenderedBlock[] {
  return html
    .split(/<div data-slot="code-block"/)
    .slice(1)
    .map((chunk) => {
      const language = chunk.match(/^[^>]*data-language="([^"]*)"/)?.[1] ?? "";
      const pre = chunk.match(/<pre[^>]*>[\s\S]*?<code[^>]*>([\s\S]*?)<\/code><\/pre>/);
      assert.ok(pre, `代码块缺少 pre/code 正文：${chunk.slice(0, 300)}`);
      // 行块是 code 的直接子 span（上游用 display:block 承担换行）
      const lines = [...pre[1].matchAll(/<span class="[^"]*block[^"]*">([\s\S]*?)<\/span>/g)].map((m) =>
        decodeEntities(m[1]),
      );
      return { language, lines };
    });
}

/** 行块文本还原成源码行：空行在渲染里是单个换行符 */
const asSourceLines = (lines: string[]) => lines.map((line) => (line === "\n" ? "" : line));

await test("代码围栏保留原文：缩进、空行、尾部空白与中文注释都不丢", () => {
  const code = [
    "function 判定(输入: string) {",
    "  // 中文注释：这里有  全角空格",
    "  if (输入 === '') {",
    "    return null",
    "  }",
    "",
    "  return 输入.trim()   ",
    "}",
  ].join("\n");

  const html = renderToStaticMarkup(
    createElement(MessageResponse, null, ["这是改动：", "", "```ts", code, "```"].join("\n")),
  );
  const blocks = codeBlocks(html);
  assert.equal(blocks.length, 1, `应有且只有一个代码块，实际 ${blocks.length}`);
  assert.equal(blocks[0].language, "ts");
  assert.deepEqual(asSourceLines(blocks[0].lines), code.split("\n"));
});

await test("同一回复里的多个围栏各自保留自己的原文", () => {
  const first = "const a = 1\nconst b = 2";
  const second = "const a = 3\nconst b = 4";
  const html = renderToStaticMarkup(
    createElement(
      MessageResponse,
      null,
      ["```ts", first, "```", "", "中间说明", "", "```python", second, "```"].join("\n"),
    ),
  );
  const blocks = codeBlocks(html);
  assert.deepEqual(
    blocks.map((b) => b.language),
    ["ts", "python"],
  );
  assert.deepEqual(asSourceLines(blocks[0].lines), first.split("\n"));
  assert.deepEqual(asSourceLines(blocks[1].lines), second.split("\n"));
});

await test("没有语言标注的围栏按纯文本处理且原文不丢", () => {
  const code = "just some plain output\nsecond line";
  const html = renderToStaticMarkup(createElement(MessageResponse, null, ["```\n", code, "\n```"].join("")));
  const blocks = codeBlocks(html);
  assert.equal(blocks[0].language, "text");
  assert.deepEqual(asSourceLines(blocks[0].lines), code.split("\n"));
});

await test("围栏有同名不同内容时按各自内容渲染，不互相顶替", () => {
  // 高亮缓存曾用「语言+长度+头尾各 100 字」做键；此例两端与长度相同、中间不同。
  const head = "A".repeat(100);
  const tail = "Z".repeat(100);
  const first = head + "M".repeat(50) + tail;
  const second = head + "N".repeat(50) + tail;
  assert.notEqual(first, second);
  assert.equal(first.length, second.length);

  const html = renderToStaticMarkup(
    createElement(MessageResponse, null, ["```ts", first, "```", "", "```ts", second, "```"].join("\n")),
  );
  const blocks = codeBlocks(html);
  assert.equal(blocks.length, 2);
  assert.deepEqual(asSourceLines(blocks[0].lines), first.split("\n"));
  assert.deepEqual(asSourceLines(blocks[1].lines), second.split("\n"));
});