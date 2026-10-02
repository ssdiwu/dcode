# 外部产品与仓库参考

状态：Reference Index（参考索引）

既有参考清单上次对齐：2026-08-15；REF-016–021 来源核对：2026-09-24；REF-022–024 论文原文核对及版本借鉴确认：2026-09-26；ZCode、PI-Desktop、Kimi Code 与 MiniMax Code 的新一轮源码和界面核对：2026-09-28。

## 权威边界

本目录记录 507 明确提供的外部产品、界面、仓库和论文参考，以及 D Code 已确认的借鉴边界。它帮助后续设计与实现理解“为什么这样做”，但不直接定义产品需求，也不能证明能力已经实现。

- 目标形态以 [`20-产品与交互/`](../20-产品与交互/README.md) 为准。
- 版本范围与验收以 [`40-版本实施方案/`](../40-版本实施方案/README.md) 为准。
- 当前实现以源码、测试和 [`10-架构与运行/`](../10-架构与运行/README.md) 为准。
- “借鉴”默认指学习对象、信息层级和交互机制，不表示接入其运行时或新增对应依赖。507 已允许对许可明确的公开共享 React UI 做源码级组件借鉴；实际移植须逐文件核对许可、来源和声明，保留 D Code 的产品语义与品牌资产。

本轮 Web 客户端的代码与 UI 对照见 [ZCode / MiniMax Code 本机对照（2026-09）](ZCode-MiniMax-Code-本机对照-2026-09.md)。

ZCode 可供下一轮逐项选择的用户可见组件见 [ZCode 组件清单与 D Code 对照（2026-09）](ZCode-组件清单与-D-Code-对照-2026-09.md)；这是参考目录，不自动扩大 `0.0.35` 或 `0.0.36` 的需求范围。

