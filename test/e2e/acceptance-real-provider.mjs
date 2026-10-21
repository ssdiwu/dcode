// D Code 首条完整路径 · 完整闭环验收（真实服务商 + 可见界面）
//
// 人工验收驱动：需要已配置真实服务商的普通数据目录与可见窗口；
// 不是自���用例的一部分（不进 *.test.mjs），按需手动运行。
//
// 隔离：仓库内只留可复现的母本 test/fixtures/acceptance-project/；
// 验收时复制到仓库外的独立目录，智能体在里面改代码不会看到 D Code 自身的改动。
// 覆盖：草稿态模型入口 → 点名模型 → 建会话 → 设思考档位 → 发送 → 工具执行 →
//       文件改动块 → 打开差异 → 追问 → 暂停 → 关闭 → 重开只读 → 显式继续。
import { createRequire } from "node:module";
import { cpSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { _electron: electron } = require("playwright-core");
const electronBinary = require("electron");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STATE_DIR = `${process.env.HOME}/Library/Application Support/D Code Development`;
const MATER = join(ROOT, "test", "fixtures", "acceptance-project");
const LOG = join(tmpdir(), "dcode-acceptance-stderr.log");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 验收项目复制到仓库外：真正隔离
const PROJECT = join(tmpdir(), "dcode-acceptance-project");
rmSync(PROJECT, { recursive: true, force: true });
cpSync(MATER, PROJECT, { recursive: true });
console.log("[closure] 验收项目已复制到仓库外：", PROJECT);

writeFileSync(LOG, "");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.DCODE_VALIDATION_ASSEMBLY;

const app = await electron.launch({
  executablePath: electronBinary,
  args: [`--user-data-dir=${join(STATE_DIR, "userdata")}`, "."],
  cwd: ROOT,
  env: { ...env, DCODE_E2E: "1", DCODE_E2E_VISIBLE: "1", DCODE_STATE_DIR: STATE_DIR, NODE_ENV: "production" },
});
const proc = app.process();
proc.stderr?.on("data", (d) => writeFileSync(LOG, String(d), { flag: "a" }));
const page = await app.firstWindow();
page.setDefaultTimeout(30000);
await page.getByText("D Code", { exact: false }).first().waitFor({ timeout: 30000 });
await wait(1500);

// 预置工作空间（绑定仓库外的隔离项目）
const statePath = join(STATE_DIR, "dcode-prototype-state.json");
const state = JSON.parse(readFileSync(statePath, "utf8"));
state.workspaces = state.workspaces.filter((w) => w.id !== "ws-acceptance");
state.tasks = state.tasks.filter((t) => t.workspaceId !== "ws-acceptance");
state.workspaces.push({ id: "ws-acceptance", name: "验收项目", folders: [PROJECT], builtinHome: false, defaultTaskId: "task-acceptance-default" });
state.tasks.push({ id: "task-acceptance-default", workspaceId: "ws-acceptance", parentId: null, kind: "long", title: "默认任务", boundFolder: null, isDefault: true, updatedAt: Date.now() });
state.settings.modelCandidates = [{ sourceId: "minimax-cn", modelId: "MiniMax-M3.1-Flash" }];
state.modelCandidateScopeConfigured = true;
state.sessions = []; state.timelines = {}; state.runs = {}; state.sessionModels = {};
state.pendingFirstSends = {}; state.runtimeCreationPending = [];
writeFileSync(statePath, JSON.stringify(state, null, 2));
rmSync(join(STATE_DIR, "runtime"), { recursive: true, force: true });

const snap = () => page.evaluate(() => window.dcode.getSnapshot()).catch(() => null);
const step = (name) => console.log(`[closure] ${name}`);

await page.getByText("验收项目", { exact: true }).first().click();
await wait(800);
await page.getByRole("button", { name: /在此空间新建任务/ }).first().click();
await wait(500);
await page.getByText("新工作草稿", { exact: true }).first().click();
await wait(1000);

// 1) 草稿态模型入口
const trigger = page.getByTestId("model-entry-trigger");
await trigger.waitFor({ state: "visible", timeout: 15000 });
step(`草稿态入口可点=${!(await trigger.isDisabled())}`);
await trigger.click();
await page.getByTestId("model-search").waitFor({ state: "visible", timeout: 15000 });

// 2) 两级浏览：来源 → 模型
await page.getByTestId("model-search").fill("MiniMax-M3.1-Flash");
await wait(400);
await page.locator('[data-testid^="model-source-"]').first().click();
await wait(200);
await page.locator('[data-testid$="minimax-cn-MiniMax-M3.1-Flash"]').first().click();
await wait(500);
step(`入口文字=${await trigger.innerText()}`);

// 3) 首次发送建会话（会拿到服务商的 400）
const area = page.locator("textarea").first();
await area.fill("先跑一次建立会话");
await area.press("Enter");
await wait(5000);

// 4) 会话内设思考档位
await trigger.click();
await page.getByTestId("model-search").waitFor({ state: "visible", timeout: 15000 });
const levels = page.locator('[data-testid^="model-level-"]');
step(`思考档位项数=${await levels.count()}`);
if (await page.getByTestId("model-level-low").count()) {
  await page.getByTestId("model-level-low").click();
  step("已选 low 档位");
}
await wait(400);
await page.keyboard.press("Escape");
await wait(400);

// 5) 发送真实需求
const requirement = "这个项目的 npm test 跑不过。请先读 AGENTS.md，按里面的约定把它修好，让测试全绿。改完把实际命令输出贴给我，并说明改了哪些文件、为什么这么改。";
await area.fill(requirement);
await area.press("Enter");
step("已发送");

// 6) 等工具执行与文件改动块
let changed = false;
for (let i = 1; i <= 60; i += 1) {
  await wait(5000);
  const s = await snap();
  if (!s) { step(`t+${i * 5}s 无响应`); break; }
  const blocks = Object.values(s.timelines ?? {}).flat();
  const tool = blocks.filter((b) => b.kind === "tool");
  const chg = blocks.filter((b) => b.kind === "change-summary");
  const run = Object.values(s.runs ?? {})[0];
  step(`t+${i * 5}s tool=${tool.length} change=${chg.length} run=${run?.status}/${run?.note ?? ""}`);
  if (chg.length > 0) { changed = true; break; }
}
step(`出现文件改动块=${changed}`);

// 7) 打开差异
// 时间线上的改动聚合入口是带 data-block-id 的按钮
const diffCard = page.locator("button[data-block-id]").first();
if (await diffCard.count()) {
  await diffCard.click();
  await wait(1500);
  step("已打开差异视图");
  const diffText = await page.locator("body").innerText();
  step("差异视图含文件名=" + /money\.js|invoice\.js/.test(diffText));
} else {
  step("未找到改动入口");
}
await page.screenshot({ path: join(ROOT, "test", "e2e", "evidence", "runs", "acceptance-2026-10-21", "17-差异视图.png") });

// 8) 追问
const area2 = page.locator("textarea").first();
await area2.fill("你改了哪些文件？为什么这样改？");
await area2.press("Enter");
step("已追问");
for (let i = 1; i <= 24; i += 1) {
  await wait(5000);
  const s = await snap();
  if (!s) break;
  const blocks = Object.values(s.timelines ?? {}).flat();
  const assistant = blocks.filter((b) => b.kind === "message" && b.role === "assistant");
  step(`追问 t+${i * 5}s assistant=${assistant.length}`);
  if (i >= 2) break;
}
await page.screenshot({ path: join(ROOT, "test", "e2e", "evidence", "runs", "acceptance-2026-10-21", "18-追问.png") });

// 9) 暂停
const pause = page.getByRole("button", { name: /^暂停$|^Pause$/ });
if (await pause.count()) {
  await pause.first().click();
  await wait(3000);
  const s = await snap();
  step(`暂停后 run=${JSON.stringify(Object.values(s?.runs ?? {})[0])}`);
  await page.screenshot({ path: join(ROOT, "test", "e2e", "evidence", "runs", "acceptance-2026-10-21", "19-暂停.png") });
} else {
  step("未找到暂停入口");
}

// 10) 关闭 → 重开只读 → 显式继续
await app.close().catch(() => {});
await wait(2000);
step("已关闭应用");
const app2 = await electron.launch({
  executablePath: electronBinary,
  args: [`--user-data-dir=${join(STATE_DIR, "userdata")}`, "."],
  cwd: ROOT,
  env: { ...env, DCODE_E2E: "1", DCODE_E2E_VISIBLE: "1", DCODE_STATE_DIR: STATE_DIR, NODE_ENV: "production" },
});
const page2 = await app2.firstWindow();
page2.setDefaultTimeout(30000);
await page2.getByText("D Code", { exact: false }).first().waitFor({ timeout: 30000 });
await wait(3000);
const s2 = await page2.evaluate(() => window.dcode.getSnapshot()).catch(() => null);
const blocks2 = Object.values(s2?.timelines ?? {}).flat();
step(`重开后 blocks=${blocks2.length}（只读回看原运行）`);
await page2.screenshot({ path: join(ROOT, "test", "e2e", "evidence", "runs", "acceptance-2026-10-21", "20-重开只读.png") });
const cont = page2.getByRole("button", { name: /^继续执行$|^Resume$|^继续$/ });
if (await cont.count()) {
  await cont.first().click();
  await wait(3000);
  step("已点显式继续");
  await page2.screenshot({ path: join(ROOT, "test", "e2e", "evidence", "runs", "acceptance-2026-10-21", "21-显式继续.png") });
} else {
  step("未找到显式继续入口");
}

console.log("[closure] stderr 尾部:\n" + readFileSync(LOG, "utf8").split("\n").slice(-10).join("\n"));
await app2.close().catch(() => {});
process.exit(0);
