import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  access,
  readFile,
  realpath,
  mkdtemp,
  writeFile,
  readdir,
  readlink,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import type { HostBridge } from "../host/bridge.js";
// Electron treats .asar as a virtual directory. Hash the archive's actual bytes.
const readBundleFile = process.versions.electron
  ? (createRequire(import.meta.url)("original-fs") as typeof import("node:fs")).promises.readFile
  : readFile;
interface Receipt {
  id: string;
  state: string;
  fromApp: string;
  toApp: string;
  fromDigest: string;
  toDigest: string;
  rollbackOf?: string;
  selection: { taskId: string | null; sessionId: string | null };
}
export async function inspectCandidate(path: string, schemaVersion: number) {
  const appPath = await realpath(path);
  const executable = join(appPath, "Contents/MacOS/D Code");
  await access(executable);
  const info = await readFile(join(appPath, "Contents/Info.plist"), "utf8");
  if (
    !/<key>CFBundleIdentifier<\/key>\s*<string>dev\.dcode\.desktop<\/string>/.test(
      info,
    )
  )
    throw new Error("候选不是 D Code Web 应用");
  const schema = await readFile(
    join(appPath, "Contents/Resources/host/dist/src/product-store-schema.js"),
    "utf8",
  );
  const actual = Number(
    schema.match(/PRODUCT_STORE_SCHEMA_VERSION\s*=\s*(\d+)/)?.[1],
  );
  if (actual !== schemaVersion)
    throw new Error("候选的数据版本不同，需要先完成专门的数据迁移验证");
  const hash = createHash("sha256");
  const walk = async (directory: string) => {
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".DS_Store") continue;
      const path = join(directory, entry.name);
      hash.update(path.slice(appPath.length));
      if (entry.isSymbolicLink()) {
        const resolved = await realpath(path);
        if (!resolved.startsWith(`${appPath}/`))
          throw new Error("候选包含应用目录之外的文件引用");
        hash.update(await readlink(path));
      } else if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) hash.update(await readBundleFile(path));
    }
  };
  await walk(appPath);
  let supportsManagedAttachments=false;
  try {supportsManagedAttachments=/MANAGED_ATTACHMENT_CAPABILITY\s*=\s*1/.test(await readFile(join(appPath,"Contents/Resources/host/dist/src/attachment-files.js"),"utf8"));} catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  return { appPath, executable, digest: `sha256:${hash.digest("hex")}`, supportsManagedAttachments };
}
async function stopChild(child: ChildProcess) {
  if (!child.pid) return;
  const pid = child.pid;
  const alive = () => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  if (alive()) process.kill(-pid, "SIGTERM");
  let deadline = Date.now() + 2000;
  while (alive() && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 50));
  if (alive()) process.kill(-pid, "SIGKILL");
  deadline = Date.now() + 3000;
  while (alive() && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 50));
  if (alive())
    throw new Error("候选进程尚未退出，原版本暂未重新连接，以免产生两个写入者");
}
export async function switchApplication(options: {
  bridge: HostBridge;
  direction: "candidate" | "rollback";
  executablePath: string;
  env: NodeJS.ProcessEnv;
  flush: () => Promise<void>;
  disconnect: () => void;
  reconnect: () => Promise<HostBridge>;
  finish: () => void;
}) {
  const sourceApp = dirname(dirname(dirname(options.executablePath)));
  if (!sourceApp.endsWith(".app"))
    throw new Error("请从本地 .app 候选中进行切换");
  const snapshot = await options.bridge.request<{
    schemaVersion: number;
    storeRevision: number;
  }>("foundation.snapshot");
  const { receipts } = await options.bridge.request<{ receipts: Receipt[] }>(
    "selfEvolution.list",
  );
  const previous = receipts.find(
    (r) => r.toApp === sourceApp && r.state !== "rolled_back",
  );
  const state = await options.bridge.request<{
    candidatePath?: string;
    status: string;
  }>("maintenance.status");
  const targetPath =
    options.direction === "rollback"
      ? previous?.fromApp
      : state.status === "succeeded"
        ? state.candidatePath
        : undefined;
  if (!targetPath)
    throw new Error(
      options.direction === "rollback"
        ? "没有可回滚的上一构建"
        : "请先成功构建候选",
    );
  const source = await inspectCandidate(sourceApp, snapshot.schemaVersion);
  const target = await inspectCandidate(targetPath, snapshot.schemaVersion);
  if (source.appPath === target.appPath) throw new Error("候选就是当前应用");
  if (
    options.direction === "rollback" &&
    previous?.fromDigest !== target.digest
  )
    throw new Error("上一构建已经改变，不能按旧回执回滚");
  await options.flush();
  const current = await options.bridge.request<{ storeRevision: number; composerDrafts?:{attachments?:unknown[]}[] }>(
    "foundation.snapshot",
  );
  if(!target.supportsManagedAttachments && current.composerDrafts?.some(draft=>draft.attachments?.length)) throw new Error("目标构建无法恢复附件草稿，请先发送或移除未发送的附件，再切换构建。");
  const handoff = await mkdtemp(join(tmpdir(), "dcode-handoff-"));
  const { receipt } = await options.bridge.request<{ receipt: Receipt }>(
    "selfEvolution.prepare",
    {
      requestId: randomUUID(),
      expectedStoreRevision: current.storeRevision,
      fromApp: source.appPath,
      toApp: target.appPath,
      fromDigest: source.digest,
      toDigest: target.digest,
      ...(options.direction === "rollback" ? { rollbackOf: previous!.id } : {}),
    },
  );
  const ready = join(handoff, "ready.json"),
    go = join(handoff, "go");
  const env: NodeJS.ProcessEnv = {
    ...options.env,
    DCODE_SWITCH_ID: receipt.id,
    DCODE_SWITCH_READY: ready,
    DCODE_SWITCH_GO: go,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.DCODE_CAPTURE;
  let disconnected = false;
  let shutdownApproved = false;
  let child: ChildProcess | undefined;
  let earlyExit = false;
  let launchError: Error | undefined;
  try {
    await options.bridge.request("host.shutdown", { requireIdle: true });
    shutdownApproved = true;
    await options.bridge.shutdown();
    options.disconnect();
    disconnected = true;
    child = spawn(target.executable, [], {
      env,
      detached: true,
      stdio: "ignore",
    });
    child.on("error", (error) => {
      launchError = error;
    });
    child.on("exit", () => {
      earlyExit = true;
    });
    child.unref();
    const deadline = Date.now() + 30000;
    let confirmed = false;
    while (Date.now() < deadline) {
      if (launchError) throw launchError;
      if (earlyExit) throw new Error("候选启动后提前退出");
      try {
        const marker = JSON.parse(await readFile(ready, "utf8")) as {
          id?: string;
          pid?: number;
        };
        if ((marker as { status?: string }).status === "failed")
          throw new Error("候选无法恢复原会话");
        if (marker.id === receipt.id && marker.pid === child.pid) {
          confirmed = true;
          break;
        }
      } catch (error) {
        if (
          !(error instanceof SyntaxError) &&
          (error as NodeJS.ErrnoException).code !== "ENOENT"
        )
          throw error;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!confirmed) throw new Error("候选未确认恢复原任务");
    await writeFile(go, receipt.id, { flag: "wx", mode: 0o600 });
    options.finish();
    return true;
  } catch (error) {
    if (child) await stopChild(child);
    if (shutdownApproved && !options.bridge.hasExited)
      throw new Error("旧服务尚未确认退出，已暂停切换，未启动其他写入者");
    const restored = disconnected ? await options.reconnect() : options.bridge;
    const next = await restored.request<{ storeRevision: number }>(
      "foundation.snapshot",
    );
    const latest = (
      await restored.request<{ receipts: Receipt[] }>("selfEvolution.list")
    ).receipts.find((r) => r.id === receipt.id);
    if (latest?.state === "session_restored") {
      await restored.request("selfEvolution.transition", {
        requestId: randomUUID(),
        expectedStoreRevision: next.storeRevision,
        id: receipt.id,
        state: "recovery_required",
        issue: "候选未完成启动确认，已返回原应用",
      });
    }
    const fresh = await restored.request<{ storeRevision: number }>(
      "foundation.snapshot",
    );
    await restored.request("selfEvolution.transition", {
      requestId: randomUUID(),
      expectedStoreRevision: fresh.storeRevision,
      id: receipt.id,
      state: options.direction === "rollback" ? "cancelled" : "rolled_back",
    });
    throw new Error("候选未能完成恢复，已返回原版本。");
  }
}
