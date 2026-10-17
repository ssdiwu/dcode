// 真实供应商后端：自定义（BaseURL/ModelID + app 自管加密凭据）与预设供应商（Pi builtin 身份 + 目录模型）双路径。
// 自定义沿用 OpenAI-compatible / Anthropic 静态登记；预设沿 builtin provider 的正式协议分发与 auth，
// 模型对象按目录（builtin + 已生效 remote 合并）精确查取，绝不替新 id 瞎猜 api/endpoint。
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createRegistry } from "@earendil-works/pi-durable";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createProvider } from "@earendil-works/pi-ai/models";
import { physicalRequestBudget } from './request-budget';
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { AssistantMessageEvent, StreamOptions } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { QuotaObservation } from "./quota-port";
import { credentialAccountKey } from "./quota-port";
import type { ExecutionBackend, SessionExecutionContext, SdkRequestAdmission, SdkRequestAdmissionGate, SdkRequestTarget } from "@/application";
import type { ModelSetupInput } from "@/contracts";
import { PiExecutionSession } from "./session";
import { ModelSetupStore, type CredentialCipher } from "./model-setup-store";
import type { ProviderDirectoryStore } from "./provider-directory-store";
import type { RegisteredPresetProvider } from "./preset-providers";
import { registerPresetProviders } from "./preset-providers";
import { createCodingTools } from "./coding-tools";
import { CodingExtensions } from "./coding-extensions";
import { CodingProviderHeaders } from './coding-provider-headers';
import { CodingResourcesUnavailable, loadCodingResources } from "./coding-resources";
import type { CodingPromptTemplate } from "./coding-resources";
import { expandCodingPrompt } from "./prompt-templates";
import * as openaiCompletionsApi from "@earendil-works/pi-ai/api/openai-completions";
import * as anthropicMessagesApi from "@earendil-works/pi-ai/api/anthropic-messages";

/** 只为新运行选择目录；已有运行由正式绑定保留原 cwd，查询不创建目录。 */
// 模板缓存只属本实例的执行准备；已有输入按正式回执查回，不以新模板重写历史。
function codingPreparation(coding: ReturnType<typeof createCodingTools> | null, agentDir: string, enabled: () => boolean, registry: ReturnType<typeof createRegistry>, models: ModelRuntime, sessionId: string, providerHeaders: CodingProviderHeaders) {
  let prompts: CodingPromptTemplate[] = [];
  let session: PiExecutionSession | undefined;
  const extensions = coding ? new CodingExtensions(coding.tools ?? [], agentDir, enabled, models, sessionId, providerHeaders) : null;
  extensions?.useRegistry(registry);
  return {
    models: extensions?.guardModels(models) ?? models,
    prepareExecution: coding ? async (cwd: string, sessionStartReason: 'startup' | 'resume' | 'reload') => {
      // 扩展开启时由同一次 Loader 独占目录，基础扫描只保项目指令，不能绕过筛选或重复技能。
      const useExtensions = enabled();
      const resources = await loadCodingResources(cwd, agentDir, { instructionsOnly: useExtensions });
      const prepared = await extensions!.prepare(cwd, useExtensions, sessionStartReason);
      const packageResources = extensions!.packageResources;
      prompts = [...resources.prompts, ...packageResources.prompts.filter(prompt => !resources.prompts.some(previous => previous.name === prompt.name))];
      return { instructions: [resources.instructions, packageResources.instructions].filter(Boolean).join('\n\n'),
        extensions: { add: [coding, ...('add' in prepared ? prepared.add ?? [] : [])], ...('remove' in prepared ? { remove: prepared.remove } : {}) },
        tools: prepared.tools };
    } : undefined,
    attachExecution: extensions ? extensions.attach.bind(extensions) : undefined,
    beginCloseExecutionResources: extensions ? (reason: 'resume' | 'quit') => extensions.beginClose(reason) : undefined,
    reconcileExecutionSpend: extensions ? extensions.reconcileModelSpend.bind(extensions) : undefined,
    needsInputPreparation: enabled,
    prepareInput: coding && extensions ? (input: import("./input-preparation").InputPreparation, api: import("@earendil-works/pi-durable").ToolExecutionApi, ctx: import("@earendil-works/chord").Context) => extensions.prepareInput(input, api, ctx, text => expandCodingPrompt(text, prompts)) : undefined,
    transformInput: coding ? (text: string) => expandCodingPrompt(text, prompts) : undefined,
    bindSession(value: PiExecutionSession) {
      session = value;
      extensions?.setUserMessageSubmitter(async (content, inputOptions, actionId, ctx, admission) => {
        if (ctx.abortSignal?.aborted || !admission.isCurrent() || !session) throw new CodingResourcesUnavailable();
        const receipt = await session.submitExtensionMessage(content, inputOptions, actionId, ctx, admission);
        if (receipt.status !== 'accepted') throw new CodingResourcesUnavailable();
      });
    },
  };
}


async function initialWorkingDirectory(context: SessionExecutionContext, stateDir: string): Promise<string> {
  if (context.workFolder) {
    const folder = context.workFolder;
    return resolve(folder === '~' ? homedir() : folder.startsWith('~/') ? join(homedir(), folder.slice(2)) : folder);
  }
  const cwd = join(stateDir, 'work-dir');
  if (context.initialize !== false) await mkdir(cwd, { recursive: true, mode: 0o700 });
  return cwd;
}

export interface RealProviderConfig {
  provider: ModelSetupInput["provider"];
  label: string;
  modelId: string;
  baseUrl: string;
}

