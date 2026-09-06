import type { ProviderView } from "./model-providers.js";

export interface ModelChoice {
  key: string;
  providerId: string;
  providerName: string;
  modelId: string;
  name: string;
  available: boolean;
  enabled: boolean;
  reasoning: boolean;
  contextWindow: number | null;
  thinkingLevels: string[];
}
export interface DCodeModelsView {
  models: ModelChoice[];
  providers: { id: string; name: string; connected: boolean }[];
  legacyProviders: ProviderView[];
  selectedKey: string | null;
  defaultKey: string | null;
  thinking: string;
  defaultThinking: string;
  thinkingLevels: string[];
  refreshing?: boolean;
  refresh: { updatedAt?: string; failedProviders: string[]; offline: boolean };
}
