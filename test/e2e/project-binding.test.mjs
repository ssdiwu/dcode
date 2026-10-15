// mock 空样例仅证明界面、正式 Bridge 与真实存储边界，不证明真实 SDK。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, ready, waitForSnapshot, killApp } from './helpers.mjs';
import { startCodingLoopback } from './ordinary-coding-fixture.mjs';

const environment = { DCODE_VALIDATION_ASSEMBLY: 'mock', DCODE_VALIDATION_SAMPLE: '0' };
const stateFile = stateDir => join(stateDir, 'dcode-prototype-state.json');
const dialog = page => page.getByRole('dialog', { name: /新建工作空间|New workspace/ });
const createButton = page => dialog(page).getByRole('button', { name: /^创建$|^Create$/ });
const chooserButton = page => dialog(page).getByRole('button', { name: /^选择文件夹$|^Choose folder$/ });

async function openWorkspaceDialog(page) {
  await page.locator('nav').getByRole('button', { name: /^新建工作空间$|^New workspace$/ }).click();
  await dialog(page).waitFor({ state: 'visible' });
}

async function diskWhenSaved(page, stateDir, predicate = () => true) {
  let value;
  await waitForSnapshot(page, async () => {
    try { value = JSON.parse(await readFile(stateFile(stateDir), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    return predicate(value);
  }, undefined, '真实状态文件未达到预期保存条件');
  return value;
}

function assertNoWork(snapshot, server) {
  assert.deepEqual(snapshot.sessions, [], '绑定界面不得创建会话');
  assert.deepEqual(snapshot.timelines, {}, '绑定界面不得创建输入、回复或工具历史');
  assert.deepEqual(snapshot.runs, {}, '绑定界面不得启动运行');
  assert.equal(server.requests.length, 0, '没有真实 HTTP；mock 运行另由会话/历史判据拒绝');
}

// 只替换 native dialog 返回；不修改 Bridge、Application 或持久化状态。
// held 的 Promise 真正在选择调用内等待，release 后再 await 其实际返回记录。
async function installChooser(handle, plans) {
  await handle.app.evaluate(({ dialog: nativeDialog }, planList) => {
    const original = nativeDialog.showOpenDialog;
    const records = [];
    const releases = new Map();
    const returned = new Map();
    const state = { original, records, releases, returned };
    globalThis.__bindingBoundaryChooser = state;
    nativeDialog.showOpenDialog = (window, options) => {
      const index = records.length;
      const plan = planList[index];
      if (!plan) throw new Error(`unplanned native directory choice ${index}`);
      const record = { index, windowId: window.id, properties: [...options.properties], returned: false, result: null };
      records.push(record);
      const nativeResult = plan.hold
        ? new Promise(resolve => releases.set(index, resolve))
        : Promise.resolve(plan.result);
      const completion = nativeResult.then(result => {
        record.result = { canceled: result.canceled, filePaths: [...result.filePaths] };
        record.returned = true;
        return result;
      });
      returned.set(index, completion);
      return completion;
    };
  }, plans);
}

async function chooserRecords(handle) {
  return handle.app.evaluate(() => globalThis.__bindingBoundaryChooser.records.map(record => ({ ...record })));
}

async function releaseChoice(handle, index, result) {
  const record = await handle.app.evaluate(async (_electron, input) => {
    const state = globalThis.__bindingBoundaryChooser;
    const release = state.releases.get(input.index);
    if (!release) throw new Error('owned native choice is not waiting');
    state.releases.delete(input.index);
    release(input.result);
    await state.returned.get(input.index);
    return { ...state.records[input.index] };
  }, { index, result });
  assert.equal(record.returned, true, '必须实际返回旧 native 选择，不由空队列推定');
  assert.deepEqual(record.result, result);
  return record;
}

async function restoreChooser(handle) {
  await handle.app.evaluate(({ dialog: nativeDialog }) => {
    const state = globalThis.__bindingBoundaryChooser;
    if (!state) return;
    for (const release of state.releases.values()) release({ canceled: true, filePaths: [] });
    state.releases.clear();
    nativeDialog.showOpenDialog = state.original;
    delete globalThis.__bindingBoundaryChooser;
  });
}

function assertNativeRecord(record) {
  assert.ok(record.windowId > 0);
  assert.deepEqual(record.properties, ['openDirectory']);
}

// 故障信号优先保留；关闭失败仍是失败。只有清理阶段可强制退出，不能给正常关闭记绿。
async function withFixture(action) {
  const root = await mkdtemp(join(tmpdir(), 'dcode-project-binding-boundary-'));
  const stateDir = join(root, 'state');
  const directoryA = join(root, 'directory-a'); const directoryB = join(root, 'directory-b');
  const context = { root, stateDir, projectA: null, projectB: null, server: null, handle: null, blocker: null, process: null };
  let primary;
  const secondary = [];
  try {
    await mkdir(directoryA); await mkdir(directoryB);
    context.projectA = await realpath(directoryA); context.projectB = await realpath(directoryB);
    context.server = await startCodingLoopback();
    context.handle = await launchApp(stateDir, environment, '.', { prebindProject: false });
    context.process = context.handle.app.process();
    await ready(context.handle.page);
    await diskWhenSaved(context.handle.page, stateDir);
    await action(context);
  } catch (error) { primary = error; }
  finally {
    if (context.blocker) {
      try { await rm(context.blocker, { recursive: true, force: true }); context.blocker = null; }
      catch (error) { secondary.push(error); }
    }
    if (context.handle) {
      const proc = context.process;
      if (proc?.exitCode === null && proc.signalCode === null) {
        try { await restoreSaveFault(context.handle); } catch (error) { secondary.push(error); }
        try { await restoreChooser(context.handle); } catch (error) { secondary.push(error); }
      }
      try { await context.handle.close(); } catch (error) { secondary.push(error); }
      if (proc?.exitCode === null && proc.signalCode === null) {
        try { await killApp(context.handle); } catch (error) { secondary.push(error); }
      }
    }
    if (context.server) {
      try { await context.server.close(); } catch (error) { secondary.push(error); }
    }
    // 不删除尚有真实 Electron 持有的状态目录。
    if (context.process?.exitCode === null && context.process.signalCode === null) {
      secondary.push(new Error('owned Electron remains alive; preserve isolated root for diagnosis'));
    } else {
      try { await rm(root, { recursive: true, force: true }); } catch (error) { secondary.push(error); }
    }
  }
  if (primary && secondary.length) throw new AggregateError([primary, ...secondary], '业务失败及清理失败分别保留');
  if (primary) throw primary;
  if (secondary.length) throw new AggregateError(secondary, '清理/真实关闭失败');
}

test('工作空间绑定：native canceled 已返回后不建立对象或开始工作', async () => withFixture(async context => {
  const { handle, stateDir, server } = context; const { page } = handle;
  const before = await page.evaluate(() => window.dcode.getSnapshot());
  const diskBefore = await readFile(stateFile(stateDir), 'utf8');
  assertNoWork(before, server);
  await installChooser(handle, [{ result: { canceled: true, filePaths: [] } }]);
  await openWorkspaceDialog(page);
  await dialog(page).getByLabel(/工作空间名称|Workspace name/).fill('取消后不得创建');
  await chooserButton(page).click();
  // choosing->可再次选择证明正式 Bridge 回执已到；不能在 native Promise 未返回时用零计数判成功。
  await chooserButton(page).waitFor({ state: 'visible' });
  assert.equal(await chooserButton(page).isEnabled(), true);
  const records = await chooserRecords(handle);
  assert.equal(records.length, 1); assertNativeRecord(records[0]);
  assert.equal(records[0].returned, true);
  assert.deepEqual(records[0].result, { canceled: true, filePaths: [] });
  await dialog(page).locator('[data-slot="workspace-selected-folder"]').getByText(/尚未选择工作文件夹|No work folder selected/).waitFor();
  assert.equal(await createButton(page).isDisabled(), true);
  assert.equal(await dialog(page).getByRole('alert').count(), 0, '取消不是选取失败');
  await dialog(page).getByRole('button', { name: /^取消$|^Cancel$/ }).click();
  await dialog(page).waitFor({ state: 'hidden' });
  const after = await page.evaluate(() => window.dcode.getSnapshot());
  assert.deepEqual(after.workspaces, before.workspaces); assert.deepEqual(after.tasks, before.tasks);
  assertNoWork(after, server);
  assert.equal(await readFile(stateFile(stateDir), 'utf8'), diskBefore);
}));

async function restoreSaveFault(handle) {
  await handle.app.evaluate(async () => {
    const fault = globalThis.__bindingSaveFault;
    if (!fault) return;
    const fs = process.getBuiltinModule('fs/promises');
    fs.rename = fault.rename; fs.readFile = fault.readFile;
    process.getBuiltinModule('module').syncBuiltinESMExports();
    delete globalThis.__bindingSaveFault;
  });
}

test('工作空间绑定：实际已写应答丢失且查回暂不可用，关表单后从原待核入口恢复一份', async () => withFixture(async context => {
  const { handle, stateDir, projectA, server } = context; const { page } = handle;
  await installChooser(handle, [{ result: { canceled: false, filePaths: [projectA] } }]);
  await openWorkspaceDialog(page); await chooserButton(page).click();
  await dialog(page).locator('[data-slot="workspace-selected-folder"]').getByText(projectA, { exact: true }).waitFor();
  await dialog(page).getByLabel(/工作空间名称|Workspace name/).fill('关表单仍按原创建查回');
  await handle.app.evaluate(async (_electron, file) => {
    const fs = process.getBuiltinModule('fs/promises');
    const state = { rename: fs.rename, readFile: fs.readFile, armed: true, deny: false, committed: 0, readFailures: 0 };
    globalThis.__bindingSaveFault = state;
    // 只认领本用例正式状态文件：先实际rename提交，再丢失这一应答；不注入空间或篡改快照。
    fs.rename = async (source, destination) => {
      const value = await state.rename(source, destination);
      if (destination === file && state.armed) { state.armed = false; state.deny = true; state.committed++; throw new Error('owned post-commit acknowledgement lost'); }
      return value;
    };
    fs.readFile = async (path, ...rest) => {
      if (path === file && state.deny) { state.readFailures++; throw Object.assign(new Error('owned readback unavailable'), { code: 'EIO' }); }
      return state.readFile(path, ...rest);
    };
    // 构建入口使用Node内置ESM具名导入，测试替身必须同步到真实消费者的导出绑定。
    process.getBuiltinModule('module').syncBuiltinESMExports();
  }, stateFile(stateDir));
  await createButton(page).click();
  await waitForSnapshot(page, async () => (await handle.app.evaluate(() => globalThis.__bindingSaveFault.committed)) === 1,
    undefined, '本用例实际保存提交故障尚未到达消费者，不判业务结果');
  await dialog(page).getByRole('alert').getByText(/尚未确认创建结果|Creation is not confirmed/).waitFor();
  const unresolved = await page.evaluate(() => window.dcode.getSnapshot());
  const intent = unresolved.pendingWorkspaceCreation;
  assert.equal(intent.name, '关表单仍按原创建查回'); assert.equal(intent.path, projectA);
  assert.equal(unresolved.workspaces.length, 1); assertNoWork(unresolved, server);
  const diskCommitted = JSON.parse(await readFile(stateFile(stateDir), 'utf8'));
  const actual = diskCommitted.workspaces.find(item => !item.builtinHome); assert.ok(actual);
  assert.equal(diskCommitted.workspaceBindingReceipts[intent.operationId].workspaceId, actual.id);
  await dialog(page).getByRole('button', { name: /^取消$|^Cancel$/ }).click(); await dialog(page).waitFor({ state: 'hidden' });
  await page.locator('nav').getByRole('button', { name: /^核对保存结果$|^Check saved result$/ }).click();
  await dialog(page).waitFor({ state: 'visible' });
  const name = dialog(page).getByLabel(/工作空间名称|Workspace name/);
  assert.equal(await name.inputValue(), intent.name); assert.equal(await name.isDisabled(), true);
  assert.equal(await chooserButton(page).isDisabled(), true, '待核意图不可改目录');
  await handle.app.evaluate(() => { globalThis.__bindingSaveFault.deny = false; });
  await dialog(page).getByRole('button', { name: /^核对保存结果$|^Check saved result$/ }).click(); await dialog(page).waitFor({ state: 'hidden' });
  const saved = await waitForSnapshot(page, snapshot => snapshot.workspaces.some(item => item.id === actual.id) && snapshot.pendingWorkspaceCreation === null);
  assert.equal(saved.workspaces.length, 2); assert.deepEqual(saved.workspaces.find(item => item.id === actual.id).folders, [projectA]);
  assert.equal(saved.tasks.find(item => item.id === actual.defaultTaskId).workspaceId, actual.id);
  const fault = await handle.app.evaluate(() => ({ committed: globalThis.__bindingSaveFault.committed, reads: globalThis.__bindingSaveFault.readFailures }));
  assert.equal(fault.committed, 1); assert.ok(fault.reads >= 1); assert.equal((await chooserRecords(handle)).length, 1);
  assertNoWork(saved, server); await restoreSaveFault(handle); await restoreChooser(handle); await handle.close();
  context.handle = await launchApp(stateDir, environment, '.', { prebindProject: false }); context.process = context.handle.app.process(); await ready(context.handle.page);
  const reopened = await context.handle.page.evaluate(() => window.dcode.getSnapshot());
  assert.equal(reopened.workspaces.filter(item => item.id === actual.id).length, 1); assertNoWork(reopened, server);
}));

test('工作空间绑定：关闭A表单→新B保存→A native 迟到实际返回，B保持并重开只读', async () => withFixture(async context => {
  const { handle, stateDir, projectA, projectB, server } = context; const { page } = handle;
  const before = await page.evaluate(() => window.dcode.getSnapshot());
  await installChooser(handle, [{ hold: true }, { result: { canceled: false, filePaths: [projectB] } }]);
  await openWorkspaceDialog(page);
  await dialog(page).getByLabel(/工作空间名称|Workspace name/).fill('A迟到不得建成');
  await chooserButton(page).click();
  await dialog(page).getByRole('button', { name: /正在选择|Choosing/ }).waitFor();
  const inFlight = await chooserRecords(handle);
  assert.equal(inFlight.length, 1); assertNativeRecord(inFlight[0]); assert.equal(inFlight[0].returned, false);
  await dialog(page).getByRole('button', { name: /^取消$|^Cancel$/ }).click();
  await dialog(page).waitFor({ state: 'hidden' });
  await openWorkspaceDialog(page);
  await chooserButton(page).click();
  await dialog(page).locator('[data-slot="workspace-selected-folder"]').getByText(projectB, { exact: true }).waitFor();
  await dialog(page).getByLabel(/工作空间名称|Workspace name/).fill('B正式保存');
  await createButton(page).click(); await dialog(page).waitFor({ state: 'hidden' });
  const saved = await waitForSnapshot(page, snapshot => snapshot.workspaces.some(workspace => workspace.name === 'B正式保存'));
  const workspace = saved.workspaces.find(item => item.name === 'B正式保存');
  assert.deepEqual(workspace.folders, [projectB]);
  assert.equal(saved.workspaces.length, before.workspaces.length + 1);
  assert.equal(saved.tasks.length, before.tasks.length + 1);
  const diskSaved = await diskWhenSaved(page, stateDir, value => value.workspaces.some(item => item.id === workspace.id));
  assert.deepEqual(diskSaved.workspaces.find(item => item.id === workspace.id).folders, [projectB]);
  // 等待 A 真正返回其目录，再走正式只读桥核 B；不拿 A 队列消失或 B 表单关闭当 A 已返回。
  await releaseChoice(handle, 0, { canceled: false, filePaths: [projectA] });
  const afterLate = await page.evaluate(() => window.dcode.getSnapshot());
  assert.deepEqual(afterLate.workspaces, saved.workspaces); assert.deepEqual(afterLate.tasks, saved.tasks);
  assert.equal(afterLate.workspaces.some(item => item.folders.includes(projectA)), false);
  assert.equal(afterLate.workspaces.some(item => item.name === 'A迟到不得建成'), false);
  assertNoWork(afterLate, server);
  const records = await chooserRecords(handle); assert.equal(records.length, 2);
  records.forEach(assertNativeRecord); assert.ok(records.every(record => record.returned));
  await restoreChooser(handle); await handle.close();
  context.handle = await launchApp(stateDir, environment, '.', { prebindProject: false });
  context.process = context.handle.app.process(); await ready(context.handle.page);
  const reopened = await context.handle.page.evaluate(() => window.dcode.getSnapshot());
  assert.deepEqual(reopened.workspaces, saved.workspaces); assert.deepEqual(reopened.tasks, saved.tasks);
  assertNoWork(reopened, server);
  assert.deepEqual(JSON.parse(await readFile(stateFile(stateDir), 'utf8')).workspaces, diskSaved.workspaces);
  await context.handle.page.locator('nav [role="tree"]').getByRole('treeitem')
    .filter({ has: context.handle.page.getByText('B正式保存', { exact: true }) }).click();
  assertNoWork(await context.handle.page.evaluate(() => window.dcode.getSnapshot()), server);
}));

test('工作空间绑定：真实临时文件写入失败保表单和旧disk；同次创建重试后实际保存', async () => withFixture(async context => {
  const { handle, stateDir, projectA, server } = context; const { page } = handle;
  const before = await page.evaluate(() => window.dcode.getSnapshot());
  const diskBefore = await readFile(stateFile(stateDir), 'utf8');
  await installChooser(handle, [{ result: { canceled: false, filePaths: [projectA] } }]);
  await openWorkspaceDialog(page); await chooserButton(page).click();
  await dialog(page).locator('[data-slot="workspace-selected-folder"]').getByText(projectA, { exact: true }).waitFor();
  const input = dialog(page).getByLabel(/工作空间名称|Workspace name/);
  await input.fill('失败后同次重试');
  const formIdentity = await dialog(page).elementHandle();
  // 只能认领本用例的 Electron PID；用 mkdir 阻塞真实 JsonFileStorage.writeFile，不改用户权限。
  const ownedPid = await handle.app.evaluate(() => process.pid);
  assert.ok(Number.isSafeInteger(ownedPid) && ownedPid > 0);
  assert.equal(ownedPid, context.process.pid);
  const blocker = `${stateFile(stateDir)}.tmp-${ownedPid}`;
  await mkdir(blocker); context.blocker = blocker; // EEXIST 即工装前置失败，不能删除未知原文件。
  await createButton(page).click();
  await dialog(page).getByRole('alert').getByText(/工作空间未能保存|The workspace could not be saved/).waitFor();
  assert.equal(await formIdentity.evaluate(element => element.isConnected), true, '原表单保留，不能重建另一创建操作');
  assert.equal(await input.inputValue(), '失败后同次重试');
  await dialog(page).locator('[data-slot="workspace-selected-folder"]').getByText(projectA, { exact: true }).waitFor();
  assert.equal(await createButton(page).isDisabled(), false);
  const failed = await page.evaluate(() => window.dcode.getSnapshot());
  assert.deepEqual(failed.workspaces, before.workspaces); assert.deepEqual(failed.tasks, before.tasks);
  assertNoWork(failed, server);
  assert.equal(await readFile(stateFile(stateDir), 'utf8'), diskBefore, '失败不得替换旧disk');
  await rm(blocker, { recursive: true }); context.blocker = null;
  // 不重新选目录、不关闭/重建表单，沿同一 operation useRef 点击创建重试。
  await createButton(page).click(); await dialog(page).waitFor({ state: 'hidden' });
  const saved = await waitForSnapshot(page, snapshot => snapshot.workspaces.some(item => item.name === '失败后同次重试'));
  const workspace = saved.workspaces.find(item => item.name === '失败后同次重试');
  assert.deepEqual(workspace.folders, [projectA]);
  assert.equal(saved.workspaces.length, before.workspaces.length + 1);
  assert.equal(saved.tasks.length, before.tasks.length + 1);
  assert.equal(saved.tasks.find(item => item.id === workspace.defaultTaskId).workspaceId, workspace.id);
  const persisted = await diskWhenSaved(page, stateDir, value => value.workspaces.some(item => item.id === workspace.id));
  assert.deepEqual(persisted.workspaces.find(item => item.id === workspace.id).folders, [projectA]);
  assert.equal(persisted.tasks.find(item => item.id === workspace.defaultTaskId).workspaceId, workspace.id);
  assert.equal(Object.entries(persisted.workspaceBindingReceipts ?? {}).filter(([, receipt]) => receipt.workspaceId === workspace.id).length, 1);
  const records = await chooserRecords(handle); assert.equal(records.length, 1, '失败重试复用已选身份，不重新模拟选择');
  assertNoWork(saved, server);
  await formIdentity.dispose();
  await restoreChooser(handle); await handle.close();
  context.handle = await launchApp(stateDir, environment, '.', { prebindProject: false });
  context.process = context.handle.app.process(); await ready(context.handle.page);
  const reopened = await context.handle.page.evaluate(() => window.dcode.getSnapshot());
  assert.deepEqual(reopened.workspaces, saved.workspaces); assert.deepEqual(reopened.tasks, saved.tasks);
  assertNoWork(reopened, server);
}));

