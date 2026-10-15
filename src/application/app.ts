// D Code 应用层：工作空间／任务／会话归属与运行协调。
// 状态唯一写入者；通过注入的执行后端与存储适配器工作，不反向引用具体实现。
// 执行端只认 ExecutionBackend（一次运行只装配 mock 或 Pi 之一）；
// 时间线块由 read() 的 entries 在投影层统一投影，renderer 不接触执行端类型。

import type {
  AppSnapshot,
  AppIssue,
  RunIssue,
  RunState,
  SendReceipt,
  SendResult,
  Session,
  SessionModelChoice,
  SessionModelState,
  Settings,
  Task,
  ThinkingLevel,
  TimelineBlock,
  WorkCapability,
  WorkUsage,
  Workspace,
  ProjectFolderSelection,
  ModelIdentity,
} from "@/contracts";
import type { ModelSourcesView, QuotaFacts, SetDefaultModelChoiceResult, TaskUsageBySource, TaskUsageScopeEntry, TaskUsageSummary } from "@/contracts";
import type {
  ControlToken,
  ExecutionBackend,
  ExecutionTarget,
  ExecutionView,
  PersistedState,
  ExecutionPort,
  StorageAdapter,
} from "./types";
import { seedState } from "./seed";
import { CUSTOM_SOURCE_ID, toSendReceipt, validateOperationInput } from "@/contracts";
import { parseWorkReferences, toReferenceSummary } from "@/contracts";
import type { CaptureReferenceInput, ListReferencesInput, ProviderDirectoryRecord, ReferenceListing, ReferenceSummary, WorkReference } from "@/contracts";
import type { ReferencePort, ReferenceRequest, SdkRequestTarget, ProjectFolderPort } from "./ports";
import { fitsCapabilities, unverifiedRequirements } from "./model-router";
import { SessionModelRegistry } from "./session-models";
import type { RoutingWorkContext, SessionModelRegistryDeps } from "./session-models";

/** 原子提交所需的扩展接口：主进程装配把 ProviderDirectoryStore 作为本接口注入；应用层不感知 fs/cipher。 */
export interface ProviderDirectoryPort {
  read(): Promise<ProviderDirectoryRecord | null>;
  commitCustomSetup(input: {
    provider: "openai-completions" | "anthropic-messages";
    label: string;
    modelId: string;
    baseUrl: string;
    note: "ready" | "auth-failed" | "auth-unverified" | "connect-failed";
    keyAction: "replace" | "keep" | "clear";
    apiKey?: string;
  }): Promise<ProviderDirectoryRecord>;
  commitPresetSelection(input: {
    providerId: string;
    modelId: string;
    note: "ready" | "auth-failed" | "auth-unverified" | "connect-failed";
  }): Promise<ProviderDirectoryRecord>;
}

/** applyModel(preset) 校验所需的目录查询（main 注入；应用层不感知 SDK/builtin）。 */
export interface PresetLookupPort {
  /** 供应商是否登记（Pi builtin 身份） */
  hasProvider(providerId: string): boolean;
  /** 供应商显示名（Pi 正式身份） */
  providerName(providerId: string): string | null;
  /** 供应商支持的认证方式 */
  authKinds(providerId: string): ReadonlyArray<"api_key" | "oauth">;
  /** 目录中该模型的安全视图（**sync**，用于 modelSetupSnapshot 显示链）；applyModel 的严格校验用 modelAsync。 */
  model(providerId: string, modelId: string): { id: string; name: string } | null;
  /** applyModel(preset) 严格校验：真实持久读盘 async，避免 store.modify 后未及时刷内存即放行错误目录条目。 */
  modelAsync(providerId: string, modelId: string): Promise<{ id: string; name: string } | null>;
}

let counter = 0;
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

const POLL_MS = 500;

/**
 * 按历史留存的身份字段复原引用集合（正文留空）。
 * 只用于只读回查：判重只看 kind/定位/快照哈希，不依赖源文件是否仍然存在，
 * 更不会把这些占位内容当正文送去执行（执行端的完整性校验只在 submit 上跑）。
 */
function identityOnlyReferences(summaries: readonly ReferenceSummary[] | undefined): readonly WorkReference[] {
  return (summaries ?? []).map((summary) => ({
    refId: summary.refId,
    kind: summary.kind,
    label: summary.label,
    locator: summary.locator,
    sourceId: summary.sourceId,
    snapshot: { ...summary.snapshot, content: "" },
  }));
}

export class DCodeApplication {
  private state: PersistedState;
  private currentBackend: ExecutionBackend;
  private readonly storage: StorageAdapter;
  private readonly initialState: () => PersistedState;
  private readonly diagnose: (event: string, cause: unknown) => void;
  private readonly modelSetupStore: ProviderDirectoryPort | null;
  /** preset 目录查询；applyModel(preset) 的 provider/model/auth 校验依据（无 preset 能力的实例为 null） */
  private readonly presetLookup: PresetLookupPort | null;
  /** 由 main 注入：根据已确认选择构造新 backend（**允许 async**：preset 分支需 await 目录 resolveAfterRefresh
   *  真实读盘拿到最新线上元数据）；不再负责凭据（凭据由 store 统一提交）。
   *  custom：与保存同形状的字段输入；preset：providerId/modelId（main 侧按目录补全模型对象）。 */
  private readonly modelSetupBackendFactory?: (
    selection:
      | { kind: "custom"; provider: "openai-completions" | "anthropic-messages"; label: string; modelId: string; baseUrl: string }
      | { kind: "preset"; providerId: string; modelId: string },
  ) => ExecutionBackend | Promise<ExecutionBackend>;
  /** 会话模型状态（选择方式／实际执行模型／路由尝试）的唯一写入者。
   *  state.sessionModels 只是**持久化与快照的投影**，每次使用前从注册表重取，不作事实来源。 */
  private readonly sessionModels: SessionModelRegistry;
  private readonly listeners = new Set<(snapshot: AppSnapshot) => void>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  // 执行端运行态（不持久化）：端口、最近控制令牌、投影游标与视图新鲜度记录。
  // 首发在途关联不在此列——它必须随 state 持久化，重开后才能复用同一对象与操作身份。
  private readonly ports = new Map<string, Promise<ExecutionPort>>();
  private readonly controls = new Map<string, ControlToken>();
  private readonly views = new Map<string, { instanceId: string; observation: number }>();
  private readonly projectedThrough = new Map<string, number>();
  private readonly syncing = new Set<string>();
  private readonly runtimeCreationSaves = new Map<string, Promise<boolean>>();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private flushPromise: Promise<void> | null = null;
  // 关闭意图先同步认领；保存/端口收束 promise 只记录其后真实完成结果。
  private closingStarted = false;
  private closeError: AppIssue | null = null;
  private closeErrorRevision = 0;
  private dirty = false;
  // 设置和绑定保存均按次认领；在途写盘受 stateSaveFlights 保护，
  // 统一延迟落盘所说的旧快照在此期间不入队，flush/persistNow 也先等它们**全部**收束。
  // 必须按次登记而不是记一个"当前在途"：单字段会被先完成的后来者覆盖或清空，
  // 关闭收束就只看得到最后一个写盘——先开始的那次反而没人等。
  private stateSaveQueue: Promise<unknown> | null = null;
  private readonly workspaceFlights = new Map<string, Promise<Workspace>>();
  private readonly unknownWorkspaceBindings = new Map<string, { workspace: Workspace; task: Task; selectionId: string; name: string }>();
  private settingsSeq = 0;
  private readonly stateSaveFlights = new Set<Promise<unknown>>();

  constructor(
    currentBackend: ExecutionBackend,
    storage: StorageAdapter,
    initialState: () => PersistedState = seedState,
    diagnose: (event: string, cause: unknown) => void = () => undefined,
    modelSetupStore: ProviderDirectoryPort | null = null,
    modelSetupBackendFactory?: (
      selection:
        | { kind: "custom"; provider: "openai-completions" | "anthropic-messages"; label: string; modelId: string; baseUrl: string }
        | { kind: "preset"; providerId: string; modelId: string },
    ) => ExecutionBackend | Promise<ExecutionBackend>,
    presetLookup: PresetLookupPort | null = null,
    /** 引用读取端口（文件／技能发现与快照）。无该能力的实例照常运行，只是不提供引用入口。 */
    private readonly referencePort: ReferencePort | null = null,
    /** D 片模型能力／额度／来源目录端口。缺席 = 资料未核实或没有额度来源，按如实态呈现，不补造。 */
    modelRoutingDeps: SessionModelRegistryDeps | null = null,
    private readonly projectFolders: ProjectFolderPort | null = null,
  ) {
    // null = 本实例没有模型目录（如隔离验证装配）：注册表照常存在，但来源为空、能力未核实、
    // 额度无来源，界面据此如实呈现，不造灰入口或示例数据当完成。
    this.sessionModels = new SessionModelRegistry({
      ...(modelRoutingDeps ?? {}),
      // 候选范围唯一依据是**用户设置的名单**；名单为空时自动模式没有范围，不会退化成目录全部。
      allowlist: (identity) => this.state.settings.modelCandidates.some(
        (c) => c.sourceId === identity.sourceId && c.modelId === identity.modelId,
      ),
      diagnose,
    });
    this.currentBackend = currentBackend;
    this.storage = storage;
    this.initialState = initialState;
    this.diagnose = diagnose;
    this.modelSetupStore = modelSetupStore;
    this.modelSetupBackendFactory = modelSetupBackendFactory;
    this.presetLookup = presetLookup;
    this.state = this.initialState();
  }

  async init(): Promise<void> {
    const loaded = await this.storage.load();
    let maySave = true;
    if (loaded.status === "ok") {
      this.state = normalizeLegacy(loaded.state);
      // 会话模型状态的唯一事实由注册表接管；state 上的副本此后只是落盘/快照投影
      this.sessionModels.hydrate(this.state.sessionModels, this.state.settings.newSessionModelChoice);
    } else if (loaded.status === "corrupt") {
      // 损坏且已成功保全：从种子如实重启并说明；原文件在旁，可安全重写原位
      this.state = this.initialState();
      this.setCloseError("state-corrupt");
      this.diagnose("state-corrupt", loaded.error);
    } else if (loaded.status === "unreadable") {
      // 读取/保全失败：保留原文件、显式报错；种子只用于内存展示，禁止落盘覆盖
      this.state = this.initialState();
      this.setCloseError("state-unreadable");
      this.diagnose("state-unreadable", loaded.error);
      maySave = false;
    }
    // 重开只查询不执行：任何未完结的运行保持暂停并标明中断来源，等待用户显式接续
    for (const run of Object.values(this.state.runs)) {
      if (run.status === "running" || run.status === "pausing" || run.status === "paused") {
        run.status = "paused";
        run.restored = true;
        run.note = "";
        run.updatedAt = Date.now();
      }
    }
    // 启动后立即落盘一次：恢复目标失效等场景需要有一份真实存在的现场记录；
    // 读取/保全失败时跳过——不得以种子覆盖原文件
    if (maySave) {
      try {
        await this.saveState(this.persistedState());
      } catch (error) {
        this.setCloseError("initial-save-failed");
        this.diagnose("initial-save-failed", error);
      }
    }
    await this.restoreModelSetup();
    this.startPolling();
  }

  /** provider-directory.json 由 ProviderDirectoryStore 统一原子写；应用层只调接口，不感知 fs。 */
  private async readModelSetupFile(): Promise<ProviderDirectoryRecord | null> {
    if (!this.modelSetupStore) return null;
    try { return await this.modelSetupStore.read(); }
    catch (err) { this.diagnose("provider-directory-read-failed", err); return null; }
  }

