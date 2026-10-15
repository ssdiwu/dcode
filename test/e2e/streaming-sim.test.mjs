// 同块流式行为验收：真实 React + 真实 Timeline + ResizeObserver + 真实滚动事件。
// 数据更新沿 Timeline 公开 props 数据边界（同一 message.id 的 text 增长 → React 重渲染 → 高度变 → RO）。
// 滚动事件由真实滚轮/键盘/程序化 scrollTop 触发，不改 DOM 高度，不覆盖生产 snapshot。
// 每个场景用 __SIM.resetSession(blocks) 以新 session.id 重挂 Timeline（真实进入会话生命周期，
// 带初始消息挂载）——真实产品中块清空即切 DraftState、Timeline 卸载，不从同实例空 Timeline 起步。
// 组件数据边界 UI 模拟：与真实发送 E2E（mock/Pi 只产生新块追加）分离，不宣称 Pi/服务商流式已实现。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron } from "playwright-core";
import { createRequire } from "node:module";
import { evidenceDir } from "./evidence-root.mjs";

const require = createRequire(import.meta.url);
const electronBinary = require("electron");
const ROOT = join(import.meta.dirname, "../..");
const SIM_DIR = join(ROOT, "test/e2e/streaming-sim");
const EVIDENCE = evidenceDir("streaming-sim");
mkdirSync(EVIDENCE, { recursive: true });

// 变体由环境显式选择：current 是正式入口默认；baseline 是拒绝旧无条件 count effect 的负对照。
// 测试自身受控构建对应 fixture（esbuild，构建失败即测试失败），不读残留 dist/variant.txt。
const VARIANT = process.env.DCODE_SIM_VARIANT ?? "current";
if (!["current", "baseline"].includes(VARIANT)) {
  throw new Error(`DCODE_SIM_VARIANT 只接受 current|baseline（实际 ${VARIANT}）`);
}
const VARIANT_EVIDENCE = `streaming-sim-${VARIANT}.json`;

// 受控构建：正式 test:e2e 路径与独立定向入口共用同一构建，缺产品构建产物时报明确错误
{
  const r = spawnSync(process.execPath, [join(SIM_DIR, "build-sim.mjs")], {
    env: { ...process.env, SIM_TIMELINE_VARIANT: VARIANT },
    encoding: "utf8",
    cwd: ROOT,
  });
  if (r.status !== 0) {
    throw new Error(`fixture 构建失败（${VARIANT}）exit=${r.status}\n${r.stdout}\n${r.stderr}`);
  }
}

// 启动/失败/正常退出的所有权：从 tempdir 创建到 firstWindow、__SIM 与 CSS 就绪全部阶段。
// 每个等待有界；任一失败只处置自己创建的 app——先等真实退出（exitCode/signalCode 真实设定，
// 或 exit 事件；不以 killed 或臆测代替），再删自己的目录；原始失败保留不吞。
// 依据 @types/node child_process.d.ts:193-198 —— killed 仅表示成功发送信号，不表示进程终止。
const LAUNCH_TIMEOUT_MS = 30_000;

const withTimeout = (p, label, onTimeout) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`launchSim 超时：${label} ${LAUNCH_TIMEOUT_MS / 1000} 秒内未就绪`));
    }, LAUNCH_TIMEOUT_MS);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
};

/** 真实终止只凭 exitCode !== null 或 signalCode !== null（进程实际退出后由 Node 设定）。
 *  不用 proc.killed（仅表示成功发送信号）判断终态，不用 pid 存在与否臆测。 */
const isTerminated = (proc) => proc.exitCode !== null || proc.signalCode !== null;

/**
 * 等待自己创建的进程真实退出。
 * - 已终止（exitCode/signalCode 已设定）：立即返回
 * - 未终止：等真实 exit 事件；超时升级 SIGKILL，之后**仍继续等真实 exit**（不立即 resolve）
 * - SIGKILL 后再次超时仍无 exit：拒绝（不能假退出成功）
 */
