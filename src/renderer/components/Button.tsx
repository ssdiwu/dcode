// 共享按钮原语：variant 与尺寸的唯一来源，页面不自行发明按钮样式。

import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

type Variant = "primary" | "ghost" | "outline" | "destructive";
type Size = "sm" | "md";

const variantClass: Record<Variant, string> = {
  // 填色主按钮焦点描边走反色（focus-ring-inverse），其余走共享中性描边
  primary:
    "focus-ring-inverse bg-primary text-primary-foreground hover:bg-primary/90 disabled:bg-primary/40",
  ghost:
    "text-subtle hover:text-foreground hover:bg-hover disabled:text-subtlest",
  outline:
    "border border-border text-foreground hover:bg-hover disabled:text-subtlest",
  destructive:
    "text-destructive hover:bg-destructive/10 disabled:text-subtlest",
};

const sizeClass: Record<Size, string> = {
  sm: "h-7 px-2.5 text-ui-sm rounded-md gap-1.5",
  md: "h-8 px-3 text-ui-base rounded-lg gap-2",
};

export function Button({
  variant = "outline",
  size = "md",
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return (
    <button
      className={`inline-flex items-center justify-center whitespace-nowrap font-medium transition-colors duration-100 cursor-default select-none disabled:cursor-not-allowed ${variantClass[variant]} ${sizeClass[size]} ${className}`}
      {...rest}
    />
  );
}

export function IconButton({
  icon: Icon,
  label,
  size = 7,
  variant = "ghost",
  strokeWidth = 1.75,
  className = "",
  tooltip,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: LucideIcon;
  label: string;
  size?: number;
  /** primary 为 DESIGN 允许的填色用途（如圆形发送钮），焦点走反色描边；ghost 为默认弱按钮 */
  variant?: "ghost" | "primary";
  strokeWidth?: number;
  /** 提供时用 Radix 提示原语呈现（悬停/聚焦均可见），不再叠加原生 title */
  tooltip?: string;
}) {
  // size 6 走共享命中区下限类（随尺度派生但不低于 24px）；其余沿尺寸阶梯
  const sizeClass = size === 6 ? "hit-floor" : size === 8 ? "size-8" : "size-7";
  const variantClass =
    variant === "primary"
      ? "rounded-full focus-ring-inverse bg-primary text-primary-foreground hover:bg-primary/90 disabled:bg-primary/40"
      : "rounded-md text-subtle hover:text-foreground hover:bg-hover disabled:text-subtlest";
  const button = (
    <button
      aria-label={label}
      title={tooltip ? undefined : label}
      className={`inline-flex items-center justify-center transition-colors duration-100 cursor-default disabled:cursor-not-allowed ${variantClass} ${sizeClass} ${className}`}
      {...rest}
    >
      <Icon className="size-4" strokeWidth={strokeWidth} />
    </button>
  );
  if (!tooltip) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

export function ButtonGroup({ children }: { children: ReactNode }) {
  return <div className="inline-flex items-center gap-1">{children}</div>;
}
