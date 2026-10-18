import { parseWorkImages } from "./execution";
import type { InputReceipt, WorkImage } from "./execution";
import type { FileChange } from './changes';
export type { DiffLine, DiffHunk, FileChange } from './changes';
import { isValidCapturedReference, isValidReferenceListing, isValidReferenceSummary, parseWorkReferences } from "./references";
import type {
  CaptureReferenceInput,
  ListReferencesInput,
  ReferenceListing,
  ReferenceSummary,
  WorkReference,
} from "./references";
import type {
  QuotaFacts,
  SessionModelChoice,
  SessionModelState,
  ThinkingLevel,
  VerifiedModelCapabilities,
  WorkUsage,
} from "./model-routing";
import { WORK_CAPABILITIES, isQuotaFacts, isSessionModelChoice, isSessionModelState, isThinkingLevel, isVerifiedModelCapabilities, isWorkUsage } from "./model-routing";

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
  images?: readonly WorkImage[];
  name: string;
  /** 折叠态单行摘要 */
  primaryText: string;
  /** 展开后的正文输出 */
  output: string;
  /** SDK对当前运行输出的实际截断量；正文不拼接内部状态文案。 */
  outputTruncation?: { droppedBytes: number; droppedLines: number };
  status: ToolStatus;
  exitCode?: number;
  /** 关联的改动文件路径 */
  changedFiles: string[];
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
      /**
       * 本条消息携带的引用（身份 + 快照元数据，无正文）。
       * 用户原文字仍在 text 里原样保留；引用不改写它。
       */
      references?: readonly ReferenceSummary[];
      /** 本会话正式扩展输入的图片身份，用于同 operation 回执查回。 */
      images?: readonly import('./execution').WorkImage[];
    }
  | { kind: "extension-message"; id: string; customType: string; text: string; at: number }
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

// ---------- 任务用量（只读汇总） ----------

/** 计量范围里的一条会话：主会话或该任务的成员会话。 */
export interface TaskUsageScopeEntry {
  sessionId: string;
  kind: SessionKind;
  /** 该会话自身可归属的用量；尚无真实用量记录为 null（不是 0） */
  usage: WorkUsage | null;
}

/** 按**实际来源**分开的用量：不用虚拟模型名称猜账户消耗，也不与账户额度混算。 */
export interface TaskUsageBySource {
  sourceId: string;
  sourceLabel: string;
  usage: WorkUsage;
}

/**
 * 任务用量汇总：按任务归属聚合主会话与成员会话的真实请求记录。
 * · **只读**：查看或刷新不改变任务执行、不发送输入、不解除暂停；
 * · 同一真实请求事实身份只计一次（聊天为服务商responseId，分类为原Durable子任务，不伪造响应ID）；
 * · 无可归属记录时 totals 为 null，不补零；覆盖不完整时写明缺口。
 */
export interface TaskUsageSummary {
  taskId: string;
  scope: readonly TaskUsageScopeEntry[];
  /** 计量范围内的合计；范围内没有任何真实记录为 null */
  totals: WorkUsage | null;
  bySource: readonly TaskUsageBySource[];
  /** 覆盖不完整时的真实原因（如某会话用量字段缺失）；没有缺口为 null */
  incompleteReason: string | null;
}

// ---------- 设置 ----------

export type ThemeSetting = "system" | "light" | "dark";
export type ColdStartSetting = "restore" | "home-draft";
export type LanguageSetting = "system" | "zh" | "en";

export interface Settings {
  /** 项目代码与 MCP 仅在明确执行前启用；旧设置缺席视为关闭。 */
  projectExtensionsEnabled?: boolean;
  theme: ThemeSetting;
  /** 字号旋钮：全部界面几何由此派生 */
  fontSize: number;
  coldStart: ColdStartSetting;
  /** 界面语言：跟随系统／中文／英文 */
  language: LanguageSetting;
  /**
   * 新会话的默认模型选择。它**只**决定此后新建会话的初值；
   * 已存在会话各自的选择不受它影响，实际执行模型也另算（见 SessionModelState）。
   */
  newSessionModelChoice: SessionModelChoice;
  /**
   * 用户预先配置的**候选名单**：自动模式只在这些「来源 + 模型」里选。
   * 空数组 = 尚未配置候选 = 自动模式没有可用范围（不会因此扩大到整个目录）。
   * 指定模式不受它限制（用户点名了具体模型）。
   */
  modelCandidates: readonly { readonly sourceId: string; readonly modelId: string }[];
}

/** 自定义接入的协议值（对应 Pi 1.0.0 已接入的 Chat Completions 系列）；自定义协议仍是高级入口，预设名称不是协议。 */
export type CustomProviderProtocol = "openai-completions" | "anthropic-messages";

/** 自定义服务商配置（settings.model 的自定义入口）；modelId 为 provider 端真实 id；baseUrl 仅 http(s)、不允许 userinfo。 */
export interface ModelSetupInput {
  provider: CustomProviderProtocol;
  label: string;
  modelId: string;
  baseUrl: string;
  keyAction: "replace" | "keep" | "clear";
  apiKey?: string;
}

/** 预设供应商选择：Pi 1.0.0 builtin 身份 + 目录中的具体模型；认证经 loginProvider 单独完成，不自绑密钥。 */
export interface PresetModelSelectionInput {
  kind: "preset";
  providerId: string;
  modelId: string;
}

/** 自定义入口应用：沿用既有字段与密钥动作。 */
export interface CustomModelApplyInput {
  kind: "custom";
  input: ModelSetupInput;
}

export type ApplyModelInput = PresetModelSelectionInput | CustomModelApplyInput;

export interface ApplyModelResult {
  ok: boolean;
  issue?: "invalid-input" | "no-existing-key" | "key-required" | "connect-failed" | "auth-failed" | "unknown-provider" | "unknown-model" | "auth-missing" | "backend-unavailable" | "run-in-flight" | "storage-failed";
  message?: string;
}

export type ModelSetupNote = "ready" | "auth-failed" | "auth-unverified" | "connect-failed";

/**
 * 快照/UI 可读的当前模型配置：仅安全元数据。
 * preset：供应商以 Pi 正式身份显示，地区/计划差异保留在 providerId 对应条目的名称里；
 * custom：沿用原有 label/provider/modelId/baseUrl 形态。快照不含 apiKey 或其片段。
 */
