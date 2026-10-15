// 真实 UI 首次添加服务商：Home → Settings → 添加 → 保存 → 发送 → 重开仍可用；
// 本地回环服务器接收正确 model/test key，UI 看到非空正文；快照与日志不回显凭据。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, mkdtempSync, existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { launchApp, ready, cleanup, killApp, waitForSnapshot } from "./helpers.mjs";
import { evidenceDir } from "./evidence-root.mjs";

const EVID = evidenceDir("model-setup");
mkdirSync(EVID, { recursive: true });

const expectedKey = `sk-test-${randomBytes(16).toString("hex")}`;
const wrongKey = `sk-wrong-${randomBytes(16).toString("hex")}`;
const EXPECTED_MODEL_ID = "test-model";

/** 通用 loopback 协议服务器：可配置 expectedKey/expectedModel，且支持后续 reconfigure（编辑 modelId 用例二段校验）。
 *  一次只能有一个活跃 expectedModel——保存时期望旧 ID；编辑后期望新 ID；服务器对每个请求严格按当前期望校验。 */
function startProtocolServer(options = {}) {
  const expKey = options.expectedKey ?? expectedKey;
  let currentExpModel = options.expectedModel ?? EXPECTED_MODEL_ID;
  const requests = [];
  // Node 侧有界等待：每次 push 后 resolve 所有等待者，无 sleep/空函数
  const waiters = new Set();
  const notify = () => { for (const w of [...waiters]) w(); };
  let seq = 0;
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(String(c)));
      req.on("end", () => {
        if (req.method !== "POST" || !(req.url ?? "").includes("/chat")) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "not-found" } }));
          return;
        }
        // 精确相等：不接受 Bearer 前缀宽松 contains；model 按当前期望严格相等
        const auth = req.headers["authorization"];
        const authOk = typeof auth === "string" && auth === `Bearer ${expKey}`;
        let bodyOk = false;
        let parsedModel = null;
        try {
          const body = JSON.parse(chunks.join(""));
          parsedModel = body?.model ?? null;
          bodyOk = parsedModel === currentExpModel;
        } catch { /* JSON.parse 失败即 body 不全 */ }
        // 独立随机 nonce＋请求序号：不派生自 expectedKey，请求记录里保存对应 nonce
        const nonce = randomBytes(6).toString("hex");
        const marker = `RT-${++seq}-${nonce}`;
        requests.push({
          seq, authExact: authOk, modelExact: bodyOk, parsedModel, nonce, marker,
          bodyPresent: chunks.join("").length > 0, fullBody: chunks.join(""),
        });
        notify();
        if (!authOk || !bodyOk) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "unauthorized-or-bad-model" } }));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end([
          `data: {"id":"chatcmpl-${seq}","object":"chat.completion.chunk","created":0,"model":"${currentExpModel}","choices":[{"index":0,"delta":{"role":"assistant","content":"${marker}"},"finish_reason":null}]}`,
          ``,
          `data: {"id":"chatcmpl-${seq}","object":"chat.completion.chunk","created":0,"model":"${currentExpModel}","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
          ``,
          `data: [DONE]`,
          ``,
        ].join("\n"));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        port,
        origin: `http://127.0.0.1:${port}`,
        requests,
        /** 更新服务器当前期望的 modelId（编辑 modelId 用例的二段验证）；旧请求记录不变。 */
        setExpectedModel: (m) => { currentExpModel = m; },
        /** 有界等待服务器请求数达到 n；到达才返回当前记录。超时抛错带当前数目。 */
        awaitCount: (n, timeoutMs = 30_000) => new Promise((res, rej) => {
          // 真正有界定时器：无新请求时也能超时收尾；成功到达立即清表并把 waiter 移出集合。
          const timer = setTimeout(() => {
            waiters.delete(check);
            rej(new Error(`server.awaitCount(${n}) 超时：当前 ${requests.length}`));
          }, timeoutMs);
          const check = () => {
            if (requests.length >= n) {
              clearTimeout(timer);
              waiters.delete(check);
              return res(requests.slice());
            }
            waiters.add(check);
          };
          check();
        }),
        close: () => new Promise((r) => server.close(() => r(undefined))),
      });
    });
  });
}

const sidebarSettingsButton = (page) => page.locator("nav").getByRole("button", { name: /设置|Settings/ });
const settingsSideBar = (page) => page.locator(".w-44");

/** 模型配置表单四字段按可访问名称填写：getByLabel 依赖真实 label 关联，缺标签会直接超时失败。 */
async function fillModelSetupForm(page, { label, modelId, baseUrl, apiKey }) {
  await page.getByLabel(/显示名|Display name/i).fill(label);
  await page.getByLabel(/模型 ID|Model ID/i).fill(modelId);
  await page.getByLabel(/Base URL/i).fill(baseUrl);
  if (apiKey !== undefined) {
    await page.getByLabel(/API 密钥|API key/i).fill(apiKey);
  }
}

/** 断言当前页面正文实际可见 marker（独立于快照）：用严格文本定位器，不允许宽匹配假通过。 */
async function expectMarkerVisible(page, marker) {
  await page.getByText(marker, { exact: true }).waitFor({ timeout: 10_000 });
}

async function artistNow(page) {
  // Playwright waitForFunction 把 Promise 当 truthy，必须走 waitForSnapshot 读真实值
  await waitForSnapshot(
    page,
    (s) => (s?.modelSetup?.kind === "custom" || s?.modelSetup?.kind === "preset-with-custom") && s?.model?.available === true,
    null,
    "保存后快照应呈现 modelSetup.custom|preset-with-custom 且 model.available=true",
  );
}

/** 自定义面板进入指引（无专用 helper）：在 settings-模型 section 默认 preset tab 时，
 *  各用例在进入前须先切 `getByRole("radio", { name: /^自定义$|^Custom$/ })` 再填写 openai-completions/Anthropic 协议字段。
 *  当前所有首用路径均已在保存前切到 custom tab（见用例首行注释）。 */

function assertNoKeyLeak(containerText, key) {
  assert.ok(!containerText.includes(key), "界面/快照/日志不能含测试 key");
}

