// 本轮改动聚合卡：时间线上的汇总入口，点击进检查器逐文件查看。

import { FileDiff, ChevronRight } from "lucide-react";
import type { FileChange } from "@/contracts";
import { useT } from "../i18n";

export function ChangeSummaryCard({
  files,
  onOpen,
  blockId,
}: {
  files: FileChange[];
  onOpen: (files: FileChange[]) => void;
  blockId?: string;
}) {
  const t = useT();
  const added = files.reduce((n, f) => n + f.added, 0);
  const deleted = files.reduce((n, f) => n + f.deleted, 0);
  return (
    // 时间线上的聚合入口：抬升表面 + 弱环 + 极弱投影，与工具块同一层，不再套一层卡片边框
    <button
      data-block-id={blockId}
      className="flex w-full cursor-default items-center gap-2.5 rounded-lg bg-raised px-3 py-2.5 text-left ring-1 ring-[var(--edge)] shadow-[var(--shadow-sm)] transition-colors duration-100 hover:bg-hover"
      onClick={() => onOpen(files)}
    >
      <FileDiff className="size-4 shrink-0 text-subtle" />
      <span className="min-w-0 flex-1 text-ui-sm">
        {t("changes.summary", { n: files.length })}
      </span>
      <span className="shrink-0 tabular-nums text-ui-xs">
        <span className="text-diff-add-text">+{added}</span>{" "}
        <span className="text-diff-del-text">−{deleted}</span>
      </span>
      <ChevronRight className="size-3.5 shrink-0 text-subtlest" />
    </button>
  );
}
