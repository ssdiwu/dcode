import type {FoundationSnapshot} from './product-store.js';
/** An overview is not a second copy of the whole Task history. Stable IDs lead
 * to explicit report reads when the reviewer needs the complete source. */
export function verificationContext(snapshot:FoundationSnapshot,taskId:string){
  const latest=<T>(items:T[],key:(item:T)=>string)=>[...new Map(items.map(item=>[key(item),item])).values()];
  const members=snapshot.agentRuns.filter(item=>item.taskId===taskId);
  const reports=latest(snapshot.agentReports.filter(item=>item.taskId===taskId&&item.reportKind!=='verification'&&item.reportKind!=='coordinator'),item=>item.agentRunId);
  const verifications=latest((snapshot.verifications??[]).filter(item=>item.taskId===taskId),item=>`${item.verifierAgentRunId}:${item.subjectAgentRunId}`);
  const relevantEvidence=new Set(verifications.flatMap(item=>item.evidenceIds));
  const evidence=snapshot.evidence.filter(item=>item.taskId===taskId&&!item.commandRedacted?.startsWith('dcode_'));
  for(const member of members)for(const item of evidence.filter(item=>item.agentRunId===member.id).slice(-2))relevantEvidence.add(item.id);
  return {
    members:members.slice(-40).map(member=>({id:member.id,sessionId:member.sessionId,role:member.role,status:member.status,title:snapshot.sessions.find(session=>session.id===member.sessionId)?.title})),
    workItems:snapshot.taskWorkItems.filter(item=>item.taskId===taskId).slice(-40).map(item=>({id:item.id,title:item.title,state:item.state,ownerAssignmentId:item.ownerAssignmentId})),
    assignments:snapshot.agentAssignments.filter(item=>item.taskId===taskId).slice(-40).map(item=>({id:item.id,agentRunId:item.agentRunId,assignmentKind:item.assignmentKind})),
    reports:reports.slice(-20).map(report=>{const text=JSON.stringify(report.body);return {id:report.id,agentRunId:report.agentRunId,createdAt:report.createdAt,preview:text.slice(0,600),complete:text.length<=600};}),
    evidence:evidence.filter(item=>relevantEvidence.has(item.id)).slice(-40),
    verifications:verifications.slice(-30).map(item=>({...item,summary:item.summary.slice(0,600),findings:item.findings.map(finding=>({...finding,description:finding.description.slice(0,600)}))})),
    reviews:(snapshot.coordinatorReviews??[]).filter(item=>verifications.some(verification=>verification.id===item.verificationId)).slice(-30).map(item=>({...item,reason:item.reason.slice(0,600)})),
    artifacts:snapshot.artifacts.filter(item=>item.taskId===taskId).slice(-30).map(item=>({id:item.id,kind:item.kind,title:item.title,agentRunId:item.agentRunId,managedPath:item.managedPath,externalPath:item.externalPath,digest:item.digest})),
    totalReports:reports.length,note:'默认显示最新报告摘要和相关检查证据；用 read_report 读取完整报告，context 不重复展开全部历史和派发说明。',
  };
}
