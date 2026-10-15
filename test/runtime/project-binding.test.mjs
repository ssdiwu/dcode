import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DCodeApplication } from '../../src/application/index.ts';
import { JsonFileStorage } from '../../src/adapters/storage/index.ts';
import { MockExecutionBackend } from '../../src/adapters/mock/index.ts';
import { NativeProjectFolders } from '../../src/main/project-folders.ts';
import { validateOperationInput, isValidOpResponse } from '../../src/contracts/index.ts';

const gate = () => { let release; const wait = new Promise(resolve => { release = resolve; }); return { wait, release }; };
const makeApp = (storage, folders) => new DCodeApplication(new MockExecutionBackend(), storage, undefined, undefined, null, undefined, null, null, null, folders);
const owned = async t => {
  const root = await mkdtemp(join(tmpdir(), 'dcode-project-binding-'));
  const a = join(root, 'project-a'), b = join(root, 'project-b'); await mkdir(a); await mkdir(b);
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = new JsonFileStorage(join(root, 'state'));
  const disk = async () => JSON.parse(await readFile(join(root, 'state/dcode-prototype-state.json'), 'utf8'));
  return { root, a, b, storage, disk };
};

test('创建绑定：同次保存空间和默认任务、正确对象读回；重开同身份查回不重复创建', async t => {
  const f = await owned(t); let picks = 0;
  const app = makeApp(f.storage, new NativeProjectFolders(async () => { picks++; return f.a; })); await app.init();
  const before = await app.getSnapshot();
  try {
    const choice = await app.chooseProjectFolder({ operationId: 'binding-a', requestId: 'pick-a' });
    const input = { operationId: 'binding-a', selectionId: choice.selectionId, name: '真实项目甲' };
    const workspace = await app.createWorkspace(input);
    const saved = await f.disk();
    assert.deepEqual(saved.workspaces.find(w => w.id === workspace.id).folders, [choice.path]);
    assert.equal(saved.tasks.find(task => task.id === workspace.defaultTaskId).workspaceId, workspace.id);
    assert.equal(saved.tasks.find(task => task.id === workspace.defaultTaskId).isDefault, true);
    assert.deepEqual(saved.workspaces.find(w => w.builtinHome), before.workspaces.find(w => w.builtinHome));
    assert.equal((await app.getSnapshot()).sessions.length, before.sessions.length, '绑定不创建会话或启动工作');
    assert.equal((await app.createWorkspace(input)).id, workspace.id);
    await app.flush();
    const reopened = makeApp(f.storage, new NativeProjectFolders(async () => { throw new Error('查回不得开选择器'); })); await reopened.init();
    try {
      assert.equal((await reopened.createWorkspace(input)).id, workspace.id);
      assert.equal((await reopened.getSnapshot()).workspaces.length, before.workspaces.length + 1);
      assert.equal(picks, 1);
      await assert.rejects(reopened.createWorkspace({ ...input, name: '改写旧创建' }), /identity-conflict/);
    } finally { await reopened.flush(); }
  } finally { await app.flush(); }
});

test('真实保存拒绝：内存和落盘保留原空间；同次名称和选择可重试', async t => {
  const f = await owned(t); let fail = false;
  const storage = { load: () => f.storage.load(), readCurrent: () => f.storage.readCurrent(), save: state => fail ? Promise.reject(new Error('owned save failure')) : f.storage.save(state) };
  const app = makeApp(storage, new NativeProjectFolders(async () => f.a)); await app.init();
  try {
    const before = await app.getSnapshot(); const prior = await f.disk();
    const choice = await app.chooseProjectFolder({ operationId: 'save-failure', requestId: 'pick-failure' });
    const input = { operationId: 'save-failure', selectionId: choice.selectionId, name: '保存待重试' };
    fail = true; await assert.rejects(app.createWorkspace(input), /save-failed/);
    assert.deepEqual((await app.getSnapshot()).workspaces, before.workspaces);
    assert.deepEqual((await f.disk()).workspaces, prior.workspaces);
    fail = false; const saved = await app.createWorkspace(input);
    assert.equal(saved.name, input.name); assert.deepEqual(saved.folders, [choice.path]);
  } finally { fail = false; await app.flush(); }
});

