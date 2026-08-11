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
- 在 Pi cwd-scoped 目录创建新会话，将 Header 与 D Code 创建来源标记一次写入初始 JSONL；该文档发布即为创建提交点，随后尝试取得 Session Lease，失败时仍返回已创建会话并降级为观察或明确不可用；
- 既有会话先以共享观察态打开：Host 只轮询当前文件身份，变化时通知 App 从已知路径刷新；发送或修改运行设置时再以写入意图取得 Session Lease，并持续检测外部写入；
- 使用固定 Pi SDK 加载现有 settings、模型、会话、流式事件及可兼容的结构化扩展能力；
- 返回 Pi SDK 的真实 Context Usage（上下文占用），并提供 D Code 自有、会话级持久化的极速模式；极速只为明确支持的 `openai-codex` 模型请求 `service_tier: priority`；
- 标准 `select`、`confirm`、`input`、`editor`、通知与状态使用结构化事件；TUI custom/widget 能力显式阻止或忽略；
- 通过精确固定的 `grok-mermaid` 提供原生 Unicode Mermaid 渲染，并对不支持的类型返回结构化失败；
- 90 项临时目录自动测试（含可见范围、筛选先于结果上限、标题与正文排序、中文相邻短语与真实命中片段、当前路径、正文隐私排除、有界暂存、半写入退避与自动恢复、刷新中失效、非当前可见会话的文件身份探测、运行期缓存损坏重建、失败代次锁存、真实 Worker 进程 JSONL/无租约、稳定搜索目标打开，以及完整/半写入外部条目的观察、冲突恢复、D Code 创建来源、Project 精确目录、极速、扩展、租约与进程生命周期）；真实 `~/.pi` 只读 smoke test 不改原会话。

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
- `src/session-origin.ts`：D Code 创建来源标记的共享协议常量。
- `src/session-search-index.ts`：搜索 Worker 生命周期、请求关联、失败恢复与缓存位置。
- `src/session-search-worker.ts`：可见范围发现、当前路径解析、SQLite FTS5 索引和查询。
- `src/dcode-fast.ts`：D Code 自有极速状态、会话持久化与 Provider Request 注入边界。
- `src/resource-policy.ts`：在 Extension Factory（扩展工厂）执行前排除外部 `pi-dfast`，其余启用扩展仍交由固定 Pi SDK 加载。
- `src/session-lease.ts`：会话租约、静默检查和外部写入检测。
- `src/extension-ui.ts`：标准结构化扩展 UI，以及 TUI 能力的显式 unsupported 边界。
- `src/pi-host.ts`：Pi SDK 会话生命周期与协议动作。
- `src/index.ts`：stdin/stdout Host 进程入口。
- `test/`：只使用临时写入范围的公开行为测试。

## 边界

- stdout 只允许协议 JSONL；诊断必须写 stderr。
- 不依赖全局 `pi` 命令，Pi 包版本必须精确固定。
- 不直接依赖或调用 `pi-tui`；它可以作为 `pi-coding-agent` 的私有传递依赖存在，但不能成为产品呈现路径。
- Session Lease 不能迫使不协作的旧客户端遵守租约；外部写入必须触发停止，不能静默续写。
- 不自动删除无法证明属于当前 owner 的租约。
