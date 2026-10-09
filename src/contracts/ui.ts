import type { InputReceipt } from "./execution";

// D Code 原型：界面与应用共享的契约类型。
// 只包含可序列化的视图与操作类型；不含宿主或运行实现。

// ---------- 对象模型（工作空间 → 任务 → 会话） ----------

export interface Workspace {
  id: string;
  name: string;
  /** 绑定的多个工作文件夹 */
  folders: string[];
  /** 内置 Home 空间，根目录为用户主文件夹 */
  builtinHome: boolean;
  /** 内置默认任务 id，不可删除 */
  defaultTaskId: string;
}

export interface Task {
  id: string;
  workspaceId: string;
  /** null = 空间直属；否则为所属长期任务 id。两级封顶。 */
  parentId: string | null;
  /** 显式任务类型：长期任务可再建短期子任务；短期任务空间直属、不可再嵌套。 */
  kind: "long" | "short";
  title: string;
  /** 可选绑定的空间内文件夹，作为默认工作目录 */
  boundFolder: string | null;
  /** 内置默认任务标记 */
  isDefault: boolean;
  updatedAt: number;
}

export type SessionKind = "main" | "sub";

export interface Session {
  id: string;
  taskId: string;
  title: string;
  kind: SessionKind;
  updatedAt: number;
}

// ---------- 时间线 ----------

export type ToolStatus = "running" | "done" | "failed" | "waiting";

export interface ToolBlockData {
  name: string;
  /** 折叠态单行摘要 */
  primaryText: string;
  /** 展开后的正文输出 */
  output: string;
  status: ToolStatus;
  exitCode?: number;
  /** 关联的改动文件路径 */
  changedFiles: string[];
}

