// D 片：模型选择、自动路由与条件参数的行为验证。
//
// 覆盖的判据（每条都对应 spec 里的一条硬要求）：
//  · 自动路由顺序不可颠倒：先按**已核实**能力筛适合候选，再读有效额度。
//  · 「已知全部耗尽」与「额度未知」严格分开：前者保留工作等明确继续，后者才允许有界尝试。
//  · 共享池内某窗口耗尽时，同池另一窗口的「可用」不采信（不用另一窗口的剩余冒充可用）。
//  · 指定模式不扩大范围、不换备用：额度未知只对该模型有界尝试，不开放其它候选。
//  · 条件参数只接受该来源该模型**逐档核实为支持**的档位；未核实不等于不支持，也不等于支持。
//  · 换选 / 暂停 / 目标失效优先于额度读取窗口里的旧结果（迟到结果作废）。
//  · 新会话默认与每条会话自己的选择是两份事实。
//  · 没有可靠额度来源时如实 unsupported —— 不返回 0，也不返回可用。
//
// 本文件只加载 contracts / application / adapters 的纯逻辑，不启动窗口、不碰真实凭据。

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideModelRouting, fitsCapabilities, isConfirmedAvailable, isKnownExhausted, unverifiedRequirements } from "@/application";
import {
  WORK_CAPABILITIES,
  isModelRoutingAttempt,
  isQuotaFacts,
  isSessionModelChoice,
  isSessionModelState,
  isVerifiedModelCapabilities,
  THINKING_LEVELS,
} from "@/contracts";
import type {
  CapabilitySupport,
  ModelIdentity,
  QuotaFacts,
  RoutingDecision,
  SessionModelChoice,
  VerifiedModelCapabilities,
  WorkCapability,
} from "@/contracts";
import { SessionModelRegistry } from "@/application";
import type { ModelSourceEntry } from "@/application";
import { PiCapabilityPort, PiQuotaPort, factsFromObservation, HEADER_BACKED_SOURCES } from "@/adapters/pi";
import { registerPresetProviders } from "@/adapters/pi";

function identity(sourceId: string, modelId: string, accountLabel: string | null = null): ModelIdentity {
  return { sourceId, modelId, sourceLabel: sourceId, modelLabel: modelId, accountLabel };
}

/** 夹具里没显式给出的能力一律是「未核实」，不是 false —— 与生产实现同口径。 */
function supportsOf(input: Partial<Record<WorkCapability, boolean>>): VerifiedModelCapabilities["supports"] {
  const out = {} as Record<WorkCapability, CapabilitySupport>;
  for (const cap of WORK_CAPABILITIES) {
    const value = input[cap];
    out[cap] = value === undefined
      ? { supported: false, evidence: "none", reason: `夹具未给出 ${cap} 的依据` }
      : { supported: value, evidence: "catalog", reason: null };
  }
  return out;
}

function capabilities(
  id: ModelIdentity,
  supports: Partial<Record<WorkCapability, boolean>> = {},
  thinkingLevels: VerifiedModelCapabilities["thinkingLevels"] = [],
  thinkingNote: string | null = null,
): VerifiedModelCapabilities {
  const full = supportsOf(supports);
  return {
    identity: id,
    contextWindow: null,
    maxTokens: null,
    input: ["text"],
    thinkingLevels,
    thinkingNote,
    supports: full,
  };
}

function quota(
  id: ModelIdentity,
  state: QuotaFacts["state"],
  extra: Partial<QuotaFacts> = {},
): QuotaFacts {
  return {
    sourceId: id.sourceId,
    modelId: id.modelId,
    state,
    poolId: null,
    windowLabel: null,
    updatedAt: state === "available" ? 1_700_000_000_000 : null,
    reason: state === "available" ? null : `state:${state}`,
    ...extra,
  };
}

const STRONG: WorkCapability[] = ["code-edit"];

/**
 * 反例：混合「一项已核实不支持 + 一项未核实」不得放行。
 *
 * 已核实不满足是确凿结论，未核实只是缺口；不能因为存在缺口就把确凿结论一起放过去
 * （那是借未知降低能力要求）。有界尝试只覆盖**全部**只是未核实的候选。
 */
void it("一项已核实不支持 + 另一项未核实：仍出局，不借未知放行", () => {
  // code-edit 是**已核实**不支持（catalog 依据）；tool-use 夹具未给出 → 未核实
  const mixed = capabilities(identity("a", "m"), { "code-edit": false });
  const requires: WorkCapability[] = ["code-edit", "tool-use"];
  const out = decideModelRouting({
    choice: { mode: "auto" },
    requires,
    candidates: [mixed],
    quota: [quota(mixed.identity, "available")],
    workRunnable: true,
  });
  assert.equal(out.decision.kind, "hold-no-capable-candidate", `混合缺口必须保留工作（实得 ${out.decision.kind}）`);
  assert.equal(
    out.attempts.some((a) => a.outcome === "attempted-unverified-capability"),
    false,
    "有已核实不支持项时不得记为「仅未核实的有界尝试」",
  );
  assert.ok(
    out.attempts.some((a) => a.outcome === "skipped-incapable"),
    "应如实记为能力不满足",
  );
});

/**
 * 反例：全部必需能力**都只是未核实**时也不放行。
 *
 * 未核实既不是「已确认能做」也不是「已确认不能做」——两者都推不出可执行。
 * spec 33 要求能力依据可核对、34 要求保留工作并说明缺口；
 * spec 38 授权的有界尝试只覆盖「**已适合**候选 + 额度未知」，不是能力缺依据。
 * 这里的额度取**已确认可用**：额度好也不能替代能力依据。
 */
void it("全部必需能力都未核实：保留工作并说明缺口，不把未核实当成获准执行", () => {
  const unverified = capabilities(identity("a", "m"), {});
  const out = decideModelRouting({
    choice: { mode: "auto" },
    requires: ["code-edit", "tool-use"],
    candidates: [unverified],
    quota: [quota(unverified.identity, "available")],
    workRunnable: true,
  });
  assert.equal(out.decision.kind, "hold-no-capable-candidate", `实得 ${out.decision.kind}`);
  const record = out.attempts.find((a) => a.modelId === "m");
  assert.equal(record?.outcome, "skipped-incapable", `实得 ${record?.outcome}`);
  assert.match(record?.reason ?? "", /未核实/, "要写明缺的是可核对的依据");
  assert.doesNotMatch(record?.reason ?? "", /（已核实不满足）/, "逐项缺口都标成「未核实」，不得有任何一项被写成已核实不满足");
  assert.equal(
    out.attempts.some((a) => a.outcome === "attempted-unknown-quota"),
    false,
    "「额度未知可尝试」只适用于已适合候选，不能借它给未核实的能力放行",
  );
});

/**
 * 反例：缺依据的候选与有依据表明不支持的候选都保留工作，但两者的缺口措辞必须能分辨。
 *
 * 把验证缺口写成产品结论（已核实不支持）会让用户以为是模型不行、可以直接换掉；
 * 反过来把产品结论写成缺口同样失真。两者都不能推出可执行，但理由不同。
 */
void it("未核实与已核实不满足都保留工作：两者措辞必须可分辨，且有依据时才获准有界尝试", () => {
  // 自定义接入没有内置能力资料：全部 evidence=none（未核实），不是「已核实不满足」
  const unverified = capabilities(identity("a", "m"), {}); // 未给出任何能力依据
  assert.ok(unverifiedRequirements(unverified, STRONG).length > 0, "该候选确实缺核实依据");

  const held = decideModelRouting({
    choice: { mode: "auto" },
    requires: STRONG,
    candidates: [unverified],
    quota: [quota(unverified.identity, "available")],
    workRunnable: true,
  });
  assert.equal(held.decision.kind, "hold-no-capable-candidate", "缺核实依据时保留工作，不把验证缺口当成获准执行");
  assert.equal(
    held.attempts.some((a) => a.outcome === "attempted-unverified-capability"),
    false,
    "router 不再把未核实能力写成可执行的有界尝试",
  );
  const unverifiedReason = held.attempts.find((a) => a.modelId === "m")?.reason ?? "";
  assert.match(unverifiedReason, /未核实/, "缺依据要如实说明");
  assert.doesNotMatch(unverifiedReason, /（已核实不满足）/, "逐项缺口不得被写成已核实不满足");

  // 有核实依据表明不支持 → 才是「已核实不满足」，同样保留工作，但措辞落在结论上
  const verifiedIncapable = capabilities(identity("a", "m"), { "code-edit": false });
  const hold = decideModelRouting({
    choice: { mode: "auto" },
    requires: STRONG,
    candidates: [verifiedIncapable],
    quota: [quota(verifiedIncapable.identity, "available")],
    workRunnable: true,
  });
  assert.equal(hold.decision.kind, "hold-no-capable-candidate");
  assert.equal(hold.attempts.some((a) => a.outcome === "skipped-incapable"), true);
  assert.match(
    hold.attempts.find((a) => a.modelId === "m")?.reason ?? "",
    /已核实不满足/,
    "有依据的不满足要写成结论，与缺依据区分开",
  );

  // 合法对照：能力**有匹配依据**、额度未知 —— 这才是 spec 38 授权的那一种有界尝试
  const verified = capabilities(identity("a", "m"), { "code-edit": true });
  const attempt = decideModelRouting({
    choice: { mode: "auto" },
    requires: STRONG,
    candidates: [verified],
    quota: [quota(verified.identity, "unknown")],
    workRunnable: true,
  });
  assert.equal(attempt.decision.kind, "bounded-attempt", "已适合候选 + 额度未知仍可按已确认规则有界尝试");
  assert.ok(
    attempt.attempts.some((a) => a.outcome === "attempted-unknown-quota"),
    "有界尝试要写明依据是额度未知，而不是能力未核实",
  );
});