test("真实 UI：首次添加服务商 → 保存 → 发送 → 重开仍可用；凭据不回显", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "dcode-msetup-"));
  const server = await startProtocolServer();
  const evidence = { stateDir, origin: server.origin, steps: [] };
  const handle = await launchApp(stateDir, { DCODE_VALIDATION_ASSEMBLY: "", DCODE_VALIDATION_SAMPLE: "0" });
  const { page, close } = handle;
  try {
    await ready(page);
    await page.getByRole("heading", { name: /开始一项新工作|Start new work/ }).waitFor();
    evidence.steps.push("home-no-model");

    // Settings → 模型 section
    await sidebarSettingsButton(page).click();
    await settingsSideBar(page).getByRole("button", { name: /模型|Model/ }).click();

    // 保存前：服务器请求数为 0（不允许任何保存前的自动请求）
    assert.equal(server.requests.length, 0, "保存前服务器请求数必须为 0");

    // 真实填写并完成保存（四字段按可访问名称 getByLabel，缺 label 关联会失败）
    // 双 tab 默认 preset；旧断言基于 openai-completions——必须先切 custom tab
    await page.getByRole("radio", { name: /^自定义$|^Custom$/ }).click();
    await page.getByRole("radio", { name: /OpenAI-compatible|OpenAI/i }).click();
    await fillModelSetupForm(page, {
      label: "我的本地回环",
      modelId: EXPECTED_MODEL_ID,
      baseUrl: server.origin + "/v1",
      apiKey: expectedKey,
    });
    await page.getByRole("button", { name: /保存|Save/ }).click();

    // 保存实时结果：不能取静态共享文字假冒，要真正快照 configured+available
    await artistNow(page);
    const snapAfterSave = await page.evaluate(() => window.dcode.getSnapshot());
    assert.equal(snapAfterSave.modelSetup?.kind, "custom");
    assert.equal(snapAfterSave.model?.available, true);
    evidence.steps.push("setup-saved");
    assert.equal(server.requests.length, 0, "保存后服务器请求数仍为 0（保存本身不发请求）");

    // 回草稿：按当前恢复现场定位（可能是草稿会话或主会话）
    await page.keyboard.press("Escape");
    const composer1 = page.getByPlaceholder(/交代需求|Describe|追问、补充|Follow up/i).first();
    await composer1.waitFor({ timeout: 10_000 });
    await composer1.fill("第一请求");
    // 快照基线：发送前 assistant 条数（按 timeline key 记录，避免索引错位）
    const snapBeforeSend = await page.evaluate(() => window.dcode.getSnapshot());
    const beforeAssistantCounts = Object.fromEntries(
      Object.entries(snapBeforeSend.timelines ?? {}).map(([k, blocks]) => [
        k, (blocks ?? []).filter((b) => b.kind === "message" && b.role === "assistant").length,
      ]),
    );
    await composer1.press("Enter");
    // 等 run 自然收束 + 至少一个 timeline 的 assistant 条数增加（新 assistant 到达才算完成）
    await waitForSnapshot(
      page,
      (s, baseline) => {
        if (!s) return false;
        const run = Object.values(s.runs ?? {})[0];
        if (!run || run.status !== "ready" || run.pendingInputs !== 0) return false;
        return Object.entries(s.timelines ?? {}).some(([k, blocks]) => {
          const cur = (blocks ?? []).filter((b) => b.kind === "message" && b.role === "assistant").length;
          return cur > (baseline[k] ?? 0);
        });
      },
      beforeAssistantCounts,
      "发送后应出现 run=ready/pendingInputs=0 且新 assistant 到达",
    );
    evidence.steps.push("send-complete");

    // 快照与 UI：不含 key
    const snapAfterSend = await page.evaluate(() => window.dcode.getSnapshot());
    assertNoKeyLeak(JSON.stringify(snapAfterSend), expectedKey);
    const uiText = await page.evaluate(() => document.body.innerText);
    assertNoKeyLeak(uiText, expectedKey);

    // 服务器收到第 1 条：完整 Authorization＋完整 model 值（有界等待，不用 sleep 或立即断言）
    const firstBatch = await server.awaitCount(1);
    const firstReq = firstBatch[0];
    assert.equal(firstReq.seq, 1);
    assert.equal(firstReq.authExact, true, "首次请求 Authorization 必须精确匹配 Bearer expectedKey");
    assert.equal(firstReq.modelExact, true, "首次请求 body.model 必须精确匹配 test-model");
    assert.ok(typeof firstReq.marker === "string" && firstReq.marker.length > 0);

    // UI 完整呈现该 marker 文本（不能用正则宽匹配，必须原文相等包含）
    await waitForSnapshot(
      page,
      (s, markerText) => {
        if (!s) return false;
        return Object.values(s.timelines ?? {}).some((blocks) =>
          (blocks ?? []).some((b) => b.kind === "message" && b.role === "assistant" && typeof b.text === "string" && b.text.includes(markerText)),
        );
      },
      firstReq.marker,
      "快照应包含首条请求对应的完整 marker 文本",
    );
    // 页面正文实际可见该 marker：独立于快照断言，不允许"快照有但 UI 未渲染"
    await expectMarkerVisible(page, firstReq.marker);

    // 凭据随单原子目录文件（provider-directory.json，格式化 2）加密落盘，**不**含明文；旧单 provider-directory.json 不再新写
    const secretPath = join(stateDir, "provider-directory.json");
    assert.ok(existsSync(secretPath), "provider-directory.json 应该已经写入（含加密凭据）");
    const secretRaw = readFileSync(secretPath, "utf8");
    assertNoKeyLeak(secretRaw, expectedKey);
    evidence.steps.push("credential-encrypted");

    // 明确关闭记录实际信息
    await page.keyboard.press("Escape").catch(() => undefined);
    await close();
    evidence.steps.push("first-run-closed");

    // 重开同一目录在正常装配 → provider-directory.json 使能装配真实 backend，不重输 key
    const handle2 = await launchApp(stateDir, { DCODE_VALIDATION_ASSEMBLY: "", DCODE_VALIDATION_SAMPLE: "0" });
    try {
      await ready(handle2.page);
      // 按实际恢复现场定位——不强猜 Home heading；显示暂停条则按现实选择继续后再发送
      const resumeBar = handle2.page.locator("text=/继续|Continue/i").first();
      const hasResume = await resumeBar.isVisible().catch(() => false);
      if (hasResume) {
        await resumeBar.click();
      }
      const composer2 = handle2.page.getByPlaceholder(/交代需求|Describe|追问、补充|Follow up/i).first();
      await composer2.waitFor({ timeout: 10_000 });
      await composer2.fill("第二请求");
      await composer2.press("Enter");

      // 服务器请求数真实增加到 2：Node 侧有界等待事件，不能用空 waitForFunction/sleep/立即断言
      const batch2 = await server.awaitCount(2);
      const secondReq = batch2[1];
      assert.equal(secondReq.seq, 2, "第二条必须是重开后新请求");
      assert.equal(secondReq.authExact, true, "重开后 Authorization 仍精确匹配——凭据落盘解密可用");
      assert.equal(secondReq.modelExact, true);
      assert.notEqual(secondReq.nonce, batch2[0].nonce, "两次请求必须有独立 nonce");

      // UI 自然完成第二条：run ready + 完整 marker 文本（引用对应请求记录的 marker，不能用旧历史满足）
      await waitForSnapshot(
        handle2.page,
        (s, markerText) => {
          if (!s) return false;
          const run = Object.values(s.runs ?? {})[0];
          if (!run || run.status !== "ready" || run.pendingInputs !== 0) return false;
          return Object.values(s.timelines ?? {}).some((blocks) =>
            (blocks ?? []).some((b) => b.kind === "message" && b.role === "assistant" && typeof b.text === "string" && b.text.includes(markerText)),
          );
        },
        secondReq.marker,
        "重开后快照应包含第二条请求对应的完整 marker",
      );
      // 重开后的页面正文实际可见第二请求 marker（独立于快照断言）
      await expectMarkerVisible(handle2.page, secondReq.marker);
      evidence.steps.push("reopen-send-complete");
    } finally {
      await handle2.close();
    }

    writeFileSync(join(EVID, "model-setup-first-run.json"), JSON.stringify(evidence, null, 1));
  } finally {
    await killApp(handle);
    await server.close();
    cleanup(stateDir);
  }
});

