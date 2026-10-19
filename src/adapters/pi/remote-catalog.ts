// 公共模型目录的联网异步检查：默认 https://pi.dev，请求 /api/models/providers/<id>?types=chat。
// 只发公共 GET + ETag（If-None-Match），不携带任何用户密钥/令牌/Authorization 头。
// 参考 Pi 官方 remote-catalog-provider.ts 的 URL/ETag/缓存/发布思路，但按 D Code 边界修正：
// - parse 必须做接收侧全形状校验，只保留 chat（实测 ?types=chat 的响应仍混入 classifier 条目）；
// - 不把远端 api/baseUrl 当作供应商身份/端点变更依据（供应商身份、协议与端点保持本地权威）；
// - 304 仅在有有效缓存正文时延长 freshness；没有缓存正文不能把「未变化」当作新目录。
//
// 并发与先后：调用方（ProviderDirectoryService）负责基线捕获与发布仲裁；这里只负责一次性
// 受限请求与解析，可取消、可超时，不自己写盘。

import type { CatalogCacheEntry, PersistedCatalogModel } from "@/contracts";

export const DEFAULT_CATALOG_BASE_URL = "https://pi.dev";
export const CATALOG_REQUEST_TIMEOUT_MS = 4_000;
export const USER_AGENT = "dcode/0.1.0-dev (pi catalog)";

export type CatalogFetchOutcome =
  | { kind: "ok"; entry: CatalogCacheEntry }
  | { kind: "not-modified"; checkedAt: number }
  | { kind: "gone"; checkedAt: number } // 404/501：该供应商在源上不可用
  | { kind: "failed"; message: string };

const CHAT_APIS_CHECK = /^[a-z0-9][a-z0-9-]*$/;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** 接收侧全字段校验 + 白名单投影（不落 api 之外的执行字段，如 headers/compat/execute）。 */
export function sanitizeCatalogModel(providerId: string, raw: unknown): PersistedCatalogModel | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  // 必须显式过滤到 chat：服务器不保证只返回 chat  shard
  if (m.type !== undefined && m.type !== "chat") return null;
  if (typeof m.id !== "string" || m.id.length === 0 || m.id.length > 256) return null;
  if (typeof m.api !== "string" || !CHAT_APIS_CHECK.test(m.api)) return null;
  if (typeof m.baseUrl !== "string" || !/^https?:\/\//.test(m.baseUrl)) return null;
  if (typeof m.reasoning !== "boolean") return null;
  if (!Array.isArray(m.input) || m.input.length === 0 || !m.input.every((i) => i === "text" || i === "image")) return null;
  const c = m.cost;
  if (typeof c !== "object" || c === null) return null;
  const cost = c as Record<string, unknown>;
  if (!isFiniteNumber(cost.input) || !isFiniteNumber(cost.output) || !isFiniteNumber(cost.cacheRead) || !isFiniteNumber(cost.cacheWrite)) return null;
  if (!isFiniteNumber(m.contextWindow) || m.contextWindow <= 0 || m.contextWindow > 10_000_000) return null;
  if (!isFiniteNumber(m.maxTokens) || m.maxTokens <= 0 || m.maxTokens > 10_000_000) return null;
  const name = typeof m.name === "string" && m.name.length > 0 ? m.name : m.id;
  return {
    id: m.id,
    name,
    api: m.api,
    provider: providerId,
    baseUrl: m.baseUrl,
    reasoning: m.reasoning,
    input: [...m.input] as Array<"text" | "image">,
    cost: {
      input: cost.input as number,
      output: cost.output as number,
      cacheRead: cost.cacheRead as number,
      cacheWrite: cost.cacheWrite as number,
    },
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    type: "chat",
  };
}

