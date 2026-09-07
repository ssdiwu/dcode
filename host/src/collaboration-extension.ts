import { Type } from "typebox";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

export const DCODE_TEAM_TOOL_NAME = "dcode_team";
export interface TeamAction {
  action: "list" | "delegate" | "send" | "stop" | "cancel_input" | "resume_input" | "read_message";
  members?: Array<{ profileId: string; title: string; instruction: string; acceptance: string }>;
  agentRunId?: string;
  message?: string;
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
    description: "协调当前任务的成员。list 查看可用档案与已创建成员和消息摘要；read_message 按 messageId 读取完整消息，长消息用 offset/limit 分段继续；delegate 按需创建独立成员并立即返回，后台工作不占住主对话；send 给已创建成员补充要求；deliveryMode=steer 在本轮安全位置补充，否则排到后续执行；stop 停止成员。resume_input 在核对暂停原因后恢复尚未发送的消息，必须说明依据。cancel_input 仅取消已被更新要求替代或不再需要的待处理消息，必须说明依据；保留原文与取消记录。创建前说明有边界的工作与可核验的验收要求。不要创建新 Task。",
    promptSnippet: "需要持续后台工作或可独立承担的工作时，先 list 再 delegate。工作项可并行，执行与独立验收按需分工。不要等待全部成员才回复用户。",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"),Type.Literal("delegate"),Type.Literal("send"),Type.Literal("stop"),Type.Literal("cancel_input"),Type.Literal("resume_input"),Type.Literal("read_message")]),
      members: Type.Optional(Type.Array(Type.Object({
        profileId: Type.String({minLength:1,maxLength:200}), title: Type.String({minLength:1,maxLength:200}),
        instruction: Type.String({minLength:1,maxLength:20000}), acceptance: Type.String({minLength:1,maxLength:10000}),
      }),{minItems:1,maxItems:8})),
      offset:Type.Optional(Type.Integer({minimum:0,maximum:200000})),
      limit:Type.Optional(Type.Integer({minimum:1,maximum:20000})),
      messageId: Type.Optional(Type.String({minLength:1,maxLength:200})),
      reason: Type.Optional(Type.String({minLength:1,maxLength:2000})),
      agentRunId: Type.Optional(Type.String({minLength:1,maxLength:200})),
      deliveryMode:Type.Optional(Type.Literal("steer")),
      message: Type.Optional(Type.String({minLength:1,maxLength:20000})),
    }),
    async execute(callId, input) {
      const result = await handle(callId,input);
      return {content:[{type:"text",text:JSON.stringify(result)}],details:result};
    },
  });
}
