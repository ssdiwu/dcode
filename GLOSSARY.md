# D Code Glossary（术语表）

本文件是 D Code 项目术语的根目录唯一权威，只回答项目专有概念“是什么”。未标注“当前实现”或“历史”的词默认描述已确认目标产品，不证明源码已经交付；当前实现看 `doc/10-架构与运行/`，产品行为与验收由精确 `PRD（产品需求文档）`负责。机器检索所需 JSON 只能从本文件生成并随时重建，不能成为第二份术语权威。

## 产品与数据

**D Code ADE（D Code 智能体开发环境）**：
由 D Code 自己拥有项目、任务、会话、上下文、能力、模型资源、原生界面和自进化闭环的 macOS 开发环境。Pi SDK 是首个运行基座，不定义 D Code 的产品身份、数据格式或界面。
_Avoid_: Pi GUI、Pi CLI 桌面版、通用聊天客户端

**D Code Harness（D Code 能力承载与编排层）**：
位于 Agent Runtime 之上的 D Code 产品层，拥有 Project、Task、D Code Session、Task View、Agent Run、能力模块、上下文组装、可见事件、报告、证据链接与原生界面；它不复制底层模型循环，但拥有模型循环所消费和产生的产品事实。
_Avoid_: Pi UI、第二 Agent Loop、通用 Agent Runtime

**D Code Product Store（D Code 产品数据仓）**：
D Code 在当前用户 D Code Data Root 下，对 Project、User Scope Task、D Code Session、提交原文、生效输入、Agent Run、能力配置、模型资源、产物、证据与恢复事实的原生耐久权威。具体数据库与索引技术属于实现选择，不改变这条产品所有权。
_Avoid_: Pi JSONL 镜像、搜索缓存、双向同步库

**D Code Data Root（D Code 数据根目录）**：
当前 macOS 用户主目录下的 `~/.dcode/`，是 D Code Product Store、D Code Session、设置、Agent Profile、能力 / 模型配置、受管 Artifact、索引、日志和恢复资料的统一本机根目录。它不拥有 Project 源码或一等项目文档正文，也不得以明文保存凭据。
_Avoid_: `~/.pi/agent`、Project Directory、用户主目录全部内容、Keychain 替代品

**D Code Session Database（D Code 会话数据库）**：
D Code Product Store 中专门持久化 D Code Session、Raw Input、Effective Input、消息、Session Path、运行记录和上下文投影的原生会话领域。它不是 Pi JSONL 的同步副本，也不以能否导回 Pi 作为完整性标准。
_Avoid_: Pi Session Cache、JSONL 镜像、会话搜索索引

**D Code Session（D Code 会话）**：
由 D Code Product Store 持久化、附着于 Task 的对话与上下文对象，拥有稳定身份、提交原文、生效输入、消息、路径、运行记录和压缩投影。它可以由 Pi Session 导入，但导入后独立演化，不以 Pi JSONL 作为继续使用的权威。
_Avoid_: Pi Session、一次 Agent Run、任务本身

**D Code Session Presentation（D Code 会话呈现）**：
Host 按确定的 D Code Session ID 返回的只读呈现投影，包含该会话自身、可选的 Runtime Adapter binding（运行时适配绑定）、活动 Runtime 状态以及可安全读取的 Adapter 会话快照。它不通过标题、cwd 或全局 active Session 猜测映射，也不会为查看行为抢占、暂停或迁移已有 Runtime。
_Avoid_: `session.open` 抢占、Pi Session ID 猜测、全局当前会话、第二份会话数据库

**Task Session（任务会话）**：
附着于一个 D Code Task、用于讨论、协调或执行该任务的 D Code Session。一个任务可以没有会话，也可以拥有一个或多个任务会话；会话不拥有任务，关闭、归档或切换模型都不会结束任务。
_Avoid_: Task、一个任务一条会话、无任务归属的耐久会话

**Coordination Session（协调会话）**：
一个 Task 当前用于用户与 Coordinator Agent 持续对齐、派发、收集问题和综合结果的默认 Task Session。它在界面中呈现为任务对话本身：点击 Task 主行即进入，导航不为它建立独立的子会话行，协调者就活在这个对话里。它不拥有 Task、Agent Team 或其他 Session；更换协调会话也不会改写任务身份。
_Avoid_: Task Root、唯一任务会话、独立协调者子会话行、Agent Team 所有者、历史 Main Agent Session

**Child Agent Session（子智能体会话）**：
某个 Agent Run 为独立 Agent 工作创建的 D Code Session。它附着于所属 Task 和 Agent Run，拥有自己的消息与上下文；默认从对应任务与运行进入，不作为普通会话重复平铺到顶层列表。
_Avoid_: Session Path、主会话副本、Agent Run

**Pi Session（Pi 会话）**：
由 Pi 持久化的外部或旧版会话对象。D Code 可以读取并导入它，但不与其双写、持续同步，也不把 D Code 会话的完整导出兼容性作为产品承诺。
_Avoid_: D Code Session、D Code 当前会话权威

**Pi Session Import（Pi 会话导入）**：
用户通过显式“导入为任务”动作，把选定 Pi Session 的可识别历史、来源和结构转换为一个新的 D Code Task，并在其中创建首个 D Code Session。用户选择 Project Scope 或 User Scope；导入保留来源证明但不修改源 JSONL，转换后的 Task / Session 使用 D Code 身份独立演化。
_Avoid_: 静默发现即导入、只创建孤立 Session、双向同步、打开即复用、兼容导出

**Imported History Projection（导入历史投影）**：
导入 Pi Session 后，D Code 从 Product Store 当前 Session Path 上的已脱敏历史派生出的有界上下文证据。它明确标注为 lineage unknown（来源链未知）的外部历史，不是当前指令、D Code Raw Input 或新 Session Run 的模型回复；只以 digest、数量、截断和脱敏事实写入 Receipt，不把正文倒填进 Raw / Effective Input，也不重新读取或写回源 Pi JSONL。
_Avoid_: Pi JSONL 续写、导入用户原话倒填 Raw Input、无界全文注入、隐藏思维链

**Main Agent Session（主智能体会话）**（历史目标态术语）：
ADR 0013 曾用来表示 D Team 协作根的 Pi Session。当前产品协作根是 Task，普通任务会话或协调会话都不拥有任务和团队。
_Avoid_: Task Root、当前产品协作根

**User Home（用户首页）**：
D Code 的全局导航初始状态，以当前 macOS 用户名标识使用者。日常导航直接呈现「项目」与「任务」两个工作对象分区；它不是需要先进入的独立页面或容器，也不等于文件系统用户主目录、默认 Project 或数据仓本身。
_Avoid_: 默认项目、会话目录、Product Store、`~/.dcode/` 文件浏览器、用户作用域页面

**User Scope（用户作用域）**：
当前 macOS 用户拥有、位于所有 Project 之外的 D Code Task 归属范围。Task 未选择 Project 时必须属于 User Scope，其默认执行目录映射为该用户的 Home Directory；产品数据仍写入 `~/.dcode/`，不会散落到主目录普通文件中，也不会伪造“未选项目”。导航栏只在「任务」分区直接呈现这些 Task，不把 User Scope 作为可进入的容器、分组名称或技术标签显示给用户。
_Avoid_: nullable Project、默认 Project、无归属 Task、`~/.dcode/` 执行目录、用户作用域分区

