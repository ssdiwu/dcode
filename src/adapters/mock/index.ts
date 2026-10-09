// 模拟执行后端：实现与真实 Pi 端口相同语义的 ExecutionPort（回执三态、控制令牌、观测序号、close 收束），
// 用脚本化 entry 流驱动时间线投影。全部内容为预设，不代表真实模型或工具执行；
// 只由显式隔离验证装配使用，正常入口不加载此后端。
// 注入开关（unknownOnce/closeFails）只服务 E2E 失败路径验证，不影响默认行为。

// 身份与指纹只用纯 JS（本模块是界面侧模拟层，不引 Node 内置模块）：
// instanceId 用时间戳+计数器保证进程内唯一；指纹用 FNV-1a 检测同/异输入，不承担安全用途。
let mockCounter = 0;
const nextInstanceId = () => `mock-${Date.now().toString(36)}-${(mockCounter++).toString(36)}`;

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}
import type {
  ExecutionBackend,
  ExecutionTarget,
  ExecutionView,
  SessionExecutionContext,
  ExecutionPort,
  WorkInput,
} from "@/application";
import { parseControl, parseTarget, parseWorkInput, type InputReceipt } from "@/contracts";

interface Step {
  delayMs: number;
  emit: (push: (kind: string, data: unknown) => void) => void;
}

export interface MockBackendOptions {
  timescale?: number;
  /** 首次 submit 返回「接收结果待核对」（unknown），且不留下任何提交记录 */
  injectUnknownOnce?: boolean;
  /** 首次 submit 实际接收并记录，但回执丢失（返回 unknown）：验证找回优先而非盲目重投 */
  dropReceiptOnce?: boolean;
  /** close() 以固定失败收束，验证关闭失败可见、不伪报成功 */
  closeFails?: boolean;
}

/** 暂停窗口：暂停开始到此期间 resume 一律按 stale 拒绝（对齐 Pi 的 pausing 语义），不随 timescale 缩放。 */
const PAUSING_WINDOW_MS = 1500;

export class MockExecutionBackend implements ExecutionBackend {
  readonly kind = "mock" as const;
  readonly modelName = "dcode-script";
  private readonly timescale: number;
  private readonly injectUnknownOnce: boolean;
  private readonly dropReceiptOnce: boolean;
  private readonly closeFails: boolean;

  constructor(options?: MockBackendOptions) {
    this.timescale = options?.timescale ?? 1;
    this.injectUnknownOnce = options?.injectUnknownOnce ?? false;
    this.dropReceiptOnce = options?.dropReceiptOnce ?? false;
    this.closeFails = options?.closeFails ?? false;
  }

  open(context: SessionExecutionContext): Promise<ExecutionPort> {
    return Promise.resolve(
      new MockExecutionPort(context.target, {
        timescale: this.timescale,
        injectUnknownOnce: this.injectUnknownOnce,
        dropReceiptOnce: this.dropReceiptOnce,
        closeFails: this.closeFails,
      }),
    );
  }
}

class MockExecutionPort implements ExecutionPort {
  readonly target: ExecutionTarget;
  readonly #timescale: number;
  readonly #instanceId = nextInstanceId();
  #revision = 0;
  #observation = 0;
  #entries: Array<{ id: number; kind: string; data: unknown }> = [];
  #nextEntryId = 0;
  #nextSubmissionId = 0;
  #steps: Step[] = [];
  #index = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #pausingTimer: ReturnType<typeof setTimeout> | null = null;
  #phase: ExecutionView["phase"] = "ready";
  #pausing = false;
  #closed = false;
  #closeResult: Promise<void> | null = null;
  #line: Promise<unknown> = Promise.resolve();
  /** operationId → 已提交记录（指纹 + 完成态）；lookupReceipt 从这里回查 */
  readonly #submissions = new Map<string, { fingerprint: string; done: boolean; submissionId: number }>();
  #unknownArmed: boolean;
  #dropArmed: boolean;
  readonly #closeFails: boolean;

  constructor(target: ExecutionTarget, options: Required<MockBackendOptions>) {
    this.target = parseTarget(target);
    this.#timescale = options.timescale;
    this.#unknownArmed = options.injectUnknownOnce;
    this.#dropArmed = options.dropReceiptOnce;
    this.#closeFails = options.closeFails;
  }

