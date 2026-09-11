# Node/Pi 宿主与 IPC

状态：Current Implementation Authority（当前实现权威；动态版本、自动验证、人工验收与已知缺口由[版本实施方案](../40-版本实施方案/README.md)统一记录）

## 职责

`host/` 是客户端唯一允许写入 D Code Product Store、启动 Runtime Adapter 和执行外部副作用的运行边界。它使用项目内精确固定的 Pi 0.85.1 提供 Agent Loop，但 Project / Task / D Code Session / Run / Prompt Receipt / Attempt 等产品事实进入 `~/.dcode/`，不以 Pi JSONL 作为产品数据库，也不调用全局 `pi` 命令。

客户端负责呈现与用户输入；Host 负责：

- 初始化、迁移、校验和单写入持有 `~/.dcode/product-store.sqlite3`；schema v1 晋升 v2 时先在 `~/.dcode/migrations/` 写入私有 SQLite 前备份，再原子补齐 Task Context Selection，不支持降级或双写；
- 以 User Scope / Project Scope → Task → Coordination / Child Session → Team / Agent / Session Run 的稳定身份执行 query 与 mutation；
- 原生持久化 Task Plan 与 Work List：Plan 激活保留 superseded 历史，Work Item 的状态、归属、详情与顺序通过 revision / request ID mutation 维护，重排在单一 SQLite 事务中避免 ordinal 唯一约束冲突；
- 管理最多 12 个显式 Runtime，拒绝同一 D Code Session 的第二写入者与不安全 workspace 共享；非 Worker Runtime 的 cwd 必须精确等于 Task Scope，可独立执行的干净 Git 项目在 Host 预写 Attempt 后使用验证过的工作树；User Scope、普通目录或脏仓库保留原目录并串行写入，不复制用户目录或自动提交；
- 支持 Coordinator 自主派发成员、持续主子沟通、独立验收与局部返工，结果回流同一任务；
- 在 Provider / Tool / Stop 副作用之前写 Operation Attempt，在崩溃后保留 unknown 且不自动重放；
- 组装并安装 D Code System Prompt、Agent Role 与真实 Active Tool Manifest；强制加载运行目录 `AGENTS.md`，其余项目文档和 Global Knowledge 只能来自 Task 的显式、带 revision Context Selection；导入 Pi 会话只从 Product Store 当前路径生成有界、二次脱敏的 Imported History Projection（导入历史投影），不倒填 Raw / Effective Input、重读或写回源 JSONL；失效选择或损坏的导入投影在 Pi Session / Provider 副作用前拒绝；
- 预览并显式单向导入外部 Pi Session，首次晋升时只自动接管带有效 D Code origin 的旧会话；
- 发现、解析和恢复 Pi Session；
- 按有效 D Code 创建来源查询 Recent Session Summary，或按 Project 的唯一项目目录精确 `cwd` 查询全部关联 Session Summary；
- 在独立 Worker 中为上述可见会话建立可删除、可重建的 SQLite FTS5 本机索引，并搜索标题与当前活动路径的用户/助手正文；
- 读取同一 Pi Session 的真实路径谱系，并在用户第一次发送时按明确路径动作切换 Agent 上下文；
- 把完整已持久化 Session 以新 ID、新 `cwd` 和源谱系有界复制到目标项目目录，经隐藏暂存、严格验证后原子发布；
- 在列表分页与搜索排序、截断之前排除由 Swift 本机归档资料指定的 Session ID；
- 打开既有 Pi 会话即取得 Session Lease，执行单写入所有权、抢占、外部写入检测与冲突恢复；D Code Session Presentation 是独立、只读的 Product Store / Adapter binding 投影，不调用该抢占路径；
- 创建 `AgentSession`，发送 prompt、中止、切换模型与 thinking level；
- 公开当前 D Code-owned Run 的稳定 Session / Run 身份、结构化等待、停止请求、完成、失败、中止与未知状态，并只在最终助手 Entry 经 Lease 同步后确认完成；
- 返回 Pi SDK 的 Context Usage，并维护 D Code 自有、会话级持久化的极速状态；
- 在 Product Store 中持久化 D Code Model Catalog、Credential Reference 与 Runtime Model Selection；Pi Runtime 只在首次迁入 / 受控发现时提供非敏感 Provider / Model 目录和外部认证桥状态，Runtime 启动前以 Store 选择、目录和凭据引用验证并显式设置模型；
- 投影 Pi 真实加载的 Extension / Skill / Prompt / Command，受控修改扩展包启停并热重载；
- 保留 Pi `models.json` / `settings.json` 的只读诊断兼容面，但拒绝 D Code 经其保存 / 删除 Provider、修改默认模型或 enabledModels；认证值不得通过 D Code IPC 进入 Pi `ModelRuntime.login`；
- 在同一 Pi Agent Loop 注册 `dcode_facts` 只读工具 facade；原生 `evidence`/`changes` 通过 Host 固定的 Task/Session/执行身份读取 Product Store，不把 Pi Session ID 或旧 Library 账本作为原生权威。`isCurrentRun` 严格匹配当前 Agent 与 Session Run；历史导入文件记录单列。原生写入操作摘要不等于持久文件 diff，缺失的文件名/行数/revision 不填造；旧适配入口和历史合同仍由对应版本文档解释；
- 转发 Pi 流式事件和结构化 Active Plan；
- 以原生 Unicode 结构渲染受支持的 Mermaid 图表，并为不支持类型返回显式失败；
- 把标准扩展交互转换为协议事件，并对 custom/widget 等 TUI 能力发出明确 unsupported 事件；
- 在退出、冲突或异常时停止写入并释放可验证属于自己的租约。

