// 普通桌面项目扩展/MCP完整生命周期；原始结果与退出见当前独立证据根。
// 两场景均普通 Electron/IPC/ModelRuntime/Durable + loopback 模型 + 真实 stdio MCP。
// native 仅替系统目录选择；不预写产品状态/凭据，不证明真实外部账户或人工接受。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { launchApp, ready, waitForSnapshot, killApp } from './helpers.mjs';
import { prepareCodingProject, startCodingLoopback, codingKey, codingModel } from './ordinary-coding-fixture.mjs';
import { evidenceDir } from './evidence-root.mjs';

async function events(project) {
  const names = (await readdir(project)).filter(name => /^mcp-events-\d+\.jsonl$/.test(name));
  return (await Promise.all(names.map(name => readFile(join(project, name), 'utf8'))))
    .flatMap(text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
}
async function effects(project) {
  try { return (await readFile(join(project, 'effects.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
const settingsButton = page => page.locator('nav').getByRole('button', { name: /设置|Settings/ });
async function configureModel(page, server) {
  await settingsButton(page).click();
  const modelSection = () => page.locator('.w-44').getByRole('button', { name: /^模型\s*(不可用)?$|^Model\s*(Unavailable)?$/i });
  await modelSection().click();
  await page.getByRole('radio', { name: /^自定义$|^Custom$/ }).click();
  await page.getByRole('radio', { name: /OpenAI-compatible|OpenAI/i }).click();
  await page.getByLabel(/显示名|Display name/).fill('普通桌面扩展 MCP');
  await page.getByLabel(/模型 ID|Model ID/).fill(codingModel);
  await page.getByLabel(/Base URL/).fill(`${server.origin}/v1`);
  await page.getByLabel(/API 密钥|API key/i).fill(codingKey);
  await page.getByRole('button', { name: /^保存$|^Save$/ }).click();
  await waitForSnapshot(page, snapshot => snapshot.model?.available === true);
  await page.keyboard.press('Escape'); await settingsButton(page).click(); await modelSection().click();
  const candidate = page.getByTestId(`candidate-user-defined-${codingModel}`);
  assert.equal(await candidate.isChecked(), false);
  await candidate.click();
  await waitForSnapshot(page, snapshot => snapshot.settings.modelCandidates.some(item => item.sourceId === 'user-defined' && item.modelId === codingModel));
  await page.waitForFunction(id => document.querySelector(`input[data-testid="${id}"]`)?.checked === true, `candidate-user-defined-${codingModel}`);
  await page.keyboard.press('Escape'); assert.equal(server.requests.length, 0);
}
async function bindProject(handle, folder, name) {
  await handle.app.evaluate(({ dialog }, path) => {
    globalThis.__mcpDirectoryChoices = [];
    dialog.showOpenDialog = async (window, options) => {
      globalThis.__mcpDirectoryChoices.push({ windowId: window.id, properties: options.properties });
      return { canceled: false, filePaths: [path] };
    };
  }, folder);
  const page = handle.page;
  await page.locator('nav').getByRole('button', { name: /新建工作空间|New workspace/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: /选择文件夹|Choose folder/ }).click();
  await dialog.locator('[data-slot="workspace-selected-folder"]').getByText(folder, { exact: true }).waitFor();
  await dialog.getByLabel(/工作空间名称|Workspace name/).fill(name);
  await dialog.getByRole('button', { name: /^创建$|^Create$/ }).click(); await dialog.waitFor({ state: 'hidden' });
  const snapshot = await waitForSnapshot(page, value => value.workspaces.some(item => item.name === name));
  const workspace = snapshot.workspaces.find(item => item.name === name);
  assert.deepEqual(workspace.folders, [folder]);
  const disk = JSON.parse(await readFile(join(handle.stateDir, 'dcode-prototype-state.json'), 'utf8'));
  assert.deepEqual(disk.workspaces.find(item => item.id === workspace.id).folders, [folder]);
  assert.equal(disk.tasks.find(item => item.id === workspace.defaultTaskId).workspaceId, workspace.id);
  const choices = await handle.app.evaluate(() => globalThis.__mcpDirectoryChoices);
  assert.equal(choices.length, 1); assert.deepEqual(choices[0].properties, ['openDirectory']); assert.ok(choices[0].windowId > 0);
  await page.locator('main').getByText(`${name} / 默认任务`, { exact: true }).waitFor();
  return workspace;
}
async function enableResources(page, stateDir) {
  await settingsButton(page).click();
  await page.locator('.w-44').getByRole('button', { name: /^项目扩展与 MCP$|^Project extensions & MCP$/ }).click();
  const group = page.getByRole('radiogroup', { name: /^项目扩展与 MCP$|^Project extensions & MCP$/ });
  assert.equal(await group.getByRole('radio', { name: /^关闭$|^Off$/ }).isChecked(), true);
  await group.getByRole('radio', { name: /^开启$|^On$/ }).click();
  await waitForSnapshot(page, snapshot => snapshot.settings.projectExtensionsEnabled === true);
  const on=await group.getByRole('radio',{name:/^开启$|^On$/}).elementHandle();
  await page.waitForFunction(element=>element?.checked===true||element?.getAttribute('aria-checked')==='true',on);
  assert.equal(await group.getByRole('radio', { name: /^开启$|^On$/ }).isChecked(), true);
  assert.equal(JSON.parse(await readFile(join(stateDir, 'dcode-prototype-state.json'), 'utf8')).settings.projectExtensionsEnabled, true);
  await page.keyboard.press('Escape');
}
async function gotoSession(page, sessionId) {
  const snapshot = await page.evaluate(() => window.dcode.getSnapshot());
  const session = snapshot.sessions.find(item => item.id === sessionId);
  const task = snapshot.tasks.find(item => item.id === session?.taskId); assert.ok(session && task);
  const workspaceRow = page.locator(`[data-workspace-id="${task.workspaceId}"] > [role="treeitem"]`);
  if (await workspaceRow.getAttribute('aria-expanded') !== 'true') await workspaceRow.click();
  const taskRow = page.locator(`[data-task-id="${task.id}"]`);
  if (await taskRow.getAttribute('aria-expanded') !== 'true') await taskRow.click();
  const row = page.locator(`[data-session-id="${sessionId}"]`); await row.click();
  await page.waitForFunction(id => document.querySelector(`[data-session-id="${id}"]`)?.getAttribute('aria-current') === 'true', sessionId);
  await page.locator('main header').getByText(session.title, { exact: true }).waitFor();
}
const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
async function visibleTool(page, block) {
  const trigger = page.getByRole('button', { name: new RegExp(`^(工具结果|Tool result) ${escapeRegex(block.tool.name)} ${escapeRegex(block.tool.primaryText)} `, 'i') });
  assert.equal(await trigger.count(), 1);
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
  const pre = page.locator('[data-slot="tool"]').filter({ has: trigger }).locator('pre');
  await pre.waitFor({ state: 'visible' }); assert.equal(await pre.innerText(), block.tool.output);
  return pre;
}
const extensionVisibleText = nonce => `extension visible ${nonce}`;
const httpMessageText = message => typeof message.content === 'string' ? message.content
  : Array.isArray(message.content) ? message.content.filter(part => part.type === 'text').map(part => part.text).join('\n') : '';
async function visibleExtensionMessage(page, snapshot, sessionId, server, nonce) {
  const text = extensionVisibleText(nonce), blocks = snapshot.timelines[sessionId];
  const messages = blocks.filter(block => block.kind === 'extension-message' && block.customType === 'fixture-extension');
  assert.equal(messages.length, 1, '同一处理器可见消息只提交一次'); assert.equal(messages[0].text, text);
  assert.equal(blocks.filter(block => block.kind === 'message' && block.role === 'assistant' && block.text === text).length, 0, '扩展正文不是模型回复');
  const startupText=`startup visible ${nonce}`,hiddenText=`startup context only ${nonce}`;
  const startup=blocks.filter(block=>block.kind==='extension-message'&&block.customType==='fixture-start');
  assert.equal(startup.length,1);assert.equal(startup[0].text,startupText);
  assert.equal(blocks.filter(block=>block.kind==='extension-message'&&block.customType==='fixture-hidden').length,0);
  const startRow=page.locator('[data-slot="extension-message"]').filter({hasText:startupText});
  await startRow.waitFor({state:'visible'});assert.match(await startRow.locator('p').first().innerText(),/^(项目扩展|Project extension) · fixture-start$/);
  assert.equal(await page.locator('[data-slot="extension-message"]').filter({hasText:hiddenText}).count(),0);
  await startRow.screenshot({path:join(evidenceDir('ordinary-extension-mcp'),`${sessionId}-startup-source-${randomUUID()}.png`)});
  assert.equal(server.requests[0].body.messages.filter(message=>httpMessageText(message)===startupText).length,1);
  assert.equal(server.requests[0].body.messages.filter(message=>httpMessageText(message)===hiddenText).length,1);
  const row = page.locator('[data-slot="extension-message"]').filter({ hasText: text });
  assert.equal(await row.count(), 1); await row.waitFor({ state: 'visible' });
  assert.match(await row.locator('p').first().innerText(), /^(项目扩展|Project extension) · fixture-extension$/);
  await row.getByText(text, { exact: true }).waitFor({ state: 'visible' });
  // visible 只证明布局未隐藏；元素截图先真实滚入视口，保留来源和正文的实际像素。
  await row.screenshot({path:join(evidenceDir('ordinary-extension-mcp'),`${sessionId}-extension-source-${randomUUID()}.png`)});
  const first = server.requests[0], next = server.requests[1]; assert.ok(first && next);
  assert.equal(first.body.messages.filter(message => httpMessageText(message) === text).length, 0, '处理器调用前没有预置扩展正文');
  assert.equal(next.ordinal, first.ordinal + 1); assert.equal(next.authOk, true); assert.equal(next.body.model, codingModel);
  assert.equal(next.body.messages.filter(message => message.role === 'user' && httpMessageText(message) === text).length, 1, '扩展正文进入紧邻处理器之后的真实 HTTP 上下文');
  assert.ok(next.body.messages.some(message => message.role === 'tool' && httpMessageText(message).includes(`extension actual ${nonce}`)), '原工具输出仍进入同一次下一 HTTP');
  return messages[0];
}
const desktopSkillPath = '.pi/skills/desktop-evidence/SKILL.md';
const desktopSkillDescription = nonce => `DESKTOP_SKILL_DESCRIPTION_${nonce}`;
const desktopSkillBody = nonce => `DESKTOP_SKILL_FULL_BODY_${nonce}`;
async function desktopSkillReads(project) {
  try { return (await readFile(join(project,'desktop-skill-read-completions.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)); }
  catch(error) { if(error.code==='ENOENT')return [];throw error; }
}
async function visibleDesktopSkillRead(page,snapshot,sessionId,f) {
  const blocks=snapshot.timelines[sessionId],body=desktopSkillBody(f.nonce);
  const reads=blocks.filter(block=>block.kind==='tool'&&block.tool.name==='read'&&block.tool.output.includes(body));
  assert.equal(reads.length,1,'按需技能read必须有唯一正式工具历史');assert.equal(reads[0].tool.status,'done');assert.ok(reads[0].tool.output.includes(f.skillContent));
  const outer=blocks.filter(block=>block.kind==='tool'&&block.tool.name==='extension_nonce');
  assert.equal(outer.length,1);assert.equal(outer[0].tool.status,'done');assert.ok(outer[0].tool.output.includes(`extension actual ${f.nonce}`));assert.ok(outer[0].tool.output.includes(f.skillContent));
  const first=f.server.requests[0],next=f.server.requests[1];assert.ok(first&&next);
  const header=first.body.messages.filter(message=>['system','developer'].includes(message.role)).map(httpMessageText).join('\n');
  assert.equal(header.split(desktopSkillDescription(f.nonce)).length-1,1,'首次模型目录只有一份本次技能description');
  assert.ok(!JSON.stringify(first.body.messages).includes(body),'目录不自动注入完整技能正文');
  assert.equal(next.ordinal,2);assert.equal(next.authOk,true);assert.equal(next.body.model,codingModel);
  const forwarded=next.body.messages.filter(message=>message.role==='tool'&&message.tool_call_id==='actual-tool-1');
  assert.equal(forwarded.length,1);assert.ok(httpMessageText(forwarded[0]).includes(`extension actual ${f.nonce}`));assert.ok(httpMessageText(forwarded[0]).includes(f.skillContent),'同一外层正式结果向紧邻HTTP交回实际read全文');
  const completed=await desktopSkillReads(f.project);assert.equal(completed.length,1,'已完成的真实ctx.read调用不能再次执行');
  assert.equal(completed[0].nonce,f.nonce);assert.match(completed[0].callId,/^actual-tool-1\//);
  assert.equal(next.body.messages.filter(message=>message.role==='tool'&&message.tool_call_id===completed[0].callId).length,0,'内部read不伪造模型发起的独立tool结果');
  const pre=await visibleTool(page,reads[0]);assert.ok((await pre.innerText()).includes(f.skillContent));
  await pre.screenshot({path:join(evidenceDir('ordinary-extension-mcp'),`${sessionId}-skill-read-${randomUUID()}.png`)});
  await visibleTool(page,outer[0]);
  return {readId:reads[0].id,outerId:outer[0].id,callId:completed[0].callId};
}
async function pauseAndDrain(f, sessionId) {
  const page = f.handle.page, primary = page.locator('button[data-slot="composer-primary"]');
  assert.match(await primary.getAttribute('aria-label'), /^暂停$|^Pause$/);
  await primary.click(); await waitForSnapshot(page, snapshot => snapshot.runs[sessionId]?.status === 'paused');
  await waitForSnapshot(page, async () => {
    const records = await events(f.project), starts = records.filter(item => item.type === 'start');
    return starts.length > 0 && starts.every(start => records.some(item => item.pid === start.pid && item.type === 'close.drained' && item.pending === 0)
      && records.some(item => item.pid === start.pid && item.type === 'exit' && item.code === 0));
  }, undefined, 'MCP must really drain and exit after user pause');
}
async function reopenReadonly(f, sessionId, requestCount) {
  const before = await events(f.project), started = before.filter(item => item.type === 'start').length;
  await f.handle.close(); f.handle = await launchApp(f.stateDir, f.env, '.', { prebindProject: false }); f.proc = f.handle.app.process();
  await ready(f.handle.page); await gotoSession(f.handle.page, sessionId);
  await f.handle.page.evaluate(() => window.dcode.getSnapshot());
  assert.equal((await events(f.project)).filter(item => item.type === 'start').length, started, '只读重开/导航不启动 MCP');
  assert.equal(f.server.requests.length, requestCount, '只读重开不请求模型');
  const snapshot = await f.handle.page.evaluate(() => window.dcode.getSnapshot());
  const user = snapshot.timelines[sessionId].find(item => item.kind === 'message' && item.role === 'user'); assert.ok(user?.operationId);
  await f.handle.page.evaluate(({ sessionId, blockId }) => window.dcode.checkReceipt({ sessionId, blockId }), { sessionId, blockId: user.id });
  assert.equal(f.server.requests.length, requestCount);
  assert.equal((await events(f.project)).filter(item => item.type === 'start').length, started);
  return snapshot;
}
async function withFixture({ calls, holdFinal = false, callsOverride, ownedComplete = false, ownedStream = false, ownedVirtual = false, virtualWait = false, ownedProviderHeader = false }, action) {
  const root = await mkdtemp(join(tmpdir(), 'dcode-desktop-extension-mcp-'));
  const f = { root, stateDir: join(root, 'state'), project: null, nonce: randomUUID(), handle: null, proc: null, server: null };
  let primary; const secondary = [];
  try {
    const project = join(root, 'project'); await prepareCodingProject(project); f.project = await realpath(project);
    await writeFile(join(f.project, '.fixture-owner'), f.nonce); await writeFile(join(f.project, 'input.txt'), `actual MCP input ${f.nonce}`);
    f.skillContent=`---\nname: desktop-evidence\ndescription: ${desktopSkillDescription(f.nonce)}\n---\n${desktopSkillBody(f.nonce)}\nThis owned skill body must be read explicitly and returned through the original tool result.\n`;
    await mkdir(join(f.project,'.pi/skills/desktop-evidence'),{recursive:true});
    await writeFile(join(f.project,desktopSkillPath),f.skillContent);
    await mkdir(join(f.project, '.pi/extensions'), { recursive: true });
    await writeFile(join(f.project, '.pi/extensions/desktop.ts'), `import { Type } from 'typebox';\nimport { appendFile } from 'node:fs/promises';\nimport { join } from 'node:path';\nexport default function(pi) { pi.on('before_agent_start',()=>({message:{customType:'fixture-start',content:${JSON.stringify('startup visible '+f.nonce)},display:true}})); pi.on('before_agent_start',()=>({message:{customType:'fixture-hidden',content:${JSON.stringify('startup context only '+f.nonce)},display:false}})); pi.registerTool({name:'extension_nonce',label:'nonce',description:'Actual project extension',parameters:Type.Object({}),async execute(id,args,signal,update,ctx){pi.sendMessage({customType:'fixture-extension',content:${JSON.stringify(extensionVisibleText(f.nonce))},display:true});const read=await ctx.executeTool('read',{path:${JSON.stringify(desktopSkillPath)}});if(read.isError)throw new Error('Actual skill read failed');await appendFile(join(ctx.cwd,'desktop-skill-read-completions.jsonl'),JSON.stringify({nonce:${JSON.stringify(f.nonce)},callId:read.toolCall.id})+'\\n');return {content:[{type:'text',text:${JSON.stringify('extension actual ' + f.nonce)}},...read.result.content],details:{}};}}); }\n`);
    if(ownedComplete) await writeFile(join(f.project,'.pi/extensions/active-complete.ts'),desktopActiveExtensionSource(f.nonce));
    if(ownedStream) await writeFile(join(f.project,'.pi/extensions/active-stream.ts'),(ownedVirtual ? desktopVirtualExtensionSource(f.nonce,virtualWait) : ownedProviderHeader ? desktopProviderHeaderExtensionSource(f.nonce) : desktopStreamExtensionSource(f.nonce)));
    await writeFile(join(f.project, '.pi/mcp.json'), JSON.stringify({ mcpServers: { fixture: {
      command: process.execPath, args: [resolve(import.meta.dirname, 'ordinary-mcp-fixture.mjs'), f.project, f.nonce], exposure: 'direct', enabled: true,
    } } }));
    f.server = await startCodingLoopback({ prefixCalls: calls(f.nonce), holdFinal, callsOverride,
      ...(ownedProviderHeader ? {expectedProviderHeader:f.nonce} : {}),
      // route等待例应当零inner；仍识别并记录意外inner，但不能套“已有held HTTP须结束”的旧stream前提。
      ...(ownedStream ? {ownedComplete:{marker:desktopStreamInput(f.nonce),text:desktopStreamText(f.nonce),responseId:'desktop-stream-'+f.nonce,...(virtualWait?{}:{stream:{prefix:desktopStreamPrefix(f.nonce)}})}}
        : ownedComplete ? {ownedComplete:{marker:'DESKTOP_ACTIVE_INPUT_'+f.nonce,text:'DESKTOP_ACTIVE_RESULT_'+f.nonce,responseId:'desktop-active-'+f.nonce}} : {}) });
    f.env = { DCODE_VALIDATION_ASSEMBLY: '', DCODE_VALIDATION_SAMPLE: '0', DCODE_CATALOG_BASE_URL: `${f.server.origin}/catalog`, ...((ownedComplete || ownedStream) ? {DCODE_E2E_VISIBLE:'0'} : {}) };
    f.handle = await launchApp(f.stateDir, f.env, '.', { prebindProject: false }); f.proc = f.handle.app.process(); await ready(f.handle.page);
    await configureModel(f.handle.page, f.server); f.workspace = await bindProject(f.handle, f.project, '真实扩展 MCP 空间');
    assert.deepEqual(await events(f.project), []); assert.equal(f.server.requests.length, 0);
    await enableResources(f.handle.page, f.stateDir);
    assert.deepEqual(await events(f.project), [], '保存启用意图不连接/执行项目代码'); assert.equal(f.server.requests.length, 0);
    await action(f);
  } catch (error) { primary = error; }
  finally {
    if (f.handle) {
      try { await f.handle.close(); } catch (error) { secondary.push(error); }
      if (f.proc?.exitCode === null && f.proc.signalCode === null) {
        try { await killApp(f.handle); } catch (error) { secondary.push(error); }
      }
    }
    if (f.server) { try { await f.server.close(); } catch (error) { secondary.push(error); } }
    if (f.proc?.exitCode === null && f.proc.signalCode === null) secondary.push(Error('owned Electron remains alive; preserve isolated data'));
    else { try { await rm(root, { recursive: true, force: true }); } catch (error) { secondary.push(error); } }
  }
  if (primary && secondary.length) throw new AggregateError([primary, ...secondary], '业务及清理失败分别保留');
  if (primary) throw primary; if (secondary.length) throw new AggregateError(secondary, '真实关闭/清理失败');
}

// 1) 项目扩展 + MCP read/append/error，再保原编码1→0/diff；暂停与重开不重放。
test('普通桌面启用：真实项目扩展/MCP作用与错误进入UI和下一HTTP；暂停重开只读，继续不重放', async () => withFixture({ holdFinal: true,
  calls: nonce => [['extension_nonce', {}], ['mcp__fixture__read', {}], ['mcp__fixture__append_once', { token: 'desktop_once', text: nonce }], ['mcp__fixture__fail', { token: 'handled_error' }]],
}, async f => {
  const page = f.handle.page, input = `真实扩展 MCP 与编码 ${f.nonce}`;
  const composer = page.getByPlaceholder(/交代需求|Describe|追问、补充|Follow up/).first(); await composer.fill(input); await composer.press('Enter');
  const snapshot = await waitForSnapshot(page, value => f.server.requests.length === 10 && Object.values(value.timelines).some(blocks =>
    blocks.filter(block => block.kind === 'tool').length === 10 && blocks.filter(block => block.kind === 'tool').every(block => ['done', 'failed'].includes(block.tool.status))));
  const sessionId = Object.keys(snapshot.timelines).find(id => snapshot.timelines[id].some(block => block.kind === 'message' && block.role === 'user' && block.text === input));
  assert.ok(sessionId); const blocks = snapshot.timelines[sessionId], tools = blocks.filter(block => block.kind === 'tool');
  const extension = tools.find(block => block.tool.name === 'extension_nonce'); assert.ok(extension); assert.match(extension.tool.output, new RegExp(f.nonce));
  const extensionMessage = await visibleExtensionMessage(page, snapshot, sessionId, f.server, f.nonce);
  const skillRead = await visibleDesktopSkillRead(page, snapshot, sessionId, f);
  const read = tools.find(block => block.tool.name === 'mcp__fixture__read'); assert.ok(read); assert.match(await (await visibleTool(page, read)).innerText(), new RegExp(`actual MCP input ${f.nonce}`));
  const fail = tools.find(block => block.tool.name === 'mcp__fixture__fail'); assert.ok(fail); assert.equal(fail.tool.status, 'failed');
  assert.match(await (await visibleTool(page, fail)).innerText(), /expected-tool-error/); assert.match(fail.tool.output, new RegExp(f.nonce));
  assert.ok(f.server.requests[4].body.messages.some(message => message.role === 'tool' && message.content.includes('expected-tool-error') && message.content.includes(f.nonce)), '真实错误正文进入下一个 SDK 请求');
  assert.deepEqual(await effects(f.project), [{ nonce: f.nonce, token: 'desktop_once', text: f.nonce }]);
  assert.match(await readFile(join(f.project, 'index.mjs'), 'utf8'), /return a \+ b/);
  assert.deepEqual(tools.filter(block => block.tool.name === 'bash').map(block => [block.tool.exitCode, block.tool.status]), [[1, 'failed'], [0, 'done']]);
  const edit = blocks.find(block => block.kind === 'change-summary' && block.files.some(file => file.path.endsWith('index.mjs'))); assert.ok(edit);
  await page.locator(`button[data-block-id="${edit.id}"]`).click();
  const inspector = page.locator('.app-inspector'); await inspector.waitFor({ state: 'visible' });
  await inspector.getByRole('button', { name: 'index.mjs', exact: true }).click(); assert.match(await inspector.innerText(), /return a - b/); assert.match(await inspector.innerText(), /return a \+ b/);
  await page.getByRole('button', { name: /关闭检查器|Close inspector/ }).click();
  const ids = tools.map(block => block.id); await pauseAndDrain(f, sessionId); assert.equal(f.server.requests.length, 10);
  const reopened = await reopenReadonly(f, sessionId, 10);
  assert.deepEqual(reopened.timelines[sessionId].filter(block => block.kind === 'tool').map(block => block.id), ids);
  assert.equal((await visibleExtensionMessage(f.handle.page, reopened, sessionId, f.server, f.nonce)).id, extensionMessage.id);
  assert.deepEqual(await visibleDesktopSkillRead(f.handle.page, reopened, sessionId, f),skillRead);
  f.server.releaseFinal(); const primary = f.handle.page.locator('button[data-slot="composer-primary"]'); assert.match(await primary.getAttribute('aria-label'), /^继续执行$|^Resume$/); await primary.click();
  await f.handle.page.getByText(f.server.nonce, { exact: true }).waitFor();
  const final = await waitForSnapshot(f.handle.page, value => value.runs[sessionId]?.status === 'ready' && value.runs[sessionId]?.pendingInputs === 0);
  assert.equal(f.server.requests.length, 11); assert.equal(final.timelines[sessionId].filter(block => block.kind === 'message' && block.role === 'user').length, 1);
  assert.deepEqual(final.timelines[sessionId].filter(block => block.kind === 'tool').map(block => block.id), ids);
  assert.equal((await visibleExtensionMessage(f.handle.page, final, sessionId, f.server, f.nonce)).id, extensionMessage.id);
  assert.deepEqual(await visibleDesktopSkillRead(f.handle.page, final, sessionId, f),skillRead);
  assert.equal((await events(f.project)).filter(item => item.type === 'call.start' && item.tool === 'append_once').length, 1);
  assert.deepEqual(await effects(f.project), [{ nonce: f.nonce, token: 'desktop_once', text: f.nonce }]);
  assert.ok(f.server.requests.every(request => request.authOk && request.body.model === codingModel)); assert.deepEqual(f.server.errors, []);
}));

// 2) 已完成作用 + 真正wait在途：按requestId消费取消，暂停关闭drain，RO不连接。
for(const closing of ['pause','close'])test(`普通桌面 MCP 在途 ${closing}：先完成副作用，再关闭同requestId wait；重开零连接，继续原输入不重放`, async () => withFixture({
  calls: nonce => [['extension_nonce', {}], ['mcp__fixture__append_once', { token: 'before_wait', text: nonce }], ['mcp__fixture__wait', { token: 'parked' }]],
}, async f => {
  const page = f.handle.page, input = `真实 MCP 等待取消 ${f.nonce}`;
  const composer = page.getByPlaceholder(/交代需求|Describe|追问、补充|Follow up/).first(); await composer.fill(input); await composer.press('Enter');
  let parked;
  const running = await waitForSnapshot(page, async snapshot => {
    parked = (await events(f.project)).find(item => item.type === 'wait.pending');
    return !!parked && snapshot.sessions.some(session => snapshot.timelines[session.id]?.some(block => block.kind === 'message' && block.role === 'user' && block.text === input)
      && snapshot.timelines[session.id]?.some(block => block.kind === 'extension-message' && block.customType === 'fixture-extension' && block.text === extensionVisibleText(f.nonce))
      && snapshot.timelines[session.id]?.some(block => block.kind === 'tool' && block.tool.name === 'mcp__fixture__append_once' && block.tool.status === 'done')
      && snapshot.timelines[session.id]?.some(block => block.kind === 'tool' && block.tool.name === 'read' && block.tool.status === 'done' && block.tool.output.includes(desktopSkillBody(f.nonce))));
  });
  const sessionId = running.sessions.find(session => running.timelines[session.id]?.some(block => block.kind === 'message' && block.role === 'user' && block.text === input)).id;
  assert.equal(f.server.requests.length, 3); assert.deepEqual(await effects(f.project), [{ nonce: f.nonce, token: 'before_wait', text: f.nonce }]);
  const extensionMessage = await visibleExtensionMessage(page, running, sessionId, f.server, f.nonce);
  const skillRead = await visibleDesktopSkillRead(page, running, sessionId, f);
  const done = running.timelines[sessionId].find(block => block.kind === 'tool' && block.tool.name === 'mcp__fixture__append_once'); assert.ok(done); assert.equal(done.tool.status, 'done');
  assert.match(await (await visibleTool(page, done)).innerText(), new RegExp(f.nonce));
  if(closing==='pause')await pauseAndDrain(f,sessionId);else await f.handle.close();
  const closed = await events(f.project);
  assert.ok(closed.some(item=>item.type==='close.drained'&&item.pending===0));
  assert.ok(closed.some(item=>item.type==='exit'&&item.code===0));
  assert.ok(closed.some(item => item.type === 'cancel.received' && item.requestId === parked.requestId && item.matched));
  assert.equal(f.server.requests.length, 3, '取消与停止之间没有漏出下一模型请求');
  assert.deepEqual(await effects(f.project), [{ nonce: f.nonce, token: 'before_wait', text: f.nonce }]);
  const reopened = await reopenReadonly(f, sessionId, 3);
  assert.equal((await visibleExtensionMessage(f.handle.page, reopened, sessionId, f.server, f.nonce)).id, extensionMessage.id);
  assert.deepEqual(await visibleDesktopSkillRead(f.handle.page, reopened, sessionId, f),skillRead);
  const primary = f.handle.page.locator('button[data-slot="composer-primary"]'); assert.match(await primary.getAttribute('aria-label'), /^继续执行$|^Resume$/); await primary.click();
  await f.handle.page.getByText(f.server.nonce, { exact: true }).waitFor();
  const final = await waitForSnapshot(f.handle.page, value => value.runs[sessionId]?.status === 'ready' && value.runs[sessionId]?.pendingInputs === 0);
  const records = await events(f.project);
  assert.equal(records.filter(item => item.type === 'call.start' && item.tool === 'append_once').length, 1);
  assert.equal(records.filter(item => item.type === 'call.start' && item.tool === 'wait').length, 1);
  assert.equal(records.filter(item => item.type === 'effect.committed').length, 1);
  assert.deepEqual(await effects(f.project), [{ nonce: f.nonce, token: 'before_wait', text: f.nonce }]);
  assert.equal(final.timelines[sessionId].filter(block => block.kind === 'message' && block.role === 'user').length, 1);
  assert.equal(final.timelines[sessionId].find(block => block.id === done.id)?.tool.name, 'mcp__fixture__append_once');
  assert.equal((await visibleExtensionMessage(f.handle.page, final, sessionId, f.server, f.nonce)).id, extensionMessage.id);
  assert.deepEqual(await visibleDesktopSkillRead(f.handle.page, final, sessionId, f),skillRead);
  assert.equal(f.server.requests.length, 9); assert.ok(f.server.requests.every(request => request.authOk && request.body.model === codingModel)); assert.deepEqual(f.server.errors, []);
}));


const desktopActiveToolName='desktop_active_complete';
function desktopActiveExtensionSource(nonce) {return `import {Type} from 'typebox';export default function(pi){
    pi.registerTool({name:${JSON.stringify(desktopActiveToolName)},label:'desktop owned complete',description:'One real owned complete from the desktop tool task',parameters:Type.Object({}),async execute(id,args,signal,onUpdate,ctx){
      if(!signal||ctx.signal!==signal||signal.aborted)throw new Error('Original tool signal missing');
      const model=ctx.modelRegistry.find('user-defined',${JSON.stringify(codingModel)});if(!model)throw new Error('Configured chat model missing');
      const result=await ctx.modelRegistry.complete(model,{messages:[{role:'user',content:${JSON.stringify('DESKTOP_ACTIVE_INPUT_'+nonce)},timestamp:Date.now()}]},{signal,maxRetries:0,maxTokens:32,temperature:0});
      const observed={nonce:${JSON.stringify(nonce)},originalToolCallId:id,message:{role:result.role,provider:result.provider,model:result.model,responseId:result.responseId,stopReason:result.stopReason,text:result.content.filter(part=>part.type==='text').map(part=>part.text).join(''),usage:result.usage}};
      return {content:[{type:'text',text:JSON.stringify(observed)}],details:{ownedModelObservation:observed}};
    }});}`;}

const desktopActiveUsage={input:120,output:15,cacheRead:0,cacheWrite:0,requests:3};
function desktopActiveUsageFacts(snapshot,sessionId,f) {
  const session=snapshot.sessions.find(item=>item.id===sessionId);assert.ok(session);
  const used=snapshot.sessionModels[sessionId],summary=snapshot.taskUsage[session.taskId];assert.ok(used);assert.ok(summary);
  assert.equal(used.actual?.sourceId,'user-defined');assert.equal(used.actual?.modelId,codingModel);assert.equal(used.lastResult,'succeeded');
  assert.deepEqual(used.usage,desktopActiveUsage,'主动complete的真实响应必须计入会话用量，不能只数两个外层响应');
  const responseIds=['actual-response-1','actual-response-2',f.server.completeRequests[0].responseId].sort();
  assert.equal(used.requests.length,3);assert.deepEqual(used.requests.map(item=>item.responseId).sort(),responseIds);
  assert.equal(new Set(used.requests.map(item=>item.responseId)).size,3);assert.ok(used.requests.every(item=>item.sourceId==='user-defined'&&item.usage.requests===1));
  const direct=used.requests.find(item=>item.responseId===f.server.completeRequests[0].responseId);
  assert.deepEqual(direct.usage,{input:117,output:13,cacheRead:0,cacheWrite:0,requests:1});
  assert.equal(used.actualResponseId,'actual-response-2','最后实际采用仍是最后外层响应，不由工具返回伪造');
  assert.equal(summary.taskId,session.taskId);assert.deepEqual(summary.totals,desktopActiveUsage);assert.equal(summary.incompleteReason,null);
  const scope=summary.scope.filter(item=>(item.usage?.requests??0)>0);assert.equal(scope.length,1);assert.equal(scope[0].sessionId,sessionId);assert.deepEqual(scope[0].usage,desktopActiveUsage);
  const sources=summary.bySource.filter(item=>item.usage.requests>0);assert.equal(sources.length,1);assert.equal(sources[0].sourceId,'user-defined');assert.deepEqual(sources[0].usage,desktopActiveUsage);
  return {taskId:session.taskId,usage:used.usage,requests:used.requests,task:{totals:summary.totals,scope:summary.scope,bySource:summary.bySource,incompleteReason:summary.incompleteReason}};
}
async function visibleDesktopActiveUsage(page,sessionId,phase,f) {
  await page.getByTestId('model-entry-trigger').click();await page.getByTestId('model-search').waitFor({state:'visible'});
  const task=page.getByTestId('model-usage-task'),session=page.getByTestId('model-usage-session');await task.waitFor({state:'visible'});await session.waitFor({state:'visible'});
  for(const text of [await task.innerText(),await session.innerText()]) {
    assert.match(text,/输入 120／输出 15／缓存读 0／缓存写 0|in 120 \/ out 15 \/ cache read 0 \/ cache write 0/);
    assert.match(text,/3 次请求|3 request\(s\)/);
  }
  await page.getByTestId('model-usage-scope-toggle').click();await page.getByTestId(`model-usage-scope-${sessionId}`).waitFor({state:'visible'});
  await task.screenshot({path:join(evidenceDir('ordinary-extension-mcp'),`${sessionId}-active-usage-${phase}-${f.nonce}.png`)});
  await page.keyboard.press('Escape');
}

test('普通桌面active complete：开启意图不执行，真实内层HTTP与工具正文计入任务用量；关闭只读重开不重发',async()=>withFixture({
  calls:()=>[],callsOverride:[[desktopActiveToolName,{}]],ownedComplete:true,
},async f=>{
  // 原fixture前置通过普通设置/绑定/开启，且已严格核保存意图后零模型请求/MCP连接；不预写产品状态。
  assert.equal(f.server.requests.length,0);assert.deepEqual(f.server.completeRequests,[]);
  const windows=await f.handle.app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().map(window=>({visible:window.isVisible(),focused:window.isFocused(),focusable:window.isFocusable()})));assert.ok(windows.length>0);assert.ok(windows.every(window=>!window.visible&&!window.focused&&!window.focusable));

  const input='普通桌面主动单次模型 '+f.nonce,page=f.handle.page;
  const composer=page.getByPlaceholder(/交代需求|Describe|追问、补充|Follow up/).first();await composer.fill(input);await composer.press('Enter');
  const complete=await waitForSnapshot(page,snapshot=>snapshot.sessions.some(session=>snapshot.timelines[session.id]?.some(block=>block.kind==='message'&&block.role==='user'&&block.text===input)
    &&snapshot.timelines[session.id]?.some(block=>block.kind==='tool'&&block.tool.name===desktopActiveToolName&&block.tool.status==='done')
    &&snapshot.runs[session.id]?.status==='ready'&&snapshot.runs[session.id]?.pendingInputs===0));
  const sessionId=complete.sessions.find(session=>complete.timelines[session.id]?.some(block=>block.kind==='message'&&block.role==='user'&&block.text===input)).id;
  await page.getByText(f.server.nonce,{exact:true}).waitFor({state:'visible'});
  assert.equal(f.server.requests.length,2);assert.equal(f.server.completeRequests.length,1);assert.deepEqual(f.server.errors,[]);
  assert.ok(f.server.requests.every(item=>item.authOk&&item.body.model===codingModel));const direct=f.server.completeRequests[0];assert.equal(direct.accepted,true);assert.equal(direct.finished,true);assert.equal(direct.authOk,true);assert.equal(direct.model,codingModel);
  const tools=complete.timelines[sessionId].filter(block=>block.kind==='tool');assert.equal(tools.length,1);const block=tools[0];assert.equal(block.tool.name,desktopActiveToolName);
  const observed=JSON.parse(block.tool.output);assert.equal(observed.nonce,f.nonce);assert.equal(observed.originalToolCallId,'actual-tool-1');
  assert.equal(observed.message.role,'assistant');assert.equal(observed.message.provider,'user-defined');assert.equal(observed.message.model,codingModel);assert.equal(observed.message.stopReason,'stop');
  assert.equal(observed.message.responseId,direct.responseId);assert.equal(observed.message.text,'DESKTOP_ACTIVE_RESULT_'+f.nonce);
  assert.equal(observed.message.usage.input,117);assert.equal(observed.message.usage.output,13);assert.equal(observed.message.usage.cacheRead,0);assert.equal(observed.message.usage.cacheWrite,0);assert.equal(observed.message.usage.totalTokens,130);
  const forwarded=f.server.requests[1].body.messages.filter(message=>message.role==='tool'&&message.tool_call_id==='actual-tool-1');assert.equal(forwarded.length,1);assert.equal(httpMessageText(forwarded[0]),block.tool.output);
  assert.equal(complete.timelines[sessionId].filter(item=>item.kind==='message'&&item.role==='assistant'&&item.text===f.server.nonce).length,1);assert.ok(!complete.timelines[sessionId].some(item=>item.kind==='message'&&item.role==='assistant'&&item.text.includes(observed.message.text)),'内层返回是工具正文，不伪造对话助手');
  const pre=await visibleTool(page,block);assert.ok((await pre.innerText()).includes(observed.message.text));await pre.screenshot({path:join(evidenceDir('ordinary-extension-mcp'),`${sessionId}-active-tool-before-close-${f.nonce}.png`)});
  const usageReady=await waitForSnapshot(page,snapshot=>snapshot.sessionModels[sessionId]?.actualResponseId==='actual-response-2'&&snapshot.sessionModels[sessionId]?.lastResult==='succeeded'
    &&snapshot.taskUsage[snapshot.sessions.find(session=>session.id===sessionId)?.taskId]?.totals!=null,undefined,'最终真实响应及任务汇总应先可读');
  const before=desktopActiveUsageFacts(usageReady,sessionId,f);await visibleDesktopActiveUsage(page,sessionId,'before-close',f);
  const user=complete.timelines[sessionId].find(item=>item.kind==='message'&&item.role==='user');assert.ok(user.operationId);
  await f.handle.close();assert.equal(f.proc.exitCode,0);assert.equal(f.proc.signalCode,null);
  const drained=await events(f.project),starts=drained.filter(item=>item.type==='start');assert.ok(starts.length>0);
  assert.ok(starts.every(start=>drained.some(item=>item.pid===start.pid&&item.type==='close.drained'&&item.pending===0)&&drained.some(item=>item.pid===start.pid&&item.type==='exit'&&item.code===0)));
  const reopened=await reopenReadonly(f,sessionId,2);assert.equal(reopened.settings.projectExtensionsEnabled,true);assert.ok(['ready','paused'].includes(reopened.runs[sessionId].status));assert.equal(reopened.runs[sessionId].pendingInputs,0);
  assert.equal(reopened.timelines[sessionId].filter(item=>item.kind==='message'&&item.role==='user').length,1);assert.equal(reopened.timelines[sessionId].find(item=>item.id===user.id)?.operationId,user.operationId);
  const reopenedWindows=await f.handle.app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().map(window=>({visible:window.isVisible(),focused:window.isFocused(),focusable:window.isFocusable()})));assert.ok(reopenedWindows.every(window=>!window.visible&&!window.focused&&!window.focusable));
  const restored=reopened.timelines[sessionId].filter(item=>item.kind==='tool'&&item.tool.name===desktopActiveToolName);assert.equal(restored.length,1);assert.equal(restored[0].id,block.id);assert.equal(restored[0].tool.status,'done');assert.equal(restored[0].tool.output,block.tool.output);
  assert.deepEqual(desktopActiveUsageFacts(reopened,sessionId,f),before);await visibleDesktopActiveUsage(f.handle.page,sessionId,'readonly-reopen',f);
  const restoredPre=await visibleTool(f.handle.page,restored[0]);await restoredPre.screenshot({path:join(evidenceDir('ordinary-extension-mcp'),`${sessionId}-active-tool-readonly-reopen-${f.nonce}.png`)});
  await f.handle.page.evaluate(({sessionId,blockId})=>window.dcode.checkReceipt({sessionId,blockId}),{sessionId,blockId:user.id});
  const last=await f.handle.page.evaluate(()=>window.dcode.getSnapshot());assert.deepEqual(desktopActiveUsageFacts(last,sessionId,f),before);
  assert.equal(f.server.requests.length,2);assert.equal(f.server.completeRequests.length,1);assert.equal(f.server.completeRequests[0],direct);assert.deepEqual(f.server.errors,[]);
  assert.equal((await events(f.project)).filter(item=>item.type==='start').length,starts.length,'只读用量/历史/回执不重连资源');
  await writeFile(join(evidenceDir('ordinary-extension-mcp'),`${sessionId}-active-complete-actions-${f.nonce}.json`),JSON.stringify({nonce:f.nonce,sessionId,taskId:before.taskId,userBlockId:user.id,operationId:user.operationId,toolBlockId:block.id,directResponseId:direct.responseId,outerResponseIds:['actual-response-1','actual-response-2'],httpCounts:{outer:2,inner:1},before,after:desktopActiveUsageFacts(last,sessionId,f),normalClose:{exitCode:0,signalCode:null},readonlyReopen:true,reopenPhase:last.runs[sessionId].status},null,2));
}));


// 下一片真实stream的普通桌面资产：原四条场景原样保留，不用done正文倒推partial可见。
const desktopStreamToolName='desktop_active_stream';
const desktopStreamInput=nonce=>'DESKTOP_STREAM_INPUT_'+nonce;
const desktopStreamPrefix=nonce=>'DESKTOP_STREAM_PARTIAL_'+nonce;
const desktopStreamText=nonce=>desktopStreamPrefix(nonce)+'\nDESKTOP_STREAM_FINAL_'+nonce;
const desktopStreamTraceFile='desktop-owned-stream-trace.json';
function desktopStreamExtensionSource(nonce) {return `import {Type} from 'typebox';import {writeFile,rename} from 'node:fs/promises';import {join} from 'node:path';
export default function(pi){pi.registerTool({name:${JSON.stringify(desktopStreamToolName)},label:'desktop owned stream',description:'One actual owned SDK stream with a live desktop tool update',parameters:Type.Object({}),
async execute(id,args,signal,onUpdate,ctx){
  if(!signal||ctx.signal!==signal||signal.aborted)throw new Error('Original tool signal missing');
  const trace={nonce:${JSON.stringify(nonce)},callId:id,steps:[]},file=join(ctx.cwd,${JSON.stringify(desktopStreamTraceFile)});let writes=Promise.resolve();
  const note=(phase,data={})=>{trace.steps.push({seq:trace.steps.length+1,phase,...data});const bytes=JSON.stringify(trace);writes=writes.then(async()=>{await writeFile(file+'.tmp',bytes);await rename(file+'.tmp',file);});return writes;};
  await note('execute-start');
  const model=ctx.modelRegistry.find('user-defined',${JSON.stringify(codingModel)});if(!model)throw new Error('Configured chat model missing');
  const stream=ctx.modelRegistry.streamSimple(model,{messages:[{role:'user',content:${JSON.stringify(desktopStreamInput(nonce))},timestamp:Date.now()}]},
    {signal,maxRetries:0,maxTokens:32,temperature:0});
  const synchronousStream=typeof stream?.then!=='function'&&typeof stream?.[Symbol.asyncIterator]==='function'&&typeof stream?.result==='function';
  await note('factory-returned',{synchronousStream});if(!synchronousStream)throw new Error('Public synchronous stream contract missing');
  const eventTypes=[];let deltas='';
  try{
    for await(const event of stream){
      eventTypes.push(event.type);
      if(event.type==='text_delta'){
        deltas+=event.delta;onUpdate?.({content:[{type:'text',text:deltas}]});
        await note('text-delta',{delta:event.delta,output:deltas,contentIndex:event.contentIndex,signalAborted:signal.aborted});
      }else if(event.type==='done'||event.type==='error')await note('terminal-event',{type:event.type,reason:event.reason,signalAborted:signal.aborted});
    }
    const result=await stream.result();
    await note('result-settled',{stopReason:result.stopReason,signalAborted:signal.aborted});
    if(signal.aborted||result.stopReason!=='stop')throw new Error('Interrupted stream cannot publish completed tool success');
    const observed={nonce:${JSON.stringify(nonce)},originalToolCallId:id,method:'streamSimple',synchronousStream,eventTypes,deltas,
      message:{role:result.role,provider:result.provider,model:result.model,responseId:result.responseId,stopReason:result.stopReason,
        text:result.content.filter(part=>part.type==='text').map(part=>part.text).join(''),usage:result.usage}};
    await note('handler-returning');return {content:[{type:'text',text:JSON.stringify(observed)}],details:{ownedModelObservation:observed}};
  }catch(error){await note('handler-error',{signalAborted:signal.aborted});throw error;}
}});}`;}
async function desktopStreamTrace(f) {
  try{return JSON.parse(await readFile(join(f.project,desktopStreamTraceFile),'utf8'));}
  catch(error){if(error.code==='ENOENT')return undefined;throw error;}
}
async function desktopStreamWindows(f) {
  const windows=await f.handle.app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().map(window=>({visible:window.isVisible(),focused:window.isFocused(),focusable:window.isFocusable()})));
  assert.ok(windows.length>0);assert.ok(windows.every(window=>!window.visible&&!window.focused&&!window.focusable));return windows;
}
async function desktopStreamPartial(f,input,phase) {
  const page=f.handle.page;let trace;
  const running=await waitForSnapshot(page,async snapshot=>{
    trace=await desktopStreamTrace(f);
    const session=snapshot.sessions.find(item=>snapshot.timelines[item.id]?.some(block=>block.kind==='message'&&block.role==='user'&&block.text===input));
    if(!session)return false;const tools=snapshot.timelines[session.id].filter(block=>block.kind==='tool'&&block.tool.name===desktopStreamToolName);
    return tools.some(block=>['done','failed'].includes(block.tool.status)) || (f.server.completeRequests.length===1
      &&trace?.steps.some(step=>step.phase==='text-delta')&&tools.some(block=>block.tool.status==='running'&&block.tool.output===desktopStreamPrefix(f.nonce)));
  },undefined,'真实stream必须在服务端扣住final时把partial交到运行工具块；准备/工具错误不替代');
  const session=running.sessions.find(item=>running.timelines[item.id]?.some(block=>block.kind==='message'&&block.role==='user'&&block.text===input));assert.ok(session);
  const sessionId=session.id,blocks=running.timelines[sessionId],tools=blocks.filter(block=>block.kind==='tool'&&block.tool.name===desktopStreamToolName);
  assert.equal(tools.length,1);const block=tools[0];assert.equal(block.tool.status,'running');assert.equal(block.tool.output,desktopStreamPrefix(f.nonce));
  assert.equal(running.runs[sessionId].status,'running');assert.ok(running.runs[sessionId].pendingInputs>0,'原输入确实仍在途，不用ready作为已接收捷径');
  const users=blocks.filter(item=>item.kind==='message'&&item.role==='user'&&item.text===input);assert.equal(users.length,1);assert.ok(users[0].operationId);
  assert.equal(f.server.requests.length,1,'partial在途不能漏出外层续请求');assert.equal(f.server.completeRequests.length,1);const direct=f.server.completeRequests[0];
  assert.equal(direct.accepted,true);assert.equal(direct.partialSent,true);assert.equal(direct.finished,false);assert.equal(direct.closedBeforeFinal,false);assert.equal(direct.authOk,true);assert.equal(direct.model,codingModel);assert.deepEqual(f.server.errors,[]);
  assert.equal(trace.nonce,f.nonce);assert.equal(trace.callId,'actual-tool-1');assert.equal(trace.steps.filter(step=>step.phase==='execute-start').length,1);
  assert.equal(trace.steps.find(step=>step.phase==='factory-returned').synchronousStream,true);
  const deltas=trace.steps.filter(step=>step.phase==='text-delta');assert.equal(deltas.map(step=>step.delta).join(''),desktopStreamPrefix(f.nonce));
  assert.ok(deltas.every(step=>Number.isInteger(step.contentIndex)&&step.contentIndex>=0&&!step.signalAborted));
  assert.ok(!trace.steps.some(step=>['terminal-event','result-settled','handler-returning','handler-error'].includes(step.phase)), '真实final还扣住时不能用终态结果生成假partial');
  assert.equal(blocks.filter(item=>item.kind==='message'&&item.role==='assistant'&&item.text.includes(desktopStreamText(f.nonce))).length,0);
  const pre=await visibleTool(page,block);assert.equal(await pre.innerText(),desktopStreamPrefix(f.nonce));assert.ok((await pre.innerText()).includes(f.nonce));
  const trigger=page.getByRole('button',{name:new RegExp(`^(工具结果|Tool result) ${escapeRegex(block.tool.name)} ${escapeRegex(block.tool.primaryText)} `,'i')});
  const row=page.locator('[data-slot="tool"]').filter({has:trigger});assert.equal(await row.count(),1);
  assert.match(await trigger.getAttribute('aria-label'),/执行中|Running/);
  const png=join(evidenceDir('ordinary-extension-mcp'),`${sessionId}-stream-${phase}-partial-running-${f.nonce}.png`);await row.screenshot({path:png});
  // 截图结束才允许释放final；截图只能在未来真实运行后证明实际像素，本草稿不自称已有图。
  assert.equal(direct.finished,false);assert.equal(direct.closedBeforeFinal,false);assert.equal(f.server.requests.length,1);
  return {sessionId,user:users[0],partialBlockId:block.id,direct,partialTrace:trace,png,windows:await desktopStreamWindows(f)};
}
async function desktopStreamDrained(f) {
  const records=await events(f.project),starts=records.filter(item=>item.type==='start');assert.ok(starts.length>0);
  assert.ok(starts.every(start=>records.some(item=>item.pid===start.pid&&item.type==='close.drained'&&item.pending===0)
    &&records.some(item=>item.pid===start.pid&&item.type==='exit'&&item.code===0)));
  return {starts:starts.length,events:records.filter(item=>['start','close.drained','exit'].includes(item.type))};
}
function desktopStreamSameOriginal(snapshot,sessionId,user,input) {
  const users=snapshot.timelines[sessionId].filter(block=>block.kind==='message'&&block.role==='user');assert.equal(users.length,1);
  assert.equal(users[0].id,user.id);assert.equal(users[0].operationId,user.operationId);assert.equal(users[0].text,input);
}
async function desktopStreamNoReexecute(f) {
  const trace=await desktopStreamTrace(f);assert.equal(trace.nonce,f.nonce);assert.equal(trace.callId,'actual-tool-1');
  assert.equal(trace.steps.filter(step=>step.phase==='execute-start').length,1,'重开/继续不能再次执行原stream处理器');
  assert.equal(trace.steps.filter(step=>step.phase==='factory-returned').length,1);return trace;
}

async function desktopStreamSuccess(f) {
  assert.equal(f.server.requests.length,0);assert.deepEqual(f.server.completeRequests,[]);await desktopStreamWindows(f);
  const input='普通桌面真实流 '+f.nonce,page=f.handle.page,composer=page.getByPlaceholder(/交代需求|Describe|追问、补充|Follow up/).first();
  await composer.fill(input);await composer.press('Enter');const held=await desktopStreamPartial(f,input,'success');
  f.server.releaseOwnedStream();
  const completed=await waitForSnapshot(page,snapshot=>snapshot.timelines[held.sessionId]?.some(block=>block.kind==='tool'&&block.tool.name===desktopStreamToolName&&block.tool.status==='done')
    &&snapshot.runs[held.sessionId]?.status==='ready'&&snapshot.runs[held.sessionId]?.pendingInputs===0);
  await page.getByText(f.server.nonce,{exact:true}).waitFor({state:'visible'});
  assert.equal(f.server.requests.length,2);assert.equal(f.server.completeRequests.length,1);assert.equal(f.server.completeRequests[0],held.direct);assert.equal(held.direct.finished,true);assert.equal(held.direct.closedBeforeFinal,false);
  assert.ok(f.server.requests.every(request=>request.authOk&&request.body.model===codingModel));assert.deepEqual(f.server.errors,[]);
  const tools=completed.timelines[held.sessionId].filter(block=>block.kind==='tool'&&block.tool.name===desktopStreamToolName);assert.equal(tools.length,1);const block=tools[0];
  const observed=JSON.parse(block.tool.output);assert.equal(observed.nonce,f.nonce);assert.equal(observed.originalToolCallId,'actual-tool-1');assert.equal(observed.method,'streamSimple');assert.equal(observed.synchronousStream,true);
  assert.equal(observed.message.role,'assistant');assert.equal(observed.message.provider,'user-defined');assert.equal(observed.message.model,codingModel);assert.equal(observed.message.responseId,held.direct.responseId);
  assert.equal(observed.message.stopReason,'stop');assert.equal(observed.message.text,desktopStreamText(f.nonce));assert.equal(observed.deltas,desktopStreamText(f.nonce));
  assert.ok(observed.eventTypes.includes('start'));assert.ok(observed.eventTypes.includes('text_delta'));assert.equal(observed.eventTypes.filter(type=>type==='done').length,1);assert.ok(!observed.eventTypes.includes('error'));
  assert.equal(observed.message.usage.input,117);assert.equal(observed.message.usage.output,13);assert.equal(observed.message.usage.cacheRead,0);assert.equal(observed.message.usage.cacheWrite,0);assert.equal(observed.message.usage.totalTokens,130);
  const forwarded=f.server.requests[1].body.messages.filter(message=>message.role==='tool'&&message.tool_call_id==='actual-tool-1');assert.equal(forwarded.length,1);assert.equal(httpMessageText(forwarded[0]),block.tool.output);
  assert.ok(!completed.timelines[held.sessionId].some(item=>item.kind==='message'&&item.role==='assistant'&&item.text.includes(desktopStreamText(f.nonce))),'inner流是工具正文，不伪造对话助手');
  const finalPre=await visibleTool(page,block);assert.ok((await finalPre.innerText()).includes(desktopStreamText(f.nonce).replace('\n','\\n')),'JSON正式结果必须保完整本次流文本');
  const finalPng=join(evidenceDir('ordinary-extension-mcp'),`${held.sessionId}-stream-final-tool-${f.nonce}.png`);await finalPre.screenshot({path:finalPng});
  const usageReady=await waitForSnapshot(page,snapshot=>snapshot.sessionModels[held.sessionId]?.actualResponseId==='actual-response-2'&&snapshot.sessionModels[held.sessionId]?.lastResult==='succeeded'
    &&snapshot.taskUsage[snapshot.sessions.find(session=>session.id===held.sessionId)?.taskId]?.totals!=null,undefined,'真实流终态与任务汇总发布后才能核120/15/3');
  const before=desktopActiveUsageFacts(usageReady,held.sessionId,f);await visibleDesktopActiveUsage(page,held.sessionId,'stream-before-close',f);
  desktopStreamSameOriginal(usageReady,held.sessionId,held.user,input);const traceBefore=await desktopStreamNoReexecute(f);assert.equal(traceBefore.steps.filter(step=>step.phase==='handler-returning').length,1);
  await f.handle.close();assert.equal(f.proc.exitCode,0);assert.equal(f.proc.signalCode,null);const drained=await desktopStreamDrained(f);
  const reopened=await reopenReadonly(f,held.sessionId,2);await desktopStreamWindows(f);desktopStreamSameOriginal(reopened,held.sessionId,held.user,input);
  assert.equal(reopened.settings.projectExtensionsEnabled,true);assert.ok(['ready','paused'].includes(reopened.runs[held.sessionId].status));assert.equal(reopened.runs[held.sessionId].pendingInputs,0);
  const restored=reopened.timelines[held.sessionId].filter(item=>item.kind==='tool'&&item.tool.name===desktopStreamToolName);assert.equal(restored.length,1);assert.equal(restored[0].id,block.id);assert.equal(restored[0].tool.status,'done');assert.equal(restored[0].tool.output,block.tool.output);
  assert.deepEqual(desktopActiveUsageFacts(reopened,held.sessionId,f),before);await visibleDesktopActiveUsage(f.handle.page,held.sessionId,'stream-readonly-reopen',f);
  const restoredPre=await visibleTool(f.handle.page,restored[0]);const restoredPng=join(evidenceDir('ordinary-extension-mcp'),`${held.sessionId}-stream-final-readonly-${f.nonce}.png`);await restoredPre.screenshot({path:restoredPng});
  await desktopStreamNoReexecute(f);assert.equal(f.server.requests.length,2);assert.equal(f.server.completeRequests.length,1);assert.equal((await events(f.project)).filter(item=>item.type==='start').length,drained.starts);
  await writeFile(join(evidenceDir('ordinary-extension-mcp'),`${held.sessionId}-stream-success-actions-${f.nonce}.json`),JSON.stringify({nonce:f.nonce,sessionId:held.sessionId,operationId:held.user.operationId,userBlockId:held.user.id,
    partialObservationBlockId:held.partialBlockId,formalToolBlockId:block.id,directResponseId:held.direct.responseId,httpCounts:{outer:2,inner:1},before,after:desktopActiveUsageFacts(reopened,held.sessionId,f),
    normalClose:{exitCode:0,signalCode:null},readonlyReopen:true,drained,pixels:{partial:held.png,final:finalPng,restored:restoredPng},partialTrace:held.partialTrace,finalTrace:traceBefore},null,2));
}
test('普通桌面streamSimple：设置绑定启用零执行，final前真实partial可见，结果与任务用量正常关闭只读重开',async()=>withFixture({
  calls:()=>[],callsOverride:[[desktopStreamToolName,{}]],ownedStream:true,
},desktopStreamSuccess));


function desktopStreamInterrupted(closing) { return async f=>{
  assert.equal(f.server.requests.length,0);assert.deepEqual(f.server.completeRequests,[]);await desktopStreamWindows(f);
  const input='普通桌面中断真实流 '+closing+' '+f.nonce,page=f.handle.page,composer=page.getByPlaceholder(/交代需求|Describe|追问、补充|Follow up/).first();
  await composer.fill(input);await composer.press('Enter');const held=await desktopStreamPartial(f,input,closing);
  if(closing==='pause'){
    await pauseAndDrain(f,held.sessionId);
    await waitForSnapshot(page,()=>held.direct.closedBeforeFinal===true,undefined,'用户暂停必须实际关闭同一未final的HTTP');
    assert.equal(held.direct.finished,false);
  }else{
    await f.handle.close();assert.equal(f.proc.exitCode,0);assert.equal(f.proc.signalCode,null);
  }
  const drained=await desktopStreamDrained(f);assert.equal(f.server.requests.length,1);assert.equal(f.server.completeRequests.length,1);assert.equal(held.direct.finished,false);assert.deepEqual(f.server.errors,[]);
  // direct close先以真实process exit收束，再在只读窗口用既有有界观察等待对端close事件；不新增sleep/timeout。
  const reopened=await reopenReadonly(f,held.sessionId,1);await desktopStreamWindows(f);
  await waitForSnapshot(f.handle.page,()=>held.direct.closedBeforeFinal===true,undefined,'旧进程退出后对端必须实际看到原HTTP关闭');
  assert.equal(reopened.runs[held.sessionId].status,'paused');desktopStreamSameOriginal(reopened,held.sessionId,held.user,input);await desktopStreamNoReexecute(f);
  assert.equal(f.server.requests.length,1);assert.equal(f.server.completeRequests.length,1);assert.equal((await events(f.project)).filter(item=>item.type==='start').length,drained.starts);
  const beforeResumePng=join(evidenceDir('ordinary-extension-mcp'),`${held.sessionId}-stream-${closing}-readonly-${f.nonce}.png`);await f.handle.page.locator('main').screenshot({path:beforeResumePng});
  const primary=f.handle.page.locator('button[data-slot="composer-primary"]');assert.match(await primary.getAttribute('aria-label'),/^继续执行$|^Resume$/);await primary.click();
  await f.handle.page.getByText(f.server.nonce,{exact:true}).waitFor({state:'visible'});
  const final=await waitForSnapshot(f.handle.page,snapshot=>snapshot.runs[held.sessionId]?.status==='ready'&&snapshot.runs[held.sessionId]?.pendingInputs===0
    &&snapshot.timelines[held.sessionId]?.some(block=>block.kind==='tool'&&block.tool.name===desktopStreamToolName&&block.tool.status==='failed'));
  desktopStreamSameOriginal(final,held.sessionId,held.user,input);const trace=await desktopStreamNoReexecute(f);
  assert.equal(f.server.completeRequests.length,1,'明确继续不能重发已被对端接收但没有final的inner流');assert.equal(f.server.completeRequests[0],held.direct);assert.equal(held.direct.finished,false);assert.equal(held.direct.closedBeforeFinal,true);
  assert.equal(f.server.requests.length,2);assert.ok(f.server.requests.every(request=>request.authOk&&request.body.model===codingModel));assert.deepEqual(f.server.errors,[]);
  const tools=final.timelines[held.sessionId].filter(block=>block.kind==='tool'&&block.tool.name===desktopStreamToolName);assert.equal(tools.length,1);const failed=tools[0];assert.equal(failed.tool.status,'failed');assert.ok(failed.tool.output.length>0);assert.ok(!failed.tool.output.includes(desktopStreamText(f.nonce)),'未知结果不得变成已确认完整成功正文');
  const forwarded=f.server.requests[1].body.messages.filter(message=>message.role==='tool'&&message.tool_call_id==='actual-tool-1');assert.equal(forwarded.length,1);assert.ok(httpMessageText(forwarded[0]).length>0);assert.ok(!httpMessageText(forwarded[0]).includes(desktopStreamText(f.nonce)));
  const used=final.sessionModels[held.sessionId];assert.ok(used);assert.ok(used.requests.filter(request=>request.responseId===held.direct.responseId).every(request=>request.usage.input===0&&request.usage.output===0&&request.usage.cacheRead===0&&request.usage.cacheWrite===0),'未收到117/13终态usage，不能编造inner已确认费用');
  const failedPre=await visibleTool(f.handle.page,failed);const finalPng=join(evidenceDir('ordinary-extension-mcp'),`${held.sessionId}-stream-${closing}-continued-error-${f.nonce}.png`);await failedPre.screenshot({path:finalPng});
  await writeFile(join(evidenceDir('ordinary-extension-mcp'),`${held.sessionId}-stream-${closing}-actions-${f.nonce}.json`),JSON.stringify({nonce:f.nonce,closing,sessionId:held.sessionId,operationId:held.user.operationId,userBlockId:held.user.id,
    partialObservationBlockId:held.partialBlockId,formalToolBlockId:failed.id,directResponseId:held.direct.responseId,originalToolCallId:'actual-tool-1',httpCounts:{beforeReadonly:{outer:1,inner:1},afterExplicitResume:{outer:2,inner:1}},
    sameRemoteClosedBeforeFinal:held.direct.closedBeforeFinal,remoteFinished:held.direct.finished,drained,actualUsage:used.usage,pixels:{partial:held.png,readonly:beforeResumePng,error:finalPng},partialTrace:held.partialTrace,afterResumeTrace:trace},null,2));
}; }
for(const closing of ['pause','close'])test(`普通桌面streamSimple/partial后${closing}：同HTTP关闭，只读重开零新增，明确继续原operation不重放`,async()=>withFixture({
  calls:()=>[],callsOverride:[[desktopStreamToolName,{}]],ownedStream:true,
},desktopStreamInterrupted(closing)));


const desktopVirtualTraceFile='desktop-virtual-route.json';
function desktopVirtualExtensionSource(nonce,wait=false) {
  const definition=`pi.registerVirtualModel({provider:'desktop-virtual-direct',id:'virtual-owned-stream',name:'Project direct virtual',input:['text'],thinkingLevels:['off'],
    async route(request,ctx){
      const physical=ctx.modelRegistry.find('user-defined',${JSON.stringify(codingModel)});if(!physical)throw new Error('Physical model missing');
      const trace={nonce:${JSON.stringify(nonce)},reason:request.reason,hasState:Object.hasOwn(request,'state'),messages:request.messages,
        selected:{provider:request.model.provider,id:request.model.id},signalSame:request.signal===ctx.signal,signalAborted:request.signal?.aborted,
        physical:{provider:physical.provider,id:physical.id},containsCredential:/apiKey|authorization|x-dcode-catalog-secret/i.test(JSON.stringify(physical))};
      const watching=${JSON.stringify(wait)}?watch(ctx.cwd,{persistent:false}):undefined;
      const file=join(ctx.cwd,${JSON.stringify(desktopVirtualTraceFile)});await writeFile(file+'.tmp',JSON.stringify({...trace,phase:'route-entered'}));await rename(file+'.tmp',file);
      if(watching){try{while(true){
        try{const gate=JSON.parse(await readFile(join(ctx.cwd,'desktop-virtual-route-release.json'),'utf8'));if(gate.nonce===${JSON.stringify(nonce)})break;}
        catch(error){if(error.code!=='ENOENT')throw error;}await watching.next();
      }}finally{await watching.return();}}
      await writeFile(file+'.tmp',JSON.stringify({...trace,phase:'route-returning',signalAborted:request.signal?.aborted}));await rename(file+'.tmp',file);
      return {model:{...physical,baseUrl:'http://invalid.invalid/v1',headers:{'x-fake-route':'must-not-send'}},thinkingLevel:'off',state:{mustNotPersist:${JSON.stringify(nonce)}}};
    }});`;
  const original=desktopStreamExtensionSource(nonce);
  const needle="export default function(pi){pi.registerTool";
  const model="ctx.modelRegistry.find('user-defined',"+JSON.stringify(codingModel)+")";
  assert.ok(original.includes(needle)&&original.includes(model));
  // 先替原工具引用，再插入route；反序会误替route自己的physical查找，工具仍绕过virtual。
  return original.replace("import {writeFile,rename}","import {writeFile,rename,readFile,watch}").replace(model,"ctx.modelRegistry.find('desktop-virtual-direct','virtual-owned-stream')").replace(needle,'export default function(pi){'+definition+'pi.registerTool');
}
test('普通桌面virtual direct：真实工厂登记、原工具流到canonical物理HTTP与只读重开',async()=>withFixture({
  calls:()=>[],callsOverride:[[desktopStreamToolName,{}]],ownedStream:true,ownedVirtual:true,
},async f=>{
  await desktopStreamSuccess(f);
  const route=JSON.parse(await readFile(join(f.project,desktopVirtualTraceFile),'utf8'));
  assert.equal(route.nonce,f.nonce);assert.equal(route.reason,'direct');assert.equal(route.hasState,false);assert.equal(route.signalSame,true);assert.equal(route.signalAborted,false);
  assert.deepEqual(route.selected,{provider:'desktop-virtual-direct',id:'virtual-owned-stream'});assert.deepEqual(route.physical,{provider:'user-defined',id:codingModel});assert.equal(route.containsCredential,false);
  assert.equal(route.messages.length,1);assert.equal(route.messages[0].role,'user');assert.equal(route.messages[0].content,desktopStreamInput(f.nonce));
  assert.equal(f.server.completeRequests.length,1);assert.equal(f.server.requests.length,2);assert.deepEqual(f.server.errors,[]);
  await writeFile(join(evidenceDir('ordinary-extension-mcp'),'virtual-direct-desktop-route-'+f.nonce+'.json'),JSON.stringify({route,inner:f.server.completeRequests[0],httpCounts:{outer:2,inner:1},readonlyReopen:true},null,2));
}));


for(const closing of ['pause','close'])test(`普通桌面virtual direct/route等待${closing}：有限关闭、只读重开零调用，明确继续不重放`,async()=>withFixture({
  calls:()=>[],callsOverride:[[desktopStreamToolName,{}]],ownedStream:true,ownedVirtual:true,virtualWait:true,
},async f=>{
  assert.equal(f.server.requests.length,0);assert.equal(f.server.completeRequests.length,0);await desktopStreamWindows(f);
  const input='普通桌面virtual选路等待 '+closing+' '+f.nonce,page=f.handle.page;
  const composer=page.getByPlaceholder(/交代需求|Describe|追问、补充|Follow up/).first();await composer.fill(input);await composer.press('Enter');
  let route;
  const parked=await waitForSnapshot(page,async snapshot=>{
    try{route=JSON.parse(await readFile(join(f.project,desktopVirtualTraceFile),'utf8'));}catch(error){if(error.code==='ENOENT')return false;throw error;}
    return route.phase==='route-entered'&&snapshot.sessions.some(session=>snapshot.timelines[session.id]?.some(block=>block.kind==='message'&&block.role==='user'&&block.text===input)
      &&snapshot.runs[session.id]?.status==='running');
  },undefined,'原route已实际进入且刻意忽略signal；不能用准备失败或空闲代替');
  const sessionId=parked.sessions.find(session=>parked.timelines[session.id]?.some(block=>block.kind==='message'&&block.role==='user'&&block.text===input)).id;
  const user=parked.timelines[sessionId].find(block=>block.kind==='message'&&block.role==='user'&&block.text===input);assert.ok(user.operationId);
  assert.equal(route.nonce,f.nonce);assert.equal(route.reason,'direct');assert.equal(route.hasState,false);assert.equal(route.signalSame,true);
  assert.equal(f.server.requests.length,1);assert.equal(f.server.completeRequests.length,0,'选路尚未返回，物理HTTP不得提前发生');
  const beforePng=join(evidenceDir('ordinary-extension-mcp'),`${sessionId}-virtual-route-${closing}-parked-${f.nonce}.png`);await page.locator('main').screenshot({path:beforePng});
  if(closing==='pause')await pauseAndDrain(f,sessionId);else{await f.handle.close();assert.equal(f.proc.exitCode,0);assert.equal(f.proc.signalCode,null);}
  const drained=await desktopStreamDrained(f);assert.equal(f.server.requests.length,1);assert.equal(f.server.completeRequests.length,0);
  // 旧Worker已实际结束；此处只放行测试门，不能冒称旧callback已经执行到return或旧reply已实测到达。
  await writeFile(join(f.project,'desktop-virtual-route-release.json'),JSON.stringify({nonce:f.nonce}));
  const reopened=await reopenReadonly(f,sessionId,1);await desktopStreamWindows(f);assert.equal(reopened.runs[sessionId].status,'paused');
  desktopStreamSameOriginal(reopened,sessionId,user,input);await desktopStreamNoReexecute(f);
  assert.equal(f.server.completeRequests.length,0);assert.equal(f.server.requests.length,1);assert.equal((await events(f.project)).filter(item=>item.type==='start').length,drained.starts);
  const unchanged=JSON.parse(await readFile(join(f.project,desktopVirtualTraceFile),'utf8'));assert.deepEqual(unchanged,route);
  const readonlyPng=join(evidenceDir('ordinary-extension-mcp'),`${sessionId}-virtual-route-${closing}-readonly-${f.nonce}.png`);await f.handle.page.locator('main').screenshot({path:readonlyPng});
  const primary=f.handle.page.locator('button[data-slot="composer-primary"]');assert.match(await primary.getAttribute('aria-label'),/^继续执行$|^Resume$/);await primary.click();
  await f.handle.page.getByText(f.server.nonce,{exact:true}).waitFor({state:'visible'});
  const final=await waitForSnapshot(f.handle.page,snapshot=>snapshot.runs[sessionId]?.status==='ready'&&snapshot.runs[sessionId]?.pendingInputs===0
    &&snapshot.timelines[sessionId]?.some(block=>block.kind==='tool'&&block.tool.name===desktopStreamToolName&&block.tool.status==='failed'));
  desktopStreamSameOriginal(final,sessionId,user,input);const trace=await desktopStreamNoReexecute(f);assert.equal(f.server.completeRequests.length,0,'明确继续不能重发已进入execute的原route/inner模型');
  assert.equal(f.server.requests.length,2);assert.ok(f.server.requests.every(request=>request.authOk&&request.body.model===codingModel));assert.deepEqual(f.server.errors,[]);
  assert.deepEqual(JSON.parse(await readFile(join(f.project,desktopVirtualTraceFile),'utf8')),route,'原route不随新Worker装配重放');
  const failed=final.timelines[sessionId].filter(block=>block.kind==='tool'&&block.tool.name===desktopStreamToolName);assert.equal(failed.length,1);assert.equal(failed[0].tool.status,'failed');assert.ok(failed[0].tool.output.length>0);
  const forwarded=f.server.requests[1].body.messages.filter(message=>message.role==='tool'&&message.tool_call_id==='actual-tool-1');assert.equal(forwarded.length,1);assert.ok(httpMessageText(forwarded[0]).length>0);
  await writeFile(join(evidenceDir('ordinary-extension-mcp'),`${sessionId}-virtual-route-${closing}-actions-${f.nonce}.json`),JSON.stringify({nonce:f.nonce,closing,sessionId,operationId:user.operationId,route,afterStopRoute:unchanged,trace,drained,httpCounts:{beforeReadonly:{outer:1,inner:0},afterResume:{outer:2,inner:0}},gateReleasedAfterWorkerClose:true,lateCallbackReturnProven:false,pixels:{parked:beforePng,readonly:readonlyPng}},null,2));
}));


function desktopProviderHeaderExtensionSource(nonce) {
  const source=desktopStreamExtensionSource(nonce),needle='export default function(pi){pi.registerTool';
  assert.ok(source.includes(needle));
  return source.replace(needle,'export default function(pi){pi.registerProvider(\'user-defined\',{headers:{\'x-dcode-provider-config\':'+JSON.stringify(nonce)+'}});pi.registerTool');
}
async function assertDesktopProviderHeader(f,kind='normal') {
  assert.equal(f.server.requests.length,2);assert.equal(f.server.completeRequests.length,1);
  assert.ok(f.server.requests.every(request=>request.providerHeader===f.nonce&&request.authOk&&request.body.model===codingModel));
  assert.equal(f.server.completeRequests[0].providerHeader,f.nonce);assert.equal(f.server.completeRequests[0].authOk,true);assert.deepEqual(f.server.errors,[]);
  await writeFile(join(evidenceDir('ordinary-extension-mcp'),`provider-header-${kind}-${f.nonce}.json`),JSON.stringify({nonce:f.nonce,kind,outer:f.server.requests.map(request=>({ordinal:request.ordinal,authOk:request.authOk,model:request.body.model,providerHeader:request.providerHeader})),inner:f.server.completeRequests,readonlyReopen:true,explicitResume:kind!=='normal'},null,2));
}
test('普通桌面provider headers：配置绑定启用、三次真实HTTP消费、结果用量与正常关闭RO',async()=>withFixture({
  calls:()=>[],callsOverride:[[desktopStreamToolName,{}]],ownedStream:true,ownedProviderHeader:true,
},async f=>{await desktopStreamSuccess(f);await assertDesktopProviderHeader(f);}));
for(const closing of ['pause','close'])test(`普通桌面provider headers/partial后${closing}：原HTTP收束、RO零执行、明确继续重装但不重放`,async()=>withFixture({
  calls:()=>[],callsOverride:[[desktopStreamToolName,{}]],ownedStream:true,ownedProviderHeader:true,
},async f=>{await desktopStreamInterrupted(closing)(f);await assertDesktopProviderHeader(f,closing);}));
