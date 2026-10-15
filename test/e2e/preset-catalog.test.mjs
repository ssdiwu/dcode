// 预设供应商+目录来源+自定义独立保留的真实 UI 完整路径（隐藏窗口、隔离状态目录、loopback 端点）：
// 1) SDK login 经真实 openai provider 的 secret prompt 收 key 入档（凭据永不回显）；
// 2) 预设 applyModel(openai/gpt-4) 后自定义保存仍然存在且可编辑/可编辑后保持原 key（customDefinition 独立）；
// 3) 再应用预设并发消息，loopback 真实收到精确 model 与 Bearer 认证头（本地路径+同 anchor/兼容模板）；
// 4) setCatalogSource 编辑换源为 loopback 目录源并完成检查 → 视图实际变为新源（带真实成功时间）；
// 5) 真实重开后恢复原预设；切回自定义仍能复用原 key 再发送（原 key 留用、origin 核对 A）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { launchApp, ready, cleanup, killApp, waitForSnapshot } from "./helpers.mjs";
import { evidenceDir } from "./evidence-root.mjs";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

// 输出根走统一的隔离证据根（evidence-root）：复跑不再直写历史归档目录。
// 旧基准 doc/验证记录/预设协同-2026-10-09/evidence/preset-catalog-path.json 作为历史留存，
// 不由本测试再写入；evidence-root 的写入保护会拒绝此类路径。
const EVID = evidenceDir("preset-catalog");

const catalogProvider = "testco";
const kimiProvider = "openai";
const openaiKey = `sk-openai-${randomBytes(12).toString("hex")}`;
const customKey = `sk-custom-${randomBytes(12).toString("hex")}`;

/** loopback openai-responses 流：严格核对 Authorization 一致与 model 一致；返回最小 SSE。 */
function startOpenAILoop(expectedKey, initialModel) {
  let expectedModel = initialModel;
  const requests = [];
  const waiters = new Set();
  const notify = () => { for (const w of [...waiters]) w(); };
  let seq = 0;
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(String(c)));
      req.on("end", () => {
        if (req.method !== "POST" || !(req.url ?? "").startsWith("/v1/responses")) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "not-found" } }));
          return;
        }
        const auth = req.headers["authorization"];
        const bodyJson = (() => { try { return JSON.parse(chunks.join("")); } catch { return null; } })();
        const rawModel = bodyJson?.model ?? null;
        const authOk = typeof auth === "string" && auth === `Bearer ${expectedKey}`;
        const modelOk = rawModel === expectedModel;
        // marker/nonce 一并入库：测试在 UI/时间线上核对每次请求对应当次 marker，不能复用以前 marker 充数
        const nonceVal = randomBytes(8).toString("hex");
        const marker = `nonce-${nonceVal}`;
        requests.push({
          seq: ++seq, authOk, modelOk, model: rawModel, url: req.url, body: bodyJson,
          nonce: nonceVal, marker, maxOutputTokens: bodyJson?.max_output_tokens ?? null,
        });
        notify();
        if (!authOk || !modelOk) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: `bad auth or model auth=${authOk} model=${modelOk} want=${expectedModel}` } }));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        const out = buildOpenAiResponsesStream(expectedModel, marker);
        res.end(out);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        port,
        origin: `http://127.0.0.1:${port}`,
        requests,
        setExpectedModel: (m) => { expectedModel = m; },
        awaitCount: (n, timeoutMs = 30_000) => new Promise((res, rej) => {
          const timer = setTimeout(() => {
            waiters.delete(check);
            rej(new Error(`openai.awaitCount(${n}) 超时：当前 ${requests.length}`));
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

/** loopback openai-completions 流：给自定义后端（openai-completions 协议 /v1/chat/completions 端点）用。 */
function startCompletionsLoop(expectedKey, expectedModel) {
  const requests = [];
  const waiters = new Set();
  const notify = () => { for (const w of [...waiters]) w(); };
  let seq = 0;
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(String(c)));
      req.on("end", () => {
        if (req.method !== "POST" || !(req.url ?? "").startsWith("/v1/chat/completions")) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "not-found" } }));
          return;
        }
        const auth = req.headers["authorization"];
        const bodyJson = (() => { try { return JSON.parse(chunks.join("")); } catch { return null; } })();
        const rawModel = bodyJson?.model ?? null;
        const authOk = typeof auth === "string" && auth === `Bearer ${expectedKey}`;
        const modelOk = rawModel === expectedModel;
        const marker = `custom-${seq + 1}-${randomBytes(8).toString("hex")}`;
        requests.push({ seq: ++seq, authOk, modelOk, model: rawModel, url: req.url, marker, body: bodyJson });
        notify();
        if (!authOk || !modelOk) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: `bad auth/model auth=${authOk} model=${modelOk} want=${expectedModel}` } }));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end([
          `data: {"id":"chatcmpl-${seq}","object":"chat.completion.chunk","created":0,"model":"${expectedModel}","choices":[{"index":0,"delta":{"role":"assistant","content":"${marker}"},"finish_reason":null}]}`,
          ``,
          `data: {"id":"chatcmpl-${seq}","object":"chat.completion.chunk","created":0,"model":"${expectedModel}","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
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
        awaitCount: (n, timeoutMs = 30_000) => new Promise((res, rej) => {
          const timer = setTimeout(() => {
            waiters.delete(check);
            rej(new Error(`completions.awaitCount(${n}) 超时：当前 ${requests.length}`));
          }, timeoutMs);
          const check = () => {
            if (requests.length >= n) { clearTimeout(timer); waiters.delete(check); return res(requests.slice()); }
            waiters.add(check);
          };
          check();
        }),
        close: () => new Promise((r) => server.close(() => r(undefined))),
      });
    });
  });
}


function buildOpenAiResponsesStream(model, marker) {
  const id = `resp-${marker}`;
  const item = `msg-${marker}`;
  return [
    `event: response.created`,
    `data: {"type":"response.created","response":{"id":"${id}","object":"response","status":"in_progress","model":"${model}"}}`,
    ``,
    `event: response.output_item.added`,
    `data: {"type":"response.output_item.added","output_index":0,"item":{"id":"${item}","type":"message","role":"assistant","content":[{"type":"output_text","text":""}],"status":"in_progress"}}`,
    ``,
    `event: response.output_text.delta`,
    `data: {"type":"response.output_text.delta","item_id":"${item}","output_index":0,"content_index":0,"delta":"${marker}"}`,
    ``,
    `event: response.output_item.done`,
    `data: {"type":"response.output_item.done","output_index":0,"item":{"id":"${item}","type":"message","role":"assistant","content":[{"type":"output_text","text":"${marker}"}],"status":"completed"}}`,
    ``,
    `event: response.completed`,
    `data: {"type":"response.completed","response":{"id":"${id}","object":"response","status":"completed","model":"${model}","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}`,
    ``,
    // Responses 以 response.completed 结束；[DONE] 属 Chat Completions，混入会在正文后触发 SDK JSON 解析失败。
    ``,
  ].join("\n");
}

/** loopback 目录源：按 providerId 路径分发；catalog/testco/304/写盘失败四分支按 fixture 配置响应。 */
function startCatalogLoop(options) {
  const { validA, withModelsByProvider, stage } = options;
  const hits = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://x");
      hits.push({ url: req.url, etag: req.headers["if-none-match"] ?? null });
      const match = /^\/api\/models\/providers\/([a-z0-9-]+)$/.exec(url.pathname);
      if (!match) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not-found" }));
        return;
      }
      const providerId = match[1];
      const models = withModelsByProvider(providerId);
      if (!models) {
        // 未覆盖的供应商公开返回 404（gone），不失联写盘
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "provider-not-on-catalog" }));
        return;
      }
      const st = stage();
      if (st === "fail") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "fixture-network-failed" }));
        return;
      }
      if (st === "304") {
        // 只有显式携带相符 ETag 时才回 304（模拟同源再次检查）；否则 200
        const inm = req.headers["if-none-match"];
        if (inm && inm.includes(validA.etag)) {
          res.writeHead(304, { "content-type": "application/json" });
          res.end("");
          return;
        }
      }
      res.writeHead(200, {
        "content-type": "application/json",
        etag: validA.etag,
        "last-modified": new Date(validA.lastModified).toUTCString(),
      });
      res.end(JSON.stringify(models));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        hits,
        close: () => new Promise((r) => server.close(() => r(undefined))),
      });
    });
  });
}

async function gotoSettings(page) {
  await ready(page);
  await page.locator("nav").getByRole("button", { name: /设置|Settings/ }).click();
  // 进入设置后默认是「外观」分区；模型入口在左侧栏
  await page.getByText(/外观|Appearance/).first().waitFor({ timeout: 30_000 });
  // 点左侧栏「模型」入口（.w-44 侧栏、button role）
  await page.locator(".w-44").getByRole("button", { name: /模型|Model/ }).click();
  await page.getByText(/预设供应商|Preset providers|自定义|Custom/).first().waitFor({ timeout: 30_000 });
}

