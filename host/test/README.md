# Host Tests

本目录通过 Node 内置测试运行器验证 Host 公开行为：Protocol v1 与 JSONL 传输、Session Lease、Product Store 与租约、旧资料晋升与 Pi 单向导入、Runtime Supervisor 与受管 worktree、Prompt 组装与耐久请求 / Attempt、Foundation 协议与会话呈现、会话读取 / 复制 / 变更 / 搜索与目录迁移、资源与扩展、模型 / 认证、自定义供应商、极速模式、Mermaid 渲染与进程生命周期。

边界：

- 所有会话写测试仅使用系统临时目录；
- 不读取或修改真实 `~/.pi/agent` 会话；
- 与真实 Pi 运行、Swift 客户端的组合验证与人工验收不在本目录，状态见[版本实施方案](../../doc/40-版本实施方案/README.md)，Host / IPC 的真实运行证据见 [Node/Pi 宿主与 IPC](../../doc/10-架构与运行/0001-Node-Pi-宿主与-IPC.md)。
