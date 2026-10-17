import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { launchApp, cleanup, ready } from "./helpers.mjs";

function processRows() {
  const output = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  return output.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }] : [];
  });
}

function descendants(rootPid) {
  const rows = processRows();
  const pids = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (pids.has(row.ppid) && !pids.has(row.pid)) {
        pids.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter((row) => pids.has(row.pid));
}

async function assertIsolatedUserData(row, expectedRealPath, label) {
  const argument = row.command.match(/(?:^|\s)--user-data-dir=(\S+)/)?.[1];
  assert.ok(argument, `${label} 必须显式收到 --user-data-dir: ${row.command}`);
  assert.equal(await realpath(argument), expectedRealPath, `${label} 必须使用本次隔离 profile: ${row.command}`);
}

async function waitForHelperProcesses(rootPid) {
  const deadline = Date.now() + 10_000;
  let rows = [];
  for (;;) {
    rows = descendants(rootPid);
    const gpu = rows.find((row) => row.command.includes("--type=gpu-process"));
    const network = rows.find((row) => row.command.includes("--utility-sub-type=network.mojom.NetworkService"));
    const renderer = rows.find((row) => row.command.includes("--type=renderer"));
    if (gpu && network && renderer) return { gpu, network, renderer };
    if (Date.now() >= deadline) {
      throw new Error(`Electron processes did not start: gpu=${Boolean(gpu)} network=${Boolean(network)} renderer=${Boolean(renderer)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("隔离 Electron profile 从冷目录绑定到 GPU、网络与 Renderer 进程", async () => {
  assert.equal(process.platform, "darwin", "此桌面启动路径只支持 macOS");
  const stateDir = mkdtempSync(join(tmpdir(), "dcode-e2e-cold-userdata-"));
  const expectedUserData = join(stateDir, "userdata");
  assert.equal(existsSync(expectedUserData), false, "启动前不得预建 Electron profile");
  let instance;
  try {
    instance = await launchApp(stateDir, undefined, ".", { prepareUserData: false });
    await ready(instance.page);
    assert.equal(
      await instance.app.evaluate(({ app }) => app.getPath("userData")),
      expectedUserData,
      "主进程必须使用本次隔离目录",
    );
    assert.equal(existsSync(expectedUserData), true, "隔离 profile 目录须在窗口就绪时已经存在");

    const mainPid = instance.app.process().pid;
    assert.equal(typeof mainPid, "number");
    const { gpu, network, renderer } = await waitForHelperProcesses(mainPid);
    const expectedRealPath = await realpath(expectedUserData);
    await assertIsolatedUserData(gpu, expectedRealPath, "GPU 辅助进程");
    await assertIsolatedUserData(network, expectedRealPath, "网络辅助进程");
    await assertIsolatedUserData(renderer, expectedRealPath, "Renderer 进程");
  } finally {
    if (instance) {
      await instance.close();
      cleanup(instance.stateDir);
    } else {
      cleanup(stateDir);
    }
  }
});
