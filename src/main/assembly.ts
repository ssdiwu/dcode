// 装配：普通启动按 provider-directory.json 的当前选择构造真实后端；缺凭据/无记录退 unavailable。
// 显式隔离验证装配（mock / pi-controlled）必须有独立 DCODE_STATE_DIR，不继承正常数据。
// 预设供应商目录（builtin 42 家）与公共目录服务在这里建立一次，main 持有引用。
import { tmpdir } from "node:os";
import { resolve as resolvePath, sep as pathSep } from "node:path";
import { MockExecutionBackend, sampleState } from "@/adapters/mock";
import { createPiBackend } from "@/adapters/pi";
import {
  ProviderDirectoryStore,
  ProviderCatalogService,
  registerPresetProviders,
  createBackendFromSelection,
  unavailableBackend,
  modelSetupStoreFactory,
  DEFAULT_CATALOG_BASE_URL,
  PiCapabilityPort,
  PiQuotaPort,
  credentialAccountKey,
  CUSTOM_PROVIDER_ID,
  controlledModelName,
  CONTROLLED_SOURCE_A,
  CONTROLLED_SOURCE_B,
  CONTROLLED_MODEL_A,
  CONTROLLED_MODEL_B,
} from "@/adapters/pi";
import type { CredentialCipher } from "@/adapters/pi";
import type { BackendFactoryDependencies, ConfiguredSourceModels } from "@/adapters/pi";
import { builtinCatalogGeneratedAt } from "@/adapters/pi";
import type { ExecutionBackend, ModelSourceEntry, ModelSourcePort, SessionModelRegistryDeps } from "@/application";
import type { SdkRequestAdmissionGate } from "@/application";
import type { ProviderDirectoryRecord, VerifiedModelCapabilities } from "@/contracts";
import { CUSTOM_SOURCE_ID } from "@/contracts";

/** 测试 seam 仅限显式装配：环变量带 dcode-e2e- 前缀且要求独立状态目录（见 launchPresetLoopback）。 */
export const PRESET_LOOPBACK_ENV = "DCODE_E2E_PRESET_BASE_URLS";

export interface AssembledExecution {
  backend: ExecutionBackend;
  initialState: (() => ReturnType<typeof sampleState>) | undefined;
  /** 普通启动的目录服务（验证装配为 null）；main 据此挂 login/catalog IPC */
  catalog: ProviderCatalogService | null;
  directoryStore: ProviderDirectoryStore | null;
  backendDeps: BackendFactoryDependencies | null;
  /** 目录服务的 fetch 注入（测试 fixture 用）；无注入走真实网络 */
  /** D 片：会话模型选择的端口装配（能力资料／额度事实／来源目录）。
   *  验证装配（mock / pi-controlled）没有模型目录，返回 null —— 界面如实呈现「本实例无模型目录」。 */
  modelRouting: SessionModelRegistryDeps | null;
  /** 额度端口（普通装配才建）：读取服务商真实响应头回报的额度事实 */
  quotaPort: PiQuotaPort | null;
  /**
   * 挂上「每次 SDK 请求前」的准入门（普通装配才建）。
   *
   * 用转发口而不是事后赋值：启动后端在应用层建好之前就已经装配完，
   * 事后改 deps 上的字段不会到达那一条已建好的通路——请求前准入必须真的生效。
   */
  setRequestAdmission: ((gate: SdkRequestAdmissionGate) => void) | null;
}

/**
 * 模型来源目录端口：直接读既有目录服务，不新建第二份目录。
 * 读取只给「有哪些来源与模型」；能力资料与额度另走各自端口，不在这里混算。
 */
/**
 * 模型来源目录端口：读**既有**目录服务与既有持久记录，不新建第二份目录。
 *
 * 预设供应商走 catalog.view()；**自定义接入走同一个口子**（它同样可以出现在候选名单里、
 * 同样按 providerId 隔离凭据），来源标识用 `user-defined`，模型标识用其真实 modelId。
 * 读取只给「有哪些来源和模型」；能力资料与额度另走各自端口，不在这里混算。
 */
