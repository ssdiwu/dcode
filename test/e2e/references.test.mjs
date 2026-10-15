// C05 引用入口的完整动作证据（真实 Pi Durable + 受控模型，后台隐藏、不抢焦点）：
//
//  发现 → 捕获 → 添加/去重 → 移除 → 真正发送 → 受控模型实际收到的请求里含随机文件内容
//  与技能正文 → 回到正规历史与接收结果。
//
//  · 工作空间根是本文件自建的隔离夹具目录，绝不指向真实工程或用户目录；
//  · 不连真实服务商、不用真实凭据；受控模型只在自己的 demoDir 里写观测文件；
//  · 内容参与的直接证据来自 demoDir/model-requests.jsonl 里记录的**实际用户消息**，
//    不看界面自述，也不靠端口返回值代替界面动作。

import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchApp, assertValidationModel, ready, waitForSnapshot } from "./helpers.mjs";

// 每次运行都换新随机标记：证明进请求的是本次读到的真实内容，而不是固定夹具串。
const FILE_MARKER = `FILE-CONTENT-${randomBytes(6).toString("hex")}`;
const SKILL_MARKER = `SKILL-BODY-${randomBytes(6).toString("hex")}`;
const USER_TEXT = "按这两个引用继续。";

function workspaceFixture() {
  const root = mkdtempSync(join(tmpdir(), "dcode-ref-ws-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "greet.js"), `export const marker = "${FILE_MARKER}";\n`);
  mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(root, "node_modules", "dep", "index.js"), "module.exports='IGNORED';");
  mkdirSync(join(root, ".pi", "skills", "e2e-skill"), { recursive: true });
  writeFileSync(
    join(root, ".pi", "skills", "e2e-skill", "SKILL.md"),
    `---\nname: e2e-skill\ndescription: 端到端用例的受控技能\n---\n\n${SKILL_MARKER}\n`,
  );
  return root;
}

/** 预置状态：工作空间绑定隔离夹具目录。形状与真实持久化状态一致（runs 也要合法，
 *  否则整份快照会被接收侧拒绝——这是产品校验，不为夹具放宽）。 */
function seedState(stateDir, workspaceRoot) {
  const now = Date.now();
  writeFileSync(
    join(stateDir, "dcode-prototype-state.json"),
    JSON.stringify({
      workspaces: [{ id: "ws-ref", name: "引用夹具", folders: [workspaceRoot], builtinHome: false, defaultTaskId: "task-ref" }],
      tasks: [{ id: "task-ref", workspaceId: "ws-ref", parentId: null, kind: "long", title: "引用任务", boundFolder: null, isDefault: false, updatedAt: now }],
      sessions: [{ id: "session-ref", taskId: "task-ref", title: "引用会话", kind: "main", updatedAt: now }],
      // 一条前置助手消息：空时间线的会话按产品设计渲染的是草稿态（没有输入 dock）。
      // 这是"这是一个真实会话"的常规前提，不用来遮盖本次发送的新稿引用判据——
      // 本次引用发送仍是该会话的第一条用户消息。
      timelines: {
        "session-ref": [{ kind: "message", id: "msg-seed", role: "assistant", text: "前置会话内容。", streaming: false, at: now }],
      },
      runs: { "session-ref": { sessionId: "session-ref", status: "ready", note: "", pendingInputs: 0, updatedAt: now } },
      settings: { theme: "light", fontSize: 14, coldStart: "restore", language: "zh" },
      pendingFirstSends: {},
    }, null, 2),
  );
}

/**
 * 确保浮层已展开。选中后面板**按设计保持打开**（便于连续添加多个引用），
 * 因此不能再点触发器——那会把它关掉。这里只在确实关闭时点一次。
 */
async function ensurePanelOpen(page) {
  const panel = page.locator('[data-slot="composer-references-panel"]');
  // 判断"是否已展开"用**是否已挂载**，不用 isVisible：隐藏窗口里已渲染的元素也可能被判不可见，
  // 那样会再点一次触发器把面板关掉——那是测试自己制造的失败，不是产品行为。
  if ((await panel.count()) > 0) return;
  const trigger = page.locator('[data-slot="composer-references-trigger"]');
  await trigger.waitFor({ state: "attached", timeout: 20_000 });
  const before = await trigger.evaluate((el) => ({ disabled: el.disabled, tag: el.tagName }));
  await trigger.click({ force: true });
  try {
    await panel.waitFor({ timeout: 6000 });
  } catch (error) {
    const probe = await page.evaluate(() => ({
      panelCount: document.querySelectorAll('[data-slot="composer-references-panel"]').length,
      triggerCount: document.querySelectorAll('[data-slot="composer-references-trigger"]').length,
      chipCount: document.querySelectorAll('[data-slot="reference-chip"]').length,
      dock: Boolean(document.querySelector('[data-slot="composer-dock"]')),
      formCount: document.querySelectorAll('form').length,
    }));
    throw new Error(`触发器点击后浮层未挂载：before=${JSON.stringify(before)} probe=${JSON.stringify(probe)}`, { cause: error });
  }
}

/** 隐藏窗口下 Playwright 的可点击性检查拿不到命中目标；项目既有约定是 force 点击。 */
async function clickHidden(locator) {
  await locator.waitFor({ state: "visible", timeout: 20_000 });
  await locator.click({ force: true });
}

/**
 * 展开侧栏树节点并核对 aria-expanded（focus-frames.mjs 的既有约定）：
 * 点击后若仍未展开，最多再点两次并每次等真实状态变化，不靠固定时长猜。
 */
async function expandRow(page, name) {
  const row = page.getByRole("treeitem", { name });
  await row.waitFor({ state: "visible", timeout: 20_000 });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if ((await row.getAttribute("aria-expanded")) === "true") return;
    await row.hover({ force: true });
    await row.click({ force: true });
    await page.waitForFunction(
      (n) => {
        const el = [...document.querySelectorAll('[role="treeitem"]')].find((item) => item.textContent?.includes(n));
        return el?.getAttribute("aria-expanded") === "true";
      },
      name,
      { timeout: 5_000 },
    ).catch(() => undefined);
  }
  throw new Error(`侧栏节点未展开：${name}`);
}

