# Pi 版本与升级

本文件维护最近一次统一版本检查、升级取舍和迁移证据入口，不维护第二份工程进度。实际依赖版本唯一以根 `package.json`、`package-lock.json` 为准；安装目录若不同应查清原因，不能把公开 latest 或本文表格当作项目已升级。当前工程状态见 [PROGRESS](../PROGRESS.md)。

## 开工检查

- 每次新会话开始，先读项目 package／lock，核对当前锁定 Pi 依赖组及已记录的最近检查。
- 每天首次开发由协调者按 Asia/Shanghai 日期统一检查 [Pi 官方稳定发布](https://github.com/earendil-works/pi/releases) 与 npm 的 `@earendil-works/pi-coding-agent`、`pi-durable`、`pi-ai`、`chord`、`pi-telemetry` 实际元数据；其他成员复用当天结果，不各自重复查询。未有协调者时，由本次明确承担协调职责的执行者检查。
- 记录检查时间、来源、项目锁定版本、上游稳定版本及结论，在本文件更新“最近检查”，不每天新建文档。预发布、上游 main 或 API 存在不等于稳定发布／可替换本地实现。
- 发现新版先评估全部跨越版本变更、现有消费者、数据与恢复兼容、验证成本，再按实际授权升级；不自动改依赖。查询失败或来源不一致记未知，继续无关工程，不凭空报无更新，不建定时自动化。

## 最近检查

时间：2026-10-19 12:59:48 +08:00（Asia/Shanghai），执行者：协调者 Root。公开 registry 五包查询均成功；当时根 lock、全部已安装同组包（含嵌套副本）均为 1.0.0。Node 实际 `v22.22.3`，满足上游 `>=22.19.0`。直接四包及 telemetry override 当时固定 1.0.0；本表记录升级前事实，不预报升级完成。

| npm 包 | 检查时项目 lock | 上游稳定版本／元数据 |
| --- | --- | --- |
| `@earendil-works/pi-coding-agent` | 1.0.0 | [1.3.0](https://registry.npmjs.org/@earendil-works%2Fpi-coding-agent/latest) |
| `@earendil-works/pi-durable` | 1.0.0 | [1.3.0](https://registry.npmjs.org/@earendil-works%2Fpi-durable/latest) |
| `@earendil-works/pi-ai` | 1.0.0 | [1.3.0](https://registry.npmjs.org/@earendil-works%2Fpi-ai/latest) |
| `@earendil-works/chord` | 1.0.0 | [1.3.0](https://registry.npmjs.org/@earendil-works%2Fchord/latest) |
| `@earendil-works/pi-telemetry` | 1.0.0 | [1.3.0](https://registry.npmjs.org/@earendil-works%2Fpi-telemetry/latest) |

官方 [v1.3.0 发布](https://github.com/earendil-works/pi/releases/tag/v1.3.0)标为最新稳定版，2026-10-15 UTC 发布。原始公开元数据、完整版本路径、安装目录与 hash 保存在 `/Users/diwu/.codex/visualizations/2026/10/03/01a1029e-4403-7333-b95f-7e54a70cb6e1/pi130-migration-20261019/preparation-r1/daily-version-check.json`。首次盘点假设 telemetry 被提升到顶层而未找到；随后按 lock 真实嵌套路径更正读取，不是依赖已损坏。

结论：507 已明确授权在干净 `main` 直接固定升级适配到 **1.3.0**，沿 coding-agent＋Durable 原方案，Root 唯一写入；不引入第二个执行循环、历史或接收队列。升级前 HEAD 为 `813b434017c2970dfb9287be8026412462b45263`，index／工作树干净。完整源码与旧依赖恢复依据保存在 `/Users/diwu/Workspace/Archives/dcode-prototype-implementation-2026-10-10/main-before-pi130-20261019/manifest.json`；后续技术验证未完成前不称 1.3.0 已验收。

## 本次迁移核对范围

跨越版本须包括 1.0.0 之后的修订、1.1、1.2 和 1.3，依据各包固定 v1.3.0 的 CHANGELOG 与实际源码：[Durable](https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/CHANGELOG.md)、[coding-agent](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/CHANGELOG.md)、[pi-ai](https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/CHANGELOG.md)、[Chord](https://github.com/earendil-works/pi/blob/v1.3.0/packages/chord/CHANGELOG.md)、[telemetry](https://github.com/earendil-works/pi/blob/v1.3.0/packages/telemetry/CHANGELOG.md)。

| 变化 | D Code 接收边界 |
| --- | --- |
| Storage 扫描顺序、context 参数 | 实际存储适配器和直接消费者同步，旧历史分页及同一对话上下文不能反序或错位 |
| StorageRejected 移除，StorageRequestError 与 SessionFailed | StorageRequestError 仅非法读取可豁免；commit／mintId 异常仍使 Session 失败，接收结果保持未知至可靠只读回查。只有接收前无副作用校验拒绝，或可靠回查确认未接收，才能报告未接受，不盲重投 |
| Durable tool result 的 output／structuredOutput、model／nested union、非零命令结果 | 只在 Durable 边界适配；普通 coding-agent 扩展仍用 content，禁止全局替换；保工具失败反馈、原身份、费用与取消 |
| before_agent_start trigger／busy 与 emitBeforeAgentStart | 同步真实事件调用和已接收输入语义，重开读取不执行扩展或模型 |
| Kimi 等模型协议／URL与身份 | 对照固定官方消费者，核下一实际请求，旧模型配置不得静默借新协议绕过准入 |
| 原生 executeTool、嵌套任务与 Durable codemode | 必要兼容先完成，再评估复用；API 存在不自动证明可删当前桥，必须逐项保已验所有权、权限、回执、输出及生命周期 |

阶段验证采用隔离项目、旧受控数据副本与真实 SDK 配受控 HTTP；不访问真实账户、用户项目或重启用户窗口。核旧历史、暂停／明确继续、只读重开／receipt lookup 零请求零工具重放、存储未接受／未知、同任务两轮编码与实际差异、扩展／MCP／虚拟路由和受影响模型协议。集成须有对应 1.3 的架构正反、类型、Lint、构建、runtime、contracts 和后台隐藏界面证据，再独立 `507-review`，通过后按授权及时本地提交。直接在 main 提交即本次整合，不另造 merge；没有 push／tag／release 授权。

## 历史身份

[Pi 1.0.0：虚拟模型与运行恢复](Pi-1.0.0-虚拟模型与运行恢复.md)及原验证记录维持各自固定源码／运行身份，不把其结果改写成 1.3。上轮 runtime592／contracts14／界面156组合属于原 1.0；原完整界面138pass／18fail／exit1及一次15秒关闭超时未知根因仍保留，不以本次升级追补旧成功。本次升级的实际修复、失败、门槛与独立结论在实施后补入本文件，PROGRESS只登记实质进展。
