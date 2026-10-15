// 固定正常桌面主入口、普通模型配置与真实工具路径；隐藏窗口、隔离项目、本地 HTTP。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, ready, waitForSnapshot } from './helpers.mjs';
import { prepareCodingProject, startCodingLoopback, codingKey, codingModel, searchCalls } from './ordinary-coding-fixture.mjs';

async function bindFromUi(handle, folder, name) {
  const page = handle.page;
  const before = await handle.app.evaluate(() => globalThis.__ownedDirectoryChoices?.length ?? 0);
  await handle.app.evaluate(({ dialog }, path) => {
    globalThis.__ownedDirectoryChoices ??= [];
    dialog.showOpenDialog = async (window, options) => {
      globalThis.__ownedDirectoryChoices.push({ windowId: window.id, properties: options.properties });
      return { canceled: false, filePaths: [path] };
    };
  }, folder);
  await page.getByRole('button', { name: /新建工作空间|New workspace/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: /选择文件夹|Choose folder/ }).click();
  await dialog.locator('[data-slot="workspace-selected-folder"]').getByText(folder, { exact: true }).waitFor();
  await dialog.getByLabel(/工作空间名称|Workspace name/).fill(name);
  await dialog.getByRole('button', { name: /^创建$|^Create$/ }).click();
  await dialog.waitFor({ state: 'hidden' });
  const bound = await waitForSnapshot(page, snapshot => snapshot.workspaces.some(w => w.name === name));
  const workspace = bound.workspaces.find(w => w.name === name);
  assert.deepEqual(workspace.folders, [folder]);
  assert.equal(bound.tasks.find(task => task.id === workspace.defaultTaskId).workspaceId, workspace.id);
  const persisted = JSON.parse(await readFile(join(handle.stateDir, 'dcode-prototype-state.json'), 'utf8'));
  assert.deepEqual(persisted.workspaces.find(w => w.id === workspace.id).folders, [folder]);
  assert.equal(persisted.tasks.find(task => task.id === workspace.defaultTaskId).workspaceId, workspace.id);
  const choices = await handle.app.evaluate(() => globalThis.__ownedDirectoryChoices);
  assert.equal(choices.length, before + 1); assert.deepEqual(choices.at(-1).properties, ['openDirectory']);
  assert.ok(choices.at(-1).windowId > 0);
  // 保存快照不替界面当前归属；先看到正确草稿位置，才允许后面的真实需求发送。
  await page.locator('main').getByText(`${name} / 默认任务`, { exact: true }).waitFor();
  return workspace;
}

