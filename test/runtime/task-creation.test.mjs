// 任务对象与实际保存回执：真实隔离JSON存储，执行端仅作归属模拟；不证明SDK/HTTP或UI。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DCodeApplication } from '../../src/application/index.ts';
import { JsonFileStorage } from '../../src/adapters/storage/index.ts';
import { MockExecutionBackend } from '../../src/adapters/mock/index.ts';
import { isValidOpResponse, validateOperationInput } from '../../src/contracts/index.ts';

const gate = () => { let release; const wait = new Promise(resolve => { release = resolve; }); return { wait, release }; };
const input = (operationId, title = '命名长期任务') => ({ operationId, workspaceId: 'ws-home', parentId: null, title });
async function setup(t, wrap = storage => storage) {
  const root = await mkdtemp(join(tmpdir(), 'dcode-task-creation-'));
  const storage = new JsonFileStorage(root);
  const app = new DCodeApplication(new MockExecutionBackend(), wrap(storage));
  t.after(() => rm(root, { recursive: true, force: true }));
  await app.init();
  return { app, storage, disk: async () => JSON.parse(await readFile(join(root, 'dcode-prototype-state.json'), 'utf8')) };
}

function assertCreated(snapshot, disk, task, before) {
  const mains = snapshot.sessions.filter(s => s.taskId === task.id && s.kind === 'main');
  assert.equal(mains.length, 1, '命名任务在返回成功前必须已有且只有一条主会话');
  assert.equal(task.mainSessionId, mains[0].id);
  assert.equal(snapshot.tasks.length, before.tasks.length + 1);
  assert.equal(snapshot.sessions.length, before.sessions.length + 1);
  assert.ok(disk.tasks.some(t => t.id === task.id), '返回成功时任务必须已保存');
  assert.ok(disk.sessions.some(s => s.id === mains[0].id && s.taskId === task.id), '任务与主会话须同次保存');
  assert.equal(disk.taskCreationReceipts[task.operationId].taskId, task.id);
  assert.equal(disk.taskCreationReceipts[task.operationId].sessionId, mains[0].id);
  assert.equal(snapshot.runs[mains[0].id].status, 'ready', '创建保持正式ready空闲相位');
  assert.deepEqual(snapshot.timelines[mains[0].id], [], '创建不接收输入或执行工具');
}

test('命名长期任务：确认返回前同次保存唯一主会话；首发进入原会话而不另造任务', async t => {
  const { app, disk } = await setup(t);
  try {
    const before = await app.getSnapshot();
    const created = await app.createTask(input('task-create-one'));
    assertCreated(await app.getSnapshot(), await disk(), created, before);
    const sent = await app.sendMessage({ taskId: created.id, text: '在原命名任务工作', mode: 'steer', operationId: 'named-first-input' });
    assert.equal(sent.sessionId, created.mainSessionId);
    const after = await app.getSnapshot();
    assert.equal(after.tasks.length, before.tasks.length + 1);
    assert.equal(after.sessions.filter(s => s.taskId === created.id && s.kind === 'main').length, 1);
    assert.equal(after.sessions.find(s => s.id === sent.sessionId).taskId, created.id);
  } finally { await app.flush(); }
});

test('创建真实写盘在途：不提前返回或发布；关闭等待同次保存，取消不能冒称成功', async t => {
  const entered = gate(), proceed = gate(); let armed = false;
  const { app, disk } = await setup(t, storage => ({ load: () => storage.load(), readCurrent: () => storage.readCurrent(), async save(state) {
    if (armed) { armed = false; entered.release(); await proceed.wait; }
    return storage.save(state);
  } }));
  try {
    const before = await app.getSnapshot(); armed = true;
    const creation = app.createTask(input('task-create-flight'));
    const first = await Promise.race([entered.wait.then(() => 'write-entered'), creation.then(() => 'returned')]);
    assert.equal(first, 'write-entered', '不能先报创建成功、稍后才写盘');
    assert.equal((await app.getSnapshot()).tasks.length, before.tasks.length, '保存未确认不发布对象');
    let closed = false; const closing = app.flush().then(() => { closed = true; });
    await Promise.resolve(); assert.equal(closed, false);
    proceed.release(); const created = await creation; await closing;
    assertCreated(await app.getSnapshot(), await disk(), created, before);
  } finally { proceed.release(); await app.flush(); }
});

