// 供应商目录与凭据的协调服务（pi 模块公开入口之一）：
// - 目录读取：builtin（SDK 静态）为底，已校验缓存的 remote 按 (provider,id) 合并覆盖；
// - 联网检查：先恢复缓存/内置立即可读，再异步逐个供应商公共 GET，写盘成立后才发布新 revision；
// - 防重/新旧源仲裁：generation 计数；一次刷新进行中，后到刷新直接复用在途；来源切换后旧结果不得发布；
// - 关闭收束：abort 在途请求、等待已开始的缓存提交与**来源保存**收束，不在关闭后发布。
// 不读凭据正文参与目录（公共 GET 无认证）；认证经 loginProvider 走 SDK 正式通路。

import type { AnyModel, Api, Model, Provider } from "@earendil-works/pi-ai";
import type {
  CatalogModelView,
  ModelCatalogView,
  PersistedCatalogModel,
  ProviderDirectoryEntry,
  ProviderDirectoryRecord,
} from "@/contracts";
import { fetchProviderCatalog } from "./remote-catalog";
import type { FetchCatalogOptions } from "./remote-catalog";
import type { ProviderDirectoryStore } from "./provider-directory-store";
import type { RegisteredPresetProvider } from "./preset-providers";
import { resolveExecutableModel } from "./executable-models";

export interface CatalogServiceOptions {
  store: ProviderDirectoryStore;
  presets: readonly RegisteredPresetProvider[];
  /** 公共目录默认源（catalogSource.baseUrl 缺席时使用） */
  defaultBaseUrl?: string;
  /** 测试注入：替换单供应商请求（目录内容 fixture），缺省真实 fetch */
  fetchOne?: (options: FetchCatalogOptions) => ReturnType<typeof fetchProviderCatalog>;
  /** 测试注入：本地内置目录的生成时间（SDK 提供；缺省 0 = 始终接受较新远端） */
  builtinGeneratedAt?: number;
  diagnose?: (event: string, cause: unknown) => void;
}

interface CatalogState {
  record: ProviderDirectoryRecord;
  /** 当前生效的合并视图（builtin + record.catalog） */
  revision: number;
  updating: boolean;
}

/** setSource 的结果形状（公开签名与内部来源 flight 共用，避免两处漂移）。
 *  committed-not-checked：来源定义已原子提交（事实保留），但本次收尾检查因关闭/被取代未执行。
 *  它与 refresh-failed 分开，是为了不把「已保存」说成「未保存」。 */
export type SetSourceResult = { ok: boolean; issue?: "refresh-failed" | "closed" | "committed-not-checked"; message?: string; revision?: number };

export class ProviderCatalogService {
  #state: CatalogState;
  #refreshFlight: Promise<void> | null = null;
  /** 来源保存（setSource 的落盘与随后的检查）同样是在途登记；close 必须真实等它收束。 */
  #sourceFlight: Promise<SetSourceResult> | null = null;
  #refreshController: AbortController | null = null;
  #generation = 0;
  #closed = false;
  #listeners = new Set<(info: { revision: number }) => void>();
  #options: CatalogServiceOptions;
  #presetsById: Map<string, RegisteredPresetProvider>;

