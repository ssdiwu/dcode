// 自动路由判定：**纯函数**，不碰端口、不发请求、不写状态。
//
// 产品顺序不可颠倒：先按当前工作的**能力要求**筛适合候选，再核对**有效额度**。
// 不适合当前工作的模型不会因为额度更多、价格更低或别的候选已耗尽而进入适合范围。
//
// 几条硬边界都在这里收口：
//  · 指定模式的范围**仅含指定模型**，不因额度或能力扩大，也不擅自换备用；
//  · 适合候选**已知全部耗尽** → 保留工作等待明确继续；额度恢复、查询失败或变为未知
//    都不自动续跑，也不得把"已知耗尽"改标为"未知"来绕过接续要求；
//  · 适合候选**均未知**且无有效耗尽依据、原工作允许推进 → 有界尝试原工作，
//    不另发探测任务、不重复接收同一输入、不重放已完成工具；
//  · 共享池按池判定：同一池内不得把一个窗口的剩余当作另一个的可调用凭据；
//  · 工作当前不允许推进（暂停中／等待明确继续／目标失效）时，选模与额度查询都不唤醒它。

import type {
  ModelIdentity,
  ModelRoutingAttempt,
  QuotaFacts,
  RoutingDecision,
  RoutingOutcome,
  SessionModelChoice,
  VerifiedModelCapabilities,
  WorkCapability,
} from "@/contracts";

export interface RoutingInput {
  /** 该会话的选择方式；各会话独立 */
  readonly choice: SessionModelChoice;
  /** 当前工作对模型的能力要求 */
  readonly requires: readonly WorkCapability[];
  /** 已配置、当前仍适用且已具备使用条件的候选（按用户名单，不含名单外模型） */
  readonly candidates: readonly VerifiedModelCapabilities[];
  /** 各候选的有效额度事实；缺失项视为 unknown 并如实标注，不当 0 也不用 */
  readonly quota: readonly QuotaFacts[];
  /** 原工作当前是否允许推进；false 时选模与额度查询都不得唤醒它 */
  readonly workRunnable: boolean;
  /** workRunnable=false 时的真实原因 */
  readonly notRunnableReason?: string;
  /**
   * 切换准备期间发生的更优先事实：会话改选、新暂停、目标或配置失效。
   * 任一为 true 时，本次判定的结果不得用于发起请求——旧迟到结果不得覆盖新事实。
   */
  readonly supersededBy?: "session-choice" | "pause" | "target-invalid" | "config-invalid";
}

/**
 * 该候选是否适合当前工作：按**逐项能力判定**核对，不看名字、排名、上下文容量或额度。
 *
 * 三态里只有「有依据的 true」算满足：
 *  · `catalog` / `user-configuration` 且 `supported` → 满足；
 *  · `supported === false`（任何依据）→ 不满足；
 *  · `evidence === "none"`（未核实）→ **不满足**，并由调用方带上真实原因说明缺口。
 * 未核实不能因为"看起来也许行"就放行——那正是把没依据说成已核实。
 */
export function fitsCapabilities(candidate: VerifiedModelCapabilities, requires: readonly WorkCapability[]): boolean {
  return requires.every((cap) => candidate.supports[cap].supported === true && candidate.supports[cap].evidence !== "none");
}

/** 该必需能力是否**已核实为不满足**（有依据且结论为不支持）。 */
function isVerifiedIncapable(candidate: VerifiedModelCapabilities, cap: WorkCapability): boolean {
  const support = candidate.supports[cap];
  return support.evidence !== "none" && support.supported !== true;
}

/**
 * 该候选是否**只是**因为资料未核实而没通过筛选。
 *
 * 必须没有任何一项「已核实不满足」：那一项是确凿结论，不能被另一项的未知抹掉。
 * 把"有已知不支持 + 也有未知"算作"仅未核实"，等于借未知放行已知做不到的工作——
 * spec 的有界尝试只覆盖未知，不授权降低能力要求。
 */
function isUnverifiedOnly(candidate: VerifiedModelCapabilities, requires: readonly WorkCapability[]): boolean {
  if (requires.some((cap) => isVerifiedIncapable(candidate, cap))) return false;
  return requires.some((cap) => candidate.supports[cap].evidence === "none");
}

/** 当前工作里**没有已核实依据**的能力项；用于如实说明缺口（保留工作而不是静默降级）。 */
export function unverifiedRequirements(candidate: VerifiedModelCapabilities, requires: readonly WorkCapability[]): WorkCapability[] {
  return requires.filter((cap) => candidate.supports[cap].evidence === "none");
}

/** 额度事实是否属于"已确认可用"。未知／不支持／过期／读取失败都不算。 */
export function isConfirmedAvailable(facts: QuotaFacts | undefined): boolean {
  return facts?.state === "available" && facts.updatedAt !== null;
}

