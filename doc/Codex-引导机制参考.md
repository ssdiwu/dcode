# Codex 引导机制参考

核对日期：2026-10-03。目的：为 D Code 的“工作调整默认引导，信息查询走侧边对话”提供机制依据，补充 Claude Code BTW 对照。本文保存外部事实、适用边界与工程推断；D Code 的现行行为统一见 [工作台信息架构](../spec/工作台信息架构.md#运行中用户消息的引导)。

## 来源与验证范围

- 本机 `codex-cli 0.159.3`：实际执行 `codex app-server generate-ts`，输出到隔离临时目录，读取 `TurnSteerParams`、`TurnSteerResponse` 和相关错误类型。未启动 Agent 任务、连接运行中的用户会话或调用真实模型。本机 CLI 的版本不作为当前桌面客户端所用二进制版本的证明。
- [Codex App Server 官方文档](https://learn.chatgpt.com/docs/app-server#steer-an-active-turn)：核对当前轮次引导与停止的公开协议。
- [OpenAI 的 Queue 与 Steer 使用说明](https://developers.openai.com/blog/mastering-codex-remote-for-engineering#2-learn-the-difference-between-queue-and-steer)：核对排队与引导的产品含义。文章讨论 Remote，不据此推断所有桌面版本的按钮、快捷键或默认设置。
- [Responses API 的 Mid-turn steering](https://developers.openai.com/api/docs/guides/steering)：核对供应商请求层的接收、接续与断线边界；这与 Codex 的应用轮次协议不是同一层。

## 已核实事实

| 层次 | 已核实内容 | 不应由此推出的结论 |
|---|---|---|
| 用户操作 | Queue 等当前响应结束后作为下一轮发送；Steer 给正在推进的工作加入引导。官方文章说明默认方式可选择 | 不把文章作者偏好的排队默认覆盖成 D Code 的默认要求 |
| 应用轮次 | `turn/steer` 向现有轮次追加用户输入，要求 `expectedTurnId` 匹配；没有活动轮次会失败，不产生新的 `turn/started`，也不接受模型、目录等轮次配置覆盖 | 不等于已经按消息完成行动，也不保证底层只有一次模型请求 |
| 停止操作 | `turn/interrupt` 单独请求取消，最终轮次状态为 `interrupted` | 引导不能被实现为无条件调用停止，再重新开始 |
| 本机协议补证 | 导出类型包含会话目标、预期轮次、输入和可选 `clientUserMessageId`；响应返回接受输入的轮次。错误类型包含不可引导轮次的信息 | 一个消息 ID 字段不证明去重、断线恢复或全部执行时序已经正确 |

上述协议事实由官方 App Server 文档与本机导出类型交叉核对；没有实际运行时引导测试。

## 供应商原生引导的额外边界

截至核对日，Responses API 文档把原生 `response.steer` 限定在支持的 GPT-6 模型及 WebSocket 请求路径。接收事件只表示进入待处理状态；后续可生成携带更新的新 response。既有输出不被改写，已完成动作不被撤销，已开始工具不因引导自动取消。需要客户端工具结果或审批时，仍需完成对应处理。

文档还明确：连接内待处理引导不自动随原响应持久保存，断线后不能假定仍然存在。该事实只适用于这一供应商 API，不是对 Codex 整体持久化能力或 Pi 行为的结论。来源见上面的 Responses 官方指南。

## 对 D Code 的工程启发

- 507 进一步确认信息查询与工作调整分开：进度和解释类问题由临时侧边对话回答，不自动注入原工作；工作调整才采用默认引导。这个产品边界优先于将所有普通消息都归入引导的先前概括。
- 借鉴应用层“继续当前工作”的语义，保持 Pi SDK 1.0.0 选型；不同模型能否原生接收生成中的更新，另按真实能力验证。统一体验不等于统一请求层机制。
- 将目标会话、当前运行与输入身份关联，校验过期目标；不能让轮次切换把消息悄悄送入错误运行。
- 区分已接收、待纳入上下文和已有处理结果。执行端作为已接收输入的唯一写入者；界面不维护第二套可自行推进的正式队列。
- 已接受但尚未处理的引导也属于恢复范围。断线或重开后先核对记录，再决定是否需要重送；已确认接收的同一条消息不得盲目重复注入。恢复继续遵守用户显式接续要求。

这些是服务已确认产品目标的工程约束，未指定 D Code 的接口字段、存储结构或 Pi 适配实现。首版必须验证：运行中加入补充、轮次结束竞态、引导与停止的区别、保存失败、重复提交、重开后的待处理输入。具体用户行为与验收只在关联规格维护。

## 侧边对话与 Claude Code BTW 对照

同日核对的 [Claude Code 官方说明](https://code.claude.com/docs/en/interactive-mode#side-questions-with-btw) 明确：`/btw` 根据已有会话内容回答，问答不进入主对话历史；可以在主线运行时独立执行，不打断主轮次。它不能调用工具，也不看到主线尚在生成的回复。终端与 VS Code 扩展的保留方式不同，不能把一种客户端的生命周期推广到全部版本。

OpenAI 的 [长期工作说明](https://learn.chatgpt.com/docs/long-running-work#steer-a-running-goal) 建议用侧边对话查询进度或解释而不打断主线；[命令说明](https://learn.chatgpt.com/docs/reference/slash-commands) 将 `/side` 定义为不打断主会话的临时问答入口。此次没有运行两款产品的侧聊测试，也不据此推断 Codex 与 Claude 的上下文或持久化实现完全相同。

D Code 借鉴独立问答与单向读取的边界。为回答进度而提供只读运行状态及其时间，是本项目的设计适配；这不代表直接复制了 Claude 的工具权限、面板位置、关闭保留或转为子智能体的行为。具体入口与后续处理继续按 D Code 的当前规格对齐。

## 尚未验证

当前桌面客户端具体 UI 和请求实现、各模型的实际接入延迟、Pi 普通 SDK 与 Durable 对应输入入口的运行表现，以及 D Code 的引导持久化和回放都尚未验证。本轮成果是资料与协议核对，不是客户端或 Pi 接入验收。
