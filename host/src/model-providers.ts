import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Pi 的 package exports 映射未开放子路径，Node 的 exports 限制只作用于裸说明符；
// ModelConfig（models.json 的权威校验器）只能按文件路径动态加载。源码布局在
// host/src，编译产物在 host/dist/src，两档相对深度都探测（随 0.84.1 锁定）。
interface ModelConfigInstance {
  getProviderIds(): readonly string[];
  getProvider(id: string): unknown;
  getError(): string | undefined;
}

interface ModelConfigModule {
  ModelConfig: { load(path: string | undefined): Promise<ModelConfigInstance> };
}

async function loadModelConfigModule(): Promise<ModelConfigModule> {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const up of ["..", "../.."]) {
    const candidate = join(
      here,
      up,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "core",
      "model-config.js",
    );
    if (existsSync(candidate)) {
      return (await import(candidate)) as unknown as ModelConfigModule;
    }
  }
  throw new Error("无法定位 @earendil-works/pi-coding-agent 的 model-config.js（布局变更？）");
}

const ModelConfig = await loadModelConfigModule().then((module) => module.ModelConfig);

/** Swift 侧可见的模型定义（models.json 的模型无凭据字段，基础字段直出）。 */
export interface ProviderModelView {
  id: string;
  name: string | null;
  api: string | null;
  baseUrl: string | null;
  reasoning: boolean | null;
  contextWindow: number | null;
  maxTokens: number | null;
}

/** Swift 侧可见的供应商：凭据与 header 值脱敏，只报状态与键名。 */
export interface ProviderView {
  id: string;
  name: string | null;
  baseUrl: string | null;
  api: string | null;
  authMode: "apiKey" | "oauth" | "none";
  authConfigured: boolean;
  headerKeys: string[];
  models: ProviderModelView[];
  compatJson: string | null;
  modelOverridesJson: string | null;
}

export interface ProviderModelInput {
  id: string;
  name?: string | null;
  api?: string | null;
  baseUrl?: string | null;
  reasoning?: boolean | null;
  contextWindow?: number | null;
  maxTokens?: number | null;
}

export interface ProviderSaveInput {
  id: string;
  name?: string | null;
  baseUrl?: string | null;
  api?: string | null;
  /** 只写：正文不回显；remove 优先于 newApiKey / oauthRadius。 */
  newApiKey?: string;
  oauthRadius?: boolean;
  removeAuth?: boolean;
  models: ProviderModelInput[];
  /** null = 不修改；提供则以 JSON 文本整体替换（必须可解析为对象）。 */
  compatJson?: string | null;
  modelOverridesJson?: string | null;
}

export interface FieldError {
  field: string;
  message: string;
}

export interface ProviderListResult {
  path: string;
  parseError: string | null;
  providers: ProviderView[];
}

export type ProviderSaveResult =
  | { ok: true; providers: ProviderView[]; parseError: string | null }
  | { ok: false; errors: FieldError[] };

type RawProvider = Record<string, unknown>;
type RawModel = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Pi `models.json` 合同的读写边界：读取经 ModelConfig（支持注释、schema 校验），
 * 返回 Swift 的视图永远不含 apiKey / oauth / header 值正文；保存按 provider 合并
 * ——Swift 提交非凭据字段，既有凭据原样保留，新凭据只写不回显；结构检查 +
 * ModelConfig 对候选文件的真实校验双层把关，任一失败零写入。
 */
export class ModelProvidersStore {
  constructor(readonly path: string) {}

  static forAgentDir(agentDir: string): ModelProvidersStore {
    return new ModelProvidersStore(join(agentDir, "models.json"));
  }

  private async loadConfig(path = this.path): Promise<ModelConfigInstance> {
    return ModelConfig.load(path);
  }

  private async readRawProviders(): Promise<
    { ok: true; providers: Map<string, RawProvider> } | { ok: false; error: string }
  > {
    const config = await this.loadConfig();
    const parseError = config.getError();
    if (parseError) return { ok: false, error: parseError };
    const providers = new Map<string, RawProvider>();
    for (const id of config.getProviderIds()) {
      const provider = config.getProvider(id);
      if (provider !== undefined) providers.set(id, provider as unknown as RawProvider);
    }
    return { ok: true, providers };
  }

