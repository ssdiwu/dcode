import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import type { ProjectFolderPort } from '@/application';
import type { ProjectFolderSelection } from '@/contracts';

type Choice = { requestId: string; selectionId?: string; path?: string; dev?: number; ino?: number };

/** 宿主只持有用户本次选择事实；正式空间／任务绑定仍由 application 保存。 */
export class NativeProjectFolders implements ProjectFolderPort {
  readonly #choices = new Map<string, Choice>();

  constructor(private readonly pick: () => Promise<string | null>) {}

  async choose(input: { operationId: string; requestId: string }): Promise<ProjectFolderSelection | null> {
    if (!this.#choices.has(input.operationId) && this.#choices.size >= 64) throw new Error('project-folder-unavailable');
    const previous = this.#choices.get(input.operationId);
    const choice: Choice = { requestId: input.requestId };
    this.#choices.set(input.operationId, choice);
    const restore = () => {
      if (this.#choices.get(input.operationId) !== choice) return;
      if (previous?.selectionId) this.#choices.set(input.operationId, previous);
      else this.#choices.delete(input.operationId);
    };
    try {
      const selected = await this.pick();
      // 关闭表单／新选择已使本次对象失效；迟到目录不是后来创建操作的授权。
      if (this.#choices.get(input.operationId) !== choice) return null;
      if (selected === null) { restore(); return null; }
      const path = await realpath(selected);
      const info = await stat(path);
      if (!info.isDirectory()) throw new Error();
      if (this.#choices.get(input.operationId) !== choice) return null;
      Object.assign(choice, { selectionId: randomUUID(), path, dev: info.dev, ino: info.ino });
      return { ...input, selectionId: choice.selectionId!, path };
    } catch { restore(); throw new Error('project-folder-unavailable'); }
  }

  async resolve(input: { operationId: string; selectionId: string }): Promise<string> {
    const choice = this.#choices.get(input.operationId);
    if (!choice?.path || choice.selectionId !== input.selectionId) throw new Error('project-folder-stale');
    try {
      const path = await realpath(choice.path);
      const info = await stat(path);
      if (this.#choices.get(input.operationId) !== choice || path !== choice.path || !info.isDirectory()
        || info.dev !== choice.dev || info.ino !== choice.ino) throw new Error();
      return path;
    } catch { throw new Error('project-folder-stale'); }
  }

  discard(operationId: string): void { this.#choices.delete(operationId); }
}
