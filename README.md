# D Code

`D Code` 是面向 macOS 的 Pi 原生桌面客户端。名称中的 `D` 取自创作者长期使用的网名 `diwu`。它继续使用现有 Pi 会话、配置与 Pi SDK 运行能力，同时把聊天、活动 Plan、Mermaid 和结构化产物呈现为可选择、复制、缩放和持续恢复的原生界面。既有扩展可以作为能力机制参考或提供结构化标准交互，但不定义 D Code 的产品界面。

## 面向谁

面向已经使用 Pi CLI 和自研扩展，希望在不丢失现有会话与能力的前提下获得 macOS 原生工作体验的用户。

## 当前状态

`0.0.1` 是首个已验收的源码版本：User Home（用户首页）、D Code Project（项目）、多 Source Folder（源文件夹）、响应式三栏、项目文件树、只读 Git Changes（Git 变更），以及集中在 Composer（输入框）的模型、思考强度、极速和上下文占用均已落到原生 App；原生 Settings（设置）可切换系统/浅色/深色外观与工作台布局。Recent Sessions（最近会话）只显示由 D Code 新建并带有效来源标记的 Pi 会话；既有 Pi 会话只有在关联 Project 的 Source Folder 后才显示于该项目。打开后的会话默认以正常对话界面持续观察，外部已落盘消息会自动刷新；发送或修改运行设置时才取得单写入权，冲突后保留草稿并回到持续观察。Node/Pi Host 已通过 61 项自动测试；SwiftUI/AppKit 客户端通过 36 项 Swift 测试。现有聊天、Active Plan、Mermaid、结构化交互与单写入安全边界继续保留。当前产品与验收权威见：

- [0.0.1 用户首页与项目工作台产品需求](doc/40-版本实施方案/0002-0.0.1-用户首页与项目工作台产品需求.md)
- [原生会话基线产品需求](doc/40-版本实施方案/0001-首个可日常使用版本产品需求.md)
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
- 会话同步：选择既有会话即进入持续观察，不显示默认只读模式；发送或修改运行设置时取得空闲会话的单写入权。外部写入触发停止、刷新与草稿保留，不支持两个客户端同时写或在途热迁移。

## 许可证

D Code 的原创代码、设计、品牌、资产与作者拥有的编译产物部分采用
`All Rights Reserved（保留所有权利）`。本仓库是公开可见源码的专有软件，
不是 `Open Source（开源软件）`。完整边界见 [LICENSE](LICENSE)。

Pi、Node.js、grok-mermaid 与其他第三方组件继续受各自许可证约束；D Code
不主张这些组件的所有权，也不限制其许可证已经授予的权利。归属、固定版本
与分发方式见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