export interface DiffLine {
  type: "add" | "del" | "context";
  text: string;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface FileChange {
  path: string;
  added: number;
  deleted: number;
  hunks: DiffHunk[];
}

export type RunMarkerKind = "paused" | "resumed" | "finished" | "failed";

// ---------- 发送回执（三态） ----------

/**
 * 一次发送操作的接收回执。
 * accepted = 运行端校验目标有效且输入已保存（两条件缺一不算）；
 * not-accepted = 有实际拒绝或确认未提交的依据（带原因）；
 * unknown = 接收结果待核对（存储不可用／回执丢失），先只读回查，不盲投。
 */
// 界面回执是正式执行回执的投影；不删除执行端的 submissionId 或另定义接收语义。
export type SendReceipt =
  | Omit<Extract<InputReceipt, { status: "accepted" }>, "submissionId">
  | Exclude<InputReceipt, { status: "accepted" }>;

export function toSendReceipt(receipt: InputReceipt): SendReceipt {
  if (receipt.status !== "accepted") return receipt;
  return { status: receipt.status, operationId: receipt.operationId, processing: receipt.processing };
}

/** 工作输入去向：引导 = 立即纳入当前工作；稍后处理 = 留到本轮结束。 */
export type SendMode = "steer" | "follow-up";

/** 发送操作的关联身份：同次重试／自动补送复用；相同文字的新发送用新 id。 */
export interface SendResult {
  /** 本次发送所属的会话（草稿首发时为新建的会话） */
  sessionId: string;
  receipt: SendReceipt;
}

export type TimelineBlock =
  | {
      kind: "message";
      id: string;
      role: "user" | "assistant";
      text: string;
      streaming: boolean;
      at: number;
      /** 用户消息携带发送操作身份与接收回执（assistant 消息无） */
      operationId?: string;
      mode?: SendMode;
      receipt?: SendReceipt;
    }
  | { kind: "tool"; id: string; tool: ToolBlockData; at: number }
  | { kind: "change-summary"; id: string; files: FileChange[]; at: number }
  | { kind: "run-marker"; id: string; marker: RunMarkerKind; text: string; at: number };

// ---------- 运行状态 ----------

/**
 * 运行相位直接映射执行端 ExecutionView.phase。
 * 没有「已完成」相：ready 且未完成输入数为 0 也不表示任务完成，界面不得自行推断。
 */
export type RunStatus = "ready" | "running" | "pausing" | "paused" | "faulted";

export interface RunState {
  sessionId: string;
  status: RunStatus;
  note: string;
  /** 非相位的如实说明（如过期恢复被拒的原因）；可见但不伪装成标准相位 */
  errorNote?: RunIssue | null;
  /** 重开后的暂停现场；行为依据此事实，不解析 note 文案。 */
  restored?: boolean;
  /** 未完成输入数（含 queued+placed），不是「待纳入队列」 */
  pendingInputs: number;
  updatedAt: number;
}

/** 本进程装配的执行端；两种证据分开标注、分开报告。 */
export interface ExecutionInfo {
  kind: "unavailable" | "mock" | "pi";
}

// ---------- 设置 ----------

export type ThemeSetting = "system" | "light" | "dark";
export type ColdStartSetting = "restore" | "home-draft";
export type LanguageSetting = "system" | "zh" | "en";

export interface Settings {
  theme: ThemeSetting;
  /** 字号旋钮：全部界面几何由此派生 */
  fontSize: number;
  coldStart: ColdStartSetting;
  /** 界面语言：跟随系统／中文／英文 */
  language: LanguageSetting;
}

/**
 * 首次添加 / 编辑真实服务商配置（settings.model）。
 * provider 为本片实际接入的协议值（openai-completions / anthropic-messages，对应 Pi 1.0.0 Chat Completions）；
 * modelId 为 provider 端真实 id；baseUrl 仅 http(s)、不允许 userinfo；keyAction 为 replace/keep/clear。
 */
export interface ModelSetupInput {
  provider: "openai-completions" | "anthropic-messages";
  label: string;
  modelId: string;
  baseUrl: string;
  keyAction: "replace" | "keep" | "clear";
  apiKey?: string;
}

export type ModelSetupNote = "ready" | "auth-failed" | "auth-unverified" | "connect-failed";

/**
 * 快照/UI 可读的模型配置：仅安全元数据（label/provider/modelId/baseUrl/note/hasKey）。
 * 快照不含 apiKey 或其片段；hasKey 表示已存加密凭据存在，用于编辑回显一个密码字段再保存的提示。
 */
export type ModelSetupStatus =
  | { kind: "unconfigured" }
  | {
    kind: "configured";
    label: string;
    provider: ModelSetupInput["provider"];
    modelId: string;
    baseUrl: string;
    note: ModelSetupNote;
    /** true = 落盘记录里确有加密凭据；false = 只有元数据（keyAction=clear 或初始导入） */
    hasKey: boolean;
  };
export interface ModelSetupResult {
  ok: boolean;
  issue?: "invalid-input" | "no-existing-key" | "key-required" | "connect-failed" | "auth-failed" | "backend-unavailable" | "run-in-flight" | "storage-failed";
  message?: string;
}

/**
 * model-setup.json 持久化记录：连接非秘密元数据 + cipher 加密凭据共存一份文件。
 * 不再分离 secrets/*.json；写入端负责原子（临时文件 + 一次 rename），读出端按格式版本识别。
 * credential 为 cipher 加密后 base64；hasKey=false 时 credential 必须缺席。
 */
export interface ModelSetupRecord {
  format: 1;
  provider: ModelSetupInput["provider"];
  label: string;
  modelId: string;
  baseUrl: string;
  note: "ready" | "auth-failed" | "auth-unverified" | "connect-failed";
  /** cipher.encrypt(JSON.stringify(Credential)) 的 base64；hasKey=false 时缺席 */
  credential?: string;
}

/** 持久化 model-setup.json 的读写器（application/pi 共用接口；Electron 与 fs 由 main 注入） */
export interface ModelSetupIO {
  read(): Promise<ModelSetupRecord | null>;
  write(record: ModelSetupRecord): Promise<void>;
  remove(): Promise<void>;
}

export interface ModelAvailability {
  available: boolean;
  name: string | null;
}

export type RunIssue = "resume-stale" | "resume-failed" | "resume-unverified" | "auth-failed" | "model-request-failed";
export type AppIssue = "state-corrupt" | "state-unreadable" | "initial-save-failed" | "save-failed" | "settings-save-failed" | "first-send-save-failed" | "close-failed";

// ---------- 应用快照（界面读取的只读视图） ----------

export interface AppSnapshot {
  workspaces: Workspace[];
  tasks: Task[];
  sessions: Session[];
  /** sessionId → 时间线块 */
  timelines: Record<string, TimelineBlock[]>;
  /** sessionId → 运行状态 */
  runs: Record<string, RunState>;
  settings: Settings;
  model: ModelAvailability;
  /** 本片模型配置状态（不回密钥/baseUrl 原文；成功失败仍属保存前最近一次） */
  modelSetup: ModelSetupStatus;
  execution: ExecutionInfo;
  /** 关闭收束失败等一次性错误；可见状态保留，不伪报成功 */
  closeError: AppIssue | null;
  /** 应用实例内每次真实失败的编号；清除错误不回退编号，读取和广播不新增。 */
  closeErrorRevision: number;
}

// ---------- 操作（界面经隔离桥发出） ----------

export interface DCodeOperations {
  getSnapshot(): Promise<AppSnapshot>;
  createTask(input: { workspaceId: string; parentId: string | null; title: string }): Promise<Task>;
  moveTask(input: { taskId: string; targetWorkspaceId: string }): Promise<void>;
  // 首版不提供永久删除（507 选择可恢复归档 A）：deleteTask 已退出正式通路，
  // 归档／查看／恢复入口按 L01–L04 在独立切片落地。
  createSession(input: { taskId: string }): Promise<Session>;
  /**
   * 发送工作输入。草稿首发（给 taskId 不给 sessionId）建立唯一短期任务 + 主会话，
   * 对象已建但接收未确认时重试不重复建对象（同次重试复用 operationId）。
   */
  sendMessage(input: {
    sessionId?: string;
    taskId?: string;
    text: string;
    mode: SendMode;
    operationId?: string;
  }): Promise<SendResult>;
  /** 重试同一次发送：复用该消息块的 operationId、原文、模式与原目标。 */
  retrySend(input: { sessionId: string; blockId: string }): Promise<SendResult>;
  /** 只读回查接收结果（lookupReceipt），不执行工作、不盲投。 */
  checkReceipt(input: { sessionId: string; blockId: string }): Promise<SendResult>;
  pauseRun(input: { sessionId: string }): Promise<void>;
  /** 恢复绑定最近一次明确用户恢复意图对应的控制令牌；过期被拒后不自动重投。 */
  resumeRun(input: { sessionId: string }): Promise<void>;
  updateSettings(input: Partial<Settings>): Promise<Settings>;
  /**
   * 添加 / 编辑真实服务商（本片未授权 OAuth/自动路由）。
   * apiKey 由调用方提供仅在本操作中以安全凭据方式落盘（永不进入快照 / 日志 / 返回值）。
   */
  configureModel(input: ModelSetupInput): Promise<ModelSetupResult>;
}

// ---------- 桥接事件 ----------

export interface DCodeBridge extends DCodeOperations {
  onSnapshot(listener: (snapshot: AppSnapshot) => void): () => void;
}

declare global {
  interface Window {
    dcode: DCodeBridge;
  }
}

// ---------- 接收侧运行时校验（主进程唯一入口使用；只允许下列既有操作） ----------

/** 允许的操作名（与 DCodeOperations 一一对应；未知操作在入口处拒绝） */
export const OP_NAMES = [
  "getSnapshot",
  "createTask",
  "moveTask",
  "createSession",
  "sendMessage",
  "retrySend",
  "checkReceipt",
  "pauseRun",
  "resumeRun",
  "updateSettings",
  "configureModel",
] as const;

export type OpName = (typeof OP_NAMES)[number];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const isId = isNonEmpty;

const THEME_VALUES: readonly string[] = ["system", "light", "dark"];
const COLD_START_VALUES: readonly string[] = ["restore", "home-draft"];
const LANGUAGE_VALUES: readonly string[] = ["system", "zh", "en"];
/** 字号步进边界（13–16，步进 1）：全部界面几何由此派生，越界或非法类型拒绝 */
const FONT_SIZE_MIN = 13;
const FONT_SIZE_MAX = 16;

/** 设置字段级校验：枚举／类型／有限数值逐项核对，未知键拒绝；存在即须合法（Partial 语义）。 */
export function validateSettingsPatch(input: unknown): string | null {
  if (!isRecord(input)) return "updateSettings 载荷畸形";
  for (const key of Object.keys(input)) {
    if (!["theme", "fontSize", "coldStart", "language"].includes(key)) return `updateSettings 未知设置项: ${key}`;
  }
  if (input.theme !== undefined && !THEME_VALUES.includes(input.theme as string)) return "updateSettings.theme 非法取值";
  if (input.coldStart !== undefined && !COLD_START_VALUES.includes(input.coldStart as string)) return "updateSettings.coldStart 非法取值";
  if (input.language !== undefined && !LANGUAGE_VALUES.includes(input.language as string)) return "updateSettings.language 非法取值";
  if (input.fontSize !== undefined) {
    const n = input.fontSize;
    if (typeof n !== "number" || !Number.isInteger(n) || n < FONT_SIZE_MIN || n > FONT_SIZE_MAX) {
      return `updateSettings.fontSize 须为 ${FONT_SIZE_MIN}–${FONT_SIZE_MAX} 的整数`;
    }
  }
  return null;
}

/** 判断是否明确 loopback 主机：仅这几种字面量，wrapper 一律算远程 */
function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "[::1]" || h === "::1") return true;
  if (h === "127.0.0.1") return true;
  // 完整 127.0.0.0/8 字面量（不含缩写 127.1）
  if (/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(h)) {
    return h.split(".").every((s) => Number(s) <= 255);
  }
  return false;
}

