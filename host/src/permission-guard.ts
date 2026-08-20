import { isAbsolute, join, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  PermissionStore,
  bashCommandMatchesPattern,
  bashGrantPattern,
  classifyBashRisk,
  classifyWriteRisk,
  riskLabel,
  type PermissionAuditRecord,
  type PermissionDecision,
  type PermissionRisk,
} from "./permission-store.js";

export interface PermissionRequestPayload {
  requestId: string;
  sessionId: string;
  tool: string;
  summary: string;
  targets: string[];
  risk: PermissionRisk;
  riskLabel: string;
  scopeHint: string;
}

export type PermissionGateDecision = "allowOnce" | "allowScope" | "deny";

interface PendingRequest {
  resolve: (decision: PermissionGateDecision | "sessionClosed") => void;
}

/**
 * 每个可写会话一个闸门控制器：挂起未决权限请求并等待 Swift 的 permission.respond；
 * 会话关闭 / 冲突时以"会话已关闭"拒绝全部未决请求。
 */
export class PermissionGateController {
  private readonly pending = new Map<string, PendingRequest>();

  constructor(
    private readonly emit: (event: "permission.request", data: PermissionRequestPayload) => void,
    readonly store: PermissionStore,
    readonly sessionId: string,
    readonly cwd: string,
  ) {}

  request(payload: Omit<PermissionRequestPayload, "sessionId">): Promise<PermissionGateDecision | "sessionClosed"> {
    const request: PermissionRequestPayload = { ...payload, sessionId: this.sessionId };
    return new Promise((resolvePromise) => {
      this.pending.set(request.requestId, { resolve: resolvePromise });
      this.emit("permission.request", request);
    });
  }

  settle(requestId: string, decision: PermissionGateDecision): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    this.pending.delete(requestId);
    pending.resolve(decision);
    return true;
  }

  settleAll(): void {
    for (const pending of this.pending.values()) pending.resolve("sessionClosed");
    this.pending.clear();
  }

  async grantScopeFor(tool: string, command: string | undefined): Promise<void> {
    if (tool === "bash" && command !== undefined) {
      this.store.addBashPrefixGrant(this.cwd, bashGrantPattern(command), this.sessionId);
    } else {
      this.store.addFileWriteGrant(this.cwd, this.sessionId);
    }
    await this.store.save();
  }

  audit(tool: string, summary: string, risk: PermissionRisk, decision: PermissionDecision): void {
    this.store.recordAudit({
      sessionId: this.sessionId,
      tool,
      summary: summary.slice(0, 200),
      risk: riskLabel(risk),
      decision,
    });
  }
}

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

/** 打开即接管后的动作级权限闸门：读取放行；bash / 写入 / 未知工具先问。 */
export function createPermissionGuardExtension(gate: PermissionGateController): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.on("tool_call", async (event) => {
      const tool = event.toolName;
      if (READ_ONLY_TOOLS.has(tool)) return {};

      const input = event.input as Record<string, unknown>;
      if (tool === "bash") {
        const command = typeof input.command === "string" ? input.command : "";
        const risk = classifyBashRisk(command);
        const granted = gate.store.grants.some(
          (grant) => grant.kind === "bashPrefix"
            && grant.root === gate.cwd
            && grant.pattern !== undefined
            && bashCommandMatchesPattern(command, grant.pattern),
        );
        if (granted) {
          gate.audit(tool, command, risk, "autoAllow");
          return {};
        }
        const decision = await gate.request({
          requestId: event.toolCallId,
          tool,
          summary: command,
          targets: [gate.cwd],
          risk,
          riskLabel: riskLabel(risk),
          scopeHint: `授权后，${gate.cwd} 下以「${bashGrantPattern(command)}」开头的命令不再询问`,
        });
        if (decision === "sessionClosed") {
          return { block: true, reason: "会话已关闭，命令未执行。" };
        }
        if (decision === "deny") {
          gate.audit(tool, command, risk, "deny");
          return { block: true, reason: "用户拒绝了本次命令。" };
        }
        if (decision === "allowScope") await gate.grantScopeFor(tool, command);
        gate.audit(tool, command, risk, decision);
        return {};
      }

      if (tool === "write" || tool === "edit") {
        const rawPath = typeof input.path === "string" ? input.path : "";
        const resolved = isAbsolute(rawPath) ? resolve(rawPath) : resolve(join(gate.cwd, rawPath));
        const risk = classifyWriteRisk(resolved, gate.cwd);
        const granted = risk === "fileWriteInside" && gate.store.grants.some(
          (grant) => grant.kind === "fileWrite" && (resolved === grant.root || resolved.startsWith(grant.root + sep)),
        );
        if (granted) {
          gate.audit(tool, resolved, risk, "autoAllow");
          return {};
        }
        const decision = await gate.request({
          requestId: event.toolCallId,
          tool,
          summary: resolved,
          targets: [resolved],
          risk,
          riskLabel: riskLabel(risk),
          scopeHint: risk === "fileWriteInside"
            ? `授权后，${gate.cwd} 内的文件写入不再询问`
            : "该目标在当前目录之外，无法按范围授权，只能本次允许或拒绝",
        });
        if (decision === "sessionClosed") {
          return { block: true, reason: "会话已关闭，写入未执行。" };
        }
        if (decision === "deny") {
          gate.audit(tool, resolved, risk, "deny");
          return { block: true, reason: "用户拒绝了本次写入。" };
        }
        if (decision === "allowScope" && risk === "fileWriteInside") {
          await gate.grantScopeFor(tool, undefined);
        }
        gate.audit(tool, resolved, risk, decision);
        return {};
      }

      // 未知 / 自定义工具：一律先问，风险标“其他工具”。
      const summary = JSON.stringify(input).slice(0, 200);
      const risk: PermissionRisk = "otherTool";
      const decision = await gate.request({
        requestId: event.toolCallId,
        tool,
        summary,
        targets: [],
        risk,
        riskLabel: riskLabel(risk),
        scopeHint: "自定义工具不支持范围授权，只能本次允许或拒绝",
      });
      if (decision === "sessionClosed") return { block: true, reason: "会话已关闭，工具未执行。" };
      if (decision === "deny") {
        gate.audit(tool, summary, risk, "deny");
        return { block: true, reason: "用户拒绝了该工具调用。" };
      }
      gate.audit(tool, summary, risk, decision);
      return {};
    });
  };
}
