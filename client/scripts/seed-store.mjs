#!/usr/bin/env node
/**
 * 视觉验收种子：在固定隔离数据根（/tmp/dcode-visual-store）用真实协议
 * 创建项目与任务（task.create 返回真实协调会话）。可重复执行：已有
 * revision 推进时直接复用现状，不重置、不造假数据。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { HostBridge } from "../dist/src/host/bridge.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const hostEntry = join(repoRoot, "host", "dist", "src", "index.js");
const storeRoot = "/tmp/dcode-visual-store";
const agentDir = join(storeRoot, "agent");

await mkdir(join(agentDir, "sessions"), { recursive: true });
await writeFile(join(agentDir, "settings.json"), "{}\n");

const bridge = await HostBridge.start({
  executablePath: process.execPath,
  hostEntryPath: hostEntry,
  agentDirPath: agentDir,
  dataRootPath: join(storeRoot, ".dcode"),
  onStderr: text => process.stderr.write(`[host] ${text}`),
});

try {
  const hello = await bridge.request("host.hello");
  if (hello.capabilities?.productStore !== true) {
    throw new Error("productStore capability missing");
  }
  const snapshot = await bridge.request("foundation.snapshot");
  const revision = snapshot.storeRevision;
  const userId = snapshot.currentUser.id;
  console.log(`store revision=${revision} projects=${snapshot.projects.length} tasks=${snapshot.tasks.length}`);

  if (snapshot.tasks.length === 0) {
    const project = await bridge.request("project.create", {
      requestId: `seed-project-${Date.now()}`,
      expectedStoreRevision: revision,
      title: "视觉验收项目",
      directory: storeRoot,
    });
    console.log(`project.create ok · ${project.project?.title ?? "?"}`);
    const revisionAfterProject = project.storeRevision ?? revision + 1;

    await bridge.request("task.create", {
      requestId: `seed-task-project-${Date.now()}`,
      expectedStoreRevision: revisionAfterProject,
      scope: { kind: "project", projectId: project.project.id },
      title: "重构 507-rednote",
      goal: "收口连续文章与视觉摘要的默认关系。",
      acceptance: [],
    });
    await bridge.request("task.create", {
      requestId: `seed-task-standalone-${Date.now()}`,
      expectedStoreRevision: revisionAfterProject + 1,
      scope: { kind: "user", userId },
      title: "修复主页面布局",
      goal: "完成主页面导航与信息区的可用性收口。",
      acceptance: [],
    });
    console.log("task.create ×2 ok（各含真实协调会话）");
  } else {
    console.log("store already seeded; skipping");
  }

  const final = await bridge.request("foundation.snapshot");
  console.log(
    `final: projects=${final.projects.length} tasks=${final.tasks.length} sessions=${final.sessions.length}`,
  );
} finally {
  await bridge.shutdown();
}
