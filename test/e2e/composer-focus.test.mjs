import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchApp, ready, cleanup, killApp } from "./helpers.mjs";

const evidenceDir = join(import.meta.dirname, "evidence/composer-focus");
mkdirSync(evidenceDir, { recursive: true });

test("正常草稿点击与 Tab：文本输入只由圆角容器反馈焦点，菜单按钮仍独立可辨", async () => {
  const handle = await launchApp(undefined, { DCODE_VALIDATION_ASSEMBLY: "", DCODE_VALIDATION_SAMPLE: "0" });
  const observations = [];
  const { page } = handle;
  const measure = () => page.locator("textarea").evaluate(el => {
    const shell = el.closest(".input-surface");
    const innerStyle = getComputedStyle(el);
    const outerStyle = getComputedStyle(shell);
    return {
      active: document.activeElement === el, focusVisible: el.matches(":focus-visible"),
      innerShadow: innerStyle.boxShadow, innerOutline: innerStyle.outlineWidth,
      outerShadow: outerStyle.boxShadow, outerRadius: outerStyle.borderTopLeftRadius,
      focusColor: getComputedStyle(document.documentElement).getPropertyValue("--focus-ring").trim(),
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
        await page.screenshot({ path: join(evidenceDir, `${theme}-${fontSize}-click.png`) });
        assert.equal(click.active, true);
        assert.equal(click.innerShadow, "none", "点击输入文字时不能再画直角内框");
        assert.equal(click.innerOutline, "0px", "不能以浏览器 outline 代替重复内框");
        assert.match(click.outerShadow, /2px inset/, "圆角外壳必须保留清晰焦点反馈");
        assert.ok(parseFloat(click.outerRadius) > 0);

        await page.keyboard.press("Tab");
        const menu = await page.getByRole("button", { name: "输入选项" }).evaluate(el => ({
          active: document.activeElement === el, focusVisible: el.matches(":focus-visible"), shadow: getComputedStyle(el).boxShadow,
        }));
        assert.equal(menu.active, true, "模型未配置时发送禁用，Tab 仍可达输入菜单");
        assert.equal(menu.focusVisible, true);
        assert.match(menu.shadow, /2px inset/, "容器内按钮仍须各自具备键盘焦点反馈");
        await page.keyboard.press("Shift+Tab");
        const keyboard = await measure();
        observations.push({ theme, fontSize, action: "shift-tab", ...keyboard, menu });
        assert.equal(keyboard.active, true);
        assert.equal(keyboard.focusVisible, true);
        assert.equal(keyboard.innerShadow, "none");
        assert.match(keyboard.outerShadow, /2px inset/);
        await area.fill("保持我的草稿");
        await page.keyboard.press("Tab");
        assert.equal(await area.inputValue(), "保持我的草稿");
      }
    }
  } finally {
    writeFileSync(join(evidenceDir, "observations.json"), JSON.stringify(observations, null, 2));
    try { await handle.close(); } finally { await killApp(handle); cleanup(handle.stateDir); }
  }
});