**Project Scope（项目作用域）**：
由一个 D Code Project 拥有、以其唯一 Project Directory 为默认执行目录的 Task 归属范围。Task 属于 Project Scope 时保存稳定 Project ID；它不等于目录本身、User Scope 或项目文件全文。
_Avoid_: Project Directory、User Scope、多 Project Task、路径字符串归属

**Recent Sessions（最近会话）**：
按最后活动时间排列的 D Code Session 快速入口视图。它不拥有或复制会话，也不替代 User Scope / Project Scope 下的 Task 列表；打开会话应能返回其所属任务。
_Avoid_: 最近任务、默认项目会话、任务真相源

**D Code Session Origin（D Code 会话来源）**（历史实现术语）：
旧版 D Code 写入 Pi Session 的来源条目，用于证明会话由 D Code 创建。D Code 原生会话权威成立后，来源成为 Product Store 内的普通 provenance（来源证明），不再决定产品可见性。
_Avoid_: 当前会话身份、当前导航权威

**D Code Project（D Code 项目）**：
由 D Code 管理、长期持续演化的产品与工作容器，拥有名称、唯一 Project Directory、一等项目文档、Project Knowledge、Project Vision 和 Task 集合。它不等于 D Code Session、Task 或独立 Goal。
_Avoid_: Pi Project、多目录容器、会话文件夹、一次性任务

## 一等项目文档

**First-class Project Document（一等项目文档）**：
D Code 能识别其类型、权威职责、作用域、版本与取代关系，并可将当前原文连同路径和 revision 按需直接加载给 LLM 的项目对象。它不是普通 Markdown 搜索结果，也不意味着每轮全文注入。
_Avoid_: 无类型知识片段、默认全量 Prompt、文档副本

**Project Constitution（项目宪法）**：
一个 Project 中稳定的一等文档集合，说明项目是什么、Agent 如何工作、设计遵守什么、术语怎样理解、需求与决定去哪里读取。它由各类文档分工组成，不是一份自动拼接的总文档。
_Avoid_: 项目文档全文、任务说明、自动生成项目哲学

**Project Map（项目地图）**：
由根 `README.md` 与按需存在的 `doc/README.md` 组成的入口和路由文档，说明项目身份、目录职责、运行入口和各问题的当前权威。它负责指路，不覆盖规则、设计、需求、术语或决定。
_Avoid_: PRD、产品宪章、完整知识库

**Agent Instructions（智能体规则文档）**：
由 `AGENTS.md` 承载、按目录作用域约束 Agent 工作方式、安全边界、验证与交付的规则型一等文档。每次 Agent Run 建立及每次 Session Run 启动前都必须解析适用规则；工作目录作用域变化只标记下一 Run 需要刷新，不热改已经开始的 Run。
_Avoid_: Skill、任务 Prompt、产品需求

**Design Document（设计文档）**：
由 `DESIGN.md` 承载、定义产品设计性格、稳定体验原则和详细设计权威路由的一等文档。产品、交互、视觉、文案与设计审查任务按需加载。
_Avoid_: UI 规格全集、PRD、视觉参考图库

**Product Charter（产品宪章）**：
由 `PRODUCT.md` 承载、定义目标用户、产品使命、核心价值、产品主干与长期非目标的一等文档。它不复制版本功能、当前实现状态或逐项验收。
_Avoid_: 版本路线图、PRD 合集、当前实现说明

**PRD（Product Requirements Document，产品需求文档）**：
定义某个明确产品范围的问题、目标、行为、非目标、约束、验收与验证合同的一等文档。Task 关联精确 PRD；PRD 不代替任务状态、当前实现说明或 ADR。
_Avoid_: Project Charter、Task、实现进度表

**Glossary（术语表）**：
由根 `GLOSSARY.md` 承载、定义项目专有概念标准含义与禁用混称的一等文档。LLM 在首次遇到专有词、发现语义冲突、写规格或准备向用户澄清前按需读取相关定义。
_Avoid_: `glossary.json` 权威、实现 schema、普通词典

**ADR（Architecture Decision Record，架构决策记录）**：
解释一项难逆转决定为何成立、取代了什么以及保留哪些后果的一等决策文档。它按需参与冲突判断，不替代当前 PRD、产品宪章或实现事实。
_Avoid_: 当前状态页、需求规格、通用 decisions 日志

**Global Knowledge（全局知识）**：
跨 Project 可复用、由 507 持有和治理的长期知识来源。Project、Task 和 Session 只引用所需内容，不复制整库或因一次会话自动写回；当前主要来源是 Content Vault。
_Avoid_: 全局 Prompt、所有会话全文、自动记忆堆积

**Project Knowledge（项目知识）**：
一个 Project 自己拥有、由 `doc/` 及其 Project Map 组织的局部知识来源。一等项目文档保留各自更高且明确的职责；读取普通 Knowledge 时也必须保留来源 revision 与当前或历史身份，不能把所有 Markdown 当成同等可信的片段。
_Avoid_: Global Knowledge、无类型全文索引、项目现场

**Global Vision（全局愿景）**：
507 跨 Project 长期选择的方向与取舍标准，用于判断哪些 Project 和投入值得持续。它不等于 Reminder、Task、截止日期或不经确认的 Agent 总结。
_Avoid_: 长期待办、全局 Goal 对象、提醒事项

**Project Vision（项目愿景）**：
一个 Project 长期想成为什么、哪些价值不能被短期结果覆盖、什么证据会促使其改变方向的稳定判断。它可以引用产品介绍、路线图和决策；缺失时应明确显示缺失，不由 Agent 自动拼接成既定愿景。
_Avoid_: Task Goal、Roadmap、提醒事项、当前版本计划

**Project Now（项目现场）**：
Project 当前 checkout、branch、revision、未提交改动、在役 Task、规格、验证和发布门禁的动态事实投影。它不是 Knowledge 或 Vision，必须从当前文件、Git、代码、测试和平台证据读取。
_Avoid_: 项目知识页、CHANGELOG、静态状态摘要

**Project Directory（项目目录）**：
一个 D Code Project 唯一关联的规范化本机目录，也是项目文件树根、新 Task 与 Agent Run 的默认执行目录。修改项目目录只改变 D Code 对项目和会话的关系；导入来源文件默认不随之改写。
_Avoid_: Source Folder、Session Copy、项目显示路径

**Source Folder（源文件夹）**（历史）：
`0.0.1–0.0.24` 的多目录 Project 概念，已由 `0.0.25` 的 Project Directory 取代。兼容代码或历史文档仍可能使用该名称，但当前产品不得重新暴露多 Source Folder 心智。
_Avoid_: 当前 Project Directory、当前产品入口

**Session Path（会话路径）**：
同一 D Code Session 内从根节点到当前节点的一条活动对话路径；切换或续写路径不会创建、切换或还原 Git 分支和项目文件。
_Avoid_: 会话分支、Git 分支

