// Query/normalization adapted from 507's MIT-licensed pi-dusage (0.2.0).
// Host-owned data only: no TUI imports and no direct reading of Pi credentials.
import { createHash } from "node:crypto";
import { redactCredentialText } from "./credential-material.js";
import type { ModelAuth } from "@earendil-works/pi-ai";

export type QuotaProvider = "openai-codex" | "zai-coding-cn" | "minimax-cn";
export interface QuotaWindow {
  id: string;
  label: string;
  remainingPercent: number | null;
  resetAt: number | null;
  capability: "text" | "search" | "video_generation" | "image_generation" | "audio_generation";
}
export interface QuotaGroup { id: string; label: string; modelIds?: string[]; windows: QuotaWindow[] }
export interface ModelQuotaSnapshot {
  providerId: string;
  poolId: string;
  fetchedAt: number;
  validUntil: number;
  status: "known" | "unknown" | "rate_limited";
  groups: QuotaGroup[];
  error?: string;
  retryAt?: number;
}
export interface QuotaCredential {
  auth: ModelAuth;
  sourceBaseUrl: string;
  /** Optional safe identity from the credential bridge, never a raw account ID. */
  connectionId?: string;
}
const endpoints: Record<QuotaProvider, string> = {
  "openai-codex": "https://chatgpt.com/backend-api/wham/usage",
  "zai-coding-cn": "https://bigmodel.cn/api/monitor/usage/quota/limit",
  "minimax-cn": "https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains",
};
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const number = (value: unknown): number | null => (typeof value === "number" || typeof value === "string" && value.trim() !== "") && Number.isFinite(Number(value)) ? Number(value) : null;
const percent = (value: unknown): number | null => { const n = number(value); return n !== null && n >= 0 && n <= 100 ? n : null; };
const remaining = (used: unknown): number | null => { const n = percent(used); return n === null ? null : 100 - n; };
function reset(value: unknown): number | null {
  const n = number(value);
  if (n !== null && n > 0) return n < 100_000_000_000 ? n * 1000 : n;
  if (typeof value === "string") { const parsed = Date.parse(value); if (Number.isFinite(parsed)) return parsed; }
  return null;
}
function label(value: unknown, fallback: string): string {
  return typeof value === "string" && !redactCredentialText(value).redacted && /^[\p{L}\p{N} _.:()+/\-]{1,100}$/u.test(value) ? value : fallback;
}
function codexWindows(value: unknown): QuotaWindow[] {
  const limits = record(value);
  return ["primary_window", "secondary_window"].flatMap((key) => {
    if (!limits[key]) return [];
    const window = record(limits[key]);
    const seconds = number(window.limit_window_seconds);
    return [{ id: key, label: seconds === null ? key === "primary_window" ? "短期额度" : "长期额度" : `${seconds / 3600} 小时`,
      remainingPercent: limits.allowed === false || limits.limit_reached === true ? 0 : remaining(window.used_percent), resetAt: reset(window.reset_at), capability: "text" as const }];
  });
}

