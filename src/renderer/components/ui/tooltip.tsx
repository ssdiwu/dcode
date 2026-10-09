// 悬停/聚焦提示基础原语（vendored）：来源 shadcn/ui new-york-v4 tooltip.tsx。
// 固定来源：github.com/shadcn-ui/ui @ e8c3143b1cd191280befcd6c9538284bb43399a8（MIT），
// 文件 SHA256 611e4305879b2773eafe76bf3c5caa69d8e47367fd97887a71634a27828f4433。
// 本地修改：cn() 改为模板拼接；Radix 按组件分包导入；字号映射到 D Code DESIGN token；去掉动画类；
// delayDuration 取 400ms（避免鼠标掠过即弹出）。

import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";

function TooltipProvider({
  delayDuration = 400,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider data-slot="tooltip-provider" delayDuration={delayDuration} {...props} />;
}

function Tooltip({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

function TooltipTrigger({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipContent({
  className = "",
  sideOffset = 6,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={`z-50 w-fit rounded-md bg-foreground px-2.5 py-1 text-ui-xs text-background shadow-md ${className}`}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
