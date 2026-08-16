# PiDCode internal executable target

`PiDCode` 是 `D Code` 在 macOS 14+ 上保留的内部 executable target；用户可见显示名、应用包名与应用包内可执行文件均为 `D Code`。

- `PiDCodeApp.swift`：SwiftUI App、主工作区设置命令入口，以及退出时 Host 终止兜底。
- `Host/`：定位 Node/Host，编码 Protocol v1，并用 `Process`/`Pipe` 维护请求关联和事件流。
- `Models/`：容错 JSON 值、Host 快照与 Run State、Activity Attention Store、Project 与 Session 精确归属、逐路径草稿、D Code 归档 / 置顶 / 会话变更账本、单根平铺 / 多根分组的按需文件树、只读 Git 查询、结构化扩展对话框、Active Plan、Mermaid、Pi 图片内容、Conversation Round、对话导航投影、Markdown 呈现与工具安全 presenter。
- `State/`：`@MainActor` 的 AppModel；这里是 Project/Session/Path 选择、Navigation / Activity 会话栏投影、Prompt transaction、稳定完成关注态、草稿持久化、完整复制、直接归档/恢复、全局置顶投影、会话级已确认变更聚合、共享会话刷新、按需写入、冲突恢复、Host 事件和 Mermaid 请求缓存的唯一 UI 写入点。
- `Views/`：共享 surface / elevation / geometry token 与 primitive、可调会话栏 / 信息检查器的原生响应式工作台、顶部会话身份与操作入口、User Home、Navigation / Activity 双投影、带全局置顶区与非模态 Hover 详情的 Project/Session 会话栏、顶部直达“会话 / 文件 / 变更”的悬浮式非模态信息检查器、Plan / 会话变更摘要、统一 Run / Queue 控制的 Interaction Dock、模型名称左侧的上下文剩余量圆环、合并模型 / 推理强度 / 速度并标识 Pi 默认项的 Composer 运行设置菜单、路径谱系、复制目标、当前窗口内带页内导航、受限内容宽度、归档管理与“关于 D Code”子页的 Settings 工作台页面、轮次级 tool/thinking 折叠、对话导航尺、Markdown / 代码 / Mermaid / Pi 图片内容块和结构化扩展对话框。

边界：此 target 不直接读取认证文件，不直接修改 Session JSONL；所有会话写入必须经过 `host/`。
