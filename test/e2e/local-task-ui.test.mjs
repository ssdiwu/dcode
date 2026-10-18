// 本地首路径的界面意图：空间新工作与命名任务分开；父任务草稿不提前建对象；
// 任务名称行进入主会话，展开箭头只改变树，不抢当前会话。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp, cleanup, ready } from './helpers.mjs';
import { evidenceDir } from './evidence-root.mjs';

const uiState = page => page.evaluate(() => JSON.parse(localStorage.getItem('dcode-prototype-ui-v1') ?? '{}'));

async function openLongTaskDialog(page) {
  const workspace = page.getByRole('treeitem', { name: 'D Code' });
  await workspace.hover();
  await workspace.getByRole('button', { name: '在此空间新建任务' }).click();
  await page.getByRole('menuitem', { name: '新建长期任务' }).click();
  await page.getByRole('dialog', { name: '新建长期任务' }).waitFor();
  return page.getByRole('dialog', { name: '新建长期任务' });
}

test('空间与父任务草稿保留各自文字；主会话导航与成员展开分离', async () => {
  const { page, stateDir, close } = await launchApp();
  try {
    await ready(page);
    const before = await page.evaluate(() => window.dcode.getSnapshot());
    const dcode = page.getByRole('treeitem', { name: 'D Code' });
    await dcode.hover();
    await dcode.getByRole('button', { name: '在此空间新建任务' }).click();
    await page.getByRole('menuitem', { name: '新工作草稿' }).click();
    await page.getByRole('heading', { name: '开始一项新工作' }).waitFor();
    await page.getByText('D Code / 默认任务', { exact: true }).waitFor();
    const composer = page.getByPlaceholder('交代需求、提问或粘贴内容…');
    await composer.fill('空间直属的新工作原稿');

    // 默认长期任务的“＋”也能建立带父归属的草稿，发送前不创建正式任务。
    const defaultTask = page.locator('[data-workspace-id="ws-home"] [data-task-id="task-home-default"]');
    await defaultTask.hover();
    await defaultTask.getByRole('button', { name: '新建短期任务' }).click();
    await page.getByText('Home / 默认任务 / 新建短期任务', { exact: true }).waitFor();
    await composer.fill('默认任务下的短期工作原稿');
    await page.setViewportSize({ width: 720, height: 480 });
    const frameDir = evidenceDir('local-task-ui', 'frames');
    mkdirSync(frameDir, { recursive: true });
    await page.screenshot({ path: join(frameDir, 'parent-draft-720.png') });
    const geometry = await page.evaluate(() => {
      const sidebar = document.querySelector('nav')?.getBoundingClientRect();
      const main = document.querySelector('main')?.getBoundingClientRect();
      const input = document.querySelector('textarea')?.getBoundingClientRect();
      return { sidebar: sidebar && [sidebar.left, sidebar.right], main: main && [main.left, main.right], input: input && [input.left, input.right], bodyWidth: document.body.scrollWidth };
    });
    assert.ok(geometry.sidebar && geometry.main && geometry.input, '窄窗的侧栏、主区与输入均实际渲染');
    assert.ok(geometry.sidebar[1] <= geometry.main[0] + 1, '侧栏与主区不重叠');
    assert.ok(geometry.input[0] >= geometry.main[0] && geometry.input[1] <= geometry.main[1], '输入保持在主区内');
    assert.ok(geometry.bodyWidth <= 720, '工作台不产生整窗横向溢出');
    const uncommitted = await page.evaluate(() => window.dcode.getSnapshot());
    assert.equal(uncommitted.tasks.length, before.tasks.length, '只打开和编辑父任务草稿不创建任务');
    assert.equal(uncommitted.sessions.length, before.sessions.length, '只打开和编辑父任务草稿不创建会话');

    await dcode.hover();
    await dcode.getByRole('button', { name: '在此空间新建任务' }).click();
    await page.getByRole('menu').waitFor();
    await page.screenshot({ path: join(frameDir, 'workspace-create-menu-720.png') });
    const menuBounds = await page.getByRole('menu').evaluate(element => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    });
    assert.ok(menuBounds.left >= 0 && menuBounds.right <= 720 && menuBounds.top >= 0 && menuBounds.bottom <= 480, '窄窗创建菜单完整可见');
    await page.getByRole('menuitem', { name: '新工作草稿' }).click();
    await page.getByText('D Code / 默认任务', { exact: true }).waitFor();
    assert.equal(await composer.inputValue(), '空间直属的新工作原稿', '空间草稿不被父任务草稿覆盖');
    await defaultTask.hover();
    await defaultTask.getByRole('button', { name: '新建短期任务' }).click();
    await page.getByText('Home / 默认任务 / 新建短期任务', { exact: true }).waitFor();
    assert.equal(await composer.inputValue(), '默认任务下的短期工作原稿', '回到原父任务草稿保留原文');

    // 显式建立测试成员，令它比主会话更新；任务名称行仍须进入主会话。
    const member = await page.evaluate(() => window.dcode.createSession({ taskId: 'task-readme' }));
    const readmeTask = page.getByRole('treeitem', { name: '整理读书笔记' });
    await readmeTask.click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('dcode-prototype-ui-v1') ?? '{}').selectedSessionId === 'session-readme-1');
    assert.equal((await uiState(page)).selectedSessionId, 'session-readme-1');
    assert.equal(await page.getByRole('treeitem', { name: '《设计中的设计》摘抄' }).count(), 0, '主会话不重复列在成员层');

    const expand = readmeTask.getByRole('button', { name: '展开「整理读书笔记」' });
    await expand.click();
    await page.getByRole('treeitem', { name: member.title }).waitFor();
    assert.equal((await uiState(page)).selectedSessionId, 'session-readme-1', '展开不切换会话');
    await page.getByRole('treeitem', { name: member.title }).click();
    await page.waitForFunction(id => JSON.parse(localStorage.getItem('dcode-prototype-ui-v1') ?? '{}').selectedSessionId === id, member.id);
    await page.getByPlaceholder('交代需求、提问或粘贴内容…').fill('成员会话的实际新历史');
    await page.getByPlaceholder('交代需求、提问或粘贴内容…').press('Enter');
    await page.getByText('成员会话的实际新历史', { exact: true }).first().waitFor();
    await readmeTask.click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('dcode-prototype-ui-v1') ?? '{}').selectedSessionId === 'session-readme-1');
    await dcode.hover();
    await dcode.getByRole('button', { name: '在此空间新建任务' }).click();
    await page.getByRole('menuitem', { name: '新工作草稿' }).click();
    await page.getByText('D Code / 默认任务', { exact: true }).waitFor();
    assert.equal(await page.locator('main section button').filter({ hasText: 'Home / 整理读书笔记' }).count(), 1, '近期入口每任务只出现一次，取其最新会话');
  } finally {
    await close();
    cleanup(stateDir);
  }
});

