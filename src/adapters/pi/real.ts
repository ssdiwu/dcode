// 真实供应商后端：自定义 BaseURL/ModelID + app 自管的加密凭据。
// 最小链路 = 通用 OpenAI-compatible Chat Completions（api=openai-completions）；
// Anthropic 按 Pi 1.0.0 concrete `openai-completions-providers/anthropic-messages-provider` 已承认的接口开通（同序列 provider.auth）；
// OAuth / 联网 modelDiscovery / 其他 provider 不在本片范围。
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createModels } from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AssistantMessageEvent, StreamOptions } from "@earendil-works/pi-ai";
import type { ExecutionBackend, SessionExecutionContext } from "@/application";
import type { ModelSetupInput } from "@/contracts";
import { PiExecutionSession } from "./session";
import { ModelSetupStore, type CredentialCipher } from "./model-setup-store";
import * as openaiCompletionsApi from "@earendil-works/pi-ai/api/openai-completions";
import * as anthropicMessagesApi from "@earendil-works/pi-ai/api/anthropic-messages";

export interface RealProviderConfig {
  provider: ModelSetupInput["provider"];
  label: string;
  modelId: string;
  baseUrl: string;
}

export interface RealPiBackendOptions {
  stateDir: string;
  config: RealProviderConfig;
  cipher: CredentialCipher;
  /** 既已构造通过 commitWithCredential 提交的同一份 store：凭据读取必须走同一记录，不开独立 secrets 路径 */
  store: ModelSetupStore;
}

/**
 * 服务端 401/500 若把 key 回显到 error.message，SDK 会把它写进 AssistantMessage.errorMessage
 * → pi.assistant.model 持久化（jsonl）→ 凭据原文渗出。
 * 此处把 SDK stream/streamSimple 的出口包装为一份新的 AssistantMessageEventStream：
 * - type==='error' 事件**不整对象深扫**：只改写 AssistantMessage.errorMessage 与可能残留
 *   错误正文的 cause（如果有），其他字段（model/provider/id/usage/cost/content/tool 调用、
 *   正常 assistant 已生成文本）原样保留；
 * - 正常 text/tool/done 事件完全不动；
 * - 同步 throw 也是只清洗 Error.message，不保留含秘密的 cause/stack 链接。
 * 不重写 SDK、不改事件形状、不改变暂停/aborted 语义。
 */
function cleanErrorMessage(errorMessage: string, key: string): string {
  if (!key) return errorMessage;
  return errorMessage.split(key).join("<redacted>");
}

function sanitizeError(err: unknown, key: string): unknown {
  if (!key) return err;
  if (err instanceof Error) {
    const cleaned = new Error(cleanErrorMessage(String(err.message), key));
    cleaned.name = err.name;
    return cleaned;
  }
  return err;
}

/**
 * 清洗 error 事件中的 AssistantMessage：clone 只改写 errorMessage，其他字段（含已生成的
 * 正常 partial content/usage/model/provider 等真实归属字段）完整保留。
 * 若 error 不是 AssistantMessage 形状（同步异常的 payload），仅净化 .message 字段。
 */
function sanitizeErrorEvent(event: unknown, key: string): unknown {
  if (!key) return event;
  if (typeof event !== "object" || event === null) return event;
  const ev = event as { type?: unknown; error?: unknown };
  if (ev.type !== "error") return event;
  const err = ev.error;
  if (typeof err !== "object" || err === null) return event;
  // AssistantMessage 形状：仅改写 errorMessage，其他（model/provider/id/usage/cost/content）完整保留；
  // 保留事件外壳 type/reason 等（事件身份字段），只清洗 error payload 中的错误描述字段。
  const isAssistant = "role" in err && "content" in err && Array.isArray((err as { content?: unknown }).content);
  if (isAssistant) {
    const a = err as { errorMessage?: unknown };
    if (typeof a.errorMessage === "string") {
      return {
        ...(event as Record<string, unknown>),
        error: {
          ...(err as Record<string, unknown>),
          errorMessage: cleanErrorMessage(a.errorMessage, key),
        },
      };
    }
    return event;
  }
  // 通用错误载荷：只净化 message 字段（若是字符串），其他字段保留
  const m = (err as { message?: unknown }).message;
  if (typeof m === "string") {
    return {
      ...(event as Record<string, unknown>),
      error: {
        ...(err as Record<string, unknown>),
        message: cleanErrorMessage(m, key),
      },
    };
  }
  return event;
}

