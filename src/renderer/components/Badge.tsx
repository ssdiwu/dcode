// 徽章：状态词的唯一样式来源。语义色只用于语义态。

import type { ReactNode } from "react";

type Tone = "neutral" | "success" | "warning" | "destructive" | "accent";

const toneClass: Record<Tone, string> = {
  neutral: "bg-hover text-subtle",
  success: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
  destructive: "bg-destructive/10 text-destructive",
  accent: "bg-primary/8 text-foreground",
};

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1 h-5 px-1.5 rounded-md text-ui-xs font-medium whitespace-nowrap ${toneClass[tone]}`}
    >
      {children}
    </span>
  );
}
