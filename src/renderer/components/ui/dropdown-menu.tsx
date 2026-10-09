// 下拉菜单基础原语（vendored）：来源 shadcn/ui new-york-v4 dropdown-menu.tsx。
// 固定来源：github.com/shadcn-ui/ui @ e8c3143b1cd191280befcd6c9538284bb43399a8（MIT），
// 文件 SHA256 d954efb735f13734751207ad22cb0cddd7f6ec53c59d16675d103dae08cb61fb。
// 本地修改：cn() 改为模板拼接；Radix 按组件分包导入（未引 radix-ui 统一入口的其余部分）；
// 颜色/圆角/字号映射到 D Code DESIGN token；去掉 tw-animate-css 动画类（减少动态效果遵守）；
// 仅导出本片使用的子组件（Root/Portal/Trigger/Content/Group/Label/Item/RadioGroup/RadioItem/Separator）。

import * as React from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";

function DropdownMenu({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  return <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

function DropdownMenuTrigger({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  return <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

function DropdownMenuContent({
  className = "",
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        className={`z-50 min-w-44 overflow-y-auto rounded-lg border border-border bg-popover py-1 shadow-md ${className}`}
        style={{ maxHeight: "var(--radix-dropdown-menu-content-available-height)" }}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

function DropdownMenuGroup({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Group>) {
  return <DropdownMenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />;
}

function DropdownMenuItem({
  className = "",
  variant = "default",
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  variant?: "default" | "destructive";
}) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-variant={variant}
      className={`flex w-full cursor-default select-none items-center px-3 h-7 text-ui-sm text-left outline-hidden transition-colors duration-75 data-[disabled]:pointer-events-none data-[disabled]:text-subtlest data-[highlighted]:bg-hover ${
        variant === "destructive" ? "text-destructive data-[highlighted]:bg-destructive/10" : "text-foreground"
      } ${className}`}
      {...props}
    />
  );
}

function DropdownMenuRadioGroup({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>) {
  return <DropdownMenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />;
}

function DropdownMenuRadioItem({
  className = "",
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={`relative flex w-full cursor-default select-none items-center px-3 pl-8 h-7 text-ui-sm text-foreground outline-hidden transition-colors duration-75 data-[disabled]:pointer-events-none data-[disabled]:text-subtlest data-[highlighted]:bg-hover ${className}`}
      {...props}
    >
      <span className="pointer-events-none absolute left-2.5 flex size-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          {/* 空 inline span 不应用 width/height，选中圆点会零宽；显式 block 保留实际可见标记。 */}
          <span className="block size-2 rounded-full bg-foreground" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  );
}

function DropdownMenuLabel({
  className = "",
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label>) {
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-label"
      className={`px-3 pt-1.5 pb-0.5 text-ui-xs text-subtlest ${className}`}
      {...props}
    />
  );
}

function DropdownMenuSeparator({
  className = "",
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={`mx-1 my-1 h-px bg-border ${className}`}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
};
