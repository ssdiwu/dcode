// 下拉菜单与模态对话框：统一走 vendored 基础原语（见 components/ui/，来源登记在 THIRD_PARTY_NOTICES）。
// 焦点与 Esc 规则统一在这里，页面不自行实现：
// - Esc／点击外部只关闭当前浮层，不做其他动作；关闭会把焦点还回触发点（原实现一致）。
// - 触发点在树行等容器内时，点击冒泡止步于行内按钮，不得被父行当作选中或展开。

import { useRef, type ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Dialog as DialogRoot, DialogContent, DialogTitle } from "./ui/dialog";

export interface MenuItem {
  label: string;
  destructive?: boolean;
  disabled?: boolean;
  onSelect?: (trigger: HTMLElement | null) => void;
}

/** 焦点沿用原实现的回落链：优先触发钮；触发钮随行失焦隐藏时回落最近可见可聚焦祖先（如树行本体）。 */
function focusTriggerWithFallback(container: HTMLElement | null): void {
  const previous = container?.querySelector<HTMLElement>("button");
  if (!previous || !previous.isConnected) return;
  const usable = (el: HTMLElement | null | undefined): boolean => !!el && el.isConnected && el.offsetParent !== null;
  if (usable(previous)) {
    previous.focus();
    return;
  }
  const fallback = previous.parentElement?.closest<HTMLElement>("[role='treeitem'], [tabindex], button");
  if (fallback && usable(fallback)) fallback.focus();
}

export function Menu({
  trigger,
  items,
  align = "start",
  side = "down",
}: {
  trigger: ReactNode;
  items: MenuItem[];
  align?: "start" | "end";
  /** 默认向下展开；贴底触发点（如会话输入卡片内的菜单）须向上展开，避免被滚动容器裁切 */
  side?: "down" | "up";
}) {
  const triggerRef = useRef<HTMLSpanElement>(null);

  return (
    <DropdownMenu modal={false}>
      <span ref={triggerRef} className="inline-flex">
        {/* 触发点击阻止冒泡：树行/列表项内的菜单开启不得被父行当作选中或展开（E2E 复现后修复） */}
        <DropdownMenuTrigger asChild onClick={(event) => event.stopPropagation()}>
          {trigger}
        </DropdownMenuTrigger>
      </span>
      <DropdownMenuContent
        align={align}
        side={side === "up" ? "top" : "bottom"}
        // Portal 中的菜单项点击仍会沿 React 组件树冒泡到侧栏行；选择用途不能顺手展开空间。
        onClick={(event) => event.stopPropagation()}
        onCloseAutoFocus={(event) => {
          // 自管恢复：Radix 默认只聚焦触发钮本体；触发钮随行隐藏时需要回落到原行（原实现语义）
          event.preventDefault();
          focusTriggerWithFallback(triggerRef.current);
        }}
      >
        {items.map((item) => (
          <DropdownMenuItem
            key={item.label}
            variant={item.destructive ? "destructive" : "default"}
            disabled={item.disabled}
            onSelect={() => item.onSelect?.(triggerRef.current?.querySelector("button") ?? null)}
          >
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Dialog({
  title,
  children,
  actions,
  onClose,
  restoreFocusTo,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
  /** 菜单项中打开对话框时，原菜单项会卸载；调用处可提供仍在树中的触发钮。 */
  restoreFocusTo?: HTMLElement | null;
}) {
  // 原实现的恢复语义：打开前的持焦点在渲染时捕获（打开对话框的动作发生后、面板挂载前）；
  // 行内触发钮隐藏时回落到最近可见可聚焦祖先（如树行本体）。
  const restoreRef = useRef<HTMLElement | null>(null);
  if (restoreRef.current === null && typeof document !== "undefined") {
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  return (
    <DialogRoot open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const previous = restoreFocusTo ?? restoreRef.current;
          // 延后到 rAF：对话框输入框移除时浏览器会把焦点重置回 body，过早恢复会被盖掉；
          // 用户已另作选择（焦点在别处且不在 body）时不强拉
          requestAnimationFrame(() => {
            if (!previous || !previous.isConnected) return;
            const now = document.activeElement;
            if (now && now !== document.body) return;
            const usable = (el: HTMLElement | null | undefined): boolean =>
              !!el && el.isConnected && el.offsetParent !== null;
            if (usable(previous)) {
              previous.focus();
              return;
            }
            const fallback = previous.parentElement?.closest<HTMLElement>("[role='treeitem'], [tabindex], button");
            if (fallback && usable(fallback)) fallback.focus();
          });
        }}
      >
        <DialogTitle>{title}</DialogTitle>
        <div className="text-ui-base">{children}</div>
        {actions && <div className="mt-4 flex justify-end gap-2">{actions}</div>}
      </DialogContent>
    </DialogRoot>
  );
}
