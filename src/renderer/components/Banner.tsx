// 横幅：内联提示与状态说明的唯一来源。分语义色，不用装饰性插画。

import type { ReactNode } from "react";

type Tone = "info" | "warning" | "destructive";

const toneClass: Record<Tone, string> = {
  info: "border-border bg-panel text-foreground",
  warning: "border-warning/30 bg-warning/8 text-foreground",
  destructive: "border-destructive/30 bg-destructive/8 text-foreground",
};

export function Banner({
  tone = "info",
  children,
  actions,
}: {
  tone?: Tone;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-ui-sm ${toneClass[tone]}`}
    >
      <div className="min-w-0 text-subtle">{children}</div>
      {actions && <div className="shrink-0 flex items-center gap-2">{actions}</div>}
    </div>
  );
}