## 进程边界

开发入口：

```bash
cd host
npm ci
npm run build
node dist/src/index.js --agent-dir ~/.pi/agent
```

本机未签名候选入口：

```bash
npm --prefix client run dist
open "client/release/mac-arm64/D Code.app"
```

`client/scripts/package.mjs` 装配 Electron 客户端、Host 生产依赖、原生文件辅助程序、品牌和许可证资料。Host 使用 Electron 可执行文件的 Node 模式，不再打包另一份 Node 或 Swift 可执行文件。开发和包内资源分别由 `client/src/main/paths.ts` 解析，`DCODE_HOST_ENTRY` 可在显式隔离诊断时覆盖；当前命令与隔离参数见 [client/README](../../client/README.md)。候选不代表签名、公证、人工验收或正式发布。

- Host 开发运行要求 Node `>=22.19.0`；包内 Node 随锁定的 Electron 版本提供。
- stdin 接收 UTF-8 JSONL；stdout 只输出 Protocol v1 JSONL；普通诊断写 stderr。
- `--data-root` 供隔离测试或显式诊断；默认 D Code 产品数据根为当前用户 `~/.dcode/`。
- `--sessions-dir`、`--lease-agent-dir`、`--search-cache-dir` 保留既有测试/兼容诊断用途；Pi 私有会话不成为产品权威。
- App 退出先发送 `host.shutdown`，等待实际 Host 退出；超时只终止当前桥持有的进程，再确认退出。不以请求停止代替已停止。
- 自进化构建由 `host/src/maintenance.ts` 调用当前客户端候选链；`client/src/main/candidate-switch.ts` 校验身份、数据版本和完整资源摘要，停机后等待新 App 恢复确认，失败回原版本。旧 `DCodeRelaunchHelper` 不再使用。
- 平台桥等待 `host.ready` 并调用 `host.hello`；具体请求、版本化 envelope 和目标身份仍由生产协议实现验证。原 Swift `HostCompatibility` 不再是当前权威。
- Electron Node 模式保持当前平台环境，设置 `PI_CODING_AGENT_DIR`、`NO_COLOR` 和有界诊断参数；不复制凭据到客户端。

下文保留 Protocol v1 及历史 `session.*` 兼容诊断合同；当前产品任务使用 `dcodeSession.*` 与 Product Store，不能从旧协议示例推导双写或绕过产品权威。

## Protocol v1

每行恰好包含一个 JSON 对象。

请求：

```json
{"version":1,"type":"request","id":"r1","method":"host.hello","params":{}}
```

成功响应：

```json
{"version":1,"type":"response","id":"r1","method":"host.hello","ok":true,"result":{}}
```

失败响应：

```json
{"version":1,"type":"response","id":"r1","method":"host.hello","ok":false,"error":{"code":"...","message":"..."}}
```

事件：

```json
{"version":1,"type":"event","event":"session.opened","data":{}}
```

非法 JSON 或没有安全 correlation id 的非法 envelope 产生 `protocol.error` 事件；具有合法 id 的请求始终以该 id 返回成功或失败响应。无 Runtime 身份的 Product Store mutation 经过全局队列；带 `runtimeId` 的请求进入对应 Runtime 队列，不再被全局“当前会话”串行化。`extension.respond`、`agentRequest.answer` 与 `agentRun.stop` 属于解除等待或停止的控制请求，会绕过普通 Runtime 队列。认证值不进入通用 Protocol v1；API行内输入仅走独立的保密提交通道。输出仍按写入顺序串行化。

### 方法组

