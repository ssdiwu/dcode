import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSync } from 'esbuild';
import { launchApp, ready, cleanup, killApp } from './helpers.mjs';
import { evidenceDir } from "./evidence-root.mjs";

const EVIDENCE = evidenceDir("product-owned-content");
mkdirSync(EVIDENCE, { recursive: true });
const normal = { DCODE_VALIDATION_ASSEMBLY: '', DCODE_VALIDATION_SAMPLE: '0' };
const forbidden = /原型|模拟执行|真实 Pi|控制令牌|同一身份|几何.*派生|prototype|No Pi|Real Pi|control token|same identity|interface geometry|Electron \+ React|0\.0\.0|0\.1\.0/i;

test('正常入口双语内容与标题干净；隐藏不解锁；macOS 标题避开原生窗控', async () => {
  const handle = await launchApp(undefined, normal);
  const evidence = [];
  try {
    const { page, app } = handle;
    await ready(page);
    const host = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      return { platform: process.platform, visible: w.isVisible(), focusable: w.isFocusable(), focused: w.isFocused(), title: w.getTitle(), nativeButtons: process.platform === "darwin" ? w.getWindowButtonPosition() : null };
    });
    assert.deepEqual([host.visible, host.focusable, host.focused], [false, false, false]);
    assert.equal(host.title, 'D Code');
    assert.equal(await page.title(), 'D Code');
    for (const language of ['zh', 'en']) {
      await page.evaluate(lang => window.dcode.updateSettings({ language: lang }), language);
      await page.getByRole('heading', { name: language === 'zh' ? '开始一项新工作' : 'Start new work' }).waitFor();
      const draft = page.locator('textarea');
      await draft.fill('我的 Pi prototype 原文不能被改写');
      await draft.press('Enter');
      assert.equal(await draft.inputValue(), '我的 Pi prototype 原文不能被改写');
      assert.equal(await page.locator('[data-slot="composer-primary"]').isDisabled(), true);
      assert.doesNotMatch(await page.locator('body').innerText(), forbidden);
      await page.getByRole('button', { name: language === 'zh' ? /^设置/ : /^Settings/ }).click();
      const sections = language === 'zh' ? ['外观', '启动', '模型', '关于'] : ['Appearance', 'Startup', 'Model', 'About'];
      for (const section of sections) {
        await page.getByRole('button', { name: new RegExp(`^${section}`) }).click();
        assert.doesNotMatch(await page.locator('body').innerText(), forbidden);
        if (section === '模型' || section === 'Model') {
          // 添加/编辑服务商是合法入口；密钥框在「自定义」页签，密码框必须为空、hosted key 不回显
          await page.getByRole('radio', { name: language === 'zh' ? /^自定义$/ : /^Custom$/ }).click();
          const pw = page.locator('input[type="password"]');
          assert.equal(await pw.count(), 1, '自定义页签应有且仅有一个密钥输入');
          assert.equal(await pw.inputValue(), '');
        } else {
          assert.equal(await page.locator('input[type="password"]').count(), 0);
        }
      }
      await page.keyboard.press('Escape');
      assert.equal(await draft.inputValue(), '我的 Pi prototype 原文不能被改写');
      for (const width of [720, 1440]) {
        await app.evaluate(({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0].setContentSize(w, 600), width);
        const rect = await page.locator('.app-brand span').evaluate(el => {
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height, sidebarRight: el.closest('nav').getBoundingClientRect().right, platform: document.documentElement.dataset.platform };
        });
        assert.ok(rect.width > 0 && rect.height > 0 && rect.right <= rect.sidebarRight);
        if (host.platform === 'darwin') {
          assert.equal(rect.platform, 'darwin');
          assert.ok(rect.x >= 80, 'D Code 标题不得进入原生窗控安全区域');
          assert.ok(rect.bottom <= 48);
        }
        evidence.push({ language, width, host, rect });
      }
      await page.screenshot({ path: join(EVIDENCE, `normal-${language}.png`) });
      const state = await page.evaluate(() => window.dcode.getSnapshot());
      assert.equal(state.execution.kind, 'unavailable');
      assert.deepEqual(state.model, { available: false, name: null });
      assert.equal(state.tasks.length, 1);
      assert.deepEqual(state.sessions, []);
      assert.deepEqual(state.timelines, {});
    }
    writeFileSync(join(EVIDENCE, 'normal-layout.json'), JSON.stringify(evidence, null, 2));
  } finally { try { await handle.close(); } finally { await killApp(handle); cleanup(handle.stateDir); } }
});

