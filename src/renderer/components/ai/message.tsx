// 消息（vendored + 适配）：来源 vercel/ai-elements message.tsx。
// 固定来源：github.com/vercel/ai-elements @ 6a9d5b1822ffb10bba4bd97175f01edd7d8651cd
//   packages/elements/src/message.tsx，文件 SHA256 19c7755740e116f221e4247f7b6d4f20b57a44e4c4fcf66d2db5e1f111476509。
// 许可证 Apache-2.0（Copyright 2023 Vercel, Inc.）。
//
// 本地修改：
//  1. 删除 MessageBranch* / MessageToolbar / MessageAction*：D Code 是单时间线、单一运行记录，
//     没有分支、重试分支或消息级操作栏的已确认产品要求；不引入无消费者的入口。
//  2. from 的类型由 UIMessage["role"]（来自 ai 包）改为 D Code 契约的角色联合，
//     因此本文件不再依赖 AI SDK 的类型包——执行底座仍是 Pi，界面不引入 AI SDK 聊天后端。
//  3. MessageResponse 只挂 cjk 与 code 两个插件：中文正文需要 CJK 断行规则，
//     代码需要语法高亮。math（katex）与 mermaid 在 D Code 没有已确认用途，不安装。
//  4. 用户气泡由上游 bg-secondary 改为 D Code 抬升表面 --raised；助手正文不加容器，
//     阅读层级交给 .prose-dcode 排版层（字阶与行高沿用 DESIGN 共享值）。
// 5. CodeFence 的原文提取改为递归收集 hast 子树的 text 节点。早先只读 node.children[0].value，
//    而 children[0] 是 code 元素（value 为 undefined，文本在其 children 里），
//    结果正文里的代码围栏渲染成空白；证据与断言见 test/runtime/message-code-fence.test.ts。
// 6. 正文代码块补语言标注与复制入口（spec T01 复制保持原文），并给未闭合围栏的伪语言标注兜底。

import { memo, type ComponentProps } from "react";
import { Streamdown } from "streamdown";
import { cjk } from "@streamdown/cjk";
import { CodeBlock, CodeBlockActions, CodeBlockCopyButton, CodeBlockFilename, CodeBlockHeader } from "./code-block";
import { useT } from "../../i18n";

/** 与 contracts 的 TimelineBlock["message"]["role"] 对应；本地声明避免依赖 AI SDK 类型包。 */
export type MessageRole = "user" | "assistant";

export type MessageProps = React.HTMLAttributes<HTMLDivElement> & { from: MessageRole };

export const Message = ({ className = "", from, ...props }: MessageProps) => (
  <div
    data-slot="message"
    data-from={from}
    // 消息占满阅读列的可用宽度（用户气泡靠 ml-auto 靠右），正文对齐由 MessageContent 决定
    className={`flex w-full flex-col gap-2 ${from === "user" ? "is-user ml-auto items-end" : "is-assistant items-start"} ${className}`}
    {...props}
  />
);

export type MessageContentProps = React.HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({ className = "", ...props }: MessageContentProps) => (
  <div
    data-slot="message-content"
    className={`flex min-w-0 max-w-full flex-col gap-2 ${
      // 用户消息有表面（--raised）与圆角，是「我说的话」；助手消息没有容器，直接落在阅读列上，
      // 避免每条回复再套一层框（DESIGN：不给每个布局包装加卡片）
      "group-[.is-user]:ml-auto group-[.is-user]:max-w-[85%] group-[.is-user]:rounded-xl group-[.is-user]:bg-raised group-[.is-user]:px-3.5 group-[.is-user]:py-2.5 group-[.is-user]:shadow-[var(--shadow-float)] group-[.is-user]:text-foreground group-[.is-assistant]:w-full group-[.is-assistant]:text-foreground"
    } ${className}`}
    {...props}
  />
);

// 只挂 cjk 插件：中文正文需要 CJK 断行与标点规则。
// 代码高亮不挂上游 code 插件（它静态 import shiki，会把约 1.4MB 推进首屏主包），
// 改由下面的 pre 覆盖用本项目 vendored 的 CodeBlock 渲染，shiki 按需加载。
const streamdownPlugins = { cjk };

interface HastNode {
  type?: string;
  value?: unknown;
  tagName?: string;
  properties?: { className?: unknown; [key: string]: unknown };
  children?: HastNode[];
}

