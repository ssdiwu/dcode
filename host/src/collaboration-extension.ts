import { Type } from "typebox";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { RouteDispatchSchema, type RouteDispatch } from "./task-routes.js";

export const DCODE_TEAM_TOOL_NAME = "dcode_team";
export interface TeamAction {
  action: "list" | "delegate" | "continue_member" | "send" | "stop" | "cancel_input" | "resume_input" | "read_message" | "workflow_revise" | "workflow_start" | "workflow_stop" | "workflow_continue";
  workflowId?: string;
  expectedWorkflowRevision?: number;
  expectedWorkflowRunRevision?: number;
  workflowGoal?: string;
  workflowConstraints?: string[];
  workflowStages?: Array<{ id: string; title: string; completion: string; dependsOn: string[] }>;
  members?: Array<{ profileId: string; title: string; instruction: string; acceptance: string; route?: RouteDispatch; reviewWorkItemId?: string; workflowStageId?: string; workflowPurpose?: "execute" | "verify" }>;
  workflowRunId?: string;
  agentRunId?: string;
  message?: string;
  acceptance?: string;
  route?: RouteDispatch;
  deliveryMode?:"steer";
  messageId?: string;
  offset?:number;
  limit?:number;
  reason?: string;
}

/** The bound Host identity, never tool arguments, determines creation authority. */
export function createCollaborationExtension(handle: (callId: string, action: TeamAction) => Promise<unknown>): ExtensionFactory {
  return (pi) => pi.registerTool({
    name: DCODE_TEAM_TOOL_NAME,
    label: "任务协作",
    description: "协调当前任务的成员。list 查看可用档案与已创建成员和消息摘要；read_message 按 messageId 读取完整消息，长消息用 offset/limit 分段继续；delegate 按需创建独立成员并立即返回，后台工作不占住主对话；活动工作流内 delegate 必须指定 workflowRunId，并为每名成员指定明确的 workflowStageId，前置阶段通过后才能派发；send 给已创建成员补充要求；continue_member 在原工作已完成或失效且成员完全停止后，以 message、acceptance、route 为同一成员安排下一项工作，保留旧成果；先核对未处理消息，只有新安排已承接其要求时才能说明理由并取消旧排队项；deliveryMode=steer 在本轮安全位置补充，否则排到后续执行；stop 停止成员。resume_input 在核对暂停原因后恢复尚未发送的消息，必须说明依据。cancel_input 仅取消已被更新要求替代或不再需要的待处理消息，必须说明依据；保留原文与取消记录。创建前说明有边界的工作与可核验的验收要求。不要创建新 Task。",
    promptSnippet: "需要持续后台工作或可独立承担的工作时，先 list 再 delegate。用户以工作流模式提交后，先 list 找到本轮 Workflow 和版本，用 workflow_revise 定义有序阶段、完成信号与依赖，再用 workflow_start 启动；没有真实阶段不能启动。workflow_stop 仅停止后续阶段，在途成员安全收尾；workflow_continue 在核对中断结果后继续，同一 run 身份不变。活动工作流中的 delegate 必须指定 workflowRunId，每名执行成员指定 workflowStageId，独立验收成员指定同一阶段和 workflowPurpose=verify。存在任务路线时声明 route.purpose：explore/check 在当前探索中工作；execute 绑定成熟路线的 workItemId；review 绑定待验收工作项；independent 说明为何与当前路线无关。执行与验收按需分工，不等全部成员完成才回复用户。",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"),Type.Literal("delegate"),Type.Literal("continue_member"),Type.Literal("send"),Type.Literal("stop"),Type.Literal("cancel_input"),Type.Literal("resume_input"),Type.Literal("read_message"),Type.Literal("workflow_revise"),Type.Literal("workflow_start"),Type.Literal("workflow_stop"),Type.Literal("workflow_continue")]),
      workflowId: Type.Optional(Type.String({minLength:1,maxLength:200})),
      expectedWorkflowRevision: Type.Optional(Type.Integer({minimum:1})),
      expectedWorkflowRunRevision: Type.Optional(Type.Integer({minimum:1})),
      workflowGoal: Type.Optional(Type.String({minLength:1,maxLength:20000})),
      workflowConstraints: Type.Optional(Type.Array(Type.String({minLength:1,maxLength:2000}),{maxItems:32})),
      workflowStages: Type.Optional(Type.Array(Type.Object({
        id:Type.String({minLength:1,maxLength:100}),
        title:Type.String({minLength:1,maxLength:500}),
        completion:Type.String({minLength:1,maxLength:10000}),
        dependsOn:Type.Array(Type.String({minLength:1,maxLength:100}),{maxItems:24}),
      }),{minItems:1,maxItems:24})),
      members: Type.Optional(Type.Array(Type.Object({
        profileId: Type.String({minLength:1,maxLength:200}), title: Type.String({minLength:1,maxLength:200,description:"用户可见的简短成员工作名称，跟随本轮 D Code 显示与沟通语言；用户指定的名称、NDJSON 和文件名等技术标识保持原文。不要复制完整交办指令。"}),
        instruction: Type.String({minLength:1,maxLength:20000}), acceptance: Type.String({minLength:1,maxLength:10000}),
        route: Type.Optional(RouteDispatchSchema),
        reviewWorkItemId: Type.Optional(Type.String({minLength:1,maxLength:200})),
        workflowStageId: Type.Optional(Type.String({minLength:1,maxLength:100})),
        workflowPurpose: Type.Optional(Type.Union([Type.Literal("execute"), Type.Literal("verify")])),
      }),{minItems:1,maxItems:8})),
      workflowRunId: Type.Optional(Type.String({minLength:1,maxLength:200})),
      offset:Type.Optional(Type.Integer({minimum:0,maximum:200000})),
      limit:Type.Optional(Type.Integer({minimum:1,maximum:20000})),
      messageId: Type.Optional(Type.String({minLength:1,maxLength:200})),
      reason: Type.Optional(Type.String({minLength:1,maxLength:2000})),
      agentRunId: Type.Optional(Type.String({minLength:1,maxLength:200})),
      acceptance: Type.Optional(Type.String({minLength:1,maxLength:10000})),
      route: Type.Optional(RouteDispatchSchema),
      deliveryMode:Type.Optional(Type.Literal("steer")),
      message: Type.Optional(Type.String({minLength:1,maxLength:20000})),
    }),
    async execute(callId, input) {
      const result = await handle(callId,input);
      return {content:[{type:"text",text:JSON.stringify(result)}],details:result};
    },
  });
}