test("401 反馈：保存后首次发送凭据错时界面呈现失败并保留已接收事实，不转回 key，修正后可再请求", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "dcode-msetup-401-"));
  const server = await startProtocolServer();
  const handle = await launchApp(stateDir, { DCODE_VALIDATION_ASSEMBLY: "", DCODE_VALIDATION_SAMPLE: "0" });
  try {
    await ready(handle.page);
    // 保存 wrongKey
    await sidebarSettingsButton(handle.page).click();
    await settingsSideBar(handle.page).getByRole("button", { name: /模型|Model/ }).click();
    // 双 tab 默认 preset；旧断言基于 openai-completions——必须先切 custom tab
    await handle.page.getByRole("radio", { name: /^自定义$|^Custom$/ }).click();
    await handle.page.getByRole("radio", { name: /OpenAI-compatible|OpenAI/i }).click();
    await handle.page.locator("input[placeholder*='服务商']").fill("我的本地回环");
    await handle.page.locator("input[placeholder*='gpt-4o-mini']").fill("test-model");
    await handle.page.locator("input[placeholder*='api.openai.com']").fill(server.origin + "/v1");
    await handle.page.locator("input[type='password']").fill(wrongKey);
    await handle.page.getByRole("button", { name: /保存|Save/ }).click();
    await handle.page.getByText(/已保存|Saved/).waitFor();
    // 第一次真实发送（凭据错误会走 401）
    await handle.page.keyboard.press("Escape");
    const composer = handle.page.getByPlaceholder(/交代需求|Describe/);
    await composer.fill("请答复");
    await composer.press("Enter");
    await server.awaitCount(1);
    // 正向：服务端 401 经 SDK assistant stopReason=error 持久化，由 entries 投影为
    // 有限安全码 auth-failed 进入 run.errorNote；UI 显示真实可见的安全失败文案。
    const snapAfter401 = await handle.page.evaluate(() => window.dcode.getSnapshot());
    const userBlocks = Object.values(snapAfter401.timelines ?? {}).flat().filter((b) => b.kind === "message" && b.role === "user");
    assert.ok(userBlocks.some((b) => b.text === "请答复"), "401 后已发送用户消息必须保留");
    // 正向：UI 显示"服务商凭据未被接受"的安全失败文案（有限码，不含原文/key/URL）
    await waitForSnapshot(
      handle.page,
      (s) => Object.values(s.runs ?? {}).some((r) => r.errorNote === "auth-failed"),
      null,
      "401 后应把 errorNote 设置为 auth-failed",
    );
    await handle.page.getByText(/服务商凭据未被接受|Provider credentials were not accepted/i).waitFor({ timeout: 10_000 });
    // 反向断言：界面与快照与落盘都不含 wrongKey
    const uiTextAfter401 = await handle.page.evaluate(() => document.body.innerText);
    assert.ok(!uiTextAfter401.includes(wrongKey), "界面不能转回 wrongKey");
    const snapshotJson = JSON.stringify(snapAfter401);
    assert.ok(!snapshotJson.includes(wrongKey), "快照不得含 wrongKey");
    const secretRaw = readFileSync(join(stateDir, "provider-directory.json"), "utf8");
    assert.ok(!secretRaw.includes(wrongKey), "provider-directory.json 不得含明文 wrongKey");

    // 修正后用正确 key 重发：编辑配置 keep 改 replace + expectedKey，等 fault→ready 后再发能成功
    await sidebarSettingsButton(handle.page).click();
    await settingsSideBar(handle.page).getByRole("button", { name: /模型|Model/ }).click();
    await handle.page.getByRole("radio", { name: /更换|Replace/i }).click();
    await handle.page.locator("input[type='password']").fill(expectedKey);
    await handle.page.getByRole("button", { name: /保存|Save/ }).click();
    await waitForSnapshot(handle.page, (s) => (s?.modelSetup?.kind === "custom" || s?.modelSetup?.kind === "preset-with-custom"));
    // 修正后再发，必须带新 marker 完整正文 + 自然完成；errorNote 清空
    await handle.page.keyboard.press("Escape");
    const composer2 = handle.page.getByPlaceholder(/交代需求|Describe|追问|Follow/i).first();
    await composer2.fill("修正后");
    await composer2.press("Enter");
    const batch2 = await server.awaitCount(2);
    assert.equal(batch2[1].authExact, true, "修正后第二条请求必须用 expectedKey");
    assert.equal(batch2[1].modelExact, true);
    const secondMarker = batch2[1].marker;
    await waitForSnapshot(
      handle.page,
      (s, markerText) => {
        if (!s) return false;
        const runs = Object.values(s.runs ?? {});
        if (!runs.every((r) => r.status === "ready" && r.pendingInputs === 0)) return false;
        if (!Object.values(s.timelines ?? {}).some((blocks) =>
          (blocks ?? []).some((b) => b.kind === "message" && b.role === "assistant" && typeof b.text === "string" && b.text.includes(markerText)),
        )) return false;
        // 成功 assistant 到达后 errorNote 必须清除（不要遗留历史失败作为当前失败）
        return Object.values(s.runs ?? {}).every((r) => r.errorNote !== "auth-failed");
      },
      secondMarker,
      "修正后必须完整新正文到达且 auth-failed 已清除",
    );
  } finally {
    await killApp(handle);
    await server.close();
    cleanup(stateDir);
  }
});

test("编辑同目标 keep 旧 key：modelId 改成功且下一请求看到新 modelId", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "dcode-msetup-edit-"));
  const server = await startProtocolServer();
  const NEW_MODEL_ID = "test-model-v2";
  const handle = await launchApp(stateDir, { DCODE_VALIDATION_ASSEMBLY: "", DCODE_VALIDATION_SAMPLE: "0" });
  try {
    await ready(handle.page);
    await sidebarSettingsButton(handle.page).click();
    await settingsSideBar(handle.page).getByRole("button", { name: /模型|Model/ }).click();
    // 第一次保存（带 key）
    // 双 tab 默认 preset；旧断言基于 openai-completions——必须先切 custom tab
    await handle.page.getByRole("radio", { name: /^自定义$|^Custom$/ }).click();
    await handle.page.getByRole("radio", { name: /OpenAI-compatible|OpenAI/i }).click();
    await handle.page.locator("input[placeholder*='服务商']").fill("我的本地回环");
    await handle.page.locator("input[placeholder*='gpt-4o-mini']").fill(EXPECTED_MODEL_ID);
    await handle.page.locator("input[placeholder*='api.openai.com']").fill(server.origin + "/v1");
    await handle.page.locator("input[type='password']").fill(expectedKey);
    await handle.page.getByRole("button", { name: /保存|Save/ }).click();
    await waitForSnapshot(handle.page, (s) => (s?.modelSetup?.kind === "custom" || s?.modelSetup?.kind === "preset-with-custom") && s?.model?.available === true);
    // 先发一条：确认首 ID 落地
    await handle.page.keyboard.press("Escape");
    const composer1 = handle.page.getByPlaceholder(/交代需求|Describe/i).first();
    await composer1.waitFor({ timeout: 10_000 });
    await composer1.fill("首发");
    await composer1.press("Enter");
    const firstBatchA = await server.awaitCount(1);
    const firstMarker = firstBatchA[0].marker;
    assert.ok(firstMarker && firstMarker.length > 0);
    // 等 A 完整 marker 出现在快照 + run 彻底收束（不能等到发完请求就立即保存）
    await waitForSnapshot(
      handle.page,
      (s, markerText) => {
        if (!s) return false;
        const runs = Object.values(s.runs ?? {});
        if (!runs.every((r) => r.status === "ready" && r.pendingInputs === 0)) return false;
        return Object.values(s.timelines ?? {}).some((blocks) =>
          (blocks ?? []).some((b) => b.kind === "message" && b.role === "assistant" && typeof b.text === "string" && b.text.includes(markerText)),
        );
      },
      firstMarker,
      "首条应自然完成且 UI 看到完整 marker",
    );
    // 回到 Settings，编辑 modelId 与 label，keep 旧 key
    await sidebarSettingsButton(handle.page).click();
    await settingsSideBar(handle.page).getByRole("button", { name: /模型|Model/ }).click();
    // 编辑：baseUrl 自动回显；keyAction 默认 keep
    await handle.page.locator("input[placeholder*='gpt-4o-mini']").fill(NEW_MODEL_ID);
    await handle.page.locator("input[placeholder*='服务商']").fill("本地回环-v2");
    // keyAction=keep 默认；无需再输 key
    await handle.page.getByRole("button", { name: /保存|Save/ }).click();
    await waitForSnapshot(handle.page, (s) => (s?.modelSetup?.kind === "custom" || s?.modelSetup?.kind === "preset-with-custom") && s?.modelSetup?.modelId === NEW_MODEL_ID && s?.model?.available === true, null, "编辑后快照应反映新 modelId");
    const snap = await handle.page.evaluate(() => window.dcode.getSnapshot());
    assert.equal(snap.modelSetup.modelId, NEW_MODEL_ID);
    assert.equal(snap.modelSetup.hasKey, true, "keep 之后 hasKey 仍为 true");
    assert.equal(snap.modelSetup.label, "本地回环-v2");

    // 服务器期望更新到编辑后的新 ID——下一条请求必须带新 ID 才被服务端接受（200）
    // 真实成功路径：新 modelId + 原 key → 正常 streaming 完成 → 完整 marker 与 ready/pending0。
    // 不把 401 当成功验收，也不靠宽正则匹配。
    server.setExpectedModel(NEW_MODEL_ID);
    await handle.page.keyboard.press("Escape");
    const composer2 = handle.page.getByPlaceholder(/交代需求|Describe|追问|Follow/i).first();
    await composer2.waitFor({ timeout: 10_000 });
    await composer2.fill("二次");
    await composer2.press("Enter");
    const batch = await server.awaitCount(2);
    assert.equal(batch[1].parsedModel, NEW_MODEL_ID, "下一条 HTTP 请求 body.model 必须是编辑后的新 modelId");
    assert.equal(batch[1].authExact, true, "编辑 keep 之后原 key 仍被服务端精确接受");
    assert.equal(batch[1].modelExact, true, "编辑后期望新 ID，服务端 200 响应（不为 401）");
    const newMarker = batch[1].marker;
    assert.notEqual(newMarker, firstMarker, "两次请求必须独立 marker");
    // 完整新正文+自然终态；上一轮 keep 后不应遗留 auth-failed 历史错误
    await waitForSnapshot(
      handle.page,
      (s, markerText) => {
        if (!s) return false;
        const runs = Object.values(s.runs ?? {});
        if (!runs.every((r) => r.status === "ready" && r.pendingInputs === 0)) return false;
        return Object.values(s.timelines ?? {}).some((blocks) =>
          (blocks ?? []).some((b) => b.kind === "message" && b.role === "assistant" && typeof b.text === "string" && b.text.includes(markerText)),
        );
      },
      newMarker,
      "编辑 keep 后应以新 modelId 自然完成且 UI 看到完整新正文",
    );
  } finally {
    await killApp(handle);
    await server.close();
    cleanup(stateDir);
  }
});

