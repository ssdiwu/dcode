# AppModel 域拆分与宿主注入测试边界

状态：Accepted（已接受；约束 `0.0.8` 及后续版本）

## Context（背景）

`0.0.7` 收口时，`AppModel` 已经膨胀为约 4,500 行、183 个方法的单一 `@Observable` 类型：搜索、活动、模型设置 / 认证、后续队列、转录与流式全部共用一个状态容器，`handle(_:)` 事件分发单函数超过 200 行。第三方审计与 `0.0.8` 规划一致确认两个后果：状态按域分组不可辨认，以及 UI 状态机几乎无法在无真实 Pi Host 的前提下做自动回归——`PiHostClient` 直接 spawn Node 进程，测试要么连真实 `~/.pi/agent`，要么只测纯函数。

同时项目没有 xcodeproj（SwiftPM + `app/build.sh` 手工组包），XCUITest 无法在不新建工程包装的前提下落地；ViewInspector 0.10.3 对 `@Environment(AppModel.self)` 的支持存在已知缺陷（修复在未发布的 0.10.4），复杂视图树还会触发 `unsafeBitCast` 崩溃。

## Decision（决定）

1. AppModel 保持 `@MainActor` 协调者身份，但领域状态下沉到自有 `@Observable` 子模型：`SearchModel`、`ActivityModel`、`ModelSettingsState`、`FollowUpModel`。子模型只拥有状态与域内叶子操作；跨域编排（打开会话、发送、结算、与宿主通信）继续留在 AppModel，视图通过 `model.search.*`、`model.activity.*` 等嵌套路径访问。
2. 宿主依赖面收敛为 `HostProviding` Actor 协议（`start`、`request`、`requestValue` 便捷重载、`shutdown`、`lifecycle`）。生产实现仍是 `PiHostClient`；AppModel 通过 init 注入 client factory，测试注入脚本化 `FakeHostClient`（按 method 匹配响应、记录请求、主动注入 HostEvent），本地 store 全部指向临时目录，不触碰真实 Pi 会话与用户配置。
3. `handle(_:)` 保留为唯一事件入口，但只做事件族路由：会话 / Plan、扩展、模型认证、宿主生命周期四组 case 原样迁移到 `AppModel+SessionEvents` 等扩展文件。事件语义不因拆分改变；被跨文件引用的成员从 `private` 放开为模块内可见。
4. 渲染测试采用混合策略：环境无关的简单视图可用 ViewInspector（精确锁 0.10.3，仅测试目标依赖，不进 app bundle）；依赖 `@Environment(AppModel.self)` 的主界面一律用 `NSHostingView` 真实宿主渲染冒烟，断言关键状态可布局、不崩。行为断言交给 Fake-host 集成测试，不追求像素级 UI 断言。
5. 转录、流式、Prompt 结算与 Follow-up 结算时序本轮继续留在 AppModel 本体：它们与流式状态与结算门禁深度耦合，是下一轮拆分的独立决策点，不与状态分组混在一次变更里。

## Consequences（影响）

- AppModel 从约 4,500 行收缩为约 4,300 行本体加 9 个域 / 事件文件；新增功能有了明确的落点（先判域，再判协调），后续每个 `0.0.x` 可以按域继续瘦身而不阻塞产品功能。
- `swift test` 现在覆盖握手、失败清理、进程退出、Run 状态、注意力记录、搜索索引与认证事件流等此前只能人工验证的状态机；新增测试全部不依赖真实 Pi。
- 少量原 `private` 编排方法变为模块内可见：模块仍是单一 App 目标，未扩大到公共 API 面。
- ViewInspector 的能力边界被如实记录：`@Observable` 环境注入与复杂视图树在 0.10.3 不可用，升级到修复版本前不扩大其使用面。
- 仓库引入第一个测试专用三方依赖（ViewInspector，MIT，精确锁版），已按发布纪律登记在 `THIRD_PARTY_NOTICES.md`；不进入分发的 app bundle。

## Rejected Alternatives（未采用方案）

- **一次性拆到消息传递式多 Store**：会话 / 发送 / 结算时序与共享门禁（Prompt Transaction、Run State、Settlement Gate）强耦合，大改等于重写 0.0.5–0.0.7 的行为，回归风险不可接受。
- **只按扩展文件切割 AppModel**：导航改善但状态仍是一体的，测试注入缝不会出现。
- **新建 Xcode 工程包装做 XCUITest**：改动构建与发布管线，与 `app/build.sh` 手工组包流程冲突，维护成本最高。
- **用 ViewInspector 覆盖主界面**：0.10.3 在 `@Environment(AppModel.self)` 与复杂视图树上会崩溃，且需要等上游 0.0.7 之后的版本发布。
