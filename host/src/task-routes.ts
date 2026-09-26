import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const Text = Type.String({ minLength: 1, maxLength: 4000, pattern: "\\S" });
const Id = Type.String({ minLength: 1, maxLength: 200 });
const Texts = Type.Array(Text, { maxItems: 16 });
const Evidence = Type.Array(Id, { maxItems: 32, uniqueItems: true });
const Budget = Type.Object({
  candidates: Type.Integer({ minimum: 1, maximum: 32 }),
  checks: Type.Integer({ minimum: 1, maximum: 64 }),
  rounds: Type.Integer({ minimum: 1, maximum: 8 }),
}, { additionalProperties: false });
export const RouteCandidateSchema = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 200, pattern: "\\S" }),
  approach: Text,
  assumptions: Texts,
  basis: Text,
  evidenceIds: Evidence,
  failureConditions: Type.Array(Text, { minItems: 1, maxItems: 16 }),
  probe: Text,
  expectedCost: Text,
  remainingWork: Texts,
  dependencies: Text,
  derivedFrom: Type.Optional(Id),
}, { additionalProperties: false });

export const RouteOperationSchema = Type.Union([
  Type.Object({ action: Type.Literal("begin"), question: Text, budget: Budget, independentCheck: Type.Boolean() }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("propose"), candidate: RouteCandidateSchema, strategyChange: Type.Optional(Text) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("check"), candidateId: Id, outcome: Type.Union([Type.Literal("ready"), Type.Literal("revise"), Type.Literal("reject"), Type.Literal("unknown")]), findings: Type.Array(Text, { maxItems: 16, description: "仅填写未解决的问题。outcome=ready 时必须是空数组 []；已验证事实和通过理由填写 summary，实际检查证据引用填写 evidenceIds。" }), summary: Text, evidenceIds: Evidence }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("adopt"), candidateId: Id, reason: Text }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("invalidate"), reason: Text, evidenceIds: Evidence }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("reopen"), reason: Text }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("stop"), reason: Text }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("work"), title: Type.String({ minLength: 1, maxLength: 500, pattern: "\\S" }), completion: Text, dependsOn: Type.Array(Id, { maxItems: 32, uniqueItems: true }) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("cancel_work"), workItemId: Id, reason: Text }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("acknowledge"), inputId: Id, impact: Type.Union([Type.Literal("unchanged"), Type.Literal("changed")]), reason: Text }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("extend"), inputId: Id, budget: Budget, reason: Text }, { additionalProperties: false }),
]);
export type RouteOperation = Static<typeof RouteOperationSchema>;
export type RouteCandidate = Static<typeof RouteCandidateSchema> & {
  id: string; round: number; authorAgentRunId: string; sessionRunId: string; createdAt: string;
};
export interface RouteCheck {
  id: string; candidateId: string; actorAgentRunId: string; sessionRunId: string; createdAt: string;
  outcome: "ready" | "revise" | "reject" | "unknown"; findings: string[]; summary: string; evidenceIds: string[];
  evidenceFingerprint?: string;
}
export interface TaskRouteState {
  version: 1;
  question: string;
  status: "exploring" | "ready" | "invalidated" | "stopped";
  contextKey: string;
  round: number;
  budget: Static<typeof Budget>;
  independentCheck: boolean;
  acknowledgedInputId?: string;
  budgetInputId?: string;
  candidates: RouteCandidate[];
  checks: RouteCheck[];
  selectedCandidateId?: string;
  reason: string;
  history: Array<{ action: RouteOperation["action"]; actorAgentRunId: string; sessionRunId: string; createdAt: string; reason: string; candidateId?: string; workItemId?: string; inputId?: string; budget?: Static<typeof Budget> }>;
}
export interface TaskRouteContext { planId: string; planRevision: number; contextCurrent: boolean; inputCurrent?: boolean; pendingInput?: { id: string; text: string; sessionId: string; complete: boolean }; route: TaskRouteState }