/**
 * 受控模型实际收到的每一条用户内容记录，**按记录返回**（一条记录 = 一次请求里的全部内容块）。
 * 不 flatten：flatten 后就分不清标记来自同一次请求还是来自更早/更晚的另一次请求。
 */
function userContentRecords(demoDir) {
  const log = join(demoDir, "model-requests.jsonl");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => {
    const content = JSON.parse(line).userContent;
    if (typeof content === "string") return [content];
    return Array.isArray(content) ? content.map((block) => block?.text ?? "") : [];
  });
}

/**
 * 等这条用户消息拿到 accepted 回执，并核对草稿里的引用随之清空。
 * 失败时把**真实现场**带出来：完整时间线块（含回执与引用）、输入区现状、界面提示文案、
 * 以及受控模型实际收到的请求——不靠"等不到就换个断言写法"掩盖原因。
 */
async function waitForAccepted(page, demoDir) {
  const accepted = (snapshot) =>
    snapshot.timelines["session-ref"]?.find((b) => b.kind === "message" && b.role === "user" && b.receipt?.status === "accepted");
  try {
    const snapshot = await waitForSnapshot(page, (s) => Boolean(accepted(s)), undefined, "__pending__");
    await page.waitForFunction(() => document.querySelector('[data-slot="composer-references"]') === null, { timeout: 20_000 });
    return snapshot;
  } catch (error) {
    // getSnapshot() 返回 Promise：必须 await 之后再读字段，否则拿到的是 Promise 自身
    const dump = await page.evaluate(async () => {
      const s = await window.dcode.getSnapshot();
      return {
        keys: Object.keys(s ?? {}),
        sessions: s?.sessions?.map((x) => x.id) ?? null,
        timeline: s?.timelines?.["session-ref"] ?? null,
        runs: s?.runs ?? null,
        note: document.querySelector('[data-slot="composer-note"]')?.textContent ?? null,
        draft: document.querySelector("textarea")?.value ?? null,
        chips: [...document.querySelectorAll("[data-slot=reference-chip]")].map((el) => el.getAttribute("data-locator")),
      };
    });
    throw new Error(
      `未等到 accepted 回执：keys=${JSON.stringify(dump.keys)} sessions=${JSON.stringify(dump.sessions)} ` +
        `timeline=${JSON.stringify(dump.timeline)} runs=${JSON.stringify(dump.runs)} ` +
        `note=${JSON.stringify(dump.note)} draft=${JSON.stringify(dump.draft)} chips=${JSON.stringify(dump.chips)} ` +
        `modelRequestCount=${userContentRecords(demoDir).length}`,
      { cause: error },
    );
  }
}

async function enterReferenceSession(page) {
  await expandRow(page, "引用夹具");
  await expandRow(page, "引用任务");
  await clickHidden(page.getByRole("treeitem", { name: "引用会话" }));
  // 等**真实的时间线内容**出现再交互：快照到达前视图会在草稿态/时间线之间切换，
  // Composer 随之重挂载（引用面板的展开状态会复位）。这里等的是实际消息，不是固定时长。
  await page.getByText("前置会话内容。", { exact: true }).waitFor({ timeout: 20_000 });
  await page.locator('[data-slot="composer-references-trigger"]').waitFor({ timeout: 20_000 });
}

