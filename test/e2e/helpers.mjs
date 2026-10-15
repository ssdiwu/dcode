// E2E 工装：以真实 Electron 启动应用，状态目录按用例隔离。
// 串行运行（不争用同一窗口）；每个用例从明确起始状态开始。
// close() 等待真实进程退出信号：before-quit 收束（全部会话 close + 存储收束）完成后进程才会退出，
// 超时即失败——不再用 Promise.race 吞错假装关闭成功；活进程未退出时 cleanup 拒绝清理数据目录。

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { access, mkdir, writeFile } from "node:fs/promises";
import { seedState } from "../../src/application/seed.ts";
import { _electron as electron } from "playwright-core";

const require = createRequire(import.meta.url);
const electronBinary = require("electron");

/** 仍活着的进程（stateDir → childProcess）：退出前不允许清理其数据目录 */
const liveProcesses = new Map();

/**
 * @param {string} [stateDir] 复用已有状态目录（重开场景）；缺省创建隔离新目录
 * @param {Record<string, string>} [extraEnv] 附加环境变量（如 DCODE_EXECUTION=pi、DCODE_DEMO_DIR）
 */
export async function launchApp(stateDir, extraEnv, entrypoint = ".", options = {}) {
  const dir = stateDir ?? mkdtempSync(join(tmpdir(), "dcode-e2e-"));
  if (extraEnv?.DCODE_VALIDATION_ASSEMBLY === "" && options.prebindProject !== false) {
    // 普通装配也必须用真实隔离项目；资源加载不能落到 fixture 的真实 Home。
    const stateFile = join(dir, 'dcode-prototype-state.json');
    try { await access(stateFile); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const project = join(dir, 'project'); await mkdir(project, { recursive: true });
      const state = seedState(); state.workspaces[0].folders = [project];
      await writeFile(stateFile, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
    }
  }
  // 启动同样要有界：全量运行曾出现 firstWindow 无限等待（无超时出口，整批被外层杀死）；
  // 超时后杀掉可能迟到的子进程，不留孤儿
  const withTimeout = (p, label, onTimeout) => {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        onTimeout?.();
        reject(new Error(`launchApp 超时：${label} 30 秒内未就绪`));
      }, 30_000);
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  };
  let spawned = null;
  // 剔除宿主泄漏的 ELECTRON_RUN_AS_NODE：该变量会让 Electron 以纯 Node 执行，
  // 主进程 ESM 启动即失败并表现为 “Process failed to launch”（2026-10-07 接续片根因核验）
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await withTimeout(
    electron.launch({
      executablePath: electronBinary,
      // 经典 thumb 场景必须固定实际系统控件形态；仅本次进程的易失参数域，不写用户全局偏好。
      args: [entrypoint, ...(options.classicScrollbars && process.platform === "darwin" ? ["-AppleShowScrollBars", "Always"] : [])],
      cwd: join(import.meta.dirname, "../.."),
      env: {
        ...env,
        DCODE_E2E: "1",
        DCODE_E2E_VISIBLE: process.env.DCODE_E2E_VISIBLE ?? "0",
        DCODE_STATE_DIR: dir,
        DCODE_VALIDATION_ASSEMBLY: "mock",
        DCODE_VALIDATION_SAMPLE: "1",
        DCODE_MOCK_FAST: "1",
        NODE_ENV: "production",
        ...extraEnv,
      },
    }).then((a) => {
      spawned = a;
      return a;
    }),
    "Electron 启动",
    () => spawned?.process().kill("SIGKILL"),
  );
  const page = await withTimeout(app.firstWindow(), "首个窗口", () => app.process().kill("SIGKILL"));
  if (process.env.DCODE_E2E_VISIBLE !== "1") {
    const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ visible: w.isVisible(), focusable: w.isFocusable(), focused: w.isFocused() })));
    if (windows.some(w => w.visible || w.focusable || w.focused)) {
      app.process().kill("SIGKILL");
      throw new Error("background verification requires hidden, non-focusable windows");
    }
  }
  page.setDefaultTimeout(30_000);
  const proc = app.process();
  liveProcesses.set(dir, proc);
  proc.once("exit", () => {
    if (liveProcesses.get(dir) === proc) liveProcesses.delete(dir);
  });
  app.process().stderr?.on("data", (d) => {
    const text = String(d);
    if (text.includes("[storage]") || text.includes("[mock]") || text.includes("[dcode]")) process.stdout.write(`[main:${dir.slice(-6)}] ` + text);
  });
  // 页面错误直接进测试输出，避免空渲染类问题静默
  page.on("pageerror", (error) => console.error("[pageerror]", String(error).slice(0, 300)));
  // 认领的是同一真实关闭结果，不能在退出前把 closed 布尔置真并放过后来者。
  let closeFlight = null;
  return {
    app,
    page,
    stateDir: dir,
    close: () => {
      if (closeFlight) return closeFlight;
      closeFlight = (async () => {
        // exit 是一次性事件：已收到真实出口后再挂 once 会产生虚假的15秒超时。
        // 此处只消费已有事实，不把异常退出或直接 app.exit 当作应用 flush 成功。
        if (proc.exitCode !== null || proc.signalCode !== null) {
          if (proc.exitCode === 0 && proc.signalCode === null) return;
          throw new Error(`close()：程序在关闭前已异常退出 code=${proc.exitCode} signal=${proc.signalCode}`);
        }
        let timer;
        let onExit;
        const exited = new Promise((resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("close() 超时：应用 15 秒内未真实退出（收束可能被拦截或挂起）")),
            15_000,
          );
          onExit = (code, signal) => {
            if (code === 0 && signal === null) resolve(undefined);
            else reject(new Error(`close()：程序在关闭期间异常退出 code=${code} signal=${signal}`));
          };
          proc.once("exit", onExit);
        });
        try {
          // 真实退出仍是唯一成功信号；重复调用共同等待，不吞错或增加等待时间。
          await Promise.race([app.close().then(() => exited), exited]);
        } finally {
          clearTimeout(timer);
          proc.removeListener("exit", onExit);
        }
      })();
      return closeFlight;
    },
  };
}

