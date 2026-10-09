// 工具块：默认折叠为单行摘要，有可查看详情时就地展开；嵌套与失败状态有固定样式。
// 无详情时作为只读摘要（不做成带点击的无反馈按钮）；工具完成不等于任务验收。
// `tool-result` 的形态来自真实 Pi 记录的投影（name/primaryText/output/diagnostics）。
// 复制错误只复制这份错误正文：await 真实 clipboard Promise 报成功，拒绝／不可用如实反馈；
// 复制不走重试，更不会联动重试工具本体。

import { useState } from "react";
import { Check, ChevronRight, Copy, Loader2, XCircle } from "lucide-react";
import type { ToolBlockData } from "@/contracts";
import { Badge } from "./Badge";
import { Button } from "./Button";
import { useT } from "../i18n";

type CopyState = "idle" | "copying" | "copied" | "failed";

export function ToolCallBlock({ tool }: { tool: ToolBlockData }) {
  const t = useT();
  const statusBadge: Record<ToolBlockData["status"], { tone: "neutral" | "success" | "destructive" | "warning"; label: string }> = {
    running: { tone: "neutral", label: t("run.running") },
    done: { tone: "success", label: t("run.done") },
    failed: { tone: "destructive", label: t("run.failed") },
    waiting: { tone: "warning", label: t("tool.waiting") },
  };
  const [expanded, setExpanded] = useState(tool.status === "failed");
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const badge = statusBadge[tool.status];
  const hasDetail = tool.output.length > 0 || tool.changedFiles.length > 0;

  const copyError = async () => {
    if (copyState === "copying") return;
    setCopyState("copying");
    try {
      const clipboard = navigator.clipboard;
      if (!clipboard || typeof clipboard.writeText !== "function") throw new Error("clipboard unavailable");
      await clipboard.writeText(tool.output);
      setCopyState("copied");
      setTimeout(() => setCopyState((state) => (state === "copied" ? "idle" : state)), 1200);
    } catch {
      // 剪贴板拒绝／不可用时明确反馈，不伪报成功；重试复制仍只复制错误，不重试工具
      setCopyState("failed");
    }
  };

  const copyLabel =
    copyState === "copying"
      ? t("tool.copying")
      : copyState === "copied"
        ? t("tool.copied")
        : copyState === "failed"
          ? t("tool.copyFailed")
          : t("tool.copyError");
  const copyIcon =
    copyState === "copied" ? (
      <Check className="size-3.5" />
    ) : copyState === "failed" ? (
      <XCircle className="size-3.5" />
    ) : copyState === "copying" ? (
      <Loader2 className="size-3.5 animate-spin" />
    ) : (
      <Copy className="size-3.5" />
    );

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      {hasDetail ? (
        <button
          className="flex w-full items-center gap-2 px-3 h-9 text-left cursor-default"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          <SummaryContent
            tool={tool}
            badge={<Badge tone={badge.tone}>{badge.label}</Badge>}
            chevron={
              tool.status === "running" ? (
                <Loader2 className="size-3.5 animate-spin text-subtle" />
              ) : (
                <ChevronRight
                  className={`size-3.5 text-subtlest transition-transform duration-100 ${expanded ? "rotate-90" : ""}`}
                />
              )
            }
          />
        </button>
      ) : (
        // 无详情时作为只读摘要：不做成带点击处理的无反馈展开按钮（spec T04）
        <div className="flex w-full items-center gap-2 px-3 h-9 text-left">
          <SummaryContent
            tool={tool}
            badge={<Badge tone={badge.tone}>{badge.label}</Badge>}
            chevron={
              tool.status === "running" ? (
                <Loader2 className="size-3.5 animate-spin text-subtle" />
              ) : (
                <ChevronRight className="size-3.5 text-subtlest invisible" />
              )
            }
          />
        </div>
      )}
      {expanded && hasDetail && (
        <div className="border-t border-border px-3 py-2.5 space-y-2">
          {tool.output && (
            <pre className="text-ui-sm font-mono text-subtle whitespace-pre-wrap leading-5.5 overflow-x-auto">
              {tool.output}
            </pre>
          )}
          {tool.status === "failed" && (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={copyState === "copying"}
                aria-live={copyState === "copied" || copyState === "failed" ? "polite" : undefined}
                onClick={() => void copyError()}
              >
                {copyIcon}
                {copyLabel}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SummaryContent({
  tool,
  badge,
  chevron,
}: {
  tool: ToolBlockData;
  badge: React.ReactNode;
  chevron: React.ReactNode;
}) {
  const t = useT();
  return (
    <>
      {chevron}
      <span className="text-ui-xs font-mono text-subtlest uppercase shrink-0">{tool.name}</span>
      <span className="text-ui-sm text-subtle truncate flex-1">{tool.primaryText || t("tool.result")}</span>
      {tool.changedFiles.length > 0 && (
        <span className="text-ui-xs text-subtlest tabular-nums shrink-0">
          {t("tool.filesCount", { n: tool.changedFiles.length })}
        </span>
      )}
      {badge}
    </>
  );
}