**Session Copy（会话复制）**：
把一个 D Code Session 的所选耐久历史复制为具有新稳定身份、可归入另一 Project 或 Task 的独立 D Code Session。源会话始终保留；项目文件、Git 状态和未选择的本机草稿不随之复制。
_Avoid_: 移动会话、迁移会话、修改会话 `cwd`

**D Code Archive（D Code 归档）**：
以稳定 D Code Session ID 保存的本机、可逆产品状态。归档会话退出普通导航和默认搜索，但历史仍由 Product Store 保留，并可从归档入口恢复；它不改变任何导入源文件。
_Avoid_: 删除会话、移动会话文件、Pi 归档

**Composer（输入区）**：
与当前 Task Session 和 Session Path 绑定的消息输入区域；没有正式 Task 时，它承接当前 User Scope 或 Project Scope 下的 Task Draft，首次提交后创建对应作用域的 Task 及其首个 Task Session。一级控制只保留当前运行需要的最小选择与发送，文件、Skill、能力和上下文入口按需进入。
_Avoid_: 模型状态栏、信息检查器模型设置

**Composer Draft（输入草稿）**：
D Code 为特定 Task、D Code Session 与 Session Path 保存、但尚未提交的输入内容。它可以修改或删除，不是提交原文、消息或会话路径节点。
_Avoid_: 提交原文、待发送消息、会话节点

**Raw Input（提交原文）**：
用户在 D Code 明确提交的逐字文字、附件引用和来源事实。提交后不可被技能展开、输入转换、压缩或编辑并重走原位覆盖；后续修改产生新的 Raw Input 和路径。
_Avoid_: Effective Input、输入草稿、压缩摘要

**Effective Input（生效输入）**：
D Code 基于提交原文、任务合同、已选择能力和显式上下文组装后真正交给 Agent Runtime 的输入。它必须关联来源 Raw Input，不能在界面中伪装成用户逐字说过的话。
_Avoid_: 用户原话、系统提示词全集、上下文缓存

**D Code System Prompt（D Code 系统提示词）**：
D Code 为每个 Session Run 组装、定义 Agent 基础身份与运行合同的系统级输入；该 Run 属于某个 Agent Run 时，同时带入对应 Agent 角色合同。它完整替换 Pi 的通用身份，而不是在 Pi 提示词后追加品牌说明；至少包含 D Code 基础身份、当前运行环境、Agent 角色与职责、以及由本轮真实 Active Tool Set 同源生成的工具名称和说明。当前目录作用域适用的 `AGENTS.md` 必须作为带来源的 Context Projection 加入；其他项目文档、知识与历史按需加入，不默认全文塞入该提示词。
_Avoid_: Pi 默认系统提示词、静态品牌文案、全部项目文档、手写工具白名单

**D Code Agent（D Code 智能体）**：
在一次 Session Run 中接受 D Code System Prompt、Context Projection 与 Active Tool Set，并通过当前 Agent Runtime 执行工作的模型角色。`0.0.27` 只有单一普通 Agent Runtime；`0.0.28` 起真实 Agent Run 可以把 D Code Agent 具体化为 Coordinator、Explore、Worker、Verifier 或其他角色。它不是模型本身、Agent Profile、Task 所有者或可跨重启继续运行的进程。
_Avoid_: Pi Agent、模型身份、Agent Profile、永久 Worker

**Prompt Assembler（提示词组装器）**：
D Code 在每次 Session Run 启动前，把 D Code 身份、Runtime Environment、Agent Role Contract、Active Tool Manifest 与强制 / 已选择 Context Projection 组装成 Effective System Prompt 的运行组件。它必须阻断未经选择的 Pi 默认与追加提示词来源，并在组装失败时阻止请求，不能回退成双重身份。
_Avoid_: Prompt 模板编辑器、字符串追加器、Pi SYSTEM loader、上下文全文拼接器

**Runtime Environment（运行环境）**：
某次 Session Run 开始时冻结的可核对运行事实集合，包含当前 User / Project Scope、Task、Session、Agent Run、cwd / worktree、模型 / Provider、模式、平台、已加载规则和能力来源。它不是设置期望、Agent 自述或跨 Run 自动更新的全局状态。
_Avoid_: Runtime Settings、System Prompt 全文、Context Projection、环境变量正文

**Managed Worker Worktree（受管 Worker 工作树）**：
由 D Code Host 在一条 Worker Agent Run 启动前，为符合条件的 Git Project Scope 在 `~/.dcode/runtime/` 下创建、验证并保留的 detached Git worktree（分离 Git 工作树）。它与稳定 Agent Run、受管 Artifact 和预写 External Side-effect Attempt（外部副作用尝试）一一关联；Worker 只能在该工作树中以 `exclusiveWrite` 运行。User Scope、非 Git、源目录未提交，或 Task 选中的 Scope Document 未能从冻结 Git revision 物化时必须显式拒绝；系统不会自动删除、提交、合并、推送或重试 unknown（结果未知）工作树操作。
_Avoid_: 原项目目录共享写入、临时复制目录、Worker Profile 设置、Git 自动提交

**Agent Environment（智能体环境）**：
D Code 面向用户呈现某次 Agent / Session Run 实际身份与输入边界的只读结构化投影，组合 Runtime Environment、Agent Role Contract、Context Projection 来源、Active Tool Set 与 Effective Prompt Receipt。它不显示完整 System Prompt、凭据或隐藏 Thinking，也不成为这些事实的第二权威。
_Avoid_: Runtime Environment 本身、Prompt 查看器、设置页面、Agent 自述

**Agent Role Contract（智能体角色合同）**：
某个 Agent Run 当前承担的角色、目标、职责、范围、完成信号、停止边界与回报对象的结构化合同。它可以基于 Agent Profile 和 Agent Assignment 生成，但不等于 Profile、Prompt、模型身份或技术权限。
_Avoid_: Agent Profile、Agent Assignment、System Prompt、Permission Grant

**Effective System Prompt（生效系统提示词）**：
某次 Session Run 真正启动 Agent Loop 时最终交给 Agent Runtime 的不可变、版本化 D Code System Prompt 结果，关联模板版本、运行环境、角色合同、Context Projection 来源与 Active Tool Set revision。一个 Agent Run 跨多个 Session Run 或在安全边界更换环境、角色、模型或工具时，会引用多个按时间排列的生效结果，不得原位覆盖旧记录。Receipt 可以核对 hash、来源与当时身份，但不保存完整正文，也不保证在来源已变化或不可寻址时重建历史 Prompt；它不等于持久化隐藏 Thinking，也不得包含凭据正文。
_Avoid_: 提示词模板、用户消息、模型思维链、无限期全局 Prompt

**Effective Prompt Receipt（生效提示词回执）**：
在模型请求发出前由 D Code Product Store 为一次 Session Run 持久化的不可变、有界元数据记录，保存 Effective System Prompt 的模板版本与 hash、Runtime Environment / Agent Role / Context Projection 来源引用，以及 Active Tool Set revision；不保存完整提示词、项目正文、凭据或隐藏 Thinking。它证明“本轮准备使用了哪套系统输入与工具”，不证明 Provider 已接受请求或 Run 已成功完成。
_Avoid_: Effective System Prompt 正文、模型回复、运行完成证据、Self-evolution Receipt

