# ZCode 交互组件借鉴

## 核对范围与结论

2026-10-07 按 507“先看 ZCode 有哪些交互组件，我们先抄”的要求核对。沿用已选固定提交 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`，本地研究副本检出一致且无改动；不是声称已审最新主分支。枚举两个通用组件目录，并追到本轮相关业务使用位置、依赖和出处记录；没有运行上游或 D Code 窗口，也没有安装依赖或导入组件。

结论：直接复用成熟基础原语，借 ZCode 的实际页面组合，再接 D Code 的正式接口。当前 D Code 的 Menu／Dialog 等仍是独立实现，[第三方材料](../THIRD_PARTY_NOTICES.md) 明确尚未移植 shadcn、ai-elements 或 ZCode 业务组件。因此“已经参考其设计”与“已使用其组件能力”不同；本轮建议将既有分层取用方向落实到下面的具体入口。

- `components/ui/` 有 43 个 TSX 文件，混合基础原语、预览器、品牌图形及本地扩展，不能统称为 43 个可直接搬的 shadcn 原语。
- `components/ai-elements/` 有 45 个 TSX 文件，包含上游派生与本地拆分、预览、Markdown 扩展；目录存在不证明业务页正在使用每个组件。
- `src/` 根目录另有 111 个 TSX 文件，业务组件还分布在 v4、prompt-editor、app-shell、settings 等子目录；该数字不是全部业务组件数。本轮深入核对与输入、工具、布局、任务、归档、设置、终端及快捷入口直接相关的入口，未宣称逐一审读所有业务实现。
- 上述是源码文件数，与 D Code [92 项交互定义](../spec/页面与交互组件.md) 不是一一对应关系。

## 第一批优先取用

| D Code 需要的交互 | ZCode 具体来源与已核做法 | 取用方式与必要适配 | 对应控件 |
|---|---|---|---|
| 按钮与复合输入 | [button / input-group](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/components/ui/input-group.tsx)，另有 input、textarea、button-group；将输入、附加操作与主按钮组合在一个容器 | 基础原语按已确认策略从 shadcn 上游按需取；颜色、圆角、字号与几何映射到 D Code token，不直接复制另一套数值 | C01–C06、S07–S08、F01–F04 |
| 菜单、弹窗与提示 | [dropdown-menu](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/components/ui/dropdown-menu.tsx)、[dialog](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/components/ui/dialog.tsx)、[popover](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/components/ui/popover.tsx)、tooltip；使用 Radix 原语，浮层有 Portal（独立挂载层）、边界避让与键盘结构，弹窗还明确 no-drag（不被窗口拖拽命中） | 优先替换手写的基础焦点／浮层机制，保留 D Code 对 Esc、触发点恢复、行内动作不冒泡的要求；弹窗确认不等于引入权限模式 | N07、C03、F 组、K 组与所有浮层 |
| 选择器及标签页 | [select](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/components/ui/select.tsx)、tabs、switch、checkbox、accordion、collapsible | 复用已有选择与展开原语，用于主题、启动、模型与分组；没有实际需求的控件不因目录有文件就加入页面 | S03–S06、P02、P06、M01 |
| 会话输入壳与唯一主按钮 | [ConversationComposer](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/v4/ConversationComposer.tsx#L1123) + [ChatPromptEditor](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/prompt-editor/ChatPromptEditor.tsx#L413)；实际业务经 submitControl 插槽提供唯一发送／运行控制 | 借结构和状态分工；实际操作改接 D Code 发送／暂停／继续。先保留现有文本输入，Lexical、附件、提及与斜杠功能只在对应需求成立时再取，不整搬业务依赖 | C01–C06 |
| 工具摘要与详情 | [ToolSummaryRow](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/ToolCallBlocks/ToolSummaryRow.tsx) + [ToolCallBody](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/ToolCallBlocks/ToolCallBody.tsx)；摘要、展开、可选动作、状态和细节分开 | 按 Pi 实际记录投影到 D Code 的工具块；复用布局与折叠，保留错误复制和真实文件关联，工具完成不等于任务验收。审批状态和 ZCode 特有工具操作不带入 | T04–T06 |
| 消息正文与代码 | [message](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/components/ai-elements/message.tsx)、[code-block](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/components/ai-elements/code-block.tsx)，实际 MessageResponse 被会话行及工具正文使用；涉及 Streamdown、CJK（中日韩文字支持）与代码高亮 | ai-elements 上游按需取基础阅读部件，文件链接、主题与字号适配 D Code；不要复制其编辑器偏好、浏览器与服务类型。超出已确认范围的消息操作另列候选 | T01、I03、P03–P05 |

这批取用有直接收益：现有菜单和弹窗的手写逻辑较多，输入主按钮又与刚确认的行为不一致。先处理这些真实缺口，再扩展到下表；已有悬浮输入卡片和滚动修复继续作为可回退基线。

## 主按钮与滚动：必须看实际调用

[ConversationComposer 的发送条件](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/v4/ConversationComposer.tsx#L1123) 将提交中的 pending 与工作忙碌时的输入路由分开；`canSend` 检查草稿、路由、附件及当前提交配置，`showStopControl = canStop && !hasDraftToSubmit`。[实际按钮分支](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/v4/ConversationComposer.tsx#L2064) 在同一位置二选一呈现运行控制或发送。它支持 D Code 已确认 A 的呈现方式，但其 Stop（停止）动作不是 Pi 的暂停契约；不能复制其 Esc 停止快捷键覆盖我们设置、菜单和气泡的退出语义。

通用 [PromptInputSubmit](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/components/ai-elements/prompt-input-buttons.tsx) 也有状态按钮，但当前 checkout 的 src 中检索到的该符号只有定义；实际会话经 ConversationComposer → ChatPromptEditor 的 submitControl 使用自定义分支。不能因为某个库文件名字合适，就把它当作实际页面的全部行为。

实际消息区是 [ConversationTimeline](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/v4/ConversationTimeline.tsx#L1743)：独立滚动视口、虚拟历史、流式尾部、滚动锚定及 [同视口 sticky 输入 dock](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/v4/ConversationTimeline.tsx#L1908)（贴底输入容器）一起配合。ai-elements 的 conversation 文件虽然存在，本轮未找到其被该实际时间线直接使用的证据。D Code 已有同视口悬浮卡片，后续借鉴应针对长内容、贴底与用户向上阅读的实际缺口，不以换一个通用 Conversation 组件宣称滚动问题解决。

## 第二批：逐项适配，不整页移植

| 范围 | 实际来源／依赖 | 可借与暂不带入 |
|---|---|---|
| 分栏拖宽与布局恢复 | [resizable](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/components/ui/resizable.tsx) 使用 react-resizable-panels 与 useDefaultLayout；[WorkspaceShellLayout](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/app-shell/WorkspaceShellLayout.tsx#L1648) 实际嵌套主体横纵分栏 | 可作为 N09／I04／E05 的首个验证候选；侧栏本身另有指针及键盘分隔条，不是全壳统一依赖该封装。布局保存与 D Code 界面状态需明确一个所有者；不直接复制整份外壳或增加另一套布局存储 |
| 文件差异与预览 | [diff-viewer](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/components/ui/diff-viewer.tsx)、lightweight-diff-preview、code-viewer、PreviewPane；包含 @pierre/diffs 与高亮适配 | 借 I01–I04 的选择、只读差异、完整路径和返回；原始文件／差异证据仍从 D Code 获取。PDF、PPTX、Office 等专门预览仅在具体需要成立时纳入 |
| 任务行、菜单与归档 | [TaskActionMenuContent](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/TaskActionMenuContent.tsx#L100)、TaskListItemContextMenu、[WorkspaceArchivedTasksFlatSection](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/WorkspaceArchivedTasksFlatSection.tsx#L217) | 借“归档入口→归档列表→查看／恢复”的呈现，对应 N 与 L 组；重写为 D Code 空间→任务→会话归属。ZCode 还有单项删除和清空已归档功能，这些不进入首版 |
| 快捷入口 | [command](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/components/ui/command.tsx) 封装 cmdk；[CommandCenterDialog](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/command-center/CommandCenterDialog.tsx) 组合命令、会话与文件结果 | 可复用搜索、分组、空态、选中及键盘结构，但 D Code 首版仅常用操作与任务名称。TaskFindDialog 实际用于当前会话／改动查找，不能仅凭文件名把它当成我们的任务导航 |
| 设置表单 | [SettingsPage](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/SettingsPage.tsx) 与 settings 子组件依赖自身服务、账户及套餐 | 借分区、表单行和状态反馈，基础输入仍走共同原语。真实配置、保存、连接与执行分别反馈；账户、支付与全套服务装配不复制 |
| 内置终端 | [Terminal](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/Terminal.tsx)、terminal/TerminalSession 与 terminalPanelState；依赖 xterm，按 workspace identity 保留终端组 | 借 E 组的组内切换、收起及工作目录呈现；进程、退出与历史保存接 D Code 自己的宿主接口。保留标签页不证明跨退出恢复了原进程 |
| 协作图与任务详情 | ai-elements 的 node、edge、canvas、panel，及自有 workflow 相关组件 | 第一版只读图只筛节点、关系和详情呈现；不搬流程编辑器、拖线派工、工作流调度或额外运行事实。是否使用图形库由实际复杂度验证 |

ZCode 当前主体分栏的现成来源是 react-resizable-panels；Motion Panels 仍是之前收录的候选。先核该已有实现能否满足 D Code 的拖宽、恢复和键盘要求，再比较其他库，避免同时引入两套面板机制。未完成当前 Electron／React 客户端的集成或性能验证。

## 暂不取用的内容与原因

- 品牌图形 GlmMonochromeIcon、ZCodeAboutLogo：品牌属于 ZCode，D Code 延续自己的视觉与资产。
- confirmation 及工具的用户审批呈现、权限模式选择：与 D Code 已确认的主会话无产品权限模式不符；普通确认弹窗原语仍可用于真正需要用户确认的操作。
- workspace tab（工作空间标签页）、系统多窗口与完整侧聊栏：不覆盖当前空间根树、可隐藏任务面板与悬浮侧问。
- archived 列表的永久删除／清空：与本轮 A“可恢复归档”不符。
- 登录、套餐、Stripe 支付、升级提醒：没有对应的当前 D Code 产品要求。
- workflow 编辑器、自动化／错峰任务、全部专用工具渲染器：不能由 UI 复制扩大执行底座、调度或后台运行范围。
- persona、语音、媒体制作与 Office 专门编辑／预览：本轮没有足以支持一并引入的具体闭环；保留按需候选，不为数量完整导入全部目录。

## 来源与落地要求

根 [LICENSE](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/LICENSE) 为 Apache-2.0。[copied-components.json](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/third-party/copied-components.json) 记录 shadcn 的 MIT 与 ai-elements 的 Apache-2.0 来源，并明确两组原始导入 revision 未记录；其中固定的 referenceRevision 是许可／来源参照，不得登记成已知的最初复制版本。具体文件头和局部变更仍需逐项核对，不能用目录名统一宣称许可。

执行时沿已确认分层：基础原语从 shadcn 上游取，AI 对话原语从 ai-elements 上游取，ZCode 业务组件提取实际所需部分并适配。每次实际导入锁定我们采用的版本，登记文件来源、许可、保留的声明与本地修改；本轮没有导入代码，故 [第三方材料](../THIRD_PARTY_NOTICES.md) 继续如实保留“尚未移植”的状态。

取用时先保留同一份界面行为和适配边界，再验证键盘／焦点、13／14px、双语、窄窗口、失败与未知状态。代码通过检查不等于视觉已接受；组件库本身也不能替代 D Code 的输入回执、暂停与归档验证。后台用例按相关场景复用隔离窗口，不为每个组件另开一次客户端。

## 目录清单

下列文件名来自固定版本目录枚举；用来查找候选，不表示全部已深入审查、获得采用确认或完成移植。

### ui（43 个 TSX 文件）

`GlmMonochromeIcon.tsx`、`ZCodeAboutLogo.tsx`、`accordion.tsx`、`alert-dialog.tsx`、`alert.tsx`、`avatar.tsx`、`badge.tsx`、`button-group.tsx`、`button.tsx`、`card.tsx`、`chart.tsx`、`checkbox.tsx`、`code-viewer.tsx`、`collapsible.tsx`、`command.tsx`、`context-menu.tsx`、`dialog.tsx`、`diff-viewer.tsx`、`dropdown-menu.tsx`、`flip-metric-value.tsx`、`highlighted-lightweight-diff-preview.tsx`、`hover-card.tsx`、`input-group.tsx`、`input.tsx`、`kbd.tsx`、`label.tsx`、`lightweight-diff-preview.tsx`、`pdf-viewer.tsx`、`popover.tsx`、`pptx-preview-viewer.tsx`、`pptx-selection-action-bar.tsx`、`progress.tsx`、`resizable.tsx`、`scroll-area.tsx`、`scroll-fade-viewport.tsx`、`select.tsx`、`separator.tsx`、`spinner.tsx`、`switch.tsx`、`tabs.tsx`、`textarea.tsx`、`toast.tsx`、`tooltip.tsx`

### ai-elements（45 个 TSX 文件）

`agent.tsx`、`artifact.tsx`、`attachments.tsx`、`canvas.tsx`、`chat-loading.tsx`、`checkpoint.tsx`、`code-block.tsx`、`commit.tsx`、`confirmation.tsx`、`connection.tsx`、`context.tsx`、`controls.tsx`、`conversation.tsx`、`diagram-preview-dialog.tsx`、`edge.tsx`、`image-preview-dialog.tsx`、`image-thumbnail-gallery.tsx`、`image.tsx`、`markdown-blockquote.tsx`、`markdown-image.tsx`、`markdown-list.tsx`、`markdown-table.tsx`、`mermaid-block.tsx`、`message.tsx`、`node.tsx`、`panel.tsx`、`persona.tsx`、`plan.tsx`、`prompt-input-actions.tsx`、`prompt-input-buttons.tsx`、`prompt-input-primitives.tsx`、`prompt-input-textarea.tsx`、`prompt-input.tsx`、`queue.tsx`、`reasoning.tsx`、`sandbox.tsx`、`shimmer.tsx`、`snippet.tsx`、`sources.tsx`、`suggestion.tsx`、`task.tsx`、`terminal.tsx`、`test-results.tsx`、`tool.tsx`、`toolbar.tsx`


## 验证边界

本轮确认了来源目录、相关实际调用分支、依赖声明、许可记录和 D Code 对应缺口；未运行上游、未运行 D Code 窗口、未安装包、未移植代码、未访问真实模型。线上读取 provenance 清单遇到缓存缺失，采用已核到固定 HEAD 且工作树干净的本地同版本文件；核心主按钮与菜单源码的固定 GitHub 链接也已读取。静态分支证明源码如何组织，不宣称全部交互在当前机器上已经验收。

独立只读复核已确认目录数量与清单、核心主按钮／输入插槽／实际滚动调用、归档取舍及来源记录的表述，未发现剩余报告阻塞。复核没有运行代码或改变依赖；可交付的是本轮研究与规格，不能将其登记为组件移植或产品验收通过。