export function parseQuotaGroups(provider: QuotaProvider, body: unknown): QuotaGroup[] {
  const data = record(body);
  if (provider === "openai-codex") {
    if (!data.rate_limit) throw new Error("配额响应缺少通用额度");
    const groups: QuotaGroup[] = [{ id: "general", label: "通用额度", windows: codexWindows(data.rate_limit) }];
    for (const value of array(data.additional_rate_limits)) {
      const item = record(value);
      if (typeof item.metered_feature !== "string" || !/^[a-zA-Z0-9_.:-]{1,120}$/.test(item.metered_feature)) throw new Error("模型专属额度缺少可识别范围");
      const models = array(item.model_ids).filter((id): id is string => typeof id === "string" && id.length <= 200);
      groups.push({ id: item.metered_feature, label: label(item.limit_name, "模型专属额度"), ...(models.length ? { modelIds: models } : {}), windows: codexWindows(item.rate_limit) });
    }
    return groups;
  }
  if (provider === "zai-coding-cn") {
    const payload = record(data.data);
    if (data.success !== true || number(data.code) !== 200 || !Array.isArray(payload.limits)) throw new Error("智谱没有返回有效配额");
    const windows = payload.limits.map((raw, index): QuotaWindow => {
      const limit = record(raw);
      const type = String(limit.type ?? "unknown");
      return { id: typeof limit.id === "string" ? limit.id : `${type}:${String(limit.number ?? "")}:${String(limit.unit ?? "")}:${index}`,
        label: type === "TIME_LIMIT" ? "搜索次数" : limit.unit === 3 && limit.number === 5 ? "5 小时" : label(limit.type, "额度窗口"),
        remainingPercent: type === "TOKENS_LIMIT" || type === "TIME_LIMIT" ? remaining(limit.percentage) : null, resetAt: reset(limit.nextResetTime), capability: type === "TIME_LIMIT" ? "search" : "text" };
    });
    return [{ id: "general", label: "订阅额度", windows }];
  }
  if (number(record(data.base_resp).status_code) !== 0 || !Array.isArray(data.model_remains)) throw new Error("MiniMax 没有返回有效配额");
  return data.model_remains.flatMap((raw): QuotaGroup[] => {
    const item = record(raw);
    const name = typeof item.model_name === "string" ? item.model_name : "unknown";
    const id = name === "general" ? "general" : `minimax:${createHash("sha256").update(name).digest("hex").slice(0, 20)}`;
    const capabilities: Record<string, QuotaWindow["capability"]> = { video: "video_generation", image: "image_generation", audio: "audio_generation", music: "audio_generation", speech: "audio_generation" };
    const capability = capabilities[name] ?? "text";
    const models = array(item.model_ids).filter((id): id is string => typeof id === "string" && id.length <= 200 && !redactCredentialText(id).redacted);
    return [{ id, label: name === "general" ? "通用额度" : label(name, "待确认额度"), ...(models.length ? { modelIds: models } : {}), windows: [
      { id: `${id}-5h`, label: "5 小时", remainingPercent: percent(item.current_interval_remaining_percent), resetAt: reset(item.end_time), capability },
      { id: `${id}-week`, label: "每周", remainingPercent: percent(item.current_weekly_remaining_percent), resetAt: reset(item.weekly_end_time), capability },
    ] }];
  });
}

export interface QuotaAssessment { eligible: boolean; reason: string; remainingPercent?: number; retryAt?: number }
export function assessModelQuota(snapshot: ModelQuotaSnapshot, modelId: string, now: number, capabilities: readonly string[] = []): QuotaAssessment {
  if (snapshot.status !== "known") return { eligible: false, reason: snapshot.error ?? (snapshot.status === "rate_limited" ? "暂时限流" : "额度未知"), retryAt: snapshot.retryAt };
  if (now >= snapshot.validUntil) return { eligible: false, reason: "额度信息已过期" };
  const general = snapshot.groups.filter((group) => group.id === "general");
  const additional = snapshot.groups.filter((group) => group.id !== "general");
  // An unnamed extra bucket is not proof that it applies (or does not apply)
  // to this model. A verified model mapping is required before automatic selection.
  if (additional.some((group) => !group.modelIds && group.windows.some((window) => window.capability === "text"))) return { eligible: false, reason: "模型专属额度范围尚未确认" };
  const groups = [...general, ...additional.filter((group) => group.modelIds?.includes(modelId) || group.windows.some((window) => capabilities.includes(window.capability)))];
  const windows = groups.flatMap((group) => group.windows).filter((window) => window.capability === "text" || capabilities.includes(window.capability));
  if (!windows.length || groups.some((group) => !group.windows.length) || windows.some((window) => window.remainingPercent === null)) return { eligible: false, reason: "额度字段不完整" };
  const quotaCapabilities = capabilities.filter((capability) => ["search", "video_generation", "image_generation", "audio_generation"].includes(capability));
  if (quotaCapabilities.some((capability) => !windows.some((window) => window.capability === capability))) return { eligible: false, reason: "未返回所需功能的额度窗口" };
  if (windows.some((window) => window.resetAt !== null && now >= window.resetAt)) return { eligible: false, reason: "额度已到重置时间，需要重新查询" };
  const least = Math.min(...windows.map((window) => window.remainingPercent!));
  if (least <= 1) return { eligible: false, reason: least === 0 ? "额度已耗尽" : "剩余额度不高于 1%", remainingPercent: least,
    retryAt: Math.max(...windows.filter((window) => window.remainingPercent! <= 1).map((window) => window.resetAt ?? 0)) || undefined };
  return { eligible: true, reason: "额度可用", remainingPercent: least };
}

