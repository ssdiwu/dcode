import { uiText, localizeUi } from "../../../shared/ui-language.ts";
import type { FoundationSnapshot } from "../types";

type AgentRun = FoundationSnapshot["agentRuns"][number];
type TeamRun = FoundationSnapshot["teamRuns"][number];
export type MemberTone = "active" | "waiting" | "prepared" | "rework" | "recheck" | "reviewFailed" | "complete" | "error" | "unknown";

export interface MemberOverview {
  id: string;
  sessionId?: string;
  title: string;
  role: string;
  status: string;
  tone: MemberTone;
  assignment?: string;
  duration?: string;
  waitingReason?: string;
  reportId?: string;
  verificationId?: string;
  result?: string;
}

export interface TeamOverviewRound {
  id: string;
  ordinal: number;
  historical: boolean;
  status: string;
  counts: Array<{ label: string; value: number; tone: MemberTone }>;
  coordinator?: MemberOverview;
  members: MemberOverview[];
  failureReason?: string;
}

const inProgress = new Set(["prepared", "active", "waiting"]);
const statusNames: Record<string, string> = localizeUi({
  prepared: "待开始", active: "进行中", running: "运行中", waiting: "等待处理",
  completed: "已完成", failed: "失败", aborted: "已停止", interrupted: "已中断",
  unknown: "状态待核对",
});
const roleNames: Record<string, string> = localizeUi({
  coordinator: "协调者", worker: "执行", verifier: "验收", explorer: "调研",
});
const statusTone = (status: string): MemberTone =>
  status === "running" || status === "active" ? "active" :
  status === "waiting" ? "waiting" :
  status === "prepared" ? "prepared" :
  status === "completed" ? "complete" :
  ["failed", "aborted", "interrupted"].includes(status) ? "error" : "unknown";
const compact = (value: string, limit = 92) => {
  const cleaned = value.replace(/\s+/gu, " ").trim();
  return cleaned.length > limit ? `${cleaned.slice(0, limit - 1)}…` : cleaned;
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const readableDuration = (milliseconds: number) => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds >= 3600) return uiText("{0} 小时 {1} 分", [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60)]);
  if (seconds >= 60) return uiText("{0} 分 {1} 秒", [Math.floor(seconds / 60), seconds % 60]);
  return uiText("{0} 秒", [seconds]);
};

/** Only a member's own Session Run can prove elapsed time. Coordinator runs can span several Team Runs. */
function memberDuration(snapshot: FoundationSnapshot, run: AgentRun, now: number, historical: boolean): string | undefined {
  if (run.role === "coordinator") return undefined;
  const sessionRun = snapshot.sessionRuns.filter(item => item.taskId === run.taskId && item.agentRunId === run.id && item.sessionId === run.sessionId).at(-1);
  if (!sessionRun?.startedAt) return undefined;
  const start = Date.parse(sessionRun.startedAt);
  const end = sessionRun.completedAt ? Date.parse(sessionRun.completedAt) : !historical && ["running", "waiting"].includes(sessionRun.status) ? now : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  return uiText("最近执行 {0}", [readableDuration(end - start)]);
}

