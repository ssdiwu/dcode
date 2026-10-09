import { mkdir, readdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';

/** 不以心跳超时夺取仍活着的进程；所有权不明确时拒绝打开。 */
export async function claimDirectory(directory: string): Promise<() => Promise<void>> {
  const lock = join(directory, '.dcode-owner');
  const marker = `${randomUUID()}.json`;
  const ownPath = join(lock, marker);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(lock, { mode: 0o700 });
      try {
        await writeFile(ownPath, JSON.stringify({ pid: process.pid, host: hostname(), marker }), { flag: 'wx', mode: 0o600 });
        // 旧进程回收与新认领交错时，只允许唯一标记拥有目录，不递归删除他人标记。
        const files = await readdir(lock);
        if (files.length !== 1 || files[0] !== marker) throw new Error('Runtime ownership is ambiguous');
      } catch (error) {
        await unlink(ownPath).catch(() => undefined);
        await rmdir(lock).catch(() => undefined);
        throw error;
      }
      let released = false;
      return async () => {
        if (released) return;
        await unlink(ownPath);
        try { await rmdir(lock); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY' && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        released = true;
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt !== 0) throw error;
    }
    const files = await readdir(lock);
    if (files.length !== 1 || !/^[0-9a-f-]+\.json$/.test(files[0])) throw new Error('Runtime ownership cannot be verified');
    const old = JSON.parse(await readFile(join(lock, files[0]), 'utf8')) as { pid?: unknown; host?: unknown; marker?: unknown };
    if (!Number.isSafeInteger(old.pid) || (old.pid as number) <= 0 || old.host !== hostname() || old.marker !== files[0]) throw new Error('Runtime ownership cannot be verified');
    let dead = false;
    try { process.kill(old.pid as number, 0); } catch (error) { dead = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
    if (!dead) throw new Error('Runtime storage already has a live owner');
    // 仅回收已证实死亡的进程的确切标记；新代际标记和非空目录都不能被旧回收覆盖。
    await unlink(join(lock, files[0])).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(lock).catch(error => { if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error; });
  }
  throw new Error('Runtime storage is busy');
}
