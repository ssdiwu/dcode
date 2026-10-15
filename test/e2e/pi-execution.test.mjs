// Pi 模式端到端：真实 Pi Durable + 受控模型（不连真实服务商）。
// 证据链：UI 发送 → 正式接收 → 真实 Pi 工具写隔离文件 → 暂停 → 正常关闭 →
// 重开只查询（模型调用数不增）→ 用户显式继续 → 该次输入 done。
// 与 mock 套件分开报告：本文件是「真实 Pi + 受控模型」档证据，非真实服务商验收。

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchApp, assertValidationModel, ready, waitForSnapshot } from "./helpers.mjs";
import { evidenceDir } from "./evidence-root.mjs";

// 证据写进本次运行的隔离根（见 evidence-root.mjs），不覆盖任何历史归档。
const piEvidence = evidenceDir("pi-execution");

const requestCount = (demoDir) => {
  const log = join(demoDir, "model-requests.jsonl");
  if (!existsSync(log)) return 0;
  return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length;
};

test("真实 Pi：发送→接收→真实工具写文件→暂停→重开只读→显式继续→done", async () => {
  const root = mkdtempSync(join(tmpdir(), "dcode-pi-e2e-"));
  const demoDir = join(root, "demo-work");
  mkdirSync(demoDir, { recursive: true });
  const stateDir = join(root, "state");
  const env = { DCODE_VALIDATION_ASSEMBLY: "pi-controlled", DCODE_DEMO_DIR: demoDir, DCODE_PI_GATE: "1" };

  const first = await launchApp(stateDir, env);
  try {
    const { page } = first;
    await ready(page);
    // 执行事实以产品快照为准（HTML 标题是静态壳文案，不承载执行态）
    const snap = await page.evaluate(() => window.dcode.getSnapshot());
    assert.equal(snap.execution?.kind, "pi", "装配必须是真实 Pi 执行端");

    await assertValidationModel(page);
    await page.getByRole("heading", { name: "开始一项新工作" }).waitFor();

    const text = "在隔离目录写入一个文件";
    await page.getByPlaceholder("交代需求、提问或粘贴内容…").fill(text);
    await page.getByPlaceholder("交代需求、提问或粘贴内容…").press("Enter");

    // 已接收 + 真实 Pi 工具写文件（从磁盘读回验证，不看界面自述）
    await page.getByText("已接收", { exact: true }).first().waitFor();
    // 记录本次发送的会话与消息身份（供收口时按同一 operationId 核 done）
    const identity = await page.evaluate(() => {
      return window.dcode.getSnapshot().then((snap) => {
        for (const [sessionId, blocks] of Object.entries(snap.timelines)) {
          for (const b of blocks) {
            if (b.kind === "message" && b.role === "user" && b.text.includes("隔离目录")) {
              return { sessionId, blockId: b.id, operationId: b.operationId };
            }
          }
        }
        return null;
      });
    });
    assert.ok(identity?.operationId, "消息块必须携带发送身份");
    const resultFile = join(demoDir, "pi-result.txt");
    const deadline = Date.now() + 20000;
    while (!existsSync(resultFile)) {
      assert.ok(Date.now() < deadline, "真实 Pi 工具应在限时内写出隔离文件");
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.match(readFileSync(resultFile, "utf8"), /real Pi tool/);

    // 时间线投影到真实工具结果：工具块默认折叠，展开后可见写出路径
    await page.getByRole("button", { name: /工具结果|tool-result/ }).first().click();
    await page.getByText(/pi-result\.txt/).first().waitFor();

    // 第二个模型请求被门文件挂起（在途生成）；此时暂停
    await page.getByRole("button", { name: "暂停" }).click();
    await page.getByText("已暂停", { exact: true }).first().waitFor();
    const requestsAtPause = requestCount(demoDir);
    assert.ok(requestsAtPause >= 1, "暂停前至少发生一次真实模型请求");
    await first.close();

    // 重开：只查询不执行（模型调用数不增），恢复条等待显式接续
    const second = await launchApp(stateDir, env);
    try {
      await ready(second.page);
      await second.page.getByText("已打开上次的工作记录", { exact: false }).waitFor();
      await second.page.getByText("已暂停", { exact: true }).first().waitFor();
      assert.equal(requestCount(demoDir), requestsAtPause, "重开不得新增模型调用");
      const snap2 = await second.page.evaluate(() => window.dcode.getSnapshot());
      assert.equal(snap2.execution?.kind, "pi", "重开后仍是真实 Pi 执行端");

      // 显式继续：放行门文件，等待该次输入 done
      // 恢复条按钮与 Composer 恢复钮同名，恢复条在时间线顶部（DOM 在前）
      await second.page.getByRole("button", { name: "继续执行" }).first().click();
      await waitForSnapshot(second.page, (s, sid) => s.runs[sid]?.status === "running", identity.sessionId);
      const modelDeadline = Date.now() + 20000;
      while (requestCount(demoDir) <= requestsAtPause) {
        assert.ok(Date.now() < modelDeadline, "明确继续后模型请求应实际到达");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      // 先确认恢复后的原回执确实在处理，不能把暂停前缓存的 done 当本次已回答。
      const placedSnapshot = await waitForSnapshot(second.page, (s, ids) => {
        const block = s.timelines[ids.sessionId]?.find((b) => b.id === ids.blockId);
        return block?.receipt?.status === "accepted" && block.receipt.processing === "placed";
      }, identity);
      writeFileSync(join(demoDir, ".answer-gate"), "open");
      // 收口核对：先只等普通 tick 把原消息更新为 done；不额外发送或主动回查推进状态。
      // （pendingInputs 归零或空集合都不算完成证据；正文出现也不代表完成）
      assert.ok(requestCount(demoDir) > requestsAtPause, "显式继续后才产生新的模型调用");
      const doneSnapshot = await waitForSnapshot(second.page, (s, ids) => {
        const block = s.timelines[ids.sessionId]?.find((b) => b.id === ids.blockId);
        return block?.receipt?.status === "accepted" && block.receipt.processing === "done";
      }, identity);
      const requestsBeforeLookup = requestCount(demoDir);
      const receipt = await second.page.evaluate((ids) => window.dcode.checkReceipt(ids).then((r) => r.receipt), identity);
      assert.equal(receipt?.status, "accepted", "同一操作须已接收");
      assert.equal(receipt?.processing, "done", "同一 operationId 须 done，而非靠 pendingInputs 归零");
      assert.equal(requestCount(demoDir), requestsBeforeLookup, "done 后原合同的回查仍只读");
      const originalReceipt = (s) => s.timelines[identity.sessionId].find((b) => b.id === identity.blockId)?.receipt;
      writeFileSync(join(piEvidence, "pi-natural-observation.json"), JSON.stringify({
        identity, beforeResume: originalReceipt(snap2), gateHeldAfterResume: originalReceipt(placedSnapshot),
        naturalDoneBeforeExplicitLookup: originalReceipt(doneSnapshot), explicitReadAfterDone: receipt,
        requestsAtPause, requestsBeforeLookup, requestsAfterLookup: requestCount(demoDir),
      }, null, 2));
      await second.page.getByText("已接收", { exact: true }).waitFor({ state: "hidden" });
      // 助手正文经 assistantText 正式字段呈现（已提交正文，非完成信号）
      await second.page.getByText(/受控模型：已按确定文本回答/).first().waitFor();

      // 正文已生成后再重开：同内容同身份、不重复投影；只读不新增模型请求/工具执行
      const textIdentity = await second.page.evaluate(() => {
        return window.dcode.getSnapshot().then((snap) => {
          for (const [sid, blocks] of Object.entries(snap.timelines)) {
            const found = blocks.filter(
              (b) => b.kind === "message" && b.role === "assistant" && b.text.includes("受控模型：已按确定文本回答"),
            );
            if (found.length) return { sid, ids: found.map((b) => b.id), text: found[0].text };
          }
          return null;
        });
      });
      assert.ok(textIdentity && textIdentity.ids.length === 1, "正文块必须存在且唯一");
      const requestsBeforeReopen2 = requestCount(demoDir);
      await second.close();

      const third = await launchApp(stateDir, env);
      try {
        await ready(third.page);
        await third.page.getByText(/受控模型：已按确定文本回答/).first().waitFor();
        const afterReopen = await third.page.evaluate((sid) => {
          return window.dcode.getSnapshot().then((snap) => {
            const blocks = snap.timelines[sid] ?? [];
            const found = blocks.filter(
              (b) => b.kind === "message" && b.role === "assistant" && b.text.includes("受控模型：已按确定文本回答"),
            );
            return { ids: found.map((b) => b.id), texts: found.map((b) => b.text) };
          });
        }, textIdentity.sid);
        assert.deepEqual(afterReopen.ids, textIdentity.ids, "正文生成后重开：同一投影身份，不重复追加");
        assert.deepEqual(afterReopen.texts, [textIdentity.text], "正文生成后重开：原文一致");
        assert.equal(requestCount(demoDir), requestsBeforeReopen2, "正文生成后重开只读：不新增模型请求/已完成工具不重复执行");
        await third.close();
      } finally {
        await third.app.close().catch(() => {});
      }
    } finally {
      await second.app.close().catch(() => {});
    }
  } finally {
    await first.app.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});
