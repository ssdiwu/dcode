# D Code

`D Code` 是面向 macOS 的原生 Agent 工作台：Pi 提供底层运行基座，D Code 自有 Harness（能力承载与编排层）定义产品能力、生命周期和原生界面。名称中的 `D` 取自创作者长期使用的网名 `diwu`。它继续使用现有 Pi 会话、配置与 Pi SDK 运行能力，同时把聊天、活动 Plan、Mermaid 和结构化产物呈现为可选择、复制、缩放和持续恢复的原生界面。既有扩展可以作为能力机制参考或提供结构化标准交互，但不定义 D Code 的产品界面。

## 面向谁

面向已经使用 Pi CLI 和自研扩展，希望在不丢失现有会话与能力的前提下获得 macOS 原生工作体验的用户。

## 当前能力与版本状态

D Code 当前以原生 macOS 工作台呈现 Pi 会话，并由自己的 `Harness（能力承载与编排层）` 负责 Project（项目）、会话可见性、工作上下文、本机状态、生命周期、安全写入边界和结构化原生界面。已经实现的组件关系与运行边界见[架构与运行](doc/10-架构与运行/README.md)。

发布、实现候选、本地回归基线、人工验收与各版本自动验证记录统一由[版本实施方案](doc/40-版本实施方案/README.md)路由；根 README 不复制这些会随交付推进而变化的状态。

验证入口：`cd host && npm test`、`swift test`。开发运行入口：先构建 Host，再执行 `swift run PiDCode`；本机 App 构建入口：`./app/build.sh`，产物位于 `dist/D Code.app`。项目目录使用 `dcode` 技术名；`PiDCode` 仅保留为内部 Swift 可执行目标名，Host 包名、环境变量与租约目录继续保留既有 `pi-dcode` 兼容标识。

## 文档入口

- [文档总览](doc/README.md)
- [产品与交互目标态](doc/20-产品与交互/README.md)
- [工作台交互原型](doc/20-产品与交互/原型/README.md)
- [外部产品与仓库参考](doc/参考文件/README.md)
- [术语表](doc/术语表.md)
- [决策档案](doc/决策档案/README.md)
- [架构与运行](doc/10-架构与运行/README.md)
- [原生界面设计系统](doc/10-架构与运行/0002-D-Code-原生界面设计系统.md)
- [版本实施方案](doc/40-版本实施方案/README.md)

## 目录

- `host/`：固定 Pi 0.84.1 的 Node 运行宿主、Protocol v1 与测试。
- `app/`：macOS 原生 SwiftUI/AppKit 界面、Host 桥、状态与测试。
- `Package.swift`：macOS 14+ SwiftPM 可执行包入口。
- `PRODUCT.md`：当前产品实现上下文；`DESIGN.md`：设计性格与权威文档入口。
- `doc/`：产品需求、当前架构、项目术语、架构决策与验收权威。

## 核心边界

- 平台：macOS。
- 会话与配置权威：现有 `~/.pi/agent`。
- 界面：Swift 原生界面；HTML 原型等内容可在后续使用系统提供的嵌入式视图。
- 呈现：D Code 不直接依赖或调用 `pi-tui`；所有用户可见界面由自有 SwiftUI/AppKit 组件或受控内容渲染器实现。
- 扩展：标准结构化交互可以通过 Host 进入原生界面；`custom`、Widget 等 TUI 能力会显式阻止或忽略，不提供终端兼容面。Goal、Agent Team 等产品能力只借鉴外部扩展机制，不要求对应扩展成为运行时依赖。
- 会话同步：打开既有会话即取得写入所有权（[ADR 0018](doc/决策档案/0018-打开即接管与单写入所有权.md)），没有只读观察模式；D Code 实例间租约可抢占，被接管方以明确冲突退出。外部写入触发停止、草稿保留与一键重新接管，不支持两个客户端同时写或在途热迁移。

## 许可证

D Code 的原创代码、设计、品牌、资产与作者拥有的编译产物部分采用
`All Rights Reserved（保留所有权利）`。本仓库是公开可见源码的专有软件，
不是 `Open Source（开源软件）`。完整边界见 [LICENSE](LICENSE)。

Pi、Node.js、grok-mermaid 与其他第三方组件继续受各自许可证约束；D Code
不主张这些组件的所有权，也不限制其许可证已经授予的权利。归属、固定版本
与分发方式见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
