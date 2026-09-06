import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HostBridge } from "../dist/src/host/bridge.js";
test("forced shutdown does not resolve until the old Host has exited", async () => {
  const root = await mkdtemp(join(tmpdir(), "dcode-stubborn-host-"));
  const entry = join(root, "host.cjs");
  await writeFile(
    entry,
    `process.on('SIGTERM',()=>{});process.stdin.on('data',chunk=>{for(const line of chunk.toString().trim().split('\\n')){const r=JSON.parse(line);console.log(JSON.stringify({version:1,type:'response',id:r.id,method:r.method,ok:true,result:{}}));}});console.log(JSON.stringify({version:1,type:'event',event:'host.ready'}));`,
  );
  const bridge = await HostBridge.start({
    executablePath: process.execPath,
    hostEntryPath: entry,
    agentDirPath: root,
  });
  try {
    await bridge.shutdown(20);
    assert.equal(bridge.hasExited, true);
    await assert.rejects(bridge.request("host.hello"), /disposed/);
  } finally {
    bridge.kill();
    await rm(root, { recursive: true, force: true });
  }
});
