# 第三方材料

当前重新设计工作区包含原创设计文档、架构检查工具、Electron 客户端与 Pi 运行切片。TypeScript 5.9.3 使用 Apache-2.0；新增 `@earendil-works/pi-durable`、`@earendil-works/pi-ai`、`@earendil-works/chord` 均固定 1.0.0、MIT，npm gitHead 均为 `a13d35a742c6ef8462812a28fbe1d8c8b7431c32`。依赖调用仅使用公开入口，未修改第三方安装包；提示模板参数算法的有限适配及许可另见下方登记。精确版本、传递依赖与下载完整性由 package-lock.json 记录。shadcn/ui 的菜单/弹窗/提示基础原语已按下方「本片移植的组件文件」逐文件移植并登记；ai-elements 与 ZCode 业务组件尚未移植，未引入其品牌资产。

新增 ESLint、typescript-eslint、tsx 与 Node.js 类型声明按 package-lock.json 固定，使用 MIT，仅用于验证；各安装包保留原许可。后续实际分发仍须保留分发依赖的许可声明。

## 客户端实际引入的依赖

以下版本与当前安装包及锁文件核对，未修改包内实现；分发时保留各依赖自带的许可与第三方声明。共享控件来自本项目独立 UI 实现，不因设计参考相同就登记为上游移植。

| 包 | 版本 | 包声明许可 | 用途 |
|---|---|---|---|
| react / react-dom | 19.2.0 | MIT | 界面渲染 |
| lucide-react | 0.545.0 | ISC | 图标 |
| @radix-ui/react-dropdown-menu / @radix-ui/react-dialog / @radix-ui/react-tooltip | 2.1.25 / 1.2.0 / 1.3.0 | MIT | 菜单、模态弹窗与提示的宿主原语（经下方 vendored 适配层组合，实际使用规则见 architecture-policy 的 renderer externals 登记） |
| electron | 41.0.3 | MIT | Mac 客户端壳；其运行文件另附第三方许可 |
| electron-vite / vite / @vitejs/plugin-react | 4.0.1 / 7.1.9 / 5.0.4 | MIT | 构建与开发启动 |
| tailwindcss / @tailwindcss/vite | 4.1.14 | MIT | 共享样式 |
| playwright-core | 1.56.1 | Apache-2.0 | Electron 端到端验证 |
| esbuild | 0.25.12 | MIT | 构建与契约验证 |
| eslint-plugin-react-hooks | 7.1.1 | MIT | React Hooks 规则，兼容主树 ESLint 10.12.0 |
| @types/react / @types/react-dom | 19.2.2 / 19.2.1 | MIT | 开发类型声明 |
| diff | 8.0.4 | BSD-3-Clause | 已安装的固定版本转为直接依赖；真实工具前后文本差异与公开统一补丁解析，未修改包内实现 |

## 本片移植的组件文件（2026-10-07 组件接续第一片）

基础原语按已确认策略取自 shadcn/ui 上游（不搬 ZCode 本地改本；ZCode 固定研究副本只作适配参照，其 provenance 的 `referenceRevision` 只作许可参照，未记录初始复制版本，本表不登记为 importRevision）。固定来源：`github.com/shadcn-ui/ui @ e8c3143b1cd191280befcd6c9538284bb43399a8`（`apps/v4/registry/new-york-v4/ui/`），许可证 MIT（Copyright (c) 2023 shadcn，完整原文保留于 [licenses/shadcn-ui/LICENSE.md](licenses/shadcn-ui/LICENSE.md)，SHA-256 `1564074e13439397221ffd522e2e504d56561994a23d371aa5e3ad43e4f5423f`）。每个移植文件保留原作者与许可归属、在文件头追加 D Code 本地修改说明。

| D Code 文件 | 上游文件 SHA256 | 主要本地修改 |
|---|---|---|
| src/renderer/components/ui/dropdown-menu.tsx | d954efb735f13734751207ad22cb0cddd7f6ec53c59d16675d103dae08cb61fb | cn() 改模板拼接；Radix 改按组件分包导入；颜色/圆角/字号映射 D Code DESIGN token；去 tw-animate-css 动画类（减少动态效果遵守）；仅导出本片使用的子组件；RadioItem 选中圆点显式 block，避免空 inline span 零尺寸 |
| src/renderer/components/ui/dialog.tsx | 2ade6074e5fad0a4eb171ead44c43d3301a3c83d186d7236fb1fdbea80ee556b | 同上；另：去内建右上角关闭钮与内部 button.tsx 依赖（退出动作由使用处显式给出）；位置沿用 D Code 贴窗 18vh 与 app-dialog 宽度类 |
| src/renderer/components/ui/tooltip.tsx | 611e4305879b2773eafe76bf3c5caa69d8e47367fd97887a71634a27828f4433 | 同上；delayDuration 定 400ms |

