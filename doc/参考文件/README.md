# 外部产品与仓库参考

状态：Reference Index（参考索引）

最后对齐：2026-08-10

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
| REF-003 | MiniMax Code | Product UI（产品界面） | Agent Team 界面截图 | 智能体团队呈现参考 |
| REF-004 | PiDeck | Open-source App（开源应用） | [Skitre/PiDeck](https://github.com/Skitre/PiDeck) | Pi 能力运用与差距检查 |
| REF-005 | Flue | Agent Harness（智能体宿主） | [withastro/flue](https://github.com/withastro/flue) | 架构参考，不作为 D Code 基座 |
| REF-006 | Orca | Open-source App（开源应用） | [stablyai/orca](https://github.com/stablyai/orca) | 标签、编辑与预览参考 |
| REF-007 | pi-intercom | Pi Extension（Pi 扩展） | [nicobailon/pi-intercom](https://github.com/nicobailon/pi-intercom) | 跨会话通信机制参考 |
| REF-008 | pi-messenger | Pi Extension（Pi 扩展） | [nicobailon/pi-messenger](https://github.com/nicobailon/pi-messenger) | 多智能体协作机制参考 |

## REF-001 OpenAI Codex 桌面端

**D Code 借鉴**：

- 左侧 Project（项目）与 Session（会话）导航、中央工作空间、按宽度自然出现的右侧检查器；
- 对话优先，中央第一个标签固定为对话，后续标签承载文件或产物；
- 覆盖当前工作台的轻量全文搜索浮层；
- 在 Composer（输入区）集中模型、思考强度、极速模式与上下文占用；
- 把外观、布局等应用级偏好放入独立 Settings（设置）空间；D Code `0.0.1` 先落系统/浅色/深色与真实布局偏好，设置项增长后再引入分类侧栏；
- 消息下方的继续、重走、复制等就地动作。

**明确不借鉴**：不复制品牌、视觉皮肤、Codex 的 Task（任务）数据模型或任何未由 Pi Session（Pi 会话）支持的隐含语义；不为了像 Codex 而预放权限、账号、语言、插件、环境等尚无真实 D Code 行为的空设置页。

**证据边界**：507 提供的截图位于会话临时附件中，尚未复制为仓库资产；本条保存已经确认的结构结论，不把截图当成持续可用文件。

## REF-002 ZCode

**D Code 借鉴**：成熟工作台的整体信息层级，包括耐久导航、中央对话、固定输入区，以及靠近工作内容的紧凑活动与进度呈现。

**明确不借鉴**：不复制营销视觉、Web/Electron 外观、常驻挤压主空间的右栏，也不因参考其界面引入第二套 Agent Runtime（智能体运行时）。

## REF-003 MiniMax Code

**D Code 借鉴**：Agent Team（智能体团队）是当前 Session 内的一组协作者；成员可以彼此通信，用户可以集中查看成员职责、状态、工作轨迹、通信和阶段结论，并按成员展开细节。

**明确不借鉴**：不照搬固定 Coder/Verifier/General 角色，不把团队成员提升为独立 Task 层级，也不展示隐藏的原始推理过程。

**证据边界**：当前来源是 507 提供的产品截图；后续如需核实动态行为，应补充可复现的产品版本与操作路径。

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

**D Code 借鉴**：同一 Project 内多个 Agent 的通信网络，与 MiniMax Code 的 Agent Team 用户形态结合，让用户能集中理解每个成员做了什么、说了什么和形成了什么结论。

**明确不借鉴**：不直接接入其 TUI、会话存储或扩展 UI；成员、消息、活动和结论由 D Code 自有数据合同表达。

## 技术上游，不属于竞品参考

[`earendil-works/pi`](https://github.com/earendil-works/pi) 是 D Code 使用的 Pi SDK 上游技术证据，不是 507 新提供的竞品参考。D Code 使用 `pi-coding-agent` 的程序化接口；`pi-ai` 与 `pi-agent-core` 提供底层运行能力。`pi-tui` 可以作为 `pi-coding-agent` 的传递依赖存在，但 D Code 不直接依赖、调用或用它呈现产品界面。

## 明确排除

- 507 已明确否定的 X/Twitter 帖子截图不属于参考清单。
- `SwiftUI`、`AppKit`、Node.js、Git、Mermaid 和 `visualize` 是平台、技术或制作工具，不属于竞品与仓库参考。

## 更新规则

- 增加参考时记录来源归属、稳定 URL、证据版本、借鉴点和不借鉴边界。
- 外部项目更新不自动改变 D Code；只有经 507 确认并进入产品契约或版本 PRD 的结论才成为需求。
- 临时截图如需长期使用，应复制到本目录的 `assets/` 并记录来源；不得长期依赖 `/var/folders/` 等临时路径。
