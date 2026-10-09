// model-setup.json 原子读写：元数据（label/provider/modelId/baseUrl/note）与 cipher 加密凭据落同一份文件。
// 写入端到端原子：临时文件 + rename；任何提交前失败保持旧文件（含旧凭据）不变。
// 读取端 ENOENT → null；JSON/格式错必抛，不吞为缺失。
// credential 是 Pi SDK CreateModelsOptions.credentials 期望的 PiCredential 形状（encrypt 后的 base64 持久化）。

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CreateModelsOptions } from "@earendil-works/pi-ai/models";
import type { ModelSetupIO, ModelSetupRecord } from "@/contracts";

export type PiCredentialStore = NonNullable<CreateModelsOptions["credentials"]>;
export type PiCredential = NonNullable<Awaited<ReturnType<PiCredentialStore["read"]>>>;

export interface CredentialCipher {
  isAvailable(): boolean;
  encrypt(plaintext: string): Buffer;
  decrypt(encrypted: Buffer): string;
}

export interface ModelSetupStorePaths {
  /** model-setup.json 的所在目录（stateDir） */
  stateDir: string;
}

const FILE_NAME = "model-setup.json";

function recordPath(stateDir: string): string {
  return join(stateDir, FILE_NAME);
}

function isErr(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === code;
}

function isValidRecord(raw: unknown): raw is ModelSetupRecord {
  if (typeof raw !== "object" || raw === null) return false;
  const r = raw as Record<string, unknown>;
  if (r.format !== 1) return false;
  if (r.provider !== "openai-completions" && r.provider !== "anthropic-messages") return false;
  if (typeof r.label !== "string" || typeof r.modelId !== "string" || typeof r.baseUrl !== "string") return false;
  if (!["ready", "auth-failed", "auth-unverified", "connect-failed"].includes(r.note as string)) return false;
  if (r.credential !== undefined && typeof r.credential !== "string") return false;
  return true;
}

/**
 * model-setup.json 原子读写器（应用层视角：ModelSetupIO）。
 * SDK 侧凭据访问通过 asPiCredentialStore() 返回的薄适配对象（同一份文件、同一 cipher、同一份记录）。
 */
export class ModelSetupStore implements ModelSetupIO {
  constructor(
    private readonly paths: ModelSetupStorePaths,
    /** 内部使用；asPiCredentialStore 闭包内通过 store.cipher 访问 */
    readonly cipher: CredentialCipher,
  ) {}

  async read(): Promise<ModelSetupRecord | null> {
    try {
      const raw = await readFile(recordPath(this.paths.stateDir), "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!isValidRecord(parsed)) throw new Error("model-setup-record-corrupt");
      return parsed;
    } catch (err) {
      if (isErr(err, "ENOENT")) return null;
      throw err;
    }
  }

  /** 原子提交：临时文件 + rename + chmod；写临时文件失败或 rename 失败都保持旧 record 不变。 */
  async write(record: ModelSetupRecord): Promise<void> {
    await mkdir(this.paths.stateDir, { recursive: true, mode: 0o700 });
    const target = recordPath(this.paths.stateDir);
    const tmp = `${target}.work-${process.pid}-${Date.now().toString(36)}.tmp`;
    await writeFile(tmp, JSON.stringify(record, null, 2), { encoding: "utf8", mode: 0o600 });
    await rename(tmp, target);
    // chmod 晚一步失败不致 stale record（rename 已提交）；仅 best-effort、失败保留 mode=0o600 默认
    try { await import("node:fs/promises").then((fs) => fs.chmod(target, 0o600)); } catch { /* noop */ }
  }

  async remove(): Promise<void> {
    try { await unlink(recordPath(this.paths.stateDir)); }
    catch (err) { if (!isErr(err, "ENOENT")) throw err; }
  }

  /**
   * 一次性原子更新：应用在「编辑」时构造新 record（含凭据或不含凭据），由这里提交。
   * 凭据加密在提交前完成；cipher 不可用 / 加密失败 / 写盘失败任何一步都不修改旧 record。
   */
  async commitWithCredential(input: {
    provider: ModelSetupRecord["provider"];
    label: string;
    modelId: string;
    baseUrl: string;
    note: ModelSetupRecord["note"];
    keyAction: "replace" | "keep" | "clear";
    apiKey?: string;
  }): Promise<ModelSetupRecord> {
    const current = await this.read();
    let credential: string | undefined;
    if (input.keyAction === "replace") {
      if (!input.apiKey) throw new Error("apiKey-required");
      if (!this.cipher.isAvailable()) throw new Error("credential-encryption-unavailable");
      const cred: PiCredential = { type: "api_key", key: input.apiKey } as PiCredential;
      credential = this.cipher.encrypt(JSON.stringify(cred)).toString("base64");
    } else if (input.keyAction === "keep") {
      credential = current?.credential;
      if (credential === undefined) {
        throw new Error("no-existing-key");
      }
    } else {
      // clear：明确不保留凭据
      credential = undefined;
    }
    const next: ModelSetupRecord = {
      format: 1,
      provider: input.provider,
      label: input.label,
      modelId: input.modelId,
      baseUrl: input.baseUrl,
      note: input.note,
      ...(credential !== undefined ? { credential } : {}),
    };
    await this.write(next);
    return next;
  }

  /** 解密当前凭据；record 不存在或缺 credential 返回 undefined；损坏传播。 */
  async readCredential(): Promise<PiCredential | undefined> {
    const record = await this.read();
    if (!record?.credential) return undefined;
    const plain = this.cipher.decrypt(Buffer.from(record.credential, "base64"));
    return JSON.parse(plain) as PiCredential;
  }

  /** SDK 消费视角：PiCredentialStore。read/list/modify/delete 共用同一份 record，
   *  modify/delete 走原子 write，不绕过提交点。 */
  asPiCredentialStore(): PiCredentialStore {
    const read = async (_providerId: string): Promise<PiCredential | undefined> => {
      void _providerId;
      return this.readCredential();
    };
    const list = async (): Promise<readonly { providerId: string; type: PiCredential["type"] }[]> => {
      const cred = await this.readCredential().catch(() => undefined);
      if (!cred) return [];
      return [{ providerId: "user-defined", type: cred.type }];
    };
    const modify = async (
      providerId: string,
      fn: (current: PiCredential | undefined) => Promise<PiCredential | undefined>,
    ): Promise<PiCredential | undefined> => {
      const current = await this.read();
      if (!current) throw new Error(`no-model-setup-record-for-${providerId}`);
      const curCred = await this.readCredential();
      const next = await fn(curCred);
      if (next === undefined) return curCred;
      if (!this.cipher.isAvailable()) throw new Error("credential-encryption-unavailable");
      const credStr = this.cipher.encrypt(JSON.stringify(next)).toString("base64");
      await this.write({ ...current, credential: credStr });
      return next;
    };
    const del = async (_providerId: string): Promise<void> => {
      void _providerId;
      const current = await this.read();
      if (!current) return;
      const { credential: _c, ...rest } = current;
      void _c;
      await this.write(rest);
    };
    return {
      read: read as PiCredentialStore["read"],
      list: list as PiCredentialStore["list"],
      modify: modify as PiCredentialStore["modify"],
      delete: del as PiCredentialStore["delete"],
    };
  }
}

export function modelSetupStoreFactory(stateDir: string, cipher: CredentialCipher): ModelSetupStore {
  return new ModelSetupStore({ stateDir }, cipher);
}