**Active Tool（活动工具）**：
本轮 Runtime Adapter 已真实注册进 Agent Loop、模型能够实际调用的结构化工具。每项活动工具具有名称、说明、输入 schema 与执行器；D Code System Prompt 中的工具清单必须由同一份 Active Tool Set 派生，单独写进 Prompt 的名称不会创造工具、授权能力或证明调用成功。
_Avoid_: Prompt-only Tool、Skill、界面按钮、已安装但本轮未注册的能力

**Active Tool Set（活动工具集）**：
一次 Session Run 在合并 D Code 自有能力、Runtime 内置工具、已适配扩展与 Provider 工具后，经模型支持、启用范围和运行边界过滤并冻结的最终 Active Tool 不可变集合。所有来源都必须先进入同一归一化与过滤链路；模型 API Tools 和 Active Tool Manifest 只能从这个集合派生，不允许工具绕过它直接注册进 Agent Loop。
_Avoid_: 已安装工具全集、Capability Registry、Prompt 白名单、运行中可变列表

**Active Tool Manifest（活动工具清单）**：
由一次 Session Run 的 Active Tool Set 派生、放入 Effective System Prompt 的工具名称与 canonical model-facing description（规范模型说明）目录。完整输入 schema 与执行器仍通过模型工具 API 提供；清单的工具名集合必须与同一轮 API 工具集合完全一致，说明直接复用或确定性派生于同一规范字段，不能作为手写配置或独立权威。
_Avoid_: 工具注册表、固定白名单、工具 schema 副本、已安装能力列表

**Context Projection（上下文投影）**：
某次 Session Run 或 Agent Run 实际读取的有界材料组合，可以包含摘要、近期消息、一等项目文档、知识引用和任务事实。投影可以压缩和重建，但不得覆盖来源，也必须能够回查原始事实。
_Avoid_: 权威历史、全部项目文件、隐式全量注入

**Task Context Selection（任务上下文选择）**：
某个 Task 当前显式选择的、带 revision 的有序 Context Source 集合。`AGENTS.md` 是强制规则来源，不在其中取消；其余 Scope Document（作用域文档）和 Global Knowledge（全局知识）必须逐个选择具体文件。选择记录来源类型、根、相对路径、展示名与顺序，不保存正文；每个 Session Run 将当时 revision 和来源回执冻结到 Effective Input 与 Prompt Receipt，后续修改不会覆盖历史。
_Avoid_: 全部 doc/、Content Vault 全量注入、Task Goal 文本、Pi 自动项目上下文

**Pre-session Draft（会话前草稿）**（历史实现术语）：
旧会话优先实现中，用户点击“新建会话”后、首次提交非空正文前由 D Code 本机拥有的临时输入对象。项目—任务模型使用 Task Draft 承接新工作；旧资料仍按本定义读取，不把空白草稿伪装成 D Code Session。
_Avoid_: 当前 Task Draft、空会话、临时 Session ID

**Queue Item（队列项）**：
用户在当前 Session Run 执行期间明确加入 Follow-up Queue 的一条意图。它具有稳定身份并绑定确切 D Code Session 与路径；派发前可编辑、调整顺序或撤回，派发确认后转成新的 Raw Input 与 Effective Input 关系。
_Avoid_: 已发送消息、后台任务、任务工作项

**Follow-up Queue（后续消息队列）**：
当前 D Code Session 与 Session Path 内 Queue Item 的有序集合。它不会中断当前 Session Run，只在前一 Run 正常收口且派发边界成立时逐条继续；失败、中止、等待结构化用户输入或身份漂移都会保留队列并暂停自动派发。它不是跨会话调度或多 Agent 任务列表。
_Avoid_: Steer、任务队列、跨会话收件箱

**Navigation Sidebar（导航栏）**：
D Code 工作台左侧以「项目」与「任务」为唯一工作对象分区的全局导航区域：每个 Project 行下显示其 Task；不属于 Project 的 Task 直接显示在「任务」分区。置顶、最近、活动、搜索、归档与设置只是功能入口或投影视图，不成为第三种工作对象分组。它负责选择、组织与活动发现，不拥有任务、会话或设置页面。
_Avoid_: 任务数据库、项目页面、设置导航、用户作用域容器、未选项目分区

**Session Sidebar（会话栏）**（当前实现术语）：
0.0.x 会话优先工作台的左侧导航名称。目标产品升级为 Navigation Sidebar；保留该词只用于当前源码、版本 PRD 和迁移验收，不继续表达产品主干。
_Avoid_: 当前目标导航、Task Sidebar

**Activity View（活动视图）**：
Navigation Sidebar 中按 Task、Session Run 与 Agent Run 真实状态组织的活动投影。它优先显示等待用户、当前运行和尚未查看的新完成结果；它不创建新会话、主页面、标签、任务数据库或后台 Runtime。
_Avoid_: 通知中心、任务页面、多会话调度器

**Run State（运行状态）**：
D Code / Host 能以稳定 Session Run 生命周期、结构化等待请求、失败或持久化事实证明的执行状态。Session 文件更新时间、动画、当前焦点或超时都不能单独构成 Run State。
_Avoid_: User Attention、Session 更新时间、加载动画

**Interaction Dock（交互坞）**：
从 `0.0.6` 起位于 Composer 附近的当前 Session 连续控制面，统一呈现当前活动、Follow-up Queue、等待输入、停止、继续与安全重试。它不是跨 Session 调度、Goal 面板或第二个 Composer。
_Avoid_: Activity View、任务栏、输入区副本

**Main Workspace（主工作区）**：
D Code 工作台中央的主要内容区域。Conversation、Settings、Archived Sessions、Workspace Tab 与后续文件预览都在这里切换；切换页面不会创建第二个应用窗口，也不会把信息检查器变成主内容页。
_Avoid_: 主要页面、中央栏、弹窗容器

**Information Inspector（信息检查器）**：
D Code 在用户明确打开文件、Artifact、Diff 或其他需要连续检查的对象时出现的全高右侧详情区域。它显示所选对象的路径、来源、元数据、变更、引用和相关操作，不常驻承载 Task 进度、Agent Team 或交付物概览。源码中的 `WorkInspector` 是既有内部类型名；用户界面统一称“信息检查器”。
_Avoid_: Task HUD、常驻任务概览、第二主工作区、所有状态的统一右栏

**Task HUD（任务浮层）**：
当前 Task 存在时持续显示的轻量任务概览浮窗，展示进度、Agent Team、等待事项和交付物，并允许进入对应子会话或具体对象。它在任何宽度下都是与窗口边缘分离的独立浮窗，不进入普通文档流、不占结构栏位；正常宽度由 Main Workspace 为阅读画布与 Composer 预留左右安全宽度，使浮窗只落在安全区之外的留白上，不改变中央阅读宽度，也不遮挡正文。只有宽度不足时才允许覆盖阅读区域并提供收起 / 再打开入口。需要连续查看文件、Diff 或 Artifact 详情时转入 Information Inspector。
_Avoid_: 可随意关闭的宽屏面板、全高右侧栏、任务数据库、Information Inspector、固定挤压中央画布

