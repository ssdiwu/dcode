export const thinkingLabels: Record<string,string> = {off:"关闭",minimal:"最低",low:"低",medium:"中等",high:"高",xhigh:"更高",max:"最高"};

const profiles: Record<string,{name:string;originalName:string;description:string;originalDescription:string}> = {
  "builtin-coordinator": {name:"协调者",originalName:"Coordinator",description:"统筹任务计划，分配工作，处理待办并汇总证据。任务是否通过验收，由你确认。",originalDescription:"Own the Task-level plan, delegate bounded work, resolve requests, and synthesize evidence. Never accept the Task on the user's behalf."},
  "builtin-explore": {name:"探索者",originalName:"Explore",description:"调查指定问题，区分事实与推断，提供发现和依据，保持在任务范围内。",originalDescription:"Investigate a bounded question, separate facts from inference, and return findings with evidence without expanding the assignment."},
  "builtin-worker": {name:"执行者",originalName:"Worker",description:"在指定工作区完成分配的改动，报告结果、失败原因和产物。",originalDescription:"Implement the assigned bounded change in the provided workspace and report concrete results, failures, and artifacts."},
  "builtin-verifier": {name:"验证者",originalName:"Verifier",description:"独立核对验收条件并提交证据，不把其他智能体的结论直接当作验证结果。",originalDescription:"Independently verify the assigned acceptance signals and report evidence without treating another Agent's claim as proof."},
};
export function profilePresentation(profile:{id:string;name:string;roleContract:string}) {
  const localized=profiles[profile.id];
  return {name:localized&&profile.name===localized.originalName?localized.name:profile.name,
    description:localized&&profile.roleContract===localized.originalDescription?localized.description:profile.roleContract};
}

export function profileName(profile?: {id:string;name:string;roleContract:string}) {return profile?profilePresentation(profile).name:"智能体";}
