import { createHash, randomUUID } from 'node:crypto';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { Harness, LiveDoc, createSession, createRegistry, defineDoc, defineDocFamily, defineExtension, SessionFailed, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';
import type { UserInput } from '@earendil-works/pi-durable';
import type { AgentChange, Conversation, Cursor, HarnessOptions, Storage, SubmissionRecord, TaskId, ToolExecutionApi } from '@earendil-works/pi-durable';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import type { Models } from '@earendil-works/pi-ai/models';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { parsePatch } from 'diff';
import type { ExecutionPort } from '@/application/index.ts';
import { parseControl, parseExecutionChanges, parseWorkImages, parseTarget, parseWorkInput, referenceSetId } from '@/contracts/index.ts';
import type { ControlToken, ExecutionTarget, ExecutionView, InputReceipt, WorkInput, WorkReference } from '@/contracts/index.ts';
import { claimDirectory } from './ownership.ts';
import { DurableModelRouting } from './durable-routing.ts';
import { CodingResourcesUnavailable } from './coding-resources.ts';
import { createInputPreparation, processedInputId, Preparation, PreparationOrder, InnerReceipt } from './input-preparation';
import type { PreparedInput, InputPreparation } from './input-preparation';
import type { Context } from '@earendil-works/chord';

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
class PreparationPaused extends Error {}

export type ExecutionResourceShutdown = { shutdownFlushed: Promise<void>; done: Promise<void> };

export type PiSessionOptions = {
  target: ExecutionTarget;
  directory: string;
  cwd: string;
  /** 查询已有运行时禁止初始化；显式首次执行默认可创建。 */
  initialize?: boolean;
  /** 普通客户端沿原绑定目录恢复，不能把旧的相对路径工具迁到新目录。 */
  reuseStoredCwd?: boolean;
  /** 仅发送／明确继续装配资源，观察旧运行不得改写它的指令；发送期事件沿同一 Durable 准备任务。 */
  prepareExecution?: (cwd: string, sessionStartReason: 'startup' | 'resume' | 'reload', owner?: ToolExecutionApi, context?: Context) => Promise<AgentChange>;
  /** 每次只读重开只接上原 Harness 的读取，不启动资源。 */
  attachExecution?: (harness: Harness, root: Conversation, ownedModel?: DurableModelRouting['withOwnedModelInvocation']) => void;
  /** 先失效资源准备／在途回调，再等实际连接与调用收束。 */
  beginCloseExecutionResources?: (reason: 'resume' | 'quit') => ExecutionResourceShutdown;
  /** 只有停止旧调度后的暂停/关闭、明确继续前可消费已确认费用；不执行资源代码。 */
  reconcileExecutionSpend?: (session: import('@earendil-works/pi-durable').Session, context: Context) => Promise<void>;
  /** 同次资源准备后转换尚未接收的正文；查回原回执和明确继续不重新展开旧输入。 */
  transformInput?: (text: string) => string;
  needsInputPreparation?: () => boolean;
  prepareInput?: (input: InputPreparation, api: ToolExecutionApi, context: Context) => Promise<PreparedInput>;
  models: Models;
  agent: AgentChange;
  registry?: HarnessOptions['registry'];
  env?: HarnessOptions['env'];
  /** 显式装配的 Harness 策略；缺席保留当前零模型重试，不因能力接线提高调用次数。 */
  settings?: HarnessOptions['settings'];
  /** 存储适配接缝，测试用来注入明确拒绝或提交后响应丢失。 */
  openStorage?: (directory: string) => Promise<Storage>;
};

export type ExtensionInputOptions = { deliverAs: 'steer' | 'followUp'; expandPromptTemplates: boolean };
export type ExtensionInputAdmission = { ownerTaskId?: TaskId; isCurrent: () => boolean };
class ExtensionInputOwnerInactive extends Error {}

/** 一个产品会话对应一个可独立暂停的真实 Pi Harness。 */
export class PiExecutionSession implements ExecutionPort {
  readonly target: ExecutionTarget;
  readonly #options: PiSessionOptions;
  readonly #directory: string;
  #identity: string;
  #cwd: string;
  readonly #release: () => Promise<void>;
  #harness!: Harness;
  #root!: Conversation;
  #storage!: Storage;
  #instanceId = randomUUID();
  #revision = 0;
  #observation = 0;
  #sessionStartReason: 'startup' | 'resume' = 'startup';
  #paused = false;
  #enabled = false;
  #pausing = false;
  #resuming = false;
  #faulted = false;
  #sessionFailed = false;
  #failedCleanup?: Promise<void>;
  #closed = false;
  #closing = false;
  #closeResult?: Promise<void>;
  #line: Promise<unknown> = Promise.resolve();
  #routing?: DurableModelRouting;
  #stopRoutingRegistry?: () => void;
  #stopPreparationRegistry?: () => void;
  readonly #inputPreparation;

  private constructor(options: PiSessionOptions, directory: string, release: () => Promise<void>) {
    this.target = parseTarget(options.target);
    this.#options = options;
    this.#directory = directory;
    this.#cwd = resolve(options.cwd);
    this.#inputPreparation = createInputPreparation(async (input, api, ctx) => { await this.#prepareExecution(api, ctx); return options.prepareInput ? options.prepareInput(input, api, ctx) : {content:input.content,handled:false}; }, () => !this.#paused && !this.#pausing && !this.#closing && !this.#closed, (id, ctx) => this.#harness.submission(id, ctx));
    this.#identity = JSON.stringify([this.target, this.#cwd]);
    this.#release = release;
  }

  static async open(options: PiSessionOptions): Promise<PiExecutionSession> {
    const target = parseTarget(options.target);
    if (typeof options.directory !== 'string' || !options.directory || typeof options.cwd !== 'string' || !options.cwd) throw new Error('Invalid runtime directory');
    if (options.initialize !== false) await mkdir(resolve(options.directory), { recursive: true, mode: 0o700 });
    const directory = await realpath(resolve(options.directory));
    const release = await claimDirectory(directory);
    const unit = new PiExecutionSession({ ...options, target }, directory, release);
    try { await unit.#load(); return unit; }
    catch (error) { unit.#stopRoutingRegistry?.(); unit.#stopPreparationRegistry?.(); await unit.#harness?.close(context); await unit.#storage?.close(context); await release(); throw error; }
  }

  async #load(): Promise<void> {
    this.#storage = this.#options.openStorage ? await this.#options.openStorage(this.#directory) : await openNodeJsonlStorage(this.#directory, context, { fsync: true });
    // 在 Harness.open 恢复在途任务之前核对归属，错误目标不能改变已有运行记录。
    const existingRoot = await this.#storage.conversation(ROOT_CONVERSATION_ID, context);
    // 只读重开不加载扩展；下一次正式准备时应区分新启动与恢复已有会话。
    this.#sessionStartReason = existingRoot ? 'resume' : 'startup';
    if (existingRoot) {
      const record = await this.#storage.findDocument({ kind: 'dcode.binding', scope: { kind: 'session' } }, 'current', context);
      const stored = record && await this.#storage.document(record.id, 'current', context);
      if (!stored || stored.version !== 1) throw new Error('Stored session belongs to a different target or directory');
      if (this.#options.reuseStoredCwd) {
        // 在恢复内核之前核对同一正式绑定与 AgentDoc，读取不修补冲突记录。
        const binding: unknown = JSON.parse(String(stored.value.identity));
        if (!Array.isArray(binding) || binding.length !== 2 || typeof binding[1] !== 'string'
          || resolve(binding[1]) !== binding[1]
          || JSON.stringify([parseTarget(binding[0]), binding[1]]) !== stored.value.identity
          || JSON.stringify(parseTarget(binding[0])) !== JSON.stringify(this.target)) throw new Error('Stored session belongs to a different target or directory');
        const address = await this.#storage.findDocument({ kind: 'pi.agent', scope: { kind: 'conversation', conversationId: ROOT_CONVERSATION_ID } }, 'current', context);
        const agent = address && await this.#storage.document(address.id, 'current', context);
        if (!agent || agent.version !== 1 || agent.value.cwd !== binding[1]) throw new Error('Stored working directory conflicts with session binding');
        this.#cwd = binding[1];
        this.#identity = String(stored.value.identity);
      } else if (stored.value.identity !== this.#identity) throw new Error('Stored session belongs to a different target or directory');
    } else {
      if (this.#options.initialize === false) throw new Error('Runtime record is missing');
      if (this.#options.reuseStoredCwd && !(await stat(this.#cwd)).isDirectory()) throw new Error('Working directory is unavailable');
    }
    const baseRegistry = this.#options.registry ?? createRegistry();
    let registry = createRegistry(); const preparationRegistry = registry;
    const preparationExtension = defineExtension({ name: 'dcode-input-preparation', tasks: [this.#inputPreparation.preparation,this.#inputPreparation.tracking] });
    const copied = new Map<string, import('@earendil-works/pi-durable').Extension>();
    const syncPreparation = () => {
      const current = baseRegistry.snapshot().installed();
      for (const [name, previous] of copied) if (!current.some(extension => extension.name === name)) { preparationRegistry.uninstall(previous); copied.delete(name); }
      for (const extension of current) { preparationRegistry.install(extension); copied.set(extension.name, extension); }
      preparationRegistry.install(preparationExtension);
    };
    this.#stopPreparationRegistry?.(); syncPreparation(); this.#stopPreparationRegistry = baseRegistry.subscribe(syncPreparation);
    let agent = this.#options.agent;
    if (this.#options.models instanceof ModelRuntime) {
      this.#routing = new DurableModelRouting(this.#options.models, () => !this.#paused && !this.#pausing && !this.#closing && !this.#closed);
      const baseRegistry = registry;
      const ownedRegistry = createRegistry();
      const installed = new Map<string, import('@earendil-works/pi-durable').Extension>();
      const sync = () => {
        const extensions = baseRegistry.snapshot().installed();
        for (const [name, old] of installed) if (!extensions.some((e) => e.name === name)) { ownedRegistry.uninstall(old); installed.delete(name); }
        for (const extension of extensions) { ownedRegistry.install(extension); installed.set(extension.name, extension); }
        ownedRegistry.install(this.#routing!.extension);
      };
      sync();
      this.#stopRoutingRegistry = baseRegistry.subscribe(sync);
      registry = ownedRegistry;
      const extensions = agent.extensions;
      agent = { ...agent, extensions: Array.isArray(extensions)
        ? [...extensions, this.#routing.extension]
        : { ...(extensions && !Array.isArray(extensions) ? extensions : {}), add: [...(extensions && 'add' in extensions ? extensions.add ?? [] : []), this.#routing.extension] } };
    }
    this.#harness = await Harness.open(this.#storage, { models: this.#routing?.models ?? this.#options.models, registry, env: this.#options.env, settings: this.#options.settings ?? { retry: { maxRetries: 0 } } }, context);
    const openedHarness = this.#harness;
    // 1.3 的存储异常会主动关闭 Session；关闭通知只认本代，旧 pause 的正常关闭不污染新实例。
    openedHarness.subscribeClose(() => {
      // 无宿主 pause/close 意图的主动关闭先封锁旧实例；通知内不重入 Session，微任务才执行资源 join。
      if (this.#harness === openedHarness && !this.#closing && !this.#pausing) queueMicrotask(() => this.#markSessionFailed(openedHarness));
    });
    void openedHarness.closed.then(end => {
      if (end.reason === 'failed' && this.#harness === openedHarness) this.#markSessionFailed(openedHarness);
    });
    this.#routing?.attach(this.#harness);
    this.#root = await this.#harness.root(context, { agent: { ...agent, cwd: this.#cwd }, init: async tx => { (await tx.doc(Binding)).identity = this.#identity; } });
    this.#options.attachExecution?.(this.#harness, this.#root, this.#routing?.withOwnedModelInvocation.bind(this.#routing));
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
  async #reconcileStoppedSpend():Promise<void>{
    // 只读实例的正常关闭也不能消费crash留下的费用；只有本实例真正执行过才作停机维护。
    if(!this.#enabled||!this.#options.reconcileExecutionSpend)return;
    // 旧Harness已join并关闭，目录认领仍归本会话。公有Session仅提供同存储事务，不运行任务。
    const storage=this.#options.openStorage?await this.#options.openStorage(this.#directory):await openNodeJsonlStorage(this.#directory,context,{fsync:true});
    const stopped=createSession(storage);
    try{
      const binding=await stopped.snapshot(Binding,context);
      if(binding?.identity!==this.#identity)throw new Error('Stored session identity changed during shutdown');
      await this.#options.reconcileExecutionSpend(stopped,context);
    }finally{await stopped.close(context);}
  }
  async #prepareRoutingForExecution(ctx: Context = context): Promise<void> {
    if (!this.#routing) return;
    const agent = await this.#root.agent(ctx);
    if (!agent.extensions.some((extension) => extension.name === this.#routing!.extension.name)) {
      // 旧记录读取不补写能力；只有已授权的发送、改选或明确继续才接入内部路由 hook。
      await this.#root.configure({ extensions: { add: [this.#routing.extension] } }, ctx);
    }
  }
  async #prepareExecution(owner?: ToolExecutionApi, ctx: Context = context): Promise<void> {
    if (this.#options.prepareExecution) {
      const reason = this.#resuming ? 'resume' : this.#sessionStartReason;
      const change = await this.#options.prepareExecution(this.#cwd, reason, owner, ctx);
      this.#assertOpen();
      if (this.#paused || this.#pausing) throw new PreparationPaused('Execution preparation was superseded by pause');
      await this.#root.configure(change, ctx);
    }
    await this.#prepareRoutingForExecution(ctx);
  }
  #matches(token: ControlToken): boolean { return token.instanceId === this.#instanceId && token.revision === this.#revision; }
  /**
 * 输入身份指纹。
 * 无引用时保持**原三段合同**（target/mode/text）：C 片之前已落盘的输入身份不能因本次升级而改变，
 * 否则重开后的同一次发送会被当成另一份输入。有引用时才追加第四段引用集合身份。
 */
  #fingerprint(input: WorkInput): string {
    const parts: unknown[] = [input.target, input.mode, input.text];
    if (input.references.length > 0) parts.push(referenceSetId(input.references));
    if (input.images?.length) parts.push(input.images);
    return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  }
  #validateTarget(input: WorkInput): void {
    if (JSON.stringify(input.target) !== JSON.stringify(this.target)) throw new Error('Input belongs to another session');
  }

  /**
   * 引用内容必须在进入模型前逐条核对哈希：界面声称引用了什么，与真正送进去的正文必须一致。
   * 不一致即拒收整次提交——不能出现"历史里有引用、请求里没有内容"。
   */
  #assertReferenceIntegrity(refs: readonly WorkReference[]): void {
    for (const ref of refs) {
      const actual = createHash('sha256').update(ref.snapshot.content).digest('hex');
      if (actual !== ref.snapshot.contentHash) throw new Error('Reference content does not match its snapshot');
    }
  }

  /**
   * 用户原文字与引用内容分成独立内容块：原文字不被改写，每条引用自带来源与版本标识，
   * 模型能分辨哪句是用户说的、哪段是引用的。
   */
  #userContent(input: WorkInput): UserInput {
    if (input.references.length === 0 && !input.images?.length) return input.text;
    const blocks: Exclude<UserInput, string> = [{ type: 'text' as const, text: input.text }];
    for (const ref of input.references) {
      const kindLabel = ref.kind === 'skill' ? '技能' : '文件';
      const truncated = ref.snapshot.truncated ? '（已按上限截断）' : '';
      blocks.push({
        type: 'text' as const,
        text:
          `<dcode-reference kind="${ref.kind}" source="${ref.sourceId}" path="${ref.locator}" ` +
          `sha256="${ref.snapshot.contentHash}">\n${ref.snapshot.content}\n</dcode-reference>` +
          `\n（以上为用户引用的${kindLabel} ${ref.label}${truncated}）`,
      });
    }
    blocks.push(...(input.images ?? []));
    return blocks;
  }
  #accepted(input: WorkInput, stored: SubmissionRecord): InputReceipt {
    if (stored.type !== 'input' && stored.type !== 'write') throw new Error('Unexpected submission kind');
    return { status: 'accepted', operationId: input.operationId, submissionId: stored.id, processing: stored.status };
  }

  #markSessionFailed(harness: Harness): void {
    if (harness !== this.#harness || this.#sessionFailed) return;
    this.#sessionFailed = true; this.#faulted = true; this.#revision += 1;
    // 失败本身触发资源收束；查询只等待真实 join，不通过 pause/close 交出目录认领或消费费用。
    this.#failedCleanup = (async () => {
      const resources = this.#options.beginCloseExecutionResources?.('resume');
      resources?.done.catch(() => {});
      // shutdown 回调无法再提交到失败 Session；它的错误不跳过真正运输/Worker 的收束。
      await resources?.shutdownFlushed.catch(() => {});
      // backend.close失败也须等物理资源join；保首个后端错误，不让后续收束错误取代它。
      let failure: unknown;
      try { await harness.close(context); } catch (error) { failure = error; }
      try { await harness.closed; } catch (error) { failure ??= error; }
      try { await resources?.done; } catch (error) { failure ??= error; }
      if (failure) throw failure;
    })();
    void this.#failedCleanup.catch(() => {});
  }

  async #lookupStored(input: WorkInput, storage: Storage, ctx: Context): Promise<InputReceipt> {
      const address = await storage.findDocument({ kind: 'dcode.input-identity', scope: { kind: 'session' }, key: input.operationId }, 'current', ctx);
      const intent = address && await storage.document(address.id, 'current', ctx);
      if (intent && (intent.version !== 1 || intent.value.fingerprint !== this.#fingerprint(input))) return { status: 'not-accepted', operationId: input.operationId, reason: 'conflict' };
      const record = await storage.submissionByRequest(this.#root.id, input.operationId, ctx);
      if (record) {
        if (!intent) throw new Error('Stored input identity is missing');
        const preparation = await storage.findDocument({kind:'dcode.input-preparation',scope:{kind:'session'},key:input.operationId},'current',ctx);
        const prepared = preparation && await storage.document(preparation.id,'current',ctx);
        const inner = prepared ? await storage.submissionByRequest(this.#root.id,String(prepared.value.innerRequestId ?? processedInputId(input.operationId)),ctx) : undefined;
        return {...this.#accepted(input,record), ...(inner && record.status !== 'done' && record.status !== 'unanswered' ? {processing:inner.status} : {})};
      }
      return { status: 'not-accepted', operationId: input.operationId, reason: 'not-found' };
  }

  async #lookup(input: WorkInput, ctx: Context = context, recoverFailed = false): Promise<InputReceipt> {
    if (!this.#sessionFailed) {
      try { return await this.#lookupStored(input, this.#storage, ctx); }
      catch { return { status: 'unknown', operationId: input.operationId, reason: 'storage-unavailable' }; }
    }
    if (!recoverFailed) return { status: 'unknown', operationId: input.operationId, reason: 'storage-unavailable' };
    {
      try {
        await this.#failedCleanup;
        const storage = this.#options.openStorage ? await this.#options.openStorage(this.#directory) : await openNodeJsonlStorage(this.#directory, ctx, { fsync: true });
        try {
          // 只开原目录的 Storage 读取；不创建 Harness、不 wait/submit/resume，也不初始化缺失的正式运行。
          const root = await storage.conversation(ROOT_CONVERSATION_ID, ctx);
          const address = await storage.findDocument({ kind: 'dcode.binding', scope: { kind: 'session' } }, 'current', ctx);
          const binding = address && await storage.document(address.id, 'current', ctx);
          if (!root || !binding || binding.version !== 1 || binding.value.identity !== this.#identity) throw new Error('Stored session identity changed');
          return await this.#lookupStored(input, storage, ctx);
        } finally { await storage.close(ctx); }
      } catch { return { status: 'unknown', operationId: input.operationId, reason: 'storage-unavailable' }; }
    }
  }

  lookupReceipt(value: unknown): Promise<InputReceipt> {
    const input = parseWorkInput(value);
    this.#validateTarget(input);
    return this.#serialize(async () => { this.#assertOpen(); return this.#lookup(input, context, true); });
  }

  submit(value: unknown): Promise<InputReceipt> {
    return this.#submit(parseWorkInput(value), true, 'rpc');
  }

  /** SDK sendUserMessage submits through this same session owner; options only affect this new input. */
  submitExtensionMessage(content: unknown, options: ExtensionInputOptions, actionId: string, ctx: Context, admission: ExtensionInputAdmission): Promise<InputReceipt> {
    this.#assertOpen();
    if (typeof actionId !== 'string' || !actionId || actionId.length > 4096) throw new Error('Invalid extension input identity');
    const parts = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
    if (!Array.isArray(parts) || parts.length > 256) throw new Error('Invalid extension input');
    const textParts: string[] = [];
    const imageParts: unknown[] = [];
    for (const part of parts) {
      if (!part || typeof part !== 'object' || Array.isArray(part)) throw new Error('Invalid extension input');
      if (part.type === 'text' && typeof part.text === 'string') textParts.push(part.text);
      else if (part.type === 'image') imageParts.push(part);
      else throw new Error('Invalid extension input');
    }
    const text = textParts.join('\n');
    if (text.length > 1_000_000) throw new Error('Invalid extension input');
    const images = parseWorkImages(imageParts);
    if (!text.trim() && images.length === 0) throw new Error('Invalid extension input');
    const input: WorkInput = Object.freeze({
      target: this.target,
      operationId: `pi-extension/${createHash('sha256').update(actionId).digest('hex')}`,
      text,
      references: Object.freeze([]),
      ...(images.length ? { images } : {}),
      mode: options.deliverAs === 'steer' ? 'steer' : 'follow-up',
      expected: Object.freeze({ instanceId: this.#instanceId, revision: this.#revision }),
    });
    return this.#submitExtensionInput(input, options.expandPromptTemplates, ctx, admission);
  }

  /** 资源准备会等待扩展事件；事件输入须沿同一 Durable 事务接收，不能重入当前 Session 串行尾。 */
  async #submitExtensionInput(input: WorkInput, expandPromptTemplates: boolean, ctx: Context, admission: ExtensionInputAdmission): Promise<InputReceipt> {
    this.#validateTarget(input);
    this.#assertReferenceIntegrity(input.references);
    this.#assertOpen();
    const maySubmit = () => admission.isCurrent() && !ctx.abortSignal?.aborted && !this.#pausing && !this.#closing && !this.#closed
      && (!this.#paused || this.#resuming) && this.#matches(input.expected);
    if (!maySubmit()) return { status: 'not-accepted', operationId: input.operationId, reason: this.#paused ? 'paused' : 'stale-control' };
    if (this.#faulted) return { status: 'unknown', operationId: input.operationId, reason: 'storage-unavailable' };
    if (!this.#options.prepareInput) return { status: 'not-accepted', operationId: input.operationId, reason: 'execution-unavailable' };

    const prior = await this.#lookup(input, ctx);
    if (prior.status !== 'not-accepted' || prior.reason !== 'not-found') return prior;
    if (!maySubmit()) return { status: 'not-accepted', operationId: input.operationId, reason: this.#paused ? 'paused' : 'stale-control' };

    try {
      let receipt!: SubmissionRecord;
      await this.#harness.commit(async tx => {
        const binding = await tx.doc(Binding);
        if (!maySubmit()) throw new ExtensionInputOwnerInactive();
        if (admission.ownerTaskId !== undefined) {
          const owner = await tx.task(admission.ownerTaskId);
          if (!owner || owner.state.status === 'terminal' || 'abort' in owner) throw new ExtensionInputOwnerInactive();
        }
        if (binding.paused && !this.#resuming) throw new PreparationPaused();
        const order = await tx.doc(PreparationOrder);
        const previousTaskId = order.lastTaskId as TaskId | undefined;
        const innerRequestId = `dcode.prepared/${randomUUID()}`;
        await tx.doc(Intent, input.operationId, this.#fingerprint(input));
        await tx.doc(InnerReceipt, innerRequestId, input.operationId);
        await tx.appendEntry(this.#root.id, { kind: 'dcode.extension-entry', data: { action: 'user-input', value: {
          operationId: input.operationId, text: input.text, images: [...(input.images ?? [])], mode: input.mode === 'steer' ? 'steer' : 'follow-up',
        } } });
        receipt = await tx.createSubmission({ conversationId: this.#root.id, requestId: input.operationId, type: 'input', status: 'queued' });
        const taskId = await tx.createTask(this.#inputPreparation.preparation, {
          receiptId: receipt.id, requestId: input.operationId, innerRequestId,
          ...(previousTaskId === undefined ? {} : { previousTaskId }),
          content: this.#userContent(input), text: input.text, images: [...(input.images ?? [])],
          mode: input.mode === 'steer' ? 'steer' as const : 'followUp' as const,
          source: 'extension', expandPromptTemplates,
        }, { conversationId: this.#root.id, ownership: { kind: 'conversation' } });
        await tx.doc(Preparation, input.operationId, { taskId, innerRequestId });
        order.lastTaskId = taskId;
      }, ctx);
      this.#enabled = true;
      if (!this.#resuming) this.#harness.resume();
      return this.#accepted(input, receipt);
    } catch (error) {
      // 只有事务内确认 owner 已失效才是确定未接收；回执等待中取消不能证明写盘尚未完成。
      if (error instanceof ExtensionInputOwnerInactive) {
        return { status: 'not-accepted', operationId: input.operationId, reason: 'stale-control' };
      }
      if (error instanceof PreparationPaused) {
        return { status: 'not-accepted', operationId: input.operationId, reason: 'paused' };
      }
      if (error instanceof SessionFailed) this.#markSessionFailed(this.#harness);
      this.#faulted = true;
      return { status: 'unknown', operationId: input.operationId, reason: 'storage-unavailable' };
    }
  }

  #submit(input: WorkInput, expandPromptTemplates: boolean, source: 'rpc' | 'extension'): Promise<InputReceipt> {
    this.#validateTarget(input);
    this.#assertReferenceIntegrity(input.references);
    return this.#serialize(async () => {
      this.#assertOpen();
      const prior = await this.#lookup(input);
      if (prior.status !== 'not-accepted' || prior.reason !== 'not-found') return prior;
      if (this.#paused || this.#pausing) return { status: 'not-accepted', operationId: input.operationId, reason: 'paused' };
      if (!this.#matches(input.expected)) return { status: 'not-accepted', operationId: input.operationId, reason: 'stale-control' };
      if (this.#faulted) return { status: 'unknown', operationId: input.operationId, reason: 'storage-unavailable' };
      let commitStarted = false;
      try {
        if (this.#options.prepareInput && this.#options.needsInputPreparation?.()) {
          let receipt!: SubmissionRecord;
          commitStarted = true;
          await this.#harness.commit(async tx => {
            if (this.#pausing || this.#paused || !this.#matches(input.expected)) throw new PreparationPaused();
            const order = await tx.doc(PreparationOrder);
            const previousTaskId = order.lastTaskId as TaskId | undefined;
            const innerRequestId = `dcode.prepared/${randomUUID()}`;
            await tx.doc(Intent, input.operationId, this.#fingerprint(input));
            await tx.doc(InnerReceipt, innerRequestId, input.operationId);
            receipt = await tx.createSubmission({conversationId:this.#root.id,requestId:input.operationId,type:'input',status:'queued'});
            const taskId = await tx.createTask(this.#inputPreparation.preparation, { receiptId:receipt.id, requestId: input.operationId, innerRequestId, ...(previousTaskId===undefined?{}:{previousTaskId}), content: this.#userContent(input), text: input.text,
              images: [...(input.images ?? [])], mode: input.mode === 'steer' ? 'steer' as const : 'followUp' as const, source, expandPromptTemplates }, { conversationId: this.#root.id, ownership: { kind: 'conversation' } });
            await tx.doc(Preparation, input.operationId, {taskId,innerRequestId});order.lastTaskId=taskId;
          }, context);
          this.#enabled = true; this.#harness.resume();
          return this.#accepted(input,receipt);
        }
        await this.#prepareExecution();
        const text = expandPromptTemplates ? this.#options.transformInput?.(input.text) ?? input.text : input.text;
        // 未启用扩展时保原发送流程；展开明确失败仍发生在接收之前。
        commitStarted = true;
        await this.#harness.commit(async tx => { await tx.doc(Intent,input.operationId,this.#fingerprint(input)); },context);
        if (this.#pausing || this.#paused || !this.#matches(input.expected)) return {status:'not-accepted',operationId:input.operationId,reason:'paused'};
        const submission = await this.#root.submit({ type: 'input', content: this.#userContent({ ...input, text }), requestId: input.operationId, whenBusy: input.mode === 'steer' ? 'steer' : 'followUp' }, context);
        this.#enabled = true;
        return this.#accepted(input, await submission.status(context));
      } catch (error) {
        // commit 的任何存储错误在 1.3 都是未知；即使并发 pause，也不能伪报确定未接收。
        if (error instanceof SessionFailed) { this.#markSessionFailed(this.#harness); return {status:'unknown',operationId:input.operationId,reason:'storage-unavailable'}; }
        // 首次存储失败可能原样抛 Error；进入 commit 后即使并发暂停，也须先查原回执，不能据异常类型猜未接受。
        if (commitStarted && !(error instanceof PreparationPaused)) {
          this.#faulted = true;
          return { status: 'unknown', operationId: input.operationId, reason: 'storage-unavailable' };
        }
        // 暂停在资源 await 期间已认领；正式 submit 尚未调用，不能伪成未知接收或存储故障。
        if (error instanceof PreparationPaused || this.#pausing || this.#paused) return { status: 'not-accepted', operationId: input.operationId, reason: 'paused' };
        // 准备资源在正式接收之前明确失败：不冒称已接收或存储丢失。
        if (error instanceof CodingResourcesUnavailable) return { status: 'not-accepted', operationId: input.operationId, reason: 'execution-unavailable' };
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
        if (entry.kind === 'dcode.preparation-error') return {...projected,extensionMessage:{customType:'输入处理',text:'项目资源或输入处理未完成；已接收事实及已完成作用保留，中断的扩展不会自动重放。',display:true}};
        if (entry.kind === 'dcode.extension-entry') {
          const data = entry.data as {action?: string; value?: {message?: {customType?: string;content?: unknown;display?: boolean}}};
          const message = data?.action === 'message' ? data.value?.message : undefined;
          if (message && typeof message.customType === 'string' && message.customType.length <= 128 && typeof message.display === 'boolean') {
            const text = typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.flatMap(part => part && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n') : '';
            return { ...projected, extensionMessage: {customType:message.customType,text,display:message.display} };
          }
        }
        if (entry.kind === 'pi.tool-result') {
          const message = (entry.model ?? []).find(message => message.role === 'toolResult');
          if (message?.role === 'toolResult') {
            const raw = message.details && typeof message.details === 'object' && !Array.isArray(message.details) ? message.details as Record<string, unknown> : {};
            let changes: import('@/contracts').FileChange[] = [];
            let changeNotice = typeof raw.changeNotice === 'string' ? raw.changeNotice : undefined;
            try {
              if (raw.changes !== undefined) changes = parseExecutionChanges(raw.changes);
              else if (typeof raw.patch === 'string') changes = parseExecutionChanges(parsePatch(raw.patch).map(patch => {
                let added = 0; let deleted = 0;
                const hunks = patch.hunks.map(hunk => ({ header: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
                  lines: hunk.lines.filter(line => line[0] !== '\\').map(line => {
                    if (line[0] === '+') { added += 1; return { type: 'add', text: line.slice(1) }; }
                    if (line[0] === '-') { deleted += 1; return { type: 'del', text: line.slice(1) }; }
                    return { type: 'context', text: line.slice(1) };
                  }) }));
                return { path: patch.newFileName ?? patch.oldFileName ?? '', added, deleted, hunks };
              }));
            } catch { changeNotice = '本次差异结构未能核对，保留原工具结果。'; }
            return { ...projected, toolResult: {
              name: message.toolName, callId: message.toolCallId, isError: message.isError,
              text: message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'),
              ...(message.content.some(block => block.type === 'image') ? { images: parseWorkImages(message.content.filter(block => block.type === 'image').map(block => ({ type: 'image', data: block.data, mimeType: block.mimeType }))) } : {}),
              ...(Number.isSafeInteger(raw.exitCode) ? { exitCode: raw.exitCode as number } : {}), changes,
              ...(changeNotice ? { changeNotice } : {}),
            } };
          }
        }
        if (entry.kind === 'dcode.extension-typed-model-result') {
          const data = entry.data as { operation?: 'classify' | 'generateImages'; requestId?: string; typed?: import('@earendil-works/pi-ai').ClassifierResult | import('@earendil-works/pi-ai').AssistantImages };
          const typed = data?.typed;
          // child身份只证同一操作；stop或带usage的结果才可发布已确认请求，用量缺席不补零。
          if (!typed || typeof data.requestId !== 'string' || (typed.stopReason !== 'stop' && !typed.usage
            && !(data.operation==='generateImages'&&'responseId' in typed&&typeof typed.responseId==='string'&&typed.responseId.length>0))) return projected;
          return { ...projected, typedRequest: { operation: data.operation === 'generateImages' ? 'generateImages' as const : 'classify' as const, requestId: data.requestId,
            provider: typed.provider, model: typed.model, result: typed.stopReason === 'stop' ? 'succeeded' as const : 'failed' as const,
            ...(typed.usage ? { usage: { input: typed.usage.input, output: typed.usage.output, cacheRead: typed.usage.cacheRead, cacheWrite: typed.usage.cacheWrite } } : {}) } };
        }
        if (entry.kind === 'dcode.extension-model-result') {
          const message = (entry.data as {message?: import('@earendil-works/pi-ai').AssistantMessage})?.message;
          if (!message || message.role !== 'assistant' || typeof message.provider !== 'string' || typeof message.model !== 'string') return projected;
          // 工具内请求有真实响应归属，但返回值不成为会话助手正文或模型上下文。
          return { ...projected, provider: message.provider, model: message.model,
            ...(message.responseId ? {responseId:message.responseId} : {}),
            ...(message.usage ? {usage:{input:message.usage.input,output:message.usage.output,cacheRead:message.usage.cacheRead,cacheWrite:message.usage.cacheWrite}} : {}),
            ...(message.stopReason === 'error' ? {failureKind:classifyModelError(message.errorMessage)} : {}) };
        }
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
        // **真实请求归属与用量**：全部取自该条助手消息本身（Pi 1.0.0 AssistantMessage）。
        // 计划中的模型、界面上的选择都不在这里出现——这里只有这次真的发出去的请求。
        const latest = [...(entry.model ?? [])].reverse().find((m) => m.role === 'assistant');
        // 虚拟路由在发出之前失败只有选择/准备事实；不能把 virtual/unissued 的零用量说成真实物理请求。
        const attributed = latest && latest.api !== 'pi-virtual'
          ? {
              ...projected,
              assistantText,
              provider: latest.provider,
              model: latest.model,
              ...(latest.responseId ? { responseId: latest.responseId } : {}),
              ...(latest.thinkingLevel ? { thinkingLevel: latest.thinkingLevel } : {}),
              ...(latest.usage
                ? { usage: { input: latest.usage.input, output: latest.usage.output, cacheRead: latest.usage.cacheRead, cacheWrite: latest.usage.cacheWrite } }
                : {}),
            }
          : { ...projected, assistantText };
        return failureKind ? { ...attributed, failureKind } : attributed;
      }));
      cursor = page.next;
    } while (cursor !== undefined);
    for (const entry of entries) {
      const data = entry.kind === 'dcode.extension-entry' && entry.data && typeof entry.data === 'object' && !Array.isArray(entry.data)
        ? entry.data as Record<string, unknown> : undefined;
      const value = data?.action === 'user-input' && data.value && typeof data.value === 'object' && !Array.isArray(data.value)
        ? data.value as Record<string, unknown> : undefined;
      if (typeof value?.operationId !== 'string' || !value.operationId.startsWith('pi-extension/')
        || typeof value.text !== 'string' || value.text.length > 1_000_000
        || (value.mode !== 'steer' && value.mode !== 'follow-up')) continue;
      const receipt = await this.#storage.submissionByRequest(this.#root.id, value.operationId, context);
      if (receipt?.type === 'input') entry.extensionInput = { operationId: value.operationId, text: value.text,
        ...(Array.isArray(value.images) ? { images: parseWorkImages(value.images) } : {}), mode: value.mode, submissionId: receipt.id, processing: receipt.status };
    }
    const agent = await this.#root.agent(context);
    // 公共扫描页不是界面先后次序；条目 id 是正式追加身份，不能把后续结果显示到先前工具之前。
    entries.sort((a, b) => a.id - b.id);
    let pendingInputs=0;
    for(const record of inspection.submissions){
      const linked=record.requestId && await this.#storage.findDocument({kind:'dcode.prepared-input-link',scope:{kind:'session'},key:record.requestId},'current',context);
      if(!linked)pendingInputs+=1;
    }
    // 桌面原先只读正式entry，丢掉了SDK已提交的运行工具输出；仅取同一run的活工具，绝不造结果条目。
    const mayReadProgress = !this.#faulted && !this.#pausing && !this.#paused && this.#enabled && inspection.tasks.length > 0;
    const live = mayReadProgress ? await this.#harness.snapshot(LiveDoc, this.#root.id, context) : undefined;
    // snapshot等待期间pause会同步提升control并认领pausing；相位必须在最后一次await后与返回token同代次取样。
    const phase = this.#faulted ? 'faulted' : this.#pausing ? 'pausing' : this.#paused ? 'paused' : this.#enabled && inspection.tasks.length > 0 ? 'running' : 'ready';
    const toolProgress: NonNullable<ExecutionView['toolProgress']>[number][] = [];
    for (const slot of phase === 'running' ? live?.tools ?? [] : []) {
      const task = inspection.tasks.find(item => item.record.id === slot.taskId)?.record;
      if (slot.status !== 'running' || !task || task.kind !== 'pi.tool' || task.conversationId !== this.#root.id
        || task.owner !== live?.run?.taskId || task.abortRequested || typeof slot.output !== 'string' || !slot.output
        || !task.input || typeof task.input !== 'object' || Array.isArray(task.input) || (task.input.kind !== undefined && task.input.kind !== 'model') || task.input.callId !== slot.callId
        || entries.some(entry => entry.toolResult?.callId === slot.callId)) continue;
      toolProgress.push({ taskId: task.id, callId: slot.callId, name: slot.name, text: slot.output,
        droppedBytes: slot.droppedBytes ?? 0, droppedLines: slot.droppedLines ?? 0 });
    }
    return { target: this.target, control: { instanceId: this.#instanceId, revision: this.#revision }, observation: ++this.#observation, phase, execution: 'pi-durable-1.3.0', model: agent.model ?? null, entries, pendingInputs, toolProgress };
  }

  pause(): Promise<ExecutionView> {
    this.#assertOpen();
    // 在等待当前操作收束前提升版本，使已经排队的旧恢复无法跨过这次用户暂停。
    this.#revision += 1;
    this.#pausing = true;
    this.#paused = true;
    const resources = this.#options.beginCloseExecutionResources?.('resume');
    resources?.done.catch(() => {});
    return this.#serialize(async () => {
      let failure: unknown;
      try { await this.#harness.commit(async tx => { (await tx.doc(Binding)).paused = true; }, context); } catch (error) { failure = error; }
      try { await resources?.shutdownFlushed; } catch (error) { failure ??= error; }
      try { await this.#harness.close(context); } catch (error) { failure ??= error; }
      try { await resources?.done; } catch (error) { failure ??= error; }
      if(!failure)try{await this.#reconcileStoppedSpend();}catch(error){failure=error;}
      if (failure) { this.#faulted = true; throw new Error('Pause could not confirm storage and shutdown', { cause: failure }); }
      this.#enabled = false;
      // 旧 Harness 已收束，注销其 registry 同步；重开只保留当前 Harness 的一份消费者。
      this.#stopRoutingRegistry?.();
      this.#stopRoutingRegistry = undefined;
      await this.#load();
      this.#pausing = false;
      return this.#view();
    });
  }

  /** 正式换该会话 agent.model（不是 resume，不是发送）。已有根调用 Conversation.configure 的正式机制。 */
  async applyModelRef(ref: { provider: string; modelId: string }): Promise<void> {
    await this.#serialize(async () => {
      this.#assertOpen();
      await this.#prepareRoutingForExecution();
      const agent = await this.#root.agent(context);
      if (agent?.model?.provider === ref.provider && agent.model.modelId === ref.modelId) return;
      await this.#root.configure({ model: { provider: ref.provider, modelId: ref.modelId } }, context);
    });
  }

  /**
   * 按会话此刻的选择应用**模型与条件参数档位**（走 Conversation.configure 正式通路）。
   *
   * 这不是 abort、不是重投、也不改历史：正在输出的那次请求已经在跑，
   * Pi 会把它自己的 thinkingLevel 记在那条助手条目里——那是该次请求的真实归属。
   * 这次应用只影响**之后**发出去的请求。
   *
   * 档位 null 表示"用该模型的默认档位"，同样经 configure 正式设置，
   * 不在应用层自行拼 provider 原生参数（那会绕过模型自己的逐档核实映射）。
   */
  async applySessionModel(target: { sourceId: string; modelId: string; thinkingLevel: string | null }): Promise<void> {
    await this.#serialize(async () => {
      this.#assertOpen();
      const agent = await this.#root.agent(context);
      const modelUnchanged = agent?.model?.provider === target.sourceId && agent.model.modelId === target.modelId;
      const levelUnchanged = (agent?.thinkingLevel ?? null) === target.thinkingLevel;
      if (modelUnchanged && levelUnchanged) return;
      // 条件参数与模型**一起**下发：只改档位时也带上模型标识，
      // 避免同源换档后执行端仍按上一个档位发请求（Pi 侧按次读取 agent 配置）。
      await this.#root.configure({
        model: { provider: target.sourceId, modelId: target.modelId },
        thinkingLevel: target.thinkingLevel as never,
      }, context);
    });
  }

  resume(value: ControlToken): Promise<ExecutionView> {
    const token = parseControl(value);
    return this.#serialize(async () => {
      this.#assertOpen();
      if (!this.#matches(token) || this.#pausing) throw Object.assign(new Error('Stale resume request'), { name: "StaleControlError" });
      if (this.#faulted) throw new Error('Runtime storage requires reopen');
      if((await this.#harness.inspect(context)).scheduling==='paused')await this.#options.reconcileExecutionSpend?.(this.#harness,context);
      // 明确继续期间 session_start 可提交 Durable 输入，但暂停标记到正式继续提交前仍保留。
      this.#resuming = true;
      try {
      if (this.#options.prepareExecution) {
        const change = await this.#options.prepareExecution(this.#cwd, 'resume', undefined, context);
        this.#assertOpen();
        if (!this.#matches(token) || this.#pausing) throw new Error('Resume superseded by pause');
        await this.#root.configure(change, context);
      }
      await this.#prepareRoutingForExecution();
      await this.#harness.commit(async tx => { (await tx.doc(Binding)).paused = false; }, context);
      if (!this.#matches(token) || this.#pausing) throw new Error('Resume superseded by pause');
      this.#paused = false;
      this.#enabled = true;
      this.#harness.resume();
      return this.#view();
      } finally {
        this.#resuming = false;
      }
    });
  }

  close(): Promise<void> {
    // 串行尾会吞错以接续请求，不能拿它作关闭回执；所有关闭调用者必须看到同一个真实结果。
    if (this.#closeResult) return this.#closeResult;
    this.#closing = true;
    this.#paused = true;
    this.#revision += 1;
    const resources = this.#sessionFailed ? undefined : this.#options.beginCloseExecutionResources?.('quit');
    resources?.done.catch(() => {});
    this.#closeResult = this.#serialize(async () => {
      // 先等待 Pi 停止和存储关闭，再交出所有权；失败时保留认领，不能让新实例抢写。
      let failure:unknown;
      try { await this.#failedCleanup; } catch (error) { failure = error; }
      if(!this.#faulted){try{
        const inspection=await this.#harness.inspect(context);
        // 直接关窗也要保原在途暂停事实；故障／已关闭的 Harness 仍须走原实际关闭，不能被采样挡住。
        if(inspection.tasks.length||inspection.submissions.length)await this.#harness.commit(async tx=>{(await tx.doc(Binding)).paused=true;},context);
      }catch(error){failure=error;}}
      try{await resources?.shutdownFlushed;}catch(error){failure??=error;}
      try{await this.#harness.close(context);}catch(error){failure??=error;}
      try{await resources?.done;}catch(error){failure??=error;}
      if(!failure)try{await this.#reconcileStoppedSpend();}catch(error){failure=error;}
      this.#stopRoutingRegistry?.(); this.#stopPreparationRegistry?.();
      try{await this.#storage.close(context);}catch(error){failure??=error;}
      if(failure){this.#faulted=true;throw failure;}
      await this.#release();
      this.#closed = true;
    });
    return this.#closeResult;
  }
}
