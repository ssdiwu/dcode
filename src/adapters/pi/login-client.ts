// 认证用的 Models 客户端构造（pi 模块内部）：main 不直接装配 pi-ai。
// gated CredentialStore + deny-ambient AuthContext + 单个已注册 provider；
// models.login 的完整 Credential 只进入该 store（主进程安全存储），不回流到调用方视图。
import { createModels } from "@earendil-works/pi-ai";
import type { AuthInteraction, AuthPrompt, AuthType, Credential, LoginOptions, Models } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { NO_AMBIENT_CONTEXT } from "./preset-providers";

export function createLoginModelsClient(credentials: CredentialStore, provider: Provider): Models {
  const models = createModels({ credentials, authContext: NO_AMBIENT_CONTEXT });
  (models as unknown as { setProvider(p: unknown): void }).setProvider(provider);
  return models as unknown as Models;
}

export type { AuthInteraction, AuthPrompt, AuthType, Credential, LoginOptions };