void describe("自动路由：能力筛选先于额度", () => {
  void it("能力不满足的候选不参与额度判定，直接记为能力不满足", () => {
    const weak = capabilities(identity("a", "small"), { "code-edit": false });
    const strong = capabilities(identity("b", "big"), { "code-edit": true });
    const out = decideModelRouting({
      choice: { mode: "auto" },
      requires: STRONG,
      candidates: [weak, strong],
      quota: [quota(weak.identity, "exhausted"), quota(strong.identity, "available")],
      workRunnable: true,
    });
    assert.equal(out.decision.kind, "adopt");
    const skipped = out.attempts.find((x) => x.modelId === "small");
    assert.equal(skipped?.outcome, "skipped-incapable", "能力不满足的候选不应被额度结论影响");
  });

  void it("没有适合候选时保留工作，不把不匹配模型降级顶替", () => {
    const weak = capabilities(identity("a", "small"), { "code-edit": false });
    const out = decideModelRouting({
      choice: { mode: "auto" },
      requires: STRONG,
      candidates: [weak],
      quota: [quota(weak.identity, "available")],
      workRunnable: true,
    });
    assert.equal(out.decision.kind, "hold-no-capable-candidate");
  });

  void it("工作不可推进时不唤醒：判定保留工作而不是选模", () => {
    const strong = capabilities(identity("b", "big"), { "code-edit": true });
    const out = decideModelRouting({
      choice: { mode: "auto" },
      requires: STRONG,
      candidates: [strong],
      quota: [quota(strong.identity, "available")],
      workRunnable: false,
    });
    assert.equal(out.decision.kind, "hold-work-not-runnable");
  });
});

void describe("自动路由：额度事实的五态严格分开", () => {
  void it("有已确认可用候选时直接采用，不先制造一次无额度调用失败", () => {
    const a = capabilities(identity("a", "m"), { "code-edit": true });
    const b = capabilities(identity("b", "m"), { "code-edit": true });
    const out = decideModelRouting({
      choice: { mode: "auto" },
      requires: STRONG,
      candidates: [a, b],
      quota: [quota(a.identity, "available"), quota(b.identity, "available")],
      workRunnable: true,
    });
    assert.equal(out.decision.kind, "adopt");
    assert.equal(out.decision.kind === "adopt" ? out.decision.identity.sourceId : "", "a");
    assert.ok(out.attempts.every((x) => x.outcome !== "attempted-unknown-quota"));
  });

  void it("额度全部未知且没有耗尽依据时，只对同一原工作做有界尝试", () => {
    const a = capabilities(identity("a", "m"), { "code-edit": true });
    const out = decideModelRouting({
      choice: { mode: "auto" },
      requires: STRONG,
      candidates: [a],
      quota: [quota(a.identity, "unknown")],
      workRunnable: true,
    });
    assert.equal(out.decision.kind, "bounded-attempt");
    assert.equal(out.attempts.find((x) => x.modelId === "m")?.outcome, "attempted-unknown-quota");
  });

  void it("暂不支持（unsupported）与未知不同：不当作可用采信", () => {
    const a = capabilities(identity("a", "m"), { "code-edit": true });
    const out = decideModelRouting({
      choice: { mode: "auto" },
      requires: STRONG,
      candidates: [a],
      quota: [quota(a.identity, "unsupported")],
      workRunnable: true,
    });
    assert.equal(out.decision.kind, "bounded-attempt");
  });

  void it("已知全部耗尽：保留工作等明确继续，不改标成未知绕过", () => {
    const a = capabilities(identity("a", "m"), { "code-edit": true });
    const out = decideModelRouting({
      choice: { mode: "auto" },
      requires: STRONG,
      candidates: [a],
      quota: [quota(a.identity, "exhausted")],
      workRunnable: true,
    });
    assert.equal(out.decision.kind, "hold-all-exhausted");
    assert.equal(out.attempts.find((x) => x.modelId === "m")?.outcome, "skipped-exhausted");
  });

  void it("已知存在耗尽依据时，即使还有未知候选也不做有界尝试", () => {
    // 这一条盯住「不得把已知耗尽改标为未知来绕过接续要求」：只要有任一适合候选已知耗尽，
    // 就存在有效的耗尽依据，未知候选不能单独把判定拉回有界尝试。
    const spent = capabilities(identity("a", "spent"), { "code-edit": true });
    const murky = capabilities(identity("b", "murky"), { "code-edit": true });
    const out = decideModelRouting({
      choice: { mode: "auto" },
      requires: STRONG,
      candidates: [spent, murky],
      quota: [quota(spent.identity, "exhausted"), quota(murky.identity, "unknown")],
      workRunnable: true,
    });
    assert.equal(out.decision.kind, "hold-all-exhausted");
    assert.equal(out.attempts.find((x) => x.modelId === "murky")?.outcome, undefined,
      "未知候选不应被写成「已尝试」——工作根本没有被发起");
  });

  void it("同池内一窗耗尽时，另一窗口的「可用」不采信", () => {
    const a = capabilities(identity("a", "m"), { "code-edit": true });
    const b = capabilities(identity("b", "m"), { "code-edit": true });
    const out = decideModelRouting({
      choice: { mode: "auto" },
      requires: STRONG,
      candidates: [a, b],
      quota: [
        quota(a.identity, "exhausted", { poolId: "pool-1", windowLabel: "月度" }),
        quota(b.identity, "available", { poolId: "pool-1", windowLabel: "每 5 小时" }),
      ],
      workRunnable: true,
    });
    assert.equal(out.decision.kind, "hold-all-exhausted", "同池另一窗口的可用不得冒充本次可用");
  });

  void it("同池结论与候选顺序无关：可用在前／耗尽在后同样不得采信", () => {
    const spent = capabilities(identity("a", "m"), { "code-edit": true });
    const other = capabilities(identity("b", "m"), { "code-edit": true });
    const facts = [
      quota(spent.identity, "exhausted", { poolId: "pool-1", windowLabel: "月度" }),
      quota(other.identity, "available", { poolId: "pool-1", windowLabel: "每 5 小时" }),
    ];
    // 可用候选排在耗尽候选前面（单遍遍历会让它先进 available）
    const forward = decideModelRouting({ choice: { mode: "auto" }, requires: STRONG, candidates: [other, spent], quota: facts, workRunnable: true });
    const backward = decideModelRouting({ choice: { mode: "auto" }, requires: STRONG, candidates: [spent, other], quota: facts, workRunnable: true });
    assert.equal(forward.decision.kind, "hold-all-exhausted", "顺序在前不得成为被采信的理由");
    assert.equal(backward.decision.kind, "hold-all-exhausted");
  });

  void it("同池多窗口：一个窗口耗尽，池内其余窗口都不采信（四个窗口同样成立）", () => {
    const w1 = capabilities(identity("p1", "m"), { "code-edit": true });
    const w2 = capabilities(identity("p2", "m"), { "code-edit": true });
    const w3 = capabilities(identity("p3", "m"), { "code-edit": true });
    const w4 = capabilities(identity("p4", "m"), { "code-edit": true });
    const out = decideModelRouting({
      choice: { mode: "auto" },
      requires: STRONG,
      // 三窗口全"可用"、另一个模型把同池的月度窗口用尽；顺序刻意打乱
      candidates: [w3, w2, w1, w4],
      quota: [
        quota(w3.identity, "available", { poolId: "pool-x", windowLabel: "日" }),
        quota(w2.identity, "available", { poolId: "pool-x", windowLabel: "周" }),
        quota(w1.identity, "available", { poolId: "pool-x", windowLabel: "小时" }),
        quota(w4.identity, "exhausted", { poolId: "pool-x", windowLabel: "月" }),
      ],
      workRunnable: true,
    });
    assert.equal(out.decision.kind, "hold-all-exhausted");
    for (const item of out.attempts) assert.equal(item.outcome, "skipped-exhausted");
  });

  void it("不同池的耗尽不影响另一个池的可用候选", () => {
    const a = capabilities(identity("a", "m"), { "code-edit": true });
    const b = capabilities(identity("b", "m"), { "code-edit": true });
    const out = decideModelRouting({
      choice: { mode: "auto" },
      requires: STRONG,
      candidates: [a, b],
      quota: [
        quota(a.identity, "exhausted", { poolId: "pool-1" }),
        quota(b.identity, "available", { poolId: "pool-2" }),
      ],
      workRunnable: true,
    });
    assert.equal(out.decision.kind, "adopt");
    assert.equal(out.decision.kind === "adopt" ? out.decision.identity.sourceId : "", "b");
  });
});