test('旧数据、草稿关联、用户/工具原文跨双语及真实重开完整；旧假配置不能执行', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dcode-content-legacy-'));
  const output = buildSync({ entryPoints: [join(import.meta.dirname, '../../src/adapters/mock/sample-state.ts')], bundle: true, platform: 'node', format: 'esm', write: false });
  const { sampleState } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
  const old = sampleState();
  old.model = { configured: true, label: 'old-label-not-a-model', simulated: true };
  const originalUser = '用户原文：prototype、模拟、Pi、storage 不应过滤';
  const originalTool = '工具原文：Real Pi / control token / storage / 原型';
  old.timelines['session-home-1'].push(
    { kind: 'message', id: 'later-user-input', role: 'user', text: originalUser, streaming: false, at: 1, operationId: 'old-unknown', mode: 'steer', receipt: { status: 'unknown', operationId: 'old-unknown', reason: 'storage-unavailable' } },
    { kind: 'tool', id: 'later-real-tool', tool: { name: 'read', primaryText: 'original tool', output: originalTool, status: 'failed', changedFiles: [] }, at: 2 },
  );
  old.pendingFirstSends = { 'task-home-default': { sessionId: 'session-home-1', operationId: 'old-unknown', text: originalUser, mode: 'steer' } };
  writeFileSync(join(dir, 'dcode-prototype-state.json'), JSON.stringify(old));
  let current = await launchApp(dir, normal);
  let primary = null;
  try {
    await ready(current.page);
    await current.page.getByRole('button', { name: /聊聊下个季度的规划/ }).click();
    await current.page.getByRole('button', { name: '新会话' }).waitFor();
    const oldUi = await current.page.evaluate(({ originalUser }) => {
      const key = 'dcode-prototype-ui-v1';
      const ui = JSON.parse(localStorage.getItem(key));
      const draftKey = 'session-home-1';
      ui.drafts[draftKey] = originalUser;
      ui.draftOfOperation['old-unknown'] = draftKey;
      ui.operationOfDraft[draftKey] = { operationId: 'old-unknown', text: originalUser, mode: 'steer' };
      ui.unknownOps = ['old-unknown'];
      localStorage.setItem(key, JSON.stringify(ui));
      return ui;
    }, { originalUser });
    await current.page.reload();
    for (const language of ['zh', 'en']) {
      await current.page.evaluate(lang => window.dcode.updateSettings({ language: lang }), language);
      await current.page.getByRole('button', { name: language === 'zh' ? '新会话' : 'New session' }).waitFor();
      await current.page.getByRole('paragraph').filter({ hasText: originalUser }).waitFor();
      await current.page.getByText(originalTool, { exact: true }).waitFor();
      assert.equal(await current.page.locator('textarea').inputValue(), originalUser);
      await current.page.locator('textarea').press('Enter');
      const snapshot = await current.page.evaluate(() => window.dcode.getSnapshot());
      for (const field of ['workspaces', 'tasks', 'sessions', 'timelines']) assert.deepEqual(snapshot[field], old[field]);
      const ui = await current.page.evaluate(() => JSON.parse(localStorage.getItem('dcode-prototype-ui-v1')));
      // C05 迁移：旧现场的操作身份、原文、用途与草稿关联**承接**，只是归一成完整草稿版本；
      // 清掉旧关联会让那次待核对的发送失去归属，这里按承接后的形状逐项断言。
      assert.deepEqual(ui.operationOfDraft, {
        'session-home-1': {
          operationId: oldUi.operationOfDraft['session-home-1'].operationId,
          version: {
            text: originalUser,
            mode: oldUi.operationOfDraft['session-home-1'].mode,
            referenceSetId: '[]',
          },
        },
      });
      assert.deepEqual(ui.draftOfOperation, oldUi.draftOfOperation);
      assert.deepEqual(ui.unknownOps, oldUi.unknownOps);
      assert.doesNotMatch(await current.page.locator('nav').innerText(), forbidden);
      assert.doesNotMatch(await current.page.locator('main header').innerText(), forbidden);
      await current.page.screenshot({ path: join(EVIDENCE, `legacy-${language}.png`) });
    }
    await current.close();
    const persisted = JSON.parse(readFileSync(join(dir, 'dcode-prototype-state.json'), 'utf8'));
    assert.deepEqual(persisted.pendingFirstSends, old.pendingFirstSends);
    assert.deepEqual(persisted.model, old.model);
    current = await launchApp(dir, normal);
    await ready(current.page);
    await current.page.getByRole('button', { name: 'New session' }).waitFor();
    assert.equal(await current.page.locator('textarea').inputValue(), originalUser);
    assert.deepEqual((await current.page.evaluate(() => window.dcode.getSnapshot())).timelines, old.timelines);
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    // 收束错误不能覆盖较早业务断言；两者都失败时保留各自原错误与位置。
    try { await current.close(); } catch (error) {
      if (primary && primary !== error) throw new AggregateError([primary, error], '旧数据业务与退出同时失败');
      throw error;
    } finally { await killApp(current); cleanup(dir); }
  }
});

test('渲染失败页双语说明真实影响和下一步，不展示底层错误正文', async () => {
  const handle = await launchApp(undefined, normal);
  try {
    const { page } = handle;
    await ready(page);
    await page.evaluate(() => window.dcode.createTask({ workspaceId: 'ws-home', parentId: null, title: '__controlled_render_failure__' }));
    await page.addInitScript(() => {
      const find = Array.prototype.find;
      Array.prototype.find = function (...args) {
        if (this.some(item => item?.title === '__controlled_render_failure__')) throw new Error('internal session-id storage secret-content');
        return Reflect.apply(find, this, args);
      };
    });
    await page.reload();
    for (const language of ['zh', 'en']) {
      await page.evaluate(lang => window.dcode.updateSettings({ language: lang }), language);
      const alert = page.getByRole('alert');
      await alert.getByText(language === 'zh' ? /工作界面无法显示/ : /workspace could not be displayed/).waitFor();
      const text = await alert.innerText();
      assert.doesNotMatch(text, /internal|session-id|storage|secret-content|prototype|原型/);
      assert.match(text, language === 'zh' ? /关闭后重新打开.*已保存/ : /Close and reopen.*saved/);
      await page.screenshot({ path: join(EVIDENCE, `render-error-${language}.png`) });
    }
  } finally { try { await handle.close(); } finally { await killApp(handle); cleanup(handle.stateDir); } }
});