  async list(): Promise<ProviderListResult> {
    const config = await this.loadConfig();
    const parseError = config.getError() ?? null;
    const providers: ProviderView[] = [];
    if (!parseError) {
      for (const id of config.getProviderIds()) {
        const raw = config.getProvider(id) as unknown as RawProvider | undefined;
        if (raw) providers.push(this.view(id, raw));
      }
      providers.sort((a, b) => a.id.localeCompare(b.id));
    }
    return { path: this.path, parseError, providers };
  }

  private view(id: string, raw: RawProvider): ProviderView {
    const models = Array.isArray(raw.models) ? (raw.models as unknown[]).filter(isRecord) : [];
    return {
      id,
      name: optionalString(raw.name),
      baseUrl: optionalString(raw.baseUrl),
      api: optionalString(raw.api),
      authMode: typeof raw.apiKey === "string" && raw.apiKey.length > 0
        ? "apiKey"
        : raw.oauth === "radius"
          ? "oauth"
          : "none",
      authConfigured: (typeof raw.apiKey === "string" && raw.apiKey.length > 0) || raw.oauth === "radius",
      headerKeys: isRecord(raw.headers) ? Object.keys(raw.headers) : [],
      models: models.map((model) => ({
        id: typeof model.id === "string" ? model.id : "",
        name: optionalString(model.name),
        api: optionalString(model.api),
        baseUrl: optionalString(model.baseUrl),
        reasoning: typeof model.reasoning === "boolean" ? model.reasoning : null,
        contextWindow: optionalNumber(model.contextWindow),
        maxTokens: optionalNumber(model.maxTokens),
      })),
      compatJson: raw.compat === undefined ? null : stableJson(raw.compat),
      modelOverridesJson: raw.modelOverrides === undefined
        ? null
        : stableJson(raw.modelOverrides),
    };
  }

  async save(input: ProviderSaveInput): Promise<ProviderSaveResult> {
    const errors: FieldError[] = [];
    const id = input.id?.trim() ?? "";
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) {
      errors.push({ field: "id", message: "供应商 id 只能包含字母、数字、点、下划线或连字符，且以字母或数字开头" });
    }
    if (input.baseUrl !== undefined && input.baseUrl !== null && input.baseUrl !== "") {
      try {
        const url = new URL(input.baseUrl);
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocol");
      } catch {
        errors.push({ field: "baseUrl", message: "baseUrl 必须是 http(s) URL" });
      }
    }
    if (input.api !== undefined && input.api !== null && input.api !== "" && /\s/.test(input.api)) {
      errors.push({ field: "api", message: "api 不能包含空白字符" });
    }
    const seenModelIds = new Set<string>();
    for (const [index, model] of (input.models ?? []).entries()) {
      const modelId = model.id?.trim() ?? "";
      if (!/^[^\s]+$/.test(modelId)) {
        errors.push({ field: `models[${index}].id`, message: "模型 id 不能为空或包含空白" });
      } else if (seenModelIds.has(modelId)) {
        errors.push({ field: `models[${index}].id`, message: `模型 id 重复：${modelId}` });
      }
      seenModelIds.add(modelId);
      for (const numericField of ["contextWindow", "maxTokens"] as const) {
        const value = model[numericField];
        if (value !== undefined && value !== null && (typeof value !== "number" || !Number.isFinite(value) || value <= 0)) {
          errors.push({ field: `models[${index}].${numericField}`, message: `${numericField} 必须是正数` });
        }
      }
    }
    const compat = this.parseAdvancedJson(input.compatJson, "compatJson", errors);
    const modelOverrides = this.parseAdvancedJson(input.modelOverridesJson, "modelOverridesJson", errors);
    if (errors.length > 0) return { ok: false, errors };

    const loaded = await this.readRawProviders();
    if (!loaded.ok) {
      return {
        ok: false,
        errors: [{ field: "models.json", message: `当前 models.json 无法解析，拒绝合并写入：${loaded.error}` }],
      };
    }

    const merged = this.mergeProvider(loaded.providers.get(id), input, compat, modelOverrides);
    const nextProviders = new Map(loaded.providers);
    nextProviders.set(id, merged);