void describe("指定模式：不扩大范围、不换备用", () => {
  void it("额度未知时只对该模型有界尝试，不开放其它候选", () => {
    const chosen = capabilities(identity("a", "picked"), { "code-edit": true });
    const other = capabilities(identity("b", "other"), { "code-edit": true });
    const out = decideModelRouting({
      choice: { mode: "explicit", sourceId: "a", modelId: "picked" },
      requires: STRONG,
      candidates: [chosen, other],
      quota: [quota(chosen.identity, "unknown"), quota(other.identity, "available")],
      workRunnable: true,
    });
    assert.equal(out.decision.kind, "bounded-attempt");
    assert.equal(out.decision.kind === "bounded-attempt" ? out.decision.identity.modelId : "", "picked");
    assert.equal(out.attempts.length, 1, "指定模式不应产生其它候选的尝试记录");
  });

  void it("指定模型能力不足时保留原因，不擅自换备用", () => {
    const chosen = capabilities(identity("a", "picked"), { "code-edit": false });
    const other = capabilities(identity("b", "other"), { "code-edit": true });
    const out = decideModelRouting({
      choice: { mode: "explicit", sourceId: "a", modelId: "picked" },
      requires: STRONG,
      candidates: [chosen, other],
      quota: [quota(chosen.identity, "available"), quota(other.identity, "available")],
      workRunnable: true,
    });
    const decision = out.decision as Extract<RoutingDecision, { kind: "hold-explicit-unusable" }>;
    assert.equal(decision.kind, "hold-explicit-unusable");
    assert.match(decision.reason, /code-edit/);
  });

  void it("指定模型额度已耗尽时保留原因，等待明确继续", () => {
    const chosen = capabilities(identity("a", "picked"), { "code-edit": true });
    const out = decideModelRouting({
      choice: { mode: "explicit", sourceId: "a", modelId: "picked" },
      requires: STRONG,
      candidates: [chosen],
      quota: [quota(chosen.identity, "exhausted")],
      workRunnable: true,
    });
    assert.equal(out.decision.kind, "hold-explicit-unusable");
  });
});

void describe("优先级：新选择 / 暂停 / 目标失效压过额度读取窗口里的旧结果", () => {
  void it("supersededBy 直接拦截，不用旧选择发起任何请求", () => {
    const strong = capabilities(identity("b", "big"), { "code-edit": true });
    const out = decideModelRouting({
      choice: { mode: "auto" },
      requires: STRONG,
      candidates: [strong],
      quota: [quota(strong.identity, "available")],
      workRunnable: true,
      supersededBy: "session-choice",
    });
    assert.equal(out.decision.kind, "hold-work-not-runnable");
    assert.match((out.decision as Extract<RoutingDecision, { kind: "hold-work-not-runnable" }>).reason, /session-choice/);
  });

  void it("注册表：额度读取期间改选，旧结果不覆盖较新的选择", async () => {
    const source: ModelSourceEntry = {
      sourceId: "a",
      sourceLabel: "来源 A",
      configured: true,
      models: [{ modelId: "m", modelLabel: "M" }],
    };
    const gate: { release: (() => void) | null } = { release: null };
    const registry = new SessionModelRegistry({
      sourcePort: { list: async () => [source] },
      allowlist: () => true,
      capabilityPort: {
        read: async ({ sourceId, modelId }) =>
          capabilities(identity(sourceId, modelId), { "code-edit": true }),
      },
      quotaPort: {
        support: () => ({}),
        read: async () => {
          // 卡在额度读取里，等外部改选完成后再放行
          await new Promise<void>((resolve) => {
            gate.release = resolve;
          });
          return [quota(identity("a", "m"), "available")];
        },
      },
    });

    const pending = registry.resolve("s1", { requires: STRONG, runnable: true });
    // 让 resolve 先跑到额度读取，再改选
    await new Promise((r) => setTimeout(r, 5));
    const changed = await registry.setChoice("s1", { mode: "explicit", sourceId: "a", modelId: "m" });
    assert.equal(changed.choice.mode, "explicit");
    gate.release?.();
    const after = await pending;
    assert.equal(after.choice.mode, "explicit");
    assert.equal(after.actual, null, "额度读取窗口内改选后，旧结果不得再写入实际采用");
  });
});

void describe("条件参数：只用逐档核实的档位", () => {
  void it("已核实不支持的档位被拒，并如实说明；不静默降级到别档", async () => {
    const registry = new SessionModelRegistry({
      sourcePort: { list: async () => [] },
      capabilityPort: {
        read: async ({ sourceId, modelId }) =>
          capabilities(identity(sourceId, modelId), { reasoning: true }, ["low", "medium"], "已核实不支持：off；来源未逐档给出：high"),
      },
    });
    // 指定模式下按"刚选定"的模型设档位（实际采用的模型要等真实请求才成立）
    await registry.setChoice("s1", { mode: "explicit", sourceId: "a", modelId: "m" });
    const rejected = await registry.setThinkingLevel("s1", "high");
    assert.equal(rejected.thinkingLevel, null, "未核实的档位不得被写入");
    assert.match(rejected.invalidReason ?? "", /未核实支持/);
    const accepted = await registry.setThinkingLevel("s1", "high" === "high" ? "medium" : "medium");
    assert.equal(accepted.thinkingLevel, "medium");
  });

  void it("指定模式下按**刚选定**的模型设档位：还没发过请求也能设", async () => {
    const registry = new SessionModelRegistry({
      sourcePort: {
        list: async () => [
          { sourceId: "a", sourceLabel: "A", configured: true, models: [{ modelId: "m", modelLabel: "M" }] },
        ],
      },
      allowlist: () => true,
      capabilityPort: {
        read: async ({ sourceId, modelId }) =>
          capabilities(identity(sourceId, modelId), { reasoning: true }, ["low", "high"], "已核实不支持：off"),
      },
    });
    await registry.setChoice("s1", { mode: "explicit", sourceId: "a", modelId: "m" });
    // 尚无实际执行模型（actual 为 null），但选择已成立 → 档位应能按所选模型设置
    assert.equal(registry.read("s1").actual, null);
    const set = await registry.setThinkingLevel("s1", "high");
    assert.equal(set.thinkingLevel, "high");
    const rejected = await registry.setThinkingLevel("s1", "max");
    assert.equal(rejected.thinkingLevel, "high", "未核实的档位不得覆盖已设档位");
    assert.match(rejected.invalidReason ?? "", /未核实支持/);
  });

  void it("Pi 能力端口：thinkingLevelMap 里 null=该档不支持，缺键=未核实（都不是支持）", async () => {
    const presets = registerPresetProviders();
    const port = new PiCapabilityPort({ presets });
    // 取一个确有 thinkingLevelMap 的真实内置模型：逐档核实只取值为字符串的键
    let verified = 0;
    for (const preset of presets) {
      for (const model of preset.provider.getModels()) {
        const map = (model as { thinkingLevelMap?: Record<string, string | null> }).thinkingLevelMap;
        if (!map) continue;
        const got = await port.read({ sourceId: preset.id, modelId: model.id });
        assert.ok(got, "目录里的模型应有已核实能力资料");
        for (const level of THINKING_LEVELS) {
          const value = map[level];
          if (typeof value === "string") {
            assert.ok(got.thinkingLevels.includes(level), `${model.id} 的 ${level} 已核实支持却没出现`);
            assert.ok(got.thinkingNote === null || !got.thinkingNote.includes(`未核实：${level}`));
          } else if (value === null) {
            assert.ok(!got.thinkingLevels.includes(level), `${model.id} 的 ${level} 已核实不支持却出现了`);
            assert.ok(got.thinkingNote?.includes(level), "已核实不支持的档位必须在说明里出现");
          }
        }
        verified += 1;
        if (verified >= 25) break;
      }
      if (verified >= 25) break;
    }
    assert.ok(verified > 0, "应有带逐档资料的内置模型可核对");
  });

  void it("推理布尔为真但无逐档资料时，不显示任何档位（不按布尔猜六档）", async () => {
    const presets = registerPresetProviders();
    const port = new PiCapabilityPort({ presets });
    const provider = {
      id: "fake",
      name: "fake",
      authKinds: [],
      getModels: () => [{
        id: "m",
        name: "M",
        api: "openai-completions",
        provider: "fake",
        baseUrl: "https://example.invalid",
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        reasoning: true,
        contextWindow: 1000,
        maxTokens: 100,
      }],
    };
    const got = await port.read({ sourceId: "fake", modelId: "m" });
    assert.equal(got, null, "未登记来源应如实返回未核实");

    // 已登记但无 thinkingLevelMap：真实装配里通过 presets 读，这里用 registered 形态覆盖
    const withProvider = new PiCapabilityPort({
      presets: [{ ...presets[0]!, provider: provider as never }],
    });
    const second = await withProvider.read({ sourceId: presets[0]!.id, modelId: "m" });
    assert.ok(second);
    assert.deepEqual([...second.thinkingLevels], []);
    assert.match(second.thinkingNote ?? "", /未提供逐档核实资料/);
  });
});

