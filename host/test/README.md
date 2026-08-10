# Host Tests

本目录通过 Node 内置测试运行器验证 Protocol v1、JSONL 传输与 Session Lease 的公开行为。

边界：

- 所有会话写测试仅使用系统临时目录；
- 不读取或修改真实 `~/.pi/agent` 会话；
- Pi SDK 集成测试将在宿主接入后新增。
