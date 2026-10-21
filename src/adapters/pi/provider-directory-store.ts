// provider-directory.json 唯一写入者：供应商目录、按 providerId 隔离的加密凭据、当前模型选择
// 与公共目录缓存共一份文件。所有写路径经 modify() 串行合并，临时文件 + rename 原子提交；
// 任一提交失败保留旧文件与旧凭据。读侧 ENOENT → null；格式错/版本不识必抛，不吞为缺失。
//
// 格式承接：发现旧 model-setup.json（format 1，单条自定义）时自动迁移为格式 2：
// 旧自定义的元数据归入 current.kind="custom"，密钥归入 credentials["user-defined"]，provider 身份不迁移
// （不按 openai-completions 协议冒认为 OpenAI 账户）；迁移前旧文件整体备份为 model-setup.backup-<ts>.json，
// 迁移本身经同一条原子提交通路，失败保留旧文件原状。

import { chmod, mkdir, readFile, rename, stat, unlink, writeFile, copyFile } from "node:fs/promises";
import { join } from "node:path";
import type { CreateModelsOptions } from "@earendil-works/pi-ai/models";
import type {
  CatalogCacheEntry,
  CurrentModelSelection,
  PersistedCatalogModel,
  ProviderDirectoryIO,
  ProviderDirectoryRecord,
} from "@/contracts";
import type { CredentialCipher } from "./model-setup-store";

export type PiCredentialStore = NonNullable<CreateModelsOptions["credentials"]>;
export type PiCredential = NonNullable<Awaited<ReturnType<PiCredentialStore["read"]>>>;

const DIRECTORY_FILE = "provider-directory.json";
const LEGACY_FILE = "model-setup.json";

function isErr(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === code;
}

const NOTES = ["ready", "auth-failed", "auth-unverified", "connect-failed"] as const;
const CUSTOM_PROTOCOLS = ["openai-completions", "anthropic-messages"] as const;

function isNote(v: unknown): boolean {
  return typeof v === "string" && (NOTES as readonly string[]).includes(v);
}

function isValidPersistedModel(v: unknown): v is PersistedCatalogModel {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Record<string, unknown>;
  if (typeof m.id !== "string" || typeof m.name !== "string") return false;
  if (typeof m.api !== "string" || typeof m.provider !== "string" || typeof m.baseUrl !== "string") return false;
  if (typeof m.reasoning !== "boolean") return false;
  if (!Array.isArray(m.input) || !m.input.every((i) => i === "text" || i === "image")) return false;
  const c = m.cost;
  if (typeof c !== "object" || c === null) return false;
  for (const k of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    if (typeof (c as Record<string, unknown>)[k] !== "number") return false;
  }
  if (typeof m.contextWindow !== "number" || typeof m.maxTokens !== "number") return false;
  return m.type === "chat";
}

function isValidCatalogEntry(v: unknown): v is CatalogCacheEntry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  if (!Array.isArray(e.models) || !e.models.every(isValidPersistedModel)) return false;
  if (e.checkedAt !== undefined && typeof e.checkedAt !== "number") return false;
  if (e.lastModified !== undefined && typeof e.lastModified !== "number") return false;
  if (e.etag !== undefined && typeof e.etag !== "string") return false;
  if (e.sourceBaseUrl !== undefined && typeof e.sourceBaseUrl !== "string") return false;
  return true;
}

function isValidSelection(v: unknown): v is CurrentModelSelection {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  if (s.kind === "preset") {
    return typeof s.providerId === "string" && typeof s.modelId === "string" && isNote(s.note);
  }
  if (s.kind === "custom") {
    return (
      typeof s.provider === "string" && (CUSTOM_PROTOCOLS as readonly string[]).includes(s.provider) &&
      typeof s.label === "string" && typeof s.modelId === "string" && typeof s.baseUrl === "string" && isNote(s.note)
    );
  }
  return false;
}

function isValidCustomDefinition(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.provider === "string" && (CUSTOM_PROTOCOLS as readonly string[]).includes(s.provider) &&
    typeof s.label === "string" && typeof s.modelId === "string" && typeof s.baseUrl === "string" && isNote(s.note)
  );
}

