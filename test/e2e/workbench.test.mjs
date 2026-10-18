// 工作台路径：草稿态继续区与推荐动作、侧栏手风琴、开发任务全链（无审批路径）、暂停与重开恢复。

import { test } from "node:test";
import assert from "node:assert/strict";
import { launchApp, assertValidationModel, cleanup, ready } from "./helpers.mjs";

async function dump(page, tag) {
  const body = await page.evaluate(() => document.body.innerText.slice(0, 400)).catch(() => "<no eval>");
  console.log(`[dump ${tag}]`, JSON.stringify(body));
}

test("草稿态：继续区定位、推荐动作只填草稿、任务行进入主会话", async () => {
  const { page, stateDir, close } = await launchApp();
  try {
    await ready(page);
    await page.getByRole("heading", { name: "开始一项新工作" }).waitFor();

    // 推荐动作：点击只填入草稿，不发送、不导航
    await page.getByText("不知道从哪开始？推荐动作").click();
    await page.getByRole("button", { name: "描述一个开发任务，让 D Code 动手改代码" }).click();
    const composer = page.getByPlaceholder("写下需求，保存为草稿…").or(page.getByPlaceholder("交代需求、提问或粘贴内容…"));
    assert.equal(
      await composer.inputValue(),
      "描述一个开发任务，让 D Code 动手改代码",
      "推荐动作应只填入草稿",
    );
    await ready(page);
    await page.getByRole("heading", { name: "开始一项新工作" }).waitFor();

    // 继续区：点击定位到对应会话（纯导航）
    await page.getByRole("button", { name: /字号步进器与默认值/ }).click();
    await page.getByRole("button", { name: "新会话" }).waitFor();
    await page.getByText("D Code / 字号设置改为步进器", { exact: true }).waitFor();

    // 任务名称行只进入主会话，主会话本身不重复列在成员层。
    await page.getByRole("treeitem", { name: "整理读书笔记" }).click();
    await page.locator("main header").getByText("Home / 整理读书笔记", { exact: true }).waitFor();
    const tree = page.getByRole("tree", { name: "工作空间与任务" });
    assert.equal(
      await tree.getByRole("treeitem", { name: /《设计中的设计》摘抄/ }).count(),
      0,
      "主会话不应重复出现在成员列表",
    );
  } finally {
    await close();
    cleanup(stateDir);
  }
});

test("开发任务全链：发送、工具折叠与展开、无审批路径、失败、聚合卡与检查器", async () => {
  const { page, stateDir, close } = await launchApp();
  try {
    await ready(page);
    await page.getByRole("heading", { name: "开始一项新工作" }).waitFor();

    // 确认专用测试装配的模型可用
    await assertValidationModel(page);
    await ready(page);
    await page.getByRole("heading", { name: "开始一项新工作" }).waitFor();

    // 在 D Code 空间新建长期任务并发送需求
    const workspaceRow = page.getByRole("treeitem", { name: "D Code" });
    // hover 才出现的按钮：先悬停行，再 force 点击跳过稳定性等待
    const plusButton = workspaceRow.getByRole("button", { name: "在此空间新建任务" });
    await workspaceRow.hover();
    await plusButton.waitFor({ state: "visible" });
    await plusButton.click({ force: true });
    await page.getByRole("menuitem", { name: "新建长期任务" }).click();
    await page.getByPlaceholder("任务名称").fill("E2E 冒烟任务");
    await page.getByRole("button", { name: "创建" }).click();
    await page.getByText("D Code / E2E 冒烟任务", { exact: true }).waitFor().catch(async (e) => {
      await dump(page, "after-create");
      throw e;
    });
    const afterCreate = await page.evaluate(() => window.dcode.getSnapshot());
    const createdTask = afterCreate.tasks.find((task) => task.title === "E2E 冒烟任务");
    const mainSession = afterCreate.sessions.find((session) => session.taskId === createdTask?.id && session.kind === "main");
    assert.ok(createdTask && mainSession, "命名长期任务保存时已有唯一主会话");
    assert.equal(afterCreate.sessions.filter((session) => session.taskId === createdTask.id).length, 1);

    await page.getByPlaceholder("交代需求、提问或粘贴内容…").fill("把 Composer 的焦点反馈收进容器壳");
    await page.getByPlaceholder("交代需求、提问或粘贴内容…").press("Enter");

    // 已命名长期任务的首条输入进入刚保存的主会话，不再另建空间根任务。
    // 用户消息与 mock 回复的引用会重复出现该文案，取第一个（用户气泡）
    await page.getByText("把 Composer 的焦点反馈收进容器壳", { exact: true }).first().waitFor();
    await page.getByText("已接收", { exact: true }).first().waitFor();
    await assertValidationModel(page);
    const afterSend = await page.evaluate(() => window.dcode.getSnapshot());
    assert.equal(afterSend.tasks.length, afterCreate.tasks.length, "已有长期任务发送不再新建短期任务");
    assert.ok((afterSend.timelines[mainSession.id] ?? []).some((block) => block.kind === "message" && block.role === "user" && block.text === "把 Composer 的焦点反馈收进容器壳"), "原文落在该主会话");

    // 执行中：纯导航不改变执行状态（无权限步骤：旧审批卡已移除，全链不等待用户确认）
    await page.getByRole("treeitem", { name: "整理读书笔记" }).click();
    assert.equal(
      await page.getByRole("button", { name: "允许一次" }).count(),
      0,
      "权限审批卡属旧形态，全链不应出现",
    );
    await page.getByRole("treeitem", { name: "E2E 冒烟任务" }).click();
    await page.getByText("执行中", { exact: true }).first().waitFor();

    // 失败块自动展开：可见错误输出与复制按钮
    await page.getByRole("button", { name: /第一次/ }).waitFor();
    await page.getByRole("button", { name: "复制错误" }).waitFor();

    // 复跑通过：工具块默认折叠，先展开再核对输出（覆盖就地展开行为）
    await page.getByRole("button", { name: /复跑/ }).click();
    await page.getByText("248/248 断言通过", { exact: false }).waitFor();
    // 等最终消息到位、布局稳定后再点聚合卡（运行中点击移动中的目标是典型 flake）
    await page.getByText("焦点反馈统一由容器承担", { exact: false }).waitFor();
    await page.getByRole("button", { name: /本轮改动/ }).click();
    await page.getByText("文件改动（2）", { exact: true }).waitFor().catch(async (e) => {
      await dump(page, "inspector-open");
      throw e;
    });
    // 工具块摘要里也含文件名，检查器标签限定在 aside 内
    await page.locator("aside").getByRole("button", { name: "styles.css" }).click();
    await page.getByText("残留的旧规则", { exact: false }).waitFor().catch(async (e) => {
      const aside = await page.locator("aside").evaluate((el) => el.innerText.slice(0, 500)).catch(() => "<no aside>");
      console.log("[dump aside]", JSON.stringify(aside));
      await dump(page, "diff-content");
      throw e;
    });
    await page.getByRole("button", { name: "关闭检查器" }).click();
    await page.getByText("文件改动（2）", { exact: true }).waitFor({ state: "hidden" });

    // 本轮结束：运行回到 ready 相位——没有「已完成」徽标可显示（端口无完成相，界面不推断）
    await page.getByText("本轮结束。", { exact: true }).waitFor();
    await page.getByText("执行中", { exact: true }).waitFor({ state: "hidden" });

    // 从真实呈现的差异关闭返回后，继续在原主会话追问；此处是隔离界面链，
    // 真实 SDK 再次修改与测试由普通编码路径的相连场景另证。
    const beforeFollowUp = await page.evaluate(() => window.dcode.getSnapshot());
    const currentSessionId = JSON.parse(await page.evaluate(() => localStorage.getItem("dcode-prototype-ui-v1") ?? "{}" )).selectedSessionId;
    const followUp = "看完差异后继续调整焦点反馈";
    await page.getByPlaceholder("追问、补充或纠正…").fill(followUp);
    await page.getByPlaceholder("追问、补充或纠正…").press("Enter");
    await page.waitForFunction(({ sessionId, text }) => {
      const ui = JSON.parse(localStorage.getItem("dcode-prototype-ui-v1") ?? "{}");
      return ui.selectedSessionId === sessionId && document.body.innerText.includes(text);
    }, { sessionId: currentSessionId, text: followUp });
    const afterFollowUp = await page.evaluate(() => window.dcode.getSnapshot());
    assert.equal(afterFollowUp.tasks.length, beforeFollowUp.tasks.length, "检查差异后追问不新建任务");
    assert.equal(afterFollowUp.sessions.length, beforeFollowUp.sessions.length, "检查差异后追问仍在原主会话");
    assert.ok((afterFollowUp.timelines[currentSessionId] ?? []).some((block) => block.kind === "message" && block.role === "user" && block.text === followUp && block.receipt?.status === "accepted"), "原主会话实际接收追问");
  } finally {
    await close();
    cleanup(stateDir);
  }
});

