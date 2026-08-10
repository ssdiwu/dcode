# D Code

`D Code` 是面向 macOS 的 Pi 原生桌面客户端。名称中的 `D` 取自创作者长期使用的网名 `diwu`。它继续使用现有 Pi 会话、配置与 Pi SDK 运行能力，同时把聊天、活动 Plan、Mermaid 和结构化产物呈现为可选择、复制、缩放和持续恢复的原生界面。既有扩展可以作为能力机制参考或提供结构化标准交互，但不定义 D Code 的产品界面。

## 面向谁

面向已经使用 Pi CLI 和自研扩展，希望在不丢失现有会话与能力的前提下获得 macOS 原生工作体验的用户。

## 当前状态

项目处于首个可日常使用版本的实现阶段。Node/Pi Host 已通过 37 项自动测试与真实续写/重启恢复；SwiftUI/AppKit 原生客户端通过 16 项 Swift 测试以及真实 `~/.pi/agent` 的只读窗口冒烟。侧栏先按 `cwd` 工作区组织会话，App 可直接创建新会话，或在用户确认其他客户端已停止使用后继续既有会话；不要求 CLI 插件、交接 ID 或 marker。Host 会自动回收已确认 owner 进程消失的失效租约，同时保留仍存活或不可验证的租约。活动 dgoal Plan 已可恢复、实时更新和展开；Markdown 围栏中的代码与 Mermaid 已可原生呈现，支持缩放、复制源码/图片、PNG 导出，并对不支持的图表类型显式回退源码。本机 arm64 `.app` 已内嵌 Node、Host 与生产依赖，可由 Finder 独立启动；无插件直接接管已通过隔离 App 验收。当前产品与验收权威见：

- [首个可日常使用版本产品需求](doc/40-版本实施方案/0001-首个可日常使用版本产品需求.md)
- [Node/Pi 宿主与 IPC](doc/10-架构与运行/0001-Node-Pi-宿主与-IPC.md)

验证入口：`cd host && npm test`、`swift test`。开发运行入口：先构建 Host，再执行 `swift run PiDCode`；本机 App 构建入口：`./app/build.sh`，产物位于 `dist/D Code.app`。项目目录使用 `dcode` 技术名；`PiDCode` 仅保留为内部 Swift 可执行目标名，Host 包名、环境变量与租约目录继续保留既有 `pi-dcode` 兼容标识。

## 文档入口

- [文档总览](doc/README.md)
- [产品与交互目标态](doc/20-产品与交互/README.md)
- [工作台交互原型](doc/20-产品与交互/原型/README.md)
- [外部产品与仓库参考](doc/参考文件/README.md)
- [术语表](doc/术语表.md)
- [决策档案](doc/决策档案/README.md)
- [架构与运行](doc/10-架构与运行/README.md)
- [版本实施方案](doc/40-版本实施方案/README.md)

## 目录

- `host/`：固定 Pi 0.84.1 的 Node 运行宿主、Protocol v1 与测试。
- `app/`：macOS 原生 SwiftUI/AppKit 界面、Host 桥、状态与测试。
- `Package.swift`：macOS 14+ SwiftPM 可执行包入口。
- `PRODUCT.md`、`DESIGN.md`：产品设计上下文与从真实组件派生的视觉/交互规则。
- `doc/`：产品需求、当前架构、项目术语、架构决策与验收权威。

## 核心边界

- 平台：macOS。
- 会话与配置权威：现有 `~/.pi/agent`。
- 界面：Swift 原生界面；HTML 原型等内容可在后续使用系统提供的嵌入式视图。
- 呈现：D Code 不直接依赖或调用 `pi-tui`；所有用户可见界面由自有 SwiftUI/AppKit 组件或受控内容渲染器实现。
- 扩展：标准结构化交互可以通过 Host 进入原生界面；`custom`、Widget 等 TUI 能力会显式阻止或忽略，不提供终端兼容面。Goal、Agent Team 等产品能力只借鉴外部扩展机制，不要求对应扩展成为运行时依赖。
- 会话交接：App 内直接确认并取得空闲会话的单写入所有权，不需要 CLI 插件；不支持在途热迁移。
