# Pi Host

## 一句话定位

`host/` 是 `D Code` 的 Product Store、Runtime Supervisor 与 Node/Pi 适配边界：它通过版本化 JSONL 协议向客户端暴露 D Code 原生产品对象和多个 Pi Runtime，不把 Pi JSONL 当作产品权威。`@pi-dcode/host` 与 `pi-dcode-host` 继续作为内部兼容标识。

完整进程、协议与生命周期说明见 [Node/Pi 宿主与 IPC](../doc/10-架构与运行/0001-Node-Pi-宿主与-IPC.md)。

## 当前能力

- 默认使用本机架构，不引入远程 worker 或跨机器控制面。独立主进程按需启动、空闲回收后以新执行身份续接；辅助进程组单独登记，停止请求不立即释放目录占用，真实退出或未确认状态分别记录。
- 自动派发遵循每个成员的有序模型回退链，复用 `pi-dusage` 查询机制，验证启用、访问、能力和原始剩余比例；适用额度高于 1% 才可选用，未知/过期/低额度不冒充可用，不按余额重排。
- 本轮报告、输入完成状态和固定协调者通知在同一 SQLite 事务内保存。消息的 `completionReference` 标识处理它的运行，通知的 `resultReference` 标识被回传的成员运行与报告；两者不混用。保存未完成只显示保存中/未确认，不发送可靠完成通知；旧候选通知缺口在重启时幂等补齐并暂停，未保存的执行结果恢复为中断，不自动重做。

- `workspace.*` 仅访问已登记的项目、任务目录和产物；文件/资源读取与 Git 命令从拒绝符号链接的原生目录句柄开始。Markdown/HTML 保存校验原内容摘要，并与 Runtime 写入互斥；敏感路径不进入文件或 Git 展示，单文件产物不扩大父目录范围。

- 默认在当前用户 `~/.dcode/` 建立版本化 SQLite Product Store；使用独立进程租约、原子首次迁移、schema fingerprint、幂等 request ID、revision 冲突和中断恢复，损坏或未知 schema 不回退为空成功；
- 灵感正文、画布布局和编辑草稿由 `inspiration.ts` 校验，经 Product Store 的 `knowledge.inspiration` 记录保存；沿用 Schema 2。内容与位置分开修改，旧内容版本不能覆盖新编辑。媒体长期复制到 `~/.dcode/knowledge/inspiration/media/`，不参与对话附件到期清理；Markdown 导出为不可变版本文件，显式进入 Task 的 `global_knowledge` 上下文，归档不破坏历史引用。
- 原生拥有 User Scope / Project、Task、Coordination / Child Session、Session Path、Raw / Effective Input、Runtime Environment、Prompt Receipt、Team / Agent / Session Run、Operation Attempt、Agent Request、Report、Artifact 与 Evidence 投影；
- 外部 Pi Session 先预览、再经显式 `piImport.importAsTask` 单向导入；D Code 已管理的旧会话在首次晋升时自动接管，其他 Pi 会话不自动进入产品数据库；
- Runtime Supervisor 在本机按 Task / Session / Agent Run / Runtime 身份维护独立智能体进程；Host 仍负责工具副作用、Provider IO 和产品事实，进程就绪后还须完成本轮接收确认才开始模型循环；同一 Session 单写、workspace 写入冲突、12 个活动 Runtime 上限和 shared-read-only 工具证明均在启动前阻断；
- 每个交互任务由协调者承接，简单工作可直办，后台工作经 `dcode_team` 按需创建成员；成员可以独立执行、接受主对话提及或子对话输入，多名验收者和局部返工通过 `dcode_verification` 回收。旧 `team.create/start` 入口明确拒绝；成员完成、独立验收、协调复核和用户接受分别成立；
- `dcode_request` 原生工具把阻塞决定写成耐久 Agent Request，回答回到同一 Tool Result；回答或停止单个成员均携带完整身份、revision 和预写 Attempt，不影响其他 Runtime；
- 每个 Provider 请求使用 D Code 自有 System Prompt 与活动工具清单；Effective Input、Session Run、Prompt Receipt 和 Provider Attempt 在请求前同事务持久化，Pi 默认 Prompt 与外部扩展不进入显式 D Code Runtime；
- Tool Invocation 在执行前创建 Attempt，结果只以 digest 和有界 Evidence 入库；凭据形态在原生输入、导入、请求和 legacy 迁移边界被拒绝、脱敏或省略；