export interface RouteBinding {
  planId: string;
  round: number;
  purpose: "explore" | "check" | "execute" | "review";
  candidateId?: string;
  workItemId?: string;
}
export interface RouteWork {
  planId: string; round: number; candidateId: string;
  completion: string; dependsOn: string[];
  invalidatedReason?: string;
  recheckAfterRevision?: number;
  recheckReason?: string;
  cancelledReason?: string;
}
export const RouteDispatchSchema = Type.Object({
  purpose: Type.Union([Type.Literal("explore"), Type.Literal("check"), Type.Literal("execute"), Type.Literal("review"), Type.Literal("independent")]),
  candidateId: Type.Optional(Id), workItemId: Type.Optional(Id), reason: Type.Optional(Text),
}, { additionalProperties: false });
export type RouteDispatch = Static<typeof RouteDispatchSchema>;
export function readRouteWork(details: unknown): RouteWork | undefined {
  return details && typeof details === "object" ? (details as { routeWork?: RouteWork }).routeWork : undefined;
}
export function bindingMatchesRoute(binding: RouteBinding, context: TaskRouteContext | undefined): boolean {
  if (!context || !context.contextCurrent || binding.planId !== context.planId || binding.round !== context.route.round) return false;
  return binding.purpose === "execute" || binding.purpose === "review"
    ? context.route.status === "ready" && binding.candidateId === context.route.selectedCandidateId
    : context.route.status === "exploring";
}

export class TaskRouteError extends Error {
  constructor(readonly code: "INVALID_ARGUMENT" | "REVISION_CONFLICT" | "ROUTE_NOT_READY" | "ROUTE_LIMIT", message: string) {
    super(message); this.name = "TaskRouteError";
  }
}

export function parseRouteOperation(value: unknown): RouteOperation {
  if (!Value.Check(RouteOperationSchema, value)) throw new TaskRouteError("INVALID_ARGUMENT", "路线操作缺少必要内容或超出允许范围");
  return value;
}

/** Only Product Store writes this reserved part of the existing Task Plan. */
export function readTaskRoute(document: unknown): TaskRouteState | undefined {
  if (!document || typeof document !== "object") return undefined;
  const route = (document as { routeExploration?: TaskRouteState }).routeExploration;
  if (route === undefined) return undefined;
  if (!route || route.version !== 1 || !Array.isArray(route.candidates) || !Array.isArray(route.checks) || !Array.isArray(route.history)) {
    throw new TaskRouteError("INVALID_ARGUMENT", "任务路线记录不可读取，请保留原记录并检查来源");
  }
  return route;
}

export function summarizeTaskRoute(context: TaskRouteContext) {
  const { route } = context;
  return {
    planId: context.planId, planRevision: context.planRevision,
    contextCurrent: context.contextCurrent,
    inputCurrent: context.inputCurrent,
    ...(context.pendingInput ? { pendingInput: context.pendingInput } : {}),
    question: route.question, status: route.status, reason: route.reason, round: route.round,
    independentCheck: route.independentCheck,
    needsStrategyChange: needsRouteStrategyChange(route),
    budget: route.budget, used: { candidates: route.candidates.length, checks: route.checks.length, rounds: route.round },
    selectedCandidateId: route.selectedCandidateId ?? null,
    candidates: route.candidates.map(candidate => ({ id: candidate.id, title: candidate.title, round: candidate.round, authorAgentRunId: candidate.authorAgentRunId,
      checks: route.checks.filter(check => check.candidateId === candidate.id).map(check => ({ id: check.id, outcome: check.outcome, actorAgentRunId: check.actorAgentRunId })) })),
    detail: "使用 read 分页读取完整候选、检查、来源和历史；摘要不能代替原文核查。",
  };
}

export function needsRouteStrategyChange(route: TaskRouteState): boolean {
  const last = route.checks.slice(-2);
  return last.length === 2 && last.every(check => check.outcome !== "ready") && !!last[0]!.evidenceFingerprint && last[0]!.evidenceFingerprint === last[1]!.evidenceFingerprint;
}

