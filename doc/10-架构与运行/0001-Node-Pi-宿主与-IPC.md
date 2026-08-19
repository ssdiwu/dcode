# Node/Pi 宿主与 IPC

状态：Active Implementation 0.0.7（自动测试与本机 App bundle 构建已通过；模型设置写入、回复运行信息与真实 Run 的最终人工验收尚未完成）

## 职责

`host/` 是 Swift App 与 Pi 0.84.1 之间唯一允许写入会话的运行边界。它使用项目内精确固定的 Pi 包加载 `~/.pi/agent` 的配置、模型、扩展与 JSONL 会话，不调用全局 `pi` 命令，也不建立第二份会话数据库。

Swift 负责原生呈现与用户输入；Host 负责：

- 发现、解析和恢复 Pi Session；
- 按有效 D Code 创建来源查询 Recent Session Summary，或按 Project 的精确 Source Folder `cwd` 查询全部关联 Session Summary；
- 在独立 Worker 中为上述可见会话建立可删除、可重建的 SQLite FTS5 本机索引，并搜索标题与当前活动路径的用户/助手正文；
- 读取同一 Pi Session 的真实路径谱系，并在用户第一次发送时按明确路径动作切换 Agent 上下文；
- 把完整已持久化 Session 以新 ID、新 `cwd` 和源谱系有界复制到目标 Source Folder，经隐藏暂存、严格验证后原子发布；
- 在列表分页与搜索排序、截断之前排除由 Swift 本机归档资料指定的 Session ID；
- 执行共享会话观察、按需 Session Lease 与冲突检测；
- 创建 `AgentSession`，发送 prompt、中止、切换模型与 thinking level；
- 公开当前 D Code-owned Run 的稳定 Session / Run 身份、结构化等待、停止请求、完成、失败、中止与未知状态，并只在最终助手 Entry 经 Lease 同步后确认完成；
- 返回 Pi SDK 的 Context Usage，并维护 D Code 自有、会话级持久化的极速状态；
- 缓存优先读取 Pi 模型目录，主目录只投影已认证 Provider，按用户显式动作刷新动态目录或通过 Pi `ModelRuntime.login` 关联 Provider，并通过 Pi SettingsManager 受控修改全局模型启用范围与默认模型；
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

本机 Finder App 入口：

```bash
./app/build.sh
open "dist/D Code.app"
```

`build.sh` 将 release Swift executable、arm64 Node `22.22.3`、Host `dist/src` 与 npm production dependency closure 装入 App resources，并应用本地 ad-hoc signature。Finder 启动时 `HostLocator` 优先使用 `Contents/Resources/runtime/node` 与 `Contents/Resources/host/dist/src/index.js`；开发覆盖仍可通过 `--node-bin`、`--host-entry`、`PI_DCODE_NODE_BIN` 与 `PI_DCODE_HOST_ENTRY` 指定。App 不启用 Sandbox 或 Hardened Runtime，也不构成 Developer ID/notarized 分发产物。

- Host 开发运行要求 Node `>=22.19.0`；`0.0.7` App Bundle 构建精确要求 arm64 Node `22.22.3`，确保内嵌运行时、SQLite FTS5 能力与随包许可证一致。
- stdin 接收 UTF-8 JSONL；stdout 只输出 Protocol v1 JSONL；普通诊断写 stderr。
- `--sessions-dir` 只在测试或显式覆盖时使用；默认会话权威仍为 `<agent-dir>/sessions`。
- `--lease-agent-dir` 可把测试租约与真实 `~/.pi/agent` 隔离。
- `--search-cache-dir` 可把测试搜索缓存与默认 `~/Library/Caches/D Code/Search` 隔离。
- App 退出应发送 `host.shutdown`；Host 也处理 EOF、`SIGTERM` 与 `SIGHUP`。
- App 在执行任何会话查询前要求 `hostVersion=0.0.7`，并校验 Session Lease、当前会话外部同步、结构化 Plan、Mermaid、Project cwdScope、D Code 创建来源、Context Usage、Fast Mode、`sessionSearch`、`sessionPaths`、`sessionCopy`、`sessionTrash`、`sessionVisibilityExclusions`、`sessionChangeLedger`、`sessionRename`、`sessionRunCorrelation`、`sessionRunState`、`preSessionModelSelection`、`modelSettings`、`sessionSteer` 与 `modelAuthentication` 能力；旧 Host 或缺失能力会明确停止连接，不能静默退化成错误的导航、运行状态、模型选择、模型设置、认证、队列所有权或写入路径。
- Finder 环境保留继承的 `PATH` 顺序，并补入 `~/.local/bin`、Hermes、Homebrew 与标准系统目录；`HOME` 与 `PI_CODING_AGENT_DIR` 显式传给 Host。

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

