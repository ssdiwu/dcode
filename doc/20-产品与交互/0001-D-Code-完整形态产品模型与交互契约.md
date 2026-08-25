# D Code 完整形态产品模型与交互契约

状态：Confirmed Target（已确认目标态）

本文件定义 D Code 跨版本持续逼近的完整产品形态。它是后续版本切割和界面设计的目标依据，不代表当前 App 已经交付这些能力；具体版本范围与验收仍由 `40-版本实施方案/` 中对应 PRD 规定。

## Problem Statement（问题陈述）

D Code 要解决的不是“怎样把 Pi CLI 搬进原生窗口”，而是如何让一个长期项目中的任务、会话、多个 Agent、一等项目文档、Knowledge、Vision、产物和证据形成可持续工作的同一产品环境。会话只是上下文容器，模型只是某次运行事实，Pi SDK 只是首个 Runtime；它们都不能定义 D Code 的产品身份。

D Code 因而必须原生拥有产品数据、模型资源、能力配置和上下文组装。旧 Pi 会话可以单向导入，但导入后由 D Code 独立演化；既有 Pi 扩展只提供已经验证的机制，不成为 D Code 的品牌、对象、TUI 或永久运行时依赖。

## Product Model（产品模型）

### User Home（用户首页）

- D Code 启动后首先进入 User Home，而不是自动生成 Project。
- User Home 以当前 macOS 用户名标识使用者，并呈现 User Scope Task，但不把用户主目录伪装成 Project 或会话发现边界。
- User Home 提供 User Scope Task、Project、近期工作、需要关注的工作、全局 Knowledge、Vision、全局搜索与 Creation Mode（全局创造模式）入口。开始新工作可以进入 User Scope，也可以选择 Project；User Home 本身不是默认 Project，也不拥有项目文件。

### Recent Sessions（最近会话）

- Recent Sessions 是 D Code Session 的快速入口，不是项目主干或独立会话数据库。
- 初始只呈现有界 Session Summary，包括名称、所属 Task、Project / User Scope、更新时间与必要状态，不预加载完整对话正文。
- “查看更多”继续取得更早摘要；选择一条会话后才加载其完整对话与可恢复状态。
- 同一 D Code Session 可以出现在多个投影视图，但始终只有一个稳定身份，并能返回所属 Task。

### D Code Project（D Code 项目）

- Project 是长期持续演化的产品与工作容器，拥有名称、唯一 Project Directory、一等项目文档、Project Knowledge、Project Vision 和 Task 集合；它不等于 Task 或 D Code Session。
- 每个 Project 恰有一个规范化、可访问的项目目录；每个规范化目录最多属于一个 Project。目录不能重复登记、静默抢占或作为第二个目录附加给同一 Project。
- Project 通过 Task View 呈现任务列表、看板、路线图、Agent 执行或用户关注等不同视图；所有视图只投影同一批 Task，不建立第二状态源。
- 编辑 Project 并改目录时，D Code 更新 Project、Task、Session 与执行目录关系；是否迁移目录内文件是默认关闭的独立选择，不能改写 Pi 导入源或自动合并、覆盖文件。

### Project Directory（项目目录）

- Project Directory 是用户在创建或编辑 Project 时选择的确切目录。
- 项目目录是文件树根、新 Task 与 Agent Run 的默认执行目录；不会因登记父目录而静默吸收任意后代目录或外部会话。
- Project 改目录不是 Session Copy：迁移不创建新 Session ID，也不把原会话变成副本；活动运行和未确认外部副作用仍须先安全收口。

### First-class Project Documents（一等项目文档）

- D Code 把 Project Map、`AGENTS.md`、`DESIGN.md`、`PRODUCT.md`、精确 PRD、根 `GLOSSARY.md` 与 ADR 识别为具有稳定职责的一等项目文档。
- LLM 根据 Task、作用域和当前判断直接读取原文，并保留路径、revision、当前或历史身份与取代关系；一等不等于每轮全文注入。
- `AGENTS.md` 在 Agent Run 建立及每次 Session Run 启动前解析；工作目录作用域变化只影响下一 Run，不热改已经开始的 Run。其他文档按设计、需求、术语冲突、产品判断和决策核对需要加载。
- 根 `GLOSSARY.md` 是术语 Markdown 唯一权威；JSON 或数据库只能是从它生成、可删除重建的索引。

### Task（任务）

- Task 是 D Code 的基本完成单位，必须恰好属于一个 Project Scope 或当前用户的 User Scope，并拥有短期目标、范围、状态、Plan、Work List、多个 D Code Session、Agent Run、Knowledge 引用、Artifact、Evidence 与验收。
- User Scope Task 不使用 nullable Project 或“未选项目”身份；默认执行目录映射为用户 Home Directory，产品数据统一进入 `~/.dcode/`。
- 一个任务可以由单 Agent、多 Agent 串行接力或 Agent Team 并行推进；创建或编辑 Task 不会自动启动 Agent。
- 模型回复、Session Run、Agent Run、Team Run、测试、人工验收、提交、推送和发布分别成立，不自动逐级推导任务完成。

### D Code Session（D Code 会话）与 Pi 导入

- D Code Product Store 是 Session ID、Raw Input、Effective Input、消息、Session Path、运行记录、上下文投影与恢复事实的产品权威。
- 在 User Scope、Project 或 Task 中提交一项新工作时，产品语义是创建对应作用域的 Task 及其首个 D Code Session；任务也可以先以 Task Draft 存在而没有正式会话。
- `0.0.28` 升级时，已经由 D Code 管理的可见 Pi Session 自动转换为一条 Legacy Task 及其首个 D Code Session：唯一 Project 归属保留，无明确 Project 时进入 User Scope，关联本机状态同事务迁移。
- 其他 Pi Session 只有用户点击显式“导入为任务”按钮才进入；用户选择 Project Scope 或 User Scope 后，D Code 创建新的 Task 与首个 Session。两种路径都保留来源和转换证据、不修改源 JSONL；进入后使用新身份独立演化，不双写、不持续同步，也不承诺 Pi 兼容导出。
- 完整导出使用 D Code 自有格式；外部格式只作为明确标注能力损失的适配。

### Session Path（会话路径）与独立会话