function parseCatalogEntries(providerId: string, value: unknown): PersistedCatalogModel[] {
  const entries = Array.isArray(value)
    ? value
    : typeof value === "object" && value !== null && "models" in value && Array.isArray((value as { models: unknown }).models)
      ? (value as { models: unknown[] }).models
      : undefined;
  if (!entries) throw new Error("catalog-shape-invalid");
  const out: PersistedCatalogModel[] = [];
  const seen = new Set<string>();
  for (const raw of entries) {
    // classifier（声明 type 非 chat 的合法行）可滤；
    // 但 type=chat / type 缺席的行若校验缺失必要字段，视作该源返回非法——整份目录失败，
    // 不能静默成空 ok 覆盖最后有效 A（独审实路阻塞②）。
    const r = raw as Record<string, unknown> | null;
    const declaredType = r && typeof r === "object" ? r.type : undefined;
    const isClassifier = typeof declaredType === "string" && declaredType !== "chat";
    const model = sanitizeCatalogModel(providerId, raw);
    if (!model) {
      if (isClassifier) continue;
      throw new Error("catalog-shape-invalid");
    }
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    out.push(model);
  }
  return out;
}

export interface FetchCatalogOptions {
  baseUrl: string;
  providerId: string;
  /** 只由本地固定 SDK 兼容适配提供，不能接受远端自报的身份。 */
  remoteProviderId?: string;
  /** 仅当本地确有有效缓存正文时传入；304 语义才能成立 */
  etag?: string;
  signal?: AbortSignal;
  /** 测试注入；缺省全局 fetch */
  fetchImpl?: typeof fetch;
}

/** 单供应商公共目录检查：不携带认证，无模型探针，无写入副作用。 */
export async function fetchProviderCatalog(options: FetchCatalogOptions): Promise<CatalogFetchOutcome> {
  const url = new URL(`/api/models/providers/${encodeURIComponent(options.remoteProviderId ?? options.providerId)}`, options.baseUrl);
  url.searchParams.set("types", "chat");
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(new Error("catalog-timeout")); }, CATALOG_REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort(options.signal?.reason instanceof Error ? options.signal.reason : new Error("catalog-cancelled"));
  if (options.signal) {
    if (options.signal.aborted) {
      clearTimeout(timeout);
      throw Object.assign(new Error("catalog-cancelled"), { name: "AbortError" });
    }
    options.signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": USER_AGENT,
        ...(options.etag ? { "if-none-match": options.etag } : {}),
      },
      signal: controller.signal,
    });
    const checkedAt = Date.now();
    if (response.status === 304) {
      if (!options.etag) return { kind: "failed", message: "catalog-304-without-cache" };
      return { kind: "not-modified", checkedAt };
    }
    if (response.status === 404 || response.status === 501) return { kind: "gone", checkedAt };
    if (!response.ok) return { kind: "failed", message: `catalog-http-${response.status}` };
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return { kind: "failed", message: "catalog-json-invalid" };
    }
    let models: PersistedCatalogModel[];
    try {
      models = parseCatalogEntries(options.providerId, json);
    } catch {
      return { kind: "failed", message: "catalog-shape-invalid" };
    }
    const lastModifiedHeader = response.headers.get("last-modified");
    const lastModified = lastModifiedHeader ? Date.parse(lastModifiedHeader) : Number.NaN;
    const entry: CatalogCacheEntry = {
      models,
      checkedAt,
      lastModified: Number.isNaN(lastModified) ? 0 : lastModified,
      etag: response.headers.get("etag") ?? undefined,
    };
    return { kind: "ok", entry };
  } catch (err) {
    if (controller.signal.aborted) {
      if (timedOut) {
        // 自身 4s 超时是真实检查失败（lastError 必须呈现）；不能借 AbortError 冒名外部取消让调用方吞掉 lastError。
        return { kind: "failed", message: "catalog-timeout" };
      }
      // 区分用户/关闭取消与外部中断；照常抛 AbortError 收束（调用方按关闭/换源语义处理）
      const reason = (err as Error)?.message ?? "catalog-aborted";
      throw Object.assign(new Error(reason.includes("timeout") ? "catalog-timeout" : "catalog-cancelled"), { name: "AbortError" });
    }
    const msg = (err as Error)?.message ?? String(err);
    return { kind: "failed", message: msg.startsWith("catalog-") ? msg : "catalog-network-failed" };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/** 目录请求不得出现认证信息的自检：headers 白名单只有 accept/user-agent/if-none-match。 */
export function buildCatalogHeaders(etag?: string): Record<string, string> {
  return {
    accept: "application/json",
    "user-agent": USER_AGENT,
    ...(etag ? { "if-none-match": etag } : {}),
  };
}
