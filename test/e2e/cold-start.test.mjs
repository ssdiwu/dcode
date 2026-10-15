// 冷启动与设置路径：首次进入缺配置、草稿保留、恢复失效回退、移动归属定位、主题/字号/启动档位。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchApp, cleanup, ready, killApp } from "./helpers.mjs";

test("首次进入：真实不可用状态、设置无假表单、草稿往返与重开保留", async () => {
  const first = await launchApp(undefined, { DCODE_VALIDATION_ASSEMBLY: "", DCODE_VALIDATION_SAMPLE: "0" });
  try {
    const { page } = first;
    await ready(page);
    await page.getByRole("heading", { name: "开始一项新工作" }).waitFor();
    await page.getByText("当前没有可用模型", { exact: false }).first().waitFor();
    assert.equal(await page.getByRole("button", { name: "发送", exact: true }).isDisabled(), true);
    const composer = page.getByPlaceholder("写下需求，保存为草稿…");
    await composer.fill("这条草稿不能丢");
    await composer.press("Enter");
    assert.equal(await composer.inputValue(), "这条草稿不能丢");
    const before = await page.evaluate(() => window.dcode.getSnapshot());
    assert.equal(before.execution.kind, "unavailable");
    assert.equal(before.workspaces.length, 1);
    assert.equal(before.tasks.length, 1);
    assert.equal(before.sessions.length, 0);
    assert.deepEqual(before.timelines, {});
    // D02（spec/页面与交互组件.md）：缺配置时内联给出到真实配置位置的入口，草稿保留。
    // 这里仍然禁止的是「Home 上的假配置表单」——入口只导航，不在草稿页内联伪造表单。
    assert.equal(await page.locator('input[type="password"]').count(), 0, "草稿页不内联伪造的模型配置表单");
    assert.equal(await page.getByRole("button", { name: "去设置" }).count(), 1, "缺配置时应内联给出到真实配置位置的入口");
    await page.getByRole("button", { name: "去设置" }).click();
    // D02 入口落到模型分区本身，而不是通用设置首页：既要有真实表单，也要能判定当前分区。
    // 模型分区合并为「预设供应商 / 自定义」双页签且默认预设（spec S07、spec/模型选择与自动切换.md
    // 「空配置正常打开」）：真实表单先验预设页签的供应商选择器，密钥输入只属于自定义页签。
    await page.getByLabel(/^(供应商|Provider)$/).waitFor();
    assert.equal(
      await page.getByRole("button", { name: /^模型/ }).getAttribute("aria-current"),
      "page",
      "D02 入口应直接落在模型分区",
    );
    assert.equal(await page.locator('input[type="password"]').count(), 0, "预设页签不出现自定义密钥输入");
    assert.equal(
      await page.getByRole("radio", { name: /^自定义$|^Custom$/ }).count(),
      1,
      "模型分区同时保留自定义入口",
    );
    await page.getByRole("button", { name: "返回" }).click();
    await page.getByRole("heading", { name: "开始一项新工作" }).waitFor();
    assert.equal(await composer.inputValue(), "这条草稿不能丢", "经 D02 入口往返设置后草稿保留");
    assert.equal(await page.getByRole("button", { name: "发送", exact: true }).isDisabled(), true);
    await page.getByRole("button", { name: /^设置/ }).click();
    await page.getByRole("button", { name: /^模型/ }).click();
    // 真实配置入口存在（不是标签伪解锁）；未填字段时保存被禁用、快照仍为 unconfigured
    // 双 tab 默认 preset；密码/password input 在 custom tab
    await page.getByRole("radio", { name: /^自定义$|^Custom$/ }).click();
    await page.locator('input[type="password"]').waitFor();
    assert.equal(await page.locator('input[type="password"]').inputValue(), "");
    assert.equal(await page.getByRole("button", { name: "保存", exact: true }).isDisabled(), true);
    assert.equal(await page.evaluate(() => typeof window.dcode.configureModel), "function");
    assert.equal((await page.evaluate(() => window.dcode.getSnapshot())).modelSetup.kind, "unconfigured");
    await page.keyboard.press("Escape");
    assert.equal(await composer.inputValue(), "这条草稿不能丢");
    assert.equal(await page.getByRole("button", { name: "发送", exact: true }).isDisabled(), true);
    await first.close();
    const second = await launchApp(first.stateDir, { DCODE_VALIDATION_ASSEMBLY: "", DCODE_VALIDATION_SAMPLE: "0" });
    try {
      await ready(second.page);
      assert.equal(await second.page.getByPlaceholder("写下需求，保存为草稿…").inputValue(), "这条草稿不能丢");
      const reopened = await second.page.evaluate(() => window.dcode.getSnapshot());
      assert.deepEqual(reopened.timelines, {});
      assert.deepEqual(reopened.sessions, []);
    } finally { await second.close(); }
  } finally { await first.close(); cleanup(first.stateDir); }
});

