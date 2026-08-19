# dgoal 结构化状态融入与上下文构成呈现边界

状态：Accepted（已接受；约束 `0.0.8` 及后续版本）

## Context（背景）

ZCode 交互观察确认了两个吸收方向：计划批准工作流由创作者自有的 dgoal 扩展承接；上下文余量圆环的价值在于"每一部分在上下文中的占比"而非单一总量。此前 D Code 只把 dgoal 的 `dgoal-work-v1` 条目压缩成 Active Plan 胶囊：paused 状态被 Host 过滤丢弃，Plan Contract（保障档位、升级历史、阶段 / 终审独立审核）、条目证据与待批提案（`pendingProposal`）完全不呈现；dgoal 的 TUI 计划浮层则按既有边界被显式忽略。上下文方面，Pi 只提供总量（`getContextUsage`），用户无法分辨系统与工具、用户消息、助手回复、思考和工具结果各占多少。

## Decision（决定）

1. dgoal 不是 D Code 的运行时依赖：它继续由用户 Pi 配置（`settings.json` packages）加载，D Code 只识别其持久化在会话 JSONL 里的结构化状态（`dgoal-work-v1` / `dgoal-plan-history-v1`）。这维持 [ADR 0005](0005-Pi-SDK-与原生呈现边界.md) 与"不以参考扩展包作为运行时依赖"的既有边界——本 ADR 只把"识别"从远期规划提前为 `0.0.8` 交付。
2. Host 原样透传 dgoal 条目（无白名单原则不变），并把最新 work-v1 条目的 `goal`（含 `paused`）与 `pendingProposal` 随 `plan.changed` 与会话快照一并发给 Swift；`paused` 不再被当作无计划丢弃。
3. Swift 解析并原生呈现 Plan Contract：保障档位（软性清单 / 执行计划 / 目标终审 / 阶段审核）、升级历史、阶段验收标准与独立审核结果（approved / rejected / audit_error 及审核模型）、条目证据、暂停原因与耗时。soft 清单如实标注"软性清单"，不伪装执行保障。
4. 待批提案以 Composer 交互坞原生批准卡呈现；批准动作只发送 `/dgoal review` 消息（复用既有 prompt 通道，运行中被门禁拦下），实际批准 / 拒绝 / 反馈由 dgoal 的 `ui.select` 启动门禁完成——D Code 已有的原生扩展对话框链路承接，不新建第二控制面，不解析或伪造授权语义。
5. 上下文构成占比由 Host 新方法 `session.contextBreakdown` 提供：按消息种类（用户 / 助手 / 思考 / 工具结果）用 Pi 自有的 chars/4 估算口径分项，以最近真实 usage 总量锚定，差值反推"系统与工具"；全部标注估算，无锚定时只显示消息分项。只读观察会话返回不可用原因。圆环本体保持"蓝为剩余、白为已用"，仅在余量跌破阈值时转橙 / 红；旁侧常显本轮累计增减（新增 / 释放分列）。
6. dgoal 的 TUI PlanOverlay 与 `custom` / Widget 能力继续显式忽略，不伪装成功；`0.2.x` 若把 Goal / Work Map 产品对象化，以本 ADR 的识别层为起点另立决策。

## Consequences（影响）

- 用户在 D Code 中运行 dgoal 会话首次获得完整原生呈现：计划胶囊 + 详情里的保障档位、验收、审核与证据，以及待批提案的一等批准入口；`/dgoal` 自然语言与命令授权路径完全不变。
- 上下文弹层从总量升级为构成分解，用户可以回答"是谁吃掉了我的上下文"；估算口径与 Pi 压缩判断一致，锚定差异如实暴露而不是隐藏。
- Host 协议新增一个方法与一个能力位（`contextBreakdown`），App 与 Host 继续按版本锁同步发布。
- 提案批准的实际语义始终由 dgoal 拥有；若 dgoal 输入协议变化，D Code 侧只需要调整一条固定消息。

## Rejected Alternatives（未采用方案）

- **把 dgoal 内嵌进 D Code App 分发**：把用户配置的扩展变成产品运行时依赖，突破既有边界且需独立的加载与兼容性工程，留待明确需求另立 ADR。
- **D Code 直接合成授权消息（如"同意升级"自然语言）**：与 dgoal 的自然语言识别正则强耦合，协议漂移即静默失效；`/dgoal review` + 原生对话框是 dgoal 自有的稳定输入合同。
- **精确 per-section token 统计**：Pi 不提供分项数据；伪造精度比诚实估算更危险。
- **只做总量环变色**：回答不了"每部分占比"这个真实问题。