| 方法 | 作用 |
|---|---|
| `host.hello` | 返回协议、Pi 与 Node 版本及目录信息 |
| `foundation.snapshot` | 一次读取同一 Product Store revision 下的 Project、Task、Session / Path、Run、Attempt、Request、Report、Artifact、Finding、Evidence、Runtime Binding、Model Catalog、Credential Reference、未来 Runtime Model Selection 与 Task Workbench Presentation 投影；Prompt Receipt 只返回路径 / hash / 字节数和 Imported History Receipt 元数据，并在单次快照内复用当前文件读取，派生 `current_match` / `hash_mismatch` / `historical_unavailable` 状态，不返回历史 Prompt、导入历史正文或项目正文 |
| `runtimeModelSelection.set` | 以 request ID 与 expected Store revision 选择下一次 D Code Runtime 的 Provider / Model；只写 Product Store，不回写 Pi `settings.json` 或历史 Run |
| `taskWorkbenchViewState.patch` | 以 request ID、Store revision 与 View State revision 对 Task / Session 选择、HUD 分区或 Inspector 对象作局部 patch；所有 ID 必须属于同一选中 Task，状态只保存身份而不保存会话正文、Prompt 或 Artifact 内容 |
| `dcodeSession.presentation`、`dcodeSession.prompt` | 前者按 D Code Session ID 返回受控的只读 binding / Runtime / Adapter 快照；后者只为 Coordination Session 自动建立精确 Runtime，或把消息路由到已活动的指定 Child Runtime，绝不按标题、cwd 或全局 active Session 猜目标 |
| `project.create`、`task.create`、`task.acceptance` | 以 request ID、expected revision 和精确 User / Project Scope 创建或验收 D Code 原生对象 |
| `agentProfile.create`、`agentProfile.update` | 创建自定义 Profile 或版本化修改内建 / 自定义 Profile；已启动 Agent Run 保留启动快照 |
| `piImport.listCandidates`、`piImport.preview`、`piImport.importAsTask` | 发现外部 Pi Session、生成 digest / omission 预览，并在用户确认 Scope 后原子转换为新 Task；不修改源 JSONL |
| `runtime.list`、`runtime.start` | 返回活动 Runtime 与上限，或为指定 Task / D Code Session / Agent Run 建立独立 Pi AgentSession 和 workspace 所有权；Worker 只能匹配同一 Agent Run 的 ready 受管 worktree，调用方不能伪造 cwd |
| `team.create`、`team.start` | 建立 Coordinator 与成员身份；Host 从 Task Scope 派生只读源目录，并为合格的 Project Git Worker 预写 Artifact / Attempt、创建和核验独立 worktree 后才打开 Runtime；Coordinator 先规划，成员 Provider 请求并行，报告持久化后再综合 |
| `agentRequest.answer` | 以完整 Task / Team / Agent / Session Run / Runtime 身份回答耐久单选请求，答案回到原工具调用 |
| `agentRun.stop` | 先持久化 Stop Attempt，再中止指定成员并将 Session / Agent / Team 状态诚实收口；不使用含糊的全局停止目标 |
| `session.list`、`session.inspect` | 不创建 `AgentSession`，发现与恢复历史快照和路径摘要；Recent 使用 `session.list.origin="dcode"` 在分页前识别 Header ID 相符的 D Code 来源标记，Project 使用 `session.list.cwdScope` 精确匹配项目目录，`excludedSessionIds` 在分页前排除归档对象；有界列表先按文件 mtime 选择候选，再解析与筛选摘要 |
| `session.search` | 在独立 Worker 中查询可见会话本机索引；请求携带完整 Project 目录范围、归档排除 ID 与可选筛选范围，Host 在排序、分组和 `limit` 前再次强制可见性；搜索本身不打开会话、不创建租约 |
| `session.refresh` | 从当前活动会话的已知规范路径读取最新快照，不重新扫描全部 Session 目录；用于外部 Pi 条目落盘后的合并刷新 |
| `session.create` | 通过 Pi `SessionManager` 创建 cwd-scoped Session，将 Header 与 `dcode-session-origin-v1` 一次写入初始 JSONL；文档发布即提交创建并立即返回，不扫描全库、不创建 Lease、不加载扩展，也不关闭当前 Runtime；从 `0.0.5` 起 App 只在本地会话前草稿首次提交非空正文时调用，随后用独立 writable `session.open` 与 `session.prompt` 发送 |
| `session.open`、`session.close` | 显式 Runtime 请求只打开 / 关闭对应 Runtime，不影响其他会话；同一 D Code / Adapter Session 仍只有一个写入所有者。无 `runtimeId` 的旧入口保留单活动会话兼容语义，不定义新产品模型 |
| `session.setName` | 在当前会话空闲、Lease 稳定时调用 Pi SDK 写入 Session Name；空字符串恢复自动名称，单行名称最多 200 个 UTF-16 code unit |
| `session.trash` | 只将唯一、空的 D Code 创建 Session 移入当前 macOS 用户废纸篓；取得临时 Lease 后再次校验身份、来源、消息数和子会话关系，失败不执行永久删除 |
| `session.repair` | 受控修复尾部不完整的会话 JSONL（0.0.19）：仅当「尾部恰好一条记录不完整且其余记录完整」时可修；同目录完整备份 `.bak-<uuid>` → 修剪尾行 → 严格读取器复验 → 原子替换，任一环节失败原文件零改动；其余损坏形态拒绝并返回字段级原因。`session.open` 的 `INVALID_SESSION` 失败 details 附 `repairable` 与 `repairReason`，作为该入口的发现路径 |
| `session.prompt`、`session.abort` | 显式 D Code Runtime 在 Provider 前原子写 Raw / Effective Input、Session Run、Prompt Receipt 与 Attempt，并使用 D Code Prompt / Tools；`session.abort` 保留为底层 Runtime 控制，Foundation Console 停止成员使用 `agentRun.stop`。旧入口仍支持路径动作与图片附件 |
| `session.steer` | 携带预期 Run ID（与可选 `images`，同 `session.prompt` 合同），在当前 Host Run 仍为同一 `running`、没有结构化等待时调用 Pi 专用 `AgentSession.steer()`；Run 已变化则拒绝，不经过可降级为普通 Prompt 的异步 input handler，不建立新 Run、不执行斜杠命令、不中止正在执行的工具，在下一安全模型边界应用介入信息 |
| `session.copy` | 在源稳定且空闲时把完整已持久化历史复制成新 Session ID 与目标 `cwd`；源文件不改，失败目标不进入正常会话目录 |
| `session.relocateCwd` | 在明确 Project 目录迁移中，以稳定租约原地改写旧项目目录精确匹配 Session Header 的 `cwd`，保持 Session ID、历史、文件路径与谱系；可选移动目录内文件，但目标必须为空且绝不合并或覆盖 |
| `session.getState`、`session.getCommands`、`session.contextBreakdown` | 获取当前权威状态、D Code-owned Run State、命令 / 模板 / skills 与按消息种类估算的上下文构成 |
| `resources.list`、`resources.setPackageEnabled` | 投影 Pi 当前真实加载的扩展包、Extension、Skill、Prompt、Command 与诊断；只对有 Pi 配置合同的扩展包执行启停并热重载，Skill / Prompt / Command 保持只读 |
| `session.getModels`、`session.getThinkingLevels` | 获取可用模型及 thinking levels；`session.getModels` 传入规范 `cwd` 时可在尚无活动 Session 的会话前草稿读取 Pi 本机可用模型、精确默认项、默认 thinking level，并为每个模型返回其 thinking levels 与 D Code 极速资格 |
| `modelSettings.get`、`modelSettings.refresh`、`modelProviders.list` | 仅保留旧 Pi 目录的安全只读诊断 / 迁入来源，不定义 D Code Model Catalog、未来 Runtime 选择或用户可写产品设置 |
| `modelSettings.setEnabledModels`、`modelSettings.setDefaultModel`、`modelProviders.save`、`modelProviders.remove` | 明确拒绝；D Code 不再经 Pi `SettingsManager` / `models.json` 写产品模型配置 |
| `dcodeAuth.get/start/cancel/disconnect/refresh/openBrowser/enterCode/authorizeAccess` | D Code 安全连接控制；仅 Provider、认证类型、OpenAI Codex 专属 oauthMode、流程 ID 与状态，不能传入密钥或 OAuth 回调。API输入经专用保密IPC/fd3，当前设备码经只读保密IPC/fd4投影，其他OAuth交互由Host承接；机密只由Host持久保存到钥匙串，完整合同归PRD0030 |
| `modelAuth.start`、`modelAuth.respond`、`modelAuth.cancel` | 明确拒绝；D Code 不通过 IPC 启动 Pi 认证流程或发送 API Key / OAuth 值，凭据只以安全引用进入 Product Store |
| `session.setModel`、`session.setThinking` | 经 Pi SDK 修改当前已绑定 Runtime 的临时会话设置；未来 Runtime 的默认模型仍由 `runtimeModelSelection.set` 归 D Code Product Store 管理 |
| `session.setFastMode` | 写入当前 Session 的 D Code 极速状态；只为明确支持的 `openai-codex` 模型请求 `service_tier: priority`，不承诺服务端接受 |
| `extension.respond` | 完成标准 select/confirm/input/editor 扩展请求 |
| `content.renderMermaid` | 校验至多 100,000 字符的源码，返回 Unicode 行、语义 span、尺寸、类型和 warning；不支持的类型返回结构化失败 |
| `host.shutdown` | 关闭活动会话、刷新输出并退出 Host |