export type ModelSetupStatus =
  | { kind: "unconfigured" }
  | {
    kind: "preset";
    providerId: string;
    providerName: string;
    modelId: string;
    modelName: string;
    note: ModelSetupNote;
    /** true = 该 providerId 名下确有加密凭据 */
    hasKey: boolean;
    /** 该供应商支持的认证方式；apiKey/oauth 至少一个存在 */
    auth: ReadonlyArray<"api_key" | "oauth">;
  }
  | {
    kind: "custom";
    label: string;
    provider: CustomProviderProtocol;
    modelId: string;
    baseUrl: string;
    note: ModelSetupNote;
    hasKey: boolean;
  }
  | {
    /** 预设为当前，但已保存的自定义定义仍在（可编辑并留用原密钥）；界面据此呈现双方 */
    kind: "preset-with-custom";
    preset: {
      providerId: string;
      providerName: string;
      modelId: string;
      modelName: string;
      note: ModelSetupNote;
      hasKey: boolean;
      auth: ReadonlyArray<"api_key" | "oauth">;
    };
    custom: CustomProviderDefinition & { hasKey: boolean };
    note: ModelSetupNote;
    hasKey: boolean;
  };

export interface ModelSetupResult {
  ok: boolean;
  issue?: "invalid-input" | "no-existing-key" | "key-required" | "connect-failed" | "auth-failed" | "backend-unavailable" | "run-in-flight" | "storage-failed";
  message?: string;
}

/**
 * provider-directory.json 持久化记录（格式 2）：供应商目录、按 providerId 隔离的加密凭据、
 * 当前模型选择与公共目录缓存共一份文件；单写者、原子提交。凭据只按 providerId 索引，
 * 一个供应商的密钥不会返回给另一个供应商。
 */
export interface CurrentModelSelectionPreset {
  kind: "preset";
  providerId: string;
  modelId: string;
  note: ModelSetupNote;
}

export interface CurrentModelSelectionCustom {
  kind: "custom";
  provider: CustomProviderProtocol;
  label: string;
  modelId: string;
  baseUrl: string;
  note: ModelSetupNote;
}

export type CurrentModelSelection = CurrentModelSelectionPreset | CurrentModelSelectionCustom;

/** 公共模型目录的持久化条目（对应 pi-ai ModelsStoreEntry 的安全字段；models 必须已过接收侧全形状校验且只含 chat）。
 *  sourceBaseUrl 记录这份缓存属于哪个目录源：跨源后旧源 ETag/正文不得当作新源的依据或内容。 */
export interface CatalogCacheEntry {
  models: readonly PersistedCatalogModel[];
  checkedAt?: number;
  lastModified?: number;
  etag?: string;
  /** 产生这条缓存的来源地址；缺席视为旧格式（与当前源不一致时同样不采用） */
  sourceBaseUrl?: string;
}

/** 允许持久化的模型字段：只含安全模型信息；不含 api/headers 之外的宿主能力字段时由本地登记补齐。 */
export interface PersistedCatalogModel {
  id: string;
  name: string;
  api: string;
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  input: ReadonlyArray<"text" | "image">;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  type: "chat";
}

/** 凭据记录：加密 blob 与无秘密元数据同档。list/目录枚举只读 kind，不 decrypt、不执行外部 key 命令。 */
export interface StoredCredentialEntry {
  /** 认证方式（api_key/oauth）；无秘密元数据 */
  kind: "api_key" | "oauth";
  /** cipher.encrypt(JSON.stringify(Credential)) 的 base64 */
  blob: string;
}

export interface CustomProviderDefinition {
  provider: CustomProviderProtocol;
  label: string;
  modelId: string;
  baseUrl: string;
  note: ModelSetupNote;
}

export interface ProviderDirectoryRecord {
  format: 2;
  /** providerId → 凭据记录；只按 id 精确存取，一个供应商的密钥不返回给另一个供应商 */
  credentials: Record<string, StoredCredentialEntry>;
  /** 当前选择（preset 或 custom） */
  current: CurrentModelSelection | null;
  /** 已保存的自定义服务定义：独立于当前选择保留，应用预设/关闭/重开后仍可编辑/留用原密钥 */
  customDefinition?: CustomProviderDefinition;
  /** 已校验的公共目录缓存（只含 chat 模型全字段），供离线/启动即时展示与 refresh 的 304 依据 */
  catalog: Record<string, CatalogCacheEntry>;
  /** 公共目录来源与按源的成功时间（跨源不复用成功时间，也不清空缓存破坏回退） */
  catalogSource: { baseUrl: string; lastSuccessAt: number | null; lastError: string | null };
  /** sourceBaseUrl → 该源最近一次成功检查时间；换源回来时如实展示，不把 A 的成功时间当 B 的 */
  successesBySource?: Record<string, number>;
}

/** provider-directory.json 的读写接口（application/main 共用；fs 由 pi adapter 实现）。 */
export interface ProviderDirectoryIO {
  read(): Promise<ProviderDirectoryRecord | null>;
  write(record: ProviderDirectoryRecord): Promise<void>;
  remove(): Promise<void>;
}

/**
 * 旧 model-setup.json 持久化记录（格式 1，自定义单条）。读取端继续承接：
 * 旧记录自动转入 ProviderDirectoryRecord（custom + user-defined 凭据归属），原文件保留备份，不静默删除。
 */
export interface ModelSetupRecord {
  format: 1;
  provider: CustomProviderProtocol;
  label: string;
  modelId: string;
  baseUrl: string;
  note: "ready" | "auth-failed" | "auth-unverified" | "connect-failed";
  credential?: string;
}

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

// ---------- 预设供应商与模型目录（经单独 IPC 读取；不塞进每次快照推送） ----------

/** 预设供应商条目：Pi 正式身份显示；hasStoredKey 只表达已存加密凭据存在，不代表已验证可调用。 */
export interface ProviderDirectoryEntry {
  id: string;
  name: string;
  auth: ReadonlyArray<"api_key" | "oauth">;
  /** 该供应商名下确有加密凭据 */
  hasStoredKey: boolean;
  modelCount: number;
}

/** 目录中的一个模型（接收侧已校验）；价格资料不作账户余额或账单。 */
export interface CatalogModelView {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  input: ReadonlyArray<"text" | "image">;
  reasoning: boolean;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** builtin = Pi 内置静态目录；remote = 经校验缓存的在线目录 */
  source: "builtin" | "remote";
  /** 本地可执行性：builtin 精确模板可执行；remote 条目按本地 anchor/协议兼容计算；false 时 Apply 必须禁用并显示原因 */
  executable: boolean;
  /** 不可执行原因（如 unknown-api）；executable=false 时非空 */
  reason?: string;
}

export interface ModelCatalogView {
  /** 客户端实际可识别的供应商目录（含未配置的） */
  providers: readonly ProviderDirectoryEntry[];
  /** providerId → 该供应商的模型（builtin 与已生效 remote 按 id 合并） */
  models: Record<string, readonly CatalogModelView[]>;
  /** 目录来源及新鲜度 */
  source: {
    baseUrl: string;
    lastSuccessAt: number | null;
    /** 正在进行一次联网检查（包含启动自动检查/手动刷新） */
    updating: boolean;
    /** 最近一次失败/离线的可读原因；成功或使用有效缓存时为 null */
    lastError: string | null;
    /** 修订号：每次目录内容或状态真实变化 +1，界面据此判断是否需要重读 */
    revision: number;
  };
}

