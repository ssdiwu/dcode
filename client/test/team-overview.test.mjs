import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import { projectTeamOverview } from "../src/renderer/src/workbench/team-overview.ts";

const time = "2026-09-29T01:00:00.000Z";
const task = { id: "task-one", title: "检查工作台", state: "active" };
const snapshot = {
  teamRuns: [
    { id: "round-old-active", taskId: task.id, coordinatorAgentRunId: "coordinator", status: "active" },
    { id: "round-new-finished", taskId: task.id, coordinatorAgentRunId: "coordinator", status: "completed" },
    { id: "other-round", taskId: "other-task", coordinatorAgentRunId: "other-coordinator", status: "active" },
  ],
  agentRuns: [
    { id: "coordinator", taskId: task.id, sessionId: "main", role: "coordinator", status: "running", profileSnapshot: { name: "Coordinator" } },
    { id: "current", taskId: task.id, teamRunId: "round-old-active", sessionId: "child-current", role: "worker", status: "running", profileId: "shared", profileSnapshot: { name: "Worker" } },
    { id: "prepared", taskId: task.id, teamRunId: "round-old-active", sessionId: "child-prepared", role: "verifier", status: "prepared", profileId: "shared", profileSnapshot: { name: "Verifier" } },
    { id: "finished", taskId: task.id, teamRunId: "round-new-finished", sessionId: "child-finished", role: "worker", status: "completed", profileId: "shared", profileSnapshot: { name: "Worker" } },
    { id: "stale", taskId: task.id, teamRunId: "round-new-finished", sessionId: "child-stale", role: "worker", status: "running", profileSnapshot: { name: "Worker" } },
    { id: "other", taskId: "other-task", teamRunId: "other-round", sessionId: "child-other", role: "worker", status: "running", profileSnapshot: { name: "Worker" } },
  ],
  sessions: [
    { id: "main", taskId: task.id, kind: "coordination", title: "主对话" },
    { id: "child-current", taskId: task.id, kind: "child", title: "编写界面" },
    { id: "child-prepared", taskId: task.id, kind: "child", title: "独立验证" },
    { id: "child-finished", taskId: task.id, kind: "child", title: "旧轮成员" },
    { id: "child-stale", taskId: task.id, kind: "child", title: "旧轮状态不明" },
    { id: "child-other", taskId: "other-task", kind: "child", title: "其他任务" },
  ],
  agentAssignments: [
    { id: "assignment-current", taskId: task.id, teamRunId: "round-old-active", agentRunId: "current", assignmentKind: "member", taskPacket: { currentWorkItemId: "work-current", instruction: "完成界面" } },
    { id: "assignment-finished", taskId: task.id, teamRunId: "round-new-finished", agentRunId: "finished", assignmentKind: "member", taskPacket: { instruction: "历史工作" } },
  ],
  taskWorkItems: [{ id: "work-current", taskId: task.id, ownerAssignmentId: "assignment-current", title: "打磨任务成员概览", state: "in_progress" }],
  sessionRuns: [{ id: "session-current", taskId: task.id, agentRunId: "current", sessionId: "child-current", status: "running", startedAt: time }],
  agentReports: [{ id: "report-finished", taskId: task.id, agentRunId: "finished", reportKind: "member" }, { id: "coordinator-latest", taskId: task.id, agentRunId: "coordinator", reportKind: "coordinator" }],
  verifications: [{ id: "verification-finished", taskId: task.id, subjectAgentRunId: "finished", subjectReportId: "report-finished", verdict: "pass" }],
  coordinatorReviews: [{ id: "review-finished", taskId: task.id, verificationId: "verification-finished", outcome: "accepted" }],
  agentRequests: [],
  teamFailures: [],
};

test("team overview keeps rounds, member identities, results, and Task acceptance separate", () => {
  const result = projectTeamOverview(snapshot, task.id, Date.parse(time) + 13_000);
  assert.deepEqual(result.rounds.map(round => round.id), ["round-old-active", "round-new-finished"]);
  assert.equal(result.rounds[0].historical, false);
  assert.equal(result.rounds[1].historical, true);
  assert.equal(result.rounds[0].members.length, 2);
  assert.deepEqual(result.rounds[0].counts.map(item => [item.label, item.value]), [["运行", 1], ["待开始", 1]]);
  assert.equal(result.rounds[0].members[0].assignment, "打磨任务成员概览");
  assert.equal(result.rounds[0].members[0].duration, "最近执行 13 秒");
  assert.equal(result.rounds[1].members[0].result, "协调复核通过");
  assert.equal(result.rounds[1].members[1].status, "历史状态待核对");
  assert.equal(result.rounds[1].members[1].tone, "unknown");
  assert.equal(result.rounds[0].members.every(item => item.id !== "other"), true);
  assert.equal(result.rounds[0].coordinator?.duration, undefined);
  assert.equal(result.rounds[1].coordinator?.reportId, undefined);
});

test("member with no linked run remains accessible without inventing a Team Run", () => {
  const orphan = { ...snapshot.agentRuns[1], id: "orphan", teamRunId: undefined, sessionId: "child-current" };
  const result = projectTeamOverview({ ...snapshot, agentRuns: [...snapshot.agentRuns, orphan] }, task.id);
  assert.equal(result.ungrouped.length, 1);
  assert.equal(result.ungrouped[0].sessionId, "child-current");
  assert.equal(result.ungrouped[0].status, "历史状态待核对");
});