非法 JSON 或没有安全 correlation id 的非法 envelope 产生 `protocol.error` 事件；具有合法 id 的请求始终以该 id 返回成功或失败响应。普通输入按顺序处理并设置排队背压；`extension.respond` 以及 `modelAuth.respond / cancel` 为解除正在等待原生交互的长请求，在入口与 Pi Host 两层都绕过普通请求队列。输出仍按写入顺序串行化，stdin 正常结束时会等待普通与旁路请求共同收敛。

### 方法组

| 方法 | 作用 |
|---|---|
| `host.hello` | 返回协议、Pi 与 Node 版本及目录信息 |
| `session.list`、`session.inspect` | 不创建 `AgentSession`，发现与恢复历史快照和路径摘要；Recent 使用 `session.list.origin="dcode"` 在分页前识别 Header ID 相符的 D Code 来源标记，Project 使用 `session.list.cwdScope` 精确匹配 Source Folder，`excludedSessionIds` 在分页前排除归档对象；有界列表先按文件 mtime 选择候选，再解析与筛选摘要 |
| `session.search` | 在独立 Worker 中查询可见会话本机索引；请求携带完整 Project Source Folder 范围、归档排除 ID 与可选筛选范围，Host 在排序、分组和 `limit` 前再次强制可见性；搜索本身不打开会话、不创建租约 |
| `session.refresh` | 从当前活动会话的已知规范路径读取最新快照，不重新扫描全部 Session 目录；用于外部 Pi 条目落盘后的合并刷新 |
| `session.create` | 通过 Pi `SessionManager` 创建 cwd-scoped Session，将 Header 与 `dcode-session-origin-v1` 一次写入初始 JSONL；文档发布即提交创建并立即返回，不扫描全库、不创建 Lease、不加载扩展，也不关闭当前 Runtime；从 `0.0.5` 起 App 只在本地会话前草稿首次提交非空正文时调用，随后用独立 writable `session.open` 与 `session.prompt` 发送 |
| `session.open`、`session.close` | 打开内部观察态或可写会话并管理生命周期；可选 `pathId` 让历史路径观察与可写 runtime 使用同一叶节点；既有会话的 writable 请求必须携带本次 Write Intent |
| `session.setName` | 在当前会话空闲、Lease 稳定时调用 Pi SDK 写入 Session Name；空字符串恢复自动名称，单行名称最多 200 个 UTF-16 code unit |
| `session.trash` | 只将唯一、空的 D Code 创建 Session 移入当前 macOS 用户废纸篓；取得临时 Lease 后再次校验身份、来源、消息数和子会话关系，失败不执行永久删除 |
| `session.prompt`、`session.abort` | 发送输入与中止当前运行；首次路径输入可携带 `editUser`、`continueAssistant` 或 `continuePath`，只有对应 user record 持久化后才形成新路径 |
| `session.steer` | 携带预期 Run ID，在当前 Host Run 仍为同一 `running`、没有结构化等待时调用 Pi 专用 `AgentSession.steer()`；Run 已变化则拒绝，不经过可降级为普通 Prompt 的异步 input handler，不建立新 Run、不执行斜杠命令、不中止正在执行的工具，在下一安全模型边界应用介入信息 |
| `session.copy` | 在源稳定且空闲时把完整已持久化历史复制成新 Session ID 与目标 `cwd`；源文件不改，失败目标不进入正常会话目录 |
| `session.getState`、`session.getCommands` | 获取当前权威状态、当前 D Code-owned Run State、命令、模板与 skills |
| `session.getModels`、`session.getThinkingLevels` | 获取可用模型及 thinking levels；`session.getModels` 传入规范 `cwd` 时可在尚无活动 Session 的会话前草稿读取 Pi 本机可用模型、精确默认项、默认 thinking level，并为每个模型返回其 thinking levels 与 D Code 极速资格 |
| `modelSettings.get`、`modelSettings.refresh` | 在没有活动 Session 时按规范 `cwd` 读取 Pi 目录、全局与当前有效选择范围、默认模型、项目覆盖和安全认证 / 缓存状态；未认证 Provider 只返回身份与认证方法，不返回内建模型；只有显式 `refresh` 才允许有界访问动态目录网络 |
| `modelSettings.setEnabledModels`、`modelSettings.setDefaultModel` | 通过 Pi `SettingsManager` 只修改全局 `enabledModels` 或默认 Provider / Model；写前验证设置可读、模型存在、认证与启用范围，项目级设置保持只读 |
| `modelAuth.start`、`modelAuth.respond`、`modelAuth.cancel` | 驱动 Pi `ModelRuntime.login` 的 API Key / OAuth 交互；prompt/event 使用独立 flow/request ID，响应和取消旁路解除等待，成功后只返回重新读取的安全模型快照 |
| `session.setModel`、`session.setThinking` | 经 Pi SDK 修改当前会话设置 |
| `session.setFastMode` | 写入当前 Session 的 D Code 极速状态；只为明确支持的 `openai-codex` 模型请求 `service_tier: priority`，不承诺服务端接受 |
| `extension.respond` | 完成标准 select/confirm/input/editor 扩展请求 |
| `content.renderMermaid` | 校验至多 100,000 字符的源码，返回 Unicode 行、语义 span、尺寸、类型和 warning；不支持的类型返回结构化失败 |
| `host.shutdown` | 关闭活动会话、刷新输出并退出 Host |

