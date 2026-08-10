# Node/Pi 宿主与 IPC

状态：Implemented baseline

## 职责

`host/` 是 Swift App 与 Pi 0.84.1 之间唯一允许写入会话的运行边界。它使用项目内精确固定的 Pi 包加载 `~/.pi/agent` 的配置、模型、扩展与 JSONL 会话，不调用全局 `pi` 命令，也不建立第二份会话数据库。

Swift 负责原生呈现与用户输入；Host 负责：

- 发现、解析和恢复 Pi Session；
- 执行 App 内直接会话接管、Session Lease 与冲突检测；
- 创建 `AgentSession`，发送 prompt、中止、切换模型与 thinking level；
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

`build.sh` 将 release Swift executable、arm64 Node `>=22.19.0`、Host `dist/src` 与 npm production dependency closure 装入 App resources，并应用本地 ad-hoc signature。Finder 启动时 `HostLocator` 优先使用 `Contents/Resources/runtime/node` 与 `Contents/Resources/host/dist/src/index.js`；开发覆盖仍可通过 `--node-bin`、`--host-entry`、`PI_DCODE_NODE_BIN` 与 `PI_DCODE_HOST_ENTRY` 指定。App 不启用 Sandbox 或 Hardened Runtime，也不构成 Developer ID/notarized 分发产物。

- 运行时要求 Node `>=22.19.0`。
- stdin 接收 UTF-8 JSONL；stdout 只输出 Protocol v1 JSONL；普通诊断写 stderr。
- `--sessions-dir` 只在测试或显式覆盖时使用；默认会话权威仍为 `<agent-dir>/sessions`。
- `--lease-agent-dir` 可把测试租约与真实 `~/.pi/agent` 隔离。
- App 退出应发送 `host.shutdown`；Host 也处理 EOF、`SIGTERM` 与 `SIGHUP`。
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

非法 JSON 或没有安全 correlation id 的非法 envelope 产生 `protocol.error` 事件；具有合法 id 的请求始终以该 id 返回成功或失败响应。普通输入按顺序处理并设置排队背压；`extension.respond` 为解除正在等待原生对话框的 `session.prompt`，在入口与 Pi Host 两层都绕过普通请求队列。输出仍按写入顺序串行化，stdin 正常结束时会等待普通与旁路请求共同收敛。

### 方法组

| 方法 | 作用 |
|---|---|
| `host.hello` | 返回协议、Pi 与 Node 版本及目录信息 |
| `session.list`、`session.inspect` | 不创建 `AgentSession`，只读发现与恢复历史快照；有界列表先按文件 mtime 选择最近候选，再解析完整摘要 |
| `session.create` | 通过 Pi `SessionManager` 创建 cwd-scoped JSONL、取得租约并以 writable 打开 |
| `session.open`、`session.close` | 打开只读或可写会话并管理生命周期；既有会话的 writable 请求必须携带 App 的独占使用确认 |
| `session.prompt`、`session.abort` | 发送输入与中止当前运行 |
| `session.getState`、`session.getCommands` | 获取当前权威状态、命令、模板与 skills |
| `session.getModels`、`session.getThinkingLevels` | 获取可用模型及 thinking levels |
| `session.setModel`、`session.setThinking` | 经 Pi SDK 修改当前会话设置 |
| `extension.respond` | 完成标准 select/confirm/input/editor 扩展请求 |
| `content.renderMermaid` | 校验至多 100,000 字符的源码，返回 Unicode 行、语义 span、尺寸、类型和 warning；不支持的类型返回结构化失败 |

`host.hello.capabilities.mermaidUnicode=true` 表示该 Host 提供上述原生渲染动作，不表示支持 Mermaid 的全部图表语法。当前渲染器来自精确固定的 `grok-mermaid@0.2.2`，Swift 不自行解析图表语法。
| `host.shutdown` | 关闭活动会话、刷新输出并退出 Host |

参数的可执行权威位于 `host/src/protocol.ts`；Swift 客户端不得依赖未列入 Protocol v1 的内部对象字段。

### 事件组

- 生命周期：`host.ready`、`session.opened`、`session.closed`、`session.conflict`；
- Pi 运行：`session.event`，其中载荷来自 `AgentSessionEvent`，`message_update.partial` 不转发累积快照；
- 计划：`plan.changed`，只识别 `dgoal-work-v1` 与 `dgoal-plan-v2`；
- 扩展：`extension.request`、`extension.closed`、`extension.notification`、`extension.status`、`extension.working`、`extension.editorText` 与 `extension.unsupported`；
- 诊断：`protocol.error`、`session.operationError`、`session.cleanupError`、`session.cleanupTimeout`、`extension.error`。

## 会话打开与所有权

### 只读

`session.open` 的 `mode=readOnly` 只挂载已解析快照，不创建 `AgentSession`，不能调用 prompt、模型修改或扩展动作。

### 可写

`mode=writable` 必须依次通过：

1. stable session ID 定位到唯一 JSONL；
2. 对既有会话，Protocol 要求 `exclusiveUseConfirmed=true`，对应 App 中用户确认其他客户端已停止使用；新建会话由 Host 自己保证初始独占；
3. 原子创建该 session ID 的 Session Lease，已有租约时返回 `SESSION_IN_USE`；
4. 静默窗口前后文件规范路径、device、inode、size、mtime 与 leaf ID 不变；
5. Pi SDK 成功打开会话并绑定扩展 UI context；
6. 运行期间每次写入前后及定时轮询持续核对租约指纹与 runtime snapshot。

