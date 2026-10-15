import type { Context, JsonValue } from '@earendil-works/chord';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { createBashTool, createEditTool, createWriteTool } from '@earendil-works/pi-durable/tools';
import { structuredPatch } from 'diff';
import type { FileChange } from '@/contracts';
import { createImageReadTool, createSearchTools } from './search-tools';

type Sample = { exists: boolean | null; text: string | null };
type Snapshot = { files: Map<string, Sample>; complete: boolean };
const maxFileBytes = 512 * 1024;
const maxFiles = 512;
const excluded = new Set(['.git', 'node_modules']);
const changeNotice = '差异来自本次工具前后的文本采样；不覆盖依赖、Git、链接、二进制或项目目录外的变化，也不证明并发改动的作者归属。';

async function sample(env: ExecutionEnv, path: string, context: Context): Promise<Sample> {
  const info = await env.fileInfo(path, context);
  if (!info.ok) return { exists: info.error.code === 'not_found' ? false : null, text: null };
  if (info.value.kind !== 'file' || info.value.size > maxFileBytes) return { exists: true, text: null };
  const read = await env.readBinaryFile(path, context);
  if (!read.ok || read.value.includes(0)) return { exists: true, text: null };
  try { return { exists: true, text: new TextDecoder('utf-8', { fatal: true }).decode(read.value) }; }
  catch { return { exists: true, text: null }; }
}

async function snapshot(env: ExecutionEnv, context: Context): Promise<Snapshot> {
  const result: Snapshot = { files: new Map(), complete: true };
  const queue = [env.cwd];
  let bytes = 0;
  while (queue.length > 0 && result.files.size < maxFiles && bytes < 8 * 1024 * 1024 && !context.abortSignal?.aborted) {
    const folder = queue.shift()!;
    const listed = await env.listDir(folder, context);
    if (!listed.ok) { result.complete = false; continue; }
    for (const file of listed.value) {
      if (excluded.has(file.name)) continue;
      if (file.kind === 'directory') queue.push(file.path);
      else if (file.kind === 'file') {
        const value = await sample(env, file.path, context);
        result.files.set(file.path, value);
        bytes += value.text === null ? 0 : Buffer.byteLength(value.text);
        if (result.files.size >= maxFiles || bytes >= 8 * 1024 * 1024) { result.complete = false; break; }
      }
    }
  }
  if (queue.length > 0 || context.abortSignal?.aborted) result.complete = false;
  return result;
}

function change(path: string, before: Sample, after: Sample): FileChange | null {
  // 未读取／二进制／超界不能被补成空文件；只有已核对的存在与正文才生成差异。
  if (before.exists === null || after.exists === null || (before.exists && before.text === null) || (after.exists && after.text === null)) return null;
  const oldText = before.text ?? ''; const newText = after.text ?? '';
  if (oldText === newText && before.exists === after.exists) return null;
  const patch = structuredPatch(path, path, oldText, newText, undefined, undefined, { context: 3 });
  let added = 0; let deleted = 0;
  const hunks = patch.hunks.map(hunk => ({
    header: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    lines: hunk.lines.filter(line => line[0] !== '\\').map(line => {
      if (line[0] === '+') { added += 1; return { type: 'add' as const, text: line.slice(1) }; }
      if (line[0] === '-') { deleted += 1; return { type: 'del' as const, text: line.slice(1) }; }
      return { type: 'context' as const, text: line.slice(1) };
    }),
  }));
  return { path, added, deleted, hunks };
}

function details(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)) as JsonValue; }
function boundedChanges(changes: FileChange[]) {
  const kept: FileChange[] = []; let bytes = 2;
  for (const file of changes) {
    const size = Buffer.byteLength(JSON.stringify(file));
    if (bytes + size > 1024 * 1024) return { changes: kept, changeNotice: `${changeNotice} 部分差异超过展示上限。` };
    kept.push(file); bytes += size + 1;
  }
  return { changes: kept, changeNotice };
}

/** 公共 Pi 工具原执行语义不变；附带实际数字出口与有界的前后变化。 */
export function createCodingTools(agentDir: string) {
  const write = createWriteTool(); const bash = createBashTool();
  return defineExtension({ name: 'dcode-coding-tools', tools: [...createSearchTools(agentDir), createImageReadTool(agentDir), createEditTool(),
    defineTool({ ...write, async execute(args, api, context) {
      if (!api.env) throw new Error('Coding environment is unavailable');
      const resolved = await api.env.absolutePath(args.path, context);
      if (!resolved.ok) throw resolved.error;
      const before = await sample(api.env, resolved.value, context);
      try { return await write.execute(args, api, context); }
      finally {
        if (!context.abortSignal?.aborted) {
          const changed = change(resolved.value, before, await sample(api.env, resolved.value, context));
          await api.details(details(boundedChanges(changed ? [changed] : [])), context);
        }
      }
    } }),
    defineTool({ ...bash, async execute(args, api, context) {
      const env = api.env;
      if (!env) throw new Error('Coding environment is unavailable');
      const before = await snapshot(env, context);
      let exitCode: number | undefined;
      const observedEnv = new Proxy(env, { get(owner, key) {
        if (key === 'exec') return (async (...parameters: Parameters<ExecutionEnv['exec']>) => {
          const result = await owner.exec(...parameters);
          if (result.ok) {
            exitCode = result.value.exitCode;
            // 有些协议不发送 tool details；数字出口同时进入正式正文，模型不能只看到无状态输出。
            api.output(`\nCommand exit code: ${exitCode}\n`);
            await api.details({ exitCode }, context);
          }
          return result;
        }) satisfies ExecutionEnv['exec'];
        const value: unknown = Reflect.get(owner, key);
        return typeof value === 'function' ? value.bind(owner) : value;
      } });
      try { return await bash.execute(args, { ...api, env: observedEnv }, context); }
      finally {
        if (!context.abortSignal?.aborted) {
          const after = await snapshot(env, context);
          const changes: FileChange[] = [];
          for (const path of new Set([...before.files.keys(), ...after.files.keys()])) {
            const old = before.files.get(path) ?? { exists: null, text: null };
            const next = after.files.get(path) ?? await sample(env, path, context);
            // 新文件的前态只能由完整首轮列表确认；超过边界时不给它伪造旧空正文。
            const previous = !before.files.has(path) && before.complete ? { exists: false, text: null } : old;
            const changed = change(path, previous, next);
            if (changed) changes.push(changed);
          }
          await api.details(details({ ...(exitCode === undefined ? {} : { exitCode }), ...boundedChanges(changes) }), context);
        }
      }
    } }),
  ] });
}
