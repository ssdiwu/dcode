/**
 * 引用（文件／技能）的共享契约。
 *
 * 规则（见 spec/页面与交互组件.md#c05-引用入口载荷归属与竞态）：
 * - 引用是草稿内的可移除附加项，不新建发送或运行对象，也不新增成员授权；
 * - 身份（来源与定位）与快照（实际参与请求的字节）分别保存，用户原文字不被改写；
 * - 读取事实归主进程适配器，界面不直连文件系统、Node、Electron 或 Pi。
 */

/** 引用种类：当前只有真实工作空间文件与已接技能；未来已接插件走同一入口的第三种取值。 */
export type ReferenceKind = "file" | "skill";

/** 单条引用的快照：对**实际读到并参与请求的字节**求值，不引用未来可能变化的磁盘状态。
 *  `content` 是即将参与本次请求的原文；`contentHash` 必须等于对它求的 sha256，
 *  业务接收方在推进执行前逐条核对，两者不符即拒收（防止"声称引用但内容没进去"）。 */
export type ReferenceSnapshot = Readonly<{
  /** 对参与请求的内容求 sha256（十六进制） */
  contentHash: string;
  /** 原始字节数（未截断时的真实大小） */
  byteSize: number;
  /** 快照时刻（epoch ms） */
  capturedAt: number;
  /** 是否因上限截断；为真时界面必须同时显示原始字节数，不得当作完整内容 */
  truncated: boolean;
  /** 实际参与请求的文本内容 */
  content: string;
}>;

/** 草稿内的一条引用。refId 在一次草稿内唯一，去重按 (kind, locator)。 */
export type WorkReference = Readonly<{
  refId: string;
  kind: ReferenceKind;
  label: string;
  /** 相对工作空间根的路径（技能为其 SKILL.md 路径）；不得越出根 */
  locator: string;
  /** `workspace:<workspaceId>` 或 `skill:<name>` */
  sourceId: string;
  snapshot: ReferenceSnapshot;
}>;

/** 浮层里可选择的一项（尚未选取，因此没有快照）。 */
export type ReferenceCandidate = Readonly<{
  kind: ReferenceKind;
  label: string;
  locator: string;
  sourceId: string;
  /** 一行可读补充（技能描述／文件所在子目录），可缺省 */
  detail?: string;
}>;

/** 引用在历史与视图里的留存形态：身份 + 快照元数据，不带正文。
 *  正文只在提交那一刻随 WorkInput 进入执行端；历史只留"当时引用了什么、是哪一版"。 */
export type ReferenceSummary = Readonly<{
  refId: string;
  kind: ReferenceKind;
  label: string;
  locator: string;
  sourceId: string;
  snapshot: Readonly<Omit<ReferenceSnapshot, "content">>;
}>;

export function toReferenceSummary(ref: WorkReference): ReferenceSummary {
  return Object.freeze({
    refId: ref.refId,
    kind: ref.kind,
    label: ref.label,
    locator: ref.locator,
    sourceId: ref.sourceId,
    snapshot: Object.freeze({
      contentHash: ref.snapshot.contentHash,
      byteSize: ref.snapshot.byteSize,
      capturedAt: ref.snapshot.capturedAt,
      truncated: ref.snapshot.truncated,
    }),
  });
}

/** 失败与提示的有限安全码：不携带路径原文、宿主错误栈或凭据。 */
export type ReferenceIssueCode =
  | "workspace-unbound"
  | "outside-root"
  | "not-found"
  | "unreadable"
  | "permission-denied"
  | "too-large"
  | "binary"
  | "skills-unavailable"
  | "list-truncated";

export type ReferenceIssue = Readonly<{ code: ReferenceIssueCode; message: string }>;

