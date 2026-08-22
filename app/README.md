# Native App

`app/` 是 `D Code` 的 macOS 原生界面层。它只通过 Protocol v1 与 `host/` 通信，不读取认证文件，也不直接修改 Pi Session JSONL。

## 目录

- `Sources/PiDCode/Host/`：Host 子进程定位、Finder 环境补全、JSONL 与请求关联。
- `Sources/PiDCode/Models/`：协议与 Host 快照、Project / Session / Path、草稿、归档 / 置顶、Follow-up Queue、Run State、模型 / 认证、本机资源与自定义供应商、Exact Git Diff、会话变更与验证证据账本、自构建、搜索、Markdown / Mermaid / Pi 图片及原生工具 presenter 的数据合同。
- `Sources/PiDCode/State/`：`AppModel` 作为 UI 事务协调点，并由 `SearchModel`、`ActivityModel`、`FollowUpModel`、`ModelSettingsState`、`SelfBuildModel`、`ResourcesModel`、`ModelProvidersModel` 等领域状态承载各自生命周期；既有会话打开即接管，没有共享观察 / 按需写入模式，冲突后关闭失效所有权并保留草稿供重新接管。
- `Sources/PiDCode/Views/`：原生响应式工作台、会话 / Activity 导航、信息检查器、Conversation、文件与 Exact Git Diff、Composer / Plan / Run 控制、搜索、路径 / 复制 / 归档，以及同一工作台内的模型、本机资源、自定义供应商、自构建、Host 诊断和 About 设置页面。
- `Tests/PiDCodeTests/`：纯模型、Fake-host 集成与 ViewInspector 渲染回归。自动测试覆盖协议、状态、文件 / Git、搜索、资源、自构建与供应商等路径，但不替代跨 Swift / Host 真实存储合同、完整 JSONL Protocol 组合或人工视觉 / 无障碍验收；当前缺口见[版本实施方案](../doc/40-版本实施方案/README.md)。
- `Resources/`：App 图标的 `1024 × 1024` PNG 母版与构建使用的 `.icns` 资源；SwiftPM target 内的 `Sources/PiDCode/Resources/` 保存首页品牌资产。
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

脚本默认内嵌 `~/.hermes/node/bin/node`；可用 `PI_DCODE_NODE_BIN=/absolute/path/to/node` 覆盖。构建时还必须提供该 Node 发行物的完整 `LICENSE`：默认读取 Node 安装根目录的 `LICENSE`，非标准布局可用 `PI_DCODE_NODE_LICENSE=/absolute/path/to/LICENSE` 指定。当前构建脚本精确固定 arm64 Node `22.22.3`，使运行时、SQLite FTS5 搜索能力与随包许可证保持一致；输出 `dist/D Code.app`，资源布局包含 `Contents/Resources/AppIcon.icns`、`Contents/Resources/PiDCode_PiDCode.bundle`、`Contents/Resources/runtime/node`、`Contents/Resources/host/` 与 `Contents/Resources/Legal/`。Legal 目录保留 D Code 声明、Node/Pi/Apache 许可证、缺少许可证文件的 npm 包归属以及当前生产依赖清单；发现未审计许可证或新的缺失正文包时构建失败。App 优先使用包内资源，保留 `--node-bin`、`--host-entry` 和环境变量供开发诊断。`PiDCode` 继续作为内部 Swift 构建目标名，应用包内的可执行文件使用用户可见名称 `D Code`。

隔离验收可在直接启动可执行文件时传入 `--agent-dir /temporary/pi-agent`，并用 `D_CODE_PROJECT_STORE_PATH=/temporary/projects.json`、`D_CODE_SESSION_DRAFT_STORE_PATH=/temporary/drafts.json`、`D_CODE_SESSION_ARCHIVE_STORE_PATH=/temporary/archives.json`、`D_CODE_SESSION_PIN_STORE_PATH=/temporary/pins.json`、`D_CODE_SESSION_CHANGE_STORE_PATH=/temporary/session-changes.json`、`D_CODE_FOLLOW_UP_QUEUE_STORE_PATH=/temporary/follow-up-queues.json`、`D_CODE_ACTIVITY_ATTENTION_STORE_PATH=/temporary/activity-attention.json` 隔离对应本机资料；这些入口只用于开发与验证。当前验证证据账本与 `dcode_facts` 尚未贯通同一套隔离覆盖，不能据此宣称全部 D Code 本机资料都已隔离。

该产物使用 ad-hoc signature，仅用于本机运行；未启用 App Sandbox、Hardened Runtime、Developer ID 或 notarization，也不代表已获得对外分发授权。App 仍只通过 Host 访问 `~/.pi/agent`，关闭窗口或终止应用时会停止内嵌 Host。
