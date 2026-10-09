// D Code 应用层：工作空间／任务／会话归属与运行协调。
// 状态唯一写入者；通过注入的执行后端与存储适配器工作，不反向引用具体实现。
// 执行端只认 ExecutionBackend（一次运行只装配 mock 或 Pi 之一）；
// 时间线块由 read() 的 entries 在投影层统一投影，renderer 不接触执行端类型。

import type {
  AppSnapshot,
  DCodeOperations,
  AppIssue,
  RunIssue,
  RunState,
  SendReceipt,
  SendResult,
  Session,
  Settings,
  Task,
  TimelineBlock,
} from "@/contracts";
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
import { toSendReceipt } from "@/contracts";
import type { ModelSetupRecord as PiModelSetupRecord } from "@/contracts";

/** 原子提交所需的扩展接口：主进程装配把 ModelSetupStore 作为本接口注入；应用层不感知 fs。 */
export interface ModelSetupStorePort {
  read(): Promise<PiModelSetupRecord | null>;
  write(record: PiModelSetupRecord): Promise<void>;
  remove(): Promise<void>;
  commitWithCredential(input: {
    provider: PiModelSetupRecord["provider"];
    label: string;
    modelId: string;
    baseUrl: string;
    note: PiModelSetupRecord["note"];
    keyAction: "replace" | "keep" | "clear";
    apiKey?: string;
  }): Promise<PiModelSetupRecord>;
}

let counter = 0;
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

const POLL_MS = 500;

export class DCodeApplication implements DCodeOperations {
  private state: PersistedState;
  private currentBackend: ExecutionBackend;
  private readonly storage: StorageAdapter;
  private readonly initialState: () => PersistedState;
  private readonly diagnose: (event: string, cause: unknown) => void;
  private readonly modelSetupStore: ModelSetupStorePort | null;
  /** 由 main 注入：根据连接字段同步构造新 backend（不再负责凭据，凭据由 store 统一提交）。
   *  传入时应用层已 trim 完毕；调用方在提交前预构造时使用与 saved 同形状的 format=1 记录。 */
  private readonly modelSetupBackendFactory?: (record: PiModelSetupRecord) => ExecutionBackend;
  private readonly listeners = new Set<(snapshot: AppSnapshot) => void>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  // 执行端运行态（不持久化）：端口、最近控制令牌、投影游标与视图新鲜度记录。
  // 首发在途关联不在此列——它必须随 state 持久化，重开后才能复用同一对象与操作身份。
  private readonly ports = new Map<string, Promise<ExecutionPort>>();
  private readonly controls = new Map<string, ControlToken>();
  private readonly views = new Map<string, { instanceId: string; observation: number }>();
  private readonly projectedThrough = new Map<string, number>();
  private readonly syncing = new Set<string>();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private flushPromise: Promise<void> | null = null;
  private closeError: AppIssue | null = null;
  private closeErrorRevision = 0;
  private dirty = false;
  // 设置操作并发：后来者接管结果呈现；在途设置写盘受 settingsSaveFlight 保护，
  // 统一延迟落盘所说的旧快照在此期间不入队，flush/persistNow 也先等它收束
  private settingsSeq = 0;
  private settingsSaveFlight: Promise<unknown> | null = null;

  constructor(
    currentBackend: ExecutionBackend,
    storage: StorageAdapter,
    initialState: () => PersistedState = seedState,
    diagnose: (event: string, cause: unknown) => void = () => undefined,
    modelSetupStore: ModelSetupStorePort | null = null,
    modelSetupBackendFactory?: (record: PiModelSetupRecord) => ExecutionBackend,
  ) {
    this.currentBackend = currentBackend;
    this.storage = storage;
    this.initialState = initialState;
    this.diagnose = diagnose;
    this.modelSetupStore = modelSetupStore;
    this.modelSetupBackendFactory = modelSetupBackendFactory;
    this.state = this.initialState();
  }