export interface RefreshCatalogResult {
  ok: boolean;
  /** 完成后目录修订号（失败也会返回当前修订号供界面比对） */
  revision: number;
  message?: string;
}

/** 更换公共目录来源的结果：保存新来源并实际完成一次检查之前的旧目录不会被冒称已更新。 */
export interface SetCatalogSourceResult {
  ok: boolean;
  /** committed-not-checked：来源定义已原子提交（事实保留），但本次收尾检查因关闭或被取代未执行；
   *  与 refresh-failed 分开，避免把「已保存」呈现成「未保存」。 */
  issue?: "invalid-input" | "refresh-failed" | "closed" | "committed-not-checked";
  message?: string;
  revision?: number;
}

// ---------- 两层模型入口（来源优先，再按供应商分组搜索） ----------

/**
 * 模型来源条目（第一层）。**来源 + 模型**才是身份：同名模型在不同来源／账户下不去重，
 * 因为它们是彼此独立的候选。`accountLabel` 为 null 时界面显示「归属未提供」，不合并成同一条。
 */
export interface ModelSourcePick {
  sourceId: string;
  sourceLabel: string;
  /** 该来源是否已有凭据；只表达凭据存在，不代表已验证可调用 */
  configured: boolean;
  /** 该来源下的模型（按来源分组搜索的条目） */
  models: readonly ModelPickItem[];
}

/** 分组搜索结果里的一个模型条目（第二层）。 */
export interface ModelPickItem {
  sourceId: string;
  modelId: string;
  modelLabel: string;
  /** 已核实能力资料；未核实为 null，界面据此如实说明而不是猜 */
  capabilities: VerifiedModelCapabilities | null;
  /** 当前额度事实；未读取为 null。null 不等于可用，也不等于未知——未读就是未读 */
  quota: QuotaFacts | null;
}

/** 第一层读取结果：当前可用来源及其模型。不塞进每次快照推送（读一次即可）。 */
export interface ModelSourcesView {
  sources: readonly ModelSourcePick[];
  /** 新会话默认选择；与会话内各自的选择分别成立 */
  defaultChoice: SessionModelChoice;
  /** 当前会话（若有）的模型状态，与设置默认分别呈现 */
  sessionStates: readonly SessionModelState[];
}

/** 设置一份新的会话默认模型。**只影响此后新建的会话**，不改动任何已存在会话的选择。 */
export interface SetDefaultModelChoiceResult {
  ok: boolean;
  choice: SessionModelChoice;
  message?: string;
}

// ---------- 认证（loginProvider 的交互契约；密钥/令牌永不进快照/回执） ----------

export type AuthPromptKind = "text" | "secret" | "select" | "manual_code";

export interface AuthPromptOption {
  id: string;
  label: string;
  description?: string;
}

/** 主进程 → UI 的交互请求（经 onAuthEvent 推送；UI 以 replyAuthPrompt 回答）。 */
export interface AuthPromptRequest {
  requestId: string;
  loginId: string;
  kind: AuthPromptKind;
  message: string;
  placeholder?: string;
  options?: readonly AuthPromptOption[];
}

export interface AuthInfoEvent {
  loginId: string;
  type: "info" | "auth_url" | "device_code" | "progress";
  message?: string;
  url?: string;
  label?: string;
  userCode?: string;
  verificationUri?: string;
  intervalSeconds?: number;
  expiresInSeconds?: number;
}

export type AuthEventPayload = ({ type: "prompt" } & AuthPromptRequest) | ({ type: "info" | "auth_url" | "device_code" | "progress" } & AuthInfoEvent);

/** 认证事件接收侧完整校验：loginId/kind/message/url/select options/device_code/progress 逐字段核。
 *  畸形事件不交付 UI（不写 prompt、不推进流程、不落凭据）。 */
export function isValidAuthEvent(v: unknown): v is AuthEventPayload {
  if (!isRecord(v) || !isAuthId(v.loginId)) return false;
  if (v.type === "prompt") {
    if (!isAuthId(v.requestId) || typeof v.message !== "string") return false;
    if (!["text", "secret", "select", "manual_code"].includes(String(v.kind))) return false;
    if (v.placeholder !== undefined && typeof v.placeholder !== "string") return false;
    if (v.kind === "select" && (!Array.isArray(v.options) || v.options.length === 0)) return false;
    return v.options === undefined || (Array.isArray(v.options) && v.options.every((option) =>
      isRecord(option) && isAuthId(option.id) && isNonEmpty(option.label)
      && (option.description === undefined || typeof option.description === "string")));
  }
  if (!["info", "auth_url", "device_code", "progress"].includes(String(v.type))) return false;
  for (const key of ["message", "label", "userCode"]) {
    if (v[key] !== undefined && typeof v[key] !== "string") return false;
  }
  for (const key of ["url", "verificationUri"]) {
    if (v[key] !== undefined && !isAuthUrl(v[key])) return false;
  }
  for (const key of ["intervalSeconds", "expiresInSeconds"]) {
    if (v[key] !== undefined && (!isNum(v[key]) || v[key] < 0)) return false;
  }
  if (v.type === "auth_url") return isAuthUrl(v.url);
  if (v.type === "device_code") return isNonEmpty(v.userCode) && isAuthUrl(v.verificationUri);
  return typeof v.message === "string";
}

const isAuthId = (value: unknown): value is string => isNonEmpty(value) && value.length <= 256;
function isAuthUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return !url.username && !url.password && (url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHost(url.hostname)));
  } catch { return false; }
}

/** 联网事实只有有限 boolean；不允许夹带额外宿主操作。 */
export function isValidOnlineStatus(value: unknown): value is { online: boolean } {
  return isRecord(value) && Object.keys(value).length === 1 && typeof value.online === "boolean";
}

export interface LoginProviderResult {
  ok: boolean;
  issue?: "invalid-input" | "cancelled" | "unsupported-auth" | "auth-failed" | "run-in-flight" | "storage-failed";
  message?: string;
}

/** 应用层实现的操作面：目录与认证事件走宿主专用通道，application 只暴露可经 dcode:op 分发的方法。 */
export type ApplicationOperationName = Exclude<
  OpName,
  "listModelCatalog" | "refreshModelCatalog" | "loginProvider" | "cancelLogin" | "replyAuthPrompt"
>;

// ---------- 应用快照（界面读取的只读视图） ----------

