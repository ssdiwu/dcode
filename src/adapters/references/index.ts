/**
 * 引用读取适配器：发现当前会话工作空间里的真实文件与已接技能，并读取引用快照。
 *
 * 边界：
 * - 只读。不发送、不开始执行、不安装任何东西、不新增成员授权。
 * - 只认该会话工作空间绑定的文件夹，不上溯父目录，不并入其他来源或全局技能。
 * - 技能发现只经 `@earendil-works/pi-coding-agent` 的**公开根**导出 `loadSkillsFromDir`，
 *   懒加载；不使用 DefaultResourceLoader（它会先解析包并在缺包时自动安装），
 *   不访问 SDK 私有子路径，也不复制它的发现规则。
 * - 界面不直连本模块：一切经 preload 桥与接收侧校验。
 */
import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ReferenceCandidate, ReferenceIssue, ReferenceKind, ReferenceListing, WorkReference } from '@/contracts/index.ts';
import { isReferenceLocator } from '@/contracts/index.ts';
import type { ReferencePort, ReferenceRequest } from '@/application/index.ts';

/** 单个引用快照的上限：超过只取前缀并标 truncated，绝不静默当成完整内容。 */
export const REFERENCE_BYTE_LIMIT = 256 * 1024;
/** 目录遍历的硬上限，防止把超大工作空间一次读空。 */
const MAX_ENTRIES = 4000;
const MAX_DEPTH = 8;
/** 浮层里每类最多列出多少项；超出在 issues 里说明被截断，不静默丢弃。 */
const MAX_LISTED_PER_KIND = 200;

const SKILL_DIR = join('.pi', 'skills');

/** 默认忽略项：版本库、依赖、构建产物与本项目证据目录都不是"工作空间文件"。 */
const IGNORED_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'dist', 'out', 'build', 'coverage',
  '.next', '.turbo', '.cache', '.venv', '__pycache__', 'evidence',
]);

/** 可捕获为文本的扩展名白名单之外一律按不可引用处理，避免把二进制塞进上下文。 */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.pdf', '.zip', '.gz', '.tar',
  '.7z', '.rar', '.mp3', '.mp4', '.mov', '.wav', '.webm', '.woff', '.woff2', '.ttf',
  '.otf', '.eot', '.exe', '.dll', '.so', '.dylib', '.class', '.jar', '.wasm', '.bin', '.db',
]);

/** 浮层里仍然展示、但按文本读取也可能不合适的二进制后缀（读取时才判）。 */
const REFERENCE_ISSUES = {
  workspaceUnbound: (): ReferenceIssue => ({ code: 'workspace-unbound', message: '该任务未绑定工作文件夹' }),
  outsideRoot: (): ReferenceIssue => ({ code: 'outside-root', message: '引用目标不在本工作空间内' }),
  notFound: (): ReferenceIssue => ({ code: 'not-found', message: '目标已不存在或已被移动' }),
  unreadable: (): ReferenceIssue => ({ code: 'unreadable', message: '目标无法读取' }),
  permissionDenied: (): ReferenceIssue => ({ code: 'permission-denied', message: '没有读取该目标的权限' }),
  tooLarge: (size: number, limit: number): ReferenceIssue => ({
    code: 'too-large',
    message: `目标 ${size} 字节，超出可引用上限 ${limit} 字节`,
  }),
  binary: (): ReferenceIssue => ({ code: 'binary', message: '目标是二进制内容，不能作为文本引用' }),
  skillsUnavailable: (): ReferenceIssue => ({ code: 'skills-unavailable', message: '技能发现能力当前不可用' }),
} as const;

/** 带原因码的读取失败：应用层据此形成失败回执，不产生半成品引用。 */
export class ReferenceCaptureError extends Error {
  readonly code: ReferenceIssue['code'];
  constructor(code: ReferenceIssue['code'], message: string) {
    super(message);
    this.name = 'ReferenceCaptureError';
    this.code = code;
  }
}

/** `~` 与相对路径只在宿主解析；界面给的永远是工作空间内的相对定位。 */
function expandFolder(folder: string): string {
  if (folder === '~') return homedir();
  if (folder.startsWith('~/')) return join(homedir(), folder.slice(2));
  return resolve(folder);
}