**Foundation Console（基础设施控制面）**：
`0.0.28` 为真实使用和验收 Product Store、多 Runtime、Agent Profile、Coordinator / Child Agent、Request、Report 与 Attempt 提供的最小原生操作面。它复用正式 query / mutation contract，不拥有 UI 私有产品状态；`0.0.29` 工作台覆盖等价入口后退出普通导航，只保留必要诊断。
_Avoid_: 最终任务工作台、测试专用面板、第二套操作合同、永久临时 UI

**Workbench Page（工作台页面）**：
在 Main Workspace 中占据主要内容区的一种导航目的地，例如 Settings 或 Archived Sessions。页面不是独立窗口、Sheet，也不是会话栏或信息检查器。
_Avoid_: 侧栏、弹窗、第二窗口

Settings 是工具型 Workbench Page：进入时可以临时使用完整工作台画布，并以页内设置导航组织子页面；这套页内导航不叫 Session Sidebar，也不会新增第四个固定区域，但会继承导航栏同一份实际宽度。离开 Settings 后恢复此前工作台状态；只有原本打开了具体检查对象时才恢复对应 Information Inspector，Task HUD 按原 Task 状态恢复。

**Shared Rail Geometry（共享栏位几何）**：
工作台每个结构栏位在整个窗口中只有一份本机持久化的实际宽度。Settings 的页内设置导航与 Navigation Sidebar 共享左侧栏位宽度；Workspace、Settings、Archived Sessions 及后续 Workbench Page 中任一可调整入口改变该宽度后，其他页面立即继承。全高 Information Inspector 每次按需出现时也复用同一份右侧栏位宽度；Task HUD 不拥有栏位宽度。响应式布局可以暂时隐藏或覆盖栏位，但页面不得另设私有默认值、复制宽度状态或在切页时改变用户保存的宽度。
_Avoid_: 设置侧栏宽度、页面局部宽度、宽度副本、每页独立栏位

**Workspace Tab（工作区标签页）**：
Main Workspace 的 Workspace 页面中按需承载文件、Artifact、Preview 或 Editor 的可切换标签。Conversation（对话）是唯一会话主页面而不是标签；没有打开真实内容时不显示标签带，关闭最后一个内容标签后直接回到原会话主页面。各内容标签只保存自己的可恢复内容状态，不拥有或复制 Session / Path / Composer。
_Avoid_: 对话标签、消息附件、独立会话、空能力占位页

**File Preview（文件预览）**：
从 Project 文件树打开、在 Workspace Tab 中呈现的文件只读视图；它不是消息、附件或 Context 条目，打开本身不修改文件或 Git 状态。
_Avoid_: Context 附件、文件编辑器

**Live Preview（即时预览）**：
根据当前未保存编辑缓冲区持续呈现 Markdown 或 HTML 结果的 Workspace Tab 视图；Markdown 可在富预览与编辑分栏之间切换，HTML 必须在与宿主界面隔离的执行边界内呈现，不要求用户先保存或停止输入。
_Avoid_: 在宿主页面直接执行 HTML、自动加入模型上下文

**Goal（目标）**：
D Code 中说明“希望达到什么结果”的产品语义，附着于 Project 或 Task：Project Goal 表达长期方向，Task Goal 表达本次短期结果和验收目的。Goal 可以有原生视图和交互，但不建立 `Project → Goal → Task` 的独立身份层。
_Avoid_: 独立 Goal 数据库、会话标题、项目与任务之间的中间容器

**Task（任务）**：
具有稳定身份、短期结果、范围、状态和验收条件的基本完成单位，并且必须恰好属于一个 Project Scope 或当前用户的 User Scope。Task 可以拥有 Plan、Work List、多个 Task Session、一个或多个 Agent Run、Knowledge 引用、Artifact 与 Evidence；创建或编辑 Task 本身不会自动启动 Agent，任一会话或运行结束也不会自动完成 Task。
_Avoid_: nullable Project Task、无归属任务、D Code Session、单条 Todo、模型回复、一次 Agent Run

**Task Draft（任务草稿）**：
User Scope 或 Project Scope 中用于快速捕捉想法、反馈或潜在优化的轻量候选，尚未形成完整 Task 合同，也不会自动创建 D Code Session 或启动 Agent。它可以继续补充、合并、放弃，或在明确短期结果和验收边界后提升为同一作用域的正式 Task。
_Avoid_: 已开始任务、会话前草稿、自动执行请求

**Legacy Task（存量迁移任务）**：
`0.0.28` 升级时由 D Code 已经管理的可见 Pi Session 自动转换而来的 D Code Task，保留唯一既有 Project Scope，无法确定时进入 User Scope；源会话转换为其 Coordination Session，关联本机状态同事务迁移。Legacy 只说明来源，不限制后续正常使用。
_Avoid_: Import Candidate、只读旧会话、无归属 Task、永久迁移模式

**Plan（计划）**：
Task 为达到短期目标而采用、可以随证据修订或推翻的结构化推进方案。更换 Plan 通常不改变 Task 身份；Plan 不拥有 Task、Session 或 Agent Team，也不建立第二份 Work List。
_Avoid_: Task、静态路线图、模型思维链

**Work List（工作清单）**：
一个 Task 当前需要跟踪的 Work Item、状态、依赖、交付物和证据集合，用于回答“这项任务现在还要推进什么”。它属于 Task，不属于某个 D Code Session；普通步骤留在清单中，只有需要独立会话、Agent、验收或产物时才提升为 Subtask。
_Avoid_: Project Task List、Follow-up Queue、会话 Todo

**Work Item（工作项）**：
Task 的 Work List 中具有稳定身份的可跟踪步骤，包含状态、依赖、交付物和必要证据。Work Item 本身不拥有独立 Session 或 Agent Run；需要独立执行和验收时应提升为 Subtask。
_Avoid_: Task、普通 Todo 文本、Agent Assignment

**Subtask（子任务）**：
由一个较大 Task 拆出的独立 Task，拥有自己的短期结果、验收、Session 和 Agent Run，并保留父任务关系。只有独立执行与验收确有价值时才创建，不用无限嵌套替代 Task 内 Work List。
_Avoid_: Work Item、计划阶段、Agent Assignment

**Task View（任务视图）**：
对同一批 Task 按字段进行筛选、排序、分组或时间投影的保存视图，例如列表、看板、路线图、Agent 执行和用户关注。Task View 不复制 Task，也不拥有第二份状态。
_Avoid_: 任务副本、独立看板数据库、Task 状态源

**Project Management（项目管理能力）**：
Project 通过 Task、Task View、字段、Subtask、依赖、自动化与进展摘要组织长期工作的内置能力。它管理同一份 Task 真相，不等于新的 Project 对象，也不要求采用固定项目管理方法。
_Avoid_: 第二项目层、强制看板、独立 Goal 层

