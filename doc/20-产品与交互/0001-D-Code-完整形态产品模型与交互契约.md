# D Code 完整形态产品模型与交互契约

状态：Confirmed Target（已确认目标态）

本文件定义 D Code 跨版本持续逼近的完整产品形态。它是后续版本切割和界面设计的目标依据，不代表当前 App 已经交付这些能力；具体版本范围与验收仍由 `40-版本实施方案/` 中对应 PRD 规定。

## Problem Statement（问题陈述）

Pi 已经拥有真实会话、分支路径、复制会话、配置、模型和工具运行能力，但这些对象在原生桌面工作流中仍缺少稳定的信息层级。既有扩展也沉淀了 Goal、团队与通信等有价值的机制，但它们不是 D Code 的产品对象或界面基座。仅按 `cwd` 平铺会话无法表达一个工作主题包含多个代码目录，也无法同时满足快速恢复最近工作、查找完整历史、观察 Agent Team 和检查项目文件的需求。

D Code 必须在不建立第二套会话权威的前提下，提供由用户掌控的项目组织、对话优先的原生工作台，以及对 Pi 原有会话语义的一等呈现。来自既有扩展的成立机制应重构为 D Code 自有的结构化产品能力，不直接接入其 TUI 或把参考扩展设为运行时依赖。

## Product Model（产品模型）

### User Home（用户首页）

- D Code 启动后首先进入 User Home，而不是自动生成 Project。
- User Home 以当前 macOS 用户名标识使用者，但不把用户主目录当作会话发现边界。
- User Home 提供 D Code 创建的 Recent Sessions、全局搜索与全局新建会话入口；全局新建会话直接以当前 macOS 用户目录作为 `cwd`，不弹目录选择器。User Home 本身仍不是 Project，也不拥有项目文件。

### Recent Sessions（最近会话）

- Recent Sessions 只投影由 D Code 创建、带有效 `dcode-session-origin-v1` 来源条目且未被 D Code 归档的 Pi Session；置顶对象先按本机置顶时间排列，其余仍按最后更新时间降序排列。
- 来源条目不进入模型上下文，且其 Session ID 必须与会话头相同；路径、时间和文件名不能作为 D Code 创建来源的猜测依据。
- 初始只呈现最近 10 条 Session Summary，包括名称、`cwd`、更新时间与必要状态，不预加载完整对话正文。
- “查看更多”继续取得更早摘要；选择一条会话后才加载其完整对话与可恢复状态。
- 同一 Pi Session 可以同时出现在 Recent Sessions 与所属 Project 中，但始终是同一个稳定 Session ID 对象。

### D Code Project（D Code 项目）

- Project 是 D Code 自己定义的逻辑组织对象，不等于 Pi Session、Pi 会话目录或任一 `cwd`。
- Project 拥有名称、显示顺序与 Source Folder 集合；它不拥有 Pi Session 的消息、模型上下文或 Artifact。
- Project 可以包含多个 Source Folder；这些文件夹对应的 Pi Session 合并为一个项目会话列表。
- Project 会话跨 Source Folder 平铺排列，不以文件夹作为左栏分组层；每条会话的标题下方显示来源 Source Folder 与时间。置顶对象在该 Project 已成立的候选集合内优先，其余按更新时间排列；初始呈现前 10 条，再通过“查看更多”逐批显示更早记录。

### Source Folder（源文件夹）

- Source Folder 是用户明确添加到 Project 的确切目录。
- 同一个 Source Folder 同时最多属于一个 Project。再次添加时必须显示当前所属项目，并由用户明确执行“移动到此项目”；不得重复登记或静默移动。
- 移动 Source Folder 只改变 D Code 的项目组织元数据，不移动文件、不改写 Git，也不修改任何 Pi Session。
- 首个目标形态以 Source Folder 与 Pi Session 的规范化 `cwd` 相同作为关联条件；不会因父目录已登记而静默吸收任意后代目录的会话。

### Pi Session（Pi 会话）与项目投影