`host.hello.capabilities.mermaidUnicode=true` 表示该 Host 提供上述原生渲染动作，不表示支持 Mermaid 的全部图表语法。当前渲染器来自精确固定的 `grok-mermaid@0.2.2`，Swift 不自行解析图表语法。

参数的可执行权威位于 `host/src/protocol.ts`；Swift 客户端不得依赖未列入 Protocol v1 的内部对象字段。

### 事件组

- 生命周期：`host.ready`、`session.opened`、`session.closed`、`session.changed`、`session.syncError`、`session.conflict`、`session.searchIndexChanged`、`session.runStateChanged`；搜索索引事件只报告 idle/building/updating/rebuilding/ready/failed、完成度与可选错误，不携带正文；Run State 事件只携带稳定身份、阶段、时间、等待原因、输入持久化与安全重试门禁，不携带会话正文；`session.promptCompleted` / `session.promptFailed` 以 Session ID 与 Prompt ID 关联一次真实 RPC Prompt（远程调用输入）：普通消息在这次调用自身、且来源仍为 RPC 的 user record（用户记录）进入 verified owned snapshot（已验证本方快照）后确认；同一异步链里嵌套的 extension prompt（扩展输入）会进入独立来源边界，不能确认外层 RPC；扩展直接处理且不产生 RPC user record 的命令在该调用本身完成后确认；
- Pi 运行：`session.event`，其中载荷来自 `AgentSessionEvent`，`message_update.partial` 不转发累积快照；Host 为 D Code 发起的 Run 补充稳定 Session ID、Prompt / Run ID 与已持久化 Path user entry ID，但不把这些字段写入 Pi JSONL；
- 会话变更：`session.changeRecorded` 只在当前 D Code Run 中的成功 `edit` / `write` 结果满足已知结构化合同时发出；只携带 Session / Run / Path / tool-call 标识、规范路径、动作、首行、增删行和时间，不携带工具参数正文、源码或完整 patch；
- 计划：`plan.changed`，只识别 `dgoal-work-v1` 与 `dgoal-plan-v2`；
- 扩展：`extension.request`、`extension.closed`、`extension.notification`、`extension.status`、`extension.working`、`extension.editorText` 与 `extension.unsupported`；
- 诊断：`protocol.error`、`session.operationError`、`session.cleanupError`、`session.cleanupTimeout`、`extension.error`。

