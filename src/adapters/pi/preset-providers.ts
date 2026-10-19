// 预设供应商登记：以锁定的 pi-ai builtinProviders 为身份/auth/协议唯一权威来源。
// 关键边界：
// - 不重建 42 家身份表；供应商名称、协议分发、auth 流程沿用 SDK 正式实现。
// - credential 归 D Code 名下后，环境/文件凭据是旁路。策略明确且统一（不做源码文本探测：
//   Function.prototype.toString 对 bind 结果与打包产物不可靠）：所有 provider 的 apiKey.resolve
//   一律包装为——无凭据即未配置（undefined）；有凭据才调用 SDK 原 resolve，且始终传入同一份
//   deny-ambient ctx（env 一律 undefined、fileExists 一律 false）。createModels 侧再传同一个
//   authContext 作为双保险。SDK resolve 返回中的 credential.env（附属账户参数，如 Cloudflare
//   account/gateway id、Azure resource 字段）原样保留；login 收集这些参数的 SDK 正式流程不动。
// - 请求路径 env 只来自已存凭据与 resolve 的正式返回，进程 process.env 不静默补参数。

import type { ApiKeyAuth, Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

/** 已登记的预设供应商视图（身份信息不变；auth.resolve 已按凭据归属规则统一包装）。 */
export interface RegisteredPresetProvider {
  readonly id: string;
  readonly name: string;
  /** SDK 的公共目录查询身份；不改变已保存的 D Code 来源、凭据或运行身份。 */
  readonly catalogProviderId?: string;
  readonly provider: Provider;
  readonly authKinds: ReadonlyArray<"api_key" | "oauth">;
}

/** deny-ambient 的统一 ctx：credential 归 D Code 后，环境与文件凭据都不是可读来源。 */
export const NO_AMBIENT_CONTEXT = {
  env: async () => undefined,
  fileExists: async () => false,
};

/**
 * 统一包装（无分支、不探测实现文本）：
 * - 无 credential → undefined（不读 ambient）；
 * - 有 credential → SDK 原 resolve，ctx 固定为 NO_AMBIENT_CONTEXT（即便原实现本会在
 *   credential 之后回退环境，也被同一份策略关闭；credential.env 由 SDK 自己从 credential 取）。
 * check 同理：无 credential 即未配置；有 credential 时以同一 ctx 查询，不执行外部命令解锁。
 */
function wrapApiKeyAuth(original: ApiKeyAuth | undefined): ApiKeyAuth | undefined {
  if (!original) return undefined;
  const baseResolve = original.resolve?.bind(original);
  const baseCheck = original.check?.bind(original);
  type ResolveInput = Parameters<NonNullable<ApiKeyAuth["resolve"]>>[0];
  type CheckInput = Parameters<NonNullable<ApiKeyAuth["check"]>>[0];
  const resolve: ApiKeyAuth["resolve"] = !baseResolve
    ? (async () => undefined)
    : (async (input: ResolveInput) => {
        if (!input.credential) return undefined;
        return baseResolve({ ...input, ctx: NO_AMBIENT_CONTEXT });
      });
  const wrapped: ApiKeyAuth = {
    ...original,
    resolve: resolve as ApiKeyAuth["resolve"],
  };
  if (baseCheck) {
    wrapped.check = (async (input: CheckInput) => {
      if (!input.credential) return undefined;
      return baseCheck({ ...input, ctx: NO_AMBIENT_CONTEXT });
    }) as ApiKeyAuth["check"];
  }
  // login 保留 SDK 正式收集流程：prompt 收集 key + 附属账户字段，产出经 Models.login 正式入库
  return wrapped;
}

/**
 * 注册全部 builtin 供应商。每个 provider 原样复制后替换 auth.apiKey 为上述统一包装；
 * oauth 原样保留（refresh/toAuth 由 SDK 与凭据存储协作；token 刷新是 SDK 已授权请求的正常通路，
 * 不经环境旁路，也不被用户级账户变更门控误拦）。
 */
export function registerPresetProviders(): RegisteredPresetProvider[] {
  const result: RegisteredPresetProvider[] = [];
  for (const upstream of builtinProviders()) {
    // Pi 1.3 将 Azure 的 provider id 改为 azure，但 API id 未变。
    // 保 D Code 旧来源及加密键/会话/候选/历史；只适配同一官方供应商，不改用户 custom。
    const legacyAzure = upstream.id === 'azure';
    const id = legacyAzure ? 'azure-openai-responses' : upstream.id;
    const provider: Provider = legacyAzure ? {
      ...upstream, id,
      getModels: () => upstream.getModels().map(model => ({ ...model, provider: id })),
      ...(upstream.getAllModels ? { getAllModels: () => upstream.getAllModels!().map(model => ({ ...model, provider: id })) } : {}),
    } : upstream;
    const authKinds: Array<"api_key" | "oauth"> = [];
    if (provider.auth.apiKey) authKinds.push("api_key");
    if (provider.auth.oauth) authKinds.push("oauth");
    const next: Provider = {
      ...provider,
      auth: {
        ...(wrapApiKeyAuth(provider.auth.apiKey) ? { apiKey: wrapApiKeyAuth(provider.auth.apiKey)! } : {}),
        ...(provider.auth.oauth ? { oauth: provider.auth.oauth } : {}),
      },
    };
    result.push({ id: provider.id, name: provider.name, provider: next, authKinds, ...(legacyAzure ? { catalogProviderId: upstream.id } : {}) });
  }
  return result;
}