- Pi Session 的稳定 ID、消息、模型上下文和 Pi 已持久化的运行条目继续以 `~/.pi/agent` 为唯一权威。
- 添加 Source Folder 后，D Code 读取并展示已有 `cwd` 与该文件夹对应的 Pi Session；不需要导入、复制或重写 JSONL。
- 未关联的旧 Pi Session 不出现在 Recent 或任何 Project；打开、续写或观察旧会话不会把它转换为 D Code Recent Session。
- 在 Project 内新建会话时，用户先从该项目的 Source Folder 中选择一个目录；该目录成为新 Pi Session 的 `cwd`。
- Recent Sessions、Project 列表与 Search Results 都只是同一 Pi Session 权威上的不同可见性投影；三者在排序、分页和结果截断前统一排除 D Code 已归档的 Session ID，不改变会话身份或写入所有权。恢复归档只撤销该排除，不会为旧 Pi Session 补写 D Code 来源或 Project 关联。置顶只参与 Recent / Project 已成立候选集合的分页前排序，不能扩大可见范围或覆盖归档排除。

### Session Path（会话路径）与独立会话

- 同一 Pi Session 内的不同历史分支统一称为“会话路径”，不使用容易与 Git 混淆的“会话分支”。
- 用户消息提供“编辑并重走”；助手消息提供“从这里继续”。触发后 Composer 进入标明来源的“新路径草稿”，但此时不改写会话树；取消草稿不产生空路径。只有第一条非空消息成功发送时，才在同一 Session 中原子形成另一条路径并把它设为当前路径；原有路径始终保留。空消息、发送被拒绝或写入失败均不产生路径，并保留草稿供重试或取消。
- 触发路径动作前，如果当前 Composer 已有未发送内容，D Code 自动把它保留为当前会话路径的草稿，再进入新的路径草稿；不弹确认框，也不要求先清空。取消路径动作或切回原路径时恢复原文。被保留的内容仍只是输入草稿，不是 Pi 会话树节点，也不会提前写入 Pi Session。
- 未发送草稿由 D Code 在本机按稳定 Session ID 与会话路径分别保存；切换会话、切换路径或重启应用后都逐字恢复，包括空格与换行。尚未创建的新路径草稿按来源消息与路径动作单独保存，恢复它不会提前创建 Pi 会话树节点。草稿不写入 Pi JSONL、不进入全文搜索索引、不跨设备同步，也不进入诊断日志。
- 草稿不按时间自动过期，也不会因退出应用、切换会话或路径、移除 D Code Project、移除 Source Folder 关联而清除。只有对应内容发送成功、用户明确清空草稿（取消新路径草稿属于明确清空），或对应 Pi Session 被实际删除时，才清除相应本机草稿；删除一个草稿不得波及同一会话的其他路径草稿。
- 独立 Session 操作使用“复制到项目…”与“复制到项目并归档原会话…”。二者都把源 Session 的全部已持久化历史与路径复制到所选 Project Source Folder，创建新的 Session ID 与目标 `cwd`；源 Session、未发送草稿、项目文件和 Git 状态不变。
- “复制到项目并归档原会话…”只有在目标完整发布并验证可打开后才归档源 Session。归档只影响 D Code 可见性，源 Pi JSONL 仍由 Pi CLI 正常访问，并可从“已归档会话”恢复显示。
- 用户也可以直接归档当前可见 Session，而不先创建副本。直接归档没有复制目标；它与复制后归档同样保留 Pi JSONL、逐路径草稿与置顶状态，并能从“已归档会话”恢复。
- 路径切换、回溯和复制都只改变对话历史与模型上下文。项目文件和 Git 状态始终保持当前现实，不会回到历史消息所在时间点。

### Goal（目标）与 Work Map（工作地图）