test("waiting and failed rounds show recorded reasons without inventing elapsed time", () => {
  const waiting = { ...snapshot.agentRuns[1], status: "waiting" };
  const source = {
    ...snapshot,
    teamRuns: [snapshot.teamRuns[0]],
    agentRuns: [snapshot.agentRuns[0], waiting],
    sessionRuns: [],
    agentRequests: [{ id: "request", taskId: task.id, teamRunId: "round-old-active", agentRunId: "current", status: "open", prompt: "需要确认是否继续" }],
    teamFailures: [{ teamRunId: "round-old-active", taskId: task.id, reason: "工作目录不可写" }],
  };
  const current = projectTeamOverview(source, task.id);
  assert.equal(current.rounds[0].members[0].waitingReason, "等待你的决定");
  const broken = { ...source, teamRuns: [{ ...source.teamRuns[0], status: "failed" }] };
  const result = projectTeamOverview(broken, task.id);
  assert.equal(result.rounds[0].historical, true);
  assert.equal(result.rounds[0].members[0].status, "历史状态待核对");
  assert.equal(result.rounds[0].members[0].duration, undefined);
  assert.equal(result.rounds[0].members[0].waitingReason, undefined);
  assert.equal(result.rounds[0].failureReason, "工作目录不可写");
});

test("a completed Agent Run awaiting rework or recheck is not counted as completed work", () => {
  const source = {
    ...snapshot,
    teamRuns: [snapshot.teamRuns[1]],
    agentRuns: [snapshot.agentRuns[0], snapshot.agentRuns[3]],
    coordinatorReviews: [{ ...snapshot.coordinatorReviews[0], outcome: "rework" }],
  };
  const rework = projectTeamOverview(source, task.id).rounds[0];
  assert.equal(rework.members[0].result, "需要返工");
  assert.equal(rework.members[0].status, "待返工");
  assert.equal(rework.members[0].tone, "rework");
  assert.deepEqual(rework.counts.map(item => [item.label, item.value]), [["待返工", 1]]);

  const recheck = projectTeamOverview({ ...source, coordinatorReviews: [{ ...source.coordinatorReviews[0], outcome: "recheck" }] }, task.id).rounds[0];
  assert.equal(recheck.members[0].status, "待复验");
  assert.deepEqual(recheck.counts.map(item => [item.label, item.value]), [["待复验", 1]]);

  const failedVerification = projectTeamOverview({ ...source, coordinatorReviews: [], verifications: [{ ...snapshot.verifications[0], verdict: "fail" }] }, task.id).rounds[0];
  assert.equal(failedVerification.members[0].status, "验收未通过");
  assert.deepEqual(failedVerification.counts.map(item => [item.label, item.value]), [["验收未通过", 1]]);

  const newerReport = projectTeamOverview({ ...source, agentReports: [...source.agentReports, { id: "report-new", taskId: task.id, agentRunId: "finished", reportKind: "member" }] }, task.id).rounds[0];
  assert.equal(newerReport.members[0].status, "执行结束");
  assert.equal(newerReport.members[0].result, "报告已保存，待独立验收");
  assert.deepEqual(newerReport.counts.map(item => [item.label, item.value]), [["执行结束", 1]]);

  const resumed = projectTeamOverview({ ...source, teamRuns: [{ ...source.teamRuns[0], status: "active" }], agentRuns: [source.agentRuns[0], { ...source.agentRuns[1], status: "running" }] }, task.id).rounds[0];
  assert.equal(resumed.members[0].status, "运行中");
  assert.deepEqual(resumed.counts.map(item => [item.label, item.value]), [["运行", 1]]);
});

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true });
for (const key of ["window", "document", "HTMLElement", "Element", "Node", "MutationObserver", "Event", "MouseEvent", "getComputedStyle"])
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = await import("react");
const { render, screen, fireEvent, cleanup } = await import("@testing-library/react");
const server = await createServer({ configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)), server: { middlewareMode: true, hmr: false }, appType: "custom" });
const { TeamOverview } = await server.ssrLoadModule("/src/components/TeamOverview.tsx");
await server.close();

test("HUD member actions open stable child session and report sources", () => {
  let openedSession, openedDetail;
  try {
    render(React.createElement(TeamOverview, { snapshot, task, onSelect: id => { openedSession = id; }, onDetail: target => { openedDetail = target; } }));
    assert.equal(screen.getAllByText("2 名成员").length, 2);
    assert.ok(screen.getByText("任务验收：尚未接受。成员结果与任务验收分别记录。"));
    fireEvent.click(screen.getByRole("button", { name: "打开 编写界面 的对话" }));
    assert.equal(openedSession, "child-current");
    const history = document.querySelector(".team-history");
    history.open = true;
    fireEvent.click(screen.getByRole("button", { name: "打开 旧轮成员 的对话" }));
    assert.equal(openedSession, "child-finished");
    fireEvent.click(screen.getByRole("button", { name: "查看报告" }));
    assert.deepEqual(openedDetail, { kind: "report", id: "report-finished" });
    fireEvent.click(screen.getByRole("button", { name: "查看验收" }));
    assert.deepEqual(openedDetail, { kind: "report", id: "verification-finished" });
  } finally { cleanup(); }
});
