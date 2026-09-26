import { Type } from "typebox";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { RouteOperationSchema, type RouteOperation } from "./task-routes.js";

export const DCODE_ROUTE_TOOL_NAME = "dcode_route";
export interface TaskRouteAction {
  action: "context" | "read" | "read_input" | "update";
  expectedPlanRevision?: number;
  operation?: RouteOperation;
  offset?: number;
  limit?: number;
  inputId?: string;
}

export function createTaskRouteExtension(handle: (callId: string, action: TaskRouteAction) => Promise<unknown>): ExtensionFactory {
  return pi => pi.registerTool({
    name: DCODE_ROUTE_TOOL_NAME,
    label: "任务路线",
    description: "查看或推进本任务的有界路线探索。context 返回计划版本、候选检查摘要及待核对用户输入；read 分页核对完整路线，read_input 按 inputId 分页读取最新用户原文。update 使用刚读到的 expectedPlanRevision（没有计划为 0）。路线存在真实分歧才 begin；propose 保存候选，修订用 derivedFrom 保留反证；check 提供本人实际工具证据，independentCheck=true 时由不同成员检查。adopt 采用成熟路线，work 建立依赖工作项；invalidate/stop 撤销相关安排，reopen 保留投入重新探索。用户有新输入时，协调者 acknowledge 并说明 impact，changed 会使路线失效，unchanged 仅核对适用性。预算用尽后，只有用户明确的新继续决定才能作为 extend 的 inputId 依据；增加绝对上限，不清空累计投入，不改变费用授权。此工具不接受整个任务。",
    promptSnippet: "路线不确定时先 context 再按版本更新。begin 的 independentCheck 按独立判断需要设置；小规模探索可以直接核查。采用后 work 建立 completion/dependsOn 工作项；dcode_team delegate 用 execute/workItemId 派发，成果验收用 review/workItemId，探索及路线检查用 explore/check，无关工作用 independent/reason。有用户新输入先 acknowledge；只有明确新继续决定才 extend。直接任务无需创建探索记录。",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("context"), Type.Literal("read"), Type.Literal("read_input"), Type.Literal("update")]),
      inputId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      expectedPlanRevision: Type.Optional(Type.Integer({ minimum: 0 })), operation: Type.Optional(RouteOperationSchema),
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 200000 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 12000 })),
    }, { additionalProperties: false }),
    async execute(callId, input) {
      const result = await handle(callId, input);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });
}