test("跨 origin keep 必须拒绝，第二 loopback 看不到旧 key；明确新 key 才可保存", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "dcode-msetup-origin-"));
  const serverA = await startProtocolServer();
  const keyB = `sk-other-${randomBytes(16).toString("hex")}`;
  const serverB = await startProtocolServer({ expectedKey: keyB, expectedModel: EXPECTED_MODEL_ID });
  const handle = await launchApp(stateDir, { DCODE_VALIDATION_ASSEMBLY: "", DCODE_VALIDATION_SAMPLE: "0" });
  try {
    await ready(handle.page);
    await sidebarSettingsButton(handle.page).click();
    await settingsSideBar(handle.page).getByRole("button", { name: /模型|Model/ }).click();
    // 保存 A + keyA
    // 双 tab 默认 preset；旧断言基于 openai-completions——必须先切 custom tab
    await handle.page.getByRole("radio", { name: /^自定义$|^Custom$/ }).click();
    await handle.page.getByRole("radio", { name: /OpenAI-compatible|OpenAI/i }).click();
    await handle.page.locator("input[placeholder*='服务商']").fill("ServerA");
    await handle.page.locator("input[placeholder*='gpt-4o-mini']").fill(EXPECTED_MODEL_ID);
    await handle.page.locator("input[placeholder*='api.openai.com']").fill(serverA.origin + "/v1");
    await handle.page.locator("input[type='password']").fill(expectedKey);
    await handle.page.getByRole("button", { name: /保存|Save/ }).click();
    await waitForSnapshot(handle.page, (s) => (s?.modelSetup?.kind === "custom" || s?.modelSetup?.kind === "preset-with-custom"));

    // 换 origin 到 serverB，但不改 keyAction（仍 keep）→ 保存必须拒绝
    await handle.page.locator("input[placeholder*='api.openai.com']").fill(serverB.origin + "/v1");
    await handle.page.getByRole("button", { name: /保存|Save/ }).click();
    // 等错误提示出现（issue=no-existing-key 是 keep 拒绝）
    await handle.page.getByText(/origin 变更需要新 key|需要新 key|尚未保存过凭据/).waitFor({ timeout: 10_000 });
    // 快照仍是 ServerA 配置
    const snapAfterKeep = await handle.page.evaluate(() => window.dcode.getSnapshot());
    assert.equal(snapAfterKeep.modelSetup.label, "ServerA");
    assert.equal(serverB.requests.length, 0, "第二 loopback 不能收到任何探测");
    assert.equal(serverA.requests.length, 0, "保存本身不发请求");

    // 改用 replace + keyB → 提交应成功
    await handle.page.getByRole("radio", { name: /更换|Replace/i }).click();
    await handle.page.locator("input[type='password']").fill(keyB);
    await handle.page.locator("input[placeholder*='服务商']").fill("ServerB");
    await handle.page.getByRole("button", { name: /保存|Save/ }).click();
    await waitForSnapshot(handle.page, (s) => (s?.modelSetup?.kind === "custom" || s?.modelSetup?.kind === "preset-with-custom") && s?.modelSetup?.label === "ServerB");
    // 发送一条：应该向 serverB 发并带 keyB
    await handle.page.keyboard.press("Escape");
    const composer = handle.page.getByPlaceholder(/交代需求|Describe/i).first();
    await composer.fill("给 B");
    await composer.press("Enter");
    const bBatch = await serverB.awaitCount(1);
    assert.equal(bBatch[0].authExact, true, "第二 loopback 收到 keyB 的精确 Authorization");
    assert.equal(serverA.requests.length, 0, "ServerA 不应收到后续请求");
  } finally {
    await killApp(handle);
    await serverA.close();
    await serverB.close();
    cleanup(stateDir);
  }
});

test("接收侧拒绝：非 loopback HTTP、userinfo、查询/片段", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "dcode-msetup-recv-"));
  const handle = await launchApp(stateDir, { DCODE_VALIDATION_ASSEMBLY: "", DCODE_VALIDATION_SAMPLE: "0" });
  try {
    await ready(handle.page);
    // 直接走 IPC（接收侧校验），得到拒绝信息
    const rejects = await handle.page.evaluate(async () => {
      const cases = [
        { provider: "openai-completions", label: "Remote-HTTP", modelId: "m", baseUrl: "http://example.com/v1", keyAction: "replace", apiKey: "k" },
        { provider: "openai-completions", label: "With-Userinfo", modelId: "m", baseUrl: "https://user:pass@example.com/v1", keyAction: "replace", apiKey: "k" },
        { provider: "openai-completions", label: "With-Query", modelId: "m", baseUrl: "https://example.com/v1?key=abc", keyAction: "replace", apiKey: "k" },
        { provider: "openai-completions", label: "With-Fragment", modelId: "m", baseUrl: "https://example.com/v1#frag", keyAction: "replace", apiKey: "k" },
        { provider: "openai-completions", label: "Wrong-Scheme", modelId: "m", baseUrl: "file:///etc/passwd", keyAction: "replace", apiKey: "k" },
      ];
      const out = [];
      for (const c of cases) {
        try {
          const r = await window.dcode.configureModel(c);
          out.push({ label: c.label, rejected: false, issue: r?.issue ?? null });
        } catch (e) {
          out.push({ label: c.label, rejected: true, message: String(e?.message ?? e) });
        }
      }
      return out;
    });
    for (const r of rejects) {
      assert.equal(r.rejected, true, `${r.label} 必须被接收侧拒绝`);
    }
  } finally {
    await killApp(handle);
    cleanup(stateDir);
  }
});

