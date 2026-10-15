// 横幅：内联提示与状态说明的唯一来源。分语义色，不用装饰性插画。
// 信息类不描边（靠抬升表面与留白成立）；只有警告与失败才用弱语义环指出需要处理。

import type { ReactNode } from "react";

type Tone = "info" | "warning" | "destructive";

const toneClass: Record<Tone, string> = {
  info: "bg-raised ring-1 ring-[var(--edge)] text-foreground",
  warning: "bg-warning/8 ring-1 ring-warning/30 text-foreground",
  destructive: "bg-destructive/8 ring-1 ring-destructive/30 text-foreground",
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
    <div className={`flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-ui-sm shadow-[var(--shadow-sm)] ${toneClass[tone]}`}>
      <div className="min-w-0 text-subtle">{children}</div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
