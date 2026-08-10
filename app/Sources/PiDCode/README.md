# PiDCode internal executable target

`PiDCode` 是 `D Code` 在 macOS 14+ 上保留的内部 executable target；用户可见显示名、应用包名与应用包内可执行文件均为 `D Code`。

- `PiDCodeApp.swift`：SwiftUI App 入口与退出时 Host 终止兜底。
- `Host/`：定位 Node/Host，编码 Protocol v1，并用 `Process`/`Pipe` 维护请求关联和事件流。
- `Models/`：容错 JSON 值、Host 快照、结构化扩展对话框、Active Plan、Mermaid 和 transcript 投影。
- `State/`：`@MainActor` 的 AppModel；这里是窗口状态、会话生命周期、Host 事件和 Mermaid 请求缓存的唯一 UI 写入点。
- `Views/`：原生 split view、历史、composer、tool/thinking、Active Plan、代码/Mermaid 内容块和结构化扩展对话框。

边界：此 target 不直接读取认证文件，不直接修改 Session JSONL；所有会话写入必须经过 `host/`。