`host.hello.capabilities.mermaidUnicode=true` 表示该 Host 提供上述原生渲染动作，不表示支持 Mermaid 的全部图表语法。当前渲染器来自精确固定的 `grok-mermaid@0.2.2`，Swift 不自行解析图表语法。

参数的可执行权威位于 `host/src/protocol.ts`；Swift 客户端不得依赖未列入 Protocol v1 的内部对象字段。

恢复相关失败码（0.0.19 起）：`session.open` 对损坏 JSONL 返回 `INVALID_SESSION`（details 附 `repairable` 与 `repairReason`，尾部不完整时可经 `session.repair` 显式修复）；同一 `promptId` / `steerId` 在同一 Host 进程的已见 ID 窗口内重复提交返回 `SESSION_DUPLICATE_PROMPT` / `SESSION_DUPLICATE_STEER`（details 附已关联 runId）——已见 ID 仅内存级（LRU 256），Host 重启后不跨进程成立，判定历史提交是否落盘需正文比对 + `parentId` 链。

### 事件组

- 生命周期：`host.ready`、`session.opened`、`session.closed`、`session.changed`、`session.syncError`、`session.conflict`、`session.searchIndexChanged`、`session.runStateChanged`、`session.cwdRelocated`；搜索索引事件只报告 idle/building/updating/rebuilding/ready/failed、完成度与可选错误，不携带正文；`session.cwdRelocated` 只携带旧/新目录、受影响 Session ID、可选移动目录项和已关闭活动会话 ID，不携带 JSONL 正文；Run State 事件只携带稳定身份、阶段、时间、等待原因、输入持久化与安全重试门禁，不携带会话正文；`session.promptCompleted` / `session.promptFailed` 以 Session ID 与 Prompt ID 关联一次真实 RPC Prompt（远程调用输入）：普通消息在这次调用自身、且来源仍为 RPC 的 user record（用户记录）进入 verified owned snapshot（已验证本方快照）后确认；同一异步链里嵌套的 extension prompt（扩展输入）会进入独立来源边界，不能确认外层 RPC；扩展直接处理且不产生 RPC user record 的命令在该调用本身完成后确认；
- Pi 运行：`session.event`，其中载荷来自 `AgentSessionEvent`，`message_update.partial` 不转发累积快照；Host 为 D Code 发起的 Run 补充稳定 Session ID、Prompt / Run ID 与已持久化 Path user entry ID，但不把这些字段写入 Pi JSONL；
- 会话变更：`session.changeRecorded` 只在当前 D Code Run 中的成功 `edit` / `write` 结果满足已知结构化合同时发出；只携带 Session / Run / Path / tool-call 标识、规范路径、动作、首行、增删行和时间，不携带工具参数正文、源码或完整 patch；
- 计划：`plan.changed`，只识别 `dgoal-work-v1` 与 `dgoal-plan-v2`；
- 扩展：`extension.request`、`extension.closed`、`extension.notification`、`extension.status`、`extension.working`、`extension.editorText` 与 `extension.unsupported`；
- 诊断：`protocol.error`、`session.operationError`、`session.cleanupError`、`session.cleanupTimeout`、`extension.error`。

## 可见会话搜索缓存

搜索数据库不是会话历史权威。Pi JSONL 仍保存完整 Session、消息与活动路径；`~/Library/Caches/D Code/Search/search-v1.sqlite3` 只保存当前版本允许搜索的可重建投影，用户删除缓存或数据库损坏后都可以从可见 Pi Session 重建。

