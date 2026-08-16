# Changelog

本项目的用户可感知变化遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 记录，并以 Git tag 作为版本边界。

## [Unreleased]

### Added

- 实现 Session Sidebar（会话栏）的 Activity View（活动视图）：搜索旁铃铛只切换左侧投影，默认置顶 / Recent / Project 导航与唯一 Conversation 主页面保持不变；活动列表固定优先显示等待处理、当前真实运行和新完成结果，其余可见 Session 按可靠活动时间分组排序。
- Host 新增 `sessionRunState` 能力与 `session.runStateChanged` 事件，以稳定 Session / Run 身份区分运行、结构化等待、停止请求、正常完成、失败、中止与未知结果；正常完成只有在最终助手 Entry 经既有 Lease 同步后才公开稳定 completion identity。
- 新增版本化、原子且有界的本机 Activity Attention Store（活动关注记录）：蓝点只表示最新稳定完成结果尚未在对应 Conversation 实际可见，不保存消息正文、Thinking、工具结果或凭据；同一 Session 的后续完成可以重新产生蓝点。

### Changed

- 将 App / Host 开发版本提升为 `0.0.6`，并把当前 Run、结构化等待、停止 / 安全重试门禁与 `0.0.5` Follow-up Queue 收敛到 Composer 附近的 Interaction Dock（交互坞）；未知结果会阻止自动继续和重复发送。
- Activity View 与默认导航复用相同的 D Code Recent / Project / Archive 可见性资格；置顶不改变活动排序，运行期间选择其他 Session 会明确说明必须先完成或停止，不会伪装成后台多会话执行。
- Composer 将 Context（上下文）改为模型名称左侧的剩余量圆环：圆环只表达剩余比例，悬停或展开后再显示已用量与总容量；模型、推理强度和速度仍由相邻的统一运行设置菜单管理。
- 将完整 Model Settings（模型设置）从 `0.0.13` 前移到 `0.0.7`；Project Trust、Exact Git Diff、结构化验证、自构建与本机资源版本依次顺延，自定义供应商仍保持在 `0.0.14`。

### Fixed

- 修复会话前草稿清空当前 Session 模型状态后又无法在真实 Pi Session 创建前读取模型，以及模型选择器把已登记 / 已认证模型误当作已启用模型的问题：新会话现在从当前 `cwd` 生效的 Pi 配置读取 `enabledModels` 精确或通配范围、对应本机可用模型与范围内的精确默认项，在统一运行设置菜单中标出“Pi 默认”并可一键恢复；未启用的 Provider / Model 不再进入选择器。没有默认项时要求用户显式选择，模型未加载或未选定时禁止发送，选定模型会在第一条 Prompt 前通过 Host 应用。该修复不保存凭据、不修改 Pi 默认，也不提前引入完整模型设置管理。
- 修复新会话把未读取到的 Fast Mode 状态显示为不可关闭的“极速”的误导：独立极速按钮已移除，模型、推理强度与速度合并为一处运行设置；草稿默认“标准”，仅 Host 明确标记支持的 `openai-codex` 模型可选择“极速”，显式选择会在模型与推理强度之后、第一条 Prompt 之前应用；既有会话即使切到不支持的模型也始终可以恢复“标准”。
- 铃铛切换在 VoiceOver 中同时说明当前是“会话导航”还是“活动视图”以及是否有新完成结果；Activity 选中态不再只依赖蓝色图标表达。
- 修复 `agent_end` 已结束流式展示但 Host 尚未确认 Run 终态时，直接发送、切换 Session 或队列提前派发可能被短暂放行的问题；运行与队列结算现在只接受匹配 `runId` 的 Host Run State 证据。
- 结构化等待现在区分选择、确认、输入与编辑；同时存在多个原生请求时，关闭其中一个不会误报恢复运行，Interaction Dock 的停止 / 安全重试按钮也保持为独立无障碍操作。
- 修复重启后 Project 尚未展开时持久化新完成蓝点可能不显示，以及最终 Assistant 后追加安全元数据条目会令稳定完成身份误降为 unknown 的问题；相关 App 测试存储同时改为完全隔离，不读取真实用户关注文件。
- 修复会话栏与信息检查器共享分隔线只能通过无障碍增减、鼠标却无法拖动且命中范围过窄的问题：透明 SwiftUI 手势面已改为 macOS 原生 AppKit 指针跟踪，隐形命中区扩大至 20pt，同时保留细视觉边界、左右调整光标、双击恢复默认、宽度持久化与 VoiceOver 可调节语义；会话栏默认宽度仍为 400pt，但最小宽度由 400pt 调整为 280pt，不再把默认值误当成最小值。

