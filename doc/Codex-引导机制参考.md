# Codex 引导机制参考

本页是2026-10-03的外部机制研究，不维护Codex当前版本或D Code实现状态。D Code现行用户行为只见[运行中用户消息的引导](../spec/工作台信息架构.md#运行中用户消息的引导)。

## 来源与验证范围

当时用本机`codex-cli 0.159.3`导出App Server类型，未启动工作、连接用户会话或调用模型；它不证明桌面客户端所用版本。核对了[App Server引导协议](https://learn.chatgpt.com/docs/app-server#steer-an-active-turn)和[Queue/Steer说明](https://developers.openai.com/blog/mastering-codex-remote-for-engineering#2-learn-the-difference-between-queue-and-steer)，没有实际引导测试。

## 已核实事实

| 层次 | 当时取得的机制依据 | 不可推广的含义 |
|---|---|---|
| Queue/Steer | 排队等响应结束，引导加入正在推进的工作 | 原作者偏好的默认值不成为D Code要求 |
| `turn/steer` | 核预期轮次，追加输入，不产生新turn/started，不接受模型/cwd覆盖 | 接受不等行动完成，也不保证只有一次模型请求 |
| `turn/interrupt` | 独立取消，轮次为interrupted | 引导不能实现为先停再重开 |
| 输入ID | 导出类型可关联目标、轮次与用户消息 | 字段存在不证明去重、断线恢复与全部时序 |

## 供应商原生引导的额外边界

当时[Responses原生引导](https://developers.openai.com/api/docs/guides/steering)限定支持模型与WebSocket路径：接收是待处理，既有输出和已完成动作不回滚，连接内待处理引导不能假定断线后仍保存。它不是Codex应用层或Pi持久化合同；本轮未重新核外部接口现状。

## 对 D Code 的工程启发

借鉴继续当前工作的语义，并区分接收、纳入与结果；具体输入身份、未知查回、暂停和重开只引用现行[输入合同](../spec/工作台信息架构.md#工作输入的接收回执)与[恢复规格](../spec/任务暂停与恢复.md)，不在研究页再写一份。

## 侧边对话与 Claude Code BTW 对照

当时[Claude BTW说明](https://code.claude.com/docs/en/interactive-mode#side-questions-with-btw)描述独立侧问、不进入主历史、不打断主轮次，也不能调用工具或看到未生成完的回复；不同客户端保留方式不相同。[Codex侧边对话说明](https://learn.chatgpt.com/docs/long-running-work#steer-a-running-goal)提供另一参考。没有运行两款侧聊测试，不假定上下文/持久化实现相同。

D Code借单向只读问答，具体入口、关闭与转工作草稿按现行spec；这里不新增工具权限或固定侧栏。

## 复评条件

只有相关接收/侧问机制成为具体接入候选时，再核该版本原文与真实行为。旧全文与导出类型取证过程可从Git `36a26048` 本文件原路径回查；不将研究未验证写成当前产品缺实现。