/** 额度观察回调：由装配注入（读取服务商真实响应头）。缺席 = 不观察，如实按"尚未读到"。 */
export type QuotaObservationSink = (observation: QuotaObservation) => void;

export interface RealPiBackendOptions {
  stateDir: string;
  config: RealProviderConfig;
  cipher: CredentialCipher;
  /** 既已构造通过提交写盘的同一份 store：凭据读取必须走同一记录，不开独立 secrets 路径 */
  store: ModelSetupStore;
  /** 预设路径的凭据 store（与 directory 同一份物理文件）；提供时凭据读取走 providerId 精确隔离 */
  credentialSource?: { asPiCredentialStore(): ReturnType<ProviderDirectoryStore["asPiCredentialStore"]> };
  /** 额度观察回调（读取服务商真实响应头）；缺席 = 本实例不观察额度 */
  observeQuota?: QuotaObservationSink;
  /**
   * 其余**已配置**来源（当前选中的是自定义接入时同样要登记）：
   * 会话改选到它们时执行端必须能解析身份，否则只在这一条路上失效。
   */
  additionalSources?: readonly ConfiguredSourceModels[];
  /** 每次 SDK 请求前的完整准入门（应用层提供）；缺席 = 该实例不做请求前准入 */
  admitRequest?: SdkRequestAdmissionGate;
  diagnose?: (event: string, cause: unknown) => void;
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
/**
 * 组装一次额度观察（不含任何本地估算）：来源与模型取自 Pi 自己的 model 对象。
 *
 * 账户身份用**本次请求真正用的凭据**加本次请求的端点算指纹（`opts.apiKey`／`model.baseUrl`），
 * 不是"某个来源的某份配置"：换了 key 或换到另一个区域，旧响应头就不再代表当前账户。
 * 没有凭据（如未解析出 key 的请求）时如实留空——此时按来源+模型共享一份，不编造身份。
 */
export function recordQuotaObservation(
  model: { provider?: string; id?: string; baseUrl?: string },
  response: { status: number; headers: Record<string, string> },
  secret: string | undefined,
): QuotaObservation {
  return {
    sourceId: model.provider ?? "",
    modelId: model.id ?? "",
    receivedAt: Date.now(),
    headers: response.headers ?? {},
    status: response.status,
    accountKey: secret === undefined || secret === "" ? undefined : credentialAccountKey(secret, model.baseUrl ?? ""),
  };
}

/**
 * 把 Pi 的 `StreamOptions.onResponse` 接上额度观察。
 *
 * 这是**服务商自己在每次真实调用后回报的权威额度**（响应头）：不额外发请求、
 * 不需要新的凭据范围、不是本地估算。调用方原有的 onResponse 仍照常执行（观察不取代它）。
 */
function withQuotaObservation(
  opts: unknown,
  observe: ((observation: QuotaObservation) => void) | undefined,
  diagnose: (event: string, cause: unknown) => void,
): unknown {
  if (!observe) return opts;
  const original = (opts as { onResponse?: StreamOptions["onResponse"] } | undefined)?.onResponse;
  const secret = typeof (opts as StreamOptions | undefined)?.apiKey === "string" ? (opts as StreamOptions).apiKey : undefined;
  return {
    ...(opts as Record<string, unknown> | undefined),
    onResponse: (response: { status: number; headers: Record<string, string> }, model: { provider?: string; id?: string; baseUrl?: string }) => {
      try {
        observe(recordQuotaObservation(model, response, secret));
      } catch (err) {
        // 观察失败不得牵连真实请求：额度读不到就说读不到，不能把这次调用带崩。
        diagnose("quota-observation-failed", err);
      }
      return original?.(response as never, model as never);
    },
  };
}

export function relayStreamWithSanitization(
  inner: ReturnType<typeof createAssistantMessageEventStream>,
  key: string,
): ReturnType<typeof createAssistantMessageEventStream> {
  const out = createAssistantMessageEventStream();
  relayInto(out, inner, key);
  return out;
}

/** 把 inner 的事件转发到 out 并收束（含错误净化与最终消息）。抽出来供准入包装复用。 */
function relayInto(
  out: ReturnType<typeof createAssistantMessageEventStream>,
  inner: ReturnType<typeof createAssistantMessageEventStream>,
  key: string,
): void {
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
}

/**
 * **每次 SDK 请求前**消费应用层的完整准入裁定。
 *
 * `start()` 是真正发起这一次模型请求的动作——它只在准��放行后才被调用。
 * 不放行时本轮以明确的错误收束：**已输出保持**（前面的事件都在 out 里），
 * 不重投输入、不重复工具、不另发探测。
 *
 * 流是同步返回的，准入是异步的，因此这里先返回一条 out 流，准入成立后再接上 inner。
 */
/**
 * 本后端**已登记**的来源与其模型对象（按来源 id 分组）。
 *
 * 准入裁定要落到实际请求上，就必须能把「裁定给的那个身份」换成真正的模型对象；
 * 换不到就不能发——否则就是核准 B、发出 A。
 */
type RegisteredModels = Map<string, readonly Model<Api>[]>;

function resolveRegisteredModel(registered: RegisteredModels, target: { sourceId: string; modelId: string }): Model<Api> | null {
  return registered.get(target.sourceId)?.find((m) => m.id === target.modelId) ?? null;
}

/** 每条真实端口自己的 SDK 客户端：换来源仍走该客户端的正式协议与认证解析。 */
type SessionModelsClient = ModelRuntime;

async function ownedModels(credentials: import('@earendil-works/pi-ai').CredentialStore): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  // 无 await 间隙地替换全部内建认证；未配置来源不暴露可执行模型或环境凭据。
  for (const preset of registerPresetProviders()) runtime.registerNativeProvider({ ...preset.provider, getModels: () => [], getAllModels: () => [] });
  return runtime;
}

