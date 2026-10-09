// 双语路径：切换语言保留工作位置、草稿与执行状态，选择被持久化；
// 用户内容（消息、会话标题、路径）不随界面语言翻译。

import { test } from "node:test";
import assert from "node:assert/strict";
import { launchApp, assertValidationModel, cleanup, ready } from "./helpers.mjs";

test("中英切换：位置、草稿与执行状态保留，语言选择跨重开持久", async () => {
  const first = await launchApp();
  const stateDir = first.stateDir;
  try {
    const { page } = first;
    await ready(page);
    await page.getByRole("heading", { name: "开始一项新工作" }).waitFor();

    // 确认专用测试装配的模型可用
    await assertValidationModel(page);
    await page.getByRole("heading", { name: "开始一项新工作" }).waitFor();

    // 进一个有内容的会话并在输入框留草稿
    await page.getByRole("button", { name: /字号步进器与默认值/ }).click();
    await page.getByRole("button", { name: "新会话" }).waitFor();
    await page.getByPlaceholder("追问、补充或纠正…").fill("draft must survive language switch");
    // 无「已完成」相：就绪的历史会话以可见正文为锚点（折叠工具块的正文不算）
    await page.getByText("输入控件测试 260/260 通过", { exact: false }).first().waitFor();

    // 切到 English
    await page.getByRole("button", { name: /^设置/ }).click();
    await page.getByRole("radio", { name: "English" }).click();
    await page.getByText("Appearance", { exact: true }).waitFor();
    await page.keyboard.press("Escape");

    // 位置与内容不变：同一会话、草稿仍在、执行状态未因切换改变
    await page.getByRole("button", { name: "New session" }).waitFor();
    assert.equal(
      await page.getByPlaceholder("Follow up, add detail, or correct…").inputValue(),
      "draft must survive language switch",
      "切换语言后草稿应保留",
    );
    // 无「已完成」相：就绪的历史会话只呈现内容，不显示完成徽标
    await page.getByText("输入控件测试 260/260 通过", { exact: false }).first().waitFor();
    await page.getByText("字号步进器与默认值", { exact: false }).first().waitFor();
    await page.getByText("字号设置改为步进器", { exact: false }).first().waitFor();

    // 草稿态的英文文案：D Code 的默认任务还没有会话（Home 的已有，会进时间线）
    await page.getByRole("treeitem", { name: /默认任务|Default task/ }).nth(1).click();
    await page.getByRole("heading", { name: "Start new work" }).waitFor();
    await page.getByText("Continue", { exact: true }).waitFor();
    // 回到原会话再关闭：lastScene 记录的是最后的工作位置
    await page.getByRole("button", { name: /字号步进器与默认值/ }).first().click();
    await page.getByRole("button", { name: "New session" }).waitFor();
    await first.close();
  } finally {
    await first.app.close().catch(() => {});
  }

  // 重开：语言选择持久，现场恢复，文案仍为英文
  const second = await launchApp(stateDir);
  try {
    await ready(second.page);
    await second.page.getByRole("button", { name: "New session" }).waitFor();
    assert.equal(
      await second.page.getByPlaceholder("Follow up, add detail, or correct…").inputValue(),
      "draft must survive language switch",
      "重开后草稿与语言选择都应持久",
    );

    // 切回中文
    await second.page.getByRole("button", { name: /^Settings/ }).click();
    await second.page.getByRole("radio", { name: "中文" }).click();
    await second.page.getByText("外观", { exact: true }).waitFor();
    await second.page.keyboard.press("Escape");
    await second.page.getByRole("button", { name: "新会话" }).waitFor();
    await second.close();
  } finally {
    await second.app.close().catch(() => {});
    cleanup(stateDir);
  }
});