## [0.0.5] - 2026-08-16

### Added

- 冻结 `0.0.5` Follow-up Queue（后续消息队列）的产品范围与所有权决策：尚未派发的 Queue Item 由 D Code 以本机耐久状态管理，绑定当前 Session / Path；只有经 Host 交给 Pi 并取得匹配的持久化证据后才成为会话消息。
- 实现 Composer 附近的原生 Follow-up Queue：运行中可继续输入普通文本，待派发项可查看、编辑、上下移动与撤回；队列以本机原子 Store 跨重启保留，派发与 Run 结果不明时停住并要求核对。
- Host 公开 `sessionRunCorrelation` 能力门禁，App 只在能将 `session.event.runId` 与 Prompt 稳定关联的 `0.0.5` Host 上启用后续消息队列。
- 确认 `0.0.6` Activity View（活动视图）与 Run State（运行状态）的下一版范围：会话栏铃铛切换活动投影，可靠运行与等待优先，新完成结果以可恢复蓝点提示，其余会话按活动时间排序；本版仍不声称后台多会话执行。

### Changed

- 将 App / Host 版本定版为 `0.0.5`；Conversation 继续是无冗余标签的唯一会话主页面，本版只增加 Composer 附近的最小队列表面，完整 Run State / Interaction Dock 留到 `0.0.6`。
- “新建会话”改为先进入本地会话前草稿：空白草稿离开即消失，不再创建或遗留 Pi 空会话；非空正文由原子草稿资料恢复，只有首次发送时才调用 `session.create`，创建后打开或发送失败则把正文保留到该真实 Session 草稿中并明确提示。

### Fixed

- Composer 获得输入焦点时不再给整个输入容器绘制持续蓝色选中框；文本插入点与键盘输入继续可用，点击其他工作区后也不会遗留误导性的整框选中效果。
- Session Sidebar（会话栏）与 Information Inspector（信息检查器）统一为默认及最小 `400 pt`、最大 `520 pt`；旧的窄会话栏保存值在布局时自动校准，Project 名称、创建与展开操作不再被压缩在明显偏窄的左栏中。

## [0.0.4] - 2026-08-15

### Added

- 主工作区新增按需出现的本机文件只读标签；对话继续作为唯一主页面且不显示冗余标签，关闭最后一个文件后直接返回主页面。Project 文件树和助手 Markdown 中的本机文件 / 行引用复用同一安全入口，重复路径只聚焦已有标签，切换期间保留现有会话视图与逐字草稿。
- 文件预览只读取已登记 Source Folder 内的普通 UTF-8 文本，并有界拒绝越界路径、符号链接、目录、二进制、超限与读取竞态；来源授权移除后仅保留已加载的内存快照，不继续刷新磁盘。

### Changed