  subscribe(listener: (snapshot: AppSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 持久化与快照共用的投影：会话模型状态每次从唯一写入者重取，不沿用可能过期的副本。 */
  private persistedState(): PersistedState {
    this.state.sessionModels = this.sessionModels.toRecord();
    return JSON.parse(JSON.stringify(this.state)) as PersistedState;
  }

  private snapshot(): AppSnapshot {
    const base = JSON.parse(JSON.stringify(this.persistedState())) as AppSnapshot & Partial<Omit<PersistedState, "model" | "modelSetup">>;
    // 首发在途关联是应用层内部协调状态，不通过桥暴露给界面
    delete base.pendingFirstSends;
    delete base.workspaceBindingReceipts;
    delete base.runtimeCreationPending;
    delete base.modelCandidateScopeConfigured;
    const pending = this.unknownWorkspaceBindings.entries().next().value;
    base.pendingWorkspaceCreation = pending ? { operationId: pending[0], selectionId: pending[1].selectionId,
      name: pending[1].name, path: pending[1].workspace.folders[0] } : null;
    // 可用性唯一依据：宿主实际装配 + 已配置记录里**确有凭据**（clear 后 backend 仍在但
    // 缺凭据，必须恢复「缺模型 不可发送」，不能以 label/modelName 非 null 伪解锁；配置不发网络探针验证）。
    const effectiveAvailable = this.currentBackend.modelName !== null
      && (this.modelSetupStore === null
        || this.modelSetupRecord === null
        || this.modelSetupRecord.hasKey === true);
    base.model = {
      available: effectiveAvailable,
      name: effectiveAvailable ? this.currentBackend.modelName : null,
    };
    base.modelSetup = this.modelSetupSnapshot();
    base.execution = { kind: this.currentBackend.kind };
    // 任务用量是**只读汇总**：不持久化第二份，随每次快照按当前任务归属重算，
    // 界面查看它不改变任务执行、不发送输入、不解除暂停。
    base.taskUsage = this.taskUsageSummaries();
    base.closeError = this.closeError;
    base.closeErrorRevision = this.closeErrorRevision;
    return base;
  }

  private modelSetupSnapshot(): import("@/contracts").ModelSetupStatus {
    if (!this.modelSetupRecord) return { kind: "unconfigured" };
    const { selection, hasKey } = this.modelSetupRecord;
    const note: import("@/contracts").ModelSetupNote = this.currentBackend.modelName === null ? "connect-failed" : selection.note;
    if (selection.kind === "preset") {
      const providerName = this.presetLookup?.providerName(selection.providerId) ?? selection.providerId;
      const modelName = this.presetLookup?.model(selection.providerId, selection.modelId)?.name ?? selection.modelId;
      const auth = this.presetLookup?.authKinds(selection.providerId) ?? [];
      // 已保存的自定义定义独立于当前预设保留；界面可编辑并留用原密钥（不跟 preset 混用）
      const custom = this.modelSetupRecord.customDefinition
        ? { ...this.modelSetupRecord.customDefinition, hasKey: this.modelSetupRecord.customHasKey }
        : null;
      if (custom) {
        return {
          kind: "preset-with-custom",
          preset: { providerId: selection.providerId, providerName, modelId: selection.modelId, modelName, note, hasKey, auth },
          custom,
          note,
          hasKey,
        };
      }
      return {
        kind: "preset",
        providerId: selection.providerId,
        providerName,
        modelId: selection.modelId,
        modelName,
        note,
        hasKey,
        auth,
      };
    }
    return {
      kind: "custom",
      label: selection.label,
      provider: selection.provider,
      modelId: selection.modelId,
      baseUrl: selection.baseUrl,
      note,
      hasKey,
    };
  }

  private modelSetupRecord: {
    selection: import("@/contracts").CurrentModelSelection;
    hasKey: boolean;
    /** 同一记录里的自定义定义与凭据存在性（与 selection 一致的真实落盘事实） */
    customDefinition: (ProviderDirectoryRecord["customDefinition"]) | null;
    customHasKey: boolean;
  } | null = null;

  private async restoreModelSetup(): Promise<void> {
    this.modelSetupRecord = null;
    const file = await this.readModelSetupFile();
    if (!file?.current) return;
    const hasKey = file.current.kind === "custom"
      ? file.credentials["user-defined"] !== undefined
      : file.credentials[file.current.providerId] !== undefined;
    this.modelSetupRecord = {
      selection: file.current,
      hasKey,
      customDefinition: file.customDefinition ?? null,
      customHasKey: file.credentials["user-defined"] !== undefined,
    };
  }

  // 真实模型保存的在途 Promise：不共用 settingsSaveFlight（那属于普通设置），与发送/继续接收互斥。
  private modelSetupFlight: Promise<unknown> | null = null;
  /**
   * 真实接收/执行控制的在途计数：发送/重试/回查/暂停/恢复都必须在首个 await 前登记，
   * finally 释放；configureModel 开头核对，登记存在即拒绝保存。
   * 「已暂停队列」不是接收在途，不计入；登记只覆盖真实异步阶段（persist/ensurePort/最新控制/提交）。
   */
  private receivingFlightCount = 0;

  private enterReceive(): () => void {
    this.receivingFlightCount++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.receivingFlightCount--;
    };
  }

  async configureModel(input: import("@/contracts").ModelSetupInput): Promise<import("@/contracts").ModelSetupResult> {
    // 单写 flight：整个保存流程的所有 await（含 keep 的落盘回查、backend 构造、端口收束、原子提交）
    // 都在 flight 内，避免检查与提交之间的窗口里被第二保存/新发送穿过。
    if (this.modelSetupFlight) return { ok: false, issue: "run-in-flight", message: "仍在保存上一个模型配置，请稍后再试" };
    // 关闭意图由应用同步认领；等待宿主认证/目录收束期间也不能接受新配置。
    // 已开始的 modelSetupFlight 仍由最后一次 flush 真实等待，不撤销已提交事实。
    if (this.closingStarted) return { ok: false, issue: "storage-failed", message: "应用正在关闭，无法保存配置" };
    // 认证 admission 在途（含内部 4s 窗口）：任何认证流程在途时 configureModel 不得穿入。
    // 与 send/resume 的差别在这里是实质的：configureModel/applyModel 会改写**当前选择的身份**并向
    // provider-directory.json 提交，与在途认证的凭据提交同一份物理文件；spec「认证与自定义保留」允许
    // 另一供应商按身份独立提交凭据、要求文件串行合并，但没要求在提交期间改写当前选择。
    if (this.authFlowInFlight) return { ok: false, issue: "run-in-flight", message: "认证流程进行中，请先完成或取消" };
    // 保存与真实输入接收/执行控制互斥：任何在途接收（send/retry/checkReceipt/pause/resume 的真实异步阶段）
    // 必须先收束，不能关闭其正在使用的端口。已暂停队列不算接收在途。
    if (this.receivingFlightCount > 0) return { ok: false, issue: "run-in-flight", message: "有正在接收或发送中的请求；请等当前请求完成或先保存后再试" };
    if (this.hasActiveWork()) return { ok: false, issue: "run-in-flight", message: "有正在执行或正要暂停的运行；等待当前请求结束或恢复完成后再修改" };
    if (!this.modelSetupStore || !this.modelSetupBackendFactory) return { ok: false, issue: "backend-unavailable", message: "本实例不支持动态装配服务商" };

    const store = this.modelSetupStore;
    const backendFactory = this.modelSetupBackendFactory;
    // 关键时序（2026-10-09 跨 origin 修复）：
    // 直接把 async IIFE 赋给 flight 时，其 try 内同步 return（keep 拒绝/校验失败等）会让 finally 先于
    // 外层赋值把 modelSetupFlight 重置为 null，而外层随后又把已 resolved 的 flight 赋回，
    // 永远把下一次保存当 busy。正确做法：先用 Promise.resolve().then(...) 延后执行体到下一个 microtask，
    // 同步先把 flight 引用登记到 modelSetupFlight，执行体 finally 按 flight 身份严格清除。
    const flight: Promise<import("@/contracts").ModelSetupResult> = Promise.resolve().then(async () => {
      try {
        // 字段校验先行（receive 侧已做一次；应用层复核 fail-fast）
        if (!input.label.trim() || !input.modelId.trim()) return { ok: false, issue: "invalid-input", message: "label 与 modelId 必填" };

        // 提交前所有可失败的准备：keep 校验（含真实落盘回查）+ 旧端口关闭。
        // 原则：先做完所有可失败的事，原子提交是最后一步；提交后不再调用可能失败的必需操作。
        // keep 判定以已保存的 customDefinition 为准（独立于当前选择；当前 preset 时仍可留用原 custom key）。
        if (input.keyAction === "keep") {
          let storedForKeep;
          try { storedForKeep = await store.read(); }
          catch (err) {
            this.diagnose("model-setup-read-failed", err);
            return { ok: false, issue: "storage-failed", message: "读取已保存配置失败；请稍后重试" };
          }
          const def = storedForKeep?.customDefinition;
          if (!def) return { ok: false, issue: "no-existing-key", message: "尚未保存自定义凭据，无法沿用；选择更换并输入新 key" };
          if (def.provider !== input.provider) return { ok: false, issue: "no-existing-key", message: "协议变更需要新 key" };
          try {
            if (new URL(def.baseUrl).origin !== new URL(input.baseUrl).origin) {
              return { ok: false, issue: "no-existing-key", message: "origin 变更需要新 key" };
            }
          } catch { return { ok: false, issue: "invalid-input", message: "baseUrl 无法解析" }; }
          if (!storedForKeep?.credentials?.["user-defined"]) return { ok: false, issue: "no-existing-key", message: "已保存配置不含凭据，无法沿用；选择更换并输入新 key" };
        }

        // 用公开 ExecutionPort.read 核对所有已打开端口的真实运行相位（不依赖应用层投影：
        // sendMessage 的 void syncSession 是异步的，state.runs 可能还停在 ready 而真实端口已 running，
        // 仅凭 hasActiveWork 会让 configureModel 在真实运行中误放行，关闭正在使用的端口）。
        // 读失败不关端口不提交；任一端口报告 running/pausing 即整体 run-in-flight。
        // paused 不算在途：已暂停队列是用户事实，不强迫恢复坏模型才能改配置。
        for (const [, pending] of this.ports) {
          let view;
          try {
            const port = await pending;
            view = await port.read();
          } catch (err) {
            this.diagnose("model-setup-port-read-failed", err);
            return { ok: false, issue: "storage-failed", message: "无法核对既有会话的真实状态，保存未生效；请稍后再试" };
          }
          if (view.phase === "running" || view.phase === "pausing") {
            return { ok: false, issue: "run-in-flight", message: "有正在执行或正要暂停的运行；等待当前请求结束或恢复完成后再修改" };
          }
        }

        // 预关闭旧端口：关闭成功的端口从表移除；任何一个 close 失败整体保存失败（storage-failed），
        // 端口与其锁保留不被清空，用户可再次保存或关闭应用自然收束。
        const closeFailures = await this.closeIdlePorts();
        if (closeFailures.length > 0) {
          return { ok: false, issue: "storage-failed", message: `无法关闭 ${closeFailures.length} 个既有会话端口，保存未生效；请稍后再试或重启应用` };
        }

        // 预构造候选 backend：real.ts 内部 createProvider/createModels 等库可能抛校验错，
        // 必须在原子提交之前完成；backendFactory 只读取连接元数据（provider/label/modelId/baseUrl），
        // 与最终落盘的 saved record 一致——提交后不再调用任何可能失败的必需操作。
        // keyAction=clear 时跳过构造：恢复真 unavailable 能力，清除后不能借 backend.modelName 假解锁；
        // 服务商配置安全元数据保留（hasKey=false 可继续编辑填新 key，再由未来 replace 重新构造）。
        const candidateSelection = {
          kind: "custom" as const,
          provider: input.provider,
          label: input.label.trim(),
          modelId: input.modelId.trim(),
          baseUrl: input.baseUrl.trim(),
        };
        let nextBackend: ExecutionBackend;
        if (input.keyAction === "clear") {
          nextBackend = { kind: "unavailable", modelName: null, async open() { throw new Error("execution-unavailable"); } };
        } else {
          try {
            nextBackend = await backendFactory(candidateSelection);
          } catch (err) {
            this.diagnose("model-setup-backend-build-failed", err);
            return { ok: false, issue: "storage-failed", message: "候选配置无法构造后端；请检查后重试" };
          }
        }

        // 原子提交点：commitCustomSetup 是最后一步可能失败的必需操作。
        const saved = await store.commitCustomSetup({
          ...candidateSelection,
          note: "ready",
          keyAction: input.keyAction,
          apiKey: input.keyAction === "replace" ? input.apiKey : undefined,
        });

        // 提交成功 → 立即发布已就绪的新 backend（同步内存赋值）。
        this.currentBackend = nextBackend;
        const savedSel = saved.current;
        this.modelSetupRecord = savedSel
          ? {
              selection: savedSel,
              hasKey: savedSel.kind === "custom" ? saved.credentials["user-defined"] !== undefined : saved.credentials[savedSel.providerId] !== undefined,
              customDefinition: saved.customDefinition ?? null,
              customHasKey: saved.credentials["user-defined"] !== undefined,
            }
          : null;
        this.commit();
        return { ok: true };
      } catch (err) {
        const msg = String((err as Error)?.message ?? err);
        this.diagnose("model-setup-save-failed", err);
        // 明确 storage-failed：不会被误为 busy；A 记录/凭据未被改动
        return { ok: false, issue: "storage-failed", message: msg };
      } finally {
        // 严格按 flight 身份清除：如果该字段当前仍指向自己（未被后续保存覆盖占据），本次 flight 已结束可释放
        if (this.modelSetupFlight === flight) this.modelSetupFlight = null;
      }
    });
    this.modelSetupFlight = flight;
    return flight;
  }

  // ---------- 认证 flow 门控（A 轮收口，复用 configureModel 的真实相位检查） ----------
  // 更换/清除当前执行供应商的认证，必须与选模走同一套「核对接收/控制在途、执行端真实相位与关闭」
  // 门控，不允许「先静默保存凭据，再事后检查模型」。未被当前工作使用的另一供应商可独立提交；
  // SDK 已授权请求的 OAuth token 刷新属于请求通路，不经这里（也不会被误拦）。

  /**
   * 认证在途按供应商登记（providerId → 在途计数）。spec「认证与自定义保留」要求：在途门控只约束
   * **影响该供应商**的发送/继续，当前工作用的另一供应商登录不得阻断它。用 Map 计数而不是布尔，
   * 是为了让同一供应商的多个流程不会因先结束的那个把门控整体撤掉。
   */
  private readonly authFlowProviders = new Map<string, number>();

  /** 某供应商是否有在途认证（该供应商的发送/继续被拒；其他供应商不受影响）。 */
  private authFlowOpenFor(providerId: string): boolean {
    return (this.authFlowProviders.get(providerId) ?? 0) > 0;
  }

  /**
   * 尚无会话判定时的来源标识：当前执行后端实际使用的供应商。
   * 持久 selection 只有 preset/custom 两种；preset-with-custom 是「preset 选择 ＋ 仍保留 customDefinition」
   * 的快照视图，其执行身份仍是 preset。纯自定义接入的身份是 `user-defined`（凭据不经 preset 登录改写）。
   */
  private currentRequestSourceId(): string {
    const selection = this.modelSetupRecord?.selection;
    return selection?.kind === "preset" ? selection.providerId : CUSTOM_SOURCE_ID;
  }

  /**
   * 本次请求**实际会发往**的来源：已有会话按它已裁决出的目标（显式选择或自动判定采用的那个），
   * 还没有判定时退回当前后端的来源。
   *
   * 不能用设置里的「当前选择」代替：默认来源可能是 A 而这次请求实际发往 B，
   * 那样会变成 A 的登录在途拦下 B 的发送，同时放过 B 登录在途时的 B 发送。
   */
  private requestSourceId(session: Session): string {
    return this.executionTargetFor(session)?.sourceId ?? this.currentRequestSourceId();
  }

  /** 合法旧单模型的未来目标来自已保存配置；只在提交／继续应用，不在只读打开时改旧运行。 */
  private executionTargetFor(session: Session): SdkRequestTarget | null {
    const target = this.sessionModels.effectiveTarget(session.id);
    if (target) return target;
    const state = this.sessionModels.read(session.id);
    if (state.choice.mode !== 'auto' || state.waitingExplicitContinue
      || state.lastRouting?.decision.kind.startsWith('hold-')
      || this.state.settings.modelCandidates.length > 0 || this.state.modelCandidateScopeConfigured
      || !this.modelSetupRecord?.hasKey) return null;
    const selection = this.modelSetupRecord.selection;
    // readonly reopen 保留旧 AgentDoc；因此请求入口须显式应用保存后的新 id，而不能沿历史 actual 回退。
    return {
      sourceId: selection.kind === 'preset' ? selection.providerId : CUSTOM_SOURCE_ID,
      modelId: selection.modelId,
      thinkingLevel: state.thinkingLevel,
    };
  }

  /** 该来源是否正在被工作实际使用（设置当前选择，或任一会话已选定/已判定用它）。 */
  private sourceInUse(sourceId: string): boolean {
    if (this.currentRequestSourceId() === sourceId) return true;
    return this.state.sessions.some((session) => this.requestSourceId(session) === sourceId);
  }

  /** 入口处能定位到的既有会话（按 operationId 或显式 sessionId）；定位不到就是新会话。 */
  private resolveEntrySession(input: { sessionId?: string; operationId?: string }): Session | null {
    if (input.operationId) {
      const located = this.locateByOperation(input.operationId);
      if (located) return located;
    }
    if (!input.sessionId) return null;
    return this.state.sessions.find((s) => s.id === input.sessionId) ?? null;
  }

  /**
   * 是否有在途认证正影响这条请求实际使用的来源。发送/继续/重投只经它判定：
   * 在途登录只在改这个来源的凭据，别的来源不受影响（spec「认证与自定义保留」）。
   */
  private authFlowBlocksRequest(session: Session): boolean {
    return this.authFlowOpenFor(this.requestSourceId(session));
  }

  #releaseAuthFlow(providerId: string): void {
    const remaining = (this.authFlowProviders.get(providerId) ?? 0) - 1;
    if (remaining > 0) this.authFlowProviders.set(providerId, remaining);
    else this.authFlowProviders.delete(providerId);
  }

  /**
   * 开始认证前的正式认领（公开方法；main 在登记 flow 前必须调用并先在首个 await 前同步认领）：
   * 同步登记 providerId（后续该供应商的 send/resume、同 provider 第二个 login 立即被拒），
   * 再真实核相位（关闭/接收在途/保存 flight/当前供应商端口真实 phase）。失败立即释放已认领的门控。
   * 返回在确认门控后是否放行；调用方在放行之后才登记 flow 并进入 SDK 登录。
   */
  async beginProviderAuth(providerId: string): Promise<{ ok: true; release: () => void } | { ok: false; reason?: "shutting-down" | "receiving-in-flight" | "model-setup-in-flight" | "running" }> {
    // 第一同步步骤：认领认证门控（无 await 窗口让 send/另一 login 穿入）
    if (this.closingStarted) return { ok: false, reason: "shutting-down" };
    // 同 provider admission 真实互斥：该供应商已有在途流程 → 第二次 begin 立即拒绝。
    // 各供应商各占自己的槽，A→B→第二个 A 不会被 B 的登记顶掉。
    if (this.authFlowProviders.has(providerId)) return { ok: false, reason: "receiving-in-flight" };
    this.authFlowProviders.set(providerId, 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.#releaseAuthFlow(providerId);
    };
    try {
      if (this.modelSetupFlight) { release(); return { ok: false, reason: "model-setup-in-flight" }; }
      if (this.receivingFlightCount > 0) { release(); return { ok: false, reason: "receiving-in-flight" }; }
      // 该来源是否正在被工作实际使用：设置当前选择，或任一会话已选定/已判定用它。
      // 只看设置当前选择会漏掉"默认 A、会话实际跑 B"的情形——那时换 B 的凭据不核相位。
      const isCurrent = this.sourceInUse(providerId);
      if (isCurrent) {
        for (const [, pending] of this.ports) {
          let view;
          try {
            const port = await pending;
            view = await port.read();
          } catch (err) {
            this.diagnose("provider-auth-port-read-failed", err);
            release();
            return { ok: false, reason: "running" };
          }
          if (view.phase === "running" || view.phase === "pausing") {
            release();
            return { ok: false, reason: "running" };
          }
        }
      }
      // 读相位时可能已开始退出；较晚放行不能跨过关闭意图。
      if (this.closingStarted) { release(); return { ok: false, reason: "shutting-down" }; }
      return { ok: true, release };
    } catch (err) {
      // 异常路径同样释放已认领门控（不泄漏计数）
      release();
      throw err;
    }
  }

