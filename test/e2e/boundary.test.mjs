// 边界端到端：坏请求 / 坏推送不污染当前状态，有效通路保持可用。
// 坏请求经真实桥到主进程入口校验；坏推送由 DCODE_TEST_BAD_PUSH 注入（仅此环境变量显式开启）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { launchApp, cleanup, ready } from "./helpers.mjs";

test("畸形请求被拒绝且不改变状态；有效部分更新仍生效", async () => {
  const { page, stateDir, close } = await launchApp();
  try {
    await ready(page);
    await page.getByRole("heading", { name: "开始一项新工作" }).waitFor();

    const settingsOf = () => page.evaluate(() => window.dcode.getSnapshot().then((s) => s.settings));
    const taskCountOf = () => page.evaluate(() => window.dcode.getSnapshot().then((s) => s.tasks.length));
    const before = await settingsOf();
    const tasksBefore = await taskCountOf();

    // 坏枚举 / 坏类型 / 越界数值 / 未知键：全部在入口拒绝
    for (const bad of [
      { theme: "invalid-theme" },
      { fontSize: 99 },
      { fontSize: "large" },
      { language: 42 },
      { nope: 1 },
    ]) {
      await assert.rejects(
        () => page.evaluate((b) => window.dcode.updateSettings(b), bad),
        /拒绝|非法|畸形/,
        `畸形设置应被拒绝: ${JSON.stringify(bad)}`,
      );
    }
    // 空文本 / 未知会话：拒绝（后者过形状校验后在应用层拒绝）
    await assert.rejects(() =>
      page.evaluate(() => window.dcode.sendMessage({ taskId: "task-home-default", text: "", mode: "steer" })),
    );
    await assert.rejects(() =>
      page.evaluate(() => window.dcode.sendMessage({ sessionId: "no-such-session", text: "x", mode: "steer" })),
    );

    assert.deepEqual(await settingsOf(), before, "坏请求不得改变设置");
    assert.equal(await taskCountOf(), tasksBefore, "坏请求不得建对象");

    // 有效部分更新仍生效（合法通路保留）
    await page.evaluate(() => window.dcode.updateSettings({ theme: "dark" }));
    assert.equal((await settingsOf()).theme, "dark");
    await page.evaluate(() => window.dcode.updateSettings({ fontSize: 13 }));
    assert.equal((await settingsOf()).fontSize, 13);
  } finally {
    await close();
    cleanup(stateDir);
  }
});

test("畸形推送被接收侧丢弃，界面保持上一份已确认快照", async () => {
  // 首次真实推送后 100ms 注入畸形推送（main 侧 DCODE_TEST_BAD_PUSH 门控）
  const { page, stateDir, close } = await launchApp(undefined, { DCODE_TEST_BAD_PUSH: "1" });
  try {
    await ready(page);
    await page.getByRole("heading", { name: "开始一项新工作" }).waitFor();
    // 触发首次真实推送（设置变更 → commit → 推送；随后注入畸形推送）
    await page.evaluate(() => window.dcode.updateSettings({ theme: "dark" }));
    // 若畸形推送进入渲染层，store 会被替换为垃圾对象，界面随即崩溃或空白
    await page.waitForTimeout(600);
    await page.getByRole("heading", { name: "开始一项新工作" }).waitFor();
    const snap = await page.evaluate(() => window.dcode.getSnapshot());
    assert.equal(snap.settings.theme, "dark", "畸形推送不得覆盖已确认状态");
    assert.ok(Array.isArray(snap.tasks) && snap.tasks.length > 0, "畸形推送不得污染对象列表");
  } finally {
    await close();
    cleanup(stateDir);
  }
});
