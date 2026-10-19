/** 普通 SDK 扩展在资源线程装配；消息端口只传有限 JSON，不另建智能体循环。 */
export const extensionWorkerSource = String.raw`
const { parentPort, workerData, threadId } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { createHash } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { isProxy } = require('node:util').types;
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const signalAddListener = EventTarget.prototype.addEventListener;
const signalRemoveListener = EventTarget.prototype.removeEventListener;
const invocation = new AsyncLocalStorage();
const scopeOf = () => invocation.getStore()?.id;
const { syncBuiltinESMExports } = require('node:module');
let runner, sdk, sessionView, streamFactory, closed = false, state = { systemPrompt: '', model: undefined };
const calls = new Map(), replies = new Map(), children = new Set(), closings = new Set(), transports = new Set();
const modelPending = new Map(), sealedModelScopes = new Set(), modelStreams = new Map(), executions = new Set();
const virtualModels = new Map(), virtualHandles = new Map();
const providerHandles = new Map();
let serial = 0, activated = new Set(), active = [], builtins = [], errors = [];
let lastStateRequest = 0;
const actionsByScope = new Map();
const childProcessesByScope = new Map();
const closingScopes = new Set();
// 与 Pi 1.0.0 waitForChildProcess 的安静输出管道边界保持一致。
const commandExitStdioGraceMs = 100;
const nativeSpawn = cp.spawn;
const isDurableInvocationScope = scope => typeof scope === 'string' && /^(tool|input|event)\//.test(scope);
const ownsInvocationCommand = args => {
  const options = args.length >= 3 ? args[2] : args[1];
  return options?.shell === false && Array.isArray(options?.stdio)
    && options.stdio[0] === 'ignore' && options.stdio[1] === 'pipe' && options.stdio[2] === 'pipe';
};
cp.spawn = (...args) => {
  if (closed) throw new Error('Resource session closed');
  const own = invocation.getStore(), scope = own?.id;
  const commandProcess = ownsInvocationCommand(args);
  const controller = commandProcess && isDurableInvocationScope(scope) ? calls.get(scope) : undefined;
  if (commandProcess && (own?.pure || !isDurableInvocationScope(scope) || !controller || controller.signal.aborted)) {
    throw new Error('Extension command requires an active Worker invocation');
  }
  const child = nativeSpawn(...args); children.add(child);
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  let abortChild, escalation, postExitTimer, exited = false, settled = false;
  let stdoutEnded = child.stdout === null, stderrEnded = child.stderr === null;
  const settleChild = () => {
    if (settled) return;
    settled = true;
    clearTimeout(postExitTimer); clearTimeout(escalation);
    child.removeListener('error', onError); child.removeListener('exit', onExit); child.removeListener('close', onClose);
    child.stdout?.removeListener('data', onOutput); child.stderr?.removeListener('data', onOutput);
    child.stdout?.removeListener('end', onStdoutEnd); child.stderr?.removeListener('end', onStderrEnd);
    children.delete(child); closings.delete(done);
    if (controller) {
      controller.signal.removeEventListener('abort', abortChild);
      const ownChildren = childProcessesByScope.get(scope);
      ownChildren?.delete(done);
      if (ownChildren && ownChildren.size === 0 && childProcessesByScope.get(scope) === ownChildren) childProcessesByScope.delete(scope);
    }
    resolveDone();
  };
  const allOutputEnded = () => stdoutEnded && stderrEnded;
  const finalizeAfterExit = () => {
    if (exited && allOutputEnded()) settleChild();
  };
  const armPostExitIdle = () => {
    if (!exited || settled) return;
    clearTimeout(postExitTimer);
    postExitTimer = setTimeout(settleChild, commandExitStdioGraceMs);
  };
  const onOutput = () => armPostExitIdle();
  const onStdoutEnd = () => { stdoutEnded = true; finalizeAfterExit(); };
  const onStderrEnd = () => { stderrEnded = true; finalizeAfterExit(); };
  const onError = error => {
    // Node 也会用 error 报告 kill 失败；它不能代替实际退出或 SDK 的输出静默边界。
    void error;
  };
  const onExit = () => { exited = true; finalizeAfterExit(); if (!settled) armPostExitIdle(); };
  const onClose = () => settleChild();
  // kill 失败可能在 SIGTERM 与后续 SIGKILL 各发一次 error；直到真实 close/SDK 静默前都需留监听和归属。
  child.on('error', onError); child.once('exit', onExit); child.once('close', onClose);
  // 先让 SDK 安装 stdout/stderr 消费者；额外监听只对齐它的 idle 收束，不能抢走首段输出。
  queueMicrotask(() => {
    if (settled) return;
    child.stdout?.on('data', onOutput); child.stderr?.on('data', onOutput);
    child.stdout?.once('end', onStdoutEnd); child.stderr?.once('end', onStderrEnd);
    if (exited) { finalizeAfterExit(); if (!settled) armPostExitIdle(); }
  });
  closings.add(done);
  if (controller) {
    let ownChildren = childProcessesByScope.get(scope);
    if (!ownChildren) { ownChildren = new Set(); childProcessesByScope.set(scope, ownChildren); }
    ownChildren.add(done);
    abortChild = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try { child.kill('SIGTERM'); } catch { /* the close join reports the actual child state */ }
      // 与 Pi 1.0.0 execCommand 的 AbortSignal 收束一致；即使扩展未传自己的 signal，也不能让失主进程永久悬挂。
      escalation = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try { child.kill('SIGKILL'); } catch { /* close remains the authoritative completion signal */ }
        }
      }, 5000);
    };
    if (controller.signal.aborted) abortChild();
    else controller.signal.addEventListener('abort', abortChild, { once: true });
  }
  return child;
};
syncBuiltinESMExports();
const safe = value => JSON.parse(JSON.stringify(value));
const finiteDefinition = value => {
  const seen=new Set();const check=item=>{
    if(item===undefined||item===null||typeof item==='string'||typeof item==='boolean'||(typeof item==='number'&&Number.isFinite(item)))return;
    if(!item||typeof item!=='object'||seen.has(item)||(!Array.isArray(item)&&Object.getPrototypeOf(item)!==Object.prototype))throw new Error('Invalid resource metadata');
    seen.add(item);Object.values(item).forEach(check);seen.delete(item);
  };check(value);
};
const rpc = (method, value, callId) => new Promise((resolve, reject) => {
  const id = ++serial; replies.set(id, { resolve, reject });
  parentPort.postMessage({ type: 'host', id, method, value: safe(value), callId });
});
const trackAction = (scope, action) => {
  let pending = actionsByScope.get(scope);
  if (!pending) { pending = new Set(); actionsByScope.set(scope, pending); }
  pending.add(action);
};
const forgetActions = (scope, batch) => {
  const pending=actionsByScope.get(scope); if(!pending)return;
  for(const action of batch)pending.delete(action);
  if(!pending.size&&actionsByScope.get(scope)===pending)actionsByScope.delete(scope);
};
const queue = (method, value, afterCommit) => { const current=invocation.getStore(); const scope=current?.id;
  if(current?.pure)throw new Error('Argument preparation must be pure');
  const pending = rpc(method, { ...value, actionId: scope + '/' + (++current.counter) }, scope);
  const result = afterCommit ? pending.then(afterCommit) : pending;
  result.catch(() => {}); trackAction(scope, result); return result; };
const commandContext = () => {
  const context=runner.createCommandContext();
  const unavailable=new Proxy({}, {get:()=>()=>{throw new Error('Extension command UI is unavailable in D Code');}});
  return new Proxy(context,{get(target,key){
    // 读取原 SDK getter 以保留 stale runner 检查；D Code 命令没有专属 UI，公开合同仍为 boolean。
    if(key==='hasUI'){Reflect.get(target,key,target);return false;}
    if(key==='ui'){Reflect.get(target,key,target);return unavailable;}
    return Reflect.get(target,key,target);
  }});
};
const flush = async () => {
  // 动作归属于创建它的 invocation；普通工具的 finally 不能取走另一会话事件的关闭批次。
  const scope=scopeOf();
  let failed = false, failure;
  while (actionsByScope.get(scope)?.size || childProcessesByScope.get(scope)?.size) {
    const current=[...(actionsByScope.get(scope) ?? [])];
    if (current.length) {
      const outcomes = await Promise.allSettled(current);
      for (const outcome of outcomes) if (outcome.status === 'rejected' && !failed) { failed = true; failure = outcome.reason; }
      // 已经开始 shutdown 的同 scope 普通 flush 不消费拒绝批次，交给 allSettled close drain。
      if (failed && closingScopes.has(scope)) break;
      forgetActions(scope,current);
    }
    const childProcesses = [...(childProcessesByScope.get(scope) ?? [])];
    if (childProcesses.length) await Promise.all(childProcesses);
  }
  if (failed) throw failure;
};
const flushClosingActions = async scope => {
  // shutdown scope 与普通事件共享同一待完成事实，但不共享消费权；即使另一个同 scope flush 已短路，也等待全部动作和派生动作 settle。
  closingScopes.add(scope);
  let failed = false, failure;
  while (actionsByScope.get(scope)?.size) {
    const current = [...actionsByScope.get(scope)];
    for (const outcome of await Promise.allSettled(current)) if (outcome.status === 'rejected' && !failed) {
      failed = true; failure = outcome.reason;
    }
    forgetActions(scope,current);
  }
  return { failed, failure };
};
const unavailable = () => { throw new Error('This operation requires the D Code formal interface'); };
// JSON 会静默删除函数与非枚举字段；先产出有限普通对象，再交给宿主二次校验。
const validateUserMessageOptions = options => {
  if (options === undefined) return undefined;
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) throw new Error('Invalid sendUserMessage options');
  const normalized = {};
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== 'string' || !['deliverAs', 'expandPromptTemplates'].includes(key)) throw new Error('Invalid sendUserMessage options');
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (!descriptor || !('value' in descriptor)) throw new Error('Invalid sendUserMessage options');
    const value = descriptor.value;
    if (value === undefined) continue;
    if (key === 'deliverAs' && value !== 'steer' && value !== 'followUp') throw new Error('Invalid sendUserMessage options');
    if (key === 'expandPromptTemplates' && typeof value !== 'boolean') throw new Error('Invalid sendUserMessage options');
    normalized[key] = value;
  }
  return normalized;
};
const optional = file => { try { return fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const inside = (root, file) => { const rel = path.relative(root, file); return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
const scoped = file => { const actual = fs.realpathSync(file); if (!inside(workerData.cwd, actual)) throw new Error('Resource outside project'); return actual; };
const json = (file, packageManifest = false) => {
  if (!optional(file)) return {};
  const actual = scoped(file); if (!fs.statSync(actual).isFile() || fs.statSync(actual).size > 1024 * 1024) throw new Error('Invalid resource');
  const text = fs.readFileSync(actual, 'utf8');
  // 包清单保 Pi 的 UTF-8 BOM 兼容；此预审不能把已支持的本地包变成准备失败。
  const value = JSON.parse(packageManifest ? text.replace(/^\uFEFF/, '') : text); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid resource'); return value;
};
let inspected = 0, inspectedFiles = new Set(), resourceRoots = [], configurationFiles = [];
const inspect = file => {
  const app = fs.realpathSync(workerData.agentDir);
  // macOS /var 与 /private/var 是同一授权根；范围比较用实际根，不能把自有资源误拒绝。
  const root = inside(workerData.agentDir, path.resolve(file)) || inside(app, path.resolve(file)) ? app : workerData.cwd;
  const actual = fs.realpathSync(file); if (!inside(root, actual)) throw new Error('Resource outside authorized roots: inspection');
  if (++inspected > 1024) throw new Error('Resource count limit');
  if (fs.statSync(actual).isDirectory()) {
    for (const entry of fs.readdirSync(actual)) { if (entry !== 'node_modules' && entry !== '.git') inspect(path.join(actual, entry)); }
  } else { if (!fs.statSync(actual).isFile() || fs.statSync(actual).size > 8 * 1024 * 1024) throw new Error('Invalid resource file'); inspectedFiles.add(actual); }
};
const configuration = () => {
  inspected = 0; inspectedFiles = new Set();
  for (const root of resourceRoots) if (optional(root)) inspect(root);
  for (const file of configurationFiles) if (optional(file)) inspect(file);
  const hash = createHash('sha256');
  for (const file of [...inspectedFiles].sort()) { hash.update(file); hash.update(fs.readFileSync(file)); }
  return hash.digest('hex');
};
const metadata = () => runner.getAllRegisteredTools().map(({ definition: t, sourceInfo }) => ({
  name: t.name, description: t.description, parameters: t.parameters, exposure: t.exposure ?? 'direct',
  defaultActive: t.defaultActive, namespace: t.namespace, annotations: t.annotations, sourceInfo,
  outputSchema: t.outputSchema, promptGuidelines: t.promptGuidelines, reachesTools: t.reachesTools, constrainedSampling: t.constrainedSampling, hasPrepareArguments: typeof t.prepareArguments === 'function',
}));
const allTools = () => [...builtins, ...metadata()];
const syncTools = () => {
  for (const t of metadata()) if (!activated.has(t.name)) { activated.add(t.name); if ((t.exposure === 'direct' || t.exposure === 'model-only') && t.defaultActive !== false && !active.includes(t.name)) active.push(t.name); }
  const registered = allTools().map(tool => ({...tool, execute:unavailable}));
  const declared = registered.filter(tool => active.includes(tool.name) && tool.exposure !== 'hidden' && tool.exposure !== 'codemode');
  const callable = registered.filter(tool => tool.exposure === 'codemode' || tool.exposure === 'deferred' || (tool.exposure === 'direct' && active.includes(tool.name)));
  const descriptions = {}, hidden = new Set();
  const loadout = {declared,callable,registered,getExposure:name=>allTools().find(t=>t.name===name)?.exposure ?? 'direct',getNamespace:name=>allTools().find(t=>t.name===name)?.namespace,getPromptGuidelines:name=>allTools().find(t=>t.name===name)?.promptGuidelines ?? []};
  for (const tool of runner.getAllRegisteredTools()) if (active.includes(tool.definition.name) && tool.definition.prepareLoadout) {
    const next = tool.definition.prepareLoadout(loadout); if (next?.descriptions) Object.assign(descriptions,next.descriptions); for (const name of next?.hiddenDeclarations ?? []) hidden.add(name);
  }
  parentPort.postMessage({ type: 'tools', tools: safe(metadata().map(tool=>({...tool,description:descriptions[tool.name] ?? tool.description}))), active: [...active],
    declarations:declared.filter(tool=>!hidden.has(tool.name)).map(tool=>tool.name) });
};
const callables = () => allTools().filter(t => t.exposure === 'codemode' || t.exposure === 'deferred' || (t.exposure === 'direct' && active.includes(t.name))).map(t => ({ ...t, execute: unavailable }));
const executeTool = (callerId, name, args, options = {}) => {
  if(invocation.getStore()?.pure)throw new Error('Argument preparation must be pure');
  const scope=scopeOf(); const controller = calls.get(scope); if (!controller || controller.signal.aborted || options.signal?.aborted || closed) throw new Error('Tool caller unavailable');
  return rpc('nested', { name, args }, scope);
};
function refreshSession() {
  if (!sdk || !Array.isArray(state.entries)) return;

      // 只读派生视图每次从原 Durable 记录重建；保原 entry 身份，不生成另一份正式历史。
      const header = { type: 'session', version: 3, id: state.sessionId, timestamp: new Date(0).toISOString(), cwd: workerData.cwd };
      const entries = [header]; let parentId = null;
      for (const entry of state.entries) {
        const timestamp = new Date(0).toISOString();
        if (entry.kind === 'dcode.extension-entry' && entry.data?.action === 'entry') {
          const id = String(entry.id); entries.push({ type: 'custom', id, parentId, timestamp, customType: entry.data.value.customType, data: entry.data.value.data }); parentId = id;
        }
        if (entry.kind === 'dcode.extension-entry' && entry.data?.action === 'name') {
          const id = String(entry.id); entries.push({type:'session_info',id,parentId,timestamp,name:entry.data.value.name}); parentId=id;
        }
        if (entry.kind === 'dcode.extension-entry' && entry.data?.action === 'label') {
          const id = String(entry.id); entries.push({type:'label',id,parentId,timestamp,targetId:entry.data.value.id,label:entry.data.value.label}); parentId=id;
        }
        for (const [index, value] of (entry.model ?? []).entries()) {
          const id = String(entry.id) + (index ? ':' + index : ''); entries.push({ type: 'message', id, parentId, timestamp, message: value }); parentId = id;
        }
      }
      sessionView = sdk.SessionManager.inMemory(workerData.cwd, { id: state.sessionId }, entries);

}
const entriesRevision = entries => Array.isArray(entries)
  ? entries.reduce((last, entry) => Number.isSafeInteger(entry?.id) ? Math.max(last, entry.id) : last, 0) : 0;
const applyEntriesSnapshot = (entries, minimumRevision = entriesRevision(state.entries)) => {
  if (!Array.isArray(entries) || entriesRevision(entries) < minimumRevision) return false;
  state.entries = entries;
  refreshSession();
  return true;
};
const readContextUsage = () => {
  const value = state.contextUsage;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['tokens','contextWindow','percent'].includes(key))
    || !Number.isSafeInteger(value.contextWindow) || value.contextWindow <= 0 || value.contextWindow !== state.model?.contextWindow) return undefined;
  if (value.tokens === null && value.percent === null) return { tokens: null, contextWindow: value.contextWindow, percent: null };
  if (typeof value.tokens !== 'number' || !Number.isFinite(value.tokens) || value.tokens < 0
    || typeof value.percent !== 'number' || !Number.isFinite(value.percent) || value.percent < 0) return undefined;
  // 每次给有限副本；统计查询不能改宿主快照，也不发送RPC／模型请求。
  return { tokens: value.tokens, contextWindow: value.contextWindow, percent: value.percent };
};
async function initialize() {
  sdk = await import(workerData.sdk);
  // SDK 单条 abort 会异步发送取消；同线程连接关闭须先等这条真实通知完成，不能先 abort 全运输。
  const {findPackageJSON}=require('node:module'),{pathToFileURL}=require('node:url');
  const mcpPackage=findPackageJSON('@earendil-works/pi-mcp',workerData.sdk);
  const manifest=JSON.parse(fs.readFileSync(mcpPackage,'utf8'));
  // 运输收束按本轮锁定的 MCP 公开入口接入，不能遗留旧版守卫使普通输入在初始化阶段全被拒绝。
  if(manifest.version!=='1.3.0'||typeof manifest.exports?.['.']?.import!=='string')throw new Error('MCP public entry unavailable');
  const transportPort=await import(pathToFileURL(path.resolve(path.dirname(mcpPackage),manifest.exports['.'].import)).href);
  const notifications=new WeakMap(),closedTransports=new WeakMap();
  for(const Transport of [transportPort.StreamableHttpTransport,transportPort.StdioTransport]){
    const send=Transport.prototype.send,close=Transport.prototype.close,start=Transport.prototype.start;
    Transport.prototype.start=function(){if(closed)throw new Error('Resource session closed');transports.add(this);return start.call(this);};
    Transport.prototype.send=function(message,options){
      // 1.3按本次send signal阻止认证等待后的迟发，透明保留第二参，不能退回仅转发message。
      const flight=send.call(this,message,options);
      if(message.method==='notifications/cancelled'){
        let pending=notifications.get(this);if(!pending){pending=new Set();notifications.set(this,pending);}pending.add(flight);
        flight.then(()=>pending.delete(flight),()=>pending.delete(flight));
      }
      return flight;
    };
    Transport.prototype.close=function(){
      let result=closedTransports.get(this);if(result)return result;
      result=(async()=>{const pending=[...(notifications.get(this)??[])];let timer;
        try{await Promise.race([Promise.allSettled(pending),new Promise(resolve=>{timer=setTimeout(resolve,1000);})]);}finally{clearTimeout(timer);}
        // 1.3运输close使用已取得token并中止网络，不等待共享认证刷新。
        // 再join挂在token上的send会反锁关闭；其拒绝已被跟踪，整个资源线程仍由宿主真实退出join。
        await close.call(this);transports.delete(this);
      })();closedTransports.set(this,result);return result;
    };
  }
  if (closed) throw new Error('Resource preparation cancelled');
  const settingsFile = path.join(workerData.cwd, '.pi', 'settings.json');
  const settings = json(settingsFile);
  const extensions = settings.extensions ?? [], skillSelectors = settings.skills ?? [], promptSelectors = settings.prompts ?? [];
  const packages = settings.packages ?? [];
  if (![extensions, packages, skillSelectors, promptSelectors].every(Array.isArray)
    || extensions.length + packages.length + skillSelectors.length + promptSelectors.length > 128) throw new Error('Invalid resources');
  const local = source => {
    if (typeof source !== 'string' || /^(npm:|git:|https?:|ssh:|~)/.test(source)) throw new Error('Package must be locally available in project');
    const file = scoped(path.resolve(workerData.cwd, '.pi', source)); inspect(file); return file;
  };
  const resourcePaths = (entries, builtin = false) => entries.map(source => {
    if (typeof source !== 'string') throw new Error('Invalid extension selector');
    const name = source.replace(/^[!+-]/, '');
    if (name.startsWith('builtin:')) { if (!builtin) throw new Error('Invalid resource selector'); return source; }
    if (/[?*{[]/.test(name)) {
      const prefix = path.resolve(workerData.cwd, '.pi', name.split(/[?*{[]/)[0]);
      if (!inside(workerData.cwd, prefix)) throw new Error('Selector outside project'); return source;
    }
    const pathName=path.resolve(workerData.cwd,'.pi',name);
    if(!inside(workerData.cwd,pathName))throw new Error('Selector outside project');
    const actual = source[0] === '!' || source[0] === '-' ? (optional(pathName) ? scoped(pathName) : pathName) : local(name);
    return source[0] === '!' || source[0] === '+' || source[0] === '-' ? source[0] + actual : actual;
  });
  const extensionPaths = resourcePaths(extensions, true), skillPaths = resourcePaths(skillSelectors), promptPaths = resourcePaths(promptSelectors);
  const packageSources = packages.map(item => {
    if (typeof item === 'string') return local(item);
    if (!item || typeof item !== 'object' || typeof item.source !== 'string') throw new Error('Invalid package');
    return { ...item, source: local(item.source) };
  });
  const conventional = path.join(workerData.cwd, '.pi', 'extensions');
  // 普通目录与本地包采用同一失效指纹；查回不调用它，只有下一次正式准备才核变化。
  resourceRoots = [conventional, path.join(workerData.cwd,'.pi','skills'), path.join(workerData.cwd,'.agents','skills'),
    path.join(workerData.cwd,'.pi','prompts'), path.join(workerData.agentDir,'skills'), path.join(workerData.agentDir,'prompts'),
    ...[...extensionPaths, ...skillPaths, ...promptPaths].map(file=>file.replace(/^[!+-]/,'')).filter(file=>!file.startsWith('builtin:') && !/[?*{[]/.test(file)),
    ...packageSources.map(source=>typeof source === 'string' ? source : source.source)];
  configurationFiles = [settingsFile,path.join(workerData.cwd,'.pi','mcp.json'),path.join(workerData.cwd,'.gitignore')];
  if (optional(conventional)) inspect(conventional);
  const mcp = json(path.join(workerData.cwd, '.pi', 'mcp.json'));
  if (mcp.mcpServers !== undefined && (!mcp.mcpServers || typeof mcp.mcpServers !== 'object' || Array.isArray(mcp.mcpServers))) throw new Error('Invalid MCP config');
  const configFactory = pi => {
    for (const [name, config] of Object.entries(mcp.mcpServers ?? {})) {
      if (!config || typeof config !== 'object' || config.auth) throw new Error('Project MCP cannot use model provider credentials');
      if (config.cwd) scoped(path.resolve(workerData.cwd, config.cwd));
      pi.registerMcpServer(name, config);
    }
  };
  // 官方包解析在应用 noSkills 前就发现 Home／祖先资源；在本资源线程的读取端口先拒绝越界。
  // SDK 模块与依赖本身可读取；项目代码资源只给绑定项目及 D Code 自有资源根。
  const { fileURLToPath } = require('node:url');
  const sdkPath = fileURLToPath(workerData.sdk);
  const dependencyRoot = sdkPath.slice(0, sdkPath.indexOf(path.sep + 'node_modules' + path.sep) + (path.sep + 'node_modules').length);
  const appRoot = fs.realpathSync(workerData.agentDir);
  const nativeFs = Object.fromEntries(['existsSync', 'realpathSync', 'statSync', 'lstatSync', 'readdirSync', 'readFileSync'].map(name => [name, fs[name].bind(fs)]));
  const allowed = file => {
    if (typeof file !== 'string' && !(file instanceof URL) && !Buffer.isBuffer(file)) return false;
    let name = path.resolve(file instanceof URL ? fileURLToPath(file) : String(file));
    if (inside(workerData.agentDir, name)) name = path.resolve(appRoot, path.relative(workerData.agentDir, name));
    // 先限定已绑定根的词法别名，再核真实根；/var别名不会扩大最终读取范围。
    if (![workerData.cwd, workerData.agentDir, appRoot, dependencyRoot].some(root => inside(root, name))) return false;
    let actual = name;
    try { actual = nativeFs.realpathSync(name); } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    return [workerData.cwd, appRoot, dependencyRoot].some(root => inside(root, actual));
  };
  fs.existsSync = file => allowed(file) && nativeFs.existsSync(file);
  for (const name of ['realpathSync', 'statSync', 'lstatSync', 'readdirSync', 'readFileSync']) {
    const native = fs[name]; const wrapped = (file, ...args) => { if (!allowed(file)) throw Object.assign(new Error('Resource outside authorized roots: '+name), { code: 'EACCES' }); return native(file, ...args); };
    if (native.native) wrapped.native = (...args) => wrapped(...args);
    fs[name] = wrapped;
  }
  syncBuiltinESMExports();
  // 本宿主不落盘 MCP 的原始 stderr／logging 通知；只关闭指定的自有 SDK 日志出口。
  const rawMcpLog=path.join(appRoot,'mcp.log'),nativeAppend=fs.appendFileSync;
  fs.appendFileSync=(file,...args)=>{if(path.resolve(String(file))===rawMcpLog)return;return nativeAppend(file,...args);};
  syncBuiltinESMExports();
  const validateResourceText = file => {
    const actual = fs.realpathSync(file);
    if (![workerData.cwd, appRoot].some(root => inside(root, actual))) throw new Error('Resource outside authorized roots: selected text');
    const info = fs.statSync(actual);
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error('Invalid resource file');
    return sdk.parseFrontmatter(new TextDecoder('utf-8',{fatal:true}).decode(fs.readFileSync(actual)));
  };
  const projectSettings = { ...settings, packages: packageSources, extensions: extensionPaths, skills: skillPaths, prompts: promptPaths };
  const settingsManager = sdk.SettingsManager.fromStorage({ withLock(scope, fn) { const previous = scope === 'project' ? JSON.stringify(projectSettings) : undefined; const next = fn(previous); if (next !== undefined && next !== previous) throw new Error('Resource settings are read-only'); } });
  if (settingsManager.drainErrors().length) throw new Error('Resource settings failed');
  // SDK 会无诊断地略过缺 description 的普通 md；只核明示具体文件，不把自动 README 当技能。
  // 选择有效性仍取公开 PackageManager 的 enabled 结果，不能重写筛选或复活被排除项。
  const declaredSkills = new Set();
  const concreteFiles = (entries, base) => {
    const files = [];
    for (const entry of entries ?? []) {
      if (typeof entry !== 'string' || /^[!-]/.test(entry) || /[?*{[]/.test(entry)) continue;
      const file = path.resolve(base, entry.replace(/^\+/, ''));
      if (file.endsWith('.md') && optional(file)) {
        // 根内文件链接也由 SDK 实际读取；先保真实根门禁，再按目标文件类型认领声明。
        const actual = fs.realpathSync(file);
        if (fs.statSync(actual).isFile()) files.push(actual);
      }
    }
    return files;
  };
  const explicitSkills = new Set(concreteFiles(skillPaths, path.join(workerData.cwd, '.pi')));
  for (const source of packageSources) {
    const root = typeof source === 'string' ? source : source.source;
    const manifest = json(path.join(root, 'package.json'), true);
    for (const file of concreteFiles(manifest.pi?.skills, root)) explicitSkills.add(file);
    if (typeof source !== 'string') for (const file of concreteFiles(source.skills, root)) explicitSkills.add(file);
  }
  const selected = await new sdk.DefaultPackageManager({ cwd:workerData.cwd, agentDir:workerData.agentDir, settingsManager,
    builtinExtensions:['codemode','tool-search','mcp'] }).resolve();
  for (const resource of selected.skills) if (resource.enabled && explicitSkills.has(fs.realpathSync(resource.path))) declaredSkills.add(fs.realpathSync(resource.path));
  const validateDeclaredSkill = file => {
    const {frontmatter} = validateResourceText(file);
    if (typeof frontmatter.description !== 'string' || !frontmatter.description.trim()) throw new Error('Declared skill unavailable');
  };
  const loader = new sdk.DefaultResourceLoader({ cwd: workerData.cwd, agentDir: workerData.agentDir, settingsManager,
    noContextFiles: true, noThemes: true,
    skillsOverride: result => {
      // 库的缺 description／解析失败是 warning 且会丢条目；选中声明失败须在正式准备中拒绝。
      if (result.diagnostics.some(item => item.type === 'error' || (item.type === 'warning' && path.basename(item.path ?? '') === 'SKILL.md'
        && !result.skills.some(skill => skill.filePath === item.path)))) throw new Error('Declared skill unavailable');
      for (const file of declaredSkills) validateDeclaredSkill(file);
      for (const skill of result.skills) validateResourceText(skill.filePath);
      return result;
    },
    promptsOverride: result => {
      if (result.diagnostics.some(item => item.type === 'error' || item.type === 'warning')) throw new Error('Declared prompt unavailable');
      for (const prompt of result.prompts) validateResourceText(prompt.filePath);
      // 开启包加载后 SDK 会先去重项目模板；仅从其已选中冲突记录恢复应用模板的既定优先级。
      // 不另扫目录，不复活被 selector 排除的文件，其余重名仍保留 SDK 的首次定义。
      const prompts = [...result.prompts];
      for (const item of result.diagnostics) {
        const collision = item.collision;
        if (item.type !== 'collision' || collision?.resourceType !== 'prompt') continue;
        const file = collision.loserPath;
        if (![workerData.agentDir, appRoot].some(root => inside(root, path.resolve(file)))) continue;
        const index = prompts.findIndex(prompt => prompt.name === collision.name);
        if (index < 0 || [workerData.agentDir, appRoot].some(root => inside(root, path.resolve(prompts[index].filePath)))) continue;
        const { frontmatter, body } = validateResourceText(file);
        const firstLine = body.split('\n').find(line => line.trim()) ?? '';
        const description = typeof frontmatter.description === 'string' && frontmatter.description
          ? frontmatter.description : firstLine.slice(0, 60) + (firstLine.length > 60 ? '...' : '');
        const argumentHint = typeof frontmatter['argument-hint'] === 'string' ? frontmatter['argument-hint'] : undefined;
        prompts[index] = { name: collision.name, description, ...(argumentHint && { argumentHint }), content: body, filePath: file,
          sourceInfo: { path: file, source: 'auto', scope: 'user', origin: 'top-level', baseDir: workerData.agentDir } };
      }
      return { ...result, prompts };
    },
    extensionFactories: [configFactory, {name:'codemode',builtin:true,factory:sdk.createCodemodeExtension({ models: false })}, {name:'tool-search',builtin:true,factory:sdk.createToolSearchExtension()},
      {name:'mcp',builtin:true,factory:sdk.createMcpExtension({ loadConfig: () => ({ servers: [], errors: [], autoEnableCodemode: mcp.autoEnableCodemode }),
        logPath: path.join(workerData.agentDir, 'mcp.log'), openUrl: unavailable, updateConfig: unavailable })}] });
  await loader.reload();
  const loaded = loader.getExtensions(); if (loaded.errors.length) throw new Error('Extension failed to load');
  const assertRuntimeActive = loaded.runtime.assertActive;
  loaded.runtime.assertActive = () => {
    assertRuntimeActive();
    // registerTool先改SDK map再refreshTools；在公开pi入口的原assert前置挡住route写入，不能事后只挡发布。
    // ctx的只读目录/cwd/session/signal走Runner自己的stale检查，仍保持可读；不声称任意项目JS是沙箱纯函数。
    if (invocation.getStore()?.readOnlyRoute) return unavailable();
  };
  const loadedSkills = loader.getSkills(); const loadedPrompts = loader.getPrompts();
  if (loadedSkills.diagnostics.some(item => item.type === 'error') || loadedPrompts.diagnostics.some(item => item.type === 'error')) throw new Error('Package resource unavailable');
  workerData.packageInstructions = sdk.formatSkillsForPrompt(loadedSkills.skills);
  workerData.packagePrompts = loadedPrompts.prompts.map(item => ({ name: item.name, content: item.content, filePath: item.filePath }));
  if (closed) throw new Error('Resource preparation cancelled');
  const modelRuntime = await sdk.ModelRuntime.create({ credentials: {
    async read() { return undefined; }, async list() { return []; }, async write() { unavailable(); }, async remove() { unavailable(); }
  }, modelsPath: null, refreshOnCreate: false });
  // 模型目录只作派生读取；扩展发起模型执行仍须经过宿主准入，不从线程另开模型通路。
  // Root 装配只公开 event-stream 工厂入口；线程内动态 import 取公共流，不引包私有路径或自造兼容流。
  if (typeof workerData.streamFactory !== 'string') throw new Error('Public event stream unavailable');
  streamFactory = (await import(workerData.streamFactory))?.createAssistantMessageEventStream;
  if (typeof streamFactory !== 'function') throw new Error('Public event stream unavailable');
  const modelRegistry = new sdk.ModelRegistry(modelRuntime);
  for (const name of ['refresh', 'getError', 'hasConfiguredAuth', 'getApiKeyAndHeaders', 'getProviderAuthStatus', 'getProvider',
    'stream', 'streamSimple', 'complete', 'completeSimple', 'classify', 'generateImages', 'getProviderAuth', 'getApiKeyForProvider',
    'isUsingOAuth', 'registerProvider', 'unregisterProvider', 'registerVirtualModel', 'unregisterVirtualModel',
    'getRegisteredProviderConfig', 'getRegisteredNativeProvider']) modelRegistry[name] = unavailable;
  // 同步兼容 facade 只读本次宿主发布的完整 chat 帧，不另查认证、不从当前模型猜目录。
  modelRegistry.getAll = () => safe(state.modelCatalog?.all ?? []);
  modelRegistry.getAvailable = () => safe(state.modelCatalog?.available ?? []);
  modelRegistry.find = (provider, id) => {
    const model = state.modelCatalog?.all.find(model => model.provider === provider && model.id === id);
    return model ? safe(model) : undefined;
  };
  // Worker ModelRuntime 没有宿主凭据或完整 provider 装配；typed 同步读取必须使用宿主按类型发布的安全帧。
  const modelTypes = new Set(['chat', 'image', 'classifier']);
  const validProvider = provider => typeof provider === 'string' && provider.trim().length > 0 && provider.length <= 128 && !/[\x00-\x1f]/.test(provider);
  const typedCatalog = type => {
    if (!modelTypes.has(type)) return unavailable();
    const models = state.modelCatalog?.byType?.[type];
    return Array.isArray(models) ? models : [];
  };
  // Provider display names and registration IDs belong to the host catalog; the Worker runtime is deliberately unconfigured.
  modelRegistry.getProviderDisplayName = provider => {
    if (typeof provider !== 'string') return unavailable();
    return state.modelCatalog?.providerNames?.find(item => item?.id === provider)?.name ?? provider;
  };
  modelRegistry.getRegisteredProviderIds = () => safe(state.modelCatalog?.registeredProviderIds ?? []);
  modelRegistry.getModelsOfType = (type, provider) => {
    if (!modelTypes.has(type) || (provider !== undefined && !validProvider(provider))) return unavailable();
    const models = typedCatalog(type);
    return safe(provider === undefined ? models : models.filter(model => model.provider === provider));
  };
  modelRegistry.getModelOfType = (type, provider, modelId) => {
    if (!modelTypes.has(type) || !validProvider(provider) || typeof modelId !== 'string' || !modelId.trim() || modelId.length > 256) return unavailable();
    const model = typedCatalog(type).find(model => model.provider === provider && model.id === modelId);
    return model ? safe(model) : undefined;
  };
  modelRegistry.findOfType = (type, provider, modelId) => modelRegistry.getModelOfType(type, provider, modelId);
  modelRegistry.getAvailableOfType = (type, provider, options = {}) => {
    const own = invocation.getStore(), scope = scopeOf();
    if (closed || !own || !scope || !modelTypes.has(type) || (provider !== undefined && !validProvider(provider))
      || !options || typeof options !== 'object' || Array.isArray(options)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(options))
      || Reflect.ownKeys(options).some(key => key !== 'signal')) return unavailable();
    const signalDescriptor = Object.getOwnPropertyDescriptor(options, 'signal');
    if (signalDescriptor && !('value' in signalDescriptor)) return unavailable();
    const signal = signalDescriptor?.value === undefined ? calls.get(scope)?.signal : signalDescriptor.value;
    if (signal !== undefined && (!signal || typeof signal.aborted !== 'boolean'
      || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) return unavailable();
    if (signal?.aborted) return Promise.reject(new Error('Model availability cancelled'));
    const actionId = scope + '/model-availability/' + (++own.counter);
    let cancelFlight;
    const abort = () => {
      if (!cancelFlight) {
        cancelFlight = rpc('model-available-cancel', { actionId }, scope);
        cancelFlight.catch(() => {});
      }
    };
    signal?.addEventListener('abort', abort, { once: true });
    const pending = rpc('model-available-of-type', { actionId, type, ...(provider === undefined ? {} : { provider }) }, scope)
      .then(reply => {
        if (signal?.aborted) throw new Error('Model availability cancelled');
        if (!reply || !Array.isArray(reply.models)) return unavailable();
        return safe(reply.models);
      }).finally(async () => {
        signal?.removeEventListener('abort', abort);
        if (cancelFlight) await cancelFlight.catch(() => {});
      });
    pending.catch(() => {}); trackAction(scope, pending.then(() => undefined, () => undefined)); return pending;
  };
  modelRegistry.complete = (model, input, options = {}) => {
    const pending = (async () => {
    const own = invocation.getStore(); const scope = scopeOf();
    if (!own || own.pure || !scope?.startsWith('tool/') || !calls.has(scope) || sealedModelScopes.has(scope)) return unavailable();
    const { signal = calls.get(scope).signal, ...parameters } = options;
    if (signal?.aborted) throw new Error('Model invocation cancelled');
    // 函数／循环／非有限值不能被JSON静默丢弃后冒充SDK选项已生效。
    const seen = new Set();
    const check = value => {
      if (value === undefined || value === null || typeof value === 'string' || typeof value === 'boolean') return;
      if (typeof value === 'number' && Number.isFinite(value)) return;
      if (!value || typeof value !== 'object' || seen.has(value) || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)) throw new Error('Unsupported model request value');
      seen.add(value); Object.values(value).forEach(check); seen.delete(value);
    };
    check(input); check(parameters);
    const actionId = scope + '/' + (++own.counter);
    const abort = () => { void rpc('model-cancel', { actionId }, scope).catch(() => {}); };
    signal?.addEventListener('abort', abort, {once:true});
    try {
      const result = await rpc('model-complete', {caller:scope,actionId,provider:model.provider,modelId:model.id,input,options:parameters}, scope);
      if (signal?.aborted) throw new Error('Model invocation cancelled');
      return result.message;
    } finally { signal?.removeEventListener('abort', abort); }
    })();
    // 只在发起工具的收口处join；provider回调不能等待其自身正在准备的模型请求。
    const scope = scopeOf();
    if (scope && calls.has(scope)) {
      const own = modelPending.get(scope) ?? new Set(); modelPending.set(scope, own); own.add(pending);
      pending.then(() => own.delete(pending), () => own.delete(pending));
    }
    return pending;
  };
  const ownedTyped = (operation, type) => (model, input, options = {}) => {
    const own = invocation.getStore(), scope = scopeOf(), controller = calls.get(scope);
    let origin = { api: '', provider: '', id: '' };
    // classify 的公开合同是有限结果且不 reject；拒绝不能伪装成 chat 或补造服务商响应标识。
    const failure = (aborted, message) => ({ api: origin.api ?? '', provider: origin.provider ?? '', model: origin.id ?? '',
      ...(operation === 'classify' ? { answers: {} } : { output: [] }), stopReason: aborted ? 'aborted' : 'error', errorMessage: message, timestamp: Date.now() });
    let signal, cancelFlight, actionId, listening = false, scopeListening = false;
    const scopeSignal = controller?.signal;
    const aborted = value => value !== undefined && signalAborted.call(value);
    const cancel = () => { if (!cancelFlight) { cancelFlight = rpc('model-cancel', { actionId }, scope); cancelFlight.catch(() => {}); } };
    const pending = (async () => {
      try {
        if (!own || own.pure || !scope?.startsWith('tool/') || !controller || sealedModelScopes.has(scope)) return failure(false, 'Formal host operation rejected');
        // 不在有限结果保护外读取扩展对象；accessor/Proxy 也不能借错误元数据或清理再次抛出。
        if (!model || typeof model !== 'object' || isProxy(model) || ![Object.prototype, null].includes(Object.getPrototypeOf(model))) return failure(false, 'Unsupported typed model');
        const fields = {};
        for (const key of ['provider', 'id', 'api']) {
          const field = Object.getOwnPropertyDescriptor(model, key);
          if (!field || !('value' in field) || typeof field.value !== 'string') return failure(false, 'Unsupported typed model');
          fields[key] = field.value;
        }
        if (!validProvider(fields.provider) || !fields.id.trim() || fields.id.length > 256 || fields.api.length > 128) return failure(false, 'Unsupported typed model');
        const canonical = state.modelCatalog?.byType?.[type]?.find(entry => entry.provider === fields.provider && entry.id === fields.id);
        origin = canonical ? { api: canonical.api, provider: canonical.provider, id: canonical.id } : fields;
        if (!canonical) return failure(false, 'Configured typed model unavailable');
        if (!options || typeof options !== 'object' || Array.isArray(options) || isProxy(options) || Object.getPrototypeOf(options) !== Object.prototype) return failure(false, 'Unsupported typed options');
        let requested = scopeSignal;
        const parameters = {};
        for (const key of Reflect.ownKeys(options)) {
          const field = Object.getOwnPropertyDescriptor(options, key);
          // 逐键赋值前先核允许集；__proto__ 等未知键不能被对象setter静默丢弃后绕过宿主校验。
          if (typeof key !== 'string' || !(operation === 'classify' ? ['signal', 'temperature', 'timeoutMs', 'maxRetries', 'maxRetryDelayMs'] : ['signal', 'timeoutMs', 'maxRetries', 'maxRetryDelayMs']).includes(key)
            || !field || !('value' in field)) return failure(false, 'Unsupported typed options');
          if (key === 'signal') requested = field.value === undefined ? scopeSignal : field.value;
          else parameters[key] = field.value;
        }
        // 原生 brand 检查在赋值前完成，拒绝冒充signal的getter；后续不调用扩展覆盖的方法。
        if (requested !== undefined) signalAborted.call(requested);
        signal = requested;
        const seen = new Set();
        const check = value => {
          if (value === undefined || value === null || typeof value === 'string' || typeof value === 'boolean') return;
          if (typeof value === 'number' && Number.isFinite(value)) return;
          if (!value || typeof value !== 'object' || seen.has(value) || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)) throw new Error('Unsupported typed value');
          seen.add(value); Object.values(value).forEach(check); seen.delete(value);
        };
        check(input); check(parameters);
        if (aborted(signal) || aborted(scopeSignal)) return failure(true, 'Request was aborted');
        actionId = scope + '/' + operation + '/' + (++own.counter);
        if (signal) { signalAddListener.call(signal, 'abort', cancel, { once: true }); listening = true; }
        if (signal !== scopeSignal) { signalAddListener.call(scopeSignal, 'abort', cancel, { once: true }); scopeListening = true; }
        const reply = await rpc(operation === 'classify' ? 'model-classify' : 'model-images', { caller: scope, actionId, provider: origin.provider, modelId: origin.id, input, options: parameters }, scope);
        // Host 已收口真实子任务；保留其已确认 usage，包括带费用的错误或取消。
        return reply.typed;
      } catch { return failure(aborted(signal) || aborted(scopeSignal), 'Formal typed model operation rejected'); }
      finally {
        if (listening) signalRemoveListener.call(signal, 'abort', cancel);
        if (scopeListening) signalRemoveListener.call(scopeSignal, 'abort', cancel);
        if (cancelFlight) await cancelFlight.catch(() => {});
      }
    })();
    // 即使扩展忽略 Promise，原工具也要等真实 host 事务及取消收口后才能完成。
    if (scope && controller) {
      const joined = modelPending.get(scope) ?? new Set(); modelPending.set(scope, joined); joined.add(pending);
      pending.then(() => joined.delete(pending), () => joined.delete(pending));
    }
    return pending;
  };
  modelRegistry.classify = ownedTyped('classify', 'classifier');
  modelRegistry.generateImages = ownedTyped('generateImages', 'image');
  const ownedStream = method => (model, input, options = {}) => {
    const own = invocation.getStore(); const scope = scopeOf();
    if (!own || own.pure || !scope?.startsWith('tool/') || !calls.has(scope) || sealedModelScopes.has(scope)) return unavailable();
    const controller = calls.get(scope);
    const { signal = controller.signal, ...parameters } = options;
    // 函数／循环／非有限值不能被JSON静默丢弃后冒充SDK选项已生效。
    const seen = new Set();
    const check = value => {
      if (value === undefined || value === null || typeof value === 'string' || typeof value === 'boolean') return;
      if (typeof value === 'number' && Number.isFinite(value)) return;
      if (!value || typeof value !== 'object' || seen.has(value) || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)) throw new Error('Unsupported model request value');
      seen.add(value); Object.values(value).forEach(check); seen.delete(value);
    };
    check(input); check(parameters);
    const actionId = scope + '/' + (++own.counter);
    const stream = streamFactory();
    // 本地终态消息的 api/provider/model 取本次 canonical 模型引用并在发起时固定；后续目录变化不再影响。
    const catalogued = state.modelCatalog?.all.find(entry => entry.provider === model.provider && entry.id === model.id);
    const origin = { api: (catalogued ?? model).api, provider: model.provider, model: model.id };
    // 同一流只认首见 taskId 与精确递增 seq；done/error 终帧只由本 action 的最终 reply 发出一次。
    const record = { scope, taskId: undefined, seq: 0, settled: false, stream, partial: undefined };
    const scopeSignal = controller.signal;
    // 本地取消／拒绝终帧必须是完整 AssistantMessage：保留已验证 partial 的 content/usage；未确认用量给全 0 结构，不冒充 provider 完成或正式事实。
    const failure = (stopReason, errorMessage) => ({
      role: 'assistant', api: origin.api, provider: origin.provider, model: origin.model,
      content: record.partial?.content ?? [], usage: record.partial?.usage
        ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason, errorMessage, timestamp: Date.now(),
    });
    // 合法已取消signal仍保持公开同步流合同；没有发起的请求不建RPC/模型子任务或猜费用。
    if (signal?.aborted || scopeSignal.aborted) {
      stream.push({ type: 'error', reason: 'aborted', error: failure('aborted', 'Request was aborted') });
      stream.end(); return stream;
    }
    const cleanup = () => { modelStreams.delete(actionId); signal?.removeEventListener('abort', cancel); if (signal !== scopeSignal) scopeSignal.removeEventListener('abort', cancel); };
    const cancel = () => {
      if (record.settled) return;
      record.settled = true;
      // 本地取消立即以 aborted 终帧收束 iterator/result；取消只通知一次，host 事务仍 join 至真实 reply，不因本地完成丢弃。
      void rpc('model-cancel', { actionId }, scope).catch(() => {});
      stream.push({ type: 'error', reason: 'aborted', error: failure('aborted', 'Request was aborted') });
      stream.end(); cleanup();
    };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal !== scopeSignal) scopeSignal.addEventListener('abort', cancel, { once: true });
    modelStreams.set(actionId, record);
    const hostCall = rpc('model-stream', { caller: scope, actionId, provider: model.provider, modelId: model.id, input, options: parameters, mode: method }, scope);
    // modelPending join 真实 host RPC 至 settled；result-only、提前 break 或本地取消都不能提前解除这笔事务。
    const joined = modelPending.get(scope) ?? new Set(); modelPending.set(scope, joined); joined.add(hostCall);
    hostCall.then(() => joined.delete(hostCall), () => joined.delete(hostCall));
    hostCall.then(reply => {
      if (record.settled) { cleanup(); return; }
      // reply 的 taskId 须等于 partial 首认领（或此刻首认领），seq 必须是预期下一号；违者不推进流、不替代当前调用。
      // taskId 是原 SDK child TaskId：正安全整数；seq 同为正安全整数，校验失败不推进。
      const valid = Number.isSafeInteger(reply?.taskId) && reply.taskId > 0
        && (record.taskId === undefined ? (record.taskId = reply.taskId) : record.taskId === reply.taskId)
        && Number.isSafeInteger(reply.seq) && reply.seq === record.seq + 1
        && (reply.terminal?.type === 'done' || reply.terminal?.type === 'error');
      record.settled = true;
      if (!valid) {
        // 终态协议不完整时本地以 error 终帧有限收束；不重发请求，也不虚构成功。
        stream.push({ type: 'error', reason: 'error', error: failure('error', 'Model stream settlement invalid') });
        stream.end(); cleanup(); return;
      }
      if (reply.terminal.type === 'done') stream.push({ type: 'done', reason: reply.terminal.reason, message: reply.message });
      else stream.push({ type: 'error', reason: reply.terminal.reason, error: reply.message });
      stream.end(reply.message); cleanup();
    }, () => {
      if (record.settled) { cleanup(); return; }
      record.settled = true;
      // host 拒绝本操作时没有可转发的 child 终态；本地有限 error 收束，不另发请求。
      stream.push({ type: 'error', reason: 'error', error: failure('error', 'Formal host operation rejected') });
      stream.end(); cleanup();
    });
    return stream;
  };
  modelRegistry.streamSimple = ownedStream('streamSimple');
  modelRegistry.stream = ownedStream('stream');
  sessionView = sdk.SessionManager.inMemory(workerData.cwd, { id: state.sessionId }); refreshSession();
  const readMethods = new Set(['getCwd','getSessionDir','getSessionId','getSessionFile','getLeafId','getLeafEntry','getEntry','getLabel','getBranch','buildContextEntries','buildSessionProjection','getHeader','getEntries','getTree','getSessionName']);
  const sessionManager = new Proxy(sessionView, { get(target, key) {
    if (!readMethods.has(key)) return unavailable;
    return (...args) => sessionView[key](...args);
  } });
  runner = new sdk.ExtensionRunner(loaded.extensions, loaded.runtime, workerData.cwd, sessionManager, modelRegistry);
  // D Code commands share the normal non-UI session context; session-tree and reload controls must fail, not silently no-op.
  const unsupportedCommandControl = async () => { throw new Error('Extension command session control is unavailable in D Code'); };
  runner.bindCommandContext({ waitForIdle: unsupportedCommandControl, newSession: unsupportedCommandControl,
    fork: unsupportedCommandControl, navigateTree: unsupportedCommandControl, switchSession: unsupportedCommandControl,
    reload: unsupportedCommandControl });
  runner.onError(() => errors.push('extension-event-failed'));
  const registration = (method, payload) => {
    if (closed || invocation.getStore()?.pure || !scopeOf()) return unavailable();
    // SDK的注册API返回void；在原资源/事件flush处等宿主确认，不能先把本地函数表当可用目录。
    const scope=scopeOf();
    const pending = rpc(method, payload, scope).then(reply => { state.modelCatalog = reply.catalog; });
    pending.catch(() => {}); trackAction(scope, pending);
  };
  runner.bindCore({
    sendMessage: (message, options) => queue('message', { message, options }),
    sendUserMessage: (content, options) => queue('user', { content, options: validateUserMessageOptions(options) }),
    appendEntry: (customType, data) => queue('entry', { customType, data }),
    setSessionName: name => {
      if (typeof name !== 'string') return unavailable();
      // 对齐 Pi SessionManager.appendSessionInfo：元数据行内化并去首尾空白后才进入 Durable。
      const normalized = name.replace(/[\r\n]+/g, ' ').trim();
      queue('name', { name: normalized }, reply => {
        if (!reply || !Array.isArray(reply.entries) || typeof reply.nameChanged !== 'boolean') return unavailable();
        applyEntriesSnapshot(reply.entries);
        if (reply.nameChanged) return runner.emit({ type: 'session_info_changed', name: sessionView?.getSessionName() });
      });
    }, getSessionName: () => sessionView?.getSessionName(),
    setLabel: (id, label) => queue('label', { id, label }),
    getActiveTools: () => [...active], getAllTools: allTools, getSettings: () => settings,
    setActiveTools: names => { active = [...new Set(names)]; syncTools(); }, refreshTools: syncTools,
    getCommands: () => runner.getRegisteredCommands(), setModel: unavailable,
    getThinkingLevel: () => state.thinkingLevel ?? 'off', setThinkingLevel: unavailable,
  }, {
    // Context模型与用量同属宿主帧；不能把只读模型引用变成项目扩展的写入口。
    getModel: () => state.model ? structuredClone(state.model) : undefined, getScopedModels: () => [], isIdle: () => calls.size === 0,
    isProjectTrusted: () => !closed, getSignal: () => calls.get(scopeOf())?.signal,
    abort: () => queue('abort', {}), hasPendingMessages: () => false, shutdown: () => queue('shutdown', {}),
    getContextUsage: readContextUsage, compact: options => { rpc('compact', { instructions: options?.customInstructions }, scopeOf()).then(() => options?.onComplete?.(), () => options?.onError?.(new Error('正式压缩未完成'))); },
    getSystemPrompt: () => state.systemPrompt, executeTool, getCallableTools: callables,
  }, { registerProvider: (provider,config) => {
      if (closed || invocation.getStore()?.pure || !scopeOf() || typeof provider!=='string') return unavailable();
      finiteDefinition(config);
      // JSON会删除undefined字段/值；须先核原始形状，不能将不支持字段抹去或把坏值变成合法清空。
      if (!config || typeof config!=='object' || Array.isArray(config) || Object.keys(config).some(key=>key!=='headers')
        || (config.headers!==undefined && (!config.headers || typeof config.headers!=='object' || Array.isArray(config.headers)
          || Object.values(config.headers).some(value=>typeof value!=='string')))) return unavailable();
      const handle='provider/' + (++serial);
      providerHandles.set(provider,handle); registration('provider-register',{provider,config,handle});
    }, registerNativeProvider: unavailable, unregisterProvider: provider => {
      if (closed || invocation.getStore()?.pure || !scopeOf() || typeof provider!=='string') return unavailable();
      const handle=providerHandles.get(provider);if(!handle)return;
      providerHandles.delete(provider);registration('provider-unregister',{provider,handle});
    },
    registerVirtualModel: definition => {
      if (closed || invocation.getStore()?.pure || !scopeOf()) return unavailable();
      if (!definition || typeof definition.route !== 'function') return unavailable();
      const {route,...metadata} = definition, handle = 'virtual/' + (++serial);
      finiteDefinition(metadata);
      const key = JSON.stringify([metadata.provider,metadata.id]), previous = virtualModels.get(key);
      if (previous) virtualHandles.delete(previous.handle);
      const own = {handle,definition}; virtualModels.set(key,own); virtualHandles.set(handle,own);
      registration('virtual-register',{handle,definition:metadata});
    },
    unregisterVirtualModel: (provider,id) => {
      if (closed || invocation.getStore()?.pure || !scopeOf()) return unavailable();
      const key=JSON.stringify([provider,id]), own=virtualModels.get(key); if(!own)return;
      virtualModels.delete(key);virtualHandles.delete(own.handle);
      registration('virtual-unregister',{provider,modelId:id,handle:own.handle});
    } });
  builtins = workerData.builtins; active = settingsManager.getDefaultTools() ?? builtins.map(t => t.name); syncTools();
  const sessionStartReason = ['startup', 'resume', 'reload'].includes(workerData.sessionStartReason)
    ? workerData.sessionStartReason : 'startup';
  await runner.emit({ type: 'session_start', reason: sessionStartReason });
  if (runner.hasHandlers('resources_discover')) {
    const resourcesDiscoverReason = sessionStartReason === 'reload' ? 'reload' : 'startup';
    const discovered = await runner.emitResourcesDiscover(workerData.cwd, resourcesDiscoverReason);
    const paths = (entries, skills = false) => {
      if (entries.length > 128) throw new Error('Resource count limit');
      return entries.map(entry => {
        const baseDir = entry.extensionPath.startsWith('<') ? workerData.cwd : path.dirname(entry.extensionPath);
        const file = path.resolve(baseDir, entry.path);
        if (![workerData.cwd, workerData.agentDir, appRoot].some(root => inside(root, file))) throw new Error('Resource outside authorized roots');
        inspect(file); resourceRoots.push(file);
        if (skills && file.endsWith('.md') && fs.statSync(file).isFile()) declaredSkills.add(fs.realpathSync(file));
        return {path:file,metadata:{source:'extension:'+entry.extensionPath,scope:'temporary',origin:'top-level',baseDir}};
      });
    };
    loader.extendResources({skillPaths:paths(discovered.skillPaths,true),promptPaths:paths(discovered.promptPaths)});
  }
  const finalSkills = loader.getSkills(), finalPrompts = loader.getPrompts();
  workerData.packageInstructions = sdk.formatSkillsForPrompt(finalSkills.skills);
  workerData.packagePrompts = finalPrompts.prompts.map(item => ({ name:item.name,content:item.content,filePath:item.filePath }));
  // MCP 普通装配的公开 before_agent_start 消费者在首次真实输入的事件中连接。
  await flush(); syncTools();
  if (errors.length) throw new Error('Extension startup failed');
  return { packageInstructions: workerData.packageInstructions, packagePrompts: workerData.packagePrompts, configuration:configuration() };
}
async function request(message) {
  if (message.method === 'close') {
    closed = true; for (const controller of calls.values()) controller.abort();
    const reasons = ['quit', 'reload', 'new', 'resume', 'fork'];
    const reason = reasons.includes(message.value?.reason) ? message.value.reason : 'quit';
    const scope = typeof message.scope === 'string' ? message.scope : 'lifecycle/shutdown';
    closingScopes.add(scope);
    let failed = false, failure;
    const rememberFailure = error => { if (!failed) { failed = true; failure = error; } };
    const settleAll = async operations => {
      for (const outcome of await Promise.allSettled(operations)) if (outcome.status === 'rejected') rememberFailure(outcome.reason);
    };
    try {
      if (runner) {
        // Durable owner 仍开放时发关闭事件；即使扩展回调失败，也排空已认领的同批正式记录后才交出 owner。
        await invocation.run({ id: scope, counter: 0, pure: false }, async () => {
          try { await runner.emit({ type: 'session_shutdown', reason }); } catch (error) { rememberFailure(error); }
          const drained = await flushClosingActions(scope);
          if (drained.failed) rememberFailure(drained.failure);
        });
      } else {
        const drained = await flushClosingActions(scope);
        if (drained.failed) rememberFailure(drained.failure);
      }
    } catch (error) { rememberFailure(error); }
    finally { parentPort.postMessage({ type: 'shutdown-flushed', scope }); }
    // Harness 此时才可关闭；之后继续完成实际 MCP 运输、既有 execute/model 请求和子进程收束，不让前面的扩展错误跳过清理。
    const finishing = [...executions].map(promise => promise.catch(() => undefined));
    const settling = [...modelPending.values()].flatMap(own => [...own]).map(promise => promise.catch(() => undefined));
    // 从真实 transport.start 起认领；client 尚在 connecting 也不能漏掉它。SDK 仍完成自己的清理。
    await settleAll([...transports].map(transport=>Promise.resolve().then(()=>transport.close())));
    // MCP调用可依赖transport关闭才结束；先发起真实close，再join，不让新流桥反锁既有MCP收束。
    await settleAll(finishing); await settleAll(settling);
    // 原生 SDK 关闭后，仍由本线程持有的实际子进程也必须终止；不按旧 PID 文本清理别人的进程。
    for (const child of children) if (child.exitCode === null) { try { child.kill(); } catch (error) { rememberFailure(error); } }
    await settleAll([...closings]);
    if (runner) { try { runner.invalidate(); } catch (error) { rememberFailure(error); } }
    forgetActions(scope,[...(actionsByScope.get(scope)??[])]);closingScopes.delete(scope);
    if (failed) throw failure;
    return {};
  }
  if (closed) throw new Error('Resources unavailable');
  if (message.state) {
    const frame = message.state.stateFrame;
    if (!Number.isSafeInteger(message.id) || message.id <= 0 || !frame || frame.requestId !== message.id
      || frame.sessionId !== workerData.sessionId || message.state.sessionId !== workerData.sessionId
      || frame.resourceEpoch !== workerData.resourceEpoch || frame.threadId !== threadId) throw new Error('Resource frame identity mismatch');
    if (message.id > lastStateRequest) {
      const minimumRevision = entriesRevision(state.entries);
      const olderEntries = entriesRevision(message.state.entries) < minimumRevision;
      // model和usage一起接收，unknown也覆盖旧数。requestId仅是传输顺序，不是Durable revision。
      state = { ...message.state, entries: state.entries, contextUsage: olderEntries ? undefined : message.state.contextUsage };
      applyEntriesSnapshot(message.state.entries, minimumRevision);
      lastStateRequest = message.id;
    }
    // 迟到旧state不能回滚模型／窗口；原operation仍按其原scope处理，不能当作重复任务丢弃。
  }
  if (message.method === 'init') return initialize();
  if (!runner) throw new Error('Resources unavailable');
  if (message.method === 'virtual-route') {
    const own=virtualHandles.get(message.value?.handle), controller=calls.get(message.scope);
    if(!own || !controller || controller.signal.aborted || message.value.request?.reason!=='direct')throw new Error('Virtual route unavailable');
    // loader包好的真实route在当前scope取得原ExtensionContext；只替本次request.signal，不换成会话messages。
    const route=await own.definition.route({...message.value.request,signal:controller.signal});
    if(closed || controller.signal.aborted || virtualHandles.get(own.handle)!==own)throw new Error('Virtual route expired');
    if(!route || typeof route.model?.provider!=='string' || typeof route.model?.id!=='string' || typeof route.thinkingLevel!=='string')throw new Error('Virtual route invalid');
    // 本片direct不消费branch state；有限引用让host重新取canonical物理对象，绝不把伪造端点/headers带回执行。
    return {provider:route.model.provider,modelId:route.model.id,thinkingLevel:route.thinkingLevel};
  }
  if(message.method==='arguments'){
    const tool=runner.getAllRegisteredTools().find(tool=>tool.definition.name===message.value.name);
    if(!tool)throw new Error('Tool unavailable');
    const value=tool.definition.prepareArguments?tool.definition.prepareArguments(message.value.arguments):message.value.arguments;
    if(value?.then)throw new Error('Argument preparation must be synchronous');
    return {arguments:safe(value)};
  }
  if (message.method === 'configuration') return {configuration:configuration()};
  if (message.method === 'input') {
    const text=typeof message.value.text==='string'?message.value.text:'';
    if(message.value.expandPromptTemplates===true&&text.startsWith('/')){
      const spaceIndex=text.indexOf(' '),name=spaceIndex===-1?text.slice(1):text.slice(1,spaceIndex),args=spaceIndex===-1?'':text.slice(spaceIndex+1);
      const command=runner.getCommand(name);
      if(command){
        try{await command.handler(args,commandContext());await flush();syncTools();return {action:'handled'};}
        catch(error){runner.emitError({extensionPath:'command:'+name,event:'command',error:error instanceof Error?error.message:String(error)});await flush();throw new Error('Extension command failed');}
      }
    }
    const source = message.value.source === 'extension' ? 'extension' : 'rpc';
    const result = await runner.emitInput(text, message.value.images, source, message.value.mode);
    await flush(); syncTools(); return result;
  }
  if (message.method === 'agent-start') {
    const result = await runner.emitBeforeAgentStart({messageType:'user',prompt:message.value.prompt,images:message.value.images}, {cwd:workerData.cwd,forceSystemPrompt:state.systemPrompt});
    await flush(); syncTools();
    const messages = [];
    const next = result.systemPromptOptions.forceSystemPrompt ?? state.systemPrompt;
    if (next !== state.systemPrompt) messages.unshift({role:'system',content:next,timestamp:Date.now()});
    return {messages,customMessages:result.messages};
  }
  if (message.method === 'provider-body') { const result = await runner.emitBeforeProviderRequest(message.value); await flush(); return result; }
  if (message.method === 'provider-headers') { const result = await runner.emitBeforeProviderHeaders(message.value); await flush(); return result; }
  if (message.method === 'before') {
    const result = await runner.emitToolCall({ type: 'tool_call', toolName: message.value.name,
      toolCallId: message.value.id, input: message.value.arguments }); await flush(); syncTools(); return result ?? {};
  }
  if (message.method === 'after') {
    const result = await runner.emitToolResult({ type: 'tool_result', toolName: message.value.name,
      toolCallId: message.value.id, input: message.value.arguments, ...message.value.result }); await flush(); return result ?? {};
  }
  if (message.method === 'context') {
    // 迟到state可丢，但当次请求正文必须独立保留；最新统计帧不能替代原Generation输入。
    if (!Array.isArray(message.value?.messages)) throw new Error('Original context messages unavailable');
    const messages = await runner.emitContext(message.value.messages); await flush(); syncTools(); return { messages };
  }
  if (message.method === 'execute') {
    const tool = runner.getAllRegisteredTools().find(t => t.definition.name === message.value.name);
    if (!tool || tool.definition.exposure === 'hidden') throw new Error('Tool unavailable');
    const controller = calls.get(message.scope) ?? new AbortController();
    try {
      return await sdk.wrapRegisteredTool(tool, runner).execute(message.value.id, message.value.arguments,
        controller.signal, value => parentPort.postMessage({ type: 'progress', callId: message.value.id, value: safe(value), scope:message.scope }));
    } catch(error) {
      // 原工具抛错也先取消并收束它已发起的请求；不能让费用在afterTool取样之后才落定。
      controller.abort();throw error;
    } finally {
      sealedModelScopes.add(message.scope);
      await Promise.all([...(modelPending.get(message.scope) ?? [])].map(pending => pending.catch(() => undefined)));
      await flush(); syncTools();
    }
  }
  throw new Error('Unknown resource request');
}
parentPort.on('message', message => {
  if (message.type === 'reply') { const pending = replies.get(message.id); if (!pending) return; replies.delete(message.id);
    if (message.ok) pending.resolve(message.value); else pending.reject(new Error('Formal host operation rejected')); return; }
  if (message.type === 'abort') { calls.get(message.callId)?.abort(); return; }
  if (message.type === 'model-event') {
    const record = modelStreams.get(message.actionId);
    // 入站 partial 只推进同 action/scope 仍活跃的当前流：taskId 是原 SDK child TaskId（正安全整数）首见认领后不变，seq 精确递增，终帧不入流。
    if (record && !record.settled && record.scope === message.scope && calls.has(message.scope)
      && Number.isSafeInteger(message.taskId) && message.taskId > 0
      && (record.taskId ?? message.taskId) === message.taskId
      && Number.isSafeInteger(message.seq) && message.seq === record.seq + 1
      && message.event && message.event.type !== 'done' && message.event.type !== 'error') {
      record.taskId = record.taskId ?? message.taskId;
      record.seq = message.seq;
      // 本地终态只采已通过本 action/scope/taskId/seq 验证的 partial 内容与用量，无效帧不取。
      record.partial = message.event.partial ?? record.partial;
      record.stream.push(message.event);
    }
    return;
  }
  const eventController = message.scope && message.method !== 'close' ? new AbortController() : undefined;
  if (eventController) calls.set(message.scope,eventController);
  const dispatched = Promise.resolve().then(() => invocation.run({id:message.scope,counter:0,pure:message.method==='arguments'||message.method==='virtual-route',readOnlyRoute:message.method==='virtual-route'}, () => request(message)));
  const settled = dispatched.then(value => {
    parentPort.postMessage({ type: 'result', id: message.id, ok: true, value: safe(value) });
    if (message.method === 'close') parentPort.close();
  }, () => parentPort.postMessage({ type: 'result', id: message.id, ok: false, code: 'resources-unavailable' })).finally(()=>{if(eventController && calls.get(message.scope) === eventController) {calls.delete(message.scope); modelPending.delete(message.scope); sealedModelScopes.delete(message.scope);}});
  // executions 只跟踪真实 execute 的完整派发（含回执与 scope 清理），finally 只移除自身；close 用它做真实 join，不含全局 actions、provider 回调或 close 自身。
  if (message.method === 'execute') { executions.add(settled); settled.then(() => executions.delete(settled), () => executions.delete(settled)); }
});
`;