/** 额度事实是否属于"已知耗尽"。未知与失败**不是**耗尽，二者不可互换。 */
export function isKnownExhausted(facts: QuotaFacts | undefined): boolean {
  return facts?.state === "exhausted";
}

function attempt(
  identity: ModelIdentity,
  outcome: ModelRoutingAttempt["outcome"],
  reason: string | null,
): ModelRoutingAttempt {
  return { sourceId: identity.sourceId, modelId: identity.modelId, outcome, reason };
}

/** 列出该候选相对当前工作的能力缺口；确实满足时返回 null。
 *  区分两类缺口：**已核实不满足**与**未核实**——后者要说清"没有依据"，不能混成"不行"。 */
function describeGaps(candidate: VerifiedModelCapabilities, requires: readonly WorkCapability[]): string | null {
  const gaps: string[] = [];
  for (const cap of requires) {
    const support = candidate.supports[cap];
    if (support.supported && support.evidence !== "none") continue;
    gaps.push(support.evidence === "none" ? `${cap}（未核实：${support.reason ?? "没有依据"}）` : `${cap}（已核实不满足）`);
  }
  return gaps.length === 0 ? null : gaps.join("、");
}

function quotaOf(quota: readonly QuotaFacts[], identity: ModelIdentity): QuotaFacts | undefined {
  return quota.find((f) => f.sourceId === identity.sourceId && f.modelId === identity.modelId);
}

function hold(decision: RoutingDecision, attempts: readonly ModelRoutingAttempt[], quota: readonly QuotaFacts[]): RoutingOutcome {
  return { decision, attempts, quota };
}

/**
 * 自动路由判定。会话选择的实际执行模型由调用方按判定结果发布，
 * 本函数不修改任何状态，也不代表候选已经被采用。
 */
