# D Code Project 与 Pi 会话分离

D Code Project 是 D Code 自有的组织对象，只拥有项目名称、显示顺序和 Source Folder 归属；Pi Session 的稳定 ID、消息、上下文、扩展状态和持久产物继续以 `~/.pi/agent` 为唯一权威。Project 可以包含多个 Source Folder，但同一个规范化确切目录同时最多属于一个 Project；再次添加必须由用户明确移动，不能重复或静默改归属。

Project 会话列表由其 Source Folder 与 Pi Session 的 `cwd` 对应关系投影得到。添加文件夹可以发现并显示既有会话，但不得移动、复制或改写会话 JSONL；Recent Sessions 与全文 Search 同样只是跨项目视图。Project 元数据不能从 Pi 会话完整重建，因此由 D Code 独立持久化是必要边界，但它不扩张为第二套会话数据库。首个目标形态只匹配与 Source Folder 相同的规范化 `cwd`，不因登记父目录而静默吸收任意后代目录。