2026-10-01 已补[十项候选的源码复核](ZCode-组件清单与-D-Code-对照-2026-09.md#2026-10-01十项候选源码复核)：27 份原文和当前 `0.0.37` 实现对照，校正附件预览／队列已有能力，区分查找与只读文件摘要、历史用量、同 Task 运行历史和需独立运行服务的后续专项。该轮保留研究事实；2026-10-02 507 已确认全部十项与普通 UI／UX 借鉴，正式需求移至 [0.0.38](../40-版本实施方案/0040-0.0.38-工作台体验与-ZCode-共享界面借鉴产品需求.md)和 [0.0.39](../40-版本实施方案/0041-0.0.39-可复用工作流终端与定时自动化产品需求.md)；来源摘要见[清单](assets/zcode-candidate-source-check-2026-10-01.json)。

## 参考索引

| 编号 | 参考对象 | 类型 | 507 提供的来源 | 当前定位 |
|---|---|---|---|---|
| REF-001 | OpenAI Codex 桌面端 | Product UI（产品界面） | 多张界面截图与持续对照反馈 | 工作台主骨架参考 |
| REF-002 | ZCode | Product UI + Public Source（产品界面与公开源码） | [zcode.z.ai/cn](https://zcode.z.ai/cn)、[官方仓库](https://github.com/zai-org/ZCode) | “＋”添加面板、共享 React UI、工作台层级与组件级源码借鉴优先来源 |
| REF-003 | MiniMax Code | Product UI + CLI Source（产品界面与命令行源码） | 本机桌面端、[官方文档](https://agent.minimaxi.com/docs/code/welcome)、[公开 CLI 仓库](https://github.com/MiniMax-AI/minimax-code) | 桌面交互参考；CLI 状态呈现参考，桌面源码未公开于该仓库 |
| REF-004 | PiDeck | Open-source App（开源应用） | [Skitre/PiDeck](https://github.com/Skitre/PiDeck) | Pi 能力运用与差距检查 |
| REF-005 | Flue | Agent Harness（智能体宿主） | [withastro/flue](https://github.com/withastro/flue) | 架构参考，不作为 D Code 基座 |
| REF-006 | Orca | Open-source App（开源应用） | [stablyai/orca](https://github.com/stablyai/orca) | 标签、编辑与预览参考 |
| REF-007 | pi-intercom | Pi Extension（Pi 扩展） | [nicobailon/pi-intercom](https://github.com/nicobailon/pi-intercom) | 跨会话通信机制参考 |
| REF-008 | pi-messenger | Pi Extension（Pi 扩展） | [nicobailon/pi-messenger](https://github.com/nicobailon/pi-messenger) | 多智能体协作机制参考 |
| REF-009 | Todos | Agent Team Workspace（智能体团队工作空间） | [todos.dev](https://todos.dev/) | Work Map、Run 历史与人工门禁参考 |
| REF-010 | pi-dteam | Pi Extension（Pi 扩展） | [ssdiwu/pi-dteam](https://github.com/ssdiwu/pi-dteam) | D Team 执行层机制参考 |
| REF-011 | Codex Taskboard | Local-first Taskboard（本地优先任务看板） | [chuspeeism/dashi-taskboard@9b2aeb53](https://github.com/chuspeeism/dashi-taskboard/tree/9b2aeb53bfe8d40eb5d65feecdfc2cc235928066) | 外部状态流转与会话关联参考，未进入版本路线 |
| REF-012 | Otty | Native Terminal Workspace（原生终端工作台） | 本机 `1.3.1@c0620a3c`、[官方文档](https://docs.otty.sh/)与 507 提供的实机截图 | 左侧活动扫描与右侧详情分层参考 |
| REF-013 | Macro Tasks | Unified Workspace Task（统一工作空间任务） | [Macro Tasks](https://macro.com/app/component/tasks) 与 [官方仓库](https://github.com/macro-inc/macro) | 富任务对象、双向引用与并排上下文参考 |
| REF-014 | GitHub Projects | Project Planning View（项目规划视图） | [官方介绍](https://docs.github.com/en/issues/planning-and-tracking-with-projects/learning-about-projects/about-projects)与[最佳实践](https://docs.github.com/en/issues/planning-and-tracking-with-projects/learning-about-projects/best-practices-for-projects) | 同一任务多视图、字段、草稿、依赖与自动化参考 |
| REF-015 | 507 现有 Pi 拓展族 | Pi Extension Sources（Pi 拓展来源） | [本机只读审计](现有-Pi-拓展能力归宿.md) | D Code 基础能力、可选拓展、提供方与不迁移边界 |
| REF-016 | pi-agent-extensions | Pi Extension Collection（Pi 扩展集合） | [Pi 包页](https://pi.dev/packages/pi-agent-extensions) | 审查、有限迭代、会话与文件入口的机制参考 |
| REF-017 | pi-agents-team | Pi Extension（Pi 扩展） | [Pi 包页](https://pi.dev/packages/pi-agents-team) | 协调者接收精简成果、按来源查看成员过程的机制参考 |
| REF-018 | Remnic Pi 插件 | Pi Memory Extension（Pi 记忆扩展） | [npm 包页](https://www.npmjs.com/package/%40remnic/plugin-pi) | 按需召回与压缩前保存的参考；D Code 优先保留可点回原文的引用 |
| REF-019 | Magic Context Pi 插件 | Pi Memory Extension（Pi 记忆扩展） | [npm 包页](https://www.npmjs.com/package/%40cortexkit/pi-magic-context) | 跨会话检索与上下文管理的参考 |
| REF-020 | pi-agenticoding | Pi Extension（Pi 扩展） | [作者仓库](https://github.com/agenticoding/pi-agenticoding) | 任务摘要与主动交接的机制参考 |
| REF-021 | pi-cc-plugins | Pi Extension（Pi 扩展） | [507 提供的仓库](https://github.com/ariesike/pi-cc-plugins) | 外部能力导入兼容性的后续参考 |
| REF-022 | Stellar Colosseum | Research Paper（研究论文） | 507 提供标题截图；[论文 v2](https://arxiv.org/abs/2609.15983v2) | 候选路线、针对性反证、成熟判断与局部回退机制参考 |
| REF-023 | RRSI | Research Paper（研究论文） | 同一截图；[论文 v2](https://arxiv.org/abs/2609.24972v2) | 有界修改、反证保留及未参与调试任务的评估纪律参考 |
| REF-024 | Harness-Zero | Research Paper（研究论文） | 同一截图；[论文 v1](https://arxiv.org/abs/2609.24974v1) | 将 Harness 引导行为蒸馏进模型的训练方向参考，未进入版本实施范围 |
| REF-025 | PI-Desktop | Open-source App（开源桌面应用） | [官网文档](https://pi-docs.aiuo.net/)、[官方仓库](https://github.com/vastsa/PI-Desktop) | Subagent 概览卡、结构化状态与按需过程查看参考 |
| REF-026 | Kimi Code | Desktop UI + CLI Source（桌面界面与命令行源码） | [桌面端文档](https://www.kimi.com/code/docs/kimi-code-desktop/interface-and-sessions.html)、[公开 CLI 仓库](https://github.com/MoonshotAI/kimi-code) | 后台成员工作条与过程分层参考；公开仓库中的 UI 为 TUI |

## REF-001 OpenAI Codex 桌面端

**D Code 借鉴**：

- 左侧 Project（项目）与 Session（会话）导航、中央工作空间、按宽度自然出现的右侧检查器；
- 对话是唯一会话主页面且不建立冗余标签，文件或产物真实打开后才按需出现内容标签；
- 覆盖当前工作台的轻量全文搜索浮层；
- 在 Composer（输入区）集中模型、思考强度、极速模式与上下文占用；
- 把外观、布局等应用级偏好放入独立 Settings（设置）空间；D Code `0.0.1` 先落系统/浅色/深色与真实布局偏好，设置项增长后再引入分类侧栏；
- 消息下方的继续、重走、复制等就地动作。

**明确不借鉴**：不复制品牌或 Codex 的 Task（任务）数据模型，不把其未由 D Code Product Store 支持的状态伪装为已实现；不为了像 Codex 而预放尚无真实 D Code 行为的空设置页。

**证据边界**：507 提供的截图位于会话临时附件中，尚未复制为仓库资产；本条保存已经确认的结构结论，不把截图当成持续可用文件。

**Codex App Server 生图方向（2026-09-28）**：[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server)提供 ChatGPT 登录、`turn/start` 和按版本生成协议 Schema；[Codex 图像生成说明](https://learn.chatgpt.com/docs/image-generation)确认内置生图可计入适用订阅的通用用量，[定价说明](https://learn.chatgpt.com/docs/pricing)区分订阅用量与 API Key 计费。本机 `codex-cli 0.157.1` 导出的协议含 `imageGeneration` 事件、图像结果和保存路径；真实订阅认证单图测试已返回[可核对 PNG](assets/codex-app-server-imagegen-poc-2026-09-28.png)，完整边界见 [0.0.37 验证记录](../40-版本实施方案/0036-0.0.37-任务内图像生成与产物归档产品需求.md)。2026-10-01 D Code 本机试验的受管图、预览／附件／导出、重启与固定配置负向检查已通过，见[当前验证](assets/dcode-0.0.37-verification-2026-10-01.md)；精确额度扣减、稳定生产支持、正式分发及 507 本人验收仍须分别成立。它需要独立于现有 Pi SDK 的认证与运行边界；`0.0.36` 仍不加入图像生成。

## REF-002 ZCode

**D Code 借鉴**：成熟工作台的整体信息层级，包括耐久导航、中央对话、固定输入区，以及靠近工作内容的紧凑活动与进度呈现。2026-09-28 核对官方 `3.14.3` 公布源码 `29628c9`：共享 React UI 中的[成员状态组件](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/components/workflow-timeline/WorkflowAgentPill.tsx)、[工具摘要行](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/ToolCallBlocks/ToolSummaryRow.tsx)、[成员侧边会话](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/app-shell/SubagentSessionSidePane.tsx)与[设计规则](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/DESIGN.md)可供 `0.0.36` 对照和组件级移植选择。本机 ZCode 也显示 `3.14.3`，相同版本号不证明安装包与仓库字节完全一致。

**源码与边界**：仓库第一方代码采用 [Apache-2.0](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/LICENSE)，[NOTICE](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/NOTICE.md) 指明第三方软件、字体、图标和素材可能另有条件。组件实现可以在逐文件核对后适配 D Code；ZCode 标志衍生头像、品牌文案、运行时与数据权威不进入 D Code。D Code 保留自己的任务浮层、信息检查器与响应式中央阅读宽度，不整体搬运其多窗口或多面板壳。

**“＋”添加面板专项（507 提供[标注截图](assets/zcode-add-menu-507-annotated-2026-09-28.png)）**：[ChatPromptActionMenu](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/prompt-editor/ChatPromptActionMenu.tsx)以输入区宽度打开非模态 Popover（弹出面板），顶部是附件、目标和工作流，下方按真实提供方列插件、文件与对话，底部保留快捷方式说明；[MentionPanel](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/mentions/components/MentionPanel.tsx)处理分组、长列表及加载／空／失败。附件调用文件选择；目标只在新会话空草稿出现，工作流只在空草稿且命令目录确有 `/workflow` 时出现。选目标或工作流先插入命令标签，发送后才走其真实能力，不是点击菜单即执行。截图是 507 的标注材料，展示某次安装状态，不证明其中插件在 D Code 可用。

**长对话导航专项**：ZCode 的[轮次导航组件](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/v4/ConversationTurnNavigator.tsx)和[条目规则](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/v4/conversationTurnNavigatorHelpers.ts)按用户实际提问建立独立可点、可滚动且虚拟化的条目；同一执行轮里的多次用户补充可各自跳转，悬停显示提问及所属回答摘要。D Code 已有 Conversation Rail 的轮次刻度、预览与键盘跳转；`0.0.36` 借鉴 ZCode 的长列表命中和组件层级来升级现有轨道，不复制其产品数据结构。两者都不按内容高度绘制全文地图，也不直接定位单轮工具输出内部的错误；轮内查找需要独立的搜索或锚点需求。

**输入触发器专项（507 于 2026-09-28 调整 D Code 方向）**：此源码版本的[分组路由](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/mentions/mentionPanelRouting.ts)让 `@` 搜索插件、文件、对话和画板，`$` 搜索技能；[文件候选提供者](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/mentions/providers/fileMentionProvider.ts)调用受工作区身份约束的文件搜索并输出相对路径引用。[子智能体候选映射](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/packages/ui/src/mentions/providers/subagentsMentionProvider.ts)消费的是 Agent 配置摘要，不能直接作为 D Code 已创建成员的稳定运行身份。D Code 借文件搜索的界面与取消过期查询等机制；`/`、`@`、`$` 各自对应什么，由 D Code 的输入和消息合同决定，不照搬 ZCode 的符号分配。当前 D Code 客户端的 `@` 定向成员，Host 只有文件树／读取与引用核验，尚无对应的工作区搜索接口；`@` 文件引用属于新的产品行为，不因引入组件就宣称已交付。

ZCode 的[目标文档](https://zcode.z.ai/cn/docs/goal)定义会话级多轮自动校验；其内置 [`/workflow` 命令](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/bootstrap/src/builtin-workflow-command.ts)会要求 Agent 设计并启动动态工作流，背后有独立的脚本与多成员运行机制。D Code `0.0.36` 只借入口、分组、信息层级与可核对的状态处理；目标对应 D Code Task Goal，真实任务内工作流由 [PRD 0034](../40-版本实施方案/0034-0.0.36-任务内工作流产品需求.md) 定义，不把 ZCode 命令或脚本 Runtime 当成已有 D Code 能力。

## REF-003 MiniMax Code

**已核实证据**：2026-09-06 本机 `/Applications/MiniMax Code.app` 为 `3.0.60`（build `3.0.60.123`）；版本元数据只证明当时的研究对象，不单独证明具体界面行为。当轮采用 507 明确采纳的观察，以及 [Tasks](https://agent.minimaxi.com/docs/code/workflows/tasks)、[Panels](https://agent.minimaxi.com/docs/code/desktop/panels)、[Goal](https://agent.minimaxi.com/docs/code/desktop/goal)、[Agent Team](https://agent.minimaxi.com/docs/code/agents/team)、[Custom Agents](https://agent.minimaxi.com/docs/code/agents/custom-agents) 与 [Permissions](https://agent.minimaxi.com/docs/code/workflows/permissions) 可核实的本地产品机制；未反编译应用或复制其代码、文案和视觉资产。具体动态行为进入版本 PRD 时仍须记录可复现操作路径。

**D Code 借鉴**：

- 对话仍是任务主空间，本机文件、变更与运行信息作为可并行操作的上下文，不用模态蒙版切断左栏和中央对话；
- Project 文件树和助手正文中的文件、目录、代码行引用可在 D Code 自有 Workspace Tab 中打开并定位；
- Goal 在输入区附近持续显示阶段、耗时、证据、阻塞与人工控制，但不取代 D Code 的耐久 Work Map；
- Agent Profile 与 Task 内 Agent Run 分离，团队状态由 D Code 的真实交办、运行、报告和验收事实呈现；
- 上下文和用量只呈现当前 D Code Host 能核对的真实数据。

**明确不借鉴**：不照搬固定 Coder / Verifier / General 角色，不把团队成员提升为独立 Task 层级，也不展示隐藏的原始推理过程。MiniMax 的 Remote Control、IM、云端／定时任务、账号积分与签到、在线部署、Chrome Cookie 导入、Skill 市场和增长反馈入口不随 `0.0.36` 的工作台质感收口进入 D Code。

**2026-09-28 补充证据与产品边界**：本机桌面端为 `3.0.70`；公开 `minimax-code@0f6ad52` 的[README](https://github.com/MiniMax-AI/minimax-code/blob/0f6ad5229ff1f144c72dd15a4b2d520feb26cd3d/README.md)明确只发布 TUI、headless CLI 与 ACP 源码，不含桌面应用源码。其中[运行状态行](https://github.com/MiniMax-AI/minimax-code/blob/0f6ad5229ff1f144c72dd15a4b2d520feb26cd3d/packages/tui/src/tui/shell/activity-line.ts)可供状态语义参考；桌面组件只能从官方文档与实机观察核对。D Code 的 Web 客户端继续消费 Product Store 与 Pi Runtime Adapter，不接入 MiniMax Runtime 或将 CLI 组件当作桌面源码。

## REF-004 PiDeck

**D Code 借鉴**：观察第三方如何调用 Pi 的会话与 Agent 能力，用作 D Code 能力覆盖、交互入口和 SDK 使用方式的差距检查。

**明确不借鉴**：PiDeck 不成为 D Code 的产品壳、会话权威或运行时依赖；任何能力仍须回到 D Code 的原生产品模型和 Pi SDK 合同中验证。

## REF-005 Flue

**D Code 借鉴**：Agent Harness（智能体宿主）的语义事件、单会话所有权、持久接收和能力分层思想。

**明确不借鉴**：不采用 Flue 的 Runtime（运行时）、会话数据库、HTTP/SSE 协议、React UI 或扩展编写模型。D Code 继续由 Product Store 拥有会话事实，通过自己的 Host 与 Web 客户端工作；Pi 只作为 Runtime Adapter。

**当前结论**：Reference Only（仅作参考）。它适合从零构建 Web/Node Agent 产品，不作为 D Code 第一阶段的开发基础。

## REF-006 Orca

**D Code 借鉴**：

- 中央 Tabs、Panes 与 Split Layouts 的内容组织思想；首阶段只采用单组中央标签；
- Markdown 富预览、源码与预览分栏；
- HTML、图片、PDF、Mermaid、CSV/TSV 与 Notebook 等 Viewer 的对象化呈现方式。

**明确不借鉴**：不复制其整套编辑器、任意拖拽分栏或安全模型；Markdown 与 HTML 的“即时预览”必须由 D Code 的未保存缓冲区驱动，不能把 Orca 当前的磁盘文件预览误写成已经验证的连续刷新方案。

相关官方说明：[Tabs、Panes 与 Split Layouts](https://www.onorca.dev/docs/model/tabs-panes-splits)、[Rich Markdown Editor](https://www.onorca.dev/docs/editing/markdown)、[Viewers](https://www.onorca.dev/docs/editing/viewers)。

## REF-007 pi-intercom

**D Code 借鉴**：跨 Session 的持久、定向通信，以及消息来源、目标、送达状态和恢复语义。

**明确不借鉴**：不把 `pi-intercom` 作为 D Code 产品运行时依赖，也不把它的终端界面搬进原生 App。相关能力需要由 D Code 定义结构化合同和原生呈现。

## REF-008 pi-messenger

**D Code 借鉴**：多 Agent 消息的稳定身份、来源、目标与可观察结果，与 MiniMax Code 的 Agent Team 用户形态结合，让用户能集中理解每个成员做了什么、主智能体转发了什么，以及形成了什么结论。

**明确不借鉴**：不直接接入其 TUI、会话存储或扩展 UI；成员、消息、活动和结论由 D Code 自有数据合同表达。

## REF-009 Todos

**D Code 借鉴**：

- Goal 之下的稳定 Work Item，以及同一工作项的多次 Run 历史；
- Plan / Changes 作为可寻址、可版本化的工作产物，而不是被对话流冲走的临时消息；
- 计划确认、结果验收和用户回答等明确人工门禁；
- 工具、机器、凭据与人类角色相互约束的分层权限思路。

**明确不借鉴**：不把 Todos Cloud 设为 D Code 的事实权威，不把一个 Todo 强制等同于一个 Pi Session，不在近期版本复制全局 Chief、常驻角色团队、每项独立 Worktree、定时重跑、远程机器或自动合并发布。目前没有核实到可供 D Code 复制或随 App 分发的开放源码许可；只学习公开产品机制，不复制其编译代码。服务权利边界见 [Todos Terms](https://todos.dev/terms)。

**连接边界**：Todos 的 [Remote MCP](https://todos.dev/docs/mcp) 只是 D Code 本机工作对象合同稳定后的可选连接器候选。即使后续接入，Todos Project / Todo 也只是远程引用，不改写 D Code 的本机身份与状态权威。

## REF-010 pi-dteam

**D Code 借鉴**：模型分级路由、有界 Worker 任务、只读默认与显式写入范围，以及 Finding、Request、Control、恢复和结构化 WorkerReport 的生命周期语义。主智能体继续负责判断、路由、中转和最终综合。

**明确不借鉴**：不把当前进程内 Worker Runtime 伪装成耐久 Work Map，不声称 Worker P2P，不自动调度工作项依赖，不持久化完整 Worker Transcript 或隐藏 Thinking，不解析 `/dteam` TUI 作为产品界面。

**当前定位**：pi-dteam 是 `0.3.x` D Team Execution Plane（执行层）的机制与可复用实现来源；D Code 自己拥有 Work Item / Team Run / Member / Event / Report 的产品合同、Host IPC、持久化边界和 SwiftUI 原生呈现，不要求用户另外安装该扩展。

## REF-011 Codex Taskboard

**已核实边界**：本次固定参考 `chuspeeism/dashi-taskboard@9b2aeb53`。它的卡片是产品自有、保存在 Taskboard SQLite 中的 Task / Issue（工作项），不是 GitHub Issue，也不是 Codex Conversation。一个工作项可关联多个会话，会话内的 Run 状态与看板阶段分开；普通 Run 结束不自动进入待确认或已完成。

**D Code 参考点**：保留 Work Item 与 Session / Run 分层、执行状态与人工验收分离、原会话不因组织操作被复制或迁移等调查结论。

**明确不纳入**：会话拖入 Kanban、四列看板、自动移列和 Taskboard 运行时均未进入 D Code 当前版本路线。对应的离线原型只用于保存已完成的研究；未来若重新立项，必须另行进入版本 PRD，不从参考文件自动升级为产品需求。

## REF-012 Otty

**已核实证据**：本机 `/Applications/Otty.app` 为 `1.3.1`，应用内版本哈希为 `c0620a3c`。507 提供并在实机中核对了左侧 Tab 分组 / 排序菜单，以及右侧 Info / Outline / Git / Files 详情页签；Otty 官方文档同时说明了[左侧 Tab 的 Group / Order / Divider 与运行徽标](https://docs.otty.sh/user-interface/window-tab-split)和[跟随当前 Pane 的右侧 Details Panel](https://docs.otty.sh/user-interface/details-panel)。这些证据只说明参考对象在该版本的行为，不表示 D Code 已经实现对应能力。

**D Code 借鉴**：

- 左侧列表把“耐久导航”和“当前活动扫描”分开理解；Otty 的运行、等待、完成、失败徽标证明紧凑状态可帮助用户跨会话发现需要关注的工作，但 D Code 用 `0.0.6` Activity View（活动视图）承载这一结果，而不是给默认 Project / Recent 导航增加任意排序器；
- 右侧详情按对象职责拆分：当前目录与会话事实进入 Information Inspector（信息检查器），只读 Files 已由 `0.0.4` 建立，可信 Project 快捷动作进入 `0.0.8`，Exact Git Diff（精确 Git 差异）进入 `0.0.9`，Markdown / HTML 缓冲区与预览分别进入 `0.0.15–0.0.16`；
- Outline 的“快速理解当前内容结构”思想由 D Code 已有 Session Path、Plan、对话导航尺和后续结构化产物导航吸收，不复制终端命令时间线；Process / Ports 只有在连续 dogfood 形成真实闭环缺口后才进入 `0.0.20+`。

**明确不借鉴**：不把 Otty 的 Tab 等同于 Pi Session，不加入 No Grouping / By Project / By Date、Created / Updated / Manual 等通用配置矩阵，不加入手工 Divider（分隔线），也不把终端进程、端口、Shell Outline 或任意 Pane / Split Runtime 搬进 D Code。`0.0.6` 首版使用产品语义固定的“等待处理 → 正在运行 → 新完成 → 其余按可证明活动时间”顺序；默认导航仍由置顶、Recent 与 Project 组织。

## REF-013 Macro Tasks

**D Code 借鉴**：

- Task（任务）首先是可自由描述意图的富文档，再附加状态、优先级、负责人、标签、自定义属性、讨论和 References（引用）；
- 消息、邮件、文档清单和 Agent 对话可以显式提升为任务，并与来源保持双向引用；
- 任务、文档、Agent、收件箱等对象保留各自界面，同时可在同一工作空间并排打开；
- Agent 可以读取任务、复制为 Prompt（提示内容）或通过结构化能力继续执行；任务的当前状态与会话中的真实过程并存。

**明确不借鉴**：不复制 Macro 的团队套件、邮件/CRM 导航、视觉皮肤或通用任务表格；不因 Git 分支、Pull Request（拉取请求）或合并事件自动把 D Code Task 判定为完成。D Code 的项目、任务、会话、Agent 运行、自动验证、人工验收、提交与发布继续分别成立。

## REF-014 GitHub Projects

**D Code 借鉴**：

- Project Management（项目管理）是同一批 Task 上的规划与观察能力，不是第二份任务数据库；
- 表格、看板、路线图、筛选、排序、分组和自定义字段形成多个 Task View（任务视图）；
- Task Draft（任务草稿）可以先快速捕捉，确认后再提升为正式 Task；
- Subtask（子任务）和依赖只在独立执行、并行或验收有价值时建立；
- 自动化应由真实事件更新明确字段，并坚持 Single Source of Truth（单一真相源）。

**明确不借鉴**：GitHub Project 不等于 D Code Project；D Code Project 是长期产品、项目目录、规则、设计、知识、愿景和任务集合。Issue 关闭、Pull Request 合并或项目字段变化都不能自动替代 D Code 的任务验收。

## REF-015 507 现有 Pi 拓展族

**D Code 借鉴**：现有 `pi-*` 仓库是 507 已经验证过的工作方法、交互、安全和 Provider（提供方）机制来源。逐项归宿、分类判据和证据边界见[现有 Pi 拓展能力归宿](现有-Pi-拓展能力归宿.md)。

**明确不借鉴**：不按仓库边界整体搬运，不继续暴露 `dgoal`、`dteam` 等来源名称，不加载它们作为 D Code 原生 Goal / Agent Team 的运行时依赖，不复制 Pi TUI、Pi 包市场、Pi 状态键或会话所有权。只有当前 D Code 产品需要的机制进入基础能力、可选一等拓展、Capability Provider 或 Skill。

## REF-016–021 Pi 续接、记忆、协作与能力桥接

2026-09-24 按上述包页和作者仓库核对来源；外部包版本与下载量会变化，不作为 D Code 需求或选型依据。[PRD 0031](../40-版本实施方案/0031-0.0.34-任务续接与可追溯审查产品需求.md) 拥有已经确认的产品行为与验收，目标版本于 2026-09-26 顺延至 `0.0.34`。

- **pi-agent-extensions**：参考从当前会话、文件和差异进入审查与有限迭代的便捷动作；D Code 沿用任务、工作项、团队和自有界面，不复制整包命令、主题或通用 workflow（工作流）引擎。
- **pi-agents-team**：参考协调者只消费有界成果、需要时回到成员来源；D Code 已有 Task 内成员、Child Agent Session、报告和独立验收，不移植固定角色表或 Pi worker 会话权威。
- **Remnic 与 Magic Context**：参考相关内容召回、跨会话检索和上下文压力管理。D Code 的 Task、Project Knowledge 与全局 Inspiration 保留来源类型和版本，实际引用可回到原文；不让外部记忆数据库、Pi 会话日志或自动生成摘要成为产品权威。
- **pi-agenticoding**：参考任务级摘要和主动交接；D Code 的摘要是可查看、可修订、有来源的 Task 投影，换会话或进程重启不能伪装恢复在途 Runtime。
- **pi-cc-plugins**：保留外部 Skill、Agent 与 MCP 配置导入思路作为后续兼容性观察项；导入必须先适配 D Code 的能力、职责和安全合同，不进入 `0.0.34` 的任务续接范围。

## REF-022–024 Harness 论文

507 于 2026-09-26 提供上述三篇标题，并确认先以其适用机制完善协调者，再交付任务续接与可追溯审查。截图用于定位，机制与来源归属按论文原文核对。D Code 的本轮产品行为及验收由 [PRD 0032](../40-版本实施方案/0032-0.0.33-协调者按需探索与路线选择产品需求.md) 拥有。

- **Stellar Colosseum**：Google Research 与 Carnegie Mellon University 合作，首次提交于 2026-09-14；本次核对 2026-09-15 的 v2。论文先探索策略，通过针对性反驳与路线成熟判断后拆为有依赖的子问题；局部失败保留无关成果，核心策略失效则重新探索；汇总保留候选对应的异议。D Code 借鉴按需探索、验证关键假设和分层回退，不复制大规模搜索树或固定智能体数。论文的数学证明与竞赛编程结果不能直接推断为 D Code 开发任务收益，见[原文第 4 节与评测](https://arxiv.org/html/2609.15983v2)。
- **RRSI**：Google Cloud AI Research 与高校合作者，首次提交于 2026-09-21；本次核对 2026-09-23 的 v2。研究固定模型下的 Harness 自动演化：约束每轮改动量、保留先前证伪记录、筛除任务特定泄漏，并将收益、噪声、成本和冗余一起纳入候选接受。D Code 本版只借鉴有界比较、失败证据保留和未参与调试任务的验证纪律；不将 Harness 自动演化混同于单次用户任务的路线选择。见[原文方法与实验](https://arxiv.org/html/2609.24972v2)。
- **Harness-Zero**：Peking University、Google 与 The Hong Kong University of Science and Technology 合作，首次提交于 2026-09-21；本次核对 v1。研究让独立智能体在训练轨迹收集时纠正学生模型的动作，再通过微调吸收部分 Harness 引导行为；仍保留基础运行机制。它属于模型训练参考，不授权 D Code 当前训练模型、移除产品控制或用推断替代验证；未进入 `0.0.33` 或 `0.0.34` 实施范围。见[原文与作者归属](https://arxiv.org/pdf/2609.24974v1)。

这些是原文描述及本项目借鉴判断；本次没有复现论文实验，预印本结果不是 D Code 的实现或验收证据。后续若要引入 Harness 自演化或模型蒸馏，需形成独立目标与范围。

## REF-025 PI-Desktop

507 于 2026-09-28 提供[官网文档](https://pi-docs.aiuo.net/)与[官方仓库](https://github.com/vastsa/PI-Desktop)，明确认可 Subagent 的组件式展示。按仓库 `b516714` 核对：[单层拓扑卡](https://github.com/vastsa/PI-Desktop/blob/b51671458472340c360a6ff39e33aa1caaad3f56/apps/desktop/src/features/chat/transcript/SubagentDetail.tsx)显示主 Agent 与一次 Task 派生的成员，[状态投影](https://github.com/vastsa/PI-Desktop/blob/b51671458472340c360a6ff39e33aa1caaad3f56/apps/desktop/src/lib/subagent-topology.ts)区分开始、运行与终态，点击成员可打开[右侧只读过程](https://github.com/vastsa/PI-Desktop/blob/b51671458472340c360a6ff39e33aa1caaad3f56/apps/desktop/src/components/workpanel/SubagentTranscriptTab.tsx)。[组件规格](https://pi-docs.aiuo.net/spec/04-ux/08-component-spec)与当前代码的详情容器表述有演进差异；共同可借的是“概览、节点、按需详情”的层级，不把一次 `Task` 工具调用当作 D Code 的 Task 或 Agent Run。

PI-Desktop 仓库采用 [LGPL-3.0](https://github.com/vastsa/PI-Desktop/blob/b51671458472340c360a6ff39e33aa1caaad3f56/LICENSE)。本轮没有将其组件源码纳入 D Code，也未安装应用复现实机 Subagent 运行；直接移植前须独立核对具体文件、依赖和分发义务。D Code 的 Task 拥有多轮成员执行，Child Agent Session 允许用户直接交流，所以成员状态与详情必须映射回 D Code 自有事实。

**图像生成补充核对**：PI-Desktop 发布版 [`v0.15.9`](https://github.com/vastsa/PI-Desktop/releases/tag/v0.15.9) 已有[独立生图模型设置与 `GenerateImages` 运行规格](https://pi-docs.aiuo.net/spec/03-runtime/21-image-generation)，可生成、编辑并保存会话图片；[源码](https://github.com/vastsa/PI-Desktop/blob/b684e661797996db3ac64c3c5bdf5764a38fd522/apps/desktop/electron/main/services/image-generation-service.ts)走 OpenAI 兼容 Images API，明确拒绝 OAuth provider，要求 API key 或免认证服务。这是真实图像生成能力，不等于图片输入附件；本轮仅核对文档、发布 tag 和源码，未用真实服务商生成。507 暂不将图像生成纳入 D Code `0.0.36`，参考实现不会自动接入现有 Pi Runtime 或让 ChatGPT 订阅变成 Images API 额度。

## REF-026 Kimi Code

[官方桌面端文档](https://www.kimi.com/code/docs/en/kimi-code-desktop/task-execution-and-review.html)显示输入区上方的后台工作条可查看命令与子智能体的状态、耗时、结果及停止入口，右侧 Agent / Subagent 面板显示当前成员的过程。公开 [Kimi Code 仓库](https://github.com/MoonshotAI/kimi-code)以 CLI / TUI 为主；其中 [AgentGroupComponent](https://github.com/MoonshotAI/kimi-code/blob/be7d5f5fea7800778e4660cd5f36780ba783bddd/apps/kimi-code/src/tui/components/messages/agent-group.ts)按真实成员快照归并多名子智能体，并在阶段变化时立即更新，普通输出更新合并刷新。仓库根为 [MIT 许可](https://github.com/MoonshotAI/kimi-code/blob/be7d5f5fea7800778e4660cd5f36780ba783bddd/LICENSE)。本轮未找到该仓库提供的桌面 React 界面源码，不能把 TUI 组件说成桌面组件。

D Code 借鉴状态词汇、后台工作显著性及“概览可进入过程”的交互；本机安装的 Kimi Code `1.0.4` 仅供界面观察，未核对与公开 CLI 仓库的构建同源。D Code 不直接引入其 TUI 或独立会话所有权。

## 技术上游，不属于竞品参考

[`earendil-works/pi`](https://github.com/earendil-works/pi) 是 D Code 使用的 Pi SDK 上游技术证据，不是 507 新提供的竞品参考。D Code 使用 `pi-coding-agent` 的程序化接口；`pi-ai` 与 `pi-agent-core` 提供底层运行能力。`pi-tui` 可以作为 `pi-coding-agent` 的传递依赖存在，但 D Code 不直接依赖、调用或用它呈现产品界面。

### 2026-09-30 SDK 升级前置核查

2026-09-30 核对时主树三个 SDK 包锁定 `0.87.1`；npm 官方注册表与[官方 v0.99.1 发布页](https://github.com/earendil-works/pi/releases/tag/v0.99.1)均显示最新已发布版本为 `0.99.1`。该版加入 GPT-6.1 Sol；两版安装包的离线 `getBuiltinModels` 对照确认 OpenAI 与 OpenAI Codex 的 `0.87.1` 目录没有 `gpt-6.1-sol`，`0.99.1` 包含该模型。前一 `0.99.0` 版本调整 OpenAI／ChatGPT 登录入口，并增加新的工具执行上下文和聊天／图像／分类模型类型，见[固定版本变更记录](https://github.com/earendil-works/pi/blob/v0.99.1/packages/coding-agent/CHANGELOG.md)。上游的图像接口可作为后续候选机制研究，不自动取代 PRD 0036 已选的 Codex App Server 生图方向。

隔离临时副本只替换三项 SDK 到 `0.99.1`，安装成功；`tsc --noEmit` 在两个文件出现 12 条类型错误，保留[原始编译结果](assets/pi-0.99.1-compatibility-2026-09-30.txt)：`model-catalog-configuration.ts` 对新的模型配置联合类型缺少聊天类型收窄，`sdk-compatibility.test.ts` 的工具执行上下文需适配 `ExtensionToolContext`。这只证明当前源码无法直接换包通过编译，尚未测试新认证、默认内置工具、进程和会话行为。建议为模型目录、认证、Active Tool Manifest 与安全边界安排独立兼容升级；本轮没有替换主树 SDK，也不因上游更新推断 D Code 的标题栏或成员命名问题会消失。

## 明确排除

- 507 已明确否定的 X/Twitter 帖子截图不属于参考清单。
- `SwiftUI`、`AppKit`、Node.js、Git、Mermaid 和 `visualize` 是平台、技术或制作工具，不属于竞品与仓库参考。

## 更新规则

- 增加参考时记录来源归属、稳定 URL、证据版本、借鉴点和不借鉴边界。
- 外部项目更新不自动改变 D Code；只有经 507 确认并进入产品契约或版本 PRD 的结论才成为需求。
- 临时截图如需长期使用，应复制到本目录的 `assets/` 并记录来源；不得长期依赖 `/var/folders/` 等临时路径。

2026-10-01 507 明确要求完成 Pi `0.99.1` 与 `0.0.37`。上述历史调查已进入主树适配与实际包验证：三个 SDK `0.99.1`、App／Host `0.0.37`，模型类型、ExtensionToolContext、登录方式和准备竞态边界均已接通；工程结果与未验收项由 [PRD 0038](../40-版本实施方案/0038-0.0.37-Pi-SDK-升级产品需求.md)及[本轮验证](assets/dcode-0.0.37-verification-2026-10-01.md)拥有。上述“未替换主树”的段落是 2026-09-30 的历史边界，不表示当前仍使用旧 SDK。
