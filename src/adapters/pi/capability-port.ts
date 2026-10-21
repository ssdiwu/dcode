// D 片：已核实能力资料的读取端口（CapabilityPort 的真实实现）。
//
// 数据源只有三类，每一类都标明依据来源，不允许用一类冒充另一类：
//
//  1. **目录字段**（`evidence: "catalog"`）：模型对象上确有的值。
//     · `image-input`  ← `Model.input` 是否含 "image"（逐项核对，不是名称推断）
//     · `long-context` ← `Model.contextWindow` 与工作实际需要的上下文量比较（真实数字对真实数字）
//     · `reasoning`    ← `Model.reasoning` 且**逐档资料**至少确认一档
//     · `tool-use`     ← 目录**没有**任何工具能力字段，故不由目录判定
//  2. **用户配置**（`evidence: "user-configuration"`）：目录不发布该能力时，用户**事先把该模型
//     配进了候选名单**这一显式、可核对的配置事实可作依据。它不是名称、排名或容量的推断，
//     也不能授权名单外的模型（名单本身就是候选范围）。
//  3. **两者都没有**（`evidence: "none"`）：未核实。此时既不判支持也不判不支持，并给出真实原因；
//     路由遇到未核实的必需能力会保留工作并说明，而不是静默放行或静默降级。
//
// 特别注意：**上下文／输出上限不能推出编码能力**。窗口大只说明能装多少字，与能否正确改代码无关；
// 把 `contextWindow > 0 && maxTokens > 0` 当成 `code-edit = true` 是本片明确修掉的旧错。
// 同样，`tool-use` 也不能因为目录没写就一律填 `false`——那把「没有依据」说成了「确定不行」。

import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import type { Model, Api } from "@earendil-works/pi-ai";
import type {
  CapabilityPort,
  CapabilitySupport,
  ModelIdentity,
  ThinkingLevel,
  VerifiedModelCapabilities,
  WorkCapability,
} from "@/contracts";
import { THINKING_LEVELS } from "@/contracts";
import type { RegisteredPresetProvider } from "./preset-providers";

export interface PiCapabilityPortOptions {
  presets: readonly RegisteredPresetProvider[];
  /**
   * 自定义接入没有内置目录：按自定义身份给出「未核实」而不是借用同名预设的资料。
   *
   * 允许返回 Promise：判据要按**当次**的目录与目录服务解析（设置改了来源或新增线上模型后，
   * 启动时取的快照会与执行端实际能请求的集合说成两套），每次读取都重新解析才与请求同一份事实。
   */
  customIdentity?: (input: { sourceId: string; modelId: string }) => ModelIdentity | null | Promise<ModelIdentity | null>;
  /**
   * 用户预先配置的候选名单（来源＋模型）。**没有它就没有依据**：Auto 不会因此扩大到目录全部，
   * 未核实的能力也不会被它单独背书成支持。
   */
  configuredCandidates?: (identity: { sourceId: string; modelId: string }) => boolean | Promise<boolean>;
  /**
   * 当次有效解析出的模型资料（本地权威模板：内置精确条目，或线上新 ID 的 anchor）。
   *
   * 只查内置 `getModels()` 会让**已生效的线上新 ID**取不到能力资料：它登记得了、
   * 也真的能请求，能力事实却查不到，于是按「未核实」把可执行的模型判出局。
   * 这里与执行端用同一份解析结果，不另建一份目录快照。
   */
  effectiveModel?: (input: { sourceId: string; modelId: string }) => Model<Api> | null | Promise<Model<Api> | null>;
  /** 与 {@link effectiveModel} 同源的显示名（目录 info）；缺席时用模型自身的 name/id。 */
  effectiveLabel?: (input: { sourceId: string; modelId: string }) => string | null | Promise<string | null>;
}

