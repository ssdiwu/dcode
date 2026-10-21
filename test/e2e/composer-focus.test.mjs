import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchApp, ready, cleanup, killApp } from "./helpers.mjs";
import { evidenceDir } from "./evidence-root.mjs";

const focusEvidence = evidenceDir("composer-focus");

test("正常草稿点击与 Tab：文本输入只由圆角容器反馈焦点，菜单按钮仍独立可辨", async () => {
  const handle = await launchApp(undefined, { DCODE_VALIDATION_ASSEMBLY: "", DCODE_VALIDATION_SAMPLE: "0" });
  const observations = [];
  const { page } = handle;
  /**
   * 键盘焦点外壳的实际对比度。
   *
   * Shift+Tab 时内层 box-shadow 为 none、outline 为 0，外壳是唯一焦点指示，
   * 不能按「附加组反馈」豁免——必须按实际合成后的颜色对比来判。
   * 背景取真实合成结果：自页面根到外壳逐层按 alpha 叠加（含玻璃底的 backdrop 内容色忽略，
   * 只叠加各层背景色，这与浏览器对 inset 阴影的绘制底色一致）。
   */
  const measure = () => page.locator("textarea").evaluate(el => {
    const shell = el.closest(".input-surface");
    const innerStyle = getComputedStyle(el);
    const outerStyle = getComputedStyle(shell);
    const parse = (value) => {
      const text = String(value).trim();
      // 深色 token 写成 #rrggbb / #rrggbbaa，浅色写成 rgb()/rgba()：两种都要解析
      const hex = text.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i);
      if (hex) {
        const n = hex[1].match(/../g).map((h) => parseInt(h, 16));
        const a = hex[2] === undefined ? 1 : parseInt(hex[2], 16) / 255;
        return { rgb: n, a };
      }
      const m = text.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
      if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
      return { rgb: [parts[0], parts[1], parts[2]], a: parts.length > 3 ? parts[3] : 1 };
    };
    const over = (fg, bg, a) => fg.map((c, i) => c * a + bg[i] * (1 - a));
    const chain = [];
    for (let n = shell; n; n = n.parentElement) chain.unshift(n);
    let bg = [255, 255, 255];
    for (const node of chain) {
      const layer = parse(getComputedStyle(node).backgroundColor);
      if (layer && layer.a > 0) bg = over(layer.rgb, bg, layer.a);
    }
    const luminance = ([r, g, b]) => {
      const f = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const token = getComputedStyle(shell).getPropertyValue("--focus-ring-shell").trim();
    const ring = parse(token);
    const effective = ring ? over(ring.rgb, bg, ring.a) : bg;
    const lb = luminance(bg);
    const lr = luminance(effective);
    const contrast = (Math.max(lb, lr) + 0.05) / (Math.min(lb, lr) + 0.05);
    return {
      active: document.activeElement === el, focusVisible: el.matches(":focus-visible"),
      innerShadow: innerStyle.boxShadow, innerOutline: innerStyle.outlineWidth,
      outerShadow: outerStyle.boxShadow, outerRadius: outerStyle.borderTopLeftRadius,
      focusColor: getComputedStyle(document.documentElement).getPropertyValue("--focus-ring").trim(),
      ringToken: token,
      background: bg.map(Math.round),
      effectiveRing: effective.map(Math.round),
      contrast: Number(contrast.toFixed(4)),
    };
  });
  try {
    await ready(page);
    for (const theme of ["dark", "light"]) {
      for (const fontSize of [14, 13]) {
        await page.evaluate(input => window.dcode.updateSettings(input), { theme, fontSize });
        await page.waitForFunction(input => document.documentElement.classList.contains("dark") === (input.theme === "dark") && getComputedStyle(document.body).fontSize === `${input.fontSize}px`, { theme, fontSize });
        const area = page.locator("textarea");
        await area.click();
        const click = await measure();
        observations.push({ theme, fontSize, action: "click", ...click });
        await page.screenshot({ path: join(focusEvidence, `${theme}-${fontSize}-click.png`) });
        assert.equal(click.active, true);
        assert.equal(click.innerShadow, "none", "点击输入文字时不能再画直角内框");
        assert.equal(click.innerOutline, "0px", "不能以浏览器 outline 代替重复内框");
        assert.match(click.outerShadow, /2px inset/, "圆角外壳必须保留清晰焦点反馈");
        assert.ok(parseFloat(click.outerRadius) > 0);

        // 操作行顺序（C05 起）：引用入口 → 模型入口 → 发送钮 → 输入选项菜单。
        // 模型未配置时发送钮禁用、不可聚焦；模型入口是可用的真控件（改「新会话起点」），
        // 所以从输入框 Tab 依次落在引用入口、模型入口、输入选项菜单——三站都要有可辨焦点。
        await page.keyboard.press("Tab");
        const entry = await page.getByRole("button", { name: "添加文件与技能引用" }).evaluate(el => ({
          active: document.activeElement === el, focusVisible: el.matches(":focus-visible"), shadow: getComputedStyle(el).boxShadow,
        }));
        assert.equal(entry.active, true, "Tab 第一站应是引用入口");
        assert.equal(entry.focusVisible, true, "键盘 Tab 到达的次级入口须命中 :focus-visible");
        assert.match(entry.shadow, /2px inset/, "容器内次级入口仍须各自具备键盘焦点反馈");
        await page.keyboard.press("Tab");
        const modelEntry = await page.getByTestId("model-entry-trigger").evaluate(el => ({
          active: document.activeElement === el, focusVisible: el.matches(":focus-visible"), shadow: getComputedStyle(el).boxShadow,
        }));
        assert.equal(modelEntry.active, true, "Tab 第二站应是模型入口");
        assert.equal(modelEntry.focusVisible, true, "模型入口须能被键盘到达并命中 :focus-visible");
        assert.match(modelEntry.shadow, /2px inset/, "模型入口须有键盘焦点反馈");
        await page.keyboard.press("Tab");
        const menu = await page.getByRole("button", { name: "输入选项" }).evaluate(el => ({
          active: document.activeElement === el, focusVisible: el.matches(":focus-visible"), shadow: getComputedStyle(el).boxShadow,
        }));
        assert.equal(menu.active, true, "模型未配置时发送禁用，Tab 仍可达输入菜单");
        assert.equal(menu.focusVisible, true);
        assert.match(menu.shadow, /2px inset/, "容器内按钮仍须各自具备键盘焦点反馈");
        // 反向也要逐站走回：菜单 → 模型入口 → 引用入口 → 输入框
        await page.keyboard.press("Shift+Tab");
        assert.equal(await page.getByTestId("model-entry-trigger").evaluate((el) => document.activeElement === el), true, "Shift+Tab 应回到模型入口");
        await page.keyboard.press("Shift+Tab");
        assert.equal(await page.getByRole("button", { name: "添加文件与技能引用" }).evaluate((el) => document.activeElement === el), true, "Shift+Tab 应回到引用入口");
        await page.keyboard.press("Shift+Tab");
        const keyboard = await measure();
        observations.push({ theme, fontSize, action: "shift-tab", ...keyboard, menu });
        assert.equal(keyboard.active, true, "两站 Shift+Tab 后焦点应回到输入框");
        assert.equal(keyboard.focusVisible, true);
        assert.equal(keyboard.innerShadow, "none");
        assert.match(keyboard.outerShadow, /2px inset/);
        // DESIGN 键盘焦点至少 3:1；内层无框，外壳是唯一指示，按实际合成色判定
        assert.ok(keyboard.contrast >= 3, `${theme} ${fontSize}px 键盘焦点对比度须≥3:1（实际 ${keyboard.contrast}，背景 rgb(${keyboard.background})，环 rgb(${keyboard.effectiveRing})，token ${keyboard.ringToken}）`);
        await area.fill("保持我的草稿");
        await page.keyboard.press("Tab");
        assert.equal(await area.inputValue(), "保持我的草稿");
      }
    }
    // 减少透明度偏好：走真实媒体查询（Playwright 的 emulateMedia 不含该特性，用 CDP 设置），
    // 此时玻璃退化为 --input 实色，焦点对比必须在那个真实底色上同样成立
    const cdp = await page.context().newCDPSession(page);
    for (const theme of ["light", "dark"]) {
      await page.evaluate(input => window.dcode.updateSettings(input), { theme, fontSize: 14 });
      await page.waitForFunction(input => document.documentElement.classList.contains("dark") === (input.theme === "dark"), { theme });
      await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: "reduce" }] });
      try {
        const opaque = await page.locator("textarea").evaluate((el) => {
          const shell = el.closest(".input-surface");
          // 解析当前主题的 --input 实色值（探针元素读回，不硬编码任何颜色）
          const probe = document.createElement("div");
          probe.style.background = "var(--input)";
          document.body.appendChild(probe);
          const inputColor = getComputedStyle(probe).backgroundColor;
          probe.remove();
          return { backdrop: getComputedStyle(shell).backdropFilter, shellBackground: getComputedStyle(shell).backgroundColor, inputColor };
        });
        // 前置：媒体查询真的生效（玻璃底退化为当前主题的 --input 实色且不再模糊）
        assert.equal(opaque.shellBackground, opaque.inputColor, `减少透明度底应为 --input 实色（壳 ${opaque.shellBackground} / --input ${opaque.inputColor}）`);
        assert.match(opaque.backdrop, /none/, `减少透明度时应关闭 backdrop 模糊（实得 ${opaque.backdrop}）`);
        const area2 = page.locator("textarea");
        await area2.click();
        // 与主循环同一路径：点击 → Tab 到输入菜单 → Shift+Tab 回到编辑区（键盘焦点态）
        await page.keyboard.press("Tab");
        await page.getByRole("button", { name: "输入选项" }).waitFor();
        await page.keyboard.press("Shift+Tab");
        const reduced = await measure();
        observations.push({ theme, fontSize: 14, action: "shift-tab-reduced-transparency", ...reduced });
        assert.equal(reduced.focusVisible, true, "减少透明度下仍须由外壳承担键盘焦点");
        assert.equal(reduced.innerShadow, "none");
        assert.ok(reduced.contrast >= 3, `${theme} 减少透明度底上的键盘焦点对比度须≥3:1（实际 ${reduced.contrast}，背景 rgb(${reduced.background})，环 rgb(${reduced.effectiveRing})）`);
      } finally {
        await cdp.send("Emulation.setEmulatedMedia", { features: [] });
      }
    }
  } finally {
    writeFileSync(join(focusEvidence, "observations.json"), JSON.stringify(observations, null, 2));
    try { await handle.close(); } finally { await killApp(handle); cleanup(handle.stateDir); }
  }
});