test("A→失败B再发A：注入写盘失败后仍可用 A 配置请求成功", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "dcode-msetup-ab-"));
  const server = await startProtocolServer();
  const handle = await launchApp(stateDir, { DCODE_VALIDATION_ASSEMBLY: "", DCODE_VALIDATION_SAMPLE: "0" });
  try {
    await ready(handle.page);
    await sidebarSettingsButton(handle.page).click();
    await settingsSideBar(handle.page).getByRole("button", { name: /模型|Model/ }).click();
    // 保存 A 成功
    // 双 tab 默认 preset；旧断言基于 openai-completions——必须先切 custom tab
    await handle.page.getByRole("radio", { name: /^自定义$|^Custom$/ }).click();
    await handle.page.getByRole("radio", { name: /OpenAI-compatible|OpenAI/i }).click();
    await handle.page.locator("input[placeholder*='服务商']").fill("ServerA");
    await handle.page.locator("input[placeholder*='gpt-4o-mini']").fill(EXPECTED_MODEL_ID);
    await handle.page.locator("input[placeholder*='api.openai.com']").fill(server.origin + "/v1");
    await handle.page.locator("input[type='password']").fill(expectedKey);
    await handle.page.getByRole("button", { name: /保存|Save/ }).click();
    await waitForSnapshot(handle.page, (s) => (s?.modelSetup?.kind === "custom" || s?.modelSetup?.kind === "preset-with-custom") && s?.modelSetup?.label === "ServerA");

    // 让 A 请求一次，确认可用 + 完整 marker 到达 + run 自然收束
    await handle.page.keyboard.press("Escape");
    const composer1 = handle.page.getByPlaceholder(/交代需求|Describe/i).first();
    await composer1.fill("A-1");
    await composer1.press("Enter");
    const firstBatch = await server.awaitCount(1);
    const firstMarker = firstBatch[0].marker;
    assert.ok(firstMarker && firstMarker.length > 0);
    await waitForSnapshot(
      handle.page,
      (s, markerText) => {
        if (!s) return false;
        const runs = Object.values(s.runs ?? {});
        if (!runs.every((r) => r.status === "ready" && r.pendingInputs === 0)) return false;
        return Object.values(s.timelines ?? {}).some((blocks) =>
          (blocks ?? []).some((b) => b.kind === "message" && b.role === "assistant" && typeof b.text === "string" && b.text.includes(markerText)),
        );
      },
      firstMarker,
      "A 首发应自然完成且 UI 看到完整 marker",
    );

    // 让 provider-directory.json 目录变成只读 → B 写盘必失败（rename/commitWithCredential 会 throw）
    const { chmodSync } = await import("node:fs");
    chmodSync(stateDir, 0o500);

    // 尝试保存 B（任意字段失败都不会破坏 A）
    await sidebarSettingsButton(handle.page).click();
    await settingsSideBar(handle.page).getByRole("button", { name: /模型|Model/ }).click();
    await handle.page.locator("input[placeholder*='服务商']").fill("ServerB");
    await handle.page.getByRole("radio", { name: /更换|Replace/i }).click();
    await handle.page.locator("input[type='password']").fill("sk-b-never-persist");
    await handle.page.getByRole("button", { name: /保存|Save/ }).click();
    // 严格辨认 storage 类失败：EACCES/EPERM 是实际写入类错误码，不能用「失败」二字遮 busy/run-in-flight 假通过。
    await handle.page.getByText(/EACCES|EPERM|credential-encryption-unavailable|model-setup-record-corrupt/i).waitFor({ timeout: 15_000 });
    // 反向断言：不能误为「busy / run-in-flight / 保存上一个」
    const errVisible = await handle.page.evaluate(() => document.body.innerText);
    assert.ok(!errVisible.includes("仍在保存上一个模型配置"), "storage 失败不得被误为 modelSetupFlight busy");
    assert.ok(!errVisible.includes("正在执行或正要暂停"), "storage 失败不得被误为 hasActiveWork busy");

    // 恢复写权限
    chmodSync(stateDir, 0o700);

    // 快照仍是 A 配置且 hasKey 仍为 true（A 凭据未被破坏）
    const snap = await handle.page.evaluate(() => window.dcode.getSnapshot());
    assert.equal(snap.modelSetup.label, "ServerA");
    assert.equal(snap.modelSetup.hasKey, true);
    assert.equal(snap.modelSetup.modelId, EXPECTED_MODEL_ID);
    // 真实发送 A 第二条：服务器收到新请求 + 完整 marker + 自然完成
    await handle.page.keyboard.press("Escape");
    const composer2 = handle.page.getByPlaceholder(/交代需求|Describe|追问|Follow/i).first();
    await composer2.fill("A-2");
    await composer2.press("Enter");
    const batch = await server.awaitCount(2);
    assert.equal(batch[1].authExact, true, "失败 B 后 A 仍可用原 key 请求");
    assert.equal(batch[1].modelExact, true);
    const secondMarker = batch[1].marker;
    assert.notEqual(secondMarker, firstMarker, "第二次请求必须有独立 marker");
    // 等 A 第二条完整新正文 + run 自然收束：不能用上一次的 marker 或 ready 假通过
    await waitForSnapshot(
      handle.page,
      (s, markerText) => {
        if (!s) return false;
        const runs = Object.values(s.runs ?? {});
        if (!runs.every((r) => r.status === "ready" && r.pendingInputs === 0)) return false;
        return Object.values(s.timelines ?? {}).some((blocks) =>
          (blocks ?? []).some((b) => b.kind === "message" && b.role === "assistant" && typeof b.text === "string" && b.text.includes(markerText)),
        );
      },
      secondMarker,
      "失败 B 后 A 的第二请求必须看到完整新正文并自然完成",
    );
  } finally {
    await killApp(handle);
    await server.close();
    // chmod 回 0o700 再删，确保 cleanup 不失败
    try { (await import("node:fs")).chmodSync(stateDir, 0o700); } catch { /* noop */ }
    cleanup(stateDir);
  }
});

test("清除凭据后恢复缺模型不可发送；不落明文、不发网络探针；界面与快照不含已清 key", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "dcode-msetup-clear-"));
  const server = await startProtocolServer();
  const handle = await launchApp(stateDir, { DCODE_VALIDATION_ASSEMBLY: "", DCODE_VALIDATION_SAMPLE: "0" });
  try {
    await ready(handle.page);
    // 保存 A + keyA
    await sidebarSettingsButton(handle.page).click();
    await settingsSideBar(handle.page).getByRole("button", { name: /模型|Model/ }).click();
    // 双 tab 默认 preset；旧断言基于 openai-completions——必须先切 custom tab
    await handle.page.getByRole("radio", { name: /^自定义$|^Custom$/ }).click();
    await handle.page.getByRole("radio", { name: /OpenAI-compatible|OpenAI/i }).click();
    await handle.page.locator("input[placeholder*='服务商']").fill("ClearTest");
    await handle.page.locator("input[placeholder*='gpt-4o-mini']").fill(EXPECTED_MODEL_ID);
    await handle.page.locator("input[placeholder*='api.openai.com']").fill(server.origin + "/v1");
    await handle.page.locator("input[type='password']").fill(expectedKey);
    await handle.page.getByRole("button", { name: /保存|Save/ }).click();
    await waitForSnapshot(handle.page, (s) => (s?.modelSetup?.kind === "custom" || s?.modelSetup?.kind === "preset-with-custom") && s?.model?.available === true);

    // 选择「清除」保存 → hasKey=false，model 应回到「不可用」状态
    await handle.page.getByRole("radio", { name: /清除|Clear/i }).click();
    await handle.page.getByRole("button", { name: /保存|Save/ }).click();
    await waitForSnapshot(
      handle.page,
      (s) => (s?.modelSetup?.kind === "custom" || s?.modelSetup?.kind === "preset-with-custom") && s?.modelSetup?.hasKey === false && s?.model?.available === false,
      null,
      "清除凭据后 model 应恢复 不可用",
    );
    // 保存本身不发请求（清除也是同样规则：无网络探测）
    assert.equal(server.requests.length, 0, "保存（含清除）不发网络探测");
    // 落盘不含明文 key（已被清），但保留非秘密元数据（format 2：customDefinition + credentials map）
    const secretRaw = readFileSync(join(stateDir, "provider-directory.json"), "utf8");
    assert.ok(!secretRaw.includes(expectedKey), "清除后 provider-directory.json 不得保留原 key");
    const parsed = JSON.parse(secretRaw);
    assert.equal(parsed.customDefinition?.label, "ClearTest", "清除后连接元数据仍保留（供编辑回显）");
    assert.ok(!parsed.credentials?.["user-defined"], "清除后 user-defined 凭据字段必须缺席");
    // UI / 快照 不含 key 片段
    const snap = await handle.page.evaluate(() => window.dcode.getSnapshot());
    assert.ok(!JSON.stringify(snap).includes(expectedKey));
    const uiText = await handle.page.evaluate(() => document.body.innerText);
    assert.ok(!uiText.includes(expectedKey));

    // 直接 IPC 尝试发送也必须被 execution-unavailable 拒（凭据 path 不绕过 UI 的保存钮禁用）
    const rejected = await handle.page.evaluate(async () => {
      try {
        await window.dcode.sendMessage({ taskId: "task-home-default", text: "after-clear", mode: "steer" });
        return { sent: true };
      } catch (err) {
        return { sent: false, message: String(err?.message ?? err) };
      }
    });
    assert.equal(rejected.sent, false, "清除凭据后直接 IPC 发送必须拒绝");
    assert.match(rejected.message, /execution-unavailable/);
    assert.equal(server.requests.length, 0, "清除凭据后无网络请求发生");

    // 真实重开：credential 缺席 → assembly 不再构造 backend；执行真实 unavailable，
    // 但配置安全元数据仍可编辑（label/modelId/baseUrl 完整回显）
    await handle.close();
    const handle2 = await launchApp(stateDir, { DCODE_VALIDATION_ASSEMBLY: "", DCODE_VALIDATION_SAMPLE: "0" });
    try {
      await ready(handle2.page);
      const snap2 = await handle2.page.evaluate(() => window.dcode.getSnapshot());
      assert.equal(snap2.model.available, false, "重开后 model 仍不可用（credential 缺席）");
      assert.equal(snap2.modelSetup.kind, "custom");
      assert.equal(snap2.modelSetup.hasKey, false);
      assert.equal(snap2.modelSetup.label, "ClearTest", "重开后服务商 label 仍可编辑回显");
      assert.equal(snap2.modelSetup.modelId, EXPECTED_MODEL_ID);
      assert.equal(snap2.modelSetup.baseUrl, server.origin + "/v1");
      assert.equal(snap2.execution.kind, "unavailable", "无凭据时 execution.kind 应真实 unavailable");

      // 重新提供 key：UI 编辑 + replace 保存 → 真实还原为可用 + 完整新正文已接收
      await sidebarSettingsButton(handle2.page).click();
      await settingsSideBar(handle2.page).getByRole("button", { name: /模型|Model/ }).click();
      await handle2.page.getByRole("radio", { name: /更换|Replace/i }).click();
      await handle2.page.locator("input[type='password']").fill(expectedKey);
      await handle2.page.getByRole("button", { name: /保存|Save/ }).click();
      await waitForSnapshot(handle2.page, (s) => (s?.modelSetup?.kind === "custom" || s?.modelSetup?.kind === "preset-with-custom") && s?.model?.available === true, null, "重新 replace 后 model 应恢复可用");
      await handle2.page.keyboard.press("Escape");
      const composer2 = handle2.page.getByPlaceholder(/交代需求|Describe/i).first();
      await composer2.fill("restored");
      await composer2.press("Enter");
      const batch = await server.awaitCount(1);
      assert.equal(batch[0].authExact, true);
      assert.equal(batch[0].modelExact, true);
      const marker = batch[0].marker;
      await waitForSnapshot(
        handle2.page,
        (s, m) => {
          if (!s) return false;
          const runs = Object.values(s.runs ?? {});
          if (!runs.every((r) => r.status === "ready" && r.pendingInputs === 0)) return false;
          return Object.values(s.timelines ?? {}).some((blocks) =>
            (blocks ?? []).some((b) => b.kind === "message" && b.role === "assistant" && typeof b.text === "string" && b.text.includes(m)),
          );
        },
        marker,
        "重新提供 key 后 UI 应看到完整新正文并自然完成",
      );
    } finally {
      await handle2.close();
    }
  } finally {
    await killApp(handle);
    await server.close();
    cleanup(stateDir);
  }
});