const supported = (reason: string | null = null): CapabilitySupport => ({ supported: true, evidence: "catalog", reason });
const configured = (): CapabilitySupport => ({ supported: true, evidence: "user-configuration", reason: null });
/** 目录里确实写明不满足：依据来自目录字段本身，不是推断。 */
const unsupportedByCatalog = (): CapabilitySupport => ({ supported: false, evidence: "catalog", reason: null });
const unverified = (why: string): CapabilitySupport => ({ supported: false, evidence: "none", reason: why });

/**
 * 逐项判定。`requires` 是当前工作**真实**提出的能力项（由真实请求/历史推导，不是预设全集），
 * 因此未被要求的能力不需要编造依据。
 */
function deriveSupports(
  model: Model<Api>,
  requires: readonly WorkCapability[],
  isConfigured: boolean,
): Readonly<Record<WorkCapability, CapabilitySupport>> {
  const contextWindow = typeof model.contextWindow === "number" ? model.contextWindow : null;
  const neededChars = requires.includes("long-context") ? LONG_CONTEXT_CHARS : 0;
  const out = {} as Record<WorkCapability, CapabilitySupport>;

  out["image-input"] = requires.includes("image-input")
    ? (model.input ?? []).includes("image")
      ? supported()
      : unsupportedByCatalog()
    : unverified("当前工作未提出图片输入要求，未核实");

  out["long-context"] = requires.includes("long-context")
    ? contextWindow === null
      ? unverified("该来源未提供上下文上限，无法与工作需要的上下文量比较")
      : contextWindow >= neededChars
        ? supported(`目录上下文上限 ${contextWindow} ≥ 工作需要的 ${neededChars}`)
        : unsupportedByCatalog()
    : unverified("当前工作未提出长上下文要求，未核实");

  const thinking = verifiedThinkingLevels(model);
  out.reasoning = requires.includes("reasoning")
    ? thinking.levels.length > 0
      ? supported(`目录逐档核实支持：${thinking.levels.join("、")}`)
      : unsupportedByCatalog()
    : unverified("当前工作未提出推理要求，未核实");

  // 目录不发布编码能力与工具能力字段：既不用容量顶替，也不一律判 false。
  out["code-edit"] = requires.includes("code-edit")
    ? isConfigured
      ? configured()
      : unverified("该来源目录不发布编码能力依据，且该模型不在用户预先配置的候选名单内")
    : unverified("当前工作未提出代码修改要求，未核实");

  out["tool-use"] = requires.includes("tool-use")
    ? isConfigured
      ? configured()
      : unverified("该来源目录不发布工具能力依据，且该模型不在用户预先配置的候选名单内")
    : unverified("当前工作未提出工具使用要求，未核实");

  return out;
}

/** 工作提出长上下文要求时的比较基准：按真实字符数（四字符约一 token 的保守上界）换算成 token 量。 */
const LONG_CONTEXT_CHARS = 128_000 * 4;

function verifiedThinkingLevels(model: Model<Api>): { levels: readonly ThinkingLevel[]; note: string | null } {
  const map = model.thinkingLevelMap;
  if (model.reasoning !== true) {
    return { levels: [], note: "该来源资料标明此模型不支持思考" };
  }
  if (typeof map !== "object" || map === null) {
    // 来源只标明「支持思考」而没给逐档资料：按 Pi 自己的标准档位给出，并如实标明未逐档核实。
    // 2026-10-21 507 确认：缺逐档资料不再等于「不显示档位」——
    // 那会让「来源要求必须开思考」的模型在 D Code 里完全不可用。
    // 档位集合取 Pi 的 getSupportedThinkingLevels（该来源该模型实际支持的那些）：
    // 自己列全七档会把 xhigh/max 也摆出来，而 Pi 会把它们静默降级成 high，
    // 用户选到的与实际发出的不是一回事。
    return {
      levels: getSupportedThinkingLevels(model).filter((level): level is ThinkingLevel => (THINKING_LEVELS as readonly string[]).includes(level)),
      note: "该来源未逐档给出，按该来源该 API 的标准档位提供（未逐档核实）",
    };
  }
  const levels = THINKING_LEVELS.filter((level) => typeof map[level] === "string");
  const unsupportedLevels = THINKING_LEVELS.filter((level) => map[level] === null);
  const unverifiedLevels = THINKING_LEVELS.filter((level) => map[level] === undefined);
  const parts: string[] = [];
  if (unsupportedLevels.length > 0) parts.push(`已核实不支持：${unsupportedLevels.join("、")}`);
  if (unverifiedLevels.length > 0) parts.push(`来源未逐档给出（用来源默认值，未核实）：${unverifiedLevels.join("、")}`);
  // 全部七档都逐档核实清楚时不再附说明；有任何未核实或明确不支持才如实说明
  const note = parts.length > 0 ? parts.join("；") : null;
  return { levels, note };
}

