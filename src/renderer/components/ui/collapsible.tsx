// 折叠基础原语（vendored）：来源 shadcn/ui collapsible.tsx。
// 固定来源：github.com/vercel/ai-elements @ 6a9d5b1822ffb10bba4bd97175f01edd7d8651cd
//   packages/shadcn-ui/components/ui/collapsible.tsx（该目录是 shadcn/ui 的 MIT 子集再发布），
//   上游文件 SHA256 c6598e5584f4258b5d9fefadbc5ad6a66888ad58729f4b634a0bb2d9c513188b。
// 许可证 MIT（Copyright (c) 2023 shadcn，原文见 licenses/shadcn-ui/LICENSE.md）。
// 本地修改：上游从统一入口 `radix-ui` 取 Collapsible；改为按组件分包导入
// @radix-ui/react-collapsible，与本目录 dropdown/dialog/tooltip 的既有写法一致，
// 避免把 radix-ui 全量聚合包拉进 renderer 依赖。

import * as React from "react";
import * as CollapsiblePrimitive from "@radix-ui/react-collapsible";

function Collapsible(props: React.ComponentProps<typeof CollapsiblePrimitive.Root>) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}

function CollapsibleTrigger(
  props: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger>,
) {
  return <CollapsiblePrimitive.CollapsibleTrigger data-slot="collapsible-trigger" {...props} />;
}

function CollapsibleContent(
  props: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>,
) {
  return <CollapsiblePrimitive.CollapsibleContent data-slot="collapsible-content" {...props} />;
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