/** 就绪信号 + 失败时输出页面现状，便于定位是加载问题还是断言问题 */
export async function ready(page) {
  try {
    await page.getByText("D Code", { exact: false }).first().waitFor({ timeout: 30_000 });
    await page.waitForFunction(() => document.body.innerText.length > 20, { timeout: 30_000 });
  } catch (error) {
    const body = await page.evaluate(() => document.body?.innerText?.slice(0, 600) ?? "<empty>").catch(() => "<no eval>");
    const url = page.url();
    throw new Error(`App did not become ready. url=${url} body=${body}`, { cause: error });
  }
}

/** Playwright 1.56.1 waitForFunction 把 Promise 本身视作 truthy，不能等待异步快照条件。
 *  在测试侧 await 每次只读快照，再判断实际值；不调用 checkReceipt/send 推进被测状态。 */
export async function waitForSnapshot(page, predicate, arg, message = "snapshot condition did not become true") {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const snapshot = await page.evaluate(() => window.dcode.getSnapshot());
    if (await predicate(snapshot, arg)) return snapshot;
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** 只验证显式隔离装配已提供能力，不通过正常产品设置伪造配置。 */
export async function assertValidationModel(page) {
  const snapshot = await page.evaluate(() => window.dcode.getSnapshot());
  if (snapshot.execution.kind === "unavailable" || !snapshot.model.available || !snapshot.model.name) throw new Error("validation model not assembled");
}

export function cleanup(dir) {
  if (liveProcesses.has(dir)) {
    // 活进程在写时不清数据目录：先 await close()（它会等真实退出），或显式 kill 后再清理
    throw new Error(`refusing to clean up data dir of a live process: ${dir}`);
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // 清理失败不影响结果
  }
}

/** 强制结束仍活着的进程（关闭失败注入等场景用），随后可安全 cleanup */
export async function killApp(handle) {
  const proc = liveProcesses.get(handle.stateDir);
  if (proc && proc.exitCode === null && !proc.killed) {
    proc.kill("SIGKILL");
    await new Promise((resolve) => proc.once("exit", resolve));
  }
  liveProcesses.delete(handle.stateDir);
}