- 同一 D Code Session 内的不同历史分支统一称为“会话路径”，不使用容易与 Git 混淆的“会话分支”。
- 用户消息提供“编辑并重走”；助手消息提供“从这里继续”。触发后 Composer 进入标明来源的“新路径草稿”，但此时不改写会话树；取消草稿不产生空路径。只有第一条非空消息成功发送时，才在同一 Session 中原子形成另一条路径并把它设为当前路径；原有路径始终保留。空消息、发送被拒绝或写入失败均不产生路径，并保留草稿供重试或取消。
- 触发路径动作前，如果当前 Composer 已有未提交内容，D Code 先按当前路径保留草稿；编辑并重走产生新的 Raw Input 和路径，不覆盖原始提交。
- 草稿、Raw Input、Effective Input 与 Context Projection 分开：草稿可修改，提交原文不可覆盖，生效输入可组装，投影可压缩但必须能回查来源。
- Session Copy 创建新的 D Code Session 身份并保留源；Archive 只改变产品可见性。两者都不修改任何 Pi 导入源、项目文件或 Git 状态。
- 路径切换、回溯和复制都只改变对话历史与模型上下文。项目文件和 Git 状态始终保持当前现实，不会回到历史消息所在时间点。

### Goal（目标）、Plan（计划）与 Work List（工作清单）

- Goal 是附着于 Project 或 Task 的结果语义，不在两者之间建立独立身份层。Project Goal 表达长期方向；Task Goal 表达本次短期结果与验收目的。
- Task 拥有一份 Plan 和一份 Work List；Work Item 保留状态、依赖、交付物和必要证据。需要独立会话、Agent、验收或产物时才提升为 Subtask。
- 工作项生命周期、运行状态和 User Attention 互相独立。“需要确认计划”“需要回答”与“需要验收”不得冒充执行失败。
- Plan、Changes、Verification 与 Final Report 可以成为可寻址、可版本化的 Task 产物，不依赖翻找历史聊天才能恢复。
- 列表、看板、路线图、Agent 执行和用户关注都只是 Task View，不复制任务状态，也不强制采用单一项目管理方法。

## Information Architecture（信息架构）

### Navigation Sidebar（导航栏；当前实现名 Session Sidebar）

- 左侧导航默认展开，日常工作对象只分为「项目」与「任务」两组：Project 行下显示其 Task；未选择 Project 的 Task 直接显示在「任务」组。User Home 与 User Scope 是产品语义，不是可点击的导航容器或分区名称；Recent Sessions 是快速入口，不取代任务导航。导航栏不承载设置或归档管理内容。
- 首次使用同时提供“新建任务”和“新建项目”：当前已选择 Project 时新任务进入该 Project；未选择 Project 时新任务直接进入「任务」组。创建 Project 后显示其 Task 及按需展开的 D Code Session。
- Project 主行进入项目作用域；Task 主行直接进入任务当前状态、任务对话、Agent Run、计划、产物和证据。普通会话行只作为任务内入口，并能返回所属任务。
- 完整会话谱系是所选 Session 的二级历史视图，不在日常导航中永久展开。
- 置顶与归档只改变投影视图，不改变 Project、Task、Session 或文件关系；Hover 不能成为唯一可达操作。

### Main Workspace（主工作区）