直接接管不依赖 CLI 插件、Handoff ID 或会话 marker。App 的确认不是对非协作进程的技术锁：用户仍须先停止在其他客户端中使用该会话；如果 Pi CLI 或其它进程之后写入，Host 会检测冲突并立即停止，不能承诺在两个进程同时开始写入时无缝迁移在途操作。

租约指纹包括规范路径、device、inode、size、mtimeNs 与 leaf ID。Host 在普通 message、工具结果、扩展 entry、thinking、session info、compaction 和已包装的模型/树操作发生持久化后，将 Pi runtime 的完整逻辑快照 digest 与磁盘 JSONL 复核，再接受新指纹；连续 owned writes 会合并或重试，混入 runtime 未知条目则判定为外部写入。写入前和定时轮询发现外部变化时，立即标记 conflict、中止运行并拒绝后续写操作。无法验证 owner nonce 的租约不得强制删除。

## Structured Extension UI Bridge

标准 `select`、`confirm`、`input`、`editor` 请求由 `extension.request` 表达，并以 request ID 确保结果、取消或错误只完成一次。

Host 不导入或调用 `pi-tui`，不执行 extension 提供的 TUI factory，也不向 Swift 发送终端字符帧。`ui.custom()` 先发出 `extension.unsupported`，再以 `EXTENSION_UI_UNSUPPORTED` 明确失败；非空 `setWidget()` 发出一次去重的 unsupported 事件但不调用 factory。Header、footer、theme、terminal input 等未原生适配的显示请求同样显式忽略或阻止，不得静默返回成功。

`host.hello.capabilities` 中 `extensionDialogs=true`，`extensionCustomHeadless=false`，`extensionWidgets=false`。这表示原生结构化对话框可用，不表示提供任意 Pi 扩展界面的兼容层。

## 当前验证

在 `host/` 执行：

```bash
npm test
```

当前 Host 自动测试共 37 项，覆盖协议、JSONL 分片与坏输入、输出失败、直接接管确认、存活所有者拒绝、失效 owner 租约自动恢复、并发恢复只产生一个所有者、静默窗口、租约与外部写入、连续 owned writes、新建会话、会话发现/恢复、结构化 Extension UI、对话响应的进程级交错、custom/widget 与查询型 TUI 能力的明确拒绝、Mermaid 成功/不支持分支、PiHost 生命周期、父进程消失后的有界退出及真实子进程 JSONL。Swift 包另有 16 项测试，覆盖协议映射、可操作的租约冲突文案、连续 Pipe 响应、开发/Bundle Host 定位、Finder 环境补全、无外部 token 的接管入口、按 cwd 的稳定工作区分组、扩展界面状态的会话/Host 生命周期清理、streaming/persisted 回复边界去重、诊断脱敏、transcript、fenced code/Mermaid 与 Active Plan 映射。

此前真实 `~/.pi/agent` 只读 smoke test 验证过 stable session ID、模型、thinking level 与 Active Plan，隔离副本也完成过一次真实续写和重启恢复。该人工证据早于本次 TUI 兼容路径移除，因此只能证明会话主链路的历史基线，不能外推为当前所有已安装扩展仍可完成自定义交互；当前 custom/widget 合同以源码和自动测试中的明确 unsupported 行为为准。

无插件直接接管已在临时 agentDir 的真实 `.app` 上验收：App 只读打开 `ui-direct-takeover` 后，原生确认页不含插件、Handoff ID 或 marker 输入；确认后状态变为“可写”并出现 composer。租约 owner 绑定同一 session ID，源 JSONL 的 handoff marker 数量为 0；关闭 App 后租约目录消失，session hash 不变；第二次启动仍恢复相同两条历史并保持只读，等待用户再次直接继续。自动测试另证明未确认 writable 被拒、第二个 Host 在首个租约释放前得到 `SESSION_IN_USE`、静默窗口变化与未知外部条目得到明确冲突。

Swift App 已在真实 `~/.pi/agent` 上完成只读窗口冒烟：Host 握手、最近 60 个会话、当前 stable Session ID 精确搜索、1,202 条当前历史与原生目录选择面板均可达。另以真实 Mermaid 会话验证 flowchart、sequence、state 与 class 的原生呈现、`110%` 缩放、源码复制、图片剪贴板和 `2724 × 398` PNG 导出；gantt 与 pie 显式显示不支持错误并回退原始源码。arm64 本机 App 由 LaunchServices/Finder 路径启动后，进程命令行确认只使用包内 Node 与 Host，`host.hello` 成功、60 个真实会话可见，Finder 环境包含 Homebrew/用户命令目录；App bundle 通过 `codesign --verify --deep --strict`，关窗后内嵌 Node 子进程退出。1233 个 JSONL、约 2.4 GiB 的现实目录下，`session.list(limit=60)` 实测 0.747 秒，随后按 ID `session.inspect` 实测 0.337 秒。该结论仍不代表当前真实会话的最终可写接管或对外分发已经完成。
