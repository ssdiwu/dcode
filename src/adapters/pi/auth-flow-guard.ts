// 认证 flow 代次门控（A 轮收口）：用户级「更换/清除认证」与「SDK 已授权请求的 OAuth token 刷新」分开。
// - 登录/登出 flow 经 begin() 取得 guard：作为 CredentialStore modify/delete 的授权代理传入；
//   真实提交点（加密与写盘之前）核对 flow 是否仍活跃、目标 providerId 是否一致、取消/关闭是否已生效。
// - SDK 请求路径的凭据写入（token 刷新）不使用 guard，走同一 store 的无门禁通路，不会被误拦。
// - flow 结束（完成/失败/取消/关闭）立即吊销：晚到的提交意图在真实提交点被拒，旧认证保留；
//   已真实提交（写盘完成）之后的晚到 UI 取消/呈现失败不回滚，也不能把已保存误报未保存。

export interface AuthFlowGuard {
  /** 准备段授权检查（解密/加密/读 current 之前）；不匹配/已吊销抛错。 */
  beforePrepare(providerId: string): void;
  /** 提交点授权检查（紧邻真实 rename 之前）；两点间被吊销同样抛错、临时文件被清理、旧记录保留。 */
  beforeCommit(providerId: string): void;
  /** 结束并吊销；幂等。 */
  revoke(): void;
  /** 当前是否仍活跃（供流程内部判断，不用于提交点旁路）。 */
  active(): boolean;
}

export class AuthFlowRegistry {
  #nextSeq = 0;
  readonly #active = new Map<string, { seq: number; providerId: string }>();
  /** providerId → 最新 flowId（新代次使同 provider 旧 flow 失效；不维持多代共存） */
  readonly #latestByProvider = new Map<string, string>();
  #closed = false;

  /** 登记一个针对特定 providerId 的认证 flow；返回该 flow 的双授权点门禁。
   *  同 provider 已有活跃 flow 时旧 flow 立即失效（新代次语义，不需外层 also 手工 revoke 才能起）。 */
  begin(providerId: string): AuthFlowGuard {
    if (this.#closed) throw new Error("auth-flow-registry-closed");
    const flowId = `auth-flow-${++this.#nextSeq}-${Date.now().toString(36)}`;
    const priorFlowId = this.#latestByProvider.get(providerId);
    if (priorFlowId) {
      // 吊销同 provider 旧 flow（新代次立旧失效）
      this.#active.delete(priorFlowId);
    }
    const entry = { seq: this.#nextSeq, providerId };
    this.#active.set(flowId, entry);
    this.#latestByProvider.set(providerId, flowId);
    let revoked = false;
    const check = (target: string) => {
      if (revoked || !this.#active.has(flowId) || this.#closed) {
        throw new Error("auth-flow-superseded");
      }
      if (target !== entry.providerId) {
        throw new Error("auth-flow-target-mismatch");
      }
    };
    const revoke = () => {
      if (revoked) return;
      revoked = true;
      this.#active.delete(flowId);
      if (this.#latestByProvider.get(providerId) === flowId) this.#latestByProvider.delete(providerId);
    };
    return {
      beforePrepare: check,
      beforeCommit: check,
      revoke,
      active: () => !revoked && this.#active.has(flowId) && !this.#closed,
    };
  }

  /** 关闭收束：吊销全部在途 flow，此后任何认证提交意图都失败（凭据保持原状）。 */
  close(): void {
    this.#closed = true;
    this.#active.clear();
  }
}