- Goal 与 Work Item 是 D Code 自有、耐久且可恢复的工作对象，不等于 Project、Pi Session、Session Path 或一段对话。
- Work Item 保留稳定身份、状态、依赖、验收条件与完成证据；可关联一个或多个 Session / Path 作为执行参考，但创建工作项不会自动启动 Agent 或 D Team。
- 创建 Goal 时明确记录最终结果、验收证据、允许范围、不可退步条件、停止 / 阻塞条件与时间或尝试上限；未提供这些边界时不得把目标呈现成已经可以持续自动执行。
- 工作项生命周期、执行运行态和 User Attention（用户关注态）互相独立。“需要确认计划”、“需要回答”与“需要验收”是明确人工门禁，不得冒充执行失败或 Worker waiting。
- 当前 Goal 在 Composer 附近保持紧凑可见，显示阶段、已耗时、最近证据、待用户决定与阻塞原因。编辑只改变 Goal；暂停 / 继续只控制用户明确启动的当前执行；清除只退出当前 Goal 的活动呈现，不删除 Work Map、历史执行记录或完成证据。
- Plan、Changes、Verification（验证）与 Final Report（最终报告）可作为可寻址、可版本化的 Work Item 产物进入 Workspace Tab，不依赖翻找历史聊天才能恢复。
- D Code 可以识别 dgoal 等已有结构化状态，但 Goal / Work Map 的产品合同、可见性、恢复与验收由 D Code 自己定义。

## Information Architecture（信息架构）

### 左侧导航

- 左栏默认展开，是 User Home、Recent Sessions、Project 与 Session 的主导航。
- 首次使用只显示 Recent Sessions 与“新建项目”入口；创建 Project 后才出现对应项目结构。
- Project 主行与展开/收起控件分开：点击 Project 主行直接进入 Project 作用域并显示 Files，无需先选择任何 Session；展开后的 Session 跨 Source Folder 平铺，Source Folder 只显示为会话标题下方的来源说明。
- 完整会话谱系是所选 Session 的二级历史视图，不在日常导航中永久展开。
- Recent 与 Project 会话行在悬停或键盘聚焦时提供独立的置顶和归档按钮；已置顶状态常显。右键菜单和当前 Session 操作菜单提供等价入口，Hover 不是唯一可达方式。

### 中央工作空间

- 中央上方是 Workspace Tab 标签栏。第一个标签固定为“对话”、默认激活且不可关闭；第二个开始承载已打开的文件、Artifact、Preview 或 Editor，不预放尚无真实内容的空标签。
- “对话”标签显示当前会话的原生消息流、Active Plan 与 Composer。切到其他标签时这些视图可以隐藏，但其 Session、Session Path、滚动位置、输入草稿和恢复状态不得被重建或清除；切回后原位恢复。
- 从项目文件树再次打开同一文件时聚焦已有标签，不创建重复标签；同名文件用 Source Folder 或完整路径区分。关闭当前内容标签后切到相邻已打开标签，没有相邻内容时回到“对话”。
- Project 文件树和助手正文中的文件、目录与代码行引用使用同一打开合同：在 D Code 的 Workspace Tab 中打开并定位对应本机内容；目标不存在、超出已授权范围或行号失效时显示真实状态，不静默转交外部 IDE。
- Active Plan 以紧凑状态带出现在消息流与 Composer 之间，完成后让出空间。
- Composer 底部集中显示本次发送使用的模型与思考强度、极速开关和当前上下文占用；这些控制与占用状态不在顶部状态条或 Work Inspector 重复呈现。上下文占用可展开查看已用量与总容量，但已加载来源仍由 Session 的 Context 面板负责。
- 消息下方就近提供复制文本、编辑并重走及从这里继续等动作；完整会话复制与归档放在 Session 操作中，避免把完整 Fork 误解为从单条消息截取历史。
- 助手正文必须保留原始 Markdown 的段落、空行与列表换行；呈现样式不能改变复制得到的原始文本。
- Agent 成员的详细工作轨迹、通信和阶段结论可临时进入中央空间；不得展示隐藏的原始思维链。
- 普通代码文件可以先以只读 File Preview 打开；Markdown 默认打开富预览，进入编辑时以源码与富预览分栏呈现；HTML 以源码编辑缓冲区与隔离预览分栏呈现。Markdown 与 HTML 预览均跟随尚未保存的当前编辑缓冲区，不要求用户先保存；具体刷新调度与性能阈值由对应版本的实作验证确定，不在完整形态契约中预设数字。打开、聚焦、切换或关闭这些标签均不会自动加入模型 Context、创建消息或 Session Path；未执行明确保存动作前也不会改变文件与 Git 状态。
- HTML Preview 不得在宿主界面上下文中直接执行，不得继承 Pi 凭据、原生宿主桥或任意文件读取能力；脚本、网络与本地资源的具体授权策略由对应版本规格另行确认。