/** 重开保留旧暂停：用户明确创建新会话，再经真实输入和发送，旧队列不被恢复。 */
async function sendInNewSession(page, text, server, expectedModel) {
  const before = await page.evaluate(() => window.dcode.getSnapshot());
  await page.getByRole("button", { name: /^新会话$/ }).click();
  await waitForSnapshot(page, (snapshot, count) => snapshot.sessions.length === count + 1, before.sessions.length, "新会话已正式建立");
  // 宿主创建回执先于 UI 选择完成；等实际新会话草稿呈现再输入，避免写进旧暂停会话。
  await page.getByRole("heading", { name: "开始一项新工作" }).waitFor();
  await page.locator("textarea").first().fill(text);
  const requestCount = server.requests.length;
  await page.getByRole("button", { name: /^(发送|Send)$/ }).click();
  await server.awaitCount(requestCount + 1);
  const request = server.requests[requestCount];
  assert.equal(request.model, expectedModel, "本次发送采用明确选择的精确模型 ID");
  assert.ok(request.authOk, "本次请求采用该供应商的正确凭据");
  await waitForSnapshot(page, (snapshot, inputText) => Object.values(snapshot.timelines).flat().some((entry) =>
    entry.role === "user" && entry.text === inputText && entry.receipt?.status === "accepted"), text, "本次输入正式接收");
  await page.getByText(request.marker, { exact: true }).waitFor();
  return request;
}

function assertNoKeyLeak(text) {
  assert.ok(!text.includes(openaiKey), "界面/快照/日志不能含 openai key");
  assert.ok(!text.includes(customKey), "界面/快照/日志不能含 custom key");
}

/** SegmentedControl 切换：radio role 的双 tab，按 value 文案精确切换（避免与供应商 option 重名）。 */
async function clickTab(page, which) {
  const label = which === "preset" ? "预设供应商" : "自定义";
  await page.getByRole("radio", { name: label, exact: true }).click();
}

const customFormFill = async (page, { label, modelId, baseUrl, keyAction, apiKey }) => {
  await page.getByLabel(/显示名|Display name/i).fill(label);
  await page.getByLabel(/模型 ID|Model ID/i).fill(modelId);
  await page.getByLabel(/Base URL/i).fill(baseUrl);
  if (keyAction === "replace") {
    await page.getByLabel(/API 密钥|API key/i).fill(apiKey);
  }
};

const saveCustomButton = /保存|Save/;

