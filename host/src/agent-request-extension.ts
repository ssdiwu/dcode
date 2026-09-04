import { Type } from "typebox";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

export const DCODE_AGENT_REQUEST_TOOL_NAME = "dcode_request";
export const DCODE_TASK_ACCEPTANCE_TOOL_NAME = "dcode_request_task_acceptance";

export type DCodeAgentRequestKind = "choice" | "task_acceptance";

export interface DCodeAgentRequestInput {
  kind: DCodeAgentRequestKind;
  prompt: string;
  options: Array<{
    id: string;
    label: string;
    description?: string;
    recommended?: boolean;
  }>;
}

export interface DCodeAgentRequestResolution {
  requestId: string;
  answer: unknown;
}

export class DCodeAgentRequestController {
  private handler?: (
    toolCallId: string,
    input: DCodeAgentRequestInput,
    signal?: AbortSignal,
  ) => Promise<DCodeAgentRequestResolution>;

  bind(handler: (
    toolCallId: string,
    input: DCodeAgentRequestInput,
    signal?: AbortSignal,
  ) => Promise<DCodeAgentRequestResolution>): void {
    this.handler = handler;
  }

  async request(
    toolCallId: string,
    input: DCodeAgentRequestInput,
    signal?: AbortSignal,
  ): Promise<DCodeAgentRequestResolution> {
    if (!this.handler) throw new Error("D Code Agent Request controller is not bound");
    return await this.handler(toolCallId, input, signal);
  }

  dispose(): void {
    this.handler = undefined;
  }
}

export function createDCodeAgentRequestExtension(
  controller: DCodeAgentRequestController,
  options: { allowTaskAcceptance?: boolean } = {},
): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: DCODE_AGENT_REQUEST_TOOL_NAME,
      label: "请求输入",
      description:
        "当完成当前 Task 必须由用户或 Coordinator 作出澄清/决定时，创建一个耐久 Agent Request 并等待指定回答。不要用它汇报进度，也不要询问能从当前上下文或工具查到的事实。",
      promptSnippet:
        "dcode_request: 仅在缺少用户或 Coordinator 决定会阻塞 Task 时创建耐久请求；调用会等待回答。",
      parameters: Type.Object({
        prompt: Type.String({ minLength: 1, maxLength: 20_000 }),
        options: Type.Array(Type.Object({
          id: Type.String({ minLength: 1, maxLength: 100 }),
          label: Type.String({ minLength: 1, maxLength: 500 }),
          description: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
          recommended: Type.Optional(Type.Boolean()),
        }), { minItems: 2, maxItems: 5 }),
      }),
      async execute(toolCallId, input, signal) {
        const resolution = await controller.request(toolCallId, { kind: "choice", ...input }, signal);
        return {
          content: [{
            type: "text",
            text: `Agent Request ${resolution.requestId} 已回答：${JSON.stringify(resolution.answer)}`,
          }],
          details: resolution,
        };
      },
    });
    if (!options.allowTaskAcceptance) return;
    pi.registerTool({
      name: DCODE_TASK_ACCEPTANCE_TOOL_NAME,
      label: "请求任务验收",
      description:
        "仅协调者可在已完成当前 Task 的工作后请求用户验收。调用会创建一个耐久验收请求并等待用户处理：空反馈表示接受；有反馈表示继续返工。不要把普通澄清或成员问题放在这里。",
      promptSnippet:
        "dcode_request_task_acceptance: 仅协调者在准备交付当前 Task 时调用；调用会等待用户接受或提交可回查反馈。",
      parameters: Type.Object({
        prompt: Type.String({ minLength: 1, maxLength: 20_000 }),
      }),
      async execute(toolCallId, input, signal) {
        const resolution = await controller.request(toolCallId, {
          kind: "task_acceptance",
          prompt: input.prompt,
          options: [],
        }, signal);
        return {
          content: [{
            type: "text",
            text: `任务验收请求 ${resolution.requestId} 已处理：${JSON.stringify(resolution.answer)}`,
          }],
          details: resolution,
        };
      },
    });
  };
}
