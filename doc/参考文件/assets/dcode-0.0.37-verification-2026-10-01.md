# D Code 0.0.37 本机验证记录

状态：已确认范围的未提交实现、独立未签名本机候选和以下工程检查完成；507 本人产品验收、稳定生图支持、正式签名分发、旧用户库迁移／回退仍未成立。

## 位置与范围

- 源码位置：`/Users/diwu/Workspace/Codes/Apps/dcode`，`main@456a1c2989dd1bc2637c02979f5b198d8e894fa7` 加当前未提交组合改动；没有创建提交或推送。
- 环境：macOS arm64，Electron `41.10.7`，App／Host `0.0.37`，三项 Pi SDK `0.99.1`，独立安装 Codex CLI `0.157.1`。
- 候选：`/Users/diwu/Documents/Codex/2026-10-01/dcode-0.0.37-candidate-sCPyxP/mac-arm64/D Code.app`。未签名、未公证，未覆盖原正在使用的候选。
- 范围：[单图试验](../../40-版本实施方案/0036-0.0.37-任务内图像生成与产物归档产品需求.md)、[SDK 升级](../../40-版本实施方案/0038-0.0.37-Pi-SDK-升级产品需求.md)、[中英语言](../../40-版本实施方案/0039-0.0.37-中英界面与沟通语言产品需求.md)，携带此前 0.0.35／0.0.36 的主树组合实现；十项 ZCode 研究候选未自动成为实现承诺。
- 此前没有独立验收的 0.0.35 基线；本轮不追认它或 0.0.36 的整版人工验收。所有本轮窗口操作均使用隔离 Store／Agent／Electron profile，没有测试真实用户库的升级和回退。

## 自动与包体检查

| 检查 | 实际结果 | 覆盖与边界 |
|---|---|---|
| `npm --prefix host test` | 469/469，fail 0 | 普通协调／成员、准备竞态、工具、Store、恢复及生图边界；模型响应使用受控 Provider。 |
| `npm --prefix client test` | 壳 13/13、呈现／交互 95/95，fail 0 | 原始入口、草稿、文件、对话、设置与新面板；不代替真实账户全矩阵。测试有一次 Vite WebSocket 端口占用提示，测试结束全绿。 |
| 生图专项 | Host 23/23，面板 8/8 | 不重放、所属 Task、失败轮次、证明／落盘两个崩溃窗口、来源篡改、Project 根替换与 `..photos` 子目录、排他导出。 |
| 语言专项 | 词表 3/3；真实 Electron 48 组布局＋切换／重启通过 | 显式词条／静态选项英文覆盖、占位符、保存回包与失败后读、原生菜单；协调／独立成员的 SDK 请求语言绑定。真实模型语言质量不由 fixture 输出推定。 |
| `DCODE_EXPECTED_VERSION=0.0.37 npm --prefix client run verify:version` | 通过 | App／Host manifest、锁文件根包、握手与对应断言一致。 |
| `DCODE_EXPECTED_VERSION=0.0.37 DCODE_PACKAGE_OUTPUT=… npm --prefix client run dist` | 退出 0，独立候选生成 | 编译 Host 与原生程序，按锁装配生产依赖、Legal；Host 216、client 175 个唯一依赖声明。跳过签名由候选配置明确要求。 |
| 包内 Host 冒烟 | 退出 0；Host 0.0.37、Pi 0.99.1、Schema 3 | 用候选 Electron Node 模式真实启动包内 Host，核对三项 SDK、OpenAI／OpenAI Codex 各有 GPT-6 Sol、Luna、6.1 Sol；未向真实聊天模型发请求。 |
| 包体与实际 App | 通过 | Info.plist short/build version、Host manifest/lock 均为 0.0.37；图像 native helper、受控目录、Codex LICENSE/NOTICE 完整。实际 renderer 从候选 `app.asar` 载入，关于页及诊断显示 0.0.37／Host 已连接，语言 English 保存，已生成图恢复及原草稿保留。 |
| 独立交付审查 | 修复后未见本地试验代码阻断 | 复现并复验目录身份绕过和待核对图恢复窗口，逐字段核对模型目录与许可证；单次用量保证与正式生产支持仍未通过。 |
| 文档 | `git diff --check` 与当前修改文档的相对链接核对通过 | 文档、源码、实际候选和人工验收状态分别记录。 |

包体截图：[关于页](dcode-0.0.37-packaged-about-2026-10-01.png)、[诊断](dcode-0.0.37-packaged-diagnostics-2026-10-01.png)、[English 选择](dcode-0.0.37-language-settings-2026-10-01.png)；[包窗口结果](dcode-0.0.37-packaged-result-2026-10-01.json)。[窄窗口标题](dcode-0.0.37-child-header-2026-10-01.png)来自 48 组隔离走查，历史任务／成员名称保留原文。

