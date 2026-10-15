// C05 引用异步结果的**归属门禁**（spec 页面与交互组件.md#c05-引用入口载荷归属与竞态）。
//
// 为什么单独成模块：迟到结果能不能落进草稿，是一个纯判定，不该散在组件的 async 闭包里。
// 组件里最容易写错的形式是「发起时的归属 vs 同一 render 里的归属」——两者是同一个标量，
// await 回来后比较的仍是发起时的自己，目标换了也看不出来（2026-10-11 只读复核 F5 实测）。
// 门禁只认两样东西：**此刻**的归属，与一个单调自增的代次。
//
//  · 归属变化（换会话／换草稿任务）自增一代：旧归属的在途结果立刻作废；
//  · A→B→A 回到同一归属仍是新一代：A 的旧结果同样作废，不因"又变回原来"而复活；
//  · 组件卸载同样自增一代：组件已不存在时不再有任何回写；
//  · 同一个归属内的重入（关面板再打开、同一归属重新加载）不算换目标，
//    那类新旧由调用方自己的请求序号区分，不把**归属/代次**与请求新旧混成一件事。
//
// 本模块不引入第二套草稿、运行或授权机制：它只回答"这份在途结果还属不属于当前目标"，
// 写不写、写到哪，仍由草稿唯一所有者决定。

// 归属范围用 string | null：回包里未设置的归属就是 null（契约口径），两者都按"无此项"处理。
export type ReferenceScope = { sessionId?: string | null; taskId?: string | null };

/** 归属身份：会话优先，其次草稿任务；无归属为 null（此时不能发现引用）。 */
export type ScopeKey = string | null;

export function scopeKeyOf(scope: ReferenceScope | null | undefined): ScopeKey {
  if (!scope) return null;
  return scope.sessionId ? `s:${scope.sessionId}` : `t:${scope.taskId}`;
}

export interface ReferenceTicket {
  readonly scopeKey: ScopeKey;
  readonly generation: number;
}

export interface ReferenceGate {
  /** 此刻的归属身份 */
  current(): ScopeKey;
  /** 登记一次在途操作，返回它当时的归属与代次凭据 */
  begin(): ReferenceTicket;
  /** 该凭据是否仍是此刻的当前目标；false 时调用方必须整段丢弃这份结果 */
  isCurrent(ticket: ReferenceTicket): boolean;
  /** 组件是否还挂载（用于只做本地清理、不写业务状态的地方） */
  isMounted(): boolean;
  /** 目标变化时调用：不同才自增一代，重复调用同一归属是空操作 */
  advance(scopeKey: ScopeKey): void;
  /**
   * 挂载（重新挂载时复位卸载标记）。
   * 卸载与挂载成对出现：开发期严格模式会额外走一次「挂载→卸载→挂载」，
   * 只在卸载时置位而不复位，会让之后所有结果永远判为 stale。
   */
  mount(): void;
  /** 卸载：之后任何凭据都不再是当前的 */
  dispose(): void;
}

export function createReferenceGate(initial: ScopeKey): ReferenceGate {
  let scopeKey = initial;
  let generation = 0;
  let disposed = false;
  return {
    current: () => scopeKey,
    begin: () => ({ scopeKey, generation }),
    isCurrent: (ticket) => !disposed && ticket.generation === generation && ticket.scopeKey === scopeKey,
    isMounted: () => !disposed,
    advance: (next) => {
      if (next !== scopeKey) {
        scopeKey = next;
        generation += 1;
      }
    },
    dispose: () => {
      disposed = true;
      generation += 1;
    },
    mount: () => {
      disposed = false;
    },
  };
}

export type GatedOutcome<T> =
  | { status: "applied"; value: T }
  | { status: "stale" }
  | { status: "failed"; message: string };

/**
 * 在门禁下执行一次引用异步调用。
 * 结果与失败都只在凭据仍属当前目标时才交给调用方；目标已换或组件已卸载时一律 stale，
 * 调用方不得写任何业务状态（不加引用、不改列表、不弹错误说明）。
 */
export async function runGated<T>(gate: ReferenceGate, action: () => Promise<T>): Promise<GatedOutcome<T>> {
  const ticket = gate.begin();
  try {
    const value = await action();
    return gate.isCurrent(ticket) ? { status: "applied", value } : { status: "stale" };
  } catch (error) {
    if (!gate.isCurrent(ticket)) return { status: "stale" };
    return { status: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}