test("暂停与重开：恢复条显式接续，不自动继续执行", async () => {
  const first = await launchApp();
  let stateDir = first.stateDir;
  try {
    const { page } = first;
    await ready(page);
    await page.getByRole("heading", { name: "开始一项新工作" }).waitFor();
    await assertValidationModel(page);

    await page.getByPlaceholder("交代需求、提问或粘贴内容…").fill("给侧栏树加上键盘方向键导航");
    await page.getByPlaceholder("交代需求、提问或粘贴内容…").press("Enter");
    await page.getByText("执行中", { exact: true }).first().waitFor();

    // 暂停：停止推进并保留真实状态
    await page.getByRole("button", { name: "暂停" }).click();
    await page.getByText("已暂停", { exact: true }).first().waitFor();
    await page.getByText("已暂停。进度已保存", { exact: false }).waitFor();
    await first.close();
  } finally {
    await first.app.close().catch(() => {});
  }

  // 重开：界面恢复现场，执行保持暂停，恢复条等待显式接续
  const second = await launchApp(stateDir);
  await ready(second.page);
  try {
    await second.page.getByText("已打开上次的工作记录", { exact: false }).waitFor().catch(async (e) => {
      await dump(second.page, "reopen-resume-bar");
      throw e;
    });
    await second.page.getByText("已暂停", { exact: true }).first().waitFor();

    // 仅查看：收起恢复条但不推进
    await second.page.getByRole("button", { name: "仅查看" }).click();
    await second.page
      .getByText("已打开上次的工作记录", { exact: false })
      .waitFor({ state: "hidden" });
    await second.page.getByText("已暂停", { exact: true }).first().waitFor();

    // 显式继续：重开后接续段走到本轮结束
    await second.page.getByRole("button", { name: "继续执行" }).click();
    await second.page.getByText("接续完成", { exact: false }).waitFor();
    await second.page.getByText("本轮结束。", { exact: true }).waitFor();
    await second.close();
  } finally {
    await second.app.close().catch(() => {});
  }

  // 再重开：结束标记与内容持久保留
  const third = await launchApp(stateDir);
  await ready(third.page);
  try {
    await third.page.getByText("本轮结束。", { exact: true }).first().waitFor();
    await third.page.locator("main").getByText("给侧栏树加上键盘方向键导航", { exact: true }).first().waitFor();
    await third.close();
  } finally {
    await third.app.close().catch(() => {});
    cleanup(stateDir);
  }
});