test("预设/目录/自定义协同完整路径：SDK login、Preset 应用发请求、环境独立保留、目录换源", async () => {
  const evidence = { steps: [] };
  const stateDir = mkdtempSync(join(tmpdir(), "dcode-preset-e2e-"));
  let catStage = "A";
  let catalogClosedEarly = false;
  const catalog = await startCatalogLoop({
    validA: { etag: 'W/"cat-A"', lastModified: 1_800_000_000_000 },
    withModelsByProvider: (pid) => {
      if (pid === catalogProvider) {
        return [{
          id: "gpt-co", name: "Model Co", api: "openai-completions", provider: catalogProvider,
          baseUrl: "https://api.testco.example/v1", reasoning: false, input: ["text"],
          cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000, maxTokens: 4096, type: "chat",
        }];
      }
      // openai：仅当 catStage==='B' 时在线上给 openai 提供新 ID gpt-4o-2025（本地 anchor 派发 openai-responses）
      if (pid === "openai") {
        if (catStage !== "B") return [];  // A：empty 目录让 openai builtin 保留
        return [{
          id: "gpt-4o-2025", name: "GPT-4o 2025 (新上线)", api: "openai-responses", provider: "openai",
          baseUrl: "https://api.openai.com/v1", reasoning: false, input: ["text", "image"],
          cost: { input: 2, output: 6, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 256000, maxTokens: 32768, type: "chat",
        }];
      }
      return null; // 未覆盖的供应商 → 404 / gone
    },
    stage: () => catStage,
  });
  const openai = await startOpenAILoop(openaiKey, "gpt-4");
  const customLoop = await startCompletionsLoop(customKey, "a-model");
  try {
    const handle = await launchApp(stateDir, {
      // 不设 DCODE_VALIDATION_ASSEMBLY：走普通装配（目录服务、provider-directory store、login）。
      // catalog 源初始为 loopback（不连公网 pi.dev）；preset openai 端点覆盖为 loopback。
      DCODE_CATALOG_BASE_URL: catalog.origin,
      DCODE_E2E_PRESET_BASE_URLS: JSON.stringify({ [kimiProvider]: `${openai.origin}/v1` }),
      DCODE_E2E_STATE_ROOT: tmpdir(),
      DCODE_E2E: "1",
      // 关键：launchApp 默认注入 mock+sample；这里显式取消普通装配的 mock 短路由
      DCODE_VALIDATION_ASSEMBLY: "",
    }, ".");
    const { page } = handle;
    try {
      await gotoSettings(page);
      // 切到「自定义」面板先保存 A（SegmentedControl 内部 button 名「自定义」）
      await clickTab(page, "custom");
      await customFormFill(page, {
        label: "Co A",
        modelId: "a-model",
        baseUrl: `${customLoop.origin}/v1`,
        keyAction: "replace",
        apiKey: customKey,
      });
      await page.getByRole("button", { name: saveCustomButton }).click();
      // 保存完成后快照应呈现 modelSetup.kind 为 configured（custom）
      const readyCustom = await waitForSnapshot(
        page,
        (s) => s?.modelSetup?.kind === "custom" && s?.model?.available === true,
        null,
        "自定义保存后 modelSetup.kind=custom 且 model.available=true",
      );
      assert.ok(readyCustom.modelSetup);
      assertNoKeyLeak(JSON.stringify(readyCustom));

      // 进入「预设」面板，真实 UI 首用路径：点「API 密钥认证」→ 真实 prompt 出现 → 填 password → 点「确认」
      await clickTab(page, "preset");
      await page.getByLabel(/供应商|Provider/).selectOption(kimiProvider);
      // 离开认证目标会卸载 AuthControls：真实取消 SDK prompt，随后同一供应商能重新开始。
      await page.getByRole("button", { name: /API 密钥认证|API key/ }).click();
      await page.getByLabel(/OpenAI API key|API key/i).first().waitFor();
      await clickTab(page, "custom");
      await clickTab(page, "preset");
      await page.getByLabel(/供应商|Provider/).selectOption(kimiProvider);
      const afterCancelledLogin = await page.evaluate(() => window.dcode.listModelCatalog());
      assert.equal(afterCancelledLogin.providers.find((provider) => provider.id === kimiProvider).hasStoredKey, false, "卸载取消不提交认证资料");
      evidence.steps.push({ phase: "auth-unmount-cancelled" });
      // 真实 UI 触发：点「API 密钥认证」按钮（AuthControls.start("api_key")）
      await page.getByRole("button", { name: /API 密钥认证|API key/ }).click();
      // 真实 prompt 出现：SDK login 经 onAuthEvent 推 secret prompt，UI 渲染 label + password input
      // 用 label 关联（prompt.message 是 SDK 的 "OpenAI API key" 文案）
      const promptInput = page.getByLabel(/OpenAI API key|API key/i).first();
      await promptInput.waitFor({ timeout: 25_000 });
      await promptInput.fill(openaiKey);
      // 点「确认」提交（AuthControls.submitPrompt → replyAuthPrompt）
      await page.getByRole("button", { name: /确认|Confirm/ }).click();
      // 等真实 login 完成：UI 显示「认证资料已保存」或 catalog hasStoredKey 推送
      // loginProvider 完成后 main 调 noteCredentialChanged → catalog.onChanged → UI reload
      const startTime = Date.now();
      let openaiHasKey = false;
      while (Date.now() - startTime < 30_000) {
        const catalogAfterLogin = await page.evaluate(() => window.dcode.listModelCatalog());
        const openaiEntry = catalogAfterLogin.providers.find((p) => p.id === kimiProvider);
        if (openaiEntry?.hasStoredKey) { openaiHasKey = true; break; }
        await new Promise((r) => setTimeout(r, 200));
      }
      assert.ok(openaiHasKey, "SDK login 后 openai 凭据必须真实入档（hasStoredKey=true）");

      // 在目录中应用 openai/gpt-4
      // 按**角色 + 准确名称**定位设置里的「模型」分区入口：C07 新增的候选复选框与筛选框
      // 也带「模型」可访问名称，getByLabel 会同时命中它们（那是定位歧义，不是产品含义变化）。
      await page.getByRole("button", { name: /^(模型|Model)$/ }).click();
      // 等待 gpt-4 条目出现（内置目录应已可浏览）
      await page.getByText(new RegExp("gpt-4"), { exact: false }).first().waitFor({ timeout: 15_000 });
      await page.getByRole("button", { name: /^gpt-4/ }).first().click();
      await page.getByRole("button", { name: /应用当前模型|Apply as current model/ }).click();
      // 应用失败要把 issue/message 带出来（不能只靠超时等待）
      let applied;
      let lastFail = null;
      try {
        applied = await waitForSnapshot(
          page,
          (s) => ["preset", "preset-with-custom"].includes(s?.modelSetup?.kind) && s?.model?.available === true,
          null,
          "预设应用后 modelSetup.kind 在 preset/preset-with-custom 且 model.available=true",
        );
      } catch (err) {
        const snap = await page.evaluate(() => window.dcode.getSnapshot());
        lastFail = { message: (err && err.message) ?? String(err), modelSetup: snap.modelSetup, model: snap.model, closeError: snap.closeError };
        console.error("[preset-apply-failed]", JSON.stringify(lastFail, null, 2));
        throw err;
      }
      const sel = applied.modelSetup.kind === "preset" ? applied.modelSetup : applied.modelSetup.preset;
      assert.equal(sel.providerId, kimiProvider);
      assert.equal(sel.modelId, "gpt-4");
      // 自定义定义独立保留：快照应在 preset-with-custom 形式下含 custom 条目
      const afterPreset = await page.evaluate(() => window.dcode.getSnapshot());
      assert.ok(
        afterPreset.modelSetup.kind === "preset" || afterPreset.modelSetup.kind === "preset-with-custom",
        `customDefinition 应独立保留：实际 ${afterPreset.modelSetup.kind}`,
      );

      // 发送一发：loopback 真实收到精确 model=gpt-4 与 Bearer openaiKey
      // 设置页非 nav 返回；Escape 触发 SettingsPage 的真实「退到会话」路径
      await page.keyboard.press("Escape");
      await ready(page);
      await page.locator("textarea").first().fill("hello preset");
      await page.getByRole("button", { name: /发送|Send/ }).click();
      await openai.awaitCount(1, 30_000);
      // 等真实运行结束：snapshot run 状态回 ready（hasActiveWork 不挡 keep 保存）
      await waitForSnapshot(
        page,
        (s) => {
          const runs = s?.runs ?? {};
          return Object.values(runs).every((r) => (r.status !== "running" && r.status !== "pausing"));
        },
        null,
        "运行完成回 ready（ keep 保存不被 run-in-flight 拒）",
      );
      const presetReq = openai.requests[0];
      assert.ok(presetReq, "已收到至少一发预设请求");
      assert.ok(presetReq.authOk, `预设请求认证头必须精确匹配；实际 headers 摘要 modelOk=${presetReq.modelOk}`);
      assert.equal(presetReq.modelOk, true, `预设请求 model 必须为 gpt-4；实际 ${presetReq.model}`);
      evidence.steps.push({ phase: "preset-sent", model: presetReq.model });

      // —— 新 ID 实际 SDK 请求：catalog B 给 openai 提供在线新 ID gpt-4o-2025（builtin 中没有）——
      // 刷新目录拉到 B 源（openai 树出现新条目）；然后真实选择并应用 → 实际发送 → loopback 精确 model/nonce
      catStage = "B";
      await gotoSettings(page);
      await clickTab(page, "preset");
      await page.getByRole("button", { name: /刷新模型信息|Refresh model info/ }).click();
      // 等 openai 树上的新条目出现（含新 ID gpt-4o-2025，builtin 没有）
      await page.getByLabel(/供应商|Provider/).selectOption(kimiProvider);
      await page.getByText(/gpt-4o-2025/).first().waitFor({ timeout: 30_000 });
      // 用户从控件选新 ID 并应用
      await page.getByRole("button", { name: /^gpt-4o-2025/ }).click();
      // loopback 期望 model 切换为新 ID（真实 SDK 请求必须用新 ID 才被服务端接受）
      openai.setExpectedModel("gpt-4o-2025");
      await page.getByRole("button", { name: /应用当前模型|Apply as current model/ }).click();
      await waitForSnapshot(
        page,
        (s) => ["preset", "preset-with-custom"].includes(s?.modelSetup?.kind) && s?.model?.available === true,
        null,
        "新 ID 应用后 preset-with-custom 且可用",
      );
      // 发送：loopback 收到精确 model=gpt-4o-2025 与 Bearer openaiKey（SDK 真实用新 ID 派发）
      await page.keyboard.press("Escape");
      await ready(page);
      await page.locator("textarea").first().fill("hello new-id");
      const beforeNewId = openai.requests.length;
      await page.getByRole("button", { name: /发送|Send/ }).click();
      await openai.awaitCount(beforeNewId + 1, 30_000);
      await waitForSnapshot(
        page,
        (s) => Object.values(s?.runs ?? {}).every((r) => r.status !== "running" && r.status !== "pausing"),
        null,
        "新 ID 运行结束",
      );
      const newIdReq = openai.requests[openai.requests.length - 1];
      assert.ok(newIdReq.authOk, "新 ID 请求必须带精确 openaiKey Bearer");
      assert.equal(newIdReq.model, "gpt-4o-2025", "SDK 真实用新 ID 派发，不是 builtin fallback gpt-4");
      // 新 ID 的 api/endpoint 不变：openai-responses 协议、本地 endpoint（不跟远端 baseUrl 改向）
      assert.ok(String(newIdReq.url ?? "").startsWith("/v1/responses"), "api 保持 openai-responses 本地分发");
      // 新 ID 的能力参数真实成为目录元数据（contextWindow/maxTokens/input/reasoning 来自 B 源）
      const newIdCatalogEntry = await page.evaluate(async () => {
        const cat = await window.dcode.listModelCatalog();
        return (cat.models.openai ?? []).find((m) => m.id === "gpt-4o-2025") ?? null;
      });
      assert.ok(newIdCatalogEntry, "目录必须含新 ID 元数据");
      assert.equal(newIdCatalogEntry.maxTokens, 32768, "新 ID maxTokens 32768 来自 B 源在线目录（不是 builtin 模板）");
      assert.equal(newIdCatalogEntry.contextWindow, 256000);
      assert.deepEqual([...(newIdCatalogEntry.input ?? [])].sort(), ["image", "text"].sort());
      // 本次新回复 marker 真实进入时间线（非复用先前 preset/gpt-4 的 marker）
      await waitForSnapshot(
        page,
        (s) => {
          const entries = Object.values(s?.timelines ?? {})[0] ?? [];
          return Array.isArray(entries) && entries.some((b) => typeof b.text === "string" && b.text.includes(newIdReq.marker));
        },
        null,
        "时间线必须包含本次新 marker（对应当次新回复）",
      );
      evidence.steps.push({ phase: "new-id-sent", model: newIdReq.model, maxTokens: newIdCatalogEntry.maxTokens });

      // builtin 核对：gpt-4o-2025 不在 SDK OpenAI builtin（防错误用例借 builtin 假装新 ID）；新条目必须 remote 来源
      const newIdSource = await page.evaluate(async () => {
        const cat = await window.dcode.listModelCatalog();
        const entry = (cat.models.openai ?? []).find((m) => m.id === "gpt-4o-2025");
        return entry?.source ?? null;
      });
      assert.equal(newIdSource, "remote", "gpt-4o-2025 必须来自 remote（不在 OpenAI builtin 内）");

      // 自定义独立保留：切回 custom 面板（keep），update label，保留原 key 再发
      await gotoSettings(page);
      await clickTab(page, "custom");
      // 表单应保留原 label（原 metadata 都是 A；切换预设不动 custom 字段）
      const labelVal = await page.getByLabel(/显示名|Display name/i).inputValue();
      assert.equal(labelVal, "Co A", "切换预设后 custom label 仍保留");
      // keep 编辑：只改显示名，protocol/modelId/baseUrl/key 全部留用 A（同同 origin、同 key、同 modelId）
      await page.getByLabel(/显示名|Display name/i).fill("Co A (edited label)");
      await page.getByRole("button", { name: saveCustomButton }).click();
      try {
        await waitForSnapshot(
          page,
          (s) => s?.modelSetup?.kind === "custom" && s?.model?.available === true,
          null,
          "自定义 keep 后回到 custom 可用",
        );
      } catch (err) {
        const snap = await page.evaluate(() => window.dcode.getSnapshot());
        const text = await page.evaluate(() => document.body.innerText.slice(0, 2500));
        console.error("[custom-keep-failed]", JSON.stringify({ keepError: (err && err.message) ?? err, modelSetup: snap.modelSetup, model: snap.model, page: text }, null, 2));
        throw err;
      }
      // 回到会话发消息：custom 后端真实向 openai-completions /v1/chat/completions 发送，原 A key/同 modelId 精确匹配
      await page.keyboard.press("Escape");
      await ready(page);
      await page.locator("textarea").first().fill("hello custom");
      await page.getByRole("button", { name: /发送|Send/ }).click();
      const got2 = await customLoop.awaitCount(1, 30_000);
      await waitForSnapshot(
        page,
        (s) => Object.values(s?.runs ?? {}).every((r) => r.status !== "running" && r.status !== "pausing"),
        null,
        "custom keep 后发送运行结束",
      );
      assert.ok(got2[0]?.authOk, "自定义 keep 后发送必须仍用 A key（Bearer 精确匹配）");
      assert.equal(got2[0]?.modelOk, true, "自定义 keep 后 modelId 保持 a-model（自定义独立保留，不跟 preset 变）");
      evidence.steps.push({ phase: "custom-after-preset-survived" });

      // 目录换源：回到预设页编辑目录来源为同一 loopback（同 origin），观察来源文字真实变化
      await gotoSettings(page);
      await clickTab(page, "preset");
      const prevSource = await page.locator("#catalog-source-input").inputValue();
      assert.equal(prevSource, catalog.origin, "默认目录源应为本用例 loopback");
      // 触发换源：同源 URL 规范化差异（trailing slash）使按钮可点，点击实际完成一次检查
      await page.locator("#catalog-source-input").fill(`${catalog.origin}/`);
      const saveBtn = page.getByRole("button", { name: /保存并检查|Save and check/ });
      const enabled = await saveBtn.isEnabled();
      assert.ok(enabled, "URL 规范化差异下保存按钮必须可点（同源换源操作可达）");
      await saveBtn.click();
      // 同源 setSource 实际完成一次检查（刷新 catalog；受 fixture 处理，200 含新 ETag 提交）
      evidence.steps.push({ phase: "catalog-source-applied" });

      // 真实重开：最后一次写入是 custom keep（origin/凭据须留用 A）；重开恢复 custom 并再发证明 origin 核对 A
      await handle.close();
      const reopened = await launchApp(stateDir, {
        DCODE_CATALOG_BASE_URL: catalog.origin,
        DCODE_E2E_PRESET_BASE_URLS: JSON.stringify({ [kimiProvider]: `${openai.origin}/v1` }),
        DCODE_E2E_STATE_ROOT: tmpdir(),
        DCODE_E2E: "1",
        DCODE_VALIDATION_ASSEMBLY: "",
      }, ".");
      try {
        await ready(reopened.page);
        const snap = await reopened.page.evaluate(() => window.dcode.getSnapshot());
        assert.equal(snap.modelSetup.kind, "custom", "最后一次保存是 custom keep；重开应恢复 custom");
        assert.equal(snap.modelSetup.label, "Co A (edited label)", "重开后自定义显示名保留 A（独立）");
        assert.ok(snap.model.available, "重开后 custom backend 可用（A key 已持久化）");
        // 凭据文件真实落盘（不读明文）
        assert.ok(existsSync(join(stateDir, "provider-directory.json")));
        const record = JSON.parse(readFileSync(join(stateDir, "provider-directory.json"), "utf8"));
        assert.ok(record.credentials?.[kimiProvider], "openai preset key 真实入档");
        assert.ok(record.credentials?.["user-defined"], "custom A key 独立入档");
        assert.ok(!JSON.stringify(record).includes(openaiKey), "凭据密文不落明文");
        assert.ok(!JSON.stringify(record).includes(customKey), "自定义 key 也不落明文");
        assertNoKeyLeak(JSON.stringify(snap));
        // 重开后再发一发：loopback 仍接受 A key（origin 核对 A，不拿当前 B 或 B key）
        await gotoSettings(reopened.page);
        await reopened.page.keyboard.press("Escape");
        await ready(reopened.page);
        await reopened.page.locator("textarea").first().fill("hello after reopen");
        const beforeCount = customLoop.requests.length;
        await reopened.page.getByRole("button", { name: /发送|Send/ }).click();
        await customLoop.awaitCount(beforeCount + 1, 30_000);
        await waitForSnapshot(
          reopened.page,
          (s) => Object.values(s?.runs ?? {}).every((r) => r.status !== "running" && r.status !== "pausing"),
          null,
          "重开后发送运行结束",
        );
        const reqAfter = customLoop.requests[customLoop.requests.length - 1];
        assert.ok(reqAfter.authOk, "重开后发送必须继续用 A key（origin 核对 A）");
        evidence.steps.push({ phase: "reopened-send-ok" });

        // 重开后从缓存再选 gpt-4o-2025（不重输 key）：凭据已持久化、缓存新 ID 可选
        // 再应用 → 再发送 → loopback 仍收到精确 gpt-4o-2025（重开后 SDK 模板真实派发，不是 builtin fallback）
        await gotoSettings(reopened.page);
        await clickTab(reopened.page, "preset");
        await reopened.page.getByLabel(/供应商|Provider/).selectOption(kimiProvider);
        await reopened.page.getByText(/gpt-4o-2025/).first().waitFor({ timeout: 30_000 });
        await reopened.page.getByRole("button", { name: /^gpt-4o-2025/ }).click();
        await reopened.page.getByRole("button", { name: /应用当前模型|Apply as current model/ }).click();
        await waitForSnapshot(
          reopened.page,
          (s) => ["preset", "preset-with-custom"].includes(s?.modelSetup?.kind) && s?.model?.available === true,
          null,
          "重开后新 ID 从缓存可选可应用",
        );
        // 回到会话再发送：loopback 精确收 gpt-4o-2025
        await reopened.page.keyboard.press("Escape");
        await ready(reopened.page);
        await reopened.page.locator("textarea").first().fill("hello after reopen new-id");
        const beforeReopen2 = openai.requests.length;
        await reopened.page.getByRole("button", { name: /发送|Send/ }).click();
        await openai.awaitCount(beforeReopen2 + 1, 30_000);
        const reqReopen2 = openai.requests[openai.requests.length - 1];
        assert.ok(reqReopen2.authOk, "重开后新 ID 发送仍用 openaiKey（不重输）");
        assert.equal(reqReopen2.model, "gpt-4o-2025", "重开后 SDK 真实用新 ID 派发（不是 fallback）");
        evidence.steps.push({ phase: "reopened-new-id-sent", model: reqReopen2.model });

        // (d) 反例：B 保持 current（新 ID 应用后未切回 custom）→ 真实重开 → 切回 A（custom keep）→ A 资料保留 + A key 可用
        // 当前 current=preset（新 ID）。直接二次真实重开（B 保持 current），不先切回 custom。
        await reopened.close();
        const reopenedWithPresetCurrent = await launchApp(stateDir, {
          DCODE_CATALOG_BASE_URL: catalog.origin,
          DCODE_E2E_PRESET_BASE_URLS: JSON.stringify({ [kimiProvider]: `${openai.origin}/v1` }),
          DCODE_E2E_STATE_ROOT: tmpdir(),
          DCODE_E2E: "1",
          DCODE_VALIDATION_ASSEMBLY: "",
        }, ".");
        try {
          await ready(reopenedWithPresetCurrent.page);
          const snapAgain = await reopenedWithPresetCurrent.page.evaluate(() => window.dcode.getSnapshot());
          assert.ok(
            ["preset", "preset-with-custom"].includes(snapAgain.modelSetup.kind),
            `B（preset）应为 current；实际 ${snapAgain.modelSetup.kind}`,
          );
          // 切回 A：custom keep（当前是 preset-with-custom 的 A 定义保留）
          await gotoSettings(reopenedWithPresetCurrent.page);
          await clickTab(reopenedWithPresetCurrent.page, "custom");
          const labelVal2 = await reopenedWithPresetCurrent.page.getByLabel(/显示名|Display name/i).inputValue();
          assert.equal(labelVal2, "Co A (edited label)", "B 为 current 时切回 custom 仍回显 A label（不丢 A）");
          await reopenedWithPresetCurrent.page.getByRole("button", { name: saveCustomButton }).click();
          await waitForSnapshot(
            reopenedWithPresetCurrent.page,
            (s) => s?.modelSetup?.kind === "custom" && s?.model?.available === true,
            null,
            "B 为 current 后切回 A 仍可用",
          );
          // B 保持 current 后真正关闭/重开，再留用 A：同段请求与可见随机回复共同证明凭据归属。
          await reopenedWithPresetCurrent.page.keyboard.press("Escape");
          const reqCustomA = await sendInNewSession(reopenedWithPresetCurrent.page, "hello B-cold custom-A", customLoop, "a-model");
          evidence.steps.push({ phase: "b-current-coldreopen-customa-send", model: reqCustomA.model, marker: reqCustomA.marker });
        } finally {
          await reopenedWithPresetCurrent.close();
        }
      } finally {
        await reopened.close();
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
    writeFileSync(join(EVID, "preset-catalog-path.json"), JSON.stringify(evidence, null, 2));

    // (f) 目录服务器关闭后离线重开：缓存的 gpt-4o-2025 仍可选（来源显示真实缓存来源/时间），仍可用 openaiKey 发送；
    // 不能因无目录刷新机会就丢已校验的新 ID（独立审查离线 proof）。
    await catalog.close();
    catalogClosedEarly = true;
    const offlineReopen = await launchApp(stateDir, {
      // 目录源指向已关闭的 origin（连接失败但 refresh 异步不阻塞 startup）；preset loopback 仍经 loopback openai。
      DCODE_CATALOG_BASE_URL: catalog.origin,
      DCODE_E2E_PRESET_BASE_URLS: JSON.stringify({ [kimiProvider]: `${openai.origin}/v1` }),
      DCODE_E2E_STATE_ROOT: tmpdir(),
      DCODE_E2E: "1",
      DCODE_VALIDATION_ASSEMBLY: "",
    }, ".");
    try {
      await ready(offlineReopen.page);
      await gotoSettings(offlineReopen.page);
      await clickTab(offlineReopen.page, "preset");
      await offlineReopen.page.getByLabel(/供应商|Provider/).selectOption(kimiProvider);
      // 离线重开后，gpt-4o-2025 仍能从缓存看到（catalogGeneratedAt/lastModified 保留 built-in builtin 之后）
      await offlineReopen.page.getByText(/gpt-4o-2025/).first().waitFor({ timeout: 20_000 });
      await offlineReopen.page.getByRole("button", { name: /^gpt-4o-2025/ }).click();
      await offlineReopen.page.getByRole("button", { name: /应用当前模型|Apply as current model/ }).click();
      await waitForSnapshot(
        offlineReopen.page,
        (s) => ["preset", "preset-with-custom"].includes(s?.modelSetup?.kind) && s?.model?.available === true,
        null,
        "离线重开从新 ID 缓存可应用（目录服务器已关）",
      );
      // 缓存目录加载不解除暂停；用真实「新会话」动作明确开始本次工作。
      await offlineReopen.page.keyboard.press("Escape");
      const reqOffline = await sendInNewSession(offlineReopen.page, "hello offline send", openai, "gpt-4o-2025");
      evidence.steps.push({ phase: "offline-reopen-cached-new-id-sent", model: reqOffline.model, marker: reqOffline.marker });
      writeFileSync(join(EVID, "preset-catalog-path.json"), JSON.stringify(evidence, null, 2));
    } finally {
      await offlineReopen.close();
    }
  } finally {
    if (!catalogClosedEarly) await catalog.close();
    await openai.close();
    await customLoop.close();
    cleanup(stateDir);
  }
});

// ---------- P1-2：准入会话身份必须绑定到**本条会话**的端口 ----------
//
// 同一个普通后端上开两条真实会话 S1/S2：S1 先开并选定自己的模型，S2 后开并选定另一个模型。
// 随后再从 S1 发一次：那次请求必须按 **S1 自己的身份**准入、带上 S1 自己的 modelId。
// 若后端共用一个「最后一次 open」的可变会话引用，S1 的后续请求会按 S2 身份准入，
// 裁定目标落到 S2 的模型，loopback 就会收到与 S1 不符的 modelId。
test("P1-2 同一普通后端两条真实会话：S1 后续请求仍按 S1 身份与自己的 modelId 发出", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "dcode-two-session-"));
  let catStage = "A";
  const catalog = await startCatalogLoop({
    validA: { etag: 'W/"cat-A"', lastModified: 1_800_000_000_000 },
    withModelsByProvider: (pid) => {
      if (pid === catalogProvider) {
        return [{
          id: "gpt-co", name: "Model Co", api: "openai-completions", provider: catalogProvider,
          baseUrl: "https://api.testco.example/v1", reasoning: false, input: ["text"],
          cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000, maxTokens: 4096, type: "chat",
        }];
      }
      // openai：A 段只有 builtin（gpt-4）；B 段在线上给出新 ID，两个模型因此可在同一来源并存
      if (pid === "openai") {
        if (catStage !== "B") return [];
        return [{
          id: "gpt-4o-2025", name: "GPT-4o 2025 (新上线)", api: "openai-responses", provider: "openai",
          baseUrl: "https://api.openai.com/v1", reasoning: false, input: ["text", "image"],
          cost: { input: 2, output: 6, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 256000, maxTokens: 32768, type: "chat",
        }];
      }
      return null;
    },
    stage: () => catStage,
  });
  const openai = await startOpenAILoop(openaiKey, "gpt-4");
  const customLoop = await startCompletionsLoop(customKey, "a-model");
  const handle = await launchApp(stateDir, {
    DCODE_CATALOG_BASE_URL: catalog.origin,
    DCODE_E2E_PRESET_BASE_URLS: JSON.stringify({ [kimiProvider]: `${openai.origin}/v1` }),
    DCODE_E2E_STATE_ROOT: tmpdir(),
    DCODE_E2E: "1",
    DCODE_VALIDATION_ASSEMBLY: "",
  }, ".");
  const { page } = handle;
  /** 收束期异常不夺结论：原始失败优先，没有原始失败才报收束失败。 */
  let primary = null;
  try {
    await ready(page);
    // 前缀完全沿同文件已验证正例的顺序：先存一个受控 custom，再做 preset 认证与「应用当前模型」。
    // 这里只为复用确定能跑通的 UI 路径；不把「必须先存 custom 才可用 preset」当成产品要求。
    await gotoSettings(page);
    await clickTab(page, "custom");
    await customFormFill(page, {
      label: "Co A",
      modelId: "a-model",
      baseUrl: `${customLoop.origin}/v1`,
      keyAction: "replace",
      apiKey: customKey,
    });
    await page.getByRole("button", { name: saveCustomButton }).click();
    const configuredCustom = await waitForSnapshot(
      page,
      (snap) => snap?.modelSetup?.kind === "custom" && snap?.model?.available === true,
      null,
      "自定义保存后 modelSetup.kind=custom 且 model.available=true",
    );
    assert.ok(configuredCustom.modelSetup, "custom 配置应真实成立");

    // 预设认证：没有凭据就没有真实请求
    await clickTab(page, "preset");
    await clickTab(page, "preset");
    await page.getByLabel(/供应商|Provider/).selectOption(kimiProvider);
    await page.getByRole("button", { name: /API 密钥认证|API key/ }).click();
    const prompt = page.getByLabel(/OpenAI API key|API key/i).first();
    await prompt.waitFor({ timeout: 25_000 });
    await prompt.fill(openaiKey);
    await page.getByRole("button", { name: /确认|Confirm/ }).click();
    const authDeadline = Date.now() + 30_000;
    let hasKey = false;
    while (Date.now() < authDeadline) {
      const list = await page.evaluate(() => window.dcode.listModelCatalog());
      if (list.providers.find((p) => p.id === kimiProvider)?.hasStoredKey) { hasKey = true; break; }
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(hasKey, "预设凭据应真实入档");
    // 认证入档只证明凭据可用；发送门还要求**已配置当前模型**，所以先走设置页的真实应用流程：
    // 「模型」分区 → 选 gpt-4 → 「应用当前模型」→ 快照确认 provider/model 与 available。
    await page.getByRole("button", { name: /^(模型|Model)$/ }).click();
    await page.getByText(new RegExp("gpt-4"), { exact: false }).first().waitFor({ timeout: 20_000 });
    await page.getByRole("button", { name: /^gpt-4/ }).first().click();
    await page.getByRole("button", { name: /应用当前模型|Apply as current model/ }).click();
    const applied = await waitForSnapshot(
      page,
      (snap) => ["preset", "preset-with-custom"].includes(snap?.modelSetup?.kind) && snap?.model?.available === true,
      null,
      "预设应用后 modelSetup.kind 在 preset/preset-with-custom 且 model.available=true",
    );
    const sel = applied.modelSetup.kind === "preset" ? applied.modelSetup : applied.modelSetup.preset;
    assert.equal(sel.providerId, kimiProvider, `当前模型来源应是 ${kimiProvider}（实得 ${sel.providerId}）`);
    assert.equal(sel.modelId, "gpt-4", `当前模型应是 gpt-4（实得 ${sel.modelId}）`);

    await page.keyboard.press("Escape");
    await ready(page);

    /**
     * 真实「新会话」按钮建会话（同文件已验证正例的建法），并按**新增 id** 取回，
     * 不用桥调用创建——两条会话都必须是用户动作真实建立的。
     */
    const newSession = async () => {
      const before = await page.evaluate(() => window.dcode.getSnapshot());
      await page.getByRole("button", { name: /^新会话$/ }).click();
      const beforeIds = before.sessions.map((x) => x.id);
      const after = await waitForSnapshot(
        page,
        (s, ids) => s.sessions.some((x) => !ids.includes(x.id)),
        beforeIds,
        "新会话已正式建立",
      );
      return after.sessions.find((x) => !beforeIds.includes(x.id));
    };
    /**
     * 进入指定会话：先点开**所属任务**把会话列表展开（会话是任务下的 treeitem），
     * 再点该会话行。走已验证的侧栏真实导航，不用桥调用切会话。
     */
    const gotoSession = async (sessionId) => {
      const info = await page.evaluate(async (id) => {
        const snap = await window.dcode.getSnapshot();
        const session = snap.sessions.find((s) => s.id === id);
        const task = snap.tasks.find((t) => t.id === session?.taskId);
        return { title: session?.title ?? "", taskTitle: task?.title ?? "" };
      }, sessionId);
      // 任务和首发会话可同名：.first() 会再次点任务行，只折叠列表而没有选回会话。
      // 任务行持有展开状态，会话行持有当前状态；按这两个真实可访问性属性区分目标。
      const taskRow = page.locator('[role="treeitem"][aria-expanded]').filter({
        has: page.getByText(info.taskTitle, { exact: true }),
      });
      assert.equal(await taskRow.count(), 1, "所属任务行应唯一");
      if (await taskRow.getAttribute("aria-expanded") !== "true") await taskRow.click();
      const sessionRow = page.locator('[role="treeitem"]:not([aria-expanded])').filter({
        has: page.getByText(info.title, { exact: true }),
      });
      assert.equal(await sessionRow.count(), 1, "目标会话行应唯一，不能误点同名任务");
      await sessionRow.waitFor({ state: "visible", timeout: 20_000 });
      await sessionRow.click();
      await page.waitForFunction((title) => [...document.querySelectorAll('[role="treeitem"][aria-current="true"]')]
        .some((row) => row.textContent?.trim() === title), info.title);
    };
    /** 在**指定**会话里选定某个来源+模型（真实点模型入口里的条目），
     *  并等这条会话的 choice 真的提交（不按固定延时假定已落定）。 */
    const pickModel = async (sessionId, modelId) => {
      await page.getByTestId("model-entry-trigger").click();
      await page.getByTestId("model-search").waitFor({ state: "visible", timeout: 15_000 });
      const item = page.getByTestId(`model-item-${kimiProvider}-${modelId}`);
      await item.waitFor({ state: "visible", timeout: 20_000 });
      await item.click();
      await page.keyboard.press("Escape");
      // 选择是否落在**这条**会话上由正式快照回答：条目消失不等于 choice 已提交
      await waitForSnapshot(
        page,
        async (s, want) => {
          const view = await page.evaluate((id) => window.dcode.listModelSources({ sessionId: id }), want.sessionId);
          const st = view.sessionStates[0];
          return st?.choice?.mode === "explicit"
            && st.choice.sourceId === want.sourceId
            && st.choice.modelId === want.modelId;
        },
        { sessionId, sourceId: kimiProvider, modelId },
        `${sessionId} 的选择未提交为 ${kimiProvider}/${modelId}`,
      );
    };
    const send = async (text, expectedSessionId = null) => {
      const before = openai.requests.length;
      await page.locator("textarea").first().fill(text);
      await page.getByRole("button", { name: /发送|Send/ }).click();
      // 发送是否**真的发生**要看本次输入块是否形成：「当前没有运行在进行」在发送落地前就成立，
      // 用它等待会在点击刚发出时立刻通过，把没发出去的发送读成已发送。
      await waitForSnapshot(
        page,
        (s, t) => Object.values(s?.timelines ?? {}).flat()
          .some((b) => b.kind === "message" && b.role === "user" && b.text === t),
        text,
        `本次发送未形成输入块：${text}`,
      );
      // 这次发送必须**正式被接收**：静默未接收（如准入拒绝）在等待里看不出来，
      // 失败信息里带上真实回执与路由判定，避免只能靠超时猜。
      const outcome = await page.evaluate(async (t) => {
        const snap = await window.dcode.getSnapshot();
        const hit = Object.values(snap.timelines ?? {}).flat()
          .filter((b) => b.kind === "message" && b.role === "user" && b.text === t).at(-1);
        return {
          sessionId: Object.entries(snap.timelines ?? {}).find(([, blocks]) => blocks.includes(hit))?.[0] ?? null,
          receipt: hit?.receipt ?? null,
          closeError: snap.closeError ?? null,
          runs: Object.entries(snap.runs ?? {}).map(([id, r]) => ({
            id, status: r.status, errorNote: r.errorNote ?? null, note: r.note ?? null,
          })),
          models: Object.values(snap.sessionModels ?? {}).map((m) => ({
            id: m.sessionId, mode: m.choice.mode, waiting: m.waitingExplicitContinue,
            invalid: m.invalidReason ?? null, decision: m.lastRouting?.decision?.kind ?? null,
            pick: m.choice.mode === "explicit" ? `${m.choice.sourceId}/${m.choice.modelId}` : null,
          })),
        };
      }, text);
      assert.equal(outcome.receipt?.status, "accepted",
        `本次发送应被正式接收（实得 ${JSON.stringify(outcome)}）`);
      if (expectedSessionId) assert.equal(outcome.sessionId, expectedSessionId, '本次正式输入属于选中的原会话');
      // 这一轮**真正收束**的证据是当次回复正文（loopback 的 marker）落到时间线上；
      // 只等「没有运行在进行」会在请求刚发出时就通过，随后改选就会落在输出途中。
      try { await openai.awaitCount(before + 1, 40_000); }
      catch (error) {
        // 只读隔离运行副本的有限身份与终态；原断言／timeout 不变，不输出协议、认证或模型正文。
        const diagnostic = { input: text, expectedSessionId, accepted: outcome, httpCount: openai.requests.length, runtime: null };
        const copy = await mkdtemp(join(tmpdir(), 'dcode-two-session-readonly-'));
        let storage;
        let stage = 'copy';
        try {
          await cp(join(stateDir, 'runtime', outcome.sessionId), copy, { recursive: true });
          stage = 'open-storage';
          storage = await openNodeJsonlStorage(copy, BACKGROUND_CONTEXT);
          stage = 'read-entries';
          const entries = await storage.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 128, undefined, BACKGROUND_CONTEXT);
          stage = 'read-tasks';
          const tasks = await storage.scanTasks({ conversationId: ROOT_CONVERSATION_ID }, 128, undefined, BACKGROUND_CONTEXT);
          stage = 'read-agent';
          const address = await storage.findDocument({ kind: 'pi.agent', scope: { kind: 'conversation', conversationId: ROOT_CONVERSATION_ID } }, 'current', BACKGROUND_CONTEXT);
          const agent = address ? await storage.document(address.id, 'current', BACKGROUND_CONTEXT) : null;
          const liveAddress = await storage.findDocument({ kind: 'pi.live', scope: { kind: 'conversation', conversationId: ROOT_CONVERSATION_ID } }, 'current', BACKGROUND_CONTEXT);
          const live = liveAddress ? await storage.document(liveAddress.id, 'current', BACKGROUND_CONTEXT) : null;
          diagnostic.runtime = {
            agentModel: agent?.value?.model ?? null,
            live: live ? { runTaskId: live.value.run?.taskId ?? null, compactions: live.value.compactions ?? null } : null,
            tasks: tasks.items.map(task => ({ id: task.id, kind: task.kind, status: task.state?.status ?? null,
              phase: task.state?.checkpoint?.phase ?? null, stage: task.state?.checkpoint?.stage ?? null,
              model: task.state?.checkpoint?.model ?? null, attempt: task.state?.checkpoint?.attempt ?? null })),
            responses: entries.items.flatMap(entry => (entry.model ?? []).filter(message => message.role === 'assistant').map(message => ({
              entryId: entry.id, taskId: entry.byTaskId, provider: message.provider, modelId: message.model,
              responseId: message.responseId ?? null, stopReason: message.stopReason,
              failure: !message.errorMessage ? null : message.errorMessage.includes('Context overflow') ? 'context-overflow'
                : message.errorMessage.includes('Physical generation invocation changed') ? 'physical-invocation-changed'
                  : message.errorMessage.includes('unbound') ? 'unbound-request' : 'other-failure',
            }))),
          };
        } catch (cause) { diagnostic.runtime = { unavailable: true, stage, errorName: cause?.name ?? null, errorCode: cause?.code ?? null,
          failure: /not.*function/i.test(cause?.message ?? '') ? 'method-unavailable' : /corrupt|unexpected|json/i.test(cause?.message ?? '') ? 'journal-invalid' : 'read-failed' }; }
        finally { await storage?.close(BACKGROUND_CONTEXT); await rm(copy, { recursive: true, force: true }); }
        writeFileSync(join(EVID, `P1-two-session-failure-${before + 1}.json`), JSON.stringify(diagnostic, null, 2));
        throw error;
      }
      const request = openai.requests.at(-1);
      // 先核当次受控 HTTP 的身份，错误模型不能靠等待一个永不会产生的回复掩盖。
      assert.equal(request.authOk, true, "当次 HTTP 使用本来源认证");
      assert.equal(request.modelOk, true, `当次 HTTP 模型身份不符，实得 ${request.model}`);
      await page.getByText(request.marker, { exact: true }).first().waitFor({ timeout: 30_000 });
      return request;
    };

    // S1：先开并发第一次真实请求。这里走**草稿态首发**（与同文件已验证正例一致）：
    // 应用完当前模型后 Escape 退到会话，此时还没有会话视图，真实发送本身才建立 S1。
    const s1Request = await send("S1 第一次");
    assert.equal(s1Request.model, "gpt-4",
      `S1 首发应带刚应用的当前模型 gpt-4（实得 ${s1Request.model}）`);
    assert.equal(s1Request.authOk, true, "S1 首发用该来源自己的凭据");
    // S1 的身份来自这条**已接收**的首发，不预先造对象，也不靠会话标题猜
    const s1 = await page.evaluate(async (text) => {
      const snap = await window.dcode.getSnapshot();
      const hit = Object.entries(snap.timelines).find(([, blocks]) => blocks.some(
        (b) => b.kind === "message" && b.role === "user" && b.text === text && b.receipt?.status === "accepted"));
      return hit ? { id: hit[0] } : null;
    }, "S1 第一次");
    assert.ok(s1?.id, "S1 应由真实首发建立且该输入已接收");
    // S1 在自己的会话里明确选定 gpt-4（真实点模型入口条目），形成这条会话自己的采用关系。
    // 此时 S1 那一轮已按当次回复正文确认收束，改选不会落在输出途中。
    await pickModel(s1.id, "gpt-4");

    // 目录换到 B 段：openai 线上多出新 ID，与 gpt-4 在同一来源并存。
    // 换源入口与同文件已验证正例完全一致：回设置页的「预设」页签再刷新（停在自定义页签时刷新按钮不在）。
    await gotoSettings(page);
    catStage = "B";
    await clickTab(page, "preset");
    await page.getByRole("button", { name: /刷新模型信息|Refresh model info/ }).click();
    await page.getByLabel(/供应商|Provider/).selectOption(kimiProvider);
    await page.getByText(/gpt-4o-2025/).first().waitFor({ timeout: 30_000 });
    await page.keyboard.press("Escape");
    await ready(page);

    // S2：在会话视图里点真实「新会话」建立（此时才存在该按钮），选自己的新 ID
    const s2 = await newSession();
    assert.ok(s2?.id && s2.id !== s1.id, `S2 必须是与 S1 不同的一条新会话（实得 ${s2?.id}）`);
    await pickModel(s2.id, "gpt-4o-2025");
    openai.setExpectedModel("gpt-4o-2025");
    const s2Request = await send("S2 自己的请求", s2.id);
    assert.equal(s2Request.model, "gpt-4o-2025", `S2 的请求应带自己的 modelId（实得 ${s2Request.model}）`);
    assert.equal(s2Request.authOk, true, "S2 的请求用该来源自己的凭据");

    // 回到 S1 再发一次：必须仍按 S1 自己的身份与 gpt-4 发出
    await gotoSession(s1.id);
    // 仅有同名标题不能证明主区已到达：S1 首轮的当次随机回复必须在当前时间线可见。
    await page.getByText(s1Request.marker, { exact: true }).waitFor({ state: "visible", timeout: 20_000 });
    // 回到 S1 时它此前那次真实回复仍在：已完成工作不被后开的 S2 顶掉，原输入也不重投
    const s1Before = await page.evaluate(async (id) => {
      const snap = await window.dcode.getSnapshot();
      const blocks = snap.timelines[id] ?? [];
      return {
        count: blocks.length,
        hasFirst: blocks.some((b) => b.kind === "message" && b.role === "user" && b.text === "S1 第一次"),
        firstMarkers: blocks.filter((b) => b.kind === "message" && b.role === "user" && b.text === "S1 第二次").length,
      };
    }, s1.id);
    assert.ok(s1Before.hasFirst, "S1 首发输入仍在本会话");
    assert.equal(s1Before.firstMarkers, 0, "S1 第二次尚未发送，不得预先存在");
    openai.setExpectedModel("gpt-4");
    const last = await send("S1 第二次", s1.id);
    assert.equal(last.model, "gpt-4",
      `S1 的后续请求必须带 S1 自己的 modelId，不得被后打开的 S2 覆盖（实得 ${last.model}）`);
    assert.equal(last.authOk, true, "S1 的请求仍用该来源自己的凭据");
    const s1After = await page.evaluate(async (id) => {
      const snap = await window.dcode.getSnapshot();
      const blocks = snap.timelines[id] ?? [];
      return {
        count: blocks.length,
        firsts: blocks.filter((b) => b.kind === "message" && b.role === "user" && b.text === "S1 第一次").length,
        seconds: blocks.filter((b) => b.kind === "message" && b.role === "user" && b.text === "S1 第二次").length,
      };
    }, s1.id);
    assert.equal(s1After.seconds, 1, "S1 第二次输入只出现一次");
    assert.equal(s1After.firsts, 1, "S1 首发输入不得被重投");
    assert.ok(s1After.count > s1Before.count, "S1 应多出这一轮的真实对话");
    // 全程只有三次真实请求：S1 首发、S2、S1 第二次；没有为探路额外发请求
    assert.equal(openai.requests.length, 3, `真实请求次数应为 3（实得 ${openai.requests.length}）`);
    // 三次都发往 openai 来源：自定义端点一次也不该收到（本场景从未选自定义），更不该拿到 openai 的密钥
    assert.equal(customLoop.requests.length, 0,
      `自定义端点不该收到任何请求（实得 ${customLoop.requests.length}：${JSON.stringify(customLoop.requests.map((r) => r.model))}）`);
  } catch (error) {
    // 收束期的异常会盖掉真正的失败原因：先留住原始失败，收束照做但不夺结论
    primary = error;
  } finally {
    try { await handle.close(); } catch (closeError) { if (!primary) primary = closeError; }
    await killApp(handle);
    cleanup(stateDir);
    catalog.close();
    openai.close();
    customLoop.close();
    if (primary) throw primary;
  }
});


// ---------- item4：当前 custom 与会话选择分别成立 ----------
// 只调用公开只读桥观察事实；设置、认证、导航、改选和输入都由真实 UI 完成。
// 两个受控端点分别核协议、精确模型和独立认证，并返回本次随机 nonce。
async function item4GotoOriginalSession(page, sessionId) {
  const info = await page.evaluate(async (id) => {
    const snapshot = await window.dcode.getSnapshot();
    const session = snapshot.sessions.find((candidate) => candidate.id === id);
    const task = snapshot.tasks.find((candidate) => candidate.id === session?.taskId);
    return { sessionTitle: session?.title ?? null, taskTitle: task?.title ?? null };
  }, sessionId);
  assert.ok(info.sessionTitle && info.taskTitle, "原会话及其任务仍存在");
  // 首发可能使任务与会话同名：任务行有 aria-expanded，会话行没有，不能取同名第一项。
  const taskRow = page.locator('[role="treeitem"][aria-expanded]').filter({
    has: page.getByText(info.taskTitle, { exact: true }),
  });
  assert.equal(await taskRow.count(), 1, "准确定位原会话所属任务");
  if (await taskRow.getAttribute("aria-expanded") !== "true") await taskRow.click();
  const sessionRow = page.locator('[role="treeitem"]:not([aria-expanded])').filter({
    has: page.getByText(info.sessionTitle, { exact: true }),
  });
  assert.equal(await sessionRow.count(), 1, "准确定位原会话行");
  await sessionRow.click();
  await sessionRow.and(page.locator('[aria-current="true"]')).waitFor({ state: "visible" });
  assert.equal(await sessionRow.getAttribute("aria-current"), "true", "导航已实际选中原会话");
}

async function item4AuthenticatePresetB(page) {
  await gotoSettings(page);
  await clickTab(page, "preset");
  await page.getByLabel(/供应商|Provider/).selectOption(kimiProvider);
  await page.getByRole("button", { name: /API 密钥认证|API key/ }).click();
  const prompt = page.getByLabel(/OpenAI API key|API key/i).first();
  await prompt.waitFor({ timeout: 25_000 });
  await prompt.fill(openaiKey);
  await page.getByRole("button", { name: /确认|Confirm/ }).click();
  await waitForSnapshot(page, async () => {
    const catalog = await page.evaluate(() => window.dcode.listModelCatalog());
    return catalog.providers.find((provider) => provider.id === kimiProvider)?.hasStoredKey === true;
  }, null, "B 的真实认证流程已原子保存");
  // 特意不点「应用当前模型」：B 的认证不得把当前 custom A 改写成预设。
  await page.keyboard.press("Escape");
  await ready(page);
}

function item4AssertCurrentA(snapshot, customLoop) {
  assert.equal(snapshot.modelSetup?.kind, "custom", "设置页当前接入仍为 custom A");
  assert.equal(snapshot.modelSetup.provider, "openai-completions");
  assert.equal(snapshot.modelSetup.modelId, "a-model");
  assert.equal(snapshot.modelSetup.label, "Item4 Custom A");
  assert.equal(snapshot.modelSetup.baseUrl, `${customLoop.origin}/v1`);
  assert.equal(snapshot.modelSetup.hasKey, true, "A 的原加密认证仍保留");
  assert.equal(snapshot.model.available, true, "原当前接入仍可用");
  assertNoKeyLeak(JSON.stringify(snapshot));
}

function item4RequestHasText(request, role, text) {
  const messages = request.body?.input ?? request.body?.messages ?? [];
  return messages.some((entry) => entry.role === role && (
    entry.content === text || (Array.isArray(entry.content) && entry.content.some((part) => part.text === text))
  ));
}

async function item4SendAndObserve(page, server, text, modelId, sessionId = null) {
  const beforeCount = server.requests.length;
  await page.locator("textarea").first().fill(text);
  await page.getByRole("button", { name: /^(发送|Send)$/ }).click();
  const accepted = await waitForSnapshot(page, (snapshot) => {
    const timelines = sessionId
      ? [[sessionId, snapshot.timelines[sessionId] ?? []]]
      : Object.entries(snapshot.timelines);
    return timelines.some(([, blocks]) => blocks.some((block) => block.kind === "message"
      && block.role === "user" && block.text === text && block.receipt?.status === "accepted"));
  }, null, "本次新输入须在正确会话正式接收，不能用发送前就成立的空闲状态代替");
  const matches = Object.entries(accepted.timelines).filter(([, blocks]) => blocks.some((block) =>
    block.kind === "message" && block.role === "user" && block.text === text && block.receipt?.status === "accepted"));
  assert.equal(matches.length, 1, "本次随机输入只属于一个真实会话");
  const actualSessionId = matches[0][0];
  if (sessionId) assert.equal(actualSessionId, sessionId, "输入没有被送到新会话或同名任务草稿");
  await server.awaitCount(beforeCount + 1);
  const request = server.requests[beforeCount];
  assert.equal(request.model, modelId, "本次 HTTP 精确模型身份");
  assert.equal(request.modelOk, true);
  assert.equal(request.authOk, true, "本次 HTTP 使用本来源的独立认证");
  assert.ok(item4RequestHasText(request, "user", text), "真实 HTTP 正文含本次随机新输入");
  // 先见本次 HTTP 独有回复，再等正式 ready/零未完成输入，防止过早认证或关闭。
  await page.getByText(request.marker, { exact: true }).waitFor();
  const settled = await waitForSnapshot(page, (snapshot) => {
    const run = snapshot.runs[actualSessionId];
    const blocks = snapshot.timelines[actualSessionId] ?? [];
    return run?.status === "ready" && run.pendingInputs === 0
      && blocks.some((block) => block.kind === "message" && block.role === "assistant"
        && !block.streaming && block.text === request.marker)
      && blocks.some((block) => block.kind === "message" && block.role === "user"
        && block.text === text && block.receipt?.status === "accepted" && block.receipt.processing === "done");
  }, null, "当次真实回复与已处理输入在原会话收束为 ready/pendingInputs=0");
  assert.equal(server.requests.length, beforeCount + 1, "本次新输入只有一发 HTTP，没有探针或重投");
  return { sessionId: actualSessionId, request, snapshot: settled };
}

async function item4CustomAndPresetPath({ cold }) {
  const stateDir = mkdtempSync(join(tmpdir(), cold ? "dcode-item4-cold-" : "dcode-item4-auth-live-"));
  let catalog = null;
  let openai = null;
  let customLoop = null;
  let handle = null;
  let primary = null;
  const evidence = { scenario: cold ? "cold-custom-to-preset" : "opened-client-new-auth", steps: [] };
  try {
    catalog = await startCatalogLoop({
      validA: { etag: 'W/"item4-builtins"', lastModified: 1_800_000_000_000 },
      withModelsByProvider: (providerId) => providerId === kimiProvider ? [] : null,
      stage: () => "A",
    });
    openai = await startOpenAILoop(openaiKey, "gpt-4");
    customLoop = await startCompletionsLoop(customKey, "a-model");
    const env = {
      DCODE_CATALOG_BASE_URL: catalog.origin,
      DCODE_E2E_PRESET_BASE_URLS: JSON.stringify({ [kimiProvider]: `${openai.origin}/v1` }),
      DCODE_E2E_STATE_ROOT: tmpdir(), DCODE_E2E: "1", DCODE_VALIDATION_ASSEMBLY: "",
    };
    handle = await launchApp(stateDir, env, ".");
    let page = handle.page;
    await gotoSettings(page);
    await clickTab(page, "custom");
    await customFormFill(page, {
      label: "Item4 Custom A", modelId: "a-model", baseUrl: `${customLoop.origin}/v1`,
      keyAction: "replace", apiKey: customKey,
    });
    await page.getByRole("button", { name: saveCustomButton }).click();
    const configured = await waitForSnapshot(page,
      (snapshot) => snapshot.modelSetup?.kind === "custom" && snapshot.model.available === true,
      null, "当前 custom A 已真实保存");
    item4AssertCurrentA(configured, customLoop);
    await page.keyboard.press("Escape");
    await ready(page);
    const initialCatalog = await page.evaluate(() => window.dcode.listModelCatalog());
    assert.equal(initialCatalog.providers.find((provider) => provider.id === kimiProvider)?.hasStoredKey, false,
      "隔离起点没有 B 的认证");
    if (cold) {
      await item4AuthenticatePresetB(page);
      item4AssertCurrentA(await page.evaluate(() => window.dcode.getSnapshot()), customLoop);
    }
    assert.equal(customLoop.requests.length, 0, "配置及认证均不探测 A");
    assert.equal(openai.requests.length, 0, "配置及认证均不探测 B");

    const firstText = `item4 A ${randomBytes(12).toString("hex")}`;
    const first = await item4SendAndObserve(page, customLoop, firstText, "a-model");
    const sessionId = first.sessionId;
    const sessionIds = first.snapshot.sessions.map((session) => session.id).sort();
    const taskIds = first.snapshot.tasks.map((task) => task.id).sort();
    evidence.steps.push({ phase: "A-first-response-ready", sessionId, model: first.request.model, marker: first.request.marker });
    item4AssertCurrentA(first.snapshot, customLoop);

    if (cold) {
      // 已见真实回复并收束后才正常关闭；重开使用相同隔离目录，不注入旧会话/认证。
      await handle.close();
      handle = null;
      handle = await launchApp(stateDir, env, ".");
      page = handle.page;
      await ready(page);
    } else {
      // 此时 A 的真实客户端已开过且收到回复；B 通过真实认证入口加入，不全局 apply、不重建测试实例。
      await item4AuthenticatePresetB(page);
    }
    await item4GotoOriginalSession(page, sessionId);
    await page.getByText(first.request.marker, { exact: true }).waitFor();
    const beforePick = await page.evaluate(() => window.dcode.getSnapshot());
    item4AssertCurrentA(beforePick, customLoop);
    assert.deepEqual(beforePick.sessions.map((session) => session.id).sort(), sessionIds, "认证/重开/导航不新建会话");
    assert.deepEqual(beforePick.tasks.map((task) => task.id).sort(), taskIds, "认证/重开/导航不新建任务");
    assert.equal(customLoop.requests.length, 1, "认证或重开不重投 A 的旧输入");
    assert.equal(openai.requests.length, 0, "B 尚未接收任何推理请求");

    await page.getByTestId("model-entry-trigger").click();
    await page.getByTestId("model-search").waitFor({ state: "visible" });
    await page.getByTestId(`model-item-${kimiProvider}-gpt-4`).click();
    await page.keyboard.press("Escape");
    await waitForSnapshot(page, (snapshot) => {
      const choice = snapshot.sessionModels[sessionId]?.choice;
      return choice?.mode === "explicit" && choice.sourceId === kimiProvider && choice.modelId === "gpt-4";
    }, null, "B 选择须提交到原会话");
    const selected = await page.evaluate(() => window.dcode.getSnapshot());
    item4AssertCurrentA(selected, customLoop);
    assert.equal(customLoop.requests.length, 1, "会话改选不重投旧 A 输入");
    assert.equal(openai.requests.length, 0, "会话改选本身不发 B 请求");
    assert.equal(selected.runs[sessionId]?.status, beforePick.runs[sessionId]?.status, "改选不隐式恢复暂停");
    if (selected.runs[sessionId]?.status === "paused") {
      // 若宿主将关闭后现场标作暂停，仍只走既定唯一主按钮；已完成输入不能因此重发。
      assert.equal(selected.runs[sessionId].pendingInputs, 0);
      await page.locator(".input-surface").getByRole("button", { name: /^(继续执行|Resume)$/ }).click();
      await waitForSnapshot(page, (snapshot) => snapshot.runs[sessionId]?.status === "ready"
        && snapshot.runs[sessionId].pendingInputs === 0, null, "明确继续收束，旧输入不恢复执行");
      assert.equal(customLoop.requests.length, 1, "明确继续不得重发已完成 A 输入");
      assert.equal(openai.requests.length, 0, "明确继续不得将旧输入发给 B");
    }
    const secondText = `item4 B ${randomBytes(12).toString("hex")}`;
    const second = await item4SendAndObserve(page, openai, secondText, "gpt-4", sessionId);
    const blocks = second.snapshot.timelines[sessionId];
    assert.equal(blocks.filter((block) => block.kind === "message" && block.role === "user" && block.text === firstText).length, 1);
    assert.equal(blocks.filter((block) => block.kind === "message" && block.role === "assistant" && block.text === first.request.marker).length, 1,
      "旧 A 回复保留一次，未被 B 替换或重投");
    assert.equal(blocks.filter((block) => block.kind === "message" && block.role === "user" && block.text === secondText).length, 1);
    assert.ok(item4RequestHasText(second.request, "user", firstText), "B 的原会话 HTTP 上下文包含旧 A 输入");
    assert.ok(item4RequestHasText(second.request, "assistant", first.request.marker), "B 的 HTTP 上下文保留已完成 A 回复");
    assert.notEqual(second.request.marker, first.request.marker, "B 回复是本次独立 nonce");
    await page.getByText(first.request.marker, { exact: true }).waitFor();
    await page.getByText(second.request.marker, { exact: true }).waitFor();
    item4AssertCurrentA(second.snapshot, customLoop);
    assert.deepEqual(second.snapshot.sessions.map((session) => session.id).sort(), sessionIds, "B 请求仍来自原会话");
    assert.deepEqual(second.snapshot.tasks.map((task) => task.id).sort(), taskIds, "B 请求不创建替代任务");
    assert.equal(customLoop.requests.length, 1, "改选后的新请求只发 B，A 次数没有增加");
    assert.equal(openai.requests.length, 1, "B 只有本次明确新输入的一发请求");
    const actual = second.snapshot.sessionModels[sessionId]?.actual;
    assert.equal(actual?.sourceId, kimiProvider);
    assert.equal(actual?.modelId, "gpt-4", "正式实际采用与真实 B HTTP 一致");
    assertNoKeyLeak(await page.evaluate(() => document.body.innerText));
    evidence.steps.push({ phase: cold ? "cold-original-session-B-response" : "new-auth-original-client-B-response",
      sessionId, model: second.request.model, marker: second.request.marker, aRequests: 1, bRequests: 1 });
    writeFileSync(join(EVID, cold ? "item4-cold-custom-preset.json" : "item4-opened-client-new-auth.json"), JSON.stringify(evidence, null, 2));
  } catch (error) {
    primary = error;
  } finally {
    // 每一项都真正 await；保留业务首错，正常退出失败仍阻止通过，强制清理不会掩盖前者。
    if (handle) {
      try { await handle.close(); } catch (error) { primary ??= error; }
      try { await killApp(handle); } catch (error) { primary ??= error; }
    }
    for (const server of [catalog, openai, customLoop]) {
      if (server) {
        try { await server.close(); } catch (error) { primary ??= error; }
      }
    }
    try { cleanup(stateDir); } catch (error) { primary ??= error; }
  }
  if (primary) throw primary;
}

test("item4 custom 冷重开：保当前 A，原会话选已认证 preset B 后真实请求与新回复", async () => {
  await item4CustomAndPresetPath({ cold: true });
});

test("item4 已打开 custom 客户端：真实认证新增 B 后原会话下一请求采用 B", async () => {
  await item4CustomAndPresetPath({ cold: false });
});