test('保存已经提交但应答丢失：按原创建身份读回，关闭与同次重试均不盖回或再建', async t => {
  const f = await owned(t); let lose = false; let creations = 0;
  const storage = { load: () => f.storage.load(), readCurrent: () => f.storage.readCurrent(), async save(state) {
    await f.storage.save(state);
    if (lose && state.workspaces.length > 1) { lose = false; creations++; throw new Error('owned post-commit acknowledgement loss'); }
  } };
  const app = makeApp(storage, new NativeProjectFolders(async () => f.a)); await app.init();
  try {
    const choice = await app.chooseProjectFolder({ operationId: 'saved-unknown', requestId: 'pick-unknown' });
    const input = { operationId: 'saved-unknown', selectionId: choice.selectionId, name: '同次已保存' };
    lose = true; const workspace = await app.createWorkspace(input);
    assert.equal(creations, 1);
    assert.equal((await app.createWorkspace(input)).id, workspace.id);
    await app.flush();
    const disk = await f.disk();
    assert.equal(disk.workspaces.filter(w => w.id === workspace.id).length, 1);
    assert.equal(disk.workspaceBindingReceipts[input.operationId].workspaceId, workspace.id);
  } finally { await app.flush(); }
});

test('绑定和设置在途：关闭等实际保存，最终读回同时保有新目录和新设置', async t => {
  const f = await owned(t); const entered = gate(), proceed = gate(); let armed = false;
  const storage = { load: () => f.storage.load(), readCurrent: () => f.storage.readCurrent(), async save(state) {
    if (armed) { armed = false; entered.release(); await proceed.wait; }
    return f.storage.save(state);
  } };
  const app = makeApp(storage, new NativeProjectFolders(async () => f.a)); await app.init();
  try {
    const choice = await app.chooseProjectFolder({ operationId: 'close-wait', requestId: 'pick-close' });
    armed = true;
    const creation = app.createWorkspace({ operationId: 'close-wait', selectionId: choice.selectionId, name: '关闭仍保留' });
    await entered.wait;
    const settings = app.updateSettings({ theme: 'dark' }); let closed = false;
    const closing = app.flush().then(() => { closed = true; });
    await Promise.resolve(); assert.equal(closed, false, '未放行真实写盘不能报关闭');
    proceed.release(); const workspace = await creation; await settings; await closing;
    const saved = await f.disk();
    assert.deepEqual(saved.workspaces.find(w => w.id === workspace.id).folders, [choice.path]);
    assert.equal(saved.settings.theme, 'dark');
  } finally { proceed.release(); await app.flush(); }
});

test('保存结果仍未知：设置和关闭不得旧表覆盖；同创建身份先查回真实保存', async t => {
  for (const closing of [false, true]) {
    const f = await owned(t); let lose = false, unavailable = false; let writes = 0;
    const storage = { async load() {
      if (unavailable) throw new Error('owned readback unavailable');
      return f.storage.load();
    }, async readCurrent() {
      if (unavailable) throw new Error('owned readback unavailable');
      return f.storage.readCurrent();
    }, async save(state) {
      writes++; await f.storage.save(state);
      if (lose) { lose = false; unavailable = true; throw new Error('owned saved but no acknowledgement'); }
    } };
    const app = makeApp(storage, new NativeProjectFolders(async () => f.a)); await app.init();
    try {
    const choice = await app.chooseProjectFolder({ operationId: 'unresolved-binding', requestId: 'unresolved-pick' });
    const input = { operationId: 'unresolved-binding', selectionId: choice.selectionId, name: '未知先查回' };
    lose = true;
    await assert.rejects(app.createWorkspace(input), /save-unknown/);
    const pending = (await app.getSnapshot()).pendingWorkspaceCreation;
    assert.deepEqual(pending, { ...input, path: choice.path });
    await app.discardProjectFolder({ operationId: input.operationId });
    const committed = await f.disk(); const savedWorkspace = committed.workspaces.find(w => !w.builtinHome);
    assert.ok(savedWorkspace); assert.equal((await app.getSnapshot()).workspaces.length, 1, '未读回不得提前发布成功');
    const before = writes;
    if (closing) await assert.rejects(app.flush(), /close-failed/);
    else await assert.rejects(app.updateSettings({ theme: 'dark' }), /settings-save-failed/);
    assert.equal(writes, before, '查回未知时不得向存储发送任何旧完整状态');
    assert.deepEqual((await f.disk()).workspaces, committed.workspaces);
    unavailable = false;
    assert.equal((await app.createWorkspace({ operationId: pending.operationId, selectionId: pending.selectionId, name: pending.name })).id, savedWorkspace.id, '关闭选择后从待核投影沿原创建查回，不重新生成空间');
    assert.equal((await app.getSnapshot()).pendingWorkspaceCreation, null);
    assert.equal((await app.getSnapshot()).workspaces.length, 2);
    await app.flush();
    assert.equal((await f.disk()).workspaceBindingReceipts[input.operationId].workspaceId, savedWorkspace.id);
    } finally { await app.flush().catch(() => undefined); }
  }
});

