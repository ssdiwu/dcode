import { homedir } from "node:os";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

/**
 * 首个只读工具 facade（ADR 0024 决定 3）：把 D Code 宿主独有、
 * 模型无法用 bash / 文件读取等价重建的派生事实暴露进同一个 Pi Agent Loop。
 * 只读，不做任何写动作；账本缺失或损坏时如实报不可用，不伪造空成功。
 */
export interface DCodeFactsPathSummary {
  id: string;
  title: string;
  isCurrent: boolean;
  entryCount: number;
}

export interface DCodeFactsContext {
  sessionId: () => string | undefined;
  cwd: () => string | undefined;
  paths: () => DCodeFactsPathSummary[];
}

export const DCODE_FACTS_TOOL_NAME = "dcode_facts";

export function dCodeFactsDirectory(): string {
  return join(homedir(), "Library", "Application Support", "D Code");
}

async function readJsonFile(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 目录可能已被删除：符号链接解析失败时保留原样，匹配结果如实。 */
async function resolveRealPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

export function createDCodeFactsExtension(
  context: DCodeFactsContext,
  options: { factsDir?: string } = {},
): ExtensionFactory {
  const factsDir = options.factsDir ?? dCodeFactsDirectory();
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: DCODE_FACTS_TOOL_NAME,
      label: "D Code 事实",
      description:
        "读取 D Code 宿主独有的事实。kind=changes 返回当前会话的结构化文件变更归因（来自本机账本，含每次写入的文件、增删行数与 revision 来源）；kind=evidence 返回当前会话真实命令执行的验证证据（命令、退出推导、revision）；kind=lineage 返回当前会话的谱系路径（标题、记录数、当前路径）；kind=project 返回当前工作目录所属 D Code 项目的 Source Folder 集合。全部只读。",
      promptSnippet:
        "dcode_facts: 读取 D Code 宿主独有的会话变更归因、验证证据、会话谱系与项目 Source Folder（只读）。",
      parameters: Type.Object({
        kind: Type.Union([
          Type.Literal("changes"),
          Type.Literal("evidence"),
          Type.Literal("lineage"),
          Type.Literal("project"),
        ]),
      }),
      async execute(_toolCallId, params) {
        const sessionId = context.sessionId();
        if (sessionId === undefined) {
          return {
            content: [{ type: "text", text: "当前没有打开的 D Code 会话，无法提供事实。" }],
            details: { kind: params.kind, available: false },
          };
        }
        let text: string;
        try {
          text = await factsForKind(params.kind, sessionId, context, factsDir);
        } catch (error) {
          text = `读取 D Code 事实失败：${error instanceof Error ? error.message : String(error)}`;
          return {
            content: [{ type: "text", text }],
            details: { kind: params.kind, available: false },
          };
        }
        return {
          content: [{ type: "text", text }],
          details: { kind: params.kind, available: true },
        };
      },
    });
  };
}

async function factsForKind(
  kind: "changes" | "evidence" | "lineage" | "project",
  sessionId: string,
  context: DCodeFactsContext,
  factsDir: string,
): Promise<string> {
  switch (kind) {
    case "changes":
      return await changeFactsSummary(sessionId, factsDir);
    case "evidence":
      return await evidenceFactsSummary(sessionId, factsDir);
    case "lineage":
      return lineageFactsSummary(context);
    case "project":
      return await projectFactsSummary(context, factsDir);
  }
}

async function changeFactsSummary(sessionId: string, factsDir: string): Promise<string> {
  const document = await readJsonFile(join(factsDir, "session-changes-v1.json"));
  const records = isRecord(document) && Array.isArray(document.records)
    ? (document.records as unknown[]).filter(isRecord)
    : null;
  if (records === null) {
    return "会话变更账本不可用（文件缺失或损坏）。本会话没有可读取的结构化变更归因。";
  }
  const mine = records.filter((record) => record.sessionId === sessionId);
  if (mine.length === 0) return "当前会话在变更账本中没有记录。";
  const lines = mine.slice(-30).map((record) => {
    const file = typeof record.filePath === "string" ? record.filePath : "(未知文件)";
    const additions = typeof record.additions === "number" ? record.additions : 0;
    const deletions = typeof record.deletions === "number" ? record.deletions : 0;
    const line = typeof record.firstChangedLine === "number" ? `，首次变更行 ${record.firstChangedLine}` : "";
    // Swift 账本合同：source 恒为 "structured-tool-v1"（SessionChangeModels.swift 校验）。
    const source = record.source === "structured-tool-v1" ? "" : "，来源非 D Code";
    return `- ${file}（+${additions} −${deletions}${line}${source}）`;
  });
  const more = mine.length > 30 ? `\n…共 ${mine.length} 条，仅显示最近 30 条` : "";
  return `当前会话的结构化变更归因（来自 D Code 本机账本，共 ${mine.length} 条）：\n${lines.join("\n")}${more}`;
}

