import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {mkdtempSync, openSync, closeSync, constants, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';

const binary = fileURLToPath(new URL('../bin/dcode-model-credentials', import.meta.url));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('complete credential helper survives parent-watch cycles inside the actual native modal', {timeout: 10000}, async () => {
  const helper = spawn(binary, [], {stdio: ['pipe', 'pipe', 'pipe']});
  const closed = once(helper, 'close');
  try {
    helper.stdin.write(JSON.stringify({operation: 'prompt', providerName: '隔离生命周期验证',
      type: 'select', message: '这是不连接账号的辅助程序验证。',
      options: [{id: 'synthetic', label: '隔离测试选项'}]}) + '\n');
    await sleep(3300);
    assert.equal(helper.signalCode, null, 'The production NSAlert wait must not trap at the first timer tick');
    assert.equal(helper.exitCode, null);
  } finally {
    if (helper.exitCode === null && helper.signalCode === null) helper.kill();
    await closed;
  }
});

test('complete credential helper survives multiple parent-watch cycles while stdin is blocked', {timeout: 10000}, async () => {
  const helper = spawn(binary, [], {stdio: ['pipe', 'pipe', 'pipe']});
  const closed = once(helper, 'close');
  let output = '';
  helper.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  try {
    await sleep(3300);
    assert.equal(helper.signalCode, null, 'The complete production main must not trap at the first timer tick');
    assert.equal(helper.exitCode, null, 'The complete helper remains available while its parent is alive');
    helper.stdin.end('{}\n');
    assert.deepEqual(await closed, [1, null]);
    assert.deepEqual(JSON.parse(output), {error: 'unavailable'}, 'The same process still handles its private input');
  } finally {
    if (helper.exitCode === null && helper.signalCode === null) helper.kill();
    await closed;
  }
});

test('complete credential helper exits after parent death even with its input pipe kept open', {timeout: 12000}, async () => {
  // A real FIFO stays open in this outer process. Node's default socketpair
  // can signal EOF when the intermediary exits, which would hide a broken watch.
  const temp = mkdtempSync(join(tmpdir(), 'dcode-helper-parent-'));
  const input = join(temp, 'input');
  execFileSync('/usr/bin/mkfifo', [input]);
  const inputFd = openSync(input, constants.O_RDWR);
  const parent = spawn(process.execPath, ['--input-type=module', '-e', `
    import {spawn, execFileSync} from 'node:child_process';
import {mkdtempSync, openSync, closeSync, constants, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
    const helper = spawn(process.argv[1], [], {stdio: ['inherit', 'inherit', 'inherit']});
    console.log(helper.pid);
    setInterval(() => {}, 1000);
  `, binary], {stdio: [inputFd, 'pipe', 'pipe']});
  const closed = once(parent, 'close');
  const exited = once(parent, 'exit');
  let pid: number | undefined;
  let cleanup: ReturnType<typeof setTimeout> | undefined;
  try {
    pid = Number(String((await once(parent.stdout!, 'data'))[0]).trim());
    assert.ok(Number.isInteger(pid) && pid > 1);
    await sleep(2300);
    assert.doesNotThrow(() => process.kill(pid!, 0), 'The full helper survives before parent loss');
    parent.kill();
    await exited;
    await Promise.race([closed, new Promise((_, reject) => {
      cleanup = setTimeout(() => reject(Error('Orphan helper retained its inherited pipes')), 3500);
    })]);
    assert.throws(() => process.kill(pid!, 0), {code: 'ESRCH'});
  } finally {
    clearTimeout(cleanup);
    closeSync(inputFd);
    rmSync(temp, {recursive: true, force: true});
    if (pid) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    if (parent.exitCode === null && parent.signalCode === null) parent.kill();
    await closed;
  }
});