## 可见会话搜索缓存

搜索数据库不是会话历史权威。Pi JSONL 仍保存完整 Session、消息与活动路径；`~/Library/Caches/D Code/Search/search-v1.sqlite3` 只保存当前版本允许搜索的可重建投影，用户删除缓存或数据库损坏后都可以从可见 Pi Session 重建。

- Host 主线程只负责请求关联、状态事件和 Worker 生命周期；正文解析、增量更新与 SQLite FTS5 查询在独立 Worker 中执行，不阻塞普通聊天协议队列。
- 可见集合是 D Code 创建的 Recent 与当前 Project Source Folder 精确 `cwd` 投影的并集。每次查询仍把完整 Project 范围和归档排除 ID 传入 Worker，并在排序、分组与 `limit` 之前执行归档排除、可见性与 Project / Source Folder 筛选；缓存中的陈旧行不能绕过当前归属。
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

`host.hello.capabilities.sessionRunState=true` 表示 Host 会为当前唯一 D Code-owned Run 公开 `running`、`waitingForUser`、`stopRequested`、`completed`、`failed`、`aborted` 或 `unknown`。`waitingForUser` 另以 `waitingFor=select|confirm|input|editor` 区分非颜色等待语义；多个结构化请求必须全部关闭后才恢复 `running`。点击停止只先进入 `stopRequested`，直到 Agent 真正收敛才成为 `aborted`；正常完成还必须在本轮输入之后取得最终 assistant Entry 的稳定 ID，即使其后追加了安全元数据条目，仍以 `runId:entryId` 形成 completion identity。冲突、进程结束或无法证明终态时进入 `unknown`，App 必须阻止自动派发、重复发送与不安全重试。`agent_end` 只结束流式展示，不是终态证据；Follow-up Queue 只按匹配 Session / Run 的终态 Run State 结算。

`host.hello.capabilities.preSessionModelSelection=true` 表示 `session.getModels` 可以在没有活动 Pi Session 时接受一个规范工作目录，使用 Pi 的 `auth.json`、`models.json` 与该目录生效的 `settings.json` 组合本机可用模型快照，再按 `enabledModels` 的精确 / 通配规则解析 Composer 选择范围；仅登记、已认证但未启用的模型不会进入结果，并仅在精确默认 Provider / Model 同时位于该范围时返回 `defaultModel`。同一过滤合同也用于已有 Session 的模型选择菜单，但不会改写该 Session 当前或历史模型事实。结果还公开 Pi 的可选默认 thinking level，以及从真实模型元数据和 D Code Fast Mode 合同推导的 thinking levels / `fastModeSupported`；它们不构成第二份模型配置。该查询不进行网络目录刷新，不返回或复制凭据，也不修改 Pi 设置；App 没有范围内精确默认项时必须让用户显式选择，并在第一条 Prompt 前按需通过已有 `session.setModel`、`session.setThinking` 与 `session.setFastMode` 写入新 Session。完整模型设置已前移到 `0.0.7`，Provider 管理仍不属于该能力。

## Pi 模型设置边界

`host.hello.capabilities.modelSettings=true` 表示 Host 提供认证后目录的安全投影与全局选择设置写入，而不是把 Pi 模型配置复制成 D Code 私有数据库；`modelAuthentication=true` 表示可以通过 Pi 原生认证合同关联 Provider。

