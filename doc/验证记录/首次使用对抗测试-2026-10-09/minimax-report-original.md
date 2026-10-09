
# D Code 独立静态审查报告

## 执行摘要

**核心结论**：用户报告的两个可观察失败均有源码层面根因，且两者互为因果——设置页无模型配置入口导致无法解除发送限制；执行后端设计将正常启动路径设为不可用，与产品规格产生根本性冲突。现有 E2E 测试绿灯系因全部采用测试装配隔离（`DCODE_VALIDATION_ASSEMBLY: "mock"`），未覆盖正常产品通路。

---

## 一、可观察失败的根因定位

### 1.1 直角白框问题

**涉及文件**：`src/renderer/styles.css`（第 39-53 行）

**用户动作**：点击 Composer 输入框

**可观察失败**：输入区域呈现直角白框，而非规格要求的 `rounded-2xl` 圆角

**源码根因**：

```css
/* 第 49-53 行 */
.input-surface:focus-within:not(:focus-visible) {
  border-color: var(--border-strong);
  box-shadow: inset 0 0 0 1px var(--border-strong);
}
```

当容器内子元素（textarea）获得焦点时，`:focus-within` 与 `:focus-visible` 同时匹配，导致 `:not(:focus-visible)` 条件永不成立。**此弱焦点描边规则实际上永不触发**。

容器自身的 `rounded-2xl` 类定义了 `border-radius: 16px`（默认 14px 字号下），但：

| 可能性 | 证据 |
|--------|------|
| A. `bg-input` 类对应的 CSS 变量 `--background` 被渲染为纯白 | styles.css 第 12-14 行未覆盖 `bg-input`，需检查 `bg-input` 来源组件或 CSS 变量定义 |
| B. 容器 `box-shadow` 被意外清除 | 未见明确覆盖，但 `:focus-within:not(:focus-visible)` 规则意图提供"壳内子元素持焦"时的替代反馈；由于上述 bug，壳在子元素持焦时仅继承子元素样式 |

**静态确认**：CSS 逻辑错误（`:not(:focus-visible)` 在子元素持焦时永远为 `false`）属源码级缺陷。

### 1.2 正常模型页无添加入口

**涉及文件**：`src/renderer/views/SettingsPage.tsx`（第 105-116 行）

**用户动作**：导航至设置页 → 点击「模型」分区

**可观察失败**：仅展示 Badge 状态显示，无任何输入控件

**源码根因**：

```tsx
// 第 105-116 行（模型分区内容）
{!model.available && (
  <p className="text-ui-sm text-subtle">
    {t("settings.modelMissingBody")}
  </p>
)}
<div className="rounded-xl border border-border bg-card px-4">
  <SettingsRow
    label={t("settings.modelRow")}
    hint={model.available ? t("settings.modelRowHintConfigured", ...) : t("settings.modelRowHintEmpty")}
  >
    <Badge tone={model.available ? "success" : "warning"}>
      {t(model.available ? "settings.modelConfigured" : "settings.modelMissing")}
    </Badge>
  </SettingsRow>
</div>
```

**规格冲突**：

| 规格引用 | 要求 | 实现现状 |
|----------|------|----------|
| `spec/页面与交互组件.md` S07 | 提供模型配置输入；不提供假表单解锁 | 无任何输入字段 |
| `spec/冷启动与草稿态.md` | 缺模型配置时提供设置入口；配置后内联提示自动消失 | 无设置入口 |

`model` 对象仅暴露 `available` 和 `name` 两个只读属性，无任何修改路径。

---

## 二、执行后端架构与测试覆盖缺口

### 2.1 assembly.ts 的设计意图

```typescript
// 第 10-12 行
const unavailable: ExecutionBackend = {
  kind: "unavailable", modelName: null,
  async open() { throw new Error("execution-unavailable"); },
};
// 第 13-20 行
const backend = selection === "pi-controlled"
  ? createPiBackend({...})
  : selection === "mock"
    ? new MockExecutionBackend({...})
    : unavailable;  // ← 正常启动走此分支
```

