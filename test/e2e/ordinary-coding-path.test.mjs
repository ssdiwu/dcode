// 固定正常桌面主入口、普通模型配置与真实工具路径；隐藏窗口、隔离项目、本地 HTTP。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { launchApp, ready, waitForSnapshot, gotoSession } from './helpers.mjs';
import { evidenceDir } from './evidence-root.mjs';
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

for (const [template, search, followup] of [[false, false, false], [true, false, false], [false, true, false], [false, false, true]]) test(`普通桌面${followup ? '命名任务相连追问' : template ? '模板' : search ? '搜索' : '文字'}：配置→选择并绑定项目→真实工具→失败1回到同运行→修复0→差异→关闭重开只读→明确继续`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dcode-e2e-ordinary-coding-'));
  const stateDir = join(root, 'state'); let project = join(stateDir, 'project');
  const followupEvidence = followup ? evidenceDir('ordinary-coding-followup') : null;
  await prepareCodingProject(project);
  project = await realpath(project);
  if (followup) {
    // 幂等写文件不能证明命令未重放；隔离测试每次实际执行都追加一行。
    const checkPath = join(project, 'check.mjs');
    const originalCheck = await readFile(checkPath, 'utf8');
    await writeFile(checkPath, "import { appendFile } from 'node:fs/promises';\nawait appendFile(new URL('./test-executions.txt', import.meta.url), 'run\\n');\n" + originalCheck);
  }
  const assertPhysicalTests = async count => {
    if (followup) assert.equal(await readFile(join(project, 'test-executions.txt'), 'utf8'), 'run\n'.repeat(count));
  };
  if (template) {
    const dir = join(project, '.pi/prompts'); await mkdir(dir, { recursive: true });
    await writeFile(join(project, 'shared-template.md'), '---\ndescription: 修复加法\n---\n修复本目录的$1，运行真实测试并展示差异');
    await symlink('../../shared-template.md', join(dir, 'repair.md'));
  }
  const followupMarker = `看过这份真实diff后，请把加法结果再加一，更新测试并验证。${randomUUID()}`;
  const server = await startCodingLoopback({ holdFinal: true, prefixCalls: search ? searchCalls : [], followup: followup ? {
    marker: followupMarker, holdFinal: true, calls: [
      ['edit', { path: 'check.mjs', edits: [{ oldText: 'assert.equal(add(2, 3), 5)', newText: 'assert.equal(add(2, 3), 6)' }] }],
      ['bash', { command: 'node --test check.mjs' }],
      ['edit', { path: 'index.mjs', edits: [{ oldText: 'return a + b;', newText: 'return a + b + 1;' }] }],
      ['bash', { command: "node --test check.mjs && printf 'followup verified\\n' > build.txt" }],
    ],
  } : undefined });
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
    let namedTask;
    if (followup) {
      // 悬停会显露按钮并改变行的可访问名称，入口用实际空间ID保持同一对象定位。
      const row = page.locator(`[data-workspace-id="${workspace.id}"] > [role="treeitem"]`);
      await row.hover(); await row.getByRole('button', { name: /在此空间新建任务|New task in/ }).click();
      await page.getByRole('menuitem', { name: /新建长期任务|New long/ }).click();
      const dialog = page.getByRole('dialog', { name: /新建长期任务|New long/ });
      await dialog.getByLabel(/任务名称|Task name/).fill('首条相连编码任务');
      await dialog.getByRole('button', { name: /^创建$|^Create$/ }).click(); await dialog.waitFor({ state: 'hidden' });
      const created = await waitForSnapshot(page, snapshot => snapshot.tasks.some(task => task.title === '首条相连编码任务'));
      namedTask = created.tasks.find(task => task.title === '首条相连编码任务');
      assert.equal(namedTask.kind, 'long'); assert.equal(namedTask.parentId, null);
      assert.equal(namedTask.workspaceId, workspace.id);
      const main = created.sessions.filter(session => session.taskId === namedTask.id && session.kind === 'main');
      assert.equal(main.length, 1, '名称确认后已有且只有一个真实主会话');
      const disk = JSON.parse(await readFile(join(stateDir, 'dcode-prototype-state.json'), 'utf8'));
      assert.ok(disk.tasks.some(task => task.id === namedTask.id));
      assert.ok(disk.sessions.some(session => session.id === main[0].id && session.taskId === namedTask.id));
      assert.equal(server.requests.length, 0, '命名创建本身不运行模型');
    }
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
    if (followup) {
      assert.equal(actualSession.taskId, namedTask.id, '命名任务首发不能另落到根短期任务');
      assert.equal(working.sessions.filter(session => session.taskId === namedTask.id && session.kind === 'main').length, 1);
    }
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
    await assertPhysicalTests(2);
    const edit = blocks.find(block => block.kind === 'change-summary' && block.files.some(file => file.path.endsWith('index.mjs')));
    assert.ok(edit);
    await page.getByText('退出码 1', { exact: true }).waitFor(); await page.getByText('退出码 0', { exact: true }).waitFor();
    // 打开确属该工具的差异入口，不用同名示例卡片替代本次编辑。
    await page.locator(`button[data-block-id="${edit.id}"]`).click();
    const inspector = page.locator('.app-inspector'); await inspector.waitFor({ state: 'visible' });
    await inspector.getByRole('button', { name: 'index.mjs', exact: true }).click();
    assert.match(await inspector.innerText(), /return a \+ b/);
    assert.match(await inspector.innerText(), /return a - b/);
    if (followupEvidence) await page.screenshot({ path: join(followupEvidence, 'first-real-diff.png') });
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
    // 当前任务行直接定位唯一主会话；会话层只列成员，不依赖旧版重复的main子行。
    await gotoSession(page, sessionId);
    assert.equal(server.requests.length, pendingRequest);
    // 关闭承载端必须真实退出；重开只读不重复已完成工具。
    await handle.close(); handle = await launchApp(stateDir, env, '.', { prebindProject: false }); page = handle.page; await ready(page);
    const resumedView = await waitForSnapshot(page, snapshot => snapshot.timelines[sessionId]?.filter(block => block.kind === 'tool').length === totalTools);
    assert.deepEqual(resumedView.timelines[sessionId].filter(block => block.kind === 'tool').map(block => block.id), ids);
    assert.deepEqual(resumedView.workspaces.find(w => w.id === workspace.id).folders, [project], '重开从正式保存读回同空间目录');
    assert.equal(resumedView.tasks.find(task => task.id === actualSession.taskId).workspaceId, workspace.id);
    assert.deepEqual(resumedView.workspaces.find(w => w.id === other.id).folders, [otherPath]);
    assert.equal(server.requests.length, pendingRequest);
    await assertPhysicalTests(2);
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
    await assertPhysicalTests(2);
    if (followup) {
      // 同一任务看完第一轮真实diff与答复后，再交第二轮需求；模型对端只按真实用户正文分流。
      const beforeTasks = final.tasks.length, beforeSessions = final.sessions.length;
      const again = page.getByPlaceholder(/交代需求|Describe|追问、补充|Follow up/i).first();
      await again.fill(followupMarker); await again.press('Enter');
      const revised = await waitForSnapshot(page, snapshot => server.followupRequests.length === 5
        && snapshot.timelines[sessionId]?.filter(block => block.kind === 'tool').length === totalTools + 4
        && snapshot.timelines[sessionId].filter(block => block.kind === 'tool').every(block => ['done', 'failed'].includes(block.tool.status)));
      assert.equal(revised.tasks.length, beforeTasks); assert.equal(revised.sessions.length, beforeSessions);
      assert.equal(revised.sessions.find(session => session.id === sessionId).taskId, namedTask.id);
      const revisedTools = revised.timelines[sessionId].filter(block => block.kind === 'tool');
      assert.deepEqual(revisedTools.slice(totalTools).map(block => block.tool.name), ['edit', 'bash', 'edit', 'bash']);
      assert.deepEqual(revisedTools.filter(block => block.tool.name === 'bash').map(block => [block.tool.exitCode, block.tool.status]),
        [[1, 'failed'], [0, 'done'], [1, 'failed'], [0, 'done']]);
      assert.equal(server.followupRequests[0].body.messages.filter(message => message.role === 'user' && message.content === followupMarker).length, 1);
      // 只核第二轮失败工具的结果，不能由上下文里第一轮旧失败替它背书。
      const followupFailure = server.followupRequests[2].body.messages.filter(message => message.role === 'tool' && message.tool_call_id === 'followup-tool-2');
      assert.equal(followupFailure.length, 1);
      assert.match(JSON.stringify(followupFailure[0].content), /Command exit code: 1/);
      assert.match(await readFile(join(project, 'index.mjs'), 'utf8'), /return a \+ b \+ 1/);
      assert.match(await readFile(join(project, 'check.mjs'), 'utf8'), /assert.equal\(add\(2, 3\), 6\)/);
      assert.equal(await readFile(join(project, 'build.txt'), 'utf8'), 'followup verified\n');
      await assertPhysicalTests(4);
      const latestChange = [...revised.timelines[sessionId]].reverse().find(block => block.kind === 'change-summary' && block.files.some(file => file.path.endsWith('index.mjs')));
      assert.ok(latestChange); assert.notEqual(latestChange.id, edit.id);
      await page.locator(`button[data-block-id="${latestChange.id}"]`).click();
      const latestInspector = page.locator('.app-inspector'); await latestInspector.waitFor({ state: 'visible' });
      await latestInspector.getByRole('button', { name: 'index.mjs', exact: true }).click();
      assert.match(await latestInspector.innerText(), /return a \+ b;/);
      assert.match(await latestInspector.innerText(), /return a \+ b \+ 1/);
      await page.screenshot({ path: join(followupEvidence, 'second-real-diff.png') });
      await page.getByRole('button', { name: /关闭检查器|Close inspector/ }).click();
      const revisedIds = revisedTools.map(block => block.id), count = server.requests.length;
      const secondUser = revised.timelines[sessionId].find(block => block.kind === 'message' && block.role === 'user' && block.text === followupMarker);
      assert.ok(secondUser?.operationId); assert.notEqual(secondUser.operationId, user.operationId);
      // 第二轮原请求仍在途时直接关窗，不借先暂停弱化关闭路径。
      await handle.close(); handle = await launchApp(stateDir, env, '.', { prebindProject: false }); page = handle.page; await ready(page);
      const reopened = await waitForSnapshot(page, snapshot => snapshot.timelines[sessionId]?.filter(block => block.kind === 'tool').length === totalTools + 4);
      assert.equal(server.requests.length, count, '追问后重开只读，不能自动补发');
      await assertPhysicalTests(4);
      assert.deepEqual(reopened.timelines[sessionId].filter(block => block.kind === 'tool').map(block => block.id), revisedIds);
      assert.equal(reopened.tasks.find(task => task.id === actualSession.taskId).id, namedTask.id);
      await page.evaluate(({ sessionId, blockId }) => window.dcode.checkReceipt({ sessionId, blockId }), { sessionId, blockId: secondUser.id });
      assert.equal(server.requests.length, count, '查第二次输入回执不执行工作');
      await assertPhysicalTests(4);
      server.releaseFollowupFinal();
      const continueButton = page.locator('button[data-slot="composer-primary"]');
      assert.match(await continueButton.getAttribute('aria-label'), /^继续执行$|^Resume$/); await continueButton.click();
      await page.getByText(server.followupNonce, { exact: true }).waitFor();
      const complete = await waitForSnapshot(page, snapshot => snapshot.timelines[sessionId].some(block => block.kind === 'message' && block.role === 'assistant' && block.text === server.followupNonce));
      assert.equal(server.followupRequests.length, 6); assert.equal(server.requests.length, count + 1);
      assert.equal(complete.timelines[sessionId].filter(block => block.kind === 'message' && block.role === 'user').length, 2);
      assert.deepEqual(complete.timelines[sessionId].filter(block => block.kind === 'tool').map(block => block.id), revisedIds);
      assert.equal(complete.tasks.length, beforeTasks); assert.equal(complete.sessions.length, beforeSessions);
      await assertPhysicalTests(4);
      assert.equal(await readFile(join(otherPath, 'index.mjs'), 'utf8'), 'unrelated project bytes');
      assert.ok(server.requests.every(request => request.authOk && request.body.model === codingModel));
      await page.screenshot({ path: join(followupEvidence, 'second-answer-after-explicit-continue.png') });
      await writeFile(join(followupEvidence, 'actual-facts.json'), JSON.stringify({ taskId: namedTask.id, sessionId,
        userOperations: [user.operationId, secondUser.operationId], firstReply: server.nonce, followupReply: server.followupNonce,
        firstToolIds: ids, finalToolIds: revisedIds,
        toolResults: revisedTools.map(block => ({ id: block.id, name: block.tool.name, status: block.tool.status, exitCode: block.tool.exitCode ?? null })),
        requestFacts: server.requests.map(request => ({ ordinal: request.ordinal, phase: request.phase ?? 'first-input',
          model: request.body.model, authenticated: request.authOk,
          followupUserBodyMatches: request.body.messages.filter(message => message.role === 'user').at(-1)?.content === followupMarker })),
        readonlyReopenRequestCount: count, finalRequestCount: server.requests.length,
        physicalTestExecutions: (await readFile(join(project, 'test-executions.txt'), 'utf8')).split('\n').filter(Boolean).length,
        finalUserCount: complete.timelines[sessionId].filter(block => block.kind === 'message' && block.role === 'user').length,
        taskAndSessionCountsUnchanged: complete.tasks.length === beforeTasks && complete.sessions.length === beforeSessions,
        files: { index: await readFile(join(project, 'index.mjs'), 'utf8'), test: await readFile(join(project, 'check.mjs'), 'utf8'), build: await readFile(join(project, 'build.txt'), 'utf8') },
        scope: 'ordinary SDK with controlled HTTP plus hidden desktop; no real provider or507human acceptance',
      }, null, 2) + '\n');
    }
    assert.deepEqual(server.errors, []);
  } finally {
    try { await handle?.close(); } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
  }
});