const waitRealExit = async (proc, timeoutMs, label) => {
  if (isTerminated(proc)) return { exitCode: proc.exitCode, signalCode: proc.signalCode, escalated: false };
  await new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; clearTimeout(t); resolve(undefined); } };
    const t = setTimeout(done, timeoutMs);
    proc.once("exit", done);
  });
  if (isTerminated(proc)) return { exitCode: proc.exitCode, signalCode: proc.signalCode, escalated: false };
  // 首轮等待超时：升级 SIGKILL，仍按真实 exit 判断终态
  try { proc.kill("SIGKILL"); } catch { /* 进程可能已退 */ }
  await new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; clearTimeout(t); resolve(undefined); } };
    const t = setTimeout(done, timeoutMs);
    proc.once("exit", done);
  });
  if (!isTerminated(proc)) {
    throw new Error(`${label}：两轮 SIGKILL 等待后仍无真实 exit（exitCode=${proc.exitCode} signalCode=${proc.signalCode}）`);
  }
  return { exitCode: proc.exitCode, signalCode: proc.signalCode, escalated: true };
};

const launchSim = async () => {
  const dir = mkdtempSync(join(tmpdir(), "dcode-sim-"));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  let app = null;
  const ownProc = () => app?.process() ?? null;
  const killOwnIfAlive = () => {
    const p = ownProc();
    if (p && !isTerminated(p)) { try { p.kill("SIGKILL"); } catch { /* 已退 */ } }
  };
  try {
    // electron.launch 的原生 timeout，避免外层 timeout 时 app 仍 null、随后 launch 成功却无人清理
    app = await electron.launch({
      executablePath: electronBinary,
      args: [SIM_DIR],
      cwd: ROOT,
      timeout: LAUNCH_TIMEOUT_MS,
      env: { ...env, DCODE_STATE_DIR: dir, DCODE_SIM_VARIANT: VARIANT, NODE_ENV: "production" },
    });
    const page = await withTimeout(app.firstWindow(), "首个窗口", killOwnIfAlive);
    const host = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => ({ visible: w.isVisible(), focusable: w.isFocusable(), focused: w.isFocused() })));
    if (host.some((w) => w.visible || w.focusable || w.focused)) {
      throw new Error("宿主仍须隐藏不可聚焦");
    }
    page.setDefaultTimeout(15_000);
    page.on("pageerror", (e) => console.error("[pageerror]", String(e).slice(0, 200)));
    await withTimeout(page.waitForFunction(() => !!window.__SIM && window.__SIM.getScrollerInfo() !== null), "__SIM 就绪", killOwnIfAlive);
    await withTimeout(page.waitForFunction(() => {
      const link = document.getElementById("product-css");
      if (!link || !link.sheet) return false;
      const scroller = document.querySelector("main .overflow-y-auto");
      if (!scroller) return false;
      const cs = getComputedStyle(scroller);
      return cs.overflowY === "auto" && scroller.getBoundingClientRect().height > 0;
    }), "CSS 与滚动容器就绪", killOwnIfAlive);
    return { app, page, dir };
  } catch (err) {
    // 失败归属：先等真实 exit，再删除自己的 profile；任何一步失败都附加到原错误上，不吞
    const proc = ownProc();
    const pid = proc?.pid ?? null;
    let exitInfo = null;
    let dirRemoved = false;
    try {
      if (proc) {
        killOwnIfAlive();
        exitInfo = await waitRealExit(proc, LAUNCH_TIMEOUT_MS / 2, `${labelOf(err)}失败清理`);
      }
      rmSync(dir, { recursive: true, force: true });
      dirRemoved = true;
    } catch (cleanupErr) {
      err.message += `（失败清理问题：${cleanupErr.message}）`;
      err.dcodeCleanupError = String(cleanupErr.message ?? cleanupErr);
    }
    err.dcodeLaunch = {
      pid, dir,
      exitInfo: exitInfo ? { exitCode: exitInfo.exitCode, signalCode: exitInfo.signalCode, escalated: exitInfo.escalated } : null,
      dirRemoved,
    };
    throw err;
  }
};

function labelOf(err) {
  const m = /launchSim 超时：(.+?) /.exec(String(err?.message ?? ""));
  return m ? `[${m[1]}]` : "";
}

