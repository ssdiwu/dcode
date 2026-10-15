// 工具块：默认折叠为单行摘要，有可查看详情时就地展开；无详情时作为只读摘要（不做成带点击的
// 无反馈按钮，spec T04）。折叠／展开组合结构来自上游 ai-elements 的 Tool 系列。
// `tool-result` 的形态来自真实 Pi 记录的投影（name/primaryText/output/status/changedFiles）；
// 状态词与图标由本组件按真实记录给出，不采用上游 AI SDK 的 part state 文案。
// 复制错误只复制这份错误正文：await 真实 clipboard Promise 报成功，拒绝／不可用如实反馈；
// 复制不走重试，更不会联动重试工具本体。

import { useState } from "react";
import { Check, Copy, Loader2, XCircle } from "lucide-react";
import type { ToolBlockData } from "@/contracts";
import { Badge } from "./Badge";
import { Button } from "./Button";
import { Tool, ToolContent, ToolHeader, ToolOutput } from "./ai/tool";
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
  // 失败默认展开：错误正文是需要立刻看到的东西，不该多一次点击
  const [open, setOpen] = useState(tool.status === "failed");
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const badge = statusBadge[tool.status];
  const hasDetail = tool.output.length > 0 || tool.changedFiles.length > 0 || Boolean(tool.images?.length);

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

  // 摘要（会被截断）／次级计数（不截断）／状态（不截断）分开，
  // 避免状态徽标被卷进摘要一起截断、与摘要文字挤在一起。
  const summary = <span className="truncate">{tool.primaryText || t("tool.result")}</span>;
  const meta = tool.changedFiles.length > 0 || tool.exitCode !== undefined ? (
    <span className="flex gap-2 tabular-nums text-ui-xs text-subtlest">
      {tool.changedFiles.length > 0 && <span>{t("tool.filesCount", { n: tool.changedFiles.length })}</span>}
      {tool.exitCode !== undefined && <span>{t('tool.exitCode', { n: tool.exitCode })}</span>}
    </span>
  ) : null;
  // 运行中用旋转图形表达真实相位；静态替代仍可由状态文字理解（不只靠颜色）
  const status = (
    <>
      {tool.status === "running" && <Loader2 className="size-3.5 shrink-0 animate-spin text-subtle" />}
      <Badge tone={badge.tone}>{badge.label}</Badge>
    </>
  );

  const actions =
    tool.status === "failed" && tool.output ? (
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
    ) : null;

  // 无详情：只读摘要。呈现为同一表面但不作为可展开目标——不让用户点一个没有反馈的按钮。
  if (!hasDetail) {
    return (
      <div
        data-slot="tool-readonly"
        className="flex h-9 w-full items-center gap-2 rounded-lg bg-raised px-3 ring-1 ring-[var(--edge)]"
      >
        <span className="shrink-0 font-mono text-ui-xs uppercase text-subtlest">{tool.name}</span>
        {summary}
        {meta && <span className="shrink-0">{meta}</span>}
        <span className="flex shrink-0 items-center gap-1.5">{status}</span>
      </div>
    );
  }

  return (
    <Tool open={open} onOpenChange={setOpen}>
      <ToolHeader name={tool.name} summary={summary} meta={meta} status={status}
        aria-label={`${t('tool.result')} ${tool.name} ${tool.primaryText} ${badge.label}`} />
      <ToolContent>
        <ToolOutput output={tool.output} actions={actions} />
        {tool.images?.map((image, index) => <img key={index} alt={`${t('tool.result')} ${tool.name} ${index + 1}`}
          className="max-w-full max-h-96 object-contain rounded-md" loading="lazy"
          src={`data:${image.mimeType};base64,${image.data}`} />)}
      </ToolContent>
    </Tool>
  );
}