export function transitionTaskRoute(previous: TaskRouteState | undefined, operation: RouteOperation, actor: {
  agentRunId: string; sessionRunId: string; role: string; contextKey: string; now: string; id: string; latestInputId?: string;
}): TaskRouteState {
  const fail = (message: string): never => { throw new TaskRouteError("ROUTE_NOT_READY", message); };
  if (!["propose", "check"].includes(operation.action) && actor.role !== "coordinator") fail("只有协调者可以决定任务路线与探索范围");
  if (operation.action === "begin") {
    if (previous) fail("探索已经存在；使用 reopen 保留累计投入和历史，不能重新开始清空记录");
    return {
      version: 1, question: operation.question, status: "exploring", contextKey: actor.contextKey,
      round: 1, budget: operation.budget, independentCheck: operation.independentCheck, candidates: [], checks: [], reason: operation.question,
      acknowledgedInputId: actor.latestInputId, budgetInputId: actor.latestInputId,
      history: [{ action: "begin", actorAgentRunId: actor.agentRunId, sessionRunId: actor.sessionRunId, createdAt: actor.now, reason: operation.question, inputId: actor.latestInputId, budget: operation.budget }],
    };
  }
  if (!previous) return fail("尚未开始路线探索；可靠做法明确的小任务可直接推进");
  const next = structuredClone(previous);
  if (next.history.length >= 160) throw new TaskRouteError("ROUTE_LIMIT", "本次探索记录已达上限，请交付现有结果与剩余问题");
  if (!["stop", "invalidate", "reopen", "acknowledge", "extend"].includes(operation.action) && next.contextKey !== actor.contextKey) {
    throw new TaskRouteError("REVISION_CONFLICT", "任务目标或选定上下文已改变，请重新核对路线");
  }
  const record = (reason: string, candidateId?: string) => next.history.push({
    action: operation.action, actorAgentRunId: actor.agentRunId, sessionRunId: actor.sessionRunId,
    createdAt: actor.now, reason, ...(candidateId ? { candidateId } : {}),
    ...("inputId" in operation ? { inputId: operation.inputId } : {}),
    ...("workItemId" in operation ? { workItemId: operation.workItemId } : {}),
    ...(operation.action === "extend" ? { budget: operation.budget } : {}),
  });
  if (["adopt", "work", "cancel_work"].includes(operation.action) && next.acknowledgedInputId !== actor.latestInputId) fail("存在用户新输入，请先核对其对当前路线的影响");
  if (operation.action === "acknowledge") {
    if (operation.inputId !== actor.latestInputId) fail("用户输入已更新，请读取最新原文后再判断");
    if (operation.impact === "unchanged" && next.contextKey !== actor.contextKey) fail("选定上下文已改变，需要重新检查路线");
    next.acknowledgedInputId = operation.inputId;
    if (operation.impact === "changed") { next.status = "invalidated"; delete next.selectedCandidateId; }
    next.reason = operation.reason; record(operation.reason);
  } else if (operation.action === "extend") {
    if (!["stopped", "invalidated"].includes(next.status)) fail("先收口当前探索，再根据用户新决定调整投入");
    if (operation.inputId !== actor.latestInputId || operation.inputId === next.budgetInputId) fail("调整投入需要尚未用于预算调整的用户新输入");
    const fields = ["candidates", "checks", "rounds"] as const;
    if (fields.some(field => operation.budget[field] < next.budget[field]) || !fields.some(field => operation.budget[field] > next.budget[field])) fail("新的投入上限必须明确增加，累计投入不会清空");
    next.budget = operation.budget; next.budgetInputId = operation.inputId; next.acknowledgedInputId = operation.inputId;
    next.reason = operation.reason; record(operation.reason);
  } else if (operation.action === "cancel_work") {
    if (next.status !== "ready") fail("只能在当前已采用路线中收口未派发安排");
    record(operation.reason, next.selectedCandidateId);
  } else if (operation.action === "work") {
    if (next.status !== "ready" || !next.selectedCandidateId) fail("采用成熟路线后才能建立执行工作项");
    record(operation.title, next.selectedCandidateId);
  } else if (operation.action === "propose") {
    if (next.status !== "exploring") fail("当前未处于探索阶段");
    if (needsRouteStrategyChange(next) && !operation.strategyChange?.trim()) fail("连续两次检查没有新证据，需要说明方法调整或停止重复");
    if (next.candidates.length >= next.budget.candidates) throw new TaskRouteError("ROUTE_LIMIT", "候选投入已达上限，请报告结果与剩余问题");
    if (operation.candidate.derivedFrom && !next.candidates.some(c => c.id === operation.candidate.derivedFrom)) fail("修订来源不属于本任务路线");
    next.candidates.push({ ...operation.candidate, id: actor.id, round: next.round, authorAgentRunId: actor.agentRunId, sessionRunId: actor.sessionRunId, createdAt: actor.now });
    record(operation.strategyChange ? `${operation.candidate.title}；方法调整：${operation.strategyChange}` : operation.candidate.title, actor.id);
  } else if (operation.action === "check") {
    const candidate = next.candidates.find(c => c.id === operation.candidateId);
    if (!candidate || candidate.round !== next.round || next.status !== "exploring") fail("只能检查当前探索轮次的候选");
    if (next.independentCheck && candidate!.authorAgentRunId === actor.agentRunId) fail("此轮要求独立检查，须由不同于候选提出者的智能体执行");
    if (next.checks.length >= next.budget.checks) throw new TaskRouteError("ROUTE_LIMIT", "检查投入已达上限，请报告结果与剩余问题");
    if (operation.outcome === "ready" && !operation.evidenceIds.length) fail("outcome=ready 必须在 evidenceIds 提供本人实际检查的证据 ID");
    if (operation.outcome === "ready" && operation.findings.length) fail("outcome=ready 时 findings 必须为 []。findings 只填写未解决的问题；请将已验证事实和通过理由移入 summary，实际证据引用保留在 evidenceIds，再提交同一候选的检查");
    if (["reject", "revise"].includes(operation.outcome) && !operation.findings.length) fail("否定或修订结论需要指出具体问题");
    next.checks.push({ ...operation, id: actor.id, actorAgentRunId: actor.agentRunId, sessionRunId: actor.sessionRunId, createdAt: actor.now });
    record(operation.summary, operation.candidateId);
  } else if (operation.action === "adopt") {
    const candidate = next.candidates.find(c => c.id === operation.candidateId);
    const checks = next.checks.filter(c => c.candidateId === operation.candidateId);
    if (next.status !== "exploring" || !candidate || candidate.round !== next.round) fail("需要当前探索轮次的候选");
    // An inability to check is not a defect in the candidate. A later ready
    // check (with fresh evidence enforced by Store) can complete that inquiry;
    // actual objections still require a revised candidate and its own checks.
    if (checks.at(-1)?.outcome !== "ready" || checks.some(c => c.outcome === "reject" || c.outcome === "revise")) fail("检查尚未形成无未决异议的成熟路线；unknown 须补充新证据并重新检查，reject/revise 须提交修订候选并重新检查");
    next.status = "ready"; next.selectedCandidateId = operation.candidateId; next.reason = operation.reason;
    record(operation.reason, operation.candidateId);
  } else if (operation.action === "reopen") {
    if (next.status === "exploring" || next.status === "ready") fail("先记录停止或路线失效依据，再重新探索");
    if (next.round >= next.budget.rounds || next.candidates.length >= next.budget.candidates || next.checks.length >= next.budget.checks) throw new TaskRouteError("ROUTE_LIMIT", "累计探索投入已达上限，不能通过重新开一轮绕过");
    next.round++; next.status = "exploring"; next.contextKey = actor.contextKey; delete next.selectedCandidateId;
    next.acknowledgedInputId = actor.latestInputId;
    next.reason = operation.reason; record(operation.reason);
  } else {
    if (operation.action === "invalidate" && next.status !== "ready") fail("当前没有已采用路线可作废");
    next.status = operation.action === "invalidate" ? "invalidated" : "stopped";
    next.reason = operation.reason; record(operation.reason, next.selectedCandidateId);
    delete next.selectedCandidateId;
  }
  return next;
}
