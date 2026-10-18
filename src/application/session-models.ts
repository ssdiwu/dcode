// D 片：会话级模型选择与路由判定的**唯一写入者**。
//
// 为什么单独成文件：会话模型状态有自己的并发规则（改选只在后续请求生效、旧结果不得覆盖新选择、
// 额度读取不得唤醒暂停中的工作），与对象模型/运行协调是不同的事实来源。混进 app.ts 会让
// 「谁在写这条状态」说不清，也让迟到结果的判据无法单独测试。
//
// 三条不变量：
//  1. **新会话默认**（设置）与**每条会话自己的选择**是两份事实：改设置不改已有会话，
//     改某条会话不改别的会话，也不改设置默认值。
//  2. **选择方式 / 实际执行模型 / 最后一次请求结果**三者分别可辨：改了选择不等于已经换了模型，
//     路由判定也不等于请求成功。
//  3. **迟到结果一律作废**：额度读取与选模都有 await 窗口，窗口内发生的改选、暂停、目标或配置失效
//     优先于这次结果；判据是发起时的选择版本，回来时版本不符就丢弃，不写入任何状态。

import type {
  CapabilityPort,
  ModelIdentity,
  ModelSourcePick,
  QuotaFacts,
  QuotaPort,
  SessionModelChoice,
  SessionModelState,
  ThinkingLevel,
  VerifiedModelCapabilities,
  WorkCapability,
  RoutingDecision,
  WorkUsage,
  RequestAttribution,
} from "@/contracts";
import type { ModelSourceEntry, ModelSourcePort } from "./ports";
import { decideModelRouting } from "./model-router";

/** 一次路由判定所依据的当前工作条件。`runnable=false` 时选模与额度查询都不得唤醒这份工作。 */
export interface RoutingWorkContext {
  /**
   * 当前工作**真实**提出的能力项。要求本身也要有依据：
   * 由实际请求（用户带了哪些引用）和该会话**真实发生过**的工具调用推导，
   * 不从偏好、额度或"这类任务通常需要什么"反推；没有依据就不提出该项要求。
   */
  readonly requires: readonly WorkCapability[];
  /** 当前工作是否允许推进（暂停中／等待继续／目标失效时为 false） */
  readonly runnable: boolean;
  /** 不可推进的真实原因；runnable=true 时为 null */
  readonly notRunnableReason?: string;
  /** 指定模式下的目标身份；auto 模式下为 null（自动模式按候选逐个筛） */
  readonly explicitIdentity?: { sourceId: string; modelId: string } | null;
}

export interface SessionModelRegistryDeps {
  /** 已核实能力资料；缺席 = 资料未核实，如实给未知，不按名称补造 */
  readonly capabilityPort?: CapabilityPort | null;
  /** 账户额度事实；缺席 = 没有可靠来源，如实给 unsupported */
  readonly quotaPort?: QuotaPort | null;
  /** 模型来源目录（第一层入口）；缺席 = 本实例无模型目录 */
  readonly sourcePort?: ModelSourcePort | null;
  /** 用户预先配置的候选名单。**自动路由的范围以此为界**，名单外一律不进入。 */
  readonly allowlist?: ((identity: { sourceId: string; modelId: string }) => boolean) | null;
  readonly diagnose?: (event: string, cause: unknown) => void;
}

const AUTO: SessionModelChoice = { mode: "auto" };

/** 能力资料缓存键：来源与模型标识可能含分隔符，用数组编码保证无歧义。 */
function modelKey(sourceId: string, modelId: string): string {
  return JSON.stringify([sourceId, modelId]);
}

function freshState(sessionId: string, choice: SessionModelChoice): SessionModelState {
  return {
    sessionId,
    choice,
    actual: null,
    actualResponseId: null,
    usage: null,
    requests: [],
    thinkingLevel: null,
    lastRouting: null,
    lastResult: "none",
    invalidReason: null,
    waitingExplicitContinue: false,
  };
}