function member(snapshot: FoundationSnapshot, run: AgentRun, team: TeamRun | undefined, historical: boolean, now: number): MemberOverview {
  const session = snapshot.sessions.find(item => item.id === run.sessionId && item.taskId === run.taskId && item.kind === (run.role === "coordinator" ? "coordination" : "child"));
  const profile = object(run.profileSnapshot);
  const title = run.role === "coordinator" ? uiText("协调者") : session?.title || (typeof profile.name === "string" ? profile.name : uiText("成员"));
  const assignment = snapshot.agentAssignments.findLast(item => item.taskId === run.taskId && item.agentRunId === run.id && item.teamRunId === team?.id && item.assignmentKind === (run.role === "coordinator" ? "coordinator" : "member"));
  const packet = object(assignment?.taskPacket);
  const currentWorkItem = typeof packet.currentWorkItemId === "string"
    ? snapshot.taskWorkItems.find(item => item.id === packet.currentWorkItemId && item.taskId === run.taskId && item.ownerAssignmentId === assignment?.id)
    : snapshot.taskWorkItems.filter(item => item.taskId === run.taskId && item.ownerAssignmentId === assignment?.id).at(-1);
  const instruction = typeof packet.instruction === "string" ? packet.instruction : undefined;
  const taskName = typeof packet.title === "string" ? packet.title : undefined;
  const assignmentSummary = currentWorkItem?.title || instruction || (run.role === "coordinator" ? taskName : undefined);
  // A coordinator Agent Run may be reused by several Team Runs; its reports have no Team Run id.
  const latestReport = run.role === "coordinator" ? undefined : snapshot.agentReports.filter(item => item.taskId === run.taskId && item.agentRunId === run.id && item.reportKind !== "verification").at(-1);
  const verification = latestReport && snapshot.verifications?.filter(item => item.taskId === run.taskId && item.subjectAgentRunId === run.id && item.subjectReportId === latestReport.id).at(-1);
  const review = verification && snapshot.coordinatorReviews?.find(item => item.taskId === run.taskId && item.verificationId === verification.id);
  const request = !historical && run.status === "waiting" && snapshot.agentRequests.find(item => item.taskId === run.taskId && item.agentRunId === run.id && item.status === "open" && (!team || !item.teamRunId || item.teamRunId === team.id));
  const staleActivity = historical && ["prepared", "running", "waiting"].includes(run.status);
  const pendingReview = run.status === "completed"
    ? review?.outcome === "rework" ? { status: uiText("待返工"), tone: "rework" as const }
      : review?.outcome === "recheck" ? { status: uiText("待复验"), tone: "recheck" as const }
      : verification?.verdict === "fail" ? { status: uiText("验收未通过"), tone: "reviewFailed" as const }
      : undefined
    : undefined;
  const status = staleActivity ? uiText("历史状态待核对") : pendingReview?.status ?? (run.status === "completed" ? uiText("执行结束") : statusNames[run.status] ?? uiText("状态待核对"));
  const duration = memberDuration(snapshot, run, now, historical);
  const result = review
    ? review.outcome === "accepted" ? uiText("协调复核通过") : review.outcome === "rework" ? uiText("需要返工") : uiText("需要复验")
    : verification ? verification.verdict === "pass" ? uiText("独立验收通过，待复核") : uiText("独立验收未通过，待复核")
    : latestReport ? uiText("报告已保存，待独立验收") : undefined;
  return {
    id: run.id,
    ...(session ? { sessionId: session.id } : {}),
    title,
    role: run.role === "coordinator" ? uiText("主对话") : roleNames[run.role] ?? compact(run.role, 24),
    status,
    tone: staleActivity ? "unknown" : pendingReview?.tone ?? statusTone(run.status),
    ...(assignmentSummary ? { assignment: compact(assignmentSummary) } : {}),
    ...(duration ? { duration } : {}),
    ...(request ? { waitingReason: uiText("等待你的决定") } : {}),
    ...(latestReport ? { reportId: latestReport.id } : {}),
    ...(verification ? { verificationId: verification.id } : {}),
    ...(result ? { result } : {}),
  };
}

function round(snapshot: FoundationSnapshot, team: TeamRun, ordinal: number, historical: boolean, now: number): TeamOverviewRound {
  const members = snapshot.agentRuns
    .filter(item => item.taskId === team.taskId && item.teamRunId === team.id && item.role !== "coordinator")
    .map(item => member(snapshot, item, team, historical, now));
  const coordinator = snapshot.agentRuns.find(item => item.id === team.coordinatorAgentRunId && item.taskId === team.taskId && item.role === "coordinator");
  const counts: TeamOverviewRound["counts"] = [];
  for (const [tone, label] of [["active", uiText("运行")], ["waiting", uiText("等待")], ["prepared", uiText("待开始")], ["rework", uiText("待返工")], ["recheck", uiText("待复验")], ["reviewFailed", uiText("验收未通过")], ["complete", uiText("执行结束")], ["error", uiText("执行失败或中断")], ["unknown", uiText("待核对")]] as const) {
    const value = members.filter(item => item.tone === tone).length;
    if (value) counts.push({ label, value, tone });
  }
  const failure = snapshot.teamFailures.filter(item => item.taskId === team.taskId && item.teamRunId === team.id).at(-1);
  return {
    id: team.id, ordinal, historical,
    status: historical ? uiText("历史结果 · {0}", [statusNames[team.status] ?? uiText("状态待核对")]) : statusNames[team.status] ?? uiText("状态待核对"),
    counts,
    ...(coordinator ? { coordinator: member(snapshot, coordinator, team, historical, now) } : {}),
    members,
    ...(failure?.reason ? { failureReason: compact(failure.reason, 150) } : {}),
  };
}

export function projectTeamOverview(snapshot: FoundationSnapshot, taskId: string, now = Date.now()): { rounds: TeamOverviewRound[]; ungrouped: MemberOverview[] } {
  // Product Store emits Team Runs in creation order. A reopened run is the active round even if older.
  const teams = snapshot.teamRuns.filter(item => item.taskId === taskId);
  const current = teams.findLast(item => inProgress.has(item.status)) ?? teams.at(-1);
  const rounds = current ? [round(snapshot, current, teams.indexOf(current) + 1, !inProgress.has(current.status), now),
    ...teams.filter(item => item.id !== current.id).map(item => round(snapshot, item, teams.indexOf(item) + 1, true, now)).reverse()] : [];
  const knownTeams = new Set(teams.map(item => item.id));
  const ungrouped = snapshot.agentRuns
    .filter(item => item.taskId === taskId && item.role !== "coordinator" && (!item.teamRunId || !knownTeams.has(item.teamRunId)))
    .map(item => member(snapshot, item, undefined, true, now));
  return { rounds, ungrouped };
}