  constructor(options: CatalogServiceOptions) {
    this.#options = options;
    this.#presetsById = new Map(options.presets.map((p) => [p.id, p]));
    // 空记录的目录源必须与 store 默认同源：空档时 store.emptyProviderDirectory 用其 defaults.catalogBaseUrl
    // （普通装配路径 env DCODE_CATALOG_BASE_URL 传入），guard 才能匹配、首次提交才能生效。
    // 不在此处再拼另一份默认——以 store 为单一事实；options.defaultBaseUrl 只是显式覆盖。
    const initialBaseUrl = options.defaultBaseUrl ?? options.store.defaultCatalogBaseUrl();
    this.#state = {
      record: {
        format: 2,
        credentials: {},
        current: null,
        catalog: {},
        catalogSource: { baseUrl: initialBaseUrl, lastSuccessAt: null, lastError: null },
      },
      revision: 0,
      updating: false,
    };
  }

  /** 启动：读取持久记录（含旧格式迁移），发布初始视图；必须在任何刷新前完成。 */
  async init(): Promise<void> {
    const record = await this.#options.store.read();
    if (record) {
      this.#state = { ...this.#state, record, revision: this.#state.revision + 1 };
      this.#emit();
    }
  }

  onChanged(listener: (info: { revision: number }) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(): void {
    const info = { revision: this.#state.revision };
    for (const l of this.#listeners) l(info);
  }

  #bump(mutate?: (s: CatalogState) => void): void {
    if (mutate) mutate(this.#state);
    this.#state.revision += 1;
    this.#emit();
  }

  /** 当前模型目录视图（builtin + 有效 remote 缓存合并；按 providerId 精确隔离凭据状态）。 */
  async view(): Promise<ModelCatalogView> {
    // 读最新持久记录，避免启动后外部写入造成视图漂移（写都经本服务 modify，这里以内存为准足够）
    const record = this.#state.record;
    const providers: ProviderDirectoryEntry[] = this.#options.presets.map((p) => ({
      id: p.id,
      name: p.name,
      auth: p.authKinds,
      hasStoredKey: record.credentials[p.id] !== undefined,
      modelCount: this.#modelsFor(p.id, record).length,
    }));
    const models: Record<string, readonly CatalogModelView[]> = {};
    for (const p of this.#options.presets) {
      models[p.id] = this.#modelsFor(p.id, record);
    }
    // lastSuccessAt 只反映当前源的真实成功时间；不把 A 的成功时间当 B 的
    const lastSuccessAt = record.successesBySource?.[record.catalogSource.baseUrl]
      ?? (record.catalogSource.lastSuccessAt !== null && record.catalogSource.lastError === null ? record.catalogSource.lastSuccessAt : null);
    return {
      providers,
      models,
      source: {
        baseUrl: record.catalogSource.baseUrl,
        lastSuccessAt,
        updating: this.#state.updating,
        lastError: record.catalogSource.lastError,
        revision: this.#state.revision,
      },
    };
  }

  #modelsFor(providerId: string, record: ProviderDirectoryRecord): CatalogModelView[] {
    const preset = this.#presetsById.get(providerId);
    if (!preset) return [];
    const byId = new Map<string, CatalogModelView>();
    for (const m of safeBuiltinModels(preset.provider)) {
      const view = builtinToView(m);
      if (view) byId.set(view.id, view);
    }
    const cached = record.catalog[providerId];
    // 跨源回退：已校验缓存仍可浏览/解析（最后有效目录），不冒称为当前源更新；
    // 来源归属由 source.baseUrl/lastSuccessAt 表达，旧源成功时间不按当前源显示。
    const localApis = new Set(safeBuiltinModels(preset.provider).map((m) => m.api));
    if (cached && this.#remoteIsNewer(cached)) {
      for (const m of cached.models) {
        byId.set(m.id, persistedToView(m, (api) => localApis.has(api)));
      }
    }
    return [...byId.values()];
  }

  /** 线上 lastModified 与本地内置生成时间比较；本机资料更新时不接受更旧的源倒退。 */
  #remoteIsNewer(entry: { lastModified?: number }): boolean {
    const generatedAt = this.#options.builtinGeneratedAt ?? 0;
    if (generatedAt <= 0) return true;
    if (entry.lastModified === undefined) return true;
    return entry.lastModified > generatedAt;
  }

  /** 已生效持久 record（解析路径）：真实持久读盘（非内存缓存）。 */
  async #currentRecord(): Promise<ProviderDirectoryRecord> {
    const stored = await this.#options.store.read().catch(() => null);
    if (stored) return stored;
    return this.#state.record;
  }

  /** 单供应商有效模型查询（供装配 preset 后端）：builtin 与已生效 remote 合并后的当前对象。 */
  resolveModel(providerId: string, modelId: string): { builtin: Model<Api> | undefined; effective: CatalogModelView | undefined } {
    const preset = this.#presetsById.get(providerId);
    if (!preset) return { builtin: undefined, effective: undefined };
    const builtin = safeBuiltinModels(preset.provider).find((m) => m.id === modelId);
    const effective = this.#modelsFor(providerId, this.#state.record).find((m) => m.id === modelId);
    return { builtin, effective };
  }

  /**
   * 当前生效模型的本地权威解析（executable-models 单一实现）：
   * builtin 精确条目保留完整本地模板；同供应商、本地已确认协议的新线上模型以 anchor 模板执行；
   * 未知 api 显示为不可执行。api/baseUrl 一律本地权威，remote 数据只提供安全元数据。
   * sync 签名：main/backendFactory 同步回调使用；真实持久读取留给 main backendFactory 在「新 backend 真实构造」
   * 之前 await `catalog.coldStartResolve`（见下方 coldStartResolve）。
   */
  resolveModelLocal(providerId: string, modelId: string): { api: string; baseUrl: string; executable: boolean } | undefined {
    const resolution = this.resolveExecutable(providerId, modelId);
    if (!resolution) return undefined;
    return {
      api: resolution.executable && resolution.model ? resolution.model.api : (this.#remoteEntry(providerId, modelId)?.api ?? ""),
      baseUrl: resolution.model?.baseUrl ?? "",
      executable: resolution.executable,
    };
  }

  /** 完整可执行解析（main/assembly 共用）：含本地模板字段的 model 与安全元数据 info。 */
  resolveExecutable(providerId: string, modelId: string): import("./executable-models").ExecutableModelResolution | null {
    const preset = this.#presetsById.get(providerId);
    if (!preset) return null;
    const remote = this.#remoteEntry(providerId, modelId);
    return resolveExecutableModel(preset, modelId, remote);
  }

  /**
   * 解析路径真实读盘的异步入口（main/assembly 每次新构造后端之前 await）：先 refresh 内存到最新 store 记录，
   * 再做同步 resolve。这是真实「冷启动 + 明确应用」共用的读盘接缝；不把 store.modify 的绕过写入当异步同步问题。
   */
  async resolveAfterRefresh(providerId: string, modelId: string): Promise<import("./executable-models").ExecutableModelResolution | null> {
    const stored = await this.#currentRecord();
    this.#bump((s) => { s.record = stored; });
    return this.resolveExecutable(providerId, modelId);
  }

  #remoteEntryIn(record: ProviderDirectoryRecord, providerId: string, modelId: string): PersistedCatalogModel | undefined {
    const prior = record.catalog[providerId];
    if (!prior || !this.#remoteIsNewer(prior)) return undefined;
    return prior.models.find((m) => m.id === modelId);
  }

  #remoteEntry(providerId: string, modelId: string): PersistedCatalogModel | undefined {
    return this.#remoteEntryIn(this.#state.record, providerId, modelId);
  }

  /**
   * 手动/自动联网检查。并发只许一次在途；重复调用复用在途。
   * 逐供应商提交：一个供应商的成功不被另一个的失败牵连；任何失败不丢已有目录。
   * 关闭后拒绝新刷新；在途刷新由 close() 取消并等待收束。
   *
   * 公开入口在**来源变更在途**时不再另起一代：另起一代会把那次变更变成 stale，
   * 且此刻内存里的来源仍是旧源，新检查会把旧源的结果当成当前源的。setSource 的收尾检查
   * 是这次变更的一部分，走内部 #refreshNow，不受此限制。
   */
  async refresh(): Promise<{ ok: boolean; revision: number; message?: string }> {
    if (this.#sourceFlight !== null) return { ok: false, revision: this.#state.revision, message: "catalog-source-busy" };
    return this.#refreshNow();
  }

  async #refreshNow(): Promise<{ ok: boolean; revision: number; message?: string }> {
    if (this.#closed) return { ok: false, revision: this.#state.revision, message: "catalog-closed" };
    if (this.#refreshFlight) {
      await this.#refreshFlight.catch(() => undefined);
      return { ok: this.#state.record.catalogSource.lastError === null, revision: this.#state.revision, message: this.#state.record.catalogSource.lastError ?? undefined };
    }
    const generation = ++this.#generation;
    const controller = new AbortController();
    this.#refreshController = controller;
    this.#bump((s) => { s.updating = true; });
    const flight = this.#runRefresh(generation, controller.signal)
      .catch((err) => {
        this.#options.diagnose?.("catalog-refresh-failed", err);
        if (this.#closed || generation !== this.#generation) return;
        this.#bump((s) => {
          s.record = {
            ...s.record,
            catalogSource: { ...s.record.catalogSource, lastError: "catalog-refresh-exception" },
          };
        });
      })
      .finally(() => {
        if (this.#refreshController === controller) this.#refreshController = null;
        if (this.#refreshFlight === flight) this.#refreshFlight = null;
        if (generation === this.#generation) this.#bump((s) => { s.updating = false; });
      });
    this.#refreshFlight = flight;
    await flight;
    const failed = this.#state.record.catalogSource.lastError;
    return { ok: failed === null, revision: this.#state.revision, message: failed ?? undefined };
  }

  async #runRefresh(generation: number, signal: AbortSignal): Promise<void> {
    const baseUrl = this.#state.record.catalogSource.baseUrl;
    const fetchOne = this.#options.fetchOne ?? fetchProviderCatalog;
    let anySuccess = false;
    let firstError: string | null = null;
    for (const preset of this.#options.presets) {
      if (signal.aborted || this.#closed || generation !== this.#generation) return;
      const cached = this.#state.record.catalog[preset.id];
      // 跨源不得复用旧源 ETag：新源请求不带 if-none-match，避免把旧源 304 当新源成功的依据
      const etag = !preset.catalogProviderId && cached && cached.models.length > 0 && cached.sourceBaseUrl === baseUrl ? cached.etag : undefined;
      let outcome;
      try {
        // 旧 Azure 缓存仍归原来源，远端资源改名不能借旧 ETag 得到假 304。
        outcome = await fetchOne({ baseUrl, providerId: preset.id, remoteProviderId: preset.catalogProviderId, etag, signal });
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return;
        outcome = { kind: "failed" as const, message: "catalog-network-failed" };
      }
      const result = await this.#commitCatalogOutcome(generation, baseUrl, preset.id, outcome, firstError);
      if (result.committed) anySuccess = true;
      if (result.error) firstError ??= result.error;
    }
    if (signal.aborted || this.#closed || generation !== this.#generation) return;
    if (!anySuccess && firstError) {
      this.#bump((s) => {
        s.record = { ...s.record, catalogSource: { ...s.record.catalogSource, lastError: firstError } };
      });
    } else {
      const fresh = await this.#options.store.read();
      if (fresh && !this.#closed && generation === this.#generation && fresh.catalogSource.baseUrl === baseUrl) this.#bump((s) => { s.record = fresh; });
    }
  }

  /** 提交单个供应商的目录结果。返回 committed/写盘或校验失败 error；写盘失败必须落 lastError，不能 refresh ok:true。 */
  async #commitCatalogOutcome(
    generation: number,
    baseUrl: string,
    providerId: string,
    outcome: import("./remote-catalog").CatalogFetchOutcome,
    previousError: string | null,
  ): Promise<{ committed: boolean; error: string | null }> {
    try {
      const committed = await this.#options.store.modify(async (current) => {
        if (generation !== this.#generation || current.catalogSource.baseUrl !== baseUrl) {
          return { result: false };
        }
        // 同轮前一供应商失败须随之后成功落盘保留；部分更新可用不等于整轮检查成功。
        const catalog = { ...current.catalog };
        let catalogSource = current.catalogSource;
        const prior = catalog[providerId];
        // 跨源归属：缓存与 ETag 只属于其 sourceBaseUrl；新源的 304 不得把旧源正文当新源检查成功
        const priorIsCurrentSource = prior !== undefined && prior.sourceBaseUrl === baseUrl;
        if (outcome.kind === "ok") {
          if (priorIsCurrentSource && prior.lastModified !== undefined && outcome.entry.lastModified !== undefined
            && outcome.entry.lastModified > 0 && prior.lastModified > outcome.entry.lastModified) {
            catalogSource = { ...catalogSource, lastSuccessAt: outcome.entry.checkedAt ?? Date.now(), lastError: previousError };
            const successesBySource = { ...(current.successesBySource ?? {}), [baseUrl]: outcome.entry.checkedAt ?? Date.now() };
            return { record: { ...current, catalogSource, successesBySource }, result: true };
          }
          catalog[providerId] = { ...outcome.entry, sourceBaseUrl: baseUrl };
          const checkedAt = outcome.entry.checkedAt ?? Date.now();
          catalogSource = { ...catalogSource, lastSuccessAt: checkedAt, lastError: previousError };
          const successesBySource = { ...(current.successesBySource ?? {}), [baseUrl]: checkedAt };
          return { record: { ...current, catalog, catalogSource, successesBySource }, result: true };
        }
        if (outcome.kind === "not-modified") {
          // 只有同源有正文时 304 才能延长 freshness；旧源/无正文都不能当作新源成功
          if (!priorIsCurrentSource || !prior || prior.models.length === 0) {
            catalogSource = { ...catalogSource, lastError: previousError ?? "catalog-304-without-cache" };
            return { record: { ...current, catalogSource }, result: false };
          }
          catalog[providerId] = { ...prior, checkedAt: outcome.checkedAt };
          catalogSource = { ...catalogSource, lastSuccessAt: outcome.checkedAt, lastError: previousError };
          const successesBySource = { ...(current.successesBySource ?? {}), [baseUrl]: outcome.checkedAt };
          return { record: { ...current, catalog, catalogSource, successesBySource }, result: true };
        }
        if (outcome.kind === "gone") {
          // 该供应商已在源上不可用（404/501）：spec#65 跨源仅有源错误必须**保留原有效 A 目录**，
          // 不能换成 models:[] 丢失已校验的新 ID/能力；ETag/lastModified 也保留并可作为同源再试的 304 依据。
          if (prior) {
            // 已有 A：不动 catalog、lastModified/etag/sourceBaseUrl；只标当前源 lastError，refresh.ok=false 如实呈现
            catalogSource = { ...catalogSource, lastError: previousError ?? "catalog-provider-gone" };
            return { record: { ...current, catalogSource }, result: false };
          }
          // 无 prior（新源首查 404）：标 lastError；后再重试到 200 仍能写入
          catalogSource = { ...catalogSource, lastError: previousError ?? "catalog-provider-gone" };
          return { record: { ...current, catalogSource }, result: false };
        }
        // failed：保留旧缓存与旧 etag，只更新来源错误
        catalogSource = { ...catalogSource, lastError: previousError ?? outcome.message };
        return { record: { ...current, catalogSource }, result: false };
      },
      // 紧邻 rename 再复核代次/来源/关闭：modify callback 已成立之后若换源/关闭/库重开，
      // 临时文件清理、旧 record 保留（不丢 cache 也不跨源 commit 旧资料）。
      () => {
        if (generation !== this.#generation) throw new Error("catalog-commit-stale-generation");
        if (this.#state.record.catalogSource.baseUrl !== baseUrl) throw new Error("catalog-commit-stale-source");
        if (this.#closed) throw new Error("catalog-closed");
      },
    );
      if (committed) return { committed: true, error: null };
      return { committed: false, error: outcome.kind === "failed" ? outcome.message : outcome.kind === "gone" ? "catalog-provider-gone" : outcome.kind === "not-modified" ? "catalog-304-without-cache" : null };
    } catch (err) {
      this.#options.diagnose?.("catalog-cache-commit-failed", err);
      // 已吊销（已换源/关闭/代次旧）：直接收束，不再尝试落 error 写盘（同 store 安全边界）
      if (generation !== this.#generation || this.#closed || this.#state.record.catalogSource.baseUrl !== baseUrl) {
        return { committed: false, error: "catalog-cache-commit-failed" };
      }
      // 仍是当前代次+源、未关闭：写盘失败必须呈 lastError 失败（不能 refresh ok:true）；原磁盘资料保持有效。
      // error 写也经同一 guard，不能在 rename 窗口被换源/关闭穿过把 error 写到错误源。
      await this.#options.store.modify(async (current) => ({
        record: {
          ...current,
          catalogSource: { ...current.catalogSource, lastError: "catalog-cache-commit-failed" },
        },
        result: undefined,
      }), () => {
        if (generation !== this.#generation) throw new Error("catalog-commit-stale-generation");
        if (this.#state.record.catalogSource.baseUrl !== baseUrl) throw new Error("catalog-commit-stale-source");
        if (this.#closed) throw new Error("catalog-closed");
      }).catch(() => undefined);
      return { committed: false, error: "catalog-cache-commit-failed" };
    }
  }

  /**
   * 更换公共目录来源：立即吊销旧源在途请求（代次 + abort），落盘新来源并完成一次真实检查；
   * 失败保留旧来源与有效目录。来源变化不自动替换当前模型。
   *
   * 同时只允许一次来源变更在途：第二个请求在**首个 await 前**被显式拒绝，既不覆盖 #sourceFlight
   * （否则 close 只截到最新句柄，旧的在途无人等待），也不让后来的请求等来别人的结果。
   * 相同来源的「仅刷新」同样不能绕过——它会落在本次变更的提交窗口里另起一代。
   *
   * 整段（等旧 refresh → 来源落盘 → 新源检查）登记为在途 flight，落盘另经 store.modify 的原子
   * beforeCommit 门禁复核代次与关闭，覆盖 temp 写完、紧邻 rename 之前插入的换源/关闭。
   */
  async setSource(baseUrl: string): Promise<SetSourceResult> {
    if (this.#closed) return { ok: false, issue: "closed", message: "目录服务已关闭" };
    if (this.#sourceFlight !== null) return { ok: false, issue: "refresh-failed", message: "catalog-source-busy" };
    // 已是当前源：仅刷新，不当换源（不清空 lastError）。它不写来源定义，因此不占来源 flight；
    // 但仍受上面的在途判定约束——不能落在某次换源的提交窗口里另起一代。
    if (this.#state.record.catalogSource.baseUrl === baseUrl) {
      const refresh = await this.#refreshNow();
      return refresh.ok ? { ok: true, revision: refresh.revision } : { ok: false, issue: "refresh-failed", message: refresh.message, revision: refresh.revision };
    }
    // 第一同步步骤登记来源 flight（无 await 窗口让 close 越过）；登记的就是调用方拿到的这个结果
    const flight: Promise<SetSourceResult> = this.#swapSource(baseUrl).finally(() => {
      if (this.#sourceFlight === flight) this.#sourceFlight = null;
    });
    this.#sourceFlight = flight;
    return flight;
  }

  async #swapSource(baseUrl: string): Promise<SetSourceResult> {
    // 吊销旧源在途：代次 + abort 双保险；旧结果提交点在 modify 中再核对（见 #commitCatalogOutcome）
    const generation = ++this.#generation;
    this.#refreshController?.abort();
    const priorFlight = this.#refreshFlight;
    if (priorFlight) await priorFlight.catch(() => undefined);
    // 关闭可能恰好落在上面这次 await 期间：入口判定已被越过，此处不再写新来源
    if (this.#closed) return { ok: false, issue: "closed", message: "目录服务已关闭" };
    const previousBaseUrl = this.#state.record.catalogSource.baseUrl;
    // 落盘新来源（提交点写盘成功才算换源）；来源变更不触碰凭据、选择与缓存正文
    try {
      await this.#options.store.modify(async (current) => ({
        record: { ...current, catalogSource: { ...current.catalogSource, baseUrl, lastError: null } },
        result: undefined,
      }), () => {
        if (generation !== this.#generation) throw new Error("catalog-source-stale-generation");
        if (this.#state.record.catalogSource.baseUrl !== previousBaseUrl) throw new Error("catalog-source-stale-source");
        if (this.#closed) throw new Error("catalog-closed");
      });
    } catch (err) {
      if (this.#closed) return { ok: false, issue: "closed", message: "目录服务已关闭" };
      this.#options.diagnose?.("catalog-source-commit-failed", err);
      return { ok: false, issue: "refresh-failed", message: "catalog-source-commit-failed" };
    }
    // 已过 rename 门禁并提交：已保存事实保留，不回滚、不伪报未保存。但本流程不得再晚发布
    // （bump 会把已关闭/已作废的来源当成当前来源推给界面）或晚启动新检查。
    if (this.#closed) return { ok: false, issue: "committed-not-checked", message: "catalog-source-saved-then-closed", revision: this.#state.revision };
    if (generation !== this.#generation) return { ok: false, issue: "committed-not-checked", message: "catalog-source-superseded", revision: this.#state.revision };
    this.#bump((s) => {
      s.record = { ...s.record, catalogSource: { ...s.record.catalogSource, baseUrl, lastError: null } };
    });
    // 新来源的真实检查：保存新来源并实际完成检查之前，不显示已更新（见 spec 在线目录节）
    const refresh = await this.#refreshNow();
    if (!refresh.ok) {
      return { ok: false, issue: "refresh-failed", message: refresh.message ?? "catalog-refresh-failed", revision: refresh.revision };
    }
    return { ok: true, revision: refresh.revision };
  }

  /**
   * 关闭：取消在途刷新与来源保存并等二者收束；之后不再发布任何变化。
   * 两个在途句柄同步取：close 之后的 setSource/refresh 在入口被拒，不会有新 flight 漏等。
   * 来源变更同时只许一次（见 setSource），因此不存在「只截到最新句柄、旧的在途仍悬空」。
   */
  async close(): Promise<void> {
    this.#closed = true;
    this.#generation += 1;
    this.#refreshController?.abort();
    const refreshFlight = this.#refreshFlight;
    const sourceFlight = this.#sourceFlight;
    if (refreshFlight) await refreshFlight.catch(() => undefined);
    if (sourceFlight) await sourceFlight.catch(() => undefined);
    this.#listeners.clear();
  }

  /** 登录成功后同步凭据存在性：bump revision 让界面看到 hasStoredKey 变化（不读秘密）。 */
  async noteCredentialChanged(providerId: string): Promise<void> {
    const record = await this.#options.store.read();
    if (!record) return;
    this.#bump((s) => { s.record = record; });
    void providerId;
  }

  /** 当前选择变更后同步（applyModel 提交成功后由 main 调用）。 */
  async noteSelectionChanged(): Promise<void> {
    const record = await this.#options.store.read();
    if (record) this.#bump((s) => { s.record = record; });
  }

  /** 测试与装配读取当前持久记录（不暴露凭据明文：credentials 仍是加密 base64）。 */
  currentRecord(): ProviderDirectoryRecord {
    return this.#state.record;
  }

  presetIds(): readonly string[] {
    return this.#options.presets.map((p) => p.id);
  }

  preset(id: string): RegisteredPresetProvider | undefined {
    return this.#presetsById.get(id);
  }
}

function safeBuiltinModels(provider: Provider): readonly Model<Api>[] {
  try {
    return provider.getModels();
  } catch {
    return [];
  }
}

function builtinToView(m: AnyModel): CatalogModelView | null {
  if ((m as { type?: string }).type !== undefined && (m as { type?: string }).type !== "chat") return null;
  const chat = m as Model<Api>;
  return {
    id: chat.id,
    name: chat.name ?? chat.id,
    contextWindow: chat.contextWindow,
    maxTokens: chat.maxTokens,
    input: [...chat.input],
    reasoning: chat.reasoning,
    cost: { input: chat.cost.input, output: chat.cost.output, cacheRead: chat.cost.cacheRead, cacheWrite: chat.cost.cacheWrite },
    source: "builtin",
    executable: true,
  };
}

function persistedToView(m: PersistedCatalogModel, apiIsLocal: (api: string) => boolean): CatalogModelView {
  const executable = apiIsLocal(m.api);
  return {
    id: m.id,
    name: m.name,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    input: [...m.input],
    reasoning: m.reasoning,
    cost: { ...m.cost },
    source: "remote",
    executable,
    ...(executable ? {} : { reason: `unknown-api:${m.api}` }),
  };
}
