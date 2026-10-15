// 验证工装已知退出事实，不把 app.exit 当作产品正常 flush 的证据。
// 只有空白隔离实例；退出监听先登记，测试不依赖迟到的新 exit 事件。
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { launchApp, ready, killApp, cleanup } from './helpers.mjs';

for (const code of [0, 1]) test(`退出工装：已退出进程 ${code} 不等新的 exit，正常与异常出口分别处理`, async () => {
  const handle = await launchApp(undefined, { DCODE_VALIDATION_ASSEMBLY: '', DCODE_VALIDATION_SAMPLE: '0' });
  try {
    await ready(handle.page);
    const proc = handle.app.process();
    const exited = once(proc, 'exit');
    // 故意只验证已退出事实的消费；这条直接退出不证明应用保存或执行收束成功。
    await handle.app.evaluate(({ app }, exitCode) => app.exit(exitCode), code).catch(() => undefined);
    const [actualCode, signal] = await exited;
    assert.equal(actualCode, code);
    assert.equal(signal, null);
    assert.equal(proc.exitCode, code);
    if (code === 0) await handle.close();
    else await assert.rejects(handle.close(), /关闭前已异常退出.*code=1/);
  } finally {
    await killApp(handle);
    cleanup(handle.stateDir);
  }
});

test('退出工装：并发 close 共同等待真实退出，不提前报已关闭', async () => {
  const handle = await launchApp(undefined, { DCODE_VALIDATION_ASSEMBLY: '', DCODE_VALIDATION_SAMPLE: '0' });
  // Playwright channel 在关闭后已释放，真实 ChildProcess 须在此前取出并保留。
  const proc = handle.app.process();
  const original = handle.app.close.bind(handle.app);
  let release = () => {};
  const gate = new Promise(resolve => { release = resolve; });
  const flights = [];
  try {
    await ready(handle.page);
    let calls = 0;
    let secondSettled = false;
    // 只停工装向 Playwright 发出关闭的阶段，产品退出逻辑仍沿原正式入口。
    handle.app.close = () => { calls += 1; return gate.then(original); };
    const first = handle.close();
    const second = handle.close().then(() => { secondSettled = true; });
    flights.push(first, second);
    for (const flight of flights) void flight.catch(() => undefined);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(calls, 1);
    assert.equal(proc.exitCode, null);
    assert.equal(secondSettled, false, '真实关闭仍未发出，第二次 close 也必须保持在途');
    release();
    await Promise.all(flights);
    assert.equal(proc.exitCode, 0);
  } finally {
    release();
    await Promise.allSettled(flights);
    handle.app.close = original;
    await killApp(handle);
    cleanup(handle.stateDir);
  }
});
