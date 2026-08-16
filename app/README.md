# Native App

`app/` 是 `D Code` 的 macOS 原生界面层。它只通过 Protocol v1 与 `host/` 通信，不读取认证文件，也不直接修改 Pi Session JSONL。

## 目录

- `Sources/PiDCode/Host/`：Host 子进程定位、Finder 环境补全、JSONL 与请求关联。
- `Sources/PiDCode/Models/`：协议快照、Host Run State、Activity Attention Store、Project 元数据与 Session 精确归属、会话前 / 逐路径草稿、D Code 归档 / 置顶 / 会话变更账本、本机后续消息队列、单根平铺 / 多根分组文件树、Git 只读查询、搜索结果、工作轮与对话导航投影、Markdown 与 Pi 图片内容呈现、工具安全 presenter 与原生消息模型。
- `Sources/PiDCode/State/`：主线程应用状态、Navigation / Activity 会话栏投影、Recent / Project 会话分页、全局置顶、可见会话搜索、稳定完成关注态、首次发送时延迟创建 Pi Session、Prompt transaction、路径草稿、后续消息入队 / 派发 / 未知结果恢复、完整复制、直接归档/恢复、会话级已确认变更聚合、共享观察、按需写入与冲突恢复生命周期。
- `Sources/PiDCode/Views/`：共享 surface / elevation / geometry token 与 primitive、可调会话栏 / 信息检查器的 SwiftUI 原生响应式工作台、顶部会话身份与持久重命名入口、顶部直达“会话 / 文件 / 变更”的非模态信息检查器、User Home、Navigation / Activity 双投影与完成蓝点、带置顶/归档 Hover 的 Session 导航、轮次级会话与对话导航尺、工具卡、Markdown / 代码 / Mermaid / Pi 图片内容块、Plan / 会话变更摘要、会话前草稿与统一 Run / Queue 控制的 Interaction Dock、路径谱系、复制目标、`Command-K` 搜索浮层，以及当前窗口内带页内导航、受限内容宽度、归档管理与“关于 D Code”子页的 Settings 工作台页面。
- `Tests/PiDCodeTests/`：协议解码、Run State、Activity 关注态与排序、搜索与过期结果保护、路径/草稿/归档/置顶/会话变更账本、Markdown 段落和列表、Pi 图片有界解析、About 元数据、Project 持久化、文件树、Git 只读性、工作轮/对话导航密度与宽度/工具/布局策略、Bundle 定位和状态边界测试。
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

脚本默认内嵌 `~/.hermes/node/bin/node`；可用 `PI_DCODE_NODE_BIN=/absolute/path/to/node` 覆盖。构建时还必须提供该 Node 发行物的完整 `LICENSE`：默认读取 Node 安装根目录的 `LICENSE`，非标准布局可用 `PI_DCODE_NODE_LICENSE=/absolute/path/to/LICENSE` 指定。`0.0.6` 源码构建精确固定 arm64 Node `22.22.3`，使运行时、SQLite FTS5 搜索能力与随包许可证保持一致；输出 `dist/D Code.app`，资源布局包含 `Contents/Resources/AppIcon.icns`、`Contents/Resources/runtime/node`、`Contents/Resources/host/` 与 `Contents/Resources/Legal/`。Legal 目录保留 D Code 声明、Node/Pi/Apache 许可证、缺少许可证文件的 npm 包归属以及当前生产依赖清单；发现未审计许可证或新的缺失正文包时构建失败。App 优先使用包内资源，保留 `--node-bin`、`--host-entry` 和环境变量供开发诊断。`PiDCode` 继续作为内部 Swift 构建目标名，应用包内的可执行文件使用用户可见名称 `D Code`。

隔离验收可在直接启动可执行文件时传入 `--agent-dir /temporary/pi-agent`，并用 `D_CODE_PROJECT_STORE_PATH=/temporary/projects.json`、`D_CODE_SESSION_DRAFT_STORE_PATH=/temporary/drafts.json`、`D_CODE_SESSION_ARCHIVE_STORE_PATH=/temporary/archives.json`、`D_CODE_SESSION_PIN_STORE_PATH=/temporary/pins.json`、`D_CODE_SESSION_CHANGE_STORE_PATH=/temporary/session-changes.json`、`D_CODE_FOLLOW_UP_QUEUE_STORE_PATH=/temporary/follow-up-queues.json`、`D_CODE_ACTIVITY_ATTENTION_STORE_PATH=/temporary/activity-attention.json` 隔离 Project、逐路径草稿、归档、置顶、会话变更、后续消息与完成关注元数据；这些入口只用于开发与验证，不改变产品默认路径。

该产物使用 ad-hoc signature，仅用于本机运行；未启用 App Sandbox、Hardened Runtime、Developer ID 或 notarization，也不代表已获得对外分发授权。App 仍只通过 Host 访问 `~/.pi/agent`，关闭窗口或终止应用时会停止内嵌 Host。