test("服务端 401/500 真实回显 key:UI/快照/诊断/运行记录(vault之外)均不含该 key，UI 显示有限安全码", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "dcode-msetup-echokey-"));
  const echoKey = `sk-echo-${randomBytes(16).toString("hex")}`;
  // 自建 loopback 服务，故意把 key 回显进 error.message——这是真实服务可能的不当响应，
  // 不能因为服务无礼就让凭据从 UI/快照/日志/落盘运行记录（jsonl）中渗出
  const echoServerRequests = [];
  const echoServer = await new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(String(c)));
      req.on("end", () => {
        if (req.method === "POST" && (req.url ?? "").includes("/chat")) {
          const auth = req.headers["authorization"] ?? "";
          echoServerRequests.push({ auth });
          // 服务端把 bearer 原文回显到错误响应（真实不当服务的形状）
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: `401 Unauthorized: token='${auth.replace(/^Bearer /, "")}' reason=key-lookup-failed` } }));
          return;
        }
        res.writeHead(404);
        res.end("{}");
      });
    });
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      resolve({
        origin: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`,
        requests: echoServerRequests,
        close: () => new Promise((r) => srv.close(() => r(undefined))),
      });
    });
  });
  const handle = await launchApp(stateDir, { DCODE_VALIDATION_ASSEMBLY: "", DCODE_VALIDATION_SAMPLE: "0" });
  try {
    await ready(handle.page);
    await sidebarSettingsButton(handle.page).click();
    await settingsSideBar(handle.page).getByRole("button", { name: /模型|Model/ }).click();
    // 双 tab 默认 preset；旧断言基于 openai-completions——必须先切 custom tab
    await handle.page.getByRole("radio", { name: /^自定义$|^Custom$/ }).click();
    await handle.page.getByRole("radio", { name: /OpenAI-compatible|OpenAI/i }).click();
    await handle.page.locator("input[placeholder*='服务商']").fill("EchoKey");
    await handle.page.locator("input[placeholder*='gpt-4o-mini']").fill(EXPECTED_MODEL_ID);
    await handle.page.locator("input[placeholder*='api.openai.com']").fill(`${echoServer.origin}/v1`);
    await handle.page.locator("input[type='password']").fill(echoKey);
    await handle.page.getByRole("button", { name: /保存|Save/ }).click();
    await waitForSnapshot(handle.page, (s) => (s?.modelSetup?.kind === "custom" || s?.modelSetup?.kind === "preset-with-custom"));

    // 真实发送 → 服务器 401 且把 key 原文回显在 error.message
    await handle.page.keyboard.press("Escape");
    const composer = handle.page.getByPlaceholder(/交代需求|Describe/i).first();
    await composer.fill("trigger 401-echo");
    await composer.press("Enter");
    // 等 UI 显示有限安全失败码；服务器确实收到一条带 echoKey 的真实 HTTP 请求
    await waitForSnapshot(
      handle.page,
      (s) => Object.values(s.runs ?? {}).some((r) => r.errorNote === "auth-failed" || r.errorNote === "model-request-failed"),
      null,
      "服务端 401 必须反映到 run.errorNote（有限安全码，不透出原文）",
    );
    assert.equal(echoServerRequests.length, 1, "服务端真实收到一条请求");
    assert.ok(echoServerRequests[0].auth === `Bearer ${echoKey}`, "服务端收到的 Authorization 必须是 echoKey（证明 HTTP 真实到达）");

    // 检查三类不渗出通道（不打印 key 的任何片段到测试 stdout）
    const snap = await handle.page.evaluate(() => window.dcode.getSnapshot());
    const uiText = await handle.page.evaluate(() => document.body.innerText);
    // 走查 test-runner stderr 捕获：main 子进程的 stderr（diagnose 含 name/code/frames，不含 message 原文）
    // 直接读取运行记录 jsonl：stateDir/runtime/<sessionId>/ 下的 pi.assistant 持久化
    const { readdirSync, readFileSync: readSync, existsSync: ex } = await import("node:fs");
    const runtimeRoot = join(stateDir, "runtime");
    const collectJsonl = (dir) => {
      const out = [];
      if (!ex(dir)) return out;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...collectJsonl(p));
        else if (entry.name.endsWith(".jsonl") || entry.name.endsWith(".json") || entry.name.endsWith(".log")) out.push(p);
      }
      return out;
    };
    const artifactFiles = ex(runtimeRoot) ? collectJsonl(runtimeRoot) : [];
    const leakedLocations = [];
    if (uiText.includes(echoKey)) leakedLocations.push("ui-text");
    if (JSON.stringify(snap).includes(echoKey)) leakedLocations.push("snapshot");
    for (const f of artifactFiles) {
      const raw = readSync(f, "utf8");
      if (raw.includes(echoKey)) leakedLocations.push(`jsonl:${f.replace(stateDir, "<stateDir>")}`);
    }
    assert.deepEqual(leakedLocations, [], `key 渗出到 ${JSON.stringify(leakedLocations)}（不再重复打印 key）`);
    // 关键反例：sanitizer 必须真实生效——jsonl 里真实持久化了一条带 stopReason=error 的 assistant entry
    const jsonlCombined = artifactFiles.map((f) => readSync(f, "utf8")).join("\n");
    assert.ok(
      jsonlCombined.includes('"stopReason":"error"') || jsonlCombined.includes('"stopReason": "error"'),
      "jsonl 应该持久化 stopReason=error 的 assistant entry（SDK 真实持久事件，非空头承诺）",
    );
    // 有限安全码已在 UI 可见（errorNote 拉满 + 不反射原文）
    const errKinds = Object.values(snap.runs ?? {}).map((r) => r.errorNote).filter(Boolean);
    assert.ok(errKinds.length > 0);
    for (const k of errKinds) {
      assert.ok(k === "model-request-failed" || k === "auth-failed", `errorNote 必须是有限安全码，实测 ${k}`);
    }
  } finally {
    await killApp(handle);
    await echoServer.close();
    cleanup(stateDir);
  }
});

test("短凭据（≤3字符）同样被保护：服务端回显短 key 不渗出 UI/快照/落盘", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "dcode-msetup-shortkey-"));
  // 服务端把短 key 也明确 echo 到 error.message
  const shortKey = "ab";
  const shortServerRequests = [];
  const shortServer = await new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(String(c)));
      req.on("end", () => {
        if (req.method === "POST" && (req.url ?? "").includes("/chat")) {
          const auth = req.headers["authorization"] ?? "";
          shortServerRequests.push({ auth });
          res.writeHead(401, { "content-type": "application/json" });
          // 明确含短 key 原文
          res.end(JSON.stringify({ error: { message: `401 Unauthorized: bad-key shape='${auth}'` } }));
          return;
        }
        res.writeHead(404);
        res.end("{}");
      });
    });
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      resolve({
        origin: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`,
        requests: shortServerRequests,
        close: () => new Promise((r) => srv.close(() => r(undefined))),
      });
    });
  });
  const handle = await launchApp(stateDir, { DCODE_VALIDATION_ASSEMBLY: "", DCODE_VALIDATION_SAMPLE: "0" });
  try {
    await ready(handle.page);
    await sidebarSettingsButton(handle.page).click();
    await settingsSideBar(handle.page).getByRole("button", { name: /模型|Model/ }).click();
    // 双 tab 默认 preset；旧断言基于 openai-completions——必须先切 custom tab
    await handle.page.getByRole("radio", { name: /^自定义$|^Custom$/ }).click();
    await handle.page.getByRole("radio", { name: /OpenAI-compatible|OpenAI/i }).click();
    await handle.page.locator("input[placeholder*='服务商']").fill("ShortKey");
    await handle.page.locator("input[placeholder*='gpt-4o-mini']").fill(EXPECTED_MODEL_ID);
    await handle.page.locator("input[placeholder*='api.openai.com']").fill(`${shortServer.origin}/v1`);
    await handle.page.locator("input[type='password']").fill(shortKey);
    await handle.page.getByRole("button", { name: /保存|Save/ }).click();
    await waitForSnapshot(handle.page, (s) => (s?.modelSetup?.kind === "custom" || s?.modelSetup?.kind === "preset-with-custom"));

    await handle.page.keyboard.press("Escape");
    const composer = handle.page.getByPlaceholder(/交代需求|Describe/i).first();
    await composer.fill("trigger shortkey 401");
    await composer.press("Enter");
    await waitForSnapshot(
      handle.page,
      (s) => Object.values(s.runs ?? {}).some((r) => r.errorNote === "auth-failed" || r.errorNote === "model-request-failed"),
      null,
      "短 key 的 401 必须反映到 run.errorNote",
    );
    // 服务端必须真实收到 Authorization: Bearer ab
    assert.equal(shortServerRequests.length, 1);
    assert.equal(shortServerRequests[0].auth, `Bearer ${shortKey}`);
    // 快照/UI 不含 'Bearer ab'（服务端回显形状）；短 key 本身长度过短，只用完整 'Bearer ab' 形状判定渗出
    const snap = await handle.page.evaluate(() => window.dcode.getSnapshot());
    const uiText = await handle.page.evaluate(() => document.body.innerText);
    assert.ok(!uiText.includes(`Bearer ${shortKey}`), "UI 不得含服务端回显短 key 形状");
    assert.ok(!JSON.stringify(snap).includes(`Bearer ${shortKey}`), "快照不得含服务端回显短 key 形状");
    // runtime/ 下的 jsonl 也不得含完整 'Bearer ab' 形状
    const { readdirSync, readFileSync: readSync, existsSync: ex } = await import("node:fs");
    const runtimeRoot = join(stateDir, "runtime");
    const collectJsonl = (dir) => {
      const out = [];
      if (!ex(dir)) return out;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...collectJsonl(p));
        else if (entry.name.endsWith(".jsonl") || entry.name.endsWith(".json") || entry.name.endsWith(".log")) out.push(p);
      }
      return out;
    };
    const artifactFiles = ex(runtimeRoot) ? collectJsonl(runtimeRoot) : [];
    for (const f of artifactFiles) {
      const raw = readSync(f, "utf8");
      assert.ok(!raw.includes(`Bearer ${shortKey}`), `运行记录 ${f} 不得含服务端回显短 key 形状`);
    }
  } finally {
    await killApp(handle);
    await shortServer.close();
    cleanup(stateDir);
  }
});

