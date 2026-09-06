import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
  FoundationSnapshot,
  RuntimeModelCatalogProviderInput,
} from "./product-store.js";
import { redactCredentialText } from "./credential-material.js";
export interface CatalogProviderInput {
  id: string;
  name: string;
  baseUrl: string;
  apiKind: string;
  credentialEnv: string;
  keepExistingAuth?: boolean;
  adoptExisting?: boolean;
  compatJson?: string;
  models: {
    modelId: string;
    name: string;
    reasoning: boolean;
    contextWindow: number;
    maxTokens: number;
    api?: string;
    baseUrl?: string;
  }[];
}
export function catalogProviderInput(value: unknown): CatalogProviderInput {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("供应商配置格式无效");
  const p = value as Record<string, unknown>;
  const string = (key: string, max = 200) => {
    const v = p[key];
    if (
      typeof v !== "string" ||
      !v.trim() ||
      v.length > max ||
      redactCredentialText(v).redacted
    )
      throw new Error(`${key} 无效`);
    return v.trim();
  };
  const id = string("id"),
    name = string("name"),
    baseUrl = string("baseUrl", 4096),
    apiKind = string("apiKind"),
    credentialEnv = p.keepExistingAuth === true ? "" : string("credentialEnv");
  if (
    p.keepExistingAuth !== true &&
    !/^[A-Za-z_][A-Za-z0-9_]{0,199}$/.test(credentialEnv)
  )
    throw new Error("请填写环境变量名称，不要填写密钥正文");
  const url = new URL(baseUrl);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("请输入不含认证信息的 API 地址");
  if (
    ![
      "openai-completions",
      "mistral-conversations",
      "openai-responses",
      "azure-openai-responses",
      "openai-codex-responses",
      "anthropic-messages",
      "bedrock-converse-stream",
      "google-generative-ai",
      "google-vertex",
      "pi-messages",
    ].includes(apiKind)
  )
    throw new Error("暂不支持此 API 协议");
  if (!Array.isArray(p.models) || !p.models.length || p.models.length > 2048)
    throw new Error("至少需要一个模型");
  const seen = new Set<string>();
  const models = p.models.map((v: unknown) => {
    if (!v || typeof v !== "object") throw new Error("模型格式无效");
    const m = v as Record<string, unknown>;
    for (const key of ["modelId", "name"])
      if (
        typeof m[key] !== "string" ||
        !(m[key] as string).trim() ||
        (m[key] as string).length > 200 ||
        redactCredentialText(m[key] as string).redacted
      )
        throw new Error("模型 ID 和名称不可为空");
    if (seen.has(m.modelId as string)) throw new Error("模型 ID 重复");
    seen.add(m.modelId as string);
    for (const key of ["contextWindow", "maxTokens"])
      if (!Number.isSafeInteger(m[key]) || (m[key] as number) < 1)
        throw new Error("模型长度必须为正整数");
    if (typeof m.reasoning !== "boolean") throw new Error("推理能力必须明确");
    if (
      m.api !== undefined &&
      (typeof m.api !== "string" ||
        (m.api &&
          ![
            "openai-completions",
            "mistral-conversations",
            "openai-responses",
            "azure-openai-responses",
            "openai-codex-responses",
            "anthropic-messages",
            "bedrock-converse-stream",
            "google-generative-ai",
            "google-vertex",
            "pi-messages",
          ].includes(m.api)))
    )
      throw new Error("模型 API 协议无效");
    if (m.baseUrl !== undefined) {
      if (typeof m.baseUrl !== "string") throw new Error("模型地址无效");
      if (m.baseUrl) {
        const url = new URL(m.baseUrl);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          throw new Error("模型地址不得包含认证信息");
      }
    }
    return {
      ...(m.api !== undefined ? { api: m.api as string } : {}),
      ...(m.baseUrl !== undefined ? { baseUrl: m.baseUrl as string } : {}),
      modelId: (m.modelId as string).trim(),
      name: (m.name as string).trim(),
      reasoning: m.reasoning,
      contextWindow: m.contextWindow as number,
      maxTokens: m.maxTokens as number,
    };
  });
  let compatJson: string | undefined;
  if (typeof p.compatJson === "string" && p.compatJson.trim()) {
    const value = JSON.parse(p.compatJson);
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      redactCredentialText(p.compatJson).redacted ||
      /"(?:apiKey|api_key|authorization|accessToken|refreshToken|password|secret|headers)"\s*:/i.test(
        p.compatJson,
      )
    )
      throw new Error("兼容性参数必须是无凭据的 JSON 对象");
    compatJson = JSON.stringify(value);
  }
  return {
    id,
    name,
    baseUrl,
    apiKind,
    credentialEnv,
    models,
    keepExistingAuth: p.keepExistingAuth === true,
    adoptExisting: p.adoptExisting === true,
    ...(compatJson ? { compatJson } : {}),
  };
}
export function providerCatalogSeed(
  input: CatalogProviderInput,
  existingAuthConfigured = false,
): RuntimeModelCatalogProviderInput {
  return {
    id: input.id,
    name: input.name,
    baseUrl: input.baseUrl,
    apiKind: input.apiKind,
    authMode: input.keepExistingAuth ? "external_reference" : "environment",
    nonsecret: {
      source: "dcode_custom",
      credentialEnv: input.credentialEnv,
      keepExistingAuth: input.keepExistingAuth === true,
      ...(input.compatJson ? { compat: JSON.parse(input.compatJson) } : {}),
    },
    credential: {
      locator: input.keepExistingAuth
        ? `pi-runtime-auth-bridge:${input.id}`
        : `environment:${input.credentialEnv}`,
      configured: input.keepExistingAuth
        ? existingAuthConfigured
        : !!process.env[input.credentialEnv],
    },
    models: input.models.map((m) => ({
      ...m,
      nonsecret: {
        ...(m.api !== undefined ? { apiOverride: m.api || null } : {}),
        ...(m.baseUrl !== undefined
          ? { baseUrlOverride: m.baseUrl || null }
          : {}),
      },
    })),
  };
}
const nativeRegistrations = new WeakMap<ModelRuntime, Set<string>>();