- 主工作区是窗口中央唯一的内容页面容器。Workspace（工作台）、Settings（设置）与 Archived Sessions（已归档会话）都是其中可切换的 Workbench Page（工作台页面），不会打开第二个 App 窗口或叠加 Sheet。
- 齿轮与 `Command-,` 都在当前窗口进入 Settings 工具页面；该页面临时使用完整工作台画布，以页内设置导航组织模型、本机资源、智能体档案、自定义供应商、通知、外观、工作台、已归档会话、自进化、Host 诊断与“关于 D Code”，以受限宽度分组内容承载具体选项。智能体档案是可复用配置，不在日常导航中另占工作对象分区。“已归档会话”沿用同一设置外壳，不打开 Sheet 或第二窗口；“关于 D Code”显示应用图标、版本 / 构建号、作者 GitHub 和项目 GitHub。页内设置导航在语义上不是会话栏，但继承会话栏当前实际宽度；在 Settings 或 Workspace 调整后，另一页面立即同步。进入期间日常会话栏与信息检查器让出空间，但其显示偏好保持不变，返回 Workspace 后恢复。
- Conversation 是 Workspace 中唯一的会话主页面，不建立或显示名为“对话”的标签。只有真实打开文件、Artifact、Preview 或 Editor 后才出现 Workspace Tab 标签栏，标签栏不预放空标签，也不拥有独立于主画布的整条背景。
- 从 User Home 开始新工作时建立 User Scope Task Draft，从 Project 开始时建立 Project Task Draft；首次提交非空正文时创建对应作用域的 Task 及其首个 D Code Session。空白草稿离开即消失，非空草稿可以恢复；创建已提交但运行失败时保留真实 Task、Session 与逐字草稿，不自动删除。
- 打开内容标签时，当前会话的原生消息流、Active Plan 与 Composer 可以隐藏，但其 Session、Session Path、滚动位置、输入草稿和恢复状态不得被重建或清除；关闭最后一个内容标签或从会话栏重新进入 Session 后，主页面原位恢复。
- 从项目文件树再次打开同一文件时聚焦已有标签，不创建重复标签；同名文件用 Project 或完整路径区分。关闭当前内容标签后切到相邻已打开标签，没有相邻内容时直接回到会话主页面。
- Project 文件树和助手正文中的文件、目录与代码行引用使用同一打开合同：在 D Code 的 Workspace Tab 中打开并定位对应本机内容；目标不存在、超出已授权范围或行号失效时显示真实状态，不静默转交外部 IDE。
- Active Plan 以紧凑状态带出现在消息流与 Composer 之间，完成后让出空间。
- Composer 控制行保留 `+`、当前模型名、独立推理强度、按模型能力出现的独立速度菜单和发送；已创建 Session 可按需显示上下文圆环。模型名是无 CPU 图标、无外露下拉 glyph 的可点击原生 Menu；只有 Host 证明支持 Fast Mode 的 OpenAI 模型显示“标准 / 极速”，不恢复旧组合控件。普通 Run 与工具执行期间仍可调整三项设置，选择从下一安全模型边界生效；模型设置继续属于 Settings，当前模型事实同时由会话运行信息拥有。
- 当前 Session Run 正在执行且没有等待结构化用户输入时，Composer 仍接受普通文本作为绑定当前 D Code Session / Path 的 Queue Item。派发前可查看、编辑、调整顺序或撤回，且不会进入 transcript 或模型上下文；确认派发后形成新的 Raw Input 与 Effective Input 关系。
- Follow-up Queue 不打断或 steer 当前 Run。只有前一 Run 取得正常收口证据、绑定的 Session / Path 未漂移且写入所有权仍成立时，D Code 才逐条交给 Host 派发；失败、中止、等待结构化用户输入、Host 中断或派发结果未知都会保留剩余队列并停止自动派发。完整 Run State、停止、重试与等待输入控制面从 `0.0.6` Interaction Dock 开始实现。
- 从 `0.0.6` 起，会话栏铃铛在默认 Project / 置顶导航与 Activity View 间切换；活动投影优先显示可靠的等待、当前运行与带蓝点的新完成结果，其余可见 Session 按最后可证明活动时间排列。切换不替换 Conversation，也不创建页面、标签、Session 或后台运行。蓝点只表示最新完成结果尚未在 Conversation 成功呈现，打开活动列表本身不清除。
- Composer 的 `+` 使用紧凑原生 Menu，承载添加文件或图片、技能、命令、目标与计划；Skill 在菜单与 `/` 面板显示普通名称和说明，不暴露内部 `/skill:` 路由，选择后仍以真实 invocation 预填草稿、不自动发送。图片可经系统文件选择器或剪贴板进入同一内存附件链路；普通文本粘贴保持原生行为。`/` 面板继续支持键盘命令选择，Settings 承载跨请求持久配置与资源生命周期。
- Settings 的模型页面使用 D Code 原生 Model Catalog 与模型资源设置，按供应商展示模型、刷新 / 缓存、认证状态、默认模型和启用范围。设置变化只影响未来选择和运行，不改写历史 Agent Run 的实际模型事实。
- 自定义模型供应商通过 D Code 原生合同管理；Pi 或其他 Runtime 只消费安全运行配置。D Code 不在普通界面、会话、日志或模型上下文中展示 API key、OAuth token 等凭据正文，配置校验失败时不得覆盖上一份可用定义。
- 重命名、复制、归档、路径与谱系等 Session 动作继续使用原生会话菜单；不能因为 Pi TUI 存在某个内建斜杠命令就直接暴露，只有形成 D Code 原生合同后才进入 UI。该分层已由 `0.0.3` 建立并作为后续版本回归基线；`0.0.5` 不借消息队列扩张命令入口。
- 消息下方就近提供复制文本、编辑并重走及从这里继续等动作；完整会话复制与归档放在 Session 操作中，避免把完整 Fork 误解为从单条消息截取历史。
- 助手正文必须保留原始 Markdown 的段落、空行与列表换行；呈现样式不能改变复制得到的原始文本。
- D Code Session 中的结构化图片内容块以紧凑方形缩略图进入消息流，点击后在原生查看器中显示并缩放原图；附件由 D Code 会话与产物合同拥有。任意远程 Markdown 图片不会自动加载，生效输入只引用本次明确选择的附件。
- Agent 成员的详细工作轨迹、通信和阶段结论可临时进入中央空间；Pi 已持久化并作为用户可见内容提供的 Thinking 正文可以展开查看，但 D Code 不臆造或展示协议从未提供的隐藏推理。
- 普通代码文件可以先以只读 File Preview 打开；Markdown 默认打开富预览，进入编辑时以源码与富预览分栏呈现；HTML 以源码编辑缓冲区与隔离预览分栏呈现。Markdown 与 HTML 预览均跟随尚未保存的当前编辑缓冲区，不要求用户先保存；具体刷新调度与性能阈值由对应版本的实作验证确定，不在完整形态契约中预设数字。打开、聚焦、切换或关闭这些标签均不会自动加入模型 Context、创建消息或 Session Path；未执行明确保存动作前也不会改变文件与 Git 状态。
- HTML Preview 不得在宿主界面上下文中直接执行，不得继承模型供应商凭据、原生宿主桥或任意文件读取能力；脚本、网络与本地资源的具体授权策略由对应版本规格另行确认。

### Information Inspector（信息检查器）

- 当前 Task 存在时，进度、Agent Team、等待事项与交付物始终进入 Main Workspace 右上方的 Task HUD（任务浮层），而不是占据从上到下的常驻右栏。正常宽度下浮层持续可见，不提供整体关闭动作；各内容分区仍可独立折叠。
- Task HUD 在任何宽度下都是与窗口边缘分离的独立浮窗，不进入普通文档流，也不保存为第三个结构栏位。正常宽度由 Main Workspace 为中央阅读画布与 Composer 预留左右安全宽度，使浮窗只落在安全区之外的留白上，不压缩、不移动也不遮挡正文；宽度不足时才允许浮窗覆盖阅读区域。
- Task HUD 使用内容所需的紧凑尺寸，并允许进入 Child Agent Session 或所选交付物。
- Information Inspector 只在用户明确打开文件、Artifact、Diff、Context 来源或其他需要连续检查的具体对象时出现为全高右栏，显示路径、来源、revision、元数据、变更、引用关系和适用操作。退出具体对象后关闭，不回退成任务概览栏。
- Project Files / Changes 的入口可以来自导航、Workspace 或 Task HUD；选择文件会在主工作区打开或聚焦对应 Workspace Tab，选择“查看详情”才打开 Information Inspector。两者都不会自动加入模型 Context 或改变 Git 状态。
- 全高 Information Inspector 与会话可以同时操作；空间不足时按响应式规则临时覆盖。Task HUD 与全高 Inspector 不在同一位置叠加：打开 Inspector 时浮层暂时让出，关闭后自动恢复，而不是被用户永久关闭。
- 会话栏、主工作区阅读画布、Task HUD、Information Inspector 与 Composer 以语义色阶和 shared elevation（共享层级）区分；Task HUD 是轻量悬浮表面，Information Inspector 是连续检查表面，不以同一种从上到下容器承载所有内容。
- 窗口顶部只保留一条与 macOS 红黄绿按钮同排的控制带：导航栏开关、当前 Task / Session 名称、Task HUD 入口和具体对象的 Information Inspector 入口按所属区域排列，不再叠加独立工具栏。空白控制带双击遵循 macOS 标题栏偏好；名称写入 D Code Product Store，不建立只在单个视图可见的别名。