/** 逐次记录求和：同一事实只入账一次（入账处已按 responseId 去重），这里不再去重。 */
function sumUsage(requests: readonly RequestAttribution[]): WorkUsage | null {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let count = 0;
  for (const record of requests) {
    if (!record.usage) continue;
    input += record.usage.input;
    output += record.usage.output;
    cacheRead += record.usage.cacheRead;
    cacheWrite += record.usage.cacheWrite;
    count += record.usage.requests;
  }
  return count > 0 ? { input, output, cacheRead, cacheWrite, requests: count } : null;
}

export class SessionModelRegistry {
  #states = new Map<string, SessionModelState>();
  /** 每条会话的选择版本：改选 +1。迟到结果回来时版本不符即作废。 */
  #choiceSeq = new Map<string, number>();
  #defaultChoice: SessionModelChoice = AUTO;
  readonly #deps: SessionModelRegistryDeps;
  /** 最近一次读到的来源目录：只用于按标识取显示名，不作候选或能力的事实来源。 */
  #lastSources: readonly ModelSourceEntry[] = [];

  constructor(deps: SessionModelRegistryDeps = {}) {
    this.#deps = deps;
  }

  // ---------- 持久化 ----------

  /** 从持久状态恢复。旧文件没有这张表：补空表（无历史选择可恢复，不虚构）。 */
  hydrate(record: Record<string, SessionModelState> | undefined, defaultChoice: SessionModelChoice | undefined): void {
    this.#defaultChoice = defaultChoice ?? AUTO;
    for (const [sessionId, state] of Object.entries(record ?? {})) {
      if (!state || typeof state !== "object") continue;
      this.#states.set(sessionId, {
        ...freshState(sessionId, state.choice ?? this.#defaultChoice),
        ...state,
        sessionId,
        // 旧文件没有逐次归属表：补空表，不虚构历史请求
        requests: Array.isArray(state.requests) ? state.requests : [],
      });
      this.#choiceSeq.set(sessionId, 1);
    }
  }

  /** 供持久化与快照使用（按写入顺序输出，不含内部版本号）。 */
  toRecord(): Record<string, SessionModelState> {
    const out: Record<string, SessionModelState> = {};
    for (const [sessionId, state] of this.#states) out[sessionId] = state;
    return out;
  }

  defaultChoice(): SessionModelChoice {
    return this.#defaultChoice;
  }

  /**
   * 设定新会话默认。**只**改此后新建会话的初值，不动任何已有会话，也不改它们的实际执行模型。
   * 返回是否成立：显式指向的来源/模型必须能在目录里找到，否则如实失败而不是先存下再失效。
   */
  async setDefaultChoice(choice: SessionModelChoice): Promise<{ ok: boolean; choice: SessionModelChoice; message?: string }> {
    const check = await this.checkDefaultChoice(choice);
    if (!check.ok) return check;
    this.#defaultChoice = choice;
    return check;
  }

  /**
   * 只校验、不提交。**保存成立后才调用 commitDefaultChoice**：
   * 否则一次写盘失败会把一个从未被保存的默认值留在注册表里，
   * 让此后新建的会话按一个用户以为没保存上的默认值起步。
   */
  async checkDefaultChoice(choice: SessionModelChoice): Promise<{ ok: boolean; choice: SessionModelChoice; message?: string }> {
    if (choice.mode === "explicit") {
      const listing = await this.#listSources();
      const hit = listing.find((s) => s.sourceId === choice.sourceId && s.models.some((m) => m.modelId === choice.modelId));
      if (!hit) return { ok: false, choice: this.#defaultChoice, message: "所选来源或模型不在当前模型目录中" };
    }
    return { ok: true, choice };
  }

  /** 持久化成立后才提交默认值（写盘失败时调用方不会走到这里）。 */
  commitDefaultChoice(choice: SessionModelChoice): void {
    this.#defaultChoice = choice;
  }

  // ---------- 每条会话的选择 ----------

  /**
   * 会话创建时**固定**初值。必须由会话创建者显式调用：
   * 固定之后改设置默认不再影响这条会话（改默认只决定此后新建的会话）。
   */
  pin(sessionId: string, choice: SessionModelChoice = this.#defaultChoice): SessionModelState {
    const existing = this.#states.get(sessionId);
    if (existing) return existing;
    return this.#write(sessionId, freshState(sessionId, choice));
  }

  /** 读取某条会话的模型状态。**已固定的会话不会被后来的默认改写**；
   *  未固定（历史数据）才在读取这一刻按当前默认补一次并立刻固定下来。 */
  read(sessionId: string): SessionModelState {
    const existing = this.#states.get(sessionId);
    if (existing) return existing;
    return this.#write(sessionId, freshState(sessionId, this.#defaultChoice));
  }

  list(sessionId?: string): readonly SessionModelState[] {
    if (sessionId !== undefined) {
      const one = this.#states.get(sessionId);
      return one ? [one] : [];
    }
    return [...this.#states.values()];
  }

  /**
   * 设定某条会话的模型选择。**只对后续请求生效**：
   * 不中断正在输出的请求、不重投、不改历史请求的归属，也不改设置里的新会话默认。
   * 旧的实际执行模型在新的路由判定成立前仍如实显示为「实际采用的仍是上一个」，
   * 不在这里假装已经切换。
   */
  async setChoice(sessionId: string, choice: SessionModelChoice): Promise<SessionModelState> {
    const seq = (this.#choiceSeq.get(sessionId) ?? 0) + 1;
    this.#choiceSeq.set(sessionId, seq);
    if (choice.mode === "explicit") {
      const listing = await this.#listSources();
      // 目录读取有 await 窗口：期间可能已发生新的改选／暂停／失效，旧结果不得覆盖较新的事实。
      if (this.#superseded(sessionId, seq)) return this.read(sessionId);
      const hit = listing.find((s) => s.sourceId === choice.sourceId && s.models.some((m) => m.modelId === choice.modelId));
      if (!hit) {
        // 选择确实落下来了，但此刻不可用：保留用户的选择并给出真实原因，不悄悄退回自动
        return this.#write(sessionId, { ...this.read(sessionId), choice, invalidReason: "所选来源或模型不在当前模型目录中" });
      }
      const capabilities = await this.#capabilities(choice.sourceId, choice.modelId, []);
      if (this.#superseded(sessionId, seq)) return this.read(sessionId);
      if (capabilities) this.#rememberLevels(capabilities);
      // 选择变了，但**实际采用的仍是上一个模型**（由真实请求事件发布），这里不动 actual。
      return this.#write(sessionId, {
        ...this.read(sessionId),
        choice,
        thinkingLevel: null,
        invalidReason: null,
        lastRouting: null,
        // 改选不解除「等待明确继续」：等的是用户的明确指令，不是换模型。
      });
    }
    return this.#write(sessionId, { ...this.read(sessionId), choice, invalidReason: null, lastRouting: null });
  }

  /**
   * 设定该会话的条件参数档位。**只接受当前目标模型已核实支持的档位**：
   * 未核实或已核实不支持的一律不写入，并如实说明原因（不静默忽略，也不降级成任一可用档）。
   */
  async setThinkingLevel(sessionId: string, level: ThinkingLevel | null): Promise<SessionModelState> {
    const state = this.read(sessionId);
    if (level === null) return this.#write(sessionId, { ...state, thinkingLevel: null, invalidReason: null });
    const target = this.#targetOf(state);
    if (!target) {
      return this.#write(sessionId, { ...state, invalidReason: "该会话尚未确定用哪个模型，暂不能设置条件参数" });
    }
    const seq = this.#choiceSeq.get(sessionId) ?? 0;
    const capabilities = await this.#capabilities(target.sourceId, target.modelId, []);
    if (this.#superseded(sessionId, seq)) return this.read(sessionId);
    if (!capabilities) {
      return this.#write(sessionId, { ...state, invalidReason: "该来源未提供该模型的能力资料，条件参数无法核实" });
    }
    if (!capabilities.thinkingLevels.includes(level)) {
      return this.#write(sessionId, {
        ...state,
        invalidReason: `该模型未核实支持此档位${capabilities.thinkingNote ? `（${capabilities.thinkingNote}）` : ""}`,
      });
    }
    return this.#write(sessionId, { ...state, thinkingLevel: level, invalidReason: null });
  }

  /** 记录最后一次请求的真实结果。与「实际采用」分开：采用某个模型不等于这次请求成功。 */
  noteResult(sessionId: string, result: "pending" | "succeeded" | "failed"): SessionModelState {
    return this.#write(sessionId, { ...this.read(sessionId), lastResult: result });
  }

  /**
   * 只读额度事实。读取**不**发起工作输入、不启用执行、不解除暂停，也不因为读到就推进原工作。
   * 没有可靠来源时如实返回 unsupported（端口负责），此处不代为编造余额。
   */
  /**
   * 该「来源 + 模型」**当次**的可核对能力资料。
   *
   * 兼容入口（用户从未配置候选名单、只配了一个模型）按本次请求自己的身份做能力判定时用：
   * 资料缺席即「没有依据」，调用方不得据此放行——这与路由内部用的是同一份读取。
   */
  async capabilitiesFor(
    identity: { sourceId: string; modelId: string },
    requires: readonly WorkCapability[] = [],
  ): Promise<VerifiedModelCapabilities | null> {
    return this.#capabilities(identity.sourceId, identity.modelId, requires);
  }

  async readQuota(sourceId: string, modelId: string): Promise<QuotaFacts> {
    const port = this.#deps.quotaPort;
    if (!port) {
      return {
        sourceId,
        modelId,
        state: "unsupported",
        poolId: null,
        windowLabel: null,
        updatedAt: null,
        reason: "本实例未装配账户额度来源，未能核实",
      };
    }
    const facts = await port.read({ candidates: [{ sourceId, modelId }] });
    const hit = facts.find((f) => f.sourceId === sourceId && f.modelId === modelId);
    return hit ?? {
      sourceId,
      modelId,
      state: "unknown",
      poolId: null,
      windowLabel: null,
      updatedAt: null,
      reason: "额度来源未返回该候选的事实",
    };
  }

  async hasTypedModel(sourceId: string, modelId: string, type: 'classifier' | 'image' = 'classifier'): Promise<boolean> {
    try { return await this.#deps.sourcePort?.hasTypedModel?.({ sourceId, modelId, type }) === true; }
    catch (error) { this.#deps.diagnose?.('typed-model-source-read-failed', error); return false; }
  }

  // ---------- 路由判定 ----------

  /**
   * 按当前工作重新判定该会话的模型。**只判定，不发起工作**。
   * 顺序固定：能力筛适合候选 → 读有效额度 → 决定采用/有界尝试/保留工作。
   * 额度读取窗口内若发生改选、暂停或目标/配置失效，这次结果直接作废（版本比对），
   * 不用旧迟到结果发起任何请求。
   */
  async resolve(sessionId: string, work: RoutingWorkContext): Promise<SessionModelState> {
    const startSeq = this.#choiceSeq.get(sessionId) ?? 0;
    const state = this.read(sessionId);
    const candidates = await this.#collectCandidates(state, work);

    // 能力资料读取同样有 await 窗口：回来时改选／暂停／失效已发生就不按旧选择继续判定。
    if (this.#superseded(sessionId, startSeq)) return this.read(sessionId);

    const quota: QuotaFacts[] = [];
    for (const c of candidates) quota.push(await this.readQuota(c.identity.sourceId, c.identity.modelId));

    // 额度读取窗口内的改选／暂停／失效优先于这次的旧结果。
    if (this.#superseded(sessionId, startSeq)) return this.read(sessionId);
    if (!work.runnable) {
      // 工作当前不允许推进：保留工作并说明，**不**因选模或额度查询唤醒它。
      const outcome = decideModelRouting({ choice: state.choice, requires: work.requires, candidates, quota, workRunnable: false });
      return this.#write(sessionId, { ...state, lastRouting: outcome, thinkingLevel: state.thinkingLevel });
    }

    const outcome = decideModelRouting({ choice: state.choice, requires: work.requires, candidates, quota, workRunnable: true });
    const adopted = this.#decisionIdentity(outcome.decision);
    // **判定不等于已用**：actual 只由 noteRequest 收到真实请求事件时发布，
    // 这里只发布「打算用什么 / 为什么没用」，绝不把计划冒充成已经用过。
    const next: SessionModelState = {
      ...state,
      lastRouting: outcome,
      // Auto 改采另一模型时，旧档位不能借 SDK 缺键默认映射继续使用；
      // 只保留本次候选资料逐档核实的值，缺键或 null 均清除，不擅自换成别的档位。
      thinkingLevel: adopted ? this.#clampThinking(adopted, state.thinkingLevel) : state.thinkingLevel,
      invalidReason: this.#holdReason(outcome.decision) ?? state.invalidReason,
      // 已知全部耗尽进入**正式等待**：只有用户明确继续才清除。
      // 改选、额度恢复、查询失败或变为未知都不得自动解除（也不得把它改标成未知）。
      waitingExplicitContinue: outcome.decision.kind === "hold-all-exhausted" ? true : state.waitingExplicitContinue,
    };
    return this.#write(sessionId, next);
  }

  /** 用户明确继续：解除等待并重新核对条件。**只有这里**能清除等待。 */
  async continueExplicitly(sessionId: string): Promise<SessionModelState> {
    return this.#write(sessionId, { ...this.read(sessionId), waitingExplicitContinue: false });
  }

  /**
   * 明确继续之后条件**仍然**不成立：重新进入正式等待，并写明真实原因。
   *
   * 这不是"把用户的继续指令作废"，而是条件的真实结论：工作继续保留，
   * 下一次明确继续仍可再试一次；期间额度恢复或改选都不会自己解除。
   */
  markWaitingExplicitContinue(sessionId: string, reason: string): SessionModelState {
    return this.#write(sessionId, { ...this.read(sessionId), waitingExplicitContinue: true, invalidReason: reason });
  }

  /** 当前选择代次：请求前裁决用它判断 await 期间是否已被改选／暂停／关闭取代。 */
  generationOf(sessionId: string): number {
    return this.#choiceSeq.get(sessionId) ?? 0;
  }

  /**
   * 发布**一批真实请求**的事实。只由执行端的观测投影调用，判定层不调用它（判定不能冒充已用）。
   *
   * · `attributions` 按时间从旧到新给出本次观测到的每条可核对请求；同一真实请求事实身份
   *   **恰好一次**入账，重复观测与重开不重复计量，真实新增请求即使输入相同也照记。
   * · `totals` 只用于**核对**（观测口给出的总量），不作为写入依据：
   *   累计一律从合并后的逐次记录求和，因此重复观测、重开与视图变小都不会改变会话用量。
   * · 聊天实际采用只取已入账chat记录；typed结果只参与用量，不改聊天actual或选择。
   *   聊天无responseId、分类无原子任务身份均不入账；无usage保持null。
   */
  noteRequests(sessionId: string, event: {
    attributions: readonly {
      identity: ModelIdentity;
      responseId?: string;
      operation?: 'chat' | 'classify' | 'generateImages';
      requestId?: string;
      result: "succeeded" | "failed";
      usage: WorkUsage | null;
    }[];
    totals: WorkUsage | null;
  }): SessionModelState {
    const state = this.read(sessionId);
    const keyOf = (r: { operation?: 'chat' | 'classify' | 'generateImages'; requestId?: string; responseId?: string }) => r.operation === 'classify' || r.operation === 'generateImages' ? `${r.operation}:${r.requestId}` : `chat:${r.responseId}`;
    const known = new Set(state.requests.map(keyOf));
    const appended: RequestAttribution[] = [];
    for (const a of event.attributions) {
      if (!(a.operation === 'classify' || a.operation === 'generateImages' ? a.requestId : a.responseId) || known.has(keyOf(a))) continue;
      known.add(keyOf(a));
      appended.push({
        ...(a.operation === 'classify' || a.operation === 'generateImages' ? { operation: a.operation, requestId: a.requestId! } : { responseId: a.responseId! }),
        sourceId: a.identity.sourceId,
        sourceLabel: a.identity.sourceLabel,
        modelId: a.identity.modelId,
        result: a.result,
        usage: a.usage,
      });
    }
    // 实际采用取**已入账序列里的最后一条**（单调推进），不取"本次传入批次的最后一条"。
    // 理由：重开或执行端换实例后视图可能只含更早的条目，若按批次取就会把"实际采用"
    // 回退成更旧的请求——而历史请求归属是不该被改写的（曾见：切到来源 B 后又显示来源 A）。
    const merged = appended.length > 0 ? [...state.requests, ...appended] : state.requests;
    // typed费用仍入同一逐次事实；它没有聊天响应，不改变当前聊天actual或选择。
    const newest = [...merged].reverse().find(record => record.operation === undefined || record.operation === 'chat') ?? null;
    return this.#write(sessionId, {
      ...state,
      // 逐次记录里存的是扁平字段：实际采用按同一批字段还原身份
      // （发布侧 modelLabel 就是 modelId、accountLabel 就是 null，不是另一次信息）。
      actual: newest
        ? {
            sourceId: newest.sourceId,
            modelId: newest.modelId,
            sourceLabel: newest.sourceLabel,
            modelLabel: newest.modelId,
            accountLabel: null,
          }
        : state.actual,
      actualResponseId: newest ? newest.responseId ?? null : state.actualResponseId,
      lastResult: newest ? newest.result : state.lastResult,
      // 会话累计**从合并后的逐次记录求和**，不用本次观测给出的总量：
      // 重开或执行端换实例后视图可能只含更早的条目（A），按观测总量会让会话用量从 A+B 退回 A，
      // 而任务汇总仍按逐次记录是 A+B —— 两者会互相矛盾。逐次记录才是唯一事实。
      usage: sumUsage(merged),
      requests: merged,
    });
  }

  /** 来源显示名；来自既有目录，未登记时返回 null 由调用方按标识呈现。 */
  identityLabel(sourceId: string): string | null {
    for (const source of this.#lastSources) {
      if (source.sourceId === sourceId) return source.sourceLabel;
    }
    return null;
  }

  /**
   * 本次**后续请求**应当使用的模型引用，供执行端在发请求前应用。
   *
   * 次序是产品语义，不能颠倒：
   *  1. **显式选择**优先——用户刚改选到 B，下一次请求就必须发给 B。
   *     （曾因这里优先用 `actual`，改选被上一次实际采用的模型盖住，请求仍发给旧来源。）
   *  2. **自动判定**：auto 模式用最近一次判定的采用候选。
   *  3. 两者都没有时返回 null = **不覆盖执行端当前模型**：自动模式尚未判定出候选时，
   *     执行端用的就是它自己按当前配置建立的模型，不需要也不该由产品层再指定一次。
   *
   * `actual` 只用于显示与历史核对，**不参与**本次请求的目标：
   * 曾因拿它兜底，编辑过模型配置后仍按上一次实际采用的旧模型 id 重新下发，
   * 执行端解析不到该身份而拒绝，本次请求根本发不出去。
   *
   * **判定为保留工作时这里返回 null**：条件不足就不该有"本次用什么"的目标，
   * 否则会把上一个模型当成默认答案发出去（应用层据此拒绝提交并保留工作）。
   */
  effectiveTarget(sessionId: string): { sourceId: string; modelId: string; thinkingLevel: ThinkingLevel | null } | null {
    const state = this.read(sessionId);
    const decision = state.lastRouting?.decision;
    if (state.waitingExplicitContinue) return null;
    if (decision && (decision.kind === "hold-all-exhausted"
      || decision.kind === "hold-no-capable-candidate"
      || decision.kind === "hold-explicit-unusable"
      || decision.kind === "hold-work-not-runnable")) {
      return null;
    }
    const identity = state.choice.mode === "explicit"
      ? { sourceId: state.choice.sourceId, modelId: state.choice.modelId }
      : decision?.kind === "adopt" || decision?.kind === "bounded-attempt"
        ? decision.identity
        : null;
    if (!identity) return null;
    return { sourceId: identity.sourceId, modelId: identity.modelId, thinkingLevel: state.thinkingLevel };
  }

  // ---------- 两层入口 ----------

  /**
   * 第一层来源视图 + 第二层分组搜索的条目。
   * 能力资料逐个读已核实资料；**额度不在这里读**：未读取就是 null（未读），不是可用也不是未知。
   */
  async sourcesView(requires: readonly WorkCapability[] = []): Promise<readonly ModelSourcePick[]> {
    const listing = await this.#listSources();
    return Promise.all(
      listing.map(async (s) => ({
        sourceId: s.sourceId,
        sourceLabel: s.sourceLabel,
        configured: s.configured,
        models: await Promise.all(
          s.models.map(async (m) => ({
            sourceId: s.sourceId,
            modelId: m.modelId,
            modelLabel: m.modelLabel,
            capabilities: await this.#capabilities(s.sourceId, m.modelId, requires),
            quota: null,
          })),
        ),
      })),
    );
  }

  // ---------- 内部 ----------

  /** 代次是否已被更新的选择／暂停／失效取代。取代者赢，本次迟到结果不得写入。 */
  #superseded(sessionId: string, seq: number): boolean {
    return (this.#choiceSeq.get(sessionId) ?? 0) !== seq;
  }

  /** 暂停／目标失效／配置失效／关闭：自增代次，使在途的额度读取与判定结果作废。 */
  invalidate(sessionId: string, reason: string): SessionModelState {
    this.#choiceSeq.set(sessionId, (this.#choiceSeq.get(sessionId) ?? 0) + 1);
    return this.#write(sessionId, { ...this.read(sessionId), invalidReason: reason });
  }

  #write(sessionId: string, state: SessionModelState): SessionModelState {
    this.#states.set(sessionId, state);
    return state;
  }

  async #listSources(): Promise<readonly ModelSourceEntry[]> {
    const port = this.#deps.sourcePort;
    if (!port) return this.#lastSources;
    try {
      this.#lastSources = await port.list();
    } catch (err) {
      this.#deps.diagnose?.("model-sources-read-failed", err);
    }
    return this.#lastSources;
  }

  async #capabilities(sourceId: string, modelId: string, requires: readonly WorkCapability[]): Promise<VerifiedModelCapabilities | null> {
    const port = this.#deps.capabilityPort;
    if (!port) return null;
    try {
      return await port.read({ sourceId, modelId }, requires);
    } catch (err) {
      this.#deps.diagnose?.("model-capability-read-failed", err);
      return null;
    }
  }

  /**
   * 条件参数的作用目标：**指定模式下就是用户刚选定的那一个**（尚未发过请求也要能设档位）；
   * 自动模式才看实际采用的模型——没有实际模型就没有可核实的能力资料，如实不提供档位。
   */
  #targetOf(state: SessionModelState): { sourceId: string; modelId: string } | null {
    if (state.choice.mode === "explicit") return { sourceId: state.choice.sourceId, modelId: state.choice.modelId };
    return state.actual;
  }

  #decisionIdentity(decision: RoutingDecision): ModelIdentity | null {
    if (decision.kind === "adopt" || decision.kind === "bounded-attempt") return decision.identity;
    return null;
  }

  #holdReason(decision: RoutingDecision): string | null {
    switch (decision.kind) {
      case "hold-all-exhausted":
        return "适合的候选已知额度全部耗尽，工作已保留；需要你明确继续才会重新发起";
      case "hold-no-capable-candidate":
        return "没有满足当前工作要求的模型候选";
      case "hold-explicit-unusable":
        return decision.reason;
      case "hold-work-not-runnable":
        return decision.reason;
      default:
        return null;
    }
  }

  /** 换了模型之后原档位可能不再被支持：保留仍然被支持的那些，其余清掉（不带着旧档位去用新模型）。 */
  #clampThinking(identity: ModelIdentity, level: ThinkingLevel | null): ThinkingLevel | null {
    if (!level) return null;
    // 逐档核实资料只在本次候选收集时读到；没有资料就不擅自保留旧档位（宁可少显示，不假支持）
    const known = this.#knownLevels.get(`${modelKey(identity.sourceId, identity.modelId)}`);
    if (!known) return null;
    return known.includes(level) ? level : null;
  }

  /** 最近一次读到的逐档核实结果：仅用于「换模型后档位是否仍然成立」的同步判断。 */
  readonly #knownLevels = new Map<string, readonly ThinkingLevel[]>();

  #rememberLevels(capabilities: VerifiedModelCapabilities): void {
    this.#knownLevels.set(`${modelKey(capabilities.identity.sourceId, capabilities.identity.modelId)}`, capabilities.thinkingLevels);
  }

  /**
   * 收集候选。**自动模式的范围严格限于用户事先配置的候选名单**：
   *  · 名单内且**已具备使用条件**（该来源已配置／已认证）的模型才进入候选；
   *  · 名单外的模型**一律不进入**——不因为额度多、目录排在前面或"看起来更强"就加入；
   *  · 自定义接入与预设走同一条通路（它同样可以出现在名单里）。
   * 指定模式的范围仅含该模型，不扩大、不换备用。
   */
  async #collectCandidates(state: SessionModelState, work: RoutingWorkContext): Promise<VerifiedModelCapabilities[]> {
    const requires = work.requires;
    const listing = await this.#listSources();
    const entryFor = (sourceId: string, modelId: string) =>
      listing.find((s) => s.sourceId === sourceId && s.models.some((m) => m.modelId === modelId));

    if (state.choice.mode === "explicit") {
      const { sourceId, modelId } = state.choice;
      if (!entryFor(sourceId, modelId)) return [];
      const capabilities = await this.#capabilities(sourceId, modelId, requires);
      if (capabilities) this.#rememberLevels(capabilities);
      // 指定模式的候选范围仅含该模型；能力资料缺失时不拿别的模型顶替
      return capabilities ? [capabilities] : [];
    }
    const explicit = work.explicitIdentity;
    if (explicit) {
      const capabilities = await this.#capabilities(explicit.sourceId, explicit.modelId, requires);
      if (capabilities) this.#rememberLevels(capabilities);
      return capabilities ? [capabilities] : [];
    }

    const allowlist = this.#deps.allowlist;
    const out: VerifiedModelCapabilities[] = [];
    for (const s of listing) {
      // 已配置 / 已认证条件不成立的来源不进候选：那是"还不能用"，不是"不适合"。
      if (!s.configured) continue;
      for (const m of s.models) {
        const identity = { sourceId: s.sourceId, modelId: m.modelId };
        // 名单之外不进入自动路由范围（没有名单 = 没有用户授权的范围）
        if (!allowlist?.(identity)) continue;
        const capabilities = await this.#capabilities(s.sourceId, m.modelId, requires);
        if (capabilities) {
          this.#rememberLevels(capabilities);
          out.push(capabilities);
        }
      }
    }
    return out;
  }
}
