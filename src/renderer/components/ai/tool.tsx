// 工具块组合（vendored + 适配）：来源 vercel/ai-elements tool.tsx。
// 固定来源：github.com/vercel/ai-elements @ 6a9d5b1822ffb10bba4bd97175f01edd7d8651cd
//   packages/elements/src/tool.tsx，文件 SHA256 5b520e0c33792cba0ceb04e1cb18c69b212cffacdb52d7297e292c7af568dda4。
// 许可证 Apache-2.0（Copyright 2023 Vercel, Inc.）。
//
// 本地修改：
//  1. 删除 ToolInput：contracts 的 ToolBlockData 没有输入参数字段，没有消费者；
//     不为了「看起来完整」显示 D Code 实际拿不到的数据。
//  2. 不采用上游 statusLabels / statusIcons / getStatusBadge：它们是 AI SDK 的 part state，
//     文案硬编码英文且带 approval（审批）语义。D Code 的运行事实来自 Pi 的 ToolStatus
//     （running/done/failed/waiting），状态词必须走界面 i18n，且不引入审批入口。
//     状态徽标改由调用方按真实记录传入，本文件只提供容器与展开结构。
//  3. ToolOutput 不再把字符串输出当 JSON 上色：tool.output 是 Pi 记录的原始输出，
//     必须原样保留（DESIGN：保留原始工具输出）。按等宽纯文本呈现，长行横向滚动。
//  4. 表面改为 D Code token（--raised 抬升表面 + 弱边缘），去掉上游 mb-4/not-prose
//     等依赖外部排版配置的类；圆角取内层容器档 g(10)。

import type { ComponentProps, ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className = "", ...props }: ToolProps) => (
  <Collapsible
    data-slot="tool"
    // group-data-[state=open] 供 ChevronDown 旋转；过渡 100ms 与 DESIGN「展开指示箭头」一致
    className={`group w-full overflow-hidden rounded-lg bg-raised shadow-[var(--shadow-sm)] ring-1 ring-[var(--edge)] ${className}`}
    {...props}
  />
);

export type ToolHeaderProps = ComponentProps<typeof CollapsibleTrigger> & {
  /** 由调用方提供的真实状态呈现（图标 + 文字）；本组件不推断状态 */
  status?: ReactNode;
  /** 工具名：来自 Pi 记录的 name，原样显示 */
  name: string;
  /** 折叠态单行摘要（仅可截断的那一段文字） */
  summary: ReactNode;
  /** 摘要右侧的次级信息（文件计数等），在截断之外，始终可读 */
  meta?: ReactNode;
};

export const ToolHeader = ({ className = "", status, name, summary, meta, children, ...props }: ToolHeaderProps) => (
  <CollapsibleTrigger
    className={`flex w-full cursor-default select-none items-center gap-2 px-3 h-9 text-left transition-colors duration-75 hover:bg-hover ${className}`}
    {...props}
  >
    {children}
    {/* 工具名用等宽小字，是「哪一类工具」的稳定识别；摘要承担可读信息，不靠名字承担 */}
    <span className="shrink-0 font-mono text-ui-xs uppercase text-subtlest">{name}</span>
    <span className="min-w-0 flex-1 truncate text-ui-sm text-subtle">{summary}</span>
    {meta && <span className="shrink-0">{meta}</span>}
    {status && <span className="flex shrink-0 items-center gap-1.5">{status}</span>}
    <ChevronDown className="size-3.5 shrink-0 text-subtlest transition-transform duration-100 group-data-[state=open]:rotate-180" />
  </CollapsibleTrigger>
);

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

/** 展开内容：靠表面与留白分层，不给内容再描一圈边。 */
export const ToolContent = ({ className = "", ...props }: ToolContentProps) => (
  <CollapsibleContent className={`px-3 pb-3 pt-2.5 ${className}`} {...props} />
);

export type ToolOutputProps = {
  /** 工具原始输出，原样呈现 */
  output: string;
  /** 失败时的可复制错误正文（与 output 同一份真实记录） */
  errorText?: string;
  /** 折叠尾部的操作区（复制错误等），由调用方给出 */
  actions?: ReactNode;
};

export const ToolOutput = ({ output, errorText, actions }: ToolOutputProps) => {
  if (!output && !errorText) return null;
  return (
    <div className="space-y-2">
      {errorText ? (
        <div className="rounded-lg bg-destructive/8 px-3 py-2">
          <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-ui-sm leading-[1.83] text-destructive">{errorText}</pre>
        </div>
      ) : (
        <pre className="overflow-x-auto rounded-lg bg-sunken px-3 py-2.5 font-mono text-ui-sm leading-[1.83] text-subtle shadow-[var(--shadow-inset-well)] whitespace-pre-wrap">
          {output}
        </pre>
      )}
      {actions}
    </div>
  );
};
