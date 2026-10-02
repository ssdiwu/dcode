# ZCode 可见组件与 D Code 对照

初次核对日期：2026-09-28；D Code 进度补记于 2026-09-29，十项候选在 2026-10-01 重新核对。ZCode 源码固定在 [`29628c9`](https://github.com/zai-org/ZCode/tree/29628c9acdb81b703bbd4080c207a0e7ce5e276e)，2026-10-01 官方 main 仍指向该 revision；下方编号总表的 D Code 对照保留 `main@456a1c2` 调研时的历史基线，当前 `0.0.37` 未提交实现及本轮研究见补记。这里列的是可供产品取舍的**用户可见组合组件**，不枚举按钮、图标、弹层基础件等内部原子组件。源码存在、需求已写、实现完成和真实界面验收是不同状态。

“已列入 0.0.36”指 [PRD 0033](../40-版本实施方案/0033-0.0.36-协作过程可视化与工作台质感产品需求.md)或 [PRD 0034](../40-版本实施方案/0034-0.0.36-任务内工作流产品需求.md)已有相应用户行为，**不表示已实现或已选定移植该源码文件**。编号总表中的“待选”是初次研究时的状态；2026-10-02 已全部获选并分入后续两版，当前归宿见本轮范围更新。已有能力仍可借鉴呈现细节，但不能写成 D Code 缺少该能力。

## 工作台与文件

| 编号 | ZCode 组件与源码 | 用户看到或操作什么 | D Code 当前对照 | 建议归宿 |
|---|---|---|---|---|
| Z01 | [WorkspaceSidebar](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/WorkspaceSidebar.tsx) | 项目、会话与主要入口侧栏 | 已有项目／任务侧栏 | 已列入 0.0.36 的层级与当前项打磨；参考布局 |
| Z02 | [WorkspaceGroupedTasksSection](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/WorkspaceGroupedTasksSection.tsx) | 分组任务及长列表浏览 | 已有项目与最近任务；暂无同等分组拖动需求 | 待选；长列表确有性能问题时再验证虚拟化 |
| Z03 | [WorkspaceHeader](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/WorkspaceHeader.tsx) | 工作区标题、身份和就近动作 | 已有 Task／Session 顶部信息 | 已列入 0.0.36 的信息层级打磨 |
| Z04 | [WorkspaceShellLayout](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/app-shell/WorkspaceShellLayout.tsx) | 侧栏、对话、侧窗与底部区域的布局 | 已有自有工作台布局和检查器 | 仅参照布局规则；不整体移植产品壳 |
| Z05 | [WorkspaceFileTree](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/workspace-file-tree/WorkspaceFileTree.tsx) | 项目文件树与选择 | 已有文件树与打开路径 | 仅比较可读性、选中和窄窗状态 |
| Z06 | [GitPane](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/GitPane.tsx) | 变更列表及审查入口 | 已有 Git 文件列表与 Diff | 仅比较变更卡片和审查导航 |
| Z07 | [PreviewPane](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/PreviewPane.tsx) | 文件或媒体预览 | 已有 Markdown／HTML／图片预览 | 仅比较预览布局；0.0.35 优先修现有漂移 |
| Z08 | [SidePaneTerminalPane](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/SidePaneTerminalPane.tsx) | 独立交互终端面板 | 目前只在执行过程查看命令输出 | 待选；需另立终端权限与生命周期合同 |

## 输入与会话

| 编号 | ZCode 组件与源码 | 用户看到或操作什么 | D Code 当前对照 | 建议归宿 |
|---|---|---|---|---|
| Z09 | [ChatPromptEditor](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/prompt-editor/ChatPromptEditor.tsx) | 输入文本、草稿与触发菜单 | 已有 Composer | 已列入 0.0.36 的输入层级与焦点打磨 |
| Z10 | [ChatPromptActionMenu](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/prompt-editor/ChatPromptActionMenu.tsx) | “＋”分区添加附件、目标、工作流和可调用内容 | 当前“＋”有图片／文件／技能或命令 | 已列入 0.0.36；优先借鉴共享 React 组件模式 |
| Z11 | [MentionPanel](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/mentions/components/MentionPanel.tsx) | 分组搜索、加载、空态、错误与键盘选择 | 当前有命令面板和成员候选 | 已列入 0.0.36；适配 D Code 的真实候选目录 |
| Z12 | [mentionPanelRouting](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/mentions/mentionPanelRouting.ts) | 输入符号触发不同类型的候选 | `/` 混合查找；`@` 定向成员；无 `$` | `@` 文件、`/` 技能和 `$` 已创建成员均已列入 0.0.36 |
| Z13 | [V4ComposerToolbar](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/v4/composer/V4ComposerToolbar.tsx) | 模型、模式和输入区动作 | 已有模型选择与发送区动作 | 已列入 0.0.36 的密度与说明打磨；不复制权限模式 |
| Z14 | [ConversationComposer](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/v4/ConversationComposer.tsx) | 组合草稿、附件、发送和运行反馈 | Composer 已有这些基本路径 | 借组合方式和状态反馈；不替换 D Code 提交原文合同 |
| Z15 | [ChatMediaAttachmentPreviewDialog](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/ChatMediaAttachmentPreviewDialog.tsx) | 放大查看输入附件 | 已有附件缩略预览和移除 | 待选；先用现有附件路径实测是否缺放大查看 |
| Z16 | [ConversationTimeline](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/v4/ConversationTimeline.tsx) | 阅读消息、工具过程和结果 | 已有 Transcript 与执行过程 | 已列入 0.0.36 的过程分层；不重建会话事实 |
| Z17 | [ConversationTurnNavigator](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/v4/ConversationTurnNavigator.tsx) | 长对话按用户提问逐项跳转 | 已有 Conversation Rail 刻度 | 已列入 0.0.36；升级现有轨道 |
| Z18 | [useConversationTimelineFind](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/v4/useConversationTimelineFind.ts)／[conversationFindIndex](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/v4/conversationFindIndex.ts) | 在当前对话的用户输入和助手文本中查找、高亮并定位；不搜索工具输出 | 已有全局任务／消息搜索；非当前对话内查找 | 待选；若要定位工具输出错误，需另定索引范围 |
| Z19 | [ToolSummaryRow](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/ToolCallBlocks/ToolSummaryRow.tsx) | 工具动作的一行摘要、状态与展开入口 | 当前通用折叠执行记录 | 已列入 0.0.36 的动作摘要 |
| Z20 | [ConversationQueuePanel](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/v4/ConversationQueuePanel.tsx) | 查看等待处理的输入队列 | D Code 有协作交办／等待事实，未核定同类用户输入队列 | 待选；不可把成员等待冒充消息队列 |
| Z21 | [ConversationStatusPanel](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/v4/ConversationStatusPanel.tsx) | 会话当前目标、进度和状态 | 已有 Task HUD、Goal 与工作项 | 已列入 0.0.36 的概览层级；沿用 Task 事实 |
| Z22 | [ConversationFileSummaryPanel](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/v4/ConversationFileSummaryPanel.tsx) | 汇总一轮涉及的文件 | 已有文件树、Git Diff、产物与证据 | 待选；需明确“一轮涉及”的来源和去重规则 |

## 成员与工作流

| 编号 | ZCode 组件与源码 | 用户看到或操作什么 | D Code 当前对照 | 建议归宿 |
|---|---|---|---|---|
| Z23 | [WorkflowAgentPill](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/components/workflow-timeline/WorkflowAgentPill.tsx) | 成员身份、状态和活动的紧凑胶囊 | 当前为成员姓名及状态列表 | 已列入 0.0.36；优先比较 PI-Desktop 子代理卡与 ZCode 胶囊 |
| Z24 | [SubagentSessionSidePane](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/app-shell/SubagentSessionSidePane.tsx) | 进入或并排查看成员过程 | 已可进入成员子对话和检查器 | 已列入 0.0.36 的成员查看路径；侧窗几何仅参照 |
| Z25 | [SubagentDirectorySidePane](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/app-shell/SubagentDirectorySidePane.tsx) | 浏览可配置的子代理目录 | 已有 Agent Profile 设置与任务成员 | 仅比较目录可发现性；Profile 不能等同运行成员 |
| Z26 | [WorkflowTimeline](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/components/workflow-timeline/WorkflowTimeline.tsx) | 工作流阶段和成员执行轨道 | D Code 尚无真实工作流 UI | 已列入 0.0.36 的 Task 内工作流 |
| Z27 | [WorkflowRunSidePane](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/app-shell/WorkflowRunSidePane.tsx) | 工作流阶段、待回答问题、结果和产物，条件允许时可继续或停止 | D Code 尚无真实工作流 UI | 已列入 0.0.36；依赖 D Code 阶段与证据合同，不能单独移植侧窗即得运行能力 |
| Z28 | [SavedWorkflowsSection](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/settings/saved-workflows/SavedWorkflowsSection.tsx) | 全局或项目范围的已保存工作流，可直接启动或预填对话草稿 | 0.0.36 仅定义 Task 内工作流 | 后续候选；0.0.36 明确不做跨 Task 模板 |
| Z29 | [SavedWorkflowRunHistoryPanel](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/settings/saved-workflows/SavedWorkflowRunHistoryPanel.tsx) | 查看已保存工作流的跨任务运行历史 | 0.0.36 只要求同 Task 历史轮次 | 后续候选；不混入当前 Task 的运行历史 |

## 用量、权限与设置

| 编号 | ZCode 组件与源码 | 用户看到或操作什么 | D Code 当前对照 | 建议归宿 |
|---|---|---|---|---|
| Z30 | [contextUsage](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/chat-input-toolbar/contextUsage.tsx)／[CodingPlanContextUsage](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/chat-input-toolbar/CodingPlanContextUsage.tsx) | 输入区附近分区显示当前上下文已用／容量及可用时的套餐剩余额度 | Host 有当前 Runtime 上下文用量，客户端尚未呈现 | 已列入 0.0.36 的是当前会话上下文；套餐额度不随此项自动加入 |
| Z31 | [AppUsagePanel](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/settings/usage-stats/AppUsagePanel.tsx) | 应用级历史用量统计 | D Code 有模型调用用量事实，无同等统计页 | 待选；另立指标口径，不能把调用量当上下文占用 |
| Z32 | [PermissionDialog](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/PermissionDialog.tsx) | 在敏感动作前读取请求并作决定 | 已有结构化扩展请求；安全边界待修 | 0.0.35 修现有权限与焦点路径时比较，不新增 ZCode 访问模式 |
| Z33 | [SubagentsSection](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/settings/SubagentsSection.tsx) | 配置可复用子代理 | 已有 Agent Profile 设置 | 仅比较可理解性；不复制 ZCode 角色模型 |
| Z34 | [SkillsSection](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/settings/SkillsSection.tsx) | 查看与管理技能 | 已有本机技能与启停设置 | 仅比较说明、来源和错误反馈 |
| Z35 | [PluginsSection](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/settings/PluginsSection.tsx) | 浏览与管理插件 | 已有本机扩展包设置；无 ZCode 市场 | 市场暂缓；只比较已注册能力的呈现 |
| Z36 | [AutomationsSection](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/settings/AutomationsSection.tsx) | 创建或管理定时自动化 | D Code 当前无相应产品承诺 | 后续候选；不进入 0.0.36 |

## D Code 当前未提交实现进度

| 参照组件 | 主树对应实现 | 证据边界 |
|---|---|---|
| Z10–Z12、Z14 | `ComposerAddMenu`、`Composer`、`CommandMenu`：附件／目标／工作流；`/` 搜索技能、`@` 搜索项目文件、`$` 选同任务既有成员 | 隔离 Electron 菜单与文件引用路径通过；User Scope 暂不搜索 Home，显式目录登记未做；未直接移植 ZCode 源码文件 |
| Z16–Z17、Z19 | `Transcript`、`ConversationRail`、`ExecutionProcess`：过程分层与按用户提问跳转 | 定向自动和布局检查通过；长会话七次基线对照、507 视觉验收未完成 |
| Z21、Z23–Z24、Z26–Z27 | `TeamOverview`、`TaskWorkflowPanel` 与既有 Task HUD／成员子对话：成员、阶段、停止和继续 | Host 工作流身份、阶段与报告合同及隔离 Electron 基本路径接通；真实并行成员、证据收口和完整场景矩阵仍待验收 |
| Z30 | `ContextUsage`：当前 Session 的上下文估算圆环 | 用实际 usage 锚点和独立窗口检查；估算值与模型额度分别显示，整版性能与人工验收未完成 |

以上是按 D Code 自有对象和权限合同写的组件，并非 ZCode 源码移植；若后续决定逐文件移植，仍须重新核对对应许可证、资源与依赖。

## 本轮可作的取舍

- **0.0.36 已有行为目标，待选择具体借鉴文件**：Z09–Z14、Z16–Z17、Z19、Z21、Z23–Z24、Z26–Z27、Z30，以及 Z01／Z03 的局部层级。Z12 中的 `$` 只选择当前 Task 已创建成员，已由 507 确认。
- **先修现有能力**：Z07 对应的预览漂移与 Z32 对应的权限／焦点路径，落在 `0.0.35` 的现有功能及安全修复中。
- **2026-09-29 原候选研究范围，现已由 507 选择全部纳入**：Z02、Z08、Z15、Z18、Z20、Z22、Z28–Z29、Z31、Z36。研究与取舍见 [0.0.37 候选表](../40-版本实施方案/0037-0.0.37-ZCode-候选组件研究与取舍.md)；这些组件有额外产品行为或数据口径，不因源码可用就纳入当前 `0.0.36` 实现。
- **已有能力的视觉参照**：Z04–Z06、Z25、Z33–Z35；先比较真实窗口差异，再决定是否需要独立改动。

ZCode 第一方源码使用 [Apache-2.0](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/LICENSE)；[NOTICE](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/NOTICE.md) 指出字体、图标和其他第三方材料可能另有条件。对某一组件作源码级借鉴时，仍需核对它引用的样式、资源、运行时依赖和许可，再适配 D Code Product Store、状态与权限合同。

## 2026-10-01：十项候选源码复核

本轮对固定 revision 的 27 份组件、直接协作模块、manifest 和许可资料读取原文；[源码摘要清单](assets/zcode-candidate-source-check-2026-10-01.json)保存路径、固定 URL 与 SHA-256。D Code 对照为当前 `main@456a1c2` 加未提交 `0.0.37` 实现。本轮未运行 ZCode 桌面／后端，未触发终端、定时任务或收费服务；以下 ZCode 行为为源码事实，优先级为 D Code 的研究建议，未变更已确认实现范围。

### 修正旧对照

1. **附件放大并非缺失**：`Composer.tsx` 的受管附件可点预览，可信主进程通过 `attachment.resolve` 后调用 macOS `BrowserWindow.previewFile`；消息图片与生成图另有自有 `ImagePreview`。新候选应比较“App 内统一预览／状态”，不能再记为从零增加附件放大。具体系统格式仍需实测，源码入口不能证明每种文件均可预览。
2. **队列控制已有基础**：`CollaborationFeed.tsx` 已接通等待、暂停、取消、编辑及重排；Composer 区分“排到后面”和“补充当前工作”。可以借 ZCode 的输入区附近集中布局，运行语义须继续使用 D Code 已保存的消息事实。
3. **用量与工作流已有数据**：`provider-route-stream.ts` 保存完成调用的 usage，Product Store 按 call ID 取最新状态，且保留 Task／Session／Agent Run 归属。Task 工作流已有版本、阶段和运行历史。新页面需定义聚合口径及模板身份，不能写成已拥有 ZCode 的全局统计或跨任务模板。

### 当前对照与建议

| 候选 | 固定 ZCode 源码可确认的行为 | 当前 D Code 与可迁移部分 | 建议与前提 |
|---|---|---|---|
| **Z18 当前对话内查找** | [索引](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/v4/conversationFindIndex.ts)只收用户输入／助手正文；匹配有稳定行身份。配套 hook 缓存稳定轮次，按需补历史至 1200 行的自动加载上限，DOM helper 高亮与滚动。 | 已有全局任务／消息搜索及轮次导航，未见同等当前对话查找。纯匹配、稳定命中和高亮思路适合组件级移植；ZCode 行号和 render unit 须映射 D Code 当前 Session／可见路径与消息 ID。 | **第一批建议**。默认查可见用户／助手正文，上一处／下一处及覆盖范围可知；工具输出搜索另立范围。先验证 Unicode、Markdown 显示文本、历史加载和流式更新。 |
| **Z22 本轮文件摘要** | [面板](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/v4/ConversationFileSummaryPanel.tsx)展示文件数、增删行、patch／打开入口，运行中详情与终态缓存分开；还带文件撤回预检／应用。 | 已有已知 edit/write 的结构化变更与固定 Git 差异，缺靠近该轮结果的文件汇总。适合借折叠卡、文件行和查看入口；先核明耐久来源与去重。 | **第一批建议，先只读**。分别标已确认工具变更和其他当前 Git 变更；缺失行数显示未知，不把重复 edit 的行数相加冒充最终净差异。文件撤回增加副作用，另立需求。 |
| **Z20 等待输入队列** | [面板](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/v4/ConversationQueuePanel.tsx)紧贴输入区，有暂停原因、恢复、撤回编辑、删除和拖动；send-now 注释明确是 stop 当前后消费所选项。 | 已有耐久队列及按钮控制。可借集中布局、行状态、读取中的局部锁和拖动反馈。 | **第二批建议，呈现改进**。不把 ZCode send-now 等同 D Code steer；先保留暂停、保存和重排的既有合同。 |
| **Z15 附件预览** | [预览框](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/ChatMediaAttachmentPreviewDialog.tsx)统一文件名／类型、图片／视频／PDF 分支；PDF 延迟加载，视频解码失败有独立状态。 | 现有系统预览、自有图片框及生图预览已接通。可比较在 App 内统一标题、加载、过期与不可解码状态；素材数据继续由 Host 管理。 | **已有能力打磨**。先比较系统预览与 App 内预览是否存在真实摩擦；不要为图片放大单独加入 PDF.js、视频或整包依赖。 |
| **Z31 应用用量统计** | [统计页](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/settings/usage-stats/AppUsagePanel.tsx)使用本地 App Usage 数据，提供累计 tokens、每日模型趋势、模型占比与活动热图；图表延迟加载并用局部错误边界包裹。 | ProviderCall usage 可作为基础；当前 ContextUsage 是会话容量指标，配额查询是账号可用性，三者不同。可借时间筛选／模型占比展示，Host 负责去重及有界聚合。 | **第二批建议，先基础统计**。明确时间、调用状态、摘要调用、缺失记录与导入覆盖；成本字段需标来源／估算，图像订阅消耗仍未知，不以 tokens 或 SDK cost 推导真实账单。 |
| **Z02 分组长列表** | [顶层列表](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/workspace-grouped-tasks/virtualized-top-level-list.tsx)使用 react-virtual，处理滚动定位和 overscan；总容器还耦合分组、拖动及远程 workspace 服务。 | 当前按 Project／最近 Task 展示，未见虚拟列表。虚拟层、行高度和滚动保留可独立研究，完整分组容器依赖重。 | **性能条件项**。以真实规模证明瓶颈后选虚拟层；自由分组、跨作用域拖动另定义，不凭源码存在宣称 D Code 变快。 |
| **Z28 可复用工作流** | [中枢](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/settings/saved-workflows/SavedWorkflowsSection.tsx)分全局／项目，参数启动或预填草稿；launcher 创建新会话并调用 startSavedWorkflow，失败回收空会话。 | 当前只有 Task 内工作流及其版本。可借参数表单和选择器，模板、版本和新 Task 的来源须由 D Code 定义。 | **后续产品扩展**。保存的是安排模板，运行需新身份；不能复制原 Task 成员、报告、权限和历史证据为新任务成果。 |
| **Z29 跨任务运行历史** | [历史行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/settings/saved-workflows/SavedWorkflowRunHistoryPanel.tsx)给出状态、时间、耗时、tokens、参数和产物；项目／会话／工具身份完整时才可回到实例。 | TaskWorkflowRuns 和 Task Artifact 已存在；当前面板以选中工作流的最新 run 为主。可以先借表格／状态行到同 Task 完整历史。 | **局部中优先、跨 Task 后置**。同 Task 历史呈现可单独验证；跨 Task 汇总依赖可复用模板身份，不能把一个 run 绑定到另一个 Task。 |
| **Z08 交互终端** | [侧窗](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/SidePaneTerminalPane.tsx)包装 xterm＋PTY Session；registry 保留终端与 scrollback，卸载只 detach，工作区关闭才回收。 | 已有命令过程和辅助进程记录，缺用户交互终端。展示壳可参考，仍需新 PTY 服务、输入／resize、凭据环境及关闭边界。 | **专项后置**。先明确交互场景；自有 macOS 实现，不将终端辅助进程当 Agent 主执行进程，也不引入 ZCode 跨平台／远程运行链。 |
| **Z36 定时自动化** | [管理 store](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/store/automationManagementStore.ts)接入 zcode-agent RPC 的创建、改动、启停、立即运行与历史；页另耦合闲时服务和订阅资格。 | 当前没有 D Code 调度产品合同。可借状态行、计划摘要与编辑布局；业务不靠复制页面成立。 | **专项后置**。需先定 Task 归属、时区／睡眠、额度、停用、未知副作用和通知；不借入闲时收费、增长或订阅后台服务。 |

### 可以怎样源码级借鉴

- **直接适配的候选**：查找索引纯函数、命中身份与高亮 helpers，文件摘要行、状态行、运行历史列表等展示件。它们仍需替换 ZCode 类型／i18n／样式 token，逐文件保留来源和许可，并用真实 D Code 入口验证。
- **先拆展示与行为的候选**：队列和文件摘要回调。沿用 D Code 消息、Store、权限与路径身份，显式决定发送、暂停、净差异和文件撤回的语义。
- **需要独立能力的候选**：全局模板、交互终端与定时调度。ZCode 组件绑定其 services／RPC／持久化；D Code 原生实现成立后再消费相应展示。
- `@zcode/ui` manifest 同时包含 workspace 服务包、编辑器、图表、PDF、终端与其他依赖。本轮建议逐文件选取，保持现有 React、Radix、SWR、图标和中英词表；第三方字体／图标单独核对，D Code 品牌和 macOS 焦点规则继续生效。

2026-10-01 研究建议的顺序为：**对话内查找 → 只读文件摘要 → 队列集中呈现／基础用量 → 同 Task 历史与附件预览打磨 → 列表虚拟化 → 模板／终端／自动化专项**。2026-10-02 已由 507 确认十项全部纳入，当前正式版本与验收由下述新规格拥有，原 0.0.37 候选不重标。

## 2026-10-02：全部纳入与 UI／UX 授权

507 已确认十项全部可以加入，并允许普通 UI／UX 大量借鉴、包括适用源码组件；本轮研究退出待选状态。Z18／Z22／Z20／Z15／Z02／Z31 和 Z29 的同 Task 部分进入 [0.0.38 工作台体验](../40-版本实施方案/0040-0.0.38-工作台体验与-ZCode-共享界面借鉴产品需求.md)；Z28／Z29 跨 Task／Z08／Z36 进入 [0.0.39 复用与运行能力](../40-版本实施方案/0041-0.0.39-可复用工作流终端与定时自动化产品需求.md)。本文件继续只拥有来源事实及对照，细节、失败边界与验收以两份规格为唯一权威。

导航、输入／菜单、对话与过程、对象／附件、成员与工作流、设置及通用状态都属于借鉴范围；ZCode 的品牌、收费／闲时／增长后台、远程／Windows、Runtime 和产品数据格式属于特有部分。D Code 的 Task／Session／成员语义、原文和证据、Host／Product Store、权限、macOS 焦点与自身品牌继续适配。范围选择不等于完成源码移植；许可证、资源与真实运行路径逐项核验。