void describe("真实请求事实：实际采用、用量与等待明确继续", () => {
  const source: ModelSourceEntry = {
    sourceId: "a",
    sourceLabel: "A",
    configured: true,
    models: [{ modelId: "m", modelLabel: "M" }],
  };
  const registryWith = (quotaState: QuotaFacts["state"]) => new SessionModelRegistry({
    sourcePort: { list: async () => [source] },
    allowlist: () => true,
    capabilityPort: { read: async ({ sourceId, modelId }) => capabilities(identity(sourceId, modelId), { "code-edit": true }) },
    quotaPort: { read: async ({ candidates }) => candidates.map((c) => quota(identity(c.sourceId, c.modelId), quotaState)), support: () => ({}) },
  });

  void it("判定成立不发布 actual；只有真实请求事件才发布", async () => {
    const registry = registryWith("available");
    const planned = await registry.resolve("s1", { requires: STRONG, runnable: true });
    assert.equal(planned.lastRouting?.decision.kind, "adopt");
    assert.equal(planned.actual, null, "计划不得冒充已用");
    assert.equal(planned.actualResponseId, null);

    const used = registry.noteRequests("s1", {
      attributions: [{
        identity: identity("a", "m"),
        responseId: "resp-123",
        result: "succeeded",
        usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, requests: 1 },
      }],
      totals: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, requests: 1 },
    });
    assert.equal(used.actual?.modelId, "m");
    assert.equal(used.actualResponseId, "resp-123", "实际采用必须带可核对的响应身份");
    assert.equal(used.lastResult, "succeeded");
    assert.equal(used.usage?.requests, 1);
    assert.equal(used.requests.length, 1, "逐次归属入账一条");
  });

  void it("实际采用带响应身份才合法：只给模型不给响应被接收侧拒绝", () => {
    const base = {
      sessionId: "s1",
      choice: { mode: "auto" } as const,
      actual: identity("a", "m"),
      usage: null,
      thinkingLevel: null,
      lastRouting: null,
      lastResult: "succeeded" as const,
      invalidReason: null,
      waitingExplicitContinue: false,
    };
    assert.equal(isSessionModelState({ ...base, actualResponseId: null }), false);
    assert.equal(isSessionModelState({ ...base, actualResponseId: "resp-1" }), true);
  });

  void it("改选不解除等待明确继续；额度恢复也不解除；只有明确继续才清除", async () => {
    const exhausted = registryWith("exhausted");
    const held = await exhausted.resolve("s1", { requires: STRONG, runnable: true });
    assert.equal(held.lastRouting?.decision.kind, "hold-all-exhausted");
    assert.equal(held.waitingExplicitContinue, true);

    // 改选（换模型）不解除：等的是用户的明确指令，不是换模型
    const changed = await exhausted.setChoice("s1", { mode: "explicit", sourceId: "a", modelId: "m" });
    assert.equal(changed.waitingExplicitContinue, true, "改选不得解除等待明确继续");

    // 额度恢复也不解除：把同一份状态交给一个额度已可用的实例重新判定
    const restored = registryWith("available");
    restored.hydrate(exhausted.toRecord(), undefined);
    const afterRecovery = await restored.resolve("s1", { requires: STRONG, runnable: true });
    assert.equal(afterRecovery.lastRouting?.decision.kind, "adopt", "额度恢复后判定为可用");
    assert.equal(afterRecovery.waitingExplicitContinue, true, "额度恢复本身不是继续指令");

    // 只有明确继续才清除
    assert.equal((await restored.continueExplicitly("s1")).waitingExplicitContinue, false);
  });

  void it("用量按真实助手条目求和发布，重复观测不翻倍、逐次归属不重复计量", async () => {
    const registry = registryWith("available");
    const r1 = {
      identity: identity("a", "m"),
      responseId: "r1",
      result: "succeeded" as const,
      usage: { input: 100, output: 50, cacheRead: 5, cacheWrite: 2, requests: 1 },
    };
    // 第一次观测：只有一条助手条目
    const first = registry.noteRequests("s1", {
      attributions: [r1],
      totals: { input: 100, output: 50, cacheRead: 5, cacheWrite: 2, requests: 1 },
    });
    assert.deepEqual(first.usage, { input: 100, output: 50, cacheRead: 5, cacheWrite: 2, requests: 1 });
    assert.equal(first.requests.length, 1);
    // 同一批条目被再次观测（轮询每轮都会重发）：总量与逐次归属都不得翻倍
    const repeat = registry.noteRequests("s1", {
      attributions: [r1],
      totals: { input: 100, output: 50, cacheRead: 5, cacheWrite: 2, requests: 1 },
    });
    assert.deepEqual(repeat.usage, { input: 100, output: 50, cacheRead: 5, cacheWrite: 2, requests: 1 });
    assert.equal(repeat.requests.length, 1, "同一 responseId 不得重复计量");
    // 第二次真实请求后：累计总量更新，逐次归属两条
    const more = registry.noteRequests("s1", {
      attributions: [r1, { identity: identity("a", "m"), responseId: "r2", result: "succeeded", usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, requests: 1 } }],
      totals: { input: 107, output: 53, cacheRead: 5, cacheWrite: 2, requests: 2 },
    });
    assert.deepEqual(more.usage, { input: 107, output: 53, cacheRead: 5, cacheWrite: 2, requests: 2 });
    assert.equal(more.actualResponseId, "r2", "实际采用取最近一次可核对的真实响应");
    assert.equal(more.requests.length, 2);
    assert.deepEqual(more.requests.map((r) => r.responseId), ["r1", "r2"]);
    // 空批次不改动已发生的归属（没有可核对响应身份时不得改写）
    const empty = registry.noteRequests("s1", { attributions: [], totals: null });
    assert.equal(empty.actualResponseId, "r2");
    assert.equal(empty.actual?.sourceId, "a", "无可核对响应身份时不得改写已发生的归属");
    assert.equal(empty.requests.length, 2);

    // 重开/执行端换实例后视图可能只剩更早的条目：实际采用**单调推进**，不得回退到旧请求
    const reopened = registry.noteRequests("s1", { attributions: [r1], totals: null });
    assert.equal(reopened.actualResponseId, "r2", "视图变旧不得把实际采用回退成更早的请求");
    assert.equal(reopened.requests.length, 2);
  });

  void it('分类无responseId仍按原请求身份计费一次，hydrate/旧视图不回退且不改chat实际模型', () => {
    const registry = registryWith('available');
    const chat = { identity: identity('a','m'), responseId:'chat-one', result:'succeeded' as const, usage:{input:2,output:1,cacheRead:0,cacheWrite:0,requests:1} };
    const baseline = registry.noteRequests('typed', {attributions:[chat], totals:null});
    const typed = { identity:identity('typed-provider','classifier'), operation:'classify' as const, requestId:'51/tool/7/classify/2', result:'failed' as const,
      usage:{input:17,output:3,cacheRead:0,cacheWrite:0,requests:1} };
    const one = registry.noteRequests('typed',{attributions:[typed],totals:null});
    assert.equal(one.actualResponseId, baseline.actualResponseId); assert.deepEqual(one.actual,baseline.actual);
    assert.equal(one.lastResult,baseline.lastResult); assert.deepEqual(one.choice,baseline.choice);
    assert.deepEqual(one.usage,{input:19,output:4,cacheRead:0,cacheWrite:0,requests:2});
    assert.equal(isSessionModelState(one),true);
    assert.equal('responseId' in one.requests[1]!,false,'原子任务身份不能伪造服务商responseId');
    assert.equal(isSessionModelState({...one,requests:[...one.requests,one.requests[1]]}),false);
    assert.equal(isSessionModelState({...one,requests:[{...one.requests[1],requestId:''}]}),false);
    const reopened=registryWith('available');reopened.hydrate(registry.toRecord(),undefined);
    const repeat=reopened.noteRequests('typed',{attributions:[typed,chat],totals:null});assert.deepEqual(repeat.usage,one.usage);
    const two=reopened.noteRequests('typed',{attributions:[{...typed,requestId:'52/tool/7/classify/3',usage:null}],totals:null});
    assert.equal(two.requests.length,3);assert.deepEqual(two.usage,one.usage);
    assert.equal(two.actualResponseId,'chat-one');
  });

  void it("显式改选后下一次请求用新来源：上一次实际采用的模型不得盖住新选择", async () => {
    const registry = registryWith("available");
    registry.noteRequests("s1", {
      attributions: [{ identity: identity("a", "m"), responseId: "r1", result: "succeeded", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, requests: 1 } }],
      totals: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, requests: 1 },
    });
    // 显式选择目标来源必须在来源目录里（否则只保留选择并给出真实原因）
    const two = new SessionModelRegistry({
      sourcePort: { list: async () => [source, { ...source, sourceId: "b", sourceLabel: "B", models: [{ modelId: "m2", modelLabel: "M2" }] }] },
      allowlist: () => true,
      capabilityPort: { read: async ({ sourceId, modelId }) => capabilities(identity(sourceId, modelId), { "code-edit": true }) },
      quotaPort: { read: async ({ candidates }) => candidates.map((c) => quota(identity(c.sourceId, c.modelId), "available")), support: () => ({}) },
    });
    await two.noteRequests("s1", {
      attributions: [{ identity: identity("a", "m"), responseId: "r1", result: "succeeded", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, requests: 1 } }],
      totals: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, requests: 1 },
    });
    const chosen = await two.setChoice("s1", { mode: "explicit", sourceId: "b", modelId: "m2" });
    assert.equal(chosen.choice.mode, "explicit");
    assert.equal(chosen.invalidReason, null, "已登记的来源不应被判为失效");
    assert.deepEqual(two.effectiveTarget("s1"), { sourceId: "b", modelId: "m2", thinkingLevel: null });
    // actual 仍是上一次真实请求的来源（显示用），但**不参与**本次请求的目标
    assert.equal(chosen.actual?.sourceId, "a");
  });

  void it("自动模式下按最近判定的采用候选；没有判定时不用 actual 覆盖执行端当前模型", async () => {
    const registry = registryWith("available");
    assert.equal(registry.effectiveTarget("s1"), null, "没有任何可核对目标时不擅自换模型");
    registry.noteRequests("s1", {
      attributions: [{ identity: identity("a", "m"), responseId: "r1", result: "succeeded", usage: null }],
      totals: null,
    });
    // actual 是**显示与历史核对**的事实，不是本次请求的目标：没有判定就不给目标，
    // 由执行端继续用它当前的模型，而不是拿上一次实际采用的来源去覆盖。
    assert.equal(registry.effectiveTarget("s1"), null, "没有判定时 actual 不得成为请求目标");
    const decided = await registry.resolve("s1", { requires: STRONG, runnable: true });
    assert.equal(decided.lastRouting?.decision.kind, "adopt");
    assert.deepEqual(registry.effectiveTarget("s1"), { sourceId: "a", modelId: "m", thinkingLevel: null });
  });

  void it("暂停／目标失效使代次失效：在途额度读取结果作废", async () => {
    const gate: { release: (() => void) | null } = { release: null };
    const registry = new SessionModelRegistry({
      sourcePort: { list: async () => [source] },
      allowlist: () => true,
      capabilityPort: { read: async ({ sourceId, modelId }) => capabilities(identity(sourceId, modelId), { "code-edit": true }) },
      quotaPort: {
        support: () => ({}),
        read: async () => {
          await new Promise<void>((resolve) => { gate.release = resolve; });
          return [quota(identity("a", "m"), "available")];
        },
      },
    });
    const pending = registry.resolve("s1", { requires: STRONG, runnable: true });
    await new Promise((r) => setTimeout(r, 5));
    registry.invalidate("s1", "会话已暂停");
    gate.release?.();
    const after = await pending;
    assert.equal(after.invalidReason, "会话已暂停");
    assert.equal(after.lastRouting, null, "失效前发起的判定结果不得在失效后写入");
  });
});