test('迟到选择与取消：新操作保存B后旧A返回不可覆盖；取消新选择保留原有效选择', async t => {
  const f = await owned(t); const entered = gate(), old = gate(); let n = 0;
  const folders = new NativeProjectFolders(async () => {
    n++;
    if (n === 1) { entered.release(); await old.wait; return f.a; }
    return n === 2 ? f.b : null;
  });
  const app = makeApp(f.storage, folders); await app.init();
  try {
    const first = app.chooseProjectFolder({ operationId: 'old-form', requestId: 'old-pick' }); await entered.wait;
    await app.discardProjectFolder({ operationId: 'old-form' });
    const next = await app.chooseProjectFolder({ operationId: 'new-form', requestId: 'new-pick' });
    assert.equal(await app.chooseProjectFolder({ operationId: 'new-form', requestId: 'cancel-new-pick' }), null);
    const workspace = await app.createWorkspace({ operationId: 'new-form', selectionId: next.selectionId, name: '项目乙' });
    old.release(); assert.equal(await first, null);
    const snapshot = await app.getSnapshot(); assert.equal(snapshot.workspaces.filter(w => !w.builtinHome).length, 1);
    assert.deepEqual((await f.disk()).workspaces.find(w => w.id === workspace.id).folders, [next.path]);
  } finally { old.release(); await app.flush(); }
});

test('选择事实不可借给另一创建；失效目录、文件与任意路径输入均拒绝', async t => {
  const f = await owned(t); const file = join(f.root, 'not-a-directory'); await writeFile(file, 'owned file');
  let picked = f.a; const folders = new NativeProjectFolders(async () => picked);
  const app = makeApp(f.storage, folders); await app.init();
  try {
    const choice = await app.chooseProjectFolder({ operationId: 'actual-choice', requestId: 'actual-pick' });
    await assert.rejects(app.createWorkspace({ operationId: 'other-object', selectionId: choice.selectionId, name: '错误对象' }), /folder-stale/);
    await rm(f.a, { recursive: true });
    await assert.rejects(app.createWorkspace({ operationId: 'actual-choice', selectionId: choice.selectionId, name: '已失效' }), /folder-stale/);
    picked = file; await assert.rejects(app.chooseProjectFolder({ operationId: 'file-choice', requestId: 'file-pick' }), /folder-unavailable/);
    assert.equal((await app.getSnapshot()).workspaces.length, 1);
    assert.ok(validateOperationInput('createWorkspace', { operationId: 'x', selectionId: 'y', name: '任意路径', path: f.b }));
    assert.equal(isValidOpResponse('chooseProjectFolder', { operationId: 'x', requestId: 'y', selectionId: 'z', path: '../unsafe' }), false);
  } finally { await app.flush(); }
});

test('运行中查回只读：损坏不改名，暂时读不到后成功查回不污染启动期拒写保护', async t => {
  const f = await owned(t); const app = makeApp(f.storage, new NativeProjectFolders(async () => f.a)); await app.init(); await app.flush();
  const file = join(f.root, 'state/dcode-prototype-state.json'); const valid = await readFile(file, 'utf8');
  await writeFile(file, '{owned invalid JSON');
  assert.equal((await f.storage.readCurrent()).status, 'unreadable');
  assert.equal(await readFile(file, 'utf8'), '{owned invalid JSON', '运行中查回不得改名保全或修改文件');
  await writeFile(file, valid);
  const observed = await f.storage.readCurrent(); assert.equal(observed.status, 'ok');
  await f.storage.save(observed.state);
  assert.deepEqual(await f.disk(), observed.state);
});
