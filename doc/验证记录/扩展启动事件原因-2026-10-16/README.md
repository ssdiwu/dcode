# 扩展启动事件原因

## 范围

本片只接入 Pi 1.0.0 普通 ExtensionAPI 的 `session_start.reason` 与 `resources_discover.reason`，沿同一 Durable 会话及现有资源 Worker 生命周期传递原因，不增加会话、历史或执行所有者。新 Durable 会话首次正式准备资源时使用 `startup`；已存在会话在首次装载或明确继续时使用 `resume`；同一活跃会话发现扩展资源内容变化并重装 Worker 时使用 `reload`。只读重开本身不启动 Worker、不发事件。D Code 不持有可映射的 Pi 会话文件路径，因此不填造可选 `previousSessionFile`。

## 目标反例与实际结果

修复前的受控反例使用原暂停／关闭／只读重开／明确继续 Runtime 路径。Pi 固定版本 SDK 明确要求重新装载时说明启动原因，但 Worker 将每次新建都写为 `startup`。测试实际观察到恢复后第二个 `session_start` 仍为 `startup`，而目标要求为 `resume`：真实 exit 1。原 Pi 1.0.0 包源码及测试文件身份保存在 `B/Root-coding-session-start-reason-red-20261016/`；该红项只改变目标断言，四个产品源文件在运行前后逐字节相同。

修复后两条 Runtime 目标 2/2 通过：

1. 新会话首次装载记录 `startup`；同一会话暂停、关闭并重开只读时没有新事件；用户明确继续后记录 `resume`，并验证原扩展 `sendUserMessage` 仍沿同一 Durable 输入路径恰好进入一次。
2. 活跃 Worker 发现扩展文件实际变化时，按资源变更执行重新装载；`session_start` 与 `resources_discover` 均收到 `reload`，正式会话输入仍只有两条原操作。

定向红证据在 `B/Root-coding-session-start-reason-red-20261016/`：真实 exit 1，第二个事件收到 `startup` 而目标为 `resume`。修复后 `B/Root-coding-session-start-reason-r4-focused-green-20261016/` 两条目标 2/2、真实 exit 0。

资源重载用例最初把两个用户输入等同于两次 HTTP；受控 coding fixture 会为工具循环产生多个模型请求。该局部计数断言已改为核正式用户记录数及唯一重载事件，不改既有业务断言或期限。

## 完整门槛

固定 `npm run verify` 覆盖按项目入口登记的八项门槛，完整租约原始输出、真实逐门 exit 及门前／门后身份在 `B/Root-coding-session-start-reason-full-gates-r1-20261016/`：架构正反 32/32、源码架构检查 83 项、TypeScript、Lint、构建、Runtime 481/481、契约 14/14、隐藏桌面 E2E 125/125。八门各自真实 exit 0，门前后及全轮 canonical 映射一致，189 项 SHA-256 aggregate `ab4cc85843337f819d4a1fd5bea72bb3a6e805b8e09d966dc13869bc2f61130c`；无 fail／skip／cancel。Lint 为 0 error、1 项既有 `Timeline.tsx` warning。r2 固定候选及完整证据经独立审查 Standards／Spec／CodeQuality 三项 PASS，Root 已接收本片限定范围；复核报告为 `B/Root-coding-session-start-reason-r2-independent-review-20261016.md`。该接收只覆盖本节所述事件原因映射，不代表完整 Pi SDK 或整产品通过。

## 实现依据与边界

执行端在打开 Durable 存储时记录当前根是否已存在，并在正式资源准备／明确继续时把相应的 `startup` 或 `resume` 原因交给扩展 Worker。Worker 的实际资源摘要变化分支使用 `reload`；`resources_discover` 仅接受 SDK 规定的 `startup`／`reload` 两值。实现复用固定 `@earendil-works/pi-coding-agent` 1.0.0 的公开事件合同，没有修改第三方包。

本片不覆盖 Pi SDK 的全部会话原因（例如 SDK 原生 `new`／`fork` 与会话文件地址）、全部消息／压缩事件、typed/native provider、vision、`exec` 或完整 SDK 接入；不证明真实服务商账户、前台人工接受或整体产品完成。完整 SDK 与整体产品仍未验收。
