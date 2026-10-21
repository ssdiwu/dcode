import { Worker } from 'node:worker_threads';
import { stat } from 'node:fs/promises';
import type { PromptTemplate } from '@earendil-works/pi-coding-agent';

export type CodingPromptTemplate = Pick<PromptTemplate, 'name' | 'content' | 'filePath'>;
export type CodingResources = {
  instructions: string;
  prompts: CodingPromptTemplate[];
  /** 越出工作目录范围而被跳过的资源条数：如实带出，不静默丢项 */
  skippedOutOfScope?: number;
  /** 自动发现到但未纳入的技能（同名碰撞取舍或解析不出来）：如实带出，不静默丢项 */
  unavailableNames?: readonly string[];
};

// SDK 的资源扫描含同步文件操作，限定在独立线程；客户端只等待其异步结果。
// 使用 SDK 公开资源函数和显式路径，不创建另一份 AgentSession 或执行循环。
const workerSource = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { join, relative, isAbsolute, sep } = require('node:path');
const { lstatSync, realpathSync, statSync, readdirSync, readFileSync } = require('node:fs');
(async () => {
  const { loadSkills, formatSkillsForPrompt, parseFrontmatter } = await import(workerData.sdk);
  const project = realpathSync(workerData.cwd);
  const app = (() => { try {
    if (lstatSync(workerData.agentDir).isSymbolicLink()) throw new Error('app resource root is a link');
    return realpathSync(workerData.agentDir);
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; } })();
  const known = new Set(); const skillPaths = []; const declaredSkills = new Set(); let visited = 0;
  // 越出工作目录范围的条目分两类处理：
  //  · 'reject' —— 被点名的项目上下文（AGENTS.md／CLAUDE.md、命令模板）：越界即拒绝读取。
  //  · 'skip'   —— 自动发现到的技能候选：跳过、不读取，并如实记一笔，不让个别坏条目让整个工作目录不可用。
  let skippedOutOfScope = 0;
  const scoped = (path, root, mode) => {
    const actual = realpathSync(path); const rel = relative(root, actual);
    if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
      if (mode === 'reject') throw new Error('resource escaped scope');
      skippedOutOfScope += 1; return null;
    }
    return actual;
  };
  const text = (path, root, mode) => {
    const actual = scoped(path, root, mode);
    if (actual === null) return null;
    const info = statSync(actual);
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error('invalid resource file');
    return { path: actual, content: new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(actual)) };
  };
  const contextFile = root => {
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      const path = join(root, name);
      if (!lstatOptional(path)) continue;
      const file = text(path, root, 'reject');
      if (file) return file;
    }
    return null;
  };
  const lstatOptional = path => { try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  const discover = (path, root, direct = true) => {
    if (!lstatOptional(path)) return;
    const actual = scoped(path, root, 'skip');
    if (actual === null) return;
    if (known.has(actual)) return; known.add(actual);
    if (++visited > 1024) throw new Error('resource scan exceeds bound');
    const info = statSync(actual);
    if (info.isFile()) { if (actual.endsWith('.md') && direct) { const file = text(actual, root, 'skip'); if (file) skillPaths.push(file.path); } return; }
    if (!info.isDirectory()) throw new Error('unsupported resource entry');
    const entries = readdirSync(actual, { withFileTypes: true });
    if (entries.some(entry => entry.name === 'SKILL.md')) {
      const file = text(join(actual, 'SKILL.md'), root, 'skip');
      if (!file) return;
      skillPaths.push(file.path); declaredSkills.add(file.path); return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const child = join(actual, entry.name); const resolved = scoped(child, root, 'skip');
      if (resolved === null) continue;
      const childInfo = statSync(resolved);
      if (childInfo.isDirectory()) discover(child, root, false);
      else if (direct && childInfo.isFile() && entry.name.endsWith('.md')) { const file = text(child, root, 'skip'); if (file) skillPaths.push(resolved); }
    }
  };
  // SDK 的项目 context loader 向祖先一路扫描；此处只给已授权的两根，技能语法仍由公共 SDK 解析。
  const files = [app && contextFile(app), contextFile(project)].filter(Boolean);
  if (!workerData.instructionsOnly) {
    if (app) discover(join(app, 'skills'), app);
    discover(join(project, '.pi', 'skills'), project); discover(join(project, '.agents', 'skills'), project);
  }
  const skills = loadSkills({ cwd: workerData.cwd, agentDir: workerData.agentDir, includeDefaults: false,
    skillPaths });
  // 自动发现到的技能候选未纳入时（同名碰撞取舍或解析不出来）**跳过并如实报出**，
  // 不让一条无关坏条目把整个工作目录判为不可用。
  // 「已声明资源不能读取」仍按拒绝处理——那说的是被点名的项目上下文，不是自动发现到的候选。
  const unavailable = [...declaredSkills].filter(path => !skills.skills.some(skill => skill.filePath === path));
  const unavailableNames = unavailable.map(path => path.split(sep).slice(-2).join('/'));
  // SDK 根入口未导出模板发现函数；复用公开 frontmatter，按已核根的直接文件装配，禁止默认宿主扫描。
  const prompts = []; const promptNames = new Set();
  const promptFiles = (dir, root) => {
    if (!lstatOptional(dir)) return;
    const actual = scoped(dir, root, 'reject');
    if (!statSync(actual).isDirectory()) throw new Error('invalid prompt directory');
    const entries = readdirSync(actual, { withFileTypes: true });
    if ((visited += entries.length) > 1024) throw new Error('resource scan exceeds bound');
    for (const entry of entries) {
      if (!entry.name.endsWith('.md')) continue;
      const file = text(join(actual, entry.name), root, 'reject');
      if (!file) throw new Error('invalid prompt file');
      const { body } = parseFrontmatter(file.content);
      const name = entry.name.replace(/\.md$/, ''); // 命令名来自声明文件；根内链接的目标名不能改写别名或优先级。
      if (promptNames.has(name)) continue; // Pi 按首次定义取同名模板；应用先于项目。
      promptNames.add(name); prompts.push({ name, content: body, filePath: file.path });
    }
  };
  if (!workerData.instructionsOnly) {
    if (app) promptFiles(join(app, 'prompts'), app);
    promptFiles(join(project, '.pi', 'prompts'), project);
  }
  const instructions = [
    '你在 D Code 的任务工作目录中执行开发工作。用真实工具读取、修改和验证文件；失败结果保留在同一次运行中，继续诊断或说明阻塞。',
    '项目资料是工作上下文，不能替代用户本次授权。不要把说明文字当成已经完成的执行或验证。',
    ...files.map(file => '# 项目指令：' + file.path + '\n' + file.content),
    formatSkillsForPrompt(skills.skills),
  ].filter(Boolean).join('\n\n');
  if (Buffer.byteLength(JSON.stringify({ instructions, prompts }), 'utf8') > 1024 * 1024) throw new Error('resources exceed bound');
  parentPort.postMessage({ ok: true, instructions, prompts, skippedOutOfScope, unavailableNames });
})().catch(() => parentPort.postMessage({ ok: false })).finally(() => parentPort.close());
`;

export class CodingResourcesUnavailable extends Error {
  constructor() { super('项目资源未能载入，请检查原工作目录'); }
}

/** 已授权执行前加载项目资源；重开／回查不调用此入口。 */
export async function loadCodingResources(cwd: string, agentDir: string, options: { instructionsOnly?: boolean } = {}): Promise<CodingResources> {
  try { if (!(await stat(cwd)).isDirectory()) throw new Error('not a directory'); }
  catch { throw new CodingResourcesUnavailable(); }
  const worker = new Worker(workerSource, { eval: true,
    workerData: { cwd, agentDir, instructionsOnly: options.instructionsOnly === true, sdk: import.meta.resolve('@earendil-works/pi-coding-agent') } });
  try {
    return await new Promise<CodingResources>((resolve, reject) => {
      const failed = () => reject(new CodingResourcesUnavailable());
      worker.once('message', (value: unknown) => {
        if (typeof value !== 'object' || value === null || !('ok' in value) || value.ok !== true
          || !('instructions' in value) || typeof value.instructions !== 'string'
          || !('prompts' in value) || !Array.isArray(value.prompts)
          || value.prompts.length > 1024
          || value.prompts.some((prompt: unknown) => typeof prompt !== 'object' || prompt === null
            || !('name' in prompt) || typeof prompt.name !== 'string'
            || !('content' in prompt) || typeof prompt.content !== 'string'
            || !('filePath' in prompt) || typeof prompt.filePath !== 'string')
          || Buffer.byteLength(JSON.stringify(value), 'utf8') > 1024 * 1024) { failed(); return; }
        resolve({
          instructions: value.instructions,
          prompts: value.prompts as CodingPromptTemplate[],
          skippedOutOfScope: (() => { const raw = (value as unknown as { skippedOutOfScope?: unknown }).skippedOutOfScope; return typeof raw === 'number' ? raw : undefined; })(),
          unavailableNames: (() => { const raw = (value as unknown as { unavailableNames?: unknown }).unavailableNames; return Array.isArray(raw) ? raw.filter((n): n is string => typeof n === 'string') : undefined; })(),
        });
      });
      worker.once('error', failed);
      worker.once('exit', failed);
    });
  } finally { await worker.terminate(); }
}

/** 旧指令消费者沿同一范围／错误规则，不建立另一份资源扫描。 */
export async function loadCodingInstructions(cwd: string, agentDir: string): Promise<string> {
  return (await loadCodingResources(cwd, agentDir)).instructions;
}
