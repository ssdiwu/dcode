import { Type } from "typebox";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

export const DCODE_AGENT_REQUEST_TOOL_NAME = "dcode_request";

export interface DCodeAgentRequestInput {
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
        const resolution = await controller.request(toolCallId, input, signal);
        return {
          content: [{
            type: "text",
            text: `Agent Request ${resolution.requestId} 已回答：${JSON.stringify(resolution.answer)}`,
          }],
          details: resolution,
        };
      },
    });
  };
}