export function decideModelRouting(input: RoutingInput): RoutingOutcome {
  const { choice, requires, candidates, quota, workRunnable } = input;
  const attempts: ModelRoutingAttempt[] = [];

  // 更优先的新事实已经发生时，本次判定只能留痕，不能用来发起请求。
  if (input.supersededBy) {
    return hold(
      { kind: "hold-work-not-runnable", reason: `选模期间发生更优先事实（${input.supersededBy}），本次结果不用于发起请求` },
      attempts,
      quota,
    );
  }

  // 工作当前不允许推进：选模与额度查询都不唤醒它。
  if (!workRunnable) {
    return hold(
      { kind: "hold-work-not-runnable", reason: input.notRunnableReason ?? "当前工作不允许推进" },
      attempts,
      quota,
    );
  }

  // 指定模式：范围仅含该模型，不扩大、不换备用。
  if (choice.mode === "explicit") {
    const identity: ModelIdentity = {
      sourceId: choice.sourceId,
      modelId: choice.modelId,
      sourceLabel: choice.sourceId,
      modelLabel: choice.modelId,
      accountLabel: null,
    };
    const known = candidates.find((c) => c.identity.sourceId === choice.sourceId && c.identity.modelId === choice.modelId);
    if (!known) {
      // 配置被移除或失效：保留真实原因，不悄悄退回自动或替换为其他模型。
      return hold(
        { kind: "hold-explicit-unusable", identity, reason: "指定模型的配置已失效或不在当前生效名单内" },
        [attempt(identity, "failed", "指定模型的配置已失效")],
        quota,
      );
    }
    if (!fitsCapabilities(known, requires)) {
      const missing = describeGaps(known, requires);
      if (missing === null) {
        // 能力确有依据地满足：继续走额度判定
      } else {
      return hold(
        { kind: "hold-explicit-unusable", identity: known.identity, reason: `指定模型不能满足当前工作要求：${missing}` },
        [attempt(known.identity, "skipped-incapable", `能力不满足：${missing}`)],
        quota,
      );
      }
    }
    const facts = quotaOf(quota, known.identity);
    if (isKnownExhausted(facts)) {
      return hold(
        { kind: "hold-explicit-unusable", identity: known.identity, reason: `指定模型的额度已耗尽${facts?.windowLabel ? `（窗口 ${facts.windowLabel}）` : ""}` },
        [attempt(known.identity, "skipped-exhausted", facts?.reason ?? "指定模型的额度已耗尽")],
        quota,
      );
    }
    // 指定模型的额度未知时仍可对该模型有界尝试，但**不开放其他候选**。
    if (isConfirmedAvailable(facts)) {
      return hold({ kind: "adopt", identity: known.identity }, [attempt(known.identity, "adopted", null)], quota);
    }
    return hold(
      { kind: "bounded-attempt", identity: known.identity },
      [attempt(known.identity, "attempted-unknown-quota", facts?.reason ?? "额度未知")],
      quota,
    );
  }

  // 自动模式第一步：按能力筛适合候选。额度不参与这一步。
  //
  // 三态严格分开，且**未核实不是执行许可**：
  //  · 已核实不满足（evidence≠none 且 supported≠true）→ 该候选出局；
  //  · 资料未核实（evidence=none）→ 不是"已确认不能做"，但也**不是"已确认能做"**。
  //    spec 授权的有界尝试只覆盖「已适合候选 + 额度未知」这一种情形（模型选择 38 行），
  //    能力未知不在其中：缺依据时执行就是把未核实当成已核实。保留工作并说明缺什么资料，
  //    等拿到可核对依据再按条件处理——不发探针、不重投输入、不另造事实。
  const suitable = candidates.filter((c) => fitsCapabilities(c, requires));
  const verifiedIncapable = candidates.filter((c) => !fitsCapabilities(c, requires) && !isUnverifiedOnly(c, requires));
  const unverified = candidates.filter((c) => !fitsCapabilities(c, requires) && isUnverifiedOnly(c, requires));
  for (const c of verifiedIncapable) {
    attempts.push(attempt(c.identity, "skipped-incapable", `能力不满足：${describeGaps(c, requires) ?? "（无缺口）"}`));
  }
  for (const c of unverified) {
    attempts.push(attempt(
      c.identity,
      "skipped-incapable",
      `能力资料未核实（${describeGaps(c, requires) ?? "无核实依据"}）：缺依据不等于已满足，也不等于已核实不满足；取得可核对资料前不执行`,
    ));
  }

  // 没有适合候选就是没有：无论出局理由是"已核实不满足"还是"资料未核实"，
  // 都不能拿它发请求。保留工作与真实缺口，不静默降级给不匹配或没核实的模型。
  if (suitable.length === 0) {
    return hold({ kind: "hold-no-capable-candidate" }, attempts, quota);
  }
  const attemptable = suitable;

  // 第二步：核对适合候选的有效额度，跳过已知耗尽。
  const available: VerifiedModelCapabilities[] = [];
  const unknown: VerifiedModelCapabilities[] = [];
  let exhaustedCount = 0;
  // 已耗尽的**共享池**记下来：同一池剩余数字不能给池内另一个窗口的模型背书。
  const exhaustedPools = new Set<string>();

  // **同池约束先形成**：先把全部适合候选里已知耗尽的池收集齐，再判读其余的"可用"。
  // 单遍顺序遍历会让「available 在前、exhausted 在后」的候选顺序决定结论——那等于让
  // 目录顺序决定能不能用。这里显式两遍，结论与候选顺序无关。
  for (const c of attemptable) {
    const facts = quotaOf(quota, c.identity);
    if (!isKnownExhausted(facts)) continue;
    exhaustedCount += 1;
    const poolId = facts?.poolId;
    if (poolId) exhaustedPools.add(poolId);
    attempts.push(attempt(c.identity, "skipped-exhausted", facts?.reason ?? "额度已耗尽"));
  }
  for (const c of attemptable) {
    const facts = quotaOf(quota, c.identity);
    if (isKnownExhausted(facts)) continue;
    if (isConfirmedAvailable(facts)) {
      // 同池内已有窗口被确认耗尽时，这个"可用"可能来自另一窗口——不采信，
      // 也不用另一窗口的剩余冒充本次可调用。
      if (facts?.poolId && exhaustedPools.has(facts.poolId)) {
        attempts.push(attempt(c.identity, "skipped-exhausted", "同一额度池的适用窗口已耗尽，不以另一窗口的剩余冒充可用"));
        exhaustedCount += 1;
        continue;
      }
      available.push(c);
      continue;
    }
    unknown.push(c);
  }

  if (available.length > 0) {
    const chosen = available[0]!;
    for (const c of available) attempts.push(attempt(c.identity, c === chosen ? "adopted" : "failed", c === chosen ? null : "已选定其他可用候选"));
    for (const c of unknown) attempts.push(attempt(c.identity, "attempted-unknown-quota", quotaOf(quota, c.identity)?.reason ?? "额度未知"));
    // 直接选可用候选，不先制造一次无额度调用失败。
    return hold({ kind: "adopt", identity: chosen.identity }, attempts, quota);
  }

  if (unknown.length > 0 && exhaustedCount === 0) {
    // 适合候选的额度**均**未知，且没有有效耗尽依据 → 有界尝试原工作。
    const chosen = unknown[0]!;
    for (const c of unknown) attempts.push(attempt(c.identity, "attempted-unknown-quota", quotaOf(quota, c.identity)?.reason ?? "额度未知"));
    return hold({ kind: "bounded-attempt", identity: chosen.identity }, attempts, quota);
  }

  // 适合候选已知全部耗尽：保留工作，等待用户明确继续。
  // 后续额度恢复、查询失败或变为未知都**不**自动续跑，也不得改标为未知绕过接续要求。
  return hold({ kind: "hold-all-exhausted" }, attempts, quota);
}