### 响应式基线

- 导航栏与全高 Information Inspector 默认均为 `400 pt`，可在 `400–520 pt` 内调整；左栏由此为 Project 名称、创建 / 展开动作与后续 Activity View 保留稳定宽度，右栏服务具体对象的连续检查。Task HUD 不参与该宽度合同，只按内容和可用空间取得紧凑尺寸。旧于下限的已保存栏位宽度自动校准。宽度持久保存，双击调整把手恢复默认，键盘和 VoiceOver 有等价调整方式。
- 会话栏、设置页内导航及后续占用左侧栏位的页面共享同一份实际宽度；信息检查器也在所有作用域与页面间共享同一份实际宽度。页面切换不会换回页面私有默认值，也不会复制出互不一致的宽度状态。
- 没有具体检查对象时只保留导航栏与主工作区结构，Task HUD 持续悬浮在主工作区的右侧留白中。窗口能同时容纳导航栏当前宽度、主工作区至少 `480 pt` 与已打开的 Information Inspector 当前宽度时，才形成三栏并排；拖动不得把主工作区挤到该下限以下。
- `≥880 pt` 且存在具体检查对象时，Information Inspector 可以非模态常驻；空间不足以容纳当前三栏宽度时，导航栏以临时覆盖打开，不污染用户的持久隐藏偏好。
- 当主工作区无法同时容纳首选中央阅读宽度、Task HUD 宽度与必要间距时，Task HUD 才进入覆盖阅读区域的紧凑状态，并出现收起 / 再打开入口；`<880 pt` 时默认收敛为单一概览入口，主工作区优先，导航栏与 Information Inspector 均以互斥覆盖面板打开。
- 既有 `1280 / 880 pt` 宽度类别仍可用于其他视觉调整，但可见列组合以上述中央最小宽度与非模态语义为权威。

## Conversation Round（工作轮）

- 一个产品工作轮以一条 Raw Input 为起点，到下一条 Raw Input 或当前已完成尾端为止；它可以包含多次 Runtime turn、Thinking、中间助手叙述与工具调用。
- 完成后默认只显示最终助手回答；中间过程收入一个可展开的轮次摘要，摘要只保留过程状态与工具数。耗时与持久化完成日期位于最终回复正文之外，仅在整条回复悬停或键盘聚焦时显示，VoiceOver 始终可以读取。失败或中止结果不得被默认隐藏。
- 运行中只显示当前 Thinking 片段或当前正在执行的工具；一段结束后原位替换，不在主阅读面持续堆叠。
- 历史耗时使用该轮 Raw Input 到最后接受结果的 D Code 持久化时间；“完成时间”是可跨重启恢复的持久化近似值，不声称等于 Provider 返回或 Runtime settled 的精确时刻。
- read/edit/write/search 等识别出的工具使用 D Code 自有原生 presenter 显示安全摘要、行锚点、边界与 diff；未识别结构保留通用 fallback。扩展可继续在 Host 中执行，但其 TUI renderer 不定义 D Code 界面。

## Search（搜索）

- 搜索参考 Codex 的轻量浮层形态打开，覆盖在当前工作台上方但不替换当前对话、会话栏或信息检查器；关闭浮层后原工作状态保持不变。
- 全局搜索覆盖用户可见的 Project、Task、D Code Session、Raw Input、助手消息、Artifact 与一等项目文档，不只覆盖当前已经显示的摘要。
- 可搜索会话标题、用户消息正文和助手消息正文。
- 默认不搜索隐藏 thinking、原始工具输入、工具结果、认证内容或其他可能含凭据的非对话正文。
- 结果显示命中片段、对象类型、更新时间、所属 User Scope / Project / Task 与必要来源；可按作用域和对象类型缩小范围。
- 搜索命中未加载会话或文档时，选择结果打开对应稳定对象并定位原始来源。
- 搜索索引只能从 D Code Product Store 与当前一等项目文档重建；索引缺失或损坏不能改变权威数据，也不能伪装成“没有历史”。

## Agent Team（智能体团队）

- Agent Team 属于 Task。Task 可以直接启动单个 Agent Run，也可以显式启动一轮 Team Run；团队、会话和模型都不拥有任务。
- Task 可以指定一个 Coordination Session 作为任务对话；Coordinator Agent 就是活在任务对话中的 LLM，在其中持续理解目标、管理计划与派发、汇总成员问题和结果。导航中点击 Task 主行即进入任务对话，协调会话不显示为独立的子会话行；展开 Task 只列实际启动的 Child Agent Session，返回任务对话不会停止其运行。
- Coordinator 的 Task 验收请求以验收卡进入任务对话：一句话请求、一个反馈输入框和单一确认动作。空内容确认即产生结构化接受事实；非空内容确认把反馈绑定该验收请求提交（可含图片附件），Coordinator 按反馈返工，验收保持待定；不设独立的「要求返工」动作。等待类对象（成员请求、验收请求）在任务对话对象卡与 Task HUD 等待分区双入口等价，操作同一结构化对象，任一处操作后另一处同步消解。
- Agent Profile 是具有稳定身份和版本的可复用默认配置；创建、编辑或选择档案不会启动 Agent，也不会创建 D Code Session。一个 Profile 可以在不同 Task 或 Team Run 中承担不同职责。
- Team Run 必须在明确目标、范围、完成信号和停止边界下显式启动；短任务可以保持单 Agent，串行接力和并行调查使用同一 Agent Run 合同。
- 每个 Agent Run 保存 Profile 快照、职责、实际模型、实际工具、Skill 身份 / 版本、声明范围、来源上下文、执行目录、状态、Child Agent Session、可见事件、Report 与 Evidence。模型是运行事实，不是 Agent 身份。
- Child Agent Session 是 D Code Session，由所属 Task 和 Agent Run 引用；它拥有独立上下文但不在顶层导航重复平铺。Agent 结束或 Team Run 关闭不会自动删除会话、报告、证据或未处理工作空间。
- 协调 Agent 负责派发、判断、冲突、用户问题去重与最终综合；成员负责有界工作并以 Finding、Request、Report 和 Evidence 协作。首版不声称自由 P2P、自组织依赖调度或自动合并。
- 每个运行只接收显式、有界且可追溯的 Context Projection，包括 Task 合同、必要一等项目文档、Knowledge 引用、允许范围、基线、完成信号和回报格式；完整历史不会因父子关系自动复制。
- 多个可写 Agent Run 不得共享同一可写工作树；Git 项目优先使用独立且已验证的 worktree。工作目录只是执行映射，不成为 Task、Session 或 Agent 身份。
- Agent Run completed、Team Run closed、Task accepted、测试通过、提交、推送与发布分别成立，不得自动逐级推导。
- 跨重启可以恢复 Task、Session、Agent Run、未处理工作空间、可见事件、报告与证据，但不能伪装恢复已经销毁的模型生成、工具调用或 Runtime。
- `pi-dteam` 等旧扩展只作为机制来源；Agent Team 的产品对象、数据合同、生命周期、Runtime Adapter 和原生呈现由 D Code 自己定义。