function modelSourcePortFrom(
  catalog: ProviderCatalogService,
  directoryStore: ProviderDirectoryStore,
  /** 已读出的目录记录：交互装配启动时手上就有，不必为列来源再读一次盘 */
  cachedRecord: () => ProviderDirectoryRecord | null = () => null,
): ModelSourcePort {
  return {
    hasTypedModel: async ({ sourceId, modelId, type }): Promise<boolean> => {
      const record = await directoryStore.read().catch(() => null);
      const preset = catalog.preset(sourceId);
      return record?.credentials[sourceId] !== undefined && preset !== undefined
        && (preset.provider.getAllModels?.() ?? []).some(model => model.type === type && model.provider === sourceId && model.id === modelId);
    },
    list: async (): Promise<readonly ModelSourceEntry[]> => {
      const view = await catalog.view();
      // 凭据存在性只读「是否已存加密凭据」这一个事实，不读凭据正文参与目录。
      const record = await directoryStore.read().catch(() => cachedRecord());
      const sources: ModelSourceEntry[] = view.providers.map((p) => ({
        sourceId: p.id,
        sourceLabel: p.name,
        configured: record !== null && record.credentials[p.id] !== undefined,
        models: (view.models[p.id] ?? []).map((m) => ({ modelId: m.id, modelLabel: m.name })),
      }));
      // 自定义接入**独立保留**：当前选中的是别的来源时，它仍然有效、可被会话选中，
      // 目录里也要列出来（此前只在 current.kind==='custom' 时才列，会话就选不到它）。
      const definition = record?.customDefinition;
      if (definition) {
        sources.push({
          sourceId: CUSTOM_SOURCE_ID,
          sourceLabel: definition.label,
          configured: record?.credentials[CUSTOM_SOURCE_ID] !== undefined,
          models: [{ modelId: definition.modelId, modelLabel: definition.modelId }],
        });
      }
      return sources;
    },
  };
}

/**
 * 受控装配的模型路由依赖：来源目录就是两个受控来源。
 *
 * 能力来自受控模型**自己声明**的资料（容量、模态、逐档思考语义），额度则确实没有来源 ——
 * 界面据此如实呈现「未读到额度」，不把别的来源算成它们能用，也不为受控模型编造账户额度。
 */
const CONTROLLED_CAPABILITIES: VerifiedModelCapabilities[] = (() => {
  const build = (sourceId: string, sourceLabel: string, modelId: string, modelLabel: string) => ({
    identity: { sourceId, modelId, sourceLabel, modelLabel, accountLabel: null },
    contextWindow: 32768,
    maxTokens: 1024,
    input: ["text"] as ("text" | "image")[],
    thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const,
    thinkingNote: null,
    supports: {
      "code-edit": { supported: true, evidence: "catalog" as const, reason: null },
      "tool-use": { supported: true, evidence: "catalog" as const, reason: null },
      // 已核实（catalog）时不得再挂"无依据"说明：不支持本身就是核实结论
      "image-input": { supported: false, evidence: "catalog" as const, reason: null },
      "long-context": { supported: true, evidence: "catalog" as const, reason: null },
      reasoning: { supported: true, evidence: "catalog" as const, reason: null },
    },
  });
  return [
    build(CONTROLLED_SOURCE_A, "受控来源 A（本地确定性模型）", CONTROLLED_MODEL_A, controlledModelName),
    build(CONTROLLED_SOURCE_B, "受控来源 B（本地确定性模型）", CONTROLLED_MODEL_B, `${controlledModelName}（第二来源）`),
  ];
})();
function controlledModelRouting(): SessionModelRegistryDeps {
  const sourcePort: ModelSourcePort = {
    list: async (): Promise<readonly ModelSourceEntry[]> => [
      {
        sourceId: CONTROLLED_SOURCE_A,
        sourceLabel: "受控来源 A（本地确定性模型）",
        // 受控来源的凭据是进程内提供的：它确实可调用，如实标为已配置
        configured: true,
        models: [{ modelId: CONTROLLED_MODEL_A, modelLabel: controlledModelName }],
      },
      {
        sourceId: CONTROLLED_SOURCE_B,
        sourceLabel: "受控来源 B（本地确定性模型）",
        configured: true,
        models: [{ modelId: CONTROLLED_MODEL_B, modelLabel: `${controlledModelName}（第二来源）` }],
      },
    ],
  };
  return {
    sourcePort,
    // 受控模型逐档声明了思考语义与容量：能力端口据此**真实核实**，而不是一律「未核实」。
    capabilityPort: {
      read: async ({ sourceId, modelId }) => {
        const found = CONTROLLED_CAPABILITIES.find((m) => m.identity.sourceId === sourceId && m.identity.modelId === modelId);
        return found ?? null;
      },
    },
    quotaPort: {
      support: () => ({}),
      read: async ({ candidates }) => candidates.map((c) => ({
        sourceId: c.sourceId,
        modelId: c.modelId,
        state: "unsupported" as const,
        poolId: null,
        windowLabel: null,
        updatedAt: null,
        reason: "受控装配没有账户额度来源",
      })),
    },
  };
}

