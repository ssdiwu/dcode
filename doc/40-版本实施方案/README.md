# 版本实施方案

本目录保存已经确认、用于指导当前版本交付与验收的 PRD 和专项规格，也是发布、实现候选、本地回归基线、人工验收与持续回归状态的唯一文档索引。具体测试与人工证据保留在对应 PRD 的 Verification Record（验证记录）中，其他 README 只链接本页，不复制动态状态。文档完成后只要仍是有效验收基准，就继续保留在本目录；仅在被取代、放弃或只供追溯时归档。

> Target reset（目标架构重置）：ADR 0035–0040 已确认 User Scope / Project Scope → Task 主干、`~/.dcode/` 原生产品数据权威、Pi 单向导入、全局创造模式、一等项目文档以及 D Code System Prompt / Active Tool Set 边界。版本顺序固定为 `0.0.28` 先交付 Product Store、原生 Task / Session / Run、多 Runtime、Coordinator / Child Agent 与 Prompt / Tool 等基础设施；`0.0.29` 再消费这些真实事实完成任务工作台 UI/UX。`0.0.29` 曾形成 Implementation Candidate（实现候选）：`0.0.28` 基础设施继续作为同一 Product Store 合同被消费。2026-09-05 版本重切（507 确认）：`0.0.29` 候选在自动门禁全绿后收口为基线（`main@714a555`），HUD 浮窗形态的完整人工验收与 tag 取消；后续顺序为 `0.0.30` Web 客户端初版（三区布局合同与技术栈验证，[ADR 0044](../决策档案/0044-Web客户端与桌面壳技术栈边界.md)）、`0.0.31` 任务内自适应协作；507 于 2026-09-08 将 `0.0.32` 确认为工作台 UI/UX 升级，多目录项目改为后续待排期。切割纪律与完成信号见[版本界面演进](../20-产品与交互/原型/版本演进/README.md)。

`0.0.17`（`837af03`）、`0.0.18`（`617249e`）、`0.0.19`（`8f0c319`）与 `0.0.20` 已进入 `main`；`0.0.25`、`0.0.26`、`0.0.27` 已分别形成公开源码标签。`v0.0.27` 保留为历史发布标签，其实现提交为 `8403710`。`0.0.30` Web 工作台与灵感的基础验收已于 2026-09-07 通过，源码推送状态以 Git 为准。当前 Host manifest 为 `0.0.29`、客户端为 `0.0.30`；旧 Swift App manifest 随退役移除，源码批次不自动调整发布版本；本轮最终自动门禁结果与 revision 记录在各 PRD 的 Verification Record（验证记录）中。`0.0.28` 的结构化并行、导入续接、模型目录、D Code Session Presentation、Plan / Work List 与 Product Store 状态，已由 `0.0.29` 的 Project → Task → 任务对话 / Child Session、常驻 Task HUD、交付物内容区和 Information Inspector 直接消费。它不等于干净 App 候选、真实已认证 Provider 交接、原生界面人工验收、tag、GitHub Release、签名分发或发布。

### 当前已知缺口

此前记录的四项缺口已全部收口：`modelOverrides.<model>.headers` 凭据正文不再进入 Swift（0.0.16 审计 P1，40e02b9 修复、0.0.17 补嵌套脱敏断言）；搜索正文命中打开不再携带被 Protocol v1 拒绝的 `expectedEntryDigest`（40e02b9 修复、0.0.17 加回归钉子并删除误导审计的死代码）；`dcode_facts` 的 `evidence` / `project` 合同已对齐 Swift 真实存储（40e02b9 修复文件名与形状，0.0.17 再修 `changes.source` 枚举、project 符号链接归属并落地 golden fixture）；`host/package-lock.json` 版本已回补并随 `0.0.17` 提版保持一致。当前剩余边界以各 PRD 未勾选项为准，其中仍包含真实认证交接、真实用户迁移、干净候选和原生人工验收，不得概括成“只剩界面”。

`0.0.13 → 0.0.20+ → 0.1.0` 的已确认顺序、逐版差异和“连续自构建后才晋升”的门禁见[版本界面演进](../20-产品与交互/原型/版本演进/README.md)。该路线允许按真实 dogfood 缺口继续增加 `0.0.x`。

