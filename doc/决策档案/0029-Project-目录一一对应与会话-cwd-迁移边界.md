# Project 目录一一对应与会话 cwd 迁移边界

状态：Accepted（取代 ADR 0004；在 Project 目录迁移范围内取代 ADR 0008 对“同 ID 改写 cwd”的禁止）

D Code Project 改为只拥有一个规范化工作目录，且一个目录最多属于一个 Project。Project 改目录不是仅更新本机组织信息：Pi Host 在明确用户操作、所有受影响 Session 空闲且租约稳定后，原地原子改写旧目录精确匹配 Session 的 Header `cwd`。Session ID、JSONL 非 Header 条目、Session 文件路径、`parentSession` 谱系和 Pi 会话权威均保留；这不是 Session Copy，也不创建新身份。

只有 Pi Host 可执行此事务；Swift 不直接写 Pi JSONL。Host 必须先完整预检所有受影响 Session 与目标目录，任一 Header、租约或文件版本不成立即不提交。活动 Runtime 必须先安全关闭并在迁移后按新 `cwd` 重新建立，不能在生成、工具执行或等待交互中改写 `cwd`。

“同时迁移目录内文件”是用户在选择新目录后的独立第二步选项，默认关闭。关闭时只迁移 Project 目录和 Session `cwd`；开启时文件移动必须无覆盖、可验证且失败可恢复，不能把元数据迁移伪装成文件已移动。Project 旧数据中的多个 Source Folder 必须走显式、无损迁移，不能静默删除或任选一个目录。

ADR 0008 的“复制到项目”仍然保留：它用于把单个 Session 复制成新的 ID 与新的 `cwd`。本 ADR 只新增“整个 Project 改目录时保持原 ID 改写 `cwd`”这一不同语义。
