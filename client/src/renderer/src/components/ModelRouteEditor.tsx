import { useState } from "react";
import useSWR from "swr";
import { ArrowUp, ArrowDown, X, Plus, RefreshCw } from "lucide-react";
import { api, errorText } from "../types";
import type { ModelChoice } from "../../../../../host/src/model-catalog-view.js";
import type { AgentModelCandidate } from "../../../../../host/src/model-route.js";
import type { ModelQuotaSnapshot, QuotaAssessment } from "../../../../../host/src/model-quota.js";

export interface ModelRouteDraft { id: string; model: AgentModelCandidate }
interface QuotaView { snapshots: ModelQuotaSnapshot[]; assessments: Array<QuotaAssessment & AgentModelCandidate> }

export function ModelRouteEditor({ value, onChange, models, busy }: {
  value: ModelRouteDraft[];
  onChange: (value: ModelRouteDraft[]) => void;
  models: ModelChoice[];
  busy: boolean;
}) {
  const { data, error, mutate } = useSWR<QuotaView>("model-quota-settings", () => api().request("dcodeModels.quotas"), { revalidateOnFocus: false, refreshInterval: 60_000 });
  const [refreshing, setRefreshing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const refresh = async () => {
    setRefreshing(true); setFailure(null);
    try { await mutate(await api().request<QuotaView>("dcodeModels.quotas", { force: true }), false); }
    catch (error) { setFailure(errorText(error)); }
    finally { setRefreshing(false); }
  };
  const move = (index: number, direction: number) => {
    const next = value.slice();
    [next[index], next[index + direction]] = [next[index + direction], next[index]];
    onChange(next);
  };
  return <section className="model-route-editor" aria-label="模型回退顺序">
    <div className="model-route-heading"><h3>模型回退顺序</h3><button type="button" className="text-button" disabled={refreshing || busy} onClick={() => void refresh()}><RefreshCw size={13} />{refreshing ? "正在查询…" : "刷新配额"}</button></div>
    <p className="secondary">按顺序选择可用模型。适用剩余额度高于 1% 才会自动选用，低额度或未知时检查下一个。</p>
    {value.length === 0 && <p className="secondary">未单独配置，将沿用创建成员时主对话选用的模型。</p>}
    <ol className="model-route-list">
      {value.map((entry, index) => {
        const model = models.find((model) => model.providerId === entry.model.providerId && model.modelId === entry.model.modelId);
        const key = model?.key ?? (entry.model.modelId ? `${entry.model.providerId}::${entry.model.modelId}` : "");
        const assessment = data?.assessments.find((item) => item.providerId === entry.model.providerId && item.modelId === entry.model.modelId);
        const quota = data?.snapshots.find((item) => item.providerId === entry.model.providerId);
        const status = !key ? "请选择一个模型" : !model ? "原模型已不在目录中" : !model.enabled ? "未启用，派发时会跳过" : !model.available ? "当前不可访问" : assessment?.reason ?? "正在查询额度…";
        return <li key={entry.id} className="model-route-row">
          <label className="model-route-choice"><span>{index === 0 ? "首选" : `备用 ${index}`}</span><select aria-label={`候选模型 ${index + 1}`} disabled={busy} value={key} onChange={(event) => {
            const selected = models.find((item) => item.key === event.target.value);
            if (selected) onChange(value.map((item) => item.id === entry.id ? { ...item, model: { providerId: selected.providerId, modelId: selected.modelId } } : item));
          }}><option value="">选择模型</option>{!model && key && <option value={key}>{entry.model.modelId}（已不可用）</option>}{models.filter((candidate) => candidate.enabled && candidate.available || candidate.key === key).map((candidate) => <option key={candidate.key} value={candidate.key} disabled={value.some((item) => item.id !== entry.id && item.model.providerId === candidate.providerId && item.model.modelId === candidate.modelId)}>{candidate.providerName} · {candidate.name}</option>)}</select>
            <small className="secondary" aria-live="polite">{status}{assessment?.remainingPercent !== undefined ? ` · 剩余 ${Number(assessment.remainingPercent.toFixed(2))}%` : ""}{quota ? ` · ${new Date(quota.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}更新` : ""}</small>
          </label>
          <div className="model-route-actions"><button type="button" className="icon-button" aria-label={`上移候选 ${index + 1}`} disabled={busy || index === 0} onClick={() => move(index, -1)}><ArrowUp size={14} /></button><button type="button" className="icon-button" aria-label={`下移候选 ${index + 1}`} disabled={busy || index === value.length - 1} onClick={() => move(index, 1)}><ArrowDown size={14} /></button><button type="button" className="icon-button" aria-label={`移除候选 ${index + 1}`} disabled={busy} onClick={() => onChange(value.filter((item) => item.id !== entry.id))}><X size={14} /></button></div>
        </li>;
      })}
    </ol>
    <button type="button" className="text-button" disabled={busy || value.length >= 32 || value.some((row) => !row.model.modelId)} onClick={() => onChange([...value, { id: crypto.randomUUID(), model: { providerId: "", modelId: "" } }])}><Plus size={14} />添加备用模型</button>
    {(failure || error) && <p role="alert" className="inline-error">{failure ?? errorText(error)}</p>}
  </section>;
}
