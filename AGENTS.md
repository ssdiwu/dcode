# D Code Agent 规范

## 项目定位与权威

`D Code` 不是 Pi 客户端，而是以 Pi 为底层运行基座、围绕其会话、配置与 SDK 运行能力构建自有 `Harness（能力承载与编排层）` 的 macOS 原生工作台。产品核心是 D Code 自有的项目与工作上下文、能力编排、原生交互和结构化产物；Pi 不定义 D Code 的产品边界、界面或品牌。用户可见名称固定写作 `D Code`，其中 `D` 取自创作者长期使用的网名 `diwu`；项目目录使用 `dcode`，既有 `PiDCode` / `pi-dcode` 只保留为内部兼容标识。

- 先读根 `README.md` 与 `doc/README.md`；当前产品范围和验收由 `doc/40-版本实施方案/README.md` 路由，难逆转决定由 `doc/决策档案/README.md` 路由。
- Pi Host 的当前实现、协议和验证入口看 `host/README.md`、`doc/10-架构与运行/0001-Node-Pi-宿主与-IPC.md`、`host/package.json` 与相应源码；不要从产品规划推断已经交付的客户端能力。
- 版本、分支、实现进度和可运行状态必须从当前 checkout、manifest、源码与实际命令核验，不写入本文件。

## 产品与安全边界

- 仅支持 macOS；未经明确需求不引入 Windows 或跨平台界面抽象。
- `~/.pi/agent` 是 Pi 配置和会话的权威来源，不建立竞争性的会话数据库；外部扩展不是 D Code 产品模型或界面的权威。
- Swift 前端不得直接修改 Pi 会话 JSONL；所有会话写入必须通过兼容的 Pi Host 完成。
- 同一会话同时只能有一个写入所有者；不支持在途模型生成、工具执行或阻塞交互的热迁移。
- 不记录、复制或展示 API key、OAuth token、认证文件正文等凭据。
- D Code 不直接依赖或调用 `pi-tui`，不解析或转绘终端画面；所有用户可见界面由自有 SwiftUI/AppKit 组件或受控内容渲染器实现。
- 标准结构化扩展交互可以进入原生界面；`custom`、Widget 等 TUI 能力必须显式阻止或忽略，不能静默伪装成功。Goal、Agent Team 等产品能力只借鉴外部扩展机制，不以参考扩展包作为运行时依赖。
- 原生界面、Pi Host、进程间协议、会话生命周期与外部副作用是实际模块边界；实验实现必须隔离，不能替换已验证路径。

## 验证与交付

- 文档变更至少运行 `git diff --check` 并核验相对链接。
- Pi Host 改动在 `host/` 运行 `npm test`；需要单独检查构建时运行 `npm run build`。结论绑定实际目录、revision、工作区状态、命令、环境和覆盖范围。
- 原生客户端尚无可运行入口时不得把 Host 测试或规划文档冒充 App 构建、启动或人工验收；入口建立后以根 README 和 manifest 记录的命令为准。
- 涉及真实 Pi 配置、会话或凭据的验证使用隔离数据或明确授权的测试账户，不读取或改写无关用户状态。
- 打包发布产物（`app/build.sh`）前必须工作区干净（`git status --porcelain` 为空）且 `app/Info.plist`、`host/package.json`、`host/package-lock.json` 的内部版本号一致；脚本本身会做这两项硬性检查并在不满足时拒绝构建。脏树可用 `PI_DCODE_ALLOW_DIRTY_BUILD=1` 显式绕过用于本地调试，但这样产出的 `.app` 不得当作正式发布物分发；版本号不一致没有绕过项，必须先修源头。
- 未经用户明确授权，不创建 commit，不执行 `git push`、推送 tag、创建远程仓库、签名发布、部署或对外分发。