### Work Inspector（工作检查器）

- 右栏是可恢复、可折叠的 Work Inspector，不是新的内容主空间。
- Session 作用域投影与当前 Session / Path 相关的 Goal / Work Item、Agents 与 Context；Session 不拥有 Goal。Context 只呈现当前路径与已加载来源，不重复模型、思考强度、极速开关或上下文占用。
- Project 作用域包含 Files 与 Changes；Files 展示项目全部 Source Folder 的完整文件树，Changes 只呈现当前 Git 事实。
- 从左栏点击 Project 只切换工作检查器的作用域，不打开、创建或改写 Pi Session，也不清除中央当前标签、会话或草稿。
- 选择文件会在中央打开或聚焦对应 Workspace Tab，但不会自动加入模型 Context，也不会改变 Git 状态。
- Work Inspector 是可与会话同时操作的非模态右栏；空间允许时优先常驻，不给左栏或中央会话增加蒙版，也不从命中与无障碍树中移除它们。用户主动关闭依然是独立持久偏好。

### 响应式基线

- `≥1106 pt`：左栏 `286 pt`、中央至少 `480 pt` 与右栏 `340 pt` 并排。
- `880–1105 pt`：右栏优先常驻；左栏以临时覆盖打开，不污染用户的持久隐藏偏好。右栏常驻不产生蒙版。
- `<880 pt`：中央优先；左右栏均以互斥覆盖面板打开，此时才使用蒙版与模态背景约束。
- 既有 `1280 / 880 pt` 宽度类别仍可用于其他视觉调整，但可见列组合以上述中央最小宽度与非模态语义为权威。

## Conversation Round（工作轮）

- 一个产品工作轮以用户消息为起点，到下一条用户消息或当前已完成尾端为止；它可以包含多次底层 Pi turn、Thinking、中间助手叙述与工具调用。
- 完成后默认只显示最终助手回答；中间过程收入一个可展开的轮次摘要，摘要显示耗时、工具数与完成时间。失败或中止结果不得被默认隐藏。
- 运行中只显示当前 Thinking 片段或当前正在执行的工具；一段结束后原位替换，不在主阅读面持续堆叠。
- 历史耗时使用该轮用户条目到最后接受的 JSONL 持久化时间；“完成时间”是可跨重启恢复的持久化近似值，不声称等于 provider 返回或 `agent_settled` 的精确时刻。
- read/edit/write/search 等识别出的工具使用 D Code 自有原生 presenter 显示安全摘要、行锚点、边界与 diff；未识别结构保留通用 fallback。扩展可继续在 Host 中执行，但其 TUI renderer 不定义 D Code 界面。

## Search（搜索）

- 搜索参考 Codex 的轻量浮层形态打开，覆盖在当前工作台上方但不替换当前对话、左栏或工作检查器；关闭浮层后原工作状态保持不变。
- 全局搜索只覆盖“D Code 创建的 Recent Sessions”与“已关联 Project Source Folder 投影出的会话”的并集，而不只覆盖当前已经显示的 10 条摘要。
- 可搜索会话标题、用户消息正文和助手消息正文。
- 默认不搜索隐藏 thinking、原始工具输入、工具结果、认证内容或其他可能含凭据的非对话正文。
- 结果显示命中片段、会话名称、更新时间、`cwd`、所属 Project 与 Source Folder；可按 Project 和 Source Folder 缩小范围。
- 搜索命中未加载的旧会话时，选择结果会打开对应稳定 Session ID 并定位相关消息。
- 搜索索引只能是可从 Pi 会话重建的本地缓存；索引缺失或损坏不能改变 Pi Session，也不能伪装成“没有历史”。

