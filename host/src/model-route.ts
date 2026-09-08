// Ordered candidate semantics adapted from 507's pi-dteam model-routing.
import { redactCredentialText } from "./credential-material.js";
import { assessModelQuota, type ModelQuotaService, type ModelQuotaSnapshot } from "./model-quota.js";

export interface AgentModelCandidate { providerId: string; modelId: string }
export interface RouteModel { providerId: string; modelId: string; enabled: boolean; available: boolean; input?: string[]; contextWindow?: number | null }
export interface ModelRouteDecision {
  selected: AgentModelCandidate | null;
  considered: Array<{ candidate: AgentModelCandidate; eligible: boolean; reason: string; poolId?: string; fetchedAt?: number; remainingPercent?: number }>;
}

export function agentModelCandidates(value: unknown): AgentModelCandidate[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) throw new Error("模型回退链必须包含1至32个候选");
  const seen = new Set<string>();
  return value.flatMap((entry): AgentModelCandidate[] => {
    if (!entry || typeof entry !== "object") throw new Error("模型候选格式无效");
    const candidate = entry as Record<string, unknown>;
    for (const key of ["providerId", "modelId"]) if (typeof candidate[key] !== "string" || !candidate[key] || String(candidate[key]).length > 200 || redactCredentialText(String(candidate[key])).redacted || /[\r\n\0]/.test(String(candidate[key]))) throw new Error("模型候选身份无效");
    if (Object.keys(candidate).some((key) => key !== "providerId" && key !== "modelId")) throw new Error("模型候选包含不支持的字段");
    const result: AgentModelCandidate = { providerId: candidate.providerId as string, modelId: candidate.modelId as string };
    const key = JSON.stringify([result.providerId, result.modelId]);
    if (seen.has(key)) return [];
    seen.add(key);
    return [result];
  });
}

export async function chooseAgentModel(input: {
  candidates: AgentModelCandidate[];
  thresholdPercent: number;
  models: readonly RouteModel[];
  quotas: Pick<ModelQuotaService, "get">;
  now?: () => number;
  capabilities?: readonly string[];
  minimumContext?: number;
  excludedPools?: ReadonlySet<string>;
}): Promise<ModelRouteDecision> {
  const considered: ModelRouteDecision["considered"] = [];
  const snapshots = new Map<string, Promise<ModelQuotaSnapshot>>();
  for (const candidate of input.candidates) {
    const model = input.models.find((value) => value.providerId === candidate.providerId && value.modelId === candidate.modelId);
    let reason: string | undefined;
    if (!model) reason = "模型已不在目录中";
    else if (!model.enabled) reason = "模型未启用";
    else if (!model.available) reason = "模型当前不可访问";
    else if (input.minimumContext && (model.contextWindow ?? 0) < input.minimumContext) reason = "上下文容量不足";
    else if (input.capabilities?.includes("image") && !model.input?.includes("image")) reason = "模型不支持图片输入";
    if (reason) { considered.push({ candidate, eligible: false, reason }); continue; }
    let quota: ModelQuotaSnapshot;
    try {
      let pending = snapshots.get(candidate.providerId);
      if (!pending) { pending = input.quotas.get(candidate.providerId); snapshots.set(candidate.providerId, pending); }
      quota = await pending;
    }
    catch { considered.push({ candidate, eligible: false, reason: "额度查询失败" }); continue; }
    const assessment = input.excludedPools?.has(quota.poolId) ? { eligible: false, reason: "该额度池已停止新派发" } : assessModelQuota(quota, candidate.modelId, input.now?.() ?? Date.now(), input.thresholdPercent, input.capabilities);
    considered.push({ candidate, ...assessment, poolId: quota.poolId, fetchedAt: quota.fetchedAt });
    if (assessment.eligible) return { selected: candidate, considered };
  }
  return { selected: null, considered };
}
