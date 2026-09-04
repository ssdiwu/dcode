# 客户端呈现与 D Code Host 写入边界

状态：Accepted（已接受；扩展 ADR 0005、0024 的 D Code 自有呈现原则，并为未来客户端演进建立技术中立边界）

## 背景

当前实现已把 SwiftUI / AppKit、Host Bridge、D Code Product Store、Runtime Supervisor 与 Pi Runtime Adapter 分开，但这些边界仍按 macOS 当前实现描述。未来客户端需要更快地验证 UI / UX，而不能因此把某个 UI 语言、框架或桌面壳伪装成产品架构本身。

同时，`host/` 当前同时承担产品命令、Product Store 写入、Runtime 调度和部分文件 / Git / Shell 副作用。若客户端获得直接文件或数据库访问，D Code 会重新出现两套写入者、不可解释的产品事实和绕过 Task Scope 的副作用。

## 决定

1. **Client Presentation（客户端呈现层）是技术中立的产品边界。** 它负责 D Code 自有的 UI / UX、用户意图、结构化事件呈现和仅影响本设备的视图状态；当前 SwiftUI / AppKit 客户端是一个实现，而非未来唯一实现。Client Presentation 不得直接写 D Code Product Store、Project Directory、Runtime Adapter 私有会话或凭据正文。

2. **Platform Shell（平台壳）只提供系统集成。** 某个客户端可以通过平台壳实现窗口、菜单、快捷键、通知、文件选择和系统权限；平台壳不拥有 Project / Task / Session / Run 产品语义，也不成为绕过 Host 的文件或数据库入口。本决定不选择任何平台壳、UI 语言或框架。

3. **D Code Host（D Code 宿主）是产品命令和写入所有权的唯一边界。** 它校验稳定目标身份、revision、request ID、Task Scope、运行隔离与已声明能力，写入 Product Store，并把结果与事件归属到 Project / Task / Session / Agent Run。当前 Node `host/` 是这一边界的实现；未来可重组其内部模块，但不能出现第二个产品写入者。

4. **Workspace Gateway（工作区网关）执行工作区副作用。** 它由 D Code Host 调用，在 Host 已确定的 Project / User Scope、worktree、执行目录和运行隔离内读写文件、调用 Git / Shell 或管理其他工作区资源。Agent Runtime 只能请求已声明的工具动作；Client Presentation 和 Runtime Adapter 都不得绕过 Host 直接调用 Workspace Gateway。

5. **Runtime Supervisor 与 Runtime Adapter 不拥有 D Code 产品事实。** Runtime Supervisor 管理 Runtime 生命周期、隔离、停止和事件归属；Runtime Adapter 运行 Pi SDK 或未来 Runtime、维护私有会话并返回结构化事件。两者产生的 Session、工具和文件结果只有经 D Code Host 关联、校验和持久化后，才成为 D Code 产品事实。

6. **耐久数据按所有权分开，而不是按客户端复制。** Product Store 是 D Code 产品事实的唯一权威；Project Directory 是项目源码和一等项目文档正文权威；Runtime 私有会话只服务适配运行；可删除缓存与只影响本设备呈现的偏好不成为产品事实。跨客户端可见、会改变 Task / Session 语义的状态必须写入 Product Store。

7. **写入所有权不等于恢复逐动作审批。** ADR 0023 的固定完全访问与无动作级审批结论不变。这里的结构性 Scope 校验约束“哪个组件可以执行哪个类别的写入”，不要求每次文件或工具动作向用户弹出批准对话。

8. **客户端与 Host 的协议必须保持实现中立。** 客户端只能通过版本化的结构化命令、响应和事件与 Host 协作；本决定不要求 HTTP、stdio、WebSocket 或某个前端状态库。任何未来传输替换必须保持单写入、稳定身份、revision / request ID、事件归属与凭据隔离合同。

## 影响

- ADR 0005、0024 中“不使用外部 TUI / 字符界面作为产品 UI”与“界面是可见上下文来源”的语义继续有效；其中把 SwiftUI / AppKit 写成未来唯一客户端实现的表述由本 ADR 取代。当前 macOS 实现事实不被改写。
- 当前 `host/` 可以先在同一 Node 进程内形成 Product Command、Workspace Gateway 与 Runtime Supervisor 的内部模块；本 ADR 不要求立即拆进程或迁移 UI。
- 新客户端只能先消费 Host 的结构化读模型和命令；它不能通过平台壳 API 直接改写项目、Git、`~/.dcode/` 或运行私有会话。
- UI 技术选型、桌面壳选择、跨端范围、具体协议传输与迁移顺序仍是后续独立决策，须以可运行原型和资源 / 体验证据收口。

## 未选择的方案

- **现在锁定 React、Tauri 或任何 UI 技术栈**：把实现选择伪装成产品边界，阻塞后续用原型比较资源、动效和平台体验。
- **Client Presentation 直接访问 Product Store 或 Project Directory**：形成多个写入者，无法保证 Task Scope、revision、审计和恢复事实。
- **Runtime Adapter 直接把私有 Session 或工具结果升格为产品记录**：混淆运行适配状态与 D Code 产品历史，重建 Pi JSONL 双写问题。
- **把 Workspace Gateway 作为独立 Agent 权限拥有者**：文件 / Git / Shell 只执行 Host 的结构性决定，不拥有 Product / Task 语义或独立策略。