**设计问题**：正常启动（无 `DCODE_VALIDATION_ASSEMBLY` 环境变量）时执行后端为 `unavailable`。这意味着：

1. 用户即使手动提供配置，也无法通过任何产品内路径将配置与执行后端绑定
2. 规格要求"配置保存并满足必要配置要求后，内联提示自动消失"——但保存后仍然不可用

### 2.2 E2E 测试的验证盲区

**helpers.mjs 第 59-62 行**：
```javascript
env: {
  ...
  DCODE_VALIDATION_ASSEMBLY: "mock",  // ← 所有测试强制使用 mock
  DCODE_VALIDATION_SAMPLE: "1",
```

**验证缺口矩阵**：

| 场景 | 规格要求 | E2E 覆盖 | 产品实际 |
|------|----------|----------|----------|
| 正常启动（无 env） | 应能配置并使用模型 | ❌ | 后端 unavailable |
| mock 装配下发送 | 验证发送逻辑 | ✅ | 仅测试隔离内有效 |
| 设置页模型配置 UI | S07 要求配置入口 | ❌ | **不存在** |
| 缺字段时保存失败 | 规格要求区分状态 | ❌ | 无法触发（无表单） |
| URL 无效时认证失败 | 规格要求 | ❌ | 无法触发 |
| 密钥不返回/不回传 | 规格要求 | ❌ | 无法触发 |
| 配置修改后不解暂停 | 规格要求 | ❌ | 无法触发 |

---

## 三、最小可执行 E2E 反例

以下测试**不使用任何测试装配**，验证正常产品通路：

```javascript
// test/e2e/normal-product-path.test.mjs
// 最小可执行反例：正常无预置模型 → 添加真实配置 → 保存 → 发出原始请求 → 正文 → 重开

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright-core';

test('正常产品通路：设置页应有模型配置入口，配置后发送可用', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dcode-normal-'));
  const require = createRequire(import.meta.url);
  const electronBinary = require('electron');
  
  // 关键：不设置 DCODE_VALIDATION_ASSEMBLY，使用正常产品启动
  const app = await electron.launch({
    executablePath: electronBinary,
    args: ['.'],
    cwd: join(import.meta.dirname, '../..'),
    env: {
      ...process.env,
      DCODE_E2E: '1',
      DCODE_STATE_DIR: stateDir,
      NODE_ENV: 'production',
    },
  });

  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => document.body.innerText.length > 20, { timeout: 30_000 });
    
    // Step 1: 验证正常启动状态
    const initSnap = await page.evaluate(() => window.dcode.getSnapshot());
    assert.equal(initSnap.execution.kind, 'unavailable', 
      '正常启动 execution 应为 unavailable');
    assert.equal(initSnap.model.available, false,
      '正常启动 model 应不可用');
    
    // Step 2: 尝试导航到设置页 → 模型分区
    await page.getByRole('button', { name: /^设置/ }).click();
    await page.getByRole('button', { name: /^模型/ }).click();
    
    // Step 3: 验证模型配置入口存在（当前会失败——入口不存在）
    // 根据 S07，应有表单字段；根据 spec/冷启动与草稿态.md，应有添加入口
    const modelSection = page.locator('section, div').filter({ hasText: /模型/ }).last();
    const inputCount = await modelSection.locator('input, textarea, select').count();
    const buttonCount = await modelSection.locator('button').count();
    
    // 【反例断言】模型分区应有配置输入控件或添加入口
    assert.ok(
      inputCount > 0 || buttonCount.some(b => b.getByText(/添加|配置|设置/)), 
      `模型分区应有配置入口（当前 input=${inputCount}, 相关按钮=${buttonCount}）`
    );
    
    // Step 4: 若入口存在，验证配置保存流程
    // ...（根据实际 UI 结构调整）
    
    // Step 5: 验证 Composer 发送状态
    const composer = page.getByPlaceholder('交代需求、提问或粘贴内容…');
    await composer.fill('测试请求正文');
    const sendBtn = page.locator('[data-slot="composer-primary"]');
    assert.equal(await sendBtn.isDisabled(), !initSnap.model.available,
      '模型不可用时发送按钮应禁用');
    
  } finally {
    await app.close();
    await new Promise(r => setTimeout(r, 2000)); // 等待进程退出
    try { rmSync(stateDir, { recursive: true }); } catch {}
  }
});

test('配置修改不解暂停：修改模型配置时不应中断运行', async () => {
  // 前提：先有可运行的 mock 或 pi 后端
  // 当前产品通路无任何执行后端，此测试无法执行
  // 但若未来提供配置入口，应验证：
  // 1. 运行中进入设置页
  // 2. 修改模型配置（不改运行状态）
  // 3. 返回时运行继续，不被暂停
});

test('缺字段/无效URL/认证失败处理', async () => {
  // 当前无配置入口，无法触发保存逻辑
  // 应有：
  // - 缺少必填字段时保存按钮禁用或报错
  // - URL 格式错误时即时提示
  // - 认证失败时不显示"配置成功"
});
```

