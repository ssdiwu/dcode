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
  /**
   * 第二轮工具回合（可选夹具，默认关闭）：第 1 个请求发工具调用、第 2 个请求**先挂起再**发
   * 第二个工具调用、第 3 个请求才应答。
   *
   * 它只为「运行中改选」造一个可复现窗口——单轮夹具在第 2 个请求就已应答，
   * 改选之后本轮没有下一次请求可观察，落不到 SDK 的后续请求边界上。
   */
  secondToolRound?: boolean;
}

export interface ControlledModels {
  models: ReturnType<typeof createModels>;
  model: Model<"openai-completions">;
  /** 两个受控来源：改选到另一个来源时，下一次真实请求必须真的发给它 */
  all: readonly Model<"openai-completions">[];
  /** 已创建的请求数（含已被暂停中止的） */
  readonly requests: ReadonlyArray<{ index: number; settled: boolean }>;
}

export const controlledModelName = "Deterministic local fixture";
/** 第二个受控来源的标识：与来源 A 同构但身份不同，用来源+模型标识区分。 */
export const CONTROLLED_SOURCE_A = "dcode-test";
export const CONTROLLED_SOURCE_B = "dcode-test-b";
export const CONTROLLED_MODEL_A = "fixture";
export const CONTROLLED_MODEL_B = "fixture-b";

function controlledModel(
  provider: string,
  id: string,
  name: string,
): Model<"openai-completions"> {
  return {
    id,
    name,
    api: "openai-completions",
    provider,
    baseUrl: "https://invalid.invalid",
    // 受控模型确实支持思考档位，并**逐档给出**来源侧语义：
    // 这是真实的来源资料（能力端口按它核实档位），不是为通过检查编造的档数。
    reasoning: true,
    thinkingLevelMap: {
      off: "none",
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    },
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 1024,
  };
}

