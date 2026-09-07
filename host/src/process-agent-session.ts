import {routedProviderStream,type ProviderRouteControl} from "./provider-route-stream.js";
import {guardPrivateSessionPersistence,sanitizeRuntimeValue} from "./runtime-privacy.js";
import { AgentSession, createCodingTools, createReadOnlyTools, convertToLlm, type AgentSessionConfig, type CreateAgentSessionOptions, type CreateAgentSessionResult, type ModelRuntime, type ResourceLoader, type SessionManager, type SettingsManager } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel } from "@earendil-works/pi-ai/compat";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { ProcessAgent, type ProcessAgentOptions } from "./process-agent.js";

type Options = CreateAgentSessionOptions & {
  modelRuntime: ModelRuntime;
  sessionManager: SessionManager;
  settingsManager: SettingsManager;
  resourceLoader: ResourceLoader;
  providerControl?:ProviderRouteControl;
  baseToolsOverride?:AgentSessionConfig["baseToolsOverride"];
  processOptions?: Pick<ProcessAgentOptions, "idleTimeoutMs" | "onProcessChanged">;
};

/** Compose Pi's public AgentSession around the process-backed Agent. Session
 * history, tool hooks, source receipts and Provider authentication remain in the
 * Host. The private process owns the Pi loop and never opens a Product Store.
 */
export async function createProcessAgentSession(options: Options): Promise<CreateAgentSessionResult> {
  const { modelRuntime, sessionManager, settingsManager, resourceLoader } = options;
  guardPrivateSessionPersistence(sessionManager);
  const history = sanitizeRuntimeValue(sessionManager.buildSessionContext());
  const available = modelRuntime.getAvailableSnapshot();
  const model = options.model ?? available.find((candidate) => candidate.provider === history.model?.provider && candidate.id === history.model.modelId) ?? available[0];
  const configuredThinking = options.thinkingLevel ?? history.thinkingLevel as ThinkingLevel | undefined ?? settingsManager.getDefaultThinkingLevel() ?? "medium";
  const thinkingLevel = model ? clampThinkingLevel(model, configuredThinking) : "off";
  const ref: NonNullable<AgentSessionConfig["extensionRunnerRef"]> = {};
  const streamFn:NonNullable<import("@earendil-works/pi-agent-core").AgentOptions["streamFn"]> = (selected, context, streamOptions) => {
      const retry = settingsManager.getProviderRetrySettings();
      const idle = settingsManager.getHttpIdleTimeoutMs();
      return modelRuntime.streamSimple(selected, context, {
        ...streamOptions,
        timeoutMs: streamOptions?.timeoutMs ?? retry.timeoutMs ?? (idle === 0 ? 2_147_483_647 : idle),
        websocketConnectTimeoutMs: streamOptions?.websocketConnectTimeoutMs ?? settingsManager.getWebSocketConnectTimeoutMs(),
        maxRetries: streamOptions?.maxRetries ?? retry.maxRetries,
        maxRetryDelayMs: streamOptions?.maxRetryDelayMs ?? retry.maxRetryDelayMs,
        transformHeaders: async (headers) => ref.current?.hasHandlers("before_provider_headers")
          ? await ref.current.emitBeforeProviderHeaders(headers ?? {}) : headers ?? {},
      });
    };
  const agent = new ProcessAgent({
    ...options.processOptions,
    initialState: { model, thinkingLevel, messages: history.messages, tools: [] },
    convertToLlm: (messages) => {
      const converted = convertToLlm(messages).map(message=>{const {dcodeSteerId,...clean}=message as typeof message&{dcodeSteerId?:string};return clean as typeof message;});
      if (!settingsManager.getBlockImages()) return converted;
      return converted.map((message) => {
        if ((message.role !== "user" && message.role !== "toolResult") || !Array.isArray(message.content)) return message;
        return { ...message, content: message.content.map((item) => item.type === "image" ? { type: "text" as const, text: "[Image input disabled]" } : item) };
      });
    },
    streamFn:options.providerControl?routedProviderStream(streamFn,options.providerControl):streamFn,

    onPayload: async (payload) => ref.current?.hasHandlers("before_provider_request") ? await ref.current.emitBeforeProviderRequest(payload) : payload,
    onResponse: async (response) => { if (ref.current?.hasHandlers("after_provider_response")) await ref.current.emit({ type: "after_provider_response", status: response.status, headers: response.headers }); },
    transformContext: async (messages) => ref.current ? await ref.current.emitContext(messages) : messages,
    sessionId: sessionManager.getSessionId(),
    steeringMode: settingsManager.getSteeringMode(),
    followUpMode: settingsManager.getFollowUpMode(),
    transport: settingsManager.getTransport(),
    thinkingBudgets: settingsManager.getThinkingBudgets(),
    maxRetryDelayMs: settingsManager.getProviderRetrySettings().maxRetryDelayMs,
  });
  if (!history.messages.length) {
    if (model) sessionManager.appendModelChange(model.provider, model.id);
    sessionManager.appendThinkingLevelChange(thinkingLevel);
  }
  const excluded = new Set(options.excludeTools ?? []);
  const initial = options.tools ?? (options.noTools ? [] : settingsManager.getDefaultTools() ?? ["read", "bash", "edit", "write"]);
  const session = new AgentSession({
    agent, modelRuntime, sessionManager, settingsManager, resourceLoader,
    baseToolsOverride:options.baseToolsOverride?{...Object.fromEntries([...createCodingTools(options.cwd??sessionManager.getCwd(),{read:{autoResizeImages:settingsManager.getImageAutoResize()}}),...createReadOnlyTools(options.cwd??sessionManager.getCwd(),{read:{autoResizeImages:settingsManager.getImageAutoResize()}})].map(tool=>[tool.name,tool])),...options.baseToolsOverride}:undefined,
    cwd: options.cwd ?? sessionManager.getCwd(),
    scopedModels: options.scopedModels,
    customTools: options.customTools,
    initialActiveToolNames: initial.filter((name) => !excluded.has(name)),
    allowedToolNames: options.tools ?? (options.noTools === "all" ? [] : undefined),
    excludedToolNames: options.excludeTools,
    extensionRunnerRef: ref,
    sessionStartEvent: options.sessionStartEvent,
  });
  return { session, extensionsResult: resourceLoader.getExtensions() };
}