## D Code System Prompt（D Code 系统提示词）

- 每次 Session Run 启动 Agent Loop 时都由 D Code 生成自己的 System Prompt；该 Run 属于某个 Agent Run 时带入对应 Agent 角色合同。它完整替换 Pi 的通用身份、Pi 文档入口与默认能力叙述，不采用追加品牌说明的双重身份。
- 有效提示词至少明确四件事：Agent 正在 D Code ADE 中工作；当前 Project / Task / Session / Agent Run / 执行目录与已选择上下文是什么；它在本轮是谁、负责什么、向谁回报；它真实能够调用哪些 Active Tools。
- Coordinator 与成员 Agent 共享 D Code 基础身份，但角色、任务范围、完成信号、停止边界、回报对象和活动工具集合分别按 Agent Run 组装。成员不得替 Coordinator 或用户宣布 Task 完成。
- Runtime 内置、已适配扩展、D Code 自有与 Provider 工具都先经 Capability Registry 归一和过滤为本轮不可变 Active Tool Set。Active Tool Manifest 与模型 API Tools 只从该集合生成，工具名集合完全一致，并直接复用同一 canonical model-facing description；完整输入 schema 与执行器只进入模型工具 API。Prompt 中单独出现的工具名称不算接通能力，Provider 不支持真实工具调用时也不得继续宣称工具可用。
- 适用 `AGENTS.md` 在 Agent Run 建立及每次 Session Run 启动前必须解析为强制 Context Projection；工作目录作用域变化只标记下一 Run 重新解析，不热改当前回执。其他一等项目文档、Knowledge、历史消息与摘要按需加载并保留来源，不默认全文并入稳定身份。每次 Session Run 启动 Agent Loop 时保存不可变的有效提示词版本、hash、角色 / 环境 / Context Projection 来源和 Active Tool Set revision；一个 Agent Run 可以引用多条生效记录，后续变化不得覆盖历史。凭据正文和隐藏 Thinking 不得进入记录。

## Cross-Session Collaboration（跨会话协作）

- 跨会话协作以耐久 Task 为锚点，使用稳定消息身份记录来源与目标 D Code Session / Path、关联 Work Item / Team Report、送达、已读、失败、幂等重试与重启恢复。
- 跨会话消息是独立系统对象，不伪装成普通用户回复；接收会话或协调 Agent 决定是否将交接纳入后续 Context Projection。
- 交接送达本身不会启动新的 Session 或 Team Run；只有接收方或用户明确采纳后才可显式启动。后续执行不恢复已经销毁的 Runtime，也不支持在途模型生成或工具执行的热迁移。

## Creation Mode（全局创造模式）

- 创造模式是 D Code 的全局产品模式，只用于开发和自进化 D Code 自身；普通 Project 和 Task 不进入该模式。
- 进入后围绕 D Code 源码 Project 与相关 Task 组织一等项目文档、能力开发、Agent Team、验证、自构建候选、受控切换、原任务恢复、人工验收与回滚。
- 创造模式复用同一 Project → Task → D Code Session / Agent Run 主干，不建立第二套任务、会话、权限或能力系统。
- 它不是权限档位；ADR 0023 的固定完全访问保持不变。候选切换后可以恢复耐久任务和会话关系，但不能伪装恢复已经销毁的 Runtime。
- 当前自构建与 Self-evolution Run 只是这条闭环已经实现的一部分，完整创造模式仍须由后续 PRD 切片和验收。

## D Code Capability Modules（D Code 自有能力模块）

- D Code 按用户可见结果吸收旧扩展的成立机制，不把扩展前缀、包名或安装状态直接提升为产品对象。参考包可以是机制和迁移来源，但 D Code 拥有能力合同、配置、生命周期、原生界面与版本边界。
- 需要模型主动调用的能力必须在 D Code Capability Registry 中拥有名称、说明、输入 schema 与执行器，并由本轮 Runtime Adapter 注册为真实 Active Tools。系统提示、Skill 或其他 Prompt 只能帮助模型理解何时选择工具，不能把未注册能力变成可调用工具或伪造执行成功。
- 观察、请求策略、状态投影或纯界面能力不因来源是 Extension 就必须暴露为模型工具；只有存在明确模型动作、输入校验、授权边界和结构化结果时才增加最小工具 facade（门面）。
- 工具执行语义与用户可见呈现继续分层：Runtime Adapter 通过 Pi SDK 等 Runtime 执行，SwiftUI/AppKit 使用 D Code 自有 presenter；未识别结构安全降级，不解析或调用外部 TUI renderer。

## Local Resources, Models, Execution Boundaries and Recovery（本机资源、模型、执行边界与恢复）

- D Code 原生管理 Skill、Prompt、Command、Extension Capability、模型目录、供应商和能力资源；Pi 资源可以导入或作为运行适配来源，但不成为永久配置权威。Skill 不授予工具、文件、网络或凭据权限。
- Agent Profile 或 Agent Run 可以记录职责、工具集合与预期写入范围，供调度、报告和验收核对；这些声明不是运行时权限授予，也不得冒充操作系统级文件沙箱或 D Code 工具门禁。
- 动作权限继续按 ADR 0023 固定完全访问，不产生 D Code 工具审批或权限模式。macOS 系统权限、外部账户授权和外部副作用确认是不同合同，不得混称。
- 风险提示、Task / Team 控制、失败、重试与可验证执行结果形成可回放的 D Code 事件。重启只恢复耐久事实，不伪装恢复已经销毁的 Runtime。
- 上下文、用量、额度和速度状态只有在 Provider 或 Runtime 提供可确认来源时才展示；未知字段明确降级，不伪装为零。
- Remote Control、IM、云端 / 定时任务等外部系统以 Extension Capability 接入，不成为所有项目或任务的默认依赖。