## Agent Team（智能体团队）

- Agent Profile 是具有稳定身份和版本的可复用本机定义，包含名称、职责说明、可选默认工作范围与模型路由；完整目标态还可引用版本化 Skill 与 Permission Policy。创建、编辑或选择档案不会启动 Worker，也不会创建 Pi Session；编辑只影响未来运行。
- Agent Team 属于当前 Session 的一次 Team Run，而不是独立 Task 导航层；活动团队保留派发时的 Session Path 来源，切换会话路径不伪装把运行中 Worker 热迁移到新上下文。
- Team Run 必须由用户或主智能体在明确边界下显式启动；短任务默认继续由单 Agent 完成。协调、执行与验证是当次任务职责，不是强制的固定档案类型；一个 Agent Profile 可在不同 Team Run 中承担不同职责。
- 主智能体负责理解、派发、判断、中转和最终综合；成员负责有界工作项或证据问题。Finding、Request、指令与交接均由主智能体有界中转，首版不声称 Worker P2P、自组织依赖调度或自动合并。
- 每个 Team Member Run 保存所用 Profile 版本、当次任务、实际模型、Effective Grant、声明写入范围、来源上下文、queued / running / waiting / completed / failed 状态、可见事件与结构化 Report；背后的 Worker Runtime 只属于 Host 运行期。
- 右栏负责团队概览、成员选择、当次职责、实际模型与工具授予、运行状态、当前活动、耗时 / 用量、卡住与重试；中央负责所选成员的 Finding、Request、控制记录、Verifier 退回原因与结构化 Report。
- 主对话在运行中只突出当前活动和需要用户处理的 Request；成员已经结束的过程折叠进 Team Run，最终综合与结构化 Report 保持可见，不把成员日志重新铺满主对话。
- Worker completed 只表示已收到合法结构化报告；Team Run closed 表示主智能体已综合并关闭本轮；Work Item done 仍需要验收条件或用户确认成立。三者不得自动逐级推导。
- 对外呈现使用“工作轨迹”“发现”“请求”“控制”和“结论”；不展示隐藏的原始推理过程、完整 Worker Transcript 或凭据。运行时可以留在 Host 内存中，需要跨重启恢复的只是脱敏的可见事件、团队摘要与结构化报告。
- `pi-dteam`、`pi-intercom` 与 `pi-messenger` 只作为机制与呈现参考；Agent Team 的产品对象、数据合同、生命周期、Host IPC 和原生呈现由 D Code 自己定义，不要求用户安装它们，也不解析它们的 TUI。

## Cross-Session Collaboration（跨会话协作）

- 跨会话协作以耐久 Work Item 为锚点，使用稳定消息身份记录来源与目标 Session / Path、关联 Goal / Work Item / Team Report、送达、已读、失败、幂等重试与重启恢复。
- 跨会话消息是独立系统对象，不伪装成普通用户回复；接收 Session 自己决定是否将交接纳入对话上下文或 Work Map。
- 交接送达本身不会启动新的 Session 或 Team Run；只有接收方或用户明确采纳后才可显式启动。后续执行不恢复已经销毁的 Worker Runtime，不共享 Session Lease，也不支持在途模型生成或工具执行的热迁移。

## Local Skills, Permissions and Recovery（本机技能、权限与恢复）