function isValidRecord(v: unknown): v is ProviderDirectoryRecord {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (r.format !== 2) return false;
  if (typeof r.credentials !== "object" || r.credentials === null || Array.isArray(r.credentials)) return false;
  for (const [k, val] of Object.entries(r.credentials)) {
    if (typeof k !== "string") return false;
    if (typeof val !== "object" || val === null) return false;
    const e = val as Record<string, unknown>;
    if (e.kind !== "api_key" && e.kind !== "oauth") return false;
    if (typeof e.blob !== "string" || e.blob.length === 0) return false;
  }
  if (r.current !== null && !isValidSelection(r.current)) return false;
  if (r.customDefinition !== undefined && !isValidCustomDefinition(r.customDefinition)) return false;
  if (typeof r.catalog !== "object" || r.catalog === null || Array.isArray(r.catalog)) return false;
  for (const val of Object.values(r.catalog)) {
    if (!isValidCatalogEntry(val)) return false;
  }
  const src = r.catalogSource;
  if (typeof src !== "object" || src === null) return false;
  const s = src as Record<string, unknown>;
  if (typeof s.baseUrl !== "string") return false;
  if (!(s.lastSuccessAt === null || typeof s.lastSuccessAt === "number")) return false;
  if (!(s.lastError === null || typeof s.lastError === "string")) return false;
  if (r.successesBySource !== undefined) {
    if (typeof r.successesBySource !== "object" || r.successesBySource === null || Array.isArray(r.successesBySource)) return false;
    for (const v of Object.values(r.successesBySource)) if (typeof v !== "number") return false;
  }
  return true;
}

export function emptyProviderDirectory(defaultBaseUrl: string): ProviderDirectoryRecord {
  return {
    format: 2,
    credentials: {},
    current: null,
    catalog: {},
    catalogSource: { baseUrl: defaultBaseUrl, lastSuccessAt: null, lastError: null },
  };
}

export interface AuthorizeWrite {
  /** 第一授权点：开始准备写（加密/读 current）之前； */
  beforePrepare(providerId: string): void;
  /** 第二授权点：temp 写完、紧邻真实 rename 之前。无效拒绝必须清理临时文件并保留旧记录。 */
  beforeCommit(providerId: string): void;
}

/**
 * 供应商目录与凭据的唯一写入者。所有跨字段改动经 modify() 串行：
 * 同一物理文件的 RMW 排队执行，防止不同 provider/OAuth/选模写入互相丢更新。
 */
export class ProviderDirectoryStore implements ProviderDirectoryIO {
  /** 单一写入队列：read/migrate/modify/commit* 共用——迁移首次 read 也在这条队里，不并发双写覆盖。 */
  #line: Promise<unknown> = Promise.resolve();
  #initPromise: Promise<ProviderDirectoryRecord | null> | null = null;
  /**
   * 已解析记录缓存。目录文件含全部供应商及其模型（可达数百 KB），而 SDK 的
   * checkAuth / getAuthenticatedProviders 会**逐个供应商**读取凭据；每次都重新
   * 读盘并解析会让同一份内容堆积成大量副本，直至主进程内存耗尽。
   * 缓存以文件 stat（mtime+size）校验：内容不变只解析一次，文件被别处改动即失效。
   * 这是同一份记录的读缓存，不是第二份来源；写入方始终是本类的原子提交通路。
   * 注意：缓存命中时各调用方拿到的是**同一个记录对象**。现有消费者一律用展开写新对象
   * （catalog-service 的 modify 回调、装配处都不改字段），因此当前无实际危害；
   * 将来若有调用方原地改这份记录，会污染缓存——那时应改成发拷贝，而不是改缓存语义。
   */
  #cached: { mtimeNs: bigint; size: bigint; record: ProviderDirectoryRecord } | null = null;
  /** 同一时刻只有一次读盘解析；并发读取共用这次结果。 */
  #inflightRead: Promise<ProviderDirectoryRecord | null> | null = null;