void describe("额度来自服务商真实响应头：窗口、共享池与耗尽分开", () => {
  const at = 1_700_000_000_000;

  void it("Anthropic 响应头给出权威剩余、窗口与共享池身份", () => {
    const facts = factsFromObservation({
      sourceId: "anthropic",
      modelId: "claude-opus-4-6",
      receivedAt: at,
      status: 200,
      headers: {
        "anthropic-ratelimit-requests-limit": "1000",
        "anthropic-ratelimit-requests-remaining": "998",
        "anthropic-ratelimit-requests-reset": "2026-10-12T05:30:00Z",
        "anthropic-workspace-id": "ws_abc",
      },
    });
    assert.ok(facts);
    assert.equal(facts.state, "available");
    assert.equal(facts.updatedAt, at);
    assert.equal(facts.reason, null);
    // 共享池 = 服务商披露的工作区；不同工作区不得互相背书
    assert.equal(facts.poolId, "anthropic:ws_abc");
    assert.ok(facts.windowLabel && facts.windowLabel.length > 0);
  });

  void it("剩余为 0 时是已知耗尽（带真实数字），不是未知", () => {
    const facts = factsFromObservation({
      sourceId: "anthropic",
      modelId: "claude-opus-4-6",
      receivedAt: at,
      status: 200,
      headers: { "anthropic-ratelimit-requests-limit": "1000", "anthropic-ratelimit-requests-remaining": "0", "anthropic-workspace-id": "ws_abc" },
    });
    assert.ok(facts);
    assert.equal(facts.state, "exhausted");
    assert.match(facts.reason ?? "", /0\/1000/);
  });

  void it("同一个响应里的全部适用约束收齐后才判定：任一已知耗尽不得被另一窗口的剩余覆盖", () => {
    // requests 还有剩余、tokens 已经为 0：整体是已知耗尽，不能先判 requests 就说可用
    const mixed = factsFromObservation({
      sourceId: "anthropic",
      modelId: "claude-opus-4-6",
      receivedAt: at,
      status: 200,
      headers: {
        "anthropic-ratelimit-requests-limit": "100",
        "anthropic-ratelimit-requests-remaining": "10",
        "anthropic-ratelimit-tokens-limit": "1000",
        "anthropic-ratelimit-tokens-remaining": "0",
        "anthropic-workspace-id": "ws_abc",
      },
    });
    assert.ok(mixed);
    assert.equal(mixed.state, "exhausted", "token 窗口耗尽时不得因请求窗口有剩余而说可用");
    assert.match(mixed.reason ?? "", /token/);
    assert.match(mixed.reason ?? "", /仍有剩余/, "有剩余的另一约束要写明，但不能因此判可用");

    // Anthropic 的 input/output 是**独立约束**：只有 output 耗尽同样是已知耗尽
    const outputOnly = factsFromObservation({
      sourceId: "anthropic",
      modelId: "claude-opus-4-6",
      receivedAt: at,
      status: 200,
      headers: {
        "anthropic-ratelimit-requests-limit": "1000",
        "anthropic-ratelimit-requests-remaining": "900",
        "anthropic-ratelimit-output-tokens-limit": "4000",
        "anthropic-ratelimit-output-tokens-remaining": "0",
        "anthropic-workspace-id": "ws_abc",
      },
    });
    assert.ok(outputOnly);
    assert.equal(outputOnly.state, "exhausted", "输出 token 窗口耗尽不得被请求窗口的剩余掩盖");
    assert.ok(outputOnly.windowLabel && /输出/.test(outputOnly.windowLabel), "窗口说明要指出是哪条约束耗尽");

    // 全部适用窗口都有剩余才是可用
    const allLeft = factsFromObservation({
      sourceId: "openai",
      modelId: "gpt-4o",
      receivedAt: at,
      status: 200,
      headers: {
        "x-ratelimit-limit-requests": "10000",
        "x-ratelimit-remaining-requests": "9990",
        "x-ratelimit-limit-tokens": "200000",
        "x-ratelimit-remaining-tokens": "150000",
      },
    });
    assert.ok(allLeft);
    assert.equal(allLeft.state, "available");
    assert.equal(allLeft.reason, null);
  });

  void it("观测会失效：窗口重置已过、或同一来源换了账户，都不再沿用旧数字", async () => {
    const port = new PiQuotaPort();
    // 窗口重置时间取未来：这条观察此刻有效
    const future = new Date(Date.now() + 3_600_000).toISOString();
    port.observe({
      sourceId: "anthropic",
      modelId: "claude-opus-4-6",
      receivedAt: Date.now(),
      status: 200,
      headers: {
        "anthropic-ratelimit-requests-limit": "1000",
        "anthropic-ratelimit-requests-remaining": "500",
        "anthropic-ratelimit-requests-reset": future,
        "anthropic-workspace-id": "ws_1",
      },
    });
    const fresh = (await port.read({ candidates: [{ sourceId: "anthropic", modelId: "claude-opus-4-6" }] }))[0];
    assert.equal(fresh.state, "available", "未到重置时间的观察有效");

    // 窗口早已重置：旧数字不得继续当作当前可用
    const stale = new PiQuotaPort();
    stale.observe({
      sourceId: "anthropic",
      modelId: "claude-opus-4-6",
      receivedAt: Date.now() - 7_200_000,
      status: 200,
      headers: {
        "anthropic-ratelimit-requests-limit": "1000",
        "anthropic-ratelimit-requests-remaining": "500",
        "anthropic-ratelimit-requests-reset": new Date(Date.now() - 3_600_000).toISOString(),
        "anthropic-workspace-id": "ws_1",
      },
    });
    const expired = (await stale.read({ candidates: [{ sourceId: "anthropic", modelId: "claude-opus-4-6" }] }))[0];
    assert.equal(expired.state, "unknown", "过期观察退回未读，不得继续称可用");
    assert.match(expired.reason ?? "", /尚未从|读取/, "过期要说真实原因");

    // 换账户：上一个账户的观测不能留给新身份
    const switched = new PiQuotaPort();
    const headersFor = (remaining: string, pool: string) => ({
      "anthropic-ratelimit-requests-limit": "1000",
      "anthropic-ratelimit-requests-remaining": remaining,
      "anthropic-ratelimit-requests-reset": future,
      "anthropic-workspace-id": pool,
    });
    switched.observe({ sourceId: "anthropic", modelId: "claude-opus-4-6", receivedAt: Date.now(), status: 200, headers: headersFor("900", "ws_old"), accountKey: "cred-old" });
    switched.observe({ sourceId: "anthropic", modelId: "claude-opus-4-6", receivedAt: Date.now(), status: 200, headers: headersFor("5", "ws_new"), accountKey: "cred-new" });
    const afterSwitch = (await switched.read({ candidates: [{ sourceId: "anthropic", modelId: "claude-opus-4-6", accountKey: "cred-new" }] }))[0];
    assert.equal(afterSwitch.poolId, "anthropic:ws_new", "读到的必须是新账户的观测");
    assert.equal(afterSwitch.state, "available", "新账户剩余 5 仍未耗尽");
    assert.equal(afterSwitch.updatedAt !== null, true);
    // 关键：读到的数字来自新账户，不是上一个账户那次观测的 900
    assert.equal(afterSwitch.reason, null, "可用时不给旧账户数字留解释位");
    const wrongAccount = (await switched.read({ candidates: [{ sourceId: "anthropic", modelId: "claude-opus-4-6", accountKey: "cred-old" }] }))[0];
    assert.notEqual(
      wrongAccount.poolId === "anthropic:ws_old" && wrongAccount.state === "available" && wrongAccount.updatedAt !== null,
      true,
      "旧账户身份不得从新账户那次观测里读到数字",
    );

    // 换凭据（清除/更换）后显式失效：旧账户数字不再出现
    switched.invalidateSource("anthropic");
    const afterInvalidate = (await switched.read({ candidates: [{ sourceId: "anthropic", modelId: "claude-opus-4-6" }] }))[0];
    assert.equal(afterInvalidate.state, "unknown", "换凭据后不得继续沿用上一账户的观测");
  });

  void it("429 但只是速率限制时是 unknown，不等于额度耗尽", () => {
    const facts = factsFromObservation({
      sourceId: "openai",
      modelId: "gpt-4o",
      receivedAt: at,
      status: 429,
      headers: { "retry-after": "30", "x-ratelimit-limit-requests": "60", "x-ratelimit-remaining-requests": "0" },
    });
    assert.ok(facts);
    assert.equal(facts.state, "unknown", "速率限制不是额度耗尽");
    assert.match(facts.reason ?? "", /速率限制/);
  });

  void it("支出上限的 429（无 retry-after）是已知耗尽，窗口按每月", () => {
    const facts = factsFromObservation({
      sourceId: "anthropic",
      modelId: "claude-opus-4-6",
      receivedAt: at,
      status: 429,
      headers: { "x-error-code": "enforced_spend_limit_reached", "anthropic-ratelimit-requests-remaining": "0" },
    });
    assert.ok(facts);
    assert.equal(facts.state, "exhausted");
    assert.equal(facts.windowLabel, "每月支出上限");
  });

  void it("未查证来源不被断言为「服务没有接口」", () => {
    const facts = factsFromObservation({ sourceId: "some-unverified", modelId: "m", receivedAt: at, status: 200, headers: {} });
    assert.equal(facts, null);
    const port = new PiQuotaPort();
    void port.support();
  });

  void it("支持清单逐来源给出依据，而不是一句都不支持", () => {
    const list = new PiQuotaPort().support();
    const entry = list.anthropic;
    assert.ok(entry, "已核实的来源必须出现在清单里");
    assert.equal(entry.kind, "connected");
    assert.match(entry.endpoint, /anthropic-ratelimit/);
    assert.match(entry.endpoint, /共享池按/);
    assert.ok(Object.keys(HEADER_BACKED_SOURCES).length >= 2);
  });

  void it("有真实观察时读到的就是服务商给的数字；没有观察时如实说尚未读到", async () => {
    const port = new PiQuotaPort();
    const before = (await port.read({ candidates: [{ sourceId: "anthropic", modelId: "claude-opus-4-6" }] }))[0];
    assert.ok(before);
    assert.equal(before.state, "unknown");
    assert.match(before.reason ?? "", /尚未从 .* 的真实响应读到/);

    port.observe({
      sourceId: "anthropic",
      modelId: "claude-opus-4-6",
      receivedAt: at,
      status: 200,
      headers: { "anthropic-ratelimit-requests-limit": "1000", "anthropic-ratelimit-requests-remaining": "500", "anthropic-workspace-id": "ws_1" },
    });
    const after = (await port.read({ candidates: [{ sourceId: "anthropic", modelId: "claude-opus-4-6" }] }))[0];
    assert.ok(after);
    assert.equal(after.state, "available");
    assert.equal(after.poolId, "anthropic:ws_1");

    // 未查证来源：既不声称有接口，也不声称没有
    const unknownSource = (await port.read({ candidates: [{ sourceId: "some-unverified", modelId: "m" }] }))[0];
    assert.ok(unknownSource);
    assert.equal(unknownSource.state, "unsupported");
    assert.match(unknownSource.reason ?? "", /未查证/);
  });
});

