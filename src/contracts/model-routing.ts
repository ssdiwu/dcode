// D 片契约：会话级模型选择、条件参数已核实档位、账户额度事实与自动路由尝试。
//
// 三条边界贯穿本文件：
//  · **模型身份是「来源 + 标识」**，不是名字。不同来源／账户／区域／计划下的同名模型必须可区分。
//  · **条件参数只来自该来源该模型的已核实能力资料**，不从模型名、通用排名或一个布尔量猜档数。
//  · **额度事实区分未知／失败／过期／暂不支持／已耗尽／可用**；共享池与适用窗口单独标识，
//    某个窗口耗尽不得用另一窗口的剩余数字假称当前可调用，也不得把未知写成 0 或可用。

/** 思考档位：与 Pi 1.0.0 的实际定义同源（`minimal…max`），`off` 表示显式关闭。
 *  取值来自该模型**已核实**的能力资料；不支持的档位不出现，不按名称猜。 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** 任务用量：来自真实请求记录的累加，不由 token 估算账户余额，也不反过来当额度。 */
export interface WorkUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  /** 真实发生过用量记录的请求数 */
  readonly requests: number;
}

/** 会话级模型选择。每条会话独立；改一条不连带其他会话，也不回头改设置页的新会话默认。 */
export type SessionModelChoice =
  | { readonly mode: "auto" }
  | { readonly mode: "explicit"; readonly sourceId: string; readonly modelId: string };

/** 模型身份与可辨认归属。`accountLabel` 缺席即"该来源未提供账户/区域/计划区分"，不是"一定相同"。 */
export interface ModelIdentity {
  /** 来源标识（预设 providerId 或自定义接入身份）；与 modelId 一起构成唯一身份 */
  readonly sourceId: string;
  readonly modelId: string;
  /** 来源显示名；同名模型据此区分 */
  readonly sourceLabel: string;
  readonly modelLabel: string;
  /** 账户／区域／计划归属（来源能提供时）；不能确认则 null，由界面如实显示"未提供" */
  readonly accountLabel: string | null;
}

/**
 * 能力依据的来源。**目录没有写的能力不得用容量、名称或一个布尔量顶替**：
 *  · `catalog`：模型目录里确有该字段，按其真实取值判定。
 *  · `user-configuration`：目录不发布这项能力，但用户**事先把该模型配进了候选名单**，
 *    这是可核对的显式配置事实（不按名字、不按排名、不按上下文容量推）。
 *  · `none`：两者都没有 = 未核实。此时必须给出真实原因，不得判成支持，也不得判成不支持。
 */
export type CapabilityEvidence = "catalog" | "user-configuration" | "none";

/** 单项能力的三态判定。支持、不支持、未核实是三件事，不可互相折叠。 */
export interface CapabilitySupport {
  readonly supported: boolean;
  readonly evidence: CapabilityEvidence;
  /** evidence 为 `none` 时的真实原因；已核实时为 null */
  readonly reason: string | null;
}

/** 已核实的模型能力资料。只在确实核实时给出；未核实字段为 null，由界面说明而不是猜。 */
export interface VerifiedModelCapabilities {
  readonly identity: ModelIdentity;
  /** 上下文上限；未核实为 null */
  readonly contextWindow: number | null;
  /** 输出上限；未核实为 null */
  readonly maxTokens: number | null;
  /** 输入模态（已核实） */
  readonly input: readonly ("text" | "image")[];
  /** 该来源该模型**逐档核实为支持**的思考档位。
   *  「已核实支持」与「已核实不支持」（该档在来源资料里显式标记为不支持）是两件事：
   *  前者出现在本列表，后者只体现在 `thinkingNote` 的说明里，界面不得把没核实的档位说成不支持。 */
  readonly thinkingLevels: readonly ThinkingLevel[];
  /** 思考能力未核实／部分档位未核实的真实说明；已逐档核实齐全时为 null */
  readonly thinkingNote: string | null;
  /** 逐项能力判定（三态 + 依据来源）；不按名称、排名或上下文容量猜编码／工具能力 */
  readonly supports: Readonly<Record<WorkCapability, CapabilitySupport>>;
}

/** 当前工作对模型的能力要求。只用可核对的资料逐项比对，不从偏好或额度反推。 */
export type WorkCapability = "code-edit" | "long-context" | "tool-use" | "image-input" | "reasoning";

export const WORK_CAPABILITIES: readonly WorkCapability[] = ["code-edit", "long-context", "tool-use", "image-input", "reasoning"];