test('父任务草稿经设置往返与冷重开仍保留原文和父归属', async () => {
  const first = await launchApp();
  const { stateDir } = first;
  try {
    await ready(first.page);
    const before = await first.page.evaluate(() => window.dcode.getSnapshot());
    const defaultTask = first.page.locator('[data-workspace-id="ws-home"] [data-task-id="task-home-default"]');
    await defaultTask.hover();
    await defaultTask.getByRole('button', { name: '新建短期任务' }).click();
    await first.page.getByText('Home / 默认任务 / 新建短期任务', { exact: true }).waitFor();
    await first.page.getByPlaceholder('交代需求、提问或粘贴内容…').fill('重开后仍在默认任务之下');
    await first.page.getByRole('button', { name: /^设置/ }).click();
    await first.page.getByRole('button', { name: '返回' }).click();
    await first.page.getByText('Home / 默认任务 / 新建短期任务', { exact: true }).waitFor();
    assert.equal(await first.page.getByPlaceholder('交代需求、提问或粘贴内容…').inputValue(), '重开后仍在默认任务之下');
    await first.close();

    const reopened = await launchApp(stateDir);
    try {
      await ready(reopened.page);
      await reopened.page.getByText('Home / 默认任务 / 新建短期任务', { exact: true }).waitFor();
      assert.equal(await reopened.page.getByPlaceholder('交代需求、提问或粘贴内容…').inputValue(), '重开后仍在默认任务之下');
      const after = await reopened.page.evaluate(() => window.dcode.getSnapshot());
      assert.equal(after.tasks.length, before.tasks.length, '草稿恢复没有预建正式任务');
      assert.equal(after.sessions.length, before.sessions.length, '草稿恢复没有预建主会话');
      await reopened.page.getByPlaceholder('交代需求、提问或粘贴内容…').press('Enter');
      await reopened.page.getByText('重开后仍在默认任务之下', { exact: true }).first().waitFor();
      await reopened.page.getByText('已接收', { exact: true }).first().waitFor();
      const accepted = await reopened.page.evaluate(() => window.dcode.getSnapshot());
      const children = accepted.tasks.filter(task => task.parentId === 'task-home-default' && task.kind === 'short');
      assert.equal(children.length, 1, '首次发送只建立一个归属默认长期任务的短期任务');
      assert.equal(accepted.tasks.length, before.tasks.length + 1, '首次发送不另建空间根任务');
      const childSessions = accepted.sessions.filter(session => session.taskId === children[0].id && session.kind === 'main');
      assert.equal(childSessions.length, 1, '新短期任务只有一个主会话');
      assert.ok((accepted.timelines[childSessions[0].id] ?? []).some(block => block.kind === 'message' && block.role === 'user' && block.text === '重开后仍在默认任务之下'), '原文进入该子任务主会话');
    } finally { await reopened.close(); }
  } finally {
    await first.close();
    cleanup(stateDir);
  }
});