- Host 主线程只负责请求关联、状态事件和 Worker 生命周期；正文解析、增量更新与 SQLite FTS5 查询在独立 Worker 中执行，不阻塞普通聊天协议队列。
- 可见集合是 D Code 创建的 Recent 与当前 Project Directory 精确 `cwd` 投影的并集。每次查询仍把完整 Project 目录范围和归档排除 ID 传入 Worker，并在排序、分组与 `limit` 之前执行归档排除、可见性与 Project 筛选；缓存中的陈旧行不能绕过当前归属。
- 每个 Session 只索引当前活动路径的标题、用户正文与助手正文。thinking、工具调用、工具结果、自定义数据和认证字段不会进入搜索文档。
- Worker 使用文件路径、device、inode、size、mtimeNs 与 leaf ID 判断增量变化；正在追加的半条目保持索引 `complete=false` 并自动重试，刷新期间到达的新失效代际会触发后续刷新，不会被本轮完成状态吞掉。
- `session.search` 不打开 Session、不创建 Session Lease、不触发 Write Intent，也不写 Pi JSONL、Project、工作区文件或 Git。搜索结果只携带稳定 Session ID、可选 Entry ID 与展示片段；真正打开前 Host 会再次验证目标条目和文件版本。
- Node 运行时必须通过启动自检提供 SQLite FTS5。Worker 或数据库失败时发送明确 failed 状态；Swift 显示建立、重建或错误，不把不完整索引伪装成“没有结果”。

## 会话路径、草稿与复制归档

- Host 从同一 JSONL 的终端叶节点投影 Session Path；只读查看路径不会改变 Pi runtime。真正发送路径草稿前，Host 通过 Pi 的 tree lifecycle 切换到指定节点，并在租约前后复核源文件；路径 user record 尚未持久化时失败会回滚原叶节点，持久化后则保留新路径。
- Swift 把未发送草稿原子保存到 `~/Library/Application Support/D Code/session-drafts-v1.json`。普通草稿以 Session ID 与 Path target 为键；尚无 Pi 身份的会话前草稿只保存一个规范 `cwd`、非空正文、可选 Provider / Model 标识、可选 thinking level 与 Fast Mode 布尔值，空白内容不写入资料，凭据和模型配置正文不进入该文件。两者都不写 Pi JSONL、不进入模型上下文或搜索索引；会话前草稿首次提交后才调用 `session.create`，取得写权并依次确认模型、显式 thinking level 与 Fast Mode 后才发送第一条 Prompt，并把正文转移到新 Session 的 root Path 草稿。文件无法安全载入时停止覆盖原文件。
- `session.copy` 不调用 Pi 0.84.1 会全量对象化历史的 `SessionManager.forkFrom`。Host 在 `<agent-dir>/.dcode-session-copy-staging/operation-*` 中逐行读取并写入 Pi v3 兼容文档：新 Header 使用新 ID、目标规范 `cwd` 与源路径 `parentSession`，第二条写入与新 ID 匹配的 D Code 来源，随后原样保留源的全部非 Header 记录。单条记录上限 16 MiB、记录总数上限 100,000；验证 UTF-8、JSON、父子关系、重复 ID、尾换行、历史摘要与源稳定性后，才以 hard link（硬链接）一次发布到正常会话目录。源 JSONL 全程不改，发布前失败只清理隐藏暂存。
- 归档不是 Pi Session mutation（变更）。Swift 将直接归档记录或源与复制目标关系原子保存到 `~/Library/Application Support/D Code/session-archives-v1.json`；普通列表与搜索把归档源 ID 作为 `excludedSessionIds` 交给 Host。恢复显示只删除本机归档记录，再按真实 D Code 来源与 Project `cwd` 重新投影，不改源 JSONL。
- 置顶同样不进入 Pi Session。Swift 以稳定 Session ID 原子保存到 `session-pins-v1.json`，再用 `session.list(sessionIds:)` 有界补取已掉出普通页的置顶候选；只有通过当前 Recent 来源或 Project exact `cwd` 过滤的结果才会进入全局置顶投影。已置顶 ID 从 Recent / Project 普通请求中排除，因此同一会话只在顶部独立区域出现；Archive 排除始终先于 Pin 投影。

## 会话级变更账本

`host.hello.capabilities.sessionChangeLedger=true` 表示 Host 能把本次 D Code Run 内成功、结构化的文件工具结果投影为 `session.changeRecorded`。首版 adapter 只接受 DHashline-compatible `edit` 的 unified patch 元数据与 create-only `write` details；失败结果、未知工具、缺失结构、Bash 与外部写入全部不猜测。

`host.hello.capabilities.sessionRunCorrelation=true` 表示 Host 会把 D Code 传入的稳定 Prompt ID 作为当前 Run ID，在 `session.event` 中回传 `runId`，并在用户条目通过 Lease 核验后以 `session.promptCompleted` 返回匹配的 Session ID、Prompt ID 与 Entry ID。这是 `0.0.5` Follow-up Queue 的所有权转移证据；Host 仍不保存、编辑或重排 D Code 的待派发队列。

`host.hello.capabilities.sessionRepair=true` 表示该 Host 提供 `session.repair` 受控修复与 `INVALID_SESSION.details.repairable` 发现路径（0.0.19）；`promptImages=true` 表示 `session.prompt` / `session.steer` 接受可选 `images` 图片附件（0.0.20）；`sessionCwdRelocation=true` 表示该 Host 支持 Project 目录迁移的受控 Header `cwd` 原地改写（0.0.25）。

