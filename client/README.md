# D Code Web 客户端

`client/` 是 [PRD 0028（0.0.30 Web 客户端初版）](../doc/40-版本实施方案/0028-0.0.30-Web客户端初版产品需求.md)的实现目录：Electron 平台壳 + React 呈现层，经 Protocol v1 消费既有 `host/`，不写 Product Store、Project Directory 或凭据。选型与七题结论见 [0003 技术栈](../doc/10-架构与运行/0003-Web客户端技术栈.md)。

## 当前状态（2026-09-05，验收面一已通过机器自验、待 507 人工确认）

已落并经自动验证：

- `src/protocol/`：传输无关的 Protocol v1 客户端（JSONL 解码 + 请求关联 + 事件分发），单测覆盖分片、超限恢复、关联与超时。
- `src/host/`：Host 启动计划（Electron 二进制 `ELECTRON_RUN_AS_NODE` Node 模式或纯 Node；环境合同平移自 Swift `HostLocator`）与 Host 桥（`host.ready` 握手、优雅停机、崩溃上抛）。
- `scripts/smoke-host.mjs`：壳冒烟——拉起真实 `host/` 构建产物 → 握手 → `foundation.snapshot` → 优雅退出，全程隔离临时 data-root，不触碰真实 `~/.dcode`。
- `scripts/seed-store.mjs`（`npm run seed:visual`）：在隔离数据根 `/tmp/dcode-visual-store/` 用真实协议（`project.create` / `task.create`）产出含协调会话的验收数据。
- `src/main/`、`src/preload/`、`src/renderer/`：Electron 主进程、预载与三区布局——**验收面一（导航区 + 任务对话真实消息流）已实现并机器自验通过**：真实 Product Store 数据、梗概浮卡（进度 + Agent Team）、详情侧栏挤压任务区、稳定几何、深浅双主题；渲染工具链（electron / vite / react / tailwind / motion / zustand / swr）已安装并接入构建。
- 视觉自验截图：`/tmp/dcode-shots/`（七态）；人工确认后按 PRD 0028 §5 执行 Swift 对应面拆除。

## 命令

```bash
# 构建（暂时借用 host/ 的 tsc，client 自有 node_modules 落地后切换）
npm run build

# 协议客户端单测
npm test

# 壳冒烟（需先 cd ../host && npm run build）
npm run smoke:host
```

启动窗口（待渲染工具链安装后补全）：

```bash
npm install        # 安装 electron / vite / react 等 devDependencies
npm run dev        # vite dev server + electron（入口待接入）
```

## 结构

- `src/protocol/`：信封类型、JSONL 解码、传输无关客户端（电话线预铺约束一）。
- `src/host/`：启动计划与 Host 桥；stdio 管道直迁（议题一 / 议题六）。
- `src/main/`：Electron 主进程——平台壳七项职责（议题二）。
- `src/preload/`：渲染层唯一通道，版本化 IPC（预铺约束二）。
- `src/renderer/`：三区布局骨架；Tailwind / Motion / swr 接入后替换骨架样式。

## 边界

- 渲染层不得触碰传输、文件系统或 Product Store；一切经预载 IPC。
- 凭据零接触；本目录不引入终端部件与编辑引擎（PRD 0028）。
- 修改 `host/` 时在 `host/` 运行其测试；本目录验证入口为 `npm test` 与 `npm run smoke:host`。