  /**
   * main 调用：登记一个会影响 providerId 的认证流程并返回释放函数。
   * 登记按供应商归属（不再是无归属的全局计数）：只有该供应商的发送/继续受门控约束。
   */
  enterAuthFlow(providerId: string): () => void {
    this.authFlowProviders.set(providerId, (this.authFlowProviders.get(providerId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#releaseAuthFlow(providerId);
    };
  }

  /** 认证在途判定（main 发送/恢复/保存前核对；读取不因此阻塞）。 */
  get authFlowInFlight(): boolean {
    return this.authFlowProviders.size > 0;
  }

  /**
   * 应用当前模型（preset 或 custom）。custom 分支等价于 configureModel 的完整语义；
   * preset 分支：校验供应商/模型在目录中存在且该 providerId 名下确有凭据，原子提交选择后才成为当前接入。
   * 与 configureModel 共用同一单写 flight 与全部门控（接收/执行在途、运行中拒绝、读失败不提交）。
   */
  async applyModel(input: import("@/contracts").ApplyModelInput): Promise<import("@/contracts").ApplyModelResult> {
    if (input.kind === "custom") {
      const r = await this.configureModel(input.input);
      return r.ok ? { ok: true } : { ok: false, issue: r.issue, message: r.message };
    }
    if (this.modelSetupFlight) return { ok: false, issue: "run-in-flight", message: "仍在保存上一个模型配置，请稍后再试" };
    if (this.closingStarted) return { ok: false, issue: "storage-failed", message: "应用正在关闭，无法保存配置" };
    if (this.authFlowInFlight) return { ok: false, issue: "run-in-flight", message: "认证流程进行中，请先完成或取消" };
    if (this.receivingFlightCount > 0) return { ok: false, issue: "run-in-flight", message: "有正在接收或发送中的请求；请等当前请求完成后再试" };
    if (this.hasActiveWork()) return { ok: false, issue: "run-in-flight", message: "有正在执行或正要暂停的运行；等待结束后再修改" };
    if (!this.modelSetupStore || !this.modelSetupBackendFactory) return { ok: false, issue: "backend-unavailable", message: "本实例不支持动态装配服务商" };
    if (!this.presetLookup) return { ok: false, issue: "backend-unavailable", message: "本实例不支持预设供应商目录" };

    const store = this.modelSetupStore;
    const backendFactory = this.modelSetupBackendFactory;
    const lookup = this.presetLookup;
    const flight: Promise<import("@/contracts").ApplyModelResult> = Promise.resolve().then(async () => {
      try {
        if (!lookup.hasProvider(input.providerId)) {
          return { ok: false, issue: "unknown-provider", message: "未登记的预设供应商" };
        }
        if (!(await lookup.modelAsync(input.providerId, input.modelId))) {
          return { ok: false, issue: "unknown-model", message: "目录中没有该模型；请刷新目录或改选" };
        }
        // 凭据存在性按 providerId 精确核对；缺凭据不静默放行（配置 ≠ 可执行）
        let stored;
        try { stored = await store.read(); }
        catch (err) {
          this.diagnose("model-setup-read-failed", err);
          return { ok: false, issue: "storage-failed", message: "读取已保存配置失败；请稍后重试" };
        }
        if (!stored?.credentials?.[input.providerId]) {
          return { ok: false, issue: "auth-missing", message: "该供应商尚未配置认证；请先完成密钥或授权" };
        }
        for (const [, pending] of this.ports) {
          let view;
          try {
            const port = await pending;
            view = await port.read();
          } catch (err) {
            this.diagnose("model-setup-port-read-failed", err);
            return { ok: false, issue: "storage-failed", message: "无法核对既有会话的真实状态，保存未生效；请稍后再试" };
          }
          if (view.phase === "running" || view.phase === "pausing") {
            return { ok: false, issue: "run-in-flight", message: "有正在执行或正要暂停的运行；等待当前请求结束或恢复完成后再修改" };
          }
        }
        const closeFailures = await this.closeIdlePorts();
        if (closeFailures.length > 0) {
          return { ok: false, issue: "storage-failed", message: `无法关闭 ${closeFailures.length} 个既有会话端口，保存未生效；请稍后再试或重启应用` };
        }
        let nextBackend: ExecutionBackend;
        try {
          nextBackend = await backendFactory({ kind: "preset", providerId: input.providerId, modelId: input.modelId });
        } catch (err) {
          this.diagnose("model-setup-backend-build-failed", err);
          return { ok: false, issue: "storage-failed", message: "候选配置无法构造后端；请检查后重试" };
        }
        // 原子提交点：选择落盘是最后一步可能失败的必需操作
        const saved = await store.commitPresetSelection({
          providerId: input.providerId,
          modelId: input.modelId,
          note: "ready",
        });
        this.currentBackend = nextBackend;
        const savedSel = saved.current;
        this.modelSetupRecord = savedSel && savedSel.kind === "preset"
          ? {
              selection: savedSel,
              hasKey: saved.credentials[savedSel.providerId] !== undefined,
              customDefinition: saved.customDefinition ?? null,
              customHasKey: saved.credentials["user-defined"] !== undefined,
            }
          : null;
        this.commit();
        return { ok: true };
      } catch (err) {
        const msg = String((err as Error)?.message ?? err);
        this.diagnose("model-setup-save-failed", err);
        return { ok: false, issue: "storage-failed", message: msg };
      } finally {
        if (this.modelSetupFlight === flight) this.modelSetupFlight = null;
      }
    });
    this.modelSetupFlight = flight;
    return flight;
  }

  /** 真正阻断切换的工作：running/pausing 运行。
   *  paused 是已接收的暂停队列（含可能还没来得及响应的 pendingInputs），用户事实≠接收在途，
   *  不阻断编辑否则坏模型永远卡死；pendingInputs>0 时 run 通常进入 running，running 已覆盖。 */
  private hasActiveWork(): boolean {
    return Object.values(this.state.runs).some((run) => run.status === "running" || run.status === "pausing");
  }

  /** 关闭非活跃缓存端口：逐个 await close，成功才把端口从表移除；
   *  失败的 port 保留（连同它的目录锁/未收束事实），返回失败会话 id 给调用方取消保存。 */
  private async closeIdlePorts(): Promise<string[]> {
    const failures: string[] = [];
    for (const [sessionId, pending] of this.ports) {
      try {
        const port = await pending;
        await port.close();
        // 关闭成功后才能从应用层视图移除；controls/views 一并失效。
        // projectedThrough 不清：历史失败 entry 不能因换 backend 重新投影为当前失败；
        // 新 port 是同会话 continuation，已投影过的 entry id 不重放为新事实。
        this.ports.delete(sessionId);
        this.controls.delete(sessionId);
        this.views.delete(sessionId);
      } catch (err) {
        failures.push(sessionId);
        this.diagnose("model-setup-port-close-failed", err);
      }
    }
    return failures;
  }

  // 错误类型只说明内容；每次真实失败另有身份，界面忽略不能永久屏蔽后续同类失败。
  // 仅失败发生处调用；读取、普通广播和语言切换沿用当前编号，不制造新事件。
  private setCloseError(issue: AppIssue): void {
    this.closeError = issue;
    this.closeErrorRevision++;
  }

  private commit(): void {
    this.dirty = false;
    const snap = this.snapshot();
    for (const listener of this.listeners) listener(snap);
    this.scheduleSave(150);
  }

  /**
   * 延迟落盘的唯一调度口：每次 fire 都在执行时重取最新状态（不复制定时器排定时的旧快照）。
   * 设置写盘在途时旧快照不得抢先覆盖（校准：A 确认后队列里旧 settings 快照不能再盖回去）；
   * 设置写盘收束后统一重新调度，不以定时退避协调在途写入。
   */
  private scheduleSave(ms: number): void {
    if (this.closingStarted) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      // 在途设置写盘期间不排保存：避免较旧 settings 快照插到真实 FIFO 的设置写入之后；
      // 该设置写盘的真实完成会统一重新调度（见 applySavedSettings 的收束分支）
      if (this.stateSaveFlights.size > 0) return;
      // 保存失败必须进入可见通路（快照 banner），不是只记日志；只通知，不再排保存避免循环
      void this.saveState(this.persistedState()).catch((error: unknown) => {
        this.setCloseError("save-failed");
        this.diagnose("save-failed", error);
        const snap = this.snapshot();
        for (const listener of this.listeners) listener(snap);
      });
    }, ms);
  }

  /** 宿主退出的第一同步步骤：拒绝新动作，但不抢先开始保存或关闭端口。 */
  beginClosing(): void {
    this.closingStarted = true;
  }

  async flush(): Promise<void> {
    this.beginClosing();
    if (!this.flushPromise) {
      const closing = this.#flushInternal();
      this.flushPromise = closing;
      // 结果未知可在原创建身份查回；失败的关闭不能永久缓存为下一次明确关闭的结果。
      void closing.catch(() => { if (this.flushPromise === closing) this.flushPromise = null; });
    }
    return this.flushPromise;
  }

