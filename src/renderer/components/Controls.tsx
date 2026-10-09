// 表单控件原语：步进器、分段选择、开关行。输入表面统一走 input-surface 焦点规则。

import { Minus, Plus } from "lucide-react";
import { IconButton } from "./Button";
import { useT } from "../i18n";

export function Stepper({
  value,
  min,
  max,
  step = 1,
  unit,
  onChange,
  label,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onChange: (value: number) => void;
  label: string;
}) {
  const t = useT();
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  return (
    <div
      className="input-surface inline-flex items-center gap-1 h-8 rounded-lg border border-border bg-input px-1"
      role="spinbutton"
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-label={label}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowDown") onChange(clamp(value - step));
        if (event.key === "ArrowRight" || event.key === "ArrowUp") onChange(clamp(value + step));
      }}
    >
      <IconButton icon={Minus} label={t("common.decrease")} size={6} onClick={() => onChange(clamp(value - step))} />
      <span className="min-w-12 text-center text-ui-sm tabular-nums">
        {value}
        {unit}
      </span>
      <IconButton icon={Plus} label={t("common.increase")} size={6} onClick={() => onChange(clamp(value + step))} />
    </div>
  );
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="input-surface inline-flex h-8 items-center gap-0.5 rounded-lg border border-border bg-input p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.value}
          role="radio"
          aria-checked={value === option.value}
          className={`h-6.5 px-2.5 rounded-md text-ui-sm cursor-default transition-colors duration-100 ${
            value === option.value
              ? "bg-card text-foreground shadow-sm"
              : "text-subtle hover:text-foreground"
          }`}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function SettingsRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6 py-3 border-b border-border last:border-b-0">
      <div className="min-w-0">
        <div className="text-ui-base">{label}</div>
        {hint && <div className="text-ui-sm text-subtle mt-0.5">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