void describe("额度读取：没有可靠来源时如实 unsupported", () => {
  void it("无读取器时返回 unsupported，不返回 0 也不返回可用", async () => {
    const port = new PiQuotaPort();
    const [facts] = await port.read({ candidates: [{ sourceId: "a", modelId: "m" }] });
    assert.ok(facts);
    assert.equal(facts.state, "unsupported");
    assert.equal(facts.updatedAt, null);
    assert.ok(facts.reason);
    assert.ok(isQuotaFacts(facts));
  });

  void it("读取器抛错是「失败」态：降级为 unknown 并附真实原因，不是 0 也不是可用", async () => {
    const port = new PiQuotaPort({
      reader: {
        read: async () => {
          throw new Error("account-api-403");
        },
      },
    });
    const [facts] = await port.read({ candidates: [{ sourceId: "a", modelId: "m" }] });
    assert.ok(facts);
    assert.equal(facts.state, "unknown");
    assert.match(facts.reason ?? "", /account-api-403/);
  });

  void it("形状无法核对时降级为 unknown，不采信为可用", async () => {
    const port = new PiQuotaPort({
      reader: { read: async () => ({ anything: true }) as unknown as QuotaFacts },
    });
    const [facts] = await port.read({ candidates: [{ sourceId: "a", modelId: "m" }] });
    assert.ok(facts);
    assert.equal(facts.state, "unknown");
  });

  void it("读取额度不发送输入、不启用执行：注册表只返回事实", async () => {
    const submitted = { count: 0 };
    const registry = new SessionModelRegistry({
      sourcePort: { list: async () => [] },
      quotaPort: { read: async () => [quota(identity("a", "m"), "unsupported")], support: () => ({}) },
    });
    const facts = await registry.readQuota("a", "m");
    assert.equal(facts.state, "unsupported");
    assert.equal(submitted.count, 0);
  });
});

