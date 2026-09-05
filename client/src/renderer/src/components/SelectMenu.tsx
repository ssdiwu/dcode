import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown } from "lucide-react";

/**
 * 设计系统风格的紧凑下拉（Radix DropdownMenu 原语）：
 * 触发器为文字按钮（当前值 + 下箭头），菜单面板与选中勾选对齐
 * ZCode / shadcn 的视觉语义。
 */
export function SelectMenu<T extends string>({
  value,
  options,
  placeholder,
  ariaLabel,
  accent,
  onChange,
}: {
  value: T | null;
  options: { value: T; label: string }[];
  placeholder: string;
  ariaLabel: string;
  accent?: boolean;
  onChange: (value: T) => void;
}) {
  const current = options.find(option => option.value === value);
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          aria-label={ariaLabel}
          className={`flex h-6 max-w-[260px] items-center gap-1 rounded-md px-1.5 text-[11px] leading-none hover:bg-ink/5 ${
            accent ? "text-accent" : "text-muted"
          }`}
        >
          <span className="min-w-0 truncate">
            {current ? current.label : placeholder}
          </span>
          <ChevronDown size={12} className="shrink-0 opacity-70" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="start"
          sideOffset={6}
          className="z-50 max-h-[320px] min-w-[220px] overflow-y-auto rounded-lg border border-line bg-raised p-1 shadow-xl"
        >
          {options.map(option => (
            <DropdownMenu.Item
              key={option.value}
              onSelect={() => onChange(option.value)}
              className="flex h-7 cursor-pointer items-center gap-2 rounded-md px-2 text-[12px] outline-none data-[highlighted]:bg-accent-fill data-[highlighted]:text-accent"
            >
              <span className="w-3.5 shrink-0">
                {option.value === value ? <Check size={12} /> : null}
              </span>
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