function parseBaseUrlOverrides(env: Record<string, string | undefined>): Record<string, string> | undefined {
  const raw = env[PRESET_LOOPBACK_ENV];
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string" && /^https?:\/\//.test(v)) out[k] = v;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/** 显式 loopback 装配的前置核对：独立状态目录（真实临时隔离目录，非默认开发数据目录）+ 明确验证标识；
 *  任一缺失直接拒绝（不能把真实开发数据目录的供应商端点改到 loopback）。 */
export function assertLoopbackAllowed(env: Record<string, string | undefined>, stateDir: string): void {
  const raw = env[PRESET_LOOPBACK_ENV];
  if (raw === undefined) return;
  if (!env.DCODE_STATE_DIR) throw new Error("preset-loopback-requires-isolated-state");
  if (env.DCODE_E2E !== "1") throw new Error("preset-loopback-requires-e2e-marker");
  const tmp = env.DCODE_E2E_STATE_ROOT ?? tmpdir();
  const resolvedState = resolvePath(stateDir);
  const resolvedTmp = resolvePath(tmp);
  if (!resolvedState.startsWith(resolvedTmp + pathSep) && resolvedState !== resolvedTmp) {
    throw new Error("preset-loopback-requires-temp-isolated-state");
  }
}

/** 从持久记录推导后端：custom → 旧自定义通路；preset → 同一 resolver（builtin 模板/anchor 新线上模型）；缺凭据/未知 → unavailable。 */
/**
 * 当前**生效**的执行后端来源集合（启动与交互共用同一份事实）。
 *
 * 交互路径（切换模型后重建后端）此前用的是原始 `backendDeps`，只有当前来源一个模型；
 * 启动路径才注入全部已配置来源。两者不一致会让"改配置后的下一次请求"找不到身份。
 * 这里把解析集中到一处，两条路径共用。
 */
export async function resolveConfiguredSources(
  record: ProviderDirectoryRecord | null,
  deps: BackendFactoryDependencies,
  catalog: ProviderCatalogService | null,
): Promise<readonly ConfiguredSourceModels[]> {
  return configuredSourceModels(record, deps, catalog);
}

/**
 * 目录里**已配置**（有凭据记录）来源的可请求模型集合。
 *
 * 只有已配置且目录能解析出本地权威模型的来源才登记：Pi 的模型表按 provider+modelId 解析身份，
 * 没登记的身份在改选后会解析不到。解析不出来就不登记——不凭空造一个"看起来能用"的来源。
 */
async function configuredSourceModels(
  record: ProviderDirectoryRecord | null,
  deps: BackendFactoryDependencies,
  catalog: ProviderCatalogService | null,
): Promise<ConfiguredSourceModels[]> {
  if (!catalog || !record) return [];
  const out: ConfiguredSourceModels[] = [];
  const view = await catalog.view();
  // 全量集合（含当前来源自身）：启动与交互两条装配共用这一份解析，
  // 当前来源的其它模型也必须在里面，否则同源改选解析不到身份。
  for (const providerId of Object.keys(record.credentials)) {
    const preset = deps.presets.find((p) => p.id === providerId);
    if (preset) {
      // 该来源下被目录解析出本地权威模型的条目：改选到同源的另一个模型也要真能请求。
      const models = (view.models[providerId] ?? [])
        .map((m) => catalog.resolveExecutable(providerId, m.id))
        .filter((r): r is NonNullable<typeof r> => r !== null && r.executable && r.model !== null)
        .map((r) => {
          const override = deps.baseUrlOverrides?.[providerId];
          return (override ? { ...r.model, baseUrl: override } : r.model) as never;
        });
      if (models.length > 0 || (preset.provider.getAllModels?.() ?? []).some(model => model.type === 'classifier' || model.type === 'image')) out.push({ kind: "preset", providerId, preset, models });
      continue;
    }
    // 保留下来的自定义接入：当前选中别的来源时它仍然有效，会话选中它也要真能请求。
    const definition = record.customDefinition;
    if (providerId === CUSTOM_PROVIDER_ID && definition) {
      out.push({
        kind: "custom",
        providerId,
        config: {
          provider: definition.provider,
          label: definition.label,
          modelId: definition.modelId,
          baseUrl: definition.baseUrl,
        },
      });
    }
  }
  return out;
}

/**
/** 一个已登记模型的身份资料。 */
type RegisteredModelIdentity = { sourceLabel: string; modelLabel: string; custom: boolean; baseUrl: string };
/** 来源 → 模型 → 身份资料（两级 Map：id 里含任何字符都不会把两对来源/模型撞成同一个键）。 */
type RegisteredIdentities = ReadonlyMap<string, ReadonlyMap<string, RegisteredModelIdentity>>;

/**
 * 已登记的可请求身份（Pi 侧真正注册的那一批）：能力端口的「用户已配置」依据与自定义身份都取自这里。
 *
 * 不按「有没有这条凭据」或「界面现在选了哪个」去猜：凭据存在只说明该来源可认证，不说明**这个模型**已登记；
 * 反过来，目录里没被解析出本地权威模型的条目也不会登记。判据与实际请求用的是同一份集合。
 */
function configuredIdentities(sources: readonly ConfiguredSourceModels[]): RegisteredIdentities {
  const out = new Map<string, Map<string, RegisteredModelIdentity>>();
  const put = (providerId: string, modelId: string, value: RegisteredModelIdentity): void => {
    const bucket = out.get(providerId) ?? new Map<string, RegisteredModelIdentity>();
    bucket.set(modelId, value);
    out.set(providerId, bucket);
  };
  for (const source of sources) {
    if (source.kind === "preset") {
      for (const model of source.models) {
        put(source.providerId, model.id, {
          sourceLabel: source.preset.name,
          modelLabel: model.name ?? model.id,
          custom: false,
          baseUrl: model.baseUrl,
        });
      }
      continue;
    }
    put(source.providerId, source.config.modelId, {
      sourceLabel: source.config.label,
      modelLabel: source.config.modelId,
      custom: true,
      baseUrl: source.config.baseUrl,
    });
  }
  return out;
}

/** 查某个身份是否真被登记：只有登记过的（来源，模型）才算「用户已配置」。 */
function registeredIdentity(
  identities: RegisteredIdentities,
  sourceId: string,
  modelId: string,
): RegisteredModelIdentity | null {
  return identities.get(sourceId)?.get(modelId) ?? null;
}

async function backendFromRecord(
  record: ProviderDirectoryRecord | null,
  deps: BackendFactoryDependencies,
  catalog: ProviderCatalogService | null,
): Promise<ExecutionBackend> {
  const current = record?.current;
  if (!current) return unavailableBackend;
  if (current.kind === "custom") {
    if (record?.credentials["user-defined"] === undefined) return unavailableBackend;
    // 冷启动也要登记**其余已配置来源**：自定义接入是当前来源时，已保存凭据的预设供应商
    // 仍然可被会话选中并真的发请求。缺这一步就只有交互重建那条路有集合，冷重开后失效。
    const additionalSources = await configuredSourceModels(record, deps, catalog);
    return createBackendFromSelection({
      kind: "custom",
      provider: current.provider,
      label: current.label,
      modelId: current.modelId,
      baseUrl: current.baseUrl,
    }, { ...deps, additionalSources });
  }
  if (record?.credentials[current.providerId] === undefined) return unavailableBackend;
  if (!catalog) return unavailableBackend;
  const resolution = await catalog.resolveAfterRefresh(current.providerId, current.modelId);
  if (!resolution || !resolution.executable || !resolution.model) return unavailableBackend;
  const additionalSources = await configuredSourceModels(record, deps, catalog);

  return createBackendFromSelection(
    {
      kind: "preset",
      providerId: current.providerId,
      modelId: current.modelId,
      model: resolution.model as never,
      info: resolution.info,
    },
    { ...deps, additionalSources },
  );
}

export async function assembleExecution(env: Record<string, string | undefined>, stateDir: string, cipher?: CredentialCipher): Promise<AssembledExecution> {
  const selection = env.DCODE_VALIDATION_ASSEMBLY;
  // 显式空字符串视为未设置：测试可覆盖 helpers 里注入的默认 mock，改走普通装配
  const effectiveSelection = selection && selection.length > 0 ? selection : undefined;
  if (effectiveSelection && effectiveSelection !== "mock" && effectiveSelection !== "pi-controlled") throw new Error("invalid-validation-assembly");
  if (effectiveSelection && !env.DCODE_STATE_DIR) throw new Error("validation-state-directory-required");
  assertLoopbackAllowed(env, stateDir);

  if (effectiveSelection === "pi-controlled") {
    return {
      backend: createPiBackend({
        stateDir,
        demoDir: env.DCODE_DEMO_DIR ?? null,
        gated: env.DCODE_PI_GATE === "1",
        // 第二轮工具回合只用于受控夹具的「运行中改选」场景；须同时满足受控装配与独立状态目录。
        secondToolRound: env.DCODE_E2E_SECOND_TOOL_ROUND === "1",
      }),
      initialState: env.DCODE_VALIDATION_SAMPLE === "1" ? sampleState : undefined,
      catalog: null,
      directoryStore: null,
      backendDeps: null,
      setRequestAdmission: null,
      // 受控装配的来源目录就是它真实的两个受控来源（都经真实 Pi SDK 调用，只是不连真实服务商）：
      // 不用"无目录"掩盖，也不用目录里的其它来源冒充它们可切换。
      modelRouting: controlledModelRouting(),
      quotaPort: null,
    };
  }
  if (effectiveSelection === "mock") {
    return {
      backend: new MockExecutionBackend({
        timescale: env.DCODE_MOCK_FAST === "1" ? 0.12 : 1,
        injectUnknownOnce: env.DCODE_MOCK_UNKNOWN_ONCE === "1",
        dropReceiptOnce: env.DCODE_MOCK_DROP_RECEIPT_ONCE === "1",
        closeFails: env.DCODE_MOCK_CLOSE_FAIL === "1",
      }),
      initialState: env.DCODE_VALIDATION_SAMPLE === "1" ? sampleState : undefined,
      catalog: null,
      directoryStore: null,
      backendDeps: null,
      setRequestAdmission: null,
      modelRouting: null,
      quotaPort: null,
    };
  }

  // 普通启动（含显式 loopback 装配）：builtin 供应商 + 目录服务 + 按当前记录构造后端
  if (!cipher) {
    return { backend: unavailableBackend, initialState: undefined, catalog: null, directoryStore: null, backendDeps: null, modelRouting: null, quotaPort: null, setRequestAdmission: null };
  }
  const baseUrlOverrides = parseBaseUrlOverrides(env);
  const presets = registerPresetProviders();
  const resolvedCatalogBaseUrl = env.DCODE_CATALOG_BASE_URL && /^https?:\/\//.test(env.DCODE_CATALOG_BASE_URL)
    ? env.DCODE_CATALOG_BASE_URL
    : DEFAULT_CATALOG_BASE_URL;
  /**
   * 当次已登记的可请求身份：每次读取都按**此刻**的目录记录与目录服务重新解析。
   *
   * 不用启动时的快照——设置里新增/移除来源、或目录出现新线上模型之后，快照会与执行端
   * 实际能请求的集合说成两套，能力资料与账户端点就会按旧集合作答。
   */
  const registeredIdentitiesNow = async (): Promise<RegisteredIdentities> => configuredIdentities(
    await resolveConfiguredSources(await directoryStore.read().catch(() => null), deps, catalog),
  );
  let quotaPort: PiQuotaPort | null = null;
  const directoryStore = new ProviderDirectoryStore(
    { stateDir },
    cipher,
    { catalogBaseUrl: resolvedCatalogBaseUrl },
    // 凭据提交（含换 key／清除／登录完成）即让该来源的旧额度观测失效：
    // 旧数字属于上一个身份，不能留给新身份读。写盘失败不通知（凭据没变，见 store 内部说明）。
    { onCredentialCommitted: (providerId) => { quotaPort?.invalidateSource(providerId); } },
  );
  // 普通装配：catalog service 的默认目录源必须与 store 同源（否则空记录时 service 内存默认 pi.dev、store 空 record 用 env URL，source guard 不匹配首次提交）
  const catalog = new ProviderCatalogService({
    store: directoryStore,
    presets,
    builtinGeneratedAt: builtinCatalogGeneratedAt(),
    defaultBaseUrl: resolvedCatalogBaseUrl,
  });
  const legacyStore = modelSetupStoreFactory(stateDir, cipher);
  // 额度读取端口：接**服务商真实响应头**（权威剩余额度、窗口与共享池），不发额外请求、不需要新权限。
  // 读取时带上该来源**当前绑定身份**的指纹，只认同一身份下的观测（换过 key 不会读出上一账户的剩余）。
  quotaPort = new PiQuotaPort({
    resolveAccountKey: async ({ sourceId, modelId }) => {
      const identity = registeredIdentity(await registeredIdentitiesNow(), sourceId, modelId);
      const credential = await directoryStore.readCredential(sourceId).catch(() => undefined);
      // 只有 api_key 能与观测端算出同一身份：观测用的是本次请求真正用的 key（opts.apiKey）。
      // OAuth 读不到与观测端共同的密钥材料，如实不给身份，而不是给一个可能对不上的猜测。
      const key = (credential as { type?: unknown; key?: unknown } | undefined)?.type === "api_key"
        ? (credential as { key?: unknown }).key
        : undefined;
      return typeof key === "string" && key !== ""
        ? credentialAccountKey(key, identity?.baseUrl ?? "")
        : undefined;
    },
  });
  // 请求前准入的转发口：应用层稍后才提供真正的门，请求发生时读的是**当次**那一个。
  const requestAdmission: { gate?: SdkRequestAdmissionGate } = {};
  const deps: BackendFactoryDependencies = {
    stateDir,
    cipher,
    legacyStore,
    directoryStore,
    presets,
    baseUrlOverrides,
    // 每次真实响应到达时把服务商回报的额度事实交给端口；观察失败不牵连真实请求。
    observeQuota: (observation) => { quotaPort?.observe(observation); },
    // 工具回合自己发起的下一次请求也要按当次事实核：额度、能力依据、候选范围、认证在途与暂停。
    admitRequest: async (request) => (requestAdmission.gate ? requestAdmission.gate(request) : { ok: true, reason: null, target: null }),
  };
  let record: ProviderDirectoryRecord | null = null;
  try {
    record = await directoryStore.read();
  } catch {
    // 目录读取失败：unavailable 启动；界面读错由 catalog 视图与保存层据实呈现
  }
  await catalog.init().catch(() => undefined);
  const backend = await backendFromRecord(record, deps, catalog);
  // D 片装配：能力资料读 Pi 内置目录的逐模型字段；额度端口无真实来源 → 如实 unsupported。
  // 两者都只在普通装配（已有目录服务）建立，不为验证装配另造一份模型事实。
  const modelRouting: SessionModelRegistryDeps = {
    capabilityPort: new PiCapabilityPort({
      presets,
      // 自定义接入按它自己的身份给「未核实」形状，不借用同名预设的资料
      customIdentity: async ({ sourceId, modelId }) => {
        const found = registeredIdentity(await registeredIdentitiesNow(), sourceId, modelId);
        return found && found.custom
          ? { sourceId, modelId, sourceLabel: found.sourceLabel, modelLabel: found.modelLabel, accountLabel: null }
          : null;
      },
      configuredCandidates: async ({ sourceId, modelId }) => registeredIdentity(await registeredIdentitiesNow(), sourceId, modelId) !== null,
      // 内置目录查不到的线上新 ID：按**当次**有效解析取同一份本地权威模板，
      // 不另建目录快照，也不因为只查内置就把能请求的模型判成查不到资料。
      effectiveModel: async ({ sourceId, modelId }) => {
        const resolved = catalog?.resolveExecutable(sourceId, modelId) ?? null;
        return resolved?.executable === true && resolved.model !== null ? (resolved.model as never) : null;
      },
      effectiveLabel: async ({ sourceId, modelId }) => {
        const resolved = catalog?.resolveExecutable(sourceId, modelId) ?? null;
        return resolved?.info.name ?? null;
      },
    }),
    quotaPort,
    sourcePort: modelSourcePortFrom(catalog, directoryStore, () => record),
  };
  return {
    backend,
    initialState: undefined,
    catalog,
    directoryStore,
    backendDeps: deps,
    modelRouting,
    quotaPort,
    setRequestAdmission: (gate) => { requestAdmission.gate = gate; },
  };
}