## Confirmed Constraints（已确认约束）

- 产品仅支持 macOS，并使用原生 SwiftUI/AppKit 界面。
- 产品界面默认使用简体中文。“项目”“项目目录”“会话”“会话路径”“目标”“智能体”“上下文”“文件”“变更”和“工作清单”等产品概念不得以英文作为主要界面文案；`D Code`、模型名、命令、文件路径与代码标识符保留原文。
- D Code Product Store 是产品数据、会话、模型资源与能力配置权威；Pi SDK 只通过 Runtime Adapter 参与运行。`0.0.28` 已形成该边界的实现候选，发布与人工验收状态仍由精确 PRD 记录。
- 当前用户的 D Code Data Root 固定为 `~/.dcode/`；Session、设置、Agent Profile、模型 / 能力配置、受管 Artifact、索引、日志和恢复资料统一进入该根。Project 文件正文留在 Project Directory，凭据正文不明文落盘。
- Task owner 必须是 Project Scope 或 User Scope；User Scope Task 默认 cwd 为用户 Home Directory，但该目录不成为默认 Project，产品数据仍只进入 `~/.dcode/`。
- Pi Session 与配置只支持显式单向导入或运行适配；不双写、不持续同步，也不承诺 D Code 完整导出可由 Pi CLI 复用。
- 提交原文、生效输入和 Context Projection 分开持久化与呈现；摘要或转换不得覆盖用户真正提交的原始事实。
- Project 名称、唯一项目目录、一等项目文档、Task、Session 和 Agent Run 关系由 D Code 原生拥有；目录迁移不改写 Pi 导入源。
- D Code 不直接依赖或调用 `pi-tui`；所有产品界面由自有 SwiftUI/AppKit 组件或受控内容渲染器实现。传递依赖可以存在，但不得成为呈现路径。
- 外部产品只提供本地信息层级与交互机制参考；D Code 不因竞品对齐引入其云端权威、远程控制、账号体系、在线市场或 Runtime。
- 同一 D Code Session 或 Agent Run 同时只有一个写入所有者，不支持在途模型生成、工具执行或阻塞交互的热迁移。
- 文件变化与代码分支以当前文件系统和 Git 为准；Session Path 不承担代码快照或代码回滚职责。
- 目标形态由本文件约束；各版本只实现 `40-版本实施方案/` 明确切出的子集。

## Acceptance Criteria（目标态验收标准）

### Project、Task、会话与一等项目文档

- [ ] 全新状态打开 D Code 时同时提供“新建任务”与“新建项目”；未选择 Project 创建的 Task 直接显示在「任务」分区，不显示为“未选项目”，也不把 `cwd`、会话或目录分组冒充 Project。
- [ ] Task owner 必须是 User Scope 或一个 Project；User Scope Task 默认 cwd 为用户 Home Directory，而 Product Store、Session 和设置只写入 `~/.dcode/`。
- [ ] 用户可以创建 Project 并选择唯一 Project Directory；Project 以 Task 为主干，Recent Sessions 只提供能够返回所属 Task 的快速入口。
- [ ] 创建 Task 可以先形成 Task Draft；首次非空提交创建 Task 及首个 D Code Session，创建或编辑 Task 本身不会自动启动 Agent。
- [ ] Project 能识别 Project Map、AGENTS、DESIGN、PRODUCT、精确 PRD、根 GLOSSARY 与 ADR 的文档类型、职责、路径、revision 和取代关系，并按 Task 需要向 LLM 加载原文。
- [ ] 根 `GLOSSARY.md` 是术语唯一正文；删除任何派生 JSON 或索引后可以从 Markdown 重建，不存在人工维护的第二份术语定义。
- [ ] 已由 D Code 管理的可见 Pi Session 在升级时自动转换为 Legacy Task + 首个 D Code Session：唯一 Project 归属保留，否则进入 User Scope，关联 Draft / Queue / Archive / Pin / Evidence 同事务迁移且源 JSONL 不变。
- [ ] 其他 Pi Session 只有用户点击“导入为任务”才进入；选择 Project Scope 或 User Scope 后原子创建新 Task 与首个 D Code Session，导入后不双写、不持续同步，D Code 完整导出不承诺 Pi CLI 可复用。
- [ ] 在 Project 内由 D Code 新建的会话可以同时出现在 Recent 与所属 Task，两处指向相同稳定 D Code Session ID。
- [ ] 已经属于其他 Project 的 Project Directory 不能重复选择；界面显示现有归属，不能静默移动或覆盖。
- [ ] 改 Project Directory 时保留 Task / Session 身份和历史，更新 D Code 原生关系；目录内文件是否同行由独立选择决定，Pi 导入源不被改写。

### 搜索与恢复

- [ ] 全局搜索能够命中用户可见的 Project、Task、D Code Session、Raw Input、助手消息、Artifact 与一等项目文档，并保留对象类型和来源。
- [ ] 选择搜索结果后打开同一个稳定对象并定位原始来源；搜索不会隐式导入 Pi Session 或创建副本。
- [ ] 删除搜索索引后可以从 D Code Product Store 与当前项目文件重建；索引为空、过期或损坏时显示明确状态，不改写权威数据。

### 工作台与会话路径

