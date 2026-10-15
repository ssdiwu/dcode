// 复合输入区（vendored + 适配）：来源 vercel/ai-elements prompt-input.tsx。
// 固定来源：github.com/vercel/ai-elements @ 6a9d5b1822ffb10bba4bd97175f01edd7d8651cd
//   packages/elements/src/prompt-input.tsx，文件 SHA256 cf43baf5baa444b4ae06d250643b3fb2efd329c85f9b31a43e3aaf481dd27305。
// 许可证 Apache-2.0（Copyright 2023 Vercel, Inc.）。
//
// 本地修改（D Code 与上游规则的差异逐项说明，依据 spec/页面与交互组件.md 的 C 组）：
//  1. 删除附件、截图、Command、HoverCard、Select、Tab 等子组件：D Code 没有已确认的
//     附件／语音／标签页输入需求，不引入 nanoid、File API 通路与无消费者的入口。
//  2. 删除 PromptInputProvider 与其 controller/context：草稿的唯一事实来源在 App 的
//     drafts（已持久化、按草稿键管理），再引入第二份输入状态会造成双写。
//  3. 删除 PromptInputSubmit：上游按 AI SDK 的 ChatStatus 在同一按钮上切换 submit/Stop，
//     且 type 在运行时改变。D Code 的 C01 状态表按「实际运行约束 + 本次输入」推导
//     发送／暂停／继续互斥，暂停另有同一次手势的防重，由 Composer 自己渲染主按钮；
//     2026-10-10 起运行控制只有这个位置，菜单内不再有暂停／继续。
//  4. 删除「提交即清空」：上游 onSubmit 走 textInput.clear()。D Code 只在收到
//     accepted 回执后才清草稿；未接收／待核对必须保留原文（spec C02 / T02 / T03）。
//  5. 保留上游的结构性质：form + PromptInputTextarea(header/footer addons) 组合、
//     Enter→提交、Shift+Enter→换行、输入法组合期间不提交、空文本不提交、onSubmit 可 preventDefault。
//  6. 外壳圆角取 2xl（DESIGN「有明确用途的独立大壳」），焦点由 .composer-surface 单框承担。
//  7. 新增 afterSurface 插槽：渲染在输入表面之外、仍属本表单的一段内容。
//     C06 状态说明经此排在卡片之外（与已认可原型的 .composer-hint 位于 .composer 之外同构）：
//     放在卡片内时长文案会与输入行争同一行宽度——负剩余空间下 flex-basis:0 的编辑区被压成 0 宽，
//     说明变长也会挤走输入宽度。移到卡片外后二者互不影响。

import { Children, type ComponentProps, type FormEventHandler, type KeyboardEventHandler, type ReactNode } from "react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "../ui/input-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

export type PromptInputProps = {
  /** 提交：调用方决定是否成立。D Code 的「已接收才清草稿」规则在 Composer 内实现。 */
  onSubmit?: FormEventHandler<HTMLFormElement>;
  /** 作用于 <form> 本身（默认无视觉样式） */
  className?: string;
  /** 作用于承载表面与焦点框的 InputGroup（磨砂、投影、弱环等） */
  surfaceClassName?: string;
  /** 渲染在输入表面之外、仍属本表单的一段内容（见文件头本地修改 7） */
  afterSurface?: ReactNode;
  children: ReactNode;
};

/**
 * 复合输入外壳。<form> 只提供「Enter 提交」这一条键盘路径与浏览器原生语义，
 * 实际提交是否成立由 onSubmit 决定（调用方可在 disabled 时直接 return）。
 * 表面与唯一的焦点框都在内层 InputGroup 上（.input-surface / .composer-surface），
 * form 自身不参与布局，避免出现第二层内边距。
 */
export function PromptInput({ className = "", surfaceClassName = "", afterSurface, onSubmit, children }: PromptInputProps) {
  return (
    <form
      data-slot="prompt-input"
      className={`block w-full ${className}`}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit?.(event);
      }}
    >
      <InputGroup
        className={`composer-surface input-surface rounded-2xl border border-border bg-input p-3 shadow-sm ${surfaceClassName}`}
      >
        {children}
      </InputGroup>
      {afterSurface}
    </form>
  );
}