test("连接拒绝（ECONNREFUSED）：UI/快照/落盘不含服务原文与 key 片段；run 显示有限安全码", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "dcode-msetup-connrefused-"));
  // 用独立随机 key 但 loopback 服务未监听 → 连接拒绝
  const connKey = `sk-conn-${randomBytes(16).toString("hex")}`;
  const unusedOrigin = `http://127.0.0.1:1`; // 端口 1 不可绑定
  const handle = await launchApp(stateDir, { DCODE_VALIDATION_ASSEMBLY: "", DCODE_VALIDATION_SAMPLE: "0" });
  try {
    await ready(handle.page);
    await sidebarSettingsButton(handle.page).click();
    await settingsSideBar(handle.page).getByRole("button", { name: /模型|Model/ }).click();
    // 双 tab 默认 preset；旧断言基于 openai-completions——必须先切 custom tab
    await handle.page.getByRole("radio", { name: /^自定义$|^Custom$/ }).click();
    await handle.page.getByRole("radio", { name: /OpenAI-compatible|OpenAI/i }).click();
    await handle.page.locator("input[placeholder*='服务商']").fill("ConnRefused");
    await handle.page.locator("input[placeholder*='gpt-4o-mini']").fill(EXPECTED_MODEL_ID);
    await handle.page.locator("input[placeholder*='api.openai.com']").fill(`${unusedOrigin}/v1`);
    await handle.page.locator("input[type='password']").fill(connKey);
    await handle.page.getByRole("button", { name: /保存|Save/ }).click();
    await waitForSnapshot(handle.page, (s) => (s?.modelSetup?.kind === "custom" || s?.modelSetup?.kind === "preset-with-custom"));
    await handle.page.keyboard.press("Escape");
    const composer = handle.page.getByPlaceholder(/交代需求|Describe/i).first();
    await composer.fill("trigger connrefused");
    await composer.press("Enter");
    await waitForSnapshot(
      handle.page,
      (s) => Object.values(s.runs ?? {}).some((r) => r.errorNote === "model-request-failed" || r.errorNote === "auth-failed"),
      null,
      "连接拒绝必须反映到 run.errorNote（有限安全码）",
    );
    const snap = await handle.page.evaluate(() => window.dcode.getSnapshot());
    const uiText = await handle.page.evaluate(() => document.body.innerText);
    assert.ok(!uiText.includes(connKey), "UI 不得含连接 key");
    assert.ok(!JSON.stringify(snap).includes(connKey), "快照不得含连接 key");
    const secretRaw = readFileSync(join(stateDir, "provider-directory.json"), "utf8");
    assert.ok(!secretRaw.includes(connKey), "加密落盘不得含 key 明文");
    // 有限安全码已在 UI 可见；连接错误归类为 model-request-failed（不是 auth-failed）
    const errKinds = Object.values(snap.runs ?? {}).map((r) => r.errorNote).filter(Boolean);
    assert.ok(errKinds.length > 0);
    for (const k of errKinds) {
      assert.ok(k === "model-request-failed" || k === "auth-failed", `errorNote 必须是有限安全码，实测 ${k}`);
    }
  } finally {
    await killApp(handle);
    cleanup(stateDir);
  }
});

