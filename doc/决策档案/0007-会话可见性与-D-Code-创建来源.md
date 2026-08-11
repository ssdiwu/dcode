# 会话可见性与 D Code 创建来源

D Code 不把用户主目录下的全部 Pi Session 直接暴露为 Recent Sessions。Recent Sessions 只包含由 D Code Host 创建、并在创建时与 Session Header 一起写入有效 `dcode-session-origin-v1` Custom Entry 的 Pi Session。该条目的 `data.version` 必须为 `1`，`data.sessionId` 必须与当前 Session Header ID 相同；因其不进入 LLM Context（模型上下文），它只是会话来源与导航可见性的持久证据，不是消息或第二份会话数据。

Session Header 与有效来源标记作为完整初始文档成功发布，是 D Code 创建 Session 的提交点。此后运行时可写激活属于独立结果：激活失败不得删除或重写 append-only Pi JSONL，也不得把已经持久化的 Session 报告成“创建失败”；Host 必须返回稳定 Session 身份，并区分 writable、observing 与 unavailable。

旧 Pi Session 不做迁移，也不根据路径、时间或文件名猜测它是否由 D Code 创建。用户把其确切 `cwd` 登记为 Project Source Folder 后，旧会话才通过 Project 投影可见；关联或观察旧会话不会追加 D Code 来源。由其他 Pi 客户端复制的 Session 即使继承了原来的 Custom Entry，也因标记 Session ID 与新 Header ID 不一致而不进入 Recent。D Code 自己完成会话复制时，必须为目标新 Session 建立与新 Header ID 匹配的来源条目；继承的旧条目仍然无效。

因此普通会话导航的候选集合是“D Code 创建的 Recent Sessions”与“已关联 Project Source Folder 投影出的会话”的并集，再统一排除 D Code 已归档的 Session ID。同一 Session 可同时出现在 Recent 与 Project，但稳定 ID、JSONL、消息与上下文始终只有一份。全局 Search 必须遵守相同集合，不得绕过 Project 关联或归档状态暴露其他旧 Pi Session；归档对象只能通过已归档会话入口查看和恢复。
