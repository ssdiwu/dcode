#!/usr/bin/env node
/**
 * 壳冒烟（不开窗口）：拉起真实 host → host.ready 握手 → foundation.snapshot
 * 查询 → host.shutdown 优雅退出。全程使用隔离的临时 data-root 与空 agent
 * 目录，不触碰真实 ~/.dcode 或 ~/.pi/agent。
 */
import { access, mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HostBridge } from "../dist/src/host/bridge.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const candidateApp = process.env.DCODE_SMOKE_APP;
const hostRoot = candidateApp ? join(candidateApp, "Contents/Resources/host") : join(repoRoot, "host");
const hostEntry = join(hostRoot, "dist", "src", "index.js");

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
  executablePath: candidateApp ? join(candidateApp, "Contents/MacOS/D Code") : process.execPath,
  executableIsElectron: !!candidateApp,
  hostEntryPath: hostEntry,
  agentDirPath: agentDir,
  dataRootPath: join(root, ".dcode"),
  baseEnv: { ...process.env, DCODE_DATA_ROOT: join(root, ".dcode"), DCODE_AGENT_DIR: agentDir, DCODE_USER_DATA: join(root, "profile"), PI_OFFLINE: "1" },
  readyTimeoutMs: 15000,
  onStderr: text => process.stderr.write(`[host] ${text}`),
});

let failed = false;
try {
  const hello = await bridge.request("host.hello");
  if (process.env.DCODE_EXPECT_PI_VERSION && hello.piVersion !== process.env.DCODE_EXPECT_PI_VERSION) throw new Error(`Unexpected Pi version: ${hello.piVersion}`);
  if (process.env.DCODE_EXPECT_HOST_VERSION && hello.hostVersion !== process.env.DCODE_EXPECT_HOST_VERSION) throw new Error(`Unexpected Host version: ${hello.hostVersion}`);
  console.log(`host.hello hostVersion=${hello.hostVersion} piVersion=${hello.piVersion}`);
  if (candidateApp) {
    const versions = {};
    for (const name of ["pi-ai", "pi-agent-core", "pi-coding-agent"]) {
      const manifest = JSON.parse(await readFile(join(hostRoot, "node_modules/@earendil-works", name, "package.json"), "utf8"));
      if (manifest.version !== hello.piVersion) throw new Error(`Embedded SDK mismatch: ${name}`);
      versions[name] = manifest.version;
    }
    const catalog = await bridge.request("dcodeModels.get", {});
    const found = catalog.models.filter(model => ["openai", "openai-codex"].includes(model.providerId) && ["gpt-6-sol", "gpt-6-luna"].includes(model.modelId)).map(model => `${model.providerId}::${model.modelId}`);
    console.log(JSON.stringify({ embeddedVersions: versions, currentCatalogModels: found, realModelRequests: false }));
    if (hello.piVersion === "0.87.1" && found.length !== 4) throw new Error("Expected built-in model entries are missing");
  }
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
