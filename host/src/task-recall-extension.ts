import { Type } from "typebox";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

export const DCODE_RECALL_TOOL_NAME = "dcode_recall";
export type TaskRecallAction =
  | { action: "search"; query: string; limit?: number; source?: "all" | "task" | "facts" | "project" | "inspiration"; taskOffset?: number; factOffset?: number; projectOffset?: number; projectPath?: string }
  | { action: "read"; candidateId: string };

export function createTaskRecallExtension(handle: (callId: string, action: TaskRecallAction) => Promise<unknown>): ExtensionFactory {
  return pi => pi.registerTool({
    name: DCODE_RECALL_TOOL_NAME,
    label: "任务来源召回",
    description: "按当前问题查找本 Task 历史、所属 Project 的安全文件和全局灵感。search 只给有界候选身份；read 再读取原文并保存实际使用的来源版本。候选不会自动进入任务上下文或运行回执。",
    promptSnippet: "需要回忆时先 search，再 read 真正需要的候选。search 返回 coverage；若 searchIncomplete=true，应按 source=task/facts/project/inspiration 和可用的 nextOffset 继续查。Project 目录列表若 listingTruncated=true，offset 不能到达未列出的条目；已有具体子目录线索时用 projectPath 缩小范围，否则如实说明未覆盖。零候选不等于全库无材料。只引用 read 返回的 dcode-source 链接；未读候选不能当依据。旧文件或灵感版本不可恢复时说明缺失，不拿当前正文替代。",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("search"), Type.Literal("read")]),
      query: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      source: Type.Optional(Type.Union([Type.Literal("all"),Type.Literal("task"),Type.Literal("facts"),Type.Literal("project"),Type.Literal("inspiration")])),
      taskOffset: Type.Optional(Type.Integer({minimum:0,maximum:100000})),
      factOffset: Type.Optional(Type.Integer({minimum:0,maximum:100000})),
      projectOffset: Type.Optional(Type.Integer({minimum:0,maximum:100000})),
      projectPath: Type.Optional(Type.String({minLength:1,maxLength:4096})),
      candidateId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })),
    }, { additionalProperties: false }),
    async execute(callId, input) {
      const result = await handle(callId, input as TaskRecallAction);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });
}