- D Code 基于 Pi 已发现的本机 Skill 显示名称、来源、作用、启用状态与兼容性；Skill 不授予工具、文件、网络或凭据权限。只有接通 Pi 的真实配置读写合同后才提供启用 / 停用操作，不建立第二套 Skill 配置权威或在线市场。
- Agent Profile 的 Permission Policy 只定义未来运行可请求能力的默认值和上限；Team Member Run 启动时结合用户决定与当前范围解析为不可变 Effective Grant。声明写入范围用于任务约束与审计时，不得冒充操作系统级文件沙箱。
- 权限请求必须说明将执行的动作、目标路径或命令、风险理由与作用范围，并提供“本次允许”“当前范围允许”和“拒绝”等与真实能力相符的选择。删除、覆盖、工作目录外读取及具有外部副作用的动作始终保留人工门禁。
- HARD / SOFT 风险、权限决定、Goal / Team 控制、失败与重试形成可回放的本机审计事件。重启只恢复 Work Map、脱敏摘要、可见事件与结构化 Report，不伪装恢复已经销毁的 Worker Runtime。
- 上下文或用量只有在 Pi 提供可确认的本地来源数据时才分项展示；接近限制时提供明确提醒，不引入账号积分或远程计费语义。
- D Code 不建立与 Pi 平行的模型供应商或 BYOK 配置，也不把 Remote Control、IM、云端 / 定时任务、在线部署、账号增长或 Cookie 导入纳入本机核心工作流。

## Confirmed Constraints（已确认约束）

- 产品仅支持 macOS，并使用原生 SwiftUI/AppKit 界面。
- 产品界面默认使用简体中文。“项目”“源文件夹”“会话”“会话路径”“目标”“智能体”“上下文”“文件”“变更”和“工作清单”等产品概念不得以英文作为主要界面文案；`D Code`、模型名、命令、文件路径与代码标识符保留原文。
- `~/.pi/agent` 继续是 Pi 配置与会话的权威来源；D Code 不建立竞争性会话历史数据库。
- D Code 会话来源以同一 Pi Session 内的结构化 Custom Entry 持久化，只影响导航可见性，不复制消息或模型上下文。
- Project 名称、顺序与 Source Folder 归属是 D Code 自有组织元数据，与 Pi 会话权威严格分离。
- Swift 前端不直接修改 Pi 会话 JSONL；会话写入继续经过嵌入 `pi-coding-agent` SDK 的 D Code Host。
- D Code 不直接依赖或调用 `pi-tui`；所有产品界面由自有 SwiftUI/AppKit 组件或受控内容渲染器实现。传递依赖可以存在，但不得成为呈现路径。
- 外部产品只提供本地信息层级与交互机制参考；D Code 不因竞品对齐引入其云端权威、远程控制、账号体系、在线市场或 Runtime。
- 同一 Pi Session 同时只有一个写入所有者，不支持在途模型生成、工具执行或阻塞交互的热迁移。
- 文件变化与代码分支以当前文件系统和 Git 为准；Session Path 不承担代码快照或代码回滚职责。
- 目标形态由本文件约束；各版本只实现 `40-版本实施方案/` 明确切出的子集。

## Acceptance Criteria（目标态验收标准）

### 最近会话、Project 与 Source Folder

- [ ] 全新状态打开 D Code 时只出现 Recent Sessions 和新建 Project 入口，不自动把 `cwd` 分组冒充 Project。
- [ ] 未带 D Code 来源的旧 Pi Session 不会直接出现在 Recent；Recent 首屏最多显示由 D Code 创建的最近 10 条摘要，“查看更多”只继续读取同一来源集合。
- [ ] 用户可以创建 Project 并添加多个 Source Folder；Project 会按更新时间平铺显示这些文件夹已有的 Pi Session，不出现 Source Folder 会话分组，每条会话在标题下显示来源文件夹。
- [ ] 在 Project 内由 D Code 新建的会话同时出现在 Recent 与该 Project，两处指向相同稳定 Session ID。
- [ ] 已经属于其他 Project 的 Source Folder 不能重复添加；界面显示现有归属，只有明确确认后才移动。
- [ ] 移动 Source Folder 前后，真实文件、Git 状态、Pi Session ID 与 JSONL 内容均不被改写。
- [ ] 在多 Source Folder Project 中新建会话时必须选择一个具体文件夹，新会话的 `cwd` 与选择一致。