test('真实创建保存拒绝：不发布任务/会话；同operationId可重试且没有半成品', async t => {
  let fail = false;
  const { app, disk } = await setup(t, storage => ({ load: () => storage.load(), readCurrent: () => storage.readCurrent(), save: state => fail ? Promise.reject(new Error('controlled save rejected')) : storage.save(state) }));
  try {
    const before = await app.getSnapshot(), saved = await disk(); fail = true;
    await assert.rejects(app.createTask(input('task-create-failed')), /task-create-save-failed/);
    assert.deepEqual((await app.getSnapshot()).tasks, before.tasks);
    assert.deepEqual((await app.getSnapshot()).sessions, before.sessions);
    assert.deepEqual((await disk()).tasks, saved.tasks);
    fail = false; const created = await app.createTask(input('task-create-failed'));
    assertCreated(await app.getSnapshot(), await disk(), created, before);
  } finally { fail = false; await app.flush(); }
});

test('已保存应答丢失：原身份只读找回、重开不复制；同ID不同正文拒绝', async t => {
  let lose = false, taskWrites = 0;
  const { app, storage, disk } = await setup(t, original => ({ load: () => original.load(), readCurrent: () => original.readCurrent(), async save(state) {
    await original.save(state);
    if (lose && state.taskCreationReceipts?.['task-create-ack-lost']) { lose = false; taskWrites++; throw new Error('controlled saved acknowledgement lost'); }
  } }));
  let reopened;
  try {
    const before = await app.getSnapshot(); lose = true;
    const created = await app.createTask(input('task-create-ack-lost'));
    assertCreated(await app.getSnapshot(), await disk(), created, before);
    assert.equal(taskWrites, 1);
    assert.equal((await app.createTask(input('task-create-ack-lost'))).id, created.id);
    await assert.rejects(app.createTask(input('task-create-ack-lost', '另一份正文')), /task-create-conflict/);
    await app.flush();
    reopened = new DCodeApplication(new MockExecutionBackend(), storage); await reopened.init();
    const receipt = await reopened.lookupTaskCreation({ operationId: 'task-create-ack-lost' });
    assert.equal(receipt.status, 'created'); assert.equal(receipt.task.id, created.id);
    assert.equal(receipt.task.mainSessionId, created.mainSessionId);
    assert.equal((await reopened.getSnapshot()).tasks.length, before.tasks.length + 1);
    assert.equal((await reopened.getSnapshot()).sessions.length, before.sessions.length + 1);
  } finally { await app.flush(); if (reopened) await reopened.flush(); }
});

test('创建结果未知：旧整表/关闭不得覆盖；原operation查回不写盘或开始工作', async t => {
  let lose = false, unavailable = false, writes = 0;
  const { app, disk } = await setup(t, storage => ({ load: () => storage.load(), async readCurrent() {
    if (unavailable) throw new Error('controlled read unavailable'); return storage.readCurrent();
  }, async save(state) {
    writes++; await storage.save(state);
    if (lose) { lose = false; unavailable = true; throw new Error('controlled unknown after saved'); }
  } }));
  try {
    const before = await app.getSnapshot(); lose = true;
    await assert.rejects(app.createTask(input('task-create-unknown')), /task-create-unknown/);
    assert.equal((await app.getSnapshot()).tasks.length, before.tasks.length);
    assert.deepEqual((await app.getSnapshot()).pendingTaskCreation, { operationId: 'task-create-unknown', workspaceId: 'ws-home', title: '命名长期任务' });
    const saved = await disk(), count = writes;
    await assert.rejects(app.updateSettings({ theme: 'dark' }), /settings-save-failed/);
    await assert.rejects(app.flush(), /close-failed/);
    assert.equal(writes, count, '未知时禁止用旧整表覆盖已落盘创建');
    assert.equal((await app.lookupTaskCreation({ operationId: 'task-create-unknown' })).status, 'unknown');
    assert.equal(writes, count);
    unavailable = false;
    const lookup = await app.lookupTaskCreation({ operationId: 'task-create-unknown' });
    assert.equal(lookup.status, 'created');
    assert.equal(lookup.task.id, saved.taskCreationReceipts['task-create-unknown'].taskId);
    assert.equal((await app.getSnapshot()).pendingTaskCreation, null);
    assert.equal(writes, count, '读回只发布已核实对象，不重新创建或补写');
    assert.equal((await app.getSnapshot()).runs[lookup.task.mainSessionId].status, 'ready');
  } finally { unavailable = false; await app.flush().catch(() => undefined); }
});