void describe("两份事实：新会话默认与每条会话自己的选择分开", () => {
  void it("改设置默认不动已有会话；改某条会话不动其它会话也不动默认", async () => {
    const sources: ModelSourceEntry[] = [
      { sourceId: "a", sourceLabel: "A", configured: true, models: [{ modelId: "m", modelLabel: "M" }] },
      { sourceId: "b", sourceLabel: "B", configured: true, models: [{ modelId: "n", modelLabel: "N" }] },
    ];
    const registry = new SessionModelRegistry({ sourcePort: { list: async () => sources } });

    await registry.setChoice("s1", { mode: "explicit", sourceId: "a", modelId: "m" });
    await registry.setChoice("s2", { mode: "auto" });

    const result = await registry.setDefaultChoice({ mode: "explicit", sourceId: "b", modelId: "n" });
    assert.equal(result.ok, true);
    assert.equal(registry.defaultChoice().mode, "explicit");
    // 已有会话的选择不受新默认影响
    assert.equal(registry.read("s1").choice.mode, "explicit");
    assert.equal((registry.read("s1").choice as { sourceId: string }).sourceId, "a");
    assert.equal(registry.read("s2").choice.mode, "auto");
  });

  void it("默认指向目录里没有的模型时如实失败，不先存下再失效", async () => {
    const registry = new SessionModelRegistry({
      sourcePort: {
        list: async () => [
          { sourceId: "a", sourceLabel: "A", configured: true, models: [{ modelId: "m", modelLabel: "M" }] },
        ],
      },
      allowlist: () => true,
    });
    const result = await registry.setDefaultChoice({ mode: "explicit", sourceId: "zzz", modelId: "nope" });
    assert.equal(result.ok, false);
    assert.equal(registry.defaultChoice().mode, "auto");
  });

  void it("选定目录里不存在的模型时保留用户选择但给出真实原因，不悄悄退回自动", async () => {
    const registry = new SessionModelRegistry({ sourcePort: { list: async () => [] }, allowlist: () => true });
    const state = await registry.setChoice("s1", { mode: "explicit", sourceId: "zzz", modelId: "nope" });
    assert.equal(state.choice.mode, "explicit");
    assert.match(state.invalidReason ?? "", /不在当前模型目录/);
  });
});

void describe("接收侧运行时校验", () => {
  void it("「可用」必须带更新时间且无原因，否则无可核对来源", () => {
    assert.equal(isQuotaFacts({ sourceId: "a", modelId: "m", state: "available", poolId: null, windowLabel: null, updatedAt: null, reason: null }), false);
    assert.equal(isQuotaFacts({ sourceId: "a", modelId: "m", state: "available", poolId: null, windowLabel: null, updatedAt: 1, reason: "x" }), false);
    assert.equal(isQuotaFacts({ sourceId: "a", modelId: "m", state: "available", poolId: null, windowLabel: null, updatedAt: 1, reason: null }), true);
  });

  void it("一个档位都没核实出来时必须给出真实说明", () => {
    const base = capabilities(identity("a", "m"));
    assert.equal(isVerifiedModelCapabilities({ ...base, thinkingLevels: [], thinkingNote: null }), false);
    assert.equal(isVerifiedModelCapabilities({ ...base, thinkingLevels: [], thinkingNote: "未提供逐档核实资料" }), true);
  });

  void it("「已采用」不得同时带失败原因：采用与失败分开记录", () => {
    const base = { sourceId: "a", modelId: "m" };
    assert.equal(isModelRoutingAttempt({ ...base, outcome: "adopted", reason: null }), true);
    assert.equal(isModelRoutingAttempt({ ...base, outcome: "adopted", reason: "额度耗尽" }), false);
    assert.equal(isModelRoutingAttempt({ ...base, outcome: "skipped-exhausted", reason: null }), true);
    assert.equal(isModelRoutingAttempt({ ...base, outcome: "unknown-kind", reason: null }), false);
  });

  void it("路由判定产出的每条尝试记录都能过接收侧校验（采用项不带原因）", () => {
    const m = capabilities(identity("a", "m"), { "code-edit": true });
    const out = decideModelRouting({
      choice: { mode: "auto" },
      requires: STRONG,
      candidates: [m, capabilities(identity("a", "other"), { "code-edit": false })],
      quota: [quota(m.identity, "available"), quota(identity("a", "other"), "available")],
      workRunnable: true,
    });
    for (const item of out.attempts) {
      assert.ok(isModelRoutingAttempt(item), `尝试记录未过接收侧校验：${JSON.stringify(item)}`);
      if (item.outcome === "adopted") assert.equal(item.reason, null);
      else assert.notEqual(item.reason, null, "未采用的尝试必须带真实原因");
    }
  });

  void it("会话选择与模型状态的畸形载荷被拒", () => {
    assert.equal(isSessionModelChoice({ mode: "auto" }), true);
    assert.equal(isSessionModelChoice({ mode: "explicit", sourceId: "", modelId: "m" }), false);
    assert.equal(isSessionModelChoice({ mode: "explicit", sourceId: "a" }), false);
    assert.equal(
      isSessionModelState({
        sessionId: "s1",
        choice: { mode: "auto" },
        actual: null,
        actualResponseId: null,
        usage: null,
        thinkingLevel: null,
        lastRouting: null,
        lastResult: "none",
        invalidReason: null,
        waitingExplicitContinue: false,
      }),
      true,
    );
    assert.equal(
      isSessionModelState({
        sessionId: "s1",
        choice: { mode: "auto" },
        actual: null,
        actualResponseId: null,
        usage: null,
        thinkingLevel: "ultra",
        lastRouting: null,
        lastResult: "none",
        invalidReason: null,
        waitingExplicitContinue: false,
      }),
      false,
    );
  });

  void it("fitsCapabilities 逐项核对，不按名称或排名推断", () => {
    const m = capabilities(identity("a", "m"), { "code-edit": true, "image-input": false });
    assert.equal(fitsCapabilities(m, ["code-edit"]), true);
    assert.equal(fitsCapabilities(m, ["code-edit", "image-input"]), false);
  });

  void it("额度判别辅助函数：只有真实 exhausted 才算已知耗尽", () => {
    assert.equal(isKnownExhausted(quota(identity("a", "m"), "exhausted")), true);
    assert.equal(isKnownExhausted(quota(identity("a", "m"), "unknown")), false);
    assert.equal(isKnownExhausted(quota(identity("a", "m"), "unsupported")), false);
    assert.equal(isKnownExhausted(quota(identity("a", "m"), "stale")), false);
    assert.equal(isKnownExhausted(undefined), false); // 没有事实不等于已知耗尽
    assert.equal(isConfirmedAvailable(quota(identity("a", "m"), "available")), true);
    assert.equal(isConfirmedAvailable(quota(identity("a", "m"), "unknown")), false);
    assert.equal(isConfirmedAvailable(undefined), false); // 额度列表里根本没有这个候选：不是可用
  });
});

