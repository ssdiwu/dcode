/** 有限的实际文本差异结构，执行结果与界面共用，不能代表未采样变化。 */
export interface DiffLine { type: 'add' | 'del' | 'context'; text: string }
export interface DiffHunk { header: string; lines: DiffLine[] }
export interface FileChange { path: string; added: number; deleted: number; hunks: DiffHunk[] }
