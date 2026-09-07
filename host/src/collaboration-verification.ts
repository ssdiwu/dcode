import { Type } from "typebox";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
export const DCODE_VERIFICATION_TOOL_NAME="dcode_verification";
export interface VerificationRecord {
  id:string;taskId:string;verifierAgentRunId:string;verifierSessionRunId:string;subjectAgentRunId:string;subjectReportId:string;
  verdict:"pass"|"fail";evidenceIds:string[];findings:Array<{kind:"product"|"verification";description:string}>;
  summary:string;fingerprint:string;createdAt:string;
}
export interface CoordinatorReviewRecord {
  id:string;taskId:string;coordinatorAgentRunId:string;verificationId:string;
  outcome:"accepted"|"rework"|"recheck";reason:string;strategyChange?:string;createdAt:string;
}
export interface VerificationAction {
  action:"context"|"read_report"|"submit"|"review";
  offset?:number;limit?:number;
  subjectReportId?:string;verificationId?:string;verdict?:"pass"|"fail";
  evidenceIds?:string[];findings?:Array<{kind:"product"|"verification";description:string}>;
  summary?:string;outcome?:"accepted"|"rework"|"recheck";reason?:string;strategyChange?:string;
}
export function createVerificationExtension(role:string,handle:(callId:string,input:VerificationAction)=>Promise<unknown>):ExtensionFactory {
  return pi=>pi.registerTool({
    name:DCODE_VERIFICATION_TOOL_NAME,label:role==="coordinator"?"复核验收":"独立验收",
    description:role==="coordinator"?"context 查看最新报告摘要、验证证据和验收记录；read_report 按 subjectReportId 读取完整报告，长报告用 offset/limit 分页；review 对独立验收做二次复核。accepted 仅在已有通过的独立验收且证据充分时使用；rework 将产品问题交回执行者，recheck 将验收不足交回验收者。只影响对应工作项，不接受整个任务。":"context 查看最新报告摘要与检查证据；read_report 按 subjectReportId 读取完整报告，长报告用 offset/limit 分页；独立检查后 submit，指定报告和本人实际验证产生的证据。不能验收自己的执行报告；有产品问题标 product，缺少验收依据标 verification。",
    parameters:Type.Object({action:Type.Union([Type.Literal("context"),Type.Literal("read_report"),Type.Literal("submit"),Type.Literal("review")]),
      offset:Type.Optional(Type.Integer({minimum:0,maximum:1000000})),limit:Type.Optional(Type.Integer({minimum:1,maximum:20000})),
      subjectReportId:Type.Optional(Type.String({minLength:1,maxLength:200})),verificationId:Type.Optional(Type.String({minLength:1,maxLength:200})),
      verdict:Type.Optional(Type.Union([Type.Literal("pass"),Type.Literal("fail")])),evidenceIds:Type.Optional(Type.Array(Type.String({minLength:1,maxLength:200}),{maxItems:64})),
      findings:Type.Optional(Type.Array(Type.Object({kind:Type.Union([Type.Literal("product"),Type.Literal("verification")]),description:Type.String({minLength:1,maxLength:4000})}),{maxItems:32})),
      summary:Type.Optional(Type.String({minLength:1,maxLength:10000})),outcome:Type.Optional(Type.Union([Type.Literal("accepted"),Type.Literal("rework"),Type.Literal("recheck")])),reason:Type.Optional(Type.String({minLength:1,maxLength:10000})),strategyChange:Type.Optional(Type.String({minLength:1,maxLength:4000})),
    }),async execute(callId,input){const result=await handle(callId,input);return {content:[{type:"text",text:JSON.stringify(result)}],details:result};},
  });
}