export interface AppSnapshot {
  /** 应用持有的同次待核创建；只读投影，不是另一条创建队列或已保存对象。 */
  pendingWorkspaceCreation?: WorkspaceCreationIntent | null;
  /** 同次命名任务保存待核意图；不是已创建对象或执行队列。 */
  pendingTaskCreation?: TaskCreationIntent | null;
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
  /** sessionId → 该会话的模型状态（选择方式、实际执行模型、路由尝试分别可辨） */
  sessionModels: Record<string, SessionModelState>;
  /** taskId → 任务用量只读汇总（按任务归属聚合主会话与成员会话） */
  taskUsage: Record<string, TaskUsageSummary>;
  execution: ExecutionInfo;
  /** 关闭收束失败等一次性错误；可见状态保留，不伪报成功 */
  closeError: AppIssue | null;
  /** 应用实例内每次真实失败的编号；清除错误不回退编号，读取和广播不新增。 */
  closeErrorRevision: number;
}

// ---------- 操作（界面经隔离桥发出） ----------

/** 宿主实际选择的目录；身份只属本次创建操作，不能用显示路径替代它提交。 */
export interface ProjectFolderSelection {
  operationId: string;
  requestId: string;
  selectionId: string;
  path: string;
}

export interface WorkspaceCreationIntent {
  operationId: string;
  selectionId: string;
  name: string;
  path: string;
}

export interface TaskCreationIntent {
  operationId: string;
  workspaceId: string;
  title: string;
}

/** 已确认保存的任务及其真实主会话定位，不隐式开始工作。 */
export interface CreatedTask extends Task {
  operationId: string;
  mainSessionId: string;
}

export type TaskCreationLookup =
  | { operationId: string; status: "created"; task: CreatedTask }
  | { operationId: string; status: "not-found" | "unknown" };

export interface DCodeOperations {
  getSnapshot(): Promise<AppSnapshot>;
  chooseProjectFolder(input: { operationId: string; requestId: string }): Promise<ProjectFolderSelection | null>;
  discardProjectFolder(input: { operationId: string }): Promise<void>;
  createWorkspace(input: { operationId: string; selectionId: string; name: string }): Promise<Workspace>;
  createTask(input: TaskCreationIntent & { parentId: null }): Promise<CreatedTask>;
  /** 只读核对原命名任务创建，不补建对象、不发输入。 */
  lookupTaskCreation(input: { operationId: string }): Promise<TaskCreationLookup>;
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
    /** 父任务短期草稿必须与taskId同锚点；缺省是空间新工作或既有任务输入。 */
    parentTaskId?: string;
    text: string;
    /**
     * 本次发送携带的引用（身份 + 快照）。与 text 分开保存：用户原文字不被引用改写，
     * 也不把引用内容拼进 text。缺省等价于无引用。
     */
    references?: readonly WorkReference[];
    mode: SendMode;
    operationId?: string;
  }): Promise<SendResult>;
  /**
   * 发现当前会话工作空间里可引用的文件与已接技能。只读：不同步发送、不开始执行、
   * 不安装任何东西、不新增成员授权。回执带 scope，迟到结果不得覆盖新会话／新工作空间。
   */
  listReferences(input: ListReferencesInput): Promise<ReferenceListing>;
  /**
   * 读取并固化一份引用快照。失败按真实原因码返回，不产生半成品引用；
   * 成功后该引用才可进入草稿。
   */
  captureReference(input: CaptureReferenceInput): Promise<WorkReference>;
  /** 重试同一次发送：复用该消息块的 operationId、原文、模式与原目标。 */
  retrySend(input: { sessionId: string; blockId: string }): Promise<SendResult>;
  /** 只读回查接收结果（lookupReceipt），不执行工作、不盲投。 */
  checkReceipt(input: { sessionId: string; blockId: string }): Promise<SendResult>;
  pauseRun(input: { sessionId: string }): Promise<void>;
  /** 恢复绑定最近一次明确用户恢复意图对应的控制令牌；过期被拒后不自动重投。 */
  resumeRun(input: { sessionId: string }): Promise<void>;
  updateSettings(input: Partial<Settings>): Promise<Settings>;
  /**
   * 自定义服务商的添加 / 编辑：保留服务协议、显示名、模型 ID、Base URL 及明确密钥动作。
   * apiKey 仅在本操作中以安全凭据方式落盘（永不进入快照 / 日志 / 返回值）。
   */
  configureModel(input: ModelSetupInput): Promise<ModelSetupResult>;
  /**
   * 应用当前模型：preset（供应商 + 目录模型）或 custom（同 configureModel 的自定义通路）。
   * 只有原子保存成立后才成为当前接入；运行中/状态未核实拒绝替换。
   */
  applyModel(input: ApplyModelInput): Promise<ApplyModelResult>;
  /** 读取供应商与模型目录（有界读取；不含凭据）。 */
  listModelCatalog(): Promise<ModelCatalogView>;
  /**
   * 读取两层模型入口：第一层是当前来源及其模型，第二层按来源分组搜索。
   * 只读：不同步发送、不启动执行、不读取额度（quota 初始为 null，由界面按需显式读取）。
   */
  listModelSources(input?: { sessionId?: string }): Promise<ModelSourcesView>;
  /**
   * 设定某条会话的模型选择（auto 或指定来源+模型）。
   * **仅对后续请求生效**：不中断正在输出的请求、不重投、不改历史请求的归属。
   * 同一操作内并发调用时，较早请求的迟到结果不得覆盖较新的选择。
   */
  setSessionModelChoice(input: { sessionId: string; choice: SessionModelChoice }): Promise<SessionModelState>;
  /** 设定某条会话的条件参数档位；只接受该来源该模型已核实支持的档位，否则按真实原因拒绝。 */
  setSessionThinkingLevel(input: { sessionId: string; level: ThinkingLevel | null }): Promise<SessionModelState>;
  /**
   * 只读额度事实。读取本身不发送输入、不启用执行、不解除暂停，也不因为读取而发起原工作。
   * 没有可靠来源时如实返回 unsupported/unknown，绝不返回 0 或可用。
   */
  readModelQuota(input: { sessionId?: string; sourceId: string; modelId: string }): Promise<QuotaFacts>;
  /**
   * 按当前工作重新判定该会话的模型（能力筛候选 → 读有效额度 → 决定采用/保留）。
   * 只做判定，不发起工作：界面据此显示采用结果与失败原因，最终成功另由请求结果呈现。
   */
  resolveSessionRouting(input: { sessionId: string }): Promise<SessionModelState>;
  /** 设定新会话的默认模型选择（只影响此后新建的会话）。 */
  setDefaultModelChoice(input: { choice: SessionModelChoice }): Promise<SetDefaultModelChoiceResult>;
  /** 明确刷新公共模型目录：无凭据 GET + ETag；失败/离线保留有效目录，返回真实结果。 */
  refreshModelCatalog(): Promise<RefreshCatalogResult>;
  /** 更换公共目录来源（默认 pi.dev）。立即吊销旧源在途请求，保存新来源并实际完成一次检查；
   *  失败保留旧来源与有效目录。来源变化不自动替换当前模型。 */
  setCatalogSource(input: { baseUrl: string }): Promise<SetCatalogSourceResult>;
  /** 目录修订通知：内容或来源状态真实变化时推送（不携带目录正文）。 */
  onCatalogChanged(listener: (info: { revision: number }) => void): () => void;
  /**
   * 启动一个供应商的认证流程（api_key 或 oauth）。prompt/auth_url 经 onAuthEvent 推送；
   * 取消走 cancelLogin；完整凭据直接进主进程安全存储，返回值与快照不含秘密。
   */
  loginProvider(input: { loginId: string; providerId: string; type: "api_key" | "oauth" }): Promise<LoginProviderResult>;
  /** 取消进行中的认证；较晚的完成/失败回执不得覆盖较新配置。取消本身不等于已保存。 */
  cancelLogin(input: { loginId: string }): Promise<{ ok: boolean }>;
  /** 订阅认证交互事件（prompt/info/auth_url/device_code/progress）。 */
  onAuthEvent(listener: (event: AuthEventPayload) => void): () => void;
  /** 回答一次 prompt（requestId 绑定当次提问；cancel=true 表示取消该次输入）。 */
  replyAuthPrompt(input: { requestId: string; value?: string; cancel?: boolean }): Promise<{ ok: boolean }>;
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
  "chooseProjectFolder",
  "discardProjectFolder",
  "createWorkspace",
  "createTask",
  "lookupTaskCreation",
  "moveTask",
  "createSession",
  "sendMessage",
  "listReferences",
  "captureReference",
  "retrySend",
  "checkReceipt",
  "pauseRun",
  "resumeRun",
  "updateSettings",
  "configureModel",
  "applyModel",
  "listModelCatalog",
  "listModelSources",
  "setSessionModelChoice",
  "setSessionThinkingLevel",
  "readModelQuota",
  "resolveSessionRouting",
  "setDefaultModelChoice",
  "refreshModelCatalog",
  "setCatalogSource",
  "loginProvider",
  "cancelLogin",
  "replyAuthPrompt",
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
    if (!["theme", "fontSize", "coldStart", "language", "newSessionModelChoice", "modelCandidates", "projectExtensionsEnabled"].includes(key)) return `updateSettings 未知设置项: ${key}`;
  }
  if (input.projectExtensionsEnabled !== undefined && typeof input.projectExtensionsEnabled !== "boolean") return "updateSettings.projectExtensionsEnabled 须为布尔值";
  if (input.modelCandidates !== undefined) {
    if (!Array.isArray(input.modelCandidates)) return "updateSettings.modelCandidates 须为数组";
    for (const c of input.modelCandidates) {
      if (!isRecord(c) || !isNonEmpty(c.sourceId) || !isNonEmpty(c.modelId)) return "updateSettings.modelCandidates 条目非法";
    }
  }
  if (input.newSessionModelChoice !== undefined && !isSessionModelChoice(input.newSessionModelChoice)) return "updateSettings.newSessionModelChoice 非法取值";
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
    (value.projectExtensionsEnabled === undefined || typeof value.projectExtensionsEnabled === "boolean") &&
    THEME_VALUES.includes(value.theme as string) &&
    Number.isInteger(value.fontSize) &&
    (value.fontSize as number) >= FONT_SIZE_MIN &&
    (value.fontSize as number) <= FONT_SIZE_MAX &&
    COLD_START_VALUES.includes(value.coldStart as string) &&
    LANGUAGE_VALUES.includes(value.language as string) &&
    isSessionModelChoice(value.newSessionModelChoice) &&
    Array.isArray(value.modelCandidates)
      && value.modelCandidates.every((c) => isRecord(c) && isNonEmpty(c.sourceId) && isNonEmpty(c.modelId))
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
    return ["paused", "stale-control", "conflict", "not-found", "storage-rejected", "model-unavailable", "execution-unavailable"].includes(r.reason as string);
  }
  if (r.status === "unknown") return r.reason === "storage-unavailable";
  return false;
}