/**
 * 自定义接入在会话模型来源里的标识：与目录记录里的凭据键 `user-defined` 同源。
 * 放在契约层是因为来源标识要跨装配（main）、应用（application）与界面共用同一份，不各写一个字面量。
 */
export const CUSTOM_SOURCE_ID = "user-defined";

/** 额度事实的五种真实状态。`unknown`／`unsupported`／`stale` 都不等于 0，也不等于已证实可用。 */
export type QuotaState = "available" | "exhausted" | "unknown" | "unsupported" | "stale";

/** 单个候选的有效额度事实。`poolId` 标识共享池：同一池内的模型不是彼此独立的备用额度。 */
export interface QuotaFacts {
  readonly sourceId: string;
  readonly modelId: string;
  readonly state: QuotaState;
  /** 共享池身份；null = 该来源未提供可辨认的池/账户划分 */
  readonly poolId: string | null;
  /** 适用窗口（如计费周期或速率窗口）；null = 未提供 */
  readonly windowLabel: string | null;
  /** 事实的更新时间；null = 从未成功读到 */
  readonly updatedAt: number | null;
  /** 未提供／失败／过期／不支持的真实原因码；state 为 available 时为 null */
  readonly reason: string | null;
}

/** 单次自动路由尝试的如实记录。**实际采用**、失败原因、尝试归属与最终成功分开呈现，不合并成一个状态。 */
export interface ModelRoutingAttempt {
  readonly sourceId: string;
  readonly modelId: string;
  /**
   * 采用 = 后续请求将用它；其余是这次为什么没走到它。
   * `attempted-unverified-capability` 与 `attempted-unknown-quota` 同属"有界尝试原工作"，
   * 但依据不同：前者是**能力资料未核实**，后者是**额度未知**——界面分别呈现，不合并。
   */
  readonly outcome: "adopted" | "attempted-unknown-quota" | "attempted-unverified-capability" | "skipped-exhausted" | "skipped-incapable" | "failed";
  /** 真实原因；outcome 为 adopted 时为 null */
  readonly reason: string | null;
}

/** 自动路由的判定结果。`decision` 是产品行为的唯一出口，界面不得自行推断。 */
export type RoutingDecision =
  /** 存在已确认可用的适合候选 */
  | { readonly kind: "adopt"; readonly identity: ModelIdentity }
  /** 适合候选的额度均未知，且没有有效耗尽依据、原工作允许推进 → 有界尝试原工作 */
  | { readonly kind: "bounded-attempt"; readonly identity: ModelIdentity }
  /** 指定模式的范围仅含该模型，不因额度或能力扩大 */
  | { readonly kind: "hold-explicit-unusable"; readonly identity: ModelIdentity; readonly reason: string }
  /** 适合候选已知全部耗尽 → 保留工作，等待明确继续（额度恢复不自动续跑） */
  | { readonly kind: "hold-all-exhausted" }
  /** 没有适合当前工作的候选 */
  | { readonly kind: "hold-no-capable-candidate" }
  /** 当前工作不允许推进（暂停中／等待继续／目标失效）→ 选模不得唤醒 */
  | { readonly kind: "hold-work-not-runnable"; readonly reason: string };

export interface RoutingOutcome {
  readonly decision: RoutingDecision;
  readonly attempts: readonly ModelRoutingAttempt[];
  /** 各适合候选的额度事实，供界面按来源／窗口／更新时间分别呈现 */
  readonly quota: readonly QuotaFacts[];
}

/** 执行端已确认的结果/用量归属；聊天响应与typed子任务身份分开，判定层不写。 */
export type RequestAttribution = {
  readonly sourceId: string;
  readonly sourceLabel: string;
  readonly modelId: string;
  readonly result: "succeeded" | "failed";
  /** 该次请求自己的用量，不是累计；该次没有用量字段时为 null（不补零） */
  readonly usage: WorkUsage | null;
} & ({ readonly operation?: 'chat'; readonly responseId: string; readonly requestId?: never }
  | { readonly operation: 'classify' | 'generateImages'; readonly requestId: string; readonly responseId?: never });

