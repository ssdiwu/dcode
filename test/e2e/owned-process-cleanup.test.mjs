import test from 'node:test';
import assert from 'node:assert/strict';
import { launchApp, ready, cleanup, killApp } from './helpers.mjs';

await test('隔离进程回收：已关闭旧句柄不能终止同目录新owner或清掉它的活进程保护', async () => {
  const first = await launchApp();
  const firstProc = first.app.process();
  const stateDir = first.stateDir;
  let current, primary;
  try {
    await ready(first.page); await first.close();
    assert.equal(firstProc.exitCode, 0);
    current = await launchApp(stateDir); await ready(current.page);
    const proc = current.app.process();
    assert.equal(proc.exitCode, null); assert.equal(proc.signalCode, null);
    await killApp(first);
    await killApp({ stateDir, close: first.close });
    assert.equal(proc.exitCode, null, '旧handle不能按相同stateDir终止当前新进程');
    assert.equal(proc.signalCode, null); assert.equal(proc.killed, false);
    assert.throws(() => cleanup(stateDir), /live process/, '旧handle不能移除新owner的清理保护');
    assert.ok(await current.page.evaluate(() => document.body.innerText.includes('D Code')));
    await current.close(); assert.equal(proc.exitCode, 0); assert.equal(proc.signalCode, null);
  } catch (error) { primary = error; }
  finally {
    for (const handle of [current, first].filter(Boolean)) {
      try { await killApp(handle); } catch (error) { primary ??= error; }
    }
    try { cleanup(stateDir); } catch (error) { primary ??= error; }
  }
  if (primary) throw primary;
});