  /** 真实关闭收束主体：正常关闭逐个 await 全部会话 close() + 存储收束的真实结果。
   * 任何失败都保留可见状态（closeError 进快照）、不伪报成功。 */
  async #flushInternal(): Promise<void> {
    this.stopPolling();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    // 全部已开始的设置写盘先真实收束：最终保存不得用较旧的设置覆盖真实在途写入。
    // 按次等待**每一次**认领/写盘：只等"当前那一个"会让先开始、后被覆盖的那次凭空消失。
    await this.awaitStateSaves();
    // 模型配置保存在途也必须收束后退出：flush 不能在 store.commitWithCredential 写到一半时中断进程
    for (;;) {
      const flight = this.modelSetupFlight;
      if (!flight) break;
      await flight.catch(() => undefined);
      if (this.modelSetupFlight === flight) break;
    }
    const failures: string[] = [];
    for (const pending of this.ports.values()) {
      try {
        const port = await pending;
        await port.close();
      } catch (error) {
        failures.push("session-close");
        this.diagnose("session-close-failed", error);
      }
    }
    try {
      await this.saveState(this.persistedState());
    } catch (error) {
      failures.push("state-save");
      this.diagnose("close-save-failed", error);
    }
    if (failures.length) {
      this.setCloseError("close-failed");
      this.commit();
      throw new Error("close-failed");
    }
  }

  async getSnapshot(): Promise<AppSnapshot> {
    return this.snapshot();
  }

  async chooseProjectFolder(input: { operationId: string; requestId: string }): Promise<ProjectFolderSelection | null> {
    if (validateOperationInput('chooseProjectFolder', input) || this.closingStarted || !this.projectFolders) throw new Error('project-folder-unavailable');
    const selected = await this.projectFolders.choose(input);
    if (this.closingStarted) { this.projectFolders.discard(input.operationId); return null; }
    return selected;
  }

  async discardProjectFolder(input: { operationId: string }): Promise<void> {
    if (validateOperationInput('discardProjectFolder', input)) throw new Error('project-folder-stale');
    this.projectFolders?.discard(input.operationId);
  }

  createWorkspace(input: { operationId: string; selectionId: string; name: string }): Promise<Workspace> {
    if (validateOperationInput('createWorkspace', input)) return Promise.reject(new Error('project-binding-invalid'));
    const name = input.name.trim();
    const receipts = this.state.workspaceBindingReceipts ?? {};
    const known = Object.hasOwn(receipts, input.operationId) ? receipts[input.operationId] : undefined;
    if (known) {
      const workspace = this.state.workspaces.find(w => w.id === known.workspaceId);
      if (!workspace || known.selectionId !== input.selectionId || known.name !== name) return Promise.reject(new Error('project-binding-identity-conflict'));
      return Promise.resolve(structuredClone(workspace));
    }
    const current = this.workspaceFlights.get(input.operationId);
    if (current) return current.then(workspace => {
      const receipt = this.state.workspaceBindingReceipts?.[input.operationId];
      if (receipt?.selectionId !== input.selectionId || receipt.name !== name) throw new Error('project-binding-identity-conflict');
      return workspace;
    });
    const unknown = this.unknownWorkspaceBindings.get(input.operationId);
    if (unknown && (unknown.selectionId !== input.selectionId || unknown.name !== name)) return Promise.reject(new Error('project-binding-identity-conflict'));
    if (!unknown && (this.closingStarted || !this.projectFolders)) return Promise.reject(new Error('project-binding-closing'));
    // 首个目录校验await前认领；关闭和旧整表保存都等待本次真实保存与发布。
    const release = unknown && this.closingStarted ? () => undefined : this.claimStateSave();
    const run = this.serializeStateSave(async () => {
      if (unknown) {
        if (!await this.readWorkspaceBinding(input.operationId, unknown)) {
          this.unknownWorkspaceBindings.delete(input.operationId);
          throw new Error('project-binding-save-failed');
        }
        return this.publishWorkspaceBinding(input.operationId, unknown);
      }
      if (this.unknownWorkspaceBindings.size) throw new Error('project-binding-save-unknown');
      const folder = await this.projectFolders!.resolve(input);
      if (this.closingStarted) throw new Error('project-binding-closing');
      const workspace: Workspace = { id: nextId('ws'), name, folders: [folder], builtinHome: false, defaultTaskId: nextId('task') };
      const task: Task = { id: workspace.defaultTaskId, workspaceId: workspace.id, parentId: null, kind: 'long', title: '默认任务', boundFolder: null, isDefault: true, updatedAt: Date.now() };
      const receipt = { workspaceId: workspace.id, selectionId: input.selectionId, name };
      const draft = this.persistedState();
      draft.workspaces.push(workspace); draft.tasks.push(task);
      draft.workspaceBindingReceipts = { ...draft.workspaceBindingReceipts, [input.operationId]: receipt };
      const proposal = { workspace, task, selectionId: input.selectionId, name };
      try { await this.saveState(draft); }
      catch (cause) {
        this.diagnose('project-binding-save-failed', cause);
        // 保存应答丢失时先按本次创建身份读回；不能用旧内存整表覆盖其实已提交的新空间。
        this.unknownWorkspaceBindings.set(input.operationId, proposal);
        if (!await this.readWorkspaceBinding(input.operationId, proposal)) {
          this.unknownWorkspaceBindings.delete(input.operationId);
          throw new Error('project-binding-save-failed');
        }
      }
      return this.publishWorkspaceBinding(input.operationId, proposal);
    }).finally(() => {
      this.workspaceFlights.delete(input.operationId); release();
      if (this.unknownWorkspaceBindings.size) {
        // 表单关闭后仍需沿原身份核对；仅发布应用持有的待核视图，不再尝试旧整表保存。
        const snapshot = this.snapshot(); for (const listener of this.listeners) listener(snapshot);
      } else this.scheduleSave(150);
    });
    this.workspaceFlights.set(input.operationId, run);
    return run;
  }

  private async readWorkspaceBinding(operationId: string, proposal: { workspace: Workspace; task: Task; selectionId: string; name: string }): Promise<boolean> {
    const observed = await this.storage.readCurrent?.().catch(() => null);
    if (observed?.status !== 'ok' || !Array.isArray(observed.state.workspaces) || !Array.isArray(observed.state.tasks)) throw new Error('project-binding-save-unknown');
    const { workspace, task, selectionId, name } = proposal;
    const saved = observed.state.workspaceBindingReceipts?.[operationId];
    const ws = observed.state.workspaces.find(w => w.id === workspace.id);
    const savedTask = observed.state.tasks.find(t => t.id === task.id);
    if (!saved && !ws && !savedTask) return false;
    if (saved?.workspaceId !== workspace.id || saved.selectionId !== selectionId || saved.name !== name
      || ws?.name !== name || ws.defaultTaskId !== task.id || JSON.stringify(ws.folders) !== JSON.stringify(workspace.folders)
      || savedTask?.workspaceId !== workspace.id || !savedTask.isDefault) throw new Error('project-binding-save-unknown');
    return true;
  }

  private publishWorkspaceBinding(operationId: string, proposal: { workspace: Workspace; task: Task; selectionId: string; name: string }): Workspace {
    const { workspace, task, selectionId, name } = proposal;
    // 只合入本次已核实保存的事实，保留等待写盘期间推进的运行／历史。
    this.state.workspaces.push(workspace); this.state.tasks.push(task);
    this.state.workspaceBindingReceipts = { ...this.state.workspaceBindingReceipts, [operationId]: { workspaceId: workspace.id, selectionId, name } };
    this.unknownWorkspaceBindings.delete(operationId);
    this.projectFolders?.discard(operationId);
    this.commit();
    return structuredClone(workspace);
  }

  /** 未核实的保存可能已提交；所有整表写入必须等待同身份查回，不能仅保护绑定这一条调用。 */
  private saveState(state: PersistedState): Promise<void> {
    if (this.unknownWorkspaceBindings.size) return Promise.reject(new Error('project-binding-save-unknown'));
    return this.storage.save(state);
  }

  /** 设置和新绑定共享完整状态保存队列；在真实保存后发布，再允许下一操作取草案。 */
  private serializeStateSave<T>(action: () => Promise<T>): Promise<T> {
    // 空队列保持原设置调用同步到达存储的语义；仅在前次真实保存未收束时排队。
    const run = this.stateSaveQueue ? this.stateSaveQueue.then(action) : action();
    const settled = run.then(() => undefined, () => undefined);
    this.stateSaveQueue = settled;
    void settled.then(() => { if (this.stateSaveQueue === settled) this.stateSaveQueue = null; });
    return run;
  }

  async createTask(input: { workspaceId: string; parentId: string | null; title: string }): Promise<Task> {
    const workspace = this.state.workspaces.find((w) => w.id === input.workspaceId);
    if (!workspace) throw new Error(`Unknown workspace: ${input.workspaceId}`);
    if (input.parentId) {
      const parent = this.state.tasks.find((t) => t.id === input.parentId);
      if (!parent || parent.workspaceId !== input.workspaceId) throw new Error("Parent task not in workspace");
      // 任务类型与父子归属分离：只有长期任务可再建短期子任务（树动作同步约束）
      if (parent.kind !== "long") throw new Error("短期任务不能再建子任务");
    }
    const task: Task = {
      id: nextId("task"),
      workspaceId: input.workspaceId,
      parentId: input.parentId,
      kind: input.parentId ? "short" : "long",
      title: input.title.trim() || "未命名任务",
      boundFolder: null,
      isDefault: false,
      updatedAt: Date.now(),
    };
    this.state.tasks.push(task);
    this.commit();
    return task;
  }

  async moveTask(input: { taskId: string; targetWorkspaceId: string }): Promise<void> {
    const task = this.state.tasks.find((t) => t.id === input.taskId);
    const target = this.state.workspaces.find((w) => w.id === input.targetWorkspaceId);
    if (!task || !target) throw new Error("Unknown task or workspace");
    if (task.isDefault) throw new Error("内置默认任务不可移动");
    task.workspaceId = input.targetWorkspaceId;
    task.boundFolder = null; // 跨空间移动后重新解析目录
    task.updatedAt = Date.now();
    // 子任务随行
    for (const child of this.state.tasks.filter((t) => t.parentId === task.id)) {
      child.workspaceId = input.targetWorkspaceId;
      child.boundFolder = null;
      child.updatedAt = Date.now();
    }
    this.commit();
  }

  // 永久删除已退出正式通路（507 选择可恢复归档 A，spec/页面与交互组件.md N07）：
  // 应用层、契约白名单和界面入口同步移除，归档按 L01–L04 在后续独立切片实现。
  // 此前删除实现的首发在途关联清理语义由归档切片的真实实现承接。

  async createSession(input: { taskId: string }): Promise<Session> {
    const task = this.state.tasks.find((t) => t.id === input.taskId);
    if (!task) throw new Error(`Unknown task: ${input.taskId}`);
    const session: Session = {
      id: nextId("session"),
      taskId: input.taskId,
      title: "新会话",
      kind: this.state.sessions.some((s) => s.taskId === input.taskId) ? "sub" : "main",
      updatedAt: Date.now(),
    };
    this.state.sessions.push(session);
    (this.state.runtimeCreationPending ??= []).push(session.id);
    this.state.timelines[session.id] = [];
    this.state.runs[session.id] = idleRun(session.id);
    this.commit();
    return session;
  }

  // ---------- C05 引用：只读发现与选取，不发送、不执行、不安装、不新增授权 ----------

  /**
   * 解析一次引用请求的归属：会话或草稿任务二选一，其任务与工作空间必须真实。
   * 草稿态（只有任务、还没有会话）同样能引用——这里**不创建也不发送任何会话对象**。
   */
  private referenceScope(scope: { sessionId?: string; taskId?: string }, operationId?: string): ReferenceRequest {
    const session = scope.sessionId ? this.state.sessions.find((s) => s.id === scope.sessionId) : undefined;
    if (scope.sessionId && !session) throw new Error(`Unknown session: ${scope.sessionId}`);
    // 成员会话的分工范围尚未装配：在**调用读取端口之前**就拒，不让"留后片"变成"先读全空间"。
    // 正式成员分工由授权片承接（那里确定每名成员可读的目标）；这里不新增审批或权限模式，
    // 只是不假装已经有了授权。
    if (session?.kind === "sub") throw new Error("成员会话的引用范围尚未装配，已拒绝读取");
    const task = session
      ? this.state.tasks.find((t) => t.id === session.taskId)
      : this.state.tasks.find((t) => t.id === scope.taskId);
    if (!task) throw new Error(`Unknown task: ${session?.taskId ?? scope.taskId}`);
    const workspace = this.state.workspaces.find((w) => w.id === task.workspaceId);
    if (!workspace) throw new Error(`Unknown workspace: ${task.workspaceId}`);
    return {
      workspaceId: workspace.id,
      sessionId: session?.id ?? null,
      taskId: task.id,
      operationId: operationId ?? nextId("refq"),
      // 任务绑定目录优先；否则用空间绑定的全部文件夹（可能不止一个）。
      folders: task.boundFolder ? [task.boundFolder] : workspace.folders,
    };
  }

  /**
   * 业务接收方核对引用归属：文件引用必须来自本会话所属工作空间，技能来源自洽。
   * 成员会话同样按其分工范围核对；本方法只读，不新增任何授权，也不改运行事实。
   */
  private assertReferencesBelongTo(session: Session, refs: readonly WorkReference[]): void {
    if (refs.length === 0) return;
    // 带引用的提交同样先过授权：成员会话的分工范围未装配时不得凭载荷里的引用推进执行。
    // 无引用的普通发送不受影响——成员会话本身仍可正常收发，那属于成员授权片。
    if (session.kind === "sub") throw new Error("成员会话的引用范围尚未装配，已拒绝带引用提交");
    const task = this.state.tasks.find((t) => t.id === session.taskId);
    this.assertReferencesBelongToWorkspace(task?.workspaceId ?? "", refs);
  }

  /** 无会话的草稿态也按工作空间核对来源身份。 */
  private assertReferencesBelongToWorkspace(workspaceId: string, refs: readonly WorkReference[]): void {
    for (const ref of refs) {
      if (ref.kind === "file" && ref.sourceId !== `workspace:${workspaceId}`) {
        throw new Error("引用不属于本次发送目标的工作空间");
      }
      if (ref.kind === "skill" && ref.sourceId !== `skill:${ref.label}`) {
        throw new Error("技能引用来源与名称不一致");
      }
    }
  }

  /**
   * 只读查回一次：返回已存在的真实回执，或 null 表示「可靠未找到，可以谈重投」。
   * 未知（storage-unavailable）不是 not-found，不能据此重投。
   */
  private async lookUpOnly(session: Session, block: TimelineBlock): Promise<SendReceipt | null> {
    try {
      if (block.kind !== "message" || !block.operationId || !block.mode) throw new Error("该消息没有可回查的发送身份");
      const port = (await this.ports.get(session.id)) ?? await this.ensurePort(session);
      const expected = await this.latestControl(session.id, port);
      const receipt = toSendReceipt(await port.lookupReceipt({
        target: this.targetOf(session),
        operationId: block.operationId,
        text: block.text,
        references: identityOnlyReferences(block.references),
        mode: block.mode,
        expected,
      }));
      return receipt.status === "not-accepted" && receipt.reason === "not-found" ? null : receipt;
    } catch {
      // 查不通不等于未接收：返回 null 会让调用方进入重投判断，因此这里必须显式失败。
      throw new Error("接收结果核对未能完成，保持原状态不重投");
    }
  }

  /**
   * 重试前恢复原引用：按原定位重新读取，逐条核对内容哈希与原快照一致。
   * 任一条读不到、已变更或根不同，就返回 null 让调用方按 not-accepted 说明原因——
   * 不拿变化后的内容冒充同一次发送。
   */
  private async restoreReferencesForRetry(
    session: Session,
    summaries: readonly ReferenceSummary[] | undefined,
  ): Promise<readonly WorkReference[] | null> {
    if (!summaries || summaries.length === 0) return [];
    const port = this.referencePort;
    if (!port) return null;
    let request: ReferenceRequest;
    try {
      request = this.referenceScope({ sessionId: session.id });
    } catch {
      return null;
    }
    const restored: WorkReference[] = [];
    for (const summary of summaries) {
      try {
        const captured = await port.capture(request, summary.kind, summary.locator);
        if (captured.snapshot.contentHash !== summary.snapshot.contentHash) return null;
        restored.push(captured);
      } catch {
        return null;
      }
    }
    return restored;
  }

  /** 只读发现：可引用的真实文件与已接技能。回执带 scope，迟到结果由界面按它比对丢弃。 */
  async listReferences(input: ListReferencesInput): Promise<ReferenceListing> {
    const port = this.referencePort;
    if (!port) throw new Error("引用能力未装配");
    const request = this.referenceScope(input, input.operationId);
    return port.list(request);
  }

  /** 读取并固化一份快照；失败由端口抛出带原因码的错误，不产生半成品引用。 */
  async captureReference(input: CaptureReferenceInput): Promise<WorkReference> {
    const port = this.referencePort;
    if (!port) throw new Error("引用能力未装配");
    const request = this.referenceScope(input, input.operationId);
    const captured = await port.capture(request, input.kind, input.locator);
    // 业务端再核一次归属：选取结果同样必须属于本目标的工作空间。
    if (request.sessionId) {
      const session = this.state.sessions.find((s) => s.id === request.sessionId);
      if (session) this.assertReferencesBelongTo(session, [captured]);
    } else {
      this.assertReferencesBelongToWorkspace(request.workspaceId, [captured]);
    }
    return captured;
  }

  async sendMessage(input: {
    sessionId?: string;
    taskId?: string;
    text: string;
    mode: "steer" | "follow-up";
    operationId?: string;
    /** 本次输入携带的引用（C05）：与文字分成独立内容块投递，历史只留身份与快照元数据 */
    references?: readonly WorkReference[];
  }): Promise<SendResult> {
    const text = input.text.trim();
    if (!text) throw new Error("空消息不发送");
    // 关闭意图已认领：新输入立刻拒，不绕过最后一次收束
    if (this.closingStarted) return { sessionId: input.sessionId ?? "", receipt: { status: "not-accepted", operationId: input.operationId ?? "", reason: "storage-rejected" } };
    // 凭据已被清除（keyAction=clear）后，即便 backend 仍在也不得视为可执行——避免无 key 状态下真实发请求
    if (this.currentBackend.modelName === null) throw new Error("execution-unavailable");
    if (this.modelSetupRecord !== null && this.modelSetupRecord.hasKey === false) throw new Error("execution-unavailable");
    // 模型配置保存进行中不允许发送穿透：发送必须看到已提交的 backend
    if (this.modelSetupFlight) return { sessionId: input.sessionId ?? "", receipt: { status: "not-accepted", operationId: input.operationId ?? "", reason: "storage-rejected" } };
    // 认证 flow 在途（更换/清除某个来源的认证）：只有**这条请求实际会用的来源**的在途才拒它，
    // 不拿正在被替换的凭据发请求；另一个来源的登录不阻断（spec「认证与自定义保留」）。
    // 已定位到既有会话时按它已选定/已判定的来源判；新会话尚无判定，按当前后端的来源判。
    const entrySession = this.resolveEntrySession(input);
    if (entrySession ? this.authFlowBlocksRequest(entrySession) : this.authFlowOpenFor(this.currentRequestSourceId())) {
      return { sessionId: input.sessionId ?? "", receipt: { status: "not-accepted", operationId: input.operationId ?? "", reason: "storage-rejected" } };
    }
    // 登记在途：后续 persistNow/ensurePort/latestControl 的 await 期间 configureModel 不得穿入
    const releaseReceive = this.enterReceive();
    try {
      return await this.#sendMessageCore(input, text);
    } finally {
      releaseReceive();
    }
  }

  async #sendMessageCore(input: {
    sessionId?: string;
    taskId?: string;
    text: string;
    references?: readonly WorkReference[];
    mode: "steer" | "follow-up";
    operationId?: string;
  }, text: string): Promise<SendResult> {
    let session: Session | undefined;
    let operationId = input.operationId ?? nextId("op");
    // 同次重试/找回（复用既有发送身份）：先只读回查找回，可靠未找到才重投
    let reusedOperation = false;
    // 显式携带发送身份时先定位既有正式记录：已接收不以界面收到应答为准——
    // 外层应答丢失或重开后，同一 operationId 复用原会话并只读找回，不重复建对象。
    // pendingFirstSends 覆盖「对象已建但消息块尚未落盘」的更早窗口，两者互补。
    if (input.operationId) {
      const located = this.locateByOperation(input.operationId);
      if (located) {
        if (input.sessionId && input.sessionId !== located.id) throw new Error("发送身份与目标会话冲突");
        session = located;
        reusedOperation = true;
      }
    }
    if (!session && input.sessionId) {
      session = this.state.sessions.find((s) => s.id === input.sessionId);
      if (!session) throw new Error(`Unknown session: ${input.sessionId}`);
    } else if (!session) {
      // 首发：一个界面操作入口，两阶段（建对象 → 执行端确认接收）可分别回查；
      // 对象已建但接收未确认时不重复建对象。在途关联随 state 持久化，重开后仍复用。
      const draftTask = this.state.tasks.find((t) => t.id === input.taskId);
      if (!draftTask) throw new Error(`Unknown task: ${input.taskId}`);
      const pending = this.state.pendingFirstSends[draftTask.id];
      if (pending) {
        session = this.state.sessions.find((s) => s.id === pending.sessionId);
        // 同次重试（原文+模式未变）复用同一 operationId；内容变了就是新的发送身份
        if (pending.text === text && pending.mode === input.mode) {
          operationId = pending.operationId;
          reusedOperation = true;
        } else {
          operationId = input.operationId ?? nextId("op");
        }
        this.state.pendingFirstSends[draftTask.id] = { sessionId: pending.sessionId, text, mode: input.mode, operationId };
      }
      if (!session) {
        const task = this.newShortTask(draftTask.workspaceId, text);
        session = this.newMainSession(task, text);
        this.state.pendingFirstSends[draftTask.id] = { sessionId: session.id, text, mode: input.mode, operationId };
      }
      // 两阶段次序：对象与首发关联先真实落盘，再进入执行端接收。
      // 保存失败/未知时不调用执行端、不丢目标、不重复建对象；重试复用本次关联（规格：冷启动与草稿态）。
      try {
        await this.persistNow();
      } catch (error) {
        this.setCloseError("first-send-save-failed");
        this.diagnose("first-send-save-failed", error);
        const snap = this.snapshot();
        for (const listener of this.listeners) listener(snap);
        return { sessionId: session.id, receipt: { status: "not-accepted", operationId, reason: "storage-rejected" } };
      }
    }
    // 业务接收方在推进执行前核对引用归属：目标工作空间、来源自洽与定位形状。
    // 不匹配即拒收——不推进执行、不改事实、不伪报接收。
    const references = parseWorkReferences(input.references);
    this.assertReferencesBelongTo(session, references);
    // 顺序关键：**先查回既有接收事实，再谈新投递**。
    // 同一个 operationId 若此前已接收（或外层回包未知），后来的额度/能力条件变化
    // 不能倒改那条已成立的接收事实 —— 先按只读查回原样返回。
    // 只有查回给出可靠"未接收"时才真正要投递，那一步才消费完整的正式路由裁决。
    const work = { operationId, text, references, mode: input.mode };
    const receipt = reusedOperation
      ? await this.recoverOrSubmit(session, work)
      : await this.submitToPort(session, work);
    this.appendUserBlock(session, { operationId, text, references, mode: input.mode, receipt });
    // 提交后主动同步一次；后续所有已打开端口的普通观测沿同一 syncSession 推进。
    void this.syncSession(session.id);
    if (session.title === "新会话") session.title = text.slice(0, 24);
    session.updatedAt = Date.now();
    this.touchTask(session.taskId);
    // 已接收才解除在途记录；未接收／待核对保留，重试复用同一任务、主会话与消息身份
    if (receipt.status === "accepted") {
      for (const [draftTaskId, pending] of Object.entries(this.state.pendingFirstSends)) {
        if (pending.sessionId === session.id) delete this.state.pendingFirstSends[draftTaskId];
      }
    }
    this.commit();
    return { sessionId: session.id, receipt };
  }

  async retrySend(input: { sessionId: string; blockId: string }): Promise<SendResult> {
    const block = this.findUserBlock(input.sessionId, input.blockId);
    const session = this.state.sessions.find((s) => s.id === input.sessionId);
    if (!session || !block.operationId || !block.mode) throw new Error("该消息没有可重试的发送身份");
    // 关闭认领后拒绝新动作（与 sendMessage 同口径）
    if (this.closingStarted) return { sessionId: session.id, receipt: { status: "not-accepted", operationId: block.operationId, reason: "storage-rejected" } };
    // 保存 flight 在途时同身份重试不得穿透（旧 port 正在被 close 或backend即将替换）
    if (this.modelSetupFlight) return { sessionId: session.id, receipt: { status: "not-accepted", operationId: block.operationId, reason: "storage-rejected" } };
    const releaseReceive = this.enterReceive();
    try {
      // 同次重试的第一步永远是**只读查回**：已接收的发送不能因为源文件后来被删/被改
      // 而被改写成 not-accepted——接收事实由运行端存储说了算，不由磁盘现状说了算。
      const known = await this.lookUpOnly(session, block);
      if (known !== null) {
        block.receipt = known;
        void this.syncSession(session.id);
        this.commit();
        return { sessionId: session.id, receipt: known };
      }
      // 只有可靠未找到，才进入"用原内容重投"的判断：此时才需要源文件还在。
      const references = await this.restoreReferencesForRetry(session, block.references);
      if (references === null) {
        const rejected: SendResult = {
          sessionId: session.id,
          receipt: { status: "not-accepted", operationId: block.operationId, reason: "conflict" },
        };
        block.receipt = rejected.receipt;
        this.commit();
        return rejected;
      }
      const receipt = await this.recoverOrSubmit(session, { operationId: block.operationId, text: block.text, references, mode: block.mode });
      block.receipt = receipt;
      void this.syncSession(session.id);
      this.commit();
      return { sessionId: session.id, receipt };
    } finally {
      releaseReceive();
    }
  }

  async checkReceipt(input: { sessionId: string; blockId: string }): Promise<SendResult> {
    const block = this.findUserBlock(input.sessionId, input.blockId);
    const session = this.state.sessions.find((s) => s.id === input.sessionId);
    if (!session || !block.operationId || !block.mode) throw new Error("该消息没有可回查的发送身份");
    if (this.closingStarted) return { sessionId: session.id, receipt: { status: "unknown", operationId: block.operationId, reason: "storage-unavailable" } };
    // 保存 flight 在途时回查不得穿透（旧 port 正在被 close，回查结果会失真）
    if (this.modelSetupFlight) return { sessionId: session.id, receipt: { status: "unknown", operationId: block.operationId, reason: "storage-unavailable" } };
    const releaseReceive = this.enterReceive();
    try {
      const port = await this.ensurePort(session);
      const expected = await this.latestControl(session.id, port);
      // 只读回查（lookupReceipt）：不执行工作，终态也可查；结果未知不盲投。
      // 引用身份按历史留存的身份字段复原（不重读源文件——源文件是否还在与这次回查无关），
      // 否则带引用的已接收发送会被判成另一份输入而误报 conflict。
      const receipt = toSendReceipt(await port.lookupReceipt({
        target: this.targetOf(session),
        operationId: block.operationId,
        text: block.text,
        references: identityOnlyReferences(block.references),
        mode: block.mode,
        expected,
      }));
      block.receipt = receipt;
      this.commit();
      return { sessionId: session.id, receipt };
    } finally {
      releaseReceive();
    }
  }

  async pauseRun(input: { sessionId: string }): Promise<void> {
    const session = this.state.sessions.find((s) => s.id === input.sessionId);
    if (!session) throw new Error(`Unknown session: ${input.sessionId}`);
    if (this.closingStarted) throw new Error("app-closing");
    // 保存 flight 在途时暂停被拒：旧 port 正在被 close，新 backend 未发布；产品没有"结束本轮"操作，只能等保存完成
    if (this.modelSetupFlight) throw new Error("model-setup-in-flight");
    const releaseReceive = this.enterReceive();
    try {
      const port = await this.ensurePort(session);
      // 先呈现「暂停处理中」：pause() 在收束完成后才返回（对齐真实 Pi 的收束语义），
      // 中间态由这里先行登记，收束视图返回后再覆盖为真实状态。
      this.setRunStatus(session.id, "pausing");
      // 暂停使在途的选模／额度读取结果作废：它们属于暂停之前那一刻的世界。
      this.sessionModels.invalidate(session.id, "会话正在暂停，此前发起的选模结果不再生效");
      this.commit();
      const view = await port.pause();
      this.applyView(session.id, view);
      this.commit();
    } finally {
      releaseReceive();
    }
  }

  async resumeRun(input: { sessionId: string }): Promise<void> {
    const session = this.state.sessions.find((s) => s.id === input.sessionId);
    if (!session) throw new Error(`Unknown session: ${input.sessionId}`);
    if (this.closingStarted) throw new Error("app-closing");
    // 保存 flight 在途时恢复被拒：等保存完成后由用户在新 backend 上显式恢复；不能丢锁盲续
    if (this.modelSetupFlight) throw new Error("model-setup-in-flight");
    // 认证 flow 在途时恢复被拒：仅限**本会话实际会用的那个来源**的凭据正在被更换/清除，不拿旧会话盲续；
    // 另一来源的登录与本会话无关，不阻断明确继续（默认来源 A ≠ 本会话实际来源时，核的是后者）
    if (this.authFlowBlocksRequest(session)) throw new Error("auth-flow-in-flight");
    const releaseReceive = this.enterReceive();
    try {
      // **用户明确继续**是唯一能解除「已知全部耗尽等待」的指令（spec 已确认走 A）：
      // 额度恢复、重新判定、额度刷新与改选都不解除；条件由 resumeRun 后续按真实运行状态重核。
      await this.sessionModels.continueExplicitly(session.id);
      // 明确继续是**指令**，不是条件的豁免：清除等待后立即按此刻的真实条件重核，
      // 条件仍不成立就保留工作、不恢复执行（不清除等待以外的事实，不谎报已继续）。
      const admitted = await this.admitRequest(session, [], { resuming: true });
      if (!admitted.ok) {
        this.sessionModels.markWaitingExplicitContinue(session.id, "继续后条件仍不成立，工作保留等待再次明确继续");
        this.commit();
        return;
      }
      // 相位本身由上一步的判定与端口的控制令牌共同裁定：paused／pausing 走恢复（过期会被真实拒绝），
      // faulted 在判定阶段就不可推进。这里不再另设一套相位门槛，避免两处规则各说各话。
      const port = await this.ensurePort(session);
      // 运行中改选的推送可能还在途：恢复前收束它，恢复后的请求才用得到新选择
      await this.settleChoicePush(session.id);
      // 恢复前**权威应用**一次模型与档位：恢复会立刻让执行端继续发请求，
      // 不能带着上一个模型跑。应用不了（端口不具备能力或抛错）就保持暂停并保留这次选择——
      // 恢复成旧模型比不恢复更糟；失败只诊断，不改用户的选择。
      const resumeApplied = await this.applySessionModel(port, session);
      if (!resumeApplied.ok) {
        this.sessionModels.markWaitingExplicitContinue(session.id, "恢复前无法按当前选择应用模型，工作保持暂停；可改选或重新配置后再继续");
        this.commit();
        return;
      }
      // 恢复绑定最近一次明确用户恢复意图对应的控制令牌
      let expected = this.controls.get(session.id);
      if (!expected) {
        const view = await port.read();
        this.applyView(session.id, view);
        expected = view.control;
      }
      try {
        const view = await port.resume(expected);
        this.applyView(session.id, view);
      } catch (error) {
        this.diagnose("resume-failed", error);
        // 恢复失败先只读核真实相位；不能把仍暂停的端口伪装为 faulted，也不能把全部失败伪装 paused。
        // 读新 control 不重投；再次恢复仍须明确意图（规格：任务暂停与恢复）。
        try {
          const fresh = await port.read();
          this.applyView(session.id, fresh);
          const issue: RunIssue = error instanceof Error && error.name === "StaleControlError"
            ? "resume-stale" : "resume-failed";
          this.setRunFaultNote(session.id, issue, this.state.runs[session.id]?.status ?? fresh.phase);
        } catch (readError) {
          this.diagnose("resume-state-unverified", readError);
          this.setRunFaultNote(session.id, "resume-unverified", "faulted");
        }
      }
      this.commit();
    } finally {
      releaseReceive();
    }
  }

  // 设置请求先分别认领，写盘按序消费“已成功提交的事实 + 本次字段”。
  // 不合并未落盘意图：A 失败时，后面只改主题的 B 不能顺带把 A 的名单/default 保存成功。
  private settingsQueue: Promise<void> | null = null;

  // ---------- D：会话模型选择与路由判定 ----------
  //
  // 全部经 SessionModelRegistry（唯一写入者）落地，这里只做归属核对与快照发布。
  // 路由判定**不发起工作**：判定结果与请求成功在 UI 上分别呈现，不合并成一个状态。

  /**
   * D 片操作的共同前置：**会话必须真实存在**，应用未进入关闭收束。
   * 界面传来的标识不被当成对象存在的依据（也不是"先建一个再说"）。
   */
  #requireLiveSession(sessionId: string): Session {
    if (this.closingStarted) throw new Error("app-closing");
    const session = this.state.sessions.find((s) => s.id === sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    return session;
  }

  /** 两层模型入口：第一层来源，第二层按来源分组的模型条目。额度不在这里读（未读即 null）。 */
  async listModelSources(input?: { sessionId?: string }): Promise<ModelSourcesView> {
    if (input?.sessionId) this.#requireLiveSession(input.sessionId);
    const sources = await this.sessionModels.sourcesView();
    return {
      sources,
      defaultChoice: this.sessionModels.defaultChoice(),
      sessionStates: this.sessionModels.list(input?.sessionId),
    };
  }

  /** 设定某条会话的模型选择；只对后续请求生效，不中断当前输出、不重投、不改历史归属。 */
  async setSessionModelChoice(input: { sessionId: string; choice: SessionModelChoice }): Promise<SessionModelState> {
    const session = this.#requireLiveSession(input.sessionId);
    // 目录/能力读取有真实 await：在入口认领，关闭收束才会等这次校验真正结束，
    // 而不是校验结束后才开始发布（那等于在关闭已完成之后又动一次）。
    const release = this.claimStateSave();
    try {
      const state = await this.sessionModels.setChoice(session.id, input.choice);
      // await 之后必须核关闭：已经开始收束时不再发布快照，也不再对正在收束的端口下发。
      // 选择本身已落在注册表里，下次打开端口会按它应用——如实诊断，不假装已生效。
      if (this.closingStarted) {
        this.diagnose("session-model-choice-during-close", new Error("app-closing"));
        return state;
      }
      this.commit();
      this.pushChoiceToOpenPort(session);
      return state;
    } finally {
      release();
    }
  }

  /** 设定条件参数档位；只接受该来源该模型已核实支持的档位，否则如实给出原因而不写入。 */
  async setSessionThinkingLevel(input: { sessionId: string; level: ThinkingLevel | null }): Promise<SessionModelState> {
    const session = this.#requireLiveSession(input.sessionId);
    const release = this.claimStateSave();
    try {
      const state = await this.sessionModels.setThinkingLevel(session.id, input.level);
      // 同上：await 之后核关闭代次，关闭已开始就不再下发与发布。
      if (this.closingStarted) {
        this.diagnose("session-thinking-level-during-close", new Error("app-closing"));
        return state;
      }
      this.commit();
      this.pushChoiceToOpenPort(session);
      return state;
    } finally {
      release();
    }
  }

  /** 每个会话一条在途的改选推送：投递／恢复前必须收束它，保证请求发出时配置已是新的。 */
  /** 目标身份的比较键：换档位也算换了目标（模型与档位要一起应用，不能只比模型）。 */
  private targetKeyOf(target: { sourceId: string; modelId: string; thinkingLevel: string | null } | null): string {
    return target === null ? "" : `${target.sourceId} ${target.modelId} ${target.thinkingLevel ?? ""}`;
  }

  readonly #choicePushes = new Map<string, Promise<void>>();

  /**
   * 改选／改档位后推给**已经打开**的执行端口，让运行中改选在下一次 SDK 请求就生效
   * （Pi 按次读取会话配置；这里经与提交同一�� `applySessionModel` 正式通路下发）。
   *
   * 推送**不阻塞这次改选本身**：执行端正有在途请求时，应用配置可能要等那一轮收束，
   * 把它挂在界面确认路径上会让改选看起来没反应，也堵住随后的暂停／继续。
   * 因此登记后在途推送，投递与恢复前再 `settleChoicePush` 收束——顺序仍然成立。
   *
   * 失败不推翻这次选择：选择已经落地（界面照常呈现），下一次提交仍会按它应用；
   * 这里只如实诊断，不把"已记录"说成"已生效"。
   * 端口未打开、或此刻没有可核对目标（没有判定）：不动执行端——打开时会应用。
   */
  private pushChoiceToOpenPort(session: Session): void {
    const pending = this.ports.get(session.id);
    if (!pending) return;
    if (!this.executionTargetFor(session)) return;
    const previous = this.#choicePushes.get(session.id) ?? Promise.resolve();
    const next = previous
      .then(async () => {
        let port: ExecutionPort;
        try {
          port = await pending;
        } catch (err) {
          this.diagnose("session-model-push-port-unavailable", err);
          return;
        }
        const applied = await this.applySessionModel(port, session);
        if (!applied.ok) this.diagnose("session-model-push-not-applied", new Error(`not-applied:${applied.reason.status}`));
      })
      .catch((err) => {
        this.diagnose("session-model-push-failed", err);
      })
      .finally(() => {
        if (this.#choicePushes.get(session.id) === next) this.#choicePushes.delete(session.id);
      });
    this.#choicePushes.set(session.id, next);
  }

  /**
   * 收束该会话在途的改选推送：真正要发请求／恢复之前调用。
   * 失败已由推送自身诊断并吞掉，这里不把诊断变成投递失败（投递前还有权威的一次应用）。
   */
  private async settleChoicePush(sessionId: string): Promise<void> {
    await this.#choicePushes.get(sessionId);
  }

  /** 只读额度事实。读取不发送输入、不启用执行、不解除暂停，也不因此推进原工作。 */
  async readModelQuota(input: { sessionId?: string; sourceId: string; modelId: string }): Promise<QuotaFacts> {
    return this.sessionModels.readQuota(input.sourceId, input.modelId);
  }

  /**
   * 按当前工作重新判定该会话的模型：能力筛适合候选 → 读有效额度 → 决定采用/有界尝试/保留工作。
   *
   * **运行条件由正式运行状态推导，不接受界面传入的 runnable**：
   * 界面说"可推进"不构成工作可推进的依据——暂停中、正在暂停、等待明确继续、目标失效
   * 都以这里的真实状态为准。已耗尽等待中的工作也不会因这次判定或额度刷新被唤醒。
   */
  async resolveSessionRouting(input: { sessionId: string; references?: readonly WorkReference[] }): Promise<SessionModelState> {
    const session = this.#requireLiveSession(input.sessionId);
    const requires = this.deriveRequires(session, input.references ?? []);
    // 只读判定：不带 resuming —— 这里评估的是**此刻**的运行条件，暂停中就是不可推进。
    const state = await this.sessionModels.resolve(session.id, this.workContextFor(session, requires));
    this.commit();
    return state;
  }

  /**
   * 从**真实发生的记录**推导当前工作提出的能力要求。
   *
   * 每一条要求都要有可核对的来源，没有依据就不提：
   *  · `code-edit`：本次输入带了文件引用 —— 工作确实是围绕这些文件展开的；
   *  · `tool-use`：这条会话的历史里真实出现过工具调用（时间线里的 tool-call 块）；
   *  · `image-input`：本次引用里存在图片文件（按扩展名判定，引用必须真实存在）；
   *  · `long-context`：本次输入与该会话已有正文的真实字符量超过长上下文基准；
   *  · `reasoning`：用户为这条会话明确设过条件参数档位。
   * 没有任何依据时返回空要求——那是"没有提出要求"，不是"默认全都需要"。
   */
  private deriveRequires(session: Session, pendingReferences: readonly { kind: WorkReference["kind"]; locator: string }[]): WorkCapability[] {
    const requires = new Set<WorkCapability>();
    const files = pendingReferences.filter((r) => r.kind === "file");
    if (files.length > 0) requires.add("code-edit");
    if (files.some((r) => IMAGE_EXT.test(r.locator))) requires.add("image-input");
    if ((this.state.timelines[session.id] ?? []).some(block => block.kind === 'tool' && block.tool.images?.length)) requires.add('image-input');
    const blocks = this.state.timelines[session.id] ?? [];
    // 工具调用是**真实发生过**的事实：时间线里确实有工具块，才据此提出工具使用要求。
    if (blocks.some((b) => b.kind === "tool")) requires.add("tool-use");
    const accumulatedChars = blocks.reduce((sum, b) => sum + JSON.stringify(b).length, 0);
    if (accumulatedChars >= LONG_CONTEXT_CHARS) requires.add("long-context");
    if (this.sessionModels.read(session.id).thinkingLevel) requires.add("reasoning");
    return [...requires];
  }

  /** 该会话当前工作的真实条件：可推进性与能力要求都从实际对象/记录推导。 */
  private workContextFor(
    session: Session,
    requires: readonly WorkCapability[],
    options: { resuming?: boolean; requires?: readonly WorkCapability[] } = {},
  ): RoutingWorkContext {
    const model = this.sessionModels.read(session.id);
    const run = this.state.runs[session.id];
    const status = run?.status ?? "ready";
    // 「等待用户明确继续」是独立于运行相位的状态：额度恢复与重新判定都不解除它。
    if (model.waitingExplicitContinue) {
      return { requires, runnable: false, notRunnableReason: "适合候选已知全部耗尽，正在等待你明确继续；额度恢复或改选不会自动继续" };
    }
    // 明确继续时，「已暂停／正在暂停」正是这次指令要解除的相位，不能用它否决自己的恢复
    // （spec 工作流「对暂停工作明确继续」）：**恢复是否成立由执行端的控制令牌裁定**——
    // 暂停尚未收束时那次恢复会被端口按过期拒绝，界面据此呈现「工作状态已变化」，
    // 而不是在这里被提前拦成一个含糊的"条件不成立"。faulted 仍不可推进。
    if (options.resuming === true && (status === "paused" || status === "pausing")) {
      return { requires, runnable: true };
    }
    if (status === "pausing" || status === "paused") {
      return { requires, runnable: false, notRunnableReason: status === "pausing" ? "会话正在暂停" : "会话已暂停" };
    }
    if (status === "faulted") {
      return { requires, runnable: false, notRunnableReason: "运行状态无法核实，需要重新打开后再继续" };
    }
    return { requires, runnable: true };
  }

  /** 设定新会话的默认模型选择：只影响此后新建的会话，不改动任何已存在会话。
   *  **保存成立才发布**：写盘失败时注册表与设置都保持原值。 */
  async setDefaultModelChoice(input: { choice: SessionModelChoice }): Promise<SetDefaultModelChoiceResult> {
    if (this.closingStarted) return { ok: false, choice: this.sessionModels.defaultChoice(), message: "应用正在关闭，无法保存新会话默认" };
    // 首个校验 await 前即认领；已认领工作可收束，关闭后的新调用不能进入校验或写盘。
    const release = this.claimStateSave();
    try {
      const checked = await this.sessionModels.checkDefaultChoice(input.choice);
      if (!checked.ok) return checked;
      const attempt = ++this.settingsSeq;
      await this.saveSettingsPatch({ newSessionModelChoice: checked.choice }, attempt, checked.choice);
      return { ok: true, choice: checked.choice };
    } catch {
      this.commit();
      return { ok: false, choice: this.sessionModels.defaultChoice(), message: "新会话默认未能保存，原设置保持不变" };
    } finally {
      release();
    }
  }

  /**
   * 认领一次设置写入保护（同步、无 await 窗口）：收束会等它结束。
   * 按次登记自己那一个 Promise，释放只移除**自己**——后来者先完成时不能把
   * 仍在进行的先认领者从收束视野里清掉。
   */
  private claimStateSave(): () => void {
    if (this.closingStarted) throw new Error("settings-closing");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tracked = gate.catch(() => undefined);
    this.stateSaveFlights.add(tracked);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
      this.stateSaveFlights.delete(tracked);
    };
  }

  /** 等全部已登记的设置认领/写盘真实收束；期间又有新登记就继续等。 */
  private async awaitStateSaves(): Promise<void> {
    for (;;) {
      const pending = [...this.stateSaveFlights];
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
      // 本轮登记的都还在原地：既没有收束掉，也没有后来者挤进来，才算真正结束
      if (pending.length === this.stateSaveFlights.size && pending.every((f) => this.stateSaveFlights.has(f))) return;
    }
  }

  async updateSettings(input: Partial<Settings>): Promise<Settings> {
    if (this.closingStarted) throw new Error("settings-closing");
    // 普通设置也能携带模型默认并等待目录校验：首个 await 前即认领，关闭不会漏掉校验中的保存。
    const release = this.claimStateSave();
    try {
      return await this.updateClaimedSettings(input);
    } finally {
      release();
    }
  }

  private async updateClaimedSettings(input: Partial<Settings>): Promise<Settings> {
    // 新会话默认值是一份独立事实：**只校验不提交**，等写盘成立后再提交给注册表。
    // 写盘失败时注册表保持原值，此后新建的会话不会按一个没保存上的默认起步。
    let checkedDefault: SessionModelChoice | undefined;
    if (input.newSessionModelChoice !== undefined) {
      const result = await this.sessionModels.checkDefaultChoice(input.newSessionModelChoice);
      if (!result.ok) throw new Error(`拒绝设置新会话默认：${result.message ?? "该来源或模型不可用"}`);
      checkedDefault = result.choice;
    }
    const attempt = ++this.settingsSeq;
    return this.saveSettingsPatch({ ...input, ...(checkedDefault ? { newSessionModelChoice: checkedDefault } : {}) }, attempt, checkedDefault);
  }

  /** 唯一设置写盘队列：前次实际成功／失败收束后，才按正式状态生成本次完整快照。 */
  private saveSettingsPatch(input: Partial<Settings>, attempt: number, checkedDefault?: SessionModelChoice): Promise<Settings> {
    const save = () => {
      const next = { ...this.state.settings, ...input };
      const draft = JSON.parse(JSON.stringify(this.state)) as PersistedState;
      draft.settings = next;
      draft.modelCandidateScopeConfigured = this.state.modelCandidateScopeConfigured === true || input.modelCandidates !== undefined;
      return this.applySavedSettings(draft, next, attempt, checkedDefault);
    };
    // 队列空时立即到达存储；有前次请求时，等待真实结果再取正式值，不提前复制失败意图。
    const flight = this.settingsQueue ? this.settingsQueue.then(save) : save();
    const settled = flight.then(() => undefined, () => undefined);
    this.settingsQueue = settled;
    void settled.then(() => { if (this.settingsQueue === settled) this.settingsQueue = null; });
    return flight;
  }

  private async applySavedSettings(draft: PersistedState, next: Settings, attempt: number, checkedDefault?: SessionModelChoice): Promise<Settings> {
    return await this.serializeStateSave(async () => {
    // 只保留此次设置变更，其余事实在本次排到保存前重新取值。
    const rebased = this.persistedState();
    rebased.settings = next; rebased.modelCandidateScopeConfigured = draft.modelCandidateScopeConfigured;
    try {
      await this.saveState(rebased);
    } catch (cause) {
      this.diagnose("settings-save-failed", cause);
      if (attempt === this.settingsSeq) {
        this.setCloseError("settings-save-failed");
        this.commit();
      } else {
        this.scheduleSave(150);
      }
      throw new Error("settings-save-failed");
    }
    // 默认值与设置都在同次真实保存成立后发布，不能借后续请求承接失败字段。
    if (checkedDefault) this.sessionModels.commitDefaultChoice(checkedDefault);
    this.state.settings = next;
    this.state.modelCandidateScopeConfigured = draft.modelCandidateScopeConfigured;
    if (attempt === this.settingsSeq) {
      if (this.closeError === "settings-save-failed") this.closeError = null;
      this.commit();
    } else {
      this.scheduleSave(150);
    }
    return next;
    });
  }

  // ---------- 执行端协调 ----------

  private newShortTask(workspaceId: string, text: string): Task {
    const task: Task = {
      id: nextId("task"),
      workspaceId,
      parentId: null, // 空间直属短期任务：类型与 parentId 分离
      kind: "short",
      title: text.slice(0, 24) || "未命名任务",
      boundFolder: null,
      isDefault: false,
      updatedAt: Date.now(),
    };
    this.state.tasks.push(task);
    return task;
  }

  private newMainSession(task: Task, text: string): Session {
    const session: Session = {
      id: nextId("session"),
      taskId: task.id,
      title: text.slice(0, 24),
      kind: "main",
      updatedAt: Date.now(),
    };
    this.state.sessions.push(session);
    (this.state.runtimeCreationPending ??= []).push(session.id);
    this.state.timelines[session.id] = [];
    this.state.runs[session.id] = idleRun(session.id);
    // 创建时**固定**模型初值：此后改设置默认不再影响这条会话（改默认只决定此后新建的会话）。
    this.sessionModels.pin(session.id);
    return session;
  }

  private targetOf(session: Session): ExecutionTarget {
    const task = this.state.tasks.find((t) => t.id === session.taskId);
    if (!task) throw new Error(`Unknown task: ${session.taskId}`);
    return { workspaceId: task.workspaceId, taskId: task.id, sessionId: session.id };
  }

  private async ensurePort(session: Session, initialize = false): Promise<ExecutionPort> {
    let pending = this.ports.get(session.id);
    if (!pending) {
      const task = this.state.tasks.find((t) => t.id === session.taskId);
      const workspace = task && this.state.workspaces.find((w) => w.id === task.workspaceId);
      pending = this.currentBackend.open({
        target: this.targetOf(session),
        workFolder: task?.boundFolder ?? workspace?.folders[0] ?? null,
        title: session.title,
        initialize,
        projectAccess: session.kind === 'main' ? 'task-owner' : null,
        projectExtensionsEnabled: () => this.state.settings.projectExtensionsEnabled === true,
        // 打开时先按会话此刻的选择给一个起点；每次真实请求前还会再按当前选择应用一次。
        model: this.executionTargetFor(session),
      });
      this.ports.set(session.id, pending);
      // 打开失败不能留下坏缓存：同一发送的重试应能重新打开
      pending.catch(() => this.ports.delete(session.id));
    }
    return pending;
  }

  private canInitializeRuntime(session: Session): boolean {
    return (this.state.runtimeCreationPending ?? []).includes(session.id)
      && (this.state.timelines[session.id] ?? []).every(block => block.kind === 'message' && block.role === 'user' && block.receipt?.status === 'not-accepted');
  }

  /** 记录建立已由端口确认；这道客户端持久边界成功后才可能进入正式接收。 */
  private async confirmRuntimeCreation(session: Session): Promise<boolean> {
    const running = this.runtimeCreationSaves.get(session.id);
    if (running) return running;
    if (!(this.state.runtimeCreationPending ?? []).includes(session.id)) return true;
    const flight = (async () => {
      this.state.runtimeCreationPending = (this.state.runtimeCreationPending ?? []).filter(id => id !== session.id);
      try { await this.persistNow(); return true; }
      catch {
        if (!(this.state.runtimeCreationPending ?? []).includes(session.id)) this.state.runtimeCreationPending!.push(session.id);
        return false;
      }
    })();
    this.runtimeCreationSaves.set(session.id, flight);
    try { return await flight; } finally { this.runtimeCreationSaves.delete(session.id); }
  }

  /** read 是只读观测：不隐式启动或恢复执行（两种后端都遵守）。 */
  private async latestControl(sessionId: string, port: ExecutionPort): Promise<ControlToken> {
    const known = this.controls.get(sessionId);
    if (known) return known;
    const view = await port.read();
    this.applyView(sessionId, view);
    return view.control;
  }

  /**
   * 请求前的**正式路由裁决**：按此刻的真实工作条件重新判定，判定结果就是本次请求能否发出。
   *
   * 这不是界面的只读查询副产品，而是执行边界本身：
   *  · 「等待明确继续」与任何 `hold-*` 都**保留工作、不提交**，回执如实为 `model-unavailable`；
   *  · 条件成立时把采用目标写进状态，后续 `effectiveTarget` 才能拿到它；
   *  · await 期间若发生改选／暂停／关闭，本次裁决作废（代次比对），不写入任何状态。
   */
  private async admitRequest(
    session: Session,
    references: readonly { kind: WorkReference["kind"]; locator: string }[],
    options: { resuming?: boolean; requires?: readonly WorkCapability[] } = {},
  ): Promise<{ ok: true } | { ok: false; reason: SendReceipt }> {
    const choice = this.sessionModels.read(session.id).choice;
    // 范围依据只有两处事实：会话自己的显式指定，或用户配置的候选名单。
    // **名单被清空不等于绕过已确认的范围** —— 那只说明"用户还没配置候选"，
    // 此时自动模式没有范围可判，也不因此阻断发送（模型配置尚未完成，不是工作条件不成立）。
    const scoped = this.state.settings.modelCandidates.length > 0 || choice.mode === "explicit";
    // 空范围不等于无条件放行：等待明确继续与认证在途都**不依赖候选范围**，
    // 这两条在任何范围下都成立。没有范围可判的是额度与能力，不是全部条件。
    if (!scoped) {
      if (this.state.modelCandidateScopeConfigured) {
        return { ok: false, reason: { status: "not-accepted", operationId: "", reason: "model-unavailable" } };
      }
      if (this.sessionModels.read(session.id).waitingExplicitContinue) {
        return { ok: false, reason: { status: "not-accepted", operationId: "", reason: "model-unavailable" } };
      }
      if (this.authFlowOpenFor(this.requestSourceId(session))) {
        return { ok: false, reason: { status: "not-accepted", operationId: "", reason: "storage-rejected" } };
      }
      return { ok: true };
    }
    const requires = [...new Set([...this.deriveRequires(session, references), ...(options.requires ?? [])])];
    const seq = this.sessionModels.generationOf(session.id);
    const state = await this.sessionModels.resolve(session.id, this.workContextFor(session, requires, options));
    // 裁决期间可能已发生改选／暂停／关闭：**旧结论无效不能推出新的选择可执行**。
    // 这里按"尚未裁决"重新核一次，而不是拿失效的结论放行。
    if (this.sessionModels.generationOf(session.id) !== seq) {
      return this.admitRequest(session, references, options);
    }
    const reject = (): { ok: false; reason: SendReceipt } => ({
      ok: false,
      reason: { status: "not-accepted", operationId: "", reason: "model-unavailable" },
    });
    if (state.waitingExplicitContinue) return reject();
    const decision = state.lastRouting?.decision.kind;
    // 任何 hold 都保留工作：包括"工作当前不可推进"与"判定被更优先事实取代"。
    if (decision === undefined || decision.startsWith("hold-")) return reject();
    // 判定成立但拿不出本次要用的目标：不能带着与用户选择不符的旧配置发出去。
    const target = this.sessionModels.effectiveTarget(session.id);
    if (!target) return reject();
    // 认证在途按**裁决后的实际来源**判：默认来源 A 的登录不拦发往 B 的请求，B 的登录则拦住这条。
    // 放在认领这一步，是因为到这里才知道这次请求实际会用哪个身份——入口处只能看到设置里的当前选择。
    if (this.authFlowOpenFor(target.sourceId)) {
      return { ok: false, reason: { status: "not-accepted", operationId: "", reason: "storage-rejected" } };
    }
    return { ok: true };
  }

  /**
   * **每次 SDK 请求前**的完整准入。
   *
   * 发送、可靠重投与恢复只是三次准入；工具回合会在长输出过程中自己发起后续请求，
   * 那一刻的额度、能力依据、候选范围与认证在途都可能已变。这里复用**同一条**
   * `admitRequest` 判定，按当次事实重核：不另立执行器、不另造历史，
   * 也不重投已接收的输入或重复已完成的工具——不放行时这一轮就此收束，已输出保持。
   */
  async admitSdkRequest(input: { sessionId: string; sourceId: string; modelId: string; requires?: readonly WorkCapability[] }): Promise<{ ok: boolean; reason: string | null; target: SdkRequestTarget | null }> {
    const deny = (reason: string): { ok: boolean; reason: string | null; target: SdkRequestTarget | null } => ({ ok: false, reason, target: null });
    const session = this.state.sessions.find((s) => s.id === input.sessionId);
    if (!session) return deny("会话不存在");
    if (this.closingStarted) return deny("应用正在关闭");
    const state = this.sessionModels.read(session.id);
    // 候选名单被**清空**，而这条会话**已经实际用过**某个模型、却还没形成「等待明确继续」：
    // 发送入口的空名单分支核的是「已形成的等待」与认证在途，这里核的是此刻的采用关系——
    // 名单都不存在了还照旧模型发请求，就等于把用户撤掉的配置当没撤。
    //
    // 只判「整个名单为空」这一种：**名单里换掉/新增某个模型不是移除**，
    // 那条路由每次请求前的路由判定重新核对目标（改选、发新请求都会重核），
    // 在这里拿「上一次实际用的模型」去比，会把正常的改配置误判成越界。
    if (
      state.choice.mode === "auto"
      && this.state.settings.modelCandidates.length === 0
      && this.state.modelCandidateScopeConfigured
    ) {
      return deny("候选名单已被清空，不再沿用此前实际采用的模型");
    }
    const admitted = await this.admitRequest(session, this.acceptedReferencesOf(session), { requires: input.requires });
    if (!admitted.ok) {
      const reason = admitted.reason.status === "not-accepted" ? admitted.reason.reason : "model-unavailable";
      return deny(String(reason));
    }
    // 裁定采用的模型就是**这次该发往的身份**：只说「放行」而不给身份，
    // 执行端就只能继续发它已经准备好的那个——那正是「核准 B、发出 A」。
    const target = this.sessionModels.effectiveTarget(session.id);
    if (target) return { ok: true, reason: null, target };

    // 拿不出路由目标：只有「用户从未配置候选名单」的兼容入口会走到这里。
    // 那不等于免检——沿**本次请求自己的身份**做完整判定（相位、认证在途、能力依据）：
    // 成立就以该身份为权威目标，不成立就如实拒绝。既不用空范围放行，也不盲退执行端已准备的模型。
    const scoped = this.state.settings.modelCandidates.length > 0 || state.choice.mode === "explicit";
    if (scoped) return deny("裁定成立但拿不出本次该用的模型");
    // 兼容配置同样走下面的完整准入，不能进入上方已裁决目标的早退分支。
    const identity = this.executionTargetFor(session) ?? input;
    const requires = [...new Set([...this.deriveRequires(session, this.acceptedReferencesOf(session)), ...(input.requires ?? [])])];
    const work = this.workContextFor(session, requires);
    if (!work.runnable) return deny(work.notRunnableReason ?? "当前工作不允许推进");
    if (this.authFlowOpenFor(identity.sourceId)) return deny("该来源的认证仍在进行中");
    const capabilities = await this.sessionModels.capabilitiesFor(
      { sourceId: identity.sourceId, modelId: identity.modelId },
      requires,
    );
    // 没有能力资料＝没有依据：不能据此放行（spec 33 要求依据可核对）。
    if (!capabilities) return deny(`尚无 ${identity.sourceId}/${identity.modelId} 的可核对能力资料`);
    if (!fitsCapabilities(capabilities, requires)) {
      return deny(`该模型不能满足当前工作要求：${unverifiedRequirements(capabilities, requires).join("、") || "能力不满足"}`);
    }
    const quota = await this.sessionModels.readQuota(identity.sourceId, identity.modelId);
    // 能力和额度读取期间的新选择、暂停、关闭或名单更新优先，旧兼容入口不能越过它们。
    const latest = this.sessionModels.read(session.id);
    if (this.closingStarted || latest.waitingExplicitContinue
      || !this.workContextFor(session, requires).runnable || this.authFlowOpenFor(identity.sourceId)) {
      return deny("读取期间工作条件已变化");
    }
    const latestTarget = this.executionTargetFor(session);
    if (latest.choice.mode !== "auto" || this.state.modelCandidateScopeConfigured
      || (latestTarget !== null && (latestTarget.sourceId !== identity.sourceId || latestTarget.modelId !== identity.modelId))) {
      return this.admitSdkRequest(input);
    }
    if (quota.state === "exhausted") {
      this.sessionModels.markWaitingExplicitContinue(session.id, "当前模型额度已耗尽，工作已保留；需要明确继续");
      this.commit();
      return deny("当前模型额度已耗尽，等待明确继续");
    }
    const thinkingLevel = latest.thinkingLevel && capabilities.thinkingLevels.includes(latest.thinkingLevel)
      ? latest.thinkingLevel : null;
    if (thinkingLevel !== latest.thinkingLevel) {
      await this.sessionModels.setThinkingLevel(session.id, null);
      this.commit();
      if (this.closingStarted || !this.workContextFor(session, requires).runnable) return deny("条件参数核对期间工作条件已变化");
    }
    return { ok: true, reason: null, target: { sourceId: identity.sourceId, modelId: identity.modelId, thinkingLevel } };
  }

  /** 这条会话**已接收**输入里带的引用：后续工具回合仍在做同一份工作，能力要求据此推导。 */
  private acceptedReferencesOf(session: Session): readonly { kind: WorkReference["kind"]; locator: string }[] {
    const blocks = this.state.timelines[session.id] ?? [];
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
      const block = blocks[i]!;
      if (block.kind !== "message" || block.role !== "user") continue;
      if (block.receipt?.status !== "accepted") continue;
      return block.references ?? [];
    }
    return [];
  }

  private async submitToPort(
    session: Session,
    input: { operationId: string; text: string; references: readonly WorkReference[]; mode: "steer" | "follow-up" },
  ): Promise<SendReceipt> {
    // 真正要投递时才裁决：条件不足或等待明确继续 → 保留工作，本次输入如实报未接收。
    const admitted = await this.admitRequest(session, input.references);
    if (!admitted.ok) return { ...admitted.reason, operationId: input.operationId };
    // 记下裁决时的代次与目标：打开端口与读控制令牌这两段 await 里用户可能改选。
    const admittedGeneration = this.sessionModels.generationOf(session.id);
    const admittedTarget = this.executionTargetFor(session);
    // 已接收／未知或已有输出的运行不能靠另一条新输入重建。明确未接收的初始尝试仍可首发。
    const port = await this.ensurePort(session, this.canInitializeRuntime(session));
    const expected = await this.latestControl(session.id, port);
    // 在途的改选推送先收束：它与下面这次权威应用同一份目标，顺序上先来先到。
    await this.settleChoicePush(session.id);
    // 打开窗口里发生了改选／失效：**裁决时的结论不能替现在的目标背书**。
    // 按此刻的目标重新核一次条件——已耗尽的来源不能靠「刚才判过 A」发出去。
    const drifted = this.sessionModels.generationOf(session.id) !== admittedGeneration
      || this.targetKeyOf(this.executionTargetFor(session)) !== this.targetKeyOf(admittedTarget);
    if (drifted) {
      const recheck = await this.admitRequest(session, input.references);
      if (!recheck.ok) return { ...recheck.reason, operationId: input.operationId };
    }
    // 每次真实请求前按**此刻**的会话选择应用模型与条件参数：
    // 改选只影响后续请求，正在输出的那次请求已经在跑，不会被这次应用打断。
    const applied = await this.applySessionModel(port, session, input.operationId);
    if (!applied.ok) return applied.reason;
    if (!await this.confirmRuntimeCreation(session)) return { status: 'not-accepted', operationId: input.operationId, reason: 'storage-rejected' };
    const receipt = toSendReceipt(await port.submit({ target: this.targetOf(session), ...input, expected }));
    // 提交回执只说明**输入是否被接收**，不说明用了哪个模型：实际归属由真实助手条目发布（见 publishRequestFacts）。
    this.sessionModels.noteResult(session.id, receipt.status === "accepted" ? "pending" : "failed");
    return receipt;
  }

  /**
   * 把会话此刻的选择应用到执行端（Pi 侧走 Conversation.configure 正式通路）。
   *
   * 三条边界：
   *  · **只改后续请求**：不中止正在输出的请求、不重投输入、不改历史归属；
   *  · 已在跑的那次请求的档位不改——Pi 把该次请求的 thinkingLevel 记在助手条目里，
   *    那是该次请求的真实归属；
   *  · 没有可核对的模型选择时不擅自换模型，按执行端当前模型继续。
   */
  private async applySessionModel(
    port: ExecutionPort,
    session: Session,
    operationId = "",
  ): Promise<{ ok: true } | { ok: false; reason: SendReceipt }> {
    const target = this.executionTargetFor(session);
    // 没有可核对目标时**不擅自换模型**，但也不能当作"已按选择应用"：如实说明执行端当前配置未被核实。
    if (!target) return { ok: true };
    const apply = (port as unknown as {
      applySessionModel?: (t: { sourceId: string; modelId: string; thinkingLevel: string | null }) => Promise<void>;
    }).applySessionModel;
    // 端口不具备按会话应用模型的能力：这次请求会**用执行端当前配置**发出，
    // 与用户此刻的选择不符 —— 保留工作并如实拒绝，不静默回落旧模型。
    if (typeof apply !== "function") {
      this.diagnose("session-model-apply-unsupported", new Error("execution port cannot apply a session model"));
      return { ok: false, reason: { status: "not-accepted", operationId, reason: "model-unavailable" } };
    }
    try {
      await apply.call(port, target);
      return { ok: true };
    } catch (err) {
      // 应用失败同样不回落：执行端仍是上一个模型，发出去就与用户选择不符。
      this.diagnose("session-model-apply-failed", err);
      return { ok: false, reason: { status: "not-accepted", operationId, reason: "model-unavailable" } };
    }
  }

  /**
   * 从执行端的**真实观测**里发布本次请求事实：来源、模型、响应标识、结果与用量。
   *
   * 只读 `view.entries` 中助手或工具内单次模型结果的 provider/model/responseId/usage——
   * 这些是 Pi 实际发出并保存下来的，不是计划值、不是界面选择、也不是额度推算。
   * 观察器在每次投影后调用；没有真实条目时什么都不发布（actual 保持 null）。
   */
  private publishRequestFacts(sessionId: string, view: ExecutionView): void {
    // 一次观测 = 一批可核对的真实请求。按 responseId 恰好一次入账，
    // 会话累计按本轮视图求和（重复观测与重开都得到同一结果），不按轮询累加。
    const attributions: { identity: ModelIdentity; responseId: string; result: "succeeded" | "failed"; usage: WorkUsage | null }[] = [];
    let requests = 0;
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    // 按视图的**自然顺序**遍历：最后一条才是最近一次真实请求。
    // 不预设条目是「新→旧」还是「旧→新」——两种约定都出现过，
    // 反转一次就会把最旧那次当成"实际采用"（曾见：切到来源 B 后仍显示来源 A 的归属）。
    for (const entry of view.entries) {
      if (entry.kind !== "pi.assistant" && entry.kind !== "dcode.extension-model-result") continue;
      if (!entry.provider || !entry.model || !entry.responseId) continue;
      const provider = entry.provider;
      const model = entry.model;
      const sourceLabel = this.sessionModels.identityLabel(provider) ?? provider;
      const perRequest = entry.usage
        ? { input: entry.usage.input, output: entry.usage.output, cacheRead: entry.usage.cacheRead, cacheWrite: entry.usage.cacheWrite, requests: 1 }
        : null;
      attributions.push({
        identity: { sourceId: provider, modelId: model, sourceLabel, modelLabel: model, accountLabel: null },
        responseId: entry.responseId,
        result: entry.failureKind ? "failed" as const : "succeeded" as const,
        usage: perRequest,
      });
      if (!entry.usage) continue;
      requests += 1;
      input += entry.usage.input;
      output += entry.usage.output;
      cacheRead += entry.usage.cacheRead;
      cacheWrite += entry.usage.cacheWrite;
    }
    if (attributions.length === 0) return;
    const before = this.sessionModels.read(sessionId);
    const after = this.sessionModels.noteRequests(sessionId, {
      attributions,
      totals: requests > 0 ? { input, output, cacheRead, cacheWrite, requests } : null,
    });
    // 真实请求事实是**界面要显示的事实**：发布后必须让快照变脏并重渲染。
    // 不置脏的话，界面会一直停在发布前那份快照上（曾见：用量明明已记录，入口仍显示「尚无记录」）。
    if (JSON.stringify(after) !== JSON.stringify(before)) this.dirty = true;
  }

  /**
   * 任务用量只读汇总：按任务归属聚合该任务的主会话与成员会话。
   *
   * · 范围只含本任务的会话，其它关联任务不因同账户或同面板被计入；
   * · 同一 responseId 已按会话去重，这里不再二次去重；
   * · 无可归属记录时 totals 为 null（不补零），有会话缺 usage 字段时写明缺口。
   */
  private taskUsageSummaries(): Record<string, TaskUsageSummary> {
    const out: Record<string, TaskUsageSummary> = {};
    for (const task of this.state.tasks) {
      const members = this.state.sessions.filter((s) => s.taskId === task.id);
      const scope: TaskUsageScopeEntry[] = [];
      const bySource = new Map<string, TaskUsageBySource>();
      let input = 0;
      let output = 0;
      let cacheRead = 0;
      let cacheWrite = 0;
      let requests = 0;
      const missing: string[] = [];
      for (const session of members) {
        const state = this.sessionModels.read(session.id);
        scope.push({ sessionId: session.id, kind: session.kind, usage: state.usage });
        if (state.usage === null && state.requests.length > 0) missing.push(session.id);
        for (const record of state.requests) {
          if (!record.usage) {
            if (!missing.includes(session.id)) missing.push(session.id);
            continue;
          }
          const prev = bySource.get(record.sourceId);
          const usage = prev ? prev.usage : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 };
          bySource.set(record.sourceId, {
            sourceId: record.sourceId,
            sourceLabel: record.sourceLabel,
            usage: {
              input: usage.input + record.usage.input,
              output: usage.output + record.usage.output,
              cacheRead: usage.cacheRead + record.usage.cacheRead,
              cacheWrite: usage.cacheWrite + record.usage.cacheWrite,
              requests: usage.requests + record.usage.requests,
            },
          });
          input += record.usage.input;
          output += record.usage.output;
          cacheRead += record.usage.cacheRead;
          cacheWrite += record.usage.cacheWrite;
          requests += record.usage.requests;
        }
      }
      out[task.id] = {
        taskId: task.id,
        scope,
        totals: requests > 0 ? { input, output, cacheRead, cacheWrite, requests } : null,
        bySource: [...bySource.values()],
        incompleteReason: missing.length > 0 ? `${missing.length} 条会话的用量字段不完整，未按零补齐` : null,
      };
    }
    return out;
  }

  /**
   * 同一次发送的再次尝试（回执未确认后的重试/重发）：先走只读回查。
   * 找回已接收记录就不再投递；仍未知不盲投；只有可靠 not-found 才允许同身份重试投递
   * （执行端 submit 自身按 operationId 幂等，这里是产品层的找回优先次序）。
   */
  private async recoverOrSubmit(
    session: Session,
    input: { operationId: string; text: string; references: readonly WorkReference[]; mode: "steer" | "follow-up" },
  ): Promise<SendReceipt> {
    const port = await this.ensurePort(session, this.canInitializeRuntime(session));
    const expected = await this.latestControl(session.id, port);
    const workInput = { target: this.targetOf(session), ...input, expected };
    const found = toSendReceipt(await port.lookupReceipt(workInput));
    // 查回只读：已接收（accepted）或仍未知（unknown）都**原样返回**，
    // 不因后来的额度/能力条件变化把既有接收事实倒改成未接收。
    if (found.status !== "not-accepted" || found.reason !== "not-found") return found;
    // 可靠"未接收"且确实还要再投一次：这时才消费完整的正式路由裁决。
    const admitted = await this.admitRequest(session, input.references);
    if (!admitted.ok) return { ...admitted.reason, operationId: input.operationId };
    // 查回是只读的：已接收／仍未知都按原样返回，不因认证在途被改报未接收。
    // 真正要投递的那一步才消费认证判定——retrySend 只核关闭与保存 flight，
    // 若不在这里消费，同身份认证在途时重试仍能实际重投，绕过 send/resume 的门控。
    // 判定按本会话**裁决后**的实际来源（裁决刚做完，这里拿得到最终目标），不是设置里的当前选择。
    if (this.authFlowBlocksRequest(session)) return { status: "not-accepted", operationId: input.operationId, reason: "storage-rejected" };
    const applied = await this.applySessionModel(port, session, input.operationId);
    if (!applied.ok) return applied.reason;
    if (!await this.confirmRuntimeCreation(session)) return { status: 'not-accepted', operationId: input.operationId, reason: 'storage-rejected' };
    return toSendReceipt(await port.submit(workInput));
  }

  /** 只读同步：read 不隐式启动或恢复执行，只把最新观测视图投影进产品状态。 */
  private async syncSession(sessionId: string): Promise<void> {
    if (this.syncing.has(sessionId)) return;
    this.syncing.add(sessionId);
    try {
      const pending = this.ports.get(sessionId);
      if (!pending) return;
      const port = await pending;
      const view = await port.read();
      this.applyView(sessionId, view);
      await this.refreshReceipts(sessionId, port);
      this.commitIfDirty();
    } catch {
      // 同步失败不覆盖已确认状态
    } finally {
      this.syncing.delete(sessionId);
    }
  }

  /**
   * 只读刷新已接收输入的处理状态（根因见 doc/验证记录/组件接续-2026-10-07：
   * 原实现回执只在显式 checkReceipt 时抓取，普通观测永远停在 submit 当时的 processing）。
   * 随每次普通观测沿同一 lookupReceipt 通路推进；只读回查不提交、不重投；
   * 期间被重试/显式回查更新的块不覆盖（以对象引用区分同一事实）。
   */
  private async refreshReceipts(sessionId: string, port: ExecutionPort): Promise<void> {
    const blocks = this.state.timelines[sessionId];
    if (!blocks) return;
    const session = this.state.sessions.find((s) => s.id === sessionId);
    if (!session) return;
    for (const block of blocks) {
      if (block.kind !== "message" || block.role !== "user" || !block.operationId || !block.mode) continue;
      const receipt = block.receipt;
      if (!receipt || receipt.status !== "accepted") continue;
      if (receipt.processing === "done" || receipt.processing === "unanswered") continue;
      const expected = await this.latestControl(sessionId, port);
      const next = toSendReceipt(
        await port.lookupReceipt({
          target: this.targetOf(session),
          operationId: block.operationId,
          text: block.text,
          // 与 checkReceipt / lookUpOnly 同口径按历史身份复原引用：漏掉引用会让带引用的
          // 已接收发送被 #lookup 判成另一份输入，把 accepted 改写成 conflict（2026-10-11 E2E 实测）。
          references: identityOnlyReferences(block.references),
          mode: block.mode,
          expected,
        }),
      );
      // 等待回查期间可能已有更新的重试/回查结果覆盖该块：不同时空较旧观测不回写
      if (block.receipt !== receipt) continue;
      // #lookup 的读取失败以 unknown 返回而不是抛错；不能撤销已确认接收或让后续自然刷新停刷。
      // unknown 不证明处理完成，保留原 accepted/processing；下一 tick 继续只读核对。
      if (next.status === "unknown") continue;
      if (JSON.stringify(next) === JSON.stringify(receipt)) continue;
      block.receipt = next;
      this.markDirty();
    }
  }

  private findUserBlock(sessionId: string, blockId: string) {
    const blocks = this.state.timelines[sessionId] ?? [];
    const block = blocks.find((b) => b.id === blockId && b.kind === "message" && b.role === "user");
    if (!block || block.kind !== "message") throw new Error("消息块不存在");
    return block;
  }

  /**
   * 按发送身份定位既有正式记录（时间线用户块携带 operationId）。
   * 「应用已接收」不以界面是否收到应答为准：外层回执丢失或重开后，同一 operationId
   * 仍能定位原会话并只读找回，而不是重建第二套对象。
   */
  private locateByOperation(operationId: string): Session | null {
    for (const [sessionId, blocks] of Object.entries(this.state.timelines)) {
      const hit = blocks.find((b) => b.kind === "message" && b.role === "user" && b.operationId === operationId);
      if (hit) return this.state.sessions.find((s) => s.id === sessionId) ?? null;
    }
    return null;
  }

  private appendUserBlock(
    session: Session,
    input: { operationId: string; text: string; references: readonly WorkReference[]; mode: "steer" | "follow-up"; receipt: SendReceipt },
  ): void {
    // 同一次发送的重复提交（同 operationId）只保留一个消息块，回执就地更新
    const blocks = (this.state.timelines[session.id] ??= []);
    const existing = blocks.find(
      (b) => b.kind === "message" && b.role === "user" && b.operationId === input.operationId,
    );
    if (existing && existing.kind === "message") {
      existing.receipt = input.receipt;
      existing.at = Date.now();
      return;
    }
    blocks.push({
      kind: "message",
      id: nextId("msg"),
      role: "user",
      text: input.text,
      // 历史只留引用身份与快照元数据；正文不进时间线，避免每次快照搬运整份内容。
      references: input.references.map(toReferenceSummary),
      streaming: false,
      at: Date.now(),
      operationId: input.operationId,
      mode: input.mode,
      receipt: input.receipt,
    });
  }

  /**
   * 视图新鲜度：observation 是观测顺序号而非内容版本。
   * 跨实例先核 control.instanceId（换实例后重置基准）；同实例按观测顺序拒旧视图。
   */
  private applyView(sessionId: string, view: ExecutionView): void {
    const seen = this.views.get(sessionId);
    if (seen && seen.instanceId === view.control.instanceId && view.observation <= seen.observation) {
      return; // 旧视图：不覆盖更新鲜的已确认状态
    }
    this.views.set(sessionId, { instanceId: view.control.instanceId, observation: view.observation });
    this.controls.set(sessionId, view.control);
    // 顺序关键（2026-10-09 401 修复）：
    // applyRunState 处理相位与「老 errorNote vs 新相位」的清理规则（resume-* 按相位清；
    // auth-failed/model-request-failed 跨相位保留）；projectEntries 之后才按这一次新到达的
    // 条目写入新失败/成功事实。若颠倒顺序，同一次观测带来的「run.status 从 running 收束为 ready」
    // 会把刚由本次新增条目录入的 auth-failed 又覆盖回 null，UI 永远看不到错误。
    this.applyRunState(sessionId, view);
    this.projectEntries(sessionId, view);
    // 真实请求事实（实际归属、响应标识、结果、用量）在**观测投影口**发布：
    // 发送前的那次读只能证明提交用了什么计划，发不出真实请求发生过的事实。
    // 漏在这里的表现是运行结束后 actual 永远为空（曾见：只在 latestControl 发布）。
    this.publishRequestFacts(sessionId, view);
  }

  /** 投影层：只追加新 entry（按 id 游标），内容是否变化在这里比对，不拿 observation 当内容版本。
   *  每一条 entry 为 assistant 且带 failureKind 时更新 run.errorNote（新失败覆盖旧错误；
   *  新成功 assistant 清掉 errorNote）；已过去的失败不因重新投影再次呈现。 */
  private projectEntries(sessionId: string, view: ExecutionView): void {
    const through = this.projectedThrough.get(sessionId) ?? -1;
    let max = through;
    let appended = false;
    const blocks = (this.state.timelines[sessionId] ??= []);
    // 重开后游标归零，已持久化块会再次出现在视图里：按稳定投影身份去重，
    // 不把同一历史条目再次追加（投影 id 由 entry.id 派生，见 projectEntry）。
    const known = new Set(blocks.map((b) => b.id));
    for (const entry of view.entries) {
      if (entry.id <= through) continue;
      max = Math.max(max, entry.id);
      const block = projectEntry(entry);
      if (block && !known.has(block.id)) {
        known.add(block.id);
        blocks.push(block);
        appended = true;
      }
      if (block && entry.toolResult && known.has(block.id)) {
        const index = blocks.findIndex(current => current.id === block.id);
        const original = blocks[index];
        if (original && JSON.stringify({ ...block, at: original.at }) !== JSON.stringify(original)) {
          blocks[index] = { ...block, at: original.at }; appended = true;
        }
      }
      if (entry.toolResult?.changes.length) {
        const id = `pi-changes-${entry.id}`;
        if (!known.has(id)) { known.add(id); blocks.push({ kind: 'change-summary', id, files: entry.toolResult.changes, at: block?.at ?? Date.now() }); appended = true; }
      }
      // 失败/成功事实更新 errorNote；新条目才算（entry.id > through），保留历史已接收输入
      if (entry.kind === "pi.assistant") {
        if (entry.failureKind) {
          this.setRunFaultNote(sessionId, entry.failureKind, this.state.runs[sessionId]?.status ?? "ready");
          appended = true;
        } else if (entry.assistantText && entry.assistantText.length > 0) {
          // 新成功 assistant（无 failureKind、带正文）→ 清除当前 errorNote（成功不属于任何错误码）
          const cur = this.state.runs[sessionId];
          if (cur && (cur.errorNote === "auth-failed" || cur.errorNote === "model-request-failed")) {
            this.state.runs[sessionId] = { ...cur, errorNote: null, updatedAt: Date.now() };
            appended = true;
          }
        }
      }
    }
    this.projectedThrough.set(sessionId, max);
    if (appended) this.markDirty();
  }

  private applyRunState(sessionId: string, view: ExecutionView): void {
    const note =
      view.phase === "paused"
        ? "已暂停"
        : view.phase === "pausing"
          ? "暂停处理中"
          : view.phase === "running"
            ? "执行中"
            : view.phase === "faulted"
              ? ""
              : "";
    const current = this.state.runs[sessionId];
    if (
      current &&
      current.status === view.phase &&
      current.note === note &&
      current.pendingInputs === view.pendingInputs
    ) {
      return; // 无变化不重渲染、不重写
    }
    // errorNote 分两类生命周期：
    // - resume-* (resume-stale/failed/unverified)：与 resume 相位绑定，相位变化后清；
    // - auth-failed / model-request-failed：与「最近一次模型请求结果」绑定，
    //   相位变化（running→ready 收束）本身不能清；必须由后续新成功 assistant 或新一轮请求显式清除。
    const clearResumeOnly = current?.errorNote === "resume-stale" || current?.errorNote === "resume-failed" || current?.errorNote === "resume-unverified";
    const errorNote = current?.status === view.phase
      ? current.errorNote
      : clearResumeOnly ? null : current?.errorNote ?? null;
    this.state.runs[sessionId] = {
      sessionId,
      status: view.phase,
      note,
      errorNote,
      restored: current?.status === view.phase && view.phase === "paused" ? current.restored : false,
      pendingInputs: view.pendingInputs,
      updatedAt: Date.now(),
    };
    this.markDirty();
  }

  /** 状态只走 status；errorNote 承载真实拒绝/故障，实际相位改变后清除。 */
  private setRunStatus(sessionId: string, status: RunState["status"]): void {
    const current = this.state.runs[sessionId] ?? idleRun(sessionId);
    this.state.runs[sessionId] = { ...current, status, updatedAt: Date.now() };
  }

  private setRunFaultNote(sessionId: string, message: RunIssue, status: RunState["status"]): void {
    const current = this.state.runs[sessionId] ?? idleRun(sessionId);
    this.state.runs[sessionId] = { ...current, status, errorNote: message, updatedAt: Date.now() };
  }

  private startPolling(): void {
    const tick = async (): Promise<void> => {
      this.pollTimer = null;
      // 同步所有已打开端口：ready→running 等跃迁与收束后的 paused/faulted 都靠观测推进，
      // 不能只盯 running/pausing（暂停收束后的视图刷新同样依赖这里）。
      // 回执处理状态的普通观测刷新同挂在 syncSession（T02：不依赖用户手动回查）。
      for (const sessionId of this.ports.keys()) {
        await this.syncSession(sessionId);
      }
      this.commitIfDirty();
      // 观测循环的所有权只在这里：无端口时也必须续命，否则首屏停留超过一个周期后
      // 轮询永久停止，ensurePort 之后的真实结果与暂停收束再也不推到界面（E2E 全量曾因此失联）。
      if (!this.closingStarted) this.pollTimer = setTimeout(() => void tick(), POLL_MS);
    };
    this.pollTimer = setTimeout(() => void tick(), POLL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  /** 立即落盘（绕过 150ms 防抖）：首发两阶段的对象/关联必须在执行端接收前真实持久化。 */
  private async persistNow(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    // 同在途设置写盘协调：等**全部**已开始的设置写盘真实收束（若在等的途中又来新的，继续等），
    // 避免较旧配置快照在队列中盖回真实结果
    await this.awaitStateSaves();
    await this.saveState(JSON.parse(JSON.stringify(this.state)) as PersistedState);
  }

  private markDirty(): void {
    this.dirty = true;
  }

  private commitIfDirty(): void {
    // 投影/运行态在 applyView 里已就地更新；无变化不重渲染、不重置延迟落盘
    if (this.dirty) this.commit();
  }

  private touchTask(taskId: string): void {
    const task = this.state.tasks.find((t) => t.id === taskId);
    if (task) task.updatedAt = Date.now();
  }
}

function idleRun(sessionId: string): RunState {
  return { sessionId, status: "ready", note: "", pendingInputs: 0, updatedAt: Date.now() };
}

/** 把执行端 entry 投影为时间线块；未知 kind 跳过。 */
function projectEntry(entry: ExecutionView['entries'][number]): TimelineBlock | null {
  const at = Date.now();
  if (entry.extensionMessage?.display) return {kind:'extension-message',id:`pi-ext-${entry.id}`,customType:entry.extensionMessage.customType,text:entry.extensionMessage.text,at};
  if (entry.kind === "pi.assistant") {
    // 助手正文走正式字段（主树已补合同），没有正文的条目不产生空泡
    if (!entry.assistantText) return null;
    return { kind: "message", id: `pi-msg-${entry.id}`, role: "assistant", text: entry.assistantText, streaming: false, at };
  }
  if (entry.kind === "pi.tool-result") {
    if (entry.toolResult) {
      const result = entry.toolResult;
      return { kind: 'tool', id: `pi-tool-${entry.id}`, at, tool: {
        name: result.name, primaryText: result.text.split('\n')[0]?.slice(0, 160) || result.name,
        output: [result.text, result.changeNotice].filter(Boolean).join('\n\n'),
        status: result.isError ? 'failed' : 'done', ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
        changedFiles: result.changes.map(file => file.path),
        ...(result.images?.length ? { images: result.images } : {}),
      } };
    }
    const data = (entry.data ?? {}) as { diagnostics?: ReadonlyArray<{ severity: string; message: string; code?: string }> };
    const diagnostics = data.diagnostics ?? [];
    const lines = diagnostics.map((d) => `[${d.severity}]${d.code ? ` ${d.code}:` : ""} ${d.message}`);
    const failed = diagnostics.some((d) => d.severity === "error");
    return {
      kind: "tool",
      id: `pi-tool-${entry.id}`,
      tool: {
        name: "tool-result",
        primaryText: lines.join("；") || "",
        output: lines.join("\n"),
        status: failed ? "failed" : "done",
        changedFiles: [],
      },
      at,
    };
  }
  if (entry.kind === "mock.assistant") {
    const data = entry.data as { text?: string };
    return { kind: "message", id: `mock-msg-${entry.id}`, role: "assistant", text: data.text ?? "", streaming: false, at };
  }
  if (entry.kind === "mock.tool") {
    return { kind: "tool", id: `mock-tool-${entry.id}`, tool: entry.data as never, at };
  }
  if (entry.kind === "mock.change") {
    const data = entry.data as { files?: never };
    return { kind: "change-summary", id: `mock-chg-${entry.id}`, files: (data.files ?? []) as never, at };
  }
  if (entry.kind === "mock.marker") {
    const data = entry.data as { marker?: never; text?: string };
    return { kind: "run-marker", id: `mock-mrk-${entry.id}`, marker: data.marker ?? "finished", text: data.text ?? "", at };
  }
  return null;
}

/** 旧版持久化状态规范化：显式 kind 字段、相位化运行状态、剔除旧权限块、补首发关联表。 */
/** 图片引用按扩展名判定；引用必须真实存在于本次输入里，不从偏好推断。 */
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|heic|avif)$/i;
/** 长上下文基准：按真实字符量与四字符约一 token 的保守上界比较。 */
const LONG_CONTEXT_CHARS = 128_000 * 4;