### 搜索与恢复

- [ ] 全局搜索能够命中可见会话集合中、首屏 10 条之外的历史会话标题、用户消息和助手消息，不命中未关联的旧 Pi Session。
- [ ] 搜索结果展示足以区分同名会话的 Project、Source Folder、`cwd`、时间与命中片段，并支持按 Project 或 Source Folder 缩小范围。
- [ ] 选择搜索结果后打开同一个稳定 Session ID，并可定位命中消息；不会创建导入副本。
- [ ] 删除搜索索引后可以从 Pi 会话重新生成；索引为空、过期或损坏时显示明确状态，不改写原会话。

### 工作台与会话路径

- [ ] 主导航、操作、状态、空白页、错误和检查器标签均以简体中文呈现；除品牌、模型名、命令、路径与代码标识符外，不出现英文优先的产品文案。
- [ ] `≥1106pt` 默认呈现左栏、对话和 Work Inspector；`880–1105pt` 保持右栏非模态常驻、左栏按需临时覆盖；窄于 `880pt` 时使用互斥覆盖面板。
- [ ] 用户手动隐藏右栏后，窗口恢复宽度不会擅自重新打开；中宽时右栏常驻也不会遮罩或禁用左栏与对话。
- [ ] Session 与 Project 作用域中的检查器内容严格分开；点击 Project 无需先打开 Session 即可看到覆盖全部 Source Folder 的 Files，且不改变中央当前会话、草稿、上下文或 Git 状态。
- [ ] 中央第一个 Workspace Tab 固定为“对话”且不可关闭；内容标签从第二个开始按真实文件或产物创建，同一对象不会重复打开，同名对象能凭 Source Folder 或完整路径区分。
- [ ] 在文件、Artifact 或 Editor 标签间切换并返回“对话”后，原 Session、Session Path、transcript 滚动位置、Active Plan 与逐字输入草稿均保持；标签操作不新增消息、路径或 Context。
- [ ] 模型与思考强度、极速开关、上下文占用集中在 Composer 底部且可操作；顶部状态条与 Work Inspector 不重复这些状态。切换模型或极速状态不会清除当前草稿，上下文占用展开后能显示已用量与总容量。
- [ ] 普通代码文件可以只读预览；Markdown 默认显示富预览并可进入源码/预览分栏编辑；HTML 能在源码/预览分栏中跟随未保存缓冲区持续刷新，且预览无法访问宿主桥、Pi 凭据或未授权文件。
- [ ] 从用户消息编辑并重走、从助手回复继续分别产生正确的同会话路径；“复制到项目…”与“复制到项目并归档原会话…”创建新 ID、新 `cwd` 的完整独立 Session，且源 Pi Session 始终保留。
- [ ] “编辑并重走”与“从这里继续”先进入明确的“新路径草稿”；点击动作和取消草稿都不改变会话树，只有第一条非空消息成功发送才创建路径。空消息或发送失败不留下空路径，并保留草稿。
- [ ] 当前路径已有未发送内容时，进入新路径草稿会自动保留原文；取消或切回原路径后逐字恢复。保留过程不弹确认框、不创建消息或路径，也不把原草稿带入新路径。
- [ ] 已保存的当前路径草稿与尚未创建的新路径草稿在切换会话、切换路径和应用重启后仍能逐字恢复；恢复时按稳定 Session ID 与路径身份隔离，不会串入其他会话或提前写入 Pi Session。发送成功后只清除被发送的那一份草稿。
- [ ] 草稿没有自动过期；退出应用、切换上下文以及移除 Project 或 Source Folder 关联都不清除草稿。发送成功或用户明确清空时只清除目标草稿；只有对应 Pi Session 被实际删除时才清除该会话的全部本机草稿。
- [ ] 所有路径与复制操作都明确提示项目文件保持当前状态，不创建、切换或还原 Git 分支。
- [ ] 普通复制后源 Session 继续可见；复制并归档只有在目标验证成功后隐藏源 Session，且归档源可恢复、Pi JSONL 不被删除或改写。
- [ ] Recent 与 Project 行悬停、键盘聚焦、右键菜单和 Session 菜单均可置顶或直接归档；置顶不扩大可见集合并在分页前生效，直接归档不伪造复制目标，恢复后保留草稿和置顶状态。
- [ ] 助手 Markdown 中的段落、空行、无序列表与有序列表按原结构显示，不压成连续文字；复制仍返回原始正文。