- `modelSettings.get` 创建缓存优先、`allowModelNetwork=false` 的 Pi `ModelRuntime`；首次进入设置不隐式访问网络。`modelSettings.refresh` 才以用户动作允许网络并设置 12 秒中止边界，单个 Provider 失败保留其他目录，整体失败或离线也继续返回本地可辨认快照。
- 模型快照 Wire 只返回 Provider / Model 安全元数据、认证是否已配置及认证来源类型、缓存时间、启用规则、匹配关系与设置读取问题；未认证 Provider 的模型数组为空。认证步骤中的 API Key / Provider 配置值只短暂经过 `modelAuth.respond`，Protocol 严格限长，Host 不发事件、不回显、不写日志，错误统一脱敏；Provider 产生的 prompt / progress 文案进入界面前也会限长并再次脱敏。OAuth token 与认证文件正文始终不进入 Swift，D Code 不建立凭据资料。
- 全局写入先由 Pi `SettingsManager` 读取并确认没有 global error，再使用其 setter 与 `flush()` 锁内合并；损坏或不可读的全局文件原字节保留。默认模型还必须真实存在、已认证且位于全局启用范围。
- 当前 `cwd` 的 `.pi/settings.json` 只用于计算 effective scope 与解释覆盖来源；`0.0.7` 不写项目设置。更改全局值只影响后续选择和新会话，不改当前 / 历史 Session 的模型事实。

Swift 将尚未呈现的最新稳定完成身份原子保存到 `~/Library/Application Support/D Code/activity-attention-v1.json`；资料版本化、有界且只含 Session / Run / Completion / Entry 身份、完成时间与可选查看时间，不保存正文、Thinking、工具结果或凭据。Activity View 仍从可见 Pi Session 与 Host Run State 重建；关注资料不是第二套会话数据库，旧结果也不能清除同一 Session 的更新完成身份。

Swift 以稳定 Session ID 为第一身份，将收到的记录原子保存到 `~/Library/Application Support/D Code/session-changes-v1.json`。记录总量上限 50,000，标识、路径、行数、时间和来源均在进入内存及写盘前校验；损坏或未知版本保留原字节、停止继续写账本，但不阻断普通 Session 导航。摘要按 Session ID 去重文件并累计已观察的增删活动；Active Plan 仍按当前 Session Path 投影。复制得到的新 Session ID 不读取源 ID 的账本，Archive 也不删除原 ID 记录。

该账本是覆盖可能不完整的本机派生资料，不是 Pi Session、源码或 Git 的第二权威。它不保存工具参数正文、文件内容或完整 patch；同一文件反复编辑与撤销会累计活动，因此 `+ / -` 不能解释为 Project 当前 Git 净差异。

## 会话观察与写入所有权

### 观察

`session.open` 的内部 `mode=readOnly` 代表 Session Observation：只挂载已解析快照，不创建 `AgentSession`，也不创建租约。Host 以轻量 stat 轮询当前文件的 device、inode、size 与 mtime；变化后发出 `session.changed`，Swift 再用 `session.refresh` 从已知路径取得最新活动分支。无变化时不重复解析完整 JSONL，不重新扫描全部 Session 目录。该内部模式不映射为用户可见的“只读会话”；App 始终保留正常 transcript 与 Composer。空会话、旧会话或损坏前恢复出的会话若没有完整模型元数据，Host 必须在 wire 上返回 `model: null`，而不是空对象；观察仍可打开，首次取得写权后的模型选择由 writable runtime 决定。

### 可写

`mode=writable` 必须依次通过：

1. stable session ID 定位到唯一 JSONL；
2. 对既有会话，Protocol 以 `writeIntent=true` 表达本次用户 Write Intent；它由发送或修改运行设置触发，不对应一张额外确认页；新建会话由 Host 自己保证初始独占；
3. 原子创建该 session ID 的 Session Lease，已有租约时返回 `SESSION_IN_USE`；
4. 静默窗口前后文件规范路径、device、inode、size、mtime 与 leaf ID 不变；
5. Pi SDK 成功打开会话并绑定扩展 UI context；
6. 运行期间每次写入前后及定时轮询持续核对租约指纹与 runtime snapshot。

按需写入不依赖 CLI 插件、Handoff ID 或 D Code 创建来源标记；该标记只控制 Recent 导航可见性，不是写入锁。Write Intent 不是对非协作进程的技术锁：如果 Pi CLI 或其它进程在 D Code 写入期间继续写入，Host 会检测冲突并立即停止。App 随后关闭冲突运行时、释放自己的租约、回到观察态并刷新最新历史；不能承诺在两个进程同时开始写入时无缝合并在途操作。

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