  async init(): Promise<void> {
    const loaded = await this.storage.load();
    let maySave = true;
    if (loaded.status === "ok") {
      this.state = normalizeLegacy(loaded.state);
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
        await this.storage.save(this.state);
      } catch (error) {
        this.setCloseError("initial-save-failed");
        this.diagnose("initial-save-failed", error);
      }
    }
    await this.restoreModelSetup();
    this.startPolling();
  }

  /** model-setup.json 由 ModelSetupStore 统一原子写；应用层只调接口，不感知 fs。 */
  private async readModelSetupFile(): Promise<PiModelSetupRecord | null> {
    if (!this.modelSetupStore) return null;
    try { return await this.modelSetupStore.read(); }
    catch (err) { this.diagnose("model-setup-read-failed", err); return null; }
  }

  subscribe(listener: (snapshot: AppSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private snapshot(): AppSnapshot {
    const base = JSON.parse(JSON.stringify(this.state)) as AppSnapshot & Partial<Omit<PersistedState, "model" | "modelSetup">>;
    // 首发在途关联是应用层内部协调状态，不通过桥暴露给界面
    delete base.pendingFirstSends;
    // 可用性唯一依据：宿主实际装配 + 已配置记录里**确有凭据**（keyAction=clear 后 backend 仍在但
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
    base.closeError = this.closeError;
    base.closeErrorRevision = this.closeErrorRevision;
    return base;
  }

  private modelSetupSnapshot(): import("@/contracts").ModelSetupStatus {
    if (!this.modelSetupRecord) return { kind: "unconfigured" };
    const last = this.modelSetupRecord;
    const note: import("@/contracts").ModelSetupNote = this.currentBackend.modelName === null ? "connect-failed" : last.note;
    return {
      kind: "configured",
      label: last.label,
      provider: last.provider,
      modelId: last.modelId,
      baseUrl: last.baseUrl,
      note,
      hasKey: last.hasKey,
    };
  }

  private modelSetupRecord: {
    label: string;
    provider: import("@/contracts").ModelSetupInput["provider"];
    modelId: string;
    baseUrl: string;
    note: import("@/contracts").ModelSetupNote;
    hasKey: boolean;
  } | null = null;

  private async restoreModelSetup(): Promise<void> {
    this.modelSetupRecord = null;
    const file = await this.readModelSetupFile();
    if (!file) return;
    const note: import("@/contracts").ModelSetupNote =
      this.currentBackend.modelName === null
        ? "connect-failed"
        : file.note === "ready"
          ? "ready"
          : "auth-unverified";
    this.modelSetupRecord = {
      provider: file.provider,
      label: file.label,
      modelId: file.modelId,
      baseUrl: file.baseUrl,
      note,
      hasKey: Boolean(file.credential),
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
    // 关闭收束已开始（flushPromise 缓存非空）即关闭正在/已经完成：flush 是「关闭即将发生」的单一事实，
    // flushPromise 缓存永久不重做；此时继续写入会绕过最后一次收束。已开始的 modelSetupFlight 仍由 flush
    // 真实等完；之后才进入关闭路径。
    if (this.flushPromise) return { ok: false, issue: "storage-failed", message: "应用正在关闭，无法保存配置" };
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
        const current = this.modelSetupRecord;
        if (input.keyAction === "keep") {
          if (!current) return { ok: false, issue: "no-existing-key", message: "尚未保存过凭据，无法沿用；选择更换并输入新 key" };
          if (current.provider !== input.provider) return { ok: false, issue: "no-existing-key", message: "协议变更需要新 key" };
          try {
            if (new URL(current.baseUrl).origin !== new URL(input.baseUrl).origin) {
              return { ok: false, issue: "no-existing-key", message: "origin 变更需要新 key" };
            }
          } catch { return { ok: false, issue: "invalid-input", message: "baseUrl 无法解析" }; }
          // 落盘 credential 必须真实存在才算 keep 成立；读失败（损坏）直接返回 storage-failed
          let stored;
          try { stored = await store.read(); }
          catch (err) {
            this.diagnose("model-setup-read-failed", err);
            return { ok: false, issue: "storage-failed", message: "读取已保存配置失败；请稍后重试" };
          }
          if (!stored?.credential) return { ok: false, issue: "no-existing-key", message: "已保存配置不含凭据，无法沿用；选择更换并输入新 key" };
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
        const candidateRecord = {
          format: 1 as const,
          provider: input.provider,
          label: input.label.trim(),
          modelId: input.modelId.trim(),
          baseUrl: input.baseUrl.trim(),
          note: "ready" as const,
        };
        let nextBackend: ExecutionBackend;
        if (input.keyAction === "clear") {
          nextBackend = { kind: "unavailable", modelName: null, async open() { throw new Error("execution-unavailable"); } };
        } else {
          try {
            nextBackend = backendFactory(candidateRecord);
          } catch (err) {
            this.diagnose("model-setup-backend-build-failed", err);
            return { ok: false, issue: "storage-failed", message: "候选配置无法构造后端；请检查后重试" };
          }
        }

        // 原子提交点：commitWithCredential 是最后一步可能失败的必需操作。
        const saved = await store.commitWithCredential({
          ...candidateRecord,
          keyAction: input.keyAction,
          apiKey: input.keyAction === "replace" ? input.apiKey : undefined,
        });

        // 提交成功 → 立即发布已就绪的新 backend（同步内存赋值）。
        this.currentBackend = nextBackend;
        this.modelSetupRecord = {
          provider: saved.provider,
          label: saved.label,
          modelId: saved.modelId,
          baseUrl: saved.baseUrl,
          note: "ready",
          hasKey: Boolean(saved.credential),
        };
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
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      // 在途设置写盘期间不排保存：避免较旧 settings 快照插到真实 FIFO 的设置写入之后；
      // 该设置写盘的真实完成会统一重新调度（见 applySavedSettings 的收束分支）
      if (this.settingsSaveFlight) return;
      // 保存失败必须进入可见通路（快照 banner），不是只记日志；只通知，不再排保存避免循环
      void this.storage.save(JSON.parse(JSON.stringify(this.state)) as PersistedState).catch((error: unknown) => {
        this.setCloseError("save-failed");
        this.diagnose("save-failed", error);
        const snap = this.snapshot();
        for (const listener of this.listeners) listener(snap);
      });
    }, ms);
  }

  /**
   * 正常关闭收束：逐个 await 全部会话 close() + 存储收束的真实结果。
   * 任何失败都保留可见状态（closeError 进快照）、不伪报成功；
   * 同实例后续 flush 复用同一个 Promise（端口层 close 亦复用同一结果）。
   */
  async flush(): Promise<void> {
    if (!this.flushPromise) {
      this.flushPromise = (async () => {
        this.stopPolling();
        if (this.saveTimer) clearTimeout(this.saveTimer);
        // 全部已开始的设置写盘先真实收束：最终保存不得用较旧的设置覆盖真实在途写入
        for (;;) {
          const flight = this.settingsSaveFlight;
          if (!flight) break;
          await flight.catch(() => undefined);
          if (this.settingsSaveFlight === flight) break;
        }
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
          await this.storage.save(JSON.parse(JSON.stringify(this.state)) as PersistedState);
        } catch (error) {
          failures.push("state-save");
          this.diagnose("close-save-failed", error);
        }
        if (failures.length) {
          this.setCloseError("close-failed");
          this.commit();
          throw new Error("close-failed");
        }
      })();
    }
    return this.flushPromise;
  }

  async getSnapshot(): Promise<AppSnapshot> {
    return this.snapshot();
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
    this.state.timelines[session.id] = [];
    this.state.runs[session.id] = idleRun(session.id);
    this.commit();
    return session;
  }

  async sendMessage(input: {
    sessionId?: string;
    taskId?: string;
    text: string;
    mode: "steer" | "follow-up";
    operationId?: string;
  }): Promise<SendResult> {
    const text = input.text.trim();
    if (!text) throw new Error("空消息不发送");
    // 凭据已被清除（keyAction=clear）后，即便 backend 仍在也不得视为可执行——避免无 key 状态下真实发请求
    if (this.currentBackend.modelName === null) throw new Error("execution-unavailable");
    if (this.modelSetupRecord !== null && this.modelSetupRecord.hasKey === false) throw new Error("execution-unavailable");
    // 模型配置保存进行中不允许发送穿透：发送必须看到已提交的 backend
    if (this.modelSetupFlight) return { sessionId: input.sessionId ?? "", receipt: { status: "not-accepted", operationId: input.operationId ?? "", reason: "storage-rejected" } };
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
    const receipt = reusedOperation
      ? await this.recoverOrSubmit(session, { operationId, text, mode: input.mode })
      : await this.submitToPort(session, { operationId, text, mode: input.mode });
    this.appendUserBlock(session, { operationId, text, mode: input.mode, receipt });
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
    // 保存 flight 在途时同身份重试不得穿透（旧 port 正在被 close 或backend即将替换）
    if (this.modelSetupFlight) return { sessionId: session.id, receipt: { status: "not-accepted", operationId: block.operationId, reason: "storage-rejected" } };
    const releaseReceive = this.enterReceive();
    try {
      // 同次重试：复用同一 operationId + 原目标 + 原文 + 模式；先只读回查找回，可靠未找到才重投
      const receipt = await this.recoverOrSubmit(session, { operationId: block.operationId, text: block.text, mode: block.mode });
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
    // 保存 flight 在途时回查不得穿透（旧 port 正在被 close，回查结果会失真）
    if (this.modelSetupFlight) return { sessionId: session.id, receipt: { status: "unknown", operationId: block.operationId, reason: "storage-unavailable" } };
    const releaseReceive = this.enterReceive();
    try {
      const port = await this.ensurePort(session);
      const expected = await this.latestControl(session.id, port);
      // 只读回查（lookupReceipt）：不执行工作，终态也可查；结果未知不盲投
      const receipt = toSendReceipt(await port.lookupReceipt({
        target: this.targetOf(session),
        operationId: block.operationId,
        text: block.text,
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
    // 保存 flight 在途时暂停被拒：旧 port 正在被 close，新 backend 未发布；产品没有"结束本轮"操作，只能等保存完成
    if (this.modelSetupFlight) throw new Error("model-setup-in-flight");
    const releaseReceive = this.enterReceive();
    try {
      const port = await this.ensurePort(session);
      // 先呈现「暂停处理中」：pause() 在收束完成后才返回（对齐真实 Pi 的收束语义），
      // 中间态由这里先行登记，收束视图返回后再覆盖为真实状态。
      this.setRunStatus(session.id, "pausing");
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
    // 保存 flight 在途时恢复被拒：等保存完成后由用户在新 backend 上显式恢复；不能丢锁盲续
    if (this.modelSetupFlight) throw new Error("model-setup-in-flight");
    const releaseReceive = this.enterReceive();
    try {
      const port = await this.ensurePort(session);
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

  // 设置保存复用 r1 的 staged/FIFO 保证：未保存值不进入正式快照；普通保存及关闭等真实在途写盘。
  // 意图副本由应用层唯一维护，合并并发字段；每次实际写盘结果才更新正式值。
  private settingsIntent: Settings | null = null;

  async updateSettings(input: Partial<Settings>): Promise<Settings> {
    const next = { ...(this.settingsIntent ?? this.state.settings), ...input };
    this.settingsIntent = next;
    const attempt = ++this.settingsSeq;
    const draft = JSON.parse(JSON.stringify(this.state)) as PersistedState;
    draft.settings = next;
    const flight = this.applySavedSettings(draft, next, attempt);
    const tracked = flight.catch(() => undefined);
    this.settingsSaveFlight = tracked;
    try {
      return await flight;
    } finally {
      // A 完成不能清掉 B 在途保护。
      if (this.settingsSaveFlight === tracked) {
        this.settingsSaveFlight = null;
        this.settingsIntent = null;
      }
    }
  }

  private async applySavedSettings(draft: PersistedState, next: Settings, attempt: number): Promise<Settings> {
    try {
      await this.storage.save(draft);
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
    this.state.settings = next;
    if (attempt === this.settingsSeq) {
      if (this.closeError === "settings-save-failed") this.closeError = null;
      this.commit();
    } else {
      this.scheduleSave(150);
    }
    return next;
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
    this.state.timelines[session.id] = [];
    this.state.runs[session.id] = idleRun(session.id);
    return session;
  }

  private targetOf(session: Session): ExecutionTarget {
    const task = this.state.tasks.find((t) => t.id === session.taskId);
    if (!task) throw new Error(`Unknown task: ${session.taskId}`);
    return { workspaceId: task.workspaceId, taskId: task.id, sessionId: session.id };
  }

  private async ensurePort(session: Session): Promise<ExecutionPort> {
    let pending = this.ports.get(session.id);
    if (!pending) {
      const task = this.state.tasks.find((t) => t.id === session.taskId);
      const workspace = task && this.state.workspaces.find((w) => w.id === task.workspaceId);
      pending = this.currentBackend.open({
        target: this.targetOf(session),
        workFolder: task?.boundFolder ?? workspace?.folders[0] ?? null,
        title: session.title,
      });
      this.ports.set(session.id, pending);
      // 打开失败不能留下坏缓存：同一发送的重试应能重新打开
      pending.catch(() => this.ports.delete(session.id));
    }
    return pending;
  }

  /** read 是只读观测：不隐式启动或恢复执行（两种后端都遵守）。 */
  private async latestControl(sessionId: string, port: ExecutionPort): Promise<ControlToken> {
    const known = this.controls.get(sessionId);
    if (known) return known;
    const view = await port.read();
    this.applyView(sessionId, view);
    return view.control;
  }

  private async submitToPort(
    session: Session,
    input: { operationId: string; text: string; mode: "steer" | "follow-up" },
  ): Promise<SendReceipt> {
    const port = await this.ensurePort(session);
    const expected = await this.latestControl(session.id, port);
    return toSendReceipt(await port.submit({ target: this.targetOf(session), ...input, expected }));
  }

  /**
   * 同一次发送的再次尝试（回执未确认后的重试/重发）：先走只读回查。
   * 找回已接收记录就不再投递；仍未知不盲投；只有可靠 not-found 才允许同身份重试投递
   * （执行端 submit 自身按 operationId 幂等，这里是产品层的找回优先次序）。
   */
  private async recoverOrSubmit(
    session: Session,
    input: { operationId: string; text: string; mode: "steer" | "follow-up" },
  ): Promise<SendReceipt> {
    const port = await this.ensurePort(session);
    const expected = await this.latestControl(session.id, port);
    const workInput = { target: this.targetOf(session), ...input, expected };
    const found = toSendReceipt(await port.lookupReceipt(workInput));
    if (found.status !== "not-accepted" || found.reason !== "not-found") return found;
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
    input: { operationId: string; text: string; mode: "steer" | "follow-up"; receipt: SendReceipt },
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
      if (!this.flushPromise) this.pollTimer = setTimeout(() => void tick(), POLL_MS);
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
    // 同在途设置写盘协调：等全部已开始的设置写盘真实收束（若在等的途中又来新的，继续等最新一个），
    // 避免较旧配置快照在队列中盖回真实结果
    for (;;) {
      const flight = this.settingsSaveFlight;
      if (!flight) break;
      await flight.catch(() => undefined);
      if (this.settingsSaveFlight === flight) break;
    }
    await this.storage.save(JSON.parse(JSON.stringify(this.state)) as PersistedState);
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
function projectEntry(entry: { id: number; kind: string; data: unknown; assistantText?: string }): TimelineBlock | null {
  const at = Date.now();
  if (entry.kind === "pi.assistant") {
    // 助手正文走正式字段（主树已补合同），没有正文的条目不产生空泡
    if (!entry.assistantText) return null;
    return { kind: "message", id: `pi-msg-${entry.id}`, role: "assistant", text: entry.assistantText, streaming: false, at };
  }
  if (entry.kind === "pi.tool-result") {
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
function normalizeLegacy(state: PersistedState): PersistedState {
  // 旧状态文件没有首发在途关联表：补空表（无在途记录可恢复，不虚构关联）
  state.pendingFirstSends ??= {};
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