test("C05 完整路径：真实工作空间文件与已接技能可发现、选取、去重、移除，发送后正文进入真实 Pi 请求与历史", { timeout: 180000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "dcode-ref-root-"));
  const demoDir = join(root, "demo");
  const stateDir = join(root, "state");
  mkdirSync(demoDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const workspaceRoot = workspaceFixture();
  seedState(stateDir, workspaceRoot);

  const handle = await launchApp(stateDir, { DCODE_VALIDATION_ASSEMBLY: "pi-controlled", DCODE_DEMO_DIR: demoDir, DCODE_PI_GATE: "1" });
  const { page, close } = handle;
  try {
    const snap0 = await page.evaluate(() => window.dcode.getSnapshot());
    assert.equal(snap0.execution?.kind, "pi", "装配必须是真实 Pi 执行端");
    await assertValidationModel(page);
    // 先导航再等就绪：预置状态只有一棵折叠的侧栏树，ready() 的正文长度判据此时尚未成立。
    await enterReferenceSession(page);
    await ready(page);

    // 浏览不执行：打开入口之前受控模型一次请求都没有
    assert.equal(userContentRecords(demoDir).length, 0, "进入会话本身不得向模型发请求");

    // 打开「＋」：浮层向上展开，列出真实文件与已接技能
    await clickHidden(page.locator('[data-slot="composer-references-trigger"]'));
    await ensurePanelOpen(page);
    const panel = page.locator('[data-slot="composer-references-panel"]');
    const panelBox = await panel.boundingBox();
    const triggerBox = await page.locator('[data-slot="composer-references-trigger"]').boundingBox();
    assert.ok(panelBox && triggerBox, "浮层与入口都应有真实几何");
    assert.ok(panelBox.y + panelBox.height <= triggerBox.y + 1, "引用浮层必须向上展开，不得盖住输入行");

    try {
      await page.locator('[data-slot="reference-option"][data-locator="r0/src/greet.js"]').waitFor({ timeout: 8000 });
    } catch (error) {
      const dump = await page.evaluate(() => {
        const panel = document.querySelector('[data-slot="composer-references-panel"]');
        return {
          text: panel?.innerText?.slice(0, 400) ?? "<no panel>",
          options: [...document.querySelectorAll("[data-slot=reference-option]")].map((el) => el.getAttribute("data-locator")),
          box: panel ? panel.getBoundingClientRect().toJSON() : null,
        };
      });
      throw new Error(`引用项未出现：${JSON.stringify(dump)}`, { cause: error });
    }
    await page.locator('[data-slot="reference-option"][data-kind="skill"]').first().waitFor({ timeout: 20_000 });
    // 文件根范围：依赖目录不作为可引用文件出现
    assert.equal(await page.locator('[data-slot="reference-option"][data-locator^="r0/node_modules/"]').count(), 0, "依赖目录不得进入可引用文件");

    // 选取文件 → 出现可移除引用项；不自动发送
    await clickHidden(page.locator('[data-slot="reference-option"][data-locator="r0/src/greet.js"]'));
    await page.locator('[data-slot="reference-chip"][data-kind="file"]').waitFor({ timeout: 20_000 });
    assert.equal(await page.locator("textarea").inputValue(), "", "引用不改写用户原文字");

    // 重复选择同一文件：去重，不产生第二枚
    await ensurePanelOpen(page);
    await clickHidden(page.locator('[data-slot="reference-option"][data-locator="r0/src/greet.js"]'));
    await page.waitForTimeout(400);
    assert.equal(await page.locator('[data-slot="reference-chip"]').count(), 1, "同一文件不应重复引用");

    // 移除后重加技能与文件，写真实文字后发送
    await clickHidden(page.locator('[data-slot="reference-remove"]').first());
    await page.waitForTimeout(300);
    assert.equal(await page.locator('[data-slot="reference-chip"]').count(), 0);

    await ensurePanelOpen(page);
    await clickHidden(page.locator('[data-slot="reference-option"][data-locator="r0/src/greet.js"]'));
    await page.locator('[data-slot="reference-chip"][data-kind="file"]').waitFor({ timeout: 20_000 });
    await ensurePanelOpen(page);
    await clickHidden(page.locator('[data-slot="reference-option"][data-kind="skill"]').first());
    await page.locator('[data-slot="reference-chip"][data-kind="skill"]').waitFor({ timeout: 20_000 });
    assert.equal(await page.locator('[data-slot="reference-chip"]').count(), 2, "文件与技能各一枚引用");

    // 浏览/选取/去重/移除全程不执行：受控模型仍一次请求都没有，只有正式发送才进入请求
    assert.equal(userContentRecords(demoDir).length, 0, "浏览、选取、去重与移除都不得触发模型请求");

    // 会话内的占位文案是 timeline.followupPlaceholder（草稿态才是 draft.composerPlaceholder）
    const composer = page.getByPlaceholder("追问、补充或纠正…");
    await composer.fill(USER_TEXT);
    await composer.press("Enter");

    // 已接收后草稿清空（引用一并带走）
    await waitForAccepted(page, demoDir);

    // 历史关联：用户原文字原样保留，引用身份与快照元数据独立留存
    const snap = await waitForSnapshot(page, (s, sid) => {
      const block = s.timelines[sid].find((b) => b.kind === "message" && b.role === "user" && b.receipt?.status === "accepted");
      return block ? Array.isArray(block.references) && block.references.length === 2 : false;
    }, "session-ref");
    const userBlock = snap.timelines["session-ref"].find((b) => b.kind === "message" && b.role === "user" && b.receipt?.status === "accepted");
    assert.equal(userBlock.text, USER_TEXT, "用户原文字原样保留，不被引用改写");
    assert.deepEqual(userBlock.references.map((r) => r.kind).sort(), ["file", "skill"]);
    for (const ref of userBlock.references) {
      assert.match(ref.snapshot.contentHash, /^[0-9a-f]{64}$/, "历史留存快照身份");
      assert.equal(ref.snapshot.content, undefined, "历史不留引用正文");
    }

    // 直接证据：**同一条**实际用户内容记录里同时含用户原文字与两条引用正文。
    // 只在同一记录内核，才能排除"标记来自不同或更早请求"的假成立。
    const deadline = Date.now() + 30_000;
    let records = [];
    let record = null;
    while (Date.now() < deadline) {
      records = userContentRecords(demoDir);
      record = records.find((blocks) =>
        blocks.includes(USER_TEXT)
        && blocks.some((text) => text.includes(FILE_MARKER))
        && blocks.some((text) => text.includes(SKILL_MARKER)));
      if (record) break;
      await new Promise((resolve) => { setTimeout(resolve, 100); });
    }
    assert.ok(record, `同一条实际用户内容记录里应同时含原文字与两条引用正文（现有 ${records.length} 条记录）`);
    assert.equal(record.filter((text) => text === USER_TEXT).length, 1, "用户原文字作为独立内容块原样送达一次");
    const fileBlock = record.find((text) => text.includes(FILE_MARKER));
    const skillBlock = record.find((text) => text.includes(SKILL_MARKER));
    assert.ok(fileBlock.includes(FILE_MARKER), "文件块含本次随机读到的真实内容");
    assert.ok(skillBlock.includes(SKILL_MARKER), "技能块含本次随机读到的技能正文");
    // 内容块不得互相吞并：引用块带来源与快照身份，用户原文字块里不含引用正文
    assert.equal(fileBlock.includes(USER_TEXT), false, "引用内容不得与用户原文字拼成同一块");
    assert.equal(skillBlock.includes(USER_TEXT), false, "技能内容不得与用户原文字拼成同一块");
    // 块数与内容块身份绑定历史：两条引用各自成块
    assert.equal(record.length, 3, `一次发送应是 1 条原文字 + 2 条引用共 3 个内容块，实得 ${record.length}`);
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});
/**
 * 预置状态按侧栏的真实语义分两路：
 *  · 「新任务草稿」这个任务**没有任何会话**——点它才进入草稿态（点有会话的任务会选中首个会话）；
 *  · 「空会话任务」下有一个**空时间线**会话，渲染的是草稿态输入区，但归属是已有会话。
 * 两种草稿各自走一次真实的引用发现→选取→发送，不靠填旧历史把输入区变成会话形态。
 */