### Goal、D Team 与跨会话协作

- [ ] Goal 与 Work Item 可跨重启恢复，目标结果、验收证据、允许范围、停止条件、状态、依赖、完成证据与执行参考保持稳定；创建或编辑工作项不会自动创建 Pi Session 或启动 D Team。
- [ ] 当前 Goal 在输入区附近显示阶段、耗时、最近证据、待决定与阻塞原因；暂停 / 继续只控制明确启动的当前执行，清除活动 Goal 不删除 Work Map、历史执行记录或证据。
- [ ] 执行状态和用户关注态同时可见且不互相覆盖；确认计划、回答问题和验收结果均有明确操作，不以失败或无限加载伪装。
- [ ] Agent Profile 可独立创建和编辑稳定身份、名称、职责、可选默认工作范围与模型路由，且不会因保存档案而启动 Worker；同一档案可在不同 Team Run 中承担不同职责，修改也不会热更新在途成员。
- [ ] D Team 只能显式启动，短任务仍可保持单 Agent；团队概览能显示成员职责与权限、排队 / 运行 / 等待 / 已报告 / 失败、当前活动、耗时 / 用量、卡住 / 重试、经主智能体中转的发现 / 请求 / 指令、Verifier 退回原因与结构化报告，同时不暴露隐藏推理、完整 Worker Transcript 或凭据。
- [ ] Worker 报告、Team Run 关闭与 Work Item 验收三种完成语义可独立判定，任一前置状态都不会自动推导后续完成。
- [ ] 跨会话消息保留稳定身份、来源、目标、引用、送达、已读与失败状态；重试幂等，重启后可恢复，且不会被呈现为普通用户消息。

### 本机 Skill、权限与恢复

- [ ] 本机 Skill 列表能区分来源、启用状态与兼容性；没有真实 Pi 配置合同的动作只读呈现，不出现在线市场或虚假启停按钮，也不把 Skill 冒充权限授予。
- [ ] Profile Permission Policy 与 Member Run Effective Grant 可区分查看；运行记录固定实际模型、工具授予、Skill 身份 / 版本和声明写入范围，后续配置变化不会静默改写历史。
- [ ] 权限卡明确显示动作、目标、风险理由与作用范围；删除、覆盖、工作目录外读取和外部副作用不能被永久静默放行。
- [ ] 权限决定、Goal / Team 控制、失败与重试可从脱敏本机事件恢复；重启不会伪装恢复 Worker Runtime，也不会持久化隐藏 Thinking、完整成员 Transcript 或凭据。

## Out of Scope（本规格非目标）

- 在本文中规定具体存储格式、索引引擎、IPC 字段、分页游标或 Swift 类型。
- 让一个 Source Folder 同时属于多个 Project。
- 把 Session Path 与 Git 分支、文件快照或工作树绑定。
- 搜索隐藏 thinking、原始工具日志或凭据正文。
- 以 HTML 原型代替原生 App 的实现、自动测试或人工验收。

## Prototype（交互原型）

可交互参考见 [工作台交互原型说明](原型/README.md)，逐版本变化见 [版本界面演进](原型/版本演进/README.md)。原型中的名称、消息、智能体状态、文件树与 Git 标记均为模拟数据；产品行为以本文件和后续版本 PRD 为准。
