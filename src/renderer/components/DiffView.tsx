// Diff 渲染：diff 专用色，不用通用 success/destructive 色。

import type { FileChange } from "@/contracts";

export function DiffView({ file }: { file: FileChange }) {
  return (
    <div className="rounded-lg border border-border bg-panel overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-3 h-8 border-b border-border bg-card">
        <span className="text-ui-sm font-mono truncate">{file.path}</span>
        <span className="text-ui-xs tabular-nums shrink-0">
          <span className="text-diff-add-text">+{file.added}</span>{" "}
          <span className="text-diff-del-text">−{file.deleted}</span>
        </span>
      </div>
      <div className="overflow-x-auto py-1">
        {file.hunks.map((hunk, i) => (
          <div key={i}>
            <div className="px-3 py-0.5 text-ui-xs font-mono text-subtlest">{hunk.header}</div>
            {hunk.lines.map((line, j) => (
              <div
                key={j}
                className={`px-3 text-ui-sm font-mono whitespace-pre leading-5.5 ${
                  line.type === "add"
                    ? "bg-diff-add-bg text-diff-add-text"
                    : line.type === "del"
                      ? "bg-diff-del-bg text-diff-del-text"
                      : "text-subtle"
                }`}
              >
                {line.type === "add" ? "+ " : line.type === "del" ? "− " : "  "}
                {line.text}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
