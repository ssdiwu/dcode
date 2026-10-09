// 模态对话框基础原语（vendored）：来源 shadcn/ui new-york-v4 dialog.tsx。
// 固定来源：github.com/shadcn-ui/ui @ e8c3143b1cd191280befcd6c9538284bb43399a8（MIT），
// 文件 SHA256 2ade6074e5fad0a4eb171ead44c43d3301a3c83d186d7236fb1fdbea80ee556b。
// 本地修改：cn() 改为模板拼接；Radix 按组件分包导入；颜色/圆角/位置映射到 D Code DESIGN token
//（贴窗口 18vh，保留 app-dialog 宽度类）；去掉动画类与内建右上角关闭钮（退出动作由使用处显式给出，
// 取消不确认）；仅导出本片使用的子组件。

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";

function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogOverlay({ className = "", ...props }: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={`fixed inset-0 z-50 bg-foreground/10 ${className}`}
      {...props}
    />
  );
}

function DialogContent({
  className = "",
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={`app-dialog fixed left-1/2 top-[18vh] z-50 w-full -translate-x-1/2 rounded-2xl border border-border bg-popover p-5 shadow-lg outline-none ${className}`}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

function DialogTitle({ className = "", ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={`text-ui-lg font-semibold mb-3 ${className}`}
      {...props}
    />
  );
}

export { Dialog, DialogContent, DialogTitle };