function isValidSendResult(v: unknown): v is SendResult {
  return isRecord(v) && isId(v.sessionId) && isValidReceipt(v.receipt);
}

function isValidToolData(t: unknown): boolean {
  try { if (isRecord(t)) parseWorkImages(t.images); } catch { return false; }
  return (
    isRecord(t) &&
    isStr(t.name) &&
    isStr(t.primaryText) &&
    isStr(t.output) &&
    (t.outputTruncation === undefined || (isRecord(t.outputTruncation)
      && Number.isSafeInteger(t.outputTruncation.droppedBytes) && (t.outputTruncation.droppedBytes as number) >= 0
      && Number.isSafeInteger(t.outputTruncation.droppedLines) && (t.outputTruncation.droppedLines as number) >= 0)) &&
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

/** 执行结果跨模块投影时也核对有限差异结构，不接受任意工具 details。 */
export function parseExecutionChanges(value: unknown): FileChange[] {
  if (!Array.isArray(value) || value.length > 512 || !value.every(isValidFileChange)
    || JSON.stringify(value).length > 1024 * 1024
    || value.some(file => !file.path || file.path.includes('\0') || !Number.isSafeInteger(file.added) || file.added < 0 || !Number.isSafeInteger(file.deleted) || file.deleted < 0)) throw new Error('Invalid execution changes');
  return structuredClone(value) as FileChange[];
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
        (b.receipt === undefined || isValidReceipt(b.receipt)) &&
        (b.references === undefined || (Array.isArray(b.references) && b.references.every(isValidReferenceSummary))) &&
        (() => { try { if (b.images !== undefined) parseWorkImages(b.images); return true; } catch { return false; } })()
      );
    case "extension-message":
      return isStr(b.customType) && b.customType.length > 0 && b.customType.length <= 128 && isStr(b.text);
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
  if (m.kind === "preset") {
    if (!isNonEmpty(m.providerId) || !isNonEmpty(m.providerName)) return false;
    if (!isNonEmpty(m.modelId) || !isNonEmpty(m.modelName)) return false;
    if (typeof m.hasKey !== "boolean") return false;
    if (!Array.isArray(m.auth) || !m.auth.every((a) => a === "api_key" || a === "oauth")) return false;
    return ["ready", "auth-failed", "auth-unverified", "connect-failed"].includes(m.note as string);
  }
  if (m.kind === "preset-with-custom") {
    if (!isRecord(m.preset) || !isRecord(m.custom)) return false;
    const p = m.preset;
    if (!isNonEmpty(p.providerId) || !isNonEmpty(p.providerName)) return false;
    if (!isNonEmpty(p.modelId) || !isNonEmpty(p.modelName)) return false;
    if (typeof p.hasKey !== "boolean") return false;
    if (!Array.isArray(p.auth) || !p.auth.every((a) => a === "api_key" || a === "oauth")) return false;
    const c = m.custom;
    if (!isNonEmpty(c.label) || !isNonEmpty(c.modelId)) return false;
    if (c.provider !== "openai-completions" && c.provider !== "anthropic-messages") return false;
    if (!isNonEmpty(c.baseUrl) || typeof c.hasKey !== "boolean") return false;
    return ["ready", "auth-failed", "auth-unverified", "connect-failed"].includes(m.note as string);
  }
  if (m.kind !== "custom") return false;
  if (!isNonEmpty(m.label) || !isNonEmpty(m.modelId)) return false;
  if (m.provider !== "openai-completions" && m.provider !== "anthropic-messages") return false;
  if (!isNonEmpty(m.baseUrl) || typeof m.hasKey !== "boolean") return false;
  return ["ready", "auth-failed", "auth-unverified", "connect-failed"].includes(m.note as string);
}

/** 任务用量汇总的接收侧校验：范围、合计、按来源分开呈现，缺口如实带出。 */
export function isTaskUsageSummary(v: unknown): v is TaskUsageSummary {
  if (!isRecord(v)) return false;
  if (!isId(v.taskId)) return false;
  if (!Array.isArray(v.scope)) return false;
  for (const entry of v.scope) {
    if (!isRecord(entry) || !isId(entry.sessionId)) return false;
    if (entry.kind !== "main" && entry.kind !== "sub") return false;
    if (entry.usage !== null && !isWorkUsage(entry.usage)) return false;
  }
  if (v.totals !== null && !isWorkUsage(v.totals)) return false;
  // totals 为 null 时按来源也不得有数：没有可归属记录就不存在来源拆分
  if (v.totals === null && Array.isArray(v.bySource) && v.bySource.length > 0) return false;
  if (!Array.isArray(v.bySource)) return false;
  for (const src of v.bySource) {
    if (!isRecord(src) || !isId(src.sourceId) || typeof src.sourceLabel !== "string" || !src.sourceLabel) return false;
    if (!isWorkUsage(src.usage)) return false;
  }
  return v.incompleteReason === null || typeof v.incompleteReason === "string";
}

/**
 * 快照接收校验：按 AppSnapshot 契约逐字段核对——必需字段、类型、枚举，
 * timelines/runs 的每个值与每个时间线块都过形状校验。畸形快照不进入渲染层。
 */
export function isValidSnapshot(value: unknown): value is AppSnapshot {
  if (!isRecord(value)) return false;
  const pending = value.pendingWorkspaceCreation;
  if (pending !== undefined && pending !== null && (!isRecord(pending) || !isId(pending.operationId) || !isId(pending.selectionId)
    || typeof pending.name !== 'string' || !pending.name.trim() || pending.name.length > 120 || /[\u0000-\u001f]/.test(pending.name)
    || typeof pending.path !== 'string' || !pending.path.startsWith('/') || pending.path.includes('\0'))) return false;
  const taskCreation = value.pendingTaskCreation;
  if (taskCreation !== undefined && taskCreation !== null && (!isRecord(taskCreation) || !isId(taskCreation.operationId)
    || !isId(taskCreation.workspaceId) || typeof taskCreation.title !== 'string' || !taskCreation.title.trim()
    || taskCreation.title.length > 120 || /[\u0000-\u001f]/.test(taskCreation.title))) return false;
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
  if (!isRecord(value.sessionModels)) return false;
  for (const sessionState of Object.values(value.sessionModels)) {
    if (!isSessionModelState(sessionState)) return false;
  }
  // 任务用量汇总：逐项核对，并要求键与任务一致（错挂任务的汇总会被拒）
  if (!isRecord(value.taskUsage)) return false;
  for (const [taskId, summary] of Object.entries(value.taskUsage)) {
    if (!isTaskUsageSummary(summary)) return false;
    if (summary.taskId !== taskId) return false;
    if (!Array.isArray(value.tasks) || !value.tasks.some((t) => isRecord(t) && t.id === taskId)) return false;
  }
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
    case "chooseProjectFolder":
      return isRecord(input) && isId(input.operationId) && isId(input.requestId)
        && Object.keys(input).every(key => ["operationId", "requestId"].includes(key)) ? null : "chooseProjectFolder 载荷畸形";
    case "discardProjectFolder":
      return isRecord(input) && isId(input.operationId) && Object.keys(input).every(key => key === "operationId")
        ? null : "discardProjectFolder 载荷畸形";
    case "createWorkspace":
      return isRecord(input) && isId(input.operationId) && isId(input.selectionId) && typeof input.name === "string"
        && input.name.trim().length > 0 && input.name.trim().length <= 120 && !/[\u0000-\u001f]/u.test(input.name)
        && Object.keys(input).every(key => ["operationId", "selectionId", "name"].includes(key)) ? null : "createWorkspace 载荷畸形";
    case "createTask":
      return isRecord(input) && isId(input.operationId) && isId(input.workspaceId) && input.parentId === null
        && typeof input.title === "string" && !!input.title.trim() && input.title.trim().length <= 120 && !/[\u0000-\u001f]/u.test(input.title)
        && Object.keys(input).every(key => ["operationId", "workspaceId", "parentId", "title"].includes(key))
        ? null
        : "createTask 载荷畸形";
    case "lookupTaskCreation":
      return isRecord(input) && isId(input.operationId) && Object.keys(input).every(key => key === "operationId") ? null : "lookupTaskCreation 载荷畸形";
    case "moveTask":
      return isRecord(input) && isId(input.taskId) && isId(input.targetWorkspaceId) ? null : "moveTask 载荷畸形";
    case "createSession":
      return isRecord(input) && isId(input.taskId) ? null : "createSession 载荷畸形";
    case "sendMessage": {
      if (
        !isRecord(input) ||
        !(isId(input.sessionId) || isId(input.taskId)) ||
        typeof input.text !== "string" ||
        input.text.trim().length === 0 ||
        (input.mode !== "steer" && input.mode !== "follow-up") ||
        (input.operationId !== undefined && !isId(input.operationId)) ||
        (input.parentTaskId !== undefined && (!isId(input.parentTaskId) || input.parentTaskId !== input.taskId || input.sessionId !== undefined))
      ) {
        return "sendMessage 载荷畸形";
      }
      // 引用逐条走同一 schema；畸形引用让整次发送被拒，不静默丢弃后照常发送。
      try {
        parseWorkReferences(input.references);
      } catch {
        return "sendMessage 引用载荷畸形";
      }
      return null;
    }
    case "listReferences":
      // 会话或草稿任务二选一：草稿态同样能引用，但不隐式创建会话对象。
      return isRecord(input) &&
        ((isId(input.sessionId) && input.taskId === undefined) || (isId(input.taskId) && input.sessionId === undefined)) &&
        (input.operationId === undefined || isId(input.operationId))
        ? null
        : "listReferences 载荷畸形";
    case "captureReference":
      return isRecord(input) &&
        ((isId(input.sessionId) && input.taskId === undefined) || (isId(input.taskId) && input.sessionId === undefined)) &&
        (input.kind === "file" || input.kind === "skill") &&
        typeof input.locator === "string" &&
        (input.operationId === undefined || isId(input.operationId))
        ? null
        : "captureReference 载荷畸形";
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
    case "applyModel":
      return validateApplyModelInput(input);
    case "listModelCatalog":
      return input === undefined ? null : "listModelCatalog 不接受参数";
    case "listModelSources":
      return input === undefined || (isRecord(input) && Object.keys(input).every((k) => k === "sessionId") && (input.sessionId === undefined || isId(input.sessionId)))
        ? null
        : "listModelSources 载荷畸形";
    case "setSessionModelChoice":
      return isRecord(input)
        && Object.keys(input).every((k) => k === "sessionId" || k === "choice")
        && isId(input.sessionId)
        && isSessionModelChoice(input.choice)
        ? null
        : "setSessionModelChoice 载荷畸形";
    case "setSessionThinkingLevel":
      return isRecord(input)
        && Object.keys(input).every((k) => k === "sessionId" || k === "level")
        && isId(input.sessionId)
        && (input.level === null || isThinkingLevel(input.level))
        ? null
        : "setSessionThinkingLevel 载荷畸形";
    case "readModelQuota":
      return isRecord(input)
        && Object.keys(input).every((k) => ["sessionId", "sourceId", "modelId"].includes(k))
        && isId(input.sourceId)
        && isId(input.modelId)
        && (input.sessionId === undefined || isId(input.sessionId))
        ? null
        : "readModelQuota 载荷畸形";
    case "resolveSessionRouting": {
      if (!isRecord(input)) return "resolveSessionRouting 载荷畸形";
      // work 为可选的当前工作条件；给了就必须逐项核对，未知键不放行
      if (input.work !== undefined) {
        if (!isRecord(input.work)) return "resolveSessionRouting.work 载荷畸形";
        for (const key of Object.keys(input.work)) {
          if (!["requires", "runnable", "notRunnableReason", "explicitIdentity"].includes(key)) return `resolveSessionRouting.work 未知字段: ${key}`;
        }
        if (!Array.isArray(input.work.requires) || !input.work.requires.every((c) => (WORK_CAPABILITIES as readonly string[]).includes(c as string))) {
          return "resolveSessionRouting.work.requires 非法";
        }
        if (typeof input.work.runnable !== "boolean") return "resolveSessionRouting.work.runnable 必填且为布尔";
        if (input.work.notRunnableReason !== undefined && typeof input.work.notRunnableReason !== "string") return "resolveSessionRouting.work.notRunnableReason 非法";
        if (input.work.explicitIdentity !== undefined && input.work.explicitIdentity !== null) {
          const e = input.work.explicitIdentity;
          if (!isRecord(e) || !isId(e.sourceId) || !isId(e.modelId)) return "resolveSessionRouting.work.explicitIdentity 载荷畸形";
        }
      }
      return Object.keys(input).every((k) => k === "sessionId" || k === "work") && isId(input.sessionId) ? null : "resolveSessionRouting 载荷畸形";
    }
    case "setDefaultModelChoice":
      return isRecord(input) && Object.keys(input).every((k) => k === "choice") && isSessionModelChoice(input.choice)
        ? null
        : "setDefaultModelChoice 载荷畸形";
    case "refreshModelCatalog":
      return input === undefined ? null : "refreshModelCatalog 不接受参数";
    case "setCatalogSource": {
      if (!isRecord(input)) return "setCatalogSource 载荷畸形";
      for (const key of Object.keys(input)) {
        if (key !== "baseUrl") return `setCatalogSource 未知字段: ${key}`;
      }
      if (typeof input.baseUrl !== "string") return "setCatalogSource.baseUrl 必填且为字符串";
      let url: URL;
      try { url = new URL(input.baseUrl as string); } catch { return "setCatalogSource.baseUrl 须为合法 URL"; }
      if (url.protocol !== "http:" && url.protocol !== "https:") return "setCatalogSource.baseUrl 仅允许 http/https";
      if (url.username || url.password) return "setCatalogSource.baseUrl 不允许自带用户/凭据段";
      if (url.search || url.hash) return "setCatalogSource.baseUrl 不允许查询或片段";
      if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) return "setCatalogSource.baseUrl 远程仅允许 HTTPS";
      return null;
    }
    case "loginProvider":
      return isRecord(input) && Object.keys(input).every((key) => ["loginId", "providerId", "type"].includes(key)) && isAuthId(input.loginId) && isAuthId(input.providerId) && (input.type === "api_key" || input.type === "oauth")
        ? null
        : "loginProvider 载荷畸形";
    case "cancelLogin":
      return isRecord(input) && Object.keys(input).every((key) => key === "loginId") && isAuthId(input.loginId) ? null : "cancelLogin 载荷畸形";
    case "replyAuthPrompt":
      return isRecord(input) && Object.keys(input).every((key) => ["requestId", "value", "cancel"].includes(key)) && isAuthId(input.requestId) && (input.value === undefined || (typeof input.value === "string" && input.value.length <= 16384)) && (input.cancel === undefined || typeof input.cancel === "boolean")
        ? null
        : "replyAuthPrompt 载荷畸形";
  }
}