export type PromptInputTextareaProps = ComponentProps<typeof InputGroupTextarea> & {
  /** 调用方跟踪的输入法组合态。与 nativeEvent.isComposing 同时判定：
   *  部分浏览器在候选确认的 Enter 上提前把 isComposing 置 false。 */
  isComposing?: boolean;
};

/**
 * 文字编辑区。
 * Enter 尝试提交；Shift+Enter 换行；输入法组合或候选确认期间不提交（多行输入的 Shift+Enter 只换行）。
 * 不做「提交即清空」——清空时机由回执决定，见文件头说明 4。
 */
export const PromptInputTextarea = ({
  isComposing,
  className = "",
  onKeyDown,
  ...props
}: PromptInputTextareaProps) => {
  const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = (event) => {
    onKeyDown?.(event);
    // 调用方已 preventDefault 时不再自行提交（上游同规则）
    if (event.defaultPrevented) return;
    if (event.key === "Enter" && !event.shiftKey && !isComposing && !event.nativeEvent.isComposing) {
      event.preventDefault();
      // 沿同一提交通路。表单内没有 submit 按钮：主按钮是 type="button"，
      // 其 disabled 由 C01 状态表直接给出，这里只让 Enter 走 trySend
      event.currentTarget.form?.requestSubmit();
    }
  };
  return (
    <InputGroupTextarea
      className={`composer-input ${className}`}
      onKeyDown={handleKeyDown}
      {...props}
    />
  );
};

export type PromptInputHeaderProps = ComponentProps<typeof InputGroupAddon>;

/** 输入区顶部区域（当前 D Code 未使用；保留上游结构位以免重新发明同构容器）。 */
export const PromptInputHeader = ({ className = "", ...props }: PromptInputHeaderProps) => (
  <InputGroupAddon align="block-start" className={`flex-wrap ${className}`} {...props} />
);

export type PromptInputFooterProps = ComponentProps<typeof InputGroupAddon>;

/** 输入区底部操作行：左侧状态说明，右侧主按钮与次级菜单。 */
export const PromptInputFooter = ({ className = "", ...props }: PromptInputFooterProps) => (
  <InputGroupAddon align="block-end" className={`mt-1.5 ${className}`} {...props} />
);

export type PromptInputToolsProps = ComponentProps<"div">;

export const PromptInputTools = ({ className = "", ...props }: PromptInputToolsProps) => (
  <div className={`flex min-w-0 items-center gap-1 ${className}`} {...props} />
);

export type PromptInputButtonProps = ComponentProps<typeof InputGroupButton> & {
  tooltip?: string;
  /** 无可见文字的图标按钮必须给出可访问名称（DESIGN：图标在需要文字时不能独自承担含义） */
  label?: string;
  /** 圆形（用于主运行按钮这一类有形状用途的目标） */
  round?: boolean;
};

export const PromptInputButton = ({ tooltip, round = false, label, className = "", size, children, ...props }: PromptInputButtonProps) => {
  const resolvedSize = size ?? (Children.count(children) > 1 ? "sm" : "icon-sm");
  const button = (
    <InputGroupButton
      aria-label={label}
      size={resolvedSize}
      className={`${round ? "rounded-full" : ""} ${className}`}
      {...props}
    >
      {children}
    </InputGroupButton>
  );
  if (!tooltip) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
};

export type PromptInputActionMenuProps = ComponentProps<typeof DropdownMenu>;
export const PromptInputActionMenu = (props: PromptInputActionMenuProps) => <DropdownMenu {...props} />;

export type PromptInputActionMenuTriggerProps = PromptInputButtonProps;

export const PromptInputActionMenuTrigger = ({ children, ...props }: PromptInputActionMenuTriggerProps) => (
  <DropdownMenuTrigger asChild>
    <PromptInputButton {...props}>{children}</PromptInputButton>
  </DropdownMenuTrigger>
);

export type PromptInputActionMenuContentProps = ComponentProps<typeof DropdownMenuContent>;

export const PromptInputActionMenuContent = ({ className = "", ...props }: PromptInputActionMenuContentProps) => (
  <DropdownMenuContent className={`${className}`} {...props} />
);
