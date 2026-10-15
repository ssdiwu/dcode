// 存储保护端到端：损坏保全、读取失败不覆盖、保存失败可见。
// 全部在独立临时目录注入故障；不碰真实用户数据。

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchApp, ready, killApp } from "./helpers.mjs";

const stateFile = (dir) => join(dir, "dcode-prototype-state.json");

test("损坏的状态文件：成功保全后从空白开始并如实说明", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dcode-e2e-corrupt-"));
  writeFileSync(stateFile(dir), "{ 这不是合法 JSON", "utf8");
  const original = readFileSync(stateFile(dir), "utf8");

  const { page, app, close } = await launchApp(dir);
  try {
    await ready(page);
    await page.getByText("保存的工作记录无法读取", { exact: false }).waitFor();
    const aside = readdirSync(dir).find((f) => f.startsWith("dcode-prototype-state.json.corrupt-"));
    assert.ok(aside, "损坏原文件必须被改名保全");
    assert.equal(readFileSync(join(dir, aside), "utf8"), original, "保全文件字节必须不变");
    await app.close();
  } finally {
    await app.close().catch(() => {});
    await killApp({ stateDir: dir, close });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("读取失败（权限拒绝）：保留原文件、显式报错、不种子覆盖", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dcode-e2e-unreadable-"));
  writeFileSync(stateFile(dir), JSON.stringify({ marker: "原文件内容" }), "utf8");
  const original = readFileSync(stateFile(dir), "utf8");
  chmodSync(stateFile(dir), 0o000);

  const { page, close } = await launchApp(dir);
  try {
    await ready(page);
    await page.getByText("无法读取保存的工作记录", { exact: false }).waitFor();
    // 一次真实操作后，写入被拒绝且可见
    await page.getByRole("button", { name: /^设置/ }).click();
    await page.getByRole("radio", { name: "浅色" }).click();
    await page.getByText(/设置未能保存|本次更改无法保存/, { exact: false }).first().waitFor();
    // 恢复读取权限以核对原字节：保护闩锁在进程内，恢复文件权限并不解除拒写
    chmodSync(stateFile(dir), 0o600);
    assert.equal(readFileSync(stateFile(dir), "utf8"), original, "读取失败后不得覆盖原文件");
  } finally {
    chmodSync(stateFile(dir), 0o600);
    // 受保护状态下 flush 按设计固定失败、应用保持打开：不等待永不成功的正常关闭，直接强制结束并等真实退出
    await killApp({ stateDir: dir, close });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("保存失败进入可见通路：banner 出现，不伪报成功", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dcode-e2e-savefail-"));
  const { page, close } = await launchApp(dir);
  try {
    await ready(page);
    await page.getByRole("heading", { name: "开始一项新工作" }).waitFor();
    // 启动落盘完成后再注入只读故障
    const deadline = Date.now() + 10000;
    while (!existsSync(stateFile(dir))) {
      assert.ok(Date.now() < deadline, "启动落盘应在限时内完成");
      await new Promise((r) => setTimeout(r, 100));
    }
    chmodSync(dir, 0o555);
    await page.getByRole("button", { name: /^设置/ }).click();
    await page.getByRole("radio", { name: "浅色" }).click();
    await page.getByText("设置未能保存", { exact: false }).first().waitFor();
  } finally {
    chmodSync(dir, 0o755);
    await killApp({ stateDir: dir, close });
    rmSync(dir, { recursive: true, force: true });
  }
});