**Work Map（工作地图）**（历史目标态术语）：
旧产品目标中对 Goal、Work Item、依赖、验收和证据的综合投影。新模型以 Task 和多个 Task View 表达相同需要，不再把 Work Map 作为独立状态机或唯一页面。
_Avoid_: 当前任务真相源、后台调度器、Todos Cloud 镜像

**Agent Profile（智能体档案）**：
D Code 在本机保存、具有稳定身份与版本的可复用智能体默认配置，包含名称、职责说明、可选默认工作范围、模型路由与版本化 Skill 引用。声明范围用于调度与验收，不是运行时权限授予。档案不是运行中的 Worker，编辑只影响未来运行，也不会因创建或选择而自动执行。
_Avoid_: Team Run、常驻 Worker、独立 D Code Session

**Agent Team（智能体团队）**：
Task 按需组织一个或多个 Agent Run 的内置执行能力，可以串行接力、并行调查或分工完成同一 Task。团队属于 Task，不属于某个主会话；协调 Agent 负责派发、判断、冲突与综合，成员通过结构化 Finding、Request、Report 和 Evidence 协作，不默认声称自由 P2P。
_Avoid_: dteam、隐藏思维链面板、独立任务数据库、模型列表

**Coordinator Agent（协调智能体）**：
在一个 Task 中承担面向用户的持续协调角色的 Agent：理解目标、维护任务边界、决定是否派发 Agent Run、合并重复问题、处理成员请求与冲突，并综合报告和证据供用户验收。它就是活在任务对话（Coordination Session）中的 LLM，直接面对用户，不需要独立的会话入口或子窗口；它不拥有 Task，也不能替用户完成验收或把成员完成自动推导为任务完成。
_Avoid_: Task Owner、永久 Manager 进程、所有成员的共享上下文、自动验收者

**Coordinator Assignment（协调者指派）**：
Task 与一个 Coordinator Agent Profile 之间的稳定、版本化默认关系，说明谁负责后续协调，但不会因建立或恢复指派而启动模型进程。真正执行时另行创建 Coordinator Agent Run 并保存 Profile 快照。
_Avoid_: Coordinator Agent Run、常驻进程、Task Owner、模型选择

**Agent Assignment（智能体任务包）**：
Coordinator 或用户把 Task / Work Item 中一项有界工作交给某个 Agent Run 的结构化对象，包含目标、范围、完成信号、停止边界、上下文来源、回报对象和声明工作目录。它不是普通消息、共享会话内存或技术权限授予。
_Avoid_: Prompt 文本、Work Item 本身、Permission Grant、自由 P2P 消息

**Team Run（团队执行）**：
Task 显式启动、在一个有界执行阶段中组织多个 Agent Run 的一次团队执行，记录成员、串并行关系、子会话引用、来源上下文、可见事件和结构化报告。同一 Task 可以有多轮 Team Run；关闭一轮执行不会自动完成 Task。
_Avoid_: Task 状态、Agent Team 配置、可跨重启继续的模型进程

**Agent Run（Agent 运行）**：
一个 Agent Profile 在某个 Task 中承担明确职责的一次临时执行记录，保存档案快照、实际模型、工具集合、Skill 身份与版本、声明范围、上下文来源、执行目录、运行状态、报告和 Child Agent Session 引用。模型是运行事实，不是 Agent Run 的稳定身份；进程结束后可以恢复记录，但不能伪装恢复运行中的模型与工具。
_Avoid_: Task、Agent Profile、Child Agent Session、模型身份

**Finding（发现）**：
Agent Run 对一项局部问题形成的结构化观察，包含结论、来源引用、置信边界和必要 Evidence；它可以被 Coordinator 比较或综合，但不等于最终 Report、Task 决定或隐藏推理。
_Avoid_: Thinking、普通回复、Agent Report、已验收事实

**Agent Request（智能体请求）**：
Agent Run 向用户、Coordinator 或指定 Agent 提交的耐久、可寻址输入请求，具有来源、目标、问题、允许回答形式、状态和恢复身份。它不是普通会话消息、User Attention 或执行失败；User Attention 只是其可能产生的一种投影。
_Avoid_: 普通提问文本、通知、User Attention、无限等待状态

**Acceptance Request（验收请求）**：
Coordinator 向用户提出的任务阶段验收对象，在任务对话中呈现为验收卡：一句话请求、一个反馈输入框和单一确认动作。空内容确认即产生结构化接受事实；非空内容确认把反馈绑定本请求提交（可含图片附件）并触发返工，验收保持待定。接受不由模型文案推导，也不设独立的「要求返工」动作；它与成员请求一样在任务对话对象卡与 Task HUD 等待分区双入口等价。
_Avoid_: 要求返工按钮、自动验收、普通聊天确认、双状态源

**Agent Report（智能体报告）**：
Agent Run 在有界任务结束、阻塞或交接时提交的结构化结果，汇总 Finding、Artifact、Evidence、未解决项和建议下一步。报告完成不自动完成 Team Run 或 Task，也不替用户验收。
_Avoid_: 模型最后一句、Task Final Report、Agent Run 状态、隐藏过程

**Evidence（证据）**：
能够回到真实来源、身份、时间与覆盖范围的可核对记录，例如工具结果、测试运行、文件 revision、截图或外部系统回执。Evidence 支持判断但不自动构成成功、验收、提交或发布。
_Avoid_: Agent 声称、摘要、Artifact 本身、自动门禁结论

**Operation Attempt（操作尝试）**：
Provider 请求、工具调用或外部副作用执行前持久化的稳定意图记录，包含所属 Run、操作类型、目标、脱敏参数摘要与 replay policy；执行后另行关联 Outcome / Result。执行与结果落盘之间中断时保持 unknown，不能自动推断未执行或安全重放。
_Avoid_: Tool Result、Run State、自动重试许可、完整敏感参数日志

**Team Member Run（团队成员执行）**（历史目标态术语）：
ADR 0013 对团队成员一次临时执行的名称。新模型统一使用 Agent Run；历史文档中的 Team Member Run 仍按当时定义理解，不建立第二种运行对象。
_Avoid_: 当前产品术语、Agent Profile、Task

**Skill（技能）**：
由 D Code 管理、用于说明“如何完成某类工作”的版本化指令资源。Skill 可以从 Pi 或其他来源导入，也可以由 D Code 原生创建；它本身不授予工具、文件、网络或凭据权限，也不成为独立 Agent。
_Avoid_: Permission Grant、云端插件市场、Team Member

**Model Catalog（模型目录）**：
D Code Product Store 对已接入 Provider、可用 Model、非敏感能力元数据和未来 Runtime 选择的原生产品权威。Pi 或其他 Runtime 只可以在首次迁入 / 受控发现时提供安全目录事实；它们不再是 D Code 可写设置、目录身份或界面语义的长期权威。
_Avoid_: Pi Model Catalog、Pi `models.json` 权威、供应商官网镜像、静态模型白名单

**Credential Reference（凭据安全引用）**：
Product Store 对某个 Provider 已配置凭据的安全、不可逆引用，记录 Keychain、环境或外部 Runtime Auth Bridge（认证桥）的类型、定位符、配置状态和可选来源摘要，但永不保存 API Key、OAuth Token、认证文件正文或交互输入值。引用缺失或失效时 D Code 显示需要认证，不能用空成功或 Pi 配置副本伪装可运行。
_Avoid_: API Key 文本、`auth.json` 镜像、IPC 密码框、Provider 配置正文

