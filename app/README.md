# Native App

`app/` 是 `D Code` 的 macOS 原生界面层。它只通过 Protocol v1 与 `host/` 通信，不读取认证文件，也不直接修改 Pi Session JSONL。

## 目录

- `Sources/PiDCode/Host/`：Host 子进程定位、Finder 环境补全、JSONL 与请求关联。
- `Sources/PiDCode/Models/`：协议快照与原生消息模型。
- `Sources/PiDCode/State/`：主线程应用状态和会话生命周期。
- `Sources/PiDCode/Views/`：SwiftUI 原生界面。
- `Tests/PiDCodeTests/`：协议解码、历史映射、Bundle 定位和状态边界测试。
- `Info.plist`：本机 App bundle metadata。
- `build.sh`：release 构建、生产 Node 依赖装配与本地签名。

## 开发命令

先构建 Host，再启动 App：

```bash
cd host && npm run build
cd ..
swift run PiDCode
```

验证：

```bash
swift test
```

## 构建本机 App

先安装锁定依赖，再从项目根构建并打开：

```bash
cd host && npm ci && cd ..
./app/build.sh
open "dist/D Code.app"
```

脚本默认内嵌 `~/.hermes/node/bin/node`；可用 `PI_DCODE_NODE_BIN=/absolute/path/to/node` 覆盖。当前本机构建只接受 arm64 Node `>=22.19.0`，输出 `dist/D Code.app`，资源布局为 `Contents/Resources/runtime/node` 与 `Contents/Resources/host/`。App 优先使用包内资源，保留 `--node-bin`、`--host-entry` 和环境变量供开发诊断。`PiDCode` 继续作为内部 Swift 构建目标名，应用包内的可执行文件使用用户可见名称 `D Code`。

该产物使用 ad-hoc signature，仅用于本机运行；未启用 App Sandbox、Hardened Runtime、Developer ID 或 notarization，也不代表已获得对外分发授权。App 仍只通过 Host 访问 `~/.pi/agent`，关闭窗口或终止应用时会停止内嵌 Host。