/**
 * 把一份 SDK AssistantMessageEventStream 出口转送到一份新的 AssistantMessageEventStream：
 * SDK 合同（同时有 AsyncIterator/push/end/result()）保持不变。
 * error 事件的 AssistantMessage 仅改写 errorMessage 字段；其他字段与 text/tool/done 事件原样保留。
 * result() 转交 inner.result() 的 cleaned 形态（assistant.errorMessage 已净化，body 未变）。
 */
/** 供同仓使用：导出定向清理函数（经 index.ts 公开，便于单测与包内其他模块复用） */
export function relayStreamWithSanitization(
  inner: ReturnType<typeof createAssistantMessageEventStream>,
  key: string,
): ReturnType<typeof createAssistantMessageEventStream> {
  const out = createAssistantMessageEventStream();
  void (async () => {
    let iterationFailure: unknown = null;
    try {
      for await (const event of inner) {
        if (event && typeof event === "object" && (event as AssistantMessageEvent).type === "error") {
          out.push(sanitizeErrorEvent(event, key) as AssistantMessageEvent);
        } else {
          out.push(event);
        }
      }
    } catch (err) {
      iterationFailure = sanitizeError(err, key);
    }
    try {
      // SDK 合同的 result() 代表本次 stream 的最终 AssistantMessage；inner 一定 resolve 或 reject，
      // 我们不阻塞在 iteration 之外另起等待。
      const finalMessage = await inner.result();
      // result() 中的最终 AssistantMessage 也可能带 errorMessage：按 key 清洗后推 done
      const cleanedMessage =
        finalMessage && typeof finalMessage.errorMessage === "string"
          ? { ...finalMessage, errorMessage: cleanErrorMessage(finalMessage.errorMessage, key) }
          : finalMessage;
      out.push({ type: "done", reason: cleanedMessage.stopReason === "error" ? "error" : "stop", message: cleanedMessage } as AssistantMessageEvent);
      out.end(cleanedMessage);
    } catch (err) {
      const cleaned = iterationFailure ?? sanitizeError(err, key);
      const failureMessage = cleaned instanceof Error
        ? {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: cleaned.message,
          }
        : cleaned;
      out.push({ type: "error", reason: "error", error: failureMessage } as AssistantMessageEvent);
      out.end();
    }
  })();
  return out;
}