- `0.1.0` 前路线改为按自迭代闭环逐层生长：`0.0.5` 后续消息队列、`0.0.6` 运行状态与 Interaction Dock、`0.0.7` 项目信任与动作权限、`0.0.8` 精确 Git 差异、`0.0.9` 结构化验证证据、`0.0.10` 首次自构建 / 重启 / 恢复、`0.0.11` 一次性资源调用、`0.0.12` 本机资源管理、`0.0.13–0.0.14` Pi 模型设置与自定义供应商、`0.0.15–0.0.16` Markdown / HTML 工作流、`0.0.17` 失败恢复加固；之后允许继续增加真实 dogfood 缺口版本，不再把 `0.0.9` 当作硬终点。Goal / Work Map、D Team 与跨 Session 编排移至 `0.1.0` 之后的候选方向。
- 已置顶会话改为会话栏最上方的全局独立区域，并从 Recent / Project 普通列表去重；普通会话行只常驻显示单行标题，悬停或键盘聚焦后再展示完整标题、更新时间、Project、Source Folder、完整 `cwd` 与当前 Git 分支。会话行同时新增稳定且保留内部留白的中性 Hover / 选中反馈；Window control band、会话栏身份行、“新建项目”、Project 与 Session 导航行统一为 `36pt`，纯图标动作仍使用 `13pt` glyph、`18pt` glyph box、`28pt` 状态表面和 `32pt` 目标，尾部 action rail 固定为 `64 × 32pt`，不再依赖页面级图标偏移或大透明 frame。
- 设置不再打开第二个 macOS 窗口：左下角齿轮与 `Command-,` 都在当前窗口进入完整 Settings 工作台页面。该页面临时让出日常会话栏与信息检查器，以页内设置导航组织“外观 / 工作台 / 已归档会话 / 关于 D Code”，右侧使用受限宽度的分组内容；返回工作台后恢复原栏位偏好。已归档会话沿用同一页面外壳，不再叠加 Sheet，也不再占用普通会话列表空间；关于页显示 App 图标、版本 / 构建号、作者 GitHub 与项目 GitHub。会话栏底部在 Host 健康可用时不常驻显示“运行服务已就绪”，只在连接中、未连接或失败时显示可解释状态。
- Pi 结构化图片内容块不再只显示占位文案：消息内显示紧凑方形缩略图，点击后可在原生查看器中查看和缩放原图；图片只从 Pi Session JSONL 做有界内存解码，不复制为第二份本机附件，也不会自动加载任意远程 Markdown 图片。
- 对话导航尺统一使用中性刻度；已经恢复的工具或命令失败不再把整个工作轮标成橙色，真实失败仍由轮次摘要与可展开过程明确说明。
- 完成工作轮的耗时与持久化完成日期改为最终助手回复外部的 Hover / 键盘聚焦元信息；默认阅读面只保留最终回答与必要的中间过程摘要，工具数继续留在可展开摘要中。
- 助手 Markdown 改用原生块级标题、段落、列表、引用、分隔线与表格呈现；粗体结尾紧接中文时仍按用户标记渲染，复制继续返回未经展示归一化的原始正文。
- 单 Source Folder Project 的 Files 改为直接平铺根目录内容；Project 内新建会话在零个 Source Folder 时禁用并引导添加、一个时直接创建、多个时才弹出选择。打开 Project 所属 Session 后，信息检查器继续保留 Files / Changes 并叠加会话概览。顶部栏、主工作区和右侧信息检查器 rail 统一 canvas 底色，会话栏保留下层色阶并从标题栏左段连续延伸到底部；主画布圆角不再向左栏投射外阴影，信息检查器与 Composer 以共享 raised surface 表达层级，不再依赖贯穿窗口的硬分隔线。
- 窗口顶部收口为与 macOS 红黄绿按钮同排、共享中心线的 `36pt` 单一控制带：会话栏开关、真实会话名称与菜单、信息检查器开关按所属列排列，不再叠加独立按钮栏；会话栏不可见时，左上控制带补充“新建会话”入口。空白控制带双击遵循 macOS 的“连按窗口标题栏”偏好，执行放大 / 还原、最小化或无动作，不被自定义拖拽吞掉。会话操作支持持久重命名、恢复自动名称、置顶、归档、谱系和复制；没有工作对象时不重复产品名。两侧开关与新建会话默认只显示小图标，Hover / pressed 才出现 `28pt` 圆角方形状态面，不再由 macOS Toolbar 强制包成孤立玻璃胶囊。文件标签带只在打开文件后出现并直接沿用主画布底色，不再形成第四层横向 surface。信息检查器首行直接列出当前可用的“会话 / 文件 / 变更”视图。
- 会话栏与信息检查器支持拖动、双击恢复和 VoiceOver 调整宽度，并跨重启保留；拖动会保留主工作区的最小宽度，不在操作过程中把另一栏挤走。信息检查器的默认及最小宽度提高到 `400pt`，旧窄值自动校准，完整 Session ID 保持单行；空会话提示改为在标题区与 Composer 之间的正文区域真正居中。
- Composer 上方新增会话工作摘要：当前 Session Path 显示 Plan 步骤，整个稳定 Session ID 聚合 DHashline-compatible `edit` / `write` 的已确认文件数与增删行活动；展开后可查看规范路径和首个变更行。账本只保存有界元数据，不保存源码或完整 patch，并明确标注覆盖可能不完整、不是 Git 净差异。