当前 Host 自动测试共 130 项，除完整保留搜索、会话观察、按需写入、租约、冲突恢复、资源加载、结构化 Extension UI、Mermaid、协议、队列关联和进程生命周期回归外，还覆盖模型设置、未认证目录隐藏、Pi API Key 登录且事件不泄漏 secret、steer 保持当前 Run 身份，以及 Run State 的等待、停止和稳定完成边界。Swift 包共 141 项通过；除既有 Project、文件树、Git、Recent、搜索、外观、会话、路径草稿、延迟创建、Prompt transaction、Follow-up Queue、归档置顶、Markdown、工作轮、工具 presenter、可调栏位、变更账本与 Activity 回归外，还覆盖模型 / 认证快照、Host 能力门禁、Assistant usage / token 边界、Return 键策略、Thinking 跨工具保留、steer 正常结算、异常恢复和 shutdown 草稿保留。

`./app/build.sh` 已在当前工作树本机装配 433 MiB 的 `dist/D Code.app`，Host 版本与 bundle metadata 均为 `0.0.7`（build 7），包内 arm64 Node 为 `22.22.3`，ad-hoc 深层签名验证通过；当前内嵌 Host 包含 `preSessionModelSelection`、`modelSettings`、`sessionSteer` 与 `modelAuthentication`。另以独立 Bundle ID、fake Host 和隔离资料取得原生窗口 / Accessibility Tree：Return 真实写入 fake `session.prompt`，稳定完成 Dock 消失，Context 蓝 / 白环可见，模型页只展示已认证 Provider 模型、模型行全局启用与底部未认证 Provider 关联入口。真实 Pi steer / Provider 登录、浅色外观和完整 VoiceOver 仍记为待人工验收，不由自动测试或 fake Host 替代。

此前真实 `~/.pi/agent` 只读 smoke test 验证过 stable session ID、模型、thinking level 与 Active Plan，隔离副本也完成过一次真实续写和重启恢复。该人工证据早于本次 TUI 兼容路径移除，因此只能证明会话主链路的历史基线，不能外推为当前所有已安装扩展仍可完成自定义交互；当前 custom/widget 合同以源码和自动测试中的明确 unsupported 行为为准。

早期无插件直接接管曾在临时 agentDir 的真实 `.app` 上完成历史验收，但当时使用“先只读、再确认”的界面，已由 ADR 0006 取代，不能作为当前 UI 证据。当前自动测试证明观察态不创建租约、外部变化发出 `session.changed` 并可从已知路径刷新；冲突后的 writable runtime 能释放租约并重新进入观察。第二个 Host 在首个租约释放前仍得到 `SESSION_IN_USE`，静默窗口变化与未知外部条目仍得到明确冲突。

旧全量发现基线曾在真实 `~/.pi/agent` 上完成只读窗口冒烟：Host 握手、最近 60 个扫描结果、当前 stable Session ID 精确搜索、1,202 条当前历史与原生目录选择面板均可达。另以真实 Mermaid 会话验证 flowchart、sequence、state 与 class 的原生呈现、`110%` 缩放、源码复制、图片剪贴板和 `2724 × 398` PNG 导出；gantt 与 pie 显式显示不支持错误并回退原始源码。arm64 本机 App 由 LaunchServices/Finder 路径启动后，进程命令行确认只使用包内 Node 与 Host，`host.hello` 成功、扫描器可返回 60 个真实会话，Finder 环境包含 Homebrew/用户命令目录；App bundle 通过 `codesign --verify --deep --strict`，关窗后内嵌 Node 子进程退出。1233 个 JSONL、约 2.4 GiB 的现实目录下，`session.list(limit=60)` 实测 0.747 秒，随后按 ID `session.inspect` 实测 0.337 秒。该证据只证明扫描器与会话主链路的历史性能，不再代表 `0.0.1` Recent 的产品可见集合，也不证明当前真实会话的最终可写接管或对外分发已经完成。
