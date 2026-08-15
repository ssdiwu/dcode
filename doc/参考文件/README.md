# 外部产品与仓库参考

状态：Reference Index（参考索引）

最后对齐：2026-08-13

## 权威边界

本目录记录 507 明确提供的外部产品、界面和仓库参考，以及 D Code 已确认的借鉴边界。它帮助后续设计与实现理解“为什么这样做”，但不直接定义产品需求，也不能证明能力已经实现。

- 目标形态以 [`20-产品与交互/`](../20-产品与交互/README.md) 为准。
- 版本范围与验收以 [`40-版本实施方案/`](../40-版本实施方案/README.md) 为准。
- 当前实现以源码、测试和 [`10-架构与运行/`](../10-架构与运行/README.md) 为准。
- “借鉴”默认指学习对象、信息层级和交互机制，不表示接入其运行时、复制其视觉皮肤或增加对应依赖。

## 参考索引

| 编号 | 参考对象 | 类型 | 507 提供的来源 | 当前定位 |
|---|---|---|---|---|
| REF-001 | OpenAI Codex 桌面端 | Product UI（产品界面） | 多张界面截图与持续对照反馈 | 工作台主骨架参考 |
| REF-002 | ZCode | Product UI（产品界面） | [zcode.z.ai/cn](https://zcode.z.ai/cn) | 信息层级参考 |
| REF-003 | MiniMax Code | Product UI（产品界面） | 本机 `3.0.60` 与[官方本地产品文档](https://agent.minimaxi.com/docs/code/welcome) | 本地工作台、Goal、Agent 与权限交互参考 |
| REF-004 | PiDeck | Open-source App（开源应用） | [Skitre/PiDeck](https://github.com/Skitre/PiDeck) | Pi 能力运用与差距检查 |
| REF-005 | Flue | Agent Harness（智能体宿主） | [withastro/flue](https://github.com/withastro/flue) | 架构参考，不作为 D Code 基座 |
| REF-006 | Orca | Open-source App（开源应用） | [stablyai/orca](https://github.com/stablyai/orca) | 标签、编辑与预览参考 |
| REF-007 | pi-intercom | Pi Extension（Pi 扩展） | [nicobailon/pi-intercom](https://github.com/nicobailon/pi-intercom) | 跨会话通信机制参考 |
| REF-008 | pi-messenger | Pi Extension（Pi 扩展） | [nicobailon/pi-messenger](https://github.com/nicobailon/pi-messenger) | 多智能体协作机制参考 |
| REF-009 | Todos | Agent Team Workspace（智能体团队工作空间） | [todos.dev](https://todos.dev/) | Work Map、Run 历史与人工门禁参考 |
| REF-010 | pi-dteam | Pi Extension（Pi 扩展） | [ssdiwu/pi-dteam](https://github.com/ssdiwu/pi-dteam) | D Team 执行层机制参考 |
| REF-011 | Codex Taskboard | Local-first Taskboard（本地优先任务看板） | [chuspeeism/dashi-taskboard@9b2aeb53](https://github.com/chuspeeism/dashi-taskboard/tree/9b2aeb53bfe8d40eb5d65feecdfc2cc235928066) | 外部状态流转与会话关联参考，未进入版本路线 |

## REF-001 OpenAI Codex 桌面端

**D Code 借鉴**：

- 左侧 Project（项目）与 Session（会话）导航、中央工作空间、按宽度自然出现的右侧检查器；
- 对话是唯一会话主页面且不建立冗余标签，文件或产物真实打开后才按需出现内容标签；
- 覆盖当前工作台的轻量全文搜索浮层；
- 在 Composer（输入区）集中模型、思考强度、极速模式与上下文占用；
- 把外观、布局等应用级偏好放入独立 Settings（设置）空间；D Code `0.0.1` 先落系统/浅色/深色与真实布局偏好，设置项增长后再引入分类侧栏；
- 消息下方的继续、重走、复制等就地动作。

**明确不借鉴**：不复制品牌、视觉皮肤、Codex 的 Task（任务）数据模型或任何未由 Pi Session（Pi 会话）支持的隐含语义；不为了像 Codex 而预放权限、账号、语言、插件、环境等尚无真实 D Code 行为的空设置页。

**证据边界**：507 提供的截图位于会话临时附件中，尚未复制为仓库资产；本条保存已经确认的结构结论，不把截图当成持续可用文件。

## REF-002 ZCode

**D Code 借鉴**：成熟工作台的整体信息层级，包括耐久导航、中央对话、固定输入区，以及靠近工作内容的紧凑活动与进度呈现。

**明确不借鉴**：不复制营销视觉、Web/Electron 外观、不保留中央最小宽度却强行挤入的右栏，也不因参考其界面引入第二套 Agent Runtime（智能体运行时）。D Code 的 Work Inspector 在空间允许时非模态常驻，并通过左栏临时覆盖保留中央宽度。

## REF-003 MiniMax Code

**已核实证据**：本机 `/Applications/MiniMax Code.app` 为 `3.0.60`（build `3.0.60.123`）；版本元数据只证明研究对象，不单独证明具体界面行为。本路线只采用 507 明确采纳的观察，以及 [Tasks](https://agent.minimaxi.com/docs/code/workflows/tasks)、[Panels](https://agent.minimaxi.com/docs/code/desktop/panels)、[Goal](https://agent.minimaxi.com/docs/code/desktop/goal)、[Agent Team](https://agent.minimaxi.com/docs/code/agents/team)、[Custom Agents](https://agent.minimaxi.com/docs/code/agents/custom-agents) 与 [Permissions](https://agent.minimaxi.com/docs/code/workflows/permissions) 可核实的本地产品机制；不反编译应用或复制其代码、文案和视觉资产。具体动态行为仍需在进入版本 PRD 时记录可复现操作路径。

**D Code 借鉴**：

- 对话仍是任务主空间，本机文件、变更与运行信息作为可并行操作的上下文，不用模态蒙版切断左栏和中央对话；
- Project 文件树和助手正文中的文件、目录、代码行引用可在 D Code 自有 Workspace Tab 中打开并定位；
- Goal 在输入区附近持续显示阶段、耗时、证据、阻塞与人工控制，但不取代 D Code 的耐久 Work Map；
- Agent Profile 与 Team Member Run 继续分离，但 Profile / D Team 已移至 `0.3.x` 候选方向；`0.1.0` 前只在 `0.0.7` 建立独立于 Skill 的动作权限，在 `0.0.11–0.0.12` 建立一次性资源调用与本机 Skill / Prompt / Command / Extension 管理，在 `0.0.13–0.0.14` 建立 Pi 模型目录、启用范围与自定义供应商管理；
- 权限请求显示动作、目标、风险理由与作用范围；上下文和用量只呈现 Pi 能提供的真实本地数据。

**明确不借鉴**：不复制 Electron 架构或视觉皮肤，不照搬固定 Coder / Verifier / General 角色，不把团队成员提升为独立 Task 层级，也不展示隐藏的原始推理过程。Remote Control、IM、云端 / 定时任务、账号积分与签到、在线部署、Chrome Cookie 导入、BYOK、Skill 市场和增长反馈入口均不进入 D Code 本机版本路线。

**产品边界**：MiniMax Code 只提供本地信息层级与交互参考。D Code 继续使用 SwiftUI / AppKit、Pi 配置与 Session 权威、无冗余标签的唯一会话主页面、按需内容标签、耐久 Work Map、显式 Team Run 与主智能体有界中转，不接入 MiniMax Runtime。

## REF-004 PiDeck

**D Code 借鉴**：观察第三方如何调用 Pi 的会话与 Agent 能力，用作 D Code 能力覆盖、交互入口和 SDK 使用方式的差距检查。

**明确不借鉴**：PiDeck 不成为 D Code 的产品壳、会话权威或运行时依赖；任何能力仍须回到 D Code 的原生产品模型和 Pi SDK 合同中验证。

## REF-005 Flue

**D Code 借鉴**：Agent Harness（智能体宿主）的语义事件、单会话所有权、持久接收和能力分层思想。

**明确不借鉴**：不采用 Flue 的 Runtime（运行时）、会话数据库、HTTP/SSE 协议、React UI 或扩展编写模型。D Code 继续使用 Pi Session 作为会话权威，并通过自己的 Host 与原生 macOS 界面工作。

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

## 技术上游，不属于竞品参考

[`earendil-works/pi`](https://github.com/earendil-works/pi) 是 D Code 使用的 Pi SDK 上游技术证据，不是 507 新提供的竞品参考。D Code 使用 `pi-coding-agent` 的程序化接口；`pi-ai` 与 `pi-agent-core` 提供底层运行能力。`pi-tui` 可以作为 `pi-coding-agent` 的传递依赖存在，但 D Code 不直接依赖、调用或用它呈现产品界面。

## 明确排除

- 507 已明确否定的 X/Twitter 帖子截图不属于参考清单。
- `SwiftUI`、`AppKit`、Node.js、Git、Mermaid 和 `visualize` 是平台、技术或制作工具，不属于竞品与仓库参考。

## 更新规则

- 增加参考时记录来源归属、稳定 URL、证据版本、借鉴点和不借鉴边界。
- 外部项目更新不自动改变 D Code；只有经 507 确认并进入产品契约或版本 PRD 的结论才成为需求。
- 临时截图如需长期使用，应复制到本目录的 `assets/` 并记录来源；不得长期依赖 `/var/folders/` 等临时路径。