/**
 * 工作空间的每个绑定文件夹都是一个**正式根**，各带一个稳定身份（根序号）。
 * 身份进入定位前缀，因此不同根下的同名相对路径可区分；只取第一个根会让其余已绑定
 * 文件夹完全没有入口，这里逐个解析并保留。
 *
 * 序号取**绑定列表里的位置**，不是成功解析的数量：某个根失效（被删、不可达、不是目录）
 * 时，后面的根必须留在自己的位置上。按成功数编号会让后一个根前移，于是上一轮列出的
 * `r0/x` 会在下一轮指向另一个根的 `x`——用旧定位读到别的文件，比读不到更糟。
 */
type Root = { key: string; path: string };

/** 越界入口预审的预算：审不完就整体拒绝，不做"大概没事"的推断。 */
const MAX_SKILL_AUDIT_DEPTH = 6;
const MAX_SKILL_AUDIT_ENTRIES = 4000;

async function resolveRoots(folders: readonly string[]): Promise<readonly Root[]> {
  const roots: Root[] = [];
  for (const [index, folder] of folders.entries()) {
    const candidate = expandFolder(folder);
    try {
      const info = await stat(candidate);
      if (!info.isDirectory()) continue;
      roots.push({ key: `r${index}`, path: await realpath(candidate) });
    } catch {
      // 该根此刻不可用：保留它的位置（后续根不前移），本轮不产出它的任何定位。
      continue;
    }
  }
  return roots;
}

/** 定位里带根身份前缀；按它找回所属根，不靠"第一个目录"这种隐含约定。 */
function splitLocator(locator: string): { rootKey: string; relative: string } | null {
  const slash = locator.indexOf("/");
  if (slash <= 0) return null;
  const rootKey = locator.slice(0, slash);
  const relative = locator.slice(slash + 1);
  if (!/^r\d+$/.test(rootKey) || relative.length === 0) return null;
  return { rootKey, relative };
}

/** 根边界核对：区分「越出根」与「根内但读不到」——两者是不同的事实，不能混报。 */
async function resolveWithinRoot(
  root: string,
  locator: string,
): Promise<{ ok: true; absolute: string } | { ok: false; reason: 'outside-root' | 'not-found' }> {
  const split = splitLocator(locator);
  if (!split || !isReferenceLocator(split.relative)) return { ok: false, reason: 'outside-root' };
  const absolute = resolve(root, split.relative);
  const rel = relative(root, absolute);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return { ok: false, reason: 'outside-root' };
  let real: string;
  try {
    real = await realpath(absolute);
  } catch {
    // 根内定位但解析不到：目标确实不存在或不可达，如实报 not-found，不谎称越界。
    return { ok: false, reason: 'not-found' };
  }
  const realRel = relative(root, real);
  if (realRel === '' || realRel.startsWith('..') || isAbsolute(realRel)) return { ok: false, reason: 'outside-root' };
  return { ok: true, absolute: real };
}

function isIgnored(name: string): boolean {
  return IGNORED_DIRS.has(name) || name.startsWith('.') && name !== '.pi';
}

/** 把 Buffer 截到完整字符边界：避免把多字节序列切成乱码。 */
function decodeBounded(buffer: Buffer, limit: number): { text: string; truncated: boolean } {
  if (buffer.byteLength <= limit) return { text: buffer.toString('utf8'), truncated: false };
  const slice = buffer.subarray(0, limit);
  let end = slice.byteLength;
  // UTF-8 续字节形如 10xxxxxx；从末尾回退到字符起点。
  while (end > 0 && (slice[end - 1] & 0xc0) === 0x80) end -= 1;
  if (end > 0) end -= 1;
  return { text: slice.subarray(0, Math.max(end, 0)).toString('utf8'), truncated: true };
}