const info = (page) => page.evaluate(() => {
  const g = window.__SIM.getScrollerInfo();
  return {
    scrollTop: Math.round(g.scrollTop),
    scrollHeight: g.scrollHeight,
    clientHeight: g.clientHeight,
    messageCount: g.messageCount,
    rowCount: g.rowCount,
  };
});
const blockHeight = (page, needle) => page.evaluate((n) => window.__SIM.getScrollerInfo().blockHeight(n), needle);
const blockTextLength = (page, needle) => page.evaluate((n) => window.__SIM.getScrollerInfo().blockTextLength(n), needle);
const atBottom = (g) => g.scrollTop + g.clientHeight >= g.scrollHeight - 2;
const grow = (page, id, delta) => page.evaluate(({ id, delta }) => {
  window.__STREAM_OBSERVE?.mark('before-grow');
  window.__SIM.growBlock(id, delta);
}, { id, delta });
const resetSession = (page, block) => page.evaluate((b) => window.__SIM.resetSession([b]), block);
const appendBlock = (page, id, text) =>
  page.evaluate(
    ({ id, text }) => window.__SIM.appendBlock({ kind: "message", id, role: "assistant", text, streaming: true, at: Date.now(), operationId: "op", mode: "steer" }),
    { id, text },
  );
const makeBlock = (id, text) => ({ kind: "message", id, role: "assistant", text, streaming: true, at: Date.now(), operationId: "op", mode: "steer" });

const LONG_MARK = (tag) => `（${tag}）` + "同块流式模拟段落内容，逐步追加，验证 Timeline 在数据边界上的真实渲染与同块增高行为。\n".repeat(60);

/** 真实滚轮上翻到阅读位置：每轮等 scrollTop 递减或已到顶，不等固定 sleep */
const wheelToTop = async (page) => {
  await page.locator("main .overflow-y-auto").first().hover();
  const startTop = (await info(page)).scrollTop;
  for (let i = 0; i < 5; i++) {
    const before = (await info(page)).scrollTop;
    await page.mouse.wheel(0, -700);
    try {
      await page.waitForFunction((b) => {
        const cur = Math.round(document.querySelector("main .overflow-y-auto").scrollTop);
        return cur < b || cur === 0;
      }, before, { timeout: 1500 });
    } catch { /* 已在顶部不动 */ }
    if ((await info(page)).scrollTop === 0) break;
  }
  const g = await info(page);
  assert.ok(g.scrollTop < startTop, `上翻须真实减少 scrollTop（${startTop}→${g.scrollTop}）`);
  assert.ok(!atBottom(g), `上翻后须离底 ${JSON.stringify(g)}`);
  return g;
};