`host.hello.capabilities.sessionRunState=true` 表示 Host 会为当前唯一 D Code-owned Run 公开 `running`、`waitingForUser`、`stopRequested`、`completed`、`failed`、`aborted` 或 `unknown`。`waitingForUser` 另以 `waitingFor=select|confirm|input|editor` 区分非颜色等待语义；多个结构化请求必须全部关闭后才恢复 `running`。点击停止只先进入 `stopRequested`，直到 Agent 真正收敛才成为 `aborted`；正常完成还必须在本轮输入之后取得最终 assistant Entry 的稳定 ID，即使其后追加了安全元数据条目，仍以 `runId:entryId` 形成 completion identity。冲突、进程结束或无法证明终态时进入 `unknown`，App 必须阻止自动派发、重复发送与不安全重试。`agent_end` 只结束流式展示，不是终态证据；Follow-up Queue 只按匹配 Session / Run 的终态 Run State 结算。

`host.hello.capabilities.preSessionModelSelection=true` 表示 `session.getModels` 可以在没有活动 Pi Session 时接受一个规范工作目录，使用 Pi 的 `auth.json`、`models.json` 与该目录生效的 `settings.json` 组合本机可用模型快照，再按 `enabledModels` 的精确 / 通配规则解析 Composer 选择范围；仅登记、已认证但未启用的模型不会进入结果，并仅在精确默认 Provider / Model 同时位于该范围时返回 `defaultModel`。同一过滤合同也用于已有 Session 的模型选择菜单，但不会改写该 Session 当前或历史模型事实。结果还公开 Pi 的可选默认 thinking level，以及从真实模型元数据和 D Code Fast Mode 合同推导的 thinking levels / `fastModeSupported`；它们不构成第二份模型配置。该查询不进行网络目录刷新，不返回或复制凭据，也不修改 Pi 设置；App 没有范围内精确默认项时必须让用户显式选择，并在第一条 Prompt 前通过已有 `session.setModel`、`session.setThinking` 与 `session.setFastMode` 写入新 Session。全局模型设置与自定义 Provider 管理使用各自的独立方法组，不改变这项会话前选择能力的边界。

## D Code 模型与凭据边界

`host.hello.capabilities.dcodeModelCatalog=true` 表示 Host 将非敏感 Provider / Model 目录、Credential Reference（凭据安全引用）与 future Runtime Model Selection（未来运行模型选择）投影到 D Code Product Store。每次 D Code Runtime 启动前必须以 Store 选择、目录和已配置安全引用验证模型，并显式设置模型；Pi `settings.json`、`models.json` 与 `auth.json` 只服务受控发现或外部认证桥状态，不是产品权威。

- `modelSettings.get`、`modelSettings.refresh`、`modelProviders.list` 只保留旧 Pi 目录的安全只读诊断 / 迁入来源；其中不得返回 API Key、OAuth token 或认证文件正文。
- `modelProviders.save / remove`、`modelSettings.setEnabledModels / setDefaultModel` 与 `modelAuth.start / respond / cancel` 均被 Host 明确拒绝。旧 Pi 交互桥继续拒绝。D Code 自有 `dcodeAuth.*` 控制 Host 管理的安全连接，SDK 登录与刷新只消费 Host 内部凭据，不经过公共协议。
- `runtimeModelSelection.set` 只写入 Product Store 的安全、版本化选择；Pi Runtime Adapter 在实际 Run 边界读取该选择，不回写 Pi 默认配置或历史 Run。

Swift 将尚未呈现的最新稳定完成身份原子保存到 `~/Library/Application Support/D Code/activity-attention-v1.json`；资料版本化、有界且只含 Session / Run / Completion / Entry 身份、完成时间与可选查看时间，不保存正文、Thinking、工具结果或凭据。Activity View 仍从可见 Pi Session 与 Host Run State 重建；关注资料不是第二套会话数据库，旧结果也不能清除同一 Session 的更新完成身份。

Swift 以稳定 Session ID 为第一身份，将收到的记录原子保存到 `~/Library/Application Support/D Code/session-changes-v1.json`。记录总量上限 50,000，标识、路径、行数、时间和来源均在进入内存及写盘前校验；损坏或未知版本保留原字节、停止继续写账本，但不阻断普通 Session 导航。摘要按 Session ID 去重文件并累计已观察的增删活动；Active Plan 仍按当前 Session Path 投影。复制得到的新 Session ID 不读取源 ID 的账本，Archive 也不删除原 ID 记录。

该账本是覆盖可能不完整的本机派生资料，不是 Pi Session、源码或 Git 的第二权威。它不保存工具参数正文、文件内容或完整 patch；同一文件反复编辑与撤销会累计活动，因此 `+ / -` 不能解释为 Project 当前 Git 净差异。

## 会话打开与写入所有权（ADR 0018：打开即接管）

`session.open` 只有一条可写路径，没有只读观察模式（`0.0.9` 起，取代 ADR 0006 的“默认观察、按需写入”）。打开必须依次通过：

1. stable session ID 定位到唯一 JSONL；校验会话版本与搜索目标摘要（`expectedEntryId` / `expectedEntryDigest`），失败在关闭当前会话之前发生，当前会话不受影响；
2. 关闭当前活动会话并释放其租约；
3. 原子取得该 session ID 的 Session Lease（`force`）：已有存活属主（另一个 D Code 实例）时把旧锁目录原子 rename 后重建，直接抢占；旧属主在下一秒的属主自检中发现 owner 记录消失或 nonce 变化，抛 `LEASE_STOLEN` 并以 `session.conflict` 诚实退出，不伪装仍可写；
4. 静默窗口前后文件规范路径、device、inode、size、mtime 与 leaf ID 不变；文件仍在变（Pi CLI 在途写入）时轮询到稳定后完成接管，有限重试超时返回 `SESSION_NOT_IDLE`——等待的是文件稳定，不是用户；
5. Pi SDK 成功打开会话并绑定扩展 UI context；
6. 运行期间每次写入前后及定时轮询持续核对租约指纹（含属主自检）与 runtime snapshot；外部写入触发 `session.conflict`（abort、保留草稿），Swift 以原生冲突卡呈现并可一键重新接管。