- [ ] 主导航、操作、状态、空白页、错误和检查器标签均以简体中文呈现；除品牌、模型名、命令、路径与代码标识符外，不出现英文优先的产品文案。
- [ ] 导航栏与按需出现的全高 Information Inspector 可通过透明边缘命中区、键盘或 VoiceOver 调整宽度并跨重启保留；指针移入只切换调宽光标，不显示竖条或蓝色焦点框，双击边缘恢复默认。Settings 页内导航继承导航栏的同一实际宽度；每次打开具体对象的 Inspector 都复用同一右栏宽度。Task HUD 不拥有或改变栏位宽度，调整时主工作区至少保留 `480pt`。
- [ ] 当前 Task 存在且宽度充足时，右上 Task HUD 始终显示进度、Agent Team、等待事项和交付物；显示或更新 HUD 不改变中央阅读画布的宽度、位置或滚动状态。只有打开文件、Artifact、Diff 或 Context 来源详情时才出现第三个全高栏位。
- [ ] 打开具体对象的 Information Inspector 会让 Task HUD 暂时让出；关闭 Inspector 后 HUD 自动恢复。Task HUD 只有在宽度不足时才提供整体收起 / 再打开入口，宽屏不能被永久关闭。
- [ ] 全新偏好下导航栏默认显示，顶部开关可往返隐藏与恢复；空会话提示在标题区与 Composer 之间的会话正文内水平、垂直居中。Task HUD 在标准字号下不截断状态身份，具体对象的完整路径可以在 Inspector 中换行或按需复制。
- [ ] 点击 Project 无需先打开 Session 即可进入其唯一项目目录的 Files / Changes；选择对象不会改变主工作区当前会话、草稿、上下文或 Git 状态，只有明确查看详情才打开对应 Information Inspector。
- [ ] 主工作区不显示“对话”标签；没有真实内容对象时不显示标签栏，文件、Artifact 或 Editor 按真实对象创建标签，同一对象不会重复打开，同名对象能凭 Project 或完整路径区分。
- [ ] 在文件、Artifact 或 Editor 标签间切换并返回会话主页面后，原 Session、Session Path、transcript 滚动位置、Active Plan 与逐字输入草稿均保持；标签操作不新增消息、路径或 Context。
- [ ] Composer 控制行保留 `+`、无图标且无外露箭头的模型名选择、推理强度、受支持 OpenAI 模型的标准 / 极速速度菜单与发送；普通 Run / 工具执行期间仍可调整，下一安全模型边界生效。`+` 使用原生 Menu，只提供文件、图片、Skill、命令、目标与计划，且不出现插件、扩展、本机资源、网页预览或浏览器控制。Context 默认蓝环表示剩余容量，白色覆盖按已用比例增长，展开后显示已用量、总容量与剩余比例。
- [ ] 会话打开时，红黄绿窗口按钮、导航栏开关、完整可辨识的 Task / Session 名称与对象操作、Task HUD 入口和具体对象的 Information Inspector 入口位于同一条水平控制带，不在主工作区重复标题。重命名后 D Code Product Store、导航、搜索与顶部共用同一名称。
- [ ] 齿轮和 `Command-,` 都在当前窗口进入 Settings 工具页面；进入时临时使用完整工作台画布，以继承会话栏实际宽度的页内设置导航和受限宽度分组内容呈现外观、工作台布局与会话管理，返回 Workspace 后恢复原栏位偏好。“已归档会话”沿用同一设置外壳；整个路径不打开第二个窗口、Sheet 或卡片式弹窗。
- [ ] “设置 > 关于 D Code”使用同一主工作区页面外壳，显示 App 图标、版本 / 构建号、作者 GitHub 与项目 GitHub；外部链接具有明确名称并经系统 URL 路由打开。
- [ ] 合法 D Code 图片内容块显示为方形缩略图，点击后可查看并缩放原图；附件身份与来源由 D Code Session / Artifact 合同保存。损坏、不支持或超限数据安全降级，远程 Markdown 图片不会自动加载。
- [ ] 普通代码文件可以只读预览；Markdown 默认显示富预览并可进入源码/预览分栏编辑；HTML 能在源码/预览分栏中跟随未保存缓冲区持续刷新，且预览无法访问宿主桥、模型供应商凭据或未授权文件。
- [ ] 从 Raw Input 编辑并重走、从助手回复继续分别产生正确的同会话路径；新提交不会覆盖原 Raw Input。复制创建新 D Code Session ID，源会话始终保留。
- [ ] “编辑并重走”与“从这里继续”先进入明确的“新路径草稿”；点击动作和取消草稿都不改变会话树，只有第一条非空消息成功发送才创建路径。空消息或发送失败不留下空路径，并保留草稿。
- [ ] 当前路径已有未发送内容时，进入新路径草稿会自动保留原文；取消或切回原路径后逐字恢复。保留过程不弹确认框、不创建消息或路径，也不把原草稿带入新路径。
- [ ] 草稿在切换会话、路径和应用重启后仍能逐字恢复，并按稳定 D Code Session ID 与路径隔离；提交成功后只清除被消费的草稿，同时创建不可覆盖的 Raw Input。
- [ ] 草稿没有自动过期；只有提交、用户明确清空或对应 D Code Session 被实际删除时才按范围清理。
- [ ] 所有路径与复制操作都明确提示项目文件保持当前状态，不创建、切换或还原 Git 分支。
- [ ] 普通复制后源 Session 继续可见；复制并归档只有在目标验证成功后隐藏源 Session，且归档源可恢复、任何 Pi 导入源都不被删除或改写。
- [ ] 置顶会话只在会话栏最上方的全局独立区域出现，并从 Recent / Project 普通列表去重；置顶不扩大可见集合且在分页前生效。普通会话行只常驻单行标题，悬停或键盘聚焦时显示完整标题、更新时间、Project、项目目录、完整 `cwd` 与当前 Git 分支；同一路径可置顶或直接归档，右键菜单和 Session 菜单提供等价入口。直接归档不伪造复制目标，恢复后保留草稿和置顶状态。
- [ ] 会话栏铃铛只在默认导航与同一可见 Session 集合的 Activity View 间切换；当前运行、等待处理、新完成蓝点和时间排序来自可靠状态。仅打开活动列表不清除蓝点，最新完成结果在 Conversation 成功呈现后才标记已查看；单活动 Session 架构不被伪装成后台多会话运行。
- [ ] 助手 Markdown 中的标题、段落、空行、粗体、列表、引用、分隔线与表格按原结构显示；粗体结尾紧接中文时不暴露 `**` 标记，复制仍返回原始正文。
- [ ] 左侧轮次导航从顶部以紧密固定最大间距累积，少量轮次不拉散到整列；Return 在 Composer 聚焦时按当前发送方式提交，轮次跳转只滚动和更新刻度，不绘制整轮蓝色选中框。
- [ ] 已完成工作轮在最终助手回复下方显示完成状态、时间、耗时与 Runtime 可证明的用量；缺少真实字段时省略而不估算。复制、编辑并重走、从这里继续等操作按需出现，状态行不引发布局跳动且 VoiceOver 可完整读取。
- [ ] 运行中 Thinking 跨 Assistant / Tool 边界持续可见，并可与当前工具、流式正文同时呈现；完成后展开一次“中间过程”即可直接阅读思考。运行中 Composer 可在 Runtime steer 的“立即介入”和 D Code 耐久 Follow-up Queue 的“排队等待”之间切换，两者的时序、恢复与数据所有权明确不同。

