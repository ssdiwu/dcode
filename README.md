# D Code

`D Code` 是面向 macOS 的原生 Agent 工作台：Pi 提供底层运行基座，D Code 自有 Harness（能力承载与编排层）定义产品能力、生命周期和原生界面。名称中的 `D` 取自创作者长期使用的网名 `diwu`。它继续使用现有 Pi 会话、配置与 Pi SDK 运行能力，同时把聊天、活动 Plan、Mermaid 和结构化产物呈现为可选择、复制、缩放和持续恢复的原生界面。既有扩展可以作为能力机制参考或提供结构化标准交互，但不定义 D Code 的产品界面。

## 面向谁

面向已经使用 Pi CLI 和自研扩展，希望在不丢失现有会话与能力的前提下获得 macOS 原生工作体验的用户。

## 当前状态

`v0.0.1` 是首个已验收并发布的源码版本：User Home（用户首页）、D Code Project（项目）、多 Source Folder（源文件夹）、响应式三栏、项目文件树、只读 Git Changes（Git 变更），以及集中在 Composer（输入框）的模型、思考强度、极速和上下文占用均已落到原生 App；原生 Settings（设置）可切换系统/浅色/深色外观与工作台布局。Recent Sessions（最近会话）只显示由 D Code 新建并带有效来源标记的 Pi 会话；既有 Pi 会话只有在关联 Project 的 Source Folder 后才显示于该项目。打开后的会话默认以正常对话界面持续观察，外部已落盘消息会自动刷新；发送或修改运行设置时才取得单写入权，冲突后保留草稿并回到持续观察。

`0.0.2` 当前为等待 507 人工验收的实现候选：左栏按钮与全局 `Command-K` 打开原生搜索浮层，搜索 D Code Recent 与已关联 Project 的可见会话标题、当前活动路径中的用户正文和助手正文；结果可按 Project / Source Folder 筛选、按稳定 Session ID 打开，并以 Entry ID 定位和高亮命中消息。索引是可删除、可重建的本机 SQLite FTS5 缓存，由独立 Worker（工作线程）维护；浮层显示期间以轻量文件身份探测发现非当前会话的外部新增、更新与删除，只有漂移后才重建对应索引。它不取得 Session Lease、不修改 Pi JSONL，也不索引 thinking、工具载荷、工具结果或认证字段。Node/Pi Host 已通过 90 项自动测试；SwiftUI/AppKit 客户端通过 50 项 Swift 测试。现有聊天、Active Plan、Mermaid、结构化交互与单写入安全边界继续保留。当前产品与验收权威见：

`v0.0.3` 已固定为本地回归基线，仍与 `0.0.2` 一起等待 507 联合人工验收：同一 Pi Session 可查看真实路径谱系，从用户消息“编辑并重走”或从助手消息继续，并按 Session / Path 独立保存本机草稿；会话菜单提供“复制到项目…”与“复制到项目并归档原会话…”。复制使用新 Session ID 与目标 Source Folder `cwd`，保留完整已持久化历史和源谱系，源 Pi JSONL 不改；用户也能直接归档当前可见会话，或在 Recent / Project 行悬停与键盘聚焦时置顶、归档。置顶只在原本成立的可见集合中、分页前排序；归档只影响 D Code 的普通导航和搜索，可从“已归档会话”恢复，并保留草稿与置顶状态。新建 Session 在 Header 与 D Code 来源完整落盘后立即进入 Recent，不再等待旧可写 Runtime 最长十余秒的安全清理；空的 D Code 会话可从 Recent 右键菜单或会话菜单移到 macOS 废纸篓，非空、旧 Pi、可写或有子会话引用的对象不允许该操作。Work Inspector 在空间允许时作为非模态右栏常驻，不再给其他区域添加蒙版；会话按用户消息投影为工作轮，完成后默认只保留最终回答与“耗时 / 工具数 / 完成时间”摘要，中间 Thinking、工具与过程回复按轮折叠，运行中只显示当前活动。助手 Markdown 保留原段落、空行与列表换行。长会话左缘的对话导航尺以工作轮为刻度，悬停预览问题与最终回答，点击只滚动当前会话路径，定位历史后可“回到最新”恢复自动追尾。`pi-dhashline` 继续在 Host 中提供 read/edit/write/search 的安全执行能力，D Code 使用自有 SwiftUI presenter 呈现锚点、边界行与 diff，不调用其 `pi-tui` renderer。Host 通过隐藏暂存、严格流式校验和原子发布避免半成品可见，并在分页、排序和搜索截断前排除归档对象。当前完整回归为 Host `116/116`、Swift `81/81`。

- [0.0.2 可见会话搜索产品需求](doc/40-版本实施方案/0003-0.0.2-可见会话搜索产品需求.md)
- [0.0.3 会话路径与复制归档产品需求](doc/40-版本实施方案/0004-0.0.3-会话路径与复制归档产品需求.md)（`v0.0.3` 本地回归基线，等待与 `v0.0.2` 联合人工验收）
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
