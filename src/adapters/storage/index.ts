// 原型持久化：把应用状态写成一个 JSON 文件。
// 真实存储布局（数据库、索引、迁移）另行设计，本实现只服务原型验证。
// 数据保护口径：区分「确实不存在」「已确认且成功保全的损坏」「读取/保全失败」；
// 最后一类保留原文件并显式报错，绝不继续种子保存（首片数据保护验收）。

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LoadResult, PersistedState, StorageAdapter } from "@/application";

export type { LoadResult };

export class JsonFileStorage implements StorageAdapter {
  private readonly file: string;
  private readonly directory: string;
  // 写入单飞队列：关闭路径上 before-quit 与 window-all-closed 会各触发一次保存，
  // 并发写同一临时文件会互相截断导致内容回退（E2E 曾复现重开后丢失新会话）。
  private queue: Promise<unknown> = Promise.resolve();
  /** 保存失败必须可见：记录最近一次错误，不假装成功 */
  lastError: string | null = null;
  /** 读取/保全失败后保护原文件：拒写直到明确解除，种子内容不得覆盖它 */
  #protectOriginal = false;

  constructor(directory: string, private readonly diagnose: (event: string, cause: unknown) => void = () => undefined) {
    this.directory = directory;
    this.file = join(directory, "dcode-prototype-state.json");
  }

  async load(): Promise<LoadResult> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
      // 读取失败（权限/IO 等）：不能按损坏处理，保留原文件，显式报错
      this.#protectOriginal = true;
      this.diagnose("state-read-failed", error);
      return { status: "unreadable", error: String(error) };
    }
    try {
      return { status: "ok", state: JSON.parse(raw) as PersistedState };
    } catch (error) {
      this.diagnose("state-parse-failed", error);
      // 损坏：只有改名保全真实成功才允许声称已保留
      const aside = `${this.file}.corrupt-${process.pid}`;
      try {
        await rename(this.file, aside);
      } catch (renameError) {
        this.diagnose("state-preserve-failed", renameError);
        this.#protectOriginal = true;
        return {
          status: "unreadable",
          error: `JSON 解析失败且保全改名未成功（${String(renameError)}）；原文件保留未动`,
        };
      }
      return { status: "corrupt", error: String(error), preservedAs: aside };
    }
  }

  save(state: PersistedState): Promise<void> {
    if (this.#protectOriginal) {
      // 读取/保全失败后不得用种子或新状态覆盖原文件；拒绝并留下可见错误
      this.lastError = "读取/保全失败后拒绝写入，原文件保留未动";
      return Promise.reject(new Error(this.lastError));
    }
    // 串行化写入；最后一次调用携带最新状态，排队中的旧快照可被跳过
    const run = this.queue.then(() => this.write(state));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** 保存结果核对不得调用带保全副作用的启动 load，也不解除启动期数据保护。 */
  async readCurrent(): Promise<LoadResult> {
    try { return { status: "ok", state: JSON.parse(await readFile(this.file, "utf8")) as PersistedState }; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
      return { status: "unreadable", error: String(error) };
    }
  }

  private async write(state: PersistedState): Promise<void> {
    try {
      await mkdir(this.directory, { recursive: true });
      const tmp = `${this.file}.tmp-${process.pid}`;
      await writeFile(tmp, JSON.stringify(state, null, 1), "utf8");
      await rename(tmp, this.file);
      this.lastError = null;
    } catch (error) {
      this.lastError = String(error);
      this.diagnose("state-save-failed", error);
      throw error;
    }
  }
}