**运行方式**：
```bash
node test/e2e/normal-product-path.test.mjs
```

**预期结果**：第一个测试在 Step 3 处失败，因为模型分区无配置入口。

---

## 四、源码确证（无需运行）

| 缺陷 | 文件:行号 | 确证方式 |
|------|-----------|----------|
| `:focus-within:not(:focus-visible)` 逻辑错误 | `styles.css:49-53` | 静态 CSS 选择器分析 |
| 模型配置 UI 完全缺失 | `SettingsPage.tsx:105-116` | 组件结构审查 |
| 正常启动后端为 unavailable | `assembly.ts:22` | 代码逻辑分析 |
| 测试全部使用 mock 隔离 | `helpers.mjs:59` | 环境变量硬编码 |
| `assertValidationModel` 仅验证测试装配 | `helpers.mjs:95-98` | 函数实现审查 |
| Composer `unconfigured` 逻辑错误 | `Composer.tsx:131` | `Boolean(disabled)` 永为 false（disabled 默认 undefined） |

---

## 五、为何 E2E 绿灯不能证明产品可用

**结构性原因**：

1. **测试隔离假象**：`DCODE_VALIDATION_ASSEMBLY: "mock"` 将测试环境与正常产品环境完全隔离。测试验证的是"mock 后端存在且行为正确"，而非"用户能在产品中配置并使用模型"。

2. **入口覆盖缺失**：现有测试不覆盖设置页模型配置流程（因为该流程不存在）。`style-geometry.test.mjs` 使用 `assertValidationModel` 跳过正常配置流程，直接注入测试模型。

3. **状态空间截断**：测试假设执行后端状态空间为 `{unavailable, mock, pi-controlled}`，但产品应支持用户通过 UI 配置任意后端。当前状态机缺少用户配置路径。

4. **规格与实现脱节**：`spec/页面与交互组件.md` S07 明确要求"提供模型配置输入"，但实现中无此 UI，导致测试无法验证规格符合性。

**类比**：在汽车碰撞测试中使用特制"无敌车辆"通过测试，然后声称汽车安全——但正常用户购买的汽车没有安全气囊。

---

## 六、建议行动项

| 优先级 | 项目 | 涉及文件 |
|--------|------|----------|
| P0 | 实现设置页模型配置入口（满足 S07） | `SettingsPage.tsx` |
| P0 | 修复 `input-surface` 焦点样式逻辑 | `styles.css` |
| P0 | 设计正常启动时的执行后端路径 | `assembly.ts` + 相关后端模块 |
| P1 | 添加正常产品通路的 E2E 测试（不使用 mock） | 新增测试文件 |
| P1 | 验证缺字段/URL/认证失败的错误处理 | 相关表单组件 |
| P2 | 修复 Composer `unconfigured` 逻辑 | `Composer.tsx` |
| P2 | 验证配置修改后不解暂停行为 | 运行状态管理模块 |