test('两个创建和设置并发：每次真实保存串行收束且模型默认/对象不丢失', async t => {
  const { app, disk } = await setup(t);
  try {
    const before = await app.getSnapshot();
    const [a, b] = await Promise.all([app.createTask(input('task-create-a', '甲')), app.createTask(input('task-create-b', '乙')), app.updateSettings({ theme: 'dark' })]);
    const saved = await disk();
    assert.notEqual(a.id, b.id); assert.equal(saved.tasks.length, before.tasks.length + 2);
    assert.equal(saved.sessions.length, before.sessions.length + 2);
    assert.equal(saved.settings.theme, 'dark');
    for (const created of [a, b]) assert.ok(saved.sessions.some(s => s.id === created.mainSessionId && s.taskId === created.id));
  } finally { await app.flush(); }
});

test('父任务短期草稿：发送前零新对象；默认长期任务也可作为父，首发和重试保归属', async t => {
  const { app } = await setup(t);
  try {
    const before = await app.getSnapshot(), parent = before.tasks.find(task => task.isDefault);
    const send = { taskId: parent.id, parentTaskId: parent.id, operationId: 'child-first-input', text: '父任务里的短期工作', mode: 'steer' };
    const first = await app.sendMessage(send);
    const after = await app.getSnapshot(), session = after.sessions.find(s => s.id === first.sessionId), child = after.tasks.find(task => task.id === session.taskId);
    assert.equal(child.parentId, parent.id, '首发必须保父归属，不能另落到空间根部');
    assert.equal(child.kind, 'short'); assert.equal(child.workspaceId, parent.workspaceId);
    assert.equal(after.tasks.length, before.tasks.length + 1);
    assert.equal((await app.sendMessage(send)).sessionId, first.sessionId);
    assert.equal((await app.getSnapshot()).tasks.length, after.tasks.length);
  } finally { await app.flush(); }
});

test('不可信父归属在接收前拒绝；新公开创建/回查合同不接受无身份或多义目标', async t => {
  const { app } = await setup(t);
  try {
    const before = await app.getSnapshot();
    await assert.rejects(app.sendMessage({ taskId: 'task-home-default', parentTaskId: 'nonmatching-parent', operationId: 'bad-parent-input', text: '不得接收', mode: 'steer' }), /parent|父/);
    assert.deepEqual((await app.getSnapshot()).tasks, before.tasks);
    assert.deepEqual((await app.getSnapshot()).sessions, before.sessions);
    assert.notEqual(validateOperationInput('createTask', { workspaceId: 'ws-home', parentId: null, title: '缺少身份' }), null);
    assert.notEqual(validateOperationInput('createTask', { ...input('bad-create'), parentId: 'task-home-default' }), null);
    assert.notEqual(validateOperationInput('sendMessage', { sessionId: 'session-a', parentTaskId: 'task-home-default', text: '多义目标', mode: 'steer' }), null);
    assert.equal(validateOperationInput('lookupTaskCreation', { operationId: 'task-not-found' }), null);
    assert.equal(isValidOpResponse('lookupTaskCreation', { operationId: 'task-not-found', status: 'unknown' }), true);
  } finally { await app.flush(); }
});

test('启动状态不可读：不能把种子内存当原创建不存在，也不能新建覆盖未核实状态', async t => {
  let writes = 0, opens = 0;
  const app = new DCodeApplication({ kind: 'mock', modelName: 'controlled', async open() { opens++; throw new Error('unexpected execution'); } }, {
    async load() { return { status: 'unreadable', error: 'controlled prior state unreadable' }; },
    async readCurrent() { return { status: 'unreadable', error: 'controlled prior state unreadable' }; },
    async save() { writes++; throw new Error('must preserve prior state'); },
  });
  t.after(() => app.flush().catch(() => undefined));
  await app.init();
  const before = writes;
  assert.equal((await app.lookupTaskCreation({ operationId: 'prior-unknown-create' })).status, 'unknown', '种子对象不证明旧操作可靠未保存');
  await assert.rejects(app.createTask(input('new-over-unreadable')), /task-create-unknown/);
  assert.equal(writes, before); assert.equal(opens, 0);
});

