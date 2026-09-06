# Host Tests

本目录通过 Node 内置测试运行器验证 Host 公开行为：Protocol v1 与 JSONL 传输、Session Lease、Product Store 与租约、旧资料晋升与 Pi 单向导入、Runtime Supervisor 与受管 worktree、Prompt 组装与耐久请求 / Attempt、Foundation 协议与会话呈现、会话读取 / 复制 / 变更 / 搜索与目录迁移、资源与扩展、模型 / 认证、自定义供应商、极速模式、Mermaid 渲染与进程生命周期。

边界：

- 所有会话写测试仅使用系统临时目录；
- 不读取或修改真实 `~/.pi/agent` 会话；
- 与真实 Pi 运行、Swift 客户端的组合验证与人工验收不在本目录，状态见[版本实施方案](../../doc/40-版本实施方案/README.md)，Host / IPC 的真实运行证据见 [Node/Pi 宿主与 IPC](../../doc/10-架构与运行/0001-Node-Pi-宿主与-IPC.md)。

Web 修复回归：`client-recovery.test.ts` 验证新任务草稿、阅读位置、通知偏好的作用域与跨重启恢复；`../../client/test/ui-flow.test.mjs` 接入真实 React 与 PiHost，用隔离模型响应验证创建、流式、停止后续接、模型切换和草稿恢复。

设置恢复回归：`settings-restoration.test.ts` 覆盖旧偏好继承、新偏好优先、供应商原生编辑/接管、元数据优先级、嵌套凭据拒绝以及原生操作不回写 Pi 设置。`self-evolution-web.test.ts` 覆盖真实形态候选路径、回滚取消不影响原回执。client 的候选切换/停机回归分别验证资源身份、失败恢复与确认进程退出。`runtime-supervisor.test.ts` 的停止重放断言同时约束团队收尾与停止确认的竞态。


`attachments.test.ts` 覆盖副本隔离、原件变更、跨重启草稿、24 小时/30 天保留、提交事务回滚、原文与生效引用分开、凭据/符号链接拒绝、孤儿计入配额、失败不遗留副本，以及坏 manifest 不阻断其他清理。四条旧模型测试补齐独立数据根，运行 App 时也不会尝试占用真实 Product Store。