**Runtime Model Selection（未来运行模型选择）**：
D Code Product Store 为未来 Coordinator / Agent Runtime 保存的 Provider / Model 对。它在 Runtime 启动时与 D Code Model Catalog、Credential Reference 一起校验，再显式应用到 Runtime Adapter；修改它不会回写 Pi `settings.json`、改写历史 Run 或热改已经运行的模型。
_Avoid_: Pi 默认模型、当前 Session 临时切换、Agent Profile 身份、凭据设置

**Enabled Model（已启用模型）**：
由 D Code 模型资源设置允许进入 Composer、Agent Profile 与运行路由选择范围的模型。“未启用”只表示不进入新选择范围，不代表供应商认证失效、模型不存在或历史运行事实被撤销。
_Avoid_: 禁用供应商、模型权限、认证状态

**Custom Model Provider（自定义模型供应商）**：
通过 D Code 原生 Provider 合同定义的模型供应商和模型集合。D Code 拥有目录、未来运行选择和认证状态语义，但不得在普通界面、会话、日志、模型上下文或 IPC 中展示 / 接收凭据正文；Pi 等 Runtime 只消费运行所需的安全凭据引用。
_Avoid_: Pi `models.json` 可写入口、任意 API 代理、凭据正文、IPC API Key

**D Code Capability Module（D Code 自有能力模块）**：
D Code 为一个明确用户结果拥有的统一实现单位，可以贡献结构化工具、Host（宿主）服务、状态事件、存储与原生呈现。Capability Module 在架构上可以独立装配，但产品上仍必须归入 Basic Capability、Extension Capability、Capability Provider 或普通 Skill / 工具；只有真实注册进 Agent Loop 的结构化工具才可由模型调用。
_Avoid_: Pi 拓展包镜像、第二 Agent Runtime、提示词工具、无产品归属的插件

**D Code Capability Registry（D Code 能力注册表）**：
D Code 对可装配 Capability Module 及各 Runtime / 扩展 / Provider 工具适配定义的运行时注册权威。模型可调用条目以同一份 canonical definition 提供名称、canonical model-facing description、输入 schema、执行器、可选使用规则、来源和版本；可选规则不得扩大 schema 与执行器实际能力。Runtime Adapter 经最终过滤冻结 Active Tool Set，再同时生成 API Tools 与 Active Tool Manifest。它不拥有 Project、Task 或 Agent Loop。
_Avoid_: 第二 Agent Runtime、Prompt 工具列表、拓展市场、产品导航

**Basic Capability（基础能力）**：
默认随 D Code 提供、定义项目—任务—会话—Agent 运行主干或所有能力共同依赖合同的能力。它可以按模块独立实现和测试，但不能作为普通拓展卸载；正常用户不需要理解其内部模块来源。
_Avoid_: 可选拓展、Pi 内置功能镜像、所有任务每次都必须调用

**Extension Capability（拓展能力）**：
可选安装或启用、只服务部分任务并拥有独立生命周期的 D Code 能力，通常还具有外部账户、网络、系统权限、持久对象或独立额度。安装后仍须遵守 D Code 的原生界面、Agent 操作、权限、错误、恢复和卸载合同。
_Avoid_: Pi Extension 直连、普通 Skill、无状态工具按钮

**First-class Capability（一等能力）**：
拥有稳定产品名称、结构化状态、明确生命周期、原生呈现、Agent 接口和可引用结果的能力。它描述集成质量，不描述是否必装；Basic Capability 与 Extension Capability 都可以是一等能力。
_Avoid_: 必装能力、一级导航、只有工具 schema 的能力

**Capability Provider（能力提供方）**：
为一项 D Code 能力提供具体模型、网络服务、凭据路径、本机命令或传输实现的内部单元。Provider 可以独立失败和替换，但不直接拥有产品名称、导航、Task 状态或用户数据语义。
_Avoid_: Extension Capability、模型产品入口、任务插件

**Pi Extension Source（Pi 拓展来源）**：
曾在 Pi 中验证某项工作方法、状态或运行机制、可供 D Code 吸收或迁移的历史来源。D Code 不把它作为 Goal、Agent Team 等原生能力的运行时依赖；旧名称只用于来源追溯、旧数据读取与兼容诊断。
_Avoid_: D Code 拓展、运行时桥接、产品品牌

**Selection Prompt（选择提问）**：
D Code 统一收集少量互斥或可多选用户决定的原生交互能力，支持完整提交或整体取消。它服务任务对齐、Agent Request、外部账户授权与拓展设置，不负责决定该问什么，也不成为独立工作对象。
_Avoid_: 问卷系统、任意表单、dask

**Model Resources（模型资源）**：
D Code 对可用模型、供应商、推理能力、额度、重置时间、速度策略、凭据可用状态和路由事实的结构化投影。产品合同属于 D Code，具体查询、凭据池和请求修改由 Capability Provider 实现；未知或不稳定字段必须明确降级。
_Avoid_: dusage、模型排行榜、凭据正文、静态模型白名单

**Work Insights（工作洞察）**：
从 D Code 的 Project、Task、Session、Agent Run、工具、错误、用量和 Evidence 等结构化事实生成的统计、分析与报告型 Extension Capability。工作日报是其一种按日叙事，不从会话文案猜测任务完成，也不成为新的任务状态源。
_Avoid_: 独立 pi-daily、任务看板、自动绩效判断

**Attention and Notification（关注与通知）**：
根据 Task 或 Agent Run 的待决定、待批准、失败、阻塞和后台完成等真实事件形成 User Attention，并按用户设置发送系统通知的 Basic Capability。它不在每次模型回复后提醒，也不拥有任务命名或完成判断。
_Avoid_: pi-alert、普通未读消息、执行状态

**Safe File Operations（安全文件操作）**：
D Code 为读取、搜索、编辑和创建项目文件拥有的 Basic Capability，要求基于已见内容或版本检查避免陈旧写入、歧义定位和并发覆盖，并把实际文件变化与证据返回所属 Task。底层工具可以替换，产品合同和原生呈现归 D Code。
_Avoid_: dhashline 品牌、任意覆盖写入、Git 快照

**Declared Capability Scope（声明能力范围）**：
Task、Agent Profile 或 Agent Run 为调度、隔离工作目录、结果核对与验收记录的预期工具集合和声明写入范围。它是任务合同，不是 D Code 运行时 Permission Grant、权限卡或操作系统沙箱；当前工具执行按 ADR 0023 固定完全访问。
_Avoid_: Permission Policy、Effective Grant、技术权限边界、永久凭据

**User Attention（用户关注态）**：
与工作对象和 Run State 分开表达的用户关注事实，例如需要确认计划、回答问题、验收结果，或尚未查看某个稳定 Session Run 的新完成结果。关注态可以在执行完成后继续存在，但不能把执行失败、Worker waiting 或普通未读消息当成同义词。
_Avoid_: 执行状态、Worker waiting、普通未读消息

