# PiDCode internal executable target

`PiDCode` 是 `D Code` 在 macOS 14+ 上保留的内部 executable target；用户可见显示名、应用包名与应用包内可执行文件均为 `D Code`。

- `PiDCodeApp.swift`：SwiftUI App 与 Settings scene 入口，以及退出时 Host 终止兜底。
- `Host/`：定位 Node/Host，编码 Protocol v1，并用 `Process`/`Pipe` 维护请求关联和事件流。
- `Models/`：容错 JSON 值、Host 快照、Project、逐路径草稿、D Code 归档与置顶、按需文件树、只读 Git 查询、结构化扩展对话框、Active Plan、Mermaid、Conversation Round、对话导航投影、Markdown 呈现与工具安全 presenter。
- `State/`：`@MainActor` 的 AppModel；这里是 Project/Session/Path 选择、Prompt transaction、草稿持久化、完整复制、直接归档/恢复、分页前置顶排序、共享会话刷新、按需写入、冲突恢复、Host 事件和 Mermaid 请求缓存的唯一 UI 写入点。
- `Views/`：原生响应式三栏、User Home、带置顶/归档 Hover 的 Project/Session 左栏、非模态 Work Inspector、Composer、路径谱系、复制目标、已归档会话、Settings、轮次级 tool/thinking 折叠、对话导航尺、Active Plan、代码/Mermaid 内容块和结构化扩展对话框。

边界：此 target 不直接读取认证文件，不直接修改 Session JSONL；所有会话写入必须经过 `host/`。
