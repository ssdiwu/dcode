# Prompt 图片附件与统一命令面板边界

状态：Accepted（已接受；约束 `0.0.20` 的 Composer 输入交互；不改变 [0024](0024-界面即上下文与-GUI-原生呈现边界.md) 只预填不发送、[0011](0011-后续消息队列所有权与派发边界.md) 队列文本语义与 [0025](0025-Markdown-编辑缓冲区与原子保存边界.md) 缓冲区不持久化）

## Context（背景）

`0.0.19` 后的首次真实 dogfood（2026-08-22，507）暴露了 Composer 输入区的四个事实缺口：① `pi-marketplace loaded` 这类扩展就绪自报被弹成横幅，与已过滤的 pi-di18n `lang:` 状态提示同类；② 斜杠面板数据源只有 `session.getCommands`（扩展命令），Skill、Prompt 模板与命令虽已在 `resources.list` 合同中却无法经 `/` 触达；③ `+` 入口是 `Menu`，macOS 菜单样式附带的下拉指示符构成输入行里多余的箭头；④ `+` 的产品语义应是"添加附件（图片 / 文件）"而不是资源选择菜单。Pi SDK 侧已核实：`AgentSession.prompt(text, options)` 支持 `options.images`（`ImageContent = { type:"image", data: base64, mimeType }`），`steer(text, images?)` 与 `followUp(text, images?)` 同样支持；而 D Code 协议 v1 的 `session.prompt` / `session.steer` 只有文本参数。

## Decision（决定）

1. **统一斜杠面板**：输入 `/` 打开单一面板，混排 扩展命令（`session.getCommands`，行尾标注"扩展"）、命令、Skill（`skill:` 前缀名）与 Prompt 模板（`source == "prompt"`），后三类来自 `resources.list`（与 设置 › 本机资源 同源）；同名扩展命令以 `getCommands` 版本为准去重。每行描述单行常显，悬停（help）显示类型 + 调用名 + 完整描述。插入文本复用 0.0.16 `composerInvocationText` 合同（只预填、由用户显式发送）。面板可滚动（上限 12 行、最高约 7 行高度），键盘 ↑↓ / Esc 语义不变。
2. **`+` 改为附件按钮**：纯 `Button`（非 `Menu`），不携带下拉指示符；点击打开系统文件选择器（可多选）。图片文件成为图片附件；非图片文件插入精确路径引用（0024 决定 2，不读取内容）。原 `+` 一次性资源菜单退役：资源触达由统一面板承接，资源管理仍归 设置 › 本机资源。
3. **图片附件协议合同**：`session.prompt` 与 `session.steer` 增加可选 `images` 数组，元素 `{ type: "image", data: <base64>, mimeType: <image/*> }`；上限 8 张、单张 `data` ≤ 7,000,000 base64 字符，非法形态（空数组、非 image MIME、超限）由协议校验拒绝。无附件不发送该字段。可选参数向后兼容，`PROTOCOL_VERSION` 不提升。
4. **附件只存在于内存**：附件随发送构建请求，不写入会话 JSONL、不进入草稿资料与本机 store、不持久化（对齐 0025 缓冲区精神）；App 重启后未发送的附件如实消失。
5. **投递路径边界**：prompt 与 steer 可携带附件（经 Host 透传 SDK `PromptOptions.images` / `steer(text, images)`）；后续消息队列只承载文本（0011 语义不变）——带附件入队被拒绝并 notice 说明，不静默丢弃附件；请求失败或 steer 未正常完成时，附件与正文一起恢复到输入区；请求受理后清空；会话切换清空。
6. **用户显式选择即授权**：系统文件选择器中的用户选择等价于 0.0.10 的"本次允许"，不建立绕过 Source Folder 的第二条内容读取通道——非图片文件只插入路径文本；图片仅在发送时经协议进入模型输入。Swift 侧预检单张原始字节 ≤ 5 MB、数量 ≤ 8，超限给出用户可读原因。
7. **扩展状态提示降噪**：`pi-marketplace loaded` 等扩展就绪自报与 pi-di18n `lang:` / `i18n:` 同等对待——只进只读诊断日志，不弹横幅；真正面向用户的扩展通知仍弹横幅。
8. **不做**：音频 / 视频 / PDF 等非图片附件直传（协议未核实）、附件进入 follow-up 队列、附件持久化或草稿化、拖拽与剪贴板粘贴图片、行内缩略图渲染（以 chip：文件名 + 体积 + 移除呈现）、自动压缩或转码图片。

## Consequences（影响）

- `0.0.20` 交付：`/` 一次触达全部可调用资源且类型、来源与描述可见；`+` 是附件入口且输入行无多余箭头；图片真实进入模型输入；扩展就绪横幅消失。
- 协议 v1 新增可选参数：旧 Swift 对新 Host 不发送 `images` 即无行为变化；新 Swift 对旧 Host 发送 `images` 会得到 `INVALID_PARAMS`——以版本兼容检查（`host.hello`）先拦，行为诚实。
- SDK `PromptOptions.images` 的错误（模型不支持图片输入等）经既有错误路径如实呈现，D Code 不预判模型能力。
- 后续消息队列带附件被拒是"队列仅文本"的显式化，不是缺陷：用户等运行结束后直接发送即可。
- `+` 菜单退役后，`resources.list` 的唯一消费者变为统一面板与设置页，加载时机（会话打开 + Composer 出现）不变。

## Rejected Alternatives（未采用方案）

- **`+` 保留资源菜单、另加附件按钮**：两个入口并排重复（面板已覆盖资源触达），输入行回到拥挤。
- **图片落盘后以路径引用**：模型只能看路径不能看图，与用户"添加附件给模型看"的意图不符；SDK 已有真正的图片通道。
- **附件进入 follow-up 队列**：队列是持久化文本 store，写入 base64 会把大体积与敏感图片内容落盘；且 0011 队列语义是"纯文本意图表达"。
- **空 `images: []` 随行发送**：语义噪声；协议对空数组显式拒绝。
- **Swift 侧根据模型名预判图片支持**：模型能力矩阵不归 D Code 权威，诚实交由 Pi / 供应商错误呈现。
