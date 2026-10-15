// Diff 渲染：diff 专用色，不用通用 success/destructive 色。
// 只读检查（spec I03）：不提供未经确认的接受／撤销／编辑按钮。
// 层次：文件头（路径 + 增删计数）→ 下沉差异面 → hunk → 行。长行横向滚动。

import type { FileChange } from "@/contracts";

export function DiffView({ file }: { file: FileChange }) {
  return (
    <div className="overflow-hidden rounded-lg bg-sunken shadow-[var(--shadow-inset-well)] ring-1 ring-[var(--edge)]">
      {/* 文件头用抬升表面与差异面分层，不画实线 */}
      <div className="flex h-8 items-center justify-between gap-2 bg-raised px-3">
        <span className="truncate font-mono text-ui-sm" title={file.path}>{file.path}</span>
        <span className="shrink-0 tabular-nums text-ui-xs">
          <span className="text-diff-add-text">+{file.added}</span>{" "}
          <span className="text-diff-del-text">−{file.deleted}</span>
        </span>
      </div>
      {/* 横向滚动容器：窄检查器内长行仍可读（spec I03 / DESIGN 分栏） */}
      <div className="overflow-x-auto py-1">
        {file.hunks.map((hunk, i) => (
          <div key={i}>
            <div className="px-3 py-1 font-mono text-ui-xs text-subtlest">{hunk.header}</div>
            {hunk.lines.map((line, j) => (
              <div
                key={j}
                className={`whitespace-pre px-3 font-mono text-ui-sm leading-[1.83] ${
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