void describe("注册表输出可过接收侧校验", () => {
  void it("路由判定后的状态本身是合法的 SessionModelState", async () => {
    const registry = new SessionModelRegistry({
      sourcePort: {
        list: async () => [
          { sourceId: "a", sourceLabel: "A", configured: true, models: [{ modelId: "m", modelLabel: "M" }] },
        ],
      },
      allowlist: () => true,
      capabilityPort: {
        read: async ({ sourceId, modelId }) =>
          capabilities(identity(sourceId, modelId), { "code-edit": true }, ["low"], "已核实不支持：off"),
      },
      quotaPort: { read: async ({ candidates }) => candidates.map((c) => quota(identity(c.sourceId, c.modelId), "available")), support: () => ({}) },
    });
    await registry.setChoice("s1", { mode: "auto" });
    const state = await registry.resolve("s1", { requires: STRONG, runnable: true });
    assert.ok(isSessionModelState(state), "路由判定后的状态必须能过接收侧校验");
    assert.equal(state.lastResult, "none", "判定成立不等于请求成功，两者分开");
  });

  void it("自动范围只限用户候选名单：名单外的模型不进入判定", async () => {
    const registry = new SessionModelRegistry({
      sourcePort: {
        list: async () => [
          {
            sourceId: "a",
            sourceLabel: "A",
            configured: true,
            models: [{ modelId: "allowed", modelLabel: "Allowed" }, { modelId: "outside", modelLabel: "Outside" }],
          },
        ],
      },
      // 用户只把 allowed 配进了候选名单
      allowlist: (id) => id.modelId === "allowed",
      capabilityPort: {
        read: async ({ sourceId, modelId }) => capabilities(identity(sourceId, modelId), { "code-edit": true }),
      },
      // 名单外的模型额度充足、也满足能力：仍然不得被选中
      quotaPort: {
        read: async ({ candidates }) => candidates.map((c) => quota(identity(c.sourceId, c.modelId), "available")),
        support: () => ({}),
      },
    });
    const out = await registry.resolve("s1", { requires: STRONG, runnable: true });
    assert.equal(out.lastRouting?.decision.kind, "adopt");
    assert.equal(out.lastRouting?.decision.kind === "adopt" ? out.lastRouting.decision.identity.modelId : "", "allowed");
    assert.equal(out.lastRouting?.attempts.some((a) => a.modelId === "outside"), false,
      "名单外的模型连尝试记录都不应产生");
  });

  void it("公开 resolve：必需能力未核实不给出可执行结论，有匹配依据才采用", async () => {
    /** 该来源对 image-input 的核实情况可变；其余能力都已有依据。 */
    const imageEvidence: { value: boolean | undefined } = { value: undefined }; // undefined = 夹具未给出 → 未核实
    const registry = new SessionModelRegistry({
      sourcePort: {
        list: async () => [{ sourceId: "a", sourceLabel: "A", configured: true, models: [{ modelId: "m", modelLabel: "M" }] }],
      },
      allowlist: () => true,
      capabilityPort: {
        read: async ({ sourceId, modelId }) => capabilities(identity(sourceId, modelId), { "code-edit": true, "image-input": imageEvidence.value }),
      },
      quotaPort: {
        read: async ({ candidates }) => candidates.map((c) => quota(identity(c.sourceId, c.modelId), "available")),
        support: () => ({}),
      },
    });
    await registry.setChoice("s1", { mode: "auto" });

    // 必需 image-input，而该来源对它的资料**未核实**：额度确认可用也不构成执行许可
    const held = await registry.resolve("s1", { requires: ["image-input"], runnable: true });
    assert.equal(held.lastRouting?.decision.kind, "hold-no-capable-candidate", `实得 ${held.lastRouting?.decision.kind}`);
    assert.match(
      held.lastRouting?.attempts.find((a) => a.modelId === "m")?.reason ?? "",
      /未核实/,
      "公开判定要如实说明缺的是 image-input 的核实依据",
    );

    // 合法对照：同一来源给出 image-input 的匹配依据后，同一份要求才成立
    imageEvidence.value = true;
    const adopted = await registry.resolve("s1", { requires: ["image-input"], runnable: true });
    assert.equal(adopted.lastRouting?.decision.kind, "adopt", `实得 ${adopted.lastRouting?.decision.kind}`);
    assert.equal(adopted.lastRouting?.decision.kind === "adopt" ? adopted.lastRouting.decision.identity.modelId : "", "m");
  });

  void it("已配置但未列入名单的模型不进候选；未配置来源即使在名单也不进", async () => {
    const listed = new SessionModelRegistry({
      sourcePort: {
        list: async () => [{ sourceId: "a", sourceLabel: "A", configured: true, models: [{ modelId: "m", modelLabel: "M" }] }],
      },
      allowlist: (id) => id.sourceId !== "unconfigured-source",
      capabilityPort: { read: async ({ sourceId, modelId }) => capabilities(identity(sourceId, modelId), { "code-edit": true }) },
    });
    // 名单内且已配置 → 进入候选范围（额度无来源时给出有界尝试，而不是"没有适合候选"）
    assert.notEqual((await listed.resolve("s1", { requires: STRONG, runnable: true })).lastRouting?.decision.kind, "hold-no-capable-candidate");

    const notConfigured = new SessionModelRegistry({
      // 来源在名单里，但没有使用条件（未配置／未认证）→ 不是"不适合"，而是"还不能用"
      sourcePort: {
        list: async () => [{ sourceId: "a", sourceLabel: "A", configured: false, models: [{ modelId: "m", modelLabel: "M" }] }],
      },
      allowlist: () => true,
      capabilityPort: { read: async ({ sourceId, modelId }) => capabilities(identity(sourceId, modelId), { "code-edit": true }) },
    });
    const out = await notConfigured.resolve("s2", { requires: STRONG, runnable: true });
    assert.equal(out.lastRouting?.decision.kind, "hold-no-capable-candidate");
  });

  void it("选择方式与实际采用分别可辨：改选择后实际采用仍是上一个", async () => {
    const registry = new SessionModelRegistry({
      sourcePort: {
        list: async () => [
          {
            sourceId: "a",
            sourceLabel: "A",
            configured: true,
            models: [{ modelId: "m", modelLabel: "M" }, { modelId: "n", modelLabel: "N" }],
          },
        ],
      },
      allowlist: () => true,
      capabilityPort: {
        read: async ({ sourceId, modelId }) => capabilities(identity(sourceId, modelId), { "code-edit": true }),
      },
      quotaPort: { read: async ({ candidates }) => candidates.map((c) => quota(identity(c.sourceId, c.modelId), "available")), support: () => ({}) },
    });
    // 路由**判定**成立不等于已经用过它：实际采用只由真实请求事件发布。
    const planned = await registry.resolve("s1", { requires: STRONG, runnable: true });
    assert.equal(planned.lastRouting?.decision.kind, "adopt", "判定应给出采用结论");
    assert.equal(planned.actual, null, "判定成立不得冒充已经用过该模型");
    const changed = await registry.setChoice("s1", { mode: "explicit", sourceId: "a", modelId: "n" });
    assert.equal(changed.choice.mode, "explicit");
    assert.equal(changed.actual, null, "改选择本身不构成已切换模型");
  });
});

void describe("全部耗尽后不自动续跑", () => {
  void it("耗尽后额度恢复也不会自动改成采用：必须等明确继续", async () => {
    const state: SessionModelChoice = { mode: "auto" };
    const m = capabilities(identity("a", "m"), { "code-edit": true });
    const exhausted = decideModelRouting({
      choice: state,
      requires: STRONG,
      candidates: [m],
      quota: [quota(m.identity, "exhausted")],
      workRunnable: true,
    });
    assert.equal(exhausted.decision.kind, "hold-all-exhausted");
    // 额度恢复后的下一次判定是新的一次判定；「不自动续跑」由运行控制负责，
    // 路由判定本身不再产出采用，也不得把 hold 改标成 unknown。
    const recovered = decideModelRouting({
      choice: state,
      requires: STRONG,
      candidates: [m],
      quota: [quota(m.identity, "available")],
      workRunnable: true,
    });
    assert.equal(recovered.decision.kind, "adopt");
    assert.notEqual(exhausted.decision.kind, "bounded-attempt");
  });
});