## [0.0.3] - 2026-08-13

### Added

- `0.0.3` 会话路径：原生查看当前与历史 Session Path，从用户消息“编辑并重走”或从助手消息继续；路径切换只更新会话上下文，不改项目文件、Git 或工作树。
- 逐 Session / Path 本机草稿：切换会话、路径和重启后逐字恢复；待创建路径只有第一条非空用户消息真正持久化后才成为 Pi 路径。
- Session 菜单提供“复制到项目…”与“复制到项目并归档原会话…”；目标使用新 Session ID 和目标 Source Folder `cwd`，保留完整持久化历史与源谱系，源 Pi JSONL 不变。
- 左栏新增“已归档会话”：归档仅排除 D Code 的 Recent、Project 与 Search，可查看来源、复制目标和归档时间并恢复显示；复制成功但归档失败时保留可重试状态。
- Recent 与 Project 会话行新增 Hover / 键盘聚焦置顶和直接归档操作，并在右键与会话菜单提供等价入口；置顶跨重启、在分页前排序且不扩大可见范围，直接归档保留 Pi JSONL、逐路径草稿与置顶状态。
- 会话正文按用户消息组织为工作轮：完成后默认只显示最终回答及耗时、工具数和完成时间，中间 Thinking、过程回复与工具记录按轮折叠；运行中只显示当前思考或当前工具。
- 长会话左缘新增对话导航尺：悬停刻度预览用户问题与最终回答，点击或键盘调整只滚动定位当前 Session Path 内的工作轮；定位历史后暂停自动追尾，可显式“回到最新”。
- `pi-dhashline` 的 read/edit/write/search 由既有 Host 扩展执行路径继续提供，D Code 新增原生锚点、边界行和 diff presenter；write/edit 正文默认隐藏，不调用扩展的 `pi-tui` renderer。
- 空的 D Code 创建会话可从 Recent 右键菜单或会话操作菜单移到 macOS 废纸篓；非空、旧 Pi、可写或有子会话引用时保留原文件并引导归档。

### Changed

- Host 兼容门禁提升到 `0.0.3` 并要求 `sessionPaths`、`sessionCopy`、`sessionVisibilityExclusions`；归档 ID 在列表分页和搜索排序/截断之前排除。
- 完整会话复制改用隐藏暂存中的有界流式校验与同卷原子发布；严格拒绝损坏 JSONL、重复 Entry ID、缺失父节点、半条尾记录、源变化和 Busy 状态，失败目标不会进入正常导航。
- Project 展开加载因收起项目或侧栏生命周期结束而被取消时静默保留已有缓存，不再把正常的 `CancellationError` 显示为“无法读取项目会话”。
- 新建 Session 在完整 Header 与 D Code 来源落盘后立即返回并显示于 Recent；旧可写 Runtime 最长十余秒的安全清理改为随后独立打开阶段，不再阻塞创建反馈。
- Work Inspector 在 `≥880 pt` 时优先作为非模态右栏常驻，不再压暗或禁用左栏与会话；`880–1105 pt` 由左栏改用临时覆盖保留中央宽度，紧凑窗口继续使用互斥面板。
- 助手 Markdown 改为保留段落、空行、无序与有序列表换行，同时继续解析行内粗体、链接和代码；复制仍使用原始消息正文。
- Project 新建、Session 操作与模型选择菜单只保留各自一个下拉指示；会话标题栏与侧栏置顶 / 归档图标对齐标题行，同时保留 `40 pt` 命中区和原生菜单无障碍语义。
- 后续版本路线校准为 `0.0.6` Goal / Work Map（耐久工作对象与人工门禁）→ `0.0.7` 当前 Session 内的 D Team 执行层 → `0.0.8` 以 Work Item 为锚点的持久跨会话交接 → `0.0.9` 本机 Skill、权限策略、有效授予、审计与恢复收口；Todos、MiniMax Code 与 `pi-dteam` 只作为本地 UI / UX、工作地图和执行机制参考，不改变 `0.0.4–0.0.5` 切割，也不表示这些能力已由当前 App 实现。

