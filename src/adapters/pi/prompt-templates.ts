import { CodingResourcesUnavailable } from './coding-resources';
import type { CodingPromptTemplate } from './coding-resources';

// 参数算法适配自 Pi 1.0.0 core/prompt-templates.ts（MIT，Mario Zechner 2025）。
// 该函数未在包根导出；不越过公开入口、不建立另一份会话。完整来源与许可见 THIRD_PARTY_NOTICES。
function commandArgs(text: string): string[] {
  const args: string[] = []; let value = ''; let quote: string | null = null;
  for (const char of text) {
    if (quote) { if (char === quote) quote = null; else value += char; }
    else if (char === '"' || char === "'") quote = char;
    else if (/\s/.test(char)) { if (value) { args.push(value); value = ''; } }
    else value += char;
  }
  if (value) args.push(value);
  return args;
}

/** 只替换模板原文一遍，参数里的 $1 等内容不能再次被当成模板解释或 shell 命令。 */
export function expandCodingPrompt(text: string, templates: readonly CodingPromptTemplate[]): string {
  if (!text.startsWith('/')) return text;
  const command = text.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
  const template = templates.find(candidate => candidate.name === command?.[1]);
  if (!template) return text;
  const args = commandArgs(command?.[2] ?? ''); const all = args.join(' ');
  let cursor = 0; let bytes = 0;
  const expanded = template.content.replace(/\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
    (match: string, target: string | undefined, fallback: string, start: string | undefined, length: string | undefined, simple: string | undefined, offset: number) => {
      const replacement = target ? (target === '@' || target === 'ARGUMENTS' ? all : args[Number(target) - 1]) || fallback
        : start ? args.slice(Math.max(0, Number(start) - 1), length ? Math.max(0, Number(start) - 1) + Number(length) : undefined).join(' ')
          : simple === '@' || simple === 'ARGUMENTS' ? all : args[Number(simple) - 1] ?? '';
      // 重复占位符可以把有界参数放大；在拼接巨型正文前按实际 UTF-8 字节认领容量。
      bytes += Buffer.byteLength(template.content.slice(cursor, offset), 'utf8') + Buffer.byteLength(replacement, 'utf8');
      cursor = offset + match.length;
      if (bytes > 1_000_000) throw new CodingResourcesUnavailable();
      return replacement;
    });
  if (!expanded.trim() || Buffer.byteLength(expanded, 'utf8') > 1_000_000) throw new CodingResourcesUnavailable();
  return expanded;
}
