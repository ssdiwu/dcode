import { memo, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { codeToHtml } from "shiki";
import { api } from "../types";

/**
 * 助手/用户文本的富渲染：GFM Markdown + Shiki 代码高亮（双主题）+
 * mermaid 代码块经核心 content.renderMermaid 渲染（grok-mermaid）。
 */

function MermaidView({ code }: { code: string }) {
  const [lines, setLines] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api()
      .request("content.renderMermaid", { source: code })
      .then(value => {
        const result = value as {
          rendered?: boolean;
          lines?: string[];
          error?: string;
        };
        if (!alive) return;
        if (result.rendered && Array.isArray(result.lines)) {
          setLines(result.lines);
        } else {
          setError(result.error ?? "渲染失败");
        }
      })
      .catch((reason: unknown) => {
        if (alive) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    return () => {
      alive = false;
    };
  }, [code]);
  if (lines) {
    return (
      <div className="my-2 overflow-x-auto rounded-lg border border-line bg-raised px-3 py-2">
        <pre className="whitespace-pre font-mono text-[11.5px] leading-5 text-muted">
          {lines.join("\n")}
        </pre>
      </div>
    );
  }
  return (
    <div className="my-2 rounded-lg border border-line bg-nav/60 px-3 py-2 text-[11.5px] text-hint">
      {error ? `Mermaid：${error}` : "Mermaid 渲染中…"}
      <pre className="mt-1 overflow-x-auto whitespace-pre font-mono text-[11px]">
        {code}
      </pre>
    </div>
  );
}

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    codeToHtml(code, {
      lang,
      themes: { light: "github-light", dark: "github-dark" },
    })
      .then(value => {
        if (alive) setHtml(value);
      })
      .catch(() => {
        if (alive) setHtml(null);
      });
    return () => {
      alive = false;
    };
  }, [code, lang]);
  if (html) {
    return (
      <div
        className="my-2 overflow-x-auto rounded-lg border border-line text-[12px]"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }
  return (
    <pre className="my-2 overflow-x-auto rounded-lg border border-line p-3 text-[12px]">
      <code>{code}</code>
    </pre>
  );
}

function MarkdownInner({ text }: { text: string }) {
  return (
    <div className="space-y-2 break-words text-[13px] leading-6 [&_a]:text-accent [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-line [&_blockquote]:pl-3 [&_blockquote]:text-muted [&_code]:rounded [&_code]:bg-ink/8 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[12px] [&_h1]:text-[16px] [&_h1]:font-semibold [&_h2]:text-[15px] [&_h2]:font-semibold [&_h3]:text-[14px] [&_h3]:font-semibold [&_hr]:border-line [&_li]:marker:text-hint [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-line [&_pre]:p-3 [&_pre]:text-[12px] [&_table]:w-full [&_table]:text-[12px] [&_td]:border [&_td]:border-line [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-line [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_ul]:list-disc [&_ul]:pl-5">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: props => <>{props.children}</>,
          code: props => {
            const { className, children } = props as {
              className?: string;
              children?: React.ReactNode;
            };
            const raw = String(children ?? "").replace(/\n$/, "");
            const match = /language-(\w+)/.exec(className ?? "");
            if (match?.[1] === "mermaid") {
              return <MermaidView code={raw.trim()} />;
            }
            if (match || raw.includes("\n")) {
              return <CodeBlock code={raw} lang={match?.[1] ?? "text"} />;
            }
            return <code className={className}>{children}</code>;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export const Markdown = memo(MarkdownInner);
