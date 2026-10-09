// 极简 Markdown 渲染：段落、加粗、行内代码、代码块、列表、标题。
// 只覆盖原型内容所需语法；不渲染原始 HTML。

import { Fragment, type ReactNode } from "react";

function inline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith("**")) {
      parts.push(<strong key={key++} className="font-semibold">{token.slice(2, -2)}</strong>);
    } else {
      parts.push(
        <code key={key++} className="rounded bg-hover px-1 py-0.5 text-ui-sm font-mono">
          {token.slice(1, -1)}
        </code>,
      );
    }
    last = match.index + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export function MarkdownLite({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.split("\n");
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) buf.push(lines[i++]);
      i++;
      blocks.push(
        <pre key={key++} className="rounded-lg border border-border bg-panel p-3 text-ui-sm font-mono overflow-x-auto">
          {buf.join("\n")}
        </pre>,
      );
      continue;
    }
    if (/^\d+\.\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) items.push(lines[i++].replace(/^\d+\.\s/, ""));
      blocks.push(
        <ol key={key++} className="list-decimal pl-5 space-y-1">
          {items.map((item, j) => (
            <li key={j}>{inline(item)}</li>
          ))}
        </ol>,
      );
      continue;
    }
    if (line.startsWith("- ")) {
      const items: string[] = [];
      while (i < lines.length && lines[i].startsWith("- ")) items.push(lines[i++].slice(2));
      blocks.push(
        <ul key={key++} className="list-disc pl-5 space-y-1">
          {items.map((item, j) => (
            <li key={j}>{inline(item)}</li>
          ))}
        </ul>,
      );
      continue;
    }
    if (line.startsWith("### ")) {
      blocks.push(<h4 key={key++} className="text-ui-base font-semibold mt-1">{inline(line.slice(4))}</h4>);
      i++;
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    blocks.push(<p key={key++}>{inline(line)}</p>);
    i++;
  }
  return <div className="space-y-2.5 leading-relaxed">{blocks.map((b, j) => <Fragment key={j}>{b}</Fragment>)}</div>;
}
