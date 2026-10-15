import { createHash, randomUUID } from 'node:crypto';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { Harness, LiveDoc, createSession, createRegistry, defineDoc, defineDocFamily, defineExtension, StorageRejected, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable';
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

export type PiSessionOptions = {
  target: ExecutionTarget;
  directory: string;
  cwd: string;
  /** 查询已有运行时禁止初始化；显式首次执行默认可创建。 */
  initialize?: boolean;
  /** 普通客户端沿原绑定目录恢复，不能把旧的相对路径工具迁到新目录。 */
  reuseStoredCwd?: boolean;
  /** 仅发送／明确继续装配资源，观察旧运行不得改写它的指令。 */
  prepareExecution?: (cwd: string) => Promise<AgentChange>;
  /** 每次只读重开只接上原 Harness 的读取，不启动资源。 */
  attachExecution?: (harness: Harness, root: Conversation, ownedModel?: DurableModelRouting['withOwnedModelInvocation']) => void;
  /** 先失效资源准备／在途回调，再等实际连接与调用收束。 */
  closeExecutionResources?: () => Promise<void>;
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
  #paused = false;
  #enabled = false;
  #pausing = false;
  #faulted = false;
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
    this.#inputPreparation = createInputPreparation(async (input, api, ctx) => { await this.#prepareExecution(); return options.prepareInput ? options.prepareInput(input, api, ctx) : {content:input.content,handled:false}; }, () => !this.#paused && !this.#pausing && !this.#closing && !this.#closed, (id, ctx) => this.#harness.submission(id, ctx));
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
  async #prepareRoutingForExecution(): Promise<void> {
    if (!this.#routing) return;
    const agent = await this.#root.agent(context);
    if (!agent.extensions.some((extension) => extension.name === this.#routing!.extension.name)) {
      // 旧记录读取不补写能力；只有已授权的发送、改选或明确继续才接入内部路由 hook。
      await this.#root.configure({ extensions: { add: [this.#routing.extension] } }, context);
    }
  }
  async #prepareExecution(): Promise<void> {
    if (this.#options.prepareExecution) {
      const change = await this.#options.prepareExecution(this.#cwd);
      this.#assertOpen();
      if (this.#paused || this.#pausing) throw new PreparationPaused('Execution preparation was superseded by pause');
      await this.#root.configure(change, context);
    }
    await this.#prepareRoutingForExecution();
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

  async #lookup(input: WorkInput): Promise<InputReceipt> {
    try {
      // 提交后丢失回执可能令 Session 不可继续写；从正式存储读回，不能用 submit/wait 代查。
      const address = await this.#storage.findDocument({ kind: 'dcode.input-identity', scope: { kind: 'session' }, key: input.operationId }, 'current', context);
      const intent = address && await this.#storage.document(address.id, 'current', context);
      if (intent && (intent.version !== 1 || intent.value.fingerprint !== this.#fingerprint(input))) return { status: 'not-accepted', operationId: input.operationId, reason: 'conflict' };
      const record = await this.#storage.submissionByRequest(this.#root.id, input.operationId, context);
      if (record) {
        if (!intent) throw new Error('Stored input identity is missing');
        const preparation = await this.#storage.findDocument({kind:'dcode.input-preparation',scope:{kind:'session'},key:input.operationId},'current',context);
        const prepared = preparation && await this.#storage.document(preparation.id,'current',context);
        const inner = prepared ? await this.#storage.submissionByRequest(this.#root.id,String(prepared.value.innerRequestId ?? processedInputId(input.operationId)),context) : undefined;
        return {...this.#accepted(input,record), ...(inner && record.status !== 'done' && record.status !== 'unanswered' ? {processing:inner.status} : {})};
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
    this.#assertReferenceIntegrity(input.references);
    return this.#serialize(async () => {
      this.#assertOpen();
      const prior = await this.#lookup(input);
      if (prior.status !== 'not-accepted' || prior.reason !== 'not-found') return prior;
      if (this.#paused || this.#pausing) return { status: 'not-accepted', operationId: input.operationId, reason: 'paused' };
      if (!this.#matches(input.expected)) return { status: 'not-accepted', operationId: input.operationId, reason: 'stale-control' };
      if (this.#faulted) return { status: 'unknown', operationId: input.operationId, reason: 'storage-unavailable' };
      try {
        if (this.#options.prepareInput && this.#options.needsInputPreparation?.()) {
          let receipt!: SubmissionRecord;
          await this.#harness.commit(async tx => {
            if (this.#pausing || this.#paused || !this.#matches(input.expected)) throw new PreparationPaused();
            const order = await tx.doc(PreparationOrder);
            const previousTaskId = order.lastTaskId as TaskId | undefined;
            const innerRequestId = `dcode.prepared/${randomUUID()}`;
            await tx.doc(Intent, input.operationId, this.#fingerprint(input));
            await tx.doc(InnerReceipt, innerRequestId, input.operationId);
            receipt = await tx.createSubmission({conversationId:this.#root.id,requestId:input.operationId,type:'input',status:'queued'});
            const taskId = await tx.createTask(this.#inputPreparation.preparation, { receiptId:receipt.id, requestId: input.operationId, innerRequestId, ...(previousTaskId===undefined?{}:{previousTaskId}), content: this.#userContent(input), text: input.text,
              images: [...(input.images ?? [])], mode: input.mode === 'steer' ? 'steer' as const : 'followUp' as const }, { conversationId: this.#root.id, ownership: { kind: 'conversation' } });
            await tx.doc(Preparation, input.operationId, {taskId,innerRequestId});order.lastTaskId=taskId;
          }, context);
          this.#enabled = true; this.#harness.resume();
          return this.#accepted(input,receipt);
        }
        await this.#prepareExecution();
        const text = this.#options.transformInput?.(input.text) ?? input.text;
        // 未启用扩展时保原发送流程；展开明确失败仍发生在接收之前。
        await this.#harness.commit(async tx => { await tx.doc(Intent,input.operationId,this.#fingerprint(input)); },context);
        if (this.#pausing || this.#paused || !this.#matches(input.expected)) return {status:'not-accepted',operationId:input.operationId,reason:'paused'};
        const submission = await this.#root.submit({ type: 'input', content: this.#userContent({ ...input, text }), requestId: input.operationId, whenBusy: input.mode === 'steer' ? 'steer' : 'followUp' }, context);
        this.#enabled = true;
        return this.#accepted(input, await submission.status(context));
      } catch (error) {
        // 暂停在资源 await 期间已认领；正式 submit 尚未调用，不能伪成未知接收或存储故障。
        if (error instanceof PreparationPaused || this.#pausing || this.#paused) return { status: 'not-accepted', operationId: input.operationId, reason: 'paused' };
        // 准备资源在正式接收之前明确失败：不冒称已接收或存储丢失。
        if (error instanceof CodingResourcesUnavailable) return { status: 'not-accepted', operationId: input.operationId, reason: 'execution-unavailable' };
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
        || !task.input || typeof task.input !== 'object' || Array.isArray(task.input) || task.input.callId !== slot.callId
        || entries.some(entry => entry.toolResult?.callId === slot.callId)) continue;
      toolProgress.push({ taskId: task.id, callId: slot.callId, name: slot.name, text: slot.output,
        droppedBytes: slot.droppedBytes ?? 0, droppedLines: slot.droppedLines ?? 0 });
    }
    return { target: this.target, control: { instanceId: this.#instanceId, revision: this.#revision }, observation: ++this.#observation, phase, execution: 'pi-durable-1.0.0', model: agent.model ?? null, entries, pendingInputs, toolProgress };
  }

  pause(): Promise<ExecutionView> {
    this.#assertOpen();
    // 在等待当前操作收束前提升版本，使已经排队的旧恢复无法跨过这次用户暂停。
    this.#revision += 1;
    this.#pausing = true;
    this.#paused = true;
    const resources = this.#options.closeExecutionResources?.();
    resources?.catch(() => {});
    return this.#serialize(async () => {
      let failure: unknown;
      try { await this.#harness.commit(async tx => { (await tx.doc(Binding)).paused = true; }, context); } catch (error) { failure = error; }
      try { await this.#harness.close(context); } catch (error) { failure ??= error; }
      try { await resources; } catch (error) { failure ??= error; }
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
      // 明确继续时允许准备资源；暂停标记到正式继续提交前仍保留。
      if (this.#options.prepareExecution) {
        const change = await this.#options.prepareExecution(this.#cwd);
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
    });
  }

  close(): Promise<void> {
    // 串行尾会吞错以接续请求，不能拿它作关闭回执；所有关闭调用者必须看到同一个真实结果。
    if (this.#closeResult) return this.#closeResult;
    this.#closing = true;
    this.#paused = true;
    this.#revision += 1;
    const resources = this.#options.closeExecutionResources?.();
    resources?.catch(() => {});
    this.#closeResult = this.#serialize(async () => {
      // 先等待 Pi 停止和存储关闭，再交出所有权；失败时保留认领，不能让新实例抢写。
      let failure:unknown;
      if(!this.#faulted){try{
        const inspection=await this.#harness.inspect(context);
        // 直接关窗也要保原在途暂停事实；故障／已关闭的 Harness 仍须走原实际关闭，不能被采样挡住。
        if(inspection.tasks.length||inspection.submissions.length)await this.#harness.commit(async tx=>{(await tx.doc(Binding)).paused=true;},context);
      }catch(error){failure=error;}}
      try{await this.#harness.close(context);}catch(error){failure??=error;}
      try{await resources;}catch(error){failure??=error;}
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
