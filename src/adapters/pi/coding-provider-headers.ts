import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { CodingResourcesUnavailable } from './coding-resources';

type NativeProvider = NonNullable<ReturnType<ModelRuntime['getRegisteredNativeProvider']>>;
type HeaderPatch = Record<string, string>;
type Registration = { claim: object; base: NativeProvider; projected: NativeProvider; headers: HeaderPatch };

function patchOf(config: unknown): HeaderPatch | undefined {
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || Object.keys(config).some(key => key !== 'headers') || JSON.stringify(config).length > 64 * 1024) throw new CodingResourcesUnavailable();
  const value = (config as { headers?: unknown }).headers;
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 64) throw new CodingResourcesUnavailable();
  const headers = Object.create(null) as HeaderPatch;
  for (const [name, text] of Object.entries(value)) {
    const key = name.toLowerCase();
    // 只承接公开扩展头，不让项目覆盖认证/账户、协议帧或触发SDK环境/命令解析。
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(key) || key.length > 128 || Object.hasOwn(headers, key)
      || /auth|api.?key|token|cookie|secret|organization|project|account/i.test(key)
      || ['accept', 'content-type', 'user-agent', 'host', 'connection', 'content-length', 'transfer-encoding'].includes(key)
      || typeof text !== 'string' || text.length > 8192 || /[\x00-\x1f\x7f$]/.test(text) || /^\s*!/.test(text)) throw new CodingResourcesUnavailable();
    headers[key] = text;
  }
  return headers;
}

/** 每会话受管provider的公开头派生视图；不复制认证或流执行策略，不持有凭据。 */
export class CodingProviderHeaders {
  readonly #models: ModelRuntime;
  readonly #managed = new Map<string, NativeProvider>();
  readonly #owned = new Map<string, Registration>();

  constructor(models: ModelRuntime, sourceIds: readonly string[]) {
    this.#models = models;
    for (const id of sourceIds) {
      const native = models.getRegisteredNativeProvider(id);
      if (native?.getModels().length) this.#managed.set(id, native);
    }
  }

  #projection(base: NativeProvider, headers: HeaderPatch): NativeProvider {
    const all = [...(base.getAllModels?.() ?? base.getModels())];
    if (!all.some(model => (model.type ?? 'chat') === 'chat')) throw new CodingResourcesUnavailable();
    const reserved = new Set([...Object.keys(base.headers ?? {}), ...all.flatMap(model => Object.keys(model.headers ?? {}))].map(name => name.toLowerCase()));
    if (Object.keys(headers).some(name => reserved.has(name))) throw new CodingResourcesUnavailable();
    // Models.getAuth实际消费Model.headers；只写Provider.headers不会进入当前普通HTTP。
    const projected = all.map(model => (model.type ?? 'chat') === 'chat' ? { ...model, headers: { ...headers, ...model.headers } } : model);
    const protect = (resolved: Record<string, string | null> | undefined) => {
      // 任意名字也可能由原认证返回私有头；必须在SDK合入Model.headers之前拒绝碰撞，不能合并后猜回旧值。
      if (Object.keys(resolved ?? {}).some(name => Object.hasOwn(headers, name.toLowerCase()))) throw new CodingResourcesUnavailable();
    };
    const auth = { ...base.auth };
    if (base.auth.apiKey) {
      const original = base.auth.apiKey;
      auth.apiKey = { ...original, resolve: async input => { const result = await original.resolve(input); protect(result?.auth.headers); return result; } };
    }
    if (base.auth.oauth) {
      const original = base.auth.oauth;
      auth.oauth = { ...original, toAuth: async credential => { const result = await original.toAuth(credential); protect(result.headers); return result; } };
    }
    return { ...base, auth, getModels: () => projected.filter(model => (model.type ?? 'chat') === 'chat') as ReturnType<NativeProvider['getModels']>, getAllModels: () => projected };
  }

  register(id: string, config: unknown, claim: object, previousClaim?: object): void {
    const patch = patchOf(config), previous = this.#owned.get(id);
    const base = previous?.base ?? this.#managed.get(id);
    if (!base || previous?.claim !== previousClaim || this.#models.getRegisteredProviderConfig(id)
      || this.#models.getRegisteredNativeProvider(id) !== (previous?.projected ?? base)) throw new CodingResourcesUnavailable();
    const headers = patch ?? previous?.headers ?? {};
    const projected = this.#projection(base, headers);
    // 原stream/auth/filter函数保留；声明只改变本会话的有限模型头投影，不裸替换准入包装。
    this.#models.registerNativeProvider(projected);
    this.#owned.set(id, { claim, base, projected, headers });
  }

  release(id: string, claim: object): void {
    const owned = this.#owned.get(id);
    if (!owned || owned.claim !== claim) return;
    this.#owned.delete(id);
    if (!this.#models.getRegisteredProviderConfig(id) && this.#models.getRegisteredNativeProvider(id) === owned.projected) {
      this.#models.registerNativeProvider(owned.base);
    }
  }

  /** 仅real在可信来源同步登记后调用；不会把任意外部替换当成本项目新基准。 */
  refresh(sourceIds: readonly string[]): void {
    for (const id of new Set(sourceIds)) {
      const base = this.#models.getRegisteredNativeProvider(id);
      if (!base) { this.#managed.delete(id); continue; }
      this.#managed.set(id, base);
      const owned = this.#owned.get(id);
      if (!owned) continue;
      const projected = this.#projection(base, owned.headers);
      this.#models.registerNativeProvider(projected);
      this.#owned.set(id, { ...owned, base, projected });
    }
  }

  assertCurrent(): void {
    for (const [id, owned] of this.#owned) {
      if (this.#models.getRegisteredProviderConfig(id) || this.#models.getRegisteredNativeProvider(id) !== owned.projected) throw new CodingResourcesUnavailable();
    }
  }
}