/** applyModel 载荷校验：preset 只认 providerId/modelId 身份；custom 沿原 configureModel 校验（嵌套 input）。 */
function validateApplyModelInput(input: unknown): string | null {
  if (!isRecord(input)) return "applyModel 载荷畸形";
  if (input.kind === "preset") {
    for (const key of Object.keys(input)) {
      if (!["kind", "providerId", "modelId"].includes(key)) return `applyModel 未知字段: ${key}`;
    }
    if (!isId(input.providerId) || !isId(input.modelId)) return "applyModel preset 需要 providerId 与 modelId";
    return null;
  }
  if (input.kind === "custom") {
    for (const key of Object.keys(input)) {
      if (!["kind", "input"].includes(key)) return `applyModel 未知字段: ${key}`;
    }
    return validateModelSetupInput(input.input);
  }
  return "applyModel.kind 须为 preset 或 custom";
}

/**
 * 操作返回值的接收校验（preload 边界）：每个操作按既有返回契约核对，
 * 畸形返回不交付渲染层；无返回值的移动/删除/暂停/恢复只接受 undefined。
 */
export function isValidOpResponse(op: OpName, value: unknown): boolean {
  switch (op) {
    case "getSnapshot":
      return isValidSnapshot(value);
    case "chooseProjectFolder":
      return value === null || (isRecord(value) && isId(value.operationId) && isId(value.requestId) && isId(value.selectionId)
        && typeof value.path === "string" && value.path.startsWith("/") && !value.path.includes("\u0000"));
    case "createWorkspace":
      return isValidWorkspace(value);
    case "discardProjectFolder":
      return value === undefined;
    case "createTask":
      return isValidTask(value) && isRecord(value) && isId(value.operationId) && isId(value.mainSessionId) && value.kind === "long" && value.parentId === null && value.isDefault === false
        && Object.keys(value).every(key => ["id", "workspaceId", "parentId", "kind", "title", "boundFolder", "isDefault", "updatedAt", "operationId", "mainSessionId"].includes(key));
    case "lookupTaskCreation":
      return isRecord(value) && isId(value.operationId) && (value.status === "not-found" || value.status === "unknown"
        ? Object.keys(value).every(key => ["operationId", "status"].includes(key))
        : value.status === "created" && Object.keys(value).every(key => ["operationId", "status", "task"].includes(key)) && isValidOpResponse("createTask", value.task)
          && isRecord(value.task) && value.task.operationId === value.operationId);
    case "createSession":
      return isValidSession(value);
    case "sendMessage":
    case "retrySend":
    case "checkReceipt":
      return isValidSendResult(value);
    case "listReferences":
      return isValidReferenceListing(value);
    case "captureReference":
      // 选取成功才回一条合法引用；失败由应用层抛出带原因码的错误，不返回半成品。
      return isValidCapturedReference(value);
    case "updateSettings":
      return isValidSettings(value);
    case "configureModel":
      return isValidModelSetupResult(value);
    case "applyModel":
      return isValidApplyModelResult(value);
    case "listModelCatalog":
      return isValidModelCatalogView(value);
    case "listModelSources":
      return isValidModelSourcesView(value);
    case "setSessionModelChoice":
    case "setSessionThinkingLevel":
    case "resolveSessionRouting":
      return isSessionModelState(value);
    case "readModelQuota":
      return isQuotaFacts(value);
    case "setDefaultModelChoice":
      return isRecord(value) && typeof value.ok === "boolean" && isSessionModelChoice(value.choice)
        && (value.message === undefined || typeof value.message === "string");
    case "refreshModelCatalog":
      return isValidRefreshCatalogResult(value);
    case "setCatalogSource":
      return isRecord(value) && typeof value.ok === "boolean"
        && (value.ok || (typeof value.issue === "string" && typeof value.message === "string"));
    case "loginProvider":
      return isValidLoginProviderResult(value);
    case "cancelLogin":
    case "replyAuthPrompt":
      return isRecord(value) && typeof value.ok === "boolean";
    case "moveTask":
    case "pauseRun":
    case "resumeRun":
      return value === undefined;
    default:
      return false;
  }
}

