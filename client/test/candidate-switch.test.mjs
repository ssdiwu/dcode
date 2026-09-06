import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  inspectCandidate,
  switchApplication,
} from "../dist/src/main/candidate-switch.js";
async function app(root, name, script) {
  const path = join(root, name, "D Code.app");
  await mkdir(join(path, "Contents/MacOS"), { recursive: true });
  await mkdir(join(path, "Contents/Resources/host/dist/src"), {
    recursive: true,
  });
  await writeFile(
    join(path, "Contents/Info.plist"),
    "<key>CFBundleIdentifier</key><string>dev.dcode.desktop</string>",
  );
  await writeFile(
    join(path, "Contents/Resources/host/dist/src/product-store-schema.js"),
    "export const PRODUCT_STORE_SCHEMA_VERSION = 2;",
  );
  await writeFile(
    join(path, "Contents/MacOS/D Code"),
    `#!${process.execPath}\n${script}`,
    { mode: 0o755 },
  );
  return path;
}
function bridge(source, target, previous = []) {
  let receipt;
  let revision = 1;
  const calls = [];
  return {
    calls,
    hasExited: true,
    async shutdown() {
      calls.push("shutdown");
    },
    async request(method, params) {
      calls.push(method);
      if (method === "foundation.snapshot")
        return { schemaVersion: 2, storeRevision: revision };
      if (method === "maintenance.status")
        return { status: "succeeded", candidatePath: target };
      if (method === "selfEvolution.list")
        return { receipts: [...(receipt ? [receipt] : []), ...previous] };
      if (method === "selfEvolution.prepare") {
        receipt = {
          ...params,
          id: "test-switch",
          state: "restart_requested",
          selection: { taskId: null, sessionId: null },
        };
        revision++;
        return { receipt };
      }
      if (method === "selfEvolution.transition") {
        receipt.state = params.state;
        revision++;
        return { receipt };
      }
      if (method === "host.shutdown") return {};
      throw new Error(method);
    },
  };
}
test("candidate digest covers resources, not just the common Electron executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-candidate-digest-"));
  try {
    const path = await app(root, "a", "process.exit(0)");
    const first = await inspectCandidate(path, 2);
    await writeFile(
      join(path, "Contents/Resources/app.asar"),
      "different source",
    );
    const second = await inspectCandidate(path, 2);
    assert.notEqual(first.digest, second.digest);
    await assert.rejects(inspectCandidate(path, 3), /数据版本不同/);
    await symlink("/etc/hosts", join(path, "Contents/Resources/external"));
    await assert.rejects(inspectCandidate(path, 2), /目录之外/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("controlled switch waits for child readiness before releasing the original window", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-switch-"));
  try {
    const source = await app(root, "source", "process.exit(0)");
    const target = await app(
      root,
      "target",
      `const fs=require('fs');fs.writeFileSync(process.env.DCODE_SWITCH_READY,JSON.stringify({id:process.env.DCODE_SWITCH_ID,pid:process.pid}));const t=setInterval(()=>{if(fs.existsSync(process.env.DCODE_SWITCH_GO)){clearInterval(t);process.exit(0);}},10);setTimeout(()=>process.exit(2),5000).unref();`,
    );
    const host = bridge(source, target);
    let saved = false,
      disconnected = false,
      finished = false;
    assert.equal(
      await switchApplication({
        bridge: host,
        direction: "candidate",
        executablePath: join(source, "Contents/MacOS/D Code"),
        env: process.env,
        flush: async () => {
          saved = true;
        },
        disconnect: () => {
          disconnected = true;
        },
        reconnect: async () => {
          throw new Error("unexpected recovery");
        },
        finish: () => {
          finished = true;
        },
      }),
      true,
    );
    assert.ok(saved && disconnected && finished);
    assert.ok(
      host.calls.indexOf("selfEvolution.prepare") <
        host.calls.indexOf("host.shutdown"),
    );
  } finally {
    await new Promise((r) => setTimeout(r, 100));
    await rm(root, { recursive: true, force: true });
  }
});
test("a failed candidate reconnects the previous Host and records rollback", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-switch-failed-"));
  try {
    const source = await app(root, "source", "process.exit(0)");
    const target = await app(root, "target", "process.exit(1)");
    const host = bridge(source, target);
    let recovered = false,
      finished = false;
    await assert.rejects(
      switchApplication({
        bridge: host,
        direction: "candidate",
        executablePath: join(source, "Contents/MacOS/D Code"),
        env: process.env,
        flush: async () => {},
        disconnect: () => {},
        reconnect: async () => {
          recovered = true;
          return host;
        },
        finish: () => {
          finished = true;
        },
      }),
      /已返回原版本/,
    );
    assert.ok(recovered);
    assert.equal(finished, false);
    assert.equal(
      (await host.request("selfEvolution.list")).receipts[0].state,
      "rolled_back",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed rollback cancels only the attempt and preserves the rollback source", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-rollback-failed-"));
  try {
    const current = await app(root, "current", "process.exit(0)");
    const old = await app(root, "old", "process.exit(1)");
    const a = await inspectCandidate(old, 2),
      b = await inspectCandidate(current, 2);
    const prior = {
      id: "original",
      state: "session_restored",
      fromApp: old,
      toApp: current,
      fromDigest: a.digest,
      toDigest: b.digest,
    };
    const host = bridge(current, old, [prior]);
    await assert.rejects(
      switchApplication({
        bridge: host,
        direction: "rollback",
        executablePath: join(current, "Contents/MacOS/D Code"),
        env: process.env,
        flush: async () => {},
        disconnect: () => {},
        reconnect: async () => host,
        finish: () => assert.fail("must not finish failed rollback"),
      }),
      /已返回原版本/,
    );
    const receipts = (await host.request("selfEvolution.list")).receipts;
    assert.equal(receipts[0].state, "cancelled");
    assert.equal(receipts[1].state, "session_restored");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("a renderer restoration failure keeps the original application", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-restore-failed-"));
  try {
    const source = await app(root, "source", "process.exit(0)");
    const target = await app(
      root,
      "target",
      `require('fs').writeFileSync(process.env.DCODE_SWITCH_READY,JSON.stringify({id:process.env.DCODE_SWITCH_ID,pid:process.pid,status:'failed'}));setInterval(()=>{},1000);`,
    );
    const host = bridge(source, target);
    let recovered = false;
    await assert.rejects(
      switchApplication({
        bridge: host,
        direction: "candidate",
        executablePath: join(source, "Contents/MacOS/D Code"),
        env: process.env,
        flush: async () => {},
        disconnect: () => {},
        reconnect: async () => {
          recovered = true;
          return host;
        },
        finish: () => assert.fail("must not finish failed restoration"),
      }),
      /已返回原版本/,
    );
    assert.ok(recovered);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("Electron hashes archive bytes without treating app.asar as a virtual directory", async () => {
  const root=await mkdtemp(join(tmpdir(),"dcode-electron-digest-"));
  try {
    const path=await app(root,"fixture","process.exit(0)");
    await writeFile(join(path,"Contents/Resources/app.asar"),"archive bytes");
    const runner=join(root,"runner.cjs");
    const moduleUrl=new URL("../dist/src/main/candidate-switch.js",import.meta.url).href;
    await writeFile(runner,`const {app}=require('electron'); app.setPath('userData',${JSON.stringify(join(root,"user-data"))}); app.whenReady().then(async()=>{const {inspectCandidate}=await import(${JSON.stringify(moduleUrl)});const result=await inspectCandidate(${JSON.stringify(path)},2);console.log(result.digest);app.exit(0);}).catch(error=>{console.error(error);app.exit(1);});`);
    const {default:electron}=await import("electron");
    const env={...process.env}; delete env.ELECTRON_RUN_AS_NODE;
    const {stdout}=await promisify(execFileCallback)(electron,[runner],{env,timeout:30000});
    assert.match(stdout,/sha256:[a-f0-9]{64}/);
  } finally {await rm(root,{recursive:true,force:true});}
});