  #serialize<T>(action: () => Promise<T>): Promise<T> {
    const next = this.#line.then(action);
    this.#line = next.catch(() => undefined);
    return next;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Runtime is closed");
  }

  #matches(token: { instanceId: string; revision: number }): boolean {
    return token.instanceId === this.#instanceId && token.revision === this.#revision;
  }

  #fingerprint(input: WorkInput): string {
    return fnv1a(JSON.stringify([input.target, input.mode, input.text]));
  }

  #validateTarget(input: WorkInput): void {
    if (JSON.stringify(input.target) !== JSON.stringify(this.target)) throw new Error("Input belongs to another session");
  }

  #pushEntry(kind: string, data: unknown): void {
    this.#entries.push({ id: this.#nextEntryId++, kind, data });
  }

  #view(): ExecutionView {
    return {
      target: this.target,
      control: { instanceId: this.#instanceId, revision: this.#revision },
      observation: ++this.#observation,
      phase: this.#phase,
      execution: "mock",
      model: null,
      entries: this.#entries.map((e) => ({ ...e })),
      pendingInputs: [...this.#submissions.values()].filter((s) => !s.done).length,
    };
  }

  #receipt(input: WorkInput): InputReceipt {
    const stored = this.#submissions.get(input.operationId);
    if (!stored) return { status: "not-accepted", operationId: input.operationId, reason: "not-found" };
    return {
      status: "accepted",
      operationId: input.operationId,
      submissionId: stored.submissionId,
      processing: stored.done ? "done" : this.#phase === "ready" ? "queued" : "placed",
    };
  }

  read(): Promise<ExecutionView> {
    return this.#serialize(async () => {
      this.#assertOpen();
      return this.#view();
    });
  }

  lookupReceipt(value: unknown): Promise<InputReceipt> {
    const input = parseWorkInput(value);
    this.#validateTarget(input);
    return this.#serialize(async () => {
      this.#assertOpen();
      const stored = this.#submissions.get(input.operationId);
      if (stored && stored.fingerprint !== this.#fingerprint(input)) {
        return { status: "not-accepted", operationId: input.operationId, reason: "conflict" };
      }
      return this.#receipt(input);
    });
  }

  submit(value: unknown): Promise<InputReceipt> {
    const input = parseWorkInput(value);
    this.#validateTarget(input);
    return this.#serialize(async () => {
      this.#assertOpen();
      const stored = this.#submissions.get(input.operationId);
      if (stored) {
        // 同次重试（同 operationId）：指纹一致返回原回执，不一致是冲突
        if (stored.fingerprint !== this.#fingerprint(input)) {
          return { status: "not-accepted", operationId: input.operationId, reason: "conflict" };
        }
        return this.#receipt(input);
      }
      if (this.#pausing || this.#phase === "paused") {
        return { status: "not-accepted", operationId: input.operationId, reason: "paused" };
      }
      if (!this.#matches(input.expected)) {
        return { status: "not-accepted", operationId: input.operationId, reason: "stale-control" };
      }
      if (this.#unknownArmed) {
        // 注入：提交后响应丢失。不留下任何记录，回查只能得到 not-found
        this.#unknownArmed = false;
        return { status: "unknown", operationId: input.operationId, reason: "storage-unavailable" };
      }
      this.#submissions.set(input.operationId, { fingerprint: this.#fingerprint(input), done: false, submissionId: this.#nextSubmissionId++ });
      if (this.#phase === "ready") {
        // 模拟端按会话独立运行；运行中再收输入只确认接收，不另起脚本
        this.#steps = buildScript(input.text);
        this.#index = 0;
        this.#phase = "running";
        this.#schedule();
      }
      if (this.#dropArmed) {
        // 注入：已接收（记录与执行已发生）但回执丢失——调用方只看到 unknown，
        // 只读回查能找回该记录；与 unknownOnce（未留记录）区分
        this.#dropArmed = false;
        return { status: "unknown", operationId: input.operationId, reason: "storage-unavailable" };
      }
      return this.#receipt(input);
    });
  }

  pause(): Promise<ExecutionView> {
    this.#assertOpen();
    // 在等待当前操作收束前提升版本，使已排队的旧恢复无法跨过这次用户暂停（对齐 Pi）。
    // 与真实 Pi 对齐：pause() 在收束完成后才返回（真实实现 await harness.close + reload）。
    this.#revision += 1;
    this.#pausing = true;
    this.#phase = "pausing";
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#pushEntry("mock.marker", { marker: "paused", text: "已暂停。进度已保存（模拟），可随时继续。" });
    if (this.#pausingTimer) clearTimeout(this.#pausingTimer);
    return this.#serialize(async () => {
      this.#assertOpen();
      await new Promise((resolve) => {
        this.#pausingTimer = setTimeout(resolve, PAUSING_WINDOW_MS);
      });
      this.#pausingTimer = null;
      this.#pausing = false;
      this.#phase = "paused";
      return this.#view();
    });
  }

  resume(value: { instanceId: string; revision: number }): Promise<ExecutionView> {
    const token = parseControl(value);
    return this.#serialize(async () => {
      this.#assertOpen();
      if (this.#pausing) throw Object.assign(new Error("Stale resume request: pause is still settling"), { name: "StaleControlError" });
      if (!this.#matches(token)) throw Object.assign(new Error("Stale resume request"), { name: "StaleControlError" });
      if (this.#phase === "paused") this.#phase = "ready";
      this.#pushEntry("mock.marker", { marker: "resumed", text: "从中断处继续（模拟）。" });
      if (this.#index < this.#steps.length && this.#phase !== "running") {
        this.#phase = "running";
        this.#schedule();
      } else if (this.#index >= this.#steps.length) {
        // 重开后的接续：内存脚本已不存在，走明确的接续段，不假装原位续跑
        this.#steps = continuationSteps();
        this.#index = 0;
        this.#phase = "running";
        this.#schedule();
      }
      return this.#view();
    });
  }

  close(): Promise<void> {
    // 所有关闭调用者看到同一个真实结果；失败被保留并上报，不伪报成功
    if (!this.#closeResult) {
      this.#closeResult = this.#serialize(async () => {
        if (this.#timer) clearTimeout(this.#timer);
        if (this.#pausingTimer) clearTimeout(this.#pausingTimer);
        this.#timer = null;
        this.#pausingTimer = null;
        if (this.#closeFails) throw new Error("模拟关闭失败（DCODE_MOCK_CLOSE_FAIL 注入）");
        this.#closed = true;
      });
    }
    return this.#closeResult;
  }

  #schedule(): void {
    if (this.#index >= this.#steps.length) {
      this.#finish();
      return;
    }
    const step = this.#steps[this.#index++];
    this.#timer = setTimeout(() => {
      this.#timer = null;
      step.emit((kind, data) => this.#pushEntry(kind, data));
      if (this.#phase === "running") this.#schedule();
    }, step.delayMs * this.#timescale);
  }

  #finish(): void {
    this.#phase = "ready";
    for (const record of this.#submissions.values()) record.done = true;
    this.#pushEntry("mock.marker", { marker: "finished", text: "本轮结束。" });
  }
}

// ---------- 脚本内容（模拟，未接 Pi；权限步骤已随旧形态移除） ----------

function buildScript(userText: string): Step[] {
  const brief = userText.trim().slice(0, 60);
  return [
    {
      delayMs: 600,
      emit: (push) =>
        push("mock.assistant", {
          text: `收到。我先理解一下现状，再动手：${brief ? `「${brief}」` : ""}\n\n计划：\n1. 定位相关实现与约束；\n2. 分两处修改，保持焦点规则不回归；\n3. 跑输入控件测试验证。\n\n先从搜索开始。`,
        }),
    },
    {
      delayMs: 900,
      emit: (push) =>
        push("mock.tool", {
          name: "search",
          primaryText: "搜索相关实现位置",
          output:
            "找到 2 个相关文件：\n- src/renderer/components/Composer.tsx:34  输入区容器与焦点规则\n- src/renderer/styles.css:101  .input-surface 中性焦点内描边\n\n相关测试：test/layout/input-focus.mjs（260 断言）",
          status: "done",
          changedFiles: [],
        }),
    },
    {
      delayMs: 800,
      emit: (push) =>
        push("mock.tool", {
          name: "read",
          primaryText: "读取 Composer.tsx 与 styles.css 相关段落",
          output:
            'Composer.tsx:30-41\n  <div className="composer-shell">\n    <textarea className="composer-input" … />\n  </div>\n\nstyles.css:97-106\n  .input-surface:focus-within {\n    border-color: var(--line-strong);\n    box-shadow: inset 0 0 0 1px var(--line-strong);\n  }',
          status: "done",
          changedFiles: [],
        }),
    },
    {
      delayMs: 700,
      emit: (push) =>
        push("mock.assistant", {
          text: "现状清楚了：焦点反馈已经是中性内描边，需要改的是容器层级和一处硬编码。现在动手改两个文件。",
        }),
    },
    {
      delayMs: 1000,
      emit: (push) =>
        push("mock.tool", {
          name: "edit",
          primaryText: "Composer.tsx — 容器改为 rounded-2xl，padding 收到壳上",
          output: "",
          status: "done",
          changedFiles: ["src/renderer/components/Composer.tsx"],
        }),
    },
    {
      delayMs: 800,
      emit: (push) =>
        push("mock.tool", {
          name: "edit",
          primaryText: "styles.css — 移除 composer-input 的重复焦点规则",
          output: "",
          status: "done",
          changedFiles: ["src/renderer/styles.css"],
        }),
    },
    {
      delayMs: 1200,
      emit: (push) =>
        push("mock.tool", {
          name: "execute",
          primaryText: "npm run test:inputs（第一次）",
          output:
            "$ npm run test:inputs\n\n> vite build && node test/layout/input-focus.mjs\n\n✓ 51 个输入定义\n✗ 1 个断言失败：composer-input 仍存在独立焦点外框\n  at test/layout/input-focus.mjs:88\n\n247/248 通过 · 耗时 3.8s",
          status: "failed",
          exitCode: 1,
          changedFiles: [],
        }),
    },
    {
      delayMs: 700,
      emit: (push) =>
        push("mock.assistant", {
          text: "第一次跑挂了一条：`.composer-input` 还留着旧的 `outline` 覆盖。是我漏删了一行，补上。",
        }),
    },
    {
      delayMs: 700,
      emit: (push) =>
        push("mock.tool", {
          name: "edit",
          primaryText: "styles.css — 删除残留的 outline 覆盖",
          output: "",
          status: "done",
          changedFiles: ["src/renderer/styles.css"],
        }),
    },
    {
      delayMs: 1200,
      emit: (push) =>
        push("mock.tool", {
          name: "execute",
          primaryText: "npm run test:inputs（复跑）",
          output:
            "$ npm run test:inputs\n\n> vite build && node test/layout/input-focus.mjs\n\n✓ 51 个输入定义\n✓ 248/248 断言通过\n\n耗时 3.6s",
          status: "done",
          exitCode: 0,
          changedFiles: [],
        }),
    },
    {
      delayMs: 500,
      emit: (push) =>
        push("mock.change", {
          files: [
            {
              path: "src/renderer/components/Composer.tsx",
              added: 6,
              deleted: 4,
              hunks: [
                {
                  header: "@@ -30,9 +30,11 @@",
                  lines: [
                    { type: "context", text: "  return (" },
                    { type: "del", text: '    <div className="composer">' },
                    { type: "del", text: '      <textarea className="composer-input" rows={3} … />' },
                    { type: "add", text: '    <div className="composer-shell rounded-2xl border bg-input p-3">' },
                    { type: "add", text: '      <textarea className="composer-input" rows={3} … />' },
                    { type: "add", text: "      <ComposerToolbar … />" },
                    { type: "context", text: "    </div>" },
                    { type: "context", text: "  );" },
                  ],
                },
              ],
            },
            {
              path: "src/renderer/styles.css",
              added: 3,
              deleted: 5,
              hunks: [
                {
                  header: "@@ -97,10 +97,8 @@",
                  lines: [
                    { type: "context", text: ".input-surface:focus-within {" },
                    { type: "context", text: "  border-color: var(--line-strong);" },
                    { type: "del", text: ".composer-input:focus {" },
                    { type: "del", text: "  outline: 2px solid var(--accent); /* 残留的旧规则 */" },
                    { type: "del", text: "}" },
                    { type: "add", text: "/* composer 焦点反馈由容器壳统一承担 */" },
                    { type: "context", text: "}" },
                  ],
                },
              ],
            },
          ],
        }),
    },
    {
      delayMs: 600,
      emit: (push) =>
        push("mock.assistant", {
          text: "完成。改动两个文件：\n\n- `Composer.tsx`：输入区收进 `rounded-2xl` 容器壳，工具条进壳内；\n- `styles.css`：删掉 textarea 自己的焦点覆盖，焦点反馈统一由容器承担。\n\n测试第一次跑挂了一条残留规则，修掉后复跑 248/248 通过。你可以打开设置页或任意输入框 Tab 一圈确认焦点样式一致。",
        }),
    },
  ];
}

/** 重开接续段：明确的模拟内容，不复演原脚本 */
function continuationSteps(): Step[] {
  return [
    {
      delayMs: 500,
      emit: (push) =>
        push("mock.marker", {
          marker: "resumed",
          text: "从保存的进度继续（重开后接续为模拟内容，未接 Pi）。",
        }),
    },
    {
      delayMs: 900,
      emit: (push) =>
        push("mock.tool", {
          name: "execute",
          primaryText: "npm run test:inputs（接续后复跑）",
          output: "$ npm run test:inputs\n\n✓ 51 个输入定义\n✓ 248/248 断言通过\n\n耗时 3.4s",
          status: "done",
          exitCode: 0,
          changedFiles: [],
        }),
    },
    {
      delayMs: 600,
      emit: (push) =>
        push("mock.assistant", {
          text: "接续完成：剩余步骤已执行，复跑测试 248/248 通过。\n\n说明：重开后的执行是模拟接续，真实 Pi 接入后这里会按保存的运行状态恢复，而不是重演脚本。",
        }),
    },
  ];
}

export { sampleState } from "./sample-state";