- Protocol v1 的请求、响应和事件信封；
- 请求参数最小运行时校验与结构化错误；
- 支持分片、连续多行、最大行长度和输出背压的 JSONL 传输；
- 有界会话发现：Recent 按有效 D Code 创建来源筛选，Project 按唯一项目目录的精确 `cwd` 查询；稳定 ID 快速解析、历史快照与 Active Plan 恢复；
- 可见会话全文搜索：独立 Worker 使用本机 SQLite FTS5 增量索引 D Code Recent 与已关联 Project 的标题、当前活动路径用户/助手正文；查询时重新强制可见范围，缓存损坏可重建，半写入条目会自动重试；
- 读取同一 Session 的真实终端路径，按选中 leaf 恢复快照与模型上下文，并以 `editUser`、`continueAssistant`、`continuePath` 在首条用户消息持久化时建立新路径；
- 将完整已持久化 Session 以新 ID、新 `cwd` 和源谱系复制到目标项目目录：隐藏暂存中逐行校验，源稳定后用 hard link 原子发布；归档 ID 在 Recent、Project 与 Search 的分页、排序和结果上限前排除；
- Project 目录迁移（`session.relocateCwd`，0.0.25）：在所有精确匹配 Session 空闲、租约稳定后原地改写 Header `cwd`，保留 Session ID、历史、JSONL 路径与谱系；目录内文件只在用户选择后移动，目标必须为空，不合并或覆盖；
- 在 Pi cwd-scoped 目录创建新会话，将 Header 与 D Code 创建来源标记一次写入初始 JSONL；该文档发布即为创建提交点并立即返回，不扫描全库、不取得新 Lease，也不等待旧 Runtime 关闭；App 再以独立打开请求切换并取得新会话所有权；
- 对空的 D Code 创建会话提供可恢复的 `session.trash`：唯一 ID 解析、D Code 来源、零消息、无子会话、非可写和 Lease 复核全部成立后才移入用户废纸篓；失败不回退为永久删除；
- 受控修复尾部不完整的会话 JSONL（`session.repair`，0.0.19）：仅当尾部恰好一条记录不完整且其余记录完整时可修；同目录完整备份 `.bak-<uuid>`、修剪后以严格读取器复验、原子替换，任一环节失败原文件零改动；`session.open` 的 `INVALID_SESSION` details 附 `repairable` / `repairReason`；
- 会话级 `promptId` / `steerId` 幂等登记（0.0.19）：同一 Host 进程的已见 ID 窗口（LRU 256）内重复提交返回 `SESSION_DUPLICATE_PROMPT` / `SESSION_DUPLICATE_STEER`；已见 ID 仅内存级，Host 重启后不跨进程成立；
- 通过 Pi SDK 持久修改当前 Session Name，同一名称供 Pi、D Code 左栏、搜索与窗口顶部使用；空名称恢复 Pi 的自动标题；
- 打开既有会话即以 `force` 取得 Session Lease 并成为唯一写入所有者；没有只读观察模式。外部写入或另一 D Code 实例抢占会触发明确冲突、停止当前运行并关闭失效所有权，草稿由 App 保留后可显式重新接管；
- 使用固定 Pi SDK 加载现有 settings、模型、会话、流式事件及可兼容的结构化扩展能力；
- 为 D Code 发起的 Prompt 保留稳定 Prompt ID，并在 `session.event` 中附带对应 `runId` / 已持久 Path Entry ID；`sessionRunCorrelation` 能力供 App 对后续消息做顺序门禁，原生输入与协作队列由 Product Store 维护，Pi 内部队列不代替耐久消息；
- 运行中可在 Host Run State 仍为 `running` 时使用 Pi 原生 steer 介入下一安全模型边界；它不替换 Run ID，也不伪装成立即中止工具；
- `session.prompt` / `session.steer` 可选 `images` 图片附件（0.0.20）：≤8 张、`image/*` MIME、单张 base64 ≤ 7,000,000 字符，经 Pi `PromptOptions.images` / `steer(text, images)` 进入模型输入；非法形态由协议校验拒绝；
- D Code 以 Product Store 的 Model Catalog（模型目录）、Credential Reference（凭据安全引用）和 Runtime Model Selection（未来运行模型选择）作为产品权威；Pi 认证与配置只可作为只读发现 / 外部安全引用来源，API Key、OAuth 值和认证响应不经 D Code IPC；
- 投影 Pi `resourceLoader` 真实加载的 Extension、Skill、Prompt 与 Command，按 Pi `SettingsManager.setPackages` 修改扩展包启停并热重载；D Code 自有隐藏扩展不进入用户清单；
- 在同一个 Pi Agent Loop 注册只读 `dcode_facts` facade：`changes`、`evidence`、`lineage` 与 `project` 均为生产合同；`project` 检查项目根目录的 `PRODUCT.md` / `DESIGN.md` 是否为普通文件，并列出根 `AGENTS.md`、根 `README.md` 与有界 `doc/**/*.md` 的分散依据路径。二者都缺失时明确说明“产品原则尚未独立沉淀”；只列路径，不读取内容、不从 Agent 总结生成假权威；
- `modelProviders.save / remove`、`modelSettings.set*` 与 `modelAuth.*` 是保留给旧 Protocol 的显式拒绝入口；D Code 不再改写 Pi `models.json` / `settings.json`，也不接受任何凭据正文或 Pi 认证响应；
- 为当前 D Code Run 中成功且具有已知结构化结果的 `edit` / `write` 投影有界 `session.changeRecorded` 元数据；不向 App 复制工具参数正文、源码或完整 patch，未知工具和失败结果不猜测；
- 返回 Pi SDK 的真实 Context Usage（上下文占用），并提供 D Code 自有、会话级持久化的极速模式；极速只为明确支持的 `openai-codex` 模型请求 `service_tier: priority`；
- SIGINT 与 SIGTERM 同走 graceful shutdown（清理活动会话、尾行合法 JSON、中断态如实报 `phase=unknown`，退出码均为 143）；
- 标准 `select`、`confirm`、`input`、`editor`、通知与状态使用结构化事件；TUI custom/widget 能力显式阻止或忽略；
- 通过精确固定的 `grok-mermaid` 提供原生 Unicode Mermaid 渲染，并对不支持的类型返回结构化失败；
- 临时目录自动测试覆盖快速创建、会话复制 / Project 目录迁移 / 废纸篓安全边界、路径、租约、搜索、Project / Recent、打开即接管、Run State、模型 / 认证、资源、自定义供应商、扩展与进程生命周期回归；测试全绿不替代跨 Swift / Host 的真实存储、完整 Protocol 组合与人工验收，精确证据和已知缺口见[版本实施方案](../doc/40-版本实施方案/README.md)。

