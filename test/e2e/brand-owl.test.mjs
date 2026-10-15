// 品牌猫头鹰 D2-R2 接入验证（507 于 2026-10-08 定案）：
// 侧栏与「设置→关于」同源图像、D Code 保留、几何从字号派生、macOS 80px 窗控避让、无裁切/滤镜/反色。
// 证据分层：renderer 由 Vite 打包同源 URL（构建产物字节已单独核对）；
// 运行时 Dock/窗图为 nativeImage 输入（字节 hash 与解码尺寸分别证明，不要求重编码字节相等）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { launchApp, cleanup, ready, assertValidationModel } from "./helpers.mjs";
import { evidenceDir } from "./evidence-root.mjs";

const EVIDENCE = evidenceDir("brand-owl");
mkdirSync(EVIDENCE, { recursive: true });
const ROOT = join(import.meta.dirname, "../..");
const MASTER = join(ROOT, "resources/brand/dcode-owl-master.png");
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const MASTER_SHA = sha(MASTER);

test("品牌猫头鹰：侧栏与关于页同源图像可辨，几何从字号派生，边界/名称保留", async () => {
  const { app, page, stateDir, close } = await launchApp();
  const evidence = { masterSHA256: MASTER_SHA, cases: [] };
  try {
    await ready(page);
    await page.getByRole("heading", { name: "开始一项新工作" }).waitFor();
    await assertValidationModel(page);

    // 输入字节 hash（片内 source）与 nativeImage 解码尺寸分别为独立事实。
    // Dock/窗口图标的系统显示未验收——本片只在输入解码与源码接线层面证明（不声明已安装应用 ICNS）。
    const pngManifest = (() => {
      const png = readFileSync(MASTER);
      return { bytes: png.length, sha256: MASTER_SHA };
    })();
    evidence.inputPng = pngManifest;

    // 解码头 nativeImage 输入的实际解码（独立于此 main/index.ts 的 readFile 间事实）：
    // 用绝对路径从同一主进程侧读本片固定母版，复核 isEmpty/getSize
    const decoded = await app.evaluate(({ nativeImage }, masterAbs) => {
      const ni = nativeImage.createFromPath(masterAbs);
      const size = ni.getSize();
      return { isEmpty: ni.isEmpty(), width: size.width, height: size.height };
    }, join(ROOT, "resources/brand/dcode-owl-master.png"));
    assert.equal(decoded.isEmpty, false, `nativeImage 输入解码为空（不应空）`);
    assert.ok(decoded.width === 1254 && decoded.height === 1254, `nativeImage 解码尺寸须为 1254×1254（实际 ${decoded.width}×${decoded.height}）`);
    evidence.nativeImageDecoded = decoded;

    // 窗口标题仍 D Code；Dock/窗口图标为运行时入口，系统显示未验收
    const windowTitle = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle());
    assert.equal(windowTitle, "D Code");
    evidence.windowMeta = { title: windowTitle, systemIconAcceptance: "未验收（运行时 Dock/窗口 icon 入口已接线，系统显示不在本片）" };

    // 各字号：13（必需）/ 14（默认）/ 16（最大）
    const cases = [
      { lang: "zh", fontSize: 13, expectedPx: 26 },
      { lang: "zh", fontSize: 14, expectedPx: 28 },
      { lang: "en", fontSize: 16, expectedPx: 32 },
    ];
    for (const c of cases) {
      await page.evaluate(async (cc) => {
        await window.dcode.updateSettings({ language: cc.lang, fontSize: cc.fontSize });
      }, c);
      await page.waitForFunction((cc) => getComputedStyle(document.body).fontSize === `${cc.fontSize}px`, c, { timeout: 5_000 });
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

      const measure = await page.evaluate(() => {
        const navImg = document.querySelector("nav .app-brand-owl");
        const navBrand = document.querySelector("nav .app-brand");
        const brand = navBrand?.getBoundingClientRect();
        const img = navImg?.getBoundingClientRect();
        const navText = navBrand?.querySelector("span")?.getBoundingClientRect();
        const settingsBtn = [...document.querySelectorAll("nav button")].find((b) => /设置|Settings/.test(b.textContent ?? ""));
        return {
          navImg: img ? { x: img.x, y: img.y, w: img.width, h: img.height } : null,
          navText: navText ? { x: navText.x, y: navText.y } : null,
          brandRect: brand ? { x: brand.x, y: brand.y, w: brand.width, h: brand.height } : null,
          navBrandPaddingLeft: getComputedStyle(navBrand).paddingLeft,
          computedWidth: navImg ? getComputedStyle(navImg).width : null,
          natural: navImg ? { w: navImg.naturalWidth, h: navImg.naturalHeight } : null,
          complete: navImg?.complete ?? false,
          srcStartsWith: navImg?.src?.slice(0, 40) ?? null,
          alt: navImg?.alt,
          ariaHidden: navImg?.getAttribute("aria-hidden"),
          settingsPresent: !!settingsBtn,
          borderRadius: navImg ? getComputedStyle(navImg).borderRadius : null,
        };
      });
      // 图像成功加载且源就是 Vite 打包同源 URL
      assert.ok(measure.complete, `${c.fontSize}px：侧栏图须真实加载`);
      assert.ok(measure.natural.w === 1254 && measure.natural.h === 1254, `naturalWidth/Height 须为 1254×1254（实际 ${JSON.stringify(measure.natural)}）`);
      assert.ok(measure.srcStartsWith && (measure.srcStartsWith.startsWith("file:///") || measure.srcStartsWith.startsWith("app://") || measure.srcStartsWith.includes("dcode-owl")), `src 须来自 Vite 打包同源 URL（实际 ${measure.srcStartsWith}）`);
      assert.equal(measure.alt, "", "装饰图 alt 须为空（可访问名称靠相邻文本承担）");
      assert.equal(measure.ariaHidden, "true", "装饰图须 aria-hidden");
      // 几何：2 × 字号，保留宽高比；圆角须为 0px（不裁切原图四角）
      assert.ok(Math.abs(measure.navImg.w - c.expectedPx) <= 0.5, `几何应约 ${c.expectedPx}px（实际 ${measure.navImg.w}）`);
      assert.ok(Math.abs(measure.navImg.h - c.expectedPx) <= 0.5, "高度同宽（不拉伸）");
      assert.equal(measure.borderRadius, "0px", `${c.fontSize}px 侧栏图圆角须为 0px（实际 computed borderRadius=${measure.borderRadius}）`);
      // 名称仍可见且未被图挤压
      assert.ok(measure.navText.x > measure.navImg.x + measure.navImg.w, "名称须在图右侧，未被覆盖");
      // macOS 80px 窗控避让（平台为 darwin 时）
      if (process.platform === "darwin") {
        assert.equal(measure.navBrandPaddingLeft, "80px", `侧栏品牌左内边距须为 macOS 窗控避让的 80px（实际 ${measure.navBrandPaddingLeft}）`);
      }

      // 设置 → 关于：侧栏底部独有按名字固定匹配，避免 workspace 行里包含"设置"的样本按钮冲突
      await page.getByRole("button", { name: c.lang === "zh" ? "设置" : "Settings", exact: true }).click();
      await page.getByRole("button", { name: c.lang === "zh" ? "关于" : "About" }).click();
      await page.waitForTimeout(50);
      const about = await page.evaluate(() => {
        const img = document.querySelector("main .app-brand-owl");
        const r = img?.getBoundingClientRect();
        const wrapper = img?.parentElement;
        return {
          found: !!img,
          natural: img ? { w: img.naturalWidth, h: img.naturalHeight } : null,
          complete: img?.complete ?? false,
          rect: r ? { w: r.width, h: r.height } : null,
          text: wrapper?.textContent ?? null,
          borderRadius: img ? getComputedStyle(img).borderRadius : null,
        };
      });
      assert.ok(about.found, "设置→关于页须展示同源图");
      assert.ok(about.complete, "关于页图须真实加载");
      assert.ok(about.natural.w === 1254 && about.natural.h === 1254, `关于页 natural 尺寸为 1254（实际 ${JSON.stringify(about.natural)}）`);
      assert.ok(Math.abs(about.rect.w - c.expectedPx) <= 0.5, `关于页几何应约 ${c.expectedPx}px（实际 ${about.rect.w}）`);
      assert.equal(about.borderRadius, "0px", `${c.fontSize}px 关于页图圆角须为 0px（实际 computed borderRadius=${about.borderRadius}）`);
      assert.ok((about.text ?? "").includes("D Code"), "关于页必须仍含 D Code 文字");
      // 同时回到工作区为下一轮字号准备
      await page.keyboard.press("Escape");
      await page.getByRole("heading", { name: c.lang === "zh" ? "开始一项新工作" : "Start new work" }).waitFor();

      evidence.cases.push({ lang: c.lang, fontSize: c.fontSize, side: measure, about });
    }

    // 中英（13/14）+ 暗色主题复核（去 mask/反色断言不建立在主题切换基础上）
    await page.evaluate(async () => {
      await window.dcode.updateSettings({ language: "en", theme: "dark", fontSize: 14 });
    });
    await page.waitForFunction(() => getComputedStyle(document.body).fontSize === "14px", null, { timeout: 5_000 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const dark = await page.evaluate(() => {
      const img = document.querySelector("nav .app-brand-owl");
      const cs = getComputedStyle(img);
      return {
        filter: cs.filter,
        mixBlendMode: cs.mixBlendMode,
        opacity: cs.opacity,
        mask: cs.mask || cs.webkitMask,
        borderRadius: cs.borderRadius,
        objectFit: cs.objectFit,
        complete: img?.complete ?? false,
        natural: img ? { w: img.naturalWidth, h: img.naturalHeight } : null,
      };
    });
    assert.equal(dark.complete, true, "暗色主题下侧栏图须仍成功加载");
    assert.equal(dark.filter, "none", "不得对图应用滤镜");
    assert.equal(dark.mixBlendMode, "normal", "不得改混合模式");
    assert.equal(dark.opacity, "1", "不得调透明度");
    const darkMask = dark.mask ?? "";
    assert.equal(darkMask === "" || darkMask === "none", true, `不得设置 mask（实际 ${darkMask.slice(0, 100)}）`);
    assert.equal(dark.objectFit, "contain", "原图须完整按宽高比呈现（objectFit=contain）");
    assert.equal(dark.borderRadius, "0px", `暗色主题下圆角仍须为 0px（实际 computed borderRadius=${dark.borderRadius}）`);
    evidence.darkThemeCheck = dark;
    evidence.screenshots = evidence.screenshots ?? [];
    {
      const shot = windowStateShotName("dark", "en", 14, 1440, 900, "sidebar");
      await page.screenshot({ path: join(EVIDENCE, shot) });
      evidence.screenshots.push(shot);
    }

    // About 代表截图（同暗色 14px en）
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "About" }).click();
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const aboutRect = await page.evaluate(() => {
      const img = document.querySelector("main .app-brand-owl");
      const wrapper = img?.parentElement;
      const wrapperR = wrapper?.getBoundingClientRect();
      const imgR = img?.getBoundingClientRect();
      const textR = wrapper?.querySelector("span")?.getBoundingClientRect();
      return {
        wrapper: wrapperR ? { x: wrapperR.x, y: wrapperR.y, w: wrapperR.width, h: wrapperR.height } : null,
        img: imgR ? { x: imgR.x, y: imgR.y, w: imgR.width, h: imgR.height } : null,
        text: textR ? { x: textR.x, y: textR.y, w: textR.width, h: textR.height } : null,
        textContent: wrapper?.textContent ?? null,
      };
    });
    assert.ok(aboutRect.text && (aboutRect.wrapper.h >= aboutRect.img.h - 0.5), "About 容器须完整包裹图与文字");
    assert.ok(aboutRect.text.x >= aboutRect.img.x + aboutRect.img.w - 0.5, "About 文字必须在图右侧，不相交");
    assert.equal(aboutRect.textContent.includes("D Code"), true, "About 须含 D Code 文字");
    {
      const shot = windowStateShotName("dark", "en", 14, 1440, 900, "about");
      await page.screenshot({ path: join(EVIDENCE, shot) });
      evidence.screenshots.push(shot);
    }
    await page.keyboard.press("Escape");
    await page.getByRole("heading", { name: "Start new work" }).waitFor();

    // 极端组合：同一最挤 720×480 + 16 最大字号（同时最窄+最大字号）
    // 与基线 1440×900、13 最小字号复核
    const extremeCases = [
      { name: "720×480-zh-light-16", lang: "zh", theme: "light", fontSize: 16, expectedPx: 32, width: 720, height: 480 },
      { name: "1440×900-zh-light-13", lang: "zh", theme: "light", fontSize: 13, expectedPx: 26, width: 1440, height: 900 },
    ];
    for (const c of extremeCases) {
      await page.evaluate(async (cc) => {
        await window.dcode.updateSettings({ language: cc.lang, theme: cc.theme, fontSize: cc.fontSize });
      }, c);
      await app.evaluate(({ BrowserWindow }, cc) => {
        BrowserWindow.getAllWindows()[0].setSize(cc.width, cc.height);
      }, c);
      await page.waitForFunction((cc) => window.innerWidth === cc.width && window.innerHeight === cc.height && getComputedStyle(document.body).fontSize === `${cc.fontSize}px`, c, { timeout: 5_000 });
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const ex = await page.evaluate(() => {
        const img = document.querySelector("nav .app-brand-owl");
        const ir = img?.getBoundingClientRect();
        const brand = document.querySelector("nav .app-brand")?.getBoundingClientRect();
        const brandText = document.querySelector("nav .app-brand span")?.getBoundingClientRect();
        const navR = document.querySelector("nav")?.getBoundingClientRect();
        const settingsBtn = [...document.querySelectorAll("nav button")].find((b) => /设置|Settings/.test(b.textContent ?? ""));
        const sr = settingsBtn?.getBoundingClientRect();
        const cs = img ? getComputedStyle(img) : null;
        return {
          img: ir ? { x: ir.x, y: ir.y, w: ir.width, h: ir.height } : null,
          brand: brand ? { x: brand.x, y: brand.y, w: brand.width, h: brand.height } : null,
          brandText: brandText ? { x: brandText.x, y: brandText.y, w: brandText.width, h: brandText.height } : null,
          navWidth: navR?.width ?? null,
          settings: sr ? { x: sr.x, y: sr.y, w: sr.width, h: sr.height } : null,
          styles: cs ? { filter: cs.filter, borderRadius: cs.borderRadius, objectFit: cs.objectFit, mask: cs.mask || cs.webkitMask } : null,
          brandTextVis: brandText ? { top: brandText.top >= 0, bottom: brandText.bottom <= window.innerHeight, left: brandText.left >= 0, right: brandText.right <= (navR?.width ?? 0) } : null,
        };
      });
      // 容器包裹：brand 高度至少覆盖 max(img.h, text.h)
      assert.ok(ex.brand.h >= ex.img.h - 0.5 && ex.brand.h >= ex.brandText.h - 0.5, `brand 容器须完整包裹图文 ${JSON.stringify({ brand: ex.brand, img: ex.img, text: ex.brandText })}`);
      // 图文不相交：文字左边界 >= 图右边界
      assert.ok(ex.brandText.x >= ex.img.x + ex.img.w - 0.5, `图文不相交（text.x=${ex.brandText.x} vs img.right=${ex.img.x + ex.img.w}）`);
      assert.ok(ex.brandTextVis.left && ex.brandTextVis.right && ex.brandTextVis.top && ex.brandTextVis.bottom, "文字在容器与屏幕内完整可见");
      assert.ok(Math.abs(ex.img.w - c.expectedPx) <= 0.5, `${c.name} 几何应约 ${c.expectedPx}px（实际 ${ex.img.w}）`);
      // objectFit 完整、无滤镜/反色/mask；圆角必须为 0——圆角会裁切原图四角（定案要求雾蓝完整矩形）
      assert.equal(ex.styles.objectFit, "contain");
      assert.equal(ex.styles.filter, "none");
      const mask = ex.styles.mask ?? "";
      assert.equal(mask === "" || mask === "none", true, `不得设置 mask（实际 ${mask.slice(0, 100)}）`);
      assert.equal(ex.styles.borderRadius, "0px", `原图不得被圆角裁切（实际 computed borderRadius=${ex.styles.borderRadius}）`);
      evidence.extremes = evidence.extremes ?? [];
      const entry = { ...c, sidebar: ex };
      // About 同样要测图文/容器完整边界
      await page.getByRole("button", { name: c.lang === "zh" ? "设置" : "Settings", exact: true }).click();
      await page.getByRole("button", { name: c.lang === "zh" ? "关于" : "About" }).click();
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const ab = await page.evaluate(() => {
        const img = document.querySelector("main .app-brand-owl");
        const wrapper = img?.parentElement;
        const wrapperR = wrapper?.getBoundingClientRect();
        const imgR = img?.getBoundingClientRect();
        const textR = wrapper?.querySelector("span")?.getBoundingClientRect();
        const card = wrapper?.closest(".rounded-xl") ?? wrapper;
        const cardR = card?.getBoundingClientRect();
        const imgCs = img ? getComputedStyle(img) : null;
        return {
          wrapper: wrapperR ? { x: wrapperR.x, y: wrapperR.y, w: wrapperR.width, h: wrapperR.height } : null,
          img: imgR ? { x: imgR.x, y: imgR.y, w: imgR.width, h: imgR.height } : null,
          text: textR ? { x: textR.x, y: textR.y, w: textR.width, h: textR.height } : null,
          card: cardR ? { x: cardR.x, y: cardR.y, w: cardR.width, h: cardR.height } : null,
          content: wrapper?.textContent ?? null,
          imgBorderRadius: imgCs?.borderRadius ?? null,
        };
      });
      // About 容器须整体容纳图与文字；文字在图右侧；不相交
      assert.ok(ab.card.w >= ab.img.x + ab.img.w - ab.card.x - 0.5, `About 卡片须完整容纳图 ${JSON.stringify({ card: ab.card, img: ab.img })}`);
      assert.ok(ab.text.x >= ab.img.x + ab.img.w - 0.5, `About 图文不相交（text.x=${ab.text.x} vs img.right=${ab.img.x + ab.img.w}）`);
      assert.ok(ab.content.includes("D Code"), "About 须含 D Code 文字");
      assert.equal(ab.imgBorderRadius, "0px", `About 图圆角须为 0px（实际 computed borderRadius=${ab.imgBorderRadius}）`);
      entry.about = ab;
      evidence.extremes.push(entry);

      evidence.screenshots = evidence.screenshots ?? [];
      const shotName = windowStateShotName(c.theme, c.lang, c.fontSize, c.width, c.height, "sidebar");
      await page.screenshot({ path: join(EVIDENCE, shotName) });
      evidence.screenshots.push(shotName);
      await page.keyboard.press("Escape");
      await page.getByRole("heading", { name: c.lang === "zh" ? "开始一项新工作" : "Start new work" }).waitFor();
    }

    // 代表截图：1600×1200 的浅色 zh 14 About 代表（命名与实际状态一致）
    await page.evaluate(async () => {
      await window.dcode.updateSettings({ language: "zh", theme: "light", fontSize: 14 });
    });
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(1600, 1200); });
    await page.waitForFunction(() => window.innerWidth === 1600 && window.innerHeight === 1200 && getComputedStyle(document.body).fontSize === "14px", null, { timeout: 5_000 });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "关于" }).click();
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.screenshot({ path: join(EVIDENCE, windowStateShotName("light", "zh", 14, 1600, 1200, "about")) });
    evidence.screenshots.push(windowStateShotName("light", "zh", 14, 1600, 1200, "about"));
    await page.keyboard.press("Escape");

    writeFileSync(join(EVIDENCE, "brand-owl-geometry.json"), JSON.stringify(evidence, null, 1));
  } finally {
    await close();
    cleanup(stateDir);
  }
});

/** 按真实状态命名截图，与 evidence.screenshots 对应一致 */
function windowStateShotName(theme, lang, fontSize, width, height, region) {
  return `brand-${theme}-${lang}-${fontSize}px-${width}x${height}-${region}.png`;
}