**Cross-Session Message（跨会话消息）**：
D Code 在两个 Task Session 或 Child Agent Session 之间保存的持久、定向、有界交接对象，具有稳定消息身份、所属 Task、来源、目标、送达与恢复状态。它不伪装成普通用户消息，接收会话或协调 Agent 自己决定是否纳入后续上下文；同一 Task 内交接也不共享会话内存。
_Avoid_: Worker P2P、共享会话内存、运行中热迁移

**Session Takeover（打开即接管）**：
旧版 D Code 打开既有 Pi Session 时抢占 JSONL 写入权的实现术语。D Code 原生会话权威成立后，该产品概念退出；并发写入由 Product Store 与具体 Run 所有权管理，不再与 Pi CLI 抢同一文件。
_Avoid_: 当前会话打开语义、D Code 原生租约

**Write Intent（写入意图）**（历史）：
`0.0.8` 及之前用于表达写入 Pi Session 意图的产品语义；ADR 0018 后曾由“打开即接管”取代，ADR 0037 又将会话权威迁回 D Code。它只用于理解历史协议，不定义当前产品输入或所有权。
_Avoid_: 默认接管、同步多写

**Session Lease（会话租约）**（历史实现术语）：
旧版 Host 为防止多个 D Code 实例并发改写同一 Pi JSONL 建立的临时所有权声明。目标架构仍要求单写入与结果诚实，但不保留抢占外部 Pi 会话文件的产品语义。
_Avoid_: D Code Product Store 事务、当前会话身份

**Active Plan（活动 Plan）**：
当前 Task 正在使用、仍需执行或等待推进的 Plan 紧凑投影。Task 可以跨多个 Session 继续同一 Plan；旧 Pi Session 中的 dgoal 结构化状态只作为兼容来源，产品合同不由该扩展拥有。
_Avoid_: dgoal 面板、永久路线图、会话唯一计划

**Session Run（会话运行轮）**：
D Code 接受一次非空 Prompt 后，在一个 Task Session 中产生的一轮会话执行；使用 D Code Prompt ID 作为稳定 Run ID，并可关联持久化用户条目与所属 Task。Session Run 不能被 Pi Turn、工具调用、Task 或 Agent Run 替代；一个 Agent Run 可以跨一个或多个 Session Run 形成可见执行过程。
_Avoid_: Pi Turn、工具步骤、Task、Agent Run

**Self-build Candidate（自构建候选）**：
由明确 D Code 源码 checkout 经固定自动门禁生成、带 Candidate Manifest 与本机签名的可替换 App。它可以包含未提交改动，但始终是 Local-only，不等于人工验收、commit、tag 或发布。
_Avoid_: Release Build、已验收版本、模型完成声明

**Self-evolution Run（自进化运行）**：
D Code Harness 持有的一次耐久运行回执，串联发起 Task、D Code Session、实际模型、可选 Active Plan 与 Candidate Manifest，并记录重启、启动、会话恢复、人工验收或回滚状态。它只保存身份引用和有界摘要，不复制这些对象的正文。
_Avoid_: Self-build Candidate、Goal 数据库、发布流水线

**Creation Mode（全局创造模式）**：
D Code 只为开发和自进化 D Code 自身提供的全局产品模式。它把当前产品带入 D Code 源码 Project、相关 Task、能力开发、自构建候选、重启恢复、人工验收与回滚闭环；它不是权限档位，也不用于普通项目。
_Avoid_: 开发者权限模式、任意项目能力模式、热迁移

**Bootstrap Receipt（引导回执）**：
`v0.0.26 → v0.0.27` 因旧版没有 Full Preflight 能力而在新 App 恢复后补建的受限回执。它可证明候选来源、App 启动与 Session 恢复，但没有重启前检查，永不计入三次完整自进化循环。
_Avoid_: Full Receipt、第 1/3 次完整循环、追溯补证

**Full Receipt（完整回执）**：
由运行中的 `0.0.27+` 在候选交换前写入 `restart_requested`，并经目标 manifest、新 App、Host 与同一 Session 恢复核对后形成的自进化回执。只有用户显式人工验收后才计入连续门禁；仍不等于发布。
_Avoid_: Bootstrap Receipt、自动验收、Release

**Session Change Ledger（会话变更账本）**：
D Code 按稳定 D Code Session ID 持久化的已确认文件变更元数据集合；记录 Run、工具调用、文件、动作、首个变更行与增删行，不保存源码正文或完整补丁。它是覆盖可能不完整的派生投影，不是会话历史、Git 或工作区文件的第二权威。
_Avoid_: Git diff、完整审计日志、源码快照

**Change Coverage（变更覆盖度）**：
D Code 对会话变更来源能够证明到什么程度。首版“结构化工具已确认”只证明被观察到的兼容 `edit` / `write`，不能外推为 Bash、外部编辑器、旧历史或整个工作目录的完整归因。
_Avoid_: 全部变更、Git 净变化

**Artifact（产物）**：
由一次消息、工具或能力操作产生的不可变内容快照，例如 Mermaid、原型、文档、图片或 Diff。
_Avoid_: 可覆盖附件、桌面缓存

**Pinned Artifact（固定产物）**：
从原会话引用并提升到项目入口的特定 Artifact；固定不复制或改变原 Artifact。
_Avoid_: 资产副本

**Native Surface（原生呈现面）**：
桌面端根据结构化语义提供的 macOS 交互界面，而非对终端字符画面的截图或解析结果。
_Avoid_: TUI 皮肤

**Pi Host（Pi 宿主）**：
旧版 D Code 嵌入 Pi SDK、加载 Pi 配置与会话的本地运行组件名。目标架构将其收敛为 `Runtime Adapter（运行时适配器）`：消费 D Code 组装的运行输入并返回模型、工具和事件，不拥有产品会话、配置或界面。
_Avoid_: D Code 数据库、产品控制器、完整 Pi CLI

**Runtime Adapter（运行时适配器）**：
D Code Product Store、上下文组装与具体 Agent Runtime 之间的最小运行接缝。Pi SDK 是首个实现；适配器负责模型循环、工具执行和结构化事件转换，不拥有 D Code 的产品对象和耐久数据格式。
_Avoid_: 通用最低公分母 SDK、会话数据库、产品插件

**Runtime Supervisor（运行时监督器）**：
D Code Host 中按 Runtime / Task / Session / Agent Run 稳定身份管理多个 Runtime Adapter 实例的基础组件，负责并发上限、请求路由、生命周期、隔离、停止、事件归属与诚实恢复。它不拥有 Task 状态、模型身份或 Provider 实现，也不把消失的 Runtime 伪装成可恢复进程。
_Avoid_: 单一 active Session、Agent Team、任务数据库、常驻模型进程

**Unsupported UI Capability（不支持的界面能力）**：
Pi 扩展请求 `custom`、Widget 等依赖 TUI 的界面能力时，D Code 通过结构化事件明确阻止或忽略该操作；不会渲染终端帧，也不会返回虚假成功。
_Avoid_: Compatibility Fallback、静默忽略、伪原生适配