test("恢复目标失效与被移动：回退说明与归属定位", async () => {
  // 子场景 A：恢复目标被删除 → 回退 Home 默认任务并说明
  const a = await launchApp();
  try {
    await ready(a.page);
    await a.page.getByRole("heading", { name: "开始一项新工作" }).waitFor();
    await a.page.getByRole("button", { name: /聊聊下个季度的规划/ }).click();
    await a.page.getByRole("button", { name: "新会话" }).waitFor();
    await a.close();

    // 模拟对象在离开期间被删除（外部改动持久化状态）
    const stateFile = join(a.stateDir, "dcode-prototype-state.json");
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    state.sessions = state.sessions.filter((s) => s.id !== "session-home-1");
    delete state.timelines["session-home-1"];
    delete state.runs["session-home-1"];
    writeFileSync(stateFile, JSON.stringify(state));

    const a2 = await launchApp(a.stateDir);
    await ready(a2.page);
    try {
      await a2.page.getByText("上次的工作位置已不存在", { exact: false }).waitFor();
      await a2.page.getByRole("heading", { name: "开始一项新工作" }).waitFor();
      await a2.page.getByText("Home / 默认任务", { exact: true }).waitFor();
      await a2.close();
    } finally {
      await a2.app.close().catch(() => {});
    }
  } finally {
    await killApp(a);
    cleanup(a.stateDir);
  }

  // 子场景 B：恢复目标被移动到其他空间 → 定位到当前归属
  const b = await launchApp();
  try {
    await ready(b.page);
    await b.page.getByRole("heading", { name: "开始一项新工作" }).waitFor();
    await b.page.getByRole("button", { name: /《设计中的设计》摘抄/ }).click();
    // 草稿近期卡片也有同名位置；必须等真实会话页与位置保存完成，不能导航尚在途就退出。
    await b.page.locator("main header").getByText("Home / 整理读书笔记", { exact: true }).waitFor();
    await b.page.waitForFunction(() => JSON.parse(localStorage.getItem("dcode-prototype-ui-v1") ?? "{}").lastScene?.sessionId === "session-readme-1");
    await b.close();

    const stateFile = join(b.stateDir, "dcode-prototype-state.json");
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    for (const task of state.tasks) {
      if (task.id === "task-readme") {
        task.workspaceId = "ws-dcode";
        task.boundFolder = null;
      }
    }
    writeFileSync(stateFile, JSON.stringify(state));

    const b2 = await launchApp(b.stateDir);
    await ready(b2.page);
    try {
      // 界面恢复到该会话，且归属显示为新空间
      await b2.page.locator("main header").getByText("D Code / 整理读书笔记", { exact: true }).waitFor();
      await b2.page.getByText("整理好了，五条摘抄如下", { exact: false }).waitFor();
      await b2.close();
    } finally {
      await b2.app.close().catch(() => {});
    }
  } finally {
    await killApp(b);
    cleanup(b.stateDir);
  }
});

test("主题、字号旋钮与启动档位生效", async () => {
  const { page, stateDir, close } = await launchApp();
  try {
    await ready(page);
    await page.getByRole("heading", { name: "开始一项新工作" }).waitFor();

    await page.getByRole("button", { name: /^设置/ }).click();
    await page.getByRole("radio", { name: "浅色" }).click();
    await page.waitForFunction(() => !document.documentElement.classList.contains("dark"));
    await page.getByRole("radio", { name: "深色" }).click();
    await page.waitForFunction(() => document.documentElement.classList.contains("dark"));

    await page.getByRole("button", { name: "减小" }).click();
    await page.waitForFunction(
      () =>
        // 旋钮事实存在无单位数值上；计算字号经 var 链路到 body
        document.documentElement.style.getPropertyValue("--ui-font-size-num") === "13" &&
        getComputedStyle(document.body).fontSize === "13px",
    );

    // 切到固定 Home 新草稿；先去一个会话留下现场
    await page.getByRole("button", { name: "启动" }).click();
    await page.getByRole("radio", { name: "Home 新草稿" }).click();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: /聊聊下个季度的规划/ }).click();
    await page.getByRole("button", { name: "新会话" }).waitFor();
    await close();

    const again = await launchApp(stateDir);
    await ready(again.page);
    try {
      // 固定 Home 新草稿档位：不恢复上次的会话现场
      await again.page.getByRole("heading", { name: "开始一项新工作" }).waitFor();
      await again.page.getByText("Home / 默认任务", { exact: true }).first().waitFor();

      // 切回恢复现场档位后重开，应回到会话
      await again.page.getByRole("button", { name: /^设置/ }).click();
      await again.page.getByRole("button", { name: "启动" }).click();
      await again.page.getByRole("radio", { name: "恢复上次现场" }).click();
      await again.page.keyboard.press("Escape");
      await again.close();
    } finally {
      await again.app.close().catch(() => {});
    }

    const third = await launchApp(stateDir);
    await ready(third.page);
    try {
      await third.page.getByRole("button", { name: "新会话" }).waitFor();
      await third.page.getByRole("button", { name: "新会话" }).waitFor();
      await third.page.getByText("帮我理一下下个季度想做的三件事", { exact: false }).waitFor();
      await third.close();
    } finally {
      await third.app.close().catch(() => {});
    }
  } finally {
    cleanup(stateDir);
  }
});