interface EvidenceRecordLike {
  sessionId?: unknown;
  command?: unknown;
  exitKind?: unknown;
  exitCode?: unknown;
  gitRevision?: unknown;
}

/** Swift VerificationEvidenceRecord 的真实三值（VerificationModels.swift）。 */
function evidenceOutcome(record: EvidenceRecordLike): string {
  switch (record.exitKind) {
    case "ok":
      return "成功";
    case "failure":
      return typeof record.exitCode === "number" ? `失败（退出码 ${record.exitCode}）` : "失败";
    default:
      return "结果未知";
  }
}

async function evidenceFactsSummary(sessionId: string, factsDir: string): Promise<string> {
  const parsed = await readJsonFile(join(factsDir, "verification-evidence-v1.json"));
  // Swift 侧存储合同：VerificationEvidenceDocument { version, records }。
  const records = isRecord(parsed) && Array.isArray(parsed.records)
    ? (parsed.records as unknown[]).filter(isRecord)
    : null;
  if (records === null) {
    return "验证证据账本不可用（文件缺失或损坏）。本会话没有可读取的命令执行证据。";
  }
  const mine = records.filter((record) => record.sessionId === sessionId);
  if (mine.length === 0) return "当前会话在验证证据账本中没有记录。";
  const lines = mine.slice(-20).map((record) => {
    const command = typeof record.command === "string" ? record.command : "(未知命令)";
    const revision = typeof record.gitRevision === "string" && record.gitRevision.length > 0
      ? `，revision ${record.gitRevision.slice(0, 12)}`
      : "";
    return `- ${command} → ${evidenceOutcome(record)}${revision}`;
  });
  const more = mine.length > 20 ? `\n…共 ${mine.length} 条，仅显示最近 20 条` : "";
  return `当前会话的真实命令执行证据（来自 D Code 本机账本，共 ${mine.length} 条；Agent 文案不构成证据）：\n${lines.join("\n")}${more}`;
}

function lineageFactsSummary(context: DCodeFactsContext): string {
  const paths = context.paths();
  if (paths.length === 0) return "当前会话只有主路径，没有分叉谱系。";
  const lines = paths.map((path) =>
    `- ${path.title}（${path.entryCount} 条记录${path.isCurrent ? "，当前路径" : ""}）`,
  );
  return `当前会话的谱系路径：\n${lines.join("\n")}`;
}

interface ProjectLike {
  name?: unknown;
  sourceFolders?: unknown;
}

async function projectFactsSummary(context: DCodeFactsContext, factsDir: string): Promise<string> {
  const cwd = context.cwd();
  if (cwd === undefined) return "当前没有打开的会话，无法确定工作目录。";
  // Swift 侧存储合同：ProjectStore 写 projects-v1.json 的 { version, projects }。
  const parsed = await readJsonFile(join(factsDir, "projects-v1.json"));
  const list = isRecord(parsed) && Array.isArray(parsed.projects)
    ? (parsed.projects as unknown[]).filter(isRecord)
    : null;
  if (list === null) {
    return "D Code 项目登记不可用（文件缺失或损坏）。";
  }
  // 与 Swift ProjectSessionOwnershipResolver 对齐：解析符号链接后再比较，
  // 否则经符号链接打开的工作目录（如 /tmp → /private/tmp）会匹配失败。
  const normalizedCwd = await resolveRealPath(cwd);
  const owned: ProjectLike[] = [];
  for (const project of list.map((entry) => entry as ProjectLike)) {
    const folders = Array.isArray(project.sourceFolders)
      ? project.sourceFolders.filter(isRecord)
      : [];
    const matches = await Promise.all(
      folders.map(async (folder) =>
        typeof folder.path === "string"
          && await resolveRealPath(folder.path) === normalizedCwd),
    );
    if (matches.some((matched) => matched)) owned.push(project);
  }
  if (owned.length === 0) {
    return `当前工作目录 ${cwd} 未归入任何 D Code 项目。`;
  }
  const sections = owned.map((project) => {
    const folders = Array.isArray(project.sourceFolders)
      ? project.sourceFolders.filter(isRecord).map((folder) => String(folder.path))
      : [];
    return `- ${String(project.name ?? "(未命名项目)")}：${folders.join("、")}`;
  });
  return `当前工作目录归属的 D Code 项目与 Source Folder 集合：\n${sections.join("\n")}`;
}
