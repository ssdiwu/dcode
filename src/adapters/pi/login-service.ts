// 供应商认证编排（pi 模块公开 facade）：SDK 登录、prompt/notify 交互、flow 门禁与凭据落盘全部
// 留在 adapter；main 只做宿主桥事件转发。凭据正文不回流 main/UI；结果只带安全状态。
import type { AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import type { ProviderDirectoryStore } from "./provider-directory-store";
import type { RegisteredPresetProvider } from "./preset-providers";
import { createLoginModelsClient } from "./login-client";
import type { AuthFlowGuard } from "./auth-flow-guard";

export type LoginOutcome =
  | { ok: true }
  | { ok: false; issue: "cancelled" | "auth-failed"; message?: string };

export interface LoginPromptEvent {
  loginId: string;
  requestId: string;
  kind: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: ReadonlyArray<{ id: string; label: string; description?: string }>;
}

export interface LoginInfoEvent {
  loginId: string;
  type: "info" | "auth_url" | "device_code" | "progress";
  message?: string;
  url?: string;
  userCode?: string;
  verificationUri?: string;
  intervalSeconds?: number;
  expiresInSeconds?: number;
}

export interface LoginServiceCallbacks {
  /** prompt 请求：实现方把回答经 answerPrompt 回送；返回的 Promise 由 SDK 等待 */
  onPrompt(event: LoginPromptEvent): void;
  /** info/auth_url/device_code/progress */
  onInfo(event: LoginInfoEvent): void;
}

export class ProviderLoginService {
  #pending = new Map<string, { loginId: string; resolve: (v: string) => void; reject: (e: Error) => void }>();
  #promptSeq = 0;

  constructor(private readonly deps: {
    directoryStore: ProviderDirectoryStore;
    presets: readonly RegisteredPresetProvider[];
  }) {}

  /** UI 回答一次 prompt（或 cancel）；未知 requestId 返回 false。 */
  answerPrompt(requestId: string, value: string | undefined, cancel: boolean): boolean {
    const pending = this.#pending.get(requestId);
    if (!pending) return false;
    this.#pending.delete(requestId);
    if (cancel) pending.reject(new Error("prompt-cancelled"));
    else pending.resolve(String(value ?? ""));
    return true;
  }

  /** 结束指定 login 的全部挂起 prompt（取消/关闭/收束路径共用）。 */
  rejectLoginPrompts(loginId: string, reason: Error): void {
    for (const [id, p] of this.#pending) {
      if (p.loginId === loginId) {
        this.#pending.delete(id);
        p.reject(reason);
      }
    }
  }

  /**
   * 走 SDK 正式 login；guard 是该 flow 的提交点门禁（由 main 从 AuthFlowRegistry 取得）。
   * 凭据经 gated CredentialStore 在真实提交点写入；这里不读明文。
   */
  async runLogin(
    input: { loginId: string; providerId: string; type: "api_key" | "oauth" },
    guard: AuthFlowGuard,
    signal: AbortSignal,
    callbacks: LoginServiceCallbacks,
  ): Promise<LoginOutcome> {
    const preset = this.deps.presets.find((p) => p.id === input.providerId);
    if (!preset) return { ok: false, issue: "auth-failed", message: "未登记的预设供应商" };
    if (input.type === "api_key" && !preset.provider.auth.apiKey?.login) return { ok: false, issue: "auth-failed", message: "该供应商不支持密钥收集" };
    if (input.type === "oauth" && !preset.provider.auth.oauth) return { ok: false, issue: "auth-failed", message: "该供应商不支持账户授权" };
    const gatedStore = this.deps.directoryStore.asPiCredentialStore({
      beforePrepare: (target) => guard.beforePrepare(target),
      beforeCommit: (target) => guard.beforeCommit(target),
    });
    const models = createLoginModelsClient(gatedStore, preset.provider);
    const interaction: AuthInteraction = {
      signal,
      prompt: async (prompt: AuthPrompt) => {
        const requestId = `${input.loginId}-p${++this.#promptSeq}`;
        const placeholder = "placeholder" in prompt && typeof prompt.placeholder === "string" ? prompt.placeholder : undefined;
        callbacks.onPrompt({
          loginId: input.loginId,
          requestId,
          kind: prompt.type,
          message: prompt.message,
          ...(placeholder ? { placeholder } : {}),
          ...(prompt.type === "select"
            ? { options: prompt.options.map((o: { id: string; label: string; description?: string }) => ({ id: o.id, label: o.label, ...(o.description ? { description: o.description } : {}) })) }
            : {}),
        });
        return new Promise<string>((resolve, reject) => {
          this.#pending.set(requestId, { loginId: input.loginId, resolve, reject });
        });
      },
      notify: (event) => {
        if (event.type === "info") callbacks.onInfo({ loginId: input.loginId, type: "info", message: event.message });
        else if (event.type === "auth_url") callbacks.onInfo({ loginId: input.loginId, type: "auth_url", url: event.url, message: event.instructions });
        else if (event.type === "device_code") callbacks.onInfo({ loginId: input.loginId, type: "device_code", userCode: event.userCode, verificationUri: event.verificationUri, intervalSeconds: event.intervalSeconds, expiresInSeconds: event.expiresInSeconds });
        else if (event.type === "progress") callbacks.onInfo({ loginId: input.loginId, type: "progress", message: event.message });
      },
    };
    try {
      await models.login(input.providerId, input.type, interaction, {});
      return { ok: true };
    } catch (err) {
      if (signal.aborted) return { ok: false, issue: "cancelled" };
      return { ok: false, issue: "auth-failed", message: String((err as Error)?.message ?? err) };
    } finally {
      this.rejectLoginPrompts(input.loginId, new Error("login-ended"));
    }
  }
}
