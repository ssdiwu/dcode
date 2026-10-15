import { Worker } from 'node:worker_threads';
import { createFindTool, createGrepTool, createLsTool, createReadTool } from '@earendil-works/pi-coding-agent';
import { defineTool } from '@earendil-works/pi-durable';
import type { JsonValue } from '@earendil-works/chord';
import { parseWorkImages } from '@/contracts/index.ts';

// SDK 搜索器会探测本地二进制并含同步 IO；只在调用线程执行，宿主保持异步。
// 显式应用目录与 offline 禁止缺失二进制时读宿主 Pi 缓存或隐式下载。
export const searchWorkerSource = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { realpath, lstat } = require('node:fs/promises');
const { join, resolve, relative, isAbsolute, sep } = require('node:path');
const controller = new AbortController();
parentPort.on('message', message => { if (message === 'abort') controller.abort(); });
const childProcess = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const nativeSpawn = childProcess.spawn;
const childClosures = new Set();
let completed = false;
// SDK 在 stat／.git 的 await 后可能漏过取消；在本调用线程的真正 spawn 边界核原信号。
// 只接管本线程的公开进程端口，不改 SDK；已启动子进程从创建时就认领取消并等待 close。
childProcess.spawn = (...args) => {
  if (completed || controller.signal.aborted) throw new Error('Search cancelled before spawn');
  const child = nativeSpawn(...args);
  const cancel = () => { if (child.exitCode === null && !child.killed) child.kill(); };
  controller.signal.addEventListener('abort', cancel, { once: true });
  const closed = new Promise(resolve => child.once('close', () => {
    controller.signal.removeEventListener('abort', cancel); childClosures.delete(closed); resolve();
  }));
  childClosures.add(closed);
  return child;
};
syncBuiltinESMExports();
const inside = (root, path) => { const rel = relative(root, path); return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel); };
const optional = async path => { try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
(async () => {
  const sdk = await import(workerData.sdk);
  const cwd = await realpath(workerData.cwd);
  const path = await realpath(resolve(cwd, workerData.args.path ?? '.'));
  if (!inside(cwd, path)) throw Object.assign(new Error(), { code: 'scope' });
  // 应用自有 bin 若已声明也须核对真实根；不能由链接切换到另一份宿主缓存。
  const app = await optional(workerData.agentDir);
  if (app) {
    if (app.isSymbolicLink()) throw Object.assign(new Error(), { code: 'scope' });
    const root = await realpath(workerData.agentDir);
    const binary = workerData.name === 'grep' ? 'rg' : workerData.name === 'find' ? 'fd' : null;
    const bin = join(root, 'bin');
    if (binary && await optional(bin)) {
      if (!inside(root, await realpath(bin))) throw Object.assign(new Error(), { code: 'scope' });
      const file = join(bin, binary);
      if (await optional(file) && !inside(root, await realpath(file))) throw Object.assign(new Error(), { code: 'scope' });
    }
  }
  const factory = { grep: sdk.createGrepTool, find: sdk.createFindTool, ls: sdk.createLsTool, read: sdk.createReadTool }[workerData.name];
  const result = await factory(cwd).execute(workerData.callId, { ...workerData.args, path }, controller.signal);
  const payload = { ok: true, content: result.content, ...(result.details === undefined ? {} : { details: result.details }) };
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > 8 * 1024 * 1024) throw new Error();
  parentPort.postMessage(payload);
})().catch(error => parentPort.postMessage({ ok: false,
  code: controller.signal.aborted ? 'cancelled' : error.code === 'scope' ? 'scope' : 'unavailable' }))
  .finally(async () => { completed = true; await Promise.all([...childClosures]); parentPort.close(); });
`;

type Result = { content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]; details?: JsonValue };
function result(value: unknown): Result {
  if (typeof value !== 'object' || value === null || !('ok' in value) || value.ok !== true) {
    const code = typeof value === 'object' && value !== null && 'code' in value ? value.code : 'unavailable';
    throw new Error(code === 'scope' ? '搜索路径不在任务工作目录内' : code === 'cancelled' ? '搜索已取消' : '搜索工具未能执行，请检查工作目录及本地工具');
  }
  if (!('content' in value) || !Array.isArray(value.content) || value.content.some((part: unknown) =>
    typeof part !== 'object' || part === null || !('type' in part)
    || (part.type === 'text' ? !('text' in part) || typeof part.text !== 'string'
      : part.type !== 'image' || !('data' in part) || typeof part.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(part.data)
        || !('mimeType' in part) || !['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'].includes(String(part.mimeType))))
    || Buffer.byteLength(JSON.stringify(value), 'utf8') > 8 * 1024 * 1024) throw new Error('工具结果格式无效');
  // 线程只接收／返回 JSON；宿主再核正文形状及容量，不向正式记录传入任意 SDK 对象。
  // read 的图片与扩展结果、正式投影共享接收边界，不能因生产者不同先写入非法图像。
  parseWorkImages((value.content as Result['content']).filter(part=>part.type==='image').map(part=>({type:'image',data:part.data,mimeType:part.mimeType})));
  return { content: value.content as Result['content'], ...('details' in value ? { details: JSON.parse(JSON.stringify(value.details)) as JsonValue } : {}) };
}

async function search(name: string, args: unknown, cwd: string, agentDir: string, callId: string, signal?: AbortSignal): Promise<Result> {
  // 线程运行固定 SDK JavaScript，不继承宿主 execArgv 中的 TypeScript／调试加载器及其额外初始化。
  const worker = new Worker(searchWorkerSource, { eval: true, execArgv: [],
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', NODE_TEST_CONTEXT: undefined },
    workerData: { name, args, cwd, agentDir, callId, sdk: import.meta.resolve('@earendil-works/pi-coding-agent') } });
  const abort = () => worker.postMessage('abort');
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    return await new Promise<Result>((resolve, reject) => {
      let value: unknown; let failed = false;
      worker.once('message', message => { value = message; });
      worker.once('error', () => { failed = true; });
      // 等线程和 SDK 子进程的实际退出，再收束工具；暂停不遗留搜索子进程。
      worker.once('exit', code => {
        if (signal?.aborted) { reject(new Error('搜索已取消')); return; }
        if (failed || code !== 0) { reject(new Error('搜索工具未能执行')); return; }
        try { resolve(result(value)); } catch (error) { reject(error); }
      });
    });
  } finally { signal?.removeEventListener('abort', abort); }
}

/** SDK 的名称、参数及输出规则原样复用；执行／结果仍只有同一 Durable 所有者。 */
export function createSearchTools(agentDir: string) {
  return [createGrepTool('.'), createFindTool('.'), createLsTool('.')].map(tool => defineTool({
    name: tool.name, description: tool.description, parameters: tool.parameters, replay: 'safe',
    async execute(args, api, context) {
      if (!api.env) throw new Error('搜索工作目录不可用');
      return await search(tool.name, args, api.env.cwd, agentDir, api.callId, context.abortSignal);
    },
  }));
}

/** Durable 的 read 不支持图片；复用 coding-agent 的正式读取器及同一有界线程。 */
export function createImageReadTool(agentDir: string) {
  const tool = createReadTool('.');
  return defineTool({ name: tool.name, description: tool.description, parameters: tool.parameters, replay: 'safe',
    async execute(args, api, context) {
      if (!api.env) throw new Error('读取工作目录不可用');
      return search('read', args, api.env.cwd, agentDir, api.callId, context.abortSignal);
    } });
}