test('命名任务等待保存；确定失败保留名称；已保存但回执丢失按原身份冷重开查回', async () => {
  const first = await launchApp();
  const { page, app, stateDir } = first;
  try {
    await ready(page);
    await app.evaluate(({ ipcMain }) => {
      const original = ipcMain._invokeHandlers.get('dcode:op');
      const gate = { mode: 'hold-fail', release: null, calls: 0 };
      globalThis.__dcodeTaskUiGate = gate;
      ipcMain._invokeHandlers.set('dcode:op', async (...args) => {
        if (args[1] !== 'createTask') return original(...args);
        gate.calls += 1;
        if (gate.mode === 'hold-fail') {
          await new Promise(resolve => { gate.release = resolve; });
          gate.mode = 'pass';
          throw new Error('task-create-save-failed');
        }
        if (gate.mode === 'hold-success') {
          await new Promise(resolve => { gate.release = resolve; });
          gate.mode = 'pass';
          return original(...args);
        }
        if (gate.mode === 'blocked') {
          gate.mode = 'pass';
          throw new Error('task-create-blocked');
        }
        if (gate.mode === 'save-unknown') {
          gate.mode = 'pass';
          await original(...args);
          throw new Error('task-create-unknown');
        }
        return original(...args);
      });
    });

    const before = await page.evaluate(() => window.dcode.getSnapshot());
    const dialog = await openLongTaskDialog(page);
    await dialog.getByLabel('任务名称').fill('确定失败后重试');
    await dialog.getByRole('button', { name: '创建' }).click();
    await dialog.getByRole('button', { name: '正在保存…' }).waitFor();
    assert.equal(await dialog.getByLabel('任务名称').inputValue(), '确定失败后重试', '保存中名称未被清掉');
    assert.equal(await dialog.getByRole('button', { name: '正在保存…' }).isDisabled(), true, '保存中防止同次重复点击');
    assert.equal((await page.evaluate(() => window.dcode.getSnapshot())).tasks.length, before.tasks.length, '回执未到前不显示已建任务');
    await app.evaluate(() => globalThis.__dcodeTaskUiGate.release());
    await dialog.getByRole('alert').getByText('长期任务未能保存', { exact: false }).waitFor();
    assert.equal(await dialog.getByLabel('任务名称').inputValue(), '确定失败后重试', '确认失败仍保留原名称');
    await page.setViewportSize({ width: 720, height: 480 });
    const frameDir = evidenceDir('local-task-ui', 'frames');
    mkdirSync(frameDir, { recursive: true });
    await page.screenshot({ path: join(frameDir, 'task-save-failed-720.png') });
    const dialogBounds = await dialog.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    });
    assert.ok(dialogBounds.left >= 0 && dialogBounds.right <= 720 && dialogBounds.top >= 0 && dialogBounds.bottom <= 480, '窄窗失败反馈与操作完整可见');
    await dialog.getByRole('button', { name: '创建' }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.getByText('D Code / 确定失败后重试', { exact: true }).waitFor();
    const afterRetry = await page.evaluate(() => window.dcode.getSnapshot());
    const retried = afterRetry.tasks.filter(task => task.title === '确定失败后重试');
    assert.equal(retried.length, 1, '确认失败后重试只保存一个长期任务');
    assert.equal(afterRetry.sessions.filter(session => session.taskId === retried[0].id && session.kind === 'main').length, 1, '正式创建伴随唯一主会话');

    await app.evaluate(() => { globalThis.__dcodeTaskUiGate.mode = 'hold-success'; });
    const inFlightDialog = await openLongTaskDialog(page);
    await inFlightDialog.getByLabel('任务名称').fill('在途关闭仍保存');
    await inFlightDialog.getByRole('button', { name: '创建' }).click();
    await inFlightDialog.getByRole('button', { name: '正在保存…' }).waitFor();
    await inFlightDialog.getByRole('button', { name: '取消' }).click();
    await inFlightDialog.waitFor({ state: 'hidden' });
    await page.getByText('D Code / 确定失败后重试', { exact: true }).waitFor();
    await app.evaluate(() => globalThis.__dcodeTaskUiGate.release());
    await page.waitForFunction(async () => (await window.dcode.getSnapshot()).tasks.some(task => task.title === '在途关闭仍保存'));
    await page.getByText('D Code / 确定失败后重试', { exact: true }).waitFor();
    await page.getByRole('button', { name: '核对任务保存结果' }).click();
    const lateDialog = page.getByRole('dialog', { name: '新建长期任务' });
    assert.equal(await lateDialog.getByLabel('任务名称').inputValue(), '在途关闭仍保存');
    await lateDialog.getByRole('button', { name: '核对任务保存结果' }).click();
    await lateDialog.waitFor({ state: 'hidden' });
    await page.getByText('D Code / 在途关闭仍保存', { exact: true }).waitFor();

    await app.evaluate(() => { globalThis.__dcodeTaskUiGate.mode = 'blocked'; });
    const blockedDialog = await openLongTaskDialog(page);
    await blockedDialog.getByLabel('任务名称').fill('另一项待核阻断');
    await blockedDialog.getByRole('button', { name: '创建' }).click();
    await blockedDialog.getByRole('alert').getByText('另一项任务的保存结果尚待核对', { exact: false }).waitFor();
    assert.equal(await blockedDialog.getByLabel('任务名称').inputValue(), '另一项待核阻断');
    assert.equal(await blockedDialog.getByRole('button', { name: '创建' }).isDisabled(), true, '被另一项保存挡住时不反复自动创建');
    await blockedDialog.getByRole('button', { name: '取消' }).click();
    await page.getByRole('button', { name: '核对任务保存结果' }).click();
    const blockedReadback = page.getByRole('dialog', { name: '新建长期任务' });
    await blockedReadback.getByRole('button', { name: '核对任务保存结果' }).click();
    await blockedReadback.getByRole('alert').getByText('已确认任务没有创建', { exact: false }).waitFor();
    await blockedReadback.getByRole('button', { name: '创建' }).click();
    await blockedReadback.waitFor({ state: 'hidden' });
    await page.getByText('D Code / 另一项待核阻断', { exact: true }).waitFor();

    await app.evaluate(() => { globalThis.__dcodeTaskUiGate.mode = 'save-unknown'; });
    const unknownDialog = await openLongTaskDialog(page);
    await unknownDialog.getByLabel('任务名称').fill('回执丢失查回');
    await unknownDialog.getByRole('button', { name: '创建' }).click();
    await unknownDialog.getByRole('alert').getByText('尚未确认任务创建结果', { exact: false }).waitFor();
    assert.equal(await unknownDialog.getByLabel('任务名称').inputValue(), '回执丢失查回');
    assert.equal(await unknownDialog.getByLabel('任务名称').isDisabled(), true, '未知时锁定原创建意图');
    const afterLostReply = await page.evaluate(() => window.dcode.getSnapshot());
    const createdUnknown = afterLostReply.tasks.filter(task => task.title === '回执丢失查回');
    assert.equal(createdUnknown.length, 1, '模拟丢失外层回执时应用确已保存对象');
    await unknownDialog.getByRole('button', { name: '取消' }).click();
    await unknownDialog.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '核对任务保存结果' }).waitFor();
    await first.close();

    const reopened = await launchApp(stateDir);
    try {
      await ready(reopened.page);
      await reopened.page.getByRole('button', { name: '核对任务保存结果' }).click();
      const resumedDialog = reopened.page.getByRole('dialog', { name: '新建长期任务' });
      assert.equal(await resumedDialog.getByLabel('任务名称').inputValue(), '回执丢失查回', '冷重开保留同次名称供只读查回');
      await resumedDialog.getByRole('button', { name: '核对任务保存结果' }).click();
      await resumedDialog.waitFor({ state: 'hidden' });
      await reopened.page.getByText('D Code / 回执丢失查回', { exact: true }).waitFor();
      const lookedUp = await reopened.page.evaluate(() => window.dcode.getSnapshot());
      assert.equal(lookedUp.tasks.filter(task => task.title === '回执丢失查回').length, 1, '查回没有再次创建任务');
      assert.equal(lookedUp.sessions.filter(session => session.taskId === createdUnknown[0].id && session.kind === 'main').length, 1, '查回仍定位原主会话');
      assert.equal(await reopened.page.getByRole('button', { name: '核对任务保存结果' }).count(), 0, '查回成功清理界面待核意图');
    } finally { await reopened.close(); }
  } finally {
    await first.close();
    cleanup(stateDir);
  }
});

