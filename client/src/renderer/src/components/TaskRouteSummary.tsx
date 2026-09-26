import type { FoundationSnapshot } from "../types";
import type { TaskRouteState } from "../../../../../host/src/task-routes.js";

const statusLabels: Record<TaskRouteState["status"], string> = {
  exploring: "正在检查路线", ready: "路线已采用，成果待验证", invalidated: "原路线已失效", stopped: "探索已停止",
};
const checkLabels = { ready: "可以实施", revise: "需要修订", reject: "发现关键缺陷", unknown: "依据不足" };

export function TaskRouteSummary({ snapshot, taskId, onMember }: {
  snapshot: FoundationSnapshot; taskId: string; onMember: (sessionId: string) => void;
}) {
  const plan = snapshot.taskPlans.find(item => item.taskId === taskId && item.state === "active");
  const route = (plan?.document as { routeExploration?: TaskRouteState } | undefined)?.routeExploration;
  if (!route) return null;
  if (route.version !== 1 || !Array.isArray(route.candidates) || !Array.isArray(route.checks) || !Array.isArray(route.history)) {
    return <p role="status">路线记录暂不可读，请保留记录并检查来源。</p>;
  }
  const current = plan?.routeContextCurrent !== false && plan?.routeInputCurrent !== false;
  const selected = current ? route.candidates.find(candidate => candidate.id === route.selectedCandidateId) : undefined;
  const paused = route.status === "invalidated" || route.status === "stopped";
  return <section className="task-route-summary" aria-label="任务路线">
    <strong>{current || paused ? statusLabels[route.status] ?? "路线状态待核对" : plan?.routeInputCurrent === false ? "有新输入，路线待核对" : "任务要求已变更，路线待复核"}</strong>
    {paused && plan?.routeInputCurrent === false && <p className="secondary">还有用户新输入待协调者核对。</p>}
    <p>{route.question}</p>
    {selected && <p>采用：{selected.title}</p>}
    <p className="secondary">{route.reason}</p>
    {selected && selected.remainingWork.length > 0 && <p>尚待完成：{selected.remainingWork.join("；")}</p>}
    <small className="secondary">探索 {route.round}/{route.budget.rounds} 轮 · 候选 {route.candidates.length}/{route.budget.candidates} · 检查 {route.checks.length}/{route.budget.checks}</small>
    <details>
      <summary>查看候选与检查依据</summary>
      {route.candidates.map(candidate => <details key={candidate.id}>
        <summary>{candidate.title} · 第 {candidate.round} 轮{current && candidate.id === route.selectedCandidateId ? " · 已采用" : ""}</summary>
        <p>{candidate.approach}</p>
        <p>依据：{candidate.basis}</p>
        <p>关键假设：{candidate.assumptions.join("；") || "未列出"}</p>
        <p>可能失败：{candidate.failureConditions.join("；")}</p>
        <p>验证动作：{candidate.probe}</p>
        <p>预计投入：{candidate.expectedCost}</p>
        <p>依赖与完成路径：{candidate.dependencies}</p>
        {candidate.derivedFrom && <p>修订自：{route.candidates.find(item => item.id === candidate.derivedFrom)?.title ?? "来源暂不可读"}</p>}
        {route.checks.filter(check => check.candidateId === candidate.id).map(check => {
          const member = snapshot.agentRuns.find(item => item.id === check.actorAgentRunId && item.taskId === taskId);
          return <div key={check.id} className="task-route-check">
            <strong>{checkLabels[check.outcome]}</strong>
            <p>{check.summary}</p>
            {check.findings.length > 0 && <ul>{check.findings.map((finding, index) => <li key={index}>{finding}</li>)}</ul>}
            {check.evidenceIds.map(id => {
              const evidence = snapshot.evidence.find(item => item.id === id && item.taskId === taskId);
              return <p className="secondary" key={id}>{evidence ? `${evidence.commandRedacted ?? "工具检查"} · ${evidence.exitKind === "ok" ? "检查成功" : "未确认成功"}` : `证据暂不可读：${id}`}</p>;
            })}
            {member && <button type="button" onClick={() => onMember(member.sessionId)}>查看检查成员的对话</button>}
          </div>;
        })}
        {!route.checks.some(check => check.candidateId === candidate.id) && <p className="secondary">尚未检查</p>}
      </details>)}
      <details><summary>查看路线变化</summary><ol>{route.history.filter(item => ["begin", "adopt", "invalidate", "reopen", "stop", "acknowledge", "extend"].includes(item.action)).map((item, index) => <li key={index}>{item.reason}{item.action === "extend" && item.budget && <small className="secondary"> · 上限调整为 {item.budget.rounds} 轮、{item.budget.candidates} 个候选、{item.budget.checks} 次检查</small>}</li>)}</ol></details>
    </details>
  </section>;
}
