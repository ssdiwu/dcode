# D Code 品牌资源目录

当前客户端在 [`client/`](../client/README.md)。旧 SwiftUI/AppKit 界面、状态、Host 桥、SwiftPM 测试与 `app/build.sh` 已随迁移收尾退役；退役前源码保存在 Git 基线 `18e12df`。历史文档中的旧路径用于解释当时验证，不再是当前开发入口。

[`Resources/`](Resources/README.md) 保留 SVG 母版、PNG/ICNS 和统一导出脚本，仍由当前窗口和候选打包消费。不要删除整个 `app/` 目录。

Host 的原生文件辅助程序在 [`host/native/WorkspaceFiles.swift`](../host/native/WorkspaceFiles.swift)，由 Host 构建脚本独立编译，不依赖已退役的 SwiftPM 包。候选构建、重启与回退由客户端和 Host 当前合同承担，见 [client/README](../client/README.md)。
