# D Code

`D Code` 是面向 macOS 的原生 `ADE（智能体开发环境）`。D Code 自己拥有 Project、Task、D Code Session、上下文、一等项目文档、Agent Team、能力模块、模型资源、产物、证据和自进化；Pi SDK 是首个 Agent Runtime，为模型循环和工具执行提供运行基座，但不定义 D Code 的产品身份、数据格式、界面或品牌。名称中的 `D` 取自创作者长期使用的网名 `diwu`。

## 面向谁

面向希望以项目和任务组织长期 AI 开发工作，并在一个原生 macOS 环境中使用多会话、多个 Agent、项目知识、需求、设计和证据持续推进真实产品的开发者。既有 Pi 用户可以导入旧会话和能力来源，但 Pi CLI 兼容不再定义 D Code 的产品边界。

## 当前能力与版本状态

D Code 由 D Code Product Store 持久化项目、任务、会话、模型与能力配置，通过 Runtime Adapter 使用 Pi SDK 等 Agent Runtime；Pi JSONL 只作为可选择的单向导入来源。难逆转边界见 [ADR 0037](doc/决策档案/0037-D-Code-原生产品数据权威与-Pi-单向导入边界.md)。

当前客户端主路径位于 `client/`：Electron + React 工作台消费 Host 的 Project / Task / Session、模型与能力配置、消息附件和灵感数据，并提供文件树、Markdown/HTML 编辑、隔离预览与 Git 差异查看。产品事实与恢复状态归当前用户 `~/.dcode/`，Pi JSONL 不双写。`app/` 保留尚未完成退役的 Swift 客户端源码；基本验收、未迁移内容面与后续清理状态由[版本实施方案](doc/40-版本实施方案/README.md)维护。

发布、实现候选、本地回归基线、人工验收与各版本自动验证记录统一由[版本实施方案](doc/40-版本实施方案/README.md)路由；根 README 不复制这些会随交付推进而变化的状态。

开发入口：先执行 `npm --prefix host run build`，再执行 `npm --prefix client run dev`。验证入口为 `npm --prefix host test`、`npm --prefix client test`；Web 客户端的布局、输入、打包与隔离运行方式见 [client/README](client/README.md)。旧 Swift 路径保留 `swift test`、`swift run PiDCode` 与 `app/build.sh` 供迁移收尾使用。`PiDCode`、`pi-dcode` 只保留为既有兼容标识。

## 文档入口

- [项目术语](GLOSSARY.md)
- [产品宪章](PRODUCT.md)
- [设计文档](DESIGN.md)
- [文档总览](doc/README.md)
- [产品与交互目标态](doc/20-产品与交互/README.md)
- [工作台交互原型](doc/20-产品与交互/原型/README.md)
- [外部产品与仓库参考](doc/参考文件/README.md)
- [决策档案](doc/决策档案/README.md)
- [架构与运行](doc/10-架构与运行/README.md)
- [原生界面设计系统](doc/10-架构与运行/0002-D-Code-原生界面设计系统.md)
- [版本实施方案](doc/40-版本实施方案/README.md)

## 目录

- `host/`：固定 Pi 0.84.4 的 Node 运行宿主、Protocol v1 与测试。
- `client/`：当前 Web 客户端（Electron 平台壳 + React 呈现层），经 Protocol v1 消费 D Code Host；入口和结构见其 README。
- `app/`：现有 macOS SwiftUI/AppKit 客户端与 Host 桥（`0.0.29` 基线；`0.0.30` 起按面替换、验证即删）；Web 客户端选型见[架构与运行](doc/10-架构与运行/README.md)。
- `Package.swift`：macOS 14+ SwiftPM 可执行包入口。
- `PRODUCT.md`：稳定产品宪章；`DESIGN.md`：设计性格、体验原则与详细设计权威入口。
- `GLOSSARY.md`：项目专有术语的根目录唯一权威；机器索引只能从它派生。
- `doc/`：当前架构、产品目标、PRD、架构决策、参考与验收权威。

## 核心边界

- 平台：macOS。
- 产品数据与配置权威：D Code Product Store；Pi 配置与 JSONL 只服务适配运行、旧来源和显式单向导入。
- 数据根与用户任务：产品数据统一进入当前用户的 `~/.dcode/`；未选择 Project 的 Task 属于 User Scope 并默认在用户 Home Directory 工作，不建立“未选项目”伪 Project。
- 界面：自有客户端界面，技术选型由[架构与运行](doc/10-架构与运行/README.md)拥有；HTML 原型等内容可在后续使用系统提供的嵌入式视图。
- 呈现：D Code 不直接依赖或调用 `pi-tui`；所有用户可见界面由自有客户端组件或受控内容渲染器实现。
- 扩展：Goal、Agent Team 等成立机制由 D Code 原生重做；Pi 扩展只作为迁移与机制来源，不成为产品身份或永久运行时依赖。
- Agent 身份：每个 D Code Runtime 使用 D Code 自有 System Prompt，完整替换 Pi 通用身份，并从本轮真实注册工具生成活动工具清单与 Prompt Receipt。
- 会话迁移：Pi Session 可以一次性导入为新的 D Code Session；导入后不双写、不持续同步，完整导出以 D Code 自有格式为准。
- 自举开发：Creation Mode（全局创造模式）只用于开发和自进化 D Code 自身，沿用隔离候选、显式重启、恢复、人工验收与回滚，不是权限模式或热迁移。

## 许可证

D Code 的原创代码、设计、品牌、资产与作者拥有的编译产物部分采用
`All Rights Reserved（保留所有权利）`。本仓库是公开可见源码的专有软件，
不是 `Open Source（开源软件）`。完整边界见 [LICENSE](LICENSE)。

Pi、Node.js、grok-mermaid 与其他第三方组件继续受各自许可证约束；D Code
不主张这些组件的所有权，也不限制其许可证已经授予的权利。归属、固定版本
与分发方式见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
