# D Code Agent 规范

## 项目定位与权威

`D Code` 是基于 Pi SDK 构建、但拥有自身产品数据、能力和原生界面的 macOS `ADE（智能体开发环境）`，不是 Pi 客户端或 Pi CLI 的 GUI。D Code Product Store 是 Project、Task、D Code Session、提交原文、生效输入、Agent Run、模型资源、能力配置、产物与证据的产品权威；Pi SDK 是首个 Agent Runtime，只提供模型循环、工具执行和结构化运行事件。用户可见名称固定写作 `D Code`，其中 `D` 取自创作者长期使用的网名 `diwu`；项目目录使用 `dcode`，既有 `PiDCode` / `pi-dcode` 只保留为适配层兼容标识。

- 每次工作先读根 `README.md` 与 `doc/README.md`；项目专有概念以根 `GLOSSARY.md` 为唯一权威。产品使命看 `PRODUCT.md`，设计判断看 `DESIGN.md`，当前需求和验收由 `doc/40-版本实施方案/README.md` 路由，难逆转决定由 `doc/决策档案/README.md` 路由。
- `AGENTS.md`、`DESIGN.md`、`PRODUCT.md`、精确 PRD、`GLOSSARY.md`、Project Map 与 ADR 是 D Code 识别的一等项目文档：按职责和任务需要读取原文，不把全部 Markdown 静默拼进系统提示词，也不让派生摘要覆盖当前文件。
- Pi Host 的当前实现、协议和验证入口看 `host/README.md`、`doc/10-架构与运行/0001-Node-Pi-宿主与-IPC.md`、`host/package.json` 与相应源码；不要从产品规划推断已经交付的客户端能力。
- `0.0.28` 起，Product Store、Task / Session / Run、Prompt Receipt 与结构化协作事实由 D Code 原生拥有；Pi SessionManager 只承载 Runtime Adapter 的私有运行会话。已发布基线、当前候选、人工验收与发布状态仍须分别核验。
- 版本、分支、实现进度和可运行状态必须从当前 checkout、manifest、源码与实际命令核验，不写入本文件。

## 产品与安全边界

- 仅支持 macOS；未经明确需求不引入 Windows 或跨平台界面抽象。
- D Code 原生拥有会话、模型配置、能力资源与产品设置。Pi JSONL 和 Pi 配置只作为旧实现与可选择的单向导入来源；不做双写、持续同步，也不承诺 D Code 导出可以被 Pi CLI 继续使用。
- D Code Data Root 固定为当前用户的 `~/.dcode/`，保存 Product Store、Session、设置、Profile、模型 / 能力配置、受管产物、索引和恢复资料；Project 文件正文保持原位，凭据正文不得明文进入该目录。Task 必须属于 Project Scope 或 User Scope，后者默认 cwd 为用户 Home Directory，但不得伪装成“未选项目”。
- Swift 前端不得直接修改 Pi JSONL。Pi Adapter 可以通过 Host 创建私有适配会话，但 Pi JSONL 不再成为 D Code 产品历史或双写目标；外部 Pi Session 只经显式单向导入进入 Product Store。
- 提交原文与生效输入必须分开：用户真正提交的内容不可被技能展开、输入转换、压缩或编辑并重走原位覆盖；交给 Runtime 的生效输入必须保留来源关系。
- D Code System Prompt（D Code 系统提示词）由 D Code 拥有并完整替换 Pi 的通用身份；每个运行必须明确 D Code 环境、Agent 角色和职责，并从同一份真实 Active Tools（活动工具）快照生成工具名称与说明。Prompt 不得创造未注册工具，也不得静默继承 Pi 身份、Pi 文档入口或未经选择的全量项目上下文。
- 同一会话或运行事实同时只能有一个写入所有者；不支持在途模型生成、工具执行或阻塞交互的热迁移。恢复任务、会话关系和证据不等于恢复已经消失的 Runtime。
- 不记录、复制或展示 API key、OAuth token、认证文件正文等凭据。
- D Code 不直接依赖或调用 `pi-tui`，不解析或转绘终端画面；所有用户可见界面由自有客户端组件或受控内容渲染器实现，客户端技术选型由 `doc/10-架构与运行/0003` 拥有。
- 标准结构化扩展交互可以进入原生界面；`custom`、Widget 等 TUI 能力必须显式阻止或忽略，不能静默伪装成功。Goal、Agent Team 等产品能力只借鉴外部扩展机制，不以参考扩展包作为运行时依赖。
- Creation Mode（全局创造模式）只用于开发和自进化 D Code 自身；它不是权限模式，也不用于普通项目。现有候选构建、显式重启、恢复、人工验收与回滚是其安全基础，不得以热更新名义绕过。
- 原生界面、D Code Product Store、Runtime Supervisor、Pi Runtime Adapter、进程间协议、会话生命周期与外部副作用是当前模块边界。实验实现必须隔离，不能未经验证替换在役路径。

## 验证与交付

- 文档变更至少运行 `git diff --check` 并核验相对链接。
- Pi Host 改动在 `host/` 运行 `npm test`；需要单独检查构建时运行 `npm run build`。结论绑定实际目录、revision、工作区状态、命令、环境和覆盖范围。
- 原生客户端尚无可运行入口时不得把 Host 测试或规划文档冒充 App 构建、启动或人工验收；入口建立后以根 README 和 manifest 记录的命令为准。
- 涉及真实 Pi 配置、会话或凭据的验证使用隔离数据或明确授权的测试账户，不读取或改写无关用户状态。
- 打包发布产物（`app/build.sh`）前必须工作区干净（`git status --porcelain` 为空）且 `app/Info.plist`、`host/package.json`、`host/package-lock.json` 的内部版本号一致；脚本本身会做这两项硬性检查并在不满足时拒绝构建。脏树可用 `PI_DCODE_ALLOW_DIRTY_BUILD=1` 显式绕过用于本地调试，但这样产出的 `.app` 不得当作正式发布物分发；版本号不一致没有绕过项，必须先修源头。
- 未经用户明确授权，不创建 commit，不执行 `git push`、推送 tag、创建远程仓库、签名发布、部署或对外分发。