    const write = await this.validateAndWrite(nextProviders);
    if (!write.ok) return { ok: false, errors: write.errors };
    const fresh = await this.list();
    return { ok: true, providers: fresh.providers, parseError: fresh.parseError };
  }

  async remove(id: string): Promise<ProviderSaveResult> {
    const loaded = await this.readRawProviders();
    if (!loaded.ok) {
      return {
        ok: false,
        errors: [{ field: "models.json", message: `当前 models.json 无法解析，拒绝写入：${loaded.error}` }],
      };
    }
    const nextProviders = new Map(loaded.providers);
    nextProviders.delete(id);
    const write = await this.validateAndWrite(nextProviders);
    if (!write.ok) return { ok: false, errors: write.errors };
    const fresh = await this.list();
    return { ok: true, providers: fresh.providers, parseError: fresh.parseError };
  }

  private parseAdvancedJson(
    text: string | null | undefined,
    field: string,
    errors: FieldError[],
  ): Record<string, unknown> | null | undefined {
    if (text === undefined || text === null) return undefined;
    if (text.trim() === "") return null;
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isRecord(parsed)) throw new Error("not an object");
      return parsed;
    } catch {
      errors.push({ field, message: `${field} 必须是可解析的 JSON 对象` });
      return undefined;
    }
  }

  private mergeProvider(
    existing: RawProvider | undefined,
    input: ProviderSaveInput,
    compat: Record<string, unknown> | null | undefined,
    modelOverrides: Record<string, unknown> | null | undefined,
  ): RawProvider {
    const next: RawProvider = { ...(existing ?? {}) };

    if (input.name === null) delete next.name;
    else if (input.name !== undefined) next.name = input.name;

    if (input.baseUrl === null || input.baseUrl === "") delete next.baseUrl;
    else if (input.baseUrl !== undefined) next.baseUrl = input.baseUrl;

    if (input.api === null || input.api === "") delete next.api;
    else if (input.api !== undefined) next.api = input.api;

    if (input.removeAuth) {
      delete next.apiKey;
      delete next.oauth;
    } else if (typeof input.newApiKey === "string" && input.newApiKey.length > 0) {
      next.apiKey = input.newApiKey;
      delete next.oauth;
    } else if (input.oauthRadius === true) {
      next.oauth = "radius";
      delete next.apiKey;
    }

    if (compat !== undefined) {
      if (compat === null) delete next.compat;
      else next.compat = compat;
    }
    if (modelOverrides !== undefined) {
      if (modelOverrides === null) delete next.modelOverrides;
      else next.modelOverrides = modelOverrides;
    }

    const previousModels = new Map<string, RawModel>();
    for (const model of Array.isArray(existing?.models) ? (existing?.models as unknown[]) : []) {
      if (isRecord(model) && typeof model.id === "string") previousModels.set(model.id, model);
    }
    next.models = (input.models ?? []).map((model) => {
      const previous = previousModels.get(model.id) ?? {};
      const mergedModel: RawModel = { ...previous, id: model.id };
      const assign = (key: string, value: unknown, allowedNull: boolean) => {
        if (value === null) {
          if (allowedNull) delete mergedModel[key];
          return;
        }
        if (value !== undefined && value !== "") mergedModel[key] = value;
        else if (value === "" && allowedNull) delete mergedModel[key];
      };
      assign("name", model.name, true);
      assign("api", model.api, true);
      assign("baseUrl", model.baseUrl, true);
      if (model.reasoning === null) delete mergedModel.reasoning;
      else if (model.reasoning !== undefined) mergedModel.reasoning = model.reasoning;
      assign("contextWindow", model.contextWindow, true);
      assign("maxTokens", model.maxTokens, true);
      return mergedModel;
    });
    const mergedModels = next.models as RawModel[];
    if (mergedModels.length === 0) delete next.models;
    return next;
  }

  private async validateAndWrite(
    providers: Map<string, RawProvider>,
  ): Promise<{ ok: true } | { ok: false; errors: FieldError[] }> {
    const document = {
      providers: Object.fromEntries([...providers.entries()].map(([id, value]) => [id, value])),
    };
    const temporary = `${this.path}.tmp-${randomUUID()}`;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFile(temporary, stableJson(document), { mode: 0o600 });
    try {
      const candidate = await ModelConfig.load(temporary);
      const error = candidate.getError();
      if (error) {
        await rm(temporary, { force: true });
        return { ok: false, errors: [{ field: "models.json", message: `Pi 拒绝该配置：${error}` }] };
      }
      await rename(temporary, this.path);
      return { ok: true };
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}