test('正常缺模型入口：命名任务先保存主会话，草稿经模型设置往返仍在原任务', async () => {
  const handle = await launchApp(undefined, { DCODE_VALIDATION_ASSEMBLY: '', DCODE_VALIDATION_SAMPLE: '0' });
  try {
    const { page } = handle;
    await ready(page);
    const home = page.getByRole('treeitem', { name: 'Home' });
    await home.hover();
    await home.getByRole('button', { name: '在此空间新建任务' }).click();
    await page.getByRole('menuitem', { name: '新建长期任务' }).click();
    const dialog = page.getByRole('dialog', { name: '新建长期任务' });
    await dialog.getByLabel('任务名称').fill('待配置开发任务');
    await dialog.getByRole('button', { name: '创建' }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.getByText('Home / 待配置开发任务', { exact: true }).waitFor();
    const created = await page.evaluate(() => window.dcode.getSnapshot());
    const task = created.tasks.find(item => item.title === '待配置开发任务');
    const main = created.sessions.filter(item => item.taskId === task?.id && item.kind === 'main');
    assert.ok(task && main.length === 1, '缺模型仍可正式保存长期任务及其唯一主会话');
    assert.equal(created.model.available, false, '保存任务不伪装为模型可用');
    await page.getByText('当前没有可用模型', { exact: false }).first().waitFor();
    await page.getByPlaceholder('写下需求，保存为草稿…').fill('配置模型后继续这个主会话');
    await page.getByRole('button', { name: '去设置' }).click();
    await page.getByLabel(/^(供应商|Provider)$/).waitFor();
    await page.getByRole('button', { name: '返回' }).click();
    await page.getByText('Home / 待配置开发任务', { exact: true }).waitFor();
    assert.equal(await page.getByPlaceholder('写下需求，保存为草稿…').inputValue(), '配置模型后继续这个主会话');
    const after = await page.evaluate(() => window.dcode.getSnapshot());
    assert.equal(after.tasks.length, created.tasks.length, '设置往返不新建任务');
    assert.equal(after.sessions.length, created.sessions.length, '设置往返不新建主会话');
  } finally {
    await handle.close();
    cleanup(handle.stateDir);
  }
});

test('设置页侧栏创建长期任务：保存后主区进入该主会话并接收首条输入', async () => {
  const handle = await launchApp();
  try {
    const { page } = handle;
    await ready(page);
    await page.getByRole('button', { name: /^设置/ }).click();
    await page.locator('main').getByRole('button', { name: '返回' }).waitFor();
    const dialog = await openLongTaskDialog(page);
    await dialog.getByLabel('任务名称').fill('设置页创建后工作');
    await dialog.getByRole('button', { name: '创建' }).click();
    await dialog.waitFor({ state: 'hidden' });
    const saved = await page.evaluate(() => window.dcode.getSnapshot());
    const task = saved.tasks.filter(item => item.title === '设置页创建后工作');
    assert.equal(task.length, 1, '实际保存唯一命名任务');
    const main = saved.sessions.filter(item => item.taskId === task[0].id && item.kind === 'main');
    assert.equal(main.length, 1, '该任务实际保存唯一主会话');
    await page.waitForFunction(id => JSON.parse(localStorage.getItem('dcode-prototype-ui-v1') ?? '{}').selectedSessionId === id, main[0].id);
    const frameDir = evidenceDir('local-task-ui', 'frames');
    mkdirSync(frameDir, { recursive: true });
    await page.screenshot({ path: join(frameDir, 'settings-create-main.png') });
    assert.equal(await page.locator('main').getByRole('button', { name: '返回' }).isVisible(), false, '任务已选中时主区也必须退出设置页');
    await page.getByRole('heading', { name: '开始一项新工作' }).waitFor();
    await page.getByText('D Code / 设置页创建后工作', { exact: true }).waitFor();
    const text = '设置页创建后发到原主会话';
    await page.getByPlaceholder('交代需求、提问或粘贴内容…').fill(text);
    await page.getByPlaceholder('交代需求、提问或粘贴内容…').press('Enter');
    await page.waitForFunction(async ({ sessionId, text }) => (await window.dcode.getSnapshot()).timelines[sessionId]?.some(
      block => block.kind === 'message' && block.role === 'user' && block.text === text && block.receipt?.status === 'accepted',
    ), { sessionId: main[0].id, text });
    const after = await page.evaluate(() => window.dcode.getSnapshot());
    assert.equal(after.tasks.length, saved.tasks.length, '已有长期任务首发不另建根短期任务');
    assert.equal(after.sessions.length, saved.sessions.length, '首发保持同一主会话');
  } finally {
    await handle.close();
    cleanup(handle.stateDir);
  }
});

test('设置页侧栏创建回执丢失：查回成功后主区进入同一主会话', async () => {
  const handle = await launchApp();
  try {
    const { page, app } = handle;
    await ready(page);
    await page.getByRole('button', { name: /^设置/ }).click();
    await page.locator('main').getByRole('button', { name: '返回' }).waitFor();
    await app.evaluate(({ ipcMain }) => {
      const original = ipcMain._invokeHandlers.get('dcode:op');
      let lost = false;
      ipcMain._invokeHandlers.set('dcode:op', async (...args) => {
        if (args[1] === 'createTask' && !lost) {
          lost = true;
          await original(...args);
          throw new Error('task-create-unknown');
        }
        return original(...args);
      });
    });
    const dialog = await openLongTaskDialog(page);
    await dialog.getByLabel('任务名称').fill('设置页查回后工作');
    await dialog.getByRole('button', { name: '创建' }).click();
    await dialog.getByRole('alert').getByText('尚未确认任务创建结果', { exact: false }).waitFor();
    const saved = await page.evaluate(() => window.dcode.getSnapshot());
    const task = saved.tasks.filter(item => item.title === '设置页查回后工作');
    assert.equal(task.length, 1);
    const main = saved.sessions.filter(item => item.taskId === task[0].id && item.kind === 'main');
    assert.equal(main.length, 1);
    await dialog.getByRole('button', { name: '核对任务保存结果' }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.waitForFunction(id => JSON.parse(localStorage.getItem('dcode-prototype-ui-v1') ?? '{}').selectedSessionId === id, main[0].id);
    const frameDir = evidenceDir('local-task-ui', 'frames');
    mkdirSync(frameDir, { recursive: true });
    await page.screenshot({ path: join(frameDir, 'settings-lookup-main.png') });
    assert.equal(await page.locator('main').getByRole('button', { name: '返回' }).isVisible(), false, '查回已保存任务后主区也必须退出设置页');
    await page.getByRole('heading', { name: '开始一项新工作' }).waitFor();
    await page.getByText('D Code / 设置页查回后工作', { exact: true }).waitFor();
    const text = '查回后在原主会话继续';
    await page.getByPlaceholder('交代需求、提问或粘贴内容…').fill(text);
    await page.getByPlaceholder('交代需求、提问或粘贴内容…').press('Enter');
    await page.waitForFunction(async ({ sessionId, text }) => (await window.dcode.getSnapshot()).timelines[sessionId]?.some(
      block => block.kind === 'message' && block.role === 'user' && block.text === text && block.receipt?.status === 'accepted',
    ), { sessionId: main[0].id, text });
    const after = await page.evaluate(() => window.dcode.getSnapshot());
    assert.equal(after.tasks.length, saved.tasks.length, '查回后输入不另建根任务');
    assert.equal(after.sessions.length, saved.sessions.length, '查回后输入不另建主会话');
  } finally {
    await handle.close();
    cleanup(handle.stateDir);
  }
});