| 文档 | Source（源码） | Acceptance（验收） | 职责 |
|---|---|---|---|
| [0030-0.0.32 工作台 UI/UX 产品需求](0030-工作台-UI-UX-并行候选.md) | 行内 API 修复 `1f312eb` 已交独立候选；输入栏入口整合 `bf7e661` 已本地提交并通过自动验证与独立审查，待新候选验收；各批证据与实际构建版本见该文档 | 目标 0.0.32，未定版、未整体人工验收、未合并或发布 | 新任务与主题、输入反馈、共享动效、技能浮层、行内 API 连接与既有 OAuth、可设置配额门槛；项目归属收进输入卡底部、技能入口进入“＋”。固定 0.0.31 验收基线不替换，多目录项目后续待排期。 |
| [0029-0.0.31 任务内自适应协作产品需求](0029-任务内自适应协作产品需求.md) | 隔离实现分批本地提交：文件 `24149a1`、协作 `d536846`、项目维护 `c1f5f31`、SDK `18e12df`；退役已本地提交 `6d32079`；真实组合走查与运行中来源修复见 PRD 第 6 批 | 分批自动检查与审查通过，真实模型组合已到用户验收边界；物理拖拽及 0.0.31 人工验收未完成 | 模型可用性与配额感知筛选、协调者自主派发、多成员、主对话提及及子对话、验收返工、独立主执行进程与回收续接；直接任务与灵感引用任务共用同一协作能力。 |
| [0028-0.0.30 Web 客户端初版产品需求](0028-0.0.30-Web客户端初版产品需求.md) | 基础工作台与灵感源码基线，[ADR 0044](../决策档案/0044-Web客户端与桌面壳技术栈边界.md) 已 Accepted | 507 于 2026-09-07 确认基础功能验收通过；机器验证与迁移遗留见 PRD | Electron + React 工作台、完整设置、消息附件、灵感保存与任务引用、画布工具和阅读布局；迁移遗留的实现与验收由 0029 分批承接。 |
| [0027-0.0.29 任务工作台与协调者协作体验产品需求](0027-0.0.29-任务工作台与协调者协作体验产品需求.md) | Baseline `main@714a555`（2026-09-05 收口，不再单独走 HUD 人工验收） | Host `225/225` + Swift `346/346`；HUD 浮窗形态人工验收取消，布局合同移交 `0.0.30` | 以 Project / Task 主干呈现协调者任务对话、Child Session、常驻 Task HUD、交付物内容区和具体对象 Inspector；其界面布局结论由 `0.0.30` 重审。 |
| [0026-0.0.28 D Code 原生产品数据与多会话运行基础设施产品需求](0026-0.0.28-D-Code-原生产品数据与多会话运行基础设施产品需求.md) | Implementation Candidate consumed by `0.0.29` | Host `222/222` + Swift `344/344`；Native Manual / Real Auth / Clean Candidate Pending | Product Store、旧资料晋升、原生 Task / Session / Run、Pi 单向导入、多 Runtime、Coordinator 两阶段协作、D Code Prompt / Tools、Attempt / Request 与 Foundation contract 已接通；schema 不支持降级到 0.0.27。 |
| [0025-0.0.27 Composer 模型选择与原生能力菜单修正产品需求](0025-0.0.27-Composer-模型选择与原生能力菜单修正产品需求.md) | Published Source Tag `v0.0.27`（implementation `8403710`） | Automated / Candidate + Cmd-V Isolated QA Passed；Native Menu / VoiceOver / Appearance Manual Pending | 恢复独立模型名选择，把 `+` 改为紧凑原生 Menu，Skill 显示普通名称，并接通剪贴板图片附件。 |
| [0024-0.0.27 自进化运行回执与安全恢复产品需求](0024-0.0.27-自进化运行回执与安全恢复产品需求.md) | Published Source Tag `v0.0.27`（implementation `8403710`） | Automated / Candidate / Web Eval Passed；Native Manual Pending | 自进化运行身份、Bootstrap / Full Assurance、重启恢复回执、人工验收与连续门禁。 |
| [0023-0.0.26 Sol 自迭代候选闭环产品需求](0023-0.0.26-Sol-自迭代候选闭环产品需求.md) | Published Source Tag `v0.0.26` | Automated / Web Eval Passed；Native Manual Pending | 动态源码 checkout、脏工作树本机候选、测试门禁、候选来源清单与重启后核对。 |
| [0022-0.0.25 项目目录迁移与 Composer 收口产品需求](0022-0.0.25-项目目录迁移与-Composer-收口产品需求.md) | Published Source Tag `v0.0.25` | Automated Passed；Manual Pending | Project 与目录一一对应、保持 Session ID 的 `cwd` 迁移、文件迁移二次选择，以及 Composer 的项目优先与能力入口收口。 |
| [0021-0.0.20 Composer 命令面板与附件产品需求](0021-0.0.20-Composer-命令面板与附件产品需求.md) | Committed `main`（tag 待人工验收后打） | Automated Passed；Manual Pending |
| [人工验收 0.0.17–0.0.20 用户路径清单](人工验收-0.0.17-0.0.20-用户路径清单.md) | —（验收辅助，非 PRD） | 面向用户路径的走查清单：输入与附件 / Markdown / HTML / 恢复 / 版本一致性；结论回填各 PRD 的人工验收项。 | 统一 `/` 面板（扩展命令 / 命令 / Skill / 模板混排 + 类型标注 + 悬停描述）、`+` 附件入口（图片经协议 `images` 进入模型输入、文件插入路径引用）与扩展就绪横幅降噪（ADR 0028）的验收权威。 |
| [0020-0.0.19 失败与恢复加固产品需求](0020-0.0.19-失败与恢复加固产品需求.md) | Committed `main@8f0c319`（tag 待人工验收后打） | Automated Passed；Manual Pending | 中断三态辨认与恢复入口（ADR 0027）：Host 重连、半条 JSONL 受控修复、promptId/steerId 幂等、store 熔断可见化与显式重试、恢复链路去静默的验收权威。 |
| [0019-0.0.18 HTML 编辑缓冲区与隔离即时预览产品需求](0019-0.0.18-HTML-编辑缓冲区与隔离即时预览产品需求.md) | Committed `main@617249e`（tag 待人工验收后打） | Automated Passed；Manual Pending | HTML 编辑（复用 ADR 0025 缓冲区）、隔离 WKWebView 即时预览与网络询问边界（ADR 0026）验收权威。 |
| [0018-0.0.17 Markdown 编辑缓冲区与安全保存产品需求](0018-0.0.17-Markdown-编辑缓冲区与安全保存产品需求.md) | Committed `main@837af03`（tag 待人工验收后打） | Automated Passed；Manual Pending | Markdown 编辑缓冲区、Source / Preview 切换与安全保存（ADR 0025）验收权威；同时收口 0.0.16 三项审计缺口、`dcode_facts` 残留与 `models.json` 并发写入收紧。 |
| [0017-0.0.16 自定义模型供应商与一次性资源调用产品需求](0017-0.0.16-自定义模型供应商与一次性资源调用产品需求.md) | Published Source Tag `v0.0.16` | Automated Passed；Manual Pending；0.0.17 收口审计缺口 | Pi `models.json` 自定义供应商管理与 Composer `+` 一次性资源调用验收权威；审计发现的 argumentHint / 删除刷新 / 嵌套 headers 缺口与并发写入已在 0.0.17 收口。 |
| [0016-0.0.15 界面即上下文与本机资源产品需求](0016-0.0.15-界面即上下文与本机资源产品需求.md) | Published Source Tag `v0.0.15` | Automated Passed；Manual Pending；facade 合同 0.0.17 收口 | Composer 预填、压缩可见性、本机资源页、扩展包启停、`dcode_facts`、文件树键盘与性能收口验收权威；facade 两类生产合同的不一致已在 0.0.17 修复并落地 golden fixture。 |
| [0015-0.0.14 主页落地 Composer 与界面收口产品需求](0015-0.0.14-主页落地-Composer-与界面收口产品需求.md) | Published Source Tag `v0.0.14` | Automated Passed；Manual Pending | 主页会话前草稿、会话打开加载态、⌘N、发送按钮与字号收口、Host 诊断页及 ADR 0023 固定完全访问验收权威。 |
| [0014-0.0.13 第一次 Self-build Loop 产品需求](0014-0.0.13-第一次-Self-build-Loop-产品需求.md) | Published Source Tag `v0.0.13` | Automated Passed；Core Manual Loop Pending | 候选构建隔离、受控替换 / 回滚 / 重启恢复与第一次真实闭环验收权威。 |
| [0013-0.0.12 结构化验证证据产品需求](0013-0.0.12-结构化验证证据产品需求.md) | Published Source Tag `v0.0.12` | Automated Passed；Manual Pending | bash 执行证据账本、退出推导、revision 补全、会话检查器呈现与非门禁边界权威。 |
| [0012-0.0.11 只读 Exact Git Diff 产品需求](0012-0.0.11-只读-Exact-Git-Diff-产品需求.md) | Published Source Tag `v0.0.11` | Automated Passed；Manual Pending | 逐文件 / 逐 hunk 行级 Git 差异、staged / unstaged 分流、诚实截断与只读边界权威。 |
| [0011-0.0.10 Project Trust 与动作级权限产品需求](0011-0.0.10-Project-Trust-与动作级权限产品需求.md) | Published Historical Tag `v0.0.10` | Superseded（ADR 0023）；历史未验项 N/A | 保留当时的权限闸门、授权语义、权限卡与审计记录；机制已于 `0.0.14` 整体移除，仅作历史追溯。 |
| [0010-0.0.9 打开即接管产品需求](0010-0.0.9-打开即接管产品需求.md) | Published Source Tag `v0.0.9` | Automated Passed；Manual Pending；Search Regression | 打开即接管、租约抢占、冲突卡重接、只读观察删除与性能收口权威；搜索正文命中打开的当前回归另见已知缺口。 |
| [0009-0.0.8 AppModel 域拆分与测试基线产品需求](0009-0.0.8-AppModel-域拆分与测试基线产品需求.md) | Published Source Tag `v0.0.8` | Automated Passed；Manual Pending | AppModel 领域子模型、`HostProviding` 注入、Fake-host 集成测试、dgoal 融入与上下文构成验收权威。 |
| [0008-0.0.7 模型设置与回复运行信息产品需求](0008-0.0.7-模型设置与回复运行信息产品需求.md) | Published Source Tag `v0.0.7` | Automated Passed；Manual Pending | 已认证 Pi 模型目录、Provider 关联、全局选择设置、steer / queue、Context / Thinking / 轮次导航与回复运行信息权威。 |
| [0007-0.0.6 活动视图与运行状态产品需求](0007-0.0.6-活动视图与运行状态产品需求.md) | Published Source Tag `v0.0.6` | Automated Passed；Manual Pending | Activity View、可靠 Run State、完成关注态、Interaction Dock、会话前模型选择与 Context 圆环权威。 |
| [0006-0.0.5 后续消息队列产品需求](0006-0.0.5-后续消息队列产品需求.md) | Published Source Tag `v0.0.5` | Automated Passed；Manual Pending | 后续消息队列、新会话延迟创建、Composer 焦点与左右栏宽度收口权威。 |
| [0005-0.0.4 Workspace Tab 与只读文件预览产品需求](0005-0.0.4-工作区标签与只读文件预览产品需求.md) | Published Source Tag `v0.0.4` | Automated Passed；Manual Pending | 唯一会话主页面、按需文件标签、受限只读文件预览、置顶区与会话级摘要权威。 |
| [0004-0.0.3 会话路径与复制归档产品需求](0004-0.0.3-会话路径与复制归档产品需求.md) | Published Regression Tag `v0.0.3` | Automated Passed；Manual Pending | 路径草稿、完整会话复制、直接归档、置顶、轮次级会话与 Markdown 呈现权威。 |
| [0003-0.0.2 可见会话搜索产品需求](0003-0.0.2-可见会话搜索产品需求.md) | Published Regression Tag `v0.0.2` | Historical Automated Passed；Manual Pending；Current Regression | 可见范围、全文搜索、筛选与定位权威；当前正文命中打开回归另见已知缺口。 |
| [0002-0.0.1 用户首页与项目工作台产品需求](0002-0.0.1-用户首页与项目工作台产品需求.md) | Released Source `v0.0.1` | Recorded Acceptance | `v0.0.1` 的范围、验收记录与持续回归基准。 |
| [0001-首个可日常使用版本产品需求](0001-首个可日常使用版本产品需求.md) | Historical Baseline | Selective Regression | 只保留 Pi 会话权威、原生聊天 / 结构化呈现、安全与 App 生命周期约束；观察态、按需写入与 Write Intent 条款已由 ADR 0018 取代。 |
