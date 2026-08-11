# Native App

`app/` 是 `D Code` 的 macOS 原生界面层。它只通过 Protocol v1 与 `host/` 通信，不读取认证文件，也不直接修改 Pi Session JSONL。

## 目录

- `Sources/PiDCode/Host/`：Host 子进程定位、Finder 环境补全、JSONL 与请求关联。
- `Sources/PiDCode/Models/`：协议快照、Project 元数据、文件树、Git 只读查询与原生消息模型。
- `Sources/PiDCode/State/`：主线程应用状态、Recent/Project 会话分页、共享会话观察、按需写入与冲突恢复生命周期。
- `Sources/PiDCode/Views/`：SwiftUI 原生响应式三栏、User Home、Work Inspector、会话、Composer 与原生 Settings 窗口。
- `Tests/PiDCodeTests/`：协议解码、Project 持久化、文件树、Git 只读性、历史映射、Bundle 定位和状态边界测试。
- `Resources/`：App 图标的 `1024 × 1024` PNG 母版与构建使用的 `.icns` 资源。
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

脚本默认内嵌 `~/.hermes/node/bin/node`；可用 `PI_DCODE_NODE_BIN=/absolute/path/to/node` 覆盖。构建时还必须提供该 Node 发行物的完整 `LICENSE`：默认读取 Node 安装根目录的 `LICENSE`，非标准布局可用 `PI_DCODE_NODE_LICENSE=/absolute/path/to/LICENSE` 指定。`0.0.1` 本机构建精确固定 arm64 Node `22.22.3`，使运行时与随包许可证保持一致；输出 `dist/D Code.app`，资源布局包含 `Contents/Resources/AppIcon.icns`、`Contents/Resources/runtime/node`、`Contents/Resources/host/` 与 `Contents/Resources/Legal/`。Legal 目录保留 D Code 声明、Node/Pi/Apache 许可证、缺少许可证文件的 npm 包归属以及当前生产依赖清单；发现未审计许可证或新的缺失正文包时构建失败。App 优先使用包内资源，保留 `--node-bin`、`--host-entry` 和环境变量供开发诊断。`PiDCode` 继续作为内部 Swift 构建目标名，应用包内的可执行文件使用用户可见名称 `D Code`。

隔离验收可在直接启动可执行文件时传入 `--agent-dir /temporary/pi-agent`，并用 `D_CODE_PROJECT_STORE_PATH=/temporary/projects.json` 把 Project 元数据写入临时位置；这两个入口只用于开发与验证，不改变产品默认路径。

该产物使用 ad-hoc signature，仅用于本机运行；未启用 App Sandbox、Hardened Runtime、Developer ID 或 notarization，也不代表已获得对外分发授权。App 仍只通过 Host 访问 `~/.pi/agent`，关闭窗口或终止应用时会停止内嵌 Host。