/**
 * 递归取 hast 子树的原文：hast 的文本在任意深度的 text 节点上（pre > code > text，
 * Streamdown 的 harden 插件还会再包一层），不能只看直接子节点的 value。
 * 根因：早先只读 children[0].value，而 children[0] 是 code 元素（value 为 undefined），
 * 代码块因此渲染成空白；这里以真实渲染为准逐层收集。
 */
function hastText(node: HastNode | undefined): string {
  if (!node) return "";
  if (typeof node.value === "string") return node.value;
  let text = "";
  for (const child of node.children ?? []) text += hastText(child);
  return text;
}

/** 从 pre 节点里找到 code 元素（围栏的原始文本与语言类名都在它身上）。 */
function codeElement(node: HastNode | undefined): HastNode | undefined {
  const find = (current: HastNode | undefined): HastNode | undefined => {
    if (!current) return undefined;
    if (current.tagName === "code") return current;
    for (const child of current.children ?? []) {
      const hit = find(child);
      if (hit) return hit;
    }
    return undefined;
  };
  return find(node);
};

/**
 * Markdown 代码围栏的渲染：从 hast 节点取出原始代码与语言，交给 D Code 的 CodeBlock。
 * 原始文本取自节点本身而不是 React children——后者已经被上游内置组件拆散，
 * 会丢失空格与换行（DESIGN：保留原文与对应关系；spec T01 阅读/选取/复制保持原文）。
 * 无 hast 节点时（例如非 Streamdown 的直接调用）才退回 children 文本。
 */
function CodeFence(props: ComponentProps<"pre"> & { node?: unknown }) {
  const t = useT();
  const node = props.node as HastNode | undefined;
  const codeNode = codeElement(node);
  const className = Array.isArray(codeNode?.properties?.className) ? (codeNode.properties.className as string[]) : [];
  const declared = className.find((c) => typeof c === "string" && c.startsWith("language-"))?.slice("language-".length);
  // 流式解析未闭合围栏时，标注可能带上正文里的字符（实测出现过 `language-」`）。
  // 只有像语言标识的取值才算语言，否则按纯文本处理，不把正文当语言名传给高亮。
  const language = declared && /^[a-z0-9][a-z0-9#+._-]*$/i.test(declared) ? declared : "text";
  const code = node ? hastText(codeNode) : "";
  // 围栏的收尾换行是行终止符，不是作者写的一行空行；按 Markdown 语义去掉一个尾随 \n，
  // 否则代码块底部多出一个空行、复制结果也多一个换行。
  const source = code.endsWith("\n") ? code.slice(0, -1) : code;
  return (
    <CodeBlock code={source} language={language}>
      {/* 语言与复制：spec T01「阅读、选取与复制保持原文」。复制写入的是未改写的 source，
          行渲染靠 display:block 承担换行，不依赖浏览器对块级元素插入换行的复制行为。 */}
      <CodeBlockHeader>
        <CodeBlockFilename>{language === "text" ? t("message.plainCode") : language}</CodeBlockFilename>
        <CodeBlockActions>
          <CodeBlockCopyButton
            code={source}
            label={t("message.copyCode")}
            copiedLabel={t("message.codeCopied")}
            failedLabel={t("message.copyCodeFailed")}
          />
        </CodeBlockActions>
      </CodeBlockHeader>
    </CodeBlock>
  );
}

const streamdownComponents = { pre: CodeFence };

/** 透传 Streamdown 自身属性（其 props 不是 HTMLAttributes，直接用组件的 ComponentProps）。 */
export type MessageResponseProps = Omit<ComponentProps<typeof Streamdown>, "children" | "plugins" | "className"> & {
  children: string;
  className?: string;
};

/**
 * 正文容器。
 * Streamdown 会丢弃未识别的 DOM 属性，因此 data-slot 由这一层薄包装承载：
 * E2E 与验收按它定位「末尾正文容器」，不依赖 Tailwind 类名或上游内部结构。
 * 包装本身不带样式，排版仍由 .prose-dcode 承担。
 */
export const MessageResponse = memo(
  ({ className = "", children, ...props }: MessageResponseProps) => (
    <div data-slot="message-body">
      <Streamdown className={`prose-dcode ${className}`} plugins={streamdownPlugins} components={streamdownComponents} {...props}>
        {children}
      </Streamdown>
    </div>
  ),
  (prev, next) => prev.children === next.children && next.mode === prev.mode,
);
MessageResponse.displayName = "MessageResponse";