test(`同块流式五组（${VARIANT}）：底部增高跟随 / 上翻保持 / 回底恢复 / 短起点增高仍跟随 / 上翻新块保持`, async () => {
  const { app, page, dir } = await launchSim();
  const sha256File = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
  const variantTimelinePath = VARIANT === "baseline"
    ? "/Users/diwu/Workspace/Archives/dcode-scroll-and-matrix-baseline-2026-10-08/source/src/renderer/views/Timeline.tsx"
    : join(ROOT, "src/renderer/views/Timeline.tsx");
  const productIndex = readFileSync(join(ROOT, "out/renderer/index.html"), "utf8");
  const cssName = productIndex.match(/<link[^>]+href="\.\/(assets\/[^"]+\.css)"/)[1];
  const evidence = {
    variant: VARIANT,
    buildMeta: {
      variant: VARIANT,
      timelinePath: variantTimelinePath,
      timelineSHA256: existsSync(variantTimelinePath) ? sha256File(variantTimelinePath) : null,
      bundleSHA256: sha256File(join(SIM_DIR, "dist", VARIANT, "sim-bundle.js")),
      cssSource: join(ROOT, "out/renderer", cssName),
      cssSourceSHA256: sha256File(join(ROOT, "out/renderer", cssName)),
      cssCopySHA256: sha256File(join(SIM_DIR, "dist", VARIANT, "product.css")),
      nodeVersion: process.version,
    },
    scenarios: [],
    host: null,
  };
  try {
    // ---- 场景 A/B/C：同一长内容会话，初始带消息挂载 ----
    await resetSession(page, makeBlock("b0", LONG_MARK("ABC")));
    await page.waitForFunction(() => {
      const g = window.__SIM.getScrollerInfo();
      return g.scrollHeight > g.clientHeight + 4;
    });
    // mount stick 可能在渲染完成后的一帧完成位移：等真实钉底
    await page.waitForFunction(() => {
      const g = window.__SIM.getScrollerInfo();
      return g.scrollTop + g.clientHeight >= g.scrollHeight - 2;
    });

    // 只读事件取证：不写滚动位置／尺寸，不调用内部意图；保原动作及15秒断言。
    await page.evaluate(() => {
      const scroller = document.querySelector("main .overflow-y-auto"), trace = [];
      let phase = 'A', frame, stopped = false;
      const record = (kind, event) => {
        if (trace.length >= 1536) return;
        trace.push({ t: performance.now(), phase, kind, top: scroller.scrollTop,
          sh: scroller.scrollHeight, ch: scroller.clientHeight,
          gap: scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop,
          target: event?.target?.tagName ?? null, targetIsScroller: event?.target === scroller,
          active: document.activeElement?.tagName, activeIsScroller: document.activeElement === scroller,
          key: event?.key, deltaY: event?.deltaY, trusted: event?.isTrusted,
          dockHeight: document.querySelector('[data-slot="composer-dock"]')?.getBoundingClientRect().height,
          areaHeight: document.querySelector('[data-slot="composer-card"] textarea')?.getBoundingClientRect().height });
      };
      const scroll = event => record('scroll', event), wheel = event => record('wheel', event), key = event => record('keydown', event);
      scroller.addEventListener('scroll', scroll); scroller.addEventListener('wheel', wheel);
      document.addEventListener('keydown', key, true);
      const sample = () => { if (stopped) return; if (phase === 'C') record('raf'); frame = requestAnimationFrame(sample); };
      frame = requestAnimationFrame(sample);
      window.__STREAM_OBSERVE = { mark(kind) { record(kind); }, phase(value) { phase = value; record('phase'); },
        hasScopedKey(key) { return trace.some(event => event.phase === 'C' && event.kind === 'keydown' && event.key === key && event.trusted && event.targetIsScroller); },
        hasBottomScroll() { return trace.some(event => event.phase === 'C' && event.kind === 'scroll' && event.gap <= 2); },
        stop() { stopped = true; cancelAnimationFrame(frame); record('final');
          scroller.removeEventListener('scroll', scroll); scroller.removeEventListener('wheel', wheel); document.removeEventListener('keydown', key, true); return trace; } };
      record('installed');
    });

    // A：底部时同块增高 → 跟随
    const a0 = await info(page);
    const a0h = await blockHeight(page, "（ABC）");
    const a0t = await blockTextLength(page, "（ABC）");
    assert.ok(atBottom(a0), `A 起点须钉底 ${JSON.stringify(a0)}`);
    assert.ok(a0h > 0, "A 起点消息块须有真实高度");
    await grow(page, "b0", LONG_MARK("A2"));
    await page.waitForFunction((len) => window.__SIM.getScrollerInfo().blockTextLength("（ABC）") > len, a0t);
    await page.waitForFunction(() => {
      const g = window.__SIM.getScrollerInfo();
      return g.scrollTop + g.clientHeight >= g.scrollHeight - 2;
    });
    const a1 = await info(page);
    const a1h = await blockHeight(page, "（ABC）");
    assert.equal(a1.messageCount, a0.messageCount, "A：同块增高不得增加消息块数");
    assert.equal(a1.rowCount, a0.rowCount, "A：同块增高不得增加 DOM 行数（含占位）");
    assert.ok(a1h > a0h, `A：同一块高度须真实增加（${a0h}→${a1h}）`);
    assert.ok(atBottom(a1), `A：底部时同块增高须跟随 ${JSON.stringify({ before: a0, after: a1 })}`);
    evidence.scenarios.push({ name: "A-bottom-growth-follows", before: { ...a0, h: a0h }, after: { ...a1, h: a1h } });

    // B：上翻时同块增高 → 保持位置（高度确实增长 + 行数不变 + 位置不动）
    const b0 = await wheelToTop(page);
    const b0h = await blockHeight(page, "（ABC）");
    const b0t = await blockTextLength(page, "（ABC）");
    await grow(page, "b0", LONG_MARK("B2"));
    await page.waitForFunction((len) => window.__SIM.getScrollerInfo().blockTextLength("（ABC）") > len, b0t);
    // 真实高度已增长再判位置（不等固定 sleep——等真实块高度变化的条件）
    await page.waitForFunction((h) => window.__SIM.getScrollerInfo().blockHeight("（ABC）") > h, b0h);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const b1 = await info(page);
    const b1h = await blockHeight(page, "（ABC）");
    assert.equal(b1.messageCount, b0.messageCount, "B：同块增高不增加消息块数");
    assert.equal(b1.rowCount, b0.rowCount, "B：同块增高不增加 DOM 行数（含占位）");
    assert.ok(b1h > b0h, `B：同一块高度须真实增加（${b0h}→${b1h}）`);
    assert.equal(b1.scrollTop, b0.scrollTop, `B：上翻时同块增高须保持阅读位置（${b0.scrollTop}→${b1.scrollTop}）`);
    assert.ok(!atBottom(b1), `B：上翻+同块增高后仍须离底`);
    evidence.scenarios.push({ name: "B-reading-growth-keeps", before: { ...b0, h: b0h }, after: { ...b1, h: b1h } });

    // C：显式回底 → 同块增高恢复跟随
    await page.evaluate(() => {
      const s = document.querySelector("main .overflow-y-auto");
      window.__STREAM_OBSERVE.phase('C');
      // 与真实键盘用例相同：焦点只作前置，PageDown必须到时间线，不落BODY或输入框。
      s.tabIndex = 0; s.focus({ preventScroll: true });
      s.scrollTop = s.scrollHeight;
      window.__STREAM_OBSERVE.mark('explicit-programmatic-bottom-written');
    });
    // 先确认回底scroll已经真实派发，再按PageDown：覆盖已在底部、按键不再产生位移的合法顺序。
    await page.waitForFunction(() => window.__STREAM_OBSERVE.hasBottomScroll());
    await page.keyboard.press("PageDown");
    await page.waitForFunction(() => {
      const g = window.__SIM.getScrollerInfo();
      return window.__STREAM_OBSERVE.hasScopedKey('PageDown') && g.scrollTop + g.clientHeight >= g.scrollHeight - 2;
    });
    const c0 = await info(page);
    const c0h = await blockHeight(page, "（ABC）");
    const c0t = await blockTextLength(page, "（ABC）");
    assert.ok(atBottom(c0), `C：回到底部须成立 ${JSON.stringify(c0)}`);
    await grow(page, "b0", LONG_MARK("C2"));
    await page.waitForFunction((len) => window.__SIM.getScrollerInfo().blockTextLength("（ABC）") > len, c0t);
    await page.waitForFunction(() => {
      const g = window.__SIM.getScrollerInfo();
      return g.scrollTop + g.clientHeight >= g.scrollHeight - 2;
    });
    const c1 = await info(page);
    const c1h = await blockHeight(page, "（ABC）");
    assert.equal(c1.messageCount, c0.messageCount, "C：同块增高不增加消息块数");
    assert.ok(c1h > c0h, `C：同一块高度须真实增加（${c0h}→${c1h}）`);
    assert.ok(atBottom(c1), `C：回到底部后同块增高须恢复跟随`);
    evidence.scenarios.push({ name: "C-resume-growth-follows", before: { ...c0, h: c0h }, after: { ...c1, h: c1h } });
    await page.evaluate(() => window.__STREAM_OBSERVE.phase('after-C'));

    // ---- 场景 E：独立新会话（长内容）——上翻 + 新块追加保持（关键反例：拒绝旧无条件 count effect）----
    await resetSession(page, makeBlock("e0", LONG_MARK("E")));
    await page.waitForFunction(() => {
      const g = window.__SIM.getScrollerInfo();
      return g.scrollHeight > g.clientHeight + 4;
    });
    const e0 = await wheelToTop(page);
    const eBefore = { ...e0, messageCount: (await info(page)).messageCount };
    // 追加真实新块（count 变化）：触发 Timeline 的 count 分支；等真实渲染处理完成再判
    await appendBlock(page, "e1", `（E2）新增块。${"新增内容行。\n".repeat(20)}`);
    await page.waitForFunction((n) => window.__SIM.getScrollerInfo().messageCount > n, eBefore.messageCount);
    // 等 effect/布局处理完成（真实渲染帧），不 DOM 一出现就判——给跟随位移以充分机会发生（若实现有缺陷）
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const e1 = await info(page);
    assert.equal(e1.scrollTop, eBefore.scrollTop, `E：上翻时新块追加不得拉回（${eBefore.scrollTop}→${e1.scrollTop}）`);
    assert.ok(!atBottom(e1), `E：上翻+新块后仍须离底`);
    evidence.scenarios.push({ name: "E-reading-new-block-keeps", before: eBefore, after: e1 });

    // ---- 场景 D：独立新会话（短起点）——须严格无溢出，同 ID 增高到真实溢出仍跟随 ----
    await resetSession(page, makeBlock("d0", "（D）短起点"));
    await page.waitForFunction(() => window.__SIM.getScrollerInfo().messageCount === 1);
    const d0 = await info(page);
    assert.ok(d0.scrollHeight <= d0.clientHeight + 1, `D：短起点须严格未溢出（sh=${d0.scrollHeight} ch=${d0.clientHeight}）`);
    assert.ok(atBottom(d0), `D：短起点视为底部 ${JSON.stringify(d0)}`);
    const d0h = await blockHeight(page, "（D）");
    assert.ok(d0h > 0, "D：短起点块须有真实高度");
    const d0t = await blockTextLength(page, "（D）");
    await grow(page, "d0", LONG_MARK("D2"));
    await page.waitForFunction((len) => window.__SIM.getScrollerInfo().blockTextLength("（D）") > len, d0t);
    await page.waitForFunction(() => {
      const g = window.__SIM.getScrollerInfo();
      return g.scrollHeight > g.clientHeight + 4;
    });
    await page.waitForFunction(() => {
      const g = window.__SIM.getScrollerInfo();
      return g.scrollTop + g.clientHeight >= g.scrollHeight - 2;
    });
    const d1 = await info(page);
    const d1h = await blockHeight(page, "（D）");
    assert.equal(d1.messageCount, d0.messageCount, "D：同块增高不增加消息块数");
    assert.ok(d1h > d0h, `D：同一块高度须真实增加（${d0h}→${d1h}）`);
    assert.ok(atBottom(d1), `D：初始短内容增高到溢出仍须跟随`);
    evidence.scenarios.push({ name: "D-initial-short-growth-follows", before: { ...d0, h: d0h }, after: { ...d1, h: d1h } });

    evidence.observations = await page.evaluate(() => window.__STREAM_OBSERVE?.stop() ?? []);
    evidence.host = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => ({ visible: w.isVisible(), focusable: w.isFocusable(), focused: w.isFocused() })));
    writeFileSync(join(EVIDENCE, VARIANT_EVIDENCE), JSON.stringify(evidence, null, 1));
  } catch (err) {
    // 失败也保留已收场景与失败观察：baseline 反例的红证据不能只靠 exit 码
    evidence.observations = await page.evaluate(() => window.__STREAM_OBSERVE?.stop() ?? []).catch(() => []);
    evidence.failure = { message: String(err), stack: err?.stack?.split("\n").slice(0, 4) };
    writeFileSync(join(EVIDENCE, VARIANT_EVIDENCE), JSON.stringify(evidence, null, 1));
    throw err;
  } finally {
    // 正常退出同样只处置自己创建的进程；app.close 本身必须有界，真实退出只凭 exitCode/signalCode 或真实 exit 事件
    const proc = app.process();
    if (!isTerminated(proc)) {
      const exiting = waitRealExit(proc, LAUNCH_TIMEOUT_MS / 2, "正常收束");
      try {
        await withTimeout(app.close(), "app.close", () => { try { proc.kill("SIGKILL"); } catch { /* 已退 */ } });
      } catch (closeErr) {
        // close 超时：killOwnIfAlive 已发 SIGKILL，继续按真实 exit 判断（waitRealExit 未完成会自己抛错）
        console.error("[sim-test] app.close issue:", String(closeErr?.message ?? closeErr).slice(0, 120));
      }
      await exiting;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

// 辅助反例（真实子进程）：信号送达 ≠ 终止。
// 前提（先核对的 Node 语义；不再依赖猜测）：
// 1) spawn 后立刻 kill 会发生 ready race——子进程可能还没装上 SIGTERM handler，就被默认 SIGTERM 终止；
//    因此让子进程先装 handler 并经 stdout 发明确 ready，父进程实际收到后再发 SIGTERM。
// 2) handler 已装时 SIGTERM 的默认退出被抑制，此时 killed=true 但 exitCode/signalCode 仍为 null——
//    等待器不得提早 resolve；随后升级 SIGKILL 并实际 exit 后，signalCode=SIGKILL 才成立。
// 3) 不用固定 sleep、不以 elapsed>=1 这类时钟门槛替代事件事实；终态只凭 exitCode/signalCode。
test("真实子进程：信号送达 ≠ 终止，终态仅由真实 exit 确认", async () => {
  const { spawn } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "dcode-sim-signal-"));
  const marked = join(dir, "marked");
  mkdirSync(marked, { recursive: true });
  writeFileSync(join(marked, "placeholder"), "still-alive");
  const child = spawn(process.execPath, ["-e", `
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 10000);
    process.stdout.write("ready\\n");
  `], { stdio: ["ignore", "pipe", "pipe"] });
  const pid = child.pid;
  try {
    // 等子进程明确 ready（真实事件，不依赖 spawn/sleep/固定超时——timeout fwrd 等待最多 LAUNCH 上线）
    await new Promise((resolve, reject) => {
      const rt = setTimeout(() => reject(new Error("子进程 ready 信号超时等待")), LAUNCH_TIMEOUT_MS);
      child.stdout.once("data", (buf) => {
        clearTimeout(rt);
        const text = String(buf);
        if (text.includes("ready")) resolve(undefined);
        else reject(new Error(`ready 输出异常：${text.slice(0, 100)}`));
      });
    });
    // 收到 ready 后再发 SIGTERM：handler 安装完成，默认退出被抑制
    child.kill("SIGTERM");
    assert.ok(child.killed, "SIGTERM 已成功送达（killed=true）");
    assert.ok(!isTerminated(child), `SIGTERM 送达 handler 存活时不得算终止（exitCode=${child.exitCode} signalCode=${child.signalCode}）`);
    // 在此断言点目录必须仍存在：不凭 killed=true 提前清理
    assert.ok(existsSync(marked), "SIGTERM 送达但尚存活时，目录不得被提前删除");
    // 升级 SIGKILL（终态的引导信号）——waitRealExit 会等真实 exit 事件，然后返回真实终态
    child.kill("SIGKILL");
    const info = await waitRealExit(child, 200);
    assert.equal(info.signalCode, "SIGKILL", "终态必须是真实 exit 后的 signalCode=SIGKILL");
    assert.ok(!info.escalated, "SIGKILL 已送达后 waitRealExit 不再重复升级");
  } finally {
    // try 内已由 waitRealExit 确认真实 exit；这里只清目录，避免再挂 exit listener（已错过）
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 已退 */ }
  }
  writeFileSync(join(EVIDENCE, "signal-vs-termination.json"), JSON.stringify({ pid, note: "SIGTERM handler ready 后信号送达≠终止；终态仅由真实 exit 确认" }, null, 1));
});