for (const [template, search] of [[false, false], [true, false], [false, true]]) test(`普通桌面${template ? '模板' : search ? '搜索' : '文字'}：配置→选择并绑定项目→真实工具→失败1回到同运行→修复0→差异→关闭重开只读→明确继续`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dcode-e2e-ordinary-coding-'));
  const stateDir = join(root, 'state'); let project = join(stateDir, 'project');
  await prepareCodingProject(project);
  project = await realpath(project);
  if (template) {
    const dir = join(project, '.pi/prompts'); await mkdir(dir, { recursive: true });
    await writeFile(join(project, 'shared-template.md'), '---\ndescription: 修复加法\n---\n修复本目录的$1，运行真实测试并展示差异');
    await symlink('../../shared-template.md', join(dir, 'repair.md'));
  }
  const server = await startCodingLoopback({ holdFinal: true, prefixCalls: search ? searchCalls : [] });
  const totalTools = search ? 8 : 5; const pendingRequest = totalTools + 1;
  const env = { DCODE_VALIDATION_ASSEMBLY: '', DCODE_VALIDATION_SAMPLE: '0', DCODE_CATALOG_BASE_URL: `${server.origin}/catalog` };
  let handle;
  try {
    handle = await launchApp(stateDir, env, '.', { prebindProject: false }); let page = handle.page; await ready(page);
    const settings = () => page.locator('nav').getByRole('button', { name: /设置|Settings/ });
    // 缺配置时此项的可访问名称还含“不可用”状态，不能把状态反馈误当入口缺失。
    const modelSection = () => page.locator('.w-44').getByRole('button', { name: /^模型\s*(不可用)?$|^Model\s*(Unavailable)?$/i });
    await settings().click(); await modelSection().click();
    await page.getByRole('radio', { name: /^自定义$|^Custom$/ }).click();
    await page.getByRole('radio', { name: /OpenAI-compatible|OpenAI/i }).click();
    await page.getByLabel(/显示名|Display name/i).fill('真实项目工具夹具');
    await page.getByLabel(/模型 ID|Model ID/i).fill(codingModel);
    await page.getByLabel(/Base URL/i).fill(`${server.origin}/v1`);
    await page.getByLabel(/API 密钥|API key/i).fill(codingKey);
    await page.getByRole('button', { name: /^保存$|^Save$/ }).click();
    await waitForSnapshot(page, snapshot => snapshot.model?.available === true);
    assert.equal(server.requests.length, 0, '配置保存不是模型探针');
    // 已知可使用工具的受控模型由真实候选配置入口登记，不放宽必需能力未知的政策。
    await page.keyboard.press('Escape'); await settings().click(); await modelSection().click();
    const candidate = page.getByTestId(`candidate-user-defined-${codingModel}`);
    assert.equal(await candidate.isChecked(), false, '隔离配置尚未登记 Auto 候选');
    // 此控件按正式保存快照显示 checked；点击后不要求异步保存立即变色。
    await candidate.click();
    await waitForSnapshot(page, snapshot => snapshot.settings.modelCandidates.some(identity => identity.sourceId === 'user-defined' && identity.modelId === codingModel));
    await page.waitForFunction(id => document.querySelector(`input[data-testid="${id}"]`)?.checked === true,
      `candidate-user-defined-${codingModel}`);
    assert.equal(await candidate.isChecked(), true, '正式保存必须也在界面显示选中');
    await page.keyboard.press('Escape');
    const unbound = await page.evaluate(() => window.dcode.getSnapshot());
    assert.deepEqual(unbound.workspaces.map(w => w.folders), [['~']], '普通初始状态没有测试预写项目绑定');
    const workspace = await bindFromUi(handle, project, '受控真实开发空间');
    assert.equal(server.requests.length, 0, '选择与绑定不启动模型或工具');
    const composer = page.getByPlaceholder(/交代需求|Describe|追问、补充|Follow up/i).first();
    await composer.fill(template ? '/repair 加法' : '修复本目录的加法，运行真实测试并展示差异'); await composer.press('Enter');
    // 正式工具完成帧可以先于下一 SDK 请求；两者都实际到达才核同次正文，不用工具数量推定 HTTP。
    const working = await waitForSnapshot(page, snapshot => server.requests.length === pendingRequest
      && Object.values(snapshot.timelines).some(blocks => {
        const tools = blocks.filter(block => block.kind === 'tool');
        return tools.length === totalTools && tools.every(block => block.tool.status === 'done' || block.tool.status === 'failed');
      }));
    const sessionId = Object.keys(working.timelines).find(id => working.timelines[id].filter(block => block.kind === 'tool').length === totalTools);
    assert.ok(sessionId);
    const actualSession = working.sessions.find(session => session.id === sessionId);
    assert.equal(working.tasks.find(task => task.id === actualSession.taskId).workspaceId, workspace.id, '首次输入实际执行任务保留新空间归属');
    const blocks = working.timelines[sessionId];
    const tools = blocks.filter(block => block.kind === 'tool');
    assert.deepEqual(tools.map(block => block.tool.name), [...(search ? ['ls', 'find', 'grep'] : []), 'read', 'write', 'bash', 'edit', 'bash']);
    assert.deepEqual(tools.filter(block => block.tool.name === 'bash').map(block => [block.tool.exitCode, block.tool.status]), [[1, 'failed'], [0, 'done']]);
    assert.equal(server.requests.length, pendingRequest);
    assert.equal(server.requests[0].body.messages.find(message => message.role === 'user').content, '修复本目录的加法，运行真实测试并展示差异');
    assert.match(JSON.stringify(server.requests[0].body.messages), /coding-agents-real-context/);
    assert.match(JSON.stringify(server.requests[search ? 6 : 3].body.messages.filter(message => message.role === 'tool')), /Command exit code: 1/);
    if (search) {
      for (const block of tools.slice(0, 3)) {
        assert.equal(block.tool.status, 'done');
        const trigger = page.getByRole('button', { name: new RegExp(`^(工具结果|Tool result) ${block.tool.name} `, 'i') });
        await trigger.click();
        const output = page.locator('[data-slot="tool"]').filter({ has: trigger }).locator('pre');
        await output.waitFor({ state: 'visible' });
        assert.equal(await output.innerText(), block.tool.output);
        assert.match(block.tool.output, block.tool.name === 'grep' ? /index\.mjs:1:.*return a - b/ : /index\.mjs/);
        await trigger.click();
      }
      assert.match(JSON.stringify(server.requests[3].body.messages.filter(message => message.role === 'tool')), /return a - b/);
      assert.equal(server.requests.length, pendingRequest, '展开搜索结果不重新执行工具');
    }
    assert.match(await readFile(join(project, 'index.mjs'), 'utf8'), /return a \+ b/);
    assert.equal(await readFile(join(project, 'build.txt'), 'utf8'), 'actual build output\n');
    const edit = blocks.find(block => block.kind === 'change-summary' && block.files.some(file => file.path.endsWith('index.mjs')));
    assert.ok(edit);
    await page.getByText('退出码 1', { exact: true }).waitFor(); await page.getByText('退出码 0', { exact: true }).waitFor();
    // 打开确属该工具的差异入口，不用同名示例卡片替代本次编辑。
    await page.locator(`button[data-block-id="${edit.id}"]`).click();
    const inspector = page.locator('.app-inspector'); await inspector.waitFor({ state: 'visible' });
    await inspector.getByRole('button', { name: 'index.mjs', exact: true }).click();
    assert.match(await inspector.innerText(), /return a \+ b/);
    assert.match(await inspector.innerText(), /return a - b/);
    await page.getByRole('button', { name: /关闭检查器|Close inspector/ }).click();
    const ids = tools.map(block => block.id);
    // 用户明确暂停；再创建另一绑定空间并返回旧会话，不能把旧运行迁到新目录。
    await page.locator('button[data-slot="composer-primary"]').click();
    await waitForSnapshot(page, snapshot => snapshot.runs[sessionId]?.status === 'paused');
    const otherFolder = join(project, '..', 'other-project'); await mkdir(otherFolder);
    await writeFile(join(otherFolder, 'AGENTS.md'), 'other-project-must-stay-idle');
    await writeFile(join(otherFolder, 'index.mjs'), 'unrelated project bytes');
    const otherPath = await realpath(otherFolder);
    const other = await bindFromUi(handle, otherPath, '另一已绑定空间');
    assert.notEqual(other.id, workspace.id);
    assert.equal(server.requests.length, pendingRequest, '新绑定和纯导航不能恢复旧工作');
    const oldSession = page.locator(`[data-session-id="${sessionId}"]`);
    if (await oldSession.count() === 0) await page.locator(`[data-task-id="${actualSession.taskId}"]`).click();
    await oldSession.click();
    await page.locator('main header').getByText(actualSession.title, { exact: true }).waitFor();
    assert.equal(server.requests.length, pendingRequest);
    // 关闭承载端必须真实退出；重开只读不重复已完成工具。
    await handle.close(); handle = await launchApp(stateDir, env, '.', { prebindProject: false }); page = handle.page; await ready(page);
    const resumedView = await waitForSnapshot(page, snapshot => snapshot.timelines[sessionId]?.filter(block => block.kind === 'tool').length === totalTools);
    assert.deepEqual(resumedView.timelines[sessionId].filter(block => block.kind === 'tool').map(block => block.id), ids);
    assert.deepEqual(resumedView.workspaces.find(w => w.id === workspace.id).folders, [project], '重开从正式保存读回同空间目录');
    assert.equal(resumedView.tasks.find(task => task.id === actualSession.taskId).workspaceId, workspace.id);
    assert.deepEqual(resumedView.workspaces.find(w => w.id === other.id).folders, [otherPath]);
    assert.equal(server.requests.length, pendingRequest);
    const user = resumedView.timelines[sessionId].find(block => block.kind === 'message' && block.role === 'user');
    assert.ok(user?.operationId);
    await page.evaluate(({ sessionId, blockId }) => window.dcode.checkReceipt({ sessionId, blockId }), { sessionId, blockId: user.id });
    assert.equal(server.requests.length, pendingRequest);
    server.releaseFinal();
    const primary = page.locator('button[data-slot="composer-primary"]');
    assert.match(await primary.getAttribute('aria-label'), /^继续执行$|^Resume$/);
    await primary.click();
    await page.getByText(server.nonce, { exact: true }).waitFor();
    const final = await waitForSnapshot(page, snapshot => snapshot.timelines[sessionId].some(block => block.kind === 'message' && block.role === 'assistant' && block.text === server.nonce));
    assert.equal(server.requests.length, pendingRequest + 1);
    assert.deepEqual(final.timelines[sessionId].filter(block => block.kind === 'tool').map(block => block.id), ids);
    assert.equal(final.timelines[sessionId].filter(block => block.kind === 'message' && block.role === 'user').length, 1);
    assert.ok(server.requests.every(request => request.authOk && request.body.model === codingModel));
    assert.match(JSON.stringify(server.requests.at(-1).body.messages), /coding-agents-real-context/);
    assert.doesNotMatch(JSON.stringify(server.requests.at(-1).body.messages), /other-project-must-stay-idle/);
    assert.equal(await readFile(join(otherPath, 'index.mjs'), 'utf8'), 'unrelated project bytes');
    assert.deepEqual(server.errors, []);
  } finally {
    try { await handle?.close(); } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
  }
});