export class PiCapabilityPort implements CapabilityPort {
  readonly #presetsById: Map<string, RegisteredPresetProvider>;
  readonly #customIdentity: PiCapabilityPortOptions["customIdentity"];
  readonly #configured: PiCapabilityPortOptions["configuredCandidates"];
  readonly #effective: PiCapabilityPortOptions["effectiveModel"];
  readonly #effectiveLabel: PiCapabilityPortOptions["effectiveLabel"];

  constructor(options: PiCapabilityPortOptions) {
    this.#presetsById = new Map(options.presets.map((p) => [p.id, p]));
    this.#customIdentity = options.customIdentity;
    this.#configured = options.configuredCandidates;
    this.#effective = options.effectiveModel;
    this.#effectiveLabel = options.effectiveLabel;
  }

  async read(identity: { sourceId: string; modelId: string }, requires: readonly WorkCapability[] = []): Promise<VerifiedModelCapabilities | null> {
    const isConfigured = (await this.#configured?.(identity)) === true;
    const preset = this.#presetsById.get(identity.sourceId);
    if (!preset) {
      // 自定义接入没有内置逐档资料：如实给「未核实」的形状，而不是借用同名预设的真值
      const label = await this.#customIdentity?.(identity);
      if (!label) return null;
      return {
        identity: label,
        contextWindow: null,
        maxTokens: null,
        input: [],
        thinkingLevels: [],
        thinkingNote: "自定义接入未提供该模型的能力资料，暂不显示条件参数",
        supports: deriveSupports(EMPTY_MODEL, requires, isConfigured),
      };
    }
    let models: readonly Model<Api>[];
    try {
      models = preset.provider.getModels();
    } catch {
      return null;
    }
    let found = models.find((m) => m.id === identity.modelId);
    if (!found) {
      // 内置目录里没有：按**当次有效解析**再取一次（线上新 ID 走 anchor 模板）。
      // 执行端能请求它，能力事实就该按同一份解析给，不能只查内置就判成查不到。
      found = (await this.#effective?.(identity)) ?? undefined;
      if (!found) return null;
    }
    const resolvedLabel = found ? await this.#effectiveLabel?.(identity) : null;
    const thinking = verifiedThinkingLevels(found);
    return {
      identity: {
        sourceId: identity.sourceId,
        modelId: identity.modelId,
        sourceLabel: preset.name,
        modelLabel: resolvedLabel ?? found.name ?? found.id,
        // 预设目录不提供账户/区域/计划归属：缺席即「未提供」，不据此断定与其它条目相同
        accountLabel: null,
      },
      contextWindow: typeof found.contextWindow === "number" ? found.contextWindow : null,
      maxTokens: typeof found.maxTokens === "number" ? found.maxTokens : null,
      input: [...(found.input ?? [])],
      thinkingLevels: thinking.levels,
      thinkingNote: thinking.note,
      supports: deriveSupports(found, requires, isConfigured),
    };
  }
}

/** 自定义接入没有目录字段时的空壳：所有按目录判定的能力都落到「未核实」，不产出真值。 */
const EMPTY_MODEL = {
  id: "",
  name: "",
  api: "openai-completions",
  provider: "",
  baseUrl: "",
  input: [],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  reasoning: false,
  contextWindow: 0,
  maxTokens: 0,
} as unknown as Model<Api>;