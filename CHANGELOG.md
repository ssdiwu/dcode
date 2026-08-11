# Changelog

本项目的用户可感知变化遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 记录，并以 Git tag 作为版本边界。

## [Unreleased]

### Added

- `0.0.2` 可见会话搜索候选：通过左栏入口或 `Command-K` 打开原生浮层，搜索 D Code Recent 与已关联 Project 的会话标题、当前活动路径用户正文和助手正文；支持 Project / Source Folder 筛选、稳定 Session ID 打开、Entry ID 定位和短暂高亮。
- 全局“新建会话”直接使用当前 macOS 用户目录作为 `cwd`，不再弹出文件夹选择器；Project 内新建仍从已登记 Source Folder 中选择。
- Host 使用固定 Node 运行时内置的 SQLite FTS5 与独立 Worker 建立可删除、可重建的本机索引；中文使用单字与重叠双字词，相邻短语按连续位置匹配，结果片段指向真实命中；查询时再次强制可见范围，不索引 thinking、工具载荷、工具结果、认证字段或非当前会话路径。
- 搜索浮层显示期间每秒执行一次轻量文件身份探测：只遍历 JSONL 路径并读取已判定可见候选的文件元数据；非当前会话被外部新增、更新或删除后自动使缓存失效，检测到漂移后才进入完整索引刷新。

### Changed

- App/Host 兼容门禁提升到 `0.0.2` 并要求 `sessionSearch` 能力；搜索和索引不会取得 Session Lease 或修改 Pi JSONL，正在追加的半条目会保持索引未完成并按指纹退避重试，刷新期间的新失效信号不会丢失。运行期 SQLite 缓存损坏只进行一次安全重建；持续失败会锁存为可操作错误，等待显式重试，不形成重建循环。

## [0.0.1] - 2026-08-11

### Added

- `0.0.1` 原生工作台：冷启动 User Home、由 D Code 新建的最近会话每次 10 条递增加载、D Code Project 与多 Source Folder、关联文件夹后发现旧 Pi 会话、项目内跨文件夹平铺会话、响应式三栏、按需只读文件树及真实只读 Git Changes。
- macOS 原生 Settings 窗口与左栏齿轮入口，用于持久化系统/浅色/深色外观、左栏和宽屏工作检查器偏好，并可恢复默认布局。
- Project 元数据使用本机版本化 JSON 原子保存；规范化目录全局唯一，跨项目移动需要再次确认，损坏或不支持的资料会保留原文件并禁用后续写入。
- Composer 集中真实模型、思考强度、Context Usage 与 D Code 自有极速状态；极速按 Session 持久化，只在支持的 `openai-codex` 模型请求 `service_tier: priority`。
- Protocol v1 增加 `session.list.cwdScope`、`session.list.origin`、`session.refresh`、`session.setFastMode`、Context Usage/Fast state；`session.create` 在初始 JSONL 中写入不进入模型上下文的 D Code 来源标记，Recent 在分页前据此筛选。初始文档发布后即确认创建，后续可写激活失败会返回已创建对象并降级为观察或明确不可用，不产生重启后才出现的幽灵会话。App 会在读取会话前校验 Host 版本与 0.0.1 必需能力。

- Node/Pi Host Protocol v1、Session Lease、持续会话观察与按需写入、失效租约自动恢复、结构化 Extension UI Bridge、父进程消失后的有界退出与原生 Unicode Mermaid 渲染动作。
- macOS 14+ SwiftUI/AppKit 原生工作区侧栏、Recent 与 Project 会话导航、显式“新会话/重新载入”动作、历史/工具/Thinking 展示、会话创建与打开入口、流式 Composer、活动 Plan 浮层、代码/Mermaid 内容块和原生扩展对话框。
- Swift Host 子进程桥、连续 JSONL 请求关联、streaming/persisted 回复去重、Finder 环境补全、诊断脱敏与真实会话观察冒烟；Mermaid 支持缩放、复制源码/图片、PNG 导出及不支持类型的显式源码回退。
- 本机 arm64 `D Code.app` 装配脚本：内嵌 Node 22、Host 与生产依赖，使用本地 ad-hoc 签名，无需手动启动辅助服务。
- `D Code.app` 增加首枚临时品牌图标：以层叠 `D` 形工作台为主体，使用石墨外层与琥珀色工作内层，并随本机 App 构建写入 `.icns` 资源。
- 既有会话可在 App 内持续观察，发送或修改运行设置时以本次操作表达写入意图；Host 通过静默窗口、原子租约和外部写入检测保护单写入，不要求 CLI 插件或 Handoff ID。D Code 创建来源标记只控制 Recent 导航可见性，不充当写入锁或接管凭据。
- 增加 D Code 专有源码可见声明、第三方许可证索引与构建期许可证清单；本机 App Bundle 随包保留 Node.js、Pi、Apache-2.0 及缺失 npm 包的许可与归属信息。

### Changed

- Composer 的占位文字与光标改由同一原生多行文本控件排版；删除通用“能力状态”常驻菜单。Pi RPC 的工具展开查询恢复中性 `false` / no-op（空操作），被忽略的展示提示不再上浮全局警告。
- 既有 Pi 会话不再显示默认“只读/继续”界面：D Code 以正常 Composer 持续观察当前 JSONL，文件身份变化后从已知路径刷新；发送或修改运行设置时按需取得租约。外部同时写入会中止 D Code 写入、释放所有权、保留草稿并返回持续观察。
- D Code 删除对 `@earendil-works/pi-tui` 的直接依赖、Host headless TUI 渲染、Protocol custom input/resize，以及 Swift 兼容面板和 widget 呈现；标准结构化扩展对话框与状态仍保留，custom/widget 等 TUI 请求改为显式阻止或忽略。`pi-coding-agent` 私有传递依赖中的 `pi-tui` 保留但不由 D Code 调用。
- `extension.respond` 在进程入口绕过普通请求队列，结构化扩展对话不会再与等待响应的 `session.prompt` 互相阻塞；会话关闭或 Host 结束时同时清理原生扩展界面状态。
- 建立 `doc/参考文件/`，记录 Codex、ZCode、MiniMax Code、PiDeck、Flue、Orca、pi-intercom 与 pi-messenger 的借鉴点和不采用边界。
- 产品交互契约与原型统一为“点击 Project 直接查看全部 Source Folder 文件树、项目下跨文件夹平铺 Pi Session、来源文件夹作为会话副标题”；版本演进相应调整为 `0.0.1` 建立项目文件范围、`0.0.4` 提供中央标签与普通文件只读查看、`0.0.5` 提供 Markdown/HTML 未保存缓冲区即时预览。此项只记录目标与原型，不表示原生 App 已实现。
- 产品交互契约与原型将模型与思考强度、极速开关、上下文占用集中到 Composer 底部；Work Inspector 的 Context 只呈现当前路径与已加载来源，顶部运行状态不再重复这些输入状态。此项只记录目标与原型，不表示原生 App 已实现。
- 用户可见产品名、应用包与界面文案统一为 `D Code`，其中 `D` 取自创作者长期使用的网名 `diwu`；项目目录使用 `dcode`，内部 Swift 目标、Host 包名、环境变量、Bundle ID 与租约目录保留既有兼容标识。
- 有界 `session.list` 在解析摘要前先按文件 mtime 选择最近候选；现实 1233 个会话、约 2.4 GiB 下，最近 60 项列表降至亚秒级。
