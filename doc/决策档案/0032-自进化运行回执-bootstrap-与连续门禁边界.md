# 自进化运行回执、Bootstrap 与连续门禁边界

状态：Accepted（约束 `0.0.27` 及后续 Self-evolution Run）

Self-evolution Run 是 D Code Harness 拥有的本机耐久回执，只串联 Project、Pi Session、Host Model、可选 Active Plan 与 Candidate Manifest 的稳定身份和有界摘要。各对象继续由原权威拥有；回执不保存源码、diff、Prompt、回复、Goal 内容、凭据、环境变量或隐藏推理。

运行记录必须显式区分 `legacy_bootstrap` 与 `full_preflight`。已发布的 `v0.0.26` 只有一次性 Session 恢复 marker，无法在候选交换前写入新 schema；因此 `0.0.26 → 0.0.27` 只能在新 App 核对 manifest 后建立 Bootstrap Receipt，并从 `app_started` 开始。它不能倒填 `restart_requested`、切换前时间、Project / Model 预检或完整运行链，无论人工验收结果如何都不计入 `0.1.0` 的三次完整自进化循环。

Full Receipt 必须由运行中的 `0.0.27+` 在交换前完成 Project / source、Session 归属、Host Model、无在途 Run / Prompt transaction、草稿 / 队列持久化和 Candidate 身份预检，并原子保存 `restart_requested`。新 App 只有在当前 bundle manifest 匹配、Host ready 且同一 Session 可写恢复后才能进入 `session_restored`；失败进入跨重启保留的 `recovery_required`。`manual_accepted` 和 `rolled_back` 只由用户显式动作产生。

`0.0.27+` 写出的重启 intent 必须显式区分普通候选重启、Full Receipt 重启与 Self-evolution 回滚；只有没有类型字段、没有 Run ID 的 `v0.0.26` 旧 marker 可以进入 legacy Bootstrap。普通重启或回滚不得靠目标版本推断为 Bootstrap，未知类型必须保留并停止自动恢复。任一未终结 Self-evolution Run 存在时，所有会交换 active / backup 的普通路径必须拒绝；隔离构建可以继续，但唯一回滚备份必须保留到当前回执人工收口。

连续门禁只统计 `full_preflight + manual_accepted`。Bootstrap、普通 Self-build、普通启动、网页 eval、测试通过、签名通过、commit、tag 或模型回答均不能单独增加计数。运行回执始终是 Local-only 证据，不构成二进制发布或分发授权。
