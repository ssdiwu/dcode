import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { searchWorkerSource } from '../../src/adapters/pi/search-tools.ts';
import { until } from './fixtures.ts';

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const exists = async path => { try { await readFile(path); return true; } catch { return false; } };

for (const name of ['grep', 'find']) await test(`实际 SDK ${name}：pre-spawn await 中取消，释放等待后不得迟到启动子进程`, { timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dcode-search-pre-spawn-'));
  const project = join(root, 'project'); const agentDir = join(root, 'agent');
  await mkdir(join(project, '.git'), { recursive: true }); await mkdir(join(agentDir, 'bin'), { recursive: true });
  const canonicalProject = await realpath(project);
  await writeFile(join(project, 'input.txt'), 'search-window-marker\n');
  const started = join(root, 'child-pid'); const stopped = join(root, 'child-stopped');
  const entered = join(root, 'sdk-await-entered'); const aborted = join(root, 'abort-delivered'); const release = join(root, 'release-await');
  const binary = join(agentDir, 'bin', name === 'grep' ? 'rg' : 'fd');
  await writeFile(binary, `#!/bin/sh\ntrap ${quote(`printf stopped > ${quote(stopped)}; exit 0`)} TERM\nprintf '%s' "$$" > ${quote(started)}\nwhile :; do sleep 0.05; done\n`);
  await chmod(binary, 0o700);
  // 仅验证模块的公开操作闸：调用原 SDK，SDK 文件和业务 timeout 均不修改。
  // grep 用公开 operations.isDirectory；find 保持原 default，通过 Node access 的精确 .git 等待取得同一窗口。
  const sdkModule = join(root, 'sdk-await-wrapper.mjs');
  await writeFile(sdkModule, `
import fs from 'node:fs/promises';
import { parentPort } from 'node:worker_threads';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as tick } from 'node:timers/promises';
const entered=${JSON.stringify(entered)}, aborted=${JSON.stringify(aborted)}, release=${JSON.stringify(release)};
parentPort.on('message', message => { if (message === 'abort') void fs.writeFile(aborted, 'delivered'); });
async function gate() {
  await fs.writeFile(entered, 'waiting');
  while (true) { try { await fs.readFile(release); return; } catch { await tick(5); } }
}
const actualAccess = fs.access;
if (${JSON.stringify(name)} === 'find') {
  fs.access = async (path, ...args) => { if (path === ${JSON.stringify(join(canonicalProject, '.git'))}) await gate(); return await actualAccess(path, ...args); };
  syncBuiltinESMExports();
}
const sdk = await import(${JSON.stringify(import.meta.resolve('@earendil-works/pi-coding-agent'))});
export const createGrepTool = cwd => sdk.createGrepTool(cwd, { operations: {
  async isDirectory(path) { await gate(); return (await fs.stat(path)).isDirectory(); },
  readFile: path => fs.readFile(path, 'utf8'),
} });
export const createFindTool = sdk.createFindTool;
export const createLsTool = sdk.createLsTool;
`);
  const messages = []; let exitCode; let worker;
  try {
    worker = new Worker(searchWorkerSource, { eval: true, execArgv: [],
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', NODE_TEST_CONTEXT: undefined },
      workerData: { name, args: { pattern: 'search-window-marker', path: '.' }, cwd: project, agentDir, callId: `pre-spawn-${name}`, sdk: pathToFileURL(sdkModule).href } });
    worker.on('message', message => messages.push(message));
    worker.on('exit', code => { exitCode = code; });
    await until(() => exists(entered));
    worker.postMessage('abort');
    // find 已有早期监听，SDK 可能先报 cancelled 并关闭端口；该真实回复本身证明取消已到，不等被关闭的取证监听。
    await until(async () => await exists(aborted) || messages.some(message => message.ok === false && message.code === 'cancelled'));
    await writeFile(release, 'released');
    await until(async () => exitCode !== undefined || await exists(started));
    assert.equal(await exists(started), false, '原取消已到达，原 SDK await 释放后不得出现迟到进程');
    await until(() => exitCode !== undefined);
    assert.equal(exitCode, 0, '实际线程自然退出，不用 terminate 替工具收束');
    assert.deepEqual(messages, [{ ok: false, code: 'cancelled' }]);
  } finally {
    // 只收回本次夹具已明确启动且仍由本线程持有的进程；旧错误实现必须保真红并清理，不能留下活体。
    await writeFile(release, 'cleanup');
    if (exitCode === undefined) worker?.postMessage('abort');
    if (await exists(started)) {
      const pid = Number(await readFile(started, 'utf8')); assert.ok(pid > 0);
      try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    if (worker) await until(() => exitCode !== undefined);
    await rm(root, { recursive: true, force: true });
  }
});