## 真实订阅单图与恢复

在实际 D Code 主对话打开、关闭表单，没有产生生图 Attempt；再次打开后明确提交一条测试描述。真实适配器核对 ChatGPT Pro 与图像／namespace 能力，固定受控 `gpt-6-luna` 目录，未提供 API Key。普通草稿始终为“普通消息草稿 KEEP”。

- [原图](dcode-0.0.37-image-2026-10-01.png)：PNG，1254×1254，1,204,426 字节。
- SHA-256：`da4ca39ac4b079dcea52053cdee09d68d8b555141cdd2c1709f48d6b4f8f3c26`。
- D Code Attempt：`attempt-396a21f8-66df-4310-adff-b07e6e97a90c`；Artifact：`image-attempt-396a21f8-66df-4310-adff-b07e6e97a90c`。
- 实际预览解码、附为输入和 Project 导出通过；受管原图、附件副本、导出文件三者字节摘要相同，独立审查再次计算吻合。[面板截图](dcode-0.0.37-image-panel-2026-10-01.png)及[结果](dcode-0.0.37-image-result-2026-10-01.json)可复查。
- 关闭并重开隔离 Host／Electron 后，原图、附件与导出仍可核对，Attempt 数为 1，没有重新生成；[重启结果](dcode-0.0.37-image-restart-2026-10-01.json)。随后使用实际打包 App 的原生入口读取同一隔离 Store，再核对相同结果、一次 Attempt 与草稿。
- 精确余额、扣减与账单没有检查，不由文件成功、一次 Attempt 或官方一般说明推导。

## 固定配置的负向隔离

使用与生产适配器相同的固定 CLI、随机权限 profile、空 environments、启动级受控单模型目录和完整 MCP／feature 核对。测试仅替换该临时 thread 的说明，以主动尝试以下禁止路径；未提供项目历史、原普通草稿或认证正文。

| 诱导动作 | 该次观察 | 额外依据／边界 |
|---|---|---|
| `clock.curr_time`、异步询问／消息 | 调用返回对应函数不存在 | 官方完整 ModelInfo 只改 `experimental_supported_tools=[]`；上游全文 SHA `0178d235c589a31abd6ed0ea1e870935dc5819240eb0e813e178d3ebedf534f4`，独立逐字段比较其余字段零差异。 |
| shell／unified_exec、apply_patch | 不可调用，没有 command/fileChange item | 空 environments 和固定源码的环境工具注册门槛；没有依赖审批来默许执行。 |
| MCP／插件、权限升级 | 未暴露可用工具，没有 MCP item 或审批请求 | 所有列出的 MCP tools 为零；服务若提出外部审批／动态工具请求，适配器用错误回包明确拒绝并停止，此分支另有合成协议帧回归。 |
| 读取未选图片为参考 | imagegen 返回 `referenced image paths are unavailable in this session` | 该失败发生在文件读取和图像后端请求前；实际 canary 字节未变，测试未生成替代图片。 |

[脱敏摘要](dcode-0.0.37-image-isolation-2026-10-01.json)记录 item／event 类别、模型回报、固定模型与 canary 检查；只出现用户消息、推理和回复，没有新图片或命令／文件／MCP item。该次摘要没有保留全部原始事件或完整外部副作用审计，不能概括所有恶意提示变体与生产保障。

## 生图试验与待验收边界

1. 当前固定 [App Server 官方文档](https://learn.chatgpt.com/docs/app-server)仍保留实验性及生产支持限制。本轮交付是本机未签名试验候选；稳定分发前仍须核官方支持、可支持替代与 507 明确范围。
2. 一次 D Code Attempt 不等于最多一次后端扣量。固定 stdio 协议没有前置 per-call veto 或一次性图像配额，第二次 started 事件后停止不能保证后端尚未请求。界面明确标试验并提示额度／实际消耗未知，不承诺单次扣量。
3. Codex CLI 由本机独立安装，缺少或版本不符时拒绝开始；本候选没有自动下载 CLI。Codex 自有目录可能保存另一个副本，不由 D Code 临时目录清理覆盖。
4. 真实 Pi 聊天供应商／模型全矩阵、真实 IME、旧用户库升级／应用内切换回退、长会话性能对照与 507 本人完整体验验收仍待分别进行。

## 隔离启动

候选目录有 `Open-0.0.37-Isolated.command`；它固定使用同目录 `acceptance/` 中的 Product Store、空 Agent 目录和 Electron profile，启动此候选，保留实际用户库与现有应用。该入口可用于人工体验语言、输入菜单、工作流及生图；生图仍须明确提交并使用本机适用的 Codex 订阅用量。直接打开 `.app` 的默认数据路径与上述隔离入口分别成立，真实旧数据升级和回退未在本轮证明。
