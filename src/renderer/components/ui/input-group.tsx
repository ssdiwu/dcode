// 复合输入基础原语（vendored）：来源 shadcn/ui input-group.tsx。
// 固定来源：github.com/vercel/ai-elements @ 6a9d5b1822ffb10bba4bd97175f01edd7d8651cd
//   packages/shadcn-ui/components/ui/input-group.tsx（该目录是 shadcn/ui 的 MIT 子集再发布），
//   上游文件 SHA256 d347e89600f0750a438f31559c85bb91833eeef51a56e70c2af5ef5d8d2acdd2。
// 许可证 MIT（Copyright (c) 2023 shadcn，原文见 licenses/shadcn-ui/LICENSE.md）。
//
// 本地修改（逐项说明，均登记在 THIRD_PARTY_NOTICES）：
//  1. cn() 改模板拼接；class-variance-authority 的两个变体表改普通 Record，
//     与本目录 dropdown/dialog/tooltip 的既有写法一致（不新增 cva 依赖）。
//  2. 上游 InputGroup/InputGroupInput/InputGroupTextarea 依赖 shadcn 的 Button/Input/Textarea；
//     改用 D Code 自己的 token 类（text-ui-* 字阶、border/bg-input、DESIGN 圆角档），
//     按钮直接渲染 <button>，不经过本项目 Button（其 size 档与 InputGroup 的 icon-xs/icon-sm 不同）。
//  3. 焦点：上游用「容器 ring-[3px] + 控件 focus-visible:ring-0」的成对写法。
//     D Code 规定复合输入只有一个焦点框（DESIGN 共享控件规则），故容器不再自绘 ring，
//     焦点由 .input-surface / .composer-surface 承担，控件自身不加任何焦点环。
//  4. 内边距：外壳负责唯一的 12px 内缩（g(12)），addon 与 textarea 不再各自加内边距，
//     否则文字与按钮会相对外壳多缩进一层。

import * as React from "react";

type Align = "inline-start" | "inline-end" | "block-start" | "block-end";

const addonAlignClass: Record<Align, string> = {
  "inline-start": "order-first items-center pl-0",
  "inline-end": "order-last items-center pr-0",
  // block 方向：外壳已经是纵向 flex，addon 不再重复 padding，只负责换行与对齐
  "block-start": "order-first w-full items-center justify-start",
  "block-end": "order-last w-full items-center justify-between",
};

const buttonSizeClass: Record<string, string> = {
  xs: "h-6 px-2 rounded-md gap-1 text-ui-sm [&>svg:not([class*='size-'])]:size-3.5",
  sm: "h-8 px-2.5 rounded-lg gap-1.5 text-ui-base [&>svg:not([class*='size-'])]:size-4",
  "icon-xs": "hit-floor rounded-md p-0",
  "icon-sm": "size-8 rounded-lg p-0 [&>svg:not([class*='size-'])]:size-4",
};

function InputGroup({ className = "", ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-group"
      role="group"
      // min-w-0：复合输入在窄主区不被 flex 压成竖带；has-[>textarea]:h-auto 让高度随内容
      className={`flex w-full min-w-0 flex-col items-stretch rounded-2xl border border-border bg-input shadow-sm
        focus-within:border-border-strong ${className}`}
      {...props}
    />
  );
}

function InputGroupAddon({
  className = "",
  align = "inline-start",
  ...props
}: React.ComponentProps<"div"> & { align?: Align }) {
  return (
    <div
      role="group"
      data-slot="input-group-addon"
      data-align={align}
      className={`flex gap-1 select-none ${addonAlignClass[align]} ${className}`}
      {...props}
    />
  );
}

function InputGroupButton({
  className = "",
  type = "button",
  variant = "ghost",
  size = "xs",
  ...props
}: React.ComponentProps<"button"> & { variant?: "ghost" | "primary"; size?: string }) {
  const variantClass =
    variant === "primary"
      // 填色主按钮的焦点描边走反色（focus-ring-inverse），见 styles.css 的全局焦点规则
      ? "focus-ring-inverse bg-primary text-primary-foreground hover:bg-primary/90 disabled:bg-primary/40"
      : "text-subtle hover:text-foreground hover:bg-hover disabled:text-subtlest";
  return (
    <button
      type={type}
      data-slot="input-group-button"
      data-size={size}
      data-variant={variant}
      className={`inline-flex shrink-0 items-center justify-center whitespace-nowrap font-medium
        transition-colors duration-100 cursor-default select-none
        disabled:cursor-not-allowed ${variantClass} ${buttonSizeClass[size] ?? buttonSizeClass.xs} ${className}`}
      {...props}
    />
  );
}

function InputGroupText({ className = "", ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="input-group-text"
      className={`flex min-w-0 items-center gap-1.5 text-ui-xs text-subtlest [&_svg]:pointer-events-none ${className}`}
      {...props}
    />
  );
}

/** 文字编辑区：外壳已提供唯一的 12px 内缩与焦点环，这里不再加边框、内边距或焦点环。 */
function InputGroupTextarea({ className = "", ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="input-group-control"
      className={`w-full min-w-0 flex-1 resize-none border-0 bg-transparent p-0 shadow-none
        text-ui-base leading-normal outline-none placeholder:text-subtlest ${className}`}
      {...props}
    />
  );
}

export { InputGroup, InputGroupAddon, InputGroupButton, InputGroupText, InputGroupTextarea };
