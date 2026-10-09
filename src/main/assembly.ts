// 隐藏窗口只控制呈现；测试能力必须通过此显式隔离装配选择。
// 普通启动（无显式验证选择）：若 stateDir 已有 model-setup.json 记录，按该记录装配真实后端；
// 凭据加密不可用时只退 unavailable（读错、缺记录都如实反映在界面 connect-failed），不静默写明文凭据。
import { MockExecutionBackend, sampleState } from "@/adapters/mock";
import { createPiBackend } from "@/adapters/pi";
import { createRealPiBackend, modelSetupStoreFactory } from "@/adapters/pi";
import type { CredentialCipher } from "@/adapters/pi";
import type { ExecutionBackend } from "@/application";

export async function assembleExecution(env: Record<string, string | undefined>, stateDir: string, cipher?: CredentialCipher) {
  const selection = env.DCODE_VALIDATION_ASSEMBLY;
  if (selection && selection !== "mock" && selection !== "pi-controlled") throw new Error("invalid-validation-assembly");
  // 显式验证能力必须给独立状态目录；正常启动、隐藏验证均不默认加载脚本模型。
  if (selection && !env.DCODE_STATE_DIR) throw new Error("validation-state-directory-required");
  const unavailable: ExecutionBackend = {
    kind: "unavailable", modelName: null,
    async open() { throw new Error("execution-unavailable"); },
  };
  let backend: ExecutionBackend = unavailable;
  if (selection === "pi-controlled") {
    backend = createPiBackend({ stateDir, demoDir: env.DCODE_DEMO_DIR ?? null, gated: env.DCODE_PI_GATE === "1" });
  } else if (selection === "mock") {
    backend = new MockExecutionBackend({
      timescale: env.DCODE_MOCK_FAST === "1" ? 0.12 : 1,
      injectUnknownOnce: env.DCODE_MOCK_UNKNOWN_ONCE === "1",
      dropReceiptOnce: env.DCODE_MOCK_DROP_RECEIPT_ONCE === "1",
      closeFails: env.DCODE_MOCK_CLOSE_FAIL === "1",
    });
  } else if (cipher) {
    // 普通启动：按持久化 model-setup.json 装配真实后端；cipher 不可用 / credential 缺席（keyAction=clear 已清除）
    // 都退 unavailable——无凭据时绝不能用 label/modelName 让 backend 假解锁可发请求。
    const store = modelSetupStoreFactory(stateDir, cipher);
    try {
      const setup = await store.read();
      if (setup && cipher.isAvailable() && typeof setup.credential === "string" && setup.credential.length > 0) {
        backend = createRealPiBackend({
          stateDir,
          config: { provider: setup.provider, label: setup.label, modelId: setup.modelId, baseUrl: setup.baseUrl },
          cipher,
          store,
        });
      }
    } catch {
      // model-setup.json 不存在或损坏：按 unavailable 启动；读错不静默，保存层在 configureModel 时再诊断
    }
  }
  return { backend, initialState: selection && env.DCODE_VALIDATION_SAMPLE === "1" ? sampleState : undefined };
}