test('排队创建遇到前次结果未知：未尝试保存的第二项可靠未创建，不生成第二个待核proposal', async t => {
  const entered = gate(), proceed = gate(); let armed = false, unreadable = false, writes = 0;
  const { app, disk } = await setup(t, storage => ({ load: () => storage.load(), async readCurrent() {
    if (unreadable) throw new Error('controlled first save readback unavailable'); return storage.readCurrent();
  }, async save(state) {
    writes++; await storage.save(state);
    if (armed) { armed = false; entered.release(); await proceed.wait; unreadable = true; throw new Error('controlled first acknowledgement lost'); }
  } }));
  try {
    armed = true;
    const first = app.createTask(input('queued-first', '第一项保存未知')); void first.catch(() => undefined);
    await entered.wait;
    const second = app.createTask(input('queued-second', '第二项尚未写盘')); void second.catch(() => undefined);
    const count = writes; proceed.release();
    const results = await Promise.allSettled([first, second]);
    assert.equal(results[0].status, 'rejected'); assert.match(results[0].reason.message, /task-create-unknown/);
    assert.equal(results[1].status, 'rejected');
    assert.equal(writes, count, '第二项不能发出旧整表写盘');
    assert.equal((await app.lookupTaskCreation({ operationId: 'queued-second' })).status, 'not-found', '从未尝试保存不应伪造第二个未知结果');
    assert.match(results[1].reason.message, /task-create-blocked/);
    assert.equal((await app.getSnapshot()).pendingTaskCreation.operationId, 'queued-first');
    const saved = await disk(); assert.ok(saved.taskCreationReceipts['queued-first']); assert.equal(saved.taskCreationReceipts['queued-second'], undefined);
    unreadable = false;
    assert.equal((await app.lookupTaskCreation({ operationId: 'queued-first' })).status, 'created');
    assert.equal((await app.getSnapshot()).pendingTaskCreation, null);
    const created = await app.createTask(input('queued-second', '第二项尚未写盘'));
    assert.equal((await disk()).tasks.filter(task => task.id === created.id).length, 1);
  } finally { proceed.release(); unreadable = false; await app.flush().catch(() => undefined); }
});


test('前项已未知后新的创建：尚未写盘须明确blocked而非本项unknown', async t => {
  let armed = false, unavailable = false, writes = 0;
  const { app, disk } = await setup(t, storage => ({ load: () => storage.load(), async readCurrent() {
    if (unavailable) throw new Error('controlled prior creation readback unavailable');
    return storage.readCurrent();
  }, async save(state) {
    writes++; await storage.save(state);
    if (armed) { armed = false; unavailable = true; throw new Error('controlled prior creation acknowledgement lost'); }
  } }));
  try {
    const before = await app.getSnapshot(); armed = true;
    await assert.rejects(app.createTask(input('direct-prior-unknown', '前项结果未知')), /task-create-unknown/);
    const count = writes;
    await assert.rejects(app.createTask(input('direct-never-started', '尚未尝试的后项')), /task-create-blocked/);
    assert.equal(writes, count, '新的后项从未尝试写盘');
    assert.equal((await app.lookupTaskCreation({ operationId: 'direct-never-started' })).status, 'not-found');
    const snapshot = await app.getSnapshot();
    assert.equal(snapshot.pendingTaskCreation.operationId, 'direct-prior-unknown', '继续核原真正未知身份');
    assert.equal(snapshot.tasks.length, before.tasks.length, '未知结果核实前不发布对象');
    const saved = await disk();
    assert.ok(saved.taskCreationReceipts['direct-prior-unknown']);
    assert.equal(saved.taskCreationReceipts['direct-never-started'], undefined);
    unavailable = false;
    assert.equal((await app.lookupTaskCreation({ operationId: 'direct-prior-unknown' })).status, 'created');
    const created = await app.createTask(input('direct-never-started', '尚未尝试的后项'));
    assert.equal((await disk()).tasks.filter(task => task.id === created.id).length, 1);
  } finally {
    unavailable = false;
    await app.lookupTaskCreation({ operationId: 'direct-prior-unknown' }).catch(() => undefined);
    await app.flush().catch(() => undefined);
  }
});