## [0.0.2] - 2026-08-12

### Added

- `0.0.2` 可见会话搜索：通过左栏入口或 `Command-K` 打开原生浮层，搜索 D Code Recent 与已关联 Project 的会话标题、当前活动路径用户正文和助手正文；支持 Project / Source Folder 筛选、稳定 Session ID 打开、Entry ID 定位和短暂高亮。
- 全局“新建会话”直接使用当前 macOS 用户目录作为 `cwd`，不再弹出文件夹选择器；Project 内新建仍从已登记 Source Folder 中选择。
- Host 使用固定 Node 运行时内置的 SQLite FTS5 与独立 Worker 建立可删除、可重建的本机索引；中文使用单字与重叠双字词，相邻短语按连续位置匹配，结果片段指向真实命中；查询时再次强制可见范围，不索引 thinking、工具载荷、工具结果、认证字段或非当前会话路径。
- 搜索浮层显示期间每秒执行一次轻量文件身份探测：只遍历 JSONL 路径并读取已判定可见候选的文件元数据；非当前会话被外部新增、更新或删除后自动使缓存失效，检测到漂移后才进入完整索引刷新。

### Changed

- App/Host 兼容门禁提升到 `0.0.2` 并要求 `sessionSearch` 能力；搜索和索引不会取得 Session Lease 或修改 Pi JSONL，正在追加的半条目会保持索引未完成并按指纹退避重试，刷新期间的新失效信号不会丢失。运行期 SQLite 缓存损坏只进行一次安全重建；持续失败会锁存为可操作错误，等待显式重试，不形成重建循环。

## [0.0.1] - 2026-08-11

### Added

- `0.0.1` 原生工作台：冷启动 User Home、由 D Code 新建的最近会话每次 10 条递增加载、D Code Project 与多 Source Folder、关联文件夹后发现旧 Pi 会话、项目内跨文件夹平铺会话、响应式三栏、按需只读文件树及真实只读 Git Changes。
- macOS 原生 Settings 窗口与左栏齿轮入口，用于持久化系统/浅色/深色外观、左栏和宽屏工作检查器偏好，并可恢复默认布局。
- Project 元数据使用本机版本化 JSON 原子保存；规范化目录全局唯一，跨项目移动需要再次确认，损坏或不支持的资料会保留原文件并禁用后续写入。
- Composer 集中真实模型、思考强度、Context Usage 与 D Code 自有极速状态；极速按 Session 持久化，只在支持的 `openai-codex` 模型请求 `service_tier: priority`。
- Protocol v1 增加 `session.list.cwdScope`、`session.list.origin`、`session.refresh`、`session.setFastMode`、Context Usage/Fast state；`session.create` 在初始 JSONL 中写入不进入模型上下文的 D Code 来源标记，Recent 在分页前据此筛选。初始文档发布后即确认创建，后续可写激活失败会返回已创建对象并降级为观察或明确不可用，不产生重启后才出现的幽灵会话。App 会在读取会话前校验 Host 版本与 0.0.1 必需能力。

