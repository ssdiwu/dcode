import assert from 'node:assert/strict';
import {spawn, execFile} from 'node:child_process';
import {openSync, closeSync, writeSync, constants} from 'node:fs';
import {once} from 'node:events';
import {promisify} from 'node:util';
import {mkdtemp, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'dcode-helper-lifecycle-'));
const binary = join(root, 'dist/bin/dcode-model-credentials');
const driver = join(temp, 'owned-helper-ui');
await exec('xcrun', ['swiftc', '-swift-version', '6', join(root, 'test/native/credential-helper-ui.swift'), '-o', driver]);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const request = JSON.stringify({operation: 'prompt', providerName: '隔离生命周期验证',
  type: 'select', message: '这是不连接账号的辅助程序验证。',
  options: [{id: 'synthetic', label: '隔离测试选项'}]}) + '\n';
const windows = async pid => Number((await exec(driver, [String(pid), 'windows'])).stdout.trim());
const assertNoWindow = async pid => {
  for (let i = 0; i < 40; i++) { if (await windows(pid) === 0) return; await sleep(50); }
  assert.fail('Owned helper window remained after cleanup');
};

for (const [action, code, response] of [['继续', 0, {value: 'synthetic'}], ['取消', 2, {error: 'cancelled'}]]) {
  const child = spawn(binary, [], {stdio: ['pipe', 'pipe', 'pipe']});
  const closed = once(child, 'close');
  let output = '';
  child.stdout.setEncoding('utf8').on('data', data => { output += data; });
  child.stderr.resume();
  try {
    child.stdin.write(request);
    await sleep(3300);
    assert.equal(child.signalCode, null, 'Complete production helper must survive native modal wait');
    assert.equal(child.exitCode, null);
    assert.ok(await windows(child.pid) > 0, 'Owned native window is visible');
    await exec(driver, [String(child.pid), action], {timeout: 5000});
    assert.deepEqual(await closed, [code, null]);
    assert.deepEqual(JSON.parse(output), response);
    await assertNoWindow(child.pid);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  }
}

const input = join(temp, 'input');
await exec('/usr/bin/mkfifo', [input]);
const inputFd = openSync(input, constants.O_RDWR);
const parent = spawn(process.execPath, ['--input-type=module', '-e', `
  import {spawn} from 'node:child_process';
  const child = spawn(process.argv[1], [], {stdio: ['inherit', 'inherit', 'inherit']});
  console.log(child.pid); setInterval(() => {}, 1000);
`, binary], {stdio: [inputFd, 'pipe', 'pipe']});
const closed = once(parent, 'close'), exited = once(parent, 'exit');
let pid, deadline;
try {
  pid = Number(String((await once(parent.stdout, 'data'))[0]).trim());
  assert.ok(Number.isInteger(pid) && pid > 1);
  writeSync(inputFd, request);
  await sleep(3300);
  assert.ok(await windows(pid) > 0, 'Real modal is open before parent loss');
  parent.kill(); await exited;
  await Promise.race([closed, new Promise((_, reject) => { deadline = setTimeout(() => reject(Error('Orphan helper retained pipes')), 3500); })]);
  assert.throws(() => process.kill(pid, 0), {code: 'ESRCH'});
  await assertNoWindow(pid);
} finally {
  clearTimeout(deadline); closeSync(inputFd);
  if (pid) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  if (parent.exitCode === null && parent.signalCode === null) parent.kill();
  await closed;
}
console.log(JSON.stringify({temp,completeHelper:true,sha256:createHash('sha256').update(await readFile(binary)).digest('hex'),
  modalSurvivesMultipleTicks:true,nativeContinue:true,nativeCancel:true,parentDeathWithOpenStdin:true,visibleWindowCleanup:true,
  fixtureOnly:true,realAccounts:false,keychainUntouched:true}));
