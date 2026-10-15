/** 普通 SDK 扩展在资源线程装配；消息端口只传有限 JSON，不另建智能体循环。 */
export const extensionWorkerSource = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { createHash } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const invocation = new AsyncLocalStorage();
const scopeOf = () => invocation.getStore()?.id;
const { syncBuiltinESMExports } = require('node:module');
let runner, sdk, sessionView, streamFactory, closed = false, state = { messages: [], systemPrompt: '', model: undefined };
const calls = new Map(), replies = new Map(), children = new Set(), closings = new Set(), transports = new Set();
const modelPending = new Map(), sealedModelScopes = new Set(), modelStreams = new Map(), executions = new Set();
const virtualModels = new Map(), virtualHandles = new Map();
let serial = 0, activated = new Set(), active = [], builtins = [], actions = [], errors = [];
const nativeSpawn = cp.spawn;
cp.spawn = (...args) => {
  if (closed) throw new Error('Resource session closed');
  const child = nativeSpawn(...args); children.add(child);
  const done = new Promise(resolve => child.once('close', () => { children.delete(child); closings.delete(done); resolve(); }));
  closings.add(done); return child;
};
syncBuiltinESMExports();
const safe = value => JSON.parse(JSON.stringify(value));
const rpc = (method, value, callId) => new Promise((resolve, reject) => {
  const id = ++serial; replies.set(id, { resolve, reject });
  parentPort.postMessage({ type: 'host', id, method, value: safe(value), callId });
});
const queue = (method, value) => { const current=invocation.getStore(); const scope=current?.id;
  if(current?.pure)throw new Error('Argument preparation must be pure');
  const result = rpc(method, { ...value, actionId: scope + '/' + (++current.counter) }, scope); result.catch(() => {}); actions.push(result); return result; };
