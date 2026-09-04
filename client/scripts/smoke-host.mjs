#!/usr/bin/env node
/**
 * 壳冒烟（不开窗口）：拉起真实 host → host.ready 握手 → foundation.snapshot
 * 查询 → host.shutdown 优雅退出。全程使用隔离的临时 data-root 与空 agent
 * 目录，不触碰真实 ~/.dcode 或 ~/.pi/agent。
 */
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HostBridge } from "../dist/src/host/bridge.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const hostEntry = join(repoRoot, "host", "dist", "src", "index.js");

try {
  await access(hostEntry, constants.F_OK);
} catch {
  console.error(`host entry not found: ${hostEntry}`);
  console.error("run `cd host && npm run build` first");
  process.exit(1);
}

const root = await mkdtemp(join(tmpdir(), "dcode-client-smoke-"));
const agentDir = join(root, "agent");
await mkdir(join(agentDir, "sessions"), { recursive: true });
await writeFile(join(agentDir, "settings.json"), "{}\n");

const bridge = await HostBridge.start({
  executablePath: process.execPath,
  hostEntryPath: hostEntry,
  agentDirPath: agentDir,
  dataRootPath: join(root, ".dcode"),
  onStderr: text => process.stderr.write(`[host] ${text}`),
});

let failed = false;
try {
  const hello = await bridge.request("host.hello");
  const capabilities = hello.capabilities ?? {};
  console.log(`host.hello ok · productStore=${String(capabilities.productStore)} nativeTasks=${String(capabilities.nativeTasks)} foundationSnapshot=${String(capabilities.foundationSnapshot)}`);
  if (capabilities.productStore !== true || capabilities.foundationSnapshot !== true) {
    throw new Error("host.hello capabilities missing productStore / foundationSnapshot");
  }

  const snapshot = await bridge.request("foundation.snapshot");
  console.log(
    `foundation.snapshot ok · schema=v${String(snapshot.schemaVersion)} revision=${String(snapshot.storeRevision)} projects=${String(snapshot.projects?.length ?? 0)} tasks=${String(snapshot.tasks?.length ?? 0)} sessions=${String(snapshot.sessions?.length ?? 0)} user=${String(snapshot.currentUser?.id ?? "?")}`,
  );
} catch (error) {
  failed = true;
  console.error(`smoke failed: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  await bridge.shutdown();
  await rm(root, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