## 命令

```bash
npm ci
npm test
npm run build
npm start -- --agent-dir ~/.pi/agent
```

## 目录

- `src/process-agent.ts` / `agent-process-*` / `process-agent-session.ts`：本机执行进程、就绪与接收握手、Pi 会话组合和回收续接。
- `src/auxiliary-process*`：工具辅助进程组、停止确认、恢复身份校验与目录占用。
- `src/model-quota.ts` / `model-route.ts` / `provider-route-stream.ts`：配额归一、有序候选与模型调用边界回退。
- `src/collaboration-*` / `verification-context.ts`：按需派发、消息来源、独立验收和复核；耐久状态与原子结果回传由 `product-store.ts` 拥有。
- `src/input-expansion.ts` / `runtime-privacy.ts`：提交原文、生效输入与资料回执分离，私有运行历史脱敏。

- `src/workspace-files.ts` / `workspace-access.ts` / `workspace-write-guard.ts`：文件/Git 协议、来源边界与编辑保存的写入保留。
- `native/WorkspaceFiles.swift` / `FileHelper.swift`：安全目录遍历、稳定读取、原子保存和有界 Git 读取；`scripts/build-native.mjs` 随 Host 构建生成 `dist/bin/dcode-files`，客户端打包一并携带。

- `src/protocol.ts`：Protocol v1 类型、解析、参数校验和信封构造。
- `src/product-store.ts` / `src/product-store-schema.ts`：D Code 原生产品数据库、事务、迁移、投影与恢复合同。
- `src/dcode-data-root.ts` / `src/product-store-lease.ts`：`~/.dcode/` 安全目录与 Product Store 单写入所有权。
- `src/legacy-migration.ts` / `src/pi-session-import.ts`：旧 D Code 资料晋升与外部 Pi Session 显式单向导入。
- `src/credential-material.ts` / `src/imported-history-projection.ts`：常见凭据形态的识别与正文脱敏，以及外部导入历史进入 Prompt 与 Product Store 的有界、脱敏投影。
- `src/prompt-assembler.ts`：D Code 身份、环境、一等项目文档来源与活动工具同源组装。
- `src/prompt-source-status.ts`：Prompt 来源文档的存在性、大小与 Git revision 状态快照，产出有界 Source Receipt。
- `src/agent-request-extension.ts` / `src/operation-attempt-extension.ts`：耐久输入请求与工具执行前置 Attempt。
- `src/jsonl.ts`：JSONL 解码与有序输出。
- `src/session-reader.ts`：安全会话扫描、快照和 Active Plan 恢复。
- `src/session-title.ts`：会话显示标题与有界预览文本。
- `src/session-copy.ts`：完整会话的有界流式校验、隐藏暂存与原子发布。
- `src/atomic-file.ts`：新文件的同目录暂存与 hard link 一次发布，不暴露半成品、拒绝替换既有目标。
- `src/project-directory-migration.ts`：Project 目录迁移的 Header `cwd` 原地改写、可选目录项移动与可恢复事务。
- `src/session-origin.ts`：D Code 创建来源标记的共享协议常量。
- `src/session-change.ts`：DHashline-compatible 工具结果到会话变更元数据的有界、安全投影。
- `src/session-search-index.ts`：搜索 Worker 生命周期、请求关联、失败恢复与缓存位置。
- `src/session-search-worker.ts`：可见范围发现、当前路径解析、SQLite FTS5 索引和查询。
- `src/search-entry-digest.ts`：可搜索消息的有界提取与摘要，供会话读取与搜索 Worker 复用。
- `src/dcode-fast.ts`：D Code 自有极速状态、会话持久化与 Provider Request 注入边界。
- `src/dcode-facts.ts`：在同一 Agent Loop 注册 D Code 独有事实的只读工具 facade。
- `src/resource-policy.ts`：在 Extension Factory（扩展工厂）执行前排除外部 `pi-dfast`，其余启用扩展仍交由固定 Pi SDK 加载。
- `src/resources.ts`：Pi 本机资源加载快照、扩展包启停影子清单与热重载。
- `src/model-providers.ts`：旧 Pi `models.json` 自定义供应商适配 / 只读发现逻辑；D Code 产品路径不调用其写入入口。
- `src/model-catalog-configuration.ts`：原生模型供应商目录配置的输入校验、种子与注册；凭据仅接受环境变量引用并沿用脱敏边界。
- `src/session-lease.ts`：会话租约、静默检查和外部写入检测。
- `src/extension-ui.ts`：标准结构化扩展 UI，以及 TUI 能力的显式 unsupported 边界。
- `src/model-auth.ts`：旧 Pi Provider 认证桥；D Code 产品 IPC 显式拒绝认证交互和认证正文。
- `src/managed-worker-worktree.ts`：Project Worker 受管 detached Git worktree 的创建、验证与 Artifact 记录。
- `src/maintenance.ts`：本机维护动作（候选检查 / 构建）的子进程执行、持久化状态与中断恢复回执。
- `src/pi-host.ts`：Pi SDK 会话生命周期与协议动作。
- `src/index.ts`：stdin/stdout Host 进程入口。
- `test/`：只使用临时写入范围的公开行为测试。