const flush = async () => { const current = actions; actions = []; await Promise.all(current); };
const unavailable = () => { throw new Error('This operation requires the D Code formal interface'); };
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
  outputSchema: t.outputSchema, promptGuidelines: t.promptGuidelines, constrainedSampling: t.constrainedSampling, hasPrepareArguments: typeof t.prepareArguments === 'function',
}));
const allTools = () => [...builtins, ...metadata()];
const syncTools = () => {
  for (const t of metadata()) if (!activated.has(t.name)) { activated.add(t.name); if ((t.exposure === 'direct' || t.exposure === 'model-only') && t.defaultActive !== false && !active.includes(t.name)) active.push(t.name); }
  const registered = allTools().map(tool => ({...tool, execute:unavailable}));
  const declared = registered.filter(tool => active.includes(tool.name) && tool.exposure !== 'hidden' && tool.exposure !== 'codemode');
  const callable = registered.filter(tool => tool.exposure === 'codemode' || tool.exposure === 'deferred' || (tool.exposure === 'direct' && active.includes(tool.name)));
  const descriptions = {}, hidden = new Set();
  const loadout = {declared,callable,registered,getExposure:name=>allTools().find(t=>t.name===name)?.exposure ?? 'direct',getNamespace:name=>allTools().find(t=>t.name===name)?.namespace};
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
async function initialize() {
  sdk = await import(workerData.sdk);
  // SDK 单条 abort 会异步发送取消；同线程连接关闭须先等这条真实通知完成，不能先 abort 全运输。
  const {findPackageJSON}=require('node:module'),{pathToFileURL}=require('node:url');
  const mcpPackage=findPackageJSON('@earendil-works/pi-mcp',workerData.sdk);
  const manifest=JSON.parse(fs.readFileSync(mcpPackage,'utf8'));
  if(manifest.version!=='1.0.0'||typeof manifest.exports?.['.']?.import!=='string')throw new Error('MCP public entry unavailable');
  const transportPort=await import(pathToFileURL(path.resolve(path.dirname(mcpPackage),manifest.exports['.'].import)).href);
  const notifications=new WeakMap(),closedTransports=new WeakMap();
  for(const Transport of [transportPort.StreamableHttpTransport,transportPort.StdioTransport]){
    const send=Transport.prototype.send,close=Transport.prototype.close,start=Transport.prototype.start;
    Transport.prototype.start=function(){if(closed)throw new Error('Resource session closed');transports.add(this);return start.call(this);};
    Transport.prototype.send=function(message){
      const flight=send.call(this,message);
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
        await close.call(this);await Promise.allSettled(pending);transports.delete(this);
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
  for (const name of ['stream', 'streamSimple', 'complete', 'completeSimple', 'classify', 'generateImages', 'getApiKeyAndHeaders', 'getProviderAuth', 'getApiKeyForProvider', 'registerProvider', 'unregisterProvider', 'registerVirtualModel', 'unregisterVirtualModel']) modelRegistry[name] = unavailable;
  // 同步兼容 facade 只读本次宿主发布的完整 chat 帧，不另查认证、不从当前模型猜目录。
  modelRegistry.getAll = () => safe(state.modelCatalog?.all ?? []);
  modelRegistry.getAvailable = () => safe(state.modelCatalog?.available ?? []);
  modelRegistry.find = (provider, id) => {
    const model = state.modelCatalog?.all.find(model => model.provider === provider && model.id === id);
    return model ? safe(model) : undefined;
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
  modelRegistry.streamSimple = (model, input, options = {}) => {
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
    const hostCall = rpc('model-stream', { caller: scope, actionId, provider: model.provider, modelId: model.id, input, options: parameters }, scope);
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
  sessionView = sdk.SessionManager.inMemory(workerData.cwd, { id: state.sessionId }); refreshSession();
  const readMethods = new Set(['getCwd','getSessionDir','getSessionId','getSessionFile','getLeafId','getLeafEntry','getEntry','getLabel','getBranch','buildContextEntries','buildSessionProjection','getHeader','getEntries','getTree','getSessionName']);
  const sessionManager = new Proxy(sessionView, { get(target, key) {
    if (!readMethods.has(key)) return unavailable;
    return (...args) => sessionView[key](...args);
  } });
  runner = new sdk.ExtensionRunner(loaded.extensions, loaded.runtime, workerData.cwd, sessionManager, modelRegistry);
  runner.onError(() => errors.push('extension-event-failed'));
  const registration = (method, payload) => {
    if (closed || invocation.getStore()?.pure || !scopeOf()) return unavailable();
    // SDK的注册API返回void；在原资源/事件flush处等宿主确认，不能先把本地函数表当可用目录。
    const pending = rpc(method, payload, scopeOf()).then(reply => { state.modelCatalog = reply.catalog; });
    pending.catch(() => {}); actions.push(pending);
  };
  runner.bindCore({
    sendMessage: (message, options) => queue('message', { message, options }),
    sendUserMessage: (content, options) => queue('user', { content, options }),
    appendEntry: (customType, data) => queue('entry', { customType, data }),
    setSessionName: name => queue('name', { name }), getSessionName: () => sessionView?.getSessionName(),
    setLabel: (id, label) => queue('label', { id, label }),
    getActiveTools: () => [...active], getAllTools: allTools, getSettings: () => settings,
    setActiveTools: names => { active = [...new Set(names)]; syncTools(); }, refreshTools: syncTools,
    getCommands: () => runner.getRegisteredCommands(), setModel: unavailable,
    getThinkingLevel: () => state.thinkingLevel ?? 'off', setThinkingLevel: unavailable,
  }, {
    getModel: () => state.model, getScopedModels: () => [], isIdle: () => calls.size === 0,
    isProjectTrusted: () => !closed, getSignal: () => calls.get(scopeOf())?.signal,
    abort: () => queue('abort', {}), hasPendingMessages: () => false, shutdown: () => queue('shutdown', {}),
    getContextUsage: () => undefined, compact: options => { rpc('compact', { instructions: options?.customInstructions }, scopeOf()).then(() => options?.onComplete?.(), () => options?.onError?.(new Error('正式压缩未完成'))); },
    getSystemPrompt: () => state.systemPrompt, executeTool, getCallableTools: callables,
  }, { registerProvider: unavailable, registerNativeProvider: unavailable, unregisterProvider: unavailable,
    registerVirtualModel: definition => {
      if (closed || invocation.getStore()?.pure || !scopeOf()) return unavailable();
      if (!definition || typeof definition.route !== 'function') return unavailable();
      const {route,...metadata} = definition, handle = 'virtual/' + (++serial);
      const seen=new Set();const check=value=>{
        if(value===undefined||value===null||typeof value==='string'||typeof value==='boolean'||(typeof value==='number'&&Number.isFinite(value)))return;
        if(!value||typeof value!=='object'||seen.has(value)||(!Array.isArray(value)&&Object.getPrototypeOf(value)!==Object.prototype))throw new Error('Invalid virtual model metadata');
        seen.add(value);Object.values(value).forEach(check);seen.delete(value);
      };check(metadata);
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
  await runner.emit({ type: 'session_start', reason: 'startup' });
  if (runner.hasHandlers('resources_discover')) {
    const discovered = await runner.emitResourcesDiscover(workerData.cwd, 'startup');
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
    // close 先等既有 execute 及其 modelPending 的 host RPC 真实结算，再回 close reply／关端口，防 Root terminate 抢杀流消费者收尾；不 join 全局 actions 或 provider 回调。
    const finishing = [...executions].map(promise => promise.catch(() => undefined));
    const settling = [...modelPending.values()].flatMap(own => [...own]).map(promise => promise.catch(() => undefined));
    // 从真实 transport.start 起认领；client 尚在 connecting 也不能漏掉它。SDK 仍完成自己的清理。
    await Promise.all([...transports].map(transport=>transport.close()));
    // MCP调用可依赖transport关闭才结束；先发起真实close，再join，不让新流桥反锁既有MCP收束。
    await Promise.all(finishing); await Promise.all(settling);
    if (runner) { await runner.emit({ type: 'session_shutdown' }); runner.invalidate(); }
    // 原生 SDK 关闭后，仍由本线程持有的实际子进程也必须终止；不按旧 PID 文本清理别人的进程。
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all([...closings]);
    return {};
  }
  if (closed) throw new Error('Resources unavailable');
  if (message.state) {
    state = message.state;
    refreshSession();
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
    const result = await runner.emitInput(message.value.text, message.value.images, 'rpc', message.value.mode);
    await flush(); syncTools(); return result;
  }
  if (message.method === 'agent-start') {
    const result = await runner.emitBeforeAgentStart(message.value.prompt, message.value.images, {cwd:workerData.cwd,forceSystemPrompt:state.systemPrompt});
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
    const messages = await runner.emitContext(state.messages); await flush(); syncTools(); return { messages };
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
