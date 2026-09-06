import { spawn, type ChildProcess } from "node:child_process";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ProductStore } from "./product-store.js";
import { redactCredentialText } from "./credential-material.js";
export interface MaintenanceState {
  id?: string;
  status: "idle" | "running" | "succeeded" | "failed";
  sourceDirectory?: string;
  action?: "verify" | "build";
  summary: string;
  output: string[];
  candidatePath?: string;
  updatedAt?: string;
}
export class MaintenanceController {
  private state: MaintenanceState = { status: "idle", summary: "", output: [] };
  private child: ChildProcess | null = null;
  private flight: Promise<void> | null = null;
  private cancelled = false;
  private termination: Promise<void> | null = null;
  private blocked = false;
  constructor(
    private store: ProductStore,
    private emit: (event: string, data: unknown) => void,
  ) {}
  async status() {
    if (!this.flight) {
      const saved = this.store.maintenanceState();
      if (saved)
        this.state =
          saved.status === "running"
            ? {
                ...saved,
                status: "failed",
                summary: "上次操作被中断，可重新执行。",
              }
            : saved;
    }
    return this.state;
  }
  async start(source: string, action: "verify" | "build") {
    if (this.flight || this.blocked)
      throw new Error("已有检查或构建仍未结束，不能重复启动");
    const root = await realpath(source);
    if (!(await stat(root)).isDirectory()) throw new Error("请选择文件夹");
    const client = JSON.parse(
      await readFile(join(root, "client/package.json"), "utf8"),
    ) as { name?: string };
    const host = JSON.parse(
      await readFile(join(root, "host/package.json"), "utf8"),
    ) as { name?: string };
    if (client.name !== "@dcode/client" || host.name !== "@pi-dcode/host")
      throw new Error("请选择 D Code 源码项目，不能用于普通项目");
    const paths = (process.env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((dir) => join(dir, "npm"));
    paths.push("/opt/homebrew/bin/npm", "/usr/local/bin/npm");
    let npm: string | undefined;
    for (const path of paths) {
      try {
        await access(path);
        npm = path;
        break;
      } catch {}
    }
    if (!npm)
      throw new Error("没有找到 npm。请安装 Node.js 并重新打开 D Code。");
    this.cancelled = false;
    const id = `web-${randomUUID()}`;
    const output = join(root, "dist-candidate", id);
    this.state = {
      id,
      status: "running",
      sourceDirectory: root,
      action,
      summary:
        action === "verify"
          ? "正在检查 Host 与 Web 客户端…"
          : "正在构建隔离候选…",
      output: [],
      updatedAt: new Date().toISOString(),
    };
    await this.publish();
    this.flight = (async () => {
      try {
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          PATH: `${dirname(npm!)}${delimiter}${process.env.PATH ?? ""}`,
          DCODE_PACKAGE_OUTPUT: output,
        };
        delete env.ELECTRON_RUN_AS_NODE;
        if (action === "verify") {
          await this.run(npm!, ["--prefix", "host", "test"], root, env);
          await this.run(npm!, ["--prefix", "client", "test"], root, env);
        } else {
          await this.run(
            npm!,
            ["--prefix", "client", "run", "dist"],
            root,
            env,
          );
          this.state.candidatePath = join(
            output,
            process.arch === "arm64" ? "mac-arm64" : "mac",
            "D Code.app",
          );
          await access(join(this.state.candidatePath, "Contents/MacOS/D Code"));
        }
        this.state = {
          ...this.state,
          status: "succeeded",
          summary:
            action === "verify"
              ? "Host 与 Web 客户端检查通过。"
              : "本地候选已生成，当前应用保持运行。",
        };
      } catch (error) {
        this.state = {
          ...this.state,
          status: "failed",
          summary: this.cancelled
            ? "操作已停止。"
            : redactCredentialText(
                error instanceof Error ? error.message : String(error),
              ).text,
        };
      } finally {
        this.child = null;
        try {
          await this.publish();
        } catch {
          this.state = {status:"failed", summary:"执行结果未能保存，请检查存储状态后重新执行。", output:[]};
          this.emit("maintenance.changed", this.state);
          await this.store.recordMaintenance(this.state).catch(() => {});
        } finally {
          this.flight = null;
        }
      }
    })();
    return this.state;
  }
  private async publish() {
    this.state.updatedAt = new Date().toISOString();
    await this.store.recordMaintenance(this.state);
    this.emit("maintenance.changed", this.state);
  }
  private run(
    command: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.cancelled) {
        reject(new Error("操作已停止"));
        return;
      }
      const child = spawn(command, args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      this.child = child;
      this.termination = null;
      let timedOut = false;
      const append = (chunk: Buffer) => {
        const lines = redactCredentialText(chunk.toString())
          .text.split("\n")
          .map((line) => line.slice(0, 2000));
        this.state.output = [...this.state.output, ...lines].slice(-160);
        this.emit("maintenance.changed", this.state);
      };
      child.stdout?.on("data", append);
      child.stderr?.on("data", append);
      const timer = setTimeout(() => {
        timedOut = true;
        void this.stopChild().catch(reject);
      }, 15 * 60000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        void (async () => {
          try {
            await this.termination;
            this.child = null;
            if (timedOut) throw new Error("操作超过 15 分钟，进程已停止。");
            if (code !== 0)
              throw new Error(`操作退出（${code ?? "已中断"}），请查看输出。`);
            resolve();
          } catch (error) {
            reject(error);
          }
        })();
      });
    });
  }
  private stopChild(): Promise<void> {
    if (this.termination) return this.termination;
    const child = this.child;
    const pid = child?.pid;
    if (!pid) return Promise.resolve();
    const alive = () => {
      try {
        process.kill(-pid, 0);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
        throw error;
      }
    };
    const signal = (value: NodeJS.Signals) => {
      try {
        process.kill(-pid, value);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    this.termination = (async () => {
      signal("SIGTERM");
      const soft = Date.now() + 2000;
      while (alive() && Date.now() < soft)
        await new Promise((r) => setTimeout(r, 50));
      if (alive()) signal("SIGKILL");
      const hard = Date.now() + 3000;
      while (alive() && Date.now() < hard)
        await new Promise((r) => setTimeout(r, 50));
      if (alive()) {
        this.blocked = true;
        throw new Error("无法确认维护进程退出，已阻止重复构建。");
      }
    })();
    return this.termination;
  }
  async close() {
    this.cancelled = true;
    await this.stopChild();
    if (this.flight) await this.flight;
  }
}