## 边界

- stdout 只允许协议 JSONL；诊断必须写 stderr。
- 不依赖全局 `pi` 命令，Pi 包版本必须精确固定。
- 不直接依赖或调用 `pi-tui`；它可以作为 `pi-coding-agent` 的私有传递依赖存在，但不能成为产品呈现路径。
- Session Lease 不能迫使不协作的旧客户端遵守租约；外部写入必须触发停止，不能静默续写。
- 不自动删除无法证明属于当前 owner 的租约。
- `host.hello.capabilities.onDemandWrite` 目前只是 Protocol v1 的遗留兼容键，不代表产品仍有“先观察、写时再取租约”的路径；当前行为以打开即接管为准，协议残留需另行清理。

## Web 客户端恢复接口（0.0.30 修复候选）

- `taskDraft.set`：按当前用户或项目作用域保存未创建任务的文字输入，使用已有 `composer_drafts` 表；不会预建 Task / Session。正文沿用长度与凭据拒绝边界。
- `clientPreferences.get/set`：读取 / 修改通知开关和按会话保存的阅读位置。只有 Host 写 `product_settings`，位置记录验证会话归属并最多保留 200 项。
- 以上均为 Protocol v1 的加法扩展，写入继续需要 requestId 与 Store revision。现有会话草稿仍使用 `dcodeSession.composerDraft.set`；工作台对象选择仍使用 `taskWorkbenchViewState.patch`。
- 回归见 `test/client-recovery.test.ts` 与 `../client/test/ui-flow.test.mjs`。