type ProviderStreamOptions = {
  observeQuota?: QuotaObservationSink;
  diagnose?: (event: string, cause: unknown) => void;
  admitRequest?: SdkRequestAdmissionGate;
  sessionRef: { current: string };
  registered: RegisteredModels;
  modelsClient: SessionModelsClient;
};

// 未装配准入门时仍使用 SDK 原参数；已裁定时模型和逐档参数一起消费，null 与缺席分开。
type AdmittedSdkRequest = { sessionId: string; sourceId: string; modelId: string } & Partial<Pick<SdkRequestTarget, "thinkingLevel">>;

export function withRequestAdmission(
  start: (chosen: AdmittedSdkRequest) => ReturnType<typeof createAssistantMessageEventStream>,
  request: { sessionId: string; sourceId: string; modelId: string; requires?: readonly import('@/contracts').WorkCapability[] },
  key: string,
  options: {
    admitRequest?: SdkRequestAdmissionGate;
    diagnose?: (event: string, cause: unknown) => void;
    /** 按裁定身份取出**该来源那个模型对象**；取不到就如实不放行，不退回原来准备的那个 */
    resolveModel?: (target: SdkRequestTarget) => unknown;
  },
): ReturnType<typeof createAssistantMessageEventStream> {
  const diagnose = options.diagnose ?? (() => undefined);
  const gate = options.admitRequest;
  if (!gate) return relayStreamWithSanitization(start(request), key);
  const out = createAssistantMessageEventStream();
  void (async () => {
    let verdict: SdkRequestAdmission;
    try {
      verdict = await gate(request);
    } catch (err) {
      // 准入门自身抛错是缺陷，不是放行理由：如实诊断并按不放行处理，保留工作。
      diagnose("sdk-request-admission-failed", err);
      out.push(deniedEvent(request, "准入判定未能完成"));
      out.end();
      return;
    }
    if (!verdict.ok) {
      out.push(deniedEvent(request, verdict.reason ?? "当前条件不成立"));
      out.end();
      return;
    }
    // 裁定可能改用另一个模型：**把裁定身份落实到这一次实际请求**。
    // 拿不到那个模型对象时如实不放行——发出去的是 A 而裁定的是 B，比不发更坏。
    let chosen: AdmittedSdkRequest = request;
    if (verdict.target && (verdict.target.sourceId !== request.sourceId || verdict.target.modelId !== request.modelId)) {
      const resolved = options.resolveModel?.(verdict.target) ?? null;
      if (resolved === null || resolved === undefined) {
        diagnose("sdk-request-target-unresolved", new Error(`unresolved-target:${verdict.target.sourceId}/${verdict.target.modelId}`));
        out.push(deniedEvent(request, `裁定改用 ${verdict.target.sourceId}/${verdict.target.modelId}，但执行端解析不到该身份`));
        out.end();
        return;
      }
      void resolved;
    }
    if (verdict.target) chosen = { sessionId: request.sessionId, ...verdict.target };
    let inner: ReturnType<typeof createAssistantMessageEventStream>;
    try {
      inner = start(chosen);
    } catch (err) {
      const cleaned = sanitizeError(err, key);
      diagnose("sdk-request-start-throw", cleaned);
      out.push({ type: "error", reason: "error", error: { role: "assistant", content: [], stopReason: "error", errorMessage: cleaned instanceof Error ? cleaned.message : String(cleaned) } } as unknown as AssistantMessageEvent);
      out.end();
      return;
    }
    relayInto(out, inner, key);
  })();
  return out;
}

/** 本次请求的身份：会话要等到真正打开端口才知道，provider 先装配好，这里读可变引用。 */
function admissionRequestOf(sessionId: string, model: unknown, payload: unknown): { sessionId: string; sourceId: string; modelId: string; requires?: readonly import('@/contracts').WorkCapability[] } {
  const m = (model ?? {}) as { provider?: unknown; id?: unknown };
  return {
    sessionId,
    sourceId: typeof m.provider === "string" ? m.provider : "",
    modelId: typeof m.id === "string" ? m.id : "",
    ...((payload as { messages?: { content?: unknown }[] } | null)?.messages?.some(message => Array.isArray(message.content) && message.content.some((block: { type?: string }) => block.type === 'image')) ? { requires: ['image-input' as const] } : {}),
  };
}

function streamKeyOf(opts: unknown): string {
  return typeof (opts as StreamOptions | undefined)?.apiKey === "string" ? ((opts as StreamOptions).apiKey as string) : "";
}

/** 不放行时给这一轮一个可辨的收束原因；不掺入任何服务端正文或凭据。 */
function deniedEvent(request: { sourceId: string; modelId: string }, reason: string): AssistantMessageEvent {
  return {
    type: "error",
    reason: "error",
    error: {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: `本次请求未发出：${reason}`,
      // 准入拒绝在协议启动之前发生；计划身份不能被投影成一次真实物理请求。
      api: "pi-virtual",
      provider: "dcode-routing",
      model: "unissued",
      // 未发出也须满足完整SDK Usage合同；漏totalTokens会让原工具累计产生NaN，而非真实费用。
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      timestamp: Date.now(),
    },
  } as unknown as AssistantMessageEvent;
}

