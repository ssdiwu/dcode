# 会话可见性与 D Code 创建来源

D Code 不把用户主目录下的全部 Pi Session 直接暴露为 Recent Sessions。Recent Sessions 只包含由 D Code Host 创建、并在创建时与 Session Header 一起写入有效 `dcode-session-origin-v1` Custom Entry 的 Pi Session。该条目的 `data.version` 必须为 `1`，`data.sessionId` 必须与当前 Session Header ID 相同；因其不进入 LLM Context（模型上下文），它只是会话来源与导航可见性的持久证据，不是消息或第二份会话数据。

Session Header 与有效来源标记作为完整初始文档成功发布，是 D Code 创建 Session 的提交点。Host 在该点立即返回稳定 Session 身份，不关闭当前 Runtime、不为新对象取得 Lease，也不把后续打开与激活并入创建结果。App 在显示已创建 Session 后，再以独立 `session.open` 请求获得 observing 或 writable 运行状态；该请求失败不得删除或重写 append-only Pi JSONL，也不得把已持久化 Session 重新报告为“创建失败”。

从 `0.0.5` 起，App 何时发起该 Host 创建请求由 [ADR 0014](0014-新会话延迟创建与本地草稿边界.md)进一步收窄：点击“新建会话”只进入本地会话前草稿，首次提交非空正文时才调用 `session.create`。本 ADR 的初始文档发布与可见性提交语义保持不变。

旧 Pi Session 不做迁移，也不根据路径、时间或文件名猜测它是否由 D Code 创建。用户把其确切 `cwd` 登记为 Project Source Folder 后，旧会话才通过 Project 投影可见；关联或观察旧会话不会追加 D Code 来源。由其他 Pi 客户端复制的 Session 即使继承了原来的 Custom Entry，也因标记 Session ID 与新 Header ID 不一致而不进入 Recent。D Code 自己完成会话复制时，必须为目标新 Session 建立与新 Header ID 匹配的来源条目；继承的旧条目仍然无效。

因此普通会话导航的候选集合是“D Code 创建的 Recent Sessions”与“已关联 Project Source Folder 投影出的会话”的并集，再统一排除 D Code 已归档的 Session ID。同一 Session 可同时出现在 Recent 与 Project，但稳定 ID、JSONL、消息与上下文始终只有一份。全局 Search 必须遵守相同集合，不得绕过 Project 关联或归档状态暴露其他旧 Pi Session；归档对象只能通过已归档会话入口查看和恢复。
