import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { redactCredentialText } from "./credential-material.js";

export interface DCodePromptTool {
  name: string;
  description: string;
  parameters: unknown;
}

export interface DCodePromptSourceReceipt {
  path: string;
  digest: string;
  bytes: number;
}

export interface DCodePromptDocument {
  receipt: DCodePromptSourceReceipt;
  content: string;
}

export interface DCodePromptEnvironment {
  runtimeId: string;
  scope: { kind: "user"; userId: string } | { kind: "project"; projectId: string };
  taskId: string;
  taskTitle: string;
  taskGoal: string;
  sessionId: string;
  sessionKind: string;
  workspaceId: string;
  cwd: string;
  workspaceAccess: "sharedReadOnly" | "exclusiveWrite";
  modelProvider?: string;
  modelId?: string;
  role: string;
  roleRevision: string;
  roleContract: string;
}

export interface AssembledDCodePrompt {
  text: string;
  digest: string;
  sources: DCodePromptSourceReceipt[];
  tools: DCodePromptTool[];
}

const MAX_DOCUMENT_BYTES = 64 * 1024;
const FIRST_CLASS_DOCUMENTS = [
  "AGENTS.md",
  "PRODUCT.md",
  "DESIGN.md",
  "README.md",
  "GLOSSARY.md",
  "doc/40-版本实施方案/README.md",
] as const;

export class DCodePromptCredentialError extends Error {
  constructor(readonly path: string) {
    super("D Code refused to load a Prompt document containing credential material");
    this.name = "DCodePromptCredentialError";
  }
}

function digest(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export async function loadDCodePromptDocuments(cwd: string): Promise<DCodePromptDocument[]> {
  const documents: DCodePromptDocument[] = [];
  for (const name of FIRST_CLASS_DOCUMENTS) {
    const path = join(cwd, name);
    try {
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_DOCUMENT_BYTES) continue;
      const bytes = await readFile(path);
      const content = bytes.toString("utf8");
      if (redactCredentialText(content).redacted) throw new DCodePromptCredentialError(path);
      documents.push({
        receipt: { path, digest: digest(bytes), bytes: bytes.byteLength },
        content,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  return documents;
}

export function assembleDCodeSystemPrompt(input: {
  environment: DCodePromptEnvironment;
  documents: readonly DCodePromptDocument[];
  tools: readonly DCodePromptTool[];
}): AssembledDCodePrompt {
  const tools = [...input.tools]
    .map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const scope = input.environment.scope.kind === "user"
    ? `User Scope（用户作用域）: ${input.environment.scope.userId}`
    : `Project Scope（项目作用域）: ${input.environment.scope.projectId}`;
  const toolManifest = tools.length === 0
    ? "- 本轮没有活动工具。"
    : tools.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n");
  const documents = input.documents.length === 0
    ? "（本轮没有加载一等项目文档正文。）"
    : input.documents.map((document) => (
      `\n<dcode_document path="${document.receipt.path}" digest="${document.receipt.digest}">\n`
      + `${document.content}\n</dcode_document>`
    )).join("\n");
  const text = `你是 D Code 的 ${input.environment.role} Agent（智能体），运行在 D Code ADE（智能体开发环境）中。

D Code 是产品与编排主体；Pi SDK 只是本轮 Agent Runtime（智能体运行时），不定义你的身份、产品对象或界面。不要自称 Pi CLI，也不要把 Session（会话）等同于 Task（任务）。

当前环境：
- ${scope}
- Task: ${input.environment.taskId} · ${input.environment.taskTitle}
- Task Goal: ${input.environment.taskGoal}
- D Code Session: ${input.environment.sessionId} · ${input.environment.sessionKind}
- Runtime: ${input.environment.runtimeId}
- Workspace: ${input.environment.workspaceId}
- cwd: ${input.environment.cwd}
- Workspace Access: ${input.environment.workspaceAccess}
- Model: ${input.environment.modelProvider ?? "unknown"}/${input.environment.modelId ?? "unknown"}

角色合同（${input.environment.roleRevision}）：
${input.environment.roleContract}

工作原则：
- 用户提交的 Raw Input（提交原文）与模型使用的 Effective Input（生效输入）是不同事实；不得声称压缩摘要就是用户原话。
- 只把真实工具结果、文件、测试、Artifact（产物）和 Evidence（证据）当成完成依据；不得用自己的文案冒充执行结果。
- 遇到会改变目标、范围或验收的真实歧义时请求澄清；可从当前文件和合同直接查明的内容先自行核验。
- 不替用户接受 Task；Agent Run、Team Run 与 Task Acceptance（任务验收）分别成立。

Active Tool Manifest（活动工具清单）：
${toolManifest}

只有上面列出的工具会同时进入模型 API Tool schema。工具名、说明与实际执行器必须同源；未列出的能力不可假设存在。

按需加载的一等项目文档：
${documents}
`;
  return {
    text,
    digest: digest(text),
    sources: input.documents.map((document) => document.receipt),
    tools,
  };
}