Web 设置恢复新增原生接口：`clientPreferences.get/set/importLegacy` 管理工作台偏好及旧界面偏好的单向继承；`dcodeModelProvider.save/remove` 管理原生供应商，显式接管只读旧来源的非敏感配置；`task.manage` 与会话复制入口保留产品历史。`maintenance.status/start` 和 `selfEvolution.*` 记录 Web 本机候选检查、构建和恢复回执，重启前检查所有运行活动。原生 SDK 会话使用内存 SettingsManager，模型与思考切换不回写 Pi 设置。核心凭据引用边界和资源安全策略不变。


模型路径（Pi 0.84.4）：`dcodeModels.get/refresh/select/setThinking` 是客户端模型控件的核心入口。目录及认证状态由核心投影，刷新使用 Pi 官方目录并保留原生配置；目录缓存位于 D Code Data Root 的 `models-cache.json`。已有 Runtime 切换前同步原生注册，模型/思考控制的重复请求不重新执行。视图不会接触凭据正文。


受管附件（0.0.30 修复候选）：`attachment.import/get/resolve` 由 Host 管理副本，`attachment-files.ts` 负责受控目录、原子文件、完整性校验与清理。草稿附件元数据使用现有 `composer_drafts.payload_json`；`taskDraft.set` / `dcodeSession.composerDraft.set` 可携带 `attachmentIds`，空文字但有附件时保留草稿。`dcodeSession.prompt` 只接收附件 ID，核心读取图片并生成文件引用，在 `prepareSessionRun` 同事务内写原文、引用、生效输入及附件 Artifact。Schema 仍为 2，附件输入不混入交付物列表。

副本位于 `.dcode/tmp/attachments/<id>/`，未发送时 24 小时过期，持久提交后延至至少 30 天；再次提交可延长。应用启动及每小时检查到期项，关闭期间在下次启动补清理。不可变 manifest 只用于识别失败恢复和解绑孤儿，不保存可变发送状态。过期后保留消息/登记，只清副本；不删除源文件、Pi 私有历史内联图片或已记录的工具内容。单个缓存损坏隔离保留，不阻断其他会话。

附件限制在写入前校验：图片最多 8 张、单图 5 MB、全部附件最多 32 个、单文件 50 MB、暂存总量 500 MB（计入孤儿）。凭据文件和可识别文本中的凭据拒绝保存。预览仅由核心验证登记 ID 后给壳调用 macOS Quick Look（快速查看），不允许渲染层指定任意预览路径。未发送附件存在时，切换到不支持附件草稿的旧候选会被拒绝。