async function walkFiles(root: Root): Promise<{ files: ReadonlyArray<{ relative: string; label: string }>; truncated: boolean }> {
  const found: Array<{ relative: string; label: string }> = [];
  let truncated = false;
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root.path, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    if (current.depth >= MAX_DEPTH) continue;
    let entries;
    try {
      entries = await readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (found.length >= MAX_ENTRIES) {
        truncated = true;
        queue.length = 0;
        break;
      }
      const absolute = join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (isIgnored(entry.name)) continue;
        queue.push({ dir: absolute, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      const locator = relative(root.path, absolute).split(sep).join('/');
      if (locator.startsWith('.pi/')) continue;
      // 根身份与来源身份留到 list 统一拼装，这里只产出根内相对路径与展示名。
      found.push({ relative: locator, label: entry.name });
    }
  }
  found.sort((a, b) => a.relative.localeCompare(b.relative));
  return { files: found, truncated };
}

/**
 * 越界入口预审结论：`null` = 预算内审完且没有越界入口；否则是**真实原因**。
 * 审不完（读不到、无权限、超预算、层级超限）**不等于**越界，也不是安全——四种都各自成因，
 * 不能一律报成 `outside-root`，否则真实的可修原因会被伪装成"有东西跑出去了"。
 */
type SkillAuditStop = Readonly<{ code: 'outside-root' | 'unreadable' | 'permission-denied' | 'too-large'; message: string }>;

/** stat 接缝：默认 fs.stat；测试可注入可辨的元数据读取失败（与 pi 会话的 openStorage 同一性质的测试接缝）。 */
export type StatLike = (path: string) => Promise<{ isDirectory(): boolean }>;

const errnoOf = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code) : undefined;

/**
 * 越界入口预审：必须在 SDK 遍历**之前**跑完。
 *
 * `.pi/skills` 本身核过根还不够——SDK 会继续跟随它内部的目录符号链接，也会读 `SKILL.md`；
 * 只要里面有一个逃出工作空间根的链接，正文就已经在发现阶段被读走了，事后过滤 SDK 输出太晚。
 *
 * 这里不复制 SDK 的发现规则（不判断"什么算技能"、不读 frontmatter、不装任何东西），
 * 只做边界判定。
 *
 * 两条判定规则不能混：
 *  · **符号链接**先 realpath 定界。指向根内的**文件**链接到此为止——内容就是它自己，
 *    边界已经核过，不需要也不该对它再做目录递归（对文件 readdir 只会得到 ENOTDIR，
 *    把合法文件链接误判成"读不到"是错的）；指向根内的**目录**链接才继续审它里面的条目。
 *  · **目录读不到就是没审完**，不是"审过且干净"。目录被预审跳过，SDK 会照着走进去。
 */