  constructor(
    private readonly paths: { stateDir: string },
    readonly cipher: CredentialCipher,
    private readonly defaults: { catalogBaseUrl: string },
    /** 凭据改写后的通知（额度等派生事实据此失效）；在**提交成功之后**才触发。 */
    private readonly hooks: { onCredentialCommitted?: (providerId: string) => void } = {},
  ) {}

  /**
   * 凭据确实换掉之后，让依赖旧凭据的派生事实（额度观测等）失效。
   * 只在写盘成功后通知：写失败时凭据没变，让旧事实失效反而是无依据的丢弃。
   */
  #notifyCredentialCommitted(providerId: string): void {
    try {
      this.hooks.onCredentialCommitted?.(providerId);
    } catch {
      // 通知失败不得回滚已提交的凭据：凭据已是新事实，派生事实失效失败只按"读不到"处理。
    }
  }

  #target(): string {
    return join(this.paths.stateDir, DIRECTORY_FILE);
  }

  /** store 默认目录源（空记录时 emptyProviderDirectory 所用）；catalog service 借此对齐空记录起源。 */
  defaultCatalogBaseUrl(): string {
    return this.defaults.catalogBaseUrl;
  }

  #serialize<T>(action: () => Promise<T>): Promise<T> {
    const next = this.#line.then(action);
    this.#line = next.catch(() => undefined);
    return next;
  }

  /** 读取路径：ENOENT 与迁移决定只沿串行段发生一次（#ensureUnlocked）。
   *  注意：modify/commit 在 #serialize 内部调用 read；不能再于 read 里 #serialize，否则冷启动首次写入自我死锁。
   *  公开 read 与内部 read 走同一个无锁路径；迁移由 #ensureUnlocked 统一持有。 */
  async read(): Promise<ProviderDirectoryRecord | null> {
    return this.#readUnlocked();
  }

  async #readUnlocked(): Promise<ProviderDirectoryRecord | null> {
    const inflight = this.#inflightRead;
    if (inflight) return inflight;
    const flight = this.#readOnce();
    this.#inflightRead = flight;
    try { return await flight; }
    finally { if (this.#inflightRead === flight) this.#inflightRead = null; }
  }

  /** 单次读盘：stat 命中缓存则直接复用；读盘期间文件被改写时不缓存。 */
  async #readOnce(): Promise<ProviderDirectoryRecord | null> {
    const target = this.#target();
    const before = await stat(target, { bigint: true }).catch((err) => {
      if (isErr(err, "ENOENT")) return null;
      throw err;
    });
    if (before === null) {
      this.#cached = null;
      return this.#ensureInitializedUnlocked();
    }
    const cached = this.#cached;
    if (cached && cached.mtimeNs === before.mtimeNs && cached.size === before.size) return cached.record;
    const raw = await readFile(target, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isValidRecord(parsed)) throw new Error("provider-directory-record-corrupt");
    // 读盘期间文件被改写：这次结果不写缓存，下一轮按新 stat 重新读。
    const after = await stat(target, { bigint: true }).catch(() => null);
    if (after && after.mtimeNs === before.mtimeNs && after.size === before.size) {
      this.#cached = { mtimeNs: after.mtimeNs, size: after.size, record: parsed };
    } else {
      this.#cached = null;
    }
    return parsed;
  }

  /** 串行段内/外都可调用：迁移逻辑直接执行并缓存 Promise，不再嵌套 #serialize（否则 modify 内自死锁）。
   *  并发首次 read 与首个 modify 共享同一份迁移 Promise，只执行一次、不会多份原子覆盖。 */
  #ensureInitializedUnlocked(): Promise<ProviderDirectoryRecord | null> {
    this.#initPromise ??= this.#migrateLegacyIfPresent();
    return this.#initPromise;
  }

  /** 读取旧 model-setup.json 并无损迁移；旧文件备份后保留（不删除），由用户提供回退依据。 */
  async #migrateLegacyIfPresent(): Promise<ProviderDirectoryRecord | null> {
    const legacyPath = join(this.paths.stateDir, LEGACY_FILE);
    let legacyRaw: string;
    try {
      legacyRaw = await readFile(legacyPath, "utf8");
    } catch (err) {
      if (isErr(err, "ENOENT")) return null;
      throw err;
    }
    let legacy: unknown;
    try {
      legacy = JSON.parse(legacyRaw);
    } catch (err) {
      throw new Error("legacy-model-setup-corrupt", { cause: err });
    }
    const rec = legacy as Record<string, unknown>;
    if (rec.format !== 1) throw new Error("legacy-model-setup-format-unknown");
    if (!isNote(rec.note)) throw new Error("legacy-model-setup-format-unknown");
    const backupPath = join(this.paths.stateDir, `model-setup.backup-${Date.now().toString(36)}.json`);
    await copyFile(legacyPath, backupPath);
    const selection: CurrentModelSelection = {
      kind: "custom",
      provider: rec.provider as "openai-completions" | "anthropic-messages",
      label: String(rec.label ?? ""),
      modelId: String(rec.modelId ?? ""),
      baseUrl: String(rec.baseUrl ?? ""),
      note: rec.note as "ready" | "auth-failed" | "auth-unverified" | "connect-failed",
    };
    // 旧 blob 无 kind 元数据：迁移时为确定 kind 做一次性解密，失败按保守映射 api_key（format 1 只有该通路）
    let credentials: ProviderDirectoryRecord["credentials"] = {};
    if (typeof rec.credential === "string" && rec.credential.length > 0) {
      let kind: "api_key" | "oauth" = "api_key";
      try {
        const plain = this.cipher.decrypt(Buffer.from(rec.credential, "base64"));
        const parsed = JSON.parse(plain) as { type?: string };
        kind = parsed.type === "oauth" ? "oauth" : "api_key";
      } catch {
        kind = "api_key";
      }
      credentials = { "user-defined": { kind, blob: rec.credential } };
    }
    const migrated: ProviderDirectoryRecord = {
      format: 2,
      credentials,
      customDefinition: selection.kind === "custom" ? {
        provider: selection.provider,
        label: selection.label,
        modelId: selection.modelId,
        baseUrl: selection.baseUrl,
        note: selection.note,
      } : undefined,
      current: selection,
      catalog: {},
      catalogSource: { baseUrl: this.defaults.catalogBaseUrl, lastSuccessAt: null, lastError: null },
    };
    if (!isValidRecord(migrated)) throw new Error("legacy-model-setup-migration-invalid");
    await this.write(migrated);
    return migrated;
  }

  /**
   * 原子提交：临时文件 + rename + chmod；写临时文件或 rename 失败保持旧 record 不变。
   * 第二授权点（beforeCommit）在 temp 写完、紧邻真实 rename 之前再校验；此时 flow 已吊销/取消
   * 的写入必须清理临时文件并保留旧记录，不允许「校验通过后才被吊销却仍落盘」。
   */
  /** 测试 seam：isolated 注入确切的下一次写盘失败；正常生产不使用。
   *  放在实例字段上而不动 #writeAtomic 私有：catalog-service 的失败反例需要 modify 真实原子路径抛错。 */
  private __testThrowNextWrite: unknown = null;
  /** 隔离测试仅用于注入写盘失败；不新公开接口，调用方覆盖后立即清。 */
  injectWriteFailureOnce(err: unknown): void {
    this.__testThrowNextWrite = err;
  }

  async #writeAtomic(record: ProviderDirectoryRecord, beforeCommit?: () => void): Promise<void> {
    const injected = this.__testThrowNextWrite;
    this.__testThrowNextWrite = null;
    if (injected) throw injected instanceof Error ? injected : new Error(String(injected ?? "write-failure-injected"));
    if (!isValidRecord(record)) throw new Error("provider-directory-record-invalid");
    await mkdir(this.paths.stateDir, { recursive: true, mode: 0o700 });
    const target = this.#target();
    const tmp = `${target}.work-${process.pid}-${Date.now().toString(36)}.tmp`;
    await writeFile(tmp, JSON.stringify(record, null, 2), { encoding: "utf8", mode: 0o600 });
    try {
      beforeCommit?.();
      await rename(tmp, target);
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
    // rename 已提交；chmod 失败不致 stale（同步静态导入，不开第二门禁后的异步窗口）
    await chmod(target, 0o600).catch(() => undefined);
    // 写后失效读缓存：文件已换内容，旧 stat 命中会让下一次读拿到上一代记录。
    this.#cached = null;
  }

  async write(record: ProviderDirectoryRecord): Promise<void> {
    await this.#writeAtomic(record);
  }

  async remove(): Promise<void> {
    try { await unlink(this.#target()); }
    catch (err) { if (!isErr(err, "ENOENT")) throw err; }
    this.#cached = null;
  }

  /** 串行 RMW：所有跨字段合并写都从这里走。fn 可返回 undefined 表示不改动。
   *  beforeCommit：可选同步门禁，紧邻 rename 复核（比如 catalog 代次/来源/关闭）；
   *  无效时清理临时文件、保留旧 record，避免「modify callback 过了但 rename 前被换源」窗口。 */
  async modify<T>(
    fn: (current: ProviderDirectoryRecord) => Promise<{ record?: ProviderDirectoryRecord; result: T }>,
    beforeCommit?: () => void,
  ): Promise<T> {
    return this.#serialize(async () => {
      const current = (await this.read()) ?? emptyProviderDirectory(this.defaults.catalogBaseUrl);
      const next = await fn(current);
      if (next.record) await this.#writeAtomic(next.record, beforeCommit);
      return next.result;
    });
  }

  /** 解密指定 providerId 的凭据；不存在返回 undefined；损坏传播。 */
  async readCredential(providerId: string): Promise<PiCredential | undefined> {
    const record = await this.read();
    const entry = record?.credentials?.[providerId];
    if (!entry) return undefined;
    const plain = this.cipher.decrypt(Buffer.from(entry.blob, "base64"));
    return JSON.parse(plain) as PiCredential;
  }

  /** 应用层自定义保存的最终提交点：加密与合并在此完成；任何失败不改旧记录。 */
  async commitCustomSetup(input: {
    provider: "openai-completions" | "anthropic-messages";
    label: string;
    modelId: string;
    baseUrl: string;
    note: "ready" | "auth-failed" | "auth-unverified" | "connect-failed";
    keyAction: "replace" | "keep" | "clear";
    apiKey?: string;
  }): Promise<ProviderDirectoryRecord> {
    return this.#serialize(async () => {
      const current = (await this.read()) ?? emptyProviderDirectory(this.defaults.catalogBaseUrl);
      const credentials = { ...current.credentials };
      if (input.keyAction === "replace") {
        if (!input.apiKey) throw new Error("apiKey-required");
        if (!this.cipher.isAvailable()) throw new Error("credential-encryption-unavailable");
        const cred: PiCredential = { type: "api_key", key: input.apiKey } as PiCredential;
        credentials["user-defined"] = { kind: "api_key", blob: this.cipher.encrypt(JSON.stringify(cred)).toString("base64") };
      } else if (input.keyAction === "keep") {
        if (credentials["user-defined"] === undefined) throw new Error("no-existing-key");
      } else {
        delete credentials["user-defined"];
      }
      const definition = {
        provider: input.provider,
        label: input.label,
        modelId: input.modelId,
        baseUrl: input.baseUrl,
        note: input.note,
      };
      const next: ProviderDirectoryRecord = {
        ...current,
        credentials,
        customDefinition: definition,
        current: { kind: "custom", ...definition },
      };
      await this.write(next);
      if (input.keyAction !== "keep") this.#notifyCredentialCommitted("user-defined");
      return next;
    });
  }

  /** 应用层预设选择的最终提交点：只记 providerId/modelId/note；凭据不动。 */
  async commitPresetSelection(input: {
    providerId: string;
    modelId: string;
    note: "ready" | "auth-failed" | "auth-unverified" | "connect-failed";
  }): Promise<ProviderDirectoryRecord> {
    return this.#serialize(async () => {
      const current = (await this.read()) ?? emptyProviderDirectory(this.defaults.catalogBaseUrl);
      const next: ProviderDirectoryRecord = {
        ...current,
        current: { kind: "preset", providerId: input.providerId, modelId: input.modelId, note: input.note },
      };
      await this.write(next);
      return next;
    });
  }

  /** login 完成后写入凭据（加密在此完成）；不动当前选择。 */
  async commitCredential(providerId: string, credential: PiCredential): Promise<ProviderDirectoryRecord> {
    return this.#serialize(async () => {
      if (!this.cipher.isAvailable()) throw new Error("credential-encryption-unavailable");
      const current = (await this.read()) ?? emptyProviderDirectory(this.defaults.catalogBaseUrl);
      const credStr = this.cipher.encrypt(JSON.stringify(credential)).toString("base64");
      const next: ProviderDirectoryRecord = {
        ...current,
        credentials: {
          ...current.credentials,
          [providerId]: { kind: credential.type === "oauth" ? "oauth" : "api_key", blob: credStr },
        },
      };
      await this.write(next);
      this.#notifyCredentialCommitted(providerId);
      return next;
    });
  }

  /**
   * SDK CredentialStore 视角：严格按 providerId 隔离；modify/delete 走同一串行队列，不绕过提交点。
   * 凭据按代次授权：用户认证 flow（gated）在两个授权点核对目标提供者与活跃 flow 身份——
   *   (1) 准备段（解密/加密/读 current 前）；(2) 紧邻真实 rename 前。两点间被吊销的写入
   *   必须清理临时文件并保留旧记录。SDK 已授权请求的 OAuth token 刷新属于正常通路（ungated），
   *   不经这里，不会被误拦。delete 同门禁。
   */
  asPiCredentialStore(authorize?: AuthorizeWrite): PiCredentialStore {
    const read = async (providerId: string): Promise<PiCredential | undefined> => {
      if (typeof providerId !== "string" || providerId.length === 0) return undefined;
      return this.readCredential(providerId);
    };
    // 目录枚举只读安全元数据：kind 与 blob 同档存储，不解密、不执行外部 key 命令
    const list = async (): Promise<readonly { providerId: string; type: PiCredential["type"] }[]> => {
      const record = await this.read().catch(() => null);
      if (!record) return [];
      return Object.entries(record.credentials).map(([providerId, entry]) => ({ providerId, type: entry.kind }));
    };
    const modify = async (
      providerId: string,
      fn: (current: PiCredential | undefined) => Promise<PiCredential | undefined>,
    ): Promise<PiCredential | undefined> => {
      return this.#serialize(async () => {
        authorize?.beforePrepare(providerId);
        const current = (await this.read()) ?? emptyProviderDirectory(this.defaults.catalogBaseUrl);
        let curCred: PiCredential | undefined;
        const enc = current.credentials[providerId];
        if (enc) {
          const plain = this.cipher.decrypt(Buffer.from(enc.blob, "base64"));
          curCred = JSON.parse(plain) as PiCredential;
        }
        const next = await fn(curCred);
        // fn 返回 undefined = 不变更；返回新凭据是一次真实提交意图
        if (next === undefined) return curCred;
        if (!this.cipher.isAvailable()) throw new Error("credential-encryption-unavailable");
        const credStr = this.cipher.encrypt(JSON.stringify(next)).toString("base64");
        const nextRecord: ProviderDirectoryRecord = {
          ...current,
          credentials: {
            ...current.credentials,
            [providerId]: { kind: next.type === "oauth" ? "oauth" : "api_key", blob: credStr },
          },
        };
        await this.#writeAtomic(nextRecord, () => authorize?.beforeCommit(providerId));
        return next;
      });
    };
    const del = async (providerId: string): Promise<void> => {
      await this.#serialize(async () => {
        authorize?.beforePrepare(providerId);
        const current = await this.read();
        if (!current || !(providerId in current.credentials)) return;
        const credentials = { ...current.credentials };
        delete credentials[providerId];
        await this.#writeAtomic({ ...current, credentials }, () => authorize?.beforeCommit(providerId));
      });
    };
    return {
      read: read as PiCredentialStore["read"],
      list: list as PiCredentialStore["list"],
      modify: modify as PiCredentialStore["modify"],
      delete: del as PiCredentialStore["delete"],
    };
  }
}