function isValidApplyModelResult(v: unknown): v is ApplyModelResult {
  if (!isRecord(v)) return false;
  if (typeof v.ok !== "boolean") return false;
  return v.ok || (typeof v.issue === "string" && typeof v.message === "string");
}

function isValidLoginProviderResult(v: unknown): v is LoginProviderResult {
  return isValidApplyModelResult(v as ApplyModelResult);
}

function isValidRefreshCatalogResult(v: unknown): v is RefreshCatalogResult {
  return isRecord(v) && typeof v.ok === "boolean" && Number.isSafeInteger(v.revision)
    && (v.message === undefined || typeof v.message === "string");
}

function isValidCost(v: unknown): boolean {
  return isRecord(v) && isNum(v.input) && isNum(v.output) && isNum(v.cacheRead) && isNum(v.cacheWrite);
}

function isValidCatalogModelView(v: unknown): v is CatalogModelView {
  if (!isRecord(v)) return false;
  if (!isNonEmpty(v.id) || !isNonEmpty(v.name)) return false;
  if (!isNum(v.contextWindow) || !isNum(v.maxTokens)) return false;
  if (!Array.isArray(v.input) || !v.input.every((i) => i === "text" || i === "image")) return false;
  if (typeof v.reasoning !== "boolean") return false;
  if (!isValidCost(v.cost)) return false;
  if (typeof v.executable !== "boolean") return false;
  if (v.reason !== undefined && typeof v.reason !== "string") return false;
  return v.source === "builtin" || v.source === "remote";
}