/** 自定义接入在 Pi 侧的 provider 标识；与目录记录、凭据存储同源。 */
export const CUSTOM_PROVIDER_ID = "user-defined";

export function createRealPiBackend(options: RealPiBackendOptions & { diagnose?: (event: string, cause: unknown) => void }): ExecutionBackend {
  const credStore = options.credentialSource ? options.credentialSource.asPiCredentialStore() : options.store.asPiCredentialStore();
  const providerId = CUSTOM_PROVIDER_ID;
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
  const registered: RegisteredModels = new Map();
  registered.set(providerId, models as unknown as readonly Model<Api>[]);
  // 已配置来源列表随刷新更新：每条会话的客户端在 open 时现造，只读装配那一刻的列表，
  // 刷新之后新开的会话就拿不到新来源/新模型（身份解析不到，请求发不出去）。
  let additionalSources = options.additionalSources;

  /**
   * 按**本条会话**造一份 provider 与模型客户端。
   *
   * 会话身份不再挂在共享可变引用上：先打开 S1、再打开 S2 时，S1 的后续请求
   * 会以 S2 的身份去核准入（消费另一会话的选择、暂停、能力要求与认证限制）。
   * 身份必须随端口一起被创建出来，不是被后来者改写。
   */
  const buildForSession = async (sessionId: string) => {
  const sessionRef = { current: sessionId };
  const client = await ownedModels(credStore as import('@earendil-works/pi-ai').CredentialStore);
  const streamOptions = { ...options, sessionRef, registered, modelsClient: client };
  const provider = createProvider({
    id: providerId,
    name: options.config.label,
    baseUrl: options.config.baseUrl,
    models,
    api: {
      stream: wrapStreamMethod("stream", apiChoice, streamOptions) as never,
      streamSimple: wrapStreamMethod("streamSimple", apiChoice, streamOptions) as never,
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
  // 当前选中的是自定义接入时，其它已配置来源也登记到同一条会话客户端。
  client.registerNativeProvider(provider);
  // 走的是和 preset 装配同一个登记循环，不另造一套。
  registerAdditionalSources(client, additionalSources, providerId, { ...options, sessionRef, registered, currentProvider: provider });
  return { client, provider, providerHeaders: new CodingProviderHeaders(client, [...registered.keys()]) };
  };

  /** 已打开端口的模型客户端：认证提交后要把新增来源同步进去。 */
  // 显式记录「哪个客户端属于哪条会话」：类型强转**不会**生成运行时字段，
  // 之前把 client 直接当带 sessionId 的对象压进来，refresh 时读到的 sessionId 是 undefined。
  const openedClients: { client: SessionModelsClient; sessionId: string; provider: unknown; providerHeaders: CodingProviderHeaders }[] = [];

  return {
    kind: "pi",
    /**
     * 按**当次**配置重新登记已配置来源：认证提交之后，已打开的 modelsClient 也要同步。
     * 只通知目录而不动实际客户端，新增来源仍然解析不到身份——动态元数据查询不等于客户端同步。
     */
    async refreshAdditionalSources(sources: readonly ConfiguredSourceModels[] | undefined): Promise<void> {
      additionalSources = sources;
      const failures: unknown[] = [];
      // 来源已正式刷新；某会话声明与新base不兼容时保留其失效，不能截断其余活客户端的同步。
      for (const opened of openedClients) {
        try {
          const replaced = registerAdditionalSources(opened.client, sources, providerId, { ...options, sessionRef: { current: opened.sessionId }, registered, currentProvider: opened.provider });
          opened.providerHeaders.refresh(replaced);
        } catch (error) { failures.push(error); }
      }
      if (failures.length) throw failures[0];
    },
    modelName: options.config.label,
    async open(context: SessionExecutionContext): Promise<PiExecutionSession> {
      const cwd = await initialWorkingDirectory(context, options.stateDir);
      const directory = join(options.stateDir, "runtime", context.target.sessionId);
      // 每条会话自带一份模型客户端：准入身份随端口创建，不会被后打开的会话改写
      const built = await buildForSession(context.target.sessionId);
      const modelsClient = built.client;
      const coding = context.projectAccess === 'task-owner' ? createCodingTools(join(options.stateDir, 'coding-resources')) : null;
      const registry = createRegistry(); if (coding) registry.install(coding);
      openedClients.push({
        client: modelsClient,
        sessionId: context.target.sessionId,
        provider: built.provider,
        providerHeaders: built.providerHeaders,
      });
      const preparation = codingPreparation(coding, join(options.stateDir, 'coding-resources'), () => context.projectExtensionsEnabled?.() === true, registry, modelsClient, context.target.sessionId, built.providerHeaders);
      const { bindSession, ...sessionPreparation } = preparation;
      const session = await PiExecutionSession.open({
        target: context.target,
        directory,
        cwd,
        initialize: context.initialize,
        reuseStoredCwd: true,
        registry,
        ...sessionPreparation,
        settings: { retry: { maxRetries: 0 }, toolExecution: 'sequential' },
        agent: {
          extensions: [],
          model: { provider: context.model?.sourceId ?? providerId, modelId: context.model?.modelId ?? options.config.modelId },
          ...(context.model ? { thinkingLevel: (context.model.thinkingLevel ?? undefined) as never } : {}),
        },
        // 宿主的 Node 测试子进程标记不能传给项目命令，否则真实测试可能沿嵌套协议返回 0。
        env: target => new NodeExecutionEnv({ cwd: target.cwd ?? cwd, shellEnv: { NODE_TEST_CONTEXT: undefined } }),
      });
      bindSession(session);
      // 重开只读取原配置；发送／明确继续前由应用层权威应用本次模型。
      return session;
    },
  };
}

// ---------- 预设供应商后端（builtin 身份 + 目录模型） ----------

export interface PresetBackendOptions {
  /** 额度观察回调（读取服务商真实响应头） */
  observeQuota?: QuotaObservationSink;
  stateDir: string;
  selection: { providerId: string; modelId: string };
  preset: RegisteredPresetProvider;
  /** 目录解析出的完整本地模板模型（builtin 精确条目或 anchor-only 新线上模型；api/baseUrl 本地权威） */
  model: Model<Api>;
  /** UI 安全元数据（名称/能力/价格），与 model 同源但不含模板 secret 字段 */
  info: { id: string; name: string };
  store: ProviderDirectoryStore;
  /** 仅测试装配注入：按 providerId 替换请求 baseUrl（loopback 传输路由），正常启动不传 */
  baseUrlOverrides?: Record<string, string>;
  diagnose?: (event: string, cause: unknown) => void;
  /** 其余已配置来源的可请求模型：让「改选到另一个已配置来源」在执行端真的可请求 */
  additionalSources?: readonly ConfiguredSourceModels[];
  /** 每次 SDK 请求前的完整准入门（应用层提供）；缺席 = 该实例不做请求前准入 */
  admitRequest?: SdkRequestAdmissionGate;
}

function baseUrlOverrideFor(providerId: string, overrides: Record<string, string> | undefined): string | undefined {
  return overrides?.[providerId];
}

/**
 * 保留下来的自定义接入在 Pi 侧的可请求 provider。
 *
 * 与 `createRealPiBackend` 用的是同一套 api 分发、净化与认证语义：
 * 当前选中的是别的来源时，这条自定义接入仍然能被会话选中并真的发请求。
 */
function createCustomSourceProvider(
  config: { provider: "openai-completions" | "anthropic-messages"; label: string; modelId: string; baseUrl: string },
  options: ProviderStreamOptions,
): unknown {
  const api = config.provider === "anthropic-messages" ? anthropicMessagesApi : openaiCompletionsApi;
  const model = {
    id: config.modelId,
    name: config.modelId,
    api: config.provider,
    provider: CUSTOM_PROVIDER_ID,
    baseUrl: config.baseUrl,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
    reasoning: false,
  };
  return createProvider({
    id: CUSTOM_PROVIDER_ID,
    name: config.label,
    baseUrl: config.baseUrl,
    models: [model],
    api: {
      stream: (m: unknown, ctx: unknown, opts: unknown) => relayStreamWithSanitization(
        wrapStreamMethod("stream", api, options)(m as never, ctx as never, opts as never) as ReturnType<typeof createAssistantMessageEventStream>,
        typeof (opts as StreamOptions | undefined)?.apiKey === "string" ? (opts as StreamOptions).apiKey as string : "",
      ),
      streamSimple: (m: unknown, ctx: unknown, opts: unknown) => relayStreamWithSanitization(
        wrapStreamMethod("streamSimple", api, options)(m as never, ctx as never, opts as never) as ReturnType<typeof createAssistantMessageEventStream>,
        typeof (opts as StreamOptions | undefined)?.apiKey === "string" ? (opts as StreamOptions).apiKey as string : "",
      ),
    },
    auth: {
      apiKey: {
        name: `${config.label} API key`,
        resolve: async ({ credential }) => (credential && credential.type === "api_key" && credential.key
          ? { auth: { apiKey: credential.key } }
          : undefined),
        login: undefined,
      },
    },
  });
}

/** 同源额外条目里的模型集合（已应用该来源的 baseUrl 覆盖）。 */
function presetModelsOf(
  sources: readonly ConfiguredSourceModels[],
  override: string | undefined,
): Model<Api>[] {
  const out: Model<Api>[] = [];
  for (const source of sources) {
    if (source.kind !== "preset") continue;
    for (const one of source.models) out.push(override ? ({ ...one, baseUrl: override } as Model<Api>) : one);
  }
  return out;
}

/** 用扩展后的模型集合重建 provider（当前那一个模型必须仍是第一个，agent 初始配置指向它）。 */
function providerWithModels(provider: unknown, models: readonly Model<Api>[]): unknown {
  return { ...(provider as Record<string, unknown>), getModels: () => [...models], getAllModels: () => [...models] };
}

/**
 * 登记其余**已配置**来源：每条会话改选到它们时，执行端必须能解析该身份并用同一份凭据发请求。
 * 只登记已配置且目录解析出本地权威模型的来源——没有可核对模型的不登记（不凭空造一个能用的身份）。
 * preset 与 custom 两条装配共用这一处，不各写一份。
 */
function registerAdditionalSources(
  modelsClient: SessionModelsClient,
  sources: readonly ConfiguredSourceModels[] | undefined,
  currentProviderId: string,
  options: {
    observeQuota?: QuotaObservationSink;
    diagnose?: (event: string, cause: unknown) => void;
    baseUrlOverrides?: Record<string, string>;
    admitRequest?: SdkRequestAdmissionGate;
    sessionRef: { current: string };
    registered: RegisteredModels;
    /** 当前来源已包装好的 provider：刷新后要把同源新增模型重新挂回去 */
    currentProvider?: unknown;
  },
): string[] {
  const replaced: string[] = [];
  for (const extra of sources ?? []) {
    if (extra.providerId === currentProviderId) {
      // 当前来源同样要同步：目录刷新后**同源**新增的模型不在已打开客户端的模型集合里，
      // 会话改选到那个新 ID 就解析不到身份，请求发不出去（不是只有新来源受影响）。
      if (extra.kind !== "preset" || extra.models.length === 0) continue;
      const sameOverride = baseUrlOverrideFor(extra.providerId, options.baseUrlOverrides);
      const sameModels = sameOverride
        ? extra.models.map((m) => ({ ...m, baseUrl: sameOverride } as Model<Api>))
        : [...extra.models];
      options.registered.set(extra.providerId, sameModels);
      const base = options.currentProvider as Record<string, unknown> | undefined;
      if (base) {
        modelsClient.registerNativeProvider({ ...base, getModels: () => sameModels, getAllModels: () => sameModels } as never);
        replaced.push(extra.providerId);
      }
      continue;
    }
    if (extra.kind === "custom") {
      options.registered.set(extra.providerId, [{
        id: extra.config.modelId,
        name: extra.config.modelId,
        api: extra.config.provider,
        provider: extra.providerId,
        baseUrl: extra.config.baseUrl,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
        reasoning: false,
      } as unknown as Model<Api>]);
      modelsClient.registerNativeProvider(createCustomSourceProvider(extra.config, { ...options, modelsClient }) as never);
      replaced.push(extra.providerId);
      continue;
    }
    if (extra.models.length === 0) continue;
    const override = baseUrlOverrideFor(extra.providerId, options.baseUrlOverrides);
    // 该来源下可请求的全部已解析模型（不只当前那一个）：改选到同源的另一个模型也要真能请求。
    const models = override
      ? extra.models.map((m) => ({ ...m, baseUrl: override } as Model<Api>))
      : [...extra.models];
    options.registered.set(extra.providerId, models);
    modelsClient.registerNativeProvider({
      ...extra.preset.provider,
      stream: wrapStreamMethod("stream", extra.preset.provider, { ...options, modelsClient }),
      streamSimple: wrapStreamMethod("streamSimple", extra.preset.provider, { ...options, modelsClient }),
      getModels: () => models,
      getAllModels: () => models,
    } as never);
    replaced.push(extra.providerId);
  }
  return replaced;
}

/**
 * 统一的 provider 流包装：注入额度观察、净化服务端错误（可能回显 key）、异常如实诊断。
 * 当前来源与其它已配置来源共用同一份规则，不因来源不同而少一道净化。
 */
function wrapStreamMethod(
  method: "stream" | "streamSimple",
  inner: unknown,
  options: ProviderStreamOptions,
): (...args: never[]) => ReturnType<typeof createAssistantMessageEventStream> {
  const diagnose = options.diagnose ?? (() => undefined);
  return (m: unknown, ctx: unknown, opts: unknown) => {
    const request = admissionRequestOf(options.sessionRef.current, m, ctx);
    return withRequestAdmission(
      (chosen) => {
        const admittedOptions = { ...((opts ?? {}) as StreamOptions & { env?: unknown; reasoning?: string }) };
        const actualModel = resolveRegisteredModel(options.registered, chosen);
        if (!actualModel) throw new Error('裁定模型已从执行端移除');
        if (request.requires?.includes('image-input') && !actualModel.input.includes('image')) throw new Error('该模型未核实支持图片输入');
        // SDK 门可能晚于准备阶段改选；复用同一预算规则核对这次真正采用的物理模型。
        const budget = physicalRequestBudget(actualModel, ctx as never, admittedOptions.maxTokens);
        if (budget.capacityExceeded) throw new Error('Context overflow: physical model capacity is insufficient for this request');
        admittedOptions.maxTokens = budget.maxTokens;
        // 裁定在 SDK 已捕获 A/high 之后才到达，必须覆盖当次参数，而不只更新下一轮配置。
        // null/off 清除旧值；已核实的档位交给 SDK streamSimple 正式逐协议映射，不手拼原生参数。
        const admittedMethod = chosen.thinkingLevel === undefined ? method : "streamSimple";
        if (chosen.thinkingLevel !== undefined) {
          delete admittedOptions.reasoning;
          if (chosen.thinkingLevel !== null && chosen.thinkingLevel !== "off") admittedOptions.reasoning = chosen.thinkingLevel;
        }
        if (chosen.sourceId !== request.sourceId || chosen.modelId !== request.modelId) {
          // registered只核受管身份/能力；实际重分派必须取本会话canonical投影，原始模板不含已确认的扩展头。
          const selected = options.modelsClient.getPhysicalModel(chosen.sourceId, chosen.modelId);
          if (!selected) throw new Error("裁定模型已从执行端移除");
          // SDK 到达 provider 前已按原来源解析认证。只换 model 会把 A 的密钥/头传给 B，
          // 也会继续使用 A 的协议。去掉这份已解析认证，经本会话的 SDK 重新分派和解析 B；
          // 原上下文、取消信号和一般请求参数保留，B 的包装仍核完整准入并观察真实响应。
          const nextOptions = admittedOptions;
          delete nextOptions.apiKey;
          delete nextOptions.headers;
          delete nextOptions.env;
          return options.modelsClient[admittedMethod](selected, ctx as never, nextOptions as never);
        }
        const fn = (inner as Record<string, unknown>)[admittedMethod] as (
          a: never, b: never, c: never,
        ) => ReturnType<typeof createAssistantMessageEventStream>;
        return fn(m as never, ctx as never, withQuotaObservation(admittedOptions, options.observeQuota, diagnose) as never);
      },
      request,
      streamKeyOf(opts),
      { ...options, resolveModel: (target) => resolveRegisteredModel(options.registered, target) },
    );
  };
}

/**
 * 预设供应商后端：协议分发、模型参数与认证完全沿用 Pi 正式实现。
 * 与自定义路径的区别是模型对象来自目录（含真实 contextWindow/maxTokens/reasoning/input/cost），
 * 不再捏造一律 128k/4096/text/no-reasoning 的静态条目。
 */
export function createPresetPiBackend(options: PresetBackendOptions): ExecutionBackend {
  const { providerId, modelId } = options.selection;
  const registered: RegisteredModels = new Map();
  const baseUrlOverride = options.baseUrlOverrides?.[providerId];
  // 模型对象来自 executable-models 的本地模板解析（builtin 精确或 anchor），
  // 只在此处按显式测试装配覆盖 baseUrl；正常启动原样使用本地端点，不重建模板字段。
  const template = options.model;
  const model: Model<Api> = baseUrlOverride ? ({ ...template, baseUrl: baseUrlOverride } as Model<Api>) : template;
  const credStore = options.store.asPiCredentialStore();
  // 已配置来源列表**随刷新更新**：每条会话的客户端都在 open 时现造，只读装配那一刻的
  // 列表的话，刷新之后新开的会话仍拿不到新模型，身份解析不到，请求发不出去。
  let additionalSources = options.additionalSources;
  // 当前来源的模型对象：准入裁定要能把身份换成真正的模型对象
  registered.set(providerId, [model]);

  // 包装 builtin provider：流出口按同一份净化规则（服务端可能把 key 回显到错误正文）；
  // 模型集合固定为当前选择条目，不含在线目录的未知字段。
  const inner = options.preset.provider;
  /**
   * 按**本条会话**造一份 provider 与模型客户端：准入身份随端口创建，
   * 不会被后来打开的另一条会话改写（否则 S1 的后续请求按 S2 的身份核准入）。
   */
  const buildForSession = async (sessionId: string) => {
  const sessionRef = { current: sessionId };
  const modelsClient = await ownedModels(credStore as import('@earendil-works/pi-ai').CredentialStore);
  const streamOptions = { ...options, sessionRef, registered, modelsClient };
  const provider = {
    ...inner,
    stream: wrapStreamMethod("stream", inner, streamOptions) as typeof inner.stream,
    streamSimple: wrapStreamMethod("streamSimple", inner, streamOptions) as typeof inner.streamSimple,
    getModels: () => [model],
    getAllModels: () => [model],
  };

  // 当前 provider 只登记了被选中的那一个模型；同源的其它已解析模型也在同一份集合里，
  // 一起登记（会话改选到同源另一个模型时才解析得到身份）。
  // **读刷新后的来源列表**：目录刷新后新开的会话必须能用新 ID 发起请求——
  // 仍读装配那一刻的旧列表，新模型在 client 里解析不到身份，请求会卡在队列里且不产生任何请求。
  const ownExtra = (additionalSources ?? []).filter(
    (extra) => extra.kind === "preset" && extra.providerId === providerId,
  );
  const ownModels = [model, ...presetModelsOf(ownExtra, baseUrlOverrideFor(providerId, options.baseUrlOverrides))];
  // 同源身份也要能换成真正的模型对象：裁定改用到同源另一个模型时不得解析不到。
  registered.set(providerId, ownModels);
  modelsClient.registerNativeProvider(providerWithModels(provider, ownModels) as never);
  registerAdditionalSources(modelsClient, additionalSources, providerId, { ...options, sessionRef, registered, currentProvider: provider });
  return { client: modelsClient, provider, providerHeaders: new CodingProviderHeaders(modelsClient, [...registered.keys()]) };
  };

  /** 已打开端口的模型客户端：认证提交后要把新增来源同步进去。 */
  // 显式记录「哪个客户端属于哪条会话」：类型强转**不会**生成运行时字段，
  // 之前把 client 直接当带 sessionId 的对象压进来，refresh 时读到的 sessionId 是 undefined。
  const openedClients: { client: SessionModelsClient; sessionId: string; provider: unknown; providerHeaders: CodingProviderHeaders }[] = [];

  return {
    kind: "pi",
    /**
     * 按**当次**配置重新登记已配置来源：认证提交之后，已打开的 modelsClient 也要同步。
     * 只通知目录而不动实际客户端，新增来源仍然解析不到身份——动态元数据查询不等于客户端同步。
     *
     * 同时**记住这份新列表**：每条会话的客户端是在 open 时现造的，只补已打开的客户端，
     // 刷新之后新开的会话仍会拿到旧列表，新模型照样解析不到。
     */
    async refreshAdditionalSources(sources: readonly ConfiguredSourceModels[] | undefined): Promise<void> {
      additionalSources = sources;
      const failures: unknown[] = [];
      // 来源已正式刷新；某会话声明与新base不兼容时保留其失效，不能截断其余活客户端的同步。
      for (const opened of openedClients) {
        try {
          const replaced = registerAdditionalSources(opened.client, sources, providerId, { ...options, sessionRef: { current: opened.sessionId }, registered, currentProvider: opened.provider });
          opened.providerHeaders.refresh(replaced);
        } catch (error) { failures.push(error); }
      }
      if (failures.length) throw failures[0];
    },
    modelName: `${options.preset.name} / ${options.info.name}`,
    async open(context: SessionExecutionContext): Promise<PiExecutionSession> {
      const cwd = await initialWorkingDirectory(context, options.stateDir);
      const directory = join(options.stateDir, "runtime", context.target.sessionId);
      // 每条会话自带一份模型客户端：准入身份随端口创建，不会被后打开的会话改写
      const built = await buildForSession(context.target.sessionId);
      const modelsClient = built.client;
      const coding = context.projectAccess === 'task-owner' ? createCodingTools(join(options.stateDir, 'coding-resources')) : null;
      const registry = createRegistry(); if (coding) registry.install(coding);
      openedClients.push({
        client: modelsClient,
        sessionId: context.target.sessionId,
        provider: built.provider,
        providerHeaders: built.providerHeaders,
      });
      const preparation = codingPreparation(coding, join(options.stateDir, 'coding-resources'), () => context.projectExtensionsEnabled?.() === true, registry, modelsClient, context.target.sessionId, built.providerHeaders);
      const { bindSession, ...sessionPreparation } = preparation;
      const session = await PiExecutionSession.open({
        target: context.target,
        directory,
        cwd,
        initialize: context.initialize,
        reuseStoredCwd: true,
        registry,
        ...sessionPreparation,
        settings: { retry: { maxRetries: 0 }, toolExecution: 'sequential' },
        agent: {
          extensions: [],
          model: { provider: context.model?.sourceId ?? providerId, modelId: context.model?.modelId ?? modelId },
          thinkingLevel: context.model?.thinkingLevel as never,
        },
        env: target => new NodeExecutionEnv({ cwd: target.cwd ?? cwd, shellEnv: { NODE_TEST_CONTEXT: undefined } }),
      });
      bindSession(session);
      // 模型应用只发生在正式发送／继续；只读回查不能顺带配置旧运行。
      return session;
    },
  };
}

// ---------- 统一装配工厂（custom / preset 双路径） ----------

export interface BackendFactoryDependencies {
  stateDir: string;
  cipher: CredentialCipher;
  /** 额度观察回调：从每次**真实响应**的服务商头读取权威剩余额度 */
  observeQuota?: QuotaObservationSink;
  /** 旧 format 1 写入兼容：自定义保存的应用层兼容接口（新写不再经此；assemble 只读） */
  legacyStore: ModelSetupStore;
  directoryStore: ProviderDirectoryStore;
  presets: readonly RegisteredPresetProvider[];
  baseUrlOverrides?: Record<string, string>;
  diagnose?: (event: string, cause: unknown) => void;
  /**
   * **其余已配置来源**的可请求模型（同样有凭据）。
   *
   * 只登记当前默认来源时，改选到另一个已配置来源会在 Pi 侧查不到该身份——
   * 界面说选好了，执行端却发不出那个来源的请求。这里按调用方从目录与凭据记录核对过的事实登记，
   * 不登记未配置或未核实的身份。
   */
  additionalSources?: readonly ConfiguredSourceModels[];
  /** 每次 SDK 请求前的完整准入门（应用层提供） */
  admitRequest?: SdkRequestAdmissionGate;
}

/**
 * 一个**已配置**来源的可请求身份。
 *
 * · `preset`：目录里的供应商来源，凭据已存；登记该来源下被解析出本地权威模型的全部条目；
 * · `custom`：保留下来的自定义接入定义（当前选中的是别的来源时它仍然有效、可被会话选中）。
 */
export type ConfiguredSourceModels =
  | { readonly kind: "preset"; readonly providerId: string; readonly preset: RegisteredPresetProvider; readonly models: readonly Model<Api>[] }
  | { readonly kind: "custom"; readonly providerId: string; readonly config: { provider: "openai-completions" | "anthropic-messages"; label: string; modelId: string; baseUrl: string } };

/** 按当前持久化的 CurrentModelSelection 构造执行后端；未配置或缺凭据返回 unavailable（不含假解锁）。
 *  preset 分支输入为 executable-models 解析好的完整本地模板模型；调用方（main/assembly）必须用
 *  catalog.resolveExecutable 取得，不得自行拼模型。 */
export function createBackendFromSelection(
  selection:
    | { kind: "custom"; provider: ModelSetupInput["provider"]; label: string; modelId: string; baseUrl: string }
    | { kind: "preset"; providerId: string; modelId: string; model: Model<Api>; info: { id: string; name: string } },
  deps: BackendFactoryDependencies,
): ExecutionBackend {
  if (selection.kind === "custom") {
    return createRealPiBackend({
      stateDir: deps.stateDir,
      config: { provider: selection.provider, label: selection.label, modelId: selection.modelId, baseUrl: selection.baseUrl },
      cipher: deps.cipher,
      store: deps.legacyStore,
      credentialSource: deps.directoryStore,
      observeQuota: deps.observeQuota,
      additionalSources: deps.additionalSources,
      admitRequest: deps.admitRequest,
      diagnose: deps.diagnose,
    });
  }
  const preset = deps.presets.find((p) => p.id === selection.providerId);
  if (!preset) throw new Error(`unknown-preset-provider-${selection.providerId}`);
  return createPresetPiBackend({
    stateDir: deps.stateDir,
    selection: { providerId: selection.providerId, modelId: selection.modelId },
    preset,
    model: selection.model,
    info: selection.info,
    store: deps.directoryStore,
    baseUrlOverrides: deps.baseUrlOverrides,
    observeQuota: deps.observeQuota,
    diagnose: deps.diagnose,
    additionalSources: deps.additionalSources,
    admitRequest: deps.admitRequest,
  });
}

export const unavailableBackend: ExecutionBackend = {
  kind: "unavailable",
  modelName: null,
  async open() { throw new Error("execution-unavailable"); },
};