// 反例：窗口已创建后就绪不成立（移走变体目录内的 sim-bundle.js）时，
// launchSim 必须在限时内失败、自己这一个进程真实退出（可回读 exitCode/signalCode）、
// 自己的 profile 目录已删除、bundle 已实际恢复。断言直接核 launchErr.dcodeLaunch 的 pid/dir/exitInfo/dirRemoved，
// 不靠 pgrep 模糊匹配（那会误伤/误原谅其他宿主的 test 进程）。
test(`资源清理反例（${VARIANT}）：窗口已建、就绪未成立时失败路径退出并清理自身资源`, async () => {
  const bundle = join(SIM_DIR, "dist", VARIANT, "sim-bundle.js");
  const backup = bundle + ".cleanup-backup";
  assert.ok(existsSync(bundle), `fixture bundle 须已生成：${bundle}`);
  const startedAt = Date.now();
  renameSync(bundle, backup);
  let launchErr = null;
  try {
    await launchSim();
    throw new Error("launchSim 在就绪失败时竟成功，属于漏清理实现");
  } catch (err) {
    launchErr = err;
  } finally {
    // 只恢复自己生成的 bundle；恢复实际核对
    renameSync(backup, bundle);
  }
  // 失败必须在场，且不是「竟成功」类型
  assert.ok(launchErr, "launchSim 须在就绪失败时抛出明确错误");
  assert.ok(!String(launchErr).includes("竟成功"), `失败类型须是就绪失败而非误报成功（${String(launchErr).slice(0, 120)}）`);
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < LAUNCH_TIMEOUT_MS * 3 + 15_000, `失败路径须在限时内结束（${elapsed}ms）`);

  // 反例必须读到归属：pid/dir 真实设置，且 exitInfo 有真实 exitCode 或 signalCode（是 exit，不是 killed）
  const info = launchErr.dcodeLaunch;
  assert.ok(info, "launch 失败必须携带 dcodeLaunch 归属信息");
  assert.ok(typeof info.pid === "number" && info.pid > 0, `自己的 pid 须真实设置（实际 ${info.pid}）`);
  assert.ok(typeof info.dir === "string" && info.dir.includes("dcode-sim-"), `自己的 userData 目录须真实设置（实际 ${info.dir}）`);
  assert.ok(info.exitInfo, "失败清理必须等到真实 exit（exitCode/signalCode 至少其一设定）");
  assert.ok(
    info.exitInfo.exitCode !== null || info.exitInfo.signalCode !== null,
    `终态必须真实（exitCode=${info.exitInfo.exitCode} signalCode=${info.exitInfo.signalCode}，killed 不算）`,
  );
  // 该 pid 必须已经不再存在——直接读回，不依赖 pgrep 全表
  const pidGone = (() => {
    try {
      process.kill(info.pid, 0);
      return false;
    } catch (e) {
      return e.code === "ESRCH";
    }
  })();
  assert.ok(pidGone, `自己的 pid ${info.pid} 须已退出（process.kill(pid, 0) 返回 ESRCH）`);
  // 目录必须已删（existsSync 直接判断）
  assert.equal(info.dirRemoved, true, "自己的 userData 目录必须已删除");
  assert.equal(existsSync(info.dir), false, `userData 目录 ${info.dir} 必须已不存在`);
  // bundle 恢复必须实际核对（不是「rename 了就算」）
  assert.ok(existsSync(bundle), `bundle 须已恢复到 ${bundle}`);
  // 清理失败附加不覆盖原始错误（反例路径原错误必须仍然的就绪失败类型，不是 cleanup）
  assert.match(String(launchErr), /launchSim 超时|Timeout/, `原始失败须是就绪超时类型（${String(launchErr).slice(0, 120)}）`);
  if (launchErr.dcodeCleanupError) {
    // 附加的清理错误不应当被吞；它应让本测试失败（因为按 exit 后须删目录成功才能被接受）
    throw new Error(`清理路径不能伴随 cleanup error：${launchErr.dcodeCleanupError}`);
  }
  const evidence = {
    variant: VARIANT,
    launchFailure: String(launchErr).slice(0, 300),
    elapsedMs: elapsed,
    pid: info.pid,
    dir: info.dir,
    exitInfo: info.exitInfo,
    dirRemoved: info.dirRemoved,
    pidGone,
    bundleRestored: existsSync(bundle),
  };
  writeFileSync(join(EVIDENCE, `streaming-sim-cleanup-${VARIANT}.json`), JSON.stringify(evidence, null, 1));
});
