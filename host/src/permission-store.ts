import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type PermissionGrantKind = "bashPrefix" | "fileWrite";

export interface PermissionGrant {
  id: string;
  kind: PermissionGrantKind;
  /** 授予时的会话工作目录；grant 只对同目录会话生效。 */
  root: string;
  /** bashPrefix 的命令前缀；fileWrite 无 pattern。 */
  pattern?: string;
  createdAt: string;
  createdBySession: string;
}

export type PermissionDecision =
  | "allowOnce"
  | "allowScope"
  | "deny"
  | "autoAllow"
  | "sessionClosed";

export interface PermissionAuditRecord {
  at: string;
  sessionId: string;
  tool: string;
  summary: string;
  risk: string;
  decision: PermissionDecision;
  grantId?: string;
}

interface PermissionDocument {
  version: 1;
  grants: PermissionGrant[];
  audit: PermissionAuditRecord[];
}

const AUDIT_LIMIT = 200;

export class PermissionStore {
  private constructor(
    readonly path: string,
    private document: PermissionDocument,
  ) {}

  static async open(agentDir: string): Promise<PermissionStore> {
    const path = join(agentDir, "pi-dcode", "permissions-v1.json");
    let document: PermissionDocument = { version: 1, grants: [], audit: [] };
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<PermissionDocument>;
      if (parsed.version === 1 && Array.isArray(parsed.grants)) {
        document = {
          version: 1,
          grants: parsed.grants,
          audit: Array.isArray(parsed.audit) ? parsed.audit.slice(-AUDIT_LIMIT) : [],
        };
      }
    } catch {
      // 损坏或缺失时从空文档开始；首次写入会重建文件。
    }
    return new PermissionStore(path, document);
  }

  get grants(): readonly PermissionGrant[] {
    return this.document.grants;
  }

  get audit(): readonly PermissionAuditRecord[] {
    return this.document.audit;
  }

  addBashPrefixGrant(root: string, pattern: string, sessionId: string): PermissionGrant {
    const existing = this.document.grants.find(
      (grant) => grant.kind === "bashPrefix" && grant.root === root && grant.pattern === pattern,
    );
    if (existing) return existing;
    const grant: PermissionGrant = {
      id: randomUUID(),
      kind: "bashPrefix",
      root,
      pattern,
      createdAt: new Date().toISOString(),
      createdBySession: sessionId,
    };
    this.document.grants.push(grant);
    return grant;
  }

  addFileWriteGrant(root: string, sessionId: string): PermissionGrant {
    const existing = this.document.grants.find(
      (grant) => grant.kind === "fileWrite" && grant.root === root,
    );
    if (existing) return existing;
    const grant: PermissionGrant = {
      id: randomUUID(),
      kind: "fileWrite",
      root,
      createdAt: new Date().toISOString(),
      createdBySession: sessionId,
    };
    this.document.grants.push(grant);
    return grant;
  }

  revoke(id: string): boolean {
    const before = this.document.grants.length;
    this.document.grants = this.document.grants.filter((grant) => grant.id !== id);
    return this.document.grants.length !== before;
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp-${randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify(this.document, null, 2)}\n`, { mode: 0o600 });
    try {
      await rename(temporary, this.path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  recordAudit(record: Omit<PermissionAuditRecord, "at">, now = new Date()): PermissionAuditRecord {
    const entry: PermissionAuditRecord = { at: now.toISOString(), ...record };
    this.document.audit.push(entry);
    if (this.document.audit.length > AUDIT_LIMIT) {
      this.document.audit = this.document.audit.slice(-AUDIT_LIMIT);
    }
    return entry;
  }
}

/** bash 前缀匹配：pattern 之后必须是结尾或空白，避免 `git` 误匹配 `gitx`。 */
export function bashCommandMatchesPattern(command: string, pattern: string): boolean {
  if (!command.startsWith(pattern)) return false;
  const next = command.charAt(pattern.length);
  return next === "" || next === " " || next === "\t";
}

/** 从命令提取用于授权的前缀：首个程序名 + 已显式出现的子命令词。 */
export function bashGrantPattern(command: string): string {
  const trimmed = command.trim();
  const tokens = trimmed.split(/\s+/);
  const program = tokens[0] ?? trimmed;
  const knownSubcommands = new Set(["test", "run", "build", "install", "push", "pull", "commit", "status", "diff", "checkout", "fetch", "rebase", "merge", "exec", "ci", "fmt", "lint", "check"]);
  if (program === "git" || program === "npm" || program === "pnpm" || program === "yarn" || program === "cargo" || program === "swift" || program === "docker") {
    const sub = tokens[1] ?? "";
    if (sub && knownSubcommands.has(sub)) return `${program} ${sub}`;
  }
  return program;
}

const HIGH_RISK_COMMAND_PATTERNS: RegExp[] = [
  /\brm\b/,
  /\bdd\b/,
  /\bmkfs\b/,
  /\bgit\s+push\b/,
  /\bgit\s+reset\s+--hard\b/,
  /curl[^|]*\|\s*(ba)?sh/,
  /wget[^|]*\|\s*(ba)?sh/,
  /\bsudo\b/,
  /\bchmod\s+777\b/,
  /\bshutdown\b|\breboot\b/,
];

export type PermissionRisk = "fileWriteInside" | "fileWriteOutside" | "commandHighRisk" | "command" | "otherTool";

export function classifyBashRisk(command: string): PermissionRisk {
  return HIGH_RISK_COMMAND_PATTERNS.some((pattern) => pattern.test(command))
    ? "commandHighRisk"
    : "command";
}

export function classifyWriteRisk(resolvedPath: string, root: string): PermissionRisk {
  return resolvedPath.startsWith(root) ? "fileWriteInside" : "fileWriteOutside";
}

export function riskLabel(risk: PermissionRisk): string {
  switch (risk) {
    case "fileWriteInside": return "项目内写入";
    case "fileWriteOutside": return "项目外写入（高）";
    case "commandHighRisk": return "高风险命令（高）";
    case "command": return "命令执行";
    case "otherTool": return "其他工具";
  }
}