test("ModelSetupCard 在 720 窄窗 13/14 字号（其一为暗色）字段标签可读+输入不出容器+可滚到保存", async () => {
  // 初始化整段都放进 try：早先把建目录／启动应用放在 try 之外，一次早期失败就会留下
  // 已开的回环服务器与数据目录——服务端保持事件循环，整批用例会停在那里不再输出。
  const stateDir = mkdtempSync(join(tmpdir(), "dcode-msetup-720-"));
  let server = null;
  let handle = null;
  const screenshots = [];
  try {
    server = await startProtocolServer();
    const shots720 = evidenceDir("model-setup", "720");
    handle = await launchApp(stateDir, { DCODE_VALIDATION_ASSEMBLY: "", DCODE_VALIDATION_SAMPLE: "0" });
    await ready(handle.page);
    await sidebarSettingsButton(handle.page).click();
    await settingsSideBar(handle.page).getByRole("button", { name: /模型|Model/ }).click();
    // 新版预设/自定义双 tab 默认 preset：先切到可写 key 的 custom 面板
    await handle.page.getByRole("radio", { name: /^自定义$|^Custom$/ }).click();
    await handle.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(720, 600));
    await handle.page.waitForFunction(() => window.innerWidth === 720 && window.innerHeight === 600, null, { timeout: 5_000 });

    // 至少一张暗色：遍历 (theme × fontSize) 共 4 种组合，确保含暗色
    const cases = [
      { theme: "light", fontSize: 13 },
      { theme: "light", fontSize: 14 },
      { theme: "dark", fontSize: 13 },
      { theme: "dark", fontSize: 14 },
    ];

    for (const { theme, fontSize } of cases) {
      // 经 IPC 同时切换主题与字号（同一次 updateSettings 才是单提交）
      await handle.page.evaluate(async ({ theme: t2, fontSize: fs }) => {
        await window.dcode.updateSettings({ theme: t2, fontSize: fs });
        await new Promise((r) => setTimeout(r, 120));
      }, { theme, fontSize });

      // 填一次完整真实表单（一次性假 key 即可；password 保持 type=password 遮蔽）
      const labelField = handle.page.locator("input[placeholder*='服务商']");
      const modelField = handle.page.locator("input[placeholder*='gpt-4o-mini']");
      const urlField = handle.page.locator("input[placeholder*='api.openai.com']");
      await handle.page.getByRole("radio", { name: /更换|Replace/i }).click();
      const pw = handle.page.locator("input[type='password']").first();
      await labelField.fill("窄窗验证服务");
      await modelField.fill(EXPECTED_MODEL_ID);
      await urlField.fill(server.origin + "/v1");
      await pw.fill(expectedKey);

      // 1) 输入字段 bbox：可见 + 宽足以可读 + 不出容器
      for (const f of [labelField, modelField, urlField, pw]) {
        const box = await f.boundingBox();
        assert.ok(box, `theme=${theme}/fs=${fontSize} 输入应可见`);
        assert.ok(box.width > 200, `theme=${theme}/fs=${fontSize} 输入宽度应足以显示完整常见值（实测 ${box.width}px）`);
        assert.ok(box.x >= 0 && box.x + box.width <= 720 + 1, `theme=${theme}/fs=${fontSize} 输入不得被裁剪出窗`);
      }

      // 2) 字段对应 label 文本元素的 bbox：
      //    (a) 都不为 0 宽
      //    (b) 与紧随其后的输入不相交（防 label 与 input 重叠）
      const labelTexts = [
        { label: () => handle.page.getByText("显示名", { exact: true }).first(), input: labelField },
        { label: () => handle.page.getByText("模型 ID", { exact: true }).first(), input: modelField },
        { label: () => handle.page.getByText("Base URL", { exact: true }).first(), input: urlField },
        { label: () => handle.page.getByText("API 密钥", { exact: true }).first(), input: pw },
      ];
      for (const { label, input } of labelTexts) {
        const lbox = await label().boundingBox();
        assert.ok(lbox, `theme=${theme}/fs=${fontSize} label 必须可见`);
        assert.ok(lbox.width > 10, `theme=${theme}/fs=${fontSize} label 不得被挤到 0 宽（实测 ${lbox.width}px）`);
        assert.ok(lbox.height > 8, `theme=${theme}/fs=${fontSize} label 高度可读（实测 ${lbox.height}px）`);
        const ibox = await input.boundingBox();
        // 不相交：label 完全在 input 上方（纵向布局要求）
        assert.ok(lbox.y + lbox.height <= ibox.y + 2, `theme=${theme}/fs=${fontSize} label 与输入必须保持纵向不相交`);
      }

      // 3) 保存按钮可滚到并可见
      // 先记录侧栏品牌/底部"设置"按钮位置作为锚点（侧栏应该不被右侧表单长内容挤出视口）
      const brandLoc = handle.page.locator(".app-brand");
      const brandBoxBefore = await brandLoc.boundingBox();
      assert.ok(brandBoxBefore, `theme=${theme}/fs=${fontSize} 侧栏品牌必须可见`);
      const settingsNavBtn = handle.page.locator("nav").getByRole("button", { name: /设置|Settings/ });
      const navBoxBefore = await settingsNavBtn.boundingBox();
      assert.ok(navBoxBefore, `theme=${theme}/fs=${fontSize} 侧栏"设置"按髂必须可见`);

      const saveBtn = handle.page.getByRole("button", { name: /保存|Save/ });
      await saveBtn.scrollIntoViewIfNeeded();
      const saveBox = await saveBtn.boundingBox();
      assert.ok(saveBox, `theme=${theme}/fs=${fontSize} 保存按钮必须可见`);
      assert.ok(saveBox.x + saveBox.width <= 720 + 1, `theme=${theme}/fs=${fontSize} 保存按钮不得被裁剪`);
      assert.ok(saveBox.y + saveBox.height <= 600 + 1, `theme=${theme}/fs=${fontSize} 保存按钮必须在视口内`);

      // 4) 滚动事实：窗口本身不滚（scrollY = 0），滚动应发生在右侧设置内容容器
      const scrollFacts = await handle.page.evaluate(() => {
        const doc = document.scrollingElement ?? document.documentElement;
        // 找右侧设置内容容器（带 overflow-y-auto 的 scroll container）
        const scrollers = Array.from(document.querySelectorAll("*")).filter((el) => {
          const style = getComputedStyle(el);
          return (style.overflowY === "auto" || style.overflowY === "scroll") && el.scrollHeight > el.clientHeight;
        });
        const active = scrollers.map((el) => ({
          tag: el.tagName.toLowerCase(),
          cls: (el.getAttribute("class") ?? "").slice(0, 80),
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
        }));
        return {
          winScrollY: window.scrollY,
          docScrollTop: doc.scrollTop,
          scrollers: active,
        };
      });
      assert.equal(scrollFacts.winScrollY, 0, `theme=${theme}/fs=${fontSize} 窗口本身不得滚动`);
      assert.equal(scrollFacts.docScrollTop, 0, `theme=${theme}/fs=${fontSize} document.scrollingElement 不得滚动`);
      // 至少一个滚动容器、且其 scrollTop 大于 0（证明滚动确实发生在右侧设置内容容器而非外层 body）
      assert.ok(scrollFacts.scrollers.length > 0, `theme=${theme}/fs=${fontSize} 必须存在至少一个滚动容器（设置右侧内容容器）`);
      const rightScroller = scrollFacts.scrollers.find((s) => s.scrollTop > 0);
      assert.ok(rightScroller, `theme=${theme}/fs=${fontSize} 应存在 scrollTop>0 的滚动容器（右侧设置内容容器）`);

      // 5) 侧栏位置保持：品牌/设置入口位置不因右侧滚动而跳变
      const brandBoxAfter = await brandLoc.boundingBox();
      const navBoxAfter = await settingsNavBtn.boundingBox();
      assert.deepEqual(
        { x: brandBoxAfter.x, y: brandBoxAfter.y, w: brandBoxAfter.width, h: brandBoxAfter.height },
        { x: brandBoxBefore.x, y: brandBoxBefore.y, w: brandBoxBefore.width, h: brandBoxBefore.height },
        `theme=${theme}/fs=${fontSize} 侧栏品牌位置不得随右侧滚动跳变`,
      );
      assert.deepEqual(
        { x: navBoxAfter.x, y: navBoxAfter.y, w: navBoxAfter.width, h: navBoxAfter.height },
        { x: navBoxBefore.x, y: navBoxBefore.y, w: navBoxBefore.width, h: navBoxBefore.height },
        `theme=${theme}/fs=${fontSize} 侧栏"设置"按髂位置不得随右侧滚动跳变`,
      );

      // 4) 截图：一次性假 key + password 遮蔽（type=password 自带 *** 渲染）+ 已填字段 + 可见标签 + 保存按钮
      const shotPath = join(shots720, `${theme}-fs${fontSize}.png`);
      await handle.page.screenshot({ path: shotPath, fullPage: false });
      screenshots.push(shotPath);
      const shotText = await handle.page.evaluate(() => document.body.innerText);
      assert.ok(!shotText.includes(expectedKey), `theme=${theme}/fs=${fontSize} 视口文本不得含一次性假 key`);
      console.log(`[screenshot] ${shotPath}`);
    }
    // 5) 输出全部截图绝对路径便于本地查看
    console.log("[evidence-720]", JSON.stringify(screenshots, null, 1));
  } finally {
    if (handle) await killApp(handle);
    if (server) await server.close();
    cleanup(stateDir);
  }
});