function seedDraftState(stateDir, workspaceRoot) {
  const now = Date.now();
  writeFileSync(
    join(stateDir, "dcode-prototype-state.json"),
    JSON.stringify({
      workspaces: [{ id: "ws-draft", name: "草稿夹具", folders: [workspaceRoot], builtinHome: false, defaultTaskId: "task-new" }],
      tasks: [
        { id: "task-new", workspaceId: "ws-draft", parentId: null, kind: "long", title: "新任务草稿", boundFolder: null, isDefault: false, updatedAt: now },
        { id: "task-empty", workspaceId: "ws-draft", parentId: null, kind: "long", title: "空会话任务", boundFolder: null, isDefault: false, updatedAt: now },
      ],
      sessions: [{ id: "session-empty", taskId: "task-empty", title: "空会话", kind: "main", updatedAt: now }],
      timelines: {},
      runs: {},
      settings: { theme: "light", fontSize: 14, coldStart: "restore", language: "zh" },
      pendingFirstSends: {},
    }, null, 2),
  );
}

test("C05 新任务草稿与空会话：引用入口按各自归属接通，浏览不发送，发送后正文进入真实请求", { timeout: 180000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "dcode-ref-draft-"));
  const demoDir = join(root, "demo");
  const stateDir = join(root, "state");
  mkdirSync(demoDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const workspaceRoot = workspaceFixture();
  seedDraftState(stateDir, workspaceRoot);

  const handle = await launchApp(stateDir, { DCODE_VALIDATION_ASSEMBLY: "pi-controlled", DCODE_DEMO_DIR: demoDir, DCODE_PI_GATE: "1" });
  const { page, close } = handle;
  try {
    const snap0 = await page.evaluate(() => window.dcode.getSnapshot());
    assert.equal(snap0.execution?.kind, "pi", "装配必须是真实 Pi 执行端");
    await assertValidationModel(page);
    await expandRow(page, "草稿夹具");
    await ready(page);

    // ---------- 新任务草稿：任务下没有任何会话，输入区按 taskId 归属 ----------
    await clickHidden(page.getByRole("treeitem", { name: "新任务草稿" }));
    const draftTrigger = page.locator('[data-slot="composer-references-trigger"]');
    await draftTrigger.waitFor({ timeout: 20_000 });
    assert.equal(await draftTrigger.isDisabled(), false, "新任务草稿的「＋」必须可用，不能因为没有会话就禁用");
    assert.equal(await page.locator('[data-slot="composer-dock"]').count(), 0, "新任务草稿渲染的是草稿态输入区");
    const draftComposer = page.locator("textarea");
    await draftComposer.waitFor({ timeout: 20_000 });
    assert.equal(await draftComposer.getAttribute("placeholder"), "交代需求、提问或粘贴内容…", "新任务草稿渲染草稿态输入区");
    await clickHidden(draftTrigger);
    await ensurePanelOpen(page);
    await page.locator('[data-slot="reference-option"][data-locator="r0/src/greet.js"]').waitFor({ timeout: 20_000 });
    await clickHidden(page.locator('[data-slot="reference-option"][data-locator="r0/src/greet.js"]'));
    await page.locator('[data-slot="reference-chip"][data-kind="file"]').waitFor({ timeout: 20_000 });
    assert.equal(userContentRecords(demoDir).length, 0, "草稿态浏览与选取不得触发模型请求");

    const draftText = "草稿态带引用发送。";
    await draftComposer.fill(draftText);
    await draftComposer.press("Enter");
    // 首发会创建会话并接收；引用必须落在这一次真实请求里，且不是原有的空会话
    const draftSnap = await waitForSnapshot(page, (s) => Object.entries(s.timelines).some(([sid, blocks]) =>
      sid !== "session-empty" && blocks.some((b) =>
        b.kind === "message" && b.role === "user" && b.receipt?.status === "accepted"
        && b.references?.length === 1 && b.references[0].locator === "r0/src/greet.js")),
    "草稿态首发未拿到带引用的 accepted 回执");
    assert.equal((draftSnap.timelines["session-empty"] ?? []).length, 0, "草稿态首发不得写进原有的空会话");
    const draftBlock = Object.values(draftSnap.timelines).flat().find((b) =>
      b.kind === "message" && b.role === "user" && b.receipt?.status === "accepted" && b.references?.length === 1);
    assert.equal(draftBlock.text, draftText, "草稿态首发保留用户原文字");
    assert.equal(draftBlock.references[0].snapshot.content, undefined, "历史不留引用正文");

    // ---------- 空时间线会话：归属是已有会话，入口同样可用 ----------
    await expandRow(page, "空会话任务");
    await clickHidden(page.getByRole("treeitem", { name: "空会话", exact: true }));
    const emptyState = await page.evaluate(async () => {
      const s = await window.dcode.getSnapshot();
      return { sessions: s.sessions.map((x) => x.id), emptyBlocks: (s.timelines["session-empty"] ?? []).length };
    });
    assert.deepEqual(emptyState.emptyBlocks, 0, "空会话在发送前必须真的是空时间线");
    const emptyTrigger = page.locator('[data-slot="composer-references-trigger"]');
    await emptyTrigger.waitFor({ timeout: 20_000 });
    assert.equal(await emptyTrigger.isDisabled(), false, "空会话的「＋」必须可用");
    const requestsBeforeEmpty = userContentRecords(demoDir).length;
    await clickHidden(emptyTrigger);
    await ensurePanelOpen(page);
    await page.locator('[data-slot="reference-option"][data-kind="skill"]').first().waitFor({ timeout: 20_000 });
    await clickHidden(page.locator('[data-slot="reference-option"][data-kind="skill"]').first());
    await page.locator('[data-slot="reference-chip"][data-kind="skill"]').waitFor({ timeout: 20_000 });
    assert.equal(userContentRecords(demoDir).length, requestsBeforeEmpty, "空会话浏览与选取不得触发模型请求");

    // 草稿键按会话区分：切到空会话后，另一份草稿的引用不得跟着过来
    assert.equal(await page.locator('[data-slot="reference-chip"]').count(), 1, "空会话自己的草稿只有它那一枚引用");

    const emptyText = "空会话带引用发送。";
    const emptyComposer = page.locator("textarea");
    await emptyComposer.waitFor({ timeout: 20_000 });
    // 空时间线会话按设计同样渲染草稿态输入区（占位文案是草稿态那一份，不是会话内的追问文案）
    assert.equal(
      await emptyComposer.getAttribute("placeholder"),
      "交代需求、提问或粘贴内容…",
      `空会话应渲染草稿态输入区；实况=${JSON.stringify(emptyState)}`,
    );
    await emptyComposer.fill(emptyText);
    await emptyComposer.press("Enter");
    await waitForSnapshot(page, (s) => (s.timelines["session-empty"] ?? []).some((b) =>
      b.kind === "message" && b.role === "user" && b.receipt?.status === "accepted"
      && b.references?.length === 1 && b.references[0].kind === "skill"), "空会话发送未拿到带技能引用的 accepted 回执");

    // 两次发送各自一条请求记录，记录内原文字与引用内容同在。
    // 记录是受控模型**实际**写出的文件，等它落盘而不是读一次就算——否则全量跑时容易读到竞态。
    const findRecord = async (text, marker) => {
      const deadline = Date.now() + 15_000;
      for (;;) {
        const records = userContentRecords(demoDir);
        const hit = records.find((blocks) => blocks.includes(text) && blocks.some((t) => t.includes(marker)));
        if (hit) return hit;
        if (Date.now() >= deadline) return null;
        await new Promise((resolve) => { setTimeout(resolve, 100); });
      }
    };
    const draftRecord = await findRecord(draftText, FILE_MARKER);
    assert.ok(draftRecord, "草稿态那次请求的同一条记录里应同时有原文字与文件正文");
    const emptyRecord = await findRecord(emptyText, SKILL_MARKER);
    assert.ok(emptyRecord, "空会话那次请求的同一条记录里应同时有原文字与技能正文");
    // 严判：各是一条独立内容块，原文字不被引用改写或吞并
    for (const [label, record, text, marker] of [
      ["草稿态", draftRecord, draftText, FILE_MARKER],
      ["空会话", emptyRecord, emptyText, SKILL_MARKER],
    ]) {
      assert.equal(record.length, 2, `${label}那次请求应是 1 条原文字 + 1 条引用共 2 个内容块，实得 ${record.length}`);
      assert.equal(record.filter((block) => block === text).length, 1, `${label}的用户原文字作为独立内容块原样送达一次`);
      const referenceBlock = record.find((block) => block.includes(marker));
      assert.ok(referenceBlock.includes(marker), `${label}的引用块含本次随机读到的真实正文`);
      assert.equal(referenceBlock.includes(text), false, `${label}的引用内容不得与用户原文字拼成同一块`);
    }
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * 技能发现响应性的**应用内**证据：发现期间渲染层持续向主进程要快照，
 * 记录最慢一次往返。主进程被同步工作卡住时，这个往返会跟着变慢——
 * 只看"面板打开了"证明不了响应性，这里量的是真实交互期间的失联时长。
 */
function bigWorkspaceFixture(skills, files) {
  const root = mkdtempSync(join(tmpdir(), "dcode-ref-big-"));
  mkdirSync(join(root, ".pi", "skills"), { recursive: true });
  for (let i = 0; i < skills; i++) {
    const dir = join(root, ".pi", "skills", `skill-${String(i).padStart(4, "0")}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: skill-${i}\ndescription: 受控技能 ${i}\n---\n\n正文 ${"x".repeat(2000)}\n`);
  }
  for (let i = 0; i < files; i++) {
    const dir = join(root, "src", `m${Math.floor(i / 50)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `f${i}.ts`), `export const v${i} = ${i};\n`);
  }
  // 一个稳定定位的文件：在途用例用它做引用项
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "greet.js"), `export const marker = "${FILE_MARKER}";\n`);
  return root;
}

test("技能发现期间的响应性：面板打开期间主进程不失联，发现结果按规模如实呈现", { timeout: 180000 }, async () => {
  const SKILLS = 120;
  const FILES = 800;
  const root = mkdtempSync(join(tmpdir(), "dcode-ref-resp-"));
  const demoDir = join(root, "demo");
  const stateDir = join(root, "state");
  const workspaceRoot = bigWorkspaceFixture(SKILLS, FILES);
  mkdirSync(demoDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  seedState(stateDir, workspaceRoot);

  const handle = await launchApp(stateDir, { DCODE_VALIDATION_ASSEMBLY: "pi-controlled", DCODE_DEMO_DIR: demoDir, DCODE_PI_GATE: "1" });
  const { page, close } = handle;
  try {
    await enterReferenceSession(page);
    await ready(page);
    // 探测：发现期间持续要快照，记录最慢一次往返
    await page.evaluate(() => {
      window.__probe = { max: 0, samples: 0, running: true };
      const tick = async () => {
        if (!window.__probe.running) return;
        const started = performance.now();
        await window.dcode.getSnapshot();
        window.__probe.max = Math.max(window.__probe.max, performance.now() - started);
        window.__probe.samples += 1;
        setTimeout(() => { void tick(); }, 5);
      };
      void tick();
    });

    const opened = Date.now();
    await clickHidden(page.locator('[data-slot="composer-references-trigger"]'));
    await ensurePanelOpen(page);
    const elapsed = Date.now() - opened;
    await page.locator('[data-slot="reference-option"][data-kind="skill"]').first().waitFor({ timeout: 30_000 });
    const probe = await page.evaluate(() => { window.__probe.running = false; return window.__probe; });
    const listed = await page.evaluate(() => ({
      files: document.querySelectorAll('[data-slot="reference-option"][data-kind="file"]').length,
      skills: document.querySelectorAll('[data-slot="reference-option"][data-kind="skill"]').length,
      truncated: [...document.querySelectorAll('[data-slot="composer-references-panel"] li')].map((el) => el.textContent),
    }));
    // 文件数远超列表上限 ⇒ 按上限截断并如实呈现；技能数未到上限 ⇒ 全部列出
    assert.ok(FILES > 200, "夹具文件数必须超过列表上限，否则这条断言不成立");
    assert.equal(listed.files, 200, "文件列表按上限截断");
    assert.equal(listed.skills, SKILLS, "技能数未到上限时应全部列出");
    assert.ok(listed.truncated.length > 0, "截断必须如实呈现，不得静默丢项");
    assert.ok(probe.samples >= 3, `探测应覆盖发现过程并有若干次采样，实得 ${probe.samples}`);
    assert.ok(probe.max < 2000, `发现期间主进程往返最慢 ${Math.round(probe.max)}ms，应保持可用（夹具 ${SKILLS} 技能/${FILES} 文件）`);
    console.log(`[技能发现响应性] 夹具 ${SKILLS} 技能/${FILES} 文件：打开到列表 ${elapsed}ms，快照往返最慢 ${Math.round(probe.max)}ms，采样 ${probe.samples} 次`);
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

/**
 * 受控在途标记：应用层真实完成后，主进程先写下 <name> 才把应答交给界面（见 main 的
 * DCODE_TEST_SEND_RESULT_GATE / DCODE_TEST_RECEIPT_RESULT_GATE）。标记到达 = 这次请求
 * 真的已被应用处理；应答仍被门扣住 = 界面续跑还没跑。放行条件由测试自己写门文件掌握，
 * 不靠定时抢时序，也不靠长 sleep 推断在途。
 */
async function waitMarker(stateDir, name, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(join(stateDir, name))) {
    if (Date.now() > deadline) throw new Error(`受控在途标记未到达：${name}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const readMarker = (stateDir, name) => JSON.parse(readFileSync(join(stateDir, name), "utf8"));
const openGate = (stateDir, name) => writeFileSync(join(stateDir, name), "open");

/** 走真实引用入口加一枚工作空间文件引用，并等 chip 落地。 */
async function attachGreetReference(page) {
  await clickHidden(page.locator('[data-slot="composer-references-trigger"]'));
  await ensurePanelOpen(page);
  await page.locator('[data-slot="reference-option"][data-locator="r0/src/greet.js"]').waitFor({ timeout: 20_000 });
  await clickHidden(page.locator('[data-slot="reference-option"][data-locator="r0/src/greet.js"]'));
  await page.locator('[data-slot="reference-chip"][data-kind="file"]').waitFor({ timeout: 20_000 });
}

/** 该会话里唯一一条带发送身份的用户消息（本次被门控的那一次发送）。 */
const sentUserMessage = (snapshot) =>
  (snapshot.timelines["session-ref"] ?? []).filter((b) => b.kind === "message" && b.role === "user" && b.operationId);

/**
 * 通过真实菜单把发送用途改成"稍后处理"：打开输入选项 → 点该项。
 * 注意：回执待核对时输入区说明显示的是核对提示而不是用途，所以"用途确实改了"要在
 * 回执确认之后由调用方核对——提前断言会盯错字段。
 */
async function switchToFollowUp(page) {
  await clickHidden(page.getByRole("button", { name: "输入选项" }));
  await clickHidden(page.getByRole("menuitemradio", { name: /稍后处理/ }));
}

/** 输入区说明回到用途文案时，核对用途确实已是"稍后处理"。 */
async function assertFollowUpNote(page) {
  await page.waitForFunction(
    () => document.querySelector('[data-slot="composer-note"]')?.textContent?.includes("稍后处理"),
    undefined,
    { timeout: 15_000 },
  );
}

test("C6 在途改用途：直接应答不得清掉用户的新稿（文字与引用都保留）", { timeout: 180000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "dcode-ref-mode-a-"));
  const demoDir = join(root, "demo");
  const stateDir = join(root, "state");
  mkdirSync(demoDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const workspaceRoot = workspaceFixture();
  seedState(stateDir, workspaceRoot);

  // 发送侧受控在途：应用层真实完成后主进程写 waiting 标记，门文件出现前不把应答交给界面。
  const handle = await launchApp(stateDir, {
    DCODE_VALIDATION_ASSEMBLY: "pi-controlled",
    DCODE_DEMO_DIR: demoDir,
    DCODE_PI_GATE: "1",
    DCODE_TEST_SEND_RESULT_GATE: "all",
  });
  const { page, close } = handle;
  try {
    await enterReferenceSession(page);
    await ready(page);

    // 先加一枚引用：清稿判据涉及引用集合，纯文字不足以覆盖
    await attachGreetReference(page);

    const text = "在途改用途时的发送。";
    const composer = page.getByPlaceholder("追问、补充或纠正…");
    await composer.fill(text);

    await composer.press("Enter");
    // 前提：这次发送真的已被应用接收，标记里的身份就是这次发送的身份
    await waitMarker(stateDir, "send-result-waiting-1");
    const waiting = readMarker(stateDir, "send-result-waiting-1");
    const landed = sentUserMessage(await page.evaluate(() => window.dcode.getSnapshot()))[0];
    assert.equal(landed?.operationId, waiting.operationId, "在途标记必须对应该次发送的原身份");
    assert.equal(landed?.mode, "steer", "原提交用途不变");
    assert.equal(existsSync(join(stateDir, "send-result-released-1")), false, "应答未放行前不得当作已收束");

    // 在途窗口由门掌握：此刻改用途是确定的，不是抢时序
    await switchToFollowUp(page);
    assert.equal(await page.locator("textarea").inputValue(), text, "在途期间原草稿仍在场");

    openGate(stateDir, "send-result-gate-1");
    await waitMarker(stateDir, "send-result-released-1");

    assert.equal(await page.locator("textarea").inputValue(), text, "用途已在途改变：用户的新稿文字不得被旧一次 accepted 清掉");
    assert.equal(await page.locator('[data-slot="reference-chip"]').count(), 1, "新稿的引用也必须保留");
    await assertFollowUpNote(page);
  } finally {
    openGate(stateDir, "send-result-gate");
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("C6 在途改用途：查回确认已接收同样不得清掉用户的新稿", { timeout: 180000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "dcode-ref-mode-b-"));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const workspaceRoot = workspaceFixture();
  seedState(stateDir, workspaceRoot);
  const text = "回执待核对后改用途。";

  // 起点是产品自己会产生的状态：执行端**已经接收并记录**，只是给界面的回执是"待核对"。
  // （DCODE_MOCK_DROP_RECEIPT_ONCE）。因此原草稿与发送身份都还在场，回查能找回那条记录。
  const handle = await launchApp(stateDir, {
    DCODE_MOCK_DROP_RECEIPT_ONCE: "1",
    DCODE_TEST_RECEIPT_RESULT_GATE: "all",
  });
  const { page, close } = handle;
  try {
    await enterReferenceSession(page);
    await ready(page);
    await attachGreetReference(page);

    const composer = page.getByPlaceholder("追问、补充或纠正…");
    await composer.fill(text);
    await composer.press("Enter");

    // 前提一：回执确为待核对，原草稿与引用仍在（这条用例验的就是这个状态）
    await waitForSnapshot(page, (s) => sentUserMessage(s)[0]?.receipt?.status === "unknown", "起点必须是接收结果待核对");
    const unknownBlock = sentUserMessage(await page.evaluate(() => window.dcode.getSnapshot()))[0];
    assert.equal(unknownBlock?.receipt?.status, "unknown", "起点必须是接收结果待核对");
    assert.equal(await composer.inputValue(), text, "待核对期间原草稿必须保留");

    // 用户又写了一份**同样文字、同样引用**的新稿：与已接收那条唯一的差别是用途
    await composer.fill(text);
    const lookup = page.getByRole("button", { name: "回查" }).first();
    await lookup.waitFor({ timeout: 20_000 });
    await clickHidden(lookup);

    // 前提二：回查在途——应用层已真实确认，主进程写下可辨的 waiting 标记后才交付给界面
    await waitMarker(stateDir, "receipt-result-waiting-1");
    const waiting = readMarker(stateDir, "receipt-result-waiting-1");
    assert.equal(waiting.op, "checkReceipt", "在途标记必须标明这次是回查，不是重试或其它操作");
    assert.equal(waiting.sessionId, "session-ref", "在途必须绑在原会话上");
    assert.equal(waiting.blockId, unknownBlock?.id, "在途必须绑在原消息块上");
    assert.equal(existsSync(join(stateDir, "receipt-result-released-1")), false, "确认尚未交付，界面续跑不可能已执行");

    await switchToFollowUp(page);
    assert.equal(await page.locator("textarea").inputValue(), text, "在途期间新稿仍在场");

    openGate(stateDir, "receipt-result-gate-1");
    await waitMarker(stateDir, "receipt-result-released-1");

    assert.equal(await page.locator("textarea").inputValue(), text, "查回期间改了用途：新稿文字不得被清掉");
    assert.equal(await page.locator('[data-slot="reference-chip"]').count(), 1, "查回期间改了用途：新稿引用也必须保留");
    await assertFollowUpNote(page);
    const after = sentUserMessage(await page.evaluate(() => window.dcode.getSnapshot()))[0];
    assert.equal(after?.receipt?.status, "accepted", "回查应把回执确认成已接收");
    assert.equal(after?.mode, "steer", "原提交用途不变：新用途只归当前草稿");
    assert.equal(after?.operationId, unknownBlock?.operationId, "原 operationId 不变");
  } finally {
    openGate(stateDir, "receipt-result-gate");
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("C6 在途改用途：重试确认已接收同样不得清掉用户的新稿", { timeout: 180000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "dcode-ref-mode-c-"));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const workspaceRoot = workspaceFixture();
  seedState(stateDir, workspaceRoot);
  const text = "确认未接收后改用途。";

  // 起点是"确认未接收"：发送没有被接收（且没有留下记录），原草稿与发送身份都在场，
  // 于是消息块给的是重试入口而不是回查入口。（DCODE_MOCK_UNKNOWN_ONCE）
  const handle = await launchApp(stateDir, {
    DCODE_MOCK_UNKNOWN_ONCE: "1",
    DCODE_TEST_RECEIPT_RESULT_GATE: "all",
  });
  const { page, close } = handle;
  try {
    await enterReferenceSession(page);
    await ready(page);
    await attachGreetReference(page);

    const composer = page.getByPlaceholder("追问、补充或纠正…");
    await composer.fill(text);
    await composer.press("Enter");
    await waitForSnapshot(page, (s) => sentUserMessage(s)[0]?.receipt?.status === "unknown", "起点必须是接收结果待核对");
    const rejected = sentUserMessage(await page.evaluate(() => window.dcode.getSnapshot()))[0];
    assert.equal(rejected?.receipt?.status, "unknown", "起点必须是接收结果待核对");

    // 先回查一次：确实没有留下记录 ⇒ 确认未接收，入口转为重试。这次回查同样在门控下，
    // 它自己就是一次可辨的在途与放行（与后面的重试分开计数）。
    await clickHidden(page.getByRole("button", { name: "回查" }).first());
    await waitMarker(stateDir, "receipt-result-waiting-1");
    assert.equal(readMarker(stateDir, "receipt-result-waiting-1").op, "checkReceipt", "第一次在途必须是回查");
    openGate(stateDir, "receipt-result-gate-1");
    await waitMarker(stateDir, "receipt-result-released-1");
    await page.getByRole("button", { name: "重试" }).first().waitFor({ timeout: 20_000 });

    // 同样文字、同样引用再写一次作为新稿：与原发送唯一的差别是用途
    await composer.fill(text);
    const retry = page.getByRole("button", { name: "重试" }).first();
    await clickHidden(retry);

    await waitMarker(stateDir, "receipt-result-waiting-2");
    const waiting = readMarker(stateDir, "receipt-result-waiting-2");
    assert.equal(waiting.op, "retrySend", "在途标记必须标明这次是重试，不是回查");
    assert.equal(waiting.sessionId, "session-ref", "在途必须绑在原会话上");
    assert.equal(waiting.blockId, rejected?.id, "重试在途必须绑在原消息块上");
    assert.equal(existsSync(join(stateDir, "receipt-result-released-2")), false, "确认尚未交付，界面续跑不可能已执行");

    await switchToFollowUp(page);
    assert.equal(await page.locator("textarea").inputValue(), text, "在途期间新稿仍在场");

    openGate(stateDir, "receipt-result-gate-2");
    await waitMarker(stateDir, "receipt-result-released-2");

    assert.equal(await page.locator("textarea").inputValue(), text, "重试期间改了用途：新稿文字不得被清掉");
    assert.equal(await page.locator('[data-slot="reference-chip"]').count(), 1, "重试期间改了用途：新稿引用也必须保留");
    await assertFollowUpNote(page);
    const after = sentUserMessage(await page.evaluate(() => window.dcode.getSnapshot()))[0];
    assert.equal(after?.receipt?.status, "accepted", "重试应把回执确认成已接收");
    assert.equal(after?.mode, "steer", "原提交用途不变：新用途只归当前草稿");
    assert.equal(after?.operationId, rejected?.operationId, "原 operationId 不变（重试不换身份）");
  } finally {
    openGate(stateDir, "receipt-result-gate");
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});
