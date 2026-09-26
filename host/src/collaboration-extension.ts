import { Type } from "typebox";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { RouteDispatchSchema, type RouteDispatch } from "./task-routes.js";

export const DCODE_TEAM_TOOL_NAME = "dcode_team";
export interface TeamAction {
  action: "list" | "delegate" | "continue_member" | "send" | "stop" | "cancel_input" | "resume_input" | "read_message";
  members?: Array<{ profileId: string; title: string; instruction: string; acceptance: string; route?: RouteDispatch }>;
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
    description: "协调当前任务的成员。list 查看可用档案与已创建成员和消息摘要；read_message 按 messageId 读取完整消息，长消息用 offset/limit 分段继续；delegate 按需创建独立成员并立即返回，后台工作不占住主对话；send 给已创建成员补充要求；continue_member 在原工作已完成或失效且成员完全停止后，以 message、acceptance、route 为同一成员安排下一项工作，保留旧成果；先核对未处理消息，只有新安排已承接其要求时才能说明理由并取消旧排队项；deliveryMode=steer 在本轮安全位置补充，否则排到后续执行；stop 停止成员。resume_input 在核对暂停原因后恢复尚未发送的消息，必须说明依据。cancel_input 仅取消已被更新要求替代或不再需要的待处理消息，必须说明依据；保留原文与取消记录。创建前说明有边界的工作与可核验的验收要求。不要创建新 Task。",
    promptSnippet: "需要持续后台工作或可独立承担的工作时，先 list 再 delegate。存在任务路线时声明 route.purpose：explore/check 在当前探索中工作；execute 绑定成熟路线的 workItemId，前置工作完成后派发；review 绑定待验收工作项并安排验收成员；independent 说明为何与当前路线无关。执行与验收按需分工，不等全部成员完成才回复用户。",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"),Type.Literal("delegate"),Type.Literal("continue_member"),Type.Literal("send"),Type.Literal("stop"),Type.Literal("cancel_input"),Type.Literal("resume_input"),Type.Literal("read_message")]),
      members: Type.Optional(Type.Array(Type.Object({
        profileId: Type.String({minLength:1,maxLength:200}), title: Type.String({minLength:1,maxLength:200}),
        instruction: Type.String({minLength:1,maxLength:20000}), acceptance: Type.String({minLength:1,maxLength:10000}),
        route: Type.Optional(RouteDispatchSchema),
      }),{minItems:1,maxItems:8})),
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