### Task、Agent Team 与跨会话协作

- [ ] Task、Goal、Plan 与 Work List 可跨重启恢复，短期结果、范围、停止条件、状态、依赖、验收与证据保持稳定；创建或编辑它们不会自动创建 Session 或启动 Agent Team。
- [ ] 当前 Task 在工作台显示目标、阶段、计划、工作清单、最近证据、待决定与阻塞原因；暂停 / 继续只控制明确启动的执行，关闭视图不删除 Task、运行记录或证据。
- [ ] 执行状态和用户关注态同时可见且不互相覆盖；确认计划、回答问题和验收结果均有明确操作，不以失败或无限加载伪装。
- [ ] Agent Profile 可独立创建和编辑稳定身份、名称、职责、可选默认工作范围与模型路由，且不会因保存档案而启动 Worker；同一档案可在不同 Team Run 中承担不同职责，修改也不会热更新在途成员。
- [ ] Agent Team 只能在 Task 中显式启动，短任务仍可保持单 Agent；团队概览显示成员职责、实际模型与工具、声明范围、运行状态、活动、耗时 / 用量、请求、报告和证据，不暴露隐藏推理、完整私有过程或凭据。
- [ ] 每个 Agent Run 可以拥有独立 Child Agent Session；D Code 能证明 Task、Team Run、Agent Run、子会话和执行目录关系，而不把子会话重复平铺到顶层导航。
- [ ] Task 的 Coordination Session 作为默认任务对话，由 Coordinator Agent 在其中管理目标、派发、问题去重与结果综合；左侧点击 Task 主行即进入任务对话，协调会话没有独立导航行，展开 Task 只列 Child Agent Session，进入或返回不会停止其他运行。
- [ ] 具有写入能力的成员使用独立可写执行目录；重启后未处理工作空间与父子引用仍可恢复，运行中断不会被伪装为 Worker Runtime 已恢复，也不会自动重跑、合并或删除成果。
- [ ] Agent Run 报告、Team Run 关闭与 Task 验收三种完成语义可独立判定，任一前置状态都不会自动推导后续完成。
- [ ] 跨会话消息保留稳定身份、来源、目标、引用、送达、已读与失败状态；重试幂等，重启后可恢复，且不会被呈现为普通用户消息。
- [ ] 全局创造模式只在开发 D Code 自身时进入，并明确显示当前 D Code Project / Task、候选、恢复和验收状态；普通项目不出现同名模式，也不改变工具权限。
- [ ] 创造模式生成候选后，通过受控切换恢复原 Task 与 D Code Session，再由用户人工验收或回滚；Runtime 中断不会被伪装成热迁移成功。

### 本机资源、模型、执行边界与恢复

- [ ] D Code 原生 Skill / Prompt / Command / Extension Capability 列表能区分来源、启用状态与兼容性；未接通真实配置和执行合同的动作只读呈现，不出现虚假启停按钮，也不把 Skill 冒充权限授予。
- [ ] D Code Model Catalog 与模型资源设置按供应商展示模型、缓存、认证、默认模型和启用范围；关闭模型不会改写历史 Session / Agent Run 的实际模型事实。
- [ ] 默认模型、启用范围和自定义供应商由 D Code 原生合同持久化；在线刷新失败时保留最后可用目录并明确标注状态，不把空结果伪装成供应商没有模型。
- [ ] Provider 认证由 D Code 管理状态与安全引用；API Key、OAuth token 和认证文件正文不进入普通界面、会话、日志或模型上下文，Runtime 只获得本次调用所需的安全凭据。
- [ ] 任一需要模型调用的 D Code 自有能力都经 Capability Registry 和 Runtime Adapter 真实注册为结构化工具；仅在 Prompt 中列出名称不算接通。
- [ ] 任一 Session Run 的 Effective System Prompt 不再包含 Pi 通用身份或未经选择的 Pi SYSTEM / APPEND_SYSTEM 内容；它能准确说明 D Code 环境、当前角色和职责，并列出与该轮模型 API 完全同源的活动工具名称与说明。一个 Agent Run 跨多个 Session Run 时能按顺序回查全部不可变生效记录。
- [ ] Agent Profile 与 Agent Run 的职责、实际模型、工具、Skill 身份 / 版本和声明范围可区分查看；后续配置变化不会静默改写历史。
- [ ] D Code 按 ADR 0023 固定完全访问：界面不出现工具权限卡、授权表、权限审计或模式开关；macOS 系统权限、外部账户授权和外部副作用另行如实呈现。
- [ ] Task / Team 控制、失败、重试与可验证结果可从 D Code 耐久事件恢复；重启不会伪装恢复 Runtime，也不会持久化隐藏 Thinking 或凭据。

## Out of Scope（本规格非目标）

- 在本文中规定具体存储格式、索引引擎、IPC 字段、分页游标或 Swift 类型。
- 让一个 Project 关联多个目录，或让一个目录同时属于多个 Project。
- 把 Session Path 与 Git 分支、文件快照或工作树绑定。
- 让多个可写 Agent Run 或会话同时写入同一个执行目录，或把系统 `/tmp` 作为未处理成果的耐久存储。
- 搜索隐藏 thinking、原始工具日志或凭据正文。
- 以 HTML 原型代替原生 App 的实现、自动测试或人工验收。

## Prototype（交互原型）

可交互参考见 [工作台交互原型说明](原型/README.md)，逐版本变化见 [版本界面演进](原型/版本演进/README.md)。原型中的名称、消息、智能体状态、文件树与 Git 标记均为模拟数据；产品行为以本文件和后续版本 PRD 为准。
