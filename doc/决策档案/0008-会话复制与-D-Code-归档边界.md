# 会话复制与 D Code 归档边界

状态：Accepted（已接受，约束 `0.0.3` 及后续版本）

D Code 的跨 Project 会话操作使用 Pi SDK 的完整会话 Fork（分叉）语义：源 Pi Session 保留不变，目标在所选 Source Folder 中获得新的 Session ID、新 `cwd` 与指向源 Session 文件的 `parentSession`。产品只称它为“复制到项目”，不得称为“移动会话”或“迁移会话”。D Code 不提供保持同一 Session ID、改写 Header `cwd` 或重命名 Pi 会话目录的常规迁移能力。

D Code 提供两个独立操作：“复制到项目…”与“复制到项目并归档原会话…”。两者都复制源 Session 的全部已持久化非 Header 条目与当前路径状态，包括消息路径、模型与思考强度记录、压缩摘要、标签和自定义状态；不复制未发送草稿、文件或 Git 状态。目标继承复制提交点的持久状态，但以新 Session ID 独立演进。目标必须建立与新 Session ID 匹配的 D Code 创建来源；从源 Session 继承、但仍指向旧 ID 的来源条目无效。

复制目标必须先写入隐藏暂存位置并完整验证，再以原子发布或等效提交边界进入 Pi 会话发现目录。目标仍在写入、验证失败或进程中断时，Recent、Project 与 Search 都不得发现半完成会话；源 Session 也不得因此归档。目标 Project 没有有效 Source Folder 时不允许提交复制。

“复制到项目并归档原会话…”采用先复制、后验证、最后归档的顺序。只有目标的新身份、目标 `cwd`、完整历史、有效来源与可打开状态全部成立后，D Code 才能把源 Session 标记为归档。复制成功但归档失败时，目标保留，源继续可见，并报告可恢复的部分成功；不得删除目标或把源误标为已归档。

D Code Archive（D Code 归档）是以稳定 Session ID 保存的本机、可逆展示状态。它必须在 Recent、Project 与 Search 的排序、分页、数量限制和结果截断之前统一排除归档对象，同时通过“已归档会话”入口允许查看和恢复。恢复只是撤销排除，不能补写 D Code 来源或 Project 关联；会话随后只进入其原有来源与 `cwd` 关系允许的投影。归档不删除、移动、重命名或改写源 Pi JSONL，不影响 Pi CLI 继续访问源 Session，也不清除源 Session 的本机逐路径草稿。

该边界保留了 Pi Session 作为唯一对话权威，同时允许 D Code 管理自己的导航可见性。若未来需要永久删除、只复制单一路径或保持同一 ID 修改 `cwd`，必须另立需求与数据安全决策，不能复用本 ADR 的“复制”或“归档”文案。