async function auditSkillEntries(
  rootPath: string,
  dir: string,
  depth: number,
  budget: { left: number },
  seen: Set<string>,
  statFn: StatLike,
): Promise<SkillAuditStop | null> {
  if (depth > MAX_SKILL_AUDIT_DEPTH) {
    return { code: 'too-large', message: `技能目录层级超过 ${MAX_SKILL_AUDIT_DEPTH}，未能审完，已跳过全部技能` };
  }
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    const where = relative(rootPath, dir);
    if (errnoOf(error) === 'EACCES' || errnoOf(error) === 'EPERM') {
      return { code: 'permission-denied', message: `技能目录无读取权限（${where}），未能审完，已跳过全部技能` };
    }
    return { code: 'unreadable', message: `技能目录无法读取（${where}），未能审完，已跳过全部技能` };
  }
  for (const entry of entries) {
    budget.left -= 1;
    if (budget.left < 0) return { code: 'too-large', message: `技能目录条目超过 ${MAX_SKILL_AUDIT_ENTRIES}，未能审完，已跳过全部技能` };
    const absolute = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      let real: string;
      try {
        real = await realpath(absolute);
      } catch (error) {
        // 断链读不到任何内容，不构成越界；其余解析失败（权限、环路）判不出指向，同样不能放行。
        if (errnoOf(error) === 'ENOENT') continue;
        return { code: 'unreadable', message: `技能链接无法解析（${relative(rootPath, absolute)}），未能审完，已跳过全部技能` };
      }
      const rel = relative(rootPath, real);
      if (rel.startsWith('..') || isAbsolute(rel)) {
        return { code: 'outside-root', message: `技能目录存在指向工作空间之外的链接（${relative(rootPath, absolute)}），已跳过全部技能` };
      }
      // 链接指向工作空间根本身：已经跳出技能子树，不是"越出工作空间"，但预算内审不完——
      // 说成 outside-root 是撒谎（它确实在根内），说成审完同样是撒谎。
      if (rel === '') {
        return { code: 'too-large', message: `技能链接指向工作空间根（${relative(rootPath, absolute)}），已跳出可审范围，未能审完，已跳过全部技能` };
      }
      // 读不出链接目标的元数据就是**没审完**，不是"当作目录"也不是"当作安全"：
      // 按真实成因给出可辨原因。ENOENT 沿用既定断链策略（读不到任何内容，跳过即可），
      // 其余一律整体不进入 SDK——判不出类型就没有资格说这个链接安全。
      let isDir: boolean;
      try {
        isDir = (await statFn(real)).isDirectory();
      } catch (error) {
        if (errnoOf(error) === 'ENOENT') continue;
        const where = relative(rootPath, absolute);
        if (errnoOf(error) === 'EACCES' || errnoOf(error) === 'EPERM') {
          return { code: 'permission-denied', message: `技能链接目标无读取权限（${where}），未能审完，已跳过全部技能` };
        }
        return { code: 'unreadable', message: `技能链接目标无法读取（${where}），未能审完，已跳过全部技能` };
      }
      if (!isDir) continue;
      // 已审过同一处就不再重入：根内链接环会反复指向同一目录，重入只会耗尽深度预算，
      // 把一个安全结构误报成"层级超限"，并丢掉本来合法的技能。
      if (seen.has(real)) continue;
      seen.add(real);
      const nested = await auditSkillEntries(rootPath, real, depth + 1, budget, seen, statFn);
      if (nested) return nested;
      continue;
    }
    if (entry.isDirectory()) {
      if (seen.has(absolute)) continue;
      seen.add(absolute);
      const nested = await auditSkillEntries(rootPath, absolute, depth + 1, budget, seen, statFn);
      if (nested) return nested;
    }
  }
  return null;
}

/**
 * 技能发现：懒加载公共根并只对受控技能目录调用 `loadSkillsFromDir`。
 * 返回的 Skill 是纯数据（无类实例），可在进程边界上结构化传递。
 */
async function discoverSkills(root: Root, statFn: StatLike): Promise<{ skills: ReferenceCandidate[]; issues: ReferenceIssue[] }> {
  const issues: ReferenceIssue[] = [];
  const declared = join(root.path, SKILL_DIR);
  try {
    const info = await stat(declared);
    if (!info.isDirectory()) return { skills: [], issues };
  } catch {
    // 没有技能目录是正常的"本工作空间未装技能"，不是失败。
    return { skills: [], issues };
  }
  // 交给 SDK 读之前先核根：`.pi/skills` 是符号链接时，SDK 会顺着它读到工作空间之外。
  // 这里只守边界，不复制 SDK 的发现规则，也不重新引入它的包解析/自动安装路径。
  let skillsDir: string;
  try {
    skillsDir = await realpath(declared);
  } catch {
    issues.push({ code: 'unreadable', message: '技能目录无法解析，已跳过' });
    return { skills: [], issues };
  }
  const rel = relative(root.path, skillsDir);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    issues.push({ code: 'outside-root', message: '技能目录指向工作空间之外，已跳过' });
    return { skills: [], issues };
  }
  // 内部越界入口预审：审到越界链接、或者**没审完**（读不到／无权限／超预算），都整体不调用 SDK。
  // 宁可这次没有技能，也不能让越界或未知内容在发现阶段被读走；原因按真实成因分别报告。
  const escape = await auditSkillEntries(root.path, skillsDir, 0, { left: MAX_SKILL_AUDIT_ENTRIES }, new Set([skillsDir]), statFn);
  if (escape) {
    issues.push({ code: escape.code, message: escape.message });
    return { skills: [], issues };
  }
  try {
    const sdk = await import('@earendil-works/pi-coding-agent');
    const result = sdk.loadSkillsFromDir({ dir: skillsDir, source: 'workspace' });
    // 第二层：预审已经挡掉越界入口，这里再核一次每个技能文件确实在根内，
    // 不把"结果里出现的路径"直接当成可信定位。
    const skills: ReferenceCandidate[] = [];
    for (const skill of result.skills) {
      const inside = relative(root.path, await realpath(skill.filePath).catch(() => skill.filePath));
      if (inside.startsWith('..') || isAbsolute(inside)) {
        issues.push({ code: 'outside-root', message: `技能 ${skill.name} 指向工作空间之外，已跳过` });
        continue;
      }
      skills.push({
        kind: 'skill' as const,
        label: skill.name,
        // 带根身份：不同绑定根下的同名技能也可区分
        locator: `${root.key}/${inside.split(sep).join('/')}`,
        sourceId: `skill:${skill.name}`,
        detail: skill.description,
      });
    }
    for (const diagnostic of result.diagnostics) {
      // 诊断按 SDK 自己的 type 分级呈现；message 是 SDK 给的短句，不含宿主路径栈。
      issues.push({ code: 'skills-unavailable', message: `技能${diagnostic.type}：${diagnostic.message}` });
    }
    return { skills, issues };
  } catch {
    issues.push(REFERENCE_ISSUES.skillsUnavailable());
    return { skills: [], issues };
  }
}