export class ModelQuotaService {
  private readonly cache = new Map<string, ModelQuotaSnapshot>();
  private readonly generations = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<ModelQuotaSnapshot>>();
  constructor(private readonly options: {
    offline?: () => boolean;
    resolveCredential: (providerId: string) => Promise<QuotaCredential | undefined>;
    fetch?: typeof fetch;
    now?: () => number;
    maxAgeMs?: number;
    onUpdated?: (snapshot: ModelQuotaSnapshot) => void;
  }) {}

  private now(): number { return this.options.now?.() ?? Date.now(); }
  private unknown(providerId: string, poolId: string, error: string): ModelQuotaSnapshot {
    const now = this.now();
    return { providerId, poolId, fetchedAt: now, validUntil: now, status: "unknown", groups: [], error };
  }
  async get(providerId: string, force = false): Promise<ModelQuotaSnapshot> {
    if(this.options.offline?.())return this.unknown(providerId,providerId,"当前处于离线模式");
    if (!Object.hasOwn(endpoints, providerId)) return this.unknown(providerId, providerId, "暂不支持此来源的配额查询");
    const provider = providerId as QuotaProvider;
    let credential: QuotaCredential | undefined;
    try { credential = await this.options.resolveCredential(providerId); } catch { return this.unknown(providerId, providerId, "无法取得有效访问条件"); }
    if (!credential) return this.unknown(providerId, providerId, "尚未连接供应商");
    const allowedHosts: Record<QuotaProvider, string[]> = { "openai-codex": ["chatgpt.com"], "zai-coding-cn": ["bigmodel.cn", "open.bigmodel.cn"], "minimax-cn": ["api.minimaxi.com"] };
    let origin: URL;
    try { origin = new URL(credential.auth.baseUrl ?? credential.sourceBaseUrl); } catch { return this.unknown(providerId, providerId, "无法确认配额连接来源"); }
    if (origin.protocol !== "https:" || origin.username || origin.password || !allowedHosts[provider].includes(origin.hostname)) return this.unknown(providerId, providerId, "当前连接不是已验证的配额来源");
    const headers = new Headers(Object.entries(credential.auth.headers ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    const token = credential.auth.apiKey ?? headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (!token) return this.unknown(providerId, providerId, "此连接没有可用的配额查询方式");
    const account = headers.get("ChatGPT-Account-Id");
    const poolId = `quota-${createHash("sha256").update(`${provider}\0${credential.connectionId ?? account ?? token}`).digest("hex")}`;
    const existing = this.cache.get(poolId);
    if (existing?.status === "rate_limited" && this.now() < (existing.retryAt ?? 0)) return structuredClone(existing);
    if (!force && existing && this.now() < existing.validUntil) return structuredClone(existing);
    const pending = this.inFlight.get(poolId);
    if (pending) return structuredClone(await pending);
    const generation = this.generations.get(poolId) ?? 0;
    const request = this.query(provider, poolId, token, account).then((snapshot) => {
      if ((this.generations.get(poolId) ?? 0) !== generation) return this.unknown(providerId, poolId, "查询期间额度状态已改变，需要重新确认");
      this.cache.set(poolId, snapshot);
      try { this.options.onUpdated?.(structuredClone(snapshot)); } catch { /* Display observers do not own the quota result. */ }
      return snapshot;
    }).finally(() => { this.inFlight.delete(poolId); });
    this.inFlight.set(poolId, request);
    return structuredClone(await request);
  }

  invalidate(poolId: string, reason = "额度状态需要刷新"): void {
    this.generations.set(poolId, (this.generations.get(poolId) ?? 0) + 1);
    const previous = this.cache.get(poolId);
    if (previous) this.cache.set(poolId, { ...previous, validUntil: 0, status: "unknown", error: reason });
  }
  blockProvider(providerId:string,retryAfter?:string):void {
    const seconds=Number(retryAfter);
    const parsed=retryAfter?Date.parse(retryAfter):NaN;
    const retryAt=Number.isFinite(seconds)&&seconds>0?this.now()+seconds*1000:Number.isFinite(parsed)&&parsed>this.now()?parsed:this.now()+60_000;
    for(const [poolId,previous] of this.cache) if(previous.providerId===providerId) {
      this.generations.set(poolId,(this.generations.get(poolId)??0)+1);
      const snapshot:ModelQuotaSnapshot={...previous,status:"rate_limited",validUntil:retryAt,retryAt,error:"供应商已限流，暂时跳过此额度池"};
      this.cache.set(poolId,snapshot);
      try{this.options.onUpdated?.(structuredClone(snapshot));}catch{}
    }
  }

  async collect(providerIds: readonly string[], force = false): Promise<ModelQuotaSnapshot[]> {
    return Promise.all([...new Set(providerIds)].map((providerId) => this.get(providerId, force).catch(() => this.unknown(providerId, providerId, "配额查询失败"))));
  }

  private async query(provider: QuotaProvider, poolId: string, token: string, account: string | null): Promise<ModelQuotaSnapshot> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const headers: Record<string, string> = { Authorization: provider === "zai-coding-cn" ? token : `Bearer ${token}`, Accept: "application/json" };
      if (provider === "openai-codex" && account) headers["ChatGPT-Account-Id"] = account;
      const response = await (this.options.fetch ?? fetch)(endpoints[provider], { headers, signal: controller.signal, redirect: "error" });
      if (response.status === 429) {
        const retry = response.headers.get("retry-after");
        const retrySeconds = number(retry);
        const retryAt = retrySeconds !== null ? this.now() + Math.max(0, retrySeconds) * 1000 : reset(retry);
        return { ...this.unknown(provider, poolId, "配额查询暂时限流"), status: "rate_limited", retryAt: retryAt ?? undefined };
      }
      if (!response.ok) return this.unknown(provider, poolId, response.status === 401 || response.status === 403 ? "供应商拒绝了配额查询" : `配额查询失败（${response.status}）`);
      const reader = response.body?.getReader();
      if (!reader) return this.unknown(provider, poolId, "配额响应为空");
      const chunks: Uint8Array[] = []; let size = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 2_000_000) { await reader.cancel(); return this.unknown(provider, poolId, "配额响应超出大小限制"); }
        chunks.push(part.value);
      }
      const groups = parseQuotaGroups(provider, JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const now = this.now();
      const resets = groups.flatMap((group) => group.windows).flatMap((window) => window.resetAt !== null && window.resetAt > now ? [window.resetAt] : []);
      return { providerId: provider, poolId, fetchedAt: now, validUntil: Math.min(now + (this.options.maxAgeMs ?? 60_000), ...resets), status: "known", groups };
    } catch { return this.unknown(provider, poolId, controller.signal.aborted ? "配额查询超时" : "配额响应无法确认"); }
    finally { clearTimeout(timer); }
  }
}