/** configureModel 校验：字段必填、协议白名单、URL 仅 http(s) 无 userinfo、禁查询/片段；
 *  HTTP 仅允许明确 loopback（127.0.0.0/8 字面量、localhost、[::1]），其余 host 必须 HTTPS；
 * baseUrl 不允许内置 userinfo 或凭据段；key 只在 keyAction=replace 时必填。 */
export function validateModelSetupInput(input: unknown): string | null {
  if (!isRecord(input)) return "configureModel 载荷畸形";
  for (const key of Object.keys(input)) {
    if (!["provider", "label", "modelId", "baseUrl", "keyAction", "apiKey"].includes(key)) return `configureModel 未知字段: ${key}`;
  }
  if (input.provider !== "openai-completions" && input.provider !== "anthropic-messages") return "configureModel.provider 须为 openai-completions 或 anthropic-messages";
  if (typeof input.label !== "string" || input.label.trim().length === 0) return "configureModel.label 必填且非空";
  if (typeof input.modelId !== "string" || input.modelId.trim().length === 0) return "configureModel.modelId 必填且非空";
  if (typeof input.baseUrl !== "string") return "configureModel.baseUrl 必填且为字符串";
  let url: URL;
  try { url = new URL(input.baseUrl as string); } catch { return "configureModel.baseUrl 须为合法 URL"; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "configureModel.baseUrl 仅允许 http/https";
  if (url.username || url.password) return "configureModel.baseUrl 不允许自带用户/凭据段";
  if (url.search || url.hash) return "configureModel.baseUrl 不允许查询或片段";
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) return "configureModel.baseUrl 远程仅允许 HTTPS";
  if (input.keyAction !== "replace" && input.keyAction !== "keep" && input.keyAction !== "clear") return "configureModel.keyAction 非法取值";
  if (input.keyAction === "replace" && (typeof input.apiKey !== "string" || input.apiKey.length === 0)) return "configureModel.apiKey 必填且非空（keyAction=replace 时）";
  if (input.keyAction !== "replace" && input.apiKey !== undefined) return "configureModel.apiKey 仅在 keyAction=replace 时可携带";
  return null;
}

