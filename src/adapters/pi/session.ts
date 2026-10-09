import { createHash, randomUUID } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { Harness, createRegistry, defineDoc, defineDocFamily, StorageRejected, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';
import type { AgentChange, Conversation, Cursor, HarnessOptions, Storage, SubmissionRecord } from '@earendil-works/pi-durable';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import type { Models } from '@earendil-works/pi-ai/models';
import type { ExecutionPort } from '@/application/index.ts';
import { parseControl, parseTarget, parseWorkInput } from '@/contracts/index.ts';
import type { ControlToken, ExecutionTarget, ExecutionView, InputReceipt, WorkInput } from '@/contracts/index.ts';
import { claimDirectory } from './ownership.ts';

/** 把 SDK errorMessage 归类到有限安全码：不向外透传原文/URL/key/token。
 *  wordlist 只匹配明示鉴权失败的关键词；其他错误一律归 model-request-failed。 */
function classifyModelError(errorMessage: unknown): 'auth-failed' | 'model-request-failed' {
  if (typeof errorMessage !== 'string' || !errorMessage) return 'model-request-failed';
  const lower = errorMessage.toLowerCase();
  // 401 / unauthorized / invalid.*(api.?key|token|credential) / authentication failed
  if (lower.includes('401')
    || lower.includes('unauthorized')
    || lower.includes('authentication failed')
    || lower.includes('authentication_required')
    || /\binvalid\b.{0,20}\b(api.?key|token|credentials?|bearer)\b/.test(lower)
    || /\b(incorrect|wrong|missing)\b.{0,20}\b(api.?key|token)\b/.test(lower)) {
    return 'auth-failed';
  }
  return 'model-request-failed';
}

const Binding = defineDoc<{ identity: string; paused: boolean }>({ kind: 'dcode.binding', version: 1, scope: 'session', initial: () => ({ identity: '', paused: false }) });
const Intent = defineDocFamily<{ fingerprint: string }, string>({ kind: 'dcode.input-identity', version: 1, scope: 'session', family: true, initial: fingerprint => ({ fingerprint }) });

export type PiSessionOptions = {
  target: ExecutionTarget;
  directory: string;
  cwd: string;
  models: Models;
  agent: AgentChange;
  registry?: HarnessOptions['registry'];
  env?: HarnessOptions['env'];
  /** 存储适配接缝，测试用来注入明确拒绝或提交后响应丢失。 */
  openStorage?: (directory: string) => Promise<Storage>;
};

/** 一个产品会话对应一个可独立暂停的真实 Pi Harness。 */
export class PiExecutionSession implements ExecutionPort {
  readonly target: ExecutionTarget;
  readonly #options: PiSessionOptions;
  readonly #directory: string;
  readonly #identity: string;
  readonly #release: () => Promise<void>;
  #harness!: Harness;
  #root!: Conversation;
  #storage!: Storage;
  #instanceId = randomUUID();
  #revision = 0;
  #observation = 0;
  #paused = false;
  #enabled = false;
  #pausing = false;
  #faulted = false;
  #closed = false;
  #closing = false;
  #closeResult?: Promise<void>;
  #line: Promise<unknown> = Promise.resolve();

  private constructor(options: PiSessionOptions, directory: string, release: () => Promise<void>) {
    this.target = parseTarget(options.target);
    this.#options = options;
    this.#directory = directory;
    this.#identity = JSON.stringify([this.target, resolve(options.cwd)]);
    this.#release = release;
  }

  static async open(options: PiSessionOptions): Promise<PiExecutionSession> {
    const target = parseTarget(options.target);
    if (typeof options.directory !== 'string' || !options.directory || typeof options.cwd !== 'string' || !options.cwd) throw new Error('Invalid runtime directory');
    await mkdir(resolve(options.directory), { recursive: true, mode: 0o700 });
    const directory = await realpath(resolve(options.directory));
    const release = await claimDirectory(directory);
    const unit = new PiExecutionSession({ ...options, target }, directory, release);
    try { await unit.#load(); return unit; }
    catch (error) { await unit.#harness?.close(context); await unit.#storage?.close(context); await release(); throw error; }
  }

  async #load(): Promise<void> {
    this.#storage = this.#options.openStorage ? await this.#options.openStorage(this.#directory) : await openNodeJsonlStorage(this.#directory, context, { fsync: true });
    // 在 Harness.open 恢复在途任务之前核对归属，错误目标不能改变已有运行记录。
    const existingRoot = await this.#storage.conversation(ROOT_CONVERSATION_ID, context);
    if (existingRoot) {
      const record = await this.#storage.findDocument({ kind: 'dcode.binding', scope: { kind: 'session' } }, 'current', context);
      const stored = record && await this.#storage.document(record.id, 'current', context);
      if (!stored || stored.version !== 1 || stored.value.identity !== this.#identity) throw new Error('Stored session belongs to a different target or directory');
    }
    this.#harness = await Harness.open(this.#storage, { models: this.#options.models, registry: this.#options.registry ?? createRegistry(), env: this.#options.env, settings: { retry: { maxRetries: 0 } } }, context);
    this.#root = await this.#harness.root(context, { agent: { ...this.#options.agent, cwd: this.#options.cwd }, init: async tx => { (await tx.doc(Binding)).identity = this.#identity; } });
    const binding = await this.#harness.snapshot(Binding, context);
    if (!binding || binding.identity !== this.#identity) throw new Error('Stored session belongs to a different target or directory');
    const pending = await this.#harness.inspect(context);
    this.#paused = binding.paused || pending.tasks.length > 0 || pending.submissions.length > 0;
    this.#enabled = false;
    this.#instanceId = randomUUID();
  }

  #serialize<T>(action: () => Promise<T>): Promise<T> {
    const next = this.#line.then(action);
    this.#line = next.catch(() => undefined);
    return next;
  }
  #assertOpen(): void { if (this.#closed || this.#closing) throw new Error('Runtime is closed'); }
  #matches(token: ControlToken): boolean { return token.instanceId === this.#instanceId && token.revision === this.#revision; }
  #fingerprint(input: WorkInput): string { return createHash('sha256').update(JSON.stringify([input.target, input.mode, input.text])).digest('hex'); }
  #validateTarget(input: WorkInput): void {
    if (JSON.stringify(input.target) !== JSON.stringify(this.target)) throw new Error('Input belongs to another session');
  }
  #accepted(input: WorkInput, stored: SubmissionRecord): InputReceipt {
    if (stored.type !== 'input') throw new Error('Unexpected submission kind');
    return { status: 'accepted', operationId: input.operationId, submissionId: stored.id, processing: stored.status };
  }

  async #lookup(input: WorkInput): Promise<InputReceipt> {
    try {
      // 提交后丢失回执可能令 Session 不可继续写；从正式存储读回，不能用 submit/wait 代查。
      const address = await this.#storage.findDocument({ kind: 'dcode.input-identity', scope: { kind: 'session' }, key: input.operationId }, 'current', context);
      const intent = address && await this.#storage.document(address.id, 'current', context);
      if (intent && (intent.version !== 1 || intent.value.fingerprint !== this.#fingerprint(input))) return { status: 'not-accepted', operationId: input.operationId, reason: 'conflict' };
      const record = await this.#storage.submissionByRequest(this.#root.id, input.operationId, context);
      if (record) {
        if (!intent) throw new Error('Stored input identity is missing');
        return this.#accepted(input, record);
      }
      return { status: 'not-accepted', operationId: input.operationId, reason: 'not-found' };
    } catch { return { status: 'unknown', operationId: input.operationId, reason: 'storage-unavailable' }; }
  }

  lookupReceipt(value: unknown): Promise<InputReceipt> {
    const input = parseWorkInput(value);
    this.#validateTarget(input);
    return this.#serialize(async () => { this.#assertOpen(); return this.#lookup(input); });
  }

  submit(value: unknown): Promise<InputReceipt> {
    const input = parseWorkInput(value);
    this.#validateTarget(input);
    return this.#serialize(async () => {
      this.#assertOpen();
      const prior = await this.#lookup(input);
      if (prior.status !== 'not-accepted' || prior.reason !== 'not-found') return prior;
      if (this.#paused || this.#pausing) return { status: 'not-accepted', operationId: input.operationId, reason: 'paused' };
      if (!this.#matches(input.expected)) return { status: 'not-accepted', operationId: input.operationId, reason: 'stale-control' };
      if (this.#faulted) return { status: 'unknown', operationId: input.operationId, reason: 'storage-unavailable' };
      try {
        // Pi 原生只按 requestId 去重；指纹仅约束重试，不是另一份已接收输入队列。
        await this.#harness.commit(async tx => { await tx.doc(Intent, input.operationId, this.#fingerprint(input)); }, context);
        if (this.#pausing || this.#paused || !this.#matches(input.expected)) return { status: 'not-accepted', operationId: input.operationId, reason: 'paused' };
        const submission = await this.#root.submit({ type: 'input', content: input.text, requestId: input.operationId, whenBusy: input.mode === 'steer' ? 'steer' : 'followUp' }, context);
        this.#enabled = true;
        return this.#accepted(input, await submission.status(context));
      } catch (error) {
        // 只有明确拒绝且确实无提交时才能报告未接收；其余错误保持未知，先核对原记录。
        if (error instanceof StorageRejected) {
          const result = await this.#lookup(input);
          if (result.status === 'not-accepted' && result.reason === 'not-found') return { ...result, reason: 'storage-rejected' };
          return result;
        }
        this.#faulted = true;
        return { status: 'unknown', operationId: input.operationId, reason: 'storage-unavailable' };
      }
    });
  }

  read(): Promise<ExecutionView> { return this.#serialize(async () => { this.#assertOpen(); return this.#view(); }); }
  async #view(): Promise<ExecutionView> {
    const inspection = await this.#harness.inspect(context);
    const entries: Array<ExecutionView['entries'][number]> = [];
    let cursor: Cursor | undefined;
    do {
      const page = await this.#root.entries({}, 200, cursor, context);
      entries.push(...page.items.map(entry => {
        const projected = { id: entry.id, kind: entry.kind, data: structuredClone(entry.data) };
        if (entry.kind !== 'pi.assistant') return projected;
        // Pi 将助手正文保存在 model 而非 data；公开读取须带回正文，依据运行用例的保存与重开断言。
        let failureKind: 'auth-failed' | 'model-request-failed' | undefined;
        const assistantText = (entry.model ?? []).flatMap(message => {
          // stopReason==='error' + errorMessage（Pi 1.0.0 generation.js:348/381 持久化）；
          // aborted/暂停不算服务端失败；不透传 errorMessage 原文/URL/key。
          if (message.role === 'assistant' && message.stopReason === 'error') {
            failureKind = classifyModelError(message.errorMessage);
          }
          return message.role === 'assistant' ? message.content.flatMap(block => block.type === 'text' ? [block.text] : []) : [];
        }).join('');
        return failureKind ? { ...projected, assistantText, failureKind } : { ...projected, assistantText };
      }));
      cursor = page.next;
    } while (cursor !== undefined);
    const agent = await this.#root.agent(context);
    return { target: this.target, control: { instanceId: this.#instanceId, revision: this.#revision }, observation: ++this.#observation, phase: this.#faulted ? 'faulted' : this.#pausing ? 'pausing' : this.#paused ? 'paused' : this.#enabled && inspection.tasks.length > 0 ? 'running' : 'ready', execution: 'pi-durable-1.0.0', model: agent.model ?? null, entries, pendingInputs: inspection.submissions.length };
  }

  pause(): Promise<ExecutionView> {
    this.#assertOpen();
    // 在等待当前操作收束前提升版本，使已经排队的旧恢复无法跨过这次用户暂停。
    this.#revision += 1;
    this.#pausing = true;
    this.#paused = true;
    return this.#serialize(async () => {
      let failure: unknown;
      try { await this.#harness.commit(async tx => { (await tx.doc(Binding)).paused = true; }, context); } catch (error) { failure = error; }
      try { await this.#harness.close(context); } catch (error) { failure ??= error; }
      this.#enabled = false;
      if (failure) { this.#faulted = true; throw new Error('Pause could not confirm storage and shutdown', { cause: failure }); }
      await this.#load();
      this.#pausing = false;
      return this.#view();
    });
  }

  /** 正式换该会话 agent.model（不是 resume，不是发送）。已有根调用 Conversation.configure 的正式机制。 */
  async applyModelRef(ref: { provider: string; modelId: string }): Promise<void> {
    await this.#serialize(async () => {
      this.#assertOpen();
      const agent = await this.#root.agent(context);
      if (agent?.model?.provider === ref.provider && agent.model.modelId === ref.modelId) return;
      await this.#root.configure({ model: { provider: ref.provider, modelId: ref.modelId } }, context);
    });
  }

  resume(value: ControlToken): Promise<ExecutionView> {
    const token = parseControl(value);
    return this.#serialize(async () => {
      this.#assertOpen();
      if (!this.#matches(token) || this.#pausing) throw Object.assign(new Error('Stale resume request'), { name: "StaleControlError" });
      if (this.#faulted) throw new Error('Runtime storage requires reopen');
      await this.#harness.commit(async tx => { (await tx.doc(Binding)).paused = false; }, context);
      if (!this.#matches(token) || this.#pausing) throw new Error('Resume superseded by pause');
      this.#paused = false;
      this.#enabled = true;
      this.#harness.resume();
      return this.#view();
    });
  }

  close(): Promise<void> {
    // 串行尾会吞错以接续请求，不能拿它作关闭回执；所有关闭调用者必须看到同一个真实结果。
    if (this.#closeResult) return this.#closeResult;
    this.#closing = true;
    this.#paused = true;
    this.#revision += 1;
    this.#closeResult = this.#serialize(async () => {
      // 先等待 Pi 停止和存储关闭，再交出所有权；失败时保留认领，不能让新实例抢写。
      await this.#harness.close(context);
      await this.#storage.close(context);
      await this.#release();
      this.#closed = true;
    });
    return this.#closeResult;
  }
}