function isValidProviderDirectoryEntry(v: unknown): v is ProviderDirectoryEntry {
  return isRecord(v) && isNonEmpty(v.id) && isNonEmpty(v.name)
    && Array.isArray(v.auth) && (v.auth as unknown[]).every((a) => a === "api_key" || a === "oauth")
    && typeof v.hasStoredKey === "boolean" && Number.isSafeInteger(v.modelCount);
}

function isValidModelPickItem(v: unknown): boolean {
  if (!isRecord(v)) return false;
  if (!isNonEmpty(v.sourceId) || !isNonEmpty(v.modelId) || typeof v.modelLabel !== "string") return false;
  // 能力资料未核实时为 null，额度未读取时为 null；两者都不接受被当成「已核实 / 已可用」
  if (v.capabilities !== null && !isVerifiedModelCapabilities(v.capabilities)) return false;
  return v.quota === null || isQuotaFacts(v.quota);
}

function isValidModelSourcePick(v: unknown): boolean {
  if (!isRecord(v)) return false;
  if (!isNonEmpty(v.sourceId) || typeof v.sourceLabel !== "string" || typeof v.configured !== "boolean") return false;
  return Array.isArray(v.models) && v.models.every(isValidModelPickItem);
}

function isValidModelSourcesView(v: unknown): boolean {
  if (!isRecord(v)) return false;
  if (!Array.isArray(v.sources) || !v.sources.every(isValidModelSourcePick)) return false;
  if (!isSessionModelChoice(v.defaultChoice)) return false;
  return Array.isArray(v.sessionStates) && v.sessionStates.every(isSessionModelState);
}

export function isValidModelCatalogView(v: unknown): v is ModelCatalogView {
  if (!isRecord(v)) return false;
  if (!Array.isArray(v.providers) || !v.providers.every(isValidProviderDirectoryEntry)) return false;
  if (!isRecord(v.models)) return false;
  for (const list of Object.values(v.models)) {
    if (!Array.isArray(list) || !list.every(isValidCatalogModelView)) return false;
  }
  if (!isRecord(v.source)) return false;
  const s = v.source;
  if (typeof s.baseUrl !== "string") return false;
  if (!(s.lastSuccessAt === null || isNum(s.lastSuccessAt))) return false;
  if (typeof s.updating !== "boolean") return false;
  if (!(s.lastError === null || typeof s.lastError === "string")) return false;
  return Number.isSafeInteger(s.revision);
}

function isValidModelSetupResult(v: unknown): v is ModelSetupResult {
  if (!isRecord(v)) return false;
  if (typeof v.ok !== "boolean") return false;
  return v.ok || (typeof v.issue === "string" && typeof v.message === "string");
}