空会话、旧会话或损坏前恢复出的会话若没有完整模型元数据，Host 在 wire 上返回 `model: null`，而不是空对象；可写运行时自行解析实际使用的模型。

打开即接管不依赖 CLI 插件、Handoff ID 或 D Code 创建来源标记；该标记只控制 Recent 导航可见性，不是写入锁。Session Lease 不是对非协作进程的技术锁：如果 Pi CLI 或其它进程在 D Code 写入期间继续写入，Host 会检测冲突并立即停止。App 随后关闭冲突运行时、释放自己的租约并保留草稿，用户可显式重新接管；冲突后不存在继续观察的只读态，也不能承诺无缝合并在途操作。

租约指纹包括规范路径、device、inode、size、mtimeNs 与 leaf ID。Host 在普通 message、工具结果、扩展 entry、thinking、session info、compaction 和已包装的模型/树操作发生持久化后，将 Pi runtime 的完整逻辑快照 digest 与磁盘 JSONL 复核，再接受新指纹；连续 owned writes 会合并或重试，混入 runtime 未知条目则判定为外部写入。写入前和定时轮询发现外部变化时，立即标记 conflict、中止运行并拒绝后续写操作。无法验证 owner nonce 的租约不得强制删除。

## Structured Extension UI Bridge

标准 `select`、`confirm`、`input`、`editor` 请求由 `extension.request` 表达，并以 request ID 确保结果、取消或错误只完成一次。

Host 不导入或调用 `pi-tui`，不执行 extension 提供的 TUI factory，也不向 Swift 发送终端字符帧。`ui.custom()` 先发出 `extension.unsupported`，再以 `EXTENSION_UI_UNSUPPORTED` 明确失败；非空 `setWidget()` 发出一次去重的 unsupported 事件但不调用 factory。Header、footer、theme、terminal input 等未原生适配的显示请求显式记录为忽略或阻止；只有阻止用户操作的错误进入产品通知。`getToolsExpanded()` / `setToolsExpanded()` 与 Pi RPC 一致，使用折叠默认值与 no-op（空操作），不冒充成产品能力失败。

扩展的 headless 执行和用户可见呈现分属两层：Host 可以通过 Pi SDK 加载启用的普通扩展并运行其工具，Swift 不调用扩展 TUI renderer。对 read/edit/write/search 等已识别结构，App 将原始 args/content/details 安全投影为 D Code-owned presenter，隐藏 write/edit 正文并对 read 只显示边界行；未识别工具保留通用 fallback。当前本机隔离 smoke 已验证 `pi-dhashline 0.1.1` 能在固定 Pi `0.84.1` Host 中加载，writable `session.open.extensions.errors=[]` 且 `session.getCommands` 包含 `/dhashline`；该结论只覆盖加载与命令契约，不外推为所有模型文件操作均已人工验收。

Swift 从当前路径 JSONL 与 live Host events 投影 `ConversationRound`：一个产品轮以用户消息为边界，可包含多个 Pi turn。历史 `startedAt` 优先使用用户 JSONL entry 的持久化时间，`completedAt` 使用该轮最后一条已接受 entry 的持久化时间；这是可跨重启恢复的近似值，不是精确 `agent_settled` 时间。每条稳定最终 Assistant 下方常显完成状态、完成时间与该边界计算出的耗时；本轮 token 只对所有 Assistant Message 已持久化、非负且可安全求和的 `usage.totalTokens` 合计，字段缺失、非法或溢出时省略，不以 Context Usage 或估算值替代。中间工具失败后若最终 Assistant 正常完成，状态仍以最终结果为准。运行中 Thinking 跨 Assistant / Tool 边界累积，与当前工具和流式正文同时呈现；实时 buffer 上限为 `100,000` UTF-16 code unit，超出时保留最新内容并标记较早部分已省略，完整持久化 Thinking 仍从 Pi Session 读取。`agent_end(willRetry=true)` 不结束可见活动，直到 `agent_settled`。

`host.hello.capabilities` 中 `extensionDialogs=true`，`extensionCustomHeadless=false`，`extensionWidgets=false`。这表示原生结构化对话框可用，不表示提供任意 Pi 扩展界面的兼容层。

## 当前验证

在 `host/` 执行：

```bash
npm test
```

精确测试数量、tag checkout 回归、App bundle、签名、人工验收与已知缺口统一记录在[版本实施方案](../40-版本实施方案/README.md)及对应 PRD。自动测试全绿只证明现有断言通过；跨 Swift / Host 的真实存储合同、完整 JSONL Protocol 参数组合、凭据边界、视觉与无障碍仍须按相应门禁独立成立。

此前真实 `~/.pi/agent` 只读 smoke test 验证过 stable session ID、模型、thinking level 与 Active Plan，隔离副本也完成过一次真实续写和重启恢复。该人工证据早于本次 TUI 兼容路径移除，因此只能证明会话主链路的历史基线，不能外推为当前所有已安装扩展仍可完成自定义交互；当前 custom/widget 合同以源码和自动测试中的明确 unsupported 行为为准。

