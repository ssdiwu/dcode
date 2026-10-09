// 本轮改动聚合卡：时间线上的汇总入口，点击进检查器逐文件查看。

import { FileDiff, ChevronRight } from "lucide-react";
import type { FileChange } from "@/contracts";
import { useT } from "../i18n";

export function ChangeSummaryCard({
  files,
  onOpen,
}: {
  files: FileChange[];
  onOpen: (files: FileChange[]) => void;
}) {
  const t = useT();
  const added = files.reduce((n, f) => n + f.added, 0);
  const deleted = files.reduce((n, f) => n + f.deleted, 0);
  return (
    <button
      className="flex w-full items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2.5 text-left cursor-default hover:bg-hover transition-colors duration-100"
      onClick={() => onOpen(files)}
    >
      <FileDiff className="size-4 text-subtle shrink-0" />
      <span className="text-ui-sm flex-1 min-w-0">
        {t("changes.summary", { n: files.length })}
      </span>
      <span className="text-ui-xs tabular-nums shrink-0">
        <span className="text-diff-add-text">+{added}</span>{" "}
        <span className="text-diff-del-text">−{deleted}</span>
      </span>
      <ChevronRight className="size-3.5 text-subtlest shrink-0" />
    </button>
  );
}