/** 会话的模型状态：选择方式与实际执行模型分别可辨，界面不提前宣布已切换。 */
export interface SessionModelState {
  readonly sessionId: string;
  readonly choice: SessionModelChoice;
  /** 本次会话**实际**使用的来源与模型。**只由真实请求事件发布**（Pi 助手条目的 provider/model），
   *  路由判定成立不等于已经用过它——计划不得冒充已用。 */
  readonly actual: ModelIdentity | null;
  /** 实际采用的模型标识与真实响应标识（responseId）；未发生真实请求时为 null */
  readonly actualResponseId: string | null;
  /** 本次会话实际用掉的任务用量（来自真实请求记录的累加）；无真实记录为 null */
  readonly usage: WorkUsage | null;
  /** 逐次真实请求的归属：任务用量汇总与"尝试/最终"分别显示的依据。
   *  聊天按responseId、分类按原Durable子任务身份只记一次，不给typed伪造responseId。 */
  readonly requests: readonly RequestAttribution[];
  /** 本次会话选定的条件参数；只在能力资料已核实时存在 */
  readonly thinkingLevel: ThinkingLevel | null;
  readonly lastRouting: RoutingOutcome | null;
  /** 最后一次请求的真实结果；与"实际采用"分开 */
  readonly lastResult: "none" | "pending" | "succeeded" | "failed";
  /** 选择失效（如配置被移除）时的真实原因；不悄悄退回自动 */
  readonly invalidReason: string | null;
  /** 已知全部耗尽后的正式等待：等待用户**明确继续**。
   *  额度恢复、查询失败、转为未知、改选都**不**自动解除；只有明确继续才清除。 */
  readonly waitingExplicitContinue: boolean;
}

/**
 * 某个来源的额度可读性。**按目标服务逐个给出依据**，不把"所有服务都没有"归结为 SDK 缺接口：
 * 每一条都要写明是哪家服务、走哪个官方接口（或为什么没有）。
 */
export type QuotaAccess =
  /** 该服务有官方额度/用量查询接口，本装配已接通并按 (poolId, windowLabel) 归一化 */
  | { readonly kind: "connected"; readonly service: string; readonly endpoint: string }
  /** 该服务有官方接口，但本装配尚未接通：写明是哪家、缺什么，不含糊成"不支持" */
  | { readonly kind: "not-yet-connected"; readonly service: string; readonly endpoint: string; readonly missing: string }
  /** 该服务没有公开的账户额度查询：写明依据，不得用估算或本地 token 顶替 */
  | { readonly kind: "no-public-api"; readonly service: string; readonly basis: string }
  /** 认证条件不足（缺凭据 / 权限范围不够）：与"服务没有接口"是两件事 */
  | { readonly kind: "not-authenticated"; readonly service: string };

/** 逐来源的额度可读性清单：界面按来源如实显示，不合并成一个无来源的统一余额。 */
export type QuotaSupportList = Readonly<Record<string, QuotaAccess>>;

/** 额度读取端口。**没有可靠来源时如实返回 unsupported/unknown，不得返回 0 或可用。**
 *  读取本身不发送工作输入、不启用执行、不解除暂停。 */
export interface QuotaPort {
  /**
   * 读取一批候选的有效额度事实；实现须按来源逐个给出真实状态，不得合并成无来源的统一余额。
   *
   * 候选可带 `accountKey`（凭据／区域指纹）：同一来源在**不同账户**下的额度不是同一份事实，
   * 读取方按当前真实身份问，端口只回该身份观测到的数字。
   */
  read(request: { readonly candidates: readonly { sourceId: string; modelId: string; accountKey?: string }[] }): Promise<readonly QuotaFacts[]>;
  /** 逐来源的可读性依据；实现必须逐来源给出，不允许只回一句"都不支持"。 */
  support(): QuotaSupportList;
}

/** 已核实能力资料端口。资料未核实时如实返回 null，不按名称或通用排名补造。
 *  `requires` 是当前工作**真实**提出的能力项：端口据此逐项判定，未被要求的能力返回「未核实」。 */