早期无插件直接接管曾在临时 agentDir 的真实 `.app` 上完成历史验收，但当时使用“先只读、再确认”的界面，已由 ADR 0006 及其后的 ADR 0018（打开即接管）取代，不能作为当前 UI 证据。当前自动测试证明：打开即取得租约并在关闭时释放；外部写入触发 `session.conflict` 且可经重新打开恢复可写；第二个 Host 打开同一会话直接抢占（`force`），首个实例以 `LEASE_STOLEN` 诚实退出；静默窗口内持续变化有限重试后返回 `SESSION_NOT_IDLE`。

旧全量发现基线曾在真实 `~/.pi/agent` 上完成只读窗口冒烟：Host 握手、最近 60 个扫描结果、当前 stable Session ID 精确搜索、1,202 条当前历史与原生目录选择面板均可达。另以真实 Mermaid 会话验证 flowchart、sequence、state 与 class 的原生呈现、`110%` 缩放、源码复制、图片剪贴板和 `2724 × 398` PNG 导出；gantt 与 pie 显式显示不支持错误并回退原始源码。arm64 本机 App 由 LaunchServices/Finder 路径启动后，进程命令行确认只使用包内 Node 与 Host，`host.hello` 成功、扫描器可返回 60 个真实会话，Finder 环境包含 Homebrew/用户命令目录；App bundle 通过 `codesign --verify --deep --strict`，关窗后内嵌 Node 子进程退出。1233 个 JSONL、约 2.4 GiB 的现实目录下，`session.list(limit=60)` 实测 0.747 秒，随后按 ID `session.inspect` 实测 0.337 秒。该证据只证明扫描器与会话主链路的历史性能，不再代表 `0.0.1` Recent 的产品可见集合，也不证明当前真实会话的最终可写接管或对外分发已经完成。

API Key 行内连接的专用通道：可信页面通过 `dcode:connectApiKey` 提交遮蔽输入，主进程验证发送者/主frame/URL后，经创建Host时继承的fd3转交。非秘密环境标记只说明fd编号，参数/环境不携带密钥。两端独立限制帧/字段/并发并只返回白名单结果；失败和EOF不落入公共解析/异常日志。Host就绪前不执行连接，shutdown先关闭接收再收尾已接受保存。旧公开API-key start不再打开原生输入窗；OAuth流程保持独立。

### OAuth 授权页与辅助输入恢复

`dcodeAuth.openBrowser/enterCode` 仅接受有效 flowId，返回操作受理状态；不等待系统应用打开或用户输入，以保留串行协议中的取消/状态请求。Host 私有流程拥有完整授权URL和SDK手动结果请求，页面只有可操作状态与固定错误分类。自动打开失败不终止有效授权；浏览器登录的可选手动结果等待显式操作，窗口取消或故障不冒充整个连接被取消。完成、取消、过期及重启使旧流程入口失效。Swift opener 通过NSWorkspace异步完成回执确认OS已接受交付；真实默认浏览器行为与账号登录仍单独验收。

### 系统钥匙串非交互访问

D Code当前项沿用file-based登录钥匙串。依据[Apple TN3137](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains)及本机Security头文件，不能把data-protection的查询属性视为旧项的完整交互控制。独立helper在每项操作中调用[SecKeychain交互控制](https://developer.apple.com/documentation/security/seckeychainsetuserinteractionallowed%28_%3A%29)，默认禁止系统对话并恢复之前值；它是针对既有实现的兼容措施，不迁移用户钥匙串或更改ACL。

元数据查询只取属性；SDK确需正文时按provider合并在途读取，默认非交互。读到拒绝、锁定或内部超时后记录不可访问，后续后台查询不重新申请，目录逐provider计算以保留其他可用模型。公开 `dcodeAuth.authorizeAccess` 只有providerId与flowId，立即返回受理；授权阶段60秒可取消，成功后进入状态同步阶段，不能再显示授权超时，失败只重试同步。系统密码只由系统处理。

helper私有进程按provider串行复用以避免逐次启动；没有新增操作性secret缓存，每次读取仍执行OS权限检查。并发结果只服务在途请求，迟到结果不能覆盖更新；替换/缺失清除旧验证标记与元数据，取消/错误销毁对应helper，Host退出关闭全部。内容不进入普通协议、日志、Store或页面持久化，既有字面值脱敏登记不用于取得认证凭据。签名/ACL变化的实际授权仍需对应候选人工验收。

### OpenAI Codex 直接入口与设备码投影

`dcodeAuth.start.oauthMode` 仅对 `providerId=openai-codex` 且 `authType=oauth` 接受 `browser` 或 `device_code`；匹配固定 SDK 的真实选择提示与选项后直接返回对应 id。省略时直接进入 browser，不新增选择窗口；其他供应商不可借此覆盖自身的选择。OAuth URL、PKCE、state、设备轮询和令牌交换仍由 SDK 拥有。

设备码专用链路为可信主 frame → `dcode:readDeviceCode(flowId)` → 平台壳 fd4 → Host 当前流程，只返回短期 `userCode` 与 `expiresAt`，无有效流程返回 null。请求只接受关联 id 和 flowId，帧最多4096字节，平台壳只保留一个在途请求、等待最多2秒；不经过通用协议解析、诊断和日志。公开 `dcodeAuth.get` 只显示方式和可读取布尔能力。展示值不持久化，主窗口取消/完成/失败/到期/离开时清理，折叠清理页面副本；旧进程退出或迟到响应不得恢复。此通道不能查询已存凭据，不改变原 API fd3 的提交合同。
