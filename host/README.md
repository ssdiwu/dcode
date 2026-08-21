# Pi Host

## 一句话定位

`host/` 是 `D Code` 的 Node/Pi 运行边界：它通过版本化 JSONL 协议向 Swift App 暴露 Pi 会话，而不是建立第二套会话系统。`@pi-dcode/host` 与 `pi-dcode-host` 继续作为内部兼容标识。

完整进程、协议与生命周期说明见 [Node/Pi 宿主与 IPC](../doc/10-架构与运行/0001-Node-Pi-宿主与-IPC.md)。

## 当前能力

- Protocol v1 的请求、响应和事件信封；
- 请求参数最小运行时校验与结构化错误；
- 支持分片、连续多行、最大行长度和输出背压的 JSONL 传输；
- 有界会话发现：Recent 按有效 D Code 创建来源筛选，Project 按 Source Folder 的精确 `cwd` 查询；稳定 ID 快速解析、历史快照与 Active Plan 恢复；
- 可见会话全文搜索：独立 Worker 使用本机 SQLite FTS5 增量索引 D Code Recent 与已关联 Project 的标题、当前活动路径用户/助手正文；查询时重新强制可见范围，缓存损坏可重建，半写入条目会自动重试；
- 读取同一 Session 的真实终端路径，按选中 leaf 恢复快照与模型上下文，并以 `editUser`、`continueAssistant`、`continuePath` 在首条用户消息持久化时建立新路径；
- 将完整已持久化 Session 以新 ID、新 `cwd` 和源谱系复制到目标 Source Folder：隐藏暂存中逐行校验，源稳定后用 hard link 原子发布；归档 ID 在 Recent、Project 与 Search 的分页、排序和结果上限前排除；
- 在 Pi cwd-scoped 目录创建新会话，将 Header 与 D Code 创建来源标记一次写入初始 JSONL；该文档发布即为创建提交点并立即返回，不扫描全库、不取得新 Lease，也不等待旧 Runtime 关闭；App 再以独立打开请求切换并取得新会话所有权；
- 对空的 D Code 创建会话提供可恢复的 `session.trash`：唯一 ID 解析、D Code 来源、零消息、无子会话、非可写和 Lease 复核全部成立后才移入用户废纸篓；失败不回退为永久删除；
- 通过 Pi SDK 持久修改当前 Session Name，同一名称供 Pi、D Code 左栏、搜索与窗口顶部使用；空名称恢复 Pi 的自动标题；
- 打开既有会话即以 `force` 取得 Session Lease 并成为唯一写入所有者；没有只读观察模式。外部写入或另一 D Code 实例抢占会触发明确冲突、停止当前运行并关闭失效所有权，草稿由 App 保留后可显式重新接管；
- 使用固定 Pi SDK 加载现有 settings、模型、会话、流式事件及可兼容的结构化扩展能力；
- 为 D Code 发起的 Prompt 保留稳定 Prompt ID，并在 `session.event` 中附带对应 `runId` / 已持久 Path Entry ID；`sessionRunCorrelation` 能力供 App 对后续消息做顺序门禁，Host 不另建产品队列；
- 运行中可在 Host Run State 仍为 `running` 时使用 Pi 原生 steer 介入下一安全模型边界；它不替换 Run ID，也不伪装成立即中止工具；
- 模型设置主目录只投影已认证 Provider 的模型；未认证 Provider 通过独立认证桥调用 Pi `ModelRuntime.login`，支持 API Key / OAuth prompt、浏览器链接、设备代码、取消与脱敏错误，凭据只由 Pi 持久化；
- 投影 Pi `resourceLoader` 真实加载的 Extension、Skill、Prompt 与 Command，按 Pi `SettingsManager.setPackages` 修改扩展包启停并热重载；D Code 自有隐藏扩展不进入用户清单；
- 在同一个 Pi Agent Loop 注册只读 `dcode_facts` facade；当前生产合同只确认 `changes` / `lineage`，`evidence` / `project` 的 Swift 存储兼容缺口见 [0.0.15 PRD](../doc/40-版本实施方案/0016-0.0.15-界面即上下文与本机资源产品需求.md)；
- 提供 `modelProviders.list / save / remove` 管理 Pi `models.json` 自定义供应商：候选文件经结构检查与 Pi `ModelConfig` 校验后原子替换。该界面的嵌套 header 脱敏、删除后目录刷新与并发写入边界尚未收口，见 [0.0.16 PRD](../doc/40-版本实施方案/0017-0.0.16-自定义模型供应商与一次性资源调用产品需求.md)；
- 为当前 D Code Run 中成功且具有已知结构化结果的 `edit` / `write` 投影有界 `session.changeRecorded` 元数据；不向 App 复制工具参数正文、源码或完整 patch，未知工具和失败结果不猜测；
- 返回 Pi SDK 的真实 Context Usage（上下文占用），并提供 D Code 自有、会话级持久化的极速模式；极速只为明确支持的 `openai-codex` 模型请求 `service_tier: priority`；
- 标准 `select`、`confirm`、`input`、`editor`、通知与状态使用结构化事件；TUI custom/widget 能力显式阻止或忽略；
- 通过精确固定的 `grok-mermaid` 提供原生 Unicode Mermaid 渲染，并对不支持的类型返回结构化失败；
- 临时目录自动测试覆盖快速创建、会话复制 / 废纸篓安全边界、路径、租约、搜索、Project / Recent、打开即接管、Run State、模型 / 认证、资源、自定义供应商、扩展与进程生命周期回归；测试全绿不替代跨 Swift / Host 的真实存储、完整 Protocol 组合与人工验收，精确证据和已知缺口见[版本实施方案](../doc/40-版本实施方案/README.md)。

## 命令

```bash
npm ci
npm test
npm run build
npm start -- --agent-dir ~/.pi/agent
```

## 目录

- `src/protocol.ts`：Protocol v1 类型、解析、参数校验和信封构造。
- `src/jsonl.ts`：JSONL 解码与有序输出。
- `src/session-reader.ts`：安全会话扫描、快照和 Active Plan 恢复。
- `src/session-copy.ts`：完整会话的有界流式校验、隐藏暂存与原子发布。
- `src/session-origin.ts`：D Code 创建来源标记的共享协议常量。
- `src/session-change.ts`：DHashline-compatible 工具结果到会话变更元数据的有界、安全投影。
- `src/session-search-index.ts`：搜索 Worker 生命周期、请求关联、失败恢复与缓存位置。
- `src/session-search-worker.ts`：可见范围发现、当前路径解析、SQLite FTS5 索引和查询。
- `src/dcode-fast.ts`：D Code 自有极速状态、会话持久化与 Provider Request 注入边界。
- `src/dcode-facts.ts`：在同一 Agent Loop 注册 D Code 独有事实的只读工具 facade。
- `src/resource-policy.ts`：在 Extension Factory（扩展工厂）执行前排除外部 `pi-dfast`，其余启用扩展仍交由固定 Pi SDK 加载。
- `src/resources.ts`：Pi 本机资源加载快照、扩展包启停影子清单与热重载。
- `src/model-providers.ts`：Pi `models.json` 自定义供应商的投影、校验、合并与原子替换；嵌套 header 脱敏仍有已知缺口。
- `src/session-lease.ts`：会话租约、静默检查和外部写入检测。
- `src/extension-ui.ts`：标准结构化扩展 UI，以及 TUI 能力的显式 unsupported 边界。
- `src/model-auth.ts`：Pi Provider 认证 prompt / event 的有界原生桥与旁路响应生命周期。
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