// ---------- 对象级校验（快照与操作返回的接收侧共用；不豁免本进程生产者） ----------

const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isStrOrNull = (v: unknown): v is string | null => v === null || isStr(v);
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

/** 全量设置对象：四字段齐备且各自合法（区别于部分更新的 validateSettingsPatch） */
export function isValidSettings(value: unknown): value is Settings {
  if (!isRecord(value)) return false;
  return (
    THEME_VALUES.includes(value.theme as string) &&
    Number.isInteger(value.fontSize) &&
    (value.fontSize as number) >= FONT_SIZE_MIN &&
    (value.fontSize as number) <= FONT_SIZE_MAX &&
    COLD_START_VALUES.includes(value.coldStart as string) &&
    LANGUAGE_VALUES.includes(value.language as string)
  );
}

function isValidWorkspace(w: unknown): w is Workspace {
  return (
    isRecord(w) && isId(w.id) && isStr(w.name) && isStrArray(w.folders) && isBool(w.builtinHome) && isId(w.defaultTaskId)
  );
}

function isValidTask(t: unknown): t is Task {
  return (
    isRecord(t) &&
    isId(t.id) &&
    isId(t.workspaceId) &&
    (t.parentId === null || isId(t.parentId)) &&
    (t.kind === "long" || t.kind === "short") &&
    isStr(t.title) &&
    isStrOrNull(t.boundFolder) &&
    isBool(t.isDefault) &&
    isNum(t.updatedAt)
  );
}

