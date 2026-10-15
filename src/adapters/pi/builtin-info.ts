// builtin 元信息与持久化转换的 pi 模块内部职责：main 不直接引用 pi-ai。
import { getBuiltinModelDataGeneratedAt } from "@earendil-works/pi-ai/providers/all";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { PersistedCatalogModel } from "@/contracts";

export function builtinCatalogGeneratedAt(): number {
  return getBuiltinModelDataGeneratedAt() ?? 0;
}

/** builtin 模型对象 → 允许持久化/装配的安全形状（只含安全模型信息）。 */
export function builtinModelToPersisted(m: Model<Api>, providerId: string): PersistedCatalogModel {
  return {
    id: m.id,
    name: m.name ?? m.id,
    api: m.api,
    provider: providerId,
    baseUrl: m.baseUrl,
    reasoning: m.reasoning,
    input: [...m.input],
    cost: { ...m.cost },
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    type: "chat",
  };
}