export function createControlledModels(options: ControlledModelOptions): ControlledModels {
  const requests: Array<{ index: number; settled: boolean }> = [];
  let created = 0;
  const model = controlledModel(CONTROLLED_SOURCE_A, CONTROLLED_MODEL_A, controlledModelName);
  const modelB = controlledModel(CONTROLLED_SOURCE_B, CONTROLLED_MODEL_B, `${controlledModelName}（第二来源）`);
  // 序号 → 本次真实请求的思考档位（由 Pi 的 agent 循环经模型逐档映射后带进来）。
  // 助手条目按 Pi 的形状回报它与响应标识：产品侧的"实际采用"与档位由此发布，不是计划值。
  const requestThinking = new Map<number, string | undefined>();
  const message = (
    selected: { api: string; provider: string; id: string },
    content: AssistantMessage["content"],
    stopReason: AssistantMessage["stopReason"],
    requestIndex?: number,
  ): AssistantMessage => ({
    role: "assistant",
    api: selected.api,
    provider: selected.provider,
    model: selected.id,
    // 响应标识带来源：两个受控来源的响应必须可分辨，否则"实际采用"分不出是谁答的
    ...(requestIndex !== undefined ? { responseId: `resp-${selected.provider}-${requestIndex}` } : {}),
    ...(requestIndex !== undefined && requestThinking.get(requestIndex)
      ? { thinkingLevel: requestThinking.get(requestIndex) as never }
      : {}),
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
/**
 * 应答里回显**本次请求真正收到的最后一条用户正文**。
 *
 * 固定文案只能证明"有回复"，证不了"这条回复对应这一次的输入"。
 * 回显让界面上的回复与请求记录里的正文可对账：两个来源的回复各自带自己那次的正文，
 * 不会互相冒充，也没有本地推算（正文来自本次请求本身）。
 */
/** 门控等待：门文件存在前保持挂起（存在即放行；关闭会中止请求）。 */
async function holdForGate(options: ControlledModelOptions, settled: () => boolean): Promise<void> {
  if (!options.answerGate) {
    await delay(50);
    return;
  }
  while (!settled()) {
    try {
      await access(options.answerGate);
      return;
    } catch {
      await delay(100);
    }
  }
}

function echoOf(userContent: unknown): string {
  const plain = (() => {
    if (typeof userContent === "string") return userContent;
    if (!Array.isArray(userContent)) return "";
    return userContent
      .map((block) => (typeof block === "string" ? block : (block as { type?: string; text?: unknown })?.type === "text" ? String((block as { text?: unknown }).text ?? "") : ""))
      .join("");
  })();
  const trimmed = plain.trim();
  return trimmed === "" ? "" : `本次正文：${trimmed.slice(0, 120)}`;
}

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
      events.push({ type: "done", reason, message: message(selected, content, reason, index) });
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      record.settled = true;
      events.push({
        type: "error",
        reason: "aborted",
        error: { ...message(selected, [], "aborted", index), errorMessage: "test request cancelled by Pi" },
      });
    };
    streamOptions.signal?.addEventListener("abort", abort, { once: true });
    if (streamOptions.signal?.aborted) abort();
    // 自动应答：首个请求给真实写文件 toolCall；后续请求等门文件（若启用）再给确定文本。
    void (async () => {
      try {
        // 观测写入只有一次且先落盘再应答：失败则本请求显式失败，不靠双写或吞错。
        // 同时记录**本次实际收到的最后一条用户消息**：这是"引用正文真的进了模型请求"的直接证据，
        // 只记 index/at 无法证明内容参与，因此连内容一起落盘（受控装配专用，不是产品路径）。
        const lastUser = [...(input.messages ?? [])].reverse().find((m) => m.role === "user");
        const userContent = lastUser?.content ?? null;
        // 记录本次**真实解析到的**模型身份与档位：这是"请求确实发给了谁"的直接证据，
        // 不能只靠界面上的选择或配置记录来断言。
        // Pi（pi-durable/harness/generation.js:116）把本次请求的思考档位放进
        // `streamOptions.reasoning`，并且在档位为 "off" 时**不**下发该字段。
        // 这里读它才是"这次请求实际带了什么档位"的直接证据。
        const thinking = (streamOptions as { reasoning?: string; thinkingLevel?: string } | undefined)?.reasoning
          ?? (streamOptions as { thinkingLevel?: string } | undefined)?.thinkingLevel;
        requestThinking.set(index, thinking);
        // 身份与正文合并成**一行**：一次请求一条记录，避免读日志方按行取时拿到缺正文的半条。
        await appendFile(
          options.requestLog,
          `${JSON.stringify({
            index,
            at: Date.now(),
            provider: selected.provider,
            modelId: selected.id,
            ...(thinking ? { thinkingLevel: thinking } : {}),
            api: selected.api,
            userContent,
          })}\n`,
          "utf8",
        );
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
        if (options.secondToolRound && index === 1) {
          // 挂起后才发第二个工具调用：运行中改选发生在这个窗口里，
          // 随后的那次真实请求才可能用到新来源（夹具专用，默认关闭）。
          await holdForGate(options, () => settled);
          finish(
            [
              {
                type: "toolCall",
                id: "dcode-write-2",
                name: "dcode-write",
                arguments: {
                  path: join(options.demoDir, "pi-result-2.txt"),
                  content: "Second tool round (controlled model).",
                },
              },
            ],
            "toolUse",
          );
          return;
        }
        if (options.answerGate) {
          await holdForGate(options, () => settled);
        } else {
          await delay(50);
        }
        finish([{ type: "text", text: `受控模型：已按确定文本回答（未连接真实服务商）。${echoOf(userContent)}` }]);
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
  // 两个来源共用同一套受控实现（都不连真实服务商），但身份不同：
  // 改选到 B 之后，下一次真实请求必须由 provider=B 应答并在条目上如实记为 B。
  for (const one of [model, modelB]) {
    models.setProvider(
      createProvider({
        id: one.provider,
        models: [one],
        auth: { apiKey: { name: "test", resolve: async () => ({ auth: {}, source: "in-process test; no credential" }) } },
        api: { stream, streamSimple: stream },
      }),
    );
  }
  return { models, model, all: [model, modelB], requests };
}