export interface CapabilityPort {
  /** 该来源该模型的已核实能力资料；未收录或未核实时 null */
  read(identity: { sourceId: string; modelId: string }, requires?: readonly WorkCapability[]): Promise<VerifiedModelCapabilities | null>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function isThinkingLevel(v: unknown): v is ThinkingLevel {
  return typeof v === "string" && (THINKING_LEVELS as readonly string[]).includes(v);
}

export function isSessionModelChoice(v: unknown): v is SessionModelChoice {
  if (!isRecord(v)) return false;
  if (v.mode === "auto") return true;
  return v.mode === "explicit" && typeof v.sourceId === "string" && !!v.sourceId && typeof v.modelId === "string" && !!v.modelId;
}

export function isModelIdentity(v: unknown): v is ModelIdentity {
  if (!isRecord(v)) return false;
  return (
    typeof v.sourceId === "string" && !!v.sourceId &&
    typeof v.modelId === "string" && !!v.modelId &&
    typeof v.sourceLabel === "string" &&
    typeof v.modelLabel === "string" &&
    (v.accountLabel === null || typeof v.accountLabel === "string")
  );
}

export function isVerifiedModelCapabilities(v: unknown): v is VerifiedModelCapabilities {
  if (!isRecord(v)) return false;
  if (!isModelIdentity(v.identity)) return false;
  if (v.contextWindow !== null && (typeof v.contextWindow !== "number" || !Number.isFinite(v.contextWindow))) return false;
  if (v.maxTokens !== null && (typeof v.maxTokens !== "number" || !Number.isFinite(v.maxTokens))) return false;
  if (!Array.isArray(v.input) || v.input.some((x) => x !== "text" && x !== "image")) return false;
  if (!Array.isArray(v.thinkingLevels) || !v.thinkingLevels.every(isThinkingLevel)) return false;
  if (v.thinkingNote !== null && typeof v.thinkingNote !== "string") return false;
  // 一个档位都没核实出来时必须给出真实说明，否则界面无从区分「已核实不支持」与「未核实资料」
  if (v.thinkingLevels.length === 0 && (v.thinkingNote === null || v.thinkingNote === "")) return false;
  if (!isRecord(v.supports)) return false;
  const supports = v.supports;
  return WORK_CAPABILITIES.every((cap) => isCapabilitySupport(supports[cap]));
}

const CAPABILITY_EVIDENCE: readonly CapabilityEvidence[] = ["catalog", "user-configuration", "none"];

export function isCapabilitySupport(v: unknown): v is CapabilitySupport {
  if (!isRecord(v)) return false;
  if (typeof v.supported !== "boolean") return false;
  if (typeof v.evidence !== "string" || !(CAPABILITY_EVIDENCE as readonly string[]).includes(v.evidence)) return false;
  if (v.reason !== null && typeof v.reason !== "string") return false;
  // 未核实时必须给出真实原因：既不判支持也不判不支持，但要说清为什么没有依据
  if (v.evidence === "none" && (v.reason === null || v.reason === "")) return false;
  // 已核实（catalog / 用户配置）时不得再挂"无依据"说明
  return v.evidence === "none" || v.reason === null;
}

const QUOTA_STATES: readonly QuotaState[] = ["available", "exhausted", "unknown", "unsupported", "stale"];

export function isQuotaState(v: unknown): v is QuotaState {
  return typeof v === "string" && (QUOTA_STATES as readonly string[]).includes(v);
}

export function isQuotaAccess(v: unknown): v is QuotaAccess {
  if (!isRecord(v) || typeof v.service !== "string") return false;
  if (v.kind === "connected") return typeof v.endpoint === "string" && !!v.endpoint;
  if (v.kind === "not-yet-connected") {
    return typeof v.endpoint === "string" && !!v.endpoint && typeof v.missing === "string" && !!v.missing;
  }
  if (v.kind === "no-public-api") return typeof v.basis === "string" && !!v.basis;
  return v.kind === "not-authenticated";
}

export function isQuotaSupportList(v: unknown): v is QuotaSupportList {
  if (!isRecord(v)) return false;
  return Object.values(v).every(isQuotaAccess);
}

export function isQuotaFacts(v: unknown): v is QuotaFacts {
  if (!isRecord(v)) return false;
  if (typeof v.sourceId !== "string" || typeof v.modelId !== "string") return false;
  if (!isQuotaState(v.state)) return false;
  if (v.poolId !== null && typeof v.poolId !== "string") return false;
  if (v.windowLabel !== null && typeof v.windowLabel !== "string") return false;
  if (v.updatedAt !== null && (typeof v.updatedAt !== "number" || !Number.isFinite(v.updatedAt))) return false;
  if (v.reason !== null && typeof v.reason !== "string") return false;
  // 已证实可用必须带更新时间与可辨认归属，否则"可用"没有可核对的来源
  if (v.state === "available" && (v.updatedAt === null || v.reason !== null)) return false;
  return true;
}

// 接收侧必须认识生产端真实会产出的每一种 outcome：
// 缺一项就会把合法的路由判定当成非法事实拒掉（不是"多一种就不校验"）。
const ATTEMPT_OUTCOMES = [
  "adopted",
  "attempted-unknown-quota",
  "attempted-unverified-capability",
  "skipped-exhausted",
  "skipped-incapable",
  "failed",
] as const;

export function isModelRoutingAttempt(v: unknown): v is ModelRoutingAttempt {
  if (!isRecord(v)) return false;
  if (typeof v.sourceId !== "string" || typeof v.modelId !== "string") return false;
  if (typeof v.outcome !== "string" || !(ATTEMPT_OUTCOMES as readonly string[]).includes(v.outcome)) return false;
  if (v.reason !== null && typeof v.reason !== "string") return false;
  return !(v.outcome === "adopted" && v.reason !== null);
}

export function isRoutingDecision(v: unknown): v is RoutingDecision {
  if (!isRecord(v) || typeof v.kind !== "string") return false;
  switch (v.kind) {
    case "adopt":
    case "bounded-attempt":
      return isModelIdentity(v.identity);
    case "hold-explicit-unusable":
      return isModelIdentity(v.identity) && typeof v.reason === "string" && !!v.reason;
    case "hold-all-exhausted":
    case "hold-no-capable-candidate":
      return true;
    case "hold-work-not-runnable":
      return typeof v.reason === "string" && !!v.reason;
    default:
      return false;
  }
}

export function isRoutingOutcome(v: unknown): v is RoutingOutcome {
  if (!isRecord(v)) return false;
  if (!isRoutingDecision(v.decision)) return false;
  if (!Array.isArray(v.attempts) || !v.attempts.every(isModelRoutingAttempt)) return false;
  return Array.isArray(v.quota) && v.quota.every(isQuotaFacts);
}

export function isWorkUsage(v: unknown): v is WorkUsage {
  if (!isRecord(v)) return false;
  return Number.isInteger(v.input) && Number.isInteger(v.output)
    && Number.isInteger(v.cacheRead) && Number.isInteger(v.cacheWrite)
    && Number.isInteger(v.requests);
}

export function isSessionModelState(v: unknown): v is SessionModelState {
  if (!isRecord(v)) return false;
  if (typeof v.sessionId !== "string" || !v.sessionId) return false;
  if (!isSessionModelChoice(v.choice)) return false;
  if (v.actual !== null && !isModelIdentity(v.actual)) return false;
  if (v.actualResponseId !== null && typeof v.actualResponseId !== "string") return false;
  // 实际采用必须有可核对的响应身份；只有模型没有响应说明还没发生真实请求
  if (v.actual !== null && (v.actualResponseId === null || v.actualResponseId === "")) return false;
  if (v.usage !== null && !isWorkUsage(v.usage)) return false;
  // 逐次归属：responseId 必须是非空且唯一的，否则同一事实会被重复计量
  if (v.requests !== undefined) {
    if (!Array.isArray(v.requests)) return false;
    const seen = new Set<string>();
    for (const r of v.requests) {
      if (!isRecord(r)) return false;
      if (r.operation !== undefined && r.operation !== 'chat' && r.operation !== 'classify' && r.operation !== 'generateImages') return false;
      if (r.operation === 'classify' || r.operation === 'generateImages' ? typeof r.requestId !== 'string' || !r.requestId || r.responseId !== undefined
        : typeof r.responseId !== 'string' || !r.responseId || r.requestId !== undefined) return false;
      const key = r.operation === 'classify' || r.operation === 'generateImages' ? `${r.operation}:${r.requestId}` : `chat:${r.responseId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      if (typeof r.sourceId !== "string" || !r.sourceId) return false;
      if (typeof r.sourceLabel !== "string" || !r.sourceLabel) return false;
      if (typeof r.modelId !== "string" || !r.modelId) return false;
      if (r.result !== "succeeded" && r.result !== "failed") return false;
      if (r.usage !== null && !isWorkUsage(r.usage)) return false;
    }
    // 已记录真实请求却拿不出实际采用：状态自相矛盾（界面会显示有用量却查不到是谁跑的）
    if (v.requests.some(r => r.operation === undefined || r.operation === 'chat') && (v.actual === null || typeof v.actualResponseId !== "string" || v.actualResponseId === "")) {
      return false;
    }
  }
  if (v.waitingExplicitContinue !== undefined && typeof v.waitingExplicitContinue !== "boolean") return false;
  if (v.thinkingLevel !== null && !isThinkingLevel(v.thinkingLevel)) return false;
  if (v.lastRouting !== null && !isRoutingOutcome(v.lastRouting)) return false;
  if (!["none", "pending", "succeeded", "failed"].includes(String(v.lastResult))) return false;
  return v.invalidReason === null || typeof v.invalidReason === "string";
}
