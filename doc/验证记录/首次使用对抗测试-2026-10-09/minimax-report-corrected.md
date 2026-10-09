
## 更正报告

### 已撤回的错误断言

| 原断言 | 撤回原因 |
|--------|----------|
| `:focus-within:not(:focus-visible)` 逻辑错误导致规则永不触发 | textarea 作为子元素持焦时 `:focus-visible` 作用于自身，容器 `.input-surface` 不是 `:focus-visible`，`:not(:focus-visible)` 对容器为 true，规则**会触发** |
| 所有 E2E 测试均强制 mock | `product-owned-content.test.mjs` 第 6 行 `const normal = { DCODE_VALIDATION_ASSEMBLY: '', ... }`；`helpers.mjs` 第 69 行 `{...extraEnv}` 在 mock 变量**之后**展开，后者被前者覆盖 |
| `Boolean(disabled)` 永为 false | `disabled` 由父组件显式传入，非函数声明的默认值；父组件可传 `disabled={true}` |
| 测试代码 `buttonCount.some(...)` | `buttonCount` 是 `number`，无 `.some()` 方法 |
| `createRequire` 未 import | 语法错误 |
| placeholder 在配置前不存在 | 会导致 `getByPlaceholder` 失败 |
| 末尾两个 test 是空壳 | 不可执行 |

---

## 一、已核缺陷（源码支撑）

### 缺陷 1：焦点描边重叠

**文件**：`src/renderer/styles.css` 第 31-40 行

**现象**：用户报告"直角白框"，实测 textarea 持焦时 `box-shadow='rgb(236, 236, 238) 0px 0px 0px 2px inset'`

**根因**：

```css
/* 第 31-36 行：全局 textarea 焦点规则 */
:is(..., textarea, ...):focus-visible {
  box-shadow: inset 0 0 0 max(2px, ...) var(--focus-ring);
}

/* 第 49-53 行：壳内子元素持焦时壳的替代反馈 */
.input-surface:focus-within:not(:focus-visible) {
  border-color: var(--border-strong);
  box-shadow: inset 0 0 0 1px var(--border-strong);
}
```

当 textarea 子元素持焦：
- textarea 自身获得 2px `focus-ring` 描边（亮色前景）
- 容器因 `:focus-within:not(:focus-visible)` 获得 1px `border-strong` 描边

两者**同时生效**，导致双重描边。`rounded-2xl` 容器视觉上呈现"直角白框"（描边与背景色差导致圆角感知消失）。

### 缺陷 2：设置页模型配置 UI 缺失

**文件**：`src/renderer/views/SettingsPage.tsx` 第 105-116 行

**已核**：仅渲染只读 Badge，无任何 `<input type="url">`、`<input type="password">`、`<button>` 配置控件。

---

## 二、可运行测试片段

### 测试 A：焦点描边重叠

```javascript
// test/e2e/focus-overlap.test.mjs
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { _electron as electron } from "playwright-core";

const require = createRequire(import.meta.url);
const electronBinary = require("electron");

test("焦点描边重叠：textarea 持焦时 input-surface 不应同时画框", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "dcode-focus-"));
  const procExit = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("超时")), 30_000);
    const cleanup = () => clearTimeout(timer);
    const finish = (r) => { cleanup(); resolve(r); };
    const fail = (e) => { cleanup(); reject(e); };
    
    electron.launch({
      executablePath: electronBinary,
      args: ["."],
      cwd: join(import.meta.dirname, "../.."),
      env: {
        ...process.env,
        DCODE_E2E: "1",
        DCODE_STATE_DIR: stateDir,
        DCODE_VALIDATION_ASSEMBLY: "mock",
        DCODE_VALIDATION_SAMPLE: "1",
      },
    }).then(async (app) => {
      try {
        const page = await app.firstWindow();
        await page.waitForFunction(() => document.body.innerText.length > 20, { timeout: 30_000 });

        const composer = page.locator(".input-surface");
        const textarea = page.locator("textarea");
        await textarea.click();

        const shadows = await page.evaluate(() => {
          const shell = document.querySelector(".input-surface");
          const ta = shell?.querySelector("textarea");
          return {
            shell: shell ? window.getComputedStyle(shell).boxShadow : null,
            textarea: ta ? window.getComputedStyle(ta).boxShadow : null,
          };
        });

        const shellHasFocusBox = shadows.shell && shadows.shell !== "none" && !shadows.shell.includes("0px 0px 0px 0px");
        const taHasFocusBox = shadows.textarea && shadows.textarea.includes("2px inset");

        if (shellHasFocusBox && taHasFocusBox) {
          throw new Error(
            `焦点描边重叠：壳 box-shadow=${shadows.shell}，textarea box-shadow=${shadows.textarea}`
          );
        }

        await app.close().catch(() => {});
        setTimeout(finish, 2000);
      } catch (e) {
        await app.close().catch(() => {});
        setTimeout(() => fail(e), 2000);
      }
    }).catch((e) => fail(e));
  });

  try {
    await procExit;
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
```