/** 发现结果。scope 用于回执归属核对：迟到结果不得覆盖新会话／新工作空间。 */
export type ReferenceListing = Readonly<{
  /** 归属凭据：会话或草稿任务二选一，迟到结果按它比对，不匹配当前选择就丢弃 */
  scope: Readonly<{ workspaceId: string; sessionId: string | null; taskId: string | null; operationId: string }>;
  /** 真实工作空间根；null = 该会话未绑定目录，此时 files 为空并给出 workspace-unbound */
  root: string | null;
  files: readonly ReferenceCandidate[];
  skills: readonly ReferenceCandidate[];
  issues: readonly ReferenceIssue[];
}>;

/**
 * 引用操作的归属：已有会话给 sessionId；新任务草稿（还没有会话）给 taskId。
 * 二选一，不允许同时给，也不允许都不给——草稿态同样能引用，但不因此创建或发送任何会话对象。
 */
export type ReferenceScopeInput = { sessionId: string; taskId?: undefined } | { sessionId?: undefined; taskId: string };

/** 发现请求：只读，不发送、不执行、不安装、不新增授权。 */
export type ListReferencesInput = ReferenceScopeInput & {
  /** 同一草稿多次打开时携带上次的结果身份；不一致的迟到结果由接收侧丢弃 */
  operationId?: string;
};

