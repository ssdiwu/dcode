# PiDCode internal executable target

`PiDCode` 是 `D Code` 在 macOS 14+ 上保留的内部 executable target；用户可见显示名、应用包名与应用包内可执行文件均为 `D Code`。

- `PiDCodeApp.swift`：SwiftUI App、主工作区设置命令入口，以及退出时 Host 终止兜底。
- `Host/`：定位 Node/Host，编码 Protocol v1，并用 `Process`/`Pipe` 维护请求关联和事件流。
- `Models/`：容错 JSON、Host / Run 快照、Project / Session / Path、草稿、归档 / 置顶、Follow-up Queue、模型 / 认证、本机资源与自定义供应商、文件树、Exact Git Diff、会话变更与验证证据、自构建、搜索、Plan、Markdown / Mermaid / Pi 图片和原生工具 presenter。
- `State/`：`@MainActor` 的 `AppModel` 是跨领域 UI 事务协调点；`SearchModel`、`ActivityModel`、`FollowUpModel`、`ModelSettingsState`、`SelfBuildModel`、`ResourcesModel` 与 `ModelProvidersModel` 分别承载自己的状态。打开会话即取得写入所有权；没有共享观察 / 按需写入路径，冲突会关闭失效所有权并保留草稿供重新接管。
- `Views/`：共享设计 primitive、响应式工作台、导航与信息检查器、Conversation、文件 / Git、Composer / Plan / Run 控制、搜索、路径 / 复制 / 归档，以及模型、本机资源、自定义供应商、自构建、Host 诊断与 About 等原生设置页面。

边界：此 target 不直接读取认证文件，不直接修改 Session JSONL；所有会话写入必须经过 `host/`。