export interface ReferencePortOptions {
  /** 测试接缝：替换链接目标的 stat，用于注入可辨的元数据读取失败。缺省用 fs.stat，正常路径行为不变。 */
  stat?: StatLike;
}

export class NodeReferencePort implements ReferencePort {
  readonly #stat: StatLike;

  constructor(options: ReferencePortOptions = {}) {
    this.#stat = options.stat ?? ((path) => stat(path));
  }

  async list(request: ReferenceRequest): Promise<ReferenceListing> {
    const scope = { workspaceId: request.workspaceId, sessionId: request.sessionId, taskId: request.taskId, operationId: request.operationId };
    const roots = await resolveRoots(request.folders);
    if (roots.length === 0) {
      return { scope, root: null, files: [], skills: [], issues: [REFERENCE_ISSUES.workspaceUnbound()] };
    }
    // 逐根发现：每个已绑定文件夹都有入口，定位带根身份，同名相对路径互不混淆。
    const perRoot = await Promise.all(roots.map(async (root) => {
      const [walked, discovered] = await Promise.all([walkFiles(root), discoverSkills(root, this.#stat)]);
      return { root, walked, discovered };
    }));
    const issues = perRoot.flatMap((entry) => entry.discovered.issues);
    const files: ReferenceCandidate[] = [];
    const skills: ReferenceCandidate[] = [];
    for (const entry of perRoot) {
      for (const file of entry.walked.files) {
        files.push({ kind: 'file', label: file.label, locator: `${entry.root.key}/${file.relative}`, sourceId: `workspace:${request.workspaceId}` });
      }
      skills.push(...entry.discovered.skills);
    }
    // 截断必须可辨：遍历上限与列表上限是两件事，各自在超过时才报，不静默丢项。
    if (perRoot.some((entry) => entry.walked.truncated)) {
      issues.push({ code: 'too-large', message: `工作空间文件超过 ${MAX_ENTRIES} 项，遍历已截断` });
    }
    const shownFiles = files.slice(0, MAX_LISTED_PER_KIND);
    const shownSkills = skills.slice(0, MAX_LISTED_PER_KIND);
    if (shownFiles.length < files.length) {
      issues.push({ code: 'list-truncated', message: `可引用文件共 ${files.length} 项，列表只显示前 ${shownFiles.length} 项` });
    }
    if (shownSkills.length < skills.length) {
      issues.push({ code: 'list-truncated', message: `已接技能共 ${skills.length} 项，列表只显示前 ${shownSkills.length} 项` });
    }
    return { scope, root: roots.map((r) => r.path).join(sep), files: shownFiles, skills: shownSkills, issues };
  }

  async capture(request: ReferenceRequest, kind: ReferenceKind, locator: string): Promise<WorkReference> {
    const roots = await resolveRoots(request.folders);
    if (roots.length === 0) throw new ReferenceCaptureError('workspace-unbound', REFERENCE_ISSUES.workspaceUnbound().message);
    // 定位自带根身份：按前缀找回所属根，而不是"取第一个目录"。
    const split = splitLocator(locator);
    if (!split) throw new ReferenceCaptureError('outside-root', REFERENCE_ISSUES.outsideRoot().message);
    // 根身份必须仍在当前绑定列表里：上一轮列出的定位在根失效后一律取不到，
    // 绝不因为"某个根顶上来了"就把旧定位解释成另一个根的同名文件。
    const root = roots.find((candidate) => candidate.key === split.rootKey);
    if (!root) throw new ReferenceCaptureError('outside-root', REFERENCE_ISSUES.outsideRoot().message);
    const located = await resolveWithinRoot(root.path, locator);
    if (!located.ok) {
      throw new ReferenceCaptureError(
        located.reason,
        located.reason === 'outside-root' ? REFERENCE_ISSUES.outsideRoot().message : REFERENCE_ISSUES.notFound().message,
      );
    }
    const absolute = located.absolute;
    let size: number;
    try {
      const info = await stat(absolute);
      if (!info.isFile()) throw new ReferenceCaptureError('not-found', REFERENCE_ISSUES.notFound().message);
      size = info.size;
    } catch (error) {
      if (error instanceof ReferenceCaptureError) throw error;
      throw new ReferenceCaptureError('not-found', REFERENCE_ISSUES.notFound().message);
    }
    const extension = locator.slice(locator.lastIndexOf('.')).toLowerCase();
    if (BINARY_EXTENSIONS.has(extension)) throw new ReferenceCaptureError('binary', REFERENCE_ISSUES.binary().message);
    if (size > REFERENCE_BYTE_LIMIT * 4) {
      // 远超上限：直接拒绝而不是先读进来再截，避免为一次引用把超大文件读进内存。
      throw new ReferenceCaptureError('too-large', REFERENCE_ISSUES.tooLarge(size, REFERENCE_BYTE_LIMIT * 4).message);
    }
    let buffer: Buffer;
    try {
      buffer = await readFile(absolute);
    } catch (error) {
      const errno = (error as NodeJS.ErrnoException).code;
      const denied = errno === 'EACCES' || errno === 'EPERM';
      throw new ReferenceCaptureError(
        denied ? 'permission-denied' : 'unreadable',
        denied ? REFERENCE_ISSUES.permissionDenied().message : REFERENCE_ISSUES.unreadable().message,
      );
    }
    if (buffer.includes(0)) throw new ReferenceCaptureError('binary', REFERENCE_ISSUES.binary().message);
    const bounded = decodeBounded(buffer, REFERENCE_BYTE_LIMIT);
    let label: string;
    let sourceId: string;
    if (kind === 'skill') {
      // 技能身份来自发现结果（SKILL.md frontmatter 的 name），不是文件名；
      // 同时这一步也确认它确实还是已接技能——不匹配即如实报 not-found。
      const discovered = await discoverSkills(root, this.#stat);
      const candidate = discovered.skills.find((s) => s.locator === locator);
      if (!candidate) throw new ReferenceCaptureError('not-found', REFERENCE_ISSUES.notFound().message);
      label = candidate.label;
      sourceId = candidate.sourceId;
    } else {
      label = locator.slice(locator.lastIndexOf('/') + 1);
      sourceId = `workspace:${request.workspaceId}`;
    }
    return {
      refId: `${kind}-${createHash('sha256').update(locator).digest('hex').slice(0, 16)}`,
      kind,
      label,
      locator,
      sourceId,
      snapshot: {
        // 哈希覆盖**即将参与请求的文本本身**，业务接收方据此核对"内容真的进去了"。
        contentHash: createHash('sha256').update(bounded.text).digest('hex'),
        byteSize: buffer.byteLength,
        capturedAt: Date.now(),
        truncated: bounded.truncated,
        content: bounded.text,
      },
    };
  }
}

export { REFERENCE_BYTE_LIMIT as referenceByteLimit };