function isValidSession(s: unknown): s is Session {
  return (
    isRecord(s) && isId(s.id) && isId(s.taskId) && isStr(s.title) && (s.kind === "main" || s.kind === "sub") && isNum(s.updatedAt)
  );
}

function isValidReceipt(r: unknown): r is SendReceipt {
  if (!isRecord(r) || !isId(r.operationId)) return false;
  if (r.status === "accepted") return ["queued", "placed", "done", "unanswered"].includes(r.processing as string);
  if (r.status === "not-accepted") {
    return ["paused", "stale-control", "conflict", "not-found", "storage-rejected"].includes(r.reason as string);
  }
  if (r.status === "unknown") return r.reason === "storage-unavailable";
  return false;
}

function isValidSendResult(v: unknown): v is SendResult {
  return isRecord(v) && isId(v.sessionId) && isValidReceipt(v.receipt);
}

function isValidToolData(t: unknown): boolean {
  return (
    isRecord(t) &&
    isStr(t.name) &&
    isStr(t.primaryText) &&
    isStr(t.output) &&
    ["running", "done", "failed", "waiting"].includes(t.status as string) &&
    (t.exitCode === undefined || isNum(t.exitCode)) &&
    isStrArray(t.changedFiles)
  );
}

function isValidFileChange(f: unknown): boolean {
  return (
    isRecord(f) &&
    isStr(f.path) &&
    isNum(f.added) &&
    isNum(f.deleted) &&
    Array.isArray(f.hunks) &&
    f.hunks.every(
      (h) =>
        isRecord(h) &&
        isStr(h.header) &&
        Array.isArray(h.lines) &&
        h.lines.every((l) => isRecord(l) && ["add", "del", "context"].includes(l.type as string) && isStr(l.text)),
    )
  );
}

/** 时间线块逐块形状校验：四种块各自的必需字段与枚举，未知 kind 拒绝 */
function isValidTimelineBlock(b: unknown): boolean {
  if (!isRecord(b) || !isId(b.id) || !isNum(b.at)) return false;
  switch (b.kind) {
    case "message":
      return (
        (b.role === "user" || b.role === "assistant") &&
        isStr(b.text) &&
        isBool(b.streaming) &&
        (b.operationId === undefined || isId(b.operationId)) &&
        (b.mode === undefined || b.mode === "steer" || b.mode === "follow-up") &&
        (b.receipt === undefined || isValidReceipt(b.receipt))
      );
    case "tool":
      return isValidToolData(b.tool);
    case "change-summary":
      return Array.isArray(b.files) && b.files.every(isValidFileChange);
    case "run-marker":
      return ["paused", "resumed", "finished", "failed"].includes(b.marker as string) && isStr(b.text);
    default:
      return false;
  }
}

function isValidRunState(r: unknown): boolean {
  return (
    isRecord(r) &&
    isId(r.sessionId) &&
    ["ready", "running", "pausing", "paused", "faulted"].includes(r.status as string) &&
    isStr(r.note) &&
    (r.errorNote === undefined || r.errorNote === null || ["resume-stale", "resume-failed", "resume-unverified", "auth-failed", "model-request-failed"].includes(r.errorNote as string)) &&
    (r.restored === undefined || isBool(r.restored)) &&
    isNum(r.pendingInputs) &&
    isNum(r.updatedAt)
  );
}

function isValidModelAvailability(m: unknown): m is ModelAvailability {
  return isRecord(m) && isBool(m.available) && (m.available ? isNonEmpty(m.name) : m.name === null);
}

function isValidModelSetupStatus(m: unknown): m is ModelSetupStatus {
  if (!isRecord(m)) return false;
  if (m.kind === "unconfigured") return true;
  if (m.kind !== "configured") return false;
  if (!isNonEmpty(m.label) || !isNonEmpty(m.modelId)) return false;
  if (m.provider !== "openai-completions" && m.provider !== "anthropic-messages") return false;
  if (!isNonEmpty(m.baseUrl) || typeof m.hasKey !== "boolean") return false;
  return ["ready", "auth-failed", "auth-unverified", "connect-failed"].includes(m.note as string);
}

/**
 * 快照接收校验：按 AppSnapshot 契约逐字段核对——必需字段、类型、枚举，
 * timelines/runs 的每个值与每个时间线块都过形状校验。畸形快照不进入渲染层。
 */