function normalizeLegacy(state: PersistedState): PersistedState {
  // 旧状态文件没有首发在途关联表：补空表（无在途记录可恢复，不虚构关联）
  state.pendingFirstSends ??= {};
  // 旧文件没有初始化关联，不据空历史猜“尚未执行”；畸形标记不给新根创建许可。
  const sessionIds = new Set(state.sessions.map(session => session.id));
  state.runtimeCreationPending = Array.isArray(state.runtimeCreationPending)
    ? [...new Set(state.runtimeCreationPending.filter(id => typeof id === 'string' && sessionIds.has(id)))] : [];
  // D 片新增字段：旧文件没有会话模型状态表与新会话默认，补缺省值（自动）而不是猜一个已选模型
  state.sessionModels ??= {};
  state.settings.newSessionModelChoice ??= { mode: "auto" };
  // 候选名单是 D 片新增字段：旧文件没有 = 尚未配置候选 = 自动模式没有范围（不扩大到目录全部）。
  state.settings.modelCandidates ??= [];
  state.modelCandidateScopeConfigured = typeof state.modelCandidateScopeConfigured === "boolean"
    ? state.modelCandidateScopeConfigured : state.settings.modelCandidates.length > 0;
  for (const task of state.tasks) {
    if (task.kind !== "long" && task.kind !== "short") {
      task.kind = task.parentId ? "short" : "long";
    }
  }
  for (const [sessionId, blocks] of Object.entries(state.timelines)) {
    // 旧持久化文件可能含已移除的权限块（旧形态）：加载时剔除
    state.timelines[sessionId] = (blocks as Array<TimelineBlock | { kind: string }>).filter(
      (b) => b.kind !== "permission",
    ) as TimelineBlock[];
  }
  for (const run of Object.values(state.runs)) {
    const legacy = run.status as string;
    if (legacy === "idle" || legacy === "finished") run.status = "ready";
    else if (legacy === "waiting-permission") run.status = "paused";
    if (run.errorNote && !["resume-stale", "resume-failed", "resume-unverified", "auth-failed", "model-request-failed"].includes(run.errorNote)) run.errorNote = "resume-failed";
    run.pendingInputs = typeof run.pendingInputs === "number" ? run.pendingInputs : 0;
  }
  return state;
}