/** 选取请求：读取并固化一份快照；失败返回 issues 且不产生引用。 */
export type CaptureReferenceInput = ReferenceScopeInput & {
  kind: ReferenceKind;
  locator: string;
  operationId?: string;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const isSha256 = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

export const REFERENCE_KINDS: readonly ReferenceKind[] = ["file", "skill"];

export const REFERENCE_ISSUE_CODES: readonly ReferenceIssueCode[] = [
  "workspace-unbound",
  "outside-root",
  "not-found",
  "unreadable",
  "permission-denied",
  "too-large",
  "binary",
  "skills-unavailable",
  "list-truncated",
];

/**
 * 相对定位的合法性：不得为绝对路径、不得含 `..` 段、不得为空。
 * 根边界另由接收端用 realpath 后的实际根核对（这里先挡明显越界形状）。
 */
export function isReferenceLocator(value: unknown): value is string {
  if (!isText(value)) return false;
  if (value.length > 512) return false;
  if (value.startsWith("/") || value.startsWith("~") || /^[A-Za-z]:[\\/]/.test(value)) return false;
  return !value.split(/[\\/]/).includes("..");
}

export function parseWorkReference(value: unknown): WorkReference {
  if (!isRecord(value)) throw new Error("Invalid reference");
  if (!isText(value.refId)) throw new Error("Invalid reference id");
  if (value.kind !== "file" && value.kind !== "skill") throw new Error("Invalid reference kind");
  if (!isReferenceLocator(value.locator)) throw new Error("Invalid reference locator");
  if (!isText(value.label) || value.label.length > 256) throw new Error("Invalid reference label");
  if (!isText(value.sourceId) || value.sourceId.length > 256) throw new Error("Invalid reference source");
  if (!isRecord(value.snapshot)) throw new Error("Invalid reference snapshot");
  const s = value.snapshot;
  if (!isSha256(s.contentHash)) throw new Error("Invalid reference hash");
  if (!Number.isSafeInteger(s.byteSize) || (s.byteSize as number) < 0) throw new Error("Invalid reference size");
  if (!Number.isSafeInteger(s.capturedAt) || (s.capturedAt as number) <= 0) throw new Error("Invalid reference time");
  if (typeof s.truncated !== "boolean") throw new Error("Invalid reference truncated");
  if (typeof s.content !== "string") throw new Error("Invalid reference content");
  return Object.freeze({
    refId: value.refId,
    kind: value.kind,
    label: value.label,
    locator: value.locator,
    sourceId: value.sourceId,
    snapshot: Object.freeze({
      contentHash: s.contentHash,
      byteSize: s.byteSize as number,
      capturedAt: s.capturedAt as number,
      truncated: s.truncated,
      content: s.content,
    }),
  });
}

export function parseWorkReferences(value: unknown): readonly WorkReference[] {
  if (value === undefined || value === null) return Object.freeze([]);
  if (!Array.isArray(value)) throw new Error("Invalid references");
  if (value.length > 32) throw new Error("Too many references");
  const refs = value.map(parseWorkReference);
  // refId 在一次草稿内唯一：重复会让回执清稿判据失去唯一依据，直接拒绝。
  const seen = new Set<string>();
  for (const ref of refs) {
    if (seen.has(ref.refId)) throw new Error("Duplicate reference id");
    seen.add(ref.refId);
  }
  return Object.freeze(refs);
}

/** 引用集合的稳定指纹：身份 + 快照内容。用于发送途中集合变化的判据。 */
export function referenceSetId(refs: readonly { kind: ReferenceKind; locator: string; snapshot: { contentHash: string } }[] | undefined): string {
  return JSON.stringify(
    (refs ?? [])
      .map((r) => [r.kind, r.locator, r.snapshot.contentHash])
      .sort((a, b) => (a[1] as string).localeCompare(b[1] as string)),
  );
}

function isCandidate(value: unknown): value is ReferenceCandidate {
  return (
    isRecord(value) &&
    (value.kind === "file" || value.kind === "skill") &&
    isText(value.label) &&
    isReferenceLocator(value.locator) &&
    isText(value.sourceId) &&
    (value.detail === undefined || typeof value.detail === "string")
  );
}

function isIssue(value: unknown): value is ReferenceIssue {
  return (
    isRecord(value) &&
    typeof value.code === "string" &&
    (REFERENCE_ISSUE_CODES as readonly string[]).includes(value.code) &&
    typeof value.message === "string"
  );
}

/** 接收侧运行时校验：发现结果畸形一律不交付，不渲染半份数据。 */
export function isValidReferenceListing(value: unknown): value is ReferenceListing {
  if (!isRecord(value) || !isRecord(value.scope)) return false;
  const scope = value.scope;
  if (!isText(scope.workspaceId) || !isText(scope.operationId)) return false;
  // 输出 scope 至少要指明一个归属；会话同时带出其任务是正常上下文，不算畸形。
  // （"二选一"约束的是**输入**——用户要么给会话要么给草稿任务，见 validateOperationInput。）
  if (scope.sessionId === null && scope.taskId === null) return false;
  if (scope.sessionId !== null && !isText(scope.sessionId)) return false;
  if (scope.taskId !== null && !isText(scope.taskId)) return false;
  if (!(value.root === null || typeof value.root === "string")) return false;
  if (!Array.isArray(value.files) || !value.files.every(isCandidate)) return false;
  if (!Array.isArray(value.skills) || !value.skills.every(isCandidate)) return false;
  if (!Array.isArray(value.issues) || !value.issues.every(isIssue)) return false;
  return true;
}

/** 接收侧运行时校验：选取回执必须是一条合法引用。 */
export function isValidCapturedReference(value: unknown): value is WorkReference {
  try {
    parseWorkReference(value);
    return true;
  } catch {
    return false;
  }
}

/** 接收侧运行时校验：历史／快照里的引用摘要（无正文）必须完整可核。 */
export function isValidReferenceSummary(value: unknown): value is ReferenceSummary {
  if (!isRecord(value)) return false;
  if (!isText(value.refId)) return false;
  if (value.kind !== "file" && value.kind !== "skill") return false;
  if (!isReferenceLocator(value.locator)) return false;
  if (!isText(value.label) || value.label.length > 256) return false;
  if (!isText(value.sourceId) || value.sourceId.length > 256) return false;
  if (!isRecord(value.snapshot)) return false;
  const s = value.snapshot;
  return (
    isSha256(s.contentHash) &&
    Number.isSafeInteger(s.byteSize) &&
    (s.byteSize as number) >= 0 &&
    Number.isSafeInteger(s.capturedAt) &&
    (s.capturedAt as number) > 0 &&
    typeof s.truncated === "boolean"
  );
}

/** 选取失败回执：有真实原因码，没有半成品引用。 */
export type CaptureReferenceFailure = Readonly<{ code: ReferenceIssueCode; message: string }>;

export function isValidCaptureFailure(value: unknown): value is CaptureReferenceFailure {
  return isIssue(value);
}