### 测试 B：模型配置 UI 缺失

```javascript
// test/e2e/model-config-ui.test.mjs
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { _electron as electron } from "playwright-core";

const require = createRequire(import.meta.url);
const electronBinary = require("electron");

test("模型配置 UI：设置页模型分区应有可交互配置入口", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "dcode-model-ui-"));

  let app;
  try {
    app = await electron.launch({
      executablePath: electronBinary,
      args: ["."],
      cwd: join(import.meta.dirname, "../.."),
      env: {
        ...process.env,
        DCODE_E2E: "1",
        DCODE_STATE_DIR: stateDir,
        DCODE_VALIDATION_ASSEMBLY: "mock",
        DCODE_VALIDATION_SAMPLE: "1",
      },
    });

    const page = await app.firstWindow();
    await page.waitForFunction(() => document.body.innerText.length > 20, { timeout: 30_000 });

    await page.getByRole("button", { name: /^设置/ }).click();
    await page.getByRole("button", { name: /^模型/ }).click();

    const modelSection = page.locator(".min-h-0.flex-1 > div > div");
    const inputs = await modelSection.locator("input").count();
    const buttons = await modelSection.locator("button").all();
    const buttonTexts = await Promise.all(buttons.map((b) => b.textContent()));

    const hasConfigInput = inputs > 0;
    const hasAddButton = buttonTexts.some((t) => /添加|配置|设置/.test(t));

    if (!hasConfigInput && !hasAddButton) {
      throw new Error(
        `模型分区无配置入口：input=${inputs}, buttonTexts=${JSON.stringify(buttonTexts)}`
      );
    }

    await app.close().catch(() => {});
    await new Promise((r) => setTimeout(r, 2000));
  } catch (e) {
    if (app) await app.close().catch(() => {});
    await new Promise((r) => setTimeout(r, 2000));
    throw e;
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
```

---

## 三、新模型实现不可绕过的验收结果

| 验收结果 | 分类 | 说明 |
|----------|------|------|
| **1. 设置页模型分区提供真实配置控件** | 已核→待验 | 源码已确认缺失；实现后需验证：`<input type="url">` 接收端点、`<input type="password">` 接收密钥、`<button>` 触发保存；保存后 `snapshot.model.available` 变为 `true` 且 `snapshot.execution.kind` 不再为 `unavailable` |
| **2. 配置保存后 Composer 发送可用** | 待核 | 正常装配（`DCODE_VALIDATION_ASSEMBLY` 未设置或显式为空）下，输入文字后 `[data-slot="composer-primary"]` 的 `disabled` 属性为 `false`，点击或 Enter 可触发请求 |
| **3. 配置修改期间不中断运行** | 待核 | 若存在运行中的请求，进入设置页修改模型配置并保存后，原请求状态（running/paused）保持，不被重置为 unavailable；返回后可直接暂停或继续 |

**区分说明**：
- 已核：缺陷已由源码审查确认存在
- 待验：缺陷修复后需实际运行验证