export function createRealPiBackend(options: RealPiBackendOptions & { diagnose?: (event: string, cause: unknown) => void }): ExecutionBackend {
  const credStore = options.store.asPiCredentialStore();
  const providerId = "user-defined";
  // Chat Completion / Anthropic 静态 model 记录。provider baseUrl 取自定义 user 的 baseUrl，
  // model cost 用真实 0 拒绝计费引用（本片不接 billing）。Model<Api> 未给 thinkingLevel，到这里不支持 reasoning 开关。
  // Pi stream/streamSimple 均接受 Model<Api>——每 api 的特定泛型在 Pi models dispatch 已绑 model.api 找到 target；
  // 类型是 provider 的 generic ProviderModel<TApi> 版本 model 的省略类型声，不影响 dispatch 行为。
  const apiChoice = options.config.provider === "anthropic-messages"
    ? { stream: anthropicMessagesApi.stream, streamSimple: anthropicMessagesApi.streamSimple }
    : { stream: openaiCompletionsApi.stream, streamSimple: openaiCompletionsApi.streamSimple };
  const models = [
    {
      id: options.config.modelId,
      name: options.config.modelId,
      api: options.config.provider === "anthropic-messages" ? ("anthropic-messages" as const) : ("openai-completions" as const),
      provider: providerId,
      baseUrl: options.config.baseUrl,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
      reasoning: false,
    },
  ];
  const diagnose = options.diagnose ?? (() => undefined);

  const provider = createProvider({
    id: providerId,
    name: options.config.label,
    baseUrl: options.config.baseUrl,
    models,
    api: {
      stream: ((model: unknown, context: unknown, opts: unknown) => {
        try {
          const key = typeof (opts as StreamOptions | undefined)?.apiKey === "string" ? ((opts as StreamOptions).apiKey as string) : "";
          const inner = options.config.provider === "anthropic-messages"
            ? apiChoice.stream(model as never, context as never, opts as never)
            : apiChoice.stream(model as never, context as never, opts as never);
          return relayStreamWithSanitization(inner as ReturnType<typeof createAssistantMessageEventStream>, key);
        } catch (err) {
          const key = typeof (opts as StreamOptions | undefined)?.apiKey === "string" ? ((opts as StreamOptions).apiKey as string) : "";
          const cleaned = sanitizeError(err, key);
          diagnose("provider-stream-throw", cleaned);
          throw cleaned;
        }
      }) as never,
      streamSimple: ((model: unknown, context: unknown, opts: unknown) => {
        try {
          const key = typeof (opts as StreamOptions | undefined)?.apiKey === "string" ? ((opts as StreamOptions).apiKey as string) : "";
          const inner = options.config.provider === "anthropic-messages"
            ? apiChoice.streamSimple(model as never, context as never, opts as never)
            : apiChoice.streamSimple(model as never, context as never, opts as never);
          return relayStreamWithSanitization(inner as ReturnType<typeof createAssistantMessageEventStream>, key);
        } catch (err) {
          const key = typeof (opts as StreamOptions | undefined)?.apiKey === "string" ? ((opts as StreamOptions).apiKey as string) : "";
          const cleaned = sanitizeError(err, key);
          diagnose("provider-streamSimple-throw", cleaned);
          throw cleaned;
        }
      }) as never,
    },
    // auth.resolve 只读 app 自管的 credential；环境/文件的 ambient 不通过（authContext 也被 main 关闭）
    auth: {
      apiKey: {
        name: `${options.config.label} API key`,
        resolve: async ({ credential }) => {
          if (credential && credential.type === "api_key" && credential.key) {
            return { auth: { apiKey: credential.key } };
          }
          return undefined;
        },
        login: undefined,
      },
    },
  });
  const modelsClient = createModels({
    credentials: credStore as import("@earendil-works/pi-ai/models").CreateModelsOptions["credentials"],
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  (modelsClient as unknown as { setProvider(p: unknown): void }).setProvider(provider);

  return {
    kind: "pi",
    modelName: options.config.label,
    async open(context: SessionExecutionContext): Promise<PiExecutionSession> {
      const cwd = join(options.stateDir, "work-dir");
      await mkdir(cwd, { recursive: true, mode: 0o700 });
      const directory = join(options.stateDir, "runtime", context.target.sessionId);
      // 本片只承诺「配置 → 真实文字 HTTP 流」：不接用户工作目录，不扩工具权限
      // （registry/CodingTools 此前创建但未传给 PiExecutionSession，是无消费者装配；
      // Harness.open 在 session.ts 内会自带 registry createRegistry() 默认）。
      const session = await PiExecutionSession.open({
        target: context.target,
        directory,
        cwd,
        models: modelsClient as Parameters<typeof PiExecutionSession.open>[0]["models"],
        agent: { model: { provider: providerId, modelId: options.config.modelId } },
        env: target => new NodeExecutionEnv({ cwd: target.cwd ?? cwd }),
      });
      // 同一 conversation 的 existing root 不会被 open 再 init agent；下一个请求须用当前真实 modelId
      await session.applyModelRef({ provider: providerId, modelId: options.config.modelId });
      return session;
    },
  };
}
