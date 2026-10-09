// 正常隔离入口 + 真实设置控件 + 真实文件权限故障；不注入界面快照或更改错误状态。
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, ready, waitForSnapshot, cleanup, killApp } from './helpers.mjs';

const EVIDENCE = join(import.meta.dirname, '../../doc/验证记录/产品自有内容错误补修-2026-10-07', process.env.DCODE_SETTINGS_ERROR_PHASE ?? 'scenario-current');
mkdirSync(EVIDENCE, { recursive: true });

test('设置新失败不能沿用旧忽略：失败→忽略→同类失败，含中间真实成功与无成功的中英连续路径', async () => {
  const handle = await launchApp(undefined, { DCODE_VALIDATION_ASSEMBLY: '', DCODE_VALIDATION_SAMPLE: '0' });
  const evidence = [];
  const failures = [];
  try {
    const { page, stateDir } = handle;
    await ready(page);
    const journalCount = () => page.evaluate(() => window.__settingsErrors.length);
    const waitForSave = async (before, predicate) => {
      await page.waitForFunction(n => window.__settingsErrors.length > n, before);
      return waitForSnapshot(page, predicate);
    };
    const rendered = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    for (const language of ['zh', 'en']) {
      for (const successBetween of [false, true]) {
        chmodSync(stateDir, 0o755);
        // 每条独立顺序重载渲染层以还原未忽略起点；同一 Electron 窗口和数据目录一直复用。
        await page.reload();
        await ready(page);
        await page.getByRole('button', { name: /^设置|^Settings/ }).click();
        await page.evaluate(() => {
          window.__settingsErrors = [];
          window.dcode.onSnapshot(snapshot => window.__settingsErrors.push({ error: snapshot.closeError, revision: snapshot.closeErrorRevision ?? null, settings: snapshot.settings }));
        });
        // 各独立顺序在真实成功的设置值上开始；顺序内部不靠语言切换重置提示。
        let before = await journalCount();
        await page.getByRole('radio', { name: language === 'zh' ? '中文' : 'English', exact: true }).click();
        await waitForSave(before, snapshot => snapshot.settings.language === language);
        const labels = language === 'zh' ? { system: '系统', light: '浅色', dark: '深色', dismiss: '知道了' } : { system: 'System', light: 'Light', dark: 'Dark', dismiss: 'Got it' };
        before = await journalCount();
        await page.getByRole('radiogroup', { name: language === 'zh' ? '主题' : 'Theme' }).getByRole('radio', { name: labels.system, exact: true }).click();
        await waitForSave(before, snapshot => snapshot.settings.theme === 'system');
        const initial = JSON.parse(readFileSync(join(stateDir, 'dcode-prototype-state.json'), 'utf8')).settings;
        const errorText = language === 'zh' ? '设置未能保存，仍使用上次保存的值。请重新选择需要的设置。' : 'Settings could not be saved; the last saved values remain in use. Select your settings again.';
        const notice = page.getByText(errorText, { exact: true });

        chmodSync(stateDir, 0o555);
        before = await journalCount();
        await page.getByRole('radio', { name: labels.light, exact: true }).click();
        const first = await waitForSave(before, snapshot => snapshot.closeError === 'settings-save-failed');
        await notice.waitFor();
        assert.equal(first.settings.theme, 'system');
        assert.deepEqual(JSON.parse(readFileSync(join(stateDir, 'dcode-prototype-state.json'), 'utf8')).settings, initial);
        assert.equal((await page.evaluate(() => window.dcode.getSnapshot())).closeError, 'settings-save-failed', '忽略的是本次设置失败，不能误忽略自动保存的其他错误');
        await page.getByRole('button', { name: labels.dismiss, exact: true }).click();
        assert.equal(await notice.count(), 0, '允许忽略当前这次错误');
        const queried = await page.evaluate(() => Promise.all([window.dcode.getSnapshot(), window.dcode.getSnapshot()]));
        assert.ok(queried.every(snapshot => snapshot.closeErrorRevision === first.closeErrorRevision), '查询不制造新错误事件');
        assert.equal(await notice.count(), 0, '查询不能撤销本次忽略');

        let lastSaved = initial;
        if (successBetween) {
          chmodSync(stateDir, 0o755);
          before = await journalCount();
          await page.getByRole('radio', { name: labels.dark, exact: true }).click();
          const saved = await waitForSave(before, snapshot => snapshot.settings.theme === 'dark' && snapshot.closeError === null);
          lastSaved = JSON.parse(readFileSync(join(stateDir, 'dcode-prototype-state.json'), 'utf8')).settings;
          assert.deepEqual(saved.settings, lastSaved);
          assert.equal(lastSaved.theme, 'dark', '中间成功必须真实落盘');
        }

        chmodSync(stateDir, 0o555);
        before = await journalCount();
        await page.getByRole('radio', { name: labels.light, exact: true }).click();
        const second = await waitForSave(before, snapshot => snapshot.closeError === 'settings-save-failed');
        await rendered();
        const shownAgain = await notice.count() === 1;
        assert.ok(second.closeErrorRevision > first.closeErrorRevision, '同类真实新失败有独立身份');
        const actualSaved = JSON.parse(readFileSync(join(stateDir, 'dcode-prototype-state.json'), 'utf8')).settings;
        assert.deepEqual(actualSaved, lastSaved, '失败不得覆盖最后持久值');
        assert.deepEqual(second.settings, lastSaved, '界面快照仍使用最后持久值');
        const record = { language, successBetween, first, second, lastSaved, shownAgain, events: await page.evaluate(() => window.__settingsErrors) };
        evidence.push(record);
        await page.screenshot({ path: join(EVIDENCE, `repeat-${language}-${successBetween ? 'success-between' : 'no-success'}.png`) });
        if (!shownAgain) failures.push(`${language}/${successBetween ? 'success-between' : 'no-success'}: 同类新失败被旧忽略永久隐藏`);
      }
    }
    assert.deepEqual(failures, [], '每一次新的失败都应重新给出事件、影响和下一步');
  } finally {
    writeFileSync(join(EVIDENCE, 'settings-error-occurrences.json'), JSON.stringify(evidence, null, 2));
    chmodSync(handle.stateDir, 0o755);
    try { await handle.close(); } finally { await killApp(handle); cleanup(handle.stateDir); }
  }
});