export async function registerCatalogProviders(
  runtime: ModelRuntime,
  snapshot: FoundationSnapshot,
): Promise<void> {
  let changed = false;
  const present=new Set(snapshot.modelProviders.filter(p=>(p.nonsecret as {source?:string})?.source==="dcode_custom").map(p=>p.id));
  for(const id of nativeRegistrations.get(runtime)??[])if(!present.has(id)){runtime.unregisterProvider(id);changed=true;}
  nativeRegistrations.set(runtime,present);
  for (const provider of snapshot.modelProviders) {
    const config = provider.nonsecret as {
      source?: string;
      credentialEnv?: string;
      keepExistingAuth?: boolean;
      compat?: Record<string, unknown>;
    };
    if (config?.source !== "dcode_custom") continue;
    const apiKey = config.credentialEnv
      ? process.env[config.credentialEnv]
      : undefined;
    if (!apiKey && !config.keepExistingAuth) continue;
    runtime.registerProvider(provider.id, {
      name: provider.name,
      baseUrl: provider.baseUrl,
      api: provider.apiKind as Parameters<
        ModelRuntime["registerProvider"]
      >[1]["api"],
      apiKey,
      models: snapshot.modelCatalogEntries
        .filter((m) => m.providerId === provider.id)
        .map((m) => {
          const metadata = m.nonsecret as Partial<
            NonNullable<
              Parameters<ModelRuntime["registerProvider"]>[1]["models"]
            >[number]
          > & { apiOverride?: string; baseUrlOverride?: string };
          return {
            id: m.modelId,
            name: m.name,
            reasoning: m.reasoning,
            input: metadata.input ?? ["text", "image"],
            cost: metadata.cost ?? {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
            },
            contextWindow: m.contextWindow ?? 128000,
            maxTokens: m.maxTokens ?? 8192,
            ...(metadata.samplingParams ? {samplingParams:metadata.samplingParams} : {}),
            ...(metadata.thinkingLevelMap
              ? { thinkingLevelMap: metadata.thinkingLevelMap }
              : {}),
            ...(metadata.apiOverride ? { api: metadata.apiOverride } : {}),
            ...(metadata.baseUrlOverride
              ? { baseUrl: metadata.baseUrlOverride }
              : {}),
            compat: { ...config.compat, ...metadata.compat },
          };
        }),
    });
    changed = true;
  }
  if (changed) await runtime.refresh({ allowNetwork: false });
}
