import { Type } from "typebox";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { RouteOperationSchema, type RouteOperation } from "./task-routes.js";

export const DCODE_ROUTE_TOOL_NAME = "dcode_route";
export interface TaskRouteAction {
  action: "context" | "read" | "update";
  expectedPlanRevision?: number;
  operation?: RouteOperation;
  offset?: number;
  limit?: number;
}

export function createTaskRouteExtension(handle: (callId: string, action: TaskRouteAction) => Promise<unknown>): ExtensionFactory {
  return pi => pi.registerTool({
    name: DCODE_ROUTE_TOOL_NAME,
    label: "任务路线",
    description: "查看或推进本任务的有界路线探索。context 返回计划版本和候选检查摘要；read 用 offset/limit 分页核对完整原文。update 使用刚读到的 expectedPlanRevision（没有计划为 0）。只有路线存在真实分歧时由协调者 begin，可靠的小任务直接推进。propose 记录可检验候选，修订用 derivedFrom 保留反证；check 提供 dcode_facts 查询到的本人实际工具证据，independentCheck=true 时必须由不同于提出者的成员检查。ready 仅表示可继续实施。协调者 adopt 选择成熟路线，invalidate 记录失效，stop 停止，reopen 保留累计投入重新探索。预算不能重置。此工具不接受整个任务。",
    promptSnippet: "路线不确定时用 dcode_route 保存候选、针对性检查与采用依据；先 context，再按版本更新。begin 的 independentCheck 按任务约束与独立判断需要设置；小规模探索可以直接核查，不固定新增成员。直接任务无需调用或创建探索成员。",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("context"), Type.Literal("read"), Type.Literal("update")]),
      expectedPlanRevision: Type.Optional(Type.Integer({ minimum: 0 })), operation: Type.Optional(RouteOperationSchema),
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 200000 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 12000 })),
    }, { additionalProperties: false }),
    async execute(callId, input) {
      const result = await handle(callId, input);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });
}