ai-elements 与 ZCode 业务组件本片未移植（工具块只借投影/分层结论，消息正文、编辑器、附件等不纳入）；`@radix-ui/react-slot` 安装后经核对无直接消费者，已移除。

## 本片移植的组件文件（2026-10-09 界面层次与成熟组件接入）

### 来源与许可

AI 对话原语取自 [vercel/ai-elements](https://github.com/vercel/ai-elements/tree/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd)，**Apache-2.0**（Copyright 2023 Vercel, Inc.）；基础原语取自同一仓库内的 `packages/shadcn-ui`（shadcn/ui 的 MIT 子集再发布），**MIT**（Copyright (c) 2023 shadcn，完整原文保留于 [licenses/shadcn-ui/LICENSE.md](licenses/shadcn-ui/LICENSE.md)）。两者均已核对固定提交与逐文件 SHA256；执行底座仍为 Pi SDK 1.0.0，未引入 AI SDK 的聊天后端。

### 逐文件登记

| D Code 文件 | 上游文件 | 上游 SHA256 | 主要本地修改 |
|---|---|---|---|
| src/renderer/components/ui/input-group.tsx | `packages/shadcn-ui/components/ui/input-group.tsx` | d347e89600f0750a438f31559c85bb91833eeef51a56e70c2af5ef5d8d2acdd2 | `cn()` 改模板拼接；`class-variance-authority` 变体表改普通 Record（不新增 cva 依赖）；依赖 shadcn 的 Button/Input/Textarea 改为 D Code token 类；删除上游「容器 ring-[3px] + 控件 ring-0」的成对焦点写法，复合输入只保留一个焦点框；内边距统一由外壳承担 |
| src/renderer/components/ui/collapsible.tsx | `packages/shadcn-ui/components/ui/collapsible.tsx` | c6598e5584f4258b5d9fefadbc5ad6a66888ad58729f4b634a0bb2d9c513188b | 上游从统一入口 `radix-ui` 导入，改为分包 `@radix-ui/react-collapsible` |
| src/renderer/components/ai/message.tsx | `packages/elements/src/message.tsx` | 19c7755740e116f221e4247f7b6d4f20b57a44e4c4fcf66d2db5e1f111476509 | 删除 MessageBranch/MessageToolbar/MessageAction（D Code 无分支与消息级操作要求）；`from` 改为本地角色联合，去掉 `ai` 类型包依赖；插件只保留 cjk，代码走本项目 CodeBlock；助手正文不加容器表面；**代码围栏原文改为递归收集 hast 子树的 text 节点**（只读 `children[0].value` 会渲染出空白代码块）；补语言标注与复制入口，并对未闭合围栏的伪语言标注兜底 |
| src/renderer/components/ai/code-block.tsx | `packages/elements/src/code-block.tsx` | 5c7285171c5aa741749a1642a85f492a9b5e80dc4ccb704b5c3f58c45efebd04 | 删除基于 Radix Select 的语言选择器（无消费者）；表面改为 D Code token；`cn()` 改模板拼接；复制按钮复用 D Code 交互规则并如实反馈失败；**shiki 改为按需 `import()`**，高亮引擎与语言分片不在首屏加载；**高亮缓存键改用完整原文**（原「长度+头尾各 100 字」会让仅中间不同的两段代码共用高亮）；**缓存命中也通知订阅者**（否则后挂载的代码块永远停在未高亮文本）；**改用 shiki 的 JavaScript 正则引擎、按官方别名识别语言、并对未知语言降级为纯文本**（默认 WASM 引擎在本项目 file:// 渲染进程里无法初始化；`ts` 等别名不在 `bundledLanguagesInfo` 的正式 id 里，曾被误判为未知——两者叠加使代码高亮从未真正生效）；**改为正式双主题 CSS 变量输出并把背景交回 D Code 下沉表面**（原先浅色写进内联 `color` 而强制变量未定义，浅色下关键字与注释同色；`pre` 的内联浅色背景在暗色下会变成浅字白底）；**移除 `dark:!text-…` 强制工具类**，配色改由 `styles.css` 的 `[data-slot="code-block"]` 规则消费变量（该工具类被包在 `prefers-color-scheme:dark` 的 media 里，而本项目手动深色只切 `html.dark`，会导致手动深色仍是浅色配色）；复制按钮的 `code` 不再作为 DOM 属性透传 |
| src/renderer/components/ai/prompt-input.tsx | `packages/elements/src/prompt-input.tsx` | cf43baf5baa444b4ae06d250643b3fb2efd329c85f9b31a43e3aaf481dd27305 | 删除附件/截图/Command/HoverCard/Select/Tab 子组件与 `PromptInputProvider`（草稿事实源在 App 的 drafts，不引入第二份输入状态）；删除 `PromptInputSubmit`（其 Stop 语义与 `type` 切换不符合 D Code C01 状态表）；**删除「提交即清空」**，草稿只在 accepted 回执后清除；保留 form + header/footer addons + Enter/Shift+Enter/输入法组合规则 |
| src/renderer/components/ai/tool.tsx | `packages/elements/src/tool.tsx` | 5b520e0c33792cba0ceb04e1cb18c69b212cffacdb52d7297e292c7af568dda4 | 删除 ToolInput（契约无输入字段）；不采用上游 AI SDK 的 statusLabels/statusIcons（英文硬编码且含审批语义），状态徽标改由调用方按真实执行记录传入；字符串输出不再按 JSON 上色，原始输出原样保留 |

### 新增运行时依赖

| 包 | 版本 | 许可 | 用途 |
|---|---|---|---|
| streamdown | 2.7.0 | Apache-2.0 | 消息正文渲染（GFM、流式未闭合解析、代码围栏结构） |
| @streamdown/cjk | 1.0.2 | Apache-2.0 | 中文正文的 CJK 断行与标点规则 |
| shiki | 4.5.0 | MIT | 代码语法高亮（按需加载：首次出现代码块时才 import） |
| @radix-ui/react-collapsible | 1.1.12 | MIT | 工具块展开/收起的宿主原语 |

已评估但**未引入**：`@streamdown/math`（katex）与 `@streamdown/mermaid`、`ai`、`use-stick-to-bottom`、`nanoid`、`class-variance-authority`、`@streamdown/code`。前两项在 D Code 无已确认用途，后四项由本地实现或既有滚动实现替代，避免顺带引入尚未实现的功能入口。

**体积取舍（实测）**：renderer 主包由 935 kB 增至约 1.99 MB，增量主要来自 Streamdown 的 Markdown 管线（micromark/mdast/hast/rehype），这是接入 MessageResponse 的必要成本。Shiki 引擎（约 380 kB）与 300+ 语言分片已拆为独立 chunk，仅在界面出现代码块时按需加载，首屏不加载。

[DESIGN.md](DESIGN.md#组件来源) 记录组件来源方案，[规范借鉴说明](doc/规范借鉴说明.md#参考材料的使用层次) 记录参考材料分层。实际引入时逐文件登记上游路径、采用的固定版本、适用许可、保留的声明及本地修改；候选组件和书签不登记为已采用代码。

旧实现的第三方声明保留在 [0.0.37 封档](https://github.com/ssdiwu/dcode/blob/7c97a7526ba5bca4527c98db85375dc4403edd9c/THIRD_PARTY_NOTICES.md)，不表示这些组件已进入新工作区。

## Pi 提示模板参数算法（2026-10-14）

`src/adapters/pi/prompt-templates.ts` 的引号分组与单次参数替换适配自锁定 Pi 1.0.0 的 [core/prompt-templates.ts](https://github.com/earendil-works/pi/blob/a13d35a742c6ef8462812a28fbe1d8c8b7431c32/packages/coding-agent/src/core/prompt-templates.ts)。该算法未由包根导出，当前没有越界导入内部模块或另建会话循环；资源语法解析复用公开 `parseFrontmatter`。MIT，Copyright (c) 2025 Mario Zechner；完整许可保留于 [licenses/pi-coding-agent/LICENSE.txt](licenses/pi-coding-agent/LICENSE.txt)。项目与应用模板的发现／范围校验、有限失败、输入身份及暂停／恢复由 D Code 承接，未照搬宿主个人配置扫描。
