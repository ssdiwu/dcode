// 可执行模型解析（Pi adapter 内唯一可信来源，第 10 点收口）：
// - builtin 精确条目：原样保留本地 SDK 模型模板（compat/headers/promptCache/inputLimits/...），
//   只接受 remote 的安全元数据（新 id/名称/能力/限制/价格）；绝不让 remote 覆盖 api/baseUrl/headers/compat。
// - 同供应商、本地已确认协议的新线上模型（如线上新增的 claude-haiku-5-5）：以该供应商本地 builtin
//   的 anchor 模板（同 api 的首个 builtin 模型）承载协议字段，替换 id/name/baseUrl(anchor)/能力/价格；
//   未知 api 的线上模型显示为不可执行，不凭同 id 或同协议名猜测 dispatch 成立。
// - 冷启动 assembly 与「明确应用」main 都经 resolveExecutableModel 一处解析，不各拼模型。
import type { Api, Model } from "@earendil-works/pi-ai";
import type { PersistedCatalogModel } from "@/contracts";
import type { RegisteredPresetProvider } from "./preset-providers";

export interface ExecutableModelResolution {
  executable: boolean;
  /** 供 Pi dispatch 的完整模型对象（本地模板字段保留；仅 executable 时有意义） */
  model?: Model<Api>;
  /** 供 UI 的安全元数据（名称/能力/价格；不来自模板 secret 字段） */
  info: { id: string; name: string; reasoning: boolean; input: ReadonlyArray<"text" | "image">; cost: { input: number; output: number; cacheRead: number; cacheWrite: number }; contextWindow: number; maxTokens: number };
}

function toInfo(id: string, name: string, m: { reasoning: boolean; input: ReadonlyArray<"text" | "image">; cost: { input: number; output: number; cacheRead: number; cacheWrite: number }; contextWindow: number; maxTokens: number }) {
  return {
    id,
    name,
    reasoning: m.reasoning,
    input: [...m.input] as Array<"text" | "image">,
    cost: { ...m.cost },
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
  };
}

function safeBuiltinModels(preset: RegisteredPresetProvider): readonly Model<Api>[] {
  try {
    return preset.provider.getModels();
  } catch {
    return [];
  }
}

/**
 * 解析一个供应商+模型 id 的可执行对象。
 * remote 为已接收校验的线上目录条目（可缺席）；builtin 为 SDK 静态条目（可缺席）。
 */
export function resolveExecutableModel(
  preset: RegisteredPresetProvider,
  modelId: string,
  remote: PersistedCatalogModel | undefined,
): ExecutableModelResolution | null {
  const builtins = safeBuiltinModels(preset);
  const exact = builtins.find((m) => m.id === modelId);
  if (exact) {
    // builtin 精确条目：保留完整本地模板的 api/baseUrl/headers/compat/promptCache/inputLimits；
    // remote 只把经校验的安全元数据（名称/能力/限制/价格）合并进真正 model 对象，
    // 不动 api/baseUrl/headers/compat。已知 ID 的在线能力更新必须实际进入 SDK 请求参数。
    const model: Model<Api> = remote
      ? {
          ...exact,
          name: remote.name,
          reasoning: remote.reasoning,
          input: [...remote.input],
          cost: { ...remote.cost },
          contextWindow: remote.contextWindow,
          maxTokens: remote.maxTokens,
        }
      : exact;
    const info = remote ? toInfo(remote.id, remote.name, remote) : toInfo(exact.id, exact.name ?? exact.id, exact);
    return { executable: true, model, info };
  }
  if (!remote) return null;
  // 新线上模型：仅当 api 属于该供应商本地已确认协议时才可执行，anchor 用同 api 的首个 builtin 模板
  const anchor = builtins.find((m) => m.api === remote.api) ?? builtins[0];
  if (!anchor) {
    return { executable: false, info: toInfo(remote.id, remote.name, remote) };
  }
  const apis = new Set(builtins.map((m) => m.api));
  if (!apis.has(remote.api)) {
    return { executable: false, info: toInfo(remote.id, remote.name, remote) };
  }
  // 承载 anchor 的模板字段（compat/headers/promptCache/inputLimits），仅覆盖安全元数据；
  // baseUrl 用本地 anchor 的出厂端点，不跟 remote.baseUrl（凭据目标不被远端数据改向）。
  const model: Model<Api> = {
    ...anchor,
    id: remote.id,
    name: remote.name,
    baseUrl: anchor.baseUrl,
    reasoning: remote.reasoning,
    input: [...remote.input],
    cost: { ...remote.cost },
    contextWindow: remote.contextWindow,
    maxTokens: remote.maxTokens,
  };
  return { executable: true, model, info: toInfo(remote.id, remote.name, remote) };
}

/** 模板判断：catalog view 的模型是否在当前供应商本地模板下可执行（设置页据此显示限制）。
 *  remote-only 条目给出其 api 才可判定；这里只负责 builtin 精确命中与 api 集合核对。 */
export function apiIsLocal(preset: RegisteredPresetProvider, api: string): boolean {
  const builtins = safeBuiltinModels(preset);
  return builtins.some((m) => m.api === api);
}
