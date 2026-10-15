// 代码高亮缓存键的碰撞反例（真实 shiki，不是构造的假缓存）。
//
// getTokensCacheKey 曾用「语言 + 长度 + 头尾各 100 字」做键。两段语言相同、长度相同、
// 头 100 字与尾 100 字都相同、只有中间不同的代码会算出同一个键，于是第二段代码
// 直接拿到第一段的高亮结果——正文看起来是另一段代码的颜色与分段，复制出的原文也不匹配。
// 这里用真实 shiki 跑一遍：先让第一段完成高亮入缓存，再看第二段的同步取用结果。

import { test } from "node:test";
import assert from "node:assert/strict";
import { highlightCode } from "../../src/renderer/components/ai/code-block";

type Tokenized = { tokens: Array<Array<{ content: string }>> };

/** 等第一次高亮真正完成（同步取用返回 null 表示还没入缓存） */
async function warm(code: string, language: string): Promise<Tokenized> {
  return new Promise<Tokenized>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("shiki 高亮超时")), 60_000);
    const result = highlightCode(code, language, (value) => {
      clearTimeout(timer);
      resolve(value);
    });
    if (result) {
      clearTimeout(timer);
      resolve(result as Tokenized);
    }
  });
}

const text = (value: Tokenized) => value.tokens.map((line) => line.map((token) => token.content).join("")).join("\n");

/** 是否真的按语法分词并带上配色（而不是整行一个不带颜色的 token） */
const hasSyntaxColors = (value: Tokenized) =>
  value.tokens.some((line) => line.some((token) => colorsOf(token).length > 0));

/** token 的配色变量：正式双主题输出时是 --shiki-light / --shiki-dark 两个变量 */
const colorsOf = (token: unknown): string[] => {
  const style = (token as { htmlStyle?: Record<string, string> }).htmlStyle ?? {};
  return ["color", "--shiki-light", "--shiki-dark"].filter((key) => Boolean(style[key]));
};

await test("语言别名（如 ts）也真正分词并带配色，而不是静默退化为纯文本", async () => {
  const result = await warm("const answer = 42;\nfunction twice(n: number) { return n * 2 }", "ts");
  assert.equal(text(result).split("\n").length, 2);
  assert.ok(
    result.tokens[0].length > 1,
    `ts 应按语法切成多个 token，实际 ${result.tokens[0].length} 个：说明语言被当成未知退化成纯文本`,
  );
  assert.ok(hasSyntaxColors(result), "高亮 token 应带有配色");
  // 双主题必须以 CSS 变量输出：span 强制使用 var(--shiki-light)/var(--shiki-dark)，
  // 若 shiki 把浅色写进内联 color 而不是 --shiki-light，浅色主题下变量未定义会同色。
  const keyword = result.tokens[0][0];
  assert.ok(
    colorsOf(keyword).includes("--shiki-light") && colorsOf(keyword).includes("--shiki-dark"),
    `关键字 token 应同时给出 --shiki-light 与 --shiki-dark，实际 ${JSON.stringify(keyword)}`,
  );
});

await test("真正未知的语言退化为纯文本，不抛错也不丢原文", async () => {
  const code = "任意内容\n第二行";
  const result = await warm(code, "这不是一种语言");
  assert.equal(text(result), code, "未知语言下原文不能丢");
  assert.equal(
    result.tokens[0].some((token) => colorsOf(token).length > 0),
    false,
    "未知语言不应被着色",
  );
});

await test("同语言、同长度、同头尾而中间不同的代码不会共用同一份高亮", async () => {
  const head = "export const marker = 1; // ".repeat(8);
  const tail = " // tail-marker-".repeat(8);
  const first = `${head}${"A".repeat(200)}${tail}`;
  const second = `${head}${"B".repeat(200)}${tail}`;
  assert.equal(first.length, second.length, "反例前提：两段长度相同");
  assert.equal(first.slice(0, 100), second.slice(0, 100));
  assert.equal(first.slice(-100), second.slice(-100));
  assert.notEqual(first, second, "反例前提：两段内容不同");

  const warmed = await warm(first, "ts");
  assert.equal(text(warmed), first, "第一段应按自身原文高亮");

  // 缓存已热：若键只由语言/长度/头尾决定，这里会直接拿到第一段的结果
  const secondSync = highlightCode(second, "ts");
  assert.equal(
    secondSync,
    null,
    "第二段命中了第一段的缓存：缓存键不足以区分仅中间不同的代码",
  );

  const secondAsync = await warm(second, "ts");
  assert.equal(text(secondAsync), second, "第二段应按自身原文高亮");
});

await test("首尾一致但中间不同的三段代码各自按自己的原文高亮", async () => {
  // 中段前后各留相同长度的相同字符，保证长度、首 100 字与尾 100 字三者全同
  const head = "const shared = true; ".repeat(10);
  const tail = " export default shared;".repeat(4);
  const codes = ["X", "Y", "Z"].map((letter) => `${head}${letter.repeat(90)}${"-".repeat(90)}${tail}`);
  assert.equal(new Set(codes.map((c) => c.length)).size, 1, "反例前提：三段长度相同");
  assert.equal(new Set(codes.map((c) => c.slice(-100))).size, 1, "反例前提：尾 100 字相同");
  assert.equal(new Set(codes.map((c) => c.slice(0, 100))).size, 1, "反例前提：首 100 字相同");
  for (const code of codes) {
    const result = await warm(code, "ts");
    assert.equal(text(result), code, "高亮文本与输入原文不一致");
  }
});
await test("缓存已预热时，带回调的调用仍会真正回调并返回同一份结果", async () => {
  const code = "export const warm = 1; // 先预热同一份键";
  const warmed = await warm(code, "ts");
  assert.ok(hasSyntaxColors(warmed), "预热结果本身应带配色");

  let calls = 0;
  let received: Tokenized | undefined;
  const sync = highlightCode(code, "ts", (value) => {
    calls += 1;
    received = value;
  });

  assert.notEqual(sync, null, "缓存已热，应同步命中");
  assert.equal(calls, 1, "缓存命中必须通知回调：早先直接 return，后挂载的代码块永远停在原始 token");
  assert.equal(received, sync, "回调拿到的应是同步返回的同一份结果");
  assert.ok(received, "回调应收到结果");
  assert.equal(text(received), code, "回调结果应保持原文");
  assert.ok(hasSyntaxColors(received), "回调结果应保持真实着色");
});
