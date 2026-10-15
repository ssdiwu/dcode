// 宿主认证生命周期：一个记录贯穿相位核对与 SDK 登录，取消/关闭始终针对同一身份。
import type { DCodeApplication } from "@/application";
import type { AuthFlowGuard } from "@/adapters/pi";
import type { DCodeBridge, LoginProviderResult } from "@/contracts";

type LoginInput = Parameters<DCodeBridge["loginProvider"]>[0];
interface LoginDependencies {
  admit(providerId: string): ReturnType<DCodeApplication["beginProviderAuth"]>;
  beginGuard(providerId: string): AuthFlowGuard;
  perform(input: LoginInput, guard: AuthFlowGuard, signal: AbortSignal): Promise<LoginProviderResult>;
  rejectPrompts(loginId: string): void;
  diagnose(error: unknown): void;
}
interface LoginEntry {
  providerId: string;
  controller: AbortController;
  guard: AuthFlowGuard | null;
  release: (() => void) | null;
  settled: Promise<void>;
}

export class ProviderLoginController {
  private readonly logins = new Map<string, LoginEntry>();
  private closed = false;
  private closePromise: Promise<void> | null = null;

  constructor(private readonly deps: LoginDependencies) {}

  start(input: LoginInput): Promise<LoginProviderResult> {
    if (this.closed) return Promise.resolve({ ok: false, issue: "run-in-flight", message: "应用正在关闭，无法开始认证" });
    if (this.logins.has(input.loginId)) return Promise.resolve({ ok: false, issue: "invalid-input", message: "该认证标识已在进行中" });
    if ([...this.logins.values()].some((login) => login.providerId === input.providerId)) {
      return Promise.resolve({ ok: false, issue: "run-in-flight", message: "该供应商已有认证流程在进行" });
    }
    const login: LoginEntry = { providerId: input.providerId, controller: new AbortController(), guard: null, release: null, settled: Promise.resolve() };
    // 首个 await 前登记，UI 卸载/取消及退出在 admission 期间也能撤销这次身份。
    this.logins.set(input.loginId, login);
    const operation = (async (): Promise<LoginProviderResult> => {
      try {
        const admitted = await this.deps.admit(input.providerId);
        if (!admitted.ok) return { ok: false, issue: "run-in-flight", message: admitted.reason === "shutting-down" ? "应用正在关闭，无法开始认证" : "当前工作或配置仍在进行，请完成后再认证" };
        login.release = admitted.release;
        if (login.controller.signal.aborted) return { ok: false, issue: "cancelled", message: "认证已取消" };
        login.guard = this.deps.beginGuard(input.providerId);
        return await this.deps.perform(input, login.guard, login.controller.signal);
      } catch (error) {
        this.deps.diagnose(error);
        return { ok: false, issue: login.controller.signal.aborted ? "cancelled" : "auth-failed", message: login.controller.signal.aborted ? "认证已取消" : "认证失败，原认证资料保留" };
      } finally {
        login.guard?.revoke();
        login.release?.();
        this.logins.delete(input.loginId);
      }
    })();
    login.settled = operation.then(() => undefined, () => undefined);
    return operation;
  }

  cancel(loginId: string): { ok: boolean } {
    const login = this.logins.get(loginId);
    login?.guard?.revoke();
    login?.controller.abort();
    this.deps.rejectPrompts(loginId);
    return { ok: true };
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    for (const loginId of this.logins.keys()) this.cancel(loginId);
    // 信号发出不等于收束；包括未进入 SDK 的相位读取，等待每个身份真正释放。
    this.closePromise = Promise.allSettled([...this.logins.values()].map((login) => login.settled)).then(() => undefined);
    return this.closePromise;
  }
}
