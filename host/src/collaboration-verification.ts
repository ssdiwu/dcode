import { Type } from "typebox";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
export const DCODE_VERIFICATION_TOOL_NAME="dcode_verification";
export interface VerificationRecord {
  id:string;taskId:string;verifierAgentRunId:string;verifierSessionRunId:string;
  subjectKind?:"report"|"review_request";subjectAgentRunId?:string;subjectReportId?:string;subjectReviewId?:string;workItemId?:string;
  verdict:"pass"|"fail";evidenceIds:string[];findings:Array<{kind:"product"|"verification";description:string}>;
  summary:string;fingerprint:string;createdAt:string;
}
export interface CoordinatorReviewRecord {
  id:string;taskId:string;coordinatorAgentRunId:string;verificationId:string;
  outcome:"accepted"|"rework"|"recheck";reason:string;strategyChange?:string;acknowledgedInputId?:string;createdAt:string;
}
export interface VerificationAction {
  action:"context"|"read_report"|"read_review"|"request_recheck"|"submit"|"review";
  offset?:number;limit?:number;
  subjectReportId?:string;subjectReviewId?:string;verificationId?:string;verdict?:"pass"|"fail";
  evidenceIds?:string[];findings?:Array<{kind:"product"|"verification";description:string}>;
  summary?:string;outcome?:"accepted"|"rework"|"recheck";reason?:string;strategyChange?:string;acknowledgedInputId?:string;
}
export function createVerificationExtension(role:string,handle:(callId:string,input:VerificationAction)=>Promise<unknown>):ExtensionFactory {
  return pi=>pi.registerTool({
    name:DCODE_VERIFICATION_TOOL_NAME,label:role==="coordinator"?"复核验收":"独立验收",
    description:role==="coordinator"?"context 查看报告、固定差异审查与验收记录；review 对独立验收二次复核。返工产生新差异后用 request_recheck 和旧 subjectReviewId 固定新版并沿同一工作项复查；accepted 仅在独立验收通过后使用。若验收后有新用户输入，先判断是否影响该审查；确认不变时在 review 中给出 acknowledgedInputId 和具体理由，改变要求则重新检查。":"context 查看本任务待检查对象；read_report 读取执行报告，read_review 读取用户发起时固定的 Git 差异并留下本人检查记录；submit 指定 subjectReportId 或 subjectReviewId 其一，并附本人新检查证据。",
    parameters:Type.Object({action:Type.Union([Type.Literal("context"),Type.Literal("read_report"),Type.Literal("read_review"),Type.Literal("request_recheck"),Type.Literal("submit"),Type.Literal("review")]),
      offset:Type.Optional(Type.Integer({minimum:0,maximum:1000000})),limit:Type.Optional(Type.Integer({minimum:1,maximum:20000})),
      subjectReportId:Type.Optional(Type.String({minLength:1,maxLength:200})),subjectReviewId:Type.Optional(Type.String({minLength:1,maxLength:200})),verificationId:Type.Optional(Type.String({minLength:1,maxLength:200})),
      verdict:Type.Optional(Type.Union([Type.Literal("pass"),Type.Literal("fail")])),evidenceIds:Type.Optional(Type.Array(Type.String({minLength:1,maxLength:200}),{maxItems:64})),
      findings:Type.Optional(Type.Array(Type.Object({kind:Type.Union([Type.Literal("product"),Type.Literal("verification")]),description:Type.String({minLength:1,maxLength:4000})}),{maxItems:32})),
      summary:Type.Optional(Type.String({minLength:1,maxLength:10000})),outcome:Type.Optional(Type.Union([Type.Literal("accepted"),Type.Literal("rework"),Type.Literal("recheck")])),reason:Type.Optional(Type.String({minLength:1,maxLength:10000})),strategyChange:Type.Optional(Type.String({minLength:1,maxLength:4000})),acknowledgedInputId:Type.Optional(Type.String({minLength:1,maxLength:200})),
    }),async execute(callId,input){const result=await handle(callId,input);return {content:[{type:"text",text:JSON.stringify(result)}],details:result};},
  });
}
