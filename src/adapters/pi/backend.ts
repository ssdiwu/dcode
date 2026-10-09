// Pi 执行端装配：真实 Pi Durable Harness + 本地受控模型 + 真实 CodingTools。
// 安全边界：受控模型永远不读凭据、不连真实服务商（见 controlled-models.ts）；
// 运行记录、所有权锁、模型请求日志与写文件证据全部落在调用方给的隔离目录内。
// 「dcode-write」是演示证据工具：它内部调用 CodingTools 真实的 write 工具完成写文件，
// 并把路径写入 diagnostics，使隔离文件结果能作为证据呈现在时间线（真实 write 成功本身不产生诊断）。

import { mkdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CodingTools, createWriteTool } from "@earendil-works/pi-durable/tools";
import { createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { ExecutionBackend, SessionExecutionContext } from "@/application";
import { PiExecutionSession } from "./session";
import { createControlledModels, controlledModelName } from "./controlled-models";

export interface PiBackendOptions {
  /** 运行记录根目录（每会话一个子目录，含所有权锁）；必须是隔离目录 */
  stateDir: string;
  /** DCODE_DEMO_DIR：受控模型写文件与观测日志的独立临时目录；null 时回退 stateDir/demo-workspace */
  demoDir: string | null;
  /** 门控应答：第 2 个及以后的模型请求在门文件出现前保持挂起（E2E 模拟在途生成） */
  gated: boolean;
}

const innerWrite = createWriteTool();
const demoWrite = defineTool({
  ...innerWrite,
  name: "dcode-write",
  execute: async (args, api, context) => {
    // 复用真实 write 工具的执行（路径解析、写队列、真实异步写文件），只追加证据诊断
    const result = await innerWrite.execute(args, api, context);
    const bytes = Buffer.byteLength(String(args.content ?? ""), "utf8");
    return {
      ...result,
      details: { path: String(args.path) },
      diagnostics: [
        ...(result.diagnostics ?? []),
        { severity: "info" as const, code: "file-written", message: `已写入 ${String(args.path)}（${bytes} 字节）` },
      ],
    };
  },
});
const DemoWriteExtension = defineExtension({ name: "dcode-demo-write", tools: [demoWrite] });

export function createPiBackend(options: PiBackendOptions): ExecutionBackend {
  return {
    kind: "pi",
    modelName: controlledModelName,
    async open(context: SessionExecutionContext): Promise<PiExecutionSession> {
      const cwd = await resolveWorkDir(options);
      const directory = join(options.stateDir, "runtime", context.target.sessionId);
      const fixture = createControlledModels({
        demoDir: cwd,
        requestLog: join(cwd, "model-requests.jsonl"),
        answerGate: options.gated ? join(cwd, ".answer-gate") : null,
      });
      const registry = createRegistry();
      registry.install(CodingTools);
      registry.install(DemoWriteExtension);
      return PiExecutionSession.open({
        target: context.target,
        directory,
        cwd,
        models: fixture.models,
        registry,
        agent: { model: { provider: fixture.model.provider, modelId: fixture.model.id } },
        env: target => new NodeExecutionEnv({ cwd: target.cwd ?? cwd }),
      });
    },
  };
}

/** 受控演示的工作目录：始终落在明确隔离目录（demoDir 或 stateDir 派生），不碰任务绑定的用户目录。 */
async function resolveWorkDir(options: PiBackendOptions): Promise<string> {
  const dir = options.demoDir ?? join(options.stateDir, "demo-workspace");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return realpath(resolve(dir));
}