- Node/Pi Host Protocol v1、Session Lease、持续会话观察与按需写入、失效租约自动恢复、结构化 Extension UI Bridge、父进程消失后的有界退出与原生 Unicode Mermaid 渲染动作。
- macOS 14+ SwiftUI/AppKit 原生工作区侧栏、Recent 与 Project 会话导航、显式“新会话/重新载入”动作、历史/工具/Thinking 展示、会话创建与打开入口、流式 Composer、活动 Plan 浮层、代码/Mermaid 内容块和原生扩展对话框。
- Swift Host 子进程桥、连续 JSONL 请求关联、streaming/persisted 回复去重、Finder 环境补全、诊断脱敏与真实会话观察冒烟；Mermaid 支持缩放、复制源码/图片、PNG 导出及不支持类型的显式源码回退。
- 本机 arm64 `D Code.app` 装配脚本：内嵌 Node 22、Host 与生产依赖，使用本地 ad-hoc 签名，无需手动启动辅助服务。
- `D Code.app` 增加首枚临时品牌图标：以层叠 `D` 形工作台为主体，使用石墨外层与琥珀色工作内层，并随本机 App 构建写入 `.icns` 资源。
- 既有会话可在 App 内持续观察，发送或修改运行设置时以本次操作表达写入意图；Host 通过静默窗口、原子租约和外部写入检测保护单写入，不要求 CLI 插件或 Handoff ID。D Code 创建来源标记只控制 Recent 导航可见性，不充当写入锁或接管凭据。
- 增加 D Code 专有源码可见声明、第三方许可证索引与构建期许可证清单；本机 App Bundle 随包保留 Node.js、Pi、Apache-2.0 及缺失 npm 包的许可与归属信息。

### Changed

- Composer 的占位文字与光标改由同一原生多行文本控件排版；删除通用“能力状态”常驻菜单。Pi RPC 的工具展开查询恢复中性 `false` / no-op（空操作），被忽略的展示提示不再上浮全局警告。
- 既有 Pi 会话不再显示默认“只读/继续”界面：D Code 以正常 Composer 持续观察当前 JSONL，文件身份变化后从已知路径刷新；发送或修改运行设置时按需取得租约。外部同时写入会中止 D Code 写入、释放所有权、保留草稿并返回持续观察。
- D Code 删除对 `@earendil-works/pi-tui` 的直接依赖、Host headless TUI 渲染、Protocol custom input/resize，以及 Swift 兼容面板和 widget 呈现；标准结构化扩展对话框与状态仍保留，custom/widget 等 TUI 请求改为显式阻止或忽略。`pi-coding-agent` 私有传递依赖中的 `pi-tui` 保留但不由 D Code 调用。
- `extension.respond` 在进程入口绕过普通请求队列，结构化扩展对话不会再与等待响应的 `session.prompt` 互相阻塞；会话关闭或 Host 结束时同时清理原生扩展界面状态。
- 建立 `doc/参考文件/`，记录 Codex、ZCode、MiniMax Code、PiDeck、Flue、Orca、pi-intercom 与 pi-messenger 的借鉴点和不采用边界。
- 产品交互契约与原型统一为“点击 Project 直接查看全部 Source Folder 文件树、项目下跨文件夹平铺 Pi Session、来源文件夹作为会话副标题”；版本演进相应调整为 `0.0.1` 建立项目文件范围、`0.0.4` 提供中央标签与普通文件只读查看、`0.0.5` 提供 Markdown/HTML 未保存缓冲区即时预览。此项只记录目标与原型，不表示原生 App 已实现。
- 产品交互契约与原型将模型与思考强度、极速开关、上下文占用集中到 Composer 底部；Work Inspector 的 Context 只呈现当前路径与已加载来源，顶部运行状态不再重复这些输入状态。此项只记录目标与原型，不表示原生 App 已实现。
- 用户可见产品名、应用包与界面文案统一为 `D Code`，其中 `D` 取自创作者长期使用的网名 `diwu`；项目目录使用 `dcode`，内部 Swift 目标、Host 包名、环境变量、Bundle ID 与租约目录保留既有兼容标识。
- 有界 `session.list` 在解析摘要前先按文件 mtime 选择最近候选；现实 1233 个会话、约 2.4 GiB 下，最近 60 项列表降至亚秒级。