export function isValidSnapshot(value: unknown): value is AppSnapshot {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.workspaces) || !value.workspaces.every(isValidWorkspace)) return false;
  if (!Array.isArray(value.tasks) || !value.tasks.every(isValidTask)) return false;
  if (!Array.isArray(value.sessions) || !value.sessions.every(isValidSession)) return false;
  if (!isRecord(value.timelines)) return false;
  for (const blocks of Object.values(value.timelines)) {
    if (!Array.isArray(blocks) || !blocks.every(isValidTimelineBlock)) return false;
  }
  if (!isRecord(value.runs)) return false;
  for (const run of Object.values(value.runs)) {
    if (!isValidRunState(run)) return false;
  }
  if (!isValidSettings(value.settings)) return false;
  if (!isValidModelAvailability(value.model)) return false;
  if (!isValidModelSetupStatus(value.modelSetup)) return false;
  const kind = isRecord(value.execution) ? value.execution.kind : undefined;
  if (kind !== "unavailable" && kind !== "mock" && kind !== "pi") return false;
  if (kind === "unavailable" && value.model.available) return false;
  if (!Number.isSafeInteger(value.closeErrorRevision) || (value.closeErrorRevision as number) < 0) return false;
  if (value.closeError !== null && (value.closeErrorRevision as number) === 0) return false;
  return value.closeError === null || ["state-corrupt", "state-unreadable", "initial-save-failed", "save-failed", "settings-save-failed", "first-send-save-failed", "close-failed"].includes(value.closeError as string);
}

/** 返回拒绝原因；null 表示载荷通过。畸形载荷不建对象、不接收、不执行。 */
export function validateOperationInput(op: string, input: unknown): string | null {
  if (!(OP_NAMES as readonly string[]).includes(op)) return `未知操作: ${op}`;
  switch (op as OpName) {
    case "getSnapshot":
      return input === undefined ? null : "getSnapshot 不接受参数";
    case "createTask":
      return isRecord(input) && isId(input.workspaceId) && (input.parentId === null || isId(input.parentId)) && typeof input.title === "string"
        ? null
        : "createTask 载荷畸形";
    case "moveTask":
      return isRecord(input) && isId(input.taskId) && isId(input.targetWorkspaceId) ? null : "moveTask 载荷畸形";
    case "createSession":
      return isRecord(input) && isId(input.taskId) ? null : "createSession 载荷畸形";
    case "sendMessage":
      return isRecord(input) &&
        (isId(input.sessionId) || isId(input.taskId)) &&
        typeof input.text === "string" &&
        input.text.trim().length > 0 &&
        (input.mode === "steer" || input.mode === "follow-up") &&
        (input.operationId === undefined || isId(input.operationId))
        ? null
        : "sendMessage 载荷畸形";
    case "retrySend":
    case "checkReceipt":
      return isRecord(input) && isId(input.sessionId) && isId(input.blockId) ? null : `${op} 载荷畸形`;
    case "pauseRun":
    case "resumeRun":
      return isRecord(input) && isId(input.sessionId) ? null : `${op} 载荷畸形`;
    case "updateSettings":
      return validateSettingsPatch(input);
    case "configureModel":
      return validateModelSetupInput(input);
  }
}

/**
 * 操作返回值的接收校验（preload 边界）：每个操作按既有返回契约核对，
 * 畸形返回不交付渲染层；无返回值的移动/删除/暂停/恢复只接受 undefined。
 */
export function isValidOpResponse(op: OpName, value: unknown): boolean {
  switch (op) {
    case "getSnapshot":
      return isValidSnapshot(value);
    case "createTask":
      return isValidTask(value);
    case "createSession":
      return isValidSession(value);
    case "sendMessage":
    case "retrySend":
    case "checkReceipt":
      return isValidSendResult(value);
    case "updateSettings":
      return isValidSettings(value);
    case "configureModel":
      return isValidModelSetupResult(value);
    case "moveTask":
    case "pauseRun":
    case "resumeRun":
      return value === undefined;
    default:
      return false;
  }
}

function isValidModelSetupResult(v: unknown): v is ModelSetupResult {
  if (!isRecord(v)) return false;
  if (typeof v.ok !== "boolean") return false;
  return v.ok || (typeof v.issue === "string" && typeof v.message === "string");
}
