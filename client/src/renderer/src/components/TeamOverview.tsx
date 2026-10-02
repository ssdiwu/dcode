import { uiText } from "../../../shared/ui-language.ts";
import { useEffect, useState } from "react";
import { ArrowUpRight, ChevronRight } from "lucide-react";
import type { FoundationSnapshot, TaskRecord, TaskWorkbenchInspectorTarget } from "../types";
import { projectTeamOverview, type MemberOverview, type TeamOverviewRound } from "../workbench/team-overview";

function MemberRow({ member, duplicateTitle, onSelect, onDetail }: {
  member: MemberOverview;
  duplicateTitle?: boolean;
  onSelect: (sessionId: string) => void;
  onDetail: (target: TaskWorkbenchInspectorTarget) => void;
}) {
  return <li className="team-member" data-tone={member.tone}>
    <div className="team-member-top">
      {member.sessionId
        ? <button className="team-member-open" type="button" onClick={() => onSelect(member.sessionId!)} aria-label={uiText("打开 {0}{1} 的对话", [member.title, duplicateTitle ? uiText("，编号 {0}", [member.id.slice(-6)]) : ""])}>
          <span className="team-member-name">{member.title}</span><ArrowUpRight size={13} aria-hidden="true" />
        </button>
        : <span className="team-member-name">{member.title}</span>}
      <span className="team-member-status"><i aria-hidden="true" />{member.status}</span>
    </div>
    <div className="team-member-meta"><span>{member.role}</span>{duplicateTitle && <span>#{member.id.slice(-6)}</span>}{member.duration && <span>{member.duration}</span>}</div>
    {member.assignment && <p className="team-member-assignment" title={member.assignment}>{member.assignment}</p>}
    {member.waitingReason && <p className="team-member-waiting">{member.waitingReason}</p>}
    {member.result && <div className="team-member-result">
      <span>{member.result}</span>
      {member.reportId && <button className="text-button" type="button" onClick={() => onDetail({ kind: "report", id: member.reportId! })}>{uiText("查看报告")}</button>}
      {member.verificationId && <button className="text-button" type="button" onClick={() => onDetail({ kind: "report", id: member.verificationId! })}>{uiText("查看验收")}</button>}
    </div>}
  </li>;
}

function Round({ round, onSelect, onDetail }: {
  round: TeamOverviewRound;
  onSelect: (sessionId: string) => void;
  onDetail: (target: TaskWorkbenchInspectorTarget) => void;
}) {
  const duplicates = (title: string) => round.members.filter(member => member.title === title).length > 1;
  return <section className="team-round" aria-label={uiText("第 {0} 轮团队执行", [round.ordinal])}>
    <div className="team-round-heading"><strong>{uiText("第 ")}{round.ordinal} {uiText(" 轮")}</strong><span>{round.status}</span></div>
    <div className="team-counts" aria-label={uiText("{0} 名协作成员", [round.members.length])}>
      <span>{round.members.length} {uiText(" 名成员")}</span>
      {round.counts.map(count => <span data-tone={count.tone} key={count.tone}>{count.value} {count.label}</span>)}
    </div>
    {round.coordinator && <ul className="team-members coordinator"><MemberRow member={round.coordinator} onSelect={onSelect} onDetail={onDetail}/></ul>}
    {round.members.length ? <ul className="team-members">{round.members.map(member => <MemberRow key={member.id} member={member} duplicateTitle={duplicates(member.title)} onSelect={onSelect} onDetail={onDetail}/>)}</ul>
      : <p className="secondary team-empty">{uiText("该轮没有已创建的成员。")}</p>}
    {round.failureReason && <p className="team-round-failure">{uiText("本轮失败原因：")}{round.failureReason}</p>}
  </section>;
}

export function TeamOverview({ snapshot, task, onSelect, onDetail }: {
  snapshot: FoundationSnapshot;
  task: TaskRecord;
  onSelect: (sessionId: string) => void;
  onDetail: (target: TaskWorkbenchInspectorTarget) => void;
}) {
  const [now, setNow] = useState(Date.now());
  const { rounds, ungrouped } = projectTeamOverview(snapshot, task.id, now);
  const ticking = rounds.some(round => !round.historical && round.members.some(member => member.tone === "active" || member.tone === "waiting"));
  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ticking]);
  const [current, ...history] = rounds;
  if (!rounds.length && !ungrouped.length) return <p className="secondary">{uiText("尚未创建协作成员。协调者需要分工时，成员会显示在这里。")}</p>;
  return <div className="team-overview">
    {current && <Round round={current} onSelect={onSelect} onDetail={onDetail}/>}
    {history.length > 0 && <details className="team-history"><summary><ChevronRight size={12} aria-hidden="true" />{uiText("历史执行轮 ")}<span>{history.length}</span></summary>
      {history.map(round => <Round key={round.id} round={round} onSelect={onSelect} onDetail={onDetail}/>)}</details>}
    {ungrouped.length > 0 && <section className="team-round" aria-label={uiText("未关联执行轮的成员")}><div className="team-round-heading"><strong>{uiText("未关联执行轮")}</strong><span>{uiText("归属待核对")}</span></div><ul className="team-members">{ungrouped.map(member => <MemberRow key={member.id} member={member} onSelect={onSelect} onDetail={onDetail}/>)}</ul></section>}
    <p className="team-task-state">{uiText("任务验收：")}{task.state === "completed" ? uiText("已接受") : task.state === "rejected" ? uiText("未通过") : task.state === "archived" ? uiText("请查看归档记录") : uiText("尚未接受")}{uiText("。成员结果与任务验收分别记录。")}</p>
  </div>;
}
