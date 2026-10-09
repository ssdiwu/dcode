// 受控模型（测试专用）：本地确定性 provider，驱动真实 Pi Durable 运行。
// 安全约束（与主目录 test/runtime/fixtures.ts 同源）：永远不读凭据、不读用户模型配置、
// 不连接任何真实服务商（baseUrl 指向 invalid.invalid，streamSimple 被进程内实现替换，不发生网络请求）。
// E2E 自动应答变体：首个模型请求产出一次真实写文件的 toolCall（写入 demoDir）；
// 后续请求给出确定文本；可选门文件让后续请求保持挂起，模拟在途生成。

import { appendFile, access } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AssistantMessage, Model, ProviderStreams } from "@earendil-works/pi-ai";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

export interface ControlledModelOptions {
  /** 首个 toolCall 写文件的目标目录（独立临时目录） */
  demoDir: string;
  /** 每个模型请求追加一行（仅序号与时间，不含消息内容），供 E2E 观测调用数 */
  requestLog: string;
  /** 门文件：存在前，第 2 个及以后的请求保持挂起（模拟在途生成；关闭会中止请求） */
  answerGate: string | null;
}

export interface ControlledModels {
  models: ReturnType<typeof createModels>;
  model: Model<"openai-completions">;
  /** 已创建的请求数（含已被暂停中止的） */
  readonly requests: ReadonlyArray<{ index: number; settled: boolean }>;
}

export const controlledModelName = "Deterministic local fixture";

export function createControlledModels(options: ControlledModelOptions): ControlledModels {
  const requests: Array<{ index: number; settled: boolean }> = [];
  let created = 0;
  const model: Model<"openai-completions"> = {
    id: "fixture",
    name: controlledModelName,
    api: "openai-completions",
    provider: "dcode-test",
    baseUrl: "https://invalid.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 1024,
  };
  const message = (
    selected: { api: string; provider: string; id: string },
    content: AssistantMessage["content"],
    stopReason: AssistantMessage["stopReason"],
  ): AssistantMessage => ({
    role: "assistant",
    api: selected.api,
    provider: selected.provider,
    model: selected.id,
    content,
    stopReason,
    timestamp: Date.now(),
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  const stream: ProviderStreams["streamSimple"] = (selected, input, streamOptions = {}) => {
    const events = createAssistantMessageEventStream();
    let settled = false;
    const index = created++;
    const record = { index, settled: false };
    requests.push(record);
    const finish = (content: AssistantMessage["content"], reason: "stop" | "toolUse" = "stop") => {
      if (settled) return;
      settled = true;
      record.settled = true;
      streamOptions.signal?.removeEventListener("abort", abort);
      events.push({ type: "done", reason, message: message(selected, content, reason) });
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      record.settled = true;
      events.push({
        type: "error",
        reason: "aborted",
        error: { ...message(selected, [], "aborted"), errorMessage: "test request cancelled by Pi" },
      });
    };
    streamOptions.signal?.addEventListener("abort", abort, { once: true });
    if (streamOptions.signal?.aborted) abort();
    // 自动应答：首个请求给真实写文件 toolCall；后续请求等门文件（若启用）再给确定文本。
    void (async () => {
      try {
        // 观测写入只有一次且先落盘再应答：失败则本请求显式失败，不靠双写或吞错
        await appendFile(options.requestLog, `${JSON.stringify({ index, at: Date.now() })}\n`, "utf8");
        // 重放防护沿结构化记录判断：已有 dcode-write 的正式工具结果时不再重复发写工具
        const alreadyWrote = (input.messages ?? []).some(
          (m) => m.role === "toolResult" && m.toolName === "dcode-write",
        );
        if (index === 0 && !alreadyWrote) {
          await delay(50);
          finish(
            [
              {
                type: "toolCall",
                id: "dcode-write-1",
                name: "dcode-write",
                arguments: {
                  path: join(options.demoDir, "pi-result.txt"),
                  content: "This file was written by a real Pi tool (controlled model).",
                },
              },
            ],
            "toolUse",
          );
          return;
        }
        if (options.answerGate) {
          while (!settled) {
            try {
              await access(options.answerGate);
              break;
            } catch {
              await delay(100);
            }
          }
        } else {
          await delay(50);
        }
        finish([{ type: "text", text: "受控模型：已按确定文本回答（未连接真实服务商）。" }]);
      } catch (error) {
        if (!settled) {
          // 观测写入失败等异常必须显式失败，不吞错
          settled = true;
          record.settled = true;
          events.push({
            type: "error",
            reason: "aborted",
            error: { ...message(selected, [], "aborted"), errorMessage: `受控模型内部失败：${String(error)}` },
          });
        }
      }
    })();
    return events;
  };
  const models = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
  models.setProvider(
    createProvider({
      id: model.provider,
      models: [model],
      auth: { apiKey: { name: "test", resolve: async () => ({ auth: {}, source: "in-process test; no credential" }) } },
      api: { stream, streamSimple: stream },
    }),
  );
  return { models, model, requests };
}
